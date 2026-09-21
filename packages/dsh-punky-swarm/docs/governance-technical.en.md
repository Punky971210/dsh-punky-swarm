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
        (idle = **the idle state** (literally idle, NOT a crash state) → running = rework/resume re-dispatch; review -> running = rework)
Batch: planning -> running -> paused -> aborted | complete
       (complete requires the three-layer gates first)
```

- Batch phase transitions: `batch_phase` (planning→running→paused→aborted|complete); writes are rejected after a terminal state;
- **paused three sources**: manual `batch_phase(paused)`; or automatic failure escalation — ≥3 consecutive failures in the batch (`reason='failed-escalate'`); or guardrail-violation count escalation — with `governance.hook.escalation` enabled, rule refusals (DENY/NARROW) attributed to the batch reaching ≥3 within the 10-minute window (`reason='governance-escalate'`, threshold/windowMs/primitives configurable); all transition to paused after the ratchet check; recovery = manual `batch_phase(running)`.
- Member state operations: pending→running (dispatch) / running→review (submit for review) / **idle→running (idle-state re-dispatch: rework/resume; `idle` is NOT a crash state)**; terminal settlements merged/failed/skipped/conflict go through `member_settle`, which runs the corresponding gate validation (Plan-contract validation before plan merged, outputs validation before exec merged, produce validation before audit merged);
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

Tasks in the same wave dispatch in parallel; the **concurrency declaration** is set at batch creation (**it no longer takes part in runtime admission** — the concurrency gate was removed by ruling Q-B on 2026-09-18: no over-limit rejection and no queueing; the field is declaration plus echo only).

> For the topology truth source (`tasks[].deps` + `batch.handoffs`), the read-side contract after the chain declaration was retired, the handoff gate (`handoffGate`) default visibility, and the session channel contract, see `docs/chain-retirement-and-topology-20260918.md`.

## 4. Task Difficulty Gate

Before any action on each (user) turn, the Leader must **actively write** the task difficulty and execution entity via `assign_check({ difficulty, rationale, scope: "full" })` (**no default tier** — omitting them is rejected):

| Difficulty | Execution entity | Applicable |
|---|---|---|
| A | Leader direct | single-threaded (no parallel task lines, no dependency chain), low risk, self-verifiable (zero governance overhead) |
| B | single worker | **only two cases**: ① research that needs an independent subagent so it does **not consume the main Agent's context** (reading code / long documents / running probes); ② any other **already well-scoped, easily dispatched** single-step task |
| C | batch (wave_plan) | **criterion (highest priority): clear multi-line parallelism** (≥2 task lines that can progress in parallel) **or multi-dependency** (a dependency chain between tasks requiring DAG layering / multiple waves); **single-threaded tasks never open a batch** (step count / word count is not grounds for escalating to C) |

- **Actively written, no default tier**: `difficulty` (enum `A|B|C`, **required**) and `rationale` (criterion, **required**, ≥12 characters) are written by the Leader, landing in `governance.json` as `lastAssign{ difficulty, rationale, derived, override, form, reasons }` + `history` for audit; a missing `difficulty` (or a value outside `A|B|C`, `C+` included) is always rejected — the **externally observable form is the tool-parameter schema layer** (`invalid arguments: "difficulty" must be one of ["A","B","C"]`), while the code `GATE_DIFFICULTY_INVALID` is the name of the same refusal on the **kernel's explicit branch** (visible only on call paths that bypass the schema — **do not grep for it as an external error code**); a missing/too-short `rationale` behaves the same way (schema `missing required property "rationale"` ⇔ kernel `GATE_DIFFICULTY_RATIONALE_MISSING`); the old "default to C" / "when unsure, fill C" wording is **retired**; the evaluation object is the complete target task (scope=full, including future steps);
- **Boolean features demoted to cross-checks, plus explained deviation (user ruling B, 2026-09-14)**: `parallel` / `multiRole` / `gate` / `recoverable` / `needIsolation` no longer decide the tier on their own — they are check inputs from which the engine computes **`derived`** (any C criterion → `C`; else `needIsolation` → `B`; else `A`). `difficulty` **equal to `derived` passes as usual** (`override:false`); **when they differ, only an explained deviation passes** (`override:true`) — an explanation means the `rationale` carries all three elements: ① a reference to the concrete feature, ② an exception/counterexample, ③ the deviation direction and its upper bound; missing any of them is rejected as `GATE_DIFFICULTY_MISMATCH` (the message lists what is missing). Example: declaring C while all four criteria are false passes when the rationale gives the exception ("three fix-up lines are serial but long-running") and a bound; an **unexplained** declaration of the same shape is still rejected (including "single-threaded work casually reported as C");
- **Read-only reconnaissance surface**: `read` / `glob` / `grep` and **read-only shell commands** (pwsh/bash, judged at **command level**, implemented in `lib/tools/readonly.js`: read-only allowlist + write-indicator rejection + default-deny) are allowed in **any assessment state and are not counted** (they do not consume the `execCallsSince` assessment window); execution-type tools (write/edit/**non-read-only shell**/subagent …) still require a prior assessment. **Boundary (stated as-is)**: this judgment is **heuristic, not a sandbox** — it can be bypassed via aliases, script files, escaped arguments or encodings, and only closes the main path of "unconsciously using write commands for reconnaissance"; it does **not** promise OS-level isolation equivalence; **judging rules (revised after the 2026-09-14 review)**: quoted literals are **masked first** (a `>` / `|` / `;` inside quotes no longer takes part in judging — this fixes false denials), `2>&1` / `2>$null` count as **stream merging** and are allowed (real redirection is still denied), assignment prefixes (`$x = ` / `x=`) and `git` prefix options (`-C <dir>` / `--no-pager` / `-P` / `--paginate`) are **stripped before** the remaining command is judged, and an unclosed quote fails closed; interpreter commands such as `node` / `pnpm` / `python -c` are still judged **execution-type** (by design, not a defect);
- **The C+ tier is withdrawn (difficulty tier)**: the difficulty enum is `A|B|C` only; "C+ tier" no longer appears. The assembly surface is **decoupled from the difficulty tier**: a **three-layer batch** (any task declaring `layer`) must pass `assembly` at batch creation (widened on 2026-09-14; previously "≥3 exec-layer lanes"; missing → rejected with `GATE_ROLE_ASSEMBLY_MISSING`); `auditLane` is required and must point at an audit-layer lane of this batch, and **`managerPlan` defaults to `raise`** (omit it and the Manager is raised at batch creation; write `leader-direct` explicitly only when the Leader must drive directly). **The completion-time warning is triggered by the declaration**: the close-of-batch warning (`gate.manager_missing`) has been **removed (2026-09-22 user ruling)**: an unregistered Manager on the roster is recorded at build time via `gate.manager_roster_gap` instead. Former behavior: a batch declaring `raise` that never registered `batch.manager` emitted `{execLanes, managerPlan}`; **batches declaring `leader-direct` are no longer falsely reported** (the old lane-count trigger contradicted the declaration);
- **Guard gate 1 tightened**: legacy records (with `form` but no `difficulty`) are treated as **unassessed** and must be re-assessed once;
- **Tier × tooling coherence (G1, user ruling 2026-09-14)**: `wave_plan` / `member_status` / `member_settle` **all require the current session to have written `difficulty: 'C'`** — unassessed / A / B calls are rejected with `GATE_BATCH_REQUIRES_C` (batch creation) and `GATE_MEMBER_REQUIRES_C` (member state), implemented in `lib/tools/core.js#assertMemberActionTierC` (call sites: `wave_plan` / `member_settle` / `member_status`). **Strict mode**: unassessed is punished the same as A/B. **Narrowed ruling (user ruling Q2=B, 2026-09-15: "members exist as sessions only; they may not write state")**: **parent-tier inheritance is removed** — batch creation recognises **only the caller session's own C tier** (worker / Manager child sessions can never create a batch; the B tier carries single-step independent tasks and never enters `wave_plan`); member state may be written only by **the caller session holding C itself (the Leader)** or by **the batch's registered Manager session** (`batch.manager.agentId`; host semantics: a continuable `subagentId = childId = session id`). The tier read is anchored on the **caller**, not on the batch's owning session, so a worker cannot bypass it by reusing the C-tier batch session's `session` argument. Doctrine: member collaboration has exactly **one track** — assess C → create the batch → raise the Manager on creation → Manager/Leader dispatch and settle; A/B `subagent` stays limited to "research that does not occupy the main context" or "a single dispatchable step with clear context";
- **Mirroring is raise-only (Q4=B, user ruling 2026-09-15)**: when an explicit `session` differs from the execution session, `assign_check` **mirrors** the assessment into the execution session (guard compatibility). Mirroring **only raises** — if the execution session already holds a **stronger** tier (rank `C > B > A`), the mirror is **skipped** (`notice` echoes "mirror skipped"; `mirroredTo` is not written) and the execution session's own `lastAssign` / `pendingBatch` stay untouched. Motivation (observed): writing a fixture for another session silently downgraded the Leader's own C record. Equal-or-higher mirrors still proceed.
- **Raise on batch creation (G2, user ruling A 2026-09-14: hard gate moved forward)**: for a batch with `assembly.managerPlan === 'raise'` (including the defaulted value), `batch.manager` must already be registered (`batch_phase({ batchId, manager: { agentId } })`) **before the first exec-layer lane is dispatched**; otherwise the entry gate rejects the dispatch with `GATE_MANAGER_NOT_RAISED` (implementation `lib/state/gates.ts#checkEntryGate`). Boundaries: ① only **exec**-layer lanes are blocked (plan-layer design/planning may precede the raise); ② the judgment goes through `reject()` ⇒ it inherits **G-1 "the idle state must never be blocked"** (when a lane is `idle` = **the idle state**, not a crash state — rework/resume may call it — the strict condition degrades to a warned pass + trace); ③ batches declaring `leader-direct` are exempt. Same source as the completion warning `gate.manager_missing` (`managerPlan`): one blocks up front, the other audits afterwards;
- **guard enforced**: after a C judgment, calling execution-type tools without creating a batch is rejected by the engine; unassessed or expired assessments (20 execution calls or 30 minutes) are likewise rejected; read-only queries unrestricted;
- **guard window**: the assessment state expires on both an execution-call counter and a time basis;
- **asset claim-back**: exploration/troubleshooting artifacts the Leader produced directly before a C judgment can be claimed as batch assets via `asset_claim` (copied into the batch artifact root), no rework.

