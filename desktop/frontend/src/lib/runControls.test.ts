/**
 * Run control tests: availability derived from backend state, command
 * semantics (acceptance, steer, pause/abort, retry, advance mode, one-chapter
 * authorization), and structured-error surfacing — all against the scripted
 * mock bridge. No local workflow transitions: run status only changes when
 * engine events arrive.
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
import { tick } from 'svelte';

import {
  abortRunFromUi,
  authorizeOneChapterFromUi,
  continueRunFromUi,
  deriveRunControls,
  lastRunControlOutcome,
  pauseRunFromUi,
  pendingRunControls,
  resetRunControls,
  retryRunFromUi,
  setAdvanceModeFromUi,
  startRunFromUi,
  steerRunFromUi,
} from '$lib/runControls';
import {
  applyEngineEvent,
  connectionState,
  disposeDesktop,
  initDesktop,
  notifications,
  projectSnapshot,
  runState,
} from '$lib/stores/desktop';
import { engineEvent, installBridgeMarker, tauri } from '$tests/tauri-mock';
import type { EventEnvelope, ProjectSnapshot } from '$lib/types/protocol';

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

function snapshot(overrides: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    state: 'idle',
    status_label: 'Idle',
    book_title: 'Test Novel',
    total_chapters: 12,
    completed_chapters: 3,
    ...overrides,
  };
}

function scriptEngine(snap: ProjectSnapshot | null = null): void {
  tauri.reply('desktop_status', READY_STATUS);
  tauri.reply('desktop_event_state', { session: 'sess-1', lastSequence: 0, sessionsSeen: 1, duplicatesDropped: 0, forwardedCount: 1, sessionChanges: 0 });
  tauri.on('desktop_request', (_cmd, args) => {
    const method = (args as { method?: string })?.method;
    if (method === 'project.snapshot') return { ...(snap ?? { state: 'closed' }) };
    if (method === 'project.replay_events') return { replayed: 0, last_sequence: 0 };
    if (method === 'usage.snapshot') return { usage: {} };
    if (method?.startsWith('run.')) return { accepted: true };
    if (method === 'project.resume') return { resumed: true };
    throw { code: 'unknown_method', message: `unexpected ${method}` };
  });
}

async function bootReady(snap: ProjectSnapshot | null = null): Promise<void> {
  scriptEngine(snap);
  await initDesktop();
  await vi.waitFor(() => expect(get(connectionState)).toBe('ready'));
  if (snap !== null) await vi.waitFor(() => expect(get(projectSnapshot)).not.toBeNull());
}

function requestPayloadsOf(method: string): Array<Record<string, unknown> | undefined> {
  return tauri
    .callsOf('desktop_request')
    .filter((call) => (call.args as { method?: string })?.method === method)
    .map((call) => call.args?.payload as Record<string, unknown> | undefined);
}

function apply(event: string, sequence: number, payload: Record<string, unknown> = {}): void {
  applyEngineEvent(engineEvent(event, sequence, payload, 'sess-1') as unknown as EventEnvelope);
}

beforeEach(async () => {
  tauri.reset();
  resetRunControls();
  await disposeDesktop();
  installBridgeMarker();
});

describe('deriveRunControls — backend state decides availability', () => {
  it('no project: nothing is offered', () => {
    const avail = deriveRunControls(null, { status: 'idle' }, 'ready');
    expect(avail.projectOpen).toBe(false);
    expect(avail.canStart).toBe(false);
    expect(avail.canSteer).toBe(false);
    expect(avail.canContinue).toBe(false);
    expect(avail.canAuthorizeChapter).toBe(false);
    expect(avail.advanceMode).toBeNull();
  });

  it('fresh project, engine idle: start only (no resumable work yet)', () => {
    const avail = deriveRunControls(snapshot({ completed_chapters: 0 }), { status: 'idle' }, 'ready');
    expect(avail.canStart).toBe(true);
    expect(avail.canSteer).toBe(false);
    expect(avail.canPause).toBe(false);
    expect(avail.canContinue).toBe(false);
    expect(avail.canRetry).toBe(false);
  });

  it('engine reports running via snapshot: start locks, steer/pause/abort unlock', () => {
    const avail = deriveRunControls(snapshot({ running: true }), { status: 'idle' }, 'ready');
    expect(avail.engineRunning).toBe(true);
    expect(avail.canStart).toBe(false);
    expect(avail.canSteer).toBe(true);
    expect(avail.canPause).toBe(true);
    expect(avail.canAbort).toBe(true);
  });

  it('observed run.started event alone also counts as running', () => {
    const avail = deriveRunControls(snapshot(), { status: 'running' }, 'ready');
    expect(avail.engineRunning).toBe(true);
    expect(avail.canSteer).toBe(true);
  });

  it('paused after progress: continue offered alongside start (the engine arbitrates)', () => {
    const avail = deriveRunControls(snapshot({ completed_chapters: 4 }), { status: 'paused' }, 'ready');
    expect(avail.canContinue).toBe(true);
    // The engine only rejects a start while it is actually running; a paused
    // engine may accept either control, so both stay offered.
    expect(avail.canStart).toBe(true);
    expect(avail.canRetry).toBe(false);
  });

  it('failed run: retry offered (engine resume-from-persisted semantics)', () => {
    const avail = deriveRunControls(snapshot({ completed_chapters: 0 }), { status: 'failed' }, 'ready');
    expect(avail.canRetry).toBe(true);
    expect(avail.canContinue).toBe(true);
  });

  it('chapter gate: advance hold from snapshot or run.paused enables one-chapter authorization', () => {
    const fromSnapshot = deriveRunControls(snapshot({ has_advance_hold: true }), { status: 'paused' }, 'ready');
    expect(fromSnapshot.canAuthorizeChapter).toBe(true);
    const fromEvent = deriveRunControls(snapshot(), { status: 'paused', pause: { advanceHold: true, at: 0 } }, 'ready');
    expect(fromEvent.canAuthorizeChapter).toBe(true);
    const noHold = deriveRunControls(snapshot(), { status: 'paused', pause: { at: 0 } }, 'ready');
    expect(noHold.canAuthorizeChapter).toBe(false);
  });

  it('advance mode normalizes engine spellings; pending steer is surfaced', () => {
    expect(deriveRunControls(snapshot({ advance_mode: 'auto' }), { status: 'idle' }, 'ready').advanceMode).toBe('auto');
    expect(deriveRunControls(snapshot({ advance_mode: 'review' }), { status: 'idle' }, 'ready').advanceMode).toBe('review');
    expect(deriveRunControls(snapshot({ advance_mode: 'manual' }), { status: 'idle' }, 'ready').advanceMode).toBe('review');
    expect(deriveRunControls(snapshot({ pending_steer: true }), { status: 'idle' }, 'ready').pendingSteer).toBe(true);
  });

  it('engine not ready disables everything even with a project open', () => {
    const avail = deriveRunControls(snapshot(), { status: 'idle' }, 'reconnecting');
    expect(avail.engineReady).toBe(false);
    expect(avail.canStart).toBe(false);
    expect(avail.canSteer).toBe(false);
  });
});

describe('run control actions', () => {
  it('start sends {goal}, records acceptance, and status changes only via run.started', async () => {
    await bootReady(snapshot());

    const ok = await startRunFromUi('draft chapter 4');
    expect(ok).toBe(true);
    expect(requestPayloadsOf('run.start')).toEqual([{ goal: 'draft chapter 4' }]);
    // Acceptance is NOT a status change.
    expect(get(runState).status).toBe('idle');
    expect(get(lastRunControlOutcome)).toMatchObject({ kind: 'start', ok: true });

    apply('run.started', 10, { run_id: 'r-1', goal: 'draft chapter 4' });
    expect(get(runState)).toMatchObject({ status: 'running', runId: 'r-1' });
  });

  it('asynchronous run.failed after acceptance surfaces as terminal failure + notification', async () => {
    await bootReady(snapshot());
    await startRunFromUi('start over an existing book');
    apply('run.started', 10, { run_id: 'r-2' });
    apply('run.failed', 11, { message: 'book already has final chapters', code: 'invalid_state' });

    const run = get(runState);
    expect(run.status).toBe('failed');
    expect(run.terminal).toMatchObject({ kind: 'run.failed', message: 'book already has final chapters' });
    expect(get(notifications).some((n) => n.level === 'error' && n.message.includes('book already has final chapters'))).toBe(true);
    // Retry unlocks purely from the observed failure.
    expect(deriveRunControls(get(projectSnapshot), get(runState), get(connectionState)).canRetry).toBe(true);
  });

  it('start is guarded: empty goal or running engine issues no request', async () => {
    await bootReady(snapshot());
    expect(await startRunFromUi('   ')).toBe(false);
    expect(requestPayloadsOf('run.start')).toEqual([]);

    apply('run.started', 10, { run_id: 'r-3' });
    expect(await startRunFromUi('another goal')).toBe(false);
    expect(requestPayloadsOf('run.start')).toEqual([]);
  });

  it('steer sends {instruction} while running and is refused when idle', async () => {
    await bootReady(snapshot());
    expect(await steerRunFromUi('add a storm')).toBe(false);
    expect(requestPayloadsOf('run.steer')).toEqual([]);

    apply('run.started', 10, {});
    expect(await steerRunFromUi('add a storm')).toBe(true);
    expect(requestPayloadsOf('run.steer')).toEqual([{ instruction: 'add a storm' }]);
  });

  it('pause and abort both issue their engine controls while running', async () => {
    await bootReady(snapshot());
    apply('run.started', 10, { run_id: 'r-4' });

    expect(await pauseRunFromUi()).toBe(true);
    expect(requestPayloadsOf('run.pause')).toEqual([{}]);
    expect(await abortRunFromUi('changed my mind')).toBe(true);
    expect(await abortRunFromUi()).toBe(true);
    expect(requestPayloadsOf('run.abort')).toEqual([{ reason: 'changed my mind' }, { reason: 'user abort' }]);
  });

  it('continue and retry resume from persisted engine state after a pause/failure', async () => {
    await bootReady(snapshot());
    apply('run.started', 10, {});
    apply('run.paused', 11, { reason: 'user pause' });
    expect(await continueRunFromUi()).toBe(true);
    expect(requestPayloadsOf('run.continue')).toEqual([{}]);

    apply('run.started', 12, {});
    apply('run.failed', 13, { message: 'provider outage' });
    expect(await retryRunFromUi()).toBe(true);
    expect(requestPayloadsOf('run.retry')).toEqual([{}]);
  });

  it('one-chapter authorization requires a backend-reported hold', async () => {
    await bootReady(snapshot());
    expect(await authorizeOneChapterFromUi()).toBe(false);
    expect(requestPayloadsOf('run.advance_one_chapter')).toEqual([]);

    const withHold = snapshot({ has_advance_hold: true, advance_permit_chapter: 5 });
    projectSnapshot.set(withHold);
    await tick();
    expect(await authorizeOneChapterFromUi()).toBe(true);
    expect(requestPayloadsOf('run.advance_one_chapter')).toEqual([{}]);
  });

  it('advance mode switch sends {mode} and re-reads the engine-owned value', async () => {
    // The engine script owns the mode; the UI only re-reads it after acceptance.
    let engineAdvanceMode = 'review';
    tauri.reply('desktop_status', READY_STATUS);
    tauri.reply('desktop_event_state', { session: 'sess-1', lastSequence: 0, sessionsSeen: 1, duplicatesDropped: 0, forwardedCount: 1, sessionChanges: 0 });
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'project.snapshot') return { ...snapshot({ advance_mode: engineAdvanceMode }) };
      if (method === 'project.replay_events') return { replayed: 0, last_sequence: 0 };
      if (method === 'usage.snapshot') return { usage: {} };
      if (method === 'run.set_advance_mode') {
        engineAdvanceMode = (args?.payload as { mode?: string })?.mode ?? engineAdvanceMode;
        return { ok: true };
      }
      return { accepted: true };
    });
    await initDesktop();
    await vi.waitFor(() => expect(get(projectSnapshot)?.advance_mode).toBe('review'));

    expect(await setAdvanceModeFromUi('auto')).toBe(true);
    expect(requestPayloadsOf('run.set_advance_mode')).toEqual([{ mode: 'auto' }]);
    // The post-acceptance snapshot refetch is what flips the mode in the UI.
    await vi.waitFor(() => expect(get(projectSnapshot)?.advance_mode).toBe('auto'));

    // Asking for the mode the engine already reports issues no request.
    const before = tauri.callsOf('desktop_request').length;
    expect(await setAdvanceModeFromUi('auto')).toBe(false);
    expect(tauri.callsOf('desktop_request').length).toBe(before);
  });

  it('structured rejection surfaces through the error presentation with the stable code', async () => {
    await bootReady(snapshot());
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'run.start') {
        throw { code: 'host_busy', message: 'a generation run is already active', details: { active_request: 'run.start' } };
      }
      if (method === 'project.snapshot') return { ...snapshot() };
      return { accepted: true };
    });

    const ok = await startRunFromUi('goal');
    expect(ok).toBe(false);
    const outcome = get(lastRunControlOutcome);
    expect(outcome).toMatchObject({ kind: 'start', ok: false, code: 'host_busy' });
    expect(get(notifications).some((n) => n.code === 'host_busy' && n.message.includes('Engine busy'))).toBe(true);
  });

  it('pending flags bracket exactly the in-flight control', async () => {
    await bootReady(snapshot());
    let release: (() => void) | undefined;
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'run.start') {
        return new Promise((resolve) => {
          release = () => resolve({ accepted: true });
        });
      }
      if (method === 'project.snapshot') return { ...snapshot() };
      return {};
    });

    const pending = startRunFromUi('slow start');
    await vi.waitFor(() => expect(get(pendingRunControls).start).toBe(true));
    release!();
    expect(await pending).toBe(true);
    expect(get(pendingRunControls).start).toBeUndefined();
  });
});
