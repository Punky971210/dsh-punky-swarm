# 引擎宿主加载冒烟配方（不重启宿主形态）

> 用途：给「涉及宿主加载链路」的引擎改动提供一条**无需重启宿主**的加载冒烟，作为 `node --check`／单测之外的中间判据。
> 来源：批次 `engine-debt-cleanup-3-20260918` / lane `exec-d6-and-smoke`（规格 `plan/c3-spec.md` §3.1 M-1…M-4）。
> 探针本体：该批产物根 `exec-d6-and-smoke/probe/host-load-smoke.mjs`（批次产物根在引擎状态根下，不在包内）。

## 1 前置

- cwd = 包根；隔离 preload 必须挂上（否则 `apply()` 的资产同步会写真实用户目录）。
- `--import` 在 Windows 上**不接受裸绝对路径**（报 `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'd:'`）⇒ 用相对路径或 `file:///…`。
- **`DSH_HOME` 单独不足以隔离本包**：引擎侧三条写路径都经 `os.homedir()` 取真实用户目录（`DSH_HOME` 不在 `os.homedir()` 的取值链上）⇒ 手工起隔离实例时必须**同时重定向** `USERPROFILE` / `HOMEDRIVE` / `HOMEPATH`（实测取值优先级：`USERPROFILE` → `HOMEDRIVE`+`HOMEPATH` → 账户 API；仓库 `test/helpers/isolated-home.preload.mjs` 只改 `USERPROFILE`/`HOME`/`DSH_HOME` 亦足，但显式补齐四件可覆盖 `USERPROFILE` 被清空/重置的路径）：
  - `lib/index.js:92` = `const rawRoot = config.root ?? '~/.dsh/punky-preset';`（引擎状态根；该行所属代码块经 `homedir()` 派生真实用户目录——`homedir()` 字面调用在 **L93** `join(homedir(), rawRoot.slice(1))`）⇒ 未重定向时批次产物根仍落 `<真实 home>/.dsh/punky-preset`。
  - `lib/assets.js:210` = `const home = opts.home ?? homedir()`（`syncAssets()` 内逐字的 `homedir()` 调用）⇒ 装配期写 `<home>/.dsh/.agent-presets/**` 与 `<home>/.agents/skills/**`（无 config 开关可关）。
  - `lib/index.js:184` = mailbox 启动清扫的**代码块起始注释行**（`sweepOnStart` 默认 true）；mailbox 根取用在 **L190** `join(root, 'sessions')`，其 `root` 由 L93 的 `homedir()` 派生 ⇒ 未隔离时会 sweep / 删除真实用户目录下的 mailbox。
- 修正后的前置（PowerShell：四变量 + `os.homedir()` 自证；若起实例另加 `--port 0`、**禁占 3080**，并在用后清理隔离根）：

```
$Iso = Join-Path $env:TEMP ('punky-iso-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Iso | Out-Null
$env:DSH_HOME    = $Iso                                                  # 引擎状态根 / 审计 sink 面
$env:USERPROFILE = $Iso                                                  # Windows 上 os.homedir() 的首选来源
$env:HOMEDRIVE   = Split-Path -Qualifier $Iso                            # 例：C:
$env:HOMEPATH    = $Iso.Substring((Split-Path -Qualifier $Iso).Length)   # USERPROFILE 被清空时的回落对
# 自证：homedir() 必须落隔离根，否则拒绝继续
node -e "const os=require('os'),p=require('path');const iso=p.resolve(process.env.DSH_HOME);const h=p.resolve(os.homedir());if(h!==iso){console.error('ISOLATION_FAIL homedir='+h+' dshHome='+iso);process.exit(1)};console.log('ISOLATION_OK homedir='+h)"
```

## 2 两跑（先 RED 后 GREEN，禁攒批）

```
# RED（前置：先证明这条冒烟会红）
node --import ./test/helpers/isolated-home.preload.mjs "<探针绝对路径>" --red
#  期望：stdout 含 LOAD_FAIL=… ，EXIT=3

# GREEN
node --import ./test/helpers/isolated-home.preload.mjs "<探针绝对路径>"
#  期望：M-1/M-1b/M-2/M-3/M-4 全 OK，EXIT=0
```

