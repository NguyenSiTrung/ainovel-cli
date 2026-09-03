// dispatch.go —— 方法分发表：48 个 desktop-v1 方法到 Host API 的映射。
//
// 长操作（run.start / cocreate / import / simulation / revisions.sync）按协议先回
// 接受响应（或同步拒绝 host_busy/project_unavailable/invalid_payload），进度与
// 终态经事件流异步送达；触发请求的响应已发出，异步失败走 engine.error /
// run.failed 等事件（README §5 错误路由）。
package desktop

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/voocel/ainovel-cli/internal/domain"
	"github.com/voocel/ainovel-cli/internal/entry/startup"
	"github.com/voocel/ainovel-cli/internal/host"
	"github.com/voocel/ainovel-cli/internal/host/imp"
	"github.com/voocel/ainovel-cli/internal/host/sim"
	"github.com/voocel/ainovel-cli/internal/i18n"
)

func (d *Daemon) registerDispatch() {
	d.dispatch = map[string]func(*Request) *Response{
		// engine
		"engine.ping":     d.handlePing,
		"engine.shutdown": d.handleShutdown,

		// project 生命周期
		"project.create":        d.handleProjectCreate,
		"project.open":          d.handleProjectOpen,
		"project.close":         d.handleProjectClose,
		"project.snapshot":      d.handleProjectSnapshot,
		"project.resume":        d.handleProjectResume,
		"project.reopen":        d.handleProjectReopen,
		"project.replay_events": d.handleReplayEvents,

		// run 控制
		"run.start":               d.handleRunStart,
		"run.continue":            d.handleRunContinue,
		"run.steer":               d.handleRunSteer,
		"run.abort":               d.handleRunAbort,
		"run.pause":               d.handleRunPause,
		"run.advance_one_chapter": d.handleAdvanceOneChapter,
		"run.set_advance_mode":    d.handleSetAdvanceMode,
		"run.retry":               d.handleRunRetry,

		// 共创
		"cocreate.start":  d.handleCoCreateStart,
		"cocreate.stage":  d.handleCoCreateStage,
		"cocreate.resume": d.handleCoCreateResume,
		"cocreate.cancel": d.handleCoCreateCancel,

		// 导入 / 仿写
		"import.start":              d.handleImportStart,
		"import.resume":             d.handleImportResume,
		"import.cancel":             d.handleImportCancel,
		"simulation.start":          d.handleSimulationStart,
		"simulation.resume":         d.handleSimulationResume,
		"simulation.cancel":         d.handleSimulationCancel,
		"simulation.profile_import": d.handleSimulationProfileImport,

		// 章节 / 修订 / 导出
		"chapter.list":            d.handleChapterList,
		"chapter.read":            d.handleChapterRead,
		"chapter.save":            d.handleChapterSave,
		"chapter.revisions.check": d.handleRevisionsCheck,
		"chapter.revisions.sync":  d.handleRevisionsSync,
		"chapter.export":          d.handleChapterExport,

		// 工件只读投影（facts / world / summary）
		"artifacts.read": d.handleArtifactsRead,

		// 配置
		"config.get":                d.handleConfigGet,
		"config.update":             d.handleConfigUpdate,
		"config.providers":          d.handleConfigProviders,
		"config.models":             d.handleConfigModels,
		"config.switch_model":       d.handleConfigSwitchModel,
		"config.thinking_levels":    d.handleConfigThinkingLevels,
		"config.set_thinking":       d.handleConfigSetThinking,
		"config.set_language":       d.handleConfigSetLanguage,
		"config.set_story_language": d.handleConfigSetStoryLanguage,

		// 诊断 / 用量 / 日志 / 队列
		"diagnostics.snapshot": d.handleDiagnosticsSnapshot,
		"diagnostics.export":   d.handleDiagnosticsExport,
		"usage.snapshot":       d.handleUsageSnapshot,
		"logs.replay":          d.handleLogsReplay,
		"runtime.queue":        d.handleRuntimeQueue,
	}
}

// opFailed 便捷构造 operation_failed（完整错误已由调用方落 sidecar 日志时使用 err 消息）。
func (d *Daemon) opFailed(req *Request, err error) *Response {
	return d.opFailedMsg(req, err.Error())
}

func (d *Daemon) opFailedMsg(req *Request, msg string) *Response {
	return errorResponse(req.ID, d.session, CodeOperationFailed, msg, nil)
}

