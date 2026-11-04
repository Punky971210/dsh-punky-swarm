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
/** 收窄路径：工具面 / 人格的**实际生效方式**。`'none'` = 本次**未**收窄（不得读作「已收窄」）。 */
export type NarrowPath = 'request' | 'preset' | 'none';
/** 委派深度的生效方式。 */
export type DepthPath = 'request' | 'none';
/**
 * 取消请求的**回报三态**（批 `punky-three-tasks-20261103` · lane `impl-cancel` · T-B）。
 *
 * 为什么需要它：`cancel` 原签名 `Promise<void>` **零回报**，而本契约里 `AgentRuntime.cancel`
 * 的注释本就写着「语义为『停止等待』，**不得把未知当已停**」—— `void` 签名**结构性无法表达**该区分。
 * 本类型是把那句已有文字**落实为类型**（不是新增需求）。
 *
 * - `cancelled`：宿主确认已停（**唯一**可当作「停了」的取值）；
 * - `skipped`  ：没有可取消的对象（已完成 / 未开始 / 句柄失效）—— **不是**「已停」；
 * - `rejected` ：宿主拒绝、或返回形态不可识别 ⇒ **无法确认**；调用方**必须**按「可能仍在跑」处理。
 *
 * ⚠ 纪律：`rejected` 不得被调用方降级成 `cancelled` —— 「不知道」就是 `rejected`（fail-closed）。
 */
export interface CancelResult {
    outcome: 'cancelled' | 'skipped' | 'rejected';
    reason?: string;
}
/**
 * 取消信号的最小结构形状。
 *
 * ⚠ **就地声明、不引外部类型**（本文件零 import 约束）：只要满足「有布尔 `aborted`」即可，
 * 不要求原型相同。端口层据此判定入参合法，**不得**按原型校验（测试桩常为字面对象）。
 */
export interface AbortSignalLike {
    readonly aborted: boolean;
}
/**
 * 一次请求希望收窄到的**工具面**。
 *
 * - `deny`：本次要求**禁掉**的工具名（功能面工具名，非宿主字段）；
 * - `allow`：本次要求**保留**的工具名；两者可并存。
 *
 * ⚠ 本结构只表达**请求方的意图**，不表达「实际拿到了什么」。实际是否收窄由
 * `AgentRuntime.canNarrow` 与 `narrowVia` 回答，二者**不得**被互相替代。
 */
export interface ToolFace {
    deny?: readonly string[];
    allow?: readonly string[];
}
/**
 * 成员执行运行时。**唯一的执行动词是 `push_execute`**（收窄自「回读 / 注入 / 驱动」三动作：
 * 名册与工具面归内核自持后，回读与注入不再是端口，而是初次装配的一次性动作）。
 *
 * 本接口分成**两类成员**，读法不同、纪律不同：
 * - **能力位读数**（`available` / `canNarrow` / `narrowVia` / `personaVia` / `depthVia`）：
 *   引擎**只许**读这些来判断「要得到 / 要不到功能」，并据此可判定地拒派（J6-e 允许面）。
 *   读数**必须**来自实测（`narrowVia` 不得由形态推导得出）。
 * - **动作**（`push_execute` / `cancel` / `notifyLeader`）：要功能、取消、唤醒 Leader。
 *
 * ⚠ **禁止**让本接口携带任何「宿主长什么样」的字段（AC-5″）。引擎可因「功能拿不到」而拒，
 * 不可因「宿主形态」而拒。
 */
