// I-19 · ask-first = 立即拒（三态四组）
//
// 判据纪律：
//   · **同步拒**：guard 返回**字符串**（宿主观为终态拒绝），**不是** Promise、**不是**可继续的待审批态；
//   · **拒路径零写入**：靠**对照**证明 —— 同一夹具换放行白名单 ⇒ `bumpExecCount` 必须 +1。
//     只断言「拒时计数为 0」分不清「真没写」和「压根没走到那段」，故必须成对给；
//   · **签名重放**：批准票据里的 digest 必须等于**当前参数**的 `canonicalDigest`（剔除控制位 `approval` 本身）。
//
// 两个夹具坑（踩过）：
//   ① `pwsh`/`bash` 的**只读**命令走 readonly 旁路、在 allowlist 之前就放行了 ⇒ 造 default-deny 用例
//      必须用**非只读**的执行型工具（这里用 `write`），否则测到的是旁路放行，不是漏判；
//   ② guard 最前面还有**难度门**：没有 `readGovernance().lastAssign`（且 `stale()` 为假）会先被难度门拒 ⇒
//      测不到 allowlist。故夹具必须给合法 `lastAssign`（`at` 为合法 ISO 时间戳）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { installDifficultyGuard, ASK_REQUIRED_409, ASK_APPROVAL_ARGS_MISMATCH } from '../lib/tools/tier-gate.js';
import { canonicalDigest, ALLOWLIST_DENIED } from '../lib/governance/allowlist.js';

const SESSION = 'sess-i19';

/**
 * 组装 guard。返回 `guard(execution)` 与一个**写入计数器**。
 * `allowlist` 用 `undefined` 表示「未配置白名单」（关闭 I-24 段，仅留难度门），`[]` 表示「启用 + 空表」。
 */
function makeGuard({ allowlist } = {}) {
  const writes = { bumpExecCount: 0 };
  const store = {
    // 难度门前提：已评估过、未过期（stale=false），且非 C/D + pendingBatch 形态
    readGovernance: () => ({ lastAssign: { difficulty: 'B', form: 'B', at: new Date('2026-01-01T00:00:00.000Z').toISOString() } }),
    stale: () => false,
    bumpExecCount: () => { writes.bumpExecCount += 1; },
  };
  const config = allowlist === undefined ? {} : { tools: { allowlist } };
  const guards = [];
  const ctx = { tools: { guard: (fn) => { guards.push(fn); } }, logger: { warn() {}, info() {}, debug() {}, error() {} } };
  installDifficultyGuard(ctx, { store, config });
  assert.equal(guards.length, 1, '夹具须恰好注册 1 个 guard');
  return { guard: guards[0], writes };
}

/** 执行型（非只读）调用：`write` 在 EXEC_TOOLS 内且不走 shell 只读旁路。 */
function writeExec(args) {
  return { name: 'write', arguments: args, agent: { session: { id: SESSION } } };
}

test('I-19-1 default deny：空白名单 ⇒ 同步字符串拒，拒因含前缀与工具名，且零计数写', () => {
  const { guard, writes } = makeGuard({ allowlist: [] });
  const ret = guard(writeExec({ path: 'a.md', content: 'x' }));

  assert.equal(typeof ret, 'string', '拒必须返回字符串（宿主终态错误）');
  assert.ok(ret.startsWith(ALLOWLIST_DENIED), '拒因前缀必须是 allowlist-denied:，收到：' + ret);
  assert.ok(ret.includes('write'), '拒因必须带工具名');
  assert.equal(writes.bumpExecCount, 0, '拒路径零 store 写');
});

