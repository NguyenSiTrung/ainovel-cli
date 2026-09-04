/**
 * Settings orchestration for the task-8 Settings screen.
 *
 * Contract honored (task-2 adapter mapping + README §6/§8):
 * - `config.get` returns a REDACTED view — provider metadata carries at most
 *   `api_key_hint` (masked) and `has_api_key`; plaintext secrets never leave
 *   the daemon. The UI renders exactly what arrives and never sends secrets
 *   back (README §8: "Never send secrets back").
 * - Mutations are EXPLICIT and one protocol request each:
 *   `config.switch_model {provider, model}`, `config.set_thinking {level}`
 *   (level names come from `config.thinking_levels`), `config.set_language`
 *   and `config.set_story_language {language}`. The engine normalizes
 *   language codes (vi/en/zh) and echoes the applied value back.
 * - The engine exposes NO public setters for budget, style, or provider
 *   libraries: `config.update` applies only language / story_language /
 *   reasoning_effort and reports the rest as `unsupported` — never faked
 *   (task-2 report). The Settings screen therefore shows budget read-only
 *   and does not offer controls the engine would reject.
 * - Notification preferences are a LOCAL UI concern (the engine has no such
 *   setting); they live in stores/desktop.ts next to the toast layer.
 */

import { get, writable, type Writable } from 'svelte/store';

import {
  configDeleteProvider,
  configFetchProviderModels,
  configGet,
  configModels,
  configSaveProvider,
  configSetLanguage,
  configSetStoryLanguage,
  configSetThinking,
  configSwitchModel,
  configTestProvider,
  configThinkingLevels,
  toStructuredError,
  type ConfigGetResult,
  type ModelOption,
  type FetchProviderModelsPayload,
  type SaveProviderPayload,
  type TestProviderPayload,
  type ThinkingLevelsResult,
} from '$lib/api/desktop';
import { setLocale } from '$lib/locale';
import {
  onEngineSessionChange,
  projectSnapshot,
  pushNotification,
  reportError,
} from '$lib/stores/desktop';
import type { StructuredError } from '$lib/types/protocol';

/** Engine-supported UI/story language codes (internal/i18n catalog: vi/en/zh). */
export const LANGUAGE_CHOICES = ['en', 'vi', 'zh'] as const;

export interface ProviderPreset {
  id: string;
  name: string;
  label: string;
  type: string;
  api?: string;
  baseUrl?: string;
  apiKeyOptional?: boolean;
  defaultModels: Array<{ name: string; context_window?: number }>;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'custom',
    name: '',
    label: 'Custom Provider',
    type: 'openai',
    api: 'chat',
    defaultModels: [{ name: '', context_window: 128000 }],
  },
  {
    id: 'openrouter',
    name: 'openrouter',
    label: 'OpenRouter',
    type: 'openai',
    api: 'chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModels: [
      { name: 'anthropic/claude-3.5-sonnet', context_window: 200000 },
      { name: 'google/gemini-2.5-flash', context_window: 1000000 },
    ],
  },
  {
    id: 'anthropic',
    name: 'anthropic',
    label: 'Anthropic',
    type: 'anthropic',
    defaultModels: [
      { name: 'claude-sonnet-4', context_window: 1000000 },
      { name: 'claude-3-5-haiku', context_window: 200000 },
    ],
  },
  {
    id: 'gemini',
    name: 'gemini',
    label: 'Google Gemini',
    type: 'gemini',
    defaultModels: [
      { name: 'gemini-2.5-flash', context_window: 1000000 },
      { name: 'gemini-2.5-pro', context_window: 1000000 },
    ],
  },
  {
    id: 'openai',
    name: 'openai',
    label: 'OpenAI',
    type: 'openai',
    api: 'chat',
    defaultModels: [
      { name: 'gpt-4o', context_window: 128000 },
      { name: 'gpt-4o-mini', context_window: 128000 },
      { name: 'o3-mini', context_window: 200000 },
    ],
  },
  {
    id: 'deepseek',
    name: 'deepseek',
    label: 'DeepSeek',
    type: 'openai',
    api: 'chat',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModels: [
      { name: 'deepseek-chat', context_window: 128000 },
      { name: 'deepseek-reasoner', context_window: 128000 },
    ],
  },
  {
    id: 'qwen',
    name: 'qwen',
    label: 'Qwen (DashScope)',
    type: 'openai',
    api: 'chat',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModels: [
      { name: 'qwen-max', context_window: 32000 },
      { name: 'qwen-plus', context_window: 128000 },
    ],
  },
  {
    id: 'glm',
    name: 'glm',
    label: 'GLM (Zhipu)',
    type: 'openai',
    api: 'chat',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModels: [
      { name: 'glm-4-plus', context_window: 128000 },
      { name: 'glm-4-flash', context_window: 128000 },
    ],
  },
  {
    id: 'grok',
    name: 'grok',
    label: 'Grok (xAI)',
    type: 'openai',
    api: 'chat',
    baseUrl: 'https://api.x.ai/v1',
    defaultModels: [
      { name: 'grok-2', context_window: 128000 },
      { name: 'grok-beta', context_window: 128000 },
    ],
  },
  {
    id: 'ollama',
    name: 'ollama',
    label: 'Ollama',
    type: 'openai',
    api: 'chat',
    baseUrl: 'http://localhost:11434/v1',
    apiKeyOptional: true,
    defaultModels: [
      { name: 'llama3.1', context_window: 128000 },
      { name: 'qwen2.5', context_window: 128000 },
    ],
  },
  {
    id: 'bedrock',
    name: 'bedrock',
    label: 'AWS Bedrock',
    type: 'bedrock',
    apiKeyOptional: true,
    defaultModels: [
      { name: 'anthropic.claude-3-5-sonnet-20241022-v2:0', context_window: 200000 },
    ],
  },
];

