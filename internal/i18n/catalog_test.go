package i18n_test

import (
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
		{"en", "en"},
		{"en-US", "en"},
		{"en_GB.UTF-8", "en"},
		{"EN", "en"},
		{"english", "en"},
		{"zh", "zh"},
		{"zh-CN", "zh"},
		{"zh_TW.UTF-8", "zh"},
		{"ZH", "zh"},
		{"chinese", "zh"},
		{"中文", "zh"},
		{"zhongwen", "zh"},
		{"fr", "vi"}, // unsupported fallback to vi
		{"", "vi"},
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
		"tui.phase.writing",
		"tui.phase.complete",
		"tui.flow.writing",
		"tui.flow.reviewing",
		"tui.flow.rewriting",
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
