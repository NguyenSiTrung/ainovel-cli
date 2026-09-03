//! Engine provider boundary.
//!
//! The desktop shell talks to "the engine" through [`EngineProvider`]. The
//! release-one implementation is [`GoSidecarProvider`] wrapping the process
//! supervisor from `sidecar.rs`; a future `RustEngineProvider` (in-process
//! engine) can slot in behind the same trait without touching the command or
//! event layers. There is deliberately no user-facing provider selection
//! yet — the active provider is wired at startup in `lib.rs`.

use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Map, Value};

use crate::error::DesktopError;
use crate::sidecar::{Health, SidecarConfig, SidecarStatus, SidecarSupervisor};

/// Provider-agnostic status snapshot returned to the frontend.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider: &'static str,
    pub protocol: &'static str,
    pub health: Health,
    pub stopping: bool,
    pub session: Option<String>,
    pub pid: Option<u32>,
    pub restart_attempts: u32,
    pub restarts_total: u32,
    pub malformed_output_lines: u64,
    pub stderr_lines: u64,
    pub last_error: Option<String>,
    pub last_exit_code: Option<i32>,
}

impl ProviderStatus {
    fn from_sidecar(provider: &'static str, status: SidecarStatus) -> Self {
        Self {
            provider,
            protocol: crate::protocol::PROTOCOL_ID,
            health: status.health,
            stopping: status.stopping,
            session: status.session,
            pid: status.pid,
            restart_attempts: status.restart_attempts,
            restarts_total: status.restarts_total,
            malformed_output_lines: status.malformed_output_lines,
            stderr_lines: status.stderr_lines,
            last_error: status.last_error,
            last_exit_code: status.last_exit_code,
        }
    }
}

/// The engine boundary consumed by the Tauri commands.
#[async_trait]
pub trait EngineProvider: Send + Sync {
    fn name(&self) -> &'static str;

    /// Spawn the engine and run the bounded recovery policy. Returns once
    /// the post-policy outcome is decided; pair with [`EngineProvider::wait_ready`].
    async fn start(&self) -> Result<(), DesktopError>;

    /// Block until the engine reports readiness (or fails terminally).
    async fn wait_ready(&self, wait: Duration) -> Result<(), DesktopError>;

    /// One protocol request; resolves with the success payload or a
    /// structured error ({code, message, details?}).
    async fn request(
        &self,
        method: &str,
        payload: Map<String, Value>,
    ) -> Result<Map<String, Value>, DesktopError>;

    /// Graceful stop; force-terminates after the grace period.
    async fn shutdown(&self, reason: Option<String>) -> Result<(), DesktopError>;

    /// Graceful stop followed by a fresh start (new engine session; the
    /// frontend must refetch its snapshot afterwards).
    async fn restart(&self, reason: Option<String>) -> Result<(), DesktopError>;

    fn status(&self) -> ProviderStatus;
}

/// Production provider: supervises the Go engine sidecar process.
pub struct GoSidecarProvider {
    supervisor: SidecarSupervisor,
}

impl GoSidecarProvider {
    pub fn new(supervisor: SidecarSupervisor) -> Self {
        Self { supervisor }
    }

    /// Expose the underlying supervisor config (tests, diagnostics).
    pub fn config(&self) -> &SidecarConfig {
        &self.supervisor.config_ref()
    }
}

#[async_trait]
impl EngineProvider for GoSidecarProvider {
    fn name(&self) -> &'static str {
        "go-sidecar"
    }

    async fn start(&self) -> Result<(), DesktopError> {
        self.supervisor.start().await
    }

    async fn wait_ready(&self, wait: Duration) -> Result<(), DesktopError> {
        self.supervisor.wait_ready(wait).await.map(|_| ())
    }

    async fn request(
        &self,
        method: &str,
        payload: Map<String, Value>,
    ) -> Result<Map<String, Value>, DesktopError> {
        self.supervisor.request(method, payload).await
    }

    async fn shutdown(&self, reason: Option<String>) -> Result<(), DesktopError> {
        self.supervisor.shutdown(reason).await
    }

    async fn restart(&self, reason: Option<String>) -> Result<(), DesktopError> {
        self.supervisor.shutdown(reason.clone()).await?;
        self.supervisor.start().await?;
        self.supervisor
            .wait_ready(self.supervisor.config_ref().ready_timeout)
            .await
            .map(|_| ())
    }

    fn status(&self) -> ProviderStatus {
        ProviderStatus::from_sidecar(self.name(), self.supervisor.status())
    }
}
