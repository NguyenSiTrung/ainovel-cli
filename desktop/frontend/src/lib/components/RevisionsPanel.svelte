<script lang="ts">
  /**
   * Revisions panel (part of the Chapters screen): mismatch check on entry
   * and on demand, and the sync flow. Sync is acceptance-based — the
   * confirmation states exactly which chapters the engine will re-analyze,
   * then applied chapters arrive as chapter.updated {status:"synced"} facts
   * and a terminal notification; failures arrive as engine.error.
   */
  import {
    cancelRevisionSync,
    confirmRevisionSync,
    dismissRevisionSyncResult,
    requestRevisionSync,
    revisionCheck,
    revisionSync,
    runRevisionCheck,
  } from '$lib/chapters';
  import { presentError } from '$lib/types/protocol';

  let check = $derived($revisionCheck);
  let sync = $derived($revisionSync);

  let checkError = $derived(check.error ? presentError(check.error.code) : null);
  let syncError = $derived(sync.error ? presentError(sync.error.code) : null);
</script>

<section class="revisions" data-testid="revisions-panel">
  <header class="revisions-header">
    <h3>Revisions</h3>
    <button
      type="button"
      onclick={() => runRevisionCheck()}
      disabled={check.status === 'checking'}
      data-testid="revisions-check-button"
    >
      {check.status === 'checking' ? 'Checking…' : 'Check for revised chapters'}
    </button>
  </header>

  {#if check.error}
    <p class="rev-error" data-testid="revisions-check-error">
      {checkError?.title} — {check.error.message} <span class="code">[{check.error.code}]</span>
    </p>
  {:else if check.status === 'checking'}
    <p class="meta" data-testid="revisions-checking">checking the engine for chapter mismatches…</p>
  {:else if check.checkedAt === null}
    <p class="meta">No check run yet.</p>
  {:else if check.changed.length === 0}
    <p class="meta ok" data-testid="revisions-uptodate">
      Up to date — the engine reports no revised chapters (checked {new Date(check.checkedAt).toLocaleTimeString()}).
    </p>
  {:else}
    <div class="changed" data-testid="revisions-changed">
      <p>{check.changed.length} chapter{check.changed.length === 1 ? '' : 's'} changed engine-side:</p>
      <ul>
        {#each check.changed as chapter (chapter)}
          <li data-testid="revisions-changed-chapter">
            <span>Chapter {chapter}</span>
            <button type="button" class="small" onclick={() => requestRevisionSync(chapter)} data-testid="revisions-sync-one-{chapter}">
              Sync chapter {chapter}
            </button>
          </li>
        {/each}
      </ul>
      <button type="button" class="primary" onclick={() => requestRevisionSync()} data-testid="revisions-sync-all">
        Sync all changed chapters
      </button>
    </div>
  {/if}

  <!-- Explicit confirmation: no request until the user confirms. -->
  {#if sync.status === 'confirming'}
    <div class="confirm" role="dialog" aria-label="Confirm revision sync" data-testid="revisions-confirm">
      <h4>Apply revision sync?</h4>
      <p data-testid="revisions-confirm-scope">
        {#if sync.chapter !== null}
          The engine will re-analyze chapter {sync.chapter} and replace its text with the engine's
          revised version. This runs LLM analysis and can take a while.
        {:else if (sync.scope ?? []).length > 0}
          The engine will re-analyze {sync.scope!.length} chapter{sync.scope!.length === 1 ? '' : 's'}
          ({sync.scope!.join(', ')}) and replace their text with the engine's revised versions.
          This runs LLM analysis and can take a while.
        {:else}
          The engine reports no changed chapters — there is nothing to sync.
        {/if}
      </p>
      <p class="meta">Unsaved edits in those chapters are not protected by this flow; the engine's revision wins.</p>
      <div class="confirm-actions">
        <button
          type="button"
          class="primary"
          onclick={() => confirmRevisionSync()}
          disabled={(sync.scope ?? []).length === 0}
          data-testid="revisions-confirm-yes"
        >
          Sync now
        </button>
        <button type="button" onclick={() => cancelRevisionSync()} data-testid="revisions-confirm-cancel">Cancel</button>
      </div>
    </div>
  {/if}

  {#if sync.status === 'syncing'}
    <div class="sync-progress" data-testid="revisions-syncing">
      <p>Syncing… {sync.applied.length}{sync.scope && sync.scope.length > 0 ? `/${sync.scope.length}` : ''} chapters applied.</p>
      {#if sync.applied.length > 0}
        <p class="applied">applied: {sync.applied.join(', ')}</p>
      {/if}
      <p class="meta">Progress arrives as engine events; a run cannot be active during a sync.</p>
    </div>
  {:else if sync.status === 'completed'}
    <div class="sync-result ok" data-testid="revisions-sync-completed">
      <p>
        {sync.message ?? 'sync completed'}
        {#if sync.applied.length > 0}— applied chapters: {sync.applied.join(', ')}{/if}
      </p>
      <button type="button" class="small" onclick={() => dismissRevisionSyncResult()} data-testid="revisions-dismiss">
        Dismiss
      </button>
    </div>
  {:else if sync.status === 'failed'}
    <div class="sync-result error" data-testid="revisions-sync-failed">
      {#if sync.error}
        <p>{syncError?.title} — {sync.error.message} <span class="code">[{sync.error.code}]</span></p>
      {:else if sync.message}
        <p>{sync.message}</p>
      {/if}
      <button type="button" class="small" onclick={() => dismissRevisionSyncResult()} data-testid="revisions-dismiss">
        Dismiss
      </button>
    </div>
  {/if}
</section>

<style>
  .revisions {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.8rem 1rem;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: 8px;
  }
  .revisions-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  h3 {
    margin: 0;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
  }
  .meta {
    margin: 0;
    color: var(--text-faint);
    font-size: 0.78rem;
  }
  .meta.ok {
    color: var(--ok);
  }
  .rev-error {
    margin: 0;
    color: var(--danger);
    font-size: 0.82rem;
  }
  .code {
    font-family: var(--mono);
    font-size: 0.72rem;
  }
  .changed p {
    margin: 0 0 0.3rem;
    font-size: 0.85rem;
  }
  .changed ul {
    list-style: none;
    margin: 0 0 0.5rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .changed li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.84rem;
  }
  .confirm {
    border: 1px solid color-mix(in srgb, var(--warn) 55%, transparent);
    background: color-mix(in srgb, var(--warn) 8%, var(--surface-1));
    border-radius: 8px;
    padding: 0.6rem 0.8rem;
  }
  .confirm h4 {
    margin: 0 0 0.25rem;
    font-size: 0.88rem;
    color: var(--warn);
  }
  .confirm p {
    margin: 0.1rem 0;
    font-size: 0.84rem;
  }
  .confirm-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.4rem;
  }
  .sync-progress p {
    margin: 0;
    font-size: 0.84rem;
  }
  .applied {
    color: var(--ok);
    font-family: var(--mono);
    font-size: 0.78rem;
  }
  .sync-result {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    border-radius: 8px;
    padding: 0.45rem 0.7rem;
  }
  .sync-result p {
    margin: 0;
    font-size: 0.84rem;
  }
  .sync-result.ok {
    background: color-mix(in srgb, var(--ok) 10%, transparent);
    color: var(--ok);
  }
  .sync-result.error {
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    color: var(--danger);
  }
  button.small {
    font-size: 0.75rem;
    padding: 0.2rem 0.55rem;
  }
</style>
