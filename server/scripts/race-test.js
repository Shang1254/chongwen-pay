// ============================================================
// 并发安全测试（聚焦居民最关心的"钱会不会重复扣/重复入账"）
// 场景：
//   ① 多人同时给【同一张账单】下单 → 只允许 1 笔订单成功创建
//   ② 同一订单并发重复回调 10 次 → 只入账 1 次（幂等）
//   ③ 账单只会被标记已缴一次，不会出现双份留痕
// 用法：node scripts/race-test.js http://127.0.0.1:3100
// 数据安全：测试账单用 1989-04 账期标记，结束自动清理
// ============================================================
const http = require('http');
const config = require('../config');
const { pool } = require('../db/pool');

const BASE = process.argv[2] || 'http://127.0.0.1:3100';
let pass = 0, fail = 0;

function api(method, path, body, token) {
  return new Promise(function (resolve) {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + path, {
      method: method,
      headers: Object.assign(
        { 'Content-Type': 'application/json; charset=utf-8' },
        token ? { Authorization: 'Bearer ' + token } : {},
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}
      ),
      timeout: 15000
    }, function (res) {
      let raw = '';
      res.on('data', function (c) { raw += c; });
      res.on('end', function () {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('error', function () { resolve({ status: 0, body: null }); });
    req.on('timeout', function () { req.destroy(); });
    if (data) req.write(data);
    req.end();
  });
}

function check(name, ok, detail) {
  if (ok) { pass++; console.log('✓ ' + name + (detail ? ' —— ' + detail : '')); }
  else { fail++; console.log('✗ ' + name + ' —— ' + detail); }
}

function parseRoom(label) {
  const m = String(label).match(/栋(\d+)单元(\d+)室/);
  return m ? { unit: m[1], roomNo: m[2] } : null;
}

async function main() {
  console.log('目标: ' + BASE);

  const admin = await api('POST', '/api/admin/login', { username: 'admin', password: 'admin123' });
  const adminTk = admin.body.data.token;

  // 准备：挑一户（第二户，避开主测试流程用的第一户），造 1 张测试账单
  const hs = await api('GET', '/api/admin/households', null, adminTk);
  const list = hs.body.data || [];
  const target = list.find(function (x) { return x.roomLabel !== '2栋1单元101室'; });
  const room = parseRoom(target.roomLabel);
  await api('POST', '/api/admin/addproperty', {
    unit: room.unit, roomNo: room.roomNo, period: '1989-04', dueDate: '1989-05-15', amount: 1
  }, adminTk);
  console.log('→ 测试账单：' + target.roomLabel + '（1989-04 物业费 ¥1）');

  // 3 个并发"居民"都绑定这户
  const tokens = [];
  for (let i = 0; i < 3; i++) {
    const u = await api('POST', '/api/user/login', { code: 'race', mockId: 'race-' + Date.now() + '-' + i });
    const tk = u.body.data.token;
    await api('POST', '/api/user/test-entry', { code: config.testInviteCode }, tk);
    const b = await api('POST', '/api/user/bind', {
      unit: room.unit, roomNo: room.roomNo, ownerName: target.ownerName, phone: '1360000000' + i, role: 'owner'
    }, tk);
    if (!b.body.ok) throw new Error('测试用户绑定失败：' + b.body.message);
    tokens.push(tk);
  }

  // 找到这张测试账单的 id（通过第一个居民查账单列表）
  const myList = await api('GET', '/api/bill/list', null, tokens[0]);
  const testBill = (myList.body.data.unpaid || []).find(function (b) {
    return String(b.period).indexOf('1989-') === 0;
  });
  if (!testBill) throw new Error('没找到测试账单，请重跑');
  const currentBillId = testBill.id;

  // 场景①：3 人【同时】给同一张账单下单
  const createResults = await Promise.all(tokens.map(function (tk) {
    return api('POST', '/api/pay/create', { billIds: [currentBillId] }, tk);
  }));

  const okOrders = [];
  createResults.forEach(function (r) {
    if (r.body && r.body.ok) okOrders.push(r.body.data.orderNo);
  });
  check('并发下单·同一账单只生成 1 笔订单', okOrders.length === 1,
    '3 个并发请求，成功 ' + okOrders.length + ' 个' + (okOrders.length ? '（订单 ' + okOrders[0] + '）' : ''));

  // 场景②：同一订单并发重复回调 10 次（模拟微信重发/恶意重放）
  const orderNo = okOrders[0];
  const notifyResults = await Promise.all(
    Array.from({ length: 10 }, function () {
      return api('POST', '/api/pay/mock-notify', { orderNos: [orderNo] }, tokens[0]);
    })
  );
  let settled = 0;
  notifyResults.forEach(function (r) {
    if (r.body && r.body.ok && r.body.data.success === 1) settled++;
  });
  check('并发回调·10 次重复通知只入账 1 次', settled === 1, '实际入账 ' + settled + ' 次');

  // 场景③：账单状态核对
  const list2 = await api('GET', '/api/bill/list', null, tokens[0]);
  const paidBill = (list2.body.data.paid || []).find(function (b) { return b.id === currentBillId; });
  check('账单只销账一次且状态正确', !!paidBill && paidBill.status === 'paid',
    paidBill ? '已缴 ¥' + money(paidBill.amount) : '未找到');

  // 场景④：数据库层核对——该账单对应的"已支付订单"只有 1 笔
  const [dbCheck] = await pool.query(
    'SELECT COUNT(*) AS c FROM orders WHERE status = "success" AND id IN ' +
    '(SELECT order_id FROM order_bills WHERE bill_id = ?)',
    [currentBillId]
  );
  check('数据库核对·无重复入账订单', dbCheck[0].c === 1, '成功订单 ' + dbCheck[0].c + ' 笔');

  console.log('');
  console.log('======== 并发安全测试：' + pass + ' 通过 / ' + fail + ' 失败 ========');

  // 清理：测试账单/订单/测试用户
  try {
    await pool.query("DELETE FROM bills WHERE period = '1989-04'");
    await pool.query("DELETE FROM order_bills WHERE order_id NOT IN (SELECT id FROM orders)");
    const [eus] = await pool.query("SELECT id FROM users WHERE openid LIKE 'mock\\_race%'");
    const eids = eus.map(function (u) { return u.id; });
    if (eids.length) {
      await pool.query('DELETE FROM bindings WHERE user_id IN (?)', [eids]);
      await pool.query('DELETE FROM notifications WHERE user_id IN (?)', [eids]);
      await pool.query('DELETE FROM check_logs WHERE user_id IN (?)', [eids]);
      await pool.query('DELETE FROM orders WHERE user_id IN (?)', [eids]);
      await pool.query('DELETE FROM order_bills WHERE order_id NOT IN (SELECT id FROM orders)');
      await pool.query('DELETE FROM users WHERE id IN (?)', [eids]);
    }
    console.log('[清理] 测试账单与测试用户已清理');
  } catch (e) {
    console.error('[清理] 失败：', e.message);
  }
  try { await pool.end(); } catch (e) { /* ignore */ }
  process.exit(fail > 0 ? 1 : 0);
}

function money(n) { return Number(n || 0).toFixed(2); }

main().catch(function (e) {
  console.error('✗ 并发测试中断：', e.message);
  process.exit(1);
});
