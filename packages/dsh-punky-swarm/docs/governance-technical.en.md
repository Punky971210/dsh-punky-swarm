# Governance Engine Technical Manual (batch level)

> This document describes the batch-level governance engine of dsh-punky-swarm: three-layer gates, state machines, the wavePlan contract, the task difficulty gate, lifecycle, governance tools, assembly keys, and architectural boundaries. Call-level guardrails (6-primitive kernel) live in [guardrails-hook.en.md](guardrails-hook.en.md); capability-boundary declarations live in [governance-boundaries.en.md](governance-boundaries.en.md).
> 中文: [governance-technical.md](governance-technical.md)

Governance has two layers; this document covers the batch level, call level is in guardrails-hook.en.md:

| Layer | Mechanism | Location | Semantics |
|---|---|---|---|
| Task level (before dispatch) | Task difficulty gate (`ctx.tools.guard`) | assessment/batch-creation state machine | "whether this execution-type call is allowed to happen" |
| Call level (at execution time) | guardrail hook pre-execute kernel | `tools/pre-execute` event chain | "whether this call's parameters/tools are out of bounds" (rule table) |

## 1. Three-Layer Gates (Tier3)

Tasks inside a batch are layered by `layer`: plan (produce a design) → exec (implement) → audit (review). generic batches (tasks without a layer declaration) do not trigger gates; behavior is backward compatible.

### 1.1 Static validation at batch creation

Validated by wave_plan at batch creation:

- `layer` ∈ plan/exec/audit;
- exec implies audit (the audit layer consumes exec artifacts for acceptance);
- artifact path contract: consume/produce/outputs all resolve under the batch artifact root;
- cross-layer references are legal (consumed artifacts must be produced by a prior layer);
- state-file tamper resistance (single source of truth + auditable event log).

### 1.2 Per-layer gates

| Gate | Trigger | Validation | Failure disposition |
|---|---|---|---|
| Entry | before exec dispatch | consume artifacts complete | dispatch rejected `GATE_ENTRY_MISSING` |
| Plan contract (artifact structure) | before plan settlement | required spec sections (acceptance criteria/constraints) + valid-JSON task tree | merged rejected `GATE_PLAN_CONTRACT` |
| Exit (artifacts) | outputs landed before exec settlement; produce landed before audit settlement | artifact existence | merged rejected `GATE_EXIT_MISSING_*` |
| Complete (closing) | before batch complete | audit-layer acceptance done with no failed/conflict; exec layer fully terminal | complete rejected `GATE_COMPLETE_*` |

Gate state is queryable via `gate_status` (consume/produce/outputs missing-item lists); batch and lane state use the state file as the single source of truth.

## 2. State Machine

```
Member: pending -> running -> review -> merged | failed | skipped | conflict
        (idle = recovery re-dispatch; review -> running = rework)
Batch: planning -> running -> paused -> aborted | complete
       (complete requires the three-layer gates first)
```

- Batch phase transitions: `batch_phase` (planning→running→paused→aborted|complete); writes are rejected after a terminal state;
- **paused three sources**: manual `batch_phase(paused)`; or automatic failure escalation — ≥3 consecutive failures in the batch (`reason='failed-escalate'`); or guardrail-violation count escalation — with `governance.hook.escalation` enabled, rule refusals (DENY/NARROW) attributed to the batch reaching ≥3 within the 10-minute window (`reason='governance-escalate'`, threshold/windowMs/primitives configurable); all transition to paused after the ratchet check; recovery = manual `batch_phase(running)`.
- Member state operations: pending→running (dispatch) / running→review (submit for review) / idle→running (recovery re-dispatch); terminal settlements merged/failed/skipped/conflict go through `member_settle`, which runs the corresponding gate validation (Plan-contract validation before plan merged, outputs validation before exec merged, produce validation before audit merged);
- When a lane declares targets, each is verified to be on disk before merged (missing → merged rejected `GATE_TARGET_MISSING`, unchanged → `GATE_TARGET_UNCHANGED`);
- When an audit-layer artifact contains a standalone `needHuman: true` line, merged requires human adjudication evidence (contract `human:<adjudicator>:<time>:<conclusion>`); missing → merged rejected `GATE_NEEDHUMAN_PENDING`.

## 3. wavePlan Task Declaration Contract

