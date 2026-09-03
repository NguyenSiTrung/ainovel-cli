// project.go —— 项目/配置/工件的只读投影与本地适配器。
//
// 引擎没有公开 Host API 的读取面（章节列表/正文、诊断、用量明细、运行队列）经
// store/diag 的既有只读入口投影，绝不复算引擎决策；诊断与导出复用 TUI 的
// 同一路径（store.NewStore + diag.Diagnose / diag.Export，见 tui/events.go loadReport）。
package desktop

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/voocel/ainovel-cli/internal/diag"
	"github.com/voocel/ainovel-cli/internal/domain"
	"github.com/voocel/ainovel-cli/internal/host"
	"github.com/voocel/ainovel-cli/internal/host/exp"
	"github.com/voocel/ainovel-cli/internal/store"
)

// snapshotPayload 把 host.UISnapshot 投影为开放式协议载荷（project.snapshot /
// 状态刷新共用）。字段为投影名，客户端忽略未知字段。
func snapshotPayload(snap host.UISnapshot) map[string]any {
	payload := map[string]any{
		"state":                  snap.RuntimeState,
		"status_label":           snap.StatusLabel,
		"phase":                  snap.Phase,
		"flow":                   snap.Flow,
		"running":                snap.IsRunning,
		"book_title":             snap.BookTitle,
		"synopsis":               snap.Synopsis,
		"premise":                snap.Premise,
		"style":                  snap.Style,
		"provider":               snap.Provider,
		"model":                  snap.ModelName,
		"thinking_level":         snap.ThinkingLevel,
		"current_chapter":        snap.CurrentChapter,
		"total_chapters":         snap.TotalChapters,
		"completed_chapters":     snap.CompletedCount,
		"total_word_count":       snap.TotalWordCount,
		"in_progress_chapter":    snap.InProgressChapter,
		"pending_rewrites":       snap.PendingRewrites,
		"advance_mode":           snap.AdvanceMode,
		"advance_permit_chapter": snap.AdvancePermitChapter,
		"has_advance_hold":       snap.HasAdvanceHold,
		"advance_hold_reason":    snap.AdvanceHoldReason,
		"recovery_label":         snap.RecoveryLabel,
		"pending_steer":          snap.PendingSteer,
		"total_input_tokens":     snap.TotalInputTokens,
		"total_output_tokens":    snap.TotalOutputTokens,
		"total_cost_usd":         snap.TotalCostUSD,
		"budget_limit_usd":       snap.BudgetLimitUSD,
	}
	if snap.Layered {
		payload["layered"] = true
		payload["current_volume_arc"] = snap.CurrentVolumeArc
	}
	outline := make([]map[string]any, 0, len(snap.Outline))
	for _, e := range snap.Outline {
		outline = append(outline, map[string]any{
			"chapter": e.Chapter, "title": e.Title, "core_event": e.CoreEvent,
		})
	}
	payload["outline"] = outline
	if len(snap.Characters) > 0 {
		payload["characters"] = snap.Characters
	}
	return payload
}

// ── 章节（只读投影 + 保存适配器，store 既有 API）──

func (d *Daemon) handleChapterList(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	s := store.NewStore(p.host.Dir())
	progress, err := s.Progress.Load()
	if err != nil {
		return d.opFailed(req, fmt.Errorf("load progress: %w", err))
	}
	if progress == nil {
		// 全新项目还没有 meta/progress.json：投影为空（此前这里空指针 panic）。
		progress = &domain.Progress{}
	}
	chapters := make([]map[string]any, 0, len(progress.CompletedChapters))
	for _, ch := range completedSorted(progress) {
		item := map[string]any{
			"chapter": ch,
			"words":   progress.ChapterWordCounts[ch],
			"status":  "saved",
		}
		if record, err := s.ChapterRecords.Load(ch); err == nil && record != nil {
			item["version"] = record.Revision
			item["origin"] = string(record.Origin)
			if record.Facts.Title != "" {
				item["title"] = record.Facts.Title
			}
		}
		chapters = append(chapters, item)
	}
	snap := p.host.Snapshot()
	return successResponse(req.ID, d.session, map[string]any{
		"chapters":         chapters,
		"completed":        len(chapters),
		"total":            snap.TotalChapters,
		"in_progress":      snap.InProgressChapter,
		"pending_rewrites": snap.PendingRewrites,
	})
}

