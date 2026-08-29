package version

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// roundTripFunc 把函数适配为 http.RoundTripper。生产代码固定请求 api.github.com，
// 测试经 Transport 拦截注入响应，不触网。
type roundTripFunc func(req *http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func httpResp(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(body)),
		Header:     make(http.Header),
	}
}

func releasePayload(tag, body string) string {
	b, err := json.Marshal(map[string]any{"tag_name": tag, "body": body, "assets": []any{}})
	if err != nil {
		panic(err)
	}
	return string(b)
}

func TestIsNewer(t *testing.T) {
	cases := []struct {
		latest, current string
		want            bool
	}{
		{"v1.2.4", "v1.2.3", true},
		{"v1.2.3", "v1.2.3", false},
		{"v1.2.2", "v1.2.3", false},   // 回退不提醒
		{"v1.3", "v1.2.9", true},      // 段数不同补零
		{"v2", "v1.9.9", true},
		{"1.2.4", "v1.2.3", true},     // v 前缀可省
		{"v1.2.3-rc1", "v1.2.2", false}, // pre-release 解析失败 → 保守不提醒
		{"nightly", "v1.0.0", false},
		{"", "v1.0.0", false},
		{"v1.2.4", "dev", false},      // dev 无版本语义
	}
	for _, c := range cases {
		if got := isNewer(c.latest, c.current); got != c.want {
			t.Fatalf("isNewer(%q, %q) = %v, want %v", c.latest, c.current, got, c.want)
		}
	}
}

func TestCheckUpdateDevSkipsNetwork(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return httpResp(200, releasePayload("v9.9.9", "notes")), nil
	})}
	res, err := CheckUpdate(context.Background(), CheckOptions{
		CurrentVersion: "dev",
		Client:         client,
	})
	if err != nil {
		t.Fatalf("CheckUpdate: %v", err)
	}
	if res.UpdateAvailable || calls != 0 {
		t.Fatalf("dev 构建应跳过检查: res=%+v calls=%d", res, calls)
	}
}

func TestCheckUpdateFetchesThenCaches(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return httpResp(200, releasePayload("v1.2.4", "## New Features\n* feat: x")), nil
	})}
	cachePath := filepath.Join(t.TempDir(), "update-check.json")
	opts := CheckOptions{CurrentVersion: "v1.2.3", Client: client, CachePath: cachePath}

	res, err := CheckUpdate(context.Background(), opts)
	if err != nil {
		t.Fatalf("first CheckUpdate: %v", err)
	}
	if !res.UpdateAvailable || res.Latest != "v1.2.4" || res.FromCache {
		t.Fatalf("first result = %+v", res)
	}
	if res.Notes == "" {
		t.Fatalf("release notes 应随结果带回")
	}
	if _, err := os.Stat(cachePath); err != nil {
		t.Fatalf("缓存未落盘: %v", err)
	}

	res2, err := CheckUpdate(context.Background(), opts)
	if err != nil {
		t.Fatalf("second CheckUpdate: %v", err)
	}
	if !res2.FromCache {
		t.Fatalf("第二次应命中缓存: %+v", res2)
	}
	if calls != 1 {
		t.Fatalf("缓存节流失效: 联网 %d 次, want 1", calls)
	}
}

func TestCheckUpdateCacheExpiry(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return httpResp(200, releasePayload("v1.2.4", "")), nil
	})}
	cachePath := filepath.Join(t.TempDir(), "update-check.json")
	// 距上次检查超过 MaxAge 的缓存应视为过期，重新联网。
	stale := checkCache{LastCheck: time.Now().Add(-2 * time.Hour), Latest: "v1.2.4"}
	if err := os.WriteFile(cachePath, mustJSON(stale), 0o644); err != nil {
		t.Fatalf("write stale cache: %v", err)
	}
	_, err := CheckUpdate(context.Background(), CheckOptions{
		CurrentVersion: "v1.2.3", Client: client, CachePath: cachePath, MaxAge: time.Hour,
	})
	if err != nil {
		t.Fatalf("CheckUpdate: %v", err)
	}
	if calls != 1 {
		t.Fatalf("过期缓存应触发联网: calls=%d", calls)
	}
}

func TestCheckUpdateStaleCacheFallback(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		return httpResp(500, "rate limited"), nil
	})}
	cachePath := filepath.Join(t.TempDir(), "update-check.json")
	stale := checkCache{LastCheck: time.Now().Add(-48 * time.Hour), Latest: "v1.2.4", Notes: "old notes"}
	if err := os.WriteFile(cachePath, mustJSON(stale), 0o644); err != nil {
		t.Fatalf("write stale cache: %v", err)
	}
	res, err := CheckUpdate(context.Background(), CheckOptions{
		CurrentVersion: "v1.2.3", Client: client, CachePath: cachePath,
	})
	if err != nil {
		t.Fatalf("网络失败应回退过期缓存: %v", err)
	}
	if !res.FromCache || !res.UpdateAvailable {
		t.Fatalf("fallback result = %+v", res)
	}
	if calls != 1 {
		t.Fatalf("应先尝试联网再回退: calls=%d", calls)
	}
}

func TestCheckUpdateErrorWithoutCache(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return httpResp(500, "boom"), nil
	})}
	_, err := CheckUpdate(context.Background(), CheckOptions{
		CurrentVersion: "v1.2.3",
		Client:         client,
		CachePath:      filepath.Join(t.TempDir(), "absent.json"),
	})
	if err == nil {
		t.Fatalf("无缓存且网络失败应返回 error 交调用方静默")
	}
}

func TestCheckUpdateMissingTag(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return httpResp(200, `{"assets": []}`), nil
	})}
	_, err := CheckUpdate(context.Background(), CheckOptions{
		CurrentVersion: "v1.2.3",
		Client:         client,
		CachePath:      filepath.Join(t.TempDir(), "absent.json"),
	})
	if err == nil {
		t.Fatalf("release 缺 tag_name 应报错")
	}
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
