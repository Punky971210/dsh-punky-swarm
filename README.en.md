# dsh-punky-swarm — Punky Swarm

![license](https://img.shields.io/badge/license-AGPL--3.0-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green) ![CI](https://github.com/Punky971210/dsh-punky-swarm/actions/workflows/ci.yml/badge.svg)

> **Single-machine multi-subagent swarm governance** for DeepSeek Harness (dsh): fixed-semantics wavePlan (3-layer DAG, never recomputed after creation) + engine-enforced gates (Entry / Plan-contract / Exit / Complete) + state machine + locks/mailbox + session isolation + a task-difficulty routing gate. Ships with the Punky Mode preset and the jiufeng-team role assembly guide.

中文: [README.md](README.md)

## Scope

- **Goal**: single-machine multi-subagent governance on one dsh process (batching / gates / communication / reset-on-recover);
- **Out of scope**: hardening, durable resume, cluster sync, cost control — do not use this project for those needs.

## Design purpose and origin

**Purpose**: the gates (Entry / Plan-contract / Exit / Complete), batching, locks and mailbox exist first and foremost to **keep the pipeline and the cluster stable** — not to constrain agents. The tool layer is fully open to agents; the mode layer only guides; team assembly is pluggable; work is graded by scale (Leader dispatch → single-agent fallback).

**Origin**: this project grew out of the trade-off between a single agent running the whole loop and graph-based orchestration:

- Single agent, full loop (design → implement → test): heavy human intervention — the human becomes the bottleneck;
- Graph-based orchestration (LangGraph direction): tried and dropped — the flow is frozen into a graph, expensive to change, squeezes agent freedom;
- Middle path: the "Jiufeng" work mode (Leader decomposition → multi-role collaboration → gate verdicts) was built on JiuwenSwarm, then migrated to dsh as this plugin.

**Status**: developed to a "personally usable" standard. In degraded single-agent work, following the pipeline norms gives a felt improvement in controllability and stability (benchmarks pending). Effects at real cluster scale are not yet systematically validated; claims are limited to what the code demonstrates (tests, gates, CI).

## The Three Pieces

| Piece | Location | Content |
|---|---|---|
| Plugin | packages/dsh-punky-swarm | Engine: 14 governance tools + Tier3 gates + session v2 + read-only API + task difficulty gate + Punky swarm monitor |
| Mode | packages/dsh-punky-swarm/presets/jiufeng | Punky Mode preset: Leader persona + governance discipline + tool-bootstrap |
| Guide | packages/dsh-punky-swarm/skills/jiufeng-team | 3-layer 8-role × skill assembly table + constitution + templates |

## Install

> Agent-friendly, runnable steps; `web` is an example profile — replace with yours.
> On startup the plugin **auto-syncs** the mode preset (→ `~/.dsh/.agent-presets/jiufeng`) and the skill guide (→ `~/.agents/skills/jiufeng-team`) — **no manual copy needed**; existing identical targets are skipped, divergent targets are overwritten with the bundled version.

```sh
git clone https://github.com/Punky971210/dsh-punky-swarm.git
cd dsh-punky-swarm
# Install peer deps (@deepseek-ai/dsh-tools, @deepseek-ai/cordis; versions pinned by package-lock.json)
npm ci --prefix packages/dsh-punky-swarm
# POSIX
dsh plugin --profile web add link:$(pwd)/packages/dsh-punky-swarm
# Windows PowerShell
dsh plugin --profile web add link:$PWD\packages\dsh-punky-swarm
dsh web restart
```

> This is the only install path — **git source + dsh plugin link**; no npm package is published.

## Punky swarm monitor (read-only)

The plugin ships a **Punky swarm** monitor tab as the third tab of the conversation view header (对话 / 轨迹 / 蟛蜞集群). Available right after install, no extra config.

- **Batch list**: phase (planning/running/complete…) + terminal progress `3/5` + auto-release/done markers;
- **Stats strip**: total / running / done / issues (failed+conflict);
- **Batch detail**: lane state cards (status + task summary + gate-missing details + layer/deps), event timeline, mailbox (dispatch/broadcast) counts;
- **Read-only**: 3s auto-refresh; follows the Web UI light/dark theme. The execution engine (batches / gates / state machine) cannot be modified by humans — view only; governance actions are driven by the Punky Mode Leader.

## Governance Tools (14)

wave_plan / batch_phase / batch_status / artifact_types / assign_check / asset_claim / gate_status / lane_claim / lane_release / member_status / member_settle / mailbox_send / mailbox_read / mailbox_ack

## wavePlan (fixed semantics)

- Tasks are layered into waves by their dependency DAG at creation; **the plan is never recomputed after the batch is created**;
- Tasks may declare layer (plan/exec/audit), consume/produce/outputs, role/skills; team assembly injects skill prefixes by role (pluggable, not bound to jiufeng);
- Waves in the same batch dispatch in parallel; batch/member state is file-backed single source of truth (auditable event log).

## Task Difficulty Gate

- **Before any mutating action in each user turn**, the Leader must report a task difficulty A/B/C via assign_check with an execution owner: A=Leader direct / B=single subagent / C=cluster (wave_plan batch);
- **default to C**: the assessed object is the full target task (scope=full); any C feature (multi-stage ≥3 / multi-role ≥2 / gates needed / external deps / recoverability) ⇒ C; when unsure, pick C;
- **guard enforcement**: after C is assessed, calling an exec-type tool (pwsh/write/edit/run/subagent, …) before batching is denied by the engine; missing or stale assessment (≥20 exec calls or 30 min) is also denied; read-only queries stay allowed;
- **asset_claim**: artifacts the Leader already produced before the C assessment can be reclaimed into the batch via asset_claim — no rework, no path-dependency.

## Tier3 Gates

- Build-time checks: layer ∈ plan/exec/audit; exec requires audit; artifact path contract; cross-layer refs; tamper-proof plan;
- **Entry Gate**: exec dispatch requires consume artifacts, else rejected (GATE_ENTRY_MISSING);
- **Plan Contract Gate**: plan artifacts must carry required spec sections (acceptance criteria / constraints) + valid task-tree JSON, else merge rejected (GATE_PLAN_CONTRACT);
- **Exit Gate**: exec settle requires outputs, audit settle requires produce, else merge rejected (GATE_EXIT_MISSING_*);
- **Complete Gate**: batch complete requires audit acceptance done with no failed/conflict and all exec terminal (GATE_COMPLETE_*).

Generic batches (no layer) bypass gates for backward compatibility.

## State Machine

```
member: pending -> running -> review -> merged | failed | skipped | conflict (idle=re-dispatch; review->running=rework)
batch:  planning -> running -> paused -> aborted | complete (complete requires Tier3 gates)
```

## License

This project is licensed under the [GNU AGPL v3](LICENSE) (SPDX: AGPL-3.0-only). You may use, modify, and distribute it (including commercially) under AGPL-3.0; if you modify it and provide it over a network, you must publish your modifications under AGPL-3.0.