## 3 四条覆盖（各自判据）

| # | 覆盖 | 判据要点 |
|---|---|---|
| M-1 | 插件入口真加载 | `import('<包根>/lib/index.js')` 成功；导出含 `apply` / `inject` / `name`；`name='dsh-punky-swarm'`；无 `LOAD_FAIL` |
| M-1b | 装配真跑（本仓增强项） | `apply(ctx,{root: <tmp>})` 不抛错；工具注册进 `ctx.tools`（缺省 26 件）；`logger.error` 0 行；返回 `disposer` 且可安全执行 |
| M-2 | 工具注册面构造期真跑 | `createTools(ctx,{store,root})` + `register()`；关键工具在场且 `parameters` 可枚举；临时 root 的 `batches/` 不存在（零真实批次落盘） |
| M-3 | 插件树描述件在场 | `cordis.patch.yml` 字节 > 0 且结构关键字（`name` / `config`）命中 ≥1 |
| M-4 | 隔离前置必检 | 容器内断言 `PUNKY_TEST_ISOLATED_HOME` 在 `os.tmpdir()` 下、`homedir`/`DSH_HOME` 在其下、不等于真实 home；否则探针非零退出。**并前后各取一次宿主技能根读数（`SKILL.md` 计数 + 最早/最晚 mtime）须逐字零变化** |

## 3.5 宿主兼容**第三维**：派得出去（派发可用）

> 前三节覆盖「**装得上**」的加载与装配面；本节补上宿主兼容判定的**第三维**——**「派得出去」**（worker 真产出产物）。

### 3.5.1 三维矩阵 —— 缺一不得判定兼容

| 维度 | 判据面 | 取数形态 | 状态 |
|---|---|---|---|
| **装得上** | `peerDependencies`（`package.json`，机读） | 解析面可枚举 | 已有 |
| **起得来** | 本配方 §2/§3 的 M-1/M-1b/M-2/M-3/M-4（+ 安装侧 `scripts/selfcheck-install.mjs --home <dir> --json`，`exit 0` ⟺ engine/preset/skills 三面齐备） | 本 checkout **可跑** | 已有 |
| **派得出去** | 起最小批次 ⇒ **核引擎产物根真有产物** | **只能在真宿主会话内取** | **本维新增** |

**判定式**：兼容结论必须**同时**验「装得上 / 起得来 / 派得出去」三维；**缺任何一维，结论不成立**。
⚠ 本文件**单语（无 `.en` 版）**，是 `docs/` 下唯一例外 ⇒ 此处不触发中英成对约束；若把本维纳入 `README.md` / `README.en.md`，**两份必须同改**（不在本次改动范围）。

### 3.5.2 第三维的两条必核判据（缺一条即不得判「派发可用」）

**判据一 · 核「引擎产物根真有产物」，不看回执。**

- **合格读数** = 引擎产物根（`<引擎状态根>/sessions/<sessionId>/artifacts/<batchId>/`）下**存在该 lane 声明的产物文件，且非空**。
- **反面判据（负控）**：**仅凭 `lane_dispatch` 回执不足以判定派发可用。** 回执（`spawned` / `token` / `firstLine` / `ttlMs` / lane 状态）只证**「调用返回了」**，**不证「worker 真产出」**；回执成功而产物根为空 ⇒ **判定为「派发可用」不成立**。
- 同一条负控适用于全部**动作自述类**读数：`spawned:true`、`status:'running'`、批次相位迁移、扫描条数——**均不得**替代产物根在场性。

**判据二 · 核「方法名」而非只核「服务在不在」。**

