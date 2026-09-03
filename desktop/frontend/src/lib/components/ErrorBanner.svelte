<script lang="ts">
  /**
   * Error presentation for structured `{code, message, details?}` errors:
   * all 9 protocol codes + 4 shell codes (and unknown additive codes) map
   * to a user-presentable title, description, severity, and suggested
   * action via the error catalog.
   */
  import { presentError, type StructuredError } from '$lib/types/protocol';

  let {
    error,
    onDismiss,
    dismissible = true,
  }: {
    error: StructuredError;
    onDismiss?: () => void;
    dismissible?: boolean;
  } = $props();

  let presentation = $derived(presentError(error.code));
</script>

<div class="error-banner {presentation.severity}" role="alert" data-testid="error-banner">
  <div class="error-main">
    <strong>{presentation.title}</strong>
    <span class="error-code">[{error.code}]</span>
  </div>
  <p class="error-message">{error.message}</p>
  {#if presentation.description}
    <p class="error-description">{presentation.description}</p>
  {/if}
  {#if presentation.action}
    <p class="error-action">Suggested action: {presentation.action}</p>
  {/if}
  {#if dismissible && onDismiss}
    <button type="button" class="dismiss" onclick={onDismiss} data-testid="error-dismiss">
      Dismiss
    </button>
  {/if}
</div>

<style>
  .error-banner {
    border: 1px solid var(--border);
    border-left-width: 3px;
    border-radius: 8px;
    padding: 0.6rem 0.8rem;
    background: var(--surface-2);
    font-size: 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    position: relative;
  }
  .error-banner.error {
    border-left-color: var(--danger);
  }
  .error-banner.warning {
    border-left-color: var(--warn);
  }
  .error-banner.info {
    border-left-color: var(--accent);
  }
  .error-main {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .error-code {
    font-family: var(--mono);
    font-size: 0.72rem;
    color: var(--text-faint);
  }
  .error-message {
    margin: 0;
    color: var(--text);
  }
  .error-description,
  .error-action {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.8rem;
  }
  .error-action {
    color: var(--text-faint);
  }
  .dismiss {
    position: absolute;
    top: 0.4rem;
    right: 0.5rem;
    background: none;
    border: none;
    color: var(--text-faint);
    cursor: pointer;
    font-size: 0.78rem;
  }
</style>
