## 0.5.6（2026-10-25）

### 判据面根治「每批塞一条」与「注释计入」两族缺陷；指引落两条纪律；CI 从连续 4 次红修至双矩阵绿

四个批次 + 一组 CI 修复。**不改引擎判定面**（门禁族、状态机、黑板真源均未动），改的是**判据写法**、**指引纪律**与**测试的环境假设**。

- **写域判据根治（`GAP-A1-09`，批 `speclang-gatehardening-20261025`）**：`test/accept-pack2-vocabulary.test.js` 原 `PACK_DOMAINS` 是**批次清单**（7 条按批次名枚举），已连续 4 次把新出现的合法路径误判「无法归属 = 越界」（`scripts/speclang-validate.mjs` → `test-baseline.test.js` → `accept-pack2` → `accept-pack3`），每次补救都是「再塞一条」。改为**目录约定分类器**：`FACE_RULES` 六面（能力层 / 测试面 / 引擎脚本面 / 引擎面 / 基线面 / 指引面）＋ `RELEASE_RE` 发行面 ＋ `classifyFace`；按 prefix 长度**显式降序**排序（不靠书写顺序）；`--porcelain` 改 `-uall`（untracked 亦纳入）；越界文案点名路径 ＋ 已知面清单。**分类器 ≠ 禁区**：`baselines/` 在分类器里是已知面（放行），基线越权仍由原 `forbidden` 断言拦（反向构造已证该行承重）。
  台账副作用**如实登记**：旧表 × 新分类器实测「旧红→新放行 6 类、收紧 0 类」——属**换机制的预期结果**（那 6 类在老表下变红的唯一原因是「还没人改过所以没被塞进清单」，属待发假红），已逐条写入代码注释含各自兜底。
- **断言遮蔽拆牙（`GAP-A1-02`）**：`doc-manager` 不挂规格面这条断言原**寄生**在集合相等断言之后（红了也不算它红）⇒ 拆出独立 `AC-pack3-15b`；注入 `doc-manager` 指针后 15 与 15b **双红且理由不同**（真独立坐标）。
- **基线新鲜度门（`GAP-A1-06`）**：`test/test-baseline.test.js` 内新增两条纯函数（`freshnessDrift` / `baselineTotalsDrift`）＋三用例；负例走**内存副本**（不写 `baselines/**`）。经 7 组变异实证真红，含**变异 scan 侧**（证「非文件自比」）。
- **指引两条纪律（`SKILL.md`）**：① **基线纪律**——改 `test/**` ⇒ 基线重冻**必须同一提交完成**（`baselines/**` 单写者 = Leader），反例取实测 `2584663`（只落基线、树仍 18/20 ⇒ 单独检出必红、`bisect` 被误导）；② **产物根推导**——用 `ls -d ~/.dsh/*preset*/…` 通配推导、禁手抄拼写（历史事故：`puny-preset` 少一个 `k`）。
- **判据自检表（新增机制）**：`SKILL.md` 增「出包前判据自检」——**五类**（阈值 / 禁令 / 时点 / 计数 / **注释面**）× **十对** ＋ 5 个历史反例 ＋ **四条铁律**（末条：裸子串计数必须限定代码面）。
  **注释面按文件类型分档**（r1 判 reject、经独立复现后重写）：JS/TS 用 `codeOnly`（注释与字符串一并掩）；**YAML/shell 不数子串**——`presets/punky-preset/agent.cordis.yml:32` 是块标量 `prefix: >-`，注入面 27 条目正文在内、`#§` 指针 25 处是**内容不是注释** ⇒ 该档**没有安全的中点**（裸 25 / `codeOnly` 25 零效果 / 按 `#` 剥 **0** 反向错），故 `codeOnly` 与「按 `#` 剥注释」在该档**点名禁用**，改结构化取件或整行精确匹配（fail-closed）。
- **CI 修复（连续 4 次红 → 双矩阵绿）**：① `docs/` 整目录被删时连带删掉了 `.gitignore` 明文要求保留的两件集成声明文档（`docs/integrations/comfyui-glue{,.en}.md`，`.gitignore` 注释本身写着「移出会让 CI 直接红」）⇒ 恢复这两件，其余 docs 仍不入库；② 5 条用例去除开发机依赖（仓外 SpecLang 副本、会话态批次产物报告、`D:` 盘符形态、已删 docs）——缺位时**留痕跳过**（不计通过、不判红）而非判红，两侧均不降级；③ CI `checkout` 改 `fetch-depth: 0`（多处「RED 基线」判据用 `git show <固定 sha>:` 取证）；④ 两处测试临时根由硬编码 `D:\dsh\_tmp` 改跨平台 `os.tmpdir()`（该字符串在 posix 上是**相对路径** ⇒ 临时目录造进仓库 ⇒ 写域判据判越界）。
- **读数**：本地全量 `npm test` **2182 tests / 2175 pass / 0 fail / 3 skip**；CI（node 22.23.2 与 24.18.0 双矩阵）**均 success**；`baseline --check` `0`、`check-guidance-sync`（含 live）`0`、`check-vocab-counts` `0`；`porcelain 0`。
- **已知 followup（不阻塞）**：`cordis.patch.yml` 至今在任何同步判据之外（不在 `SYNC_FILES`，连 repo↔live 一致性都不校）；`test/helpers/*.mjs` 与 `scripts/**` 无机械兜底（已如实登记为接受风险，未粉饰）；`docs/**` 因 `.gitignore` 不入库 ⇒ 依赖 docs 内容的两条断言在干净检出上只能留痕。

## 0.5.5（2026-10-25）

### software-team 接上「角色 → 适配层 → vendor 原件」引用链；适配层优先序落成硬声明；两条机检补反向牙

批 `speclang-wiring-20261024`（6 wave / 6 lane）。**能力层接线**，不改引擎判定面。

- **role 层入口（e1-roles）**：`coder` / `coordinator` / `designer` / `reviewer` / `supervisor` / `tester` **各新增 1 行**「规格面原文（选读 · recommend 语义）」指针，指向仓内 vendor 具体子目录（`speclang-waterfall/` `speclang-hoare-check/` `prd-guide/` `ui-component-registry/`，按角色分工）。**`doc-manager` 按 K-3 不挂**。零删除、无重排；同行必须含 recommend 语义词，**禁止**写成必读或装配；指针不带行号（避 `AC-pack3-6③` 锚点面）。frontmatter `skills:` 零改动。
  修的是此前**引用链断点**：适配层写着「原件为准」，但 7 个 role 里指向 vendor 的曾为 **0** —— 成员按角色必读表只读到 109 行适配层，**碰不到 27 件原件**。
- **适配层优先序（e2-adapter-check）**：`spec-contract.md` 的 `S-6` 六态表**之前**新增硬声明——本表为**映射摘要**，六态定义以 `references/vendor/speclang/speclang-hoare-check/` 原件为准，**不一致一律以原件为准**，不构成第二套口径；`SKILL.md` 新增「**必读 = 适配层映射；选读 = vendor 原件**」分层句。`S-6/S-7/S-8/S-10` 四节 id 全留、只降正文。
- **机检（`test/accept-pack3-spec-contract.test.js`，未新建文件）**：
  - `AC-pack3-14`：适配层含「映射摘要」「原件为准」，且**位置断言** `声明行 < 六态表行`；
  - `AC-pack3-15`：含 vendor 指针的 role **集合精确相等、恰为 6 个**，**`doc-manager` 必须为 0**，同行含 recommend 语义词、无装配式措辞，且**每条指针路径 `existsSync` 为真（死指针即红）**。
  该判据经两轮反向构造补牙：原实现只要求 `≥5`（删 1 个仍绿）且只校字符串不校路径（改 `speclang-waterfallX/` 仍绿）——两处**假绿通道**均已封堵。
- **基线重冻（`533e330`）**：`test/accept-pack3-spec-contract.test.js` 实测 **`tests 18 / asserts 59 / lines 522`**（另补记 `accept-pack2-vocabulary.test.js` 的既有 `lines +4` 滞后）；`--check` `EXIT=0`、`test-baseline` `20/20`。
- **读数**：三件验收套件 **44 / 44 pass / 0 fail / 0 skip**；`check-guidance-sync`（含 live）与 `check-vocab-counts` 均 `EXIT=0`；`live diff=0`；**8 组反向构造全部按期望**（对照绿、删指针 / 注入 `doc-manager` / 死指针 / 缺声明 / 声明错位 / `S-7` 降级皆红）。
- **已知 followup 三项（会静默复发，非本批缺陷）**：① 成员侧 preset 根 `~/.dsh/puny-preset`（少一个 `k`）与引擎根 `~/.dsh/punky-preset` 并存，致产物跨根（本批已归位并归档残留，**根因未除**）；② `doc-manager` 专用断言仍被集合相等断言**遮蔽**（红了但那条 assert 不执行）；③ 基线**新鲜度无门**（本次重冻自承补记上一批滞后）。

## 0.5.4（2026-10-24）

### software-team vendor 引入 SpecLang（SpecArtisans）四技能原文与 ruby 校验器；新增 node 薄壳；适配层降级

批 `speclang-vendor-20261024`（5 wave / 7 lane）。本次是**能力层引入**，**不改引擎判定面**（门禁族、状态机、黑板真源均未动）。

- **vendor 落点（e1-vendor）**：新增 `skills/software-team/references/vendor/speclang/`，共 **29 件** = **27 件上游资产** ＋ `LICENSE` 副本 ＋ `NOTICE.md`，合计 **532,898 B**（资产 512,871 ＋ LICENSE 12,396 ＋ NOTICE 7,631）。上游 `D:/Project/SpecLang` @ **`b3ee6ee`**（**不锚 `HEAD`**）；27 件逐件 `sha256` 与上游**全等**（差异清单空），`NOTICE.md` 的 **28 行 sha 表逐行机检相符**。**刻意排除** `speclang-waterfall/assets/dist/speclang-convert-standalone.py`（153,701 B 构建产物，本仓不使用其转换功能、可由源重建）——`NOTICE.md` §三 单列登记，不计入变更清单。
- **node 薄壳（e2-shell）**：新增 `scripts/speclang-validate.mjs`（166 行）。四态：`ruby` 可用 ⇒ **原样透传退出码与 argv**；**`ruby` 不可用 ⇒ `exit 2` ＋ 明写 UNKNOWN（绝不伪造 `exit 0`）**；rb 原件缺失 ⇒ `exit 2` ＋ 给缺失绝对路径（与上态 stderr 可区分）；`-h/--help` ⇒ `exit 0`。路径由 `import.meta.url` 推导（无硬编盘符）。**本机无 `ruby` 属既成事实**，该能力在本机为 `UNKNOWN`（不计通过）。
- **去重与挂载（e3-mount）**：`SKILL.md` 三处订正 —— 真源改指**本仓 vendor**（`references/vendor/speclang/`，29 件）／「资产**已 vendor 进仓**、直接读仓内原件」取代原「本仓不引入其资产」／「**禁全文拷贝**」按用户裁决解除，改为「**允许 vendor ＋ 四条替代约束**（`LICENSE` 原件随目录 ／ `NOTICE.md` 含逐件 sha 变更清单 ／ 署面保留 ／ 权利人待确认）」；并新增「何时读哪一面」路由（prd-guide / waterfall / hoare-check / ui-registry）。`references/engineering/spec-contract.md` **降为蟛蜞适配层**（六态 → `gate_status`/`verdict` 映射、`SUMMARY:` 落地、S-10 缺口留档），`S-6`/`S-7`/`S-8`/`S-10` 四个 id **全留只降正文**（`AC-pack3-13` 要求引用可解析）⇒ **vendor 原件为单一真源**，无第二套六态定义。6 个 role 文件**零改动**。
- **许可与署面**：上游许可 **Apache-2.0 ＋ Runtime Library Exception**，署名 **The Cangjie Project**，**权利人待确认**（不得改写为已确认）。
- **读数**：`check-guidance-sync` **`EXIT=0`**（含 live：`file total=84 same=84 diff=0`、`software-team files=49` status=same）；`check-vocab-counts` **`EXIT=0`**；三件验收套件 **42 / 42 pass / 0 fail / 0 skip**；`AC-pack3-3` 仍 **7**（vendor 内 `spec-contract` 字面量 0 ⇒ 不增计数）。
- **判据面两处已知缺陷**（**不改本批实现**，订正归新批）：`AC-E1` 的 `pass ≥ 41` 在被点名文件上**结构性不可达**（该件仅 16 个 `test()`，41/42 为三件套件合计）；`AC-E5` 的 `grep -c 'test/'` 是**坏代理**（把"修改既有测试文件"也算进"新增"）。

## 0.5.3（2026-10-24）

### 治理纪律补三节 ＋ 判据②b 上岗（**行为变更**）、词表由空表转真拦截、software-team 能力层落 SpecLang 细则

批 `punky-iter-a-20261024`（6 wave / 9 lane）。本次有一条**行为变更**须先看：判据②b 让「注入面有规范句、正文无定义面」的单向悬空**从不可见变为必判红**，同时**废除自足条目放宽机制**（详见下第 2 条）。

- **纪律正文补三节（pack1）**：`references/discipline.md` 新增 **`## §0i 执行形态`(:132)** / **`## §0s 编号规范`(:248)** / **`## §0t 完成发现与结算`(:560)** —— 按「操作归 preset、注意事项归 discipline」口径只写注意事项面（不复制注入面操作原文）；`§0k`(:226 起) 追加 **`SUMMARY:` 机读结论行** ＋ **4 档证据强度**（`PROVED` / `SEMI_PROVED` / `VIOLATED` / `UNKNOWN`；`UNKNOWN` 不计通过、`SEMI_PROVED` 须补证计划）＋「**禁把证据强度写进 verdict 值**」（verdict 白名单仍只收 `pass`/`skip`）；`R-11` 十处悬空引用改指存档件。
- **★ 行为变更 — 判据②b 上岗 ＋ 废除自足条目机制（pack1）**：`scripts/check-guidance-sync.mjs` 新增**判据②b（按 id 正向）** —— 注入面**每一条目**都必须在正文有对应小节 `## §X`，**零白名单、零豁免集合**；同时**删除 `:300-301` 的自足条目放宽面**（原口径「注入面里有自足条目，强制会造出假失败」已废止）。**影响**：此后「注入面有规范句、正文无定义面」不再有静默通道，**新增自足条目会直接判红**（宁可判红，也不留可豁免口子）。配套新增 `test/guidance-id-coverage.test.js`（N1 必失败 / N2 同输入对照 / N3 真仓态）；文件头注「四条判据」→「五条」，`R-06` 注释实测值 26 → 27 订正。
- **受控词表由空表转真拦截（pack2）**：`lib/types/contracts.ts` 的 `GateErrorCode` union 补登记 **14 个真实发射码**（`Q-I` 的 12 个 ＋ 2 个 throw-only：`GATE_ASSEMBLY_INVALID`、`GATE_PLAN_PRESENCE_MISSING`）；`lib/state/vocabulary.json` 的 `entries: []` → **51 条真值**，`meta.counts` 订正为 `{gateCodes: 51, reasonTokens: 0}`（**counts 是声明值、不作判据**）；`lib/state/vocabulary.js` 仅动注释与一条报错文案（**空表 ⇒ 全拒**、fail-closed 口径不变）⇒ **实质变化 = 把 `entries:[]` 填成真值，让既有判定机制生效**，不是新写一套判定。新增 `scripts/check-vocab-counts.mjs`（两项检查职责，`exit 0/1/2`）；`test/vocabulary.test.js` 的 A3 由「`entries` 必须为空」改为「**必须非空 + 唯一 + `kind=gate`**」。`lib/types/contracts.d.ts` 为 `npm run build` 产物（非手改项）。
- **software-team 能力层落 SpecLang 细则（pack3）**：新增 **`skills/software-team/references/engineering/spec-contract.md`**（初版 161 行 / 13,658 B，`S-1..S-10`；**已按同日瘦身裁决收敛为 4 节 / 82 行，见下方「★ 订正」条**）—— 四面提炼：**机械规则清单 `MC-1..MC-8`**（含源文档未列、校验器实发的 **`MC-0`** 解析级失败差集）、**六态证据语法**（4 档 ＋ `CHAIN_BREAK` / `MAPPING_BLOCKED` 两旁路）、**报告机读行**（`SUMMARY:` 独立行 ＋ 单一门控词 ＋ 退出码口径）、**需求编号纪律**（`REQ-` / `SCN-` / `RULE-` / `IDX-` / `AC-` 族）＋ **登记一处缺口**：「需求点 → 契约」这一跳当前无人机械核。`skills/software-team/SKILL.md` **+22 / −7（净 +15）**（真源分层表新增 1 行「外部能力层（SpecLang 提炼）」＋ **角色必读表 7 行整行改写** ＋ 新增「**推荐技能（recommend 语义，非装配）**」段 `:169-178`）；6 个 role 文件（`coder` / `coordinator` / `designer` / `reviewer` / `supervisor` / `tester`）各 **+2 / −1（净 +1）**（新增 1 行 `S-x` 点名 ＋ 落点行改写；`doc-manager` 按 K-3 **不挂**：复盘角色不产出规格面）。
  - **SpecLang 定位（务必按此读）**：**recommend 语义、非装配、不进入引擎装配面** —— 按需加载、**不在册不构成失败**、不影响任何门禁（`GATE_SKILL_MISSING` 已于 `b8380a8` 移除）；版本钉 **`SpecLang@b3ee6ee`**（不锚 `HEAD`）；源仓许可署 **The Cangjie Project**（Apache-2.0 ＋ 运行时库例外），**权利人待确认**；**禁全文拷贝**，本仓只作规则提炼与锚点引用（字面重合度去引用面后 ≤20 字符公共子串零命中、12-gram 1.005%）。
- **★ 订正 — `spec-contract.md` 瘦身（10 节 → 4 节 ＋ 附 A，2026-10-24 用户裁决）**：逐节对位后确认原 10 节中 **8.5 节与蟛蜞既有机制重复**（MC 清单 ↔ 17 个 `scripts/*.mjs` ＋ 14 个 `lib/state/gates/*` 门模块；结构先于语义 ↔ 引擎门序；编号/引用可解析 ↔ `check-guidance-sync` ②/②b/③ ＋ `id-anchor-count.mjs`；trace 与 DAG ↔ `wavePlan.tasks[]` ＋ `lanes[].deps` ＋ `handoffs`；UI 树 ↔ 蟛蜞无 UI 面；需求编号族 ↔ `discipline.md §0s`），**净增量只有 `S-6` 六态证据语法 与 `S-8` 聚合机读行（半节）**。收敛为 **`S-6` / `S-7` / `S-8` / `S-10` 四节（82 行 / 7,813 B）＋ `附 A 不复述清单`**：重复面改为**指向业主真源的单向指针**，不再复述（避免两套口径）。`S-7`（记分口径）保留，因「`UNKNOWN` 不计通过 / `SEMI_PROVED` 须补证计划」是让 `S-6` 可计分的必要口径，本身属净增量。**role 文件零改动**（引用仍指向 `S-6`/`S-7`/`S-8` 现役编号）。live 副本已手工同步（`repo` 与 `live` 同 sha `4e953917…`）。读数：`check-guidance-sync` **`EXIT=0`**（`skill same=5 diff=0`、`file total=55 same=55`、`software-team files=20`）、`check-vocab-counts` **`EXIT=0`**、三件验收套件 **41/41 pass / 0 fail / 0 skip**。
- **版本与文档（pack4）**：`package.json` patch bump `0.5.2` → `0.5.3`；`README.md` / `README.en.md` **双语同侧落地**本次能力面（能力层 `spec-contract.md` ＋ SpecLang 推荐技能定位），两侧 `##` 章节数保持 **9/9**（未单侧增删）；`README.md:4` 的「**版本基线 `0.5.0`**」为**结构性基线标记**（团队资产/`chain` 退役那一版），**不是当前版本号**，本次**未改**。
- **读数**：本批 `git status --porcelain` = **24 条目**（无重命名 ⇒ 文件数同为 **24**：**18 已跟踪修改 ＋ 6 未跟踪新建**；`git diff --name-only bfb9b0c` = **18**，**仅已跟踪修改**、不含未跟踪新文件 —— 两个口径不得混写）。**行数口径**：一律取 `git diff --numstat`（插入 / 删除两列），**不取 `--stat` 的合计列**（合计 = 插入 ＋ 删除，易被误读成插入数）。`check-guidance-sync` **GREEN**（`EXIT=0`；`注入面条目=27`、`正文 §小节=29→32`、repo↔live 五件同 sha、`[skills] file total=55 same=55 diff=0`、`software-team files=19→20`）。

## 0.5.2（2026-10-21）

### 结构优化：`apply` 873 → 51 行 + 八项单点化收敛（41 笔提交 / 83 文件 / `+3925 −487`）

本次以**结构**为主、行为零变更：把长期堆在单一入口里的逻辑拆成可独立验证的单元，并把重复实现收敛到单点。**所有改动均以「行为等价」为验收前提**（块 sha 等价 / 逐文件回归 / 架构棘轮不破）。

- **入口瘦身 —— `apply` 873 → 51 行（−94%）**：
  - `W7a`–`W7d` 四波把内联块函数化（4 + 4 + 7 + 5 块），`apply` 依次 873 → 739 → 633 → 493 → 339；**零逻辑变更**，逐波以块 sha 等价证明。
  - `W7e` 把 `governance` 装载与两个 remount 下沉为顶层工厂，`apply` 339 → 261。
  - `W7f` 把运行期真源收拢为 `createRuntimeState`（**20 字段**）并把六个区间外移为 8 个工厂，`apply` 261 → 51。**顶层工厂数 0 → 30**（v0.5.1 时全部内联在 `apply` 内）。
- **八项单点化收敛**（`W1a`/`W1b`/`W2`/`W3a`/`W3b`/`W4`/`W5`）：
  - `sendJson` / `packageRoot` / `stripStreamMerges` 三处重复实现合一（`W1a`）；`BLIND_REVIEW_ROLES` / `boxRoot` 单点化（`W1b`）。
  - **产物路径函数四处收敛**到 `lib/state/batch-paths.js`（`W2`）；`DEFAULT_ASSEMBLY` 迁出到 `assembly/defaults.js`（保形再导出，`W5`）。
  - 删除 5 个零引用符号与 `core` 再导出（`W3a`）、三个 `gates/*.ts` 的未使用 `node:path` 导入（`W3b`）；拆掉 `state -> watch` 回指边，三谓词下沉 `state/lane-state.js`（`W4`）。
  - **命令分段器真单点化**：5 处完全相同正则（`command-exec` / `readonly`×2 / `tool-ban.ts`×2）收敛为 `lib/shell-text.js#segmentCommands`，**生产代码正则字面量物理只剩 1 处**；`detect.ts` 的分词正则未动（分词 ≠ 分段）。
- **架构真源与越界门**：新增 `.punky/arch.yml` 作为架构真源、`scripts/arch-check.mjs` 为**棘轮门**（禁止新增跨域依赖）、`arch-context` 在派发期注入架构上下文。本次为分段器单点化**授权 +1 对** `governance -> (lib-root)`（`allowedPairs` 62 → 63），理由写入提交正文。
- **安全面收口到 fail-closed 单点（4 处）**：产物声明路径解析（`cc62ffd`）、产物读面 5 点（`8f7bbd2`）、人工闸 `human:` 证据判定（`e6427e2`）、`P6` watch stat 与 `P7` handoff 在场/可读（`57a28d8`）。所有收口均配**根内正例对照**，防「一刀切把功能打死」。
- **测试债补齐 —— 166 → 171 个测试文件**：此前安全修复**零仓内测试**，本次补 `gate-artifact-containment` / `gates-needhuman-evidence` / `w7e-remount-surface` / `w7f-rt-write-surface` / `shell-text` 五件；**每条「返回空 / 被拒 / 不抛」断言均配同输入阳性对照**，防不可证伪的绿灯。
- **写序列可观测化**：`createRuntimeState(onWrite)` 在注入 `ctx.rtWriteLog` 时返回 Proxy 记录字段写入序列，未注入时返回纯对象（**生产路径零开销**）。使「`rt` 单写 vs 双写」这类**终态同构、仅写序列不同**的缺陷首次可被判据抓住。
- **指引层去重与同源**：`persona` 按「**工具能力归工具定义、调度指引与操作规范归 preset**」原则去重，注入面 **6442 → 5858 字符**；`cordis.patch.yml` 与 `presets/punky-preset/agent.cordis.yml` 两份 persona 定义**对齐为 27 条、逐条文本差异 0**（此前 patch 缺 `0i`、§0 为旧短版）；补**模板变量白名单**约束（本内核只注册 `provider`/`model`，其他双花括号变量在会话启动时即抛错）。
- **技术债跨批总账**：新增 `reports/tech-debt-ledger-20261021.md`，登记跨批未闭合项（含**取证后的「不做」结论**与不可消除的原因），使「已修 / 有意保留 / 已知不阻断」三类可追溯。
- **读数**：`83 files changed, 3925 insertions(+), 487 deletions(-)`；`apply 873 → 51`、顶层工厂 `0 → 30`、测试文件 `166 → 171`；`guard` A=B=171（1896 tests / 1889 pass / **0 fail** / 4 todo）GREEN；`arch-check` `181 / 667 / 214 / 63` `[ok]`；`check-guidance-sync` GREEN（repo ↔ live 五件同 sha）。

## 0.5.1（2026-10-14）

### 发布面落版与判据尺子固化（批 `punky-release-0.5.1-20261014`）

