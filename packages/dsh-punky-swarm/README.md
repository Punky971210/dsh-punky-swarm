# dsh-punky-swarm

> **DeepSeek Harness（dsh）的集群治理插件 + 引擎** —— 把「大型模块开发」拆成 **plan → exec → audit** 三层 DAG，配 **门禁 / 状态机 / 黑板 / 结算**，让多成员协作**可派发、可审计、可恢复**。
> **版本基线：`0.5.0` = 新基线** —— 团队资产（`team-asset`）与 `chain` 声明面**已整体退役**；`team` 为**可选自由标签**（不解析、不校验、不拒建批）。
> **适用宿主**：`@deepseek-ai/dsh` **`0.2.x`**（宽声明；不钉具体 rc）。prerelease 宿主需在插件管理器里豁免。

---

## 一、这是什么

- **引擎面**：`wave_plan`（按依赖 DAG 分层为 waves，**建批后不中途重算**）→ `lane_dispatch` / `member_status`（派发）→ `handoff_submit`（逐边交接）→ `member_settle`（结算）；辅以 `gate_status`（门禁态）、`log_export`（事件导出）。`lane_heartbeat` / `lane_longrun` **已于 G3 B1 删除**（原属停维面：维护冻结、功能保留不续维，2026-10-09 用户裁定；现无工具入口，其事件面改由 `batch_status` / `log_export` 读取）。
- **治理纪律**：**27 条 / 9 组**（评估派发 / 批与交接 / 运行模式 / 审计验收 / 结算 / 恢复监管 / 输出·能力·指引 / 两方向·编号 / 执行前经验检索），细则见 `references/discipline.md`；Manager 侧通用定义见 `references/manager.md`。
- **它治的是什么**：一批 Agent 一起干活时的四类事故 —— 上游产物没齐就开工、跑几小时一崩全丢、几个成员同时写同一份文件、拦了却说不清为什么。工具本身没坏，缺的是流程上的闸口；闸口装进引擎后，纪律成为机器判据，而不是各成员的自觉。
- **`0.5.0` 新基线**：团队资产与 `chain` 声明面退役后，**装配按「引擎基线 + 成员槽位 + 指引」**；运行期 DAG 真源 = 批次 `lanes[].deps` + `handoffs`。

---

## 二、安装后得到什么（三面构成）

| 面 | 载体 | 落点 / 说明 |
|---|---|---|
| ① **插件**（核心） | `lib/**` + `cordis.patch.yml` **两行** | **引擎行** `dsh-punky-swarm`（状态机 / 面板 / HTTP / 门禁引擎；**不注册治理工具**）+ **preset 注册行** `dsh-agent-preset-punky`（0.1.7 起 preset **必须**由插件行注册，不再扫描预设目录）。<br>**治理工具**（27 件）由预设组合里的 `punky-provider` 行注册 ⇒ 只有 `punky-preset` 会话（含其派生 worker）在工具目录里看得到，其它模式零污染（装配隔离，2026-11-08） |
| ② **模式与指引**（核心） | `@deepseek-ai/dsh-agent-preset` 注册的 **`punky-preset`（蟛蜞模式）** | `references/discipline.md` / `references/manager.md` 由启动期 `syncAssets()` **幂等同步**到 `<home>/.dsh/.agent-presets/punky-preset/` |
| ③ **团队技能指针**（附加） | `skills/` **5 个目录** | `design-team` / `research-team` / `software-team` / `video-team` / `writing-team` ⇒ 同步落点 `<home>/.agents/skills/<name>/` |

> **能力层（software-team）**：`skills/software-team/references/engineering/spec-contract.md` 现为**蟛蜞适配层**（六态证据 → `gate_status`/`verdict` 映射 / `SUMMARY:` 机读行落地 / S-10 缺口留档）；**规格结构与机械规则原文以仓内 vendor 原件为准**（见下条），由 `SKILL.md` 的角色必读表按角色挂载。
> **外部能力层（已 vendor 进仓，recommend 语义不变）**：`SKILL.md` 同节收录外部 **SpecLang**（SpecArtisans）四技能 —— `speclang-waterfall` / `speclang-hoare-check` / `prd-guide` / `ui-component-registry`。**资产已 vendor 进仓**：`skills/software-team/references/vendor/speclang/`（**29 件** = **27 件上游资产** ＋ `LICENSE` ＋ `NOTICE.md`，合计 **532,898 B**；版本钉 `SpecLang@b3ee6ee`，逐件 sha256 见 `NOTICE.md`），读者**直接读仓内原件**、不依赖宿主是否装了同名技能。**vendor 不改变 recommend 语义**：仍按需加载、不进引擎装配面、不在册不构成失败、不影响任何门禁。源仓许可 **Apache-2.0 ＋ 运行时库例外**、署 **The Cangjie Project**、**权利人待确认**；配套 node 薄壳 `scripts/speclang-validate.mjs`（`ruby` 不可用时 `exit 2` ＝ 明示未取证，绝不伪造通过）。**角色级入口已接上**：`coder`/`designer`/`coordinator` 指向 `speclang-waterfall/`（＋`prd-guide/`），`reviewer`/`tester`/`supervisor` 指向 `speclang-hoare-check/`（涉 UI 追加 `ui-component-registry/`），各 1 行、标「选读（recommend）≠ 必读」；`doc-manager` 按 K-3 不挂。机检守护：6 个挂载角色**恰各 1 条**指针、路径**逐条 `existsSync`（死指针即红）**、同行必须 recommend 措辞。

