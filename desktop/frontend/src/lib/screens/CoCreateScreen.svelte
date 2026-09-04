<script lang="ts">
  /**
   * Co-create screen: staged conversation with the engine.
   *
   * Everything here is STAGED content — the conversation, streaming
   * previews, and the draft exist engine-side and never enter the book
   * until the user resumes (cold: starts a run from the draft; stage:
   * applies it to the paused book). The right pane shows durable project
   * facts from the snapshot for explicit contrast.
   *
   * Controls follow the daemon contract: start/stage are acceptances (the
   * reply streams in as cocreate.progress events), resume hands the draft
   * over, cancel tears the session down. Nothing advances locally.
   */
  import MarkdownView from '$lib/components/MarkdownView.svelte';
  import {
    cancelCocreateFromUi,
    cocreateState,
    deriveCocreateControls,
    resumeCocreateFromUi,
    startCocreateFromUi,
    stageCocreateFromUi,
    type CocreateMode,
  } from '$lib/cocreate';
  import { connectionState, projectSnapshot, runState } from '$lib/stores/desktop';
  import { presentError } from '$lib/types/protocol';

  let { title, description, owner }: { title: string; description: string; owner: string } = $props();

  let snapshot = $derived($projectSnapshot);
  let run = $derived($runState);
  let cc = $derived($cocreateState);
  let avail = $derived(deriveCocreateControls(cc, snapshot, $connectionState));

  let message = $state('');
  let startMode = $state<CocreateMode>('cold');

  let errorPresentation = $derived(cc.error ? presentError(cc.error.code) : null);
  let hasSession = $derived(cc.mode !== null);
  let canSend = $derived(
    message.trim() !== '' && (avail.canStage || (avail.canStartCold && startMode === 'cold') || (avail.canStartStage && startMode === 'stage')),
  );

  async function submit(): Promise<void> {
    const text = message;
    const ok = hasSession ? await stageCocreateFromUi(text) : await startCocreateFromUi(text, startMode);
    if (ok) message = '';
  }

  function useSuggestion(suggestion: string): void {
    message = suggestion;
  }
</script>

