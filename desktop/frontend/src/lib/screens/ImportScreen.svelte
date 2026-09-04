<script lang="ts">
  /**
   * Import screen: bring an existing text into the project.
   *
   * The source is a native-picked FILE (the engine decodes UTF-8/BOM/GB18030
   * text; directories are not import sources). `import.start` is an
   * acceptance; progress and the structural terminals (stage:"done" /
   * payload error) arrive as import.progress events. Desktop has no
   * interactive confirm channel, so auto_confirm defaults on and the engine's
   * awaiting stages display their detail verbatim. Published chapters are
   * durable facts and appear via the snapshot refresh — the pane here shows
   * the import flow itself.
   */
  import {
    cancelImportFromUi,
    deriveImportControls,
    dismissImportResult,
    importState,
    resumeImportFromUi,
    startImportFromUi,
    type ImportOptions,
  } from '$lib/imports';
  import { connectionState, projectSnapshot } from '$lib/stores/desktop';
  import { presentError } from '$lib/types/protocol';

  let { title, description, owner }: { title: string; description: string; owner: string } = $props();

  let snapshot = $derived($projectSnapshot);
  let flow = $derived($importState);
  let avail = $derived(deriveImportControls(flow, snapshot, $connectionState));

  let autoConfirm = $state(true);
  let continueAfter = $state(false);
  let storyResolution = $state<'unspecified' | 'open' | 'closed'>('unspecified');
  let guidance = $state('');

  let errorPresentation = $derived(flow.error ? presentError(flow.error.code) : null);
  let statusLabel = $derived(
    {
      idle: 'idle',
      picking: 'choosing source…',
      starting: 'requesting…',
      resuming: 'resuming workspace…',
      running: 'importing…',
      completed: 'completed',
      failed: 'failed',
      cancelled: 'cancelled',
      interrupted: 'interrupted',
    }[flow.status],
  );

  function options(): ImportOptions {
    return {
      auto_confirm: autoConfirm,
      continue_after: continueAfter,
      ...(storyResolution === 'unspecified' ? {} : { story_resolution: storyResolution }),
      ...(guidance.trim() === '' ? {} : { guidance: guidance.trim() }),
    };
  }
</script>

