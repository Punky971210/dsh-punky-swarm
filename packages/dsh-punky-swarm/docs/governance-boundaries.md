# Governance 能力边界与复核结论

> 配套文档：本文为 README「工具调用级护栏（Governance Hook，M2）」章（README.md:256-361）的边界声明与复核结论落点；英文 1:1 镜像见 [governance-boundaries.en.md](governance-boundaries.en.md)。

## 导言：本文档性质与来源

- **性质**：纯边界声明与复核结论记录——代码行为零变更（文档化处置，无 lib/ test/ 改动）。
- **来源**：m2-harden 验收残留 #3/#5/#6/#9 的文档化落点。上游事实源：`sessions/m2-harden-20260831/artifacts/m2-harden-20260831/audit/harden-acceptance.md` §4 处置建议（下称 harden-acceptance §4:行号）；audit 处置口径 = 「文档化能力边界即可 / 记录 / 同源口径记录」。
- **处置映射**：#3 → §1（复核结论记录）；#5 → §2·#5（能力边界文档化）；#6 → §2·#6（能力边界文档化 + M5-d 留档）；#9 → §3（同源口径记录）。
- 每节统一含四要素：**来源残留 # / 裁定结论 / 证据位点（文件:行号）/ 维持现状 or 未来路径**。

## §1 DEFER 会话范围复核结论（残留 #3）

- **来源残留**：#3 —— DEFER 门取 session-wide（per-session 文件态），来源 p1 待核实④（harden-acceptance §4:153）。
- **裁定结论**：**契约 A.4 未限定工具/调用维度，per-session 文件态为合理实现，维持现状**。语义 = 同一 session 任一 soft 违规触发 DEFER 后，窗口期内该 session 的调用统一被拒（挂起态跨调用共享），与「窗口内重试被拒」的产品描述一致。
- **证据位点**：
  - `lib/governance/state-store.js:20` —— `<root>/governance/state/<sessionId>.json`（per-session 单文件，幂等读写）；
  - `lib/governance/state-store.js:71` `readSessionState`（按 sessionId 读状态文件）；`:35` `DEFER_RETRY_MS = 30_000`（窗口 30s）；`:62` 惰性过期（读时清理，无定时器）；
  - `README.md:282` —— 文件态简版状态机契约描述（状态文件路径 / 30s / 惰性过期自动恢复 / flag-off 无副作用）一致。
- **维持现状 or 未来路径**：**维持现状**。若产品语义要求「仅同调用重试被拒」（每次违规仅拒该次调用、同 session 后续重试放行）→ 需 **M5 完整状态机调整**（README ⑥:361 N-7「DEFER/PAUSE 完整状态机」范畴；文件态简版已落地 P1）；本批不动作，留档。

## §2 哈希链与 canonical 能力边界（残留 #5/#6）

### #5 链尾删除能力边界

- **来源残留**：#5 —— 链尾删除不可检测，来源 p2 待核实②（harden-acceptance §4:155）。
- **裁定结论**：**删中间/篡改可检测；删链尾不可检测——需外部 count 对照；WORM（N-11）覆盖，能力边界至此**。
  - 删中间/篡改：可检测 —— `verifyRefusals` brokenAt 定位（issue = `hash-mismatch` 自身篡改 / `link-break` 缺链/伪造重锚）；
  - 删链尾（链尾收据整体删除）：剩余链自洽、verify 仍 ok，**链校验不可检测**；检测需外部 count 对照 = `ledger-<sessionId>.jsonl` 行数 vs `refusals/<sessionId>/` 目录 json 文件数（缺一即异常）；
  - WORM（README ⑥:361 N-11，维持不做）→ 能力边界至此。
