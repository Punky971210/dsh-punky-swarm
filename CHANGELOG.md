
# Changelog

按版本倒序记录变更。变更日志允许描述技术细节（模块、字段、事件、拒码、脚本）；内部批次编号、裁决过程与验证读数不入本文件。

## 0.6.0（2026-11-14）

### checkpoint 改为逐项留痕（破坏性变更）

- **checkpoint 逐项留痕**：使用 `subtasks` 的批次需按 subtask 逐个调用 `lane_checkpoint`；结算门只认显式 `subtaskId` 覆盖，不再接受「单次报到末项」代表全量。
- **`total.mismatch` 覆盖两种方言**：`checkpoints` 与 `subtasks` 两种声明均校验 total。
- **新增事件 `lane.checkpoint.subtask-hint`**：每次 checkpoint 落 `covered` / `remaining`（按声明序）。
- **`handoff_view` 输出 `subtaskOutputs`**：逐项 `outputs` 与在场情况（只读展示）。
- **任务包 `## checkpoint 计划（强制）` 段与门判据对齐**。
- **MCP 连接级失败退避重试**：`postJsonOf` 对偶发连接失败重试 2 次并落 warning。
- **安装面**：`dsh.engines.dsh` 声明 `>=0.2.1-rc.2`；`@deepseek-ai/cordis` peer 放宽为 `>=4.0.1` 并标 optional；仓库根可直接以 git 地址安装（无需子目录参数）。

## 0.5.6（2026-10-25）

### 写域判据改目录约定分类器；断言遮蔽拆牙；基线新鲜度门；CI 双矩阵转绿

- **`PACK_DOMAINS` 由批次清单改目录约定分类器**：`FACE_RULES` 六面 + `RELEASE_RE` + `classifyFace`，按前缀长度显式降序匹配；`git status` 采样改 `-uall`（未跟踪文件亦纳入）。
- **断言遮蔽拆牙**：`pack3-15` 的集合相等断言旁拆出独立 `pack3-15b`（`doc-manager` 指针必须为 0），两断言各自可红。
- **基线新鲜度门**：`test/test-baseline.test.js` 新增 `freshnessDrift` / `baselineTotalsDrift` 与三条用例，负例走内存副本。
- **CI 修复**：恢复 `.gitignore` 明文要求保留的 `docs/integrations/comfyui-glue{,.en}.md`；5 条依赖开发机的用例改缺位留痕（不计通过、不判红）；`actions/checkout` 改 `fetch-depth: 0`；测试临时根由硬编码盘符改 `os.tmpdir()`。

## 0.5.5（2026-10-25）

### software-team 接上「角色 → 适配层 → vendor 原件」引用链

- **6 个 role 各增 1 行 vendor 指针**：`coder` / `coordinator` / `designer` / `reviewer` / `supervisor` / `tester`；`doc-manager` 不挂。
- **适配层优先序落硬声明**：`spec-contract.md` 六态表之前声明「本表为映射摘要，不一致一律以 vendor 原件为准」。
- **机检**：`AC-pack3-14`（声明行位置在六态表之前）、`AC-pack3-15`（含 vendor 指针的 role 集合精确相等为 6、`doc-manager` 为 0、每条指针路径 `existsSync` 为真）。

## 0.5.4（2026-10-24）

### vendor 引入 SpecLang 四技能原文；新增 node 薄壳；适配层降级

- **vendor 落点**：新增 `skills/software-team/references/vendor/speclang/`，共 29 件（27 件上游资产 + `LICENSE` 副本 + `NOTICE.md`），逐件 sha256 与上游全等。
- **node 薄壳**：新增 `scripts/speclang-validate.mjs`——`ruby` 可用则原样透传退出码与 argv；不可用 `exit 2` + 明写 UNKNOWN；原件缺失 `exit 2` + 缺失绝对路径；`-h/--help` 为 `exit 0`。
- **适配层降级**：`references/engineering/spec-contract.md` 改为蟛蜞适配层（六态 → `gate_status` / `verdict` 映射、`SUMMARY:` 落地、S-10 缺口留档），`S-6` / `S-7` / `S-8` / `S-10` 编号保留。

## 0.5.3（2026-10-24）

