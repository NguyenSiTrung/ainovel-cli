/**
 * Smoke diagnostics flow against the shared protocol fixtures
 * (protocols/desktop-v1/fixtures/valid-requests-catalog.jsonl): mounting the
 * real shell on the diagnostics route pulls the observer-only views
 * (snapshot / queue / logs / usage) and the export button drives one
 * `diagnostics.export` whose output_path matches the binding fixture. The
 * optional `include` filter is deliberately NOT sent — the engine has no
 * section-filter support, so the UI always requests every sanitized section
 * (the fixture field is optional, README §6). No LLM, no real files.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
vi.mock('@tauri-apps/plugin-dialog', async () => {
  const { dialogMock } = await import('$tests/dialog-mock');
  return {
    open: (options: unknown) => dialogMock.open(options as never),
    save: (options: unknown) => dialogMock.save(options as never),
  };
});

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { get } from 'svelte/store';

import AppShell from '$lib/components/AppShell.svelte';
import { resetDiagnosticsState } from '$lib/diagnostics';
import { currentRoute } from '$lib/routes';
import { activity, connectionState, disposeDesktop, initDesktop, projectSnapshot } from '$lib/stores/desktop';
import { dialogMock } from '$tests/dialog-mock';
import { engineEvent, installBridgeMarker, tauri } from '$tests/tauri-mock';

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

function loadCatalog(): string {
  const candidates = [
    resolve(process.cwd(), '../../protocols/desktop-v1/fixtures/valid-requests-catalog.jsonl'),
    resolve(process.cwd(), 'protocols/desktop-v1/fixtures/valid-requests-catalog.jsonl'),
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, 'utf8');
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`fixture not found (tried: ${candidates.join(', ')})`);
}
const catalog = loadCatalog()
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line) as { method: string; payload?: Record<string, unknown> });
const exportFixture = catalog.find((entry) => entry.method === 'diagnostics.export');
if (!exportFixture?.payload?.output_path) throw new Error('diagnostics.export fixture missing');
const FIXTURE_OUTPUT_PATH = exportFixture.payload.output_path as string;

const SNAPSHOT = {
  state: 'idle',
  book_title: 'First Novel',
  total_chapters: 12,
  completed_chapters: 3,
};

function scriptEngine(): void {
  tauri.reply('desktop_status', READY_STATUS);
  tauri.reply('desktop_event_state', {
    session: 'sess-1',
    lastSequence: 0,
    sessionsSeen: 1,
    duplicatesDropped: 0,
    forwardedCount: 0,
    sessionChanges: 0,
  });
  tauri.on('desktop_request', (_cmd, args) => {
    const method = (args as { method?: string })?.method;
    switch (method) {
      case 'diagnostics.snapshot':
        return {
          stats: { completed_chapters: 3, total_chapters: 12, total_words: 7900 },
          findings: [
            {
              rule: 'pacing-slow',
              category: 'pacing',
              severity: 'medium',
              confidence: 'high',
              title: 'Chapter pacing dips',
              evidence: 'beat density',
              suggestion: 'tighten',
            },
          ],
          runtime: {
            current_step: 'outline',
            stuck_step: '',
            stuck_count: 0,
            log_errors: 0,
            log_warns: 1,
            stop_guard: '',
            models: [{ agent: 'writer', provider: 'openai', model: 'gpt-4o-mini' }],
            load_errors: false,
          },
          planned_actions: 0,
        };
      case 'diagnostics.export':
        return { output_path: FIXTURE_OUTPUT_PATH, sanitized: true, findings: 1 };
      case 'logs.replay':
        return {
          records: [
            { sequence: 1, time: '2026-09-03T10:00:00Z', level: 'info', module: 'daemon', message: 'project opened' },
          ],
          count: 1,
          last_sequence: 1,
        };
      case 'runtime.queue':
        return { items: [], count: 0 };
      case 'usage.snapshot':
        return {
          usage: { input_tokens: 1000, output_tokens: 200, cost_usd: 0.1 },
          budget: { limit_usd: 25, spent_usd: 0.1 },
          per_agent: [],
        };
      case 'project.snapshot':
        return { ...SNAPSHOT };
      case 'project.replay_events':
        return { replayed: 0, last_sequence: 0 };
      default:
        throw { code: 'unknown_method', message: `unexpected ${method}` };
    }
  });
}

beforeEach(async () => {
  tauri.reset();
  dialogMock.reset();
  await disposeDesktop();
  resetDiagnosticsState();
  cleanup();
  installBridgeMarker();
  connectionState.set('ready');
  projectSnapshot.set({ ...SNAPSHOT });
  currentRoute.set('overview');
});

describe('fixture-driven diagnostics smoke', () => {
  it('generates a sanitized diagnostic export through the native destination', async () => {
    scriptEngine();
    dialogMock.saveImpl = async () => FIXTURE_OUTPUT_PATH;

    render(AppShell);
    currentRoute.set('diagnostics');
    await vi.waitFor(() => expect(screen.getByTestId('diagnostics-screen')).toBeTruthy());

    // Boot the real event pipeline so desktop://event deliveries apply.
    await initDesktop();

    // The observer-only views loaded: findings, logs, session facts.
    await vi.waitFor(() => expect(screen.getByTestId('diagnostics-finding').textContent).toContain('Chapter pacing dips'));
    await vi.waitFor(() => expect(screen.getByTestId('diagnostics-logs-records').textContent).toContain('project opened'));

    await fireEvent.click(screen.getByTestId('diagnostics-export'));

    const calls = tauri
      .callsOf('desktop_request')
      .filter((c) => (c.args as { method?: string })?.method === 'diagnostics.export');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const payload = (calls[0]!.args as { payload?: Record<string, unknown> }).payload;
    // Destination matches the binding fixture verbatim; `include` is NOT
    // sent (the engine has no section filter — every sanitized section is
    // exported; the fixture's `include` field is optional).
    expect(payload).toEqual({ output_path: FIXTURE_OUTPUT_PATH });

    await vi.waitFor(() => expect(screen.getByTestId('diagnostics-export-result')).toBeTruthy());
    expect(screen.getByTestId('diagnostics-export-result').textContent).toContain(FIXTURE_OUTPUT_PATH);
    expect(screen.getByTestId('diagnostics-export-result').textContent).toContain('1 findings');

    // The export also emits diagnostics.completed; the event pipeline
    // records it as activity (tolerant, never crashes).
    tauri.emit('desktop://event', engineEvent('diagnostics.completed', 5, { findings: 1, output_path: FIXTURE_OUTPUT_PATH }, 'sess-1'));
    await vi.waitFor(() =>
      expect(get(activity).some((entry) => entry.event === 'diagnostics.completed')).toBe(true),
    );

    // Observer-only across the whole flow: reads, export, and the boot
    // resync (snapshot + replay, all read-only) — no mutations anywhere.
    const methods = new Set(
      tauri.callsOf('desktop_request').map((c) => (c.args as { method?: string })?.method),
    );
    expect([...methods].sort()).toEqual(
      [
        'diagnostics.export',
        'diagnostics.snapshot',
        'logs.replay',
        'project.replay_events',
        'project.snapshot',
        'runtime.queue',
        'usage.snapshot',
      ].sort(),
    );
  });
});
