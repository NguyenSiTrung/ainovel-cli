// dispatch_test.go —— 各方法 handler 的行为测试（假 Host + 临时目录 store）。
package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/voocel/ainovel-cli/internal/domain"
	"github.com/voocel/ainovel-cli/internal/host"
	"github.com/voocel/ainovel-cli/internal/host/exp"
	"github.com/voocel/ainovel-cli/internal/host/imp"
	"github.com/voocel/ainovel-cli/internal/host/sim"
	"github.com/voocel/ainovel-cli/internal/revision"
	"github.com/voocel/ainovel-cli/internal/store"
)

func requestLine(id, method, payload string) string {
	return `{"protocol":"desktop-v1","kind":"request","id":"` + id + `","method":"` + method + `","payload":` + payload + `}`
}

// ── run ──

func TestRunStartValidationAndAcceptance(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)

	// 无项目。
	resp := doRequest(t, d, requestLine("rs0", "run.start", `{}`))
	if code := mustErrCode(t, resp); code != CodeProjectUnavailable {
		t.Fatalf("want project_unavailable, got %s", code)
	}
	openFakeProject(d, h)

	// 空 goal：引擎无从启动（引擎要求非空需求）。
	resp = doRequest(t, d, requestLine("rs1", "run.start", `{}`))
	if code := mustErrCode(t, resp); code != CodeInvalidPayload {
		t.Fatalf("want invalid_payload for empty goal, got %s", code)
	}

	// 已在运行 → host_busy。
	h.setSnapshot(host.UISnapshot{RuntimeState: "running", IsRunning: true})
	resp = doRequest(t, d, requestLine("rs2", "run.start", `{"goal":"写一部悬疑小说"}`))
	if code := mustErrCode(t, resp); code != CodeHostBusy {
		t.Fatalf("want host_busy, got %s", code)
	}

	// 正常路径：接受响应 + 异步 run.started。
	h.setSnapshot(host.UISnapshot{RuntimeState: "idle"})
	var gotPrompt string
	h.startPreparedFn = func(p string) error { gotPrompt = p; return nil }
	resp = doRequest(t, d, requestLine("rs3", "run.start", `{"goal":"写一部悬疑小说"}`))
	if resp["ok"] != true {
		t.Fatalf("run.start 应被接受: %v", resp)
	}
	if resp["payload"].(map[string]any)["accepted"] != true {
		t.Fatalf("接受响应应带 accepted: %v", resp)
	}
	awaitEvent(t, d, "run.started")
	if !strings.Contains(gotPrompt, "写一部悬疑小说") {
		t.Fatalf("需求应传给 StartPrepared: %q", gotPrompt)
	}
}

func TestRunStartAsyncFailureEmitsRunFailed(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)
	h.startPreparedFn = func(string) error { return errors.New("启动裁定失败: provider down") }
	resp := doRequest(t, d, requestLine("rf1", "run.start", `{"goal":"a novel"}`))
	if resp["ok"] != true {
		t.Fatalf("接受响应应成功（异步失败走事件）: %v", resp)
	}
	runID := resp["payload"].(map[string]any)["run_id"].(string)
	ev := awaitEventWhere(t, d, "run.failed", func(pl map[string]any) bool { return pl["run_id"] == runID })
	payload := ev["payload"].(map[string]any)
	if payload["message"] == "" {
		t.Fatal("run.failed 必须带 message")
	}
	// 失败者是当前意图持有者：意图必须被复位（终态收口）。
	d.stateMu.Lock()
	stillActive := d.run.active
	d.stateMu.Unlock()
	if stillActive {
		t.Fatal("持有意图的 run 失败后意图应复位")
	}
}

func TestRunSteerAbortPauseModes(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	steered := ""
	h.steerFn = func(text string) error { steered = text; return nil }
	resp := doRequest(t, d, requestLine("st1", "run.steer", `{"instruction":"放慢节奏"}`))
	if resp["ok"] != true || steered != "放慢节奏" {
		t.Fatalf("steer 失败: %v steered=%q", resp, steered)
	}

	h.steerFn = func(string) error { return errors.New("创作引擎运行中或正在停止，请稍候再干预") }
	resp = doRequest(t, d, requestLine("st2", "run.steer", `{"instruction":"x"}`))
	if code := mustErrCode(t, resp); code != CodeHostBusy {
		t.Fatalf("引擎互斥文案应映射 host_busy, got %s", code)
	}

	h.abortFn = func() bool { return true }
	resp = doRequest(t, d, requestLine("ab1", "run.abort", `{"reason":"user requested stop"}`))
	if resp["payload"].(map[string]any)["stopped"] != true {
		t.Fatalf("abort: %v", resp)
	}
	resp = doRequest(t, d, requestLine("pa1", "run.pause", `{}`))
	if resp["payload"].(map[string]any)["paused"] != true {
		t.Fatalf("pause: %v", resp)
	}
}

func TestRunSetAdvanceModeAndAdvance(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	var gotMode domain.ChapterAdvanceMode
	h.setAdvanceModeFn = func(m domain.ChapterAdvanceMode) error { gotMode = m; return nil }
	resp := doRequest(t, d, requestLine("am1", "run.set_advance_mode", `{"mode":"manual"}`))
	if resp["ok"] != true || gotMode != domain.ChapterAdvanceReview {
		t.Fatalf("manual 应映射 review: mode=%v resp=%v", gotMode, resp)
	}
	resp = doRequest(t, d, requestLine("am2", "run.set_advance_mode", `{"mode":"auto"}`))
	if resp["ok"] != true || gotMode != domain.ChapterAdvanceAuto {
		t.Fatalf("auto 映射失败: %v", resp)
	}
	resp = doRequest(t, d, requestLine("am3", "run.set_advance_mode", `{"mode":"warp"}`))
	if code := mustErrCode(t, resp); code != CodeInvalidPayload {
		t.Fatalf("未知模式应 invalid_payload, got %s", code)
	}

	h.advanceOneFn = func() error { return errors.New("/next 仅用于逐章验收模式") }
	resp = doRequest(t, d, requestLine("nx1", "run.advance_one_chapter", `{}`))
	if resp["ok"] != false {
		t.Fatalf("advance 失败应回错误: %v", resp)
	}
}

func TestRunContinueAndRetryMapToResume(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	resumeCalls := 0
	h.resumeFn = func() (string, error) { resumeCalls++; return "checkpoint: ch3", nil }
	for _, method := range []string{"run.continue", "run.retry"} {
		resp := doRequest(t, d, requestLine("rc", method, `{}`))
		if resp["ok"] != true {
			t.Fatalf("%s: %v", method, resp)
		}
		if resp["payload"].(map[string]any)["resumed"] != true {
			t.Fatalf("%s 应报告 resumed: %v", method, resp)
		}
	}
	if resumeCalls != 2 {
		t.Fatalf("run.continue/run.retry 都应调用 Resume, got %d", resumeCalls)
	}

	// 无可恢复会话 → operation_failed。
	h.resumeFn = func() (string, error) { return "", nil }
	resp := doRequest(t, d, requestLine("rc2", "run.retry", `{}`))
	if code := mustErrCode(t, resp); code != CodeOperationFailed {
		t.Fatalf("want operation_failed, got %s", code)
	}
}