// ── engine ──

func (d *Daemon) handlePing(req *Request) *Response {
	payload := map[string]any{"pong": true, "protocol": ProtocolID}
	if pid := d.currentProjectID(); pid != "" {
		payload["project_id"] = pid
	}
	return successResponse(req.ID, d.session, payload)
}

func (d *Daemon) handleShutdown(req *Request) *Response {
	reason := payloadString(req.Payload, "reason")
	if reason == "" {
		reason = "requested by client"
	}
	d.setShutdownReason(reason)
	d.log("info", "daemon", "shutdown requested", "reason", reason)
	return successResponse(req.ID, d.session, map[string]any{"shutting_down": true, "reason": reason})
}

// ── project ──

func (d *Daemon) handleProjectCreate(req *Request) *Response {
	path := strings.TrimSpace(payloadString(req.Payload, "path"))
	if path == "" {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "path is required", nil)
	}
	name := strings.TrimSpace(payloadString(req.Payload, "name"))
	resp := d.openProject(req, path, true)
	if resp.OK && name != "" {
		resp.Payload["name"] = name // 引擎不落盘项目名；仅回显供客户端显示
	}
	return resp
}

func (d *Daemon) handleProjectOpen(req *Request) *Response {
	path := strings.TrimSpace(payloadString(req.Payload, "path"))
	if path == "" {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "path is required", nil)
	}
	return d.openProject(req, path, false)
}

func (d *Daemon) handleProjectClose(req *Request) *Response {
	d.stateMu.Lock()
	p := d.proj
	d.stateMu.Unlock()
	if p == nil {
		return errorResponse(req.ID, d.session, CodeProjectUnavailable, "no project is open", nil)
	}
	d.closeProject()
	return successResponse(req.ID, d.session, map[string]any{"closed": true, "path": p.path})
}

func (d *Daemon) handleProjectSnapshot(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	return successResponse(req.ID, d.session, snapshotPayload(p.host.Snapshot()))
}

// handleProjectResume → Host.Resume()（崩溃/中断恢复）。checkpoint_id 为可选：
// 引擎恢复语义固定取最新检查点，指定历史检查点不被支持，显式回绝避免静默错行为。
func (d *Daemon) handleProjectResume(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	if cp := strings.TrimSpace(payloadString(req.Payload, "checkpoint_id")); cp != "" {
		return errorResponse(req.ID, d.session, CodeInvalidPayload,
			"resuming a specific checkpoint is not supported; the engine always resumes from the latest state", nil)
	}
	label, err := p.host.Resume()
	if err != nil {
		d.log("warn", "project", "resume failed", "err", err.Error())
		return errorResponse(req.ID, d.session, classifyCode(err), err.Error(), nil)
	}
	if label == "" {
		return successResponse(req.ID, d.session, map[string]any{
			"resumed": false, "reason": "no resumable session in this project",
		})
	}
	d.markRunActive(p, newID("run"), "resume: "+label)
	return successResponse(req.ID, d.session, map[string]any{"resumed": true, "label": label})
}

// handleProjectReopen 镜像 TUI 的 /reopen 命令（internal/entry/tui/commands.go:213-228）：
// 重开已完结的小说继续创作。可选 direction 登记为待处理干预（经 Arbiter 裁定注入），
// 再调用 Host.Resume() 续跑引擎。
func (d *Daemon) handleProjectReopen(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	if p.host.Snapshot().IsRunning {
		return errorResponse(req.ID, d.session, CodeHostBusy,
			"a generation run is already active", map[string]any{"active_request": "project.reopen"})
	}

	direction := strings.TrimSpace(payloadString(req.Payload, "direction"))
	if err := p.host.Reopen(direction); err != nil {
		d.log("warn", "project", "reopen failed", "err", err.Error())
		return errorResponse(req.ID, d.session, classifyCode(err), err.Error(), nil)
	}

	label, err := p.host.Resume()
	if err != nil {
		d.log("warn", "project", "resume after reopen failed", "err", err.Error())
		return errorResponse(req.ID, d.session, classifyCode(err), err.Error(), nil)
	}
	via := "project.reopen"
	if direction != "" {
		via += ": " + direction
	}
	d.markRunActive(p, newID("run"), via)
	payload := map[string]any{"reopened": true, "label": label}
	if direction != "" {
		payload["direction"] = direction
	}
	return successResponse(req.ID, d.session, payload)
}

