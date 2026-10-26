# 契约豁免清单（contract-exemptions）

> **写盘纪律（TODO-2）**：本目录（`reports/`）**可写**；但写完**必须提交**才能跑禁区门 —— `FORBIDDEN_ZONES` 只判**未提交面**，正确顺序 = `freeze → commit → run`。

> 批次 `punky-quantity-todo-20261027` ｜ lane `e36-exemptions` ｜ 唯一上游 = `punky-quantity-rulings-20261027/exec/contract-table.md`（CX-01..CX-25）
> 本件两处**内容逐字一致**：批次内 `exec/exemptions.md` 与仓内 `reports/contract-exemptions.md`（sha 对账见 §六）

## 授权出处（谁裁的 · 什么时候 · 裁了什么）

> **用户裁定** ｜ 时间：**2026-10-27** ｜ 本清单全部 25 条的授权来源逐条如下（编号可被任何下游引用）。

| 编号 | 裁定内容 |
|---|---|
| **C-1** | 先建成**可枚举表**再裁（不许拿「约 60 条」这种核不到条的数来裁） |
| **C-1b** | **订阅数 6 条**（`CX-02/03/04/05/09/10`）并回接受，**条件 = `e33` 完成后按并行读数判** |
| **C-2** | **中 11 条**全接受（`CX-12 … CX-22`） |
| **C-3** | **低 3 条**全接受（`CX-23 / CX-24 / CX-25`） |
| **C-4** | 路由「**只锚定存在性，不锚定数量**」← **这一条直接导致 `4 → 28`**（4 = 原 4 条 `routes.length === 7` 数量断言；28 = 替换后的存在性/身份断言面） |
| **C-5** | 豁免清单落 `reports/contract-exemptions.md`（即本件） |

> 因此「**4 条 `routes.length === 7` 断言被删除**」是**用户裁定授权的定向替换**，
> **不是**顺手删断言；替换后判据在「**删除/替换**」方向**不变弱**，仅在「**合法新增**」方向不再假红。

## 〇、用途与效力

| 项 | 说明 |
|---|---|
| **作用** | 下次普查命中本清单条目 ⇒ 直接标 `契约（豁免）`，**不进待改清册** |
| **为什么豁免** | 这些数字**本身就是协议/算法契约**：改它 = **协议变更**，不是「对象合法增长」⇒ 不满足普查「合法增长即假红」的前提 |
| **不豁免什么** | 清单外一律照普查口径处置；`未决 15` / `剔除 2` / 已转存在性的 3 条路由 **不在**本清单内 |
| **撤销方式** | 协议变更时（加原语 / 加订阅点 / 改形参 / 换摘要算法）须**同时**改断言并删本清单对应行，不得只改一边 |

## 一、⚠ 认识论红线：6 条订阅数的依据是**语义**，不是「验证过」

`CX-02 / CX-03 / CX-04 / CX-05 / CX-09 / CX-10` 这 6 条的**依据列一律为 `语义（非 flake 证据）`**。确切含义：

```text
这 6 条从未红过。
「从未红」= 没有失败记录，≠ 契约被验证过。
「缺席失败 ≠ 正确」：没坏过只说明「订阅数在这段时间没被改动」，
   不说明「若订阅数被改动会有断言拦住」。
豁免资格只能由语义支撑：删掉这条断言会丢什么（见「为何是协议契约」列）。
```

**禁止**在本清单或任何下游产物中把它们写成「已由 flake 验证」「多次运行零 flake 证明该契约成立」。
`e33` 之后的 5/5 零 flake 只证明 **flakes 不在订阅数**，是**无 flake 的反证**，不能反推契约成立。

## 二、25 条豁免清单

