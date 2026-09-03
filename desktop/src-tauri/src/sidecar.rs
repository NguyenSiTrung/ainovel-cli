//! Sidecar process supervisor.
//!
//! Owns the Go engine child process (`<binary> --desktop-daemon`) speaking
//! the desktop-v1 NDJSON protocol on private stdin/stdout pipes, with logs
//! forwarded from stderr. Responsibilities:
//!
//! * launch with a validated executable path and fixed arguments (direct
//!   exec; no shell, no interpolation, inherited environment);
//! * async stdout line reading with [`ParseMode::Runtime`] tolerance:
//!   responses are correlated by request id, events are forwarded to the
//!   configured sink, malformed lines are skipped and surfaced as a health
//!   signal (counter + sample), never crashing the reader;
//! * readiness = the first `engine.ready` event; a health state machine
//!   tracks Stopped/Starting/Ready/Restarting/Exited/Failed;
//! * graceful shutdown: send `engine.shutdown`, wait out the grace period,
//!   then force-kill through the tokio child API;
//! * unexpected exit: surface an exited-equivalent state, then bounded
//!   restart with backoff. Operation success is NEVER inferred from process
//!   exit: every pending request fails with a structured
//!   `engine_unavailable` error when the process goes away.
//!
//! A new engine `session` id (README section 4) means the engine restarted
//! and sequence numbers reset; the supervisor records the session and the
//! event layer (`events.rs`) reacts on top.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, Mutex as AsyncMutex};
use tokio::time::{timeout, Instant};

use crate::error::DesktopError;
use crate::paths;
use crate::protocol::{self, EventEnvelope, Message, ParseMode, ParsedLine, ResponseEnvelope};

/// Callback receiving every supervisor observation. Must be cheap and
/// non-blocking; the Tauri wiring emits frontend events from it.
pub type EventSink = Arc<dyn Fn(SupervisorEvent) + Send + Sync>;

/// Restart policy for unexpected exits (and failed launches).
#[derive(Debug, Clone)]
pub struct RestartPolicy {
    /// Maximum consecutive restart attempts before giving up (health
    /// becomes `Failed`). The streak only resets after a restarted engine
    /// stays ready for `stable_after`, so a flapping engine (ready, crash,
    /// ready, crash, ...) is still bounded.
    pub max_attempts: u32,
    pub backoff_base: Duration,
    pub backoff_max: Duration,
    /// Uptime required before a restart is considered stable (and the
    /// attempt streak resets).
    pub stable_after: Duration,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            backoff_base: Duration::from_millis(250),
            backoff_max: Duration::from_secs(4),
            stable_after: Duration::from_secs(5),
        }
    }
}

impl RestartPolicy {
    /// Exponential backoff: base * 2^(attempt-1), capped at `backoff_max`.
    pub fn backoff_for(&self, attempt: u32) -> Duration {
        let shift = attempt.saturating_sub(1).min(16);
        self.backoff_base
            .saturating_mul(1u32 << shift)
            .min(self.backoff_max)
    }
}

/// Process-level configuration. Defaults are tuned for the desktop app;
/// tests use short timeouts and small backoffs.
#[derive(Debug, Clone)]
pub struct SidecarConfig {
    pub binary: PathBuf,
    pub args: Vec<String>,
    /// Extra environment variables set ONLY on the child (inherited
    /// environment plus these). Keeps child configuration per-instance —
    /// tests configure mock modes without process-global env races.
    pub env: Vec<(String, String)>,
    pub ready_timeout: Duration,
    pub request_timeout: Duration,
    pub shutdown_grace: Duration,
    pub restart: RestartPolicy,
}

impl SidecarConfig {
    pub fn new(binary: PathBuf) -> Self {
        Self {
            binary,
            args: vec!["--desktop-daemon".to_string()],
            env: Vec::new(),
            ready_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(120),
            shutdown_grace: Duration::from_secs(5),
            restart: RestartPolicy::default(),
        }
    }
}

