//! desktop-v1 protocol types and line parser.
//!
//! Source of truth: `protocols/desktop-v1/` (README.md wire rules,
//! commands.schema.json, events.schema.json, fixtures/). The types here must
//! match the schemas exactly:
//!
//! * Envelope keys are closed: unknown top-level keys are rejected
//!   (`#[serde(deny_unknown_fields)]`).
//! * Payload objects are open: unknown payload fields are kept and ignored
//!   (payloads are `serde_json::Map<String, Value>`).
//! * `protocol` must be the literal `"desktop-v1"`; anything else is
//!   rejected with a structured `invalid_payload`-style reason.
//! * Blank lines are not protocol messages and are skipped by readers.
//!
//! Parsing has two strictness levels:
//!
//! * [`ParseMode::Strict`] mirrors JSON-Schema conformance (what the ajv
//!   validator in `protocols/desktop-v1/validate.mjs` enforces). It is used
//!   by the shared fixture tests and rejects unknown method/event names and
//!   error codes outside the catalog.
//! * [`ParseMode::Runtime`] is used on the live sidecar stdout stream.
//!   desktop-v1 only allows additive changes (README section 9), so at
//!   runtime we tolerate event names and error codes the catalog does not
//!   know yet and forward them opaquely; every structural rule (closed
//!   envelopes, required fields, response/error exclusivity, required
//!   payload fields of known events) is still enforced.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// The literal protocol identifier; anything else on the wire is rejected.
pub const PROTOCOL_ID: &str = "desktop-v1";

/// The 48 desktop-v1 method names (commands.schema.json `method` enum).
pub const METHODS: &[&str] = &[
    "engine.ping",
    "engine.shutdown",
    "project.create",
    "project.open",
    "project.close",
    "project.snapshot",
    "project.resume",
    "project.replay_events",
    "run.start",
    "run.continue",
    "run.steer",
    "run.abort",
    "run.pause",
    "run.advance_one_chapter",
    "run.set_advance_mode",
    "run.retry",
    "cocreate.start",
    "cocreate.stage",
    "cocreate.resume",
    "cocreate.cancel",
    "chapter.list",
    "chapter.read",
    "chapter.save",
    "chapter.revisions.check",
    "chapter.revisions.sync",
    "chapter.export",
    "artifacts.read",
    "import.start",
    "import.resume",
    "import.cancel",
    "simulation.start",
    "simulation.resume",
    "simulation.cancel",
    "simulation.profile_import",
    "config.get",
    "config.update",
    "config.providers",
    "config.models",
    "config.switch_model",
    "config.thinking_levels",
    "config.set_thinking",
    "config.set_language",
    "config.set_story_language",
    "diagnostics.snapshot",
    "diagnostics.export",
    "usage.snapshot",
    "logs.replay",
    "runtime.queue",
];

/// The 26 desktop-v1 event names (events.schema.json `event` enum).
pub const EVENTS: &[&str] = &[
    "engine.ready",
    "engine.status_changed",
    "engine.error",
    "engine.exited",
    "engine.restarting",
    "run.started",
    "run.step_changed",
    "run.progress",
    "run.paused",
    "run.completed",
    "run.failed",
    "run.aborted",
    "stream.delta",
    "stream.clear",
    "checkpoint.created",
    "artifact.updated",
    "chapter.updated",
    "outline.updated",
    "usage.updated",
    "cocreate.progress",
    "import.progress",
    "simulation.progress",
    "diagnostics.completed",
    "notification.info",
    "notification.warning",
    "notification.error",
];

/// The stable error codes (events.schema.json `error_code` enum).
pub const ERROR_CODES: &[&str] = &[
    "malformed_json",
    "invalid_payload",
    "unknown_method",
    "duplicate_request_id",
    "project_unavailable",
    "host_busy",
    "operation_failed",
    "cancelled",
    "internal_error",
];

pub fn is_known_method(method: &str) -> bool {
    METHODS.contains(&method)
}

pub fn is_known_event(event: &str) -> bool {
    EVENTS.contains(&event)
}

pub fn is_known_error_code(code: &str) -> bool {
    ERROR_CODES.contains(&code)
}

/// Strictness of [`parse_line`]; see the module docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseMode {
    /// Full JSON-Schema conformance (fixtures, catalog membership enforced).
    Strict,
    /// Live sidecar output: additive-only tolerance for unknown event names
    /// and error codes; structure still enforced.
    Runtime,
}

