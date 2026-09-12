# Plan: [Module Name]

**参照 spec**：spec.md §[章节号]

**外部输入**：
- Tech Stack & Version: [由外部预置，Designer 不自主决定]
- 开发方案大方向: [由 Leader/Coordinator 预先提供]

---

## Data Model

### 核心实体

| 实体 | 说明 | 关键字段 | 关联实体 |
|------|------|---------|---------|
| [Entity] | [描述] | [字段列表] | [关联] |

### 数据流概要

```
[描述数据在核心实体间的流转路径]
```

---

## Constraints

### 性能约束

| 指标 | 目标 | 测量方式 |
|------|------|---------|
| P95 延迟 | < [N]ms | [工具/方式] |
| 吞吐量 | [N] req/s | [工具/方式] |

### 安全约束

- [ ] OWASP Top 10 合规
- [ ] 敏感数据加密（传输 TLS + 存储加密）
- [ ] 认证/授权机制（参考 constitution.md Security Baselines）
- [ ] 输入校验与防注入

### 合规约束

- [ ] 数据本地化要求（参考 constitution.md Compliance Constraints）
- [ ] 其他法规要求

---

## Performance Goals

| 目标 | 当前基线 | 目标值 | 验收方式 |
|------|---------|--------|---------|
| [目标] | [基线] | [目标值] | [验收方式] |

---

## 参照文档

- spec.md §[章节] — 功能需求与 API 设计
- constitution.md §[章节] — 治理约束
