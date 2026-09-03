//! Typed Tauri commands invoked by the frontend (task 4 consumes these
//! EXACTLY; see desktop/src-tauri/README.md for the full contract).
//!
//! Every engine interaction goes through `desktop_request`, which returns
//! the success payload as JSON or rejects with a structured
//! `{code, message, details?}` error (protocol error codes plus the
//! shell-extension codes engine_unavailable / request_timeout /
//! sidecar_error / invalid_path). Commands are async and run on the Tauri
//! async runtime; none of them block the main thread.

use std::path::PathBuf;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{Manager, State};

use crate::error::DesktopError;
use crate::events::{EventForwarder, EventState};
use crate::paths::{self, ProjectDirReport, SidecarSource};
use crate::provider::{EngineProvider, ProviderStatus};

/// Managed Tauri state: the active engine provider plus the event
/// forwarder used for `desktop_event_state`.
pub struct DesktopState {
    pub provider: std::sync::Arc<dyn EngineProvider>,
    pub forwarder: std::sync::Arc<EventForwarder>,
    pub sidecar_source: Option<SidecarSource>,
}

/// Send one desktop-v1 request to the engine and await its response.
///
/// - `method`: one of the 48 catalog method names.
/// - `payload`: optional method arguments object (defaults to `{}`).
///
/// Resolves with the response payload; rejects with
/// `{code, message, details?}` (protocol codes plus shell extensions).
#[tauri::command]
pub async fn desktop_request(
    state: State<'_, DesktopState>,
    method: String,
    payload: Option<Map<String, Value>>,
) -> Result<Map<String, Value>, DesktopError> {
    let payload = payload.unwrap_or_default();
    state.provider.request(&method, payload).await
}

/// Supervisor/provider snapshot (health, session, restarts, counters).
#[tauri::command]
pub fn desktop_status(state: State<'_, DesktopState>) -> ProviderStatus {
    state.provider.status()
}

/// Start the engine (idempotent) and wait for readiness. Rejects with a
/// structured error when the engine cannot become ready (bad binary,
/// startup error, restarts exhausted).
#[tauri::command]
pub async fn desktop_start(state: State<'_, DesktopState>) -> Result<ProviderStatus, DesktopError> {
    state.provider.start().await?;
    let ready_timeout = std::time::Duration::from_secs(10);
    state.provider.wait_ready(ready_timeout).await?;
    Ok(state.provider.status())
}

/// Graceful engine shutdown (`engine.shutdown` + grace period + force kill).
#[tauri::command]
pub async fn desktop_shutdown(
    state: State<'_, DesktopState>,
    reason: Option<String>,
) -> Result<ProviderStatus, DesktopError> {
    state.provider.shutdown(reason).await?;
    Ok(state.provider.status())
}

/// Graceful stop followed by a fresh start. The engine session id changes:
/// the frontend receives `desktop://session` and must refetch its snapshot.
#[tauri::command]
pub async fn desktop_restart(
    state: State<'_, DesktopState>,
    reason: Option<String>,
) -> Result<ProviderStatus, DesktopError> {
    state.provider.restart(reason).await?;
    Ok(state.provider.status())
}

/// Event bookkeeping: dedupe counters, current session, last sequence
/// (replay cursor for `project.replay_events` / `logs.replay`).
#[tauri::command]
pub fn desktop_event_state(state: State<'_, DesktopState>) -> EventState {
    state.forwarder.event_state()
}

/// Native path information for the frontend (project picker defaults,
/// diagnostics). `sidecarPath` is where the engine binary was resolved from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPaths {
    pub app_data_dir: PathBuf,
    pub projects_dir: PathBuf,
    pub sidecar_path: Option<PathBuf>,
    pub sidecar_source: Option<String>,
    pub target_triple: &'static str,
}

// Runtime-generic so the same command registration serves both the wry app
// and tauri's mock runtime in the startup tests.
#[tauri::command]
pub fn desktop_paths<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, DesktopState>,
) -> Result<DesktopPaths, DesktopError> {
    let data_dir = paths::app_data_dir(&app)?;
    let home = app
        .path()
        .home_dir()
        .map_err(|e| DesktopError::internal(format!("cannot resolve home dir: {e}")))?;
    Ok(DesktopPaths {
        projects_dir: paths::default_projects_dir(&home),
        app_data_dir: data_dir,
        sidecar_path: state
            .sidecar_source
            .as_ref()
            .map(|s| s.path().to_path_buf()),
        sidecar_source: state
            .sidecar_source
            .as_ref()
            .map(|s| s.source_label().to_string()),
        target_triple: paths::target_triple(),
    })
}

/// Native validation of a directory the frontend wants to open as a
/// project: absolute + normalized (no `..` traversal), exists, is a
/// directory. `recognized` is a best-effort hint; the engine stays the
/// authority on project validity.
#[tauri::command]
pub fn desktop_validate_project_dir(path: String) -> Result<ProjectDirReport, DesktopError> {
    paths::validate_project_dir(&path)
}

impl SidecarSource {
    pub fn source_label(&self) -> &'static str {
        match self {
            SidecarSource::EnvOverride { .. } => "env_override",
            SidecarSource::ExeSiblingTriple { .. } => "exe_sibling_triple",
            SidecarSource::ExeSiblingPlain { .. } => "exe_sibling_plain",
        }
    }
}
