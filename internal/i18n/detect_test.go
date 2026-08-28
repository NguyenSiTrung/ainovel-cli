package i18n_test

import (
	"testing"

	"github.com/voocel/ainovel-cli/internal/i18n"
)

func TestDetectFromEnv(t *testing.T) {
	tests := []struct {
		name     string
		env      map[string]string
		expected string
	}{
		{
			name: "AINOVEL_LANG highest priority",
			env: map[string]string{
				"AINOVEL_LANG": "en",
				"LC_ALL":       "vi_VN.UTF-8",
				"LANG":         "zh_CN.UTF-8",
			},
			expected: "en",
		},
		{
			name: "LC_ALL priority over LANG",
			env: map[string]string{
				"LC_ALL": "zh_CN.UTF-8",
				"LANG":   "en_US.UTF-8",
			},
			expected: "zh",
		},
		{
			name: "LC_MESSAGES priority over LANG",
			env: map[string]string{
				"LC_MESSAGES": "vi_VN.UTF-8",
				"LANG":        "en_US.UTF-8",
			},
			expected: "vi",
		},
		{
			name: "LANG parsed",
			env: map[string]string{
				"LANG": "en_US.UTF-8",
			},
			expected: "en",
		},
		{
			name: "LANGUAGE parsed",
			env: map[string]string{
				"LANGUAGE": "zh_TW:zh",
			},
			expected: "zh",
		},
		{
			name:     "Empty env falls back to default vi",
			env:      map[string]string{},
			expected: "vi",
		},
		{
			name: "Unknown language falls back to default vi",
			env: map[string]string{
				"LANG": "fr_FR.UTF-8",
			},
			expected: "vi",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			lookup := func(key string) string {
				return tt.env[key]
			}
			got := i18n.DetectFromEnvWithLookup(lookup)
			if got != tt.expected {
				t.Errorf("DetectFromEnvWithLookup() = %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestDetectSystemLanguage(t *testing.T) {
	// Smoke test that DetectSystemLanguage returns one of supported languages
	lang := i18n.DetectSystemLanguage()
	if lang != "vi" && lang != "en" && lang != "zh" {
		t.Errorf("DetectSystemLanguage() returned unexpected lang %q", lang)
	}
}
