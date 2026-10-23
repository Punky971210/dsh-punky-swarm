# 设计边界登记 —— 四类残余 + 两项未验

> **文档性质**：本文件登记**已论证过、明确不修**的残余项与未验项。它不是待办清单的反面，而是**下一批接手者的判据**：
> 这些条目每一项都做过威胁模型与代价评估，结论是「在当前平台契约下修不成**或**修它超出收口范围」。
> 没有这份登记，下一个接手者会把它们当成「上一批忘了修」，重开一轮 —— 这正是本文存在的理由。
>
> **不发布**：`package.json` 的 `files` 白名单已不含 `docs/`（裁决 `Q-10@closeout`）⇒ 本文不进 npm 产物，
> 因此可以写内部细节，不必为发布面裁剪。
>
> **用语纪律（读本文前先接受这一条）**：以下条目**没有一项**属于「问题已不存在」。它们的正确表述是
> 「窗口已收窄 / 恶化路径已封 / 残余已登记 / 证据级别为静态」——**禁止**任何完成态表述（如把某项写成
> 已经不存在、已经彻底解决）。凡窗口仍在的，本文一律给出该窗口的**明确读数**，让复核者能自己判断可接受性。

## 一、四类残余

### 残余 1 · 写面 fencing 缺失（批级 rev CAS 的残余窗口，K-1）

- **窗口大小**：`diskRevOf` 读完盘上 `__rev` → `atomicWrite` 的 `renameSync` 完成之间，**两次文件系统调用**
  （实测量级 μs~ms，不是秒级）。锚点符号：`lib/state/store.js` 的 `diskRevOf` / `commitBatch` / `atomicWrite`。
- **触发条件**：两个写者**都**在该窗口内完成「读 → 比对 → 写」这一整段，且两者读到的 `actual` 相同 ⇒
  双双通过 CAS ⇒ 后写覆盖先写（lost update）。
- **为何不修（平台限制）**：彻底闭合需要 OS 级「**写前有条件替换**」原语 —— Linux 的
  `renameat2(RENAME_NOREPLACE)` 可以一次写完成「校验 + 替换」，但 Windows **无等价语义**；
  另一条路是文件锁，用户裁决 K-1 已明确**否决**把锁接进批级写路径。
  平台之外的补充：本引擎的威胁模型里，并发写者**本就具备与引擎相同的写盘权限** ⇒ 该窗口只影响
  「谁的事实留下」，不扩大「能写到哪」，不构成提权。
- **当前缓解**：① **rev CAS 单点**（`commitBatch`）把窗口从「整段 read-modify-write（含门禁链、
  `command gate` 子进程、`claimAsset` 的文件复制）」压到「两次 fs 调用之间」；② 冲突**抛普通错误且零落盘**，
  由上层重读重试 ⇒ 覆盖不再是**静默**的：被覆盖方下一次同对象提交会因 `actual` 跳变**立刻**抛冲突，
  事实不会消失；③ `__rev` 就地回写调用方对象（正确性条件，防自冲突）；④ 损坏 JSON **抛而不覆盖**，
  绝不把 corrupt 当 `0`。
- **可接受性**：并发写在本引擎是**常态**（worker 同时结算），但「同批双写在 μs~ms 窗口内同值通过」是
  低概率事件，且**后果可判**（下一次提交即暴露）。判据形式是「已可判 + 窗口收窄」，不是「已消除」。

### 残余 2 · TOCTOU（`log_export` 的 `writeTo` 落盘）

- **窗口大小**：复判（`resolveWriteTargetIn` 第二次解析）→ `fs.openSync` 之间**一次** syscall 间隙。
  锚点符号：`lib/tools/log-tools.js` 的 `writeTo` 分支。
- **触发条件**：在该间隙内，产物根内的**祖先目录段**被替换为 junction / 软链，使本次写入被重定向到根外。
  攻击者是**与引擎同用户**、能在根内建 junction / 软链的本地进程（与 `claimAsset` 同族、同威胁模型）。
