# Product Concept & Vision

## Product Overview
`ainovel-cli` is a fully automated AI long-form novel creation engine built in Go. It operates on a "deterministic facts, autonomous semantics" architecture: a deterministic state engine executes an explicit route decision table across Architect, Writer, and Editor autonomous agents, waking an Arbiter model only for semantic boundary adjudications. From a single prompt or interactive co-creation session to a complete 500+ chapter novel, the engine runs end-to-end with zero manual intervention required, while supporting real-time steering, chapter-by-chapter acceptance gates, and resilient step-level checkpoint recovery.

## Target Audience & Personas
1. **Web Novel Authors & Creative Writers**: Authors looking to generate complete long-form works, brainstorm dynamic outlines, or co-create stories with strict consistency, character arc tracking, and stylistic differentiation.
2. **AI Narrative Researchers & Developers**: Engineers building autonomous multi-agent systems who require deterministic state transitions, auditable decision logs, and low-cost orchestration.
3. **Automated Content Publishers**: Creators running batch or CI/CD-driven generation via headless CLI mode or interactive TUI.

## Core Features & Value Propositions
- **Deterministic Engine + Multi-Agent Collaboration**: Engine dispatches Architect, Writer, and Editor via a deterministic routing table without LLM orchestration overhead.
- **Auditable Semantic Arbiter**: Single-call structured adjudication for planner selection, steering triage, and deadlock recovery with on-disk audit logs.
- **Step-Level Checkpoint Recovery**: Precise atomic checkpoints after every tool invocation for crash-resilient resumption across plan, draft, check, and commit stages.
- **Rolling Volume/Arc/Chapter Planning**: 2-volume rolling skeleton and on-demand arc expansions guided by narrative compass and character state snapshots.
- **Long-Form Context & Memory Pipeline**: Three-tier summarization (chapter, arc, volume), four-tier context compression pipeline, and smart historical chapter recommendation across 500+ chapters.
- **Seven-Dimensional Quality Review**: Editor agent reviews consistency, character behavior, pacing, coherence, foreshadowing, hooks, and prose texture with mandatory textual citations.
- **Dual Runtime (TUI + Headless)**: Interactive Bubble Tea terminal UI with live steering and progress visualization, alongside headless mode for server/NAS/CI pipelines.
