# hook-rules 规则预设集

本目录为 dsh-punky-swarm 随包发布的调用参数级护栏规则预设（preset）。预设以「wrapper（`_meta` 元数据 + `rules` 规则数组）」JSON 文件组织，规则正文与引擎 `Rule` 类型逐字段对齐、零扩展字段；装载器只剥离 `_meta` 取 `rules`，不做规则字段改写。

## 文件与内容

| 文件 | 注册 id | 层 | 规则数 | 内容 |
|---|---|---|---|---|
| `l1-sensitive.json` | `l1-sensitive` | L1 | 12 | 敏感数据防护：私钥块/凭据签名进入子代理透传面（subagent/subagent_fork/send_message/workflow/ralph）、外网搜索出口（web_search）与命令执行面（pwsh/ssh_exec/ssh_cluster）时的值级内容检测 |
| `l2-resource.json` | `l2-resource` | L2 | 6 | 资源边界：timeoutMs/maxWorkers/max_goal_rounds/maxRounds 数值上限，超限拒绝并回收窄指引 |
| `compose.json` | `compose` | compose | 18 | 全量合并（L1 12 条在前、L2 6 条在后），内容等价于分别引用 l1-sensitive 与 l2-resource |

动作档语义：

- **L1 私钥块**（L1-D01~D04、D09）：`hard` → **DENY** 拒绝执行。私钥字面量进入透传面/出网面无正当场景。
- **L1 凭据签名**（L1-A05~A08、A10~A12）：`manual_review` → **REQUIRE_APPROVAL** 人工复核。可能是正当透传（如向执行子代理交付部署凭证），也可能泄密；交互态走宿主人工闸，自动化无审批通道态 = fail-closed 拒绝。
- **L2 资源上限**（L2-R01~R06）：`narrowable` + `narrow[{path, max}]`。`flags.narrow: true` 时原语为 **NARROW**，否则回退 **DENY**——两种情况均拒绝执行并下发 `narrowedParams` 收窄指引（clamped 明细），模型按指引重试即为合规调用（deny-with-guidance）。

## 启用方式

预设为**可选启用**片段，出厂规则表保持空（零拦截）。两种启用写法：

1. **引用键（推荐，后续装载能力版本提供）**：`governance.hook.preset` 配置注册 id 或注册 id 数组——
   `"preset": "compose"`（18 条全量）或 `"preset": ["l1-sensitive", "l2-resource"]`（组合，展开结果与 compose 逐条等价）。
   `compose` 与分别引用 l1/l2 为互斥用法：同批引用会因规则 id 重复被装载层唯一性校验拒绝（规则 id 须全局唯一）。
2. **整表粘贴（装载能力落地前过渡）**：将目标文件的 `rules` 数组整体写入 `governance.hook.rules`。

启用 L2 时建议同时设 `flags: { narrow: true }` 使原语语义清晰；不开也成立（回退 DENY + 指引照给）。

## 分级上线建议

1. 先上 **L2**（资源上限：数值判定、无内容判断，交互/自动化均安全）；
2. 再上 **L1-A 组**（manual_review：交互态人工复核、自动化态拒绝，风险可见可控）；
3. 最后上 **L1-D 组**（hard DENY：严格护栏）。

每步用专用会话观察拒绝收据（reason/ruleRefs/attemptedParams/narrowedParams）再扩面。

## 上限调整指引

L2 数值上限为声明式规则值：调整即改对应规则的 `match.value`（超限判据，gt 严格大于，等值不命中）与 `narrow[].max`（钳制收敛目标，含等号）。两处须同步，否则出现「判定超限却钳制不到上限」的不一致。改后建议同步更新 `_meta.notes` 中对应说明。

## 多档同现语义

同一次调用命中多条**不同类别**规则时，裁决档位按引擎分类序：**hard > manual_review > narrowable**：

- 含 `hard` → DENY（hard 最优先）；
- 否则含 `manual_review` → REQUIRE_APPROVAL；
- 仅 `narrowable` → `flags.narrow` 开为 NARROW、关则回退 DENY（均带收窄指引）。

`narrowedParams` 仅在 NARROW 或 DENY 含 narrowable 时填充；**REQUIRE_APPROVAL 命中时即使同调用另有 narrowable 违规，也不下发钳制指引**——资源边界由人工闸裁决替代（人工放行 = 知情接受超限）。`flags.narrow` 只影响「纯 narrowable 裁决」档位；有 hard/manual_review 在场时档位优先，narrow 旗标不改变档位。

## 防误拦说明

- 全部规则**显式携带工具白名单**（见各文件 `_meta.tools`），无缺省=全工具的内容规则。白名单仅覆盖内容/资源面工具（共 10 个：subagent、subagent_fork、send_message、workflow、ralph、web_search、pwsh、ssh_exec、ssh_cluster、create_goal）。
- 治理/编排类工具（看板、批次/成员/信箱/日志/心跳等注册工具及只读查询工具）**不在任何规则的白名单内**（结构性排除）——其参数即使含相似文本也不命中。
- 每条规则锚定具体参数 path（如 `/prompt`、`/command`、`/timeoutMs`），不使用根 path。
- 正则无大小写旗标，规则正则自含大小写容忍（如 `[Pp]assword`）。

## 边界

- 覆盖范围 = 调用参数值级内容与资源数值上限；本地文件写读（write/edit/read）与路径面归宿主沙箱管理，本预设不设规则。
- 只拒绝不改写：宿主参数输入只读，命中即拒绝 + 收据 reason 给模型纠正文本，不做内容消毒替换。
- escalation（违规计数升级）出厂关闭；开启后 DENY/NARROW 在默认计入子集内，阈值/窗口由部署方自定。