export interface AgentRuntime {
    /**
     * 本宿主 + 本配置下**该功能面是否可用**。
     *
     * `false` 的语义是「拿不到功能」，调用方须走可判定降级/拒态，**不得**静默当成可用。
     */
    readonly available: boolean;
    /**
     * 能否按**本次请求**收窄工具面 / 人格。
     *
     * 判据（两段，缺一不可）：
     * ① 若 `ask` **未表达收窄需求**（`toolFace` 两集皆空且无 `persona`）⇒ 返回 `true`
     *    （无收窄需求不构成「以弱换强」）；
     * ② 否则 ⇒ 必须有**可核对的收窄见证**才返回 `true`；见证不可得返回 `false`。
     *
     * ⚠ **`ask` 为空对象时返回的 `true` 不得被读作「该 lane 已被收窄」**——那只表示
     * 「本次未提出收窄要求」。调用方若要判定「这次派发是否安全」，必须传真实
     * `{ role, toolFace, persona }`。
     * ⚠ **不可核对的收窄不得宣称成立**（fail-closed）：只配了一个预设名字符串、
     * 而无法核对该预设对本次工具面的覆盖关系时，本方法必须返回 `false`。
     */
    canNarrow(ask: NarrowAsk): boolean;
    /**
     * 工具面收窄**实际**经哪条路生效（实测结果，不是形态推导）。
     *
     * - `'request'`：按次请求面直接生效；
     * - `'preset'`：经预设组合生效，且**已验证**该预设覆盖本次请求；
     * - `'none'`：本次**未**收窄。
     *
     * ⚠ 本读数是**诊断/能力位**，**不得**作入口选择的分支条件（入口选择属 provider 内部）；
     * 分支只许问 `canNarrow`。
     */
    readonly narrowVia: NarrowPath;
    /** 人格**实际**经哪条路生效（实测）。取值域与纪律同 `narrowVia`。 */
    readonly personaVia: NarrowPath;
    /** 委派深度限制**实际**经哪条路生效（实测）。 */
    readonly depthVia: DepthPath;
    /**
     * 执行一次成员 spec，返回结果。
     *
     * 语义 = 「启动一次成员执行并回报可核对证据」。适配器**不得自选或扩员 target**。
     * `ExecSpec` 中 `dispatch` **之外**的字段是内核的持久化/恢复校验面，适配器**不消费**
     * （不得假装消费，也不得因它们在场而改行为）。
     */
    push_execute(spec: ExecSpec): Promise<ExecResult>;
    /**
     * 请求取消一次已发出的执行；语义为「停止等待」，不得把未知当已停。
     *
     * 取消**按执行标识**进行，不得把宿主侧取消原语的参数表原样透出给调用方。
     *
     * 【T-B · 批 `punky-three-tasks-20261103`】返回**三态** `CancelResult`（`cancelled`/`skipped`/`rejected`）：
     * 原 `Promise<void>` 零回报 ⇒ 调用方无法区分「已停」与「不知道」，正好违背上一行的「不得把未知当已停」。
     * 适配器须把宿主返回**归一**到三态；不可识别的宿主返回一律判 `rejected`（**禁默认 `cancelled`**）。
     */
    cancel(runId: string): Promise<CancelResult>;
    /**
     * 唤醒一个会话的所有者（Leader 唤醒通路）。
     *
     * 收窄自「先取宿主会话句柄、再调其推送原语」的两步：调用方**不得**拿到、也**不得**解引用
     * 任何宿主句柄；本方法只接受元数据，投递结果由返回值表达。
     * 不可用时**不抛**，以 `NotifyLeaderResult.reason` 表达成因（供调用方降级留痕）。
     */
    notifyLeader(request: NotifyLeaderRequest): Promise<NotifyLeaderResult>;
}
/**
 * `canNarrow` 的提问形状。
 *
 * ⚠ `ask` 的**每一段都必须来自该 lane 的真实数据**；传空对象等于放弃判定。
 */
export interface NarrowAsk {
    /** 该 lane 的角色名（用于解析该角色的工具面约束）。 */
    role?: string;
    /** 本次要求收窄到的工具面。 */
    toolFace?: ToolFace | null;
    /** 本次要求注入的人格文本（非空即视为有收窄需求）。 */
    persona?: string | null;
}
/** 唤醒请求。**只带元数据**：禁把消息正文复制成契约面字段之外的第二处真源。 */
export interface NotifyLeaderRequest {
    /** 目标会话标识（要唤醒的那一方的会话 id）。 */
    sessionId: string;
    /** 唤醒消息体（已由调用方定型的结构；本层不改写语义）。 */
    message: Readonly<Record<string, unknown>>;
}
/** 唤醒结果。不可用时 `delivered:false` + `reason`，**不抛宿主原生错**。 */
export interface NotifyLeaderResult {
    delivered: boolean;
    /** 功能面成因（禁写宿主服务名/入口名）；`delivered:true` 时常为 `null`。 */
    reason?: string | null;
}
/** 审计出口。 */
export interface AuditSink {
    /**
     * 追加一条审计事件（内核已定型的 event 对象，sink 只落盘不改义）。
     *
     * 定性订正：本槽位**默认由内核自持实现，是唯一实现**；`KernelPorts` 的必需位与
     * 端口注入面的存在只为**测试缝**（注入替换内核 sink 用于构造反例），
     * 不是「允许外部替换审计」的承诺。
     */
    append(event: Readonly<Record<string, unknown>>): void;
}
/** 名册条目（宿主中立最小集；其余字段由调用方按需自取，不进契约）。 */
export interface RosterRow {
    readonly name: string;
    readonly id?: string;
    readonly role?: string;
    readonly status?: string;
}
/**
 * 名册来源。缺失 ⇒ 内核使用内建 roster（不是「不支持」）。
 *
 * ⚠ **术语区分（必读，防两件事被当成一件）**：本处「内建 roster」= `lib/roster.js#BUILTIN_ROLES`
 * 的**静态职位名表**（本仓认为**该有哪些**席位：`manager` / `lead` / …；常量、零写入），
 * **不是**「谁**真的在座**」的**席位登记表**——后者由**引擎自建**、落批次字段
 * `batch.managerSeat`（`source:'engine-registry'`），写入道仅 `batch_phase({manager})`。
 * ⇒ 「缺失就用内建的」**只覆盖职位名表**（对账基准），**不构成**在册真源；在册判定读批次表。
 */
