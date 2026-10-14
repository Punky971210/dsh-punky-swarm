# 上游内核缺陷登记（upstream defects）

> 本文件登记 **dsh / cordis 内核**（上游依赖）的缺陷，不是本仓缺陷。
> 为什么不修：本仓红线是**不改 dsh 核心包与 cordis 本体**——核心由官方更新，fork 之后每次官方发版都要手工追平，
> 维护成本不可接受。因此本仓对上游缺陷只做「登记 + 规避」，不改上游一行代码。
> 为什么要登记：这两条缺陷都会**穿过内核 API 边界传到插件调用点**（见各节「影响」），
> 读者在自建 exporter / 自渲染日志时可能踩到同一处；本仓的规避做法一并写出，便于对照与独立复核。
> 复现环境：Windows，Node v24.18.0（本仓 `engines` 下限为 Node 22；本节结论未在 Node 22 上单独复跑）。
> 取证对象：`@deepseek-ai/cordis`，源码文件 `src/logger.ts`（该包随包分发 `src/`，可直接对照）。

## 缺陷总览

| 编号 | 一句话 | 影响面 | 本仓规避 | 上游状态 |
|---|---|---|---|---|
| UD-1 | exporter disposer 交叉击杀：销毁先注册的 exporter 会连带杀掉后注册的那个，且先注册的残留 | 同进程内任何「多 exporter 共存 + 调用 disposer」的组合 | `lib/auditlog/sink.js:688-697`：disposer 只记录、**绝不调用**；卸挂走自持开关 | 未上报／未修 |
| UD-2 | `Logger.format` 对不可序列化实参抛错，异常沿 exporter 派发栈穿到 `ctx.logger.*` 调用点 | 任何在 `export()` 内调用 `Logger.format` 的 exporter（本仓审计 sink 即此类） | `lib/auditlog/sink.js:284-292`：`safeFormat` 整体 try + 本地同源渲染兜底 | 未上报／未修 |

实测版本覆盖：**cordis 4.0.1**（本仓 devDependency 实际解析到的版本，`lib/index.js` 为运行入口）与
**cordis 4.0.2**（dsh 0.1.5-rc.1 内置版本）。两条缺陷在**两个版本上表现一致**，故不是版本回退造成的一次性现象。

---

## UD-1 exporter disposer 交叉击杀

### 现象

同一 `LoggerService` 上注册两个 exporter（记 e1、e2）后，调用 **e1 的 disposer**，结果：
**e2 被移除、e1 仍在册**。此后 e2 不再收到任何日志，而 e1 会一直收到——两件事同时错。

### 复现方式

- 源码依据（`src/logger.ts`，`LoggerService.exporter`）：

  ```ts
  exporter(exporter: Exporter) {
    return this.ctx.effect(() => {
      this.exporters.set(++this._snExporter, exporter)
      return () => this.exporters.delete(this._snExporter)
    }, 'ctx.logger.exporter()')
  }
  ```

  注册时用自增序号 `++this._snExporter` 作 Map 键；disposer 执行时**重新读取当时的 `this._snExporter`**，
  而不是闭包捕获注册那一刻的键。于是 disposer 删掉的永远是「当下最大的那个键」。
  `LoggerService` 构造器自己先注册了一个内置 buffer exporter，故第一个插件 exporter 得键 2、第二个得键 3。

- 运行时入口同样可核对：编译产物 `lib/index.js` 内 `exporter(exporter)` 一段与之逐行同形。

- 最小复现（Node ESM，直接跑）：

  ```js
  import { Context } from '@deepseek-ai/cordis';

  const svc = new Context().logger;
  const seen = [];
  const mk = (tag) => ({ colors: false, levels: { default: 3 }, export: () => seen.push(tag) });
  const e1 = mk('e1');
  const e2 = mk('e2');
  const d1 = svc.exporter(e1);
  svc.exporter(e2);

  seen.length = 0; svc.info('before');
  console.log('before:', seen.slice(), 'size:', svc.exporters.size);   // 期望 [e1, e2] / 3（含内置）

  d1();                                                                 // 只应移除 e1
  console.log('after keys:', [...svc.exporters.keys()]);                // 期望 [1, 3]（e2 仍在）
  const still = { e1: false, e2: false };
  for (const v of svc.exporters.values()) { if (v === e1) still.e1 = true; if (v === e2) still.e2 = true; }
  console.log('e1 在册:', still.e1, ' e2 在册:', still.e2);              // 期望 true / true

  seen.length = 0; svc.info('after');
  console.log('after:', seen.slice());                                  // 期望 ['e1']
  ```