/// Error produced while turning one stdout line into a [`Message`].
#[derive(Debug, Clone, PartialEq)]
pub enum ProtocolError {
    /// The line is not valid JSON (or not a JSON object). Mirrors the
    /// protocol's `malformed_json` classification.
    MalformedJson(String),
    /// The line parsed but violates the envelope/payload schema. Mirrors
    /// `invalid_payload`.
    SchemaViolation(String),
}

impl std::fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProtocolError::MalformedJson(m) => write!(f, "malformed_json: {m}"),
            ProtocolError::SchemaViolation(m) => write!(f, "invalid_payload: {m}"),
        }
    }
}

impl std::error::Error for ProtocolError {}

fn empty_map() -> Map<String, Value> {
    Map::new()
}

/// Request envelope (client -> engine, stdin). Keys are closed; `payload`
/// defaults to `{}` and is an open object.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RequestEnvelope {
    pub protocol: String,
    pub kind: String,
    pub id: String,
    pub method: String,
    #[serde(default = "empty_map")]
    pub payload: Map<String, Value>,
}

/// Structured error object carried by `ok:false` responses and mirrored by
/// `engine.error` events.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ProtocolErrorBody {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

/// Response envelope (engine -> client, stdout).
///
/// `ok:true` may carry `payload` and must not carry `error`; `ok:false` must
/// carry `error` and must not carry `payload`. Both rules are enforced in
/// [`Message::parse_line`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ResponseEnvelope {
    pub protocol: String,
    pub kind: String,
    pub id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ProtocolErrorBody>,
}

/// Event envelope (engine -> client, stdout). `sequence` is monotonic per
/// engine session; delivery is at-least-once so duplicates are valid input.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EventEnvelope {
    pub protocol: String,
    pub kind: String,
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    pub sequence: u64,
    #[serde(default = "empty_map")]
    pub payload: Map<String, Value>,
}

/// A parsed stdout/stdin protocol message.
#[derive(Debug, Clone, PartialEq)]
pub enum Message {
    Request(RequestEnvelope),
    Response(ResponseEnvelope),
    Event(EventEnvelope),
}

/// Result of reading one wire line.
#[derive(Debug, Clone, PartialEq)]
pub enum ParsedLine {
    /// Blank (or whitespace-only) line: not a protocol message, skip it.
    Blank,
    Message(Message),
}

impl Message {
    /// Build a request envelope for `method`. `protocol`/`kind` are stamped
    /// automatically; the payload is serialized verbatim.
    pub fn build_request(id: &str, method: &str, payload: Map<String, Value>) -> RequestEnvelope {
        RequestEnvelope {
            protocol: PROTOCOL_ID.to_string(),
            kind: "request".to_string(),
            id: id.to_string(),
            method: method.to_string(),
            payload,
        }
    }

