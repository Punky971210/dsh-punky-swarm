# dsh-punky-swarm — Keeps AI teams from breaking, not just running

<p align="center">
  <a href="https://github.com/Punky971210/dsh-punky-swarm/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Punky971210/dsh-punky-swarm?label=license" alt="license"></a>
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome"></a>
  <a href="https://github.com/Punky971210/dsh-punky-swarm/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Punky971210/dsh-punky-swarm/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="https://github.com/Punky971210/dsh-punky-swarm/blob/main/packages/dsh-punky-swarm/package.json"><img src="https://img.shields.io/badge/node-%3E%3D22-blue" alt="node"></a>
</p>

> *Keeps AI teams from breaking — not just running.*
>
> **Local, engine-level pipeline governance for multi-agent work** — task grading, breakdown, scheduling, quality gates, acceptance and recovery all live in the engine; you only judge: say what you want, accept what it made. Gates reject half-done work, checkpoints resume in place — a batch of agents that does not just run, it does not break.

中文: [README.md](README.md)

---

## Why it is needed

A single agent is easy to manage: when it drifts, you watch it and pull it back. A batch of agents working together is another story — who runs first, who waits for whom, who writes which file, where to resume after a crash. With no one in charge, it is an incident site waiting to happen.

Pain points anyone who has run long tasks has hit:

| Pain point | What it costs you |
|---|---|
| **Half-done work shipped as done** | Downstream lanes get dispatched before upstream artifacts exist, and errors only surface when rework is forced |
| **One crash wipes out everything** | Hours of work with no mid-way snapshot; a single crash resets it all to zero |
| **Parallel writers trample each other** | Several agents writing the same repository overwrite each other, and when a conflict appears nobody can say who changed what |
| **Out-of-bounds calls slip through silently** | An agent puts a private key into a subtask argument or pushes a command parameter to an absurd ceiling — nobody intercepts |
| **Blocked, but no reason given** | A call is rejected with only "the user rejected this tool"; neither the agent nor the user can tell it was the guardrail, or which rule it hit |

The tools are not broken — what is missing are gates in the pipeline. This plugin puts the gates into the engine: artifacts incomplete, no dispatch; step done, one snapshot saved; one job, one writer at a time; every out-of-bounds call blocked — and blocked explainably.

## What it does

**Two layers of governance, two lines of defense.** Batch-level orchestration and call-level guardrails apply in layers and neither can be bypassed:

- **Layer 1 · Task orchestration** — decides "how work is dispatched": tasks are graded first — a quick job is done directly, a self-contained chunk goes to one agent, and work with many steps, roles and acceptance criteria goes through the full batch pipeline. Batches are layered into dependency-ordered waves; state and events are fully traced, auditable and re-traceable.
- **Layer 2 · Call guardrails** — decides "whether each tool call is out of bounds": beyond the dispatch gate, every call is adjudicated per call against adjudication primitives; a hit produces a tamper-evident refusal receipt that re-checks can locate.

**Three-layer gates that reject half-done work.** Every batch advances through plan → execute → accept, with artifact contracts as the gates between layers:

- Upstream artifacts are checked before dispatch, files are checked on disk before settle, and acceptance is checked before complete — **missing pieces are rejected outright**;
- Want to change the goal? Create a new batch — what is already running never drifts;
- Work one step, save one snapshot — an interruption stops at the snapshot, not back at zero; failure is terminal, rework means a new batch, never auto-resume or silent overwrite.

**Why engine-level, not protocol-level.** Interconnect protocols can wire agents together so they call each other, but what they wire up is a chat room — they can talk, they cannot form a pipeline. Gates have to sit on the tool-call chain: no upstream artifacts, no dispatch; one step not accepted, no progress to the next. Such checks can only live inside the host's execution loop — protocol layers have no place for them.

## Three mechanisms, exactly three cures

| Pain point | Mechanism | What you get |
|---|---|---|
| Half-done work shipped as done | **Engine-enforced gates**: upstream artifacts checked before dispatch, files checked on disk before settle, acceptance checked before complete — reject when anything is missing | Half-done work never reaches you |
| One crash wipes out everything | **Snapshot preservation**: every completed sub-step is preserved once; inspectable and resumable after a crash | Interruption is a pause at a save point, not a restart |
| Parallel writers trample each other | **Single-writer lock + isolated workspaces**: one writer per job at a time, each editing its own tree | Conflicts keep the scene for adjudication — never silently overwritten |
| Out-of-bounds calls | **Call-level guardrails + refusal receipts**: adjudicated per call; a hit is rejected and logged as a tamper-evident receipt | Out-of-bounds never reaches execution; verifiable afterwards |
| Blocked without a reason | **Refusal visibility**: the rejection you receive is not a generic notice but the guardrail label, the matched rule and the violation note | The agent knows why it was blocked and can fix the parameters and resend a compliant call |
| Rules you cannot vet | **Zero interception out of the box + a per-rule review list**: installing changes no behavior; rules can be reviewed before they are enabled | What blocks and why is laid out in full for checking |

