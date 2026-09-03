//! Protocol-event forwarding with sequence/replay bookkeeping.
//!
//! Delivery from the engine is at-least-once: events may be re-delivered
//! with their ORIGINAL sequence number (replay, transport hiccups), and a
//! changed `session` id means the sidecar restarted with a reset sequence
//! (README sections 4 and "Sidecar recovery procedure"). The
//! [`EventBookkeeper`] encodes those rules:
//!
//! * dedupe on the `(session, sequence)` pair — within a session, any
//!   sequence at or below the last forwarded one is a duplicate and is
//!   dropped (counted, never re-emitted);
//! * a session change resets the sequence window and is reported so the
//!   frontend can refetch `project.snapshot` and replay;
//! * `last_sequence` is exposed per session for replay cursors
//!   (`project.replay_events { after_sequence }`).
//!
//! [`EventForwarder`] applies the bookkeeper to supervisor events and pushes
//! them onto the Tauri event system through an injected emit function (the
//! AppHandle wiring lives in `lib.rs`; tests inject a collector). The
//! frontend-facing Tauri event names are part of the task-4 contract:
//!
//! * `desktop://event`   — one deduped protocol event.
//! * `desktop://session` — session change: refetch snapshot + replay.
//! * `desktop://status`  — supervisor lifecycle transitions.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::{json, Value};

use crate::protocol::EventEnvelope;
use crate::sidecar::SupervisorEvent;

/// Pure bookkeeping state; no I/O. Wrapped in a `Mutex` by
/// [`EventForwarder`].
#[derive(Debug, Default, Clone)]
pub struct EventBookkeeper {
    current_session: Option<String>,
    last_sequence: Option<u64>,
    sessions_seen: Vec<String>,
    duplicates_dropped: u64,
    forwarded_count: u64,
    session_changes: u64,
}

/// Result of observing one event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObserveOutcome {
    /// Forward; `session_changed` is true when this event opened a new
    /// engine session (sidecar restart detected).
    Forwarded { session_changed: bool },
    /// Exact re-delivery within the same session: drop.
    Duplicate,
}

impl EventBookkeeper {
    /// Events without an explicit `session` are attributed to the current
    /// session bucket ("" before any session is known); the ready event
    /// always carries the session in practice.
    fn session_key(&self, event: &EventEnvelope) -> String {
        event
            .session
            .clone()
            .unwrap_or_else(|| self.current_session.clone().unwrap_or_default())
    }

    pub fn observe(&mut self, event: &EventEnvelope) -> ObserveOutcome {
        let key = self.session_key(event);
        let same_session = self.current_session.as_deref() == Some(key.as_str());
        if same_session {
            if let Some(last) = self.last_sequence {
                if event.sequence <= last {
                    self.duplicates_dropped += 1;
                    return ObserveOutcome::Duplicate;
                }
            }
            self.last_sequence = Some(event.sequence);
            self.forwarded_count += 1;
            return ObserveOutcome::Forwarded {
                session_changed: false,
            };
        }

        let session_changed = self.current_session.is_some();
        self.current_session = Some(key.clone());
        if !key.is_empty() && !self.sessions_seen.contains(&key) {
            self.sessions_seen.push(key);
        }
        self.last_sequence = Some(event.sequence);
        self.forwarded_count += 1;
        if session_changed {
            self.session_changes += 1;
        }
        ObserveOutcome::Forwarded { session_changed }
    }

    pub fn current_session(&self) -> Option<&str> {
        self.current_session.as_deref()
    }

    /// Highest forwarded sequence in the current session (replay cursor).
    pub fn last_sequence(&self) -> Option<u64> {
        self.last_sequence
    }

    pub fn sessions_seen(&self) -> &[String] {
        &self.sessions_seen
    }

    pub fn duplicates_dropped(&self) -> u64 {
        self.duplicates_dropped
    }

    pub fn forwarded_count(&self) -> u64 {
        self.forwarded_count
    }

    pub fn session_changes(&self) -> u64 {
        self.session_changes
    }
}

