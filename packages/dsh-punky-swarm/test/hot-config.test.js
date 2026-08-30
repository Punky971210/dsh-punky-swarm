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

// R1 热更新运行时单测（设计 §3.1 + 契约 §3.2 exec-panel-a 验收①②④⑤⑥）
//   H1 缺省 {} 零行为变化（快照 = 静态 config 原样；start 不广播）
//   H2 覆盖既有路径生效（runtime.json 覆盖 capabilities.trajectory.enabled → onChange 携带 key/value/config）
//   H3 未知顶层键被拒（保持旧快照，不广播）——契约验收④
//   H4 坏 JSON 保持旧快照（不广播、不抛错）
//   H5 无变化键不广播（防 fs.watch 抖动）
//   H6 启停幂等（重复 start/stop/dispose 无异常）——契约验收⑤
//   H7 初始 overlay 启动即生效但不广播（重启语义）
//   H8 fs.watch 真实触发路径（防抖后 onChange 生效）
//   H9 deepMerge 导出复用（assembly/schema.js export 语义不变，readCapability 回归）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfigWatcher, validateOverlay, ALLOWED_TOP_KEYS } from '../lib/hot/config-watch.js';
import { deepMerge, readCapability } from '../lib/assembly/schema.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'punky-hot-'));
}

// 静态 config（模拟 cordis.patch.yml 宿主合并结果）：含既有 schema 路径
function staticConfig() {
  return {
    root: '~/.dsh/jiufeng',
    capabilities: {
      trajectory: { enabled: true, autoFail: false },
      watch: { enabled: true, scanIntervalMinutes: 1 },
      topic: { enabled: false },
    },
    mailbox: { sweepOnStart: true },
  };
}

function writeRuntime(root, overlay) {
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify(overlay, null, 2));
}

test('H1 缺省 {} 零行为变化：无 runtime.json → 快照 = 静态 config 原样；start 不广播', () => {
  const cfg = staticConfig();
  const events = [];
  const watcher = createConfigWatcher({ root: tmpRoot(), config: cfg, onChange: (c) => events.push(c), useWatcher: false });
  const st = watcher.start();
  assert.equal(st.started, true);
  assert.deepEqual(watcher.readSnapshot(), cfg, '快照 = 静态 config 原样（零行为变化）');
  assert.deepEqual(events, [], 'start 不广播');
  watcher.dispose();
});

test('H2 覆盖既有路径生效：reload 应用 capabilities.trajectory.enabled=false → onChange 携带 key/value/config', async () => {
  const root = tmpRoot();
  const cfg = staticConfig();
  const events = [];
  const watcher = createConfigWatcher({ root, config: cfg, onChange: (c) => events.push(c), useWatcher: false });
  watcher.start();
  writeRuntime(root, { capabilities: { trajectory: { enabled: false } } });
  const r = await watcher.reload();
  assert.equal(r.ok, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].key, 'capabilities');
  assert.deepEqual(events[0].config.capabilities.trajectory, { enabled: false, autoFail: false }, 'deepMerge 叠加（autoFail 保留静态值）');
  assert.equal(events[0].config.mailbox.sweepOnStart, true, '未覆盖键保持静态');
  assert.deepEqual(watcher.readSnapshot().capabilities.trajectory, { enabled: false, autoFail: false });
  watcher.dispose();
});

test('H3 未知顶层键被拒：保持旧快照不广播（契约验收④）', async () => {
  const root = tmpRoot();
  const cfg = staticConfig();
  const events = [];
  const watcher = createConfigWatcher({ root, config: cfg, onChange: (c) => events.push(c), useWatcher: false });
  watcher.start();
  writeRuntime(root, { capabilitiesx: { enabled: true } });
  const r = await watcher.reload();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid-overlay');
  assert.ok(r.errors[0].includes('unknown top-level key: capabilitiesx'), '拒绝未知顶层键: ' + r.errors[0]);
  assert.deepEqual(events, [], '不广播');
  assert.deepEqual(watcher.readSnapshot(), cfg, '快照不变');
  // 未知 capabilities 子键同样被拒
  writeRuntime(root, { capabilities: { topicx: { enabled: true } } });
  const r2 = await watcher.reload();
  assert.equal(r2.ok, false);
  assert.ok(r2.errors[0].includes('unknown capabilities key: topicx'));
  watcher.dispose();
});

