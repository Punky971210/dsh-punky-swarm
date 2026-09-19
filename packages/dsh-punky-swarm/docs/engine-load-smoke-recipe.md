# 引擎宿主加载冒烟配方（不重启宿主形态）

> 用途：给「涉及宿主加载链路」的引擎改动提供一条**无需重启宿主**的加载冒烟，作为 `node --check`／单测之外的中间判据。
> 来源：批次 `engine-debt-cleanup-3-20260918` / lane `exec-d6-and-smoke`（规格 `plan/c3-spec.md` §3.1 M-1…M-4）。
> 探针本体：该批产物根 `exec-d6-and-smoke/probe/host-load-smoke.mjs`（批次产物根在引擎状态根下，不在包内）。

## 1 前置

- cwd = 包根；隔离 preload 必须挂上（否则 `apply()` 的资产同步会写真实用户目录）。
- `--import` 在 Windows 上**不接受裸绝对路径**（报 `ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'd:'`）⇒ 用相对路径或 `file:///…`。

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
