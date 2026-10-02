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
// targets 门（存在性 + 变更性 mtime/marker 双模式）——
//   【2026-10-02 · 内务批 波 4】随 `createGates` 巨型函数拆分下沉；
//   依赖方向单向：`gates.ts`（组合器）→ 本文件，本文件不反向 import 组合器（零环）。
import { flowOf, enabledByFlag, flagOf } from '../../assembly/flows.js';
import { taskOf, smokeOf, contractMissingPayload, TARGETS_CLAIMED_RE } from './detect.js';
import fs from 'node:fs';
export function buildTargets(cx) {
    const { flowsOf, laneStartedAt } = cx;
    // targets 门禁：exec 层 lane 声明 targets（批次产物根外目标文件绝对路径）→ merged 前置校验
    // 每个 target：①存在性（statSync 为文件；缺失/目录 → missing）；②变更性——mtime 晚于 lane 变更性基线（laneStartedAt：排除 idle 空闲态重派）
    // （默认 mtime 路径），或 marker 逃生（任务级 targetsMarker 非空 或 env GATE_TARGETS_MODE==='marker' →
    // 目标文件内容含独立行 `targets-claimed: true` 即视为已变更，跳过 mtime 比对，两模式不叠加）；
    // 未声明 targets / 非 exec 层 / GATE_ENABLED=false → 零感知（{ ok: true, declared: false }，与 checkCommandGate 对称）。
    // 判定：missing 非空 → { ok:false, code:'GATE_TARGET_MISSING', missing }；unchanged 非空 →
    // { ok:false, code:'GATE_TARGET_UNCHANGED', unchanged }；全过 → { ok:true, declared:true, mode:'mtime'|'marker' }。
    // 诚实披露：mtime/marker 均为低成本实证（非密码学证据），防「口头声称零成本通过」；恶意伪造归人工审计。
    function checkTargetsGate(sessionId, batchId, batch, lane) {
        // 总开关（GATE_ENABLED=false → 全批零感知，应急逃生阀，与 checkCommandGate 同源）
        // S15（本批）：env 阀保留，命中补 `escape{kind:'env-gate-disabled', gate:'targets'}` 留痕（判定不变）。
        if (String(process.env.GATE_ENABLED).toLowerCase() === 'false') {
            return {
                ok: true, declared: false,
                escape: {
                    kind: 'env-gate-disabled', gate: 'targets', lane,
                    reason: 'GATE_ENABLED=false（应急逃生阀）⇒ targets 门零感知放行（判定不变）＋留痕',
                },
            };
        }
        const t = taskOf(batch, lane);
        if (!t || t.layer !== 'exec' || !Array.isArray(t.targets) || t.targets.length === 0) {
            return { ok: true, declared: false }; // 未声明 / 非 exec 层 → 零感知
        }
        // gate-lite Q-G1：冒烟/探针批 ⇒ 跳过 targets 门（存在性/变更性都属产物契约类）；
        //   留痕 `disabledBy` 使「为什么这个 smoke 批没跑 targets」在返回值里可读（与既有 disabledBy 同形）。
        if (smokeOf(batch))
            return { ok: true, declared: false, disabledBy: 'batch:smoke' };
        // 声明开关 flows.exec.targets——显式 false 则跳过 targets 校验（存在性+变更性）；缺声明 ⇒ 引擎基线启用（enabledByFlag strictDefault=true，非回落旧口径）
        // S18（本批）：团队级关闭**保留**（判定不变），但补 `escape{kind:'targets-off'}` 载荷留痕（零静默）；
        //   `targetsNoChange` / marker 两个**任务级**显式声明保持不动（既有 `mode` 留痕留待 `gate.target.passed`）。
        const efTargets = flowOf(flowsOf(batch).flows, 'exec');
        // B2（§8⑤ **P-5** targets）：targets 开关**未声明**（`flagOf(execFlow,'targets') === null`）⇒ 引擎基线启用
        //   ⇒ 产首触载荷；**显式 false** 已有独立 `escape{kind:'targets-off'}` 面（下方分支不挂钩）。
        const cmTargets = flagOf(efTargets, 'targets') === null
            ? contractMissingPayload('targets', 'exec', 'engine:enabledByFlag(targets,true)', 'targets-engine-default-enabled', '团队资产未声明 flows.exec.targets ⇒ 引擎基线启用（缺声明不得放宽）；本事件为首触留痕，不改判定')
            : null;
        if (!enabledByFlag(efTargets, 'targets', true)) {
            return {
                ok: true, declared: false, disabledBy: 'team-asset:targets',
                escape: {
                    kind: 'targets-off', lane,
                    reason: '团队资产显式声明 flows.exec.targets=false ⇒ targets 门停用（放行判定不变）＋留痕',
                },
            };
        }
        const startAt = laneStartedAt(batch, lane);
        const startMs = Date.parse(startAt);
        const markerMode = (typeof t.targetsMarker === 'string' && t.targetsMarker.length > 0)
            || String(process.env.GATE_TARGETS_MODE).toLowerCase() === 'marker';
        // 缺口修复：零改动声明（task.targetsNoChange === true）→ 只核目标存在性，跳过"变更性"判定；
        //   留痕 mode='no-change' + skippedChange=true（gate.target.passed 事件随 mode 落盘，可审计谁声明了零改动）。
        const noChange = t.targetsNoChange === true;
        const modeOf = () => (noChange ? 'no-change' : (markerMode ? 'marker' : 'mtime'));
        const missing = [];
        const unchanged = [];
        for (const target of t.targets) {
            let st;
            try {
                st = fs.statSync(target);
            }
            catch {
                missing.push(target);
                continue;
            }
            if (!st.isFile()) {
                missing.push(target);
                continue;
            } // 目录/非文件视同缺失（与 detectNeedHuman 文件判定同源）
            if (markerMode) {
                let claimed = false;
                try {
                    claimed = TARGETS_CLAIMED_RE.test(fs.readFileSync(target, 'utf8'));
                }
                catch { /* 读失败 → 视为未声明（fail-closed，落到 unchanged） */ }
                if (claimed)
                    continue; // 标记命中 → 视为已变更（跳过 mtime 比对）
                unchanged.push(target);
                continue;
            }
            // mtime 主路径（默认）：目标文件 mtime 必须晚于 lane 变更性基线（laneStartedAt：最近一条**非 idle 空闲态重派**的
            // running 启动——review→running 返工重置基准；idle→running 恢复重派不后移基线，详见 laneStartedAt 注释）
            if (noChange)
                continue; // 零改动声明 → 只核存在性（上面 missing 分支已排除缺失）
            const mtimeMs = new Date(st.mtime).getTime();
            if (!(Number.isFinite(mtimeMs) && Number.isFinite(startMs) && mtimeMs > startMs))
                unchanged.push(target);
        }
        if (missing.length > 0) {
            return { ok: false, declared: true, code: 'GATE_TARGET_MISSING', missing, unchanged: [], mode: modeOf(), targets: [...t.targets] };
        }
        if (unchanged.length > 0) {
            return { ok: false, declared: true, code: 'GATE_TARGET_UNCHANGED', missing: [], unchanged, mode: modeOf(), targets: [...t.targets] };
        }
        return { ok: true, declared: true, missing: [], unchanged: [], mode: modeOf(), skippedChange: noChange, targets: [...t.targets], ...(cmTargets ?? {}) };
    }
    return { checkTargetsGate };
}
