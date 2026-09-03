/**
 * Artifacts screen tests: outline/characters/story stay snapshot
 * projections; facts/world/summaries are read through artifacts.read
 * (desktop-v1 §12) — issued on entry, rendered read-only with per-kind
 * error/empty states, re-read on Refresh and on the engine's chapter
 * update signal (via the snapshot refresh chain), and silent on
 * project_unavailable. No fabricated content anywhere.
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

import {
  enterArtifactsScreen,
  leaveArtifactsScreen,
  resetArtifactsState,
} from '$lib/artifacts';
import ArtifactsScreen from '$lib/screens/ArtifactsScreen.svelte';
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
  synopsis: 'A lighthouse keeper discovers the light answers back.',
  premise: 'What if the sea kept its promises?',
  style: 'Lyrical, close third person',
  total_chapters: 12,
  completed_chapters: 3,
  outline: [
    { chapter: 1, title: 'The Arrival', core_event: 'Mara reaches the island' },
    { chapter: 2, title: 'First Light', core_event: 'The lamp flickers a reply' },
    { chapter: 3, title: 'The Bargain', core_event: 'A price is named' },
  ],
  characters: ['Mara', 'The Keeper'],
};

const FACTS = {
  kind: 'facts',
  count: 2,
  facts: [
    {
      chapter: 1,
      version: 3,
      origin: 'record',
      facts: {
        title: 'The Arrival',
        summary: 'Mara reaches the island.',
        characters: ['Mara', 'The Keeper'],
        key_events: ['The ferry leaves', 'The lamp answers'],
      },
    },
    {
      chapter: 2,
      version: 1,
      origin: 'sync',
      facts: { title: 'First Light', summary: 'The lamp flickers.', hook_type: 'mystery' },
    },
  ],
};

const WORLD = {
  kind: 'world',
  count: 2,
  rules: [
    { category: 'magic', rule: 'Lamps answer only in verse.', boundary: 'Never prose.' },
    { category: 'geography', rule: 'Nine islands, one tide.' },
  ],
};

const SUMMARIES = {
  kind: 'summary',
  count: 1,
  summaries: [
    {
      chapter: 1,
      title: 'The Arrival',
      summary: 'Mara reaches the island and the light answers back.',
      characters: ['Mara'],
      key_events: ['The ferry leaves', 'The reply'],
    },
  ],
};

interface ScriptOptions {
  /** artifacts.read kinds that reject with operation_failed. */
  failKinds?: string[];
  /** Override the canned payloads (default: FACTS/WORLD/SUMMARIES). */
  facts?: unknown;
  world?: unknown;
  summaries?: unknown;
}

function scriptEngine(opts: ScriptOptions = {}): void {
  tauri.on('desktop_request', (_cmd: string, args?: Record<string, unknown>) => {
    const method = (args as { method?: string })?.method;
    switch (method) {
      case 'project.snapshot':
        return { ...SNAPSHOT };
      case 'project.replay_events':
        return { replayed: 0, last_sequence: 0 };
      case 'usage.snapshot':
        return { usage: {} };
      case 'artifacts.read': {
        const kind = (args as { payload?: { kind?: string } })?.payload?.kind;
        if (opts.failKinds?.includes(kind ?? '')) {
          throw { code: 'operation_failed', message: `artifacts.read (${kind}) failed` };
        }
        if (kind === 'facts') return opts.facts !== undefined ? opts.facts : FACTS;
        if (kind === 'world') return opts.world !== undefined ? opts.world : WORLD;
        if (kind === 'summary') return opts.summaries !== undefined ? opts.summaries : SUMMARIES;
        throw { code: 'invalid_payload', message: `unexpected kind ${kind}` };
      }
      default:
        throw { code: 'unknown_method', message: `unexpected ${method}` };
    }
  });
}

function renderArtifacts(): void {
  render(ArtifactsScreen, { props: { title: 'Artifacts', description: 'Read-only', owner: 'task 6' } });
}

