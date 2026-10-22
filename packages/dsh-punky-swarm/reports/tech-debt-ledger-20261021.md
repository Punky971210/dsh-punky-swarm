# 技术债台账（跨批，截至 2026-10-21）

> **存在理由**：`punky-debt-sweep-20261020` 的 `audit/gap-list.json` 生成于 2026-10-21 01:40，之后又有多笔提交把其中 10 项处理掉了，但 JSON 未回写；且「后期订正」留痕原本只落在 **session artifacts**（可被清理）。
> 本件把跨批未闭合项收成**一份仓库内可版本化的总账**，避免台账散落与丢失。
> **本件只登记状态与证据指针，不复制正文**（正文在对应产物 / `discipline.md` 里）。

## 一、已闭合（10 项）

| 编号 | 原缺口 | 处置落点 | 证据 |
| --- | --- | --- | --- |
| `SWEEP-FU-SEG-2` | `segmentCommands` 非字符串分支无直接单测 | `test/shell-text.test.js`（5 例，含「恒返回 [] 必红」阳性对照） | commit `9c0bf45`；baseline 170→171 |
| `R4-prime-rollout` | R4′（连续块 ∧ 逐字全命中）未落地为口径 | `references/discipline.md` §0k「等价复算（R4′）」表 | commit `9c0bf45`；`discipline.md:212` |
| `isolated-home-standard` | 合跑必须带 `isolated-home.preload` 未标准化 | `references/discipline.md` §0k「合跑须隔离 HOME」表 | commit `9c0bf45`；`discipline.md:213` |
| `Q3-correction` | `impl-w7f.md` §9 O-2 写点 42 为笔误 | 该件 O-2 已订正为 **41**（34 直接 + 7 解构，`.current` 不计） | `punky-w7f-20261020/exec/impl-w7f.md:203` |
| `W7F-DOC-N2` | d1 §4.5 判据分工方向写反（L1 能抓「写点存在但运行时没走到」） | 该件追加「## 后期订正」节，**原文未改** | `punky-w7f-20261020/plan/rt-write-observability.md:305` |
| `M-1` | `scope.md` §6 T-1④「`ctx.effect` 注册数 ≥2」缺前提（默认 `sweepIntervalMs=0`） | 追加「## 后期订正」节，给出正确前提 | `punky-w7e-20261020/plan/scope.md:211` |
| `M-2` | `scope.md` §6 T-3①「`tracked: true`」缺前提（须 beat 一拍） | 同上 | `punky-w7e-20261020/plan/scope.md:211` |
| `SWEEP-DOC-AC4` | AC-4「+N/−0」与 §2.2「须改写头注释」互斥；AC-1「全文命中==1」实为 2（含测试注释） | 追加「## 后期订正」节 | `punky-debt-sweep-20261020/plan/scope.md:264` |
| `SWEEP-DOC-Q4` | `e4-s3` lane `cmd` 写「6/6 逐字（DEBT-2=甲）」，与 SWEEP-B=乙 冲突 | 同上：判定**以乙为准**，`cmd` 为建批期冻结字段不改 | `punky-debt-sweep-20261020/plan/scope.md:264` |
| `GAP-06` | 批次停在 `phase=planning`（未做相位迁移） | 该批已 `batch_phase(running)` → `complete` | 批次事件流 |

**口径说明**：`W7F-DOC-N2` / `M-1` / `M-2` / `SWEEP-DOC-*` 采用「**追加订正节、原文不动**」方式（用户裁决：历史判据源不改写）—— 保留「当时按什么标准验收」的可审计性，同时让读者看到正确口径。

## 二、有意保留（2 项，非遗漏；2026-10-21 经变异取证后**重新裁决**）

> **重裁背景**：批 `punky-sleep-assert-20261021` 曾把这两项合并、按「假绿」定性做改造（`30263a7` + `e421981`），随后 **`e2-mutation` 的变异取证推翻了「假绿」前提**，用户裁决**全部回退**（`c895e02`）。下述口径均为**取证后**的准确描述，不再含推测。

| 编号 | 内容 | 保留理由（取证后） | 触发条件 |
| --- | --- | --- | --- |
| `remaining-12-sleep` | `test/watch-hotconfig.test.js` 其余 12 处固定 `sleep` 未改 | ① 用户裁定 **DEBT-1 = 只修 H1**；② **「假绿」在整条用例层面不成立** —— 注入 1500ms 迟到 remount 后 **pre-fix 也红 3 例**（H2/H4/H7），因同一 test 后续几轮 `sleep(1000)`+断言会在 +2000ms 后把同一次迟到计入；③ 改双极后真实收益仅为**敏感度提升**（post-fix 4 红 vs pre-fix 3 红，多抓 H3），代价是该文件 **10.2s → 22.1s**（+11.9s/次，全量 guard 连带）⇒ 收益不值代价 | 该文件再出 flake、或测试时长预算放宽时重评；**改造前先读本行 ②③**（避免再次为「假绿」这个不成立的理由付时间代价） |
| `Q4-RISK` | 不强制 RED-first：测试无法自证「缺陷复发会变红」 | 用户否决 RED-first；且取证发现**该风险在当前判据形态下不可消除**：`waitFor` 的 `lastObserved` 记 `check()` **返回值**，本文件 12 处 check 全布尔 ⇒ 恒为 `"false"`，**拿不到「实际值 N−1」这类可诊断证据**（N-3）；`waitQuiet` 五字段**只在 timeout 出现**，单次迟到是「正常返回但读数错」⇒ 走 `assert.equal`（N-2） | 触碰相关测试的批次应**补阳性对照**（本批已按此执行）；要真正销号须先改判据形态（让 check 返回**实际值**而非布尔），属独立改造 |

