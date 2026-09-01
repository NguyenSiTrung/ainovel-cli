package revision

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/voocel/agentcore"
	"github.com/voocel/ainovel-cli/internal/chapterfacts"
	"github.com/voocel/ainovel-cli/internal/domain"
	"github.com/voocel/ainovel-cli/internal/store"
)

type legacyCommit struct {
	chapter    int
	facts      domain.ChapterFacts
	acceptedAt time.Time
}

type legacyCommitArgs struct {
	Chapter int `json:"chapter"`
	domain.ChapterFacts
}

// MigrateLegacyBaseline 为 chapter_records 出现前创建的作品补齐接纳基线。
// 已有记录保持原样；缺失记录只使用成功提交中的章节事实和当时的草稿，
// 不会把可能已被用户修改的 chapters/*.md 静默当成已接纳版本。
func MigrateLegacyBaseline(st *store.Store) error {
	progress, err := st.Progress.Load()
	if err != nil {
		return fmt.Errorf("读取进度: %w", err)
	}
	if progress == nil || len(progress.CompletedChapters) == 0 {
		return nil
	}

	chapters := slices.Clone(progress.CompletedChapters)
	slices.Sort(chapters)
	records := make([]domain.ChapterRecord, 0, len(chapters))
	pending := make([]domain.ChapterRecord, 0)
	var commits map[int]legacyCommit
	for _, chapter := range chapters {
		record, err := st.ChapterRecords.Load(chapter)
		if err != nil {
			return err
		}
		if record != nil {
			records = append(records, *record)
			continue
		}

		if commits == nil {
			commits, err = loadLegacyCommits(st.Dir())
			if err != nil {
				return err
			}
		}
		migrated, err := buildLegacyRecord(st, chapter, commits)
		if err != nil {
			return err
		}
		records = append(records, migrated)
		pending = append(pending, migrated)
	}
	if err := ValidateRecords(records); err != nil {
		return fmt.Errorf("章节接纳记录无法形成一致基线: %w", err)
	}

	for _, record := range pending {
		if err := st.ChapterRecords.Save(record); err != nil {
			return fmt.Errorf("保存第 %d 章修订基线: %w", record.Chapter, err)
		}
	}
	return nil
}

func buildLegacyRecord(st *store.Store, chapter int, commits map[int]legacyCommit) (domain.ChapterRecord, error) {
	commit, ok := commits[chapter]
	if !ok {
		var err error
		commit, ok, err = loadLegacyImportCommit(st.Dir(), chapter)
		if err != nil {
			return domain.ChapterRecord{}, err
		}
	}
	if !ok {
		return domain.ChapterRecord{}, fmt.Errorf("第 %d 章缺少可验证的成功提交或导入分析记录，无法建立修订基线", chapter)
	}
	if err := chapterfacts.Validate(commit.facts); err != nil {
		return domain.ChapterRecord{}, fmt.Errorf("第 %d 章历史提交事实无效: %w", chapter, err)
	}
	draft, err := st.Drafts.LoadDraft(chapter)
	if err != nil {
		return domain.ChapterRecord{}, fmt.Errorf("读取第 %d 章历史草稿: %w", chapter, err)
	}
	if strings.TrimSpace(draft) == "" {
		return domain.ChapterRecord{}, fmt.Errorf("第 %d 章缺少历史草稿，无法确认已接纳正文", chapter)
	}
	if err := verifyLegacySummary(st, chapter, commit.facts); err != nil {
		return domain.ChapterRecord{}, err
	}
	acceptedAt := commit.acceptedAt
	if acceptedAt.IsZero() {
		if cp := st.Checkpoints.LatestByStep(domain.ChapterScope(chapter), "commit"); cp != nil {
			acceptedAt = cp.OccurredAt
		}
	}
	if acceptedAt.IsZero() {
		return domain.ChapterRecord{}, fmt.Errorf("第 %d 章成功提交记录缺少时间，无法建立修订基线", chapter)
	}
	content := domain.NormalizeChapterContent(draft)
	return domain.ChapterRecord{
		Version: domain.ChapterRecordVersion, Chapter: chapter, Revision: 1,
		Origin: domain.ChapterOriginGenerated, Content: content,
		ContentSHA256: domain.ChapterContentSHA256(content), Facts: commit.facts,
		AcceptedAt: acceptedAt,
	}, nil
}

