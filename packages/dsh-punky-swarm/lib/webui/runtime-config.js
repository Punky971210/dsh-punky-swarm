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

// lib/webui/runtime-config.js —— WebUI 治理配置写通道服务（webui-config-build-20260903）
// 端点 POST /api/dsh-punky-swarm/config 的写侧：受控白名单预检（拒绝而非回退）→ 读-改-写保留语义
//   → validateOverlay 兜底 → tmp+rename 原子写 <root>/config/runtime.json。
// 依据：webui-config-design.md §1.4（校验）/§1.5（原子写）；宿主事实 eval/host-impl-facts.md §③/§④。
// 语义要点：
//   - 读-改-写保留：读现有 runtime.json（缺失 = {}）→ 仅替换顶层 governance 段 → 写回全量。
//     其它顶层键（aip/acps/capabilities/mailbox/resume/ratchet/escalation）与 governance.hook 内
//     非表单键（rules/defaults/pause/defer）原样保留——写通道是「受控改键」，不做全量替换。
//   - preset 省略（payload.hook 无 preset 键）= 删键回静态出厂空表（叠加语义，T4-4 模式）；
//     escalation/flags/enabled 省略 = 该键不动（escalation 显式整段合并：{...cur, ...form}）。
//   - 服务端自做值域预检（validateOverlay 不做 governance 深度校验的缺口，§1.4）——
//     拒绝（400 errors 逐字段 code）而非引擎式回退，给表单可操作回显。
//   - 预检通过仍跑 validateOverlay(全量 overlay) 兜底：保证写入内容必被 watcher 接受、
//     热更确定性生效；兜底失败 → 500 不回写（不应发生）。
//   - 原子写：同目录写临时文件（.runtime.json.tmp）→ renameSync——写入必须走 rename 而非
//     直接 writeFile，watch 只看到完整文件（config-watch 文件级 watch 实施回注，cw:29-33）。
// 零 ctx 依赖、fs 封装可单测；只 import config-watch 的 validateOverlay（导出面）+ preset-loader 的
//   PRESET_IDS（注册 id 枚举唯一权威，不接受任意路径引用）。
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateOverlay } from '../hot/config-watch.js';
import { PRESET_IDS } from '../governance/preset-loader.js';

// 受控表单 escalation.primitives 合法值域 = 引擎 resolve 合法域（governance/config.js resolveEscalationConfig
//   ——DENY/NARROW/DEFER/PAUSE；REQUIRE_APPROVAL 与状态门收据不可配入，config.js:177 红线）。
//   config.ts 未导出该枚举（governance/*.js 为 .ts 编译产物，不动源防环）——此处本地持字面量 +
//   交叉引用注释；改引擎枚举须同步此处（两端同源，注释锚 config.js:37）。
const ESCALATION_PRIMITIVE_SET = new Set(['DENY', 'NARROW', 'DEFER', 'PAUSE']);

// 受控字段集白名单（§1.4-1/2）：body 顶层仅 governance；governance 仅 hook；hook 仅表单四键。
const TOP_KEYS = new Set(['governance']);
const GOV_KEYS = new Set(['hook']);
const HOOK_FORM_KEYS = new Set(['enabled', 'preset', 'escalation', 'flags']);
// windowSeconds（秒，webui-config-fix2-20260904 新语义提交字段）= UI 输入单位；后端 ×1000 归一
//   windowMs（毫秒）落盘——runtime.json 存储契约（windowMs ms）不变。windowMs（ms）字段保留旧语义
//   向后兼容（既有 api-config/webui-runtime-config 测试与调用方不破）。
const ESC_FORM_KEYS = new Set(['enabled', 'threshold', 'windowMs', 'windowSeconds', 'primitives']);
const FLAG_FORM_KEYS = new Set(['narrow']);

