package tui

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/voocel/ainovel-cli/internal/host"
	"github.com/voocel/ainovel-cli/internal/i18n"
)

func TestStartCommandLoadsPromptFile(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "outline files")
	if err := os.Mkdir(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "story outline.md")
	want := "世界设定\n\n第一卷大纲"
	if err := os.WriteFile(path, []byte("  "+want+"  "), 0o644); err != nil {
		t.Fatal(err)
	}

	m := NewModel(nil, "")
	cmd, ok := parseSlashCommand("/start " + path)
	if !ok {
		t.Fatal("/start should parse as slash command")
	}
	prompt, err := prepareFileStart(cmd.args)
	if err != nil {
		t.Fatal(err)
	}
	if prompt != want {
		t.Fatalf("prompt = %q, want full file content", prompt)
	}
	next, startCmd := m.handleSlashCommand(cmd)
	got := next.(Model)
	if startCmd == nil || !got.starting || got.mode != modeRunning {
		t.Fatalf("start state = mode %v, starting %v, cmd %v", got.mode, got.starting, startCmd)
	}
}

func TestEnterStartingSwitchesToWorkbenchImmediately(t *testing.T) {
	m := NewModel(nil, "")
	m.width = 120
	m.height = 40
	m.resizeTextarea()
	m.updateViewportSize()

	m.enterStarting("写一本东方玄幻长篇")

	if m.mode != modeRunning {
		t.Fatalf("mode = %v, want modeRunning", m.mode)
	}
	if !m.starting {
		t.Fatal("starting should be true while host startup command is running")
	}
	if !m.snapshot.IsRunning {
		t.Fatal("snapshot should render as running during local startup")
	}
	if got := m.textarea.Placeholder; got != i18n.T("tui.status.starting_placeholder") {
		t.Fatalf("placeholder = %q", got)
	}
	if len(m.events) != 2 {
		t.Fatalf("events = %+v, want startup user + system events", m.events)
	}
	if m.events[0].Category != "USER" || !strings.HasPrefix(m.events[0].Summary, i18n.T("tui.hints.input_label")+": ") {
		t.Fatalf("first event = %+v, want USER prompt event", m.events[0])
	}
}

func TestStartupSpinnerAnimatesWhileStartingAndRunning(t *testing.T) {
	m := NewModel(nil, "")
	m.width = 120
	m.height = 40
	m.enterStarting("写一本东方玄幻长篇")

	// 即使 snapshot 被后台 tick 置为 IsRunning=false，m.starting 仍驱动顶部 spinner 转动
	m.snapshot.IsRunning = false
	frame := m.currentSpinnerFrame()
	if frame == "" {
		t.Fatal("currentSpinnerFrame should be non-empty while starting=true")
	}
	topBar := renderTopBar(m.snapshot, m.width, frame, m.version)
	if !strings.Contains(topBar, frame) {
		t.Fatalf("topBar should render spinnerFrame during starting: %q", topBar)
	}
}

func TestStartupObservedDecisionTriggersToolSpinner(t *testing.T) {
	m := NewModel(nil, "")
	m.width = 120
	m.height = 40
	m.enterStarting("写一本东方玄幻长篇")

	// 收到归一化/启动裁定等具有 lifecycle 的 DECISION 事件
	startEv := host.Event{
		ID:       "e1",
		Time:     time.Now(),
		Category: "DECISION",
		Agent:    "arbiter",
		Summary:  i18n.T("tui.decision.prepare_user_rules"),
		Level:    "info",
	}

	updated, cmd, handled := m.handleRuntimeMsg(eventMsg(startEv))
	if !handled {
		t.Fatal("eventMsg should be handled")
	}
	got := updated.(Model)
	if !got.hasRunningEvent() {
		t.Fatal("hasRunningEvent should be true for in-flight DECISION event")
	}
	if !got.toolTicking {
		t.Fatal("toolTicking should be activated for in-flight DECISION event")
	}
	if cmd == nil {
		t.Fatal("expected tickToolSpinner command in batch")
	}
}

func TestStartupFailureStaysInWorkbench(t *testing.T) {
	m := NewModel(nil, "")
	m.width = 120
	m.height = 40
	m.resizeTextarea()
	m.updateViewportSize()

	m.enterStarting("写一本东方玄幻长篇")

	next, _ := m.handleStartResultMsg(startResultMsg{err: errors.New("模型账户未激活")})
	got := next.(Model)
	if got.mode != modeRunning {
		t.Fatalf("启动失败后 mode = %v, want modeRunning", got.mode)
	}
	if got.starting {
		t.Fatal("启动失败后 starting 应复位")
	}
	if got.snapshot.IsRunning {
		t.Fatal("启动失败后 snapshot 不应仍显示运行中")
	}
	if !strings.Contains(got.textarea.Placeholder, "启动失败") {
		t.Fatalf("placeholder = %q", got.textarea.Placeholder)
	}
	if len(got.events) == 0 || got.events[len(got.events)-1].Category != "ERROR" {
		t.Fatalf("工作台应保留启动错误事件: %+v", got.events)
	}
}

func TestApplyStartupPromptEventTruncatesSummaryButKeepsDetail(t *testing.T) {
	m := NewModel(nil, "")
	prompt := strings.Repeat("设", maxPromptEventCols+50)

	m.applyStartupPromptEvent(prompt)

	if len(m.events) != 1 {
		t.Fatalf("events = %+v, want one event", m.events)
	}
	ev := m.events[0]
	if ev.Detail != prompt {
		t.Fatalf("detail should keep full prompt, got len=%d want=%d", len([]rune(ev.Detail)), len([]rune(prompt)))
	}
	maxSummaryRunes := len([]rune("创作需求: ")) + maxPromptEventCols
	if got := len([]rune(ev.Summary)); got > maxSummaryRunes {
		t.Fatalf("summary runes = %d, want <= %d", got, maxSummaryRunes)
	}
	if !strings.HasSuffix(ev.Summary, "...") {
		t.Fatalf("summary should be truncated with ellipsis, got %q", ev.Summary)
	}
}

func TestStreamFlushTimerRunsOnlyForPendingData(t *testing.T) {
	m := NewModel(nil, "")
	next, cmd, handled := m.handleRuntimeMsg(streamDeltaMsg("正文"))
	if !handled || cmd == nil {
		t.Fatal("流式增量应启动一次刷新")
	}
	got := next.(Model)
	if !got.streamDirty || !got.flushPending {
		t.Fatal("流式增量应标记待刷新")
	}
	next, cmd, handled = got.handleRuntimeMsg(streamFlushTickMsg{})
	got = next.(Model)
	if !handled || cmd != nil || got.streamDirty || got.flushPending {
		t.Fatal("刷新完成后 timer 应停止")
	}
}
