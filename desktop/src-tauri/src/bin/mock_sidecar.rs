//! Mock desktop-v1 sidecar used by the Rust integration tests and by
//! developers iterating on the supervisor without building the Go engine.
//!
//! Speaks the same wire protocol as `ainovel-cli --desktop-daemon`: NDJSON
//! on stdin/stdout, logs on stderr, `engine.ready` (sequence 1) as the very
//! first stdout line. Behavior modes are selected with env vars so a single
//! binary covers every supervisor scenario:
//!
//! * `MOCK_MODE=healthy` (default) — ready, echo responses, graceful
//!   shutdown, stdin EOF exits 0.
//! * `MOCK_MODE=garbage` — after ready, one malformed line plus one valid
//!   event, then healthy behavior (malformed-output handling).
//! * `MOCK_MODE=crash` — exit(1) after MOCK_DELAY_MS without engine.exited;
//!   with MOCK_STATE_FILE, crash only on the first spawn (crash-once).
//! * `MOCK_MODE=crash_on_request` — wait for the first request, then
//!   exit(1) without responding (pending-request failure).
//! * `MOCK_MODE=never_ready` — nothing on stdout (readiness timeout).
//! * `MOCK_MODE=hang_shutdown` — reply ok to engine.shutdown but never exit
//!   (grace-timeout force kill).
//! * `MOCK_MODE=dup_event` — on each ping, re-emit one event with the SAME
//!   sequence number (duplicate delivery / dedupe).
//! * `MOCK_MODE=slow` — delay ping responses by MOCK_DELAY_MS (request
//!   timeout).
//!
//! `MOCK_SESSION` pins the session id; by default every spawn generates a
//! fresh one, which is how restart tests observe the session change.

use std::io::{BufRead, Write};
use std::process::exit;

use ainovel_desktop_lib::protocol::{
    EventEnvelope, Message, ParseMode, ParsedLine, ProtocolErrorBody, RequestEnvelope,
    ResponseEnvelope, PROTOCOL_ID,
};
use serde_json::{Map, Value};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

fn session_id() -> String {
    env("MOCK_SESSION").unwrap_or_else(|| {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("mock-sess-{nanos}-{}", std::process::id())
    })
}

struct Mock {
    session: String,
    sequence: u64,
}

impl Mock {
    fn stdout_line(&mut self, line: &str) {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(line.as_bytes());
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }

    fn stderr_log(&self, message: &str) {
        let mut err = std::io::stderr().lock();
        let _ = writeln!(err, "[mock-sidecar] {message}");
        let _ = err.flush();
    }

    fn next_sequence(&mut self) -> u64 {
        self.sequence += 1;
        self.sequence
    }

    fn emit_event(&mut self, event: &str, payload: Map<String, Value>, sequence: Option<u64>) {
        let envelope = EventEnvelope {
            protocol: PROTOCOL_ID.to_string(),
            kind: "event".to_string(),
            event: event.to_string(),
            project_id: None,
            session: Some(self.session.clone()),
            sequence: sequence.unwrap_or_else(|| self.next_sequence()),
            payload,
        };
        self.stdout_line(&serde_json::to_string(&envelope).expect("serialize event"));
    }

    fn respond_ok(&mut self, id: &str, payload: Map<String, Value>) {
        let envelope = ResponseEnvelope {
            protocol: PROTOCOL_ID.to_string(),
            kind: "response".to_string(),
            id: id.to_string(),
            ok: true,
            session: Some(self.session.clone()),
            payload: Some(payload),
            error: None,
        };
        self.stdout_line(&serde_json::to_string(&envelope).expect("serialize response"));
    }

    fn respond_err(&mut self, id: &str, code: &str, message: &str) {
        let envelope = ResponseEnvelope {
            protocol: PROTOCOL_ID.to_string(),
            kind: "response".to_string(),
            id: id.to_string(),
            ok: false,
            session: Some(self.session.clone()),
            payload: None,
            error: Some(ProtocolErrorBody {
                code: code.to_string(),
                message: message.to_string(),
                details: None,
            }),
        };
        self.stdout_line(&serde_json::to_string(&envelope).expect("serialize response"));
    }