- **`R-1`（唯一发布阻塞）已解 —— 版本史与版本面结构性对齐**：`package.json:3` 早已是 `0.5.0`，而版本史顶部仍是「未发布（Unreleased）」、首版本标题停在 `## 0.4.4`。本次**真落**：原「未发布」段体**落版为 `## 0.5.0（2026-10-12）`**（**段体一字未改**，sha16 `d6eeb75b36ba38e7`），并在其上新建本段；版本行 → `0.5.1`。
- **注释订正（`F-1`）**：`lib/sig-fingerprint.js:35` 原注「不进 `GateErrorCode` union（**拒码面恒 29 保持不变**）」**已为假**（实测 union = **37**）⇒ 改为**指向 `lib/types/contracts.ts` 的 union 为唯一真源、不写数字**（规模随授权批演进，写死即漂移源）。改动面 = **恰 1 减 1 加、两行均注释行**，`node --check` 双态 exit 0。
- **判据尺子固化（`D-04`）**：新增 `scripts/audit/tool-face-count.mjs`（**按块解析 + 四口径阶梯 + 三态退出码**）。原命令只覆盖双引号 ⇒ **26 ≠ 32**；实測病根是**两条叠加**：**引号**（+4，全在 `lib/tools/lane-tools.js` 的单引号 `name`）与**扫描面**（+2，`lib/watch/lane-heartbeat.js` 的 2 件 `defineTool` —— **不在 `lib/tools/*.js` 内**）⇒「只补引号」天花板为 **30**。
- **锚点类文档入库（`PA-1`）**：`docs/` **54 件**逐件 `git add -f`（禁通配）。根因 = `.gitignore:50` 忽略整个 `docs/**`，且 `:49` 记录 2026-10-10 已 `rm --cached` 49 件 ⇒ 属「**在库 → 只在工作树**」的退化。入库后三读数 **37/37** 符合预期（`check-ignore` 仍报 `:50` = **未改规则**）。
- **新增技能**：`skills/video-team/`（三层 7 角色 team skill + 宪法 6 章 24 条 + 模板 6 件 + `check-video-team-density.mjs` S1–S7 机检）。
- **读数**：`58 files changed, 13054 insertions(+), 3 deletions(-)`（发布面）+ `17 files changed, 1869 insertions(+)`（video-team）。

## 0.5.0（2026-10-12）

### 抄规格体系 P0/P1/P2 三波次 + 三个已验收外部批（`a4a2779`，91 件 / +9407 −236）

- **范围**：一次收口提交，含三批主交付（P0 抄规格 L1 事件重放校验腿 + L2 上下文注入预算；P1 抄规格 L3 测试证据自证 / L5 隔离可判定 / L6 宿主兼容第三维；P2 抄规格 L7 写路径原子性 / L4 规则变更传播 / L8 判据脚本信任模型 / L9 记忆溯源 / C-5 坏配置 fail-closed）与**三个已验收外部批**（各自 `verdict = approve`、`blocking = 0`）。
- **要点**：新增 1 枚拒码（`GATE_SCRIPT_CHANGED`，语义独立于只读黑名单命中，以保审计可辨）；`lib/comms/inject-budget.js` 新建（四层结构 + 显式省略标记）；`lib/state/rule-propagation.ts` 新建（规则变更传播，随 `scripts/copy-ts-built.mjs` 回拷清单同步）。
- **读数**：`91 files changed, 9407 insertions(+), 236 deletions(-)`。

### 指引同步改造 —— 10 项 + 2 附带（`431b873`，2 件 / +77 −7）

- **范围**：把 L1~L9 的规格口径落进指引（正文 `references/discipline.md`）＋**移除注入面 `0i` 行**（挂起内容不得在注入面出现）。
- **要点**：判据类落 `### 15.16`–`### 15.20`、操作类入各自同族 §；**不新增 `## §X`**（故不影响注入面↔正文双向检查）；收口以 `node scripts/check-guidance-sync.mjs` **GREEN（exit 0）** 为准。
- **读数**：`2 files changed, 77 insertions(+), 7 deletions(-)`。

### 未发布补录：D 档偏离语义修复 + 引擎自派 worker 批归属索引填充面修复（2026-10-12，批 `session-bind-index-fix-20261012`；同段补录前批 `d-override-fix-20261011`）

- **形态**：本批 `session-bind-index-fix-20261012` = 5 lane（`p1-spec` →（`e1-fix` → `e2-assert`）∥ `e3-changelog` → `a1-audit`）；前批 `d-override-fix-20261011` = 9 lane（`p1-spec` → `e1-engine` ∥ `e2-guidance` ∥ `e3-tests` ∥ `e4-session-bind` ∥ `e5-c1-schema-fix` ∥ `e6-index-wiring` ∥ `e7-assert-align` → `a1-audit`），`audit verdict = approve`（AC-1..AC-20 **100% 有结论** / **blocking 0** / followup 12）· **带 gap 收口**（非 clean-pass）；前批全量读数（a1 独立复跑，非采信 lane 自述）：`npm test` tests **1765 / pass 1761 / fail 0** exit 0 · `npm run check` exit 0 · `node scripts/check-guidance-sync.mjs` exit 0 · `ac19-host-smoke.mjs` **15/15**。
- **前批 ① · 双轴判据（D 档偏离语义修复的根）**：原语义「声明 D ⇒ 恒 `override:true`」把合规 D 误判为偏离。改为**两轴独立推导、互不耦合**——**难度轴** `derived` = 五布尔 + 两个新布尔的机械推导（任一 C 判据 ∥ `fixedRole` ∥ `durableSeats` → `C`；否则 `needIsolation` → `B`；否则 `A`；**`D` 不入难度轴**，因通道不属难度）；**通道轴** `derivedChannel` = `durableSeats === true ? 'team' : 'dispatch'`。落点 `lib/tools/assign-tools.js:107-109`；两实参入 schema 且**均非必填**（缺省零破坏：不传时退化为原 `derived` 且恒走 tier 支）。
- **前批 ② · D 的正当形态 ⇒ `override:false`**：`difficulty:'D'` **且** 通道轴为 `team`（即 `durableSeats:true`）⇒ **回归常规路径**（`override:false` / `overrideKind:null`），rationale **不需要**引用 A/B/C 特征词 —— 这正是「D 被机械事实覆盖 ⇒ 不记偏离」的修复点。落点 `lib/tools/assign-tools.js:121-122`；真宿主读数（`ac19-host-smoke.mjs` ⇒ `total=15 pass=15 fail=0`）：`{"derived":"C","derivedChannel":"team","override":false,"overrideKind":null}`，工具行**无** `[override(...)]` 标记，`governance.json#lastAssign` 逐键一致。
- **前批 ③ · D 通道变体 ⇒ 通道三要素**：`difficulty:'D'` 但通道轴为 `dispatch`（`durableSeats` 未声明 ⇒ 通道面未落实）⇒ **唯一保留的偏离**：`override:true` / `overrideKind:'channel'`，rationale 须含**通道三要素**（**① 引用通道/特征面 ② 为何 durable 而非 subagent ③ 通道方向与上限：不泛化为全批、team 面缺失须显式降级**），缺任一即拒 `GATE_DIFFICULTY_MISMATCH`（文案说「**通道偏离**」并逐项列缺，附两条正范式）；**不**复用原三要素（其 ① 强制 A/B/C 特征词，正是要绕开的误拒源）。非 D 偏离**逐字保留**原路径（`overrideKind:'tier'` + 原三要素）。落点 `lib/tools/assign-tools.js:124-138`。
- **前批 ④ · 建批面 D×通道硬拒 + guard 硬消费**：`lib/tools/wave-plan-tools.js:96` 在 `createBatch` **之前** throw `GATE_DIFFICULTY_CHANNEL_UNRESOLVED`（本会话声明 D 档而本批 `channel:'dispatch'` ⇒ **D 与通道面不一致，拒建批**，**零批次 JSON 落盘**、`pendingBatch` 保留可重试）；执行型工具面由 `lib/tools/tier-gate.js:221-234` **同源硬消费**同一码（只读壳调用判定**先于**该门 ⇒ 侦察面零阻断）。真宿主读数（前批 `G-01` 运行时半）：拒态逐字命中 + 零落盘。
- **前批 ⑤ · C↔D 同档豁免**：会话镜像的**跳过判据**由强度序 `tierRank` 改用**准入档单点** `accessTierRank` —— `C` 与 `D` **同档** ⇒ 「D 会话被镜像 C」**不再跳过**（照常镜像），仅**跨档降档**才跳过；修掉「活跃批期间 D→C 必被 `GATE_DIFFICULTY_DOWNGRADE_BLOCKED` 误拦」的实测缺陷。落点 `lib/tools/assign-tools.js:215-225`（禁两处各写一套判据）；真宿主读数：放行、无该码。
- **前批 ⑥ · C-1（`overrideKind` schema 可空）**：`assign_check` 的 `output.schema` 中 `overrideKind` 由 `{"type":"string"}` 改为 `oneOf:[{type:'string',enum:['channel','tier']},{type:'null'}]`（前批 lane `e5-c1-schema-fix`）——常规路径回 `null` 不再被**宿主同款**校验判违例（原 schema 使合规 D 的 `null` 读数被判违反输出契约 = 阻断缺陷 C-1）。落点 `lib/tools/assign-tools.js:60`；宿主同款校验**零违例**。
- **前批 ⑦ · session 绑定形态落地 + 指引同步**：批归属解析**单点** `lib/engine/dispatch.js#batchSessionIdOfWorker`（`worker 会话 → 批归属会话` 的**唯一**反查点，只 `get`、取不到即 `null` 不猜兜底）+ `lib/tools/shared.js#sessionOf` **四级回落**（`args.session` → 注入 resolver 命中 ⇒ 批归属会话 → `exec.agent.session.id` → `'cli'`；`shared.js` 守**零 import** 红线、resolver 只收**注入的函数**、抛错/非字符串视为不命中）；装配面 `lib/index.js:307` 把 `dispatchIndex` 声明**前移** + `:313` 闭包注入 `resolveBatchSession`（捕获**引用**而非快照值），并完成批内治理工具（`lane-tools` / `query-tools` / `task-tools` / `member-tools` / `mailbox-tools` / `handoff-tools` / `asset-tools` / `log-tools`）的三参化接线（前批 lane `e6-index-wiring`）。**指引同步**：`presets/punky-preset/references/discipline.md:25` 写入 D 档偏离口径（双轴 / 正当形态 / 通道三要素 / 建批面仍须落实 `channel:'team'`，否则拒 `GATE_DIFFICULTY_CHANNEL_UNRESOLVED`），`:393` 后续项同步；`node scripts/check-guidance-sync.mjs` **GREEN**（repo == live，前批 a1 独立复跑）。
- **本批 · 现象与根因**：引擎**自派**的 worker（子会话）**不传 `session`** 调治理工具时一律回落自身子会话 ⇒ `Error: batch not found: <batchId> @<workerSessionId>`；`lane_checkpoint`（写）与只读 `batch_status` **同形失败**，lane worktree **零提交**。根因 = **索引填充面缺口**（**不是**接线逻辑错误，前批已逐条排除「宿主未加载新码」「闭包 Map ≠ 登记 Map」两候选）：内存索引 `dispatchIndex` 的三条既有填充路径在自派场景**全部缺席** —— ① 启动重建（`lib/index.js:545-563`）**只跑一次**且早于批创建；② 热登记（`lib/bridge/dispatch-register.js:108`）只订阅宿主 `tools/post-execute` 且名单 `DEFAULT_DISPATCH_TOOLS = ['subagent','subagent_fork']`；③ **引擎自派写点**（`lib/engine/dispatch.js:884`）虽为「唯一写路径」写 `member.dispatch` 事件，却**不写 `dispatchIndex`** ⇒ 「**事件在盘上、索引里没有**」，resolver 恒未命中。旁证：同一份绑定数据在**磁盘扫描路命中**（`laneBindingOf`，`swarm_report` 回执自证）而**内存索引路未命中** ⇒ 失败点收敛在**填充面**，非绑定数据缺失。
- **本批 · 修复（三处）**：① **自派同步写（主路，确定性根源修复）**：自派成功写 `member.dispatch` 事件的**同一段同步代码内**同步 `dispatchIndex.set(...)`，消除「事件有、索引无」的分裂（`lib/engine/dispatch.js:884` 侧）；② **未命中回填（兜底）**：resolver **未命中内存索引**时回落**扫事件流反查**（复用同文件既有 `laneBindingOf` 的 `member.dispatch` 判据），命中后**回填同一索引**（经 `dispatchIndexEntryOf` **单点构造**，保持既有 3 键形状与非枚举 `ownerSessionId`）；③ **登记名单（防御性）**：`DEFAULT_DISPATCH_TOOLS` 补 `lane_dispatch` —— 引擎自派路径**直接调 `rt.start`**、**不经** `tools/post-execute` ⇒ 本条**不产生覆盖面**，仅为防御性登记，**不得**作为本缺陷的补救依据。**索引填充五路时序**（本批核心关系）：① 启动重建（存量回溯，仅 t0）→ ② 热登记（宿主工具面增量）→ ③ **自派同步写（本批新增主路）** → ④ 结算路惰性重建（既有先例，本批**不动**）→ ⑤ **未命中回填（本批新增兜底）**；③ **先于** ⑤（自派写点在派发返回前同步落 Map ⇒ worker 首个治理调用即命中，⑤ 不触发）；③⑤ **共用同一值构造单点**（冷/热读数逐字相同）；⑤ **复用** ①④ 的同一事件事实源、**不新建第二套索引**，且是 ① 的**运行期补位**（① 时窗仅启动，由 ⑤ 在运行期补齐，两者判据同源、幂等同形）。
- **兼容性（红线，逐条钉死）**：`lib/tools/shared.js#sessionOf` 四级回落**顺序逐字不变**、`'cli'` 兜底取值式不变；**未命中且无反查数据源**（无 `store` / 反查无命中 / 反查抛错）⇒ **逐字**保持既有回落，Leader 自身行为**零变化**；`batchSessionIdOfWorker` **纯函数契约不动**（只 `get`、只认 `Map`）；worker→批 反查仍**单点**（无第二套索引、**无负缓存**）；索引值形状**冻结**（`Object.keys(entry)` 恰 `['sessionId','batchId','lane']`）；回填**幂等**（同键覆盖 ⇒ 键数不增、不产生重复事件）；导出面 / 事件常量 / `GATE_*` 码**净增 0**。⚠ 前批教训（已写入前批记录）：**接线形态 ≠ 运行时连通** —— 不得以「接线在源码面在位」或「手塞 deps 的探针通过」代替数据面读数。
- **验证面**：单元判据（冷索引反查命中 + Map 事后含键可核 / 自派返回后**无需任何反查**即可查 / 索引形状与单点结构锁 / 回填幂等）交本批 `e2-assert` 承接并留读数；**宿主级 DoD 尚未执行**（见下「未闭合项」）。
- **⚠ 未闭合项（如实登记，不美化）**：**worker 侧自动会话解析的宿主级验证，在前批 `d-override-fix-20261011` 批末未通过** —— 前批 `e4-AC-8` 实拒 `Error: batch not found: smoke-session-bind-20261012 @b6d520d3-7d5a-443a-a652-7db7cc1a678f`，只读 `batch_status` 同形失败、lane worktree 零提交；**根因 = 上述索引填充面缺口**（前批按用户裁决**另开本批修**、以**带 gap** 形态收口，未冒认通过）。⇒ **本批修复后需重启宿主复验**：一次重启后真宿主演一遍 —— 引擎**自派** worker **刻意不传 `session`** 调 `lane_checkpoint` **成功提交**（事件流出现 `worktree.checkpoint`、`git log` 可见提交），并附**只读工具同形复现**（`batch_status` 不传 `session` 应可达）作为**数据面被真实填充**的证据；**补 `session` 参数重试的那次调用不属于判据**。前批另有一项未闭合（一并如实登记）：建批面**非 dispatch 通道**（team 系）的**放行**半**未取运行时读数**（前批为 dispatch 通道，同批无法验）。
- **不升版声明 + 生效面**：本段两条批**均不升版** —— `package.json` 的 `version` **逐字保持 `0.5.0`**（Q-F：补条目但**不升版**；本批**未**改写版本号、**未**打 tag、**未**发布）。引擎代码（`lib/**`）与数据面（`presets/punky-preset/references/discipline.md`）⇒ 随宿主重启一次生效。

### 清理波：构建面收口（TD-09 + TD-21/N-13 + G-2）与长尾清理并行（2026-09-18，批 `cleanup-wave-20260918`）

- **形态**：engine-team · 5 lane（`plan-designer` → **`exec-build` ∥ `exec-panel-docs` ∥ `exec-longtail`** → `audit-wave`）· `leader-direct`；用户裁决「能力面扩张挂起，构建面与长尾清理**不踩踏则并行**」；`audit verdict = approve`（pass 9 / skip 1 / fail 0 / **blocking 0** / followup 4）。
- **TD-09 结项（构建面）**：`npm run check` exit 0；**`npm run build`** exit 0（tsc → `.tsbuild` → `copy-ts-built.mjs` 回拷 **15 组 / 30 文件**）；**`npm test` exit 0**（tests 1616 / pass 1612 / fail 0 / todo 4）。**构建幂等实测**：build 后再跑 `pkg-hashes --check` 仍 GREEN（回拷产物与在盘字节一致）。
- **TD-21 / N-13 结项（读放大收敛）**：`lib/state/gates.ts` 抽 `gateStatusOfLane`（唯一计算实现、零读盘）+ `gateStatusOfBatch(sessionId,batchId)` / `gateStatusMapOfBatch(...)`（一次 `readBatch` → `{lane: gateView}`）；`gateStatus` **保留为兼容外壳**（签名 / 形状 / 抛错面逐字不变，`lib/tools/core.js` 零改动）；`lib/state/store.js:1247,1251-1252` 暴露；`lib/api.js:141` 由逐 lane 循环改**批级一次调用**。**读数（audit 独立自写探针）**：投影段**恒读 1**、整请求**恒 2**、**不随 lane 数增长**（N∈{1,3,6,12}）；逐 lane 与旧实现 `deepStrictEqual` 全等。**两阶段落地**：改前 dry-diff **0/30 全等** → 改后 **2/28**（仅 `state/gates.js`+`.d.ts`）→ 备份 30 文件在 `.wip-backup/build-pre-td21-20260918/`。
- **G-2 结项**：新增 `test/api-batch-keys.test.js`（**3 用例 / 26 断言**）：P-1 七键在场（含条件键 `manager`/`smoke` **不写空占位**的负向断言）/ P-2 批级与逐 lane 深比较全等 / P-3 读计数（双口径）。
- **G-6 勘误结项（零改动）**：「跨段顶层 `chip` 重名」**不成立**——唯一声明 = `lib/panel/theme.js:83`，`widgets.js:22` 是组件 `Chip`（大写）。**复跑陷阱已登记**：PowerShell `Select-String` 默认大小写不敏感会误判，须加 `-CaseSensitive`。
- **G-7 结项**：`lib/panel/main.js:341` `fontSize: 10` → **10.5**（对齐 Q-2 下限）；bundle 内 `fontSize: 10,` 命中归零。
- **TD-15 部分结项**：F-5（`lib/assembly/chain.js` 7 处悬空包内 `docs/` 引用 → `[docs-ref]` 锚记 + 展开表，**仅注释零语义**）+ 新件入册（`skills/engine-team/SKILL.md` 新增工程文档指针章节，repo ↔ live 镜像 sha 全等）；F2/F7/G3/N-9/N-11 属层域外，独立排期（N-9 建议直接结项）。
- **长尾交底（TD-16～19）**：`exec/exec-longtail.md`（258 行）逐条「取证 / 方案 / 可自动 / 需授权」；**零系统级写**。三条口径订正：① `GATE_MANAGER_NOT_RAISED` 硬门**已删**（判定代码 0 处）⇒ 解封 = `batch_phase({phase:'running'})`；② 看护任务 `dsh-web-watchdog` **已注册但 Disabled + Interactive only**（启用前须核 `-or 401`）；③ **（被 audit 推翻的 exec 结论）**「包内 docs 未纳版本控制」**错误**——`packages/dsh-punky-swarm/docs` 实为**在版 17 件**（`.gitignore` 的 `docs/` 锚定仓根，被 `!docs/` 反取回），真正排除面 = `**/docs/decisions/` + 工作区 docs 树。
- **F-3 双配置核对**：`~/.dsh/AGENTS.md` ↔ `~/.claude/CLAUDE.md` **零漂移**（sha256 同值 `365EB100…`，各 12,660 B / 106 行，锚点双在场，无 BOM + LF）⇒ 未写一个字节。
- **Leader 收口读数**：基线重算（+3 tests / +26 asserts / +184 lines）`--check` **0 漂移**；`pkg-hashes.txt` **359 件** GREEN；五队资产 `ok:true`；指引 **GREEN**；定向套件 panel 31/31、api 族 94/94。
- **部署面**：`lib/api.js` / `lib/state/gates.js` **待宿主重载**才在 3080 生效（读放大收敛 N+1 → 2 于下次重载后可用）；面板 UI 无变化。

### 面板重构：集群监控面板按引擎现状重新设计（2026-09-18，批 `panel-redesign-20260918`）

- **依据**：用户对设计稿 `docs/panel-redesign-spec-20260918.md` 的 5 条裁决——Q-1 面板**不引入操作**（只读）；Q-2 **接受密度偏离**（正文/辅助字 ≥10.5px、关键数字 ≥18px、对比度 ≥4.5:1，先看效果再评估）；Q-3 **治理配置页不动**（`gov-config.js` 一字不改，挂起为待办）；Q-4 事件流**默认人话摘要** + 保留「原始 type」开关；Q-5 **新增渲染测试**。
- **服务端读端（纯加法，零新真源）**：`lib/api.js` 351→375 行，`/batch` 补 **7 键 + 1 条件键**（`danglingLanes` / `handoffs` / `manager`* / `assembly`* / `teamAsset`* / `chain`* / `+smoke`*），三处投影只 `import` 既有单点纯函数（`danglingLanesOf` / `chainEchoOf`+`chainOfBatch` / `smokeOf`）——**禁第二份判定**；SSE 帧协议与既有键语义零改动。
- **客户端 7 段 → 8 段**：新增 `lib/panel/panel-model.js`（309 行**纯函数段**，`SEGMENT_ORDER` 置首、段内禁 `React.`/`tt(`/`T.`，可 `new Function` 独立求值 = 可测性前提）；六段改造——`locales` 179→413（**19 键**换词/新增）、`theme` 103→106（仅 chip alpha）、`widgets` 63→89（≥18px 关键数字 + `aria-label`/`aria-hidden`）、`batch-list` 84→144（关注度角标 + 筛选）、`batch-detail` 163→324（**三层泳道** + 契约行「吃→吐」 + 交接/装配条 + 人话事件流 + 原始开关）、`main` 280→412（**引力条** + **主行动卡** + 错误态条 + 深链 + 降级原因句）；`lib/client.js` 重拼（8 段 / 2444 行）；`scripts/assemble-panel.mjs` 与 `test/client-sync.test.js` 同步（段清单 +1）。
- **测试面**：新增 `test/panel-render.test.js`（**22 例 / 97 断言 / 430 行**：引力条 0 值收起、主行动卡优先级、三层分区不混层与 exec 并行计数、契约行逐字一致、徽章零噪音、19 键文案（zh/en 各恰 1 次）、对比度 16 组、降级原因句、段纯度、≥18px 字号）；`test/client-sync.test.js` 段清单同步（+1 行）。
- **验收（audit lane 独立复证，非引用自证）**：十项 **pass 8 / fail 1 / skip 3**，**exec 侧 blocking = 0**，gap-list 7 条全 `followup`。唯一 fail = **部署面**（3080 宿主进程启动早于本批落盘 ⇒ 内存中仍是改前 `api.js`/bundle；HTTP 探针 15 键、新键全缺），实现面以旁路独立复证为真（直 import 真源函数 + 直读批次 JSON + 自实现 WCAG 公式复算 16 组最低 4.60 + 内存复算拼装 139524 bytes 逐字节一致）。**⇒ 收口前置：一次宿主重启**。
- **Leader 收口读数**：全量套件 **tests 1613 / pass 1609 / fail 0 / todo 4**；`baselines/test-baseline.json` 重算（+22 tests / +97 asserts / +431 lines，`--check` 0 漂移）；`pkg-hashes.txt` 重算 **358 件**（+2：`panel-model.js`、`panel-render.test.js`）`--check` **GREEN**；`check-team-assets` 五队 `ok:true`；`check-guidance-sync` **GREEN**。
- **显式延后（登记，不静默砍）**：① **N-13** `lanesGate` 批次级一次扫描（需改 `lib/state/gates.ts` + `npx tsc -p tsconfig.build.json && node scripts/copy-ts-built.mjs` = 等价 `npm run build`，触 TD-09「构建面须用户放行」红线；现状实测 **4 次批次读/请求**）② `handoffGate` 键（需 `lib/index.js` 注入 liveConfig + `core.js` `readLiveConfig` 单点化）③ 引力条「卡住 N」引擎级 `stalled`（真源为 `lane_heartbeat`/`lane_longrun` 探针，逐请求调用 = 整批扫描）⇒ 本轮以「**待恢复 N**」（idle 计数）代替，**不冒充 stalled** ④ watch 服务端增量 ⑤ `test/api-batch-keys.test.js`（P-2/P-3 用例依赖 N-13）。
- **教训（R-3，写入门禁口径）**：**命令 gate 的 cwd 不是包根**——解析序 = lane worktree → env `GATE_REPO_ROOT` → **批次产物根**（`lib/state/gates.js:967-983`）⇒ `gate:` 行若用裸相对路径会**假红**（exit 1，`GATE_EXIT_NONZERO`）；正确形态 = 行内自带 `cd /d <包根>`。本批首轮即因此被判 paused，修正后从产物根 `cmd /d /s /c` 复现 exit 0。
- **生效与收口（2026-09-18 宿主重载后实测）**：引擎代码（`lib/api.js`、`lib/panel/**`、`lib/client.js`）随宿主重启生效。**部署面已闭**（原 G-1）：新进程 `pid 15576` 起于 `14:33:34`（后于本批落盘 `14:14`）；`/api/dsh-punky-swarm/batch` 探针由 **15 键 → 20 键**，七新键全在场（`danglingLanes` / `handoffs`（逐 lane 边计数）/ `assembly` / `teamAsset`（`team=engine-team, ok=true`）/ `chain` / `lanesGate` / `aipSession`），条件键 `manager` / `smoke` 正确缺场；在盘 bundle `lib/client.js` = **8 段 / 2447 行 / 139,524 B**（含 `panel-model` 段标记恰 1 处）；`pkg-hashes --check` **GREEN**、`check-guidance-sync` **GREEN**；批次 `panel-redesign-20260918` ⇒ **`complete`**。**残留（用户面）— 已确认闭环（2026-09-18）**：用户实测**面板可见**且**深链生效**（`http://127.0.0.1:3080/#cluster=session-ea465acf-…%3Apanel-redesign-20260918&view=lanes` 直达该批 `lanes` 视图）⇒ **面板项完全收口**。
- **顺带归档（TD-24 / R-3 口径写入指引）**：`presets/punky-preset/references/discipline.md` **§0e 新增 D-9**（任务包强制项：`gate:` 行必须 cwd 无关）+ **附录 A.4** 的命令 gate cwd 契约补「两种合规范式 + 实测假红反例 + 真源 `commandCwd()`」；`skills/engine-team/SKILL.md` §交接与门禁要点 同口径加一条。**live 副本同批同步**（`~/.dsh/.agent-presets/punky-preset/references/discipline.md`、`~/.agents/skills/engine-team/SKILL.md`）⇒ `check-guidance-sync` 复跑 **GREEN**。

