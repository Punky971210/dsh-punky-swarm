// lib/governance/receipt-model.js —— 拒因收据模型（**唯一**字段装配点）。
//
// 为什么单独成文件（批 `punky-guard-split-20261114` · 契约 §S-1.4 / §P-5 / §P-6）：
//   收据 schema 被**三条通道**共用 —— A 通道（护栏 pre，`lib/guard/wiring.js`）/ B 通道（工具面 guard，
//   `lib/tools/tier-gate.js`）/ C 通道（写族来源守卫，`lib/tools/write-provenance-guard.js`）。三者靠
//   **同一** `createRefusalReceipt` + **同一** `writeRefusal` 才能被 `verifyRefusals` 统一校验（锚链哈希
//   覆盖字段集）。护栏拆分后 A 通道在墙内（`lib/guard/**`）、B/C 在 core ⇒ 若墙内自建第二份收据写入器，
//   格式立刻漂移且不可审计（§P-6）。
//   ⇒ 本函数**逐字**自 `lib/governance/kernel.js`（HEAD `05b3e79` 的 `:174-194`）抽出、留 core，
//     墙内与 core 各自 import 它（`lib/governance/receipt-model.js` 在 PEER_LEAVES 冻结清单内）。
//   纪律：**纯函数 + 零外部读取**（只用 `crypto.randomUUID()` / `Date` / `structuredClone`）；收据 id 与 ts
//   是天然不确定面，由调用方归一化（探针 `normalizeReceipt`）抹掉，不参与判等。

function deepClone(v) {
    return structuredClone(v);
}

export function createRefusalReceipt(input) {
    const { tool, callId, sessionId, decision, attemptedParams } = input;
    const receipt = {
        receiptId: globalThis.crypto.randomUUID(),
        ts: new Date().toISOString(),
        tool,
        callId,
        sessionId: sessionId ?? null,
        decision: {
            primitive: decision.primitive,
            priority: decision.priority,
            reason: decision.reason,
        },
        attemptedParams: deepClone(attemptedParams),
        ruleRefs: [...decision.ruleRefs],
    };
    if (decision.narrowedParams !== undefined) {
        receipt.narrowedParams = deepClone(decision.narrowedParams);
    }
    return receipt;
}
