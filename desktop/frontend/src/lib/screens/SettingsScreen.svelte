<script lang="ts">
  /**
   * Settings screen (task 8): provider/model selection, role thinking level,
   * UI + story language — each an EXPLICIT single protocol request — plus the
   * read-only configuration facts (budget, style, config path, projects
   * directory) and local notification preferences.
   *
   * Secrets never appear: the engine's config views are redacted server-side
   * (README §8) and only the masked `api_key_hint` ever arrives; the screen
   * renders exactly what arrived and never sends anything secret back. The
   * engine has no setters for budget/style/update-channel, so those are
   * displayed read-only rather than faked as controls.
   */
  import { onMount } from 'svelte';

  import { getPaths, type ProviderSummary } from '$lib/api/desktop';
  import ProviderEditorModal from '$lib/components/ProviderEditorModal.svelte';
  import CustomSelect, { type OptionItem } from '$lib/components/CustomSelect.svelte';
  import { currentLanguage, t } from '$lib/locale';
  import {
    deleteProviderFromUi,
    dismissSettingsMessage,
    LANGUAGE_CHOICES,
    loadModelOptions,
    refreshConfig,
    refreshThinkingLevels,
    setLanguageFromUi,
    setStoryLanguageFromUi,
    setThinkingFromUi,
    settingsState,
    switchModelFromUi,
  } from '$lib/settings';
  import { notificationPrefs, projectSnapshot, setNotificationPref } from '$lib/stores/desktop';
  import { presentError } from '$lib/types/protocol';

  let { title, description, owner }: { title: string; description: string; owner: string } = $props();

  let settings = $derived($settingsState);
  let snapshot = $derived($projectSnapshot);
  let view = $derived(settings.view);
  let prefs = $derived($notificationPrefs);

  let configError = $derived(settings.error ? presentError(settings.error.code) : null);
  // Chrome strings resolve through the tiny en/vi/zh catalog; passing the
  // store value explicitly keeps each lookup reactive to locale switches.
  let lang = $derived($currentLanguage);

  // Selection state for the switch-model flow (explicit Apply, one request).
  let selectedProvider = $state('');
  let selectedModel = $state('');
  let selectedThinking = $state('');
  let selectedLanguage = $state('');
  let selectedStoryLanguage = $state('');
  let projectsDir = $state<string | null>(null);
  let showProviderModal = $state(false);
  let editingProvider = $state<ProviderSummary | null>(null);

  const LANGUAGE_LABELS: Record<string, string> = {
    en: 'English (en)',
    vi: 'Tiếng Việt (vi)',
    zh: '中文 (zh)',
  };

  // Adopt the engine-reported current values as the initial selections
  // whenever a fresh config view arrives and the user has not chosen yet.
  $effect(() => {
    const current = $settingsState.view;
    if (current === null) return;
    if (selectedProvider === '') selectedProvider = current.provider ?? '';
    if (selectedModel === '') selectedModel = current.model ?? '';
    if (selectedThinking === '') selectedThinking = current.reasoning_effort ?? '';
    if (selectedLanguage === '') selectedLanguage = current.language ?? '';
    if (selectedStoryLanguage === '') selectedStoryLanguage = current.story_language ?? '';
  });

  onMount(() => {
    if (snapshot !== null) {
      void refreshConfig();
      void refreshThinkingLevels();
    }
    // Shell fact for the read-only directories row; optional decoration.
    getPaths()
      .then((paths) => (projectsDir = paths.projectsDir))
      .catch(() => undefined);
  });

  function refresh(): void {
    void refreshConfig();
    void refreshThinkingLevels();
  }

  let providers = $derived(view?.providers ?? []);
  let providerNames = $derived(providers.map((p) => p.name ?? '').filter((n) => n !== ''));
  let activeProviderSummary = $derived(
    providers.find((p) => p.name === selectedProvider) ??
      providers.find((p) => p.name === view?.provider),
  );

  /** Model names for the selected provider: config.models when loaded, else
   *  the redacted provider summary's model list. */
  let modelNames = $derived.by(() => {
    if (settings.modelOptions.status === 'ready' && settings.modelOptions.provider === selectedProvider) {
      const names = settings.modelOptions.options.map((m) => m.name ?? '').filter((n) => n !== '');
      if (names.length > 0) return names;
    }
    return activeProviderSummary?.models ?? [];
  });

  let modelChoiceValid = $derived(selectedProvider !== '' && selectedModel !== '');

  // Keep the model selection coherent with the visible options (provider
  // switches reset it; the engine's current model is adopted when listed).
  $effect(() => {
    if (modelNames.length === 0) return;
    if (!modelNames.includes(selectedModel)) selectedModel = modelNames[0] ?? '';
  });
  let languageChoices = $derived.by(() => {
    const choices = [...LANGUAGE_CHOICES];
    for (const current of [view?.language, view?.story_language]) {
      if (current && !choices.includes(current as (typeof LANGUAGE_CHOICES)[number])) {
        choices.push(current as (typeof LANGUAGE_CHOICES)[number]);
      }
    }
    return choices;
  });

  let providerOptions = $derived<OptionItem[]>(
    providers.map((p) => ({
      value: p.name ?? '',
      label: p.name ?? '',
      badge: p.type ?? undefined,
      description: p.requires_api_key
        ? p.has_api_key
          ? 'API key configured'
          : 'Missing API key'
        : 'Local / no key needed',
    })),
  );

  let modelOptionsList = $derived.by<OptionItem[]>(() => {
    if (settings.modelOptions.status === 'ready' && settings.modelOptions.provider === selectedProvider) {
      const list = settings.modelOptions.options
        .filter((m) => !!m.name)
        .map((m) => ({
          value: m.name ?? '',
          label: m.name ?? '',
          badge: m.context_window ? `${Math.round(m.context_window / 1000)}k` : undefined,
          description: m.context_source ? `Source: ${m.context_source}` : undefined,
        }));
      if (list.length > 0) return list;
    }
    return (activeProviderSummary?.models ?? []).map((name) => ({
      value: name,
      label: name,
    }));
  });

  let thinkingOptions = $derived<OptionItem[]>(
    settings.thinking.levels.map((lvl) => ({
      value: lvl,
      label: lvl.charAt(0).toUpperCase() + lvl.slice(1),
    })),
  );

  let languageOptions = $derived<OptionItem[]>(
    languageChoices.map((code) => ({
      value: code,
      label: LANGUAGE_LABELS[code] ?? code,
      badge: code.toUpperCase(),
    })),
  );

  function changeProvider(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement;
    selectedProvider = select.value;
    selectedModel = '';
    if (selectedProvider !== '') void loadModelOptions(selectedProvider);
  }

  function changeModel(event: Event): void {
    selectedModel = (event.currentTarget as HTMLSelectElement).value;
  }

  function changeThinking(event: Event): void {
    selectedThinking = (event.currentTarget as HTMLSelectElement).value;
  }

  function changeLanguage(event: Event): void {
    selectedLanguage = (event.currentTarget as HTMLSelectElement).value;
  }

  function changeStoryLanguage(event: Event): void {
    selectedStoryLanguage = (event.currentTarget as HTMLSelectElement).value;
  }

  function togglePref(category: keyof typeof prefs, event: Event): void {
    setNotificationPref(category, (event.currentTarget as HTMLInputElement).checked);
  }

  function money(value: number | undefined): string {
    return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : '-';
  }

  function openAddProvider(): void {
    editingProvider = null;
    showProviderModal = true;
  }

  function openEditProvider(): void {
    editingProvider = activeProviderSummary ?? null;
    showProviderModal = true;
  }

  async function handleDeleteProvider(): Promise<void> {
    if (!selectedProvider || selectedProvider === view?.provider) return;
    const toDelete = selectedProvider;
    const ok = await deleteProviderFromUi(toDelete);
    if (ok) {
      selectedProvider = view?.provider ?? '';
      if (selectedProvider !== '') void loadModelOptions(selectedProvider);
    }
  }
