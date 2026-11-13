// test/helpers/verdicts.mjs —— **隔离判据谓词的单点定义**（批 `punky-isolation-rootfix-20261101` · lane `p2-idle-window`）
//
// ## 为什么在这里（FU1-5）
//
// 原先四处测**同一事实**（「隔离根 / 归因」）却各有判据：
//   `G2` 三态 / `D2` 进程级 / `I-6a` 归因 / `D11` R-1 键空间 —— 全部定义在 `test/home-isolation.test.js` 内。
//   ⇒ **修一处不修另一处必然复发**（历史已发生：键空间漏归一化 ⇒ red 恒不可达）。
//   本模块把它们外移为**跨文件单点**（比「同文件内单点」更强：`p3-migrate` 再改测试文件时不会再撞）。
//
// ## 迁移纪律
//
// · **逐字搬移，零行为变更**（除下方 §归因双命中 的显式说明）；
// · 依赖（`normPath` / `sameFace` / `toPosix`）**一并搬出并由测试文件导入回来** ——
//   若就地复制一个副本，等于把「单点」变成两份，正违反本项目的；
// · 导出名与签名**保持不变**（测试文件只改 import，不改调用点）。
//
// ## 归因双命中（FU1-1 口径，**唯一实现点**）
//
// 「某项变化是否归因于我方写点」的判据在本模块 `g2Verdict` 内**只实现一次**，两条同时成立才算命中：
//   ① **路径命中**：`rel` 落在声明的归因键空间（`faceRel` / `isoRel` / `a2Rel` / `a3`）；
//   ② **内容命中**：条目声明了 `sha256`（= A3）时，必须与真实面**当前内容**逐字相等
//      （只比 rel 会把「常驻宿主写入同 rel 的不同版本」误判成我方产物 = 假泄漏）。
import fs from 'node:fs';
import path from 'node:path';

