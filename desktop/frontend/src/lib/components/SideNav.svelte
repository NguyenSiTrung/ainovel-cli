<script lang="ts">
  /**
   * Primary navigation across the task 5-8 screens. Navigation goes through
   * `navigate` so registered guards (unsaved chapter edits) can block a route
   * change and demand an explicit user decision first.
   */
  import { ROUTES, currentRoute, navigate } from '$lib/routes';

  let active = $derived($currentRoute);
</script>

<nav class="side-nav" data-testid="side-nav" aria-label="Primary">
  <ul>
    {#each ROUTES as route (route.id)}
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
          {route.label}
        </a>
      </li>
    {/each}
  </ul>
</nav>

<style>
  .side-nav {
    padding: 0.75rem 0.5rem;
    border-right: 1px solid var(--border);
    background: var(--surface-1);
    min-width: 11rem;
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
    display: block;
    padding: 0.4rem 0.65rem;
    border-radius: 6px;
    color: var(--text-dim);
    text-decoration: none;
    font-size: 0.9rem;
  }
  a:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  a.active {
    background: var(--surface-3);
    color: var(--text);
    font-weight: 600;
  }
</style>
