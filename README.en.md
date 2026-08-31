# dsh-punky-swarm — Multi-Agent Governance for DeepSeek Harness

<p align="center">
  <a href="https://github.com/Punky971210/dsh-punky-swarm/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Punky971210/dsh-punky-swarm?label=license" alt="license"></a>
  <a href="https://github.com/awesome-dsh-plugin/awesome-dsh-plugin"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome"></a>
  <a href="https://github.com/Punky971210/dsh-punky-swarm/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Punky971210/dsh-punky-swarm/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="https://github.com/Punky971210/dsh-punky-swarm/blob/main/packages/dsh-punky-swarm/package.json"><img src="https://img.shields.io/badge/node-%3E%3D22-blue" alt="node"></a>
  <a href="https://github.com/Punky971210/dsh-punky-swarm/tree/main/packages/dsh-punky-swarm/test"><img src="https://img.shields.io/badge/tests-582%20passed-success" alt="tests"></a>
</p>

> *Engine-enforced guardrails for DeepSeek Harness agent swarms: quality gates reject half-done work, crash-safe checkpoints resume in place — keeps AI teams from breaking, not just running.*

中文: [README.md](README.md)

## Abstract

dsh-punky-swarm is a single-machine multi-agent governance plugin for DeepSeek Harness. Tasks run in dependency-ordered waves, engine-enforced gates reject half-done work, and checkpoints let long-running batches resume after a crash. The plugin ships 19 governance tools (20 with all capabilities enabled), passes 582 tests, and is licensed under AGPL-3.0-only.

## Quick Start

```sh
npm install -g dsh-punky-swarm
dsh plugin --profile web add dsh-punky-swarm
dsh web restart
```

Then ask the agent in a session to create a batch via `wave_plan` (declaring plan/exec/audit layers and artifact contracts), watch the waves dispatch, and inspect state with `batch_status` / `gate_status`.

## Capabilities (10)

1. **ABC task-difficulty routing gate** — A=Leader direct / B=single subagent / C=wave_plan batch; scope=full, default to C.
2. **wavePlan with fixed semantics** — 3 layers (plan→exec→audit), waves layered by dependency DAG, never recomputed after batch creation.
3. **Tier3 engine-enforced gates** — dispatch requires consume artifacts (GATE_ENTRY_MISSING otherwise); settle requires artifacts on disk; complete requires audit acceptance.
4. **Checkpoint resume** — git-preserved progress per sub-step (step N/total); a new worker queries checkpoints and skips completed steps after a crash.
5. **Lane worktree isolation + serialized merge** — parallel lanes writing one git repo stay conflict-free; merges serialize; conflicts keep the scene.
6. **Mailbox blackboard** — inbox/outbox/broadcast, atomic writes with ackId, metadata only.
7. **lane_claim single-writer lock** — O_EXCL, conflict rejects first, wait or force takeover.
8. **Member state machine** — pending→running→review→merged/failed/conflict/skipped; terminal states reject further writes.
9. **Batch session isolation** — state files are the single source of truth; event stream is auditable.
10. **Project state** — 19 governance tools by default (20 with all capabilities), 582/582 tests passing, v0.3.6 released, AGPL-3.0-only, listed on awesome-dsh-plugin.

## Contents

The primary README is Chinese-first: [README.md](README.md) covers Why, Architecture, Compatibility Matrix, Roadmap, and License (AGPL-3.0-only; mirrors copy release files byte-for-byte and only add commits — never rewriting .git history).
