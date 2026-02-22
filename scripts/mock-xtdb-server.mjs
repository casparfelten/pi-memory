import http from 'node:http';
import { URL } from 'node:url';

const port = Number(process.env.XTDB_PORT || 3000);
const docs = new Map();

const json = (res, code, data) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);

  if (url.pathname === '/_xtdb/status') return json(res, 200, { status: 'ok' });

  if (req.method === 'POST' && url.pathname === '/_xtdb/submit-tx') {
    const body = await new Promise((resolve) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => resolve(d));
    });
    const parsed = JSON.parse(body || '{}');
    const put = parsed.txOps?.[0]?.[1];
    const id = put['xt/id'] ?? put.id;
    const txTime = new Date().toISOString();
    const existing = docs.get(id) ?? [];
    existing.push({ ...put, 'xt/id': id, txTime });
    docs.set(id, existing);
    return json(res, 200, { txTime });
  }

  if (req.method === 'GET' && url.pathname === '/_xtdb/entity') {
    const id = url.searchParams.get('eid');
    const history = url.searchParams.get('history') === 'true';
    const validTime = url.searchParams.get('valid-time');
    const versions = docs.get(id) ?? [];
    if (history) return json(res, 200, versions);
    if (validTime) {
      const v = [...versions].reverse().find((x) => x.txTime <= validTime) ?? null;
      return json(res, 200, v);
    }
    return json(res, 200, versions.at(-1) ?? null);
  }

  if (req.method === 'POST' && url.pathname === '/_xtdb/query') {
    const body = await new Promise((resolve) => {
      let d = '';
      req.on('data', (c) => (d += c));
      req.on('end', () => resolve(d));
    });
    const parsed = JSON.parse(body || '{}');
    const text = JSON.stringify(parsed.query);
    if (text.includes('file')) {
      const rows = [...docs.values()].map((v) => v.at(-1)).filter((d) => d?.type === 'file');
      return json(res, 200, rows);
    }
    return json(res, 200, []);
  }

  json(res, 404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock xtdb listening on ${port}`);
});