### TD-02 结项：`pkg-hashes.txt` 重算 + 交付副本核对 + 宿主 reload 验证（2026-09-18，重启后）

- **宿主 reload 冒烟（本轮实测，非推断）**：dsh web 进程 `pid 36928` 起于 `2026-09-18 13:33:34`（旧进程已被替换 ⇒ F-1 的重启事实成立）；插件 apply 于 `2026-09-18T05:33:42Z`（= 13:33:42）写入 **7 条** `[dsh-punky-swarm] asset synced`（`presets/punky-preset`、`presets/engine-team`、`skills/software-team`、`skills/engine-team`、`skills/design-team`、`skills/research-team`、`skills/writing-team`）——证据源 `~/.dsh/logs/punky-swarm/audit-2026-09-18.jsonl`（`pid:36928`、`kind:log`）。**未 sync 的 3 条**（`skills/review-execution` / `acceptance-gate` / `retro-and-memory`）为 `current`（无变更 ⇒ 不记日志，与 `syncDir` 幂等语义一致）。
- **交付副本核对（十面逐文件 sha256：0 mismatch / 0 missing）**：`presets/punky-preset`(6)【含 `references/discipline.md` = 本轮退役口径改写】、`presets/engine-team`(1)【team-asset v3 单步三分支】、`skills/{software,engine,design,research,writing}-team`(17/1/9/1/1)、`skills/{review-execution,acceptance-gate,retro-and-memory}`(1/1/1) —— **repo 树 vs live 树逐文件比对全等**。⇒ F-2 / f-03 / UV-1 / G5 / G6 五条「live 落后」项**一次翻掉**；且**成因已定位**：交付副本由插件 apply 内的 `syncAssets()`（`lib/index.js:151`）**自动幂等同步**，**无需手工镜像**（原「是否本轮手工镜像」的悬置取消）。
- **TD-02 主体：新增生成器 `scripts/pkg-hashes.mjs` + 清单重算**。根因 = **该清单此前无生成器**（一次性命令产出）⇒ 重算不可复现、漂移只能人肉比对。新脚本单点固化三件事：范围（`baselines/ docs/ lib/ presets/ scripts/ skills/ test` 递归 + 包根文件；**点目录与 `node_modules` 一律排除**、清单自身不入表）、排序（相对路径字节序）、形态（`<相对路径>\t<sha256>\n`、UTF-8 无 BOM + LF）。参数面 **fail-closed**（未知参数/非法组合 ⇒ 用法打 stderr + **exit 2**，绝不进写盘分支）；`--check` 为只读对照。
- **重算读数**：重算前 `--check` = **RED 48 项漂移**（changed **45** / added **2**〔`scripts/pkg-hashes.mjs` 本体、`test/concurrency-gate.test.js`〕／removed **1**〔`skills/software-team-assembly/SKILL.md` 已退役〕；清单 355 → 实测 **356 件**）；重算后 `--check` = **changed 0 / added 0 / removed 0（GREEN）**。**回滚路径**：旧清单原样留存 `.wip-backup/pkg-hashes-pre-td02-20260918.txt`（sha256 `5c1ff601385295acd0b5875ceb11bd08b6fcff90773c303db7dfce1771b500c1`，33,678 B / 355 行）。**注（避免自指过期）**：新版清单**自身**的 sha 与字节数**不写进包内**——清单包含 `CHANGELOG.md` ⇒ 一旦写入就自指过期；清单真值以「最后一次 `--check` GREEN」为准，其 sha 记于台账 `§6.2`（包外，稳定）。
- **仍未做（维持挂起）**：longrun 工具改造（T-2/F-10/F-11）与面板 / HTTP 读端（T-1）——用户裁决挂起；五队新链真批（TD-07）待真实任务自然发生。

### 清债轮：冗余声明退役 + 死码清理 + K-2 单码例外（2026-09-18，用户裁决「保留引擎运行的核心内容，清理冗余设计与死代码」）

- **裁决口径**：用户裁「保留引擎运行的**核心**内容，清理所有**冗余设计**及其技术债与死代码；**longrun 与面板维持挂起**；`TEAM_ASSET_LAYER_UNKNOWN` 目前用不到（无外部自建 team）⇒ 先清理，之后有需求再用其他方式补充」。
- **① K-2 结项 = 单码例外（不推翻 Q1 严格面）**：`TEAM_ASSET_LAYER_UNKNOWN` **移出** `BLOCKING_CODES`（`lib/assembly/team-asset.js`）——未知层不再否决建批（`ok:true` + severity `warning` 留痕 + **不级联**），**其余 `TEAM_ASSET_*` 码逐条保持 blocking**。这是「Q1 都不降」的**唯一单码例外**，已在码表旁原位登记「为何只此一码」。
- **② 未接线三键退役（声明即拒）**：顶层 `state_machine` / 顶层 `rework` / `flows.<layer>.progress_contract` ⇒ 新增 `RETIRED_TOP_KEYS` / `RETIRED_FLOW_KEYS` 退役闸，**声明即拒** `TEAM_ASSET_FIELD_NOT_ALLOWED`（blocking、**零新造码**）。台账 `UNWIRED_DECLARATIONS` **清零**（三条整条删除、历史注释原位留档）⇒ `unwiredDeclarationsOf()` 恒空、`gate_status.gateStrength.unwired` 不再回显任何键。依据：三键**零运行期消费者**（原登记即「无读端」），留作「声明位」= 写了不生效 ⇒ **比拒更糟**（同 M1 步级 `on` 裁决）。
- **③ 链级 `chain.needHuman` 退役**：新增 `RETIRED_CHAIN_KEYS`（**派生自单点事由表** `RETIRED_CHAIN_REASONS`，新增退役键必同时补事由）⇒ `validateChain` 第 ⑧b 条**声明即拒** `TEAM_ASSET_FIELD_NOT_ALLOWED` @ `chain.needHuman`。原「只声明不消费」摘除；链级人工闸**唯一真源** = `flows.audit.needhuman` + Tier3 `checkNeedHumanGate`（**不设双真源**）。
- **④ 死码清理（只清「已无判据对象」的部分）**：`lib/assembly/team-asset.js` 不可达分支 `if (layer === 'complete') continue;`（F-4 后恒假）；同文件 `STATE_*` 三码 + `ESCALATIONS` 常量 + 未被消费的 `MEMBER_STATES`/`MEMBER_TRANSITIONS` 导入；`scripts/check-guidance-sync.mjs` 零读点载荷 `line`（连同 `forEach` 死下标参数）。`lib/tools/core.js` 的 `member-session-trace.log` 死绑定**上批已删**，本轮只留一行沿革注释（**不**当死码再删——保住审计线索）。
- **⑤ 测试面（翻转 + 补留痕 + 保码面，删断言数 = 0）**：`test/audit-contract-gate.test.js`（F-4+K-2）、`test/team-asset.test.js`（`state_machine`/`rework` 声明 → 退役闸一例；R2-3-c 表行改 `FIELD_NOT_ALLOWED`；混合告警夹具改用 `roles.extra`）、`test/chain-v3-assembly.test.js`（未知层不再否决 + 码/严重级锚点）、`test/gate-flows.test.js`（F-4+K-2 四锚点）、`test/teams-root.test.js`（`ENTRY_REQUIRE_UNKNOWN` + 新增「未知层不否决建批」例）、`test/contract-missing-first-touch.test.js`（夹具去 `state_machine`）、`test/gate-techdebt-red.test.js`（R-14/R-29 → 空台账 + 反向锚点）、`test/team-asset-snapshot.test.js`（`unwired` 恒空）、`test/writing-team-asset.test.js`（`state_machine` 缺席）；**新增** `test/p2-chain-autodrive.test.js` **P2-1b**（退役键声明即拒：路径 + 码 + severity + 反向零误伤 + 台账可读）。
- **⑥ 文档同步**：`presets/punky-preset/references/discipline.md` 消费点裁决表两行（`state_machine` / `progress_contract`+`rework`）**合并改写**为「**已退役（声明即拒）**」行（含台账位置与依据）；**live 副本同批同步**（`~/.dsh/.agent-presets/punky-preset/references/discipline.md`，`check-guidance-sync` 报 `repo == live`）⇒ 检查器 **GREEN**；三队 SKILL.md（engine / software / research）的「未接线键」口径更新为「`flows.exec.contract` = 未接线声明｜`chain.needHuman`、`flows.*.progress_contract` = **已退役、声明即拒**」。
- **⑥b 顺手修一处团队文档与资产不一致**（同一清债口径）：`skills/engine-team/SKILL.md` §链步形态原写「exec **三步串行**（`exec-impl`/`exec-verify`/`exec-review`），`pair_with:"exec-review"` ⇒ 6 lane」——与权威资产（**单步三分支**、`pair_with:"exec"`）**相反**；已按实测改写为「一步三分支并行 ⇒ `audit-pair` 派生 3 条 audit lane」，并把**实测读数**写进文档（`expandChainBranches(chain)`：plan 1 / exec 3 / audit-pair 3 / accept 1 = **8 lane**；`loadTeamAsset` / `chainProblemsOf` 均 `problems: []`、`expand.ok = true`）。**证据 = 命令读数**，非推断。
- **⑦ 派生工件与验证**：`baselines/test-baseline.json` 经官方脚本重生成（`--reason` 留痕）⇒ `files 136 / tests 1552 / asserts 7719 / tautologies 0 / todos 4 / lines 40439`（相对上一版：tests +1 / asserts +6 / lines +19，**全部来自 P2-1b**）。**全量验证**：`node --import ./test/helpers/isolated-home.preload.mjs --test` ⇒ **tests 1590 / pass 1586 / fail 0 / todo 4**；`node scripts/baseline-snapshot.mjs --check` ⇒ **exit 0**；`node scripts/check-team-assets.mjs --json` ⇒ **五队 `ok:true` / `problems: []`**（`resolvableNames 101`）；`node scripts/check-guidance-sync.mjs` ⇒ **GREEN**。
- **⑧ 未做（显式登记，不声称已做）**：**宿主 reload 冒烟**（F-1/F-2/f-03/UV-1/G5/G6）待一次授权窗口；`pkg-hashes.txt`（2026-09-17 22:57 版，已 stale）与交付副本 `~/.dsh/.agent-presets/engine-team/team-asset.yml`（实测 sha 与 repo 不一致）**同批待重载窗口同步**；**longrun 工具改造（T-2/F-10/F-11）与面板/HTTP 读端（T-1）维持挂起**（用户裁决）。
- **生效**：引擎代码（`lib/**`）+ 数据面（`presets/punky-preset/references/discipline.md`）+ 三条 SKILL.md ⇒ **需宿主重启一次**才在 live 生效（本轮**未**重启，**未**声称已做）。

### 交接语义归并：M0′（三小项）+ M1（删步级条件边 `on`）（2026-09-17，批 `handoff-consolidation-m0m1-20260917`）

- **M0′-① · `leader-direct` 批链推进全程 no-op**：`assembly.managerPlan === 'leader-direct'` 的批，`advanceChainAfterSettle`（`lib/engine/chain-runner.js`）在**读批之后、相位闸之前**直接返回，返回 `reason:'manager-plan-leader-direct'` + `note:'leader-direct-noop'`（**常态，不 warn**）。判据 = 批次 JSON 字段（建批期归一化写入；同字段既有读端 = 收口告警段），**不看 roster、不做运行时推断**。动机：Leader 直驱形态下引擎无自派能力（`dispatchLaneCore` 需 `exec.agent` 挂载点）⇒ 推进必然落 `no-lane-for-step` / `no-paired-lane` / `dispatch-failed` 等停轮分支，把 `running` 批写成 `paused`，逼 Leader 手工 `resume`（真机实证：同会话前一批 4ms 内 `chain.step{dispatch:{ok:false,reason:'no-lane-for-step'}}` + `batch.phase running→paused`）。边界：不改相位、不写 `chain.step`、不派发、不写锁；`raise` 批与无 `assembly` 的历史批**逐字不变**；调用方（`member_settle` 工具面 / 自动结算路 / 重放路）**零改动**（均不消费 `reason` 分支）。
- **M0′-② · `batch.phase` 事件补 `reason`（事由随相位迁移落盘）**：`store.setPhase` 增第 4 参 `{ reason = null }` 并归一化（**仅非空字符串计事由**）⇒ **非空才写键**，既有 `{from,to}` 形态零污染（历史读端与既有深比较不受影响）；埋点同步带 `reason`。**四个生产写点**逐个补事由：① 链停轮 `pauseBatch`（8 个调用点，取值与所在分支 `out.reason` **同源**）→ `chain:<分支>`；② 自动结算停轮 `pauseForFail` → `auto-settle:<判据码>`；③ `batch_phase` 工具面 → 缺省回填 `manual:batch_phase:<phase>`（**新增可选参 `reason`**，调用方可覆盖）；④ `batch_control` 干预面 → `manual:batch_control.<action>`。读端 `log_export` markdown 渲染 `<from> -> <to> | <reason>`（审计面「为何不推进」的唯一解释入口）。**不新增运行期门禁**（`setPhase` 是通用内部写入口，加抛错会连带改造测试夹具与动态相位调用面）⇒ 改以**源码级回归锁**承担（`test/phase-reason.test.js` 的 PR-8：三生产文件内不得存在裸 `setPhase(` 调用）。
- **M0′-③ · `chain` 运行期口径收敛（6 处纯文本）**：统一口径句 = 「`chain` = **建批期展开 + 静态校验**；**运行期 DAG 真源 = 批次 `lanes[].deps` + `handoffs`**（`chain.step` 仅是推进留痕，随 M5′ 退出）」。落点：`presets/punky-preset/references/discipline.md §0o`（新增「运行期口径」条 + 八条校验清单去掉 `on`）、`lib/assembly/chain.js` 头注释、`lib/engine/chain-runner.js` 头注释、`wave_plan` 与 `batch_status` 的 `description` 尾注、本 CHANGELOG。**只写口径、不新开文档**；包内 `docs/**` 与 EN 面实测无同步面。
- **M1 · 步级条件边 `on` 声明面下线（能力面**不可逆**）**：`on` 从「白名单键」变「未知键」⇒ `validateChain` **声明即拒** `TEAM_ASSET_FIELD_NOT_ALLOWED` @ `chain.steps.<id>.on`（v1/v2/v3 同拒，**零批次 JSON 落盘**）。**刻意不静默失能**：只删校验会让声明被忽略（「写了不生效」比拒更糟）。删除面：键域常量 `CHAIN_ON_TOKENS` 整条删除；`edgesOfStep` 只产 `next`；悬空目标校验（③）只判 `next`；判定单点 `chainNextOf` 收敛为「`merged`→`next`（缺省即链尾）/ `skipped` 恒不推进 / 失败面只余 `anyFailure`→`onFail` 两级」（`conflict` 与 `failed` **逐字同路**）；`CHAIN_STEP_VIA` 收窄为 `['next','onFail','anyFailure']`（写侧白名单 ⇒ 新写不可能产出历史 `on` 族取值）。**保留面（读侧历史兼容，禁删）**：`chainEchoOf`（不校验 `via` ⇒ 历史事件照常回显）、`countReworkAttempts`（仍按历史 `via` 计数，服务历史批的跨重启幂等）、`chainNextOf` 的回边预算段 —— 三者**同注登记**：M1 后无新触发路径，口径迁移归 **M4/CH-2**（本批不含；删则静默丢 `rework` 语义）。
- **能力面影响（不可逆项）**：显式条件路由（`on` 的四个终态键）**无法再声明**。等价性依据（`plan/spec.md §3`）：① 5 个内置团队资产 `chain` 块**零 `on` 使用**（逐行举证）；② 删掉的都是「**未声明 `on` 时从不命中**」的兜底分支 ⇒ 对不声明 `on` 的资产判定结果**逐字不变**；③ 反例面由拒绝面 fail-closed 挡住。未来若需恢复须**走规格**（登记于 `plan/spec.md §4 R1`）。
- **测试面**：`test/w1-conditional-edges.test.js` **同题反转**（W1-② 条件边 → 下线拒绝面：声明即拒三版本 + 零落盘 + 旧语义逐字不变 + 新 via 取值，头部登记反转）；`test/p2-chain-autodrive.test.js`（五段链改 `next`-only、环夹具改用 **v2 `deps` 拓扑回边**、`via` 期望改 `next`、**追加 M0′-① 三例**：leader-direct no-op / raise 对照 / 无 assembly 历史批不命中）；`test/gap-s12-chain-downgrade.test.js`（`on.merged` → `next`）；三套件装配声明由 `leader-direct` 改 **`raise`**（M0′-① 后 leader-direct 批链推进全程 no-op ⇒ 断言「引擎自动递进 / 无挂载点降级」的套件必须取非 leader-direct 形态）；`test/chain-v2-pairing.test.js` **同因联动**（分支配对 e2e 的装配声明改 `raise`，否则去屏障断言恒 wait）；**新增** `test/m1-on-removed.test.js`（13 例）与 `test/phase-reason.test.js`（8 例）。
- **断言账（如实）**：全库 asserts **7489 → 7563（+74）**、tests **1509 → 1532（+23）**、tautologies **0 → 0**；其中 `w1-conditional-edges` 单文件 tests −1 / asserts **−7**（**对象消失的等价改写**：显式条件路由已下线，7 条「条件路由生效」断言失去判据对象，改写为「声明即拒 / 恒不推进 / 新 via 取值」断言；**非静默删断言**，`baseline --check` 的总量判据不降反升）。
- **验证**：新增两套件 RED→GREEN（RED：21 例中 15 红，逐条证明「失败 = 未实现」）；受影响清单（spec §8②，14 文件）**204/204 pass**；**全量** `node --import ./test/helpers/isolated-home.preload.mjs --test` ⇒ **tests 1570 / pass 1564 / fail 2 / todo 4**，两例红 = `test/test-baseline.test.js` 的 e2-1/e2-2（**基线快照滞后**所致：本批新增/改写用例 ⇒ 逐文件漂移；`baselines/**` 按批约束**只允许 `--check`**、禁写盘 ⇒ 登记为已知项，重生成归 Leader 排期）；`node scripts/baseline-snapshot.mjs --check` **exit 0**（断言总数 +74 不降、恒真形态 0 不升）。
- **宿主冒烟（未做，显式登记）**：本批**禁重启宿主**（批约束 C-6）⇒ 真实加载冒烟**无法在本批完成**；完成判据取「模块级 import 冒烟 + 受影响测试全绿 + 基线 `--check`」，**宿主 reload 冒烟待 Leader 排期（重启窗口）**——`exec/out.md` 已同口径登记，**未声称已做**。
- **生效**：引擎代码（`lib/**`）与数据面（`presets/punky-preset/references/discipline.md`）⇒ **需宿主重启一次**；本批**禁重启宿主**，故**宿主级 reload 冒烟待 Leader 排期**（已在 `exec/out.md` 显式登记，未声称已做）。

### P2：推进链 `chain` 接线 —— 事件驱动自动推进 + P0 句柄修复（2026-09-16，批 `p2-chain-autodrive-20260916`）

- **语义（构造期校验 + 事件驱动自动推进）**：团队资产**顶层 `chain`**（唯一规范位；显式声明 `flows.chain` ⇒ 拒 `TEAM_ASSET_FIELD_NOT_ALLOWED`，禁双真源、不设兼容分支）在**构造期**（`wave_plan`，`createBatch` **之前**）做**八条静态校验**——层白名单 / 角色悬空 / 悬空 `next`·`on` / 到不了的环节（无孤儿步）/ 环须由 `rework` 承认 / 链尾（`terminal`）唯一 / `join:any` 必带 `anyFailure` / 只收枚举 token（禁表达式）；逐条**复用既有 `TEAM_ASSET_*` 码、零新造**，拒后**零批次 JSON 落盘**。链内 lane 的 `member.settled` ⇒ 引擎算下一环并**自派**（`merged` 走 `next`/`on.merged`；`failed`/`conflict` 走 `on.fail` → `join:any` 的 `anyFailure` → 链级 `onFail`；`skipped` 不推进）；每次推进落一条 `chain.step`（`{from,to,via,lane,step}`），`batch_status` 增 `chain` 回显（`{version,steps[],lastStep,edges[]}`）。**无 `chain` 的批全程 no-op**（层序/门禁/事件/成员语义逐字不变 = R5 向后兼容锁，读端也不出现 `chain` 键）。
- **停轮口径（只停推进、不判死）**：`onFail` 缺省 `pause` ⇒ 写 `chain.step` + `running→paused`（幂等；已 `paused` 不重复写），**不写 `failed`、不 `abort`**；`review`/`failed` 两 token 只留痕停轮（处置交还 Leader/Manager）。链步在本批无对应 lane（`no-lane-for-step`）、目标 lane 已终态/持锁不可重派（`no-redispatchable-lane`）、映射歧义（`ambiguous-mapping`）一律**停轮 + 事件留痕**，**绝不新造 lane、绝不改 `wavePlan` 分层**（RK2）；回边只重派同一 lane，`rework.max_attempts` 硬限（计数取事件流 `via:'on.fail'` 条数，跨重启幂等）。
- **落点（新增 2 + 修改 3 + 常量 1）**：新增 `lib/assembly/chain.js`（纯函数：解析 / 八条校验 / lane→step 映射 / 推进判定 / 读端投影，零 IO、零副作用）与 `lib/engine/chain-runner.js`（`member.settled` ⇒ 推进主入口；异常隔离不抛，结算事实不被推进失败反噬）；`lib/engine/dispatch.js` 抽出 `dispatchLaneCore`（工具面 `lane_dispatch` 与链引擎**共用同一条派发路径**——同 Tier3 entry 门 / 同句柄 / 同任务包骨架 / 同 `member.dispatch` 登记，禁第二套实现）；`lib/tools/core.js` 接 `assertChainReady`（构造期首码原样透出）+ `member_settle` 挂推进 + `batch_status` 回显；`lib/assembly/team-asset.js` 删除 P1 的 `chain` 未接线台账条目；`lib/state/event-types.js` 增 `EVT_CHAIN_STEP='chain.step'`（本批唯一 `lib/state/**` 改动，一行）。
- **P0 句柄修复**：**成功自派 ⇒ 立即消费句柄**（`member.dispatch` 登记之后调 `consumeLaneHandle`；口径「自派即发放即作废、仅直派形态需长期有效」写入代码注释）；两处降级「仅发句柄」分支（无 `ctx.subagents` / 未配置 `config.dispatch.provider`）**不得消费**——句柄是人工直派形态的唯一凭证；失败路径维持既有消费（等价「已回收」）。绑定缺口判据改「**无绑定才报**」：本 stint 内 `member.dispatch` 且 `workerSessionId` 非空 ⇒ 已绑定直接 `hit:false`（**句柄残留 ≠ 无绑定**，修掉引擎自派后旧句柄造成的 `token-ttl-expired` 幽灵缺口）；`no-dispatch` / 无绑定 + 超 TTL 未消费句柄 ⇒ `token-ttl-expired` 两类既有语义逐字保留。
- **测试面（本批 e-tests）**：新增 `test/p2-chain-autodrive.test.js`（**9 例**：① 链声明正向（五段链八条全过 + 真资产 `engine-team` + `flows.chain` 位置拒 + `skipped` 不推进）② 三反例构造期拒（环未被 `rework` 承认 / `join:any` 缺 `anyFailure` / 链尾不唯一）各含**零批次 JSON 落盘**校验 ③ **五段链自动递进**：`plan` merged ⇒ `plan→exec→tester→review→audit` 逐环自动自派（4 条 `chain.step` 逐条核对 `via`、`member.dispatch` 与 label、句柄零残留、`batch_status.chain` 回显可复原全链，链尾不伪造边）④ P0 句柄两分支（成功= `handle-consumed` + `pendingHandles` 清空；降级= 句柄仍 `verifyLaneHandle` 通过且留在 pending）⑤ `>30min` 活跃 lane 零假 gap（真实批次的已绑定 lane 在 TTL 之后仍 `hit:false` + 未绑定反证仍报 `token-ttl-expired` + 无 dispatch 仍 `no-dispatch`）⑥ 无 `chain` 向后兼容锁（零 `chain.step` / 相位不变 / 不自动派发 / 读端无 `chain` 键）⑦ G-3 有资产但无 `flows.audit` + 含 audit lane ⇒ 零感知跳过）。**删断言数 = 0**。
- **回归锁（两处既有红，均为方向对齐而非放宽）**：`test/team-asset-mandatory.test.js` P1-4a 的 `chain` 台账断言 **反转为「不得登记」**（P1 登记（`status:'unwired'`、consumer 标 P2）→ P2 接线 ⇒ 条目整条删除；反转形态防回退，判据强度未减）；`test/engine-dispatch.test.js` B2 夹具**去掉 `workerSessionId`**（原夹具带 `ws-1` 命中「无绑定才报」判据 ⇒ `token-ttl-expired` 分支**永不可达**；反证实测：旧夹具 `{"hit":false,"reason":null}`、新夹具 `{"hit":true,"reason":"token-ttl-expired"}`）并**补**「已绑定 + 超 TTL 残句柄 ⇒ `hit:false`」断言。
- **指引**：`presets/punky-preset/references/discipline.md` §0o 增「**`chain` 已接线**」（唯一规范位 / 八条校验 / 自动推进 / 无链 no-op / P1 台账条目已删）与「**两段式拒态（G-2）**」——建批失败须先分段：**段一 = 框架参数面**（宿主参数 schema，文案不含引擎码）⇒ **段二 = 业务构造期面**（`wave_plan.execute` 内判定序，文案首行原样透出 `TEAM_ASSET_*`/`GATE_*` 码）；共同判据 = **零批次 JSON 落盘** + `pendingBatch` 保留可重试。
- **派生工件**：`baselines/test-baseline.json` 经官方脚本重生成（`node scripts/baseline-snapshot.mjs --reason "P2 推进链接线（批 p2-chain-autodrive-20260916 · lane e-tests）…"`）⇒ files **114→115**、tests **1321→1330**（+9）、asserts **6540→6586**（+46）、tautologies 0、todos 4 不变。
  - *（2026-09-17 漂移复核注记：**以上数字是 P2 时点快照，非当前值**——基线此后已被后续批次重生成。现 `baselines/test-baseline.json` 实读：`reason` = 「W1-① 重放/恢复尾巴：新增 test/replay-integration.test.js…」、`generatedAt` = `2026-09-16T16:24:15Z`、files **125** / tests **1431** / asserts **7063** / tautologies 0 / todos 4；`package.json` version 仍为 `0.4.4`（本批未发版）。P2 当时的历史数字按「不重写历史」纪律原样保留。）*
