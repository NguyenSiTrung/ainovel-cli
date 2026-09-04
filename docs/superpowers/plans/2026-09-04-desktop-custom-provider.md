# Desktop Custom Provider & Model Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement full custom provider and model management (create, edit, delete, live connection test) in the Desktop Application settings interface, supporting OpenAI-compatible and other custom endpoints with write-only credential security.

**Architecture:** Extend the `desktop-v1` protocol with 3 new methods (`config.save_provider`, `config.test_provider`, `config.delete_provider`), wire them to the Go engine's existing `Host.ConfigureModels` and `Host.TestModelConnection`, add `Host.DeleteProvider` with reference safety, update the Tauri command whitelist, and integrate an accessible `ProviderEditorModal` component and toolbar into `SettingsScreen.svelte`.

**Tech Stack:** Go (daemon & engine), Rust (Tauri IPC whitelist), JSON Schema Draft 2020-12, TypeScript, Svelte 5 (`$state`/`$derived`), Vitest, `@testing-library/svelte`.

**Spec:** `docs/superpowers/specs/2026-09-04-desktop-custom-provider-design.md`

## Global Constraints

- Secrets remain strictly engine-side; plaintext API keys are write-only into the daemon and are never echoed back in events, responses, logs, or UI state.
- Protocol changes in `desktop-v1` are strictly additive.
- Modifying or deleting a provider must not break active project runs or orphan references. Deleting a provider that is currently active or referenced as a fallback must be rejected.
- All file operations must use atomic writes with safe file permissions (`0600`).
- Frontend components must follow existing Svelte 5 runes conventions and CSS design variables (`var(--surface-1)`, `var(--border)`, `var(--radius-md)`, etc.).

---

### Task 1: Protocol Schema & Whitelist Updates

**Files:**
- Modify: `protocols/desktop-v1/commands.schema.json`
- Modify: `protocols/desktop-v1/fixtures/valid-requests-catalog.jsonl`
- Modify: `protocols/desktop-v1/validate.mjs`
- Modify: `desktop/src-tauri/src/protocol.rs:70-86`
- Test: `protocols/desktop-v1/validate.mjs`

**Interfaces:**
- Produces: `config.save_provider`, `config.test_provider`, `config.delete_provider` protocol methods in schema and Tauri whitelist.

- [ ] **Step 1: Write failing protocol validation check**

In `protocols/desktop-v1/validate.mjs`, increment `METHOD_COUNT` from `49` to `52`.
Run validation to verify it fails:
`node protocols/desktop-v1/validate.mjs`
Expected: FAIL due to missing methods in `commands.schema.json` and catalog fixtures.

- [ ] **Step 2: Add schema definitions and fixtures for new methods**

In `protocols/desktop-v1/commands.schema.json`:
1. Add `"config.save_provider"`, `"config.test_provider"`, `"config.delete_provider"` to the `method` enum under `request_envelope`.
2. Add `if/then` selector branches mapping each method to its request payload definition:
   - `config_save_provider_request`
   - `config_test_provider_request`
   - `config_delete_provider_request`
3. Add definition schemas:
   - `config_save_provider_request`: `type: "object"`, required `["provider", "type", "models"]`. Properties: `provider` (string), `type` (string), `api` (string), `base_url` (string), `api_key_action` (string), `api_key` (string), `models` (array of objects with `name` and optional `context_window`), `renames` (array).
   - `config_test_provider_request`: same as save plus required `test_model` (string).
   - `config_delete_provider_request`: `type: "object"`, required `["provider"]`.

In `protocols/desktop-v1/fixtures/valid-requests-catalog.jsonl`:
Append the 3 valid request lines:
```jsonl
{"protocol":"desktop-v1","kind":"request","id":"cat-050","method":"config.save_provider","payload":{"provider":"custom-proxy","type":"openai","base_url":"https://api.example.com/v1","models":[{"name":"gpt-4o"}]}}
{"protocol":"desktop-v1","kind":"request","id":"cat-051","method":"config.test_provider","payload":{"provider":"custom-proxy","type":"openai","base_url":"https://api.example.com/v1","models":[{"name":"gpt-4o"}],"test_model":"gpt-4o"}}
{"protocol":"desktop-v1","kind":"request","id":"cat-052","method":"config.delete_provider","payload":{"provider":"custom-proxy"}}
```

