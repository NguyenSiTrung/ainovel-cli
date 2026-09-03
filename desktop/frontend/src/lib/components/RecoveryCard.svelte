<script lang="ts">
  /**
   * The explicit recovery choice (README §4): after an engine session change
   * that interrupted observed work, the user decides — resume (project.resume,
   * always-latest checkpoint), inspect (keep state visible, drop the prompt),
   * or close the project. The app never resumes automatically.
   */
  import {
    closeProject,
    dismissRecoveryPrompt,
    projectSnapshot,
    recoveryPrompt,
    reportError,
    resumeRecoveredProject,
  } from '$lib/stores/desktop';

  let prompt = $derived($recoveryPrompt);
  let snapshot = $derived($projectSnapshot);

  let resuming = $state(false);
  let closing = $state(false);

  async function resume(): Promise<void> {
    resuming = true;
    try {
      await resumeRecoveredProject();
    } finally {
      resuming = false;
    }
  }

  async function close(): Promise<void> {
    closing = true;
    try {
      await closeProject();
    } catch (raw) {
      reportError(raw, 'project.close');
    } finally {
      closing = false;
    }
  }
</script>

{#if prompt}
  <section class="recovery-card" data-testid="recovery-card" aria-label="Recovery choice" tabindex="-1">
    <div class="recovery-head">
      <h3>Engine restarted — your run was interrupted</h3>
      <p class="recovery-context">
        Session {prompt.previousSession ?? '?'} → {prompt.currentSession ?? '?'} · run was
        {prompt.runStatusBefore} when it changed.
        {#if snapshot?.recovery_label}
          Engine recovery state: {snapshot.recovery_label}.
        {/if}
        Nothing has been resumed — choose what happens next.
      </p>
    </div>
    <div class="recovery-actions">
      <button type="button" class="primary" onclick={() => resume()} disabled={resuming || closing} data-testid="recovery-resume">
        {resuming ? 'Resuming…' : 'Resume latest checkpoint'}
      </button>
      <button type="button" onclick={() => dismissRecoveryPrompt()} disabled={resuming || closing} data-testid="recovery-inspect">
        Inspect first
      </button>
      <button type="button" class="danger" onclick={() => close()} disabled={resuming || closing} data-testid="recovery-close">
        {closing ? 'Closing…' : 'Close project'}
      </button>
    </div>
  </section>
{/if}

<style>
  .recovery-card {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.8rem 1rem;
    border: 1px solid color-mix(in srgb, var(--warn) 55%, transparent);
    background: color-mix(in srgb, var(--warn) 8%, var(--surface-1));
    border-radius: 8px;
  }
  h3 {
    margin: 0 0 0.25rem;
    font-size: 0.95rem;
    color: var(--warn);
  }
  .recovery-context {
    margin: 0;
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  .recovery-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
</style>
