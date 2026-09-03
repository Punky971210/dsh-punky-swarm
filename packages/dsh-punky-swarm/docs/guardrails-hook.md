# 调用级护栏（Governance Hook）技术手册

> 本文档描述工具调用级护栏：6 原语运行期语义、规则配置与示例、拒绝收据与验签、事件桥接、热更新与不提供项。批级治理引擎见 [governance-technical.md](governance-technical.md)；能力边界声明见 [governance-boundaries.md](governance-boundaries.md)。
> English: [guardrails-hook.en.md](guardrails-hook.en.md)

护栏订阅宿主工具生命周期事件 `tools/pre-execute` + `tools/post-execute` 双阶段（插件侧增量，零宿主改造），6 原语纯函数内核裁决（`lib/governance/`，同步、确定性、零 IO）。与批级任务难度门禁互补，不冲突：

| 层 | 机制 | 位点 | 语义 |
|---|---|---|---|
| 任务级（派发前） | `ctx.tools.guard`（任务难度门禁） | 评估/建批状态机 | 「该执行型调用是否允许发生」 |
| 调用级（执行时） | 本 hook pre-execute 内核 | `tools/pre-execute` 事件链 | 「该次调用的参数/工具是否越界」（规则表） |

执行序：pre-execute 事件链（内核）→ ask 解析 → 难度门禁（guardReason）→ dispatch；内核判 ALLOW → 难度门禁照常生效（两门禁串行叠加）；内核判 deny/ask → 难度门禁不再参与（不变量：难度门禁只可能「收紧」不可能被绕过）。

## 1. 双阶段接线

- **pre-execute**：状态前置检查（会话延后/暂停中 → 直接拒绝，见 §2 DEFER/PAUSE）→ 内核裁决 → ALLOW 则透传（`next()`）；非 ALLOW 同步落盘拒绝收据（失败仅 warn，观察者纪律，不阻断裁决）→ 返回 `{kind:'deny'|'ask'}`；
- **post-execute**：pass-through 观察者——恒 `next()`，不篡改结果；仅尽力补记 ask outcome（查表推断，写失败仅 warn）；
- **事件序**：pre → execute → post → result；本 hook 不调用 `ctx.emit` 篡改事件流；pre 拒绝短路径下 execute 不执行，post 观察者仍被调用（ask 降级 deny 路径同样补记）；
- **卸载**：`dispose()` 依次卸载 pre + post listener（幂等）。

## 2. 6 原语运行期语义

| 原语 | 落地形态 | 触发条件 |
|---|---|---|
| `ALLOW` | 透传不拦截（`next()`） | 规则未命中 / 命中零违规 |
| `DENY` | `{kind:'deny'}` 拒绝执行 | hard 违规；pausable/narrowable/soft 在对应 flag 关闭时回退 DENY |
| `REQUIRE_APPROVAL` | `{kind:'ask'}` → 宿主 approval 通道（serviceAsk） | manual_review / ftra / soft 置信达标（≥0.70） |
| `NARROW` | `{kind:'deny'}` + 参数收窄指引 + 收据 `narrowedParams` | flag.narrow=true 且 narrowable |
| `DEFER` | `{kind:'deny'}` + 会话延后挂起（状态文件 + 收据 `deferMeta`） | flag.defer=true 且 soft |
| `PAUSE` | `{kind:'deny'}` + 会话暂停（状态文件 + 收据 `pauseMeta`） | flag.pause=true 且 pausable |

判定顺序（category 优先级，先命中先生效）：

1. `ftra` → REQUIRE_APPROVAL（边界人工介入）；
2. `manual_review` 且无 hard → REQUIRE_APPROVAL（需人工复核）；
3. `hard` → DENY（硬性违规）；
4. `pausable` → flag.pause ? PAUSE : DENY；
5. `narrowable` → flag.narrow ? NARROW : DENY（NARROW 含 narrowedParams 钳制指引；flag-off 回退 DENY 亦填充指引）；
6. `soft` 置信 < 0.70 → flag.defer ? DEFER : DENY；
7. `soft` 置信 ≥ 0.70 → REQUIRE_APPROVAL；
8. 未分类违规 → 兜底原语（defaults.deny，缺省 DENY；绝不 ALLOW——fail-closed）。

