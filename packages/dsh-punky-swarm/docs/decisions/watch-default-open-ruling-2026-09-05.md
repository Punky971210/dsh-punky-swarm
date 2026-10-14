# 决策备忘：watch 族出厂默认开定案（D1/D2/D3）+ R-PANEL + backlog 收录

- 日期：2026-09-05
- 主题：watch/lane 过期检测/longrun 治理族出厂默认「开」的口径定案与范围收窄（用户裁决），及默认关例外键转 backlog
- 决策状态：定案已落 exec 修正（comment-only + 文档口径对齐）；backlog 待后续逐项评估
- 归属：蟛蜞模式 / dsh-punky-swarm 架构决策系列
- 关联批次会话：watch-default-on-20260905（session-e02a999d-1936-4f07-96e9-c483645610da）
- 来源产物：plan/watch-default-inventory.md（p1-inventory 盘点）、plan/user-ruling-amendment.md（Leader 修正补充）

---

## 0. 结论摘要（四条裁决）

1. **D1 — watch 族出厂决策统一「默认开」**：watch/lane 过期检测/longrun 相关治理能力出厂默认开，代码事实已满足（schema.js WATCH_DEFAULTS.enabled=true、lane-heartbeat.js LONGRUN_DEFAULTS.enabled=true、resolve 均 `!== false` 显式 false 才关）；本批残余仅为注释口径 2 处（lib/index.js:202/:212 写「默认关/缺省不挂」），comment-only 修正达成文档与代码一致。
2. **D2 — 工具归属与兼容口径**：lane_longrun/lane_heartbeat 为蟛蜞插件（dsh-punky-swarm）内置工具，随 preset jiufeng 启用与插件 config（capabilities.watch.* / runtime.json overlay）生效；兼容性跟随插件自身声明（package.json:58-61 `@deepseek-ai/dsh-tools: "^0.1.0-rc.6 || ^0.1.1-rc.2"`）而非活 harness 版本。
3. **D3 — 范围收窄（用户裁决）**：本次仅落实 longrun 族默认开的口径统一；其余暂定默认关的能力一律不动作，转为 backlog 逐项评估后再定默认开。
4. **R-PANEL — 面板需求另批**：lane_heartbeat/lane_longrun 开关（capabilities.watch.longrun.enabled 与 watch.enabled）需进入「蟛蜞治理配置」面板，另建 C 类批实施，不在本批执行。

---

## 一、背景

watch 族（watch 心跳引擎 / lane 过期检测 / longrun 长跑档）此前经历了 P1-01「默认开化」定案修订：源码与测试均已翻为「缺省默认开、显式 false 才关」（WATCH_DEFAULTS.enabled=true 见 lib/schema.js:101-107，resolveWatchConfig `c.enabled !== false` 见 :117；LONGRUN_DEFAULTS.enabled=true 见 lib/watch/lane-heartbeat.js:64-68，resolveLongrunConfig :74），watchdog 挂载与 lane_heartbeat/lane_longrun 注册出厂即生效。但盘点发现个别注释仍沿用旧「默认关」口径（残留表述），同时工具清单文档的工具总数注释已陈旧（写 18，实测裸配置 20 / patch 全开 21 / 显式关 14），需 exec 层 comment-only 修正对齐。

## 二、裁决

### D1 — watch 族出厂默认开（含遗留注释修正）

- 事实基线：watch.enabled 缺省 = true（schema.js:117），watchdog 缺省即挂载（lib/index.js:203-224）、longrun tick 出厂即跑（lane-heartbeat.js:391-396）、lane_heartbeat/lane_longrun 出厂即注册（lane-tools.js:447-449；cordis.patch.yml:39-44 显式值与出厂默认一致）。
- 本批修正（exec comment-only）：lib/index.js:202 与 :212 注释按「出厂默认开，仅显式 false 不建/不挂」口径改写；不改任何默认值常量、判定逻辑、测试断言。
- 边界：watch 族之外的默认关能力不因本裁决翻转（见 D3 backlog）。

