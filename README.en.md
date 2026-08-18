# dsh-punky-swarm — Punky Swarm

![license](https://img.shields.io/badge/license-Apache--2.0-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green)

> **Single-machine multi-subagent swarm governance** for DeepSeek Harness (dsh): fixed-semantics wavePlan (3-layer DAG) + engine-enforced gates (Entry/L0/Exit/Complete) + state machine + locks/mailbox + session isolation. Ships with the Punky Mode preset and the jiufeng-team role assembly guide.

中文: [README.md](README.md)

## Scope

- **Goal**: single-machine multi-subagent governance on one dsh process (batching / gates / communication / reset-on-recover);
- **Out of scope**: hardening, durable resume, cluster sync, cost control — do not use this project for those needs.

## The Three Pieces

| Piece | Location | Content |
|---|---|---|
| Plugin | packages/dsh-punky | Engine: 13 governance tools + Tier3 gates + session v2 + read-only API |
| Mode | packages/dsh-punky/presets/jiufeng | Punky Mode preset: Leader persona + governance discipline + tool-bootstrap |
| Guide | packages/dsh-punky/skills/jiufeng-team | 3-layer 8-role × skill assembly table + constitution + templates |

## Install

> Agent-friendly, runnable steps; `web` is an example profile — replace with yours.

### 1. Get the plugin (GitHub)

```sh
git clone https://github.com/Punky971210/dsh-punky-swarm.git
cd dsh-punky-swarm
```

### 2. Mount the plugin

```sh
# POSIX
dsh plugin --profile web add link:$(pwd)/packages/dsh-punky
# Windows PowerShell
dsh plugin --profile web add link:$PWD\packages\dsh-punky
```

### 3. Install the mode preset (delete target first if it exists)

```sh
rm -rf ~/.dsh/.agent-presets/jiufeng
cp -r packages/dsh-punky/presets/jiufeng ~/.dsh/.agent-presets/jiufeng
# Windows: robocopy packages\dsh-punky\presets\jiufeng %USERPROFILE%\.dsh\.agent-presets\jiufeng /E
```

### 4. Install the skill guide

```sh
rm -rf ~/.agents/skills/jiufeng-team
cp -r packages/dsh-punky/skills/jiufeng-team ~/.agents/skills/jiufeng-team
```

### 5. Verify

1. Restart dsh web, create a new session, and pick the "蟛蜞模式" preset;
2. The tool surface includes the 13 governance tools: wave_plan / batch_phase / batch_status / artifact_types / assign_check / gate_status / lane_claim / lane_release / member_status / member_settle / mailbox_send / mailbox_read / mailbox_ack;
3. Skill in place: `ls ~/.agents/skills/jiufeng-team/SKILL.md`.

> Once published on npm: `dsh plugin --profile web add dsh-punky-swarm` (preset/skills still need steps 3–4; source paths are presets/ and skills/ inside the installed package).

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
