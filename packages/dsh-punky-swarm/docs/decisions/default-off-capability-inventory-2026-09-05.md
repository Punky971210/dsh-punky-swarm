# 决策备忘：默认关能力族留档盘点 + 同型注释清理记录

- 日期：2026-09-05
- 主题：默认关工具带决策依据留档（D3 收窄后的 backlog 实体化）+ 同型注释口径统一（comment-only 清理 T1-T5）
- 决策状态：留档建档完成；同型注释清理已由 exec（lane e1-cleanup）落地（comment-only 5 行/5 文件）
- 归属：蟛蜞模式 / dsh-punky-swarm 架构决策系列
- 关联批次会话：default-off-archive-20260905（session-e02a999d-1936-4f07-96e9-c483645610da）
- 来源产物：plan/archive-inventory.md（盘点清单/清理清单/文档大纲）、上批 plan/watch-default-inventory.md + plan/user-ruling-amendment.md（D3 收窄 + R-PANEL + backlog）
- 仓库基线：939cc86（上批 watch 族默认开口径已合入；本批 exec 改动待 Leader 统一提交）

---

## 一、背景

用户裁决 D3（2026-09-05）：「本次开只开 longrun，其他暂定默认关的工具留一份清单，之后慢慢改善再设置默认开；longrun 工具开关需要进配置面板，预计建批执行。」上批 watch 族出厂默认开已合入（939cc86），其例外清单（默认关能力 6 族 9 条 + 界外同型注释残留）升级为 backlog。本批指令：默认关能力族带决策依据留档建档 + 同型注释口径统一清理（仅注释/文档行，零默认值/判定逻辑/测试改动）。

---

## 二、默认关能力族全景（三层分轨，9 条）

分层口径对应三类默认关语义，供逐项默认开立项分轨：

- **L1 能力级默认关**：注册表 11 键中 4 键出厂默认关（identity/acps/logs/topic）——显式开启才激活，关闭时零加载零工具位/零监听/零网络。
- **L2 子键级保守默认**：父能力键出厂默认开，族内个别子键保守默认关（worktree.mergeAgent、governance.hook.escalation + flags.*、trajectory.autoFail/poll、verify.mode=advisory 保守档）。
- **L3 非注册表键**：config.resume.enabled——恢复能力，缺省关 = 严格判等语义。

默认开候选注记统一原则（D3）：逐条当前均置空待评估；确有长期默认关倾向的（acps 端点=对外网络暴露面、resume=恢复保守默认）注明「评估方向=维持默认关」倾向理由；其余待逐项立项评估后再定默认开（backlog 语义，非永久禁止）。本批一律不动作。

### L1 能力级默认关（4 族）

1. **identity（键 `identity`，config 路径 `aip.identity` → identity 族）**
   - 出厂默认关决策依据：注册表 `{ key:'identity', path:['aip','identity'], default:{enabled:false} }`（lib/assembly/schema.js:39；族注释 :30-32 默认关 → 零开销零破坏、不注册新治理工具）；lib/aip/identity.js:31（`enabled === true` 才激活）；docs/aip-compliance.md:35-37（默认关闭，关闭时零加载）；README.md:81（表列「关」）。
   - 默认开候选注记：置空待评估。身份体系（AIC/CAI/签名/信任链）需宿主信任语境；评估方向暂倾向「维持默认关至有明确宿主集成需求」。

2. **acps 族（键 `acps`，路径 `acps.*` → acps 族：总开关 + endpoint + discovery + bridge.inbound + registry）**
   - 出厂默认关决策依据（双关 + 全子键默认关）：总开关 + endpoint（lib/schema.js:209-233 ACPS_DEFAULTS，:219 能力总开关默认关、:221 endpoint 对外端点默认关、:231 devInsecure:false）；lib/assembly/schema.js:35-38（enabled 与 endpoint.enabled 均 false 时零加载零监听）；docs/acps-communication.md:3（全部默认关（安全默认），关闭时零运行时路径）；discovery 子键（lib/schema.js:167-173，:168 对外能力显式开启）；bridge + inbound（lib/schema.js:196-200，:197/:199；lib/comms/acps-bridge.js:18/82 inbound 缺省 false）；registry 子键（lib/acps/registry-client.js:22/29/128 半自动注册需显式开启）。
   - 默认开候选注记：**评估方向=维持默认关（倾向理由）**——对外 mTLS 服务端点 + 外部发现客户端，属网络暴露面安全默认；默认开立项仅当有受控内网/白名单部署需求且经安全评审。

