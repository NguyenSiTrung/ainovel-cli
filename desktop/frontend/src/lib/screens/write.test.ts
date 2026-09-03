/**
 * Write screen tests: plan/content/facts-activity panes, streaming render
 * with round separation on stream.clear (persisted rounds stay visible),
 * markdown/text rendering of generated content (with escaping), and the
 * empty state.
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

import { cleanup, render, screen } from '@testing-library/svelte';
import { get } from 'svelte/store';
import { tick } from 'svelte';

import WriteScreen from '$lib/screens/WriteScreen.svelte';
import {
  applyEngineEvent,
  connectionState,
  disposeDesktop,
  projectSnapshot,
  runState,
  stream,
} from '$lib/stores/desktop';
import { engineEvent, installBridgeMarker, tauri } from '$tests/tauri-mock';
import type { EventEnvelope } from '$lib/types/protocol';

const SNAPSHOT = {
  state: 'running',
  status_label: 'Writing chapter 5',
  phase: 'drafting',
  flow: 'standard',
  book_title: 'The Lantern Sea',
  total_chapters: 12,
  completed_chapters: 4,
  total_word_count: 42310,
  pending_steer: false,
  characters: [{ name: 'Mara' }, { name: 'The Keeper' }],
  outline: [
    { chapter: 1, title: 'The Arrival', core_event: 'Mara reaches the island' },
    { chapter: 2, title: 'First Light', core_event: 'The lamp flickers a reply' },
  ],
};

function apply(event: string, sequence: number, payload: Record<string, unknown> = {}): void {
  applyEngineEvent(engineEvent(event, sequence, payload, 'sess-1') as unknown as EventEnvelope);
}

function renderWrite(): { container: HTMLElement } {
  const { container } = render(WriteScreen, {
    props: { title: 'Write', description: 'Writing screen', owner: 'task 5' },
  });
  return { container };
}

beforeEach(async () => {
  tauri.reset();
  await disposeDesktop();
  cleanup();
  installBridgeMarker();
  connectionState.set('ready');
});

describe('write screen', () => {
  it('no project open: empty state, no panes', () => {
    projectSnapshot.set(null);
    renderWrite();
    expect(screen.getByTestId('write-empty')).toBeTruthy();
    expect(screen.queryByTestId('write-pane-content')).toBeNull();
  });

  it('plan pane projects the outline and run step; facts pane shows project facts', () => {
    projectSnapshot.set({ ...SNAPSHOT });
    runState.set({ status: 'running', step: 'beats' });
    renderWrite();

    const rows = screen.getAllByTestId('write-outline-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('The Arrival');
    expect(rows[0]!.textContent).toContain('Mara reaches the island');
    expect(screen.getByTestId('write-plan-step').textContent).toBe('beats');
    expect(screen.getByTestId('write-pane-facts').textContent).toContain('4/12');
    expect(screen.getByTestId('write-pane-facts').textContent).toContain('42,310');
    expect(screen.getByTestId('write-pane-facts').textContent).toContain('Characters');
  });

  it('streams deltas into a live round and renders markdown', () => {
    projectSnapshot.set({ ...SNAPSHOT });
    runState.set({ status: 'running' });
    apply('stream.delta', 3, { text: '# Chapter 5\n\n', channel: 'prose' });
    apply('stream.delta', 4, { text: 'The market **roared** with gulls.', channel: 'prose' });
    renderWrite();

    expect(screen.getByTestId('write-stream-live')).toBeTruthy();
    const rounds = screen.getAllByTestId('write-round');
    expect(rounds).toHaveLength(1);
    const markdown = screen.getByTestId('write-round-markdown');
    expect(markdown.querySelector('h1')?.textContent).toContain('Chapter 5');
    expect(markdown.querySelector('strong')?.textContent).toBe('roared');
  });

  it('stream.clear separates rounds; persisted rounds remain visible with their content', () => {
    projectSnapshot.set({ ...SNAPSHOT });
    runState.set({ status: 'running' });
    apply('stream.delta', 3, { text: 'First worker round text. ', channel: 'prose' });
    apply('stream.delta', 4, { text: 'More of round one.', channel: 'prose' });
    apply('stream.clear', 5, { channel: 'prose', reason: 'worker round complete' });
    apply('stream.delta', 6, { text: 'Second round begins.', channel: 'prose' });
    renderWrite();

    const rounds = screen.getAllByTestId('write-round');
    expect(rounds).toHaveLength(2);
    // Round 1 stays visible with its full persisted text and the clear reason.
    expect(rounds[0]!.textContent).toContain('First worker round text. More of round one.');
    expect(rounds[0]!.textContent).toContain('cleared: worker round complete');
    expect(rounds[0]!.dataset.roundIndex).toBe('1');
    // Round 2 is the live one.
    expect(rounds[1]!.textContent).toContain('Second round begins.');
    expect(rounds[1]!.dataset.roundIndex).toBe('2');
    expect(rounds[1]!.className).toContain('live');
  });

  it('plain-text content renders as paragraphs (text pass-through)', () => {
    projectSnapshot.set({ ...SNAPSHOT });
    apply('stream.delta', 3, { text: 'Just prose, no markup.', channel: 'prose' });
    renderWrite();
    const markdown = screen.getByTestId('write-round-markdown');
    expect(markdown.querySelector('p')?.textContent).toBe('Just prose, no markup.');
  });

  it('engine-generated HTML-looking content is escaped, never executed markup', () => {
    projectSnapshot.set({ ...SNAPSHOT });
    apply('stream.delta', 3, { text: '<script>alert(1)</script> and <b>bold</b>', channel: 'prose' });
    const { container } = renderWrite();

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByTestId('write-round-markdown').textContent).toContain('<script>alert(1)</script>');
  });

  it('multiple channels each keep their own rounds', () => {
    projectSnapshot.set({ ...SNAPSHOT });
    apply('stream.delta', 3, { text: 'prose line', channel: 'prose' });
    apply('stream.delta', 4, { text: 'note line', channel: 'notes' });
    renderWrite();

    expect(screen.getByTestId('write-channel-prose').textContent).toContain('prose line');
    expect(screen.getByTestId('write-channel-notes').textContent).toContain('note line');
  });

  it('writing events feed the facts pane activity list', () => {
    projectSnapshot.set({ ...SNAPSHOT });
    apply('run.started', 2, { run_id: 'r-1', goal: 'chapter 5' });
    apply('chapter.updated', 3, { chapter: 4, status: 'saved' });
    apply('notification.info', 4, { message: 'noise that is not writing-related' });
    renderWrite();

    const list = screen.getByTestId('write-activity-list');
    expect(list.textContent).toContain('run.started');
    expect(list.textContent).toContain('chapter.updated');
    expect(list.textContent).not.toContain('noise that is not writing-related');
  });

  it('advance hold from the snapshot is visible in the plan pane', async () => {
    projectSnapshot.set({ ...SNAPSHOT, has_advance_hold: true, advance_permit_chapter: 5 });
    renderWrite();
    expect(screen.getByTestId('write-pane-plan').textContent).toContain('holding at chapter 5');
    expect(screen.getByTestId('run-control-authorize-chapter')).toBeTruthy();

    projectSnapshot.set({ ...SNAPSHOT });
    await tick();
    expect(screen.queryByTestId('run-control-authorize-chapter')).toBeNull();
  });

  it('stream store current channel state stays consistent with the rendered rounds', () => {
    projectSnapshot.set({ ...SNAPSHOT });
    apply('stream.delta', 3, { text: 'abc', channel: 'prose' });
    apply('stream.clear', 4, { channel: 'prose', reason: 'reset' });
    renderWrite();

    // Store: channel text reset with a revision bump (task 4 semantics).
    expect(get(stream).channels['prose']!.text).toBe('');
    expect(get(stream).channels['prose']!.revision).toBe(1);
    // UI: the round is closed but its text persists.
    expect(screen.getAllByTestId('write-round')[0]!.textContent).toContain('abc');
  });
});