func completedSorted(progress *domain.Progress) []int {
	if progress == nil || len(progress.CompletedChapters) == 0 {
		return nil
	}
	out := append([]int(nil), progress.CompletedChapters...)
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}

func (d *Daemon) handleChapterRead(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	chapter, ok := payloadInt(req.Payload, "chapter")
	if !ok || chapter <= 0 {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "chapter must be a positive integer (or numeric string)", nil)
	}
	s := store.NewStore(p.host.Dir())
	text, err := s.Drafts.LoadChapterText(chapter)
	if err != nil {
		return d.opFailed(req, fmt.Errorf("read chapter %d: %w", chapter, err))
	}
	payload := map[string]any{
		"chapter": chapter,
		"content": text,
		"words":   utf8.RuneCountInString(text),
	}
	if record, err := s.ChapterRecords.Load(chapter); err == nil && record != nil {
		payload["version"] = record.Revision
		payload["origin"] = string(record.Origin)
		if text == "" { // 工作区文件缺失时回落接纳记录的基线正文
			payload["content"] = record.Content
			payload["words"] = utf8.RuneCountInString(record.Content)
			payload["source"] = "record"
		}
	}
	if text == "" {
		if _, hasVersion := payload["version"]; !hasVersion {
			return d.opFailedMsg(req, fmt.Sprintf("chapter %d not found", chapter))
		}
	}
	return successResponse(req.ID, d.session, payload)
}

// handleChapterSave 保存章节正文（origin=user）：
//  0. 运行中的引擎独占进度/接纳账本 → host_busy 拒绝（与 revisions.sync 同一
//     IsRunning 守卫：字数投影的 Progress.Load→mutate→Save 与引擎进度写无
//     跨实例互斥，运行期保存会静默丢一侧更新）；
//  1. base_version 冲突检测（相对接纳记录的 revision）；
//  2. 写工作区正文 chapters/NN.md（Drafts.SaveFinalChapter）；
//  3. ChapterRecords.Accept 保留既有 Facts/StyleDelta（只换正文，事实归引擎）；
//  4. 字数投影（ChapterWordCounts/TotalWordCount）等量替换，保持 chapter.list 一致。
func (d *Daemon) handleChapterSave(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	chapter, ok := payloadInt(req.Payload, "chapter")
	if !ok || chapter <= 0 {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "chapter must be a positive integer (or numeric string)", nil)
	}
	content := payloadString(req.Payload, "content")
	if strings.TrimSpace(content) == "" {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "content is required", nil)
	}
	if p.host.Snapshot().IsRunning {
		return errorResponse(req.ID, d.session, CodeHostBusy,
			"a generation run is already active", map[string]any{"active_request": "chapter.save"})
	}

	s := store.NewStore(p.host.Dir())
	record, err := s.ChapterRecords.Load(chapter)
	if err != nil {
		return d.opFailed(req, fmt.Errorf("load chapter %d record: %w", chapter, err))
	}
	if baseVersion, has := payloadInt(req.Payload, "base_version"); has && record != nil && record.Revision != baseVersion {
		return errorResponse(req.ID, d.session, CodeOperationFailed,
			fmt.Sprintf("chapter %d was modified concurrently (base_version=%d, current version=%d)", chapter, baseVersion, record.Revision),
			map[string]any{"conflict": true, "current_version": record.Revision})
	}

	normalized := domain.NormalizeChapterContent(content)
	if err := s.Drafts.SaveFinalChapter(chapter, normalized); err != nil {
		return d.opFailed(req, fmt.Errorf("write chapter %d: %w", chapter, err))
	}
	var facts domain.ChapterFacts
	var style domain.StyleDelta
	if record != nil {
		facts, style = record.Facts, record.StyleDelta
	}
	accepted, err := s.ChapterRecords.Accept(chapter, domain.ChapterOriginUser, normalized, facts, style)
	if err != nil {
		return d.opFailed(req, fmt.Errorf("accept chapter %d record: %w", chapter, err))
	}
	if err := applyChapterWordCount(s, chapter, normalized); err != nil {
		d.log("warn", "chapter", "word count projection failed", "chapter", chapter, "err", err.Error())
	}

	version := 1
	if accepted != nil {
		version = accepted.Revision
	}
	d.emitEvent(p.id, "chapter.updated", map[string]any{
		"chapter": chapter, "version": version, "status": "saved",
	})
	return successResponse(req.ID, d.session, map[string]any{
		"chapter": chapter, "version": version, "saved": true,
	})
}