- **为何不修（平台限制）**：彻底闭合需要 `openat(dirfd, …)` / `O_NOFOLLOW` 语义 —— Node **跨平台不可用**：
  Windows 无 `openat`，且 junction 是**目录重解析点**、根本不受 `O_NOFOLLOW` 约束；剩余选项是给写路径加锁，
  属本批非目标（K-1 已否决）。
- **当前缓解**：① 首判 + `mkdirSync` 后**复判**的双档判据（词法 + realpath 解权，`resolveWriteTargetIn` 单点、
  fail-closed）—— 首判时中间段尚不存在，复判时它已存在 ⇒「刚创建就被换成 junction」在这一档暴露；
  ② 复判后**一次性 fd**（`openSync` 后只写该 fd，路径解析仅此一次），使「判据 → 落盘」之间只剩一次解析；
  ③ 失败文案由单点原样抛出，调用方可见语义未变。
- **可接受性**：重定向需与引擎**同用户**的本地进程，该主体已持相同写权限 ⇒ **不构成提权**；
  真正受影响的是「产物落点归属」这一**审计面**的准确性。故此残余的定级是「审计面残余」，不是「安全面缺口」。

### 残余 3 · `claimAsset` 重试耗尽后的孤儿产物

- **窗口大小**：`copyFileSync` 成功 → `asset.claimed` 事件落盘之间（`copy` **在重试循环外**）。
  锚点符号：`lib/state/store/batch.js` 的 `claimAsset`（`copyFileSync` 与 `commitBatch` 重试段）。
- **触发条件**：归位产物时与「结算 / 事件写」高并发 ⇒ `BATCH_VERSION_CONFLICT`，重试次数耗尽
  （`REV_RETRY_MAX`）后**上抛**——此时产物**已在盘上**、事件**未落盘** ⇒ 孤儿产物（有产物、无留痕）。
- **为何不修（平台限制）**：归位是「跨卷复制 + 事件落盘」**两步**，二者不具备单事务原语：
  把复制纳入 CAS 提交会让一次提交持续持有跨卷 I/O（正好把残余 1 的窗口重新放大）；用文件锁串行化，
  K-1 已否决。⇒ 在既有平台契约下，「复制成功但事件失败」这一中途态**无法消除**，只能**可判**。
- **当前缓解**：① 根内路径判据 **fail-closed**（词法 + realpath 双档，判据在 `mkdirSync` / `copyFileSync`
  **之前**）⇒ junction → 根外时**根外零落盘**；② `copyFileSync` **幂等**（同内容覆盖）⇒ 重试不重复副作用，
  且重试只覆盖「事件 + 落盘」段，冲突那次未落盘 ⇒ **不会重复事件**；③ 重试时**强制重读**，非冲突类错误
  **立即上抛不回退**；④ 孤儿可判：产物在场而批次事件流无对应 `asset.claimed` ⇒ 后续审计可按此比对发现。
- **可接受性**：耗尽概率随并发度上升但**有上界**（重试非无限）；且后果是「多一份未被登记的产物」，
  不产生静默的行为改变 —— 与「事件已落盘但产物缺失」（会误导下游取件）相比是**更安全的一侧**。

### 残余 4 · 残余 8 模块 SCC1 环（`lib/watch/**`）

- **窗口大小**：这不是时间窗口，而是**代码形态窗口** —— 该环当前能安全求值，**仅因**环内边全部指向
  聚合器 `lib/watch/lane-heartbeat.js` 的**函数声明**（ESM 实例化期即初始化，首求值不读其值）。
  范围：8 个成员（`watch/heartbeat/{activity,context,evidence,longrun,primitives,stalled,state-surface}.js`
  + `watch/lane-heartbeat.js`）、24 条环内边 + 3 条外部入边。
- **触发条件**（任一即回到 TDZ 崩溃面）：① 环内模块在**模块顶层**读另一环内模块的 `const` / `let`；
  ② 环内导出改成 **`const` 箭头函数**（不再是函数声明）；③ 新增「叶子模块反向 import 聚合器」的边。
  历史样本：`8d7815b` 形态下对 `heartbeat/primitives.js` 做首求值会抛
  `ReferenceError: Cannot access 'REASON_BLIND_RUN_UPSTREAM_NEVER_READY' before initialization`。