In `desktop/src-tauri/src/protocol.rs`:
Add `"config.save_provider"`, `"config.test_provider"`, `"config.delete_provider"` to `METHODS` array.

- [ ] **Step 3: Run protocol validation to verify it passes**

Run: `node protocols/desktop-v1/validate.mjs`
Expected: PASS with all 52 methods and 26 events verified.

---

### Task 2: Go Backend Engine Provider Deletion & Reference Guarding

**Files:**
- Modify: `internal/bootstrap/configfile.go`
- Test: `internal/bootstrap/configfile_test.go`
- Modify: `internal/host/model_config.go`
- Test: `internal/host/model_config_test.go`

**Interfaces:**
- Produces:
  - `bootstrap.DeleteProviderConfig(path string, provider string) error`
  - `host.Host.DeleteProvider(provider string) error`
  - `host.Host.ConfigureModels(draft ModelConfigurationDraft) error` (existing)
  - `host.Host.TestModelConnection(ctx context.Context, draft ModelConfigurationDraft, model string) error` (existing)

- [ ] **Step 1: Write failing unit test for `DeleteProviderConfig`**

In `internal/bootstrap/configfile_test.go`, add `TestDeleteProviderConfig`:
```go
func TestDeleteProviderConfig(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".ainovel", "config.json")
	original := Config{
		Provider: "kept", ModelName: "kept-model",
		Providers: map[string]ProviderConfig{
			"kept":    {Type: "openai", Models: []ModelConfig{{Name: "kept-model"}}},
			"deleted": {Type: "openai", Models: []ModelConfig{{Name: "del-model"}}},
		},
	}
	if err := SaveConfig(path, original); err != nil {
		t.Fatal(err)
	}
	if err := DeleteProviderConfig(path, "deleted"); err != nil {
		t.Fatal(err)
	}
	updated, err := LoadConfigFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := updated.Providers["deleted"]; exists {
		t.Fatalf("provider 'deleted' should have been removed")
	}
	if _, exists := updated.Providers["kept"]; !exists {
		t.Fatalf("provider 'kept' should still exist")
	}
}
```

- [ ] **Step 2: Run test to verify failure**

Run: `go test -v ./internal/bootstrap -run TestDeleteProviderConfig`
Expected: FAIL (`DeleteProviderConfig` undefined).

- [ ] **Step 3: Implement `DeleteProviderConfig`**

In `internal/bootstrap/configfile.go`:
```go
// DeleteProviderConfig 从目标配置文件中删除指定 provider。
func DeleteProviderConfig(path string, provider string) error {
	provider = strings.TrimSpace(provider)
	if provider == "" {
		return fmt.Errorf("provider name cannot be empty")
	}
	target, found, err := loadOptionalJSON(path)
	if err != nil {
		return err
	}
	if !found || target.Providers == nil {
		return nil
	}
	if _, exists := target.Providers[provider]; !exists {
		return nil
	}
	delete(target.Providers, provider)
	return atomicWriteJSON(path, target)
}
```

- [ ] **Step 4: Write failing unit test for `Host.DeleteProvider`**

In `internal/host/model_config_test.go`:
Add `TestDeleteProviderRejectsInUseAndDeletesUnused`:
```go
func TestDeleteProviderRejectsInUseAndDeletesUnused(t *testing.T) {
	h, _ := newModelConfigTestHost(t)
	// proxy is active default provider -> delete must be rejected
	err := h.DeleteProvider("proxy")
	if err == nil {
		t.Fatalf("expected error deleting active default provider")
	}
	// Add unused provider
	err = h.ConfigureModels(ModelConfigurationDraft{
		Provider: "unused", Type: "openai", BaseURL: "https://unused.example/v1",
		Models: []bootstrap.ModelConfig{{Name: "m1"}}, APIKeyAction: APIKeyKeep,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Deleting unused should succeed
	if err := h.DeleteProvider("unused"); err != nil {
		t.Fatalf("delete unused provider failed: %v", err)
	}
}
```

- [ ] **Step 5: Implement `Host.DeleteProvider`**

