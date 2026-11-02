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

// test/rl2-narrow-ask-axis.test.js —— **RL-2**：`canNarrow` 的**入参敏感性**（ask 轴）
//
// ══ 为什么需要这条（判据 5 的唯一剩余）═════════════════════════════════════════════════
//
// `canNarrow(ask)` 要回答的是「**按本次请求**能否收窄」。它的判据有两根**不同的轴**：
//
//   · **coverage 轴**：`presetFor` 声明该 preset 实际拿到哪些工具（`covers`）。
//     ⇒ 现有 `S-3a` / `S-3b` 两态变的是**这一轴**（`presetCoverage` 内容），它们证明的是
//       「覆盖与 deny 相交 ⇒ 拒派；不相交 ⇒ 放行」。
//   · **ask 轴**：同一 preset、同一 coverage，**换 `ask.toolFace`** 时判定必须随之变。
//     ⇒ **本文件测这一轴**；`S-3b` 测不了它（`S-3b` 两次调用的 ask 相同、只换 coverage）。
//
// ⚠ 把这两根轴混为一谈，是 `plan/meter-spec.md` 初稿的一处认知混淆（当时把「同 preset 两组
//   不同 ask」与「同 preset 两组不同 coverage」并列成同一类证）。本文件把轴分开，并在
//   `exec/rl2-forms.md` 里显式更正。
//
// ══ 它防的是什么回归（a1 推演的实害）══════════════════════════════════════════════════
//
// 若把实现改成「**读全局 deny 集**（忽略 `ask.toolFace`）」，则：
//   `S-3a`（放行）、`S-3a-R`（拒派）、`S-3b` 两态**全都仍然绿** —— 因为它们的判定不随 ask 变。
//   ⇒ 「**按次收窄**」静默退化为「**按配置收窄**」，而现有 4 条锁**全部发现不了**。
// 本文件的 R2-a 直接测该退化（`ok !== bad && bad === false`）；R2-b 是**反变异 meta 用例**，
// 用同一断言跑「忽略 ask 的变异实现」并断言它**必失败** ⇒ 证明 R2-a 有判别力、不是恒真。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentPort } from '../lib/provider-dsh/agent.js';

/** activation 形态的最小宿主桩（只有新入口，无 `start`）。 */
const ACTIVATION_HOST = { startActivation: async () => ({ id: 'w-act' }) };

/** 同一 preset 的**固定**覆盖声明：该 preset **实际拿到**的工具面 = `['bash']`。
 *  ⚠ 非空（C-5：空覆盖必须被拒，不能拿它当「全收窄」）；且**不含**任何治理工具。 */
const COVERS = ['bash'];
const presetForFixed = () => ({ preset: 'p', covers: [...COVERS] });

// ══ R2-a · RL-2 主体：同一 preset、两组不同 ask ⇒ 判定必须不同 ═══════════════════════════
test('R2-a RL-2 入参敏感性：同一 preset（covers=[bash]），换 ask.toolFace ⇒ 判定必须随之变', () => {
  const port = createAgentPort({ subagents: ACTIVATION_HOST }, { presetFor: presetForFixed });

  // ask-1：deny `wave_plan`（与 covers **不相交**）⇒ 收窄成立 ⇒ 期望 true
  const ok = port.canNarrow({ toolFace: { deny: ['wave_plan'] } });
  // ask-2：deny `bash`（与 covers **相交**）⇒ 该 preset 拿到的正是本次要禁的 ⇒ 期望 false
  const bad = port.canNarrow({ toolFace: { deny: ['bash'] } });

  // ⚠ 两个断言都必须在：
  //   只断 `bad === false` ⇒ **恒 false 的实现**也能过（无区分力的另一面）；
  //   只断 `ok === true`  ⇒ **恒 true 的实现**也能过。
  assert.equal(bad, false, 'deny 与 covers 相交 ⇒ 收窄不成立 ⇒ 必须 false；实际=' + String(bad));
  assert.equal(ok, true, 'deny 与 covers 不相交 ⇒ 收窄成立 ⇒ 必须 true；实际=' + String(ok));
  assert.notEqual(ok, bad, '两组 ask 的判定必须**不同**（否则实现忽略了 ask ⇒ 「按次收窄」退化为「按配置收窄」）');
});

