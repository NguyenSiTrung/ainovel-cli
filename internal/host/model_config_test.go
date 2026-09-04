package host

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/voocel/ainovel-cli/internal/bootstrap"
)

func newModelConfigTestHost(t *testing.T) (*Host, string) {
	t.Helper()
	pc := bootstrap.ProviderConfig{
		Type: "openai", APIKey: "old-secret", BaseURL: "https://example.com/v1",
		Models: []bootstrap.ModelConfig{{Name: "old", ContextWindow: 128000}, {Name: "writer-model"}},
	}
	cfg := bootstrap.Config{
		Provider: "proxy", ModelName: "old", Providers: map[string]bootstrap.ProviderConfig{"proxy": pc},
		Roles: map[string]bootstrap.RoleConfig{"writer": {
			Provider: "proxy", Model: "writer-model",
			Fallbacks: []bootstrap.ModelRef{{Provider: "proxy", Model: "old"}},
		}},
	}
	models, err := bootstrap.NewModelSet(cfg)
	if err != nil {
		t.Fatalf("new model set: %v", err)
	}
	// 落一份初始配置：生产中 configPath 必指向已存在的配置层，SaveProviderConfig
	// 只补 providers 段、保留其余，seed 后才能真实检验“顶层选择不被改动”。
	path := filepath.Join(t.TempDir(), "config.json")
	if err := bootstrap.SaveConfig(path, cfg); err != nil {
		t.Fatalf("seed config: %v", err)
	}
	return &Host{
		cfg: cfg, models: models, events: make(chan Event, 4),
		configPath: path,
	}, path
}

// 推理强度存储保留原始意图：显式设定后，切模型不得把它钳制降级写回。
func TestSetRoleThinkingPreservesIntentAcrossModelSwitch(t *testing.T) {
	h, _ := newModelConfigTestHost(t)
	if err := h.SetRoleThinking("writer", "high"); err != nil {
		t.Fatalf("set thinking: %v", err)
	}
	if got := h.cfg.Roles["writer"].ReasoningEffort; got != "high" {
		t.Fatalf("SetRoleThinking 应原样存 high，得到 %q", got)
	}
	// 换 writer 的模型：已存的强度意图必须保持 high，钳制只应发生在下发路径。
	if err := h.SwitchModel("writer", "proxy", "old"); err != nil {
		t.Fatalf("switch: %v", err)
	}
	if got := h.cfg.Roles["writer"].ReasoningEffort; got != "high" {
		t.Fatalf("切模型后 writer thinking 被改写为 %q，应仍是 high", got)
	}
}

func TestConfigureModelsRejectsDeletingReferencedModel(t *testing.T) {
	h, _ := newModelConfigTestHost(t)
	// 删掉被 writer 角色引用的 "writer-model"（保留顶层在用的 "old"）应被拒。
	err := h.ConfigureModels(ModelConfigurationDraft{
		Provider: "proxy", Type: "openai", BaseURL: "https://example.com/v1",
		Models:       []bootstrap.ModelConfig{{Name: "old"}, {Name: "new"}},
		APIKeyAction: APIKeyKeep,
	})
	if err == nil || !strings.Contains(err.Error(), "writer") {
		t.Fatalf("expected writer reference error, got %v", err)
	}
	provider, model, _ := h.models.CurrentSelection("default")
	if provider != "proxy" || model != "old" {
		t.Fatalf("runtime mutated after failure: %s/%s", provider, model)
	}
}

// /config 不再代切默认：删掉顶层正在用的模型必须被拒，让用户先去 /model 切走。
func TestConfigureModelsRejectsDeletingCurrentModel(t *testing.T) {
	h, _ := newModelConfigTestHost(t)
	err := h.ConfigureModels(ModelConfigurationDraft{
		Provider: "proxy", Type: "openai", BaseURL: "https://example.com/v1",
		Models:       []bootstrap.ModelConfig{{Name: "writer-model"}, {Name: "new"}},
		APIKeyAction: APIKeyKeep,
	})
	if err == nil || !strings.Contains(err.Error(), "default") {
		t.Fatalf("expected default reference error, got %v", err)
	}
}

