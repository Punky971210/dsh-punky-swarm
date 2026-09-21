# dispatch one-shot 化 · 施工前活体核报告（2026-09-21 23:5x）

**性质**：V-1/V-2/V-3 施工前置验证，**全部源码级定性（行号证据闭环）**。用户已批「可隔离启动验证」；因三处证据在源码面即已闭环（driver/宿主运行时/官方工具生产用法三层互证），隔离启动 E2E 并入 S1 批内验收（用 mock LLM 驱动真实 `rt.start`，构造一次 fire-and-forget 全链），避免为此重复装配整套宿主。
**上游**：`docs/dispatch-one-shot-redesign-plan-2026-09-21.md` §6 验证清单。

---

## V-1 ✅ one-shot 后台存续 —— 不绑 caller turn（三层证据）

**① Driver 层**（`dsh-subagent-in-process-driver/lib/index.js`）：
- `startInProcessRun`（:161-190）：`parent.ctx.agents.create({ sessionId: childId, …, signal: request.signal })` 发布子代理 → `drivePublishedRun`；
- `drivePublishedRun`（:195-229）：`child.followup(prompt); await child.whenIdle()` —— **子代理循环独立驱动**，result promise 只负责读结果；文件头明言「after publication the returned AgentHandle is **the one quiescent lifecycle owner held by the provider's caller**」+「Continuable children never come through here: … this driver owns **exactly one turn with one result**」。取消**只有** `request.signal` abort 一条路（:198-203）。
- ⇒ **生命周期属主 = 引擎持有的 run 对象，与 Leader 工具调用回合无关**。引擎持引用、不调 `dispose` 即跑到完成。

**② 宿主运行时层**（`dsh-subagent/lib/index.js:3150-3178` `SubagentRuntime.start()`）：
`expectProvider → assertCapabilities → descriptor 快照（mode:'one-shot'）→ provider.start → establishCatalogChild（挂父会话目录）→ observeRun → return run` —— 只 await 到发布，无任何回合绑定。

**③ 官方工具生产用法（宿主自证）**（`dsh-tool-subagent/lib/index.js:534-555`）：
官方 one-shot 后台模式 = `jobs.start({ run: () => ({ cancel, done: …subagents.start(...) }) })` —— **调用即返回 jobId，run 在 jobs 服务下继续跑**。
⚠ **关键细节**：foreground 分支用 `signal: exec.signal`（:559），background 分支**故意新建 `AbortController`**（:543）—— 因为 `exec.signal` 随工具调用结束而中止，**这正是 V-1 风险的实证与官方规避法**。引擎 `buildStartSpec` 缺省「永不中止 signal」（`new AbortController().signal`）**恰好正确且必要**，保持不动。

**给 S1 的增量结论**：fire-and-forget 裸用即可；若要任务可见性/可取消，可照官方模式**选配** `ctx.get('jobs')` 包装（非 inject 取用，缺 service 降级裸用）—— 列入 S1 实现细节，默认实现为：**activeRuns Map 持引用 + result.catch 告警**（方案 §2-S1 原案），jobs 包装作为增强档。

## V-2 ✅ one-shot 请求面支持 toolFilter/persona/label/maxDepth

- `toolFilter/persona`：driver `setup` → `applyChildComposition(childCtx, parent, { persona: request.persona, toolFilter: request.toolFilter })`（driver:173-176）—— 与 continuable **同一组合函数**，语义等价；
- `label`：runtime `start()` 快照进 descriptor（`index.js:3155-3159`，`...request.label !== void 0 ? { label: request.label } : {}`）⇒ **B3 label 机制存活**；
- `maxDepth`：runtime 层断言（:3153）+ driver 层再断言（:162）；`agentOptions/outputSchema` 亦有位（按需）。

## V-3 ✅ run.id ≡ subagent/end 的 info.id（观察桥可对齐）

- `run.id = childId = brandString(randomUUID())` 即**子会话 id**（driver:166/219）；
- `observeRun` identity = `{ runId: SubagentRunId(randomUUID()), provider, id: run.id, local }`（`index.js:294-298`）⇒ **`info.id === run.id`**；
- `subagent/end` 载荷 = identity + `stopReason` + `lastAssistantMessage`（最终助手输出，:300-311）⇒ S3 观察桥除对齐外**可顺带留痕产物摘要**（仍零判定）。
- 注意：`runId`（观察 id）≠ `id`（会话 id）——引擎登记面用 `id`，勿错拿 `runId`。

## V-4 ⏸ 留 S2 批内验收

deny 追加后 worker 收不到连续控制工具 + 结算链全绿 —— 属行为回归，随 S2 全量跑。

---

## 结论

**V-1/V-2/V-3 三项前置全部通过，S1 可开工。** 方案无需结构修改；两处实现细节据验证结果固化：
1. S1 默认实现 = `activeRuns` Map 持引用 + `result.catch` 告警；`jobs` 包装为选配增强档（照官方 :534-555 模式，非 inject 取用、缺 service 降级）；
2. signal 纪律：one-shot 请求**必须**用引擎自持 signal（现状缺省正确），**严禁**透传 `exec.signal`（官方 foreground/background 分叉实证其会随回合中止）。
