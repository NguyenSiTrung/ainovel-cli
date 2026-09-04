// fakehost_test.go —— 可编排的 HostAPI 假实现：协议/分发测试绝不构建真实
// 模型客户端（不用 host.New），无网络、无付费 provider。
package desktop

import (
	"bytes"
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/voocel/agentcore"
	"github.com/voocel/ainovel-cli/assets"
	"github.com/voocel/ainovel-cli/internal/bootstrap"
	"github.com/voocel/ainovel-cli/internal/domain"
	"github.com/voocel/ainovel-cli/internal/host"
	"github.com/voocel/ainovel-cli/internal/host/exp"
	"github.com/voocel/ainovel-cli/internal/host/imp"
	"github.com/voocel/ainovel-cli/internal/host/sim"
	"github.com/voocel/ainovel-cli/internal/revision"
)

// fakeHost 按需编排：默认行为全部成功/空，具体用例覆盖 xxxFn 钩子。
type fakeHost struct {
	dir string

	events chan host.Event
	stream chan string
	done   chan struct{}

	mu          sync.Mutex
	closeCount  int
	snapshotVal host.UISnapshot

	prepareUserRulesFn func(string) error
	startPreparedFn    func(string) error
	resumeFn           func() (string, error)
	continueFn         func(string) error
	reopenFn           func(string) error
	steerFn            func(string) error
	abortFn            func() bool
	setAdvanceModeFn   func(domain.ChapterAdvanceMode) error
	advanceOneFn       func() error

	pauseForCoCreateFn   func() bool
	coCreateStreamFn     func(ctx context.Context, history []host.CoCreateMessage, onProgress func(kind, text string)) (host.CoCreateReply, error)
	stageCoCreateStreamF func(ctx context.Context, history []host.CoCreateMessage, onProgress func(kind, text string)) (host.CoCreateReply, error)
	resumeFromCoCreateF  func(string) error
	cancelCoCreateCalled bool

	importFromFn  func(ctx context.Context, opts imp.Options) (<-chan imp.Event, error)
	simulateFn    func(ctx context.Context, sourceDir string) (<-chan sim.Event, error)
	importSimPrfF func(ctx context.Context, path string) (<-chan sim.Event, error)

	lastSimulateSourceDir string // 最近一次 Simulate 解析出的语料目录

	checkRevisionsFn func() ([]int, error)
	syncRevisionsFn  func(ctx context.Context) (*revision.Result, error)
	exportFn         func(ctx context.Context, opts exp.Options) (*exp.Result, error)

	switchModelFn     func(role, provider, model string) error
	setRoleThinkingFn func(role, level string) error
	configureLangFn       func(ui, story string) error
	configureModelsFn     func(draft host.ModelConfigurationDraft) error
	testModelConnectionFn func(ctx context.Context, draft host.ModelConfigurationDraft, model string) error
	deleteProviderFn      func(provider string) error
	fetchRemoteModelsFn   func(ctx context.Context, draft host.FetchRemoteModelsDraft) ([]string, error)
}

func newFakeHost(t *testing.T) *fakeHost {
	t.Helper()
	return &fakeHost{
		dir:    t.TempDir(),
		events: make(chan host.Event, 64),
		stream: make(chan string, 64),
		done:   make(chan struct{}, 8),
	}
}

func (f *fakeHost) PrepareUserRules(p string) error {
	if f.prepareUserRulesFn != nil {
		return f.prepareUserRulesFn(p)
	}
	return nil
}

func (f *fakeHost) StartPrepared(r string) error {
	if f.startPreparedFn != nil {
		return f.startPreparedFn(r)
	}
	return nil
}

func (f *fakeHost) Resume() (string, error) {
	if f.resumeFn != nil {
		return f.resumeFn()
	}
	return "checkpoint: chapter 3", nil
}
func (f *fakeHost) Continue(text string) error {
	if f.continueFn != nil {
		return f.continueFn(text)
	}
	return nil
}

func (f *fakeHost) Reopen(direction string) error {
	if f.reopenFn != nil {
		return f.reopenFn(direction)
	}
	return nil
}

func (f *fakeHost) Steer(text string) error {
	if f.steerFn != nil {
		return f.steerFn(text)
	}
	return nil
}

