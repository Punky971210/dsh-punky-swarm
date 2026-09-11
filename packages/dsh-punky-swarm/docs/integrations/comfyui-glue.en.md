# Integration Declaration: comfyui-glue (external plugin sub-module relationship)

> This document declares the "sub-module" relationship between dsh-punky-swarm and the external plugin **comfyui-glue**: what it is, where the boundary lies, how to install it, how to verify it, and how to roll it back.
> 中文：[comfyui-glue.md](comfyui-glue.md)

## 1. Relationship Definition

The engineering definition of a sub-module in this repository is **one sentence**:

> Sub-module = **one hard-coded declaration contract + one runtime linkage criterion**, both living inside this repository; the other repository's physical location, build chain and release cadence stay completely unchanged. This repository has **zero module dependency and zero build-time contact** with it — the only coupling point is the **host (dsh) tool surface**.

Four "don'ts" (the boundary itself):

| # | Don't | Meaning |
|---|---|---|
| 1 | **Don't move directories** | comfyui-glue stays in its own repository (local working copy: `D:\Project\comfyui-glue`) and evolves and releases independently |
| 2 | **Don't create a module edge** | This repository does not `import` it, and never writes it into `dependencies` / `peerDependencies` / `optionalDependencies` |
| 3 | **Don't create a mount line** | This repository's `cordis.patch.yml` adds **no** `insert` line for comfyui-glue (see §5) |
| 4 | **Don't modify the other repository** | This repository writes none of comfyui-glue's files (including its `package.json`) |

## 2. The Tool Surface Is the Interface (4 capability names, verbatim)

The linkage interface is **not** new code added by this repository — it is the tool surface already provided by the host. This repository declares only the **capability-name set** and the **decision semantics**:

| # | Tool name (verbatim, case-sensitive) | Purpose |
|---|---|---|
| 1 | `comfy_probe` | Probe ComfyUI backend reachability, version and checkpoint list |
| 2 | `comfy_object_info` | Read ComfyUI node object information (object_info) |
| 3 | `comfy_run` | Submit one workflow execution |
| 4 | `comfy_fetch_output` | Fetch execution outputs |

The probe primitives are provided by the host (public, read-only, zero side effects). This repository **adds no probe tool, adds no probe function module, and changes no existing route payload**.

## 3. Decision Semantics (frozen)

- Capability-name set = the **4 names above, verbatim, case-sensitive**.
- `available = true` ⟺ **all** 4 names are registered; any missing ⇒ `partial` + missing list; 0 present ⇒ `absent`.
- The probe **reads the name set only**: it does not read implementations, does not execute tools, does not register anything, does not write to disk, and does not change routes or tool counts.

Three paths for the runtime to learn "the 4 tools are registered" (ordered by strength):

1. **Callability (strongest, host-level real evidence)**: call `comfy_probe` directly — unregistered yields `UNKNOWN_TOOL`, registered yields a structured result.
2. **Visibility (model surface)**: the tool list is visible to the model, so it is known before dispatch.
3. **In-process determination (for future orchestration consumers)**: filter the host tool catalogue by the `` `comfy_` `` prefix.

> When the ComfyUI backend (default `127.0.0.1:8188`) is not listening, `comfy_probe` returns `ready:false` + `error.code` — this is **also** evidence that the tool is registered (the tool ran; only the backend service is down).

## 4. Dependency Declaration

| Surface | Ruling |
|---|---|
| This repository's `package.json` | **Zero dependency edge**: no comfyui-glue entry in `dependencies` / `peerDependencies` / `optionalDependencies` |
| Deployment surface (profile) | The `link:` dependency stays in the profile (a deployment-time resolution mechanism, not package metadata) |
| Documents + guard test | This file (declaration) + `test/integration-comfyui-glue.test.js` (turns the declaration into executable assertions) |

Rationale: this repository consumes a **tool name**, not a **module**, so `peerDependencies` semantics do not hold; and the other package is not published to npm ⇒ any version range would be a dangling edge, and writing it into a publicly released package's metadata would be irreversibly polluting.

## 5. Mount Prerequisite (the `insert` line **stays in the profile patch**)

comfyui-glue **declares no `dsh.bundle`** ⇒ `dsh plugin add` only installs it as an **ordinary dependency** and it never enters the bundle layer stack automatically; **the patch `insert` line is the only path into the loading tree**.

**That `insert` line belongs to the profile patch (deployment surface) and must not be moved into this repository's bundle patch.** Reasons:

- This repository's `cordis.patch.yml` lives **inside the package** (shipped with the release), while the profile patch lives on the **user's machine** (external to this batch); the two cannot be completed in one atomic change, so the intermediate state necessarily contains two `insert` entries with the same `id` ⇒ the loader throws `duplicate loader entry id: comfyui-glue` ⇒ **the whole site fails to start**.
- The `insert` line's `name` is resolved at deployment time (first from the installation, then from the profile directory); comfyui-glue exists only in the profile's `node_modules`. Putting it into a publicly released package's patch would make other machines try to insert an unpublished package too.

**Cross-form criterion (anti-drift)**: the comfyui-glue `insert` line is **globally unique** — in the composed configuration tree, `- id: comfyui-glue` must appear **exactly once**. If the count is > 1, stop immediately and report.