test('H4 坏 JSON：保持旧快照零行为变化（不广播不抛错）', async () => {
  const root = tmpRoot();
  const cfg = staticConfig();
  const events = [];
  const watcher = createConfigWatcher({ root, config: cfg, onChange: (c) => events.push(c), useWatcher: false });
  watcher.start();
  const dir = path.join(root, 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime.json'), '{ invalid json !!!');
  const r = await watcher.reload();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'read-failed');
  assert.deepEqual(events, [], '不广播');
  assert.deepEqual(watcher.readSnapshot(), cfg, '快照不变');
  watcher.dispose();
});

test('H5 无变化键不广播：同内容重复 reload → 零事件（防 fs.watch 抖动）', async () => {
  const root = tmpRoot();
  const cfg = staticConfig();
  const events = [];
  const watcher = createConfigWatcher({ root, config: cfg, onChange: (c) => events.push(c), useWatcher: false });
  watcher.start();
  writeRuntime(root, { capabilities: { topic: { enabled: true } } });
  await watcher.reload();
  assert.equal(events.length, 1);
  // 同内容再 reload：diff 为空 → 不广播
  await watcher.reload();
  assert.equal(events.length, 1, '无变化键不广播');
  watcher.dispose();
});

test('H6 启停幂等：重复 start/stop/dispose 无异常（契约验收⑤）', () => {
  const watcher = createConfigWatcher({ root: tmpRoot(), config: staticConfig(), useWatcher: false });
  assert.doesNotThrow(() => { watcher.start(); watcher.start(); });
  assert.doesNotThrow(() => { watcher.stop(); watcher.stop(); });
  assert.doesNotThrow(() => { watcher.dispose(); watcher.dispose(); });
  // 真实 watcher 路径启停幂等
  const w2 = createConfigWatcher({ root: tmpRoot(), config: staticConfig() });
  assert.doesNotThrow(() => { w2.start(); w2.stop(); w2.start(); w2.stop(); });
});

test('H7 初始 overlay 启动即生效但不广播（重启语义：静态合并后启动）', () => {
  const root = tmpRoot();
  const cfg = staticConfig();
  writeRuntime(root, { capabilities: { watch: { enabled: false } } });
  const events = [];
  const watcher = createConfigWatcher({ root, config: cfg, onChange: (c) => events.push(c), useWatcher: false });
  watcher.start();
  assert.equal(watcher.readSnapshot().capabilities.watch.enabled, false, '初始 overlay 已生效');
  assert.deepEqual(events, [], '启动不广播');
  watcher.dispose();
});

test('H8 fs.watch 真实触发路径：文件级 watch（实施回注——本环境目录级 watch 触发 libuv 断言崩溃，改直 watch 文件）', async () => {
  const root = tmpRoot();
  const cfg = staticConfig();
  const events = [];
  // 预创建 runtime.json（文件级 watch 需文件存在；初始 overlay 启动静默生效）
  writeRuntime(root, { capabilities: { topic: { enabled: false } } });
  const watcher = createConfigWatcher({ root, config: cfg, onChange: (c) => events.push(c), debounceMs: 30 });
  watcher.start();
  await sleep(150); // 等待 watch 建立
  // 变更写入 → 事件 → 防抖后 onChange
  writeRuntime(root, { capabilities: { topic: { enabled: true } } });
  await sleep(600);
  assert.equal(events.length, 1, '文件级 watch 触发后 onChange 收到');
  assert.equal(events[0].config.capabilities.topic.enabled, true);
  // 同内容再写：diff 为空 → 不广播
  writeRuntime(root, { capabilities: { topic: { enabled: true } } });
  await sleep(600);
  assert.equal(events.length, 1, '无变化键经 watch 路径亦不广播');
  watcher.dispose();
});

test('H8b 文件缺失 bootstrap：运行中新建 runtime.json → 存在性轮询发现 → 建 watch + 重读广播', async () => {
  const root = tmpRoot();
  const cfg = staticConfig();
  const events = [];
  const watcher = createConfigWatcher({ root, config: cfg, onChange: (c) => events.push(c), debounceMs: 20, pollMs: 100 });
  watcher.start(); // runtime.json 尚不存在
  assert.deepEqual(watcher.readSnapshot(), cfg, '缺省零行为变化');
  writeRuntime(root, { capabilities: { watch: { enabled: false } } });
  await sleep(700); // 覆盖 pollMs(100) + debounce(20) + 事件处理
  assert.equal(events.length, 1, 'bootstrap 发现文件 → 重读广播');
  assert.equal(events[0].config.capabilities.watch.enabled, false);
  watcher.dispose();
});

test('H9 deepMerge 导出复用：export 语义不变（readCapability 回归 + 覆盖合并）', () => {
  // deepMerge 导出后内部 readCapability 行为不变（缺省合并 topic 默认关）
  assert.equal(readCapability(staticConfig(), 'topic').enabled, false);
  assert.equal(readCapability({ capabilities: { topic: { enabled: true } } }, 'topic').enabled, true);
  // deepMerge 语义：对象递归合并、标量覆盖
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 } }, { a: { b: 9 } }), { a: { b: 9, c: 2 } });
  assert.deepEqual(deepMerge({ a: 1 }, { a: 2 }), { a: 2 });
  // validateOverlay 允许键集
  assert.ok(ALLOWED_TOP_KEYS.has('capabilities'));
  assert.ok(validateOverlay({ capabilities: { topic: { enabled: true } } }).ok);
  assert.equal(validateOverlay([]).ok, false, '数组 overlay 拒绝');
  assert.equal(validateOverlay(null).ok, false);
});
