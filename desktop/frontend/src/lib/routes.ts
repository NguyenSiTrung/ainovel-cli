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

import { t } from '$lib/locale';

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
    label: t('route.overview.label'),
    description: t('route.overview.description'),
    owner: 'task 5',
    component: OverviewScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'write',
    label: t('route.write.label'),
    description: t('route.write.description'),
    owner: 'task 5',
    component: WriteScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'chapters',
    label: t('route.chapters.label'),
    description: t('route.chapters.description'),
    owner: 'task 6',
    component: ChaptersScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'artifacts',
    label: t('route.artifacts.label'),
    description: t('route.artifacts.description'),
    owner: 'task 6',
    component: ArtifactsScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'cocreate',
    label: t('route.cocreate.label'),
    description: t('route.cocreate.description'),
    owner: 'task 7',
    component: CoCreateScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'import',
    label: t('route.import.label'),
    description: t('route.import.description'),
    owner: 'task 7',
    component: ImportScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'simulation',
    label: t('route.simulation.label'),
    description: t('route.simulation.description'),
    owner: 'task 7',
    component: SimulationScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'diagnostics',
    label: t('route.diagnostics.label'),
    description: t('route.diagnostics.description'),
    owner: 'task 8',
    component: DiagnosticsScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'settings',
    label: t('route.settings.label'),
    description: t('route.settings.description'),
    owner: 'task 8',
    component: SettingsScreen as Component<{ title: string; description: string; owner: string }>,
  },
  {
    id: 'export',
    label: t('route.export.label'),
    description: t('route.export.description'),
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

/**
 * Locale-live chrome strings for a route. Kept separate from `component`
 * on purpose: cloning a route record (spread / Object.create) breaks the
 * Svelte class-component identity, so callers resolve strings via this and
 * keep `component` from the static ROUTES registry.
 */
export function routeStrings(id: RouteId): { label: string; description: string } {
  return { label: t(`route.${id}.label`), description: t(`route.${id}.description`) };
}

export function routeById(id: RouteId): RouteDefinition {
  const route = ROUTES.find((r) => r.id === id);
  if (!route) throw new Error(`unknown route: ${id}`);
  return route;
}
