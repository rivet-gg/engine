macro_rules! define_keys {
	($(($value:literal, $const_name:ident, $str_name:literal)),* $(,)?) => {
		$(
			pub const $const_name: usize = $value;
		)*

		pub fn key_from_str(key: &str) -> Option<usize> {
			match key {
				$(
					$str_name => Some($const_name),
				)*
				_ => None,
			}
		}

		pub fn str_from_key(key: usize) -> Option<&'static str> {
			match key {
				$(
					$const_name => Some($str_name),
				)*
				_ => None,
			}
		}
	};
}

define_keys! {
	(0, RIVET, "rivet"),
	(1, GASOLINE, "gasoline"),
	(2, KV, "kv"),
	(3, PEGBOARD, "pegboard"),
	(4, DATA, "data"),
	(5, WORKFLOW, "workflow"),
	(6, SIGNAL, "signal"),
	(7, BODY, "body"),
	(8, LEASE, "lease"),
	(9, TAG, "tag"),
	(10, INPUT, "input"),
	(11, OUTPUT, "output"),
	(12, WAKE_SIGNAL, "wake_signal"),
	(13, WAKE_DEADLINE, "wake_deadline"),
	(14, ACK_TS, "ack_ts"),
	(15, CREATE_TS, "create_ts"),
	(16, SILENCE_TS, "silence_ts"),
	(17, PENDING, "pending"),
	(18, RAY_ID, "ray_id"),
	(19, NAME, "name"),
	(20, WORKFLOW_ID, "workflow_id"),
	(21, WAKE, "wake"),
	(22, SUB_WORKFLOW, "sub_workflow"),
	(23, WORKER_INSTANCE, "worker_instance"),
	(24, LAST_PING_TS, "last_ping_ts"),
	(25, METRICS_LOCK, "metrics_lock"),
	(26, ERROR, "error"),
	(27, WAKE_SUB_WORKFLOW_ID, "wake_sub_workflow_id"),
	(28, BY_NAME_AND_TAG, "by_name_and_tag"),
	(29, HAS_WAKE_CONDITION, "has_wake_condition"),
	(30, WORKER_INSTANCE_ID, "worker_instance_id"),
	(31, DBS, "dbs"),
	(32, ACTOR, "actor"),
	(33, BY_NAME, "by_name"),
	// 34
	(35, REMAINING_MEMORY, "remaining_memory"),
	(36, REMAINING_CPU, "remaining_cpu"),
	(37, TOTAL_MEMORY, "total_memory"),
	(38, TOTAL_CPU, "total_cpu"),
	(39, NAMESPACE, "namespace"),
	// 40
	(41, DISPLAY_NAME, "display_name"),
	(42, CONNECTABLE, "connectable"),
	(43, SLEEP_TS, "sleep_ts"),
	(44, METADATA, "metadata"),
	(45, COMPRESSED_DATA, "compressed_data"),
	(46, RUNNER, "runner"),
	(47, RUNNER_ALLOC_IDX, "runner_alloc_idx"),
	(48, REMAINING_SLOTS, "remaining_slots"),
	(49, TOTAL_SLOTS, "total_slots"),
	(50, STATE, "state"),
	(51, RUNNER_ID, "runner_id"),
	(52, NAMESPACE_ID, "namespace_id"),
	(53, PENDING_ACTOR_BY_RUNNER_NAME_SELECTOR, "pending_actor_by_runner_name_selector"),
	(54, CONTAINER, "container"),
	(55, HISTORY, "history"),
	(56, ACTIVE, "active"),
	(57, FORGOTTEN, "forgotten"),
	(58, EVENT_TYPE, "event_type"),
	(59, VERSION, "version"),
	// 60
	(61, SIGNAL_ID, "signal_id"),
	(62, SUB_WORKFLOW_ID, "sub_workflow_id"),
	(63, ITERATION, "iteration"),
	(64, DEADLINE_TS, "deadline_ts"),
	(65, SLEEP_STATE, "sleep_state"),
	(66, INNER_EVENT_TYPE, "inner_event_type"),
	(67, ALL, "all"),
	(68, BY_NAME_AND_KEY, "by_name_and_key"),
	(69, DESTROY_TS, "destroy_ts"),
	(70, EPOXY, "epoxy"),
	(71, PEER_STATE, "peer_state"),
	(72, ACTOR_KV, "actor_kv"),
	(73, STOP_TS, "stop_ts"),
	(74, DRAIN_TS, "drain_ts"),
	(75, LAST_RTT, "last_rtt"),
	(76, CONNECTED_TS, "connected_ts"),
	(77, EXPIRED_TS, "expired_ts"),
	(78, KEY, "key"),
	(79, VALUE, "value"),
	(80, COMMITTED_VALUE, "committed_value"),
	(81, OPTIMISTIC_CACHE, "optimistic_cache"),
	(82, OPTIMISTIC_CACHED_VALUE, "optimistic_cached_value"),
	(83, RESERVATION, "reservation"),
	(84, INSTANCE, "instance"),
	(85, LOG, "log"),
	(86, ENTRY, "entry"),
	(87, KEY_INSTANCE, "key_instance"),
	(88, INSTANCE_NUMBER, "instance_number"),
	(89, REPLICA, "replica"),
	(90, CONFIG, "config"),
	(91, METRIC, "metric"),
	(92, CURRENT_BALLOT, "current_ballot"),
	(93, INSTANCE_BALLOT, "instance_ballot"),
	(94, SERVERLESS, "serverless"),
	(95, DESIRED_SLOTS, "desired_slots"),
	(96, BY_VARIANT, "by_variant"),
	(97, ACL, "acl"),
	(98, TOKEN, "token"),
	(99, SECRET, "secret"),
}