- **为何不修（平台限制）**：真拆环需要重构 `lane-heartbeat` ↔ `heartbeat/*` 的**聚合关系**
  （聚合器反向持有各叶子模块的注册表，这是设计选择而非缺陷）⇒ 属架构改造，超出本轮收口范围；
  且 ESM 的 TDZ 语义是**语言级**约束，没有「忽略循环导入」的运行时开关可用。
- **当前缓解**：`test/esm-first-eval.test.js` 是一道**长期防线**（不是一次性验收）：冻结
  `RESIDUAL_SCC_EDGES`（24 条环内边）/ `RESIDUAL_SCC_INBOUND`（3 条外部入边）/ `KNOWN_DYNAMIC_EDGES`，
  外加 **14 个模块的首求值清单**（独立进程 `import()`，任一 TDZ 即红）。清单**不得缩减** ——
  缩一个就少一个可触发入口的护栏；改环必须**显式声明**冻结表变更（不允许为迁就实现而改表）。

## 二、两项未验（证据级别为静态，`verified=false`）

### 未验 5 · `capabilities.verify.mode = 'enforce'` 的 warn（现网恒 `mode=advisory`）

- **窗口大小**（验证窗口）：装配面到判定面之间的**语义落差**永久存在 —— 配 `enforce` 与配 `advisory`
  在运行期**行为相同**（`createCompletionGate` 无生产消费点，装配侧只挂证据捕获 hook、**从不读 `mode`**）。
  锚点符号：`lib/verify/mount.js` 的 `mountVerify` 的 enforce 告警分支。
- **触发条件**：用户显式把 `capabilities.verify.mode` 配成 `'enforce'`。
- **为何不修（平台限制）**：接线 = 改**门禁链**（属功能变更，不是内务）；本轮裁决 `Q-2@closeout`
  明确「维持现状：只保证配 enforce 时 warn 可见」。且 `verify/gate.js` 的接线 or 退役本身**仍是未决项**，
  在没有该裁决前接线等于替用户拍板。
- **当前缓解**：① `mountVerify` 在**任何 inert 提前返回之前**主动 `warn`，说明 enforce **未接线**、
  实际按 advisory 生效，并指出静音路径（改 `advisory`）与决策文档锚点 —— 该 warn 位置是刻意的：
  放在 inert 返回之后，`ctx.on` 缺失时这条真相就永不可见；② 判定路径**零改动**（只多一条日志）；
  ③ 离线冒烟覆盖 `enabled/mode` 组合，使「warn 是否出现」可回归。

### 未验 6 · `inject` 缺服务时的真实失败形态（整块 pending）

- **窗口大小**（范围）：**宿主启动面**的**全或全无** —— 三个硬依赖（`tools` / `webServer` / `subagents`）
  任一缺失 ⇒ 本插件**整块 fiber 置 pending**，`apply` 根本不执行 ⇒ 治理工具面全部不出现、
  `/api/dsh-punky-swarm/*` 全部 404。判据是「在 / 不在」，不存在局部降级态。
- **触发条件**：宿主未提供服务（如未挂载 `@deepseek-ai/dsh-subagent` ⇒ 无 `subagents`）。
- **为何不修（平台限制）**：宿主 `cordis` 4.0.5 的 `inject` 归一化为 **name → config 映射、逐名 required，
  没有 optional 位**。真降级必须把键**移出** `inject` 并改用 `ctx.get(name)`（宿主唯一「不声明也能读」的通道），
  那是**插件加载面变更**，须先在最小 host profile 夹具下取得红→绿读数再动；而本轮裁决 `Q-3@closeout`
  **不投入真机验** ⇒ 证据级别只能停在「宿主源码契约 + 静态推理」。
