use anyhow::Result;
use futures_util::SinkExt;
use gas::prelude::*;
use hyper::upgrade::Upgraded;
use hyper_tungstenite::tungstenite::Message as WsMessage;
use hyper_util::rt::TokioIo;
use rivet_runner_protocol::{self as protocol, versioned};
use std::sync::Arc;
use tokio_tungstenite::WebSocketStream;
use universalpubsub::{NextOutput, Subscriber};
use versioned_data_util::OwnedVersionedData as _;

use crate::{
	conn::{Conn, TunnelActiveRequest},
	utils::{self, WebSocketSender},
};

pub async fn task(ctx: StandaloneCtx, conn: Arc<Conn>, sub: Subscriber) {
	match task_inner(ctx, conn, sub).await {
		Ok(_) => {}
		Err(err) => {
			tracing::error!(?err, "pubsub to client error");
		}
	}
}

async fn task_inner(ctx: StandaloneCtx, conn: Arc<Conn>, mut sub: Subscriber) -> Result<()> {
	while let Result::Ok(NextOutput::Message(ups_msg)) = sub.next().await {
		tracing::info!(
			payload_len = ups_msg.payload.len(),
			"received message from pubsub, forwarding to WebSocket"
		);

		// Parse message
		let mut msg = match versioned::ToClient::deserialize_with_embedded_version(&ups_msg.payload)
		{
			Result::Ok(x) => x,
			Err(err) => {
				tracing::error!(?err, "failed to parse tunnel message");
				continue;
			}
		};

		// Handle tunnel messages
		if let protocol::ToClient::ToClientTunnelMessage(tunnel_msg) = &mut msg {
			handle_tunnel_message(&conn, tunnel_msg).await;
		}

		// Forward raw message to WebSocket
		let serialized_msg =
			match versioned::ToClient::latest(msg).serialize_version(conn.protocol_version) {
				Result::Ok(x) => x,
				Err(err) => {
					tracing::error!(?err, "failed to serialize tunnel message");
					continue;
				}
			};
		let ws_msg = WsMessage::Binary(serialized_msg.into());
		if let Err(e) = conn.ws_tx.lock().await.send(ws_msg).await {
			tracing::error!(?e, "failed to send message to WebSocket");
			break;
		}
	}

	Ok(())
}

async fn handle_tunnel_message(conn: &Arc<Conn>, msg: &mut protocol::ToClientTunnelMessage) {
	// Save active request
	//
	// This will remove gateway_reply_to from the message since it does not need to be sent to the
	// client
	if let Some(reply_to) = msg.gateway_reply_to.take() {
		tracing::debug!(?msg.request_id, ?reply_to, "creating active request");
		let mut active_requests = conn.tunnel_active_requests.lock().await;
		active_requests.insert(
			msg.request_id,
			TunnelActiveRequest {
				gateway_reply_to: reply_to,
			},
		);
	}

	// If terminal, remove active request tracking
	if utils::is_to_client_tunnel_message_kind_request_close(&msg.message_kind) {
		tracing::debug!(?msg.request_id, "removing active conn from close message");
		let mut active_requests = conn.tunnel_active_requests.lock().await;
		active_requests.remove(&msg.request_id);
	}
}