export interface RosterSource {
    /**
     * 读取宿主侧名册，仅用于与内建 roster **对账**，不得作为权威。
     *
     * ⚠ **只供对账**（真源 = 引擎自建表）：`inRoster` 一类判定**不得**读本方法。
     */
    read(): Promise<RosterRow[]>;
    /**
     * 按名查该成员所属的会话标识（子代理派发配套；此前散在引擎侧）。
     *
     * 三档语义（**必须区分**，禁归并成「查不到」）：
     * - 名在场 ⇒ 返回其会话标识；
     * - 名**不在**名册 ⇒ 返回 `null`（**正常态**，调用方不得当失败）；
     * - 查询本身失败（宿主侧抛错）⇒ **抛**，不得返回 `null`（否则「查不到」与「查询坏了」不可分）。
     *
     * ⚠ 与 `read()` **不同源**：本方法只要一个反查结果，不承担成员清单职责
     * （把两者合成一个方法会让两个不同用途的调用方互相污染）。
     */
    sessionOf(name: string): Promise<string | null>;
}
/** 工具面探测的**三态**结果。查询失败**不得**降级为「不存在」。 */
export type ToolProbeResult = {
    readonly state: 'present';
    readonly definition: unknown;
} | {
    readonly state: 'absent';
    readonly reason?: string;
} | {
    readonly state: 'errored';
    readonly reason: string;
};
/** 工具调用请求。 */
export interface ToolInvokeRequest {
    /** 工具名（功能面名）。 */
    name: string;
    /** 入参。 */
    args?: Readonly<Record<string, unknown>>;
    /**
     * 取消信号（**必填**）。
     *
     * 缺失/非法 ⇒ 端口层抛自己的拒态（业务可识别的参数错），**禁**下沉成宿主的参数校验错。
     * 调用方**不得**因此改为「永不放弃」的假信号——那等于把取消通道关掉。
     */
    signal: AbortSignalLike;
    /** 关联标识（由本层按需填充，不透出宿主字段名）。 */
    correlation?: string;
}
/** 工具 guard：返回非空字符串即拒。 */
export type ToolGuard = (execution: unknown) => string | undefined;
/** 工具面。缺失 ⇒ 内核自持注册表（默认不向宿主申请工具面）。 */
export interface ToolSurface {
    /** 本宿主工具面是否可用（不可用时各方法按**降级语义**返回，不抛）。 */
    readonly available: boolean;
    /** 是否已注册。 */
    hasTool(name: string): boolean;
    /** 三态查询（存在 / 不存在 / **查询失败**）。 */
    probeTool(name: string): ToolProbeResult;
    /** 取工具定义；不可用/未注册 ⇒ `null`（不抛）；**查询失败 ⇒ 抛**（禁返 null）。 */
    getTool(name: string): unknown | null;
    /** 注册工具（装配期）。@returns 是否真的调用了宿主注册面 */
    registerTool(definition: Readonly<Record<string, unknown>>): boolean;
    /** 安装 guard（追加语义）。@returns 是否真的安装了 */
    installGuard(guard: ToolGuard): boolean;
    /**
     * 调用工具（具名参数；宿主侧的调用对象在本层内部组装，**不外泄**）。
     *
     * @throws `signal` 缺失/非法；或工具面不可用
     */
    invokeTool(request: ToolInvokeRequest): Promise<unknown>;
}
/**
 * 路由匹配语义（**宿主中立**）。
 *
 * 宿主侧自己的匹配字段由 provider 内部映射，本契约只用本枚举；
 * 调用方声明 `'prefix'` 必须被转发，**不得**在端口层丢弃后硬编码成单一取值。
 */