/// Supervisor health state machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    /// Never started, or stopped by request.
    Stopped,
    /// Spawned, waiting for the first `engine.ready`.
    Starting,
    /// `engine.ready` observed; session established.
    Ready,
    /// Exited unexpectedly; bounded restart loop active.
    Restarting,
    /// Exited unexpectedly; restart decision pending (transient).
    Exited,
    /// Start failed or restart attempts exhausted; `last_error` is set.
    Failed,
}

/// Snapshot of supervisor state (surfaced by `desktop_status`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarStatus {
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
    pub binary: PathBuf,
}

/// Everything the supervisor reports to the event layer.
#[derive(Debug, Clone)]
pub enum SupervisorEvent {
    /// A structurally valid protocol event from engine stdout (dedupe and
    /// session bookkeeping happen in `events.rs`, not here).
    Protocol(EventEnvelope),
    /// `engine.ready` observed (session established or re-established).
    SessionReady {
        session: Option<String>,
    },
    /// Engine process gone. `graceful` is true only when a supervisor
    /// shutdown was in progress; `exit_code` is the raw process exit code
    /// (None when killed by signal or unknown).
    SessionExited {
        last_session: Option<String>,
        exit_code: Option<i32>,
        graceful: bool,
    },
    Restarting {
        attempt: u32,
        reason: String,
    },
    RestartFailed {
        attempts: u32,
        reason: String,
    },
    /// Malformed or schema-violating engine output was skipped.
    MalformedOutput {
        count: u64,
        sample: String,
    },
}

pub struct SidecarSupervisor {
    inner: Arc<Inner>,
}

impl Clone for SidecarSupervisor {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

struct Inner {
    config: SidecarConfig,
    sink: EventSink,
    health: Mutex<Health>,
    stopping: AtomicBool,
    session: Mutex<Option<String>>,
    pid: Mutex<Option<u32>>,
    /// stdin of the live child; `None` means no live session (EOF signaled).
    stdin_slot: AsyncMutex<Option<ChildStdin>>,
    /// the live child; used for exit polling and force kill.
    child_slot: AsyncMutex<Option<Child>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Map<String, Value>, DesktopError>>>>,
    next_id: AtomicU64,
    restart_claim: AtomicBool,
    restart_attempts: AtomicU32,
    restarts_total: AtomicU32,
    malformed_lines: AtomicU64,
    stderr_lines: AtomicU64,
    last_error: Mutex<Option<String>>,
    last_exit_code: Mutex<Option<i32>>,
    /// Serializes start/shutdown lifecycle transitions.
    lifecycle: AsyncMutex<()>,
    /// Reader tasks report unexpected exits to the supervisor actor over
    /// this channel. The indirection is deliberate: the async fn call
    /// graph is cyclic (reader -> exit handler -> restart loop -> launcher
    /// -> reader), and rustc cannot infer Send for mutually recursive
    /// opaque future types. The channel breaks the cycle structurally.
    exit_tx: tokio::sync::mpsc::UnboundedSender<u64>,
    exit_rx: AsyncMutex<Option<tokio::sync::mpsc::UnboundedReceiver<u64>>>,
    actor_started: AtomicBool,
    /// Monotonic launch generation. Exit notices carry the generation of
    /// the session that died; the actor ignores notices from superseded
    /// sessions so restart cycles are never double-triggered.
    launch_generation: AtomicU64,
    /// When the current session last observed engine.ready (stability
    /// bookkeeping for the restart policy).
    session_ready_at: Mutex<Option<Instant>>,
}

impl SidecarSupervisor {
    pub fn new(config: SidecarConfig, sink: EventSink) -> Self {
        let (exit_tx, exit_rx) = tokio::sync::mpsc::unbounded_channel();
        Self {
            inner: Arc::new(Inner {
                config,
                sink,
                health: Mutex::new(Health::Stopped),
                stopping: AtomicBool::new(false),
                session: Mutex::new(None),
                pid: Mutex::new(None),
                stdin_slot: AsyncMutex::new(None),
                child_slot: AsyncMutex::new(None),
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
                restart_claim: AtomicBool::new(false),
                restart_attempts: AtomicU32::new(0),
                restarts_total: AtomicU32::new(0),
                malformed_lines: AtomicU64::new(0),
                stderr_lines: AtomicU64::new(0),
                last_error: Mutex::new(None),
                last_exit_code: Mutex::new(None),
                lifecycle: AsyncMutex::new(()),
                exit_tx,
                exit_rx: AsyncMutex::new(Some(exit_rx)),
                actor_started: AtomicBool::new(false),
                launch_generation: AtomicU64::new(0),
                session_ready_at: Mutex::new(None),
            }),
        }
    }