At batch creation, tasks are layered into waves by dependency DAG; **never recomputed mid-flight after creation** (fixed semantics). Declarable task fields:

| Field | Description |
|---|---|
| `layer` | plan / exec / audit (basis for the three-layer gates) |
| `consume` | dependent in-batch artifacts (relative to the batch artifact root; must be complete before exec dispatch) |
| `produce` / `outputs` | this task's outputs (relative to the batch artifact root; must be on disk before settlement) |
| `role` | role (team assembly injects skill prefixes by role; pluggable, not bound to a specific team) |
| `skills` | explicit skill prefixes |
| `deps` | inter-task dependencies (forming the DAG → waves) |

Tasks in the same wave dispatch in parallel; the concurrency cap is declared at batch creation.

## 4. Task Difficulty Gate

Before any action on each (user) turn, `assign_check` must give a task difficulty and execution entity:

| Difficulty | Execution entity | Applicable |
|---|---|---|
| A | Leader direct | single-step verifiable, low risk, single role, no external dependency (zero governance overhead) |
| B | single worker | single role but needs an independent context/tool surface |
| C | batch (wave_plan) | multi-step ≥3 / multi-role ≥2 / gate needed / external dependency / recoverability needed — any one hit → C |

- **default to C**: the evaluation object is the complete target task (scope=full, including future steps); when unsure, fill C;
- **guard enforced**: after a C judgment, calling execution-type tools without creating a batch is rejected by the engine; unassessed or expired assessments (20 execution calls or 30 minutes) are likewise rejected; read-only queries unrestricted;
- **guard window**: the assessment state expires on both an execution-call counter and a time basis;
- **asset claim-back**: exploration/troubleshooting artifacts the Leader produced directly before a C judgment can be claimed as batch assets via `asset_claim` (copied into the batch artifact root), no rework.

The difficulty gate and the call-level guardrail stack serially: when the kernel judges ALLOW → the difficulty gate applies as usual; when the kernel judges deny/ask → the difficulty gate no longer participates (invariant: the difficulty gate can only tighten, never be bypassed).

## 5. Lifecycle

- **lane conditions**: statically declared at batch creation (dependency artifacts/files exist), validated before dispatch, unsatisfied → skipped;
- **archive auto-archiving**: after complete, one-way auto-archive (artifacts packaged and kept queryable, not rollback-able);
- **needHuman hold**: audit artifact declares needHuman → lane held at review, Manager relays the human verdict (merged/conflict), no new member state;
- **ratchet rule table**: state-transition config (delete-only, never add; allowRelax escape hatch default off);
- **recovery mechanism**: checkpoint preservation + recovery audit + crash→idle re-dispatch (new workers can query checkpoints to skip completed steps); failed lanes stay terminal, redo opens a new batch (no automatic resume).

## 6. Governance Tool Reference

Tools are grouped by function; registration is controlled by assembly keys (see §7); `log_export` is registered only when `capabilities.logs` is enabled.

### Batch planning

| Tool | Description |
|---|---|
| `wave_plan` | Create batches layered into waves by dependency DAG (fixed semantics, never recomputed after creation) |
| `batch_phase` | Batch phase transitions (planning→running→paused→aborted/complete) |
| `batch_status` | Query batch status (phase/lanes/wavePlan/event summary) |

### Task grading and gates

| Tool | Description |
|---|---|
| `assign_check` | Task difficulty judgment A/B/C and execution entity (guard gate basis) |
| `gate_status` | Query lane gate status (consume/produce/outputs missing-item lists) |
| `artifact_types` | Query artifact type registry (layer/directory prefix conventions) |

### Assets and locks

| Tool | Description |
|---|---|
| `asset_claim` | Claim Leader-produced artifacts as batch assets (copied into the engine artifact root) |
| `lane_claim` | Claim a lane with an O_EXCL single-writer lock (conflict rejected first) |
| `lane_release` | Release a lane lock |

### Member status

| Tool | Description |
|---|---|
| `member_status` | Member status operations (pending/running/review/idle) |
| `member_settle` | Member settlement (merged/failed/skipped/conflict, with gate validation) |

### Communication (mailbox)

| Tool | Description |
|---|---|
| `mailbox_send` | Send messages (inbox/outbox/broadcast, atomic write + ackId) |
| `mailbox_read` | Read unacknowledged messages |
| `mailbox_ack` | Acknowledge consumed messages |

