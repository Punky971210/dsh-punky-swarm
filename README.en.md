# dsh-punky-swarm · the Punky governance engine

<p align="center">
  <a href="https://github.com/Punky971210/dsh-punky-swarm/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Punky971210/dsh-punky-swarm?label=license" alt="license"></a>
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome"></a>
  <a href="https://github.com/Punky971210/dsh-punky-swarm/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Punky971210/dsh-punky-swarm/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="https://github.com/Punky971210/dsh-punky-swarm/blob/main/packages/dsh-punky-swarm/package.json"><img src="https://img.shields.io/badge/node-%3E%3D22-blue" alt="node"></a>
</p>

> **One agent is a contractor on call. A governed team of agents is a department.**
>
> Turn a company's rules into software and put them inside the engine: scheduling, quality checks, approvals and recovery run as mechanisms. The human is left with judgement only — state what you want, accept what was made.

中文: [README.md](README.md)

## Highlights

- **Four gates, nothing half-done passes** — upstream artifacts before dispatch, plan structure before merge, artifacts on disk before settlement, finished acceptance before close.
- **Criteria fixed before work starts** — acceptance criteria live in the plan layer and the audit checks them item by item; an agent can submit, but **cannot write its own settlement**.
- **Run mode assigned by task profile** — small jobs are done directly, without governance overhead; multi-step work takes the pipeline, and nothing starts without a batch.
- **A checkpoint per step** — an interruption resumes from the last checkpoint instead of restarting.
- **One writer per lane at a time** — isolated worktrees; conflicts are neither auto-merged nor silently overwritten.
- **Complex long tasks must open a batch** — acting without one is refused by the engine, and gradings expire so nobody drifts into unplanned work.
- **Denials are legible** — a rejected call says which rule stopped it and comes with a tamper-evident receipt.
- **Everything on the record** — state, handoffs, settlements and gate decisions land in an event stream that can be replayed and exported.

## Why it is needed

A single agent is easy to manage: assign, watch, accept — one person handles one. But its value ends at the individual. Stacking quantity is worse: ten agents working together, none of them knowing who runs first, who waits, who writes which file, where to resume after a crash. What you stacked is not help — it is more contractors to babysit.

**Contractors rely on supervision; departments rely on rules.** One person cannot watch everything; a rule set can. And the maths works: headcount is paid whether or not there is work, while rules inside an engine are rented by the token. One person, one automated rule set, a pool of agents on call — that is a one-person company.

Most multi-agent products stall on one invisible line: **they give you capability, but no seat for the rules.** Opened up, that line hides three failures:

| Failure | What you get | Engine answer |
|---|---|---|
| Lost state | context compresses, session closes, the work evaporates; one interruption means starting over | state moves into files as the single source of truth, checkpointed per step |
| Target drift | requirements quietly change mid-conversation and nobody notices | target fixed before work starts; a created batch is never recomputed |
| Vague asks | all you can say is "write me a plan" | grade first, layer by dependency, every track declares its deliverable |

## Rails set at the tool-call level

An agent going off track cannot be cured by more capability. It is cured by discipline — the way walking is wired into the spinal cord rather than occupying the brain. **Whether a task completes depends not on how smart the agent is right now, but on whether a process is holding it up.**

So judgement is taken out of the agent's hands: contracts are fixed before work starts (what this step delivers, what counts as complete), each step is accepted before the next opens, and the check sits on the tool-call path rather than in the agent's conscience.

This can only live at **the layer where the host opens its execution loop**. If the host opens no more than external protocols, discipline has to be bolted on outside the engine; if it opens the loop itself, discipline can live inside and become instinct.

Three parts make it up: **engine** for capability (grading, sequencing, gates, locks, checkpoints, guardrails, read-only panel), **mode** for behaviour (roles, discipline, boot guidance), **guidance** for usage (role manuals, artifact formats, templates). All three ship together — install it and you have a runnable team.

## Discipline lives inside the engine, not beside the protocol

