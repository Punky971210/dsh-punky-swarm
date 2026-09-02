# Governance Capability Boundary Declaration

> This document is a capability-boundary declaration: it records the actual boundaries and maintenance policy of several call-level guardrail mechanisms, for external transparency and regression prevention. Documentation only — zero code-behavior change. Companion documents: [guardrails-hook.en.md](guardrails-hook.en.md) (guardrail runtime mechanisms), [governance-technical.en.md](governance-technical.en.md) (batch-level governance engine); the Chinese 1:1 mirror is [governance-boundaries.md](governance-boundaries.md).

Every section carries four elements: **capability conclusion / evidence locations (file:line / doc section) / keep-as-is / future path (neutral statement, no codenames)**.

## §1 DEFER Session-Scope Boundary

- **Capability conclusion**: the DEFER gate is session-wide (per-session file state) — after any soft violation in a session triggers DEFER, calls of that session are uniformly rejected during the window (the suspension state is shared across calls), consistent with the product description "retries within the window are rejected". The contract does not constrain the tool/call dimension; the per-session file state is a reasonable implementation — **keep as-is**.
- **Evidence locations**:
  - Mechanism description: [guardrails-hook.en.md](guardrails-hook.en.md) §2 "DEFER/PAUSE file-state state machine" (state-file path / 30s window / lazy-expiry auto-recovery / flag-off no side effect);
  - `lib/governance/state-store.js:20` — `<root>/governance/state/<sessionId>.json` (per-session single file, idempotent read/write); `:71` `readSessionState` (reads the state file by sessionId); `:35` `DEFER_RETRY_MS = 30_000` (30s window); `:62` lazy expiry (cleaned on read, no timer).
- **Future path (neutral)**: keep as-is. If the product semantics require "only the same-call retry is rejected" (each violation rejects only that call; later retries in the same session pass) → a complete state-machine adjustment would be needed (queue/external-storage semantics), which is a "non-provision" — see [guardrails-hook.en.md](guardrails-hook.en.md) §7; the file-state simplified version is provided.

## §2 Hash-Chain and canonical Capability Boundaries

### 2.1 Tail-Deletion Capability Boundary

- **Capability conclusion**: deleting middle receipts / tampering **is detectable** (`verifyRefusals` brokenAt locates it, issue = `hash-mismatch` own content tampered / `link-break` missing link / forged re-anchor); **deleting the chain tail is not detectable** — the remaining chain stays self-consistent and verify still returns ok; detection requires an external comparison = `ledger-<sessionId>.jsonl` line count vs number of json files under `refusals/<sessionId>/` (a mismatch is an anomaly). The capability boundary ends here.
- **Evidence locations**:
  - Mechanism description: [guardrails-hook.en.md](guardrails-hook.en.md) §4 "Receipt Evidence Envelope (hash anchoring + verification)";
  - `lib/governance/receipt-store.js:202` `verifyRefusals` → `{ok, brokenAt, count, receipts}` (:228 return; :222 brokenAt first failure); `:20` / `:41-44` — `ledger-<sessionId>.jsonl` ledger path and receipt dual landing (atomic json write + ledger append).
- **Future path (neutral)**: keep as-is (documented boundary). Strong tail-deletion detection depends on an external ledger comparison or immutable (write-once class) storage, which is a "non-provision" — see [guardrails-hook.en.md](guardrails-hook.en.md) §7.

### 2.2 canonical RFC8785 Simplified-Version Boundary

- **Capability conclusion**: canonical is the RFC8785 **simplified version** — deterministic within the current receipt domain, **keep as-is**. What is not done (capability boundary): full RFC8785 numeric normalization (-0 / no cross-engine/version exponent-format guarantee), the per-character escaping table (U+2028/2029 etc. not escaped, JSON.stringify minimal escaping), semantically sensitive numeric normalization (precision-sensitive values / large numbers).
- **Evidence locations**:
  - Mechanism description: [guardrails-hook.en.md](guardrails-hook.en.md) §4 "canonical boundary";
  - `lib/governance/hash-utils.js:31-56` `canonicalize` (boundary comments :21-27): key sorting `Object.keys().sort()` (UTF-16 code-unit order; ASCII key domain consistent with RFC8785) :24 / :50-51; no whitespace; array elements undefined → null :47; object keys with undefined skipped :50-51; NaN/±Infinity → null :42; numbers via JSON.stringify (V8-deterministic, -0 → "0") :43.
- **Future path (neutral)**: keep as-is (the simplified version satisfies the deterministic evidence-envelope need). Scenarios with semantically sensitive numbers → upgrading to full RFC8785 (numeric normalization / per-character escaping) and true signatures could be evaluated; these are "non-provisions" — see [guardrails-hook.en.md](guardrails-hook.en.md) §7.

## §3 Example-Rule Same-Source Maintenance Policy

- **Capability conclusion**: the example rules and the test-embedded constants are **two places, one source — maintained in sync**: changes to the example yaml in [guardrails-hook.en.md](guardrails-hook.en.md) §3 must be mirrored in the test-embedded rule constants in `test/governance-hotconfig.test.js` and vice versa (changing one side and missing the other is same-source drift); semantic consistency is covered by test assertions (documented expected behavior ↔ T6/T7/T4 assertions).
- **Evidence locations (same-source facts)**:
  - [guardrails-hook.en.md](guardrails-hook.en.md) §3 — example yaml, 3 rules (rule ids: `example-forbid-force-delete` / `example-timeout-narrow` / `example-admin-approval`) and expected behavior; Chinese mirror [guardrails-hook.md](guardrails-hook.md) §3 (bilingual 1:1, kept in sync with the Chinese side);
  - `test/governance-hotconfig.test.js:87` — comment states the example rules share the same source (the T6/T7/T4 assertions are the documented expected behavior); constants :88-105 `EX_RULE_FORBID_DELETE` / `EX_RULE_TIMEOUT_NARROW` / `EX_RULE_ADMIN_APPROVAL` — id / tools / match / violations / narrow mirror the document yaml.
- **Change workflow (doc-update policy)**: ① modify the example yaml in [guardrails-hook.en.md](guardrails-hook.en.md) §3 → ② sync [guardrails-hook.md](guardrails-hook.md) §3 (bilingual 1:1) → ③ sync the `EX_RULE_*` constants in `test/governance-hotconfig.test.js` (:88-105) → ④ run the governance group tests (`node --test test/governance-hotconfig.test.js`) to confirm the expected-behavior assertions still pass.
- **Future path**: keep as-is (policy record), no future-path item.

## §4 Guardrail-Violation Count Escalation Boundary (guardrails → batch paused)

- **Capability conclusion**: guardrail-violation count escalation is **off by default** — `governance.hook.escalation.enabled` ships as `false`; only after it is explicitly enabled and rule refusals (DENY/NARROW) attributed to the batch reach the threshold within the window can a batch be automatically paused (the batch-level paused automatic sources correspondingly number three; see governance-technical.en.md §2). Default off = zero factory behavior change, not a gap.
- **Evidence locations**: trigger chain and configuration key in [guardrails-hook.en.md](guardrails-hook.en.md) §5 "Event Bridging" (escalation trigger condition) and §3 configuration; batch-level state machine and trigger sources in [governance-technical.en.md](governance-technical.en.md) §2.
- **Keep as-is / future path**: keep as-is (default off is the factory semantics).
