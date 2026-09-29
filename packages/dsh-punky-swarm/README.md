# dsh-punky-swarm

> **DeepSeek Harness（dsh）的集群治理插件 + 引擎** —— 把「大型模块开发」拆成 **plan → exec → audit** 三层 DAG，配 **门禁 / 状态机 / 黑板 / 结算**，让多成员协作**可派发、可审计、可恢复**。
> **版本基线：`0.5.0` = 新基线** —— 团队资产（`team-asset`）与 `chain` 声明面**已整体退役**；`team` 为**可选自由标签**（不解析、不校验、不拒建批）。
> **适用宿主（双线）**：`@deepseek-ai/dsh` **`0.1.7-rc.2`** ／ **`0.2.0-rc.1`** —— 双线支持矩阵与**各自的上游版本钉法**见 **§3.2**。

---

## 一、这是什么

- **引擎面**：`wave_plan`（按依赖 DAG 分层为 waves，**建批后不中途重算**）→ `lane_dispatch` / `member_status`（派发）→ `handoff_submit`（逐边交接）→ `member_settle`（结算）；辅以 `gate_status`（门禁态）、`log_export`（事件导出）、`lane_heartbeat` / `lane_longrun`（监管）。
- **治理纪律**：24 条（难度路由 / 三层门禁 / 交接与批 / 运行模式 / 审计验收 / 恢复监管 / 输出与指引 / 两方向规格），细则见 `references/discipline.md`；Manager 侧通用定义见 `references/manager.md`。
- **`0.5.0` 新基线**：团队资产与 `chain` 声明面退役后，**装配按「引擎基线 + 成员槽位 + 指引」**；运行期 DAG 真源 = 批次 `lanes[].deps` + `handoffs`。

---

## 二、安装后得到什么（三面构成）

| 面 | 载体 | 落点 / 说明 |
|---|---|---|
| ① **插件**（核心） | `lib/**` + `cordis.patch.yml` **两行** | **引擎行** `dsh-punky-swarm`（治理工具 + 面板）+ **preset 注册行** `dsh-agent-preset-punky`（0.1.7 起 preset **必须**由插件行注册，不再扫描预设目录） |
| ② **模式与指引**（核心） | `@deepseek-ai/dsh-agent-preset` 注册的 **`punky-preset`（蟛蜞模式）** | `references/discipline.md` / `references/manager.md` 由启动期 `syncAssets()` **幂等同步**到 `<home>/.dsh/.agent-presets/punky-preset/` |
| ③ **团队技能指针**（附加） | `skills/` **8 个目录** | `acceptance-gate` / `design-team` / `engine-team` / `research-team` / `retro-and-memory` / `review-execution` / `software-team` / `writing-team` ⇒ 同步落点 `<home>/.agents/skills/<name>/` |

---

## 三、安装（**唯一命令**）

**Step 1 —— 产出可分发包**（在包目录内执行）：

```bash
pnpm pack                 # ⇒ dsh-punky-swarm-0.5.0.tgz
```

**Step 2 —— 唯一安装命令**（dev / 离线环境；干净 `DSH_HOME` 上一条命令装齐）：

先取**宿主 rc**（下文记作 `<HOST_RC>`；本机示例值 `0.1.7-rc.1`，请以你的宿主实际输出为准）：

```bash
dsh --version
```

```bash
dsh plugin --profile web add <ABSOLUTE_PATH>/dsh-punky-swarm-0.5.0.tgz @deepseek-ai/dsh-experimental-agent-team-profile@<HOST_RC> @deepseek-ai/dsh-agent-preset@<HOST_RC>
```

**三条硬要求（不要省）**：

