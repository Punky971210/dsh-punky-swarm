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

// webui-config-build-20260903 / 设计 §3 测试表：webui-config-trust——trusted 判定纯函数单测
// 语义契约：自复刻宿主 /api 信任护栏（conn:184-198 未导出故复刻，lib/webui/config-trust.js）——
//   Host 存在且可解析 → hostname loopback 或在 trustedHosts → sec-fetch-site !== 'cross-site'
//   → Origin 存在时 origin.host === Host 的 host（缺省通过）。复刻不放宽不收紧。
import test from 'node:test';
import assert from 'node:assert/strict';
import { isTrustedConfigRequest } from '../lib/webui/config-trust.js';

// 判定封装：headers = { host, 'sec-fetch-site'?, origin? }（Node http 头键小写形态）
const trust = (headers, trustedHosts) => isTrustedConfigRequest({ headers }, trustedHosts);

test('trusted：Host 缺失 → 拒', () => {
  assert.equal(trust({}), false);
  assert.equal(trust({ 'sec-fetch-site': 'same-origin' }), false);
});

test('trusted：Host 不可解析 → 拒', () => {
  assert.equal(trust({ host: '' }), false);
  assert.equal(trust({ host: 'not a host url::' }), false);
});

test('trusted：loopback 四类（localhost / 127.0.0.1 / [::1] / 127.x.y.z 任意端口）→ 过', () => {
  assert.equal(trust({ host: 'localhost' }), true);
  assert.equal(trust({ host: 'localhost:3080' }), true);
  assert.equal(trust({ host: '127.0.0.1' }), true);
  assert.equal(trust({ host: '127.0.0.1:3080' }), true);
  assert.equal(trust({ host: '[::1]:3080' }), true);
  assert.equal(trust({ host: '127.8.9.10:99' }), true);
  assert.equal(trust({ host: '127.0.0.255:1' }), true);
});

test('trusted：非 loopback + trustedHosts 缺省 [] → 拒（出厂仅 loopback 可写）', () => {
  assert.equal(trust({ host: 'example.com' }), false);
  assert.equal(trust({ host: '192.168.1.10:3080' }), false);
  assert.equal(trust({ host: '0.0.0.0:3080' }), false);
  assert.equal(trust({ host: '127.0.0.1.evil.com:3080' }), false); // 127 前缀但非四段纯数字 → 非 loopback
  assert.equal(trust({ host: '127.256.0.1' }), false); // 段 >255 → 非 loopback
});

test('trusted：trustedHosts 无端口条目 = 该 hostname 任意端口 → 过', () => {
  const th = ['example.com'];
  assert.equal(trust({ host: 'example.com' }, th), true);
  assert.equal(trust({ host: 'example.com:8080' }, th), true);
  assert.equal(trust({ host: 'example.com:443' }, th), true);
  assert.equal(trust({ host: 'sub.example.com:8080' }, th), false); // hostname 精确匹配（非子域通配）
  assert.equal(trust({ host: 'other.net:8080' }, th), false);
});

test('trusted：trustedHosts 带端口条目 = host:port 精确 → 仅同端口过', () => {
  const th = ['example.com:8443'];
  assert.equal(trust({ host: 'example.com:8443' }, th), true);
  assert.equal(trust({ host: 'example.com:8080' }, th), false);
  assert.equal(trust({ host: 'example.com' }, th), false);
});

test('trusted：sec-fetch-site=cross-site → 拒（跨站简单请求面封闭）；非 cross-site 不受影响', () => {
  assert.equal(trust({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(trust({ host: 'example.com:8443', 'sec-fetch-site': 'cross-site' }, ['example.com:8443']), false);
  assert.equal(trust({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }), true);
  assert.equal(trust({ host: '127.0.0.1:3080', 'sec-fetch-site': 'none' }), true);
});

test('trusted：Origin 缺失 → 过（非浏览器客户端/同源缺省通过）', () => {
  assert.equal(trust({ host: '127.0.0.1:3080' }), true);
  assert.equal(trust({ host: 'localhost:3080' }), true);
});

test('trusted：Origin 同 host → 过（scheme 不影响判定，与 conn 同构）；异 host → 拒', () => {
  assert.equal(trust({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }), true);
  assert.equal(trust({ host: '127.0.0.1:3080', origin: 'https://127.0.0.1:3080' }), true);
  assert.equal(trust({ host: 'example.com:8443', origin: 'http://example.com:8443' }, ['example.com:8443']), true);
  assert.equal(trust({ host: '127.0.0.1:3080', origin: 'http://evil.example:3080' }), false);
  assert.equal(trust({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:9999' }), false); // 同 hostname 异端口 → 拒
});

test('trusted：Origin 不可解析 → 拒（异常 Origin 不静默放行）', () => {
  assert.equal(trust({ host: '127.0.0.1:3080', origin: 'not a url:::' }), false);
  assert.equal(trust({ host: '127.0.0.1:3080', origin: '' }), false); // 空串非 undefined → parse 拒
});
