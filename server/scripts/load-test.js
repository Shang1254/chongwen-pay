// ============================================================
// 压力测试脚本（零依赖，Node 自带 http）
// 目的：验证系统在并发压力下会不会被击垮
//
// 用法（在 server 目录）：
//   node scripts/load-test.js --base http://127.0.0.1:3100 --report loadtest-report.md
//   node scripts/load-test.js --quick          （快速版，约 1 分钟）
//
// 前置：
//   1. 目标服务已启动（run-loadtest.bat 会自动在 3100 端口起一个独立实例）
//   2. 已执行 db/migrate-v2.js（新表/字段/索引）
//   3. 测试实例需设置 CWLT_DISABLE_RATE_LIMIT=1（run-loadtest.bat 已处理）
//
// 安全说明：
//   · 测试账单统一用 "1990-xx" 账期作为标记，结束后自动删除
//   · 测试用户 openid 带 load- 前缀，结束后按 id 区间清理
//   · 不会删除真实账单/真实用户；不会改动本月账单
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../config');
const { pool } = require('../db/pool');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const BASE = arg('base', 'http://127.0.0.1:3000');
const QUICK = argv.indexOf('--quick') >= 0;
const DO_CLEANUP = argv.indexOf('--no-cleanup') < 0;
const REPORT = path.resolve(arg('report', path.join(__dirname, '..', '..', 'loadtest-report.md')));
const TEST_PREFIX = '1990-';   // 测试账单账期前缀

// ---------- HTTP 客户端（keep-alive，模拟真实高频请求） ----------
const agent = new http.Agent({ keepAlive: true, maxSockets: 600 });

function request(method, p, body, token, timeoutMs) {
  return new Promise(function (resolve) {
    let url;
    try { url = new URL(BASE + p); } catch (e) { return resolve({ status: 0, json: null, ms: 0 }); }
    const data = body ? JSON.stringify(body) : null;
    const started = Date.now();
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: method,
      agent: agent,
      headers: Object.assign(
        { 'Content-Type': 'application/json; charset=utf-8' },
        token ? { Authorization: 'Bearer ' + token } : {},
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}
      ),
      timeout: timeoutMs || 15000
    }, function (res) {
      let raw = '';
      res.on('data', function (c) { raw += c; });
      res.on('end', function () {
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch (e) { json = null; }
        resolve({ status: res.statusCode, json: json, ms: Date.now() - started });
      });
    });
    req.on('timeout', function () { req.destroy(); });
    req.on('error', function () { resolve({ status: 0, json: null, ms: Date.now() - started }); });
    if (data) req.write(data);
    req.end();
  });
}

const GET = function (p, t) { return request('GET', p, null, t); };
const POST = function (p, b, t) { return request('POST', p, b, t); };

// ---------- 统计 ----------
function percentile(arr, p) {
  if (!arr.length) return 0;
  const a = arr.slice().sort(function (x, y) { return x - y; });
  const idx = Math.min(a.length - 1, Math.ceil(p / 100 * a.length) - 1);
  return a[Math.max(0, idx)];
}

