# ainovel-cli

<p align="center">
  <a href="README.md">English</a> |
  <a href="README_VI.md">Tiếng Việt</a> |
  <b>中文</b>
</p>

全自动 AI 长篇小说创作引擎。确定性引擎跑完整本书，模型在每个需要判断的位置被精确使用：Engine 按事实路由驱动 Architect / Writer / Editor 三个自主创作代理，语义裁定按需唤醒 Arbiter。从一句话需求到完整小说，全程无需人工干预。

<p align="center">
  <img src="scripts/sample.gif" alt="ainovel-cli demo" width="800">
  <img src="scripts/novel.png" alt="ainovel-cli bg" width="800">
</p>

## 特性

- **确定性引擎 + 多智能体协作** — Engine 按事实决策表调度 Architect / Writer / Editor 三个自主创作代理，主循环零 LLM 开销、行为可穷举测试
- **多语言原生支持** — 界面原生支持 Vietnamese (vi), English (en), Chinese (zh)；小说创作语言支持 `--story-lang vi` (内置自然流畅越南语防机翻指令), `en`, `zh`
- **语义裁定可审计** — 选规划师、干预分诊、失败出路等判断由 Arbiter 单次调用完成，每次裁定落盘可回放。越简单越稳定，拒绝复杂编排
- **Step 级断点恢复** — 每个工具执行成功后写入 checkpoint，崩溃后精确到 plan/draft/check/commit 步骤级恢复
- **卷弧双层滚动规划** — 长篇不再一次性规划全部章节。初始只规划前 2 卷弧骨架 + 第 1 弧详细章节，后续弧/卷在写作推进到时再由 Architect 展开，每次展开都参考前文摘要和角色状态，远期规划不空洞
- **相关章节智能推荐** — 每章写作时从伏笔、角色出场、状态变化、关系四个维度自动推荐相关历史章节，配合下一章预告，确保 500+ 章长篇的连续性
- **自适应上下文策略** — 根据总章节数自动切换全量 / 滑窗 / 分层摘要，支持 500+ 章长篇
- **七维质量评审** — Editor 从设定一致性、角色行为、节奏、叙事连贯、伏笔、钩子、审美品质七个维度评审，审美维度细分描写质感/叙事手法/对话区分度/用词质量/情感打动力五项，每项必须引用原文举证
- **用户实时干预（Steer）** — 写作过程中随时在输入框注入修改意见（无需暂停），系统自动评估影响范围并重写受影响章节
- **可选逐章验收** — 默认仍全自动；需要精细控制时用 `/review on`，每次 `/next` 只放行一个新章节，返工和崩溃恢复不会误消耗许可
- **语义小说导入与逆向** — `/import` 可将外部 TXT 语义切分、提取事实并构建大纲与角色库，无缝接力续写
- **仿写画像（Simulation）** — `/simulate` 读取参考范文，提取文风、用词偏好、情节密度与钩子设计
- **手动修改接纳（Sync）** — 人工修改已完成章节后，`/sync` 自动重构事实网络与后续规划
- **多格式导出** — `/export` 一键将全书或指定章节导出为标准 TXT 或 EPUB
- **TUI + Headless 双入口** — 既可在交互界面实时观察和干预，也可在服务器、NAS 或 CI 中无界面持续运行
- **多 LLM 支持** — OpenRouter / Anthropic / Gemini / OpenAI / DeepSeek / Ollama 等随意切换，支持角色级模型路由与推理强度配置

## 架构

核心设计：**事实层确定，语义层自主**。可枚举的状态迁移由确定性代码执行（Engine + Route）；边界清晰的判断按需咨询 LLM 函数（Arbiter）；开放式创作交给自主的 LLM 循环（Workers）。

