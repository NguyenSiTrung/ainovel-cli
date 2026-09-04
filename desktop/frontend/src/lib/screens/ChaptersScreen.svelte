<script lang="ts">
  /**
   * Chapters screen: chapter list with status/progress (chapter.list), a
   * reader for the final chapter text (chapter.read — desktop-v1 exposes no
   * intermediate-artifact reads, so only the final text is ever shown), an
   * editor with dirty-state tracking and base_version optimistic locking
   * (explicit conflict resolution: reload vs review-then-overwrite), and the
   * revisions panel. All mutations go through protocol commands; the
   * unsaved-change guard lives in the shell (UnsavedGuardCard).
   */
  import { onMount } from 'svelte';

  import MarkdownView from '$lib/components/MarkdownView.svelte';
  import RevisionsPanel from '$lib/components/RevisionsPanel.svelte';
  import {
    beginConflictReview,
    chapterEditor,
    chapterListState,
    closeEditor,
    editDraft,
    editorDirty,
    enterChaptersScreen,
    openChapter,
    overwriteAfterReview,
    resolveConflictReload,
    saveEditor,
    stopEditing,
  } from '$lib/chapters';
  import { projectSnapshot } from '$lib/stores/desktop';
  import { presentError } from '$lib/types/protocol';

  let { title, description, owner }: { title: string; description: string; owner: string } = $props();

  let snapshot = $derived($projectSnapshot);
  let list = $derived($chapterListState);
  let editor = $derived($chapterEditor);
  let dirty = $derived($editorDirty);

  let editing = $state(false);
  let editorError = $derived(editor.error ? presentError(editor.error.code) : null);
  let filterQuery = $state('');

  // Opening a different chapter always starts in read mode.
  let seenChapter: number | null = null;
  $effect(() => {
    if (editor.chapter !== seenChapter) {
      seenChapter = editor.chapter;
      editing = false;
    }
  });

  // Screen entry: refresh the chapter list + run the revision check.
  onMount(() => {
    enterChaptersScreen();
  });

  function startEditing(): void {
    if (editor.baseline !== null) {
      editDraft(editor.baseline.content);
      editing = true;
    }
  }

  let filteredItems = $derived.by(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return list.items;
    return list.items.filter((item) => {
      const ch = String(item.chapter ?? '');
      const title = (item.title ?? '').toLowerCase();
      return ch.includes(q) || title.includes(q);
    });
  });

  let editWordCount = $derived(
    editor.draft ? editor.draft.trim().split(/\s+/).filter(Boolean).length : 0,
  );
</script>

