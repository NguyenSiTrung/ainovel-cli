/**
 * Co-create controller tests: acceptance semantics (start/stage), streaming
 * previews with replace semantics, terminal assistant replies carrying the
 * staged draft (empty draft keeps the previous), resume/cancel flows, the
 * engine.error round-failure channel, and projection resets (project close,
 * engine session change). All against the scripted mock bridge.
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
  cancelCocreateFromUi,
  cocreateState,
  deriveCocreateControls,
  resetCocreateState,
  resumeCocreateFromUi,
  startCocreateFromUi,
  stageCocreateFromUi,
} from '$lib/cocreate';
import {
  applyEngineEvent,
  connectionState,
  disposeDesktop,
  engineState,
  notifications,
  projectSnapshot,
} from '$lib/stores/desktop';
import { engineEvent, installBridgeMarker, tauri } from '$tests/tauri-mock';
import type { EventEnvelope, ProjectSnapshot } from '$lib/types/protocol';

const SNAPSHOT: ProjectSnapshot = { state: 'idle', book_title: 'Test Novel', total_chapters: 12 };

function payloadOf(method: string): Record<string, unknown> | undefined {
  const call = tauri
    .callsOf('desktop_request')
    .find((c) => (c.args as { method?: string })?.method === method);
  return (call?.args as { payload?: Record<string, unknown> })?.payload;
}

function apply(event: string, sequence: number, payload: Record<string, unknown> = {}): void {
  applyEngineEvent(engineEvent(event, sequence, payload, 'sess-1') as unknown as EventEnvelope);
}

beforeEach(async () => {
  tauri.reset();
  resetCocreateState();
  await disposeDesktop();
  installBridgeMarker();
  connectionState.set('ready');
  projectSnapshot.set({ ...SNAPSHOT });
  engineState.set({ health: 'ready', stopping: false, restartAttempts: 0, restartsTotal: 0, malformedOutputLines: 0, session: 'sess-1' });
});

describe('cocreate.start — acceptance + streamed round', () => {
  it('cold start sends {message} without a mode field and records the engine-echoed mode', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    const ok = await startCocreateFromUi('a sci-fi novel about a lighthouse', 'cold');
    expect(ok).toBe(true);
    expect(payloadOf('cocreate.start')).toEqual({ message: 'a sci-fi novel about a lighthouse' });

    const s = get(cocreateState);
    expect(s.mode).toBe('cold');
    expect(s.roundActive).toBe(true);
    expect(s.conversation).toHaveLength(1);
    expect(s.conversation[0]).toMatchObject({ role: 'user', text: 'a sci-fi novel about a lighthouse' });
  });

  it('stage start sends mode:"stage" and adopts the engine-echoed mode', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'stage' });
    await startCocreateFromUi('darker middle act', 'stage');
    expect(payloadOf('cocreate.start')).toEqual({ message: 'darker middle act', mode: 'stage' });
    expect(get(cocreateState).mode).toBe('stage');
  });

  it('rejects an empty message without sending anything', async () => {
    const ok = await startCocreateFromUi('   ');
    expect(ok).toBe(false);
    expect(tauri.callsOf('desktop_request')).toHaveLength(0);
  });

  it('a structured start failure (host_busy) surfaces the error and leaves no session', async () => {
    tauri.fail('desktop_request', { code: 'host_busy', message: 'a co-create round is already in flight' });
    const ok = await startCocreateFromUi('hello');
    expect(ok).toBe(false);
    const s = get(cocreateState);
    expect(s.mode).toBeNull();
    expect(s.roundActive).toBe(false);
    expect(s.error?.code).toBe('host_busy');
    // Structured error presentation went through the notification store.
    expect(get(notifications).some((n) => n.code === 'host_busy')).toBe(true);
  });
});

describe('cocreate.progress projection', () => {
  it('previews replace per stage kind (accumulated text contract) and the terminal reply closes the round', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    await startCocreateFromUi('hello');

    apply('cocreate.progress', 2, { stage: 'thinking', message: 'thinking a' });
    apply('cocreate.progress', 3, { stage: 'thinking', message: 'thinking about it' });
    apply('cocreate.progress', 4, { stage: 'reply', message: 'partial' });

    let s = get(cocreateState);
    expect(s.preview).toEqual({ thinking: 'thinking about it', reply: 'partial' });
    expect(s.roundActive).toBe(true);

    apply('cocreate.progress', 5, {
      stage: 'assistant',
      message: 'what genre?',
      ready: false,
      draft: '',
      suggestions: ['加个反派', 'make it a mystery'],
    });

    s = get(cocreateState);
    expect(s.roundActive).toBe(false);
    expect(s.preview).toBeNull();
    expect(s.conversation).toHaveLength(2);
    expect(s.conversation[1]).toMatchObject({ role: 'assistant', text: 'what genre?' });
    expect(s.draft).toMatchObject({ text: '', ready: false });
    expect(s.draft?.suggestions).toEqual(['加个反派', 'make it a mystery']);
  });

  it('an empty draft string keeps the previously staged draft (daemon session rule)', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    await startCocreateFromUi('hello');
    apply('cocreate.progress', 2, { stage: 'assistant', message: 'm', draft: '## first draft', ready: false });
    expect(get(cocreateState).draft?.text).toBe('## first draft');

    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    await stageCocreateFromUi('more input');
    // Degraded parse path: terminal reply carries draft:"" — keep the old draft.
    apply('cocreate.progress', 4, { stage: 'assistant', message: 'm2', draft: '', ready: true });
    const s = get(cocreateState);
    expect(s.draft?.text).toBe('## first draft');
    expect(s.draft?.ready).toBe(true);
  });

  it('engine.error while a round is active is the round failure channel', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    await startCocreateFromUi('hello');
    apply('cocreate.progress', 2, { stage: 'reply', message: 'partial' });

    apply('engine.error', 3, { code: 'operation_failed', message: 'co-create round failed: provider exploded' });

    const s = get(cocreateState);
    expect(s.roundActive).toBe(false);
    expect(s.preview).toBeNull();
    expect(s.roundError).toBe('co-create round failed: provider exploded');
    // The session survives engine-side: staging another round stays available.
    expect(s.mode).toBe('cold');
    expect(deriveCocreateControls(s, SNAPSHOT, 'ready').canStage).toBe(true);
  });
});

describe('cocreate.stage / resume / cancel', () => {
  it('stage appends a user turn and requires an existing session', async () => {
    const okNoSession = await stageCocreateFromUi('hello');
    expect(okNoSession).toBe(false);
    expect(tauri.callsOf('desktop_request')).toHaveLength(0);

    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    await startCocreateFromUi('first');
    apply('cocreate.progress', 2, { stage: 'assistant', message: 'm', draft: 'd', ready: true });

    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    const ok = await stageCocreateFromUi('second');
    expect(ok).toBe(true);
    expect(payloadOf('cocreate.stage')).toEqual({ message: 'second' });
    expect(get(cocreateState).conversation.map((t) => t.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('resume hands the draft over, resets the projection, and leaves the run to run.* events', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    await startCocreateFromUi('first');
    apply('cocreate.progress', 2, { stage: 'assistant', message: 'm', draft: '## brief', ready: true });

    tauri.reply('desktop_request', { accepted: true, mode: 'cold', run_id: 'run-9' });
    const ok = await resumeCocreateFromUi();
    expect(ok).toBe(true);
    expect(payloadOf('cocreate.resume')).toEqual({});

    const s = get(cocreateState);
    expect(s.mode).toBeNull();
    expect(s.lastResumed).toMatchObject({ mode: 'cold' });

    // The engine's run.started afterwards is observed by the run store, not here.
    apply('run.started', 3, { run_id: 'run-9', goal: '## brief' });
    expect(get(cocreateState).mode).toBeNull();
  });

  it('resume without a session sends nothing', async () => {
    expect(await resumeCocreateFromUi()).toBe(false);
    expect(tauri.callsOf('desktop_request')).toHaveLength(0);
  });

  it('availability mirrors the engine draft guard: no resume until the draft is non-empty', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    await startCocreateFromUi('first');
    apply('cocreate.progress', 2, { stage: 'assistant', message: 'm', draft: '', ready: false });
    expect(deriveCocreateControls(get(cocreateState), SNAPSHOT, 'ready').canResume).toBe(false);

    apply('cocreate.progress', 3, { stage: 'assistant', message: 'm2', draft: '## ready brief', ready: true });
    expect(deriveCocreateControls(get(cocreateState), SNAPSHOT, 'ready').canResume).toBe(true);
  });

  it('cancel with an engine-side session resets the projection', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'stage' });
    await startCocreateFromUi('first', 'stage');
    apply('cocreate.progress', 2, { stage: 'assistant', message: 'm', draft: 'd', ready: true });

    tauri.reply('desktop_request', { cancelled: true, stage: 'stage' });
    const ok = await cancelCocreateFromUi('done here');
    expect(ok).toBe(true);
    expect(payloadOf('cocreate.cancel')).toEqual({ reason: 'done here' });

    const s = get(cocreateState);
    expect(s.mode).toBeNull();
    expect(s.message).toBe('co-create session cancelled');
  });

  it('cancel answered cancelled:false (no engine session) drops the stale projection too', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    await startCocreateFromUi('first');
    apply('cocreate.progress', 2, { stage: 'assistant', message: 'm', draft: 'd', ready: true });

    tauri.reply('desktop_request', { cancelled: false, reason: 'no co-create session' });
    await cancelCocreateFromUi();
    const s = get(cocreateState);
    expect(s.mode).toBeNull();
    expect(s.message).toBe('no co-create session');
  });
});

describe('terminal-beats-acceptance race (daemon spawns the round before answering)', () => {
  it('a terminal reply arriving before the acceptance does not reopen the round', async () => {
    let release: (value: unknown) => void = () => {};
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'cocreate.start') {
        return new Promise((resolve) => {
          release = resolve as (value: unknown) => void;
        });
      }
      return { accepted: true };
    });

    const pending = startCocreateFromUi('hello');
    // The round's terminal event lands while the response is still in flight.
    apply('cocreate.progress', 2, { stage: 'assistant', message: 'fast reply', draft: '## d', ready: true });

    release({ accepted: true, mode: 'cold' });
    expect(await pending).toBe(true);

    const s = get(cocreateState);
    // The raced user turn is inserted before the assistant turn, and the
    // acceptance must NOT flip the closed round back to in-flight.
    expect(s.roundActive).toBe(false);
    expect(s.preview).toBeNull();
    expect(s.conversation.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(s.draft?.text).toBe('## d');
    expect(s.mode).toBe('cold');
  });

  it('engine.error during the acceptance window fails the round instead of wedging it', async () => {
    let release: (value: unknown) => void = () => {};
    let requestInFlight = false;
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'cocreate.start') {
        requestInFlight = true;
        return new Promise((resolve) => {
          release = resolve as (value: unknown) => void;
        });
      }
      return { accepted: true };
    });

    const pending = startCocreateFromUi('hello');
    await vi.waitFor(() => expect(requestInFlight).toBe(true));
    // The round fails before the acceptance response is written.
    apply('engine.error', 2, { code: 'operation_failed', message: 'co-create round failed: provider down' });
    release({ accepted: true, mode: 'cold' });
    expect(await pending).toBe(true);

    const s = get(cocreateState);
    // The acceptance must not reopen the failed round (advance-only).
    expect(s.roundActive).toBe(false);
    expect(s.roundError).toContain('provider down');
    expect(s.conversation.map((t) => t.role)).toEqual(['user']); // recorded exactly once
    expect(s.mode).toBe('cold');
    // Composer not wedged: staging another message stays available.
    expect(deriveCocreateControls(s, SNAPSHOT, 'ready').canStage).toBe(true);
  });
});

describe('projection resets', () => {
  it('closing the project drops the staged session', async () => {    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    await startCocreateFromUi('first');
    expect(get(cocreateState).mode).toBe('cold');
    projectSnapshot.set(null);
    expect(get(cocreateState).mode).toBeNull();
  });

  it('facts recorded before the close are not replayed onto the next session (no disposeDesktop)', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    await startCocreateFromUi('first');
    apply('cocreate.progress', 2, { stage: 'assistant', message: 'old reply', draft: '## old draft', ready: true });
    expect(get(cocreateState).draft?.text).toBe('## old draft');

    // Project closes WITHOUT disposeDesktop: the projection resets while the
    // shared fact store keeps its history.
    projectSnapshot.set(null);
    expect(get(cocreateState).mode).toBeNull();

    // New project, new session: the old terminal fact must not resurrect the
    // previous conversation or draft when the next fact arrives.
    projectSnapshot.set({ ...SNAPSHOT });
    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    await startCocreateFromUi('second');
    apply('cocreate.progress', 3, { stage: 'reply', message: 'new preview' });

    const s = get(cocreateState);
    expect(s.roundActive).toBe(true);
    expect(s.conversation.map((t) => t.text)).toEqual(['second']);
    expect(s.draft).toBeNull();
    expect(s.preview?.reply).toBe('new preview');
  });

  it('an engine session change (sidecar restart) drops the daemon-resident session', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    await startCocreateFromUi('first');
    expect(get(cocreateState).mode).toBe('cold');

    engineState.update((s) => ({ ...s, session: 'sess-2' }));
    expect(get(cocreateState).mode).toBeNull();
  });
});
