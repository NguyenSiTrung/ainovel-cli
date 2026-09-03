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
    min-height: 0;
    overflow: hidden;
  }
  h3 {
    margin: 0 0 0.4rem;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-faint);
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .count {
    font-size: 0.72rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 0 0.4rem;
    color: var(--text-dim);
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  li {
    display: flex;
    gap: 0.45rem;
    align-items: baseline;
    font-size: 0.76rem;
    font-family: var(--mono);
    padding: 0.1rem 0.2rem;
    border-radius: 4px;
  }
  li:hover {
    background: var(--surface-2);
  }
  .seq {
    color: var(--text-faint);
    min-width: 2.5rem;
    text-align: right;
  }
  .name {
    color: var(--accent);
    white-space: nowrap;
  }
  .summary {
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .empty {
    color: var(--text-faint);
    font-size: 0.8rem;
  }
</style>
