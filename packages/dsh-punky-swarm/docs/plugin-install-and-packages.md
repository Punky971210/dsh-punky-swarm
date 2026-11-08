# 一键安装与分子包架构（设计）

> 2026-11-05 ｜ 基于**实测**（DSH kernel `0.2.x`）
> 前作 `docs/install.md` 是「建 profile + link」的手工路径；**本文是插件管理器一键安装 + 分子包架构**

---

## 一、已实测：一键安装**真的是一键**

```powershell
# ① 打包（引擎仓 packages/dsh-punky-swarm 下）
pnpm pack --pack-destination "$env:TEMP"
#   → dsh-punky-swarm-0.5.6.tgz

# ② 一键装（dsh plugin = 把参数透传给 profile 目录里的 pnpm）
dsh plugin --profile <name> add <tgz 路径>
#   → + dsh-punky-swarm file:.../dsh-punky-swarm-0.5.6.tgz
#   → Done in 950ms
```

**`dsh plugin add` 自动做了三件事**（实测 `plugin-test` profile）：

| # | 动作 | 实测结果 |
|---|---|---|
| **1** | 初始化 profile（`package.json` + `cordis.yml`）| ✅ |
| **2** | 加 `dependencies` | ✅ `"dsh-punky-swarm": "file:...tgz"` |
| **3** | **加 `dsh.profile.bundles`** | ✅ `["@deepseek-ai/dsh-base", "dsh-punky-swarm"]` |

**装配验证**（`--dump-config`）：
```yaml
# == dsh-punky-swarm          ← 引擎作为 bundle 层加载
- id: dsh-punky-swarm
  name: dsh-punky-swarm
```

**⇒ 所以「一键安装」的核心机制**：**`dsh plugin add <包>` 只要该包的 `package.json` 有 `dsh.bundle.patch`，就会被自动加进 `bundles` 并作为 bundle 层加载。**

**引擎包已具备的条件**（`packages/dsh-punky-swarm/package.json`）：
```json
"files": ["lib","presets","skills","cordis.patch.yml","puncat.jpg","LICENSE","README.md","CHANGELOG.md","scripts","!scripts/audit/out"],
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "inject": ["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-conversation"], "platform": "web" }
},
"peerDependencies": {
  "@deepseek-ai/cordis": "^4.0.1",
  "@deepseek-ai/dsh-tools": "0.2.x"
},
"peerDependenciesMeta": {
  "@deepseek-ai/dsh-tools": { "optional": true }
},
"devDependencies": {
  "@deepseek-ai/dsh-app-boot": "^0.2.2-rc.1",
  "@deepseek-ai/dsh-scope": "^0.2.2-rc.1",
  "@deepseek-ai/dsh-tools": "^0.2.2-rc.1"
}
```

> **为什么 peer 宽、dev 窄**（2026-11-08 实测）：`@deepseek-ai/dsh-*` 在 registry 上**零个稳定版**，
> 标准 semver 的 `0.2.x` 一个预发布版也匹配不到（`npm view '@deepseek-ai/dsh-tools@0.2.x' version`
> ⇒ `could not be found`）⇒ **安装面**（`devDependencies`）必须给可解析的 rc 下界，否则 `npm ci` 必失败；
> **声明面**（`peerDependencies`）保持宽声明表达「宿主需在 0.2 线」，并用
> `peerDependenciesMeta.optional` 让 npm 7+ 不把它当安装闸。

---

## 二、已实测：一键安装的**两个缺口**

### 缺口 1：上游 bundle 不会被自动加入

`dsh plugin add dsh-punky-swarm` 后的 `bundles` 只有：
```json
["@deepseek-ai/dsh-base", "dsh-punky-swarm"]
```

**缺两项**（缺了功能就残）：
| 缺什么 | 后果 |
|---|---|
| `@deepseek-ai/dsh-web-app` | **无 GUI**（只能 headless）|
| `@deepseek-ai/dsh-experimental-agent-team-profile` | **`agentTeams` 服务不可用** ⇒ `lane_dispatch` 的 D 通道拿不到 |

**根因**：`dsh plugin add` 只把**被 add 的那个包**加进 `bundles`，**不递归加它的 `dependencies`**。

### 缺口 2：peerDependencies 未满足时只 WARN 不阻断

```
[WARN] Issues with peer dependencies found
+ dsh-punky-swarm ...
Done in 950ms
[exit code: 1]
```

**⇒ 包装进去了**（`+ dsh-punky-swarm`），**但 exit code = 1** ⇒ **自动化脚本会把「成功」判成失败。**

**根因**：`@deepseek-ai/cordis` / `@deepseek-ai/dsh-tools` 是 kernel 自带的（不在 profile 的 `node_modules` 里可解析位置），pnpm 认为 peer 未满足。

**⇒ 建议**：安装脚本里**忽略 exit code 1**（或先 `pnpm add` 那两个 peer 为 `link:` 到 kernel）。

---

## 三、分子包架构（参照 `@linxin666/dsh-web-all`）

### 参照物的形态（实测 `dsh-web-all@0.4.7`）

```json
{
  "name": "@linxin666/dsh-web-all",
  "version": "0.4.7",
  "dsh": {
    "engines": { "dsh": "0.2.x" },
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": [], "platform": "web" }
  },
  "dependencies": {
    "@linxin666/dsh-client-ui-plugin-manager": "...",
    "@linxin666/dsh-client-ui-market": "...",
    "...": "共 19 个子包"
  }
}
```