- **当前缓解**：① 把事实**显式化**：三个键在 `inject` 里声明为硬依赖，并在 `lib/index.js` 注明
  「不是可选依赖」——不做「看起来可降级、实际不可达」的伪装；② 两处服务缺失守卫
  （`installWebSurface` 的 `if (ctx.webServer)`、`lib/engine/dispatch.js` 的「`ctx.subagents` 不可取」档）
  **保留作防御纵深**，并逐处标注「当前宿主契约下不可达，勿据其推断可降级」；其中派发侧已升级为
  **能力位前置 fail-closed 拒派**（宁可拒派也不「以弱换强」）；③ 离线冒烟覆盖四态
  （新形态 / 旧形态 / 皆无 / 未注入）——覆盖的是**离线可判**的部分，不声称覆盖宿主启动面。

## 三、分层说明：`asset_claim` 与 `lane_worktree_*` 互不替代

这两个能力名字相近、都涉及「文件落点」，但**不同层**，任何一方都**不能**替代另一方（裁决 `Q-6@closeout`）：

| 面 | `asset_claim`（产物归位） | `lane_worktree_*`（git 工作树隔离） |
|---|---|---|
| **管什么** | **产物归位**：把已有的源文件**复制**进 `<artifacts>/<batchId>/<target>`（保留内容、不移动），写一份 `asset.claimed` 事件 | **物理写隔离**：为 lane 建独立 git worktree + 分支（`punky/<laneId>` 从 orch 基线），让多个 lane 的**文件树写**互不踩踏 |
| **真源** | 批次产物根（引擎状态根内）+ 事件流 | git 对象库 / 分支 |
| **判据** | **根内判据**：`target` 必须是批次内相对路径，且经 `resolveWriteTargetIn` 的「词法 + realpath 解权」双档 fail-closed 判定 | git 自身（worktree / 分支/ merge 冲突） |
| **留痕** | `asset.claimed` 事件（可审计：谁在何时归位了什么） | `worktree.checkpoint` 事件 + git log（可审计：提交链） |
| **不可替代的原因** | 它解决的是「**产物在哪、归谁、有没有留痕**」—— 不碰 git，也不提供写隔离 | 它解决的是「**多个写者别互相覆盖文件树**」—— 不复制产物、不产事件、不判产物根内/根外 |
| **残余** | 重试耗尽孤儿（残余 3）、TOCTOU（残余 2 同族） | merge 冲突保留现场，交 Leader 裁决（不改成员状态） |

⇒ 一句话：**`asset_claim` 是「产物治理 + 审计留痕」，`lane_worktree_*` 是「并发写隔离」，二者正交。**
把产物归位改由 worktree 承担 = 丢掉「根内判据 + 事件留痕」；把写隔离改由 `asset_claim` 承担 = 让复制冒充互斥。两条都不做。

## 四、复核入口（每条残余都有一条可复跑的命令）

| # | 条目 | 复核方式 |
|---|---|---|
| 1 | 写面 fencing | 读 `lib/state/store.js` 的 `diskRevOf` / `commitBatch` / `atomicWrite` 三处 docblock（残余窗口与允许措辞写在那里）；行为面：并发提交下 CAS 抛冲突而非静默覆盖（`test/**` 的 CAS 用例） |
| 2 | TOCTOU（`writeTo`） | 读 `lib/tools/log-tools.js` 的 `writeTo` 分支注释（窗口描述 + 威胁模型）；根内/根外行为面：`resolveWriteTargetIn` 的双档判据用例 |
| 3 | `claimAsset` 孤儿 | 读 `lib/state/store/batch.js` 的 `claimAsset`（`copy` 在循环外 + 重试语义）；可判性：产物在场 vs 事件流的比对 |
| 4 | 残余 SCC1 | `node --test test/esm-first-eval.test.js` ⇒ **7/7 pass**（该文件当前 7 条用例；「4/4」是只冻结 SCC 成员、尚未加冻三张边表之前的旧读数 —— 2026-10-23 实测更正）；冻结表数值（24 边 / 3 入边 / 14 模块）以该文件为准 |
| 5 | `verify.enforce` | 配置 `capabilities.verify.mode='enforce'` 后启动，观察 `mountVerify` 的 warn；`grep -c 'is NOT wired' lib/verify/mount.js` |
| 6 | `inject` pending | 读 `lib/index.js` 的 `inject` 声明上方注释（硬依赖理由 + 降级路径 + 证据级别）；四态冒烟在 `test/**` |
