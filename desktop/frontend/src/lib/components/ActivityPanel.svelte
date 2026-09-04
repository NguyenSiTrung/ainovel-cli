<script lang="ts">
  /**
   * Activity panel: bounded, append-only projection of engine events with
   * their (session, sequence) coordinates. Newest entries render first.
   */
  import { activity } from '$lib/stores/desktop';

  let entries = $derived($activity);
  let visible = $derived(entries.slice(-80).reverse());
</script>

<aside class="activity-panel" data-testid="activity-panel">
  <h3>
    Activity
    <span class="count">{entries.length}</span>
  </h3>
  {#if visible.length === 0}
    <p class="empty">No engine events yet.</p>
  {:else}
    <ul>
      {#each visible as entry (entry.id)}
        <li>
          <span class="seq" title={`session ${entry.session ?? '?'} · sequence ${entry.sequence}`}>
            {entry.sequence}
          </span>
          <span class="name">{entry.event}</span>
          {#if entry.summary}
            <span class="summary">{entry.summary}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  .activity-panel {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: var(--surface-1);
  }
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.76rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-weight: 700;
  }
  .count {
    font-size: 0.68rem;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    padding: 0.05rem 0.45rem;
    color: var(--text-dim);
    font-weight: 600;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  li {
    display: flex;
    gap: 0.45rem;
    align-items: center;
    font-size: 0.76rem;
    font-family: var(--mono);
    padding: 0.2rem 0.35rem;
    border-radius: var(--radius-xs);
    border: 1px solid transparent;
    transition: background var(--transition-fast);
  }
  li:hover {
    background: var(--surface-2);
    border-color: var(--border-subtle);
  }
  .seq {
    color: var(--text-faint);
    min-width: 2.2rem;
    text-align: right;
    font-size: 0.7rem;
  }
  .name {
    color: var(--accent);
    font-weight: 500;
    white-space: nowrap;
    font-size: 0.74rem;
  }
  .summary {
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.72rem;
  }
  .empty {
    color: var(--text-faint);
    font-size: 0.78rem;
    font-style: italic;
  }
</style>
