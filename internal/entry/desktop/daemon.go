// daemon.go —— desktop-v1 sidecar 守护进程：生命周期、协议流循环、事件桥接。
package desktop

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/voocel/agentcore"
	"github.com/voocel/ainovel-cli/assets"
	"github.com/voocel/ainovel-cli/internal/bootstrap"
	"github.com/voocel/ainovel-cli/internal/domain"
	"github.com/voocel/ainovel-cli/internal/entry/startup"
	"github.com/voocel/ainovel-cli/internal/errs"
	"github.com/voocel/ainovel-cli/internal/host"
	"github.com/voocel/ainovel-cli/internal/host/exp"
	"github.com/voocel/ainovel-cli/internal/host/imp"
	"github.com/voocel/ainovel-cli/internal/host/sim"
	"github.com/voocel/ainovel-cli/internal/revision"
)

// HostAPI 是 daemon 依赖的 Host 能力子集。生产实现是 *host.Host
// （构造走 host.New，含 desktop.log 文件日志）；测试注入假实现，
// 协议/分发测试绝不构建真实模型客户端。
type HostAPI interface {
	PrepareUserRules(rawPrompt string) error
	StartPrepared(rawRequirement string) error
	Resume() (string, error)
	Continue(text string) error
	Reopen(direction string) error
	Steer(text string) error
	Abort() bool
	SetAdvanceMode(mode domain.ChapterAdvanceMode) error
	AdvanceOneChapter() error

	Events() <-chan host.Event
	Stream() <-chan string
	Done() <-chan struct{}
	Snapshot() host.UISnapshot
	ReplayQueue(afterSeq int64) ([]domain.RuntimeQueueItem, error)
	Dir() string
	Close()

	PauseForCoCreate() bool
	CoCreateStream(ctx context.Context, history []host.CoCreateMessage, onProgress func(kind, text string)) (host.CoCreateReply, error)
	StageCoCreateStream(ctx context.Context, history []host.CoCreateMessage, onProgress func(kind, text string)) (host.CoCreateReply, error)
	ResumeFromCoCreate(draft string) error
	CancelCoCreate()

	ImportFrom(ctx context.Context, opts imp.Options) (<-chan imp.Event, error)
	ImportResumeHint() string
	Simulate(ctx context.Context, opts ...host.SimulateOption) (<-chan sim.Event, error)
	ImportSimulationProfile(ctx context.Context, path string) (<-chan sim.Event, error)

	CheckChapterRevisions() ([]int, error)
	SyncChapterRevisions(ctx context.Context) (*revision.Result, error)
	Export(ctx context.Context, opts exp.Options) (*exp.Result, error)

	ModelConfiguration() host.ModelConfigurationSnapshot
	ConfiguredProviders() []string
	ConfiguredModelOptions(provider string) []host.ConfiguredModel
	CurrentModelSelection(role string) (string, string, bool)
	SwitchModel(role, provider, model string) error
	CurrentThinking(role string) string
	AvailableThinking(role string) []agentcore.ThinkingLevel
	SetRoleThinking(role, level string) error
	ConfigureLanguage(uiLang, storyLang string) error
}

var _ HostAPI = (*host.Host)(nil) // 编译期断言：生产 Host 满足接口

// HostFactory 为一个输出目录构建 Host。outputDir 由调用方注入 cfg 前传入。
type HostFactory func(cfg bootstrap.Config, bundle assets.Bundle, outputDir string) (HostAPI, error)

// productionHostFactory 是生产工厂：与 TUI/headless 同一条 bootstrap/config/assets
// 路径，外加 desktop.log 文件日志（细节留档，stdout 永远只有协议）。
func productionHostFactory(cfg bootstrap.Config, bundle assets.Bundle, outputDir string) (HostAPI, error) {
	cfg.OutputDir = outputDir
	return host.New(cfg, bundle, host.WithFileLog("desktop.log", true, slog.String("entry", "desktop")))
}

// Options 配置 daemon；零值字段在 Run 内落默认。
type Options struct {
	Stdin   io.Reader
	Stdout  io.Writer
	Stderr  io.Writer // 协议之外的一切日志（会再镜像进 logs.replay 环形缓冲）
	Config  bootstrap.Config
	Bundle  assets.Bundle
	NewHost HostFactory // 测试注入；nil 用生产工厂
	Session string      // 测试可固定会话 id
}

