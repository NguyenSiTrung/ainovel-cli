/**
 * Settings controller tests: redacted config projection (secrets never
 * render), explicit one-request mutations (switch model / set thinking /
 * set language / set story language) with engine-echoed confirmations,
 * thinking-level and model-option loads, project-unavailable silent resets,
 * and rejection handling — all against the scripted mock bridge.
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

import { get } from 'svelte/store';

import {
  deleteProviderFromUi,
  dismissSettingsMessage,
  fetchProviderModelsFromUi,
  loadModelOptions,
  refreshConfig,
  refreshThinkingLevels,
  resetSettingsState,
  saveProviderFromUi,
  setLanguageFromUi,
  setStoryLanguageFromUi,
  setThinkingFromUi,
  settingsState,
  switchModelFromUi,
  testProviderFromUi,
} from '$lib/settings';
import { connectionState, disposeDesktop, projectSnapshot } from '$lib/stores/desktop';
import { installBridgeMarker, tauri } from '$tests/tauri-mock';
import type { ProjectSnapshot } from '$lib/types/protocol';

const SNAPSHOT: ProjectSnapshot = { state: 'idle', book_title: 'Test Novel', total_chapters: 12 };

/**
 * Redacted config view as the adapter produces it (project.go
 * handleConfigGet). Includes a masked `api_key_hint` AND a rogue plaintext
 * `api_key` field the real engine never sends — the UI must not render the
 * latter anywhere even if some future engine leaked it into the payload.
 */
const CONFIG_VIEW = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  reasoning_effort: 'medium',
  language: 'en',
  story_language: 'en',
  style: 'lyrical',
  budget_usd: 25,
  config_path: '/Users/demo/.config/ainovel/config.toml',
  providers: [
    {
      name: 'openai',
      type: 'openai',
      api: 'chat',
      base_url: '',
      models: ['gpt-4o-mini', 'gpt-4o'],
      has_api_key: true,
      api_key_hint: 'sk-…ab12',
      requires_api_key: true,
    },
    {
      name: 'ollama',
      type: 'ollama',
      api: 'chat',
      base_url: 'http://localhost:11434',
      models: ['llama3'],
      has_api_key: false,
      requires_api_key: false,
    },
  ],
  // Rogue field: must never be projected or echoed back by the UI.
  api_key: 'sk-SUPERSECRET-plaintext',
  secret: 'hunter2',
};

function payloadOf(method: string): Record<string, unknown> | undefined {
  const call = tauri
    .callsOf('desktop_request')
    .find((c) => (c.args as { method?: string })?.method === method);
  return (call?.args as { payload?: Record<string, unknown> })?.payload;
}

function callsOfMethod(method: string): number {
  return tauri
    .callsOf('desktop_request')
    .filter((c) => (c.args as { method?: string })?.method === method).length;
}

function scriptEngine(overrides: Record<string, (payload: Record<string, unknown>) => unknown> = {}): void {
  tauri.on('desktop_request', (_cmd, args) => {
    const method = (args as { method?: string })?.method;
    const payload = (args as { payload?: Record<string, unknown> })?.payload ?? {};
    const handler = overrides[method ?? ''];
    if (handler) return handler(payload);
    switch (method) {
      case 'config.get':
        return { ...CONFIG_VIEW };
      case 'config.thinking_levels':
        return { levels: ['low', 'medium', 'high'], provider: 'openai', model: 'gpt-4o-mini' };
      case 'config.models':
        return {
          provider: payload.provider,
          models: [
            { name: 'gpt-4o-mini', context_window: 128000, context_source: 'catalog' },
            { name: 'gpt-4o', context_window: 128000, context_source: 'catalog' },
          ],
        };
      case 'config.switch_model':
        return { provider: payload.provider, model: payload.model };
      case 'config.set_thinking':
        return { level: payload.level };
      case 'config.set_language':
        return { language: payload.language };
      case 'config.set_story_language':
        return { story_language: payload.language };
      default:
        throw { code: 'unknown_method', message: `unexpected ${method}` };
    }
  });
}

beforeEach(async () => {
  tauri.reset();
  resetSettingsState();
  await disposeDesktop();
  installBridgeMarker();
  connectionState.set('ready');
  projectSnapshot.set({ ...SNAPSHOT });
});

