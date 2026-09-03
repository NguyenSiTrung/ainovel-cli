//! Process-level supervisor tests against the mock sidecar binary
//! (`src/bin/mock_sidecar.rs`, built as `mock-sidecar`). The Go engine is
//! never built inside Rust tests.
//!
//! Covered: readiness, request/response correlation (including concurrent
//! in-flight requests), graceful shutdown (engine.exited + exit 0), grace
//! timeout force kill, unexpected exit with bounded restart and session
//! change, pending-request failure on engine death, malformed output
//! handling, duplicate-event dedupe through the event forwarder, local
//! request validation, missing binary, readiness watchdog, and request
//! timeouts.
//!
//! Mock behavior is configured per child through `SidecarConfig::env`
//! (no process-global env mutation), so tests run safely in parallel.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ainovel_desktop_lib::error::{
    DesktopError, CODE_ENGINE_UNAVAILABLE, CODE_INVALID_PAYLOAD, CODE_REQUEST_TIMEOUT,
    CODE_SIDECAR_ERROR, CODE_UNKNOWN_METHOD,
};
use ainovel_desktop_lib::events::EventForwarder;
use ainovel_desktop_lib::sidecar::{
    Health, SidecarConfig, SidecarStatus, SidecarSupervisor, SupervisorEvent,
};
use serde_json::{json, Map, Value};

fn mock_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mock-sidecar"))
}

fn test_config() -> SidecarConfig {
    let mut config = SidecarConfig::new(mock_binary());
    config.ready_timeout = Duration::from_secs(5);
    config.request_timeout = Duration::from_secs(3);
    config.shutdown_grace = Duration::from_secs(2);
    config.restart.max_attempts = 3;
    config.restart.backoff_base = Duration::from_millis(50);
    config.restart.backoff_max = Duration::from_millis(200);
    config.restart.stable_after = Duration::from_millis(400);
    config
}

/// Supervisor + collector of every supervisor event, wired through the
/// event forwarder exactly like `lib.rs` does (collector + desktop://*).
struct Harness {
    supervisor: SidecarSupervisor,
    events: Arc<Mutex<Vec<SupervisorEvent>>>,
    forwarder: Arc<EventForwarder>,
    emitted: Arc<Mutex<Vec<(String, Value)>>>,
}

impl Harness {
    /// `mock_env` entries become child-only env vars.
    fn spawn(mut config: SidecarConfig, mock_env: &[(&str, &str)]) -> Self {
        config.env = mock_env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();

        let events: Arc<Mutex<Vec<SupervisorEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let (forwarder, emitted) = EventForwarder::collector();
        let sink_events = events.clone();
        let sink_forwarder = forwarder.clone();
        let supervisor = SidecarSupervisor::new(
            config,
            Arc::new(move |event| {
                sink_forwarder.handle(event.clone());
                sink_events.lock().unwrap().push(event);
            }),
        );
        Self {
            supervisor,
            events,
            forwarder,
            emitted,
        }
    }

    fn has(&self, predicate: &dyn Fn(&SupervisorEvent) -> bool) -> bool {
        self.events.lock().unwrap().iter().any(predicate)
    }

    fn count(&self, predicate: &dyn Fn(&SupervisorEvent) -> bool) -> usize {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| predicate(e))
            .count()
    }

    /// Wait until `predicate` matches the supervisor status (poll, bounded).
    async fn wait_until_status<F: Fn(&SidecarStatus) -> bool + Copy>(
        &self,
        timeout: Duration,
        predicate: F,
    ) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if predicate(&self.supervisor.status()) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
        false
    }
}

fn is_protocol_event(name: &str) -> impl Fn(&SupervisorEvent) -> bool + '_ {
    move |event: &SupervisorEvent| matches!(event, SupervisorEvent::Protocol(ev) if ev.event == name)
}

fn ping_payload() -> Map<String, Value> {
    Map::new()
}