/**
 * Adopt the engine-reported UI language as the chrome locale. The engine is
 * the normalizer/echo authority (trim-only sends, echoed codes displayed);
 * unknown or missing codes keep the current locale.
 */
function syncLocaleFromView(view: ConfigGetResult | null): void {
  if (view?.language !== undefined) setLocale(view.language);
}
// ---------------------------------------------------------------------------
// Projection state
// ---------------------------------------------------------------------------

export type MutationStatus = 'idle' | 'applying';

export interface SettingsState {
  status: 'idle' | 'loading' | 'ready';
  view: ConfigGetResult | null;
  error: StructuredError | null;
  fetchedAt: number | null;
  thinking: {
    status: 'idle' | 'loading' | 'ready';
    levels: string[];
    /** Active pair the engine reported the levels for. */
    provider: string | undefined;
    model: string | undefined;
    error: StructuredError | null;
  };
  /** Model options for the provider currently under selection. */
  modelOptions: {
    status: 'idle' | 'loading' | 'ready';
    provider: string | undefined;
    options: ModelOption[];
    error: StructuredError | null;
  };
  mutations: {
    model: MutationStatus;
    thinking: MutationStatus;
    language: MutationStatus;
    storyLanguage: MutationStatus;
    provider: MutationStatus;
  };
  /** Last applied-change confirmation (engine-echoed values). */
  message: string | null;
}

function initialSettingsState(): SettingsState {
  return {
    status: 'idle',
    view: null,
    error: null,
    fetchedAt: null,
    thinking: { status: 'idle', levels: [], provider: undefined, model: undefined, error: null },
    modelOptions: { status: 'idle', provider: undefined, options: [], error: null },
    mutations: { model: 'idle', thinking: 'idle', language: 'idle', storyLanguage: 'idle', provider: 'idle' },
    message: null,
  };
}

export const settingsState: Writable<SettingsState> = writable(initialSettingsState());

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function isProjectUnavailable(structured: StructuredError): boolean {
  return structured.code === 'project_unavailable';
}

/** Fetch the redacted configuration view (no secrets ever arrive). */
export async function refreshConfig(): Promise<boolean> {
  settingsState.update((s) => ({ ...s, status: 'loading', error: null }));
  try {
    const view = await configGet();
    syncLocaleFromView(view);
    settingsState.update((s) => ({
      ...s,
      status: 'ready',
      view,
      fetchedAt: Date.now(),
      error: null,
    }));
    return true;
  } catch (raw) {
    const structured = reportError(raw, 'config.get');
    if (isProjectUnavailable(structured)) {
      settingsState.set(initialSettingsState());
      return false;
    }
    settingsState.update((s) => ({ ...s, status: 'idle', error: structured }));
    return false;
  }
}