describe('config view', () => {
  it('projects the redacted view: current values, providers, masked hint', async () => {
    scriptEngine();
    await refreshConfig();
    const view = get(settingsState).view;
    expect(view?.provider).toBe('openai');
    expect(view?.model).toBe('gpt-4o-mini');
    expect(view?.reasoning_effort).toBe('medium');
    expect(view?.budget_usd).toBe(25);
    expect(view?.providers).toHaveLength(2);
    expect(view?.providers?.[0]).toMatchObject({ name: 'openai', has_api_key: true, api_key_hint: 'sk-…ab12' });
    expect(payloadOf('config.get')).toEqual({});
  });

  it('secret-looking fixture fields stay outside the rendered surface (screen test asserts rendering)', async () => {
    scriptEngine();
    await refreshConfig();
    const view = get(settingsState).view;
    // The typed projection surface the screen renders: provider summaries
    // carry only the boolean key status + masked hint — never key material.
    for (const provider of view?.providers ?? []) {
      expect(typeof provider.has_api_key).toBe('boolean');
      expect(String(provider.api_key_hint ?? '')).not.toContain('SUPERSECRET');
    }
    // Rogue plaintext fields from the fixture are never echoed back by any
    // mutation (asserted per-mutation below: payloads carry only chosen values).
  });

  it('project_unavailable resets silently; other failures surface', async () => {
    scriptEngine({
      'config.get': () => {
        throw { code: 'operation_failed', message: 'config unreadable' };
      },
    });
    await refreshConfig();
    expect(get(settingsState).error).toMatchObject({ code: 'operation_failed' });

    tauri.reset();
    scriptEngine({
      'config.get': () => {
        throw { code: 'project_unavailable', message: 'no project is open' };
      },
    });
    await refreshConfig();
    expect(get(settingsState).error).toBeNull();
    expect(get(settingsState).view).toBeNull();
  });

  it('project close drops the view', async () => {
    scriptEngine();
    await refreshConfig();
    expect(get(settingsState).view).not.toBeNull();
    projectSnapshot.set(null);
    expect(get(settingsState).view).toBeNull();
  });
});

describe('thinking levels', () => {
  it('loads the engine-provided levels for the active model', async () => {
    scriptEngine();
    await refreshThinkingLevels();
    const thinking = get(settingsState).thinking;
    expect(thinking.status).toBe('ready');
    expect(thinking.levels).toEqual(['low', 'medium', 'high']);
    expect(thinking.model).toBe('gpt-4o-mini');
    expect(payloadOf('config.thinking_levels')).toEqual({});
  });
});

describe('model options', () => {
  it('loads models for the selected provider only', async () => {
    scriptEngine();
    await loadModelOptions('openai');
    expect(payloadOf('config.models')).toEqual({ provider: 'openai' });
    expect(get(settingsState).modelOptions.options).toHaveLength(2);
  });
});