// projectState 是当前打开的项目（每项目一个 Host，独占目录锁）。
type projectState struct {
	id         string
	path       string
	host       HostAPI
	cfg        bootstrap.Config // 本项目打开时的配置快照（含 story_language）
	storyLang  string           // 本项目 bundle 实际烘入的创作语言
	bridgeDone chan struct{}    // host 事件桥接 goroutine 退出信号
}

// runState 是桥接层为本会话 run 终态分类保留的意图标记。
type runState struct {
	active      bool
	runID       string
	goal        string
	abortReason string // 非空 = 用户请求过 abort/pause
	lastError   string // 非空 = 运行中观察到 ERROR 级事件
}

// cocreateState 承载共创会话（复用 startup.CoCreateSession 状态机）。
type cocreateState struct {
	session *startup.CoCreateSession
	stage   bool // true=阶段共创（暂停创作规划后续）；false=冷启动共创
	active  bool // 一轮 LLM 对话在途
	cancel  context.CancelFunc
}

// logRecord 是 logs.replay 回放的缓冲结构化日志。
type logRecord struct {
	Seq     int64             `json:"sequence"`
	Time    time.Time         `json:"time"`
	Level   string            `json:"level"`
	Module  string            `json:"module"`
	Message string            `json:"message"`
	Attrs   map[string]string `json:"attrs,omitempty"`
}

const (
	historyCap = 4096 // project.replay_events 的内存事件环
	logsCap    = 1024 // logs.replay 的日志环
)

// Daemon 是 sidecar 守护进程本体。
type Daemon struct {
	opts    Options
	session string

	out    *bufio.Writer // stdout（仅协议）
	stderr io.Writer

	// outMu 串行化「序号分配 + 写出一行」：保证 stdout 上事件按 sequence 严格递增。
	outMu   sync.Mutex
	seq     int64
	history []EventEnvelope

	logMu  sync.Mutex
	logSeq int64
	logs   []logRecord

	stateMu      sync.Mutex
	inFlight     map[string]struct{}
	proj         *projectState
	cocreate     *cocreateState
	run          runState
	importCancel context.CancelFunc
	simCancel    context.CancelFunc
	shuttingDown bool
	shutdownMsg  string

	dispatch map[string]func(*Request) *Response
}

// Run 启动 daemon：发出 engine.ready，进入 stdin 协议循环，退出前收尾。
func Run(opts Options) error {
	if opts.NewHost == nil {
		opts.NewHost = productionHostFactory
	}
	if opts.Stdin == nil {
		opts.Stdin = os.Stdin
	}
	if opts.Stdout == nil {
		opts.Stdout = os.Stdout
	}
	if opts.Stderr == nil {
		opts.Stderr = os.Stderr
	}
	d := newDaemon(opts)
	d.log("info", "daemon", "desktop daemon ready", "session", d.session)
	d.emitEvent("", "engine.ready", map[string]any{"recovered": false})

	err := d.loop()
	d.finalize(err)
	return err
}

// StartupError 在 daemon 尚未建立（如首次引导缺失、配置损坏）时向 w 写出
// 唯一一条 engine.error 事件行，让桌面端仍能结构化理解启动失败并落 stderr。
func StartupError(w io.Writer, code, message string) {
	env := EventEnvelope{
		Protocol: ProtocolID,
		Kind:     KindEvent,
		Event:    "engine.error",
		Sequence: 1,
		Payload:  map[string]any{"code": code, "message": redactString(message)},
	}
	data, err := json.Marshal(env)
	if err != nil {
		return
	}
	fmt.Fprintln(w, string(data))
}

func newDaemon(opts Options) *Daemon {
	session := opts.Session
	if session == "" {
		session = newID("sess")
	}
	d := &Daemon{
		opts:     opts,
		session:  session,
		out:      bufio.NewWriter(opts.Stdout),
		stderr:   opts.Stderr,
		inFlight: make(map[string]struct{}),
	}
	d.registerDispatch()
	return d
}

// ── 输出：响应与事件（stdout 仅协议；全部过脱敏）──