## 6. Install and Uninstall

Four install steps (order matters):

1. **Back up** the profile patch: `cordis.patch.yml` → `cordis.patch.yml.bak-<yyyymmdd-HHMMSS>`.
2. **Profile dependency**: `dsh plugin --profile web add link:D:\Project\comfyui-glue`
   — note: the package has no `dsh.bundle`, so this step only installs it as an ordinary dependency and warns "declares no dsh.bundle"; it does **not** enter the layer stack automatically.
3. **Append the single unique insert line** to the profile patch (both `id` and `name` are `comfyui-glue`); grep first to confirm no residual entry with the same `id`.
   — **This step is not done in this repository, nor in this repository's `cordis.patch.yml`.**
4. **Restart dsh web** (user action), then smoke-test: the startup log shows no `duplicate loader entry id` and no `tool "..." is already registered`; then call `comfy_probe` for real.

Uninstall = reverse order: remove the `insert` line from the profile patch → `dsh plugin --profile web remove comfyui-glue` → restart.

This repository adds **no install script** (the official `dsh plugin` is already the entry point; and hand-rolled scripts would only widen the risk surface of writing to the user's profile).

## 7. Boundary with the Cross-Version Prerequisite (C1/C2)

- Synchronising the **two peer** ranges of comfyui-glue (host runtime packages) is **not owned by this repository**; it belongs to the deployment-surface / cross-version prerequisite workstream. This repository **does not update them, does not touch them, does not edit them on its behalf**.
- This repository treats the profile's `dsh.profile.bundles`, the profile patch, and the kernel installation directory as strictly **read-only**.
- If implementation reveals that "the declaration only holds if the profile or the other repository's peers are changed" ⇒ **stop and report**; do not write across the boundary.

## 8. Decoupling Rules (R1–R4, hard constraints)

Goal: when the other repository is **unreachable** (moved / renamed / different machine), this repository's `install` / `check` / `build` / `test` **all still succeed**.

- **R1 zero module references**: no cross-repository module or path reference of any form (`import` / `require` / dynamic `import`) may appear under `lib/`, `test/` or `scripts/`. Capability names may appear only as **string literals**. `docs/` may mention paths (a document is not a reference) but must not provide copy-pasteable import statements.
- **R2 zero build-input coupling**: `tsconfig.json.include`, `tsconfig.build.json.rootDir`, the copy-back script's copy-back list, and `package.json.files` must contain no path outside this package (`../` or absolute); the copy-back list stays a **hard-coded array** — **glob is forbidden** (glob would silently pull future external artefacts into the build).
- **R3 zero test coupling**: new tests must not import the other module, must not connect to the ComfyUI port, and must not read the other repository's paths (sole exception: a static scan of **this repository's own** files).
- **R4 zero install coupling**: this repository's `package.json` gains no dependency edge on comfyui-glue.

## 9. Evidence Commands (3, read-only)

```powershell
# E1 mounted and unique (read-only; starts no service, binds no port)
dsh --profile web --dump-config | Select-String -Pattern '^\s*- id: comfyui-glue\s*$'      # expected: exactly 1 line

# E2 this repository's bundle patch adds no such insert (anti duplicate id)
Select-String -Path 'D:\dsh\Punky-plugin\packages\dsh-punky-swarm\cordis.patch.yml' -Pattern 'comfyui-glue'   # expected: 0 hits

# E3 the profile-side link dependency is in place
(Get-Item 'C:\Users\Administrator\.dsh\profiles\web\node_modules\comfyui-glue').LinkTarget   # expected: D:\Project\comfyui-glue
```

Decoupling self-proof (closed loop inside this repository):

```powershell
npm run check; npm run build; npm test                       # all three exit 0
Test-Path .\node_modules\comfyui-glue                        # expected: False
Get-ChildItem lib,test,scripts -Recurse -File |
  Select-String -Pattern 'comfyui-glue' -Encoding UTF8       # expected: 0 hits (except the whitelisted strings in the guard test)
```

## 10. Rollback

| Surface | Action |
|---|---|
| This repository's declaration | Delete the 2 added documents + 1 guard test; remove the two `files` whitelist entries (or restore from the pre-change backup) |
| profile | Restore from the sibling `cordis.patch.yml.bak-*` or from the snapshot image; **requires a restart to take effect**; **never delete** existing `.bak-*` files |
| The other repository's peers | Single-file rollback, performed **in the same batch** as the profile link change, to avoid an intermediate state |

## 11. Stop Conditions (stop, restore, report; no self-remediation, no downgrade)

| ID | Condition |
|---|---|
| S1 | Any of this repository's `check` / `build` / `test` fails and cannot be localised in reasonable time ⇒ roll back, report |
| S2 | Discover that "the declaration only holds if the profile (including the insert line) is changed" ⇒ stop at that boundary, report |
| S3 | Discover that "the declaration only holds if the other repository's peers (or any of its files) are changed" ⇒ stop, report |
| S4 | The composed configuration tree shows more than one `- id: comfyui-glue`, or this repository's patch is asked to add that insert ⇒ stop immediately (it would break site startup) |
| S5 | Any action requiring a **dsh restart / port 3080 / starting or stopping ComfyUI** ⇒ do not do it; convert it into a manual to-do |