In `internal/host/model_config.go`:
```go
// DeleteProvider 校验未被引用后，从配置中删除指定 provider 并热应用。
func (h *Host) DeleteProvider(provider string) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	provider = strings.TrimSpace(provider)
	if provider == "" {
		return fmt.Errorf("provider 不能为空")
	}
	if _, ok := h.cfg.Providers[provider]; !ok {
		return fmt.Errorf("provider %q 不存在", provider)
	}
	if h.cfg.Provider == provider {
		return fmt.Errorf("provider %q 仍被默认模型引用，请先切换默认模型后再删除", provider)
	}
	for role, rc := range h.cfg.Roles {
		if rc.Provider == provider {
			return fmt.Errorf("provider %q 仍被角色 %s 引用，请先修改角色配置后再删除", provider, role)
		}
		for _, fallback := range rc.Fallbacks {
			if fallback.Provider == provider {
				return fmt.Errorf("provider %q 仍被角色 %s 的 fallback 引用，请先修改角色配置后再删除", provider, role)
			}
		}
	}

	delete(h.cfg.Providers, provider)
	return bootstrap.DeleteProviderConfig(h.configPath, provider)
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `go test -v ./internal/bootstrap -run TestDeleteProviderConfig`
Run: `go test -v ./internal/host -run TestDeleteProviderRejectsInUseAndDeletesUnused`
Expected: PASS.

---

### Task 3: Desktop Daemon Dispatch Handlers

**Files:**
- Modify: `internal/entry/desktop/dispatch.go`
- Modify: `internal/entry/desktop/project.go`
- Test: `internal/entry/desktop/dispatch_test.go`

**Interfaces:**
- Consumes: `host.Host.ConfigureModels`, `host.Host.TestModelConnection`, `host.Host.DeleteProvider`
- Produces: Handlers for `"config.save_provider"`, `"config.test_provider"`, `"config.delete_provider"`.

- [ ] **Step 1: Write failing dispatch unit tests**

In `internal/entry/desktop/dispatch_test.go`:
Add tests for `config.save_provider`, `config.test_provider`, and `config.delete_provider`:
```go
func TestConfigProviderManagement(t *testing.T) {
	d, _ := newTestDaemon(t)
	// 1. Test invalid save (empty models)
	resp := doRequest(t, d, requestLine("sp1", "config.save_provider", `{"provider":"test-p","type":"openai","models":[]}`))
	if resp["ok"] == true {
		t.Fatalf("expected failure for empty models")
	}

	// 2. Test valid save
	resp = doRequest(t, d, requestLine("sp2", "config.save_provider", `{"provider":"custom-proxy","type":"openai","base_url":"https://api.example/v1","models":[{"name":"custom-model","context_window":128000}]}`))
	if resp["ok"] != true {
		t.Fatalf("save provider failed: %v", resp)
	}

	// 3. Test connection probe with mock server
	resp = doRequest(t, d, requestLine("tp1", "config.test_provider", `{"provider":"custom-proxy","type":"openai","base_url":"https://api.example/v1","models":[{"name":"custom-model"}],"test_model":"custom-model"}`))
	// Connection will fail network call to example.com, returning structured operation_failed error
	if resp["ok"] == true {
		t.Fatalf("expected network failure for unroutable host")
	}
	if resp["error"].(map[string]any)["code"] != CodeOperationFailed {
		t.Fatalf("expected operation_failed, got %v", resp["error"])
	}

	// 4. Test delete
	resp = doRequest(t, d, requestLine("dp1", "config.delete_provider", `{"provider":"custom-proxy"}`))
	if resp["ok"] != true {
		t.Fatalf("delete provider failed: %v", resp)
	}
}
```

- [ ] **Step 2: Run dispatch tests to verify failure**

Run: `go test -v ./internal/entry/desktop -run TestConfigProviderManagement`
Expected: FAIL (methods not registered in dispatch table).

- [ ] **Step 3: Implement dispatch handlers in `project.go` and wire in `dispatch.go`**

In `internal/entry/desktop/dispatch.go`:
Add to `initMethods()`:
```go
"config.save_provider":   d.handleConfigSaveProvider,
"config.test_provider":   d.handleConfigTestProvider,
"config.delete_provider": d.handleConfigDeleteProvider,
```

In `internal/entry/desktop/project.go`:
Implement helper `parseModelConfigurationDraft(payload map[string]any) (host.ModelConfigurationDraft, error)`:
- Extracts `provider`, `type`, `api`, `base_url`, `api_key_action`, `api_key`, `models` (parsing `name` and `context_window`), and `renames`.

Implement `handleConfigSaveProvider`:
```go
func (d *Daemon) handleConfigSaveProvider(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	draft, err := parseModelConfigurationDraft(req.Payload)
	if err != nil {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, err.Error(), nil)
	}
	if err := p.host.ConfigureModels(draft); err != nil {
		d.log("warn", "config", "save provider failed", "provider", draft.Provider, "err", err.Error())
		return errorResponse(req.ID, d.session, classifyCode(err), err.Error(), nil)
	}
	mcfg := p.host.ModelConfiguration()
	var summary map[string]any
	for _, s := range providerSummaries(mcfg) {
		if s["name"] == draft.Provider {
			summary = s
			break
		}
	}
	d.emitEvent(p.id, "notification.info", map[string]any{
		"message": fmt.Sprintf("provider %q configuration saved", draft.Provider),
	})
	return successResponse(req.ID, d.session, map[string]any{"saved": true, "provider": summary})
}
```

Implement `handleConfigTestProvider`:
```go
func (d *Daemon) handleConfigTestProvider(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	draft, err := parseModelConfigurationDraft(req.Payload)
	if err != nil {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, err.Error(), nil)
	}
	testModel := strings.TrimSpace(payloadString(req.Payload, "test_model"))
	if testModel == "" {
		if len(draft.Models) > 0 {
			testModel = draft.Models[0].Name
		} else {
			return errorResponse(req.ID, d.session, CodeInvalidPayload, "test_model is required", nil)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	start := time.Now()
	if err := p.host.TestModelConnection(ctx, draft, testModel); err != nil {
		d.log("warn", "config", "test provider connection failed", "provider", draft.Provider, "model", testModel, "err", err.Error())
		return errorResponse(req.ID, d.session, CodeOperationFailed, redactString(err.Error()), nil)
	}
	latency := time.Since(start).Milliseconds()
	return successResponse(req.ID, d.session, map[string]any{
		"success": true, "latency_ms": latency,
	})
}
```

Implement `handleConfigDeleteProvider`:
```go
func (d *Daemon) handleConfigDeleteProvider(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	provider := strings.TrimSpace(payloadString(req.Payload, "provider"))
	if provider == "" {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "provider is required", nil)
	}
	if err := p.host.DeleteProvider(provider); err != nil {
		d.log("warn", "config", "delete provider failed", "provider", provider, "err", err.Error())
		return errorResponse(req.ID, d.session, classifyCode(err), err.Error(), nil)
	}
	d.emitEvent(p.id, "notification.info", map[string]any{
		"message": fmt.Sprintf("provider %q deleted", provider),
	})
	return successResponse(req.ID, d.session, map[string]any{"deleted": true, "provider": provider})
}
```

- [ ] **Step 4: Run dispatch unit tests to verify they pass**

Run: `go test -v ./internal/entry/desktop -run TestConfigProviderManagement`
Expected: PASS.

---

### Task 4: Desktop Frontend Protocol Types & API Wrappers

**Files:**
- Modify: `desktop/frontend/src/lib/types/protocol.ts`
- Modify: `desktop/frontend/src/lib/api/desktop.ts`
- Test: `desktop/frontend/src/lib/api/desktop.test.ts`

**Interfaces:**
- Produces:
  - `SaveProviderPayload`, `TestProviderPayload`, `DeleteProviderPayload`
  - `configSaveProvider`, `configTestProvider`, `configDeleteProvider`

- [ ] **Step 1: Write failing API unit tests**

In `desktop/frontend/src/lib/api/desktop.test.ts`:
Add tests calling `configSaveProvider`, `configTestProvider`, `configDeleteProvider`:
```ts
it('configSaveProvider invokes config.save_provider with payload', async () => {
  tauri.reply('desktop_request', { saved: true, provider: { name: 'test' } });
  const res = await configSaveProvider({
    provider: 'test', type: 'openai', models: [{ name: 'gpt' }]
  });
  expect(res.saved).toBe(true);
  expect(tauri.callsOf('desktop_request')[0]?.args).toMatchObject({
    method: 'config.save_provider'
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm --prefix desktop/frontend test -- desktop.test.ts`
Expected: FAIL (`configSaveProvider` not exported).

- [ ] **Step 3: Implement protocol types and API wrappers**

In `desktop/frontend/src/lib/types/protocol.ts`:
Add `config.save_provider`, `config.test_provider`, `config.delete_provider` to `DesktopRequestMethod`.

In `desktop/frontend/src/lib/api/desktop.ts`:
Export types:
```ts
export interface ProviderModelDraft {
  name: string;
  context_window?: number;
}

export interface SaveProviderPayload {
  provider: string;
  type: string;
  api?: string;
  base_url?: string;
  api_key_action?: 'keep' | 'replace' | 'clear';
  api_key?: string;
  models: ProviderModelDraft[];
  renames?: Array<{ from: string; to: string }>;
}

export interface SaveProviderResult {
  saved: boolean;
  provider: ProviderSummary;
}

export interface TestProviderPayload extends SaveProviderPayload {
  test_model: string;
}

export interface TestProviderResult {
  success: boolean;
  latency_ms?: number;
}

export interface DeleteProviderPayload {
  provider: string;
}

export interface DeleteProviderResult {
  deleted: boolean;
  provider: string;
}
```

Export API functions:
```ts
export async function configSaveProvider(payload: SaveProviderPayload): Promise<SaveProviderResult> {
  return request<SaveProviderResult>('config.save_provider', payload as unknown as Record<string, unknown>);
}

export async function configTestProvider(payload: TestProviderPayload): Promise<TestProviderResult> {
  return request<TestProviderResult>('config.test_provider', payload as unknown as Record<string, unknown>);
}

export async function configDeleteProvider(payload: DeleteProviderPayload): Promise<DeleteProviderResult> {
  return request<DeleteProviderResult>('config.delete_provider', payload as unknown as Record<string, unknown>);
}
```

- [ ] **Step 4: Run API unit tests to verify they pass**

Run: `npm --prefix desktop/frontend test -- desktop.test.ts`
Expected: PASS.

---

### Task 5: Settings Store Orchestration

**Files:**
- Modify: `desktop/frontend/src/lib/settings.ts`
- Test: `desktop/frontend/src/lib/settings.test.ts`

**Interfaces:**
- Produces:
  - `saveProviderFromUi(payload: SaveProviderPayload): Promise<boolean>`
  - `testProviderFromUi(payload: TestProviderPayload): Promise<{ ok: boolean; latencyMs?: number; error?: string }>`
  - `deleteProviderFromUi(provider: string): Promise<boolean>`

- [ ] **Step 1: Write failing settings store tests**

In `desktop/frontend/src/lib/settings.test.ts`:
Add tests for `saveProviderFromUi`, `testProviderFromUi`, and `deleteProviderFromUi`:
```ts
it('saveProviderFromUi updates view providers and active selection on success', async () => {
  // test implementation
});
it('deleteProviderFromUi calls config.delete_provider and refreshes view', async () => {
  // test implementation
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm --prefix desktop/frontend test -- settings.test.ts`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement actions in `settings.ts`**

In `desktop/frontend/src/lib/settings.ts`:
1. Add `saveProviderFromUi`:
   - Invokes `configSaveProvider`.
   - On success, updates `settingsState.view.providers` (replacing or adding the updated `ProviderSummary`), sets `message: "Provider <name> saved"`, calls `refreshConfig()`.
2. Add `testProviderFromUi`:
   - Invokes `configTestProvider`.
   - Returns `{ ok: true, latencyMs: res.latency_ms }` on success, or `{ ok: false, error: err.message }` on error.
3. Add `deleteProviderFromUi`:
   - Invokes `configDeleteProvider`.
   - On success, triggers `refreshConfig()`, resets selection if the deleted provider was selected.

- [ ] **Step 4: Run settings store tests to verify they pass**

Run: `npm --prefix desktop/frontend test -- settings.test.ts`
Expected: PASS.

---

### Task 6: ProviderEditorModal Component

**Files:**
- Create: `desktop/frontend/src/lib/components/ProviderEditorModal.svelte`
- Test: `desktop/frontend/src/lib/components/ProviderEditorModal.test.ts`

**Interfaces:**
- Consumes: `saveProviderFromUi`, `testProviderFromUi`, `ProviderSummary`
- Props:
  - `open: boolean`
  - `provider: ProviderSummary | null` (null = create mode, non-null = edit mode)
  - `onclose: () => void`
  - `onsaved: (providerName: string) => void`

- [ ] **Step 1: Write failing component test**

In `desktop/frontend/src/lib/components/ProviderEditorModal.test.ts`:
```ts
it('renders modal with fields and dispatches test and save', async () => {
  // render ProviderEditorModal with open=true
  // verify inputs: provider name, type select, base_url, model row
  // trigger test connection and verify mock call
  // trigger save and verify saveProviderFromUi called
});
```

- [ ] **Step 2: Run component test to verify failure**

Run: `npm --prefix desktop/frontend test -- ProviderEditorModal.test.ts`
Expected: FAIL (component not found).

- [ ] **Step 3: Implement `ProviderEditorModal.svelte`**

Create `desktop/frontend/src/lib/components/ProviderEditorModal.svelte`:
- Implement form with `$state`:
  - `providerName`, `providerType` (default `"openai"`), `apiEndpoint` (`"chat"` or `"responses"`), `baseUrl`.
  - Credential action: `"keep" | "replace" | "clear"`, and `apiKey` input.
  - Models array: `models: Array<{ name: string; context_window?: number }>`.
  - Test connection state: `testStatus: "idle" | "testing" | "success" | "error"`, `testResult: string`.
- Live validation: Provider Name and at least one non-empty Model name required before Save is enabled.
- "Test connection" button: passes draft and selected model to `testProviderFromUi`.
- "Save provider" button: calls `saveProviderFromUi`, emits `onsaved`, closes modal.

- [ ] **Step 4: Run component test to verify it passes**

Run: `npm --prefix desktop/frontend test -- ProviderEditorModal.test.ts`
Expected: PASS.

---

### Task 7: SettingsScreen Integration & End-to-End Verification

**Files:**
- Modify: `desktop/frontend/src/lib/screens/SettingsScreen.svelte`
- Test: `desktop/frontend/src/lib/screens/settings.test.ts`

**Interfaces:**
- Consumes: `ProviderEditorModal`, `deleteProviderFromUi`

- [ ] **Step 1: Write failing integration test in `settings.test.ts`**

In `desktop/frontend/src/lib/screens/settings.test.ts`:
```ts
it('shows Add Provider and Edit buttons and opens ProviderEditorModal', async () => {
  renderSettings();
  const addBtn = screen.getByTestId('settings-provider-add');
  expect(addBtn).toBeTruthy();
  await fireEvent.click(addBtn);
  expect(screen.getByTestId('provider-editor-modal')).toBeTruthy();
});

it('disables Delete button when currently active model is selected', async () => {
  renderSettings();
  const delBtn = screen.getByTestId('settings-provider-delete');
  expect(delBtn.hasAttribute('disabled')).toBe(true);
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npm --prefix desktop/frontend test -- settings.test.ts`
Expected: FAIL (elements not found).

- [ ] **Step 3: Update `SettingsScreen.svelte`**

In `desktop/frontend/src/lib/screens/SettingsScreen.svelte`:
1. Import `ProviderEditorModal` and `deleteProviderFromUi`.
2. Add state `showProviderModal = $state(false)`, `modalTargetProvider = $state<ProviderSummary | null>(null)`.
3. In the "Provider & model" card, next to the provider select, add toolbar:
   - `<button type="button" class="small" onclick={() => openAddProvider()} data-testid="settings-provider-add">+ Add provider</button>`
   - `<button type="button" class="small" onclick={() => openEditProvider()} data-testid="settings-provider-edit">Edit</button>`
   - `<button type="button" class="small danger" disabled={selectedProvider === view?.provider} onclick={() => confirmDeleteProvider()} data-testid="settings-provider-delete">Delete</button>`
4. Render `<ProviderEditorModal open={showProviderModal} provider={modalTargetProvider} onclose={() => showProviderModal = false} onsaved={(name) => { selectedProvider = name; showProviderModal = false; }} />`.

- [ ] **Step 4: Run all test suites across the project**

Run: `node protocols/desktop-v1/validate.mjs`
Run: `go test -v ./internal/...`
Run: `npm --prefix desktop/frontend test`
Expected: ALL PASS.