export type HttpRouteMatch = 'exact' | 'prefix';
/** 一条路由。 */
export interface HttpRoute {
    method: string;
    path: string;
    /** 缺省 = `'exact'`。 */
    match?: HttpRouteMatch;
    handler: (...args: unknown[]) => unknown;
}
/** 挂载结果。 */
export interface HttpMount {
    mounted: boolean;
    dispose: () => void;
}
/** HTTP 面。缺失 ⇒ 内核自起 loopback。 */
export interface HttpSurface {
    /** 本宿主 HTTP 面是否可用。 */
    readonly available: boolean;
    /**
     * 挂载路由。
     *
     * 不可用时**返回 `{ mounted:false, dispose:noop }` 而不抛**（可判定降级，非异常）。
     */
    mountRoute(route: HttpRoute): HttpMount;
}
/**
 * 内核端口集合。
 *
 * - `runtime` / `audit` **必需**：前者是执行面唯一来源，后者恒自持不可替换；
 * - `roster` / `tools` / `http` **可选**：缺失的语义是「内核自建」，**不是**「不支持」。
 *
 * 读取规则：可选端口缺失时走内建路径，且**降级必须可见**（回显字段或事件），禁静默降级。
 *
 * ⚠ **键集冻结为 5 键**：增删槽位会让「槽位键对账」与「成员名对账」两道机检同时变化，
 * 属契约级变更，须单开批。
 */
export interface KernelPorts {
    /** 必须：成员执行与 loop。 */
    runtime: AgentRuntime;
    /** 必需位（内核默认唯一实现；注入面只服务测试缝）。 */
    audit: AuditSink;
    /**
     * 缺失 → 内建 roster（**静态职位名表**，仅供对账基准；**不是**席位登记表——在册真源 = 引擎自建的
     * `batch.managerSeat`，见 `RosterSource` 的术语区分）。
     */
    roster?: RosterSource;
    /** 缺失 → 内核自持注册表（默认不申请宿主）。 */
    tools?: ToolSurface;
    /** 缺失 → 自起 loopback。 */
    http?: HttpSurface;
}
/**
 * 一次成员执行的输入。派发输入是**不可变**的：
 * 恢复挂起执行时必须逐项比对持久化值与当前值，任一不符即拒绝恢复（绑定校验）。
 *
 * 分两组读法（**不可混用**）：
 * - `runId` / `targetId` / `member` / `session` / `taskPkg` / `contract`：
 *   **内核持久化与恢复校验面**，provider **不消费**（显式标注，禁假装消费）；
 * - `dispatch`：provider 的**真实映射面**（把本契约映射成该宿主的一次执行）。
 */
export interface ExecSpec {
    /** 运行标识；绑定校验的锚点之一。 */
    runId: string;
    /** target 由 Leader 给定，适配器**不得自选、不得扩员**。 */
    targetId: string;
    /** 成员描述（最小集；`budget` 用于预算硬停，属准入前置而非产物判定）。 */
    member: {
        id: string;
        title?: string;
        callsign?: string;
        model?: string;
        budget?: number;
    };
    /** 会话下发由黑板持有；`params` 为透传参数，`id` 为空表示新会话。 */
    session: {
        id: string | null;
        params: Record<string, unknown> | null;
    };
    /** 任务包引用（`wave` / `deps` 供恢复期拓扑校验）。 */
    taskPkg: {
        id: string;
        wave?: number;
        deps?: readonly string[];
    };
    /** 完成契约引用（`sha256` 参与绑定校验，契约变更须留痕）。 */
    contract: {
        id: string;
        sha256: string;
    };
    /**
     * **provider 的真实映射面**（本轮新增；此前契约缺此段，导致「纸面动词无对应物」）。
     *
     * 上面那些「内核面」字段 provider 不消费；provider 只从这里取它真正要的东西。
     */
    dispatch: DispatchSpec;
    /**
     * 宿主预设表达位 —— **别名位**，非收窄证据。
     *
     * ⚠ 本字段存在**不得**被读作「收窄能力已生效」：能否按次收窄**只以**运行期读数
     * （`canNarrow` / `narrowVia`）为准。旧注释称「本批不接线…运行仍拒派」已与实现不符，此处订正。
     */
    agentPreset?: string;
    /**
     * 子会话 composition 表达位：一次执行期望的子会话组成（谁、什么角色）。
     *
     * ⚠ 与 `agentPreset` 同为**表达位**：形状只用于表达「期望组成」，**不参与**任何运行期判定
     * 与派发决策；判定只看功能面读数。
     */
    composition?: {
        /** 期望的子会话席位（有序；空/缺省 = 未声明期望组成）。 */
        seats?: readonly {
            /** 席位名（与名册职位的命名口径一致，仅作表达，不做运行期解析）。 */
            role: string;
            /** 该席位的适配器标识（表达位；缺省 = 由宿主决定）。 */
            adapter?: string;
        }[];
        /** 期望的并行度上限（表达位；缺省 = 由引擎/适配器决定，不做运行期裁剪）。 */
        maxParallel?: number;
    };
}
/**
 * 一次执行的**派发映射面**（provider 唯一消费的入参段）。
 *
 * 字段语义均为功能面语言；宿主侧的请求对象由 provider **内部**组装，不外泄。
 */
