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

## Audit log

The plugin ships a **process-level audit log sink**: it writes the engine's and this plugin's log lines to local disk, line by line, for after-the-fact inspection. It is **enabled by default** — an audit entry point is only worth having if it is always on: being off by default means evidence exists only when you happened to think of switching it on beforehand, which is exactly the case where evidence is most needed. Format, fields, location and switches are below, each verifiable.

**Location**: `<DSH_HOME>\logs\punky-swarm\audit-YYYY-MM-DD.jsonl` (the date in the file name is the **local date**; the name is fixed at process start and does not change within the process). When one volume reaches 64 MiB it rolls over to `audit-YYYY-MM-DD.1.jsonl`, `.2.jsonl`, … This location is **neither inside the session workspace nor inside the plugin artifact root**; runtime diagnostics go to a separate file, `diagnostics\sink-diagnostics.json`, under the same root. `<DSH_HOME>` is resolved as `PUNKY_AUDITLOG_SINK_DIR` → plugin config subkey `capabilities.auditlog.sinkDir` → `DSH_HOME` → `~/.dsh` (the first non-blank wins), then joined with `logs/punky-swarm`.

**Turning it off** (two channels; either one takes effect only after a **host restart**):

1. Environment variable `PUNKY_AUDITLOG`: `0` / `false` / `off` / `no` disables it (case-insensitive, surrounding whitespace trimmed); `1` / `true` / `on` / `yes` enables it; unset or blank means "no override".
2. Plugin config key `capabilities.auditlog.enabled: false`, written into `cordis.patch.yml` or `runtime.json`.

**Turning aggregation off** (also **restart-gated**): aggregation is a separate switch that is **on by default** — environment variable `PUNKY_AUDITLOG_AGGREGATE` (`0` / `false` / `off` / `no` disables, `1` / `true` / `on` / `yes` enables, unset or blank means "no override") or plugin config key `capabilities.auditlog.aggregate: false`. When off, every message is written line by line and there are zero `log-aggregate` lines — equivalent to the behavior before aggregation existed — and the folded-message counter stays 0.

**Priority**: env overrides config, **per key** (the same rule applies to `PUNKY_AUDITLOG_SINK_DIR` / `PUNKY_AUDITLOG_KEEP_DAYS` / `PUNKY_AUDITLOG_MAX_FILE_BYTES` / `PUNKY_AUDITLOG_MAX_TOTAL_BYTES` / `PUNKY_AUDITLOG_LEVELS_DEFAULT` / `PUNKY_AUDITLOG_AGGREGATE` / `PUNKY_LOGGER_STDOUT`). **The disabled state costs nothing**: no sink directory is created, no exporter is registered, not a single byte is written. **Hot changes do not apply** — the new configuration only takes effect after a host restart; a running process never mounts or unmounts the sink midway (mounting is a one-shot side effect at startup, and no runtime switch is provided).

**Writing to stdout**: a separate `PUNKY_LOGGER_STDOUT` switch controls whether the **same line** is also written to stdout. It is **off by default**; only `1` / `true` / `on` / `yes` enable it, anything else counts as off. When it is off, this module writes no bytes to stdout at all.

**One JSON per line (JSONL)**, 10 fields:

| Field | Meaning |
|---|---|
| `v` | Line format version, currently always `1` |
| `ts` | Event time, ISO 8601 (UTC) |
| `level` | Level: `error` / `warn` / `info` / `debug`; `sink-error` for sink-generated diagnostic rows |
| `name` | Log source name; defaults to `root` |
| `msg` | Rendered message text (the same rendering path the host log uses) |
| `args` | Raw arguments (values that cannot be serialized degrade to `<unserializable>`) |
| `sn` | Kernel-side sequence number |
| `truncated` | Whether this line was truncated |
| `pid` | Process id |
| `kind` | Record kind: `log` (a regular log line) / `log-aggregate` (a window-closing counting line) / `sink-error` (a diagnostic line produced by the sink itself) |

