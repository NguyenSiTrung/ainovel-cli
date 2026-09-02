package i18n_test

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/voocel/ainovel-cli/internal/i18n"
)

func TestNormalizeLanguage(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"vi", "vi"},
		{"vi-VN", "vi"},
		{"vi_VN.UTF-8", "vi"},
		{"VI", "vi"},
		{"vietnamese", "vi"},
		{"tiếng việt", "vi"},
		{"tieng_viet", "vi"},
		{"vn", "vi"},
		{"vie", "vi"},
		{"viet", "vi"},
		{"en", "en"},
		{"en-US", "en"},
		{"en_GB.UTF-8", "en"},
		{"EN", "en"},
		{"english", "en"},
		{"eng", "en"},
		{"us", "en"},
		{"gb", "en"},
		{"zh", "zh"},
		{"zh-CN", "zh"},
		{"zh_TW.UTF-8", "zh"},
		{"ZH", "zh"},
		{"chinese", "zh"},
		{"中文", "zh"},
		{"zhongwen", "zh"},
		{"cmn", "zh"},
		{"zho", "zh"},
		{"chi", "zh"},
		{"cn", "zh"},
		{"tw", "zh"},
		{"fr", "zh"}, // unsupported fallback to upstream default zh
		{"", "zh"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := i18n.NormalizeLanguage(tt.input)
			if got != tt.expected {
				t.Errorf("NormalizeLanguage(%q) = %q, want %q", tt.input, got, tt.expected)
			}
		})
	}
}

func TestCatalogTranslations(t *testing.T) {
	// Set to Vietnamese
	i18n.SetLanguage("vi")
	if i18n.CurrentLanguage() != "vi" {
		t.Fatalf("expected current language to be 'vi', got %q", i18n.CurrentLanguage())
	}

	// Test basic key lookup in Vietnamese
	val := i18n.T("app.name")
	if val == "" || val == "app.name" {
		t.Errorf("expected non-empty translation for 'app.name', got %q", val)
	}

	// Test argument interpolation
	valWithArgs := i18n.T("tui.status.tokens", 1500)
	if valWithArgs == "" || valWithArgs == "tui.status.tokens" {
		t.Errorf("expected interpolated translation, got %q", valWithArgs)
	}

	// Switch to English
	i18n.SetLanguage("en")
	if i18n.CurrentLanguage() != "en" {
		t.Fatalf("expected current language to be 'en', got %q", i18n.CurrentLanguage())
	}
	enVal := i18n.T("app.name")
	if enVal == "" || enVal == "app.name" {
		t.Errorf("expected non-empty en translation for 'app.name', got %q", enVal)
	}

	// Switch to Chinese
	i18n.SetLanguage("zh")
	if i18n.CurrentLanguage() != "zh" {
		t.Fatalf("expected current language to be 'zh', got %q", i18n.CurrentLanguage())
	}
	zhVal := i18n.T("app.name")
	if zhVal == "" || zhVal == "app.name" {
		t.Errorf("expected non-empty zh translation for 'app.name', got %q", zhVal)
	}
}

func TestCatalogFallback(t *testing.T) {
	i18n.SetLanguage("en")
	// Non-existent key should return key itself
	missing := i18n.T("some.totally.nonexistent.key.12345")
	if missing != "some.totally.nonexistent.key.12345" {
		t.Errorf("expected missing key to return key itself, got %q", missing)
	}
}

func TestConcurrentAccess(t *testing.T) {
	var wg sync.WaitGroup
	langs := []string{"vi", "en", "zh"}

	for i := 0; i < 50; i++ {
		wg.Add(2)
		go func(idx int) {
			defer wg.Done()
			i18n.SetLanguage(langs[idx%len(langs)])
		}(i)

		go func() {
			defer wg.Done()
			_ = i18n.T("app.name")
			_ = i18n.CurrentLanguage()
		}()
	}

	wg.Wait()
}

func TestKeySymmetryAcrossLanguages(t *testing.T) {
	essentialKeys := []string{
		"tui.phase.init",
		"tui.phase.premise",
		"tui.phase.writing",
		"tui.phase.complete",
		"tui.flow.writing",
		"tui.flow.reviewing",
		"tui.flow.rewriting",
		"tui.flow.steering",
		"tui.welcome.title",
		"tui.welcome.feature_multi_agent",
		"tui.cocreate.title",
		"tui.cocreate.mode_quick",
		"tui.sidebar.in_progress_writing",
		"tui.sidebar.cache_overall_hit",
		"tui.modals.config_models_title",
		"setup.api_type_title",
		"cli.update_success",
	}

	for _, lang := range []string{"vi", "en", "zh"} {
		i18n.SetLanguage(lang)
		for _, key := range essentialKeys {
			if !i18n.Has(key) {
				t.Errorf("language %q is missing key %q", lang, key)
			}
			val := i18n.T(key)
			if val == key {
				t.Errorf("language %q returned key itself for %q", lang, key)
			}
		}
	}
}

// TestLocaleFileParity 直接读取 locales/*.json，断言三种语言键集合完全一致，
// 且每个键的格式化动词序列（%s/%d/...）逐个对齐——模板少一个 %s 会让对应
// 语言静默丢失参数（fmt 忽略多余实参，不报错）。
func TestLocaleFileParity(t *testing.T) {
	langs := []string{"vi", "en", "zh"}
	flattened := make(map[string]map[string]string, len(langs))
	for _, lang := range langs {
		data, err := os.ReadFile(filepath.Join("locales", lang+".json"))
		if err != nil {
			t.Fatalf("read locales/%s.json: %v", lang, err)
		}
		var raw map[string]any
		if err := json.Unmarshal(data, &raw); err != nil {
			t.Fatalf("parse locales/%s.json: %v", lang, err)
		}
		flat := make(map[string]string)
		flattenJSON("", raw, flat)
		flattened[lang] = flat
	}

	base := flattened["zh"]
	for _, lang := range []string{"vi", "en"} {
		other := flattened[lang]
		for key := range base {
			if _, ok := other[key]; !ok {
				t.Errorf("language %q is missing key %q (present in zh)", lang, key)
			}
		}
		for key := range other {
			if _, ok := base[key]; !ok {
				t.Errorf("language %q has extra key %q (absent in zh)", lang, key)
			}
		}
	}

	verbPattern := regexp.MustCompile(`%[-+#0-9.]*[a-zA-Z]`)
	for key, zhVal := range base {
		zhVerbs := verbPattern.FindAllString(strings.ReplaceAll(zhVal, "%%", ""), -1)
		for _, lang := range []string{"vi", "en"} {
			otherVal, ok := flattened[lang][key]
			if !ok {
				continue
			}
			otherVerbs := verbPattern.FindAllString(strings.ReplaceAll(otherVal, "%%", ""), -1)
			if !slices.Equal(zhVerbs, otherVerbs) {
				t.Errorf("key %q: %s verb sequence %v does not match zh %v (value: %q)",
					key, lang, otherVerbs, zhVerbs, otherVal)
			}
		}
	}
}

func flattenJSON(prefix string, src map[string]any, dest map[string]string) {
	for k, v := range src {
		key := k
		if prefix != "" {
			key = prefix + "." + k
		}
		if nested, ok := v.(map[string]any); ok {
			flattenJSON(key, nested, dest)
			continue
		}
		dest[key] = fmt.Sprintf("%v", v)
	}
}
