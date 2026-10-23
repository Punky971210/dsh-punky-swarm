# ACPs 通讯明细（默认关）

> 本文档描述 ACPs（Agent Communication Protocol Standard）通讯能力：对外 mTLS 服务端点、内部 mailbox↔ACPs 桥接、registry 半自动注册与外部 ADP 发现对接，以及与既有 AIP 能力的关系和能力边界。**全部默认关**（安全默认）——`acps.enabled` 与 `acps.endpoint.enabled` 均默认 `false`；关闭时零运行时路径（无监听、无定时器、无网络）。
>
> **边界**：ACPS 面向**主 Agent**（外部伙伴 ↔ 本实例 Supervisor inbox）；子代理 / lane worker 的通信一律走 `swarm_report` / `swarm_cc` / mailbox / handoff，**不得**经 ACPS（用户裁决 2026-10-23：「ACPS 只接主 Agent」）。
> English: [acps-communication.en.md](acps-communication.en.md)

## 1. 能力总览

| 能力 | 装配键 | 默认 | 用途 |
|---|---|---|---|
| 对外 mTLS 端点 | `acps.enabled` + `acps.endpoint.enabled` | 关 | 对外提供 AIP JSON-RPC / ACS / 健康检查（TLSv1.3 + 双向证书） |
| 内部桥接 | `acps.bridge` | 关（inbound 再子门控关） | **单向**：外部 TaskCommand → 批级 `supervisor/inbox`（目标由配置钉死）；outbound 投影面未接线（零生产消费） |
| registry 注册 | `acps.registry` | 关 | 半自动注册客户端（需 registry.url + 用户凭据） |
| discovery 发现 | `acps.discovery` | 关 | 外部 ADP 发现客户端（POST /discover） |

## 2. 对外 mTLS 服务端点