A single line is hard-capped at 32 KiB: over the cap the `args` segment is truncated first, then the `msg` segment, with a `...[truncated]` marker left at the cut and `truncated` set to true — **no record is dropped and logging is not interrupted**.

**Aggregation of repeated lines (on by default)**: messages sharing the same `(level,name,msg)` are written only as their **first line** within a **60-second sliding window** (byte-identical in shape to the non-aggregated case: 10 fields, `kind:"log"`, no `count`), and when the window closes one **counting line** is appended — `kind:"log-aggregate"`, carrying `count` and `aggKey` **in addition to** the same 10 fields. The counting line's `ts` is the time of the **last suppressed message** in that window (not the closing moment), while `sn` and `args` come from the **first line** (keeping "first occurrence" as a traceable anchor); the counting line is written before the new first line that triggered the close, so timestamps never go backwards within a file.

The window's right edge is **refreshed** by every suppressed arrival (one rescan storm collapses as a whole), with an additional **10-minute hard cap** so a long-running window cannot grow without bound (hitting the cap closes the window and reopens it with the current message). The window length is an internal implementation detail and is **not exposed as a configuration item**. It is on by default because of sheer volume: the measured rate of one and the same warning from one source (`skill-filesystem`) is about **13 per minute** (per process; 834 lines within 42 minutes) — an audit log earns its keep by making anomalies findable, not by copying one sentence 800 times.

A window closes at exactly three points, and **no timer is introduced** (settlement is lazy): (1) a new message with the same key arrives past the window's right edge; (2) the process `exit` hook; (3) a runtime `flushDiagnostics()` call.

The two fields a `log-aggregate` line carries **in addition to** the 10 (**additional — no existing field is replaced or renamed**; first lines never carry `count`):

| Additional field | Meaning |
|---|---|
| `count` | Total messages in that window including the first line (`1 + number folded`) |
| `aggKey` | Aggregation key: first 16 hex digits of `sha256(level ⊕ name ⊕ msg)` (excludes `ts` / `sn` / `pid` / `args`) |