### Heartbeat and expiry detection

| Tool | Description |
|---|---|
| `lane_heartbeat` | Lane heartbeat query/trigger (watchdog scan, stalled marking) |

### worktree physical isolation

| Tool | Description |
|---|---|
| `lane_worktree_create` | Create an independent git worktree for a lane (baselined from the integration-branch HEAD) |
| `lane_worktree_merge` | Merge a lane branch into the integration branch (conflict preserves scene + manifest) |
| `lane_checkpoint` | In-lane checkpoint commit (git add+commit, preserves artifacts) |
| `lane_checkpoint_status` | Query checkpoint history and progress (resume-contract entry point) |

### Logs

| Tool | Description |
|---|---|
| `log_export` | Read-only event-stream export (lane/type/since filters + json/markdown + engine artifact root landing) |

## 7. Assembly Keys

Assembly is centralized in `cordis.patch.yml`; runtime overrides are covered in the hot-update section of guardrails-hook.en.md. Key semantics follow the code facts (`lib/assembly/schema.js` CAPABILITY_REGISTRY is the single source of truth for the registry):

| Capability | Assembly key | Default | Mechanism |
|---|---|---|---|
| Discovery service (ADP) | `capabilities.discovery` | on | Mounts `POST /api/dsh-punky-swarm/discover` + `GET /.well-known/aip`; nodes can hide per-node with active=false |
| Diagnostics bridging | `capabilities.trajectory` | on (autoFail=false) | anomaly diagnosis → sessionId→lane mapping → notify; auto-failed only when autoFail=true (failConfidence threshold) |
| Mailbox loop protection | `capabilities.budget` | on (hops=4 / roundTrips=2) | checkBudget before outbox/broadcast sends; inbox (Leader downlink dispatch) never limited |
| Heartbeat/expiry detection | `capabilities.watch` | on | watchdog timer + lane_heartbeat; backoff-tier follow-ups + N consecutive no-activity beats → lane.stalled mark (mark only, no automatic disposition) |
| worktree physical isolation | `capabilities.worktree` | on | lane_worktree_create/merge/checkpoint; complements the lane_claim logical lock |
| Acceptance evidence | `capabilities.verify` | on (mode=advisory) | post-execute evidence capture (content-addressed blob + ledger); three-state adjudication (done/failed/blocked); intercepts when mode=enforce |
| Log export | `capabilities.logs` | off | log_export tool registration (explicitly enabled by the patch) |
| topic subscription | `capabilities.topic` | off | subscribeTopic/emitTopic: in-process dispatch + mailbox broadcast landing |
| Conflict-resolution agent | `capabilities.worktree.mergeAgent` | off | requires a host-injected spawner; without injection the conflict stays in conflict state |
| AIP catalog/endpoint | `aip.enabled` | on | tool 6-attribute catalog + `GET /api/dsh-punky-swarm/tools` |
| Identity system | `aip.identity.enabled` | off | AIC/CAI/signing/trust chain (details in aip-compliance.en.md) |
| ACPs communication | `acps.*` | all off | mTLS endpoint/bridge/registry/discovery (details in acps-communication.en.md) |
| Call-level guardrails | `governance.hook` | on (empty rules = zero interception) | 6-primitive kernel pre/post adjudication (details in guardrails-hook.en.md) |

Assembly-switch semantics: `enabled` defaults merge the registry default; explicit `enabled: false` disables the capability (tool not registered, hook not mounted, zero runtime path). `mergeAgent` requires a host-injected spawner.

## 8. Architectural Boundaries

- **In-process governance**: batches/gates/state machine/communication all run inside the dsh plugin process; the governed objects are a cohort of Agent subprocesses orchestrated in the same process;
- **Zero external dependencies**: the engine uses native Node.js capabilities (node:fs / node:crypto / node:https / node:tls); peer dependencies are the host runtime only (@deepseek-ai/dsh-tools, @deepseek-ai/cordis);
- **Network capabilities off by default**: network capabilities such as ACPs are all off by default; when off there are no listeners, no timers, no network paths (zero runtime footprint);
- **Single-machine boundary**: oriented at in-process single-machine governance; cross-machine distributed sync and multi-machine orchestration are not provided — see [single-machine-capabilities.en.md](single-machine-capabilities.en.md).
