# Product Guidelines & Standards

## 1. Narrative & Prose Quality Standards
- **Anti-AI Tone & Authenticity**: Strip out formulaic AI clichés, repetitive rhetorical questions, superficial moralizing, and hollow motivational monologues. Prose must feel organically authored.
- **Sensory Grounding & Specificity**: Ground every scene in tangible physical environments, dynamic sensory details, and character micro-actions rather than generic abstract emotions.
- **Differentiated Dialogue**: Every character must have a distinct speech cadence, vocabulary, and worldview reflecting their personality and background.
- **Structural Integrity & Pacing**: Maintain narrative momentum with distinct chapter objectives, escalating micro-conflicts, and organic cliffhangers/hooks.

## 2. CLI & Terminal UX Principles
- **Dual Runtime Symmetry**: Maintain feature parity and reliability between the interactive Bubble Tea TUI and the headless batch/CI pipeline.
- **Transparent & Resilient Error Handling**: Fatal errors must be logged to `~/.ainovel/last-error.log` and pause for confirmation in interactive terminals to prevent instant window closure.
- **Atomic, Idempotent State**: All state transitions and chapter commits must be backed by atomic disk operations and replayable checkpoints.

## 3. Multi-Agent System Principles
- **Deterministic Orchestration**: Never use LLMs for state routing or flow management; preserve deterministic Go state machine dispatching.
- **Evidence-Based Review**: The Editor agent must provide verbatim text citations for every critique or score.
- **Auditable Semantics**: All Arbiter decisions (planner selection, intervention triage) must produce structured JSON logged to disk.