// applyChapterWordCount 把一次用户保存投影进进度（纯数值记账，非引擎决策）：
//  1. 全新项目尚无 meta/progress.json 时就地初始化投影（不触碰引擎阶段机）；
//  2. 章号进入 CompletedChapters（chapter.list 与 chapter.export 的数据源，
//     MarkChapterComplete 属生成完成路径，会连带阶段/场景语义，不适用于用户保存）；
//  3. 字数投影（ChapterWordCounts/TotalWordCount）等量替换，保持 chapter.list 一致。
func applyChapterWordCount(s *store.Store, chapter int, content string) error {
	progress, err := s.Progress.Load()
	if err != nil {
		return err
	}
	if progress == nil {
		progress = &domain.Progress{}
	}
	newCount := utf8.RuneCountInString(content)
	if progress.ChapterWordCounts == nil {
		progress.ChapterWordCounts = map[int]int{}
	}
	if old, exists := progress.ChapterWordCounts[chapter]; exists {
		progress.TotalWordCount += newCount - old
	} else {
		progress.TotalWordCount += newCount
	}
	progress.ChapterWordCounts[chapter] = newCount
	if !slices.Contains(progress.CompletedChapters, chapter) {
		progress.CompletedChapters = append(progress.CompletedChapters, chapter)
		slices.Sort(progress.CompletedChapters)
	}
	return s.Progress.Save(progress)
}

// ── 修订 ──

func (d *Daemon) handleRevisionsCheck(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	changed, err := p.host.CheckChapterRevisions()
	if err != nil {
		return d.opFailed(req, err)
	}
	if chapter, ok := payloadInt(req.Payload, "chapter"); ok && chapter > 0 {
		changed = filterChapters(changed, chapter)
	}
	return successResponse(req.ID, d.session, map[string]any{
		"chapters": changed, "count": len(changed),
	})
}

func filterChapters(chapters []int, want int) []int {
	for _, ch := range chapters {
		if ch == want {
			return []int{want}
		}
	}
	return nil
}

// handleRevisionsSync 接受响应 + 异步执行（SyncChapterRevisions 含 LLM 分析，
// 引擎侧独占）。终态经事件：完成 → chapter.updated(synced) + notification.info；
// 失败 → engine.error（code 已分类）。
func (d *Daemon) handleRevisionsSync(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	changed, err := p.host.CheckChapterRevisions()
	if err != nil {
		return d.opFailed(req, err)
	}
	if chapter, ok := payloadInt(req.Payload, "chapter"); ok && chapter > 0 {
		if len(filterChapters(changed, chapter)) == 0 {
			return successResponse(req.ID, d.session, map[string]any{"changed": []int{}, "applied": []int{}})
		}
	}
	if p.host.Snapshot().IsRunning {
		return errorResponse(req.ID, d.session, CodeHostBusy,
			"a generation run is already active", map[string]any{"active_request": "chapter.revisions.sync"})
	}
	go func() {
		result, err := p.host.SyncChapterRevisions(context.Background())
		if err != nil {
			d.log("error", "revision", "sync failed", "err", err.Error())
			d.emitEvent(p.id, "engine.error", map[string]any{
				"code": classifyCode(err), "message": "revision sync failed: " + err.Error(),
			})
			return
		}
		applied := []int{}
		if result != nil {
			applied = result.Applied
		}
		for _, ch := range applied {
			d.emitEvent(p.id, "chapter.updated", map[string]any{"chapter": ch, "status": "synced"})
		}
		d.emitEvent(p.id, "notification.info", map[string]any{
			"message": fmt.Sprintf("revision sync completed: %d applied", len(applied)),
			"details": map[string]any{"applied": applied},
		})
	}()
	return successResponse(req.ID, d.session, map[string]any{"accepted": true, "changed": changed})
}

