#!/usr/bin/env node
// bus 自证入口（可执行）：`node lib/bus/selftest.mjs`
//
// 退出码：0 = 全部检查通过；1 = 有检查失败（**含反向开关模式下的「缺陷已复现」**）。
//
// 模式：
//   node lib/bus/selftest.mjs               　→ 正向：四条加固 + 否定对照 + 四动作探针，全绿才 0
//   node lib/bus/selftest.mjs --break=f1    → 关掉 F-1 加固 ⇒ **必须红**（证明该行在起作用）
//                                             --break=f2 / f3 / f4 同理
//
// 设计要点：每条反例的「反向开关」是**同一个实现里的一个分支**（`harden.<fN>=false`），
//   不是另写一份缺陷实现 —— 否则「复现」证明不了任何东西。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBus, createNullAdapters, runMinimalBatch } from './index.js';
import { BUILTIN_ROLES } from '../roster.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const results = [];
const record = (id, ok, readout) => {
  results.push({ id, ok, readout });
  console.log((ok ? 'PASS ' : 'FAIL ') + id + '  ' + readout);
};

// ── C0 形状对账：PORT_SLOTS（= null 适配器键集）⟷ lib/ports.ts#KernelPorts ──────────
function checkShapeReconciliation() {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'ports.ts'), 'utf8');
  const block = src.match(/interface KernelPorts\s*\{([\s\S]*?)\n\}/);
  if (!block) return record('C0 shape', false, 'lib/ports.ts 内未找到 interface KernelPorts');
  const fromPorts = new Set([...block[1].matchAll(/^\s{2}([A-Za-z_]\w*)\??:/gm)].map((m) => m[1]));
  const fromBus = new Set(Object.keys(createNullAdapters()));
  const onlyPorts = [...fromPorts].filter((k) => !fromBus.has(k));
  const onlyBus = [...fromBus].filter((k) => !fromPorts.has(k));
  const ok = onlyPorts.length === 0 && onlyBus.length === 0;
  return record('C0 shape', ok, 'ports.ts=' + JSON.stringify([...fromPorts]) + ' bus=' + JSON.stringify([...fromBus])
    + (ok ? '  (集合相等)' : '  多出=' + JSON.stringify(onlyBus) + ' 缺失=' + JSON.stringify(onlyPorts)));
}

// ── C1 · F-1 可选端口被当必需直用 ────────────────────────────────────────────────
async function checkF1(harden) {
  // 构造：只给必需两项（runtime/audit）；roster 显式为 null ⇒ 可选缺失
  const ports = { runtime: createNullAdapters().runtime, audit: createNullAdapters().audit, roster: null };
  const bus = createBus({ ports, harden });
  try {
    const routed = await bus.route('coder');
    const degrades = bus.report().degrades.map((d) => d.slot);
    const ok = degrades.includes('roster');
    return record('F-1 可选端口', ok,
      'route() 未抛；degrades=' + JSON.stringify(degrades) + '；seat=' + String(routed?.seat));
  } catch (err) {
    // 反向开关下这里必须命中：TypeError: Cannot read properties of null (reading 'read')
    return record('F-1 可选端口', false, 'THREW ' + String(err?.constructor?.name) + ': ' + String(err?.message));
  }
}

// ── C2 · F-2 降级不可见（三个可选同时缺、必需齐）──────────────────────────────────
function checkF2(harden) {
  const nulls = createNullAdapters();
  const bus = createBus({ ports: { runtime: nulls.runtime, audit: nulls.audit }, harden });
  const rep = bus.report();
  const capabilityRecords = rep.capabilityRecords ?? [];
  const optionalAllMissing = ['roster', 'tools', 'http'].every((slot) => rep.missing.includes(slot));
  const ok = optionalAllMissing && capabilityRecords.length >= 1;
  return record('F-2 降级可见', ok,
    'missing=' + JSON.stringify(rep.missing) + '；capability-*记录=' + JSON.stringify(capabilityRecords));
}

// ── C3 · F-3 两路径形状不一致 ────────────────────────────────────────────────────
async function checkF3(harden) {
  const base = { runtime: createNullAdapters().runtime, audit: createNullAdapters().audit };
  const viaNull = createBus({ ports: { ...base, roster: null }, harden });
  const viaReal = createBus({
    ports: { ...base, roster: { read: () => [{ name: 'coder' }, { name: 'lead' }] } },
    harden,
  });
  const a = await viaNull.route('coder'); // 内建路径
  const b = await viaReal.route('coder'); // 端口路径（返回等价 Row）
  const ka = JSON.stringify(Object.keys(a).sort());
  const kb = JSON.stringify(Object.keys(b).sort());
  const ok = ka === kb;
  return record('F-3 形状一致', ok, 'null路径键=' + ka + ' 真实端口路径键=' + kb);
}

