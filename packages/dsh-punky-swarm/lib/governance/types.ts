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

// 工具调用级护栏（governance hook，M2）纯函数内核共享类型（G1）。
// 蓝图：upgrade-design-20260831/.../design/m2-detailed.md §2.1（签名级逐字段对齐）。
// 形态决策：TS 纯数据、零依赖（仅类型层，编译期擦除）；消费方 = lib/governance/ 其余 6 组件 + wiring.js。
// P0 硬化（harden-plan §5.1）：A2 方案——Rule 增加显式 narrow?: NarrowBounds[]（对齐 narrow.ts 契约，
//   {path, max?, min?, enum?, pattern?}）；narrowedParams 类型精化为 NarrowResult（向后兼容：旧规则无 narrow 字段不钳制）。

// 类型级引用（import type 编译期擦除，零运行期依赖；narrow.ts 无反向 import，无环）
import type { NarrowBounds, NarrowResult } from './narrow.js';

// P1 硬化（harden-plan §5.2）：DEFER/PAUSE 文件态简版状态机 + REQUIRE_APPROVAL ask 接线——
//   RefusalReceipt 扩展可选 deferMeta?/pauseMeta?/ask? 字段（§4.2 收据扩展向后兼容：旧收据无字段不炸）。
// P2 硬化（harden-plan §5.3 A）：收据签名/哈希锚定——RefusalReceipt 扩展可选 anchor? 字段
//   （M5-d 证据信封简版：sha256 哈希链；同 session 收据按 ts 序串链，篡改任一收据破坏后续链）。
//   anchor 由收据落盘层（receipt-store.js writeRefusal/verifyRefusals）写/验——TS 内核不触碰（纯数据）。
//   hash 覆盖 receipt 除 anchor 自身外全部字段（含 prevHash），即 hashContent({...body, prevHash})。

// DEFER 延后元信息（flag.defer=true 且 P5 soft 违规命中时 wiring 写状态后随收据落盘）。
//   deferId：状态文件与收据共用的延后标识（重试 deny reason 溯源）；retryAfterMs：延后窗口；
//   until：窗口截止 ISO ts（惰性过期判定点：读时比较 now vs until）。
export interface DeferMeta {
  deferId: string;
  retryAfterMs: number;
  until: string;
}

// PAUSE 暂停元信息（flag.pause=true 且 P3 pausable 违规命中时 wiring 写状态后随收据落盘）。
//   pauseToken：状态文件与收据共用的暂停令牌（同 session 后续 deny reason 溯源）；until：窗口截止。
export interface PauseMeta {
  pauseToken: string;
  until: string;
}

// REQUIRE_APPROVAL ask 记录（宿主 serviceAsk 通道接线，HOST:3303-3354；dsh 侧不实现审批服务）：
//   pre 同步落盘 initiated（必做）；post 观察者尽力补记 outcome（写失败仅 warn，不改变返回语义 §4.4）。
//   outcome 枚举 = 宿主降级/放行结果（无审批服务/无 agent/用户拒绝/取消/通道不可用/一次性放行）。
export interface ReceiptAskMeta {
  channel: 'host-serviceAsk';
  initiated: string;   // ISO ts（= 收据 ts，pre 落盘时刻）
  requestId: string;   // 宿主 ask 关联 id（= 调用 callId；审批请求经 approval.request({callId})，审计可回溯）
  outcome?: 'denied-no-approval' | 'denied-no-agent' | 'denied-rejected' | 'denied-cancelled' | 'unavailable' | 'allowed-once';
}

// 6 治理原语（CAGE GovernanceDecision 六原语，hf.md:76-77）：
//   ALLOW=放行透传 / DENY=拒绝执行 / REQUIRE_APPROVAL=人工审批通道 / DEFER=延后 /
//   NARROW=参数收窄指引 / PAUSE=暂停（2.2 简版：DENY/DEFER/NARROW/PAUSE 统一 deny + 收据元信息）。
export type GovernancePrimitive =
  | 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' | 'DEFER' | 'NARROW' | 'PAUSE';

// M5-a 违规计数升级（§4 escalation 键）可计入原语子集：DENY/NARROW 默认计入；DEFER/PAUSE 自带
//   30s/60s 短窗自愈（state-store.js）默认不计、可显式扩入；REQUIRE_APPROVAL（ask 流程）与
//   状态门收据（ruleRefs=[]）设计红线不可配入（§1.5）——resolve 校验层拒绝/回退（见 config.ts）。
export type EscalationPrimitive = 'DENY' | 'NARROW' | 'DEFER' | 'PAUSE';

