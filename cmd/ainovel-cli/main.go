package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/voocel/ainovel-cli/assets"
	"github.com/voocel/ainovel-cli/internal/bootstrap"
	"github.com/voocel/ainovel-cli/internal/entry/desktop"
	"github.com/voocel/ainovel-cli/internal/entry/headless"
	"github.com/voocel/ainovel-cli/internal/entry/startup"
	"github.com/voocel/ainovel-cli/internal/entry/tui"
	"github.com/voocel/ainovel-cli/internal/eval"
	"github.com/voocel/ainovel-cli/internal/i18n"
	"github.com/voocel/ainovel-cli/internal/rules"
	buildversion "github.com/voocel/ainovel-cli/internal/version"
)

var (
	version = "dev"
	commit  = "unknown"
	date    = "unknown"
)

// headlessMode 记录本次是否 headless 启动，供 die 决定错误退出时是否暂停。
var headlessMode bool

func main() {
	// Initialize system locale detection early
	i18n.SetLanguage(i18n.DetectSystemLanguage())

	// 子命令在常规 flag 解析之前拦截：eval 是离线评测 harness，参数体系独立。
	if len(os.Args) > 1 && os.Args[1] == "eval" {
		os.Exit(eval.Command(os.Args[2:]))
	}

	opts, args, err := parseCLIOptions(os.Args[1:])
	if err != nil {
		die("flags: %v", err)
	}
	if opts.Language != "" {
		i18n.SetLanguage(opts.Language)
	}
	if opts.Version {
		buildversion.Print(os.Stdout, versionInfo())
		return
	}
	if opts.Update {
		if err := runSelfUpdate(opts.UpdateVersion); err != nil {
			fmt.Fprintf(os.Stderr, "update: %v\n", err)
			os.Exit(1)
		}
		return
	}
	headlessMode = opts.Headless

	// 桌面端 sidecar 模式：在首次引导之前拦截——绝不能把交互式 wizard
	// 拉进无终端的 stdin/stdout 协议流；缺失配置以结构化错误退出。
	if opts.DesktopDaemon {
		runDesktopDaemon(opts, args)
		return
	}

	// 首次引导
	if bootstrap.NeedsSetup() {
		if opts.Headless {
			die("error: %s", i18n.T("cli.err_headless_setup"))
		}
		setupCfg, err := bootstrap.RunSetup()
		if err != nil {
			die("setup: %v", err)
		}
		// 引导完成后使用生成的配置继续
		runWithConfig(setupCfg, opts, args)
		return
	}

	// 加载配置
	cfg, err := bootstrap.LoadConfig()
	if err != nil {
		die("config: %v", err)
	}

	runWithConfig(cfg, opts, args)
}

// die 统一处理致命错误退出：打印到 stderr、落盘到 ~/.ainovel/last-error.log，
// 并在交互式终端（非 headless）下暂停等待回车——双击启动时控制台会随进程退出
// 立即关闭，不暂停的话错误一闪而过，正是 issue #37 里用户无从排查的根因。
func die(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	fmt.Fprintln(os.Stderr, msg)
	if path := bootstrap.WriteStartupError(msg); path != "" {
		fmt.Fprintf(os.Stderr, "(%s)\n", fmt.Sprintf(i18n.T("errors.last_error_log"), path))
	}
	if !headlessMode && stdinIsTerminal() {
		fmt.Fprint(os.Stderr, "\n"+i18n.T("errors.pause_exit_prompt"))
		fmt.Fscanln(os.Stdin)
	}
	os.Exit(1)
}

// stdinIsTerminal 判断标准输入是否连接到终端（字符设备）。双击启动 / 交互式终端
// 为 true；管道、重定向、CI 为 false。零依赖近似，足够区分要不要暂停。
func stdinIsTerminal() bool {
	fi, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeCharDevice != 0
}

