/*
Copyright (C) 2025-2026 Punky

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.
*/

// test/persona-and-sink-notes.test.js —— 两处**注释/接线事实**的验证（只验证，不改代码）。
//
// ① **persona 死参数说明**：`dispatch.js` 的 activation 分支把 `persona` 交给 `agentPort.spawn(...)`，
//    但 activation 宿主无 `persona` 字段 ⇒ 该值不生效。注释必须说清**四件事**：
//    接收不转发生效 / 这不是缺陷 / 宿主无 persona 字段 / 保留传参是为两形态签名一致。
//    ⚠ 定位用**唯一文本锚**（`persona: builtRequest.persona,`）而不是行号 —— 多批同文件串行下行号会持续漂移。
//
// ② **`scanSinkDir` 写路径未接 logger**（`e1` 登记的未接项，**复核但不当缺陷**）：
//    `sink.js` 的写路径（`pruneByTotal(state.sinkDir, …)`）作用域只持 `state`、取不到 logger
//    ⇒ 写路径触发的「目录不可读」本轮**仍静默**（只有挂载期可辨）。本用例只钉「登记属实」。
//
// 跑法（必须带 preload）：node --import ./test/helpers/isolated-home.preload.mjs --test test/persona-and-sink-notes.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(PKG, rel), 'utf8');

test('① persona 死参数说明在位，且说清四件事（以唯一文本锚定位，不依行号）', () => {
  const src = read('lib/engine/dispatch.js');
  const anchor = 'persona: builtRequest.persona,';
  const at = src.indexOf(anchor);
  assert.equal(at >= 0, true, '必须存在唯一文本锚 `' + anchor + '`（activation 分支的 persona 传参）');
  // 取锚点前 900 字符内的说明块（注释在传参之前）
  const block = src.slice(Math.max(0, at - 900), at);

  const points = {
    接收但不转发生效: /接收但不转发生效/,
    '不是缺陷': /这不是缺陷/,
    '宿主无 persona 字段': /无\s*`?persona`?\s*字段/,
    '保留传参为两形态签名一致': /两形态签名一致/,
  };
  const missing = Object.entries(points).filter(([, re]) => !re.test(block)).map(([k]) => k);
  assert.deepEqual(missing, [], '四件事必须**逐条**说明；缺=' + JSON.stringify(missing) + '（实取块=' + block.slice(-160) + '）');

  // 阳性对拍：同一锚点在文件里只出现一次（防「多处分叉」把说明搬走却仍绿）
  const occurrences = src.split(anchor).length - 1;
  assert.equal(occurrences, 1, '`' + anchor + '` 在 dispatch.js 内必须恰出现 1 次；实际=' + occurrences);
});

test('② sink 写路径「未接 logger」登记属实（只登记事实，不当缺陷）', () => {
  const src = read('lib/auditlog/sink.js');

  // 事实 A：写路径的 pruneByTotal 调用**不传 logger**（第 3 参只有 pruneStray）
  const callRe = /pruneByTotal\(\s*state\.sinkDir,\s*state\.cfg\.maxTotalBytes,\s*(\{[^}]*\})\s*\)/;
  const m = callRe.exec(src);
  assert.ok(m, '必须存在 `pruneByTotal(state.sinkDir, state.cfg.maxTotalBytes, {...})` 的写路径调用');
  assert.equal(/logger/.test(m[1]), false,
    '写路径调用**不得**出现 logger（若出现说明已接线，本登记需撤销）；实际第三参=' + m[1]);

  // 事实 B：该处注释**显式登记未接**（不是沉默遗漏）
  const before = src.slice(Math.max(0, m.index - 700), m.index);
  assert.match(before, /未接/, '写路径附近必须显式登记「未接」（禁假装接了）');
  assert.match(before, /仍静默|静默/, '登记须写明后果（写路径触发的不可读仍静默）');

  // 阳性对拍：挂载期那条调用**应当**带 logger（可辨那一侧真的存在，否则「只有未接」也是坏形态）
  const withLogger = /pruneByTotal\([^)]*logger/.test(src) || /scanSinkDir\([^)]*logger/.test(src);
  assert.equal(withLogger, true, '挂载期路径必须**已接** logger（否则两侧全静默 ⇒ 三态可辨名存实亡）');
});
