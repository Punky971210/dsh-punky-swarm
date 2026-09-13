## 未发布（Unreleased）

### 追踪项收口：口径定案与文档订正（2026-09-13）

- **F7（文档订正）**：`discipline.md` 附录 A 的 `TEAM_ASSET_LEAD_NOT_IN_LAYERS` 行订正为精确口径——该码只判「声明的 lead 角色**是否出现在任何层**的 `layers[*].roles` 中（声明悬空）」，**不判层次归属**；某层是否构成该层牵头由 `lane.layer` + 牵头集判定；并明示**牵头角色 ≠ Manager**（Manager 属引擎层、不占 lane）。
- **F2（勘误）**：团队资产内技能名**一律取加载名**（宿主 `SKILL.md` frontmatter `name`）；早期 spec 文本中的目录名写法（如 `research-compiler`）作废，实际值为 `ara-compiler` / `ara-research-manager` / `ara-rigor-reviewer`。
- **F1（跨批交接口径，零引擎改动）**：生产/交付批（`producer` / `publisher`）需要搭建批的 audit 产物时，**由 Leader 在生产批建批前用 `asset_claim` 把该产物归位到生产批产物根**，生产 lane 的 `consume` 指向**本批内路径**（入口门禁因此照常生效：审核未过则产物不存在 → `GATE_ENTRY_MISSING` 拒派）。跨批原生引用（引擎直接解析他批产物根）留作后续增强，**不得**假定其已生效。
- **O-2（路径口径）**：批次产物路径以 **批次 `wavePlan` 为唯一权威**（冻结语义，不中途重算）；plan 文档（`task-tree.json` / `assembly-statement.md`）中的路径引用仅作可读说明，与 wavePlan 不一致时以 wavePlan 为准。
- **F3 留痕**：`skills/design-team/SKILL.md` 直读字节数与某 lane 自述存在 +182 B 差异（疑报告后用词微调），不影响判据（Layer A 区块 59/59 已独立复算），记留痕、无动作。

### 团队装配扩充：design-team / research-team / writing-team（2026-09-13）

- **新增三套团队装配资产 + 团队技能**（装配数据唯一权威 = 各自 `presets/<team>/team-asset.yml`；团队技能只声明指针与用途，不复制装配数据）：
  - `design-team`：plan `design-planner`（评估需求 → 研判风格 → 设计 ComfyUI 使用资产）/ exec `workflow-builder`（搭建工作流 + 初步冒烟）、`producer`（**新批次实跑生产**，consume audit 产物）/ audit `workflow-auditor`（审工具合理性与是否符合设计目的）。技能：`spec-writing`、`interaction-design-principles`、`comfyui-use`、`acceptance-gate`、`review-execution`。
  - `research-team`：plan `research-planner` / exec `researcher` / audit `research-auditor`。技能：`spec-writing`、`decision-mapping`、`tech-benchmark-planning`、`ara-compiler`、`ara-research-manager`、`ara-rigor-reviewer`、`citation-evaluator`、`arxiv-translator`（**加载名口径**）。
  - `writing-team`：plan `writing-planner`（读者/平台/体裁/风格评估 → 写作规格）/ exec `drafter`（按规格成稿）、`polisher`（修订/去 AI 痕/密度压缩）、`publisher`（**新批次排版交付**，consume audit 两产物）/ audit `writing-auditor`（判据对照审稿，只读不改稿）。技能：`spec-writing`、`writing-trio`、`wechat-writing-style`、`humanizer`、`lieflat-less-ai-tone`、`revision-patterns`、`baoyu-markdown-to-html`、`acceptance-gate`、`review-execution`。
- **三团队共用口径**：自定义角色经资产 `roles.extra` + `plan_leads`/`audit_leads` 声明（与引擎基础牵头集**并集**）；`flows`/`state_machine` 沿用软件工程团队同口径（plan 契约裸标题 `## 验收标准`/`## 约束`、exec `entry_requires:["consume"]`、audit `needhuman`、`complete.require_audit_outcomes:["pass","skip"]`、`tighten-only`）；**生产/交付一律另开批次**，其 lane `consume` audit 验收产物（缺则 `GATE_ENTRY_MISSING` 拒派 ⇒ 审核通过才开产/交付）。
- **装配读端**：`lib/assembly/team-asset.js`、`lib/assembly/flows.js` 已随本次提交落入 HEAD（此前为未跟踪文件，他域改动回退会使新团队资产不可加载）。
- **技能名解析**：装配内技能名一律取**加载名**（宿主 `SKILL.md` frontmatter `name`）；引擎的技能存在性校验（`GATE_SKILL_MISSING`）按「宿主**目录名 ∪ frontmatter 名**」判定，避免目录名与加载名不一致时的误报。
- **登记与测试**：`presets/jiufeng/asset-manifest.json`（→9 条）、`lib/assets.js` `DEFAULT_ASSETS`、`test/assets.test.js` 计数与清单断言同步（断言强度未放宽）；新增 `test/team-assets-fill.test.js`（9 用例）与 `test/writing-team-asset.test.js`（5 用例）覆盖：资产加载期校验、建批技能前缀逐字、自定义牵头生效、生产/交付的 `GATE_ENTRY_MISSING` 正负例。