func TestConfigureModelsPersistsAndHotApplies(t *testing.T) {
	h, path := newModelConfigTestHost(t)
	err := h.ConfigureModels(ModelConfigurationDraft{
		Provider: "proxy", Type: "openai", API: "responses", BaseURL: "https://new.example/v1",
		Models:       []bootstrap.ModelConfig{{Name: "old", ContextWindow: 640000}, {Name: "writer-model"}},
		APIKeyAction: APIKeyKeep,
	})
	if err != nil {
		t.Fatalf("configure: %v", err)
	}
	// 顶层选择不被 /config 改动：仍是 proxy/old。
	provider, model, _ := h.models.CurrentSelection("default")
	if provider != "proxy" || model != "old" {
		t.Fatalf("runtime selection mutated = %s/%s", provider, model)
	}
	// provider 段热应用：old 的窗口更新为 640000。
	if window, source := h.models.ResolveContextWindow("proxy", "old"); window != 640000 || source != bootstrap.CtxWindowModelConfig {
		t.Fatalf("runtime window = %d %s", window, source)
	}
	saved, err := bootstrap.LoadConfigFile(path)
	if err != nil {
		t.Fatalf("load saved: %v", err)
	}
	if saved.Provider != "proxy" || saved.ModelName != "old" || saved.Providers["proxy"].APIKey != "old-secret" {
		t.Fatalf("saved config = %#v", saved)
	}
	if saved.Providers["proxy"].API != "responses" || saved.Providers["proxy"].BaseURL != "https://new.example/v1" {
		t.Fatalf("saved provider not patched = %#v", saved.Providers["proxy"])
	}
	if len(saved.Providers["proxy"].Models) != 2 || saved.Providers["proxy"].Models[0].ContextWindow != 640000 {
		t.Fatalf("saved models = %#v", saved.Providers["proxy"].Models)
	}
}

// TUI 草稿保存不得丢失 json_schema 三态（prepareProviderDraftLocked 整结构体
// 往返的回归锁）。
func TestConfigureModelsPreservesJSONSchemaTriState(t *testing.T) {
	h, path := newModelConfigTestHost(t)
	tr := true
	err := h.ConfigureModels(ModelConfigurationDraft{
		Provider: "proxy", Type: "openai", BaseURL: "https://example.com/v1",
		Models: []bootstrap.ModelConfig{
			{Name: "old", ContextWindow: 128000, JSONSchema: &tr},
			{Name: "writer-model"},
		},
		APIKeyAction: APIKeyKeep,
	})
	if err != nil {
		t.Fatalf("configure: %v", err)
	}
	saved, err := bootstrap.LoadConfigFile(path)
	if err != nil {
		t.Fatalf("load saved: %v", err)
	}
	models := saved.Providers["proxy"].Models
	if len(models) != 2 || models[0].JSONSchema == nil || !*models[0].JSONSchema {
		t.Fatalf("json_schema 丢失: %#v", models)
	}
	if models[1].JSONSchema != nil {
		t.Fatalf("未配置模型不应臆造三态: %#v", models[1])
	}
}

