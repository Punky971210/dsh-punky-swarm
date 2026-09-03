# Call-Level Guardrails (Governance Hook) Technical Manual

> This document describes the tool-call-level guardrails: 6-primitive runtime semantics, rule configuration and examples, refusal receipts and verification, event bridging, hot update, non-provisions, and capability boundaries & trade-offs. The batch-level governance engine lives in [governance-technical.en.md](governance-technical.en.md); capability-boundary declarations live in [governance-boundaries.en.md](governance-boundaries.en.md).
> 中文: [guardrails-hook.md](guardrails-hook.md)

The guardrails subscribe to the host tool lifecycle events `tools/pre-execute` + `tools/post-execute` (additive on the plugin side, zero host modification); a 6-primitive pure-function kernel adjudicates (`lib/governance/`, synchronous, deterministic, zero IO). Complementary to the batch-level task difficulty gate, no conflict:

| Layer | Mechanism | Location | Semantics |
|---|---|---|---|
| Task level (before dispatch) | `ctx.tools.guard` (task difficulty gate) | assessment/batch-creation state machine | "whether this execution-type call is allowed to happen" |
| Call level (at execution time) | this hook's pre-execute kernel | `tools/pre-execute` event chain | "whether this call's parameters/tools are out of bounds" (rule table) |

Execution order: pre-execute event chain (kernel) → ask resolution → difficulty gate (guardReason) → dispatch; when the kernel judges ALLOW → the difficulty gate applies as usual (the two gates stack serially); when the kernel judges deny/ask → the difficulty gate no longer participates (invariant: the difficulty gate can only tighten, never be bypassed).

## 1. Two-Phase Wiring

- **pre-execute**: session-state pre-check (session deferred/paused → reject directly, see §2 DEFER/PAUSE) → kernel adjudication → ALLOW passes through (`next()`); non-ALLOW synchronously writes the refusal receipt (failure only warns, observer discipline, does not block adjudication) → returns `{kind:'deny'|'ask'}`;
- **post-execute**: pass-through observer — always `next()`, never alters the result; only best-effort backfills the ask outcome (lookup + inference, write failure only warns);
- **event order**: pre → execute → post → result; this hook never calls `ctx.emit` to tamper with the event stream; on the pre-rejection short path execute does not run, but the post observer is still invoked (the degraded-deny path of ask is backfilled the same way);
- **teardown**: `dispose()` unsubscribes pre + post listeners in order (idempotent).

## 2. 6-Primitive Runtime Semantics

| Primitive | Landing form | Trigger condition |
|---|---|---|
| `ALLOW` | Pass-through, no interception (`next()`) | rule not matched / matched with zero violations |
| `DENY` | `{kind:'deny'}` rejects execution | hard violation; pausable/narrowable/soft fall back to DENY when the corresponding flag is off |
| `REQUIRE_APPROVAL` | `{kind:'ask'}` → host approval channel (serviceAsk) | manual_review / ftra / soft confidence met (≥0.70) |
| `NARROW` | `{kind:'deny'}` + parameter narrowing guidance + receipt `narrowedParams` | flag.narrow=true and narrowable |
| `DEFER` | `{kind:'deny'}` + session deferred suspension (state file + receipt `deferMeta`) | flag.defer=true and soft |
| `PAUSE` | `{kind:'deny'}` + session pause (state file + receipt `pauseMeta`) | flag.pause=true and pausable |

Adjudication order (category priority, first match wins):

1. `ftra` → REQUIRE_APPROVAL (boundary human intervention);
2. `manual_review` with no hard → REQUIRE_APPROVAL (manual review needed);
3. `hard` → DENY (hard violation);
4. `pausable` → flag.pause ? PAUSE : DENY;
5. `narrowable` → flag.narrow ? NARROW : DENY (NARROW includes narrowedParams clamp guidance; the flag-off DENY fallback also carries the guidance);
6. `soft` with confidence < 0.70 → flag.defer ? DEFER : DENY;
7. `soft` with confidence ≥ 0.70 → REQUIRE_APPROVAL;
8. unclassified violations → fallback primitive (defaults.deny, default DENY; never ALLOW — fail-closed).