Interop protocols (MCP / ACP) solve reachability: find each other, hand over tasks — at best a chat room. **A real pipeline does not grow out of interop; it grows out of acceptance.** The rear foot may not move until the front foot is planted.

Such a check has one place to grow: inside the host's execution loop, because only the loop knows what was missing before a call, what it produced, and who is waiting on it. **"The agent remembers to do it" and "the engine must verify it" are two kinds of governance** — this engine picks the second.

The market splits roughly three ways: **single-agent coding products** (get one agent to finish a job; multi-track work and artifact contracts are not in their design), **multi-agent orchestration frameworks** (get several agents talking in a topology; the criteria stay with the caller), and **judgement-engineering approaches** (gates and reviewers, but a single line). The first lacks orchestration, the second lacks gates, the third has only one line — this engine puts all three in one place.

## What you get

Three-layer gates with batch and member state machines · single-writer locks · isolated worktrees with checkpoints · task-difficulty grading · explicit message channels (three mailboxes, metadata only, consumption requires acknowledgement) · heartbeats and long-run probes · call-level guardrails (six verdict primitives plus tamper-evident receipts; ships empty, changes nothing until configured) · local audit log (on by default, never shipped anywhere) · read-only panel.

Plus **five team skills**: software engineering, design, research, video, writing. The software one also carries specification-language originals and an adapter layer, so writing a spec, checking structure and verifying consistency all have a reference.

## What it does not do

It does not judge intent (guardrails sit at the tool-call layer; generation and reasoning are outside the line of defence). It is not a sandbox, not an egress gateway, and does not detect side channels that bypass the explicit message channel. It provides no write-once storage (the hash chain defends against silent tampering, not deletion, and carries no third-party signature). It cannot authenticate a caller (trails give record and visibility, not access control). Governance is in-process on one machine; cross-machine orchestration is out of scope. Guardrails ship empty, so verdicts are allow-all until rules are configured.

So it never claims to have "prevented an agent from going off track". It offers a choice of position: **stop determinable overreach and missing delivery during execution, instead of learning about them from a report afterwards.**

## Who it is for

One person, or a small technical team, doing **delivery with acceptance criteria** — code, research, design, writing all count. Worth it only when all three hold:

1. you are advancing several things at once, not editing one function;
2. you need the artifact chain traceable, failures searchable, overreach interceptable;
3. you are unwilling to act as reviewer again after the agent says it is done.

Few people satisfy all three. But if you do, there is no second option on the market — that is not a research conclusion, it is why the plugin was written.

## Install

Requires DeepSeek Harness (dsh) and Node.js ≥ 22.

```sh
dsh plugin add dsh-punky-swarm
dsh web restart
```

> Alternative: `npm install -g dsh-punky-swarm`, then `dsh plugin --profile <profile> add dsh-punky-swarm`. For development, point `link:` at the local package directory.

After the restart the swarm panel appears in the session area and the team skills sync into your user directory — installed and ready, no extra configuration.

## Compatibility and license

**Version**: single source `packages/dsh-punky-swarm/package.json` (see `CHANGELOG.md`). **Test baseline**: 204 test files / 2,147 tests / 10,560 assertions / 0 tautological (single source `baselines/test-baseline.json`).

**Peer dependencies**: `@deepseek-ai/dsh-tools` (^0.1.0-rc.6 || ^0.1.1-rc.2 || ^0.1.5-rc.1 || ^0.1.6-alpha.1 || ^0.1.7-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.2) and `@deepseek-ai/cordis` (^4.0.1); zero third-party runtime dependencies. **Boundaries**: in-process on a single machine — no distributed sync, no cost control, no model routing, zero cloud dependency, no network exposure by default; failure is terminal and nothing auto-resumes.

**License**: GNU AGPL v3 (AGPL-3.0-only) as the sole license. Under [AGPL-3.0](LICENSE) you may use, modify and distribute freely, including commercially; if you offer the modified software over a network, you must publish your changes.
