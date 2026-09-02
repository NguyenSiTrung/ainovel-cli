package tui

import (
	"strings"
	"testing"

	"github.com/voocel/ainovel-cli/internal/domain"
	"github.com/voocel/ainovel-cli/internal/host"
	"github.com/voocel/ainovel-cli/internal/i18n"
)

// TestRenderOutlineListShowsChapterTitles 保护单列大纲渲染：
// 每章的标题（与"进行中"徽标）必须真正写入输出——i18n 重构期间
// b.WriteString(line) 被误删，短篇（<20 章）大纲一度只剩空行。
func TestRenderOutlineListShowsChapterTitles(t *testing.T) {
	i18n.SetLanguage("zh")
	snap := host.UISnapshot{
		Outline: []host.OutlineSnapshot{
			{Chapter: 1, Title: "风起"},
			{Chapter: 2, Title: "云涌"},
		},
		CompletedCount:    1,
		InProgressChapter: 2,
	}

	got := renderOutlineSection(snap, 60)
	if !strings.Contains(got, "风起") || !strings.Contains(got, "云涌") {
		t.Fatalf("单列大纲应包含各章标题, got %q", got)
	}
	if !strings.Contains(got, i18n.T("tui.outline.in_progress_badge")) {
		t.Fatalf("进行中章节应带徽标 %q, got %q", i18n.T("tui.outline.in_progress_badge"), got)
	}
}

// TestSnapshotPhaseFlowLabelsCoverDomainValues 保证侧栏阶段/流程标签
// 对 domain 全部枚举值都有本地化键：缺键会退回原始英文（如 premise/steering
// 曾在三种语言下都显示裸值）。
func TestSnapshotPhaseFlowLabelsCoverDomainValues(t *testing.T) {
	phases := []string{
		string(domain.PhaseInit),
		string(domain.PhasePremise),
		string(domain.PhaseOutline),
		string(domain.PhaseWriting),
		string(domain.PhaseComplete),
	}
	flows := []string{
		string(domain.FlowWriting),
		string(domain.FlowReviewing),
		string(domain.FlowRewriting),
		string(domain.FlowPolishing),
		string(domain.FlowSteering),
	}

	for _, lang := range i18n.SupportedLanguages() {
		i18n.SetLanguage(lang)
		for _, ph := range phases {
			if got := snapshotPhaseLabel(ph); got == ph || got == "" {
				t.Errorf("lang %q: snapshotPhaseLabel(%q) = %q, want localized label", lang, ph, got)
			}
		}
		for _, fl := range flows {
			if got := snapshotFlowLabel(fl); got == fl || got == "" {
				t.Errorf("lang %q: snapshotFlowLabel(%q) = %q, want localized label", lang, fl, got)
			}
		}
	}
}

// TestSnapshotRuntimeStateLabelDistinguishesPausing 暂停中/已暂停是两个
// 运行时状态，标签不得合并（i18n 化时曾把 pausing 也映射成"已暂停"）。
func TestSnapshotRuntimeStateLabelDistinguishesPausing(t *testing.T) {
	for _, lang := range i18n.SupportedLanguages() {
		i18n.SetLanguage(lang)
		pausing := snapshotRuntimeStateLabel("pausing")
		paused := snapshotRuntimeStateLabel("paused")
		if pausing == "" || paused == "" {
			t.Fatalf("lang %q: labels must be non-empty (pausing=%q paused=%q)", lang, pausing, paused)
		}
		if pausing == paused {
			t.Errorf("lang %q: pausing 与 paused 标签不得相同 (both %q)", lang, pausing)
		}
	}
}