- 合格读数 = **`rt.start` 存在且为函数**（`rt` = `ctx.subagents`）。本仓**已**在能力探测处做该判定：`lib/engine/dispatch.js:745` = `return rt && typeof rt.start === 'function' ? rt : null;` ⇒ **此条须写入检查步骤**，使「方法名」成为**显式证据项**，而非隐含在函数内部。
- **接口真源**：现行派发接口 = **`rt.start(provider, request)`**（one-shot，请求载荷**平铺**），**不是** `startContinuable(spec)`。
  - 直读锚点：`lib/engine/dispatch.js:875`（`【2026-09-22 · one-shot 化】startContinuable(spec) → rt.start(provider, request)`）、`:893`（**唯一调用点**）、`:662`（载荷组装）、`:22`/`:33`（模块头注释）、`lib/index.js:96`（`inject` 声明 `subagents`）。
  - ⚠ **外部书面材料仍可能记 `startContinuable(spec)`** ⇒ 按外部材料写的消费者会**同名不符**失败。**以代码直读为准，不以本文档历史版本或外部材料为准。**
- **上一条的不可替代性**：探测通过 ≠ 调用通过 ≠ **产物在场**。三者是三级递进的独立判据，**不得互相替代**。

### 3.5.3 缺失机理：探测**对象**错位（比「清单缺一条」深一层）

本仓的 `subagentRuntimeOf(ctx)`（`lib/engine/dispatch.js:738-747`）**确实核了方法名**（`:745` 的 `typeof rt.start === 'function'`）。但**错位不在「有没有核方法名」，而在三处**：

| # | 错位点 | 直读锚点 | 后果 |
|---|---|---|---|
| 1 | 探测把 **「服务不在」** 与 **「服务在但方法名不匹配」** 折叠成**同一个返回值 `null`** | `:741`（`rt = ctx?.subagents ?? null`）、`:744`（注入守卫抛错 ⇒ `null`）、`:745`（`typeof` 不符 ⇒ `null`）；三路**同返 `null`** | 「宿主升级改了方法名」与「宿主本就没挂该服务」**二义** |
| 2 | `null` 的唯一处置 = **降级「仅发句柄」**（`spawned:false` + `spawnNote`），**不是**显式的不可兼容裁决 | `:827-830` | 方法名不匹配时，本仓走**静默降级**；调用方若只看 `spawned` 与 lane 状态，**看不出宿主版本不兼容** |
| 3 | 探测对象是 `rt`（`ctx.subagents`），**调用对象是 `rt.start`** ⇒ 探测**不产出「本次实际用的那个方法」的证据链** | 探测 `:745` vs 调用 `:893`（`await rt.start(provider, request)`） | 探测与调用**非同一对象读数**；判据面缺一条「实际被调用的方法在场」的显式记录 |

**⇒ 传播链（服务在、方法改名）**：探测按 `:745` 返 `null` ⇒ 降级为「仅发句柄」；若该降级未被接受而**径直到达调用点**（或外部消费者直接调 `ctx.subagents.startContinuable(…)` 等旧名），调用抛 ⇒ 经 `mapSpawnError`（`:702-711`）**归一到 `GATE_DISPATCH_FAILED`**（`:710` 兜底分支）；同时**回滚 lane 至 `failed`** 并**作废已发放句柄**（`:918-929`）。即：**探测层没有「版本不兼容」这一档**，真不兼容要到**调用失败**才显形。

> **⚠ 被证伪的上游转述（如实登记，勿沿用）**：上游材料把本机理写作「能力探测**只探服务存在性**（`ctx.subagents`）**不探方法名**（`rt.start`）」。**直读证伪**：`:745` 逐字为 `return rt && typeof rt.start === 'function' ? rt : null;` ⇒ **方法名确被检查**（`dispatch.js` 全文模式 `\.start\(` 落点：`:22` 注释 / `:893` 调用，**无**「只查存在性」的裸真值判定）。**准确定义**：不是「漏探方法名」，而是**探测结果二义**（服务缺 vs 方法改名不可分）+ **处置为降级而非显式不兼容裁决** + **探测对象与调用对象非同一点**。检查清单仍须写「核 `rt.start` 方法名」，其价值 = 把**隐含在函数内部**的判定**升为显式、可取证步骤**。

### 3.5.4 环境限制与替代路径登记（**不得**据此判 pass）

**不可达面（如实登记）**：