### 纪律补三节；注入面新增判据②b；受控词表由空表转真拦截

- **纪律正文补三节**：`references/discipline.md` 新增 `## §0i` 执行形态 / `## §0s` 编号规范 / `## §0t` 完成发现；`§0k` 增 `SUMMARY:` 机读结论行与四档证据强度（`PROVED` / `SEMI_PROVED` / `VIOLATED` / `UNKNOWN`）。
- **判据②b 上岗（行为变更）**：注入面每条目须在正文有对应 `## §X`，零白名单、零豁免；同时删除自足条目放宽面。新增 `test/guidance-id-coverage.test.js`。
- **受控词表转真拦截**：`lib/state/vocabulary.json` 由 `entries: []` 填为 51 条真值（`kind=gate`）；新增 `scripts/check-vocab-counts.mjs`；`test/vocabulary.test.js` 的 A3 改为「必须非空 + 唯一 + `kind=gate`」。

## 0.5.2（2026-10-21）

### 结构优化：`apply` 873 → 51 行 + 八项单点化收敛

- **入口瘦身**：`apply` 873 → 51 行，顶层工厂 0 → 30，运行期真源收拢为 `createRuntimeState`（20 字段）。
- **单点化**：`sendJson` / `packageRoot` / `stripStreamMerges` 三处重复实现合一；产物路径函数收敛到 `lib/state/batch-paths.js`；命令分段器收敛到 `lib/shell-text.js#segmentCommands`（生产代码正则字面量只剩 1 处）。
- **架构真源与越界门**：新增 `.punky/arch.yml` 与 `scripts/arch-check.mjs` 棘轮门（禁止新增跨域依赖），`arch-context` 在派发期注入架构上下文。
- **安全面收口到 fail-closed 单点**：产物声明路径解析、产物读面 5 点、人工闸 `human:` 证据判定、handoff 在场与可读。
- **测试债补齐**：测试文件 166 → 171，新增 5 件安全面用例，每条「返回空 / 被拒 / 不抛」断言配同输入阳性对照。
- **写序列可观测化**：`createRuntimeState(onWrite)` 在注入 `ctx.rtWriteLog` 时记录字段写入序列，未注入时返回纯对象（生产路径零开销）。
- **指引层去重**：persona 注入面 6442 → 5858 字符；`cordis.patch.yml` 与 `presets/punky-preset/agent.cordis.yml` 两份定义对齐为 27 条、逐条差异 0；模板变量白名单约束（本内核只注册 `provider` / `model`）。

## 0.5.1（2026-10-14）

### 发布面落版与判据尺子固化

- **版本史落版**：原「未发布」段体落为 `## 0.5.0（2026-10-12）`，版本行置 `0.5.1`。
- **注释订正**：`lib/sig-fingerprint.js` 改指 `lib/types/contracts.ts` 的 union 为唯一真源，不再写死拒码数量。
- **判据尺子固化**：新增 `scripts/audit/tool-face-count.mjs`（按块解析 + 四口径阶梯 + 三态退出码），修正原命令只覆盖双引号导致的 26 ≠ 32。
- **锚点类文档入库**：`docs/` 54 件逐件 `git add -f`（禁通配）。
- **新增技能**：`skills/video-team/`（三层 7 角色 + 宪法 6 章 + 模板 6 件 + 密度机检）。

## 0.5.0（2026-10-12）

### 累积收口（2026-09-12 → 2026-10-12）

