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

//   运行时唯一调用方是测试的显式 DI（`{acList, ledger, readBlob}`）。装配侧真正挂载的是
//   `verify/mount.js` 的 `mountVerify`，它只订阅证据捕获 hook，**从不读 `mode`**。
import { createSelectorRegistry } from './selector.js';
import { createEvidenceRegistry } from './evidence.js';
import { readCapability } from '../assembly/schema.js'; // 装配开关经注册表 default 缺省合并

function worse(a, b) {
  const rank = { done: 0, failed: 1, blocked: 2 };
  const ra = a == null ? -1 : rank[a];
  const rb = b == null ? -1 : rank[b];
  return rb > ra ? b : a;
}

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
