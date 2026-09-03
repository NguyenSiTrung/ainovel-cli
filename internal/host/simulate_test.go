package host

import (
	"path/filepath"
	"testing"
)

// TestSimulateSourceDirDefault：零选项必须保持历史默认（<wd>/simulate），
// 保证 TUI 等现有 Simulate(ctx) 调用方行为不变。
func TestSimulateSourceDirDefault(t *testing.T) {
	got := SimulateSourceDir()
	want := filepath.Join("simulate")
	if filepath.Base(got) != want {
		t.Fatalf("default source dir should end in %q, got %q", want, got)
	}
	if !filepath.IsAbs(got) {
		t.Fatalf("default source dir should resolve to an absolute path, got %q", got)
	}
}

// TestSimulateSourceDirOverride：显式目录优先；空串视为未指定（回默认）；
// nil 选项安全跳过；多选项后者胜。
func TestSimulateSourceDirOverride(t *testing.T) {
	if got := SimulateSourceDir(WithSimulateSource("/data/corpus")); got != "/data/corpus" {
		t.Fatalf("override not honored: %q", got)
	}
	if got := SimulateSourceDir(WithSimulateSource("  ")); filepath.Base(got) != "simulate" {
		t.Fatalf("blank override should fall back to default, got %q", got)
	}
	if got := SimulateSourceDir(nil, WithSimulateSource("/a"), WithSimulateSource("/b")); got != "/b" {
		t.Fatalf("last option should win, got %q", got)
	}
	if got := SimulateSourceDir(nil); filepath.Base(got) != "simulate" {
		t.Fatalf("nil option should be skipped, got %q", got)
	}
}