function summarize(name, concurrency, lat, errors, statuses, durationMs, extra) {
  const total = lat.length;
  const sum = lat.reduce(function (s, v) { return s + v; }, 0);
  const base = {
    name: name,
    concurrency: concurrency,
    durationMs: durationMs,
    total: total,
    errors: errors,
    errorRate: total + errors ? +(errors / (total + errors) * 100).toFixed(2) : 0,
    qps: +(total / (durationMs / 1000)).toFixed(1),
    avg: total ? Math.round(sum / total) : 0,
    p50: percentile(lat, 50),
    p90: percentile(lat, 90),
    p95: percentile(lat, 95),
    p99: percentile(lat, 99),
    max: lat.length ? Math.max.apply(null, lat) : 0,
    statuses: statuses
  };
  if (extra) { for (const k in extra) base[k] = extra[k]; }
  return base;
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ---------- 阶段一：混合读压力（持续 N 秒，C 个并发） ----------
async function runReadPhase(name, concurrency, durationMs, adminTk, residentTk) {
  const lat = [];
  const statuses = {};
  let errors = 0;
  const endAt = Date.now() + durationMs;

  async function worker() {
    while (Date.now() < endAt) {
      const r = Math.random();
      let res;
      if (r < 0.10) res = await GET('/api/health');
      else if (r < 0.30) res = await GET('/api/admin/overview', adminTk);
      else if (r < 0.55) res = await GET('/api/admin/unpaid', adminTk);
      else if (r < 0.85) res = await GET('/api/bill/list', residentTk);
      else if (r < 0.95) res = await GET('/api/user/me', residentTk);
      else res = await GET('/api/admin/households', adminTk);

      if (res.status >= 200 && res.status < 300) lat.push(res.ms);
      else errors++;
      statuses[res.status] = (statuses[res.status] || 0) + 1;
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return summarize(name, concurrency, lat, errors, statuses, durationMs);
}

// ---------- 阶段二：登录/报修写入压力 ----------
async function runWritePhase(name, concurrency, durationMs, kind) {
  const lat = [];
  const statuses = {};
  let errors = 0;
  let seq = 0;
  const endAt = Date.now() + durationMs;

  async function worker() {
    while (Date.now() < endAt) {
      seq++;
      let res;
      if (kind === 'login') {
        res = await POST('/api/user/login', { code: 'load', mockId: 'load-' + Date.now() + '-' + seq });
      } else {
        // 报修需要登录用户：先登录一次拿 token，再提交
        const login = await POST('/api/user/login', { code: 'load', mockId: 'load-repair-' + Date.now() + '-' + seq });
        if (!login.json || !login.json.ok) { errors++; continue; }
        res = await POST('/api/repair/create', {
          category: '其他',
          content: '压力测试自动生成的报修内容，用于检验写入性能（可忽略）',
          contact: '13800000000'
        }, login.json.data.token);
      }
      if (res.status >= 200 && res.status < 300) lat.push(res.ms);
      else errors++;
      statuses[res.status] = (statuses[res.status] || 0) + 1;
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return summarize(name, concurrency, lat, errors, statuses, durationMs);
}

// ---------- 测试用户/账单准备 ----------
function parseRoom(label) {
  const m = String(label).match(/栋(\d+)单元(\d+)室/);
  return m ? { unit: m[1], roomNo: m[2] } : null;
}

async function makeResident(idx, household, adminTk) {
  const login = await POST('/api/user/login', {
    code: 'load',
    mockId: 'load-' + Date.now() + '-' + idx
  });
  if (!login.json || !login.json.ok) throw new Error('测试用户登录失败');
  const token = login.json.data.token;

  if (config.pilotOnly) {
    await POST('/api/user/test-entry', { code: config.testInviteCode }, token);
  }

  const room = parseRoom(household.roomLabel);
  if (!room) throw new Error('无法解析房号：' + household.roomLabel);
  const bind = await POST('/api/user/bind', {
    unit: room.unit,
    roomNo: room.roomNo,
    ownerName: household.ownerName
  }, token);
  if (!bind.json || !bind.json.ok) {
    throw new Error('测试用户绑定失败：' + (bind.json ? bind.json.message : '无响应'));
  }
  return { token: token, household: household, room: room };
}

// 给一户造 P 张测试物业费账单（账期 1990-01 ...）
async function makeTestBills(adminTk, household, count) {
  const room = parseRoom(household.roomLabel);
  for (let i = 0; i < count; i++) {
    const period = TEST_PREFIX + String(i + 1).padStart(2, '0');
    await POST('/api/admin/addproperty', {
      unit: room.unit,
      roomNo: room.roomNo,
      period: period,
      dueDate: '1990-02-15',
      amount: 1
    }, adminTk);
  }
}

// ---------- 阶段三：缴费写入（真实链路：查账单→下单→模拟支付→凭证/留痕） ----------
async function runPaymentPhase(writers) {
  const lat = [];
  let errors = 0;
  let success = 0;
  const started = Date.now();

  async function payOne(w) {
    try {
      const list = await GET('/api/bill/list', w.token);
      if (!list.json || !list.json.ok) { errors++; return; }
      const bills = (list.json.data.unpaid || []).filter(function (b) {
        return String(b.period).indexOf(TEST_PREFIX) === 0;
      });
      for (const b of bills) {
        const t0 = Date.now();
        const created = await POST('/api/pay/create', { billIds: [b.id] }, w.token);
        let ok = false;
        if (created.json && created.json.ok) {
          const d = created.json.data || {};
          const nos = d.orderNos || (d.orderNo ? [d.orderNo] : []);
          const notified = await POST('/api/pay/mock-notify', { orderNos: nos }, w.token);
          ok = !!(notified.json && notified.json.ok);
        }
        if (ok) { lat.push(Date.now() - t0); success++; }
        else { errors++; }
      }
    } catch (e) {
      errors++;
    }
  }

  await Promise.all(writers.map(payOne));
  const durationMs = Date.now() - started;
  return summarize('缴费写入（查账单→下单→支付→凭证→留痕）', writers.length, lat, errors, { 200: success }, durationMs, {
    payments: success
  });
}

// ---------- 数据库快照与清理 ----------
async function snapshotMaxIds() {
  const tables = ['users', 'orders', 'repair_orders', 'check_logs', 'audit_logs', 'notifications'];
  const out = {};
  for (const t of tables) {
    try {
      const [r] = await pool.query('SELECT IFNULL(MAX(id),0) AS m FROM ' + t);
      out[t] = r[0].m;
    } catch (e) {
      out[t] = 0;
    }
  }
  return out;
}

async function cleanup(snap) {
  const report = [];
  try {
    // 留痕只删本次新增的尾部记录（保证前面的哈希链依然完整）
    let r = await pool.query('DELETE FROM notifications WHERE id > ? AND user_id > ?', [snap.notifications, snap.users]);
    report.push('notifications -' + r[0].affectedRows);
    r = await pool.query('DELETE FROM audit_logs WHERE id > ?', [snap.audit_logs]);
    report.push('audit_logs -' + r[0].affectedRows);
    r = await pool.query('DELETE FROM check_logs WHERE id > ?', [snap.check_logs]);
    report.push('check_logs -' + r[0].affectedRows);
    r = await pool.query('DELETE FROM repair_orders WHERE user_id > ?', [snap.users]);
    report.push('repair_orders -' + r[0].affectedRows);
    r = await pool.query('DELETE FROM order_bills WHERE order_id > ?', [snap.orders]);
    report.push('order_bills -' + r[0].affectedRows);
    r = await pool.query('DELETE FROM orders WHERE id > ?', [snap.orders]);
    report.push('orders -' + r[0].affectedRows);
    r = await pool.query('DELETE FROM bindings WHERE user_id > ?', [snap.users]);
    report.push('bindings -' + r[0].affectedRows);
    r = await pool.query('DELETE FROM users WHERE id > ?', [snap.users]);
    report.push('users -' + r[0].affectedRows);
    r = await pool.query("DELETE FROM bills WHERE type = 'property' AND period LIKE ?", [TEST_PREFIX + '%']);
    report.push('测试账单 -' + r[0].affectedRows);
    console.log('[清理] 已清理测试数据：' + report.join('，'));
  } catch (e) {
    console.error('[清理] 失败（可以手动检查）：', e.message);
  }
}

// ---------- 主流程 ----------
async function main() {
  console.log('==========================================');
  console.log(' 崇文兰亭缴费通 · 压力测试');
  console.log(' 目标: ' + BASE + '  模式: ' + (QUICK ? '快速' : '完整'));
  console.log('==========================================');

  // 0. 健康检查 + 准备
  const health = await GET('/api/health');
  if (!health.json || !health.json.ok) {
    throw new Error('服务没起来或健康检查失败，请先启动后端');
  }
  console.log('✓ 服务在线（db=' + health.json.db + '，mock=' + health.json.mockMode + '）');

  const admin = await POST('/api/admin/login', { username: 'admin', password: 'admin123' });
  if (!admin.json || !admin.json.ok) throw new Error('物业登录失败（确认 init.sql 已执行）');
  const adminTk = admin.json.data.token;

  const hs = await GET('/api/admin/households', adminTk);
  const households = (hs.json && hs.json.data) || [];
  if (!households.length) throw new Error('没有住户数据，请先执行 seed-demo.js');

  // ★ 先记录当前各表最大 ID：压测结束后只清理"这之后新增"的数据，
  //   避免误删压测前就存在的真实数据
  const snap = await snapshotMaxIds();

  console.log('→ 准备测试用户与住户数据…');
  const readUser = await makeResident(0, households[0], adminTk);

  const K = QUICK ? 6 : 20;   // 缴费测试户数
  const P = QUICK ? 3 : 6;     // 每户测试账单数
  const writers = [];
  for (let i = 0; i < K; i++) {
    const h = households[i % households.length];
    const w = await makeResident(i + 1, h, adminTk);
    await makeTestBills(adminTk, h, P);
    writers.push(w);
  }
  console.log('✓ 已准备 ' + K + ' 户 × ' + P + ' 张测试账单（账期 ' + TEST_PREFIX + 'xx，结束后自动清理）');

  // 1. 读压力阶梯
  const ramp = QUICK ? [5, 10, 20, 40] : [5, 10, 20, 40, 60, 80];
  const readResults = [];
  for (const c of ramp) {
    process.stdout.write('→ 读压力 ' + c + ' 并发… ');
    const r = await runReadPhase('混合读·' + c + '并发', c, QUICK ? 3000 : 5000, adminTk, readUser.token);
    readResults.push(r);
    console.log('QPS ' + r.qps + '，p95 ' + r.p95 + 'ms，错误率 ' + r.errorRate + '%');
  }

  // 2. 写入压力
  process.stdout.write('→ 登录写入压力… ');
  const loginResult = await runWritePhase('登录写入', QUICK ? 20 : 40, QUICK ? 3000 : 5000, 'login');
  console.log('QPS ' + loginResult.qps + '，p95 ' + loginResult.p95 + 'ms');

  process.stdout.write('→ 报修写入压力… ');
  const repairResult = await runWritePhase('报修写入', QUICK ? 10 : 20, QUICK ? 3000 : 5000, 'repair');
  console.log('QPS ' + repairResult.qps + '，p95 ' + repairResult.p95 + 'ms');

  // 3. 缴费写入
  process.stdout.write('→ 缴费写入压力… ');
  const payResult = await runPaymentPhase(writers);
  console.log('成功 ' + payResult.payments + ' 笔，QPS ' + payResult.qps + '，p95 ' + payResult.p95 + 'ms');

  // 4. 持续混合负载（模拟真实高峰）
  const sustainedC = QUICK ? 30 : 80;
  process.stdout.write('→ 持续混合负载 ' + sustainedC + ' 并发… ');
  const sustained = await runReadPhase('持续混合负载', sustainedC, QUICK ? 6000 : 15000, adminTk, readUser.token);
  console.log('QPS ' + sustained.qps + '，p95 ' + sustained.p95 + 'ms，错误率 ' + sustained.errorRate + '%');

  // 5. 判定
  const peakRead = readResults[readResults.length - 1];
  const checks = [
    { name: '读压力（最高阶 ' + peakRead.concurrency + ' 并发）错误率 < 2%', pass: peakRead.errorRate < 2, value: peakRead.errorRate + '%' },
    { name: '读压力（最高阶）p95 < 2000ms', pass: peakRead.p95 < 2000, value: peakRead.p95 + 'ms' },
    { name: '持续混合负载错误率 < 1%', pass: sustained.errorRate < 1, value: sustained.errorRate + '%' },
    { name: '持续混合负载 p95 < 1500ms', pass: sustained.p95 < 1500, value: sustained.p95 + 'ms' },
    { name: '缴费链路全部成功（' + (K * P) + ' 笔）', pass: payResult.payments === K * P, value: payResult.payments + ' 笔' },
    { name: '缴费链路 p95 < 3000ms', pass: payResult.p95 < 3000, value: payResult.p95 + 'ms' }
  ];
  const failed = checks.filter(function (c) { return !c.pass; });
  const verdict = failed.length === 0 ? '通过（未被压力击垮）' : '存在风险（有 ' + failed.length + ' 项未达标）';

  // 6. 写报告
  const lines = [];
  lines.push('# 崇文兰亭缴费通 · 压力测试报告');
  lines.push('');
  lines.push('- 测试时间：' + new Date().toLocaleString());
  lines.push('- 测试目标：' + BASE);
  lines.push('- 测试模式：' + (QUICK ? '快速' : '完整') + '（Node ' + process.version + '，' + os.cpus().length + ' 核 / ' + Math.round(os.totalmem() / 1024 / 1024 / 1024) + 'GB 内存）');
  lines.push('- 综合判定：**' + verdict + '**');
  lines.push('');
  lines.push('## 分阶段结果');
  lines.push('');
  lines.push('| 阶段 | 并发 | 请求数 | QPS | 平均 | p50 | p90 | p95 | p99 | 最大 | 错误率 |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  const all = readResults.concat([loginResult, repairResult, payResult, sustained]);
  all.forEach(function (r) {
    lines.push('| ' + r.name + ' | ' + r.concurrency + ' | ' + r.total + ' | ' + r.qps + ' | ' + r.avg + 'ms | ' +
      r.p50 + 'ms | ' + r.p90 + 'ms | ' + r.p95 + 'ms | ' + r.p99 + 'ms | ' + r.max + 'ms | ' + r.errorRate + '% |');
  });
  lines.push('');
  lines.push('## 判定明细');
  lines.push('');
  checks.forEach(function (c) {
    lines.push('- ' + (c.pass ? '✅' : '❌') + ' ' + c.name + '（实测 ' + c.value + '）');
  });
  lines.push('');
  lines.push('## 说明与建议');
  lines.push('');
  lines.push('- 本测试使用 `1990-xx` 账期的临时物业费账单，结束后自动清理，不影响真实账单。');
  lines.push('- 1200 户小区的真实缴费高峰通常是"每月缴费日的前后 2~3 天"，同时在线缴费一般不超过几十人；请以"持续混合负载"结果作为容量参考。');
  lines.push('- 若 p95 偏高或错误率超标，优先检查：MySQL 连接池（CWLT_DB_POOL）、慢查询（admin/unpaid 等 JOIN）、单进程 CPU。');
  lines.push('- 若错误中出现 429，说明限流生效（正式环境属正常保护；压测实例应设置 CWLT_DISABLE_RATE_LIMIT=1）。');
  lines.push('- 本报告为本地环境实测，生产环境（服务器配置、网络、MySQL 调优不同）需复测。');
  lines.push('');

  fs.writeFileSync(REPORT, lines.join('\n'), 'utf8');
  console.log('');
  console.log('==========================================');
  console.log(' 结论：' + verdict);
  console.log(' 报告：' + REPORT);
  console.log('==========================================');

  // 7. 清理测试数据
  if (DO_CLEANUP) await cleanup(snap);

  // 8. 退出（关闭连接池，让脚本自然结束）
  try { await pool.end(); } catch (e) { /* ignore */ }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error('✗ 压测中断：', e.message);
  console.error('  请确认：①服务已启动 ②db/migrate-v2.js 已执行 ③seed-demo.js 已执行');
  process.exit(2);
});
