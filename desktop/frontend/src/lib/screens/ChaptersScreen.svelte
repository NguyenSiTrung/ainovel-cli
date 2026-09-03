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
        <h3>Chapters</h3>
        <dl class="facts" data-testid="chapters-progress">
          <div><dt>Saved</dt><dd>{list.completed ?? 0}/{list.total ?? snapshot.total_chapters ?? '?'}</dd></div>
          {#if list.inProgress}
            <div><dt>In progress</dt><dd>chapter {list.inProgress}</dd></div>
          {/if}
          {#if list.pendingRewrites}
            <div class="hold"><dt>Rewrites</dt><dd>{list.pendingRewrites} pending</dd></div>
          {/if}
        </dl>

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
            {#each list.items as item (item.chapter ?? 0)}
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
                {dirty ? 'modified — save sends your text with the version you started from (base_version)' : 'unmodified'}
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
    gap: 0.75rem;
    padding: 0.9rem 1rem 1.5rem;
    flex: 1;
    min-height: 0;
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
  .chapters-body {
    display: grid;
    grid-template-columns: minmax(15rem, 22rem) minmax(0, 1fr);
    gap: 0.75rem;
    flex: 1;
    min-height: 22rem;
  }
  .pane {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.7rem 0.85rem;
    overflow-y: auto;
    min-height: 0;
  }
  .pane h3 {
    margin: 0 0 0.6rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
  }
  .meta {
    margin: 0.2rem 0;
    color: var(--text-faint);
    font-size: 0.8rem;
  }
  .meta.error {
    color: var(--danger);
  }
  .facts {
    margin: 0 0 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .facts div {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.8rem;
  }
  .facts dt {
    color: var(--text-faint);
    flex: none;
  }
  .facts dd {
    margin: 0;
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
    gap: 0.3rem;
  }
  .chapter-row {
    display: flex;
    gap: 0.6rem;
    width: 100%;
    text-align: left;
    padding: 0.45rem 0.6rem;
    border-radius: 6px;
    background: transparent;
    border: 1px solid transparent;
    cursor: pointer;
  }
  .chapter-row:hover {
    background: var(--surface-2);
  }
  .chapter-row.active {
    background: var(--surface-2);
    border-color: var(--accent);
  }
  .chapter-row.dirty {
    border-color: var(--warn);
  }
  .num {
    font-family: var(--mono);
    color: var(--accent);
    flex: none;
    min-width: 3rem;
    font-size: 0.78rem;
  }
  .row-body {
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
    min-width: 0;
  }
  .row-title {
    color: var(--text);
    font-size: 0.84rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-meta {
    color: var(--text-faint);
    font-size: 0.7rem;
    font-family: var(--mono);
  }
  .chapter-view {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .view-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .view-title {
    font-family: var(--mono);
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  .view-actions {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .dirty-badge {
    font-size: 0.68rem;
    color: var(--warn);
    border: 1px solid color-mix(in srgb, var(--warn) 55%, transparent);
    border-radius: 999px;
    padding: 0.05rem 0.5rem;
  }
  .stale-note {
    margin: 0;
    font-size: 0.8rem;
    padding: 0.3rem 0.6rem;
    border-radius: 6px;
    background: color-mix(in srgb, var(--warn) 12%, transparent);
    color: var(--warn);
  }
  .conflict {
    border: 1px solid color-mix(in srgb, var(--danger) 50%, transparent);
    background: color-mix(in srgb, var(--danger) 7%, var(--surface-1));
    border-radius: 8px;
    padding: 0.6rem 0.8rem;
  }
  .conflict h4 {
    margin: 0 0 0.25rem;
    color: var(--danger);
    font-size: 0.88rem;
  }
  .conflict p {
    margin: 0.1rem 0;
    font-size: 0.82rem;
  }
  .conflict-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 0.4rem;
  }
  .engine-content {
    margin-top: 0.3rem;
    max-height: 10rem;
    overflow-y: auto;
    white-space: pre-wrap;
    font-size: 0.8rem;
    color: var(--text-dim);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.4rem 0.6rem;
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
  .editor {
    width: 100%;
    resize: vertical;
    font-family: var(--mono);
    font-size: 0.84rem;
    line-height: 1.55;
  }
</style>
