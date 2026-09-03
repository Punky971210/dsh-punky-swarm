# ACPs 通讯明细（默认关）

> 本文档描述 ACPs（Agent Communication Protocol Standard）通讯能力：对外 mTLS 服务端点、内部 mailbox↔ACPs 桥接、registry 半自动注册与外部 ADP 发现对接，以及与既有 AIP 能力的关系和能力边界。**全部默认关**（安全默认）——`acps.enabled` 与 `acps.endpoint.enabled` 均默认 `false`；关闭时零运行时路径（无监听、无定时器、无网络）。
> English: [acps-communication.en.md](acps-communication.en.md)

## 1. 能力总览

| 能力 | 装配键 | 默认 | 用途 |
|---|---|---|---|
| 对外 mTLS 端点 | `acps.enabled` + `acps.endpoint.enabled` | 关 | 对外提供 AIP JSON-RPC / ACS / 健康检查（TLSv1.3 + 双向证书） |
| 内部桥接 | `acps.bridge` | 关（inbound 再子门控关） | mailbox ↔ ACPs 消息进程内双向投影/投递 |
| registry 注册 | `acps.registry` | 关 | 半自动注册客户端（需 registry.url + 用户凭据） |
| discovery 发现 | `acps.discovery` | 关 | 外部 ADP 发现客户端（POST /discover） |

## 2. 对外 mTLS 服务端点

独立 HTTPS 监听器（node:https + node:tls 原生，零新依赖），默认端口 `9443`（`acps.endpoint.port` 可配）、host 默认 `127.0.0.1`；TLSv1.3（`minVersion` 默认，可配 TLSv1.2）+ 双向证书（`requestCert` + `rejectUnauthorized` = CERT_REQUIRED）；`devInsecure` 仅显式开发开关（默认 `false`，生产不允许降级）。装配条件：`acps.enabled` 与 `acps.endpoint.enabled` **双真**；证书缺失/不可用 → 启动告警并保持禁用，不阻塞主进程。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/acps/rpc` | POST | AIP JSON-RPC（jsonrpc 2.0，method=`rpc`，params.command=TaskCommand → TaskResult accepted/rejected）；客户端证书 CN 须为合法 AIC（否则 400） |
| `/.well-known/acs.json` | GET | ACS 直取（14 必填键 + securitySchemes.mutualTLS + endPoints JSONRPC） |
| `/health` | GET | 健康检查（agent/status/tasks/groups） |

证书：CA 自签（node:crypto 原生 X.509 + ECDSA P-256），实体证书 CN=AIC、SAN=URI:acps://{AIC}，默认生成于 `<root>/acps/certs`（ca.pem/ca.key/server.pem/server.key）；`cert/key/ca` 三路径可配置覆盖。

## 3. 内部桥接

`acps.bridge`（进程内双向，默认关；mode=`inprocess`）：

- **inbound**（默认关，`acps.bridge.inbound=true` 显式开启）：外部 ACPs TaskCommand → mailbox 消息，**经 lib/comms/mailbox.js 公共接口原子写 inbox（ackId 由 mailbox 生成，绝不绕过、无旁路写）**；写入目标仅 inbox（按 mentions/groupId 推导 lane 进 meta），outbox 不可外部直接写，broadcast 外部投递不支持；
- **outbound**：mailbox 消息 → ACPs Message/TaskResult（复用 aip-format 三映射），只投影/投递视图，不反写 mailbox 存储；
- **/rpc→bridge 接线**：`POST /acps/rpc` 收到的 TaskCommand 经 `handleInbound` 落 mailbox；`bridge.inbound=false` 时协议级 `rejected`（INBOUND_DISABLED，HTTP 200 返回——传输成功、协议层拒绝）；bridge 未装配时回端点缺省 accepted（向后兼容）；
- **mailbox 红线保留**：ackId 原子写、三 box（inbox/outbox/broadcast）、lane 隔离语义逐字保留；
- **零路径**：`enabled=false` 时不加载不实例化（mountBridge 返回 null）。

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
    enabled: false             # 内部桥（进程内双向）
    inbound: false             # 外部写 mailbox 需显式 true
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
- **SM2 签名**：暂不支持——sign 为可插拔接口，默认 ECDSA-P256 / RSA-2048，`algorithm='sm2'` 显式拒绝；
- **mini-ADSP**：对外 `/discover` 服务端语义仅预留函数签名（createMiniAdsp），未实现。

与 AIP 兼容明细的衔接见 [aip-compliance.md](aip-compliance.md)。
