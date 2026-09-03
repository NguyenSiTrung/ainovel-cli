/**
 * API layer tests: request dispatch over the mocked Tauri bridge, request
 * id attachment, structured error normalization, wrapper argument shapes,
 * and the (session, sequence) dedupe window.
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

import {
  DesktopApiError,
  EventDeduper,
  enginePing,
  getPaths,
  getStatus,
  normalizeForwardedEvent,
  pendingRequestCount,
  projectReplayEvents,
  readFacts,
  readSummaries,
  readWorld,
  request,
  shutdownEngine,
  startEngine,
  subscribeEngineEvents,
  subscribeSessionChanges,
  toStructuredError,
  validateProjectDir,
} from '$lib/api/desktop';
import { tauri } from '$tests/tauri-mock';

describe('request dispatch', () => {
  beforeEach(() => {
    tauri.reset();
  });

  it('sends method and payload through desktop_request and resolves the payload', async () => {
    tauri.reply('desktop_request', { pong: true });
    const result = await enginePing();
    expect(result).toEqual({ pong: true });
    expect(tauri.callsOf('desktop_request')).toHaveLength(1);
    expect(tauri.callsOf('desktop_request')[0]!.args).toEqual({ method: 'engine.ping', payload: {} });
  });

  it('defaults payload to an empty object and passes through given fields', async () => {
    tauri.reply('desktop_request', { opened: true });
    await request('project.open', { path: '/tmp/novel' });
    expect(tauri.callsOf('desktop_request')[0]!.args).toEqual({
      method: 'project.open',
      payload: { path: '/tmp/novel' },
    });
  });

  it('attaches unique request ids and clears them when settled', async () => {
    const resolvers: Array<(value: unknown) => void> = [];
    tauri.on('desktop_request', () => new Promise((resolve) => resolvers.push(resolve)));

    const first = request('engine.ping');
    const second = request('engine.ping');
    expect(pendingRequestCount()).toBe(2);
    expect(resolvers).toHaveLength(2);
    for (const resolve of resolvers) resolve({});
    await Promise.all([first, second]);
    expect(pendingRequestCount()).toBe(0);
  });

  it('maps a structured rejection to DesktopApiError with the stable code', async () => {
    tauri.fail('desktop_request', {
      code: 'host_busy',
      message: 'a generation run is already active',
      details: { active_request: 'run.start' },
    });
    const error = await request('run.start').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DesktopApiError);
    const apiError = error as DesktopApiError;
    expect(apiError.code).toBe('host_busy');
    expect(apiError.message).toBe('a generation run is already active');
    expect(apiError.details).toEqual({ active_request: 'run.start' });
    expect(apiError.is('host_busy')).toBe(true);
    expect(apiError.requestId).toMatch(/^ui-/);
  });

  it.each([
    ['engine_unavailable', 'engine died'],
    ['request_timeout', 'no response'],
    ['sidecar_error', 'spawn failed'],
    ['invalid_path', 'relative path'],
    ['malformed_json', 'bad line'],
    ['invalid_payload', 'missing field'],
    ['unknown_method', 'nope'],
    ['duplicate_request_id', 'id reuse'],
    ['project_unavailable', 'no project'],
    ['operation_failed', 'provider error'],
    ['cancelled', 'user abort'],
    ['internal_error', 'panic'],
  ])('surfaces shell/protocol code %s untouched', async (code, message) => {
    tauri.fail('desktop_request', { code, message });
    const error = (await request('engine.ping').catch((e: unknown) => e)) as DesktopApiError;
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
  });

  it('normalizes string rejections to internal_error', async () => {
    tauri.on('desktop_request', () => {
      throw 'plain string failure';
    });
    const error = (await request('engine.ping').catch((e: unknown) => e)) as DesktopApiError;
    expect(error.code).toBe('internal_error');
    expect(error.message).toBe('plain string failure');
  });

  it('normalizes objects without a code to internal_error', () => {
    expect(toStructuredError({ message: 'weird' })).toEqual({
      code: 'internal_error',
      message: 'weird',
    });
    expect(toStructuredError(null)).toEqual({
      code: 'internal_error',
      message: 'unexpected command failure',
    });
  });
});

describe('shell command wrappers', () => {
  beforeEach(() => {
    tauri.reset();
  });

  it('desktop_status takes no arguments', async () => {
    tauri.reply('desktop_status', { provider: 'go-sidecar', health: 'ready' });
    const status = await getStatus();
    expect(status.health).toBe('ready');
    expect(tauri.callsOf('desktop_status')[0]!.args).toBeUndefined();
  });

  it('desktop_start and desktop_shutdown forward camelCase args', async () => {
    tauri.reply('desktop_start', { health: 'ready' });
    tauri.reply('desktop_shutdown', { health: 'stopped' });
    await startEngine();
    await shutdownEngine('user request');
    expect(tauri.callsOf('desktop_start')[0]!.args).toBeUndefined();
    expect(tauri.callsOf('desktop_shutdown')[0]!.args).toEqual({ reason: 'user request' });
  });

  it('desktop_paths and desktop_validate_project_dir', async () => {
    tauri.reply('desktop_paths', { appDataDir: '/x', projectsDir: '/y', targetTriple: 'aarch64-apple-darwin' });
    tauri.reply('desktop_validate_project_dir', { path: '/y/N', recognized: true });
    const paths = await getPaths();
    const report = await validateProjectDir('/y/N');
    expect(paths.projectsDir).toBe('/y');
    expect(report).toEqual({ path: '/y/N', recognized: true });
    expect(tauri.callsOf('desktop_validate_project_dir')[0]!.args).toEqual({ path: '/y/N' });
  });

  it('invalid_path from validation surfaces as structured error', async () => {
    tauri.fail('desktop_validate_project_dir', {
      code: 'invalid_path',
      message: 'relative paths are rejected',
    });
    const error = (await validateProjectDir('relative/path').catch((e: unknown) => e)) as DesktopApiError;
    expect(error.code).toBe('invalid_path');
  });

  it('project.replay_events sends the after_sequence cursor', async () => {
    tauri.reply('desktop_request', { replayed: 3, last_sequence: 12 });
    const result = await projectReplayEvents(9);
    expect(result.replayed).toBe(3);
    expect(tauri.callsOf('desktop_request')[0]!.args).toEqual({
      method: 'project.replay_events',
      payload: { after_sequence: 9 },
    });
  });
});

describe('event dedupe window', () => {
  it('applies ascending sequences and drops exact re-deliveries', () => {
    const deduper = new EventDeduper();
    expect(deduper.accept({ session: 's1', sequence: 1 })).toEqual({ kind: 'apply' });
    expect(deduper.accept({ session: 's1', sequence: 2 })).toEqual({ kind: 'apply' });
    expect(deduper.accept({ session: 's1', sequence: 2 })).toEqual({ kind: 'duplicate' });
    expect(deduper.accept({ session: 's1', sequence: 1 })).toEqual({ kind: 'duplicate' });
    expect(deduper.snapshot().duplicatesDropped).toBe(2);
    expect(deduper.accept({ session: 's1', sequence: 3 })).toEqual({ kind: 'apply' });
  });

  it('a session change resets the sequence window', () => {
    const deduper = new EventDeduper();
    deduper.accept({ session: 's1', sequence: 100 });
    const verdict = deduper.accept({ session: 's2', sequence: 1 });
    expect(verdict).toEqual({ kind: 'session-change', previous: 's1', current: 's2' });
    // Sequence 1 of the new session is not a duplicate even though the old
    // window was far ahead.
    expect(deduper.accept({ session: 's2', sequence: 2 })).toEqual({ kind: 'apply' });
    expect(deduper.accept({ session: 's2', sequence: 1 })).toEqual({ kind: 'duplicate' });
  });

  it('reset() forces a fresh window', () => {
    const deduper = new EventDeduper();
    deduper.accept({ session: 's1', sequence: 5 });
    deduper.reset('s9');
    expect(deduper.accept({ session: 's9', sequence: 1 })).toEqual({ kind: 'apply' });
  });

  it('events without session share one anonymous window', () => {
    const deduper = new EventDeduper();
    expect(deduper.accept({ sequence: 1 })).toEqual({ kind: 'apply' });
    expect(deduper.accept({ sequence: 1 })).toEqual({ kind: 'duplicate' });
    expect(deduper.accept({ sequence: 2 })).toEqual({ kind: 'apply' });
  });
});

describe('normalizeForwardedEvent', () => {
  it('keeps catalog events and their payload', () => {
    const envelope = normalizeForwardedEvent({
      event: 'run.progress',
      sequence: 12,
      session: 's1',
      projectId: 'p1',
      payload: { completed: 3, total: 6 },
    });
    expect(envelope).toEqual({
      event: 'run.progress',
      sequence: 12,
      session: 's1',
      projectId: 'p1',
      payload: { completed: 3, total: 6 },
    });
  });

  it('ignores unknown event names (additive compatibility)', () => {
    expect(normalizeForwardedEvent({ event: 'engine.progress', sequence: 1, payload: {} })).toBeNull();
  });

  it('ignores malformed shapes', () => {
    expect(normalizeForwardedEvent({ sequence: 1 } as never)).toBeNull();
    expect(normalizeForwardedEvent({ event: 'run.progress', sequence: '12' } as never)).toBeNull();
  });
});

describe('subscribeEngineEvents', () => {
  beforeEach(() => {
    tauri.reset();
  });

  it('delivers apply/duplicate/session-change verdicts and stops on unlisten', async () => {
    const deliveries: string[] = [];
    const unlisten = await subscribeEngineEvents((delivery) => {
      deliveries.push(
        delivery.kind === 'event'
          ? `event:${delivery.envelope.event}:${delivery.envelope.sequence}`
          : delivery.kind === 'duplicate'
            ? `dup:${delivery.envelope.sequence}`
            : `session:${delivery.previous}->${delivery.current}`,
      );
    });

    tauri.emit('desktop://event', { event: 'engine.ready', sequence: 1, session: 's1', payload: {} });
    tauri.emit('desktop://event', { event: 'run.started', sequence: 2, session: 's1', payload: {} });
    tauri.emit('desktop://event', { event: 'run.started', sequence: 2, session: 's1', payload: {} });
    tauri.emit('desktop://event', { event: 'engine.ready', sequence: 1, session: 's2', payload: {} });
    tauri.emit('desktop://event', { event: 'engine.progress', sequence: 2, session: 's2', payload: {} });

    expect(deliveries).toEqual([
      'event:engine.ready:1',
      'event:run.started:2',
      'dup:2',
      'session:s1->s2',
    ]);

    unlisten();
    tauri.emit('desktop://event', { event: 'run.progress', sequence: 9, session: 's2', payload: {} });
    expect(deliveries).toHaveLength(4);
  });
});

describe('session notice resets the shared dedupe window', () => {
  beforeEach(() => {
    tauri.reset();
  });

  it('notice arriving before the new session events: they apply without re-firing a session-change', async () => {
    const deduper = new EventDeduper();
    const verdicts: string[] = [];
    const unlistenEvents = await subscribeEngineEvents((delivery) => verdicts.push(delivery.kind), { deduper });
    const unlistenSession = await subscribeSessionChanges(() => undefined, { deduper });

    tauri.emit('desktop://event', { event: 'run.progress', sequence: 4, session: 's1', payload: {} });
    // Sidecar restart: the shell's desktop://session notice lands before the
    // first forwarded event of the new session.
    tauri.emit('desktop://session', { previous: 's1', current: 's2', lastSequence: 4 });
    tauri.emit('desktop://event', { event: 'engine.ready', sequence: 1, session: 's2', payload: {} });

    expect(verdicts).toEqual(['event', 'event']); // no session-change verdict re-fire
    expect(deduper.snapshot()).toEqual({ lastSession: 's2', lastSequence: 1, duplicatesDropped: 0 });

    unlistenEvents();
    unlistenSession();
  });

  it('without a shared deduper the session subscriber forwards notices unchanged', async () => {
    const currents: Array<string | null> = [];
    const unlisten = await subscribeSessionChanges((change) => currents.push(change.current ?? null));
    tauri.emit('desktop://session', { previous: 's1', current: 's2' });
    expect(currents).toEqual(['s2']);
    unlisten();
  });
});

describe('artifacts read wrappers', () => {
  beforeEach(() => {
    tauri.reset();
  });

  it('each kind sends artifacts.read with exactly its kind payload', async () => {
    tauri.on('desktop_request', (_cmd: string, args?: Record<string, unknown>) => ({
      kind: (args as { payload?: { kind?: string } })?.payload?.kind,
      count: 0,
    }));
    const facts = await readFacts();
    const world = await readWorld();
    const summaries = await readSummaries();
    expect(facts).toEqual({ kind: 'facts', count: 0 });
    expect(world).toEqual({ kind: 'world', count: 0 });
    expect(summaries).toEqual({ kind: 'summary', count: 0 });
    expect(tauri.callsOf('desktop_request').map((c) => c.args)).toEqual([
      { method: 'artifacts.read', payload: { kind: 'facts' } },
      { method: 'artifacts.read', payload: { kind: 'world' } },
      { method: 'artifacts.read', payload: { kind: 'summary' } },
    ]);
  });
});
