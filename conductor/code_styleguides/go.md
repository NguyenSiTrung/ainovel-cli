# Go Code Styleguide

## 1. General Principles
- Follow standard Go conventions (`gofmt`, `go vet`, `golint`).
- Keep package APIs minimal and focused. Avoid unnecessary abstractions and premature interfaces.
- Prefer explicit state passing and deterministic logic over hidden global state.

## 2. Error Handling
- Never ignore errors; always handle or wrap them.
- Use `fmt.Errorf("context: %w", err)` for semantic error wrapping to preserve the causal chain.
- Provide descriptive context in error messages without capitalizing the first letter or ending with punctuation.

## 3. Concurrency & State Safety
- Use `flock` and filesystem atomic writes for multi-process or crash-resilient data persistence.
- Mutexes should protect discrete data structures; avoid holding locks across I/O or network calls.
- Use `context.Context` for cancellation and timeout propagation across agent loops.

## 4. Testing
- Use standard Go `testing` package with table-driven tests (`tests := []struct{ name string ... }`).
- Run subtests with `t.Run(tt.name, func(t *testing.T) { ... })`.
- Ensure unit and integration tests are isolated, deterministic, and self-cleaning.