// writeResponse 写出一条响应（成功载荷 / 错误细节都先脱敏）。
func (d *Daemon) writeResponse(resp *Response) {
	if resp == nil {
		return
	}
	if resp.Session == "" {
		resp.Session = d.session
	}
	if resp.OK {
		resp.Payload = redactPayload(resp.Payload)
	} else if resp.Error != nil {
		resp.Error.Details = redactValue(resp.Error.Details)
		resp.Error.Message = redactString(resp.Error.Message)
	}
	d.writeLine(resp)
}

// emitEvent 分配序号、补齐身份、记录回放历史并写出一条事件。
func (d *Daemon) emitEvent(projectID, name string, payload map[string]any) {
	if payload == nil {
		payload = map[string]any{}
	}
	payload = redactPayload(payload)

	d.outMu.Lock()
	d.seq++
	env := EventEnvelope{
		Protocol:  ProtocolID,
		Kind:      KindEvent,
		Event:     name,
		ProjectID: projectID,
		Session:   d.session,
		Sequence:  d.seq,
		Payload:   payload,
	}
	d.history = append(d.history, env)
	if len(d.history) > historyCap {
		d.history = d.history[len(d.history)-historyCap:]
	}
	err := d.writeLineLocked(env)
	d.outMu.Unlock()
	if err != nil {
		d.log("error", "daemon", "write event failed", "err", err.Error())
	}
}

// writeLineLocked 写出一行 JSON；调用方必须持有 outMu（或为最终响应路径）。
func (d *Daemon) writeLineLocked(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if _, err := d.out.Write(append(data, '\n')); err != nil {
		return err
	}
	return d.out.Flush()
}

func (d *Daemon) writeLine(v any) {
	d.outMu.Lock()
	err := d.writeLineLocked(v)
	d.outMu.Unlock()
	if err != nil {
		d.log("error", "daemon", "write response failed", "err", err.Error())
	}
}

// ── 结构化日志（stderr + logs.replay 环）──

func (d *Daemon) log(level, module, msg string, kv ...any) {
	attrs := map[string]string{}
	for i := 0; i+1 < len(kv); i += 2 {
		if k, ok := kv[i].(string); ok {
			attrs[k] = fmt.Sprint(kv[i+1])
		}
	}
	d.logMu.Lock()
	d.logSeq++
	rec := logRecord{Seq: d.logSeq, Time: time.Now(), Level: level, Module: module, Message: redactString(msg), Attrs: attrs}
	d.logs = append(d.logs, rec)
	if len(d.logs) > logsCap {
		d.logs = d.logs[len(d.logs)-logsCap:]
	}
	d.logMu.Unlock()

	args := append([]any{"module", module}, kv...)
	switch level {
	case "error":
		slog.Error(msg, args...)
	case "warn":
		slog.Warn(msg, args...)
	default:
		slog.Info(msg, args...)
	}
}

// ── stdin 协议循环 ──

func (d *Daemon) loop() error {
	reader := bufio.NewReaderSize(d.opts.Stdin, 64<<10)
	for {
		if d.isShuttingDown() {
			return nil
		}
		line, err := reader.ReadString('\n')
		if line != "" {
			d.handleLine([]byte(strings.TrimRight(line, "\r\n")))
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				d.setShutdownReason("stdin closed")
				return nil
			}
			return fmt.Errorf("read stdin: %w", err)
		}
	}
}

// handleLine 处理一行输入：坏行走 engine.error 事件（绝不回响应），
// 合法请求走 handleRequest 并恰好回一条响应。shutdown 确认后停止接受请求。
func (d *Daemon) handleLine(line []byte) {
	if d.isShuttingDown() {
		return
	}
	trimmed := strings.TrimSpace(string(line))
	if trimmed == "" {
		return // 空行不是协议消息
	}
	if len(trimmed) > maxLineBytes {
		d.log("warn", "protocol", "oversized input line rejected", "bytes", len(trimmed))
		d.emitEvent("", "engine.error", map[string]any{
			"code":    CodeMalformedJSON,
			"message": fmt.Sprintf("input line exceeds %d bytes", maxLineBytes),
		})
		return
	}
	raw := []byte(trimmed)
	req, perr := decodeRequest(raw)
	if perr != nil {
		id := peekRequestID(raw)
		if perr.code == CodeMalformedJSON || id == "" {
			// 无法关联：engine.error 事件（payload.code 标明 malformed_json/invalid_payload）。
			d.log("warn", "protocol", "rejected input line", "code", perr.code, "err", perr.message)
			d.emitEvent("", "engine.error", map[string]any{"code": perr.code, "message": perr.message})
			return
		}
		d.log("warn", "protocol", "invalid request", "id", id, "code", perr.code, "err", perr.message)
		d.writeResponse(errorResponse(id, d.session, perr.code, perr.message, nil))
		return
	}

	resp := d.handleRequest(req)
	d.writeResponse(resp)
}

