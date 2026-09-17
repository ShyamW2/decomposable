# Musician docs

| File | What it is | Read when |
|------|------------|-----------|
| [01-vision.md](01-vision.md) | The pitch, and the list of things that would make this genuinely new | Starting any design work |
| [02-feasibility.md](02-feasibility.md) | Capability-by-capability feasibility, available open-source pieces, honest hard parts | Choosing what to build first, estimating |
| [03-architecture.md](03-architecture.md) | Cordis kernel, plugin contract, Python worker boundary, analysis document, hot swap, agent bridge | Writing any plugin |
| [04-harmony-engine.md](04-harmony-engine.md) | Chord naming, voicing classification, progression parsing. The novel core | Touching anything under `harmony/` |
| [05-roadmap.md](05-roadmap.md) | Phases, milestones, and which model tier does what | Planning a sprint |
| [06-decisions.md](06-decisions.md) | ADR log: proposed, accepted, superseded | Before changing a foundational choice |
| [07-delegation.md](07-delegation.md) | How the high-tier model hands work to Sonnet/Opus. Task brief template | Delegating or receiving a task |
| [08-references.md](08-references.md) | Links: models, libraries, papers, Cordis | Looking for a library |

Conventions for these docs: keep them short enough to read in one sitting. Put dated
notes at the bottom of a doc under "Log" rather than rewriting history. Decisions go
in the ADR log, not inline.
