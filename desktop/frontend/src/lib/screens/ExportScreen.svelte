<script lang="ts">
  /**
   * Export screen: chapter-range and whole-book export through the engine
   * (chapter.export — synchronous local IO engine-side; the frontend never
   * touches the filesystem). The destination comes from the native save
   * dialog (a path string forwarded verbatim); formats are the engine's
   * txt/epub. Results show path/bytes/chapters/skipped; failures surface the
   * structured error. A cancelled picker sends nothing and is not an error.
   */
  import { dismissExportResult, exportState, formatBytes, runExport, type ExportFormat, type ExportScopeMode } from '$lib/exportBook';
  import { projectSnapshot } from '$lib/stores/desktop';
  import { chapterListState, refreshChapterList } from '$lib/chapters';
  import { presentError } from '$lib/types/protocol';
  import { onMount } from 'svelte';

  let { title, description, owner }: { title: string; description: string; owner: string } = $props();

  let snapshot = $derived($projectSnapshot);
  let list = $derived($chapterListState);
  let flow = $derived($exportState);

  let mode = $state<ExportScopeMode>('book');
  let format = $state<ExportFormat>('txt');
  let from = $state(1);
  let to = $state(1);

  let errorPresentation = $derived(flow.error ? presentError(flow.error.code) : null);

  // Known chapter bounds guide the range inputs (engine data, not guesses).
  onMount(() => {
    if (snapshot !== null && list.items.length === 0) void refreshChapterList();
  });

  let maxChapter = $derived.by(() => {
    const fromList = list.items.length > 0 ? (list.items[list.items.length - 1]?.chapter ?? 0) : 0;
    return Math.max(fromList, snapshot?.total_chapters ?? 0, 1);
  });

  let rangeValid = $derived(
    Number.isInteger(from) && Number.isInteger(to) && from >= 1 && to >= from && to <= 100000,
  );
  let canExport = $derived(flow.status === 'idle' && (mode === 'book' || rangeValid));

  let scopeLabel = $derived(
    mode === 'book' ? 'the whole book' : `chapters ${from}–${to}`,
  );
</script>

