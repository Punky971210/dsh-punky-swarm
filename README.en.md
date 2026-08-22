# dsh-punky-swarm — Punky Swarm

![license](https://img.shields.io/badge/license-AGPL--3.0-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green) ![CI](https://github.com/Punky971210/dsh-punky-swarm/actions/workflows/ci.yml/badge.svg)

> **Single-machine multi-subagent swarm governance** for DeepSeek Harness (dsh): fixed-semantics wavePlan (3-layer DAG, never recomputed after creation) + engine-enforced gates (Entry / Plan-contract / Exit / Complete) + state machine + locks/mailbox + session isolation + task-difficulty routing gate + GB-standard AIP compatibility + governance enhancements (watchdog heartbeat, worktree isolation, verification evidence, mailbox budget loop-protection, trajectory bridge, log export). Ships with the Punky Mode preset and the jiufeng-team role assembly guide.

中文: [README.md](README.md)

## Scope

- **Goal**: single-machine multi-subagent governance on one dsh process (batching / gates / communication / reset-on-recover);
- **Out of scope**: cluster sync, cost control, model-tier routing; resume provides checkpoint preservation + recovery audit only (failed lanes stay terminal, redo = new batch).

## Design purpose and origin

**Purpose**: the gates (Entry / Plan-contract / Exit / Complete), batching, locks and mailbox exist first and foremost to **keep the pipeline and the cluster stable** — not to constrain agents. The tool layer is fully open to agents; the mode layer only guides; team assembly is pluggable; work is graded by scale (Leader dispatch → single-agent fallback).

**Origin**: this project grew out of the trade-off between a single agent running the whole loop and graph-based orchestration:

- Single agent, full loop (design → implement → test): heavy human intervention — the human becomes the bottleneck;
- Graph-based orchestration (LangGraph direction): tried and dropped — the flow is frozen into a graph, expensive to change, squeezes agent freedom;
- Middle path: the "Jiufeng" work mode (Leader decomposition → multi-role collaboration → gate verdicts) was built on an early Swarm cluster runtime, then migrated to dsh as this plugin.

## The Three Pieces

| Piece | Location | Content |
|---|---|---|
| Plugin | packages/dsh-punky-swarm | Engine: **20 governance tools** + Tier3 gates + session v2 + read-only API (incl. AIP /tools · /agents · /discover endpoints) + task difficulty gate + Punky swarm monitor |
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

> npm is also available: `npm install -g dsh-punky-swarm` (version in [package.json](packages/dsh-punky-swarm/package.json)); git source + dsh plugin link remains the dev/debug path.

### npm install

```sh
npm install -g dsh-punky-swarm
dsh plugin --profile web add dsh-punky-swarm
dsh web restart
```

> The `dsh plugin add` usage for the npm package is subject to verification after release (as of 0.3.1).

## Punky swarm monitor (read-only)

The plugin ships a **Punky swarm** monitor tab as the third tab of the conversation view header (对话 / 轨迹 / 蟛蜞集群). Available right after install, no extra config.

- **Batch list**: phase (planning/running/complete…) + terminal progress `3/5` + auto-release/done markers;
- **Stats strip**: total / running / done / issues (failed+conflict);
- **Batch detail**: lane state cards (status + task summary + gate-missing details + layer/deps), event timeline, mailbox (dispatch/broadcast) counts;
- **Read-only**: 3s auto-refresh; follows the Web UI light/dark theme. The execution engine (batches / gates / state machine) cannot be modified by humans — view only; governance actions are driven by the Punky Mode Leader.

## Governance Tools (20)

Grouped by function:

### Batch planning
| Tool | Description |
|---|---|
| `wave_plan` | Layer tasks into waves by dependency DAG and create a batch (fixed semantics, never recomputed) |
| `batch_phase` | Batch phase transition (planning→running→paused→aborted/complete) |
| `batch_status` | Query batch state (phase/lanes/wavePlan/event summary) |

### Task grading & gates
| Tool | Description |
|---|---|
| `assign_check` | Task difficulty assessment A/B/C with execution owner (guard gate basis) |
| `gate_status` | Query lane gate state (consume/produce/outputs missing lists) |
| `artifact_types` | Query artifact-type registry (layer/dir prefix conventions) |

### Assets & locks
| Tool | Description |
|---|---|
| `asset_claim` | Claim Leader-produced artifacts as batch assets (copy into engine artifact root) |
| `lane_claim` | Claim a lane with an O_EXCL single-writer lock (conflict rejects first) |
| `lane_release` | Release a lane lock |

### Member state
| Tool | Description |
|---|---|
| `member_status` | Member state operations (pending/running/review/idle) |
| `member_settle` | Member settlement (merged/failed/skipped/conflict, with gate checks) |

### Communication (mailbox)
| Tool | Description |
|---|---|
| `mailbox_send` | Send a message (inbox/outbox/broadcast; atomic write + ackId) |
| `mailbox_read` | Read unacknowledged messages |
| `mailbox_ack` | Acknowledge message consumption |

### Heartbeat & staleness
| Tool | Description |
|---|---|
| `lane_heartbeat` | Lane heartbeat query/trigger (watchdog scan, stalled marker) |

### Worktree isolation
| Tool | Description |
|---|---|
| `lane_worktree_create` | Create an isolated git worktree for a lane (baseline from orch HEAD) |
| `lane_worktree_merge` | Merge a lane branch into orch (conflict keeps the scene + file list) |
| `lane_checkpoint` | In-lane checkpoint commit (git add+commit, artifact preservation) |
| `lane_checkpoint_status` | Query checkpoint history & progress (resume-contract entry) |

### Logging
| Tool | Description |
|---|---|
| `log_export` | Read-only event-stream export (lane/type/since filters + json/markdown + engine-root writeTo) |

> Capability switches (cordis.patch.yml): aip / discovery / verify / watch / worktree / budget / trajectory / logs default ON, disable per-key with `enabled: false`; identity default OFF (enable via `aip.identity.enabled: true`); mergeAgent default OFF (requires a host-injected spawner).

## GB AIP Compatibility

GB/Z 185-2026 (AI Agent Interconnection) agent-interconnection compatibility — additive only, pluggable (field names follow the reference implementation ACPs-community v2.1.0 verbatim):

- **Tool 6 attributes (GB/Z 185.7-2026 Part 7: Agent Tool Calling)**: toolId / name / description / version / inputParam / outputParam per tool (toolId = `dsh.punky-swarm.<name>`; inputParam/outputParam are JSON Schema with required always present);
- **Agent descriptor (GB/Z 185.4-2026 Part 4: Agent Description; ACS field set)**: assembly config → per-role ACS AgentCapabilitySpec (root 20 keys = 14 required: aic / active / lastModifiedTime / protocolVersion / name / description / version / provider / securitySchemes / endPoints / capabilities / defaultInputModes / defaultOutputModes / skills; 6 optional: iconUrl / documentationUrl / webAppUrl / entityUserId / entityMeta / certificate; AgentSkill 8 keys = 5 required: id / name / description / version / tags, 3 optional: examples / inputModes / outputModes; protocol 02.01); the former "14+8 attributes" (agentId/accessAddress/…) was a second-hand reading, demoted to the toLegacyDescriptor compatibility mapping layer (audit-only, not part of the external contract);
- **Message/Task/Session mapping (GB/Z 185.6-2026 Part 6)**: mailbox messages, wavePlan tasks, batch state → ACPs AIP structures (Message: id / sentAt / senderRole / senderId / dataItems / mentions; TaskCommand; Session — pure read-only mapping, ackId atomic writes preserved); `/mailbox` items and `/batch` attach ACPs projections (response unchanged when not injected);
- **Identity (GB/Z 185.2/185.3-2026 Parts 2/3, default OFF)**: AIC identity codes (prefix 1.2.156.3088 + 10-level encoding + CRC-16/CCITT-FALSE + Base36 checksum) + CAI identity certificates (CN=AIC, SAN=acps://, EAB credential) + pluggable signing (default ECDSA-P256 / optional RSA-2048) + trust-chain verification; SM2 not supported (`algorithm='sm2'` explicitly rejected); switch `aip.identity` default OFF (exposed via module API, no new governance tools);
- **Discovery (GB/Z 185.5-2026 Part 5: Agent Discovery/ADP, default ON)**: `POST /api/dsh-punky-swarm/discover` (query types explicit/exploratory/trending/filtered, 34 filter operators, error codes 40000–40005/50001) + `GET /.well-known/aip` (protocol ACPs 02.01); active semantics replace discoverable (nodes with active=false are excluded from results);
- **Switch**: `aip.enabled` (default ON when unset, explicit `false` disables) → tool 6-attribute catalog + `GET /api/dsh-punky-swarm/tools` (`?name=` filter) + ACS agent catalog + `GET /api/dsh-punky-swarm/agents`.

## Governance Capabilities

| Capability | Switch | Mechanism |
|---|---|---|
| Heartbeat/staleness | `capabilities.watch` | watchdog timer + lane_heartbeat tool; backoff probes + lane.stalled marker |
| Worktree isolation | `capabilities.worktree` | lane_worktree_create/merge/checkpoint (git worktree + checkpoint commits) |
| Verification evidence | `capabilities.verify` | post-execute evidence capture (content-addressed blob + ledger) + 3-state verdict + completion gate |
| Mailbox loop-protection | `capabilities.budget` | max chain hops / round trips / duplicate rejection; inbox exempt |
| Trajectory bridge | `capabilities.trajectory` | anomaly diagnosis (deadlock/invalid retry/goal drift) → lane mapping → notify |
| Log export | `capabilities.logs` | log_export tool: read-only event-stream projection, filters + json/markdown + engine-root writeTo (escape-proof) |
| Topic subscribe | — (pure module) | subscribeTopic/emitTopic: in-process dispatch + mailbox broadcast (ackId atomic) |
| Merge agent | `worktree.mergeAgent` (default OFF) | conflict resolution (requires a host-injected spawner; without injection the conflict stays unresolved) |

## Lifecycle

- **lane condition**: static declaration at batch creation (artifact/file existence), checked before dispatch, skipped if unmet;
- **archive**: automatic one-way archiving after complete (packaged artifacts remain queryable, non-rollback);
- **needHuman**: audit artifact declares needHuman → lane holds in review, Manager relays to a human verdict (merged/conflict), no new member state;
- **ratchet rules table**: configurable state transitions (tighten-only; allowRelax escape hatch default off);
- **recovery**: checkpoint preservation + recovery audit + idle re-dispatch after crash (new workers can query checkpoints to skip completed steps); breakpoint-resume interfaces reserved.

## wavePlan (fixed semantics)

- Tasks are layered into waves by their dependency DAG at creation; **the plan is never recomputed after the batch is created**;
- Tasks may declare layer (plan/exec/audit), consume/produce/outputs, role/skills; team assembly injects skill prefixes by role (pluggable, not bound to jiufeng);
- Waves in the same batch dispatch in parallel; batch/member state is file-backed single source of truth (auditable event log).

## Task Difficulty Gate

- **Before any mutating action in each user turn**, the Leader must report a task difficulty A/B/C via assign_check with an execution owner: A=Leader direct / B=single subagent / C=cluster (wave_plan batch);
- **default to C**: the assessed object is the full target task (scope=full); any C feature (multi-stage ≥3 / multi-role ≥2 / gates needed / external deps / recoverability) ⇒ C; when unsure, pick C;
- **guard enforcement**: after C is assessed, calling an exec-type tool (pwsh/write/edit/run/subagent, …) before batching is denied by the engine; missing or stale assessment (≥20 exec calls or 30 min) is also denied; read-only queries stay allowed;
- **asset_claim**: artifacts the Leader already produced before the C assessment can be reclaimed into the batch via asset_claim — no rework.

## Tier3 Gates

- Build-time checks: layer ∈ plan/exec/audit; exec requires audit; artifact path contract; cross-layer refs; tamper-proof plan;
- **Entry Gate**: exec dispatch requires consume artifacts, else rejected (GATE_ENTRY_MISSING);
- **Plan Contract Gate**: plan artifacts must carry required spec sections (acceptance criteria / constraints) + valid task-tree JSON, else merge rejected (GATE_PLAN_CONTRACT);
- **Exit Gate**: exec settle requires outputs, audit settle requires produce, else merge rejected (GATE_EXIT_MISSING_*);
- **Complete Gate**: batch complete requires audit acceptance done with no failed/conflict and all exec terminal (GATE_COMPLETE_*);
- **Hardening (dp1–dp4) = the above gates, engine-enforced** (mapping in skills/jiufeng-team/references/workflow.md §4): dp1 dispatch check → Entry + assign_check; dp2 completion check → Exit; dp3 review routing → review + member_settle; dp4 acceptance check → Complete — an implemented capability, hence removed from out-of-scope.

Generic batches (no layer) bypass gates for backward compatibility.

## State Machine

```
member: pending -> running -> review -> merged | failed | skipped | conflict (idle=re-dispatch; review->running=rework)
batch:  planning -> running -> paused -> aborted | complete (complete requires Tier3 gates)
```

## License & Commercial Licensing

This project is licensed solely under **GNU AGPL v3 (AGPL-3.0)**:

- You may freely use, modify and distribute it (including commercially) under [AGPL-3.0](LICENSE); if you modify it and provide it over a network, you must publish your modifications under AGPL-3.0.
- For any other license (e.g. closed-source commercial use), contact the author for permission.
