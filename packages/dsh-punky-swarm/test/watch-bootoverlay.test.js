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

// watch 启动对账（longrun-panel-config-20260905，e2 新增）：镜像 governance-bootoverlay.test.js BO1 结构，
//   断言对象 = lib/index.js 尾部 remountWatchEngine(hotConfig.readSnapshot(), 'boot-overlay')——
//   启动时（apply 尾部 hotConfig.start() 后）runtime.json overlay 已含 capabilities.watch 生效变化 →
//   按当前快照补一次对账 remount（logTag='boot-overlay'，热更路径无此 tag 可区分）。
//   行为断言 = GET /config applied.watch（configEndpoints.appliedWatch = watchInstalledCfg）：仅当
//   remount 执行才更新——overlay enabled:false/longrun.enabled:false 经启动对账后生效快照即对齐。
//   正场景：
//   A  静态默认开 + overlay watch.enabled:false → apply 尾部一次 unmounted remount（[boot-overlay] +
//      applied.watch.enabled=false——引擎被对账卸载）；
//   A2 静态默认开 + overlay longrun.enabled:false → apply 尾部一次 re-mounted remount（[boot-overlay] +
//      applied.watch.longrun.enabled=false——长跑探针重启即对齐）；
//   B  快照一致（空 overlay）→ remount no-op（零 [boot-overlay] 日志 + applied.watch 出厂快照 + 零
//      warn/error）+ 行为：对账未误杀引擎——静默 tick（6000ms 档）对超时 stint 照常产候选。
//   C  overlay 携带自定义长跑阈值（watch-panel-wiring e2：阈值已纳入 boot 对账生效面）→ 启动对账
//      remount 一次（[boot-overlay]）+ applied.watch 阈值对齐 overlay——「阈值重启即对齐」正例。
//   applied.watch 快照形状 = 5 键全形 {enabled, longrun:{enabled, maxDurationMs, noProgressWindowMs},
//      scanIntervalMinutes}（阈值随 watchInstalledCfg 携带；A/A2/B 中阈值未覆盖 → 默认 1200000/300000）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';
import { createStore } from '../lib/state/store.js';
import { buildWavePlan } from '../lib/wave-plan.js';
import { EVT_LANE_LONGRUN_CANDIDATE, EVT_MEMBER_DISPATCH } from '../lib/state/event-types.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN = 60_000;

const CONFIG_PATH = '/api/dsh-punky-swarm/config';
const TRUSTED_HEADERS = { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3080' };

// ── 装配级 fake ctx（governance-bootoverlay 同款）+ webServer 路由捕获（GET /config 查 applied.watch）──
function assemblyCtx() {
  const listeners = new Map();
  const calls = { info: [], warn: [], error: [] };
  const logger = {
    info: (...a) => calls.info.push(a.join(' ')),
    warn: (...a) => calls.warn.push(a.join(' ')),
    error: (...a) => calls.error.push(a.join(' ')),
  };
  const routes = [];
  const ctx = {
    listeners, calls, logger,
    tools: { register() {} },
    emit() {},
    webServer: { register: (r) => { routes.push(r); return () => {}; } },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => { listeners.get(event)?.delete(fn); };
    },
  };
  return { ctx, routes };
}

function freshRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'punky-wbo-'));
}

function writeRuntime(root, overlay) {
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(overlay, null, 2));
}

const bootRemountLines = (calls) => calls.info.filter((l) => l.includes('hot config: watch engine') && l.includes('[boot-overlay]'));
const mountedLines = (calls) => calls.info.filter((l) => l.includes('watch capability enabled'));

function invoke(route, url) {
  let status = 0, resBody = null;
  const res = { writeHead(s) { status = s; }, end(b) { resBody = JSON.parse(b); } };
  route.handler({ url, method: 'GET', headers: TRUSTED_HEADERS }, res);
  return { status, body: resBody };
}
function getAppliedWatch(routes) {
  const route = routes.find((r) => r.path === CONFIG_PATH);
  assert.ok(route, '/config 已注册（webServer 注入面）');
  const r = invoke(route, CONFIG_PATH);
  assert.equal(r.status, 200);
  return r.body.applied.watch;
}

