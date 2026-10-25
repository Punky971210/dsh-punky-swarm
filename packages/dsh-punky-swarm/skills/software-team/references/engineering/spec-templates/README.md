# SpecLang 规格面模板（recommend · 按需取用）

上游原文在 `references/vendor/speclang/`（29 件，`b3ee6ee`，**原件为准**）。本目录只放**可直接抄的骨架**，
避免每个批次各写一套；抄完请按本批实际字段改写，**不要保留本目录的示例值**。

## 什么时候用

- 批次里有「需求 → 契约 → 实现」三层要对账，且**希望机械可核**（不是只写散文计划）；
- 或者验收里要声称「规格与实现一致」，需要一条能红能绿的命令作证据。

只写普通计划、不做规格对账的批次，用适配层的 `S-7`（记分口径，入口见 `SKILL.md` 真源表）即可，不必引入本模板。

## 三步

### 1. 写规格：`speclang.yaml`

抄 `speclang.yaml.tpl`，字段含义见文件内注释与 `references/vendor/speclang/speclang-waterfall/assets/MECHANICAL_RULES.md`。

### 2. 跑机械校验：拿到 `SUMMARY:` 机读行

```sh
# ① 优先用仓内薄壳（四态，退出码原样透传）
node scripts/speclang-validate.mjs <spec.yaml>

# ② 若 ruby 不在当前进程 PATH（Windows 常见），用绝对路径显式指定
node scripts/speclang-validate.mjs --ruby="D:/Program Files/Ruby40-x64/bin/ruby.exe" <spec.yaml>

# ③ 找 ruby 在哪（一条命令，别靠猜）
where ruby        # Windows
command -v ruby   # bash / macOS / Linux
```

判定口径：**只有 `exit 0` ＋ `SUMMARY: 0 failures, 0 warnings. [PROCEED...]` 才算通过**；
`exit 2` 是 UNKNOWN（ruby 不可用 / rb 原件缺失）——**UNKNOWN 不计通过**，也不许写成"通过"。

### 3. 负控：证明校验器真的会红

**绿行不是充分证据**。抄 `mc-negative-controls.tpl.mjs`，为每条你要依赖的规则构造一个变异体：
改坏一处 → 跑校验器 → 断言 `exit != 0` 且输出命中**该规则 id**。

- 变异体必须是**副本**，跑完删掉，绝不改原 spec；
- 每条规则都写一条变异；**一条变异没红 = 该规则在本批不可依赖**，要如实登记，不能默认它生效；
- 已知现象：一条变异可能同时命中多条规则（如删 contract 字段连带其它规则）⇒ 记「非一对一」，不影响可达性结论。

## 有牙的门（可选，但推荐）

审计产物里写一行 `gate:`，让引擎在合并前真跑对账：

```sh
# 核「plan 要求的 CC-* / hoare-check 在验收里有没有交代」
node scripts/check-spec-accounting.mjs --plan <plan.md> --acceptance <audit.md>
```

退出码：`0` 全部有交代 / `1` 有要求未交代（打印缺口清单）/ `2` 用法或文件错误（fail-closed）。
「未执行」必须带原因才放行——只写"未执行"判红。

## 文件

| 文件 | 用途 |
|---|---|
| `speclang.yaml.tpl` | 规格骨架（字段带注释） |
| `mc-negative-controls.tpl.mjs` | 交叉平台负控跑法（Node，无第三方依赖） |
