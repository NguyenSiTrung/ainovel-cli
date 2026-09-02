package i18n

import (
	"embed"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

//go:embed locales/*.json
var localesFS embed.FS

const (
	LangVI = "vi"
	LangEN = "en"
	LangZH = "zh"

	DefaultLanguage = LangVI
)

var (
	mu          sync.RWMutex
	currentLang = DefaultLanguage
	catalogs    = make(map[string]map[string]string)
)

func init() {
	loadCatalogs()
}

func loadCatalogs() {
	entries, err := localesFS.ReadDir("locales")
	if err != nil {
		return
	}

	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		lang := strings.TrimSuffix(entry.Name(), ".json")
		data, err := localesFS.ReadFile("locales/" + entry.Name())
		if err != nil {
			continue
		}

		var raw map[string]any
		if err := json.Unmarshal(data, &raw); err != nil {
			continue
		}

		flat := make(map[string]string)
		flattenMap("", raw, flat)
		catalogs[lang] = flat
	}
}

func flattenMap(prefix string, src map[string]any, dest map[string]string) {
	for k, v := range src {
		key := k
		if prefix != "" {
			key = prefix + "." + k
		}
		switch val := v.(type) {
		case map[string]any:
			flattenMap(key, val, dest)
		case string:
			dest[key] = val
		default:
			dest[key] = fmt.Sprintf("%v", val)
		}
	}
}

// NormalizeLanguage standardizes locale codes to supported languages (vi, en, zh).
// Defaults to "vi".
func NormalizeLanguage(lang string) string {
	cleaned := strings.ToLower(strings.TrimSpace(lang))
	if cleaned == "" {
		return DefaultLanguage
	}

	// Remove charset like .UTF-8 or modifiers
	if idx := strings.IndexAny(cleaned, ".@"); idx != -1 {
		cleaned = cleaned[:idx]
	}

	// Normalize separators and trim whitespace
	cleaned = strings.ReplaceAll(cleaned, "-", "_")
	cleaned = strings.TrimSpace(cleaned)

	switch {
	case strings.HasPrefix(cleaned, "vi") || cleaned == "vietnamese" || cleaned == "tieng_viet" || cleaned == "tiengviet" || cleaned == "tiếng việt" || cleaned == "tiếng_việt" || cleaned == "vn" || cleaned == "vie" || cleaned == "viet":
		return LangVI
	case strings.HasPrefix(cleaned, "en") || cleaned == "english" || cleaned == "eng" || cleaned == "us" || cleaned == "gb":
		return LangEN
	case strings.HasPrefix(cleaned, "zh") || cleaned == "chinese" || cleaned == "zhongwen" || cleaned == "中文" || cleaned == "cmn" || cleaned == "zho" || cleaned == "chi" || cleaned == "cn" || cleaned == "tw":
		return LangZH
	default:
		return DefaultLanguage
	}
}

// SetLanguage sets the active UI language.
func SetLanguage(lang string) {
	mu.Lock()
	defer mu.Unlock()
	currentLang = NormalizeLanguage(lang)
}

// CurrentLanguage returns the active UI language code.
func CurrentLanguage() string {
	mu.RLock()
	defer mu.RUnlock()
	return currentLang
}

// SupportedLanguages returns the list of available languages.
func SupportedLanguages() []string {
	return []string{LangVI, LangEN, LangZH}
}

// LanguageName returns the localized display name of a language code.
func LanguageName(lang string) string {
	switch NormalizeLanguage(lang) {
	case LangVI:
		return "Tiếng Việt"
	case LangEN:
		return "English"
	case LangZH:
		return "中文"
	default:
		return "Tiếng Việt"
	}
}

// Has checks if a key exists in the current or fallback catalog.
func Has(key string) bool {
	mu.RLock()
	defer mu.RUnlock()

	if cat, ok := catalogs[currentLang]; ok {
		if _, exists := cat[key]; exists {
			return true
		}
	}
	if cat, ok := catalogs[DefaultLanguage]; ok {
		if _, exists := cat[key]; exists {
			return true
		}
	}
	return false
}

// T translates a key using the active language catalog and optional format arguments.
// If missing, it falls back to the default language, then returns the key itself.
func T(key string, args ...any) string {
	mu.RLock()
	defer mu.RUnlock()

	template := key
	if cat, ok := catalogs[currentLang]; ok {
		if val, exists := cat[key]; exists {
			template = val
		} else if currentLang != DefaultLanguage {
			if defCat, ok := catalogs[DefaultLanguage]; ok {
				if defVal, exists := defCat[key]; exists {
					template = defVal
				}
			}
		}
	} else if defCat, ok := catalogs[DefaultLanguage]; ok {
		if defVal, exists := defCat[key]; exists {
			template = defVal
		}
	}

	if len(args) == 0 {
		return template
	}

	return fmt.Sprintf(template, args...)
}