| 编号 | 当前树 file:line | 断言原文 | 定义处锚（`lib/**`） | 为何是协议契约 | 风险分级 | 依据 |
|---|---|---|---|---|---|---|
| **CX-01** | `test/audit-blind-review.test.js:40` | `assert.equal(BLIND_REVIEW_ROLES.length, 3);` | `lib/assembly/schema.js:75` | 盲审**角色集恰 3 个**——加第 4 个角色是协议变更，删掉后无人拦 | **高** | 语义（枚举定义） |
| **CX-02** | `test/auto-settle.test.js:87` | `assert.equal(hooks.length, 1, '恰一条 subagent/end 订阅');` | `lib/engine/auto-settle.js:27` | `subagent/end` **恰 1 条**主路订阅——重复订阅会让同一子代理结束被结算两次 | **高** | 语义（非 flake 证据） |
| **CX-03** | `test/auto-settle.test.js:659` | `assert.equal(hooks.length, 1, '恰一条 subagent/end 订阅');` | `lib/engine/auto-settle.js:27` | 同上；此条钉**缺省兼容路径**（未声明开关时照装 1 条） | **高** | 语义（非 flake 证据） |
| **CX-04** | `test/auto-settle.test.js:852` | `assert.equal(subagentEndCount(ctx), 2, '装配后引擎主路面已挂（结算路 + 唤醒路两订阅；缺省 = 启用，R-1）');` | `lib/engine/auto-settle.js:26-27` | 装配后引擎主路面**恰 2 路**（结算路 + 唤醒路）——少挂唤醒路则「完成不唤醒 Leader」无人拦 | **高** | 语义（非 flake 证据） |
| **CX-05** | `test/auto-settle.test.js:874` | `assert.equal(subagentEndCount(ctx), 2, 'L-AC-13：热写 true ⇒ 订阅 0 → 2（结算路 + 唤醒路一并恢复）');` | `lib/engine/auto-settle.js:26-27` | 热写 true 后订阅由 **0 恢复为 2**——只恢复一半（漏唤醒路）无人拦 | **高** | 语义（非 flake 证据） |
| **CX-06** | `test/engine-dispatch.test.js:579` | `assert.equal(ROLE_MANDATORY_FIELDS.length, 5, 'R-1a：元组长度 = 5');` | `lib/engine/dispatch.js:275` | 角色元组**恰 5 个必填字段**（`Object.freeze` 只冻结数组，不冻结长度契约） | **高** | 语义（枚举定义） |
| **CX-07** | `test/governance-decisions.test.js:31` | `assert.equal(GOVERNANCE_PRIMITIVES.length, 6);` | `lib/governance/decisions.js:19` | 裁决原语**恰 6 种**——新增第 7 个原语是协议变更 | **高** | 语义（枚举定义） |
| **CX-08** | `test/plan-criteria-config.test.js:58` | `assert.ok(Array.isArray(ENGINE_BASELINE_PLAN_SECTIONS) && ENGINE_BASELINE_PLAN_SECTIONS.length === 6);` | `lib/assembly/flows.js:91` | plan 基线**恰 6 节**——删一节或新增未同步指引无人拦 | **高** | 语义（枚举定义） |
| **CX-09** | `test/swarm-wake-addressing.test.js:165` | `assert.equal(hooks.length, 2, '前置：`subagent/end` 面须为两路订阅（结算路 + 唤醒路）');` | `lib/engine/auto-settle.js:27` | `subagent/end` 面**须为两路**（前置）——少一路后后续断言会以「唤醒未发生」而非「结构变了」红，误判成本高 | **高** | 语义（非 flake 证据） |
| **CX-10** | `test/swarm-wake-addressing.test.js:430` | `assert.equal(hooks.length, 2, '`subagent/end` 面仍为 2 路订阅（新增订阅结构未变）');` | `lib/engine/auto-settle.js:27` | 新增订阅结构后**仍为 2 路**——加第 3 路（可能重复唤醒）无人拦 | **高** | 语义（非 flake 证据） |
| **CX-11** | `test/w7f-rt-write-surface.test.js:146` | `assert.equal((INDEX_SRC.match(/new Proxy\(/g) ?? []).length, 1, 'new Proxy( 须恰 1 处');` | `lib/index.js:876` | `new Proxy(` **恰 1 处** = 写通道唯一入口；出现第二条写通道（绕过 onWrite）无人拦 | **高** | 语义（结构单点） |
| **CX-12** | `test/auditlog-sink-stderr.test.js:250` | `assert.equal(lines.length, 1, 'stderr 行数 === 1（实际 ' + lines.length + ' 行: ' + JSON.stringify(r.stderr) + '）');` | `lib/auditlog/sink.js:741` | stderr **首失败只刷 1 行**（输出面硬契约）；改 `>=1` 后一次失败刷 N 行无人拦 | **中** | 语义（输出面上限） |
| **CX-13** | `test/auditlog-sink-stderr.test.js:285` | `assert.equal(lines.length, 2, 'stderr 行数 === 2（实际 ' + lines.length + ' 行: ' + JSON.stringify(r.stderr) + '）');` | `lib/auditlog/sink.js:62` | stderr 通知**上限 2 行**（`MAX_STDERR_NOTICES=2`）；常量改 3 时不红 | **中** | 语义（上限常量） |
| **CX-14** | `test/auditlog-sink-stderr.test.js:308` | `assert.equal(lines.length, 2, 'count=' + count + ' ⇒ stderr 行数恰 2（实际 ' + lines.length` | `lib/auditlog/sink.js:62` | `count=N` 触顶后**仍只 2 行**——改 `>=2` 放过「触顶后继续刷行」 | **中** | 语义（上限常量） |
| **CX-15** | `test/audit-blind-review.test.js:73` | `assert.equal(cfg.panelistCount, 2, 'config panelistCount 默认 2');` | `lib/assembly/audit-blind-review.js:82` | `panelistCount` **缺省 2**（防流程膨胀的默认值）；缺省被改 1/3 无人拦 | **中** | 语义（默认值契约） |
| **CX-16** | `test/audit-blind-review.test.js:107` | `assert.equal(spec.config.panelistCount, 2);` | `lib/assembly/audit-blind-review.js:82` | 规格回显的 `panelistCount` 与缺省**一致**——回显与默认脱钩无人拦 | **中** | 语义（默认值契约） |
| **CX-17** | `test/p2-single-point.test.js:282` | `assert.equal(singlePointMailboxRootOf.length, 3, '单点参数个数 = 3（root, sessionId, batchId）');` | `lib/mailbox-paths.js:35` | 单点函数**形参个数 = 3**（root, sessionId, batchId）——签名增删形参破坏所有调用面 | **中** | 语义（API 形参） |
| **CX-18** | `test/p2-single-point.test.js:283` | `assert.equal(commsMailbox.mailboxRootOf.length, 3, '① 导出面保形：参数个数不变');` | `lib/mailbox-paths.js:35` | ① 导出面保形：四路导出的 `mailboxRootOf` 形参个数一致 | **中** | 语义（API 形参） |
| **CX-19** | `test/p2-single-point.test.js:284` | `assert.equal(dispatchMailbox.mailboxRootOf.length, 3, '② 导出面保形：参数个数不变');` | `lib/mailbox-paths.js:35` | ② 导出面保形（同上） | **中** | 语义（API 形参） |
| **CX-20** | `test/p2-single-point.test.js:285` | `assert.equal(heartbeatContext.mailboxRootOf.length, 3, '④ 导出面保形：参数个数不变');` | `lib/mailbox-paths.js:35` | ④ 导出面保形（同上） | **中** | 语义（API 形参） |
| **CX-21** | `test/engine-dispatch.test.js:698` | `assert.equal(renderRoleGuide.length, 1, '签名恰 1 个入参（只吃**已解析**的 role 对象，不吃 id 字符串）');` | `lib/engine/dispatch.js:621` | `renderRoleGuide` **恰 1 个入参**（只吃已解析 role，不吃 id 字符串）——签名破坏面变更无人拦 | **中** | 语义（API 形参） |
| **CX-22** | `test/engine-dispatch.test.js:730` | `assert.equal(hits.length, 1, 'role_guide 须恰注册 1 件');` | `lib/engine/dispatch.js:511` | 工具面**恰注册 1 件** `role_guide`——重复注册（双源）或漏注册无人拦 | **中** | 语义（注册唯一性） |
| **CX-23** | `test/auditlog-mount.test.js:494` | `assert.equal(buf[buf.length - 1], 0x0a, '末字节 = LF');` | `lib/auditlog/sink.js:754` | JSONL 行**以 0x0a 结尾**（字节级格式契约）——写 CRLF 或漏 LF 无人拦 | **低** | 语义（格式常量） |
| **CX-24** | `test/atomic-write-ordering.test.js:253` | `assert.equal(before.sha256.length, 64, 'sha256 十六进制摘要的**形状契约**（64 字符；非规模快照）');` | `lib/governance/hash-utils.js:59` | sha256 hex **定长 64**——摘要换 md5(32)/sha1(40) 后存在性断言无法区分 | **低** | 语义（算法常量） |
| **CX-25** | `test/governance-receipt-anchor.test.js:110` | `assert.equal(sha256Hex('abc').length, 64, 'sha256 hex 摘要定长 64 字符（算法契约，非规模快照）');` | `lib/governance/hash-utils.js:59` | sha256 hex **定长 64**（同上，回执锚路径） | **低** | 语义（算法常量） |