<section class="cocreate-screen screen" data-testid="cocreate-screen">
  <header class="screen-header">
    <h2>{title}</h2>
    <p class="screen-description">{description} <span class="owner">({owner})</span></p>
  </header>

  {#if snapshot === null}
    <div class="empty-state" data-testid="cocreate-empty">
      <h3>No project open</h3>
      <p>Open or create a project from the Overview screen to co-create.</p>
    </div>
  {:else}
    <p class="staged-banner" data-testid="cocreate-staged-note">
      <span class="staged-badge">staged</span>
      Co-create content is staged engine-side — nothing enters the book until you resume.
    </p>

    <div class="panes">
      <section class="pane conversation-pane" data-testid="cocreate-conversation-pane">
        <h3>
          Conversation
          {#if cc.roundActive}<span class="live" data-testid="cocreate-round-live">round in flight</span>{/if}
        </h3>

        {#if cc.conversation.length === 0 && !cc.roundActive}
          <p class="meta" data-testid="cocreate-conversation-empty">
            Describe the book you want — the engine asks questions and drafts a brief as you chat.
          </p>
        {:else}
          <ol class="turns" data-testid="cocreate-conversation">
            {#each cc.conversation as turn (turn.id)}
              <li class="turn {turn.role}" data-testid="cocreate-turn-{turn.role}">
                <span class="who">{turn.role}</span>
                <div class="body">{turn.text}</div>
              </li>
            {/each}
          </ol>
        {/if}

        {#if cc.roundActive}
          <div class="preview" data-testid="cocreate-preview">
            {#if cc.preview?.thinking}
              <details class="thinking">
                <summary>thinking…</summary>
                <div data-testid="cocreate-preview-thinking">{cc.preview.thinking}</div>
              </details>
            {/if}
            {#if cc.preview?.reply}
              <div class="reply" data-testid="cocreate-preview-reply">{cc.preview.reply}</div>
            {:else}
              <p class="meta">the engine is replying…</p>
            {/if}
          </div>
        {/if}

        {#if cc.roundError}
          <p class="round-error" data-testid="cocreate-round-error">{cc.roundError}</p>
        {/if}

        <div class="composer">
          {#if !hasSession}
            <div class="mode-toggle" data-testid="cocreate-mode">
              <button
                type="button"
                class="segment"
                class:active={startMode === 'cold'}
                onclick={() => (startMode = 'cold')}
                data-testid="cocreate-mode-cold"
              >
                New book (cold start)
              </button>
              <button
                type="button"
                class="segment"
                class:active={startMode === 'stage'}
                onclick={() => (startMode = 'stage')}
                data-testid="cocreate-mode-stage"
              >
                With current book (pauses the run)
              </button>
            </div>
          {/if}
          <textarea
            rows="3"
            placeholder={hasSession ? 'Continue the conversation…' : 'What do you want to write?'}
            bind:value={message}
            disabled={cc.roundActive || cc.pendingStart || cc.pendingStage}
            data-testid="cocreate-message-input"
          ></textarea>
          <button
            type="button"
            class="primary"
            onclick={() => submit()}
            disabled={!canSend}
            data-testid="cocreate-send"
          >
            {cc.pendingStart || cc.pendingStage ? 'Sending…' : hasSession ? 'Send' : 'Start co-create'}
          </button>
        </div>

        {#if cc.draft && cc.draft.suggestions.length > 0 && !cc.roundActive}
          <div class="suggestions" data-testid="cocreate-suggestions">
            {#each cc.draft.suggestions as suggestion, i (i)}
              <button type="button" class="chip" onclick={() => useSuggestion(suggestion)} data-testid="cocreate-suggestion">
                {suggestion}
              </button>
            {/each}
          </div>
        {/if}
      </section>

      <aside class="pane side-pane">
        <section class="draft" data-testid="cocreate-draft-pane">
          <h3>
            Staged draft
            <span class="staged-badge">staged</span>
          </h3>
          {#if cc.draft && cc.draft.text !== ''}
            {#if cc.draft.ready}
              <p class="ready" data-testid="cocreate-draft-ready">the engine considers the draft ready</p>
            {/if}
            <MarkdownView text={cc.draft.text} testid="cocreate-draft" />
            <p class="meta">Refine it by continuing the conversation; resume hands this exact engine-side draft over.</p>
          {:else}
            <p class="meta" data-testid="cocreate-draft-empty">
              No draft yet — keep chatting; the engine accumulates the brief as the conversation progresses.
            </p>
          {/if}

          <div class="actions">
            <button
              type="button"
              class="primary"
              onclick={() => resumeCocreateFromUi()}
              disabled={!avail.canResume}
              title={cc.draft && cc.draft.text === '' ? 'continue the conversation until a draft exists' : ''}
              data-testid="cocreate-resume"
            >
              {cc.pendingResume ? 'Resuming…' : cc.mode === 'stage' ? 'Apply to the book' : 'Start run from draft'}
            </button>
            <button
              type="button"
              onclick={() => cancelCocreateFromUi()}
              disabled={!avail.canCancel}
              data-testid="cocreate-cancel"
            >
              {cc.pendingCancel ? 'Cancelling…' : 'Cancel session'}
            </button>
          </div>
          {#if !avail.canResume && hasSession && !cc.roundActive && cc.draft && cc.draft.text === ''}
            <p class="meta">Resume unlocks once the engine has drafted a non-empty brief.</p>
          {/if}
          {#if cc.lastResumed}
            <p class="ok" data-testid="cocreate-resumed-note">{cc.message}</p>
          {/if}
          {#if cc.message && !cc.lastResumed}
            <p class="meta" data-testid="cocreate-message">{cc.message}</p>
          {/if}
          {#if cc.error}
            <div class="error-box" data-testid="cocreate-error">
              <p>{errorPresentation?.title} — {cc.error.message} <span class="code">[{cc.error.code}]</span></p>
              {#if errorPresentation?.action}<p class="meta">{errorPresentation.action}</p>{/if}
            </div>
          {/if}
        </section>

        <section class="facts" data-testid="cocreate-facts">
          <h3>Project facts <span class="durable-badge">durable</span></h3>
          <dl class="fact-list">
            <div><dt>Book</dt><dd>{snapshot.book_title ?? '—'}</dd></div>
            <div><dt>Chapters</dt><dd>{snapshot.completed_chapters ?? 0}/{snapshot.total_chapters ?? '?'}</dd></div>
            <div><dt>Run</dt><dd data-testid="cocreate-facts-run">{run.status}</dd></div>
          </dl>
          <p class="meta">These live in the project; co-create output does not touch them until resume.</p>
        </section>
      </aside>
    </div>
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
  .staged-banner {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 0;
    padding: 0.5rem 0.85rem;
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.82rem;
    color: var(--text-dim);
  }
  .staged-badge,
  .durable-badge {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    border-radius: var(--radius-full);
    padding: 0.1rem 0.55rem;
    font-weight: 600;
    white-space: nowrap;
  }
  .staged-badge {
    border: 1px solid color-mix(in srgb, var(--warn) 55%, transparent);
    background: var(--warn-subtle);
    color: var(--warn);
  }
  .durable-badge {
    border: 1px solid color-mix(in srgb, var(--ok) 55%, transparent);
    background: var(--ok-subtle);
    color: var(--ok);
  }
  .panes {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(17rem, 23rem);
    gap: 0.85rem;
    flex: 1;
    min-height: 26rem;
  }
  .pane {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1rem 1.15rem;
    overflow-y: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .pane h3 {
    margin: 0;
    font-size: 0.74rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .live {
    font-size: 0.68rem;
    color: var(--ok);
    background: var(--ok-subtle);
    border: 1px solid color-mix(in srgb, var(--ok) 40%, transparent);
    border-radius: var(--radius-full);
    padding: 0.05rem 0.5rem;
    font-weight: 600;
    text-transform: none;
    letter-spacing: normal;
  }
  .meta {
    margin: 0.2rem 0;
    color: var(--text-faint);
    font-size: 0.82rem;
  }
  .turns {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .turn {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.75rem 1rem;
    background: var(--surface-2);
    font-size: 0.88rem;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .turn.user {
    background: color-mix(in srgb, var(--accent) 8%, var(--surface-2));
    border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .turn .who {
    display: block;
    font-family: var(--mono);
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
    margin-bottom: 0.3rem;
    font-weight: 600;
  }
  .turn.user .who {
    color: var(--accent);
  }
  .preview {
    border: 1px dashed color-mix(in srgb, var(--ok) 45%, transparent);
    background: color-mix(in srgb, var(--ok) 5%, transparent);
    border-radius: var(--radius-md);
    padding: 0.75rem 1rem;
    font-size: 0.86rem;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }
  .preview .thinking {
    color: var(--text-dim);
    font-size: 0.8rem;
    background: var(--surface-2);
    padding: 0.4rem 0.65rem;
    border-radius: var(--radius-xs);
    border: 1px solid var(--border-subtle);
  }
  .preview .thinking summary {
    cursor: pointer;
    font-family: var(--mono);
    color: var(--text-faint);
    font-size: 0.74rem;
  }
  .preview .thinking div {
    margin-top: 0.35rem;
    font-family: var(--mono);
    white-space: pre-wrap;
  }
  .preview .reply {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
  }
  .round-error {
    margin: 0;
    color: var(--danger);
    font-size: 0.84rem;
    border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
    background: var(--danger-subtle);
    border-radius: var(--radius-sm);
    padding: 0.5rem 0.75rem;
  }
  .composer {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    margin-top: auto;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border-subtle);
  }
  .mode-toggle {
    display: flex;
    gap: 0.45rem;
    background: var(--surface-2);
    padding: 0.2rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
    width: fit-content;
  }
  .segment {
    font-size: 0.76rem;
    padding: 0.2rem 0.65rem;
    border-radius: var(--radius-full);
    background: transparent;
    border: 1px solid transparent;
    color: var(--text-dim);
  }
  .segment.active {
    background: var(--surface-3);
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
    color: var(--accent);
    font-weight: 600;
  }
  .composer textarea {
    resize: vertical;
    font-size: 0.88rem;
    line-height: 1.5;
    min-height: 4rem;
  }
  .suggestions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .chip {
    font-size: 0.75rem;
    padding: 0.2rem 0.65rem;
    border-radius: var(--radius-full);
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    cursor: pointer;
    transition: background var(--transition-fast), border-color var(--transition-fast);
  }
  .chip:hover {
    background: var(--surface-3);
    border-color: var(--accent);
  }
  .side-pane .draft,
  .side-pane .facts {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
  .ready {
    margin: 0;
    color: var(--ok);
    font-size: 0.8rem;
    font-weight: 500;
    background: var(--ok-subtle);
    padding: 0.35rem 0.65rem;
    border-radius: var(--radius-xs);
    border: 1px solid color-mix(in srgb, var(--ok) 30%, transparent);
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .ok {
    margin: 0;
    color: var(--ok);
    font-size: 0.82rem;
    font-weight: 500;
  }
  .fact-list {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.65rem 0.8rem;
    background: var(--surface-2);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
  }
  .fact-list div {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.82rem;
  }
  .fact-list dt {
    color: var(--text-dim);
    flex: none;
  }
  .fact-list dd {
    margin: 0;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .error-box {
    border: 1px solid color-mix(in srgb, var(--danger) 50%, transparent);
    background: var(--danger-subtle);
    border-radius: var(--radius-sm);
    padding: 0.55rem 0.75rem;
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
</style>