    fn arc(&self) -> Arc<Inner> {
        self.inner.clone()
    }

    /// Validate the configured binary and spawn the first session.
    /// Idempotent while a session is live. If the first launch fails (or the
    /// engine dies before readiness), the bounded restart policy runs before
    /// returning, so the returned state reflects the post-policy outcome.
    pub async fn start(&self) -> Result<(), DesktopError> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        let inner = self.arc();

        if matches!(
            inner.health(),
            Health::Ready | Health::Starting | Health::Restarting | Health::Exited
        ) {
            // Already live, or the restart loop owns recovery. `Exited` is
            // the transient state between an unexpected exit and the loop
            // claiming it; restarting here would race the loop.
            return Ok(());
        }
        inner.stopping.store(false, Ordering::SeqCst);
        inner.restart_attempts.store(0, Ordering::SeqCst);
        inner.set_health(Health::Starting);
        ensure_supervisor_actor(&inner).await;

        let launch_error = launch_session(&inner).await.err();
        if launch_error.is_none() {
            return Ok(());
        }

        // First spawn failed: let the bounded restart policy decide the
        // final state before reporting.
        if inner.claim_restart() {
            run_restart_loop(&inner).await;
            inner.release_restart();
        }
        match inner.health() {
            Health::Ready => Ok(()),
            _ => Err(inner
                .last_error()
                .or(launch_error)
                .unwrap_or_else(|| DesktopError::sidecar("sidecar failed to start"))),
        }
    }