#[tokio::test]
async fn ready_ping_and_graceful_shutdown() {
    let harness = Harness::spawn(test_config(), &[]);

    harness.supervisor.start().await.expect("start");
    let status = harness
        .supervisor
        .wait_ready(Duration::from_secs(5))
        .await
        .expect("ready");
    assert_eq!(status.health, Health::Ready);
    let session = status.session.expect("engine.ready carries a session id");
    assert!(session.starts_with("mock-sess-"), "session: {session}");

    // engine.ping round trip.
    let payload = harness
        .supervisor
        .request("engine.ping", ping_payload())
        .await
        .expect("ping");
    assert_eq!(payload.get("pong"), Some(&json!(true)));

    // Graceful shutdown: engine.exited observed, exit 0 recorded, health
    // Stopped, and no restart was triggered by a requested shutdown.
    harness
        .supervisor
        .shutdown(Some("test finished".into()))
        .await
        .expect("shutdown");
    assert!(
        harness
            .wait_until_status(Duration::from_secs(3), |s| s.health == Health::Stopped)
            .await
    );

    let status = harness.supervisor.status();
    assert_eq!(status.health, Health::Stopped);
    assert_eq!(status.last_exit_code, Some(0), "graceful exit code 0");
    assert!(harness.has(&is_protocol_event("engine.exited")));

    // SessionExited is emitted by the reader task when it observes stdout
    // EOF, which happens asynchronously AFTER shutdown() observed the exit;
    // yield until it lands.
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while !harness.has(&|e: &SupervisorEvent| {
        matches!(e, SupervisorEvent::SessionExited { graceful: true, .. })
    }) {
        assert!(
            std::time::Instant::now() < deadline,
            "graceful SessionExited never observed; events so far: {:?}",
            harness.events.lock().unwrap().len()
        );
        tokio::time::sleep(Duration::from_millis(15)).await;
    }
    assert_eq!(status.restarts_total, 0);
    assert!(!harness.has(&|e: &SupervisorEvent| matches!(e, SupervisorEvent::Restarting { .. })));
}

#[tokio::test]
async fn concurrent_requests_correlate_by_id() {
    let harness = Harness::spawn(test_config(), &[]);
    harness.supervisor.start().await.expect("start");
    harness
        .supervisor
        .wait_ready(Duration::from_secs(5))
        .await
        .expect("ready");

    // The mock echoes the payload back; concurrent in-flight requests must
    // each receive their own response.
    let supervisor = harness.supervisor.clone();
    let mut handles = Vec::new();
    for i in 0..5 {
        let supervisor = supervisor.clone();
        handles.push(tokio::spawn(async move {
            let mut payload = Map::new();
            payload.insert("marker".into(), json!(i));
            supervisor
                .request("engine.ping", payload)
                .await
                .expect("ping response")
        }));
    }
    let mut results = Vec::new();
    for handle in handles {
        results.push(handle.await.expect("task"));
    }
    let mut markers: Vec<i64> = results
        .iter()
        .map(|payload| payload["echo"]["marker"].as_i64().unwrap())
        .collect();
    markers.sort_unstable();
    assert_eq!(markers, vec![0, 1, 2, 3, 4], "each id got its own echo");

    harness.supervisor.shutdown(None).await.expect("shutdown");
}

#[tokio::test]
async fn request_errors_map_to_structured_codes() {
    let harness = Harness::spawn(test_config(), &[]);
    harness.supervisor.start().await.expect("start");
    harness
        .supervisor
        .wait_ready(Duration::from_secs(5))
        .await
        .expect("ready");

    // Unknown method is rejected locally with the protocol's code.
    let err = harness
        .supervisor
        .request("teleport.now", ping_payload())
        .await
        .unwrap_err();
    assert_eq!(err.code, CODE_UNKNOWN_METHOD);

    // Missing required payload field likewise.
    let err = harness
        .supervisor
        .request("run.steer", ping_payload())
        .await
        .unwrap_err();
    assert_eq!(err.code, CODE_INVALID_PAYLOAD);
    assert!(err.message.contains("instruction"));

    // The mock's canned chapter.read failure surfaces the engine's code.
    let mut payload = Map::new();
    payload.insert("chapter".into(), json!(1));
    let err = harness
        .supervisor
        .request("chapter.read", payload)
        .await
        .unwrap_err();
    assert_eq!(err.code, "project_unavailable");

    harness.supervisor.shutdown(None).await.expect("shutdown");
}

