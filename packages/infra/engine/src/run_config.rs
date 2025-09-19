use anyhow::*;
use rivet_service_manager::{RunConfigData, Service, ServiceKind};

pub fn config(_rivet_config: rivet_config::Config) -> Result<RunConfigData> {
	let services = vec![
		Service::new("api_peer", ServiceKind::ApiPeer, |config, pools| {
			Box::pin(rivet_api_peer::start(config, pools))
		}),
		Service::new("guard", ServiceKind::Standalone, |config, pools| {
			Box::pin(rivet_guard::start(config, pools))
		}),
		Service::new(
			"workflow_worker",
			ServiceKind::Standalone,
			|config, pools| Box::pin(rivet_workflow_worker::start(config, pools)),
		),
		Service::new("bootstrap", ServiceKind::Oneshot, |config, pools| {
			Box::pin(rivet_bootstrap::start(config, pools))
		}),
		Service::new(
			"pegboard_serverless",
			ServiceKind::Standalone,
			|config, pools| Box::pin(pegboard_serverless::start(config, pools)),
		),
	];

	Ok(RunConfigData { services })
}