// 规则表冲突守卫的错误文案（§1.4-4）——表单不改写/清空手工 rules 的静默覆盖防护
const INLINE_RULES_CONFLICT_MSG = '检测到手工 rules（governance.hook.rules 非空）；preset 切换会与手工规则并存/冲突——'
  + '请先手工移除 rules 或保持 preset 不变（受控表单不提供清空 rules 动作）';

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ── 服务端受控白名单预检（纯函数、零 IO，§1.4）──
// payload = POST 请求体 { governance: { hook: {...} } }；curHook = 当前文件 governance.hook（可选，
//   提供时追加 §1.4-4 规则表冲突守卫——preset 相对现有引用有变化 + 现有 overlay rules 非空 → 拒绝）。
// 返回 { ok, errors: [{ field, code, message }] }——400 拒绝而非回退（值域判据 = 引擎 resolve 合法域，
//   不发明引擎外上封顶）。code 枚举（UI 双语映射键）：unknown-top-level / field-not-allowed /
//   unknown-preset / preset-conflicts-inline-rules / invalid-value。
export function validateGovernancePayload(payload, curHook) {
  const errors = [];
  const push = (field, code, message) => errors.push({ field, code, message });

  if (!isPlainObject(payload)) {
    push('payload', 'invalid-value', 'request body must be a JSON object');
    return { ok: false, errors };
  }
  // ① 顶层键预检：body 顶层仅允许 governance
  for (const k of Object.keys(payload)) {
    if (!TOP_KEYS.has(k)) push(k, 'unknown-top-level', `unknown top-level key '${k}'（受控写通道仅接受 governance）`);
  }
  if (!isPlainObject(payload.governance)) {
    push('governance', 'invalid-value', 'governance must be a JSON object');
    return { ok: false, errors };
  }
  for (const k of Object.keys(payload.governance)) {
    if (!GOV_KEYS.has(k)) push(`governance.${k}`, 'field-not-allowed', `governance 仅接受 hook 子键（got '${k}'）`);
  }
  if (!isPlainObject(payload.governance.hook)) {
    push('governance.hook', 'invalid-value', 'governance.hook must be a JSON object');
    return { ok: false, errors };
  }
  const hook = payload.governance.hook;
  // ② hook 子键白名单：enabled | preset | escalation | flags（rules/defaults/pause/defer 等表单外键拒绝）
  for (const k of Object.keys(hook)) {
    if (!HOOK_FORM_KEYS.has(k)) {
      push(`governance.hook.${k}`, 'field-not-allowed',
        `form field '${k}' not allowed（受控表单不开放任意规则 JSON——编辑 rules/defaults 走手工 runtime.json 路径，不会被表单误清）`);
    }
  }

  // ③ 逐字段值域（值域判据 = 引擎 resolve 合法域：governance/config.js resolveEscalationConfig / preset-loader.js）
  if ('enabled' in hook && typeof hook.enabled !== 'boolean') {
    push('governance.hook.enabled', 'invalid-value', 'enabled must be boolean');
  }
  if ('preset' in hook && hook.preset !== undefined) {
    const badPreset = (field, message) => push(field, 'invalid-value', message);
    const p = hook.preset;
    if (typeof p === 'string') {
      if (p.length === 0) badPreset('governance.hook.preset', 'preset must not be an empty string（省略该键 = 出厂空表）');
      else if (!PRESET_IDS.includes(p)) push('governance.hook.preset', 'unknown-preset',
        `unknown preset id '${p}'（注册 id 枚举：${PRESET_IDS.join(' / ')}）`);
    } else if (Array.isArray(p)) {
      if (p.length === 0) badPreset('governance.hook.preset', 'preset array must not be empty（空引用无意义；省略该键 = 出厂空表）');
      p.forEach((el, i) => {
        if (typeof el !== 'string') {
          badPreset(`governance.hook.preset[${i}]`, `preset element must be a string（got ${JSON.stringify(el)}）`);
        } else if (el.length === 0) {
          badPreset(`governance.hook.preset[${i}]`, 'preset element must not be an empty string');
        } else if (!PRESET_IDS.includes(el)) {
          push('governance.hook.preset', 'unknown-preset',
            `unknown preset id '${el}'（注册 id 枚举：${PRESET_IDS.join(' / ')}）`);
        }
      });
    } else {
      badPreset('governance.hook.preset', `preset must be a registered id string | string[]（got ${JSON.stringify(p)}）`);
    }
  }
  if ('escalation' in hook) {
    const esc = hook.escalation;
    if (!isPlainObject(esc)) {
      push('governance.hook.escalation', 'invalid-value', 'escalation must be a JSON object');
    } else {
      for (const k of Object.keys(esc)) {
        if (!ESC_FORM_KEYS.has(k)) push(`governance.hook.escalation.${k}`, 'field-not-allowed',
          `escalation form key '${k}' not allowed（仅 ${[...ESC_FORM_KEYS].join(' / ')}）`);
      }
      if ('enabled' in esc && typeof esc.enabled !== 'boolean') {
        push('governance.hook.escalation.enabled', 'invalid-value', 'escalation.enabled must be boolean');
      }
      if ('threshold' in esc) {
        const t = esc.threshold;
        if (typeof t !== 'number' || !Number.isInteger(t) || t < 1) {
          push('governance.hook.escalation.threshold', 'invalid-value', 'threshold must be an integer >= 1');
        }
      }
      // 窗口单位（webui-config-fix2-20260904）：windowSeconds（秒，新语义，≥1s）+ windowMs（毫秒，旧语义
      //   ≥1000ms，向后兼容）互斥——同送拒绝（歧义）；换算在写路径 ×1000 归一（毫秒存储契约不变）。
      if ('windowMs' in esc && 'windowSeconds' in esc) {
        push('governance.hook.escalation.windowSeconds', 'invalid-value',
          'windowSeconds (s) and windowMs (ms) are mutually exclusive — send either the new windowSeconds (UI seconds) or the legacy windowMs (ms)');
      } else {
        if ('windowMs' in esc) {
          const w = esc.windowMs;
          if (typeof w !== 'number' || !Number.isFinite(w) || w < 1000) {
            push('governance.hook.escalation.windowMs', 'invalid-value', 'windowMs must be a finite number >= 1000 (ms)');
          }
        }
        if ('windowSeconds' in esc) {
          const s = esc.windowSeconds;
          if (typeof s !== 'number' || !Number.isFinite(s) || s < 1) {
            push('governance.hook.escalation.windowSeconds', 'invalid-value', 'windowSeconds must be a finite number >= 1 (s)');
          }
        }
      }
      if ('primitives' in esc) {
        const pr = esc.primitives;
        if (!Array.isArray(pr)) {
          push('governance.hook.escalation.primitives', 'invalid-value', 'primitives must be an array');
        } else if (pr.length === 0) {
          push('governance.hook.escalation.primitives', 'invalid-value',
            'primitives must not be empty（空列表引擎会回退默认；省略该键保持现状）');
        } else {
          pr.forEach((p2, i) => {
            if (typeof p2 !== 'string' || !ESCALATION_PRIMITIVE_SET.has(p2)) {
              push('governance.hook.escalation.primitives', 'invalid-value',
                `invalid primitive ${JSON.stringify(p2)}（仅可配 ${[...ESCALATION_PRIMITIVE_SET].join(' / ')}；REQUIRE_APPROVAL 与状态门收据不可配入）`);
            }
          });
        }
      }
    }
  }
  if ('flags' in hook) {
    const f = hook.flags;
    if (!isPlainObject(f)) {
      push('governance.hook.flags', 'invalid-value', 'flags must be a JSON object');
    } else {
      for (const k of Object.keys(f)) {
        if (!FLAG_FORM_KEYS.has(k)) push(`governance.hook.flags.${k}`, 'field-not-allowed',
          `flags form key '${k}' not allowed（仅 narrow 可经表单；pause/defer 走手工 runtime.json 路径）`);
      }
      if ('narrow' in f && typeof f.narrow !== 'boolean') {
        push('governance.hook.flags.narrow', 'invalid-value', 'flags.narrow must be boolean');
      }
    }
  }

  // ④ 规则表冲突守卫（受控写入的静默覆盖防护）：现有 overlay rules 非空（用户手工规则）且
  //   本次 preset 相对现有引用有变化 → 拒绝。preset 省略 = 删键 = 引用变化（回静态）。
  if (errors.length === 0 && curHook !== undefined) {
    const curRules = Array.isArray(curHook?.rules) ? curHook.rules : [];
    if (curRules.length > 0) {
      const curRefKey = presetRefKey(curHook?.preset);
      const nextRef = 'preset' in hook ? hook.preset : undefined; // 省略 = 删键（§1.5）
      if (presetRefKey(nextRef) !== curRefKey) {
        push('governance.hook.preset', 'preset-conflicts-inline-rules', INLINE_RULES_CONFLICT_MSG);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// preset 引用比较键（cur=文件现态，含非法形态——容错映射为 distinct 键，非法即变化）
function presetRefKey(ref) {
  if (ref === undefined || ref === null) return 'none';
  if (typeof ref === 'string') return 's:' + ref;
  if (Array.isArray(ref)) return 'a:' + ref.map(String).join(',');
  return 'x:' + JSON.stringify(ref);
}

// 写通道服务：<root>/config/runtime.json（governance 段受控写键；读-改-写 + validateOverlay 兜底 + 原子写）
export function createRuntimeConfigService({ root, logger } = {}) {
  const configDir = join(root, 'config');
  const runtimeFile = join(configDir, 'runtime.json');

  // 读现有 runtime.json（缺失 = {}）；坏 JSON/非对象 → throw（错误信息含路径）——
  // 写路径拒写不吞：其它顶层键无法保全时宁 500 不回写（坏 base 属运维错误，见 §1.5「不应发生」）
  function readOverlay() {
    if (!existsSync(runtimeFile)) return {};
    const raw = readFileSync(runtimeFile, 'utf8');
    const parsed = JSON.parse(raw); // 坏 JSON → SyntaxError 上抛
    if (!isPlainObject(parsed)) throw new Error('runtime.json must be a JSON object: ' + runtimeFile);
    return parsed;
  }

  // 保存 governance 受控字段集：{ ok:true, written } | { ok:false, status:400|500, errors|error }
  function writeGovernance(payload) {
    let overlay;
    try {
      overlay = readOverlay(); // 坏 base JSON → 归一到 500 不回写（其它顶层键无法保全）
    } catch (e) {
      return { ok: false, status: 500, error: 'runtime.json unreadable: ' + String(e?.message ?? e) };
    }
    const curGov = isPlainObject(overlay.governance) ? overlay.governance : {};
    const curHook = isPlainObject(curGov.hook) ? curGov.hook : {};
    const v = validateGovernancePayload(payload, curHook);
    if (!v.ok) return { ok: false, status: 400, errors: v.errors };

    // 读-改-写保留：仅替换 governance 段；hook 内非表单键（rules/defaults/pause/defer）经 curHook 展开原样保留
    const hook = payload.governance.hook;
    const nextHook = { ...curHook };
    if ('enabled' in hook) nextHook.enabled = hook.enabled;
    if (!('preset' in hook)) delete nextHook.preset; // 未选 = 删键（回静态出厂空表，T4-4 叠加语义）
    else if (hook.preset !== undefined) nextHook.preset = hook.preset;
    if ('escalation' in hook) {
      const esc = isPlainObject(curHook.escalation) ? curHook.escalation : {};
      nextHook.escalation = { ...esc, ...pickEscalationSubset(hook.escalation) };
    }
    if ('flags' in hook) {
      const flags = isPlainObject(curHook.flags) ? curHook.flags : {};
      const narrow = 'narrow' in hook.flags ? { narrow: hook.flags.narrow } : {};
      nextHook.flags = { ...flags, ...narrow };
    }
    const nextGov = { ...curGov, hook: nextHook };
    const nextOverlay = { ...overlay, governance: nextGov };

    // validateOverlay 兜底（§1.4-5）：保证写入内容必被 watcher 接受（热更确定性生效）——失败 500 不回写
    const gate = validateOverlay(nextOverlay);
    if (!gate.ok) {
      return { ok: false, status: 500, error: 'overlay-rejected: ' + gate.errors.join('; ') };
    }

    // 原子写：同目录 tmp + rename（tmp 放 runtime.json 同目录——rename 需同卷原子；watch 只看到完整文件）
    mkdirSync(configDir, { recursive: true });
    const tmp = join(configDir, '.runtime.json.tmp');
    writeFileSync(tmp, JSON.stringify(nextOverlay, null, 2) + '\n', 'utf8');
    renameSync(tmp, runtimeFile);
    return { ok: true, written: nextGov };
  }

  return { runtimeFile, readOverlay, writeGovernance };
}

// 从已验证的 escalation 段摘出「显式提交」的子键（仅本表单键，逐字段值域已在 validate 保证）。
// 窗口单位归一（webui-config-fix2-20260904）：windowSeconds（秒）→ ×1000 换算为 windowMs 落盘
//   （runtime.json 毫秒存储契约不变，windowSeconds 为线协议键不落盘）；旧 windowMs（毫秒）原样
//   透传（向后兼容——不二次换算）。两者同送已在 validate 阶段互斥拒绝。
function pickEscalationSubset(esc) {
  const sub = {};
  for (const k of ['enabled', 'threshold', 'primitives']) {
    if (k in esc) sub[k] = esc[k];
  }
  if ('windowSeconds' in esc) sub.windowMs = esc.windowSeconds * 1000;
  else if ('windowMs' in esc) sub.windowMs = esc.windowMs;
  return sub;
}
