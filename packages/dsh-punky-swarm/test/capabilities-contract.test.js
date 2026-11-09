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

// test/capabilities-contract.test.js —— `lib/capabilities.js` 的**代码面契约锁**
// ─────────────────────────────────────────────────────────────────────────────
// 判据来源 = 批 `punky-gate-fix` · lane `e3-docs-unlink` · 修复 **R-2**（上游锚 `H-03@punky-gate-hardening`）。
//
// **为什么本件存在（先迁后删）**：原 `scripts/docs-consistency.mjs` 把 9 条判据混在一条链上 ——
//   · 2 条读 **`lib/capabilities.js`**（`A-1` / `A-1·语义`，脚本 `:152-164`）= **代码面**；
//   · 7 条读 `drift-audit.md`（`A-2` + `C×6`）= 文档面。
//   R-2 的口径是「测试链只绑代码」，所以整节点要从 `package.json` 的 `scripts.test` 摘掉；
//   但**直接摘链会净损失**那 2 条代码面判据（实测：`test/**` 内原本**零处**断言
//   `lib/capabilities.js` 的 `degraded` 计数 —— 同名 `degraded` 命中全属异义：`assets` 同步降级、
//   `dispatch register degraded`、`probe.degraded` 事件…）⇒ 故本件**先落成并转绿，再摘链**。
//
// 迁移口径（两步，禁只做第一步）：
//   ① **逐字承接**原两条断言：`degraded` 字面量恰 1 处 ＋ 该行含「已废除」。
//   ② **补行为面锁**（原脚本只有字面量计数，一处注释改格式就会误红/漏红，属弱判据）：
//      `capabilityReport()` 的 `host[]` 每项键集**恰为** `{key, available, reason, channels}`、
//      **无** `degraded` 位；`available` 只取 `true|false|null` 三态；`available===true ⇒ reason===null`；
//      `unavailable` **不含** `null`（未探明不冒充「不可用」）。
//   ⇒ 即「文档曾是数据源、落地时把数据搬进代码常量」的迁移范式（样板：`test/retired-codes-lock.test.js`）。
//
// 四态纪律：每条用例正文首行写明**失败条件**；本件**零文档输入**（只读 `lib/**` 与运行期返回值），
//   不读 `docs/**`、不读 `presets/**`、不读仓外路径。
// 执行方式：`node --test test/capabilities-contract.test.js`
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根（**基于本文件位置**派生，不依赖 cwd）。 */
const PKG_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const CAPS_REL = 'lib/capabilities.js';
const capsSource = () => readFileSync(join(PKG_ROOT, CAPS_REL), 'utf8');

// ── ① 字面量面：逐字承接 `docs-consistency.mjs` 的 A-1 / A-1·语义 ──────────────────────
test('CAP-1 `lib/capabilities.js` 的 `degraded` 字面量恰 1 处，且该行含「已废除」', () => {
  // 失败条件：`degraded` 计数 ≠ 1（删到 0 = 丢了「为什么不用降级」的唯一依据；
  //           >1 = 「半可用」中间态回生），或唯一那处所在行不再是「已废除」那句
  //           （= 剩下的是一处有效代码位 ⇒ 降级状态模型回来了）。
  const src = capsSource();
  const linesWith = src.split(/\r?\n/).filter((line) => line.includes('degraded'));
  assert.equal(
    (src.match(/degraded/g) ?? []).length,
    1,
    '`degraded` 在 ' + CAPS_REL + ' 须**恰出现 1 次**（Q-E=乙「废除降级」的唯一依据句）；实测命中行：'
      + JSON.stringify(linesWith),
  );
  assert.match(
    linesWith[0] ?? '',
    /已废除/,
    '唯一一处 `degraded` 所在行须含「已废除」（否则等于把降级态写回代码）：'
      + JSON.stringify(linesWith[0] ?? null),
  );
});

