# Track Specification: Full Localization into Vietnamese & Settings Integration

## Overview
Full Vietnamese localization for `ainovel-cli`, providing a complete, native Vietnamese user experience across all CLI commands, TUI interface views, configuration systems, first-time setup wizard, agent prompts, novel style templates, and output templates. The architecture introduces an embedded, zero-dependency `internal/i18n` catalog with system locale auto-detection, runtime language switching via the `/config` (or `/setting`) modal, and independent configuration for UI language and novel generation language.

---

## Functional Requirements

### 1. Embedded i18n Engine (`internal/i18n`)
- **Embedded Translation Catalog**: Store localization dictionaries using Go's `embed.FS` (JSON format) supporting `vi` (Vietnamese), `zh` (Chinese/original), and `en` (English).
- **Translation API**: Provide clean, type-safe translation helper functions `i18n.T(key, args...)` and domain-scoped translation namespaces (e.g., `i18n.TUI`, `i18n.CLI`, `i18n.Setup`, `i18n.Errors`).
- **Graceful Fallback**: If a key is missing in the target locale, fallback seamlessly to default/fallback locale without runtime panics or broken views.
- **Locale Resolution Hierarchy**:
  1. CLI flag override (`--lang <lang>` / `-l <lang>`)
  2. Environment variable override (`AINOVEL_LANG`)
  3. Project-level config (`./.ainovel/config.json`)
  4. Global config (`~/.ainovel/config.json`)
  5. System locale auto-detection (`$LANG`, `$LC_ALL`, OS locale API)
  6. Default fallback (`vi`)

### 2. Configuration & Settings Integration
- **Config Fields**:
  - `language`: UI display language (`"vi"`, `"zh"`, `"en"`, default: `"vi"` on detected Vietnamese systems).
  - `story_language`: Language used for novel generation, world-building, character arcs, and review prompts (default: `"vi"`, configurable independently from UI language).
- **Config Files**:
  - Update `internal/bootstrap/config.go` with `Language` and `StoryLanguage` fields.
  - Update `config.example.jsonc` with Vietnamese and multi-language documentation comments.
- **First-Time Setup Wizard**:
  - Localize the interactive bootstrap setup wizard (`bootstrap.RunSetup()`) into Vietnamese.
  - Include an initial language selection step with auto-detected default.
- **TUI Settings Integration**:
  - Extend the TUI `/config` modal (and add command alias `/setting`) with a dedicated **Language Settings** section.
  - Support instant live UI re-rendering when changing language in TUI without requiring application restart.

### 3. Complete TUI & CLI Interface Translation
- **TUI Views & Components**:
  - **Sidebar & Panels**: Outline panel, Memory panel, Character state cards, Progress trackers, Token & Budget metrics.
  - **Activity Feed**: Agent lifecycle events, tool invocation logs, planning stages, draft streaming banners.
  - **Chapter View**: Title/Volume headers, review results, citations, acceptance gate actions.
  - **Co-create & Interactive Modes**: Prompt input dialogs, interactive choice prompts, steering textarea, simulation view, book import dialog.
  - **Status Bar**: Token usage, cost/budget limit alerts, cache hit rate metrics, model badges.
  - **Modals & Palette**: Command palette (`/`), `/help` modal with shortcut descriptions, `/model`, `/config`, `/style`, `/export`, `/advance`, `/simulation`.
- **CLI & Error Handling**:
  - CLI flag descriptions (`--help`, `--version`, `--headless`, `--prompt`, `--prompt-file`, `update`).
  - Startup checks, configuration validation errors, and `~/.ainovel/last-error.log` output.
  - Interactive terminal exit pause prompt (`"Nhấn Enter để thoát..."`).

### 4. Vietnamese Prompts, Styles & Output Templates
- **Novel Style Templates**:
  - Localized and tailored Vietnamese novel style presets in `assets/styles/` (e.g. Tiên hiệp / Huyền huyễn, Kiếm hiệp, Đô thị / Trùng sinh, Ngôn tình, Trinh thám / Kinh dị, Mặc định).
- **Agent Prompts (`assets/prompts/`)**:
  - Provide Vietnamese versions or locale-aware prompt formatting for Architect, Writer, Editor, Arbiter, Revision, and Import agents when `story_language` is `"vi"`.
- **Export & Document Templates**:
  - Localize generated chapter export headers, metadata summaries, and book directory layouts.

---

## Non-Functional Requirements
- **Zero External Runtime Dependencies**: Implemented natively in Go with standard library `embed.FS` and fast in-memory map lookup.
- **Performance**: Translation lookups execute in `< 1ms` with zero noticeable frame delay in Bubble Tea render cycles.
- **Idiomatic Translation**: High-quality, natural Vietnamese translations adhering to software and literary writing conventions.
- **Backward Compatibility**: Fully backward compatible with existing configurations that lack `language` / `story_language` fields (defaults to auto-detected/sensible fallback).

---

## Acceptance Criteria
- [ ] Running `ainovel-cli` on a Vietnamese locale displays all CLI messages and TUI panels in fluent Vietnamese.
- [ ] User can switch language in the TUI via `/config` (or `/setting`) and see the UI update immediately.
- [ ] Running `ainovel-cli --lang vi` forces Vietnamese, while `--lang zh` or `--lang en` switches accordingly.
- [ ] Initial setup wizard (`bootstrap.RunSetup()`) runs in Vietnamese with a language selection step.
- [ ] Novel generation with `story_language: "vi"` generates outlines, characters, chapters, and reviews in natural Vietnamese with Vietnamese style presets.
- [ ] All unit tests pass: `go test ./...` with race detector enabled.

---

## Out of Scope
- Translating developer-facing code comments and internal Go package error variable names.
- Translating raw third-party API error responses returned directly from external LLM providers (context wrappers will be translated).
