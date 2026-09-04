<script lang="ts">
  import { untrack } from 'svelte';
  import type { ProviderSummary } from '$lib/api/desktop';
  import { fetchProviderModelsFromUi, PROVIDER_PRESETS, saveProviderFromUi, testProviderFromUi } from '$lib/settings';

  interface Props {
    open: boolean;
    provider?: ProviderSummary | null;
    onclose?: () => void;
    onsaved?: (providerName: string) => void;
  }

  let { open = false, provider = null, onclose, onsaved }: Props = $props();

  let isNew = $derived(provider === null);

  let selectedPresetId = $state('custom');
  let name = $state('');
  let type = $state('openai');
  let api = $state('chat');
  let baseUrl = $state('');
  let apiKeyAction = $state<'keep' | 'replace' | 'clear'>('replace');
  let apiKey = $state('');
  let models = $state<Array<{ name: string; context_window?: number }>>([{ name: '', context_window: 128000 }]);

  let testModel = $state('');
  let testStatus = $state<'idle' | 'testing' | 'success' | 'error'>('idle');
  let testFeedback = $state('');
  let saving = $state(false);
  let formError = $state<string | null>(null);

  let fetchingModels = $state(false);
  let remoteModels = $state<string[]>([]);
  let showModelPicker = $state(false);
  let modelSearchQuery = $state('');
  let selectedRemoteModels = $state<Record<string, boolean>>({});
  let fetchError = $state<string | null>(null);

  let lastInitKey = $state<string | null>(null);

  $effect(() => {
    const key = open ? (provider ? `edit:${provider.name}` : 'new') : null;
    if (key !== null && key !== lastInitKey) {
      lastInitKey = key;
      untrack(() => {
        if (provider) {
          name = provider.name ?? '';
          type = provider.type || 'openai';
          api = provider.api || 'chat';
          baseUrl = provider.base_url ?? '';
          apiKeyAction = 'keep';
          apiKey = '';
          models = (provider.models ?? []).map((m) => ({ name: m, context_window: 128000 }));
          if (models.length === 0) {
            models = [{ name: '', context_window: 128000 }];
          }
        } else {
          selectedPresetId = 'custom';
          name = '';
          type = 'openai';
          api = 'chat';
          baseUrl = '';
          apiKeyAction = 'replace';
          apiKey = '';
          models = [{ name: '', context_window: 128000 }];
        }
        testModel = models[0]?.name ?? '';
        testStatus = 'idle';
        testFeedback = '';
        formError = null;
        fetchingModels = false;
        remoteModels = [];
        showModelPicker = false;
        modelSearchQuery = '';
        selectedRemoteModels = {};
        fetchError = null;
      });
    } else if (!open) {
      lastInitKey = null;
    }
  });

  let validModels = $derived(models.filter((m) => m.name.trim() !== ''));

  $effect(() => {
    const currentValid = validModels;
    untrack(() => {
      if (currentValid.length > 0 && (!testModel || !currentValid.some((m) => m.name === testModel))) {
        testModel = currentValid[0]?.name ?? '';
      }
    });
  });

  let canTest = $derived(
    name.trim() !== '' &&
    type.trim() !== '' &&
    validModels.length > 0 &&
    testModel !== '' &&
    testStatus !== 'testing'
  );

  let canSave = $derived(
    name.trim() !== '' &&
    type.trim() !== '' &&
    validModels.length > 0 &&
    !saving &&
    testStatus !== 'testing'
  );

  function addModel(): void {
    models.push({ name: '', context_window: 128000 });
  }

  function removeModel(index: number): void {
    if (models.length > 1) {
      models.splice(index, 1);
    } else {
      models[0] = { name: '', context_window: 128000 };
    }
  }

  let existingModelNames = $derived(new Set(models.map((m) => m.name.trim()).filter((n) => n !== '')));
  let activePreset = $derived(PROVIDER_PRESETS.find((p) => p.id === selectedPresetId));
  let isApiKeyOptional = $derived(
    isNew
      ? Boolean(activePreset?.apiKeyOptional)
      : (name === 'ollama' || name === 'bedrock')
  );

  function onPresetChange(event: Event): void {
    const target = event.currentTarget as HTMLSelectElement;
    selectedPresetId = target.value;
    const preset = PROVIDER_PRESETS.find((p) => p.id === selectedPresetId);
    if (!preset) return;
    if (preset.id === 'custom') {
      name = '';
      type = 'openai';
      api = 'chat';
      baseUrl = '';
      apiKey = '';
      models = [{ name: '', context_window: 128000 }];
    } else {
      name = preset.name;
      type = preset.type;
      api = preset.api || 'chat';
      baseUrl = preset.baseUrl || '';
      apiKey = '';
      models = preset.defaultModels.map((m) => ({ ...m }));
    }
    testModel = models[0]?.name ?? '';
    testStatus = 'idle';
    testFeedback = '';
    fetchError = null;
  }


  let filteredRemoteModels = $derived.by(() => {
    const q = modelSearchQuery.trim().toLowerCase();
    if (q === '') return remoteModels;
    return remoteModels.filter((m) => m.toLowerCase().includes(q));
  });

  let selectedCount = $derived(
    Object.entries(selectedRemoteModels).filter(([_, checked]) => checked).length
  );

  function selectAllFiltered(): void {
    const next = { ...selectedRemoteModels };
    for (const m of filteredRemoteModels) {
      next[m] = true;
    }
    selectedRemoteModels = next;
  }

  function deselectAllFiltered(): void {
    const next = { ...selectedRemoteModels };
    for (const m of filteredRemoteModels) {
      next[m] = false;
    }
    selectedRemoteModels = next;
  }

  async function handleFetchRemoteModels(): Promise<void> {
    if (baseUrl.trim() === '') return;
    fetchingModels = true;
    fetchError = null;
    formError = null;

    try {
      const list = await fetchProviderModelsFromUi({
        provider: name.trim() || undefined,
        type: type.trim(),
        api: type === 'openai' ? api.trim() : undefined,
        base_url: baseUrl.trim(),
        api_key_action: isNew ? 'replace' : apiKeyAction,
        api_key: apiKey.trim() || undefined,
      });
      if (list.length === 0) {
        fetchError = 'Endpoint returned an empty model list';
        return;
      }
      remoteModels = list;
      modelSearchQuery = '';
      const existing = existingModelNames;
      const initial: Record<string, boolean> = {};
      for (const m of list) {
        initial[m] = !existing.has(m);
      }
      selectedRemoteModels = initial;
      showModelPicker = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      fetchError = `Failed to fetch models: ${msg}`;
    } finally {
      fetchingModels = false;
    }
  }

  function confirmAddSelectedModels(): void {
    const toAdd = Object.entries(selectedRemoteModels)
      .filter(([_, checked]) => checked)
      .map(([m]) => m);

    if (toAdd.length === 0) {
      showModelPicker = false;
      return;
    }

    const cleanModels = models.filter((m) => m.name.trim() !== '');
    const existingSet = new Set(cleanModels.map((m) => m.name));

    for (const m of toAdd) {
      if (!existingSet.has(m)) {
        cleanModels.push({ name: m, context_window: 128000 });
        existingSet.add(m);
      }
    }

    models = cleanModels.length > 0 ? cleanModels : [{ name: '', context_window: 128000 }];
    showModelPicker = false;
  }

  async function handleTest(): Promise<void> {
    if (!canTest) return;
    testStatus = 'testing';
    testFeedback = '';
    formError = null;

    const payload = {
      provider: name.trim(),
      type: type.trim(),
      api: type === 'openai' ? api.trim() : undefined,
      base_url: baseUrl.trim() || undefined,
      api_key_action: isNew ? 'replace' : apiKeyAction,
      api_key: apiKey.trim() || undefined,
      models: validModels.map((m) => ({
        name: m.name.trim(),
        context_window: m.context_window && m.context_window > 0 ? Number(m.context_window) : undefined,
      })),
      test_model: testModel.trim(),
    };

    const res = await testProviderFromUi(payload);
    if (res.ok) {
      testStatus = 'success';
      testFeedback = `Connected (${res.latencyMs ?? 0}ms)`;
    } else {
      testStatus = 'error';
      testFeedback = res.error || 'Connection probe failed';
    }
  }

  async function handleSave(): Promise<void> {
    if (!canSave) return;
    saving = true;
    formError = null;

    const payload = {
      provider: name.trim(),
      type: type.trim(),
      api: type === 'openai' ? api.trim() : undefined,
      base_url: baseUrl.trim() || undefined,
      api_key_action: isNew ? 'replace' : apiKeyAction,
      api_key: apiKey.trim() || undefined,
      models: validModels.map((m) => ({
        name: m.name.trim(),
        context_window: m.context_window && m.context_window > 0 ? Number(m.context_window) : undefined,
      })),
    };

    const ok = await saveProviderFromUi(payload);
    saving = false;
    if (ok) {
      onsaved?.(name.trim());
      onclose?.();
    } else {
      formError = 'Failed to save provider configuration. Check console or daemon logs.';
    }
  }
