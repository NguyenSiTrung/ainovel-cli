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
import { tick } from 'svelte';
import ProviderEditorModal from '$lib/components/ProviderEditorModal.svelte';
import { tauri } from '$tests/tauri-mock';

describe('ProviderEditorModal component', () => {
  beforeEach(() => {
    tauri.reset();
    cleanup();
  });

  it('does not render dialog when open is false', () => {
    render(ProviderEditorModal, { props: { open: false } });
    expect(screen.queryByTestId('provider-editor-modal')).toBeNull();
  });

  it('renders in create mode with empty fields and allows adding models', async () => {
    render(ProviderEditorModal, { props: { open: true, provider: null } });
    expect(screen.getByTestId('provider-editor-modal')).toBeTruthy();
    expect(screen.getByTestId('provider-modal-title').textContent).toContain('Add provider');

    const nameInput = screen.getByTestId('provider-name-input') as HTMLInputElement;
    expect(nameInput.disabled).toBe(false);
    await fireEvent.input(nameInput, { target: { value: 'my-custom' } });
    expect(nameInput.value).toBe('my-custom');

    const addModelBtn = screen.getByTestId('model-add-button');
    await fireEvent.click(addModelBtn);
    const modelInputs = screen.getAllByTestId('model-name-input');
    expect(modelInputs.length).toBeGreaterThanOrEqual(2);
  });

  it('renders in edit mode with provider data pre-populated and name locked', () => {
    const existing = {
      name: 'deepseek',
      type: 'openai',
      api: 'chat',
      base_url: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      has_api_key: true,
      api_key_hint: 'sk-…4f2a',
      requires_api_key: true,
    };
    render(ProviderEditorModal, { props: { open: true, provider: existing } });
    expect(screen.getByTestId('provider-modal-title').textContent).toContain('Edit provider');
    const nameInput = screen.getByTestId('provider-name-input') as HTMLInputElement;
    expect(nameInput.value).toBe('deepseek');
    expect(nameInput.disabled).toBe(true);

    const baseUrlInput = screen.getByTestId('provider-baseurl-input') as HTMLInputElement;
    expect(baseUrlInput.value).toBe('https://api.deepseek.com/v1');
  });

  it('triggers connection test and shows success response', async () => {
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'config.test_provider') {
        return { success: true, latency_ms: 180 };
      }
      return {};
    });

    render(ProviderEditorModal, { props: { open: true, provider: null } });
    await fireEvent.input(screen.getByTestId('provider-name-input'), { target: { value: 'proxy' } });
    await fireEvent.input(screen.getByTestId('provider-baseurl-input'), { target: { value: 'http://localhost:8000/v1' } });
    await fireEvent.input(screen.getAllByTestId('model-name-input')[0]!, { target: { value: 'model-a' } });

    const testBtn = screen.getByTestId('provider-test-button');
    await fireEvent.click(testBtn);
    await tick();

    await vi.waitFor(() => {
      expect(screen.getByTestId('provider-test-status').textContent).toContain('Connected (180ms)');
    });
  });

  it('saves provider and invokes onsaved callback', async () => {
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'config.save_provider') {
        return { saved: true, provider: { name: 'saved-proxy', type: 'openai', models: ['m1'] } };
      }
      if (method === 'config.get') {
        return { provider: 'saved-proxy', model: 'm1', providers: [] };
      }
      return {};
    });

    let savedName = '';
    render(ProviderEditorModal, {
      props: {
        open: true,
        provider: null,
        onsaved: (name: string) => { savedName = name; },
      },
    });

    await fireEvent.input(screen.getByTestId('provider-name-input'), { target: { value: 'saved-proxy' } });
    await fireEvent.input(screen.getAllByTestId('model-name-input')[0]!, { target: { value: 'm1' } });

    const saveBtn = screen.getByTestId('provider-save-button');
    await fireEvent.click(saveBtn);
    await tick();

    await vi.waitFor(() => {
      expect(savedName).toBe('saved-proxy');
    });
  });

  it('handles remote model fetching, filtering, and bulk selection into models table', async () => {
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'config.fetch_provider_models') {
        return { models: ['gpt-4o', 'gpt-4o-mini', 'o1-preview', 'text-embedding-3'] };
      }
      return {};
    });

    render(ProviderEditorModal, { props: { open: true, provider: null } });

    const fetchBtn = screen.getByTestId('model-fetch-button') as HTMLButtonElement;
    expect(fetchBtn.disabled).toBe(true);

    // Enter base URL
    const baseUrlInput = screen.getByTestId('provider-baseurl-input');
    await fireEvent.input(baseUrlInput, { target: { value: 'http://localhost:11434/v1' } });
    expect(fetchBtn.disabled).toBe(false);

    // Click fetch models
    await fireEvent.click(fetchBtn);

    // Picker modal should appear
    await vi.waitFor(() => {
      expect(screen.getByTestId('model-picker-modal')).toBeTruthy();
    });

    // Search filter
    const searchInput = screen.getByTestId('model-picker-search');
    await fireEvent.input(searchInput, { target: { value: 'gpt-4o' } });

    expect(screen.getByTestId('model-picker-item-gpt-4o')).toBeTruthy();
    expect(screen.getByTestId('model-picker-item-gpt-4o-mini')).toBeTruthy();
    expect(screen.queryByTestId('model-picker-item-o1-preview')).toBeNull();

    // Clear search
    await fireEvent.input(searchInput, { target: { value: '' } });
    expect(screen.getByTestId('model-picker-item-o1-preview')).toBeTruthy();

    // Confirm add
    const confirmBtn = screen.getByTestId('model-picker-confirm');
    await fireEvent.click(confirmBtn);

    // Picker closes, models table populated
    await vi.waitFor(() => {
      expect(screen.queryByTestId('model-picker-modal')).toBeNull();
    });

    const modelInputs = screen.getAllByTestId('model-name-input') as HTMLInputElement[];
    const modelValues = modelInputs.map((input) => input.value);
    expect(modelValues).toContain('gpt-4o');
    expect(modelValues).toContain('gpt-4o-mini');
    expect(modelValues).toContain('o1-preview');
    expect(modelValues).toContain('text-embedding-3');
  });

  it('surfaces fetch error when endpoint is unreachable', async () => {
    tauri.on('desktop_request', (_cmd, args) => {
      const method = (args as { method?: string })?.method;
      if (method === 'config.fetch_provider_models') {
        throw { code: 'operation_failed', message: 'connection refused' };
      }
      return {};
    });

    render(ProviderEditorModal, { props: { open: true, provider: null } });
    await fireEvent.input(screen.getByTestId('provider-baseurl-input'), {
      target: { value: 'http://bad-host:9999/v1' },
    });
    await fireEvent.click(screen.getByTestId('model-fetch-button'));

    await vi.waitFor(() => {
      expect(screen.getByTestId('model-fetch-error').textContent).toContain('Failed to fetch models');
    });
  });

  it('renders preset selector in create mode and populates preset defaults', async () => {
    render(ProviderEditorModal, { props: { open: true, provider: null } });
    const presetSelect = screen.getByTestId('provider-preset-select') as HTMLSelectElement;
    expect(presetSelect).toBeTruthy();
    expect(presetSelect.value).toBe('custom');

    // Select deepseek preset
    await fireEvent.change(presetSelect, { target: { value: 'deepseek' } });

    const nameInput = screen.getByTestId('provider-name-input') as HTMLInputElement;
    expect(nameInput.value).toBe('deepseek');

    const baseUrlInput = screen.getByTestId('provider-baseurl-input') as HTMLInputElement;
    expect(baseUrlInput.value).toBe('https://api.deepseek.com/v1');

    const modelInputs = screen.getAllByTestId('model-name-input') as HTMLInputElement[];
    const modelNames = modelInputs.map((m) => m.value);
    expect(modelNames).toContain('deepseek-chat');
  });

  it('marks api key as optional for local providers like ollama', async () => {
    render(ProviderEditorModal, { props: { open: true, provider: null } });
    const presetSelect = screen.getByTestId('provider-preset-select') as HTMLSelectElement;

    await fireEvent.change(presetSelect, { target: { value: 'ollama' } });

    const nameInput = screen.getByTestId('provider-name-input') as HTMLInputElement;
    expect(nameInput.value).toBe('ollama');

    const baseUrlInput = screen.getByTestId('provider-baseurl-input') as HTMLInputElement;
    expect(baseUrlInput.value).toBe('http://localhost:11434/v1');

    const apiKeyInput = screen.getByTestId('provider-apikey-input') as HTMLInputElement;
    expect(apiKeyInput.placeholder.toLowerCase()).toContain('optional');
  });

  it('does not display preset selector in edit mode', () => {
    const existing = {
      name: 'my-ollama',
      type: 'openai',
      models: ['llama3.1'],
    };
    render(ProviderEditorModal, { props: { open: true, provider: existing } });
    expect(screen.queryByTestId('provider-preset-select')).toBeNull();
  });
});