/// Snapshot exposed through the `desktop_event_state` command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventState {
    pub session: Option<String>,
    pub last_sequence: Option<u64>,
    pub sessions_seen: Vec<String>,
    pub duplicates_dropped: u64,
    pub forwarded_count: u64,
    pub session_changes: u64,
}

/// How the forwarder delivers to the outside world. The Tauri wiring emits
/// on the AppHandle; tests collect.
pub type EmitFn = Arc<dyn Fn(&str, Value) + Send + Sync>;

pub struct EventForwarder {
    emit: EmitFn,
    book: Mutex<EventBookkeeper>,
}

/// Frontend payload of `desktop://event`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardedEvent<'a> {
    pub event: &'a str,
    pub session: Option<&'a str>,
    pub sequence: u64,
    pub project_id: Option<&'a str>,
    pub payload: &'a serde_json::Map<String, Value>,
}

/// Frontend payload of `desktop://session`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionChange {
    pub previous: Option<String>,
    pub current: Option<String>,
    pub last_sequence: Option<u64>,
}

impl EventForwarder {
    pub fn new(emit: EmitFn) -> Self {
        Self {
            emit,
            book: Mutex::new(EventBookkeeper::default()),
        }
    }

    /// Test convenience: a forwarder that only keeps bookkeeping state.
    pub fn collector() -> (Arc<Self>, Arc<Mutex<Vec<(String, Value)>>>) {
        let seen: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let forwarder = Arc::new(Self::new(Arc::new(move |name, payload| {
            sink.lock().unwrap().push((name.to_string(), payload));
        })));
        (forwarder, seen)
    }

    /// Feed one supervisor observation.
    pub fn handle(&self, event: SupervisorEvent) {
        match event {
            SupervisorEvent::Protocol(envelope) => self.handle_protocol_with_history(&envelope),
            SupervisorEvent::SessionReady { session } => {
                self.emit_status(json!({ "health": "ready", "session": session }));
            }
            SupervisorEvent::SessionExited {
                last_session,
                exit_code,
                graceful,
            } => {
                self.emit_status(json!({
                    "health": if graceful { "stopped" } else { "exited" },
                    "graceful": graceful,
                    "exitCode": exit_code,
                    "session": last_session,
                }));
            }
            SupervisorEvent::Restarting { attempt, reason } => {
                self.emit_status(json!({
                    "health": "restarting",
                    "attempt": attempt,
                    "reason": reason,
                }));
            }
            SupervisorEvent::RestartFailed { attempts, reason } => {
                self.emit_status(json!({
                    "health": "failed",
                    "attempts": attempts,
                    "reason": reason,
                }));
            }
            SupervisorEvent::MalformedOutput { count, sample } => {
                // Health signal only: never a protocol event, the engine
                // output was not valid protocol data.
                self.emit_status(json!({
                    "health": "degraded",
                    "malformedOutputLines": count,
                    "sample": sample,
                }));
            }
        }
    }

    /// Forward one protocol event with session-change notification. The
    /// previous session id is only knowable before the observe call mutates
    /// the bookkeeping, so it is captured first.
    pub fn handle_protocol_with_history(&self, envelope: &EventEnvelope) {
        let previous = self
            .book
            .lock()
            .unwrap()
            .current_session()
            .map(str::to_string);
        let outcome = self.book.lock().unwrap().observe(envelope);
        match outcome {
            ObserveOutcome::Duplicate => {
                log::debug!(
                    target: "events",
                    "duplicate event {}/{} dropped",
                    envelope.session.as_deref().unwrap_or(""),
                    envelope.sequence
                );
            }
            ObserveOutcome::Forwarded { session_changed } => {
                let payload = ForwardedEvent {
                    event: &envelope.event,
                    session: envelope.session.as_deref(),
                    sequence: envelope.sequence,
                    project_id: envelope.project_id.as_deref(),
                    payload: &envelope.payload,
                };
                (self.emit)(
                    "desktop://event",
                    serde_json::to_value(payload).unwrap_or(Value::Null),
                );
                if session_changed {
                    let book = self.book.lock().unwrap();
                    (self.emit)(
                        "desktop://session",
                        serde_json::to_value(SessionChange {
                            previous,
                            current: book.current_session().map(str::to_string),
                            last_sequence: book.last_sequence(),
                        })
                        .unwrap_or(Value::Null),
                    );
                }
            }
        }
    }

