# 集成声明：comfyui-glue（外部插件子模块关系）

> 本文档声明 dsh-punky-swarm 与外部插件 **comfyui-glue** 之间的「子模块」关系：它是什么、边界在哪、怎么装、怎么验、怎么退。
> English: [comfyui-glue.en.md](comfyui-glue.en.md)

## 1. 关系定义

子模块（sub-module）在本仓的工程定义是**一句话**：

> 子模块 = **一份写死的声明契约 + 一条运行时联动判据**，落在本仓内；对方仓的物理位置、构建链、发布节奏完全不变，本仓对它**零模块依赖、零构建期接触**，两者唯一耦合点是**宿主（dsh）的工具面**。

四个「不」（C 形态的边界本体）：

| # | 不做什么 | 含义 |
|---|---|---|
| 1 | **不搬目录** | comfyui-glue 继续住它自己的仓（本机活动件：`D:\Project\comfyui-glue`），独立演进、独立发版 |
| 2 | **不建模块边** | 本仓不 `import` 它，也不写入 `dependencies` / `peerDependencies` / `optionalDependencies` |
| 3 | **不建挂载行** | 本仓的 `cordis.patch.yml` **不新增** comfyui-glue 的 `insert` 行（见 §5） |
| 4 | **不改对方仓库** | 本仓不写 comfyui-glue 的任何文件（含其 `package.json`） |

## 2. 工具面即接口（4 条能力名，逐字）

联动接口**不是**本仓新增的代码，而是宿主已提供的工具面。本仓只声明**能力名集合**与**判定语义**：

| # | 工具名（逐字，大小写敏感） | 作用 |
|---|---|---|
| 1 | `comfy_probe` | 探测 ComfyUI 后端可达性与版本/底模清单 |
| 2 | `comfy_object_info` | 读取 ComfyUI 节点对象信息（object_info） |
| 3 | `comfy_run` | 提交一次工作流执行 |
| 4 | `comfy_fetch_output` | 取回执行产物 |

探测原语由宿主提供（公开、只读、零副作用），本仓**不新增探测工具、不新增探测函数模块、不改既有路由 payload**。

## 3. 判定语义（写死）

- 能力名集合 = 上表 **4 条，逐字，大小写敏感**。
- `available = true` ⟺ 上述 4 名**全部**在册；缺任一 ⇒ `partial` + 缺失清单；0 条 ⇒ `absent`。
- 探测**只读名字集合**：不读实现、不执行工具、不注册、不写盘、不改路由与工具数。

运行时可得「4 工具在册」的三条路径（按强度排序）：

1. **可调用性（最强，宿主级真证据）**：直接调用 `comfy_probe` —— 未注册得到 `UNKNOWN_TOOL`，注册则得到结构化返回。
2. **可见性（模型面）**：工具列表对模型可见 ⇒ 派发前即可知。
3. **程序内判定（供将来编排消费）**：对宿主工具目录按 `` `comfy_` `` 前缀过滤。

> ComfyUI 后端（默认 `127.0.0.1:8188`）未监听时，`comfy_probe` 返回 `ready:false` + `error.code` —— 这**也是**「工具在册」的证据（工具跑起来了，只是后端服务没起）。

## 4. 依赖声明方式

| 面 | 裁定 |
|---|---|
| 本仓 `package.json` | **零依赖边**：不写 comfyui-glue 的 `dependencies` / `peerDependencies` / `optionalDependencies` |
| 部署面（profile） | `link:` 依赖留在 profile（部署期解析机制，不进包内元数据） |
| 文档 + 守卫测试 | 本文件（声明）+ `test/integration-comfyui-glue.test.js`（把声明变成可执行断言） |

理由：本仓消费的是**工具名**而不是**模块**，peer 语义不成立；且对方包未发布 npm ⇒ 任何版本范围都是悬空边，写进公开发布包的元数据会污染面不可逆。

## 5. 挂载前提（insert 行**留在 profile patch**）

comfyui-glue **未声明 `dsh.bundle`** ⇒ `dsh plugin add` 只会把它装成**普通依赖**，不会自动进 bundle 层栈；**patch 的 `insert` 行是它进入装载树的唯一途径**。

**该 `insert` 行归 profile patch（部署面），不得迁进本仓的 bundle patch。** 原因：

- 本仓 `cordis.patch.yml` 在**包内**（随包发布），profile patch 在**用户机器**（本批外部件）；两者无法在同一原子变更里完成，中间态必然出现同一 `id` 的两条 `insert` ⇒ loader 抛 `duplicate loader entry id: comfyui-glue` ⇒ **整站启动失败**。
- `insert` 行的 `name` 是部署期解析（先从安装解析、再从 profile 目录解析），comfyui-glue 只存在于 profile `node_modules`；写进公开发布包的 patch 等于让其他机器也去 insert 一个未发布包。

**跨形态判据（防漂移）**：comfyui-glue 的 `insert` 行**全局唯一** —— 合成配置树中 `- id: comfyui-glue` 必须**恰好 1 次**。发现计数 > 1 立即停止并上报。

## 6. 安装与卸载

安装四步（顺序不可换）：