1. **两件上游包都要显式列出，且都钉「宿主同 rc」**：`<HOST_RC>` 取自上面的 `dsh --version`（例：宿主 `0.1.7-rc.1` ⇒ 两处都写 `@0.1.7-rc.1`）。**为什么不写 caret、也不能固定写 `rc.2`** —— 见 §3.1（写错的后果是**模式面无声消失**）。
2. **禁裸 spec、禁标签式 spec**：无版本会被兼容门**直接拒装**（原因见 §四 的 `latest` 陷阱）；而用 dist-tag（标签）代替版本号会**随上游发布静默换线**（`next` 现已指向新线）⇒ **一律把 `<HOST_RC>` 写成精确版本**（形如 `0.1.7-rc.2` / `0.2.0-rc.1`）。
3. **显式列出 spec 不可省**：本包 `dependencies` 键**已整体移除** ⇒ 上游包**只由安装命令提供**（本包**不再携带**任何上游版本范围）；而 profile 的 `dsh.profile.bundles` **只登记新增的 top-level 依赖** ⇒ **transitive 依赖不会成为 profile layer** ⇒ 命令里**必须**把包名 + 版本写全。

### 3.1 为什么必须钉「宿主同 rc」（**别写 caret，也别固定 `rc.2`**）

- **① prerelease caret 会静默浮版**：`^0.1.7-rc.1` 的语义**包含** `0.1.7-rc.2`，且包管理器取**最高满足版** ⇒ 你以为装的是 rc.1，实际落 **rc.2**。**依赖声明层无法表达「宿主同 rc」** —— 这是把该约束放在**命令**里的根本原因。
- **② 模式注册包与宿主 registry 精确强耦合**：`@deepseek-ai/dsh-agent-preset@0.1.7-rc.2` 的 `peerDependencies` 精确钉 `@deepseek-ai/dsh-agent-preset-registry@0.1.7-rc.2`，而 rc.1 宿主上实装的是 `…-preset-registry@0.1.7-rc.1` ⇒ **版本不符** ⇒ 引擎在启动期 **行级禁用**三行：`preset-minimal` / `preset-cordis` / **`dsh-agent-preset-punky`** ⇒ **模式面无声消失**（引擎按 per-entry fail-soft：进程照起，只往 stderr 落一行 `disabling profile plugin row …`，**界面无提示**）。
- **③ 固定写 `rc.2` 同样错**：宿主是 rc.1 时钉 rc.2 = 必现上面那条链；宿主是 rc.2 时钉 rc.1 亦同 ⇒ **唯一自洽写法 = 按 `dsh --version` 取宿主 rc，两件上游包都钉它**（「四件同 rc」由此才成立）。
- **④ 本包 `dependencies` 中已不再有任何 `-profile` 声明**（该键**整体移除** ⇒ 由**命令独占**，**根治「双族共存」**），**更不是**「免列 spec」的理由（见第 3 条）；`@deepseek-ai/dsh-agent-preset` 同样**不在** `dependencies` 中 —— 正因上述浮版链（它的 peer 与宿主 registry 强耦合）。

**补充说明**：

- `<ABSOLUTE_PATH>` 请用**绝对路径**（`dsh plugin` 以 `process.cwd()` 作为 pnpm 的 cwd，相对路径易踩）。
- 干净 `DSH_HOME` 上该命令会**自动初始化 `web` profile**，无需先手工建。

### 3.2 双线支持矩阵（宿主 × 上游版本钉法）

