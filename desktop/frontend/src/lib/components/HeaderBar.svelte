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

  <div class="header-section">
    <span class="status-pill {connection}" data-testid="connection-status" title={engine.lastError ?? undefined}>
      <span class="status-dot" aria-hidden="true"></span>
      {statusLabel}
      {#if engine.session}
        <span class="session-id">({engine.session.slice(0, 8)})</span>
      {/if}
    </span>
    {#if runLabel}
      <span class="run-chip" data-testid="run-status">{runLabel}</span>
    {/if}
    {#if usageLabel}
      <span class="usage-chip" data-testid="usage-summary" title="Cost / budget">
        {usageLabel}
      </span>
    {/if}
    <span
      class="notify-chip {noteCount > 0 ? 'has-notes' : ''}"
      data-testid="notification-count"
      title="{noteCount} notification(s)"
    >
      {noteCount}
    </span>
  </div>

  <div class="header-section engine-controls">
    {#if canStart}
      <button type="button" class="ghost" onclick={() => startEngineFromUi()} data-testid="engine-start">
        Start engine
      </button>
    {/if}
    <button
      type="button"
      class="ghost"
      onclick={() => restartEngineFromUi('user restart')}
      disabled={!canRestart}
      data-testid="engine-restart"
    >
      Restart
    </button>
    <button
      type="button"
      class="ghost danger"
      onclick={() => shutdownEngineFromUi('user shutdown')}
      disabled={!canStop}
      data-testid="engine-stop"
    >
      Stop
    </button>
  </div>
</header>

<style>
  .header-bar {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.5rem 1rem;
    border-bottom: 1px solid var(--border);
    background: var(--surface-1);
    flex-wrap: wrap;
  }
  .header-section {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .header-section.grow {
    flex: 1;
    min-width: 0;
  }
  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
    border: 1px solid var(--border);
    font-size: 0.82rem;
    white-space: nowrap;
  }
  .status-dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--text-faint);
  }
  .status-pill.ready .status-dot {
    background: var(--ok);
  }
  .status-pill.ready {
    border-color: color-mix(in srgb, var(--ok) 50%, transparent);
  }
  .status-pill.reconnecting .status-dot,
  .status-pill.starting .status-dot,
  .status-pill.booting .status-dot {
    background: var(--warn);
  }
  .status-pill.failed .status-dot {
    background: var(--danger);
  }
  .status-pill.degraded .status-dot {
    background: var(--warn);
  }
  .session-id {
    color: var(--text-faint);
    font-size: 0.72rem;
  }
  .run-chip,
  .usage-chip,
  .notify-chip {
    font-size: 0.78rem;
    padding: 0.15rem 0.55rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    white-space: nowrap;
  }
  .notify-chip.has-notes {
    border-color: color-mix(in srgb, var(--warn) 60%, transparent);
    color: var(--warn);
    font-weight: 600;
  }
</style>
