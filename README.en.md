# dsh-punky-swarm · the Punky engineering engine

<p align="center">
  <a href="https://github.com/Punky971210/dsh-punky-swarm/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Punky971210/dsh-punky-swarm?label=license" alt="license"></a>
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome"></a>
  <a href="https://github.com/Punky971210/dsh-punky-swarm/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Punky971210/dsh-punky-swarm/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="https://github.com/Punky971210/dsh-punky-swarm/blob/main/packages/dsh-punky-swarm/package.json"><img src="https://img.shields.io/badge/node-%3E%3D22-blue" alt="node"></a>
</p>

> **One agent is easy to manage. A team of agents is not.**
>
> The Punky engine moves "who should do this, and what counts as delivered" out of your attention span and into the engine. Tasks are graded by difficulty, batches are sequenced by dependency, deliveries are gated, and every tool call can be adjudicated. You do two things: say what you want, accept what was made.

中文: [README.md](README.md)

---

## It starts with the human being the bottleneck

Run a whole pipeline through a single agent and you end up with human-assisted automation: design, code, test and review all handed to one agent. It does a piece, you glance at it, you nod, it does the next. The human sits between the steps of an automation that was supposed to remove the human.

So you reach for an orchestration graph. The moment the graph is drawn, nodes and edges are hard-coded. Change a requirement and you redraw the graph. An agent wants a cheaper route? There is no such edge. Agent freedom is squeezed flat, and the cost of change is high enough that you open a second pipeline instead.

Neither extreme works. The Punky engine takes the middle road: **the pipeline is not hard-coded, but delivery never rests on good faith.** The engine does not dictate how an agent works. It asks, at a few decisive points — was the upstream artifact handed over, was the acceptance done, did this call cross a line. If the answer is no, work stops there.

## Three parts: the engine gives capability, the mode sets behaviour, the guidance teaches usage

| Part | What it is | What happens without it |
|---|---|---|
| **Engine** | A dsh plugin providing governance: task grading, batch sequencing, gates, single-writer locks, checkpoints, per-call guardrails, a read-only panel | Mode and guidance become talk |
| **Mode** | A preset: role definitions, governance discipline, boot guidance, behavioural norms — how an agent should behave inside this swarm | The engine degrades into a pile of unused tools |
| **Guidance** | Team skills: layered role manuals, artifact formats, templates — which skills each role loads, what it must produce | Every agent works from its own interpretation |

All three ship with the package. Install it and you have a runnable team, with no second system to assemble.

## Four gates: from "humans watch the flow" to "the engine watches the flow"

- **Before dispatch** — if the upstream artifacts a downstream step consumes are not in place, the step does not start.
- **Before merge** — plan-layer artifacts pass a structural contract check; a missing section sends them back.
- **Before settle** — declared outputs that never reached disk block settlement.
- **Before close** — a batch with unfinished acceptance, failures or conflicts cannot be closed.

All four do one thing: **block what is non-compliant, release what is compliant.** Half-finished work does not reach you by accident.

## Difficulty gate: decide who does the job before anyone starts

- **A** — small and verifiable: the lead does it directly.
- **B** — needs an isolated context or tool surface: one subagent.
- **C** — multi-step, parallel, gated, recoverable: the full batch pipeline.

**When in doubt, grade C.** Grading C and then acting without a batch is refused by the engine. Gradings expire, so nobody drifts into a long stretch of unplanned work. Exploration you already did can be claimed into the batch instead of being thrown away.

The point is blunt: **the engine forces planning; good faith is not a mechanism.** Small tasks do not pay team-scale overhead, and large tasks do not blow up one agent's context.

## Once a batch is created, its shape is fixed

Tasks are layered into waves by dependency. Waves can depend on each other; who waits for whom and who runs in parallel is settled at creation time and never recomputed midway.

Fixed beats dynamic in three ways: **traceable** — the original shape of the batch is always recoverable; **auditable** — which wave, which owner, which state, at a glance; **reproducible** — same input, same plan, same execution path.

A task can declare its layer (plan / exec / audit), what it consumes, what it produces and who owns it. Same layer runs in parallel; across layers, gates apply.

## Everything is accounted for

- **The state file is the single source of truth** — batch and member state come from it, never from a report.
- **Events are recorded end to end** — dispatch, handoff, settlement, gate decisions; all replayable.
- **Single-writer lock** — one writer per lane at a time; conflicts keep the scene for a human to rule on instead of silently overwriting.
- **Checkpoints** — every sub-step is preserved, so an interruption stops at a checkpoint rather than starting over.
- **Read-only panel** — batch list, statistics, lane cards, event timeline and inbox counts in the Web UI. The engine only adjudicates, never edits; humans only look.

