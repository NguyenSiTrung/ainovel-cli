package host

import (
	"strings"
	"testing"

	"github.com/voocel/ainovel-cli/internal/i18n"
)

// TestCoCreateLangDirectiveSelectsPerLanguage 守护对话语言指令按语言选择：
// vi/en 各取本地化指令，未识别与空语言回退中文（上游默认行为，无行为漂移）。
func TestCoCreateLangDirectiveSelectsPerLanguage(t *testing.T) {
	cases := []struct {
		lang string
		want string
	}{
		{"vi", "tiếng Việt"},
		{"vietnamese", "tiếng Việt"},
		{"en", "Conversation Language (English)"},
		{"EN_us", "Conversation Language (English)"},
		{"zh", "中文"},
		{"", "中文"},
		{"fr", "中文"}, // 未识别 → 默认中文
	}
	for _, c := range cases {
		got := coCreateLangDirective(c.lang)
		if !strings.Contains(got, c.want) {
			t.Errorf("coCreateLangDirective(%q) 应包含 %q，得:\n%s", c.lang, c.want, got)
		}
	}
}

// TestCoCreatePromptBaseNeutral 守护基础模板不再硬编码中文输出要求——
// 语言由调用方经 coCreateLangDirective 注入，硬编码 pin 正是本 bug 的根因
// （英文界面 + 越南语输入仍被提示词强制用中文回复）。
func TestCoCreatePromptBaseNeutral(t *testing.T) {
	for name, p := range map[string]string{
		"coCreateSystemPrompt":      coCreateSystemPrompt,
		"stageCoCreateSystemPrompt": stageCoCreateSystemPrompt,
	} {
		for _, pin := range []string{"中文自然回复", "中文创作指令"} {
			if strings.Contains(p, pin) {
				t.Errorf("%s 仍含硬编码输出语言 pin %q，应交给 coCreateLangDirective", name, pin)
			}
		}
	}
}

// TestBuildCoCreatePromptAppendsDirective 守护冷启动提示词 = 基础模板 + 语言指令，
// 指令位于末尾（离输出最近），且内容语言与所选语言一致。
func TestBuildCoCreatePromptAppendsDirective(t *testing.T) {
	p := buildCoCreatePrompt(coCreateSystemPrompt, "vi")
	dir := coCreateLangDirective("vi")
	if !strings.HasSuffix(p, dir) {
		t.Fatal("对话语言指令应附加在基础模板末尾")
	}
	if !strings.Contains(p, "## Ngôn ngữ đối thoại (Tiếng Việt)") {
		t.Fatalf("vi 提示词应含越南语指令，得:\n%s", p)
	}
	if !strings.Contains(p, "给用户看的自然回复") {
		t.Fatal("基础模板的回复指引应保持语言中立")
	}

	zh := buildCoCreatePrompt(coCreateSystemPrompt, "zh")
	if !strings.Contains(zh, "## 对话语言（中文）") {
		t.Fatal("zh 提示词应含中文指令")
	}
}

// TestStageSystemPromptDirectiveLast 守护阶段共创提示词里语言指令仍在最末
// （故事状态摘要追加在指令之前，不稀释语言约束的收尾位置）。
func TestStageSystemPromptDirectiveLast(t *testing.T) {
	p := stageSystemPrompt(nil, i18n.LangEN)
	dir := coCreateLangDirective(i18n.LangEN)
	if !strings.HasSuffix(p, dir) {
		t.Fatalf("语言指令应位于阶段提示词末尾，得:\n%s", p)
	}
	if !strings.Contains(p, "## Conversation Language (English)") {
		t.Fatal("en 阶段提示词应含英文指令")
	}
}