- **「派发产出产物」的真实读数只能在真宿主会话内取得（需授权窗口）** —— 因为派发需要**在场的宿主服务** `ctx.subagents`（`lib/index.js:96` 声明的注入面），而本 checkout **无在役宿主会话**。
- **探活时刻：2026-10-13（本机实测）**，环境读数为：
  - `packages/dsh-punky-swarm/node_modules` **顶层 8 条目**（`.bin` / `@deepseek-ai` / `@standard-schema` / `@types` / `typescript` / `undici-types` / `zod` / `.package-lock.json`）；`@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools` **均可解析**（`require.resolve` 实测命中本地 `node_modules`）。
  - **裸进程加载现况**：`node -e "await import('./lib/index.js')"` ⇒ **成功**（`name='dsh-punky-swarm'`、`inject=['tools','webServer','subagents']`、`apply=function`）⇒ **本环境「起得来」侧已有可跑读数**。
  - **订正登记**：`test/helpers/host-dep-fallback.mjs:23` 逐字「`packages/dsh-punky-swarm/node_modules` 为空（本机实测 0 条目）⇒ 任何加载 `lib/**` 的进程都抛 `ERR_MODULE_NOT_FOUND`」——该**语句在其自述的探活时刻成立**，但**以本 checkout 当前形态已不成立**（依赖已就位）。按该钩子自述的语义（`:146-151`：**先走默认解析链**，**仅**在 `ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND` 时才回退宿主检出），**本地可解析状态下该钩子不介入**。
  - ⇒ **不得**再以「node_modules 为空 ⇒ 加载必败」作为「第三维不可得」的理由；当前不可得的**唯一**理由是**宿主服务 `ctx.subagents` 不在场**。第三维仍**不可得**，但边界已收窄。

**两条替代路径（真实存在，本 checkout 可核；用途 = 覆盖「起得来」及其相邻面，**不**覆盖第三维）**：

| 路径 | 存在性回显（探活时刻 2026-10-13） | 作用 | 与第三维的关系 |
|---|---|---|---|
| `test/helpers/host-dep-fallback.mjs` | **EXIST 9761 B** | 惰性兜底 ESM 加载钩子：先 `nextResolve` 走默认解析链，仅「本地找不到」才回退宿主检出（生产零介入）；供**测试内 spawn 的子进程**兜住依赖缺失 | **不覆盖**第三维：它解的是「模块解析」，不是「宿主服务在场」 |
| `test/g10-host-smoke.test.js` | **EXIST 6950 B** | 真装冒烟：经同一入口 `apply(ctx,{root})` 真装载 + 工具面真注册且无重名 + 走插件自己的 store + `disposer()` 无残留 | **不覆盖**第三维：它证「装配与注册」，**不证**「worker 真产出产物」 |

⇒ **本批交付面 = 本检查清单 + 判据（§3.5.2）+ 上述替代路径登记**；**不承诺**在本 checkout 取得真实派发读数。

## 4 不覆盖（务必显式登记，勿当已做）

- **进程级宿主重启冒烟**：重启在役宿主后确认插件树加载成功、引擎无 boot 报错（需用户授权窗口）。
- **热更真机验证**：改现网 `config/runtime.json` 后**不重启**观察派发行为变化（需用户改现网配置）。
- **第三维「派得出去」的实测读数**：起最小批次并核产物根在场性，**需真宿主会话（授权窗口）**；本 checkout 无宿主服务 ⇒ 本节只给判据，**不得**写成 pass（详见 §3.5）。
- 以上三项属「需用户配合」形态，只能登记为未验证项，**不得**写成 pass。

## 5 判据边界

- 本配方证明「模块加载 + 装配 + 工具注册」链路在当前工作树可跑通，**不证明**运行中宿主的新代码已生效（那需要一次重启/reload 窗口）。
- 本配方**不证明**「派得出去」：装卸与注册链路通过 ≠ worker 能派发、能落产物（第三维判据见 §3.5.2，取数需真宿主会话）。
- 与全量套件的关系：本配方是**中间 checkpoint**，替代不了套件与终读数采集。