// ══ R2-b · 反变异 meta 用例：忽略 ask 的变异实现 ⇒ 同一断言必失败 ════════════════════════════
/** **变异实现**（模拟 a1 推演的回归）：判定只看「有没有覆盖」，**忽略 `ask.toolFace`**。
 *  等价于把 `ask.toolFace` 换成一份**全局** deny 集 —— 于是同一 preset 下两 ask 得同值。 */
function canNarrowMutant(port, _ask) {
  // 退化的两种常见写法，都得到「与 ask 无关」的结论：
  //   ① 恒 true（只要有见证就算收窄）
  //   ② 用全局 deny 集代替 ask.toolFace（`[]` 与任何 covers 都不相交 ⇒ 恒 true）
  return port.available && port.narrowVia !== 'none';
}

test('R2-b 反变异：把判定改成「忽略 ask（读全局 deny 集）」⇒ R2-a 的断言**必失败**', () => {
  const port = createAgentPort({ subagents: ACTIVATION_HOST }, { presetFor: presetForFixed });
  const okLike = canNarrowMutant(port, { toolFace: { deny: ['wave_plan'] } });
  const badLike = canNarrowMutant(port, { toolFace: { deny: ['bash'] } });

  // 变异体的判定**必须**与 ask 无关（否则这个 meta 用例本身造错了）
  assert.equal(okLike, badLike, '变异实现必须产出「两 ask 同值」（这正是退化的形态）');

  // 而 R2-a 的核心断言 `ok !== bad` 在变异体上**必然失败** ⇒ 证明 R2-a 有判别力
  const r2aWouldFail = (okLike !== badLike);
  assert.equal(r2aWouldFail, false,
    'R2-a 的 `ok !== bad` 在「忽略 ask」的实现上必须为假（⇒ R2-a 会红）；'
    + '若此处为真，说明 R2-a 无法抓住该回归。变异体读数 ok=' + String(okLike) + ' bad=' + String(badLike));
});

// ══ R2-c · 边界：两组 ask 之外，`covers` 为空时必须仍被拒（与 C-5 不冲突）════════════════
test('R2-c 轴的分野佐证：ask 轴成立时，C-5（空覆盖必须拒）不受影响', () => {
  const emptyCovers = createAgentPort({ subagents: ACTIVATION_HOST },
    { presetFor: () => ({ preset: 'p', covers: [] }) });
  assert.equal(emptyCovers.canNarrow({ toolFace: { deny: ['wave_plan'] } }), false,
    '空覆盖 ⇒ 必须 false（`∅∩∅=∅` 恒成立，不拒就退化成恒 true）');

  // 同一 ask、只换 coverage ⇒ 判定从 false 变 true（**coverage 轴**，S-3b 的领地）
  const withCovers = createAgentPort({ subagents: ACTIVATION_HOST }, { presetFor: presetForFixed });
  assert.equal(withCovers.canNarrow({ toolFace: { deny: ['wave_plan'] } }), true,
    '同 ask、覆盖非空且不相交 ⇒ true（coverage 轴：S-3b 的领地，与本文件的 ask 轴互不替代）');
});

// ══ R2-d · 无收窄需求时不误伤（need=false 短路，与 ask 轴正交）══════════════════════════
test('R2-d 轴外基线：ask 未提出收窄需求 ⇒ 恒 true（不参与本轴判定）', () => {
  const port = createAgentPort({ subagents: ACTIVATION_HOST }, { presetFor: presetForFixed });
  assert.equal(port.canNarrow({}), true, 'ask={} ⇒ need=false 短路 ⇒ true（不得被读作「已收窄」）');
  assert.equal(port.canNarrow({ toolFace: { deny: [] } }), true, 'deny 空集 ⇒ 无收窄需求 ⇒ true');
});
