<script lang="ts">
  /**
   * The run control surface shared by the Overview and Write screens.
   *
   * Every button's enabled/disabled state comes from `deriveRunControls`,
   * which reads ONLY backend-reported state (engine snapshot + observed
   * run.* events). Nothing here advances run state locally: commands go out
   * through the protocol, and status changes arrive as engine events.
   *
   * Backend semantics honored:
   * - start takes a goal and is acceptance-based (outcome arrives async);
   * - steer sends a natural-language instruction mid-run;
   * - pause and abort both stop the engine (abort is the destructive label);
   * - continue/retry resume from persisted engine state;
   * - advance mode (auto/review) is engine-owned; the toggle reflects
   *   snapshot.advance_mode and re-reads it after switching;
   * - "authorize one chapter" appears only when the engine reports a
   *   chapter-gate hold (has_advance_hold / run.paused advance_hold).
   */
  import {
    abortRunFromUi,
    authorizeOneChapterFromUi,
    continueRunFromUi,
    deriveRunControls,
    lastRunControlOutcome,
    pauseRunFromUi,
    pendingRunControls,
    reopenProjectFromUi,
    retryRunFromUi,
    setAdvanceModeFromUi,
    startRunFromUi,
    steerRunFromUi,
  } from '$lib/runControls';
  import { connectionState, projectSnapshot, runState } from '$lib/stores/desktop';

  let goal = $state('');
  let steerInstruction = $state('');
  let continueInstruction = $state('');
  let reopenDirection = $state('');

  let snapshot = $derived($projectSnapshot);
  let run = $derived($runState);
  let avail = $derived(deriveRunControls(snapshot, run, $connectionState));
  let pending = $derived($pendingRunControls);
  let outcome = $derived($lastRunControlOutcome);

  let runStatusLabel = $derived.by(() => {
    const progress =
      run.progress?.total !== undefined ? ` (${run.progress.completed ?? 0}/${run.progress.total})` : '';
    return `${run.status}${run.step ? ` · ${run.step}` : ''}${progress}`;
  });

  async function submitStart(): Promise<void> {
    if (await startRunFromUi(goal)) goal = '';
  }

  async function submitSteer(): Promise<void> {
    if (await steerRunFromUi(steerInstruction)) steerInstruction = '';
  }

  async function submitContinue(): Promise<void> {
    if (await continueRunFromUi(continueInstruction)) continueInstruction = '';
  }

  async function submitReopen(): Promise<void> {
    if (await reopenProjectFromUi(reopenDirection)) reopenDirection = '';
  }
</script>