    /// Wait until health is Ready or Failed. Polling keeps this race-free
    /// across the async restart loop.
    pub async fn wait_ready(&self, wait: Duration) -> Result<SidecarStatus, DesktopError> {
        let inner = self.arc();
        let deadline = Instant::now() + wait;
        loop {
            match inner.health() {
                Health::Ready => return Ok(inner.status()),
                Health::Failed => {
                    return Err(inner
                        .last_error()
                        .unwrap_or_else(|| DesktopError::sidecar("engine failed to start")))
                }
                _ => {}
            }
            if Instant::now() >= deadline {
                return Err(DesktopError::sidecar(format!(
                    "engine not ready within {wait:?} (health: {:?})",
                    inner.health()
                )));
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    }

    /// Send one protocol request and await its terminal response.
    ///
    /// Fails fast (without touching the process) when the method is not in
    /// the catalog or required payload fields are missing, reusing the
    /// engine's own error codes (`unknown_method`, `invalid_payload`).
    /// Never infers success from process state: if the engine exits with the
    /// request in flight, the caller receives `engine_unavailable`.
    pub async fn request(
        &self,
        method: &str,
        payload: Map<String, Value>,
    ) -> Result<Map<String, Value>, DesktopError> {
        let inner = self.arc();
        if !protocol::is_known_method(method) {
            return Err(DesktopError::unknown_method(method));
        }
        protocol::validate_request_payload(method, &payload, ParseMode::Runtime).map_err(|e| {
            DesktopError::invalid_payload(e.to_string())
                .with_details(serde_json::json!({ "method": method }))
        })?;

        let health = inner.health();
        if health != Health::Ready {
            return Err(DesktopError::engine_unavailable(format!(
                "engine is not ready (health: {health:?}); request {method} not sent"
            )));
        }

        let id = format!("req-{}", inner.next_id.fetch_add(1, Ordering::SeqCst));
        let envelope = Message::build_request(&id, method, payload);
        let line =
            protocol::to_line(&envelope).map_err(|e| DesktopError::internal(e.to_string()))? + "\n";

        let (tx, rx) = oneshot::channel();
        inner.pending.lock().unwrap().insert(id.clone(), tx);

        {
            let mut stdin_slot = inner.stdin_slot.lock().await;
            let write_result = match stdin_slot.as_mut() {
                None => Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "engine stdin is closed",
                )),
                Some(stdin) => {
                    async {
                        stdin.write_all(line.as_bytes()).await?;
                        stdin.flush().await
                    }
                    .await
                }
            };
            if let Err(e) = write_result {
                drop(stdin_slot);
                inner.pending.lock().unwrap().remove(&id);
                return Err(DesktopError::engine_unavailable(format!(
                    "cannot write request {id} to engine stdin: {e}"
                )));
            }
        }

        match timeout(inner.config.request_timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_dropped)) => {
                inner.pending.lock().unwrap().remove(&id);
                Err(DesktopError::engine_unavailable(
                    "engine response channel closed before a response arrived",
                ))
            }
            Err(_) => {
                inner.pending.lock().unwrap().remove(&id);
                Err(DesktopError::request_timeout(&id))
            }
        }
    }

    /// Graceful shutdown: send `engine.shutdown`, drop stdin (EOF is also a
    /// graceful exit path), wait out the grace period, then force-kill
    /// through the child API. Idempotent.
    pub async fn shutdown(&self, reason: Option<String>) -> Result<(), DesktopError> {
        let _lifecycle = self.inner.lifecycle.lock().await;
        let inner = self.arc();
        inner.stopping.store(true, Ordering::SeqCst);

        let live = inner.stdin_slot.lock().await.is_some();
        if live {
            // Best-effort shutdown request; the engine replies ok:true,
            // emits engine.exited, then exits 0. Requiring the response is
            // pointless — we wait for the process itself below.
            let mut payload = Map::new();
            if let Some(reason) = reason.as_deref() {
                payload.insert("reason".into(), Value::String(reason.to_string()));
            }
            if let Err(e) = send_raw(&inner, "engine.shutdown", payload).await {
                log::warn!(target: "sidecar", "engine.shutdown request failed: {e}");
            }

            // Dropping stdin signals EOF (documented graceful exit path).
            inner.stdin_slot.lock().await.take();

            // Wait out the grace period, polling for process exit without
            // holding the child lock (the reader task may still drain).
            let deadline = Instant::now() + inner.config.shutdown_grace;
            let mut exited: Option<Option<i32>> = None;
            while Instant::now() < deadline {
                let status = {
                    let mut slot = inner.child_slot.lock().await;
                    match slot.as_mut() {
                        None => break,
                        Some(child) => child.try_wait().transpose(),
                    }
                };
                match status {
                    Some(Ok(exit)) => {
                        exited = Some(exit.code());
                        break;
                    }
                    Some(Err(_)) | None => {
                        tokio::time::sleep(Duration::from_millis(15)).await;
                    }
                }
            }

            match exited {
                Some(code) => {
                    *inner.last_exit_code.lock().unwrap() = code;
                }
                None => {
                    // Grace expired: force termination through the child API.
                    let mut slot = inner.child_slot.lock().await;
                    if let Some(child) = slot.as_mut() {
                        let _ = child.kill().await;
                        let code = child.wait().await.ok().and_then(|s| s.code());
                        *inner.last_exit_code.lock().unwrap() = code;
                    }
                }
            }
        }

        inner.set_health(Health::Stopped);
        Ok(())
    }

    pub fn status(&self) -> SidecarStatus {
        self.inner.status()
    }

    /// Read-only access to the process configuration (timeouts, restart
    /// policy) for diagnostics and tests.
    pub fn config_ref(&self) -> &SidecarConfig {
        &self.inner.config
    }
}