/**
 * Fetch the thinking levels for the ACTIVE model (the engine exposes levels
 * only for the currently selected model; requested pairs are echoed back).
 */
export async function refreshThinkingLevels(): Promise<boolean> {
  settingsState.update((s) => ({ ...s, thinking: { ...s.thinking, status: 'loading', error: null } }));
  try {
    const result: ThinkingLevelsResult = await configThinkingLevels();
    settingsState.update((s) => ({
      ...s,
      thinking: {
        status: 'ready',
        levels: result.levels ?? [],
        provider: result.provider,
        model: result.model,
        error: null,
      },
    }));
    return true;
  } catch (raw) {
    const structured = reportError(raw, 'config.thinking_levels');
    if (isProjectUnavailable(structured)) {
      settingsState.update((s) => ({ ...s, thinking: initialSettingsState().thinking }));
      return false;
    }
    settingsState.update((s) => ({ ...s, thinking: { ...s.thinking, status: 'idle', error: structured } }));
    return false;
  }
}

function noteApplied(message: string): void {
  settingsState.update((s) => ({ ...s, message }));
  pushNotification('info', message, { source: 'status' });
}

/**
 * Load the selectable models for one provider (`config.models {provider}`).
 * Read-only; used to populate the switch-model picker.
 */
export async function loadModelOptions(provider: string): Promise<boolean> {
  if (provider === '') return false;
  settingsState.update((s) => ({
    ...s,
    modelOptions: { ...s.modelOptions, status: 'loading', provider, error: null },
  }));
  try {
    const result = await configModels(provider);
    settingsState.update((s) => ({
      ...s,
      modelOptions: {
        status: 'ready',
        provider: result.provider ?? provider,
        options: result.models ?? [],
        error: null,
      },
    }));
    return true;
  } catch (raw) {
    const structured = reportError(raw, 'config.models');
    if (isProjectUnavailable(structured)) {
      settingsState.update((s) => ({ ...s, modelOptions: initialSettingsState().modelOptions }));
      return false;
    }
    settingsState.update((s) => ({
      ...s,
      modelOptions: { ...s.modelOptions, status: 'idle', error: structured },
    }));
    return false;
  }
}

/** Switch the active provider/model — one explicit protocol request. */
export async function switchModelFromUi(provider: string, model: string): Promise<boolean> {
  if (get(settingsState).mutations.model !== 'idle' || provider === '' || model === '') return false;
  settingsState.update((s) => ({
    ...s,
    mutations: { ...s.mutations, model: 'applying' },
    message: null,
  }));
  try {
    const result = await configSwitchModel(provider, model);
    noteApplied(`model switched to ${result.provider ?? provider} / ${result.model ?? model}`);
    // The redacted view + thinking levels are authoritative again.
    await refreshConfig();
    await refreshThinkingLevels();
    return true;
  } catch (raw) {
    reportError(raw, 'config.switch_model');
    return false;
  } finally {
    settingsState.update((s) => ({ ...s, mutations: { ...s.mutations, model: 'idle' } }));
  }
}

/** Set the thinking level — one explicit request (level from the engine list). */
export async function setThinkingFromUi(level: string): Promise<boolean> {
  if (get(settingsState).mutations.thinking !== 'idle' || level === '') return false;
  settingsState.update((s) => ({
    ...s,
    mutations: { ...s.mutations, thinking: 'applying' },
    message: null,
  }));
  try {
    const result = await configSetThinking(level);
    noteApplied(`thinking level set to ${result.level ?? level}`);
    await refreshConfig();
    return true;
  } catch (raw) {
    reportError(raw, 'config.set_thinking');
    return false;
  } finally {
    settingsState.update((s) => ({ ...s, mutations: { ...s.mutations, thinking: 'idle' } }));
  }
}

