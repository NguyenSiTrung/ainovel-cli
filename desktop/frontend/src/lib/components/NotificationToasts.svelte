<script lang="ts">
  /**
   * Toast notifications driven by structured error codes and engine
   * notification events. Manual dismissal keeps behavior deterministic.
   * Notifications routed to a category the user muted in Settings
   * (completion / pause / warning / failure) stay out of the toast layer —
   * they are still recorded in the notifications store and the Overview
   * error list; uncategorized ones (request errors, info notes) always show.
   */
  import {
    dismissNotification,
    notificationPrefs,
    notificationVisible,
    notifications,
  } from '$lib/stores/desktop';
  import { presentError } from '$lib/types/protocol';

  let visible = $derived($notifications.filter((note) => notificationVisible(note, $notificationPrefs)).slice(-6));
</script>

<div class="toasts" data-testid="notification-toasts" aria-live="polite">
  {#each visible as note (note.id)}
    <div class="toast {note.level}" data-testid={`toast-${note.level}`}>
      <div class="toast-body">
        <span class="toast-title">
          {#if note.code}
            {presentError(note.code).title}:
          {:else}
            {note.level === 'error' ? 'Error' : note.level === 'warning' ? 'Warning' : 'Note'}:
          {/if}
        </span>
        {note.message}
      </div>
      <button
        type="button"
        class="dismiss"
        onclick={() => dismissNotification(note.id)}
        aria-label="Dismiss"
        data-testid={`dismiss-${note.id}`}
      >
        ×
      </button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    right: 1rem;
    bottom: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: 26rem;
    z-index: 100;
  }
  .toast {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-left-width: 3px;
    border-radius: 8px;
    padding: 0.5rem 0.6rem;
    box-shadow: 0 4px 14px rgb(0 0 0 / 30%);
    font-size: 0.82rem;
  }
  .toast.error {
    border-left-color: var(--danger);
  }
  .toast.warning {
    border-left-color: var(--warn);
  }
  .toast.info {
    border-left-color: var(--accent);
  }
  .toast-body {
    flex: 1;
    overflow-wrap: anywhere;
  }
  .toast-title {
    font-weight: 600;
  }
  .dismiss {
    background: none;
    border: none;
    color: var(--text-faint);
    font-size: 1rem;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }
</style>
