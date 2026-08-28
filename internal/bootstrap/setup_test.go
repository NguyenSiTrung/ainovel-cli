package bootstrap

import (
	"os"
	"testing"
)

func TestMaskKey(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"", "****"},
		{"1234", "****"},
		{"12345678", "****"},
		{"sk-1234567890abcdef", "sk-1****cdef"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := maskKey(tt.input)
			if got != tt.want {
				t.Errorf("maskKey(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestSetupLanguageOptions(t *testing.T) {
	opts := languageOptions()
	if len(opts) < 3 {
		t.Fatalf("expected at least 3 language options (vi, en, zh), got %d", len(opts))
	}

	foundVI := false
	for _, opt := range opts {
		if opt.name == "vi" {
			foundVI = true
		}
	}
	if !foundVI {
		t.Errorf("expected 'vi' language option to be present")
	}
}

func TestExampleConfigSync(t *testing.T) {
	rootExample, err := os.ReadFile("../../config.example.jsonc")
	if err != nil {
		t.Skipf("cannot read root config.example.jsonc: %v", err)
	}

	if string(rootExample) != exampleConfig {
		t.Errorf("internal/bootstrap/config.example.jsonc does not match root config.example.jsonc")
	}
}
