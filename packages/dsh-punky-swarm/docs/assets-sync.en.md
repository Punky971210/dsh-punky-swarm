# Packaged assets and where they land

> This section was moved out of the repository-root `README.md` (2026-10-10 README slimming); its body is preserved verbatim.
> Original location: `README.en.md` `## Packaged assets and where they land` (originally lines 156–211).

---

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