- 实测回显（连续两次独立运行，分别对 4.0.1 与 4.0.2）：

  ```
  size0(builtin only)=1 after two registrations=3 keys=[1,2,3]
  seen before dispose = ["e1","e2"]
  after d1() size=2 keys=[1,2] e1StillRegistered=true e2StillRegistered=false
  seen after dispose = ["e1"]
  keys after re-register=[1,2,4] _snExporter=4
  ```

  对照期望（`size` 应回到 2 且键为 `[1,3]`、`e2` 仍收消息）：**实测 e2 消失、e1 残留**——缺陷成立。
  末行还暴露一处附带效应：`_snExporter` 单调递增不回退，键不复用，反复注册会让 Map 键持续增长
  （一个 exporter 若被移除再注册会拿到新键，旧键永不回收）。

### 影响

- 多 exporter 共存的进程里，**任意一次 dispose 都可能误杀无辜的邻居**；被误杀者静默失去日志，无异常、无告警。
- 依赖「卸载自己」的插件无法真正卸载：调用 disposer 既没清掉自己，还破坏了别人。
- 本仓审计 sink 若调用 disposer，会连带杀掉宿主/其它插件的 exporter（尤其是后来注册的那些）；
  宿主日志面因此可能静默缺失，而故障现象与审计日志毫无表面关联，排障成本高。

### 为何不在本仓修

本仓红线：不改 dsh 核心包与 cordis 本体。修这一条要动 `LoggerService.exporter` 的键捕获语义
（把注册键闭包捕获，或改成 `Map<Exporter>`），属于内核行为变更；fork 后需手动追官方更新，
维护成本不可接受。故本仓只登记 + 规避。

### 本仓规避方式

`lib/auditlog/sink.js:688-697`（`mountAuditLog` 内）：

- `disposer = logger.exporter(exporter)` 的返回值**只赋值记录，绝不调用**（`void disposer;`），
  因此本仓在任何路径上都不会触发该 disposer，也就不会误杀邻居；
- 卸挂不依赖内核 disposer，改走**自持开关**（`PUNKY_AUDITLOG` env / `capabilities.auditlog.enabled` 配置）：
  开关关闭时 sink 首行直接 return（不取 logger、不建目录、不注册 exporter、零字节写入）。
- 代价（如实说明）：本仓因此无法在运行期主动注销自己的 exporter；进程内只能存在一个 sink 实例
  （sink 侧以 `state.mounted` 幂等守卫保证单挂载）。

---

## UD-2 `Logger.format` 对不可序列化实参抛错，异常穿到调用点

### 现象

`Logger.format` 的 `%o / %O` 占位符直接调 `JSON.stringify` 且**没有 try 保护**；
传入循环引用对象、`BigInt` 等不可序列化值时抛 `TypeError`。
由于渲染发生在 exporter 自己的 `export()` 调用栈内、而内核派发循环对该调用**无 try/catch**，
异常会一路穿到业务侧 `ctx.logger.info(...)` 的调用点——「记录一条日志」变成「可能抛错的调用」。

### 复现方式

- 源码依据（`src/logger.ts`）：默认格式化器 `o: (value) => JSON.stringify(value)`、`O` 同；
  `Logger.format` 的占位符替换与尾参渲染两处都直接用该格式化器，无 try/catch；
  `Logger._method` 的派发循环形如 `for (const exporter of this.service.exporters.values()) { ... exporter.export(message) }`，同样无 try/catch。
- 最小复现：

  ```js
  import { Context, Logger } from '@deepseek-ai/cordis';

  const circular = {}; circular.self = circular;

  // ① 直接调静态渲染
  try { Logger.format({ colors: false }, { args: ['x %o', circular], name: 'root' }); }
  catch (e) { console.log('circular ->', e.constructor.name + ': ' + e.message.split('\n')[0]); }
  try { Logger.format({ colors: false }, { args: ['x %o', 10n], name: 'root' }); }
  catch (e) { console.log('bigint   ->', e.constructor.name + ': ' + e.message.split('\n')[0]); }

  // ② 经真实 Context：exporter 内部渲染（本仓审计 sink 就是这种形态）
  const svc = new Context().logger;
  svc.exporter({ colors: false, levels: { default: 3 },
    export: (m) => Logger.format({ colors: false }, m) });   // ← 渲染在此，不在内核派发里
  try { svc.info('boom %o', circular); console.log('call site: no-throw'); }
  catch (e) { console.log('call site ->', e.constructor.name + ': ' + e.message.split('\n')[0]); }

  // ③ 对照组：exporter 不渲染 → 异常不出域
  const svc2 = new Context().logger;
  svc2.exporter({ colors: false, levels: { default: 3 }, export: () => {} });
  try { svc2.info('boom %o', circular); console.log('control: no-throw'); }
  catch (e) { console.log('control ->', e.constructor.name); }
  ```