func (f *fakeHost) Abort() bool {
	if f.abortFn != nil {
		return f.abortFn()
	}
	return true
}

func (f *fakeHost) SetAdvanceMode(m domain.ChapterAdvanceMode) error {
	if f.setAdvanceModeFn != nil {
		return f.setAdvanceModeFn(m)
	}
	return nil
}

func (f *fakeHost) AdvanceOneChapter() error {
	if f.advanceOneFn != nil {
		return f.advanceOneFn()
	}
	return nil
}

func (f *fakeHost) Events() <-chan host.Event { return f.events }
func (f *fakeHost) Stream() <-chan string     { return f.stream }
func (f *fakeHost) Done() <-chan struct{}     { return f.done }
func (f *fakeHost) ReplayQueue(int64) ([]domain.RuntimeQueueItem, error) {
	return []domain.RuntimeQueueItem{{Seq: 1, Summary: "dispatch writer", Agent: "writer", Category: "DISPATCH"}}, nil
}
func (f *fakeHost) Dir() string { return f.dir }

func (f *fakeHost) Snapshot() host.UISnapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snapshotVal
}

func (f *fakeHost) setSnapshot(s host.UISnapshot) {
	f.mu.Lock()
	f.snapshotVal = s
	f.mu.Unlock()
}

func (f *fakeHost) Close() {
	f.mu.Lock()
	f.closeCount++
	f.mu.Unlock()
	close(f.events)
	close(f.stream)
	close(f.done)
}

func (f *fakeHost) closeCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closeCount
}

func (f *fakeHost) PauseForCoCreate() bool {
	if f.pauseForCoCreateFn != nil {
		return f.pauseForCoCreateFn()
	}
	return true
}

func (f *fakeHost) CoCreateStream(ctx context.Context, h []host.CoCreateMessage, p func(string, string)) (host.CoCreateReply, error) {
	if f.coCreateStreamFn != nil {
		return f.coCreateStreamFn(ctx, h, p)
	}
	return host.CoCreateReply{Message: "ok", Prompt: "draft", Ready: true}, nil
}

func (f *fakeHost) StageCoCreateStream(ctx context.Context, h []host.CoCreateMessage, p func(string, string)) (host.CoCreateReply, error) {
	if f.stageCoCreateStreamF != nil {
		return f.stageCoCreateStreamF(ctx, h, p)
	}
	return host.CoCreateReply{Message: "stage ok", Prompt: "next arc brief", Ready: true}, nil
}

func (f *fakeHost) ResumeFromCoCreate(draft string) error {
	if f.resumeFromCoCreateF != nil {
		return f.resumeFromCoCreateF(draft)
	}
	return nil
}

func (f *fakeHost) CancelCoCreate() {
	f.mu.Lock()
	f.cancelCoCreateCalled = true
	f.mu.Unlock()
}

func (f *fakeHost) ImportFrom(ctx context.Context, opts imp.Options) (<-chan imp.Event, error) {
	if f.importFromFn != nil {
		return f.importFromFn(ctx, opts)
	}
	ch := make(chan imp.Event, 2)
	ch <- imp.Event{Stage: imp.StageDone, Current: 3, Total: 3, Message: "published"}
	close(ch)
	return ch, nil
}

func (f *fakeHost) ImportResumeHint() string { return "" }

func (f *fakeHost) Simulate(ctx context.Context, opts ...host.SimulateOption) (<-chan sim.Event, error) {
	dir := host.SimulateSourceDir(opts...)
	f.mu.Lock()
	f.lastSimulateSourceDir = dir
	f.mu.Unlock()
	if f.simulateFn != nil {
		return f.simulateFn(ctx, dir)
	}
	ch := make(chan sim.Event, 1)
	ch <- sim.Event{Stage: sim.StageDone, Message: "profile updated"}
	close(ch)
	return ch, nil
}

// simulateSourceDir 返回最近一次 Simulate 调用解析出的语料目录。
func (f *fakeHost) simulateSourceDir() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastSimulateSourceDir
}