<section class="run-controls" data-testid="run-controls">
  <header class="controls-header">
    <h3>Run</h3>
    <span class="run-facts" data-testid="run-facts">
      {#if avail.projectOpen}
        {runStatusLabel}
        {#if snapshot?.advance_mode}
          · mode: {avail.advanceMode ?? snapshot.advance_mode}
        {/if}
        {#if avail.pendingSteer}
          · steering queued
        {/if}
      {:else}
        no project open
      {/if}
    </span>
  </header>

  {#if run.status === 'failed' && run.terminal?.message}
    <p class="terminal-note failed" data-testid="run-failure-note">{run.terminal.message}</p>
  {/if}
  {#if run.pause?.reason}
    <p class="terminal-note paused" data-testid="run-pause-note">paused: {run.pause.reason}</p>
  {/if}
  {#if snapshot?.has_advance_hold}
    <p class="terminal-note paused" data-testid="advance-hold-note">
      chapter gate: {snapshot.advance_hold_reason ?? `engine is holding before chapter ${snapshot.advance_permit_chapter ?? '?'}`}
    </p>
  {/if}

  {#if !avail.projectOpen}
    <p class="hint" data-testid="run-controls-no-project">Open or create a project to start writing.</p>
  {:else if !avail.engineReady}
    <p class="hint" data-testid="run-controls-engine-not-ready">Engine not connected — controls unlock when it is ready.</p>
  {/if}

  <div class="control-row">
    {#if avail.canStart}
      <textarea
        rows="2"
        placeholder="Goal for this run (e.g. draft chapter 4 with the reveal at the market)…"
        bind:value={goal}
        data-testid="run-goal-input"
      ></textarea>
      <button
        type="button"
        class="primary"
        onclick={() => submitStart()}
        disabled={pending.start || goal.trim() === ''}
        data-testid="run-control-start"
      >
        {pending.start ? 'Starting…' : 'Start run'}
      </button>
    {/if}

    {#if avail.canContinue}
      <div class="continue-group" data-testid="continue-group">
        <input
          type="text"
          placeholder="Instruction for continuation (optional)…"
          bind:value={continueInstruction}
          data-testid="run-continue-instruction-input"
        />
        <button
          type="button"
          onclick={() => submitContinue()}
          disabled={pending.continue}
          data-testid="run-control-continue"
        >
          {pending.continue ? 'Continuing…' : 'Continue'}
        </button>
      </div>
    {/if}

    {#if avail.canReopen}
      <div class="reopen-group" data-testid="reopen-group">
        <input
          type="text"
          placeholder="Continuation direction (optional)…"
          bind:value={reopenDirection}
          data-testid="run-reopen-direction-input"
        />
        <button
          type="button"
          class="primary"
          onclick={() => submitReopen()}
          disabled={pending.reopen}
          data-testid="run-control-reopen"
        >
          {pending.reopen ? 'Reopening…' : 'Reopen book'}
        </button>
      </div>
    {/if}

    {#if avail.canRetry}
      <button
        type="button"
        onclick={() => retryRunFromUi()}
        disabled={pending.retry}
        data-testid="run-control-retry"
      >
        {pending.retry ? 'Retrying…' : 'Retry'}
      </button>
    {/if}

    {#if avail.canSteer}
      <div class="steer-group" data-testid="steer-group">
        <input
          type="text"
          placeholder="Steer the run (natural language)…"
          bind:value={steerInstruction}
          data-testid="run-steer-input"
        />
        <button
          type="button"
          onclick={() => submitSteer()}
          disabled={pending.steer || steerInstruction.trim() === ''}
          data-testid="run-control-steer"
        >
          {pending.steer ? 'Sending…' : 'Steer'}
        </button>
      </div>
    {/if}

    {#if avail.canPause}
      <button type="button" onclick={() => pauseRunFromUi()} disabled={pending.pause} data-testid="run-control-pause">
        {pending.pause ? 'Pausing…' : 'Pause'}
      </button>
    {/if}
    {#if avail.canAbort}
      <button
        type="button"
        class="danger"
        onclick={() => abortRunFromUi('user abort from run controls')}
        disabled={pending.abort}
        data-testid="run-control-abort"
      >
        {pending.abort ? 'Aborting…' : 'Abort'}
      </button>
    {/if}

    {#if avail.canAuthorizeChapter}
      <button
        type="button"
        class="primary"
        onclick={() => authorizeOneChapterFromUi()}
        disabled={pending['authorize-chapter']}
        data-testid="run-control-authorize-chapter"
      >
        Authorize one chapter
      </button>
    {/if}
  </div>

  <div class="advance-toggle" data-testid="advance-mode-toggle" title="Engine advance mode (snapshot.advance_mode)">
    <span class="toggle-label">Chapters:</span>
    <button
      type="button"
      class="segment"
      class:active={avail.advanceMode === 'auto'}
      onclick={() => setAdvanceModeFromUi('auto')}
      disabled={!avail.projectOpen || !avail.engineReady || pending['advance-mode'] || avail.advanceMode === 'auto'}
      data-testid="advance-mode-auto"
    >
      Auto
    </button>
    <button
      type="button"
      class="segment"
      class:active={avail.advanceMode === 'review'}
      onclick={() => setAdvanceModeFromUi('review')}
      disabled={!avail.projectOpen || !avail.engineReady || pending['advance-mode'] || avail.advanceMode === 'review'}
      data-testid="advance-mode-review"
    >
      Review
    </button>
    {#if avail.advanceMode === null}
      <span class="toggle-unknown" data-testid="advance-mode-unknown">mode unknown</span>
    {/if}
  </div>

  {#if outcome}
    <p class="outcome {outcome.ok ? 'ok' : 'error'}" data-testid="run-control-outcome">
      {#if outcome.ok}
        {outcome.message}
      {:else}
        {outcome.code ? `[${outcome.code}] ` : ''}{outcome.message}
      {/if}
    </p>
  {/if}
</section>

<style>
  .run-controls {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    padding: 0.8rem 1rem;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .controls-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  h3 {
    margin: 0;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
  }
  .run-facts {
    font-size: 0.8rem;
    color: var(--text-dim);
    font-family: var(--mono);
  }
  .hint {
    margin: 0;
    color: var(--text-faint);
    font-size: 0.85rem;
  }
  .terminal-note {
    margin: 0;
    font-size: 0.82rem;
    padding: 0.3rem 0.6rem;
    border-radius: 6px;
  }
  .terminal-note.failed {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger);
  }
  .terminal-note.paused {
    background: color-mix(in srgb, var(--warn) 12%, transparent);
    color: var(--warn);
  }
  .control-row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: flex-start;
  }
  .control-row textarea {
    flex: 1 1 16rem;
    resize: vertical;
  }
  .steer-group,
  .continue-group,
  .reopen-group {
    display: flex;
    gap: 0.5rem;
    flex: 1 1 14rem;
  }
  .steer-group input,
  .continue-group input,
  .reopen-group input {
    flex: 1;
    min-width: 10rem;
  }
  .advance-toggle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .toggle-label {
    font-size: 0.8rem;
    color: var(--text-dim);
    margin-right: 0.15rem;
  }
  .segment {
    font-size: 0.78rem;
    padding: 0.2rem 0.7rem;
    border-radius: 999px;
  }
  .segment.active {
    background: var(--surface-3);
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }
  .toggle-unknown {
    font-size: 0.75rem;
    color: var(--text-faint);
  }
  .outcome {
    margin: 0;
    font-size: 0.8rem;
    font-family: var(--mono);
  }
  .outcome.ok {
    color: var(--ok);
  }
  .outcome.error {
    color: var(--danger);
  }
</style>
