<script lang="ts">
  /**
   * Overview screen: project identity, progress (chapters/phase from the
   * engine snapshot), runtime status, recovery state, budget indicator,
   * usage, recent activity, last errors, and the primary actions
   * (RunControls + project lifecycle). Pure projection of store state; the
   * engine snapshot and run.* events are the only sources.
   */
  import MarkdownView from '$lib/components/MarkdownView.svelte';
  import ProjectActions from '$lib/components/ProjectActions.svelte';
  import RunControls from '$lib/components/RunControls.svelte';
  import {
    activity,
    connectionState,
    engineState,
    notifications,
    projectSnapshot,
    runState,
    snapshotError,
    usage,
  } from '$lib/stores/desktop';

  let { title, description, owner }: { title: string; description: string; owner: string } = $props();

  let snapshot = $derived($projectSnapshot);
  let run = $derived($runState);
  let totals = $derived($usage.totals);

  let chapterLabel = $derived.by(() => {
    if (!snapshot) return '';
    const done = snapshot.completed_chapters ?? 0;
    const total = snapshot.total_chapters;
    return total !== undefined ? `${done}/${total}` : `${done}`;
  });
  let chapterPercent = $derived.by(() => {
    if (!snapshot?.total_chapters) return null;
    return Math.round(((snapshot.completed_chapters ?? 0) / snapshot.total_chapters) * 100);
  });
  let budgetPercent = $derived.by(() => {
    const cost = totals?.costUsd ?? snapshot?.total_cost_usd;
    const limit = totals?.budgetLimitUsd ?? snapshot?.budget_limit_usd;
    if (cost === undefined || limit === undefined || limit <= 0) return null;
    return Math.min(100, Math.round((cost / limit) * 100));
  });
  let budgetLabel = $derived.by(() => {
    const cost = totals?.costUsd ?? snapshot?.total_cost_usd;
    const limit = totals?.budgetLimitUsd ?? snapshot?.budget_limit_usd;
    if (cost === undefined) return null;
    const costText = `$${cost.toFixed(2)}`;
    return limit !== undefined && limit > 0 ? `${costText} of $${limit.toFixed(2)}` : costText;
  });
  let recentActivity = $derived($activity.slice(-10).reverse());
  let lastErrors = $derived($notifications.filter((n) => n.level === 'error').slice(-5).reverse());
  let wordCount = $derived(snapshot?.total_word_count);
</script>

