use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Client → Gateway request frame.
///
/// Wire format: `{ "type": "req", "id": "<uuid>", "method": "<name>", "params": <optional> }`
#[derive(Debug, Clone, Serialize)]
pub struct RequestFrame {
    #[serde(rename = "type")]
    pub frame_type: String,
    pub id: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

impl RequestFrame {
    pub fn new(id: impl Into<String>, method: impl Into<String>, params: Option<serde_json::Value>) -> Self {
        Self {
            frame_type: "req".into(),
            id: id.into(),
            method: method.into(),
            params,
        }
    }
}

/// Gateway → Client response frame.
///
/// Wire format: `{ "type": "res", "id": "<uuid>", "ok": bool, "payload": <opt>, "error": <opt> }`
#[derive(Debug, Clone, Deserialize)]
pub struct ResponseFrame {
    pub id: String,
    pub ok: bool,
    #[serde(default)]
    pub payload: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<RpcErrorDetail>,
}

/// Error detail embedded in a `ResponseFrame`.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct RpcErrorDetail {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub details: Option<serde_json::Value>,
    #[serde(default)]
    pub retryable: Option<bool>,
    #[serde(default, rename = "retryAfterMs")]
    pub retry_after_ms: Option<u64>,
}

/// Gateway → Client event frame (broadcast).
///
/// Wire format: `{ "type": "event", "event": "<name>", "payload": <opt>, "seq": <opt> }`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventFrame {
    pub event: String,
    #[serde(default)]
    pub payload: Option<serde_json::Value>,
    #[serde(default)]
    pub seq: Option<u64>,
    #[serde(default, rename = "stateVersion")]
    pub state_version: Option<HashMap<String, u64>>,
}

/// Discriminated union for all inbound (server → client) frames.
///
/// Uses serde tagged enum on the `"type"` field:
/// - `"res"` → `InboundFrame::Response`
/// - `"event"` → `InboundFrame::Event`
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum InboundFrame {
    #[serde(rename = "res")]
    Response(ResponseFrame),
    #[serde(rename = "event")]
    Event(EventFrame),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_request_frame_serialization() {
        let frame = RequestFrame::new("test-1", "health", None);
        let json = serde_json::to_string(&frame).unwrap();
        assert!(json.contains(r#""type":"req"#));
        assert!(json.contains(r#""id":"test-1"#));
        assert!(json.contains(r#""method":"health"#));
        // params should be omitted when None
        assert!(!json.contains("params"));
    }

    #[test]
    fn test_request_frame_with_params() {
        let frame = RequestFrame::new(
            "test-2",
            "send",
            Some(serde_json::json!({"target": "+1234"})),
        );
        let json = serde_json::to_string(&frame).unwrap();
        assert!(json.contains(r#""params":"#));
        assert!(json.contains(r#""target":"+1234"#));
    }

    #[test]
    fn test_response_frame_ok() {
        let json = r#"{"type":"res","id":"r1","ok":true,"payload":{"status":"ok"}}"#;
        let frame: ResponseFrame = serde_json::from_str(json).unwrap();
        assert!(frame.ok);
        assert_eq!(frame.id, "r1");
        assert!(frame.payload.is_some());
        assert!(frame.error.is_none());
    }

    #[test]
    fn test_response_frame_error() {
        let json = r#"{"type":"res","id":"r2","ok":false,"error":{"code":"NOT_LINKED","message":"channel not linked","retryable":false}}"#;
        let frame: ResponseFrame = serde_json::from_str(json).unwrap();
        assert!(!frame.ok);
        let err = frame.error.unwrap();
        assert_eq!(err.code, "NOT_LINKED");
        assert_eq!(err.message, "channel not linked");
        assert_eq!(err.retryable, Some(false));
    }

    #[test]
    fn test_response_frame_tolerant_unknown_fields() {
        let json = r#"{"type":"res","id":"r3","ok":true,"payload":{"x":1},"unknownField":42}"#;
        // Should not panic — extra fields are ignored
        let frame: ResponseFrame = serde_json::from_str(json).unwrap();
        assert!(frame.ok);
    }

    #[test]
    fn test_event_frame_deserialization() {
        let json = r#"{"type":"event","event":"tick","payload":{"ts":1700000000},"seq":42}"#;
        let frame: EventFrame = serde_json::from_str(json).unwrap();
        assert_eq!(frame.event, "tick");
        assert_eq!(frame.seq, Some(42));
    }

    #[test]
    fn test_event_frame_minimal() {
        let json = r#"{"event":"presence"}"#;
        let frame: EventFrame = serde_json::from_str(json).unwrap();
        assert_eq!(frame.event, "presence");
        assert!(frame.payload.is_none());
        assert!(frame.seq.is_none());
    }

    #[test]
    fn test_inbound_frame_response() {
        let json = r#"{"type":"res","id":"x","ok":true}"#;
        let frame: InboundFrame = serde_json::from_str(json).unwrap();
        assert!(matches!(frame, InboundFrame::Response(_)));
    }

    #[test]
    fn test_inbound_frame_event() {
        let json = r#"{"type":"event","event":"chat","payload":null}"#;
        let frame: InboundFrame = serde_json::from_str(json).unwrap();
        assert!(matches!(frame, InboundFrame::Event(_)));
    }

    #[test]
    fn test_event_frame_clone() {
        let frame = EventFrame {
            event: "test".into(),
            payload: Some(serde_json::json!({"key": "value"})),
            seq: Some(1),
            state_version: None,
        };
        let cloned = frame.clone();
        assert_eq!(cloned.event, "test");
        assert_eq!(cloned.seq, Some(1));
    }
}
