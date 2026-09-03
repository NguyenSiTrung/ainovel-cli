<script lang="ts">
  /**
   * Application shell: project switcher + status header, navigation, the
   * active workspace route, and the activity/stream panels. Pure
   * presentation over the desktop stores; commands fire only on user
   * gesture. Task 5-8 screens mount inside the workspace slot.
   */
  import { currentRoute, routeById, routeStrings } from '$lib/routes';
  import { currentLanguage } from '$lib/locale';
  import ActivityPanel from './ActivityPanel.svelte';
  import HeaderBar from './HeaderBar.svelte';
  import NotificationToasts from './NotificationToasts.svelte';
  import RecoveryCard from './RecoveryCard.svelte';
  import SideNav from './SideNav.svelte';
  import SnapshotErrorBanner from './SnapshotErrorBanner.svelte';
  import StreamPanel from './StreamPanel.svelte';
  import UnsavedGuardCard from './UnsavedGuardCard.svelte';

  // Component identity comes from the static registry; chrome strings
  // re-resolve live on locale switch.
  let route = $derived(routeById($currentRoute));
  const Screen = $derived(route.component);
  let strings = $derived.by(() => {
    void $currentLanguage;
    return routeStrings($currentRoute);
  });
</script>

<div class="app-shell" data-testid="app-shell">
  <HeaderBar />
  <div class="shell-body">
    <SideNav />
    <main class="workspace" data-testid="workspace">
      <SnapshotErrorBanner />
      <RecoveryCard />
      <UnsavedGuardCard />
      <Screen title={strings.label} description={strings.description} owner={route.owner} />
    </main>
    <aside class="side-panels" data-testid="side-panels">
      <StreamPanel />
      <ActivityPanel />
    </aside>
  </div>
  <NotificationToasts />
</div>

<style>
  .app-shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  .shell-body {
    display: grid;
    grid-template-columns: auto 1fr 20rem;
    flex: 1;
    min-height: 0;
  }
  .workspace {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .side-panels {
    display: grid;
    grid-template-rows: minmax(12rem, 1fr) minmax(12rem, 1fr);
    gap: 0.5rem;
    padding: 0.5rem;
    border-left: 1px solid var(--border);
    background: var(--surface-1);
    min-height: 0;
    overflow: hidden;
  }
</style>
