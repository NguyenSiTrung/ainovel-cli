// Package desktop 实现桌面端 sidecar 守护进程：以 desktop-v1 NDJSON 协议
// （protocols/desktop-v1/）在 stdin/stdout 上对外提供引擎能力。
//
// 约束（README.md 的绑定规则）：
//   - stdout 只输出协议消息（响应 + 事件）；所有日志走 stderr / 文件日志。
//   - 每个请求恰好一条终态响应；长操作先回接受响应，进度与终态走事件。
//   - 无法解析的输入行 → engine.error 事件（payload.code=malformed_json），
//     绝不回响应（没有 id 可回显）。
//   - 事件 sequence 在会话内单调递增；session 变化即 sidecar 重启。
package desktop

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
)

// ProtocolID 是 desktop-v1 协议标识。
const ProtocolID = "desktop-v1"

// 消息 kind。
const (
	KindRequest  = "request"
	KindResponse = "response"
	KindEvent    = "event"
)

// 稳定错误码（events.schema.json error_code 枚举，绑定所有实现）。
const (
	CodeMalformedJSON      = "malformed_json"
	CodeInvalidPayload     = "invalid_payload"
	CodeUnknownMethod      = "unknown_method"
	CodeDuplicateRequestID = "duplicate_request_id"
	CodeProjectUnavailable = "project_unavailable"
	CodeHostBusy           = "host_busy"
	CodeOperationFailed    = "operation_failed"
	CodeCancelled          = "cancelled"
	CodeInternalError      = "internal_error"
)

// maxLineBytes 是单行请求的长度上限；超限按 malformed_json 处理（防内存放大）。
const maxLineBytes = 8 << 20

// Request 是客户端请求信封。Payload 为开放式对象（未知字段允许并忽略）。
type Request struct {
	Protocol string
	Kind     string
	ID       string
	Method   string
	Payload  map[string]any
}

// Response 是引擎响应信封。成功可带 payload；失败必带 Error 且不带 payload。
type Response struct {
	Protocol string         `json:"protocol"`
	Kind     string         `json:"kind"`
	ID       string         `json:"id"`
	OK       bool           `json:"ok"`
	Session  string         `json:"session,omitempty"`
	Payload  map[string]any `json:"payload,omitempty"`
	Error    *ResponseError `json:"error,omitempty"`
}

// ResponseError 是 ok:false 响应携带的结构化错误。
type ResponseError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details any    `json:"details,omitempty"`
}

// EventEnvelope 是异步事件信封。
type EventEnvelope struct {
	Protocol  string         `json:"protocol"`
	Kind      string         `json:"kind"`
	Event     string         `json:"event"`
	ProjectID string         `json:"project_id,omitempty"`
	Session   string         `json:"session,omitempty"`
	Sequence  int64          `json:"sequence"`
	Payload   map[string]any `json:"payload"`
}

// successResponse 构造成功响应。
func successResponse(id, session string, payload map[string]any) *Response {
	if payload == nil {
		payload = map[string]any{}
	}
	return &Response{
		Protocol: ProtocolID,
		Kind:     KindResponse,
		ID:       id,
		OK:       true,
		Session:  session,
		Payload:  payload,
	}
}

// errorResponse 构造失败响应（payload 按协议省略）。
func errorResponse(id, session, code, message string, details any) *Response {
	return &Response{
		Protocol: ProtocolID,
		Kind:     KindResponse,
		ID:       id,
		OK:       false,
		Session:  session,
		Error:    &ResponseError{Code: code, Message: message, Details: details},
	}
}

// requestEnvelope 是严格解码用的镜像结构（信封键封闭：未知键拒绝）。
type requestEnvelope struct {
	Protocol string          `json:"protocol"`
	Kind     string          `json:"kind"`
	ID       string          `json:"id"`
	Method   string          `json:"method"`
	Payload  json.RawMessage `json:"payload"`
}

// knownMethods 是 desktop-v1 的 48 个方法名（commands.schema.json 枚举）。
var knownMethods = map[string]struct{}{}

// methodsRequiringPayload 依 schema 声明必填 payload 的方法。
var methodsRequiringPayload = map[string]struct{}{
	"project.create":            {},
	"project.open":              {},
	"run.steer":                 {},
	"run.set_advance_mode":      {},
	"cocreate.start":            {},
	"cocreate.stage":            {},
	"chapter.read":              {},
	"chapter.save":              {},
	"artifacts.read":            {},
	"import.start":              {},
	"simulation.start":          {},
	"simulation.profile_import": {},
	"config.update":             {},
	"config.switch_model":       {},
	"config.set_thinking":       {},
	"config.set_language":       {},
	"config.set_story_language": {},
}

// payloadFieldKind 是 payload 必填字段的类型判别。
type payloadFieldKind int

