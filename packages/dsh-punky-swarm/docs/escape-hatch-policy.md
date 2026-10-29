# 逃生舱（escape hatch）政策 —— 本仓不建

- 适用仓：`packages/dsh-punky-swarm`
- 裁定来源：蓝批 `punky-g3-b3-design-2026-10-31` 的 `plan/p2-pack-b3-design.md` §2.6 / §2.7（已 approve）
- 快照：HEAD `dc75bc5`（文中行号以此快照为准；漂移时以符号名为锚）
- 性质：**策略文档**，不含实现。本文件只声明边界，不引入任何代码面。

---

## 1. 裁定

**本仓不建逃生舱** —— 不提供「任意 URL ＋ 任意 body 直通到内部执行面」的通道（无论叫 escape hatch、bypass、admin passthrough 还是 debug invoke）。

理由的核心是**入口数量**：本仓的数据/治理入口已经明确为两处（§3），再加一个"任意直通"就是**第三个入口**，而它恰恰不承担判据。

## 2. 三条理由

| # | 理由 | 本仓事实（锚点） |
|---|---|---|
| **R-1** | **新建即新增绕过面**：本仓已有 MCP 薄包装与 `ctx.webServer` 端点面，再开"任意直通"= 第二个（第三个）入口，而门禁判据只挂在前两个入口上 | 端点面 `lib/api.js:47`（`ctx.webServer.register` 唯一注册口）；MCP 面 `lib/mcp/data-plane-server.js:261`（`method:'POST', kind:'exact', path:'/mcp'`）；判据真源 `lib/state/gates/**` |
| **R-2** | **蓝图 C4 的意图（限 `/api` 下 ＋ 限 JSON body）已由现有路径等效达成** | 见 §3 三行（逐行给路径） |
| **R-3** | **零依赖纪律**：逃生舱若要"任意 body 解析/转发"就需要通用校验或代理库；本仓 `package.json` 的 `dependencies` 键**不存在**（生产零依赖），此纪律不得为通道而破 | `package.json`（无 `dependencies` 键）；现有 JSON 解析为手写 `readJsonBody`：`lib/api.js:378` |

## 3. 等效达成（蓝图要求 → 本仓实际路径）

| 蓝图要求 | 本仓实际路径 | 锚点 |
|---|---|---|
| **限 `/api` 下** | 插件 HTTP 面全部经 `ctx.webServer.register` 注册，且路径固定前缀 `/api/dsh-punky-swarm/*`（另有 `/.well-known/aip` 只读发现面与 `/mcp` 协议面） | 注册口 `lib/api.js:47`；MCP 面 `lib/mcp/data-plane-server.js:42`（`MCP_PATH = '/mcp'`）＋ `:261` |
| **限 JSON body** | 请求体只经手写 `readJsonBody` 解析（`POST` 面），`lib/api.js:247` 使用；解析失败归 400；MCP 侧同样先 `readBody` 再 `JSON.parse`，失败 ⇒ `-32700`/`-32600` | `lib/api.js:378`（`function readJsonBody`）｜`lib/mcp/data-plane-server.js:236-243`（帧解析与错误码） |
| **受控调用** | ① **写工具**必经写族溯源守卫（缺 L1 `sourceRunId` ⇒ 拒，返回字符串 `source-run-id-missing:`）；② **执行型工具**必经难度门禁；③ **MCP** 只有唯一派发点 `ctx.tools.execute(...)`（必过宿主 `tools/pre-execute` → guard 链），且非 loopback 请求直接拒 | ① `lib/tools/write-provenance-guard.js:95`（install）／`:99`（`ctx.tools.guard`）／`:60`（前缀常量）｜② `lib/tools/tier-gate.js:133`（`installDifficultyGuard`）／`:141`（`ctx.tools.guard`）｜③ `lib/mcp/data-plane-server.js:183`（唯一 `ctx.tools.execute`），loopback 判定 `:93`，非 loopback 拒 `:228` |

## 4. 将来准入三条件（**可判定门槛**，缺一不得开工）

若日后确有需要新增受控通道，**必须先满足**下列三条（每条给出机核方式，均可脚本判定 —— **不接受"看起来可行"式的口头结论**）：

