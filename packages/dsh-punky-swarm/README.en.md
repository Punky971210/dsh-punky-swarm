# dsh-punky-swarm

> **A cluster-governance plugin + engine for DeepSeek Harness (dsh)** — it decomposes "large module development" into a three-layer **plan → exec → audit** DAG, with **gates / state machine / blackboard / settlement**, so multi-member work is **dispatchable, auditable and recoverable**.
> **Version baseline: `0.5.0` = the new baseline** — the team-asset (`team-asset`) and `chain` declaration faces have been **fully retired**; `team` is now an **optional free-form label** (never parsed, never validated, never blocks batch creation).
> **Supported hosts (two lines)**: `@deepseek-ai/dsh` **`0.1.7-rc.2`** / **`0.2.0-rc.1`** — see the dual-line support matrix in **§3.2** for each line's **upstream pinning**.

---

## 1. What this is

- **Engine surface**: `wave_plan` (layer tasks into waves by dependency DAG, **never recomputed mid-batch**) → `lane_dispatch` / `member_status` (dispatch) → `handoff_submit` (per-edge handoff) → `member_settle` (settlement); plus `gate_status` (gate state), `log_export` (event export) and `lane_heartbeat` / `lane_longrun` (supervision).
- **Governance rules**: 24 items (difficulty routing / three-layer gates / handoff & batch / run modes / audit & acceptance / recovery & supervision / output & guidance / two-direction spec). Details in `references/discipline.md`; the Manager-side definition is `references/manager.md`.
- **The `0.5.0` baseline**: with the team-asset and `chain` declaration faces retired, **assembly follows "engine baseline + member slots + guidance"**, and the runtime DAG source of truth is the batch's `lanes[].deps` + `handoffs`.

---

## 2. What you get after installing (three faces)

| Face | Carrier | Landing point / notes |
|---|---|---|
| ① **Plugin** (core) | `lib/**` + **two rows** in `cordis.patch.yml` | the **engine row** `dsh-punky-swarm` (governance tools + panel) and the **preset-registration row** `dsh-agent-preset-punky` (since 0.1.7 a preset **must** be registered by a plugin row; the preset directory is no longer scanned) |
| ② **Mode & guidance** (core) | **`punky-preset`** registered through `@deepseek-ai/dsh-agent-preset` | `references/discipline.md` / `references/manager.md` are **idempotently synced** by `syncAssets()` at startup into `<home>/.dsh/.agent-presets/punky-preset/` |
| ③ **Team skill pointers** (extra) | the **8 directories** under `skills/` | `acceptance-gate` / `design-team` / `engine-team` / `research-team` / `retro-and-memory` / `review-execution` / `software-team` / `writing-team` ⇒ synced to `<home>/.agents/skills/<name>/` |

---

## 3. Install (the **single command**)

**Step 1 — build the distributable package** (run inside the package directory):

```bash
pnpm pack                 # ⇒ dsh-punky-swarm-0.5.0.tgz
```

**Step 2 — the single install command** (dev / offline; on a clean `DSH_HOME` one command installs everything):

