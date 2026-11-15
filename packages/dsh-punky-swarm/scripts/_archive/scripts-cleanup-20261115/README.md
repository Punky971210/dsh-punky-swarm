# 归档脚本（2026-11-15）

> **本目录只作历史留档，不维护、不建议运行。**
> 这些文件已从 `scripts/` 移出。运行期真源见包根 `cordis.patch.yml`；在役脚本见 `scripts/`。
> 本目录内容若与在役实现不一致，**以 `scripts/` 与包根 `cordis.patch.yml` 为准**。
>
> ⚠ 原先打算放在 `docs/archive/`，但当时 `test/accept-pack1-guidance.test.js` 的 `AC-pack1-12` 把
> `baselines/**`、`docs/**`、`reports/**` 列为**禁区**（不得出现未提交变更）⇒ 改放 `scripts/_archive/`。
> **2026-11-15 补记**：该判据（连同整个 `accept-pack1-guidance.test.js`）已按「测试件不再检验文档」裁决删除
> ⇒ 上述禁区现**无机检**，由人工把关；本次归档位置保持 `scripts/_archive/` 不变（语义上更贴合，且不必再挪）。

## 为什么归档

用户 2026-11-15 裁决「弃用这类同步脚本，手动维护足够，检查项目内其他过度设计的脚本」，选定范围 B（3 项冗余脚本 + 7 个一次性探针）、方式 B（先移归档再删）。

| 文件 | 归档理由 | 证据 |
|---|---|---|
| `sync-guidance.mjs` | **纯冗余**：五件同步落点（`~/.dsh/.agent-presets/punky-preset`）已实证不参与装配，真源是包根 `cordis.patch.yml`；skills 同步已被 `lib/index.js` 的 `setImmediate(syncAssets)` 幂等覆盖，且 `lib/assets.js:35-41` 的 `DEFAULT_ASSETS` 覆盖全部 5 个团队 | 重启实测 + `lib/index.js` + `lib/assets.js:35-41` |
| `pkg-hashes.mjs` | **TD-02 已关闭**：清单不随仓维护；自述「不是门禁」，`--check` 恒 exit 0 | `references/discipline.md:741` |
| `docs-consistency.mjs` | **迁移已完成**：9 条判据已迁入 `test/capabilities-contract.test.js`，该文件注释写「先迁后删」 | `test/capabilities-contract.test.js:22` |
| `probe-boot-cost.mjs` | 一次性启动耗时探针，诊断使命完成 | 支撑 `exec/coldstart-session/notice.md`、`exec/boot-slim/notice.md` 读数 |
| `probe-sweep-defer.mjs` | 一次性启动清扫探针，与上者配套 | 同上 |
| `probe-host-pre-reject.mjs` | 一次性宿主预拒探针 | 诊断批产出 |
| `probe-harden-ask.mjs` | 一次性加固问询探针 | 诊断批产出 |
| `probe-batch-status-budget.mjs` | 一次性 `batch_status` 读面预算探针 | `reports/mcp-data-plane.md` 曾引用 |
| `probes/flex-assembly-audit.mjs` | 一次性装配灵活性审计探针 | 诊断批产出 |
| `dtier-machinecheck.mjs` | D 档前置机检，一次性（来源批 `guidance-dtier-20261001`） | 脚本头注释自述来源批 |

## 恢复方式

需要复跑某探针时，优先**重写一个更小的探针**而不是复活整份历史脚本；确需原件则 `git log --diff-filter=R -- <当前归档路径>` 追溯并 `git checkout`。
