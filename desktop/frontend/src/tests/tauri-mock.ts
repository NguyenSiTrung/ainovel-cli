/**
 * Shared fake Tauri bridge for unit tests. Test files install it with:
 *
 *   vi.mock('@tauri-apps/api/core', async () => {
 *     const { tauri } = await import('$tests/tauri-mock');
 *     return { invoke: (cmd, args) => tauri.invoke(cmd, args) };
 *   });
 *   vi.mock('@tauri-apps/api/event', async () => {
 *     const { tauri } = await import('$tests/tauri-mock');
 *     return { listen: (name, handler) => tauri.listen(name, handler) };
 *   });
 *
 * No real backend is involved; commands and events are scripted per test.
 */

import type { ForwardedEvent, JsonObject } from '$lib/types/protocol';

export interface InvokeCall {
  cmd: string;
  args?: Record<string, unknown>;
}

export type InvokeHandler = (cmd: string, args: Record<string, unknown>) => unknown;

class TauriBridgeMock {
  readonly calls: InvokeCall[] = [];
  readonly handlers = new Map<string, InvokeHandler>();
  readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  defaultHandler: InvokeHandler = (cmd) => {
    throw new Error(`unexpected tauri command in test: ${cmd}`);
  };

  /** Script a command response (value or thrown error). */
  on(cmd: string, handler: InvokeHandler): this {
    this.handlers.set(cmd, handler);
    return this;
  }

  /** Convenience: succeed with a JSON value. */
  reply(cmd: string, value: unknown): this {
    return this.on(cmd, () => value);
  }

  /** Convenience: reject with a structured error object. */
  fail(cmd: string, error: { code: string; message: string; details?: unknown }): this {
    return this.on(cmd, () => {
      throw error;
    });
  }

  async invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ cmd, args });
    const handler = this.handlers.get(cmd) ?? this.defaultHandler;
    return handler(cmd, args ?? {});
  }

  async listen(name: string, handler: (event: { event: string; payload: unknown }) => void): Promise<() => void> {
    const set = this.listeners.get(name) ?? new Set();
    const wrapped = (payload: unknown) => handler({ event: name, payload });
    set.add(wrapped);
    this.listeners.set(name, set);
    return () => {
      set.delete(wrapped);
    };
  }

  /** Emit a Tauri event to all current subscribers (test driver). */
  emit(name: string, payload: unknown): void {
    for (const handler of this.listeners.get(name) ?? []) {
      handler(payload);
    }
  }

  callsOf(cmd: string): InvokeCall[] {
    return this.calls.filter((call) => call.cmd === cmd);
  }

  reset(): void {
    this.calls.length = 0;
    this.handlers.clear();
    this.listeners.clear();
  }
}

/** Singleton shared by the vi.mock factories in each test file. */
export const tauri = new TauriBridgeMock();

/** Install the `window.__TAURI_INTERNALS__` marker hasTauriBridge() looks for. */
export function installBridgeMarker(): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

export function removeBridgeMarker(): void {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
}

/** Build a forwarded engine event payload (`desktop://event` shape). */
export function engineEvent(
  event: string,
  sequence: number,
  payload: Record<string, unknown> = {},
  session?: string,
): ForwardedEvent {
  return { event, sequence, session, payload: payload as JsonObject };
}