// handleRequest 校验在途 id 唯一性并分发；保证恰好一条终态响应。
//
// 命名返回值是 panic 兜底的关键：handler panic 时 recover 必须能在 defer 里
// 给 resp 赋一条 internal_error，否则函数带零值返回、请求永远得不到响应，
// 违反 README §3「a request is never left unanswered」。
func (d *Daemon) handleRequest(req *Request) (resp *Response) {
	d.stateMu.Lock()
	if _, busy := d.inFlight[req.ID]; busy {
		d.stateMu.Unlock()
		return errorResponse(req.ID, d.session, CodeDuplicateRequestID,
			fmt.Sprintf("request id %q is still in flight", req.ID), nil)
	}
	d.inFlight[req.ID] = struct{}{}
	d.stateMu.Unlock()
	defer func() {
		d.stateMu.Lock()
		delete(d.inFlight, req.ID)
		d.stateMu.Unlock()
	}()

	handler := d.dispatch[req.Method]
	if handler == nil {
		return errorResponse(req.ID, d.session, CodeUnknownMethod,
			fmt.Sprintf("method %q is not implemented", req.Method), nil)
	}

	defer func() {
		if r := recover(); r != nil {
			d.log("error", "daemon", "handler panic", "method", req.Method, "panic", fmt.Sprint(r))
			resp = errorResponse(req.ID, d.session, CodeInternalError,
				"internal daemon failure while handling "+req.Method, nil)
		}
	}()
	resp = handler(req)
	if resp == nil {
		// 编程错误（handler 返回 nil 且未 panic）：兜底 internal_error，绝不悬挂请求。
		resp = errorResponse(req.ID, d.session, CodeInternalError,
			"internal daemon failure while handling "+req.Method, nil)
	}
	resp.ID = req.ID
	return resp
}

// requireProject 返回当前打开的项目；未打开时返回 project_unavailable 响应。
func (d *Daemon) requireProject(req *Request) (*projectState, *Response) {
	d.stateMu.Lock()
	p := d.proj
	d.stateMu.Unlock()
	if p == nil {
		return nil, errorResponse(req.ID, d.session, CodeProjectUnavailable, "no project is open", nil)
	}
	return p, nil
}

// currentProjectID 返回当前项目 id（无则空串）。
func (d *Daemon) currentProjectID() string {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	if d.proj == nil {
		return ""
	}
	return d.proj.id
}

// ── 收尾 ──

func (d *Daemon) setShutdownReason(reason string) {
	d.stateMu.Lock()
	d.shuttingDown = true
	if d.shutdownMsg == "" {
		d.shutdownMsg = reason
	}
	d.stateMu.Unlock()
}

func (d *Daemon) isShuttingDown() bool {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	return d.shuttingDown
}

// finalize 关闭项目资源（等待桥接 goroutine 退出）并发出 engine.exited。
func (d *Daemon) finalize(cause error) {
	reason := "shutdown complete"
	if cause != nil {
		reason = cause.Error()
	} else {
		d.stateMu.Lock()
		if d.shutdownMsg != "" {
			reason = d.shutdownMsg
		}
		d.stateMu.Unlock()
	}
	d.closeProject()
	d.emitEvent("", "engine.exited", map[string]any{"reason": reason, "exit_code": 0})
	d.log("info", "daemon", "desktop daemon exited", "reason", reason)
}