// handleReplayEvents 重放本会话内存事件环（保留原 sequence，供去重/续传）。
func (d *Daemon) handleReplayEvents(req *Request) *Response {
	after, hasAfter, err := payloadInt64(req.Payload, "after_sequence")
	if err != nil {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, err.Error(), nil)
	}
	if !hasAfter {
		after = 0
	}
	limit, hasLimit, err := payloadInt64(req.Payload, "limit")
	if err != nil {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, err.Error(), nil)
	}
	if hasLimit && limit < 1 {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "limit must be >= 1", nil)
	}

	d.outMu.Lock()
	history := make([]EventEnvelope, len(d.history))
	copy(history, d.history)
	lastSeq := d.seq
	d.outMu.Unlock()

	replayed := 0
	for _, env := range history {
		if env.Sequence <= after {
			continue
		}
		if hasLimit && int64(replayed) >= limit {
			break
		}
		d.outMu.Lock()
		err := d.writeLineLocked(env)
		d.outMu.Unlock()
		if err != nil {
			d.log("error", "protocol", "replay write failed", "err", err.Error())
			break
		}
		replayed++
	}
	payload := map[string]any{"replayed": replayed, "last_sequence": lastSeq}
	if replayed == 0 {
		payload["advise"] = "project.snapshot"
	}
	return successResponse(req.ID, d.session, payload)
}

// ── run ──

// handleRunStart 镜像 headless.Run 的启动路径（internal/entry/headless/run.go）：
// PrepareQuick → PrepareUserRules（增强路径，失败降级告警）→ StartPrepared。
func (d *Daemon) handleRunStart(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	goal := strings.TrimSpace(payloadString(req.Payload, "goal"))
	if goal == "" {
		return errorResponse(req.ID, d.session, CodeInvalidPayload,
			"goal is required to start a generation run", nil)
	}
	prompt, err := startup.PrepareQuick(goal)
	if err != nil {
		return d.opFailed(req, err)
	}
	if p.host.Snapshot().IsRunning {
		return errorResponse(req.ID, d.session, CodeHostBusy,
			"a generation run is already active", map[string]any{"active_request": "run.start"})
	}

	runID := newID("run")
	d.stateMu.Lock()
	d.run = runState{active: true, runID: runID, goal: goal}
	d.stateMu.Unlock()

	go func() {
		if err := p.host.PrepareUserRules(prompt); err != nil {
			d.log("warn", "run", "user rules normalization failed; continuing with raw prompt", "err", err.Error())
			d.emitEvent(p.id, "notification.warning", map[string]any{
				"message": "user rule normalization failed; continuing with raw prompt: " + err.Error(),
			})
		}
		if err := p.host.StartPrepared(prompt); err != nil {
			d.failRun(p, runID, err)
			return
		}
		d.claimRun(p, runID, goal)
	}()
	return successResponse(req.ID, d.session, map[string]any{"accepted": true, "run_id": runID})
}

// handleRunContinue 续跑引擎。若携带 instruction，镜像 TUI 停机态输入
// （internal/entry/tui/model_update.go:325 经 Host.Continue(text) 进入 Arbiter
// 裁定并在必要时重启引擎）；若无 instruction，保持既有行为：从 store 事实续跑（Resume）。
func (d *Daemon) handleRunContinue(req *Request) *Response {
	instruction := strings.TrimSpace(payloadString(req.Payload, "instruction"))
	if instruction == "" {
		return d.restartFromStoppedState(req, "run.continue")
	}

	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	if p.host.Snapshot().IsRunning {
		return errorResponse(req.ID, d.session, CodeHostBusy,
			"a generation run is already active", map[string]any{"active_request": "run.continue"})
	}

	if err := p.host.Continue(instruction); err != nil {
		d.log("warn", "run", "continue with instruction failed", "err", err.Error())
		return errorResponse(req.ID, d.session, classifyCode(err), err.Error(), nil)
	}
	d.markRunActive(p, newID("run"), "run.continue: "+instruction)
	return successResponse(req.ID, d.session, map[string]any{
		"resumed": true, "instruction": instruction, "via": "run.continue",
	})
}

// handleRunRetry 重试最近失败步骤：TUI 无独立 retry 命令；失败后的恢复动作
// 是从落盘事实重启引擎（Resume，见 task-2 报告的映射论证）。
func (d *Daemon) handleRunRetry(req *Request) *Response {
	return d.restartFromStoppedState(req, "run.retry")
}

