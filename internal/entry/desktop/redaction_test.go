// redaction_test.go —— 密钥绝不上协议（desktop-v1 README §8）。
package desktop

import (
	"strings"
	"testing"
)

func TestRedactStringMasksTokenShapes(t *testing.T) {
	cases := []struct {
		in, mustNotContain string
	}{
		{"auth failed for sk-abcdef1234567890abcdef", "sk-abcdef1234567890abcdef"},
		{"Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig"},
		{"api_key=\"ghp_0123456789abcdefghijklmnopqrstuvwxyz\"", "ghp_0123456789abcdefghijklmnopqrstuvwxyz"},
		{"api_key=AKIAIOSFODNN7EXAMPLE1234", "AKIAIOSFODNN7EXAMPLE1234"},
		{"token: 8fd4a1b0c2e34f56a7b8c9d0e1f2a3b4c5d6e7f8", "8fd4a1b0c2e34f56a7b8c9d0e1f2a3b4c5d6e7f8"},
	}
	for _, tc := range cases {
		out := redactString(tc.in)
		if strings.Contains(out, tc.mustNotContain) {
			t.Fatalf("泄露: %q → %q", tc.in, out)
		}
	}
}

func TestRedactStringKeepsOrdinaryText(t *testing.T) {
	plain := "provider openai model gpt-5: 429 rate limited, retry in 30s"
	if got := redactString(plain); got != plain {
		t.Fatalf("普通错误文案不应被改写: %q", got)
	}
	url := "GET https://api.example.com/v1/chat 500 internal server error"
	if got := redactString(url); !strings.Contains(got, "api.example.com") {
		t.Fatalf("URL 不应被整体遮蔽: %q", got)
	}
}

func TestRedactPayloadMasksSecretKeys(t *testing.T) {
	in := map[string]any{
		"provider":     "openai",
		"api_key":      "sk-supersecret123456",
		"has_api_key":  true,
		"nested":       map[string]any{"access_token": "tok-0123456789abcdef", "name": "demo"},
		"list":         []any{map[string]any{"refresh_token": "rt-0123456789abcdef"}},
		"normal_value": "keep me",
	}
	out := redactPayload(in)
	if out["api_key"] != "<redacted>" {
		t.Fatalf("api_key 应整体遮蔽: %v", out["api_key"])
	}
	if out["has_api_key"] != true {
		t.Fatalf("布尔标志应保留: %v", out["has_api_key"])
	}
	nested := out["nested"].(map[string]any)
	if nested["access_token"] != "<redacted>" || nested["name"] != "demo" {
		t.Fatalf("嵌套脱敏错误: %v", nested)
	}
	list := out["list"].([]any)
	if list[0].(map[string]any)["refresh_token"] != "<redacted>" {
		t.Fatalf("列表内脱敏错误: %v", list)
	}
	if out["normal_value"] != "keep me" || out["provider"] != "openai" {
		t.Fatalf("非敏感字段应原样保留: %v", out)
	}
	// 原 map 不被修改。
	if in["api_key"] != "sk-supersecret123456" {
		t.Fatal("redactPayload 不应修改原 payload")
	}
}

func TestMaskWholeValueNonString(t *testing.T) {
	if maskWholeValue(42) != "<redacted>" || maskWholeValue(nil) != nil || maskWholeValue(false) != false {
		t.Fatal("数字遮蔽、nil 保持、布尔保持")
	}
}

func TestIsSecretKey(t *testing.T) {
	for _, k := range []string{"API_KEY", "api_key", " ApiKey ", "access_token", "Authorization"} {
		if !isSecretKey(k) {
			t.Fatalf("%q 应视为敏感键", k)
		}
	}
	for _, k := range []string{"model", "provider", "name", "context_window"} {
		if isSecretKey(k) {
			t.Fatalf("%q 不应视为敏感键", k)
		}
	}
}