<section class="overview-screen screen" data-testid="overview-screen">
  <header class="screen-header">
    <h2>{title}</h2>
    <p class="screen-description">{description} <span class="owner">({owner})</span></p>
  </header>

  <!-- Mounted once, outside the branches, so its local state (busy flags,
       validation hints) survives the empty-state -> project-open flip. -->
  <ProjectActions />

  {#if snapshot === null}
    <div class="empty-state" data-testid="overview-empty">
      <div class="empty-icon-circle">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" />
          <path d="M6 6h10" />
          <path d="M6 10h10" />
        </svg>
      </div>
      <h3>No project open</h3>
      <p>Create a new novel project or open an existing folder to begin.</p>
      {#if $snapshotError}
        <p class="snapshot-error" data-testid="overview-snapshot-error">
          Last snapshot attempt failed ({$snapshotError.code}) — the engine stays authoritative.
        </p>
      {/if}
    </div>
  {:else}
    <div class="card-grid">
      <article class="card identity hero-card" data-testid="overview-identity">
        <div class="card-header-row">
          <h3>Project</h3>
          {#if snapshot.status_label ?? snapshot.state}
            <span class="meta status-badge">{snapshot.status_label ?? snapshot.state}</span>
          {/if}
        </div>
        <p class="book-title">{snapshot.book_title ?? 'Untitled project'}</p>
        {#if snapshot.synopsis ?? snapshot.premise}
          <div class="synopsis">
            <MarkdownView text={String(snapshot.synopsis ?? snapshot.premise)} testid="overview-synopsis" />
          </div>
        {/if}
        <dl class="facts">
          {#if snapshot.phase}
            <div><dt>Phase</dt><dd>{snapshot.phase}</dd></div>
          {/if}
          {#if snapshot.flow}
            <div><dt>Flow</dt><dd>{snapshot.flow}</dd></div>
          {/if}
          {#if snapshot.provider ?? snapshot.model}
            <div><dt>Model</dt><dd>{snapshot.provider ?? '?'} / {snapshot.model ?? '?'}</dd></div>
          {/if}
          {#if snapshot.current_volume_arc}
            <div><dt>Volume arc</dt><dd>{snapshot.current_volume_arc}</dd></div>
          {/if}
        </dl>
      </article>

      <article class="card progress" data-testid="overview-progress">
        <h3>Progress</h3>
        <div class="progress-metric-row">
          <p class="big-number" data-testid="overview-chapters">{chapterLabel}</p>
          <p class="meta">chapters written</p>
        </div>
        {#if chapterPercent !== null}
          <div class="bar"><div class="fill" style="width: {chapterPercent}%"></div></div>
        {/if}
        <dl class="facts">
          {#if snapshot.current_chapter !== undefined || snapshot.in_progress_chapter !== undefined}
            <div><dt>Current</dt><dd>chapter {snapshot.in_progress_chapter ?? snapshot.current_chapter}</dd></div>
          {/if}
          {#if wordCount !== undefined}
            <div><dt>Words</dt><dd data-testid="overview-words">{wordCount.toLocaleString()}</dd></div>
          {/if}
          {#if snapshot.pending_rewrites !== undefined}
            <div><dt>Pending rewrites</dt><dd>{snapshot.pending_rewrites}</dd></div>
          {/if}
          {#if run.status === 'running' && run.progress?.total !== undefined}
            <div><dt>Run</dt><dd>{run.progress.completed ?? 0}/{run.progress.total} {run.progress.detail ?? ''}</dd></div>
          {/if}
        </dl>
      </article>

      <article class="card runtime" data-testid="overview-runtime">
        <h3>Runtime</h3>
        <dl class="facts">
          <div><dt>Connection</dt><dd><span class="badge ok">{$connectionState}</span></dd></div>
          <div><dt>Engine</dt><dd>{$engineState.health}{$engineState.status ? ` · ${$engineState.status}` : ''}</dd></div>
          {#if $engineState.session}
            <div><dt>Session</dt><dd class="mono">{$engineState.session}</dd></div>
          {/if}
          <div><dt>Run</dt><dd data-testid="overview-run-status">{run.status}{run.step ? ` · ${run.step}` : ''}</dd></div>
          {#if snapshot.running !== undefined}
            <div><dt>Engine says</dt><dd>{snapshot.running ? 'running' : 'not running'}</dd></div>
          {/if}
        </dl>
        {#if run.terminal?.message}
          <p class="terminal failed" data-testid="overview-run-terminal">{run.terminal.message}</p>
        {:else if run.terminal?.kind === 'run.completed'}
          <p class="terminal ok" data-testid="overview-run-terminal">run completed</p>
        {/if}
      </article>

      <article class="card recovery" data-testid="overview-recovery">
        <h3>Recovery</h3>
        {#if snapshot.recovery_label}
          <p class="recovery-label" data-testid="overview-recovery-label">{snapshot.recovery_label}</p>
        {/if}
        {#if run.status === 'paused' && run.pause?.reason}
          <p class="recovery-label">paused: {run.pause.reason}</p>
        {/if}
        {#if snapshot.recovery_label || run.status === 'paused'}
          <p class="meta">Resume is an explicit choice — see the recovery banner or the run controls.</p>
        {:else}
          <p class="meta" data-testid="overview-recovery-clear">Nothing to recover.</p>
        {/if}
      </article>

      <article class="card budget" data-testid="overview-budget">
        <h3>Budget</h3>
        {#if budgetLabel !== null}
          <p class="big-number" data-testid="overview-budget-amount">{budgetLabel}</p>
          {#if budgetPercent !== null}
            <div class="bar">
              <div class="fill {budgetPercent >= 90 ? 'hot' : ''}" style="width: {budgetPercent}%"></div>
            </div>
            <p class="meta">{budgetPercent}% of budget used</p>
          {/if}
        {:else}
          <p class="meta">No budget configured.</p>
        {/if}
      </article>

      <article class="card usage" data-testid="overview-usage">
        <h3>Usage</h3>
        <dl class="facts">
          <div>
            <dt>Input tokens</dt>
            <dd class="mono">{(totals?.inputTokens ?? snapshot.total_input_tokens ?? 0).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Output tokens</dt>
            <dd class="mono">{(totals?.outputTokens ?? snapshot.total_output_tokens ?? 0).toLocaleString()}</dd>
          </div>
          {#if $usage.updatedAt}
            <div><dt>Updated</dt><dd>{new Date($usage.updatedAt).toLocaleTimeString()}</dd></div>
          {/if}
        </dl>
      </article>
    </div>

    <RunControls />

    <div class="timeline-grid">
      <article class="card activity-card" data-testid="overview-activity">
        <h3>Recent activity</h3>
        {#if recentActivity.length === 0}
          <p class="meta">No engine events yet.</p>
        {:else}
          <ul class="activity-list">
            {#each recentActivity as entry (entry.id)}
              <li>
                <span class="seq">{entry.sequence}</span>
                <span class="name">{entry.event}</span>
                {#if entry.summary}<span class="summary">{entry.summary}</span>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </article>

      <article class="card errors-card" data-testid="overview-errors">
        <h3>Last errors</h3>
        {#if lastErrors.length === 0}
          <p class="meta" data-testid="overview-no-errors">No errors recorded.</p>
        {:else}
          <ul class="error-list">
            {#each lastErrors as note (note.id)}
              <li data-testid="overview-error-item">
                {#if note.code}<span class="code">[{note.code}]</span>{/if}
                <span>{note.message}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </article>
    </div>
  {/if}
</section>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
    padding: 1.25rem 1.5rem 2.5rem;
    max-width: 72rem;
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
    margin-top: 0.5rem;
  }
  .empty-icon-circle {
    width: 3.25rem;
    height: 3.25rem;
    border-radius: var(--radius-full);
    background: var(--surface-2);
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--accent);
    margin-bottom: 0.25rem;
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
    max-width: 28rem;
    font-size: 0.88rem;
  }
  .snapshot-error {
    font-size: 0.8rem;
    color: var(--warn);
    background: var(--warn-subtle);
    border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent);
    border-radius: var(--radius-sm);
    padding: 0.4rem 0.75rem;
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
    padding: 0.9rem 1.05rem;
    min-width: 0;
    box-shadow: var(--shadow-sm);
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }
  .card:hover {
    border-color: var(--border-hover);
  }
  .card-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
  }
  .status-badge {
    font-size: 0.72rem;
    padding: 0.1rem 0.45rem;
    border-radius: var(--radius-full);
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text-dim);
  }
  .hero-card {
    grid-column: 1 / -1;
    background: linear-gradient(145deg, var(--surface-1) 0%, color-mix(in srgb, var(--accent) 5%, var(--surface-1)) 100%);
    border-color: color-mix(in srgb, var(--accent) 25%, var(--border));
  }
  .card h3 {
    margin: 0 0 0.45rem;
    font-size: 0.74rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
    font-weight: 700;
  }
  .book-title {
    margin: 0;
    font-size: 1.35rem;
    font-weight: 700;
    font-family: var(--font-serif);
    letter-spacing: -0.015em;
    color: var(--text);
  }
  .progress-metric-row {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
  }
  .big-number {
    margin: 0;
    font-size: 1.75rem;
    font-weight: 700;
    font-family: var(--mono);
    color: var(--text);
    letter-spacing: -0.03em;
  }
  .meta {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.8rem;
  }
  .synopsis {
    margin-top: 0.55rem;
    max-height: 8rem;
    overflow-y: auto;
    color: var(--text-secondary);
    font-size: 0.86rem;
    line-height: 1.55;
    background: var(--surface-2);
    padding: 0.6rem 0.75rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
  }
  .facts {
    margin: 0.65rem 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .facts div {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    font-size: 0.82rem;
    align-items: center;
  }
  .facts dt {
    color: var(--text-dim);
  }
  .facts dd {
    margin: 0;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 65%;
    font-weight: 500;
    color: var(--text);
  }
  .facts dd.mono {
    font-family: var(--mono);
    font-size: 0.78rem;
  }
  .badge {
    display: inline-flex;
    padding: 0.05rem 0.45rem;
    border-radius: var(--radius-xs);
    font-size: 0.75rem;
  }
  .badge.ok {
    background: var(--ok-subtle);
    color: var(--ok);
    border: 1px solid color-mix(in srgb, var(--ok) 35%, transparent);
  }
  .bar {
    height: 0.45rem;
    background: var(--surface-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-full);
    overflow: hidden;
    margin: 0.5rem 0;
  }
  .fill {
    height: 100%;
    background: linear-gradient(90deg, var(--accent) 0%, var(--info) 100%);
    border-radius: var(--radius-full);
    transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .fill.hot {
    background: linear-gradient(90deg, var(--warn) 0%, var(--danger) 100%);
  }
  .terminal {
    margin: 0.6rem 0 0;
    font-size: 0.8rem;
    padding: 0.35rem 0.6rem;
    border-radius: var(--radius-sm);
  }
  .terminal.failed {
    background: var(--danger-subtle);
    color: var(--danger);
    border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
  }
  .terminal.ok {
    background: var(--ok-subtle);
    color: var(--ok);
    border: 1px solid color-mix(in srgb, var(--ok) 30%, transparent);
  }
  .recovery-label {
    margin: 0;
    color: var(--warn);
    font-size: 0.85rem;
    font-weight: 500;
  }
  .timeline-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
    gap: 0.85rem;
  }
  .activity-list,
  .error-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-height: 14rem;
    overflow-y: auto;
    font-family: var(--mono);
    font-size: 0.76rem;
  }
  .activity-list li {
    display: flex;
    gap: 0.5rem;
    padding: 0.2rem 0.35rem;
    border-radius: var(--radius-xs);
    transition: background var(--transition-fast);
  }
  .activity-list li:hover {
    background: var(--surface-2);
  }
  .seq {
    color: var(--text-faint);
    min-width: 2.2rem;
    text-align: right;
  }
  .name {
    color: var(--accent);
    white-space: nowrap;
  }
  .summary {
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .error-list li {
    display: flex;
    gap: 0.4rem;
    color: var(--danger);
    padding: 0.2rem 0.35rem;
    border-radius: var(--radius-xs);
    background: var(--danger-subtle);
  }
  .error-list .code {
    color: var(--text-faint);
  }
</style>
