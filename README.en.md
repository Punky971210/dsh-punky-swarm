# dsh-punky-swarm · the Punky governance engine

<p align="center">
  <a href="https://github.com/Punky971210/dsh-punky-swarm/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Punky971210/dsh-punky-swarm?label=license" alt="license"></a>
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome"></a>
  <a href="https://github.com/Punky971210/dsh-punky-swarm/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Punky971210/dsh-punky-swarm/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="https://github.com/Punky971210/dsh-punky-swarm/blob/main/packages/dsh-punky-swarm/package.json"><img src="https://img.shields.io/badge/node-%3E%3D22-blue" alt="node"></a>
</p>

> **One agent is a contractor on call. A governed team of agents is a department.**
>
> The Punky engine turns a company's rules into software and puts them inside the engine: scheduling, quality checks, approvals and recovery run as mechanisms, not as things a person has to remember or enforce. Once the rules live there, the human is left with judgement only — state what you want, accept what was made.

中文: [README.md](README.md)

---

## One person, a team, and an invisible line

Treating AI as an employee has been the fashionable framing. Employees need salaries, management, patience and notice periods. A single agent has none of that: on call, billed per job, gone when done. It is closer to a contractor than to staff — assign work, watch work, accept work, one person can handle one.

And that is where the value of a single agent ends.

So people stack quantity. Ten agents working together are far harder to manage than one: who runs first, who waits, who writes which file, where to resume after a crash. Without rules underneath, it is an incident site. What you stacked is not help — it is more contractors to babysit.

The turning point is not quantity. It is governance. **Contractors rely on supervision; departments rely on rules.** One person cannot watch everything; a rule set can. Once the rules live inside the engine the maths works too: headcount is paid whether or not there is work, while rules inside an engine are rented by the token — paid only when used. One person, one automated rule set, and a pool of agents on call: that is the whole composition of a one-person company.

There is no shortage of multi-agent products; very few actually run as one-person companies. Most stall at the same invisible line. That line is not drawn in the vision statement — you have to open up an agent to see where it lies.

## Open up an agent first

Just as the internet has a general five-layer structure, an agent splits into four layers: **substrate, tools, capability, application**. The substrate is the agent's operating system; above it sits what it can call, what it can become, and what it finally delivers.

For a harness, the question is not who dug the substrate deeper — it is which layer is opened to you. **The more layers open, the more you can define.**

Openness falls roughly into four bands:

| Band | What is open | Outcome |
|---|---|---|
| L0 capability | models, external tools and skills are swappable | you can *use* the engine |
| L1 process | task flow defined inside the engine, or multi-instance orchestration outside at the protocol layer | you can add orchestration around it |
| **L2 host** | agent loop, session log, sandbox and UI are all replaceable and self-hostable | you can *grow* things inside the engine |
| Discipline band | gates, approvals, checkpoints, locks, audit | **the only place rules can take a seat** |

DSH is a local plugin tree with every layer replaceable: the agent loop itself is a plugin, and session events are appended in full — what the model can see is already recorded, searchable and replayable. **This engine runs on DSH not as a matter of taste, but because rules need somewhere to sit.**

## Discipline lives in the spinal cord, not the brain

An agent going off track cannot be cured by more capability. It is cured by discipline.

Consider walking: the skill is wired into instinct, so ordinary that nobody notices it. What matters is how deeply the body opens the machinery of walking — the answer is the spinal cord. Without it, movement stops. Typing, by contrast, is learned and depends on the brain, eyes and fingers, all of which are far younger in evolutionary terms than the spinal cord.

**Capability ranks behind discipline.** Whether a task completes does not depend on how smart the agent is right now, but on whether a process is holding it up. A classic agent loop self-confirms at every step — provided it believes it knows what correct means. But that judgement is generated on the spot, and confidence in this moment does not carry to the next. The engine takes the judgement away: contracts are fixed before work starts (what this step delivers, what counts as complete); each step is accepted before the next opens; and the check lives on the tool-call path rather than in the agent's conscience.

Making a task *instinctive* means removing the constant looking-back from the process. That does not happen on the model side. **If the host does not open the execution loop deep enough, there is nowhere for discipline to sit.**

## Three failures, one key

Delivery fails in three places, and none of them is model capability.

| Failure | Symptom | Engine answer |
|---|---|---|
| **Lost state** | context compresses or the session closes and the work evaporates; one interruption means starting over | **Freeze the state**: move it out of the model's head into files that are the single source of truth; checkpoint every completed sub-step and resume from the latest one, without redoing finished steps |
| **Target drift** | requirements quietly change mid-conversation; every step is confident yet no human anchor exists on the path | **Put judgement into gates**: fix the target before work starts; a created batch is never recomputed. Changing the target means a new batch — an explicit, visible decision |
| **Vague asks** | nobody knows what to ask for, so the request becomes "write me a plan" | **Make decomposition routine**: grade first, layer by dependency, and have every track declare what it delivers |

In one line: **going off track is not the frightening part — people drift too. Nobody stopping it is.**

## It lives inside the engine, not beside the protocol

Platforms connect agents through interop protocols such as MCP and ACP. They solve *reachability*: find each other, call each other's tools, hand over tasks.