impl Inner {
    fn health(&self) -> Health {
        *self.health.lock().unwrap()
    }

    fn set_health(&self, health: Health) {
        *self.health.lock().unwrap() = health;
    }

    fn last_error(&self) -> Option<DesktopError> {
        self.last_error
            .lock()
            .unwrap()
            .as_ref()
            .map(|e| DesktopError::sidecar(e.clone()))
    }

    fn set_last_error(&self, message: impl Into<String>) {
        *self.last_error.lock().unwrap() = Some(message.into());
    }

    fn session(&self) -> Option<String> {
        self.session.lock().unwrap().clone()
    }

    fn set_session(&self, session: Option<String>) {
        *self.session.lock().unwrap() = session;
    }

    fn sink(&self, event: SupervisorEvent) {
        (self.sink)(event);
    }

    fn claim_restart(&self) -> bool {
        !self.restart_claim.swap(true, Ordering::SeqCst)
    }

    fn release_restart(&self) {
        self.restart_claim.store(false, Ordering::SeqCst);
    }

    fn status(&self) -> SidecarStatus {
        SidecarStatus {
            health: self.health(),
            stopping: self.stopping.load(Ordering::SeqCst),
            session: self.session(),
            pid: *self.pid.lock().unwrap(),
            restart_attempts: self.restart_attempts.load(Ordering::SeqCst),
            restarts_total: self.restarts_total.load(Ordering::SeqCst),
            malformed_output_lines: self.malformed_lines.load(Ordering::SeqCst),
            stderr_lines: self.stderr_lines.load(Ordering::SeqCst),
            last_error: self.last_error.lock().unwrap().clone(),
            last_exit_code: *self.last_exit_code.lock().unwrap(),
            binary: self.config.binary.clone(),
        }
    }

    /// Fail every in-flight request with a structured error. Process exit
    /// tells us nothing about operation outcomes, so callers must treat
    /// these as failed, never succeeded.
    fn fail_all_pending(&self, message: String) {
        let pending: Vec<_> = self.pending.lock().unwrap().drain().collect();
        for (id, tx) in pending {
            let _ = tx.send(Err(DesktopError::engine_unavailable(format!(
                "{message} (request {id})"
            ))));
        }
    }
}

/// Write a request line without the readiness guard (used by the shutdown
/// path, which must work in any health state).
async fn send_raw(
    inner: &Arc<Inner>,
    method: &str,
    payload: Map<String, Value>,
) -> Result<(), DesktopError> {
    let id = format!("req-{}", inner.next_id.fetch_add(1, Ordering::SeqCst));
    let envelope = Message::build_request(&id, method, payload);
    let line =
        protocol::to_line(&envelope).map_err(|e| DesktopError::internal(e.to_string()))? + "\n";
    let mut stdin_slot = inner.stdin_slot.lock().await;
    match stdin_slot.as_mut() {
        None => Err(DesktopError::engine_unavailable("engine stdin is closed")),
        Some(stdin) => async {
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await
        }
        .await
        .map_err(|e| DesktopError::engine_unavailable(format!("stdin write failed: {e}"))),
    }
}

