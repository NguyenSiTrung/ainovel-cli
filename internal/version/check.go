package version

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// DefaultRepo 是版本检查与自更新默认指向的上游仓库。
const DefaultRepo = "voocel/ainovel-cli"

// DefaultCheckInterval 是两次联网检查之间的最小间隔。GitHub 匿名 API 限流
// 60 req/h，且发版节奏是天级，更频繁的检查只有打扰没有收益。
const DefaultCheckInterval = 24 * time.Hour

// CheckOptions 是一次版本检查的输入。CachePath 由调用方传入（通常为
// 配置目录下的 update-check.json）；本包不依赖 bootstrap，保持 version
// 作为叶子包的依赖方向。
type CheckOptions struct {
	Repo           string
	CurrentVersion string
	Client         *http.Client
	CachePath      string        // 空 = 不落盘，每次调用都联网
	MaxAge         time.Duration // 缓存有效期；<=0 取 DefaultCheckInterval
}

// CheckResult 是版本检查的结论。Notes 携带 release 原文（markdown），
// 供调用方在详情面板展示"更新了什么"，升级与否由用户决定。
type CheckResult struct {
	Latest          string
	Current         string
	Notes           string
	UpdateAvailable bool
	FromCache       bool
}

// checkCache 是 CachePath 的落盘结构。损坏或残缺的缓存视为不存在
//（下次启动重新联网），不构成错误。
type checkCache struct {
	LastCheck time.Time `json:"last_check"`
	Latest    string    `json:"latest"`
	Notes     string    `json:"notes"`
}

// CheckUpdate 查询上游最新 release 并判断是否需要提醒升级。只读不写任何
// 二进制；是否升级、何时升级完全由用户经 `ainovel-cli update` 决定。
// 网络失败时回退过期缓存（旧提醒好过没有）；完全无数据返回 error，由调用方静默。
func CheckUpdate(ctx context.Context, opts CheckOptions) (*CheckResult, error) {
	current := Normalize(opts.CurrentVersion)
	if current == "dev" {
		// 本地构建没有可比较的版本语义，跳过检查避免把任意构建误报成"可升级"。
		return &CheckResult{Current: current}, nil
	}
	repo := strings.TrimSpace(opts.Repo)
	if repo == "" {
		repo = DefaultRepo
	}
	maxAge := opts.MaxAge
	if maxAge <= 0 {
		maxAge = DefaultCheckInterval
	}

	var stale *checkCache
	if opts.CachePath != "" {
		if c, ok := loadCache(opts.CachePath); ok {
			if time.Since(c.LastCheck) <= maxAge {
				return c.result(current), nil
			}
			stale = c // 过期但结构完整：留作网络失败的兜底
		}
	}

	client := opts.Client
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Second}
	}
	rel, err := fetchRelease(ctx, client, repo, "latest")
	if err != nil {
		if stale != nil {
			return stale.result(current), nil
		}
		return nil, err
	}
	if rel.TagName == "" {
		if stale != nil {
			return stale.result(current), nil
		}
		return nil, fmt.Errorf("release 缺少 tag_name")
	}

	// 缓存写失败只影响下次节流，本次结果照常返回。
	_ = writeCache(opts.CachePath, rel)
	return &CheckResult{
		Latest:          rel.TagName,
		Current:         current,
		Notes:           rel.Body,
		UpdateAvailable: isNewer(rel.TagName, current),
	}, nil
}

// loadCache 读取并解析缓存；文件不存在、损坏或字段残缺一律视为无缓存。
func loadCache(path string) (*checkCache, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, false
	}
	var c checkCache
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, false
	}
	if c.Latest == "" || c.LastCheck.IsZero() {
		return nil, false
	}
	return &c, true
}

// result 把缓存内容转换为检查结论（FromCache=true）。
func (c *checkCache) result(current string) *CheckResult {
	return &CheckResult{
		Latest:          c.Latest,
		Current:         current,
		Notes:           c.Notes,
		UpdateAvailable: isNewer(c.Latest, current),
		FromCache:       true,
	}
}

// writeCache 落盘本次检查结果。目录不存在则创建；缓存丢失只意味着下次多一次联网。
func writeCache(path string, rel *release) error {
	if path == "" {
		return nil
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	data, err := json.Marshal(checkCache{LastCheck: time.Now(), Latest: rel.TagName, Notes: rel.Body})
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// isNewer 判断 latest 是否语义上新于 current。两边剥 "v" 前缀后按 "." 分段
// 做数字比较，短的一方补零。任一段无法解析为非负整数（含 pre-release 后缀
// 如 1.2.3-rc1）时保守返回 false——宁可漏提醒，不误提醒。
func isNewer(latest, current string) bool {
	a, ok := parseSemver(latest)
	if !ok {
		return false
	}
	b, ok := parseSemver(current)
	if !ok {
		return false
	}
	n := max(len(a), len(b))
	for i := 0; i < n; i++ {
		x, y := 0, 0
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

func parseSemver(v string) ([]int, bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if v == "" {
		return nil, false
	}
	parts := strings.Split(v, ".")
	nums := make([]int, 0, len(parts))
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return nil, false
		}
		nums = append(nums, n)
	}
	return nums, true
}
