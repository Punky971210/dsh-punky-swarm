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

// lib/assembly/snapshot.js —— §8③「解析结果落快照」的**写单点**（批次 `a3-snapshot-b1-20260915` · lane e1）。
//
// 定位（规格 §2 / §5 P1）：
//   · 快照是**派生观察档**，**不参与任何门禁判定**——判定面仍走 `resolveTeamFlows` 的实时解析
//     （`gates.ts` 的 `flowsOf`，热生效语义零变化）；快照只承载「建批那一刻解析到了什么」这一审计事实，
//     批次侧以 `batch.teamAsset`（指纹引用 + 键级摘要）指向它。
//   · 写时点 = **建批侧**（`store.createBatch` 事务内，与批次字段/事件同一次 atomicWrite；档**先于**批次落盘）。
//     **不得**把写盘挂到 `resolveTeamFlows`（读端）：那会把 `gate_status` / 面板 / 20+ 个判定点的共同取数入口
//     变成写者，与「只读视图绝不发射」（`store.js` 的写路径纪律）同族冲突（规格 §4.2）。
//   · 不塞进 `team-asset.js`（加载期校验单点，保其「解析器纯读」边界）、不塞进 `flows.js`（保其纯读单点）。
//
// 落点：会话级正档 `<sessionDir>/team-assets/<team>.<assetHash>.json`
//   —— 档名含**内容指纹** ⇒ 同内容幂等（no-op，不重写）；不同版本各留一档 = 资产变更史。
//   —— 批次侧只落指纹 + 键级摘要，**不复制资产正文、不复制完整 summary**。
//
// 边界（规格 §6）：无资产（`generic` / 拼错 / 退役团队）⇒ 只写 `ok:false` 字段，**不写档、不落事件**
//   （无内容可冻结 ⇒ 无 hash 可命名；失败事实由 `batch.teamAsset.ok:false` **字段**承担——原 `GATE_TEAM_ASSET_MISSING` 告警与码已删，见 `lib/tools/core.js:691-694`）。
//   有资产但解析失败 ⇒ 与成功路径同构（照写档 + 记 `resolved.ok:false`），跳过写盘 = 又一处空过点。
//   写档失败（目录不可写 / 满盘 / 竞态）⇒ 返回 `{ error }`（**不 throw**）：调用方告警 + 字段/事件双留痕，
//   **不拒建批**——观察面故障不升级为治理面拒态（解析本身没失败，失败的只是派生观察档）。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  packageRoot, resolveTeamFlows, declarationSummaryOf, flowOf, enabledByFlag, flagOf,
} from './flows.js';
import { loadTeamAsset, teamAssetSignature } from './team-asset.js';

/** 正档格式版本（`schema` 键；键集变化时才升，本批为 1）。 */
const SNAPSHOT_SCHEMA = 1;
/** 正档类型标记（防「同目录下别的 JSON 被当档读」）。 */
const SNAPSHOT_KIND = 'team-asset-snapshot';
/** 会话级档目录名（相对 `<sessionDir>`）。 */
const SNAPSHOT_DIR = 'team-assets';
/** 快照内 `summary` 的稳定子集（`declarationSummaryOf` 的读端投影；`unwired` 单独平铺、不当子对象）。 */
const SNAPSHOT_SUMMARY_KEYS = Object.freeze([
  'produceFields', 'produceFieldDeclared', 'consumeFields', 'consumeProblems',
  'entryRequires', 'flags', 'flagsResolved', 'contract', 'presenceGlobs', 'auditContract',
]);

/** 会话级档目录绝对路径。 */
function snapshotDirOf(sessionDirAbs) {
  return path.join(sessionDirAbs, SNAPSHOT_DIR);
}

/**
 * 内容指纹：`sha256(文件原始字节)` 前 16 位 hex（用于**内容等价的档命名/幂等**）。
 * 与既有 `assetSig`（路径+mtimeMs+size，用于**缓存新旧判定**）**不冲突、不互替**：
 *   同 hash ⇒ 同内容 ⇒ 同档；同 sig ⇒ 免重读。
 * 实现自建（约 5 行）：**不复用** `lib/governance/hash-utils.js` 的 `sha256Hex`（只接字符串，
 *   对文件字节不等价）、**不导出** `lib/state/archive.js` 的局部读字节函数（改动面更大）⇒ 零新依赖、零域外写。
 * @returns 16 位 hex；路径不可读/不存在 ⇒ `null`（调用方按「写档失败」处置）。
 */