- 实测回显（4.0.1 与 4.0.2 一致）：

  ```
  circular %o -> THREW: TypeError: Converting circular structure to JSON
  bigint %o -> THREW: TypeError: Do not know how to serialize a BigInt
  non-string first arg (auto %o) -> THREW: TypeError: Converting circular structure to JSON
  extra object arg (tail loop) -> THREW: TypeError: Converting circular structure to JSON
  propagation via ctx.logger.info (exporter 内调 Logger.format): callSite=TypeError: Converting circular structure to JSON | exporter.export=called
  control (exporter 不渲染): callSite=no-throw
  ```

  三条要点：
  ① 四种实参形态都会抛（占位符命中、首参非字符串时自动补 `%o`、以及尾参渲染循环）；
  ② 异常确实穿到 `ctx.logger.info` 调用点（`callSite` 拿到了 TypeError，而非被内核吞掉）；
  ③ 对照组证明**传播的前提是 exporter 自己调用了渲染**——渲染在 exporter 侧，不在内核派发循环里，
  这点决定了规避动作该落在哪一层（exporter 侧）。

### 影响

- 任何在 `export()` 内渲染消息的 exporter，都会把渲染失败的异常**反向注入调用方**：
  业务代码一次普通的 `ctx.logger.info('...%o', obj)` 可能抛出，进而在业务路径上引发非预期中断；
  日志系统从「无副作用的旁路」变成「可抛错的依赖」。
- 触发面不小：循环引用对象、`BigInt`、含循环引用的错误上下文都是常见实参。

### 为何不在本仓修

同上红线：不改 dsh 核心包与 cordis 本体。本条要动默认格式化器或派发循环（给 `JSON.stringify` 包 try、
或给 `exporter.export(message)` 包 try），都是内核行为变更，会被官方更新冲刷掉。
故本仓只登记 + 规避。

### 本仓规避方式

`lib/auditlog/sink.js:284-292`（`safeFormat`）：

- 把**整段**内核渲染 `Logger.format(...)` 包进 try；成功沿用内核渲染结果（与宿主日志逐字一致）；
- 失败时记账（`recordError` + `formatFallbacks` 计数），回落到本地同源渲染 `fallbackFormat`：
  同样的占位符语义，但对对象先做安全 JSON 化，保证**行照常落盘**、异常不外抛；
- 与 `lib/auditlog/sink.js` 顶部 L6 契约（`export()` 整体 try/catch，绝不 rethrow）叠加，
  形成两层兜底：渲染层兜格式化异常、导出层兜其余一切异常。

---

## 取证记录

| 项 | 内容 |
|---|---|
| 环境 | Windows；`node -v` → `v24.18.0` |
| 被测版本 | `@deepseek-ai/cordis` 4.0.1（仓库内解析）与 4.0.2（dsh 内置）；两条缺陷在两者上输出逐字一致 |
| 源码依据 | `@deepseek-ai/cordis/src/logger.ts`：`LoggerService.exporter`（disposer 重读 `_snExporter`）、`defaultFormatters.o/O`（裸 `JSON.stringify`）、`Logger.format`（无 try）、`Logger._method`（派发循环无 try） |
| 复现手段 | 两份**独立探针脚本**（一份不依赖本仓任何模块，仅 import cordis；一份经真实 `Context` 走 `ctx.logger` 调用点），逐条打印原始回显；本文件所载回显为脚本**原始输出**，未润色 |
| 未做 | 未向上游提单；未在本仓或内核侧做任何修补（红线）；未在 Node 22 上复跑（本仓 `engines` 下限为 Node 22） |

> 复现脚本不随仓库分发：本文给出可独立运行的完整片段，第三方按「复现方式」逐行执行即可得到同款回显。
