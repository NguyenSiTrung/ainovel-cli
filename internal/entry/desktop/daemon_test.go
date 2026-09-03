// daemon_test.go —— 生命周期、请求关联、事件序、流式边界、错误路由、优雅退出。
package desktop

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/voocel/ainovel-cli/assets"
	"github.com/voocel/ainovel-cli/internal/bootstrap"
	"github.com/voocel/ainovel-cli/internal/host"
)

func TestRunLifecyclePingAndCleanExit(t *testing.T) {
	h := newFakeHost(t)
	out := &lockedBuffer{}
	input := strings.NewReader(
		`{"protocol":"desktop-v1","kind":"request","id":"r1","method":"engine.ping","payload":{}}` + "\n" +
			requestLineObj("r2", "project.open", map[string]any{"path": h.dir}) + "\n" +
			`{"protocol":"desktop-v1","kind":"request","id":"r3","method":"project.close","payload":{}}` + "\n")
	err := Run(Options{
		Stdin:   input,
		Stdout:  out,
		Stderr:  &strings.Builder{},
		Session: "sess-lifecycle",
		NewHost: func(cfg bootstrap.Config, bundle assets.Bundle, dir string) (HostAPI, error) { return h, nil },
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	lines, err := decodeLines(out.lines())
	if err != nil {
		t.Fatalf("stdout 有非 JSON 行: %v", err)
	}
	if len(lines) == 0 || lines[0].raw["event"] != "engine.ready" {
		t.Fatalf("首个输出必须是 engine.ready 事件，得到 %v", lines[0])
	}
	if lines[0].raw["session"] != "sess-lifecycle" {
		t.Fatalf("事件应带 session id")
	}
	var ping, open, closeResp map[string]any
	for _, l := range lines {
		if l.kind != "response" {
			continue
		}
		switch l.raw["id"] {
		case "r1":
			ping = l.raw
		case "r2":
			open = l.raw
		case "r3":
			closeResp = l.raw
		}
	}
	if ping == nil || ping["ok"] != true {
		t.Fatalf("ping 响应缺失或失败: %v", ping)
	}
	if open == nil || open["ok"] != true {
		t.Fatalf("project.open 响应: %v", open)
	}
	if closeResp == nil || closeResp["ok"] != true {
		t.Fatalf("project.close 响应: %v", closeResp)
	}
	last := lines[len(lines)-1]
	if last.raw["event"] != "engine.exited" {
		t.Fatalf("最后一条输出应为 engine.exited，得到 %v", last.raw)
	}
	if h.closeCalls() < 1 {
		t.Fatalf("project.close 已请求，Host.Close 必须被调用")
	}
}

func TestMalformedLineEmitsEventNeverResponse(t *testing.T) {
	d, _ := newTestDaemon(t, newFakeHost(t))
	before := len(d.snapshotHistory())
	d.handleLine([]byte(`{"protocol":"desktop-v1","kind":"request","id":"m1","method":"engine.ping","payload":{"oops"`))
	lines := d.snapshotHistory()
	if len(lines) != before+1 {
		t.Fatalf("malformed 行应恰好产出一条 engine.error 事件，得到 %d 行", len(lines)-before)
	}
	var ev map[string]any
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &ev); err != nil {
		t.Fatal(err)
	}
	if ev["kind"] != "event" || ev["event"] != "engine.error" {
		t.Fatalf("应为 engine.error 事件: %v", ev)
	}
	payload := ev["payload"].(map[string]any)
	if payload["code"] != CodeMalformedJSON {
		t.Fatalf("payload.code 应为 malformed_json: %v", payload)
	}
	if _, has := payload["message"]; !has {
		t.Fatal("engine.error payload 必须含 message（schema 必填）")
	}
}

func TestNonObjectLineIsMalformedEvent(t *testing.T) {
	d, _ := newTestDaemon(t, newFakeHost(t))
	d.handleLine([]byte(`[1, 2, 3]`))
	last := lastLine(t, d)
	if last["event"] != "engine.error" || last["payload"].(map[string]any)["code"] != CodeMalformedJSON {
		t.Fatalf("非对象行应为 malformed_json 事件: %v", last)
	}
}

func TestUnknownMethodAndInvalidPayloadResponses(t *testing.T) {
	d, _ := newTestDaemon(t, newFakeHost(t))
	resp := doRequest(t, d, `{"protocol":"desktop-v1","kind":"request","id":"u1","method":"teleport.now","payload":{}}`)
	if code := mustErrCode(t, resp); code != CodeUnknownMethod {
		t.Fatalf("want unknown_method, got %s", code)
	}
	if resp["id"] != "u1" {
		t.Fatalf("响应必须回显请求 id: %v", resp)
	}
	resp = doRequest(t, d, `{"protocol":"desktop-v1","kind":"request","id":"u2","method":"run.steer","payload":{"instruction":42}}`)
	if code := mustErrCode(t, resp); code != CodeInvalidPayload {
		t.Fatalf("want invalid_payload, got %s", code)
	}
}

func TestRequestCorrelationInOrder(t *testing.T) {
	d, _ := newTestDaemon(t, newFakeHost(t))
	ids := []string{"c-1", "c-2", "c-3"}
	for _, id := range ids {
		resp := doRequest(t, d, `{"protocol":"desktop-v1","kind":"request","id":"`+id+`","method":"engine.ping","payload":{}}`)
		if resp["id"] != id || resp["ok"] != true {
			t.Fatalf("关联失败: %v", resp)
		}
	}
}

func TestDuplicateRequestIDRejectedWhileInFlight(t *testing.T) {
	d, _ := newTestDaemon(t, newFakeHost(t))
	block := make(chan struct{})
	original := d.dispatch["engine.ping"]
	d.dispatch["engine.ping"] = func(req *Request) *Response {
		<-block
		return original(req)
	}
	defer func() { d.dispatch["engine.ping"] = original }()

	done := make(chan map[string]any, 1)
	go func() {
		done <- doRequest(t, d, `{"protocol":"desktop-v1","kind":"request","id":"dup","method":"engine.ping","payload":{}}`)
	}()
	// 等第一个请求真正进入 handler（inFlight 已登记）。
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		d.stateMu.Lock()
		_, inflight := d.inFlight["dup"]
		d.stateMu.Unlock()
		if inflight {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	resp := doRequest(t, d, `{"protocol":"desktop-v1","kind":"request","id":"dup","method":"engine.ping","payload":{}}`)
	if code := mustErrCode(t, resp); code != CodeDuplicateRequestID {
		t.Fatalf("want duplicate_request_id, got %s", code)
	}
	close(block)
	first := <-done
	if first["ok"] != true {
		t.Fatalf("原始请求必须恰好一条成功终态响应: %v", first)
	}
}

func TestEventSequencesStrictlyMonotonicUnderConcurrency(t *testing.T) {
	d, _ := newTestDaemon(t, newFakeHost(t))
	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 25; i++ {
				d.emitEvent("", "notification.info", map[string]any{"message": "x"})
			}
		}()
	}
	wg.Wait()
	var lastSeq float64
	count := 0
	for _, l := range d.snapshotHistory() {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatal(err)
		}
		if m["kind"] != "event" {
			continue
		}
		seq := m["sequence"].(float64)
		if seq <= lastSeq {
			t.Fatalf("sequence 必须严格递增: %v after %v", seq, lastSeq)
		}
		if seq < 1 {
			t.Fatalf("sequence 应 >= 1")
		}
		lastSeq = seq
		count++
	}
	if count != 200 {
		t.Fatalf("应有 200 条事件，得到 %d", count)
	}
}