- **抄规格体系 P0/P1/P2 三波次**：L1 事件重放校验腿、L2 上下文注入预算、L3 测试证据自证、L5 隔离可判定、L6 宿主兼容第三维、L7 写路径原子性、L4 规则变更传播、L8 判据脚本信任模型、L9 记忆溯源、C-5 坏配置 fail-closed；新增拒码 `GATE_SCRIPT_CHANGED`，新建 `lib/comms/inject-budget.js` 与 `lib/state/rule-propagation.ts`。
- **指引同步改造**：规格口径落 `references/discipline.md`（判据类入 `### 15.16`–`### 15.20`），移除注入面 `0i` 行。
- **D 档偏离语义双轴修复**：难度轴 `derived`（五布尔 + `fixedRole` + `durableSeats`）与通道轴 `derivedChannel`（`durableSeats ? 'team' : 'dispatch'`）独立推导，`D` 不入难度轴。
- **难度门禁 v3**：取消默认档，增只读侦察面；`execToolCount` 降为纯观察面，不再作为升档与过期依据。
- **G1「档位 × 工具面」与 G2「建批即拉起」硬门禁**：成员面动作只认 C 档；三层批建批即拉起编排角色。
- **团队资产必填化**：`team` 必填、构造期拒绝、废弃 `generic`；`DEFAULT_ASSEMBLY` 仅保留兼容导出。
- **禁止成员嵌套派发**：`subagent` / `subagent_fork` 入成员 deny 列表。
- **派发套件活体修复**：`inject` 漏声明 `subagents`、`startContinuable` 的 `signal` 契约；任务包补齐 `cmd` 携带。
- **`jiufeng` → `punky-preset` 改名**：preset id / 目录、引擎数据根缺省、装配命名空间三处同改；旧根保留为历史归档，不迁移、不桥接。
- **legacy 完全清退**：缺声明的回落通道删除，不兼容旧批次。
- **`idle` 语义纠正**：回到字面意义的空闲态，仅经恢复 / 回收单点进入。
- **单选遗产清除**：`preset` 一律多选 / 数组；`compose` 组合项删除，注册项 4 → 3；治理配置面板同步。
- **cage 护栏第三类「工具黑名单」**：写通道路由，规则可热加载。
- **团队装配扩充**：新增 `design-team` / `research-team` / `writing-team`；`jiufeng` 团队装配退役，装配数据唯一来源改为团队资产 `presets/<team>/team-asset.{json,yml}`。
- **交接语义归并**：M0′ 三小项 + M1 删除步级条件边 `on`；`chain` 事件驱动自动推进接线。
- **审计日志**：默认开、可显式关闭、带轮转与体积上限、零远程上报。
- **清理与结项**：`pkg-hashes.txt` 重算与交付副本核对、冗余声明退役与死码清理、集群监控面板按引擎现状重构。

### 团队更名登记：jiufeng-team → software-team

- 更名：原名 `jiufeng-team` → 新名 `software-team`；日期 **2026-09-12**。
- 影响面：技能目录 `packages/dsh-punky-swarm/skills/jiufeng-team/` → `skills/software-team/`（18 文件，文件集合与 8 角色文件名不变）；技能同步任务 `lib/assets.js:85` 与关联测试 `test/assets.test.js` 同步改名；`SKILL.md` frontmatter `name:`、自引用与 `cmd` 示例改名，description 定位由「蟛蜞模式指引层」改为「软件工程团队」；`package.json` description、包内 `docs/single-machine-capabilities.md`/`.en.md` 同步改名；部署副本目标路径随之变为 `~/.agents/skills/software-team`（管理式同步单向复制）。
- 不改动面：`presets/jiufeng/`（preset id/目录名）、装配命名空间键 `jiufeng`（`DEFAULT_ASSEMBLY.team`、`aip.team`）、引擎数据根 `~/.dsh/jiufeng`、`VALID_ROLES`/`REQUIRED_ROLES` 值。
- 历史行不改：本文件既有 `jiufeng-team` 记载（历史事实行）原样保留。

## 0.4.4（2026-09-08）

### 批次事件结局分型（恢复与回收记账）

- 恢复路径记 crashed：进程崩溃重启后，恢复流程将崩溃前处于运行/评审中的 lane 置回待派发（idle），恢复事件为该类 lane 逐一记结局 crashed，并保留原态与既有审计字段——重派前可经事件流查询哪些 lane 系因崩溃中断。
- 回收处置记 interrupted：running lane 具备停滞证据、被显式回收脱离在飞态（置回 idle 待重派）时，回收事件记结局 interrupted。
- 默认开启、只记不改：结局记账自动生效，不构成新的成员状态、不改变既有成员迁移/拦截/结算语义，也不介入重派决策（重派仍走既有待派发→运行通道）；未带结局的旧事件与旧批次读取零迁移兼容。

### 评审与验收结论结构化必填