/// Validate the binary, spawn the child, and start the reader/stderr tasks.
/// Returns once the process is spawned (readiness is observed separately).
async fn launch_session(inner: &Arc<Inner>) -> Result<(), DesktopError> {
    paths::validate_executable(&inner.config.binary)?;

    let mut command = Command::new(&inner.config.binary);
    // Fixed argument vector, direct exec: no shell, no interpolation.
    command.args(&inner.config.args);
    command.envs(inner.config.env.iter().cloned());
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    command.kill_on_drop(true);

    let mut child = command.spawn().map_err(|e| {
        let message = format!(
            "cannot spawn sidecar {:?}: {e}",
            inner.config.binary.display()
        );
        inner.set_last_error(message.clone());
        DesktopError::sidecar(message)
    })?;

    let watch_pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| DesktopError::sidecar("sidecar stdin was not piped"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| DesktopError::sidecar("sidecar stdout was not piped"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| DesktopError::sidecar("sidecar stderr was not piped"))?;

    let generation = inner.launch_generation.fetch_add(1, Ordering::SeqCst) + 1;
    inner.set_health(Health::Starting);
    *inner.pid.lock().unwrap() = watch_pid;
    *inner.stdin_slot.lock().await = Some(stdin);
    *inner.child_slot.lock().await = Some(child);

    tokio::spawn(read_stdout(inner.clone(), stdout, generation));
    tokio::spawn(pump_stderr(inner.clone(), stderr));
    tokio::spawn(ready_watchdog(inner.clone(), watch_pid));
    Ok(())
}

/// If a freshly spawned engine does not report `engine.ready` within
/// `ready_timeout`, kill it so the standard unexpected-exit path (EOF ->
/// bounded restart) takes over. Without this, a silent-but-alive child
/// would leave the supervisor in `Starting` forever.
async fn ready_watchdog(inner: Arc<Inner>, pid: Option<u32>) {
    tokio::time::sleep(inner.config.ready_timeout).await;
    if inner.stopping.load(Ordering::SeqCst) || inner.health() != Health::Starting {
        return;
    }
    let mut slot = inner.child_slot.lock().await;
    if let Some(child) = slot.as_mut() {
        if child.id() == pid {
            log::warn!(
                target: "sidecar",
                "engine did not report engine.ready within {:?}; killing for restart",
                inner.config.ready_timeout
            );
            let _ = child.kill().await;
        }
    }
}

async fn pump_stderr(inner: Arc<Inner>, stderr: ChildStderr) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                inner.stderr_lines.fetch_add(1, Ordering::SeqCst);
                log::info!(target: "sidecar::stderr", "{}", line.trim_end());
            }
        }
    }
}

async fn read_stdout(inner: Arc<Inner>, stdout: ChildStdout, generation: u64) {
    let mut reader = BufReader::new(stdout);
    let mut ready_seen = false;
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => break,
            Err(e) => {
                log::warn!(target: "sidecar", "stdout read error: {e}");
                break;
            }
            Ok(_) => handle_protocol_line(&inner, &line, &mut ready_seen),
        }
    }

    handle_exit(&inner, generation).await;
}

fn handle_protocol_line(inner: &Arc<Inner>, line: &str, ready_seen: &mut bool) {
    match Message::parse_line(line, ParseMode::Runtime) {
        Ok(ParsedLine::Blank) => {}
        Ok(ParsedLine::Message(Message::Request(_))) => {
            record_malformed(inner, "engine wrote a request on stdout", line);
        }
        Ok(ParsedLine::Message(Message::Response(response))) => {
            handle_response(inner, response);
        }
        Ok(ParsedLine::Message(Message::Event(event))) => {
            handle_event(inner, event, ready_seen);
        }
        Err(error) => record_malformed(inner, &error.to_string(), line),
    }
}

fn record_malformed(inner: &Arc<Inner>, reason: &str, line: &str) {
    let count = inner.malformed_lines.fetch_add(1, Ordering::SeqCst) + 1;
    let sample = line.trim().chars().take(200).collect::<String>();
    log::warn!(target: "sidecar", "malformed engine output ({reason}): {sample:?}");
    inner.sink(SupervisorEvent::MalformedOutput {
        count,
        sample: format!("{reason}: {sample}"),
    });
}