// ── 导出（Host.Export：纯本地 IO，同步响应）──

func (d *Daemon) handleChapterExport(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	opts := exp.Options{
		OutPath: strings.TrimSpace(payloadString(req.Payload, "output_path")),
	}
	switch strings.ToLower(strings.TrimSpace(payloadString(req.Payload, "format"))) {
	case "":
		// 由 OutPath 后缀推断（exp 自带规则）
	case "txt":
		opts.Format = exp.FormatTXT
	case "epub":
		opts.Format = exp.FormatEPUB
	default:
		return errorResponse(req.ID, d.session, CodeInvalidPayload,
			"unsupported export format (supported: txt, epub)", nil)
	}
	if raw, ok := req.Payload["chapters"].([]any); ok && len(raw) > 0 {
		first, last, err := chapterRange(raw)
		if err != nil {
			return errorResponse(req.ID, d.session, CodeInvalidPayload, err.Error(), nil)
		}
		opts.From, opts.To = first, last
	}
	result, err := p.host.Export(context.Background(), opts)
	if err != nil {
		return d.opFailed(req, err)
	}
	payload := map[string]any{}
	if result != nil {
		payload = map[string]any{
			"path": result.Path, "chapters": result.Chapters,
			"bytes": result.Bytes, "skipped": result.Skipped,
		}
	}
	return successResponse(req.ID, d.session, payload)
}

// chapterRange 把章节列表折成引擎支持的闭区间（范围外的未完成章由引擎跳过）。
func chapterRange(raw []any) (int, int, error) {
	first, last := 0, 0
	for _, v := range raw {
		n, ok := 0, false
		switch t := v.(type) {
		case float64:
			n, ok = int(t), true
		case string:
			if _, err := fmt.Sscanf(t, "%d", &n); err == nil {
				ok = true
			}
		}
		if !ok || n <= 0 {
			return 0, 0, fmt.Errorf("chapters entries must be positive integers (got %v)", v)
		}
		if first == 0 || n < first {
			first = n
		}
		if n > last {
			last = n
		}
	}
	if first == 0 {
		return 0, 0, fmt.Errorf("chapters must not be empty")
	}
	return first, last, nil
}

// ── 工件只读投影（artifacts.read：facts / world / summary）──
//
// 纯只读适配层，与 diagnostics/chapter.list 同一模式：store.NewStore(projectDir)
// 的公开 API 直读。响应形状见 protocols/desktop-v1/README.md §12；载荷开放，
// 客户端忽略未知字段。写路径不存在 —— 工件变更由引擎自身拥有。