// restartFromStoppedState 是 run.continue / run.retry 共用的停机态重启路径。
func (d *Daemon) restartFromStoppedState(req *Request, via string) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	if p.host.Snapshot().IsRunning {
		return errorResponse(req.ID, d.session, CodeHostBusy,
			"a generation run is already active", map[string]any{"active_request": via})
	}
	label, err := p.host.Resume()
	if err != nil {
		d.log("warn", "run", "restart failed", "via", via, "err", err.Error())
		return errorResponse(req.ID, d.session, classifyCode(err), err.Error(), nil)
	}
	if label == "" {
		return d.opFailedMsg(req, "no stopped run to resume; use run.start with a goal for a new book")
	}
	d.markRunActive(p, newID("run"), via+": "+label)
	return successResponse(req.ID, d.session, map[string]any{"resumed": true, "label": label, "via": via})
}

func (d *Daemon) handleRunSteer(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	instruction := strings.TrimSpace(payloadString(req.Payload, "instruction"))
	if instruction == "" {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "instruction is required", nil)
	}
	if err := p.host.Steer(instruction); err != nil {
		d.log("warn", "run", "steer failed", "err", err.Error())
		return errorResponse(req.ID, d.session, classifyCode(err), err.Error(), nil)
	}
	return successResponse(req.ID, d.session, map[string]any{"steered": true})
}

// handleRunAbort → Host.Abort()。引擎的 Abort 即暂停（控制方裁定：
// run.pause 与 run.abort 都映射到 Abort，仅意图标记不同）。
func (d *Daemon) handleRunAbort(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	reason := strings.TrimSpace(payloadString(req.Payload, "reason"))
	if reason == "" {
		reason = "user requested stop"
	}
	stopped := p.host.Abort()
	if stopped {
		d.noteAbort(reason)
	}
	return successResponse(req.ID, d.session, map[string]any{"stopped": stopped})
}

func (d *Daemon) handleRunPause(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	paused := p.host.Abort()
	if paused {
		d.noteAbort("user requested pause")
	}
	return successResponse(req.ID, d.session, map[string]any{"paused": paused})
}

func (d *Daemon) handleAdvanceOneChapter(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	if err := p.host.AdvanceOneChapter(); err != nil {
		d.log("warn", "run", "advance one chapter failed", "err", err.Error())
		return errorResponse(req.ID, d.session, classifyCode(err), err.Error(), nil)
	}
	d.markRunActive(p, newID("run"), "advance one chapter")
	return successResponse(req.ID, d.session, map[string]any{"authorized": true})
}

func (d *Daemon) handleSetAdvanceMode(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	mode := strings.TrimSpace(payloadString(req.Payload, "mode"))
	var engineMode domain.ChapterAdvanceMode
	switch strings.ToLower(mode) {
	case "auto":
		engineMode = domain.ChapterAdvanceAuto
	case "review", "manual": // 协议示例用 manual；引擎语义是逐章验收（review）
		engineMode = domain.ChapterAdvanceReview
	default:
		return errorResponse(req.ID, d.session, CodeInvalidPayload,
			fmt.Sprintf("unknown advance mode %q (supported: auto, review)", mode), nil)
	}
	if err := p.host.SetAdvanceMode(engineMode); err != nil {
		return errorResponse(req.ID, d.session, classifyCode(err), err.Error(), nil)
	}
	return successResponse(req.ID, d.session, map[string]any{"mode": strings.ToLower(mode)})
}

// ── 共创（状态机复用 internal/entry/startup.CoCreateSession）──

func (d *Daemon) handleCoCreateStart(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	message := strings.TrimSpace(payloadString(req.Payload, "message"))
	if message == "" {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "message is required", nil)
	}
	stage := strings.EqualFold(strings.TrimSpace(payloadString(req.Payload, "mode")), "stage")

	d.stateMu.Lock()
	if d.cocreate != nil && d.cocreate.active {
		d.stateMu.Unlock()
		return errorResponse(req.ID, d.session, CodeHostBusy,
			"a co-create round is already in flight", map[string]any{"active_request": "cocreate.start"})
	}
	d.stateMu.Unlock()

	if stage && !p.host.PauseForCoCreate() {
		return d.opFailedMsg(req, "cannot enter stage co-create now (book completed or engine stopping)")
	}
	cc := &cocreateState{session: startup.NewCoCreateSession(message), stage: stage, active: true}
	d.stateMu.Lock()
	d.cocreate = cc
	d.stateMu.Unlock()
	go d.runCoCreateRound(p, cc)
	return successResponse(req.ID, d.session, map[string]any{"accepted": true, "mode": cocreateMode(stage)})
}