#[tokio::test]
async fn requests_before_ready_fail_fast() {
    let harness = Harness::spawn(test_config(), &[]);
    let err = harness
        .supervisor
        .request("engine.ping", ping_payload())
        .await
        .unwrap_err();
    assert_eq!(err.code, CODE_ENGINE_UNAVAILABLE);
    assert_eq!(harness.supervisor.status().health, Health::Stopped);
}

#[tokio::test]
async fn malformed_output_is_skipped_and_counted() {
    let harness = Harness::spawn(test_config(), &[("MOCK_MODE", "garbage")]);
    harness.supervisor.start().await.expect("start");
    harness
        .supervisor
        .wait_ready(Duration::from_secs(5))
        .await
        .expect("ready");

    // The garbage line is skipped; the valid event after it still flows and
    // the engine still answers requests.
    assert!(
        harness
            .wait_until_status(Duration::from_secs(3), |s| s.malformed_output_lines >= 1)
            .await,
        "malformed output counted"
    );
    assert!(harness.has(&is_protocol_event("notification.info")));
    let payload = harness
        .supervisor
        .request("engine.ping", ping_payload())
        .await
        .expect("engine still responsive after garbage");
    assert_eq!(payload.get("pong"), Some(&json!(true)));

    harness.supervisor.shutdown(None).await.expect("shutdown");
}

#[tokio::test]
async fn duplicate_events_are_deduped_by_the_forwarder() {
    // dup_event: each ping re-emits one event with the SAME sequence twice.
    let harness = Harness::spawn(test_config(), &[("MOCK_MODE", "dup_event")]);
    harness.supervisor.start().await.expect("start");
    harness
        .supervisor
        .wait_ready(Duration::from_secs(5))
        .await
        .expect("ready");

    let payload = harness
        .supervisor
        .request("engine.ping", ping_payload())
        .await
        .expect("ping triggers the duplicated event");
    assert_eq!(payload.get("pong"), Some(&json!(true)));

    // Give the reader a moment to deliver both copies.
    tokio::time::sleep(Duration::from_millis(250)).await;
    let state = harness.forwarder.event_state();
    assert_eq!(state.duplicates_dropped, 1, "exact re-delivery dropped");
    assert_eq!(
        state.forwarded_count, 2,
        "ready + one notification forwarded"
    );

    // Scope the collector borrow: holding this mutex across the shutdown
    // await below would deadlock the reader task (the sink pushes into the
    // same mutex) on the current-thread test runtime.
    let event_names: Vec<String> = {
        let emitted = harness.emitted.lock().unwrap();
        emitted
            .iter()
            .filter(|(n, _)| n == "desktop://event")
            .map(|(_, v)| v["event"].as_str().unwrap().to_string())
            .collect()
    };
    assert_eq!(
        event_names,
        vec!["engine.ready".to_string(), "notification.info".to_string()],
        "duplicate never re-emitted to the frontend"
    );

    harness.supervisor.shutdown(None).await.expect("shutdown");
}

#[tokio::test]
async fn unexpected_exit_restarts_with_new_session() {
    // crash-once: the first spawn exits 1; the next spawn is healthy with a
    // fresh session id (sequence reset) — the recovery path.
    let state_file = std::env::temp_dir().join(format!(
        "mock-sidecar-crash-once-{}-{:?}",
        std::process::id(),
        std::time::Instant::now()
    ));
    let state_path = state_file.to_str().unwrap().to_string();
    let harness = Harness::spawn(
        test_config(),
        &[
            ("MOCK_MODE", "crash"),
            ("MOCK_STATE_FILE", &state_path),
            ("MOCK_DELAY_MS", "50"),
        ],
    );

    harness.supervisor.start().await.expect("first spawn");
    let first = harness
        .supervisor
        .wait_ready(Duration::from_secs(5))
        .await
        .expect("first ready");
    let first_session = first.session.expect("session");

    // The engine dies on its own; the supervisor must recover with a NEW
    // session. Wait for the stability-confirmed success (restarts_total
    // bumps and the streak resets only after `stable_after`).
    assert!(
        harness
            .wait_until_status(Duration::from_secs(10), |s| {
                s.health == Health::Ready
                    && s.session.as_deref() != Some(first_session.as_str())
                    && s.restarts_total == 1
                    && s.restart_attempts == 0
            })
            .await,
        "restarted with a new session, got {:?}",
        harness.supervisor.status()
    );

    let status = harness.supervisor.status();
    assert_eq!(status.last_exit_code, Some(1));

    // Supervisor-visible lifecycle events fired.
    assert!(harness.has(&|e: &SupervisorEvent| matches!(
        e,
        SupervisorEvent::SessionExited {
            graceful: false,
            ..
        }
    )));
    assert!(harness
        .has(&|e: &SupervisorEvent| matches!(e, SupervisorEvent::Restarting { attempt: 1, .. })));
    assert!(harness.has(&is_protocol_event("engine.ready")));

    // The recovered engine answers requests again, and the forwarder saw
    // the session change (frontend refetch trigger).
    let payload = harness
        .supervisor
        .request("engine.ping", ping_payload())
        .await
        .expect("ping after restart");
    assert_eq!(payload.get("pong"), Some(&json!(true)));
    tokio::time::sleep(Duration::from_millis(250)).await;
    let state = harness.forwarder.event_state();
    assert_eq!(state.session_changes, 1, "session change surfaced");
    assert_eq!(state.sessions_seen.len(), 2);

    harness.supervisor.shutdown(None).await.expect("shutdown");
}

