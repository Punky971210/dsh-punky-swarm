# Governance 能力边界声明

> 本文档为能力边界声明：记录调用级护栏若干机制的实际边界与维护口径，供外部透明核对与防回归。代码行为零变更（纯文档）。配套文档：[guardrails-hook.md](guardrails-hook.md)（护栏运行机制）、[governance-technical.md](governance-technical.md)（批级治理引擎）；英文 1:1 镜像见 [governance-boundaries.en.md](governance-boundaries.en.md)。

每节统一含四要素：**能力结论 / 证据位点（文件:行号 / 文档章节）/ 维持现状 / 未来路径（中性陈述，无代号）**。

## §1 DEFER 会话范围边界

- **能力结论**：DEFER 门取 session-wide（per-session 文件态）——同一 session 任一 soft 违规触发 DEFER 后，窗口期内该 session 的调用统一被拒（挂起态跨调用共享），与「窗口内重试被拒」的产品描述一致。契约未限定工具/调用维度，per-session 文件态为合理实现，**维持现状**。
- **证据位点**：
  - 机制描述：[guardrails-hook.md](guardrails-hook.md) §2「DEFER/PAUSE 文件态状态机」（状态文件路径 / 30s 窗口 / 惰性过期自动恢复 / flag-off 无副作用）；
  - `lib/governance/state-store.js:20` —— `<root>/governance/state/<sessionId>.json`（per-session 单文件，幂等读写）；`:71` `readSessionState`（按 sessionId 读状态文件）；`:35` `DEFER_RETRY_MS = 30_000`（窗口 30s）；`:62` 惰性过期（读时清理，无定时器）。
- **未来路径（中性）**：维持现状。若产品语义要求「仅同调用重试被拒」（每次违规仅拒该次调用、同 session 后续重试放行）→ 需完整状态机调整（含队列/外部存储语义），属「不提供项」，见 [guardrails-hook.md](guardrails-hook.md) §7；文件态简版已提供。

## §2 哈希链与 canonical 能力边界

### 2.1 链尾删除能力边界

- **能力结论**：删中间收据/篡改**可检测**（`verifyRefusals` brokenAt 定位，issue = `hash-mismatch` 自身篡改 / `link-break` 缺链/伪造重锚）；**删链尾不可检测**——剩余链自洽、verify 仍 ok；检测需外部对照 = `ledger-<sessionId>.jsonl` 行数 vs `refusals/<sessionId>/` 目录 json 文件数（缺一即异常）。能力边界至此。
- **证据位点**：
  - 机制描述：[guardrails-hook.md](guardrails-hook.md) §4「收据证据信封（哈希锚定 + 验签）」；
  - `lib/governance/receipt-store.js:202` `verifyRefusals` → `{ok, brokenAt, count, receipts}`（:228 返回；:222 brokenAt 首个失败）；`:20` / `:41-44` —— `ledger-<sessionId>.jsonl` 台账路径与收据双落盘（json 原子写 + ledger 追加）。
- **未来路径（中性）**：维持现状（文档化边界）。删链尾强检测依赖外部台账对照或不可变存储（write-once 类，见 [guardrails-hook.md](guardrails-hook.md) §7「不提供项」），不在当前提供范围。

### 2.2 canonical RFC8785 简版边界

- **能力结论**：canonical 为 RFC8785 **简版**——在当前收据域内确定，**维持现状**。未做面（能力边界）：完整 RFC8785 数字规范化（-0 / 跨引擎/版本指数格式无保证）、逐字符转义表（U+2028/2029 等不转义，JSON.stringify 最小转义）、语义敏感数字规范化（精度敏感值 / 大数）。
- **证据位点**：
  - 机制描述：[guardrails-hook.md](guardrails-hook.md) §4「canonical 边界」；
  - `lib/governance/hash-utils.js:31-56` `canonicalize`（边界注释 :21-27）：键排序 `Object.keys().sort()`（UTF-16 code unit 序；ASCII 键域与 RFC8785 一致）:24 / :50-51；无空白；数组元素 undefined → null :47；对象键 undefined 跳过 :50-51；NaN/±Infinity → null :42；数字走 JSON.stringify（V8 确定，-0 → "0"）:43。
- **未来路径（中性）**：维持现状（简版满足确定性证据信封需求）。含语义敏感数字场景 → 可评估升级完整 RFC8785（数字规范化/逐字符转义）与真签名，属「不提供项」，见 [guardrails-hook.md](guardrails-hook.md) §7。

## §3 示例规则同源维护口径

- **能力结论**：示例规则与测试内嵌常量**双处同源、同步维护**——改动 [guardrails-hook.md](guardrails-hook.md) §3 示例 yaml 必须同步 `test/governance-hotconfig.test.js` 内嵌规则常量（改一处漏一处即同源漂移）；语义一致性由测试断言覆盖（文档预期行为 ↔ T6/T7/T4 断言）。
- **证据位点（同源事实）**：
  - [guardrails-hook.md](guardrails-hook.md) §3 —— 示例 yaml 3 条（规则 id：`example-forbid-force-delete` / `example-timeout-narrow` / `example-admin-approval`）与预期行为；英文镜像 [guardrails-hook.en.md](guardrails-hook.en.md) §3（双语 1:1，随中文同步）；
  - `test/governance-hotconfig.test.js:87` —— 注释明示示例规则同源（T6/T7/T4 断言即文档预期行为）；常量 :88-105 `EX_RULE_FORBID_DELETE` / `EX_RULE_TIMEOUT_NARROW` / `EX_RULE_ADMIN_APPROVAL` —— id / tools / match / violations / narrow 与文档 yaml 互映。
- **变更流程（doc-update 口径）**：① 修改 [guardrails-hook.md](guardrails-hook.md) §3 示例 yaml → ② 同步 [guardrails-hook.en.md](guardrails-hook.en.md) §3（双语 1:1）→ ③ 同步 `test/governance-hotconfig.test.js` `EX_RULE_*` 常量（:88-105）→ ④ 跑 governance 组测试（`node --test test/governance-hotconfig.test.js`）确认预期行为断言仍绿。
- **未来路径**：维持现状（口径记录），无未来路径项。

## §4 护栏违规计数升级边界（护栏 → 批级 paused）

- **能力结论**：护栏违规计数升级**默认关**——`governance.hook.escalation.enabled` 出厂为 `false`；显式开启且归属批次的规则拒绝（DENY/NARROW）在窗口内达阈值后，才可能自动暂停批次（批级 paused 自动触发源相应为三，见 governance-technical.md §2）。默认关 = 出厂零行为变化，非缺失项。
- **证据位点**：触发链与配置键见 [guardrails-hook.md](guardrails-hook.md) §5「事件桥接」（escalation 触发条件）与 §3 配置；批级状态机与触发源见 [governance-technical.md](governance-technical.md) §2。
- **维持现状 / 未来路径**：维持现状（默认关为出厂语义）。
