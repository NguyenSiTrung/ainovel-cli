# Desktop App Custom Provider & Model Management Design

- **Date**: 2026-09-04
- **Status**: Proposed
- **Author**: Assistant & User
- **Scope**: Architectural (Protocols, Go Backend, Tauri IPC Bridge, Desktop Frontend UI)

---

## 1. Problem Statement & Motivation

Currently, the Desktop App's Settings screen (`SettingsScreen.svelte`) allows users only to switch between pre-configured providers and models via dropdown selectors. 

While the underlying Go engine (`internal/bootstrap` and `internal/host`) already has robust support for custom OpenAI-compatible endpoints, custom base URLs, and custom API keys:
1. The Desktop UI provides no mechanism (forms, buttons, or dialogs) to add, modify, test, or remove providers.
2. The `desktop-v1` IPC protocol currently lacks methods for provider-level mutations (`config.update` deliberately rejects provider changes as `unsupported`).
3. Users who want to use custom OpenAI-compatible providers (such as Ollama, vLLM, DeepSeek, OpenRouter, or local proxies) are forced to manually edit JSON configuration files or use the terminal CLI (`/config`).

This design introduces a full **Provider & Model Manager** directly in the Desktop App, accompanied by live connection testing and write-only credential security.

---

## 2. Requirements & Goals

### Functional Requirements
- **Create Provider**: Add a new provider with Name/ID, Protocol Type (`openai`, `anthropic`, `gemini`), API endpoint style (`chat`, `responses`), Base URL, optional API Key, and a list of Models with token Context Windows.
- **Edit Provider**: Modify existing providers (Base URL, models, context windows, API key).
- **Safe Credential Management**: Plaintext API keys must remain write-only. When editing an existing provider, users can choose to **Keep existing key** (masked hint shown), **Replace key**, or **Clear key**.
- **Live Connection Test**: A "Test Connection" button that sends a minimal probe call via the engine to verify endpoint reachability and credentials before saving.
- **Delete Provider**: Safely delete a provider configuration with reference-protection (rejects deletion if the provider is active or referenced as a fallback).
- **Instant Hot-Reload**: Changes saved in the dialog immediately update the UI, the Go host's model set, and persist to `config.json`.

### Non-Goals
- Exposing plaintext secrets over the IPC protocol or into webview memory (redaction rules remain inviolable).
- In-UI editing of arbitrary engine internals (e.g. prompt template overrides or Python runtime bridges).

---

## 3. Protocol Contract Additions (`desktop-v1`)

Three additive RPC methods will be registered in `protocols/desktop-v1/commands.schema.json` and `desktop/src-tauri/src/protocol.rs`.

### 3.1 `config.save_provider`
Saves or updates a provider in the configuration and hot-applies it in the engine.

- **Request**:
  ```json
  {
    "provider": "deepseek-local",
    "type": "openai",
    "api": "chat",
    "base_url": "https://api.deepseek.com/v1",
    "api_key_action": "replace",
    "api_key": "sk-...",
    "models": [
      { "name": "deepseek-chat", "context_window": 64000 },
      { "name": "deepseek-reasoner", "context_window": 64000 }
    ],
    "renames": []
  }
  ```
  - `provider` (string, required): Unique provider identifier.
  - `type` (string, required): `openai` | `anthropic` | `gemini`.
  - `api` (string, optional): `chat` | `responses`. Default is `chat`.
  - `base_url` (string, optional): Endpoint URL.
  - `api_key_action` (string, optional): `keep` | `replace` | `clear`. Default is `keep` if `api_key` is empty, or `replace` if `api_key` is non-empty.
  - `api_key` (string, optional): Secret key string (write-only).
  - `models` (array of objects, required): Minimum 1 model. Each object has `name` (string) and optional `context_window` (integer >= 0).
  - `renames` (array of objects, optional): Model rename tracking `[{ "from": "...", "to": "..." }]`.

- **Response**:
  ```json
  {
    "saved": true,
    "provider": {
      "name": "deepseek-local",
      "type": "openai",
      "api": "chat",
      "base_url": "https://api.deepseek.com/v1",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "has_api_key": true,
      "api_key_hint": "sk-******4f2a",
      "requires_api_key": true
    }
  }
  ```

### 3.2 `config.test_provider`
Executes a live probe using draft configuration without persisting or modifying runtime selection.

- **Request**:
  Same fields as `config.save_provider`, plus `test_model` (string, required).
  ```json
  {
    "provider": "deepseek-local",
    "type": "openai",
    "base_url": "https://api.deepseek.com/v1",
    "api_key": "sk-...",
    "models": [{ "name": "deepseek-chat" }],
    "test_model": "deepseek-chat"
  }
  ```

- **Response**:
  ```json
  {
    "success": true,
    "latency_ms": 284
  }
  ```
  - On failure: Returns structured error (`operation_failed` or `invalid_payload`) with scrubbed error message.

### 3.3 `config.delete_provider`
Deletes a provider from the configuration.

- **Request**:
  ```json
  {
    "provider": "deepseek-local"
  }
  ```

- **Response**:
  ```json
  {
    "deleted": true,
    "provider": "deepseek-local"
  }
  ```
  - Safety rule: If the provider is in use (e.g. `c.Provider == provider` or in `c.Roles`), returns `operation_failed` with explicit explanation.

---

## 4. Go Backend Architecture (`internal/`)