3. **logs（键 `logs`，路径 `capabilities.logs` → logs 族）**
   - 出厂默认关决策依据：注册表 `{ key:'logs', default:{enabled:false} }`（lib/assembly/schema.js:46-48，注释「日志导出工具注册开关——默认关（与 cordis.patch.yml 显式 logs.enabled:true 相合）」）；lib/tools/register.js:44（createLogTools 缺省不注册）；lib/tools/log-tools.js:25/131（readCapability 合并注册表 default {enabled:false}）；README.md:78（表列「关」）。
   - 默认开候选注记：置空待评估。日志导出工具属工具面收缩设计（缺省零注册零工具位）；可在面板配置化后评估按需开启（R-PANEL 后续批可带），无安全暴露面。

4. **topic（键 `topic`，路径 `capabilities.topic` → topic 族）**
   - 出厂默认关决策依据：注册表 `{ key:'topic', default:{enabled:false} }`（lib/assembly/schema.js:49-50，注释「预留模块开关——默认关；接线归操作面板批次」）；lib/index.js:89-92（默认关 → emit=null → 零行为变化）、:298-311（R2 运行时装配默认关）、:554（热更新启停分支）；lib/comms/topic.js:24、lib/comms/topic-runtime.js:20；lib/state/store.js:122。
   - 默认开候选注记：置空待评估。预留模块未接线前零挂载零路径；接线归操作面板批次（R-PANEL 同轨），默认开评估随接线批一并立项。

### L2 子键级保守默认（父能力默认开，5 组）

5. **worktree.mergeAgent（worktree 族内子键；父能力 `capabilities.worktree` 默认开）**
   - 出厂默认关决策依据：worktree 注册表 default `{ enabled:true, mergeAgent:{ enabled:false, model:null, timeoutMs:600000 } }`（lib/assembly/schema.js:43）；lib/tools/merge-agent.js:22/84/92/98（enabled !== true → statusQuo 现状路径逐字一致）；lib/tools/lane-tools.js:49/430；cordis.patch.yml:52-55（enabled=false（默认）冲突完全走现状路径）；README.md:78。
   - 默认开候选注记：置空待评估。依赖宿主注入 mergeAgentSpawner；无 spawner 环境（当前默认）冲突完全走现状路径。默认开评估须绑定 spawner 注入可行性。

6. **governance.hook.escalation + flags.*（governance 护栏族子键；父键 `governance.hook` 默认开）**
   - 出厂默认关决策依据：cordis.patch.yml:90-104（escalation.enabled:false :94 总开关默认关 = 零计数零记录零升级；flags.pause/narrow/defer 均 false :102-104 默认关 → P3/P4/P5 回退 DENY）；lib/governance/config.js:20/178/305；lib/governance/config.ts:21/37/204/322、types.ts:71/111（出厂默认关形态）；docs/governance-boundaries.md:44-46（出厂零行为变化，非缺失项）；docs/guardrails-hook.md:50。
   - 默认开候选注记：置空待评估（倾向维持保守面）。护栏违规升级保守设计（改规则不意外武装暂停）；运行态 runtime.json 显式 `escalation.enabled:true` 属显式开启路径、非默认翻转（config-watch 白名单热更先例，R-PANEL 面板批可复用写通道）。hook.enabled 本身出厂默认开（与子键默认关正交）。