// ── C4 · F-4 空证据被判 advanced ────────────────────────────────────────────────
function checkF4(harden) {
  const bus = createBus({ harden });
  const classification = bus.classifyProgress({ writes: [], evidence: [] });
  const ok = classification !== 'advanced';
  return record('F-4 空证据不谎报', ok, 'classification=' + classification + '（期望 ≠ advanced）');
}

// ── C5 · 否定对照（AC-14）：故意缺必需端口 ⇒ 必须抛，不得静默通过 ─────────────────
function checkNegativeControl() {
  const bus = createBus({}); // 不给 runtime / audit
  try {
    bus.assertCapability('tools');
    return record('C5 否定对照', false, '静默通过 ⇒ 不合格（缺必需端口却无异常）');
  } catch (err) {
    const msg = String(err?.message ?? '');
    const ok = err instanceof Error
      && err.code === undefined
      && !/^GATE_/.test(msg)
      && msg.includes('capability-missing:')
      && msg.includes('runtime');
    return record('C5 否定对照', ok,
      'THREW ' + String(err?.constructor?.name) + ' code=' + String(err?.code) + ' msg=' + JSON.stringify(msg));
  }
}

// ── C6 · 四动作各一条探针 ───────────────────────────────────────────────────────
async function checkFourActions() {
  const nulls = createNullAdapters();
  const bus = createBus({ ports: { runtime: nulls.runtime, audit: nulls.audit } });
  const out = [];
  out.push('register→' + bus.register('tools', { list: () => [], call: () => ({ ok: true }) }));
  out.push('assertCapability→' + String(bus.assertCapability('tools', { ctx: { tools: {} } })));
  out.push('route→' + String((await bus.route('coder')).seat));
  out.push('normalize→' + JSON.stringify(Object.keys(bus.normalize({ writes: [], evidence: ['e'] })).sort()));
  const ok = out.every((line) => !line.includes('undefined'));
  return record('C6 四动作', ok, out.join(' ｜ '));
}

// ── C7 · 最小批次跑完（runMinimalBatch）────────────────────────────────────────
async function checkMinimalBatch() {
  const nulls = createNullAdapters();
  const bus = createBus({ ports: { runtime: nulls.runtime, audit: nulls.audit } });
  const summary = await runMinimalBatch(bus, {
    capability: 'tools',
    rt: { ctx: { tools: {} } }, // 最小宿主面：只声明本次断言用到的那一项（其余不放宽）
    task: { id: 'selftest-task', role: BUILTIN_ROLES[0] },
  });
  const ok = summary.steps.length >= 5 && summary.classification === 'empty_response';
  return record('C7 最小批次', ok,
    'steps=' + JSON.stringify(summary.steps) + ' classification=' + summary.classification);
}

// ── main ──────────────────────────────────────────────────────────────────────
const breakArg = process.argv.slice(2).find((a) => a.startsWith('--break='));
const breakTarget = breakArg ? breakArg.slice('--break='.length) : null;
const harden = breakTarget ? { [breakTarget]: false } : {};

console.log('== bus selftest ==' + (breakTarget ? '  [反向开关 harden.' + breakTarget + '=false]' : ''));

// 逐检查捕获：某条加固被关掉后，缺陷可能**溢出到别的探针**并抛错（例如 F-1 的裸解引用会让
//   F-3 的取件路径先崩）。那也要记成该探针的 FAIL，而不是让整个脚本崩掉 —— 否则「缺陷已复现」
//   的读数会被一个未捕获异常盖住，读的人只看到 stack。
async function runSafely(label, fn) {
  try {
    return await fn();
  } catch (err) {
    return record(label + ' 探针异常', false, 'THREW ' + String(err?.constructor?.name) + ': ' + String(err?.message));
  }
}

await runSafely('C0', checkShapeReconciliation);
await runSafely('F-1', () => checkF1(harden));
await runSafely('F-2', () => checkF2(harden));
await runSafely('F-3', () => checkF3(harden));
await runSafely('F-4', () => checkF4(harden));
if (!breakTarget) {
  await runSafely('C5', checkNegativeControl);
  await runSafely('C6', checkFourActions);
  await runSafely('C7', checkMinimalBatch);
}

const failed = results.filter((r) => !r.ok);
if (breakTarget) {
  const hit = failed.find((r) => r.id.startsWith('F-' + breakTarget.slice(1)));
  if (hit) {
    console.log('== 缺陷已复现（harden.' + breakTarget + '=false ⇒ ' + hit.id + ' 红）⇒ exit 1 ==');
    process.exit(1);
  }
  console.log('== 反向开关无效：关掉 ' + breakTarget + ' 后该检查仍绿 ⇒ 该行并非守卫 ==');
  process.exit(1);
}
console.log('== ' + (failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED') + ' ⇒ exit ' + (failed.length === 0 ? 0 : 1) + ' ==');
process.exit(failed.length === 0 ? 0 : 1);
