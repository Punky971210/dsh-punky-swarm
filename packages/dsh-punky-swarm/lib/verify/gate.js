/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

// verify/gate.js —— 完成闸门三态裁决（借鉴 dsh-verification CompletionGate）
// 三态：done / failed / blocked；模式 advisory（默认只记录不拦截）/ enforce（显式装配启用则拦截）。
// **本闸未接线（A1-P2-11）**：本文件**无生产消费点** —— 全仓 `lib/**` 的唯一引用是注释，
//   运行时唯一调用方是测试的显式 DI（`{acList, ledger, readBlob}`）。装配侧真正挂载的是
//   `verify/mount.js` 的 `mountVerify`，它只订阅证据捕获 hook，**从不读 `mode`**。
//   ⇒ `capabilities.verify.mode:'enforce'` 在本文件的**纯函数语义**里成立（`evaluateGate` 的
//   `intercepted` 分支不变），但**在装配面不生效**：配 enforce 得到的仍是 advisory 裁决。
//   `mountVerify` 会在该配置下输出一条明确 warn（不再静默）。接线 or 退役 = 未决取向，
//   见 `docs/governance-technical.md`（本批只做「不再静默」，**不改任何判定语义**）。
// 审计消费桥接（**报告渲染器已删**）：audit lane 消费 exec 产物 + evidence → `evaluateAcEvidence` 产出裁决对象；
//   原「裁决报告渲染器」随批 `punky-closeout-20261023`（裁决 Q-9@closeout）
//   删除（B1 实测零引用）⇒ **报告文本格式不再是本文件契约**：将来接线时由 audit lane 自定格式，本文件只保
//   「裁决对象」这一内容层增强（既有 gates.js 零改动）。
//   ⚠ 本注释刻意**不裸写被删符号名**：机检判据是「全仓零命中」，裸写会让判据恒假红。
import { createSelectorRegistry } from './selector.js';
import { createEvidenceRegistry } from './evidence.js';
import { readCapability } from '../assembly/schema.js'; // 装配开关经注册表 default 缺省合并

// 状态劣化序：done < failed < blocked（blocked 需人工，优先级最高）；null 视为最低（-1）
function worse(a, b) {
  const rank = { done: 0, failed: 1, blocked: 2 };
  const ra = a == null ? -1 : rank[a];
  const rb = b == null ? -1 : rank[b];
  return rb > ra ? b : a;
}

