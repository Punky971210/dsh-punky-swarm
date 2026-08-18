# 项目 Constitution — 治理原则

> 生成日期：[YYYY-MM-DD]
> 生成者：Leader（基于 leader-decision-pack.md + Mnemopi 记忆种子）
> 用途：项目级不可协商的治理原则，所有角色自动引用

---

## I. Code Standards（编码规范）

| 条目 | 类型 | 说明 |
|------|------|------|
| 命名即文档：目录/文件/变量名称须语义清晰，拒绝无意义命名 | MUST | 从名称即可推断用途 |
| 提交前必须通过 lint 检查 | MUST | 防止基本语法问题流入下游 |
| 关键模块必须有注释 | SHOULD | 非显而易见的设计决策须记录 |

---

## II. Security Baselines（安全基线）

| 条目 | 类型 | 说明 |
|------|------|------|
| OWASP Top 10 合规 | MUST | 注入防护、认证、会话管理、XSS 防护 |
| 敏感数据加密传输（TLS）和存储 | MUST | 密码/令牌/个人隐私数据 |
| 密码使用 bcrypt/argon2 等慢哈希 | MUST | 禁止明文存储或 MD5/SHA 快速哈希 |
| API 端点必须有鉴权校验 | MUST | 除公开端点外全部需要 |
| 密钥和凭据不得硬编码 | MUST | 使用环境变量或密钥管理 |

---

## III. Compliance Constraints（合规约束）

| 条目 | 类型 | 说明 |
|------|------|------|
| 用户数据全本地化 | MUST | 不依赖外部 API 存储用户数据 |
| 依赖选型优先 MIT 开源协议 | SHOULD | 避免 GPL 传染性协议 |
| 保持可自托管 | MUST | 架构不锁定特定云厂商 |

---

## IV. Architecture Principles（架构原则）

| 条目 | 类型 | 说明 |
|------|------|------|
| 前后端分离，按依赖链路排序粗拆 | MUST | 避免跨前后端的混合子模块 |
| MVP 优先，不超前添加未要求的灵活性 | MUST | 设计不过度原则 |
| 增量开发优先于推倒重做 | MUST | 在现有架构上做增量修改 |
| 模块间解耦 | MUST | 依赖链路清晰，无循环依赖 |

---

## V. Process Gates（流程门禁）

| 条目 | 类型 | 说明 |
|------|------|------|
| Coder 交付前必须自检（lint + 测试通过） | MUST | Mnemopi SP-05 |
| Reviewer 打回必须附带 MUST-FIX 清单 | MUST | Mnemopi SP-08 |
| 同子模块 3 次打回触发 HATL 门禁 | MUST | 现有流水线规则 |
| Spec Acceptance Criteria 必须可测试 | MUST | 可用 JSON 断言验证 |
| 复盘必须阅读 6 类产出物 | MUST | Mnemopi SP-09 |

---

## 引用规范

所有角色细则中引用 constitution 时使用以下格式：

```
参考 Constitution §[章节]：[条目描述]
```

例如：

```
参考 Constitution §II：API 端点必须有鉴权校验
```