func TestStreamDeltasAndClearBoundary(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	h.stream <- "The harbor lights "
	h.stream <- "drowned in fog."
	h.stream <- host.StreamClearSentinel
	h.stream <- "Next chapter."

	deadline := time.Now().Add(2 * time.Second)
	var deltas, clears int
	for time.Now().Before(deadline) && (deltas < 3 || clears < 1) {
		deltas, clears = 0, 0
		for _, l := range d.snapshotHistory() {
			var m map[string]any
			if json.Unmarshal([]byte(l), &m) != nil {
				t.Fatal("stdout 出现非协议行")
			}
			switch m["event"] {
			case "stream.delta":
				deltas++
				if _, has := m["payload"].(map[string]any)["text"]; !has {
					t.Fatal("stream.delta 必须带 text（schema 必填）")
				}
			case "stream.clear":
				clears++
			}
		}
		time.Sleep(3 * time.Millisecond)
	}
	if deltas != 3 || clears != 1 {
		t.Fatalf("want 3 deltas + 1 clear, got %d/%d", deltas, clears)
	}
}

func TestHostEventBridgingByCategory(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	h.events <- host.Event{ID: "d1", Category: "DISPATCH", Agent: "writer", Summary: "writer(第1章)", Level: "info"}
	h.events <- host.Event{ID: "t1", Time: time.Now(), FinishedAt: time.Now(), Category: "TOOL", Agent: "writer",
		Summary: "commit_chapter(第7章)", Level: "info"}
	h.events <- host.Event{Category: "SYSTEM", Summary: "写作规则已更新", Level: "info"}
	h.events <- host.Event{Category: "SYSTEM", Summary: "预算接近上限", Level: "warn"}

	awaitEvent(t, d, "run.step_changed")
	awaitEvent(t, d, "chapter.updated")
	awaitEvent(t, d, "run.progress")
	awaitEvent(t, d, "usage.updated")
	awaitEvent(t, d, "notification.warning")

	var stepChanged, chapterUpdated bool
	for _, l := range d.snapshotHistory() {
		var m map[string]any
		if json.Unmarshal([]byte(l), &m) != nil {
			continue
		}
		switch m["event"] {
		case "run.step_changed":
			stepChanged = true
			if m["payload"].(map[string]any)["step"] != "writer" {
				t.Fatalf("step 应为 agent 名: %v", m)
			}
		case "chapter.updated":
			chapterUpdated = true
			if m["payload"].(map[string]any)["chapter"] != float64(7) {
				t.Fatalf("chapter.updated 章号错误: %v", m)
			}
			if m["project_id"] != "project-test" {
				t.Fatalf("项目事件应带 project_id: %v", m)
			}
		}
	}
	if !stepChanged || !chapterUpdated {
		t.Fatalf("桥接缺失: step=%v chapter=%v", stepChanged, chapterUpdated)
	}
}

