package host

import (
	"os"
	"path/filepath"
	"strings"
)

// simulateOptions 承载一次仿写画像生成的可选项。
type simulateOptions struct {
	sourceDir string // 仿写语料目录；空 = 默认 <进程工作目录>/simulate
}

// SimulateOption 配置一次 Host.Simulate（可选参数，零选项保持既有行为，
// TUI 等现有调用方 Simulate(ctx) 不受影响）。
type SimulateOption func(*simulateOptions)

// WithSimulateSource 指定仿写语料目录（建议绝对路径）。桌面端 sidecar 用它把
// 用户经原生对话框选定的语料目录/文件交给引擎，而不是依赖进程工作目录。
func WithSimulateSource(dir string) SimulateOption {
	return func(o *simulateOptions) {
		o.sourceDir = strings.TrimSpace(dir)
	}
}

// SimulateSourceDir 解析一组选项的语料目录：显式指定优先，否则回退到
// <进程工作目录>/simulate（Host.Simulate 的历史默认）。Host.Simulate 与
// 调用方（如桌面 daemon 的预检/回显）共用这一条解析路径。
func SimulateSourceDir(opts ...SimulateOption) string {
	var o simulateOptions
	for _, opt := range opts {
		if opt != nil {
			opt(&o)
		}
	}
	if o.sourceDir != "" {
		return o.sourceDir
	}
	if wd, err := os.Getwd(); err == nil {
		return filepath.Join(wd, "simulate")
	}
	return filepath.Join("simulate")
}
