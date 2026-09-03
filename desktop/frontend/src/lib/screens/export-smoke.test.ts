/**
 * Smoke export flow against the shared protocol fixtures
 * (protocols/desktop-v1/fixtures/valid-requests-catalog.jsonl): the
 * chapter.export request the UI emits must match the binding fixture
 * payload verbatim, and the result card must project the engine's answer.
 * No LLM, no real files — the bridge and dialog are the shared mocks.
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
import { resetChaptersState } from '$lib/chapters';
import { currentRoute } from '$lib/routes';
import { connectionState, disposeDesktop, projectSnapshot } from '$lib/stores/desktop';
import { dialogMock } from '$tests/dialog-mock';
import { installBridgeMarker, tauri } from '$tests/tauri-mock';

// The binding fixture request for chapter.export (shared by Go/Rust/frontend).
// Resolve relative to wherever vitest was invoked (frontend root or repo root).
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
const exportFixture = catalog.find((entry) => entry.method === 'chapter.export');
if (!exportFixture?.payload) throw new Error('chapter.export fixture missing');
const FIXTURE_PAYLOAD = exportFixture.payload;

/** Fixture-consistent project state: chapters 1-3 saved of 12. */
const SNAPSHOT = {
  state: 'idle',
  book_title: 'First Novel',
  total_chapters: 12,
  completed_chapters: 3,
  total_word_count: 7900,
};

const engine = {
  exportResult: { path: FIXTURE_PAYLOAD.output_path, chapters: 3, bytes: 512000 },
};

function scriptEngine(): void {
  tauri.on('desktop_request', (_cmd, args) => {
    const method = (args as { method?: string })?.method;
    switch (method) {
      case 'chapter.list':
        return {
          chapters: [
            { chapter: 1, title: 'The Arrival', words: 3200, version: 4, status: 'saved' },
            { chapter: 2, title: 'First Light', words: 2800, version: 2, status: 'saved' },
            { chapter: 3, title: 'The Bargain', words: 1900, version: 1, status: 'saved' },
          ],
          completed: 3,
          total: 12,
        };
      case 'chapter.export':
        return { ...engine.exportResult };
      case 'project.snapshot':
        return { ...SNAPSHOT };
      case 'project.replay_events':
        return { replayed: 0, last_sequence: 0 };
      case 'usage.snapshot':
        return { usage: {} };
      default:
        throw { code: 'unknown_method', message: `unexpected ${method}` };
    }
  });
}

beforeEach(async () => {
  tauri.reset();
  dialogMock.reset();
  engine.exportResult = { path: FIXTURE_PAYLOAD.output_path, chapters: 3, bytes: 512000 };
  await disposeDesktop();
  resetChaptersState();
  cleanup();
  installBridgeMarker();
  connectionState.set('ready');
  projectSnapshot.set({ ...SNAPSHOT });
  currentRoute.set('overview');
});

describe('fixture-driven export smoke', () => {
  it('the UI emits exactly the fixture chapter.export payload and projects the result', async () => {
    expect(Array.isArray(FIXTURE_PAYLOAD.chapters)).toBe(true);
    const [lo, hi] = ((FIXTURE_PAYLOAD.chapters as number[]).length > 0
      ? [
          Math.min(...(FIXTURE_PAYLOAD.chapters as number[])),
          Math.max(...(FIXTURE_PAYLOAD.chapters as number[])),
        ]
      : [1, 1]) as [number, number];

    scriptEngine();
    dialogMock.saveImpl = async () => FIXTURE_PAYLOAD.output_path as string;

    render(AppShell);
    currentRoute.set('export');
    await vi.waitFor(() => expect(screen.getByTestId('export-screen')).toBeTruthy());

    // Mirror the fixture's scope (chapters [1,2,3] → range 1–3) and format.
    await fireEvent.click(screen.getByTestId('export-mode-range'));
    await fireEvent.input(screen.getByTestId('export-from'), { target: { value: String(lo) } });
    await fireEvent.input(screen.getByTestId('export-to'), { target: { value: String(hi) } });
    const format = FIXTURE_PAYLOAD.format === 'epub' ? 'epub' : 'txt';
    await fireEvent.click(screen.getByTestId(`export-format-${format}`));
    await fireEvent.click(screen.getByTestId('export-run'));

    // The emitted request must match the binding fixture payload verbatim.
    const calls = tauri
      .callsOf('desktop_request')
      .filter((c) => (c.args as { method?: string })?.method === 'chapter.export');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const payload = (calls[0]!.args as { payload?: Record<string, unknown> }).payload;
    expect(payload).toEqual(FIXTURE_PAYLOAD);

    // Result card projects the engine's answer (path, bytes, chapters).
    await vi.waitFor(() => expect(screen.getByTestId('export-result')).toBeTruthy());
    expect(screen.getByTestId('export-result-path').textContent).toBe(FIXTURE_PAYLOAD.output_path);
    expect(screen.getByTestId('export-result-chapters').textContent).toBe('3');
    expect(screen.getByTestId('export-result-bytes').textContent).toBe('500.0 KB');

    // The projection stays clean: no error anywhere in the happy path.
    expect(screen.queryByTestId('export-error')).toBeNull();
    expect(get(projectSnapshot)?.book_title).toBe('First Novel');
  });
});
