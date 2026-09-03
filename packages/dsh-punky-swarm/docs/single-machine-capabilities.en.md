# Single-Machine Capabilities

> This document states the single-machine capability boundaries of dsh-punky-swarm in product language: local operation, zero cloud dependency, zero network exposure by default, plugin-scoped governance, deterministic zero-dependency.
> 中文: [single-machine-capabilities.md](single-machine-capabilities.md)

## 1. Local Operation

- The plugin runs inside the dsh (DeepSeek Harness) process; orchestration, adjudication and record-keeping all complete inside the local process;
- The governed objects are a cohort of Agent subprocesses orchestrated in the same process (batches / gates / communication / recovery re-dispatch);
- A single npm package contains: the plugin engine, the Punky Swarm preset (presets/jiufeng), and the jiufeng-team role guide (skills/jiufeng-team); on startup the plugin auto-syncs the preset and skills to the user directory — no manual placement needed;
- The read-only monitoring panel loads with the plugin (the "Punky Swarm cluster" tab in the session view), available on install.

## 2. Zero Cloud Dependency / Zero External Services

- The engine uses only native Node.js capabilities (node:fs / node:crypto / node:https / node:tls);
- Peer dependencies are the host runtime: @deepseek-ai/dsh-tools (host tools and execution context) and @deepseek-ai/cordis (plugin bus);
- No external database, no external message queue, no SaaS dependency; starting dsh locally provides the full governance capability.

## 3. Zero Network Exposure by Default (secure default)

- Network capabilities are all **off by default**: ACPs communication (`acps.*`) and the identity system (`aip.identity`) default off;
- When off, zero runtime footprint: no listeners, no timers, no network paths (nothing loads or instantiates);
- Only explicit enablement (e.g. `acps.endpoint.enabled`) loads listeners/clients; the external endpoint host defaults to `127.0.0.1` only;
- Factory guardrails are zero-interception: `governance.hook.rules` defaults empty (decide is always ALLOW) — usable on install, existing behavior unchanged.

## 4. Plugin-Scoped Governance Range

- The governance range is the cluster orchestration **inside a single dsh plugin process** (batch-level three-layer gates + call-level guardrails, two layers; see governance-technical.en.md / guardrails-hook.en.md);
- Batch/member state uses the state file as the single source of truth; events are fully recorded and auditable;
- Crash recovery is checkpoint preservation + recovery audit + idle re-dispatch (new workers can query checkpoints to skip completed steps); **no automatic resume** — failed lanes stay terminal, redo opens a new batch;
- Cross-machine distributed cluster sync, multi-machine orchestration, cost control and model tiering are outside the provided range (see §8 architectural boundaries in governance-technical.en.md).

## 5. Determinism and Zero Dependency

- The call-level guardrail kernel is a **synchronous, deterministic, zero-IO** pure function (`lib/governance/`): rule match → violation classification → decision, no external state involved;
- The refusal-receipt hash chain uses the standard-library sha256 (node:crypto) + deterministic canonical serialization (RFC8785 simplified: key sorting / no whitespace / undefined aligned with JSON.stringify) — same input, same output, reproducible verification;
- File IO (receipts / state / event streams) uses atomic writes (tmp+rename) with write-then-read verification, fail-closed, no partial artifacts left behind;
- The whole implementation adds zero new runtime dependencies (peer host dependencies + Node standard library only).

## 6. Connections to External Systems (optional, off by default)

- **National-standard AIP compatibility** (on by default, in-process read-only endpoints): generates tool/agent catalogs per the GB/Z 185-2026 descriptor structures — see [aip-compliance.md](aip-compliance.md);
- **ACPs communication** (off by default): external mTLS endpoint / internal bridge / registry / discovery — network paths exist only when explicitly enabled, see [acps-communication.md](acps-communication.md);
- Both capabilities are orthogonal to single-machine governance: when off, they affect no local governance function.
