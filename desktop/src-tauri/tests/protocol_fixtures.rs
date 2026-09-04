//! Shared protocol fixture conformance: every line of every fixture in
//! `protocols/desktop-v1/fixtures/` is parsed by the Rust implementation.
//!
//! * `valid-*.jsonl`: every line must parse in Strict mode AND Runtime mode,
//!   and serialize/deserialize round-trips to the same JSON value.
//! * `invalid-*.jsonl`: every line must be rejected in Strict mode. In
//!   Runtime mode everything is still rejected except additive-only
//!   additions desktop-v1 explicitly permits (unknown event names), which
//!   must parse and forward opaquely.

use ainovel_desktop_lib::protocol::{Message, ParseMode, ParsedLine, PROTOCOL_ID};
use serde_json::Value;

fn fixtures_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../protocols/desktop-v1/fixtures")
}

fn fixture(name: &str) -> Vec<String> {
    let path = fixtures_dir().join(name);
    let content = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read fixture {name:?}: {e}"));
    content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect()
}

#[test]
fn fixtures_dir_is_reachable_and_has_expected_files() {
    let expected = [
        "valid-request.jsonl",
        "valid-response-success.jsonl",
        "valid-response-error.jsonl",
        "valid-events-stream-lifecycle.jsonl",
        "valid-events-duplicate-sequence-replay.jsonl",
        "valid-events-sidecar-recovery.jsonl",
        "valid-requests-catalog.jsonl",
        "valid-events-catalog.jsonl",
        "invalid-malformed-line.jsonl",
        "invalid-schema-violations.jsonl",
    ];
    for name in expected {
        assert!(fixtures_dir().join(name).exists(), "missing fixture {name}");
    }
}

#[test]
fn valid_fixtures_parse_in_both_modes() {
    let valid_files = [
        "valid-request.jsonl",
        "valid-response-success.jsonl",
        "valid-response-error.jsonl",
        "valid-events-stream-lifecycle.jsonl",
        "valid-events-duplicate-sequence-replay.jsonl",
        "valid-events-sidecar-recovery.jsonl",
        "valid-requests-catalog.jsonl",
        "valid-events-catalog.jsonl",
    ];
    let mut total = 0;
    for file in valid_files {
        for line in fixture(file) {
            for mode in [ParseMode::Strict, ParseMode::Runtime] {
                let parsed = Message::parse_line(&line, mode)
                    .unwrap_or_else(|e| panic!("{file}: line rejected in {mode:?}: {e}\n{line}"));
                assert!(
                    matches!(parsed, ParsedLine::Message(_)),
                    "{file}: expected a message, got blank: {line}"
                );
            }
            // Every valid line stamps the protocol identifier.
            let as_value: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(as_value["protocol"], PROTOCOL_ID);
            total += 1;
        }
    }
    // 53 request catalog lines + 26 event catalog lines + the rest.
    assert!(
        total >= 80,
        "expected the full shared fixture set, got {total}"
    );
}

#[test]
fn request_catalog_fixture_covers_every_binding_method() {
    let lines = fixture("valid-requests-catalog.jsonl");
    assert_eq!(lines.len(), 53, "one valid request per method");
    let mut methods: Vec<String> = lines
        .iter()
        .map(
            |line| match Message::parse_line(line, ParseMode::Strict).unwrap() {
                ParsedLine::Message(Message::Request(req)) => req.method,
                other => panic!("expected request, got {other:?}"),
            },
        )
        .collect();
    methods.sort_unstable();
    let mut expected: Vec<&str> = ainovel_desktop_lib::protocol::METHODS.to_vec();
    expected.sort_unstable();
    assert_eq!(methods, expected, "catalog drift between fixtures and Rust");
}

#[test]
fn event_catalog_fixture_covers_every_binding_event() {
    let lines = fixture("valid-events-catalog.jsonl");
    assert_eq!(lines.len(), 26, "one valid event per event name");
    let mut events: Vec<String> = lines
        .iter()
        .map(
            |line| match Message::parse_line(line, ParseMode::Strict).unwrap() {
                ParsedLine::Message(Message::Event(ev)) => ev.event,
                other => panic!("expected event, got {other:?}"),
            },
        )
        .collect();
    events.sort_unstable();
    let mut expected: Vec<&str> = ainovel_desktop_lib::protocol::EVENTS.to_vec();
    expected.sort_unstable();
    assert_eq!(events, expected, "catalog drift between fixtures and Rust");
}