<section class="chapters-screen screen" data-testid="chapters-screen">
  <header class="screen-header">
    <h2>{title}</h2>
    <p class="screen-description">{description} <span class="owner">({owner})</span></p>
  </header>

  {#if snapshot === null}
    <div class="empty-state" data-testid="chapters-empty">
      <h3>No project open</h3>
      <p>Open or create a project from the Overview screen to read and edit chapters.</p>
    </div>
  {:else}
    <div class="chapters-body">
      <aside class="pane list-pane" data-testid="chapters-list-pane">
        <div class="pane-header-row">
          <h3>Chapters</h3>
          {#if list.items.length > 0}
            <span class="chapter-count-pill">{list.items.length}</span>
          {/if}
        </div>
        <dl class="facts" data-testid="chapters-progress">
          <div><dt>Saved</dt><dd>{list.completed ?? 0}/{list.total ?? snapshot.total_chapters ?? '?'}</dd></div>
          {#if list.inProgress}
            <div><dt>In progress</dt><dd>chapter {list.inProgress}</dd></div>
          {/if}
          {#if list.pendingRewrites}
            <div class="hold"><dt>Rewrites</dt><dd>{list.pendingRewrites} pending</dd></div>
          {/if}
        </dl>

        {#if list.items.length > 3}
          <div class="chapter-search-box">
            <input
              type="text"
              placeholder="Filter chapters..."
              bind:value={filterQuery}
              class="search-input"
            />
          </div>
        {/if}

        {#if list.loading && list.items.length === 0}
          <p class="meta" data-testid="chapters-list-loading">loading chapters…</p>
        {:else if list.error}
          <p class="meta error" data-testid="chapters-list-error">{list.error.message}</p>
        {:else if list.items.length === 0}
          <p class="meta" data-testid="chapters-list-empty">
            No completed chapters yet — the engine saves chapters here as it writes them.
          </p>
        {:else}
          <ol class="chapter-list" data-testid="chapters-list">
            {#each filteredItems as item (item.chapter ?? 0)}
              {@const n = item.chapter ?? 0}
              <li>
                <button
                  type="button"
                  class="chapter-row"
                  class:active={editor.chapter === n}
                  class:dirty={editor.chapter === n && dirty}
                  onclick={() => openChapter(n)}
                  data-testid="chapter-row-{n}"
                >
                  <span class="num">Ch {n}</span>
                  <span class="row-body">
                    <span class="row-title">{item.title ?? 'Untitled'}</span>
                    <span class="row-meta">
                      {item.status ?? 'saved'}{item.version !== undefined ? ` · v${item.version}` : ''}
                      {item.origin ? ` · ${item.origin}` : ''}
                      {item.words !== undefined ? ` · ${(item.words ?? 0).toLocaleString()} words` : ''}
                    </span>
                  </span>
                </button>
              </li>
            {/each}
          </ol>
        {/if}
      </aside>

      <section class="pane reader-pane" data-testid="chapters-reader-pane">
        <h3>Chapter</h3>
        {#if editor.chapter === null}
          <p class="meta" data-testid="chapters-reader-empty">Select a chapter to read it.</p>
        {:else if editor.loading}
          <p class="meta" data-testid="chapters-reader-loading">loading chapter {editor.chapter}…</p>
        {:else if editor.error && editor.baseline === null}
          <div class="error-box" data-testid="chapters-reader-error">
            <p>{editorError?.title} — {editor.error.message} <span class="code">[{editor.error.code}]</span></p>
            <p class="meta">{editorError?.action ?? ''}</p>
          </div>
        {:else if editor.baseline !== null}
          <article class="chapter-view">
            <header class="view-header">
              <span class="view-title" data-testid="chapter-view-title">
                Chapter {editor.chapter}
                {#if editor.baseline.version !== undefined}· v{editor.baseline.version}{/if}
                {#if editor.baseline.origin}· {editor.baseline.origin}{/if}
              </span>
              <span class="view-actions">
                {#if dirty}<span class="dirty-badge" data-testid="chapter-dirty-indicator">unsaved edits</span>{/if}
                {#if editing}
                  <button
                    type="button"
                    onclick={() => stopEditing()}
                    data-testid="chapter-stop-edit"
                    disabled={editor.saving}
                  >
                    Stop editing
                  </button>
                  <button
                    type="button"
                    class="primary"
                    onclick={() => saveEditor()}
                    disabled={!dirty || editor.saving}
                    data-testid="chapter-save"
                  >
                    {editor.saving ? 'Saving…' : 'Save chapter'}
                  </button>
                {:else}
                  <button type="button" onclick={() => startEditing()} data-testid="chapter-edit">Edit</button>
                {/if}
                <button
                  type="button"
                  onclick={() => closeEditor()}
                  disabled={editor.saving}
                  data-testid="chapter-close"
                >
                  Close
                </button>
              </span>
            </header>

            {#if editor.staleWarning}
              <p class="stale-note" data-testid="chapter-stale-warning">
                The engine saved a newer version of this chapter while you were editing — saving may
                conflict with the engine's revision.
              </p>
            {/if}

            {#if editor.error && editor.baseline !== null}
              <div class="error-box" data-testid="chapters-reader-error">
                <p>{editorError?.title} — {editor.error.message} <span class="code">[{editor.error.code}]</span></p>
                <p class="meta">{editorError?.action ?? ''}</p>
              </div>
            {/if}

            {#if editor.conflict}
              <div class="conflict" data-testid="chapter-conflict">
                <h4>Version conflict</h4>
                <p>
                  {editor.conflict.message}
                  {#if editor.conflict.engineVersion !== undefined}
                    (engine is at v{editor.conflict.engineVersion})
                  {/if}
                </p>
                <div class="conflict-actions">
                  <button
                    type="button"
                    onclick={() => resolveConflictReload()}
                    disabled={editor.reloading}
                    data-testid="conflict-reload"
                  >
                    {editor.reloading ? 'Reloading…' : 'Reload engine version (discard my edits)'}
                  </button>
                  {#if editor.conflict.engineContent === null}
                    <button
                      type="button"
                      onclick={() => beginConflictReview()}
                      disabled={editor.conflict.reviewing}
                      data-testid="conflict-review"
                    >
                      {editor.conflict.reviewing ? 'Fetching…' : 'Review engine version'}
                    </button>
                  {:else}
                    <button
                      type="button"
                      class="danger"
                      onclick={() => overwriteAfterReview()}
                      disabled={editor.saving}
                      data-testid="conflict-overwrite"
                    >
                      {editor.saving ? 'Saving…' : 'Overwrite engine version with my edit'}
                    </button>
                  {/if}
                </div>
                {#if editor.conflict.engineContent !== null}
                  <div class="engine-version">
                    <p class="meta">Engine version that would be overwritten:</p>
                    <div class="engine-content" data-testid="conflict-engine-content">
                      {editor.conflict.engineContent}
                    </div>
                  </div>
                {/if}
              </div>
            {/if}

            {#if editing}
              <textarea
                class="editor"
                rows="18"
                value={editor.draft}
                oninput={(event) => editDraft(event.currentTarget.value)}
                data-testid="chapter-editor"
                disabled={editor.saving}
              ></textarea>
              <p class="meta" data-testid="chapter-editor-meta">
                {dirty ? 'modified — save sends your text with the version you started from (base_version)' : 'unmodified'} · {editWordCount.toLocaleString()} words
              </p>
            {:else}
              {#if editor.baseline.content === ''}
                <p class="meta">(empty chapter)</p>
              {:else}
                <MarkdownView text={editor.baseline.content} testid="chapter-content" />
              {/if}
            {/if}
          </article>
        {/if}
      </section>
    </div>

    <RevisionsPanel />
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
  .screen-header h2 {
    margin: 0;
    font-size: 1.35rem;
    font-weight: 700;
  }
  .screen-description {
    margin: 0.15rem 0 0;
    color: var(--text-dim);
    font-size: 0.84rem;
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
  .chapters-body {
    display: grid;
    grid-template-columns: minmax(16rem, 22rem) minmax(0, 1fr);
    gap: 0.85rem;
    flex: 1;
    min-height: 26rem;
  }
  .pane {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1rem 1.15rem;
    overflow-y: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .pane-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.65rem;
  }
  .pane h3 {
    margin: 0;
    font-size: 0.74rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
    font-weight: 700;
  }
  .chapter-count-pill {
    font-size: 0.68rem;
    font-family: var(--mono);
    background: var(--surface-2);
    padding: 0.1rem 0.45rem;
    border-radius: var(--radius-full);
    color: var(--text-dim);
  }
  .chapter-search-box {
    margin-bottom: 0.6rem;
  }
  .chapter-search-box .search-input {
    width: 100%;
    font-size: 0.8rem;
    padding: 0.35rem 0.6rem;
    border-radius: var(--radius-sm);
  }
  .meta {
    margin: 0.2rem 0;
    color: var(--text-faint);
    font-size: 0.82rem;
  }
  .meta.error {
    color: var(--danger);
  }
  .facts {
    margin: 0 0 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.6rem 0.8rem;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
  }
  .facts div {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.8rem;
  }
  .facts dt {
    color: var(--text-dim);
    flex: none;
  }
  .facts dd {
    margin: 0;
    font-weight: 500;
  }
  .facts div.hold dd {
    color: var(--warn);
  }
  .chapter-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .chapter-row {
    display: flex;
    gap: 0.65rem;
    width: 100%;
    text-align: left;
    padding: 0.55rem 0.75rem;
    border-radius: var(--radius-sm);
    background: transparent;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background var(--transition-fast), border-color var(--transition-fast);
  }
  .chapter-row:hover {
    background: var(--surface-2);
  }
  .chapter-row.active {
    background: var(--surface-2);
    border-color: var(--accent);
    box-shadow: inset 2px 0 0 var(--accent);
  }
  .chapter-row.dirty {
    border-color: var(--warn);
  }
  .num {
    font-family: var(--mono);
    color: var(--accent);
    flex: none;
    min-width: 3.2rem;
    font-size: 0.78rem;
    font-weight: 600;
  }
  .row-body {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }
  .row-title {
    color: var(--text);
    font-size: 0.85rem;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-meta {
    color: var(--text-faint);
    font-size: 0.72rem;
    font-family: var(--mono);
  }
  .chapter-view {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
    flex: 1;
  }
  .view-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border-subtle);
  }
  .view-title {
    font-family: var(--mono);
    font-size: 0.84rem;
    color: var(--text-dim);
    font-weight: 600;
  }
  .view-actions {
    display: flex;
    gap: 0.45rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .dirty-badge {
    font-size: 0.7rem;
    color: var(--warn);
    background: var(--warn-subtle);
    border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
    border-radius: var(--radius-full);
    padding: 0.1rem 0.55rem;
    font-weight: 500;
  }
  .stale-note {
    margin: 0;
    font-size: 0.82rem;
    padding: 0.4rem 0.75rem;
    border-radius: var(--radius-sm);
    background: var(--warn-subtle);
    color: var(--warn);
    border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent);
  }
  .conflict {
    border: 1px solid color-mix(in srgb, var(--danger) 50%, transparent);
    background: var(--danger-subtle);
    border-radius: var(--radius-md);
    padding: 0.8rem 1rem;
  }
  .conflict h4 {
    margin: 0 0 0.3rem;
    color: var(--danger);
    font-size: 0.9rem;
    font-weight: 600;
  }
  .conflict p {
    margin: 0.1rem 0;
    font-size: 0.84rem;
  }
  .conflict-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 0.5rem;
  }
  .engine-content {
    margin-top: 0.35rem;
    max-height: 12rem;
    overflow-y: auto;
    white-space: pre-wrap;
    font-size: 0.82rem;
    color: var(--text-dim);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.75rem;
    font-family: var(--font-serif);
    line-height: 1.6;
  }
  .error-box {
    border: 1px solid color-mix(in srgb, var(--danger) 50%, transparent);
    border-radius: var(--radius-md);
    padding: 0.65rem 0.85rem;
    background: var(--danger-subtle);
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
  .editor {
    width: 100%;
    flex: 1;
    min-height: 22rem;
    resize: vertical;
    font-family: var(--font-serif);
    font-size: 0.95rem;
    line-height: 1.7;
    padding: 1rem 1.15rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  :global([data-testid='chapter-content']) {
    font-family: var(--font-serif);
    font-size: 1.02rem;
    line-height: 1.8;
    max-width: 68ch;
    margin: 0 auto;
    width: 100%;
  }
  :global([data-testid='chapter-content'] p) {
    margin: 0 0 1.15rem;
  }
  :global([data-testid='chapter-content'] h1, [data-testid='chapter-content'] h2) {
    font-family: var(--font-sans);
    letter-spacing: -0.02em;
    margin: 1.5rem 0 0.8rem;
  }
</style>
