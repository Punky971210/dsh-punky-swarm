// copy-ts-built.mjs —— 编译产物回拷（.ts 源 → lib 双产物回拷）
// tsc -p tsconfig.build.json 把 lib 下 .ts 模块 emit 到 .tsbuild/；
// 本脚本把转换模块 + contracts 的 .js/.d.ts 回拷到 lib/ 原位（main/exports/相对 import 路径契约零变化），
// 随后删除 .tsbuild（未转 .js 的复制被丢弃——lib 下唯一覆盖/新增就是回拷清单产物）。
import { cpSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const built = join(root, '.tsbuild'); // rootDir:lib → 产物相对 lib 的结构直接落在 .tsbuild 根（lib/schema.ts → .tsbuild/schema.js）

// 回拷清单（.js + .d.ts）：schema 5 组 + contracts + governance 9 组（纯函数内核，lib/governance/）；
// 未转 .js 原样保留在 lib，不回拷
const files = [
  'schema.js', 'schema.d.ts',
  'state/schema-v3.js', 'state/schema-v3.d.ts',
  'state/machine-rules.js', 'state/machine-rules.d.ts',
  // 【2026-10-13 · P2 波次 · lane e2-l4-propagate】L4 传播判定内核（`lib/state/rule-propagation.ts`）：
  //   .ts 源 → 同目录 .js/.d.ts 回拷。**漏本行 ⇒ lib 下无该模块 ⇒ 运行期 ERR_MODULE_NOT_FOUND**
  //   （症状 = 「.tsbuild 里有、调用即找不到」；本 lane 已取到该 RED 读数）。
  'state/rule-propagation.js', 'state/rule-propagation.d.ts',
  'state/gates.js', 'state/gates.d.ts',
  // 【2026-10-02 · 内务批 波 4】createGates 拆分子产物（lib/state/gates/**）：.ts 源 → 同目录 .js/.d.ts 回拷。
  'state/gates/cx.js', 'state/gates/cx.d.ts',
  'state/gates/helpers.js', 'state/gates/helpers.d.ts',
  'state/gates/detect.js', 'state/gates/detect.d.ts',
  'state/gates/presence.js', 'state/gates/presence.d.ts',
  'state/gates/reason-vocabulary.js', 'state/gates/reason-vocabulary.d.ts',
  'state/gates/entry.js', 'state/gates/entry.d.ts',
  'state/gates/plan-contract.js', 'state/gates/plan-contract.d.ts',
  'state/gates/exit.js', 'state/gates/exit.d.ts',
  'state/gates/command.js', 'state/gates/command.d.ts',
  'state/gates/targets.js', 'state/gates/targets.d.ts',
  'state/gates/complete.js', 'state/gates/complete.d.ts',
  'state/gates/status.js', 'state/gates/status.d.ts',
  'state/gates/handoff.js', 'state/gates/handoff.d.ts',
  'wave-plan.js', 'wave-plan.d.ts',
  'types/contracts.js', 'types/contracts.d.ts',
  'governance/types.js', 'governance/types.d.ts',
  'governance/decisions.js', 'governance/decisions.d.ts',
  'governance/classify.js', 'governance/classify.d.ts',
  'governance/narrow.js', 'governance/narrow.d.ts',
  'governance/tool-ban.js', 'governance/tool-ban.d.ts',
  'governance/config.js', 'governance/config.d.ts',
  'governance/kernel.js', 'governance/kernel.d.ts',
  'governance/preset-loader.js', 'governance/preset-loader.d.ts',
  'governance/index.js', 'governance/index.d.ts',
  // 【P2 · arch-context】架构上下文注入件（`lib/engine/arch-context.ts`）：.ts 源 → 同目录 .js/.d.ts 回拷。
  //   漏本行 ⇒ lib 下无该模块 ⇒ `dispatch.js` 的 import 运行期 `ERR_MODULE_NOT_FOUND`。
  'engine/arch-context.js', 'engine/arch-context.d.ts',
];

for (const f of files) {
  const src = join(built, f);
  const dest = join(root, 'lib', f);
  if (!existsSync(src)) throw new Error('missing built artifact: ' + src);
  cpSync(src, dest);
  console.log('copy -> lib/' + f);
}

rmSync(join(root, '.tsbuild'), { recursive: true, force: true });
console.log('removed .tsbuild');
