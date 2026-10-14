# Audit log

> This section was moved out of the repository-root `README.md` (2026-10-10 README slimming); its body is preserved verbatim.
> Original location: `README.en.md` `## Audit log` (originally lines 78–143).

---

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