### 缺口推进（追踪项处置，2026-09-13）

- **`batch.manager.raised` 登记幂等（O-1）**：`store.markManagerRaised` 增**同 `agentId` 幂等守卫**——重复登记同一 Manager 直接返回既有记录、**不重复写事件**（此前「先登记、后迁移」的调用序被重试时会留下重复事件，属审计噪音）。配套把 `test/governance.test.js` 的期望事件数由 2 改为 1（断言强度不降：改为「同 agentId 幂等」这一更强语义）。验证：`npm test` **1062/1062 fail 0**。
- **F6（装配读端落 HEAD）**：`lib/assembly/team-asset.js`、`lib/assembly/flows.js` 此前是**未跟踪文件**（他域在途改动一旦被回退，design-team / research-team 两套新资产将不可加载）——已连同本批交付（`presets/{design,research}-team/team-asset.yml`、`skills/research-team/SKILL.md`、`test/team-assets-fill.test.js`）以**路径限定提交**落入 HEAD，未挟带他域在途改动。
- **F7（仅文档面，未改代码）**：`TEAM_ASSET_LEAD_NOT_IN_LAYERS` 的校验语义是「牵头角色须出现在**任一层**的 roles 中（声明悬空即报码）」（见 `lib/assembly/team-asset.js`），与部分文档写成「本层」不一致；**不收紧校验**——某层是否构成牵头由 `lane.layer` + 牵头集判定。已登入工作区追踪台账 `engine-open-items.md`。
- **澄清（与 Manager 层归属相关）**：**「牵头角色」不指代 Manager**。牵头角色是团队层内承担计划/验收职责的角色（声明面 `roles.plan_leads` / `roles.audit_leads`）；Manager 是引擎层功能角色（不属任何层、不占 lane，只代理指挥团队按任务 DAG 执行），从不进入牵头候选集；误用作 lane 角色会得专属告警 `GATE_ROLE_MANAGER_AS_LANE`。

### 复核收尾：`manager` 作 lane 角色的专属告警 + 孤儿回收入口留档（2026-09-13）

- **D1（修）**：`manager` 保留在合法角色集合中（供 `assembly.roles` **声明面**使用），新增**专属告警码 `GATE_ROLE_MANAGER_AS_LANE`**——某 lane 的生效角色为 `manager` 时提示「Manager 属引擎层（不属任何层、不占 lane），请改用该域自己的计划/验收角色（plan: designer/coordinator；audit: supervisor/doc-manager）」。此前该情形只会混入 `GATE_ROLE_MISSING`，读起来像「缺牵头角色」，语义错位。仅告警、不阻断；`manager` 仍可作 `assembly.roles` 声明项。
- **B7（留档，不接线）**：孤儿 worker 的显式回收维持 **lib 级人审能力** —— `store.recycleStalledLane(sessionId, batchId, lane)`：
  - **语义**：lane 必须为 `running` 且已有 `lane.stalled` 证据（终态 lane 永不可回收）；执行后 lane 落 `idle`，并留事件 `lane.recycled{lane, from:'running', reason:'stalled', outcome:'interrupted', note}`；随后走既有 `member_status(idle→running)` 重派。
  - **不接线的理由**：① 注册为治理工具会打破「20 工具契约」（多个测试文件硬断言）；② 加 API 路由 / 面板入口属前端面新增，超出本轮范围；③ 该动作要求人审判断，而工具层无 caller identity，暴露为工具反而不安全。
  - **触发方式（当前）**：宿主侧以 Node 直接调用 `createStore(<引擎状态根>).recycleStalledLane(sessionId, batchId, lane)`；是否接线为工具/API 由后续需要决定。

### 团队装配收敛：jiufeng 团队装配退役 + 临时团队 `flows` 面补全（2026-09-13）