- **验证**：定向 `node --import ./test/helpers/isolated-home.preload.mjs --test test/p2-chain-autodrive.test.js` **9/9 pass**；四文件定向（`test-baseline` + 本批三处）**53/53 pass**；全量同命令 **tests 1366 / pass 1362 / fail 0 / todo 4**（其中 2 例 `test-baseline` 红由基线滞后引起，重生成后归零）。
- **生效**：引擎代码（`lib/**`）与数据面（`presets/punky-preset/references/discipline.md`、`baselines/`）⇒ **需宿主重启一次**：代码面随插件重载生效，指引面经资产同步（包内 `presets/` → `~/.dsh/.agent-presets/punky-preset/`）随同一次重启落到 live preset。

### P1：团队资产必填化 —— `team` 必填 + 构造期拒 + 废 `generic`（2026-09-16，批 `p1-team-asset-mandatory-20260916`）

- **语义（构造期拒）**：`wave_plan` 的 `team` 改为**必填且必须解析到团队资产**——缺失/空串 ⇒ 参数面即拒（`team` 出 `required`，文案原样含 `TEAM_ASSET_MISSING_FIELD` 语义）；解析不到资产（含**已废除的 `generic`**、**已退役的 `jiufeng`**、以及**模式名误用**如 `punky-preset`）⇒ 构造期拒 `TEAM_ASSET_NOT_FOUND`；资产某 role 的 `skills` **非空但不可解析** ⇒ 拒 `TEAM_ASSET_SKILLS_MISMATCH`（语义由「非空」扩为「非空且可解析」）。**拒后零批次 JSON 落盘**、`pendingBatch` 保留（补声明可重试）——不再有「告警 + 照常建批」的假绿灯。
- **判定序（fail-closed，`lib/tools/core.js` 构造期前置段，先于 `store.createBatch`）**：① `team` 词法/必填 → ② 资产加载 + 加载期不变量（首个 blocking 码**原样透出**）→ ③ `skills` 可解析 → ④ 才进 `buildWavePlan`/`createBatch`。**门作用域仍限工具面**（直调 `buildWavePlan` 不走本门 = 已登记差异 W-2，本批不消）。
- **技能可解析面**：宿主技能根 `USERPROFILE||HOME` + `.agents/skills`（与既有技能名告警面**同源**）；可解析名 = 技能**目录名** ∪ `SKILL.md` frontmatter `name`；**技能根不存在/不可读 ⇒ 同码拒**（不放行、不静默跳过）。零新 env、零新码（复用既有 `TEAM_ASSET_*`）。
- **拒态文案可读可自救**：点名「该团队无资产 ⇒ 改用有资产的团队」并给出**运行时枚举**的可解析团队；同时消歧「`presets/<team>/team-asset.yml` = 团队资产」vs「`presets/punky-preset/` = 预设（模式）资产，不是团队资产」。
- **新增资产 `presets/engine-team/team-asset.yml`**：engine 级团队（plan `designer` / exec `coder`·`reviewer` / audit `reviewer`，`audit_leads:[reviewer]`）；`chain` 段 P1 **只登记不接线**——已登进 `lib/assembly/team-asset.js` 的 `UNWIRED_DECLARATIONS`（`status:'unwired'`，consumer 标「P2 flows 推进链」），P2 接线时删该条。资产清单同步 **9 → 10 条**（`presets/punky-preset/asset-manifest.json` 与 `lib/assets.js` 的 `DEFAULT_ASSETS`，新增 `presets/engine-team → preset/engine-team`）。
- **读端兜底清理**：`lib/state/store.js` / `lib/assembly/snapshot.js` / `lib/aip/agent-descriptor.js` 的 `?? 'generic'` 与 `lib/wave-plan.js` 的 `team = 'generic'` 缺省**同批清退**（避免第二个默认值真源）；缺省链口径不变（无 `chain` ⇒ 现行 3 层直线链 `plan→exec→audit`）。
- **指引**：`presets/punky-preset/references/discipline.md` 新增 **§0o 团队资产必填与缺省链口径**（team 必填 / 无资产团队名一律拒 / 命名空间消歧 / 团队资产要求含自建团队 skills 必可解析 / 缺省链口径；§0m 已被「派发套件」占用，故不共号）。
- **测试面（本批 e2）**：新增 `test/team-asset-mandatory.test.js`（9 例：无资产拒 + 零落盘、模式名误用拒、`team` 缺失/空串拒、`generic` 拒、teamsRoot skills 不可解析拒（含正向对照）、技能根不存在同码拒、engine-team `ok:true`/`problems:[]` + 牵头角色不悬空 + `chain` 登记**且可读**、engine-team 建批零 `GATE_TEAM_ASSET_*`/`GATE_ROLE_MISSING`、读端不再兜底 `generic`）；新增夹具 `test/helpers/host-skills.mjs`（隔离宿主技能根**显式注入** + 建批面默认团队 `withDefaultTeam`）。同步既有用例：**60 处 / 14 文件**建批调用补 `team`（不覆盖显式传值）、**4 处断言反转**（无资产：告警+建批 → 拒+零批次落盘）、**9 文件补技能根**、`threeTierTasks`/`cplusTasks`/`G2_TASKS` audit 补 `exec/` consume（团队 `audit_contract.consumes_required` 既有纪律，形态收紧）、assets 计数 **9→10**、`contract.test.js` 与 tool-descriptor 读端口径同步、`suite-consistency-and-hot` 的 `stripComments` 改正则→状态机（注释里 `presets/*` 会破坏正则配对，实测把 core.js 14 个 `defineTool` 块吞到 4 个）。**删断言数 = 0**。
- **派生工件**：`baselines/test-baseline.json` 经官方脚本重生成（`node scripts/baseline-snapshot.mjs --reason "P1 团队资产必填化（批 p1-team-asset-mandatory-20260916）：新增 test/team-asset-mandatory.test.js（9 例）+ 同步既有用例（补 team / 断言反转 / 夹具技能根 / assets 计数 9→10 / 扫描器修正）"`）⇒ files 113→114、tests 1312→1321（+9）、asserts 6498→6540（+42）、todos 4 不变。
- **验证**：定向 `node --import ./test/helpers/isolated-home.preload.mjs --test test/team-asset-mandatory.test.js` **9/9 pass**；全量同命令 **tests 1357 / pass 1353 / fail 0 / todo 4**（e1 未落盘期 RED 基线 = 100 fail，收敛后 0）。
- **生效**：引擎代码（`lib/**`、`presets/engine-team/`、`asset-manifest.json`）与**数据面**（`presets/punky-preset/references/discipline.md §0o`、`baselines/`）⇒ **需宿主重启一次**：代码面随插件重载生效，指引面经资产同步（包内 `presets/` → `~/.dsh/.agent-presets/punky-preset/`）随同一次重启落到 live preset。

### 套件工具单点注册表 `SUITE_TOOLS`：deny 集与模式门覆盖集同源派生（2026-09-16，批 `suite-registry-20260916`）

- **动机**：成员 deny 集（`lib/engine/dispatch.js` 的 13 项字面量）与模式门覆盖集（`lib/tools/core.js` 的 `assertModeActive` 调用点）此前各自散落、两侧口径靠人肉同步——本批把「哪件工具属于哪一面」收敛成**一张表 + 两个派生函数**：新建 `lib/engine/suite.js`（`SUITE_TOOLS`，26 件 × 五字段 `name`/`kind`/`modeGate`/`memberDeny`/`write`）。
- **派生与兼容**：`SUITE_DENY_TOOLS ≡ SUITE_TOOLS.filter(memberDeny)`（**13 项，导出名/内容/顺序逐字不变**、`Object.freeze`）；`MODE_GATED_TOOLS ≡ SUITE_TOOLS.filter(modeGate)`（9 项）。`lib/engine/dispatch.js` 改为 `import { SUITE_DENY_TOOLS, MODE_GATED_TOOLS } from './suite.js'` 再 `export { … }`——**必须保留本地绑定**：`buildStartSpec({ denyTools = SUITE_DENY_TOOLS })` 的缺省值直接引用该符号，纯再导出（`export { … } from`）会 `ReferenceError`。
  - *（2026-09-17 漂移复核注记：注册表此后**扩了一件**，故上句的 26 / 13 / 9 是**本批时点值**。现 `lib/engine/suite.js` 运行期实读：`SUITE_TOOLS` **27** / `SUITE_DENY_TOOLS` **14** / `MODE_GATED_TOOLS` **10**，增量恰为 `batch_control`（`suite.js:59`，成员 deny 与模式门两面各 +1，注释自述「P3a 最小干预面」）。⇒「13 项逐字不变」的现存语义是**既有 13 项名字与顺序不变 + 尾部追加**，不是总数冻结（`test/suite-consistency-and-hot.test.js` SC-1 现按 14/10 对账）。本批历史数字原样保留。）*
- **口径边界（承前）**：本表只收治理/派发套件，`mcp__*` **不入表、不进 deny、不受模式门**（MCP 等普通工具对成员全量开放）。
- **模式门补齐 5 件**：`batch_phase` / `lane_claim` / `lane_release` / `asset_claim` / `assign_check`——各件 `execute` **首行**落 `assertModeActive(deps, exec, '<动作名>')`，**先于**参数/状态校验，使非生效模式下零治理写入（`batch_phase` 不迁阶段、`lane_claim` 不落锁、`asset_claim` 不复制产物、`assign_check` 不写 `lastAssign`）。
- **回归锁**：`test/suite-consistency-and-hot.test.js` SC-1 升级为**全量一致性**（注册表派生 ↔ 导出 ↔ 冻结现值：deny 13 项顺序逐字不变、modeGate 9 项含新补 5 件、两面均不含 `mcp__*`）+ 新增 SC-4（**静态声明面 = 行为面 = 注册表 `modeGate` 集**，双向相等）；`test/mode-gate.test.js` 新增 T3（新补 5 件各一条反向用例 ⇒ `GATE_MODE_INACTIVE` + 零治理写入）。反证已做：三处预期故意改错时三条用例各自 RED。
- **文档**：`presets/punky-preset/references/discipline.md` §0n 增「零介入面 = 注册表 modeGate 集」条（含 9 件清单与锁定用例指针）。
- **生效**：代码改动 ⇒ **需宿主重启**。

### 禁止成员嵌套派发：`subagent` / `subagent_fork` 入成员 deny 列表（2026-09-16 用户裁决）

- **裁决口径**：「【成员侧只禁主 Agent 的派发工具】≡【禁止成员嵌套派发】——蟛蜞模式下成员无法派生子成员即可」；边界同时确立为「**MCP 等普通工具对成员全量开放**」。
- **为何必须显式 deny（代码证据）**：宿主 `maxDepth` 判据是 `childDepth > maxDepth`（`@deepseek-ai/dsh-subagent/lib/index.js:432-436`），我们传的 `maxDepth: 1` **只约束「创建该子会话」**，不约束子会话再派——子会话再派时用的是**它自己那层**的 `tool-subagent` 配置，而 `presets/punky-preset/agent.cordis.yml` 的 `tool-subagent`/`tool-subagent-fork` **未设 maxDepth** ⇒ 走宿主默认 **3** ⇒ 成员（depth 1）再派 depth 2 **被允许**。故成员 deny 列表是「禁止嵌套派发」的**唯一落实点**（`toolFilter.deny` = 可见性期收窄，工具 vanish 且拒绝执行；活体已证「目录可见、调用面被移除」）。
- **落点**：`lib/engine/dispatch.js` `SUITE_DENY_TOOLS` 11 → **13** 项（`+ subagent` / `+ subagent_fork`），并注明口径边界（不得扩到 `mcp__*` 等普通工具）。
- **回归锁**：新增 `test/member-deny-boundary.test.js`（3 用例）：① 两件派发工具必须在列；② 必须真正落到 `buildStartSpec(...).request.toolFilter.deny`（不是只写在常量里）；③ **边界锁**——列表不得含 `mcp__*`/`read`/`write`/`pwsh` 等普通工具。测试基线按登记理由再生（`tests=+3 asserts=+5`）。
- **未采的第二道防线（留档，非本轮范围）**：可另在 preset 给 `tool-subagent`/`tool-subagent-fork` 设 `maxDepth: 1` 做结构性兜底（Leader 的 `childDepth=1≤1` 不受影响；成员再派 `2>1` 被拒）。经裁决只做 deny 面，此项记为可选加固。
- **生效**：代码改动 ⇒ **需宿主重启**。

### 派发套件活体验证结论 + 第三处缺陷（任务包不携带 `cmd`）（2026-09-16，批次 `suite-live-20260916`）

**活体通过面**（同一批次三轮修复后实测）：

| 验证项 | 活体读数 |
|---|---|
| 引擎自派（`lane_dispatch` → `ctx.subagents.startContinuable`） | p-spec → worker `7cefa483…`；e-a → `25940350…`；e-b → `6c4dfa53…`；a-verify → `fa70aa90…` 全部 `spawned:true` |
| B5 引擎直写 `member.dispatch` | 批事件 3 条（p-spec / e-a @05:51:47.873 / e-b @05:51:48.119）；**并行派发两条 lane 各自登记、未互相覆盖**（修掉「只登记最后一条」） |
| 成员工具面收窄 | e-a：`wave_plan`/`member_settle`/`assign_check` 目录可见但**本会话不可用**；e-b：`tools_schema` 精确名查询 `missing=[lane_dispatch, wave_plan, member_status]` ⇒ **可见性期收窄生效**（目录层 ≠ 会话面，两口径不可混同） |
| 成员通信套件 | `swarm.report → Leader（suite-live-20260916/e-a，progress）` 与 `swarm.cc → Manager（suite-live-20260916/e-b，anomaly）` 均成功，**未报 `GATE_SWARM_UNBOUND_REPORT`** ⇒ 身份按 `member.dispatch.workerSessionId` 反查绑定成功；批事件 `swarm.report` / `swarm.cc` 双留痕 |
| 产物与门禁 | `plan/spec.md`(1,449B) / `exec/a.md`(1,578B) / `exec/b.md`(1,776B) 落批次产物根；plan/exec lane 结算 merged（Plan 契约 / outputs 门均通过） |

**第三处缺陷（本轮抓出，已修待重启生效）**：worker 回执报任务包「目标」位为 `（未声明 cmd）`。

- **根因**：派发处读 `store.readBatch(...)?.wavePlan?.tasks`，而 **`batch.wavePlan` 存的是 wave 数组**（`[{wave, tasks:[…]}]`；见 `wave_plan` 渲染 `value.wavePlan.length + ' waves'`）⇒ `.tasks` 恒 `undefined` ⇒ `laneTask` 恒 `null` ⇒ 任务包「角色/契约/产物」位同样取不到，worker 只能靠 Leader 的 `prompt` 补充自述任务（**本轮全靠 prompt 自包含才没跑偏**——若 Leader 只给一句话要点，引擎自派的 worker 将拿到空任务包）。
- **修复**：改为拍平所有 wave 的 tasks 后再按 lane id 定位（`wavePlan.flatMap(w => w?.tasks ?? [])`，并兼容旧的非数组形态）。
- **同源特征（三处一致）**：这条派发链上「**类型面/结构面与运行时不符**」——①未 `inject` 的服务取属性即抛（不是 `undefined`）；②类型 `Omit` 掉却在运行时必需的 `signal`；③`wavePlan` 是 wave 数组而非 `{tasks}`。⇒ 该链路后续改动须以**活体**为准，类型/文档面不足以定契约。
- **待补验证（本轮未做）**：被 `toolFilter.deny` 的工具是「隐藏」已在活体证实，但**「越权调用被拒」尚未实测**（两条 lane 都按纪律没去调），下一轮由一条 lane 显式尝试调用 `wave_plan` 取拒态码。

### 派发套件活体缺陷修复：`inject` 漏声明 `subagents` + `startContinuable` 的 `signal` 契约（2026-09-16，批次 `suite-live-20260916` 首派连抓两层）

- **第一层（inject）**：
  - **现象（活体原始报错）**：`lane_dispatch({batchId, lane:'p-spec'})` 报 `cannot get property "subagents" without inject`——**原始 cordis 错**，不是我们的 `GATE_DISPATCH_*` 码面；lane 已被置 `running` 但零绑定 worker。
  - **根因**：cordis 对**未在 `inject` 声明的服务**在取属性时**直接抛**（不是返回 `undefined`）⇒ `subagentRuntimeOf(ctx)` 里那句 `ctx?.subagents` 直接炸，既定的「无 `ctx.subagents` ⇒ 降级为仅发句柄」分支（B1 语义）**从未有机会执行**。
  - **修复**：① `lib/index.js` `inject` 补 `subagents`（宿主 `dsh-base` 默认挂载 `@deepseek-ai/dsh-subagent`，声明安全）；② `subagentRuntimeOf` 包 `try/catch` ⇒ 走「仅发句柄」降级，不再以原始错崩掉。
- **第二层（signal，重启后重派才暴露）**：
  - **现象**：`GATE_DISPATCH_FAILED: 引擎自派失败：Cannot read properties of undefined (reading 'throwIfAborted')`。
  - **根因**：宿主 `SubagentRuntime.startContinuable(spec)` **直接调 `spec.signal.throwIfAborted()`**（`@deepseek-ai/dsh-subagent/lib/types/continuation.js:139`，并透传 `prepareContinuable(..., {signal: spec.signal})`）⇒ **`signal` 是运行时必需字段**；而宿主类型把它写在 `Omit<..., 'signal'>` 里 ⇒ **类型面看不出来**，只有活体能抓。
  - **修复**：`lib/engine/dispatch.js` `buildStartSpec` 补 `signal`——缺省 `new AbortController().signal`（**永不中止**：worker 不随 Leader 回合取消而中断），并支持调用方注入自有 signal（原样透传，显式取消能力）。
- **锁死回归**：`test/dispatch-inject-guard.test.js` 扩到 6 用例：inject 含 `subagents`；**抛错式**取属性（Proxy 模拟注入守卫）⇒ `null` 不抛；常规三形态；**`spec.signal` 存在且 `throwIfAborted()` 可调**；自有 signal 原样透传 + 中止后抛；缺省 signal 每次独立（不复用单例，防跨 lane 误取消）。测试基线按登记理由再生（累计 `tests=+6 asserts=+15`）。
- **顺带实证（正面结论）**：第一层失败**被引擎自己的观测面抓到**——心跳写 `lane.binding_gap{lane:p-spec, reason:no-dispatch}`（D2 接线活体有效，**只标记不自动处置**），Manager 首轮只读回执据此定位（含产物根目录不存在这一物理佐证）。
- **生效**：两处均为代码改动 ⇒ **各需一次宿主重启**；本批置 `paused`，重启后 `batch_phase(running)` + 重派 `p-spec` 续跑。

### `execToolCount` 降为纯观察面：不再是升档/评估过期依据（2026-09-16 用户裁决）

- **裁决原话**：「execToolCount 改为仅提示，不作为升难度档依据，难度档位依据已经彻底改写。」
- **落点**：`lib/state/store.js` `stale()` **移除 `execCallsSince ≥ maxCalls(20)` 判据**（入参 `maxCalls` 保留但忽略，向后兼容调用方签名）——过期只认「从未评估 / 距 `lastAssign.at` ≥ 30min / 时间戳非法」；`bumpExecCount` 保留累计语义并注明**纯观察**。
- **理由（如实）**：① 档位依据已改写为「每回合主动写入的 difficulty + 判据」，调用数本就不该驱动档位或过期；② 活体实测只读侦察计数会被灌水（见 `lib/tools/readonly.js` 头部活体注记）⇒ 旧判据会误触发重评、压缩评估窗口。
- **连带更新**：`lib/tools/readonly.js` 头注补充活体实测结论（guard 阶段只读判定未命中，属待修项）与「计数仅观察」口径。
- **测试同步（4 条断言改写 + 1 条新锚）**：`test/governance.test.js` stale 用例改为「`execCallsSince` 20 / 10000 均不过期」；`guard` 用例由「20 次调用后重评」改为「补足 20+ 次仍放行 + 时间窗过期才重评」；`test/tools.test.js` 两处旧判据断言改用时间窗。测试基线按登记理由再生（`asserts=+5`）。

### 改名登记与「模式跟随」：`jiufeng` → `punky-preset` + 全局装载不全局生效（2026-09-16）

- **改名（三处全改，用户裁决 A3）**：① **agent preset id / 目录**：`presets/jiufeng/` → `presets/punky-preset/`（含 `asset-manifest.json`、`preset.yml`、`agent.cordis.yml`、`references/`）；② **引擎数据根缺省**：`config.root ?? '~/.dsh/punky-preset'`（旧根 `~/.dsh/jiufeng` **原样保留**为历史归档，用户裁决 R-c：不迁移、不桥接 ⇒ 活体查询不呈现旧批次）；③ **装配命名空间**：`aip.team` 缺省与 `resolveAssembly(...)` 的退役团队名一并改 `punky-preset`。**未改**（历史事实）：`CHANGELOG.md` 既有条目、`docs/decisions/**` 留档、旧团队名 `jiufeng-team` 字面。
- **改动面**：51 个文件 165 处（`lib/**` 含 `wave-plan.ts/.js` 对、`test/**` 断言与夹具、`presets/**`、`skills/**`、`docs/**`、`scripts/**`）；`test/contract.test.js` 内标识符 `jiufengAssembly` 手工修正为 `punkyPresetAssembly`（机械替换会咬伤长标识符，已登记为改名操作的坑）。
- **模式跟随（B1，用户裁决「全局装载、不全局生效」）**：新增 `config.modes.gate` 白名单——名单内 preset 才启用难度门禁 / G1 / 套件工具；名单外**门禁全放行且不计数**（其他模式零影响）；子会话（Manager/worker）继承父会话模式，**结算面不被误锁**；套件写面工具在名单外拒 `GATE_MODE_INACTIVE`（先于 G1）。`modes` / `dispatch` 纳入热更白名单 ⇒ 改 `runtime.json` 即生效、无需重启。
- **缺省方向（如实登记）**：包缺省 = `modes.gate` 未配置 ⇒ **全模式生效（旧行为）**，避免升级悄然改变任何已装环境的行为；「跟随模式」由部署配置显式开启（本机 `cordis.patch.yml` 已写 `gate: ['punky-preset','jiufeng']`，`jiufeng` 为旧会话过渡别名）。
- **`dispatch.gate` 保持缺省 `warn`**（用户裁决：enforce 不开）；`config.dispatch.provider: spawn` 随本次一并配置（宿主 `dsh-base` 挂载 `dsh-subagent-spawn-in-process`, providerName `spawn`）。
- **验证**：新增 `test/mode-gate.test.js`（10 用例：纯函数 / guard 放行与计数 / 套件拒态码与 G1 次序 / 热更白名单与快照切换）⇒ 10/10；全量回归绿；测试基线按登记理由再生（+10 用例 / +42 断言，差值恰为新文件）。
- **生效**：引擎代码 + 部署配置 ⇒ **需宿主重启**；活体验证（白名单外模式零介入、白名单内门禁照旧、`lane_dispatch` 自派）留待重启后按清单执行。

