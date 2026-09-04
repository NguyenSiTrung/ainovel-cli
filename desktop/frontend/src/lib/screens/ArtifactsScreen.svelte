<script lang="ts">
  /**
   * Artifacts screen: read-only projections of the engine's book bible.
   *
   * Outline, characters, and the story fields ride `project.snapshot`; the
   * facts / world / summaries panes are read through `artifacts.read`
   * (desktop-v1 §12 read-only projections; the engine owns all writes).
   * The read model refreshes on entry, on Refresh, and on the engine's
   * update signals (chapter/artifact/outline → snapshot refresh → re-read).
   * No edit affordances exist here by design.
   */
  import { onMount } from 'svelte';
  import ErrorBanner from '$lib/components/ErrorBanner.svelte';
  import MarkdownView from '$lib/components/MarkdownView.svelte';
  import { artifactsState, enterArtifactsScreen, leaveArtifactsScreen } from '$lib/artifacts';
  import { projectSnapshot, refreshSnapshot } from '$lib/stores/desktop';
  import type { ChapterFactsEntry, ChapterSummaryEntry } from '$lib/api/desktop';
  import type { OutlineEntry } from '$lib/types/protocol';

  let { title, description, owner }: { title: string; description: string; owner: string } = $props();

  onMount(() => {
    enterArtifactsScreen();
    return leaveArtifactsScreen;
  });

  let snapshot = $derived($projectSnapshot);
  let artifacts = $derived($artifactsState);

  let outline: OutlineEntry[] = $derived(Array.isArray(snapshot?.outline) ? (snapshot!.outline as OutlineEntry[]) : []);
  let characters: string[] = $derived.by(() => {
    const raw = snapshot?.characters;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((c) => {
        if (typeof c === 'string') return c;
        if (typeof c === 'object' && c !== null) {
          const name = (c as { name?: unknown }).name;
          if (typeof name === 'string' && name !== '') return name;
        }
        return undefined;
      })
      .filter((c): c is string => c !== undefined);
  });

  function proseField(key: string): string | undefined {
    const value = snapshot?.[key];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  }

  let synopsis = $derived(proseField('synopsis'));
  let premise = $derived(proseField('premise'));
  let style = $derived(proseField('style'));

  // ── facts / world / summaries projections (artifacts.read) ──

  function factsObject(entry: ChapterFactsEntry): Record<string, unknown> {
    return typeof entry.facts === 'object' && entry.facts !== null && !Array.isArray(entry.facts)
      ? (entry.facts as Record<string, unknown>)
      : {};
  }
  function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  }
  function strList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : [];
  }
  /** The named human-readable fields, extracted for prose rendering. */
  function factsDisplay(entry: ChapterFactsEntry): {
    title?: string;
    summary?: string;
    characters: string[];
    keyEvents: string[];
  } {
    const facts = factsObject(entry);
    return {
      title: str(facts.title),
      summary: str(facts.summary),
      characters: strList(facts.characters),
      keyEvents: strList(facts.key_events),
    };
  }
  /** Additive/unknown facts fields still surface, as JSON (README §9). */
  function factsRest(entry: ChapterFactsEntry): string | null {
    const facts = factsObject(entry);
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(facts)) {
      if (key !== 'title' && key !== 'summary' && key !== 'characters' && key !== 'key_events') {
        rest[key] = value;
      }
    }
    return Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : null;
  }

  let summariesMarkdown = $derived.by(() => {
    const entries = artifacts.summaries.entries;
    if (entries.length === 0) return '';
    return entries
      .map((entry: ChapterSummaryEntry) => {
        const heading = `## Chapter ${entry.chapter ?? '?'}${entry.title ? ` — ${entry.title}` : ''}`;
        const parts = [heading];
        const summary = str(entry.summary);
        if (summary) parts.push(summary);
        const characters = strList(entry.characters);
        if (characters.length > 0) parts.push(`**Characters:** ${characters.join(', ')}`);
        const events = strList(entry.key_events);
        if (events.length > 0) parts.push(events.map((e) => `- ${e}`).join('\n'));
        return parts.join('\n\n');
      })
      .join('\n\n');
  });

  let refreshing = $state(false);
  // Refresh refreshes the snapshot only: the fresh snapshot store value
  // drives the artifacts re-read (same path as the engine's update signals).
  async function refresh(): Promise<void> {
    refreshing = true;
    try {
      await refreshSnapshot();
    } finally {
      refreshing = false;
    }
  }
</script>