const (
	fieldString  payloadFieldKind = iota // JSON string
	fieldObject                          // JSON object
	fieldChapter                         // anyOf: string | integer
)

// payloadRequirements 是各方法 payload 内的字段级必填（commands.schema.json
// 各 *_request 的 required 段）。集中在解码层执行 → invalid_payload 响应。
var payloadRequirements = map[string][]struct {
	name string
	kind payloadFieldKind
}{
	"project.create":            {{"path", fieldString}},
	"project.open":              {{"path", fieldString}},
	"run.steer":                 {{"instruction", fieldString}},
	"run.set_advance_mode":      {{"mode", fieldString}},
	"cocreate.start":            {{"message", fieldString}},
	"cocreate.stage":            {{"message", fieldString}},
	"chapter.read":              {{"chapter", fieldChapter}},
	"chapter.save":              {{"chapter", fieldChapter}, {"content", fieldString}},
	"artifacts.read":            {{"kind", fieldString}},
	"import.start":              {{"source_path", fieldString}},
	"simulation.start":          {{"source_path", fieldString}},
	"simulation.profile_import": {{"profile_path", fieldString}},
	"config.update":             {{"values", fieldObject}},
	"config.switch_model":       {{"provider", fieldString}, {"model", fieldString}},
	"config.set_thinking":       {{"level", fieldString}},
	"config.set_language":       {{"language", fieldString}},
	"config.set_story_language": {{"language", fieldString}},
}

// validatePayloadFields 执行字段级必填校验（缺失或类型不符 → invalid_payload）。
func validatePayloadFields(method string, payload map[string]any) *parseError {
	fields, ok := payloadRequirements[method]
	if !ok {
		return nil
	}
	for _, f := range fields {
		v, present := payload[f.name]
		if !present {
			return &parseError{code: CodeInvalidPayload,
				message: fmt.Sprintf("%s is required in payload for %s", f.name, method)}
		}
		switch f.kind {
		case fieldString:
			if _, isStr := v.(string); !isStr {
				return &parseError{code: CodeInvalidPayload, message: f.name + " must be a string"}
			}
		case fieldObject:
			if _, isObj := v.(map[string]any); !isObj {
				return &parseError{code: CodeInvalidPayload, message: f.name + " must be an object"}
			}
		case fieldChapter:
			switch v.(type) {
			case float64, string:
				// anyOf: string | integer（JSON 数字解码为 float64）
			default:
				return &parseError{code: CodeInvalidPayload, message: f.name + " must be a string or integer"}
			}
		}
	}
	return nil
}

func init() {
	for _, m := range []string{
		"engine.ping", "engine.shutdown",
		"project.create", "project.open", "project.close", "project.snapshot",
		"project.resume", "project.replay_events",
		"run.start", "run.continue", "run.steer", "run.abort", "run.pause",
		"run.advance_one_chapter", "run.set_advance_mode", "run.retry",
		"cocreate.start", "cocreate.stage", "cocreate.resume", "cocreate.cancel",
		"chapter.list", "chapter.read", "chapter.save",
		"chapter.revisions.check", "chapter.revisions.sync", "chapter.export",
		"artifacts.read",
		"import.start", "import.resume", "import.cancel",
		"simulation.start", "simulation.resume", "simulation.cancel",
		"simulation.profile_import",
		"config.get", "config.update", "config.providers", "config.models",
		"config.switch_model", "config.thinking_levels", "config.set_thinking",
		"config.set_language", "config.set_story_language",
		"diagnostics.snapshot", "diagnostics.export",
		"usage.snapshot", "logs.replay", "runtime.queue",
	} {
		knownMethods[m] = struct{}{}
	}
}

// knownMethod 报告方法是否在 desktop-v1 目录内。
func knownMethod(method string) bool {
	_, ok := knownMethods[method]
	return ok
}

// parseError 描述一行输入为何无法成为合法请求。
type parseError struct {
	code    string // malformed_json 或 invalid_payload
	message string
}

func (e *parseError) Error() string { return e.message }