### B2：蓝图 §8⑤「运行期首触校验」落地 —— `gate.contract_missing`（2026-09-15）

- **语义（读法 A，Leader 已裁）**：团队资产**未声明**某检查项 ⇒ 引擎缺省接管时**首次触达该检查点**，落事件 `gate.contract_missing` + 一次 `warn` 留痕；**非拒态**——**不新增 `GateErrorCode`**、不改任何判定、不改 exit code、不阻断迁移。
- **去重与幂等**：去重键 `(batchId, gateKind, layer)`，判据 = `batch.events`（同键已存在 ⇒ 不再发）⇒ **只报一次/批 + 跨重启幂等**；实测 **7 条/批**（6 个判定位 + `layer` 维度）。
- **只读零发射（R-5 硬边界）**：事件**只由写路径**（`setMember` / `setPhase`）发射；`gate_status` 等**只读视图绝不发射**（负控用例锁定）。
- **落点**：`lib/state/event-types.js`（常量单点）｜`lib/types/contracts.ts`（事件判别分支；`GateErrorCode` **零改**）｜`lib/state/gates.ts`（**纯构造**载荷 `contractMissingPayload()` + 6 个判定位：`entry_requires`/`contract`/`needhuman`/`gate_command`/`targets`/`complete`）｜`lib/state/store.js`（纯函数去重 + **即时发射器**，与 `member.settled` **同一次 `atomicWrite`**）。
- **验证**：9 用例 RED(6红)→GREEN(9/9)；R-5 只读零发射（`gateStatus` 9 次 + 真工具面 3 次调用均零事件）；幂等（跨 `createStore` 实例重建后同键仍 1 条）；定向 344 tests / 0 fail；**audit 独立复现 18/18**（含 `GateErrorCode` 21 条零新增、拒侧仍拒）。
- **规格勘误（D-5，2026-09-15 回写）**：实施形态由规格「延迟收集 + 统一落盘」改为**即时 push 独立发射器**（去重须即时判定）；去重上限由规格「≤6 条/批」订正为**实测 7 条**（键含 `layer`，按 R-3 键逐字实现、不并层）；勘误落在 `artifacts/core-debt-parallel-20260915/plan/debt-spec.md` 顶部「勘误与回写」。
- **生效**：引擎代码 ⇒ 需宿主重启（已随 2026-09-15 重启载入）；**活体事件验证纳入内核收口后的统一验证 V3**。

### F-7：空 `gate:` 行（**声明了却没给命令**）改为**真拒**（2026-09-15，用户裁「严控勿松」）

- **问题（长期潜伏，非新缺陷）**：exec 层产物写 `gate:` 行但**命令解析为空**时，`lib/state/gates.js` 的 `GATE_EXIT_NO_COMMAND` 分支**长期不可达**——三重遮蔽：① 正则 `^gate:\s*(.+)$` 的 `(.+)` 要求 ≥1 字符 ⇒ 空声明零命中；② 收集层 `cmd.length===0 ⇒ continue` 再剔除；③ 判定层 `if(!det.declared)` 早退**先于**空判 ⇒ 该码永不执行；注释却声称「命令解析为空仍走 GATE_EXIT_NO_COMMAND」（**注释漂移 = 第二重「写了不生效」**）。实测为**静默放行**。
- **改动**（`lib/state/gates.ts` 单文件；`store.js`/`command-exec.js` 判定未碰）：新增 `GATE_EMPTY_LINE_RE=/^gate:[ \t]*$/m`（**`[ \t]` 非 `\s`**，防跨行误吞）+ `detectGate.emptyCommand` 位 + `!det.declared` 早退**之前**首判短路 ⇒ 空声明直接拒；删原死码三行（保留 `:786` 历史痕迹注释「曾长期不可达，F-7 起真正生效」）；**`declared` 语义一字未改**（兼容锚点）；顺带把 `GATE_OFF_LINE_RE` 的 `\s*` 收紧为 `[ \t]*`（零行为变化）。
- **语义边界（必须区分）**：**空声明 ⇒ 拒**（`gate.exit_blocked` + lane 留 review）｜**完全未声明 ⇒ 仍零感知**｜`gate: false` ⇒ 走显式关闭留痕（`command-declared-off`），**不拒**。
- **连带 fixture**：**删断言数 = 0**（3 处反转 + 用例名 + X-1 关账）；`gates.test.js`：**F-7 净增 +14（纯新增，唯一改动块 `@@ -403,0 +494,55 @@`），文件当前 203**——注：与「改前 189」的差额含**前置批次**（r2/V9）删除的 7 行，非本批删除（audit 独立判定）；新增 G11 空声明端到端拒 / G12 未声明零命令门族事件、`gate-techdebt-red.test.js` 3 条断言反转、`command-exec.test.js` 补「仅单元层可达」注释。
- **双向护栏（真跑留档）**：A 向「改坏短路 ⇒ G11 + R-27 转红 → 回退复绿」；B 向「误置位 ⇒ G10 + G12 + R-27(a) 转红 → 回退复绿」；正则探针 13/13（R7 跨行风险 MISMATCH=0）。
- **验证**：**拒载反例真调用**（空声明/尾随空格 ⇒ `ERROR GATE_EXIT_NO_COMMAND` + lane `review` + `gate.exit_blocked` 恰 1 条）；定向 5 文件 **132 tests / 128 pass / fail 0 / todo 4 / exit 0**；`gate:` 行在**产物根**与**仓库根**双 cwd exit 0（92/88）；`npm run build` 后产物同步（未手改 `.js`/`.d.ts`）；**全量判定归 audit lane**。
- **不追溯（U5）**：**旧批**中未 merged 的空声明 lane **不追溯**——此前后续将以「静默通过」变「拒 + 留 review」，属**有意的正向收紧**（符合「严控勿松」）；已终态批不受影响。
- **规格偏差（如实）**：规格建议护栏 G12 用 `/^gate\./` **全族**零事件，实测不成立（`gate.passed` 在 merged 恒有；jiufeng 下另有 B2 的 `gate.contract_missing` 契约首触留痕，二者均**非命令门**）⇒ e1 已等价收紧为「**命令门族零事件** + 其余 `gate.*` 仅白名单该两项，出现第三种即红」，**护栏强度不降**。
- **生效**：引擎代码 ⇒ **需宿主重启一次**。

### F-4：`flows.complete` 升为 `LAYER_UNKNOWN`（**blocking 拒载**）（2026-09-15，用户裁决 Q-D=A「严控勿松」）

- **改动**：`lib/assembly/team-asset.js:48` 的 `FLOW_SECTIONS` **移除 `'complete'`**（同处注释同步为「已清退」口径）。允许层集自此**恰为三段：`plan` / `exec` / `audit`**。
- **行为变化（须读，按用户「严控勿松」裁决执行）**：团队资产若声明 `flows.complete` ⇒ **整份资产拒载**（码 `TEAM_ASSET_LAYER_UNKNOWN`、`severity='blocking'`）——**不降为告警、不加兼容分支、不豁免、不追溯旧批**；处置 = **删除该段**（四个内置团队在 legacy 清退时已删 ⇒ 零回归）。
- **连带 fixture**：**删断言 0 / 断言反转 1 / 新增 19**；`test/audit-contract-gate.test.js` 采「**活证据保活 + 废键证据面迁为拒载反例**」双轨（`:176` 的 `GATE_COMPLETE_AUDIT_FAILED` 断言逐字保留——其语义正是「`verdict` 是唯一真源」；原 legacy 键面迁为新用例断言整份拒载），避免以「删键了事」造成**静默证据丢失**。
- **双向护栏（实测）**：临时把 `'complete'` 加回 ⇒ **恰好 3 条用例转红**（46/43/3，exit 1）；回退后 **46/46 exit 0**。
- **验证**：定向 6 文件 **65/65 exit 0**；A5-L2 47/47；A7 `node scripts/check-team-assets.mjs` 四团队 **PASS**；**全量（权威跑，audit lane 独立复跑）1251 / pass 1247 / fail 0 / todo 4 / exit 0**（e1 自报的 1248/1244/0/4 为 `--test "test/*.test.js"` **子集口径**，属文件集差异、非回归）；`gate:` 行在**产物根**与**仓库根**双 cwd exit 0，并以引擎真件 `detectGate`+`runCommand`（cwd=产物根）实跑 `COMMANDS=1 / EXIT=0`。
- **生效**：引擎代码 ⇒ **需宿主重启一次**。
- **登记未清**：`team-asset.js` 死码（原 :274，现 :282）**本批不清**（精准修改）；`docs/**` 经扫描**无需改动**（对 `complete` 的 24 处命中全属「批次阶段 / complete 门禁」语义）。

### `idle` 语义纠正：**字面意义的「空闲态」**（2026-09-15 用户澄清；代码行为不变）

- **澄清（用户口径）**：`idle` **不是崩溃态**，是**字面意义的空闲态**——成员当前无在跑动作；`idle → running` 是**返工 / 续跑 / 重派**的**常规入口，可随时调用**，不必先有「故障」。进程重启把在途 lane 落回 `idle` 只是它的**一个来源**，不是它的定义。
- **纠正面（只纠正措辞与定位，判定与行为零改动）**：
  - 引擎：`lib/state/gates.ts`（G-1 注释 + **运行期可见的 `gate.escape.reason` 文案** → 「G-1 空闲态不堵：lane 处于 idle（空闲态——返工/续跑可调用；进程重启亦会把在途 lane 落回 idle）…」；mtime 变更性基线注释 2 处 → 「排除 idle 空闲态重派」）；`lib/types/contracts.ts`（`MemberState` 注释 → 「idle **空闲态**（8 值；非崩溃态，返工/续跑可调用）」）。
  - 指引：`presets/jiufeng/references/discipline.md`（§0b G2 边界改「G-1 空闲态不堵」；**新增独立 idle 语义条**：字面空闲、非崩溃态、`idle→running` 为续跑/重派入口）；`presets/jiufeng/agent.cordis.yml`（纪律 `0g` 与 `7`）；`presets/jiufeng/references/manager.md`（3 处）。
  - 文档：`docs/governance-technical.md` 与 `.en.md`（状态图、成员状态操作、G-1 边界、恢复机制、重启冷窗 5 处）；`docs/single-machine-capabilities.md` 与 `.en.md`；`docs/engine-intro.md`（并**顺带修正其中已过时的 G1 表述**——「worker/Manager 子会话继承父档」已按 Q2=B 取消，判据落调用方）。
- **验证**：`npm run build` exit 0；全量 **1242 / pass 1228 / fail 0 / todo 14 / exit 0**（无测试断言旧文案）。
- **生效**：`gates.ts`/`contracts.ts`（含 build 产物，运行期 `escape.reason` 文案在内）与 persona/指引属文本面 ⇒ **需宿主重启一次**在运行会话生效。

### legacy（缺声明回落）**完全清退**（2026-09-15，用户裁决「完全清退，不兼容旧有批次」）

- **批次** `legacy-retire-20260915`（5 lane / 3 waves：`p1` 清退规格 → `e1` 引擎侧 ‖ `e2` 资产侧 → `a1` 验收；team `software-team`，建批即拉起 Manager）。**audit verdict=pass（blocking 0 / followup 5）**；**批已 complete**。
- **引擎侧清退（E-1..E-5）**：`LEGACY_PLAN_CONTRACT` 死常量删除 → `ENGINE_BASELINE_PLAN_SECTIONS`（`flows.js`）唯一真源；plan 契约缺声明分支正名（行为零变化）；`produceFieldOf` **null 化**（消除 `degrades{kind:'produce-field-widened'}` 的虚构字段名误报，非判定面）；**complete 双键收敛**——`verdict` 为唯一真源（`gates.ts` 两态 `source`），`flows.complete.require_audit_outcomes` 校验移除（校验器保留 `complete` 合法 + `continue` 短路，方案 B）；`enforcesConsumeEntry` 死函数删除 + 全部「回落 legacy」措辞正名。
- **资产侧清退（E-2）**：四个内置团队资产（software/design/research/writing-team）的 `flows.complete.require_audit_outcomes` 段**整段删除**（每文件恰 −64B 纯删除）；`audit_contract.verdict` 真源全保留。
- **总语义（第一硬约束，已实测守住）**：**引擎基线 = 唯一默认**，**新建批次行为零变化**——a1 以自写 18 条探针做「当前引擎 vs 基线回滚副本」双引擎对照：**15 条判定面双引擎同判（零翻转）**，3 处差异全为清退动作本身（produceFieldOf 回落、degrades 误报、资产 complete 段）。**旧批次不兼容、不追溯**（按用户裁决）。
- **验证**：全量 **1236 / pass 1222 / fail 0 / todo 14 / exit 0**（Leader 独立复跑一致；+1 = 规格点名的**正向清退用例**，非放水）；两条 lane `gate:` 命令在产物根与仓库根**四跑全 exit 0**；改动物对账**越界 0**（14 文件基线 MANIFEST 逐条对上，`store.js`/`gates.test.js`/`contract.test.js`/`gate-techdebt-red` 逐字节零改，四 yml 恰 −64B）；`lib/**` 内 `LEGACY_|require_audit_outcomes|enforcesConsumeEntry` **代码零命中**（仅存历史注释）。
- **文档同步**：`discipline.md`（码表 `verdict` 行、audit 边界行、teamsRoot 两处、附录 A.2「消费点实况」——`consume_field` 标注为 S19① **已接线**、`audit_contract` 三键消费点写明）、`lib/assembly.js` / `lib/tools/core.js` 注释正名。
- **followup（a1 登记，不阻断）**：F-3 `scripts/probes/flex-assembly-audit.mjs:52` 废键声明（探针脚本，无害）；F-4 方案 A（`FLOW_SECTIONS` 移除 `complete`）独立清理项；F-5 a1 未直接复跑 build（以产物同刻 mtime + 套件背书判定）。
- **生效**：`flows.js`/`gates.ts`(→build)/`assembly.js`/`core.js` 属引擎代码 ⇒ **需宿主重启一次**在运行会话生效。

### `config.ratchet` 热更守卫：重启生效面显式化（2026-09-15，用户裁决 Q-9=A，G-3 收口）

- **问题（audit G-3）**：`config.ratchet` 位列热更顶层键白名单（`lib/hot/config-watch.js` `ALLOWED_TOP_KEYS`），但 `applyConfigChange` **无 ratchet 分支** ⇒ 热写「被接受却不生效、非法也不校验」——典型「写了不生效」的假动作面（A-① 接线后该键已真实生效于装配期，此面更显眼）。
- **裁决与落地（按推荐 A，机制按意图修正）**：原表述「移出热键」在机制上不成立——`ALLOWED_TOP_KEYS` 是 runtime.json 顶层键**合法性白名单**（boot overlay 同用），移除会让 `ratchet` 整键被拒（破坏启动期配置）。故按**意图**落地：`lib/hot/config-watch.js` 新增**纯函数守卫 `ratchetHotGuard`**（变化检测 + `loadRules` 当场校验 + 文案），`lib/index.js` 的 `applyConfigChange` 增 **⑥ 分支**：ratchet 变化 ⇒ **warn「需重启生效（热更不应用）」**；非法 ⇒ **warn「非法 + 重启时装配将失败」**（`loadRules` fail-closed 语义不变，重启仍会失败——守卫只负责让用户提前知晓）。`ALLOWED_TOP_KEYS` 保持含 `ratchet`（合法启动期键）。
- **测试**：`test/governance-hotconfig.test.js` 新增 T8–T11（无变化零噪音 / 合法变更文案 / 非法变更文案与原因 / 删键回落默认表仍告警）。全量 **1235 / pass 1221 / fail 0 / todo 14 / exit 0**。
- **生效**：`lib/index.js` / `lib/hot/config-watch.js` 为手写 JS ⇒ **需宿主重启一次**在运行会话生效。

### 引擎核心待办 A 类落地：`config.ratchet` 生产接线 + 台账漂移修正（2026-09-15，用户指令「按 wave_plan 拆分成小项并行」）

- **批次** `core-pending-a-20260915`（5 lane / 3 waves：`p1`‖`p2` → `e1`‖`e2` → `a1`；team `software-team`；`assembly={managerPlan:'raise', auditLane:'a1'}`，**建批即拉起 Manager** 并登记）。audit lane **verdict=pass**（`blocking` 0 / `followup` 8）。
- **A-① `config.ratchet` 生产不可达（已修）**：装配点 `lib/index.js` 的 `createStore(root, { rules: loadRules(config), onStateChange })` —— **必须传整份 config**（`lib/state/machine-rules.js` 内部自取 `config.ratchet`；传子对象会静默退化为默认表 = 没修）；读点 `lib/state/store.js` 的 `rules ?? loadRules()` 形态**一字未改**；**缺省零差异**（无 `ratchet` / 空对象 / `{}` 三者与 `schema` 常量**同引用**）。台账条目（`gates.ts`）由「🔴 域外未接线」改述为 `status:'wired'` 并保留可读性。
  - **⚠ 行为变化（必读）**：**非法棘轮配置**（越界键 / 放宽迁移且未 `allowRelax`）由「**静默忽略**」变为「**装配期 throw**」（`loadRules` 语义 fail-closed：棘轮不可绕过）⇒ 配置写错会让插件**加载失败**（错误信息明确，如 `ratchet memberRules: relaxing transition "pending -> bogus" is not allowed`）。回滚 = 删 `rules:` 一行。
- **A-② 台账漂移（已修）**：`lib/assembly/team-asset.js` 的 `UNWIRED_DECLARATIONS` **删除 `consume_field` 整条**（并清 `declared` 映射死键、原位留历史注释）——**只把 `status` 改 `'wired'` 无法消除误报**（读端 `unwiredDeclarationsOf` 只按「该键是否被声明」过滤，不看 `status`）；`lib/assembly/flows.js` 两处失实注释（「已备但未接线」）同步为「已接线（S19①）」。事实基础：`consume_field` 自 **S19①** 起已由 `gates.ts` entry 门 `consumeFieldNameOf` 消费。四内置团队 `unwired` 由 `[consume_field, state_machine]` → `[state_machine]`（`gate_status.gateStrength.unwired` 不再误报）。
- **R-15 复活（P-1 口径）**：`test/gate-techdebt-red.test.js` 的 `test.todo` R-15 改为真实用例；白名单 `CONSUME_FIELDS=['consume']` **未扩**（`inputs` 构造在合规资产下不可达一事已在测试体内注明，避免假契约）。同文件顺带**cwd 无关化**（`PKG_ROOT` 基准；`process.cwd()` 依赖清零）。
- **新增** `test/ratchet-wiring.test.js`（7 用例）：判别性设计（无 `ratchet` ⇒ `GATE_ENTRY_MISSING`；收紧后 ⇒ `invalid member transition: pending -> running`，**码字可区分**，避免「只断言抛错」的恒绿假过）+ 缺省零差异（引用相等）+ 非法配置 fail-closed + 接线形态守卫；子进程隔离 `USERPROFILE`/`HOME`/`DSH_HOME`。
- **命令 gate 的 cwd 契约（第二批实测坑，已入纪律 §0b 六）**：`gate:` 行在**批次产物根**执行 ⇒ 写成绝对路径**还不够**，**被调脚本自身也不得依赖 cwd**（`process.cwd()` 相对夹具必 `ENOENT` → 结算被 `GATE_EXIT_NONZERO` 拒、lane 留 review）；交付判据 = 在**产物根**与**仓库根**各跑一次**均 exit 0**。本批 e2 因此被门禁拦下一次并返工（`review → running → 重跑 gate`）。
- **验证（Leader 独立复跑 + audit 独立取证）**：全量 **1231 / pass 1217 / fail 0 / todo 14 / exit 0**（基线 1224/1209/0；差量闭合 = +7 新用例、R-15 todo→pass）；两条 lane `gate:` 命令在产物根与仓库根**四处 exit 0**；改动物对账**无越界**（30 项 tsc 回拷产物与新鲜构建逐字 `SAME=30 / DIFF=0`）。
- **生效条件**：`lib/index.js` / `lib/state/store.js` / `lib/assembly/*` 为手写 JS（免构建）；`lib/state/gates.ts` 属源、已 `npm run build` ⇒ 本批**需宿主重启一次**方在运行会话生效（用户口径：不自行重启）。**宿主级加载冒烟未做**（受禁令，列为 followup）。
- **audit gap-list（8 条 followup / 0 blocking，如实登记）**：G-1 规格未回写 `core-spec`（`pending:['running']` 不构成收紧，e1 已按代码订正为 `pending:['failed']`）；G-2 注释行号 off-by-one；**G-3 `config.ratchet` 仍列 `lib/hot/config-watch.js` 的 hot 顶层键，但 `applyConfigChange` 无 ratchet 分支 ⇒ 热更不生效、非法热写不校验**（待裁决）；G-4 本条目即 CHANGELOG 补记；G-5 宿主级冒烟未做；G-6 e2 自述「`process.cwd()` 计数 0」实为 1（`:87` 注释内）；G-7 A-③ 清单缺「默认值/不裁决后果」行；G-8 三个 `.ts`/产物文件无备份级 diff（无基线）。

### G1 收窄（Q2=B）+ 镜像只升不降（Q4=B）（2026-09-15，用户裁决）

- **G1 收窄：成员仅作为会话存在，不可写成员状态**。`lib/tools/core.js#assertMemberActionTierC` **取消父档继承**（原实现允许 worker / Manager 子会话经 `header.parentSession` 继承 Leader 的 C 档）：
  - **建批（`wave_plan`）**：只认**本会话自己的 C 档** —— worker / Manager 子会话一律建不了批（B 档仅承载单个「单步独立任务」，不进 `wave_plan`）；
  - **成员状态（`member_status` / `member_settle`）**：仅 **调用方会话自己 C 档（Leader）** 或 **该批已登记的 Manager 会话**（`batch.manager.agentId`；宿主口径 = continuable 的 `subagentId = childId = 会话 id`）可写；
  - **判据落调用方**而非批归属会话 ⇒ 「worker 借用 C 档批会话的 `session` 参数借道」同样被拒（原实现会误放行：命中批归属会话的 C 档）。
- **镜像只升不降（Q4=B）**：`assign_check` 在「显式 `session` ≠ 执行会话」时把评估镜像到执行会话（guard 兼容）；现**只升不降**——执行会话自身档位更强（rank `C > B > A`）时**跳过镜像**（`notice` 回显「镜像跳过」、不写 `mirroredTo`），保留其 `lastAssign` / `pendingBatch` 不动。动机（实测）：为写「他会话」B 档夹具而调 `assign_check`，镜像把 Leader 自身 C 档覆盖为 B。
- **测试**：`test/tools.test.js` 原「继承正例」改写为新契约（worker 不继承 ⇒ 建批拒；非 Manager 子会话借 C 档批会话 `session` 仍拒；该批已登记 Manager 会话放行），新增 Q4 镜像用例（只升不降 + 等档照常镜像的反向对照）。聚焦 **27/27**、全量 **1224 / pass 1209 / fail 0**。
- **文档**：`presets/jiufeng/references/discipline.md`（§0 G1 收窄段 + §0a 镜像只升不降 + 附录 A.3.1）、`presets/jiufeng/agent.cordis.yml`（纪律 `0` / `0a`）、`presets/jiufeng/references/manager.md`（§4 成员面写权边界）、`skills/software-team/SKILL.md`（纪律要点）、`docs/governance-technical.md` 与 `.en.md`。
- **生效条件**：`lib/tools/core.js` 属引擎代码（纯 JS）⇒ **需宿主重启一次**方在运行会话生效（同「引擎改动重启前不生效」实测口径；用户口径：不自行重启）。
- **Q3（同批裁决）**：**旧引擎拉起的批次无关**（不追溯、不迁移）；**legacy 由后续任务统一清退**（登记见 `docs/legacy-fallback-inventory-*` 的退场口径）。

### G1「档位 × 工具面」+ G2「建批即拉起」硬门禁（2026-09-14，用户裁决：G1=B 严格 / G2=A）

