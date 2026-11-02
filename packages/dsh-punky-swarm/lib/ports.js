/**
 * `lib/ports.ts` —— 内核端口与执行契约的**唯一契约面**（纯类型，零实现）。
 *
 * ## 约束（本文件的存在条件，改动前必读）
 * 1. **零运行期 import**：全文不得出现任何 `import` / `require` 语句——
 *    机核 `grep -cE '^(import|require)' lib/ports.ts` 必须为 **0**。
 *    因此本文件引用的每个结构都在此**就地声明**（结构型最小形状），不做跨模块类型引用。
 * 2. **只写类型、不接线**：无实现、无副作用、无运行期导出值。任何模块 import 本文件
 *    只应取 `type`，不得依赖其运行期存在。
 * 3. **零业务行为**：本文件不参与波次 / 门禁 / 交接 / 结算任何判定路径。
 * 4. **宿主形态值不进本契约面**（AC-5″）：本文件内宿主实现形态的键名字面量必须为 **0**。
 *    宿主「用的是哪个启动入口」属 provider 内部状态；引擎与适配层只许读**功能面读数**
 *    （`available` / `canNarrow` / `narrowVia` / `personaVia` / `depthVia` / `reason`）。
 * 5. **契约即唯一形状**：本文件只声明「引擎向适配层要什么」，**实现一律归 provider**
 *    （`lib/provider-dsh/**`）。在本文件里写实现 = 把 provider 的活做在错的位置。
 *
 * ## 本轮的形状变更（批 `punky-adapter-split-20261031` · lane `w1-contract-ports`）
 * 一次补齐四件（**禁止分两次改本文件**——漏项就要二次改契约）：
 * ① `AgentRuntime.push_execute` 落地为唯一执行动词（此前契约有、三方皆无实现，是 G01 的核心洞）；
 * ② `canNarrow` / `narrowVia` / `personaVia` / `depthVia` 四个**功能面读数**入契约；
 * ③ 宿主形态值出契约（不导出、引擎不消费）；
 * ④ `AgentRuntime.notifyLeader` 新增（Leader 唤醒通路，此前全仓 0 命中）。
 * 另按 `plan/contract-shape.md` §2 的目标形状一次补齐其余槽位的方法面
 * （`ToolSurface` / `HttpSurface` / `RosterSource` / `AuditSink`），理由同上：契约必须一次到最终形状，
 * 否则迁一个槽位就要改一次契约。
 *
 * ## 与蓝图的关系
 * 字段集对齐 `punky-refactor-blueprint-v4.md` §3.1（端口）与 §3.3（执行契约）。
 * 刻意**不含** `stopReason`：活性由内核从证据推导，不由执行体声明。
 *
 * ## 回拷登记
 * 本文件已登记进 `scripts/copy-ts-built.mjs` 回拷清单（`ports.js` / `ports.d.ts`）。
 * `ports.d.ts` 是**构建产物，禁手改**：改本文件后须重生成（`tsc -p tsconfig.build.json`）。
 * 漏登记的症状是「`.tsbuild` 里有、运行期 `ERR_MODULE_NOT_FOUND`」——已在 `rule-propagation.ts`
 * 上取到过一次 RED 读数，故此处先登记后接线。
 */
export {};