### D2 — 工具归属与兼容口径

- lane_longrun/lane_heartbeat 归属蟛蜞插件 dsh-punky-swarm（lib/tools/lane-tools.js 组装，watch/lane-heartbeat.js 自持门控）。
- 生效链：插件出厂默认（watch/longrun enabled:true）→ cordis.patch.yml capabilities.watch{enabled:true,longrun:{enabled:true}} → runtime.json overlay 通道（lib/hot/config-watch.js 顶层白名单热更）。
- 兼容声明：peerDependencies 随插件声明 `@deepseek-ai/dsh-tools: "^0.1.0-rc.6 || ^0.1.1-rc.2"`（package.json:58-61）；COMPAT 别名层为尽力而为托底，兜不住由 fail-soft 隔离。

### D3 — 本次仅 longrun 族；其余转 backlog（用户裁决 2026-09-05）

用户原意：「本次开只开 longrun，其他暂定默认关的工具留一份清单，之后慢慢改善再设置默认开；longrun 工具开关需要进配置面板，预计建批执行。」→ 本批只收 longrun 族口径；§五 backlog 收录全部其余默认关能力与界外同型残留，逐项评估、另行立项。

### R-PANEL — longrun 开关进治理配置面板（另建 C 批）

capabilities.watch.longrun.enabled 与 watch.enabled 开关进入 dsh webui「蟛蜞治理配置」侧边栏面板（复用既有 governance.hook 写通道 runtime.json 先例）。执行形态：面板 UI + 后端写通道扩展 + lib/hot/config-watch.js 白名单热更核对 + 装配 schema + 测试 = C 类批，在本批 complete 后启动。

## 三、证据（关键文件:行）

- lib/schema.js:100-127：WATCH_DEFAULTS（enabled:true、intervalsMinutes:[10,20,30]、maxMissed:3、scanIntervalMinutes:1）；resolveWatchConfig `enabled: c.enabled !== false`（:117）。
- lib/watch/lane-heartbeat.js:62-78：LONGRUN_DEFAULTS.enabled:true（:65 出厂默认开注记）；resolveLongrunConfig `!== false`（:74）。
- lib/assembly/schema.js:26-51：能力注册表 11 键口径——7 键默认开（aip/discovery/verify/watch/worktree/budget/trajectory）+ 4 键默认关（identity/acps/logs/topic）；watch 键 default = WATCH_DEFAULTS（:42）；worktree 键 default mergeAgent.enabled:false（:43）。
- lib/index.js:203-224：watchCfg = resolveWatchConfig → enabled 时 createLaneHeartbeat + setInterval watchdog；缺省 enabled=true → 出厂即挂。
- lib/watch/lane-heartbeat.js:344-357、391-396：longrun tick 仅扫 batch/lane === 'running'；lrCfg.enabled 时跑 longrunTick。
- lib/watch/lane-heartbeat.js:490、533-535：lane_heartbeat 门控 watch.enabled===true；lane_longrun 门控 watch.enabled && watch.longrun.enabled。
- lib/tools/lane-tools.js:442-458：组装 lane_heartbeat/lane_longrun + worktree 四工具（create/merge/checkpoint/checkpoint_status）。
- lib/tools/register.js:44：TBD-2 实测工具总数 裸配置 20 / patch 全开 21 / 显式关（worktree+watch 关）14。
- cordis.patch.yml:39-44：watch.enabled:true、longrun.enabled:true（显式值 = 出厂默认值）。
- package.json:58-61：peerDependencies `@deepseek-ai/dsh-tools: "^0.1.0-rc.6 || ^0.1.1-rc.2"`、`@deepseek-ai/cordis: "^4.0.1"`。
- C:\Users\Administrator\.dsh\jiufeng\config\runtime.json：仅 governance.hook，无 capabilities.watch → 出厂默认开在运行态生效。
- 测试：test/watch-heartbeat.test.js:213-224、:273-279；test/watch-longrun.test.js:308-312；test/watch-longrun-integration.test.js:227-257（出厂默认开断言，本批零改动）。

