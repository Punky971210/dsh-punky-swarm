# Governance Capability Boundaries & Recheck Conclusions

> Companion document: this file is the boundary-declaration and recheck-conclusion landing point for the README chapter "Tool-Call-Level Guardrails (Governance Hook, M2)" (README.en.md:256-361); the Chinese 1:1 mirror is [governance-boundaries.md](governance-boundaries.md).

## Introduction: nature and provenance of this document

- **Nature**: pure boundary declarations and recheck-conclusion records — zero code-behavior change (documentation-only disposition; no lib/ test/ changes).
- **Provenance**: documentation landing point for m2-harden acceptance residuals #3/#5/#6/#9. Upstream source of truth: `sessions/m2-harden-20260831/artifacts/m2-harden-20260831/audit/harden-acceptance.md` §4 disposition recommendations (hereafter harden-acceptance §4:line); the audit disposition scope = "document the capability boundary only / record / same-source maintenance policy record".
- **Disposition mapping**: #3 → §1 (recheck-conclusion record); #5 → §2·#5 (capability boundary documented); #6 → §2·#6 (capability boundary documented + M5-d deferred record); #9 → §3 (same-source maintenance policy record).
- Every section carries four elements: **residual # / adjudication conclusion / evidence locations (file:line) / keep-as-is or future path**.

## §1 DEFER Session-Scope Recheck Conclusion (residual #3)

- **Residual #**: #3 — DEFER gate is session-wide (per-session file state), source p1 pending-verification ④ (harden-acceptance §4:153).
- **Adjudication conclusion**: **Contract A.4 does not constrain the tool/call dimension; the per-session file state is a reasonable implementation — keep as-is**. Semantics = after any soft violation in a session triggers DEFER, calls of that session are uniformly rejected during the window (the suspension state is shared across calls), consistent with the product description "retries within the window are rejected".
- **Evidence locations**:
  - `lib/governance/state-store.js:20` — `<root>/governance/state/<sessionId>.json` (per-session single file, idempotent read/write);
  - `lib/governance/state-store.js:71` `readSessionState` (reads the state file by sessionId); `:35` `DEFER_RETRY_MS = 30_000` (30s window); `:62` lazy expiry (cleaned on read, no timer);
  - `README.en.md:282` — file-state simplified state-machine contract description (state-file path / 30s / lazy-expiry auto-recovery / flag-off no side effect) consistent.
- **Keep-as-is or future path**: **keep as-is**. If the product semantics require "only the same-call retry is rejected" (each violation rejects only that call; later retries in the same session pass) → a **full M5 state-machine adjustment** is needed (README.en.md ⑥:361 N-7 "DEFER/PAUSE complete state machine" scope; the file-state simplified version already landed as P1); not acted on in this batch, recorded for later.

## §2 Hash-Chain and canonical Capability Boundaries (residuals #5/#6)

### #5 Tail-Deletion Capability Boundary

- **Residual #**: #5 — tail receipt deletion is undetectable, source p2 pending-verification ② (harden-acceptance §4:155).
- **Adjudication conclusion**: **deleting middle receipts / tampering is detectable; deleting the chain tail is not detectable — requires an external count comparison; WORM (N-11) covers it; the capability boundary ends here**.
  - Middle deletion / tampering: detectable — `verifyRefusals` brokenAt locates it (issue = `hash-mismatch` own content tampered / `link-break` missing link / forged re-anchor);
  - Tail deletion (the tail receipt removed entirely): the remaining chain stays self-consistent and verify still returns ok — **not detectable by chain validation**; detection requires an external count comparison = `ledger-<sessionId>.jsonl` line count vs number of json files under `refusals/<sessionId>/` (a mismatch is an anomaly);
  - WORM (README.en.md ⑥:361 N-11, kept not-implemented) → the capability boundary ends here.