func TestRunEndClassification(t *testing.T) {
	cases := []struct {
		name     string
		snapshot host.UISnapshot
		prep     func(d *Daemon)
		want     string
	}{
		{
			name:     "completed",
			snapshot: host.UISnapshot{RuntimeState: "completed", Phase: "complete", CompletedCount: 12},
			prep:     func(d *Daemon) { d.stateMu.Lock(); d.run = runState{active: true, runID: "r"}; d.stateMu.Unlock() },
			want:     "run.completed",
		},
		{
			name:     "failed after error event",
			snapshot: host.UISnapshot{RuntimeState: "idle"},
			prep: func(d *Daemon) {
				d.stateMu.Lock()
				d.run = runState{active: true, runID: "r", lastError: "provider unavailable after retries"}
				d.stateMu.Unlock()
			},
			want: "run.failed",
		},
		{
			name:     "aborted by user",
			snapshot: host.UISnapshot{RuntimeState: "paused"},
			prep: func(d *Daemon) {
				d.stateMu.Lock()
				d.run = runState{active: true, runID: "r", abortReason: "user requested stop"}
				d.stateMu.Unlock()
			},
			want: "run.aborted",
		},
		{
			name:     "paused at gate",
			snapshot: host.UISnapshot{RuntimeState: "paused", HasAdvanceHold: true},
			prep: func(d *Daemon) {
				d.stateMu.Lock()
				d.run = runState{active: true, runID: "r"}
				d.stateMu.Unlock()
			},
			want: "run.paused",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newFakeHost(t)
			h.setSnapshot(tc.snapshot)
			d, _ := newTestDaemon(t, h)
			openFakeProject(d, h)
			tc.prep(d)
			h.done <- struct{}{}
			ev := awaitEvent(t, d, tc.want)
			if ev["payload"] == nil {
				t.Fatal("terminal 事件应带 payload")
			}
			if tc.want == "run.failed" {
				payload := ev["payload"].(map[string]any)
				if payload["message"] != "provider unavailable after retries" {
					t.Fatalf("run.failed 应带 message: %v", payload)
				}
			}
			// 终态后 run 意图复位。
			d.stateMu.Lock()
			active := d.run.active
			d.stateMu.Unlock()
			if active {
				t.Fatal("终态分类后 run 意图应复位")
			}
		})
	}
}