/** Count of issued artifacts.read requests for one kind. */
function readCalls(kind: string): number {
  return tauri
    .callsOf('desktop_request')
    .filter(
      (c) =>
        (c.args as { method?: string })?.method === 'artifacts.read' &&
        (c.args as { payload?: { kind?: string } })?.payload?.kind === kind,
    ).length;
}

function snapshotCalls(): number {
  return tauri.callsOf('desktop_request').filter((c) => (c.args as { method?: string })?.method === 'project.snapshot').length;
}

function apply(event: string, sequence: number, payload: Record<string, unknown> = {}): void {
  applyEngineEvent(engineEvent(event, sequence, payload, 'sess-1') as unknown as EventEnvelope);
}

beforeEach(async () => {
  tauri.reset();
  await disposeDesktop();
  cleanup();
  leaveArtifactsScreen();
  resetArtifactsState();
  installBridgeMarker();
  connectionState.set('ready');
});

describe('artifacts screen', () => {
  it('no project open: empty state, and no artifacts.read is issued', () => {
    projectSnapshot.set(null);
    renderArtifacts();
    expect(screen.getByTestId('artifacts-empty')).toBeTruthy();
    expect(screen.queryByTestId('artifacts-outline')).toBeNull();
    expect(readCalls('facts')).toBe(0);
    expect(readCalls('world')).toBe(0);
    expect(readCalls('summary')).toBe(0);
  });

  it('renders the outline and characters read-only from the snapshot', () => {
    projectSnapshot.set({ ...SNAPSHOT });
    renderArtifacts();

    const rows = screen.getAllByTestId('artifacts-outline-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('The Arrival');
    expect(rows[0]!.textContent).toContain('Mara reaches the island');
    expect(screen.getByTestId('artifacts-outline').textContent).toContain('answers back');

    const characters = screen.getAllByTestId('artifacts-character');
    expect(characters.map((c) => c.textContent)).toEqual(['Mara', 'The Keeper']);
    expect(screen.getByTestId('artifacts-story').textContent).toContain('What if the sea kept its promises?');
    expect(screen.getByTestId('artifacts-story').textContent).toContain('Lyrical, close third person');
  });

  it('renders structured character objects by name when the engine sends them', () => {
    projectSnapshot.set({ ...SNAPSHOT, characters: [{ name: 'Mara', role: 'protagonist' }, { name: 'The Keeper' }] });
    renderArtifacts();
    expect(screen.getAllByTestId('artifacts-character').map((c) => c.textContent)).toEqual([
      'Mara',
      'The Keeper',
    ]);
  });

  it('screen entry issues all three artifacts.read requests with exact payloads', async () => {
    scriptEngine();
    projectSnapshot.set({ ...SNAPSHOT });
    renderArtifacts();
    await vi.waitFor(() => expect(screen.getAllByTestId('artifacts-facts-entry')).toHaveLength(2));
    expect(readCalls('facts')).toBe(1);
    expect(readCalls('world')).toBe(1);
    expect(readCalls('summary')).toBe(1);
    const payloads = tauri
      .callsOf('desktop_request')
      .filter((c) => (c.args as { method?: string })?.method === 'artifacts.read')
      .map((c) => (c as { args: { payload?: unknown } }).args.payload);
    expect(payloads).toContainEqual({ kind: 'facts' });
    expect(payloads).toContainEqual({ kind: 'world' });
    expect(payloads).toContainEqual({ kind: 'summary' });
  });

  it('renders chapter facts entries: meta, title, summary, characters, key events, additive JSON', async () => {
    scriptEngine();
    projectSnapshot.set({ ...SNAPSHOT });
    renderArtifacts();
    await vi.waitFor(() => expect(screen.getAllByTestId('artifacts-facts-entry')).toHaveLength(2));

    const first = screen.getAllByTestId('artifacts-facts-entry')[0]!;
    expect(first.textContent).toContain('Ch 1');
    expect(first.textContent).toContain('record');
    expect(first.textContent).toContain('v3');
    expect(first.textContent).toContain('The Arrival');
    expect(first.textContent).toContain('Mara reaches the island.');
    expect(
      Array.from(first.querySelectorAll('[data-testid="artifacts-facts-character"]')).map((c) => c.textContent),
    ).toEqual(['Mara', 'The Keeper']);
    expect(
      Array.from(first.querySelectorAll('[data-testid="artifacts-facts-event"]')).map((c) => c.textContent),
    ).toEqual(['The ferry leaves', 'The lamp answers']);
    // Named fields extracted for prose; chapter 2 carries an additive field.
    expect(first.querySelector('[data-testid="artifacts-facts-rest"]')).toBeNull();
    const second = screen.getAllByTestId('artifacts-facts-entry')[1]!;
    expect(second.textContent).toContain('First Light');
    expect(second.querySelector('[data-testid="artifacts-facts-rest"]')!.textContent).toContain('mystery');
  });

  it('renders world rules with category, rule, and boundary', async () => {
    scriptEngine();
    projectSnapshot.set({ ...SNAPSHOT });
    renderArtifacts();
    await vi.waitFor(() => expect(screen.getAllByTestId('artifacts-world-rule')).toHaveLength(2));
    const rules = screen.getAllByTestId('artifacts-world-rule');
    expect(rules[0]!.textContent).toContain('magic');
    expect(rules[0]!.textContent).toContain('Lamps answer only in verse.');
    expect(rules[0]!.textContent).toContain('Never prose.');
    expect(rules[1]!.textContent).toContain('Nine islands, one tide.');
  });

  it('renders chapter summaries as markdown with heading, characters, and key events', async () => {
    scriptEngine();
    projectSnapshot.set({ ...SNAPSHOT });
    renderArtifacts();
    await vi.waitFor(() => expect(screen.getByTestId('artifacts-summaries-content')).toBeTruthy());
    const content = screen.getByTestId('artifacts-summaries-content');
    expect(content.querySelector('h2')?.textContent).toContain('Chapter 1');
    expect(content.querySelector('h2')?.textContent).toContain('The Arrival');
    expect(content.textContent).toContain('Mara reaches the island and the light answers back.');
    expect(content.textContent).toContain('Characters:');
    expect(content.textContent).toContain('The ferry leaves');
  });

  it('empty kinds render explicit empty states, never fabricated content', async () => {
    scriptEngine({ facts: { kind: 'facts', count: 0, facts: [] }, world: { kind: 'world', count: 0, rules: [] }, summaries: { kind: 'summary', count: 0, summaries: [] } });
    projectSnapshot.set({ ...SNAPSHOT });
    renderArtifacts();
    await vi.waitFor(() => expect(screen.getByTestId('artifacts-facts-empty')).toBeTruthy());
    expect(screen.getByTestId('artifacts-world-empty')).toBeTruthy();
    expect(screen.getByTestId('artifacts-summaries-empty')).toBeTruthy();
    expect(screen.queryByTestId('error-banner')).toBeNull();
    expect(screen.queryByTestId('artifacts-summaries-content')).toBeNull();
  });

  it('a failing kind shows its error banner; sibling kinds still render', async () => {
    scriptEngine({ failKinds: ['world'] });
    projectSnapshot.set({ ...SNAPSHOT });
    renderArtifacts();
    await vi.waitFor(() => expect(screen.getByTestId('artifacts-world-error')).toBeTruthy());
    const worldError = screen.getByTestId('artifacts-world-error');
    expect(worldError.querySelector('[data-testid="error-banner"]')).toBeTruthy();
    expect(worldError.textContent).toContain('[operation_failed]');
    // Siblings are unaffected.
    expect(screen.getAllByTestId('artifacts-facts-entry')).toHaveLength(2);
    expect(screen.getByTestId('artifacts-summaries-content')).toBeTruthy();
    expect(screen.queryByTestId('artifacts-facts-error')).toBeNull();
    expect(screen.queryByTestId('artifacts-summaries-error')).toBeNull();
  });

  it('project_unavailable clears silently (empty state, no error banner)', async () => {
    // Every artifacts.read reports project_unavailable while the snapshot
    // itself still succeeds (the race the silent path guards against).
    tauri.on('desktop_request', (_cmd: string, args?: Record<string, unknown>) => {
      const method = (args as { method?: string })?.method;
      if (method === 'artifacts.read') {
        throw { code: 'project_unavailable', message: 'no project open' };
      }
      if (method === 'project.snapshot') return { ...SNAPSHOT };
      if (method === 'project.replay_events') return { replayed: 0, last_sequence: 0 };
      if (method === 'usage.snapshot') return { usage: {} };
      throw { code: 'unknown_method', message: `unexpected ${method}` };
    });
    projectSnapshot.set({ ...SNAPSHOT });
    renderArtifacts();
    await vi.waitFor(() => expect(readCalls('facts')).toBe(1));
    await vi.waitFor(() => expect(screen.getByTestId('artifacts-facts-empty')).toBeTruthy());
    expect(screen.getByTestId('artifacts-world-empty')).toBeTruthy();
    expect(screen.getByTestId('artifacts-summaries-empty')).toBeTruthy();
    expect(screen.queryByTestId('error-banner')).toBeNull();
  });

  it('no edit affordances exist anywhere on the screen', async () => {
    scriptEngine();
    projectSnapshot.set({ ...SNAPSHOT });
    const { container } = render(ArtifactsScreen, {
      props: { title: 'Artifacts', description: 'Read-only', owner: 'task 6' },
    });
    await vi.waitFor(() => expect(screen.getAllByTestId('artifacts-facts-entry')).toHaveLength(2));
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('button')).toBe(screen.getByTestId('artifacts-refresh'));
  });

  it('Refresh re-issues project.snapshot and all three artifacts.read', async () => {
    scriptEngine();
    projectSnapshot.set({ ...SNAPSHOT });
    renderArtifacts();
    await vi.waitFor(() => expect(readCalls('facts')).toBe(1));
    const snapshotsBefore = snapshotCalls();

    await fireEvent.click(screen.getByTestId('artifacts-refresh'));
    await vi.waitFor(() => {
      expect(readCalls('facts')).toBe(2);
      expect(readCalls('world')).toBe(2);
      expect(readCalls('summary')).toBe(2);
      expect(snapshotCalls()).toBe(snapshotsBefore + 1);
    });
  });

  it('chapter.updated refreshes the snapshot and re-reads the projections (update-signal chain)', async () => {
    scriptEngine();
    projectSnapshot.set({ ...SNAPSHOT });
    renderArtifacts();
    await vi.waitFor(() => expect(readCalls('facts')).toBe(1));
    const snapshotsBefore = snapshotCalls();

    apply('chapter.updated', 10, { chapter: 2, version: 3, status: 'saved' });
    await vi.waitFor(() => {
      expect(snapshotCalls()).toBeGreaterThan(snapshotsBefore);
      expect(readCalls('facts')).toBe(2);
      expect(readCalls('world')).toBe(2);
      expect(readCalls('summary')).toBe(2);
    });
  });

  it('leaving the screen stops snapshot-driven re-reads; re-entry resumes them', async () => {
    scriptEngine();
    projectSnapshot.set({ ...SNAPSHOT });
    renderArtifacts();
    await vi.waitFor(() => expect(readCalls('facts')).toBe(1));

    // Unmount: the snapshot-driven refresh must stop (no hidden-pane requests).
    cleanup();
    projectSnapshot.set({ ...SNAPSHOT, completed_chapters: 4 });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(readCalls('facts')).toBe(1);

    // Re-entry (controller-level, as the screen would on next mount) resumes.
    enterArtifactsScreen();
    await vi.waitFor(() => expect(readCalls('facts')).toBe(2));
    leaveArtifactsScreen();
  });
});
