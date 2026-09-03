/**
 * Co-create screen tests: conversation + staged streaming render, staged vs
 * durable distinction, draft review (markdown) + resume gating, suggestion
 * chips, cancel, mode selection payloads, and error presentation. Driven
 * through the real controller + store routing against the mock bridge.
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

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';

import CoCreateScreen from '$lib/screens/CoCreateScreen.svelte';
import { resetCocreateState } from '$lib/cocreate';
import {
  applyEngineEvent,
  connectionState,
  disposeDesktop,
  projectSnapshot,
} from '$lib/stores/desktop';
import { engineEvent, installBridgeMarker, tauri } from '$tests/tauri-mock';
import type { EventEnvelope } from '$lib/types/protocol';

const SNAPSHOT = {
  state: 'idle',
  book_title: 'The Lantern Sea',
  total_chapters: 12,
  completed_chapters: 3,
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

function renderScreen(): void {
  render(CoCreateScreen, { props: { title: 'Co-create', description: 'Co-create screen', owner: 'task 7' } });
}

beforeEach(async () => {
  tauri.reset();
  resetCocreateState();
  await disposeDesktop();
  cleanup();
  installBridgeMarker();
  connectionState.set('ready');
  projectSnapshot.set({ ...SNAPSHOT });
});

describe('co-create screen', () => {
  it('no project open: empty state', () => {
    projectSnapshot.set(null);
    renderScreen();
    expect(screen.getByTestId('cocreate-empty')).toBeTruthy();
    expect(screen.queryByTestId('cocreate-conversation-pane')).toBeNull();
  });

  it('staged banner + durable facts pane distinguish staged content from project facts', () => {
    renderScreen();
    expect(screen.getByTestId('cocreate-staged-note').textContent).toContain('nothing enters the book');
    const facts = screen.getByTestId('cocreate-facts');
    expect(facts.textContent).toContain('durable');
    expect(facts.textContent).toContain('The Lantern Sea');
    expect(screen.getByTestId('cocreate-draft-pane').querySelector('.staged-badge')).toBeTruthy();
  });

  it('cold start: message + mode segments send cocreate.start without a mode field', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    renderScreen();

    await fireEvent.input(screen.getByTestId('cocreate-message-input'), {
      target: { value: 'a lighthouse mystery' },
    });
    await fireEvent.click(screen.getByTestId('cocreate-send'));

    await vi.waitFor(() => expect(payloadOf('cocreate.start')).toEqual({ message: 'a lighthouse mystery' }));
    expect(screen.getByTestId('cocreate-turn-user').textContent).toContain('a lighthouse mystery');
  });

  it('stage mode selection sends mode:"stage"', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'stage' });
    renderScreen();

    await fireEvent.click(screen.getByTestId('cocreate-mode-stage'));
    await fireEvent.input(screen.getByTestId('cocreate-message-input'), {
      target: { value: 'darker second act' },
    });
    await fireEvent.click(screen.getByTestId('cocreate-send'));

    await vi.waitFor(() =>
      expect(payloadOf('cocreate.start')).toEqual({ message: 'darker second act', mode: 'stage' }),
    );
  });

  it('streamed previews render while the round is active and the terminal reply lands in history', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    renderScreen();
    await fireEvent.input(screen.getByTestId('cocreate-message-input'), { target: { value: 'hello' } });
    await fireEvent.click(screen.getByTestId('cocreate-send'));
    await vi.waitFor(() => expect(screen.getByTestId('cocreate-round-live')).toBeTruthy());

    apply('cocreate.progress', 2, { stage: 'thinking', message: 'pondering genre' });
    apply('cocreate.progress', 3, { stage: 'reply', message: 'What tone do you want?' });
    await vi.waitFor(() => expect(screen.getByTestId('cocreate-preview-reply').textContent).toContain('What tone do you want?'));

    apply('cocreate.progress', 4, {
      stage: 'assistant',
      message: 'A quiet, salt-worn mystery then.',
      ready: false,
      draft: '',
      suggestions: [],
    });
    await vi.waitFor(() => expect(screen.queryByTestId('cocreate-round-live')).toBeNull());
    expect(screen.getByTestId('cocreate-turn-assistant').textContent).toContain('A quiet, salt-worn mystery then.');
    expect(screen.queryByTestId('cocreate-preview')).toBeNull();
  });

  it('staged draft renders as markdown with the ready verdict and resume gating', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    renderScreen();
    await fireEvent.input(screen.getByTestId('cocreate-message-input'), { target: { value: 'hello' } });
    await fireEvent.click(screen.getByTestId('cocreate-send'));

    // First terminal: draft still empty -> resume stays locked.
    apply('cocreate.progress', 2, { stage: 'assistant', message: 'm', draft: '', ready: false });
    await vi.waitFor(() => expect(screen.getByTestId('cocreate-draft-empty')).toBeTruthy());
    expect(screen.getByTestId('cocreate-resume').hasAttribute('disabled')).toBe(true);

    // Second round produces the draft.
    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    await fireEvent.input(screen.getByTestId('cocreate-message-input'), { target: { value: 'make it eerie' } });
    await fireEvent.click(screen.getByTestId('cocreate-send'));
    apply('cocreate.progress', 4, {
      stage: 'assistant',
      message: 'done',
      draft: '# The Lantern Sea\n\nA keeper counts the dead.',
      ready: true,
      suggestions: ['add a rival keeper'],
    });

    await vi.waitFor(() => expect(screen.getByTestId('cocreate-draft').querySelector('h1')?.textContent).toContain('The Lantern Sea'));
    expect(screen.getByTestId('cocreate-draft-ready')).toBeTruthy();
    expect(screen.getByTestId('cocreate-resume').hasAttribute('disabled')).toBe(false);

    // Suggestion chip fills the composer.
    await fireEvent.click(screen.getByTestId('cocreate-suggestion'));
    expect((screen.getByTestId('cocreate-message-input') as HTMLTextAreaElement).value).toBe('add a rival keeper');
  });

  it('resume sends cocreate.resume and confirms; the staged panes reset', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    renderScreen();
    await fireEvent.input(screen.getByTestId('cocreate-message-input'), { target: { value: 'hello' } });
    await fireEvent.click(screen.getByTestId('cocreate-send'));
    apply('cocreate.progress', 2, { stage: 'assistant', message: 'm', draft: '## brief', ready: true });
    await vi.waitFor(() => expect(screen.getByTestId('cocreate-resume').hasAttribute('disabled')).toBe(false));

    tauri.reply('desktop_request', { accepted: true, mode: 'cold', run_id: 'run-1' });
    await fireEvent.click(screen.getByTestId('cocreate-resume'));
    await vi.waitFor(() => expect(payloadOf('cocreate.resume')).toEqual({}));
    await vi.waitFor(() => expect(screen.getByTestId('cocreate-resumed-note').textContent).toContain('Write screen'));
    expect(screen.getByTestId('cocreate-draft-empty')).toBeTruthy();
  });

  it('cancel sends the request and resets to the fresh composer', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    renderScreen();
    await fireEvent.input(screen.getByTestId('cocreate-message-input'), { target: { value: 'hello' } });
    await fireEvent.click(screen.getByTestId('cocreate-send'));
    apply('cocreate.progress', 2, { stage: 'assistant', message: 'm', draft: 'd', ready: true });
    await vi.waitFor(() => expect(screen.getByTestId('cocreate-cancel')).toBeTruthy());

    tauri.reply('desktop_request', { cancelled: true, stage: 'cold' });
    await fireEvent.click(screen.getByTestId('cocreate-cancel'));
    await vi.waitFor(() => expect(payloadOf('cocreate.cancel')).toEqual({}));
    await vi.waitFor(() => expect(screen.getByTestId('cocreate-mode-cold')).toBeTruthy());
    expect(screen.getByTestId('cocreate-conversation-empty')).toBeTruthy();
  });

  it('a structured start failure shows the error catalog entry with the code', async () => {
    tauri.fail('desktop_request', { code: 'host_busy', message: 'a co-create round is already in flight' });
    renderScreen();
    await fireEvent.input(screen.getByTestId('cocreate-message-input'), { target: { value: 'hello' } });
    await fireEvent.click(screen.getByTestId('cocreate-send'));

    await vi.waitFor(() => expect(screen.getByTestId('cocreate-error')).toBeTruthy());
    expect(screen.getByTestId('cocreate-error').textContent).toContain('[host_busy]');
    expect(screen.getByTestId('cocreate-error').textContent).toContain('already in flight');
  });

  it('a failed round (engine.error) is visible and the session survives for another message', async () => {
    tauri.reply('desktop_request', { accepted: true, mode: 'cold' });
    renderScreen();
    await fireEvent.input(screen.getByTestId('cocreate-message-input'), { target: { value: 'hello' } });
    await fireEvent.click(screen.getByTestId('cocreate-send'));
    apply('engine.error', 2, { code: 'operation_failed', message: 'co-create round failed: provider down' });

    await vi.waitFor(() => expect(screen.getByTestId('cocreate-round-error').textContent).toContain('provider down'));
    expect(screen.getByTestId('cocreate-message-input').hasAttribute('disabled')).toBe(false);
  });
});