func TestConfigureModelsRenamesModelAndReferencesAtomically(t *testing.T) {
	h, path := newModelConfigTestHost(t)
	err := h.ConfigureModels(ModelConfigurationDraft{
		Provider: "proxy", Type: "openai", BaseURL: "https://example.com/v1",
		Models: []bootstrap.ModelConfig{{Name: "renamed", ContextWindow: 256000}, {Name: "writer-renamed"}},
		Renames: []ModelRename{
			{From: "old", To: "renamed"},
			{From: "writer-model", To: "writer-renamed"},
		}, APIKeyAction: APIKeyKeep,
	})
	if err != nil {
		t.Fatalf("rename model: %v", err)
	}
	if h.cfg.ModelName != "renamed" || h.cfg.Roles["writer"].Model != "writer-renamed" ||
		h.cfg.Roles["writer"].Fallbacks[0].Model != "renamed" {
		t.Fatalf("runtime references not migrated: default=%q writer=%#v", h.cfg.ModelName, h.cfg.Roles["writer"])
	}
	provider, model, ok := h.models.CurrentSelection("default")
	if !ok || provider != "proxy" || model != "renamed" {
		t.Fatalf("runtime model set not migrated: %s/%s ok=%v", provider, model, ok)
	}
	saved, err := bootstrap.LoadConfigFile(path)
	if err != nil {
		t.Fatalf("load saved: %v", err)
	}
	if saved.ModelName != "renamed" || saved.Roles["writer"].Model != "writer-renamed" ||
		saved.Roles["writer"].Fallbacks[0].Model != "renamed" {
		t.Fatalf("saved references not migrated: default=%q writer=%#v", saved.ModelName, saved.Roles["writer"])
	}
	if _, ok := saved.Providers["proxy"].ModelConfig("renamed"); !ok {
		t.Fatalf("saved provider missing renamed model: %#v", saved.Providers["proxy"].Models)
	}
}

func TestConfigureModelsDoesNotGuessRenameFromDeleteAndAdd(t *testing.T) {
	h, _ := newModelConfigTestHost(t)
	err := h.ConfigureModels(ModelConfigurationDraft{
		Provider: "proxy", Type: "openai", BaseURL: "https://example.com/v1",
		Models: []bootstrap.ModelConfig{{Name: "renamed"}, {Name: "writer-model"}}, APIKeyAction: APIKeyKeep,
	})
	if err == nil || !strings.Contains(err.Error(), "default") {
		t.Fatalf("未显式声明重命名时仍应按删除保护，got %v", err)
	}
}

func TestModelConfigurationsIncludesReferencedUnlistedModel(t *testing.T) {
	pc := bootstrap.ProviderConfig{Models: []bootstrap.ModelConfig{{Name: "listed"}}}
	cfg := bootstrap.Config{
		Provider: "proxy", ModelName: "listed", Providers: map[string]bootstrap.ProviderConfig{"proxy": pc},
		Roles: map[string]bootstrap.RoleConfig{"writer": {Provider: "proxy", Model: "referenced-only"}},
	}
	models := modelConfigurations(cfg, "proxy", pc)
	if len(models) != 2 || models[0].Name != "listed" || models[1].Name != "referenced-only" {
		t.Fatalf("界面与重命名校验应共享完整候选模型列表，got %#v", models)
	}
}

func TestMaskAPIKeyAndSnapshotNeverExposeFullValue(t *testing.T) {
	if got := MaskAPIKey("  sk-1234567890abcdef  "); got != "sk-1******cdef" {
		t.Fatalf("MaskAPIKey = %q", got)
	}
	if got := MaskAPIKey("short-secret"); got != "******" {
		t.Fatalf("短 Key 应全部隐藏，得到 %q", got)
	}

	h, _ := newModelConfigTestHost(t)
	snapshot := h.ModelConfiguration()
	if len(snapshot.Providers) != 1 {
		t.Fatalf("providers = %#v", snapshot.Providers)
	}
	provider := snapshot.Providers[0]
	if provider.APIKeyHint != "******" || strings.Contains(provider.APIKeyHint, "old-secret") {
		t.Fatalf("snapshot 暴露了完整 API Key: %#v", provider)
	}
}

func TestConfigureModelsRejectsMissingRequiredAPIKeyForUnusedProvider(t *testing.T) {
	h, _ := newModelConfigTestHost(t)
	err := h.ConfigureModels(ModelConfigurationDraft{
		Provider:     "anthropic",
		Models:       []bootstrap.ModelConfig{{Name: "claude-test"}},
		APIKeyAction: APIKeyKeep,
	})
	if err == nil || !strings.Contains(err.Error(), "必须配置 API Key") {
		t.Fatalf("未使用但要求凭证的 Provider 也应拒绝空 Key，得到 %v", err)
	}
	if _, exists := h.cfg.Providers["anthropic"]; exists {
		t.Fatal("校验失败后不应修改运行时配置")
	}
}

