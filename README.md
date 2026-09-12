# dsh-punky-swarm —— 让 AI 团队跑得起来，更跑不坏

<p align="center">
  <a href="https://github.com/Punky971210/dsh-punky-swarm/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Punky971210/dsh-punky-swarm?label=license" alt="license"></a>
  <a href="https://awesome-dsh-plugin.com"><img src="https://awesome-dsh-plugin.com/badge.svg" alt="awesome"></a>
  <a href="https://github.com/Punky971210/dsh-punky-swarm/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Punky971210/dsh-punky-swarm/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="https://github.com/Punky971210/dsh-punky-swarm/blob/main/packages/dsh-punky-swarm/package.json"><img src="https://img.shields.io/badge/node-%3E%3D22-blue" alt="node"></a>
</p>

> **Keeps AI teams from breaking — not just running.**
>
> **本地多 Agent 流水线治理**——任务分级、拆解、排期、质检、验收、容灾全部装进引擎，人只做裁决：说清要什么，验收做出什么。门禁拦下半成品，检查点原地续跑——让一批 Agent 不只跑得起来，更跑不坏。
>
> *One agent is a helper; a governed swarm of agents is department-scale output in one person — breakdown, scheduling, gates, acceptance and recovery live in the engine, and you only judge: say what you want, accept what it made.*

English: [README.en.md](README.en.md)

---

## 为什么需要它

一个 Agent 好管：跑偏了，你盯一眼就能拽回来。一批 Agent 一起干活是另一回事——谁先跑、谁等谁、谁写哪个文件、崩了从哪续，没人管，跑起来就是事故现场。

几个跑过长任务的人都撞见过的痛点：

| 痛点 | 你得到的后果 |
|---|---|
| **半成品当完成品交** | 下游在上游产物没齐时就被派活，错误一路传到返工才暴露 |
| **一崩全丢** | 跑了几小时没有中间存档，一次崩溃全部归零 |
| **并发互相踩** | 几个 Agent 同时写同一个仓库，互相覆盖，出冲突说不清谁改了什么 |
| **越界调用悄悄发生** | Agent 把私钥写进子任务参数、把命令参数开到离谱上限，没人拦 |
| **拦了却说不清为什么** | 调用被拒，只收到一句「用户拒绝了该工具」，Agent 和人都不知道是护栏拦的、拦的是哪条规则 |

工具本身没坏——缺的是流程上的闸口。本插件把闸口装进引擎：产物不齐，不放行；干一步，存一档；同一份活，只许一个人写；每一次越界，拦得明明白白。

## 它做什么

**双层治理，两道防线。** 批级编排与调用级护栏叠加生效，互不绕过：

- **第一层 · 任务编排**：决定「任务怎么派」——任务先分级：顺手的小活直接干，要独立跑一摊的交一个 Agent，环节多、要协作、要验收的走整条批次流水线。批次按依赖排成波次，状态与事件全程留痕，可审计可回溯。
- **第二层 · 调用护栏**：决定「每次工具调用是否越界」——除派发门禁外，每次调用再按裁决原语逐调用判定；命中即产出可验篡改的拒绝收据，复核可定位。

**三层门禁，拒绝半成品。** 每个批次按「计划 → 执行 → 验收」分层推进，层与层之间以产物契约为闸：

- 派发前查上游产物是否齐备、结算前查产物是否落盘、完结前查验收是否完成——**缺件直接拒**；
- 想改目标就新建批次，正在跑的不会偷跑偏；
- 干一步、存档一步，中断只是停在存档点，不是从头再来；失败即终态，重做即新建批次，不自动续跑、不静默覆盖。

**为什么是引擎级，而不是协议级。** 互联协议能把 Agent 连起来互相调用，但连出来的是聊天室——能对话，组织不成流水线。门禁要拦在工具调用链上：产出不齐不许开工、一步没验收不进下一步，这类检查只能长在宿主执行循环内部，协议层没有落点。

## 三个机制，正好治三件事

| 痛点 | 机制 | 你得到 |
|---|---|---|
| 半成品当完成品交 | **门禁引擎强制**：派发前查上游产物、结算前查落盘、完结前查验收，缺件直接拒 | 半成品到不了你手里 |
| 一崩全丢 | **存档点保全**：每完成一个子步骤即保全一次，崩溃后可查可续 | 中断只是停在存档点，不是从头再来 |
| 并发互相踩 | **单写者锁 + 隔离工作区**：同一份活同时只许一个写者，各改各的树 | 冲突保留现场、交人裁决，不静默覆盖 |
| 越界调用 | **调用级护栏 + 拒绝收据**：逐调用裁决，命中即拒绝并落可验篡改的收据 | 越界到不了执行面，事后可复核 |
| 拦得不明不白 | **拒绝可见性**：被拦时收到的不是泛化提示，而是护栏标注、命中规则与违规说明 | Agent 知道为什么被拦，可按说明修正参数重发合规调用 |
| 规则心里没底 | **出厂零拦截 + 逐条审阅清单**：装上不改行为，规则可先审后用 | 拦的是什么、为什么拦，全部摊开可核对 |