func (d *Daemon) handleCoCreateStage(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	message := strings.TrimSpace(payloadString(req.Payload, "message"))
	if message == "" {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "message is required", nil)
	}
	d.stateMu.Lock()
	cc := d.cocreate
	if cc != nil && cc.active {
		d.stateMu.Unlock()
		return errorResponse(req.ID, d.session, CodeHostBusy,
			"a co-create round is already in flight", map[string]any{"active_request": "cocreate.stage"})
	}
	if cc == nil {
		d.stateMu.Unlock()
		return d.opFailedMsg(req, "no co-create session; start one with cocreate.start")
	}
	cc.session.AppendUser(message)
	cc.active = true
	d.stateMu.Unlock()
	go d.runCoCreateRound(p, cc)
	return successResponse(req.ID, d.session, map[string]any{"accepted": true, "mode": cocreateMode(cc.stage)})
}

// runCoCreateRound 执行一轮共创 LLM 对话：流式进度 → cocreate.progress，
// 终态回复（含 draft/ready/suggestions）→ 一条终态 cocreate.progress；
// 失败 → engine.error 事件（请求的接受响应早已发出）。
func (d *Daemon) runCoCreateRound(p *projectState, cc *cocreateState) {
	ctx, cancel := context.WithCancel(context.Background())
	d.stateMu.Lock()
	cc.cancel = cancel
	d.stateMu.Unlock()
	defer func() {
		cancel()
		d.stateMu.Lock()
		cc.cancel = nil
		cc.active = false
		d.stateMu.Unlock()
	}()

	history := cc.session.History()
	onProgress := func(kind, text string) {
		d.emitEvent(p.id, "cocreate.progress", map[string]any{"stage": kind, "message": text})
	}
	var reply host.CoCreateReply
	var err error
	if cc.stage {
		reply, err = p.host.StageCoCreateStream(ctx, history, onProgress)
	} else {
		reply, err = p.host.CoCreateStream(ctx, history, onProgress)
	}
	if err != nil {
		d.log("warn", "cocreate", "round failed", "stage", cc.stage, "err", err.Error())
		code := classifyCode(err)
		d.emitEvent(p.id, "engine.error", map[string]any{
			"code": code, "message": "co-create round failed: " + err.Error(),
		})
		return
	}
	cc.session.ApplyReply(reply)
	// 终态事件用 stage=assistant，与流式预览（thinking/reply）区分。
	d.emitEvent(p.id, "cocreate.progress", map[string]any{
		"stage":       "assistant",
		"message":     reply.Message,
		"ready":       reply.Ready,
		"draft":       reply.Prompt,
		"suggestions": reply.Suggestions,
	})
}

// handleCoCreateResume 把共创产物交还引擎：阶段共创 → ResumeFromCoCreate；
// 冷启动共创 → 以 draft 为需求走 run.start 同款启动路径。
func (d *Daemon) handleCoCreateResume(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	d.stateMu.Lock()
	cc := d.cocreate
	if cc != nil && cc.active {
		d.stateMu.Unlock()
		return errorResponse(req.ID, d.session, CodeHostBusy,
			"a co-create round is already in flight", map[string]any{"active_request": "cocreate.resume"})
	}
	d.stateMu.Unlock()
	if cc == nil {
		return d.opFailedMsg(req, "no co-create session; start one with cocreate.start")
	}
	draft, err := cc.session.BuildPrompt()
	if err != nil {
		return d.opFailedMsg(req, "co-create draft is not ready yet; continue the conversation first")
	}

	if cc.stage {
		if err := p.host.ResumeFromCoCreate(draft); err != nil {
			d.log("warn", "cocreate", "resume from co-create failed", "err", err.Error())
			return errorResponse(req.ID, d.session, classifyCode(err), err.Error(), nil)
		}
		d.markRunActive(p, newID("run"), "resume from stage co-create")
		return successResponse(req.ID, d.session, map[string]any{"resumed": true, "mode": "stage"})
	}

	if p.host.Snapshot().IsRunning {
		return errorResponse(req.ID, d.session, CodeHostBusy,
			"a generation run is already active", map[string]any{"active_request": "cocreate.resume"})
	}
	runID := newID("run")
	d.stateMu.Lock()
	d.run = runState{active: true, runID: runID, goal: draft}
	d.stateMu.Unlock()
	go func() {
		if err := p.host.PrepareUserRules(draft); err != nil {
			d.log("warn", "cocreate", "user rules normalization failed; continuing", "err", err.Error())
		}
		if err := p.host.StartPrepared(draft); err != nil {
			d.failRun(p, runID, err)
			return
		}
		d.claimRun(p, runID, "co-create draft")
	}()
	return successResponse(req.ID, d.session, map[string]any{"accepted": true, "mode": "cold", "run_id": runID})
}