// closeProject 关闭当前项目 Host（若无可直接返回）：取消在途异步作业、
// 关闭共创、复位 run 意图，等待事件桥接 goroutine 退出后再返回。
func (d *Daemon) closeProject() {
	d.stateMu.Lock()
	p := d.proj
	d.proj = nil
	if d.cocreate != nil {
		if d.cocreate.cancel != nil {
			d.cocreate.cancel()
		}
		d.cocreate = nil
	}
	if d.importCancel != nil {
		d.importCancel()
		d.importCancel = nil
	}
	if d.simCancel != nil {
		d.simCancel()
		d.simCancel = nil
	}
	d.run = runState{}
	d.stateMu.Unlock()

	if p == nil {
		return
	}
	p.host.Close()
	select {
	case <-p.bridgeDone:
	case <-time.After(5 * time.Second):
		d.log("warn", "daemon", "event bridge did not stop in time", "project", p.id)
	}
}

// ── Host 事件桥接 ──

// startBridge 为项目 Host 启动事件/流式/完成信号三路桥接 goroutine。
func (d *Daemon) startBridge(p *projectState) {
	p.bridgeDone = make(chan struct{})
	go d.bridgeHost(p)
}

func (d *Daemon) bridgeHost(p *projectState) {
	defer close(p.bridgeDone)
	for {
		select {
		case ev, ok := <-p.host.Events():
			if !ok {
				return
			}
			d.handleHostEvent(p, ev)
		case delta, ok := <-p.host.Stream():
			if !ok {
				continue // 通道关闭与 Events 同步发生，由 Events 分支退出
			}
			d.handleStreamDelta(p, delta)
		case _, ok := <-p.host.Done():
			if !ok {
				return
			}
			d.handleRunEnd(p)
		}
	}
}

// handleStreamDelta 把 Host 流式增量映射为 stream.delta / stream.clear。
func (d *Daemon) handleStreamDelta(p *projectState, delta string) {
	if delta == "" {
		return
	}
	if delta == host.StreamClearSentinel {
		d.emitEvent(p.id, "stream.clear", map[string]any{
			"channel": "prose", "reason": "stream round boundary",
		})
		return
	}
	d.emitEvent(p.id, "stream.delta", map[string]any{"text": delta, "channel": "prose"})
}

// handleHostEvent 把 Host.Event 按类别映射为协议事件。
//
// 映射（见 task-2 报告的完整表）：
//   - DISPATCH 开始          → run.step_changed{step: agent}
//   - ERROR/error 级         → engine.error（并记录为本会话 run 失败依据）
//   - warn 级                → notification.warning
//   - TOOL 完成 commit_chapter → chapter.updated + run.progress + usage.updated
//   - 其它完成/非调用事件     → notification.info（details 携带类别/agent/耗时）
func (d *Daemon) handleHostEvent(p *projectState, ev host.Event) {
	// 调用事件的「开始」半条（同 ID 开始/结束共用一条）。
	if ev.ID != "" && ev.FinishedAt.IsZero() {
		if ev.Category == "DISPATCH" && ev.Agent != "" {
			d.emitEvent(p.id, "run.step_changed", map[string]any{"step": ev.Agent})
		}
		return
	}

	msg := strings.TrimSpace(ev.Summary)
	if msg == "" {
		msg = strings.TrimSpace(ev.Detail)
	}
	if msg == "" {
		return
	}
	details := map[string]any{"category": ev.Category}
	if ev.Agent != "" {
		details["agent"] = ev.Agent
	}
	if ev.Duration > 0 {
		details["duration_ms"] = ev.Duration.Milliseconds()
	}
	if ev.Kind != "" {
		details["kind"] = ev.Kind
	}
	if ev.Failed {
		details["failed"] = true
	}

	switch {
	case ev.Category == "ERROR" || ev.Level == "error":
		code := CodeOperationFailed
		if ev.Kind != "" {
			code = ev.Kind
		}
		d.noteRunError(msg)
		d.emitEvent(p.id, "engine.error", map[string]any{"message": msg, "code": code})
	case ev.Level == "warn":
		d.emitEvent(p.id, "notification.warning", map[string]any{"message": msg, "details": details})
	default:
		if chapter, ok := committedChapter(ev); ok {
			d.emitEvent(p.id, "chapter.updated", map[string]any{"chapter": chapter, "status": "saved"})
			d.emitRunProgress(p)
			d.emitUsage(p)
			return
		}
		d.emitEvent(p.id, "notification.info", map[string]any{"message": msg, "details": details})
	}
}

