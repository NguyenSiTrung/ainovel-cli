/**
 * Import screen tests: native source selection via the dialog mock (path
 * forwarded verbatim, cancelled picker sends nothing), option payload,
 * progress + structural terminals display, result (continued) vs durable
 * facts distinction, cancel, and structured error presentation.
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

import ImportScreen from '$lib/screens/ImportScreen.svelte';
import { resetImportState } from '$lib/imports';
import {
  applyEngineEvent,
  connectionState,
  disposeDesktop,
  projectSnapshot,
} from '$lib/stores/desktop';
import { dialogMock } from '$tests/dialog-mock';
import { engineEvent, installBridgeMarker, tauri } from '$tests/tauri-mock';
import type { EventEnvelope } from '$lib/types/protocol';

const SNAPSHOT = {
  state: 'idle',
  book_title: 'The Lantern Sea',
  total_chapters: 12,
  completed_chapters: 3,
  total_word_count: 9001,
};

function apply(event: string, sequence: number, payload: Record<string, unknown> = {}): void {
  applyEngineEvent(engineEvent(event, sequence, payload, 'sess-1') as unknown as EventEnvelope);
}

function payloadOf(method: string): Record<string, unknown> | undefined {
  const call = tauri
    .callsOf('desktop_request')
    .find((c) => (c.args as { method?: string })?.method === method);
  return (call?.args as { payload?: Record<string, unknown> })?.payload;
}

function scriptEngine(): void {
  tauri.on('desktop_request', (_cmd, args) => {
    const method = (args as { method?: string })?.method;
    switch (method) {
      case 'project.snapshot':
        return { ...SNAPSHOT };
      case 'import.start':
        return { accepted: true, source_path: '/books/source.txt' };
      case 'import.resume':
        return { accepted: true, source_path: '' };
      default:
        return { accepted: true };
    }
  });
}

function renderScreen(): void {
  render(ImportScreen, { props: { title: 'Import', description: 'Import screen', owner: 'task 7' } });
}

beforeEach(async () => {
  tauri.reset();
  dialogMock.reset();
  resetImportState();
  await disposeDesktop();
  cleanup();
  installBridgeMarker();
  connectionState.set('ready');
  projectSnapshot.set({ ...SNAPSHOT });
});

describe('import screen', () => {
  it('no project open: empty state', () => {
    projectSnapshot.set(null);
    renderScreen();
    expect(screen.getByTestId('import-empty')).toBeTruthy();
    expect(screen.queryByTestId('import-form')).toBeNull();
  });

  it('staged banner and durable facts pane are distinct', () => {
    renderScreen();
    expect(screen.getByTestId('import-staged-note').textContent).toContain('durable');
    const facts = screen.getByTestId('import-facts');
    expect(facts.textContent).toContain('durable');
    expect(facts.textContent).toContain('9,001');
  });

  it('file pick + default options produce the exact import.start payload', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => '/books/the-lantern-sea.txt';
    renderScreen();

    await fireEvent.click(screen.getByTestId('import-run'));
    await vi.waitFor(() =>
      expect(payloadOf('import.start')).toEqual({
        source_path: '/books/the-lantern-sea.txt',
        options: { auto_confirm: true, continue_after: false },
      }),
    );
    // The engine echo is authoritative for the source line.
    await vi.waitFor(() => expect(screen.getByTestId('import-source').textContent).toContain('/books/source.txt'));
  });

  it('option changes ride the nested options object', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => '/books/x.txt';
    renderScreen();

    await fireEvent.click(screen.getByTestId('import-option-continue'));
    await fireEvent.change(screen.getByTestId('import-option-story-select'), { target: { value: 'open' } });
    await fireEvent.input(screen.getByTestId('import-option-guidance-input'), { target: { value: 'keep the poetry' } });
    await fireEvent.click(screen.getByTestId('import-run'));

    await vi.waitFor(() =>
      expect(payloadOf('import.start')).toEqual({
        source_path: '/books/x.txt',
        options: {
          auto_confirm: true,
          continue_after: true,
          story_resolution: 'open',
          guidance: 'keep the poetry',
        },
      }),
    );
  });

  it('cancelled picker: no request, no error, button re-enabled', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => null;
    renderScreen();

    await fireEvent.click(screen.getByTestId('import-run'));
    await vi.waitFor(() => expect(dialogMock.openCalls).toHaveLength(1));
    expect(tauri.callsOf('desktop_request').filter((c) => (c.args as { method?: string }).method === 'import.start')).toHaveLength(0);
    expect(screen.getByTestId('import-no-result')).toBeTruthy();
    expect(screen.getByTestId('import-run').hasAttribute('disabled')).toBe(false);
  });

  it('progress events render stage/units and the recent list', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => '/books/source.txt';
    renderScreen();
    await fireEvent.click(screen.getByTestId('import-run'));
    await vi.waitFor(() => expect(screen.getByTestId('import-status').textContent).toBe('importing…'));

    apply('import.progress', 2, { stage: 'ingesting', completed: 1, total: 10, detail: 'decoding gb18030' });
    apply('import.progress', 3, { stage: 'segmenting', completed: 5, total: 10, detail: 'splitting chapters' });

    await vi.waitFor(() => expect(screen.getByTestId('import-progress').textContent).toContain('segmenting'));
    expect(screen.getByTestId('import-progress').textContent).toContain('5/10');
    expect(screen.getByTestId('import-recent').textContent).toContain('decoding gb18030');
  });

  it('terminal done shows the completed result with the continue-after fact', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => '/books/source.txt';
    renderScreen();
    await fireEvent.click(screen.getByTestId('import-run'));
    await vi.waitFor(() => expect(screen.getByTestId('import-status').textContent).toBe('importing…'));
    apply('import.progress', 2, { stage: 'done', completed: 10, total: 10, detail: 'published', continued: true });

    await vi.waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(screen.getByTestId('import-status').textContent).toBe('completed');
    expect(screen.getByTestId('import-result-continued').textContent).toContain('continued into a writing run');
    expect(screen.getByTestId('import-result').textContent).toContain('durable project facts');
  });

  it('a stage failure shows the structured operation_failed error and dismisses', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => '/books/source.txt';
    renderScreen();
    await fireEvent.click(screen.getByTestId('import-run'));
    await vi.waitFor(() => expect(screen.getByTestId('import-status').textContent).toBe('importing…'));
    apply('import.progress', 2, { stage: 'analyzing', error: 'provider exploded' });

    await vi.waitFor(() => expect(screen.getByTestId('import-error')).toBeTruthy());
    expect(screen.getByTestId('import-error').textContent).toContain('[operation_failed]');
    expect(screen.getByTestId('import-error').textContent).toContain('provider exploded');

    await fireEvent.click(screen.getByTestId('import-dismiss-error'));
    await vi.waitFor(() => expect(screen.queryByTestId('import-error')).toBeNull());
  });

  it('cancel is offered while running and answers back into the status line', async () => {
    scriptEngine();
    dialogMock.openImpl = async () => '/books/source.txt';
    renderScreen();
    await fireEvent.click(screen.getByTestId('import-run'));
    expect(screen.getByTestId('import-cancel').hasAttribute('disabled')).toBe(true);

    apply('import.progress', 2, { stage: 'ingesting', detail: 'reading' });
    await vi.waitFor(() => expect(screen.getByTestId('import-cancel').hasAttribute('disabled')).toBe(false));

    tauri.reply('desktop_request', { cancelled: false, reason: 'no import in progress' });
    await fireEvent.click(screen.getByTestId('import-cancel'));
    await vi.waitFor(() => expect(screen.getByTestId('import-message').textContent).toContain('no import in progress'));
    expect(screen.getByTestId('import-status').textContent).toBe('importing…');
  });

  it('resume re-enters the workspace with no payload', async () => {
    scriptEngine();
    renderScreen();
    await fireEvent.click(screen.getByTestId('import-resume'));
    await vi.waitFor(() => expect(payloadOf('import.resume')).toEqual({}));
    await vi.waitFor(() => expect(screen.getByTestId('import-source').textContent).toContain('active workspace'));
  });

  it('an inaccessible source shows the engine error with its action hint', async () => {
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'import.start') {
        throw { code: 'operation_failed', message: 'source file not accessible: open /x: no such file' };
      }
      return { accepted: true };
    });
    dialogMock.openImpl = async () => '/x/missing.txt';
    renderScreen();

    await fireEvent.click(screen.getByTestId('import-run'));
    await vi.waitFor(() => expect(screen.getByTestId('import-error')).toBeTruthy());
    expect(screen.getByTestId('import-error').textContent).toContain('source file not accessible');
  });
});