func runWithConfig(cfg bootstrap.Config, opts cliOptions, args []string) {
	rules.EnsureHomeRulesDir()

	if len(args) > 0 {
		die("error: %s", i18n.T("cli.err_no_cli_prompt"))
	}

	if opts.Language != "" {
		cfg.Language = opts.Language
	}
	if opts.StoryLanguage != "" {
		cfg.StoryLanguage = opts.StoryLanguage
	}

	// FillDefaults 必须先于资产加载:OutputDir 是运行时字段,默认值在此归一
	cfg.FillDefaults()
	i18n.SetLanguage(cfg.Language)

	loadOpts := assets.DefaultLoadOptions(cfg.OutputDir)
	loadOpts.StoryLanguage = cfg.StoryLanguage
	bundle := assets.Load(cfg.Style, loadOpts)
	if opts.Headless {
		prompt, err := loadPrompt(opts)
		if err != nil {
			die("error: %v", err)
		}
		if err := headless.Run(cfg, bundle, headless.Options{Prompt: prompt}); err != nil {
			die("error: %v", err)
		}
		return
	}
	if opts.Prompt != "" || opts.PromptFile != "" {
		die("error: %s", i18n.T("cli.err_headless_prompt_only"))
	}
	if err := tui.Run(cfg, bundle, versionInfo()); err != nil {
		die("error: %v", err)
	}
}

type cliOptions struct {
	Headless      bool
	Prompt        string
	PromptFile    string
	Language      string
	StoryLanguage string
	Version       bool
	Update        bool
	UpdateVersion string
	DesktopDaemon bool
}

// runDesktopDaemon 启动 desktop-v1 sidecar 协议循环（stdin/stdout NDJSON）。
// 配置加载与资产装配和 TUI/headless 同路径；stdout 从此只承载协议消息。
func runDesktopDaemon(opts cliOptions, args []string) {
	if len(args) > 0 {
		fmt.Fprintf(os.Stderr, "desktop-daemon: unexpected arguments: %v\n", args)
		os.Exit(1)
	}
	if bootstrap.NeedsSetup() {
		msg := "engine setup is missing: run the interactive TUI once to configure providers, then relaunch the desktop app"
		desktop.StartupError(os.Stdout, desktop.CodeOperationFailed, msg)
		fmt.Fprintln(os.Stderr, "desktop-daemon:", msg)
		os.Exit(1)
	}
	cfg, err := bootstrap.LoadConfig()
	if err != nil {
		desktop.StartupError(os.Stdout, desktop.CodeInvalidPayload, "load config: "+err.Error())
		fmt.Fprintf(os.Stderr, "desktop-daemon: config: %v\n", err)
		os.Exit(1)
	}
	if opts.Language != "" {
		cfg.Language = opts.Language
	}
	if opts.StoryLanguage != "" {
		cfg.StoryLanguage = opts.StoryLanguage
	}
	cfg.FillDefaults()
	i18n.SetLanguage(cfg.Language)

	loadOpts := assets.DefaultLoadOptions(cfg.OutputDir)
	loadOpts.StoryLanguage = cfg.StoryLanguage
	bundle := assets.Load(cfg.Style, loadOpts)

	if err := desktop.Run(desktop.Options{Config: cfg, Bundle: bundle}); err != nil {
		// Run 内部已按协议发过事件（engine.ready/exited）；此处不再向 stdout
		// 追加事件行，避免与 daemon 的 sequence 冲突，细节只落 stderr/文件。
		fmt.Fprintf(os.Stderr, "desktop-daemon: %v\n", err)
		_ = bootstrap.WriteStartupError(err.Error())
		os.Exit(1)
	}
}

