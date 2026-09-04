package bootstrap

import (
	"os"
	"path/filepath"
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

func TestSeedDefaultConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	if !NeedsSetup() {
		t.Fatal("expected NeedsSetup to be true in clean temp home")
	}

	if err := SeedDefaultConfig(); err != nil {
		t.Fatalf("SeedDefaultConfig failed: %v", err)
	}

	if NeedsSetup() {
		t.Fatal("expected NeedsSetup to be false after SeedDefaultConfig")
	}

	cfg, err := LoadConfig()
	if err != nil {
		t.Fatalf("LoadConfig failed: %v", err)
	}
	if len(cfg.Providers) != 0 {
		t.Fatalf("seeded config should have empty providers (no pre-example like openrouter/claude-code-proxy), got: %v", cfg.Providers)
	}
	if cfg.Provider != "" {
		t.Fatalf("seeded config should have empty default provider, got: %q", cfg.Provider)
	}
	examplePath := filepath.Join(home, ".ainovel", "config.example.jsonc")
	if _, err := os.Stat(examplePath); err != nil {
		t.Fatalf("expected config.example.jsonc to be saved for reference: %v", err)
	}
}