独立 HTTPS 监听器（node:https + node:tls 原生，零新依赖），默认端口 `9443`（`acps.endpoint.port` 可配）、host 默认 `127.0.0.1`；TLSv1.3（`minVersion` 默认，可配 TLSv1.2）+ 双向证书（`requestCert` + `rejectUnauthorized` = CERT_REQUIRED）；`devInsecure` 仅显式开发开关（默认 `false`，生产不允许降级），且**不放宽信任锚**：TLS 层放宽验签（`rejectUnauthorized=false`）后，应用层仍强制把对端证书链锚定到 `acps.endpoint.ca`（`checkIssued` + `verify`），不通过则三端点（`/acps/rpc`、`/.well-known/acs.json`、`/health`）一律 `403`（`no-peer-certificate` / `peer-cert-not-anchored`，起服时一条降级范围说明 warn）；服务端证书 / CA 证书**过期或未生效** ⇒ 装配期告警（warn 带 `validFrom` / `validTo` 实值）并保持禁用（不静默起服）。装配条件：`acps.enabled` 与 `acps.endpoint.enabled` **双真**；证书缺失/不可用 → 启动告警并保持禁用，不阻塞主进程。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/acps/rpc` | POST | AIP JSON-RPC（jsonrpc 2.0，method=`rpc`，params.command=TaskCommand → TaskResult accepted/rejected）；客户端证书 CN 须为合法 AIC（否则 400） |
| `/.well-known/acs.json` | GET | ACS 直取（14 必填键 + securitySchemes.mutualTLS + endPoints JSONRPC） |
| `/health` | GET | 健康检查（agent/status/tasks/groups） |

证书：CA 自签（node:crypto 原生 X.509 + ECDSA P-256），实体证书 CN=AIC、SAN=URI:acps://{AIC}，默认生成于 `<root>/acps/certs`（ca.pem/ca.key/server.pem/server.key）；`cert/key/ca` 三路径可配置覆盖。

**有效期在装配期校验**（`X509Certificate.validFromDate` / `validToDate`）：服务端证书或 CA 证书过期 / 未生效 ⇒ `createAcpsServer` 返 `{error}`（**不 listen**）⇒ 启动 warn + 端点保持禁用——不是「起服成功、零 warn、全部握手失败」的静默假可用。恢复方式：更新 `cert` / `key`，或删除 `certDir` 让 `ensureAcpsCerts` 重签（注意：`ensureAcpsCerts` 仍是「文件存在即复用」，**不**主动检测过期重签）。

## 3. 内部桥接

`acps.bridge`（默认关；mode=`inprocess`；**对外单向**——外部 TaskCommand → 批级 `supervisor/inbox`）：

> ⚠ `mode` 目前**只实现 `inprocess`**：schema 能解析 `mode='http'` 但不生效（无 http 桥实现），配了等于没配 —— 本批只做文档明示，未改代码（ACPS-10 属 S4，登记不改）。

- **inbound**（默认关，`acps.bridge.inbound=true` 显式开启）：外部 ACPs TaskCommand → mailbox 消息，**经 lib/comms/mailbox.js 公共接口原子写 inbox（ackId 由 mailbox 生成，绝不绕过、无旁路写）**；
- **投递目标恒为配置值**：目标只由装配期配置决定——`acps.bridge.inboundSessionId`（主 Agent 会话）+ `acps.bridge.inboundBatchId`（该会话下的目标批次），实际落点 `<root>/sessions/<inboundSessionId>/mailbox/<inboundBatchId>/supervisor/inbox/`；`handleInbound(taskCommand)` 的**第二参数已移除** ⇒ 调用方 / 报文**没有**传目标的入口（结构性保证，不靠调用纪律）；
- **未配置 / 只配一个 / 值非法 ⇒ fail-closed 拒收**：两键缺一、全缺，或值不合法（须匹配 `/^[a-zA-Z0-9._-]+$/` 且非 `.` / `..`）⇒ 目标不可用 ⇒ `/acps/rpc` 回协议级 `rejected`，`status.dataItems[0].data.code = INBOUND_UNAVAILABLE`，**零落盘**（不投默认会话、不投第一条批）；装配期另外 warn 一次并**点名缺哪个键**（`inboundSessionId` / `inboundBatchId` / 两者），同时给出配法与「改后须重启插件」提示；
- **报文自带 id 一律丢弃**：TaskCommand 内的 `sessionId` / `commandParams.sessionId` / `commandParams.batchId` **只读一次**用于 warn 留痕（`report-supplied sessionId/batchId ignored`；`inbound=false` 时零噪声），**不参与寻址**——对端可继续带，但不影响落点；
- **不开放给子代理 / lane**：inbox 是**批级单目录**，代码侧**本无 lane inbox**——`meta.lane` 由 `mentions` / `groupId` 推导后**仅作元数据**记录（唯一读点是回执回显与 outbound 兜底，**零寻址消费方**）⇒ **不支持 lane 定向投递**。早期表述「按 mentions/groupId 推导 lane」容易被读成「可投到 lane」，属**口径不准确**、**不是**能力越界；用户裁决 2026-10-23：**ACPS 只接主 Agent**，子代理 / lane worker 一律走 `swarm_report` / `swarm_cc` / mailbox / handoff。写入目标仅 inbox，outbox 不可外部直接写，broadcast 外部投递不支持；
- **outbound**：mailbox 消息 → ACPs Message/TaskResult（复用 aip-format 三映射），只投影/投递视图，不反写 mailbox 存储；**注意**：投影函数（`toOutbound` / `toTaskResult`）在位但**未接线**——零生产消费、端点无出站发送方；
- **/rpc→bridge 接线**：`POST /acps/rpc` 收到的 TaskCommand 经 `handleInbound(command)` 落 mailbox；`bridge.inbound=false` 时协议级 `rejected`（`INBOUND_DISABLED`，HTTP 200 返回——传输成功、协议层拒绝）；bridge 未装配时：**未声明** `acps.bridge.inbound` ⇒ 端点缺省 `accepted`（向后兼容，不落盘）；**声明了** `inbound=true` 但 `acps.bridge.enabled=false` ⇒ 协议级 `rejected`（`INBOUND_UNAVAILABLE`，HTTP 200，不落盘）+ 启动期 warn 一次——不再是静默假成功；
- **拒因四码（按判定顺序）**：`BRIDGE_DISABLED`（`acps.bridge.enabled=false`）→ `INBOUND_DISABLED`（`inbound=false`）→ `INBOUND_UNAVAILABLE`（目标未配置 / 非法，或声明 inbound 但桥未装配）→ `INVALID_CONTEXT`（落盘前 id 闸口，路径穿越防护）；四条均回 `rejected` + `status.dataItems[0].data.code`，均**零落盘**；
- **mailbox 红线保留**：ackId 原子写、三 box（inbox/outbox/broadcast）、lane 隔离语义逐字保留；
- **零路径**：`enabled=false` 时不加载不实例化（mountBridge 返回 null）。

**已知限制（本批登记，不修）**：

1. **目标静态 ⇒ 可能死信**：`inboundBatchId` 指向的批次收口后，ACPS 仍会往该死批 inbox 写，无人读取（**静默死信**）。「写前校验批相位 / 非活跃批拒收」**未实现**：读相位需 import `lib/state/**` 治理面，会新增 `comms → state` 跨域边并突破 arch-check 棘轮（`allowedPairs=63`）⇒ 只能靠**运行侧**发现（检查目标 inbox 是否真的有人消费）；
2. **改目标必须重启插件**：`acps.*` 无 remounter（热更不生效）⇒ 换批 / 改两键**必须重启插件**，否则仍投旧目标（旧批已收口 ⇒ 落进死信）；
3. **「宿主自动注入会话身份」= 未实现的 followup**：装配期 `ctx` 只提供 `tools` / `webServer` / `subagents` 服务句柄，**取不到会话身份**（会话 id 仅在工具执行期可得，`exec.agent.session.id`）⇒ 目标**只能**经配置键在装配期注入；**勿**误以为已自动绑定本实例会话。

> inbound 内容是**外部不可信输入**，直入主 Agent 上下文——主 Agent 应把 inbox 消息视为外部不可信输入（这也是 inbound 默认关的原因之一）。

## 4. registry / discovery 对接（默认关）

- **registry**（`acps.registry`，半自动注册客户端）：需 `registry.url` + 用户凭据（username/password 或 token，config/env 注入，不硬编码不落仓库）；流程 login → upsertAgent → submitAgent（**人工审批，不自动化跳过**）→ requestEab → queryAcs；EAB macKey **AES-256-GCM 加密存证**（`eabKey` 未配置时仅返回明文凭据由调用方自存）；
- **discovery**（`acps.discovery`，ADP 客户端）：POST `{baseUrl}/discover` 查询外部 Agent（type 四类 / 34 运算符，与本地 discovery 共享协议常量）；`scope` = local（仅本地既有目录）/ external（仅外部）/ both（本地+外部合并，acsMap 外部优先）；timeout 默认 10s、limit 默认 5。

## 5. 配置示例

```yaml
# ACPs 通讯能力（全部默认关，安全默认）
acps:
  enabled: true                # 能力总开关
  endpoint:
    enabled: true              # 对外 mTLS 端点（与总开关双真才装配）
    port: 9443                 # 默认 9443
    host: 127.0.0.1            # 默认仅本机
    certDir: null              # 缺省 <root>/acps/certs（自动生成）
    minVersion: TLSv1.3        # 默认 TLSv1.3（可 TLSv1.2）
    devInsecure: false         # 仅显式开发；生产不允许降级
  bridge:
    enabled: false             # 内部桥（单向：外部 TaskCommand → supervisor/inbox）
    inbound: false             # 外部写 mailbox 需显式 true
    inboundSessionId: null     # inbound=true 时必填：目标会话 = 主 Agent 会话（报文不得自选）
    inboundBatchId: null       # inbound=true 时必填：该会话下的目标批次（同 /^[a-zA-Z0-9._-]+$/ 约束）
  registry:
    enabled: false             # 半自动注册
    url: null                  # registry public API 基址（必需）
    username: null             # config/env 注入，不硬编码
    password: null
    eabKey: null               # EAB macKey 加密存证密钥（AES-256-GCM）
  discovery:
    enabled: false             # 外部 ADP 发现客户端
    baseUrl: ''                # 外部 discovery-server 根地址
    scope: local               # local / external / both
    timeout: 10000             # 默认 10s
    limit: 5                   # 默认返回上限
```

## 6. 与既有 AIP 能力的关系

- 既有端点（`GET /api/dsh-punky-swarm/tools`、`GET /api/dsh-punky-swarm/agents`、`POST /api/dsh-punky-swarm/discover`、`GET /.well-known/aip`）**一字不动**——ACPs 对外独立 9443 监听 + `/acps/*` 前缀，路径零冲突；
- 既有本地发现（`capabilities.discovery`，默认开）为进程内查询通道；`acps.discovery` 为外部查询通道，`scope=both` 时合并两通道结果；
- ACPs 通讯复用的既有资产：`aip-format` 三映射（Message/TaskCommand/Session）、`lib/aip/identity.js`（AIC 校验/证书）、`lib/discovery/schema.js`（协议常量与校验）；
- 与 `aip.identity`（默认关）同属默认关能力。

## 7. 能力边界（未实现）

- **工具调用（GB/Z 185.7-2026 第 7 部分：智能体工具调用）**：未实现；
- **lane 定向投递**：不支持——代码侧本无 lane inbox（mailbox 是批级单目录 `<root>/sessions/<sid>/mailbox/<bid>/supervisor/inbox`，lane 只落 `meta.lane`、零寻址消费方）；用户裁决 2026-10-23「ACPS 只接主 Agent」；早期「推导 lane」表述属口径不准确，非能力越界；
- **outbound（ACPs 出站）**：未接线——投影面 `toOutbound` / `toTaskResult` 在位但零生产消费，端点无出站发送方；
- **SM2 签名**：暂不支持——sign 为可插拔接口，默认 ECDSA-P256 / RSA-2048，`algorithm='sm2'` 显式拒绝；
- **mini-ADSP**：对外 `/discover` 服务端语义仅预留函数签名（createMiniAdsp），未实现。

与 AIP 兼容明细的衔接见 [aip-compliance.md](aip-compliance.md)。