// 完成闸门三态裁决（纯函数）：
//   acBindings: [{ acId, selectorRef }]（AC 清单经 freeze+bind 后的形态）
//   evidence:   { bindingsFor(acId) => [{selectorRef, blobKey}], readBlob(key) => evidence }（注册表+store 适配）
//   mode:       'advisory'（默认，只记录不拦截）| 'enforce'（拦截，status!==done 时 intercepted=true）
// 裁决规则：缺绑定 → failed「Missing evidence for AC x」；绑定但证据不满足 → failed+detail；
//   损坏/截断 blob（读校验 fail closed）→ blocked（需人工）；证据为工具错误 → failed；至少一条成功证据 → done。
function evaluateGate({ acBindings = [], evidence = null, mode = 'advisory' }) {
  if (!Array.isArray(acBindings)) throw new Error('evaluateGate: acBindings must be an array');
  if (mode !== 'advisory' && mode !== 'enforce') throw new Error('evaluateGate: mode must be advisory|enforce');
  if (typeof evidence?.bindingsFor !== 'function' || typeof evidence?.readBlob !== 'function') {
    throw new Error('evaluateGate: evidence must provide bindingsFor(acId) and readBlob(key)');
  }
  const defects = [];
  let status = 'done';

  for (const ac of acBindings) {
    if (!ac || typeof ac.acId !== 'string') continue;
    const bound = evidence.bindingsFor(ac.acId);
    if (bound.length === 0) {
      defects.push({ acId: ac.acId, selectorRef: ac.selectorRef ?? null, code: 'MISSING_EVIDENCE', detail: 'Missing evidence for AC ' + ac.acId });
      status = worse(status, 'failed');
      continue;
    }
    let acStatus = null;
    for (const b of bound) {
      let blob;
      try {
        blob = evidence.readBlob(b.blobKey);
      } catch (e) {
        // 损坏 blob fail closed → 需人工（不可用疑似损坏的内容做裁决）
        defects.push({ acId: ac.acId, selectorRef: b.selectorRef, code: 'EVIDENCE_UNREADABLE', detail: String(e?.message ?? e) });
        acStatus = worse(acStatus, 'blocked');
        continue;
      }
      if (blob.truncated === true) {
        defects.push({ acId: ac.acId, selectorRef: b.selectorRef, code: 'EVIDENCE_TRUNCATED', detail: 'evidence over ' + (blob.note ?? 'limit') + ' — needs human review' });
        acStatus = worse(acStatus, 'blocked');
        continue;
      }
      if (blob.ok === false) {
        defects.push({ acId: ac.acId, selectorRef: b.selectorRef, code: 'EVIDENCE_ERROR', detail: 'tool ' + blob.tool + ' failed: ' + (blob.error ?? 'unknown') });
        acStatus = worse(acStatus, 'failed');
        continue;
      }
      acStatus = worse(acStatus, 'done'); // 至少一条成功证据
    }
    if (acStatus) status = worse(status, acStatus);
  }

  // advisory 只记录不拦截；enforce 显式拦截并返回缺陷清单
  const intercepted = mode === 'enforce' && status !== 'done';
  return {
    status,
    defects,
    mode,
    intercepted,
    message: intercepted
      ? 'verify gate blocked: ' + status + ' (' + defects.length + ' defect(s)) — see defects'
      : (defects.length ? 'verify gate recorded ' + defects.length + ' defect(s) in advisory mode' : 'verify gate passed'),
  };
}

// 审计消费桥接主入口：AC 清单 × 捕获台账 → 绑定 → 三态裁决。
//   acList:  [{ id, tool, args }]（audit lane 任务包携带，源自 spec.md「## 验收标准」）
//   ledger:  捕获台账条目（readLedger 输出，含 selectorKey/blobKey）
//   readBlob: evidence store 的 readBlob（注入，保持 gate 纯逻辑可测）
//   mode:    advisory | enforce
export function evaluateAcEvidence({ acList = [], ledger = [], readBlob, mode = 'advisory' }) {
  const selectors = createSelectorRegistry();
  selectors.bindAll(acList); // 重复 selector / 重复 AC 在此拒绝（V1）
  const registry = createEvidenceRegistry();
  const acBindings = selectors.list().map((s) => ({ acId: s.acId, selectorRef: s.selectorRef }));
  for (const entry of ledger) {
    const acId = selectors.matchByKey(entry.selectorKey); // exact-only 全等匹配
    if (acId) registry.bindEvidence(acId, acId + ':' + entry.selectorKey, entry.blobKey);
  }
  const result = evaluateGate({
    acBindings,
    evidence: { bindingsFor: (id) => registry.bindingsFor(id), readBlob },
    mode,
  });
  return { acBindings, bindings: registry, result };
}

// 完成闸门工厂：config.capabilities.verify.{enabled, mode}——缺省默认开（readCapability 合并
//   注册表 default VERIFY_DEFAULTS {enabled:true, mode:'advisory'}）；显式 enabled:false 时 evaluate
//   返回 skipped（无裁决、零运行时开销）；enforce 仅显式装配启用。
export function createCompletionGate({ config = {}, mode } = {}) {
  const vcfg = readCapability(config, 'verify') ?? {};
  const enabled = vcfg.enabled === true;
  const effMode = mode ?? vcfg.mode ?? 'advisory';
  return {
    enabled,
    mode: effMode,
    evaluate(args) {
      if (!enabled) return { status: 'done', defects: [], mode: effMode, skipped: true, intercepted: false };
      return evaluateGate({ ...args, mode: effMode });
    },
  };
}