The trouble is that reachability at best produces a chat room or a meeting room. **A real pipeline does not grow out of interop — it grows out of acceptance.** The rear foot may not move until the front foot is planted; nothing is released while deliverables are incomplete. Such a check has exactly one place to grow: inside the host's execution loop. Only the loop knows what was missing before a call, what the call produced, and who is waiting on it. A protocol carries a message between endpoints; it does not carry "is this step complete".

Governance exists elsewhere too, but where it sits differs: some sit outside the process at the egress, as a request-level interception chain; some sit in a service matrix and session layer, managing scheduling and messages; some sit in the application and coordination layer with a large model acting as leader. Each has its use, but **"the agent remembers to do it" and "the engine must verify it" are two different kinds of governance.**

The Punky engine puts the rules inside the execution loop, so what it governs is whether something was handed over, verified and allowed to close — not whether an agent remembers what to hand over.

## What you get

- **Grading before work**: small jobs are done directly without governance overhead; multi-step, collaborative, acceptance-bound work takes the full pipeline. **When in doubt, grade heavy** — grading heavy and then acting without a batch is refused; gradings expire so nobody drifts into unplanned work.
- **Tracks by dependency**: independent tracks run in parallel, dependent ones sequence; nothing is reordered after start. Each track splits into plan, execution and review — no execution before the plan is fixed, no review before output lands, no delivery before review passes.
- **Four gates**: upstream artifacts before dispatch, plan structure before merge, artifacts on disk before settlement, finished acceptance before close. Any missing piece is refused.
- **A checkpoint per sub-step**: an interruption resumes rather than restarts; a new owner reads the checkpoint and skips completed steps. Nothing auto-resumes — you look before you continue.
- **One writer per lane at a time**: parallel work uses isolated worktrees; conflicts are neither auto-merged nor silently overwritten — the scene is preserved for a human ruling.
- **Everything on the record**: batch and member state, handoffs, settlements and gate decisions all land in an event stream that can be replayed and exported for audit. A read-only panel sits in the Web UI; the engine adjudicates, it never rewrites.
- **Every tool call can be adjudicated**: call-level guardrails judge each invocation with six verdict primitives covering allow, deny, human approval, narrowing, deferral and pause; denials produce tamper-evident receipts so the agent knows which rule stopped it. Guardrails ship empty and change nothing until configured.
- **Five team skills bundled**: software engineering, design, research, video, writing. The software one also carries specification-language originals plus an adapter layer, so writing a spec, checking structure and verifying consistency all have a reference.

## Judgement written down before work starts

Taking judgement away from the agent and into a procedure it cannot overturn is a path others have taken too. The difference is **what gets judged**:

- One approach has a reviewer from another vendor judge *whether it is done* — an endpoint verdict with wide discretion, betting on uncorrelated judgement.
- The Punky engine's audit judges **each acceptance criterion written into the plan**, item by item — a criteria comparison, not an endpoint verdict. The criteria are fixed before work starts and live in the plan-layer artifact; the audit's intake must anchor to it, or dispatch is refused. To rule, you first pass the criteria gate.

The later criteria are written, the more room drift has. So the decision power goes to code: how member state migrates and when a batch may close are decided by the engine's state machine and phase machine, with every transition in the event stream — **an agent can submit, but cannot write its own settlement.**

One more thing usually skipped: **knowing when to stop.** If completion is judged per *round*, and a round has no bound on files or changes, then "is this round done" is already fuzzy at submission time. The Punky engine's unit is a **step**: every finished step writes a checkpoint with its progress, so judging whether the whole thing is done reduces to judging whether the last step landed. Long-run probes are also judged per state — elapsed time with a no-progress window while running, time awaiting settlement in review, time awaiting recovery when idle, time awaiting dispatch when pending. One ruler cannot measure every state. Stopping is an explicit action, not a timeout.

## What it does not do

This section matters more than the capability list.

The engine does not judge intent: guardrails work at the tool-call layer, so generation and reasoning stay outside the line of defence. It is not a sandbox, not an egress gateway, and does not detect side channels that bypass the explicit message channel. It provides no write-once storage: the hash chain defends against silent tampering, not deletion, and carries no third-party signature. It cannot authenticate a caller; trails give record and visibility, not access control. Governance is in-process on one machine; cross-machine orchestration is out of scope. Guardrails ship empty, so verdicts are allow-all until rules are configured.

So it will never claim to have "prevented an agent from going off track". It offers a choice of position: **stop determinable overreach and missing delivery during execution, instead of learning about them from a report afterwards.**

## Who it is for

One person, or a small technical team, doing **delivery with acceptance criteria** — code, research, design, writing all count.

Worth it only when all three hold:

1. you are advancing several things at once, not editing one function;
2. you need the artifact chain traceable, failures searchable, overreach interceptable;
3. you are unwilling to act as reviewer again after the agent says it is done.

Few people satisfy all three. But if you do, you will find there is no second option on the market — that is not a research conclusion, it is why the plugin was written.

It is not for "let the AI do the job in one sentence". Every mechanism here spends its cost on acceptance criteria; work without acceptance criteria does not need it.

## Install

Requires DeepSeek Harness (dsh) and Node.js ≥ 22.

```sh
# install and register into dsh (replace <profile> with the one you use)
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