<section class="artifacts-screen screen" data-testid="artifacts-screen">
  <header class="screen-header">
    <h2>{title}</h2>
    <p class="screen-description">
      {description} <span class="owner">({owner})</span>
      <button type="button" class="small" onclick={() => refresh()} disabled={refreshing} data-testid="artifacts-refresh">
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
    </p>
  </header>

  {#if snapshot === null}
    <div class="empty-state" data-testid="artifacts-empty">
      <h3>No project open</h3>
      <p>Open or create a project from the Overview screen to see its artifacts.</p>
    </div>
  {:else}
    <div class="artifacts-grid">
      <section class="pane" data-testid="artifacts-outline">
        <h3>Outline</h3>
        {#if synopsis}<p class="synopsis">{synopsis}</p>{/if}
        {#if outline.length === 0}
          <p class="meta">No outline yet — it appears as the engine plans the book.</p>
        {:else}
          <ol class="outline-list">
            {#each outline as entry, i (i)}
              {@const label = entry.chapter ?? i + 1}
              <li data-testid="artifacts-outline-row">
                <span class="chapter">Ch {label}</span>
                <span class="outline-body">
                  {#if entry.title}<span class="outline-title">{entry.title}</span>{/if}
                  {#if entry.core_event}<span class="outline-event">{entry.core_event}</span>{/if}
                </span>
              </li>
            {/each}
          </ol>
        {/if}
      </section>

      <section class="pane" data-testid="artifacts-characters">
        <h3>Characters</h3>
        {#if characters.length === 0}
          <p class="meta">No characters published yet.</p>
        {:else}
          <ul class="character-list">
            {#each characters as name (name)}
              <li data-testid="artifacts-character">{name}</li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="pane" data-testid="artifacts-story">
        <h3>Story</h3>
        {#if premise}
          <div class="story-block">
            <h4>Premise</h4>
            <p>{premise}</p>
          </div>
        {/if}
        {#if style}
          <div class="story-block">
            <h4>Style</h4>
            <p>{style}</p>
          </div>
        {/if}
        {#if !premise && !style}
          <p class="meta">No premise or style published yet.</p>
        {/if}
      </section>

      <section class="pane" data-testid="artifacts-facts">
        <h3>Facts</h3>
        {#if artifacts.facts.error}
          <div data-testid="artifacts-facts-error"><ErrorBanner error={artifacts.facts.error} /></div>
        {:else if artifacts.facts.entries.length === 0}
          {#if artifacts.facts.loading && !artifacts.facts.loaded}
            <p class="meta" data-testid="artifacts-facts-loading">Loading chapter facts…</p>
          {:else}
            <p class="meta" data-testid="artifacts-facts-empty">
              No accepted chapter facts yet — they appear here as the engine accepts chapters.
            </p>
          {/if}
        {:else}
          <div class="facts-list">
            {#each artifacts.facts.entries as entry (entry.chapter ?? JSON.stringify(entry))}
              {@const display = factsDisplay(entry)}
              {@const rest = factsRest(entry)}
              <article class="facts-entry" data-testid="artifacts-facts-entry">
                <p class="facts-meta">
                  <span class="chapter">Ch {entry.chapter ?? '?'}</span>
                  {#if entry.origin}<span class="facts-origin">{entry.origin}</span>{/if}
                  {#if typeof entry.version === 'number'}<span class="facts-version">v{entry.version}</span>{/if}
                </p>
                {#if display.title}<strong class="facts-title">{display.title}</strong>{/if}
                {#if display.summary}<p class="facts-summary">{display.summary}</p>{/if}
                {#if display.characters.length > 0}
                  <ul class="character-list">
                    {#each display.characters as name (name)}
                      <li data-testid="artifacts-facts-character">{name}</li>
                    {/each}
                  </ul>
                {/if}
                {#if display.keyEvents.length > 0}
                  <ul class="facts-events">
                    {#each display.keyEvents as event (event)}
                      <li data-testid="artifacts-facts-event">{event}</li>
                    {/each}
                  </ul>
                {/if}
                {#if rest}<div class="json-block" data-testid="artifacts-facts-rest">{rest}</div>{/if}
              </article>
            {/each}
          </div>
        {/if}
      </section>

      <section class="pane" data-testid="artifacts-world">
        <h3>World</h3>
        {#if artifacts.world.error}
          <div data-testid="artifacts-world-error"><ErrorBanner error={artifacts.world.error} /></div>
        {:else if artifacts.world.entries.length === 0}
          {#if artifacts.world.loading && !artifacts.world.loaded}
            <p class="meta" data-testid="artifacts-world-loading">Loading world rules…</p>
          {:else}
            <p class="meta" data-testid="artifacts-world-empty">No world rules recorded yet.</p>
          {/if}
        {:else}
          <ul class="world-list">
            {#each artifacts.world.entries as rule, i (i)}
              <li data-testid="artifacts-world-rule">
                {#if rule.category}<span class="world-category">{rule.category}</span>{/if}
                <span class="world-rule">{rule.rule ?? ''}</span>
                {#if rule.boundary}<span class="world-boundary">{rule.boundary}</span>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section class="pane" data-testid="artifacts-summaries">
        <h3>Summaries</h3>
        {#if artifacts.summaries.error}
          <div data-testid="artifacts-summaries-error"><ErrorBanner error={artifacts.summaries.error} /></div>
        {:else if artifacts.summaries.entries.length === 0}
          {#if artifacts.summaries.loading && !artifacts.summaries.loaded}
            <p class="meta" data-testid="artifacts-summaries-loading">Loading chapter summaries…</p>
          {:else}
            <p class="meta" data-testid="artifacts-summaries-empty">No chapter summaries yet.</p>
          {/if}
        {:else}
          <MarkdownView text={summariesMarkdown} testid="artifacts-summaries-content" />
        {/if}
      </section>
    </div>
  {/if}
</section>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.25rem 1.5rem 2rem;
    flex: 1;
    min-height: 0;
  }
  .screen-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .screen-header h2 {
    margin: 0;
    font-size: 1.35rem;
    font-weight: 700;
  }
  .screen-description {
    margin: 0.15rem 0 0;
    color: var(--text-dim);
    font-size: 0.84rem;
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .owner {
    font-style: italic;
    display: none;
  }
  button.small {
    font-size: 0.72rem;
    padding: 0.15rem 0.6rem;
    border-radius: var(--radius-full);
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
  .artifacts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
    gap: 0.85rem;
    align-items: start;
  }
  .pane {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1rem 1.15rem;
    max-height: 28rem;
    overflow-y: auto;
    box-shadow: var(--shadow-sm);
  }
  .pane h3 {
    margin: 0 0 0.75rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    font-weight: 700;
  }
  .pane h4 {
    margin: 0.75rem 0 0.3rem;
    font-size: 0.8rem;
    color: var(--text);
    font-weight: 600;
  }
  .meta {
    margin: 0.2rem 0;
    color: var(--text-faint);
    font-size: 0.82rem;
  }
  .synopsis {
    margin: 0 0 0.75rem;
    font-size: 0.88rem;
    color: var(--text-dim);
    font-family: var(--font-serif);
    line-height: 1.6;
    padding-bottom: 0.6rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .outline-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .outline-list li {
    display: flex;
    gap: 0.6rem;
    font-size: 0.82rem;
    align-items: baseline;
    padding: 0.4rem 0.55rem;
    border-radius: var(--radius-xs);
    background: var(--surface-2);
  }
  .chapter {
    font-family: var(--mono);
    color: var(--accent);
    flex: none;
    min-width: 3.2rem;
    font-weight: 600;
    font-size: 0.78rem;
  }
  .outline-body {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .outline-title {
    color: var(--text);
    font-weight: 500;
  }
  .outline-event {
    color: var(--text-dim);
    font-size: 0.76rem;
  }
  .character-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .character-list li {
    font-size: 0.8rem;
    padding: 0.2rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--surface-2);
    color: var(--text);
    font-weight: 500;
  }
  .story-block p {
    margin: 0;
    font-size: 0.86rem;
    line-height: 1.6;
    color: var(--text-dim);
  }
  .facts-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .facts-entry {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.65rem 0.8rem;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
  }
  .facts-meta {
    margin: 0;
    display: flex;
    gap: 0.5rem;
    font-size: 0.74rem;
    color: var(--text-faint);
  }
  .facts-meta .chapter {
    min-width: 0;
  }
  .facts-origin,
  .facts-version {
    font-family: var(--mono);
  }
  .facts-title {
    font-size: 0.88rem;
    font-weight: 600;
    color: var(--text);
  }
  .facts-summary {
    margin: 0;
    font-size: 0.82rem;
    color: var(--text-dim);
    line-height: 1.5;
  }
  .facts-events {
    margin: 0;
    padding-left: 1.1rem;
    font-size: 0.78rem;
    color: var(--text-dim);
  }
  .world-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .world-list li {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.5rem 0.65rem;
    background: var(--surface-2);
    border-radius: var(--radius-xs);
    font-size: 0.82rem;
  }
  .world-category {
    font-family: var(--mono);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent);
    font-weight: 600;
  }
  .world-rule {
    color: var(--text);
    line-height: 1.45;
  }
  .world-boundary {
    color: var(--text-faint);
    font-size: 0.76rem;
  }
  .json-block {
    white-space: pre-wrap;
    font-family: var(--mono);
    font-size: 0.74rem;
    color: var(--text-dim);
    background: var(--surface-3);
    padding: 0.4rem 0.6rem;
    border-radius: var(--radius-xs);
    border: 1px solid var(--border-subtle);
  }
</style>
