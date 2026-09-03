//! AI Novel desktop shell (Tauri 2).
//!
//! Layout:
//! * [`protocol`] — desktop-v1 envelope types + line parser (fixtures-tested).
//! * [`sidecar`]  — process supervisor: spawn, correlation, health, shutdown,
//!   bounded restart.
//! * [`provider`] — `EngineProvider` trait boundary (`GoSidecarProvider`
//!   today; a future in-process `RustEngineProvider` slots in here).
//! * [`events`]   — sequence/replay bookkeeping + Tauri event forwarding.
//! * [`commands`] — the `desktop_*` Tauri command surface for the frontend.
//! * [`paths`]    — native path resolution/validation and sidecar lookup.
//! * [`error`]    — structured `{code, message, details?}` errors.

pub mod commands;
pub mod error;
pub mod events;
pub mod paths;
pub mod protocol;
pub mod provider;
pub mod sidecar;

use std::sync::Arc;

use tauri::{Emitter, Manager};

use crate::commands::DesktopState;
use crate::events::EventForwarder;
use crate::provider::GoSidecarProvider;
use crate::sidecar::{SidecarConfig, SidecarSupervisor};

/// Env var enabling the one-shot development startup smoke: the app fully
/// initializes (context codegen, setup wiring, command registration, engine
/// sidecar start) and exits before entering the event loop.
pub const SMOKE_EXIT_ENV: &str = "AINOVEL_DESKTOP_SMOKE_EXIT";

/// Build and run the desktop application.
///
/// With [`SMOKE_EXIT_ENV`] set, runs the startup smoke checks and exits
/// before the event loop (development/testing aid; see tests/app_startup.rs
/// and README.md).
pub fn run() {
    init_logger();

    let app = configure_app(tauri::Builder::default())
        .build(tauri::generate_context!())
        .expect("error while running the desktop application");

    if std::env::var_os(SMOKE_EXIT_ENV).is_some() {
        // The setup hook runs on the event loop's Ready event, so the smoke
        // checks run there too and exit the loop immediately after.
        log::info!(target: "smoke", "smoke mode: entering event loop");
        let code = app.run_return(|handle, event| {
            if matches!(event, tauri::RunEvent::Ready) {
                smoke_exit_checks(handle);
                handle.exit(0);
            }
        });
        log::info!(target: "smoke", "smoke exit complete (exit code {code})");
        return;
    }

    app.run(|_app, _event| {});
}

