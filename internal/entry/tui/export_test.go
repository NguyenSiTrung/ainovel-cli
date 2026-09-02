package tui

import (
	"errors"
	"strings"
	"testing"

	"github.com/voocel/ainovel-cli/internal/host/exp"
	"github.com/voocel/ainovel-cli/internal/i18n"
)

// TestExportDoneMsgFailureEmitsErrorOnly 保护 exportDoneMsg 的错误分支：
// 失败时 exp.Run 返回 (nil, err)，只允许回显 ERROR 事件——成功事件一旦
// 误入错误分支，formatExportSuccess 会对 nil *exp.Result 解引用直接 panic。
func TestExportDoneMsgFailureEmitsErrorOnly(t *testing.T) {
	i18n.SetLanguage("zh")
	m := NewModel(nil, "")

	next, _, _ := m.handleRuntimeMsg(exportDoneMsg{err: errors.New("unsupported format")})
	got := next.(Model)

	if len(got.events) == 0 {
		t.Fatal("失败的导出应回显 ERROR 事件")
	}
	if last := got.events[len(got.events)-1]; last.Category != "ERROR" {
		t.Fatalf("最后一条事件 category = %q, want ERROR (%+v)", last.Category, got.events)
	}
	for _, ev := range got.events {
		if ev.Level == "success" {
			t.Fatalf("失败的导出不应产生成功事件: %+v", ev)
		}
	}
}

// TestExportDoneMsgSuccessEmitsSuccessEvent 保护成功分支：
// 成功导出必须回显带路径的完成事件。
func TestExportDoneMsgSuccessEmitsSuccessEvent(t *testing.T) {
	i18n.SetLanguage("zh")
	m := NewModel(nil, "")

	next, _, _ := m.handleRuntimeMsg(exportDoneMsg{result: &exp.Result{
		Path: "/tmp/book.epub", Chapters: 3, Bytes: 42,
	}})
	got := next.(Model)

	found := false
	for _, ev := range got.events {
		if ev.Category == "SYSTEM" && ev.Level == "success" && strings.Contains(ev.Summary, "/tmp/book.epub") {
			found = true
		}
	}
	if !found {
		t.Fatalf("成功的导出应回显成功事件, events=%+v", got.events)
	}
}