## 三、4 条行号漂移：**四件齐全**（禁只写新行）

> 旧行号来自上游 `contract-table.md`；该表产出后 `auto-settle.test.js` 又被追加了行，故当前树行号 +2。
> **`CX-02` 与 `CX-03` 的断言文本一模一样**（`assert.equal(hooks.length, 1, '恰一条 subagent/end 订阅')`）
> ⇒ 仅靠行号或文本**无法区分**，必须用**所属 test 名**消歧。

| 编号 | 旧行 | **新行（当前树）** | 消歧依据 | 所属 test 标题（含起行） |
|---|---:|---:|---|---|
| **CX-02** | `:85` | **`:87`** | 所属 test 含 **A1** | `A1: installAutoSettle 以 ctx.on("subagent/end", h, { global: true }) 注册（scope 化插件 ctx 默认漏收，global 为硬性要求）` |
| **CX-03** | `:657` | **`:659`** | 所属 test 含 **J1** | `J1: 【R-1 缺省兼容 · L-AC-1】未声明开关键 ⇒ 主路照装（installed:true / 恰 1 条 subagent/end / opts={global:true} / count()=0）` |
| **CX-04** | `:850` | **`:852`** | 消息含「**装配后**」（test = J8） | `J8: 【R-5 热更生效 · L-AC-13】runtime.json 写 autoSettle.enabled:false ⇒ 主路订阅 1→0（无需重启）；写回 true ⇒ 0→1` |
| **CX-05** | `:872` | **`:874`** | 消息含「**热写 true**」（与 CX-04 **同一 test** ⇒ 只能靠消息消歧） | `J8: 【R-5 热更生效 · L-AC-13】同上（同一 test 块内两条订阅数断言）` |