// committedChapter 识别 commit_chapter 工具完成事件，提取章节号。
// 事件 Summary 形如 "commit_chapter(第3章)"（displayToolName 的既有格式）。
func committedChapter(ev host.Event) (int, bool) {
	if ev.Category != "TOOL" || ev.ID == "" || ev.FinishedAt.IsZero() {
		return 0, false
	}
	tool := ev.Summary
	if i := strings.IndexAny(tool, "(["); i > 0 {
		tool = tool[:i]
	}
	if tool != "commit_chapter" {
		return 0, false
	}
	rest := strings.TrimPrefix(ev.Summary, tool)
	for _, r := range rest {
		if r >= '0' && r <= '9' {
			n := 0
			if _, err := fmt.Sscanf(rest, "(第%d章)", &n); err == nil && n > 0 {
				return n, true
			}
			// 退路：抓第一段连续数字。
			var digits strings.Builder
			for _, c := range rest {
				if c >= '0' && c <= '9' {
					digits.WriteRune(c)
				} else if digits.Len() > 0 {
					break
				}
			}
			if digits.Len() > 0 {
				n = 0
				for _, c := range digits.String() {
					n = n*10 + int(c-'0')
				}
				if n > 0 {
					return n, true
				}
			}
			return 0, false
		}
	}
	return 0, false
}

// noteRunError 记录运行中错误，供 run 终态分类（failed 优先于 paused）。
func (d *Daemon) noteRunError(msg string) {
	d.stateMu.Lock()
	if d.run.active && d.run.lastError == "" {
		d.run.lastError = msg
	}
	d.stateMu.Unlock()
}

// noteAbort 记录用户 abort/pause 意图。
func (d *Daemon) noteAbort(reason string) {
	d.stateMu.Lock()
	if d.run.active && d.run.abortReason == "" {
		d.run.abortReason = reason
	}
	d.stateMu.Unlock()
}

// failRun 处理一次已接受 run 的异步启动失败（run.start / 冷启动 cocreate.resume）。
//
// 竞态纪律（StartPrepared 的裁定窗口可持续数秒，两个 run.start 都能通过
// IsRunning 预检，后发者会改写 d.run）：
//   - run.failed 终态事件**必须**发出（带自己的 run_id，客户端据终态收口），
//     不得因意图被后发 run 改写而吞掉；
//   - 只有当会话 run 意图仍属于本 run（runID 匹配）时才复位，
//     否则保留后发 run 的意图不被清空。
func (d *Daemon) failRun(p *projectState, runID string, err error) {
	d.stateMu.Lock()
	mine := d.run.active && d.run.runID == runID
	if mine {
		d.run = runState{}
	}
	d.stateMu.Unlock()
	d.log("error", "run", "start failed", "run_id", runID, "err", err.Error())
	d.emitEvent(p.id, "run.failed", map[string]any{
		"message": err.Error(), "code": classifyCode(err), "run_id": runID,
	})
}

// claimRun 在异步启动成功后认领会话 run 意图：并发 start 竞态下，
// 真正跑起来的 run 拥有意图（后发但失败的兄弟 run 已各自发出 run.failed）。
// 意图非 active（已被终态分类消费等）时不复活。
func (d *Daemon) claimRun(p *projectState, runID, goal string) {
	d.stateMu.Lock()
	if d.run.active {
		d.run.runID = runID
		d.run.goal = goal
	}
	d.stateMu.Unlock()
	d.emitEvent(p.id, "run.started", map[string]any{"run_id": runID, "goal": goal})
}

// markRunActive 登记一次 run 开始（run.start/resume/continue/retry 等入口），
// 发出 run.started；若引擎立即停机则就地触发终态分类。
func (d *Daemon) markRunActive(p *projectState, runID, goal string) {
	d.stateMu.Lock()
	d.run = runState{active: true, runID: runID, goal: goal}
	d.stateMu.Unlock()
	d.emitEvent(p.id, "run.started", map[string]any{"run_id": runID, "goal": goal})
	// 引擎可能瞬间完结（完本恢复等）：给 runEnded 的 Done 信号一点时间落点，
	// 未落则就地分类，保证终态事件恰好一条（状态被首次分类消费）。
	for i := 0; i < 10 && p.host.Snapshot().IsRunning == false; i++ {
		time.Sleep(20 * time.Millisecond)
	}
	if !p.host.Snapshot().IsRunning {
		d.handleRunEnd(p)
	}
}