| 宿主线 | 支持 | 命令里两件 spec 的**精确后缀** | 安装命令形态 | 已证 / 未证边界 |
|---|---|---|---|---|
| **旧线** `0.1.7-rc.2` | **✓** | `@deepseek-ai/dsh-experimental-agent-team-profile@0.1.7-rc.2` ＋ `@deepseek-ai/dsh-agent-preset@0.1.7-rc.2` | **仍是同一条唯一命令**（§三 Step 2）：把两处 `<HOST_RC>` 替换为 `0.1.7-rc.2` | **已证（解析层 + 运行面）**：上游包**只由命令提供**（本包 `dependencies` 键已整体移除）；**解析层三探针** `distinct=1` —— 新线（`0.2.0-rc.1`）与旧线（`0.1.7-rc.2`）各一次，且**不传 spec 时四包 0 命中**（「双族共存」的**必要条件已消除**）；`peerDependencies` 的 `@deepseek-ai/dsh-*` 范围**三版全通过**（内核兼容门只读它）；workflow 行**单行同名同构**（双副本一致性机检在役）。**已实跑**：旧线 `0.1.7-rc.2` 用**真实隔离实例** `D:\dsh\iso-0.1.7-rc.2`（真 rc.2 内核）跑通，**3/3 GREEN**、三面 / workflow / 端口 / 哨兵全达标；**未覆盖项 = 真实既有 profile 的就地 boot**（读数见批次产物 `exec/verify-fix.md`，**该结论尚未落地 ⇒ 登记为待复核**，见 §九） |
| **新线** `0.2.0-rc.1` | **✓** | `@deepseek-ai/dsh-experimental-agent-team-profile@0.2.0-rc.1` ＋ `@deepseek-ai/dsh-agent-preset@0.2.0-rc.1` | 同上：替换为 `0.2.0-rc.1` | **已证（解析层）**：上游包**只由命令提供**（同上）；解析层探针**新线 `distinct=1`**（改动前并集范围下**同一 lock 含两族**，**负例留档**）；本机有隔离载体 `D:\dsh\iso-0.2.0-rc.1`。**运行面**：批 6 曾观测**安装层非确定性**（同一输入 9 跑 6 红：**形态 A** 三件子包恰一件落旧线 ⇒ 行被静默停用；**形态 B** 安装整体 `status=1`）；本批已**从解析层消除形态 A 的必要条件**，**形态 B 属环境 / 包管理器侧、本批不承诺修复**（只要求**响亮失败**）⇒ 两线运行面复验读数见 `exec/verify-fix.md`（**待复核**） |
| 参考 · `0.1.7-rc.1` | ⚪ **非目标线** | 同上（钉 `0.1.7-rc.1`） | 同上 | 仅作**旧线等价代表**（本机 CLI 实装）；**不是**本支持矩阵的目标行 —— **以 `0.1.7-rc.2` / `0.2.0-rc.1` 两行为准** |

> **共同前置**：`@deepseek-ai/dsh-workflow-ptc` 由**内核**提供（`0.1.7-rc.1` / `0.1.7-rc.2` / `0.2.0-rc.1` **三版内核全部**依赖它）⇒ **无需**用户额外安装（见 §四）。
> **声明面口径**：本表 = **人读声明面**；**机读声明面** = 本包 `peerDependencies` 中 `@deepseek-ai/dsh-*` 条目的范围（内核兼容门**只读它**，**本批未改动**）。**上游包不由本包提供**：本包 `dependencies` 键**已整体移除** ⇒ 上游包**只由安装命令的显式 spec 提供**（`<HOST_RC>`）。**本包内不存在、也不应有** `compatibility.json` —— 该文件名在 DSH 中**专指 profile 级豁免表**（落点是 profile 目录），包内放它**无消费者**。

---

## 四、上游依赖 / 前置（两件显式 spec）

安装命令里的**两件上游包**（见 §三）各自身份与声明位置：

| 包 | 角色 | 声明位置 |
|---|---|---|
| `@deepseek-ai/dsh-experimental-agent-team-profile` | **聚合 bundle**：装它即带出 `-agent-team` / `-client-ui-agent-team` / `-tool-agent-team`（`spawn_teammate` / `team_task_*` / `send_message` / `wait_agent` / `list_agents` / `interrupt_agent` **工具面的来源**） | **仅命令显式列出**（**不再进 `dependencies`** —— 该键已整体移除，由命令独占） |
| `@deepseek-ai/dsh-agent-preset` | **模式注册插件本体**（`cordis.patch.yml` 的 `dsh-agent-preset-punky` 行以它为 `name`）—— 缺它 ⇒ 面② **静默消失** | **仅命令显式列出**（**已从 `dependencies` 摘出**：prerelease caret 会浮到最高 rc，而它的 peer 与宿主 registry **精确强耦合** ⇒ 浮版即触发行级禁用；详见 §3.1） |

