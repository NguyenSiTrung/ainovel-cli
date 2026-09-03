/**
 * Export screen tests: scope (whole book / chapter range), format choice,
 * native destination via the dialog mock (path forwarded verbatim), result
 * display (path/bytes/chapters/skipped), cancelled picker (no request, no
 * error), structured export failures, and invalid-range guarding.
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
vi.mock('@tauri-apps/plugin-dialog', async () => {
  const { dialogMock } = await import('$tests/dialog-mock');
  return {
    open: (options: unknown) => dialogMock.open(options as never),
    save: (options: unknown) => dialogMock.save(options as never),
  };
});

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

import ExportScreen from '$lib/screens/ExportScreen.svelte';
import { resetChaptersState } from '$lib/chapters';
import { connectionState, disposeDesktop, projectSnapshot } from '$lib/stores/desktop';
import { dialogMock } from '$tests/dialog-mock';
import { installBridgeMarker, tauri } from '$tests/tauri-mock';

const SNAPSHOT = {
  state: 'idle',
  book_title: 'The Lantern Sea',
  total_chapters: 12,
  completed_chapters: 3,
};

type ExportHandler = (payload: Record<string, unknown>) => unknown;

function scriptEngine(exportHandler: ExportHandler = () => ({ path: '/Users/demo/Exports/novel.txt', chapters: 3, bytes: 48000 })): void {
  tauri.on('desktop_request', (_cmd, args) => {
    const method = (args as { method?: string })?.method;
    const payload = (args as { payload?: Record<string, unknown> })?.payload ?? {};
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
        return exportHandler(payload);
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

function exportCalls(): Array<Record<string, unknown>> {
  return tauri
    .callsOf('desktop_request')
    .filter((c) => (c.args as { method?: string })?.method === 'chapter.export')
    .map((c) => (c.args as { payload?: Record<string, unknown> })?.payload ?? {});
}

function renderExport(): void {
  render(ExportScreen, { props: { title: 'Export', description: 'Export the book', owner: 'task 6' } });
}

beforeEach(async () => {
  tauri.reset();
  dialogMock.reset();
  await disposeDesktop();
  resetChaptersState();
  cleanup();
  installBridgeMarker();
  connectionState.set('ready');
  projectSnapshot.set({ ...SNAPSHOT });
});

describe('export screen', () => {
  it('no project open: empty state', () => {
    projectSnapshot.set(null);
    renderExport();
    expect(screen.getByTestId('export-empty')).toBeTruthy();
    expect(screen.queryByTestId('export-form')).toBeNull();
  });

  it('whole-book export: dialog destination → chapter.export without a chapters field', async () => {
    scriptEngine();
    dialogMock.saveImpl = async () => '/Users/demo/Exports/the-lantern-sea.txt';
    renderExport();

    await fireEvent.click(screen.getByTestId('export-run'));
    await vi.waitFor(() => expect(exportCalls()).toHaveLength(1));
    expect(exportCalls()[0]).toEqual({
      format: 'txt',
      output_path: '/Users/demo/Exports/the-lantern-sea.txt',
    });
    // Save dialog carried the txt filter and a default file name.
    expect(dialogMock.saveCalls[0]?.filters).toEqual([{ name: 'Plain text', extensions: ['txt'] }]);
    expect(dialogMock.saveCalls[0]?.defaultPath).toContain('txt');

    await vi.waitFor(() => expect(screen.getByTestId('export-result')).toBeTruthy());
    // The engine's returned path is authoritative (it may normalize).
    expect(screen.getByTestId('export-result-path').textContent).toBe('/Users/demo/Exports/novel.txt');
    expect(screen.getByTestId('export-result-bytes').textContent).toBe('46.9 KB');
    expect(screen.getByTestId('export-result-chapters').textContent).toBe('3');
  });

  it('chapter range export sends the enumerated chapters array', async () => {
    scriptEngine();
    dialogMock.saveImpl = async () => '/Users/demo/Exports/range.epub';
    renderExport();

    await fireEvent.click(screen.getByTestId('export-mode-range'));
    await fireEvent.input(screen.getByTestId('export-from'), { target: { value: '2' } });
    await fireEvent.input(screen.getByTestId('export-to'), { target: { value: '3' } });
    await fireEvent.click(screen.getByTestId('export-format-epub'));
    await fireEvent.click(screen.getByTestId('export-run'));

    await vi.waitFor(() => expect(exportCalls()).toHaveLength(1));
    expect(exportCalls()[0]).toEqual({
      chapters: [2, 3],
      format: 'epub',
      output_path: '/Users/demo/Exports/range.epub',
    });
    expect(dialogMock.saveCalls[0]?.filters).toEqual([{ name: 'EPUB', extensions: ['epub'] }]);
  });

  it('single-chapter range (from == to) sends one entry', async () => {
    scriptEngine();
    dialogMock.saveImpl = async () => '/Users/demo/Exports/ch1.txt';
    renderExport();
    await fireEvent.click(screen.getByTestId('export-mode-range'));
    await fireEvent.click(screen.getByTestId('export-run'));
    await vi.waitFor(() => expect(exportCalls()).toHaveLength(1));
    expect(exportCalls()[0]).toMatchObject({ chapters: [1] });
  });

  it('skipped chapters are shown in the result', async () => {
    scriptEngine(() => ({ path: '/x/novel.txt', chapters: 2, bytes: 1024, skipped: [3] }));
    dialogMock.saveImpl = async () => '/x/novel.txt';
    renderExport();
    await fireEvent.click(screen.getByTestId('export-run'));
    await vi.waitFor(() => expect(screen.getByTestId('export-result-skipped')).toBeTruthy());
    expect(screen.getByTestId('export-result-skipped').textContent).toBe('3');
  });

  it('cancelled destination picker: no request, no error, back to idle', async () => {
    scriptEngine();
    dialogMock.saveImpl = async () => null; // cancelled
    renderExport();
    await fireEvent.click(screen.getByTestId('export-run'));
    await vi.waitFor(() => expect(dialogMock.saveCalls).toHaveLength(1));
    expect(exportCalls()).toHaveLength(0);
    expect(screen.queryByTestId('export-error')).toBeNull();
    expect(screen.getByTestId('export-no-result')).toBeTruthy();
    expect(screen.getByTestId('export-run').hasAttribute('disabled')).toBe(false);
  });

  it('export failure surfaces the structured error with the code and action', async () => {
    scriptEngine(() => {
      throw { code: 'operation_failed', message: 'export failed: chapter 7 unreadable' };
    });
    dialogMock.saveImpl = async () => '/x/novel.txt';
    renderExport();
    await fireEvent.click(screen.getByTestId('export-run'));
    await vi.waitFor(() => expect(screen.getByTestId('export-error')).toBeTruthy());
    expect(screen.getByTestId('export-error').textContent).toContain('[operation_failed]');
    expect(screen.getByTestId('export-error').textContent).toContain('chapter 7 unreadable');
    // Dismissing clears it.
    await fireEvent.click(screen.getByTestId('export-dismiss-error'));
    await vi.waitFor(() => expect(screen.queryByTestId('export-error')).toBeNull());
  });

  it('invalid range (to < from) disables the export button and no picker opens', async () => {
    scriptEngine();
    renderExport();
    await fireEvent.click(screen.getByTestId('export-mode-range'));
    await fireEvent.input(screen.getByTestId('export-from'), { target: { value: '5' } });
    await fireEvent.input(screen.getByTestId('export-to'), { target: { value: '2' } });
    expect(screen.getByTestId('export-range-invalid')).toBeTruthy();
    expect(screen.getByTestId('export-run').hasAttribute('disabled')).toBe(true);
    expect(dialogMock.saveCalls).toHaveLength(0);
  });

  it('running export disables the button until the response returns', async () => {
    let release: (value: unknown) => void = () => {};
    scriptEngine(
      () =>
        new Promise((resolve) => {
          release = resolve as (value: unknown) => void;
        }),
    );
    dialogMock.saveImpl = async () => '/x/novel.txt';
    renderExport();
    await fireEvent.click(screen.getByTestId('export-run'));
    await vi.waitFor(() => expect(screen.getByTestId('export-inflight')).toBeTruthy());
    expect(screen.getByTestId('export-run').hasAttribute('disabled')).toBe(true);
    release({ path: '/x/novel.txt', chapters: 3, bytes: 1 });
    await vi.waitFor(() => expect(screen.getByTestId('export-result')).toBeTruthy());
  });

  it('dismiss clears a completed result', async () => {
    scriptEngine();
    dialogMock.saveImpl = async () => '/x/novel.txt';
    renderExport();
    await fireEvent.click(screen.getByTestId('export-run'));
    await vi.waitFor(() => expect(screen.getByTestId('export-result')).toBeTruthy());
    await fireEvent.click(screen.getByTestId('export-dismiss'));
    await vi.waitFor(() => expect(screen.queryByTestId('export-result')).toBeNull());
    expect(screen.getByTestId('export-no-result')).toBeTruthy();
  });
});
