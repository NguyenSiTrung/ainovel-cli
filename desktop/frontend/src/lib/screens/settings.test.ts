/**
 * Settings screen tests: redacted configuration rendering, provider/model
 * selection flow (config.models on provider change → one explicit
 * config.switch_model on Apply), thinking level and language applies, budget
 * as read-only, local notification-preference toggles, and the binding
 * secret-absence guarantee — plaintext key material from the fixture is
 * never rendered anywhere on the screen.
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
import { get } from 'svelte/store';

import SettingsScreen from '$lib/screens/SettingsScreen.svelte';
import { resetSettingsState } from '$lib/settings';
import {
  connectionState,
  disposeDesktop,
  notificationPrefs,
  projectSnapshot,
} from '$lib/stores/desktop';
import { installBridgeMarker, tauri } from '$tests/tauri-mock';

const SNAPSHOT = { state: 'idle', book_title: 'The Lantern Sea', total_chapters: 12 };

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
  // Rogue fields a compliant engine never sends; if they ever leak into an
  // open payload, the screen still must not render them.
  api_key: 'sk-SUPERSECRET-plaintext',
  secret: 'hunter2',
  token: 'tok-DO-NOT-RENDER-42',
};

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

function payloadOf(method: string): Record<string, unknown> | undefined {
  const call = tauri
    .callsOf('desktop_request')
    .find((c) => (c.args as { method?: string })?.method === method);
  return (call?.args as { payload?: Record<string, unknown> })?.payload;
}

function callsOf(method: string): number {
  return tauri
    .callsOf('desktop_request')
    .filter((c) => (c.args as { method?: string })?.method === method).length;
}

function renderSettings(): void {
  render(SettingsScreen, { props: { title: 'Settings', description: 'Settings description', owner: 'task 8' } });
}

beforeEach(async () => {
  tauri.reset();
  resetSettingsState();
  await disposeDesktop();
  cleanup();
  installBridgeMarker();
  connectionState.set('ready');
  projectSnapshot.set({ ...SNAPSHOT });
});

describe('settings screen', () => {
  it('no project open: empty state, no requests', () => {
    projectSnapshot.set(null);
    renderSettings();
    expect(screen.getByTestId('settings-empty')).toBeTruthy();
    expect(tauri.callsOf('desktop_request')).toHaveLength(0);
  });

  it('renders the redacted view: active pair, thinking, languages, masked hint', async () => {
    scriptEngine();
    renderSettings();
    await vi.waitFor(() => expect(screen.getByTestId('settings-model').textContent).toContain('openai / gpt-4o-mini'));
    expect(screen.getByTestId('settings-thinking').textContent).toContain('medium');
    expect(screen.getByTestId('settings-key-hint').textContent).toBe('sk-…ab12');
    expect(screen.getByTestId('settings-provider-credentials').textContent).toContain('yes');
    expect(screen.getByTestId('settings-budget').textContent).toBe('$25.00');
  });

  it('surfaces the active AI configuration before its controls', async () => {
    scriptEngine();
    renderSettings();

    await vi.waitFor(() => {
      expect(screen.getByTestId('settings-active-summary').textContent).toContain('openai');
    });
    expect(screen.getByTestId('settings-active-summary').textContent).toContain('gpt-4o-mini');
    expect(screen.getByTestId('settings-active-summary').textContent).toContain('medium');
  });

  it('secrets never render: rogue plaintext fields from the fixture are absent', async () => {
    scriptEngine();
    renderSettings();
    await vi.waitFor(() => expect(screen.getByTestId('settings-model')).toBeTruthy());
    const text = document.body.textContent ?? '';
    expect(text).not.toContain('sk-SUPERSECRET-plaintext');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('tok-DO-NOT-RENDER-42');
  });

  it('provider change loads its models; Apply sends exactly one switch_model', async () => {
    scriptEngine();
    renderSettings();
    await vi.waitFor(() => expect(screen.getByTestId('settings-provider-select')).toBeTruthy());
    await vi.waitFor(() =>
      expect((screen.getByTestId('settings-provider-select') as HTMLSelectElement).value).toBe('openai'),
    );

    await fireEvent.change(screen.getByTestId('settings-provider-select'), { target: { value: 'ollama' } });
    await vi.waitFor(() => expect(callsOf('config.models')).toBe(1));
    expect(payloadOf('config.models')).toEqual({ provider: 'ollama' });

    await fireEvent.change(screen.getByTestId('settings-model-select'), { target: { value: 'gpt-4o-mini' } });
    await fireEvent.click(screen.getByTestId('settings-model-apply'));
    await vi.waitFor(() => expect(callsOf('config.switch_model')).toBe(1));
    expect(payloadOf('config.switch_model')).toEqual({ provider: 'ollama', model: 'gpt-4o-mini' });
    // Confirmation surfaced from the engine echo.
    await vi.waitFor(() => expect(screen.getByTestId('settings-applied').textContent).toContain('ollama / gpt-4o-mini'));
  });

  it('switch_model failures surface the structured error and keep the view', async () => {
    scriptEngine({
      'config.switch_model': () => {
        throw { code: 'invalid_payload', message: 'unknown model' };
      },
    });
    renderSettings();
    await vi.waitFor(() =>
      expect((screen.getByTestId('settings-provider-select') as HTMLSelectElement).value).toBe('openai'),
    );
    await fireEvent.click(screen.getByTestId('settings-model-apply'));
    await vi.waitFor(() => expect(callsOf('config.switch_model')).toBe(1));
    expect(screen.queryByTestId('settings-applied')).toBeNull();
    // The engine-reported active pair is still what the screen shows.
    expect(screen.getByTestId('settings-model').textContent).toContain('openai / gpt-4o-mini');
  });

  it('thinking apply sends the chosen level', async () => {
    scriptEngine();
    renderSettings();
    await vi.waitFor(() =>
      expect((screen.getByTestId('settings-thinking-select') as HTMLSelectElement).value).toBe('medium'),
    );
    await fireEvent.change(screen.getByTestId('settings-thinking-select'), { target: { value: 'high' } });
    await fireEvent.click(screen.getByTestId('settings-thinking-apply'));
    await vi.waitFor(() => expect(payloadOf('config.set_thinking')).toEqual({ level: 'high' }));
    await vi.waitFor(() => expect(screen.getByTestId('settings-applied').textContent).toContain('high'));
  });

  it('language and story language apply as separate explicit requests', async () => {
    scriptEngine();
    renderSettings();
    await vi.waitFor(() =>
      expect((screen.getByTestId('settings-language-select') as HTMLSelectElement).value).toBe('en'),
    );
    await fireEvent.change(screen.getByTestId('settings-language-select'), { target: { value: 'vi' } });
    await fireEvent.click(screen.getByTestId('settings-language-apply'));
    await vi.waitFor(() => expect(payloadOf('config.set_language')).toEqual({ language: 'vi' }));

    await fireEvent.change(screen.getByTestId('settings-story-language-select'), { target: { value: 'zh' } });
    await fireEvent.click(screen.getByTestId('settings-story-language-apply'));
    await vi.waitFor(() => expect(payloadOf('config.set_story_language')).toEqual({ language: 'zh' }));
  });

  it('budget is read-only: value shown, no apply control for it', async () => {
    scriptEngine();
    renderSettings();
    await vi.waitFor(() => expect(screen.getByTestId('settings-budget').textContent).toBe('$25.00'));
    expect(screen.getByTestId('settings-readonly').textContent).toContain('no public engine setters');
    expect(screen.getByTestId('settings-update-channel').textContent).toContain('outside this app');
  });

  it('notification preference toggles update the local prefs', async () => {
    scriptEngine();
    renderSettings();
    await vi.waitFor(() => expect(screen.getByTestId('settings-pref-failure')).toBeTruthy());
    expect(get(notificationPrefs).failure).toBe(true);
    await fireEvent.click(screen.getByTestId('settings-pref-failure'));
    expect(get(notificationPrefs).failure).toBe(false);
    await fireEvent.click(screen.getByTestId('settings-pref-completion'));
    expect(get(notificationPrefs).completion).toBe(false);
    await fireEvent.click(screen.getByTestId('settings-pref-failure'));
    expect(get(notificationPrefs).failure).toBe(true);
  });

  it('shows Add Provider and Edit buttons and opens ProviderEditorModal', async () => {
    scriptEngine();
    renderSettings();
    await vi.waitFor(() => expect(screen.getByTestId('settings-provider-add')).toBeTruthy());

    const addBtn = screen.getByTestId('settings-provider-add');
    await fireEvent.click(addBtn);
    expect(screen.getByTestId('provider-editor-modal')).toBeTruthy();
    expect(screen.getByTestId('provider-modal-title').textContent).toContain('Add provider');
  });

  it('disables Delete button when active default provider is selected, enables for non-active', async () => {
    scriptEngine({
      'config.delete_provider': () => ({ deleted: true, provider: 'ollama' }),
    });
    renderSettings();
    await vi.waitFor(() =>
      expect((screen.getByTestId('settings-provider-select') as HTMLSelectElement).value).toBe('openai'),
    );

    const delBtn = screen.getByTestId('settings-provider-delete') as HTMLButtonElement;
    expect(delBtn.disabled).toBe(true);

    // Change to 'ollama'
    await fireEvent.change(screen.getByTestId('settings-provider-select'), { target: { value: 'ollama' } });
    await vi.waitFor(() => expect(delBtn.disabled).toBe(false));

    await fireEvent.click(delBtn);
    await vi.waitFor(() => expect(callsOf('config.delete_provider')).toBe(1));
  });

  it('displays empty provider notice when no providers are configured on first run', async () => {
    scriptEngine({
      'config.get': () => ({
        provider: '',
        model: '',
        reasoning_effort: '',
        language: 'en',
        story_language: 'en',
        style: 'default',
        budget_usd: 0,
        config_path: '/home/user/.ainovel/config.json',
        providers: [],
      }),
    });
    renderSettings();
    await vi.waitFor(() => {
      expect(screen.getByTestId('settings-no-providers')).toBeTruthy();
    });
    expect(screen.getByTestId('settings-no-providers').textContent).toContain('No providers configured');
  });
});
