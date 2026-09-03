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

  import { getPaths } from '$lib/api/desktop';
  import { currentLanguage, t } from '$lib/locale';
  import {
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
    return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : '—';
  }
</script>

<section class="settings-screen screen" data-testid="settings-screen">
  <header class="screen-header">
    <h2>{title}</h2>
    <p class="screen-description">{description} <span class="owner">({owner})</span></p>
  </header>

  {#if snapshot === null}
    <div class="empty-state" data-testid="settings-empty">
      <h3>{t('common.noProject.title', lang)}</h3>
      <p>{t('settings.empty.hint', lang)}</p>
    </div>
  {:else}
    <div class="actions-row">
      <button type="button" onclick={() => refresh()} disabled={settings.status === 'loading'} data-testid="settings-refresh">
        Refresh configuration
      </button>
      {#if settings.message}
        <span class="applied" data-testid="settings-applied">{settings.message}</span>
        <button type="button" class="small" onclick={() => dismissSettingsMessage()} data-testid="settings-dismiss-applied">
          Dismiss
        </button>
      {/if}
    </div>

    {#if settings.error}
      <div class="error-box" data-testid="settings-error">
        <p>{configError?.title} — {settings.error.message} <span class="code">[{settings.error.code}]</span></p>
        <p class="meta">{configError?.action ?? ''}</p>
      </div>
    {/if}

    <div class="card-grid">
      <article class="card" data-testid="settings-model">
        <h3>Provider &amp; model</h3>
        <p class="meta">
          Active: <span class="mono">{view?.provider ?? '—'} / {view?.model ?? '—'}</span>
        </p>
        <label>
          provider
          <select value={selectedProvider} onchange={changeProvider} data-testid="settings-provider-select">
            {#each providerNames as name (name)}
              <option value={name}>{name}</option>
            {/each}
          </select>
        </label>
        <label>
          model
          <select value={selectedModel} onchange={changeModel} data-testid="settings-model-select">
            {#each modelNames as name (name)}
              <option value={name}>{name}</option>
            {/each}
          </select>
        </label>
        <button
          type="button"
          class="primary"
          onclick={() => switchModelFromUi(selectedProvider, selectedModel)}
          disabled={!modelChoiceValid || settings.mutations.model !== 'idle'}
          data-testid="settings-model-apply"
        >
          {settings.mutations.model === 'applying' ? 'Switching…' : 'Switch model'}
        </button>

        {#if activeProviderSummary}
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
          <p class="meta">Credentials stay engine-side; only a masked hint ever reaches the UI.</p>
        {/if}
      </article>

      <article class="card" data-testid="settings-thinking">
        <h3>Thinking level</h3>
        <p class="meta">
          Active: <span class="mono">{view?.reasoning_effort ?? '—'}</span>
          {#if settings.thinking.model}for {settings.thinking.provider ?? '?'} / {settings.thinking.model}{/if}
        </p>
        {#if settings.thinking.error}
          <div class="error-box">
            <p>{presentError(settings.thinking.error.code).title} — {settings.thinking.error.message}</p>
          </div>
        {:else}
          <label>
            level
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
            {settings.mutations.thinking === 'applying' ? 'Applying…' : 'Set thinking level'}
          </button>
          <p class="meta">Levels come from the engine for the active model (config.thinking_levels).</p>
        {/if}
      </article>

      <article class="card" data-testid="settings-languages">
        <h3>{t('settings.languages.title', lang)}</h3>
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
        <label class="form-gap">
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
        <p class="meta">{t('settings.languages.hint', lang)}</p>
      </article>

      <article class="card" data-testid="settings-notifications">
        <h3>Notifications</h3>
        <p class="meta">Local toast preferences for engine events (this app session).</p>
        <label class="check">
          <input
            type="checkbox"
            checked={prefs.completion}
            onchange={(event) => togglePref('completion', event)}
            data-testid="settings-pref-completion"
          />
          completion notifications
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={prefs.pause}
            onchange={(event) => togglePref('pause', event)}
            data-testid="settings-pref-pause"
          />
          pause notifications
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={prefs.warning}
            onchange={(event) => togglePref('warning', event)}
            data-testid="settings-pref-warning"
          />
          warning notifications
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={prefs.failure}
            onchange={(event) => togglePref('failure', event)}
            data-testid="settings-pref-failure"
          />
          failure notifications
        </label>
        <p class="meta">Errors from your own actions always surface.</p>
      </article>

      <article class="card" data-testid="settings-readonly">
        <h3>Engine-managed (read-only)</h3>
        <dl class="facts">
          <div><dt>Budget limit</dt><dd data-testid="settings-budget">{money(view?.budget_usd)}</dd></div>
          {#if view?.style}<div><dt>Style</dt><dd>{view.style}</dd></div>{/if}
          {#if view?.config_path}<div><dt>Config file</dt><dd class="mono">{view.config_path}</dd></div>{/if}
          {#if projectsDir}<div><dt>Projects directory</dt><dd class="mono">{projectsDir}</dd></div>{/if}
        </dl>
        <p class="meta">
          Budget and style have no public engine setters (config.update rejects them); export and
          diagnostics destinations are chosen per-run through native dialogs.
        </p>
        <p class="meta" data-testid="settings-update-channel">
          Update channel: app updates are managed outside this app — the engine exposes no setting.
        </p>
      </article>
    </div>
  {/if}
</section>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.9rem 1rem 1.5rem;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .screen-header h2 {
    margin: 0;
    font-size: 1.2rem;
  }
  .screen-description {
    margin: 0.1rem 0 0;
    color: var(--text-faint);
    font-size: 0.82rem;
  }
  .owner {
    font-style: italic;
  }
  .empty-state {
    padding: 2.5rem 2rem;
    border: 1px dashed var(--border);
    border-radius: 10px;
  }
  .empty-state h3 {
    margin: 0 0 0.3rem;
  }
  .empty-state p {
    margin: 0;
    color: var(--text-dim);
  }
  .actions-row {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .applied {
    color: var(--ok);
    font-size: 0.82rem;
  }
  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr));
    gap: 0.75rem;
    align-items: start;
  }
  .card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem 0.9rem;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .card h3 {
    margin: 0;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.8rem;
    color: var(--text-dim);
  }
  label.check {
    flex-direction: row;
    align-items: center;
    gap: 0.45rem;
  }
  label.form-gap {
    margin-top: 0.4rem;
  }
  select {
    font-size: 0.82rem;
  }
  button.primary {
    align-self: flex-start;
  }
  .facts {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .facts div {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: 0.82rem;
  }
  .facts dt {
    color: var(--text-faint);
    flex: none;
  }
  .facts dd {
    margin: 0;
    text-align: right;
    overflow-wrap: anywhere;
  }
  .mono {
    font-family: var(--mono);
    font-size: 0.76rem;
  }
  .meta {
    margin: 0;
    color: var(--text-faint);
    font-size: 0.78rem;
  }
  .error-box {
    border: 1px solid color-mix(in srgb, var(--danger) 50%, transparent);
    border-radius: 8px;
    padding: 0.5rem 0.7rem;
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
    padding: 0.2rem 0.55rem;
  }
</style>