- 评审（review）与验收（acceptance）产出的结论必须结构化携带三要素并置于报告头部：① 结论 approve / reject（显式二选一）；② 阻断项清单（reject 时必列，验收侧与既有对账衔接）；③ 跟进项清单（后续动作与遗留观察，可为空）。
- 空结论即评审未完成：缺失 approve / reject 结论、或以一句笼统表态（如「总体没问题」「建议合并」「验收通过」）替代三要素的，视为评审未完成，可打回补全（沿用既有驳回语义）。

### 批次级装配声明与规模批门禁

- wave_plan 建批新增可选顶层参数 assembly（批次级装配声明）：managerPlan（编排牵头形态：raise=拉起编排 Manager 代管调度 / leader-direct=任务负责人直管派发）与 auditLane（验收归属 lane）必填，coordinatorLane / roles 可选。
- 规模批强制：三层批且 exec 层任务（lane）数达 3 个及以上时装配声明必填——声明缺失、结构非法、或所引 lane 不存在/层错配将拒绝建批（无批次落盘，补齐声明后重试）；roles 词条格式异常仅告警、不阻断。
- 声明随批次持久化与回显：归一化声明写入批次数据顶层（可选字段、schema 不升；未声明不写键，既有批次零迁移），建批返回值附装配声明视图。

### 模式装配与纪律条文更新

- 难度路由扩档：模式预设难度路由在 A/B/C 之上新增规模批档 C+（三层批且 exec 层任务达 3 个及以上，与引擎装配门禁同一判定口径）；此类批次进入运行后须先拉起编排 Manager（首个 exec 任务派发前完成），任务负责人的兜底代行与豁免留痕仅限普通批次，边界条文同步更新。
- 装配履职条文：按需装配的细拆/架构复核角色须先经代码图谱建立与复核代码索引（细拆与架构复核依据可追溯）；评审/验收结构化结论条文见前节。
- 新增纪律条文：消费方契约摸底先行（实现消费宿主接口、外部 DSL 与框架扩展点前，先落契约摸底产物并作为实现前置契约）与宿主级自验证（产出完成判据须含真实宿主加载/启动冒烟，语法与局部级检查不作完成判据）。

### 发布整理

- 版本 0.4.3 → 0.4.4；变更记录整理与发布前内部口径清查。

## 0.4.3（2026-09-07）

### 调用级护栏拒绝可见性

- 护栏拦截明示：工具调用送入人工审批后被拒绝（含审批服务不可达、无可用 agent 等降级情形）时，Agent 收到的拒绝不再只是「用户拒绝了该工具」的泛化提示，而会携带护栏标注、命中规则、违规说明与查阅路径——Agent 与用户均可识别该拒绝源于护栏对疑似敏感数据调用的拦截，并可按违规说明修正参数后重发合规调用；非拦截场景行为保持不变。
- 拒绝文本携带命中规则：拒绝原因末尾追加命中规则及其预设归属（如 L1-A10 · preset l1-sensitive），人工审批请求与直接拒绝路径均携带，用户在批准/拒绝前即可核对所触发的具体规则。
- 行为说明同步：拒绝可见性语义（拦截明示与规则引用，含边界说明）随双语主题文档 guardrails-hook 同步更新。

### 护栏预设逐条审阅清单

- presets/hook-rules/README.md 新增逐条规则审阅清单：敏感数据防护 12 条与资源边界 6 条，按规则编号 / 预设归属 / 类别 / 生效原语 / 触发工具 / 匹配摘要 / 违规说明逐条成表，供用户与 Agent 主动审阅护栏规则全集；配套一致性断言守护清单与规则文件同步。

### 发布整理

- 版本 0.4.2 → 0.4.3；变更记录整理与发布前内部口径清查。

## 0.4.2（2026-09-06）

### 治理配置面板：Lane 过期检测与重派探针

