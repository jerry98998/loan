/**
 * 房贷看板 · 云同步（Cloudflare Worker + KV）
 *
 * 接口：
 *   GET  /api/state   → 返回 JSON 数据（小组件、网页都读它）
 *   PUT  /api/state   → 覆盖保存（网页「上传到云端」）
 *   GET  /            → 健康检查
 *
 * 鉴权：请求头 Authorization: Bearer <TOKEN>，TOKEN 用 wrangler secret 设置。
 * 存储：KV 命名空间 LOAN_KV，键 state。
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, CORS, extra || {}),
  });
}

function bearer(req) {
  const h = req.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, service: 'loan-sync', hasToken: !!env.TOKEN });
    }

    if (url.pathname !== '/api/state') return json({ error: 'not_found' }, 404);

    if (!env.TOKEN) return json({ error: 'server_misconfigured', hint: 'wrangler secret put TOKEN' }, 500);
    if (bearer(req) !== env.TOKEN) return json({ error: 'unauthorized' }, 401);

    if (req.method === 'GET') {
      const raw = await env.LOAN_KV.get('state');
      if (!raw) return json({ error: 'empty', hint: '先在网页里点一次「上传到云端」' }, 404);
      return new Response(raw, {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
      });
    }

    if (req.method === 'PUT') {
      const raw = await req.text();
      if (raw.length > 512 * 1024) return json({ error: 'too_large' }, 413);

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return json({ error: 'bad_json' }, 400);
      }
      if (!parsed || !Array.isArray(parsed.loans)) return json({ error: 'bad_shape', hint: '需要 { loans: [...] }' }, 400);

      parsed.updatedAt = new Date().toISOString();
      await env.LOAN_KV.put('state', JSON.stringify(parsed));
      return json({ ok: true, loans: parsed.loans.length, updatedAt: parsed.updatedAt });
    }

    return json({ error: 'method_not_allowed' }, 405, { Allow: 'GET, PUT, OPTIONS' });
  },
};
