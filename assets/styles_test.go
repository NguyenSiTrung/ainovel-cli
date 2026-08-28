package assets

import (
	"strings"
	"testing"
)

func TestVietnameseStylePresets(t *testing.T) {
	b := Load("default", LoadOptions{})

	requiredStyles := []struct {
		key     string
		keyword string
	}{
		{"tienhiep", "Tiên Hiệp"},
		{"kiemhiep", "Kiếm Hiệp"},
		{"dothi", "Đô Thị"},
		{"ngontinh", "Ngôn Tình"},
		{"trinhtham", "Trinh Thám"},
		{"default", "通用写作风格"},
		{"fantasy", "奇幻冒险风格"},
		{"romance", "言情风格"},
		{"suspense", "悬疑推理风格"},
	}

	for _, tt := range requiredStyles {
		t.Run(tt.key, func(t *testing.T) {
			content, exists := b.Styles[tt.key]
			if !exists {
				t.Fatalf("style %q missing from loaded bundle styles: %+v", tt.key, b.Styles)
			}
			if !strings.Contains(content, tt.keyword) {
				t.Fatalf("style %q content does not contain %q, got: %s", tt.key, tt.keyword, content)
			}
		})
	}
}
