<script lang="ts">
  /**
   * Stream panel: rendered projection of stream.delta entries with explicit
   * stream.clear boundaries. Completion is signalled by the owning run.*
   * lifecycle event (there is no stream.completion event in desktop-v1), so
   * this panel only projects what arrived.
   */
  import { runState, stream } from '$lib/stores/desktop';

  let entries = $derived($stream.entries);
  let visible = $derived(entries.slice(-120));
  // The engine streams on its named channel (`prose`); pick it, else the
  // store default, else whichever channel most recently carried a delta.
  let currentText = $derived.by(() => {
    const channels = $stream.channels;
    if (channels['prose'] !== undefined) return channels['prose']!.text;
    if (channels['default'] !== undefined) return channels['default']!.text;
    const lastText = [...entries].reverse().find((e) => e.kind === 'text');
    if (lastText && lastText.kind === 'text') return channels[lastText.channel]?.text ?? '';
    return '';
  });
  let run = $derived($runState);
</script>

<aside class="stream-panel" data-testid="stream-panel">
  <h3>
    Stream
    {#if run.status === 'running'}
      <span class="live" data-testid="stream-live">live</span>
    {/if}
  </h3>

  <div class="current" data-testid="stream-current">
    {#if currentText === ''}
      <span class="empty">No active stream.</span>
    {:else}
      {currentText}
    {/if}
  </div>

  {#if visible.length > 0}
    <div class="history" data-testid="stream-history">
      {#each visible as entry, index (entry.sequence * 1000 + index)}
        {#if entry.kind === 'clear'}
          <div class="clear-marker" data-testid="stream-clear-marker">
            ── cleared{entry.reason ? `: ${entry.reason}` : ''} ──
          </div>
        {:else if entry.channel !== 'default'}
          <span class="channel-tag">[{entry.channel}]</span><span class="delta">{entry.text}</span>
        {:else}
          <span class="delta">{entry.text}</span>
        {/if}
      {/each}
    </div>
  {/if}
</aside>

<style>
  .stream-panel {
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
  .live {
    font-size: 0.68rem;
    color: var(--ok);
    border: 1px solid color-mix(in srgb, var(--ok) 50%, transparent);
    border-radius: 999px;
    padding: 0 0.4rem;
    text-transform: lowercase;
  }
  .current {
    font-family: var(--mono);
    font-size: 0.8rem;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 8rem;
    overflow-y: auto;
    background: var(--surface-2);
    border-radius: 6px;
    padding: 0.4rem 0.5rem;
  }
  .empty {
    color: var(--text-faint);
  }
  .history {
    font-family: var(--mono);
    font-size: 0.72rem;
    color: var(--text-dim);
    max-height: 6rem;
    overflow-y: auto;
    margin-top: 0.4rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .clear-marker {
    color: var(--warn);
    margin: 0.2rem 0;
    user-select: none;
  }
  .channel-tag {
    color: var(--text-faint);
  }
</style>
