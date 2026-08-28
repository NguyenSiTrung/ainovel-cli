# CLI & Terminal UI Styleguide

## 1. Terminal UI (Bubble Tea & Lip Gloss)
- Structure UI models with the Elm architecture (`Init`, `Update`, `View`).
- Keep `View()` pure and side-effect free.
- Scope Lip Gloss styling functions to package or module level; avoid instantiating new styles inside hot rendering loops.
- Support terminal resize events gracefully via `tea.WindowSizeMsg`.

## 2. Headless & Scripting Support
- Separate interactive view logic from underlying engine execution.
- Maintain full parity between headless CLI execution and TUI orchestration.
- Route narrative / primary content to `stdout` and operational / debug logs to `stderr` or dedicated log files.

## 3. Reliability & Fatal Error Handling
- Write fatal error traces and context to `~/.ainovel/last-error.log`.
- In interactive terminal environments, pause before exiting on fatal errors to prevent sudden window closure.
