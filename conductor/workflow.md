# Development Workflow

## 1. Core Methodology: Context-Driven TDD
- **Measure Twice, Code Once**: Verify specifications, dependencies, and state boundaries before writing code.
- **Test-Driven Development (TDD)**:
  - Write failing test first (`red`).
  - Implement minimum code to pass test (`green`).
  - Refactor for simplicity and performance (`refactor`).
- **State Machine Verification**: For routing, lifecycle, and store state changes, maintain exhaustive state transition coverage.

## 2. Test Execution & Standards
- **Command Suite**:
  - Run all tests: `go test ./...`
  - Run with race detector: `go test -race ./...`
  - Run package tests: `go test -v ./internal/<package>/...`
  - Check coverage: `go test -cover ./internal/<package>/...`
- **Coverage Target**: Minimum 80% coverage on new and modified business logic.
- **Testing Patterns**:
  - Standard Go table-driven tests (`tests := []struct{ name string ... }`).
  - Isolated temporary directories for storage/file tests (`t.TempDir()`).
  - Deterministic state machine testing (exhaustive permutation coverage for routing & state flows).
  - Contract & simulation tests for agent loops and TUI command handling.

## 3. Commit & Progress Tracking
- **Commit Frequency**: Commit after each completed task.
- **Commit Message Convention**:
  - `feat(<scope>): <summary>`
  - `fix(<scope>): <summary>`
  - `test(<scope>): <summary>`
  - `refactor(<scope>): <summary>`
- **Task Verification Protocol**:
  - Before marking a task `[x]`, execute test suite and verify clean output.
  - Record task learnings in track `learnings.md`.