func (f *fakeHost) ImportSimulationProfile(ctx context.Context, path string) (<-chan sim.Event, error) {
	if f.importSimPrfF != nil {
		return f.importSimPrfF(ctx, path)
	}
	ch := make(chan sim.Event, 1)
	ch <- sim.Event{Stage: sim.StageDone, Message: "imported"}
	close(ch)
	return ch, nil
}

func (f *fakeHost) CheckChapterRevisions() ([]int, error) {
	if f.checkRevisionsFn != nil {
		return f.checkRevisionsFn()
	}
	return nil, nil
}

func (f *fakeHost) SyncChapterRevisions(ctx context.Context) (*revision.Result, error) {
	if f.syncRevisionsFn != nil {
		return f.syncRevisionsFn(ctx)
	}
	return &revision.Result{Changed: []int{2}, Applied: []int{2}}, nil
}

func (f *fakeHost) Export(ctx context.Context, opts exp.Options) (*exp.Result, error) {
	if f.exportFn != nil {
		return f.exportFn(ctx, opts)
	}
	return &exp.Result{Path: "/tmp/out.txt", Chapters: 3, Bytes: 9000}, nil
}

func (f *fakeHost) ModelConfiguration() host.ModelConfigurationSnapshot {
	return host.ModelConfigurationSnapshot{
		DefaultProvider: "demo",
		DefaultModel:    "demo-model",
		Providers: []host.ProviderSnapshot{{
			Name: "demo", Type: "openai", HasAPIKey: true,
			APIKeyHint:     host.MaskAPIKey("sk-demo-0123456789abcdef"),
			RequiresAPIKey: true,
			Models:         []bootstrap.ModelConfig{{Name: "demo-model"}},
		}},
	}
}

func (f *fakeHost) ConfiguredProviders() []string { return []string{"demo"} }

func (f *fakeHost) ConfiguredModelOptions(provider string) []host.ConfiguredModel {
	return []host.ConfiguredModel{{Name: "demo-model", ContextWindow: 128000, ContextSource: bootstrap.CtxWindowModelConfig}}
}

func (f *fakeHost) CurrentModelSelection(role string) (string, string, bool) {
	return "demo", "demo-model", true
}

func (f *fakeHost) SwitchModel(role, provider, model string) error {
	if f.switchModelFn != nil {
		return f.switchModelFn(role, provider, model)
	}
	return nil
}

func (f *fakeHost) CurrentThinking(role string) string { return "high" }

func (f *fakeHost) AvailableThinking(role string) []agentcore.ThinkingLevel {
	return []agentcore.ThinkingLevel{"off", "low", "medium", "high"}
}

func (f *fakeHost) SetRoleThinking(role, level string) error {
	if f.setRoleThinkingFn != nil {
		return f.setRoleThinkingFn(role, level)
	}
	return nil
}

func (f *fakeHost) ConfigureLanguage(ui, story string) error {
	if f.configureLangFn != nil {
		return f.configureLangFn(ui, story)
	}
	return nil
}

func (f *fakeHost) ConfigureModels(draft host.ModelConfigurationDraft) error {
	if f.configureModelsFn != nil {
		return f.configureModelsFn(draft)
	}
	return nil
}

func (f *fakeHost) TestModelConnection(ctx context.Context, draft host.ModelConfigurationDraft, model string) error {
	if f.testModelConnectionFn != nil {
		return f.testModelConnectionFn(ctx, draft, model)
	}
	return nil
}

func (f *fakeHost) DeleteProvider(provider string) error {
	if f.deleteProviderFn != nil {
		return f.deleteProviderFn(provider)
	}
	return nil
}

func (f *fakeHost) FetchRemoteModels(ctx context.Context, draft host.FetchRemoteModelsDraft) ([]string, error) {
	if f.fetchRemoteModelsFn != nil {
		return f.fetchRemoteModelsFn(ctx, draft)
	}
	return []string{"gpt-4o", "gpt-4o-mini"}, nil
}

// ── 测试工具 ──

// lockedBuffer 是并发安全的 stdout 捕获。
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) lines() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return splitLines(b.buf.Bytes())
}

func splitLines(data []byte) []string {
	var out []string
	for _, l := range bytes.Split(data, []byte{'\n'}) {
		if len(bytes.TrimSpace(l)) == 0 {
			continue
		}
		out = append(out, string(l))
	}
	return out
}

