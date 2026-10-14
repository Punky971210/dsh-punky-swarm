# 退役面台账（single ledger for retired faces）

> **本文档地位**：**退役面等值反转**族（`resolveTeamFlows` / 团队资产声明面已退役后，测试里对该面做「等值反转」说明的历史叙述）的**单一集中台账**。
> **建立**：批 `engine-techdebt-cleanup-r2-20261008` · lane `e03-comments-docs` · 判据项 **R-2**。
> **口径**：**集中 + 指针**，**不删史实** —— 下列 8 条**逐字归档原文**（保可追溯）；对应站点改为「一行指针」。
> **同族边界**：另有 ≥6 处同族站点**不在本轮授权面**（只登记，见 §3）。

---

## 1. 归档原文（R2-1 .. R2-8，逐字）

### R2-1 · `test/gate-techdebt-red.test.js:874`（注释）
```
//      ⇒ 命中 `TEAM_ASSET_CONSUME_FIELD_NOT_ALLOWED`（`team-asset.js:281-283`）⇒ `resolveTeamFlows().ok=false`
```

### R2-2 · `test/gate-techdebt-red.test.js:926`（**断言消息字符串**）
```
  '  会被资产校验拒（`TEAM_ASSET_CONSUME_FIELD_NOT_ALLOWED`）⇒ `resolveTeamFlows().ok=false`、`flows=null`',
```

### R2-3 · `test/gate-flows.test.js:335`（**断言消息字符串**）
```
      '【2026-09-27 批 3 · T-15/D-6 等值反转（面仍在：`resolveTeamFlows` 读端）】'
```

### R2-4 · `test/gate-hardening-red.test.js:107`（注释）
```
//   孤儿代码，一并删除（`resolveTeamFlows` 恒返 `ok:false` ⇒ 该前置在任何输入下都不可能通过）。
```

### R2-5 · `test/gate-hardening-red.test.js:300`（注释）
```
  //   已随 T-1（`lib/assembly/team-asset.js` 删除）/ T-6（`resolveTeamFlows` 恒返无声明）删净；
```

### R2-6 · `test/contract-missing-first-touch.test.js:360`（注释）
```
//   面已消失 = **团队资产声明面**（T-1 装载器删除 + T-6 读端删除）⇒ 该负控的**前置**（`resolveTeamFlows(...).ok === true`
```

### R2-7 · `test/gates-vocabulary-contract.test.js:276`（注释）
```
//   （T-6：`resolveTeamFlows` 读端删除 ⇒ 恒返「无声明」；T-1：`lib/assembly/team-asset.js` 本体删除，
```

### R2-8 · `test/plan-criteria-config.test.js:46`（注释）
```
//   `flows.plan.contract.required_sections`）：T-6（`resolveTeamFlows` 读端删除 ⇒ 恒返「无声明」）+ T-1
```

---

## 2. 事实口径（为何收敛）

`lib/assembly/team-asset.js` 本体与其「团队资产声明面」已退役（批 3），`resolveTeamFlows` 读端随之恒返「**无声明**」（`ok:false` / `flows:null`）。
⇒ 上述 8 处的原叙述**本身仍然成立**（不是错误），但属**同一事实的重复说明**、散落 6 个文件 ⇒ 维护时需多处同步。
⇒ 本台账把这些说明**集中一处**（§1 逐字归档），各站点保留**一行指针**，后续该面再变动时**只改本台账**。

## 3. 同族**未授权**站点（只登记，本轮不动）

| 站点 | 说明 |
|---|---|
| `test/gate-techdebt-red.test.js:386` | 同族说明 |
| `test/gate-flows.test.js:170` | 同族说明 |
| `test/gate-flows.test.js:397` | 同族说明 |
| `test/gate-hardening-red.test.js:29` | 同族说明 |
| `test/abort-dangling-and-warn-event.test.js:213` / `:216` | 同族说明 |

> ⚠ **`test/gate-flows.test.js:331` 是 `resolveTeamFlows(...)` 的**实际调用**（活断言被测点），**不是注释债** ⇒ **不动**。
