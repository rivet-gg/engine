import { ActorFeature } from "@rivetkit/core/inspector";
import { type Rivet, RivetClient } from "@rivetkit/engine-api-full";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { Actor, ActorId, CrashPolicy } from "@/components/actors";
import { engineEnv } from "@/lib/env";
import { convertStringToId } from "@/lib/utils";
import {
	ActorQueryOptionsSchema,
	createDefaultGlobalContext,
	type DefaultDataProvider,
	RECORDS_PER_PAGE,
} from "./default-data-provider";

export type CreateNamespace = {
	displayName: string;
	name?: string;
};

export type Namespace = {
	id: string;
	name: string;
	displayName: string;
	createdAt: string;
};

export function createClient(baseUrl = engineEnv().VITE_APP_API_URL) {
	return new RivetClient({
		baseUrl: () => baseUrl,
		environment: "",
	});
}

export const createGlobalContext = () => {
	const client = createClient();
	return {
		client,
		namespacesQueryOptions() {
			return infiniteQueryOptions({
				queryKey: ["namespaces"] as any,
				initialPageParam: undefined as string | undefined,
				queryFn: async ({ pageParam, signal: abortSignal }) => {
					const data = await client.namespaces.list(
						{
							limit: RECORDS_PER_PAGE,
							cursor: pageParam ?? undefined,
						},
						{ abortSignal },
					);
					return {
						...data,
						namespaces: data.namespaces.map((ns) => ({
							id: ns.namespaceId,
							displayName: ns.displayName,
							name: ns.name,
							createdAt: new Date(ns.createTs).toISOString(),
						})),
					};
				},
				getNextPageParam: (lastPage) => {
					if (lastPage.namespaces.length < RECORDS_PER_PAGE) {
						return undefined;
					}
					return lastPage.pagination.cursor;
				},
				select: (data) => data.pages.flatMap((page) => page.namespaces),
			});
		},
		createNamespaceMutationOptions(opts: {
			onSuccess?: (data: Namespace) => void;
		}) {
			return {
				...opts,
				mutationKey: ["namespaces"],
				mutationFn: async (data: CreateNamespace) => {
					const response = await client.namespaces.create({
						displayName: data.displayName,
						name: data.name || convertStringToId(data.displayName),
					});

					return {
						id: response.namespace.namespaceId,
						name: response.namespace.name,
						displayName: response.namespace.displayName,
						createdAt: new Date(
							response.namespace.createTs,
						).toISOString(),
					};
				},
			};
		},
	};
};