- **jiufeng 团队装配退役**：装配数据唯一权威来源 = 团队资产 `presets/<team>/team-asset.{json,yml}`；删除 `presets/jiufeng/team-asset.yml`，`lib/assembly.js` 不再内置任何团队常量兜底（原 `team === 'jiufeng' ? DEFAULT_ASSEMBLY : null` 分支移除）。`DEFAULT_ASSEMBLY` 保留为兼容导出，内容改为 = `software-team` 装配（不再含退役技能名）。此后各团队以自身资产为准（`software-team` 等）。
- **无资产团队不再静默**：`team` 无对应资产时，建批照常成功但**不注入任何 `[skills=…]` 前缀**，并落告警事件 `gate.role_invalid{code: GATE_TEAM_ASSET_MISSING}`（不阻断）。
- **技能名存在性告警**：建批时校验装配引用的技能能否在**宿主技能根**（`~/.agents/skills/<name>/SKILL.md`）解析，缺失落 `GATE_SKILL_MISSING`（不阻断；技能根不存在时跳过校验，避免隔离环境噪声）。
- **临时团队 `flows` 面补全（D3）**：建批时 `teamsRoot` 随批次持久化（新可选字段 `teamsRoot`，缺省不写键 = 旧批零迁移）；门禁读端解析根优先级改为 ① 批次级 `teamsRoot` → ② 注入的 `flowsRoot`（测试缝）→ ③ 包根。临时团队的 `entry_requires` / `contract` / `produce_field` / `needhuman` / `complete` 判据**按临时资产生效**，与内置团队同一解析器、同一门禁语义。
- 契约测试同步：11 条承载旧语义的用例改写为新语义（等价锚改指 `software-team`；显式断言 `resolveAssembly('jiufeng') === null`、`loadTeamAsset(...,'jiufeng').ok === false`）；新增 T8（临时团队 flows 生效 + 缺省对照）。用例总数 1053。

### 治理面缺口修复（复核批次落地，2026-09-13）

- **终态冻结（A1）**：批次进入 `complete` / `aborted` 后，任何成员迁移一律拒 `GATE_BATCH_TERMINAL`（防「已收口批次仍被改写成 running」）。
- **C+ 收口告警（A2）**：exec 层 lane ≥3 的批次 `complete` 时未登记 Manager 拉起 → 落 `gate.manager_missing`（**非阻断**，避免追溯性拦旧批）。
- **Manager 拉起登记（新增可核事实）**：`batch_phase({ batchId, manager: { agentId, note? } })` 登记 → 写批次字段 `manager={agentId,raisedAt}` + 事件 `batch.manager.raised`；`batch_status` / `gate_status` 均可读。门禁：非 `running` 拒 `GATE_MANAGER_PHASE_INVALID`、终态拒 `GATE_MANAGER_TERMINAL`、`agentId` 必填 `GATE_MANAGER_AGENT_ID_REQUIRED`。
- **longrun 豁免随派发（A3）**：豁免是「本次派发」的属性——结算终态自动清退；**重派未带 `exempt` 时旧豁免自动失效**（不再继承放大阈值与 stalled 豁免）。
- **崩溃恢复清 stale lane 锁（A4）**：进程重启恢复把 in-flight lane 落 idle 时，同步清退该 lane 的锁文件（持有者进程已不存在 ⇒ 死锁），使重派不再被 `lane_claim` 冲突挡住。
- **`gate_status` 批次级视图（B3）**：返回补 `manager` 与 `assembly` 两字段，使 C+ 装配声明与 Manager 事实可经单次只读查询核对。
- **告警文本去重（B8）**：`GATE_ROLE_MISSING.missing` 拼接去重。
- **预留事件标注（B5）**：`worktree.created/merged/merge.conflict/merge.resolved`、`gate.passed`、`gate.exit.missing`、`gate.target_blocked`、`gate.target.passed` 标注为「预留未接线」（lib 内无写端无读端），不得当作既有留痕能力引用。
- **未接线声明披露补全（D4）**：`flows.*.consume_field` 补进「暂无消费点」清单（引擎恒按任务自身 `consume` 判定）。
- **发布面脱敏（C3）**：`skills/design-team/SKILL.md` 去除本机绝对路径与内部产物路径引用。
- **指引订正（C1/C2/C4/C6）**：装配声明的**唯一生效形态**写明为 `wave_plan({ assembly: { … } })` 顶层入参（plan 文档只是人可读载体）；persona 0h 豁免倍率改为「按类型取档（ai-render 8× / large-download 6× / dep-install·none 4×）」；纪律 0 条重复表述合并；难度路由口径明确为「多线并行或多依赖才升 C，单线程不建批」（B 档收窄为两类：独立上下文调研 / 已明确上下文可简单派发的单步任务）。
- **痕迹清理**：非文档文件中移除内部决策溯源与版本叙事（批次 id、日期戳、「用户裁决」、「本批/本轮」、内部文档路径、`spec §x`/`GAP-0x` 编号）；`test/**` 中承载旧语义的注释与常量同步订正。

