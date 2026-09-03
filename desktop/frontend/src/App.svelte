<script lang="ts">
  /**
   * Root component: mounts the shell and runs the startup handshake
   * (status -> start-if-needed -> subscribe -> snapshot/replay). All
   * projection state lives in the desktop stores.
   */
  import { onMount } from 'svelte';

  import AppShell from '$lib/components/AppShell.svelte';
  import { initDesktop } from '$lib/stores/desktop';

  onMount(() => {
    void initDesktop().catch(() => {
      // initDesktop reports its own failures through the notification store.
    });
  });
</script>

<AppShell />
