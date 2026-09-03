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
      <article class="card identity" data-testid="overview-identity">
        <h3>Project</h3>
        <p class="book-title">{snapshot.book_title ?? 'Untitled project'}</p>
        {#if snapshot.status_label ?? snapshot.state}
          <p class="meta">{snapshot.status_label ?? snapshot.state}</p>
        {/if}
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
        <p class="big-number" data-testid="overview-chapters">{chapterLabel}</p>
        <p class="meta">chapters written</p>
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
          <div><dt>Connection</dt><dd>{$connectionState}</dd></div>
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
            <dd>{(totals?.inputTokens ?? snapshot.total_input_tokens ?? 0).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Output tokens</dt>
            <dd>{(totals?.outputTokens ?? snapshot.total_output_tokens ?? 0).toLocaleString()}</dd>
          </div>
          {#if $usage.updatedAt}
            <div><dt>Updated</dt><dd>{new Date($usage.updatedAt).toLocaleTimeString()}</dd></div>
          {/if}
        </dl>
      </article>
    </div>

    <RunControls />

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
  {/if}
</section>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.9rem 1rem 1.5rem;
    max-width: 60rem;
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
    display: flex;
    flex-direction: column;
    gap: 0.8rem;
    padding: 2.5rem 2rem;
    border: 1px dashed var(--border);
    border-radius: 10px;
    align-items: flex-start;
  }
  .empty-state h3 {
    margin: 0;
  }
  .empty-state p {
    margin: 0;
    color: var(--text-dim);
  }
  .snapshot-error {
    font-size: 0.8rem;
    color: var(--warn);
  }
  .card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: 0.75rem;
  }
  .card {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.75rem 0.9rem;
    min-width: 0;
  }
  .card h3 {
    margin: 0 0 0.5rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
  }
  .book-title {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 700;
  }
  .big-number {
    margin: 0;
    font-size: 1.6rem;
    font-weight: 700;
    font-family: var(--mono);
  }
  .meta {
    margin: 0.15rem 0 0;
    color: var(--text-faint);
    font-size: 0.8rem;
  }
  .synopsis {
    margin-top: 0.4rem;
    max-height: 8rem;
    overflow-y: auto;
    color: var(--text-dim);
    font-size: 0.85rem;
  }
  .facts {
    margin: 0.5rem 0 0;
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
  }
  .facts dd {
    margin: 0;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 60%;
  }
  .facts dd.mono {
    font-family: var(--mono);
    font-size: 0.76rem;
  }
  .bar {
    height: 0.45rem;
    background: var(--surface-3);
    border-radius: 999px;
    overflow: hidden;
    margin-top: 0.4rem;
  }
  .fill {
    height: 100%;
    background: var(--accent);
    border-radius: 999px;
    transition: width 0.3s ease;
  }
  .fill.hot {
    background: var(--danger);
  }
  .terminal {
    margin: 0.5rem 0 0;
    font-size: 0.8rem;
    padding: 0.25rem 0.5rem;
    border-radius: 6px;
  }
  .terminal.failed {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger);
  }
  .terminal.ok {
    background: color-mix(in srgb, var(--ok) 12%, transparent);
    color: var(--ok);
  }
  .recovery-label {
    margin: 0;
    color: var(--warn);
    font-size: 0.85rem;
  }
  .activity-list,
  .error-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    max-height: 12rem;
    overflow-y: auto;
    font-family: var(--mono);
    font-size: 0.76rem;
  }
  .activity-list li {
    display: flex;
    gap: 0.5rem;
  }
  .seq {
    color: var(--text-faint);
    min-width: 2.5rem;
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
  }
  .error-list .code {
    color: var(--text-faint);
  }
</style>