func (d *Daemon) handleCoCreateCancel(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	reason := strings.TrimSpace(payloadString(req.Payload, "reason"))
	d.stateMu.Lock()
	cc := d.cocreate
	d.cocreate = nil
	d.stateMu.Unlock()
	if cc == nil {
		return successResponse(req.ID, d.session, map[string]any{"cancelled": false, "reason": "no co-create session"})
	}
	if cc.cancel != nil {
		cc.cancel()
	}
	if cc.stage {
		p.host.CancelCoCreate()
	}
	if reason == "" {
		reason = "user cancelled co-create"
	}
	d.emitEvent(p.id, "notification.info", map[string]any{"message": "co-create cancelled: " + reason})
	return successResponse(req.ID, d.session, map[string]any{"cancelled": true, "stage": cocreateMode(cc.stage)})
}

func cocreateMode(stage bool) string {
	if stage {
		return "stage"
	}
	return "cold"
}

// ── 导入 ──

func impOptionsFromPayload(req *Request) (imp.Options, error) {
	opts := imp.Options{
		SourcePath: strings.TrimSpace(payloadString(req.Payload, "source_path")),
	}
	raw, ok := req.Payload["options"]
	if !ok || raw == nil {
		return opts, nil
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return opts, errors.New("options must be an object")
	}
	if v, ok := m["auto_confirm"].(bool); ok {
		opts.AutoConfirm = v
	}
	if v, ok := m["continue_after"].(bool); ok {
		opts.ContinueAfter = v
	}
	if v, ok := m["story_resolution"].(string); ok && v != "" {
		if v != "open" && v != "closed" {
			return opts, errors.New("options.story_resolution must be open or closed")
		}
		opts.StoryResolution = v
	}
	if v, ok := m["guidance"].(string); ok {
		opts.Guidance = strings.TrimSpace(v)
	}
	return opts, nil
}

// startImport 是 import.start / import.resume 的共用入口（resume = 空 Options 重入）。
func (d *Daemon) startImport(req *Request, opts imp.Options) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	ctx, cancel := context.WithCancel(context.Background())
	ch, err := p.host.ImportFrom(ctx, opts)
	if err != nil {
		cancel()
		d.log("warn", "import", "start failed", "err", err.Error())
		return errorResponse(req.ID, d.session, classifyCode(err), err.Error(), nil)
	}
	d.stateMu.Lock()
	d.importCancel = cancel
	d.stateMu.Unlock()
	go d.drainImport(p, ch)
	return successResponse(req.ID, d.session, map[string]any{
		"accepted": true, "source_path": opts.SourcePath,
	})
}

func (d *Daemon) handleImportStart(req *Request) *Response {
	opts, err := impOptionsFromPayload(req)
	if err != nil {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, err.Error(), nil)
	}
	if opts.SourcePath == "" {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "source_path is required", nil)
	}
	if _, err := os.Stat(opts.SourcePath); err != nil {
		return d.opFailed(req, fmt.Errorf("source file not accessible: %w", err))
	}
	return d.startImport(req, opts)
}

// handleImportResume 镜像 TUI /import 无参恢复：空 Options 从活动工作区续跑。
func (d *Daemon) handleImportResume(req *Request) *Response {
	return d.startImport(req, imp.Options{})
}

func (d *Daemon) handleImportCancel(req *Request) *Response {
	d.stateMu.Lock()
	cancel := d.importCancel
	d.importCancel = nil
	d.stateMu.Unlock()
	if cancel == nil {
		return successResponse(req.ID, d.session, map[string]any{"cancelled": false, "reason": "no import in progress"})
	}
	cancel()
	return successResponse(req.ID, d.session, map[string]any{"cancelled": true})
}