    fn sleep_ms(&self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

fn crash_once_allowed(state_file: &str) -> bool {
    // First spawn (counter 0 -> 1) crashes; later spawns stay healthy.
    let counter = std::fs::read_to_string(state_file)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(0);
    let _ = std::fs::write(state_file, format!("{}", counter + 1));
    counter == 0
}

fn main() {
    let mode = env("MOCK_MODE").unwrap_or_else(|| "healthy".into());
    let session = session_id();
    let delay_ms = env("MOCK_DELAY_MS")
        .and_then(|v| v.parse().ok())
        .unwrap_or(100);

    if mode == "never_ready" {
        let mock = Mock {
            session: session.clone(),
            sequence: 0,
        };
        mock.stderr_log("mode=never_ready: staying silent on stdout");
        // Consume stdin so the supervisor controls our lifetime.
        let _ = std::io::stdin().lock().lines().count();
        exit(0);
    }

    if mode == "crash" {
        if let Some(state_file) = env("MOCK_STATE_FILE") {
            if !crash_once_allowed(&state_file) {
                // Subsequent spawn: behave healthy (restart-recovery test).
                run_healthy(session.clone(), mode.clone(), delay_ms);
            }
        }
        // Model an engine that was READY and then died unexpectedly: emit
        // engine.ready first, then exit(1) with no engine.exited.
        let mut mock = Mock {
            session: session.clone(),
            sequence: 0,
        };
        mock.stderr_log("mode=crash: ready then exiting 1 without engine.exited");
        mock.emit_event(
            "engine.ready",
            {
                let mut payload = Map::new();
                payload.insert("recovered".into(), Value::Bool(false));
                payload
            },
            None,
        );
        mock.sleep_ms(delay_ms);
        exit(1);
    }

    let mut mock = Mock {
        session,
        sequence: 0,
    };
    mock.stderr_log(&format!("mode={mode} session={}", mock.session));

    // First stdout line is always engine.ready (sequence 1).
    mock.emit_event(
        "engine.ready",
        {
            let mut payload = Map::new();
            payload.insert("recovered".into(), Value::Bool(false));
            payload
        },
        None,
    );

    if mode == "garbage" {
        // One malformed line (not protocol) plus one valid event afterwards.
        mock.stdout_line("this is {{{ not json at all");
        mock.emit_event(
            "notification.info",
            {
                let mut payload = Map::new();
                payload.insert("message".into(), Value::String("after garbage".into()));
                payload
            },
            None,
        );
    }

    if mode == "crash_on_request" {
        // Read one request, then die without responding: the supervisor
        // must fail the pending request with engine_unavailable.
        let mut stdin = std::io::stdin().lock();
        let mut line = String::new();
        let _ = stdin.read_line(&mut line);
        mock.stderr_log("mode=crash_on_request: exiting 1 with a request in flight");
        exit(1);
    }

    // healthy / garbage / hang_shutdown / dup_event / slow share the loop.
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        let request: RequestEnvelope = match Message::parse_line(&line, ParseMode::Runtime) {
            Ok(ParsedLine::Message(Message::Request(req))) => req,
            _ => {
                // Unparseable/invalid input: engine.error event (code
                // malformed_json), never a response — mirrors the contract.
                mock.emit_event(
                    "engine.error",
                    {
                        let mut payload = Map::new();
                        payload.insert("code".into(), Value::String("malformed_json".into()));
                        payload.insert(
                            "message".into(),
                            Value::String("input line could not be parsed".into()),
                        );
                        payload
                    },
                    None,
                );
                continue;
            }
        };

        match request.method.as_str() {
            "engine.ping" => {
                if mode == "dup_event" {
                    // Re-deliver the SAME sequence twice, then answer.
                    let seq = mock.next_sequence();
                    let mut payload = Map::new();
                    payload.insert("message".into(), Value::String("dup".into()));
                    mock.emit_event("notification.info", payload.clone(), Some(seq));
                    mock.emit_event("notification.info", payload, Some(seq));
                }
                if mode == "slow" {
                    mock.sleep_ms(delay_ms);
                }
                let mut payload = Map::new();
                payload.insert("pong".into(), Value::Bool(true));
                payload.insert("echo".into(), Value::Object(request.payload.clone()));
                mock.respond_ok(&request.id, payload);
            }
            "engine.shutdown" => {
                mock.respond_ok(&request.id, Map::new());
                if mode == "hang_shutdown" {
                    mock.stderr_log("mode=hang_shutdown: ignoring exit");
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(3600));
                    }
                }
                mock.emit_event(
                    "engine.exited",
                    {
                        let mut payload = Map::new();
                        payload.insert("reason".into(), Value::String("shutdown complete".into()));
                        payload.insert("exit_code".into(), Value::from(0));
                        payload
                    },
                    None,
                );
                exit(0);
            }
            method => {
                // Generic echo so correlation tests can verify id/payload
                // matching, plus a structured error for a canned method.
                if method == "config.get" {
                    let mut payload = Map::new();
                    payload.insert("mock".into(), Value::Bool(true));
                    mock.respond_ok(&request.id, payload);
                } else if method == "chapter.read" {
                    mock.respond_err(&request.id, "project_unavailable", "no project is open");
                } else {
                    let mut payload = Map::new();
                    payload.insert("method".into(), Value::String(method.to_string()));
                    payload.insert("payload".into(), Value::Object(request.payload.clone()));
                    payload.insert("session".into(), Value::String(mock.session.clone()));
                    mock.respond_ok(&request.id, payload);
                }
            }
        }
    }

    // stdin EOF: graceful exit (matches the Go daemon behavior).
    exit(0);
}

fn run_healthy(session: String, _mode: String, _delay_ms: u64) {
    let mut mock = Mock {
        session,
        sequence: 0,
    };
    mock.stderr_log(&format!("recovered spawn session={}", mock.session));
    mock.emit_event(
        "engine.ready",
        {
            let mut payload = Map::new();
            payload.insert("recovered".into(), Value::Bool(true));
            payload
        },
        None,
    );
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(ParsedLine::Message(Message::Request(req))) =
            Message::parse_line(&line, ParseMode::Runtime)
        {
            if req.method == "engine.shutdown" {
                mock.respond_ok(&req.id, Map::new());
                mock.emit_event(
                    "engine.exited",
                    {
                        let mut payload = Map::new();
                        payload.insert("reason".into(), Value::String("shutdown complete".into()));
                        payload.insert("exit_code".into(), Value::from(0));
                        payload
                    },
                    None,
                );
                exit(0);
            }
            let mut payload = Map::new();
            payload.insert("pong".into(), Value::Bool(true));
            payload.insert("echo".into(), Value::Object(req.payload.clone()));
            mock.respond_ok(&req.id, payload);
        }
    }
    exit(0);
}