#[tokio::test]
async fn restart_attempts_are_bounded() {
    // Always crash: every spawn dies; the supervisor must stop after
    // max_attempts and settle in Failed, not loop forever.
    let mut config = test_config();
    config.restart.max_attempts = 2;
    config.restart.backoff_base = Duration::from_millis(30);
    config.restart.backoff_max = Duration::from_millis(60);
    let harness = Harness::spawn(config, &[("MOCK_MODE", "crash"), ("MOCK_DELAY_MS", "30")]);

    harness
        .supervisor
        .start()
        .await
        .expect("spawn ok (dies later)");
    assert!(
        harness
            .wait_until_status(Duration::from_secs(15), |s| s.health == Health::Failed)
            .await,
        "expected terminal Failed, got {:?}",
        harness.supervisor.status()
    );

    let status = harness.supervisor.status();
    assert_eq!(status.restarts_total, 0, "no restart ever became ready");
    assert_eq!(
        status.restart_attempts, 2,
        "attempt counter holds the bound"
    );
    assert_eq!(
        harness.count(&|e: &SupervisorEvent| matches!(e, SupervisorEvent::Restarting { .. })),
        2,
        "exactly max_attempts restarts"
    );
    assert!(harness.has(&|e: &SupervisorEvent| matches!(
        e,
        SupervisorEvent::RestartFailed { attempts: 2, .. }
    )));

    // Requests while dead are structured errors, never successes.
    let err = harness
        .supervisor
        .request("engine.ping", ping_payload())
        .await
        .unwrap_err();
    assert_eq!(err.code, CODE_ENGINE_UNAVAILABLE);
}

#[tokio::test]
async fn pending_request_fails_when_engine_dies() {
    // crash_on_request: the engine exits(1) with our request in flight. The
    // request must fail with engine_unavailable — never success.
    let harness = Harness::spawn(test_config(), &[("MOCK_MODE", "crash_on_request")]);
    harness.supervisor.start().await.expect("start");
    harness
        .supervisor
        .wait_ready(Duration::from_secs(5))
        .await
        .expect("ready");

    let err: DesktopError = harness
        .supervisor
        .request("engine.ping", ping_payload())
        .await
        .expect_err("engine died with the request in flight");
    assert_eq!(err.code, CODE_ENGINE_UNAVAILABLE);
    assert!(err.message.contains("exited before responding"));

    // The supervisor restarts (fresh crash_on_request mock waits quietly).
    assert!(
        harness
            .wait_until_status(Duration::from_secs(10), |s| s.health == Health::Ready)
            .await,
        "recovered after the crash, got {:?}",
        harness.supervisor.status()
    );
    harness.supervisor.shutdown(None).await.expect("shutdown");
}

