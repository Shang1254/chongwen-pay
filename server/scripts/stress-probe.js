// ============================================================
// 极限探测脚本：逐级加并发，找系统的"拐点/崩溃点"
// 用法：node scripts/stress-probe.js http://127.0.0.1:3100
// 注意：只发读请求，不会写账单；会创建 1 个测试账号，结束后删除
// ============================================================
const http = require('http');
const { pool } = require('../db/pool');

const BASE = process.argv[2] || 'http://127.0.0.1:3100';
const LEVELS = [100, 200, 300, 400, 600, 800];
const DURATION = 5000;

const agent = new http.Agent({ keepAlive: true, maxSockets: 1500 });

function req(method, p, body, token) {
  return new Promise(function (resolve) {
    const url = new URL(BASE + p);
    const data = body ? JSON.stringify(body) : null;
    const started = Date.now();
    const r = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: method, agent: agent,
      headers: Object.assign(
        { 'Content-Type': 'application/json; charset=utf-8' },
        token ? { Authorization: 'Bearer ' + token } : {},
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}
      ),
      timeout: 20000
    }, function (res) {
      let raw = '';
      res.on('data', function (c) { raw += c; });
      res.on('end', function () {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (e) { json = null; }
        resolve({ status: res.statusCode, json: json, ms: Date.now() - started });
      });
    });
    r.on('timeout', function () { r.destroy(); });
    r.on('error', function () { resolve({ status: 0, json: null, ms: Date.now() - started }); });
    if (data) r.write(data);
    r.end();
  });
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const a = arr.slice().sort(function (x, y) { return x - y; });
  return a[Math.min(a.length - 1, Math.ceil(p / 100 * a.length) - 1)];
}

async function main() {
  console.log('目标: ' + BASE + '，每档 ' + DURATION / 1000 + ' 秒');
  const admin = await req('POST', '/api/admin/login', { username: 'admin', password: 'admin123' });
  const at = admin.json.data.token;
  const login = await req('POST', '/api/user/login', { code: 'x', mockId: 'stress-' + Date.now() });
  const rt = login.json.data.token;
  const uid = login.json.data.user.id;
  await req('POST', '/api/user/test-entry', { code: 'CWLT-2-2026' }, rt);
  const hs = await req('GET', '/api/admin/households', null, at);
  const h = hs.json.data[0];
  const m = h.roomLabel.match(/栋(\d+)单元(\d+)室/);
  await req('POST', '/api/user/bind', { unit: m[1], roomNo: m[2], ownerName: h.ownerName }, rt);

  let breaking = 0;
  for (const c of LEVELS) {
    const lat = [];
    let err = 0;
    const st = {};
    const end = Date.now() + DURATION;

    async function worker() {
      while (Date.now() < end) {
        const r = Math.random();
        let res;
        if (r < 0.2) res = await req('GET', '/api/health');
        else if (r < 0.5) res = await req('GET', '/api/admin/unpaid', null, at);
        else if (r < 0.8) res = await req('GET', '/api/bill/list', null, rt);
        else res = await req('GET', '/api/admin/overview', null, at);
        if (res.status >= 200 && res.status < 300) lat.push(res.ms);
        else { err++; st[res.status] = (st[res.status] || 0) + 1; }
      }
    }

    const workers = [];
    for (let i = 0; i < c; i++) workers.push(worker());
    await Promise.all(workers);

    const total = lat.length + err;
    const qps = +(lat.length / (DURATION / 1000)).toFixed(1);
    const errorRate = total ? +(err / total * 100).toFixed(2) : 0;
    console.log(c + ' 并发 → QPS ' + qps + '，p50 ' + pct(lat, 50) + 'ms，p95 ' + pct(lat, 95) +
      'ms，p99 ' + pct(lat, 99) + 'ms，错误率 ' + errorRate + '% ' + JSON.stringify(st));

    if ((errorRate > 5 || pct(lat, 95) > 5000) && c >= 200) {
      breaking = c;
      console.log('>> 拐点：' + c + ' 并发时开始明显劣化');
      break;
    }
  }

  const health = await req('GET', '/api/health');
  console.log('压完后健康检查：' + (health.json && health.json.ok ? '服务仍然存活 ✓' : '服务异常 ✗'));

  // 清理探测账号
  await pool.query('DELETE FROM bindings WHERE user_id = ?', [uid]);
  await pool.query('DELETE FROM check_logs WHERE user_id = ?', [uid]);
  await pool.query('DELETE FROM users WHERE id = ?', [uid]);
  try { await pool.end(); } catch (e) { /* ignore */ }
  console.log('探测账号已清理' + (breaking ? '，拐点并发=' + breaking : '，最高档仍未击垮'));
  process.exit(0);
}

main().catch(function (e) {
  console.error('探测失败：', e.message);
  process.exit(1);
});