    fn emit_status(&self, payload: Value) {
        (self.emit)("desktop://status", payload);
    }

    pub fn event_state(&self) -> EventState {
        let book = self.book.lock().unwrap();
        EventState {
            session: book.current_session().map(str::to_string),
            last_sequence: book.last_sequence(),
            sessions_seen: book.sessions_seen().to_vec(),
            duplicates_dropped: book.duplicates_dropped(),
            forwarded_count: book.forwarded_count(),
            session_changes: book.session_changes(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{Message, ParseMode, ParsedLine};
    use serde_json::json;

    fn event(line: &str) -> EventEnvelope {
        match Message::parse_line(line, ParseMode::Runtime).unwrap() {
            ParsedLine::Message(Message::Event(ev)) => ev,
            other => panic!("expected event, got {other:?}"),
        }
    }

    fn seq_event(session: &str, sequence: u64, name: &str) -> EventEnvelope {
        EventEnvelope {
            protocol: "desktop-v1".into(),
            kind: "event".into(),
            event: name.into(),
            project_id: None,
            session: Some(session.into()),
            sequence,
            payload: serde_json::Map::new(),
        }
    }

    #[test]
    fn duplicate_sequence_in_same_session_is_dropped() {
        // Shape of fixtures/valid-events-duplicate-sequence-replay.jsonl:
        // 471, 471 (re-delivery), 472.
        let mut book = EventBookkeeper::default();
        assert_eq!(
            book.observe(&seq_event("s1", 471, "stream.delta")),
            ObserveOutcome::Forwarded {
                session_changed: false
            }
        );
        assert_eq!(
            book.observe(&seq_event("s1", 471, "stream.delta")),
            ObserveOutcome::Duplicate
        );
        assert_eq!(
            book.observe(&seq_event("s1", 472, "stream.delta")),
            ObserveOutcome::Forwarded {
                session_changed: false
            }
        );
        assert_eq!(book.forwarded_count(), 2);
        assert_eq!(book.duplicates_dropped(), 1);
        assert_eq!(book.last_sequence(), Some(472));
        assert_eq!(book.sessions_seen(), &["s1".to_string()]);
    }

    #[test]
    fn session_change_resets_sequence_window() {
        // Shape of fixtures/valid-events-sidecar-recovery.jsonl: old session
        // dies at 482/483, new session starts at 1.
        let mut book = EventBookkeeper::default();
        book.observe(&seq_event("sess-7f2c", 481, "stream.delta"));
        book.observe(&seq_event("sess-7f2c", 482, "engine.exited"));
        assert_eq!(
            book.observe(&seq_event("sess-91bd", 1, "engine.ready")),
            ObserveOutcome::Forwarded {
                session_changed: true
            }
        );
        // Sequence 2 of the new session is NOT a duplicate even though the
        // old session already reached 482.
        assert_eq!(
            book.observe(&seq_event("sess-91bd", 2, "engine.status_changed")),
            ObserveOutcome::Forwarded {
                session_changed: false
            }
        );
        assert_eq!(book.last_sequence(), Some(2));
        assert_eq!(book.session_changes(), 1);
        assert_eq!(book.sessions_seen().len(), 2);
    }

    #[test]
    fn sessionless_events_join_current_bucket() {
        let mut book = EventBookkeeper::default();
        book.observe(&seq_event("s1", 5, "run.progress"));
        let mut bare = seq_event("", 6, "run.progress");
        bare.session = None;
        assert_eq!(
            book.observe(&bare),
            ObserveOutcome::Forwarded {
                session_changed: false
            }
        );
        // A second bare event with a lower sequence is treated as a
        // duplicate of the s1 bucket.
        let mut older = seq_event("", 5, "run.progress");
        older.session = None;
        assert_eq!(book.observe(&older), ObserveOutcome::Duplicate);
    }

    #[test]
    fn forwarder_emits_event_and_session_change() {
        let (forwarder, seen) = EventForwarder::collector();

        forwarder.handle(SupervisorEvent::Protocol(seq_event(
            "s1",
            1,
            "engine.ready",
        )));
        forwarder.handle(SupervisorEvent::Protocol(seq_event(
            "s1",
            2,
            "run.progress",
        )));
        forwarder.handle(SupervisorEvent::Protocol(seq_event(
            "s1",
            2,
            "run.progress",
        ))); // dup
        forwarder.handle(SupervisorEvent::SessionExited {
            last_session: Some("s1".into()),
            exit_code: Some(137),
            graceful: false,
        });
        forwarder.handle(SupervisorEvent::Restarting {
            attempt: 1,
            reason: "unexpected exit".into(),
        });
        forwarder.handle(SupervisorEvent::Protocol(seq_event(
            "s2",
            1,
            "engine.ready",
        )));

        let seen = seen.lock().unwrap();
        let names: Vec<&str> = seen.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "desktop://event",
                "desktop://event",
                "desktop://status",
                "desktop://status",
                "desktop://event",
                "desktop://session",
            ]
        );

        let first_event = &seen[0].1;
        assert_eq!(first_event["event"], "engine.ready");
        assert_eq!(first_event["session"], "s1");
        assert_eq!(first_event["sequence"], 1);

        let session_change = seen.last().unwrap().1.clone();
        assert_eq!(session_change["current"], "s2");
        assert_eq!(session_change["lastSequence"], 1);

        let state = forwarder.event_state();
        assert_eq!(state.duplicates_dropped, 1);
        assert_eq!(state.forwarded_count, 3);
        assert_eq!(state.session, Some("s2".to_string()));
    }

    #[test]
    fn fixture_recovery_lines_flow_through_forwarder() {
        // Exercise the actual fixture wire shape end to end.
        let raw = r#"{"protocol":"desktop-v1","kind":"event","event":"stream.delta","project_id":"project-123","session":"sess-7f2c","sequence":481,"payload":{"text":"drowned in fog.","channel":"prose"}}"#;
        let (forwarder, _seen) = EventForwarder::collector();
        forwarder.handle_protocol_with_history(&event(raw));
        let state = forwarder.event_state();
        assert_eq!(state.session.as_deref(), Some("sess-7f2c"));
        assert_eq!(state.last_sequence, Some(481));
    }

    #[test]
    fn handle_protocol_with_history_reports_previous_session() {
        let (forwarder, seen) = EventForwarder::collector();
        forwarder.handle_protocol_with_history(&seq_event("a", 1, "engine.ready"));
        forwarder.handle_protocol_with_history(&seq_event("a", 2, "run.progress"));
        forwarder.handle_protocol_with_history(&seq_event("b", 1, "engine.ready"));
        let seen = seen.lock().unwrap();
        let session_changes: Vec<&Value> = seen
            .iter()
            .filter(|(n, _)| n == "desktop://session")
            .map(|(_, v)| v)
            .collect();
        assert_eq!(session_changes.len(), 1);
        assert_eq!(session_changes[0]["previous"], "a");
        assert_eq!(session_changes[0]["current"], "b");
    }

    #[test]
    fn payload_json_shape_is_frontend_contract() {
        let (forwarder, seen) = EventForwarder::collector();
        let mut ev = seq_event("s1", 7, "run.progress");
        ev.payload.insert("completed".into(), json!(12));
        ev.payload.insert("total".into(), json!(24));
        ev.project_id = Some("project-123".into());
        forwarder.handle(SupervisorEvent::Protocol(ev));
        let payload = &seen.lock().unwrap()[0].1;
        assert_eq!(
            payload,
            &json!({
                "event": "run.progress",
                "session": "s1",
                "sequence": 7,
                "projectId": "project-123",
                "payload": { "completed": 12, "total": 24 },
            })
        );
    }
}