7. **trajectory.autoFail / trajectory.poll（trajectory 族子键；父能力 `capabilities.trajectory` 默认开）**
   - 出厂默认关决策依据：TRAJECTORY_DEFAULTS（lib/schema.js:89-98：enabled:true :94、autoFail:false :95 异常只 notify 不自动 member_settle failed、poll:{enabled:false} :97 可选 HTTP 轮询 fallback 默认关）；lib/bridge/trajectory.js:19/108/157；validateCapabilities DEP-2/DEP-3 兜底（lib/assembly/schema.js:103-114）。
   - 默认开候选注记：置空待评估。notify-only 保守默认；autoFail 默认开需置信阈值体系与误判成本评估；poll 仅显式开启（依赖插件未装时静默降级）。

8. **verify.mode（verify 族子键；非「关」而是「保守档」；父能力 `capabilities.verify` 默认开）**
   - 出厂默认关决策依据：VERIFY_DEFAULTS（lib/schema.js:128-135：enabled:true :133、mode:'advisory' :134 默认只记录不拦截）；resolveVerifyConfig `enabled: c.enabled !== false`（:140）；lib/verify/gate.js:19/37/146-147（advisory 默认 / enforce 显式启用）；cordis.patch.yml:58-63（verify.enabled:true :62、mode:advisory :63）；DEP-1 校验（lib/assembly/schema.js:98-101）。
   - 默认开候选注记：**评估方向=维持 advisory 默认档**（只记录不拦截 = 出厂零拦截；enforce 需显式启用）。此项是档位默认问题而非「关→开」翻转，默认开立项实质 = 「enforce 是否升为默认」——倾向维持现状，除非治理审计要求默认拦截。

### L3 非注册表键

9. **config.resume.enabled（恢复能力，非注册表键）**
   - 出厂默认关决策依据：lib/state/resume.js:43-49（RESUME_DEFAULTS 无 readCapability entry：缺省关语义即严格判等）、:21/26（默认关，零运行时开销，行为不变）；lib/index.js:66/128（缺省关 → 内部委托 store.recoverBatches() 原路径零行为变化）。
   - 默认开候选注记：**评估方向=维持默认关（倾向理由）**。启动恢复保守默认：进程重启后 in-flight 一律落 idle（system.recovered），不原地恢复 running/review（防恢复误判）；显式开才原地保留。默认开立项需先评估恢复误判防护。

---

## 三、同型注释清理记录（comment-only，5 行/5 文件）

口径定义：代码实际默认开（DEFAULTS enabled:true 或 resolve 缺省 true），但注释/文档写「enabled 默认关 / 缺省关 / 默认关闭 / 缺省不挂 / enabled=false（默认）」的条目。本批清理 5 处（已知 3 处复核确认 + 新增 2 处并入，Leader 裁决），改文一律最小 diff；不改默认值常量/判定逻辑/测试断言。

- **T1 · lib/index.js:288（trajectory 桥接）**
  现文 `// enabled 默认关：enabled=false 时桥接不创建不挂载——零运行时开销，行为与既有版本一致。`
  → 改文 `// trajectory 出厂默认开（isTrajectoryEnabled 经 readCapability 合并注册表 default enabled:true）——仅显式 capabilities.trajectory.enabled:false 时桥接不创建不挂载（零运行时开销，行为与既有版本一致）`
- **T2 · lib/verify/mount.js:35（verify 装配）**
  现文 `//   enabled=false（默认）→ installed:false / reason:'disabled'，不注册任何监听，零副作用；`
  → 改文 `//   enabled=false（显式关闭——verify 出厂默认开，resolveVerifyConfig 缺省 enabled=true）→ installed:false / reason:'disabled'，不注册任何监听，零副作用；`
- **T3 · lib/verify/evidence.js:223（verify 捕获注释，仅注释行）**
  现文 `// ---- post-execute 捕获安装（enabled 缺省关，V5：enabled=false 零运行时开销） ----`
  → 改文 `// ---- post-execute 捕获安装（函数默认参 enabled=false = 裸调保守默认零开销；verify 能力出厂默认开——mountVerify 经 resolveVerifyConfig 缺省 enabled=true 装配时显式传 enabled:true） ----`
  （:227 函数默认参 `enabled = false` 保留——函数级保守默认，与能力默认开并存合理，属默认值红线禁改，本批不改。）