#[test]
fn invalid_fixtures_are_rejected_structurally() {
    // Malformed lines.
    for line in fixture("invalid-malformed-line.jsonl") {
        assert!(
            Message::parse_line(&line, ParseMode::Strict).is_err(),
            "malformed line must be rejected: {line}"
        );
        assert!(
            Message::parse_line(&line, ParseMode::Runtime).is_err(),
            "malformed line must be rejected at runtime too: {line}"
        );
    }

    // Schema violations: all rejected in Strict mode; in Runtime mode only
    // additive-only catalog additions (unknown event and method names, per
    // README section 9 forward compatibility) are tolerated.
    let mut runtime_tolerated = 0;
    for line in fixture("invalid-schema-violations.jsonl") {
        assert!(
            Message::parse_line(&line, ParseMode::Strict).is_err(),
            "strict mode must reject: {line}"
        );
        match Message::parse_line(&line, ParseMode::Runtime) {
            Err(_) => {}
            Ok(ParsedLine::Message(Message::Event(ev))) => {
                // Unknown (additive) event name that is structurally sound.
                assert_eq!(
                    ev.event, "engine.teleported",
                    "unexpected tolerance: {line}"
                );
                runtime_tolerated += 1;
            }
            Ok(ParsedLine::Message(Message::Request(req))) => {
                // Unknown (additive) method name that is structurally sound.
                assert_eq!(req.method, "teleport.now", "unexpected tolerance: {line}");
                runtime_tolerated += 1;
            }
            Ok(ParsedLine::Message(Message::Response(resp))) => {
                // Unknown (additive) error code in a structurally sound
                // failure response.
                assert_eq!(
                    resp.error.as_ref().map(|e| e.code.as_str()),
                    Some("VERY_BAD"),
                    "unexpected tolerance: {line}"
                );
                runtime_tolerated += 1;
            }
            Ok(other) => panic!("runtime mode must reject: {line} -> {other:?}"),
        }
    }
    assert_eq!(
        runtime_tolerated, 3,
        "unknown event, method, and error-code lines are runtime-tolerated"
    );
}

#[test]
fn specific_violation_reasons_map_to_protocol_error_kinds() {
    use ainovel_desktop_lib::protocol::ProtocolError;

    let wrong_protocol =
        r#"{"protocol":"desktop-v2","kind":"request","id":"x","method":"engine.ping"}"#;
    let err = Message::parse_line(wrong_protocol, ParseMode::Strict).unwrap_err();
    assert!(matches!(err, ProtocolError::SchemaViolation(_)));
    assert!(err.to_string().contains("desktop-v2"));

    let truncated = r#"{"protocol":"desktop-v1","kind":"request","id":"r","method":"engine.ping","payload":{"oops""#;
    let err = Message::parse_line(truncated, ParseMode::Strict).unwrap_err();
    assert!(matches!(err, ProtocolError::MalformedJson(_)));

    let garbage = "[[[ not json at all";
    assert!(matches!(
        Message::parse_line(garbage, ParseMode::Strict).unwrap_err(),
        ProtocolError::MalformedJson(_)
    ));
}

#[test]
fn envelope_serialization_round_trips_through_parse() {
    // Every valid fixture line: parse -> reserialize as Value -> equality
    // with the original JSON value (payload field order may differ, value
    // equality must hold).
    for file in [
        "valid-request.jsonl",
        "valid-response-success.jsonl",
        "valid-response-error.jsonl",
    ] {
        for line in fixture(file) {
            let original: Value = serde_json::from_str(&line).unwrap();
            let parsed = match Message::parse_line(&line, ParseMode::Strict).unwrap() {
                ParsedLine::Message(message) => message,
                ParsedLine::Blank => unreachable!(),
            };
            let serialized: Value = match &parsed {
                Message::Request(req) => serde_json::to_value(req).unwrap(),
                Message::Response(resp) => serde_json::to_value(resp).unwrap(),
                Message::Event(ev) => serde_json::to_value(ev).unwrap(),
            };
            assert_eq!(original, serialized, "{file}: round-trip mismatch");
        }
    }
}

#[test]
fn sidecar_recovery_fixture_models_the_restart_flow() {
    // The recovery fixture must parse as: old-session events incl.
    // engine.exited, engine.restarting, then engine.ready with a NEW
    // session and reset sequence.
    let lines = fixture("valid-events-sidecar-recovery.jsonl");
    let events: Vec<_> = lines
        .iter()
        .map(
            |line| match Message::parse_line(line, ParseMode::Strict).unwrap() {
                ParsedLine::Message(Message::Event(ev)) => ev,
                other => panic!("expected event, got {other:?}"),
            },
        )
        .collect();

    assert_eq!(events[0].session.as_deref(), Some("sess-7f2c"));
    assert_eq!(events[1].event, "engine.exited");
    assert_eq!(events[2].event, "engine.restarting");
    assert_eq!(events[3].event, "engine.ready");
    assert_eq!(events[3].session.as_deref(), Some("sess-91bd"));
    assert_eq!(
        events[3].sequence, 1,
        "sequence resets with the new session"
    );
    assert_eq!(
        events[3].payload.get("recovered"),
        Some(&serde_json::json!(true))
    );
}