- **Unified refusal message format**: `[governance:<primitive>] <reason>` (primitive ∈ ALLOW/DENY/REQUIRE_APPROVAL/DEFER/NARROW/PAUSE; aligned with the difficulty gate's `[task-difficulty-gate]` prefix style) — the model side can distinguish "task level unassessed" from "call level out of bounds". DENY/DEFER/NARROW/PAUSE all land as `{kind:'deny'}`; REQUIRE_APPROVAL → `{kind:'ask'}`.
- **REQUIRE_APPROVAL ask behavior (explicit)**: pre synchronously writes `ask: {channel:'host-serviceAsk', initiated, requestId(=callId)}`; post best-effort backfills `outcome` (denied-no-approval / denied-no-agent / denied-rejected / denied-cancelled / unavailable / allowed-once). **Depends on the host approval channel (serviceAsk); no approval service / no agent → degraded deny** (behavior unchanged, record made explicit); allowed-once → allow.
- **DEFER/PAUSE file-state state machine (truly effective once flags are on)**: `flags.defer: true` (soft violation) → session suspended and deferred (state file `<root>/governance/state/<sessionId>.json`, window 30s, receipt carries `deferMeta`); `flags.pause: true` (pausable violation) → session paused (window 60s, receipt carries `pauseMeta`). While suspended/paused, same-session calls are uniformly denied with `[governance:DEFER|PAUSE]` (reason includes retry-after / pauseToken / until); **lazy expiry auto-recovers** (cleaned on read; no timer / no resume endpoint); flag-off collapses to DENY with no state side effect (distinguishable from "session deferred/paused").

## 3. Configuration Guide and Example Rules

- **Configuration**: top-level key `governance.hook` in `cordis.patch.yml` — `enabled: true` (**default on**; explicit `enabled: false` turns it off) / `rules: []` / `defaults.deny: DENY` (fail-closed fallback, other denial-class primitives configurable, ALLOW not allowed) / `flags: {pause:false, narrow:false, defer:false}` (primitive switches default off → the corresponding class falls back to DENY).
- **Rule structure**: `id` / `tools?` / `match{path?,op?,pattern?,value?}` / `violations[{code,category,severity?,message,path?}]` / `narrow?`.

`match.op` supports: `eq` (recursive deep equality) / `gt` / `gte` / `lt` / `lte` / `in` / `regex`; `match.path` is a JSON Pointer (default = match the whole arguments; path absent → not matched). `category` values: hard / manual_review / ftra / narrowable / pausable / soft / unknown.

- ⚠️ **Factory default `rules: []` = zero interception** (decide is always ALLOW, behavior unchanged) — do not mistake it for active guardrails; the examples below take real effect when copied into `governance.hook` (replacing the `rules` and `flags` sections), and can also be written to `<root>/config/runtime.json` for a hot-update override (see §6).

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

Expected behavior (fed to the kernel): example 1 (`bash` + `cmd: "rm -rf /data"`) → `DENY` (ruleRefs `['example-forbid-force-delete']`); example 2 (`bash` + `timeout: 7200`) with `flags.narrow: true` → `NARROW` + `narrowedParams` (`/timeout` 7200 → 3600 clamp details); flag off → falls back to `DENY`; example 3 (any tool + `scope: "admin"`) → `REQUIRE_APPROVAL`.

> Same-source maintenance: these example rules and the test-embedded constants are maintained in sync (`test/governance-hotconfig.test.js` `EX_RULE_*`); maintenance policy in [governance-boundaries.en.md](governance-boundaries.en.md) §3.

## 4. Receipt Evidence Envelope (hash anchoring + verification)

- **Refusal receipt**: `<root>/governance/refusals/<sessionId>/<receiptId>.json` (atomic write tmp+rename, write-then-read verification fail-closed) + `ledger-<sessionId>.jsonl` (append). **Base eight keys**: receiptId / ts / tool / callId / sessionId / decision (primitive+priority+reason) / attemptedParams / ruleRefs; **optional extensions** (backward compatible; old receipts without these fields do not break): `narrowedParams` (NARROW / DENY-with-narrow clamp guidance), `deferMeta` / `pauseMeta` (DEFER/PAUSE metadata), `ask` (REQUIRE_APPROVAL record), `anchor` (hash anchoring).
- **Hash anchoring**: same-session receipts are chained in ts order into a sha256 hash chain — `anchor: {version: 1, alg: 'sha256', prevHash, hash}`; the hash covers all receipt fields except anchor itself (including prevHash); tampering with any receipt breaks the whole chain after it. Chain order = strict ts order (same-ms collisions nudged +1ms for determinism; receiptId tie-break is only a fallback).
- **Verification**: `lib/governance/receipt-store.js` `verifyRefusals(root, sessionId)` → `{ok, brokenAt, count, receipts}` — per receipt `{receiptId, ts, anchored, ok, issue?}`, issue = `hash-mismatch` (own content tampered) / `link-break` (prevHash not matching the previous receipt in the chain = missing link / forged re-anchor); old receipts (no anchor) do not join chain validation and are not judged failed (compatible). Audit can re-run: change 1 byte → verify fails and brokenAt locates it.
- **ask-outcome backfill and cascading re-anchor**: post backfill is a receipt-body rewrite (atomic tmp+rename); when the receipt is already anchored, its hash is recomputed (prevHash unchanged) → on hash change all successors in the chain are cascadingly recomputed (atomic json rewrite + ledger evolution snapshot append). Chain-tail backfill (the common case) re-anchors only that receipt. Old receipts keep pure backfill.
- **canonical boundary**: canonical is the RFC8785 simplified version (key sorting + no whitespace + undefined/NaN aligned with JSON.stringify, `lib/governance/hash-utils.js`). **Capability boundary**: full RFC8785 numeric normalization (-0 / cross-engine exponent guarantees), the per-character escaping table (U+2028/2029 etc.) and true signatures are not currently provided (see §7).

## 5. Event Bridging (receipts → event stream)

Receipt landing → assembly-layer `onRefusal` callback → event stream `<root>/governance/events/refusal-<sessionId>.jsonl` (each line `{type:'governance.refusal.recorded', ts, sessionId, receiptId, primitive, tool, callId}`), observable in parallel with refusals receipts/ledger — layered governance "receipt layer → event stream" coordination. The bridge is event-visibility-only by default and does **not** trigger batch-level state transitions; when `governance.hook.escalation.enabled: true` and the receipt is attributed to a batch (via the member.dispatch session mapping), rule refusals (DENY/NARROW) are counted per batch over a rolling window, and reaching the threshold can trigger batch-level paused through ratchet validation (event reason='governance-escalate', see governance-technical §2). **Session-level DEFER/PAUSE short-window states do not directly map to batch-level paused** (short-window lazy auto-recovery vs. batch-level persistent suspension — semantic-mismatch forbidden zone); state-gate receipts (empty ruleRefs) are not counted. Batch-level paused has two automatic trigger sources: consecutive member failures `failed-escalate` (existing) and guardrail-violation count escalation `governance-escalate`. Callback errors are isolated as warn and do not block adjudication; disconnected after `dispose` (idempotent); after a hot re-mount the bridge follows and is re-injected (see §6).

## 6. Hot Update (no restart)

- The governance key is in the runtime.json top-level whitelist (`lib/hot/config-watch.js` `ALLOWED_TOP_KEYS`) — any **effective sub-key change** of `governance.hook` (enabled flip / rules / flags / defaults) takes effect immediately via assembly-side dispose + re-mount, **no restart** (the kernel closure holds the old config → unified re-mount, no updateConfig API introduced). Runtime state resets after a re-mount (refusals count back to zero; the outcome backfill of in-flight asks across a re-mount is lost — `ask.initiated` was already landed in the receipt at pre, audit not lost); DEFER/PAUSE session state is file-based (state-store), not lost across a re-mount.
- **Override examples** (write to `<root>/config/runtime.json`, atomic write tmp+rename; deep-merge overlay, static config zero change):

```json
{ "governance": { "hook": { "enabled": false } } }
```

  Writing `enabled: false` → hot unmount (pre no longer triggers, calls no longer intercepted); writing back `true` or deleting the key (restores the default true) → re-mount takes effect. Rules override example (whole-array replacement, remaining sub-keys keep static values):

```json
{ "governance": { "hook": { "rules": [ { "id": "runtime-deny-shutdown", "tools": ["bash"], "match": { "path": "/cmd", "op": "regex", "pattern": "shutdown" }, "violations": [ { "code": "RT1", "category": "hard", "message": "Shutdown commands are forbidden" } ] } ] } } }
```

  Expected: after writing, re-mount → the new rule immediately intercepts `shutdown` calls (DENY + receipt landing), no process restart needed.

## 7. Boundaries and Non-Provisions

The current guardrails provide in-process, single-machine, rule-table-driven call-level governance; the following are **not currently provided** (explicit scope-boundary statements, not gaps):

- out-of-process gateway / MCP gateway paths;
- cloud integration / K8s deployment forms;
- heavy third-party dependencies (NeMo / Presidio / spaCy class);
- model-side LLM interception (the guardrails act on the host tool-call layer);
- route seal;
- DEFER/PAUSE **complete** state machine (queue/external-storage semantics; the file-state simplified version is provided, see §2; no setInterval / no resume endpoint maintained);
- NARROW transparent parameter rewriting (the host forbids input rewriting; landed as deny + guidance);
- streaming event push (tools/result + SSE class);
- full RFC8785 (numeric normalization / per-character escaping) and true-signature evidence envelope (the sha256-chain simplified version is provided, see §4);
- immutable storage (write-once class).

## 8. Capability Boundaries & Trade-offs

The call-level guardrails extend governance beyond the task level with a call-level line of defense while keeping determinism, auditability, zero added dependencies, and zero host modification. The summary below is grouped into **enhancement surface / capability boundaries / technical trade-offs** (implementation details in §1–§7).

### 8.1 Enhancement Surface (10 items)

Relative to task-level governance, the guardrails add ten governance capabilities:

1. **Finer granularity: task level (inside batch orchestration, before dispatch) → call level (at each call's execution)** — bounds checks no longer stop at dispatch time; they happen on every tool call (§1);
2. **Two independent lines of defense** — the task-level difficulty gate (how tasks are dispatched) and the call-level guardrails (whether each call is out of bounds) are wired independently and apply in series; neither can be bypassed (comparison table above);
3. **6 primitives per call** — ALLOW / DENY / REQUIRE_APPROVAL / NARROW / DEFER / PAUSE land on every call; non-ALLOW synchronously produces a refusal receipt (§2);
4. **Deterministic pure function** — the kernel is synchronous, deterministic, zero IO, free of external state: same input → same output, unit-testable and reproducible (§2);
5. **Verifiable audit hash chain** — same-session receipts are chained by ts order into a sha256 chain; tampering breaks the chain and verify locates it (§4);
6. **Runtime states DEFER/PAUSE** — session-level defer/pause genuinely take effect as file states (window + lazy expiry recovery), not just hints (§2);
7. **Hot update** — rules / switches / defaults take effect at runtime without restart (§6);
8. **Two-layer violation escalation** — call-level violation counts reaching the threshold can trigger batch-level paused through ratchet validation (§5);
9. **Secure factory defaults** — enabled by default with a fail-closed fallback (unclassified violations → DENY, never ALLOW): the line of defense exists on install, complementary to factory zero interception that needs configured rules to actually fire (see 8.2-2);
10. **Unified refusal format** — the `[governance:<primitive>]` prefix aligns with the difficulty-gate style, letting the caller distinguish "task level unassessed" from "call level out of bounds" (§2).

### 8.2 Capability Boundaries (8 items)

Usage boundaries of the guardrails (scope statements, not defects; the feature-level non-provision list lives in §7):

1. **Tool side, not model side** — adjudication acts on the host tool-call layer (pre/post-execute); the model's own generation and reasoning are outside the guardrails' scope (see §7);
2. **Factory zero interception; rules must be configured to take effect** — with `rules: []`, decide is always ALLOW; "install and use, existing behavior unchanged" holds only once rules are configured (§3);
3. **Single-machine, plugin-scoped; not a gateway** — in-process, single-machine, plugin form; out-of-process / MCP gateway paths are not provided (see §7);
4. **NARROW is guidance-level; the host forbids rewriting** — NARROW lands as deny + narrowing guidance, never transparent parameter rewriting (the host forbids input rewriting, §2/§7);
5. **Tamper-evidence ≠ deletion protection** — the chain guarantees that landed receipts cannot be silently altered (tampering breaks the chain and is locatable), but the receipt files themselves can be deleted: no WORM / write-once storage is provided (§4/§7);
6. **Attribution depends on registration** — receipt → batch-level linkage relies on registration via the member.dispatch session mapping; unattributed receipts stay event-visible only and never trigger batch-level transitions (§5);
7. **No authoritative signature** — hash anchoring is self-proving within the chain, with no third-party authoritative signature backing it (full RFC8785 and true signatures are not provided, §4/§7);
8. **Rule version is not snapshotted** — receipts record the matched rule IDs (ruleRefs) and the reason, not the rule-set version in force at adjudication time; after a hot-update wholesale rule replacement, old receipts cannot exactly reproduce the rule set that judged them (§4/§6).

### 8.3 Technical Trade-offs

**Strengths**
- **Deterministic and testable** — pure synchronous kernel, same input → same output; rule behavior can be locked down by unit tests and reproduced for verification;
- **Zero added dependencies** — Node standard library + host peer only, no third-party runtime dependency (§2);
- **Zero host modification** — additive wiring on the plugin side; the host only exposes its existing lifecycle events, no intrusion (§1).

**Costs**
- **No model-side line of defense** — the model's own behavior is outside the line (see 8.2-1);
- **NARROW does not actually rewrite** — it only guides narrowing and cannot modify parameters itself; the actual effect depends on the caller's cooperation (see 8.2-4);
- **No WORM** — tamper-evidence does not prevent deletion; the strength ceiling of the audit trail is self-proving chaining (see 8.2-5);
- **Hot reload resets in-flight approvals** — after a hot re-mount, the outcome backfill of in-flight asks across the re-mount is lost (`ask.initiated` already landed at pre, so the audit survives; §6).