/// The complete app wiring (setup, managed state, command registration),
/// runtime-generic so the startup tests can drive it on tauri's mock
/// runtime (`tauri::test`) exactly like production drives it on wry.
pub fn configure_app<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        // Native file/directory pickers for the frontend (project dir
        // selection, export destination). The capability grant is limited to
        // `dialog:default` (capabilities/default.json); the frontend only
        // ever receives a path string, which it forwards to project.open /
        // project.create — no filesystem access happens in the webview.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // Event forwarding: supervisor observations -> Tauri events
            // (desktop://event, desktop://session, desktop://status).
            let app_for_events = handle.clone();
            let forwarder = Arc::new(EventForwarder::new(Arc::new(
                move |name: &str, payload: serde_json::Value| {
                    if let Err(e) = app_for_events.emit(name, payload) {
                        log::warn!(target: "events", "emit {name} failed: {e}");
                    }
                },
            )));

            // Sidecar binary resolution: AINOVEL_SIDECAR env override first,
            // then the externalBin sibling naming convention (see paths.rs
            // and README.md for the dev story).
            let exe_dir = std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(|p| p.to_path_buf()));
            let sidecar_source = paths::resolve_sidecar_path(
                std::env::var("AINOVEL_SIDECAR").ok().as_deref(),
                exe_dir.as_deref(),
            )
            .map_err(|e| {
                log::error!(
                    target: "sidecar",
                    "sidecar binary resolution failed: {} \
                     (set AINOVEL_SIDECAR=/path/to/engine for dev runs)",
                    e.message
                );
                e
            })
            .ok();

            let config = sidecar_source.as_ref().map(|source| {
                let mut config = SidecarConfig::new(source.path().to_path_buf());
                // Fixed argument vector; validated executable path.
                config.args = vec!["--desktop-daemon".to_string()];
                config
            });

            let state = match config {
                Some(config) => {
                    let forwarder_for_sink = forwarder.clone();
                    let supervisor = SidecarSupervisor::new(
                        config,
                        Arc::new(move |event| forwarder_for_sink.handle(event)),
                    );
                    DesktopState {
                        provider: Arc::new(GoSidecarProvider::new(supervisor)),
                        forwarder,
                        sidecar_source,
                    }
                }
                None => {
                    // No engine binary: the app still starts so the UI can
                    // show a structured error; engine commands will report
                    // engine_unavailable via the same boundary.
                    let forwarder_for_sink = forwarder.clone();
                    let supervisor = SidecarSupervisor::new(
                        SidecarConfig::new(std::path::PathBuf::from(
                            "/unresolvable-sidecar-binary",
                        )),
                        Arc::new(move |event| forwarder_for_sink.handle(event)),
                    );
                    DesktopState {
                        provider: Arc::new(GoSidecarProvider::new(supervisor)),
                        forwarder,
                        sidecar_source: None,
                    }
                }
            };

            // Auto-start the engine in the background; readiness (and any
            // failure) is observable through desktop_status and the
            // desktop://status events.
            let provider = state.provider.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = provider.start().await {
                    log::error!(target: "sidecar", "engine start failed: {}", e.message);
                }
            });

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::desktop_request,
            commands::desktop_status,
            commands::desktop_start,
            commands::desktop_shutdown,
            commands::desktop_restart,
            commands::desktop_event_state,
            commands::desktop_paths,
            commands::desktop_validate_project_dir,
        ])
}

/// One-shot startup smoke (see [`SMOKE_EXIT_ENV`]): wait for engine
/// readiness, round-trip a request, and shut down, logging each step.
fn smoke_exit_checks<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use std::time::Duration;

    let provider = app.state::<DesktopState>().provider.clone();
    let report = tauri::async_runtime::block_on(async {
        let mut report = Vec::new();
        match provider.wait_ready(Duration::from_secs(10)).await {
            Ok(()) => {
                let status = provider.status();
                report.push(format!(
                    "engine ready: health={:?} session={:?}",
                    status.health, status.session
                ));
            }
            Err(e) => report.push(format!("engine NOT ready: {e}")),
        }
        match provider
            .request("engine.ping", serde_json::Map::new())
            .await
        {
            Ok(payload) => report.push(format!(
                "engine.ping ok: {}",
                serde_json::to_string(&payload).unwrap_or_default()
            )),
            Err(e) => report.push(format!("engine.ping FAILED: {e}")),
        }
        let status = provider.status();
        report.push(format!(
            "status: health={:?} restarts_total={} malformed_output_lines={}",
            status.health, status.restarts_total, status.malformed_output_lines
        ));
        match provider.shutdown(Some("smoke exit".into())).await {
            Ok(()) => report.push(format!(
                "shutdown ok: final health={:?}",
                provider.status().health
            )),
            Err(e) => report.push(format!("shutdown FAILED: {e}")),
        }
        report
    });
    for line in report {
        log::info!(target: "smoke", "{line}");
    }
}

/// Minimal logger: stderr with timestamps. The engine's own logs arrive on
/// the sidecar stderr stream and are tagged `sidecar::stderr`.
fn init_logger() {
    struct ShellLogger;
    impl log::Log for ShellLogger {
        fn enabled(&self, metadata: &log::Metadata) -> bool {
            metadata.level() <= log::Level::Debug
        }
        fn log(&self, record: &log::Record) {
            if !self.enabled(record.metadata()) {
                return;
            }
            eprintln!(
                "[{:?} {} {}] {}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                record.level(),
                record.target(),
                record.args()
            );
        }
        fn flush(&self) {}
    }
    let _ = log::set_boxed_logger(Box::new(ShellLogger));
    log::set_max_level(log::LevelFilter::Info);
}
