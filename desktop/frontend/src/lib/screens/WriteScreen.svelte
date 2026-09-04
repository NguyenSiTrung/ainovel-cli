<script lang="ts">
  /**
   * Write screen: plan / content / facts-activity panes.
   *
   * - Plan pane projects the engine's outline + flow/phase/step and run
   *   progress straight from the snapshot and run.* events.
   * - Content pane renders the stream with ROUND SEPARATION: worker rounds
   *   are delimited by stream.clear markers; previously streamed (persisted)
   *   rounds stay visible above the current one, and generated content is
   *   rendered as markdown (plain text passes through unchanged).
   * - Facts pane shows project facts plus writing-relevant recent activity.
   *
   * All controls live in the shared RunControls component (bottom).
   */
  import MarkdownView from '$lib/components/MarkdownView.svelte';
  import RunControls from '$lib/components/RunControls.svelte';
  import { deriveRunControls } from '$lib/runControls';
  import { activity, connectionState, projectSnapshot, runState, stream } from '$lib/stores/desktop';
  import type { StreamEntry, StreamState } from '$lib/types/protocol';

  let { title, description, owner }: { title: string; description: string; owner: string } = $props();

  let snapshot = $derived($projectSnapshot);
  let run = $derived($runState);
  let avail = $derived(deriveRunControls(snapshot, run, $connectionState));

  // -----------------------------------------------------------------------
  // Stream rounds: entries split into rounds on stream.clear markers.
  // -----------------------------------------------------------------------

  interface StreamRound {
    id: string;
    channel: string;
    index: number;
    text: string;
    live: boolean;
    clearReason?: string;
    startSequence: number;
  }

  function roundsFromStream(state: StreamState, entryWindow = 600): StreamRound[] {
    const recent: StreamEntry[] = state.entries.slice(-entryWindow);
    const rounds: StreamRound[] = [];
    const liveByChannel = new Map<string, StreamRound>();
    const nextIndex: Record<string, number> = {};
    for (const entry of recent) {
      const indexBase = (nextIndex[entry.channel] ?? 0) + 1;
      if (entry.kind === 'text') {
        let round = liveByChannel.get(entry.channel);
        if (!round) {
          nextIndex[entry.channel] = indexBase;
          round = {
            id: `${entry.channel}-${indexBase}-${entry.sequence}`,
            channel: entry.channel,
            index: indexBase,
            text: '',
            live: true,
            startSequence: entry.sequence,
          };
          liveByChannel.set(entry.channel, round);
          rounds.push(round);
        }
        round.text += entry.text;
      } else {
        const round = liveByChannel.get(entry.channel);
        if (round && round.text !== '') {
          // stream.clear closes the current worker round; its content stays
          // visible (persisted rounds are never dropped by the UI).
          round.live = false;
          round.clearReason = entry.reason;
          liveByChannel.delete(entry.channel);
        }
        // A clear with no accumulated text carries nothing to separate.
      }
    }
    return rounds;
  }

  let rounds = $derived(roundsFromStream($stream));
  let channels = $derived([...new Set(rounds.map((r) => r.channel))]);

  // -----------------------------------------------------------------------
  // Facts pane inputs.
  // -----------------------------------------------------------------------

  const WRITING_EVENTS = new Set([
    'run.started',
    'run.step_changed',
    'run.progress',
    'run.paused',
    'run.completed',
    'run.failed',
    'run.aborted',
    'chapter.updated',
    'artifact.updated',
    'outline.updated',
    'checkpoint.created',
  ]);
  let writingActivity = $derived($activity.filter((a) => WRITING_EVENTS.has(a.event)).slice(-12).reverse());
  let outline = $derived(Array.isArray(snapshot?.outline) ? snapshot!.outline : []);
</script>