The difficulty gate and the call-level guardrail stack serially: when the kernel judges ALLOW → the difficulty gate applies as usual; when the kernel judges deny/ask → the difficulty gate no longer participates (invariant: the difficulty gate can only tighten, never be bypassed).

## 5. Lifecycle

- **lane conditions**: statically declared at batch creation (dependency artifacts/files exist), validated before dispatch, unsatisfied → skipped;
- **archive auto-archiving**: after complete, one-way auto-archive (artifacts packaged and kept queryable, not rollback-able);
- **needHuman hold**: audit artifact declares needHuman → lane held at review, Manager relays the human verdict (merged/conflict), no new member state;
- **ratchet rule table**: state-transition config (delete-only, never add; allowRelax escape hatch default off); **effective at assembly time** (`createStore({ rules: loadRules(config) })`, wired 2026-09-15) — **hot reload does not apply it**: a `ratchet` change in `runtime.json` goes through the hot-reload guard (`ratchetHotGuard`) which **validates on the spot and warns "restart required"** (an illegal change is likewise warned on the spot, but the boot assembly will still fail closed), never silently swallowed;
- **recovery mechanism**: checkpoint preservation + recovery audit + **in-flight lanes drop to `idle` (the idle state) and may be re-dispatched (rework/resume)** (new workers can query checkpoints to skip completed steps); failed lanes stay terminal, redo opens a new batch (no automatic resume).

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
| `assign_check` | Task difficulty **actively written** (`difficulty` A/B/C + `rationale` criterion, both required, no default tier) and execution entity (guard gate basis; `parallel`/`multiRole`/`gate`/`recoverable`/`needIsolation` are cross-checks only) |
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
| `lane_heartbeat` | Lane heartbeat query/trigger (watchdog scan, stalled marking; lane omitted → returns all running lanes of the batch) |
| `lane_longrun` | Lane longrun probe query/trigger (longrun tier: runningSince/duration/no-progress window/candidate state; lane omitted → returns all running lanes of the batch; registered when both the watch and longrun sub-switches are on) |

