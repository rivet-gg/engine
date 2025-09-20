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

use crate::utils::WebSocketSender;

pub struct TunnelActiveRequest {
	/// Subject to send replies to.
	pub gateway_reply_to: String,
}

pub struct Conn {
	pub runner_id: Id,
	pub workflow_id: Id,
	pub protocol_version: u16,
	pub ws_tx: Mutex<WebSocketSender>,

	// tx: Arc<
	// 	Mutex<
	// 		Box<
	// 			dyn futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
	// 				+ Send
	// 				+ Unpin,
	// 		>,
	// 	>,
	// >,
	pub last_rtt: AtomicU32,

	/// Active HTTP & WebSocket requests. They are separate but use the same mechanism to
	/// maintain state.
	pub tunnel_active_requests: Mutex<HashMap<RequestId, TunnelActiveRequest>>,
}

impl Conn {
	pub fn new() -> Self {
		todo!()
	}
}

// #[tracing::instrument(skip_all)]
// async fn build_connection(
// 	ctx: &StandaloneCtx,
// 	tx: &mut Option<futures_util::stream::SplitSink<HyperWebSocketStream, Message>>,
// 	rx: &mut futures_util::stream::SplitStream<HyperWebSocketStream>,
// 	UrlData {
// 		protocol_version,
// 		namespace,
// 		runner_key,
// 	}: UrlData,
// ) -> Result<(Id, Arc<Connection>)> {
// 	let namespace = ctx
// 		.op(namespace::ops::resolve_for_name_global::Input { name: namespace })
// 		.await?
// 		.ok_or_else(|| namespace::errors::Namespace::NotFound.build())?;
//
// 	tracing::debug!("new runner connection");
//
// 	// Receive init packet
// 	let (runner_id, workflow_id) = if let Some(msg) =
// 		tokio::time::timeout(Duration::from_secs(5), rx.next())
// 			.await
// 			.map_err(|_| WsError::TimedOutWaitingForInit.build())?
// 	{
// 		let buf = match msg? {
// 			Message::Binary(buf) => buf,
// 			Message::Close(_) => return Err(WsError::ConnectionClosed.build()),
// 			msg => {
// 				tracing::debug!(?msg, "invalid initial message");
// 				return Err(WsError::InvalidInitialPacket("must be a binary blob").build());
// 			}
// 		};
//
// 		let packet = versioned::ToServer::deserialize(&buf, protocol_version)
// 			.map_err(|err| WsError::InvalidPacket(err.to_string()).build())?;
//
// 		let (runner_id, workflow_id) =
// 			if let protocol::ToServer::ToServerInit(protocol::ToServerInit {
// 				name,
// 				version,
// 				total_slots,
// 				..
// 			}) = &packet
// 			{
// 				// Look up existing runner by key
// 				let existing_runner = ctx
// 					.op(pegboard::ops::runner::get_by_key::Input {
// 						namespace_id: namespace.namespace_id,
// 						name: name.clone(),
// 						key: runner_key.clone(),
// 					})
// 					.await?;
//
// 				let runner_id = if let Some(runner) = existing_runner.runner {
// 					// IMPORTANT: Before we spawn/get the workflow, we try to update the runner's last ping ts.
// 					// This ensures if the workflow is currently checking for expiry that it will not expire
// 					// (because we are about to send signals to it) and if it is already expired (but not
// 					// completed) we can choose a new runner id.
// 					let update_ping_res = ctx
// 						.op(pegboard::ops::runner::update_alloc_idx::Input {
// 							runners: vec![pegboard::ops::runner::update_alloc_idx::Runner {
// 								runner_id: runner.runner_id,
// 								action: Action::UpdatePing { rtt: 0 },
// 							}],
// 						})
// 						.await?;
//
// 					if update_ping_res
// 						.notifications
// 						.into_iter()
// 						.next()
// 						.map(|notif| matches!(notif.eligibility, RunnerEligibility::Expired))
// 						.unwrap_or_default()
// 					{
// 						// Runner expired, create a new one
// 						Id::new_v1(ctx.config().dc_label())
// 					} else {
// 						// Use existing runner
// 						runner.runner_id
// 					}
// 				} else {
// 					// No existing runner for this key, create a new one
// 					Id::new_v1(ctx.config().dc_label())
// 				};
//
// 				// Spawn a new runner workflow if one doesn't already exist
// 				let workflow_id = ctx
// 					.workflow(pegboard::workflows::runner::Input {
// 						runner_id,
// 						namespace_id: namespace.namespace_id,
// 						name: name.clone(),
// 						key: runner_key.clone(),
// 						version: version.clone(),
// 						total_slots: *total_slots,
// 					})
// 					.tag("runner_id", runner_id)
// 					.unique()
// 					.dispatch()
// 					.await?;
//
// 				(runner_id, workflow_id)
// 			} else {
// 				tracing::debug!(?packet, "invalid initial packet");
// 				return Err(WsError::InvalidInitialPacket("must be `ToServer::Init`").build());
// 			};
//
// 		// Forward to runner wf
// 		ctx.signal(pegboard::workflows::runner::Forward { inner: packet })
// 			.to_workflow_id(workflow_id)
// 			.send()
// 			.await?;
//
// 		(runner_id, workflow_id)
// 	} else {
// 		return Err(WsError::ConnectionClosed.build());
// 	};
//
// 	let tx = tx.take().context("should exist")?;
//
// 	Ok((
// 		runner_id,
// 		Arc::new(Connection {
// 			workflow_id,
// 			protocol_version,
// 			tx: Arc::new(Mutex::new(Box::new(tx)
// 				as Box<
// 					dyn futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
// 						+ Send
// 						+ Unpin,
// 				>)),
// 			last_rtt: AtomicU32::new(0),
// 		}),
// 	))
// }