func verifyLegacySummary(st *store.Store, chapter int, facts domain.ChapterFacts) error {
	summary, err := st.Summaries.LoadSummary(chapter)
	if err != nil {
		return fmt.Errorf("读取第 %d 章摘要: %w", chapter, err)
	}
	if summary == nil {
		return fmt.Errorf("第 %d 章缺少摘要，无法校验历史提交", chapter)
	}
	if summary.Title != facts.Title || summary.Summary != facts.Summary ||
		!slices.Equal(summary.Characters, facts.Characters) || !slices.Equal(summary.KeyEvents, facts.KeyEvents) {
		return fmt.Errorf("第 %d 章摘要与成功提交记录不一致，拒绝猜测迁移", chapter)
	}
	return nil
}

func loadLegacyCommits(dir string) (map[int]legacyCommit, error) {
	sessionsDir := filepath.Join(dir, "meta", "sessions", "agents")
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return map[int]legacyCommit{}, nil
		}
		return nil, fmt.Errorf("读取历史 Worker 会话: %w", err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	commits := make(map[int]legacyCommit)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "writer-") || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		path := filepath.Join(sessionsDir, entry.Name())
		if err := readLegacyCommits(path, commits); err != nil {
			return nil, err
		}
	}
	return commits, nil
}

func loadLegacyImportCommit(dir string, chapter int) (legacyCommit, bool, error) {
	path := filepath.Join(dir, "meta", "import", "analyses", fmt.Sprintf("%06d.json", chapter))
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return legacyCommit{}, false, nil
		}
		return legacyCommit{}, false, fmt.Errorf("读取第 %d 章历史导入分析: %w", chapter, err)
	}
	var artifact struct {
		Payload struct {
			Facts legacyCommitArgs `json:"facts"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(data, &artifact); err != nil {
		return legacyCommit{}, false, fmt.Errorf("解析第 %d 章历史导入分析: %w", chapter, err)
	}
	if artifact.Payload.Facts.Chapter != chapter {
		return legacyCommit{}, false, fmt.Errorf("第 %d 章历史导入分析的章号为 %d", chapter, artifact.Payload.Facts.Chapter)
	}
	return legacyCommit{chapter: chapter, facts: artifact.Payload.Facts.ChapterFacts}, true, nil
}

func readLegacyCommits(path string, commits map[int]legacyCommit) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	pending := make(map[string]legacyCommitArgs)
	reader := bufio.NewReader(f)
	for lineNo := 1; ; lineNo++ {
		line, readErr := reader.ReadBytes('\n')
		line = bytes.TrimSpace(line)
		if len(line) > 0 {
			var msg agentcore.Message
			if err := json.Unmarshal(line, &msg); err != nil {
				return fmt.Errorf("解析历史会话 %s:%d: %w", filepath.Base(path), lineNo, err)
			}
			for _, call := range msg.ToolCalls() {
				if call.Name != "commit_chapter" || call.ArgsInvalid || call.ID == "" {
					continue
				}
				var args legacyCommitArgs
				if err := json.Unmarshal(call.Args, &args); err != nil {
					return fmt.Errorf("解析历史会话 %s:%d 的 commit_chapter: %w", filepath.Base(path), lineNo, err)
				}
				pending[call.ID] = args
			}
			if msg.Role == agentcore.RoleTool {
				id, _ := msg.Metadata["tool_call_id"].(string)
				args, ok := pending[id]
				if ok {
					delete(pending, id)
					failed, _ := msg.Metadata["is_error"].(bool)
					if !failed && toolResultCommitted(msg.TextContent()) {
						candidate := legacyCommit{chapter: args.Chapter, facts: args.ChapterFacts, acceptedAt: msg.Timestamp}
						previous, exists := commits[args.Chapter]
						if !exists || previous.acceptedAt.IsZero() || !candidate.acceptedAt.Before(previous.acceptedAt) {
							commits[args.Chapter] = candidate
						}
					}
				}
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				return nil
			}
			return fmt.Errorf("读取历史会话 %s: %w", filepath.Base(path), readErr)
		}
	}
}

func toolResultCommitted(text string) bool {
	var result struct {
		Committed bool `json:"committed"`
	}
	if json.Unmarshal([]byte(text), &result) == nil {
		return result.Committed
	}
	var quoted string
	return json.Unmarshal([]byte(text), &quoted) == nil && json.Unmarshal([]byte(quoted), &result) == nil && result.Committed
}
