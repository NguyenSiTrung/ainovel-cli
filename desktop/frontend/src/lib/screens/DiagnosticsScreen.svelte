<script lang="ts">
  /**
   * Diagnostics screen (task 8): OBSERVER-ONLY projections of engine health.
   * Findings, runtime view, engine session facts, the persisted runtime event
   * queue, structured-log replay with severity filtering, usage/budget
   * detail, and the sanitized diagnostics export.
   *
   * Binding constraints: no repair/resume/mutate affordances exist here —
   * repairs and resume are explicit user actions elsewhere; the export is a
   * server-sanitized bundle, the UI only contributes a destination path
   * string from the native save dialog; log/config payloads are redacted
   * engine-side and rendered verbatim.
   */
  import { onMount } from 'svelte';

  import {
    diagnosticsState,
    dismissDiagnosticsExport,
    exportDiagnosticsFromUi,
    LOG_LEVEL_FILTERS,
    refreshAllDiagnostics,
    refreshLogs,
    type LogLevelFilter,
  } from '$lib/diagnostics';
  import {
    activity,
    engineState,
    eventBookkeeping,
    projectSnapshot,
    refreshUsage,
    usage,
  } from '$lib/stores/desktop';
  import { presentError } from '$lib/types/protocol';

  let { title, description, owner }: { title: string; description: string; owner: string } = $props();

  let state = $derived($diagnosticsState);
  let snapshot = $derived($projectSnapshot);
  let usageState = $derived($usage);

  let diagError = $derived(state.error ? presentError(state.error.code) : null);
  let exportError = $derived(state.exportFlow.error ? presentError(state.exportFlow.error.code) : null);
  let logsError = $derived(state.logs.error ? presentError(state.logs.error.code) : null);

  // Frontend-side event bookkeeping (session, cursor, duplicates). Derived
  // against $activity/$engineState so it recomputes whenever a new engine
  // fact arrives (every applied event appends an activity entry).
  let bookkeeping = $derived.by(() => {
    void $activity;
    void $engineState;
    return eventBookkeeping();
  });

  let findings = $derived(state.snapshot?.findings ?? []);
  let runtime = $derived(state.snapshot?.runtime);
  let stats = $derived(state.snapshot?.stats);

  // Checkpoints as observed facts: the daemon emits checkpoint.created
  // events (recorded in activity); there is no checkpoint-list method in
  // desktop-v1, so recent observed checkpoints + the snapshot's recovery
  // label are the honest projection.
  let recentCheckpoints = $derived(
    $activity
      .filter((entry) => entry.event === 'checkpoint.created')
      .slice(-5)
      .reverse(),
  );

  onMount(() => {
    if (snapshot !== null) {
      void refreshAllDiagnostics();
      void refreshUsage();
    }
  });

  function levelClass(severity: string | undefined): string {
    switch ((severity ?? '').toLowerCase()) {
      case 'high':
      case 'error':
        return 'sev-high';
      case 'medium':
      case 'warn':
        return 'sev-medium';
      default:
        return 'sev-low';
    }
  }

  function logTime(time: string | undefined): string {
    if (time === undefined) return '';
    const parsed = new Date(time);
    return Number.isNaN(parsed.getTime()) ? time : parsed.toLocaleTimeString();
  }

  function num(value: unknown): string {
    return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';
  }

  /** Loose JSON field rendered as text (payloads are open; never assume). */
  function statString(container: Record<string, unknown> | undefined, key: string): string {
    const value = container?.[key];
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : String(value);
  }

  function usageNumber(container: Record<string, unknown> | undefined, key: string): string {
    const value = container?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : '—';
  }

  /** Per-agent rows are loose JSON; read fields defensively. */
  function agentRow(row: unknown): Record<string, unknown> {
    return typeof row === 'object' && row !== null && !Array.isArray(row)
      ? (row as Record<string, unknown>)
      : {};
  }

  function usageMoney(container: Record<string, unknown> | undefined, key: string): string {
    const value = container?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(2)}` : '—';
  }

  function refreshWithLogs(): void {
    void refreshAllDiagnostics();
    void refreshUsage();
  }

  function changeLogLevel(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement;
    void refreshLogs(select.value as LogLevelFilter);
  }
</script>

<section class="diagnostics-screen screen" data-testid="diagnostics-screen">
  <header class="screen-header">
    <h2>{title}</h2>
    <p class="screen-description">{description} <span class="owner">({owner})</span></p>
  </header>

  {#if snapshot === null}
    <div class="empty-state" data-testid="diagnostics-empty">
      <h3>No project open</h3>
      <p>Diagnostics need an open project — open or create one from the Overview screen.</p>
    </div>
  {:else}
    <p class="observer-note" data-testid="diagnostics-observer-note">
      Read-only view — diagnostics never repair, resume, or change engine state.
    </p>

    <div class="actions-row">
      <button
        type="button"
        onclick={() => refreshWithLogs()}
        disabled={state.status === 'loading'}
        data-testid="diagnostics-refresh"
      >
        Refresh diagnostics
      </button>
      <button
        type="button"
        class="primary"
        onclick={() => exportDiagnosticsFromUi()}
        disabled={state.exportFlow.status !== 'idle'}
        data-testid="diagnostics-export"
      >
        {state.exportFlow.status === 'picking'
          ? 'Choosing destination…'
          : state.exportFlow.status === 'exporting'
            ? 'Exporting sanitized bundle…'
            : 'Export sanitized bundle'}
      </button>
    </div>

    {#if state.exportFlow.error}
      <div class="error-box" data-testid="diagnostics-export-error">
        <p>{exportError?.title} — {state.exportFlow.error.message} <span class="code">[{state.exportFlow.error.code}]</span></p>
        <button type="button" class="small" onclick={() => dismissDiagnosticsExport()} data-testid="diagnostics-export-dismiss-error">
          Dismiss
        </button>
      </div>
    {:else if state.exportFlow.result}
      <div class="result-box" data-testid="diagnostics-export-result">
        <p class="ok">
          Sanitized bundle written{state.exportFlow.result.findings !== undefined
            ? ` (${state.exportFlow.result.findings} findings)`
            : ''}.
        </p>
        <p class="mono path">{state.exportFlow.result.path ?? '—'}</p>
        <button type="button" class="small" onclick={() => dismissDiagnosticsExport()} data-testid="diagnostics-export-dismiss">
          Dismiss
        </button>
      </div>
    {/if}

    {#if state.error}
      <div class="error-box" data-testid="diagnostics-error">
        <p>{diagError?.title} — {state.error.message} <span class="code">[{state.error.code}]</span></p>
        <p class="meta">{diagError?.action ?? ''}</p>
      </div>
    {/if}

    <div class="card-grid">
      <article class="card" data-testid="diagnostics-stats">
        <h3>Project stats</h3>
        <dl class="facts">
          <div><dt>Chapters</dt><dd>{num(stats?.completed_chapters)} / {num(stats?.total_chapters)}</dd></div>
          <div><dt>Words</dt><dd>{num(stats?.total_words)}</dd></div>
          {#if statString(stats, 'phase')}<div><dt>Phase</dt><dd>{statString(stats, 'phase')}</dd></div>{/if}
          {#if statString(stats, 'flow')}<div><dt>Flow</dt><dd>{statString(stats, 'flow')}</dd></div>{/if}
          <div><dt>Avg review score</dt><dd>{num(stats?.avg_review_score)}</dd></div>
          <div><dt>Foreshadow open / stale</dt><dd>{num(stats?.foreshadow_open)} / {num(stats?.foreshadow_stale)}</dd></div>
          <div><dt>Planned actions</dt><dd>{num(state.snapshot?.planned_actions)}</dd></div>
        </dl>
      </article>

      <article class="card" data-testid="diagnostics-runtime">
        <h3>Runtime view</h3>
        <dl class="facts">
          <div><dt>Current step</dt><dd>{statString(runtime, 'current_step') || '—'}</dd></div>
          <div><dt>Stuck step</dt><dd>{statString(runtime, 'stuck_step') || '—'}{num(runtime?.stuck_count) !== '—' ? ` ×${statString(runtime, 'stuck_count')}` : ''}</dd></div>
          <div><dt>Log errors</dt><dd data-testid="diagnostics-log-errors">{num(runtime?.log_errors)}</dd></div>
          <div><dt>Log warnings</dt><dd data-testid="diagnostics-log-warns">{num(runtime?.log_warns)}</dd></div>
          <div><dt>Stop guard</dt><dd>{statString(runtime, 'stop_guard') || '—'}</dd></div>
          <div><dt>Load errors</dt><dd>{runtime?.load_errors === true ? 'yes' : runtime?.load_errors === false ? 'no' : '—'}</dd></div>
        </dl>
        {#if runtime?.models && runtime.models.length > 0}
          <table class="models" data-testid="diagnostics-models">
            <thead><tr><th>Agent</th><th>Provider</th><th>Model</th></tr></thead>
            <tbody>
              {#each runtime.models as row (`${row.agent}-${row.provider}-${row.model}`)}
                <tr>
                  <td>{row.agent ?? '—'}</td>
                  <td>{row.provider ?? '—'}</td>
                  <td>{row.model ?? '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </article>

      <article class="card" data-testid="diagnostics-session">
        <h3>Session &amp; events</h3>
        <dl class="facts">
          <div><dt>Engine session</dt><dd class="mono">{$engineState.session ?? '—'}</dd></div>
          <div><dt>Event session</dt><dd class="mono">{bookkeeping.lastSession ?? '—'}</dd></div>
          <div><dt>Last sequence</dt><dd>{bookkeeping.lastSequence >= 0 ? bookkeeping.lastSequence : '—'}</dd></div>
          <div><dt>Duplicates tolerated</dt><dd>{bookkeeping.duplicatesTolerated}</dd></div>
          <div><dt>Resync pending</dt><dd>{bookkeeping.pendingResync ? 'yes' : 'no'}</dd></div>
          {#if snapshot.recovery_label}
            <div><dt>Recovery</dt><dd>{snapshot.recovery_label}</dd></div>
          {/if}
        </dl>
        {#if recentCheckpoints.length > 0}
          <p class="meta" data-testid="diagnostics-checkpoints">
            recent checkpoints (observed): {recentCheckpoints.map((entry) => entry.summary ?? `#${entry.sequence}`).join(', ')}
          </p>
        {:else}
          <p class="meta">No checkpoint events observed this session.</p>
        {/if}
      </article>

      <article class="card" data-testid="diagnostics-usage">
        <h3>Usage &amp; budget</h3>
        <dl class="facts">
          <div><dt>Input tokens</dt><dd>{usageNumber(usageState.usage, 'input_tokens')}</dd></div>
          <div><dt>Output tokens</dt><dd>{usageNumber(usageState.usage, 'output_tokens')}</dd></div>
          <div><dt>Cache read</dt><dd>{usageNumber(usageState.usage, 'cache_read_tokens')}</dd></div>
          <div><dt>Cache write</dt><dd>{usageNumber(usageState.usage, 'cache_write_tokens')}</dd></div>
          <div><dt>Cost</dt><dd>{usageMoney(usageState.usage, 'cost_usd')}</dd></div>
          <div><dt>Saved (cache)</dt><dd>{usageMoney(usageState.usage, 'saved_usd')}</dd></div>
          <div><dt>Budget limit</dt><dd>{usageMoney(usageState.budget, 'limit_usd')}</dd></div>
          <div><dt>Spent</dt><dd>{usageMoney(usageState.budget, 'spent_usd')}</dd></div>
          {#if usageState.updatedAt}
            <div><dt>Updated</dt><dd>{new Date(usageState.updatedAt).toLocaleTimeString()}</dd></div>
          {/if}
        </dl>
        {#if usageState.perAgent && usageState.perAgent.length > 0}
          <table class="models" data-testid="diagnostics-usage-per-agent">
            <thead><tr><th>Role</th><th>In</th><th>Out</th><th>Cost</th><th>Saved</th></tr></thead>
            <tbody>
              {#each usageState.perAgent as entry (String(agentRow(entry).role) + String(agentRow(entry).input) + String(agentRow(entry).cost_usd))}
                {@const row = agentRow(entry)}
                <tr>
                  <td>{row.role ?? '—'}</td>
                  <td>{num(row.input)}</td>
                  <td>{num(row.output)}</td>
                  <td>{typeof row.cost_usd === 'number' ? `$${row.cost_usd.toFixed(2)}` : '—'}</td>
                  <td>{typeof row.saved_usd === 'number' ? `$${row.saved_usd.toFixed(2)}` : '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </article>
    </div>

    <article class="card" data-testid="diagnostics-findings">
      <h3>Findings ({findings.length})</h3>
      {#if findings.length === 0}
        <p class="meta" data-testid="diagnostics-no-findings">No findings reported.</p>
      {:else}
        <ul class="findings-list">
          {#each findings as finding, index (index)}
            <li class={levelClass(finding.severity)} data-testid="diagnostics-finding">
              <details>
                <summary>
                  <span class="badge">{finding.severity ?? 'info'}</span>
                  <span class="finding-title">{finding.title ?? finding.rule ?? `finding ${index + 1}`}</span>
                  {#if finding.category}<span class="cat">{finding.category}</span>{/if}
                  {#if finding.confidence}<span class="conf">confidence: {finding.confidence}</span>{/if}
                </summary>
                {#if finding.rule}<p class="mono">rule: {finding.rule}</p>{/if}
                {#if finding.evidence}<p class="evidence">{finding.evidence}</p>{/if}
                {#if finding.suggestion}<p class="suggestion">Suggestion: {finding.suggestion}</p>{/if}
              </details>
            </li>
          {/each}
        </ul>
      {/if}
    </article>

    <article class="card" data-testid="diagnostics-queue">
      <h3>Runtime event queue ({state.queue.count ?? state.queue.items.length})</h3>
      {#if state.queue.error}
        <div class="error-box">
          <p>{presentError(state.queue.error.code).title} — {state.queue.error.message} <span class="code">[{state.queue.error.code}]</span></p>
        </div>
      {:else if state.queue.items.length === 0}
        <p class="meta" data-testid="diagnostics-queue-empty">Queue empty.</p>
      {:else}
        <ul class="queue-list" data-testid="diagnostics-queue-items">
          {#each state.queue.items as item (item.seq ?? JSON.stringify(item))}
            <li>
              <span class="seq">{item.seq ?? '·'}</span>
              {#if item.priority}<span class="badge">{item.priority}</span>{/if}
              {#if item.agent}<span class="agent">{item.agent}</span>{/if}
              <span class="summary">{item.summary ?? ''}</span>
              {#if item.category}<span class="cat">{item.category}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </article>

    <article class="card" data-testid="diagnostics-logs">
      <h3>Structured logs</h3>
      <div class="logs-controls">
        <label>
          minimum severity
          <select value={state.logs.level} onchange={changeLogLevel} data-testid="diagnostics-logs-level">
            {#each LOG_LEVEL_FILTERS as level (level)}
              <option value={level}>{level === '' ? 'all' : level}</option>
            {/each}
          </select>
        </label>
        <button
          type="button"
          onclick={() => refreshLogs()}
          disabled={state.logs.status === 'loading'}
          data-testid="diagnostics-logs-refresh"
        >
          Replay logs
        </button>
        <span class="meta">
          {state.logs.count ?? state.logs.records.length} records{state.logs.lastSequence !== undefined ? ` · ring cursor ${state.logs.lastSequence}` : ''}
        </span>
      </div>
      {#if logsError}
        <div class="error-box">
          <p>{logsError.title} — {state.logs.error?.message} <span class="code">[{state.logs.error?.code}]</span></p>
        </div>
      {:else if state.logs.records.length === 0}
        <p class="meta" data-testid="diagnostics-logs-empty">No log records buffered.</p>
      {:else}
        <ul class="log-list" data-testid="diagnostics-logs-records">
          {#each state.logs.records as record (record.sequence ?? JSON.stringify(record))}
            <li class="log-{(record.level ?? 'info').toLowerCase()}">
              <details>
                <summary>
                  <span class="seq">{record.sequence ?? '·'}</span>
                  <span class="badge">{record.level ?? 'info'}</span>
                  <span class="module">{record.module ?? ''}</span>
                  <span class="message">{record.message ?? ''}</span>
                  <span class="time">{logTime(record.time)}</span>
                </summary>
                <p class="mono">{JSON.stringify(record, null, 2)}</p>
              </details>
            </li>
          {/each}
        </ul>
      {/if}
      <p class="meta">Records arrive redacted from the engine; the full record expands in place.</p>
    </article>
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
    overflow-y: auto;
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
  .observer-note {
    margin: 0;
    font-size: 0.82rem;
    color: var(--text-dim);
    border: 1px dashed var(--border);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.85rem;
    background: var(--surface-1);
  }
  .actions-row {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }
  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
    gap: 0.85rem;
  }
  .card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1.1rem 1.25rem;
    min-width: 0;
    box-shadow: var(--shadow-sm);
  }
  .card h3 {
    margin: 0 0 0.75rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    font-weight: 700;
  }
  .facts {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.65rem 0.8rem;
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
    font-weight: 500;
  }
  .mono {
    font-family: var(--mono);
    font-size: 0.76rem;
  }
  .models {
    width: 100%;
    border-collapse: collapse;
    margin-top: 0.65rem;
    font-size: 0.76rem;
    font-family: var(--mono);
  }
  .models th,
  .models td {
    text-align: left;
    padding: 0.35rem 0.45rem;
    border-top: 1px solid var(--border-subtle);
    overflow-wrap: anywhere;
  }
  .models th {
    color: var(--text-dim);
    font-weight: 600;
  }
  .findings-list,
  .queue-list,
  .log-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    max-height: 24rem;
    overflow-y: auto;
  }
  .findings-list li {
    border-left: 3px solid var(--border);
    border-radius: var(--radius-xs);
    padding: 0.45rem 0.7rem;
    background: var(--surface-2);
    font-size: 0.84rem;
  }
  .findings-list li.sev-high {
    border-left-color: var(--danger);
    background: color-mix(in srgb, var(--danger) 6%, var(--surface-2));
  }
  .findings-list li.sev-medium {
    border-left-color: var(--warn);
    background: color-mix(in srgb, var(--warn) 6%, var(--surface-2));
  }
  .findings-list li.sev-low {
    border-left-color: var(--accent);
  }
  .findings-list summary {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    flex-wrap: wrap;
  }
  .finding-title {
    font-weight: 600;
  }
  .cat,
  .conf {
    color: var(--text-faint);
    font-size: 0.74rem;
  }
  .evidence {
    margin: 0.45rem 0 0;
    color: var(--text-dim);
    font-size: 0.8rem;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--mono);
    padding: 0.4rem 0.6rem;
    background: var(--surface-3);
    border-radius: var(--radius-xs);
  }
  .suggestion {
    margin: 0.35rem 0 0.2rem;
    color: var(--ok);
    font-size: 0.82rem;
    font-weight: 500;
  }
  .badge {
    display: inline-block;
    padding: 0.1rem 0.5rem;
    border-radius: var(--radius-full);
    border: 1px solid var(--border);
    font-size: 0.68rem;
    text-transform: uppercase;
    color: var(--text-dim);
    font-family: var(--mono);
    font-weight: 600;
  }
  .queue-list li {
    display: flex;
    gap: 0.65rem;
    font-family: var(--mono);
    font-size: 0.78rem;
    align-items: baseline;
    padding: 0.25rem 0.4rem;
    border-radius: var(--radius-xs);
  }
  .queue-list li:hover {
    background: var(--surface-2);
  }
  .queue-list .seq {
    color: var(--text-faint);
    min-width: 2.5rem;
    text-align: right;
  }
  .queue-list .agent {
    color: var(--accent);
    white-space: nowrap;
    font-weight: 500;
  }
  .queue-list .summary {
    color: var(--text-dim);
    overflow-wrap: anywhere;
  }
  .logs-controls {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
    margin-bottom: 0.65rem;
  }
  .logs-controls label {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-size: 0.8rem;
    color: var(--text-dim);
  }
  .logs-controls select {
    font-size: 0.8rem;
  }
  .log-list li {
    background: var(--surface-2);
    border-radius: var(--radius-xs);
    padding: 0.35rem 0.65rem;
    font-family: var(--mono);
    font-size: 0.76rem;
    transition: background var(--transition-fast);
  }
  .log-list li:hover {
    background: var(--surface-3);
  }
  .log-error .badge {
    border-color: var(--danger);
    color: var(--danger);
    background: var(--danger-subtle);
  }
  .log-warn .badge {
    border-color: var(--warn);
    color: var(--warn);
    background: var(--warn-subtle);
  }
  .log-list summary {
    display: flex;
    gap: 0.6rem;
    cursor: pointer;
    align-items: baseline;
  }
  .log-list .seq {
    color: var(--text-faint);
    min-width: 2.2rem;
    text-align: right;
  }
  .log-list .module {
    color: var(--accent);
    white-space: nowrap;
    font-weight: 500;
  }
  .log-list .message {
    color: var(--text-dim);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .log-list .time {
    color: var(--text-faint);
    white-space: nowrap;
  }
  .log-list details[open] .message {
    white-space: normal;
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
  .result-box {
    border: 1px solid color-mix(in srgb, var(--ok) 50%, transparent);
    background: var(--ok-subtle);
    border-radius: var(--radius-sm);
    padding: 0.65rem 0.85rem;
    font-size: 0.84rem;
  }
  .result-box .ok {
    color: var(--ok);
    margin: 0.1rem 0;
    font-weight: 600;
  }
  .result-box .path {
    margin: 0.1rem 0;
    overflow-wrap: anywhere;
    font-family: var(--mono);
  }
  .code {
    font-family: var(--mono);
    font-size: 0.72rem;
  }
  .meta {
    margin: 0.25rem 0 0;
    color: var(--text-faint);
    font-size: 0.8rem;
  }
  button.small {
    font-size: 0.75rem;
    padding: 0.2rem 0.65rem;
    margin-top: 0.35rem;
    border-radius: var(--radius-full);
  }
</style>