## 护栏与规则

工具调用级护栏默认**出厂零拦截**（规则表为空），装上即用、不改变既有行为；规则按需启用。

随包提供可选**规则预设**，一句启用一套护栏：

- **敏感数据防护**：私钥块 / 凭据签名进入子任务参数、消息信道、搜索与远程命令面时的内容检测（硬性拦截 + 人工复核两档）；
- **资源边界**：命令超时、并发数、目标轮数等数值上限，超限拒绝并给收窄指引（可按指引重试为合规调用）；
- **全量合并**：以上两套的逐条等价合并，一条配置启用全部。

**自 0.4.3 起的三项新能力：**

- **拒绝可见性**——工具调用送入人工审批后被拒绝（含审批服务不可达等降级情形）时，收到的拒绝不再是「用户拒绝了该工具」的泛化文本，而携带护栏标注、命中规则、违规说明与查阅路径；Agent 与用户都能识别「这是护栏在拦疑似敏感调用」，并可按违规说明修正后重发合规调用。非拦截场景行为保持不变。
- **拒绝文本携带命中规则**——拒绝原因末尾追加命中的规则与预设归属；人工审批请求与直接拒绝两条路径均携带，用户在批准/拒绝前即可核对触发的具体规则。
- **逐条规则审阅清单**——随包提供护栏规则的逐条审阅清单：按规则编号 / 预设归属 / 类别 / 生效裁决档 / 触发面 / 匹配摘要 / 违规说明逐条成表，供用户与 Agent 主动审阅护栏全集（配套一致性断言守护清单与规则文件同步）。装规则前先审一遍，心里有数。

配置入口：Web UI 设置区的治理配置页可调护栏开关、规则与窗口，保存即时生效、免重启。

## 安装

前置：已安装 DeepSeek Harness（dsh），Node.js ≥ 22。

```sh
# 安装并装入 dsh（profile 可按需替换为实际使用的 profile）
dsh plugin add dsh-punky-swarm
dsh web restart
```

> 备选：`npm install -g dsh-punky-swarm` 后以 `dsh plugin --profile <profile> add dsh-punky-swarm` 装入；开发路线亦可 `link:` 指向本地包目录。

## 包内资产与实装去向

本插件随包携带**预设本体**（蟛蜞模式纪律与装配面）与**团队技能**（`software-team` / `design-team`）。装入 dsh 后，这些资产会被同步到你的用户目录，技能由此可被运行期加载。

### 包内路径 → 实装去向

| 包内路径 | 实装去向（用户目录） | 性质 |
|---|---|---|
| `presets/jiufeng/` | `~/.dsh/.agent-presets/jiufeng/` | 用户机实装面：随预设同步 |
| `presets/jiufeng/asset-manifest.json` | `~/.dsh/.agent-presets/jiufeng/asset-manifest.json` | 用户机实装面：资产清单本身，也是下表同步项的声明来源 |
| `skills/software-team/` | `~/.agents/skills/software-team/` | 用户机实装面：技能目录，供 `skill` 工具加载 |
| `skills/design-team/` | `~/.agents/skills/design-team/` | 同上 |
| `presets/hook-rules/` | **无用户机落点** | 包内原地读取面：随插件安装目录原地读取（启动时装载一次），**不复制到 `~/.dsh` 或 `~/.agents`**，故不会出现在你的用户目录里 |

### 触发时机

- **同步发生在插件启动/重载时**（dsh 载入本插件的 `apply` 阶段），每个进程执行一次；不是每次工具调用、也不提供任意时刻的手动触发命令。
- 因此：**运行中改了包内资产，需要重启 dsh 才生效**。
- **同步由包内清单 `presets/jiufeng/asset-manifest.json` 驱动**——清单声明「同步哪些包内路径、各自落到哪里」，而不是把路径写死在代码里；新增或调整资产改清单即可（清单的落点根只有两个枚举：`preset` = `~/.dsh/.agent-presets`、`skill` = `~/.agents/skills`，不能写绝对路径）。
- **清单缺失或损坏时不会静默不同步**：清单文件不存在、读取失败、JSON 非法或字段不合规时，机制**回落到内置默认三条**（上表前三行）并照常同步，同时在启动日志给出告警：`asset manifest 不可用（…），已回退内置默认资产表；用户机实装面可能与包内清单声明不一致`。也就是说，最坏情形下三份资产仍然会被装上，只是清单的声明性失效——你有日志可查、不是无声跳过。

### 资产清单（人读版 schema）

清单是包内 `presets/jiufeng/asset-manifest.json`，把「包内相对路径 → 落点根 → 目标子路径」写成 JSON。字段与出厂值：

