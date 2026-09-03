/**
 * Store tests: startup handshake, event ordering, duplicate tolerance,
 * stream clear boundaries, run projection, reconnect, replay-from-cursor,
 * session-change snapshot refetch, bounded buffers, and error mapping.
 * Driven entirely through the mocked Tauri bridge.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', async () => {
  const { tauri } = await import('$tests/tauri-mock');
  return { invoke: (cmd: string, args?: Record<string, unknown>) => tauri.invoke(cmd, args) };
});
vi.mock('@tauri-apps/api/event', async () => {
  const { tauri } = await import('$tests/tauri-mock');
  return {
    listen: (name: string, handler: (event: { event: string; payload: unknown }) => void) =>
      tauri.listen(name, handler),
  };
});

import { get } from 'svelte/store';

import {
  activity,
  cocreateEvents,
  connectionState,
  dismissNotification,
  disposeDesktop,
  engineState,
  eventBookkeeping,
  importProgressEvents,
  initDesktop,
  notifications,
  notificationPrefs,
  projectSnapshot,
  refreshSnapshot,
  runState,
  setNotificationPref,
  simulationProgressEvents,
  snapshotError,
  stream,
  usage,
} from '$lib/stores/desktop';
import { engineEvent, installBridgeMarker, removeBridgeMarker, tauri } from '$tests/tauri-mock';
import type { ForwardedEvent } from '$lib/types/protocol';

const READY_STATUS = {
  provider: 'go-sidecar',
  protocol: 'desktop-v1',
  health: 'ready',
  stopping: false,
  session: 'sess-1',
  pid: 4242,
  restartAttempts: 0,
  restartsTotal: 0,
  malformedOutputLines: 0,
  stderrLines: 0,
  lastError: null,
  lastExitCode: null,
};

const SNAPSHOT = {
  state: 'idle',
  status_label: 'Idle',
  book_title: 'Test Novel',
  total_chapters: 12,
  completed_chapters: 3,
  total_cost_usd: 1.25,
  budget_limit_usd: 10,
  total_input_tokens: 1000,
  total_output_tokens: 2000,
};

function scriptReadyEngine(): void {
  tauri.reply('desktop_status', READY_STATUS);
  tauri.reply('desktop_event_state', {
    session: 'sess-1',
    lastSequence: 0,
    sessionsSeen: ['sess-1'],
    duplicatesDropped: 0,
    forwardedCount: 1,
    sessionChanges: 0,
  });
  tauri.on('desktop_request', (_cmd, args) => {
    const method = (args as { method?: string })?.method;
    if (method === 'project.snapshot') return { ...SNAPSHOT };
    if (method === 'project.replay_events') return { replayed: 0, last_sequence: 0 };
    if (method === 'usage.snapshot') return { usage: { runs: 1 } };
    if (method === 'engine.ping') return { pong: true };
    throw { code: 'unknown_method', message: `unexpected ${method}` };
  });
}

function requestCallsOf(method: string): Array<Record<string, unknown> | undefined> {
  return tauri
    .callsOf('desktop_request')
    .filter((call) => (call.args as { method?: string } | undefined)?.method === method)
    .map((call) => call.args?.payload as Record<string, unknown> | undefined);
}

async function bootReady(): Promise<void> {
  scriptReadyEngine();
  await initDesktop();
  await vi.waitFor(() => expect(get(connectionState)).toBe('ready'));
}

function emitEvent(event: string, sequence: number, payload: Record<string, unknown> = {}, session = 'sess-1'): void {
  tauri.emit('desktop://event', engineEvent(event, sequence, payload, session) as ForwardedEvent);
}

beforeEach(async () => {
  tauri.reset();
  await disposeDesktop();
  installBridgeMarker();
});

describe('startup handshake', () => {
  it('status -> ready: subscribes, snapshots, replays from cursor, fetches usage', async () => {
    await bootReady();

    expect(tauri.callsOf('desktop_status')).toHaveLength(1);
    // Event, session, and status subscriptions are attached.
    for (const name of ['desktop://event', 'desktop://session', 'desktop://status']) {
      expect(tauri.listeners.has(name)).toBe(true);
    }
    await vi.waitFor(() => {
      expect(requestCallsOf('project.snapshot')).toHaveLength(1);
      expect(requestCallsOf('usage.snapshot')).toHaveLength(1);
    });
    // The shell's event_state seeded the cursor (0) -> replay from 0.
    expect(requestCallsOf('project.replay_events')).toEqual([{ after_sequence: 0 }]);

    expect(get(connectionState)).toBe('ready');
    expect(get(engineState).health).toBe('ready');
    expect(get(engineState).session).toBe('sess-1');
    expect(get(projectSnapshot)?.book_title).toBe('Test Novel');
    expect(get(usage).totals?.costUsd).toBe(1.25);
    expect(get(snapshotError)).toBeNull();
  });

  it('starts the engine when it is not running', async () => {
    scriptReadyEngine();
    tauri.reply('desktop_status', { ...READY_STATUS, health: 'stopped', session: null });
    tauri.reply('desktop_start', READY_STATUS);
    await initDesktop();
    await vi.waitFor(() => expect(tauri.callsOf('desktop_start')).toHaveLength(1));
    expect(get(engineState).health).toBe('ready');
    await vi.waitFor(() => expect(get(connectionState)).toBe('ready'));
  });

  it('reports a failed start as a structured error without crashing', async () => {
    tauri.reply('desktop_status', { ...READY_STATUS, health: 'stopped', session: null });
    tauri.fail('desktop_start', { code: 'sidecar_error', message: 'binary missing' });
    await initDesktop();
    expect(get(connectionState)).toBe('failed');
    const notes = get(notifications);
    expect(notes.some((n) => n.code === 'sidecar_error' && n.level === 'error')).toBe(true);
  });

  it('without the Tauri bridge it degrades to a notice (plain-browser dev)', async () => {
    removeBridgeMarker();
    await initDesktop();
    expect(get(connectionState)).toBe('stopped');
    expect(tauri.calls).toHaveLength(0);
    expect(get(notifications).some((n) => n.level === 'warning')).toBe(true);
  });
});

describe('event ordering and duplicate tolerance', () => {
  it('applies events in sequence order and drops re-deliverions', async () => {
    await bootReady();

    emitEvent('engine.status_changed', 2, { status: 'running' });
    emitEvent('run.started', 3, { run_id: 'r-1', goal: 'write' });
    emitEvent('run.progress', 4, { completed: 1, total: 4 });
    emitEvent('run.progress', 4, { completed: 1, total: 4 }); // exact re-delivery
    emitEvent('run.started', 3, { run_id: 'r-1', goal: 'write' }); // older sequence
    emitEvent('run.step_changed', 5, { step: 'drafting' });

    const entries = get(activity);
    expect(entries.map((e) => e.event)).toEqual([
      'engine.status_changed',
      'run.started',
      'run.progress',
      'run.step_changed',
    ]);
    expect(entries.map((e) => e.sequence)).toEqual([2, 3, 4, 5]);
    expect(eventBookkeeping().duplicatesTolerated).toBe(2);
    expect(get(runState).step).toBe('drafting');
  });

  it('unknown event names are ignored entirely', async () => {
    await bootReady();
    tauri.emit('desktop://event', engineEvent('engine.progress', 9, { done: 1 }, 'sess-1') as ForwardedEvent);
    expect(get(activity)).toHaveLength(0);
  });

  it('activity is bounded', async () => {
    await bootReady();
    for (let i = 1; i <= 520; i += 1) {
      emitEvent('run.progress', 100 + i, { completed: i });
    }
    expect(get(activity)).toHaveLength(500);
    // Newest entries survive.
    expect(get(activity)[get(activity).length - 1]!.sequence).toBe(620);
  });
});

describe('task-7 fact routing (cocreate / import / simulation progress)', () => {
  it('cocreate.progress facts keep the structural draft fields for the terminal reply', async () => {
    await bootReady();
    emitEvent('cocreate.progress', 10, { stage: 'thinking', message: 'pondering' });
    emitEvent('cocreate.progress', 11, {
      stage: 'assistant',
      message: 'reply',
      ready: true,
      draft: '## brief',
      suggestions: ['a', 'b'],
    });
    const facts = get(cocreateEvents);
    expect(facts).toHaveLength(2);
    expect(facts[0]).toMatchObject({ stage: 'thinking', message: 'pondering' });
    expect(facts[1]).toMatchObject({
      stage: 'assistant',
      ready: true,
      draft: '## brief',
      suggestions: ['a', 'b'],
    });
  });

  it('import/simulation progress facts carry the daemon drain fields verbatim', async () => {
    await bootReady();
    emitEvent('import.progress', 10, {
      stage: 'ingesting',
      completed: 1,
      total: 9,
      detail: 'reading',
      level: 'warn',
      retry_at: '2026-09-03T10:00:00Z',
    });
    emitEvent('import.progress', 11, { stage: 'done', continued: true });
    emitEvent('simulation.progress', 12, { stage: 'scan', completed: 2, total: 4, detail: 'scanning' });
    emitEvent('simulation.progress', 13, { stage: 'analyze', error: 'llm down' });

    expect(get(importProgressEvents)[0]).toMatchObject({
      stage: 'ingesting',
      completed: 1,
      total: 9,
      level: 'warn',
      retryAt: '2026-09-03T10:00:00Z',
    });
    expect(get(importProgressEvents)[1]).toMatchObject({ stage: 'done', continued: true });
    expect(get(simulationProgressEvents)[0]).toMatchObject({ stage: 'scan', completed: 2, total: 4 });
    expect(get(simulationProgressEvents)[1]).toMatchObject({ stage: 'analyze', error: 'llm down' });
  });

  it('facts without a cocreate stage string are ignored (open-payload tolerance)', async () => {
    await bootReady();
    emitEvent('cocreate.progress', 10, { message: 'no stage field' });
    expect(get(cocreateEvents)).toHaveLength(0);
  });
});

describe('stream projection', () => {
  it('accumulates deltas per channel and honors clear boundaries', async () => {
    await bootReady();

    emitEvent('stream.delta', 10, { text: 'Hello ' });
    emitEvent('stream.delta', 11, { text: 'world' });
    emitEvent('stream.delta', 12, { text: 'note', channel: 'side' });

    let state = get(stream);
    expect(state.channels['default']!.text).toBe('Hello world');
    expect(state.channels['side']!.text).toBe('note');
    expect(state.entries.map((e) => e.kind)).toEqual(['text', 'text', 'text']);

    emitEvent('stream.clear', 13, { reason: 'rerun' });
    state = get(stream);
    expect(state.channels['default']!.text).toBe('');
    expect(state.channels['default']!.revision).toBe(1);
    expect(state.channels['side']!.text).toBe('note'); // other channel untouched
    expect(state.entries.map((e) => e.kind)).toEqual(['text', 'text', 'text', 'clear']);

    emitEvent('stream.delta', 14, { text: 'fresh' });
    state = get(stream);
    expect(state.channels['default']!.text).toBe('fresh');
    // History keeps pre-clear content plus the boundary marker.
    expect(state.entries.map((e) => (e.kind === 'text' ? e.text : `clear:${e.reason}`))).toEqual([
      'Hello ',
      'world',
      'note',
      'clear:rerun',
      'fresh',
    ]);
  });
});

describe('run projection', () => {
  it('records observed lifecycle facts without inventing transitions', async () => {
    await bootReady();

    emitEvent('run.started', 3, { run_id: 'r-9', goal: 'chapter 4' });
    expect(get(runState)).toMatchObject({ status: 'running', runId: 'r-9', goal: 'chapter 4' });

    emitEvent('run.step_changed', 4, { step: 'outline' });
    emitEvent('run.progress', 5, { completed: 2, total: 6, detail: 'beats' });
    expect(get(runState).step).toBe('outline');
    expect(get(runState).progress).toMatchObject({ completed: 2, total: 6, detail: 'beats' });

    emitEvent('run.paused', 6, { reason: 'user' });
    expect(get(runState).status).toBe('paused');

    emitEvent('run.failed', 7, { message: 'provider exploded', code: 'provider_error' });
    const failed = get(runState);
    expect(failed.status).toBe('failed');
    expect(failed.terminal).toMatchObject({ kind: 'run.failed', message: 'provider exploded' });
    expect(get(notifications).some((n) => n.level === 'error' && n.message.includes('provider exploded'))).toBe(
      true,
    );
  });

  it('terminal states are replaced only by new terminal events', async () => {
    await bootReady();
    emitEvent('run.started', 3, {});
    emitEvent('run.completed', 4, { summary: { chapters: 2 } });
    expect(get(runState).status).toBe('completed');
    emitEvent('run.aborted', 5, { reason: 'changed mind' });
    expect(get(runState).status).toBe('aborted');
    expect(get(runState).terminal?.reason).toBe('changed mind');
  });
});

describe('usage and notifications', () => {
  it('usage.updated merges counters', async () => {
    await bootReady();
    emitEvent('usage.updated', 6, { usage: { runs: 2 }, budget: { limit: 20 } });
    const state = get(usage);
    expect(state.usage).toEqual({ runs: 2 });
    expect(state.budget).toEqual({ limit: 20 });
  });

  it('notification events become dismissable toasts, bounded', async () => {
    await bootReady();
    emitEvent('notification.warning', 7, { message: 'careful' });
    emitEvent('notification.error', 8, { message: 'broken' });
    let notes = get(notifications);
    expect(notes.map((n) => n.level)).toEqual(['warning', 'error']);

    dismissNotification(notes[0]!.id);
    expect(get(notifications).map((n) => n.message)).toEqual(['broken']);

    for (let i = 0; i < 60; i += 1) {
      emitEvent('notification.info', 100 + i, { message: `n${i}` });
    }
    expect(get(notifications)).toHaveLength(50);
  });

  it('desktop notifications: completion and pause events surface as categorized toasts', async () => {
    await bootReady();
    emitEvent('run.completed', 20, { summary: { chapters: 3 } });
    emitEvent('run.paused', 21, { reason: 'user requested pause' });
    emitEvent('run.paused', 22, { reason: 'chapter gate', advance_hold: true });
    emitEvent('run.failed', 23, { message: 'provider exploded' });
    emitEvent('run.aborted', 24, { reason: 'changed mind' });

    const notes = get(notifications);
    expect(notes.find((n) => n.category === 'completion')?.message).toBe('run completed');
    const pauses = notes.filter((n) => n.category === 'pause');
    expect(pauses).toHaveLength(2);
    // Chapter-gate holds ask for a decision, so they surface as warnings.
    expect(pauses[0]?.level).toBe('info');
    expect(pauses[1]?.level).toBe('warning');
    expect(pauses[1]?.message).toContain('chapter gate');
    expect(notes.find((n) => n.category === 'failure')?.level).toBe('error');
    expect(notes.find((n) => n.category === 'warning')?.message).toContain('run aborted');
  });

  it('notification preferences are local, filterable, and reset on dispose', async () => {
    await bootReady();
    expect(get(notificationPrefs)).toEqual({ completion: true, pause: true, warning: true, failure: true });

    setNotificationPref('pause', false);
    setNotificationPref('failure', false);
    expect(get(notificationPrefs)).toEqual({ completion: true, pause: false, warning: true, failure: false });

    await disposeDesktop();
    expect(get(notificationPrefs)).toEqual({ completion: true, pause: true, warning: true, failure: true });
  });
});

describe('snapshot error mapping', () => {
  it('structured failures set snapshotError and notify; project_unavailable clears silently', async () => {
    await bootReady();

    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'project.snapshot') {
        throw { code: 'host_busy', message: 'run active' };
      }
      if (method === 'project.replay_events') return { replayed: 0 };
      if (method === 'usage.snapshot') return {};
      throw { code: 'unknown_method', message: 'x' };
    });
    await refreshSnapshot();

    expect(get(snapshotError)?.code).toBe('host_busy');
    expect(get(notifications).some((n) => n.code === 'host_busy')).toBe(true);

    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'project.snapshot') {
        throw { code: 'project_unavailable', message: 'no project open' };
      }
      if (method === 'project.replay_events') return { replayed: 0 };
      if (method === 'usage.snapshot') return {};
      throw { code: 'unknown_method', message: 'x' };
    });
    await refreshSnapshot();
    expect(get(snapshotError)).toBeNull();
    expect(get(projectSnapshot)).toBeNull();
    expect(get(notifications).some((n) => n.code === 'project_unavailable')).toBe(false);
  });
});

describe('session change and reconnect', () => {
  it('desktop://session resets the window, refetches the snapshot, replays from 0', async () => {
    await bootReady();
    emitEvent('run.started', 3, { run_id: 'r-1' });
    emitEvent('run.progress', 4, { completed: 1, total: 2 });
    expect(get(runState).status).toBe('running');

    const snapshotsBefore = requestCallsOf('project.snapshot').length;
    const replaysBefore = requestCallsOf('project.replay_events').length;
    tauri.emit('desktop://session', { previous: 'sess-1', current: 'sess-2', lastSequence: 4 });

    await vi.waitFor(() => {
      expect(requestCallsOf('project.snapshot').length).toBeGreaterThan(snapshotsBefore);
      expect(requestCallsOf('project.replay_events').length).toBeGreaterThan(replaysBefore);
    });
    // Window reset -> replay from sequence 0 under the new session id.
    expect(requestCallsOf('project.replay_events').at(-1)).toEqual({ after_sequence: 0 });
    // Observed run state belonged to the old session.
    expect(get(runState).status).toBe('idle');
    // New-session events apply from their own numbering.
    emitEvent('engine.ready', 1, { recovered: true }, 'sess-2');
    expect(get(activity).at(-1)!.summary).toBe('recovered');
    emitEvent('run.started', 2, { run_id: 'r-2' }, 'sess-2');
    expect(get(runState).status).toBe('running');
  });

  it('envelope-carried session change triggers the same recovery', async () => {
    await bootReady();
    emitEvent('run.started', 3, {});
    const snapshotsBefore = requestCallsOf('project.snapshot').length;
    const replaysBefore = requestCallsOf('project.replay_events').length;

    emitEvent('engine.ready', 1, { recovered: true }, 'sess-other');

    await vi.waitFor(() => {
      expect(requestCallsOf('project.snapshot').length).toBeGreaterThan(snapshotsBefore);
      expect(requestCallsOf('project.replay_events').length).toBeGreaterThan(replaysBefore);
    });
    // The triggering envelope itself is applied before the async resync
    // reads the cursor, so replay continues after its sequence.
    expect(requestCallsOf('project.replay_events').at(-1)).toEqual({ after_sequence: 1 });
  });

  it('one session-change toast per restart (shell order: forwarded event first, then the notice)', async () => {
    await bootReady();
    emitEvent('run.started', 3, { run_id: 'r-1' });

    // Real shell order (events.rs): the new session's first event is
    // forwarded, THEN desktop://session is emitted for the same transition.
    emitEvent('engine.ready', 1, { recovered: true }, 'sess-2');
    tauri.emit('desktop://session', { previous: 'sess-1', current: 'sess-2', lastSequence: 1 });

    const sessionToasts = get(notifications).filter((n) => n.message.includes('engine session changed'));
    expect(sessionToasts).toHaveLength(1);
    // The triggering envelope still applied under the new session id.
    expect(get(activity).at(-1)!.event).toBe('engine.ready');
    expect(eventBookkeeping().lastSession).toBe('sess-2');
    // Observed run state belonged to the old session.
    expect(get(runState).status).toBe('idle');
  });

  it('one session-change toast per restart (notice first, then the new session events)', async () => {
    await bootReady();
    emitEvent('run.started', 3, { run_id: 'r-1' });

    tauri.emit('desktop://session', { previous: 'sess-1', current: 'sess-2', lastSequence: 3 });
    emitEvent('engine.ready', 1, { recovered: true }, 'sess-2');
    emitEvent('run.started', 2, { run_id: 'r-2' }, 'sess-2');

    const sessionToasts = get(notifications).filter((n) => n.message.includes('engine session changed'));
    expect(sessionToasts).toHaveLength(1);
    // The dedupe window was reset by the notice, so both new-session events
    // applied normally (no second session-change recovery from the deduper).
    expect(get(runState)).toMatchObject({ status: 'running', runId: 'r-2' });
    expect(eventBookkeeping().lastSession).toBe('sess-2');
  });

  it('reconnect: restarting -> ready resyncs with replay from the applied cursor', async () => {
    await bootReady();
    emitEvent('run.progress', 3, { completed: 1, total: 2 });
    emitEvent('run.progress', 4, { completed: 2, total: 2 });

    tauri.emit('desktop://status', { health: 'restarting', attempt: 1, reason: 'crash' });
    expect(get(connectionState)).toBe('reconnecting');
    expect(get(engineState).restartAttempts).toBe(1);

    const snapshotsBefore = requestCallsOf('project.snapshot').length;
    const replaysBefore = requestCallsOf('project.replay_events').length;
    tauri.emit('desktop://status', { health: 'ready', session: 'sess-1' });

    await vi.waitFor(() => {
      expect(requestCallsOf('project.snapshot').length).toBeGreaterThan(snapshotsBefore);
      expect(requestCallsOf('project.replay_events').length).toBeGreaterThan(replaysBefore);
    });
    // Same session: replay continues from the last applied sequence.
    expect(requestCallsOf('project.replay_events').at(-1)).toEqual({ after_sequence: 4 });
    expect(get(connectionState)).toBe('ready');
  });

  it('exited-without-grace reconnects; failed notifies with sidecar_error', async () => {
    await bootReady();

    tauri.emit('desktop://status', { health: 'exited', graceful: false, exitCode: 1, session: 'sess-1' });
    expect(get(connectionState)).toBe('reconnecting');

    tauri.emit('desktop://status', { health: 'failed', attempts: 3, reason: 'restarts exhausted' });
    expect(get(connectionState)).toBe('failed');
    expect(get(notifications).some((n) => n.code === 'sidecar_error')).toBe(true);
  });

  it('graceful exit maps to stopped', async () => {
    await bootReady();
    tauri.emit('desktop://status', { health: 'exited', graceful: true, exitCode: 0, session: 'sess-1' });
    expect(get(connectionState)).toBe('stopped');
  });

  it('degraded status signal flags a degraded connection', async () => {
    await bootReady();
    tauri.emit('desktop://status', { health: 'degraded', malformedOutputLines: 4 });
    expect(get(connectionState)).toBe('degraded');
    expect(get(engineState).malformedOutputLines).toBe(4);
    expect(get(notifications).some((n) => n.level === 'warning' && n.message.includes('degraded'))).toBe(true);
  });
});
