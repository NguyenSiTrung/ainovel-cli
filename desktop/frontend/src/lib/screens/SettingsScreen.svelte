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
          <div>
            <h3>AI model</h3>
            <p class="meta">Choose the provider and model used across your writing workflow.</p>
          </div>
          <p class="active-pair">Active <span class="mono">{view?.provider || 'Not configured'} / {view?.model || 'Not configured'}</span></p>
        </header>

        {#if providerNames.length === 0}
          <div class="empty-provider-notice" data-testid="settings-no-providers">
            No providers configured yet. Click "+ Add provider" below to get started.
          </div>
        {/if}

        <div class="field-grid">
          <label>
            Provider
            <select value={selectedProvider} onchange={changeProvider} data-testid="settings-provider-select">
              {#if providerNames.length === 0}
                <option value="" disabled selected>No providers configured</option>
              {/if}
              {#each providerNames as name (name)}
                <option value={name}>{name}</option>
              {/each}
            </select>
          </label>
          <label>
            Model
            <select value={selectedModel} onchange={changeModel} data-testid="settings-model-select">
              {#each modelNames as name (name)}
                <option value={name}>{name}</option>
              {/each}
            </select>
          </label>
        </div>

        <div class="provider-actions">
          <button
            type="button"
            class="small secondary"
            onclick={openAddProvider}
            data-testid="settings-provider-add"
          >
            + Add provider
          </button>
          <button
            type="button"
            class="small"
            disabled={!selectedProvider}
            onclick={openEditProvider}
            data-testid="settings-provider-edit"
          >
            Edit
          </button>
          <button
            type="button"
            class="small danger"
            disabled={!selectedProvider || selectedProvider === view?.provider || settings.mutations.provider !== 'idle'}
            title={selectedProvider === view?.provider ? 'Active default provider cannot be deleted' : undefined}
            onclick={handleDeleteProvider}
            data-testid="settings-provider-delete"
          >
            Delete
          </button>
        </div>

        <div class="apply-row">
          <p class="meta">Changes apply to the active project after you confirm them.</p>
          <button
            type="button"
            class="primary"
            onclick={() => switchModelFromUi(selectedProvider, selectedModel)}
            disabled={!modelChoiceValid || settings.mutations.model !== 'idle'}
            data-testid="settings-model-apply"
          >
            {settings.mutations.model === 'applying' ? 'Switching…' : 'Use this model'}
          </button>
        </div>

      </article>

      <article class="card" data-testid="settings-thinking">
        <header class="card-header">
          <div>
            <h3>Thinking level</h3>
            <p class="meta">Control how much reasoning the current model uses before it writes.</p>
          </div>
          <span class="current-value">Current: {view?.reasoning_effort ?? 'Default'}</span>
        </header>
        {#if settings.thinking.error}
          <div class="error-box" role="alert">
            <p>{presentError(settings.thinking.error.code).title}: {settings.thinking.error.message}</p>
          </div>
        {:else}
          <div class="preference-control">
            <label>
              Level
              <select value={selectedThinking} onchange={changeThinking} data-testid="settings-thinking-select">
                {#each settings.thinking.levels as level (level)}
                  <option value={level}>{level}</option>
                {/each}
              </select>
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
          <label>
            {t('settings.languages.interfaceLabel', lang)}
            <select value={selectedLanguage} onchange={changeLanguage} data-testid="settings-language-select">
              {#each languageChoices as code (code)}
                <option value={code}>{LANGUAGE_LABELS[code] ?? code}</option>
              {/each}
            </select>
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
        <div class="language-control">
          <label>
            {t('settings.languages.storyLabel', lang)}
            <select value={selectedStoryLanguage} onchange={changeStoryLanguage} data-testid="settings-story-language-select">
              {#each languageChoices as code (code)}
                <option value={code}>{LANGUAGE_LABELS[code] ?? code}</option>
              {/each}
            </select>
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
    gap: 0.9rem;
    margin-bottom: 0.2rem;
    padding: 1.45rem 1.5rem 1.55rem;
    background: color-mix(in srgb, var(--surface-1) 92%, var(--accent));
    border: 1px solid color-mix(in srgb, var(--accent) 19%, var(--border));
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm), inset 0 1px 0 color-mix(in srgb, var(--text) 4%, transparent);
  }
  .model-card > .card-header,
  .model-card > :not(.card-header) {
    grid-column: auto;
    grid-row: auto;
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
    font-size: 1.02rem;
    font-weight: 650;
    letter-spacing: -0.02em;
  }
  .card-header .meta {
    margin-top: 0.38rem;
    max-width: 30rem;
    line-height: 1.45;
    text-wrap: pretty;
  }
  .active-pair {
    flex: none;
    margin: 0.08rem 0 0;
    color: var(--text-dim);
    font-size: 0.73rem;
    text-align: right;
  }
  .active-pair span {
    display: block;
    margin-top: 0.18rem;
    color: var(--text-secondary);
    overflow-wrap: anywhere;
  }
  .current-value {
    display: block;
    margin-top: 0.45rem;
    color: var(--text-dim);
    font-size: 0.73rem;
    font-weight: 600;
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
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
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
  select {
    font-size: 0.84rem;
    width: 100%;
    min-height: 2.25rem;
  }
  .apply-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.85rem;
    padding-top: 0.15rem;
  }
  .apply-row .meta {
    max-width: 22rem;
    color: var(--text-dim);
  }
  .preference-control {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.65rem;
    align-items: end;
  }
  .preference-control .primary,
  .language-control .primary {
    min-width: 4.75rem;
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
  button.small {
    font-size: 0.75rem;
    padding: 0.24rem 0.55rem;
    border-radius: var(--radius-sm);
  }
  .provider-actions {
    display: flex;
    gap: 0.45rem;
    align-items: center;
    flex-wrap: wrap;
    margin-top: -0.1rem;
  }
  button.secondary {
    color: var(--text-secondary);
    background: var(--surface-2);
    border-color: var(--border);
  }
  button.danger {
    background: var(--danger-subtle);
    color: var(--danger);
    border: 1px solid var(--danger);
  }
  button.danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--danger) 25%, transparent);
  }
  .language-control {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.65rem;
    align-items: end;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .language-control + .language-control {
    padding-top: 0.1rem;
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
    .active-pair {
      text-align: left;
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
    .language-control,
    .preference-control {
      grid-template-columns: 1fr;
    }
    .language-control .primary,
    .preference-control .primary {
      width: 100%;
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
    .language-control,
    .preference-control {
      grid-template-columns: 1fr;
    }
    .language-control .primary,
    .preference-control .primary {
      width: 100%;
    }
  }
</style>