- **统一拒绝消息格式**：`[governance:<primitive>] <reason>`（primitive ∈ ALLOW/DENY/REQUIRE_APPROVAL/DEFER/NARROW/PAUSE；对齐难度门禁 `[task-difficulty-gate]` 前缀风格）——模型侧可区分「任务级未评估」vs「调用级越界」。DENY/DEFER/NARROW/PAUSE 统一以 `{kind:'deny'}` 落地；REQUIRE_APPROVAL → `{kind:'ask'}`。
- **REQUIRE_APPROVAL ask 行为（显式化）**：pre 同步落盘 `ask: {channel:'host-serviceAsk', initiated, requestId(=callId)}`；post 尽力补记 `outcome`（denied-no-approval / denied-no-agent / denied-rejected / denied-cancelled / unavailable / allowed-once）。**依赖宿主 approval 通道（serviceAsk），无审批服务 / 无 agent = 降级 deny**（行为不变，记录显式化）；allowed-once → allow。
- **DEFER/PAUSE 文件态状态机（flag 开启后真实生效）**：`flags.defer: true`（soft 违规）→ 会话挂起延后（状态文件 `<root>/governance/state/<sessionId>.json`，窗口 30s，收据含 `deferMeta`）；`flags.pause: true`（pausable 违规）→ 会话暂停（窗口 60s，收据含 `pauseMeta`）。挂起/暂停期间同会话调用统一 `[governance:DEFER|PAUSE]` deny（reason 含 retry-after / pauseToken / until），**惰性过期自动恢复**（读时清理，无定时器 / 无 resume 端点）；flag-off 折叠 DENY 无状态副作用（与「会话延后/暂停中」可区分）。

## 3. 配置指南与示例规则

- **配置**：`cordis.patch.yml` 顶层键 `governance.hook`——`enabled: true`（**默认开**；显式 `enabled: false` 可关）/ `rules: []` / `defaults.deny: DENY`（fail-closed 兜底，可配其他拒绝类原语，不可为 ALLOW）/ `flags: {pause:false, narrow:false, defer:false}`（原语开关默认关 → 对应类回退 DENY）。
- **Rule 结构**：`id` / `tools?` / `match{path?,op?,pattern?,value?}` / `violations[{code,category,severity?,message,path?}]` / `narrow?`。

`match.op` 支持：`eq`（递归深度相等）/ `gt` / `gte` / `lt` / `lte` / `in` / `regex`；`match.path` 为 JSON Pointer（缺省 = 匹配整个 arguments；path 不存在 → 不命中）。`category` 取值：hard / manual_review / ftra / narrowable / pausable / soft / unknown。

- ⚠️ **出厂默认 `rules: []` = 零拦截**（decide 恒 ALLOW，行为不变）——勿误以为护栏在生效；以下示例复制到 `governance.hook`（替换 `rules` 与 `flags` 段）即真实生效，亦可写入 `<root>/config/runtime.json` 热更新覆盖（见 §6）。