<section class="export-screen screen" data-testid="export-screen">
  <header class="screen-header">
    <h2>{title}</h2>
    <p class="screen-description">{description} <span class="owner">({owner})</span></p>
  </header>

  {#if snapshot === null}
    <div class="empty-state" data-testid="export-empty">
      <h3>No project open</h3>
      <p>Open or create a project from the Overview screen to export it.</p>
    </div>
  {:else}
    <div class="export-layout">
      <section class="pane form-pane" data-testid="export-form">
        <h3>What to export</h3>
        <div class="mode-toggle" data-testid="export-mode">
          <button
            type="button"
            class="segment"
            class:active={mode === 'book'}
            onclick={() => (mode = 'book')}
            data-testid="export-mode-book"
          >
            Whole book
          </button>
          <button
            type="button"
            class="segment"
            class:active={mode === 'range'}
            onclick={() => (mode = 'range')}
            data-testid="export-mode-range"
          >
            Chapter range
          </button>
        </div>

        {#if mode === 'range'}
          <div class="range-row" data-testid="export-range-inputs">
            <label>
              from
              <input
                type="number"
                min="1"
                max={maxChapter}
                bind:value={from}
                data-testid="export-from"
              />
            </label>
            <label>
              to
              <input
                type="number"
                min={from}
                max={maxChapter}
                bind:value={to}
                data-testid="export-to"
              />
            </label>
            {#if !rangeValid}
              <span class="range-warn" data-testid="export-range-invalid">enter a valid chapter range</span>
            {/if}
          </div>
          <p class="meta">
            Chapters outside the saved range are skipped by the engine ({list.completed ?? snapshot.completed_chapters ?? 0} saved).
          </p>
        {/if}

        <h3 class="form-gap">Format</h3>
        <div class="mode-toggle" data-testid="export-format">
          <button
            type="button"
            class="segment"
            class:active={format === 'txt'}
            onclick={() => (format = 'txt')}
            data-testid="export-format-txt"
          >
            Plain text (.txt)
          </button>
          <button
            type="button"
            class="segment"
            class:active={format === 'epub'}
            onclick={() => (format = 'epub')}
            data-testid="export-format-epub"
          >
            EPUB (.epub)
          </button>
        </div>

        <button
          type="button"
          class="primary big"
          onclick={() => runExport({ mode, format, from, to })}
          disabled={!canExport}
          data-testid="export-run"
        >
          {flow.status === 'picking'
            ? 'Choosing destination…'
            : flow.status === 'exporting'
              ? 'Exporting…'
              : `Export ${scopeLabel} as ${format.toUpperCase()}`}
        </button>
        <p class="meta">You will choose where to save the file; the engine writes it directly.</p>
      </section>

      <section class="pane result-pane" data-testid="export-result-pane">
        <h3>Result</h3>
        {#if flow.status === 'picking'}
          <p class="meta" data-testid="export-picking">waiting for the destination picker…</p>
        {:else if flow.status === 'exporting'}
          <p class="meta" data-testid="export-inflight">the engine is writing the file…</p>
        {:else if flow.error}
          <div class="error-box" data-testid="export-error">
            <p>{errorPresentation?.title} — {flow.error.message} <span class="code">[{flow.error.code}]</span></p>
            <p class="meta">{errorPresentation?.action ?? ''}</p>
            <button type="button" class="small" onclick={() => dismissExportResult()} data-testid="export-dismiss-error">
              Dismiss
            </button>
          </div>
        {:else if flow.result}
          <div class="result" data-testid="export-result">
            <p class="ok">Export complete.</p>
            <dl class="result-facts">
              <div><dt>File</dt><dd data-testid="export-result-path">{flow.result.path ?? '—'}</dd></div>
              <div><dt>Size</dt><dd data-testid="export-result-bytes">{formatBytes(flow.result.bytes)}</dd></div>
              <div>
                <dt>Chapters</dt>
                <dd data-testid="export-result-chapters">{flow.result.chapters ?? '—'}</dd>
              </div>
              {#if flow.result.skipped && flow.result.skipped.length > 0}
                <div>
                  <dt>Skipped</dt>
                  <dd data-testid="export-result-skipped">{flow.result.skipped.join(', ')}</dd>
                </div>
              {/if}
              <div><dt>Format</dt><dd>{flow.result.format}</dd></div>
            </dl>
            <button type="button" class="small" onclick={() => dismissExportResult()} data-testid="export-dismiss">
              Dismiss
            </button>
          </div>
        {:else}
          <p class="meta" data-testid="export-no-result">No export run yet.</p>
        {/if}
      </section>
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
  .export-layout {
    display: grid;
    grid-template-columns: minmax(16rem, 24rem) minmax(14rem, 1fr);
    gap: 0.75rem;
    align-items: start;
  }
  .pane {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.8rem 0.9rem;
  }
  .pane h3 {
    margin: 0 0 0.6rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
  }
  .pane .form-gap {
    margin-top: 0.9rem;
  }
  .mode-toggle {
    display: flex;
    gap: 0.4rem;
    margin-bottom: 0.6rem;
  }
  .segment {
    font-size: 0.8rem;
    padding: 0.25rem 0.8rem;
    border-radius: 999px;
  }
  .segment.active {
    background: var(--surface-3);
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }
  .range-row {
    display: flex;
    gap: 0.8rem;
    align-items: center;
    margin-bottom: 0.3rem;
  }
  .range-row label {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.8rem;
    color: var(--text-dim);
  }
  .range-row input {
    width: 5rem;
  }
  .range-warn {
    color: var(--warn);
    font-size: 0.75rem;
  }
  .meta {
    margin: 0.25rem 0;
    color: var(--text-faint);
    font-size: 0.78rem;
  }
  .big {
    margin-top: 0.7rem;
    padding: 0.5rem 1rem;
    font-size: 0.9rem;
  }
  .result .ok {
    color: var(--ok);
    margin: 0 0 0.4rem;
    font-size: 0.9rem;
  }
  .result-facts {
    margin: 0 0 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .result-facts div {
    display: flex;
    justify-content: space-between;
    gap: 0.6rem;
    font-size: 0.82rem;
  }
  .result-facts dt {
    color: var(--text-faint);
    flex: none;
  }
  .result-facts dd {
    margin: 0;
    text-align: right;
    overflow-wrap: anywhere;
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
    margin-top: 0.3rem;
  }
</style>
