# 国标 AIP 兼容明细

> 本文档描述 dsh-punky-swarm 对《人工智能 智能体互联》国标（GB/Z 185-2026）的兼容明细：工具 6 属性、智能体描述（ACS 字段集）、消息/任务/会话映射、身份体系与装配开关。遵循「仅增不改、可插拔」——兼容层为只读投影，不改变既有存储与行为。
> English: [aip-compliance.en.md](aip-compliance.en.md)

## 1. 工具 6 属性

每个治理工具提供国标描述结构所需 6 属性：

| 属性 | 说明 |
|---|---|
| `toolId` | `dsh.punky-swarm.<name>` 反向域唯一标识 |
| `name` | 工具名 |
| `description` | 功能描述 |
| `version` | 工具版本 |
| `inputParam` | JSON Schema（required 恒在） |
| `outputParam` | JSON Schema（required 恒在） |

目录由装配配置生成（`aip.enabled=true` 时），生成逻辑见 `lib/aip/tool-descriptor.js`；版本号取引擎版本。

## 2. 智能体描述（GB/Z 185.4-2026 ACS 字段集）

装配配置 → 每角色 ACS AgentCapabilitySpec 描述（`lib/aip/agent-descriptor.js`）：

- **根对象**（20 键）：
  - 必填 14：`aic` / `active` / `lastModifiedTime` / `protocolVersion` / `name` / `description` / `version` / `provider` / `securitySchemes` / `endPoints` / `capabilities` / `defaultInputModes` / `defaultOutputModes` / `skills`；
  - 可选 6：`iconUrl` / `documentationUrl` / `webAppUrl` / `entityUserId` / `entityMeta` / `certificate`；
- **AgentSkill**（8 键）：必填 5：`id` / `name` / `description` / `version` / `tags`；可选 3：`examples` / `inputModes` / `outputModes`；
- 协议版本 `02.01`。

## 3. 消息 / 任务 / 会话映射

mailbox 消息、wavePlan 任务、批次状态 → 国标结构（纯映射、只读、不改存储；ackId 原子写保留）。映射实现见 `lib/comms/aip-format.js`（`toAipMessage` / `toAipTask` / `toAipSession` 投影函数，恒导出零副作用）。

## 4. 身份体系（默认关）

装配键 `aip.identity.enabled=true` 激活（默认关闭，关闭时零加载）：

| 组件 | 说明 |
|---|---|
| AIC 身份码 | OID 前缀 `1.2.156.3088` + CRC-16/CCITT-FALSE + Base36 校验码 |
| CAI 身份证书 | 国标智能体身份证书 |
| 签名 | 可插拔接口，默认 ECDSA-P256 / RSA-2048 |
| 信任链验证 | `verifyTrustChain` |

实现见 `lib/aip/identity.js`（AIC 校验 / 证书 / sign / verifyTrustChain）。

**能力边界**：SM2 暂不支持——sign 为可插拔接口，默认 ECDSA-P256 / RSA-2048；`algorithm='sm2'` 显式拒绝。

## 5. 装配开关与端点

| 装配键 | 默认 | 效果 |
|---|---|---|
| `aip.enabled` | 开 | 生成工具 6 属性目录 + `GET /api/dsh-punky-swarm/tools`（可 `?name=` 过滤）；关闭则零运行时开销 |
| `aip.identity.enabled` | 关 | 身份体系（AIC/CAI/签名/信任链）激活 |
| `aip.team` | jiufeng | 装配团队（决定 ACS 角色集来源） |

相关端点：`GET /api/dsh-punky-swarm/tools`、`GET /api/dsh-punky-swarm/agents`、`GET /.well-known/aip`（均为只读）。

## 6. 能力边界

- 工具调用（GB/Z 185.7-2026 第 7 部分：智能体工具调用）未实现；
- 对外 `/discover` 服务端语义（mini-ADSP）仅预留函数签名（`createMiniAdsp`），未实现；
- ACPs 通讯（另一条对外通路）见 [acps-communication.md](acps-communication.md)。
