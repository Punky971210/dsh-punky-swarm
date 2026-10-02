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
// 门禁强度摘要 + 门禁视图三入口（`gateStatus` 兼容外壳 / 批级两入口）——
//   【2026-10-02 · 内务批 波 4】随 `createGates` 巨型函数拆分下沉；
//   依赖方向单向：`gates.ts`（组合器）→ 本文件，本文件不反向 import 组合器（零环）。
import { flowOf, produceFieldsOf, entryRequiresOf } from '../../assembly/flows.js';
import { taskOf } from './detect.js';
import * as EVT from '../event-types.js';
import fs from 'node:fs';
export function buildStatus(cx) {
    const { batchFile, checkPlanContract, completeOutcomesOf, consumeFieldNameOf, flowsOf, laneStartedAt, layersOf, orphanProductsOf, presenceOfArtifact, readBatch, unwiredEntriesOf, vocabOpts, vocabularyViewOf } = cx;
    // 门禁强度摘要（原则②的载体）：**只增不改** —— 纯只读视图，不参与任何门禁判定
    function gateStrengthOf(batch) {
        const layers = layersOf(batch);
        const flows = flowsOf(batch).flows;
        const layerFlow = (l) => flowOf(flows, l);
        const declaredProduce = {};
        // G-2（本批）：`entryRequires` 改读**单一读端** `entryRequiresOf(flow)` ⇒ 对象
        //   `{enforced, declared, values, source}`（**形态变化面**：原为 `string[]` 直读 `f.entry_requires`）。
        //   `lib/**` 内除本文件无消费点（grep 可核）；`test/**` 若断言该字段由 e3 同步。
        const entryRequires = {};
        for (const l of ['plan', 'exec', 'audit']) {
            const f = layerFlow(l);
            declaredProduce[l] = f && typeof f.produce_field === 'string' ? f.produce_field : null;
            entryRequires[l] = entryRequiresOf(f);
        }
        const af = layerFlow('audit');
        const ef = layerFlow('exec');
        // 【2026-09-28 · 批 `cleanup-tail-20260927` E-3】原 `ac`（`af.audit_contract` 提取）随下方恒不可达三元同批删除：
        //   资产面退役 ⇒ `flows` 恒 `null` ⇒ `af` 恒 `undefined` ⇒ `ac` 恒 `null` ⇒ 该变量**只服务恒 `null` 的三元**
        //   ⇒ 删三元后成死码，一并清除（`af` / `ef` 仍被下方 `disabled` 判据消费，保留）。
        const disabled = [];
        if (af && af.needhuman === false)
            disabled.push('needhuman@team-asset');
        if (ef && ef.gate_command === false)
            disabled.push('gate_command@team-asset');
        if (ef && ef.targets === false)
            disabled.push('targets@team-asset');
        if (String(process.env.GATE_ENABLED).toLowerCase() === 'false')
            disabled.push('all-gates@env');
        const evs = (batch.events ?? []);
        // V-4 读端单点化（本批）：事件名比较改引 `EVT` 常量（原为字节字面量 'gate.escape' / 'gate.degrade'）
        const escapes = evs.filter((e) => e && e.type === EVT.EVT_GATE_ESCAPE).map((e) => ({ kind: typeof e.kind === 'string' ? e.kind : null }));
        const degrades = evs.filter((e) => e && e.type === EVT.EVT_GATE_DEGRADE).map((e) => ({ kind: typeof e.kind === 'string' ? e.kind : null }));
        const outcomes = completeOutcomesOf(batch);
        return {
            level: layers.exec.length === 0 && layers.audit.length === 0 ? 'none' : 'strict',
            lanes: { plan: layers.plan.length, exec: layers.exec.length, audit: layers.audit.length },
            // G-2（本批）：被检面改读**单一读端** `produceFieldsOf(flow, layer)`（恒 `['produce','outputs']` 并集）——
            //   **形态变化面**：原为恒字面量串 `'produce∪outputs'`，现为数组（语义逐字相同：声明只能收窄不得放宽）。
            // S19①（判据同源）：`consumeField` 与 entry 检面同用 `consumeFieldOf`（缺声明回落 `'consume'`）。
            produceField: {
                plan: [...produceFieldsOf(layerFlow('plan'), 'plan')],
                exec: [...produceFieldsOf(layerFlow('exec'), 'exec')],
                audit: [...produceFieldsOf(layerFlow('audit'), 'audit')],
            },
            produceFieldDeclared: declaredProduce,
            entryRequires,
            consumeField: {
                exec: consumeFieldNameOf(flows, 'exec'),
                audit: consumeFieldNameOf(flows, 'audit'),
            },
            escapes,
            degrades,
            disabled,
            // S19② / S20：未接线声明改读**台账**（原为硬编码 4 项 ⇒ 与台账双源；台账更新不会生效）
            unwired: unwiredEntriesOf(batch),
            evaluatedAt: ['running', 'merged'],
            orphanProducts: orphanProductsOf(batch),
            emptyNoted: [],
            // 【2026-09-28 · 批 `cleanup-tail-20260927` E-3】原三元（`ac ? { … } : null`，其 `source` 值指向
            //   **团队资产**来源）已删：资产面退役 ⇒ `flows` 恒 `null` ⇒ `af`/`ac` 恒 `undefined`/`null`
            //   ⇒ 该三元**恒走 `null` 支**（恒不可达分支），其「团队资产」来源标注**恒不产生**
            //   ⇒ 键保形保留、值恒 `null`。
            auditContract: null,
            completeOutcomes: outcomes,
            completeSemantics: 'Q-7：complete = 执行完成且通过验收 ⇒ 仅 pass / skip 可 complete；fail / conflict 恒拒且带 escapeRoute{phase:"aborted"}（D-8 终态可退出）',
        };
    }
    // 门禁状态查询（gate_status 工具用）：lane 的 layer/契约字段/缺失清单/plan 契约问题。
    // 【TD-21 / N-13（2026-09-18 清理波）】读放大收敛——三个入口共用**同一 lane 计算实现**（`gateStatusOfLane`，
    //   单点，禁第二份判定），差别**只在读盘次数**：
    //     · `gateStatus`            = **兼容外壳**（逐 lane 调用方）：1 次读批 → 单 lane 视图；签名/返回形状/
    //                                  语义/抛错面**逐字不变**（`gate_status` 工具与 lib/tools/core.js 零改动）；
    //     · `gateStatusOfBatch`     = **批级入口**（1 次读批）→ `{lane: gateView}`，键序同 `batch.lanes`；
    //     · `gateStatusMapOfBatch`  = 批级入口的**对外稳定名**（`store.js` 暴露 / `api.js` 消费），返回**普通
    //                                  对象而非 `Map`**——响应键须 `[lane]` 可索引且 JSON 序列化键序与改前
    //                                  （`Object.fromEntries(Object.keys(b.lanes).map(...))`）逐字一致。
    //   回归锁（`test/api-batch-keys.test.js`）：P-2 = 批级视图逐 lane 与 `gateStatus` **深比较全等**；
    //   P-3 = 批级一次读（`fs.readFileSync` 计数：投影段 1 次，且不随 lane 数增长）。
    function gateStatus(sessionId, batchId, lane) {
        const batch = readBatch(sessionId, batchId);
        if (!batch) {
            // 损坏批次（文件存在但解析失败）→ 返回 corrupt 视图不 throw（读路径不 throw）；不存在 → throw
            if (fs.existsSync(batchFile(sessionId, batchId))) {
                return { lane, layer: null, state: null, team: null, corrupt: true, consume: [], produce: [], outputs: [], consumeMissing: [], outputsMissing: [], produceMissing: [], contractProblems: null, targets: [], targetsMissing: [], targetsUnchanged: [] };
            }
            throw new Error('batch not found: ' + batchId);
        }
        return gateStatusOfLane(sessionId, batchId, batch, lane);
    }
    // 单 lane 门禁视图（**已读批**：批对象由调用方传入 ⇒ 本函数零读盘）。三个入口的唯一计算实现。
    function gateStatusOfLane(sessionId, batchId, batch, lane) {
        const t = taskOf(batch, lane);
        // B2：lane 在 batch.lanes 但不在 wavePlan.tasks ⇒ 状态损坏，显式报 orphan（不再退化为 'generic'）
        if (!t) {
            return {
                lane, layer: null, state: batch.lanes[lane], gates: 'orphan', team: batch.team,
                consume: [], produce: [], outputs: [], consumeMissing: [], outputsMissing: [], produceMissing: [],
                contractProblems: null, targets: [], targetsMissing: [], targetsUnchanged: [],
                gateStrength: gateStrengthOf(batch),
                vocabulary: vocabularyViewOf(vocabOpts),
            };
        }
        // 面板与门禁同源（原则②）：缺失判定改走 presenceJudge（形态二分 + 0 字节 + 空内容通道），
        //   消除「面板说缺产物、门禁却放行」的不一致（gates.js 旧 fileExistsNonEmpty 的目录视同存在语义）。
        const missing = (field) => {
            const list = Array.isArray(t[field]) ? t[field] : [];
            return list.filter((p) => !presenceOfArtifact(sessionId, batchId, t.layer ?? null, p).ok);
        };
        const contract = t.layer === 'plan' ? checkPlanContract(sessionId, batchId, batch, lane) : null;
        // targets 探测：声明清单 + 缺失清单 + 未变更清单——仅 stat（存在性 + mtime 路径），
        // 不读文件正文（marker 命中判定留给门禁执行时，避免 gate_status 读文件成本，见 design Open Question 3）
        const targets = Array.isArray(t.targets) ? [...t.targets] : [];
        const startAt = laneStartedAt(batch, lane);
        const startMs = Date.parse(startAt);
        const statFile = (p) => { try {
            const st = fs.statSync(p);
            return st.isFile() ? st : null;
        }
        catch {
            return null;
        } };
        const targetsMissing = targets.filter((p) => statFile(p) === null);
        const targetsUnchanged = targets.filter((p) => {
            if (targetsMissing.includes(p))
                return false;
            const st = statFile(p);
            if (!st)
                return true; // 探测竞态：stat 失败视同未变更（保守）
            const mtimeMs = new Date(st.mtime).getTime();
            return !(Number.isFinite(mtimeMs) && Number.isFinite(startMs) && mtimeMs > startMs);
        });
        return {
            lane, layer: t.layer ?? null, state: batch.lanes[lane], team: batch.team,
            gates: t.layer ? 'in-plan' : 'no-layer',
            consume: t.consume ?? [], produce: t.produce ?? [], outputs: t.outputs ?? [],
            consumeMissing: missing('consume'), outputsMissing: missing('outputs'), produceMissing: missing('produce'),
            contractProblems: contract && !contract.ok ? contract.problems : null,
            targets, targetsMissing, targetsUnchanged,
            gateStrength: gateStrengthOf(batch),
            // R1 §2.4 #6：词表**只读展示位**（恰好 `{loaded,version,source}` 三键）——**不参与任何判定**：
            //   面板据此显示「本批判定所依的词表是否加载成功 / 版本 / 来源」，不得据此放行或拒绝任何 lane。
            //   词表不可用（fail-open 侧）⇒ `loaded:false` + 两 null（与词表门 E1/C3 的降级口径同源）。
            vocabulary: vocabularyViewOf(vocabOpts),
        };
    }
    // 批级门禁视图（TD-21 / N-13）：**一次读批** → `{lane: gateView}`（键序 = `batch.lanes` 键序）。
    // 读路径语义与 `gateStatus` 同口径（`readBatch` 私有单点）：不存在 ⇒ throw；损坏批 ⇒ 空视图
    //   （批级无 lane 名可枚举；逐 lane 口径下的 corrupt 视图仍由 `gateStatus` 提供，二者不冲突）。
    function gateStatusOfBatch(sessionId, batchId) {
        const batch = readBatch(sessionId, batchId);
        if (!batch) {
            if (fs.existsSync(batchFile(sessionId, batchId)))
                return {};
            throw new Error('batch not found: ' + batchId);
        }
        const view = {};
        for (const lane of Object.keys(batch.lanes ?? {}))
            view[lane] = gateStatusOfLane(sessionId, batchId, batch, lane);
        return view;
    }
    // 对外稳定名（`store.js` 暴露 / `api.js:138` 消费）：与 `gateStatusOfBatch` **同一实现、同一次读批**，
    //   不重复实现、不重复读盘（批级读放大收敛的对外契约名）。
    function gateStatusMapOfBatch(sessionId, batchId) {
        return gateStatusOfBatch(sessionId, batchId);
    }
    return { gateStrengthOf, gateStatus, gateStatusOfBatch, gateStatusMapOfBatch, gateStatusOfLane };
}