- **证据位点**：
  - `lib/governance/receipt-store.js:202` `verifyRefusals` → `{ok, brokenAt, count, receipts}`（:228 返回；:222 brokenAt 首个失败）；
  - `README.md:334-335` —— 哈希链锚定 + 验签返回结构与 issue 词汇；
  - `lib/governance/receipt-store.js:20` / `:41-44` —— `ledger-<sessionId>.jsonl` 台账路径；`README.md:333` —— 收据双落盘（json 原子写 + ledger 追加）。
- **维持现状 or 未来路径**：**维持现状（文档化边界）**。删链尾强检测依赖外部台账对照或 WORM 类不可变存储（N-11 留档），不在本批范围。

### #6 canonical RFC8785 简版边界

- **来源残留**：#6 —— canonical RFC8785 简版边界（-0 / U+2028 等数字规范化未做），来源 p2 待核实③（harden-acceptance §4:156）。
- **裁定结论**：**简版在当前收据域内确定，维持现状；含语义敏感数字场景 → 升级 full RFC8785 归 M5-d 留档**。
- **证据位点（简版已做面，`lib/governance/hash-utils.js:31-56` `canonicalize`，边界注释 :21-27）**：
  - 键排序：`Object.keys().sort()`（UTF-16 code unit 序；ASCII 键域与 RFC8785 一致）:24 / :50-51；
  - 无空白；数组元素 undefined → null :47；对象键 undefined 跳过 :50-51；NaN/±Infinity → null :42；
  - 数字走 JSON.stringify（V8 确定，-0 → "0"）:43 —— 依赖引擎确定性，无跨引擎指数格式规范化 :22。
- **简版未做面（能力边界）**：完整 RFC8785 数字规范化（跨引擎/版本指数格式无保证，:22）；逐字符转义表（U+2028/2029 等不转义，JSON.stringify 最小转义，:23）；语义敏感数字规范化（精度敏感值 / 大数）。
- **维持现状 or 未来路径**：**维持现状**（README.md:336 能力边界同口径：canonical = RFC8785 简版，完整版归 M5）。含语义敏感数字场景 → 升级 full RFC8785 归 **M5-d**（README ⑥:361 N-10「哈希锚定/签名证据信封——完整 RFC8785/真签名」；M5-d sha256 链简版已落地 P2，见 README.md:334）。

## §3 示例规则同源维护口径（残留 #9）

- **来源残留**：#9 —— 示例规则与测试同源维护，来源 p3 待核实⑦（harden-acceptance §4:159）。
- **裁定结论**：**双处同源、同步维护** —— README 示例 yaml 与测试内嵌规则常量必须同步修改（改一处漏一处即同源漂移）；语义一致性由测试断言覆盖（README 预期行为 ↔ T6/T7/T4 断言）。
- **证据位点（同源事实）**：
  - `README.md:289-327` —— ② 示例 yaml 3 条（规则 id：:302 `example-forbid-force-delete` / :310 `example-timeout-narrow` / :321 `example-admin-approval`）；预期行为 :329；
  - `test/governance-hotconfig.test.js:87` —— 注释明示「README ② 示例规则（governance-hotconfig 与 README 同源：T6/T7/T4 断言即 README 预期行为）」；常量 :88-93 `EX_RULE_FORBID_DELETE` / :94-100 `EX_RULE_TIMEOUT_NARROW` / :101-105 `EX_RULE_ADMIN_APPROVAL` —— id / tools / match / violations / narrow 与 README yaml 互映；
  - `README.en.md:289-327` —— 英文镜像同号示例（双语 1:1，随中文同步）。
- **变更流程（doc-update 口径）**：① 修改 README.md ② 示例 yaml（:289-327）→ ② 同步 test/governance-hotconfig.test.js `EX_RULE_*` 常量（:88-105）→ ③ 同步 README.en.md ② 示例（双语 1:1）→ ④ 跑 governance 组测试（`node --test test/governance-hotconfig.test.js`）确认预期行为断言仍绿。
- **维持现状 or 未来路径**：**维持现状（口径记录）**，无未来路径项。