```json
{
  "manifestVersion": 1,
  "description": "蟛蜞模式（jiufeng）资产清单：声明包内预设与团队技能到用户机实装面的单向同步（真源=包内 skills/，不反向同步）",
  "assets": [
    { "rel": "presets/jiufeng", "note": "蟛蜞模式预设本体", "target": { "root": "preset", "subpath": "jiufeng" } },
    { "rel": "skills/software-team", "note": "软件工程团队技能（真源）", "target": { "root": "skill", "subpath": "software-team" } },
    { "rel": "skills/design-team", "note": "设计团队技能（真源）", "target": { "root": "skill", "subpath": "design-team" } }
  ]
}
```

| 字段 | 含义与约束 |
|---|---|
| `manifestVersion` | 清单 schema 版本，当前为 `1` |
| `description` | 一句话说明（单行） |
| `assets[].rel` | 包内相对路径（`/` 分隔，不得含 `..`、`\`、`:` 或前导 `/`） |
| `assets[].note` | 该条用途（人类可读，可选） |
| `assets[].target.root` | 落点根类型，仅 `preset` / `skill` 两值 |
| `assets[].target.subpath` | 落点根内的目标子路径（路径规则同 `rel`） |

**真源方向是单向的**：包内 `skills/` 是唯一真源，同步方向为 包内 → 用户机；你在 `~/.agents/skills/` 下的改动**不会**回流到包内。

### 幂等与注意

- **幂等**：目标内容与包内一致时跳过（不重复写），不一致时整体覆盖重写。
- **会做**：**活目标根内多余文件会被覆盖清除**（例如包内已无 `stale.md`，同步后目标根里的 `stale.md` 也会消失）。
- **不会做**：**旧目标根目录不被删除**。资产改名或移除后，条目的旧目标根不再有同步动作，`syncDir` 无 job 即无动作，**旧目录会残留在用户目录**（历史上技能由 `jiufeng-team` 更名为 `software-team` 时，旧目录即留存下来）。
- **清理须手工**：技能更名后旧目录应手工删除，否则两个名字的技能并存，技能目录加载与装配断言可能双命中；同理，**清单中移除某条 = 只停止同步，不会清理用户机上已有副本**，清理同样须手工。
- 自举条（清单文件本体）每次同步都会重拷一份到用户目录，以保证那里的清单副本恒不旧于本次实际执行的声明；**目录类资产才走内容一致判定，文件类资产（如自举条）每次整拷**。

## 快速开始

1. **启用插件**：执行上方安装命令并重启 dsh。
2. **建第一个批次**：向治理层说明目标，任务自动进入「计划 → 执行 → 验收」流水线；复杂任务自动按依赖排程。
3. **看进度**：Web UI 批次面板查看阶段、子任务状态与事件时间线；批次完成后产物归档，全程可查。

交互演示页与界面截图将后续补充。

## 文档

随包维护中英双语主题文档（7 组、每组含中英两版，随 npm 包分发），仓库内目录：[packages/dsh-punky-swarm/docs](packages/dsh-punky-swarm/docs)：

| 主题 | 文档（同目录附对应 `.en.md` 英文版） |
|---|---|
| 治理技术细节（门禁语义、状态机、装配与工具参考） | [governance-technical.md](packages/dsh-punky-swarm/docs/governance-technical.md) |
| 治理配置页说明（Web UI 护栏开关与能力开关的保存生效口径） | [webui-governance-config.md](packages/dsh-punky-swarm/docs/webui-governance-config.md) |
| 护栏挂钩机制（调用级护栏运行期语义、规则示例与收据验签） | [guardrails-hook.md](packages/dsh-punky-swarm/docs/guardrails-hook.md) |
| 单机能力边界（本地单机治理能力声明） | [single-machine-capabilities.md](packages/dsh-punky-swarm/docs/single-machine-capabilities.md) |
| 合规对齐（AIP 描述结构：工具属性 / 智能体描述 / 消息映射） | [aip-compliance.md](packages/dsh-punky-swarm/docs/aip-compliance.md) |
| 通讯扩展（ACPs：对外端点 / 注册 / 发现，默认关闭） | [acps-communication.md](packages/dsh-punky-swarm/docs/acps-communication.md) |
| 治理边界（能力边界声明：哈希链与 canonical 边界、规则同步维护口径） | [governance-boundaries.md](packages/dsh-punky-swarm/docs/governance-boundaries.md) |

## 兼容性与边界

当前版本 **0.4.3**；863 项测试全绿（实测于 Node 24，CI 覆盖 Node 22/24）；peer 依赖 @deepseek-ai/dsh-tools（^0.1.0-rc.6 \|\| ^0.1.1-rc.2）与 @deepseek-ai/cordis（^4.0.1）；已收录 awesome-dsh-plugin。

诚实边界：面向单机进程内治理——不做分布式集群同步、无成本控制、无模型分层路由，零云依赖、默认零网络暴露；失败即终态，重做即新建批次，不自动续跑。

## License

**GNU AGPL v3（AGPL-3.0-only）** 为唯一许可：遵守 [AGPL-3.0](LICENSE) 可自由使用、修改、分发（含商用）；修改后经网络提供服务须公开修改内容。