// handleArtifactsRead 读取工件投影：
//   - kind=facts  （可 chapter 过滤）：ChapterRecords 的已接纳章节事实；
//   - kind=world  （不接受 chapter）  ：world_rules 世界规则账本；
//   - kind=summary（可 chapter 过滤）：summaries/ 章节摘要。
func (d *Daemon) handleArtifactsRead(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	kind := strings.TrimSpace(payloadString(req.Payload, "kind"))
	chapter, hasChapter := payloadInt(req.Payload, "chapter")
	if hasChapter && chapter <= 0 {
		return errorResponse(req.ID, d.session, CodeInvalidPayload,
			"chapter must be a positive integer", nil)
	}
	s := store.NewStore(p.host.Dir())

	switch kind {
	case "facts":
		if hasChapter {
			record, err := s.ChapterRecords.Load(chapter)
			if err != nil {
				return d.opFailed(req, fmt.Errorf("load chapter %d record: %w", chapter, err))
			}
			if record == nil {
				// 未接纳事实是正常状态（如写作中的章节），不是错误。
				return successResponse(req.ID, d.session, map[string]any{
					"kind": kind, "chapter": chapter, "found": false,
				})
			}
			return successResponse(req.ID, d.session, map[string]any{
				"kind": kind, "chapter": chapter, "found": true,
				"version": record.Revision, "origin": string(record.Origin),
				"facts": record.Facts,
			})
		}
		progress, err := s.Progress.Load()
		if err != nil {
			return d.opFailed(req, fmt.Errorf("load progress: %w", err))
		}
		items := []map[string]any{}
		for _, ch := range completedSorted(progress) {
			record, err := s.ChapterRecords.Load(ch)
			if err != nil {
				return d.opFailed(req, fmt.Errorf("load chapter %d record: %w", ch, err))
			}
			if record == nil {
				continue
			}
			items = append(items, map[string]any{
				"chapter": ch, "version": record.Revision, "origin": string(record.Origin),
				"facts": record.Facts,
			})
		}
		return successResponse(req.ID, d.session, map[string]any{
			"kind": kind, "facts": items, "count": len(items),
		})

	case "world":
		if hasChapter {
			return errorResponse(req.ID, d.session, CodeInvalidPayload,
				"chapter is only valid for kinds facts and summary (world rules are not chapter-scoped)", nil)
		}
		rules, err := s.World.LoadWorldRules()
		if err != nil {
			return d.opFailed(req, fmt.Errorf("load world rules: %w", err))
		}
		if rules == nil {
			rules = []domain.WorldRule{}
		}
		return successResponse(req.ID, d.session, map[string]any{
			"kind": kind, "rules": rules, "count": len(rules),
		})

	case "summary":
		if hasChapter {
			sum, err := s.Summaries.LoadSummary(chapter)
			if err != nil {
				return d.opFailed(req, fmt.Errorf("load summary %d: %w", chapter, err))
			}
			if sum == nil {
				return successResponse(req.ID, d.session, map[string]any{
					"kind": kind, "chapter": chapter, "found": false,
				})
			}
			return successResponse(req.ID, d.session, map[string]any{
				"kind": kind, "chapter": chapter, "found": true, "summary": sum,
			})
		}
		progress, err := s.Progress.Load()
		if err != nil {
			return d.opFailed(req, fmt.Errorf("load progress: %w", err))
		}
		summaries := []domain.ChapterSummary{}
		for _, ch := range completedSorted(progress) {
			sum, err := s.Summaries.LoadSummary(ch)
			if err != nil {
				return d.opFailed(req, fmt.Errorf("load summary %d: %w", ch, err))
			}
			if sum != nil {
				summaries = append(summaries, *sum)
			}
		}
		return successResponse(req.ID, d.session, map[string]any{
			"kind": kind, "summaries": summaries, "count": len(summaries),
		})

	default:
		return errorResponse(req.ID, d.session, CodeInvalidPayload,
			"kind must be one of facts, world, summary", nil)
	}
}

// ── 配置 ──

// handleConfigGet 返回脱敏配置视图（Host.ModelConfiguration 本就不携带明文密钥，
// api_key 仅保留 hint；出口再过一遍 redactPayload）。
func (d *Daemon) handleConfigGet(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	mcfg := p.host.ModelConfiguration()
	snap := p.host.Snapshot()
	view := map[string]any{
		"provider":         mcfg.DefaultProvider,
		"model":            mcfg.DefaultModel,
		"reasoning_effort": p.host.CurrentThinking("default"),
		"language":         mcfg.Language,
		"story_language":   mcfg.StoryLanguage,
		"style":            snap.Style,
		"budget_usd":       snap.BudgetLimitUSD,
		"config_path":      mcfg.ConfigPath,
		"providers":        providerSummaries(mcfg),
	}
	if keys, ok := req.Payload["keys"].([]any); ok && len(keys) > 0 {
		filtered := map[string]any{}
		for _, k := range keys {
			name, _ := k.(string)
			if v, exists := view[name]; exists {
				filtered[name] = v
			}
		}
		view = filtered
	}
	return successResponse(req.ID, d.session, view)
}

