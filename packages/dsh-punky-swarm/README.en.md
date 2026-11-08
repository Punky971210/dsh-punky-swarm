# dsh-punky-swarm

> **A cluster-governance plugin + engine for DeepSeek Harness (dsh)** — it decomposes "large module development" into a three-layer **plan → exec → audit** DAG, with **gates / state machine / blackboard / settlement**, so multi-member work is **dispatchable, auditable and recoverable**.
> **Version baseline: `0.5.0` = the new baseline** — the team-asset (`team-asset`) and `chain` declaration faces have been **fully retired**; `team` is now an **optional free-form label** (never parsed, never validated, never blocks batch creation).
> **Supported host**: `@deepseek-ai/dsh` **`0.2.x`** (wide declaration; no pinned rc). Prerelease hosts need an exemption in the plugin manager.

---

## 1. What this is

- **Engine surface**: `wave_plan` (layer tasks into waves by dependency DAG, **never recomputed mid-batch**) → `lane_dispatch` / `member_status` (dispatch) → `handoff_submit` (per-edge handoff) → `member_settle` (settlement); plus `gate_status` (gate state) and `log_export` (event export). `lane_heartbeat` / `lane_longrun` were **deleted in G3 B1** (previously maintenance-frozen: surface kept, no longer maintained; user ruling 2026-10-09). No tool entry remains — their event surface is now read via `batch_status` / `log_export`.
- **Governance rules**: **27 items in 9 groups** (difficulty routing / handoff & batch / run modes / audit & acceptance / settlement / recovery & supervision / output · capability · guidance / two-direction spec · numbering / knowledge-first pre-check). Details in `references/discipline.md`; the Manager-side definition is `references/manager.md`.
- **What it fixes**: four failure modes of running a team of agents — a downstream lane starting before its upstream artifacts exist, hours of work lost to a single crash, several members writing the same file at once, and a rejection nobody can explain. The tools were never the problem; what is missing is a gate in the flow. Once the gates live inside the engine, discipline becomes a machine criterion instead of each member's self-restraint.
- **The `0.5.0` baseline**: with the team-asset and `chain` declaration faces retired, **assembly follows "engine baseline + member slots + guidance"**, and the runtime DAG source of truth is the batch's `lanes[].deps` + `handoffs`.

---

## 2. What you get after installing (three faces)

| Face | Carrier | Landing point / notes |
|---|---|---|
| ① **Plugin** (core) | `lib/**` + **two rows** in `cordis.patch.yml` | the **engine row** `dsh-punky-swarm` (state machine / panel / HTTP / gate engine; it registers **no governance tools**) and the **preset-registration row** `dsh-agent-preset-punky` (since 0.1.7 a preset **must** be registered by a plugin row; the preset directory is no longer scanned).<br>The **governance tools** (27) are registered by the `punky-provider` row inside the preset composition ⇒ only `punky-preset` sessions (and the workers they spawn) see them in the tool catalog; other modes are untouched (assembly isolation, 2026-11-08) |
| ② **Mode & guidance** (core) | **`punky-preset`** registered through `@deepseek-ai/dsh-agent-preset` | `references/discipline.md` / `references/manager.md` are **idempotently synced** by `syncAssets()` at startup into `<home>/.dsh/.agent-presets/punky-preset/` |
| ③ **Team skill pointers** (extra) | the **5 directories** under `skills/` | `design-team` / `research-team` / `software-team` / `video-team` / `writing-team` ⇒ synced to `<home>/.agents/skills/<name>/` |

> **Capability layer (software-team)**: `skills/software-team/references/engineering/spec-contract.md` is now the **Punky adapter layer** (six-state evidence → `gate_status`/`verdict` mapping / where the `SUMMARY:` machine-readable line lands / the S-10 gap record); **the authoritative text for spec structure and mechanical rules is the vendored original inside this repo** (next paragraph), mounted per role by the role-to-reading table in `SKILL.md`.
> **External capability layer (vendored into this repo; recommend semantics unchanged)**: the same section of `SKILL.md` lists four external **SpecLang** (SpecArtisans) skills — `speclang-waterfall` / `speclang-hoare-check` / `prd-guide` / `ui-component-registry`. **The assets are vendored in-repo**: `skills/software-team/references/vendor/speclang/` (**29 files** = **27 upstream assets** + `LICENSE` + `NOTICE.md`, **532,898 B** total; version pin `SpecLang@b3ee6ee`, per-file sha256 in `NOTICE.md`), so you **read the in-repo originals** and do not depend on the host having a same-named skill installed. **Vendoring does not change recommend semantics**: still loaded on demand, never entering the engine assembly surface, absence is not a failure, and they affect no gate. Source license **Apache-2.0 plus the runtime-library exception**, signed **The Cangjie Project**, **rights holder to be confirmed**; a node wrapper `scripts/speclang-validate.mjs` is included (`exit 2` when `ruby` is unavailable = explicitly unproven, never fakes a pass). **Per-role entry points are wired in**: `coder`/`designer`/`coordinator` point at `speclang-waterfall/` (plus `prd-guide/`), `reviewer`/`tester`/`supervisor` at `speclang-hoare-check/` (adding `ui-component-registry/` for UI work) — one line each, marked "optional reading (recommend), NOT required"; `doc-manager` deliberately has none (K-3). Guarded by machine checks: exactly one pointer per each of the six mounted roles, every path `existsSync`-verified (a dead pointer fails), and each line must use recommend wording.

