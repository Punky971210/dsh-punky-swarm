# dsh-punky-swarm — Punky Swarm (Cluster Governance)

![license](https://img.shields.io/badge/license-AGPL--3.0-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green) ![CI](https://github.com/Punky971210/dsh-punky-swarm/actions/workflows/ci.yml/badge.svg)

> A dsh (DeepSeek Harness) **single-machine multi-subagent cluster governance** plugin: wavePlan three-layer DAG (fixed semantics, never recomputed after batch creation) + engine-level gates (Entry / Plan contract / Exit / Complete) + state machine + lock/mailbox + session isolation + task difficulty routing gate + national-standard AIP compatibility + governance capability enhancements (heartbeat/watchdog, worktree physical isolation, acceptance evidence, mailbox loop protection, diagnostics bridging, log export). Ships with the Punky Swarm preset and jiufeng-team role guide.

中文: [README.md](README.md)

## Scope

- **Goal**: dsh **single-machine multi-subagent governance** — govern a cohort of workers inside the same dsh process (batches / gates / communication / recovery re-dispatch);
- **Out of scope**: distributed cluster sync, cost control, model tiering; resume only provides checkpoint preservation and recovery audit (failed lanes stay terminal, redo opens a new batch).

## Design Purpose and Origins

**Purpose**: gates (Entry/Plan contract/Exit/Complete) together with batches, locks, mailbox and other mechanisms exist to **keep the pipeline and the cluster stable**, not to restrict agent freedom — the tool layer is fully open to agents, the pattern layer only guides, and team assembly is pluggable; tasks are graded by size (Leader assignment → single-agent fallback).

**Origins**: this project grew out of the trade-off between single-agent full pipelines and graph-style orchestration:

- Single-agent full pipeline (design → execution → testing): heavy human involvement, the human becomes the pipeline bottleneck;
- Graph-style orchestration (LangGraph direction): tried and abandoned — flow hard-coded into graphs, costly to change, agent freedom crushed;
- Compromise: implemented on an early Swarm cluster runtime following a Leader-decomposition → multi-role collaboration → gate-adjudication working pattern, then migrated into dsh to become this plugin.

## The Three Components

| Component | Location | Contents |
|---|---|---|
| Plugin | packages/dsh-punky-swarm | Engine: **20 governance tools** + Tier3 gates + session isolation v2 + read-only API (incl. AIP /tools endpoint) + task difficulty gate + Punky Swarm cluster monitoring panel |
| Pattern | packages/dsh-punky-swarm/presets/jiufeng | Punky Swarm preset: Leader persona + governance discipline + tool-bootstrap |
| Guide | packages/dsh-punky-swarm/skills/jiufeng-team | 3-layer 8-role × operation-manual assembly table + constitution + templates |

## Installation

> The instructions below target Agent / automated execution; commands can be run directly; `web` is an example profile and can be replaced.
> The plugin **auto-syncs** the pattern preset (→ `~/.dsh/.agent-presets/jiufeng`) and skill guide (→ `~/.agents/skills/jiufeng-team`) on startup — **no manual placement needed**; if present and identical it is skipped, otherwise it is overwritten with the packaged version.

```sh
git clone https://github.com/Punky971210/dsh-punky-swarm.git
cd dsh-punky-swarm
# Install peer dependencies (@deepseek-ai/dsh-tools, @deepseek-ai/cordis; versions pinned by package-lock.json)
npm ci --prefix packages/dsh-punky-swarm
# POSIX
dsh plugin --profile web add link:$(pwd)/packages/dsh-punky-swarm
# Windows PowerShell
dsh plugin --profile web add link:$PWD\packages\dsh-punky-swarm
dsh web restart
```

> It can also be installed via npm: `npm install -g dsh-punky-swarm` (version see [package.json](packages/dsh-punky-swarm/package.json)); git source + dsh plugin link is the development/debugging route.

### npm installation

```sh
npm install -g dsh-punky-swarm
dsh plugin --profile web add dsh-punky-swarm
dsh web restart
```

## Punky Swarm Cluster Monitoring Panel (read-only)

The plugin ships with a **Punky Swarm cluster** monitoring panel: third tab "对话 / 轨迹 / Punky Swarm 集群" in the session header (conversation.view), **available on install, no extra configuration**.

- **Batch list**: phase (planning/running/complete…) + terminal progress `3/5` + auto-release/completed marks;
- **Stats bar**: total batches / running / completed / abnormal (failed+conflict);
- **Batch detail**: lane status cards (status + task summary + gate missing-item details + layer/dependencies), event timeline, inbox (dispatch/broadcast) counts;
- **Read-only**: 3s auto-refresh, follows Web UI light/dark theme; the execution engine (batch/gate/state machine) **cannot be modified by humans, view only**; governance operations are executed by the Punky Swarm Leader.

## Governance Tools (20)

> Scope note: **20 is the full-open (cordis.patch.yml) count** — `log_export` is included only when `logs.enabled: true`.
> Under the bare default config (no `capabilities` key), 7 keys are on by default (aip/discovery/verify/watch/worktree/budget/trajectory),
> giving 19 tools (without `log_export`); `logs` defaults off and is turned on by the patch to reach 20. Explicit `enabled: false` disables per-key.

Grouped by function:

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
| `lane_worktree_create` | Create an independent git worktree for a lane (baselined from orch HEAD) |
| `lane_worktree_merge` | Merge a lane branch into orch (conflict preserves scene + manifest) |
| `lane_checkpoint` | In-lane checkpoint commit (git add+commit, preserves artifacts) |
| `lane_checkpoint_status` | Query checkpoint history and progress (resume-contract entry point) |

### Logs
| Tool | Description |
|---|---|
| `log_export` | Read-only event-stream export (lane/type/since filters + json/markdown + landing in engine artifact root) |

> Assembly switches (cordis.patch.yml): aip / discovery / verify / watch / worktree / budget / trajectory / logs default enabled, each can be explicitly disabled with `enabled: false`; mergeAgent default disabled (requires host-injected spawner). Default-off capabilities: `aip.identity` (identity system) and `acps` (ACPs communication, see next chapter).

## National Standard AIP Compatibility

Compatible with the Agent-Interconnection national standard (GB/Z 185-2026) tool/agent descriptor structures — additive only, no changes to existing behavior, pluggable:

- **Tool 6 attributes**: every tool provides toolId / name / description / version / inputParam / outputParam (toolId = `dsh.punky-swarm.<name>` reverse-domain unique; inputParam/outputParam are JSON Schemas, required always present);
- **Agent descriptor (GB/Z 185.4-2026 Part 4: Agent Description; ACS field set)**: assembly config → per-role ACS AgentCapabilitySpec descriptor (root object 20 keys = 14 required: aic / active / lastModifiedTime / protocolVersion / name / description / version / provider / securitySchemes / endPoints / capabilities / defaultInputModes / defaultOutputModes / skills, 6 optional: iconUrl / documentationUrl / webAppUrl / entityUserId / entityMeta / certificate; AgentSkill 8 keys = 5 required: id / name / description / version / tags, 3 optional: examples / inputModes / outputModes; protocol 02.01);
- **Message/task/session mapping**: mailbox messages, wavePlan tasks, batch status → national-standard structures (pure mapping, read-only, storage unchanged, ackId atomic write preserved);
- **Identity system** (default off, activated by `aip.identity.enabled=true`): AIC identity code (OID prefix `1.2.156.3088` + CRC-16/CCITT-FALSE + Base36 check digit) + CAI identity certificate + pluggable signing (default ECDSA-P256 / RSA-2048) + trust-chain verification; SM2 not supported (signing interface is pluggable, defaults ECDSA-P256 / RSA-2048, `algorithm='sm2'` explicitly rejected);
- **Assembly switch**: `aip.enabled` (default on) → generates tool 6-attribute catalog + `GET /api/dsh-punky-swarm/tools` (filterable with `?name=`).

## ACPs Communication (off by default)

ACPs (Agent Communication Protocol Standard) communication capability: external mTLS service endpoint + internal mailbox↔ACPs bridge + registry semi-automatic registration and external ADP discovery integration. **All off by default** (secure default) — both `acps.enabled` and `acps.endpoint.enabled` default to `false`; listeners/clients load only when explicitly enabled; when off there is zero runtime footprint (no listeners, no timers, no network).

### Capability overview

| Capability | Assembly key | Default | Purpose |
|---|---|---|---|
| External mTLS endpoint | `acps.enabled` + `acps.endpoint.enabled` | Off | External AIP JSON-RPC / ACS / health check (TLSv1.3 + mutual certificates) |
| Internal bridge | `acps.bridge` | Off (inbound additionally sub-gated off) | In-process bidirectional mailbox ↔ ACPs message projection/delivery |
| registry registration | `acps.registry` | Off | Semi-automatic registration client (requires registry.url + user credentials) |
| discovery discovery | `acps.discovery` | Off | External ADP discovery client (POST /discover) |

### External mTLS service endpoint

Standalone HTTPS listener (native node:https + node:tls, zero new dependencies), default port `9443` (`acps.endpoint.port` configurable), host default `127.0.0.1`; TLSv1.3 (`minVersion` default, TLSv1.2 configurable) + mutual certificates (`requestCert` + `rejectUnauthorized` = CERT_REQUIRED); `devInsecure` is an explicit development-only switch (default `false`, production downgrade not allowed). Assembly condition: `acps.enabled` AND `acps.endpoint.enabled` **both true**; missing/unusable certificates → startup warning and stay disabled, does not block the main process.

| Endpoint | Method | Description |
|---|---|---|
| `/acps/rpc` | POST | AIP JSON-RPC (jsonrpc 2.0, method=`rpc`, params.command=TaskCommand → TaskResult accepted/rejected); client certificate CN must be a valid AIC (otherwise 400) |
| `/.well-known/acs.json` | GET | Direct ACS fetch (14 required keys + securitySchemes.mutualTLS + endPoints JSONRPC) |
| `/health` | GET | Health check (agent/status/tasks/groups) |

Certificates: CA self-signed (native node:crypto X.509 + ECDSA P-256), entity certificate CN=AIC, SAN=URI:acps://{AIC}, generated by default under `<root>/acps/certs` (ca.pem/ca.key/server.pem/server.key); `cert/key/ca` three paths configurable to override.

### Internal bridge

`acps.bridge` (in-process bidirectional, default off; mode=`inprocess`):
- **inbound** (default off, enable explicitly with `acps.bridge.inbound=true`): external ACPs TaskCommand → mailbox message, **written atomically to inbox via the lib/comms/mailbox.js public interface (ackId generated by mailbox, never bypassed, no side-channel writes)**; write target is inbox only (lane derived from mentions/groupId into meta), outbox is not externally writable, external broadcast delivery unsupported;
- **outbound**: mailbox messages → ACPs Message/TaskResult (reuses the aip-format three mappings), projection/delivery view only, never writes back to mailbox storage;
- **/rpc→bridge wiring**: TaskCommand received at `POST /acps/rpc` lands in mailbox via `handleInbound`; when `bridge.inbound=false`, protocol-level `rejected` (INBOUND_DISABLED, HTTP 200 returned — transport succeeded, protocol layer rejected); when bridge is not assembled, falls back to standalone endpoint `accepted` (backward compatible);
- **mailbox red lines preserved**: ackId atomic write, three boxes (inbox/outbox/broadcast), lane isolation semantics preserved verbatim;
- **zero path**: when `enabled=false`, nothing loads or instantiates (mountBridge returns null).

### registry / discovery integration (off by default)

- **registry** (`acps.registry`, semi-automatic registration client): requires `registry.url` + user credentials (username/password or token, injected via config/env, never hard-coded, never committed); flow login → upsertAgent → submitAgent (**human approval, never auto-skipped**) → requestEab → queryAcs; EAB macKey stored encrypted with **AES-256-GCM** (when `eabKey` is unconfigured, plaintext credentials are returned for the caller to store itself);
- **discovery** (`acps.discovery`, ADP client): POST `{baseUrl}/discover` to query external agents (4 type categories / 34 operators, sharing protocol constants with local discovery); `scope` = local (existing local catalog only) / external (external only) / both (local+external merged, external takes precedence in acsMap); timeout default 10s, limit default 5.

### Configuration example

```yaml
# ACPs communication capability (all off by default, secure default)
acps:
  enabled: true                # capability master switch
  endpoint:
    enabled: true              # external mTLS endpoint (both this and the master switch must be true to assemble)
    port: 9443                 # default 9443
    host: 127.0.0.1            # localhost only by default
    certDir: null              # default <root>/acps/certs (auto-generated)
    minVersion: TLSv1.3        # default TLSv1.3 (TLSv1.2 allowed)
    devInsecure: false         # explicit development only; no production downgrade
  bridge:
    enabled: false             # internal bridge (in-process bidirectional)
    inbound: false             # external writes to mailbox require explicit true
  registry:
    enabled: false             # semi-automatic registration
    url: null                  # registry public API base URL (required)
    username: null             # injected via config/env, never hard-coded
    password: null
    eabKey: null               # EAB macKey encryption key (AES-256-GCM)
  discovery:
    enabled: false             # external ADP discovery client
    baseUrl: ''                # external discovery-server root address
    scope: local               # local / external / both
    timeout: 10000             # default 10s
    limit: 5                   # default result cap
```

### Relationship with existing AIP capabilities

- Existing endpoints (`GET /api/dsh-punky-swarm/tools`, `GET /api/dsh-punky-swarm/agents`, `POST /api/dsh-punky-swarm/discover`, `GET /.well-known/aip`) **remain byte-for-byte unchanged** — ACPs uses an independent 9443 listener + `/acps/*` prefix, zero path conflicts;
- Existing local discovery (`capabilities.discovery`, default on) is the in-process query channel; `acps.discovery` is the external query channel; `scope=both` merges both channels' results;
- Existing assets reused by ACPs communication: `aip-format` three mappings (Message/TaskCommand/Session), `lib/aip/identity.js` (AIC validation/certificates), `lib/discovery/schema.js` (protocol constants and validation);
- Same as `aip.identity` (default off), this is a default-off capability; CAPABILITY_REGISTRY now has 9 keys (aip/identity/discovery/verify/watch/worktree/budget/trajectory/acps).

### Capability boundaries (not implemented)

- **Tool calling (GB/Z 185.7-2026 Part 7: Agent Tool Calling)**: not implemented;
- **SM2 signing**: not supported — sign is a pluggable interface, defaults ECDSA-P256 / RSA-2048, `algorithm='sm2'` explicitly rejected;
- **mini-ADSP**: external `/discover` server semantics only reserve the function signature (createMiniAdsp), not implemented;

## Governance Capabilities

| Capability | Assembly key | Mechanism |
|---|---|---|
| Heartbeat/expiry detection | `capabilities.watch` | watchdog timer + lane_heartbeat tool; backoff-tier follow-ups + N consecutive no-activity beats → lane.stalled mark |
| worktree physical isolation | `capabilities.worktree` | lane_worktree_create/merge/checkpoint (git worktree isolation + checkpoint commits); complements the lane_claim logical lock |
| Acceptance evidence | `capabilities.verify` | post-execute evidence capture (content-addressed blob + ledger) + three-state adjudication (done/failed/blocked) + completion gate (advisory/enforce) |
| Mailbox loop protection | `capabilities.budget` | chain-hop cap / per-ordered-pair round-trip cap / duplicate-message rejection; inbox exempt |
| Diagnostics bridging | `capabilities.trajectory` | anomaly diagnosis (deadlock/invalid retry/goal drift) → sessionId→lane mapping → notify (autoFail default off) |
| Log export | `capabilities.logs` | log_export tool: read-only event-stream projection, lane/type/since filters + json/markdown + engine artifact root landing (escape-proof) |
| topic subscription | — (pure module) | subscribeTopic/emitTopic: in-process dispatch + mailbox broadcast landing (ackId atomic write) |
| merge agent | `worktree.mergeAgent` (default off) | conflict-semantics resolution (requires a host-injected spawner; without injection the conflict stays unresolved) |

## Lifecycle

- **lane conditions**: statically declared at batch creation (dependency artifacts/files exist), validated before dispatch, unsatisfied → skipped;
- **archive auto-archiving**: after complete, one-way auto-archive (artifacts packaged and kept queryable, not rollback-able);
- **needHuman hold**: audit artifact declares needHuman → lane held at review, Manager relays the human verdict (merged/conflict), no new member state;
- **ratchet rule table**: state-transition config (delete-only, never add; allowRelax escape hatch default off);
- **recovery mechanism**: checkpoint preservation + recovery audit + crash→idle re-dispatch (new workers can query checkpoints to skip completed steps); resume interface reserved.

## wavePlan (fixed semantics)

- On batch creation, tasks are layered into waves by dependency DAG; **never recomputed mid-flight after creation** (fixed wavePlan semantics);
- Tasks may declare layer (plan/exec/audit), consume/produce/outputs, role/skills; team assembly injects skill prefixes by role (pluggable, not bound to a specific team);
- Same-wave tasks dispatch in parallel; batch/member status uses the state file as the single source of truth (event log auditable).

## Task Difficulty Gate

- **Before any action on each (user) turn**, the Leader must give a task difficulty A/B/C and execution entity via assign_check: A=Leader direct / B=single subagent / C=cluster wave_plan batch;
- **default to C**: the evaluation object is the complete target task (scope=full); any C feature (multi-step ≥3 / multi-role ≥2 / gate needed / external dependency / recoverability) → C; when unsure, fill C;
- **guard enforced**: after a C judgment, calling execution tools (pwsh/write/edit/run/subagent, etc.) without creating a batch is rejected by the engine; unassessed/expired assessments (20 execution calls or 30 minutes) are likewise rejected; read-only queries unrestricted;
- **asset_claim**: exploration/troubleshooting artifacts the Leader produced directly before a C judgment can be claimed as batch assets via asset_claim, no rework.

## Tool-Call-Level Guardrails (Governance Hook, M2)

Subscribes to the host's `tools/pre-execute` + `tools/post-execute` two phases (zero host modification, additive on the plugin side); the CAGE 6-primitive pure-function kernel adjudicates (`lib/governance/`, TS compiled back):

- **Layered semantics** (complementary to the task-level gate, no conflict):

| Layer | Mechanism | Location | Semantics |
|---|---|---|---|
| Task level (before dispatch) | `ctx.tools.guard` (task difficulty gate) | assessment/batch-creation state machine | "whether this execution-type call is allowed to happen" |
| Call level (at execution time) | this hook's pre-execute kernel | `tools/pre-execute` waterfall | "whether this call's parameters/tools are out of bounds" (rule table) |

  Execution order: pre-execute waterfall (kernel) → ask resolution → difficulty gate (guardReason) → dispatch; when the kernel judges ALLOW → the difficulty gate applies as usual (the two gates stack serially); when the kernel judges deny/ask → the difficulty gate no longer participates (invariant: the difficulty gate can only tighten, never be bypassed).

### ① Primitive Runtime Semantics (6/6)

| Primitive | Landing form | Trigger tier |
|---|---|---|
| `ALLOW` | Pass-through, no interception (`next()`) | rule not matched / matched with zero violations |
| `DENY` | `{kind:'deny'}` rejects execution | hard (P2); pausable/narrowable/soft fall back to DENY when the corresponding flag is off (P3-P5) |
| `REQUIRE_APPROVAL` | `{kind:'ask'}` → host approval channel (serviceAsk) | manual_review (P1) / ftra (P0) / soft confidence met (P6) |
| `NARROW` | `{kind:'deny'}` + parameter narrowing guidance + receipt `narrowedParams` | flag.narrow=true and narrowable (P4) |
| `DEFER` | `{kind:'deny'}` + session deferred suspension (state file + receipt `deferMeta`) | flag.defer=true and soft (P5) |
| `PAUSE` | `{kind:'deny'}` + session pause (state file + receipt `pauseMeta`) | flag.pause=true and pausable (P3) |

- **Unified refusal message format**: `[governance:<primitive>] <reason>` (primitive ∈ ALLOW/DENY/REQUIRE_APPROVAL/DEFER/NARROW/PAUSE; aligned with the difficulty gate's `[task-difficulty-gate]` prefix style) — the model side can distinguish "task level unassessed" from "call level out of bounds". DENY/DEFER/NARROW/PAUSE all land as `{kind:'deny'}` (2.2 simplified + receipt metadata); REQUIRE_APPROVAL → `{kind:'ask'}`.
- **REQUIRE_APPROVAL ask behavior (explicit)**: pre synchronously writes `ask: {channel:'host-serviceAsk', initiated, requestId(=callId)}`; post best-effort backfills `outcome` (denied-no-approval / denied-no-agent / denied-rejected / denied-cancelled / unavailable / allowed-once). **Depends on the host approval channel (serviceAsk); no approval service / no agent → degraded deny** (behavior unchanged, record made explicit); allowed-once → allow.
- **DEFER/PAUSE file-state simplified state machine (truly effective once flags are on)**: `flags.defer: true` (soft violation) → session suspended and deferred (state file `<root>/governance/state/<sessionId>.json`, window 30s, receipt carries `deferMeta`); `flags.pause: true` (pausable violation) → session paused (window 60s, receipt carries `pauseMeta`). While suspended/paused, same-session calls are uniformly denied with `[governance:DEFER|PAUSE]` (reason includes retry-after / pauseToken / until); **lazy expiry auto-recovers** (cleaned on read; no timer / no resume endpoint); flag-off collapses to DENY with no state side effect (distinguishable from "session deferred/paused").

### ② Configuration Guide and Example Rules (copyable)

- **Configuration**: top-level key `governance.hook` in `cordis.patch.yml` — `enabled: true` (**default on**, finalized 2026-08-31; explicit `enabled: false` turns it off) / `rules: []` / `defaults.deny: DENY` (fail-closed fallback, other denial-class primitives configurable, ALLOW not allowed) / `flags: {pause:false, narrow:false, defer:false}` (primitive switches default off → the corresponding tier falls back to DENY). The rule table follows the `Rule` structure (`id` / `tools?` / `match{path?,op?,pattern?,value?}` / `violations[{code,category,severity?,message,path?}]` / `narrow?`).
- ⚠️ **Factory default `rules: []` = zero interception** (decide is always ALLOW, behavior unchanged) — do not mistake it for active guardrails; the examples below take real effect when copied into `governance.hook` (replacing the `rules` and `flags` sections), and can also be written to `<root>/config/runtime.json` for a hot-update override (see ⑤).

```yaml
# Copy into the governance.hook section of cordis.patch.yml (replacing the existing rules: [] and flags sections takes effect)
# Expected behavior: example 1 matched → DENY; example 2 matched → NARROW (narrowing guidance + narrowedParams land in the receipt);
#                     example 3 matched → REQUIRE_APPROVAL ask (depends on the host approval channel; no channel → degraded deny)
governance:
  hook:
    enabled: true
    flags:
      pause: false
      narrow: true      # example 2 needs the narrow primitive enabled (default false — if off, example 2 falls back to DENY + narrowing guidance)
      defer: false
    rules:
      # Example 1: forbid force delete (hard → DENY) — tools follow the host's actual tool names (bash/pwsh/…)
      - id: example-forbid-force-delete
        tools: [bash, pwsh]
        match: { path: /cmd, op: regex, pattern: 'rm -rf|Remove-Item -Recurse|del /f /s /q' }
        violations:
          - code: EX1
            category: hard
            message: Force-delete commands are forbidden by the guardrail (rm -rf / Remove-Item -Recurse / del /f /s /q)
      # Example 2: timeout parameter narrowing (narrowable + narrow bounds → NARROW when flag.narrow=true)
      - id: example-timeout-narrow
        tools: [bash]
        match: { path: /timeout, op: gt, value: 3600 }
        violations:
          - code: EX2
            category: narrowable
            message: Timeout parameter exceeds 3600s and must be narrowed
        narrow:
          - path: /timeout
            max: 3600
      # Example 3 (optional): approval gate (manual_review → REQUIRE_APPROVAL)
      - id: example-admin-approval
        match: { path: /scope, op: eq, value: admin }
        violations:
          - code: EX3
            category: manual_review
            message: High-risk admin operations require manual review
```

Expected behavior (fed to the kernel): example 1 (`bash` + `cmd: "rm -rf /data"`) → `DENY` (priority 2, ruleRefs `['example-forbid-force-delete']`); example 2 (`bash` + `timeout: 7200`) with `flags.narrow: true` → `NARROW` + `narrowedParams` (`/timeout` 7200 → 3600 clamp details); flag off → falls back to `DENY`; example 3 (any tool + `scope: "admin"`) → `REQUIRE_APPROVAL`.

### ③ Receipt Evidence Envelope (hash anchoring + verification)

- **Refusal receipt**: `<root>/governance/refusals/<sessionId>/<receiptId>.json` (atomic write tmp+rename) + `ledger-<sessionId>.jsonl` (append). **Base eight keys**: receiptId / ts / tool / callId / sessionId / decision (primitive+priority+reason) / attemptedParams / ruleRefs; **optional extensions** (P0-P2, backward compatible; old receipts without these fields do not break): `narrowedParams` (NARROW / DENY-with-narrow clamp guidance), `deferMeta` / `pauseMeta` (DEFER/PAUSE metadata), `ask` (REQUIRE_APPROVAL record), `anchor` (hash anchoring).
- **Hash anchoring (P2, M5-d simplified)**: same-session receipts are chained in ts order into a sha256 hash chain — `anchor: {version: 1, alg: 'sha256', prevHash, hash}`; the hash covers all receipt fields except anchor itself (including prevHash); tampering with any receipt breaks the whole chain after it.
- **Verification**: `lib/governance/receipt-store.js` `verifyRefusals(root, sessionId)` → `{ok, brokenAt, count, receipts}` — per receipt `{receiptId, ts, anchored, ok, issue?}`, issue = `hash-mismatch` (own content tampered) / `link-break` (prevHash not matching the previous receipt in the chain = missing link / forged re-anchor); old receipts (no anchor) do not join chain validation and are not judged failed (compatible). Audit can re-run: change 1 byte → verify fails and brokenAt locates it.
- **Capability boundary**: canonical is the RFC8785 simplified version (key sorting + no whitespace + undefined/NaN aligned with JSON.stringify); full RFC8785 numeric normalization / per-character escaping and true signatures (WORM) belong to M5 (see ⑥).

### ④ Two-Layer Bridge (batch-level event stream)

Receipt landing → assembly-layer `onRefusal` callback → batch-level event stream `<root>/governance/events/refusal-<sessionId>.jsonl` (each line `{type:'governance.refusal.recorded', ts, sessionId, receiptId, primitive, tool, callId}`), observable in parallel with refusals receipts/ledger — **layered governance "receipt layer → batch-level event stream" coordination** (hook-eval A.3 critique 6 closed). Event visibility only, **does not trigger batch-level state transitions** (DEFER/PAUSE → batch_phase paused/aborted linkage belongs to M5-a); callback errors are isolated as warn and do not block adjudication; disconnected after dispose; after a hot re-mount the bridge follows and is re-injected (see ⑤).

### ⑤ Hot Update (no restart)

- The governance key is in the runtime.json top-level whitelist (`lib/hot/config-watch.js` `ALLOWED_TOP_KEYS`) — any **effective sub-key change** of `governance.hook` (enabled flip / rules / flags / defaults) takes effect immediately via assembly-side `applyConfigChange` ⑤ dispose + re-mount, **no restart** (aligned with the verify ④ pattern; the kernel closure holds the old config → unified re-mount, no updateConfig API introduced). Runtime state resets after a re-mount (refusals count back to zero; the outcome backfill of in-flight asks across a re-mount is lost — `ask.initiated` was already landed in the receipt at pre, audit not lost); DEFER/PAUSE session state is file-based (state-store), not lost across a re-mount.
- **Override examples** (write to `<root>/config/runtime.json`, atomic write tmp+rename; deep-merge overlay, static config zero change):

```json
{ "governance": { "hook": { "enabled": false } } }
```

  Writing `enabled: false` → hot unmount (pre no longer triggers, calls no longer intercepted); writing back `true` or deleting the key (restores the default true) → re-mount takes effect. Rules override example (whole-array replacement, remaining sub-keys keep static values):

```json
{ "governance": { "hook": { "rules": [ { "id": "runtime-deny-shutdown", "tools": ["bash"], "match": { "path": "/cmd", "op": "regex", "pattern": "shutdown" }, "violations": [ { "code": "RT1", "category": "hard", "message": "Shutdown commands are forbidden" } ] } ] } } }
```

  Expected: after writing, re-mount → the new rule immediately intercepts `shutdown` calls (DENY + receipt landing), no process restart needed.

### ⑥ Not-Implemented List (revised)

Anti-scope-creep (M2 construction boundary, still complete after revision): MCP gateway / out-of-process paths (N-1), 8-tier financial layer (N-2), NeMo/Presidio/spaCy heavy dependencies (N-3), K8s/cloud integration (N-4), model-side LLM interception (N-5), route seal (N-6), DEFER/PAUSE **complete** state machine (N-7 — refers to Redis state-machine/queue semantics; the file-state simplified version has landed as P1, see ①; the no-setInterval / no-endpoint audit checks remain), NARROW transparent parameter rewriting (N-8 — the host forbids input rewriting, landed as deny + guidance), streaming events tools/result + SSE (N-9), hash-anchoring/signature evidence envelope (N-10 — refers to full RFC8785 / true signatures; the M5-d **sha256-chain simplified version has landed as P2**, see ③), WORM (N-11, kept not-implemented). Full verification method: see batch `exec/tester-report.md`.

- Adjudicated boundaries & recheck conclusions for residuals #3/#5/#6/#9: [governance-boundaries.en.md](docs/governance-boundaries.en.md)

## Tier3 Gates

- **Batch-creation static validation**: layer ∈ plan/exec/audit; exec implies audit; artifact path contracts; cross-layer references; tamper resistance;
- **Entry**: consume artifacts complete before exec dispatch, missing → dispatch rejected (GATE_ENTRY_MISSING);
- **Plan contract (artifact structure gate)**: plan artifacts must contain required spec sections (acceptance criteria/constraints) + valid-JSON task tree, missing → merged rejected (GATE_PLAN_CONTRACT);
- **Exit (artifact gate)**: outputs landed before exec settlement, produce landed before audit settlement, missing → merged rejected (GATE_EXIT_MISSING_*);
- **Complete (closing gate)**: before batch complete, audit-layer acceptance done with no failed/conflict and exec layer fully terminal (GATE_COMPLETE_*);
- **Hardening (dp1-dp4) = the above gates engine-ized** (mapping see skills/jiufeng-team/references/workflow.md §四): dp1 assignment judgment → Entry + assign_check; dp2 completion confirmation → Exit; dp3 review routing → review + member_settle; dp4 acceptance judgment → Complete — implemented capability, moved out of "out of scope".

generic batches (no layer) do not trigger gates, backward compatible.

## State Machine

```
Member: pending -> running -> review -> merged | failed | skipped | conflict (idle=recovery re-dispatch; review->running=rework)
Batch: planning -> running -> paused -> aborted | complete (complete requires the three-layer gates first)
```

## License and Commercial Licensing

This project is licensed under **GNU AGPL v3 (AGPL-3.0) as its sole license**:

- Under [AGPL-3.0](LICENSE), free to use, modify, and distribute (including commercially); if you provide the modified software over a network as a service, you must publish your modifications under AGPL-3.0.
- For other licensing (e.g., closed-source commercial use), please contact the author.