- **现象与根因（用户提出）**：难度门禁只管住 Leader 自己的执行型工具面，**管不住「借成员面工具绕开档位」**——A/B 档会话照样能 `wave_plan` 建批、`member_status` / `member_settle` 写成员状态。次生根因更重：Leader 以 A/B 档手工 `subagent` 逐个派单 + 手工改成员状态 ⇒ **批次落在 worker 会话名下**（装配声明 / Manager 拉起 / audit lane 责任全部错位），与「成员大规模并行」的执行模式相悖。另一条时序缺口：`managerPlan` 缺省已归一到 `raise`，但「拉起」当时只有收口告警（且仅 exec lane≥3 的批）⇒ **实为自觉**。
- **G1 = 工具面前置断言（严格档）**：新增 `assertMemberActionTierC(store, sessionId, exec, action)`（`lib/tools/core.js`），`wave_plan` / `member_settle` / `member_status` 三处调用前要求当前会话已写入 `difficulty: 'C'`——**未评估与 A/B 同罚**，分别拒 `GATE_BATCH_REQUIRES_C` / `GATE_MEMBER_REQUIRES_C`；worker / Manager 子会话经 `header.parentSession` **继承父档**（否则「建批即拉起」的 Manager 连自家批都结算不了）。**设计取舍**：未做成 guard 规则（那一层只拦 Agent 调用路径、代价更小）——选工具面强制，任何调用者都绕不过去，代价是引擎级测试须显式模拟「C 档会话建批」这一前置事实。
- **G2 = entry 门禁前置（事前拦）**：`lib/state/gates.ts#checkEntryGate` 增判——`assembly.managerPlan === 'raise'`（含缺省归一）的批，**第一个 exec 层 lane 派发前**必须已登记 `batch.manager`（`batch_phase({ batchId, manager: { agentId } })`），否则拒派 `GATE_MANAGER_NOT_RAISED`。边界：只拦 **exec** 层（plan 层可先出设计与计划）；判定走 `reject()` ⇒ **继承 G-1「idle 恢复永不可堵」**（`idle` lane 的崩溃重派降级为告警放行 + 留痕）；显式 `leader-direct` 的批不受此门。收口告警 `gate.manager_missing` **保留**为事后核对面（两者同源 `managerPlan`）。
- **码表**：`GateErrorCode` 增 `GATE_BATCH_REQUIRES_C` / `GATE_MEMBER_REQUIRES_C` / `GATE_MANAGER_NOT_RAISED`。
- **纪律与文档**：`presets/jiufeng/references/discipline.md`（§0 增「档位 × 工具面一致性（G1）」；§0b 一 增「建批即拉起（G2 硬门禁）」；§0g 标「已由 entry 门禁硬拦」；附录 A.3.1 新增 + A.4 增一行）；`presets/jiufeng/agent.cordis.yml`（纪律 0 增 G1 一句；0b / 0g 增 G2）；`presets/jiufeng/references/manager.md`（§1 拉起时机增「该时序已由 entry 门禁硬拦」）；`skills/software-team/SKILL.md`（纪律要点增「成员面动作只认 C 档」+ 任务包不含建批/管成员职责）；`docs/governance-technical.md` 与 `.en.md`（§4 增 G1 / G2 两段）；`docs/engine-intro.md`（难度路由行补 G1/G2）。口径原话：**成员协作只有一条轨道** = 评 C → 建批 → 建批即拉起 Manager → 由 Manager/Leader 派发与结算。
- **存量影响面（实测）**：扫描 `~/.dsh/jiufeng/sessions/**/batches/*.json`——批总数 765、`running`/`paused` 71、声明 `raise` 63、其中未登记 Manager 51；**唯一可能被拦的形态（在途 + 未登记 + 有 pending lane）= 4 个批，且其 pending lane 全在 audit 层** ⇒ **G2 实际阻塞存量批 = 0**（那 4 个批若将来重开 exec lane，需一行 `batch_phase(manager=…)` 解封，属既定语义）。
- **验证（Leader 独立复跑）**：`npm run build` exit 0；全量测试 **1223 / pass 1208 / fail 0 / todo 15**（改动前基线 1214 / 1129 / 70 ⇒ 净增 **9** 条 G1/G2 用例；新增 `test.skip`/`test.only` = 0，用例总数不减）。红证据由 worker 以「临时停用门禁 → 单跑取红 → 逐字还原」取得（`lib/tools/core.js` 还原后 sha256 `03e890a2…6ad0` 与备份一致，`lib/**` 内无探针残留）。测试面改动：17 个 `test/**` 文件——`test/helpers/gate-fixture.mjs` 新增共享种子 `assessC`（走 `writeGovernance`，与 `assign_check` 同一落盘函数）与 `registerManager`（委托 `store.markManagerRaised`，即 `batch_phase({manager})` 唯一入口），16 个套件在 harness/`setup` 补种子、3 处补 Manager 登记；`lib/**` 语义**零改动**（未通过改断言/改实现绕过任何红）。
- **实机生效性（重启后实测，4/4 PASS）**：重启**之前**两道门禁在运行进程里均**未生效**（探针①未评估会话建批成功；探针②`raise` 批未登记 Manager 派 exec lane 返回改前码 `GATE_ENTRY_MISSING`，而构建产物 `lib/state/gates.js` 内已含 `GATE_MANAGER_NOT_RAISED` ⇒ **非构建缺失、是进程未重载模块**）。**用户重启后复验**：① 未评估会话建批 → 拒 `GATE_BATCH_REQUIRES_C`；② `raise` 批未登记 Manager 派 exec lane → 拒 `GATE_MANAGER_NOT_RAISED`；③ 登记 Manager 后同 lane 拒因回落到 `GATE_ENTRY_MISSING`（G2 已放行）；④ lane `idle` 重派 → 降级放行 + 事件 `gate.escape{kind:'idle-recovery-passthrough'}`，**移除 Manager 后同样降级**（`reason` 内可见被跳过的 `GATE_MANAGER_NOT_RAISED`）——G-1「恢复路径永不可堵」在 G2 上实测成立；⑤ **B 档分支（用户原始症状）**：B 档会话调 `wave_plan` → 拒 `GATE_BATCH_REQUIRES_C`（`本会话档位 = B`）、调 `member_status` → 拒 `GATE_MEMBER_REQUIRES_C` ⇒「B 难度还去建批」已被物理堵死。
- **顺带修复（O-18，本轮实机复验发现）**：`lib/state/store.js` 的 entry 门禁**抛错文案**旧写法 `g.missing ?? g.problems ?? []` 会被恒为数组（G2 下为空 `[]`）的 `missing` 吞掉 `problems` ⇒ 抛错只剩 `Error: GATE_MANAGER_NOT_RAISED`（**留痕事件里 `problems` 是全的**，仅抛错侧丢提示）。改为**取非空者**，一并修好 P1 `GATE_AUDIT_CRITERIA_MISSING` 的同类形态；`test/tools.test.js` 的 G2 负向断言同步**收紧为必须带提示**（`/GATE_MANAGER_NOT_RAISED: .*batch_phase.*登记再派 exec/`）。验证：聚焦 **26/26**、全量 **1223 / pass 1208 / fail 0**；**待下次宿主重启生效**。
- **口径修正（如实）**：本轮之前记录的「G1 已在 live 会话确认生效」**与本次探针矛盾**，复核判为早先那条结论**不可靠**（很可能是把难度 guard 的「未评估即拒执行型工具」误读为 G1）——以实机探针为准。

### 单选遗产全面清除：`preset` 一律多选 / 数组（2026-09-14，用户澄清）

- **澄清（用户口径）**：`compose` 是「护栏配置原本单选」时的不合理设计产物——单选无法表达叠加，才需要一个"全量合并项"。故本轮把**单选遗产整体清除**，护栏配置统一为**多选 / 数组**语义。
- **引擎**（`lib/governance/config.ts`）：`preset` 的**单值字符串形态废除**——`preset: "l1-sensitive"` 判形态非法（`normalizePresetRefs` 报错 → resolve 回退空表 + warn，warn 文本给出数组写法指引）；**唯一合法形态 = 注册 id 数组**。
- **写通道**（`lib/webui/runtime-config.js`）：单值字符串 → `invalid-value`（错误信息含 `must be an array` 与数组写法），不再按 id 合法性放行。
- **面板**（`lib/panel/gov-config.js`）：`formPresetOf` 只接受数组；单值字符串 / 含未注册 id / 其它形态一律走 `{ custom }`（原文保留 + 警示），保存时由后端形态校验拒绝并回显——**不再有任何单值或 compose 自动迁移**（上一轮的 compose 一次性迁移映射一并删除）。
- **测试同步**：48 处单值点位改数组 + 3 处语义用例改写（`governance-preset-loader` T3-2 → 「单值形态废除回退空表 + warn」；`webui-runtime-config` 校验-5 → 「单值即便 id 合法也判 invalid-value」；`webui-preset-options` W2 → 「compose 迁移分支须删除」并新增 W5「formPresetOf 只接受数组、非数组不自动包装」）+ 2 处断言期望改数组（`api-config` / `webui-runtime-config` 的 `written…preset`）。
- **文档**：`docs/webui-governance-config{,.en}.md`（旧组合项段改写为「不做自动迁移 + 单值废除」）、`presets/hook-rules/README.md`、`cordis.patch.yml`（示例统一数组）。
- **验证**：`npm test` **1118/1118 fail 0**；最小探针实测 `validateGovernancePayload({preset:'l2-resource'})` → `ok:false / invalid-value`、`{preset:['l2-resource']}` → `ok:true`；面板产物重新合成（`assemble-panel.mjs`，1540 行 / 7 段）。
- **代价与影响（如实）**：本机既有配置为数组（`~/.dsh/jiufeng/config/runtime.json` = `["l2-resource","l3-tool-ban"]`），无现网影响；**他处若有单值 `preset: "xxx"` 旧配置，升级后会失效**（引擎回退空表 + warn；面板保存被拒并提示改数组）——这是「全面清除单选遗产」的已知代价。
- **顺带实证（L3 已生效）**：本轮一次带 `*>` 重定向的 pwsh 命令被 **L3-W01 当场 DENY**（正文含「改用 edit / write」+ 规则引用 `L3-W01（preset l3-tool-ban）`），随后改用管道形态完成验证——写通道路由按设计工作。

### compose 组合项彻底删除：注册项 4 → 3（2026-09-14，用户裁决「compose 注册项也删」）

- **删除面**：`presets/hook-rules/compose.json` 文件删除；`PRESET_IDS` **4 → 3**（`l1-sensitive` / `l2-resource` / `l3-tool-ban`）——`preset: "compose"` **不再是合法引用**（写通道以 `unknown-preset` 拒绝；引擎装载判未知 id → **回退空表 + warn**，宁空勿半）。组合一律由**多选 / 数组引用**表达。
- **同步面**：`lib/governance/preset-loader.ts`（枚举 + 三处注释）、`lib/governance/config.ts`（未知 id 提示文案）、`lib/index.js` 与 `lib/governance/wiring.js`（注释）、`cordis.patch.yml`（preset 注释）、`presets/hook-rules/{README.md,l3-tool-ban.json}`、`docs/webui-governance-config{,.en}.md`、测试 5 文件（`preset-rules`：去 COMPOSE 加载 / P-1 / P-1b / 两处循环 / V9 改「废除声明」断言；`governance-preset-loader`：L-1 / L-2 / L-4（坏目录计数 4→3）/ T3-3 / T3-6（改用同 id 引用两次构造重复）/ T3-8 / T3-9；`api-config` catalog mock；`webui-runtime-config` preset 值域用例；`webui-preset-options` W2 措辞）。
- **保留面（救生索，非注册项）**：面板 `formPresetOf` 的 `'compose' → l1+l2` **一次性回显迁移**保留——旧 runtime.json 里的 `preset: "compose"` 在面板回显为两项勾选，保存即归一为合法数组；若不做该迁移，旧值会落到 `{ custom }` 分支并被后端 `unknown-preset` 拒。
- **影响面与不可逆性（如实登记）**：本机既有配置不含 compose（`~/.dsh/jiufeng/config/runtime.json` 现值 `preset: ["l2-resource"]`），故本次删除无现网影响；**若他处仍有 `preset: "compose"` 的旧配置，删除后该引用会静默回退空表（仅 warn 留痕）**——这是本裁决的已知代价。
- **验证**：`npm run check`（tsc）+ `npm test` 全量 + 面板重新合成（`node scripts/assemble-panel.mjs`）；`grep` 全仓复核 compose 仅剩「已废除」声明与一次性迁移映射两类命中（`docker-compose` / 英文 composed 为无关词）。

### 治理配置面板：规则集全部多选 + compose 组合项语义退场（2026-09-14，用户裁决）

- **L3 未出现在面板的根因**：面板多选行由源分段 `lib/panel/gov-config.js`（合成进 `lib/client.js`）的 `presetOptionIds()` 硬编码为两项 `['l1-sensitive','l2-resource']`——引擎侧 catalog 已含 `l3-tool-ban`，但面板不认。已改源分段为三项（L1 敏感 / L2 资源 / L3 工具黑名单平级多选）。
- **compose 语义退场（面板层）**：面板不再有「组合项」概念（组合 = 勾选叠加本身）；`gov.preset.compose` 文案键删除，原「全勾 = L1+L2 全量组合」摘要行改为通用合计行「已选 N 项 · 合计 M 条」（新增 `fmtN2` 双占位符格式化 + `gov.preset.total` 中英文案）。面板对旧值 `preset: "compose"` 保留**一次性回显迁移**（→ l1+l2 两项勾选），避免旧配置因选项消失而无法保存。（本轮当时 compose 尚在注册表内；**随后按用户裁决「compose 注册项也删」彻底删除**，见下一条。）
- **改源不改产物（纪律修复）**：`lib/client.js` 是 `lib/panel/*.js` 7 段经 `scripts/assemble-panel.mjs` 合成的产物（`test/client-sync.test.js` 逐字节一致性守护）。本轮先误改产物被该测试当场拦下（2 例失败）→ 改为「改源分段 → 重新合成」的正当路径（合成 1541 行 / 7 段）。
- **新增回归锚点**：`test/webui-preset-options.test.js`（W1–W4 源码级契约断言）——① 选项集合 = 三个平级规则集且**必须含 `l3-tool-ban`**（防面板再漏规则集）；② 选项集合不得含 `compose`，且一次性旧值迁移映射须保留；③ zh/en 文案键齐备（l1/l2/l3/total）且 compose 文案键已删；④ 合计行为通用实现（不得以「恰好两项」判定）。
- **文档**：`docs/webui-governance-config.md` / `.en.md`「规则预设」段重写为多选语义（含旧 compose 项说明 + 第三类判定面提示）。
- **验证**：`node --check lib/client.js` exit 0；`npm test` **1117/1117 fail 0**（原 1112 + 5）。
- **如实记录（flaky 观察，未处置）**：一次全量跑出现 `test/audit-contract-gate.test.js`「glob 回归：`plan/**` 不再命中 exec 路径」1 例失败，而该文件单跑 8/8 全绿、且本轮改动不涉 `lib/assembly/flows.js`；复跑全量即 1117/1117。判为全量并发下的偶发（用例为纯函数断言；实现含两条防放宽规则，见 `lib/assembly/flows.js:237-259`），留痕待观察，未做改动。
- **生效条件**：面板 UI 是客户端 bundle，改动**需重启宿主一次**方可加载；引擎侧 `l3-tool-ban` 的 presetTable 在宿主 boot 时装载（用户已重启过一次）⇒ 现可**直接**在 `runtime.json` 引用 `l3-tool-ban` 而无需再重启。

### cage 护栏第三类「工具黑名单」：写通道路由（2026-09-14，用户裁决 Q1=A / Q2=A / Q3「仅护栏禁止修改或写文件」/ Q4「仅护栏可热加载、与执行引擎无关」/ Q5=B）

- **新增第三类判定面 `toolBan`（工具 × 行为）**：与参数级 `rules` 并列的判定来源。首批条目 `L3-W01`（preset `l3-tool-ban`）：禁用 `pwsh` 的 `file-write`——**写通道路由**：文件写走 `edit` / `write` / `str-replace-editor` 等在册工具，不经 shell 自建写路径落盘（Windows 下 `>` 重定向与 `Set-Content` / `Out-File` 可能写入 GBK 或带 BOM，破坏文件编码头且不可逆）。
- **判定内核**（新增 `lib/governance/tool-ban.ts`，纯函数零依赖）：引号掩码（引号内的 `>` / cmdlet 名不参与判定）→ 剥流合并（`2>&1` / `2>$null` 不算落盘）→ 全串写指示符（重定向 / 写动词 cmdlet / `-OutFile` / `find -exec`）→ 分段取段首写命令名 → 其余放行；未闭合引号 fail-closed。**收窄口径**（Q3/Q6）：只拦「修改或写文件」这一类动作，执行 / 构建 / 测试 / 包管理 / 只读命令一律放行（`npm run build`、`npm test`、`node x.mjs`、`git status`、`Get-ChildItem` 不命中——拦构建会断裂常规开发闭环）。
- **裁决接线（零分类器改动）**：`matchToolBan` 命中产出 `Violation` + `ruleRefs`，与参数规则命中**同列汇入**同一 `classifyViolation` → 缺省 `hard` → **DENY（P2）**；拒绝正文携带纠正文本「文件写请改用 edit / write / str-replace-editor 等在册工具」。收据 / 事件桥接 / 拒绝可见性链路天然复用（`ruleRefs` 前缀 `L3-` → preset 归属 `l3-tool-ban`，`wiring.presetOfRuleId`）。
- **与执行引擎无关**（Q4）：判定在护栏内**自带一份收窄的写动作判定**，**不 import / 不修改** `lib/tools/readonly.js`（任务难度门禁「只读侦察面」在执行侧使用的共享判定）——两处判定独立、互不影响。
- **双生效通道**：① **热加载主力**（`<root>/config/runtime.json` 的 `governance.hook.toolBan`；`toolBan` 进 resolved 快照 ⇒ 既有 remount JSON 比较器**零改动**感知变化 → dispose + 重挂，**免重启**）；② 随包 preset `l3-tool-ban`（注册 id 枚举 3 → 4，**其后按用户裁决复归 3 项——compose 组合项废除**；`preset` 引用键需 boot 装载一次）。L3 为独立判定维度，与参数级规则面（L1/L2）任意叠加（`preset: ['l1-sensitive','l2-resource','l3-tool-ban']`）。
- **装载面**：`loadPresetTable()` 返回**双表**（`table` 参数级规则 / `banTable` 第三类）；`presetCatalog`（WebUI `GET /config presets`）两表并计；新增校验 `validateToolBanEntries`（形状）与 `validateToolBanTable`（全表 id 唯一，与 `validateRuleTable` 同纪律——宁空勿半，任一错误两类面一并回退空表）；`toolBan` 行为面合法值域 `TOOL_BAN_BEHAVIORS = ['file-write']`。
- **文件面**：新增 `lib/governance/tool-ban.ts` + `presets/hook-rules/l3-tool-ban.json` + `test/governance-toolban.test.js`（27 例：F 判定正反成对 / K 裁决接线 / R 装载语义 / A 装配级静态引用与**热加载端到端**）；同步 `lib/governance/{types,config,kernel,preset-loader,index}.ts|js`、`lib/governance/wiring.js`、`lib/index.js`（双表注入 + catalog）、`scripts/copy-ts-built.mjs`（回拷清单加 `governance/tool-ban`）、`presets/hook-rules/README.md`（L3 审阅清单表 + 启用方式 + 边界）、`test/{preset-rules,governance-preset-loader,governance-config}.test.js`、`docs/{guardrails-hook,governance-boundaries,webui-governance-config}.md` 与 `.en.md` 对偶、`CHANGELOG.md`。
- **验证**：`npm run check`（tsc）exit 0；`npm test` **1112/1112 fail 0**（原 1072 + 40）；**宿主同源加载冒烟**（宿主以 `link:` 指向本包源码，加载 `lib/index.js` + `loadPresetTable()` 双表：`l1-sensitive` 12 / `l2-resource` 6 / `l3-tool-ban` 1（compose 其后废除，注册 id 现为三项），errors 空）。
- **边界（如实）**：启发式、**非沙箱**——别名（`sc` / `ni` / `ri` / `mi`）、脚本文件（`pwsh -File x.ps1`）、转义参数、编码方式可绕过；「内联解释器写」（`node -e "fs.writeFileSync(...)"` / `python -c "open(...,'w')"`）**首批不覆盖**（followup：需新增 behavior 值与判定实现）。本面不保证编码安全，真正的编码保证来自 edit/write 工具链本身。
- **未决（待用户）**：**真进程重启冒烟**——Q5=B 本轮不重启宿主，重启后由用户用真实调用验证（如 `pwsh` + `Set-Content` 被拒、`Get-ChildItem` 放行）。

### 难度门禁 v3：无默认档 + 只读侦察面（2026-09-14）

- **难度无默认档（主动写入）**：`assign_check` 新增**必填**参数 `difficulty`（枚举 `A|B|C`）与 `rationale`（判据，≥12 字），难度由 Leader 主动写入并落 `governance.json` 的 `lastAssign{ difficulty, rationale, form, reasons }` + `history` 供审计；缺 `difficulty` 拒 `GATE_DIFFICULTY_INVALID`，缺/过短 `rationale` 拒 `GATE_DIFFICULTY_RATIONALE_MISSING`。旧口径「default to C」「拿不准就填 C」**废止**。
- **布尔特征降为交叉校验 + 有解释的偏离（2026-09-14 用户裁决 B）**：`parallel` / `multiRole` / `gate` / `recoverable` / `needIsolation` 不再唯一决定档位，只作校验输入；引擎据此算出 `derived`。`difficulty` **等于 `derived` 即放行**（`override:false`）；**不等时「有解释才放行」**（`override:true`）——「解释」= `rationale` 含三要素：① 引用具体特征面 ② 例外/反例 ③ 偏离方向与上限，缺任一即拒 `GATE_DIFFICULTY_MISMATCH`（消息列出缺项）；`derived`/`override` 随 `lastAssign` + `history` 落盘（`derived` 由引擎计算 ⇒ 可核事实，读端可辨「哪些档位偏离了机械推导」）。
- **只读侦察面（对标梁神模式两阶段锚定）**：`read` / `glob` / `grep` 与只读 shell 命令（pwsh/bash 的**命令级**判定，`lib/tools/readonly.js`：只读白名单 + 写指示符拒绝 + 默认拒绝）在任何评估状态下放行且**不计数**（不占 `execCallsSince` 评估窗口）；执行型工具（write/edit/非只读 shell/subagent 等）调用前仍须先评估。**边界如实标注**：判定为**启发式、非沙箱**（可经别名/脚本/转义参数/编码绕过），不承诺等价于 OS 级隔离。
- **C+ 档撤销 + 装配面扩面（2026-09-14 用户裁决）**：难度枚举只剩 `A|B|C`；装配**与难度档解耦**——**三层批**（任一 task 声明 layer）建批必须传 `assembly`（由「exec 层 lane≥3」**扩面**；缺则拒建批 `GATE_ROLE_ASSEMBLY_MISSING`，必备判定 = `requiresAssemblyDecl`），`auditLane` 必填且指向 audit 层 lane，**`managerPlan` 缺省 `raise`**（省略即建批即拉起 Manager；确需 Leader 直驱才**显式**写 `leader-direct`）；**收口告警改按声明触发**——`gate.manager_missing` 携带 `{execLanes, managerPlan}`，声明 `leader-direct` 的批不再被误报（旧口径按 lane 数触发属语义矛盾）。
- **guard 门禁 1 收紧**：旧记录（有 `form` 无 `difficulty`）按**未评估**处理，须重评一次。
- **只读判定误拒修复（F1–F4，2026-09-14 复核）**：引号字面量先**掩码**（引号内 `>` / `|` / `;` 不再参与判定）、`2>&1` / `2>$null` 按**流合并**放行、赋值前缀（`$x = ` / `x=`）与 `git` 前缀选项（`-C <dir>` / `--no-pager` / `-P` / `--paginate`）**剥离后**判定、未闭合引号 fail-closed（判定链见 `lib/tools/readonly.js` 头部）。
- **拒收码可观测口径修正**：`difficulty` 枚举/缺参由**工具参数 schema 层**先行拒（`invalid arguments: …`）；`GATE_DIFFICULTY_INVALID` / `GATE_DIFFICULTY_RATIONALE_MISSING` 是同一拒收在**内核显式分支**的命名（勿当外部错误码 grep）——`docs/governance-technical.md`(+`.en.md`) 与 `discipline.md` 三处同步。
- **`leader-direct` 批的 mailbox 口径（缺口补齐）**：无 Manager 消费者 ⇒ worker 回执走**单通道** `report`→Leader、**不写 `outbox`**（persona 0g + `discipline.md#§4` + `manager.md#5.4` + `software-team/SKILL.md` 任务包模板四处同口径）。
- **audit 职责与收敛口径（2026-09-14 用户裁决 A）**：audit 层 = **验收**（按 plan 的验收标准逐条核对），**不做二次评审**；工程团队 `tester→reviewer→supervisor` 是同一语义的三段实现，非工程团队单 audit 角色是单段实现、不因此扩大职责。**收敛判据**：① 验收标准条目 100% 逐条有结论；② 未决怀疑全部落 `gap-list.json`（标 `blocking`/`followup`，过程形式不算载体）；③ `blocking` 收紧为「不满足即无法判定某条标准」；**不得以「继续调查」为默认终点**（audit 不收口 ⇒ `GATE_EXIT_PENDING_AUDIT` 阻塞整批 complete）。落点：`discipline.md#§0k`（新增）+ persona 0k + `acceptance-gate/SKILL.md §2.5` + `software-team/references/roles/supervisor.md`。
- **P1：audit 判据来源锚定（2026-09-14 用户裁决，全局严格、无需声明翻牌）**：① **建批期** —— 三层批中只要有 audit lane 声明了 `consume`，则**至少一条** audit lane 必须消费到 **plan 层产物**（判定：`plan/` 前缀，或由某条 plan lane 在 `produce`/`outputs` 声明；落**批级**，多 audit lane 设计不必每条都消费 spec），否则**拒建批** `GATE_AUDIT_INPUT_MISSING`；② **entry 期** —— audit lane 派发前，其消费的 plan 产物至少一份**正文含裸标题行 `## 验收标准`**（与 `GATE_PLAN_CONTRACT` 同判据），否则**拒派** `GATE_AUDIT_CRITERIA_MISSING`（载荷 `problems`）。**语义依据**：audit 对的是**总体任务验收**，判据只能来自 plan 的验收标准；exec 层的 `reviewer`（消费 tester 结果）是**初步 audit，不外延到总体验收**，不构成替代。落点：`lib/wave-plan.ts`（建批）+ `lib/state/gates.ts`（entry）+ `lib/state/store.js`（拒派载荷兼容）+ `lib/types/contracts.ts`（码表）+ `discipline.md#§0k` 与附录 A + `acceptance-gate/SKILL.md` + `software-team/references/roles/reviewer.md`；既有 fixture 中「audit 只消费 exec 产物」的**漂移按不变量收敛**。
- **P2：audit 职责声明化（2026-09-14 用户裁决 B，fail-closed）**：团队资产新增 **`flows.audit.audit_contract`**（与同层 `contract` **不同键**——后者是产出内容契约 `artifact_globs`/`required_sections`，避免语义混淆）：`{ criteria_from?, consumes_required?, verdict?, checklist_anchor?, exempt?, reason? }`。**建批期门禁**：批次含 audit lane 且解析到团队资产时，**缺键 → 拒建批** `GATE_AUDIT_CONTRACT_MISSING`；**显式空 `{}` 或 `{exempt:true}` → 放行但落留痕告警** `GATE_AUDIT_CONTRACT_EXEMPT`（带 `reason` 则一并记）；**无团队资产**（`generic` / 已退役团队）→ 跳过（零感知）。四个内置团队资产已补实内容声明。**为什么 fail-closed**：缺声明仅告警 = 无人读时「幽灵通过」；本口径让「忘了声明」被拦、「明确决定不约束」必须**写出来**，读端可区分两者。落点：`lib/assembly/team-asset.js`（结构校验）+ `lib/tools/core.js`（建批期门禁 + 豁免告警）+ 四团队 `team-asset.yml` + `discipline.md#§0k` 与附录 A + 新增测试 `test/audit-contract-gate.test.js`（4 例：正例 / 缺键拒建批 / 显式空放行带告警 / 无资产跳过）。
- **P2.1：audit_contract 字段接消费 + 白声明清理（2026-09-14「A 方案」，逐字段核实后）**：审出 P2 声明的四个字段 `criteria_from` / `consumes_required` / `checklist_anchor` / `verdict` **均无消费点**（典型「声明白契约」），且 `verdict` 与既有 `flows.complete.require_audit_outcomes` **重复**。处置：① `criteria_from` **接消费** —— entry 期按其 glob **指名**锚点产物（未被指名的 plan 产物带 `## 验收标准` 不顶用）；② `consumes_required` **接消费** —— 建批期要求每个声明前缀至少被一条 audit lane 的 `consume` 命中；③ `verdict` 升为 complete 门禁**唯一真源**（`require_audit_outcomes` 降为未声明时的 legacy 回落），取值统一为 `{pass,skip,fail,conflict}`（software-team 原 `approve/reject` 已校正）；④ **移除 `checklist_anchor`**（自由文本不可机器判定 ⇒ 归技能手册/文档面）。落点：`lib/state/gates.ts`（两处读端）+ `lib/tools/core.js`（加强门禁）+ `lib/assembly/team-asset.js`（去字段校验）+ 四资产字段收敛 + 新增 3 例测试（`consumes_required` 缺口 / `criteria_from` 指名 / `verdict` 真源）。
- **缺陷修复：`globMatchesPath` 末段回退静默放宽（2026-09-14，P2.1 活体验证中发现）**：`lib/assembly/flows.js` 的末段回退有两处缺陷——① **`**` 作末段**时退化为「匹配任意路径」（实测 `plan/**` 命中 `exec/e1/o.md`）；② **只比文件名、不校目录段**（`plan/*spec.md` 命中 `D:/…/exec/design-spec.md`）。后果：audit 的 `criteria_from` 锚点与 plan 内容契约的 `artifact_globs` **静默放宽**（判据形同虚设）。修法：末段回退**仅对绝对路径**生效（保留「绝对路径产物带目录前缀不该失配」的原始动机）+ **末段非纯通配 `**`** + **目录段按序对齐**。落点：`lib/assembly/flows.js`（唯一实现；`sectionProblemsOf` 与 `gates.ts` 两个消费方同时受益）+ `test/audit-contract-gate.test.js` 新增 6 条断言回归（两条缺陷回归点 + 原动机保护 + 反例）。**发现路径留档**：该缺陷是 P2.1 活体冒烟的**报错文案**里多出一条不该出现的 `exec/e1/o.md` 才暴露的（细节输出本身携带信息）；且我的第一版修复不彻底，被自己写的回归测试当场抓出。

