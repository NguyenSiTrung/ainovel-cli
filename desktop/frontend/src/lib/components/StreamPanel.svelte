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
  .live {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.68rem;
    color: var(--ok);
    background: color-mix(in srgb, var(--ok) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--ok) 40%, transparent);
    border-radius: var(--radius-full);
    padding: 0.05rem 0.45rem;
    text-transform: lowercase;
    font-weight: 600;
  }
  .live::before {
    content: '';
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 5px var(--ok);
  }
  .current {
    font-family: var(--mono);
    font-size: 0.82rem;
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-word;
    flex: 1;
    min-height: 5rem;
    max-height: 14rem;
    overflow-y: auto;
    background: var(--surface-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 0.55rem 0.65rem;
    color: var(--text);
  }
  .empty {
    color: var(--text-faint);
    font-style: italic;
    font-size: 0.78rem;
  }
  .history {
    font-family: var(--mono);
    font-size: 0.74rem;
    line-height: 1.4;
    color: var(--text-dim);
    max-height: 8rem;
    overflow-y: auto;
    margin-top: 0.4rem;
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--surface-0);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-xs);
    padding: 0.4rem 0.5rem;
  }
  .clear-marker {
    color: var(--warn);
    margin: 0.25rem 0;
    user-select: none;
    font-size: 0.7rem;
    opacity: 0.9;
  }
  .channel-tag {
    color: var(--accent);
    font-weight: 500;
  }
</style>
