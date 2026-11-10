# dsh-punky-swarm 一键安装（新引擎）

> 适用：DSH 0.2.x（kernel `0.2.x` 实测）｜Node >= 22｜pnpm
> 目标：把 `dsh-punky-swarm`（新引擎）装进一个独立 profile，**不碰你正在用的 profile**

---

## 一、三步安装（复制粘贴即可）

```powershell
# ① 定路径
$Profile = 'my-swarm'                                                    # 改成你要的 profile 名
$Engine  = 'D:/dsh/Punky-multi-agent-engine/packages/dsh-punky-swarm'    # 引擎源码目录（改成你的）

# ② 建 profile 目录 + 写 package.json（link: 指向源码，不下载、不依赖 registry）
$dir = "$env:USERPROFILE\.dsh\profiles\$Profile"
New-Item -ItemType Directory -Path $dir -Force | Out-Null
@{
  name = "dsh-profile-$Profile"
  private = $true
  dependencies = @{ 'dsh-punky-swarm' = "link:$Engine" }
  dsh = @{ profile = @{ bundles = @(
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-experimental-agent-team-profile',
    'dsh-punky-swarm'
  ) } }
} | ConvertTo-Json -Depth 8 | Set-Content "$dir\package.json" -Encoding UTF8
'[]' | Set-Content "$dir\cordis.yml" -Encoding UTF8

# ③ 装依赖（link: 零下载，秒级）
Push-Location $dir; pnpm install --prefer-offline; Pop-Location
```

**为什么用 `pnpm` 而不是 `npm`**：`link:` 是 **pnpm 协议**，`npm` 会报 `EUNSUPPORTEDPROTOCOL`。

**为什么 `link:` 而不是版本号**：引擎未发版；`link:` 让源码改动**立即生效**，且**不需要网络**。

---

## 二、验证装配

```powershell
# 绕过 dsh.ps1 包装直接跑 node（ps1 在 stderr 非空时会抛 NativeCommandError 并虚构报错位置）
$node = 'C:\Users\Administrator\AppData\Roaming\dsh-tauri\runtime\node.exe'   # 或你的 node
$bin  = 'D:\DSH\kernel\0.2.x\node_modules\@deepseek-ai\dsh\lib\bin.js'   # 或你的 kernel 路径
& $node $bin --profile my-swarm --dump-config 2>&1 | Select-String "^# ==|pending|dsh-punky-swarm"
```

**期望**：
- **3 个 bundle 包名全在**（`dsh-base` / `dsh-experimental-agent-team-profile` / `dsh-web-app`）
- **`pending` = 0**（或报出具名）
- **`dsh-punky-swarm` 出现 >= 1 次**

**⚠ 不要看 exit code** —— `--dump-config` 的退出码会被 patch warning 污染（首次装可能报 `patch: entry "web-ui-git-graph" not found`，那是**全局 patch 引用 desktop 独有 entry**，**不阻断**）。

---

## 三、启动

```powershell
# GUI（会打印带 token 的 URL）
dsh --profile my-swarm

# headless 跑一条（⚠ 需在启动环境里注入 key，headless 不自动读 .credentials.yaml）
$env:DEEPSEEK_API_KEY = '<your-key>'
dsh --profile my-swarm "跑一下测试"
```

---

## 四、要让 `lane_dispatch` 真派发，还需三处配置

装完只解决「引擎加载」，**要真派发 worker** 还要配 `dispatch` 段（**不配就只能发句柄**）：

**位置**：`~/.dsh/puny-preset/config/runtime.json`（**热更快照的真源**，不是 profile 的 `cordis.patch.yml`）

```json
{
  "dispatch": {
    "provider": "spawn",
    "agentPreset": "punky-preset",
    "presetCoverage": {
      "punky-preset": {
        "tools": ["read", "glob", "grep", "pwsh", "skill", "write"]
      }
    }
  }
}
```

**三处缺一不可**：

| 字段 | 缺了会怎样 |
|---|---|
| **`provider`** | 走 `dispatch.js:1237` 降级分支（`mode:'degraded'`，仅发句柄）|
| **`agentPreset`** | `dispatch.js:1171` 返回 `mode:'rejected'`（收窄不可核）|
| **`presetCoverage[<id>].tools`** | `presetFor` 返回**裸字符串** ⇒ 无见证 ⇒ 拒派 |

**⚠ 语义（2026-11-10 裁决固化）：`presetCoverage[<presetId>].tools` 是「收窄见证」。**

