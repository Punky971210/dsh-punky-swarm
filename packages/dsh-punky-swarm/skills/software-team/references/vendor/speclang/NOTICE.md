# NOTICE — 第三方资产说明（SpecLang）

本文件说明 `references/vendor/speclang/` 目录内第三方资产的来源、许可与逐件校验值。
本目录内容是**上游原文副本**，不是本仓撰写的文档，也不随本仓的工程细则一同演进。

## 一、来源与版本

| 字段 | 值 |
|---|---|
| 组件名 | **SpecLang**（四技能合集：`prd-guide` / `speclang-waterfall` / `speclang-hoare-check` / `ui-component-registry`） |
| 来源 URL | `https://gitcode.com/xuanjz/SpecLang` |
| 版本钉 | **`b3ee6ee`**（提交短哈希；**不锚 `HEAD`** —— `HEAD` 会随上游演进漂移，导出的副本必须能指回确定的那一版） |
| 导入日期 | `2026-10-24` |
| 许可 | **Apache-2.0 with Runtime Library Exception** |
| 署面 | **The Cangjie Project**（与同目录 `LICENSE` 第 2 行逐字一致） |
| 权利状态 | **权利人待确认** —— `LICENSE` 署名字面与本仓名、与上游仓名三者不一致，故**不得**当作已确认填写；在权利人书面确认前，本目录只作内部参考使用 |

## 二、变更清单（**未改动，逐字复制**）

本目录 27 件资产与 1 件 `LICENSE` 均为上游文件的**字节级副本**：
未改名、未扁平化、未调格式、未转行尾、未修 typo。校验口径 = 两侧 `sha256` 逐件相等。

采集命令（两侧同一口径，禁手抄）：

```bash
cd <上游>/.github/skills && find . -type f | sort | xargs -d '\n' sha256sum
cd <上游> && sha256sum LICENSE
cd <本仓>/skills/software-team/references/vendor/speclang && find . -type f | sort | xargs -d '\n' sha256sum
```

| # | 上游相对路径（`.github/skills/` 之后） | 字节 | sha256 |
|---:|---|---:|---|
| 1 | `prd-guide/SKILL.md` | 15,732 | `d817219b646ded11ecb8925cebd03f9bbd4b0fdeb576b402a1bd94aaead95455` |
| 2 | `prd-guide/assets/prd-template.md` | 4,267 | `45e7511f22c0c1780f39d62bd86e0ba4b745b0fcfe280e2f10d48f753e564fab` |
| 3 | `speclang-waterfall/SKILL.md` | 4,335 | `d4c0777bd176e90218eb8723c2063e4cca96b990585e5ec51ae7335487b1892b` |
| 4 | `speclang-waterfall/assets/MECHANICAL_RULES.md` | 7,888 | `fdbf06ffa9a3d3cd70e1ccc41dc49abc599fcd71af607374da95d8800b81b635` |
| 5 | `speclang-waterfall/assets/SYNC_NOTES.md` | 6,709 | `5a661e33c397dd5566c2fe01e030dc1f47fe79bf8fd31f42a2adda711febd062` |
| 6 | `speclang-waterfall/assets/code_consistency_checks.md` | 12,303 | `8938e2dff40ac04290667fecc29ba3b4b4a7cd7f10d9127e80293e2f4d212ce5` |
| 7 | `speclang-waterfall/assets/reporting_requirements.md` | 2,523 | `c9c4ab13c8d3d410f9a8678a5cfe48eb4a2af7541a82a73672e6f9d0c91c1d6b` |
| 8 | `speclang-waterfall/assets/speclang-template.yaml` | 16,663 | `49f4e010e25f4141d3a35ebc22892cf00405acda9d0f591b7d31a772c9ba3a9e` |
| 9 | `speclang-waterfall/assets/speclang_authoring_and_validation_workflow.md` | 9,436 | `1585e0f5630cb9fd5199012b91c89b8a20f5bbad1ec70ac8b549e688a214d594` |
| 10 | `speclang-waterfall/assets/speclang_foundation_reference.md` | 18,265 | `96cb583f31d8ee61e662c7245b4097820a61f6a77bc15387e2e526290dd0ad2d` |
| 11 | `speclang-waterfall/assets/test_validate_speclang_mechanical.rb` | 37,246 | `2540c38866e581b0866e01d95794255503098076c89182eba9b69ec5bbc88f6f` |
| 12 | `speclang-waterfall/assets/validate_speclang_mechanical.rb` | 54,771 | `a62af0c7a76fdf239f6f1c8ffef9b5610b2471feea67f7f7a2c8523d8db7c1d9` |
| 13 | `speclang-hoare-check/SKILL.md` | 24,572 | `86e101bd58bdc03a3be83933765a4af3ddd896885c53b58ecd9d4c11a74a7544` |
| 14 | `speclang-hoare-check/assets/hoare-reasoning-report-template.md` | 6,962 | `25afbe671a75ea2d9826349abc94192f8edc0ab521d3e08655b2cc4363c48cdd` |
| 15 | `ui-component-registry/SKILL.md` | 11,430 | `242589d237b02eaa1e02ef94c0c78fc54604327c2db3a2181ddcb46b60b0643c` |
| 16 | `ui-component-registry/assets/constraints/accessibility-rules.yaml` | 12,326 | `b138638f6c4eb23291e06db51c9e45b454e7296cce2a919700de29d719cc0193` |
| 17 | `ui-component-registry/assets/constraints/ios-pod-constraints.yaml` | 7,480 | `6bc11c460b7c2cfa0e594346e3258f56aa93317e183c3aeffa438c8a9d83e5e6` |
| 18 | `ui-component-registry/assets/constraints/performance-guidelines.yaml` | 8,565 | `7e3a6993b476c40ad8b732bd841c466bbb08f7c920d9080eb35123f005a93a6c` |
| 19 | `ui-component-registry/assets/guides/pseudocode-to-arkui-arkts.yaml` | 31,813 | `3e3a6563d03a63be8e49de84f1c9044a1283e6d5444e03ba027c8128eb94b90a` |
| 20 | `ui-component-registry/assets/guides/pseudocode-to-arkui-cangjie.yaml` | 28,656 | `ea9d3b772f2a194bd956aae1d8264125b5af929da8886e57771832bd4379e6f4` |
| 21 | `ui-component-registry/assets/guides/pseudocode-to-compose.yaml` | 12,571 | `3162e43272209905a5b75f3f02aad76310c8ce7816d01272e28112770399e770` |
| 22 | `ui-component-registry/assets/guides/pseudocode-to-flutter.yaml` | 14,431 | `bc54027814ea1ec13e0c95b2102816c324c8fc8f3315eef482cacc8e08ba5ddd` |
| 23 | `ui-component-registry/assets/guides/pseudocode-to-react-native.yaml` | 13,010 | `b6d96e4f123349db2f38c3efb77b247d80e015747a571920ae1b337babf7a249` |
| 24 | `ui-component-registry/assets/guides/pseudocode-to-swiftui.yaml` | 12,398 | `6a476da56cec026ecfc3cd9cb6986d797c2c97f65d70be9a88671ad5faadc06f` |
| 25 | `ui-component-registry/assets/guides/pseudocode-to-uikit.yaml` | 15,921 | `dd45cc2584582285d3655c55c48bd1991a5d52f729a6e86f54c3e47927c5c8d8` |
| 26 | `ui-component-registry/assets/guides/pseudocode-to-web.yaml` | 15,759 | `59dafaeac981e10c3dc51871650b8db3cae2bbd2a4db725d2379a20ff5823551` |
| 27 | `ui-component-registry/assets/kinds-catalog.yaml` | 106,839 | `1f6968ce564aabf89fd53b332499f932636aa6c079352e057a3dc271e51de08e` |
| 28 | `LICENSE` | 12,396 | `c6b19ceadc94d277930cd8a91ea324c73f322e22561a58457e92962b1ffb110e` |