func providerSummaries(mcfg host.ModelConfigurationSnapshot) []map[string]any {
	out := make([]map[string]any, 0, len(mcfg.Providers))
	for _, pc := range mcfg.Providers {
		models := make([]string, 0, len(pc.Models))
		for _, m := range pc.Models {
			models = append(models, m.Name)
		}
		out = append(out, map[string]any{
			"name": pc.Name, "type": pc.Type, "api": pc.API, "base_url": pc.BaseURL,
			"models": models, "has_api_key": pc.HasAPIKey,
			"api_key_hint": pc.APIKeyHint, "requires_api_key": pc.RequiresAPIKey,
		})
	}
	return out
}

// handleConfigUpdate 宽松键值更新：受公共 API 支持的键就地应用；
// 其余键列入 unsupported（引擎无公开设置器，绝不伪造成功）。
func (d *Daemon) handleConfigUpdate(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	values, ok := req.Payload["values"].(map[string]any)
	if !ok || len(values) == 0 {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "values must be a non-empty object", nil)
	}
	var updated, unsupported []string
	for key, val := range values {
		str, isStr := val.(string)
		if !isStr {
			unsupported = append(unsupported, key+" (non-string value)")
			continue
		}
		var err error
		switch key {
		case "language":
			err = p.host.ConfigureLanguage(normalizeLanguageCode(str), "")
		case "story_language":
			err = p.host.ConfigureLanguage("", normalizeLanguageCode(str))
		case "reasoning_effort":
			err = p.host.SetRoleThinking("default", str)
		default:
			unsupported = append(unsupported, key)
			continue
		}
		if err != nil {
			d.log("warn", "config", "update key failed", "key", key, "err", err.Error())
			return errorResponse(req.ID, d.session, CodeInvalidPayload,
				fmt.Sprintf("update %s failed: %s", key, err.Error()), nil)
		}
		updated = append(updated, key)
	}
	if len(updated) == 0 {
		return errorResponse(req.ID, d.session, CodeInvalidPayload,
			"no supported keys in values (supported: language, story_language, reasoning_effort)",
			map[string]any{"unsupported": unsupported})
	}
	return successResponse(req.ID, d.session, map[string]any{
		"updated": updated, "unsupported": unsupported,
	})
}

func (d *Daemon) handleConfigProviders(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	mcfg := p.host.ModelConfiguration()
	return successResponse(req.ID, d.session, map[string]any{
		"providers":        providerSummaries(mcfg),
		"default_provider": mcfg.DefaultProvider,
		"default_model":    mcfg.DefaultModel,
	})
}

func (d *Daemon) handleConfigModels(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	provider := strings.TrimSpace(payloadString(req.Payload, "provider"))
	modelList := func(name string) []map[string]any {
		out := make([]map[string]any, 0)
		for _, m := range p.host.ConfiguredModelOptions(name) {
			out = append(out, map[string]any{
				"name": m.Name, "context_window": m.ContextWindow,
				"context_source": string(m.ContextSource),
			})
		}
		return out
	}
	if provider != "" {
		return successResponse(req.ID, d.session, map[string]any{
			"provider": provider, "models": modelList(provider),
		})
	}
	providers := map[string]any{}
	for _, name := range p.host.ConfiguredProviders() {
		providers[name] = modelList(name)
	}
	return successResponse(req.ID, d.session, map[string]any{"providers": providers})
}

func (d *Daemon) handleConfigSwitchModel(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	provider := strings.TrimSpace(payloadString(req.Payload, "provider"))
	model := strings.TrimSpace(payloadString(req.Payload, "model"))
	if provider == "" || model == "" {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "provider and model are required", nil)
	}
	if err := p.host.SwitchModel("default", provider, model); err != nil {
		d.log("warn", "config", "switch model failed", "err", err.Error())
		return errorResponse(req.ID, d.session, classifyCode(err), err.Error(), nil)
	}
	return successResponse(req.ID, d.session, map[string]any{"provider": provider, "model": model})
}

// handleConfigThinkingLevels 引擎只暴露“当前生效模型”的档位
// （Host.AvailableThinking 按角色解析），provider/model 入参仅回显请求。
func (d *Daemon) handleConfigThinkingLevels(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	levels := make([]string, 0)
	for _, l := range p.host.AvailableThinking("default") {
		levels = append(levels, string(l))
	}
	provider, model, _ := p.host.CurrentModelSelection("default")
	payload := map[string]any{
		"levels": levels, "provider": provider, "model": model,
	}
	if reqProvider := strings.TrimSpace(payloadString(req.Payload, "provider")); reqProvider != "" {
		payload["requested_provider"] = reqProvider
	}
	if reqModel := strings.TrimSpace(payloadString(req.Payload, "model")); reqModel != "" {
		payload["requested_model"] = reqModel
	}
	return successResponse(req.ID, d.session, payload)
}

