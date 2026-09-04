<script lang="ts">
  /**
   * Primary navigation across the task 5-8 screens. Navigation goes through
   * `navigate` so registered guards (unsaved chapter edits) can block a route
   * change and demand an explicit user decision first.
   */
  import { currentRoute, navigate, routeStrings, ROUTES, type RouteId } from '$lib/routes';
  import { currentLanguage } from '$lib/locale';
  import { runState } from '$lib/stores/desktop';
  import { editorDirty } from '$lib/chapters';

  let active = $derived($currentRoute);
  let run = $derived($runState);
  let dirty = $derived($editorDirty);

  // Subscribe to locale switches so labels re-render; strings resolve live.
  let labels = $derived.by(() => {
    void $currentLanguage;
    return new Map(ROUTES.map((r) => [r.id, routeStrings(r.id)] as const));
  });

  interface NavGroup {
    title: string;
    routes: RouteId[];
  }

  const GROUPS: NavGroup[] = [
    {
      title: 'Studio',
      routes: ['overview', 'write', 'chapters', 'cocreate', 'artifacts'],
    },
    {
      title: 'Workshop',
      routes: ['simulation', 'import', 'export'],
    },
    {
      title: 'System',
      routes: ['diagnostics', 'settings'],
    },
  ];

  function getRoute(id: RouteId) {
    return ROUTES.find((r) => r.id === id);
  }
</script>

<nav class="side-nav" data-testid="side-nav" aria-label="Primary">
  <div class="nav-groups">
    {#each GROUPS as group}
      <div class="nav-group">
        <span class="group-title">{group.title}</span>
        <ul>
          {#each group.routes as routeId}
            {@const route = getRoute(routeId)}
            {#if route}
              <li>
                <a
                  href="#{route.id}"
                  class:active={active === route.id}
                  onclick={(event) => {
                    event.preventDefault();
                    navigate(route.id);
                  }}
                  data-testid={`nav-${route.id}`}
                >
                  {#if route.id === 'overview'}
                    <svg class="nav-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="7" height="9" x="3" y="3" rx="1" /><rect width="7" height="5" x="14" y="3" rx="1" /><rect width="7" height="9" x="14" y="12" rx="1" /><rect width="7" height="5" x="3" y="16" rx="1" /></svg>
                  {:else if route.id === 'write'}
                    <svg class="nav-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>
                  {:else if route.id === 'chapters'}
                    <svg class="nav-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1-2.5-2.5Z" /><path d="M6 6h10" /><path d="M6 10h10" /></svg>
                  {:else if route.id === 'artifacts'}
                    <svg class="nav-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
                  {:else if route.id === 'cocreate'}
                    <svg class="nav-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 21 1.9-5.7a8.5 8.5 0 1 1 3.8 3.8z" /></svg>
                  {:else if route.id === 'import'}
                    <svg class="nav-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" /></svg>
                  {:else if route.id === 'simulation'}
                    <svg class="nav-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12h5l3 5 4-10 3 5h5" /></svg>
                  {:else if route.id === 'export'}
                    <svg class="nav-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" x2="12" y1="3" y2="15" /></svg>
                  {:else if route.id === 'diagnostics'}
                    <svg class="nav-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" /><line x1="12" x2="12" y1="9" y2="13" /><line x1="12" x2="12.01" y1="17" y2="17" /></svg>
                  {:else if route.id === 'settings'}
                    <svg class="nav-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
                  {/if}{labels.get(route.id)?.label ?? route.label}{#if route.id === 'write' && run.status === 'running'}<span class="status-indicator running" aria-hidden="true"></span>{:else if route.id === 'chapters' && dirty}<span class="status-indicator dirty" aria-hidden="true"></span>{/if}</a>
              </li>
            {/if}
          {/each}
        </ul>
      </div>
    {/each}
  </div>
</nav>

<style>
  .side-nav {
    padding: 0.85rem 0.6rem;
    border-right: 1px solid var(--border);
    background: var(--surface-1);
    min-width: 12.5rem;
    overflow-y: auto;
  }
  .nav-groups {
    display: flex;
    flex-direction: column;
    gap: 1.1rem;
  }
  .nav-group {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .group-title {
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
    padding: 0 0.6rem 0.2rem;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  a {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.42rem 0.65rem;
    border-radius: var(--radius-sm);
    color: var(--text-dim);
    text-decoration: none;
    font-size: 0.86rem;
    font-weight: 500;
    transition: background var(--transition-fast), color var(--transition-fast);
    position: relative;
  }
  a:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  a.active {
    background: var(--surface-2);
    color: var(--accent);
    font-weight: 600;
  }
  a.active::before {
    content: '';
    position: absolute;
    left: 0;
    top: 25%;
    height: 50%;
    width: 3px;
    background: var(--accent);
    border-radius: 0 var(--radius-xs) var(--radius-xs) 0;
  }
  .nav-icon {
    flex-shrink: 0;
    opacity: 0.75;
    transition: opacity var(--transition-fast), transform var(--transition-fast);
  }
  a:hover .nav-icon,
  a.active .nav-icon {
    opacity: 1;
  }
  .status-indicator {
    margin-left: auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .status-indicator.running {
    background: var(--ok);
    box-shadow: 0 0 6px var(--ok);
    animation: pulse 2s infinite;
  }
  .status-indicator.dirty {
    background: var(--warn);
    box-shadow: 0 0 6px var(--warn);
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
</style>