---

## 三、安装（**唯一命令**）

**Step 1 —— 产出可分发包**（在包目录内执行）：

```bash
VERSION=$(node -p "require('./package.json').version")   # 版本号只从 package.json 取，文档不写死
pnpm pack                 # ⇒ dsh-punky-swarm-$VERSION.tgz
```

**Step 2 —— 唯一安装命令**（dev / 离线环境；干净 `DSH_HOME` 上一条命令装齐）：

上游两件包用**宽声明**（`0.2.x`，与宿主同线）：

```bash
dsh plugin --profile web add <ABSOLUTE_PATH>/dsh-punky-swarm-$VERSION.tgz \
  @deepseek-ai/dsh-experimental-agent-team-profile@0.2.x \
  @deepseek-ai/dsh-agent-preset@0.2.x
```

**三条要求**：

1. **两件上游包都要显式列出**：本包 `dependencies` 键已整体移除 ⇒ 上游包只由命令提供。
2. **用宽声明 `0.2.x`，不钉精确 rc**：精确 rc 会随宿主升级失效（semver 的 prerelease 规则跨 patch 不匹配）。
3. **显式列出 spec 不可省**：profile 的 `dsh.profile.bundles` 只登记新增的 top-level 依赖 ⇒ transitive 依赖不会成为 profile layer。

**补充说明**：

- `<ABSOLUTE_PATH>` 请用**绝对路径**（`dsh plugin` 以 `process.cwd()` 作为 pnpm 的 cwd，相对路径易踩）。
- 干净 `DSH_HOME` 上该命令会**自动初始化 `web` profile**，无需先手工建。

---

## 四、上游依赖 / 前置（两件显式 spec）

| 包 | 角色 | 声明位置 |
|---|---|---|
| `@deepseek-ai/dsh-experimental-agent-team-profile` | **聚合 bundle**：装它即带出 `-agent-team` / `-client-ui-agent-team` / `-tool-agent-team`（`spawn_teammate` / `team_task_*` / `send_message` / `wait_agent` / `list_agents` / `interrupt_agent` 工具面来源）| 仅命令显式列出 |
| `@deepseek-ai/dsh-agent-preset` | **模式注册插件本体**（`cordis.patch.yml` 的 `dsh-agent-preset-punky` 行以它为 `name`）| 仅命令显式列出 |

- **只要宿主装有 dsh 官方包即可用** —— 上游包只由安装命令的显式 spec 提供。
- **版本策略（宽声明）**：本包 `peerDependencies` 对 `@deepseek-ai/dsh-tools` 只保留 `0.2.x`，不钉任何具体 rc。
  - 标准 semver 下 `0.2.x` **不匹配** prerelease 宿主（如 `0.2.x-rc.y`）⇒ prerelease 宿主请在插件管理器里允许/豁免。
- **`workflow-ptc` 由内核提供**（`@deepseek-ai/dsh-base` 依赖它）⇒ 无需额外安装；**禁**自行回加旧推进器行（见 §九）。
- **`engines.dsh` 不落**：内核兼容门只读 `peerDependencies`（`@deepseek-ai/dsh*` 前缀），该字段零效力。
- **本包对团队服务的依赖声明**：引擎消费宿主服务 `agentTeams`，声明落在装配面（`cordis.patch.yml` 的探针行 `inject: [agentTeams]`），不进 `dependencies`。缺该服务时该行进入 pending（启动审计响亮），同级引擎行与模式行照常存活。

---

## 五、装完自证（三面只读自检）

```bash
node scripts/selfcheck-install.mjs --home <dir> --json    # exit 0 ⟺ engine / preset / skills 三面齐备
node scripts/smoke-install.mjs                            # 宿主级安装冒烟（含真实 home 污染守卫）
```

（两个脚本随包提供；冒烟会在**临时 `DSH_HOME` + 临时 home** 上装一次并断言三面。）

---

## 六、隔离测试步骤（**务必照抄**）

> ⚠ **关键事实**：`syncAssets()` 用 **`os.homedir()`**，且**不读 `DSH_HOME`**。
> ⇒ **只隔离 `DSH_HOME` 是不够的**：它仍会把同步结果写进**真实用户主目录**的 `~/.agents/skills/*` 与 `~/.dsh/.agent-presets/punky-preset/*`（= **覆写你既有资产**；同类事故在本仓有 **21 件**真实技能文件被覆写的前科）。
> ⇒ **必须同时隔离 `DSH_HOME` 与 `USERPROFILE` / `HOME`**，并加**真实 home 前后 sha256 守卫**。

### 6.1 Windows（PowerShell，逐行可抄）

