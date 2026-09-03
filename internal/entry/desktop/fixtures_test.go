// fixtures_test.go —— Task 1 共享 fixtures 的 Go 侧兼容性：
// valid-* 每行必须能解码进本包类型；invalid-* 每行必须产出结构化错误
// （engine.error 事件或 ok:false 响应），绝不 ok:true。
package desktop

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const fixturesDir = "../../../protocols/desktop-v1/fixtures"

func fixtureLines(t *testing.T, name string) []string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(fixturesDir, name))
	if err != nil {
		t.Fatalf("读 fixture %s: %v", name, err)
	}
	var lines []string
	for _, l := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(l) == "" {
			continue
		}
		lines = append(lines, l)
	}
	return lines
}

// valid 请求 fixtures：每一行都必须成功解码为 Request。
func TestFixturesValidRequestsDecode(t *testing.T) {
	for _, name := range []string{"valid-request.jsonl", "valid-requests-catalog.jsonl"} {
		lines := fixtureLines(t, name)
		if len(lines) == 0 {
			t.Fatalf("%s 为空", name)
		}
		for i, l := range lines {
			req, perr := decodeRequest([]byte(l))
			if perr != nil {
				t.Fatalf("%s:%d 应被接受，被拒: %s (%s)", name, i+1, perr.code, perr.message)
			}
			if req.ID == "" || req.Method == "" {
				t.Fatalf("%s:%d 解码缺字段", name, i+1)
			}
		}
	}
	// 目录 fixture 必须覆盖全部 48 个方法。
	lines := fixtureLines(t, "valid-requests-catalog.jsonl")
	if len(lines) != len(knownMethods) {
		t.Fatalf("请求目录应 %d 行，得到 %d", len(knownMethods), len(lines))
	}
}

// valid 响应 fixtures：每一行都必须解码为 Response。
func TestFixturesValidResponsesDecode(t *testing.T) {
	for _, name := range []string{"valid-response-success.jsonl", "valid-response-error.jsonl"} {
		for i, l := range fixtureLines(t, name) {
			resp, err := decodeResponseLine([]byte(l))
			if err != nil {
				t.Fatalf("%s:%d 应被接受: %v", name, i+1, err)
			}
			if !resp.OK && resp.Error == nil {
				t.Fatalf("%s:%d 失败响应必须带 error", name, i+1)
			}
			if resp.OK && resp.Error != nil {
				t.Fatalf("%s:%d 成功响应不得带 error", name, i+1)
			}
		}
	}
}

// valid 事件 fixtures：每一行都必须解码为 EventEnvelope（含 sequence）。
func TestFixturesValidEventsDecode(t *testing.T) {
	for _, name := range []string{
		"valid-events-catalog.jsonl",
		"valid-events-stream-lifecycle.jsonl",
		"valid-events-duplicate-sequence-replay.jsonl",
		"valid-events-sidecar-recovery.jsonl",
	} {
		for i, l := range fixtureLines(t, name) {
			ev, err := decodeEventLine([]byte(l))
			if err != nil {
				t.Fatalf("%s:%d 应被接受: %v", name, i+1, err)
			}
			if ev.Sequence < 0 {
				t.Fatalf("%s:%d sequence 应 >= 0", name, i+1)
			}
		}
	}
	// 事件目录必须覆盖全部 26 个事件名。
	lines := fixtureLines(t, "valid-events-catalog.jsonl")
	names := map[string]int{}
	for _, l := range lines {
		ev, err := decodeEventLine([]byte(l))
		if err != nil {
			t.Fatal(err)
		}
		names[ev.Event]++
	}
	if len(names) != 26 {
		t.Fatalf("事件目录应覆盖 26 个事件名，得到 %d", len(names))
	}
}