// drainImport 消费导入事件通道直至关闭：进度 → import.progress；
// StageError 额外发 engine.error；结束释放取消句柄。
func (d *Daemon) drainImport(p *projectState, ch <-chan imp.Event) {
	defer func() {
		d.stateMu.Lock()
		if d.importCancel != nil {
			d.importCancel()
			d.importCancel = nil
		}
		d.stateMu.Unlock()
	}()
	for ev := range ch {
		payload := map[string]any{
			"stage":     string(ev.Stage),
			"completed": ev.Current,
			"total":     ev.Total,
			"detail":    ev.Message,
		}
		if ev.Level != "" {
			payload["level"] = ev.Level
		}
		if !ev.RetryAt.IsZero() {
			payload["retry_at"] = ev.RetryAt.Format("2006-01-02T15:04:05Z07:00")
		}
		if ev.Err != nil {
			payload["error"] = ev.Err.Error()
		}
		if ev.Stage == imp.StageDone {
			payload["continued"] = ev.Continued
		}
		d.emitEvent(p.id, "import.progress", payload)
		if ev.Err != nil {
			d.log("error", "import", "import failed", "stage", string(ev.Stage), "err", ev.Err.Error())
			d.emitEvent(p.id, "engine.error", map[string]any{
				"code": CodeOperationFailed, "message": "import failed at " + string(ev.Stage) + ": " + ev.Err.Error(),
			})
		}
		if ev.Stage == imp.StageDone {
			d.emitEvent(p.id, "notification.info", map[string]any{
				"message": "import completed; foundation and chapters published",
			})
		}
	}
}

// ── 仿写 ──

// simulationCorpusDir 是桌面端的确定性语料库目录：<项目目录>/simulate。
// 引擎（Host.Simulate + WithSimulateSource）被指向该绝对目录；语料跨次累积、
// 同名替换（与引擎画像 merge 的同 RelativePath 替换语义一致，见 README §6）。
func simulationCorpusDir(p *projectState) string {
	return filepath.Join(p.path, "simulate")
}

// isSimulationSource 报告文件扩展名是否为引擎支持的仿写语料（.txt/.md/.markdown）。
func isSimulationSource(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".txt", ".md", ".markdown":
		return true
	default:
		return false
	}
}

// stageSimulationSource 把用户选定的语料真正落进项目语料库：
//   - source 是文件   → 复制为 <项目>/simulate/<basename>（同名覆盖旧副本）；
//   - source 是目录   → 递归复制其中受支持的语料，保留相对路径（指纹稳定）；
//
// 只复制 .txt/.md/.markdown（引擎不识别其它格式），不支持的单文件输入显式报错，
// 绝不静默空跑。返回绝对语料库目录。
func (d *Daemon) stageSimulationSource(p *projectState, sourcePath string) (string, error) {
	abs, err := filepath.Abs(sourcePath)
	if err != nil {
		return "", fmt.Errorf("resolve source path: %w", err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("simulation source not accessible: %w", err)
	}
	corpusDir := simulationCorpusDir(p)
	if err := os.MkdirAll(corpusDir, 0o755); err != nil {
		return "", fmt.Errorf("create corpus dir: %w", err)
	}

	if !info.IsDir() {
		if !isSimulationSource(abs) {
			return "", fmt.Errorf("simulation source must be a .txt/.md/.markdown file or a directory containing them: %s", abs)
		}
		if err := copyFile(abs, filepath.Join(corpusDir, filepath.Base(abs))); err != nil {
			return "", fmt.Errorf("stage %s: %w", abs, err)
		}
		return corpusDir, nil
	}

	staged := 0
	err = filepath.WalkDir(abs, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !isSimulationSource(path) {
			return nil
		}
		rel, err := filepath.Rel(abs, path)
		if err != nil {
			return err
		}
		if err := copyFile(path, filepath.Join(corpusDir, rel)); err != nil {
			return fmt.Errorf("stage %s: %w", path, err)
		}
		staged++
		return nil
	})
	if err != nil {
		return "", err
	}
	if staged == 0 {
		return "", fmt.Errorf("no .txt/.md/.markdown sources found in directory: %s", abs)
	}
	return corpusDir, nil
}

