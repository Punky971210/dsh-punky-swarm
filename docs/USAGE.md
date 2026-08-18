# dsh-punky-swarm 使用文档（蟛蜞模式）

## 安装
```
# 插件（任意 profile）
dsh plugin --profile web add link:<repo>/packages/dsh-punky
# 预设（已装）
# ~/.dsh/.agent-presets/jiufeng/  （preset.yml + agent.cordis.yml）
```

## 工具清单（13）
| 工具 | 用途 |
|---|---|
| wave_plan | 按 DAG 依赖分层为 waves 并持久化批次（固定语义，绝不中途重算）；Tier3：声明 layer/consume/produce/outputs/role/skills，建批时三层契约静态校验；team 装配注入 skill 前缀 |
| batch_phase | 批次阶段迁移（planning→running→paused→aborted|complete）；complete 前置 audit 验收齐备 |
| batch_status | 查询批次状态（唯一事实源）/ 列出当前会话全部批次 |
| artifact_types | 产物类型注册表（只读）：类型 → 层/目录前缀约定 |
| assign_check | 委派形态判定：Leader 直做（A）/ 轻量 subagent（B）/ 必须走流水线批次（C） |
| gate_status | 查询批次/lane 门禁状态：layer、consume/produce/outputs 缺失清单、plan 契约问题 |
| member_status | 成员非终态操作：pending→running（派发，exec 需 consume 齐备）、running→review（提交）、idle→running（恢复重派） |
| member_settle | 成员终态结算：review→merged/failed/skipped/conflict；Tier3：plan merged 前 L0 校验、exec 前 outputs、audit 前 produce |
| lane_claim / lane_release | O_EXCL 单写者锁（冲突先拒绝；wait/force 可选；token 校验释放） |
| mailbox_send / read / ack | 文件 mailbox：inbox(Leader→worker)/outbox(worker→Leader)/broadcast，原子写+ack |

## 三层门禁（Tier3）
- **建批静态校验**：layer ∈ plan/exec/audit；有 exec 必有 audit；产物路径必须 plan/|exec/|audit/ 前缀或绝对路径；exec.consume 的 plan/ 路径必须由 plan 层 produce；跨批次 artifacts/ 先禁。
- **Entry Gate**：exec 派发前 consume 齐备非空。
- **L0**：plan merged 前 spec.md 含「## 验收标准」「## 约束」，.json 可解析。
- **Exit Gate**：exec merged 前 outputs 存在；audit merged 前 produce 存在。
- **Complete Gate**：三层批次 audit 存在、全终态、无 failed/conflict；exec 全终态。
- generic 批次（无 layer）不触发门禁，向后兼容。

## 工作目录约定（会话隔离 v2）
```
<root>/sessions/<sessionId>/batches/<batchId>.json   # 唯一事实源（原子写：临时文件+rename）
<root>/sessions/<sessionId>/artifacts/<batchId>/plan|exec|audit/   # 三层产物
<root>/sessions/<sessionId>/mailbox/<batchId>/…      # supervisor/inbox、<lane>/outbox、broadcast
<root>/sessions/<sessionId>/.locks/…                 # lane 锁
默认 root：~/.dsh/jiufeng（可经插件 config.root 覆盖）；存量 root/batches 启动时自动迁移 sessions/legacy
```

## 事件（只存元数据，不复制正文）
batch.created / batch.phase / member.settled / gate.entry.missing / gate.exit.missing / gate.complete_blocked / gate.passed / system.recovered

## 恢复语义
进程启动时（每进程一次）：in-flight 成员 running/review → idle + system.recovered；wavePlan 持久化保证恢复后布局不变。

## 治理流程（Leader 视角）
1. wave_plan 建批次（三层：plan→exec→audit）→ 2. batch_phase running → 3. 按 wave 并发派发（member_status running，exec 过 Entry Gate）→ 4. plan 产物过 L0 后 merged → 5. exec 产物过 Exit Gate 后 merged → 6. audit 产物过 Exit Gate 后 merged → 7. 全 lane 终态后 batch_phase complete（过 Complete Gate）→ 8. gate_status/batch_status 核对。
