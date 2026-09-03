<script lang="ts">
  /**
   * Global snapshot-error surface: renders the last structured error from
   * project.snapshot (other than "no project open", which is a normal
   * state, not an error).
   */
  import { snapshotError } from '$lib/stores/desktop';

  import ErrorBanner from './ErrorBanner.svelte';

  let error = $derived($snapshotError);
</script>

{#if error}
  <div class="snapshot-error-slot" data-testid="snapshot-error-slot">
    <ErrorBanner error={error} onDismiss={() => ($snapshotError = null)} />
  </div>
{/if}

<style>
  .snapshot-error-slot {
    padding: 0 1rem;
  }
</style>
