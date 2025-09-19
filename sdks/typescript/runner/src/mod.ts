import WebSocket from "ws";
import { importWebSocket } from "./websocket.js";
import * as protocol from "@rivetkit/engine-runner-protocol";
import { unreachable, calculateBackoff } from "./utils";
import { Tunnel } from "./tunnel";
import { WebSocketTunnelAdapter } from "./websocket-tunnel-adapter";
import type { Logger } from "pino";
import { setLogger, logger } from "./log.js";

const KV_EXPIRE: number = 30_000;

export interface ActorInstance {
	actorId: string;
	generation: number;
	config: ActorConfig;
	requests: Set<string>; // Track active request IDs
	webSockets: Set<string>; // Track active WebSocket IDs
}

export interface ActorConfig {
	name: string;
	key: string | null;
	createTs: bigint;
	input: Uint8Array | null;
}

export interface RunnerConfig {
	logger?: Logger;
	version: number;
	endpoint: string;
	pegboardEndpoint?: string;
	pegboardRelayEndpoint?: string;
	namespace: string;
	totalSlots: number;
	runnerName: string;
	runnerKey: string;
	prepopulateActorNames: Record<string, { metadata: Record<string, any> }>;
	metadata?: Record<string, any>;
	onConnected: () => void;
	onDisconnected: () => void;
	onShutdown: () => void;
	fetch: (actorId: string, request: Request) => Promise<Response>;
	websocket?: (actorId: string, ws: any, request: Request) => Promise<void>;
	onActorStart: (
		actorId: string,
		generation: number,
		config: ActorConfig,
	) => Promise<void>;
	onActorStop: (actorId: string, generation: number) => Promise<void>;
	noAutoShutdown?: boolean;
}

export interface KvListOptions {
	reverse?: boolean;
	limit?: number;
}

interface KvRequestEntry {
	actorId: string;
	data: protocol.KvRequestData;
	resolve: (value: any) => void;
	reject: (error: unknown) => void;
	sent: boolean;
	timestamp: number;
}

export class Runner {
	#config: RunnerConfig;

	get config(): RunnerConfig {
		return this.#config;
	}

	#actors: Map<string, ActorInstance> = new Map();
	#actorWebSockets: Map<string, Set<WebSocketTunnelAdapter>> = new Map();

	// WebSocket
	#pegboardWebSocket?: WebSocket;
	runnerId?: string;
	#lastCommandIdx: number = -1;
	#pingLoop?: NodeJS.Timeout;
	#nextEventIdx: bigint = 0n;
	#started: boolean = false;
	#shutdown: boolean = false;
	#reconnectAttempt: number = 0;
	#reconnectTimeout?: NodeJS.Timeout;

	// Runner lost threshold management
	#runnerLostThreshold?: number;
	#runnerLostTimeout?: NodeJS.Timeout;

	// Event storage for resending
	#eventHistory: { event: protocol.EventWrapper; timestamp: number }[] = [];
	#eventPruneInterval?: NodeJS.Timeout;

	// Command acknowledgment
	#ackInterval?: NodeJS.Timeout;

	// KV operations
	#nextRequestId: number = 0;
	#kvRequests: Map<number, KvRequestEntry> = new Map();
	#kvCleanupInterval?: NodeJS.Timeout;

	// Tunnel for HTTP/WebSocket forwarding
	#tunnel?: Tunnel;

	constructor(config: RunnerConfig) {
		this.#config = config;
		if (this.#config.logger) setLogger(this.#config.logger);

		// TODO(RVT-4986): Prune when server acks events
		// Start pruning old events every minute
		this.#eventPruneInterval = setInterval(() => {
			this.#pruneOldEvents();
		}, 60000); // Run every minute