它是**收窄见证清单（witness）**，唯一用途 = 让派发面核对「本次要禁的工具是否落在该 preset 声称的覆盖面内」：

- **不定义成员工具面** —— 成员实际可见工具 = **preset 组合面产出 − deny 单据**（`SUITE_DENY_TOOLS` ∪ `config.dispatch.denyTools`）；
- **不参与** `toolFilter` 的构造（真正落地的是 deny 集；本键只喂「本次收窄是否可核」这一个判据）；
- **不是白名单**，也不裁剪 preset 组合面（组合面由 `cordis.patch.yml` / `agent.cordis.yml` 决定）。

⇒ **见证 ≠ 白名单**。它只有三条约束（均已实现）：① **非空**（空集与任何集交集恒空 ⇒ 判据退化为恒真 ⇒ 拒派）；
② 与本次 `deny` 集**不相交**（任一命中 ⇒ 判「解析不出可用 preset」⇒ 拒派）；
③ **不得**为「让门过」而把它缩成某个角色的 `tools.allow` 值（那是**意图声明**，不是工具面事实）。

**填法**：写该 preset 组合面**实际可能产出**的工具名集合即可；**禁止**把它当工具面清单维护。
（上文 JSON 里的 6 件只是见证**示例值**，不是成员工具面枚举 —— 别抄成「成员只有这 6 件」。）
role 侧自 2026-11-10 起**不再**用 `tools.allow` 反推 deny 补集（`tools.deny_derived` 缺省 `false`），
故「初配见证被拒」的旧机型（`edit` 落进 `deny` 之类）已不复存在。

---

## 五、已知坑（每条都实测撞过）

| # | 坑 | 解法 |
|---|---|---|
| **1** | `npm install` 报 `EUNSUPPORTEDPROTOCOL: link:` | **用 pnpm** |
| **2** | `pnpm install` 因网络失败（`UND_ERR_DESTROYED`）| **`@deepseek-ai/*` 那 305 个包在 kernel 自带** ⇒ profile 只需装 `link:` 那个，用 `--prefer-offline` |
| **3** | `--dump-config` exit code = 1 | **正常**（patch warning 污染）；**看输出内容不看退出码** |
| **4** | `dsh.ps1` 报 `app-boot/index.js:4000` | **假象**（ps1 在 stderr 非空时抛 `NativeCommandError`）⇒ **绕过 ps1 直接跑 `node bin.js`** |
| **5** | headless 报 `MISSING_CREDENTIAL` | **headless 不读 `~/.dsh/.credentials.yaml`** ⇒ 需 `$env:DEEPSEEK_API_KEY` |
| **6** | `cordis.patch.yml` 报 `patch: entry "xxx" not found` | 该 profile 缺那个 entry ⇒ **改 `- insert:` + 缩进列表**（不是「`name` 无 `id`」）|
| **7** | 工具目录里**没有** `wave_plan` / `member_settle` 等治理工具 | 治理工具自 2026-11-08 起**只在 `punky-preset` 组合里注册**（装配隔离）⇒ ① 确认 `dsh-agent-preset-punky` 行在场（`preset` 未注册则整组工具不存在）；② 会话确实选用 `punky-preset`；③ 若 preset 行显示 pending，查它等的服务 `punkySwarmTools`（需引擎行 `dsh-punky-swarm` 先装载）。<br>**旧症状**（`wave_plan` 在册但报 `GATE_MODE_INACTIVE`）仍可能出现在把 preset id 改名的场景：此时把新 id 加进 `modes.gate`。 |
| **8** | 新建 profile 前端报「无法保存确认状态」 | **onboarding 依赖的插件生态缺失**（desktop 有 31 bundle + 6 目录）⇒ **建议用 `desktop` 的 bundles 全集而非最小集**，或直接用 `smoke-engine`（headless）|

---

## 六、最小可用清单（复制即用）

| 场景 | 需要 |
|---|---|
| **只想验证引擎能加载** | 三步安装 + `--dump-config` |
| **想跑 GUI** | 三步 + **bundles 加 `@deepseek-ai/dsh-web-app`**（已在上面）|
| **想跑 headless 真 LLM** | 三步 + `$env:DEEPSEEK_API_KEY` |
| **想让 `lane_dispatch` 真派发** | 上一行 + `runtime.json` 的 `dispatch` 三配置 |
| **想验三层门禁全链路** | 上一行 + **GUI profile**（headless 的 worker 生命周期 < 主进程，S-6 后半段验不了）|