</script>

{#if open}
  <div class="modal-overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onclose?.(); }}>
    <div
      class="modal-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      data-testid="provider-editor-modal"
    >
      <header class="modal-header">
        <h3 id="modal-title" data-testid="provider-modal-title">
          {isNew ? 'Add provider' : `Edit provider: ${name}`}
        </h3>
        <button type="button" class="icon-btn" onclick={onclose} aria-label="Close dialog">✕</button>
      </header>

      <div class="modal-body">
        {#if formError}
          <div class="error-box" data-testid="provider-modal-error">
            <p>{formError}</p>
          </div>
        {/if}

        {#if isNew}
          <div class="form-row preset-row">
            <label>
              Provider Preset
              <select
                value={selectedPresetId}
                onchange={onPresetChange}
                data-testid="provider-preset-select"
              >
                {#each PROVIDER_PRESETS as preset (preset.id)}
                  <option value={preset.id}>{preset.label}</option>
                {/each}
              </select>
            </label>
          </div>
        {/if}

        <div class="form-row">
          <label>
            Provider ID / Name
            <input
              type="text"
              bind:value={name}
              disabled={!isNew}
              placeholder="e.g. deepseek, ollama-local"
              data-testid="provider-name-input"
            />
          </label>
          <label>
            Protocol Type
            <select bind:value={type} data-testid="provider-type-select">
              <option value="openai">OpenAI Compatible</option>
              <option value="anthropic">Anthropic</option>
              <option value="gemini">Google Gemini</option>
            </select>
          </label>
        </div>

        {#if type === 'openai'}
          <div class="form-row">
            <label>
              API Endpoint Style
              <select bind:value={api} data-testid="provider-api-select">
                <option value="chat">Chat (/chat/completions)</option>
                <option value="responses">Responses (/responses)</option>
              </select>
            </label>
          </div>
        {/if}

        <label>
          Base URL
          <input
            type="text"
            bind:value={baseUrl}
            placeholder={type === 'openai' ? 'http://localhost:11434/v1 or https://api.deepseek.com/v1' : 'Leave empty for official endpoint'}
            data-testid="provider-baseurl-input"
          />
        </label>

        <div class="credentials-group">
          <span class="group-label">API Key</span>
          {#if !isNew}
            <div class="key-actions">
              <label class="radio-label">
                <input type="radio" name="apiKeyAction" value="keep" bind:group={apiKeyAction} data-testid="provider-keyaction-keep" />
                Keep existing key ({provider?.api_key_hint || 'none'})
              </label>
              <label class="radio-label">
                <input type="radio" name="apiKeyAction" value="replace" bind:group={apiKeyAction} data-testid="provider-keyaction-replace" />
                Replace key
              </label>
              <label class="radio-label">
                <input type="radio" name="apiKeyAction" value="clear" bind:group={apiKeyAction} data-testid="provider-keyaction-clear" />
                Clear key
              </label>
            </div>
          {/if}

          {#if isNew || apiKeyAction === 'replace'}
            <input
              type="password"
              bind:value={apiKey}
              placeholder={isApiKeyOptional ? 'Optional (leave blank if unauthenticated or local)' : 'sk-...'}
              autocomplete="new-password"
              data-testid="provider-apikey-input"
            />
          {/if}
          <p class="meta">Credentials remain engine-side; only a masked hint will ever be stored in memory.</p>
        </div>

        <div class="models-group">
          <div class="group-header">
            <span class="group-label">Models</span>
            <div class="model-header-actions">
              <button
                type="button"
                class="small secondary"
                disabled={baseUrl.trim() === '' || fetchingModels}
                onclick={handleFetchRemoteModels}
                data-testid="model-fetch-button"
                title={baseUrl.trim() === '' ? 'Enter Base URL to fetch models from endpoint' : 'Query endpoint for available models'}
              >
                {fetchingModels ? 'Fetching…' : 'Fetch models'}
              </button>
              <button type="button" class="small" onclick={addModel} data-testid="model-add-button">+ Add model</button>
            </div>
          </div>
          {#if fetchError}
            <div class="fetch-error" data-testid="model-fetch-error">
              {fetchError}
            </div>
          {/if}

          <div class="models-list">
            {#each models as model, index (index)}
              <div class="model-row">
                <input
                  type="text"
                  bind:value={model.name}
                  placeholder="Model name (e.g. gpt-4o, deepseek-chat)"
                  data-testid="model-name-input"
                />
                <input
                  type="number"
                  bind:value={model.context_window}
                  placeholder="Tokens (e.g. 128000)"
                  min="0"
                  step="1000"
                  data-testid="model-context-input"
                />
                <button
                  type="button"
                  class="small danger"
                  onclick={() => removeModel(index)}
                  disabled={models.length <= 1 && model.name === ''}
                  data-testid="model-remove-button"
                  aria-label="Remove model"
                >✕</button>
              </div>
            {/each}
          </div>
        </div>

        <div class="test-group">
          <div class="test-controls">
            <label>
              Test model:
              <select bind:value={testModel} disabled={validModels.length === 0 || testStatus === 'testing'}>
                {#each validModels as m (m.name)}
                  <option value={m.name}>{m.name}</option>
                {/each}
              </select>
            </label>
            <button
              type="button"
              onclick={handleTest}
              disabled={!canTest}
              data-testid="provider-test-button"
            >
              {testStatus === 'testing' ? 'Testing…' : 'Test connection'}
            </button>
          </div>
          {#if testStatus !== 'idle'}
            <div class="test-status-box" class:ok={testStatus === 'success'} class:err={testStatus === 'error'} data-testid="provider-test-status">
              {testFeedback}
            </div>
          {/if}
        </div>
      </div>

      <footer class="modal-footer">
        <button type="button" onclick={onclose} disabled={saving} data-testid="provider-cancel-button">
          Cancel
        </button>
        <button
          type="button"
          class="primary"
          onclick={handleSave}
          disabled={!canSave}
          data-testid="provider-save-button"
        >
          {saving ? 'Saving…' : 'Save provider'}
        </button>
      </footer>
    </div>

    {#if showModelPicker}
      <div class="picker-overlay" role="dialog" aria-modal="true" aria-label="Select remote models">
        <div class="picker-card" data-testid="model-picker-modal">
          <div class="picker-header">
            <h4>Select models to add</h4>
            <button type="button" class="icon-btn" onclick={() => { showModelPicker = false; }} aria-label="Close picker">✕</button>
          </div>

          <div class="picker-search">
            <input
              type="text"
              placeholder="Filter models…"
              bind:value={modelSearchQuery}
              data-testid="model-picker-search"
            />
            <div class="picker-quick-actions">
              <button type="button" class="text" onclick={selectAllFiltered}>Select all</button>
              <button type="button" class="text" onclick={deselectAllFiltered}>Deselect all</button>
            </div>
          </div>

          <div class="picker-list" data-testid="model-picker-list">
            {#each filteredRemoteModels as m (m)}
              <label class="picker-item">
                <input
                  type="checkbox"
                  checked={selectedRemoteModels[m] ?? false}
                  onchange={(e) => {
                    selectedRemoteModels[m] = (e.currentTarget as HTMLInputElement).checked;
                  }}
                  data-testid="model-picker-item-{m}"
                />
                <span class="model-id mono">{m}</span>
                {#if existingModelNames.has(m)}
                  <span class="badge">Added</span>
                {/if}
              </label>
            {/each}
            {#if filteredRemoteModels.length === 0}
              <p class="meta empty-search">No models match "{modelSearchQuery}"</p>
            {/if}
          </div>

          <div class="picker-footer">
            <span class="meta">{selectedCount} model(s) selected</span>
            <div class="footer-buttons">
              <button type="button" onclick={() => { showModelPicker = false; }}>Cancel</button>
              <button
                type="button"
                class="primary"
                disabled={selectedCount === 0}
                onclick={confirmAddSelectedModels}
                data-testid="model-picker-confirm"
              >
                Add selected ({selectedCount})
              </button>
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(3px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 999;
    padding: 1rem;
  }
  .modal-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 32rem;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: var(--shadow-lg);
  }
  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.25rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .modal-header h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--text);
  }
  .icon-btn {
    background: transparent;
    border: none;
    color: var(--text-dim);
    font-size: 1.1rem;
    padding: 0.2rem 0.5rem;
    cursor: pointer;
  }
  .icon-btn:hover {
    color: var(--text);
  }
  .modal-body {
    padding: 1.25rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.65rem;
    padding: 0.85rem 1.25rem;
    border-top: 1px solid var(--border-subtle);
    background: var(--surface-0);
    border-radius: 0 0 var(--radius-lg) var(--radius-lg);
  }
  .form-row {
    display: flex;
    gap: 0.75rem;
  }
  .form-row label {
    flex: 1;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.8rem;
    color: var(--text-dim);
    font-weight: 500;
  }
  input[type="text"],
  input[type="password"],
  input[type="number"],
  select {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 0.45rem 0.65rem;
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    width: 100%;
  }
  input:focus,
  select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .credentials-group,
  .models-group,
  .test-group {
    background: var(--surface-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .group-label {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .group-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .key-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
  }
  .radio-label {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.35rem;
    cursor: pointer;
  }
  .models-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .model-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .model-row input[type="text"] {
    flex: 2;
  }
  .model-row input[type="number"] {
    flex: 1;
  }
  .test-controls {
    display: flex;
    gap: 0.75rem;
    align-items: flex-end;
  }
  .test-controls label {
    flex: 1;
  }
  .test-status-box {
    font-size: 0.8rem;
    padding: 0.4rem 0.65rem;
    border-radius: var(--radius-xs);
    background: var(--surface-3);
    color: var(--text-dim);
  }
  .test-status-box.ok {
    background: var(--ok-subtle);
    color: var(--ok);
    border: 1px solid var(--ok);
  }
  .test-status-box.err {
    background: var(--danger-subtle);
    color: var(--danger);
    border: 1px solid var(--danger);
  }
  .error-box {
    background: var(--danger-subtle);
    color: var(--danger);
    border: 1px solid var(--danger);
    padding: 0.5rem 0.75rem;
    border-radius: var(--radius-sm);
    font-size: 0.82rem;
  }
  .error-box p {
    margin: 0;
  }
  .meta {
    margin: 0;
    font-size: 0.75rem;
    color: var(--text-faint);
  }
  button.small {
    font-size: 0.75rem;
    padding: 0.2rem 0.55rem;
    border-radius: var(--radius-sm);
  }
  button.danger {
    background: var(--danger-subtle);
    color: var(--danger);
    border: 1px solid var(--danger);
  }
  button.primary {
    background: var(--accent);
    color: #fff;
    border: 1px solid var(--accent);
  }
  button.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .model-header-actions {
    display: flex;
    gap: 0.45rem;
    align-items: center;
  }
  button.secondary {
    background: var(--surface-3);
    color: var(--text);
    border: 1px solid var(--border);
  }
  button.secondary:hover:not(:disabled) {
    background: var(--surface-2);
  }
  button.text {
    background: transparent;
    border: none;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
    padding: 0;
  }
  button.text:hover {
    color: var(--accent-hover);
  }
  .fetch-error {
    font-size: 0.78rem;
    color: var(--danger);
    background: var(--danger-subtle);
    border: 1px solid var(--danger);
    padding: 0.35rem 0.6rem;
    border-radius: var(--radius-xs);
  }
  .picker-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(2px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1001;
    padding: 1rem;
  }
  .picker-card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 26rem;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: var(--shadow-lg);
  }
  .picker-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.85rem 1rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .picker-header h4 {
    margin: 0;
    font-size: 0.95rem;
    color: var(--text);
  }
  .picker-search {
    padding: 0.75rem 1rem 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .picker-quick-actions {
    display: flex;
    gap: 0.75rem;
    font-size: 0.75rem;
  }
  .picker-list {
    padding: 0.5rem 0.75rem;
    overflow-y: auto;
    max-height: 280px;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .picker-item {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.5rem;
    border-radius: var(--radius-xs);
    cursor: pointer;
    user-select: none;
    transition: background 0.15s ease;
  }
  .picker-item:hover {
    background: var(--surface-2);
  }
  .picker-item input[type="checkbox"] {
    cursor: pointer;
    accent-color: var(--accent);
  }
  .model-id {
    flex: 1;
    font-size: 0.82rem;
    color: var(--text);
    word-break: break-all;
  }
  .badge {
    font-size: 0.7rem;
    color: var(--text-faint);
    background: var(--surface-3);
    padding: 0.15rem 0.4rem;
    border-radius: var(--radius-xs);
  }
  .picker-footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem 1rem;
    border-top: 1px solid var(--border-subtle);
    background: var(--surface-0);
    border-radius: 0 0 var(--radius-lg) var(--radius-lg);
  }
  .footer-buttons {
    display: flex;
    gap: 0.5rem;
  }
  .empty-search {
    padding: 1rem;
    text-align: center;
  }
</style>
