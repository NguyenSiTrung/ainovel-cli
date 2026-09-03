/**
 * Scriptable fake for `@tauri-apps/plugin-dialog`. Install with:
 *
 *   vi.mock('@tauri-apps/plugin-dialog', async () => {
 *     const { dialogMock } = await import('$tests/dialog-mock');
 *     return {
 *       open: (options: unknown) => dialogMock.open(options),
 *       save: (options: unknown) => dialogMock.save(options),
 *     };
 *   });
 *
 * Tests script `openImpl` / `saveImpl`; unscripted pickers resolve null
 * (user cancelled), which is never an error.
 */

export interface DialogOptions {
  directory?: boolean;
  multiple?: boolean;
  title?: string;
  defaultPath?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

class DialogMock {
  openImpl: ((options: DialogOptions) => Promise<string | string[] | null>) | null = null;
  saveImpl: ((options: DialogOptions) => Promise<string | null>) | null = null;
  readonly openCalls: DialogOptions[] = [];
  readonly saveCalls: DialogOptions[] = [];

  async open(options: DialogOptions): Promise<string | string[] | null> {
    this.openCalls.push(options);
    return this.openImpl ? this.openImpl(options) : Promise.resolve(null);
  }

  async save(options: DialogOptions): Promise<string | null> {
    this.saveCalls.push(options);
    return this.saveImpl ? this.saveImpl(options) : Promise.resolve(null);
  }

  reset(): void {
    this.openImpl = null;
    this.saveImpl = null;
    this.openCalls.length = 0;
    this.saveCalls.length = 0;
  }
}

export const dialogMock = new DialogMock();