#[tokio::test]
async fn never_ready_times_out_into_failure() {
    // never_ready: silent stdout; the readiness watchdog kills the child,
    // the bounded restart runs, and the supervisor settles in Failed.
    let mut config = test_config();
    config.ready_timeout = Duration::from_millis(400);
    config.restart.max_attempts = 1;
    config.restart.backoff_base = Duration::from_millis(20);
    config.restart.backoff_max = Duration::from_millis(40);
    let harness = Harness::spawn(config, &[("MOCK_MODE", "never_ready")]);

    harness.supervisor.start().await.expect("spawn");
    let result = harness.supervisor.wait_ready(Duration::from_secs(5)).await;
    assert!(result.is_err(), "engine never became ready");
    assert_eq!(harness.supervisor.status().health, Health::Failed);

    harness
        .supervisor
        .shutdown(None)
        .await
        .expect("shutdown cleanup");
}

#[tokio::test]
async fn shutdown_grace_timeout_force_kills() {
    // hang_shutdown: replies ok to engine.shutdown but never exits; the
    // supervisor must force-kill after the grace period and return.
    let mut config = test_config();
    config.shutdown_grace = Duration::from_millis(500);
    let harness = Harness::spawn(config, &[("MOCK_MODE", "hang_shutdown")]);
    harness.supervisor.start().await.expect("start");
    harness
        .supervisor
        .wait_ready(Duration::from_secs(5))
        .await
        .expect("ready");

    let started = std::time::Instant::now();
    harness
        .supervisor
        .shutdown(Some("force kill test".into()))
        .await
        .expect("shutdown completes via force kill");
    let elapsed = started.elapsed();
    assert!(
        elapsed < Duration::from_secs(3),
        "force kill happened promptly, took {elapsed:?}"
    );
    assert!(
        harness
            .wait_until_status(Duration::from_secs(2), |s| s.health == Health::Stopped)
            .await
    );
}

#[tokio::test]
async fn request_times_out_when_engine_is_slow() {
    let mut config = test_config();
    config.request_timeout = Duration::from_millis(250);
    let harness = Harness::spawn(config, &[("MOCK_MODE", "slow"), ("MOCK_DELAY_MS", "900")]);
    harness.supervisor.start().await.expect("start");
    harness
        .supervisor
        .wait_ready(Duration::from_secs(5))
        .await
        .expect("ready");

    let err = harness
        .supervisor
        .request("engine.ping", ping_payload())
        .await
        .expect_err("slow ping exceeds the timeout");
    assert_eq!(err.code, CODE_REQUEST_TIMEOUT);
    assert!(
        err.details.is_some(),
        "timeout error carries the request id"
    );

    harness.supervisor.shutdown(None).await.expect("shutdown");
}

#[tokio::test]
async fn missing_binary_reports_structured_error() {
    let mut config = test_config();
    config.binary = PathBuf::from("/definitely/not/a/real/sidecar-binary");
    config.restart.max_attempts = 1;
    config.restart.backoff_base = Duration::from_millis(10);
    config.restart.backoff_max = Duration::from_millis(20);
    let harness = Harness::spawn(config, &[]);

    let err = harness.supervisor.start().await.expect_err("no binary");
    assert_eq!(err.code, CODE_SIDECAR_ERROR);
    assert_eq!(harness.supervisor.status().health, Health::Failed);
    let _ = harness.supervisor.shutdown(None).await;
}

#[tokio::test]
async fn shutdown_is_idempotent() {
    let harness = Harness::spawn(test_config(), &[]);
    harness.supervisor.start().await.expect("start");
    harness
        .supervisor
        .wait_ready(Duration::from_secs(5))
        .await
        .expect("ready");

    harness.supervisor.shutdown(None).await.expect("first");
    harness.supervisor.shutdown(None).await.expect("second");
    assert_eq!(harness.supervisor.status().health, Health::Stopped);
}

#[tokio::test]
async fn stderr_is_forwarded_to_the_log_counter() {
    // The mock logs its mode banner on stderr; the supervisor counts lines
    // (the text itself goes through the `log` facade).
    let harness = Harness::spawn(test_config(), &[]);
    harness.supervisor.start().await.expect("start");
    harness
        .supervisor
        .wait_ready(Duration::from_secs(5))
        .await
        .expect("ready");
    assert!(
        harness
            .wait_until_status(Duration::from_secs(2), |s| s.stderr_lines >= 1)
            .await,
        "stderr lines counted"
    );
    harness.supervisor.shutdown(None).await.expect("shutdown");
}