| # | 门槛 | 机核方式（期望读数） |
|---|---|---|
| **A-1** | **判据先行**：该通道对应的判据条目必须**先**存在于判据真源，且本政策同步更新 | `grep -rn "<通道名>" lib/state/gates/ \| wc -l` ≥ 1（**先落判据，后写通道**） |
| **A-2** | **入口归一**：通道必须注册在既有 `ctx.webServer.register` 面并落 `/api` 前缀，且只接受 JSON body；**不得**新起监听 | `grep -rnE "\.listen\(\|createServer\(" lib/ \| wc -l` **不增长**（当前 = 3，全部在 `lib/acps/server.js`，见 §6）；且不出现 `path:` 不以 `/api` 开头的**写**入口 |
| **A-3** | **不得自建第二套判据**：通道内不得实现判据/策略（只能调用判据真源） | `grep -cE "gateDecision\|judge\|matchToolBan" <新文件>` = **0**（且其调用必须落在 `lib/state/gates/**` 或既有 `ctx.tools.guard` 链路） |

> 三条门槛的**目的**是让"新增"这件事必须**付出可见成本**（先写判据、复用入口、不自造策略），而不是禁止一切演进。

## 5. 禁两头留

**不得同时**（a）在本文件声明"本仓不建"**且**（b）在仓内留下半成品逃生舱（例如：注册了通道但默认关闭的开关、未接线的 handler、注释掉的直通分支、"仅测试用"的 passthrough）。

判据：`git grep -nE "escape.?hatch\|passthrough\|bypass" -- lib/` 为 **0**，且不存在"声明关闭但有实现"的通道文件。**要建就整条建（含 §4 三条件），不建就一行不留。**

## 6. 「本仓当前不存在此机制」的机核方式

```bash
# ① 名称面：代码里没有这个机制（期望 0）
grep -rniE "escape.?hatch" lib/ test/ scripts/ | wc -l

# ② 文档面：除本文件自身外没有别处谈论它（期望 0；本文件是自指，必须排除）
grep -rniE "escape.?hatch" docs/ --exclude=escape-hatch-policy.md | wc -l

# ③ 正面证据：派发唯一性（期望 1，且唯一处为 MCP 的注册表派发）
grep -rn "ctx\.tools\.execute(" lib/ | wc -l
# ④ 正面证据：无绕过注册表的直调（期望 0）
grep -rnE "(tool|definition|def)\.execute\(" lib/ | wc -l
# ⑤ 监听面清点（当前 3，全部在 lib/acps/server.js；一旦增长须解释新入口）
grep -rnE "\.listen\(|createServer\(" lib/ | wc -l
```

**读数（HEAD `dc75bc5` 实测）**：① **0** ｜ ② **0** ｜ ③ **1**（`lib/mcp/data-plane-server.js:183`）｜ ④ **0** ｜ ⑤ **3**。

> ⚠ **方法学声明（必读）**：上面的 ① 是「**这个词不存在**」的证据，**不是**「**已收敛/无等价旁路**」的证据 —— 0 命中只能否定"有个叫 escape hatch 的东西"，不能否定"有个不叫这个名字的旁路"。
> 因此"无等价旁路"必须靠 ③④⑤ 三条**结构证据**支撑：派发点唯一、无直调工具对象、监听面可清点。
> 并且 ⑤ 的 **3 个监听点不是 0**：`lib/acps/server.js:262`（`https.createServer`）＋ `:343`（`server.listen`，缺省绑 `127.0.0.1`）由 `lib/index.js:485` 调用 —— 这是**ACPS 专用协议端点**，其 URL 集是**固定三项**（`GET /.well-known/acs.json`、`GET /health`、`POST /acps/rpc`，见 `lib/acps/server.js:296-308`），并启用 mTLS（`requestCert` / `rejectUnauthorized`，见 `:268`）⇒ **不是"任意 URL ＋ 任意 body 直通"**。它的存在被如实登记在此，而不是被"本仓无逃生舱"一句话掩盖。

## 7. 与蓝图的关系

蓝图 C4 描述的是**受控出口**（限路径、限 body）而非"免判据出口"。本仓以「固定路径集 ＋ JSON body 解析 ＋ guard 链单点派发」实现同一意图；**不新增第三条入口**即为本政策的全部要求。

---

*本文件为策略声明，随 §4 门槛或 §6 读数变化而更新；任何实现变更须另开批次并在此文件登记。*
