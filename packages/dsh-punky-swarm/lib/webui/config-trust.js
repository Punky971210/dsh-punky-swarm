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

// lib/webui/config-trust.js —— 自复刻宿主 /api 信任护栏语义（conn:184-198，未导出故复刻）
// 背景（eval/host-impl-facts.md ①）：插件以 kind:'exact' 自注册的 webServer 路由先于宿主 /api prefix
//   命中（host-web exact 优先），不经宿主 isTrustedApiRequest 护栏——新增写端点后跨站 POST 面成立
//   （同源策略不拦简单请求副作用），故写端点须自复刻宿主护栏判定（GET 同走——与宿主护栏对读请求
//   一致：护栏语义非鉴权层、防的是 DNS-rebinding/跨站）。
// 语义契约全文 = api-request-trust.d.ts 43 行 + conn:100-104（loopback 分类）——复刻不放宽不收紧：
//   Host 头必须存在且可解析 → hostname 是 loopback 或在 trustedHosts → sec-fetch-site !== 'cross-site'
//   → Origin 存在时 origin.host === Host 的 host（缺省通过）。纯函数、零宿主依赖、可单测。

// 读取请求头（Node http 头键已小写；测试直调形态同构）
function header(h, name) {
  const v = h && h[name];
  return typeof v === 'string' ? v : undefined;
}

// loopback 分类（conn:100-104）：localhost / [::1] / 127/8 IPv4（WHATWG hostname，IPv6 保留括号）
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127'
    && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

// trustedHosts 条目匹配（conn:148-176 语义）：无端口条目 = 该 hostname 任意端口；带端口 = host:port 精确。
// 条目在装配时已断言为裸 authority（host | host:port，canonical 形态），此处只做比对。
export function isTrustedAuthority(hostUrl, trustedHosts) {
  return (trustedHosts || []).some((entry) => {
    let u; try { u = new URL('http://' + entry); } catch { return false; }
    const entryPort = u.port !== '' ? u.port : new URL('https://' + entry).port; // canonicalAuthority 语义
    return entryPort === '' ? u.hostname === hostUrl.hostname : u.host === hostUrl.host;
  });
}

// 判定（conn:184-198 同构）：Host 存在且可解析 → hostname loopback 或在 trustedHosts →
// sec-fetch-site !== 'cross-site' → Origin 存在时 origin.host === Host 的 host（缺省通过）
export function isTrustedConfigRequest(req, trustedHosts = []) {
  const host = header(req.headers, 'host');
  if (host === undefined) return false;
  let hostUrl; try { hostUrl = new URL('http://' + host); } catch { return false; }
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false;
  const origin = header(req.headers, 'origin');
  if (origin === undefined) return true;
  try { return new URL(origin).host === hostUrl.host; } catch { return false; }
}