Watch consumption for batches without a Manager (or while the Manager is absent) falls to the Leader: on each worker settlement or confirmed idle, the Leader checks `mailbox_read(broadcast)` for longrun.candidate broadcasts and cross-checks probe state (candidate/emitted/reason) with `lane_longrun` (whole-batch default); a hit candidate is handled as a semi-automatic redispatch — keep observing while the lane has recent checkpoints/activity, stop-and-redispatch or reopen the batch when there is genuinely no progress, and escalate doubtful cases to the user; once a Manager is raised, scheduling returns to the Manager.

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
| Heartbeat/expiry detection | `capabilities.watch` | on | watchdog timer + lane_heartbeat; backoff-tier follow-ups + N consecutive no-activity beats → lane.stalled mark (mark only, no automatic disposition); hot-apply/restart-reconcile surface = 5 keys {`enabled`, `longrun.enabled`, `scanIntervalMinutes`, `longrun.maxDurationMs`, `longrun.noProgressWindowMs`} — longrun thresholds can be set via the governance-config page form (minutes→ms) or runtime.json and take effect on hot-apply/restart |
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

## 9. longrun 长程豁免与探针语义（Long-running Exemption and Probe Semantics）

> This section covers the **exemption attribute**, the **scan-surface boundary**, and the **cold-window invariant** of the longrun tier (§6 "Heartbeat and expiry detection"). **Out of scope**: probes over bare subagents, and call-level guardrails (see [guardrails-hook.en.md](guardrails-hook.en.md)).