// 事件目录里出现过的 payload 必填字段，本包发射路径也必须携带
// （engine.status_changed→status、run.step_changed→step、run.failed→message、
// stream.delta→text、checkpoint/artifact/chapter/outline 的事件由桥接层产出）。
func TestFixturesCatalogRequiredFieldsEmittedByDaemon(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	p := openFakeProject(d, h)

	d.emitEvent(p.id, "engine.status_changed", map[string]any{"status": "idle"})
	d.emitEvent(p.id, "run.step_changed", map[string]any{"step": "writer"})
	d.emitEvent(p.id, "run.failed", map[string]any{"message": "provider down"})
	d.emitEvent(p.id, "run.progress", map[string]any{"completed": 1, "total": 2})
	d.emitEvent(p.id, "stream.delta", map[string]any{"text": "hi"})
	d.emitEvent(p.id, "stream.clear", map[string]any{})
	d.emitEvent(p.id, "checkpoint.created", map[string]any{"checkpoint_id": "ckpt-1"})
	d.emitEvent(p.id, "artifact.updated", map[string]any{"artifact": "outline"})
	d.emitEvent(p.id, "chapter.updated", map[string]any{"chapter": 3})
	d.emitEvent(p.id, "usage.updated", map[string]any{})
	d.emitEvent(p.id, "cocreate.progress", map[string]any{"stage": "reply"})
	d.emitEvent(p.id, "import.progress", map[string]any{})
	d.emitEvent(p.id, "simulation.progress", map[string]any{})
	d.emitEvent(p.id, "diagnostics.completed", map[string]any{})
	d.emitEvent(p.id, "notification.info", map[string]any{"message": "saved"})
	d.emitEvent(p.id, "notification.warning", map[string]any{"message": "budget"})
	d.emitEvent(p.id, "notification.error", map[string]any{"message": "export failed"})

	for _, l := range d.snapshotHistory() {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("非 JSON 输出: %q", l)
		}
		if m["kind"] != "event" {
			continue
		}
		name := m["event"].(string)
		payload, _ := m["payload"].(map[string]any)
		required := map[string][]string{
			"engine.status_changed": {"status"},
			"run.step_changed":      {"step"},
			"run.failed":            {"message"},
			"stream.delta":          {"text"},
			"checkpoint.created":    {"checkpoint_id"},
			"artifact.updated":      {"artifact"},
			"chapter.updated":       {"chapter"},
			"cocreate.progress":     {"stage"},
			"notification.info":     {"message"},
			"notification.warning":  {"message"},
			"notification.error":    {"message"},
		}
		for _, field := range required[name] {
			if _, has := payload[field]; !has {
				t.Fatalf("事件 %s 缺 schema 必填字段 %s: %v", name, field, m)
			}
		}
	}
}

// invalid fixtures：逐行喂给 daemon —— 必须产出结构化错误
// （engine.error 事件或 ok:false 响应），任何一行都不得 ok:true。
func TestFixturesInvalidLinesProduceStructuredErrors(t *testing.T) {
	for _, name := range []string{"invalid-malformed-line.jsonl", "invalid-schema-violations.jsonl"} {
		for i, l := range fixtureLines(t, name) {
			h := newFakeHost(t)
			d, _ := newTestDaemon(t, h)
			before := len(d.snapshotHistory())
			d.handleLine([]byte(l))
			added := d.snapshotHistory()[before:]
			if len(added) == 0 {
				t.Fatalf("%s:%d 未产出任何结构化错误: %q", name, i+1, l)
			}
			for _, out := range added {
				var m map[string]any
				if err := json.Unmarshal([]byte(out), &m); err != nil {
					t.Fatalf("%s:%d 输出非 JSON: %q", name, i+1, out)
				}
				switch m["kind"] {
				case "event":
					if m["event"] != "engine.error" {
						t.Fatalf("%s:%d 只应产出 engine.error 事件: %v", name, i+1, m)
					}
					payload, _ := m["payload"].(map[string]any)
					if payload["message"] == nil {
						t.Fatalf("%s:%d engine.error 缺 message: %v", name, i+1, m)
					}
				case "response":
					if m["ok"] == true {
						t.Fatalf("%s:%d 非法行绝不能得到 ok:true: %v", name, i+1, m)
					}
					errObj, _ := m["error"].(map[string]any)
					if errObj == nil || errObj["code"] == nil || errObj["message"] == nil {
						t.Fatalf("%s:%d 错误响应缺 code/message: %v", name, i+1, m)
					}
				default:
					t.Fatalf("%s:%d 非法行只应产出错误响应或 engine.error: %v", name, i+1, m)
				}
			}
		}
	}
}