// startSimulation 对既定语料目录跑一次画像生成（start 先完成 staging 再进来；
// resume 直接用项目语料库——画像按语料指纹增量合并，重跑即恢复）。
func (d *Daemon) startSimulation(req *Request, sourcePath, corpusDir string) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	ctx, cancel := context.WithCancel(context.Background())
	ch, err := p.host.Simulate(ctx, host.WithSimulateSource(corpusDir))
	if err != nil {
		cancel()
		d.log("warn", "simulation", "start failed", "err", err.Error())
		return errorResponse(req.ID, d.session, classifyCode(err), err.Error(), nil)
	}
	d.stateMu.Lock()
	d.simCancel = cancel
	d.stateMu.Unlock()
	go d.drainSimulation(p, ch)
	return successResponse(req.ID, d.session, map[string]any{
		"accepted": true, "source_path": sourcePath,
		"engine_source_dir": corpusDir,
	})
}

func (d *Daemon) handleSimulationStart(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	source := strings.TrimSpace(payloadString(req.Payload, "source_path"))
	if source == "" {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "source_path is required", nil)
	}
	corpusDir, err := d.stageSimulationSource(p, source)
	if err != nil {
		return d.opFailed(req, err)
	}
	return d.startSimulation(req, source, corpusDir)
}

// handleSimulationResume 仿写画像按语料指纹增量合并：对项目语料库重跑
// Simulate 即恢复；语料库尚未建立时同步报错（不静默空跑引擎的 StageError）。
func (d *Daemon) handleSimulationResume(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	corpusDir := simulationCorpusDir(p)
	if info, err := os.Stat(corpusDir); err != nil || !info.IsDir() {
		return d.opFailedMsg(req, "no simulation corpus staged in this project; start one with simulation.start {source_path}")
	}
	return d.startSimulation(req, "", corpusDir)
}

func (d *Daemon) handleSimulationCancel(req *Request) *Response {
	d.stateMu.Lock()
	cancel := d.simCancel
	d.simCancel = nil
	d.stateMu.Unlock()
	if cancel == nil {
		return successResponse(req.ID, d.session, map[string]any{"cancelled": false, "reason": "no simulation in progress"})
	}
	cancel()
	return successResponse(req.ID, d.session, map[string]any{"cancelled": true})
}

func (d *Daemon) handleSimulationProfileImport(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	profilePath := strings.TrimSpace(payloadString(req.Payload, "profile_path"))
	if profilePath == "" {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "profile_path is required", nil)
	}
	if _, err := os.Stat(profilePath); err != nil {
		return d.opFailed(req, fmt.Errorf("profile file not accessible: %w", err))
	}
	ctx, cancel := context.WithCancel(context.Background())
	ch, err := p.host.ImportSimulationProfile(ctx, profilePath)
	if err != nil {
		cancel()
		d.log("warn", "simulation", "profile import failed", "err", err.Error())
		return errorResponse(req.ID, d.session, classifyCode(err), err.Error(), nil)
	}
	d.stateMu.Lock()
	d.simCancel = cancel
	d.stateMu.Unlock()
	go d.drainSimulation(p, ch)
	return successResponse(req.ID, d.session, map[string]any{"accepted": true, "profile_path": profilePath})
}

func (d *Daemon) drainSimulation(p *projectState, ch <-chan sim.Event) {
	defer func() {
		d.stateMu.Lock()
		if d.simCancel != nil {
			d.simCancel()
			d.simCancel = nil
		}
		d.stateMu.Unlock()
	}()
	for ev := range ch {
		payload := map[string]any{
			"stage":     string(ev.Stage),
			"completed": ev.Current,
			"total":     ev.Total,
			"detail":    ev.Message,
		}
		if ev.Err != nil {
			payload["error"] = ev.Err.Error()
		}
		d.emitEvent(p.id, "simulation.progress", payload)
		if ev.Err != nil {
			d.log("error", "simulation", "simulation failed", "stage", string(ev.Stage), "err", ev.Err.Error())
			d.emitEvent(p.id, "engine.error", map[string]any{
				"code": CodeOperationFailed, "message": "simulation failed at " + string(ev.Stage) + ": " + ev.Err.Error(),
			})
		}
		if ev.Stage == sim.StageDone {
			d.emitEvent(p.id, "notification.info", map[string]any{"message": ev.Message})
		}
	}
}

// setStoryLanguageEnv 供 config.set_language / set_story_language 归一化语言码。
func normalizeLanguageCode(v string) string {
	return i18n.NormalizeLanguage(strings.TrimSpace(v))
}