func (d *Daemon) handleConfigSetThinking(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	level := strings.TrimSpace(payloadString(req.Payload, "level"))
	if level == "" {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "level is required", nil)
	}
	if err := p.host.SetRoleThinking("default", level); err != nil {
		// SetRoleThinking 的失败路径即档位校验失败（agents.ParseThinkingLevel）。
		return errorResponse(req.ID, d.session, CodeInvalidPayload, err.Error(), nil)
	}
	return successResponse(req.ID, d.session, map[string]any{"level": level})
}

func (d *Daemon) handleConfigSetLanguage(req *Request) *Response {
	return d.setLanguage(req, true)
}

func (d *Daemon) handleConfigSetStoryLanguage(req *Request) *Response {
	return d.setLanguage(req, false)
}

func (d *Daemon) setLanguage(req *Request, ui bool) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	raw := strings.TrimSpace(payloadString(req.Payload, "language"))
	if raw == "" {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "language is required", nil)
	}
	lang := normalizeLanguageCode(raw)
	if ui {
		if err := p.host.ConfigureLanguage(lang, ""); err != nil {
			return d.opFailed(req, err)
		}
		return successResponse(req.ID, d.session, map[string]any{"language": lang})
	}
	// story_language 影响随资产包加载的提示词方向；持久化即时生效于共创/运行时
	// 配置，资产级指令在下次打开项目（重建 Host/bundle）时全面生效（报告有记载）。
	if err := p.host.ConfigureLanguage("", lang); err != nil {
		return d.opFailed(req, err)
	}
	return successResponse(req.ID, d.session, map[string]any{"story_language": lang})
}

// ── 诊断（复用 TUI 的 store.NewStore + diag.Diagnose 路径）──

func (d *Daemon) handleDiagnosticsSnapshot(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	rep, rc := diag.Diagnose(store.NewStore(p.host.Dir()))
	findings := make([]map[string]any, 0, len(rep.Findings))
	for _, f := range rep.Findings {
		findings = append(findings, map[string]any{
			"rule": f.Rule, "category": string(f.Category), "severity": string(f.Severity),
			"confidence": string(f.Confidence), "title": f.Title,
			"evidence": f.Evidence, "suggestion": f.Suggestion,
		})
	}
	models := make([]map[string]any, 0, len(rc.Models))
	for _, m := range rc.Models {
		models = append(models, map[string]any{"agent": m.Agent, "provider": m.Provider, "model": m.Model})
	}
	return successResponse(req.ID, d.session, map[string]any{
		"stats": map[string]any{
			"completed_chapters": rep.Stats.CompletedChapters,
			"total_chapters":     rep.Stats.TotalChapters,
			"total_words":        rep.Stats.TotalWords,
			"phase":              rep.Stats.Phase,
			"flow":               rep.Stats.Flow,
			"avg_review_score":   rep.Stats.AvgReviewScore,
			"foreshadow_open":    rep.Stats.ForeshadowOpen,
			"foreshadow_stale":   rep.Stats.ForeshadowStale,
		},
		"findings": findings,
		"runtime": map[string]any{
			"current_step": rc.CurrentStep,
			"stuck_step":   rc.StuckStep,
			"stuck_count":  rc.StuckCount,
			"log_errors":   rc.LogErrors,
			"log_warns":    rc.LogWarns,
			"stop_guard":   rc.StopGuard,
			"models":       models,
			"load_errors":  len(rc.Sources) > 0,
		},
		"planned_actions": len(rep.Actions),
	})
}