// 引擎级 seeding：running lane + 25min 前 dispatch（超 maxDuration 的旧 stint；直写镜像 IT-G——
//   setMember 的真实 settled ts 会覆盖伪造时间轴）。apply 之后调用（绕过启动恢复把 running 归 idle）。
function seedOverdueStint(root, S, batchId, lane) {
  const aux = createStore(root);
  const plan = buildWavePlan({ batchId, tasks: [{ id: lane, outputs: ['exec/' + lane + '/out.txt'], cmd: 'work' }] });
  aux.createBatch(S, { batchId, wavePlan: plan, phase: 'running' });
  const bf = aux.batchFile(S, batchId);
  const b = JSON.parse(fs.readFileSync(bf, 'utf8'));
  b.lanes[lane] = 'running';
  b.events.push({ ts: new Date(Date.now() - 25 * MIN).toISOString(), type: EVT_MEMBER_DISPATCH, lane, workerSessionId: 'w1' });
  fs.writeFileSync(bf, JSON.stringify(b, null, 2));
  return aux;
}
function candCount(store, S, batchId, lane) {
  return (store.readBatch(S, batchId)?.events ?? []).filter((e) => e.type === EVT_LANE_LONGRUN_CANDIDATE && e.lane === lane).length;
}

// 静态侧出厂默认开（enabled/longrun 缺省 true；scanIntervalMinutes 缺省 1）——与 runtime.json overlay
// 不同即触发启动对账 remount；governance-bootoverlay BO1 同款静态/overlay 对照口径。
const STATIC_WATCH = (root) => ({ root });