```yaml
# 复制到 cordis.patch.yml 的 governance.hook 段（替换既有 rules: [] 与 flags 即可生效）
# 预期行为：示例 1 命中 → DENY；示例 2 命中 → NARROW（收窄指引 + narrowedParams 落收据）；
#            示例 3 命中 → REQUIRE_APPROVAL ask（依赖宿主 approval 通道，无通道则降级 deny）
governance:
  hook:
    enabled: true
    flags:
      pause: false
      narrow: true      # 示例 2 需开启 narrow 原语（默认 false——不开则示例 2 回退 DENY + 收窄指引）
      defer: false
    rules:
      # 示例 1：禁止强制删除（hard → DENY）——tools 按宿主实际工具名（bash/pwsh/…）
      - id: example-forbid-force-delete
        tools: [bash, pwsh]
        match: { path: /cmd, op: regex, pattern: 'rm -rf|Remove-Item -Recurse|del /f /s /q' }
        violations:
          - code: EX1
            category: hard
            message: 强制删除命令被护栏禁止（rm -rf / Remove-Item -Recurse / del /f /s /q）
      # 示例 2：超时参数收窄（narrowable + narrow bounds → flag.narrow=true 时 NARROW）
      - id: example-timeout-narrow
        tools: [bash]
        match: { path: /timeout, op: gt, value: 3600 }
        violations:
          - code: EX2
            category: narrowable
            message: 超时参数超过 3600s，需收窄
        narrow:
          - path: /timeout
            max: 3600
      # 示例 3（可选）：审批门（manual_review → REQUIRE_APPROVAL）
      - id: example-admin-approval
        match: { path: /scope, op: eq, value: admin }
        violations:
          - code: EX3
            category: manual_review
            message: 高危管理操作需人工复核
```

预期行为（喂内核裁决）：示例 1（`bash` + `cmd: "rm -rf /data"`）→ `DENY`（ruleRefs `['example-forbid-force-delete']`）；示例 2（`bash` + `timeout: 7200`）在 `flags.narrow: true` → `NARROW` + `narrowedParams`（`/timeout` 7200 → 3600 钳制明细），flag-off 则回退 `DENY`；示例 3（任意工具 + `scope: "admin"`）→ `REQUIRE_APPROVAL`。

> 同源维护：本示例规则与测试内嵌常量同源同步（`test/governance-hotconfig.test.js` `EX_RULE_*`），维护口径见 [governance-boundaries.md](governance-boundaries.md) §3。

## 4. 收据证据信封（哈希锚定 + 验签）

- **拒绝收据**：`<root>/governance/refusals/<sessionId>/<receiptId>.json`（原子写 tmp+rename，写后读校验 fail closed）+ `ledger-<sessionId>.jsonl`（追加）。**基础八键**：receiptId / ts / tool / callId / sessionId / decision（primitive+priority+reason）/ attemptedParams / ruleRefs；**可选扩展**（向后兼容，旧收据无字段不炸）：`narrowedParams`（NARROW / DENY-含窄域的钳制指引）、`deferMeta` / `pauseMeta`（DEFER/PAUSE 元信息）、`ask`（REQUIRE_APPROVAL 记录）、`anchor`（哈希锚定）。
- **哈希锚定**：同 session 收据按 ts 序串 sha256 哈希链——`anchor: {version: 1, alg: 'sha256', prevHash, hash}`；hash 覆盖收据除 anchor 自身外全部字段（含 prevHash），篡改任一收据即破坏其后整条链。链序 = 严格 ts 序（同 ms 碰撞 nudge +1ms 保证确定性；receiptId 破平仅兜底）。
- **验签**：`lib/governance/receipt-store.js` `verifyRefusals(root, sessionId)` → `{ok, brokenAt, count, receipts}`——逐条 `{receiptId, ts, anchored, ok, issue?}`，issue = `hash-mismatch`（自身内容被篡改）/ `link-break`（prevHash 与链上前一不符 = 缺链/伪造重锚）；旧收据（无 anchor）不参与链校验、不判失败（兼容）。审计可复跑：改 1 字节 → verify 失败且 brokenAt 定位。
- **ask outcome 补记与级联重锚**：post 补记 = 收据体事后改写（原子 tmp+rename）；若收据已锚定，重算本收据 hash（prevHash 不变）→ hash 变化时链上所有后继级联重算（json 原子改写 + ledger 演化快照追加）。链尾补记（常见）仅本收据重锚。旧收据维持纯补记。
- **canonical 边界**：canonical 为 RFC8785 简版（键排序 + 无空白 + undefined/NaN 对齐 JSON.stringify，`lib/governance/hash-utils.js`）。**能力边界**：完整 RFC8785 数字规范化（-0 / 指数格式跨引擎保证）、逐字符转义表（U+2028/2029 等）与真签名不在当前提供范围（见 §7）。