func TestRunContinueWithInstruction(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	// 1. 运行中 → host_busy
	h.setSnapshot(host.UISnapshot{RuntimeState: "running", IsRunning: true})
	resp := doRequest(t, d, requestLine("ci0", "run.continue", `{"instruction":"加快节奏"}`))
	if code := mustErrCode(t, resp); code != CodeHostBusy {
		t.Fatalf("want host_busy, got %s", code)
	}

	// 2. 停机态带 instruction → 调用 Continue(instruction)
	h.setSnapshot(host.UISnapshot{RuntimeState: "idle", IsRunning: false})
	var continuedText string
	h.continueFn = func(text string) error {
		continuedText = text
		return nil
	}
	resp = doRequest(t, d, requestLine("ci1", "run.continue", `{"instruction":"加快节奏，让主角遇到劲敌"}`))
	if resp["ok"] != true {
		t.Fatalf("run.continue with instruction 应成功: %v", resp)
	}
	payload := resp["payload"].(map[string]any)
	if payload["resumed"] != true || payload["instruction"] != "加快节奏，让主角遇到劲敌" {
		t.Fatalf("unexpected payload: %v", payload)
	}
	if continuedText != "加快节奏，让主角遇到劲敌" {
		t.Fatalf("Continue 应收到指令: %q", continuedText)
	}

	// 3. Continue 失败 → 返回错误响应
	h.continueFn = func(string) error { return errors.New("干预持久化失败") }
	resp = doRequest(t, d, requestLine("ci2", "run.continue", `{"instruction":"fail"}`))
	if resp["ok"] != false {
		t.Fatalf("Continue 失败应返回 ok:false: %v", resp)
	}
}

func TestProjectReopen(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)

	// 1. 无项目 → project_unavailable
	resp := doRequest(t, d, requestLine("ro0", "project.reopen", `{}`))
	if code := mustErrCode(t, resp); code != CodeProjectUnavailable {
		t.Fatalf("want project_unavailable, got %s", code)
	}
	openFakeProject(d, h)

	// 2. 运行中 → host_busy
	h.setSnapshot(host.UISnapshot{RuntimeState: "running", IsRunning: true})
	resp = doRequest(t, d, requestLine("ro1", "project.reopen", `{}`))
	if code := mustErrCode(t, resp); code != CodeHostBusy {
		t.Fatalf("want host_busy, got %s", code)
	}

	// 3. 正常重开（无方向）
	h.setSnapshot(host.UISnapshot{RuntimeState: "idle", IsRunning: false, Phase: "complete"})
	reopenCalled := false
	var reopenDir string
	h.reopenFn = func(dir string) error {
		reopenCalled = true
		reopenDir = dir
		return nil
	}
	h.resumeFn = func() (string, error) {
		return "reopened novel", nil
	}
	resp = doRequest(t, d, requestLine("ro2", "project.reopen", `{}`))
	if resp["ok"] != true {
		t.Fatalf("reopen 应成功: %v", resp)
	}
	payload := resp["payload"].(map[string]any)
	if payload["reopened"] != true || payload["label"] != "reopened novel" {
		t.Fatalf("unexpected reopen payload: %v", payload)
	}
	if !reopenCalled || reopenDir != "" {
		t.Fatalf("reopen 应以空方向被调用: called=%v dir=%q", reopenCalled, reopenDir)
	}

	// 4. 带方向重开
	reopenCalled = false
	resp = doRequest(t, d, requestLine("ro3", "project.reopen", `{"direction":"开启第二部修仙篇"}`))
	if resp["ok"] != true {
		t.Fatalf("reopen 带方向应成功: %v", resp)
	}
	payload = resp["payload"].(map[string]any)
	if payload["direction"] != "开启第二部修仙篇" {
		t.Fatalf("direction 应回显: %v", payload)
	}
	if reopenDir != "开启第二部修仙篇" {
		t.Fatalf("reopenFn 应收到方向: %q", reopenDir)
	}

	// 5. Reopen 失败
	h.reopenFn = func(string) error { return errors.New("创作引擎运行中，无需重开") }
	resp = doRequest(t, d, requestLine("ro4", "project.reopen", `{}`))
	if resp["ok"] != false {
		t.Fatalf("Reopen 失败应返回 ok:false: %v", resp)
	}
}

// ── 共创 ──

// TestOverlappingRunStartsDoNotClobberRunIntent —— StartPrepared 的启动裁定
// 窗口可持续数秒，IsRunning 预检挡不住窗口内的第二个 run.start：后发者改写意图。
// 此时首请求失败必须仍然发出自己的 run.failed，且只在其 runID 仍持有意图时才复位。
func TestOverlappingRunStartsDoNotClobberRunIntent(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	firstEntered := make(chan struct{})
	firstRelease := make(chan struct{})
	h.startPreparedFn = func(prompt string) error {
		if strings.Contains(prompt, "第一本") {
			close(firstEntered)
			<-firstRelease // 模拟首请求停在秒级启动裁定窗口
			return errors.New("启动裁定失败: provider down")
		}
		return nil // 第二本成功启动
	}

	resp1 := doRequest(t, d, requestLine("ov1", "run.start", `{"goal":"第一本书"}`))
	if resp1["ok"] != true {
		t.Fatalf("首 run.start 应被接受: %v", resp1)
	}
	runID1 := resp1["payload"].(map[string]any)["run_id"].(string)
	<-firstEntered // 首 goroutine 已进入 StartPrepared（预检窗口内 IsRunning 仍 false）

	// 第二个 run.start 落在裁定窗口内：预检通过、也被接受、改写 run 意图。
	resp2 := doRequest(t, d, requestLine("ov2", "run.start", `{"goal":"第二本书"}`))
	if resp2["ok"] != true {
		t.Fatalf("第二 run.start 应被接受: %v", resp2)
	}
	runID2 := resp2["payload"].(map[string]any)["run_id"].(string)

	// 等第二本成功启动并认领意图（claimRun）后再放行首请求的失败。
	awaitEventWhere(t, d, "run.started", func(pl map[string]any) bool { return pl["run_id"] == runID2 })

	close(firstRelease)
	ev := awaitEventWhere(t, d, "run.failed", func(pl map[string]any) bool { return pl["run_id"] == runID1 })
	if ev == nil {
		t.Fatal("首请求失败必须发出自己的 run.failed（不得因意图被改写而吞掉）")
	}
	if msg, _ := ev["payload"].(map[string]any)["message"].(string); !strings.Contains(msg, "provider down") {
		t.Fatalf("run.failed 应携带首请求的真实错误: %v", ev)
	}

	d.stateMu.Lock()
	run := d.run
	d.stateMu.Unlock()
	if !run.active || run.runID != runID2 {
		t.Fatalf("第二本 run 意图必须保持完好: %+v", run)
	}
}

