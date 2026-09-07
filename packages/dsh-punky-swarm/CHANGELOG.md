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

## 0.3.6（2026-08-29）

### 操作面板增强

- 配置热更新：配置变更实时生效，无需重启（兼容 Windows 平台约束）。
- 状态事件实时发布：状态变更经 topic 通道推送（swarm.&lt;type&gt;.&lt;sid&gt;.&lt;bid&gt; 命名）。
- SSE 实时面板：新增 /stream 端点，EventSource 主通道 + 轮询降级 + 心跳恢复；客户端面板段逐字节同步。

### 代码质量收敛

- 事件常量单点化（发端/读端统一引用，消除字面量散落）。
- git 工具函数单点下沉，消除双向依赖环。

### Punky Swarm 模式指引精简

- 角色指引瘦身（Persona 精简、公共约束单一来源），配套密度校验脚本自动检查。

### TypeScript 化（contract/gate 模块）

- contract/gate 核心模块改为 TypeScript 源 + 编译产物双形态：`lib/schema`、`lib/state/gates`、`lib/state/machine-rules`、`lib/state/schema-v3`、`lib/wave-plan` 提供 `.ts` 源、`.d.ts` 类型声明与编译后 `.js`；新增 type-only 契约层 `lib/types/contracts`（运行时行为不变）。
- 新增 `tsconfig.json` / `tsconfig.build.json` 与 `scripts/copy-ts-built.mjs` 构建链路（`npm run check` 类型检查 / `npm run build` 编译 + 产物归位）；devDependencies 引入 `typescript ^5.9.3`。

## 0.3.4（2026-08-22）

### dsh-tools 双版本兼容（compat-layer）

- peer/devDependencies 的 `@deepseek-ai/dsh-tools` 改为 `^0.1.0-rc.6 || ^0.1.1-rc.2`，双版本兼容内核 0.1.0-rc.6 与 0.1.1-rc.2。

## 0.3.3（2026-08-22）

### 国标 AIP 兼容契约对齐

- **aip.enabled 默认开启**（readCapability 合并 `{enabled:true}`）；智能体描述改为 ACS 字段集（根对象 20 键 必填 14/可选 6、AgentSkill 8 键，协议 02.01，旧 14+8 属性降级为 toLegacyDescriptor 兼容映射层）；消息映射对齐 ACPs AIP（aip-format.js Message/TaskCommand/Session 三函数，mailbox/batch 附 ACPs 投影）；身份体系（默认关）：AIC 身份码（前缀 1.2.156.3088 + CRC-16/CCITT-FALSE + Base36）+ CAI 身份证书 + 可插拔签名（默认 ECDSA-P256/RSA-2048）；发现服务（ADP，默认开）：`lib/discovery/` 新域 + `POST /api/dsh-punky-swarm/discover`（type 四类/filter 34 运算符/错误码 40000~40005/50001）+ `GET /.well-known/aip`；工具描述 6 属性保持现状（待正式协议文本校准）。

### ACPs 通讯方式（默认关）

- **能力总开关默认关**：`acps.enabled` 与 `acps.endpoint.enabled` 均默认 `false`，关闭时零运行时路径；对外 mTLS 服务端点：独立 HTTPS 监听器（node:https/tls 原生、零新依赖），默认端口 9443/host 127.0.0.1、TLSv1.3 + 双向证书（CERT_REQUIRED）、端点 `POST /acps/rpc`（AIP JSON-RPC）+ `GET /.well-known/acs.json`（ACS 14 必填键 + mutualTLS + JSONRPC）+ `GET /health`，证书 CA 自签（CN=AIC/SAN=acps://AIC，默认 `<root>/acps/certs`）；内部桥接（默认关）：`acps.bridge`（同进程双向，inbound 默认关需显式 `acps.bridge.inbound=true`；outbound = mailbox→ACPs 投影/投递；`/rpc→bridge 接线` 已通，inbound=false 时协议级 rejected INBOUND_DISABLED）；registry 对接（半自动注册，默认关）：login→upsertAgent→submitAgent（人工工批不自动跳过）→requestEab→queryAcs，EAB macKey **AES-256-GCM 加密存证**（与参考实现 SM4-CBC 标注差异）；discovery 对接（ADP 客户端，默认关）：`POST {baseUrl}/discover` 查询外部 Agent（type 四类/34 运算符与本地共享协议常量），scope=local/external/both（默认 local）；能力注册表扩至 9 键（aip/identity/discovery/verify/watch/worktree/budget/trajectory/**acps**，acps 与 identity 为默认关能力）；未实现项如实标注（工具调用待正式协议文本校准；SM2 签名无参考证据可插拔；mini-ADSP 仅预留签名；与参考实现真实互通待 demo 验证）。

### 护栏根治 + 文档补建

- 护栏 `\r?\n` 处理修复（merge-agent 护栏）；`README.en.md` 英文文档补建（22 KB，含中文互链）。

## 0.3.2（2026-08-22）

### 版本对齐推送
- 版本更新至 0.3.2，对齐远程推送（GitHub punky971210/dsh-punky-swarm）
- 许可合规（AGPL-3.0 唯一许可）与 npm 发布描述维护

## 0.3.1（2026-08-21）

### 许可合规修正 + npm 发布
- 许可唯一化：全仓表述统一为 AGPL-3.0 唯一许可（AGPL-3.0-only），移除商业授权字段；其他授权一律「联系作者获得许可」（README.md / README.en.md / CHANGELOG 0.3.0 记载 / docs/OPENSOURCE.md）
- 品牌残留清零：Swarm 集群品牌词全包改写为 dsh 语义历史沿革（README / SKILL.md / CHANGELOG 历史记载）
- npm 发布：dsh-punky-swarm@0.3.1 发布至 npm registry（`npm install -g dsh-punky-swarm`），README / docs/OPENSOURCE 安装章节同步更新
- 发布包与主仓库文本/版本号对齐（排除备份与依赖目录）
- 审计清理：docs/OPENSOURCE.md checklist LICENSE 项修正为 AGPL-3.0；本地库 package-lock.json root license 修正为 AGPL-3.0-only

## 0.3.0（2026-08-21）

### 0.3.0 发布：AGPL-3.0 唯一许可 + 治理能力默认全开
- 能力升级：引擎修复（目录 consume 判定 / 产物根指引 / 难度门禁豁免）+ lib 四域解耦（43 文件，删 3 单体）+ 国标 AIP 兼容 + 7 能力域（资产/装配/桥接/通信/面板/状态/验证/监控）+ 生命周期 + 恢复机制
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
- references/ 残留术语改写：Swarm 集群运行时术语（HITL/HATL/Converge/任务包）统一为 dsh 治理语义（人审门禁/gap-list 对账/lane 任务）。
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
# Changelog

本项目尚未发布；以下按时间线记录 0.1.0 未发布期间的主要变更。

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