export interface DispatchSpec {
    /** 后端标识（由配置给出；端口不猜）。 */
    provider: string;
    /** 子会话标签（可从中反解析归属）。 */
    label: string;
    /** 任务包文本。 */
    prompt: string;
    /**
     * 父会话/身份的**不透明引用**。
     *
     * ⚠ 本层**不得**解引用其字段：调用方交出引用、由 provider 交给宿主；契约刻意不声明其形状，
     * 以防宿主字段经此渗进契约面。
     */
    parent: unknown;
    /** 该 lane 的角色名（供收窄解析，不直接交给宿主）。 */
    role?: string;
    /** 本次要求收窄到的工具面。 */
    toolFace?: ToolFace;
    /** 本次要求注入的人格文本。 */
    persona?: string;
    /** 委派深度上限（受宿主能力位约束；不可用时 provider 显式降级，禁静默丢）。 */
    maxDepth?: number;
    /** 工作目录（可选）。 */
    cwd?: string;
    /**
     * 取消信号。
     *
     * ⚠ 纪律：缺省时 provider 自持**永不中止**的信号（执行须跨调用方回合跑完）；
     * 调用方**不得**把自己的回合信号透传进来（那会在回合结束时误杀执行）。
     */
    signal?: AbortSignalLike;
}
/**
 * 一次成员执行的结果。
 *
 * **不含 `stopReason`**：活性分类由内核从证据（`writes` / `evidence` / usage）推导，
 * 不由执行体声明。执行体只回报可被核对的证据，避免「谎报停止原因」的攻防成本。
 */
export interface ExecResult {
    /** 是否超时。超时只针对**已结算的执行**，思考阶段不计时。 */
    timedOut: boolean;
    exitCode: number | null;
    signal: string | null;
    /** 可诊断拒因：家族 + 码 + 最早可重试时刻（用于把失败路由到修复动作）。 */
    errorCode?: string | null;
    errorFamily?: string | null;
    retryNotBefore?: string | null;
    /** 用量摘要。 */
    usage?: UsageSummary;
    /** 用量口径**必须显式声明**，不得靠 session id 推断（禁 `never infer cumulative from a reused session`）。 */
    usageBasis?: 'per_run' | 'session_cumulative';
    /** 会话回写：`sessionParams` 更新与 `clearSession` 清空。 */
    sessionParams?: Record<string, unknown> | null;
    clearSession?: boolean;
    /**
     * 证据：本次写入清单（内核据此判定是否「有进展」）。
     *
     * ⚠ **必填**（本轮从可选改必填）：活性判据依赖「写入与证据**都非空**」才判有进展；
     * 字段可选会让「未回报」静默等于「无进展」，判据随之失效。**空即空数组，不是省略**。
     */
    writes: string[];
    /** 证据引用（必填，理由同上），供内核交叉核对声明与事实是否相配。 */
    evidence: ExecEvidence[];
}
/** 单条证据引用。 */
export interface ExecEvidence {
    kind: string;
    ref: string;
    outcome?: string;
}
/** 用量摘要（最小集；口径由 `ExecResult.usageBasis` 声明）。 */
export interface UsageSummary {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
}