// decodeRequest 把一行 NDJSON 严格解码为 Request。
// 返回的 parseError 携带稳定错误码，供调用方决定回响应（有 id）还是事件。
func decodeRequest(line []byte) (*Request, *parseError) {
	// 第一遍：必须是合法 JSON 且是对象。
	var probe any
	if err := json.Unmarshal(line, &probe); err != nil {
		return nil, &parseError{code: CodeMalformedJSON, message: "line is not valid JSON: " + err.Error()}
	}
	if _, ok := probe.(map[string]any); !ok {
		return nil, &parseError{code: CodeMalformedJSON, message: "line is not a JSON object"}
	}

	// 第二遍：严格解码信封键（信封封闭，未知键 = invalid_payload）。
	var env requestEnvelope
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&env); err != nil {
		// 对象但信封不合法：能提取到非空 id 就回响应，否则只能发事件。
		return nil, &parseError{code: CodeInvalidPayload, message: "invalid request envelope: " + err.Error()}
	}

	req := &Request{
		Protocol: env.Protocol,
		Kind:     env.Kind,
		ID:       env.ID,
		Method:   env.Method,
	}
	if req.Protocol != ProtocolID {
		return nil, &parseError{code: CodeInvalidPayload, message: fmt.Sprintf("unsupported protocol %q (expected %q)", env.Protocol, ProtocolID)}
	}
	if req.Kind != KindRequest {
		return nil, &parseError{code: CodeInvalidPayload, message: fmt.Sprintf("unsupported kind %q on engine stdin (expected %q)", env.Kind, KindRequest)}
	}
	if req.ID == "" {
		return nil, &parseError{code: CodeInvalidPayload, message: "request id is required"}
	}
	if !knownMethod(req.Method) {
		return nil, &parseError{code: CodeUnknownMethod, message: fmt.Sprintf("unknown method %q", req.Method)}
	}

	// payload：可省略（默认 {}），但出现时必须是对象。
	if len(env.Payload) > 0 {
		var payload any
		if err := json.Unmarshal(env.Payload, &payload); err != nil || payload == nil {
			return nil, &parseError{code: CodeInvalidPayload, message: "payload must be a JSON object"}
		}
		if _, ok := payload.(map[string]any); !ok {
			return nil, &parseError{code: CodeInvalidPayload, message: "payload must be a JSON object"}
		}
		req.Payload = payload.(map[string]any)
	}
	if req.Payload == nil {
		if _, required := methodsRequiringPayload[req.Method]; required {
			return nil, &parseError{code: CodeInvalidPayload, message: fmt.Sprintf("method %q requires a payload object", req.Method)}
		}
		req.Payload = map[string]any{}
	}
	if perr := validatePayloadFields(req.Method, req.Payload); perr != nil {
		return nil, perr
	}
	return req, nil
}

// peekRequestID 从一行（已确认是 JSON 对象）尽力提取非空字符串 id，
// 供信封校验失败时决定能否回响应。提取失败返回空串。
func peekRequestID(line []byte) string {
	var obj map[string]json.RawMessage
	if json.Unmarshal(line, &obj) != nil {
		return ""
	}
	raw, ok := obj["id"]
	if !ok {
		return ""
	}
	var id string
	if json.Unmarshal(raw, &id) != nil {
		return ""
	}
	return id
}

// decodeResponseLine 把 fixtures 中的响应行解码为 Response（测试/校验用）。
func decodeResponseLine(line []byte) (*Response, error) {
	var resp Response
	if err := json.Unmarshal(line, &resp); err != nil {
		return nil, err
	}
	if resp.Protocol != ProtocolID || resp.Kind != KindResponse || resp.ID == "" {
		return nil, errors.New("not a desktop-v1 response envelope")
	}
	return &resp, nil
}

// decodeEventLine 把 fixtures 中的事件行解码为 EventEnvelope（测试/校验用）。
func decodeEventLine(line []byte) (*EventEnvelope, error) {
	var ev EventEnvelope
	if err := json.Unmarshal(line, &ev); err != nil {
		return nil, err
	}
	if ev.Protocol != ProtocolID || ev.Kind != KindEvent || ev.Event == "" {
		return nil, errors.New("not a desktop-v1 event envelope")
	}
	return &ev, nil
}

// ── payload 取值助手（JSON 数字统一为 float64）──

func payloadString(p map[string]any, key string) string {
	v, ok := p[key]
	if !ok {
		return ""
	}
	s, _ := v.(string)
	return s
}

func payloadBool(p map[string]any, key string) bool {
	v, ok := p[key]
	if !ok {
		return false
	}
	b, _ := v.(bool)
	return b
}

// payloadInt 接受 JSON 整数与整型字符串（chapter 字段 anyOf string|integer）。
func payloadInt(p map[string]any, key string) (int, bool) {
	v, ok := p[key]
	if !ok {
		return 0, false
	}
	switch n := v.(type) {
	case float64:
		if n != float64(int(n)) {
			return 0, false
		}
		return int(n), true
	case string:
		var parsed int
		if _, err := fmt.Sscanf(n, "%d", &parsed); err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

// payloadInt64 读取可为 null 的整数字段；存在且是整数返回值与 true。
func payloadInt64(p map[string]any, key string) (int64, bool, error) {
	v, ok := p[key]
	if !ok || v == nil {
		return 0, false, nil
	}
	f, ok := v.(float64)
	if !ok || f != float64(int64(f)) {
		return 0, true, fmt.Errorf("%s must be an integer", key)
	}
	return int64(f), true, nil
}