func TestModelConnectionUsesDraftWithoutSaving(t *testing.T) {
	var requestPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"id":"test","object":"chat.completion","created":1,"model":"old",
			"choices":[{"index":0,"message":{"role":"assistant","content":"OK"},"finish_reason":"stop"}],
			"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}
		}`))
	}))
	defer server.Close()

	h, path := newModelConfigTestHost(t)
	originalURL := h.cfg.Providers["proxy"].BaseURL
	err := h.TestModelConnection(context.Background(), ModelConfigurationDraft{
		Provider: "proxy", Type: "openai", BaseURL: server.URL + "/v1",
		Models: []bootstrap.ModelConfig{{Name: "old"}}, APIKeyAction: APIKeyKeep,
	}, "old")
	if err != nil {
		t.Fatalf("test connection: %v", err)
	}
	if requestPath != "/v1/chat/completions" {
		t.Fatalf("request path = %q", requestPath)
	}
	if got := h.cfg.Providers["proxy"].BaseURL; got != originalURL {
		t.Fatalf("连接测试修改了运行时配置: %q", got)
	}
	saved, err := bootstrap.LoadConfigFile(path)
	if err != nil {
		t.Fatalf("load config: %v", err)
	}
	if got := saved.Providers["proxy"].BaseURL; got != originalURL {
		t.Fatalf("连接测试写入了配置文件: %q", got)
	}
}

func TestConfigureModelsSuggestsSwitchForNewProvider(t *testing.T) {
	h, _ := newModelConfigTestHost(t)
	err := h.ConfigureModels(ModelConfigurationDraft{
		Provider: "backup", Type: "openai", BaseURL: "https://backup.example/v1",
		Models: []bootstrap.ModelConfig{{Name: "backup-model"}}, APIKeyAction: APIKeyKeep,
	})
	if err != nil {
		t.Fatalf("configure backup: %v", err)
	}
	event := <-h.events
	if !strings.Contains(event.Summary, "使用 /model 切换") {
		t.Fatalf("新增非当前 Provider 后应提示切换，event=%q", event.Summary)
	}
}

func TestDeleteProviderRejectsInUseAndDeletesUnused(t *testing.T) {
	h, _ := newModelConfigTestHost(t)
	// proxy is active default provider -> delete must be rejected
	err := h.DeleteProvider("proxy")
	if err == nil {
		t.Fatalf("expected error deleting active default provider")
	}
	// Add unused provider
	err = h.ConfigureModels(ModelConfigurationDraft{
		Provider: "unused", Type: "openai", BaseURL: "https://unused.example/v1",
		Models: []bootstrap.ModelConfig{{Name: "m1"}}, APIKeyAction: APIKeyKeep,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Deleting unused should succeed
	if err := h.DeleteProvider("unused"); err != nil {
		t.Fatalf("delete unused provider failed: %v", err)
	}
	if _, exists := h.cfg.Providers["unused"]; exists {
		t.Fatalf("provider 'unused' should not exist in host config")
	}
}

func TestFetchRemoteModelsOpenAIAndOllamaFormats(t *testing.T) {
	h, _ := newModelConfigTestHost(t)

	// 1. OpenAI format
	srvOpenAI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-key" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":[{"id":"gpt-4o"},{"id":"gpt-4o-mini"},{"id":"text-embedding-3"}]}`))
	}))
	defer srvOpenAI.Close()

	models, err := h.FetchRemoteModels(context.Background(), FetchRemoteModelsDraft{
		Type: "openai", BaseURL: srvOpenAI.URL, APIKey: "test-key", APIKeyAction: APIKeyReplace,
	})
	if err != nil {
		t.Fatalf("fetch openai models: %v", err)
	}
	if len(models) != 3 || models[0] != "gpt-4o" || models[1] != "gpt-4o-mini" || models[2] != "text-embedding-3" {
		t.Fatalf("unexpected models list: %v", models)
	}

	// 2. Ollama format
	srvOllama := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"models":[{"name":"llama3:latest"},{"name":"qwen2.5:7b"}]}`))
	}))
	defer srvOllama.Close()

	models, err = h.FetchRemoteModels(context.Background(), FetchRemoteModelsDraft{
		Type: "openai", BaseURL: srvOllama.URL,
	})
	if err != nil {
		t.Fatalf("fetch ollama models: %v", err)
	}
	if len(models) != 2 || models[0] != "llama3:latest" || models[1] != "qwen2.5:7b" {
		t.Fatalf("unexpected ollama models: %v", models)
	}

	// 3. Fallback from /models to /v1/models on 404
	srvFallback := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/models" {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path == "/v1/models" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte(`{"data":[{"id":"fallback-model"}]}`))
			return
		}
		http.NotFound(w, r)
	}))
	defer srvFallback.Close()

	models, err = h.FetchRemoteModels(context.Background(), FetchRemoteModelsDraft{
		Type: "openai", BaseURL: srvFallback.URL,
	})
	if err != nil {
		t.Fatalf("fetch fallback models: %v", err)
	}
	if len(models) != 1 || models[0] != "fallback-model" {
		t.Fatalf("unexpected fallback models: %v", models)
	}

	// 4. Retain existing API key with APIKeyKeep
	srvAuth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer old-secret" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"data":[{"id":"secret-model"}]}`))
	}))
	defer srvAuth.Close()

	models, err = h.FetchRemoteModels(context.Background(), FetchRemoteModelsDraft{
		Provider: "proxy", Type: "openai", BaseURL: srvAuth.URL, APIKeyAction: APIKeyKeep,
	})
	if err != nil {
		t.Fatalf("fetch with existing key: %v", err)
	}
	if len(models) != 1 || models[0] != "secret-model" {
		t.Fatalf("unexpected secret models: %v", models)
	}
}
func TestHost_UnconfiguredProvider_AllowsInitAndSavesFirstProvider(t *testing.T) {
	cfg := bootstrap.Config{
		Providers: map[string]bootstrap.ProviderConfig{},
	}
	models, err := bootstrap.NewModelSet(cfg)
	if err != nil {
		t.Fatalf("expected NewModelSet with empty provider to succeed, got: %v", err)
	}
	path := filepath.Join(t.TempDir(), "config.json")
	if err := bootstrap.SaveConfig(path, cfg); err != nil {
		t.Fatalf("save empty config: %v", err)
	}
	h := &Host{
		cfg: cfg, models: models, events: make(chan Event, 4),
		configPath: path,
	}
	snap := h.ModelConfiguration()
	if snap.DefaultProvider != "" || len(snap.Providers) != 0 {
		t.Fatalf("expected unconfigured snapshot, got default=%q, providers=%d", snap.DefaultProvider, len(snap.Providers))
	}

	draft := ModelConfigurationDraft{
		Provider: "deepseek",
		Type:     "openai",
		BaseURL:  "https://api.deepseek.com/v1",
		Models: []bootstrap.ModelConfig{
			{Name: "deepseek-chat", ContextWindow: 128000},
		},
	}
	if err := h.ConfigureModels(draft); err != nil {
		t.Fatalf("ConfigureModels failed on first provider: %v", err)
	}

	after := h.ModelConfiguration()
	if after.DefaultProvider != "deepseek" {
		t.Fatalf("expected default provider to become deepseek, got: %q", after.DefaultProvider)
	}
	if after.DefaultModel != "deepseek-chat" {
		t.Fatalf("expected default model to become deepseek-chat, got: %q", after.DefaultModel)
	}
}
