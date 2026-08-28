# Track Learnings: vietnamese_localization_20260828

Patterns, gotchas, and context discovered during implementation.

## Codebase Patterns (Inherited)

### Code Conventions
- **Explicit Error Wrapping**: Use `fmt.Errorf("context: %w", err)` to preserve error chains.
- **Table-Driven Tests**: Structure unit tests with `tests := []struct{ name string ... }` and `t.Run(tt.name, ...)`.

### Architecture
- **Deterministic Orchestration**: State transitions and routing decisions are executed deterministically by the Go engine without LLM overhead.
- **Auditable Semantics**: Arbiter decisions (planner selection, steering triage) produce structured JSON logged to disk.
- **Atomic File Store**: All state mutations and chapter commits use atomic disk write semantics with replayable checkpoints.

### Gotchas
- **Interactive Terminal Exit**: Fatal errors must be logged to `~/.ainovel/last-error.log` and pause for confirmation in interactive terminals to prevent double-click window closure.

### Testing
- **Exhaustive State Space Testing**: Route transitions and state machine permutations are verified with exhaustive test tables (`router_exhaustive_test.go`).
- **Temporary Directories**: Isolate filesystem tests using `t.TempDir()`.

---

<!-- Learnings from implementation will be appended below -->

### Phase 1: Foundation & Core i18n Engine
- **Embedded Catalogs & Flattening**: JSON translation dictionaries embedded via `embed.FS` are recursively flattened at initialization time for $O(1)$ key lookups with dot-notation.
- **Graceful Fallback**: Missing keys fall back to `vi` (default), then to the raw key string to prevent panics or UI breakages.
- **Locale Auto-Detection**: Prioritizes `AINOVEL_LANG`, then standard POSIX variables (`LC_ALL`, `LC_MESSAGES`, `LANGUAGE`, `LANG`), defaulting safely to `vi`.

### Phase 2: Configuration, Bootstrap & Settings Integration
- **Dual Language Architecture**: `Language` (UI display) and `StoryLanguage` (novel output) are decoupled in `bootstrap.Config`, allowing developers/users to use a Vietnamese UI with English/Chinese generation or vice versa.
- **Live TUI Language Switching**: Changing the language in `/config` (or `/setting`) immediately updates global `i18n.CurrentLanguage()` and notifies `Host`, enabling instant re-render of Bubble Tea viewports without process restart.

### Phase 3: CLI, Error Handling & Global Application Messages
- **Early Flag Interception**: Flags `--lang` / `-l` and `--story-lang` are parsed before configuration loading or setup wizards so error messages and prompts immediately reflect the requested locale.
- **Interactive Crash Protection**: Localized pause prompts (`"Nhấn Enter để thoát..."`) ensure error logs are visible to users before GUI/interactive terminal window closure.

### Phase 4: Complete TUI Interface Localization
- **Viewport-Safe Layouts**: Replaced hardcoded text in dynamic Bubble Tea viewports (Sidebar, Activity feed, Outline, Modals, Status Bar) with `i18n.T()` lookups while preserving ANSI cell width calculations.
- **Dynamic Runtime Placeholders**: Input prompts and placeholders seamlessly switch between active generation, review gates (`/next`), and completion modes in Vietnamese.

### Phase 5: Vietnamese Prompts, Styles & Output Templates
- **Genre-Specific Vietnamese Style Presets**: Added high-fidelity genre presets (`tienhiep`, `kiemhiep`, `dothi`, `ngontinh`, `trinhtham`) defining pacing, cultivation systems, dialogue conventions, and narrative rules for Vietnamese readers.
- **Dynamic Export Localization**: TXT and EPUB export formats adapt chapter headers, table of contents, cover labels, and volume dividers according to the active locale without breaking structural invariants.