## 四、边界（本批禁止动作）

- 仅注释/文档口径文字修正；零默认值常量、判定逻辑、测试断言改动（lib/index.js R1/R2、cordis.patch.yml:47、NOTICE、agent.cordis.yml 均限口径文字）。
- 不碰 CHANGELOG/LICENSE/历史文件；零 commit/push（Leader 统一提交）；仓库内仅上述文件 + 本决策文档。
- 界外同型注释 3 处（lib/index.js:288 trajectory、lib/verify/evidence.js:223/:227、lib/verify/mount.js:35）不并入本批，列入 backlog（见 §五-2）。

## 五、后续（backlog 清单）

### 1. 默认关例外键（6 族 9 条）——待逐项评估后再定默认开，逐项立项推进

1. **identity（aip.identity）**：assembly/schema.js:39 default {enabled:false}；docs/aip-compliance.md:35-37 零加载零工具面。保守依据：身份体系需宿主信任语境。
2. **acps 族（acps.* 含 discovery/bridge+inbound/registry）**：schema.js:218-233 ACPS_DEFAULTS 双关（enabled + endpoint）；assembly/schema.js:36-38；acps-communication.md:3 零运行时路径。保守依据：网络暴露面安全默认。
3. **logs（capabilities.logs）**：assembly/schema.js:46-48；register.js:44 logs 默认关不注册；patch 显式 logs.enabled:true 才注册（cordis.patch.yml:67-68）。
4. **topic（capabilities.topic）**：assembly/schema.js:49-50；lib/index.js:92/:298 关闭零挂载；预留模块接线归操作面板批次。
5. **resume（config.resume.enabled）**：lib/state/resume.js:43-49 缺省关 = 严格判等；启动恢复保守默认（in-flight 落 idle，不原地恢复）。
6. **mergeAgent（capabilities.worktree.mergeAgent）**：assembly/schema.js:43；cordis.patch.yml:52-55；merge-agent.js:22/98 默认关 = 现状路径逐字一致。依赖宿主注入 spawner。
7. **escalation + flags（governance.hook.escalation / flags.*）**：cordis.patch.yml:90-97/:102-104；governance-boundaries.md:44 默认关 = 出厂零行为变化；运行时 runtime.json 显式开启属显式路径。
8. **trajectory.poll / trajectory.autoFail（能力键内子键）**：schema.js:90-97 默认关/autoFail=false；trajectory.js:19/108 仅 loop_deadlock 且置信达标才自动结算；notify-only 保守默认（trajectory 能力本身默认开）。
9. **verify.mode（保守档而非关）**：schema.js:132-135 mode=advisory 默认只记录不拦截；enforce 需显式启用（verify 能力 enabled 本身默认开）。

### 2. 界外同型注释残留（3 处）——「邻域注释口径清理」另开 comment-only 批

1. **lib/index.js:288**：trajectory「enabled 默认关」vs TRAJECTORY_DEFAULTS.enabled=true（schema.js:93-98）。
2. **lib/verify/evidence.js:223/:227**：post-execute 捕获「enabled 缺省关」+ 函数默认参 enabled=false vs VERIFY_DEFAULTS.enabled=true（schema.js:132-135）；mountVerify 调用方传 cfg.enabled 默认实为开。
3. **lib/verify/mount.js:35**：「enabled=false（默认）→ installed:false」vs verify 能力缺省开（resolveVerifyConfig `!== false`；verify-mount.test.js:125-130 断言缺省 installed:true）。

## 六、变更记录

- 2026-09-05：建档。收录 D1/D2/D3/R-PANEL 定案 + backlog 例外键 6 族 9 条 + 界外同型 3 处；exec（lane e1-comment-fix）按本备忘完成仓库 4 文件 comment/口径修正，报告见 exec/comment-fix-report.md。