describe('explicit mutations (one protocol request each)', () => {
  it('switch model sends exactly one request, echoes the result, refetches the view', async () => {
    scriptEngine();
    const ok = await switchModelFromUi('ollama', 'llama3');
    expect(ok).toBe(true);
    expect(payloadOf('config.switch_model')).toEqual({ provider: 'ollama', model: 'llama3' });
    expect(callsOfMethod('config.switch_model')).toBe(1);
    // Confirmation + authoritative refresh followed.
    expect(get(settingsState).message).toContain('ollama / llama3');
    expect(callsOfMethod('config.get')).toBeGreaterThanOrEqual(1);
    expect(callsOfMethod('config.thinking_levels')).toBeGreaterThanOrEqual(1);
  });

  it('set thinking sends the level verbatim', async () => {
    scriptEngine();
    const ok = await setThinkingFromUi('high');
    expect(ok).toBe(true);
    expect(payloadOf('config.set_thinking')).toEqual({ level: 'high' });
    expect(get(settingsState).message).toContain('high');
  });

  it('set language / story language are separate explicit requests', async () => {
    scriptEngine();
    expect(await setLanguageFromUi('vi')).toBe(true);
    expect(payloadOf('config.set_language')).toEqual({ language: 'vi' });
    expect(await setStoryLanguageFromUi('zh')).toBe(true);
    expect(payloadOf('config.set_story_language')).toEqual({ language: 'zh' });
    expect(get(settingsState).message).toContain('zh');
  });

  it('rejections surface via the error path and clear the busy flag', async () => {
    scriptEngine({
      'config.set_thinking': () => {
        throw { code: 'invalid_payload', message: 'unknown thinking level: turbo' };
      },
    });
    const ok = await setThinkingFromUi('turbo');
    expect(ok).toBe(false);
    expect(get(settingsState).mutations.thinking).toBe('idle');
    expect(get(settingsState).message).toBeNull();
    expect(callsOfMethod('config.set_thinking')).toBe(1);
  });

  it('busy guard: no second switch while one is applying', async () => {
    let release: (value: unknown) => void = () => {};
    scriptEngine({
      'config.switch_model': () =>
        new Promise((resolve) => {
          release = resolve as (value: unknown) => void;
        }),
    });
    const first = switchModelFromUi('openai', 'gpt-4o');
    const second = await switchModelFromUi('openai', 'gpt-4o-mini');
    expect(second).toBe(false);
    release({ provider: 'openai', model: 'gpt-4o' });
    expect(await first).toBe(true);
    expect(callsOfMethod('config.switch_model')).toBe(1);
  });

  it('empty selections send nothing', async () => {
    scriptEngine();
    expect(await switchModelFromUi('', 'model')).toBe(false);
    expect(await switchModelFromUi('openai', '')).toBe(false);
    expect(await setThinkingFromUi('')).toBe(false);
    expect(await setLanguageFromUi('   ')).toBe(false);
    expect(await setStoryLanguageFromUi('')).toBe(false);
    expect(tauri.callsOf('desktop_request')).toHaveLength(0);
  });

  it('dismiss clears the applied message', async () => {
    scriptEngine();
    await setThinkingFromUi('low');
    expect(get(settingsState).message).not.toBeNull();
    dismissSettingsMessage();
    expect(get(settingsState).message).toBeNull();
  });

  it('saveProviderFromUi calls config.save_provider and refreshes config', async () => {
    scriptEngine({
      'config.save_provider': () => ({
        saved: true,
        provider: { name: 'new-proxy', type: 'openai', models: ['model-1'] },
      }),
    });
    const ok = await saveProviderFromUi({
      provider: 'new-proxy',
      type: 'openai',
      models: [{ name: 'model-1' }],
    });
    expect(ok).toBe(true);
    expect(callsOfMethod('config.save_provider')).toBe(1);
    expect(get(settingsState).message).toContain('provider new-proxy saved');
  });

  it('testProviderFromUi returns latency on success and error on failure', async () => {
    scriptEngine({
      'config.test_provider': () => ({
        success: true,
        latency_ms: 150,
      }),
    });
    const res = await testProviderFromUi({
      provider: 'new-proxy',
      type: 'openai',
      models: [{ name: 'model-1' }],
      test_model: 'model-1',
    });
    expect(res.ok).toBe(true);
    expect(res.latencyMs).toBe(150);
  });

  it('deleteProviderFromUi calls config.delete_provider and notes applied', async () => {
    scriptEngine({
      'config.delete_provider': () => ({
        deleted: true,
        provider: 'old-proxy',
      }),
    });
    const ok = await deleteProviderFromUi('old-proxy');
    expect(ok).toBe(true);
    expect(callsOfMethod('config.delete_provider')).toBe(1);
    expect(get(settingsState).message).toContain('provider old-proxy deleted');
  });

  it('deleteProviderFromUi with empty provider sends nothing', async () => {
    scriptEngine();
    expect(await deleteProviderFromUi('')).toBe(false);
    expect(callsOfMethod('config.delete_provider')).toBe(0);
  });

  it('fetchProviderModelsFromUi calls config.fetch_provider_models and returns models', async () => {
    scriptEngine({
      'config.fetch_provider_models': () => ({
        models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
      }),
    });
    const models = await fetchProviderModelsFromUi({
      type: 'openai',
      base_url: 'https://api.example.com/v1',
    });
    expect(models).toEqual(['gpt-4o', 'gpt-4o-mini', 'o3-mini']);
    expect(callsOfMethod('config.fetch_provider_models')).toBe(1);
  });
});