<section class="import-screen screen" data-testid="import-screen">
  <header class="screen-header">
    <h2>{title}</h2>
    <p class="screen-description">{description} <span class="owner">({owner})</span></p>
  </header>

  {#if snapshot === null}
    <div class="empty-state" data-testid="import-empty">
      <h3>No project open</h3>
      <p>Open or create a project from the Overview screen to import into it.</p>
    </div>
  {:else}
    <p class="staged-banner" data-testid="import-staged-note">
      <span class="staged-badge">staged</span>
      Progress below is the import pipeline; the book's chapters change only when the engine publishes them (durable).
    </p>

    <div class="import-layout">
      <section class="pane form-pane" data-testid="import-form">
        <h3>Source</h3>
        <button
          type="button"
          class="primary big"
          onclick={() => startImportFromUi(options())}
          disabled={!avail.canStart}
          data-testid="import-run"
        >
          {flow.status === 'picking'
            ? 'Choosing source…'
            : flow.status === 'starting'
              ? 'Starting import…'
              : 'Choose text file & import'}
        </button>
        <p class="meta">
          A single text file (UTF-8 / UTF-8 BOM / GB18030). The engine reads it directly; this app never touches the filesystem.
        </p>

        <h3 class="form-gap">Engine options</h3>
        <label class="option-row" data-testid="import-option-auto-confirm">
          <input type="checkbox" bind:checked={autoConfirm} />
          <span>
            Auto-confirm segmentation
            <span class="meta-inline">desktop has no interactive confirm channel; unchecked imports hold for review</span>
          </span>
        </label>
        <label class="option-row" data-testid="import-option-continue">
          <input type="checkbox" bind:checked={continueAfter} />
          <span>Continue into a writing run when the import completes</span>
        </label>
        <label class="option-row" data-testid="import-option-story">
          <span>Story status</span>
          <select bind:value={storyResolution} data-testid="import-option-story-select">
            <option value="unspecified">let the engine decide</option>
            <option value="open">open (continues)</option>
            <option value="closed">closed (complete)</option>
          </select>
        </label>
        <label class="option-row" data-testid="import-option-guidance">
          <span>Guidance</span>
          <input
            type="text"
            placeholder="optional segmentation guidance…"
            bind:value={guidance}
            data-testid="import-option-guidance-input"
          />
        </label>

        <div class="actions">
          <button
            type="button"
            onclick={() => resumeImportFromUi()}
            disabled={!avail.canResume}
            data-testid="import-resume"
          >
            {flow.status === 'resuming' ? 'Resuming…' : 'Resume import workspace'}
          </button>
          <button
            type="button"
            onclick={() => cancelImportFromUi()}
            disabled={!avail.canCancel}
            data-testid="import-cancel"
          >
            {flow.pendingCancel ? 'Cancelling…' : 'Cancel import'}
          </button>
        </div>
        {#if !avail.engineReady}
          <p class="meta">Engine not connected — controls unlock when it is ready.</p>
        {/if}
      </section>

      <section class="pane result-pane" data-testid="import-progress-pane">
        <h3>
          Progress
          <span class="status" data-testid="import-status">{statusLabel}</span>
        </h3>

        {#if flow.sourcePath !== null}
          <p class="meta" data-testid="import-source">source: {flow.sourcePath === '' ? 'active workspace (resume)' : flow.sourcePath}</p>
        {/if}

        {#if flow.progress}
          <dl class="fact-list" data-testid="import-progress">
            {#if flow.progress.stage}<div><dt>Stage</dt><dd>{flow.progress.stage}</dd></div>{/if}
            {#if flow.progress.total !== undefined}
              <div><dt>Units</dt><dd>{flow.progress.completed ?? 0}/{flow.progress.total}</dd></div>
            {/if}
            {#if flow.progress.detail}<div class="detail"><dt>Detail</dt><dd>{flow.progress.detail}</dd></div>{/if}
          </dl>
        {/if}

        {#if flow.recent.length > 0}
          <ul class="recent" data-testid="import-recent">
            {#each flow.recent as line, i (i)}
              <li class:x={line.level === 'warn'}>
                {#if line.stage}<span class="stage">{line.stage}</span>{/if}
                <span class="detail">{line.detail ?? (line.total !== undefined ? `${line.completed ?? 0}/${line.total}` : '')}</span>
              </li>
            {/each}
          </ul>
        {/if}

        {#if flow.error}
          <div class="error-box" data-testid="import-error">
            <p>{errorPresentation?.title} — {flow.error.message} <span class="code">[{flow.error.code}]</span></p>
            {#if errorPresentation?.action}<p class="meta">{errorPresentation.action}</p>{/if}
            <button type="button" class="small" onclick={() => dismissImportResult()} data-testid="import-dismiss-error">
              Dismiss
            </button>
          </div>
        {:else if flow.status === 'completed'}
          <div class="result" data-testid="import-result">
            <p class="ok">Import completed — foundation and chapters published.</p>
            {#if flow.result?.continued}
              <p class="meta" data-testid="import-result-continued">the engine continued into a writing run</p>
            {/if}
            <p class="meta">Published chapters are durable project facts — see the Chapters screen.</p>
            <button type="button" class="small" onclick={() => dismissImportResult()} data-testid="import-dismiss">
              Dismiss
            </button>
          </div>
        {:else if flow.message}
          <p class="meta" data-testid="import-message">{flow.message}</p>
        {:else if flow.status === 'idle'}
          <p class="meta" data-testid="import-no-result">No import run yet.</p>
        {/if}
      </section>

      <aside class="pane facts-pane" data-testid="import-facts">
        <h3>Project facts <span class="durable-badge">durable</span></h3>
        <dl class="fact-list">
          <div><dt>Book</dt><dd>{snapshot.book_title ?? '—'}</dd></div>
          <div><dt>Chapters</dt><dd>{snapshot.completed_chapters ?? 0}/{snapshot.total_chapters ?? '?'}</dd></div>
          <div><dt>Words</dt><dd>{snapshot.total_word_count?.toLocaleString() ?? '—'}</dd></div>
        </dl>
        <p class="meta">Refreshed from the engine snapshot after publication — never guessed locally.</p>
      </aside>
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
  .staged-banner {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 0;
    padding: 0.5rem 0.85rem;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  .staged-badge,
  .durable-badge {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    border-radius: var(--radius-full);
    padding: 0.1rem 0.55rem;
    font-weight: 600;
    white-space: nowrap;
  }
  .staged-badge {
    border: 1px solid color-mix(in srgb, var(--warn) 55%, transparent);
    background: var(--warn-subtle);
    color: var(--warn);
  }
  .durable-badge {
    border: 1px solid color-mix(in srgb, var(--ok) 55%, transparent);
    background: var(--ok-subtle);
    color: var(--ok);
  }
  .import-layout {
    display: grid;
    grid-template-columns: minmax(18rem, 24rem) minmax(16rem, 1fr) minmax(13rem, 16rem);
    gap: 0.85rem;
    align-items: start;
  }
  .pane {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1.1rem 1.25rem;
    box-shadow: var(--shadow-sm);
  }
  .pane h3 {
    margin: 0 0 0.75rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .pane .form-gap {
    margin-top: 1.15rem;
  }
  .status {
    font-size: 0.7rem;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    padding: 0.05rem 0.55rem;
    text-transform: none;
    letter-spacing: 0;
    font-weight: 500;
  }
  .meta {
    margin: 0.3rem 0;
    color: var(--text-faint);
    font-size: 0.8rem;
    line-height: 1.45;
  }
  .meta-inline {
    display: block;
    color: var(--text-faint);
    font-size: 0.74rem;
    margin-top: 0.15rem;
  }
  .big {
    padding: 0.65rem 1.25rem;
    font-size: 0.9rem;
    font-weight: 600;
    width: 100%;
  }
  .option-row {
    display: flex;
    align-items: baseline;
    gap: 0.55rem;
    font-size: 0.82rem;
    margin-bottom: 0.55rem;
    color: var(--text-dim);
  }
  .option-row select,
  .option-row input[type='text'] {
    flex: 1;
    min-width: 0;
    font-size: 0.82rem;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 0.75rem;
  }
  .fact-list {
    margin: 0 0 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.65rem 0.8rem;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
  }
  .fact-list div {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: 0.82rem;
  }
  .fact-list div.detail dd {
    white-space: normal;
  }
  .fact-list dt {
    color: var(--text-dim);
    flex: none;
  }
  .fact-list dd {
    margin: 0;
    text-align: right;
    overflow-wrap: anywhere;
    font-weight: 500;
  }
  .recent {
    list-style: none;
    margin: 0.5rem 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-family: var(--mono);
    font-size: 0.74rem;
    max-height: 12rem;
    overflow-y: auto;
  }
  .recent li {
    display: flex;
    gap: 0.5rem;
    color: var(--text-dim);
    padding: 0.2rem 0.4rem;
    border-radius: var(--radius-xs);
    background: var(--surface-2);
  }
  .recent li.x {
    color: var(--warn);
  }
  .recent .stage {
    color: var(--accent);
    min-width: 8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .recent .detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .result .ok {
    color: var(--ok);
    margin: 0 0 0.4rem;
    font-size: 0.9rem;
    font-weight: 600;
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
    padding: 0.2rem 0.65rem;
    margin-top: 0.35rem;
    border-radius: var(--radius-full);
  }
</style>