### 9.1 Exemption attribute semantics

An exemption is **attached by the Leader at the dispatch surface** (`member_status`, `pending→running` / `idle→running`): **members cannot modify it themselves**, and **revocation must be an explicit call** (`revokeExempt` → `lane.exempt.revoked`). The semantics widen the **threshold by a multiplier**; they do not switch the probe off:

| Tier | Default multiplier | Effective threshold `effectiveMaxDurationMs` | Default absolute window (`maxDurationMs` defaults to 20 min) |
|---|---|---|---|
| `none` (no exemption) | 4 | 20 min × 4 | 80 min |
| `dep-install` | 4 | 20 min × 4 | 80 min |
| `large-download` | 6 | 20 min × 6 | 120 min |
| `ai-render` | 8 | 20 min × 8 | 160 min |

- An exemption **only widens the duration threshold** (candidates appear later); it **does not widen `noProgressWindowMs`**;
- `stalled` linkage: an exempt lane is **also exempt from stalled follow-ups**, but an **exempt lane must still write checkpoints / heartbeats** (for human inspection and near-window reading);
- Timeout re-dispatch **still applies** (candidates are judged as usual after `n × multiplier`), and the no-progress criterion stays a strict AND;
- The grant / revoke event payload always writes the exemption type as `exemptType`; the candidate object carries a separate `exempt` key with the exemption state snapshot — **the two keys belong to different payloads**, do not conflate them.

### 9.2 Scan-surface boundary and error codes

| Item | Boundary |
|---|---|
| longrun scan surface | **punky-preset batch lanes only** (`phase = running ∧ lane = running`), judging duration and progress batch by batch, lane by lane |
| Bare subagent | **excluding bare subagents** — **outside the scan surface** (no lane, no persistent batch state, no event/progress signal) — dispatching to a bare subagent leaves longrun protection and stalled follow-ups behind; therefore C-tier batch execution always goes through wavePlan lanes (D-1, a searchable anchor) |
| Stale batch (D-4) | a batch with no activity beyond `staleBatchMs` (default 24 h) → the **whole batch is skipped** (guard against false re-dispatch of long-archived batches); `staleBatchMs = 0` is an **explicit switch-off** (`0` must be written to get escape-valve semantics) — it affects the longrun tier only, never the stalled surface |
| Unconsumed candidate (D-2) | candidates / follow-ups **must leave an ack trace** (the `isAcked` criterion); an ack missing beyond `unconsumedTimeoutMs` → the `lane.longrun.unconsumed` event |
| Dual delivery (D-3) | a candidate goes to both broadcast and `supervisor/inbox`; the two `ackId`s are mutually independent, so **each needs its own ack** |

### 9.3 Restart cold window (zero delta ≠ failure)

**A process restart drops in-flight lanes to `idle` (the idle state, not a crash state)**; after re-dispatch `runningSince` is reset → within `maxDurationMs × multiplier` a longrun candidate is **structurally impossible**:

| Tier | Cold-window length |
|---|---|
| default / `dep-install` / `none` (4×) | **80 min** |
| `large-download` (6×) | **120 min** |
| `ai-render` (8×) | **160 min** |

A zero delta inside the window **must not** be read as probe failure — it is a **structural impossibility**, not probe silence; observation becomes meaningful only after the window elapses.

### 9.4 Non-git progress signal and honest boundary

- **Narrowed scan surface**: the `<lane>/progress/` subtree + `<lane>/*.md`;
- **Progress snapshot**: land a `<lane>/progress/NN-<slug>.md` immediately after each sub-step (with `step N/total` and the artifact location; never batch them up) — it preserves resumption (a new worker after a crash reads the snapshot to skip completed steps; **physical retention only, no automatic resume**) and it is the probe's **only progress signal** on the non-git surface; the cause: a lane writing or reading code produces no events and lands no artifacts → the probe and the liveness reading **both judge "no progress"**, so a missing snapshot reads as stalled;
- **Honest boundary**: **the tool layer has no caller identity** — the engine **cannot determine the caller's identity** and cannot rule out a proxy action or a manual file edit; the structural enforcement is limited to "a running lane has no running/idle successor", which provides **recording and visibility**, **not access control**.

### 9.5 Gate error codes (exemption-related)

| Error code | Trigger |
|---|---|
| `GATE_EXEMPT_NOT_DISPATCH` | an exemption parameter on a non-dispatch surface (`to !== 'running'`), or an exemption with neither dispatch nor revocation |
| `GATE_EXIT_MISSING_EXEC` | exec-layer outputs settled before landing on disk (§1.2 Exit gate; not an exemption feature) |

