use async_trait::async_trait;
use bytes::Bytes;
use futures_util::{
	SinkExt, StreamExt,
	stream::{SplitSink, SplitStream},
};
use gas::prelude::Id;
use gas::prelude::*;
use http_body_util::Full;
use hyper::upgrade::Upgraded;
use hyper::{Response, StatusCode};
use hyper_tungstenite::tungstenite::Message as WsMessage;
use hyper_tungstenite::{HyperWebsocket, tungstenite::Message};
use hyper_util::rt::TokioIo;
use pegboard::ops::runner::update_alloc_idx::{Action, RunnerEligibility};
use pegboard_actor_kv as kv;
use rivet_error::*;
use rivet_guard_core::{
	custom_serve::CustomServeTrait, proxy_service::ResponseBody, request_context::RequestContext,
};
use rivet_runner_protocol as protocol;
use rivet_runner_protocol::*;
use serde_json::json;
use std::{
	collections::HashMap,
	sync::{
		Arc,
		atomic::{AtomicU32, Ordering},
	},
	time::Duration,
};
use tokio::sync::{Mutex, RwLock};
use tokio_tungstenite::{
	WebSocketStream,
	tungstenite::protocol::frame::{CloseFrame, coding::CloseCode},
};
use universalpubsub::NextOutput;

pub type WebSocketReceiver = futures_util::stream::SplitStream<WebSocketStream<TokioIo<Upgraded>>>;

pub type WebSocketSender =
	futures_util::stream::SplitSink<WebSocketStream<TokioIo<Upgraded>>, WsMessage>;

#[derive(Clone)]
pub struct UrlData {
	pub protocol_version: u16,
	pub namespace: String,
	pub runner_key: String,
}

pub fn parse_url_from_url(url: url::Url) -> Result<UrlData> {
	// Read protocol version from query parameters (required)
	let protocol_version = url
		.query_pairs()
		.find_map(|(n, v)| (n == "protocol_version").then_some(v))
		.context("missing `protocol_version` query parameter")?
		.parse::<u16>()
		.context("invalid `protocol_version` query parameter")?;

	// Read namespace from query parameters
	let namespace = url
		.query_pairs()
		.find_map(|(n, v)| (n == "namespace").then_some(v))
		.context("missing `namespace` query parameter")?
		.to_string();

	// Read runner key from query parameters (required)
	let runner_key = url
		.query_pairs()
		.find_map(|(n, v)| (n == "runner_key").then_some(v))
		.context("missing `runner_key` query parameter")?
		.to_string();

	Ok(UrlData {
		protocol_version,
		namespace,
		runner_key,
	})
}

pub fn err_to_close_frame(err: anyhow::Error) -> CloseFrame {
	let rivet_err = err
		.chain()
		.find_map(|x| x.downcast_ref::<RivetError>())
		.cloned()
		.unwrap_or_else(|| RivetError::from(&INTERNAL_ERROR));

	let code = match (rivet_err.group(), rivet_err.code()) {
		("ws", "connection_closed") => CloseCode::Normal,
		_ => CloseCode::Error,
	};

	// NOTE: reason cannot be more than 123 bytes as per the WS protocol
	let reason = util::safe_slice(
		&format!("{}.{}", rivet_err.group(), rivet_err.code()),
		0,
		123,
	)
	.into();

	CloseFrame { code, reason }
}

/// Determines if a given message kind will terminate the request.
pub fn is_to_server_tunnel_message_kind_request_close(
	kind: &protocol::ToServerTunnelMessageKind,
) -> bool {
	match kind {
		// HTTP terminal states
		protocol::ToServerTunnelMessageKind::ToServerResponseStart(resp) => !resp.stream,
		protocol::ToServerTunnelMessageKind::ToServerResponseChunk(chunk) => chunk.finish,
		protocol::ToServerTunnelMessageKind::ToServerResponseAbort => true,
		// WebSocket terminal states (either side closes)
		protocol::ToServerTunnelMessageKind::ToServerWebSocketClose(_) => true,
		_ => false,
	}
}

/// Determines if a given message kind will terminate the request.
pub fn is_to_client_tunnel_message_kind_request_close(
	kind: &protocol::ToClientTunnelMessageKind,
) -> bool {
	match kind {
		// WebSocket terminal states (either side closes)
		protocol::ToClientTunnelMessageKind::ToClientWebSocketClose(_) => true,
		_ => false,
	}
}