- **只要宿主装有 dsh 官方包即可用** —— 无需再单独手工安装（命令已含 spec）。
- ⚠ **`latest` 陷阱（硬）**：该团队包 `dist-tags.latest = 0.1.5-alpha.2`，与 `0.1.7` 线**不兼容** ⇒ **裸装（不带版本/标签）会被兼容门直接拒**（引擎口径：`an incompatible version is never installed`）。`@deepseek-ai/dsh-agent-preset` 的 `latest = 0.1.7-alpha.1` 同理。
- **四件同 rc**：四件（两件显式 spec + `-profile` 带出的子件）应落在**同一条 rc 线**（= 宿主 rc，形如 `0.1.7-rc.x` / `0.2.0-rc.x`），**请勿混用不同 rc**。
- **`workflow-ptc` 由内核提供（两线同源 ⇒ 无需额外装）**：`@deepseek-ai/dsh-base` 在 `0.1.7-rc.1` / `0.1.7-rc.2` / `0.2.0-rc.1` **三版全部**依赖 `@deepseek-ai/dsh-workflow-ptc` ⇒ 用户**不必**安装任何 workflow 相关包，**也禁**自行回加旧推进器行（见 §九 禁项）。
- **适配声明的两个面**：**机读** = 上方 `peerDependencies` 中 `@deepseek-ai/dsh-*` 条目的范围（内核兼容门**唯一**判据面，三版全通过）；**人读** = §3.2 双线支持矩阵。⇒ **不引入任何包内新声明件**（无 `compatibility.json`、无自创字段 —— 二者内核**都不读**）。

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

---

## 九、已知边界（如实）

- 安装失败**只落 stderr warning**（引擎按 **per-entry fail-soft**：本插件两行**都不在**必需启动清单内）⇒ 模式可能**静默未挂载**。**请用 §五 的自检脚本主动核**。
- 预设子项在**会话装配期**挂载（不经启动期审计）⇒ 某一子项异常**只影响该 preset 的 agent 组合**，同样只留 stderr。
- `latest` tag 与 `0.1.7` 线不兼容（§四）⇒ **永远显式钉版本**。
- **workflow 面「单行两线通吃」的依据与禁项**：依据 = `0.1.7-rc.1` / `0.1.7-rc.2` / `0.2.0-rc.1` **三版内核全部**依赖 `@deepseek-ai/dsh-workflow-ptc` ⇒ **单行即双线正解**。**禁项**：① **禁**回加旧推进器行（`@deepseek-ai/dsh-workflow-…` 的 **worker-thread** 包）—— 会在两线之一**新增必失败行**，且旧线存在**双挂载**风险；② **禁**新增 `!!js` **版本条件行** —— 内核**无**宿主版本变量 ⇒ 条件行**不可达**，写错即制造新 warning。
- **旧线已实跑（覆盖损失收敛为一项）**：旧线 `0.1.7-rc.2` 已用**真实隔离实例** `D:\dsh\iso-0.1.7-rc.2` 跑通（**3/3 GREEN**，三面 / workflow / 端口 / 哨兵全达标）；**未覆盖项 = 真实既有 profile 的就地 boot**（隔离实例覆盖 ≠ 在役 profile 就地升级；运行面复验读数见批次产物 `exec/verify-fix.md` —— **该结论尚未落地 ⇒ 登记为待复核**）。
- **新线安装层非确定性（批 6 发现 / 本批修复）**：新线**同一输入曾 9 跑 6 红** —— **形态 A**（三件子包恰一件落旧线 ⇒ 对应行被**静默停用**）与 **形态 B**（安装整体 `status=1`）；本批已**从解析层消除形态 A 的必要条件**（本包不再声明上游范围 ⇒ 新线宿主上**没有旧版本可回退**），**形态 B 属环境 / 包管理器侧、本批不承诺修复**（只要求 `status=1` + 诊断落盘的**响亮失败**）⇒ 两线运行面读数归 `exec/verify-fix.md`（待复核）。
- **标签式 spec 会静默换线**（§3.2 / §四）：`latest` 与 dist-tag（如 `next`）都可能指向**非目标线**版本 ⇒ **永远写精确版本**。
