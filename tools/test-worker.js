/* tools/test-worker.js — 用 Node 内置的 Request/Response 直接跑 Worker
 * 用法：node tools/test-worker.js
 */
'use strict';

const path = require('path');

const worker = require(path.resolve(__dirname, '..', 'worker', 'src', 'index.js'));
const fetchHandler = worker.default.fetch;

function makeEnv(token) {
  const store = {};
  return {
    TOKEN: token,
    LOAN_KV: {
      async get(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      async put(k, v) { store[k] = v; },
    },
    _store: store,
  };
}

const BASE = 'https://loan-sync.test';
let pass = 0;
const fails = [];

function ok(cond, msg) {
  if (cond) pass += 1;
  else fails.push(msg);
}

function req(method, path, opts) {
  const o = Object.assign({ method }, opts || {});
  return new Request(BASE + path, o);
}

(async function main() {
  const env = makeEnv('s3cret');

  // 1. 健康检查
  let r = await fetchHandler(req('GET', '/'), env);
  const body1 = await r.json();
  ok(r.status === 200 && body1.ok === true && body1.hasToken === true, '健康检查');

  // 2. 未带令牌
  r = await fetchHandler(req('GET', '/api/state'), env);
  ok(r.status === 401, '无令牌 401');

  // 3. 令牌错误
  r = await fetchHandler(req('GET', '/api/state', { headers: { Authorization: 'Bearer wrong' } }), env);
  ok(r.status === 401, '错令牌 401');

  // 4. 还没数据
  r = await fetchHandler(req('GET', '/api/state', { headers: { Authorization: 'Bearer s3cret' } }), env);
  ok(r.status === 404, '空数据 404');

  // 5. 写入
  const payload = { v: 1, name: '我的房贷', loans: [{ id: 'a', principal: 1000000 }] };
  r = await fetchHandler(req('PUT', '/api/state', {
    headers: { Authorization: 'Bearer s3cret', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }), env);
  const put = await r.json();
  ok(r.status === 200 && put.ok === true && put.loans === 1, 'PUT 成功');
  ok(!!put.updatedAt, 'PUT 补了 updatedAt');

  // 6. 读回来
  r = await fetchHandler(req('GET', '/api/state', { headers: { Authorization: 'Bearer s3cret' } }), env);
  const got = await r.json();
  ok(r.status === 200 && got.loans.length === 1 && got.name === '我的房贷', 'GET 读回一致');
  ok(!!got.updatedAt, 'GET 带 updatedAt');
  ok(r.headers.get('access-control-allow-origin') === '*', 'GET 带 CORS 头');

  // 7. 坏 JSON
  r = await fetchHandler(req('PUT', '/api/state', {
    headers: { Authorization: 'Bearer s3cret' },
    body: '{oops',
  }), env);
  ok(r.status === 400, '坏 JSON 400');

  // 8. 结构不对
  r = await fetchHandler(req('PUT', '/api/state', {
    headers: { Authorization: 'Bearer s3cret' },
    body: JSON.stringify({ hello: 1 }),
  }), env);
  ok(r.status === 400, '缺 loans 400');

  // 9. 预检
  r = await fetchHandler(req('OPTIONS', '/api/state'), env);
  ok(r.status === 204, 'OPTIONS 204');
  ok((r.headers.get('access-control-allow-headers') || '').toLowerCase().includes('authorization'), '预检允许 Authorization');

  // 10. 其它路径 / 方法
  r = await fetchHandler(req('GET', '/nope'), env);
  ok(r.status === 404, '未知路径 404');
  r = await fetchHandler(req('DELETE', '/api/state', { headers: { Authorization: 'Bearer s3cret' } }), env);
  ok(r.status === 405, 'DELETE 405');

  // 11. 没配 TOKEN
  r = await fetchHandler(req('GET', '/api/state'), makeEnv(''));
  ok(r.status === 500, '未配置 TOKEN 500');

  // 12. 覆盖写
  await fetchHandler(req('PUT', '/api/state', {
    headers: { Authorization: 'Bearer s3cret' },
    body: JSON.stringify({ loans: [] }),
  }), env);
  r = await fetchHandler(req('GET', '/api/state', { headers: { Authorization: 'Bearer s3cret' } }), env);
  const after = await r.json();
  ok(after.loans.length === 0, '覆盖写生效');

  console.log('--- worker ----------');
  console.log('passed ' + pass + ' failed ' + fails.length);
  fails.forEach((f) => console.log('FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
