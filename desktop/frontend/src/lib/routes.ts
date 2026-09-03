/**
 * Route registry for the application shell. Tasks 5-8 replace the
 * placeholder components with the real screens; the ids, labels, and order
 * here are the stable navigation contract.
 *
 * Navigation guards: screens with unsaved state (the task-6 chapter editor)
 * register a guard; `navigate` defers to it and records the blocked target so
 * the shell can ask the user what to do (save / discard / stay) before the
 * route actually changes.
 */

import type { Component } from 'svelte';
import { get, writable, type Writable } from 'svelte/store';

import ArtifactsScreen from '$lib/screens/ArtifactsScreen.svelte';
import ChaptersScreen from '$lib/screens/ChaptersScreen.svelte';
import CoCreateScreen from '$lib/screens/CoCreateScreen.svelte';
import DiagnosticsScreen from '$lib/screens/DiagnosticsScreen.svelte';
import ExportScreen from '$lib/screens/ExportScreen.svelte';
import ImportScreen from '$lib/screens/ImportScreen.svelte';
import OverviewScreen from '$lib/screens/OverviewScreen.svelte';
import SettingsScreen from '$lib/screens/SettingsScreen.svelte';
import SimulationScreen from '$lib/screens/SimulationScreen.svelte';
import WriteScreen from '$lib/screens/WriteScreen.svelte';

export type RouteId =
  | 'overview'
  | 'write'
  | 'chapters'
  | 'artifacts'
  | 'cocreate'
  | 'import'
  | 'simulation'
  | 'diagnostics'
  | 'settings'
  | 'export';

export interface RouteDefinition {
  id: RouteId;
  label: string;
  /** One-line scope note for the placeholder (owning task fills the screen). */
  description: string;
  owner: string;
  component: Component<{ title: string; description: string; owner: string }>;
}

export const ROUTES: readonly RouteDefinition[] = [
  {
    id: 'overview',
    label: 'Overview',
    description: 'Project, progress, runtime state, recovery, budget, usage, recent events, actions.',
    owner: 'task 5',
    component: OverviewScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'write',
    label: 'Write',
    description: 'Plan, streamed content, steer, pause, abort, continue, retry, chapter authorization.',
    owner: 'task 5',
    component: WriteScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'chapters',
    label: 'Chapters',
    description: 'List, read, edit, save, unsaved-change protection, revision sync, export.',
    owner: 'task 6',
    component: ChaptersScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    description: 'Outline, characters, facts, world: read-only projections.',
    owner: 'task 6',
    component: ArtifactsScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'cocreate',
    label: 'Co-create',
    description: 'Conversation, staged stream, review/edit, resume, cancel.',
    owner: 'task 7',
    component: CoCreateScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'import',
    label: 'Import',
    description: 'Source selection, start/resume/cancel, progress, results.',
    owner: 'task 7',
    component: ImportScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'simulation',
    label: 'Simulation',
    description: 'Source selection, start/resume/cancel, profile display, profile import.',
    owner: 'task 7',
    component: SimulationScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'diagnostics',
    label: 'Diagnostics',
    description: 'Findings, runtime errors, sessions, checkpoints, event queue, sanitized export.',
    owner: 'task 8',
    component: DiagnosticsScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Providers, models, thinking, languages, budgets, notifications, updates.',
    owner: 'task 8',
    component: SettingsScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'export',
    label: 'Export',
    description: 'Chapter selection, formats, output destination, results.',
    owner: 'task 6',
    component: ExportScreen as Component<{ title: string; description: string; owner: string }>,
  },
] as const;

export const currentRoute = writable<RouteId>('overview');

// ---------------------------------------------------------------------------
// Navigation guards (unsaved-change protection)
// ---------------------------------------------------------------------------

/**
 * A guard inspects a navigation target. Returning true allows it; returning
 * false blocks it (the guard is responsible for surfacing the reason and,
 * after the user decides, completing the navigation via
 * `proceedBlockedNavigation`).
 */
export type NavigationGuard = (target: RouteId) => boolean;

let navigationGuard: NavigationGuard | null = null;

/** A navigation that a guard blocked, awaiting an explicit user decision. */
export interface BlockedNavigation {
  target: RouteId;
  at: number;
}

export const blockedNavigation: Writable<BlockedNavigation | null> = writable(null);

export function setNavigationGuard(guard: NavigationGuard | null): void {
  navigationGuard = guard;
}

export function navigate(id: RouteId): void {
  if (navigationGuard && get(currentRoute) !== id) {
    const allowed = navigationGuard(id);
    if (!allowed) {
      blockedNavigation.set({ target: id, at: Date.now() });
      return;
    }
  }
  blockedNavigation.set(null);
  currentRoute.set(id);
}

/** Complete a previously blocked navigation (the user resolved the guard). */
export function proceedBlockedNavigation(): void {
  const blocked = get(blockedNavigation);
  blockedNavigation.set(null);
  if (blocked) currentRoute.set(blocked.target);
}

/** Keep the current route (the guard stays armed; state unchanged). */
export function cancelBlockedNavigation(): void {
  blockedNavigation.set(null);
}

export function routeById(id: RouteId): RouteDefinition {
  const route = ROUTES.find((r) => r.id === id);
  if (!route) throw new Error(`unknown route: ${id}`);
  return route;
}