func TestCoCreateLifecycle(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	var progressCalls int
	h.coCreateStreamFn = func(ctx context.Context, history []host.CoCreateMessage, onProgress func(string, string)) (host.CoCreateReply, error) {
		progressCalls++
		onProgress(host.CoCreateProgressReply, "partial")
		return host.CoCreateReply{Message: "reply text", Prompt: "## draft", Ready: true, Suggestions: []string{"加个反派"}}, nil
	}

	resp := doRequest(t, d, requestLine("cc1", "cocreate.start", `{"message":"我想写科幻小说"}`))
	if resp["ok"] != true {
		t.Fatalf("cocreate.start: %v", resp)
	}
	// 终态 cocreate.progress（stage=assistant）带 draft/ready/suggestions。
	ev := awaitEventWhere(t, d, "cocreate.progress", func(p map[string]any) bool { return p["stage"] == "assistant" })
	payload := ev["payload"].(map[string]any)
	if payload["ready"] != true || payload["draft"] != "## draft" {
		t.Fatalf("终态 progress 载荷错误: %v", payload)
	}

	// 第二轮：cocreate.stage 续会话。
	resp = doRequest(t, d, requestLine("cc2", "cocreate.stage", `{"message":"主角是轨道站工程师"}`))
	if resp["ok"] != true {
		t.Fatalf("cocreate.stage: %v", resp)
	}
	awaitEventWhere(t, d, "cocreate.progress", func(p map[string]any) bool { return p["stage"] == "assistant" })
	waitCocreateIdle(t, d)

	// resume：冷启动模式 → 用 draft 启动新书（接受 + run.started）。
	resp = doRequest(t, d, requestLine("cc3", "cocreate.resume", `{}`))
	if resp["ok"] != true {
		t.Fatalf("cocreate.resume: %v", resp)
	}
	awaitEvent(t, d, "run.started")

	// cancel（新会话）。
	resp = doRequest(t, d, requestLine("cc4", "cocreate.cancel", `{"reason":"done"}`))
	if resp["payload"].(map[string]any)["cancelled"] != true {
		t.Fatalf("cocreate.cancel: %v", resp)
	}
}

// waitCocreateIdle 等待在途共创轮次收尾（active=false）。
func waitCocreateIdle(t *testing.T, d *Daemon) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		d.stateMu.Lock()
		cc := d.cocreate
		busy := cc != nil && cc.active
		d.stateMu.Unlock()
		if !busy {
			return
		}
		time.Sleep(3 * time.Millisecond)
	}
	t.Fatal("共创轮次未在期限内结束")
}

func TestCoCreateStageModeUsesPauseAndResumeFromCoCreate(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	paused := false
	h.pauseForCoCreateFn = func() bool { paused = true; return true }
	h.stageCoCreateStreamF = func(ctx context.Context, history []host.CoCreateMessage, onProgress func(string, string)) (host.CoCreateReply, error) {
		return host.CoCreateReply{Message: "stage reply", Prompt: "next arc", Ready: true}, nil
	}
	var resumeDraft string
	h.resumeFromCoCreateF = func(draft string) error { resumeDraft = draft; return nil }

	resp := doRequest(t, d, requestLine("sc1", "cocreate.start", `{"message":"规划下一卷","mode":"stage"}`))
	if resp["ok"] != true || !paused {
		t.Fatalf("stage 模式应先 PauseForCoCreate: %v paused=%v", resp, paused)
	}
	awaitEventWhere(t, d, "cocreate.progress", func(p map[string]any) bool { return p["stage"] == "assistant" })
	waitCocreateIdle(t, d)
	resp = doRequest(t, d, requestLine("sc2", "cocreate.resume", `{}`))
	if resp["ok"] != true || resumeDraft != "next arc" {
		t.Fatalf("stage resume 应走 ResumeFromCoCreate(draft): %v %q", resp, resumeDraft)
	}
}

func TestCoCreateWithoutSession(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)
	resp := doRequest(t, d, requestLine("cc0", "cocreate.stage", `{"message":"hi"}`))
	if code := mustErrCode(t, resp); code != CodeOperationFailed {
		t.Fatalf("无会话 stage 应 operation_failed, got %s", code)
	}
}

// ── 导入 / 仿写 ──

func TestImportStartProgressAndCancel(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	src := filepath.Join(t.TempDir(), "source.txt")
	if err := os.WriteFile(src, []byte("小说正文"), 0o644); err != nil {
		t.Fatal(err)
	}

	var gotOpts imp.Options
	h.importFromFn = func(ctx context.Context, opts imp.Options) (<-chan imp.Event, error) {
		gotOpts = opts
		ch := make(chan imp.Event, 3)
		ch <- imp.Event{Stage: imp.StageIngesting, Current: 0, Total: 10, Message: "reading"}
		ch <- imp.Event{Stage: imp.StageDone, Current: 10, Total: 10, Message: "published", Continued: true}
		close(ch)
		return ch, nil
	}
	line := requestLine("im1", "import.start",
		`{"source_path":"`+src+`","options":{"auto_confirm":true,"continue_after":true}}`)
	resp := doRequest(t, d, line)
	if resp["ok"] != true {
		t.Fatalf("import.start: %v", resp)
	}
	if !gotOpts.AutoConfirm || !gotOpts.ContinueAfter || gotOpts.SourcePath != src {
		t.Fatalf("options 映射错误: %+v", gotOpts)
	}
	ev := awaitEvent(t, d, "import.progress")
	p := ev["payload"].(map[string]any)
	if p["stage"] != "ingesting" && p["stage"] != "done" {
		t.Fatalf("import.progress.stage 应附加: %v", p)
	}

	// 排空 goroutine 退出（importCancel 清空）后 cancel → cancelled:false。
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		d.stateMu.Lock()
		busy := d.importCancel != nil
		d.stateMu.Unlock()
		if !busy {
			break
		}
		time.Sleep(3 * time.Millisecond)
	}
	resp = doRequest(t, d, requestLine("im2", "import.cancel", `{}`))
	if resp["payload"].(map[string]any)["cancelled"] != false {
		t.Fatalf("import.cancel 幂等: %v", resp)
	}
}