<section class="write-screen screen" data-testid="write-screen">
  <header class="screen-header">
    <h2>{title}</h2>
    <p class="screen-description">{description} <span class="owner">({owner})</span></p>
  </header>

  {#if snapshot === null}
    <div class="empty-state" data-testid="write-empty">
      <h3>No project open</h3>
      <p>Open or create a project from the Overview screen to start writing.</p>
    </div>
  {:else}
    <div class="panes">
      <aside class="pane plan-pane" data-testid="write-pane-plan">
        <h3>Plan</h3>
        <dl class="facts">
          <div><dt>Phase</dt><dd>{snapshot.phase ?? '—'}</dd></div>
          {#if snapshot.flow}
            <div><dt>Flow</dt><dd>{snapshot.flow}</dd></div>
          {/if}
          <div><dt>Step</dt><dd data-testid="write-plan-step">{run.step ?? '—'}</dd></div>
          <div><dt>Run</dt><dd data-testid="write-plan-run">{run.status}</dd></div>
          {#if run.progress?.total !== undefined}
            <div><dt>Progress</dt><dd>{run.progress.completed ?? 0}/{run.progress.total}</dd></div>
          {/if}
          <div><dt>Mode</dt><dd>{avail.advanceMode ?? snapshot.advance_mode ?? '—'}</dd></div>
          {#if snapshot.has_advance_hold}
            <div class="hold"><dt>Gate</dt><dd>holding at chapter {snapshot.advance_permit_chapter ?? '?'}</dd></div>
          {/if}
        </dl>

        <h4>Outline ({snapshot.total_chapters ?? outline.length} chapters)</h4>
        {#if outline.length === 0}
          <p class="meta">No outline yet — it appears as the engine plans.</p>
        {:else}
          <ol class="outline-list" data-testid="write-outline-list">
            {#each outline as entry, i (i)}
              {@const label = entry.chapter ?? i + 1}
              <li data-testid="write-outline-row">
                <span class="chapter">Ch {label}</span>
                <span class="outline-body">
                  {#if entry.title}<span class="outline-title">{entry.title}</span>{/if}
                  {#if entry.core_event}<span class="outline-event">{entry.core_event}</span>{/if}
                </span>
              </li>
            {/each}
          </ol>
        {/if}
      </aside>

      <section class="pane content-pane" data-testid="write-pane-content">
        <h3>
          Content
          {#if run.status === 'running'}
            <span class="live" data-testid="write-stream-live">streaming</span>
          {/if}
        </h3>
        {#if rounds.length === 0}
          <p class="meta" data-testid="write-content-empty">
            Nothing streamed yet. Start a run or continue the story — generated text appears here round by round.
          </p>
        {:else}
          {#each channels as channel (channel)}
            <div class="channel-section" data-testid="write-channel-{channel}">
              {#if channels.length > 1}
                <h4 class="channel-name">{channel}</h4>
              {/if}
              {#each rounds.filter((r) => r.channel === channel) as round (round.id)}
                <article
                  class="round {round.live ? 'live' : ''}"
                  data-testid="write-round"
                  data-round-index={round.index}
                >
                  <header class="round-header">
                    <span>Round {round.index}</span>
                    {#if round.live && run.status === 'running'}
                      <span class="streaming">writing…</span>
                    {:else if round.clearReason}
                      <span class="cleared" title="stream.clear">cleared: {round.clearReason}</span>
                    {:else if !round.live}
                      <span class="cleared" title="stream.clear">round closed</span>
                    {/if}
                  </header>
                  {#if round.text === ''}
                    <p class="meta">(empty round)</p>
                  {:else}
                    <MarkdownView text={round.text} testid="write-round-markdown" />
                  {/if}
                </article>
              {/each}
            </div>
          {/each}
        {/if}
      </section>

      <aside class="pane facts-pane" data-testid="write-pane-facts">
        <h3>Facts &amp; activity</h3>
        <dl class="facts">
          <div><dt>Chapters</dt><dd>{snapshot.completed_chapters ?? 0}/{snapshot.total_chapters ?? '?'}</dd></div>
          {#if snapshot.total_word_count !== undefined}
            <div><dt>Words</dt><dd>{snapshot.total_word_count.toLocaleString()}</dd></div>
          {/if}
          {#if snapshot.characters}
            <div><dt>Characters</dt><dd>{snapshot.characters.length}</dd></div>
          {/if}
          {#if snapshot.pending_rewrites !== undefined}
            <div><dt>Pending rewrites</dt><dd>{snapshot.pending_rewrites}</dd></div>
          {/if}
          {#if snapshot.pending_steer}
            <div class="hold"><dt>Steer</dt><dd>instruction queued</dd></div>
          {/if}
          {#if snapshot.recovery_label}
            <div class="hold"><dt>Recovery</dt><dd>{snapshot.recovery_label}</dd></div>
          {/if}
        </dl>

        <h4>Writing events</h4>
        {#if writingActivity.length === 0}
          <p class="meta">No writing events yet.</p>
        {:else}
          <ul class="activity-list" data-testid="write-activity-list">
            {#each writingActivity as entry (entry.id)}
              <li>
                <span class="seq">{entry.sequence}</span>
                <span class="name">{entry.event}</span>
                {#if entry.summary}<span class="summary">{entry.summary}</span>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </aside>
    </div>

    <RunControls />
  {/if}
</section>

<style>
  .screen {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1.25rem 1.5rem 2rem;
    flex: 1;
    min-height: 0;
  }
  .screen-header h2 {
    margin: 0;
    font-size: 1.35rem;
    font-weight: 700;
  }
  .screen-description {
    margin: 0.15rem 0 0;
    color: var(--text-dim);
    font-size: 0.84rem;
  }
  .owner {
    font-style: italic;
    display: none;
  }
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 0.85rem;
    padding: 3.5rem 2rem;
    border: 1px dashed var(--border);
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--surface-1) 80%, transparent);
  }
  .empty-state h3 {
    margin: 0;
    font-size: 1.15rem;
    font-weight: 600;
    color: var(--text);
  }
  .empty-state p {
    margin: 0;
    color: var(--text-dim);
    font-size: 0.88rem;
  }
  .panes {
    display: grid;
    grid-template-columns: minmax(14rem, 18rem) minmax(0, 1fr) minmax(13rem, 17rem);
    gap: 0.85rem;
    flex: 1;
    min-height: 28rem;
  }
  .pane {
    background: var(--surface-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.85rem 1rem;
    overflow-y: auto;
    min-height: 0;
    box-shadow: var(--shadow-sm);
  }
  .pane h3 {
    margin: 0 0 0.65rem;
    font-size: 0.74rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
    display: flex;
    align-items: center;
    gap: 0.45rem;
    font-weight: 700;
  }
  .pane h4 {
    margin: 1.1rem 0 0.5rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    font-weight: 600;
  }
  .live {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.68rem;
    color: var(--ok);
    background: var(--ok-subtle);
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
  .meta {
    margin: 0.25rem 0;
    color: var(--text-faint);
    font-size: 0.82rem;
  }
  .facts {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .facts div {
    display: flex;
    justify-content: space-between;
    gap: 0.65rem;
    font-size: 0.82rem;
    align-items: center;
  }
  .facts dt {
    color: var(--text-dim);
    flex: none;
  }
  .facts dd {
    margin: 0;
    text-align: right;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    font-weight: 500;
  }
  .facts div.hold dd {
    color: var(--warn);
    white-space: normal;
    background: var(--warn-subtle);
    padding: 0.1rem 0.4rem;
    border-radius: var(--radius-xs);
  }
  .outline-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .outline-list li {
    display: flex;
    gap: 0.6rem;
    font-size: 0.8rem;
    align-items: baseline;
    padding: 0.35rem 0.45rem;
    border-radius: var(--radius-xs);
    background: var(--surface-2);
    border: 1px solid var(--border-subtle);
  }
  .chapter {
    font-family: var(--mono);
    color: var(--accent);
    flex: none;
    min-width: 2.8rem;
    font-weight: 600;
    font-size: 0.76rem;
  }
  .outline-body {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }
  .outline-title {
    color: var(--text);
    font-weight: 500;
  }
  .outline-event {
    color: var(--text-dim);
    font-size: 0.74rem;
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: 1.35;
  }
  .content-pane {
    background: var(--surface-0);
    border-color: color-mix(in srgb, var(--accent) 15%, var(--border));
  }
  .channel-section {
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  .channel-name {
    margin: 0;
    font-size: 0.74rem;
    color: var(--accent);
    font-family: var(--mono);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .round {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 0.85rem 1.15rem;
    background: var(--surface-1);
    box-shadow: var(--shadow-sm);
  }
  .round.live {
    border-color: color-mix(in srgb, var(--ok) 55%, transparent);
    box-shadow: 0 0 16px var(--ok-subtle);
  }
  .round-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.72rem;
    color: var(--text-faint);
    font-family: var(--mono);
    margin-bottom: 0.6rem;
    padding-bottom: 0.4rem;
    border-bottom: 1px solid var(--border-subtle);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .streaming {
    color: var(--ok);
    font-weight: 600;
  }
  .cleared {
    color: var(--warn);
    font-size: 0.7rem;
  }
  :global([data-testid='write-round-markdown']) {
    font-family: var(--font-serif);
    font-size: 1.05rem;
    line-height: 1.75;
    color: var(--text);
    max-width: 68ch;
  }
  :global([data-testid='write-round-markdown'] p) {
    margin-bottom: 1.15rem;
  }
  :global([data-testid='write-round-markdown'] h1, [data-testid='write-round-markdown'] h2, [data-testid='write-round-markdown'] h3) {
    font-family: var(--font-serif);
    color: var(--text);
    letter-spacing: -0.015em;
    margin-top: 1.25rem;
    margin-bottom: 0.5rem;
  }
  .activity-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-family: var(--mono);
    font-size: 0.75rem;
  }
  .activity-list li {
    display: flex;
    gap: 0.45rem;
    padding: 0.2rem 0.35rem;
    border-radius: var(--radius-xs);
    transition: background var(--transition-fast);
  }
  .activity-list li:hover {
    background: var(--surface-2);
  }
  .seq {
    color: var(--text-faint);
    min-width: 2.2rem;
    text-align: right;
  }
  .name {
    color: var(--accent);
    white-space: nowrap;
    font-weight: 500;
  }
  .summary {
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