    /// Parse one NDJSON line in the given strictness mode.
    pub fn parse_line(line: &str, mode: ParseMode) -> Result<ParsedLine, ProtocolError> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return Ok(ParsedLine::Blank);
        }

        let value: Value = serde_json::from_str(trimmed)
            .map_err(|e| ProtocolError::MalformedJson(format!("{e}")))?;
        let obj = value
            .as_object()
            .ok_or_else(|| ProtocolError::MalformedJson("line is not a JSON object".into()))?;

        let protocol = obj
            .get("protocol")
            .and_then(Value::as_str)
            .ok_or_else(|| ProtocolError::SchemaViolation("missing protocol field".into()))?;
        if protocol != PROTOCOL_ID {
            return Err(ProtocolError::SchemaViolation(format!(
                "unsupported protocol value: {protocol:?} (expected {PROTOCOL_ID:?})"
            )));
        }

        let kind = obj
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| ProtocolError::SchemaViolation("missing kind field".into()))?;

        match kind {
            "request" => {
                let env: RequestEnvelope = serde_json::from_value(value).map_err(|e| {
                    ProtocolError::SchemaViolation(format!("request envelope: {e}"))
                })?;
                if env.id.is_empty() {
                    return Err(ProtocolError::SchemaViolation(
                        "request id must be a non-empty string".into(),
                    ));
                }
                if mode == ParseMode::Strict && !is_known_method(&env.method) {
                    return Err(ProtocolError::SchemaViolation(format!(
                        "unknown method: {}",
                        env.method
                    )));
                }
                validate_request_payload(&env.method, &env.payload, mode)?;
                Ok(ParsedLine::Message(Message::Request(env)))
            }
            "response" => {
                let env: ResponseEnvelope = serde_json::from_value(value).map_err(|e| {
                    ProtocolError::SchemaViolation(format!("response envelope: {e}"))
                })?;
                if env.id.is_empty() {
                    return Err(ProtocolError::SchemaViolation(
                        "response id must be a non-empty string".into(),
                    ));
                }
                if env.ok {
                    if env.error.is_some() {
                        return Err(ProtocolError::SchemaViolation(
                            "success response must not carry error".into(),
                        ));
                    }
                } else {
                    let error = env.error.as_ref().ok_or_else(|| {
                        ProtocolError::SchemaViolation("ok:false response requires error".into())
                    })?;
                    if env.payload.is_some() {
                        return Err(ProtocolError::SchemaViolation(
                            "failure response must not carry payload".into(),
                        ));
                    }
                    if error.message.is_empty() {
                        return Err(ProtocolError::SchemaViolation(
                            "error.message must be a non-empty string".into(),
                        ));
                    }
                    if mode == ParseMode::Strict && !is_known_error_code(&error.code) {
                        return Err(ProtocolError::SchemaViolation(format!(
                            "unknown error code: {}",
                            error.code
                        )));
                    }
                }
                Ok(ParsedLine::Message(Message::Response(env)))
            }
            "event" => {
                let env: EventEnvelope = serde_json::from_value(value)
                    .map_err(|e| ProtocolError::SchemaViolation(format!("event envelope: {e}")))?;
                if mode == ParseMode::Strict && !is_known_event(&env.event) {
                    return Err(ProtocolError::SchemaViolation(format!(
                        "unknown event: {}",
                        env.event
                    )));
                }
                validate_event_payload(&env.event, &env.payload, mode)?;
                Ok(ParsedLine::Message(Message::Event(env)))
            }
            other => Err(ProtocolError::SchemaViolation(format!(
                "unknown kind: {other}"
            ))),
        }
    }
}

/// Required request payload fields per commands.schema.json
/// (`required` arrays of the `<method>_request` defs). Returns
/// `(field, expected)` pairs; the expected shape is checked in
/// [`validate_field_shape`].
fn required_request_fields(method: &str) -> &'static [(&'static str, FieldShape)] {
    use FieldShape::*;
    match method {
        "project.create" => &[("path", String)],
        "project.open" => &[("path", String)],
        "run.steer" => &[("instruction", String)],
        "run.set_advance_mode" => &[("mode", String)],
        "cocreate.start" => &[("message", String)],
        "cocreate.stage" => &[("message", String)],
        "chapter.read" => &[("chapter", StringOrInt)],
        "chapter.save" => &[("chapter", StringOrInt), ("content", String)],
        "artifacts.read" => &[("kind", String)],
        "import.start" => &[("source_path", String)],
        "simulation.start" => &[("source_path", String)],
        "simulation.profile_import" => &[("profile_path", String)],
        "config.update" => &[("values", Object)],
        "config.switch_model" => &[("provider", String), ("model", String)],
        "config.set_thinking" => &[("level", String)],
        "config.set_language" => &[("language", String)],
        "config.set_story_language" => &[("language", String)],
        _ => &[],
    }
}

/// Required event payload fields per events.schema.json.
fn required_event_fields(event: &str) -> &'static [(&'static str, FieldShape)] {
    use FieldShape::*;
    match event {
        "engine.status_changed" => &[("status", String)],
        "engine.error" => &[("message", String)],
        "run.step_changed" => &[("step", String)],
        "run.failed" => &[("message", String)],
        "stream.delta" => &[("text", String)],
        "checkpoint.created" => &[("checkpoint_id", String)],
        "artifact.updated" => &[("artifact", String)],
        "chapter.updated" => &[("chapter", StringOrInt)],
        "cocreate.progress" => &[("stage", String)],
        "notification.info" | "notification.warning" | "notification.error" => {
            &[("message", String)]
        }
        _ => &[],
    }
}

#[derive(Clone, Copy)]
enum FieldShape {
    String,
    StringOrInt,
    Object,
}

