# ainovel-cli

<p align="center">
  <b>English</b> |
  <a href="README_VI.md">Tiếng Việt</a> |
  <a href="README_ZH.md">中文</a>
</p>

<p align="center">
  <strong>Fully autonomous AI long-form novel creation engine.</strong><br>
  A deterministic state machine coordinates autonomous agents (Architect, Writer, Editor) with semantic arbitration (Arbiter), guiding your story from a single prompt to a finished multi-volume novel without human intervention.
</p>

<p align="center">
  <img src="scripts/sample.gif" alt="ainovel-cli demo" width="800">
  <img src="scripts/novel.png" alt="ainovel-cli bg" width="800">
</p>

---

## Table of Contents

- [Key Features](#key-features)
- [Architecture & Workflow](#architecture--workflow)
  - [Core Principles](#core-principles)
  - [Agent Roles](#agent-roles)
  - [Chapter Writing Loop](#chapter-writing-loop)
  - [Rolling Long-Form Planning](#rolling-long-form-planning)
  - [Hierarchical Context Management](#hierarchical-context-management)
- [Quick Start](#quick-start)
  - [Installation](#installation)
  - [Initial Setup](#initial-setup)
  - [CLI Flags](#cli-flags)
  - [Headless Mode (Server / CI / Automation)](#headless-mode-server--ci--automation)
  - [Docker & Docker Compose](#docker--docker-compose)
- [Interactive TUI & Slash Commands](#interactive-tui--slash-commands)
- [Configuration Guide](#configuration-guide)
  - [Configuration File Resolution](#configuration-file-resolution)
  - [Example Configuration](#example-configuration)
  - [Role-Based Model Routing & Fallbacks](#role-based-model-routing--fallbacks)
  - [Custom API Proxies & Gateways](#custom-api-proxies--gateways)
- [Advanced Features](#advanced-features)
  - [Semantic Novel Import & Reverse-Engineering (`/import`)](#semantic-novel-import--reverse-engineering-import)
  - [Style Simulation & Profile Extraction (`/simulate`)](#style-simulation--profile-extraction-simulate)
  - [Manual Human Revision Sync (`/sync`)](#manual-human-revision-sync-sync)
  - [Interactive Chapter Review Gate (`/review`)](#interactive-chapter-review-gate-review)
  - [Real-Time Steer & User Intervention](#real-time-steer--user-intervention)
  - [Multi-Format Book Export (`/export`)](#multi-format-book-export-export)
  - [Voice Layer & Custom Style Presets](#voice-layer--custom-style-presets)
  - [Anti-AI Tone & Custom User Rules](#anti-ai-tone--custom-user-rules)
  - [Diagnostics & Health Check (`/diag`)](#diagnostics--health-check-diag)
  - [Budget Safeguards & Unattended Notifications](#budget-safeguards--unattended-notifications)
  - [Offline Evaluation Harness (`eval`)](#offline-evaluation-harness-eval)
- [Output Directory Structure](#output-directory-structure)
- [Crash Recovery & Persistence](#crash-recovery--persistence)
- [Tech Stack](#tech-stack)
- [License](#license)

---

## Key Features

- **Deterministic Engine + Autonomous Multi-Agent Collaboration**: Zero-LLM dispatch loop driven by a finite state machine. The Engine executes code-based routing while granting autonomous creative freedom to `Architect`, `Writer`, and `Editor`.
- **Native Multilingual Storytelling (i18n)**:
  - **UI Localization**: Native support for **Vietnamese (`vi`)**, **English (`en`)**, and **Chinese (`zh`)**.
  - **Story Language (`--story-lang`)**: Generate full novels in **Vietnamese** (with built-in anti-translation directives ensuring natural vocabulary, authentic dialogue, and rich literary flow), **English**, or **Chinese**.
- **Auditable Semantic Arbiter**: High-stakes decisions (planner selection, user intervention triage, deadlock recovery) are evaluated via single-shot structured LLM calls with audit logging in `meta/decisions.jsonl`.
- **Step-Level Checkpoint Recovery**: Every tool operation writes an atomic checkpoint. If interrupted or crashed, the engine resumes exactly at `plan`, `draft`, `check`, or `commit` without losing state.
- **Two-Tier Rolling Long-Form Planning**: Avoids rigid, hollow outlines for 300+ chapter books. Starts with a high-level compass + skeleton arcs for the first 2 volumes and expands detailed chapter plans progressively as the story advances.
- **Intelligent Context Recommendation**: Recommends historical context per chapter based on foreshadowing clues, character presence, state changes, and relationship shifts, keeping narrative consistency across 500+ chapters.
- **Seven-Dimensional Quality Review**: The `Editor` evaluates setting consistency, character agency, pacing, narrative cohesion, foreshadowing, chapter hooks, and aesthetic literary quality (with textual evidence citations).
- **Real-Time Dynamic Steer**: Inject plot changes, character adjustments, or pacing corrections at any time directly through the TUI without stopping the engine.
- **Optional Chapter-by-Chapter Approval Gate**: Toggle `/review on` to inspect each chapter before running `/next` to authorize the next chapter.
- **Semantic Novel Import & Reverse-Engineering**: Ingest raw `.txt` / `.md` manuscripts with `/import`. Automatically segments chapters, extracts facts, reconstructs worldbuilding, and sets up continuation.
- **Style Simulation (`/simulate`)**: Ingest reference text to extract a style profile (lexicon, sentence structures, tension design, pacing density, hook techniques).
- **Manual Revision Synchronization (`/sync`)**: Edit generated chapters by hand; the engine detects file changes via SHA-256 and updates all downstream character states and summaries.
- **Multi-Format Export (`/export`)**: Compile finished chapters into clean TXT or standard EPUB 3 eBooks with metadata and table of contents.
- **Broad LLM Provider Compatibility**: Works seamlessly with OpenRouter, Anthropic, Google Gemini, OpenAI, DeepSeek, Qwen, GLM, Grok, Ollama, Bedrock, and custom proxies.

---

## Architecture & Workflow

### Core Principles

The architectural foundation is: **Deterministic Factual Layer, Autonomous Semantic Layer**.
1. **Enumerable transitions belong to code**: Routing decisions are pure state table lookups (`flow.Route`) with zero LLM overhead.
2. **Clear semantic boundaries belong to the Arbiter**: Structured decisions (planner triage, steer impact evaluation, failure recovery) are resolved by single-turn LLM calls.
3. **Open-ended creation belongs to Workers**: The Writer independently carries out chapter planning, drafting, self-checking, and committing.
4. **Tools only return facts**: Tools perform atomic file I/O and return structured JSON facts. The next action is recomputed by the Engine.

```
┌─────────────────────────────────────────────────────────────┐
│                    Host / Engine (Deterministic)            │
│  Read Store → Route → Dispatch Worker → Repeat Loop         │
│  Plan Start / Steer Triage / Deadlock → Consult Arbiter     │
└──────┬──────────────┬──────────────┬──────────────┬─────────┘
       │              │              │              │
 ┌─────▼──────┐ ┌─────▼──────┐ ┌─────▼──────┐  ┌────▼─────┐
 │ Architect  │ │   Writer   │ │   Editor   │  │ Arbiter  │
 │ (LLM Loop) │ │ (LLM Loop) │ │ (LLM Loop) │  │(Function)│
 └─────┬──────┘ └─────┬──────┘ └─────┬──────┘  └──────────┘
       └──────────────┼──────────────┘
                      │ Tool Execution (Atomic IO + Checkpoint)
┌─────────────────────▼───────────────────────────────────────┐
│                          Store                              │
│   Progress / Checkpoints / Outline / Drafts / Summaries     │
└─────────────────────────────────────────────────────────────┘
```

### Agent Roles

| Role | Responsibilities | Core Tools |
|---|---|---|
| **Arbiter** | Semantic decision-making: startup planning triage, user steer evaluation, failure/deadlock resolution. | *None (single-shot LLM function outputting structured schema)* |
| **Architect** | Worldbuilding, character profiles, premise, multi-volume master outline, rolling arc expansion. | `novel_context`, `save_book`, `save_foundation` |
| **Writer** | Chapter planning, scene drafting, sensory description, consistency self-check, and chapter commit. | `novel_context`, `read_chapter`, `plan_chapter`, `draft_chapter`, `check_consistency`, `commit_chapter` |
| **Editor** | Cross-chapter structural critique, 7-dimension aesthetic review, arc and volume summary generation. | `novel_context`, `read_chapter`, `save_review`, `save_arc_summary`, `save_volume_summary` |

### Chapter Writing Loop

```
User Prompt ──► Arbiter Triage ──► Architect (World / Outline) ──► Writer (Chapter Loop) ──► Editor (Arc Review)
                                                                           ▲                        │
                                                                           ├── Rewrite / Polish ────┘
                                                                           │
                                                                 Architect (Expands Next Arc/Vol)
```

Within each chapter, the **Writer** strictly follows an autonomous execution sequence:
1. `novel_context`: Load relevant background (recent summaries, foreshadowing log, active character states, style rules).
2. `read_chapter`: Re-read recent chapters to capture rhythm, tone, and character voice.
3. `plan_chapter`: Formulate chapter goals, conflicts, emotional arcs, and pacing.
4. `draft_chapter`: Write the complete chapter prose.
5. `check_consistency`: Validate consistency against world rules, character states, and timelines.
6. `commit_chapter`: Commit the final draft using a transactional Saga, updating progress and fact stores.

### Rolling Long-Form Planning

Unlike traditional generators that create a rigid outline for 300+ chapters upfront (resulting in hollow pacing), `ainovel-cli` utilizes a **Compass + Rolling Horizon Planning** system:

```
Initial Planning                 Arc Boundary                       Volume Boundary
┌─────────────────────────┐    ┌───────────────────────────┐    ┌───────────────────────────┐
│ Master Compass          │    │ Editor Arc Review         │    │ Editor Volume Review      │
│ Initial 2 Volume Shells │    │ Arc Summary + Snapshot    │    │ Volume Summary            │
│ Arc 1 Detailed Chapters │ ──►│ Architect Expands Next Arc│ ──►│ Architect Creates Next Vol│
│ Characters & World      │    │ Writer Continues Writing  │    │ & Updates Master Compass  │
└─────────────────────────┘    └───────────────────────────┘    └───────────────────────────┘
```

- **Master Compass**: Maintains overarching endgame direction, major plot threads, and milestone targets.
- **Skeleton Arcs**: Unwritten arcs remain lightweight placeholders with target goals and chapter estimates until reached.
- **Progressive Elaboration**: Arcs are fleshed out only when the narrative reaches them, incorporating all prior character growth and story developments.

### Hierarchical Context Management

For novels spanning hundreds of chapters, context is organized hierarchically with proactive token management:
- **Chapter Summaries**: Detailed rolling summary of recent chapters.
- **Arc Summaries**: Compressed milestones for middle-range arcs.
- **Volume Summaries**: High-level summaries for distant historical volumes.
- **Proactive Context Compaction**: Automatically triggers when token usage reaches 85% of the model's context window, preserving an 8,000-token minimum buffer to prevent model attention degradation.

---

## Quick Start

### Installation

```bash
# One-line installer (macOS / Linux, no Go required)
curl -fsSL https://raw.githubusercontent.com/voocel/ainovel-cli/main/scripts/install.sh | sh

# Install a specific release version
curl -fsSL https://raw.githubusercontent.com/voocel/ainovel-cli/main/scripts/install.sh | sh -s -- v1.2.3

# Or install via Go (Go 1.25+ recommended)
go install github.com/voocel/ainovel-cli/cmd/ainovel-cli@latest

# Check version or update in-place
ainovel-cli --version
ainovel-cli update
```

> **Windows Users**: Download pre-built binaries directly from [GitHub Releases](https://github.com/voocel/ainovel-cli/releases/latest).

### Initial Setup

Run `ainovel-cli` in an empty directory. If no configuration file exists, the interactive setup wizard will guide you through:
1. Selecting your primary LLM provider (OpenRouter, Anthropic, Gemini, OpenAI, DeepSeek, Ollama, etc.).
2. Entering your API Key and Base URL.
3. Choosing your default model.

```bash
ainovel-cli
```

### CLI Flags

```bash
# Set UI Language (vi, en, zh - default: system locale or vi)
ainovel-cli --lang en
ainovel-cli -l en

# Set Story Generation Language (vi, en, zh - default: matching UI language)
ainovel-cli --story-lang vi    # Vietnamese generation with natural literary directives
ainovel-cli --story-lang en    # English generation
ainovel-cli --story-lang zh    # Chinese generation

# Check version
ainovel-cli --version

# Update to latest GitHub release
ainovel-cli update
```

### Headless Mode (Server / CI / Automation)

`--headless` runs the creation pipeline non-interactively without the TUI, perfect for VPS, NAS, Docker, or CI workflows:

```bash
# Start a new novel from a prompt
ainovel-cli --headless --prompt "A cyberpunk mystery novel set in Neo-Saigon with an android detective"

# Start from a premise/outline file
ainovel-cli --headless --prompt-file ./story-premise.txt

# Read prompt from stdin
cat ./prompt.txt | ainovel-cli --headless --prompt-file -

# Resume an existing novel in the current directory
ainovel-cli --headless
```

### Docker & Docker Compose

Run `ainovel-cli` with containerized storage:

```bash
mkdir -p config workspace

# Interactive TUI Mode
docker run --rm -it \
  -v "$PWD/config:/root/.ainovel" \
  -v "$PWD/workspace:/workspace" \
  ghcr.io/voocel/ainovel-cli:latest

# Headless Background Mode
docker run --rm \
  -v "$PWD/config:/root/.ainovel" \
  -v "$PWD/workspace:/workspace" \
  ghcr.io/voocel/ainovel-cli:latest \
  --headless --prompt "A high-fantasy epic about an exiled prince reclaiming the throne"
```

Using Docker Compose:

```yaml
services:
  ainovel:
    image: ghcr.io/voocel/ainovel-cli:latest
    stdin_open: true
    tty: true
    volumes:
      - ./config:/root/.ainovel
      - ./workspace:/workspace
```

```bash
docker compose run --rm ainovel
```

---

## Interactive TUI & Slash Commands

Within the interactive TUI, type `/` to open the command palette.

| Command | Usage | Description |
|---|---|---|
| `/help` | `/help` | View command reference and keybindings. |
| `/model` | `/model [role]` | Open interactive panel to switch Provider, Model, and Reasoning Effort per role (`architect`, `writer`, `editor`, or `default`). |
| `/config` | `/config` | Manage UI/Story language, Provider credentials, candidate models, and system parameters. |
| `/diag` | `/diag` | Run project diagnostics and export a sanitized troubleshooting report (`meta/diag-export.md`). |
| `/review` | `/review on\|off` | Toggle chapter-by-chapter approval gate. |
| `/next` | `/next` | Authorize generation of the next chapter in review mode. |
| `/start` | `/start <path>` | Start a new novel using an existing premise/outline file on the welcome screen. |
| `/import` | `/import <path> [--yes] [--story=open\|closed] [--continue] [--guide="..."]` | Semantically import an external TXT/MD novel into the engine. |
| `/reopen` | `/reopen [direction]` | Reopen a completed novel to write new sequel volumes. |
| `/cocreate` | `/cocreate` (or `/plan`) | Pause generation and enter interactive stage co-creation with the Architect. |
| `/simulate` | `/simulate` | Analyze sample texts in `./simulate/` to extract a style and pacing profile. |
| `/importsim` | `/importsim <profile.json>` | Import an existing style simulation profile. |
| `/sync` | `/sync [--check]` | Ingest manual chapter edits into the facts database and update character states. |
| `/export` | `/export [path] [from=N] [to=M] [--overwrite]` | Export completed chapters to TXT or EPUB format. |

### Essential TUI Keybindings

- `Tab` / `Shift+Tab`: Switch focus across fields / panels.
- `↑` / `↓` / `←` / `→`: Navigate items, scroll viewports, adjust selections.
- `Enter`: Submit command / input or confirm selection.
- `Esc`: Close open modal / cancel current view.
- `Ctrl+R`: Toggle terminal mouse copy mode.

---

## Configuration Guide

### Configuration File Resolution

Configurations are merged in hierarchical order:
1. `~/.ainovel/config.json`: Global user configuration.
2. `./.ainovel/config.json`: Project-level configuration (overrides global).

### Example Configuration

You can find the commented template in `config.example.jsonc`:

```jsonc
{
  "provider": "openrouter",
  "model": "google/gemini-2.5-flash",
  "reasoning_effort": "medium", // off / low / medium / high / xhigh / max

  // Language settings
  "language": "vi",       // UI Language: vi / en / zh
  "story_language": "vi", // Story Language: vi / en / zh

  // Genre style preset
  "style": "default",

  "providers": {
    "openrouter": {
      "api_key": "sk-or-v1-xxx",
      "base_url": "https://openrouter.ai/api/v1",
      "models": [
        { "name": "google/gemini-2.5-flash", "context_window": 200000 },
        { "name": "google/gemini-2.5-pro", "context_window": 1000000 }
      ]
    },
    "anthropic": {
      "api_key": "sk-ant-xxx",
      "models": [{ "name": "claude-sonnet-4-6", "json_schema": true }]
    },
    "ollama": {
      "base_url": "http://localhost:11434/v1",
      "models": [{ "name": "qwen3:14b", "context_window": 32768 }],
      "stream_idle_timeout": "15m"
    }
  },

  // Optional: Role-based model overrides
  "roles": {
    "writer": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "reasoning_effort": "high",
      "fallbacks": [{ "provider": "openrouter", "model": "google/gemini-2.5-pro" }]
    },
    "architect": {
      "provider": "openrouter",
      "model": "google/gemini-2.5-pro",
      "reasoning_effort": "medium"
    }
  },

  // Optional: Book USD budget guardrail
  "budget": {
    "book_usd": 50,
    "warn_ratio": 0.8,
    "hard_stop": false
  },

  // Optional: Unattended Alerting
  "notify": {
    "enabled": true,
    "events": ["run_end", "budget", "advance_gate", "worker_failure"]
  }
}
```

### Role-Based Model Routing & Fallbacks

Assign distinct models to specific agents to optimize cost and quality:
- `architect`: High-reasoning model for intricate worldbuilding and long-form outline planning.
- `writer`: Expressive model with high literary flair and deep context retention.
- `editor`: Critical analysis model for consistency and aesthetic review.
- `import_segment`, `import_analyze`, `import_synthesize`: Dedicated tiers for the novel import pipeline.

### Custom API Proxies & Gateways

For custom gateways (NewAPI, OneAPI, Claude Code proxies, Codex endpoints), set `type` explicitly:

```jsonc
"providers": {
  "my-custom-proxy": {
    "type": "openai", // "openai" or "anthropic"
    "api_key": "sk-xxx",
    "base_url": "https://proxy.example.com/v1",
    "api": "chat",    // "chat" (default) or "responses"
    "extra": {
      "headers": { "X-Custom-Auth": "secret" },
      "user_agent": "my-agent/1.0"
    }
  }
}
```

---

## Advanced Features

### Semantic Novel Import & Reverse-Engineering (`/import`)

Import an existing `.txt` or `.md` novel to analyze its world and continue writing seamlessly:

```text
/import ~/my_novel.txt
```

**Pipeline Stages**:
1. **Ingest**: File checksum verification and charset decoding (UTF-8 / GB18030).
2. **Segment**: LLM semantic chapter boundary detection (no fragile regex required).
3. **Analyze**: Batch chapter-by-chapter factual extraction (events, character updates, timelines).
4. **Synthesize**: Master premise, world rules, character dossier, and layered volume outline generation.
5. **Publish**: Atomic persistence to `output/novel/` ready for continuation.

### Style Simulation & Profile Extraction (`/simulate`)

Place 1-5 sample chapters or reference books in `./simulate/` and run:

```text
/simulate
```

The Architect extracts a `simulation_profile.json` capturing sentence rhythms, vocabulary tendencies, tension dynamics, and hook structures. Agents reference this profile to emulate the desired literary style without copying specific names or plotlines.

### Manual Human Revision Sync (`/sync`)

If you manually edit generated chapters in `output/novel/chapters/*.md`, synchronize changes with:

```text
/sync --check    # Check which chapters have been modified
/sync            # Ingest edits, re-extract facts, and update character states
```

### Interactive Chapter Review Gate (`/review`)

When human-in-the-loop control is needed:

```text
/review on       # Enable chapter review gate
/next            # Approve and write the next chapter
/review off      # Return to continuous autonomous mode
```

### Real-Time Steer & User Intervention

While the engine is generating, type instructions into the input box and press `Enter`:

```text
❯ Give the protagonist a magical artifact in Chapter 5 and increase dialogue tension.
```

The **Arbiter** assesses the impact:
- Premise / worldbuilding updates are delegated to the **Architect**.
- Completed chapters requiring adjustment are queued for the **Editor** / **Writer**.
- Writing rules are immediately appended to memory.

### Multi-Format Book Export (`/export`)

```text
/export                         # Default TXT export to output/novel/{title}.txt
/export ~/MyNovel.epub          # Export as standard EPUB 3 eBook with TOC and metadata
/export from=1 to=50 ~/Part1.epub --overwrite
```

### Voice Layer & Custom Style Presets

Customize literary voice layers without modifying the engine source code. Overrides resolve across three tiers: `Built-in < Global ~/.ainovel/style/ < Book-level ./style/`:

```
style/
├── voice.md                    # Appends custom prose standards
├── anti-ai-tone.md             # Appends custom anti-AI criteria
├── styles/
│   └── darkfantasy.md          # Custom style preset (selectable in config)
└── genres/
    └── darkfantasy/
        └── style-references.md # Genre reference guidelines
```

**Built-in Styles**: `default`, `tienhiep` (Xianxia), `kiemhiep` (Wuxia), `dothi` (Urban), `ngontinh` (Modern Romance), `trinhtham` (Detective/Mystery), `fantasy`, `suspense`, `romance`.

### Anti-AI Tone & Custom User Rules

To enforce custom rules (e.g., "Keep chapters around 3,500 words", "Avoid repetitive rhetorical questions", "No modern slang in historical settings"), place plain text Markdown files in:
- Global: `~/.ainovel/rules/*.md`
- Project: `./.ainovel/rules/*.md`

The system automatically extracts structured constraints and enforces them during the `commit_chapter` gate.

### Diagnostics & Health Check (`/diag`)

Run `/diag` to audit narrative consistency, character arcs, pacing bottlenecks, and timeline anomalies. Generates an anonymized diagnostic report at `output/novel/meta/diag-export.md` suitable for sharing in bug reports.

### Budget Safeguards & Unattended Notifications

Configure spending limits and notifications in `config.json`:
- **Budget**: Set `book_usd` to cap total generation spend.
- **Alerts**: Supports native OS notifications (macOS `osascript`, Linux `notify-send`, Windows toast), Bark (iOS), ntfy, or custom webhook curl commands.

### Offline Evaluation Harness (`eval`)

A dedicated offline evaluation suite to benchmark models and run A/B prompt tests:

```bash
ainovel-cli eval --dataset ./benchmarks/prompt_suite.json --model anthropic/claude-sonnet-4-6
```

---

## Output Directory Structure

Each novel is self-contained within its workspace directory:

```
output/novel/
├── book.md                   # Human-readable title and synopsis
├── chapters/                 # Final committed chapters (Markdown)
│   ├── 01.md
│   └── ...
├── drafts/                   # Working draft files
├── reviews/                  # Chapter review reports
├── summaries/                # Chapter, Arc, and Volume summaries (JSON)
├── timeline.jsonl            # Chronological event log
├── premise.md                # Core story premise
├── layered_outline.json      # Hierarchical multi-volume outline
├── characters.json           # Character profiles and state ledger
├── world_rules.json          # Worldbuilding rules and magic systems
└── meta/
    ├── book.json             # Single source of truth for book metadata
    ├── compass.json          # Master long-form compass
    ├── progress.json         # Current phase, chapter pointer, and status
    ├── foreshadow.json       # Active foreshadowing log
    ├── checkpoints.jsonl     # Step-level atomic checkpoints
    └── decisions.jsonl       # Arbiter decision audit ledger
```

---

## Crash Recovery & Persistence

Writing a 500-chapter novel can take days. `ainovel-cli` is built with enterprise crash-resilience:
- **Atomic File I/O**: File writes use `temp + fsync + rename` to prevent corruptions during power loss.
- **Step Checkpoints**: Recorded after every tool execution.
- **Zero Session Dependence**: Restarting `ainovel-cli` in the same directory reads the state store, recovers pending signals, and resumes seamlessly.

---

## Tech Stack

- **[Go 1.25+](https://golang.org/)**: High-performance, concurrent backend engine.
- **[agentcore](https://github.com/voocel/agentcore)**: Minimalist agent kernel with tool execution and streaming.
- **[litellm](https://github.com/voocel/litellm)**: Universal LLM provider adapter.
- **[Bubble Tea](https://github.com/charmbracelet/bubbletea)** & **[Lipgloss](https://github.com/charmbracelet/lipgloss)**: Beautiful terminal UI framework.

---

## License

This project is open-source under the [MIT License](LICENSE).

Community discussions and support are welcomed at [linux.do](https://linux.do/).