```
┌─────────────────────────────────────────────────┐
│              Host / Engine（确定性）              │
│  读 Store → Route → 直接运行 Worker → 循环        │
│  启动裁定 / 干预分诊 / 失败僵局 → 按需咨询 Arbiter  │
└────┬──────────┬──────────┬─────────────┬────────┘
     │          │          │             │
 ┌───▼────┐ ┌───▼───┐ ┌────▼────┐   ┌────▼────┐
 │Architect│ │Writer │ │ Editor  │   │ Arbiter │
 │(LLM循环)│ │(LLM循环)│ │(LLM循环)│   │(LLM函数)│
 └───┬────┘ └───┬───┘ └────┬────┘   └─────────┘
     └──────────┼──────────┘
                │ 工具调用（IO + checkpoint）
┌───────────────▼─────────────────────────────────┐
│                   Store                         │
│  Progress / Checkpoint / Outline / Drafts / ... │
└─────────────────────────────────────────────────┘
```

- **Engine** — 每轮从 Store 读事实、按 Route 决策表派发 Worker，执行决定、不参与文学判断
- **Arbiter** — 按需唤醒的语义裁定（选规划师、用户干预分诊、失败/僵局出路），事实进、结构化决策出
- **Workers** — Architect / Writer / Editor 各自独立 context 的自主创作循环
- **Tools** — 单文件原子 IO + 幂等重放；章节提交使用持久化 Saga + checkpoint

### 智能体职责

| 角色 | 职责 | 工具 |
|--------|------|------|
| **Arbiter** | 语义裁定：启动选规划师、用户干预分诊、失败/僵局出路 | 无（单次 LLM 调用，输出结构化决策） |
| **Architect** | 生成书名、小说简介、前提、大纲、角色档案、世界规则 | `novel_context` `save_book` `save_foundation` |
| **Writer** | 自主完成一章的构思、写作、自审和提交 | `novel_context` `read_chapter` `plan_chapter` `draft_chapter` `check_consistency` `commit_chapter` |
| **Editor** | 阅读原文，从结构和审美两个层面审阅 | `novel_context` `read_chapter` `save_review` `save_arc_summary` `save_volume_summary` |

## 快速开始

```bash
# 一键安装（macOS / Linux，无需 Go）
curl -fsSL https://raw.githubusercontent.com/voocel/ainovel-cli/main/scripts/install.sh | sh

# 或通过 Go 安装
go install github.com/voocel/ainovel-cli/cmd/ainovel-cli@latest

# 查看版本 / 更新到最新版本
ainovel-cli --version
ainovel-cli update

# 首次运行，自动进入引导流程（选择 Provider → 输入 API Key → Base URL → 模型名）
ainovel-cli
```

### 命令行选项

```bash
# 指定界面语言
ainovel-cli --lang vi    # 越南语 (默认)
ainovel-cli --lang en    # 英语
ainovel-cli --lang zh    # 中文

# 指定小说创作语言
ainovel-cli --story-lang vi    # 越南语创作 (默认)
ainovel-cli --story-lang en    # 英语创作
ainovel-cli --story-lang zh    # 中文创作

# Headless 模式（适合服务器/自动化后台）
ainovel-cli --headless --prompt "写一本东方玄幻长篇，主角从边陲小城起步"
ainovel-cli --headless --prompt-file prompt.txt
```

### TUI 常用斜杠命令

| 命令 | 说明 |
|---|---|
| `/help` | 查看帮助与快捷键 |
| `/model [role]` | 交互式切换全局或指定角色（Architect/Writer/Editor）的 Provider、模型与推理强度 |
| `/config` | 配置 UI/创作语言、Provider 凭证库、模型列表与系统参数 |
| `/diag` | 诊断小说创作健康度并生成脱敏排查报告 |
| `/review on\|off` | 开启或关闭逐章验收模式 |
| `/next` | 验收模式下放行下一章节创作 |
| `/start <path>` | 从大纲/设定文件创建新书 |
| `/import <path>` | 语义导入外部小说并逆向大纲/角色/设定 |
| `/reopen [方向]` | 重开已完结的小说继续续写新卷 |
| `/cocreate` | 暂停创作，进入阶段共创规划 |
| `/simulate` | 分析 `./simulate` 目录下的参考小说并提取仿写画像 |
| `/importsim <file>` | 导入已有仿写画像 JSON |
| `/sync [--check]` | 检查或接纳人工修改的章节内容，重建事实库 |
| `/export [path]` | 导出已完成章节为 TXT 或 EPUB 格式 |

## License

MIT
