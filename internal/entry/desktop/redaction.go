// redaction.go —— 协议出参脱敏：密钥绝不上协议（desktop-v1 README §8）。
//
// 三层防线：
//  1. 结构化字段名命中敏感键（api_key/token/...）→ 值整体遮蔽；
//  2. 自由文本中的常见凭证形态（sk-…、Bearer …、长 base64/hex 串）→ 保留首尾遮中段；
//  3. provider 元数据走 Host.ModelConfiguration（本就只带 api_key_hint）。
package desktop

import (
	"regexp"
	"strings"

	"github.com/voocel/ainovel-cli/internal/host"
)

// secretKeys 是命中即遮蔽值（大小写不敏感）的字段名集合。
var secretKeys = map[string]struct{}{
	"api_key": {}, "apikey": {}, "key": {}, "token": {}, "access_token": {},
	"refresh_token": {}, "secret": {}, "client_secret": {}, "password": {},
	"authorization": {}, "auth": {}, "credential": {}, "credentials": {},
	"access_key": {}, "session_key": {}, "private_key": {},
}

// bearerRe 匹配 "Bearer <token>" / "Authorization: ..." 形态。
var bearerRe = regexp.MustCompile(`(?i)\b(bearer|basic)\s+([A-Za-z0-9._~+/=-]{12,})`)

// kvSecretRe 匹配 key=value / "key": "value" 形态里的敏感值。
var kvSecretRe = regexp.MustCompile(`(?i)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)\b(\s*[:=]\s*)("[^"]{8,}"|'[^']{8,}'|\S{8,})`)

// skTokenRe 匹配常见服务前缀凭证（sk-…、ghp_…、xox…、AKIA…、glpat-…）。
var skTokenRe = regexp.MustCompile(`\b((?:sk|rk)-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|glpat-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{30,})`)

// longTokenRe 匹配孤立的超长 base64/hex 串（≥40 字符，独立词）。
var longTokenRe = regexp.MustCompile(`\b[A-Za-z0-9+/_-]{40,}={0,2}\b`)

// redactString 对自由文本做凭证形态遮蔽，复用 host.MaskAPIKey 的首尾保留策略。
func redactString(s string) string {
	if s == "" {
		return s
	}
	s = skTokenRe.ReplaceAllStringFunc(s, host.MaskAPIKey)
	s = bearerRe.ReplaceAllStringFunc(s, func(m string) string {
		groups := bearerRe.FindStringSubmatch(m)
		if len(groups) < 3 {
			return m
		}
		return groups[1] + " " + host.MaskAPIKey(groups[2])
	})
	s = kvSecretRe.ReplaceAllStringFunc(s, func(m string) string {
		groups := kvSecretRe.FindStringSubmatch(m)
		if len(groups) < 4 {
			return m
		}
		quoted := groups[3]
		var masked string
		if len(quoted) >= 2 && (quoted[0] == '"' || quoted[0] == '\'') {
			masked = string(quoted[0]) + host.MaskAPIKey(quoted[1:len(quoted)-1]) + string(quoted[len(quoted)-1])
		} else {
			masked = host.MaskAPIKey(quoted)
		}
		return groups[1] + groups[2] + masked
	})
	s = longTokenRe.ReplaceAllStringFunc(s, func(m string) string {
		// 只遮“像密钥”的独立长串；普通长词（URL 路径段等含 '/' 的已排除在字符集外）。
		if strings.ContainsAny(m, "://") {
			return m
		}
		return host.MaskAPIKey(m)
	})
	return s
}

// redactValue 递归遮蔽任意 JSON 值中的敏感字段与凭证形态字符串。
func redactValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, val := range t {
			if isSecretKey(k) {
				out[k] = maskWholeValue(val)
				continue
			}
			out[k] = redactValue(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = redactValue(val)
		}
		return out
	case string:
		return redactString(t)
	default:
		return v
	}
}

// redactPayload 返回脱敏后的载荷副本（不修改原 map）。
func redactPayload(p map[string]any) map[string]any {
	if p == nil {
		return nil
	}
	out := make(map[string]any, len(p))
	for k, v := range p {
		if isSecretKey(k) {
			out[k] = maskWholeValue(v)
			continue
		}
		out[k] = redactValue(v)
	}
	return out
}

func isSecretKey(k string) bool {
	_, ok := secretKeys[strings.ToLower(strings.TrimSpace(k))]
	return ok
}

// maskWholeValue 把敏感字段的值替换为 "<redacted>"（布尔保持原值：
// has_api_key=true 不泄密且有信息量；字符串/数字一律遮蔽）。
func maskWholeValue(v any) any {
	switch t := v.(type) {
	case bool:
		return t
	case nil:
		return nil
	default:
		return "<redacted>"
	}
}