func TestProjectOpenCloseAndUnavailable(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)

	// 未打开项目：任意项目级命令 → project_unavailable。
	resp := doRequest(t, d, `{"protocol":"desktop-v1","kind":"request","id":"p0","method":"project.snapshot","payload":{}}`)
	if code := mustErrCode(t, resp); code != CodeProjectUnavailable {
		t.Fatalf("want project_unavailable, got %s", code)
	}
	resp = doRequest(t, d, `{"protocol":"desktop-v1","kind":"request","id":"p0b","method":"project.close","payload":{}}`)
	if code := mustErrCode(t, resp); code != CodeProjectUnavailable {
		t.Fatalf("project.close 无项目也应 project_unavailable, got %s", code)
	}

	resp = doRequest(t, d, requestLineObj("p1", "project.open", map[string]any{"path": h.dir}))
	if resp["ok"] != true {
		t.Fatalf("project.open 失败: %v", resp)
	}
	pid1 := resp["payload"].(map[string]any)["project_id"].(string)
	if pid1 == "" {
		t.Fatal("project.open 应返回 project_id")
	}

	// 同路径幂等。
	resp = doRequest(t, d, requestLineObj("p2", "project.open", map[string]any{"path": h.dir}))
	if resp["ok"] != true || resp["payload"].(map[string]any)["project_id"] != pid1 {
		t.Fatalf("幂等打开失败: %v", resp)
	}
	if h.closeCalls() != 0 {
		t.Fatalf("同路径重复打开不应重建 Host")
	}

	resp = doRequest(t, d, `{"protocol":"desktop-v1","kind":"request","id":"p3","method":"project.close","payload":{}}`)
	if resp["ok"] != true {
		t.Fatalf("project.close 失败: %v", resp)
	}
	if h.closeCalls() != 1 {
		t.Fatalf("Host.Close 应被调用一次, got %d", h.closeCalls())
	}
}

func TestGracefulShutdownStopsAcceptingRequests(t *testing.T) {
	h := newFakeHost(t)
	d, out := newTestDaemon(t, h)
	openFakeProject(d, h)

	resp := doRequest(t, d, `{"protocol":"desktop-v1","kind":"request","id":"s1","method":"engine.shutdown","payload":{"reason":"app closing"}}`)
	if resp["ok"] != true {
		t.Fatalf("shutdown 应先回 ok:true: %v", resp)
	}
	if !d.isShuttingDown() {
		t.Fatal("shutdown 标志未置位")
	}
	before := len(out.lines())
	d.handleLine([]byte(`{"protocol":"desktop-v1","kind":"request","id":"s2","method":"engine.ping","payload":{}}`))
	if len(out.lines()) != before {
		t.Fatal("shutdown 后不应再接受请求")
	}
	d.finalize(nil)
	lines := out.lines()
	var last map[string]any
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &last); err != nil {
		t.Fatal(err)
	}
	if last["event"] != "engine.exited" {
		t.Fatalf("finalize 应发出 engine.exited: %v", last)
	}
	payload := last["payload"].(map[string]any)
	if payload["reason"] != "app closing" {
		t.Fatalf("engine.exited 应带 reason: %v", payload)
	}
	if payload["exit_code"] != float64(0) {
		t.Fatalf("优雅退出 exit_code=0: %v", payload)
	}
	if h.closeCalls() != 1 {
		t.Fatalf("退出前应关闭 Host, got %d", h.closeCalls())
	}
}

func TestStdoutCarriesOnlyProtocolLines(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)
	d.handleLine([]byte(`garbage`))
	d.handleLine([]byte(`{"protocol":"desktop-v1","kind":"request","id":"x1","method":"engine.ping","payload":{}}`))
	d.handleLine([]byte(`{"protocol":"desktop-v1","kind":"request","id":"x2","method":"project.snapshot","payload":{}}`))
	h.events <- host.Event{Category: "SYSTEM", Summary: "some event", Level: "info"}
	awaitEvent(t, d, "notification.info")
	for _, l := range d.snapshotHistory() {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("stdout 出现非协议行: %q", l)
		}
		if m["protocol"] != ProtocolID {
			t.Fatalf("protocol 字段必须为 desktop-v1: %q", l)
		}
		switch m["kind"] {
		case "response", "event":
		default:
			t.Fatalf("stdout 只允许 response/event: %q", l)
		}
	}
}

