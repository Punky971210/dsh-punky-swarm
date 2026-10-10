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

工具调用级护栏默认**出厂零拦截**（规则表为空），装上即用、不改变既有行为；规则按需启用。随包提供可选**规则预设**（敏感数据防护 / 资源边界 / 两者合并），一句启用一套。

被拦时收到的不是泛化提示，而是护栏标注、命中规则与违规说明，并落**可验篡改的拒绝收据**——Agent 知道为什么被拦，可按说明修正后重发合规调用。配置入口在 Web UI 设置区的治理配置页，保存即时生效、免重启。

## 审计日志

内置**进程级本地审计日志**：把引擎与本插件产生的日志逐行落到本地磁盘，供事后核对。**默认开启**（审计入口的意义在常态可用），**不做任何远程上报**——这是硬约束，不是默认值。

## 包内资产与实装去向

本插件随包携带**预设本体**（蟛蜞模式纪律与装配面）与**团队技能**（`software-team` / `design-team`）；装入 dsh 后由启动期同步到你的用户目录，技能由此可被运行期加载。

## 安装

前置：已安装 DeepSeek Harness（dsh），Node.js ≥ 22。

```sh
# 安装并装入 dsh（profile 可按需替换为实际使用的 profile）
dsh plugin add dsh-punky-swarm
dsh web restart
```

> 备选：`npm install -g dsh-punky-swarm` 后以 `dsh plugin --profile <profile> add dsh-punky-swarm` 装入；开发路线亦可 `link:` 指向本地包目录。

## 快速开始

1. **启用插件**：执行上方安装命令并重启 dsh。
2. **建第一个批次**：向治理层说明目标，任务自动进入「计划 → 执行 → 验收」流水线；复杂任务自动按依赖排程。
3. **看进度**：Web UI 批次面板查看阶段、子任务状态与事件时间线；批次完成后产物归档，全程可查。

交互演示页与界面截图将后续补充。

## 兼容性与边界

当前版本以 `packages/dsh-punky-swarm/package.json` 为单一真源（见 `CHANGELOG.md` 变更记录）；测试基线 **154 个测试文件 / 1656 个测试 / 7940 条断言，全绿**（单一真源 `packages/dsh-punky-swarm/baselines/test-baseline.json`，实测于 Node 24，CI 覆盖 Node 22/24）；peer 依赖 @deepseek-ai/dsh-tools（^0.1.0-rc.6 \|\| ^0.1.1-rc.2 \|\| ^0.1.5-rc.1 \|\| ^0.1.6-alpha.1 \|\| ^0.1.7-rc.1 \|\| ^0.2.0-rc.1）与 @deepseek-ai/cordis（^4.0.1）；已收录 awesome-dsh-plugin。

诚实边界：面向单机进程内治理——不做分布式集群同步、无成本控制、无模型分层路由，零云依赖、默认零网络暴露；失败即终态，重做即新建批次，不自动续跑。

## License

**GNU AGPL v3（AGPL-3.0-only）** 为唯一许可：遵守 [AGPL-3.0](LICENSE) 可自由使用、修改、分发（含商用）；修改后经网络提供服务须公开修改内容。