func TestImportStartRejectsBadOptions(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)
	src := filepath.Join(t.TempDir(), "s.txt")
	os.WriteFile(src, []byte("x"), 0o644)
	resp := doRequest(t, d, requestLine("im3", "import.start",
		`{"source_path":"`+src+`","options":{"story_resolution":"sideways"}}`))
	if code := mustErrCode(t, resp); code != CodeInvalidPayload {
		t.Fatalf("非法 story_resolution 应 invalid_payload, got %s", code)
	}
	resp = doRequest(t, d, requestLine("im4", "import.start", `{"source_path":"/nonexistent/file.txt"}`))
	if code := mustErrCode(t, resp); code != CodeOperationFailed {
		t.Fatalf("不可访问源应 operation_failed, got %s", code)
	}
}

func TestSimulationHandlers(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	p := openFakeProject(d, h)

	simRuns := 0
	h.simulateFn = func(ctx context.Context, sourceDir string) (<-chan sim.Event, error) {
		simRuns++
		ch := make(chan sim.Event, 1)
		ch <- sim.Event{Stage: sim.StageDone, Current: 3, Total: 3, Message: "profile updated"}
		close(ch)
		return ch, nil
	}

	// 单文件语料：真实落进 <项目>/simulate，引擎被指向该绝对目录。
	simSrc := filepath.Join(t.TempDir(), "reference.txt")
	if err := os.WriteFile(simSrc, []byte("参考语料正文"), 0o644); err != nil {
		t.Fatal(err)
	}
	resp := doRequest(t, d, requestLine("sm1", "simulation.start", `{"source_path":"`+simSrc+`"}`))
	if resp["ok"] != true {
		t.Fatalf("simulation.start: %v", resp)
	}
	wantCorpus := filepath.Join(p.path, "simulate")
	if got := resp["payload"].(map[string]any)["engine_source_dir"]; got != wantCorpus {
		t.Fatalf("engine_source_dir 应为项目语料库 %q, got %v", wantCorpus, got)
	}
	if h.simulateSourceDir() != wantCorpus {
		t.Fatalf("Host.Simulate 应被指向项目语料库: got %q", h.simulateSourceDir())
	}
	staged, err := os.ReadFile(filepath.Join(wantCorpus, "reference.txt"))
	if err != nil || string(staged) != "参考语料正文" {
		t.Fatalf("语料应被复制进项目语料库: %q %v", staged, err)
	}
	awaitEvent(t, d, "simulation.progress")

	// resume：对项目语料库重跑（增量合并即恢复）。
	resp = doRequest(t, d, requestLine("sm2", "simulation.resume", `{}`))
	if resp["ok"] != true || simRuns != 2 {
		t.Fatalf("simulation.resume 应再次调用 Simulate: runs=%d %v", simRuns, resp)
	}
	if h.simulateSourceDir() != wantCorpus {
		t.Fatalf("resume 也应指向项目语料库: %q", h.simulateSourceDir())
	}

	profile := filepath.Join(t.TempDir(), "profile.json")
	os.WriteFile(profile, []byte(`{}`), 0o644)
	resp = doRequest(t, d, requestLine("sm3", "simulation.profile_import", `{"profile_path":"`+profile+`"}`))
	if resp["ok"] != true {
		t.Fatalf("simulation.profile_import: %v", resp)
	}
}

// TestSimulationStagingSemantics —— source_path 必须真正被消费：
// 目录语料递归落库（仅 .txt/.md/.markdown，保留相对路径）、同名替换累积、
// 不支持格式显式报错、不可访问路径报错。
func TestSimulationStagingSemantics(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	p := openFakeProject(d, h)
	corpus := filepath.Join(p.path, "simulate")

	// 目录语料：a.txt + 子目录 b.md 落库；c.pdf 被跳过。
	srcDir := t.TempDir()
	os.MkdirAll(filepath.Join(srcDir, "sub"), 0o755)
	os.WriteFile(filepath.Join(srcDir, "a.txt"), []byte("A"), 0o644)
	os.WriteFile(filepath.Join(srcDir, "sub", "b.md"), []byte("B"), 0o644)
	os.WriteFile(filepath.Join(srcDir, "c.pdf"), []byte("C"), 0o644)

	resp := doRequest(t, d, requestLine("ss1", "simulation.start", `{"source_path":"`+srcDir+`"}`))
	if resp["ok"] != true {
		t.Fatalf("目录语料 start: %v", resp)
	}
	for rel, want := range map[string]string{"a.txt": "A", filepath.Join("sub", "b.md"): "B"} {
		got, err := os.ReadFile(filepath.Join(corpus, rel))
		if err != nil || string(got) != want {
			t.Fatalf("语料 %s 未按相对路径落库: %q %v", rel, got, err)
		}
	}
	if _, err := os.Stat(filepath.Join(corpus, "c.pdf")); !os.IsNotExist(err) {
		t.Fatal("不受支持的格式不应落库")
	}
	if h.simulateSourceDir() != corpus {
		t.Fatalf("引擎语料目录: %q", h.simulateSourceDir())
	}

	// 同名替换：再次 start 覆盖 a.txt，既有语料保留（累积语义）。
	os.WriteFile(filepath.Join(srcDir, "a.txt"), []byte("A2"), 0o644)
	resp = doRequest(t, d, requestLine("ss2", "simulation.start", `{"source_path":"`+srcDir+`"}`))
	if resp["ok"] != true {
		t.Fatalf("二次 start: %v", resp)
	}
	if got, _ := os.ReadFile(filepath.Join(corpus, "a.txt")); string(got) != "A2" {
		t.Fatalf("同名语料应替换: %q", got)
	}
	if got, _ := os.ReadFile(filepath.Join(corpus, "sub", "b.md")); string(got) != "B" {
		t.Fatal("既有语料应保留（累积语义）")
	}

	// 不支持的单文件 → operation_failed（绝不静默空跑）。
	pdf := filepath.Join(t.TempDir(), "book.pdf")
	os.WriteFile(pdf, []byte("x"), 0o644)
	resp = doRequest(t, d, requestLine("ss3", "simulation.start", `{"source_path":"`+pdf+`"}`))
	if code := mustErrCode(t, resp); code != CodeOperationFailed {
		t.Fatalf("pdf 语料应 operation_failed, got %s", code)
	}

	// 不存在的路径 → operation_failed。
	resp = doRequest(t, d, requestLine("ss4", "simulation.start", `{"source_path":"/nonexistent/corpus"}`))
	if code := mustErrCode(t, resp); code != CodeOperationFailed {
		t.Fatalf("不可访问语料应 operation_failed, got %s", code)
	}
}

// TestSimulationResumeWithoutCorpus —— 未建库时 resume 同步报错（不静默空跑引擎）。
func TestSimulationResumeWithoutCorpus(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)
	resp := doRequest(t, d, requestLine("sr1", "simulation.resume", `{}`))
	if code := mustErrCode(t, resp); code != CodeOperationFailed {
		t.Fatalf("无语料库 resume 应 operation_failed, got %s", code)
	}
}

// ── 章节（真实临时目录 store，只读投影 + 保存适配器）──