// handleRunEnd 在 Done 信号（引擎循环结束）后按意图分类终态：
// complete → run.completed；记录过错误 → run.failed；abort 请求 → run.aborted；
// 其它停机 → run.paused。终态后附带 usage.updated。
func (d *Daemon) handleRunEnd(p *projectState) {
	// 先排空已入队事件（runEnded 在发送 Done 前已发出最终事件）。
	for {
		select {
		case ev, ok := <-p.host.Events():
			if !ok {
				d.classifyRunEnd(p)
				return
			}
			d.handleHostEvent(p, ev)
		default:
			d.classifyRunEnd(p)
			return
		}
	}
}

func (d *Daemon) classifyRunEnd(p *projectState) {
	d.stateMu.Lock()
	st := d.run
	d.run = runState{}
	d.stateMu.Unlock()

	snap := p.host.Snapshot()
	if !st.active {
		d.emitEvent(p.id, "engine.status_changed", map[string]any{"status": snap.RuntimeState})
		return
	}

	switch {
	case snap.Phase == string(domain.PhaseComplete):
		d.emitEvent(p.id, "run.completed", map[string]any{"summary": map[string]any{
			"chapters": snap.CompletedCount,
			"words":    snap.TotalWordCount,
			"title":    snap.BookTitle,
			"run_id":   st.runID,
		}})
	case st.lastError != "":
		d.emitEvent(p.id, "run.failed", map[string]any{
			"message": st.lastError, "code": CodeOperationFailed, "run_id": st.runID,
		})
	case st.abortReason != "":
		d.emitEvent(p.id, "run.aborted", map[string]any{"reason": st.abortReason, "run_id": st.runID})
	default:
		payload := map[string]any{
			"reason": "engine stopped; awaiting user action", "run_id": st.runID,
		}
		if snap.HasAdvanceHold {
			payload["advance_hold"] = true
			payload["reason"] = "engine paused at chapter advance gate"
		}
		d.emitEvent(p.id, "run.paused", payload)
	}
	d.emitUsage(p)
}

// emitRunProgress 用快照的章节数发出 run.progress。
func (d *Daemon) emitRunProgress(p *projectState) {
	snap := p.host.Snapshot()
	d.emitEvent(p.id, "run.progress", map[string]any{
		"completed": snap.CompletedCount,
		"total":     snap.TotalChapters,
		"detail":    "chapters committed",
	})
}

// emitUsage 用快照累计值发出 usage.updated（与 usage.snapshot 同构）。
func (d *Daemon) emitUsage(p *projectState) {
	d.emitEvent(p.id, "usage.updated", usagePayload(p.host.Snapshot()))
}

func usagePayload(snap host.UISnapshot) map[string]any {
	return map[string]any{
		"usage": map[string]any{
			"input_tokens":       snap.TotalInputTokens,
			"output_tokens":      snap.TotalOutputTokens,
			"cache_read_tokens":  snap.TotalCacheReadTokens,
			"cache_write_tokens": snap.TotalCacheWriteTokens,
			"cost_usd":           snap.TotalCostUSD,
			"saved_usd":          snap.TotalSavedUSD,
		},
		"budget": map[string]any{
			"limit_usd": snap.BudgetLimitUSD,
			"spent_usd": snap.TotalCostUSD,
		},
	}
}

// ── 项目 Host 生命周期 ──

