<script lang="ts">
  /**
   * Simulation screen: style-imitation from a corpus.
   *
   * `simulation.start` genuinely consumes the chosen source (a
   * .txt/.md/.markdown file or a directory of them): the engine stages it
   * into the project corpus `<project>/simulate` (engine_source_dir) and
   * merges the generated profile incrementally — resume re-runs the staged
   * corpus. The generated profile is STAGED/generated content (it shapes
   * style); durable project facts are the separate right pane. Profile
   * import brings a produced profile JSON into the project over the same
   * simulation.progress event channel.
   */
  import {
    cancelSimulationFromUi,
    deriveSimulationControls,
    dismissSimulationResult,
    importProfileFromUi,
    resumeSimulationFromUi,
    simulationState,
    startSimulationFromUi,
  } from '$lib/simulation';
  import { connectionState, projectSnapshot } from '$lib/stores/desktop';
  import { presentError } from '$lib/types/protocol';

  let { title, description, owner }: { title: string; description: string; owner: string } = $props();

  let snapshot = $derived($projectSnapshot);
  let flow = $derived($simulationState);
  let avail = $derived(deriveSimulationControls(flow, snapshot, $connectionState));

  let errorPresentation = $derived(flow.error ? presentError(flow.error.code) : null);
  let profileErrorPresentation = $derived(
    flow.profileImport.error ? presentError(flow.profileImport.error.code) : null,
  );
  let statusLabel = $derived(
    {
      idle: 'idle',
      picking: 'choosing source…',
      starting: 'staging source…',
      resuming: 'resuming…',
      running: 'simulating…',
      completed: 'completed',
      failed: 'failed',
      cancelled: 'cancelled',
      interrupted: 'interrupted',
    }[flow.status],
  );
</script>