fn validate_field_shape(
    method_or_event: &str,
    field: &str,
    shape: FieldShape,
    value: &Value,
) -> Result<(), ProtocolError> {
    // Strings must additionally be non-empty where the schema uses minLength.
    let ok = match shape {
        FieldShape::String => matches!(value, Value::String(s) if !s.is_empty()),
        FieldShape::StringOrInt => matches!(value, Value::String(_) | Value::Number(_)),
        FieldShape::Object => value.is_object(),
    };
    if !ok {
        return Err(ProtocolError::SchemaViolation(format!(
            "{method_or_event}: payload field {field:?} has the wrong type or is empty"
        )));
    }
    Ok(())
}

/// Validate a request payload's schema-required fields. Used both when
/// parsing requests (fixture conformance / mock sidecar input) and before the
/// shell sends a request, so obvious mistakes fail fast with the same
/// `invalid_payload` code the engine would return.
pub fn validate_request_payload(
    method: &str,
    payload: &Map<String, Value>,
    _mode: ParseMode,
) -> Result<(), ProtocolError> {
    for (field, shape) in required_request_fields(method) {
        match payload.get(*field) {
            None => {
                return Err(ProtocolError::SchemaViolation(format!(
                    "{method}: payload field {field:?} is required"
                )))
            }
            Some(value) => validate_field_shape(method, field, *shape, value)?,
        }
    }
    Ok(())
}

/// Validate a known event's schema-required payload fields. Unknown event
/// names have no catalog entry and pass (additive forward compatibility).
pub fn validate_event_payload(
    event: &str,
    payload: &Map<String, Value>,
    _mode: ParseMode,
) -> Result<(), ProtocolError> {
    for (field, shape) in required_event_fields(event) {
        match payload.get(*field) {
            None => {
                return Err(ProtocolError::SchemaViolation(format!(
                    "{event}: payload field {field:?} is required"
                )))
            }
            Some(value) => validate_field_shape(event, field, *shape, value)?,
        }
    }
    Ok(())
}

