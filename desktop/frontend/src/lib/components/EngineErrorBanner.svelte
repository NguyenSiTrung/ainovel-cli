<script lang="ts">
  /**
   * Global engine error banner: renders prominently in the workspace slot
   * when the engine sidecar is failed, showing the root cause (e.g. missing
   * binary or startup failure) and a direct retry action.
   */
  import {
    connectionState,
    engineState,
    restartEngineFromUi,
    startEngineFromUi,
  } from '$lib/stores/desktop';

  let connection = $derived($connectionState);
  let engine = $derived($engineState);
  let failed = $derived(connection === 'failed');
  let restarting = $state(false);

  async function handleRetry(): Promise<void> {
    restarting = true;
    try {
      if (connection === 'failed' || connection === 'stopped') {
        await startEngineFromUi();
      } else {
        await restartEngineFromUi('retry from engine error banner');
      }
    } catch {
      // Errors update engineState and connectionState.
    } finally {
      restarting = false;
    }
  }
</script>

{#if failed}
  <div class="engine-error-slot" data-testid="engine-error-slot">
    <div class="engine-error-banner" role="alert" data-testid="engine-error-banner">
      <div class="error-header">
        <svg class="error-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <strong class="error-title">Novel Engine Unavailable</strong>
        <span class="error-tag">[engine_failed]</span>
      </div>
      <p class="error-message">
        {engine.lastError || 'The novel engine sidecar process failed to start or exited unexpectedly.'}
      </p>
      {#if engine.lastError && engine.lastError.includes('setup is missing')}
        <p class="error-suggestion">
          First-run setup required: run the CLI interactive setup once or verify that ~/.ainovel/config.json exists.
        </p>
      {/if}
      <div class="error-actions">
        <button
          type="button"
          class="small retry-btn"
          onclick={handleRetry}
          disabled={restarting}
          data-testid="engine-retry-btn"
        >
          {restarting ? 'Starting engine…' : 'Start / Restart engine'}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .engine-error-slot {
    padding: 0 1rem 0.75rem;
  }
  .engine-error-banner {
    border: 1px solid var(--danger);
    border-left-width: 4px;
    border-radius: var(--radius-md, 8px);
    padding: 0.75rem 1rem;
    background: var(--danger-subtle, rgba(248, 113, 113, 0.12));
    font-size: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .error-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--danger);
  }
  .error-title {
    font-weight: 600;
  }
  .error-tag {
    font-size: 0.75rem;
    font-family: var(--font-mono, monospace);
    opacity: 0.8;
  }
  .error-message {
    margin: 0;
    color: var(--text);
    line-height: 1.4;
  }
  .error-suggestion {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.8rem;
  }
  .error-actions {
    margin-top: 0.25rem;
  }
  .retry-btn {
    cursor: pointer;
  }
</style>