test('I-19-2 ask-first = 立即拒（非挂起）：同步 string、非 Promise、非待审批态；对照放行路径有计数写', () => {
  const needApproval = [{ tool: 'write', requireApproval: true }];

  // 态 A：需批准但未带票据 ⇒ 立即拒（409 语义）
  const denying = makeGuard({ allowlist: needApproval });
  const ret = denying.guard(writeExec({ path: 'a.md', content: 'x' }));
  assert.equal(typeof ret, 'string', 'ask 必须**同步**返回字符串');
  assert.equal(typeof ret?.then, 'undefined', '返回不得是 Promise（挂起态会破坏「现在拒」的语义）');
  assert.ok(ret.startsWith(ASK_REQUIRED_409), '拒因前缀必须是 ' + ASK_REQUIRED_409 + '，收到：' + ret);
  assert.ok(ret.includes('write'));
  assert.equal(denying.writes.bumpExecCount, 0, 'ask 拒路径零 store 写（不写「待审批」状态）');

  // 对照态：同一夹具、同一调用形状，仅换「不需批准」的白名单 ⇒ 放行且有计数写
  const allowing = makeGuard({ allowlist: ['write'] });
  const ok = allowing.guard(writeExec({ path: 'a.md', content: 'x' }));
  assert.equal(ok, undefined, '放行时返回 undefined');
  assert.equal(allowing.writes.bumpExecCount, 1,
    '对照：放行路径必须 +1 ⇒ 证明拒路径的 0 是「真没写」，不是「没走到」');
});

test('I-19-3 批准 + 原参数 ⇒ 放行（签名重放命中）', () => {
  const args = { path: 'a.md', content: 'x' };
  const digest = canonicalDigest(args);
  const { guard, writes } = makeGuard({ allowlist: [{ tool: 'write', requireApproval: true }] });

  const ret = guard(writeExec({ ...args, approval: { digest } }));
  assert.equal(ret, undefined, '票据与参数一致 ⇒ 放行');
  assert.equal(writes.bumpExecCount, 1, '放行路径计数 +1');
});

test('I-19-4 批准后改参数 ⇒ 拒（approval-args-mismatch，且两摘要不相等）', () => {
  const approvedArgs = { path: 'a.md', content: 'x' };
  const tamperedArgs = { path: 'b.md', content: 'x' };
  const digest = canonicalDigest(approvedArgs);
  const { guard, writes } = makeGuard({ allowlist: [{ tool: 'write', requireApproval: true }] });

  // 前提：两摘要确实不同（否则本用例测不到「改参」）
  assert.notEqual(canonicalDigest(tamperedArgs), digest, '夹具前提：改参后摘要必须不同');

  const ret = guard(writeExec({ ...tamperedArgs, approval: { digest } }));
  assert.equal(typeof ret, 'string', '改参必须拒');
  assert.ok(ret.startsWith(ASK_APPROVAL_ARGS_MISMATCH), '拒因前缀必须是 ' + ASK_APPROVAL_ARGS_MISMATCH + '，收到：' + ret);
  assert.ok(ret.includes('write'));
  assert.equal(writes.bumpExecCount, 0, '改参拒路径零 store 写');

  // 两态对照：把票据换成「当前参数」的摘要 ⇒ 同一构造立刻放行（证「拒」不是恒真）
  const { guard: g2 } = makeGuard({ allowlist: [{ tool: 'write', requireApproval: true }] });
  assert.equal(g2(writeExec({ ...tamperedArgs, approval: { digest: canonicalDigest(tamperedArgs) } })), undefined,
    '票据与当前参数一致 ⇒ 放行（对照组）');
});

test('I-19-5 未配置白名单 ⇒ I-24 段整段不执行（旧行为零变化的两态对照）', () => {
  // 未配置：即便调的是「空白名单会拒」的同一工具，也应放行（证明默认不启用）
  const plain = makeGuard({});
  assert.equal(plain.guard(writeExec({ path: 'a.md', content: 'x' })), undefined, '未配置 ⇒ 放行');
  assert.equal(plain.writes.bumpExecCount, 1, '未配置 ⇒ 照常计数');

  // 对照：配置空表 ⇒ 同一调用被拒（证明「未配置」与「空表」是两回事）
  const strict = makeGuard({ allowlist: [] });
  const ret = strict.guard(writeExec({ path: 'a.md', content: 'x' }));
  assert.equal(typeof ret, 'string', '空表 = 启用且 default deny');
  assert.ok(ret.startsWith(ALLOWLIST_DENIED));
});
