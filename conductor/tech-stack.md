# Technology Stack

## Core Technologies
- **Language**: Go 1.25.5
- **CLI & TUI Architecture**:
  - `github.com/charmbracelet/bubbletea` (v1.3.10) — Elm-architecture terminal UI framework
  - `github.com/charmbracelet/bubbles` (v1.0.0) — TUI UI components (viewports, textinputs, spinners)
  - `github.com/charmbracelet/lipgloss` (v1.1.0) — Terminal styling and layout engine
  - `github.com/muesli/termenv` (v0.16.0) — ANSI terminal color and feature detection
- **Agent Orchestration & LLM Integration**:
  - `github.com/voocel/agentcore` (v1.8.2) — Autonomous agent loop and tool dispatch runtime
  - `github.com/voocel/litellm` (v1.8.10) — Unified multi-provider LLM client interface
- **State & Storage**:
  - Atomic File I/O — JSON and Markdown document persistence with crash-safe atomic write semantics
  - `github.com/gofrs/flock` (v0.13.0) — File-level concurrency locking for multi-process safety
- **Task & Project Management**:
  - Beads (`bd`) — Issue and task tracking backed by local Dolt database
- **Build & Quality Tooling**:
  - Go toolchain (`go test`, `go build`, `go vet`, `go fmt`)
  - Cross-platform install and verification scripts