function assetHashOf(assetPath) {
  if (typeof assetPath !== 'string' || assetPath.length === 0) return null;
  try {
    return createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

/** 档名 = `<team>.<assetHash>.json`（同 hash ⇒ 同名 ⇒ 同档）。 */
function snapshotFileNameOf(team, assetHash) {
  return String(team) + '.' + String(assetHash) + '.json';
}

/**
 * `flagsResolved`（快照内**只读派生键**）：`flags[layer+'.'+name] = {declared, value, effective}`，
 * 由 `flagOf` + `enabledByFlag` 现算 ⇒ 让「未声明 ⇒ 门禁生效侧（tighten-only）」在快照内可见。
 * 只进快照，**不改** `declarationSummaryOf` 的返回形状（保形，避免既有断言破）。
 */
function flagsResolvedOf(flows) {
  const out = {};
  for (const layer of ['plan', 'exec', 'audit']) {
    const f = flowOf(flows, layer);
    for (const name of ['targets', 'gate_command', 'needhuman']) {
      const value = flagOf(f, name);
      out[layer + '.' + name] = { declared: value !== null, value, effective: enabledByFlag(f, name) };
    }
  }
  return out;
}

/** 声明面**可读汇总**的稳定子集（复用单一读端 `declarationSummaryOf`，不新增第二套声明语义）。 */
function snapshotSummaryOf(flows, asset = null) {
  const raw = declarationSummaryOf(flows, asset) ?? {};
  const out = {};
  for (const k of SNAPSHOT_SUMMARY_KEYS) out[k] = k === 'flagsResolved' ? flagsResolvedOf(flows) : (raw[k] ?? null);
  return out;
}

/** 键级摘要（批次字段 `summaryKeys` 取数；只含键名/短值，**不含正文、不含完整 summary**）。 */
function summaryKeysOf(summary, unwired) {
  const s = summary ?? {};
  const entryRequires = s.entryRequires ?? {};
  return {
    produceFields: [...(s.produceFields?.exec ?? ['produce', 'outputs'])], // 被检面（恒并集，平面化）
    consumeFields: { ...(s.consumeFields ?? {}) },
    entryRequiresSource: Object.fromEntries(
      Object.entries(entryRequires).map(([l, v]) => [l, (v && v.source) ?? null]),
    ),
    flagsResolved: { ...(s.flagsResolved ?? {}) },
    contractSections: Array.isArray(s.contract?.required_sections) ? [...s.contract.required_sections] : null,
    unwiredKeys: (Array.isArray(unwired) ? unwired : []).map((d) => d.key),
  };
}

/**
 * 幂等写档：档已存在 ⇒ **no-op**（不重写，mtime 不变）；否则「先写 `.tmp` 再 rename」。
 * @returns `{ file, error }`——失败**不 throw**（调用方按 §6「告警 + 降级」处置）。
 */
function writeSnapshotFile(sessionDirAbs, team, assetHash, doc) {
  const dir = snapshotDirOf(sessionDirAbs);
  const file = path.join(dir, snapshotFileNameOf(team, assetHash));
  try {
    if (fs.existsSync(file)) return { file, error: null }; // 幂等：同 hash ⇒ 同内容 ⇒ 不重写
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, '.' + path.basename(file) + '.' + process.pid + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n'); // UTF-8 无 BOM + LF
    fs.renameSync(tmp, file);
    return { file, error: null };
  } catch (error) {
    return { file: null, error };
  }
}

/**
 * 建批时刻的解析 + 冻结：解析团队声明 → （有资产时）落会话级正档 → 产批次字段与事件载荷。
 * **档先于批次落盘**：批次写失败只留「无引用的孤儿档」（幂等、可重放、无害）；反之才会出现
 * 「批有引用、档不存在」的坏中间态。
 * @param {{sessionDirAbs: string, team: string, teamsRoot?: string|null, now?: Date}} input
 * @returns {{field: object, event: object|null, snapshotPath: string|null, warning: string|null}}
 *   `field` = `batch.teamAsset`（恒有）；`event` = `batch.team-asset.resolved` 载荷（无资产 ⇒ null）；
 *   `snapshotPath` = 相对 `<sessionDir>` 的档路径；`warning` = 写档失败的告警文案（成功 ⇒ null）。
 */
export function teamAssetRefOf({ sessionDirAbs, team, teamsRoot = null, now = new Date() }) {
  // 解析根与门禁**同源**（gates.ts `flowsOf` 的优先级 ①→③）：批次 `teamsRoot` → 缺省 = 包根。
  // 优先级 ②（DI 缝 `flowsRoot`）在建批侧不可达（`createStore` 不接收 flowsRoot）⇒ 不写 `flows-root` 枚举值。
  const rootKind = teamsRoot ? 'teams-root' : 'package';
  const root = path.resolve(teamsRoot ?? packageRoot());
  // P1（2026-09-16，D-3）：`?? 'generic'` 兜底已清退（建批面必填后成死码 ⇒ 防第二默认值真源）。
  //   缺 team ⇒ 空串（= 「无团队」事实，不再**代造成团队名**）；下游 `resolveTeamFlows('')` 如实走「无资产」路径。
  const teamName = typeof team === 'string' && team.trim().length > 0 ? team : '';
  const resolved = resolveTeamFlows(teamName, teamsRoot ? { root: teamsRoot } : {});
  // 整份资产（供未接线台账的**顶层键**读法：`state_machine` / `rework`——`resolveTeamFlows().flows` 只有子对象）
  const loaded = loadTeamAsset(teamsRoot ?? packageRoot(), teamName);
  const summary = snapshotSummaryOf(resolved.flows, loaded && loaded.asset ? loaded.asset : null);
  const unwired = Array.isArray(loaded?.unwired) ? loaded.unwired : [];
  const assetPath = typeof resolved.path === 'string' ? resolved.path : null;

  const base = {
    team: teamName,
    root,
    rootKind,
    assetPath,
    assetSig: assetPath ? teamAssetSignature(teamsRoot ?? packageRoot(), teamName) : null,
    assetHash: null,
    snapshotPath: null,
    resolvedAt: now.toISOString(),
    ok: resolved.ok === true,
    severity: resolved.severity ?? 'none',
    summaryKeys: summaryKeysOf(summary, unwired),
  };

  // 无资产：不写档、不落事件（只写 ok:false 字段；失败事实已由批次字段 + 既有告警通道承担）
  if (!assetPath) return { field: base, event: null, snapshotPath: null, warning: null };

  const assetHash = assetHashOf(assetPath);
  const problems = [...(resolved.problems ?? [])];
  const unwiredKeys = unwired.map((d) => d.key);
  const eventBase = {
    team: teamName, root, rootKind, assetPath, assetHash, ok: base.ok, severity: base.severity,
    snapshotPath: null, problems, unwiredKeys,
  };

  if (!assetHash) {
    // 内容指纹都取不到（读失败）⇒ 无档可命名，按「写档失败」处置（不 throw、不拒建批）
    const warning = '[dsh-punky-swarm] team-asset snapshot skipped (unreadable asset): ' + assetPath
      + ' —— 批次照建，快照字段记 snapshotWriteFailed:true';
    return {
      field: { ...base, snapshotWriteFailed: true },
      event: { ...eventBase, snapshotWriteFailed: true },
      snapshotPath: null,
      warning,
    };
  }

  let assetBytes = 0;
  try { assetBytes = fs.statSync(assetPath).size; } catch { assetBytes = 0; }
  const doc = {
    schema: SNAPSHOT_SCHEMA,
    kind: SNAPSHOT_KIND,
    writtenAt: now.toISOString(),
    team: teamName,
    root,
    rootKind,
    assetPath,
    assetSig: base.assetSig,
    assetHash,
    assetBytes,
    resolved: {
      ok: base.ok,
      severity: base.severity,
      blocking: resolved.blocking === true,
      problems,
      escalation: resolved.escalation ?? null,
    },
    summary,
    unwired, // 单独平铺（台账，非 flows 子对象）
  };

  const { file, error } = writeSnapshotFile(sessionDirAbs, teamName, assetHash, doc);
  const snapshotPath = file ? path.relative(sessionDirAbs, file).split(path.sep).join('/') : null;
  if (error) {
    const warning = '[dsh-punky-swarm] team-asset snapshot write failed: ' + String(error && error.message)
      + ' —— 批次照建（观察面故障不升级为治理面拒态），字段/事件记 snapshotWriteFailed:true';
    return {
      field: { ...base, assetHash, snapshotWriteFailed: true },
      event: { ...eventBase, snapshotWriteFailed: true },
      snapshotPath: null,
      warning,
    };
  }
  return {
    field: { ...base, assetHash, snapshotPath },
    event: { ...eventBase, snapshotPath },
    snapshotPath,
    warning: null,
  };
}