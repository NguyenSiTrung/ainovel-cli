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
  .export-layout {
    display: grid;
    grid-template-columns: minmax(18rem, 26rem) minmax(16rem, 1fr);
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
  }
  .pane .form-gap {
    margin-top: 1.15rem;
  }
  .mode-toggle {
    display: flex;
    gap: 0.45rem;
    margin-bottom: 0.75rem;
    background: var(--surface-2);
    padding: 0.2rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
    width: fit-content;
  }
  .segment {
    font-size: 0.78rem;
    padding: 0.25rem 0.8rem;
    border-radius: var(--radius-full);
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-dim);
  }
  .segment.active {
    background: var(--surface-3);
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
    color: var(--accent);
    font-weight: 600;
  }
  .range-row {
    display: flex;
    gap: 0.85rem;
    align-items: center;
    margin-bottom: 0.45rem;
  }
  .range-row label {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  .range-row input {
    width: 5.5rem;
    font-family: var(--mono);
    padding: 0.3rem 0.5rem;
  }
  .range-warn {
    color: var(--warn);
    font-size: 0.75rem;
    font-weight: 500;
  }
  .meta {
    margin: 0.3rem 0;
    color: var(--text-faint);
    font-size: 0.8rem;
    line-height: 1.45;
  }
  .big {
    margin-top: 1rem;
    padding: 0.65rem 1.25rem;
    font-size: 0.9rem;
    font-weight: 600;
    width: 100%;
  }
  .result .ok {
    color: var(--ok);
    margin: 0 0 0.5rem;
    font-size: 0.92rem;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .result-facts {
    margin: 0 0 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.75rem 0.85rem;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
  }
  .result-facts div {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: 0.82rem;
  }
  .result-facts dt {
    color: var(--text-dim);
    flex: none;
  }
  .result-facts dd {
    margin: 0;
    text-align: right;
    overflow-wrap: anywhere;
    font-family: var(--mono);
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
    margin-top: 0.4rem;
    border-radius: var(--radius-full);
  }
</style>
