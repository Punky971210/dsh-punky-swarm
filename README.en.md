# dsh-punky-swarm — Punky Swarm

![license](https://img.shields.io/badge/license-Apache--2.0-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green) ![CI](https://github.com/Punky971210/dsh-punky-swarm/actions/workflows/ci.yml/badge.svg)

> **Single-machine multi-subagent swarm governance** for DeepSeek Harness (dsh): fixed-semantics wavePlan (3-layer DAG) + engine-enforced gates (Entry/L0/Exit/Complete) + state machine + locks/mailbox + session isolation. Ships with the Punky Mode preset and the jiufeng-team role assembly guide.

中文: [README.md](README.md)

## Scope

- **Goal**: single-machine multi-subagent governance on one dsh process (batching / gates / communication / reset-on-recover);
- **Out of scope**: hardening, durable resume, cluster sync, cost control — do not use this project for those needs.

## Design purpose and origin

**Purpose**: the gates (Entry/L0/Exit/Complete), batching, locks and mailbox exist first and foremost to **keep the pipeline and the cluster stable** — not to constrain agents. The tool layer is fully open to agents; the mode layer only guides; team assembly is pluggable; work is graded by scale (Leader dispatch → single-agent fallback).

**Origin**: this project grew out of the trade-off between a single agent running the whole loop and graph-based orchestration:

- Single agent, full loop (design → implement → test): heavy human intervention — the human becomes the bottleneck;
- Graph-based orchestration (LangGraph direction): tried and dropped — the flow is frozen into a graph, expensive to change, squeezes agent freedom;
- Middle path: the "Jiufeng" work mode (Leader decomposition → multi-role collaboration → gate verdicts) was built on JiuwenSwarm, then migrated to dsh as this plugin.

**Status**: developed to a "personally usable" standard. In degraded single-agent work, following the pipeline norms gives a felt improvement in controllability and stability (benchmarks pending). Effects at real cluster scale are not yet systematically validated; claims are limited to what the code demonstrates (tests, gates, CI).

## The Three Pieces

| Piece | Location | Content |
|---|---|---|
| Plugin | packages/dsh-punky-swarm | Engine: 13 governance tools + Tier3 gates + session v2 + read-only API + Punky swarm monitor |
| Mode | packages/dsh-punky-swarm/presets/jiufeng | Punky Mode preset: Leader persona + governance discipline + tool-bootstrap |
| Guide | packages/dsh-punky-swarm/skills/jiufeng-team | 3-layer 8-role × skill assembly table + constitution + templates |

## Install

> Agent-friendly, runnable steps; `web` is an example profile — replace with yours.
> On startup the plugin **auto-syncs** the mode preset (→ `~/.dsh/.agent-presets/jiufeng`) and the skill guide (→ `~/.agents/skills/jiufeng-team`) — **no manual copy needed**; existing identical targets are skipped, divergent targets are overwritten with the bundled version.

### 1. Get the plugin (GitHub)

```sh
git clone https://github.com/Punky971210/dsh-punky-swarm.git
cd dsh-punky-swarm
```

### 2. Install the plugin dependencies (peer deps)

```sh
cd packages/dsh-punky-swarm
npm ci
```

> After mounting via `link:`, Node resolves dependencies from the plugin directory upward; the repo ships a `package-lock.json`, so `npm ci` installs `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis` in one command — no manual symlinks needed.

### 3. Mount the plugin

```sh
# POSIX
dsh plugin --profile web add link:$(pwd)/packages/dsh-punky-swarm
# Windows PowerShell
dsh plugin --profile web add link:$PWD\packages\dsh-punky-swarm
```

### 4. Restart dsh web (first start runs the preset/skill sync)

```sh
dsh web restart
```

### 5. Verify

1. Create a new session and pick the "蟛蜞模式" preset;
2. The tool surface includes the 13 governance tools: wave_plan / batch_phase / batch_status / artifact_types / assign_check / gate_status / lane_claim / lane_release / member_status / member_settle / mailbox_send / mailbox_read / mailbox_ack;
3. Preset and skill in place: `ls ~/.dsh/.agent-presets/jiufeng/preset.yml` and `ls ~/.agents/skills/jiufeng-team/SKILL.md`.
4. The conversation header shows a third tab "蟛蜞集群" — the read-only monitor — open it to watch batches;

> This is the only install path — **git source + dsh plugin link**; no npm package is published.

## Punky swarm monitor (read-only)

The plugin ships a **Punky swarm** monitor tab as the third tab of the conversation view header (对话 / 轨迹 / 蟛蜞集群). Available right after install, no extra config.

- **Batch list**: phase (planning/running/complete…) + terminal progress `3/5` + auto-release/done markers;
- **Stats strip**: total / running / done / issues (failed+conflict);
- **Batch detail**: lane state cards (status + task summary + gate-missing details + layer/deps), event timeline, mailbox (dispatch/broadcast) counts;
- **Read-only**: 3s auto-refresh; follows the Web UI light/dark theme. The execution engine (batches / gates / state machine) cannot be modified by humans — view only; governance actions are driven by the Punky Mode Leader.

## Governance Tools (13)

wave_plan / batch_phase / batch_status / artifact_types / assign_check / gate_status / lane_claim / lane_release / member_status / member_settle / mailbox_send / mailbox_read / mailbox_ack

## Tier3 Gates

- Build-time checks: layer ∈ plan/exec/audit; exec requires audit; artifact path contract; cross-layer refs; tamper-proof plan;
- Entry Gate: exec dispatch requires consume artifacts;
- L0: plan merge requires spec headings / parseable JSON;
- Exit Gate: exec → outputs, audit → produce exist;
- Complete Gate: audit all terminal without failed/conflict, exec all terminal.

Generic batches (no layer) bypass gates for backward compatibility.

## State Machine

```
member: pending -> running -> review -> merged | failed | skipped | conflict (idle=re-dispatch; review->running=rework)
batch:  planning -> running -> paused -> aborted | complete (complete requires Tier3 gates)
```

## License

Apache-2.0. See [LICENSE](LICENSE).