- 治理配置页新增 **Lane 过期检测** 与 **长跑超时重派探针** 两级开关：前者控制 running lane 的心跳过期扫描，后者控制长时间无 checkpoint / 活动进展 lane 的重派候选探测。开关随护栏共用同一保存通道写入运行配置，保存即热更生效，进程重启后按 runtime.json 自动对账，无需重复设置；出厂默认开（缺省即开、显式关闭才停），关闭仅停止扫描与候选探测，不改动已落盘批次 / 成员状态，重新开启后自基线恢复扫描。
- 长跑时间窗口面板化：**超时窗口**（默认 20 分钟）与**无进展窗口**（默认 5 分钟）可在表单以分钟输入，保存时自动换算毫秒生效，无需手工编辑配置文件。
- 「违规自动升级」说明文案优化：直接说明触发次数 / 窗口阈值的判定与升级暂停行为，去除括号提示与实现细节，降低配置理解成本。
- 配套新增回归测试：覆盖开关保存热更、进程重启对账与长跑无进展候选场景。

### 无 Manager 批次的长跑候选消费

- 未拉起编排 Manager 的批次运行期间，由任务负责人（Leader）兜底承担长跑候选消费：读取候选广播、核对 lane 探针状态与 checkpoint / 活动进展，按半自动规则裁决继续观察或重新派发；已拉起 Manager 的批次仍由 Manager 完成调度。

### 注释与文档口径统一

- 「出厂默认开、显式关闭才停」口径统一：Lane 过期检测与长跑探针的默认开启说明跨代码注释、预设说明与双语文档对齐（纯注释与文档改动，零逻辑变更）。

### 发布整理

- 版本 0.4.1 → 0.4.2；变更记录整理。

## 0.4.1（2026-09-05）

### 治理预设规则包

- 出厂护栏规则预设随包发布（presets/hook-rules）：l1-sensitive（L1 敏感数据防护 12 条）、l2-resource（L2 资源上限 6 条）、compose（L1+L2 全量 18 条），wrapper 结构（`_meta` 元数据 + `rules` 数组），规则字段与引擎 Rule 类型逐字段对齐、零扩展字段。
- preset 装载与引用：装载器剥离 `_meta` 取 rules 并做受控资产早失败校验；`governance.hook.preset` 支持注册 id / id 数组引用（如 `"preset": "compose"` 或 `["l1-sensitive","l2-resource"]`），跨 preset 规则 id 全局唯一性校验拒绝重复。

### Web UI 治理配置页 + runtime.json 写通道

- 治理配置设置页（Web UI 设置区）：护栏开关、规则预设、违规自动升级（触发次数 / 窗口）可视化配置；页面保存即时生效、无需重启。
- runtime.json 热写通道：保存请求经 config-trust 校验（顶层白名单 / 值域 / preset 与内联规则冲突守卫）后落盘 runtime.json，400 校验拒绝不落盘；窗口秒输入后端毫秒归一化（windowSeconds → windowMs，线协议键不落盘）。
- 随包双语主题文档：docs/webui-governance-config(.en).md。

### lane_longrun 超时无进展探针

- watch 长跑档（默认开启）：running lane 运行超时且长期无 checkpoint / 活动进展 → 产候选并广播给 Manager（探针只产候选，不改成员状态），重派裁决归 Manager / Leader。
- 与心跳 stalled 档并列扫描；事件留痕可审计。

### Web UI 修复

- 治理配置页 UI 修复：重命名、preset 多选、放大字号、移除全组合提示。

### 发布整理

- 版本 0.4.0 → 0.4.1；根 README（GitHub 面）精简：170 → ≈100 行，中文 / 英文 1:1 同构重写，去除过期版本与测试数（实测刷新 816）；删除 README.market.md（人话版内容并入精简后根 README 机制表与能力段）。

## 0.4.0（2026-09-03）

### 工具调用级治理护栏

- 引导层挂载 + 运行时接线：治理钩子随引导装配挂载（bootoverlay），运行期 wiring 接线，工具调用进入统一裁决链。
- 6 原语裁决内核：classify / config / decisions / escalate / narrow / proto 域分层裁决，处置原语含 ALLOW / DENY / REQUIRE_APPROVAL / DEFER / NARROW / PAUSE。
- 拒绝收据锚定 + 哈希链防篡改：违规判定与处置落盘拒绝收据（receipt-store），锚定 prevHash 级联哈希（hash-utils），链式校验可审计、篡改即断链。
- DEFER / PAUSE 状态机：延后/暂停以文件态会话状态落盘（state-store），命中写状态并回填收据元信息（deferMeta / pauseMeta）。
- REQUIRE_APPROVAL 审批通道：软违规置信达标或边界命中转人工审批（ask 通道），审批结果回填收据并级联重锚。