<section class="simulation-screen screen" data-testid="simulation-screen">
  <header class="screen-header">
    <h2>{title}</h2>
    <p class="screen-description">{description} <span class="owner">({owner})</span></p>
  </header>

  {#if snapshot === null}
    <div class="empty-state" data-testid="simulation-empty">
      <h3>No project open</h3>
      <p>Open or create a project from the Overview screen to run a simulation.</p>
    </div>
  {:else}
    <p class="staged-banner" data-testid="simulation-staged-note">
      <span class="staged-badge">generated</span>
      The profile this produces is generated content that shapes style — it is not a durable book fact.
    </p>

    <div class="sim-layout">
      <section class="pane form-pane" data-testid="simulation-form">
        <h3>Corpus source</h3>
        <div class="actions">
          <button
            type="button"
            class="primary"
            onclick={() => startSimulationFromUi('file')}
            disabled={!avail.canStartFromFile}
            data-testid="simulation-run-file"
          >
            Choose file & simulate
          </button>
          <button
            type="button"
            onclick={() => startSimulationFromUi('directory')}
            disabled={!avail.canStartFromDirectory}
            data-testid="simulation-run-directory"
          >
            Choose folder & simulate
          </button>
        </div>
        <p class="meta">
          .txt / .md / .markdown. The engine stages the source into the project corpus and re-analyzes only new or changed files.
        </p>

        <div class="actions">
          <button
            type="button"
            onclick={() => resumeSimulationFromUi()}
            disabled={!avail.canResume}
            data-testid="simulation-resume"
          >
            {flow.status === 'resuming' ? 'Resuming…' : 'Re-run staged corpus'}
          </button>
          <button
            type="button"
            onclick={() => cancelSimulationFromUi()}
            disabled={!avail.canCancel}
            data-testid="simulation-cancel"
          >
            {flow.pendingCancel ? 'Cancelling…' : 'Cancel'}
          </button>
        </div>
        {#if !avail.engineReady}
          <p class="meta">Engine not connected — controls unlock when it is ready.</p>
        {/if}

        <h3 class="form-gap">Profile import</h3>
        <button
          type="button"
          onclick={() => importProfileFromUi()}
          disabled={!avail.canImportProfile}
          data-testid="simulation-profile-import"
        >
          {flow.profileImport.status === 'picking'
            ? 'Choosing profile…'
            : flow.profileImport.status === 'importing'
              ? 'Importing…'
              : 'Import profile (.json)'}
        </button>
        <p class="meta">Brings a produced simulation profile into this project.</p>
        {#if flow.profileImport.profilePath}
          <p class="meta" data-testid="simulation-profile-path">profile: {flow.profileImport.profilePath}</p>
        {/if}
        {#if flow.profileImport.status === 'completed'}
          <p class="ok" data-testid="simulation-profile-done">
            profile imported{flow.profileImport.detail ? ` — ${flow.profileImport.detail}` : ''}
          </p>
        {/if}
        {#if flow.profileImport.error}
          <div class="error-box" data-testid="simulation-profile-error">
            <p>
              {profileErrorPresentation?.title} — {flow.profileImport.error.message}
              <span class="code">[{flow.profileImport.error.code}]</span>
            </p>
          </div>
        {/if}
      </section>

      <section class="pane result-pane" data-testid="simulation-progress-pane">
        <h3>
          Progress
          <span class="status" data-testid="simulation-status">{statusLabel}</span>
        </h3>

        {#if flow.sourcePath}
          <p class="meta" data-testid="simulation-source">last source: {flow.sourcePath}</p>
        {/if}

        {#if flow.progress}
          <dl class="fact-list" data-testid="simulation-progress">
            {#if flow.progress.stage}<div><dt>Stage</dt><dd>{flow.progress.stage}</dd></div>{/if}
            {#if flow.progress.total !== undefined}
              <div><dt>Units</dt><dd>{flow.progress.completed ?? 0}/{flow.progress.total}</dd></div>
            {/if}
            {#if flow.progress.detail}<div class="detail"><dt>Detail</dt><dd>{flow.progress.detail}</dd></div>{/if}
          </dl>
        {/if}

        {#if flow.recent.length > 0}
          <ul class="recent" data-testid="simulation-recent">
            {#each flow.recent as line, i (i)}
              <li>
                {#if line.stage}<span class="stage">{line.stage}</span>{/if}
                <span class="detail">{line.detail ?? (line.total !== undefined ? `${line.completed ?? 0}/${line.total}` : '')}</span>
              </li>
            {/each}
          </ul>
        {/if}

        {#if flow.error}
          <div class="error-box" data-testid="simulation-error">
            <p>{errorPresentation?.title} — {flow.error.message} <span class="code">[{flow.error.code}]</span></p>
            {#if errorPresentation?.action}<p class="meta">{errorPresentation.action}</p>{/if}
            <button type="button" class="small" onclick={() => dismissSimulationResult()} data-testid="simulation-dismiss-error">
              Dismiss
            </button>
          </div>
        {:else if flow.status === 'completed'}
          <div class="result" data-testid="simulation-result">
            <p class="ok">Simulation completed.</p>
            {#if flow.result?.detail}
              <p class="meta" data-testid="simulation-result-detail">{flow.result.detail}</p>
            {/if}
            <button type="button" class="small" onclick={() => dismissSimulationResult()} data-testid="simulation-dismiss">
              Dismiss
            </button>
          </div>
        {:else if flow.message}
          <p class="meta" data-testid="simulation-message">{flow.message}</p>
        {:else if flow.status === 'idle'}
          <p class="meta" data-testid="simulation-no-result">No simulation run yet.</p>
        {/if}
      </section>

      <aside class="pane side-pane">
        <section class="generated" data-testid="simulation-generated">
          <h3>Generated profile <span class="staged-badge">generated</span></h3>
          {#if flow.corpusDir}
            <p class="meta" data-testid="simulation-corpus-dir">corpus: {flow.corpusDir}</p>
          {/if}
          {#if flow.result}
            <p class="meta">{flow.result.detail ?? 'profile updated'}</p>
            <p class="meta">Stored engine-side and merged by content fingerprint — re-running only analyzes new or changed sources.</p>
          {:else}
            <p class="meta">The generated summary appears here when a run completes.</p>
          {/if}
        </section>

        <section class="facts" data-testid="simulation-facts">
          <h3>Project facts <span class="durable-badge">durable</span></h3>
          <dl class="fact-list">
            <div><dt>Book</dt><dd>{snapshot.book_title ?? '—'}</dd></div>
            <div><dt>Chapters</dt><dd>{snapshot.completed_chapters ?? 0}/{snapshot.total_chapters ?? '?'}</dd></div>
            {#if snapshot.style}
              <div><dt>Style</dt><dd>{snapshot.style}</dd></div>
            {/if}
          </dl>
        </section>
      </aside>
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
  .staged-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    font-size: 0.8rem;
    color: var(--text-dim);
  }
  .staged-badge,
  .durable-badge {
    font-size: 0.64rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-radius: 999px;
    padding: 0.05rem 0.45rem;
    border: 1px solid color-mix(in srgb, var(--warn) 55%, transparent);
    color: var(--warn);
    white-space: nowrap;
  }
  .durable-badge {
    border-color: color-mix(in srgb, var(--ok) 55%, transparent);
    color: var(--ok);
  }
  .sim-layout {
    display: grid;
    grid-template-columns: minmax(16rem, 22rem) minmax(14rem, 1fr) minmax(11rem, 14rem);
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
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .pane .form-gap {
    margin-top: 0.9rem;
  }
  .side-pane .generated,
  .side-pane .facts {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .side-pane .facts {
    margin-top: 0.7rem;
  }
  .status {
    font-size: 0.68rem;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0 0.45rem;
    text-transform: none;
    letter-spacing: 0;
  }
  .meta {
    margin: 0.25rem 0;
    color: var(--text-faint);
    font-size: 0.78rem;
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 0.4rem;
  }
  .fact-list {
    margin: 0 0 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .fact-list div {
    display: flex;
    justify-content: space-between;
    gap: 0.6rem;
    font-size: 0.82rem;
  }
  .fact-list div.detail dd {
    white-space: normal;
  }
  .fact-list dt {
    color: var(--text-faint);
    flex: none;
  }
  .fact-list dd {
    margin: 0;
    text-align: right;
    overflow-wrap: anywhere;
  }
  .recent {
    list-style: none;
    margin: 0.4rem 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-family: var(--mono);
    font-size: 0.72rem;
    max-height: 11rem;
    overflow-y: auto;
  }
  .recent li {
    display: flex;
    gap: 0.5rem;
    color: var(--text-dim);
  }
  .recent .stage {
    color: var(--accent);
    min-width: 6rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recent .detail {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .result .ok {
    color: var(--ok);
    margin: 0 0 0.4rem;
    font-size: 0.9rem;
  }
  .ok {
    color: var(--ok);
    font-size: 0.8rem;
    margin: 0.2rem 0;
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