1. **备份** profile patch：`cordis.patch.yml` → `cordis.patch.yml.bak-<yyyymmdd-HHMMSS>`。
2. **profile 依赖**：`dsh plugin --profile web add link:D:\Project\comfyui-glue`
   —— 注意：该包无 `dsh.bundle`，此步只装成普通依赖并 warn「declares no dsh.bundle」，**不会**自动进层栈。
3. **profile patch 追加唯一 insert 行**（`id` / `name` 均为 `comfyui-glue`）；写前先 grep 确认无同 `id` 残留。
   —— **这一步不在本仓做，也不在本仓的 `cordis.patch.yml` 做**。
4. **重启 dsh web**（用户动作）后冒烟：启动日志无 `duplicate loader entry id` / 无 `tool "..." is already registered`；再真调用 `comfy_probe`。

卸载 = 逆序：删除 profile patch 的 insert 行 → `dsh plugin --profile web remove comfyui-glue` → 重启。

本仓**不新增安装脚本**（官方 `dsh plugin` 已是入口；且本仓 `files` 白名单不含 `scripts/` 之外的可执行约定，自造脚本只增加写用户 profile 的风险面）。

## 7. 与跨版本前置（C1/C2）的边界

- comfyui-glue 的**两条 peer**（宿主运行时包）的区间同步更新责任**不归本仓**，归**部署面/跨版本前置**那条工作线；本仓**不同步更新、不触碰、不代改**。
- 本仓对 profile 的 `dsh.profile.bundles`、profile patch、内核安装目录一律**只读**。
- 本仓若在实现中发现「必须改 profile 或改对方仓的 peer，声明才成立」⇒ **停止并上报**，不得跨域开写。

## 8. 解耦规则（R1–R4，硬约束）

目标：在对方仓**不可达**（被移走/重命名/换机器）时，本仓 `install` / `check` / `build` / `test` **仍全部成功**。

- **R1 零模块引用**：`lib/`、`test/`、`scripts/` 内不得出现任何形式的跨仓模块或路径引用（`import`/`require`/动态 `import`）。能力名只允许以**字符串字面量**出现。`docs/` 可提及路径（文档不是引用），但不得给出可复制的 import 语句。
- **R2 零构建输入耦合**：`tsconfig.json.include`、`tsconfig.build.json.rootDir`、回拷脚本的回拷清单、`package.json.files` 内不得出现本包外路径（`../` 或绝对路径）；回拷清单保持**硬编码数组**形态，**禁止引入 glob**（glob 会把未来的外部产物意外纳入构建）。
- **R3 零测试耦合**：新增测试不得 import 对方模块、不得连 ComfyUI 端口、不得读对方仓路径（唯一例外：对**本仓自身**文件做静态扫描）。
- **R4 零安装耦合**：本仓 `package.json` 不新增 comfyui-glue 的任何依赖边。

## 9. 证据命令（3 条，只读）

```powershell
# E1 挂载在册且唯一（只读，不起服务、不占端口）
dsh --profile web --dump-config | Select-String -Pattern '^\s*- id: comfyui-glue\s*$'      # 期望：恰好 1 行

# E2 本仓的 bundle patch 未新增该 insert（防 duplicate id）
Select-String -Path 'D:\dsh\Punky-plugin\packages\dsh-punky-swarm\cordis.patch.yml' -Pattern 'comfyui-glue'   # 期望：0 命中

# E3 profile 侧 link 依赖在位
(Get-Item 'C:\Users\Administrator\.dsh\profiles\web\node_modules\comfyui-glue').LinkTarget   # 期望：D:\Project\comfyui-glue
```

解耦自证（本仓内闭环）：

```powershell
npm run check; npm run build; npm test                       # 三条 exit 0
Test-Path .\node_modules\comfyui-glue                        # 期望：False
Get-ChildItem lib,test,scripts -Recurse -File |
  Select-String -Pattern 'comfyui-glue' -Encoding UTF8       # 期望：0 命中（守卫测试内的白名单字符串除外）
```

## 10. 回滚

| 面 | 动作 |
|---|---|
| 本仓声明 | 删除新增的 2 份文档 + 1 个守卫测试；`package.json` 的 `files` 白名单移除对应两条（或按改前备份还原） |
| profile | 用同目录 `cordis.patch.yml.bak-*` 还原，或按快照镜像还原；**需重启生效**；**禁止删除**既有 `.bak-*` |
| 对方仓 peer | 单文件回滚，与 profile link 变更**同批**执行，避免中间态 |

## 11. 停止条件（命中即停、还原、上报；不自行补救、不降级）

| ID | 条件 |
|---|---|
| S1 | 本仓 `check` / `build` / `test` 任一失败且无法在合理时间内定位 ⇒ 回滚，上报 |
| S2 | 发现「必须改 profile（含 insert 行）声明才成立」⇒ 停在该边界，上报 |
| S3 | 发现「必须改对方仓的 peer（或任何对方仓文件）声明才成立」⇒ 停，上报 |
| S4 | 合成配置树中 `- id: comfyui-glue` 计数 > 1，或被要求在本仓 patch 新增该 insert 行 ⇒ 立即停（会导致整站启动失败） |
| S5 | 任何需要**重启 dsh / 占用 3080 / 启停 ComfyUI** 才能继续的动作 ⇒ 不做，转人工待办 |