</script>

<section class="settings-screen screen" data-testid="settings-screen">
  <header class="settings-header">
    <div>
      <h2>{title}</h2>
      <p class="screen-description">{description} <span class="owner">({owner})</span></p>
    </div>
    {#if snapshot !== null}
      <button
        type="button"
        class="refresh-button"
        onclick={() => refresh()}
        disabled={settings.status === 'loading'}
        data-testid="settings-refresh"
      >
        {settings.status === 'loading' ? 'Refreshing…' : 'Refresh'}
      </button>
    {/if}
  </header>

  {#if snapshot === null}
    <div class="empty-state" data-testid="settings-empty">
      <h3>{t('common.noProject.title', lang)}</h3>
      <p>{t('settings.empty.hint', lang)}</p>
    </div>
  {:else}
    {#if settings.message}
      <div class="applied" role="status" data-testid="settings-applied">
        <span>{settings.message}</span>
        <button
          type="button"
          class="dismiss-message"
          onclick={() => dismissSettingsMessage()}
          data-testid="settings-dismiss-applied"
          aria-label="Dismiss confirmation"
        >
          Dismiss
        </button>
      </div>
    {/if}

    {#if settings.error}
      <div class="error-box" role="alert" data-testid="settings-error">
        <p>{configError?.title}: {settings.error.message} <span class="code">[{settings.error.code}]</span></p>
        <p class="meta">{configError?.action ?? ''}</p>
      </div>
    {/if}

    <section class="active-summary" data-testid="settings-active-summary" aria-label="Active AI configuration">
      <div class="active-summary-heading">
        <span class="section-label">Writing engine</span>
        <h3>{view?.model || 'Choose a model'}</h3>
        <p>
          {view?.provider
            ? `${view.provider} is ready for planning, drafting, and revision.`
            : 'Add a provider to start writing with AI.'}
        </p>
      </div>
      <dl class="active-summary-data">
        <div>
          <dt>Provider</dt>
          <dd class="mono">{view?.provider || 'Not configured'}</dd>
        </div>
        <div>
          <dt>Thinking</dt>
          <dd>{view?.reasoning_effort || 'Default'}</dd>
        </div>
        <div>
          <dt>Story language</dt>
          <dd>{LANGUAGE_LABELS[view?.story_language ?? ''] ?? view?.story_language ?? 'Default'}</dd>
        </div>
      </dl>
    </section>

    <div class="settings-grid">
      <article class="card model-card" data-testid="settings-model">
        <header class="card-header">
          <div class="card-title-group">
            <div class="card-icon-badge" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
              </svg>
            </div>
            <div>
              <div class="card-title-row">
                <h3>AI model</h3>
                {#if selectedProvider === view?.provider && selectedModel === view?.model}
                  <span class="status-pill active" title="Currently active in writing engine">
                    <span class="status-dot"></span> Active
                  </span>
                {:else if modelChoiceValid}
                  <span class="status-pill pending" title="Changes not applied yet">
                    <span class="status-dot"></span> Pending switch
                  </span>
                {/if}
              </div>
              <p class="meta">Choose the provider and model used across your writing workflow.</p>
            </div>
          </div>
        </header>

        {#if providerNames.length === 0}
          <div class="empty-provider-notice" data-testid="settings-no-providers">
            No providers configured yet. Click "+ Add provider" below to get started.
          </div>
        {/if}

        <div class="field-grid">
          <div class="model-field">
            <div class="field-top-row">
              <span class="field-label-text">Provider</span>
              <div class="provider-actions">
                <button
                  type="button"
                  class="action-pill primary-ghost"
                  onclick={openAddProvider}
                  data-testid="settings-provider-add"
                  title="Add new provider"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                    <line x1="12" y1="5" x2="12" y2="19"></line>
                    <line x1="5" y1="12" x2="19" y2="12"></line>
                  </svg>
                  <span>Add</span>
                </button>
                <button
                  type="button"
                  class="action-pill ghost"
                  disabled={!selectedProvider}
                  onclick={openEditProvider}
                  data-testid="settings-provider-edit"
                  title="Edit provider settings"
                >
                  Edit
                </button>
                <button
                  type="button"
                  class="action-pill danger"
                  disabled={!selectedProvider || selectedProvider === view?.provider || settings.mutations.provider !== 'idle'}
                  title={selectedProvider === view?.provider ? 'Active default provider cannot be deleted' : undefined}
                  onclick={handleDeleteProvider}
                  data-testid="settings-provider-delete"
                >
                  Delete
                </button>
              </div>
            </div>

            <CustomSelect
              value={selectedProvider}
              options={providerOptions}
              placeholder={providerNames.length === 0 ? 'No providers configured' : 'Select provider…'}
              dataTestId="settings-provider-select"
              onchange={changeProvider}
            />

            <div class="field-footer-info">
              {#if activeProviderSummary}
                <span class="provider-type-tag">{activeProviderSummary.type || 'standard'}</span>
                {#if activeProviderSummary.requires_api_key}
                  <span class="provider-auth-tag" class:authed={activeProviderSummary.has_api_key}>
                    {activeProviderSummary.has_api_key ? '● Key configured' : '○ Missing key'}
                  </span>
                {/if}
              {:else}
                <span class="control-note">Choose a provider to configure models</span>
              {/if}
            </div>
          </div>

          <div class="model-field">
            <div class="field-top-row">
              <span class="field-label-text">Model</span>
              <span class="model-count-tag" class:loading={settings.modelOptions.status === 'loading'}>
                {settings.modelOptions.status === 'loading'
                  ? 'Loading models…'
                  : `${modelNames.length} ${modelNames.length === 1 ? 'model' : 'models'} available`}
              </span>
            </div>

            <CustomSelect
              value={selectedModel}
              options={modelOptionsList}
              placeholder="Select model…"
              dataTestId="settings-model-select"
              mono={true}
              searchable={true}
              searchPlaceholder="Filter models…"
              onchange={changeModel}
            />

            <div class="field-footer-info">
              {#if selectedModel}
                <span class="target-model-preview">
                  Target: <strong class="mono">{selectedModel}</strong>
                </span>
              {:else}
                <span class="control-note">No model selected</span>
              {/if}
            </div>
          </div>
        </div>

        <div class="apply-row">
          <div class="selection-preview" data-testid="settings-model-selection">
            <span class="selection-preview-label">Selected setup</span>
            <div class="selection-preview-val">
              <strong class="mono">{selectedProvider || 'No provider'} / {selectedModel || 'No model'}</strong>
              {#if selectedProvider === view?.provider && selectedModel === view?.model}
                <span class="status-tag active">Active in engine</span>
              {:else if modelChoiceValid}
                <span class="status-tag pending">Pending apply</span>
              {/if}
            </div>
          </div>
          <button
            type="button"
            class="primary apply-model-btn"
            onclick={() => switchModelFromUi(selectedProvider, selectedModel)}
            disabled={!modelChoiceValid || settings.mutations.model !== 'idle'}
            data-testid="settings-model-apply"
          >
            {#if settings.mutations.model === 'applying'}
              <span class="spinner-inline" aria-hidden="true"></span>
              <span>Switching…</span>
            {:else}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              <span>Use this model</span>
            {/if}
          </button>
        </div>
      </article>

      <article class="card" data-testid="settings-thinking">
        <header class="card-header">
          <div>
            <h3>Thinking level</h3>
            <p class="meta">Control how much reasoning the current model uses before it writes.</p>
          </div>
        </header>
        {#if settings.thinking.error}
          <div class="error-box" role="alert">
            <p>{presentError(settings.thinking.error.code).title}: {settings.thinking.error.message}</p>
          </div>
        {:else}
          <div class="preference-stack">
            <div class="preference-control">
              <label>
                Level
                <CustomSelect
                  value={selectedThinking}
                  options={thinkingOptions}
                  dataTestId="settings-thinking-select"
                  onchange={changeThinking}
                />
              </label>
              <button
                type="button"
                class="primary"
                onclick={() => setThinkingFromUi(selectedThinking)}
                disabled={selectedThinking === '' || settings.mutations.thinking !== 'idle'}
                data-testid="settings-thinking-apply"
              >
                {settings.mutations.thinking === 'applying' ? 'Applying…' : 'Apply'}
              </button>
            </div>
            <p class="control-note">Current: <strong>{view?.reasoning_effort ?? 'Default'}</strong></p>
          </div>
        {/if}
      </article>

      <article class="card" data-testid="settings-languages">
        <header class="card-header">
          <div>
            <h3>{t('settings.languages.title', lang)}</h3>
            <p class="meta">Set the language used by the app and the language used in generated prose.</p>
          </div>
        </header>
        <div class="language-control">
          <div class="preference-control">
            <label>
              {t('settings.languages.interfaceLabel', lang)}
              <CustomSelect
                value={selectedLanguage}
                options={languageOptions}
                dataTestId="settings-language-select"
                onchange={changeLanguage}
              />
            </label>
            <button
              type="button"
              class="primary"
              onclick={() => setLanguageFromUi(selectedLanguage)}
              disabled={selectedLanguage === '' || settings.mutations.language !== 'idle'}
              data-testid="settings-language-apply"
            >
              {settings.mutations.language === 'applying' ? t('settings.languages.applying', lang) : t('settings.languages.setInterface', lang)}
            </button>
          </div>
          <p class="control-note">
            {t('settings.languages.current', lang)}:
            <strong>{LANGUAGE_LABELS[view?.language ?? ''] ?? view?.language ?? t('settings.languages.default', lang)}</strong>
          </p>
        </div>
        <div class="language-control">
          <div class="preference-control">
            <label>
              {t('settings.languages.storyLabel', lang)}
              <CustomSelect
                value={selectedStoryLanguage}
                options={languageOptions}
                dataTestId="settings-story-language-select"
                onchange={changeStoryLanguage}
              />
            </label>
            <button
              type="button"
              class="primary"
              onclick={() => setStoryLanguageFromUi(selectedStoryLanguage)}
              disabled={selectedStoryLanguage === '' || settings.mutations.storyLanguage !== 'idle'}
              data-testid="settings-story-language-apply"
            >
              {settings.mutations.storyLanguage === 'applying' ? t('settings.languages.applying', lang) : t('settings.languages.setStory', lang)}
            </button>
          </div>
          <p class="control-note">
            {t('settings.languages.current', lang)}:
            <strong>{LANGUAGE_LABELS[view?.story_language ?? ''] ?? view?.story_language ?? t('settings.languages.default', lang)}</strong>
          </p>
        </div>
        <p class="meta card-footer-note">{t('settings.languages.hint', lang)}</p>
      </article>

      <article class="card" data-testid="settings-notifications">
        <header class="card-header">
          <div>
            <h3>Notifications</h3>
            <p class="meta">Choose which run events should interrupt your writing session.</p>
          </div>
        </header>
        <label class="check">
          <input
            type="checkbox"
            checked={prefs.completion}
            onchange={(event) => togglePref('completion', event)}
            data-testid="settings-pref-completion"
          />
          <span><strong>Completion</strong><small>When a run finishes</small></span>
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={prefs.pause}
            onchange={(event) => togglePref('pause', event)}
            data-testid="settings-pref-pause"
          />
          <span><strong>Paused runs</strong><small>When input is needed</small></span>
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={prefs.warning}
            onchange={(event) => togglePref('warning', event)}
            data-testid="settings-pref-warning"
          />
          <span><strong>Warnings</strong><small>When the engine needs attention</small></span>
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={prefs.failure}
            onchange={(event) => togglePref('failure', event)}
            data-testid="settings-pref-failure"
          />
          <span><strong>Failures</strong><small>When a run cannot continue</small></span>
        </label>
        <p class="meta card-footer-note">Errors from your own actions always appear.</p>
      </article>

      <details class="engine-details" data-testid="settings-advanced">
        <summary>
          <span>
            <strong>Advanced</strong>
            <small>Credentials, file locations, and engine-managed values</small>
          </span>
          <span class="summary-hint">Details</span>
        </summary>
        <div class="advanced-content">
          {#if activeProviderSummary}
            <section class="advanced-group">
              <header>
                <h4>Connection details</h4>
                <p>Credentials stay inside the engine. The app receives only a masked key hint.</p>
              </header>
              <dl class="facts" data-testid="settings-provider-credentials">
                <div><dt>API key configured</dt><dd>{activeProviderSummary.has_api_key === true ? 'yes' : 'no'}</dd></div>
                {#if activeProviderSummary.api_key_hint}
                  <div><dt>Key hint</dt><dd class="mono" data-testid="settings-key-hint">{activeProviderSummary.api_key_hint}</dd></div>
                {/if}
                <div><dt>Key required</dt><dd>{activeProviderSummary.requires_api_key === true ? 'yes' : 'no'}</dd></div>
                {#if activeProviderSummary.base_url}
                  <div><dt>Base URL</dt><dd class="mono">{activeProviderSummary.base_url}</dd></div>
                {/if}
              </dl>
            </section>
          {/if}

          <section class="advanced-group" data-testid="settings-readonly">
            <header>
              <h4>Engine-managed details</h4>
              <p>Reference values controlled by the engine or selected per run.</p>
            </header>
            <dl class="facts">
              <div><dt>Budget limit</dt><dd data-testid="settings-budget">{money(view?.budget_usd)}</dd></div>
              {#if view?.style}<div><dt>Style</dt><dd>{view.style}</dd></div>{/if}
              {#if view?.config_path}<div><dt>Config file</dt><dd class="mono">{view.config_path}</dd></div>{/if}
              {#if projectsDir}<div><dt>Projects directory</dt><dd class="mono">{projectsDir}</dd></div>{/if}
            </dl>
            <p class="meta">
              Budget and style have no public engine setters (config.update rejects them). Export and
              diagnostics destinations are chosen per run through native dialogs.
            </p>
            <p class="meta" data-testid="settings-update-channel">
              App updates are managed outside this app. The engine exposes no update setting.
            </p>
          </section>
        </div>
      </details>
    </div>
  {/if}
  <ProviderEditorModal
    open={showProviderModal}
    provider={editingProvider}
    onclose={() => { showProviderModal = false; }}
    onsaved={(newProviderName) => {
      selectedProvider = newProviderName;
      showProviderModal = false;
      void loadModelOptions(newProviderName);
    }}
  />
</section>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    gap: 1.4rem;
    width: min(100%, 64rem);
    margin: 0 auto;
    padding: 2.25rem 2.25rem 3.5rem;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    container-type: inline-size;
  }
  .settings-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
  }
  .settings-header h2 {
    margin: 0;
    font-size: 1.7rem;
    font-weight: 700;
    letter-spacing: -0.04em;
    line-height: 1.15;
  }
  .screen-description {
    margin: 0.35rem 0 0;
    color: var(--text-dim);
    font-size: 0.88rem;
    max-width: 38rem;
    text-wrap: pretty;
  }
  .refresh-button {
    flex: none;
    white-space: nowrap;
    color: var(--text-dim);
    background: transparent;
    border-color: var(--border-subtle);
  }
  .section-label {
    display: block;
    color: var(--accent);
    font-size: 0.69rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    line-height: 1.2;
    text-transform: uppercase;
  }
  .owner {
    font-style: italic;
    display: none;
  }
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 0.85rem;
    padding: 3.5rem 2rem;
    border: 1px dashed var(--border);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--surface-1) 80%, transparent);
  }
  .empty-state h3 {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 600;
    color: var(--text);
  }
  .empty-state p {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.88rem;
  }
  .applied {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    color: color-mix(in srgb, var(--ok) 72%, var(--text));
    font-size: 0.82rem;
    font-weight: 500;
    background: var(--ok-subtle);
    border: 1px solid color-mix(in srgb, var(--ok) 28%, transparent);
    border-radius: var(--radius-md);
    padding: 0.55rem 0.65rem 0.55rem 0.85rem;
  }
  .dismiss-message {
    padding: 0.15rem 0.35rem;
    color: inherit;
    background: transparent;
    border-color: transparent;
    font-size: 0.75rem;
  }
  .dismiss-message:hover:not(:disabled) {
    background: color-mix(in srgb, var(--ok) 14%, transparent);
    border-color: transparent;
  }
  .active-summary {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(24rem, 0.9fr);
    gap: 2rem;
    align-items: center;
    padding: 1.5rem 1.6rem 1.65rem;
    border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border));
    border-radius: var(--radius-lg);
    background:
      radial-gradient(circle at 0 0, color-mix(in srgb, var(--accent) 13%, transparent), transparent 42%),
      var(--surface-1);
    box-shadow: var(--shadow-sm), inset 0 1px 0 color-mix(in srgb, var(--text) 5%, transparent);
  }
  .active-summary-heading h3 {
    margin: 0.32rem 0 0;
    font-family: var(--font-serif);
    font-size: 1.35rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }
  .active-summary-heading p {
    max-width: 32rem;
    margin: 0.42rem 0 0;
    color: var(--text-dim);
    font-size: 0.84rem;
    text-wrap: pretty;
  }
  .active-summary-data {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
    margin: 0;
  }
  .active-summary-data div {
    min-width: 0;
    padding-left: 0.75rem;
    border-left: 1px solid color-mix(in srgb, var(--border-hover) 65%, transparent);
  }
  .active-summary-data dt {
    color: var(--text-faint);
    font-size: 0.68rem;
    font-weight: 600;
    letter-spacing: 0.03em;
  }
  .active-summary-data dd {
    margin: 0.16rem 0 0;
    overflow-wrap: anywhere;
    color: var(--text);
    font-size: 0.8rem;
    font-weight: 600;
  }
  .settings-grid {
    display: flex;
    flex-direction: column;
  }
  .card {
    display: grid;
    grid-template-columns: minmax(13rem, 0.72fr) minmax(0, 1.28fr);
    align-items: start;
    gap: 0.75rem 2rem;
    min-width: 0;
    padding: 1.45rem 0.25rem 1.6rem;
    border-top: 1px solid var(--border-subtle);
  }
  .card > .card-header {
    grid-column: 1;
  }
  .card > :not(.card-header) {
    grid-column: 2;
  }
  .model-card {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 1.1rem;
    margin-bottom: 0.35rem;
    padding: 1.6rem 1.65rem 1.6rem;
    background: linear-gradient(145deg, color-mix(in srgb, var(--surface-1) 94%, var(--accent) 6%) 0%, var(--surface-1) 100%);
    border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--border));
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  }
  .model-card > .card-header,
  .model-card > :not(.card-header) {
    grid-column: auto;
    grid-row: auto;
  }
  .card-title-group {
    display: flex;
    align-items: flex-start;
    gap: 0.9rem;
  }
  .card-icon-badge {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2.35rem;
    height: 2.35rem;
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--accent) 14%, var(--surface-2));
    border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent);
    color: var(--accent-hover);
    box-shadow: 0 0 14px var(--accent-subtle);
    flex: none;
    margin-top: 0.1rem;
  }
  .card-title-row {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    flex-wrap: wrap;
  }
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.16rem 0.55rem;
    border-radius: var(--radius-full);
    letter-spacing: 0.02em;
    user-select: none;
  }
  .status-pill.active {
    background: var(--ok-subtle);
    color: var(--ok);
    border: 1px solid color-mix(in srgb, var(--ok) 32%, transparent);
  }
  .status-pill.pending {
    background: var(--accent-subtle);
    color: var(--accent-hover);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .status-dot {
    width: 0.38rem;
    height: 0.38rem;
    border-radius: var(--radius-full);
    background: currentColor;
    box-shadow: 0 0 6px currentColor;
  }
  .card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .card-header h3 {
    margin: 0;
    color: var(--text);
    font-size: 1.05rem;
    font-weight: 650;
    letter-spacing: -0.02em;
  }
  .card-header .meta {
    margin-top: 0.38rem;
    max-width: 32rem;
    line-height: 1.45;
    text-wrap: pretty;
  }
  .empty-provider-notice {
    font-size: 0.8rem;
    color: var(--text-dim);
    background: var(--surface-2);
    border: 1px dashed var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.65rem;
    line-height: 1.4;
  }
  .field-grid {
    display: grid;
    grid-template-columns: minmax(13rem, 1fr) minmax(16rem, 1.25fr);
    gap: 1.15rem;
  }
  .model-field {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    min-width: 0;
    padding: 1.05rem;
    border: 1px solid color-mix(in srgb, var(--border) 80%, var(--accent) 20%);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--surface-2) 75%, transparent);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
  }
  .field-top-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    min-height: 1.65rem;
  }
  .field-label-text {
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--text-secondary);
    text-transform: uppercase;
  }
  .provider-actions {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .action-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.2rem 0.5rem;
    font-size: 0.72rem;
    font-weight: 550;
    border-radius: var(--radius-xs);
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    cursor: pointer;
    transition: all var(--transition-fast);
  }
  .action-pill:hover:not(:disabled) {
    background: var(--surface-3);
    border-color: var(--border-hover);
  }
  .action-pill.primary-ghost {
    border-color: color-mix(in srgb, var(--accent) 35%, transparent);
    background: color-mix(in srgb, var(--accent) 12%, var(--surface-2));
    color: var(--accent-hover);
  }
  .action-pill.primary-ghost:hover:not(:disabled) {
    background: color-mix(in srgb, var(--accent) 22%, var(--surface-2));
    border-color: var(--accent);
  }
  .action-pill.danger {
    border-color: color-mix(in srgb, var(--danger) 30%, transparent);
    background: color-mix(in srgb, var(--danger) 8%, var(--surface-2));
    color: var(--danger);
  }
  .action-pill.danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--danger) 18%, var(--surface-2));
    border-color: var(--danger);
  }
  .model-count-tag {
    font-size: 0.72rem;
    font-weight: 550;
    color: var(--text-dim);
    background: var(--surface-3);
    border: 1px solid var(--border-subtle);
    padding: 0.14rem 0.45rem;
    border-radius: var(--radius-xs);
  }
  .model-count-tag.loading {
    color: var(--accent-hover);
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  }
  .field-footer-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.73rem;
    min-height: 1.25rem;
    color: var(--text-dim);
  }
  .provider-type-tag {
    display: inline-flex;
    align-items: center;
    padding: 0.1rem 0.35rem;
    font-size: 0.67rem;
    font-weight: 600;
    text-transform: uppercase;
    background: var(--surface-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-xs);
    color: var(--text-faint);
  }
  .provider-auth-tag {
    font-size: 0.72rem;
    font-weight: 500;
    color: var(--text-faint);
  }
  .provider-auth-tag.authed {
    color: var(--ok);
  }
  .target-model-preview {
    font-size: 0.73rem;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .target-model-preview strong {
    color: var(--text);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.42rem;
    font-size: 0.78rem;
    color: var(--text-dim);
    font-weight: 600;
  }
  label.check {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    flex-direction: row;
    align-items: center;
    gap: 1rem;
    padding: 0.65rem 0;
    border-bottom: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: color var(--transition-fast);
  }
  label.check:last-of-type {
    border-bottom: 0;
  }
  label.check input {
    position: relative;
    grid-column: 2;
    grid-row: 1;
    width: 2.35rem;
    height: 1.3rem;
    margin: 0;
    appearance: none;
    border: 1px solid var(--border-hover);
    border-radius: var(--radius-full);
    background: var(--surface-3);
    cursor: pointer;
    transition: background var(--transition-fast), border-color var(--transition-fast);
  }
  label.check input::before {
    content: '';
    position: absolute;
    top: 0.16rem;
    left: 0.17rem;
    width: 0.82rem;
    height: 0.82rem;
    border-radius: var(--radius-full);
    background: var(--text-dim);
    box-shadow: var(--shadow-sm);
    transition: transform var(--transition-fast), background var(--transition-fast);
  }
  label.check input:checked {
    border-color: color-mix(in srgb, var(--accent) 72%, var(--border));
    background: color-mix(in srgb, var(--accent) 68%, var(--surface-3));
  }
  label.check input:checked::before {
    transform: translateX(1rem);
    background: #f7f9fc;
  }
  label.check input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  label.check strong,
  label.check small {
    display: block;
  }
  label.check strong {
    color: var(--text-secondary);
    font-size: 0.82rem;
    font-weight: 600;
  }
  label.check small {
    margin-top: 0.08rem;
    color: var(--text-faint);
    font-size: 0.73rem;
    font-weight: 500;
  }
  .control-note {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.72rem;
    font-weight: 500;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .control-note strong {
    color: var(--text-secondary);
    font-weight: 600;
  }
  .apply-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.25rem;
    padding-top: 1rem;
    border-top: 1px solid color-mix(in srgb, var(--border) 75%, var(--accent) 25%);
  }
  .apply-model-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    min-width: 9.5rem;
    min-height: 2.75rem;
    padding: 0.6rem 1.25rem;
    font-size: 0.86rem;
    font-weight: 600;
    box-shadow: 0 2px 10px var(--accent-subtle);
  }
  .spinner-inline {
    display: inline-block;
    width: 0.85rem;
    height: 0.85rem;
    border: 2px solid rgba(255, 255, 255, 0.3);
    border-top-color: #ffffff;
    border-radius: var(--radius-full);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .selection-preview {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }
  .selection-preview-label {
    font-size: 0.68rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-faint);
  }
  .selection-preview-val {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .selection-preview-val strong {
    font-size: 0.88rem;
    color: var(--text);
    font-weight: 600;
  }
  .status-tag {
    font-size: 0.67rem;
    font-weight: 600;
    padding: 0.1rem 0.38rem;
    border-radius: var(--radius-xs);
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .status-tag.active {
    background: var(--ok-subtle);
    color: var(--ok);
    border: 1px solid color-mix(in srgb, var(--ok) 30%, transparent);
  }
  .status-tag.pending {
    background: var(--accent-subtle);
    color: var(--accent-hover);
    border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .preference-control {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 8.75rem;
    gap: 0.7rem;
    align-items: end;
  }
  .preference-stack {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    min-width: 0;
  }
  .preference-control .primary,
  .language-control .primary {
    width: 8.75rem;
    min-height: 2.75rem;
  }
  .engine-details summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 0.79rem;
    font-weight: 600;
  }
  .engine-details summary:hover {
    color: var(--text);
  }
  .facts {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.7rem 0.8rem;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
  }
  .facts div {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: 0.82rem;
  }
  .facts dt {
    color: var(--text-dim);
    flex: none;
  }
  .facts dd {
    margin: 0;
    text-align: right;
    overflow-wrap: anywhere;
    color: var(--text-secondary);
    font-weight: 600;
  }
  .mono {
    font-family: var(--mono);
    font-size: 0.76rem;
  }
  .meta {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.8rem;
  }
  .card-footer-note {
    margin-top: auto;
    padding-top: 0.15rem;
  }
  .error-box {
    border: 1px solid color-mix(in srgb, var(--danger) 50%, transparent);
    background: var(--danger-subtle);
    border-radius: var(--radius-sm);
    padding: 0.65rem 0.85rem;
    color: var(--danger);
    font-size: 0.84rem;
  }
  .error-box p {
    margin: 0.1rem 0;
  }
  .code {
    font-family: var(--mono);
    font-size: 0.72rem;
  }
  .language-control {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    padding-bottom: 0.9rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .language-control + .language-control {
    padding-top: 0.25rem;
  }
  .engine-details {
    margin-top: 0.15rem;
    padding: 1.05rem 0.25rem 0;
    border: 1px solid var(--border-subtle);
    border-width: 1px 0 0;
  }
  .engine-details summary strong {
    display: block;
    color: var(--text);
    font-size: 0.95rem;
  }
  .engine-details summary small {
    display: block;
    margin-top: 0.18rem;
    color: var(--text-dim);
    font-size: 0.76rem;
    font-weight: 500;
  }
  .summary-hint {
    color: var(--text-faint);
    font-size: 0.72rem;
    font-weight: 600;
  }
  .advanced-content {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
    align-items: start;
    margin-top: 1.1rem;
    padding-bottom: 0.25rem;
  }
  .advanced-group {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    min-width: 0;
    padding: 1rem;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--surface-1) 72%, var(--surface-0));
  }
  .advanced-group h4 {
    margin: 0;
    color: var(--text-secondary);
    font-size: 0.86rem;
  }
  .advanced-group header p {
    margin: 0.25rem 0 0;
    color: var(--text-dim);
    font-size: 0.75rem;
    line-height: 1.45;
  }

  @container (max-width: 50rem) {
    .active-summary {
      grid-template-columns: 1fr;
      gap: 1.15rem;
    }
  }

  @container (max-width: 42rem) {
    .card {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 0.85rem;
      padding: 1.25rem 0.1rem;
    }
    .model-card {
      padding: 1.2rem;
    }
    .card-header,
    .model-card .card-header {
      width: 100%;
    }
  }

  @container (max-width: 34rem) {
    .model-card .card-header,
    .apply-row {
      align-items: stretch;
      flex-direction: column;
    }
    .active-summary-data,
    .field-grid,
    .advanced-content {
      grid-template-columns: 1fr;
    }
    .active-summary-data div {
      padding: 0.45rem 0 0;
      border-top: 1px solid color-mix(in srgb, var(--border-hover) 65%, transparent);
      border-left: 0;
    }
    .preference-control {
      grid-template-columns: 1fr;
    }
    .language-control .primary,
    .preference-control .primary {
      width: 100%;
    }
    .apply-row .primary {
      width: 100%;
      min-height: 2.75rem;
    }
  }

  @media (max-width: 58rem) {
    .active-summary {
      grid-template-columns: 1fr;
    }
    .card {
      grid-template-columns: minmax(11rem, 0.65fr) minmax(0, 1.35fr);
    }
  }

  @media (max-width: 46rem) {
    .screen {
      gap: 1rem;
      padding: 1.25rem 1rem 2rem;
    }
    .settings-header,
    .apply-row {
      align-items: stretch;
      flex-direction: column;
    }
    .refresh-button,
    .apply-row .primary {
      width: 100%;
    }
    .active-summary {
      gap: 1rem;
      padding: 1.1rem;
    }
    .active-summary-data,
    .field-grid,
    .advanced-content {
      grid-template-columns: 1fr;
    }
    .card {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 0.85rem;
      padding: 1.25rem 0.1rem;
    }
    .model-card {
      padding: 1.2rem;
    }
    .card-header,
    .model-card .card-header {
      width: 100%;
    }
    .preference-control {
      grid-template-columns: 1fr;
    }
    .language-control .primary,
    .preference-control .primary {
      width: 100%;
    }
  }
</style>