### 护栏规则热更新

- 治理配置变更实时生效（config-watch），无需重启；规则与阈值热加载，配置窗口极小。

### 双层状态联动（违规升级 → 批次暂停）

- 滚动窗口违规计数升级：窗口内拒绝计数达阈值自动升级并暂停批次（governance refusal 事件 + 窗口摘要）。
- dispatch 归属登记：工具调用按发起方登记，违规处置可回溯（receiptId / callId / sessionId）。

### 产品化双语文档分层

- 文档分层：产品化双语发布文档与内部技术开发文档分流（包级 README / README.en 产品化）。
- 随包分发双语主题文档：governance-boundaries / governance-technical / guardrails-hook / single-machine-capabilities / aip-compliance / acps-communication 中英 12 文件（npm files 白名单）。

## 0.3.2（2026-08-22）

### 版本对齐推送
- 版本更新至 0.3.2，对齐远程推送（GitHub punky971210/dsh-punky-swarm）
- 许可合规（AGPL-3.0 唯一许可）与 npm 发布描述维护

## 0.3.1（2026-08-21）

### 许可合规修正 + npm 发布
- 许可唯一化：全仓表述统一为 AGPL-3.0 唯一许可（AGPL-3.0-only），移除商业授权字段；其他授权一律「联系作者获得许可」（README.md / README.en.md / CHANGELOG 0.3.0 记载 / docs/OPENSOURCE.md）
- 品牌残留清零：Swarm 集群品牌词全包改写为 dsh 语义历史沿革（README 中英 L22、SKILL.md L152/L195、CHANGELOG 历史记载）
- npm 发布：dsh-punky-swarm@0.3.1 发布至 npm registry（`npm install -g dsh-punky-swarm`），README / docs/OPENSOURCE 安装章节同步更新
- 本地库同步：本地开发库与发布包文本/版本号对齐（排除 backup/node_modules/backups）
- 审计清理：docs/OPENSOURCE.md checklist LICENSE 项修正为 AGPL-3.0；本地库 package-lock.json root license 修正为 AGPL-3.0-only

## 0.3.0（2026-08-21）

### 0.3.0 发布：8 批次升级 + AGPL-3.0 唯一许可 + 治理能力默认全开
- 8 批次能力升级：引擎修复（目录 consume 判定 / 产物根指引 / 难度门禁豁免）+ lib 四域解耦（43 文件，删 3 单体）+ 国标 AIP 兼容 + 7 能力域（资产/装配/桥接/通信/面板/状态/验证/监控）+ 生命周期 + 恢复机制
- 测试 93 → 276 全绿（27 测试文件）
- 许可切换：Apache-2.0 → AGPL-3.0 唯一许可（AGPL-3.0-only；其他授权一律联系作者获得许可，自 0.3.0 起）
- 治理能力默认全开：wavePlan 三层 DAG + 引擎级门禁 + 状态机 + 锁/mailbox + 会话隔离

## 0.2.2（2026-08-21）

### 引擎修复 + README 边界修正
- 修复：Windows 目录 consume 判定（fileExistsNonEmpty 目录 size 恒 0 误报 GATE_ENTRY_MISSING → 目录存在即视为产物存在，空文件仍拒）
- 修复：产物根指引（任务包模板补「产物落盘」字段，worker 按引擎产物根落盘 / asset_claim 归位，双路径不一致根治）
- 修复：子代理难度门禁豁免（guard 对 subagent 降级豁免 + session 解析对称，worker 执行型工具不再被难度门禁误拦）
- README 边界修正：硬化=工程级门禁（dp1-dp4）确认已由 Tier3 实现，从「范围外」移除，Tier3 章节补 dp1-dp4 ↔ 门禁映射（README.md / README.en.md 1:1）

## 0.2.1（2026-08-19）

