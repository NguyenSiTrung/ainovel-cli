//! Structured errors crossing the Tauri command boundary.
//!
//! The shape mirrors the desktop-v1 protocol error object
//! (`{code, message, details?}`) so the frontend handles engine failures and
//! shell failures through one code path. Codes from the protocol catalog
//! (`malformed_json`, `unknown_method`, ...) are reused verbatim when the
//! shell detects the same condition locally; the shell adds a small, clearly
//! namespaced set of codes for failures only it can observe
//! (`engine_unavailable`, `request_timeout`, `sidecar_error`,
//! `invalid_path`).

use serde::{ser::SerializeStruct, Serialize, Serializer};
use serde_json::Value;

// Protocol catalog codes (desktop-v1 README section 5) reused by the shell.
pub const CODE_MALFORMED_JSON: &str = "malformed_json";
pub const CODE_INVALID_PAYLOAD: &str = "invalid_payload";
pub const CODE_UNKNOWN_METHOD: &str = "unknown_method";
pub const CODE_INTERNAL_ERROR: &str = "internal_error";

// Shell-extension codes (documented in desktop/src-tauri/README.md).
/// The engine process is not running or is not ready; no request was sent.
pub const CODE_ENGINE_UNAVAILABLE: &str = "engine_unavailable";
/// The engine accepted the request but no terminal response arrived in time.
pub const CODE_REQUEST_TIMEOUT: &str = "request_timeout";
/// The sidecar process could not be spawned or supervised.
pub const CODE_SIDECAR_ERROR: &str = "sidecar_error";
/// A path supplied by the frontend failed native validation.
pub const CODE_INVALID_PATH: &str = "invalid_path";

/// Structured error returned by every Tauri command.
///
/// Serializes to `{ "code": ..., "message": ..., "details": ... }` with
/// `details` omitted when absent, matching the protocol error object.
#[derive(Debug, Clone, PartialEq)]
pub struct DesktopError {
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
}

impl DesktopError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            details: None,
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn with_details_opt(self, details: Option<Value>) -> Self {
        match details {
            Some(details) => self.with_details(details),
            None => self,
        }
    }

    pub fn unknown_method(method: &str) -> Self {
        Self::new(
            CODE_UNKNOWN_METHOD,
            format!("unknown desktop-v1 method: {method}"),
        )
        .with_details(serde_json::json!({ "method": method }))
    }

    pub fn invalid_payload(message: impl Into<String>) -> Self {
        Self::new(CODE_INVALID_PAYLOAD, message)
    }

    pub fn engine_unavailable(message: impl Into<String>) -> Self {
        Self::new(CODE_ENGINE_UNAVAILABLE, message)
    }

    pub fn request_timeout(id: &str) -> Self {
        Self::new(
            CODE_REQUEST_TIMEOUT,
            format!("engine did not answer request {id} before the timeout"),
        )
        .with_details(serde_json::json!({ "id": id }))
    }

    pub fn sidecar(message: impl Into<String>) -> Self {
        Self::new(CODE_SIDECAR_ERROR, message)
    }

    pub fn invalid_path(message: impl Into<String>) -> Self {
        Self::new(CODE_INVALID_PATH, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(CODE_INTERNAL_ERROR, message)
    }
}

impl std::fmt::Display for DesktopError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for DesktopError {}

impl Serialize for DesktopError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let n = if self.details.is_some() { 3 } else { 2 };
        let mut s = serializer.serialize_struct("DesktopError", n)?;
        s.serialize_field("code", &self.code)?;
        s.serialize_field("message", &self.message)?;
        if let Some(details) = &self.details {
            s.serialize_field("details", details)?;
        }
        s.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_with_and_without_details() {
        let with = serde_json::to_value(
            DesktopError::unknown_method("teleport.now").with_details(serde_json::json!({"a":1})),
        )
        .unwrap();
        assert_eq!(
            with,
            serde_json::json!({"code":"unknown_method","message":"unknown desktop-v1 method: teleport.now","details":{"a":1}})
        );

        let without =
            serde_json::to_value(DesktopError::engine_unavailable("engine exited")).unwrap();
        assert_eq!(
            without,
            serde_json::json!({"code":"engine_unavailable","message":"engine exited"})
        );
    }
}