> **CX-09**（`swarm-wake-addressing.test.js:165`）不属于上述 4 条，但有同类风险需登记：
> 该行**不在任何 `test()` 块内** —— 它是模块级 helper 的前置断言（`:163` `function wakeHookOf(ctx)`、`:164` 取 hooks、`:165` 断言、`:166` 返回 `hooks[1]`）。
> 消歧依据 = 「函数名 `wakeHookOf` + 行内消息『前置：`subagent/end` 面须为两路订阅』」——**不能靠 test 名**（它没有）。

## 四、统计（可与上表逐行数出）

| 分类 | 条数 | 编号 |
|---|---:|---|
| 高 · 枚举/结构类 | 5 | CX-01 / CX-06 / CX-07 / CX-08 / CX-11 |
| 高 · 订阅数（依据 = 语义，非 flake） | 6 | CX-02 / CX-03 / CX-04 / CX-05 / CX-09 / CX-10 |
| 中 | 11 | CX-12 … CX-22 |
| 低 | 3 | CX-23 / CX-24 / CX-25 |
| **合计** | **25** | 5 + 6 + 11 + 3 = 25 ✅ |
| 不入清单 · 未决 | 15 | 见 `contract-table.md` §五（缺 `lib/**` 锚 / 定义面不在 `lib/**`） |
| 不入清单 · 剔除 | 2 | `preset-rules:58` / `:168`（存在性 / 形状断言，非数量） |
| 不入清单 · 已转存在性的路由 | 3 | 路由断言已改身份/存在性 ⇒ **不再是契约**，不豁免 |