**「假绿」判据的三层口径（取证结论，供后续自查复用）**

| 层 | 结论 | 证据形态 |
| --- | --- | --- |
| **单点断言**（那一刻） | **成立** | +1000ms 读 `len=1`、+3500ms 读 `len=2` |
| **整条用例** | **不成立** | pre-fix 也红 3 例（后续轮次会把同一次迟到计入） |
| **合跑** | 未涉 | — |

**⇒ 教训**：判「断言是否可证伪」**必须按层分别判断**，不能用「单点那一瞬的读数」代表整条用例。

**⇒ 附带定位（不随回退丢失）**：冻结的变异注入点 C1 **不可达**，根因 = `config-watch.js:216-221` 对同值内容 `changed.length===0` 即 `return` ⇒ `onChange` 不触发 ⇒ `applyConfigChange` 不执行。后续做同类变异须选「能产生 onChange 且不动 watch 生效面」的面。

## 三、已知问题（2 项，不阻断）

| 编号 | 内容 | 判定 |
| --- | --- | --- |
| `K-1` | guard 计数口径随批次变化（A=B 条目数会涨） | 非缺陷：guard 用**运行期枚举**，不写死期望值 |
| `K-2` | `HOST skip` 1 例（`lane-wake-autodispatch`） | 非缺陷：宿主级用例在本机环境 skip，`t.skip` 显式 |

## 四、跨批指引层变更（2026-10-21，供后人追溯）

| 变更 | 落点 | commit |
| --- | --- | --- |
| persona 两份定义对齐（patch 缺 `0i`、§0 旧短版 → 27 条 / 差异 0） | `cordis.patch.yml` + `presets/punky-preset/agent.cordis.yml` | `554418e` |
| persona 去重（工具能力归工具定义 / 调度指引与操作规范归 preset） | 同上，**净减**（读数一律现算，不写死数字） | `554418e`、`911603b` |
| 模板变量白名单（内核只注册 `provider` / `model`，其他双花括号变量启动即抛） | `agent.cordis.yml` 头注释 | `6dafe83` |
| 指引维护改回**三条判据**；persona 一致性为**人工自维护约定**（不设机器门禁） | `references/discipline.md` §13 | `911603b` |

> **〔订正 2026-10-23 · 批 `punky-fix-house-20261023`（H-F2）〕** 上表原记的「某数 → 某数 字符」一对具体数字**不可复现**（旧读数未写明口径：整文件字符数、`prefix: >-` 块原样字节数、去缩进后码点数，三种口径均算不出旧读数）⇒ **该对数字不再复写**（避免不可复现读数被继续复制）；下方改为**可复算口径 + 实算读数**。
>
> **口径（本仓唯一）**：锚点 = `presets/punky-preset/agent.cordis.yml`（镜像载体 `cordis.patch.yml`）中 `- id: persona` 行 → 其后首个 `prefix: >-` 行 → 取其后**缩进更深**的块（遇缩进 ≤ `prefix:` 行的行终止）→ **去掉块内公共缩进**（= YAML `>-` 折叠语义）→ 数码点（`chars`）与 UTF-8 字节（`bytes`）。**不含** YAML 缩进、不含键名行。
>
> **复算**（`scripts/persona-count.mjs` 随包提供；未落地前用下列同口径内联版，二者判据相同）：
> ```bash
> node scripts/persona-count.mjs presets/punky-preset/agent.cordis.yml cordis.patch.yml
> # 同口径内联版（无脚本时可用）：
> node -e 'const fs=require("fs"),f=process.argv[1],L=fs.readFileSync(f,"utf8").split(/\r?\n/);
> const i=L.findIndex(l=>/^\s*-\s*id:\s*persona\s*$/.test(l));let j=-1;
> for(let k=i+1;k<L.length;k++){if(/^\s*prefix:\s*>-\s*$/.test(L[k])){j=k;break;}}
> const ind=L[j].match(/^\s*/)[0].length,b=[];for(let k=j+1;k<L.length;k++){if(L[k].trim()===""){b.push("");continue;}
> if(L[k].match(/^\s*/)[0].length<=ind)break;b.push(L[k]);}
> while(b.length&&b[b.length-1].trim()==="")b.pop();
> const m=Math.min(...b.filter(l=>l.trim()).map(l=>l.match(/^\s*/)[0].length)),s=b.map(l=>l.slice(m)).join("\n");
> console.log(f+": chars="+[...s].length+" bytes="+Buffer.byteLength(s,"utf8")+" lines="+b.length)' presets/punky-preset/agent.cordis.yml
> ```
>
> **2026-10-23 实测（本口径）**：两载体互为镜像、读数**逐字相等** ⇒ `chars=2976 / bytes=5697`。
> **历史快照同法复算**：`git show 554418e^:packages/dsh-punky-swarm/presets/punky-preset/agent.cordis.yml` 与 `git show 554418e:…` 各存临时文件后同法读 ⇒ `chars 3576 → 3051`、`bytes 6478 → 5788`（= 该次去重的真实净减幅度，与上方「净减」一致）。
> ⇒ **此后 persona 读数一律「口径 + 复算命令」，不写死数字。**

> **注意**：`cordis.patch.yml` 在 boot 期由 loader 组合进 profile ⇒ 上述指引改动**需重启宿主**才进入在役。
