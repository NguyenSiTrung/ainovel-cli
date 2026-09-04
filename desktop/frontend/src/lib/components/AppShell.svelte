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

  // Collapsible and tabbed side-dock state
  let sidePanelOpen = $state(true);
  let sideTab = $state<'all' | 'stream' | 'activity'>('all');

  function toggleSidePanel(): void {
    sidePanelOpen = !sidePanelOpen;
  }

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
  <HeaderBar {sidePanelOpen} onToggleInspector={toggleSidePanel} />
  <div class="shell-body" class:panel-collapsed={!sidePanelOpen}>
    <SideNav />
    <main class="workspace" data-testid="workspace">
      <SnapshotErrorBanner />
      <RecoveryCard />
      <UnsavedGuardCard />
      <Screen title={strings.label} description={strings.description} owner={route.owner} />
    </main>

    {#if !sidePanelOpen}
      <button
        type="button"
        class="expand-dock-button"
        onclick={toggleSidePanel}
        title="Open Live Inspector"
        aria-label="Open Live Inspector"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M15 3v18" />
          <path d="m10 15-3-3 3-3" />
        </svg>
        <span>Inspector</span>
      </button>
    {/if}

    <aside class="side-panels" class:collapsed={!sidePanelOpen} data-testid="side-panels">
      <div class="dock-header">
        <div class="dock-title-group">
          <span class="dock-title">Live Inspector</span>
          <div class="dock-tabs">
            <button
              type="button"
              class="dock-tab"
              class:active={sideTab === 'all'}
              onclick={() => (sideTab = 'all')}
            >
              Split
            </button>
            <button
              type="button"
              class="dock-tab"
              class:active={sideTab === 'stream'}
              onclick={() => (sideTab = 'stream')}
            >
              Stream
            </button>
            <button
              type="button"
              class="dock-tab"
              class:active={sideTab === 'activity'}
              onclick={() => (sideTab = 'activity')}
            >
              Activity
            </button>
          </div>
        </div>
        <button
          type="button"
          class="dock-close-button ghost"
          onclick={toggleSidePanel}
          title="Collapse inspector"
          aria-label="Collapse inspector"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      </div>

      <div class="dock-content dock-{sideTab}">
        <div class="panel-slot panel-stream" class:hidden-slot={sideTab === 'activity'}>
          <StreamPanel />
        </div>
        <div class="panel-slot panel-activity" class:hidden-slot={sideTab === 'stream'}>
          <ActivityPanel />
        </div>
      </div>
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
    background: var(--bg);
  }
  .shell-body {
    display: grid;
    grid-template-columns: auto 1fr 21.5rem;
    flex: 1;
    min-height: 0;
    position: relative;
    transition: grid-template-columns var(--transition-normal);
  }
  .shell-body.panel-collapsed {
    grid-template-columns: auto 1fr 0px;
  }
  .workspace {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    background: var(--bg);
  }
  .side-panels {
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border);
    background: var(--surface-1);
    min-height: 0;
    overflow: hidden;
    width: 21.5rem;
    transition: width var(--transition-normal), opacity var(--transition-fast);
  }
  .side-panels.collapsed {
    width: 0;
    border-left-color: transparent;
    opacity: 0;
    pointer-events: none;
  }
  .dock-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.65rem;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-2);
  }
  .dock-title-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .dock-title {
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
  }
  .dock-tabs {
    display: flex;
    background: var(--surface-1);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-xs);
    padding: 1px;
  }
  .dock-tab {
    background: transparent;
    border: none;
    border-radius: 3px;
    padding: 0.15rem 0.4rem;
    font-size: 0.7rem;
    color: var(--text-faint);
    cursor: pointer;
  }
  .dock-tab:hover {
    color: var(--text);
  }
  .dock-tab.active {
    background: var(--surface-3);
    color: var(--text);
    font-weight: 600;
  }
  .dock-close-button {
    padding: 0.2rem 0.35rem;
    color: var(--text-faint);
    border-radius: var(--radius-xs);
  }
  .dock-close-button:hover {
    color: var(--text);
  }
  .dock-content {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    padding: 0.5rem;
    gap: 0.5rem;
  }
  .dock-content.dock-all {
    display: grid;
    grid-template-rows: minmax(10rem, 1.2fr) minmax(10rem, 1fr);
  }
  .panel-slot {
    display: flex;
    flex-direction: column;
    min-height: 0;
    overflow: hidden;
  }
  .panel-slot.hidden-slot {
    display: none;
  }
  .expand-dock-button {
    position: absolute;
    right: 0.75rem;
    top: 0.75rem;
    z-index: 10;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    padding: 0.3rem 0.65rem;
    font-size: 0.75rem;
    color: var(--text-dim);
    box-shadow: var(--shadow-sm);
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }
  .expand-dock-button:hover {
    background: var(--surface-3);
    color: var(--text);
    border-color: var(--border-hover);
  }
</style>