- **Evidence locations**:
  - `lib/governance/receipt-store.js:202` `verifyRefusals` → `{ok, brokenAt, count, receipts}` (:228 return; :222 brokenAt first failure);
  - `README.en.md:334-335` — hash-chain anchoring + verification return structure and issue vocabulary;
  - `lib/governance/receipt-store.js:20` / `:41-44` — `ledger-<sessionId>.jsonl` ledger path; `README.en.md:333` — receipt dual landing (atomic json write + ledger append).
- **Keep-as-is or future path**: **keep as-is (documented boundary)**. Strong tail-deletion detection depends on an external ledger comparison or WORM-like immutable storage (N-11 recorded), outside this batch's scope.

### #6 canonical RFC8785 Simplified-Version Boundary

- **Residual #**: #6 — canonical RFC8785 simplified-version boundary (-0 / U+2028 etc. numeric normalization not done), source p2 pending-verification ③ (harden-acceptance §4:156).
- **Adjudication conclusion**: **the simplified version is deterministic within the current receipt domain — keep as-is; scenarios with semantically sensitive numbers → upgrade to full RFC8785, deferred to M5-d**.
- **Evidence locations (what the simplified version does, `lib/governance/hash-utils.js:31-56` `canonicalize`, boundary comments :21-27)**:
  - Key sorting: `Object.keys().sort()` (UTF-16 code-unit order; ASCII key domain consistent with RFC8785) :24 / :50-51;
  - No whitespace; array elements undefined → null :47; object keys with undefined skipped :50-51; NaN/±Infinity → null :42;
  - Numbers via JSON.stringify (V8-deterministic, -0 → "0") :43 — relies on engine determinism, no cross-engine exponent-format normalization :22.
- **What is not done (capability boundary)**: full RFC8785 numeric normalization (no cross-engine/version exponent-format guarantee, :22); per-character escaping table (U+2028/2029 etc. not escaped, JSON.stringify minimal escaping, :23); semantically sensitive numeric normalization (precision-sensitive values / large numbers).
- **Keep-as-is or future path**: **keep as-is** (README.en.md:336 capability boundary states the same: canonical = RFC8785 simplified, the full version belongs to M5). Scenarios with semantically sensitive numbers → upgrade to full RFC8785, deferred to **M5-d** (README.en.md ⑥:361 N-10 "hash anchoring/signature evidence envelope — full RFC8785 / true signatures"; the M5-d sha256-chain simplified version already landed as P2, see README.en.md:334).

## §3 Example-Rule Same-Source Maintenance Policy (residual #9)

- **Residual #**: #9 — example rules and tests need same-source maintenance, source p3 pending-verification ⑦ (harden-acceptance §4:159).
- **Adjudication conclusion**: **two places, one source — maintain in sync**: changes to the README example yaml must be mirrored in the test-embedded rule constants and vice versa (changing one side and missing the other is same-source drift); semantic consistency is covered by test assertions (README expected behavior ↔ T6/T7/T4 assertions).
- **Evidence locations (same-source facts)**:
  - `README.en.md:289-327` — ② example yaml, 3 rules (rule ids: :302 `example-forbid-force-delete` / :310 `example-timeout-narrow` / :321 `example-admin-approval`); expected behavior :329;
  - `test/governance-hotconfig.test.js:87` — comment states explicitly "README ② example rules (governance-hotconfig and README share the same source: the T6/T7/T4 assertions are the README expected behavior)"; constants :88-93 `EX_RULE_FORBID_DELETE` / :94-100 `EX_RULE_TIMEOUT_NARROW` / :101-105 `EX_RULE_ADMIN_APPROVAL` — id / tools / match / violations / narrow mirror the README yaml;
  - `README.md:289-327` — the Chinese mirror carries the same-numbered examples (bilingual 1:1, maintained in sync with the Chinese side).
- **Change workflow (doc-update policy)**: ① modify the README.en.md ② example yaml (:289-327) → ② sync the test/governance-hotconfig.test.js `EX_RULE_*` constants (:88-105) → ③ sync the README.md ② examples (bilingual 1:1) → ④ run the governance group tests (`node --test test/governance-hotconfig.test.js`) to confirm the expected-behavior assertions still pass.
- **Keep-as-is or future path**: **keep as-is (policy record)**, no future-path item.
