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

## 4 不覆盖（务必显式登记，勿当已做）

- **进程级宿主重启冒烟**：重启在役宿主后确认插件树加载成功、引擎无 boot 报错（需用户授权窗口）。
- **热更真机验证**：改现网 `config/runtime.json` 后**不重启**观察派发行为变化（需用户改现网配置）。
- 以上两项属「需用户配合」形态，只能登记为未验证项，**不得**写成 pass。

## 5 判据边界

- 本配方证明「模块加载 + 装配 + 工具注册」链路在当前工作树可跑通，**不证明**运行中宿主的新代码已生效（那需要一次重启/reload 窗口）。
- 与全量套件的关系：本配方是**中间 checkpoint**，替代不了套件与终读数采集。