```powershell
# 0) 记住真实 home —— 第 2 步会覆盖这些变量，第 5 步必须用 $Real 复算
$Real = $env:USERPROFILE
$Tmp  = Join-Path $env:TEMP ("punky-iso-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path "$Tmp\dsh-home","$Tmp\home" -Force | Out-Null

# 1) 真实 home 的 sha256 基线（只读；覆盖 skills 与 preset 两处）
Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue -Path "$Real\.agents\skills","$Real\.dsh\.agent-presets\punky-preset" | Get-FileHash -Algorithm SHA256 | Sort-Object Path | ForEach-Object { "$($_.Hash)  $($_.Path)" } | Set-Content "$Tmp\real-home.sha256.before"

# 2) 双变量隔离（缺一不可）
$env:DSH_HOME    = "$Tmp\dsh-home"
$env:USERPROFILE = "$Tmp\home"
$env:HOME        = "$Tmp\home"

# 3) 在本窗口内执行 §三 Step 2 的唯一命令（不要新开窗口，否则环境变量丢失）

# 4) 三面断言（示例，可自行加严）
dsh --profile web --dump-config | Select-String 'dsh-punky-swarm'
dsh --profile web --dump-config | Select-String 'dsh-agent-preset-punky'
Test-Path "$Tmp\home\.agents\skills\software-team\SKILL.md"
Test-Path "$Tmp\home\.dsh\.agent-presets\punky-preset\references\discipline.md"

# 5) 污染守卫：复算真实 home 并与基线比对 —— 输出为空才算通过
Get-ChildItem -Recurse -File -ErrorAction SilentlyContinue -Path "$Real\.agents\skills","$Real\.dsh\.agent-presets\punky-preset" | Get-FileHash -Algorithm SHA256 | Sort-Object Path | ForEach-Object { "$($_.Hash)  $($_.Path)" } | Set-Content "$Tmp\real-home.sha256.after"
Compare-Object (Get-Content "$Tmp\real-home.sha256.before") (Get-Content "$Tmp\real-home.sha256.after")
```

- **守卫判定**：`Compare-Object` **无输出** = 真实 home 未被触碰；**有输出 = FAIL** ⇒ **保留 `$Tmp` 现场**（勿删）并据差异清单排查。
- 测试结束后可删临时根：`Remove-Item -Recurse -Force $Tmp`（**仅在守卫通过后**）。

### 6.2 POSIX（macOS / Linux）

```bash
Real="$HOME"; Tmp="$(mktemp -d)"; mkdir -p "$Tmp/dsh-home" "$Tmp/home"
find "$Real/.agents/skills" "$Real/.dsh/.agent-presets/punky-preset" -type f 2>/dev/null | sort | xargs shasum -a 256 > "$Tmp/real-home.sha256.before"
export DSH_HOME="$Tmp/dsh-home" USERPROFILE="$Tmp/home" HOME="$Tmp/home"
# 在此 shell 内执行 §三 Step 2 的唯一命令
find "$Real/.agents/skills" "$Real/.dsh/.agent-presets/punky-preset" -type f 2>/dev/null | sort | xargs shasum -a 256 > "$Tmp/real-home.sha256.after"
diff "$Tmp/real-home.sha256.before" "$Tmp/real-home.sha256.after" && echo "GUARD OK" || echo "GUARD FAIL"
```

---

## 七、卸载 / 回滚

```bash
dsh plugin --profile web remove dsh-punky-swarm
```

或从 profile 的 `dsh.profile.bundles` 摘除本包后重启。团队包若不再需要，同法移除。

---

## 八、文档

| 文档 | 内容 |
|---|---|
| `references/discipline.md` | 治理纪律细则（码表 / 语义 / 边界 / 操作序列） |
| `references/manager.md` | Manager 通用定义（行为层） |
| `docs/engine-intro.md` | 引擎内部说明 |
| `skills/software-team/references/engineering/spec-contract.md` | software-team 能力层：**规格契约细则**（机械规则 / 六态证据 / 机读行 / 需求编号；SpecLang `b3ee6ee` 提炼引用，recommend 语义非装配） |

---

## 九、已知边界（如实）

- 安装失败**只落 stderr warning**（引擎按 **per-entry fail-soft**：本插件两行**都不在**必需启动清单内）⇒ 模式可能**静默未挂载**。**请用 §五 的自检脚本主动核**。
- 预设子项在**会话装配期**挂载（不经启动期审计）⇒ 某一子项异常**只影响该 preset 的 agent 组合**，同样只留 stderr。
- **版本策略**：宽声明 `0.2.x`；prerelease 宿主（`0.2.x-rc.y`）标准 semver 不匹配，需在插件管理器里豁免。
- **workflow 面**：`@deepseek-ai/dsh-workflow-ptc` 由内核提供，单行即可。**禁项**：① 禁回加旧推进器行（`@deepseek-ai/dsh-workflow-…` worker-thread 包，会新增必失败行）；② 禁新增 `!!js` 版本条件行（内核无宿主版本变量 ⇒ 条件行不可达）。
- **宿主升级后**：若插件行被兼容门跳过（stderr 出现 `skipping profile bundle`），检查 `peerDependencies` 宽声明是否仍覆盖宿主主版本，或在插件管理器里显式允许该版本。