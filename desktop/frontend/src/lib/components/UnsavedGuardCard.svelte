<script lang="ts">
  /**
   * Unsaved-chapter guard: rendered by the shell whenever the chapters
   * controller parked a dirty-editor decision (chapter switch, editor close,
   * or route navigation). The user explicitly chooses save / discard / stay;
   * nothing is dropped or written without that choice.
   */
  import { chapterEditor, chapterGuard, guardDiscardAndProceed, guardSaveAndProceed, guardStay, guardSaving } from '$lib/chapters';

  let guard = $derived($chapterGuard);
  let editor = $derived($chapterEditor);
  let saving = $derived($guardSaving);

  let subject = $derived.by(() => {
    if (!guard) return '';
    if (guard.kind === 'switch') return `open chapter ${guard.targetChapter}`;
    if (guard.kind === 'navigate') return `leave this screen for ${guard.target}`;
    if (guard.kind === 'stop-edit') return 'stop editing';
    return 'close the chapter';
  });
</script>

{#if guard && editor.chapter !== null}
  <div class="guard-card" role="alertdialog" aria-label="Unsaved chapter changes" data-testid="unsaved-guard">
    <div class="guard-body">
      <h4>Unsaved changes in chapter {editor.chapter}</h4>
      <p>
        You have edits that are not saved yet. Choose what to do before you {subject}.
      </p>
    </div>
    <div class="guard-actions">
      <button
        type="button"
        class="primary"
        onclick={() => guardSaveAndProceed()}
        disabled={saving}
        data-testid="guard-save-proceed"
      >
        {saving ? 'Saving…' : 'Save & continue'}
      </button>
      <button type="button" class="danger" onclick={() => guardDiscardAndProceed()} data-testid="guard-discard-proceed">
        Discard edits & continue
      </button>
      <button type="button" onclick={() => guardStay()} data-testid="guard-stay">Keep editing</button>
    </div>
  </div>
{/if}

<style>
  .guard-card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.7rem 0.9rem;
    background: color-mix(in srgb, var(--warn) 10%, var(--surface-1));
    border: 1px solid color-mix(in srgb, var(--warn) 55%, transparent);
    border-radius: 8px;
  }
  h4 {
    margin: 0;
    font-size: 0.9rem;
    color: var(--warn);
  }
  .guard-body p {
    margin: 0.15rem 0 0;
    color: var(--text-dim);
    font-size: 0.84rem;
  }
  .guard-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
</style>
