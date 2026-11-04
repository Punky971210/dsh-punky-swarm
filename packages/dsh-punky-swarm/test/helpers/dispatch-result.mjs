// test/helpers/dispatch-result.mjs
//
// 【批 `punky-d1d2-impl-20261103` · lane `impl-d1`】**D-1 拒派返回的四要素单点**。
//
// ## 为什么需要它
// D-1 把 `lane_dispatch` 的拒派从 **throw 改为返回**（`mode:'rejected'`）。原先 10 处测试各写一份
// `assert.rejects(/GATE_DISPATCH_CAPABILITY_UNAVAILABLE/)`；改成返回值后如果**每处各写一遍四要素**，
// 下次判据一变就要动 10 个地方 —— 那正是本仓一直在修的「两套口径」病根。
// ⇒ 四要素**只在这里实现一次**，所有调用方 `import { assertRejected }`。
//
// ## 为什么放在**新文件**而不是 `test/helpers/verdicts.mjs`
// `verdicts.mjs` 是**纯谓词模块**（零 assert 依赖、零副作用，被 G2/G3 判据消费）。
// 把断言 helper 塞进去会让「纯函数模块」依赖 `node:assert` —— 污染它的定位。
// **单点目标同样达成**：一个文件、一个函数、所有调用方 import 同一处。
import assert from 'node:assert/strict';

/**
 * 断言「这是一次**拒派**」——四要素单点（D-1 · 方案乙）。
 *
 * @param {object} r       `lane_dispatch` / `dispatchLaneCore` 的返回值
 * @param {string} [label] 失败消息前缀（默认 `'拒派'`）
 */
/**
 * 断言「这是一次**拒派**」——四要素单点（D-1 · 方案乙）。
 *
 * @param {object} r       `lane_dispatch` / `dispatchLaneCore` 的返回值
 * @param {string} [label] 失败消息前缀（默认 `'拒派'`）
 * @param {{code?: string, status?: string|null}} [opts]
 *   · `code`   —— 期望拒码，缺省 `GATE_DISPATCH_CAPABILITY_UNAVAILABLE`（能力位不足这一族）；
 *   · `status` —— 期望 `status` 字段，缺省 `'pending'`（拒派打在状态变更之前）；
 *                传 `null` ⇒ **跳过** status 断言（用于「失败**已**置终态」的形态，如派发失败类，
 *                那时由用例自己对 `store.readBatch(...).lanes[lane]` 断言终态，helper 不越权）。
 */
export function assertRejected(r, label = '拒派', opts = {}) {
  const { code = 'GATE_DISPATCH_CAPABILITY_UNAVAILABLE', status = 'pending' } = opts ?? {};
  assert.equal(r?.mode, 'rejected',
    label + '：mode 必须为 rejected —— D-1 起拒派不再抛错，改由返回值表达；实测=' + JSON.stringify(r && { mode: r.mode, status: r.status, spawned: r.spawned }));
  assert.equal(r?.code, code,
    label + '：code 必须为 ' + code + '；实测=' + String(r?.code));
  assert.equal(r?.spawned, false,
    label + '：拒派不得自称已派发（spawned 必须为 false）');
  if (status !== null) {
    // 状态取 `batch.lanes[lane]`：拒派打在 `setMember('running')` **之前** ⇒ 此刻恒为 `'pending'`
    // （该路径本想表达「lane 未被改动」，而 `'pending'` 正是它的真值）。
    assert.equal(r?.status, status,
      label + "：status 必须为 '" + status + "'；实测=" + String(r?.status));
  }
  // 「无句柄是事实」：拒派发生在 `issueLaneHandle` 之前 ⇒ 返回体不含句柄三键中的 token。
  assert.equal(r?.token, undefined,
    label + '：拒派路径未发放句柄 ⇒ 返回体不得含 token');
}