- **T4 · lib/index.js:374（verify 引擎级捕获装配注释）**
  现文 `// installEvidenceCapture（tools/post-execute 证据捕获，blob + ledger 落 <root>/verify/）。enabled=false（默认）`
  → 改文 `// installEvidenceCapture（tools/post-execute 证据捕获，blob + ledger 落 <root>/verify/）。verify 出厂默认开（resolveVerifyConfig 缺省 enabled=true）；仅显式 enabled=false 才`（续 :375「不挂 hook、零运行时开销」成句）
- **T5 · lib/api.js:181（agentCatalog /agents 端点注释）**
  现文 `// enabled=false（默认）时 agentCatalog 为 null，不注册该路由（既有路由契约不变）。`
  → 改文 `// aip.enabled=false（显式关闭——aip 出厂默认开，readCapability 缺省合并 {enabled:true}）时 agentCatalog 为 null，不注册该路由（既有路由契约不变）。`

**豁免/勿误清标注（非清理对象）**：例外键族自身「出厂默认关」描述真实正确（identity/acps/logs/topic、resume、mergeAgent、escalation+flags、trajectory.autoFail/poll、verify.mode advisory 档、extensions.blindReview、wave-plan resume 字段注记）；已修正/正确口径（lib/index.js:202/212、lane-heartbeat.js、lane-tools.js:448/450、cordis.patch.yml、NOTICE、agent.cordis.yml、lib/schema.js:100/129/146、README、docs/governance-technical.md:164/168）；test/ 层全部豁免（红线不碰）；CHANGELOG/LICENSE/历史豁免。

**自检口径**：grep 同型模式（`enabled 默认关|enabled=false（默认）|enabled 缺省关`）在 lib/ 应仅剩例外键族真实默认关描述——按 ②.2 豁免集判定残留=0（详见 exec/cleanup-report.md 自检节）。

---

## 四、后续立项指引

### 1. 逐项默认开评估（backlog 实体：9 项族条目）

按本备忘第二节注记逐项立项评估，先评 acps 之外的 8 项；acps 维持默认关倾向标注。具体：identity（有明确宿主集成需求时评估）、acps（仅受控内网/白名单部署 + 安全评审，倾向维持默认关）、logs（面板配置化后按需开启评估）、topic（随接线批一并立项）、mergeAgent（spawner 注入可行性评估）、escalation/flags（维持保守面，仅显式开启路径）、trajectory.autoFail（置信阈值体系评估）/poll（依赖就绪评估）、verify.mode（enforce 是否升默认评估）、resume（恢复误判防护评估后定，倾向维持默认关）。

### 2. R-PANEL 面板批（另建 C 类批）

lane_heartbeat/lane_longrun 开关（capabilities.watch.longrun.enabled 与 watch.enabled）进「蟛蜞治理配置」面板（dsh webui 设置侧边栏；复用 governance.hook runtime.json 写通道先例 + lib/hot/config-watch.js 白名单热更核对），另建 C 类批，本批 complete 后启动。

### 3. 可顺带评估项

logs 按需开启、mergeAgent spawner 注入、trajectory.autoFail 置信体系、verify enforce 档默认化。

---

## 五、变更记录

- 2026-09-05：建档。收录默认关能力族全景（L1 4 族 / L2 5 组 / L3 1 键 = 9 条）+ 同型注释清理记录（T1-T5）+ 后续立项指引（逐项默认开评估 + R-PANEL 面板批）。
- 2026-09-05：exec（lane e1-cleanup）comment-only 落地同型清理 5 行/5 文件（T1-T5，仅注释行）；本决策文档落盘 docs/decisions（gitignored 本地留档惯例，不入库）；仓库侧 4 文件改动待 Leader 统一提交；报告见 exec/cleanup-report.md。
