#!/usr/bin/env node
/**
 * check-v3-density.mjs — V3 信息密度检查脚本（S1–S4）
 *
 * 批次：punky-impl-takeover-0829 / lane e4（exec-roles-script 域）
 * 契约：v3-impl-pack.md（落点 A/B）+ v3-density-design.md §4.3（脚本可测规则）
 * 规则：
 *   S1 统计任务包顶层键数 >10 → FAIL（SKILL.md §任务包最小结构 json 示例）
 *   S2 Persona 行字符数 >50（CJK 计 1 字符）→ FAIL（roles/*.md ## Persona 段）
 *   S3 roles/*.md 中「约束」行与公共约束模板串匹配数 >0 → FAIL（收敛后应为 0，提示去重）
 *   S4 公共语义指针句在 roles 内出现：完整指针句 >0 → FAIL；压缩差异说明 >2 处 → FAIL
 *      （收敛后仅 manager/reviewer 差异说明可保留，≤2 处）
 * 用法：node skills/jiufeng-team/scripts/check-v3-density.mjs
 * 退出码：全 PASS = 0；任一 FAIL = 1
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..'); // skills/jiufeng-team/
const SKILL = path.join(ROOT, 'SKILL.md');
const ROLES_DIR = path.join(ROOT, 'references', 'roles');

/** 公共约束模板串（SKILL.md §worker 公共约束 单一来源）——去空白比较，防换行干扰 */
const PUBLIC_CONSTRAINT = '按真实用户行为操作（点击调用链，禁机器式调接口）；产物落盘 `artifacts/<batchId>/`；诚实披露（失败/异常如实记录）；回执简短结构化（对比表/清单）';
/** 完整指针句（收敛前 8 角色同句的旧长句） */
const FULL_POINTER = '协作方式公共语义（checkpoint 纪律 / 三层门禁 / 约束引用格式单一来源）见 SKILL.md §纪律要点 + §三层门禁 + 使用方式 §3 + references/workflow.md §二/§四';
/** 压缩差异说明（收敛后仅 manager/reviewer 保留） */
const COMPACT_POINTER = '协作方式：公共语义单一来源见 SKILL.md；本角色差异如下';

const strip = (s) => s.replace(/\s+/g, '');
const compactPublic = strip(PUBLIC_CONSTRAINT);
const compactFull = strip(FULL_POINTER);

const results = [];
const add = (id, pass, detail) => results.push({ id, pass, detail });

/* ---------- S1：任务包顶层键数 ---------- */
const sk = fs.readFileSync(SKILL, 'utf8');
const jsonBlock = sk.match(/```json\n([\s\S]*?)\n```/);
if (!jsonBlock) {
  add('S1', false, 'SKILL.md 未找到 ```json 任务包示例块');
} else {
  const block = jsonBlock[1];
  // 顶层键 = 块首行 `{ id, role, layer,` 内联键（整行逗号分隔）+ 恰好 2 空格缩进的独立行（内层 4 空格不匹配）
  const firstLine = (block.match(/^\{\s*([^\n]*)/m) || [])[1] || '';
  const inlineKeys = firstLine.split(',').map((k) => k.trim()).filter((k) => /^[a-zA-Z\u4e00-\u9fa5]+$/.test(k));
  const rowKeys = [...block.matchAll(/^  ([^ :{][^:]*?):/gm)].map((m) => m[1].trim());
  const keys = [...inlineKeys, ...rowKeys];
  const n = keys.length;
  add('S1', n <= 10, `任务包顶层键数 = ${n}（≤10 达标）；键：${keys.join(' / ')}`);
}

/* ---------- S2：Persona 长度 ---------- */
const roleFiles = fs.readdirSync(ROLES_DIR).filter((f) => f.endsWith('.md')).sort();
const over = [];
for (const f of roleFiles) {
  const c = fs.readFileSync(path.join(ROLES_DIR, f), 'utf8');
  const m = c.match(/## Persona[^\n]*\n([\s\S]*?)(?=\n## )/);
  const p = m ? m[1].trim() : '';
  if (p.length > 50) over.push(`${f}:${p.length}`);
}
add('S2', over.length === 0, over.length === 0
  ? `Persona 全部 ≤50 字（${roleFiles.length} 角色）`
  : `超限：${over.join('，')}`);

/* ---------- S3：公共约束行去重（roles 内不再内联全文） ---------- */
const s3hits = [];
for (const f of roleFiles) {
  const c = fs.readFileSync(path.join(ROLES_DIR, f), 'utf8');
  if (strip(c).includes(compactPublic)) s3hits.push(f);
}
add('S3', s3hits.length === 0, s3hits.length === 0
  ? 'roles 内无公共约束全文内联（全部指针化 SKILL.md 单一来源）'
  : `仍内联公共约束全文：${s3hits.join('，')}（改为「公共约束见 SKILL.md §worker 公共约束」）`);

/* ---------- S4：公共语义指针句收敛（完整句 0；压缩说明 ≤2 处） ---------- */
const s4Full = [];
const s4Compact = [];
for (const f of roleFiles) {
  const c = fs.readFileSync(path.join(ROLES_DIR, f), 'utf8');
  if (strip(c).includes(compactFull)) s4Full.push(f);
  if (c.includes(COMPACT_POINTER)) s4Compact.push(f);
}
const s4Ok = s4Full.length === 0 && s4Compact.length <= 2;
add('S4', s4Ok,
  `完整指针句出现 ${s4Full.length} 处（要求 0：${s4Full.join('，') || '无'}）；压缩差异说明 ${s4Compact.length} 处（要求 ≤2：${s4Compact.join('，') || '无'}）`);

/* ---------- 汇总 ---------- */
const fails = results.filter((r) => !r.pass);
console.log('=== check-v3-density (S1–S4) ===');
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.detail}`);
}
console.log(`--- ${results.length - fails.length}/${results.length} PASS ---`);
process.exit(fails.length === 0 ? 0 : 1);
