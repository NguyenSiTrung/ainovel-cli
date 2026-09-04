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
    clearNotifications,
    dismissNotification,
    notificationPrefs,
    notificationVisible,
    notifications,
  } from '$lib/stores/desktop';
  import { presentError } from '$lib/types/protocol';

  let visible = $derived($notifications.filter((note) => notificationVisible(note, $notificationPrefs)).slice(-6));
</script>

<div class="toasts" data-testid="notification-toasts" aria-live="polite">
  {#if visible.length > 1}
    <div class="toasts-actions">
      <button
        type="button"
        class="clear-all-btn"
        onclick={() => clearNotifications()}
        data-testid="clear-all-notifications"
      >
        Clear all
      </button>
    </div>
  {/if}
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
  .toasts-actions {
    display: flex;
    justify-content: flex-end;
  }
  .clear-all-btn {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 6px);
    color: var(--text-dim);
    font-size: 0.76rem;
    font-weight: 500;
    padding: 0.2rem 0.55rem;
    cursor: pointer;
    box-shadow: 0 2px 6px rgb(0 0 0 / 25%);
    transition: background var(--transition-fast, 120ms ease), color var(--transition-fast, 120ms ease), border-color var(--transition-fast, 120ms ease);
  }
  .clear-all-btn:hover {
    background: var(--surface-3);
    color: var(--text);
    border-color: var(--border-hover);
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
