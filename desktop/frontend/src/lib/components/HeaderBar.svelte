<script lang="ts">
  /**
   * Status / usage / notification header: connection + engine health pill,
   * run status summary, usage totals, notification count, and engine
   * lifecycle controls (commands only; the shell owns the decisions).
   */
  import {
    connectionState,
    engineState,
    notifications,
    restartEngineFromUi,
    runState,
    shutdownEngineFromUi,
    startEngineFromUi,
    usage,
  } from '$lib/stores/desktop';
  import type { ConnectionState } from '$lib/types/protocol';
  import ProjectSwitcher from './ProjectSwitcher.svelte';

  let {
    sidePanelOpen = true,
    onToggleInspector,
  }: {
    sidePanelOpen?: boolean;
    onToggleInspector?: () => void;
  } = $props();

  let connection = $derived($connectionState);
  let engine = $derived($engineState);
  let run = $derived($runState);
  let totals = $derived($usage.totals);
  let noteCount = $derived($notifications.filter((n) => n.level !== 'info').length);

  const CONNECTION_LABELS: Record<ConnectionState, string> = {
    booting: 'Starting up…',
    starting: 'Engine starting…',
    ready: 'Connected',
    reconnecting: 'Reconnecting…',
    degraded: 'Degraded',
    failed: 'Engine failed',
    stopped: 'Engine stopped',
  };

  let statusLabel = $derived(CONNECTION_LABELS[connection]);
  let runLabel = $derived(
    run.status === 'idle'
      ? null
      : `${run.status}${run.step ? ` · ${run.step}` : ''}${
          run.progress?.total !== undefined ? ` (${run.progress.completed ?? 0}/${run.progress.total})` : ''
        }`,
  );
  let usageLabel = $derived(
    totals
      ? `${(totals.costUsd ?? 0).toFixed(2)} USD${totals.budgetLimitUsd ? ` / ${totals.budgetLimitUsd.toFixed(2)}` : ''}`
      : null,
  );

  let canStart = $derived(connection === 'stopped' || connection === 'failed');
  let canRestart = $derived(connection !== 'booting' && connection !== 'starting');
  let canStop = $derived(engine.health === 'ready' || engine.health === 'restarting');
</script>

<header class="header-bar" data-testid="header-bar">
  <div class="header-section grow">
    <ProjectSwitcher />
  </div>

  <div class="header-section status-section">
    <span class="status-pill {connection}" data-testid="connection-status" title={engine.lastError ?? undefined}>
      <span class="status-dot" aria-hidden="true"></span>
      <span class="status-text">{statusLabel}</span>
      {#if engine.session}
        <span class="session-id">({engine.session.slice(0, 8)})</span>
      {/if}
    </span>
    {#if runLabel}
      <span class="run-chip" data-testid="run-status">
        <span class="run-indicator" aria-hidden="true"></span>
        {runLabel}
      </span>
    {/if}
    {#if usageLabel}
      <span class="usage-chip" data-testid="usage-summary" title="Cost / budget">
        <svg class="chip-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 18V6"/></svg>
        {usageLabel}
      </span>
    {/if}
    <span
      class="notify-chip {noteCount > 0 ? 'has-notes' : ''}"
      data-testid="notification-count"
      title="{noteCount} notification(s)"
    >
      <svg class="chip-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
      {noteCount}
    </span>
  </div>

  <div class="header-section engine-controls">
    {#if canStart}
      <button type="button" class="ghost" onclick={() => startEngineFromUi()} data-testid="engine-start">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Start engine
      </button>
    {/if}
    <button
      type="button"
      class="ghost"
      onclick={() => restartEngineFromUi('user restart')}
      disabled={!canRestart}
      data-testid="engine-restart"
      title="Restart engine sidecar"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>
      Restart
    </button>
    <button
      type="button"
      class="ghost danger"
      onclick={() => shutdownEngineFromUi('user shutdown')}
      disabled={!canStop}
      data-testid="engine-stop"
      title="Stop engine sidecar"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect width="14" height="14" x="5" y="5" rx="2"/></svg>
      Stop
    </button>

    {#if onToggleInspector}
      <button
        type="button"
        class="ghost inspector-toggle"
        class:active={sidePanelOpen}
        onclick={onToggleInspector}
        title={sidePanelOpen ? 'Hide inspector' : 'Show inspector'}
        aria-label="Toggle inspector dock"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M15 3v18" />
        </svg>
      </button>
    {/if}
  </div>
</header>

<style>
  .header-bar {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    padding: 0.45rem 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
    flex-wrap: wrap;
    min-height: 2.85rem;
  }
  .header-section {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .header-section.grow {
    flex: 1;
    min-width: 0;
  }
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.65rem;
    border-radius: var(--radius-full);
    border: 1px solid var(--border);
    background: var(--surface-2);
    font-size: 0.78rem;
    font-weight: 500;
    white-space: nowrap;
    transition: border-color var(--transition-fast), background var(--transition-fast);
  }
  .status-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--text-faint);
    flex-shrink: 0;
  }
  .status-pill.ready .status-dot {
    background: var(--ok);
    box-shadow: 0 0 6px var(--ok);
  }
  .status-pill.ready {
    border-color: color-mix(in srgb, var(--ok) 40%, transparent);
    background: color-mix(in srgb, var(--ok) 6%, var(--surface-2));
  }
  .status-pill.reconnecting .status-dot,
  .status-pill.starting .status-dot,
  .status-pill.booting .status-dot {
    background: var(--warn);
    box-shadow: 0 0 6px var(--warn);
    animation: pulse 1.5s infinite;
  }
  .status-pill.failed .status-dot {
    background: var(--danger);
    box-shadow: 0 0 6px var(--danger);
  }
  .status-pill.degraded .status-dot {
    background: var(--warn);
  }
  .session-id {
    color: var(--text-faint);
    font-size: 0.7rem;
    font-family: var(--mono);
  }
  .run-chip,
  .usage-chip,
  .notify-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.76rem;
    padding: 0.2rem 0.55rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .run-chip {
    border-color: var(--accent);
    color: var(--text);
    background: var(--accent-subtle);
    font-weight: 500;
  }
  .run-indicator {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 6px var(--accent);
    animation: pulse 1.5s infinite;
  }
  .chip-icon {
    opacity: 0.7;
  }
  .notify-chip.has-notes {
    border-color: color-mix(in srgb, var(--warn) 60%, transparent);
    background: var(--warn-subtle);
    color: var(--warn);
    font-weight: 600;
  }
  .engine-controls {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    border-left: 1px solid var(--border-subtle);
    padding-left: 0.6rem;
  }
  .inspector-toggle {
    padding: 0.3rem 0.45rem;
    color: var(--text-dim);
  }
  .inspector-toggle:hover,
  .inspector-toggle.active {
    color: var(--accent);
    background: var(--surface-2);
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
</style>