### 审计日志（默认开、可显式关闭、有轮转与体积上限、零远程上报）

- 新增进程级审计日志 sink（`lib/auditlog/sink.js` + `lib/auditlog/config.js`），挂载点在 `lib/index.js` 的 `apply()` 内——**先于配置校验 warn、门禁逃生阀 warn 与资产同步**，使启动期审计信号不漏记；挂载失败不炸宿主。
- 落点 `<DSH_HOME>\logs\punky-swarm\audit-YYYY-MM-DD.jsonl`（本地日期；`<DSH_HOME>` 依次取 `PUNKY_AUDITLOG_SINK_DIR` → `DSH_HOME` → `~/.dsh`），不在会话工作区、不在插件产物根内；运行期诊断面在同根 `diagnostics/sink-diagnostics.json`。
- 默认开启；关闭渠道两条：环境变量 `PUNKY_AUDITLOG`（`0`/`false`/`off`/`no`）或配置键 `capabilities.auditlog.enabled: false`；env 逐键覆盖 config；关闭态不建目录、不注册 exporter、零字节写入；**热改需重启宿主生效**（不提供运行期挂载/卸载）。
- 行格式 JSONL，10 字段（`v`/`ts`/`level`/`name`/`msg`/`args`/`sn`/`truncated`/`pid`/`kind`）；单行硬上限 32 KiB，两段截断（先 `args` 后 `msg`）并留 `...[truncated]` 标记，不丢记录。
- 轮转与体积上限：单卷 64 MiB 硬分割（`-1`/`-2`… 单调递增）、保留 14 天、总量 512 MiB（超出按最旧优先清理）；只 append、永不改写既有卷。
- stdout 默认关（`PUNKY_LOGGER_STDOUT` 显式开启才输出），与文件 sink 同一 record 结构；写失败不 fallback stdout。
- 降级有界：export 全链路 try/catch 绝不向调用点抛错；连续失败 3 次开断路器（此后每 1000 次尝试放行一次探活），`sink-error` 记录上限 3 条；不调用 exporter 的 disposer。
- **不做任何远程上报**（零网络出口、零远端 sink、零 OTel 导出）；捕获面为元数据级（诊断文本 + 绝对路径 + 会话/批次标识符 + Error 堆栈），**无法按 ctx/插件收窄**（exporter 注册表进程级全局）。
- 能力注册表新增 `capabilities.auditlog` 项（默认值取自 `lib/auditlog/config.js` 的冻结常量，单一来源）；不注册新工具、不新增校验规则、不新增运行时依赖。
- 已知边界：不支持多进程写同一 sink 根（隔离实例请用 `PUNKY_AUDITLOG_SINK_DIR` 指定独立目录）。
- 版本号不变（本次仅登记变更，不 bump）。

### 团队更名登记：jiufeng-team → software-team

- 登记条目（可追溯硬项）：原名 `jiufeng-team` → 新名 `software-team`；日期 **2026-09-12**；原因：引擎/团队分层改造，团队技能名与团队定位对齐（「蟛蜞模式」为引擎侧治理模式名，软件工程角色指引归团队层，原「蟛蜞模式指引层」名不副实）。
- 影响面：技能目录 `skills/jiufeng-team/` → `skills/software-team/`（18 文件，文件集合与 8 角色文件名不变）；同步任务 `lib/assets.js:85` 目标改为 `~/.agents/skills/software-team`，关联测试 `test/assets.test.js` 同步；`SKILL.md` frontmatter `name:`、自检脚本 `scripts/check-v3-density.mjs` 注释与 `cmd` 示例改名；本包 `package.json` description 与 `docs/single-machine-capabilities.md`/`.en.md` 同步改名。
- 不改动面：`presets/jiufeng/`（preset id/目录名/`preset.yml` 的 `name`）、装配命名空间键 `jiufeng`（`DEFAULT_ASSEMBLY.team`、`aip.team`）、引擎数据根 `~/.dsh/jiufeng`、`VALID_ROLES`/`REQUIRED_ROLES` 值。
- 历史行不改：本文件既有 `jiufeng-team` 记载（历史事实行）原样保留，本次仅**追加**本登记块。

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