**⇒ 四个要素**：
1. **`dsh.engines.dsh`** —— 声明 DSH 版本约束（**我们缺这一项**）
2. **`dsh.bundle.patch`** —— 指向 umbrella 自己的 `cordis.patch.yml`
3. **`dsh.client`** —— client 面声明（`inject` 可空 + `platform`）
4. **`dependencies` 列全部子包** —— **umbrella 只聚合，不实装**

### 建议的引擎分子包拆分

| 包 | 内容 | 为什么拆 |
|---|---|---|
| **`dsh-punky-swarm`**（umbrella，现有名保留）| `dependencies` 列下面全部子包 + `cordis.patch.yml`（`- insert:` 子包 entry）| **用户只装这一个** |
| **`dsh-punky-swarm-core`** | `lib/engine/` + `lib/state/` + `lib/tools/` + `lib/provider-dsh/` | **引擎本体**（体积最大、变更最频）|
| **`dsh-punky-swarm-skills`** | `skills/`（software-team / design-team / research-team / writing-team / video-team）| **独立演进**（技能库涨得快）|
| **`dsh-punky-swarm-ui`** | `dsh.client.inject` 那三个 client 插件 | **只在 GUI 场景需要**（headless 不需要）|
| **`dsh-punky-swarm-schema`** | `lib/schema*` / `lib/state/schema-v3` | **契约层**（被 core 和 ui 共用）|

**⇒ 拆分的判据**：**「谁和谁的变更频率/部署场景不同」** —— 不是「谁和谁的代码像」。

### 关键：umbrella 怎么让「一键」包含上游

**`dsh plugin add` 只加 umbrella 到 `bundles`** ⇒ **上游两份（`web-app` / `agent-team-profile`）怎么办？**

**三个方案**：

| 方案 | 做法 | 评价 |
|---|---|---|
| **甲** | **umbrella 的 `cordis.patch.yml` 里 `- insert:` 上游的 entry** | ❌ **复制上游 entry 定义，脆弱**（上游改了就漂）|
| **乙** | **`dsh.bundle.dependsOn: ["@deepseek-ai/dsh-web-app", "..."]`**，由 `dsh plugin` 递归加入 | ✅ **最干净，但要改宿主**（`dsh plugin` 目前不读这个字段）|
| **丙** | **文档 + 安装脚本**：`dsh plugin add` 三次（umbrella / web-app / agent-team-profile） | ✅ **现在就能用**，但**不是「一次」** |

**⇒ 推荐**：**丙（现在）+ 乙（向 DSH 提需求）**

**丙 的脚本形态**（3 行）：
```powershell
dsh plugin --profile <name> add <umbrella-tgz>
dsh plugin --profile <name> add @deepseek-ai/dsh-web-app
dsh plugin --profile <name> add @deepseek-ai/dsh-experimental-agent-team-profile
```
**⚠ 后两条需 registry 可达**；若不可达，用 `--prefer-offline`（kernel 已缓存）或 `link:` 到 kernel 目录。

---

## 四、发布前要补的两项（当前缺失）

| # | 项 | 现状 | 要补 |
|---|---|---|---|
| **1** | **`dsh.engines.dsh`** | ❌ **没有** | 加 `"engines": { "dsh": "0.2.x" }` 到 `dsh` 字段（参照 `dsh-web-all`）|
| **2** | **`dsh.bundle.dependsOn`** | ❌ **没有**（宿主也不读） | **可先加声明**（供将来 `dsh plugin` 支持），同时用丙方案兜底 |

**⇒ 这两项都是**声明性**的，加了不影响现有行为（宿主不读就忽略）。**

---

## 五、验证过的完整流程（可复制）

```powershell
# ── 打包 ──────────────────────────────────────────────
cd D:\dsh\Punky-multi-agent-engine\packages\dsh-punky-swarm
pnpm pack --pack-destination "$env:TEMP"
$tgz = Get-ChildItem "$env:TEMP\dsh-punky-swarm-*.tgz" | Sort-Object LastWriteTime | Select-Object -Last 1

# ── 一键装（三行；前两条可省若 registry 不可达则跳过，功能会残）──
dsh plugin --profile my-swarm add $tgz.FullName
dsh plugin --profile my-swarm add @deepseek-ai/dsh-web-app
dsh plugin --profile my-swarm add @deepseek-ai/dsh-experimental-agent-team-profile

# ── 验证（⚠ 不看 exit code，patch warning 会污染）──
$node = 'C:\Users\Administrator\AppData\Roaming\dsh-tauri\runtime\node.exe'
$bin  = 'D:\DSH\kernel\0.2.x\node_modules\@deepseek-ai\dsh\lib\bin.js'
& $node $bin --profile my-swarm --dump-config 2>&1 | Select-String "^# ==|pending|dsh-punky-swarm"
```

**期望**：`# == dsh-punky-swarm` 分段头出现 + `pending` 0 + 三个上游 bundle 段头都在。

---

## 六、和 `docs/install.md` 的分工

| 文档 | 场景 | 特点 |
|---|---|---|
| **`docs/install.md`** | **开发/调试**（`link:` 到源码）| 源码改动**立即生效**，**不需要打包**；适合迭代 |
| **本文** | **分发/安装**（`pnpm pack` + `dsh plugin add`）| **装的是 tarball**，与源码解耦；适合用户/CI |

**⇒ 两者互补**：开发用 `link:`，交付用 `plugin add`。