/** 路径归一化：解析最近存在祖先 + 未解析尾部拼回；win32 小写。 */
export function normPath(p) {
  // 解析最近的存在祖先后拼回未解析的尾部（被测落点常常尚不存在，不能直接 realpath）。
  // 两侧口径必须一致：Windows 临时目录会以 8.3 短名（ADMINI~1）出现，与长名混用会让同一条路径比不相等。
  let cur = path.resolve(String(p ?? ''));
  const tail = [];
  for (;;) {
    try { cur = fs.realpathSync.native(cur); break; } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  const out = tail.length ? path.join(cur, ...tail) : cur;
  return process.platform === 'win32' ? out.toLowerCase() : out;
}

/** 面快照四字段全等（green 判据的唯一实现）。 */
export const sameFace = (x, y) => !!x && !!y && x.exists === y.exists && x.count === y.count && x.sumBytes === y.sumBytes && x.digest === y.digest;

/**
 * 路径键归一化**单点**：面相对键统一用 posix（`/`）形态。
 *
 * ⚠ 2026-11-14 修正（批 `punky-g2-closeout-20261113` 收口期）：原实现是
 *   `String(p).split(path.sep).join('/')` —— 它按**当前平台**分隔符切分，于是在
 *   Windows 上能把 `punky-preset\agent.cordis.yml` 转成 posix，而在 **Linux/CI 上
 *   `path.sep === '/'` ⇒ 反斜杠不被切分 ⇒ 原样返回反斜杠键**。
 *   `home-isolation.test.js#D13-2b` 正是用「含反斜杠的键」验证自防御查找必命中
 *   ⇒ 在 ubuntu-latest 上必然 miss（本地 Windows 恒绿，故长期未被发现）。
 *   ⇒ 改为**无条件把所有反斜杠替换为正斜杠**：语义就是「归一成 posix」，与平台无关。
 */
export const toPosix = (p) => String(p).replace(/\\/g, '/');

/** G1 谓词：homedir 必须等于声明的隔离根，且不等于真实 home。 */
export function g1Verdict(homedirValue, sentinelValue, realHomeValue) {
  const sentinel = String(sentinelValue ?? '').trim();
  const reasons = [];
  if (!sentinel) reasons.push('未声明隔离根（进程未加载隔离 preload）');
  if (sentinel && normPath(homedirValue) !== normPath(sentinel)) {
    reasons.push(`os.homedir()=${homedirValue} 不等于声明的隔离根=${sentinel}`);
  }
  if (sentinel && realHomeValue && normPath(sentinel) === normPath(realHomeValue)) {
    reasons.push('声明的隔离根就是真实 home');
  }
  if (realHomeValue && normPath(homedirValue) === normPath(realHomeValue)) {
    reasons.push('os.homedir() 仍在真实 home');
  }
  return { ok: reasons.length === 0, reasons };
}

/** G3 谓词：每条写入落点都必须位于隔离根之下。 */
export function attributionVerdict(writtenPaths, isolatedRoot) {
  const root = normPath(isolatedRoot);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  const outside = [];
  for (const p of writtenPaths) {
    const n = normPath(p);
    if (n !== root && !n.startsWith(prefix)) outside.push(p);
  }
  return { ok: outside.length === 0, outside };
}

/** 路径级 diff（added / removed / changed），供证据结构与归因使用。 */
export function faceDiff(before, after) {
  const b = new Map((before?.files ?? []).map((f) => [f.rel, f]));
  const a = new Map((after?.files ?? []).map((f) => [f.rel, f]));
  const added = [...a.keys()].filter((k) => !b.has(k)).sort();
  const removed = [...b.keys()].filter((k) => !a.has(k)).sort();
  const changed = [...a.keys()].filter((k) => b.has(k) && (b.get(k).sha256 !== a.get(k).sha256 || b.get(k).size !== a.get(k).size)).sort();
  return { added, removed, changed };
}

/**
 * 三态判定（纯函数）。
 * 判定顺序：green（四字段全等）→ transient（after2 == before）→ red（差异项 ∩ attributed ≠ ∅）→ unattributable。
 * 残量上界（规格 §三.3，如实写死，不得读作"已覆盖"）：
 *   · 已存在路径的字节覆盖且内容与同步产物相同 ⇒ 无法区分写者 ⇒ unattributable；
 *   · 已存在路径被删除且无自报 ⇒ 收敛则 transient，否则 unattributable；
 *   · 仅 mtime 变化而字节相同 ⇒ unattributable（cpSync 跨卷可能不保留 mtime）。
 */
export function g2Verdict({ face, before, after, after2, attributed = [], faceMap = null }) {
  const delta = faceDiff(before, after);
  // 键空间统一 posix：walkFiles 的 rel 在 Windows 下是反斜杠，而归因键（A1/A3）统一 posix。
  // 不归一化 ⇒ diffSet.has(rel) 恒假 ⇒ red 又变得不可达（D11 正是抓到这一点）。
  // 归一化统一走模块级 toPosix（单点；本函数内的 diffPaths 与归因键都经它）
  const diffPaths = [...delta.added, ...delta.removed, ...delta.changed].map(toPosix);
  if (sameFace(before, after)) {
    return { face, status: 'green', delta, diffPaths: [], attribution: { hits: [], unresolved: [], unmatched: [], bySource: { faceRel: 0, isoRel: 0, a2Rel: 0, a3: 0 }, keySpace: 'faceRel', faceMapProvided: typeof faceMap === 'function' }, evidence: { before, after, after2: after2 ?? null } };
  }
  if (after2 && sameFace(before, after2)) {
    return { face, status: 'inconclusive', subclass: 'transient', delta, diffPaths, reason: '差异在 settleMs 内收敛（并发 syncDir 的 rm+cp 中间态）', evidence: { before, after, after2 } };
  }
  // ── 键空间对齐（P0 真缺陷修复）────────────────────────────────────────────
  // diffPaths 恒为**面相对**（相对该 REAL_FACE 根）。attributed 允许两种粒度：
  //   · 扁平字符串 / {kind:'faceRel'} ⇒ 已是面相对，直接比（D5 的既有用法保持不变）；
  //   · {kind:'isoRel'|'a2Rel'} ⇒ **必须先经 faceMap 映射为面相对**再比；映射不到 ⇒ 记 unresolved
  //     （键空间不一致不得被静默当成"不归因"，否则 red 恒不可达且无从发现）。
  const diffSet = new Set(diffPaths);
  // 【FU1-1 修复】A3 归因必须**真比内容**：真实面当前内容的 sha256（按 posix rel 索引）。
  //   旧实现只比 rel ⇒ 常驻宿主写入**不同版本内容**到同一 rel（开发机常态）就被判成「我方产物」= 假泄漏。
  //   现在：条目带 `sha256` 时，只有「我方内容 == 真实面当前内容」才算归因；不相等 ⇒ 进 unmatched（可见、不静默）。
  const faceHashByRel = new Map((after?.files ?? []).map((f) => [toPosix(f.rel), f.sha256]));
  const hits = [];
  const unresolved = [];      // 键空间**解析不了** / 调用方声明的**期望键**未命中
  const unmatched = [];       // 候选枚举（对象条目）未命中 / **内容不匹配**：允许，但必须可见（不静默）
  const bySource = { faceRel: 0, isoRel: 0, a2Rel: 0, a3: 0 };
  for (const item of attributed ?? []) {
    const isStr = typeof item === 'string';
    const kind = isStr ? 'faceRel' : (item.kind ?? 'faceRel');
    const rel = String(isStr ? item : item.rel);
    if (kind === 'faceRel') {
      bySource.faceRel += 1;
      // 自防御：扁平 faceRel 可能是 `path.join(...)` 拼出的**反斜杠**键（面相对键本就含子目录，
      // 这不是假想情形）。命中后统一以**归一化后的 posix 键**入 hits；归一化后仍不命中 ⇒ 显式进 unresolved
      // （与 isoRel/a2Rel 通道对齐，**不得静默跳过**——faceRel 曾是唯一没有 unresolved 通道的 kind）。
      const normalized = toPosix(rel);
      const matchedRel = diffSet.has(rel) ? rel : (diffSet.has(normalized) ? normalized : null);
      // 内容口径（**双命中的第二腿，唯一实现点**）：条目声明了 sha256（= A3）时，
      //   必须与真实面**当前内容**逐字相等
      const declaredSha = (item && typeof item === 'object' && typeof item.sha256 === 'string' && item.sha256.length > 0)
        ? item.sha256 : null;
      const faceSha = faceHashByRel.get(normalized) ?? null;
      const contentMatched = declaredSha === null ? true : (faceSha !== null && faceSha === declaredSha);
      if (matchedRel !== null && contentMatched) {
        hits.push({ rel: normalized, kind, source: item?.source ?? 'faceRel' });
      } else if (matchedRel !== null && !contentMatched) {
        // 路径命中但**内容不同** ⇒ 不是我们的产物（常驻宿主写的另一版本）⇒ 不得计为泄漏，但必须可见
        unmatched.push({ rel: normalized, kind, source: item?.source ?? 'faceRel', reason: 'content-mismatch' });
      } else if (isStr) {
        // 扁平字符串 = 调用方声明的**期望键** ⇒ 未命中就是问题（键空间/期望写错），进 unresolved
        unresolved.push({ rel, kind, reason: 'raw-faceRel-unmatched' });
      } else {
        // 对象条目 = **候选枚举**（如 A1 把隔离根文件全列出来）⇒ 大多数本就不该命中，
        // 允许未命中，但记入 unmatched 保持可见（不得静默跳过）。
        unmatched.push({ rel: normalized, kind, source: item?.source ?? 'faceRel' });
      }
      continue;
    }
    const mapped = typeof faceMap === 'function' ? faceMap(rel, kind) : null;
    bySource[kind] = (bySource[kind] ?? 0) + 1;
    if (!mapped) { unresolved.push({ rel, kind }); continue; }
    if (diffSet.has(mapped)) {
      hits.push({ rel: mapped, kind, from: rel, source: item?.source ?? kind });
    } else {
      // 第四通道（p2 读码发现）：**映射成功但未命中**。修复前这里**没有 else**
      // ⇒ hits / unresolved / unmatched 三处全不记（连桶都没有）。现归入 unmatched（与"候选枚举未命中"同桶）。
      unmatched.push({ rel: mapped, kind, from: rel, source: item?.source ?? kind, reason: 'mapped-but-unmatched' });
    }
  }
  const attribution = { hits, unresolved, unmatched, bySource, keySpace: 'faceRel', faceMapProvided: typeof faceMap === 'function' };
  if (hits.length > 0) {
    return { face, status: 'red', delta, diffPaths, attributedHits: hits.map((h) => h.rel), attribution, reason: '差异持久且可归因于被测运行（差异项 ∩ 被测产物面 ≠ ∅）', evidence: { before, after, after2: after2 ?? null } };
  }
  return { face, status: 'inconclusive', subclass: 'unattributable', delta, diffPaths, attribution, reason: '差异持久且不可归因（外来写者的终态改动 / 写者不可区分）', evidence: { before, after, after2: after2 ?? null } };
}
