//! Startup tests: boot the REAL app wiring (`configure_app` — setup hook,
//! managed state, emit wiring, command registration) on tauri's mock
//! runtime, which needs no display and no real webview.
//!
//! Covered:
//! * the no-binary boot path (sidecar resolution fails, app still builds,
//!   commands answer with structured errors);
//! * command registration and a full IPC round trip with the mock sidecar
//!   via the `AINOVEL_SIDECAR` override (`desktop_request`, error mapping,
//!   event bookkeeping through `desktop_event_state`).
//!
//! `generate_context!` (wry codegen) is additionally exercised by every
//! `cargo build`/`cargo check` of the binaries and by the recorded
//! `AINOVEL_DESKTOP_SMOKE_EXIT=1 cargo run` smoke run (see README.md).

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::webview::InvokeRequest;
use tauri::Manager;

use ainovel_desktop_lib::commands::DesktopState;
use ainovel_desktop_lib::configure_app;

fn mock_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mock-sidecar"))
}

/// The setup hook reads AINOVEL_SIDECAR at build time; serialize env
/// mutation between the two startup tests (they run in one process).
fn env_lock() -> MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn build_app() -> tauri::App<MockRuntime> {
    let mut app = configure_app(mock_builder())
        .build(mock_context(noop_assets()))
        .expect("app builds with the real wiring");
    // The setup hook runs on the event loop's Ready event; one mock
    // iteration triggers it exactly like the real Ready flow.
    #[allow(deprecated)]
    app.run_iteration(|_app, _event| {});
    app
}

fn main_webview(app: &tauri::App<MockRuntime>) -> tauri::WebviewWindow<MockRuntime> {
    tauri::WebviewWindowBuilder::new(app, "main", Default::default())
        .build()
        .expect("mock webview builds")
}

fn invoke(
    webview: &tauri::WebviewWindow<MockRuntime>,
    cmd: &str,
    args: Value,
) -> Result<Value, Value> {
    let request = InvokeRequest {
        cmd: cmd.to_string(),
        callback: tauri::ipc::CallbackFn(0),
        error: tauri::ipc::CallbackFn(1),
        url: if cfg!(any(windows, target_os = "android")) {
            "http://tauri.localhost"
        } else {
            "tauri://localhost"
        }
        .parse()
        .unwrap(),
        body: tauri::ipc::InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.to_string(),
    };
    tauri::test::get_ipc_response(webview, request)
        .map(|body| body.deserialize::<Value>().expect("valid json body"))
}

#[test]
fn app_boots_without_sidecar_binary_and_answers_structured_errors() {
    let _env = env_lock();
    std::env::remove_var("AINOVEL_SIDECAR");

    let app = build_app();
    assert!(
        app.try_state::<DesktopState>().is_some(),
        "setup hook managed DesktopState even without a sidecar binary"
    );
    let state = app.state::<DesktopState>();
    assert!(state.sidecar_source.is_none(), "no binary was resolved");

    // Registered commands answer over IPC even in the degraded state.
    let webview = main_webview(&app);
    let status = invoke(&webview, "desktop_status", json!({})).expect("desktop_status answers");
    assert_eq!(status["provider"], "go-sidecar");
    assert_eq!(status["protocol"], "desktop-v1");
    assert!(
        ["stopped", "starting", "restarting", "failed"]
            .contains(&status["health"].as_str().unwrap()),
        "degraded health, got {status}"
    );

    // Requests fail fast with the structured engine_unavailable error.
    let err = invoke(
        &webview,
        "desktop_request",
        json!({"method": "engine.ping"}),
    )
    .expect_err("no engine: request must fail");
    assert_eq!(err["code"], "engine_unavailable", "got {err}");
}

#[test]
fn app_commands_round_trip_with_mock_sidecar() {
    let _env = env_lock();
    let binary = mock_binary();
    std::env::set_var("AINOVEL_SIDECAR", &binary);

    let app = build_app();
    let state = app.state::<DesktopState>();
    assert_eq!(
        state.sidecar_source.as_ref().map(|s| s.path()),
        Some(binary.as_path()),
        "AINOVEL_SIDECAR override resolved"
    );

    // The setup hook auto-starts the engine on the tauri async runtime;
    // wait for readiness through the same provider the commands use.
    let provider = state.provider.clone();
    tauri::async_runtime::block_on(async {
        provider
            .wait_ready(Duration::from_secs(10))
            .await
            .expect("engine ready through the app wiring");
    });

    let webview = main_webview(&app);

    // Full IPC round trip: desktop_request -> supervisor -> mock engine.
    let payload = invoke(
        &webview,
        "desktop_request",
        json!({"method": "engine.ping", "payload": {"marker": 42}}),
    )
    .expect("desktop_request round trip");
    assert_eq!(payload["pong"], true, "got {payload}");
    assert_eq!(payload["echo"]["marker"], 42);

    // Structured error mapping over IPC: unknown method is rejected with
    // the protocol's own code before anything hits the process.
    let err = invoke(
        &webview,
        "desktop_request",
        json!({"method": "teleport.now"}),
    )
    .expect_err("unknown method must reject");
    assert_eq!(err["code"], "unknown_method", "got {err}");
    assert!(err["message"].as_str().unwrap().contains("teleport.now"));

    // Event bookkeeping observed through the command surface: engine.ready
    // was forwarded exactly once into the frontend-facing state.
    let event_state =
        invoke(&webview, "desktop_event_state", json!({})).expect("desktop_event_state answers");
    assert!(
        event_state["session"]
            .as_str()
            .unwrap()
            .starts_with("mock-sess-"),
        "got {event_state}"
    );
    assert_eq!(event_state["forwardedCount"], 1, "got {event_state}");
    assert_eq!(event_state["duplicatesDropped"], 0);

    let status = invoke(&webview, "desktop_status", json!({})).expect("desktop_status answers");
    assert_eq!(status["health"], "ready", "got {status}");
    assert_eq!(status["provider"], "go-sidecar");

    // Graceful shutdown through the command surface.
    let final_status = invoke(&webview, "desktop_shutdown", json!({"reason": "test done"}))
        .expect("desktop_shutdown answers");
    assert_eq!(final_status["health"], "stopped", "got {final_status}");
}