**合计：27 件资产 512,871 B ＋ `LICENSE` 12,396 B = 525,267 B**（`sha256` 表共 28 行）。
第 28 行的 `LICENSE` 取自上游**仓根**（不在 `skills/` 下），其余 27 行的路径均相对上游 `.github/skills/`。

## 三、刻意排除（**非遗漏，是决定**）

| 被排除项 | 字节 | 排除理由 |
|---|---:|---|
| `speclang-waterfall/assets/dist/speclang-convert-standalone.py` | 153,701 | ① 它是上游的**构建产物**（`dist/` 目录下的单文件打包）；② 可由上游源重新生成 ⇒ 入仓等于存一份可复现的派生物；③ 本仓**不使用**其转换功能，保留只会增加体积与审计面。故本目录**不含**该文件；将来若确需转换能力，应连同生成方式一并评估，而不是单独搬入派生物 |

> 因此上游 `.github/skills/` 侧共 28 件，本目录只收 **27 件**（28 − 1）。
> 排除项**不计入** §二 变更清单（清单只列在场件），此表即其正式登记位。

## 四、`LICENSE` 副本保留

- 同目录 `LICENSE` 是上游仓根 `LICENSE` 的**逐字副本**（`sha256` 见 §二 第 28 行），**必须与资产一同分发，不得单独移除**。
- 本目录的 `LICENSE` 与 `NOTICE.md` 构成该第三方资产的许可合规面：删任一件即视为违反本仓的 vendor 四条件（许可副本 / 本说明 / 逐件校验值 / 署面保留）。
- 发包面：包清单 `files` 已含 `skills` ⇒ 本目录随包自动携带，**无需**扩充白名单。

## 五、文件清单归属

| 上游技能 | 在场件数 | 本目录位置 |
|---|---:|---|
| `prd-guide` | 2 | `prd-guide/` |
| `speclang-waterfall` | 10 | `speclang-waterfall/`（不含 §三 排除项） |
| `speclang-hoare-check` | 2 | `speclang-hoare-check/` |
| `ui-component-registry` | 13 | `ui-component-registry/` |
| —（许可面） | 1 | `LICENSE` |
| **合计** | **28** | 另加本文件 `NOTICE.md` ⇒ 目录内共 **29 件** |