func TestReplayEventsUsesOriginalSequences(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)
	d.emitEvent("p", "notification.info", map[string]any{"message": "a"})
	d.emitEvent("p", "notification.info", map[string]any{"message": "b"})
	d.emitEvent("p", "notification.info", map[string]any{"message": "c"})

	resp := doRequest(t, d, `{"protocol":"desktop-v1","kind":"request","id":"rp","method":"project.replay_events","payload":{"after_sequence":1}}`)
	if resp["ok"] != true {
		t.Fatalf("replay 失败: %v", resp)
	}
	// 输出中 sequence>1 的事件应被重放（保留原序号）且恰好各一次。
	seen := map[float64]int{}
	for _, l := range d.snapshotHistory() {
		var m map[string]any
		if json.Unmarshal([]byte(l), &m) != nil {
			continue
		}
		if m["kind"] == "event" && m["event"] == "notification.info" {
			seen[m["sequence"].(float64)]++
		}
	}
	// seq 2、3 原始各 1 次 + 重放各 1 次 = 2；seq 1 只有原始 1 次。
	if seen[1] != 1 || seen[2] != 2 || seen[3] != 2 {
		t.Fatalf("重放应保留原 sequence 且可重复投递: %v", seen)
	}
}

// TestPanicHandlerStillAnswersRequest —— handler panic 时 recover 必须在
// 命名返回值上兜底 internal_error：恰好一条终态响应，请求绝不悬挂（README §3）。
func TestPanicHandlerStillAnswersRequest(t *testing.T) {
	d, _ := newTestDaemon(t, newFakeHost(t))
	original := d.dispatch["engine.ping"]
	d.dispatch["engine.ping"] = func(req *Request) *Response {
		panic("boom")
	}
	defer func() { d.dispatch["engine.ping"] = original }()

	before := len(d.snapshotHistory())
	d.handleLine([]byte(`{"protocol":"desktop-v1","kind":"request","id":"p9","method":"engine.ping","payload":{}}`))
	added := d.snapshotHistory()[before:]
	if len(added) != 1 {
		t.Fatalf("panic 后应恰好产出一条输出，得到 %d: %v", len(added), added)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(added[0]), &m); err != nil {
		t.Fatal(err)
	}
	if m["kind"] != "response" || m["id"] != "p9" || m["ok"] != false {
		t.Fatalf("必须是 p9 的失败响应: %v", m)
	}
	errObj := m["error"].(map[string]any)
	if errObj["code"] != CodeInternalError {
		t.Fatalf("panic 兜底应为 internal_error: %v", errObj)
	}

	// panic 请求不得残留在 inFlight。
	d.stateMu.Lock()
	_, leftover := d.inFlight["p9"]
	d.stateMu.Unlock()
	if leftover {
		t.Fatal("panic 后 inFlight 应已清理")
	}

	// daemon 仍存活：恢复 handler 后，后续请求正常应答。
	d.dispatch["engine.ping"] = original
	resp := doRequest(t, d, `{"protocol":"desktop-v1","kind":"request","id":"p10","method":"engine.ping","payload":{}}`)
	if resp["ok"] != true {
		t.Fatalf("panic 后 daemon 应继续服务: %v", resp)
	}
}

func TestEmptyLineSkipped(t *testing.T) {
	d, _ := newTestDaemon(t, newFakeHost(t))
	before := len(d.snapshotHistory())
	d.handleLine([]byte(`   `))
	d.handleLine([]byte(``))
	if len(d.snapshotHistory()) != before {
		t.Fatal("空行不应产生任何输出")
	}
}

func lastLine(t *testing.T, d *Daemon) map[string]any {
	t.Helper()
	lines := d.snapshotHistory()
	if len(lines) == 0 {
		t.Fatal("无输出")
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &m); err != nil {
		t.Fatal(err)
	}
	return m
}