---

## 3. Install (the **single command**)

**Step 1 — build the distributable package** (run inside the package directory):

```bash
VERSION=$(node -p "require('./package.json').version")   # version comes from package.json only — never hard-coded in docs
pnpm pack                 # ⇒ dsh-punky-swarm-$VERSION.tgz
```

**Step 2 — the single install command** (dev / offline; one command on a clean `DSH_HOME`):

Upstream packages use the **`@next` dist-tag** (always the current 0.2 line, no pinned rc):

```bash
dsh plugin --profile web add <ABSOLUTE_PATH>/dsh-punky-swarm-$VERSION.tgz \
  @deepseek-ai/dsh-experimental-agent-team-profile@next \
  @deepseek-ai/dsh-agent-preset@next
```

**Three requirements**:

1. **List both upstream packages explicitly**: this package removed its `dependencies` key entirely ⇒ upstream packages come only from the command.
2. **Use `@next`, never a pinned rc**: these packages publish **no stable version** (only `-rc` / `-alpha`); measured `@0.2.x` ⇒ `could not be found`, so a wide `0.2.x` **cannot be used in an install command**. `@next` is the executable form of "follow the 0.2 line" and pins no specific rc.
3. **The explicit specs are not optional**: the profile's `dsh.profile.bundles` only records newly added top-level dependencies ⇒ transitive deps never become a profile layer.

**Notes**:

- `<ABSOLUTE_PATH>` must be absolute (`dsh plugin` uses `process.cwd()` as pnpm cwd; relative paths are error-prone).
- On a clean `DSH_HOME` the command auto-initializes the `web` profile.

---

## 4. Upstream dependency / prerequisite (two explicit specs)

| Package | Role | Declared where |
|---|---|---|
| `@deepseek-ai/dsh-experimental-agent-team-profile` | **Aggregate bundle**: pulls in `-agent-team` / `-client-ui-agent-team` / `-tool-agent-team` (source of `spawn_teammate` / `team_task_*` / `send_message` / `wait_agent` / `list_agents` / `interrupt_agent`) | Explicit in the command only |
| `@deepseek-ai/dsh-agent-preset` | **Preset-registration plugin** (`dsh-agent-preset-punky` row uses it as `name`) | Explicit in the command only |

- **Works as long as the host ships the official dsh packages** — upstream packages are provided only by the install command.
- **Version policy: declaration face vs install face**
  - `peerDependencies` = **wide declaration `0.2.x`** (the claim "host must be on the 0.2 line"), paired with `peerDependenciesMeta.optional` — otherwise npm 7+ treats it as an install gate.
  - `devDependencies` = **`^0.2.2-rc.1`** (`dsh-tools` / `dsh-scope` / `dsh-app-boot`): no stable release exists, measured `npm view '@deepseek-ai/dsh-tools@0.2.x' version` ⇒ `could not be found` (`>=0.2.0-0 <0.3.0-0` only matches `0.2.0-rc.x`) ⇒ the install face needs a resolvable rc lower bound or `npm ci` always fails.
  - Under standard semver `0.2.x` does **not** match prerelease hosts (e.g. `0.2.x-rc.y`) ⇒ allow/exempt them in the plugin manager.
- **`workflow-ptc` is provided by the kernel** (`@deepseek-ai/dsh-base` depends on it) ⇒ no extra install; **do not** re-add the legacy workflow row (see §9).
- **`engines.dsh` is not written**: the compatibility gate reads only `peerDependencies` (the `@deepseek-ai/dsh*` prefix); that field has zero effect.
- **Team-service dependency**: the engine consumes the host `agentTeams` service; the declaration lives on the assembly face (`cordis.patch.yml` probe row `inject: [agentTeams]`), not in `dependencies`. When missing, that row goes pending (loud at boot) while the engine and preset rows survive.

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
| `skills/software-team/references/engineering/spec-contract.md` | software-team capability layer: the **spec-contract rules** (mechanical rules / six-state evidence / machine-readable report line / requirement IDs; distilled reference from SpecLang `b3ee6ee`, recommend semantics, not assembly) |

---

## 9. Known boundaries (stated honestly)

- Install failure **only lands as a stderr warning** (per-entry fail-soft: neither plugin row is on the required boot list) ⇒ the preset may be **silently unmounted**. **Use the self-check script in §5 to verify** proactively.
- Preset sub-items mount **at session-assembly time** (not at boot audit) ⇒ a broken sub-item only affects that preset's agent composition, again leaving only stderr.
- **Version policy**: `peerDependencies` wide declaration `0.2.x` (**declaration face**) + `devDependencies` `^0.2.2-rc.1` (**install face**, no stable release exists); prerelease hosts (`0.2.x-rc.y`) do not match under standard semver — grant an exemption in the plugin manager.
- **workflow face**: `@deepseek-ai/dsh-workflow-ptc` is provided by the kernel, one row is enough. **Forbidden**: ① re-adding the legacy worker-thread workflow row (adds a guaranteed-failing row); ② adding `!!js` version-conditional rows (the kernel exposes no host-version variable ⇒ unreachable).
- **After a host upgrade**: if the plugin row is skipped by the compatibility gate (stderr: `skipping profile bundle`), check whether the `peerDependencies` wide declaration still covers the host major line, or explicitly allow that version in the plugin manager.