## 五、复核方式（任何人可重跑，25 条 + 12 个锚一次过）

```bash
cd D:/dsh/Punky-plugin-onto/packages/dsh-punky-swarm

# —— 25 条断言（当前树行号）——
sed -n '40p'   test/audit-blind-review.test.js        # CX-01
sed -n '87p'   test/auto-settle.test.js               # CX-02（test=A1）
sed -n '659p'  test/auto-settle.test.js               # CX-03（test=J1）
sed -n '852p'  test/auto-settle.test.js               # CX-04（J8·装配后）
sed -n '874p'  test/auto-settle.test.js               # CX-05（J8·热写 true）
sed -n '579p'  test/engine-dispatch.test.js           # CX-06
sed -n '31p'   test/governance-decisions.test.js      # CX-07
sed -n '58p'   test/plan-criteria-config.test.js      # CX-08
sed -n '165p'  test/swarm-wake-addressing.test.js     # CX-09（helper wakeHookOf）
sed -n '430p'  test/swarm-wake-addressing.test.js     # CX-10
sed -n '146p'  test/w7f-rt-write-surface.test.js      # CX-11
sed -n '250p;285p;308p' test/auditlog-sink-stderr.test.js  # CX-12..14
sed -n '73p;107p'       test/audit-blind-review.test.js    # CX-15..16
sed -n '282p;283p;284p;285p' test/p2-single-point.test.js   # CX-17..20
sed -n '698p;730p'      test/engine-dispatch.test.js        # CX-21..22
sed -n '494p'  test/auditlog-mount.test.js            # CX-23
sed -n '253p'  test/atomic-write-ordering.test.js     # CX-24
sed -n '110p'  test/governance-receipt-anchor.test.js # CX-25

# —— 定义处锚 ——
sed -n '75p'   lib/assembly/schema.js                # BLIND_REVIEW_ROLES
sed -n '275p'  lib/engine/dispatch.js                # ROLE_MANDATORY_FIELDS
sed -n '19p'   lib/governance/decisions.js           # GOVERNANCE_PRIMITIVES
sed -n '91p'   lib/assembly/flows.js                 # ENGINE_BASELINE_PLAN_SECTIONS
sed -n '876p'  lib/index.js                          # new Proxy( 唯一写通道
sed -n '27p'   lib/engine/auto-settle.js             # subagent/end 订阅契约
sed -n '62p;741p' lib/auditlog/sink.js               # MAX_STDERR_NOTICES / stderr 写面
sed -n '82p'   lib/assembly/audit-blind-review.js    # panelistCount: 2
sed -n '35p'   lib/mailbox-paths.js                  # mailboxRootOf
sed -n '621p;511p' lib/engine/dispatch.js            # renderRoleGuide / role_guide
sed -n '754p'  lib/auditlog/sink.js                  # JSONL 行尾
sed -n '59p'   lib/governance/hash-utils.js          # sha256Hex
```

## 六、两处一致性

| 位置 | 用途 |
|---|---|
| 批次内 `exec/exemptions.md` | 审计 / 裁决取件面 |
| 仓内 `reports/contract-exemptions.md` | 普查口径的**输入**（下次普查直接读，命中即标 `契约（豁免）`） |
| 一致性 | 两份 **sha256 相同**；改任一份必须同步另一份 |

## 七、本件未做的事（如实）

- **未改**任何测试、`lib/**`、`package.json`、`README`；只新建上述两个文件。
- **未跑**测试套件（本件是清单，不产生代码变更）。
- **未做**「按级别抽样复跑」——那属 audit 的 AC-1 抽检。
- **未**把 6 条订阅数写成「已验证」——见 §一。
