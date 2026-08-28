# Codebase Patterns

Reusable patterns discovered during development. Read this before starting new work.

## Code Conventions
- **Explicit Error Wrapping**: Use `fmt.Errorf("context: %w", err)` to preserve error chains.
- **Table-Driven Tests**: Structure unit tests with `tests := []struct{ name string ... }` and `t.Run(tt.name, ...)`.

## Architecture
- **Deterministic Orchestration**: State transitions and routing decisions are executed deterministically by the Go engine without LLM overhead.
- **Auditable Semantics**: Arbiter decisions (planner selection, steering triage) produce structured JSON logged to disk.
- **Atomic File Store**: All state mutations and chapter commits use atomic disk write semantics with replayable checkpoints.
- **Dual Language Decoupling**: UI display language (`Language`) and generation language (`StoryLanguage`) are decoupled to support bilingual workflows.
- **Zero-Dependency Embedded i18n**: Multi-lingual translation dictionaries are embedded via `embed.FS`, flattened at package initialization for $O(1)$ lookups with dot-notation and thread-safe dynamic language switching.

## Gotchas
- **Interactive Terminal Exit**: Fatal errors must be logged to `~/.ainovel/last-error.log` and pause for confirmation in interactive terminals to prevent double-click window closure.
- **Viewport-Safe Layouts**: Dynamic Bubble Tea modal dialogs and sidebars must account for multi-byte Unicode characters (such as Vietnamese diacritics and CJK runes) using visual cell width metrics rather than byte/rune slice lengths.

## Testing
- **Exhaustive State Space Testing**: Route transitions and state machine permutations are verified with exhaustive test tables (`router_exhaustive_test.go`).
- **Temporary Directories**: Isolate filesystem tests using `t.TempDir()`.

---
Last refreshed: 2026-08-28