// ── ② 行为面：报告形状里没有 degraded 位，可用性只有一个三态位 ─────────────────────────
test('CAP-2 `capabilityReport()` 的 `host[]` 无 degraded 位；`available` 只取三态且 true ⇒ reason=null', async () => {
  // 失败条件：`host[]` 任一项键集 ≠ `{key,available,reason,channels}`（多出 `degraded` 之类第二可用性位
  //           / 少了 `reason`）／`available` 出现 `true|false|null` 之外的取值（如 `"partial"`、`undefined`）
  //           ／`available===true` 而 `reason` 非 null（自相矛盾读数）／未探明被并进 `unavailable`
  //           （把「没探到」伪装成「没有」= 静默缺陷）。
  const { capabilityReport, HOST_FACE_KEYS } = await import('../lib/capabilities.js');
  const EXPECTED_KEYS = ['available', 'channels', 'key', 'reason'];

  /** 三种输入形态：未探明（无 ports）／端口在位可用／端口在位不可用。 */
  const CASES = [
    { label: '无 ports（未探明）', rt: {} },
    { label: 'ports 在位且 available:true', rt: { ports: Object.fromEntries(HOST_FACE_KEYS.map((k) => [k, { available: true }])) } },
    { label: 'ports 在位且 available:false', rt: { ports: Object.fromEntries(HOST_FACE_KEYS.map((k) => [k, { available: false }])) } },
  ];

  for (const c of CASES) {
    const report = capabilityReport(c.rt);
    // 报告顶层也不得冒出降级位
    assert.equal(
      Object.prototype.hasOwnProperty.call(report, 'degraded'),
      false,
      `${c.label}：报告顶层不得出现 \`degraded\` 键（降级态已废除）`,
    );
    const faceKeys = report.host.map((h) => h.key);
    assert.deepEqual(
      faceKeys.slice().sort(),
      [...HOST_FACE_KEYS].sort(),
      `${c.label}：\`host[]\` 须逐面在场（面本身不存在才不列），实测 ${JSON.stringify(faceKeys)}`,
    );
    for (const item of report.host) {
      assert.deepEqual(
        Object.keys(item).sort(),
        EXPECTED_KEYS,
        `${c.label}：\`host\` 项 ${item.key} 的键集须恰为 {key,available,reason,channels}（无第二可用性位），`
          + '实测 ' + JSON.stringify(Object.keys(item).sort()),
      );
      assert.ok(
        item.available === true || item.available === false || item.available === null,
        `${c.label}：\`available\` 只取 true|false|null 三态，实测 ${JSON.stringify(item.available)}（${item.key}）`,
      );
      if (item.available === true) {
        assert.equal(
          item.reason,
          null,
          `${c.label}：\`available===true\` 时 \`reason\` 必须为 null（禁「可用但带不可用成因」），`
            + `实测 ${JSON.stringify(item.reason)}（${item.key}）`,
        );
      }
      // `channels` 只属 agentRuntime 面；其余面恒 null（`null` ≠ `{}`：空对象会被读成「有通道对象但无通道」）
      if (item.key !== 'agentRuntime') {
        assert.equal(item.channels, null, `${c.label}：非 agentRuntime 面 \`channels\` 恒 null（${item.key}）`);
      }
    }
    // 未探明（null）**不得**进 `unavailable`：未探明不是不可用
    for (const key of report.unavailable) {
      const item = report.host.find((h) => h.key === key);
      assert.equal(
        item.available,
        false,
        `${c.label}：\`unavailable\` 只收 available===false 的面，实测 ${key} 的 available=${JSON.stringify(item?.available)}`,
      );
    }
    // 正例：ports 在位可用 ⇒ 无一面被误判不可用
    if (c.label.includes('available:true')) {
      assert.deepEqual(report.unavailable, [], `${c.label}：全可用时 \`unavailable\` 须为空集`);
    }
    // 反例：ports 在位不可用 ⇒ 逐面进 unavailable（防「永远空集」的恒真）
    if (c.label.includes('available:false')) {
      assert.deepEqual(
        report.unavailable.slice().sort(),
        [...HOST_FACE_KEYS].sort(),
        `${c.label}：全不可用时 \`unavailable\` 须逐面列出，实测 ${JSON.stringify(report.unavailable)}`,
      );
    }
  }
});