### Manager 代劳指挥协作架构 + role 残留清零
- 新增 SKILL.md「Manager 角色派发模板」：Manager=代劳指挥（只指挥不执行、不派发子代理），指挥循环 5 步（batch_status 读黑板 → mailbox_send 建议派发 → mailbox_read 收通知 → member_status/settle 结算 → report 批次完成）；任务包模板补 worker 双通道回执约定（report→Leader 简短 + mailbox_send outbox→Manager 详细）
- 新增 persona 纪律 0g Leader 唤醒协议：worker 由 Leader 派发（depth-1 直系）、Manager mailbox 建议、report→send_message 一行唤醒、Leader 不做调度决策（调度循环在 Manager 上下文）
- manager.md 协作方式 5 要素更新：不派发子代理 / mailbox 建议派发 / 收 worker 通知 / member_settle 结算裁决 / worker 双通道回执
- references/ 残留清零：constitution/workflow/call-chain-matrix-template/leader-decision-pack 4 文件 Swarm 集群运行时术语（HITL/HATL/Converge/任务包）改写为 dsh 语义（人审门禁/gap-list 对账/lane 任务）；role 8 文件重写（4 段骨架 dsh 工具面对齐）
- 测试 93/93 全绿；安装链路验证（模块加载 + syncAssets 幂等）通过

## 0.2.0（2026-08-19）

### 任务难度值门禁（工程纪律落地）
- 新增 assign_check 增强：scope（current/full，缺省 full）、输出 next/escalationHint/execToolCount/history；C 类 next=["wave_plan"]
- 新增会话级治理状态 governance.json v2（read/write/bump/stale/hasActiveBatch，原子写，history 审计留痕）
- 新增 guard 三重门禁（ctx.tools.guard）：门禁1 未评估/过期（execCallsSince>=20 或 >=30min）拒执行型工具；门禁2 判C未建批拒；门禁3 A类派 subagent 拒；非执行型豁免防死锁；计数与拦截分离；EXEC_TOOLS 可配置覆盖
- 新增 asset_claim 工具（工具面 13->14）：Leader 直做产物归位为批次资产（防逃逸纵深 + asset.claimed 事件留痕）
- config 贯通：apply 的 config 传入 createTools（config.escalation.execTools 覆盖名单，缺省回退）
- persona 纪律 0 重写（难度路由门禁：每轮必评 A/B/C + default to C + scope=full + 惰性化）+ 新增 0e（Leader 不写实现）
- jiufeng-team SKILL.md：移除"降级判定优先"判定策略（路由归 Punky Swarm 模式），改造为 C 类触发后的执行机制 + 任务包最小结构模板（两副本同步）
- 资产同步 syncAssets 幂等（预设/技能字节一致跳过，mtime 容差）
- 单测 68->93（governance 15 + asset/config 5 + 扩 5）

## 0.1.0（未发布）

### 2026-08-17 · 引擎初版
- 10 治理工具：wave_plan / batch_phase / batch_status / lane_claim / lane_release / member_status / member_settle / mailbox_send / mailbox_read / mailbox_ack；
- 状态机（成员 pending→…→merged|failed|skipped|conflict；批次 planning→…→complete）+ 原子写 + 锁 + mailbox + 恢复语义；
- 29 单测。

### 2026-08-19 · Tier3 三层门禁回填
- 新增 assign_check（委派形态判定 A/B/C）与 gate_status（门禁状态查询），工具面 10→12；
- wavePlan 层契约：layer ∈ plan/exec/audit、有 exec 必有 audit、路径契约、跨层引用校验、防篡改；
- 引擎级门禁：Entry（consume 齐备）/ L0（spec 必填章节）/ Exit（outputs/produce 存在）/ Complete（audit 全终态）；
- assembly 可插拔装配（默认装配）+ 会话隔离 v2（sessions/<id> + legacy 迁移）；
- 单测 29→68。

### 2026-08-20 · 产物注册表与门禁可视 + 开源准备
- 新增 artifact_types（产物类型注册表），工具面 12→13；
- API lanesGate、client GateBadge / AttemptBadge；
- 开源材料：LICENSE（Apache-2.0）、CI、CHANGELOG、CONTRIBUTING、三件套入包（presets/jiufeng + skills/jiufeng-team）；
- 修复：test script（node --test test/ → node --test，兼容 Windows/Node24）、peerDependencies 补 @deepseek-ai/dsh-tools。