**Rotation and retention limits**: a hard split at **64 MiB** per volume (new volumes `-1` / `-2` … increase monotonically; no reordering, no going back); **14 days** of retention (judged by the date inside the volume's name; closed volumes older than "today − 14 days" are deleted); **512 MiB** total (when exceeded, the oldest are cleaned up first).

**No remote reporting whatsoever**: the audit log is written to local disk only — no network egress, no remote sink, no OTel export. This is a hard constraint, not a default value.

**Fidelity bounds (honest statement)**: what aggregation guarantees is that **message counts remain checkable** — folded messages get their own counter, and the message-surface identity `messagesSeen = (writes − aggregateRows) + filteredByLevel + collapsedMessages + failures` always holds (`writes` counts **successfully written lines**, and a counting line is one of them, which is why it is deducted in a message-surface equation; `aggregateRows` = counting lines produced) — it does **not** mean "every line is preserved verbatim". Item by item:

- **B1 The exact timestamps of suppressed lines are necessarily lost**: only the **first line**'s real time and the counting line's **last** time survive; the exact instants of the other `count-2` messages in the window **cannot be recovered from the sink**, so per-message arrival intervals cannot be recomputed.
- **B2 Suppressed lines' `sn` is lost**: only the first line's `sn` remains; sequence-number continuity can no longer prove that nothing was dropped.
- **B3 Suppressed lines' `args` is lost**: the key is `(level,name,msg)` only, so messages with **the same text but different arguments** can be folded as well — and that folding **cannot be told apart** from the written content.
- **B4 Folding can span "logically different" events**: the same warning recurring across ticks or sessions is semantically several events, yet it lands as a single `count` value.
- **B5 An unclosed window loses its count under a hard kill**: when the process is terminated forcibly (no `exit` hook fires), the last window's counting line is never written and its `count` lives only in memory — the log keeps just that window's first line. The `aggregate` section of the runtime diagnostics file `diagnostics/sink-diagnostics.json` (`windowOpen` / `collapsedTotal` / `keys`) is the **only** way to recover that.
- **B6 Aggregation is cross-source**: folding is by `(level,name,msg)`, which stacks with the "capture surface cannot be narrowed per ctx / plugin" note below — readers **cannot infer from the source name** which line was folded (this plugin's own critical warns share the source name with its routine info).

**Note for third-party auditors**: seeing `kind:"log-aggregate"` means `count-1` further messages in that window were **not written line by line** and their exact timestamps are unavailable. Hence: the line count no longer equals the message count; for a **closed** window the message count is the first line (1) plus that window's `count`; a window that has not closed yet (process still running, or killed hard) has only its first line, and its folded count exists only in the runtime counters and the diagnostics file (see B5).

**Capture surface (honest statement)**: what gets logged is **diagnostic text + absolute paths + session/batch identifiers + Error stacks**, i.e. **metadata-level**; the business data itself is not recorded. **Note that the capture surface cannot be narrowed per ctx / plugin**: the logger's exporter registry is process-global, so this plugin has no "isolate by context" capability and cannot promise "only my own logs are recorded" — loading this plugin means in-process logs are recorded along with it. Narrowing by source name is equally unreliable: this plugin's own critical warns share the same source name `dsh-punky-swarm` as its routine info.

**Known boundaries**: multiple processes writing the same sink root are not supported — when several dsh instances on one machine share a single `DSH_HOME`, the same volume is appended to concurrently (a single write is ≤ 32 KiB, so lines never interleave) and the volume counters may each start at `.1` and overwrite same-named volumes. To run several isolated instances side by side, point each one at its own directory with `PUNKY_AUDITLOG_SINK_DIR`. The audit sink only provides local traces for troubleshooting and inspection; it is not a security-audit or compliance-audit capability.

## Installation

Prerequisites: DeepSeek Harness (dsh) installed, Node.js ≥ 22.

```sh
# Install and load into dsh (replace the profile with the one you actually use)
dsh plugin add dsh-punky-swarm
dsh web restart
```

> Alternative: `npm install -g dsh-punky-swarm` and load it with `dsh plugin --profile <profile> add dsh-punky-swarm`; for development you can also point a `link:` entry at the local package directory.

## Packaged assets and where they land

The package ships a **preset body** (the jiufeng mode's discipline and assembly surface) and **team skills** (`software-team` / `design-team`). Once the plugin is loaded into dsh, these assets are synced into your home directory, which is what makes the skills loadable at runtime.

### Package path → deployed location

| Package path | Deployed location (home directory) | Nature |
|---|---|---|
| `presets/jiufeng/` | `~/.dsh/.agent-presets/jiufeng/` | User-machine install surface: synced with the preset |
| `presets/jiufeng/asset-manifest.json` | `~/.dsh/.agent-presets/jiufeng/asset-manifest.json` | User-machine install surface: the asset manifest itself, and the source of the declarations in the table below |
| `skills/software-team/` | `~/.agents/skills/software-team/` | User-machine install surface: a skill directory, loadable by the `skill` tool |
| `skills/design-team/` | `~/.agents/skills/design-team/` | Same as above |
| `presets/hook-rules/` | **No home-directory location** | In-package, read-in-place surface: read in place from the plugin install directory (loaded once at boot), **never copied into `~/.dsh` or `~/.agents`**, so it never appears in your home directory |

### When the sync runs

- **The sync runs when the plugin starts or reloads** (the `apply` phase of dsh loading this plugin), once per process; it is not per tool call, and no command is provided to trigger it manually at an arbitrary moment.
- Consequence: **assets changed in the package while dsh is running need a dsh restart to take effect**.
- **The sync is driven by the in-package manifest `presets/jiufeng/asset-manifest.json`** — the manifest declares which package paths are synced and where each one lands, instead of hard-coding those paths in code; adding or adjusting assets means editing the manifest (its target roots are exactly two enums: `preset` = `~/.dsh/.agent-presets` and `skill` = `~/.agents/skills`; no absolute paths).
- **A missing or broken manifest never means a silent no-sync**: if the file is absent, fails to read, is invalid JSON, or has non-compliant fields, the mechanism **falls back to the three built-in defaults** (the first three rows above) and still syncs them, while emitting a startup-log warning: `asset manifest 不可用（…），已回退内置默认资产表；用户机实装面可能与包内清单声明不一致`. In other words, in the worst case the three assets still get installed and only the manifest's declarative role is lost — it is visible in the log rather than silently skipped.

### The asset manifest (human-readable schema)

The manifest is the in-package file `presets/jiufeng/asset-manifest.json`; it writes "in-package relative path → target root → target subpath" as JSON. Its fields and shipped values:

```json
{
  "manifestVersion": 1,
  "description": "蟛蜞模式（jiufeng）资产清单：声明包内预设与团队技能到用户机实装面的单向同步（真源=包内 skills/，不反向同步）",
  "assets": [
    { "rel": "presets/jiufeng", "note": "蟛蜞模式预设本体", "target": { "root": "preset", "subpath": "jiufeng" } },
    { "rel": "skills/software-team", "note": "软件工程团队技能（真源）", "target": { "root": "skill", "subpath": "software-team" } },
    { "rel": "skills/design-team", "note": "设计团队技能（真源）", "target": { "root": "skill", "subpath": "design-team" } }
  ]
}
```

| Field | Meaning and constraint |
|---|---|
| `manifestVersion` | Manifest schema version, currently `1` |
| `description` | One-line description |
| `assets[].rel` | In-package relative path (`/`-separated; no `..`, `\`, `:` or leading `/`) |
| `assets[].note` | What the entry is for (human-readable, optional) |
| `assets[].target.root` | Target root type; only `preset` / `skill` |
| `assets[].target.subpath` | Target subpath inside the root (same path rules as `rel`) |

**The source direction is one-way**: the in-package `skills/` is the single source of truth and the sync goes package → your machine; edits under `~/.agents/skills/` **do not** flow back into the package.

### Idempotence and caveats

- **Idempotent**: identical content is skipped (no rewrite); differing content is fully overwritten.
- **What it does**: **extra files inside a live target root are cleared by that overwrite** (for example, if `stale.md` no longer exists in the package, the `stale.md` in the target root disappears after the sync too).
- **What it does not do**: **an old target root directory is not deleted.** After an asset is renamed or removed, its old target root gets no sync action at all — `syncDir` with no job means no action — so **the old directory stays behind in your home directory** (historically, when a skill was renamed from `jiufeng-team` to `software-team`, the old directory stayed).
- **Cleanup is manual**: after a skill rename, delete the old directory by hand, or both names coexist and skill-directory loading and assembly assertions may match twice; likewise, **removing an entry from the manifest only stops the sync — it does not clear the copy already on your machine**, and that cleanup is manual too.
- The bootstrap entry (the manifest file itself) is re-copied to your home directory on every sync, so the manifest copy there is never older than the declarations this run actually executed; **directory-type assets are the ones that go through the content-equality check, while file-type assets (such as the bootstrap entry) are re-copied in full on every sync**.

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

The current version is sourced from `packages/dsh-punky-swarm/package.json` (see `CHANGELOG.md`); 900+ tests passing (measured on Node 24, CI covers Node 22/24); peer dependencies @deepseek-ai/dsh-tools (^0.1.0-rc.6 \|\| ^0.1.1-rc.2) and @deepseek-ai/cordis (^4.0.1); listed on awesome-dsh-plugin.

Honest boundaries: in-process governance for a single machine — no distributed cluster sync, no cost control, no model-tier routing; zero cloud dependencies and no network exposure by default; failure is terminal and rework means a new batch, never auto-resume.

## License

Licensed under **GNU AGPL v3 (AGPL-3.0-only)** as the sole license: you may freely use, modify and redistribute (including commercially) under [AGPL-3.0](LICENSE); if you provide the software as a network service after modification you must make the modified source available.