// decodedLine 是一行协议输出的解析结果。
type decodedLine struct {
	kind string // request/response/event
	raw  map[string]any
}

func decodeLines(lines []string) ([]decodedLine, error) {
	out := make([]decodedLine, 0, len(lines))
	for _, l := range lines {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			return nil, err
		}
		out = append(out, decodedLine{kind: m["kind"].(string), raw: m})
	}
	return out, nil
}

// newTestDaemon 构造走假工厂的 daemon（无真实 host.New / 网络）。
func newTestDaemon(t *testing.T, h *fakeHost) (*Daemon, *lockedBuffer) {
	t.Helper()
	out := &lockedBuffer{}
	d := newDaemon(Options{
		Stdout:  out,
		Stderr:  &bytes.Buffer{},
		Session: "sess-test",
		NewHost: func(cfg bootstrap.Config, bundle assets.Bundle, outputDir string) (HostAPI, error) {
			return h, nil
		},
	})
	return d, out
}

// openFakeProject 直接挂一个假项目（绕过 openProject 的文件系统检查）并启动桥接。
func openFakeProject(d *Daemon, h *fakeHost) *projectState {
	p := &projectState{id: "project-test", path: h.dir, host: h}
	d.stateMu.Lock()
	d.proj = p
	d.stateMu.Unlock()
	d.startBridge(p)
	return p
}

// requestLineObj 便捷：以结构化对象序列化生成请求行（正确转义 Windows 路径中的反斜杠等特殊字符）。
func requestLineObj(id, method string, payload any) string {
	b, err := json.Marshal(map[string]any{
		"protocol": ProtocolID,
		"kind":     "request",
		"id":       id,
		"method":   method,
		"payload":  payload,
	})
	if err != nil {
		panic(err)
	}
	return string(b)
}

// doRequest 便捷：一行请求 → 处理 → 返回最后一条响应（handleLine 同步写回）。
func doRequest(t *testing.T, d *Daemon, line string) map[string]any {
	t.Helper()
	d.handleLine([]byte(line))
	var last map[string]any
	for _, l := range d.snapshotHistory() {
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("stdout 产出非 JSON 行: %q", l)
		}
		if m["kind"] == "response" {
			last = m
		}
	}
	if last == nil {
		t.Fatalf("请求未得到响应: %q\n输出:\n%s", line, stringsJoin(d.snapshotHistory()))
	}
	return last
}

// snapshotHistory 读取当前输出行（测试辅助；lockedBuffer 自带并发保护）。
func (d *Daemon) snapshotHistory() []string {
	w, ok := d.opts.Stdout.(*lockedBuffer)
	if !ok {
		return nil
	}
	return w.lines()
}

// awaitEvent 轮询输出直到出现指定事件（后台 goroutine 异步写入）。
func awaitEvent(t *testing.T, d *Daemon, name string) map[string]any {
	t.Helper()
	return awaitEventWhere(t, d, name, nil)
}

// awaitEventWhere 等待首个满足谓词的指定事件。
func awaitEventWhere(t *testing.T, d *Daemon, name string, where func(payload map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		for _, l := range d.snapshotHistory() {
			var m map[string]any
			if err := json.Unmarshal([]byte(l), &m); err != nil {
				t.Fatalf("stdout 产出非 JSON 行: %q", l)
			}
			if m["kind"] != "event" || m["event"] != name {
				continue
			}
			payload, _ := m["payload"].(map[string]any)
			if where == nil || where(payload) {
				return m
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("等待事件 %s 超时；输出:\n%s", name, stringsJoin(d.snapshotHistory()))
	return nil
}

func stringsJoin(parts []string) string {
	out := ""
	for _, p := range parts {
		out += p + "\n"
	}
	return out
}

func mustErrCode(t *testing.T, resp map[string]any) string {
	t.Helper()
	if resp == nil {
		t.Fatal("缺少响应")
	}
	if ok, _ := resp["ok"].(bool); ok {
		t.Fatalf("期望失败响应，得到: %v", resp)
	}
	errObj, _ := resp["error"].(map[string]any)
	if errObj == nil {
		t.Fatalf("失败响应缺 error: %v", resp)
	}
	code, _ := errObj["code"].(string)
	return code
}
