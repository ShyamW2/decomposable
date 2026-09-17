# 07 — Delegation

How the high tier (Fable) hands work to Opus and Sonnet, and what a receiving
model is expected to do. The `agent-bridge` plugin uses the same template to brief
the in-app coding agent, so keep this format stable.

## When to delegate what

| Signal | Tier |
|--------|------|
| The task changes an ADR, the plugin contract, or `harmony/` design | Fable, do not delegate |
| Multi-plugin integration, event-store internals, supervisor, anything with subtle lifecycle | Opus |
| One plugin from a spec, tests from a list of cases, UI components, docs, refactors | Sonnet |
| Debugging with an unclear cause | Opus; escalate to Fable if it touches design |

Rule of thumb: if the brief can state the definition of done as a list of tests,
it is Sonnet-shaped. If the definition of done needs judgement, it is Opus-shaped.
If writing the brief requires deciding something, it is Fable-shaped.

## Task brief template

```markdown
# Task: <imperative title>

Tier: sonnet | opus
Touches: <directories the task may modify; nothing else>
ADRs in force: <ids>   Docs to read first: <paths>

## Goal
One paragraph. What exists after this task that did not before.

## Context the implementer needs
- Relevant services and their interfaces (paste, do not reference)
- The nearest existing example to copy (path)
- Fixtures to use (path)

## Definition of done
- [ ] Tests: <named cases, or "conformance suite for kind X passes">
- [ ] `pnpm test` green; no new lint warnings
- [ ] README.md in the plugin directory updated
- [ ] No changes outside "Touches"

## Out of scope
Explicit list, so the implementer does not "improve" adjacent things.

## Questions to ask before starting (if any are unanswered, stop and ask)
```

## Expectations of the receiving model

1. Read the listed docs and the nearest example before writing code.
2. Stay inside "Touches". If the task cannot be done without going outside, stop
   and say why. Do not widen scope.
3. Register every side effect through `ctx.effect`. Run the conformance suite
   locally before reporting done.
4. Report faithfully: what passed, what failed with output, what was skipped.
5. Do not edit ADRs, CLAUDE.md, or `03-architecture.md`. Propose changes in the
   report instead.

## Expectations of the delegating model

1. Do the thinking first. A brief that says "figure out the right design" is a
   sign the wrong tier is doing the work.
2. Paste interfaces into the brief; do not make the implementer discover them.
3. Name the fixtures. If they do not exist, writing them is a separate Sonnet task
   that comes first.
4. Review the result against the definition of done, not against taste.

## Log

- 2026-09-18: first draft.