// openProject 构建（或复用）一个项目 Host 并启动桥接。
func (d *Daemon) openProject(req *Request, path string, created bool) *Response {
	abs, err := filepath.Abs(path)
	if err != nil {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "invalid project path: "+err.Error(), nil)
	}
	if created {
		if err := os.MkdirAll(abs, 0o755); err != nil {
			return errorResponse(req.ID, d.session, CodeOperationFailed, "create project directory: "+err.Error(), nil)
		}
		if existing, err := projectHasContent(abs); err != nil {
			return errorResponse(req.ID, d.session, CodeOperationFailed, "inspect project directory: "+err.Error(), nil)
		} else if existing {
			return errorResponse(req.ID, d.session, CodeOperationFailed,
				"directory already contains a novel project; use project.open instead", nil)
		}
	} else if _, err := os.Stat(abs); err != nil {
		return errorResponse(req.ID, d.session, CodeOperationFailed, "project directory not accessible: "+err.Error(), nil)
	}

	d.stateMu.Lock()
	current := d.proj
	d.stateMu.Unlock()
	if current != nil && current.path == abs {
		// 幂等：重复打开同一路径直接返回现状。
		return successResponse(req.ID, d.session, map[string]any{
			"project_id": current.id, "path": current.path,
			"import_resume_hint": current.host.ImportResumeHint(),
		})
	}
	// Host 持目录独占锁：先关旧再开新。
	d.closeProject()

	// 本项目 bundle 按当前 story_language 重建：daemon 启动时的 bundle
	// 只反映启动瞬间，set_story_language 持久化后必须对新打开项目生效；
	// 测试注入的 NewHost 照常收到重建后的 bundle（fakeHost 忽略内容）。
	projCfg := d.opts.Config
	projCfg.OutputDir = abs
	projCfg.FillDefaults()
	bundle := d.opts.Bundle
	if strings.TrimSpace(projCfg.StoryLanguage) != "" {
		loadOpts := assets.DefaultLoadOptions(abs)
		loadOpts.StoryLanguage = projCfg.StoryLanguage
		bundle = assets.Load(projCfg.Style, loadOpts)
	}
	h, err := d.opts.NewHost(projCfg, bundle, abs)
	if err != nil {
		d.log("error", "project", "open host failed", "dir", abs, "err", err.Error())
		return errorResponse(req.ID, d.session, CodeOperationFailed,
			"open project host failed: "+redactString(err.Error()), nil)
	}
	p := &projectState{id: projectID(abs), path: abs, host: h, cfg: projCfg, storyLang: projCfg.StoryLanguage}
	d.stateMu.Lock()
	d.proj = p
	d.stateMu.Unlock()
	d.startBridge(p)
	d.log("info", "project", "project opened", "dir", abs, "project_id", p.id)
	payload := map[string]any{
		"project_id": p.id,
		"path":       abs,
	}
	if hint := h.ImportResumeHint(); hint != "" {
		payload["import_resume_hint"] = hint
	}
	if created {
		payload["created"] = true
	}
	return successResponse(req.ID, d.session, payload)
}

// projectHasContent 报告目录是否已含小说工程痕迹（进度/章节/书信息）。
func projectHasContent(dir string) (bool, error) {
	for _, rel := range []string{"meta/progress.json", "meta/book.json"} {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(rel))); err == nil {
			return true, nil
		} else if !os.IsNotExist(err) {
			return false, err
		}
	}
	if entries, err := os.ReadDir(filepath.Join(dir, "chapters")); err == nil && len(entries) > 0 {
		return true, nil
	} else if err != nil && !os.IsNotExist(err) {
		return false, err
	}
	return false, nil
}

// ── 工具 ──

// newID 生成 prefix-<8 hex> 随机标识。
func newID(prefix string) string {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%s-%d", prefix, time.Now().UnixNano())
	}
	return prefix + "-" + hex.EncodeToString(b[:])
}

// projectID 由绝对路径派生稳定项目 id。
func projectID(abs string) string {
	return newIDStable("project", abs)
}

func newIDStable(prefix, seed string) string {
	return prefix + "-" + sha256Sum(seed)[:8]
}

func sha256Sum(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// classifyCode 把引擎/宿主错误映射到稳定协议错误码。
//
// 依据（host.go 的实际错误文案，均为引擎语义而非协议契约）：
//   - 互斥占用（“运行中/进行中/请先…”、”already running”）→ host_busy
//   - 配置类（errs.ErrConfig 包装）→ invalid_payload
//   - 取消 → cancelled
//   - 其余 → operation_failed
func classifyCode(err error) string {
	if err == nil {
		return CodeOperationFailed
	}
	msg := err.Error()
	switch {
	case errors.Is(err, context.Canceled):
		return CodeCancelled
	case errors.Is(err, errs.ErrConfig):
		return CodeInvalidPayload
	case strings.Contains(msg, "already running"),
		strings.Contains(msg, "运行中"),
		strings.Contains(msg, "进行中，请先"),
		strings.Contains(msg, "正在关闭"),
		strings.Contains(msg, "正在停止"):
		return CodeHostBusy
	default:
		return CodeOperationFailed
	}
}