/// Serialize an envelope into exactly one compact NDJSON line (no embedded
/// raw newlines; serde_json escapes control characters).
pub fn to_line<T: Serialize>(envelope: &T) -> Result<String, ProtocolError> {
    serde_json::to_string(envelope)
        .map_err(|e| ProtocolError::MalformedJson(format!("failed to encode envelope: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_sizes_match_protocol_readme() {
        assert_eq!(METHODS.len(), 48, "48 binding methods");
        assert_eq!(EVENTS.len(), 26, "26 binding events");
        assert_eq!(ERROR_CODES.len(), 9, "9 binding error codes");
    }

    #[test]
    fn blank_lines_are_skipped() {
        assert_eq!(
            Message::parse_line("", ParseMode::Strict).unwrap(),
            ParsedLine::Blank
        );
        assert_eq!(
            Message::parse_line("   \t ", ParseMode::Runtime).unwrap(),
            ParsedLine::Blank
        );
    }

    #[test]
    fn rejects_wrong_protocol_value() {
        let err = Message::parse_line(
            r#"{"protocol":"desktop-v2","kind":"request","id":"r","method":"engine.ping"}"#,
            ParseMode::Runtime,
        )
        .unwrap_err();
        assert!(matches!(err, ProtocolError::SchemaViolation(_)));
        assert!(err.to_string().contains("desktop-v2"));
    }

    #[test]
    fn rejects_non_object_and_broken_json() {
        assert!(matches!(
            Message::parse_line("[1, 2, 3]", ParseMode::Strict).unwrap_err(),
            ProtocolError::MalformedJson(_)
        ));
        assert!(matches!(
            Message::parse_line("{\"protocol\":", ParseMode::Strict).unwrap_err(),
            ProtocolError::MalformedJson(_)
        ));
        assert!(matches!(
            Message::parse_line("42", ParseMode::Runtime).unwrap_err(),
            ProtocolError::MalformedJson(_)
        ));
    }

    #[test]
    fn rejects_unknown_top_level_keys() {
        let err = Message::parse_line(
            r#"{"protocol":"desktop-v1","kind":"event","event":"engine.ready","sequence":1,"extra":true}"#,
            ParseMode::Runtime,
        )
        .unwrap_err();
        assert!(matches!(err, ProtocolError::SchemaViolation(_)));
    }

    #[test]
    fn strict_rejects_unknown_event_runtime_accepts() {
        let line = r#"{"protocol":"desktop-v1","kind":"event","event":"engine.teleported","sequence":5,"payload":{}}"#;
        assert!(Message::parse_line(line, ParseMode::Strict).is_err());
        let parsed = Message::parse_line(line, ParseMode::Runtime).unwrap();
        match parsed {
            ParsedLine::Message(Message::Event(ev)) => assert_eq!(ev.event, "engine.teleported"),
            other => panic!("expected event, got {other:?}"),
        }
    }

    #[test]
    fn response_error_exclusivity_is_always_enforced() {
        // ok:true together with error -> reject even at runtime.
        assert!(Message::parse_line(
            r#"{"protocol":"desktop-v1","kind":"response","id":"r","ok":true,"error":{"code":"internal_error","message":"boom"}}"#,
            ParseMode::Runtime
        )
        .is_err());
        // ok:false without error -> reject.
        assert!(Message::parse_line(
            r#"{"protocol":"desktop-v1","kind":"response","id":"r","ok":false}"#,
            ParseMode::Runtime
        )
        .is_err());
        // ok:false with payload -> reject.
        assert!(Message::parse_line(
            r#"{"protocol":"desktop-v1","kind":"response","id":"r","ok":false,"error":{"code":"host_busy","message":"busy"},"payload":{}}"#,
            ParseMode::Runtime
        )
        .is_err());
        // ok as string -> reject.
        assert!(Message::parse_line(
            r#"{"protocol":"desktop-v1","kind":"response","id":"r","ok":"true"}"#,
            ParseMode::Runtime
        )
        .is_err());
    }

    #[test]
    fn request_payload_required_fields_enforced() {
        // run.steer without instruction is invalid in both modes.
        for mode in [ParseMode::Strict, ParseMode::Runtime] {
            let err = Message::parse_line(
                r#"{"protocol":"desktop-v1","kind":"request","id":"r","method":"run.steer","payload":{}}"#,
                mode,
            )
            .unwrap_err();
            assert!(err.to_string().contains("instruction"));
        }
        // chapter.save accepts string or integer chapter plus content.
        let ok = Message::parse_line(
            r#"{"protocol":"desktop-v1","kind":"request","id":"r","method":"chapter.save","payload":{"chapter":3,"content":"text"}}"#,
            ParseMode::Strict,
        );
        assert!(ok.is_ok());
        let ok = Message::parse_line(
            r#"{"protocol":"desktop-v1","kind":"request","id":"r","method":"chapter.save","payload":{"chapter":"ch-1","content":"text"}}"#,
            ParseMode::Strict,
        );
        assert!(ok.is_ok());
        // artifacts.read requires a kind string (field-table parity with
        // commands.schema.json; the daemon rejects it the same way).
        for mode in [ParseMode::Strict, ParseMode::Runtime] {
            let err = Message::parse_line(
                r#"{"protocol":"desktop-v1","kind":"request","id":"r","method":"artifacts.read","payload":{}}"#,
                mode,
            )
            .unwrap_err();
            assert!(err.to_string().contains("kind"));
        }
        let ok = Message::parse_line(
            r#"{"protocol":"desktop-v1","kind":"request","id":"r","method":"artifacts.read","payload":{"kind":"facts"}}"#,
            ParseMode::Strict,
        );
        assert!(ok.is_ok());
    }

    #[test]
    fn known_event_payload_required_fields_enforced_at_runtime() {
        // stream.delta without text is structurally invalid even at runtime.
        assert!(Message::parse_line(
            r#"{"protocol":"desktop-v1","kind":"event","event":"stream.delta","sequence":10,"payload":{}}"#,
            ParseMode::Runtime
        )
        .is_err());
        // unknown event name with arbitrary payload is tolerated.
        assert!(Message::parse_line(
            r#"{"protocol":"desktop-v1","kind":"event","event":"engine.brand_new","sequence":11,"payload":{"anything":1}}"#,
            ParseMode::Runtime
        )
        .is_ok());
    }

    #[test]
    fn build_request_and_roundtrip() {
        let mut payload = Map::new();
        payload.insert("path".into(), Value::String("/tmp/novel".into()));
        let req = Message::build_request("req-1", "project.open", payload);
        let line = to_line(&req).unwrap();
        assert!(!line.contains('\n'));
        let parsed = Message::parse_line(&line, ParseMode::Strict).unwrap();
        match parsed {
            ParsedLine::Message(Message::Request(r)) => {
                assert_eq!(r.id, "req-1");
                assert_eq!(r.method, "project.open");
                assert_eq!(r.payload.get("path").unwrap(), "/tmp/novel");
            }
            other => panic!("expected request, got {other:?}"),
        }
    }
}
