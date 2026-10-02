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

// U-4 **证据通道**（盲跑判据 BR-2 的唯一可判定来源）
//   （【2026-10-02 · 内务批 波 2】随 `createLaneHeartbeat` 巨型函数拆分下沉，代码逐字搬移）：
//   原 `createLaneHeartbeat` 闭包内的 `resolvableArtifact` / `recordConsumeObservation` / `consumeCtxOf`
//   三个函数集中本文件；台账挂在内存 entry 上（随 entry 生命周期存活，**不新增真源**）。
import { statSync } from 'node:fs';
import { resolveArtifact } from './context.js';
import { laneConsumePathsOf } from './primitives.js';

// 可解析 = 存在**且非空**（与 gates.resolveArtifact/fileExistsNonEmpty 同口径；空文件不算就绪）。
// 只读、失败即静默（不存在/不可读/是目录 → false），永不 throw。
export function resolvableArtifact(cx, sessionId, batchId, rel) {
  try {
    const p = resolveArtifact(cx, sessionId, batchId, rel);
    const st = statSync(p);
    return st.isFile() && st.size > 0;
  } catch { return false; }
}
// 台账记录（**观测而非判定**）：只写「某时刻看到的可解析性」，不写任何 reason/candidate。
//   · resolvedAtTs：**首个可解析观测**的时刻（0 = 尚未观测到可解析）；
//   · neverResolvable：该窗内**从未**可解析（首个观测即全不可解析 → true；此后一旦可解析即翻 false）；
//   · observedTs：最近一次观测时刻（供「派发之后」的时序判定用，见 upstreamMissingEvidenceOf）；
//   · resolvableNow：最近一次观测的可解析性（BR-2 判「探针时刻不可解析」）。
// 台账挂在内存 entry 上，随 entry 生命周期存活（**不再有主动丢态路径**——见 tick 的非终态保留语义）；
//   进程/引擎重启 ⇒ 台账清空 ⇒ BR-2 证据缺失 ⇒ 不产候选（design §4.1 明文反例：宁可少报不误报）。
export function recordConsumeObservation(cx, entry, sessionId, batchId, batch, lane, nowTs) {
  const paths = laneConsumePathsOf(batch, lane);
  if (paths.length === 0) { entry.consumeObs = null; return; }
  let any = false;
  for (const rel of paths) {
    if (resolvableArtifact(cx, sessionId, batchId, rel)) { any = true; break; }
  }
  const prev = entry.consumeObs;
  const obs = {
    resolvedAtTs: any ? (prev?.resolvedAtTs > 0 ? prev.resolvedAtTs : nowTs) : (prev?.resolvedAtTs ?? 0),
    neverResolvable: any ? false : (prev ? prev.neverResolvable : true),
    observedTs: nowTs,
    resolvableNow: any,
    paths,
  };
  entry.consumeObs = obs;
}
// 判定侧入参：可解析性回调（judgeLongrun 的 resolveConsume）+ 台账快照（consumeObs）
export function consumeCtxOf(cx, sessionId, batchId, batch, lane, entry) {
  return {
    resolveConsume: (rel) => resolvableArtifact(cx, sessionId, batchId, rel),
    consumeObs: entry?.consumeObs ? { ...entry.consumeObs } : null,
  };
}