## Even a single tool call can be adjudicated

Beyond batch gates, call-level guardrails judge each tool invocation with six verdict primitives covering allow, deny, escalate to human approval, narrow the arguments, defer and pause. A denial produces a **tamper-evident receipt** anchored in a hash chain — change one byte and the chain breaks. The agent learns which rule stopped it, not a generic refusal.

Guardrails ship with an empty rule set: installing changes nothing, rules are enabled deliberately and reviewed before use.

## What you get

- **Governance**: three-layer gates, batch and member state machines, single-writer locks, isolated worktrees with checkpoints, difficulty gate, artifact claiming.
- **Coordination**: explicit message channels (three mailboxes, metadata only, consumption requires acknowledgement), heartbeats and long-run probes, batch outcome typing.
- **Calls**: six-primitive guardrails, denial receipts with hash chains, rule presets (sensitive data / resource bounds / both).
- **Observability**: read-only panel, process-level local audit log (on by default, never shipped anywhere).
- **Team skills (5)**: `software-team`, `design-team`, `research-team`, `video-team`, `writing-team`. The software one also ships the specification-language originals plus an adapter layer, so writing a spec, checking its structure and verifying consistency all have a reference.

## Why hierarchy

| Shape | Upside | Cost |
|---|---|---|
| Star (centralised) | Simple | The centre is a single point of failure; a limited context cannot govern a large swarm |
| Decentralised (peer negotiation) | No single point of failure | Coordination cost grows exponentially; state becomes untraceable |
| **Hierarchical (this engine)** | Parallel within a layer, gates across layers; layered by cognitive load | Needs discipline — which is exactly what can live in the engine |

In one line: **stability, not restriction.** The tool layer stays fully open, the mode only advises, and the team assembly is pluggable — swap in whichever role system you prefer.

## What it does not do

This section matters more than the capability list.

The engine does not judge intent: guardrails work at the tool-call layer, so generation and reasoning stay outside the line of defence. It is not a sandbox, not an egress gateway, and does not detect side channels that bypass the explicit message channel. It provides no write-once storage: the hash chain defends against silent tampering, not deletion, and carries no third-party signature. It cannot authenticate a caller; trails provide record and visibility, not access control. Governance is in-process on one machine; cross-machine orchestration is out of scope. Guardrails ship empty, so verdicts are allow-all until rules are configured.

So it will never claim to have "prevented misalignment". What it offers is a choice of position: **stop determinable overreach and missing delivery during execution, instead of learning about them from a report afterwards.**

## Who it is for

One person or a small team doing **delivery with acceptance criteria** — code, research, design, writing all count. You want an auditable artifact chain, traceable failures, interceptable overreach, and data that stays local.

It is not for "let the AI do the job in one sentence". Every mechanism here spends its cost on acceptance criteria; work without acceptance criteria does not need it.

## Install

Requires DeepSeek Harness (dsh) and Node.js ≥ 22.

```sh
dsh plugin add dsh-punky-swarm
dsh web restart
```

> Alternative: `npm install -g dsh-punky-swarm`, then `dsh plugin --profile <profile> add dsh-punky-swarm`. For development, point `link:` at the local package directory.

After the restart the swarm panel appears in the session area and the team skills sync into your user directory — **installed and ready, no extra configuration.**

## Compatibility, readings and license

**Version** has a single source of truth: `packages/dsh-punky-swarm/package.json` (see `CHANGELOG.md`). **Test baseline**: **204 test files / 2,147 tests / 10,560 assertions / 0 tautological assertions**, single source `packages/dsh-punky-swarm/baselines/test-baseline.json`, measured on Node 24 and continuously checked on Node 22 and 24.

**Peer dependencies**: `@deepseek-ai/dsh-tools` (^0.1.0-rc.6 || ^0.1.1-rc.2 || ^0.1.5-rc.1 || ^0.1.6-alpha.1 || ^0.1.7-rc.1 || ^0.2.0-rc.1 || ^0.2.1-rc.2) and `@deepseek-ai/cordis` (^4.0.1). Zero third-party runtime dependencies.

**Honest boundaries**: in-process governance on a single machine — no distributed cluster sync, no cost control, no model routing, zero cloud dependency, no network exposure by default. Failure is terminal; redoing means a new batch, and nothing auto-resumes.

## License

**GNU AGPL v3 (AGPL-3.0-only)** as the sole license. Under [AGPL-3.0](LICENSE) you may use, modify and distribute freely, including commercially; if you offer the modified software over a network, you must publish your changes.