### 灵活装配 × 角色白名单同源修复（2026-09-14）

- **缺口事实（按事实核查，非按测试结论）**：用户报告「灵活装配指引与角色白名单对不上，leader 的灵活装配都作废」。探针 `scripts/probes/flex-assembly-audit.mjs`（leader 直做，零依赖可直接跑）复现两条：
  - **D-1（词法面不同源）**：资产把自有角色写进 `layers[*].roles`（= 技能映射的键，最自然的写法）却没抄一份到 `roles.extra` ⇒ 建批时**每个自定义 lane 角色**判 `GATE_ROLE_INVALID`（探针 C1：5 条）+ 计划/验收位 `GATE_ROLE_MISSING`（2 条）。指引（`discipline.md §0j 二`「放开的是层 / 角色 / 技能 / flows 的组装」）与白名单（8 基础角色 ∪ 盲审三角色 ∪ `roles.extra`）**不一致**。包内 4 团队之所以干净，是靠**人工把各层角色并集抄进 `roles.extra`**（`test/team-assets-fill.test.js:214` 的断言即该同步义务的证据）。
  - **D-2（缓存陈旧 = 真·作废）**：`lib/assembly/flows.js` 的 `CACHE` / `ROLE_CACHE` 键仅 `root::team`、无失效判据 ⇒ **同进程内改资产不重载**。Leader 的灵活装配循环（写资产 → 建批 → 见告警 → 补声明 → 重建批）第二步仍读旧值（探针 C4：run2 资产已含 `roles.extra`，仍报 5×`GATE_ROLE_INVALID` + 2×`GATE_ROLE_MISSING`），修正**隔空失效直到重启**（宿主为长驻进程）。
- **修复（引擎侧，最小且兼容）**：
  - ① **角色词法集与资产声明面同源**：新增 `unionRoleVocabulary()`（`lib/assembly/flows.js`）= **各层声明角色 ∪ `roles.extra`**（小写归一 + 去重）；`lib/wave-plan.ts#buildWavePlan` 与 `lib/tools/core.js`（`assembly.roles` 判定）改从该读端取词法集。`resolveTeamRoles` 新增 `layerRoles` / `layerRolesByLayer` 字段；**`extra` 字段语义不变**（仍= 显式声明的扩展角色，`software-team` 仍为 `[]`）。
  - ② **缓存加资产签名**：新增 `teamAssetSignature(root, team)`（路径 + mtime + size，读端 `lib/assembly/team-asset.js`），`CACHE` / `ROLE_CACHE` 命中前比对签名，变了即重读 ⇒ 资产改动**即时生效、免重启**。
  - ③ **告警文案**：`GATE_ROLE_INVALID` 消息补「, or any role declared by the team asset）」，指向唯一读端。
- **未改（显式保留）**：`GATE_ROLE_MISSING` 语义——**牵头角色仍须显式声明**（`plan_leads` / `audit_leads`）；「角色可用」与「角色可牵头」是两件事（是否让各层声明角色自动取得牵头资格 = 待用户裁决项，见工作区台账）。
- **指引同步（3 处）**：`presets/jiufeng/references/discipline.md#§0j 五` 重写为新口径（含旧口径作废声明 + 探针/回归证据）；`presets/jiufeng/references/manager.md §5.6` 修**陈旧 flows 口径**（原文「临时团队只覆盖装配面、`flows` 待补全、批次不存 `teamsRoot`」与 D3 补全后的实现**相反**，与 persona 0j / discipline §0j 四冲突）+ 增「资产改动即时生效」；`docs/engine-intro.md` 三节同步。
- **验证**：新增 `test/flex-assembly-roles.test.js`（F1 layer 声明即合法 / F2 装配声明面同源 + 未声明角色负向对照 / F3 `extra` 兼容与 union 语义 / F4 缓存陈旧修复 / F5 灵活装配循环端到端）；`npm test` **1072/1072 fail 0**（原 1067 + 5）；`npm run check`（tsc）exit 0；构建链 `npm run build` 已回拷 `lib/wave-plan.js|d.ts`。
- **残留（如实）**：D-2 的签名判据在同一 mtime 毫秒内**同尺寸**改写时可能漏判（人工/代理编辑流中不现实，未为此牺牲缓存命中）；资产层角色名若带大写而 `layers[*].skills` 键为原样大写，归一化小写会让前缀查找 miss（既有行为，未在本轮改动）。

### 指引一致性订正与记录补齐（2026-09-14）

- **`discipline.md §0c` 口径订正**：原写「Manager = **任务第一对接点** … 空闲节点发现与建议指派（`member_status` 拉起 idle/pending lane）」，与 persona 新口径（Manager 只代劳指挥、不产 plan 产物）及既有写入口径（**派发与结算写入默认由 Leader 执行**）冲突。已改为：① Manager = 引擎层功能角色（不属任何层、不占 lane），只代劳指挥、**不产 plan 产物、不得充当 plan 层牵头**；② **派发/结算写入默认执行方 = Leader**，Manager 负判读+建议，仅在 Leader 明确授权时代为写入。
- **团队技能退役名订正（5 文件）**：`skills/software-team/SKILL.md`（角色概览表 + 装配表技能列 → v3 名；装配表上方加「唯一来源 = `presets/software-team/team-asset.yml`」；示例与指引引用同改；弃用/不装配两节保留但加「本节为历史记录」声明）、`skills/software-team-assembly/SKILL.md`（角色作用表技能列 → v3 名）、`skills/design-team/references/roles/designer.md`（删「执行层留空、由 Leader 代劳」——与设计团队现状相反，改为「执行层已装配 `workflow-builder`/`producer`、audit 层 `workflow-auditor`」）、`skills/software-team/references/workflow.md` 与 `.../roles/designer.md`（`dev-designer`/`dev-planner` 引用 → `spec-writing`/`writing-plans`）。**`software-team/SKILL.md` frontmatter description** 同步（原「`dev*/prd*/review*/doc*` 手册映射」→「角色 × 能力层技能速查 + 唯一来源声明」）。
- **复核口径**：`skills/**` 精确词边界扫描，装配/角色手册语境下退役名命中 **0**；剩余 6 处全在**已声明的历史节**或**自建技能的「替代旧 X」说明句**中（有意保留）。
- **验证**：`npm test` **1067/1067 fail 0**（文档改动后复跑）；改动文件 UTF-8 无 BOM。

### persona 纪律块精简（两轮，2026-09-13）

- **规模**：治理纪律块 **4482 → 3071 字符（−31.5%）**；规则行数仍为 **21**（`0` / `0a`–`0i` / `0j` / `1`–`10`，编号一个不缺，`#§x` 引用全部有效）。
- **手段**：① 去重——0c 与 0g 的 Manager 口径合一、8 从 5 拆回独立行、1–4 短句化；② 操作性条款下沉——`0b`/`0f`/`0g`/`0h`/`0i`/`9`/`10`/`0j` 只留「判据 + 指针」（`references/discipline.md#§0b|§0f|§0g|§0h|§0i|§9|§10|§0j`），码表与操作序列留在细则。
- **订正陈旧事实（重点）**：`0j` 原写「临时团队…`flows` 面待补全（后续项）」，与 D3 补全后的实现**相反** → 已改为「**装配面与 `flows` 面均已生效**（`teamsRoot` 随批次持久化，与内置团队同一校验器、同一门禁语义；缺省走包根）」；旧口径残留 **0** 处。
- **判据守恒核验**（逐条 grep 实测在场）：`明确多线并行`、`单线程任务一律不建批`、`assign_check`、`gate_status`、`revokeExempt`、`禁裸 subagent`、`progress/NN`、`宿主级加载`、`survey/<target>-contract`、`flows 面均已生效`、`同一门禁语义`（`batch.manager.raised` 事件名与豁免倍率码表位于 `#§0g`/`#§0h` 细则内）。
- **验证**：YAML 结构自检 **PASS**（21 行编号齐、无未编号续行、无控制字符）；全量 `npm test` **1067/1067 fail 0**。

### 追踪项收口：口径定案与文档订正（2026-09-13）

- **F7（文档订正）**：`discipline.md` 附录 A 的 `TEAM_ASSET_LEAD_NOT_IN_LAYERS` 行订正为精确口径——该码只判「声明的 lead 角色**是否出现在任何层**的 `layers[*].roles` 中（声明悬空）」，**不判层次归属**；某层是否构成该层牵头由 `lane.layer` + 牵头集判定；并明示**牵头角色 ≠ Manager**（Manager 属引擎层、不占 lane）。
- **F2（勘误）**：团队资产内技能名**一律取加载名**（宿主 `SKILL.md` frontmatter `name`）；早期 spec 文本中的目录名写法（如 `research-compiler`）作废，实际值为 `ara-compiler` / `ara-research-manager` / `ara-rigor-reviewer`。
- **F1（跨批交接口径，零引擎改动）**：生产/交付批（`producer` / `publisher`）需要搭建批的 audit 产物时，**由 Leader 在生产批建批前用 `asset_claim` 把该产物归位到生产批产物根**，生产 lane 的 `consume` 指向**本批内路径**（入口门禁因此照常生效：审核未过则产物不存在 → `GATE_ENTRY_MISSING` 拒派）。跨批原生引用（引擎直接解析他批产物根）留作后续增强，**不得**假定其已生效。
- **O-2（路径口径）**：批次产物路径以 **批次 `wavePlan` 为唯一权威**（冻结语义，不中途重算）；plan 文档（`task-tree.json` / `assembly-statement.md`）中的路径引用仅作可读说明，与 wavePlan 不一致时以 wavePlan 为准。
- **F3 留痕**：`skills/design-team/SKILL.md` 直读字节数与某 lane 自述存在 +182 B 差异（疑报告后用词微调），不影响判据（Layer A 区块 59/59 已独立复算），记留痕、无动作。

### 团队装配扩充：design-team / research-team / writing-team（2026-09-13）

- **新增三套团队装配资产 + 团队技能**（装配数据唯一权威 = 各自 `presets/<team>/team-asset.yml`；团队技能只声明指针与用途，不复制装配数据）：
  - `design-team`：plan `design-planner`（评估需求 → 研判风格 → 设计 ComfyUI 使用资产）/ exec `workflow-builder`（搭建工作流 + 初步冒烟）、`producer`（**新批次实跑生产**，consume audit 产物）/ audit `workflow-auditor`（审工具合理性与是否符合设计目的）。技能：`spec-writing`、`interaction-design-principles`、`comfyui-use`、`acceptance-gate`、`review-execution`。
  - `research-team`：plan `research-planner` / exec `researcher` / audit `research-auditor`。技能：`spec-writing`、`decision-mapping`、`tech-benchmark-planning`、`ara-compiler`、`ara-research-manager`、`ara-rigor-reviewer`、`citation-evaluator`、`arxiv-translator`（**加载名口径**）。
  - `writing-team`：plan `writing-planner`（读者/平台/体裁/风格评估 → 写作规格）/ exec `drafter`（按规格成稿）、`polisher`（修订/去 AI 痕/密度压缩）、`publisher`（**新批次排版交付**，consume audit 两产物）/ audit `writing-auditor`（判据对照审稿，只读不改稿）。技能：`spec-writing`、`writing-trio`、`wechat-writing-style`、`humanizer`、`lieflat-less-ai-tone`、`revision-patterns`、`baoyu-markdown-to-html`、`acceptance-gate`、`review-execution`。
- **三团队共用口径**：自定义角色经资产 `roles.extra` + `plan_leads`/`audit_leads` 声明（与引擎基础牵头集**并集**）；`flows`/`state_machine` 沿用软件工程团队同口径（plan 契约裸标题 `## 验收标准`/`## 约束`、exec `entry_requires:["consume"]`、audit `needhuman`、`complete.require_audit_outcomes:["pass","skip"]`、`tighten-only`）；**生产/交付一律另开批次**，其 lane `consume` audit 验收产物（缺则 `GATE_ENTRY_MISSING` 拒派 ⇒ 审核通过才开产/交付）。
- **装配读端**：`lib/assembly/team-asset.js`、`lib/assembly/flows.js` 已随本次提交落入 HEAD（此前为未跟踪文件，他域改动回退会使新团队资产不可加载）。
- **技能名解析**：装配内技能名一律取**加载名**（宿主 `SKILL.md` frontmatter `name`）；引擎的技能存在性校验（`GATE_SKILL_MISSING`）按「宿主**目录名 ∪ frontmatter 名**」判定，避免目录名与加载名不一致时的误报。
- **登记与测试**：`presets/jiufeng/asset-manifest.json`（→9 条）、`lib/assets.js` `DEFAULT_ASSETS`、`test/assets.test.js` 计数与清单断言同步（断言强度未放宽）；新增 `test/team-assets-fill.test.js`（9 用例）与 `test/writing-team-asset.test.js`（5 用例）覆盖：资产加载期校验、建批技能前缀逐字、自定义牵头生效、生产/交付的 `GATE_ENTRY_MISSING` 正负例。

### 缺口推进（追踪项处置，2026-09-13）

- **`batch.manager.raised` 登记幂等（O-1）**：`store.markManagerRaised` 增**同 `agentId` 幂等守卫**——重复登记同一 Manager 直接返回既有记录、**不重复写事件**（此前「先登记、后迁移」的调用序被重试时会留下重复事件，属审计噪音）。配套把 `test/governance.test.js` 的期望事件数由 2 改为 1（断言强度不降：改为「同 agentId 幂等」这一更强语义）。验证：`npm test` **1062/1062 fail 0**。
- **F6（装配读端落 HEAD）**：`lib/assembly/team-asset.js`、`lib/assembly/flows.js` 此前是**未跟踪文件**（他域在途改动一旦被回退，design-team / research-team 两套新资产将不可加载）——已连同本批交付（`presets/{design,research}-team/team-asset.yml`、`skills/research-team/SKILL.md`、`test/team-assets-fill.test.js`）以**路径限定提交**落入 HEAD，未挟带他域在途改动。
- **F7（仅文档面，未改代码）**：`TEAM_ASSET_LEAD_NOT_IN_LAYERS` 的校验语义是「牵头角色须出现在**任一层**的 roles 中（声明悬空即报码）」（见 `lib/assembly/team-asset.js`），与部分文档写成「本层」不一致；**不收紧校验**——某层是否构成牵头由 `lane.layer` + 牵头集判定。已登入工作区追踪台账 `engine-open-items.md`。
- **澄清（与 Manager 层归属相关）**：**「牵头角色」不指代 Manager**。牵头角色是团队层内承担计划/验收职责的角色（声明面 `roles.plan_leads` / `roles.audit_leads`）；Manager 是引擎层功能角色（不属任何层、不占 lane，只代理指挥团队按任务 DAG 执行），从不进入牵头候选集；误用作 lane 角色会得专属告警 `GATE_ROLE_MANAGER_AS_LANE`。

### 复核收尾：`manager` 作 lane 角色的专属告警 + 孤儿回收入口留档（2026-09-13）

- **D1（修）**：`manager` 保留在合法角色集合中（供 `assembly.roles` **声明面**使用），新增**专属告警码 `GATE_ROLE_MANAGER_AS_LANE`**——某 lane 的生效角色为 `manager` 时提示「Manager 属引擎层（不属任何层、不占 lane），请改用该域自己的计划/验收角色（plan: designer/coordinator；audit: supervisor/doc-manager）」。此前该情形只会混入 `GATE_ROLE_MISSING`，读起来像「缺牵头角色」，语义错位。仅告警、不阻断；`manager` 仍可作 `assembly.roles` 声明项。
- **B7（留档，不接线）**：孤儿 worker 的显式回收维持 **lib 级人审能力** —— `store.recycleStalledLane(sessionId, batchId, lane)`：
  - **语义**：lane 必须为 `running` 且已有 `lane.stalled` 证据（终态 lane 永不可回收）；执行后 lane 落 `idle`，并留事件 `lane.recycled{lane, from:'running', reason:'stalled', outcome:'interrupted', note}`；随后走既有 `member_status(idle→running)` 重派。
  - **不接线的理由**：① 注册为治理工具会打破「20 工具契约」（多个测试文件硬断言）；② 加 API 路由 / 面板入口属前端面新增，超出本轮范围；③ 该动作要求人审判断，而工具层无 caller identity，暴露为工具反而不安全。
  - **触发方式（当前）**：宿主侧以 Node 直接调用 `createStore(<引擎状态根>).recycleStalledLane(sessionId, batchId, lane)`；是否接线为工具/API 由后续需要决定。

### 团队装配收敛：jiufeng 团队装配退役 + 临时团队 `flows` 面补全（2026-09-13）

- **jiufeng 团队装配退役**：装配数据唯一权威来源 = 团队资产 `presets/<team>/team-asset.{json,yml}`；删除 `presets/jiufeng/team-asset.yml`，`lib/assembly.js` 不再内置任何团队常量兜底（原 `team === 'jiufeng' ? DEFAULT_ASSEMBLY : null` 分支移除）。`DEFAULT_ASSEMBLY` 保留为兼容导出，内容改为 = `software-team` 装配（不再含退役技能名）。此后各团队以自身资产为准（`software-team` 等）。
- **无资产团队不再静默**：`team` 无对应资产时，建批照常成功但**不注入任何 `[skills=…]` 前缀**，并落告警事件 `gate.role_invalid{code: GATE_TEAM_ASSET_MISSING}`（不阻断）。
- **技能名存在性告警**：建批时校验装配引用的技能能否在**宿主技能根**（`~/.agents/skills/<name>/SKILL.md`）解析，缺失落 `GATE_SKILL_MISSING`（不阻断；技能根不存在时跳过校验，避免隔离环境噪声）。
- **临时团队 `flows` 面补全（D3）**：建批时 `teamsRoot` 随批次持久化（新可选字段 `teamsRoot`，缺省不写键 = 旧批零迁移）；门禁读端解析根优先级改为 ① 批次级 `teamsRoot` → ② 注入的 `flowsRoot`（测试缝）→ ③ 包根。临时团队的 `entry_requires` / `contract` / `produce_field` / `needhuman` / `complete` 判据**按临时资产生效**，与内置团队同一解析器、同一门禁语义。
- 契约测试同步：11 条承载旧语义的用例改写为新语义（等价锚改指 `software-team`；显式断言 `resolveAssembly('jiufeng') === null`、`loadTeamAsset(...,'jiufeng').ok === false`）；新增 T8（临时团队 flows 生效 + 缺省对照）。用例总数 1053。

### 治理面缺口修复（复核批次落地，2026-09-13）

- **终态冻结（A1）**：批次进入 `complete` / `aborted` 后，任何成员迁移一律拒 `GATE_BATCH_TERMINAL`（防「已收口批次仍被改写成 running」）。
- **C+ 收口告警（A2）**：exec 层 lane ≥3 的批次 `complete` 时未登记 Manager 拉起 → 落 `gate.manager_missing`（**非阻断**，避免追溯性拦旧批）。
- **Manager 拉起登记（新增可核事实）**：`batch_phase({ batchId, manager: { agentId, note? } })` 登记 → 写批次字段 `manager={agentId,raisedAt}` + 事件 `batch.manager.raised`；`batch_status` / `gate_status` 均可读。门禁：非 `running` 拒 `GATE_MANAGER_PHASE_INVALID`、终态拒 `GATE_MANAGER_TERMINAL`、`agentId` 必填 `GATE_MANAGER_AGENT_ID_REQUIRED`。
- **longrun 豁免随派发（A3）**：豁免是「本次派发」的属性——结算终态自动清退；**重派未带 `exempt` 时旧豁免自动失效**（不再继承放大阈值与 stalled 豁免）。
- **崩溃恢复清 stale lane 锁（A4）**：进程重启恢复把 in-flight lane 落 idle 时，同步清退该 lane 的锁文件（持有者进程已不存在 ⇒ 死锁），使重派不再被 `lane_claim` 冲突挡住。
- **`gate_status` 批次级视图（B3）**：返回补 `manager` 与 `assembly` 两字段，使 C+ 装配声明与 Manager 事实可经单次只读查询核对。
- **告警文本去重（B8）**：`GATE_ROLE_MISSING.missing` 拼接去重。
- **预留事件标注（B5）**：`worktree.created/merged/merge.conflict/merge.resolved`、`gate.passed`、`gate.exit.missing`、`gate.target_blocked`、`gate.target.passed` 标注为「预留未接线」（lib 内无写端无读端），不得当作既有留痕能力引用。
  - **订正（2026-09-15 · 复核实测）**：本行 2026-08 建账时点后，其中三项**已被接线**，原「无写端无读端」表述**已过期**——`gate.passed`（exit 门放行留痕，任何 merged 恒有）、`gate.target_blocked` / `gate.target.passed`（targets 门：写端 `lib/state/store.js:632/:638`，读端 `test/gates.test.js` O2 组 + `test/batch-store.test.js:309/:323`）。**结论：不得按「预留」删除**（删除会同时移除 targets 门的留痕能力与 6 条断言），B5 台账条目据此改为「事实订正」；仅 `worktree.*` 与 `gate.exit.missing` 维持预留标注。
- **未接线声明披露补全（D4）**：`flows.*.consume_field` 补进「暂无消费点」清单（引擎恒按任务自身 `consume` 判定）。
- **发布面脱敏（C3）**：`skills/design-team/SKILL.md` 去除本机绝对路径与内部产物路径引用。
- **指引订正（C1/C2/C4/C6）**：装配声明的**唯一生效形态**写明为 `wave_plan({ assembly: { … } })` 顶层入参（plan 文档只是人可读载体）；persona 0h 豁免倍率改为「按类型取档（ai-render 8× / large-download 6× / dep-install·none 4×）」；纪律 0 条重复表述合并；难度路由口径明确为「多线并行或多依赖才升 C，单线程不建批」（B 档收窄为两类：独立上下文调研 / 已明确上下文可简单派发的单步任务）。
- **痕迹清理**：非文档文件中移除内部决策溯源与版本叙事（批次 id、日期戳、「用户裁决」、「本批/本轮」、内部文档路径、`spec §x`/`GAP-0x` 编号）；`test/**` 中承载旧语义的注释与常量同步订正。

