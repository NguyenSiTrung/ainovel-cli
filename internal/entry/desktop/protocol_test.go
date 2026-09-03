// protocol_test.go —— 信封解码/编码与错误路由的单元测试。
package desktop

import (
	"testing"
)

func TestDecodeValidRequestEnvelope(t *testing.T) {
	line := []byte(`{"protocol":"desktop-v1","kind":"request","id":"req-8f3a","method":"project.open","payload":{"path":"/Users/demo/Novels/First-Novel"}}`)
	req, perr := decodeRequest(line)
	if perr != nil {
		t.Fatalf("valid request rejected: %v", perr.message)
	}
	if req.ID != "req-8f3a" || req.Method != "project.open" {
		t.Fatalf("bad decode: %+v", req)
	}
	if req.Payload["path"] != "/Users/demo/Novels/First-Novel" {
		t.Fatalf("payload lost: %+v", req.Payload)
	}
}

func TestDecodeDefaultsPayloadToEmptyObject(t *testing.T) {
	req, perr := decodeRequest([]byte(`{"protocol":"desktop-v1","kind":"request","id":"a","method":"engine.ping"}`))
	if perr != nil {
		t.Fatalf("unexpected error: %v", perr.message)
	}
	if req.Payload == nil || len(req.Payload) != 0 {
		t.Fatalf("payload should default to empty object, got %v", req.Payload)
	}
}

func TestDecodeMalformedLines(t *testing.T) {
	cases := []string{
		`{"protocol":"desktop-v1","kind":"request","id":"req-mal-1","method":"engine.ping","payload":{"oops"`,
		`[[[ not json at all`,
		``,
		`   `,
		`[1, 2, 3]`,
		`"just a string"`,
		`42`,
		`null`,
	}
	for _, line := range cases {
		_, perr := decodeRequest([]byte(line))
		if perr == nil {
			t.Fatalf("line %q should be rejected", line)
		}
		if perr.code != CodeMalformedJSON {
			t.Fatalf("line %q: want malformed_json, got %s (%s)", line, perr.code, perr.message)
		}
	}
}

func TestDecodeInvalidPayloadEnvelopes(t *testing.T) {
	cases := []struct {
		line string
		code string
	}{
		{`{"protocol":"desktop-v2","kind":"request","id":"x","method":"engine.ping","payload":{}}`, CodeInvalidPayload},
		{`{"protocol":"desktop-v1","kind":"response","id":"x","ok":true}`, CodeInvalidPayload},
		{`{"protocol":"desktop-v1","kind":"event","event":"run.started","sequence":1}`, CodeInvalidPayload},
		{`{"protocol":"desktop-v1","kind":"request","method":"engine.ping"}`, CodeInvalidPayload},         // 缺 id
		{`{"protocol":"desktop-v1","kind":"request","id":"","method":"engine.ping"}`, CodeInvalidPayload}, // 空 id
		{`{"protocol":"desktop-v1","kind":"request","id":"x","method":"teleport.now","payload":{}}`, CodeUnknownMethod},
		{`{"protocol":"desktop-v1","kind":"request","id":"x","method":"engine.ping","extra":1}`, CodeInvalidPayload}, // 信封键封闭
		{`{"protocol":"desktop-v1","kind":"request","id":"x","method":"engine.ping","payload":[1,2]}`, CodeInvalidPayload},
		{`{"protocol":"desktop-v1","kind":"request","id":"x","method":"engine.ping","payload":"str"}`, CodeInvalidPayload},
		{`{"protocol":"desktop-v1","kind":"request","id":"x","method":"run.steer"}`, CodeInvalidPayload},                            // 需 payload
		{`{"protocol":"desktop-v1","kind":"request","id":"x","method":"project.open","payload":{}}`, CodeInvalidPayload},            // 需 path
		{`{"protocol":"desktop-v1","kind":"request","id":"x","method":"chapter.save","payload":{"chapter":3}}`, CodeInvalidPayload}, // 需 content
		{`{"protocol":"desktop-v1","kind":"request","id":"x","method":"config.update","payload":{"values":"nope"}}`, CodeInvalidPayload},
		{`{"protocol":"desktop-v1","kind":"request","id":"x","payload":{}}`, CodeUnknownMethod}, // 缺 method → 空方法名不在目录
	}
	for _, tc := range cases {
		_, perr := decodeRequest([]byte(tc.line))
		if perr == nil {
			t.Fatalf("line %q should be rejected", tc.line)
		}
		if perr.code != tc.code {
			t.Fatalf("line %q: want %s, got %s (%s)", tc.line, tc.code, perr.code, perr.message)
		}
	}
}

func TestPeekRequestID(t *testing.T) {
	if got := peekRequestID([]byte(`{"id":"req-1","kind":"request"}`)); got != "req-1" {
		t.Fatalf("want req-1, got %q", got)
	}
	if got := peekRequestID([]byte(`{"kind":"request"}`)); got != "" {
		t.Fatalf("want empty, got %q", got)
	}
	if got := peekRequestID([]byte(`{"id":42}`)); got != "" {
		t.Fatalf("non-string id should yield empty, got %q", got)
	}
	if got := peekRequestID([]byte(`not json`)); got != "" {
		t.Fatalf("garbage should yield empty, got %q", got)
	}
}

func TestPayloadHelpers(t *testing.T) {
	p := map[string]any{
		"chapter":    float64(3),
		"chapterStr": "12",
		"flag":       true,
		"name":       "demo",
		"after":      float64(481),
	}
	if n, ok := payloadInt(p, "chapter"); !ok || n != 3 {
		t.Fatalf("int chapter: %d %v", n, ok)
	}
	if n, ok := payloadInt(p, "chapterStr"); !ok || n != 12 {
		t.Fatalf("string chapter: %d %v", n, ok)
	}
	if _, ok := payloadInt(p, "name"); ok {
		t.Fatal("string name should not parse as int")
	}
	if !payloadBool(p, "flag") {
		t.Fatal("flag should be true")
	}
	if payloadString(p, "name") != "demo" {
		t.Fatal("name mismatch")
	}
	if v, has, err := payloadInt64(p, "after"); err != nil || !has || v != 481 {
		t.Fatalf("int64 after: %d %v %v", v, has, err)
	}
	if _, has, _ := payloadInt64(p, "missing"); has {
		t.Fatal("missing key should report !has")
	}
}

func TestKnownMethodsCatalog(t *testing.T) {
	if len(knownMethods) != 49 {
		t.Fatalf("method catalog must have 49 entries, got %d", len(knownMethods))
	}
	for _, m := range []string{"engine.ping", "engine.shutdown", "project.replay_events", "config.set_story_language", "runtime.queue", "simulation.profile_import"} {
		if !knownMethod(m) {
			t.Fatalf("method %q missing from catalog", m)
		}
	}
}

func TestSuccessResponseShape(t *testing.T) {
	resp := successResponse("r1", "s1", nil)
	if !resp.OK || resp.Error != nil || resp.ID != "r1" || resp.Session != "s1" {
		t.Fatalf("bad success response: %+v", resp)
	}
	if resp.Payload == nil {
		t.Fatal("success payload should never be nil (schema: object, 默认 {})")
	}
	err := errorResponse("r2", "s1", CodeHostBusy, "busy", map[string]any{"x": 1})
	if err.OK || err.Payload != nil || err.Error.Code != CodeHostBusy {
		t.Fatalf("bad error response: %+v", err)
	}
}