### 4.1 Bootstrap Storage (`internal/bootstrap/configfile.go`)
- Implement `DeleteProviderConfig(path string, provider string) error`:
  - Reads target config file (project `.ainovel/config.json` or global `~/.ainovel/config.json`).
  - Removes the key from `target.Providers`.
  - Atomically writes back with secure permissions (`0600`).

### 4.2 Host Engine (`internal/host/model_config.go`)
- **Saving**: Reuse `Host.ConfigureModels(draft ModelConfigurationDraft)`:
  - Already handles validation, model renames, reference checks, disk persistence, and hot-updating memory models.
- **Testing**: Reuse `Host.TestModelConnection(ctx context.Context, draft ModelConfigurationDraft, model string)`:
  - Generates a temporary `agentcore.ChatModel` with draft parameters and runs a test probe message (`"Reply OK."`).
- **Deleting**: Implement `Host.DeleteProvider(provider string) error`:
  - Ensures no active references exist (`h.cfg.Provider != provider` and no role/fallback references).
  - Deletes from disk using `DeleteProviderConfig` and updates `h.cfg.Providers`.

### 4.3 Desktop Daemon Dispatch (`internal/entry/desktop/`)
- Register handlers in `dispatch.go`:
  - `"config.save_provider": d.handleConfigSaveProvider`
  - `"config.test_provider": d.handleConfigTestProvider`
  - `"config.delete_provider": d.handleConfigDeleteProvider`
- In `project.go`:
  - Implement request validation and error mapping.
  - Emit desktop event `notification.info` upon successful provider save or deletion.

---

## 5. Tauri Shell IPC Layer (`desktop/src-tauri/`)

- Update `desktop/src-tauri/src/protocol.rs`:
  - Append `"config.save_provider"`, `"config.test_provider"`, and `"config.delete_provider"` to `METHODS` whitelist.
  - Update method count assertion and fixtures in `validate.mjs`.

---

## 6. Desktop Frontend UI (`desktop/frontend/`)

### 6.1 State Management & API (`lib/settings.ts` & `lib/api/desktop.ts`)
- Add API wrappers:
  - `configSaveProvider(payload: SaveProviderPayload): Promise<SaveProviderResult>`
  - `configTestProvider(payload: TestProviderPayload): Promise<TestProviderResult>`
  - `configDeleteProvider(payload: DeleteProviderPayload): Promise<DeleteProviderResult>`
- Add store action flows in `settings.ts`:
  - `saveProviderFromUi(draft)`: sends request, updates settings view, and re-selects the saved provider.
  - `testProviderFromUi(draft, testModel)`: performs connection test.
  - `deleteProviderFromUi(name)`: deletes provider and resets selection to active default.

### 6.2 Provider Editor Modal Component (`lib/components/ProviderEditorModal.svelte`)
A dedicated dialog component with:
- **Mode**: Create (`isNew = true`) or Edit (`isNew = false`).
- **Fields**:
  - `Provider ID`: Input (disabled in Edit mode).
  - `Protocol Type`: Select (`openai`, `anthropic`, `gemini`).
  - `API Endpoint`: Select (`chat` or `responses` when type is `openai`).
  - `Base URL`: Text input with helpful placeholder (e.g. `http://localhost:11434/v1` or `https://api.deepseek.com/v1`).
  - `API Key Management`:
    - When New: Single password input.
    - When Edit: Radio options (`Keep existing key [sk-******1234]`, `Replace key`, `Clear key`).
  - `Models Table`:
    - Dynamic rows with Model ID and Context Window inputs.
    - Add Model / Remove Model buttons.
  - `Test Connection`:
    - Model selection dropdown + "Test Connection" button.
    - Live feedback pill (idle, testing spinner, success latency badge, or error alert).
- **Actions**:
  - Cancel and Save buttons with in-flight loading guards.

### 6.3 SettingsScreen Integration (`lib/screens/SettingsScreen.svelte`)
- Add action buttons in the "Provider & model" card:
  - `+ Add provider`: opens modal in Create mode.
  - `Edit`: opens modal in Edit mode for currently selected provider.
  - `Delete`: prompts confirmation and triggers deletion (disabled if provider is active or referenced).

---

## 7. Verification & Testing Strategy

1. **Protocol Schema Tests**:
   - Update `protocols/desktop-v1/commands.schema.json` and `valid-requests-catalog.jsonl`.
   - Run `node protocols/desktop-v1/validate.mjs` to ensure draft-2020-12 schema conformance and fixture completeness.
2. **Go Engine Unit Tests**:
   - `internal/bootstrap/configfile_test.go`: Verify `DeleteProviderConfig` safely removes provider while preserving others.
   - `internal/host/model_config_test.go`: Verify reference checking on provider deletion.
   - `internal/entry/desktop/dispatch_test.go`: Test IPC dispatch for `config.save_provider`, `config.test_provider`, and `config.delete_provider`.
3. **Frontend Vitest Suites**:
   - `desktop/frontend/src/lib/settings.test.ts`: Verify `saveProviderFromUi`, `testProviderFromUi`, and `deleteProviderFromUi`.
   - `desktop/frontend/src/lib/screens/settings.test.ts`: Verify UI interactions (opening modal, filling fields, testing connection, saving, deleting).
4. **End-to-End Smoke Testing**:
   - Verify adding an OpenAI-compatible endpoint (e.g. local or proxy endpoint), testing connection, saving, and switching to the new model in the desktop application.