/** Set the UI language — one explicit request; the engine normalizes. */
export async function setLanguageFromUi(language: string): Promise<boolean> {
  if (get(settingsState).mutations.language !== 'idle' || language.trim() === '') return false;
  settingsState.update((s) => ({
    ...s,
    mutations: { ...s.mutations, language: 'applying' },
    message: null,
  }));
  try {
    const result = await configSetLanguage(language.trim());
    noteApplied(`interface language set to ${result.language ?? language.trim()}`);
    await refreshConfig();
    return true;
  } catch (raw) {
    reportError(raw, 'config.set_language');
    return false;
  } finally {
    settingsState.update((s) => ({ ...s, mutations: { ...s.mutations, language: 'idle' } }));
  }
}

/** Set the story output language — one explicit request; the engine normalizes. */
export async function setStoryLanguageFromUi(language: string): Promise<boolean> {
  if (get(settingsState).mutations.storyLanguage !== 'idle' || language.trim() === '') return false;
  settingsState.update((s) => ({
    ...s,
    mutations: { ...s.mutations, storyLanguage: 'applying' },
    message: null,
  }));
  try {
    const result = await configSetStoryLanguage(language.trim());
    noteApplied(`story language set to ${result.story_language ?? language.trim()}`);
    await refreshConfig();
    return true;
  } catch (raw) {
    reportError(raw, 'config.set_story_language');
    return false;
  } finally {
    settingsState.update((s) => ({ ...s, mutations: { ...s.mutations, storyLanguage: 'idle' } }));
  }
}

/** Save or update a provider configuration — explicit protocol request. */
export async function saveProviderFromUi(payload: SaveProviderPayload): Promise<boolean> {
  if (get(settingsState).mutations.provider !== 'idle' || payload.provider.trim() === '') return false;
  settingsState.update((s) => ({
    ...s,
    mutations: { ...s.mutations, provider: 'applying' },
    message: null,
  }));
  try {
    const result = await configSaveProvider(payload);
    noteApplied(`provider ${result.provider?.name ?? payload.provider} saved`);
    await refreshConfig();
    return true;
  } catch (raw) {
    reportError(raw, 'config.save_provider');
    return false;
  } finally {
    settingsState.update((s) => ({ ...s, mutations: { ...s.mutations, provider: 'idle' } }));
  }
}

/** Test a draft provider connection without saving. */
export async function testProviderFromUi(
  payload: TestProviderPayload,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  try {
    const result = await configTestProvider(payload);
    return { ok: true, latencyMs: result.latency_ms };
  } catch (raw) {
    const structured = toStructuredError(raw);
    return { ok: false, error: structured.message };
  }
}

/** Delete a provider configuration — explicit protocol request. */
export async function deleteProviderFromUi(provider: string): Promise<boolean> {
  const name = provider.trim();
  if (get(settingsState).mutations.provider !== 'idle' || name === '') return false;
  settingsState.update((s) => ({
    ...s,
    mutations: { ...s.mutations, provider: 'applying' },
    message: null,
  }));
  try {
    const result = await configDeleteProvider({ provider: name });
    noteApplied(`provider ${result.provider ?? name} deleted`);
    await refreshConfig();
    return true;
  } catch (raw) {
    reportError(raw, 'config.delete_provider');
    return false;
  } finally {
    settingsState.update((s) => ({ ...s, mutations: { ...s.mutations, provider: 'idle' } }));
  }
}

/** Fetch available models from a remote endpoint. Returns model ID list or throws on failure. */
export async function fetchProviderModelsFromUi(payload: FetchProviderModelsPayload): Promise<string[]> {
  try {
    const result = await configFetchProviderModels(payload);
    return result.models ?? [];
  } catch (raw) {
    reportError(raw, 'config.fetch_provider_models');
    throw raw;
  }
}

/** Clear the last applied-change message. */
export function dismissSettingsMessage(): void {
  settingsState.update((s) => ({ ...s, message: null }));
}

/** Reset all module state (tests / disposal). */
export function resetSettingsState(): void {
  settingsState.set(initialSettingsState());
}

// Project closed: configuration views are project-scoped; drop them.
projectSnapshot.subscribe((snapshot) => {
  if (snapshot === null) resetSettingsState();
});

// Engine restart: the Host (and its in-memory configuration) was rebuilt;
// cached views are stale. Reset — the screen refetches on mount/refresh.
onEngineSessionChange(() => {
  resetSettingsState();
});