First read the **host rc** (referred to below as `<HOST_RC>`; example value on this machine: `0.1.7-rc.1` — always use your own host's output):

```bash
dsh --version
```

```bash
dsh plugin --profile web add <ABSOLUTE_PATH>/dsh-punky-swarm-0.5.0.tgz @deepseek-ai/dsh-experimental-agent-team-profile@<HOST_RC> @deepseek-ai/dsh-agent-preset@<HOST_RC>
```

**Three hard requirements (do not skip)**:

1. **List both upstream packages explicitly, and pin both to the host rc**: `<HOST_RC>` comes from the `dsh --version` above (e.g. host `0.1.7-rc.1` ⇒ write `@0.1.7-rc.1` in both places). **Why a caret is wrong and a fixed `rc.2` is also wrong** — see §3.1 (getting this wrong makes the **mode face vanish silently**).
2. **No bare spec, no tag-style spec**: a spec with no version is **rejected outright** by the compatibility gate (see the `latest` trap in §4); using a dist-tag instead of a version **switches lines silently** as upstream publishes (the `next` tag now points at the new line) ⇒ **always write `<HOST_RC>` as an exact version** (e.g. `0.1.7-rc.2` / `0.2.0-rc.1`).
3. **The explicit spec cannot be omitted**: this package's `dependencies` key has been **removed entirely** ⇒ the upstream packages are **provided by the install command only** (the package carries **no** upstream version range); the profile's `dsh.profile.bundles` **only registers newly added top-level dependencies** ⇒ **transitive dependencies never become a profile layer** ⇒ the command **must** spell out the full package name + version.

### 3.1 Why the spec must be pinned to the host rc (**never a caret, never a fixed `rc.2`**)

- **① A prerelease caret floats silently**: `^0.1.7-rc.1` **includes** `0.1.7-rc.2`, and the package manager picks the **highest satisfying version** ⇒ you think you installed rc.1 but you actually get **rc.2**. **The dependency-declaration layer cannot express "same rc as the host"** — which is exactly why this constraint lives in the **command**.
- **② The mode-registration package is exactly coupled to the host registry**: `@deepseek-ai/dsh-agent-preset@0.1.7-rc.2` pins `@deepseek-ai/dsh-agent-preset-registry@0.1.7-rc.2` in `peerDependencies`, while an rc.1 host ships `…-preset-registry@0.1.7-rc.1` ⇒ **version mismatch** ⇒ at startup the engine **disables the row**: `preset-minimal` / `preset-cordis` / **`dsh-agent-preset-punky`** ⇒ **the mode face vanishes silently** (per-entry fail-soft: the process still starts and writes only one stderr line `disabling profile plugin row …`; **no UI hint**).
- **③ A fixed `rc.2` is equally wrong**: on an rc.1 host it reproduces the chain above, and on an rc.2 host pinning rc.1 does the same ⇒ **the only self-consistent form = read the host rc from `dsh --version` and pin both upstream packages to it** (that is what makes "all four on one rc" true).
- **④ This package's `dependencies` no longer carries any `-profile` entry at all** (the key was **removed entirely** ⇒ the command owns it, which **eliminates the "two families coexisting" condition**), which is **even less** a reason to omit the spec (see requirement 3); `@deepseek-ai/dsh-agent-preset` is likewise **not** in `dependencies` — precisely because of the floating chain above (its peer is exactly coupled to the host registry).

**Additional notes**:

- Use an **absolute path** for `<ABSOLUTE_PATH>` (`dsh plugin` uses `process.cwd()` as pnpm's cwd, so relative paths are easy to get wrong).
- On a clean `DSH_HOME` the command **auto-initializes the `web` profile**; no manual setup needed first.

### 3.2 Dual-line support matrix (host × upstream pinning)

| Host line | Supported | The **exact suffix** for both specs in the command | Install-command shape | Proven / not yet proven |
|---|---|---|---|---|
| **Old line** `0.1.7-rc.2` | **✓** | `@deepseek-ai/dsh-experimental-agent-team-profile@0.1.7-rc.2` + `@deepseek-ai/dsh-agent-preset@0.1.7-rc.2` | **Still the same single command** (§3 Step 2): replace both `<HOST_RC>` with `0.1.7-rc.2` | **Proven (resolution layer + runtime)**: the upstream packages are **provided by the command only** (this package's `dependencies` key was removed entirely); the **three resolution probes** give `distinct=1` — once for the new line (`0.2.0-rc.1`) and once for the old line (`0.1.7-rc.2`) — plus **zero hits for all four packages when no spec is passed** (the **precondition for the two families coexisting is eliminated**); the `@deepseek-ai/dsh-*` ranges in `peerDependencies` pass on all three versions (the kernel compatibility gate reads only those); the workflow row is a **single row** with identical id/name in both copies (guarded by an in-repo consistency test). **Actually run**: the old line `0.1.7-rc.2` was exercised on a **real isolated instance** `D:\dsh\iso-0.1.7-rc.2` (a genuine rc.2 kernel) — **3/3 GREEN**, with the three faces / workflow / port / sentinel all passing; **the only uncovered item = an in-place boot on a real pre-existing profile** (readings in the batch artifact `exec/verify-fix.md`, **that conclusion has not landed ⇒ registered as pending re-check**, see §9) |
| **New line** `0.2.0-rc.1` | **✓** | `@deepseek-ai/dsh-experimental-agent-team-profile@0.2.0-rc.1` + `@deepseek-ai/dsh-agent-preset@0.2.0-rc.1` | Same as above: replace with `0.2.0-rc.1` | **Proven (resolution layer)**: the upstream packages are **provided by the command only** (same as above); the resolution probe gives **`distinct=1` on the new line** (before the fix, the union range produced **both families in one lock** — **negative case on record**); this machine has the isolated carrier `D:\dsh\iso-0.2.0-rc.1`. **Runtime**: batch 6 observed **install-layer non-determinism** on this line (9 runs, 6 red on identical input: **form A** — exactly one of the three sub-packages falling back to the old line, silently disabling its row; **form B** — the whole install failing with `status=1`); this batch **eliminates form A's precondition at the resolution layer**, while **form B is environment / package-manager side and is not promised as fixed** (it is only required to **fail loudly**) ⇒ two-line runtime readings live in `exec/verify-fix.md` (**pending re-check**) |
| Reference · `0.1.7-rc.1` | ⚪ **not a target line** | Same shape (pin `0.1.7-rc.1`) | Same as above | Only a **stand-in for the old line** (what this machine's CLI actually ships); it is **not** a target row here — **the two rows above are authoritative** |

> **Shared prerequisite**: `@deepseek-ai/dsh-workflow-ptc` comes **from the kernel** (all three kernels `0.1.7-rc.1` / `0.1.7-rc.2` / `0.2.0-rc.1` depend on it) ⇒ **nothing extra to install** (see §4).
> **Declaration-face convention**: this table is the **human-readable** declaration face; the **machine-readable** one is the range of the `@deepseek-ai/dsh-*` entries in this package's `peerDependencies` (the kernel compatibility gate reads **only** that; **unchanged in this batch**). **The upstream packages are not provided by this package**: its `dependencies` key has been **removed entirely** ⇒ they come **only from the install command's explicit specs** (`<HOST_RC>`). **No `compatibility.json` exists in this package and none should be added** — in DSH that filename means a **profile-level exemption table** (it lives in the profile directory), so putting one in a package has **no consumer**.

---

## 4. Upstream dependency / prerequisite (two explicit specs)

The **two upstream packages** in the install command (see §3), with their roles and where they are declared:

| Package | Role | Declared in |
|---|---|---|
| `@deepseek-ai/dsh-experimental-agent-team-profile` | **Aggregate bundle**: installing it brings in `-agent-team` / `-client-ui-agent-team` / `-tool-agent-team` — the **source of the** `spawn_teammate` / `team_task_*` / `send_message` / `wait_agent` / `list_agents` / `interrupt_agent` **tool surface** | **Command only** (**no longer in `dependencies`** — that key was removed entirely, so the command owns it) |
| `@deepseek-ai/dsh-agent-preset` | **The mode-registration plugin itself** (the `dsh-agent-preset-punky` row in `cordis.patch.yml` names it) — without it, face ② **vanishes silently** | **Command only** (**removed from `dependencies`**: its prerelease caret floats to the highest rc, and its peer is **exactly coupled** to the host registry ⇒ floating means row-disabled; see §3.1) |

- **As long as the host has the official dsh packages it just works** — no separate manual install is needed (the command already carries the specs).
- ⚠ **The `latest` trap (hard)**: that team profile package has `dist-tags.latest = 0.1.5-alpha.2`, which is **incompatible** with the `0.1.7` line ⇒ **a bare install (no version/tag) is rejected outright by the compatibility gate** (engine wording: `an incompatible version is never installed`). The same applies to `@deepseek-ai/dsh-agent-preset` (`latest = 0.1.7-alpha.1`).
- **Keep all four on one rc**: all four (the two explicit specs plus the sub-packages pulled in by `-profile`) should stay on **one rc line** (= the host rc, shaped like `0.1.7-rc.x` / `0.2.0-rc.x`); **do not mix rc versions**.
- **`workflow-ptc` comes from the kernel (same source on both lines ⇒ nothing extra to install)**: `@deepseek-ai/dsh-base` depends on `@deepseek-ai/dsh-workflow-ptc` on **all three** of `0.1.7-rc.1` / `0.1.7-rc.2` / `0.2.0-rc.1` ⇒ you do **not** need to install any workflow package, and you must **not** add the old pusher row back (see the prohibitions in §9).
- **The two faces of the adaptation declaration**: **machine-readable** = the range of the `@deepseek-ai/dsh-*` entries in `peerDependencies` above (the **only** face the kernel compatibility gate reads; passes on all three versions); **human-readable** = the §3.2 dual-line support matrix. ⇒ **No new in-package declaration artifact is introduced** (no `compatibility.json`, no invented fields — the kernel reads **neither**).
- **This package's dependency declaration for the team service (batch `decl-face-and-logging-20260930`, 2026-09-30)**: the engine consumes the host team service **`agentTeams`** (`ctx.get('agentTeams')` → `listMembers`, the source of truth for the Manager roster check) ⇒ that dependency is declared **on the assembly face** (the probe row `inject: [agentTeams]` in `cordis.patch.yml`) and is **never** put into `dependencies` (batch-7 invariant: that key was removed entirely; the upstream packages come only from the explicit specs on the install command). When the service is missing, that row goes **pending** (a **loud** startup audit: `pending (waiting for service: agentTeams)`), while the **sibling engine row and preset row stay alive** (the host is per-entry fail-soft).
- **`engines.dsh`: deliberately NOT written this round (a zero-effect documentation face)** — consumer evidence: `evaluatePluginCompatibility` (the `dsh-app-boot` compatibility gate) reads **only `peerDependencies`**, and only entries prefixed `@deepseek-ai/dsh` / `@deepseek-ai/dsh-` ⇒ **`engines.dsh` is consumed by no gate**; and `package.json` **cannot carry comments**, so writing it would easily be misread as an enforced constraint ⇒ this package **does not write that field**; kernel compatibility is carried **only by `peerDependencies` plus the §3.2 dual-line matrix** (the field is neither mandatory nor part of any rejection or validation).

---

## 5. Self-verification after install (three-face read-only check)

```bash
node scripts/selfcheck-install.mjs --home <dir> --json    # exit 0 ⟺ engine / preset / skills all present
node scripts/smoke-install.mjs                            # host-level install smoke (includes real-home pollution guard)
```

(Both scripts ship with the package; the smoke test installs once into a **temporary `DSH_HOME` + temporary home** and asserts all three faces.)

---

## 6. Isolated-test procedure (**copy it as-is**)

> ⚠ **Key fact**: `syncAssets()` resolves the home directory via **`os.homedir()`** and **does not read `DSH_HOME`**.
> ⇒ **Isolating `DSH_HOME` alone is not enough**: sync results would still be written into the **real user home** — `~/.agents/skills/*` and `~/.dsh/.agent-presets/punky-preset/*` (= **overwriting your existing assets**; this repo has a precedent of **21** real skill files being overwritten).
> ⇒ You **must isolate `DSH_HOME` **and** `USERPROFILE` / `HOME`**, and add a **before/after sha256 guard on the real home**.

### 6.1 Windows (PowerShell, line by line)

```powershell
# 0) Remember the real home -- step 2 overwrites these variables, so step 5 must use $Real
$Real = $env:USERPROFILE
$Tmp  = Join-Path $env:TEMP ("punky-iso-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path "$Tmp\dsh-home","$Tmp\home" -Force | Out-Null

# 1) sha256 baseline of the real home (read-only; covers both skills and preset)
Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue -Path "$Real\.agents\skills","$Real\.dsh\.agent-presets\punky-preset" | Get-FileHash -Algorithm SHA256 | Sort-Object Path | ForEach-Object { "$($_.Hash)  $($_.Path)" } | Set-Content "$Tmp\real-home.sha256.before"

# 2) Isolate BOTH variables (neither may be omitted)
$env:DSH_HOME    = "$Tmp\dsh-home"
$env:USERPROFILE = "$Tmp\home"
$env:HOME        = "$Tmp\home"

# 3) Run the single command from section 3 Step 2 in THIS window (do not open a new one, or the variables are lost)

# 4) Three-face assertions (examples; tighten as you like)
dsh --profile web --dump-config | Select-String 'dsh-punky-swarm'
dsh --profile web --dump-config | Select-String 'dsh-agent-preset-punky'
Test-Path "$Tmp\home\.agents\skills\software-team\SKILL.md"
Test-Path "$Tmp\home\.dsh\.agent-presets\punky-preset\references\discipline.md"

# 5) Pollution guard: recompute the real home and compare with the baseline -- empty output means pass
Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue -Path "$Real\.agents\skills","$Real\.dsh\.agent-presets\punky-preset" | Get-FileHash -Algorithm SHA256 | Sort-Object Path | ForEach-Object { "$($_.Hash)  $($_.Path)" } | Set-Content "$Tmp\real-home.sha256.after"
Compare-Object (Get-Content "$Tmp\real-home.sha256.before") (Get-Content "$Tmp\real-home.sha256.after")
```

- **Guard verdict**: `Compare-Object` with **no output** = the real home was untouched; **any output = FAIL** ⇒ **keep the `$Tmp` scene** (do not delete it) and inspect the differences.
- When done, remove the temp root: `Remove-Item -Recurse -Force $Tmp` (**only after the guard passes**).

### 6.2 POSIX (macOS / Linux)

```bash
Real="$HOME"; Tmp="$(mktemp -d)"; mkdir -p "$Tmp/dsh-home" "$Tmp/home"
find "$Real/.agents/skills" "$Real/.dsh/.agent-presets/punky-preset" -type f 2>/dev/null | sort | xargs shasum -a 256 > "$Tmp/real-home.sha256.before"
export DSH_HOME="$Tmp/dsh-home" USERPROFILE="$Tmp/home" HOME="$Tmp/home"
# run the single command from section 3 Step 2 inside this shell
find "$Real/.agents/skills" "$Real/.dsh/.agent-presets/punky-preset" -type f 2>/dev/null | sort | xargs shasum -a 256 > "$Tmp/real-home.sha256.after"
diff "$Tmp/real-home.sha256.before" "$Tmp/real-home.sha256.after" && echo "GUARD OK" || echo "GUARD FAIL"
```

---

## 7. Uninstall / rollback

```bash
dsh plugin --profile web remove dsh-punky-swarm
```

Alternatively drop the package from the profile's `dsh.profile.bundles` and restart. Remove the team profile package the same way if you no longer need it.

---

## 8. Documentation

| Document | Contents |
|---|---|
| `references/discipline.md` | Governance rule details (code tables / semantics / boundaries / operation sequences) |
| `references/manager.md` | Generic Manager definition (behaviour layer) |
| `docs/engine-intro.md` | Engine internals |

---

## 9. Known boundaries (stated honestly)

- A failed install only produces a **stderr warning** (the engine is **per-entry fail-soft**, and neither of this plugin's two rows is on the required-startup list) ⇒ the mode may end up **silently unmounted**. **Use the self-check script in §5 to verify actively.**
- Preset sub-entries mount during **session assembly** (not during startup auditing) ⇒ a bad sub-entry only affects **that preset's agent composition**, and it too only leaves a stderr line.
- The `latest` tag is incompatible with the `0.1.7` line (§4) ⇒ **always pin the version explicitly**.
- **Why one workflow row covers both lines, and what is forbidden**: the basis is that **all three** kernels `0.1.7-rc.1` / `0.1.7-rc.2` / `0.2.0-rc.1` depend on `@deepseek-ai/dsh-workflow-ptc` ⇒ **a single row is the dual-line answer**. **Prohibitions**: ① **never** add the old pusher row back (the **worker-thread** package under `@deepseek-ai/dsh-workflow-…`) — it would create a **guaranteed-failing row on one of the two lines**, and the old line risks **double mounting**; ② **never** add a `!!js` **version-conditional row** — the kernel exposes **no host-version variable** ⇒ such a condition is **unreachable**, and a bad expression just produces a new warning.
- **The old line has actually been run (coverage loss narrows to one item)**: the old line `0.1.7-rc.2` was exercised on a **real isolated instance** `D:\dsh\iso-0.1.7-rc.2` (**3/3 GREEN**, with the three faces / workflow / port / sentinel all passing); **the only uncovered item = an in-place boot on a real pre-existing profile** (an isolated run ≠ upgrading a live profile in place; runtime readings in the batch artifact `exec/verify-fix.md` — **that conclusion has not landed ⇒ registered as pending re-check**).
- **New-line install-layer non-determinism (found in batch 6 / fixed in this batch)**: on identical input the new line once went **9 runs, 6 red** — **form A** (exactly one of the three sub-packages falling back to the old line ⇒ that row **silently disabled**) and **form B** (the whole install failing with `status=1`); this batch **eliminates form A's precondition at the resolution layer** (the package no longer declares any upstream range ⇒ there is **no old version to fall back to** on a new-line host), while **form B is environment / package-manager side and is not promised as fixed** (only required to **fail loudly** with `status=1` + a diagnostics path) ⇒ two-line runtime readings belong to `exec/verify-fix.md` (**pending re-check**).
- **Tag-style specs switch lines silently** (§3.2 / §4): `latest` and dist-tags (such as `next`) may point at a **non-target line** ⇒ **always write an exact version**.
