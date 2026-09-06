# Governance Configuration

> This guide covers the Governance page under Settings in the dsh Web UI: which guardrail options you can adjust, how changes take effect immediately after saving, and what this page deliberately does not do.
> 中文: [webui-governance-config.md](webui-governance-config.md)

## What this page does

Governance is a dedicated page in the Settings area of the dsh Web UI. It manages a set of guardrail options for dsh running on this machine: the guardrails inspect the tool calls an Agent makes, detect out-of-bounds calls, and then allow, deny, or escalate them according to the rules you have chosen. Changes made on this page take effect **immediately after saving — no dsh restart needed**.

Besides the guardrails, this page also provides lane capability switches: enabling and disabling lane expiry detection (watch, including the longrun timeout re-dispatch probe).

At the top of the page you can see the current state: whether the guardrails are live, and how many rules are currently in effect.

## Configurable options

### Guardrail switch

- **On**: the guardrails take part in checking, judging out-of-bounds calls against the rule set below.
- **Off**: the guardrails take no part at all and calls are not held back by this feature.
- **Factory default: on**. However, the factory rule set is empty, so nothing is actually intercepted (see "Behavior boundaries").

### Rule preset

Pick a ready-made rule set to quickly enable a group of out-of-bounds protections:

| Option | Number of rules | Purpose |
|---|---|---|
| Factory default (no interception) | 0 | No rules enabled; guardrails on but nothing is held back |
| Sensitive-data guard | 12 | For out-of-bounds calls involving sensitive data such as credentials and private keys |
| Resource limits | 6 | For calls that exceed resource ceilings such as timeout and concurrency |
| Combination (L1 + L2) | 18 | The full combination of the two rule sets above |

Once you select a preset, the page shows the **count and a purpose summary** for that rule set. Switching presets does not change the running state by itself — it takes effect when you click Save.

### Auto-escalation

Off by default. When enabled, once the rules are refused a set number of times within a time window for the same batch of tasks, the affected batch is escalated automatically (the related work is paused and a record is kept, waiting for you to review and continue).

- **Refusals within window**: how many rule refusals within one time window trigger escalation (minimum 1).
- **Window (ms)**: the length of the counting window (minimum 1000).
- **Counted verdicts**: "Deny" and "Narrowed allowance" are counted by default; "Defer" and "Pause" can be added as needed; verdicts that require human approval are not on this list.

### Narrowed allowance

Off by default. When enabled, calls that go beyond the allowed bounds are no longer denied outright; instead the guardrails give narrowing guidance so the caller can retry with narrowed parameters. When disabled, such calls are denied outright.

### Lane capability switches (watch)

Control lane expiry detection (heartbeat / longrun):

- **Lane expiry detection (watch)**: the parent switch, controls the watchdog expiry scan over running lanes (heartbeat backoff follow-ups + stalled marking). When off, expiry detection does not run at all.
- **Longrun timeout re-dispatch probe (longrun)**: the child switch, controls the longrun candidate probe for lanes making no progress for too long. **On by factory default**; it takes effect only while the parent switch is on (when the parent is off, the child is disabled with a hint).

Both switches are on by factory default (`enabled` defaults to on — off only when explicitly `false`). While off, running lanes producing no stalled / longrun candidate events is expected; after re-enabling, scanning resumes from the baseline.

## Saving and activation

- **Save**: after clicking Save, the settings are written to the local configuration file and then applied to the running dsh immediately — no restart at any point. The page first shows "Saved, confirming…" and turns to "Live" once confirmed.
- **Activation of the lane capability switches (watch)**: `watch.enabled` and `watch.longrun.enabled` are saved together with the guardrails (same Save button, merged into `runtime.json`); saving hot-applies them immediately, and after a process restart they are also reconciled against `runtime.json`, so there is no need to set them again.
- **Reset**: discards your unsaved changes and returns to the state most recently loaded into the page.
- **Save rejected**: the page shows why the save was rejected; the common reasons are listed in "Behavior boundaries" below.

## Behavior boundaries

- **A controlled form — no free-form rule editing**: this page offers only the switches, presets, and numeric options above; there is no entry point for editing rules one by one. Teams that need fully custom rules should maintain the rule list in the configuration file (see the technical manual linked below).
- **Factory default zero interception is unchanged**: a fresh install ships with the factory default — guardrails on but no rules loaded, so no call is intercepted and existing behavior is unaffected; interception only begins after you select a preset or configure rules manually.
- **Manual rules must be handled first when they conflict with presets**: if a hand-maintained rule list already exists in the configuration, switching presets is rejected (to avoid overwriting manual rules); remove those rules manually first, or keep the preset unchanged, then save.
- **Saving is accepted only from this machine (or trusted sources)**: this page only accepts save requests from a browser on this machine (a local address); if dsh is served through a remote address, the deployment must add the visiting source to the trust list (the dsh host and this plugin must stay consistent), otherwise saves are rejected.
- **Boundaries of the watch switches**: on by factory default — off only when explicitly disabled; turning them off only stops scanning and probe events and never changes already-landed batch/member states. The tool registration surface (whether the heartbeat/longrun query tools appear in the available list) is fixed at startup; while watch is turned off at runtime, the query tools remain available and return a "disabled" state (no error).
- **watch thresholds are not on this page's form**: the longrun timeout duration and no-progress window thresholds are intentionally left out of this page's write path (a gate left open); adjust them in the configuration file if needed. This page exposes only the two watch switches.

## Further reading

- [Call-level guardrails technical manual](guardrails-hook.en.md): guardrail mechanics, rule authoring, and runtime details (for maintainers and developers).
- [Batch governance technical manual](governance-technical.en.md): batches, gates, and state machine (for operators).