// M5-a 违规计数升级配置（§4 装配键 governance.hook.escalation）——出厂默认关（enabled:false =
//   零计数零记录零升级，桥接维持现状仅 jsonl；与 hook enabled:true 内核就位零拦截正交）。
export interface GovernanceEscalationConfig {
  enabled: boolean;         // 总开关（默认 false）
  threshold: number;        // 窗口内可计入 refusal 数阈值（整数 ≥1；默认 3，与 failed-escalate 同值不同键）
  windowMs: number;         // 滚动计数窗口毫秒（≥1000；默认 600000 = 10 分钟）
  primitives: readonly EscalationPrimitive[]; // 计入的拒绝类原语子集（默认 ['DENY','NARROW']；freeze 后只读）
}

// 违规类别（classify 六分路 P0-P6 + 兜底 的判档依据，蓝图 §4）。
export type ViolationCategory =
  | 'hard' | 'pausable' | 'narrowable' | 'soft' | 'manual_review' | 'ftra' | 'unknown';

export interface Violation {
  code: string;            // 规则编号（可溯源；M5-f 红线：无来源编号禁止，design.md:192）
  category: ViolationCategory;
  severity?: number;       // 0-1（P5 置信度对照用）
  message: string;         // 违规说明（入收据 reason）
  path?: string;           // 涉及参数路径（JSON Pointer，NARROW 用）
}

export interface Rule {
  id: string;                              // 规则 id（收据 ruleRefs 溯源）
  tools?: string[];                        // 命中工具白名单；缺省=全工具
  match: {                                 // 参数匹配（与窄域 DAG 无关，纯规则引擎）
    path?: string;                         // JSON Pointer（缺省=匹配整个 arguments）
    pattern?: string;                      // 正则（对 path 值）
    op?: 'eq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'regex';
    value?: unknown;
  };
  violations: Violation[];                 // 命中产出违规描述（1..n）
  narrow?: NarrowBounds[];                 // P0（A2 方案）：显式钳制界限（narrow.ts NarrowBounds 契约）；
                                           //   旧规则无该字段 → 不钳制（向后兼容）
}

export interface GovernanceConfig {
  enabled: boolean;         // hook 总开关
  rules: Rule[];            // 规则表（空表=零拦截，decide 恒 ALLOW）
  defaults: { deny: GovernancePrimitive }; // fail-closed 兜底（默认 DENY）
  flags: { pause: boolean; narrow: boolean; defer: boolean }; // 原语开关（CAGE feature-flag 借鉴，hf.md:83-85）
  escalation: GovernanceEscalationConfig; // M5-a：违规计数升级（§4；resolve 恒返回——默认关形态）
}

// P2 哈希锚定信封（M5-d 简版）：version=1 表示 sha256 内容哈希链布局。
//   prevHash：链上前一收据的 hash（同 session 按 ts 序；首收据 null）；hash：本收据内容哈希。
//   （版本字段为后续锚定方案演进预留——WORM/真签名归 M5，本批不引入。）
export interface ReceiptAnchor {
  version: 1;                    // 锚定方案版本（当前 1 = sha256 简版哈希链）
  alg: 'sha256';
  prevHash: string | null;       // 链上前一收据 hash（首收据 null）
  hash: string;                  // 本收据内容哈希（覆盖除 anchor 自身外全部字段含 prevHash）
}

export interface RefusalReceipt {          // 对齐 CAGE RefusalReceipt 简版（design.md:115；verdict2.md:50 口径）
  receiptId: string;                       // uuid（对齐 evidence 内容寻址之外的独立 id）
  ts: string;                              // ISO 时间戳
  tool: string; callId: string; sessionId: string | null;
  decision: { primitive: GovernancePrimitive; priority: number | null; reason: string };
  attemptedParams: unknown;                // 尝试参数（attempted_params）
  narrowedParams?: NarrowResult;           // NARROW 时给模型的钳制指引（narrowed 参数 + clamped 明细）；可选，旧收据无此字段不炸
  deferMeta?: DeferMeta;                   // P1：DEFER 触发（含状态门 deny）元信息；可选，旧收据无此字段不炸
  pauseMeta?: PauseMeta;                   // P1：PAUSE 触发（含状态门 deny）元信息；可选，旧收据无此字段不炸
  ask?: ReceiptAskMeta;                    // P1：REQUIRE_APPROVAL ask 记录（initiated + 尽力补记 outcome）；可选，旧收据无此字段不炸
  anchor?: ReceiptAnchor;                  // P2：sha256 哈希链锚定（落盘层写/验）；可选，旧收据无此字段不炸（§4.2）
  ruleRefs: string[];                      // 命中规则 id（可溯源）
}

export interface KernelDecision {
  primitive: GovernancePrimitive;
  priority: number;                        // P0-P6；ALLOW = -1
  reason: string;                          // 拒绝正文（无前缀；前缀由 wiring 统一加）
  narrowedParams?: NarrowResult;           // P0 接线后：NARROW / DENY-含-narrowable 时填充（computeNarrowedParams 结果）
  ruleRefs: string[];
}