## 5. 事件桥接（收据 → 事件流）

收据落盘 → 装配层 `onRefusal` 回调 → 批级事件流 `<root>/governance/events/refusal-<sessionId>.jsonl`（每行 `{type:'governance.refusal.recorded', ts, sessionId, receiptId, primitive, tool, callId}`），与 refusals 收据/ledger 并行可观测——分层治理「收据层 → 事件流」协同。桥接默认仅事件可见性，**不触发批级状态迁移**；当 `governance.hook.escalation.enabled: true` 且收据归属到批次（经 member.dispatch 会话映射）时，规则拒绝（DENY/NARROW）按批滚动窗口计数，达阈值经棘轮校验可触发批级 paused（事件 reason='governance-escalate'，见 governance-technical §2）。**DEFER/PAUSE 会话短窗态不直映批级 paused**（短窗惰性自动恢复 vs 批级持久挂起，语义错配禁区）；状态门收据（ruleRefs 为空）不计入。批级 paused 自动触发源共二：连续成员失败 `failed-escalate`（既有）与护栏违规计数 `governance-escalate`。回调抛错隔离 warn 不阻断裁决；`dispose` 后断开（幂等）；热更新重挂后桥接随动重新注入（见 §6）。

## 6. 热更新（免重启）

- governance 键已纳入 runtime.json 顶层白名单（`lib/hot/config-watch.js` `ALLOWED_TOP_KEYS`）——`governance.hook` 任一**生效子键变化**（enabled 翻转 / rules / flags / defaults）经装配侧 dispose + 重挂**即时生效，免重启**（kernel 闭包持有旧配置 → 统一重挂，不引入 updateConfig API）。重挂后运行时状态重置（refusals count 归零；跨重挂在途 ask 的 outcome 补记丢失——收据 `ask.initiated` 已在 pre 落盘不丢审计）；DEFER/PAUSE 会话状态为文件态（state-store），不随重挂丢失。
- **覆盖示例**（写入 `<root>/config/runtime.json`，原子写 tmp+rename；深度合并叠加，静态配置零改动）：

```json
{ "governance": { "hook": { "enabled": false } } }
```

  写 `enabled: false` → 热切卸载（pre 不再触发，调用不再被拦）；写回 `true` 或删除该键（恢复默认 true）→ 重挂生效。rules 覆盖示例（数组整体替换，其余子键保留静态值）：

```json
{ "governance": { "hook": { "rules": [ { "id": "runtime-deny-shutdown", "tools": ["bash"], "match": { "path": "/cmd", "op": "regex", "pattern": "shutdown" }, "violations": [ { "code": "RT1", "category": "hard", "message": "禁止 shutdown 命令" } ] } ] } } }
```

  预期：写入后重挂 → 新规则立即拦截 `shutdown` 调用（DENY + 收据落盘），无需重启进程。

## 7. 边界与不提供项

当前护栏提供进程内、单机、规则表驱动的调用级治理；以下**当前不提供**（均为明确的范围边界陈述，非缺失项）：

- 进程外网关 / MCP 网关路径；
- 云集成 / K8s 部署形态；
- 重型第三方依赖（NeMo / Presidio / spaCy 类）；
- 模型侧 LLM 拦截（本护栏作用于宿主工具调用层）；
- 路由封条（seal）；
- DEFER/PAUSE **完整**状态机（指队列/外部存储语义；文件态简版已提供，见 §2；维持无 setInterval / 无 resume 端点）；
- NARROW 透明参数改写（宿主禁止输入改写，以 deny + 指引落地）；
- 流式事件推送（tools/result + SSE 类）；
- 完整 RFC8785（数字规范化 / 逐字符转义）与真签名证据信封（sha256 链简版已提供，见 §4）；
- 不可变存储（write-once 类）。
