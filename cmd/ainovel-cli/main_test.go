package main

import (
	"testing"

	"github.com/voocel/ainovel-cli/internal/i18n"
)

func TestParseCLIOptionsLanguageFlags(t *testing.T) {
	tests := []struct {
		name          string
		argv          []string
		wantLang      string
		wantStoryLang string
		wantErr       bool
	}{
		{
			name:     "--lang flag",
			argv:     []string{"--lang", "vi"},
			wantLang: "vi",
		},
		{
			name:     "-l short flag",
			argv:     []string{"-l", "en"},
			wantLang: "en",
		},
		{
			name:          "--story-lang flag",
			argv:          []string{"--story-lang", "zh"},
			wantStoryLang: "zh",
		},
		{
			name:          "both --lang and --story-lang",
			argv:          []string{"-l", "vi", "--story-lang", "en"},
			wantLang:      "vi",
			wantStoryLang: "en",
		},
		{
			name:    "--lang missing value",
			argv:    []string{"--lang"},
			wantErr: true,
		},
		{
			name:    "-l missing value",
			argv:    []string{"-l"},
			wantErr: true,
		},
		{
			name:    "--story-lang missing value",
			argv:    []string{"--story-lang"},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			opts, _, err := parseCLIOptions(tt.argv)
			if (err != nil) != tt.wantErr {
				t.Fatalf("parseCLIOptions() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr {
				return
			}
			if opts.Language != tt.wantLang {
				t.Errorf("opts.Language = %q, want %q", opts.Language, tt.wantLang)
			}
			if opts.StoryLanguage != tt.wantStoryLang {
				t.Errorf("opts.StoryLanguage = %q, want %q", opts.StoryLanguage, tt.wantStoryLang)
			}
		})
	}
}

func TestDiePromptLocalization(t *testing.T) {
	i18n.SetLanguage("vi")
	viPrompt := i18n.T("errors.pause_exit_prompt")
	if viPrompt != "Nhấn Enter để thoát..." {
		t.Errorf("expected Vietnamese pause exit prompt to be 'Nhấn Enter để thoát...', got %q", viPrompt)
	}

	i18n.SetLanguage("en")
	enPrompt := i18n.T("errors.pause_exit_prompt")
	if enPrompt != "Press Enter to exit..." {
		t.Errorf("expected English pause exit prompt to be 'Press Enter to exit...', got %q", enPrompt)
	}

	i18n.SetLanguage("vi")
}
