// test/helpers/write-intercept.preload.mjs —— 写入拦截的**安装点**（preload 时相；lane p1-intercept）
//
// 用法（在隔离 preload **之后**串联，顺序即 argv 顺序）：
//   node --import ./test/helpers/isolated-home.preload.mjs \
//        --import ./test/helpers/write-intercept.preload.mjs \
//        --test test/home-isolation.test.js
//
// 契约（环境变量）：
//   PUNKY_INTERCEPT_ROOT    拦截根（缺省回落 PUNKY_TEST_ISOLATED_HOME；两者皆空 ⇒ 非零退出）
//   PUNKY_INTERCEPT_REPORT  报告落盘路径（缺省 `<root>/.write-intercept/report.txt`）
//   PUNKY_INTERCEPT_THROW   置 1/true ⇒ 越界即抛（构造「必须红」用）
//
// fail-closed：根不可解析 / 报告不可写 / 拦截未装上 ⇒ stderr + 非零退出。
//   **绝不**以「未拦截」状态静默继续 —— 否则本机制会退化成又一个假绿源。

import fs from 'node:fs';
import path from 'node:path';
import { installWriteIntercept, writeInterceptReport, resolveTarget } from './write-intercept.mjs';

function abort(reason) {
  process.stderr.write('[write-intercept.preload] 拦截前置失败：' + reason + '\n');
  process.stderr.write('[write-intercept.preload] 进程终止（拒绝以未拦截状态继续）\n');
  process.exit(1);
}

const declaredRoot = (process.env.PUNKY_INTERCEPT_ROOT ?? process.env.PUNKY_TEST_ISOLATED_HOME ?? '').trim();
if (!declaredRoot) abort('未声明 PUNKY_INTERCEPT_ROOT / PUNKY_TEST_ISOLATED_HOME');
const rootResolved = resolveTarget(declaredRoot);
if (!rootResolved.ok) abort('拦截根解析失败(' + rootResolved.reason + ')：' + declaredRoot);

const reportPath = (process.env.PUNKY_INTERCEPT_REPORT ?? path.join(rootResolved.real, '.write-intercept', 'report.txt')).trim();
try { fs.mkdirSync(path.dirname(reportPath), { recursive: true }); } catch (e) {
  abort('报告目录不可建：' + path.dirname(reportPath) + ' —— ' + String(e && e.message));
}

const throwOnViolation = /^(1|true|on|yes)$/i.test((process.env.PUNKY_INTERCEPT_THROW ?? '').trim());

let handle;
try {
  handle = installWriteIntercept({
    root: rootResolved.real,
    allow: [reportPath],                      // 报告自身不算越界（否则自触发）
    throwOnViolation,
  });
} catch (e) {
  abort('安装失败：' + String(e && e.message));
}
if (!handle || !Array.isArray(handle.covered) || handle.covered.length === 0) abort('包裹清单为空（无可包裹入口）');

// 报告在**进程退出**时落盘（同步 handler ⇒ 可用 writeFileSync；内部走原始函数，不自我触发）
process.on('exit', (code) => {
  try {
    const payload = writeInterceptReport(reportPath, handle);
    // 人读回执走 stderr（不进测试断言面）
    process.stderr.write('[write-intercept.preload] 退出 code=' + code
      + ' 包裹=' + payload.covered.length + ' 违规=' + payload.counts.violations
      + ' 放行=' + payload.counts.allowed + ' 报告=' + reportPath + '\n');
  } catch { /* 报告失败由父进程「缺报告 ⇒ 判红」承接 */ }
});