fn handle_response(inner: &Arc<Inner>, response: ResponseEnvelope) {
    let sender = inner.pending.lock().unwrap().remove(&response.id);
    match sender {
        None => {
            // Late or duplicate response for an already-settled request:
            // exactly-one-terminal-response still holds from our side.
            log::debug!(
                target: "sidecar",
                "response for unknown request id {} dropped",
                response.id
            );
        }
        Some(tx) => {
            if response.ok {
                let _ = tx.send(Ok(response.payload.unwrap_or_default()));
            } else {
                let error = response.error.unwrap_or_else(|| {
                    // Unreachable: parse_line requires error on ok:false.
                    crate::protocol::ProtocolErrorBody {
                        code: "internal_error".into(),
                        message: "engine returned ok:false without an error body".into(),
                        details: None,
                    }
                });
                let _ = tx
                    .send(Err(DesktopError::new(&error.code, error.message)
                        .with_details_opt(error.details)));
            }
        }
    }
}

fn handle_event(inner: &Arc<Inner>, event: EventEnvelope, ready_seen: &mut bool) {
    // Session bookkeeping: a changed session means the engine restarted and
    // sequence numbers reset; events.rs reacts on top of this.
    if let Some(session) = event.session.clone() {
        inner.set_session(Some(session));
    }

    if event.event == "engine.ready" {
        *inner.session_ready_at.lock().unwrap() = Some(Instant::now());
        if !*ready_seen {
            *ready_seen = true;
            inner.set_health(Health::Ready);
        }
        inner.sink(SupervisorEvent::SessionReady {
            session: inner.session(),
        });
    } else if event.event == "engine.error" && inner.health() == Health::Starting && !*ready_seen {
        // Startup failure path (e.g. missing first-run setup): the engine
        // emits one engine.error and exits; record it for status/diagnostics.
        let message = event
            .payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("engine reported a startup error")
            .to_string();
        inner.set_last_error(format!("engine startup error: {message}"));
    }

    inner.sink(SupervisorEvent::Protocol(event));
}

/// Reader-end-of-stream handler: reap the child, fail pending requests,
/// then run the bounded restart loop when the exit was not requested.
async fn handle_exit(inner: &Arc<Inner>, generation: u64) {
    let graceful = inner.stopping.load(Ordering::SeqCst);

    // The engine's stdout closed: the process is going away. Reap it, but
    // never block forever if something keeps it alive. Locks are released
    // while sleeping so a concurrent supervisor shutdown never deadlocks.
    let mut exit_code: Option<i32> = None;
    {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let mut slot = inner.child_slot.lock().await;
            let Some(child) = slot.as_mut() else { break };
            match child.try_wait() {
                Ok(Some(status)) => {
                    exit_code = status.code();
                    break;
                }
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        break;
                    }
                }
                Err(_) => break,
            }
            drop(slot);
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    }

    *inner.child_slot.lock().await = None;
    *inner.stdin_slot.lock().await = None;
    *inner.pid.lock().unwrap() = None;
    if exit_code.is_some() {
        *inner.last_exit_code.lock().unwrap() = exit_code;
    }

    inner.fail_all_pending("engine exited before responding".to_string());

    let last_session = inner.session();
    inner.set_health(if graceful {
        Health::Stopped
    } else {
        Health::Exited
    });
    inner.sink(SupervisorEvent::SessionExited {
        last_session,
        exit_code,
        graceful,
    });

    if !graceful {
        // Hand recovery to the supervisor actor (see Inner::exit_tx docs),
        // tagged with this session's launch generation so stale notices
        // (already handled inside a finished restart cycle) are ignored.
        let _ = inner.exit_tx.send(generation);
    }
}

/// Spawn the restart actor exactly once (first `start()` wins).
async fn ensure_supervisor_actor(inner: &Arc<Inner>) {
    if inner.actor_started.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(rx) = inner.exit_rx.lock().await.take() {
        tokio::spawn(supervisor_actor(inner.clone(), rx));
    }
}