func seedChapterStore(t *testing.T, dir string) *store.Store {
	t.Helper()
	s := store.NewStore(dir)
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	if err := s.Progress.Init(2); err != nil {
		t.Fatal(err)
	}
	if err := s.Drafts.SaveFinalChapter(1, "# 第一章\n\n正文一"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ChapterRecords.Accept(1, domain.ChapterOriginGenerated, "# 第一章\n\n正文一",
		domain.ChapterFacts{Title: "第一章"}, domain.StyleDelta{}); err != nil {
		t.Fatal(err)
	}
	if err := s.Progress.MarkChapterComplete(1, 7, "", ""); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestChapterListReadSave(t *testing.T) {
	h := newFakeHost(t)
	seedChapterStore(t, h.dir)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	resp := doRequest(t, d, requestLine("cl1", "chapter.list", `{}`))
	payload := resp["payload"].(map[string]any)
	chapters := payload["chapters"].([]any)
	if len(chapters) != 1 {
		t.Fatalf("应有 1 章: %v", payload)
	}
	first := chapters[0].(map[string]any)
	if first["chapter"] != float64(1) || first["title"] != "第一章" {
		t.Fatalf("章节投影错误: %v", first)
	}

	resp = doRequest(t, d, requestLine("cr1", "chapter.read", `{"chapter":1}`))
	payload = resp["payload"].(map[string]any)
	if !strings.Contains(payload["content"].(string), "正文一") {
		t.Fatalf("chapter.read: %v", payload)
	}
	if payload["version"] != float64(1) {
		t.Fatalf("version 投影: %v", payload)
	}

	// 字符串章节号（schema anyOf）。
	resp = doRequest(t, d, requestLine("cr2", "chapter.read", `{"chapter":"1"}`))
	if resp["ok"] != true {
		t.Fatalf("字符串章节号应被接受: %v", resp)
	}

	// 保存：base_version 冲突 → operation_failed + conflict 标记。
	resp = doRequest(t, d, requestLine("cs1", "chapter.save",
		`{"chapter":1,"content":"新的正文","base_version":99}`))
	if code := mustErrCode(t, resp); code != CodeOperationFailed {
		t.Fatalf("冲突应 operation_failed, got %s", code)
	}

	// 正常保存：版本递增 + chapter.updated 事件 + 字数投影。
	resp = doRequest(t, d, requestLine("cs2", "chapter.save",
		`{"chapter":1,"content":"改写后的正文","base_version":1}`))
	if resp["ok"] != true || resp["payload"].(map[string]any)["version"] != float64(2) {
		t.Fatalf("chapter.save: %v", resp)
	}
	ev := awaitEvent(t, d, "chapter.updated")
	if ev["payload"].(map[string]any)["status"] != "saved" {
		t.Fatalf("chapter.updated: %v", ev)
	}
	s2 := store.NewStore(h.dir)
	progress, err := s2.Progress.Load()
	if err != nil {
		t.Fatal(err)
	}
	if progress.ChapterWordCounts[1] != len([]rune("改写后的正文")) {
		t.Fatalf("字数投影未更新: %v", progress.ChapterWordCounts)
	}
}

// TestChapterSaveRejectedWhileRunActive —— 保存路径的 store 实例与 Host 内部
// store 无跨实例互斥（applyChapterWordCount 的 Load→mutate→Save 不设防），
// 运行期保存会与引擎进度写互丢更新：与 revisions.sync 同一 IsRunning 守卫，
// 运行中拒绝 host_busy 且 store 不被触碰；空闲后保存照常成功。
func TestChapterSaveRejectedWhileRunActive(t *testing.T) {
	h := newFakeHost(t)
	seedChapterStore(t, h.dir)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	// 运行中 → host_busy（镜像 revisions.sync 的守卫与载荷形态）。
	h.setSnapshot(host.UISnapshot{RuntimeState: "running", IsRunning: true})
	resp := doRequest(t, d, requestLine("cs-busy", "chapter.save",
		`{"chapter":1,"content":"运行期间写下的正文"}`))
	if code := mustErrCode(t, resp); code != CodeHostBusy {
		t.Fatalf("want host_busy, got %s", code)
	}
	errObj := resp["error"].(map[string]any)
	if errObj["details"].(map[string]any)["active_request"] != "chapter.save" {
		t.Fatalf("host_busy 载荷应指明被拒请求: %v", errObj)
	}

	// store 完全未被触碰：字数投影、工作区正文、接纳记录版本都保持原样。
	s := store.NewStore(h.dir)
	progress, err := s.Progress.Load()
	if err != nil {
		t.Fatal(err)
	}
	if progress.ChapterWordCounts[1] != 7 {
		t.Fatalf("运行中保存不得触碰字数投影: %v", progress.ChapterWordCounts)
	}
	text, err := s.Drafts.LoadChapterText(1)
	if err != nil || text != "# 第一章\n\n正文一" {
		t.Fatalf("运行中保存不得改写工作区正文: %q %v", text, err)
	}
	record, err := s.ChapterRecords.Load(1)
	if err != nil || record == nil || record.Revision != 1 {
		t.Fatalf("运行中保存不得触碰接纳记录: %+v %v", record, err)
	}

	// 运行结束 → 保存成功（版本递增 + 字数投影更新）。
	h.setSnapshot(host.UISnapshot{RuntimeState: "idle"})
	resp = doRequest(t, d, requestLine("cs-idle", "chapter.save",
		`{"chapter":1,"content":"空闲后改写的正文"}`))
	if resp["ok"] != true || resp["payload"].(map[string]any)["version"] != float64(2) {
		t.Fatalf("空闲后保存应成功: %v", resp)
	}
	ev := awaitEvent(t, d, "chapter.updated")
	if ev["payload"].(map[string]any)["status"] != "saved" {
		t.Fatalf("chapter.updated: %v", ev)
	}
	progress, err = store.NewStore(h.dir).Progress.Load()
	if err != nil {
		t.Fatal(err)
	}
	if progress.ChapterWordCounts[1] != len([]rune("空闲后改写的正文")) {
		t.Fatalf("空闲后字数投影应更新: %v", progress.ChapterWordCounts)
	}
}

// 全新项目（尚无 meta/progress.json）：chapter.list 必须空投影成功而非 panic，
// chapter.save 必须建立进度投影（CompletedChapters 供 chapter.list/export 使用）。
func TestChapterFreshProjectListAndSaveProjection(t *testing.T) {
	h := newFakeHost(t) // 不 seedChapterStore：目录里没有任何 meta/进度文件
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	resp := doRequest(t, d, requestLine("cl-fresh", "chapter.list", `{}`))
	if resp["ok"] != true {
		t.Fatalf("全新项目 chapter.list 应成功: %v", resp)
	}
	payload := resp["payload"].(map[string]any)
	if payload["completed"] != float64(0) {
		t.Fatalf("全新项目应 0 章完成: %v", payload)
	}

	resp = doRequest(t, d, requestLine("cs-fresh", "chapter.save",
		`{"chapter":1,"content":"灯塔看守人数到第十七级台阶。守灯的人向黑暗转过身去。"}`))
	if resp["ok"] != true {
		t.Fatalf("chapter.save: %v", resp)
	}

	resp = doRequest(t, d, requestLine("cl-fresh2", "chapter.list", `{}`))
	payload = resp["payload"].(map[string]any)
	chapters := payload["chapters"].([]any)
	if len(chapters) != 1 || chapters[0].(map[string]any)["chapter"] != float64(1) {
		t.Fatalf("保存后 chapter.list 应包含第 1 章: %v", payload)
	}

	s := store.NewStore(h.dir)
	progress, err := s.Progress.Load()
	if err != nil || progress == nil {
		t.Fatalf("保存后进度投影应存在: %v %v", progress, err)
	}
	if len(progress.CompletedChapters) != 1 || progress.CompletedChapters[0] != 1 {
		t.Fatalf("CompletedChapters 应含第 1 章: %v", progress.CompletedChapters)
	}
	if progress.ChapterWordCounts[1] == 0 {
		t.Fatalf("字数投影未记录: %v", progress.ChapterWordCounts)
	}
}

func TestChapterReadMissing(t *testing.T) {
	h := newFakeHost(t)
	seedChapterStore(t, h.dir)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)
	resp := doRequest(t, d, requestLine("crx", "chapter.read", `{"chapter":42}`))
	if code := mustErrCode(t, resp); code != CodeOperationFailed {
		t.Fatalf("不存在章节应 operation_failed, got %s", code)
	}
}

func TestRevisionsCheckSync(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	h.checkRevisionsFn = func() ([]int, error) { return []int{2, 5}, nil }
	resp := doRequest(t, d, requestLine("rv1", "chapter.revisions.check", `{}`))
	payload := resp["payload"].(map[string]any)
	if payload["count"] != float64(2) {
		t.Fatalf("check: %v", payload)
	}
	resp = doRequest(t, d, requestLine("rv2", "chapter.revisions.check", `{"chapter":2}`))
	payload = resp["payload"].(map[string]any)
	chapters := payload["chapters"].([]any)
	if len(chapters) != 1 || chapters[0] != float64(2) {
		t.Fatalf("chapter 过滤失败: %v", payload)
	}

	h.syncRevisionsFn = func(ctx context.Context) (*revision.Result, error) {
		return &revision.Result{Changed: []int{2}, Applied: []int{2}}, nil
	}
	resp = doRequest(t, d, requestLine("rv3", "chapter.revisions.sync", `{}`))
	if resp["ok"] != true || resp["payload"].(map[string]any)["accepted"] != true {
		t.Fatalf("sync 接受: %v", resp)
	}
	awaitEvent(t, d, "chapter.updated")
	awaitEvent(t, d, "notification.info")
}

func TestChapterExport(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	var gotOpts exp.Options
	h.exportFn = func(ctx context.Context, opts exp.Options) (*exp.Result, error) {
		gotOpts = opts
		return &exp.Result{Path: "/tmp/book.epub", Chapters: 3}, nil
	}
	resp := doRequest(t, d, requestLine("ex1", "chapter.export",
		`{"chapters":[1,2,3],"format":"epub","output_path":"/tmp/book.epub"}`))
	if resp["ok"] != true {
		t.Fatalf("export: %v", resp)
	}
	if gotOpts.Format != exp.FormatEPUB || gotOpts.From != 1 || gotOpts.To != 3 || gotOpts.OutPath != "/tmp/book.epub" {
		t.Fatalf("export 参数映射: %+v", gotOpts)
	}
	resp = doRequest(t, d, requestLine("ex2", "chapter.export", `{"format":"pdf"}`))
	if code := mustErrCode(t, resp); code != CodeInvalidPayload {
		t.Fatalf("不支持格式应 invalid_payload, got %s", code)
	}
}

// ── 工件只读投影（artifacts.read）──

func seedArtifacts(t *testing.T, dir string) *store.Store {
	t.Helper()
	s := seedChapterStore(t, dir)
	if err := s.World.SaveWorldRules([]domain.WorldRule{
		{Category: "magic", Rule: "Lamps answer honestly", Boundary: "Never lie"},
		{Category: "geography", Rule: "The island moves with the tide"},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.Summaries.SaveSummary(domain.ChapterSummary{
		Chapter: 1, Title: "第一章", Summary: "Mara 抵达灯塔。",
		Characters: []string{"Mara"}, KeyEvents: []string{"arrival"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ChapterRecords.Accept(1, domain.ChapterOriginGenerated, "# 第一章\n\n正文一",
		domain.ChapterFacts{
			Title:      "第一章",
			Summary:    "抵达",
			Characters: []string{"Mara"},
			KeyEvents:  []string{"arrival"},
			HookType:   "cliffhanger",
		}, domain.StyleDelta{}); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestArtifactsRead(t *testing.T) {
	h := newFakeHost(t)
	seedArtifacts(t, h.dir)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	// facts 全量：每完成章一条，facts 为接纳记录的完整事实。
	resp := doRequest(t, d, requestLine("ar1", "artifacts.read", `{"kind":"facts"}`))
	payload := resp["payload"].(map[string]any)
	items := payload["facts"].([]any)
	if payload["count"] != float64(1) || len(items) != 1 {
		t.Fatalf("facts 全量: %v", payload)
	}
	item := items[0].(map[string]any)
	if item["chapter"] != float64(1) || item["origin"] != string(domain.ChapterOriginGenerated) {
		t.Fatalf("facts 条目元数据: %v", item)
	}
	facts := item["facts"].(map[string]any)
	if facts["title"] != "第一章" || facts["hook_type"] != "cliffhanger" {
		t.Fatalf("facts 投影: %v", facts)
	}

	// facts 单章 + 未接纳章节 found:false（正常态，非错误）。
	resp = doRequest(t, d, requestLine("ar2", "artifacts.read", `{"kind":"facts","chapter":1}`))
	payload = resp["payload"].(map[string]any)
	if payload["found"] != true || payload["version"] == nil {
		t.Fatalf("facts 单章: %v", payload)
	}
	resp = doRequest(t, d, requestLine("ar3", "artifacts.read", `{"kind":"facts","chapter":9}`))
	payload = resp["payload"].(map[string]any)
	if payload["found"] != false {
		t.Fatalf("未接纳章节应 found:false: %v", payload)
	}

	// world：规则账本 + 不接受 chapter 过滤。
	resp = doRequest(t, d, requestLine("ar4", "artifacts.read", `{"kind":"world"}`))
	payload = resp["payload"].(map[string]any)
	rules := payload["rules"].([]any)
	if payload["count"] != float64(2) || len(rules) != 2 {
		t.Fatalf("world: %v", payload)
	}
	first := rules[0].(map[string]any)
	if first["category"] != "magic" || first["boundary"] != "Never lie" {
		t.Fatalf("world 规则投影: %v", first)
	}
	resp = doRequest(t, d, requestLine("ar5", "artifacts.read", `{"kind":"world","chapter":1}`))
	if code := mustErrCode(t, resp); code != CodeInvalidPayload {
		t.Fatalf("world+chapter 应 invalid_payload, got %s", code)
	}

	// summary 全量 + 单章 + 缺失 found:false。
	resp = doRequest(t, d, requestLine("ar6", "artifacts.read", `{"kind":"summary"}`))
	payload = resp["payload"].(map[string]any)
	summaries := payload["summaries"].([]any)
	if payload["count"] != float64(1) || len(summaries) != 1 {
		t.Fatalf("summary 全量: %v", payload)
	}
	sum := summaries[0].(map[string]any)
	if sum["chapter"] != float64(1) || sum["title"] != "第一章" {
		t.Fatalf("summary 投影: %v", sum)
	}
	resp = doRequest(t, d, requestLine("ar7", "artifacts.read", `{"kind":"summary","chapter":1}`))
	if resp["payload"].(map[string]any)["found"] != true {
		t.Fatalf("summary 单章: %v", resp)
	}
	resp = doRequest(t, d, requestLine("ar8", "artifacts.read", `{"kind":"summary","chapter":5}`))
	if resp["payload"].(map[string]any)["found"] != false {
		t.Fatalf("缺失摘要应 found:false: %v", resp)
	}

	// 非法 kind / 缺失 kind / 非法 chapter。
	resp = doRequest(t, d, requestLine("ar9", "artifacts.read", `{"kind":"outline"}`))
	if code := mustErrCode(t, resp); code != CodeInvalidPayload {
		t.Fatalf("非法 kind 应 invalid_payload, got %s", code)
	}
	resp = doRequest(t, d, requestLine("ar10", "artifacts.read", `{}`))
	if code := mustErrCode(t, resp); code != CodeInvalidPayload {
		t.Fatalf("缺失 kind 应 invalid_payload, got %s", code)
	}
	resp = doRequest(t, d, requestLine("ar11", "artifacts.read", `{"kind":"facts","chapter":-1}`))
	if code := mustErrCode(t, resp); code != CodeInvalidPayload {
		t.Fatalf("非法 chapter 应 invalid_payload, got %s", code)
	}
}

func TestArtifactsReadRequiresProject(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h) // 未打开项目
	resp := doRequest(t, d, requestLine("arp", "artifacts.read", `{"kind":"world"}`))
	if code := mustErrCode(t, resp); code != CodeProjectUnavailable {
		t.Fatalf("无项目应 project_unavailable, got %s", code)
	}
}

func TestArtifactsReadEmptyProject(t *testing.T) {
	h := newFakeHost(t)
	s := store.NewStore(h.dir)
	if err := s.Init(); err != nil {
		t.Fatal(err)
	}
	if err := s.Progress.Init(2); err != nil {
		t.Fatal(err)
	}
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	// 空项目的 world 返回空列表（而非 null / 错误）。
	resp := doRequest(t, d, requestLine("are", "artifacts.read", `{"kind":"world"}`))
	payload := resp["payload"].(map[string]any)
	if payload["count"] != float64(0) || len(payload["rules"].([]any)) != 0 {
		t.Fatalf("空 world 应空列表: %v", payload)
	}
}

// ── 配置 ──

func TestConfigHandlers(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	// get：默认全量（脱敏），api_key 只有 hint。
	resp := doRequest(t, d, requestLine("cg1", "config.get", `{}`))
	payload := resp["payload"].(map[string]any)
	providers := payload["providers"].([]any)
	p0 := providers[0].(map[string]any)
	if _, has := p0["api_key"]; has {
		t.Fatal("config.get 绝不能携带明文 api_key")
	}
	if p0["has_api_key"] != true {
		t.Fatalf("has_api_key 应保留布尔: %v", p0)
	}

	// get：keys 过滤。
	resp = doRequest(t, d, requestLine("cg2", "config.get", `{"keys":["provider","model"]}`))
	payload = resp["payload"].(map[string]any)
	if _, has := payload["providers"]; has {
		t.Fatal("keys 过滤应剔除未请求键")
	}

	// update：支持键 + unsupported 列表。
	var uiLang string
	h.configureLangFn = func(ui, story string) error { uiLang = ui; return nil }
	resp = doRequest(t, d, requestLine("cu1", "config.update", `{"values":{"language":"vi","budget_usd":5}}`))
	payload = resp["payload"].(map[string]any)
	if uiLang != "vi" {
		t.Fatalf("language 应被应用: %q", uiLang)
	}
	unsupported, _ := payload["unsupported"].([]any)
	if len(unsupported) != 1 {
		t.Fatalf("unsupported 应列出 budget_usd: %v", payload)
	}

	// providers / models / thinking。
	resp = doRequest(t, d, requestLine("cp1", "config.providers", `{}`))
	if resp["payload"].(map[string]any)["default_provider"] != "demo" {
		t.Fatalf("providers: %v", resp)
	}
	resp = doRequest(t, d, requestLine("cm1", "config.models", `{"provider":"demo"}`))
	models := resp["payload"].(map[string]any)["models"].([]any)
	if models[0].(map[string]any)["name"] != "demo-model" {
		t.Fatalf("models: %v", models)
	}
	resp = doRequest(t, d, requestLine("ct1", "config.thinking_levels", `{"provider":"demo","model":"demo-model"}`))
	payload = resp["payload"].(map[string]any)
	if _, isList := payload["levels"].([]any); !isList {
		t.Fatalf("thinking_levels: %v", payload)
	}

	// switch_model / set_thinking / 语言。
	var swRole, swProvider, swModel string
	h.switchModelFn = func(role, provider, model string) error {
		swRole, swProvider, swModel = role, provider, model
		return nil
	}
	resp = doRequest(t, d, requestLine("cw1", "config.switch_model", `{"provider":"openai","model":"gpt-5"}`))
	if resp["ok"] != true || swRole != "default" || swProvider != "openai" || swModel != "gpt-5" {
		t.Fatalf("switch_model: %v %v/%v/%v", resp, swRole, swProvider, swModel)
	}
	var thinkLevel string
	h.setRoleThinkingFn = func(role, level string) error { thinkLevel = level; return nil }
	resp = doRequest(t, d, requestLine("cx1", "config.set_thinking", `{"level":"high"}`))
	if resp["ok"] != true || thinkLevel != "high" {
		t.Fatalf("set_thinking: %v %q", resp, thinkLevel)
	}
	resp = doRequest(t, d, requestLine("cy1", "config.set_language", `{"language":"EN"}`))
	if resp["payload"].(map[string]any)["language"] != "en" {
		t.Fatalf("语言码应归一化: %v", resp)
	}
	resp = doRequest(t, d, requestLine("cy2", "config.set_story_language", `{"language":"zh"}`))
	if resp["ok"] != true {
		t.Fatalf("set_story_language: %v", resp)
	}
}

// ── 诊断 / 用量 / 日志 / 队列 ──

func TestDiagnosticsSnapshotAndExport(t *testing.T) {
	h := newFakeHost(t)
	seedChapterStore(t, h.dir)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	resp := doRequest(t, d, requestLine("ds1", "diagnostics.snapshot", `{}`))
	payload := resp["payload"].(map[string]any)
	if _, has := payload["findings"]; !has {
		t.Fatalf("diagnostics.snapshot: %v", payload)
	}

	target := filepath.Join(t.TempDir(), "diag", "bundle.md")
	resp = doRequest(t, d, requestLine("ds2", "diagnostics.export", `{"output_path":"`+target+`"}`))
	if resp["ok"] != true {
		t.Fatalf("diagnostics.export: %v", resp)
	}
	if resp["payload"].(map[string]any)["output_path"] != target {
		t.Fatalf("应尊重对话框路径: %v", resp)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("脱敏包应复制到目标路径: %v", err)
	}
	awaitEvent(t, d, "diagnostics.completed")
}

func TestUsageLogsQueue(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)
	h.setSnapshot(host.UISnapshot{RuntimeState: "idle", TotalInputTokens: 100, TotalOutputTokens: 50, TotalCostUSD: 1.25})

	resp := doRequest(t, d, requestLine("us1", "usage.snapshot", `{}`))
	usage := resp["payload"].(map[string]any)["usage"].(map[string]any)
	if usage["input_tokens"] != float64(100) || usage["cost_usd"] != 1.25 {
		t.Fatalf("usage.snapshot: %v", usage)
	}

	d.log("info", "test", "first message")
	d.log("error", "test", "second message")
	resp = doRequest(t, d, requestLine("lr1", "logs.replay", `{"after_sequence":0,"level":"error"}`))
	payload := resp["payload"].(map[string]any)
	records := payload["records"].([]any)
	if len(records) != 1 {
		t.Fatalf("level 过滤应只回 error: %v", payload)
	}
	rec := records[0].(map[string]any)
	if rec["message"] != "second message" {
		t.Fatalf("日志记录: %v", rec)
	}

	resp = doRequest(t, d, requestLine("rq1", "runtime.queue", `{}`))
	payload = resp["payload"].(map[string]any)
	items := payload["items"].([]any)
	if payload["count"] != float64(1) || items[0].(map[string]any)["agent"] != "writer" {
		t.Fatalf("runtime.queue: %v", payload)
	}
}

func TestProjectSnapshotPayload(t *testing.T) {
	h := newFakeHost(t)
	h.setSnapshot(host.UISnapshot{
		RuntimeState: "running", IsRunning: true, Phase: "writing",
		BookTitle: "测试小说", CompletedCount: 3, TotalChapters: 24, Style: "default",
		Outline: []host.OutlineSnapshot{{Chapter: 1, Title: "序章", CoreEvent: "爆炸"}},
	})
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)
	resp := doRequest(t, d, requestLine("ps1", "project.snapshot", `{}`))
	payload := resp["payload"].(map[string]any)
	if payload["state"] != "running" || payload["book_title"] != "测试小说" {
		t.Fatalf("snapshot 投影: %v", payload)
	}
	outline := payload["outline"].([]any)
	if outline[0].(map[string]any)["title"] != "序章" {
		t.Fatalf("outline 投影: %v", outline)
	}
}

func TestProjectResume(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)

	resumeLabels := []string{"checkpoint: ch3", ""}
	i := 0
	h.resumeFn = func() (string, error) { lbl := resumeLabels[i]; i++; return lbl, nil }

	resp := doRequest(t, d, requestLine("pr1", "project.resume", `{}`))
	if resp["payload"].(map[string]any)["resumed"] != true {
		t.Fatalf("project.resume: %v", resp)
	}
	awaitEvent(t, d, "run.started")

	// checkpoint_id 显式回绝（引擎固定取最新）。
	resp = doRequest(t, d, requestLine("pr2", "project.resume", `{"checkpoint_id":"ckpt-1"}`))
	if code := mustErrCode(t, resp); code != CodeInvalidPayload {
		t.Fatalf("指定 checkpoint 应 invalid_payload, got %s", code)
	}

	resp = doRequest(t, d, requestLine("pr3", "project.resume", `{}`))
	if resp["payload"].(map[string]any)["resumed"] != false {
		t.Fatalf("无恢复会话应 resumed:false: %v", resp)
	}
}

func TestProjectCreateGuards(t *testing.T) {
	h := newFakeHost(t)
	seedChapterStore(t, h.dir) // h.dir 已是现成工程
	d, _ := newTestDaemon(t, h)

	resp := doRequest(t, d, requestLine("pc1", "project.create", `{"path":"`+h.dir+`"}`))
	if code := mustErrCode(t, resp); code != CodeOperationFailed {
		t.Fatalf("已有工程目录应拒绝 create, got %s", code)
	}

	fresh := filepath.Join(t.TempDir(), "NewNovel")
	resp = doRequest(t, d, requestLine("pc2", "project.create", `{"path":"`+fresh+`","name":"My Book"}`))
	if resp["ok"] != true {
		t.Fatalf("project.create: %v", resp)
	}
	payload := resp["payload"].(map[string]any)
	if payload["created"] != true || payload["name"] != "My Book" {
		t.Fatalf("create 载荷: %v", payload)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("目录应被创建: %v", err)
	}
}

func TestRedactionInResponses(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)
	h.switchModelFn = func(role, p, m string) error {
		return errors.New("provider openai auth failed: sk-abcdef1234567890abcdef rejected")
	}
	resp := doRequest(t, d, requestLine("rd1", "config.switch_model", `{"provider":"openai","model":"gpt-5"}`))
	errObj := resp["error"].(map[string]any)
	msg := errObj["message"].(string)
	if strings.Contains(msg, "sk-abcdef1234567890abcdef") {
		t.Fatalf("错误消息必须脱敏: %q", msg)
	}
	if !strings.Contains(msg, "****") && !strings.Contains(msg, "******") {
		t.Fatalf("应保留遮蔽形态: %q", msg)
	}
}

// 确保解码辅助对 JSON 输出稳定（防止 map 序列化漂移）。
func TestResponsesAreJSONMarshalable(t *testing.T) {
	h := newFakeHost(t)
	d, _ := newTestDaemon(t, h)
	openFakeProject(d, h)
	resp := doRequest(t, d, requestLine("jp1", "project.snapshot", `{}`))
	if _, err := json.Marshal(resp); err != nil {
		t.Fatalf("响应必须可序列化: %v", err)
	}
}
