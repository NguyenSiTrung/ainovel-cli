# Track Implementation Plan: Full Localization into Vietnamese & Settings Integration

## Phase 1: Foundation & Core i18n Engine
<!-- execution: sequential -->
<!-- depends: -->

- [x] Task 1.1: [TDD] Implement `internal/i18n` catalog with embedded dictionaries and fallback chains
  <!-- files: internal/i18n/catalog.go, internal/i18n/catalog_test.go, internal/i18n/locales/vi.json, internal/i18n/locales/en.json, internal/i18n/locales/zh.json -->
  - [x] Write unit tests for dictionary loading, argument interpolation, and fallback resolution
  - [x] Implement `internal/i18n` core package with embedded `embed.FS` JSON catalogs
  - [x] Implement global translation accessors (`i18n.T`, `i18n.SetLanguage`, `i18n.CurrentLanguage`)

- [x] Task 1.2: [TDD] Implement cross-platform system locale auto-detection
  <!-- files: internal/i18n/detect.go, internal/i18n/detect_test.go -->
  - [x] Write tests for `$LANG`, `$LC_ALL`, and OS locale environment parsing
  - [x] Implement robust system locale detection falling back to `vi`
---

## Phase 2: Configuration, Bootstrap & Settings Integration
<!-- execution: parallel -->
<!-- depends: phase1 -->

- [x] Task 2.1: [TDD] Extend `bootstrap.Config` with `Language` and `StoryLanguage`
  <!-- files: internal/bootstrap/config.go, internal/bootstrap/config_test.go, config.example.jsonc -->
  - [x] Add `Language` and `StoryLanguage` fields with validation, normalization, and defaults
  - [x] Update `config.example.jsonc` and test config loading/serialization

- [x] Task 2.2: [TDD] Localize initial setup wizard (`RunSetup()`) and add language selection
  <!-- files: internal/bootstrap/setup.go, internal/bootstrap/setup_test.go -->
  - [x] Write tests for interactive setup wizard with language selection
  - [x] Localize setup wizard views, prompts, and status messages into Vietnamese

- [x] Task 2.3: [TDD] Integrate Language Settings into TUI `/config` modal and add `/setting` alias
  <!-- files: internal/entry/tui/command_config.go, internal/entry/tui/command_config_test.go, internal/entry/tui/command_registry.go -->
  - [x] Implement Language switcher in `/config` modal with live UI re-render on selection
  - [x] Register `/setting` alias in command registry and add unit tests

---

## Phase 3: CLI, Error Handling & Global Application Messages
<!-- execution: parallel -->
<!-- depends: phase1 -->

- [x] Task 3.1: [TDD] Add CLI `--lang` / `-l` flags and wire startup language resolution
  <!-- files: cmd/ainovel-cli/main.go, cmd/ainovel-cli/main_test.go -->
  - [x] Write tests for `--lang` flag parsing and precedence over config files
  - [x] Implement flag parsing and initialize `i18n` before runtime dispatch

- [x] Task 3.2: [TDD] Localize startup errors, crash logging, and terminal exit pause prompts
  <!-- files: cmd/ainovel-cli/main.go, internal/errs/errors.go -->
  - [x] Localize all fatal exit messages, `last-error.log` notices, and `"Nhấn Enter để thoát..."` prompt
  - [x] Verify non-interactive and interactive terminal error behavior

---

## Phase 4: Complete TUI Interface Localization
<!-- execution: parallel -->
<!-- depends: phase2 -->

- [x] Task 4.1: [TDD] Localize TUI Sidebar (Outline, Memory, Characters, Progress) and Status Bar
  <!-- files: internal/entry/tui/panels_sidebar.go, internal/entry/tui/panels_outline.go, internal/entry/tui/statusbar.go, internal/entry/tui/panels_test.go -->
  - [x] Replace hardcoded strings with `i18n.T()` in sidebar panels, token counters, and budget badges
  - [x] Update / add tests for sidebar and status bar rendering in Vietnamese

- [x] Task 4.2: [TDD] Localize TUI Activity Feed, Chapter Views, and acceptance gates
  <!-- files: internal/entry/tui/panels_activity.go, internal/entry/tui/model.go, internal/entry/tui/model_update.go -->
  - [x] Localize agent lifecycle banners, tool invocation logs, review badges, and acceptance buttons
  - [x] Update tests to verify Vietnamese activity events and chapter status rendering

- [x] Task 4.3: [TDD] Localize TUI Modals, Palette & Interactive Dialogs
  <!-- files: internal/entry/tui/command_help.go, internal/entry/tui/command_model.go, internal/entry/tui/export.go, internal/entry/tui/simulation.go, internal/entry/tui/cocreate.go, internal/entry/tui/import.go -->
  - [x] Localize `/help` modal, `/model`, `/style`, `/export`, `/advance`, `/simulation`, `/cocreate`, `/import`
  - [x] Verify shortcut keys, wrapped text, and modal frame alignments
---

## Phase 5: Vietnamese Prompts, Styles & Output Templates
<!-- execution: parallel -->
<!-- depends: phase2 -->

- [x] Task 5.1: Create Vietnamese novel style presets
  <!-- files: assets/styles/tienhiep.md, assets/styles/kiemhiep.md, assets/styles/dothi.md, assets/styles/ngontinh.md, assets/styles/trinhtham.md, assets/styles/default.md, assets/load.go -->
  - [x] Author high-quality Vietnamese style templates for major genres
  - [x] Update style loader to recognize Vietnamese presets and test with `assets/styles_test.go`

- [x] Task 5.2: Localize agent system prompts and export templates for `story_language: "vi"`
  <!-- files: assets/prompts/*.md, assets/load.go, internal/agents/*.go -->
  - [x] Provide Vietnamese-targeted system prompts for Architect, Writer, Editor, Arbiter, Revision, and Simulation
  - [x] Localize exported markdown headers and book metadata summaries

---

## Phase 6: End-to-End Verification & Quality Gate
<!-- execution: sequential -->
<!-- depends: phase3, phase4, phase5 -->

- [x] Task 6.1: Run full automated test suite with race detector (`go test -race ./...`)
- [x] Task 6.2: Smoke test TUI in Vietnamese, test live language switching in `/config`, `--lang` flag, and chapter generation flow