// parseCLIOptions 提取 CLI flag，返回选项和剩余参数。
func parseCLIOptions(argv []string) (cliOptions, []string, error) {
	var opts cliOptions
	var args []string
	for i := 0; i < len(argv); i++ {
		switch argv[i] {
		case "--lang", "-l":
			if i+1 >= len(argv) {
				return opts, nil, errors.New(i18n.T("cli.err_lang_missing"))
			}
			opts.Language = i18n.NormalizeLanguage(argv[i+1])
			i++
		case "--story-lang":
			if i+1 >= len(argv) {
				return opts, nil, errors.New(i18n.T("cli.err_story_lang_missing"))
			}
			opts.StoryLanguage = i18n.NormalizeLanguage(argv[i+1])
			i++
		case "--version", "-v":
			opts.Version = true
		case "version":
			if i+1 < len(argv) {
				return opts, nil, errors.New("version " + i18n.T("cli.err_no_args"))
			}
			opts.Version = true
		case "update":
			if opts.Update {
				return opts, nil, errors.New("update " + i18n.T("cli.err_single_spec"))
			}
			opts.Update = true
			if i+1 < len(argv) {
				if strings.HasPrefix(argv[i+1], "-") {
					return opts, nil, errors.New("update " + i18n.T("cli.err_optional_version"))
				}
				opts.UpdateVersion = argv[i+1]
				i++
			}
			if i+1 < len(argv) {
				return opts, nil, errors.New("update " + i18n.T("cli.err_optional_version"))
			}
		case "--headless":
			opts.Headless = true
		case "--desktop-daemon":
			opts.DesktopDaemon = true
		case "--prompt":
			if i+1 >= len(argv) {
				return opts, nil, errors.New("--prompt " + i18n.T("cli.err_missing_val"))
			}
			opts.Prompt = argv[i+1]
			i++
		case "--prompt-file":
			if i+1 >= len(argv) {
				return opts, nil, errors.New("--prompt-file " + i18n.T("cli.err_missing_val"))
			}
			opts.PromptFile = argv[i+1]
			i++
		default:
			args = append(args, argv[i])
		}
	}
	if opts.Prompt != "" && opts.PromptFile != "" {
		return opts, nil, errors.New(i18n.T("cli.err_prompt_conflict"))
	}
	if opts.DesktopDaemon && (opts.Headless || opts.Prompt != "" || opts.PromptFile != "") {
		return opts, nil, errors.New("--desktop-daemon cannot be combined with --headless/--prompt/--prompt-file")
	}
	if opts.Version && (opts.Update || opts.Headless || opts.DesktopDaemon || opts.Prompt != "" || opts.PromptFile != "" || len(args) > 0) {
		return opts, nil, errors.New("version " + i18n.T("cli.err_no_mix"))
	}
	if opts.Update && (opts.Headless || opts.DesktopDaemon || opts.Prompt != "" || opts.PromptFile != "" || len(args) > 0) {
		return opts, nil, errors.New("update " + i18n.T("cli.err_no_mix"))
	}
	return opts, args, nil
}

func versionInfo() buildversion.Info {
	return buildversion.Resolve(buildversion.Info{
		Version: version,
		Commit:  commit,
		Date:    date,
	})
}

func runSelfUpdate(target string) error {
	info := versionInfo()
	result, err := buildversion.Update(context.Background(), buildversion.UpdateOptions{
		Repo:           buildversion.DefaultRepo,
		BinaryName:     "ainovel-cli",
		TargetVersion:  target,
		CurrentVersion: info.Version,
	})
	if err != nil {
		return err
	}
	if !result.Updated {
		fmt.Println(fmt.Sprintf(i18n.T("cli.update_is_latest"), result.Version))
		return nil
	}
	fmt.Println(fmt.Sprintf(i18n.T("cli.update_success"), result.Version))
	fmt.Println(fmt.Sprintf(i18n.T("cli.update_location"), result.Path))
	return nil
}

func loadPrompt(opts cliOptions) (string, error) {
	return loadPromptFrom(opts, os.Stdin)
}

func loadPromptFrom(opts cliOptions, stdin io.Reader) (string, error) {
	if opts.PromptFile == "" {
		return strings.TrimSpace(opts.Prompt), nil
	}

	if opts.PromptFile == "-" {
		data, err := io.ReadAll(stdin)
		if err != nil {
			return "", fmt.Errorf("%s: %w", i18n.T("errors.prompt_read_failed"), err)
		}
		return strings.TrimSpace(string(data)), nil
	}
	return startup.LoadPromptFile(opts.PromptFile)
}