// handleDiagnosticsExport 导出脱敏诊断包（diag.Export 的固定产物）；
// output_path 由调用方经原生对话框选定，此处把脱敏产物复制过去。
// include 过滤器引擎不支持（脱敏分节固定），回显 unsupported_include。
func (d *Daemon) handleDiagnosticsExport(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	s := store.NewStore(p.host.Dir())
	path, err := diag.Export(s)
	if err != nil {
		return d.opFailed(req, err)
	}
	target := strings.TrimSpace(payloadString(req.Payload, "output_path"))
	if target != "" {
		if err := copyFile(path, target); err != nil {
			return d.opFailed(req, fmt.Errorf("copy diagnostics bundle to %s: %w", target, err))
		}
		path = target
	}
	rep, _ := diag.Diagnose(s)
	payload := map[string]any{"output_path": path, "sanitized": true, "findings": len(rep.Findings)}
	d.emitEvent(p.id, "diagnostics.completed", map[string]any{
		"findings": payload["findings"], "output_path": path,
	})
	return successResponse(req.ID, d.session, payload)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

// ── 用量 / 日志 / 队列 ──

func (d *Daemon) handleUsageSnapshot(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	snap := p.host.Snapshot()
	payload := usagePayload(snap)
	perAgent := make([]map[string]any, 0, len(snap.CachePerAgent))
	for _, a := range snap.CachePerAgent {
		perAgent = append(perAgent, map[string]any{
			"role": a.Role, "input": a.Input, "output": a.Output,
			"cache_read": a.CacheRead, "cache_write": a.CacheWrite,
			"cost_usd": a.Cost, "saved_usd": a.Saved,
		})
	}
	payload["per_agent"] = perAgent
	return successResponse(req.ID, d.session, payload)
}

// handleLogsReplay 重放 daemon 结构化日志环（after_sequence/limit/level 过滤）。
func (d *Daemon) handleLogsReplay(req *Request) *Response {
	after, hasAfter, err := payloadInt64(req.Payload, "after_sequence")
	if err != nil {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, err.Error(), nil)
	}
	if !hasAfter {
		after = 0
	}
	limit, hasLimit, err := payloadInt64(req.Payload, "limit")
	if err != nil {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, err.Error(), nil)
	}
	if hasLimit && limit < 1 {
		return errorResponse(req.ID, d.session, CodeInvalidPayload, "limit must be >= 1", nil)
	}
	level := strings.TrimSpace(payloadString(req.Payload, "level"))

	d.logMu.Lock()
	records := make([]logRecord, len(d.logs))
	copy(records, d.logs)
	lastSeq := d.logSeq
	d.logMu.Unlock()

	out := make([]logRecord, 0)
	for _, rec := range records {
		if rec.Seq <= after {
			continue
		}
		if level != "" && rec.Level != level && !looserLevel(rec.Level, level) {
			continue
		}
		if hasLimit && int64(len(out)) >= limit {
			break
		}
		out = append(out, rec)
	}
	return successResponse(req.ID, d.session, map[string]any{
		"records": out, "count": len(out), "last_sequence": lastSeq,
	})
}

// looserLevel 实现“最低严重级”过滤：请求 level=info 时 warn/error 也返回。
func looserLevel(rec, min string) bool {
	rank := map[string]int{"debug": 0, "info": 1, "warn": 2, "error": 3}
	r, okR := rank[rec]
	m, okM := rank[min]
	return okR && okM && r >= m
}

// handleRuntimeQueue 面向 ReplayQueue 的持久化运行队列投影（logs.replay 的伴生）。
func (d *Daemon) handleRuntimeQueue(req *Request) *Response {
	p, errResp := d.requireProject(req)
	if errResp != nil {
		return errResp
	}
	items, err := p.host.ReplayQueue(0)
	if err != nil {
		return d.opFailed(req, err)
	}
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		entry := map[string]any{
			"seq": item.Seq, "time": item.Time.Format("2006-01-02T15:04:05Z07:00"),
			"priority": string(item.Priority), "summary": item.Summary,
		}
		if item.Agent != "" {
			entry["agent"] = item.Agent
		}
		if item.Category != "" {
			entry["category"] = item.Category
		}
		out = append(out, entry)
	}
	return successResponse(req.ID, d.session, map[string]any{"items": out, "count": len(out)})
}