### 审计日志（默认开、可显式关闭、有轮转与体积上限、零远程上报）

- 新增进程级审计日志 sink（`lib/auditlog/sink.js` + `lib/auditlog/config.js`），挂载点在 `lib/index.js` 的 `apply()` 内——**先于配置校验 warn、门禁逃生阀 warn 与资产同步**，使启动期审计信号不漏记；挂载失败不炸宿主。
- 落点 `<DSH_HOME>\logs\punky-swarm\audit-YYYY-MM-DD.jsonl`（本地日期；`<DSH_HOME>` 依次取 `PUNKY_AUDITLOG_SINK_DIR` → `DSH_HOME` → `~/.dsh`），不在会话工作区、不在插件产物根内；运行期诊断面在同根 `diagnostics/sink-diagnostics.json`。
- 默认开启；关闭渠道两条：环境变量 `PUNKY_AUDITLOG`（`0`/`false`/`off`/`no`）或配置键 `capabilities.auditlog.enabled: false`；env 逐键覆盖 config；关闭态不建目录、不注册 exporter、零字节写入；**热改需重启宿主生效**（不提供运行期挂载/卸载）。
- 行格式 JSONL，10 字段（`v`/`ts`/`level`/`name`/`msg`/`args`/`sn`/`truncated`/`pid`/`kind`）；单行硬上限 32 KiB，两段截断（先 `args` 后 `msg`）并留 `...[truncated]` 标记，不丢记录。
- 轮转与体积上限：单卷 64 MiB 硬分割（`-1`/`-2`… 单调递增）、保留 14 天、总量 512 MiB（超出按最旧优先清理）；只 append、永不改写既有卷。
- stdout 默认关（`PUNKY_LOGGER_STDOUT` 显式开启才输出），与文件 sink 同一 record 结构；写失败不 fallback stdout。
- 降级有界：export 全链路 try/catch 绝不向调用点抛错；连续失败 3 次开断路器（此后每 1000 次尝试放行一次探活），`sink-error` 记录上限 3 条；不调用 exporter 的 disposer。
- **不做任何远程上报**（零网络出口、零远端 sink、零 OTel 导出）；捕获面为元数据级（诊断文本 + 绝对路径 + 会话/批次标识符 + Error 堆栈），**无法按 ctx/插件收窄**（exporter 注册表进程级全局）。
- 能力注册表新增 `capabilities.auditlog` 项（默认值取自 `lib/auditlog/config.js` 的冻结常量，单一来源）；不注册新工具、不新增校验规则、不新增运行时依赖。
- 已知边界：不支持多进程写同一 sink 根（隔离实例请用 `PUNKY_AUDITLOG_SINK_DIR` 指定独立目录）。
- 版本号不变（本次仅登记变更，不 bump）。

### 团队更名登记：jiufeng-team → software-team

- 登记条目（可追溯硬项）：原名 `jiufeng-team` → 新名 `software-team`；日期 **2026-09-12**；原因：引擎/团队分层改造，团队技能名与团队定位对齐（「蟛蜞模式」为引擎侧治理模式名，软件工程角色指引归团队层，原「蟛蜞模式指引层」名不副实）。
- 影响面：技能目录 `skills/jiufeng-team/` → `skills/software-team/`（18 文件，文件集合与 8 角色文件名不变）；同步任务 `lib/assets.js:85` 目标改为 `~/.agents/skills/software-team`，关联测试 `test/assets.test.js` 同步；`SKILL.md` frontmatter `name:`、自检脚本 `scripts/check-v3-density.mjs` 注释与 `cmd` 示例改名；本包 `package.json` description 与 `docs/single-machine-capabilities.md`/`.en.md` 同步改名。
- 不改动面：`presets/jiufeng/`（preset id/目录名/`preset.yml` 的 `name`）、装配命名空间键 `jiufeng`（`DEFAULT_ASSEMBLY.team`、`aip.team`）、引擎数据根 `~/.dsh/jiufeng`、`VALID_ROLES`/`REQUIRED_ROLES` 值。
- 历史行不改：本文件既有 `jiufeng-team` 记载（历史事实行）原样保留，本次仅**追加**本登记块。

## 0.4.4（2026-09-08）

### 批次事件结局分型（恢复与回收记账）

- 恢复路径记 crashed：进程崩溃重启后，恢复流程将崩溃前处于运行/评审中的 lane 置回待派发（idle），恢复事件为该类 lane 逐一记结局 crashed，并保留原态与既有审计字段——重派前可经事件流查询哪些 lane 系因崩溃中断。
- 回收处置记 interrupted：running lane 具备停滞证据、被显式回收脱离在飞态（置回 idle 待重派）时，回收事件记结局 interrupted。
- 默认开启、只记不改：结局记账自动生效，不构成新的成员状态、不改变既有成员迁移/拦截/结算语义，也不介入重派决策（重派仍走既有待派发→运行通道）；未带结局的旧事件与旧批次读取零迁移兼容。

### 评审与验收结论结构化必填

- 评审（review）与验收（acceptance）产出的结论必须结构化携带三要素并置于报告头部：① 结论 approve / reject（显式二选一）；② 阻断项清单（reject 时必列，验收侧与既有对账衔接）；③ 跟进项清单（后续动作与遗留观察，可为空）。
- 空结论即评审未完成：缺失 approve / reject 结论、或以一句笼统表态（如「总体没问题」「建议合并」「验收通过」）替代三要素的，视为评审未完成，可打回补全（沿用既有驳回语义）。

### 批次级装配声明与规模批门禁

- wave_plan 建批新增可选顶层参数 assembly（批次级装配声明）：managerPlan（编排牵头形态：raise=拉起编排 Manager 代管调度 / leader-direct=任务负责人直管派发）与 auditLane（验收归属 lane）必填，coordinatorLane / roles 可选。
- 规模批强制：三层批且 exec 层任务（lane）数达 3 个及以上时装配声明必填——声明缺失、结构非法、或所引 lane 不存在/层错配将拒绝建批（无批次落盘，补齐声明后重试）；roles 词条格式异常仅告警、不阻断。
- 声明随批次持久化与回显：归一化声明写入批次数据顶层（可选字段、schema 不升；未声明不写键，既有批次零迁移），建批返回值附装配声明视图。

### 模式装配与纪律条文更新

- 难度路由扩档：模式预设难度路由在 A/B/C 之上新增规模批档 C+（三层批且 exec 层任务达 3 个及以上，与引擎装配门禁同一判定口径）；此类批次进入运行后须先拉起编排 Manager（首个 exec 任务派发前完成），任务负责人的兜底代行与豁免留痕仅限普通批次，边界条文同步更新。
- 装配履职条文：按需装配的细拆/架构复核角色须先经代码图谱建立与复核代码索引（细拆与架构复核依据可追溯）；评审/验收结构化结论条文见前节。
- 新增纪律条文：消费方契约摸底先行（实现消费宿主接口、外部 DSL 与框架扩展点前，先落契约摸底产物并作为实现前置契约）与宿主级自验证（产出完成判据须含真实宿主加载/启动冒烟，语法与局部级检查不作完成判据）。

### 发布整理

- 版本 0.4.3 → 0.4.4；变更记录整理与发布前内部口径清查。

## 0.4.3（2026-09-07）

### 调用级护栏拒绝可见性

- 护栏拦截明示：工具调用送入人工审批后被拒绝（含审批服务不可达、无可用 agent 等降级情形）时，Agent 收到的拒绝不再只是「用户拒绝了该工具」的泛化提示，而会携带护栏标注、命中规则、违规说明与查阅路径——Agent 与用户均可识别该拒绝源于护栏对疑似敏感数据调用的拦截，并可按违规说明修正参数后重发合规调用；非拦截场景行为保持不变。
- 拒绝文本携带命中规则：拒绝原因末尾追加命中规则及其预设归属（如 L1-A10 · preset l1-sensitive），人工审批请求与直接拒绝路径均携带，用户在批准/拒绝前即可核对所触发的具体规则。
- 行为说明同步：拒绝可见性语义（拦截明示与规则引用，含边界说明）随双语主题文档 guardrails-hook 同步更新。

### 护栏预设逐条审阅清单

- presets/hook-rules/README.md 新增逐条规则审阅清单：敏感数据防护 12 条与资源边界 6 条，按规则编号 / 预设归属 / 类别 / 生效原语 / 触发工具 / 匹配摘要 / 违规说明逐条成表，供用户与 Agent 主动审阅护栏规则全集；配套一致性断言守护清单与规则文件同步。

### 发布整理

- 版本 0.4.2 → 0.4.3；变更记录整理与发布前内部口径清查。

## 0.4.2（2026-09-06）

### 治理配置面板：Lane 过期检测与重派探针

- 治理配置页新增 **Lane 过期检测** 与 **长跑超时重派探针** 两级开关：前者控制 running lane 的心跳过期扫描，后者控制长时间无 checkpoint / 活动进展 lane 的重派候选探测。开关随护栏共用同一保存通道写入运行配置，保存即热更生效，进程重启后按 runtime.json 自动对账，无需重复设置；出厂默认开（缺省即开、显式关闭才停），关闭仅停止扫描与候选探测，不改动已落盘批次 / 成员状态，重新开启后自基线恢复扫描。
- 长跑时间窗口面板化：**超时窗口**（默认 20 分钟）与**无进展窗口**（默认 5 分钟）可在表单以分钟输入，保存时自动换算毫秒生效，无需手工编辑配置文件。
- 「违规自动升级」说明文案优化：直接说明触发次数 / 窗口阈值的判定与升级暂停行为，去除括号提示与实现细节，降低配置理解成本。
- 配套新增回归测试：覆盖开关保存热更、进程重启对账与长跑无进展候选场景。

### 无 Manager 批次的长跑候选消费

- 未拉起编排 Manager 的批次运行期间，由任务负责人（Leader）兜底承担长跑候选消费：读取候选广播、核对 lane 探针状态与 checkpoint / 活动进展，按半自动规则裁决继续观察或重新派发；已拉起 Manager 的批次仍由 Manager 完成调度。

### 注释与文档口径统一

- 「出厂默认开、显式关闭才停」口径统一：Lane 过期检测与长跑探针的默认开启说明跨代码注释、预设说明与双语文档对齐（纯注释与文档改动，零逻辑变更）。

### 发布整理

- 版本 0.4.1 → 0.4.2；变更记录整理。

## 0.4.1（2026-09-05）

### 治理预设规则包

- 出厂护栏规则预设随包发布（presets/hook-rules）：l1-sensitive（L1 敏感数据防护 12 条）、l2-resource（L2 资源上限 6 条）、compose（L1+L2 全量 18 条），wrapper 结构（`_meta` 元数据 + `rules` 数组），规则字段与引擎 Rule 类型逐字段对齐、零扩展字段。
- preset 装载与引用：装载器剥离 `_meta` 取 rules 并做受控资产早失败校验；`governance.hook.preset` 支持注册 id / id 数组引用（如 `"preset": "compose"` 或 `["l1-sensitive","l2-resource"]`），跨 preset 规则 id 全局唯一性校验拒绝重复。

### Web UI 治理配置页 + runtime.json 写通道

- 治理配置设置页（Web UI 设置区）：护栏开关、规则预设、违规自动升级（触发次数 / 窗口）可视化配置；页面保存即时生效、无需重启。
- runtime.json 热写通道：保存请求经 config-trust 校验（顶层白名单 / 值域 / preset 与内联规则冲突守卫）后落盘 runtime.json，400 校验拒绝不落盘；窗口秒输入后端毫秒归一化（windowSeconds → windowMs，线协议键不落盘）。
- 随包双语主题文档：docs/webui-governance-config(.en).md。

### lane_longrun 超时无进展探针

- watch 长跑档（默认开启）：running lane 运行超时且长期无 checkpoint / 活动进展 → 产候选并广播给 Manager（探针只产候选，不改成员状态），重派裁决归 Manager / Leader。
- 与心跳 stalled 档并列扫描；事件留痕可审计。

### Web UI 修复

- 治理配置页 UI 修复：重命名、preset 多选、放大字号、移除全组合提示。

### 发布整理

- 版本 0.4.0 → 0.4.1；根 README（GitHub 面）精简：170 → ≈100 行，中文 / 英文 1:1 同构重写，去除过期版本与测试数（实测刷新 816）；删除 README.market.md（人话版内容并入精简后根 README 机制表与能力段）。

## 0.4.0（2026-09-03）

### 工具调用级治理护栏

- 引导层挂载 + 运行时接线：治理钩子随引导装配挂载（bootoverlay），运行期 wiring 接线，工具调用进入统一裁决链。
- 6 原语裁决内核：classify / config / decisions / escalate / narrow / proto 域分层裁决，处置原语含 ALLOW / DENY / REQUIRE_APPROVAL / DEFER / NARROW / PAUSE。
- 拒绝收据锚定 + 哈希链防篡改：违规判定与处置落盘拒绝收据（receipt-store），锚定 prevHash 级联哈希（hash-utils），链式校验可审计、篡改即断链。
- DEFER / PAUSE 状态机：延后/暂停以文件态会话状态落盘（state-store），命中写状态并回填收据元信息（deferMeta / pauseMeta）。
- REQUIRE_APPROVAL 审批通道：软违规置信达标或边界命中转人工审批（ask 通道），审批结果回填收据并级联重锚。

### 护栏规则热更新

- 治理配置变更实时生效（config-watch），无需重启；规则与阈值热加载，配置窗口极小。

### 双层状态联动（违规升级 → 批次暂停）

- 滚动窗口违规计数升级：窗口内拒绝计数达阈值自动升级并暂停批次（governance refusal 事件 + 窗口摘要）。
- dispatch 归属登记：工具调用按发起方登记，违规处置可回溯（receiptId / callId / sessionId）。

### 产品化双语文档分层

- 文档分层：产品化双语发布文档与内部技术开发文档分流（包级 README / README.en 产品化）。
- 随包分发双语主题文档：governance-boundaries / governance-technical / guardrails-hook / single-machine-capabilities / aip-compliance / acps-communication 中英 12 文件（npm files 白名单）。

## 0.3.6（2026-08-29）

### 操作面板增强

- 配置热更新：配置变更实时生效，无需重启（兼容 Windows 平台约束）。
- 状态事件实时发布：状态变更经 topic 通道推送（swarm.&lt;type&gt;.&lt;sid&gt;.&lt;bid&gt; 命名）。
- SSE 实时面板：新增 /stream 端点，EventSource 主通道 + 轮询降级 + 心跳恢复；客户端面板段逐字节同步。

### 代码质量收敛

- 事件常量单点化（发端/读端统一引用，消除字面量散落）。
- git 工具函数单点下沉，消除双向依赖环。

### Punky Swarm 模式指引精简

- 角色指引瘦身（Persona 精简、公共约束单一来源），配套密度校验脚本自动检查。

### TypeScript 化（contract/gate 模块）

- contract/gate 核心模块改为 TypeScript 源 + 编译产物双形态：`lib/schema`、`lib/state/gates`、`lib/state/machine-rules`、`lib/state/schema-v3`、`lib/wave-plan` 提供 `.ts` 源、`.d.ts` 类型声明与编译后 `.js`；新增 type-only 契约层 `lib/types/contracts`（运行时行为不变）。
- 新增 `tsconfig.json` / `tsconfig.build.json` 与 `scripts/copy-ts-built.mjs` 构建链路（`npm run check` 类型检查 / `npm run build` 编译 + 产物归位）；devDependencies 引入 `typescript ^5.9.3`。

## 0.3.4（2026-08-22）

### dsh-tools 双版本兼容（compat-layer）

- peer/devDependencies 的 `@deepseek-ai/dsh-tools` 改为 `^0.1.0-rc.6 || ^0.1.1-rc.2`，双版本兼容内核 0.1.0-rc.6 与 0.1.1-rc.2。

## 0.3.3（2026-08-22）

### 国标 AIP 兼容契约对齐

- **aip.enabled 默认开启**（readCapability 合并 `{enabled:true}`）；智能体描述改为 ACS 字段集（根对象 20 键 必填 14/可选 6、AgentSkill 8 键，协议 02.01，旧 14+8 属性降级为 toLegacyDescriptor 兼容映射层）；消息映射对齐 ACPs AIP（aip-format.js Message/TaskCommand/Session 三函数，mailbox/batch 附 ACPs 投影）；身份体系（默认关）：AIC 身份码（前缀 1.2.156.3088 + CRC-16/CCITT-FALSE + Base36）+ CAI 身份证书 + 可插拔签名（默认 ECDSA-P256/RSA-2048）；发现服务（ADP，默认开）：`lib/discovery/` 新域 + `POST /api/dsh-punky-swarm/discover`（type 四类/filter 34 运算符/错误码 40000~40005/50001）+ `GET /.well-known/aip`；工具描述 6 属性保持现状（待正式协议文本校准）。

### ACPs 通讯方式（默认关）

- **能力总开关默认关**：`acps.enabled` 与 `acps.endpoint.enabled` 均默认 `false`，关闭时零运行时路径；对外 mTLS 服务端点：独立 HTTPS 监听器（node:https/tls 原生、零新依赖），默认端口 9443/host 127.0.0.1、TLSv1.3 + 双向证书（CERT_REQUIRED）、端点 `POST /acps/rpc`（AIP JSON-RPC）+ `GET /.well-known/acs.json`（ACS 14 必填键 + mutualTLS + JSONRPC）+ `GET /health`，证书 CA 自签（CN=AIC/SAN=acps://AIC，默认 `<root>/acps/certs`）；内部桥接（默认关）：`acps.bridge`（同进程双向，inbound 默认关需显式 `acps.bridge.inbound=true`；outbound = mailbox→ACPs 投影/投递；`/rpc→bridge 接线` 已通，inbound=false 时协议级 rejected INBOUND_DISABLED）；registry 对接（半自动注册，默认关）：login→upsertAgent→submitAgent（人工工批不自动跳过）→requestEab→queryAcs，EAB macKey **AES-256-GCM 加密存证**（与参考实现 SM4-CBC 标注差异）；discovery 对接（ADP 客户端，默认关）：`POST {baseUrl}/discover` 查询外部 Agent（type 四类/34 运算符与本地共享协议常量），scope=local/external/both（默认 local）；能力注册表扩至 9 键（aip/identity/discovery/verify/watch/worktree/budget/trajectory/**acps**，acps 与 identity 为默认关能力）；未实现项如实标注（工具调用待正式协议文本校准；SM2 签名无参考证据可插拔；mini-ADSP 仅预留签名；与参考实现真实互通待 demo 验证）。

### 护栏根治 + 文档补建

- 护栏 `\r?\n` 处理修复（merge-agent 护栏）；`README.en.md` 英文文档补建（22 KB，含中文互链）。

## 0.3.2（2026-08-22）

### 版本对齐推送
- 版本更新至 0.3.2，对齐远程推送（GitHub punky971210/dsh-punky-swarm）
- 许可合规（AGPL-3.0 唯一许可）与 npm 发布描述维护

## 0.3.1（2026-08-21）

### 许可合规修正 + npm 发布
- 许可唯一化：全仓表述统一为 AGPL-3.0 唯一许可（AGPL-3.0-only），移除商业授权字段；其他授权一律「联系作者获得许可」（README.md / README.en.md / CHANGELOG 0.3.0 记载 / docs/OPENSOURCE.md）
- 品牌残留清零：Swarm 集群品牌词全包改写为 dsh 语义历史沿革（README / SKILL.md / CHANGELOG 历史记载）
- npm 发布：dsh-punky-swarm@0.3.1 发布至 npm registry（`npm install -g dsh-punky-swarm`），README / docs/OPENSOURCE 安装章节同步更新
- 发布包与主仓库文本/版本号对齐（排除备份与依赖目录）
- 审计清理：docs/OPENSOURCE.md checklist LICENSE 项修正为 AGPL-3.0；本地库 package-lock.json root license 修正为 AGPL-3.0-only

## 0.3.0（2026-08-21）

### 0.3.0 发布：AGPL-3.0 唯一许可 + 治理能力默认全开
- 能力升级：引擎修复（目录 consume 判定 / 产物根指引 / 难度门禁豁免）+ lib 四域解耦（43 文件，删 3 单体）+ 国标 AIP 兼容 + 7 能力域（资产/装配/桥接/通信/面板/状态/验证/监控）+ 生命周期 + 恢复机制
- 测试 93 → 276 全绿（27 测试文件）
- 许可切换：Apache-2.0 → AGPL-3.0 唯一许可（AGPL-3.0-only；其他授权一律联系作者获得许可，自 0.3.0 起）
- 治理能力默认全开：wavePlan 三层 DAG + 引擎级门禁 + 状态机 + 锁/mailbox + 会话隔离

## 0.2.2（2026-08-21）

### 引擎修复 + README 边界修正
- 修复：Windows 目录 consume 判定（fileExistsNonEmpty 目录 size 恒 0 误报 GATE_ENTRY_MISSING → 目录存在即视为产物存在，空文件仍拒）
- 修复：产物根指引（任务包模板补「产物落盘」字段，worker 按引擎产物根落盘 / asset_claim 归位，双路径不一致根治）
- 修复：子代理难度门禁豁免（guard 对 subagent 降级豁免 + session 解析对称，worker 执行型工具不再被难度门禁误拦）
- README 边界修正：硬化=工程级门禁（dp1-dp4）确认已由 Tier3 实现，从「范围外」移除，Tier3 章节补 dp1-dp4 ↔ 门禁映射（README.md / README.en.md 1:1）

## 0.2.1（2026-08-19）

### Manager 代劳指挥协作架构 + role 残留清零
- 新增 SKILL.md「Manager 角色派发模板」：Manager=代劳指挥（只指挥不执行、不派发子代理），指挥循环 5 步（batch_status 读黑板 → mailbox_send 建议派发 → mailbox_read 收通知 → member_status/settle 结算 → report 批次完成）；任务包模板补 worker 双通道回执约定（report→Leader 简短 + mailbox_send outbox→Manager 详细）
- 新增 persona 纪律 0g Leader 唤醒协议：worker 由 Leader 派发（depth-1 直系）、Manager mailbox 建议、report→send_message 一行唤醒、Leader 不做调度决策（调度循环在 Manager 上下文）
- manager.md 协作方式 5 要素更新：不派发子代理 / mailbox 建议派发 / 收 worker 通知 / member_settle 结算裁决 / worker 双通道回执
- references/ 残留术语改写：Swarm 集群运行时术语（HITL/HATL/Converge/任务包）统一为 dsh 治理语义（人审门禁/gap-list 对账/lane 任务）。
- 测试 93/93 全绿；安装链路验证（模块加载 + syncAssets 幂等）通过

## 0.2.0（2026-08-19）

### 任务难度值门禁（工程纪律落地）
- 新增 assign_check 增强：scope（current/full，缺省 full）、输出 next/escalationHint/execToolCount/history；C 类 next=["wave_plan"]
- 新增会话级治理状态 governance.json v2（read/write/bump/stale/hasActiveBatch，原子写，history 审计留痕）
- 新增 guard 三重门禁（ctx.tools.guard）：门禁1 未评估/过期（execCallsSince>=20 或 >=30min）拒执行型工具；门禁2 判C未建批拒；门禁3 A类派 subagent 拒；非执行型豁免防死锁；计数与拦截分离；EXEC_TOOLS 可配置覆盖
- 新增 asset_claim 工具（工具面 13->14）：Leader 直做产物归位为批次资产（防逃逸纵深 + asset.claimed 事件留痕）
- config 贯通：apply 的 config 传入 createTools（config.escalation.execTools 覆盖名单，缺省回退）
- persona 纪律 0 重写（难度路由门禁：每轮必评 A/B/C + default to C + scope=full + 惰性化）+ 新增 0e（Leader 不写实现）
- jiufeng-team SKILL.md：移除"降级判定优先"判定策略（路由归 Punky Swarm 模式），改造为 C 类触发后的执行机制 + 任务包最小结构模板（两副本同步）
- 资产同步 syncAssets 幂等（预设/技能字节一致跳过，mtime 容差）
- 单测 68->93（governance 15 + asset/config 5 + 扩 5）
# Changelog

本项目尚未发布；以下按时间线记录 0.1.0 未发布期间的主要变更。

## 0.1.0（未发布）

### 2026-08-17 · 引擎初版
- 10 治理工具：wave_plan / batch_phase / batch_status / lane_claim / lane_release / member_status / member_settle / mailbox_send / mailbox_read / mailbox_ack；
- 状态机（成员 pending→…→merged|failed|skipped|conflict；批次 planning→…→complete）+ 原子写 + 锁 + mailbox + 恢复语义；
- 29 单测。

### 2026-08-19 · Tier3 三层门禁回填
- 新增 assign_check（委派形态判定 A/B/C）与 gate_status（门禁状态查询），工具面 10→12；
- wavePlan 层契约：layer ∈ plan/exec/audit、有 exec 必有 audit、路径契约、跨层引用校验、防篡改；
- 引擎级门禁：Entry（consume 齐备）/ L0（spec 必填章节）/ Exit（outputs/produce 存在）/ Complete（audit 全终态）；
- assembly 可插拔装配（默认装配）+ 会话隔离 v2（sessions/<id> + legacy 迁移）；
- 单测 29→68。

### 2026-08-20 · 产物注册表与门禁可视 + 开源准备
- 新增 artifact_types（产物类型注册表），工具面 12→13；
- API lanesGate、client GateBadge / AttemptBadge；
- 开源材料：LICENSE（Apache-2.0）、CI、CHANGELOG、CONTRIBUTING、三件套入包（presets/jiufeng + skills/jiufeng-team）；
- 修复：test script（node --test test/ → node --test，兼容 Windows/Node24）、peerDependencies 补 @deepseek-ai/dsh-tools。