## Guardrails & rules

Call-level guardrails are **zero interception out of the box** (empty rule table): install and use, existing behavior unchanged; enable rules as needed.

Optional **rule presets** ship with the package — one line enables one guardrail suite:

- **Sensitive-data protection**: content detection when private-key blocks / credential signatures enter subtask arguments, message channels, search and remote-command surfaces (hard interception + human review tiers);
- **Resource boundaries**: numeric ceilings such as command timeout, concurrency and target rounds; exceeding them is rejected with narrowing guidance (retry as a compliant call by following the guidance);
- **Full merge**: an equivalent per-rule merge of the two suites above — one config enables everything.

**Three new capabilities since 0.4.3:**

- **Refusal visibility** — when a tool call sent to human approval is rejected (including degraded cases such as an unreachable approval service), the rejection is no longer the generic "the user rejected this tool" text; it now carries the guardrail label, the matched rule, the violation note and where to look. Both the agent and the user can recognize "the guardrail blocked a suspected sensitive call" and fix the parameters to resend a compliant call. Non-blocking scenarios behave unchanged.
- **Rejection text carries the matched rule** — the matched rule and its preset membership are appended to the end of the rejection reason; both the human-approval request and the direct-rejection path carry it, so the user can verify the exact rule triggered before approving/rejecting.
- **Per-rule review list** — a per-rule review list of the guardrail rules ships with the package: rule id / preset membership / category / effective adjudication tier / trigger surface / match summary / violation note in one table per rule, so users and agents can proactively review the whole guardrail set (guarded by a consistency assertion that keeps the list and rule files in sync). Review before you enable — know what you are getting.

Configuration entry point: the governance config page in the Web UI settings area adjusts guardrail switches, rules and windows; saving applies immediately, no restart needed.

## Installation

Prerequisites: DeepSeek Harness (dsh) installed, Node.js ≥ 22.

```sh
# Install and load into dsh (replace the profile with the one you actually use)
dsh plugin add dsh-punky-swarm
dsh web restart
```

> Alternative: `npm install -g dsh-punky-swarm` and load it with `dsh plugin --profile <profile> add dsh-punky-swarm`; for development you can also point a `link:` entry at the local package directory.

## Quick start

1. **Enable the plugin**: run the install commands above and restart dsh.
2. **Create your first batch**: state the goal to the governance layer; the task automatically enters the "plan → execute → accept" pipeline, and complex tasks are scheduled by dependency automatically.
3. **Watch progress**: the Web UI batch panel shows phases, subtask states and the event timeline; when a batch completes its artifacts are archived and everything stays inspectable.

Interactive demo pages and screenshots will be added later.

## Documentation

Bilingual topic documentation ships with the package (7 groups, each with a Chinese and an English copy, distributed with the npm package); the in-repo directory is [packages/dsh-punky-swarm/docs](packages/dsh-punky-swarm/docs):

| Topic | Document (a matching `.en.md` copy sits in the same directory) |
|---|---|
| Governance technical details (gate semantics, state machines, assembly & tool reference) | [governance-technical.md](packages/dsh-punky-swarm/docs/governance-technical.md) |
| Governance config page guide (save/effect semantics of Web UI guardrail & capability switches) | [webui-governance-config.md](packages/dsh-punky-swarm/docs/webui-governance-config.md) |
| Guardrail hook mechanism (runtime semantics of call-level guardrails, rule examples, receipt verification) | [guardrails-hook.md](packages/dsh-punky-swarm/docs/guardrails-hook.md) |
| Single-machine capability boundaries (local single-machine governance capability statement) | [single-machine-capabilities.md](packages/dsh-punky-swarm/docs/single-machine-capabilities.md) |
| Compliance alignment (AIP descriptor structures: tool attributes / agent description / message mapping) | [aip-compliance.md](packages/dsh-punky-swarm/docs/aip-compliance.md) |
| Communications extension (ACPs: external endpoint / registration / discovery, off by default) | [acps-communication.md](packages/dsh-punky-swarm/docs/acps-communication.md) |
| Governance boundaries (capability boundary statement: hash-chain & canonical boundaries, rule-sync maintenance) | [governance-boundaries.md](packages/dsh-punky-swarm/docs/governance-boundaries.md) |

## Compatibility & boundaries

Current version **0.4.3**; 863 tests passing (measured on Node 24, CI covers Node 22/24); peer dependencies @deepseek-ai/dsh-tools (^0.1.0-rc.6 \|\| ^0.1.1-rc.2) and @deepseek-ai/cordis (^4.0.1); listed on awesome-dsh-plugin.

Honest boundaries: in-process governance for a single machine — no distributed cluster sync, no cost control, no model-tier routing; zero cloud dependencies and no network exposure by default; failure is terminal and rework means a new batch, never auto-resume.

## License

Licensed under **GNU AGPL v3 (AGPL-3.0-only)** as the sole license: you may freely use, modify and redistribute (including commercially) under [AGPL-3.0](LICENSE); if you provide the software as a network service after modification you must make the modified source available.