		// Start cleaning up old unsent KV requests every 15 seconds
		this.#kvCleanupInterval = setInterval(() => {
			this.#cleanupOldKvRequests();
		}, 15000); // Run every 15 seconds
	}

	// MARK: Manage actors
	sleepActor(actorId: string, generation?: number) {
		const actor = this.getActor(actorId, generation);
		if (!actor) return;

		// Keep the actor instance in memory during sleep
		this.#sendActorIntent(actorId, actor.generation, "sleep");

		// NOTE: We do NOT remove the actor from this.#actors here
		// The server will send a StopActor command if it wants to fully stop
	}

	async stopActor(actorId: string, generation?: number) {
		const actor = this.#removeActor(actorId, generation);
		if (!actor) return;

		// Unregister actor from tunnel
		if (this.#tunnel) {
			this.#tunnel.unregisterActor(actor);
		}

		// If onActorStop times out, Pegboard will handle this timeout with ACTOR_STOP_THRESHOLD_DURATION_MS
		try {
			await this.#config.onActorStop(actorId, actor.generation);
		} catch (err) {
			console.error(`Error in onActorStop for actor ${actorId}:`, err);
		}

		this.#sendActorStateUpdate(actorId, actor.generation, "stopped");

		this.#config.onActorStop(actorId, actor.generation).catch((err) => {
			logger()?.error({
				msg: "error in onactorstop for actor",
				actorId,
				err,
			});
		});
	}

	#stopAllActors() {
		logger()?.info(
			"stopping all actors due to runner lost threshold exceeded",
		);

		const actorIds = Array.from(this.#actors.keys());
		for (const actorId of actorIds) {
			this.stopActor(actorId);
		}
	}

	getActor(actorId: string, generation?: number): ActorInstance | undefined {
		const actor = this.#actors.get(actorId);
		if (!actor) {
			logger()?.error({ msg: "actor not found", actorId });
			return undefined;
		}
		if (generation !== undefined && actor.generation !== generation) {
			logger()?.error({
				msg: "actor generation mismatch",
				actorId,
				generation,
			});
			return undefined;
		}

		return actor;
	}

	hasActor(actorId: string, generation?: number): boolean {
		const actor = this.#actors.get(actorId);

		return (
			!!actor &&
			(generation === undefined || actor.generation === generation)
		);
	}

	#removeActor(
		actorId: string,
		generation?: number,
	): ActorInstance | undefined {
		const actor = this.#actors.get(actorId);
		if (!actor) {
			logger()?.error({ msg: "actor not found", actorId });
			return undefined;
		}
		if (generation !== undefined && actor.generation !== generation) {
			logger()?.error({
				msg: "actor generation mismatch",
				actorId,
				generation,
			});
			return undefined;
		}

		this.#actors.delete(actorId);

		// Close all WebSocket connections for this actor
		const actorWebSockets = this.#actorWebSockets.get(actorId);
		if (actorWebSockets) {
			for (const ws of actorWebSockets) {
				try {
					ws.close(1000, "Actor stopped");
				} catch (err) {
					logger()?.error({
						msg: "error closing websocket for actor",
						actorId,
						err,
					});
				}
			}
			this.#actorWebSockets.delete(actorId);
		}

		return actor;
	}

	// MARK: Start
	async start() {
		if (this.#started) throw new Error("Cannot call runner.start twice");
		this.#started = true;

		logger()?.info("starting runner");

		try {
			// Connect tunnel first and wait for it to be ready before connecting runner WebSocket
			// This prevents a race condition where the runner appears ready but can't accept network requests
			await this.#openTunnelAndWait();
			await this.#openPegboardWebSocket();
		} catch (error) {
			this.#started = false;
			throw error;
		}

		if (!this.#config.noAutoShutdown) {
			process.on("SIGTERM", this.shutdown.bind(this, false, true));
			process.on("SIGINT", this.shutdown.bind(this, false, true));
		}
	}

	// MARK: Shutdown
	async shutdown(immediate: boolean, exit: boolean = false) {
		logger()?.info({ msg: "starting shutdown...", immediate });
		this.#shutdown = true;

		// Clear reconnect timeout
		if (this.#reconnectTimeout) {
			clearTimeout(this.#reconnectTimeout);
			this.#reconnectTimeout = undefined;
		}

		// Clear runner lost timeout
		if (this.#runnerLostTimeout) {
			clearTimeout(this.#runnerLostTimeout);
			this.#runnerLostTimeout = undefined;
		}

		// Clear ping loop
		if (this.#pingLoop) {
			clearInterval(this.#pingLoop);
			this.#pingLoop = undefined;
		}

		// Clear ack interval
		if (this.#ackInterval) {
			clearInterval(this.#ackInterval);
			this.#ackInterval = undefined;
		}

		// Clear event prune interval
		if (this.#eventPruneInterval) {
			clearInterval(this.#eventPruneInterval);
			this.#eventPruneInterval = undefined;
		}

		// Clear KV cleanup interval
		if (this.#kvCleanupInterval) {
			clearInterval(this.#kvCleanupInterval);
			this.#kvCleanupInterval = undefined;
		}

		// Reject all KV requests
		for (const request of this.#kvRequests.values()) {
			request.reject(
				new Error("WebSocket connection closed during shutdown"),
			);
		}
		this.#kvRequests.clear();

		// Close WebSocket
		if (
			this.#pegboardWebSocket &&
			this.#pegboardWebSocket.readyState === WebSocket.OPEN
		) {
			const pegboardWebSocket = this.#pegboardWebSocket;
			if (immediate) {
				// Stop immediately
				pegboardWebSocket.close(1000, "Stopping");
			} else {
				// Wait for actors to shut down before stopping
				try {
					logger()?.info({
						msg: "sending stopping message",
						readyState: pegboardWebSocket.readyState,
					});

					// NOTE: We don't use #sendToServer here because that function checks if the runner is
					// shut down
					const encoded = protocol.encodeToServer({
						tag: "ToServerStopping",
						val: null,
					});
					if (
						this.#pegboardWebSocket &&
						this.#pegboardWebSocket.readyState === WebSocket.OPEN
					) {
						this.#pegboardWebSocket.send(encoded);
					} else {
						logger()?.error(
							"WebSocket not available or not open for sending data",
						);
					}

					const closePromise = new Promise<void>((resolve) => {
						if (!pegboardWebSocket)
							throw new Error("missing pegboardWebSocket");

						pegboardWebSocket.addEventListener("close", (ev) => {
							logger()?.info({
								msg: "connection closed",
								code: ev.code,
								reason: ev.reason.toString(),
							});
							resolve();
						});
					});

					// TODO: Wait for all actors to stop before closing ws

					logger()?.info("closing WebSocket");
					pegboardWebSocket.close(1000, "Stopping");

					await closePromise;

					logger()?.info("websocket shutdown completed");
				} catch (error) {
					logger()?.error({
						msg: "error during websocket shutdown:",
						error,
					});
					pegboardWebSocket.close();
				}
			}
		} else {
			logger()?.warn("no runner WebSocket to shutdown or already closed");
		}

		// Close tunnel
		if (this.#tunnel) {
			this.#tunnel.shutdown();
			logger()?.info("tunnel shutdown completed");
		}

		if (exit) process.exit(0);

		this.#config.onShutdown();
	}

	// MARK: Networking
	get pegboardUrl() {
		const endpoint = this.#config.pegboardEndpoint || this.#config.endpoint;
		const wsEndpoint = endpoint
			.replace("http://", "ws://")
			.replace("https://", "wss://");
		return `${wsEndpoint}?protocol_version=1&namespace=${encodeURIComponent(this.#config.namespace)}&runner_key=${encodeURIComponent(this.#config.runnerKey)}`;
	}

	get pegboardTunnelUrl() {
		const endpoint =
			this.#config.pegboardRelayEndpoint ||
			this.#config.pegboardEndpoint ||
			this.#config.endpoint;
		const wsEndpoint = endpoint
			.replace("http://", "ws://")
			.replace("https://", "wss://");
		return `${wsEndpoint}?protocol_version=1&namespace=${encodeURIComponent(this.#config.namespace)}&runner_name=${encodeURIComponent(this.#config.runnerName)}&runner_key=${encodeURIComponent(this.#config.runnerKey)}`;
	}

	async #openTunnelAndWait(): Promise<void> {
		return new Promise((resolve, reject) => {
			const url = this.pegboardTunnelUrl;
			logger()?.info({ msg: "opening tunnel to:", url });
			logger()?.info({
				msg: "current runner id:",
				runnerId: this.runnerId || "none",
			});
			logger()?.info({
				msg: "active actors count:",
				actors: this.#actors.size,
			});

			let connected = false;

			this.#tunnel = new Tunnel(this, url, {
				onConnected: () => {
					if (!connected) {
						connected = true;
						logger()?.info("tunnel connected");
						resolve();
					}
				},
				onDisconnected: () => {
					if (!connected) {
						// First connection attempt failed
						reject(new Error("Tunnel connection failed"));
					}
					// If already connected, tunnel will handle reconnection automatically
				},
			});
			this.#tunnel.start();
		});
	}

	// MARK: Runner protocol
	async #openPegboardWebSocket() {
		const WS = await importWebSocket();
		const ws = new WS(this.pegboardUrl, {
			headers: {
				"x-rivet-target": "runner",
			},
		}) as any as WebSocket;
		this.#pegboardWebSocket = ws;

		ws.addEventListener("open", () => {
			logger()?.info("Connected");

			// Reset reconnect attempt counter on successful connection
			this.#reconnectAttempt = 0;

			// Clear any pending reconnect timeout
			if (this.#reconnectTimeout) {
				clearTimeout(this.#reconnectTimeout);
				this.#reconnectTimeout = undefined;
			}

			// Clear any pending runner lost timeout since we're reconnecting
			if (this.#runnerLostTimeout) {
				clearTimeout(this.#runnerLostTimeout);
				this.#runnerLostTimeout = undefined;
			}

			// Send init message
			const init: protocol.ToServerInit = {
				name: this.#config.runnerName,
				version: this.#config.version,
				totalSlots: this.#config.totalSlots,
				lastCommandIdx:
					this.#lastCommandIdx >= 0
						? BigInt(this.#lastCommandIdx)
						: null,
				prepopulateActorNames: new Map(
					Object.entries(this.#config.prepopulateActorNames).map(
						([name, data]) => [
							name,
							{ metadata: JSON.stringify(data.metadata) },
						],
					),
				),
				metadata: JSON.stringify(this.#config.metadata),
			};

			this.#sendToServer({
				tag: "ToServerInit",
				val: init,
			});

			// Process unsent KV requests
			this.#processUnsentKvRequests();

			// Start ping interval
			const pingInterval = 1000;
			const pingLoop = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) {
					this.#sendToServer({
						tag: "ToServerPing",
						val: {
							ts: BigInt(Date.now()),
						},
					});
				} else {
					clearInterval(pingLoop);
					logger()?.info("WebSocket not open, stopping ping loop");
				}
			}, pingInterval);
			this.#pingLoop = pingLoop;

			// Start command acknowledgment interval (5 minutes)
			const ackInterval = 5 * 60 * 1000; // 5 minutes in milliseconds
			const ackLoop = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) {
					this.#sendCommandAcknowledgment();
				} else {
					clearInterval(ackLoop);
					logger()?.info("WebSocket not open, stopping ack loop");
				}
			}, ackInterval);
			this.#ackInterval = ackLoop;
		});

		ws.addEventListener("message", async (ev) => {
			let buf;
			if (ev.data instanceof Blob) {
				buf = new Uint8Array(await ev.data.arrayBuffer());
			} else if (Buffer.isBuffer(ev.data)) {
				buf = new Uint8Array(ev.data);
			} else {
				throw new Error("expected binary data, got " + typeof ev.data);
			}

			// Parse message
			const message = protocol.decodeToClient(buf);

			// Handle message
			if (message.tag === "ToClientInit") {
				const init = message.val;
				const hadRunnerId = !!this.runnerId;
				this.runnerId = init.runnerId;

				// Store the runner lost threshold from metadata
				this.#runnerLostThreshold = init.metadata?.runnerLostThreshold
					? Number(init.metadata.runnerLostThreshold)
					: undefined;

				logger()?.info({
					msg: "received init",
					runnerId: init.runnerId,
					lastEventIdx: init.lastEventIdx,
					runnerLostThreshold: this.#runnerLostThreshold,
				});

				// Resend events that haven't been acknowledged
				this.#resendUnacknowledgedEvents(init.lastEventIdx);

				this.#config.onConnected();
			} else if (message.tag === "ToClientCommands") {
				const commands = message.val;
				this.#handleCommands(commands);
			} else if (message.tag === "ToClientAckEvents") {
				throw new Error("TODO");
			} else if (message.tag === "ToClientKvResponse") {
				const kvResponse = message.val;
				this.#handleKvResponse(kvResponse);
			}
		});

		ws.addEventListener("error", (ev) => {
			logger()?.error("WebSocket error:", ev.error);
		});

		ws.addEventListener("close", (ev) => {
			logger()?.info({
				msg: "connection closed",
				code: ev.code,
				reason: ev.reason.toString(),
			});

			this.#config.onDisconnected();

			// Clear ping loop on close
			if (this.#pingLoop) {
				clearInterval(this.#pingLoop);
				this.#pingLoop = undefined;
			}

			// Clear ack interval on close
			if (this.#ackInterval) {
				clearInterval(this.#ackInterval);
				this.#ackInterval = undefined;
			}

			if (!this.#shutdown) {
				// Start runner lost timeout if we have a threshold and are not shutting down
				if (
					this.#runnerLostThreshold &&
					this.#runnerLostThreshold > 0
				) {
					logger()?.info({
						msg: "starting runner lost timeout",
						seconds: this.#runnerLostThreshold / 1000,
					});
					this.#runnerLostTimeout = setTimeout(() => {
						this.#stopAllActors();
					}, this.#runnerLostThreshold);
				}

				// Attempt to reconnect if not stopped
				this.#scheduleReconnect();
			}
		});
	}

	#handleCommands(commands: protocol.ToClientCommands) {
		logger()?.info({
			msg: "received commands",
			commandCount: commands.length,
		});

		for (const commandWrapper of commands) {
			logger()?.info({ msg: "received command", commandWrapper });
			if (commandWrapper.inner.tag === "CommandStartActor") {
				this.#handleCommandStartActor(commandWrapper);
			} else if (commandWrapper.inner.tag === "CommandStopActor") {
				this.#handleCommandStopActor(commandWrapper);
			}

			this.#lastCommandIdx = Number(commandWrapper.index);
		}
	}

	#handleCommandStartActor(commandWrapper: protocol.CommandWrapper) {
		const startCommand = commandWrapper.inner
			.val as protocol.CommandStartActor;

		const actorId = startCommand.actorId;
		const generation = startCommand.generation;
		const config = startCommand.config;

		const actorConfig: ActorConfig = {
			name: config.name,
			key: config.key,
			createTs: config.createTs,
			input: config.input ? new Uint8Array(config.input) : null,
		};

		const instance: ActorInstance = {
			actorId,
			generation,
			config: actorConfig,
			requests: new Set(),
			webSockets: new Set(),
		};

		this.#actors.set(actorId, instance);

		this.#sendActorStateUpdate(actorId, generation, "running");

		// TODO: Add timeout to onActorStart
		// Call onActorStart asynchronously and handle errors
		this.#config
			.onActorStart(actorId, generation, actorConfig)
			.catch((err) => {
				logger()?.error({
					msg: "error in onactorstart for actor",
					actorId,
					err,
				});

				// TODO: Mark as crashed
				// Send stopped state update if start failed
				this.stopActor(actorId, generation);
			});
	}

	#handleCommandStopActor(commandWrapper: protocol.CommandWrapper) {
		const stopCommand = commandWrapper.inner
			.val as protocol.CommandStopActor;

		const actorId = stopCommand.actorId;
		const generation = stopCommand.generation;

		this.stopActor(actorId, generation);
	}

	#sendActorIntent(
		actorId: string,
		generation: number,
		intentType: "sleep" | "stop",
	) {
		if (this.#shutdown) {
			logger()?.warn("Runner is shut down, cannot send actor intent");
			return;
		}
		let actorIntent: protocol.ActorIntent;

		if (intentType === "sleep") {
			actorIntent = { tag: "ActorIntentSleep", val: null };
		} else if (intentType === "stop") {
			actorIntent = {
				tag: "ActorIntentStop",
				val: null,
			};
		} else {
			unreachable(intentType);
		}

		const intentEvent: protocol.EventActorIntent = {
			actorId,
			generation,
			intent: actorIntent,
		};

		const eventIndex = this.#nextEventIdx++;
		const eventWrapper: protocol.EventWrapper = {
			index: eventIndex,
			inner: {
				tag: "EventActorIntent",
				val: intentEvent,
			},
		};

		// Store event in history for potential resending
		this.#eventHistory.push({
			event: eventWrapper,
			timestamp: Date.now(),
		});

		logger()?.info({
			msg: "sending event to server",
			index: eventWrapper.index,
			tag: eventWrapper.inner.tag,
			val: eventWrapper.inner.val,
		});

		this.#sendToServer({
			tag: "ToServerEvents",
			val: [eventWrapper],
		});
	}

	#sendActorStateUpdate(
		actorId: string,
		generation: number,
		stateType: "running" | "stopped",
	) {
		if (this.#shutdown) {
			logger()?.warn(
				"Runner is shut down, cannot send actor state update",
			);
			return;
		}
		let actorState: protocol.ActorState;

		if (stateType === "running") {
			actorState = { tag: "ActorStateRunning", val: null };
		} else if (stateType === "stopped") {
			actorState = {
				tag: "ActorStateStopped",
				val: {
					code: protocol.StopCode.Ok,
					message: "hello",
				},
			};
		} else {
			unreachable(stateType);
		}

		const stateUpdateEvent: protocol.EventActorStateUpdate = {
			actorId,
			generation,
			state: actorState,
		};

		const eventIndex = this.#nextEventIdx++;
		const eventWrapper: protocol.EventWrapper = {
			index: eventIndex,
			inner: {
				tag: "EventActorStateUpdate",
				val: stateUpdateEvent,
			},
		};

		// Store event in history for potential resending
		this.#eventHistory.push({
			event: eventWrapper,
			timestamp: Date.now(),
		});

		logger()?.info({
			msg: "sending event to server",
			index: eventWrapper.index,
			tag: eventWrapper.inner.tag,
			val: eventWrapper.inner.val,
		});

		this.#sendToServer({
			tag: "ToServerEvents",
			val: [eventWrapper],
		});
	}

	#sendCommandAcknowledgment() {
		if (this.#shutdown) {
			logger()?.warn(
				"Runner is shut down, cannot send command acknowledgment",
			);
			return;
		}

		if (this.#lastCommandIdx < 0) {
			// No commands received yet, nothing to acknowledge
			return;
		}

		//logger()?.log("Sending command acknowledgment", this.#lastCommandIdx);

		this.#sendToServer({
			tag: "ToServerAckCommands",
			val: {
				lastCommandIdx: BigInt(this.#lastCommandIdx),
			},
		});
	}

	#handleKvResponse(response: protocol.ToClientKvResponse) {
		const requestId = response.requestId;
		const request = this.#kvRequests.get(requestId);

		if (!request) {
			const msg = "received kv response for unknown request id";
			if (logger()) {
				logger()?.error({ msg, requestId });
			} else {
				logger()?.error({ msg, requestId });
			}
			return;
		}

		this.#kvRequests.delete(requestId);

		if (response.data.tag === "KvErrorResponse") {
			request.reject(
				new Error(response.data.val.message || "Unknown KV error"),
			);
		} else {
			request.resolve(response.data.val);
		}
	}

	#parseGetResponseSimple(
		response: protocol.KvGetResponse,
		requestedKeys: Uint8Array[],
	): (Uint8Array | null)[] {
		// Parse the response keys and values
		const responseKeys: Uint8Array[] = [];
		const responseValues: Uint8Array[] = [];

		for (const key of response.keys) {
			responseKeys.push(new Uint8Array(key));
		}

		for (const value of response.values) {
			responseValues.push(new Uint8Array(value));
		}

		// Map response back to requested key order
		const result: (Uint8Array | null)[] = [];
		for (const requestedKey of requestedKeys) {
			let found = false;
			for (let i = 0; i < responseKeys.length; i++) {
				if (this.#keysEqual(requestedKey, responseKeys[i])) {
					result.push(responseValues[i]);
					found = true;
					break;
				}
			}
			if (!found) {
				result.push(null);
			}
		}

		return result;
	}

	#keysEqual(key1: Uint8Array, key2: Uint8Array): boolean {
		if (key1.length !== key2.length) return false;
		for (let i = 0; i < key1.length; i++) {
			if (key1[i] !== key2[i]) return false;
		}
		return true;
	}

	//#parseGetResponse(response: protocol.KvGetResponse) {
	//	const keys: string[] = [];
	//	const values: Uint8Array[] = [];
	//	const metadata: { version: Uint8Array; createTs: bigint }[] = [];
	//
	//	for (const key of response.keys) {
	//		keys.push(new TextDecoder().decode(key));
	//	}
	//
	//	for (const value of response.values) {
	//		values.push(new Uint8Array(value));
	//	}
	//
	//	for (const meta of response.metadata) {
	//		metadata.push({
	//			version: new Uint8Array(meta.version),
	//			createTs: meta.createTs,
	//		});
	//	}
	//
	//	return { keys, values, metadata };
	//}

	#parseListResponseSimple(
		response: protocol.KvListResponse,
	): [Uint8Array, Uint8Array][] {
		const result: [Uint8Array, Uint8Array][] = [];

		for (let i = 0; i < response.keys.length; i++) {
			const key = response.keys[i];
			const value = response.values[i];

			if (key && value) {
				const keyBytes = new Uint8Array(key);
				const valueBytes = new Uint8Array(value);
				result.push([keyBytes, valueBytes]);
			}
		}

		return result;
	}

	//#parseListResponse(response: protocol.KvListResponse) {
	//	const keys: string[] = [];
	//	const values: Uint8Array[] = [];
	//	const metadata: { version: Uint8Array; createTs: bigint }[] = [];
	//
	//	for (const key of response.keys) {
	//		keys.push(new TextDecoder().decode(key));
	//	}
	//
	//	for (const value of response.values) {
	//		values.push(new Uint8Array(value));
	//	}
	//
	//	for (const meta of response.metadata) {
	//		metadata.push({
	//			version: new Uint8Array(meta.version),
	//			createTs: meta.createTs,
	//		});
	//	}
	//
	//	return { keys, values, metadata };
	//}

	// MARK: KV Operations
	async kvGet(
		actorId: string,
		keys: Uint8Array[],
	): Promise<(Uint8Array | null)[]> {
		const kvKeys: protocol.KvKey[] = keys.map(
			(key) =>
				key.buffer.slice(
					key.byteOffset,
					key.byteOffset + key.byteLength,
				) as ArrayBuffer,
		);

		const requestData: protocol.KvRequestData = {
			tag: "KvGetRequest",
			val: { keys: kvKeys },
		};

		const response = await this.#sendKvRequest(actorId, requestData);
		return this.#parseGetResponseSimple(response, keys);
	}

	async kvListAll(
		actorId: string,
		options?: KvListOptions,
	): Promise<[Uint8Array, Uint8Array][]> {
		const requestData: protocol.KvRequestData = {
			tag: "KvListRequest",
			val: {
				query: { tag: "KvListAllQuery", val: null },
				reverse: options?.reverse || null,
				limit:
					options?.limit !== undefined ? BigInt(options.limit) : null,
			},
		};

		const response = await this.#sendKvRequest(actorId, requestData);
		return this.#parseListResponseSimple(response);
	}

	async kvListRange(
		actorId: string,
		start: Uint8Array,
		end: Uint8Array,
		exclusive?: boolean,
		options?: KvListOptions,
	): Promise<[Uint8Array, Uint8Array][]> {
		const startKey: protocol.KvKey = start.buffer.slice(
			start.byteOffset,
			start.byteOffset + start.byteLength,
		) as ArrayBuffer;
		const endKey: protocol.KvKey = end.buffer.slice(
			end.byteOffset,
			end.byteOffset + end.byteLength,
		) as ArrayBuffer;

		const requestData: protocol.KvRequestData = {
			tag: "KvListRequest",
			val: {
				query: {
					tag: "KvListRangeQuery",
					val: {
						start: startKey,
						end: endKey,
						exclusive: exclusive || false,
					},
				},
				reverse: options?.reverse || null,
				limit:
					options?.limit !== undefined ? BigInt(options.limit) : null,
			},
		};

		const response = await this.#sendKvRequest(actorId, requestData);
		return this.#parseListResponseSimple(response);
	}

	async kvListPrefix(
		actorId: string,
		prefix: Uint8Array,
		options?: KvListOptions,
	): Promise<[Uint8Array, Uint8Array][]> {
		const prefixKey: protocol.KvKey = prefix.buffer.slice(
			prefix.byteOffset,
			prefix.byteOffset + prefix.byteLength,
		) as ArrayBuffer;

		const requestData: protocol.KvRequestData = {
			tag: "KvListRequest",
			val: {
				query: {
					tag: "KvListPrefixQuery",
					val: { key: prefixKey },
				},
				reverse: options?.reverse || null,
				limit:
					options?.limit !== undefined ? BigInt(options.limit) : null,
			},
		};

		const response = await this.#sendKvRequest(actorId, requestData);
		return this.#parseListResponseSimple(response);
	}

	async kvPut(
		actorId: string,
		entries: [Uint8Array, Uint8Array][],
	): Promise<void> {
		const keys: protocol.KvKey[] = entries.map(
			([key, _value]) =>
				key.buffer.slice(
					key.byteOffset,
					key.byteOffset + key.byteLength,
				) as ArrayBuffer,
		);
		const values: protocol.KvValue[] = entries.map(
			([_key, value]) =>
				value.buffer.slice(
					value.byteOffset,
					value.byteOffset + value.byteLength,
				) as ArrayBuffer,
		);

		const requestData: protocol.KvRequestData = {
			tag: "KvPutRequest",
			val: { keys, values },
		};

		await this.#sendKvRequest(actorId, requestData);
	}

	async kvDelete(actorId: string, keys: Uint8Array[]): Promise<void> {
		const kvKeys: protocol.KvKey[] = keys.map(
			(key) =>
				key.buffer.slice(
					key.byteOffset,
					key.byteOffset + key.byteLength,
				) as ArrayBuffer,
		);

		const requestData: protocol.KvRequestData = {
			tag: "KvDeleteRequest",
			val: { keys: kvKeys },
		};

		await this.#sendKvRequest(actorId, requestData);
	}

	async kvDrop(actorId: string): Promise<void> {
		const requestData: protocol.KvRequestData = {
			tag: "KvDropRequest",
			val: null,
		};

		await this.#sendKvRequest(actorId, requestData);
	}

	// MARK: Alarm Operations
	setAlarm(actorId: string, alarmTs: number | null, generation?: number) {
		const actor = this.getActor(actorId, generation);
		if (!actor) return;

		if (this.#shutdown) {
			console.warn("Runner is shut down, cannot set alarm");
			return;
		}

		const alarmEvent: protocol.EventActorSetAlarm = {
			actorId,
			generation: actor.generation,
			alarmTs: alarmTs !== null ? BigInt(alarmTs) : null,
		};

		const eventIndex = this.#nextEventIdx++;
		const eventWrapper: protocol.EventWrapper = {
			index: eventIndex,
			inner: {
				tag: "EventActorSetAlarm",
				val: alarmEvent,
			},
		};

		// Store event in history for potential resending
		this.#eventHistory.push({
			event: eventWrapper,
			timestamp: Date.now(),
		});

		this.#sendToServer({
			tag: "ToServerEvents",
			val: [eventWrapper],
		});
	}

	clearAlarm(actorId: string, generation?: number) {
		this.setAlarm(actorId, null, generation);
	}

	#sendKvRequest(
		actorId: string,
		requestData: protocol.KvRequestData,
	): Promise<any> {
		return new Promise((resolve, reject) => {
			if (this.#shutdown) {
				reject(new Error("Runner is shut down"));
				return;
			}

			const requestId = this.#nextRequestId++;
			const isConnected =
				this.#pegboardWebSocket &&
				this.#pegboardWebSocket.readyState === WebSocket.OPEN;

			// Store the request
			const requestEntry = {
				actorId,
				data: requestData,
				resolve,
				reject,
				sent: false,
				timestamp: Date.now(),
			};

			this.#kvRequests.set(requestId, requestEntry);

			if (isConnected) {
				// Send immediately
				this.#sendSingleKvRequest(requestId);
			}
		});
	}

	#sendSingleKvRequest(requestId: number) {
		const request = this.#kvRequests.get(requestId);
		if (!request || request.sent) return;

		try {
			const kvRequest: protocol.ToServerKvRequest = {
				actorId: request.actorId,
				requestId,
				data: request.data,
			};

			this.#sendToServer({
				tag: "ToServerKvRequest",
				val: kvRequest,
			});

			// Mark as sent and update timestamp
			request.sent = true;
			request.timestamp = Date.now();
		} catch (error) {
			this.#kvRequests.delete(requestId);
			request.reject(error);
		}
	}

	#processUnsentKvRequests() {
		if (
			!this.#pegboardWebSocket ||
			this.#pegboardWebSocket.readyState !== WebSocket.OPEN
		) {
			return;
		}

		let processedCount = 0;
		for (const [requestId, request] of this.#kvRequests.entries()) {
			if (!request.sent) {
				this.#sendSingleKvRequest(requestId);
				processedCount++;
			}
		}

		if (processedCount > 0) {
			//logger()?.log(`Processed ${processedCount} queued KV requests`);
		}
	}

	#sendToServer(message: protocol.ToServer) {
		if (this.#shutdown) {
			logger()?.warn(
				"Runner is shut down, cannot send message to server",
			);
			return;
		}

		const encoded = protocol.encodeToServer(message);
		if (
			this.#pegboardWebSocket &&
			this.#pegboardWebSocket.readyState === WebSocket.OPEN
		) {
			this.#pegboardWebSocket.send(encoded);
		} else {
			logger()?.error(
				"WebSocket not available or not open for sending data",
			);
		}
	}

	#scheduleReconnect() {
		if (this.#shutdown) {
			//logger()?.log("Runner is shut down, not attempting reconnect");
			return;
		}

		const delay = calculateBackoff(this.#reconnectAttempt, {
			initialDelay: 1000,
			maxDelay: 30000,
			multiplier: 2,
			jitter: true,
		});

		//logger()?.log(
		//	`Scheduling reconnect attempt ${this.#reconnectAttempt + 1} in ${delay}ms`,
		//);

		this.#reconnectTimeout = setTimeout(async () => {
			if (!this.#shutdown) {
				this.#reconnectAttempt++;
				//logger()?.log(
				//	`Attempting to reconnect (attempt ${this.#reconnectAttempt})...`,
				//);
				await this.#openPegboardWebSocket();
			}
		}, delay);
	}

	#resendUnacknowledgedEvents(lastEventIdx: bigint) {
		const eventsToResend = this.#eventHistory.filter(
			(item) => item.event.index > lastEventIdx,
		);

		if (eventsToResend.length === 0) return;

		//logger()?.log(
		//	`Resending ${eventsToResend.length} unacknowledged events from index ${Number(lastEventIdx) + 1}`,
		//);

		// Resend events in batches
		const events = eventsToResend.map((item) => item.event);
		this.#sendToServer({
			tag: "ToServerEvents",
			val: events,
		});
	}

	// TODO(RVT-4986): Prune when server acks events instead of based on old events
	#pruneOldEvents() {
		const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
		const originalLength = this.#eventHistory.length;

		// Remove events older than 5 minutes
		this.#eventHistory = this.#eventHistory.filter(
			(item) => item.timestamp > fiveMinutesAgo,
		);

		const prunedCount = originalLength - this.#eventHistory.length;
		if (prunedCount > 0) {
			//logger()?.log(`Pruned ${prunedCount} old events from history`);
		}
	}

	#cleanupOldKvRequests() {
		const thirtySecondsAgo = Date.now() - KV_EXPIRE;
		const toDelete: number[] = [];

		for (const [requestId, request] of this.#kvRequests.entries()) {
			if (request.timestamp < thirtySecondsAgo) {
				request.reject(
					new Error(
						"KV request timed out waiting for WebSocket connection",
					),
				);
				toDelete.push(requestId);
			}
		}

		for (const requestId of toDelete) {
			this.#kvRequests.delete(requestId);
		}

		if (toDelete.length > 0) {
			//logger()?.log(`Cleaned up ${toDelete.length} expired KV requests`);
		}
	}
}