export const createNamespaceContext = ({
	namespace,
	namespaceId,
	client,
}: { namespace: string; namespaceId: string } & ReturnType<
	typeof createGlobalContext
>) => {
	const def = createDefaultGlobalContext();
	const dataProvider = {
		...def,
		features: {
			canCreateActors: true,
			canDeleteActors: true,
		},
		statusQueryOptions() {
			return queryOptions({
				...def.statusQueryOptions(),
				queryKey: [
					{ namespace, namespaceId },
					...def.statusQueryOptions().queryKey,
				],
				enabled: true,
				queryFn: async () => {
					return true;
				},
			});
		},
		regionsQueryOptions() {
			return infiniteQueryOptions({
				...def.regionsQueryOptions(),
				enabled: true,
				queryKey: [
					{ namespace, namespaceId },
					...def.regionsQueryOptions().queryKey,
				],
				queryFn: async () => {
					const data = await client.datacenters.list();
					return {
						regions: data.datacenters.map((dc) => ({
							id: dc.name,
							name: dc.name,
						})),
						pagination: data.pagination,
					};
				},
			});
		},
		regionQueryOptions(regionId: string | undefined) {
			return queryOptions({
				...def.regionQueryOptions(regionId),
				queryKey: [
					{ namespace, namespaceId },
					...def.regionQueryOptions(regionId).queryKey,
				],
				queryFn: async ({ client }) => {
					const regions = await client.ensureInfiniteQueryData(
						this.regionsQueryOptions(),
					);

					for (const page of regions.pages) {
						for (const region of page.regions) {
							if (region.id === regionId) {
								return region;
							}
						}
					}

					throw new Error(`Region not found: ${regionId}`);
				},
			});
		},
		actorQueryOptions(actorId) {
			return queryOptions({
				...def.actorQueryOptions(actorId),
				queryKey: [
					{ namespace, namespaceId },
					...def.actorQueryOptions(actorId).queryKey,
				],
				enabled: true,
				queryFn: async ({ signal: abortSignal }) => {
					const data = await client.actorsGet(
						actorId,
						{ namespace },
						{ abortSignal },
					);

					return transformActor(data.actor);
				},
			});
		},
		actorsQueryOptions(opts) {
			return infiniteQueryOptions({
				...def.actorsQueryOptions(opts),
				queryKey: [
					{ namespace, namespaceId },
					...def.actorsQueryOptions(opts).queryKey,
				],
				enabled: true,
				initialPageParam: undefined,
				queryFn: async ({
					signal: abortSignal,
					pageParam,
					queryKey: [, , _opts],
				}) => {
					const { success, data: opts } =
						ActorQueryOptionsSchema.safeParse(_opts || {});

					if (
						(opts?.n?.length === 0 || !opts?.n) &&
						(opts?.filters?.id?.value?.length === 0 ||
							!opts?.filters?.id?.value ||
							opts?.filters.key?.value?.length === 0 ||
							!opts?.filters.key?.value)
					) {
						// If there are no names specified, we can return an empty result
						return {
							actors: [],
							pagination: {
								cursor: undefined,
							},
						};
					}

					const data = await client.actorsList(
						{
							namespace,
							cursor: pageParam ?? undefined,
							actorIds: opts?.filters?.id?.value?.join(","),
							key: opts?.filters?.key?.value?.join(","),
							includeDestroyed:
								success &&
								(opts?.filters?.showDestroyed?.value.includes(
									"true",
								) ||
									opts?.filters?.showDestroyed?.value.includes(
										"1",
									)),
							limit: RECORDS_PER_PAGE,
							name: opts?.filters?.id?.value
								? undefined
								: opts?.n?.join(","),
						},
						{ abortSignal },
					);

					return {
						...data,
						actors: data.actors.map((actor) =>
							transformActor(actor),
						),
					};
				},
				getNextPageParam: (lastPage) => {
					if (lastPage.actors.length < RECORDS_PER_PAGE) {
						return undefined;
					}
					return lastPage.pagination.cursor;
				},
			});
		},
		buildsQueryOptions() {
			return infiniteQueryOptions({
				...def.buildsQueryOptions(),
				queryKey: [
					{ namespace, namespaceId },
					...def.buildsQueryOptions().queryKey,
				],
				enabled: true,
				queryFn: async ({ signal: abortSignal, pageParam }) => {
					const data = await client.actorsListNames(
						{
							namespace,
							cursor: pageParam ?? undefined,
							limit: RECORDS_PER_PAGE,
						},
						{ abortSignal },
					);

					return {
						pagination: data.pagination,
						builds: Object.keys(data.names)
							.sort()
							.map((build) => ({
								id: build,
								name: build,
							})),
					};
				},
				getNextPageParam: (lastPage) => {
					if (lastPage.builds.length < RECORDS_PER_PAGE) {
						return undefined;
					}
					return lastPage.pagination.cursor;
				},
			});
		},
		createActorMutationOptions() {
			return {
				...def.createActorMutationOptions(),
				mutationKey: [namespace, "actors"],
				mutationFn: async (data) => {
					const response = await client.actorsCreate({
						namespace,
						name: data.name,
						key: data.key,
						crashPolicy: data.crashPolicy,
						runnerNameSelector: data.runnerNameSelector,
						input: JSON.stringify(data.input),
					});

					return response.actor.actorId;
				},
				onSuccess: () => {},
			};
		},
		actorDestroyMutationOptions(actorId) {
			return {
				...def.actorDestroyMutationOptions(actorId),
				mutationFn: async () => {
					await client.actorsDelete(actorId);
				},
			};
		},
	} satisfies DefaultDataProvider;

	return {
		...dataProvider,
		runnersQueryOptions(opts: { namespace: string }) {
			return infiniteQueryOptions({
				queryKey: [opts.namespace, "runners"],
				initialPageParam: undefined as string | undefined,
				queryFn: async ({ pageParam, signal: abortSignal }) => {
					const data = await client.runners.list(
						{
							namespace: opts.namespace,
							cursor: pageParam ?? undefined,
							limit: RECORDS_PER_PAGE,
						},
						{ abortSignal },
					);
					return data;
				},
				getNextPageParam: (lastPage) => {
					if (lastPage.runners.length < RECORDS_PER_PAGE) {
						return undefined;
					}
					return lastPage.pagination.cursor;
				},
				select: (data) => data.pages.flatMap((page) => page.runners),
			});
		},
		runnerNamesQueryOptions(opts: { namespace: string }) {
			return infiniteQueryOptions({
				queryKey: [opts.namespace, "runner", "names"],
				initialPageParam: undefined as string | undefined,
				queryFn: async ({ signal: abortSignal, pageParam }) => {
					const data = await client.runners.listNames(
						{
							namespace: opts.namespace,
							cursor: pageParam ?? undefined,
							limit: RECORDS_PER_PAGE,
						},
						{
							abortSignal,
						},
					);
					return data;
				},
				getNextPageParam: (lastPage) => {
					if (lastPage.names.length < RECORDS_PER_PAGE) {
						return undefined;
					}
					return lastPage.pagination.cursor;
				},
				select: (data) => data.pages.flatMap((page) => page.names),
			});
		},
		runnerByNameQueryOptions(opts: {
			namespace: string;
			runnerName: string;
		}) {
			return queryOptions({
				queryKey: [opts.namespace, "runner", opts.runnerName],
				enabled: !!opts.runnerName,
				queryFn: async ({ signal: abortSignal }) => {
					const data = await client.runners.list(
						{ namespace: opts.namespace, name: opts.runnerName },
						{
							abortSignal,
						},
					);
					if (!data.runners[0]) {
						throw new Error("Runner not found");
					}
					return data.runners[0];
				},
			});
		},
		createRunnerConfigMutationOptions(
			opts: {
				onSuccess?: (data: Rivet.RunnerConfigsUpsertResponse) => void;
			} = {},
		) {
			return {
				...opts,
				mutationKey: ["runner-config"],
				mutationFn: async ({
					name,
					config,
				}: {
					name: string;
					config: Rivet.RunnerConfig;
				}) => {
					const response = await client.runnerConfigs.upsert(name, {
						namespace,
						...config,
					});
					return response;
				},
			};
		},
		runnerConfigsQueryOptions() {
			return infiniteQueryOptions({
				queryKey: [{ namespace }, "runners", "configs"],
				initialPageParam: undefined as string | undefined,
				queryFn: async ({ signal: abortSignal, pageParam }) => {
					const response = await client.runnerConfigs.list(
						{
							namespace,
							cursor: pageParam ?? undefined,
							limit: RECORDS_PER_PAGE,
						},
						{ abortSignal },
					);

					return response;
				},

				select: (data) =>
					data.pages.flatMap((page) =>
						Object.entries(page.runnerConfigs),
					),
				getNextPageParam: (lastPage) => {
					if (
						Object.values(lastPage.runnerConfigs).length <
						RECORDS_PER_PAGE
					) {
						return undefined;
					}
					return lastPage.pagination.cursor;
				},
			});
		},
	};
};

function transformActor(a: Rivet.Actor): Actor {
	return {
		id: a.actorId as ActorId,
		name: a.name,
		key: a.key ? a.key : undefined,
		connectableAt: a.connectableTs
			? new Date(a.connectableTs).toISOString()
			: undefined,
		region: a.datacenter,
		createdAt: new Date(a.createTs).toISOString(),
		startedAt: a.startTs ? new Date(a.startTs).toISOString() : undefined,
		destroyedAt: a.destroyTs
			? new Date(a.destroyTs).toISOString()
			: undefined,
		sleepingAt: a.sleepTs ? new Date(a.sleepTs).toISOString() : undefined,
		pendingAllocationAt: a.pendingAllocationTs
			? new Date(a.pendingAllocationTs).toISOString()
			: undefined,
		crashPolicy: a.crashPolicy as CrashPolicy,
		runner: a.runnerNameSelector,
		features: [
			ActorFeature.Config,
			ActorFeature.Connections,
			ActorFeature.State,
			ActorFeature.Console,
			ActorFeature.Database,
			ActorFeature.EventsMonitoring,
		],
	};
}
