package i18n

import (
	"os"
	"strings"
)

// DetectFromEnvWithLookup scans environment variables using a custom lookup func.
func DetectFromEnvWithLookup(lookup func(string) string) string {
	envVars := []string{
		"AINOVEL_LANG",
		"LC_ALL",
		"LC_MESSAGES",
		"LANGUAGE",
		"LANG",
	}

	for _, v := range envVars {
		val := strings.TrimSpace(lookup(v))
		if val == "" {
			continue
		}
		// If LANGUAGE has multiple like "zh_TW:zh_CN:en", take first item
		if strings.Contains(val, ":") {
			parts := strings.Split(val, ":")
			if len(parts) > 0 && strings.TrimSpace(parts[0]) != "" {
				val = parts[0]
			}
		}
		norm := NormalizeLanguage(val)
		if norm != "" {
			return norm
		}
	}

	return DefaultLanguage
}

// DetectSystemLanguage inspects environment variables and OS locale to identify the preferred language.
func DetectSystemLanguage() string {
	return DetectFromEnvWithLookup(os.Getenv)
}