test('BO1 watch boot-overlay 启动对账：overlay 生效覆盖 → apply 尾部一次 remount（unmounted + [boot-overlay] + applied.watch 对齐）', async (t) => {
  // ── A：启动前 runtime.json 已含 watch.enabled:false（≠ 静态默认开）→ 引擎被对账卸载 ──
  const rootA = freshRoot();
  writeRuntime(rootA, { capabilities: { watch: { enabled: false } } });
  const { ctx: ctxA, routes: routesA } = assemblyCtx();
  const disposerA = apply(ctxA, STATIC_WATCH(rootA));
  try {
    // 启动对账 remount 恰一次（logTag='boot-overlay'；热更路径无此 tag）
    const bootA = bootRemountLines(ctxA.calls);
    assert.equal(bootA.length, 1, '启动对账 remount 日志恰 1 行（实际: ' + ctxA.calls.info.join(' || ') + '）');
    // unmounted 方向（overlay enabled:false 覆盖 → 引擎 dispose + timer 清）
    assert.ok(bootA[0].includes('unmounted (watch disabled)'), 'overlay enabled:false → unmounted 方向（实际: ' + bootA[0] + '）');
    // 佐证：静态 enabled 引擎曾挂载（remount 前有物可卸）→ 初始 mount 日志恰 1 行
    assert.equal(mountedLines(ctxA.calls).length, 1, '静态装配先挂载（watch capability enabled）→ 被对账卸载');
    // 行为断言：applied.watch（watchInstalledCfg）已随启动对账对齐 overlay——enabled=false（阈值未覆盖 → 默认）
    assert.deepEqual(getAppliedWatch(routesA),
      { enabled: false, longrun: { enabled: true, maxDurationMs: 1200000, noProgressWindowMs: 300000 }, scanIntervalMinutes: 1 },
      '启动对账后生效快照 enabled=false（引擎按持久化覆盖关；5 键全形含默认阈值）');
  } finally {
    disposerA();
  }

  await t.test('BO1-A2 overlay longrun.enabled:false → 启动对账一次 re-mounted（longrun=false + applied.watch 对齐）', () => {
    const rootA2 = freshRoot();
    writeRuntime(rootA2, { capabilities: { watch: { longrun: { enabled: false } } } });
    const { ctx: ctxA2, routes: routesA2 } = assemblyCtx();
    const disposerA2 = apply(ctxA2, STATIC_WATCH(rootA2));
    try {
      const bootA2 = bootRemountLines(ctxA2.calls);
      assert.equal(bootA2.length, 1, '启动对账 remount 恰 1 行（实际: ' + ctxA2.calls.info.join(' || ') + '）');
      assert.ok(bootA2[0].includes('re-mounted') && bootA2[0].includes('longrun=false'),
        'overlay longrun.enabled:false → re-mounted（longrun=false）（实际: ' + bootA2[0] + '）');
      assert.deepEqual(getAppliedWatch(routesA2),
        { enabled: true, longrun: { enabled: false, maxDurationMs: 1200000, noProgressWindowMs: 300000 }, scanIntervalMinutes: 1 },
        '启动对账后长跑探针开关重启即对齐（applied.watch.longrun.enabled=false；阈值默认保留）');
      assert.equal(ctxA2.calls.warn.length, 0, '对账路径零 warn');
      assert.equal(ctxA2.calls.error.length, 0, '对账路径零 error');
    } finally {
      disposerA2();
    }
  });

  await t.test('BO1-B 幂等对照：overlay 与静态快照一致 → remount no-op（零 [boot-overlay] 日志、出厂快照、零 warn/error）', async () => {
    // ── B：启动前 runtime.json 无 watch 生效变化（空 overlay → 快照 = 静态 config 原样）──
    const rootB = freshRoot();
    writeRuntime(rootB, {});
    // scanIntervalMinutes:0.1（min 0.1 → watchdog 档期 6000ms）——幂等对照的行为正场景：对账 no-op 不误杀引擎，
    //   静默 tick 对超时 stint 照常产候选（出厂默认开语义）
    const { ctx: ctxB, routes: routesB } = assemblyCtx();
    const disposerB = apply(ctxB, { root: rootB, capabilities: { watch: { enabled: true, scanIntervalMinutes: 0.1 } } });
    try {
      // remountWatchEngine 快照相等 → 返回 false no-op（不 dispose 不重挂不写 remount 日志）
      assert.equal(bootRemountLines(ctxB.calls).length, 0, '快照一致 → 零 [boot-overlay] remount 日志（幂等 no-op；实际: ' + ctxB.calls.info.join(' || ') + '）');
      assert.equal(mountedLines(ctxB.calls).length, 1, '静态引擎挂载保持（对账未误卸载）');
      assert.deepEqual(getAppliedWatch(routesB),
        { enabled: true, longrun: { enabled: true, maxDurationMs: 1200000, noProgressWindowMs: 300000 }, scanIntervalMinutes: 0.1 },
        '生效快照 = 静态出厂 5 键全形（enabled/longrun 默认开 + 阈值默认）');
      assert.equal(ctxB.calls.warn.length, 0, '启动对账路径零 warn（实际: ' + ctxB.calls.warn.join(' || ') + '）');
      assert.equal(ctxB.calls.error.length, 0, '启动对账路径零 error');
      // 行为正场景：对账 no-op 后引擎照常扫描——超时 stint（25min 前派发）经静默 tick 产候选（≤ 1 个档期 + 余量）
      const S = 'sess-wbo-b';
      const seed = seedOverdueStint(rootB, S, 'b-wbo-b', 'l1');
      await sleep(7_500); // watchdog 档期 6000ms + 事件/fs 余量
      assert.equal(candCount(seed, S, 'b-wbo-b', 'l1'), 1, '幂等 no-op 未误杀引擎：静默 tick 照常产长跑候选');
    } finally {
      disposerB();
    }
  });

  await t.test('BO1-C 阈值 boot 对账（e2 生效面扩展）：overlay 携带自定义长跑阈值 → 启动对账一次 remount + applied.watch 阈值对齐', () => {
    // ── C：启动前 runtime.json overlay 已含长跑阈值（60000=1min / 30000=30s，≠ 静态默认 1200000/300000）
    //    → 阈值键纳入 boot 对账比较集（watch-panel-wiring e2）→ 重启即对齐（修复「阈值 boot 不生效」洞）──
    const rootC = freshRoot();
    writeRuntime(rootC, { capabilities: { watch: { longrun: { maxDurationMs: 60000, noProgressWindowMs: 30000 } } } });
    const { ctx: ctxC, routes: routesC } = assemblyCtx();
    const disposerC = apply(ctxC, STATIC_WATCH(rootC));
    try {
      const bootC = bootRemountLines(ctxC.calls);
      assert.equal(bootC.length, 1, '阈值 overlay → 启动对账 remount 恰 1 行（实际: ' + ctxC.calls.info.join(' || ') + '）');
      assert.ok(bootC[0].includes('re-mounted') && bootC[0].includes('longrun=true'),
        'overlay 阈值变化 → re-mounted（enabled/longrun 保持默认开）（实际: ' + bootC[0] + '）');
      assert.equal(mountedLines(ctxC.calls).length, 1, '静态引擎先挂载 → 被对账以新阈值重建');
      assert.deepEqual(getAppliedWatch(routesC),
        { enabled: true, longrun: { enabled: true, maxDurationMs: 60000, noProgressWindowMs: 30000 }, scanIntervalMinutes: 1 },
        '启动对账后生效快照阈值对齐 overlay（重启即生效，供面板回显/确认轮询）');
      assert.equal(ctxC.calls.warn.length, 0, '对账路径零 warn');
      assert.equal(ctxC.calls.error.length, 0, '对账路径零 error');
    } finally {
      disposerC();
    }
  });
});