/// Long-lived task owning the bounded restart loop. Spawned once from the
/// first `start()`; notices arriving while a restart is in flight (or for
/// an already-healthy session) are ignored.
async fn supervisor_actor(inner: Arc<Inner>, mut rx: tokio::sync::mpsc::UnboundedReceiver<u64>) {
    while let Some(generation) = rx.recv().await {
        if inner.stopping.load(Ordering::SeqCst) {
            inner.set_health(Health::Stopped);
            continue;
        }
        if generation != inner.launch_generation.load(Ordering::SeqCst) {
            continue; // stale notice from a superseded session
        }
        if matches!(
            inner.health(),
            Health::Ready | Health::Starting | Health::Failed
        ) {
            continue; // recovered on its own, still starting, or terminal
        }
        if inner.claim_restart() {
            run_restart_loop(&inner).await;
            inner.release_restart();
        }
    }
}

/// Bounded restart with backoff. The caller must hold the restart claim.
async fn run_restart_loop(inner: &Arc<Inner>) {
    let policy = inner.config.restart.clone();
    if policy.max_attempts == 0 {
        inner.set_health(Health::Failed);
        inner.set_last_error("engine exited unexpectedly and restarts are disabled");
        inner.sink(SupervisorEvent::RestartFailed {
            attempts: 0,
            reason: "restarts disabled".into(),
        });
        return;
    }

    // Continue the consecutive-failure streak (the actor resets it only via
    // a stability-confirmed success below).
    let mut attempt = inner
        .restart_attempts
        .load(Ordering::SeqCst)
        .saturating_add(1);
    while attempt <= policy.max_attempts {
        if inner.stopping.load(Ordering::SeqCst) {
            inner.set_health(Health::Stopped);
            return;
        }
        inner.set_health(Health::Restarting);
        inner.restart_attempts.store(attempt, Ordering::SeqCst);
        let reason = inner
            .last_error
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| "unexpected engine exit".into());
        inner.sink(SupervisorEvent::Restarting { attempt, reason });

        let backoff = policy.backoff_for(attempt);
        tokio::time::sleep(backoff).await;
        if inner.stopping.load(Ordering::SeqCst) {
            inner.set_health(Health::Stopped);
            return;
        }

        match launch_session(inner).await {
            Ok(()) => {
                // Wait for readiness AND stability: a restart only counts
                // (and only resets the streak) when the engine stays ready
                // for `stable_after`. Dying again continues the streak.
                let deadline = Instant::now() + inner.config.ready_timeout + policy.stable_after;
                loop {
                    match inner.health() {
                        Health::Ready => {
                            let ready_at = inner
                                .session_ready_at
                                .lock()
                                .unwrap()
                                .unwrap_or_else(Instant::now);
                            if ready_at.elapsed() >= policy.stable_after {
                                inner.restarts_total.fetch_add(1, Ordering::SeqCst);
                                inner.restart_attempts.store(0, Ordering::SeqCst);
                                return; // stable recovery
                            }
                        }
                        Health::Stopped | Health::Failed => return,
                        // The freshly spawned attempt already died: stop
                        // waiting out the readiness timeout.
                        Health::Exited => break,
                        Health::Starting | Health::Restarting => {}
                    }
                    if Instant::now() >= deadline {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(15)).await;
                }
                // Not ready (or not stable) in time: tear down and retry.
                log::warn!(target: "sidecar", "engine not stable after restart attempt {attempt}");
                inner.set_last_error(format!(
                    "engine did not stay ready after restart attempt {attempt}"
                ));
                let mut slot = inner.child_slot.lock().await;
                if let Some(child) = slot.as_mut() {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
                *slot = None;
                *inner.stdin_slot.lock().await = None;
            }
            Err(e) => inner.set_last_error(e.message.clone()),
        }
        attempt += 1;
    }

    let attempts = policy.max_attempts;
    let reason = inner
        .last_error
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| "restart attempts exhausted".into());
    inner.set_health(Health::Failed);
    inner.sink(SupervisorEvent::RestartFailed { attempts, reason });
}
