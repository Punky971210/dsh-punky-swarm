# dsh-punky-swarm — Punky Swarm

![license](https://img.shields.io/badge/license-Apache--2.0-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green)

> **Single-machine multi-subagent swarm governance** for DeepSeek Harness (dsh): fixed-semantics wavePlan (3-layer DAG, never recomputed after creation) + engine-enforced gates (Entry / Plan-contract / Exit / Complete) + state machine + locks/mailbox + session isolation + a task-difficulty routing gate. Ships with the Punky Mode preset and the jiufeng-team role assembly guide.

中文: [README.md](README.md)

## Scope

- **Goal**: single-machine multi-subagent governance on one dsh process (batching / gates / communication / reset-on-recover);
- **Out of scope**: hardening, durable resume, cluster sync, cost control — do not use this project for those needs.

## The Three Pieces

| Piece | Location | Content |
|---|---|---|
| Plugin | packages/dsh-punky-swarm | Engine: 14 governance tools + Tier3 gates + session v2 + read-only API + read-only monitor panel |
| Mode | packages/dsh-punky-swarm/presets/jiufeng | Punky Mode preset: Leader persona + governance discipline + tool-bootstrap |
| Guide | packages/dsh-punky-swarm/skills/jiufeng-team | 3-layer 8-role × skill assembly table + constitution + templates |

## Install

> Agent-friendly, runnable steps; `web` is an example profile — replace with yours.
> On startup the plugin **auto-syncs** the mode preset (→ `~/.dsh/.agent-presets/jiufeng`) and the skill guide (→ `~/.agents/skills/jiufeng-team`) — **no manual copy needed**; existing identical targets are skipped, divergent targets are overwritten with the bundled version.

```sh
git clone https://github.com/Punky971210/dsh-punky-swarm.git
cd dsh-punky-swarm
# POSIX
dsh plugin --profile web add link:$(pwd)/packages/dsh-punky-swarm
# Windows PowerShell
dsh plugin --profile web add link:$PWD\packages\dsh-punky-swarm
dsh web restart
```

> This is the only install path — **git source + dsh plugin link**; no npm package is published.

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

Apache-2.0. See [LICENSE](LICENSE).
