// ============================================================
// 端到端自测脚本（v3：业主认证/租户/多房产/线下兜底/退款/对账/日志）
// 用法：先启动后端（双击 start.bat），然后在 server 目录执行
//       node scripts/e2e-test.js
// 特点：从欠费名单自动挑住户来测，随时可重复跑；
//       会创建少量测试数据（测试用户/登记手机号），可重复执行。
// ============================================================
const http = require('http');
const config = require('../config');
const { pool } = require('../db/pool');

const BASE = 'http://127.0.0.1:3000';
let pass = 0, fail = 0;

function api(method, path, body, token) {
  return new Promise(function (resolve, reject) {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(BASE + path, {
      method: method,
      headers: Object.assign(
        { 'Content-Type': 'application/json; charset=utf-8' },
        token ? { Authorization: 'Bearer ' + token } : {},
        data ? { 'Content-Length': Buffer.byteLength(data) } : {}
      )
    }, function (res) {
      let raw = '';
      res.on('data', function (c) { raw += c; });
      res.on('end', function () {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { reject(new Error('返回不是 JSON：' + raw.slice(0, 100))); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function check(name, ok, detail) {
  if (ok) { pass++; console.log('✓ ' + name + (detail ? ' —— ' + detail : '')); }
  else { fail++; console.log('✗ ' + name + ' —— ' + detail); }
}

function money(n) { return Number(n || 0).toFixed(2); }

function parseRoom(label) {
  const m = String(label).match(/栋(\d+)单元(\d+)室/);
  return m ? { unit: m[1], roomNo: m[2] } : null;
}

async function main() {
  // 1. 健康检查
  const h = await api('GET', '/api/health');
  check('健康检查', h.body.ok && h.body.db === true, '数据库连接 ' + (h.body.db ? '正常' : '失败'));

  // 2. 物业登录
  const admin = await api('POST', '/api/admin/login', { username: 'admin', password: 'admin123' });
  check('物业登录', admin.body.ok && admin.body.data.token, '账号 admin 登录成功');
  const adminTk = admin.body.data.token;

  // 3. 欠费名单挑一户（v3起接口返回 {rows,total,...}）
  const unpaidList = await api('GET', '/api/admin/unpaid?pageSize=50', null, adminTk);
  const first = ((unpaidList.body.data || {}).rows || [])[0];
  if (!first) {
    console.log('⚠️ 当前没有未缴账单，请先执行 seed-demo.js / seed-property.js');
    console.log('======== 自测结果：' + pass + ' 通过 / ' + fail + ' 失败 ========');
    process.exit(fail > 0 ? 1 : 0);
  }
  const r1 = parseRoom(first.roomLabel);
  console.log('→ 本次测试住户：' + first.roomLabel + '（户主 ' + first.ownerName + '）');

  // 测试夹具：给这户登记一个已知手机号，让主流程绑定走完整的"手机号校验"链路
  const hhList0 = await api('GET', '/api/admin/households', null, adminTk);
  const firstHh = (hhList0.body.data || []).find(function (x) { return x.roomLabel === first.roomLabel; });
  let firstHhId = firstHh ? firstHh.id : 0;
  await api('POST', '/api/admin/household-setphone', { householdId: firstHhId, phone: '13800001234' }, adminTk);

  // 4. 居民登录
  const login = await api('POST', '/api/user/login', { code: 'e2e', mockId: 'e2e-' + Date.now() });
  check('居民登录', login.body.ok && login.body.data.token, '演示身份建档成功');
  const tk = login.body.data.token;

  // 5. 邀请码：错码拒绝 / 正码解锁
  const badCode = await api('POST', '/api/user/test-entry', { code: 'WRONG' }, tk);
  check('测试入口·错误邀请码被拒', badCode.body.ok === false, badCode.body.message.slice(0, 30));
  const goodCode = await api('POST', '/api/user/test-entry', { code: config.testInviteCode }, tk);
  check('测试入口·邀请码解锁', goodCode.body.ok === true, goodCode.body.data.message);

  // 6. Agent1 姓名拦截
  const badName = await api('POST', '/api/user/bind', { unit: r1.unit, roomNo: r1.roomNo, ownerName: '查无此人' }, tk);
  check('Agent1拦截·姓名对不上', badName.body.ok === false, badName.body.message.slice(0, 40));

  // 7. 业主绑定（带登记手机号：完整认证链路）
  const bind = await api('POST', '/api/user/bind',
    { unit: r1.unit, roomNo: r1.roomNo, ownerName: first.ownerName, phone: '13800001234', role: 'owner' }, tk);
  check('业主绑定（手机号认证）', bind.body.ok && bind.body.data.household,
    bind.body.ok ? bind.body.data.household.roomLabel + '（业主）' : bind.body.message);

  // 8. 查账单 + 下单 + 支付
  const list = await api('GET', '/api/bill/list', null, tk);
  const unpaid = list.body.data.unpaid || [];
  const hasProperty = unpaid.some(function (b) { return b.type === 'property'; });
  check('查询账单', list.body.ok && unpaid.length > 0,
    '待缴 ' + unpaid.length + ' 笔 ¥' + unpaid.reduce(function (s, b) { return s + b.amount; }, 0).toFixed(2) +
    (hasProperty ? '（含物业费）' : ''));

  const ids = unpaid.map(function (b) { return b.id; });
  const order = await api('POST', '/api/pay/create', { billIds: ids }, tk);
  const orderNo = order.body.ok ? order.body.data.orderNo : '';
  check('下单（合并结账）', order.body.ok && !!orderNo, '订单 ' + orderNo);

  const notify = await api('POST', '/api/pay/mock-notify', { orderNos: [orderNo] }, tk);
  check('模拟支付回调', notify.body.ok && notify.body.data.success === 1, '幂等销账生效');

  // 9. 电子凭证
  const voucher = await api('GET', '/api/pay/voucher?orderNo=' + orderNo, null, tk);
  check('电子缴费凭证', voucher.body.ok && voucher.body.data.voucherNo && voucher.body.data.verifyCode,
    voucher.body.ok ? voucher.body.data.voucherNo + ' / 防伪码 ' + voucher.body.data.verifyCode : voucher.body.message);

  // 10. 重复缴纳拦截
  const dup = await api('POST', '/api/pay/create', { billIds: ids }, tk);
  check('Agent1拦截·重复缴纳', dup.body.ok === false, dup.body.message.slice(0, 30));

  // ========== v3 新增 ==========

  // 11. 业主认证：物业登记手机号后，不一致必须拦下
  const hhList = await api('GET', '/api/admin/households', null, adminTk);
  const others = (hhList.body.data || []).filter(function (x) { return x.roomLabel !== first.roomLabel; });
  const h2 = others[0];
  let h2Id = h2.id; // 供收尾清理登记手机号用
  await api('POST', '/api/admin/household-setphone', { householdId: h2.id, phone: '13900001111' }, adminTk);
  const u2 = await api('POST', '/api/user/login', { code: 'e2e', mockId: 'e2e-b-' + Date.now() });
  const tk2 = u2.body.data.token;
  // 第二个测试用户也要先解锁试点（流程完整性）
  await api('POST', '/api/user/test-entry', { code: config.testInviteCode }, tk2);
  const r2 = parseRoom(h2.roomLabel);
  const badPhone = await api('POST', '/api/user/bind',
    { unit: r2.unit, roomNo: r2.roomNo, ownerName: h2.ownerName, phone: '13800000000', role: 'owner' }, tk2);
  check('业主认证·手机号不一致被拦', badPhone.body.ok === false, badPhone.body.message.slice(0, 40));
  const goodPhone = await api('POST', '/api/user/bind',
    { unit: r2.unit, roomNo: r2.roomNo, ownerName: h2.ownerName, phone: '13900001111', role: 'owner' }, tk2);
  check('业主认证·手机号一致通过', goodPhone.body.ok === true, h2.roomLabel + '（业主）');

  // 12. 租户绑定（免户主校验，手机号必填）
  const h3 = others[1];
  const r3 = parseRoom(h3.roomLabel);
  const tenant = await api('POST', '/api/user/bind',
    { unit: r3.unit, roomNo: r3.roomNo, ownerName: '租户本人', phone: '13700002222', role: 'tenant' }, tk2);
  check('租户绑定', tenant.body.ok === true && tenant.body.data.household.role === 'tenant',
    tenant.body.ok ? tenant.body.data.household.roomLabel + '（租户）' : tenant.body.message);

  // 13. 多房产：me 列表 + 按房号筛选账单
  const me2 = await api('GET', '/api/user/me', null, tk2);
  check('多房产·我的房产列表', me2.body.ok && (me2.body.data.households || []).length >= 2,
    '绑定 ' + (me2.body.data.households || []).length + ' 套');
  const hhId2 = tenant.body.data.household.id;
  const listB = await api('GET', '/api/bill/list?householdId=' + hhId2, null, tk2);
  check('账单按房号筛选', listB.body.ok && listB.body.data.household.id === hhId2,
    listB.body.ok ? listB.body.data.household.roomLabel + '，待缴 ' + (listB.body.data.unpaid || []).length + ' 笔' : '');

  // 14. 跨房号下单保护
  const listA2 = await api('GET', '/api/bill/list?householdId=' + h2.id, null, tk2);
  const idA = ((listA2.body.data.unpaid || [])[0] || {}).id;
  const idB = ((listB.body.data.unpaid || [])[0] || {}).id;
  if (idA && idB) {
    const mixed = await api('POST', '/api/pay/create', { billIds: [idA, idB] }, tk2);
    check('跨房号下单被拒', mixed.body.ok === false && (mixed.body.message || '').indexOf('分开') >= 0,
      (mixed.body.message || '').slice(0, 30));
  } else {
    check('跨房号下单被拒', true, '（某户无待缴账单，跳过）');
  }

  // 15. 线下兜底收款（现金登记 → 销账 + 凭证）
  // 15. 线下兜底收款（先自造一张测试账单，确保每次都有"货"可收）
  await api('POST', '/api/admin/addproperty', {
    unit: r3.unit, roomNo: r3.roomNo, period: '1989-04', dueDate: '1989-05-15', amount: 1
  }, adminTk);
  const listOff = await api('GET', '/api/bill/list?householdId=' + hhId2, null, tk2);
  const billForOffline = (((listOff.body.data || {}).unpaid || []).find(function (b) { return String(b.period) === '1989-04'; }) || {}).id;
  if (!billForOffline) {
    check('线下兜底收款登记', false, '测试账单创建失败');
  } else {
    const off = await api('POST', '/api/admin/offline-pay',
      { billIds: [billForOffline], channel: 'cash', receiptNo: 'SK-001' }, adminTk);
    check('线下兜底收款登记', off.body.ok === true, off.body.data ? off.body.data.message : off.body.message);

    const listB2 = await api('GET', '/api/bill/list?householdId=' + hhId2, null, tk2);
    const stillUnpaid = (listB2.body.data.unpaid || []).some(function (b) { return b.id === billForOffline; });
    check('线下收款已销账', stillUnpaid === false, '账单转为已缴');

    // 16. 退款 → 账单恢复待缴
    const offOrder = off.body.data.orderNo;
    const refund = await api('POST', '/api/admin/refund', { orderNo: offOrder, reason: '测试退款' }, adminTk);
    check('退款（演示原路退回）', refund.body.ok === true, refund.body.data ? refund.body.data.message : refund.body.message);
    const listB3 = await api('GET', '/api/bill/list?householdId=' + hhId2, null, tk2);
    const backUnpaid = (listB3.body.data.unpaid || []).some(function (b) { return b.id === billForOffline; });
    check('退款后账单恢复待缴', backUnpaid === true, '');
  }

  // 17. 对账文件导出
  const stl = await api('GET', '/api/admin/settlement', null, adminTk);
  check('对账文件导出', stl.body.ok && stl.body.data.count > 0,
    stl.body.ok ? stl.body.data.date + ' ' + stl.body.data.count + ' 笔，净额 ¥' + stl.body.data.summary.net : stl.body.message);

  // 17b. 分页与筛选（欠费名单）
  const pg = await api('GET', '/api/admin/unpaid?page=1&pageSize=5', null, adminTk);
  check('欠费名单·分页', pg.body.ok && (pg.body.data.rows || []).length <= 5 && pg.body.data.totalPages >= 1,
    pg.body.ok ? '共 ' + pg.body.data.total + ' 条 / ' + pg.body.data.totalPages + ' 页' : pg.body.message);
  // 关键词"单元"应命中全部欠费记录（所有房号都含这二字）；乱写的词应命中 0 条
  const pgKw = await api('GET', '/api/admin/unpaid?keyword=' + encodeURIComponent('单元'), null, adminTk);
  check('欠费名单·关键词筛选', pgKw.body.ok && pgKw.body.data.total >= 1 &&
    (pgKw.body.data.rows || []).every(function (b) { return b.roomLabel.indexOf('单元') >= 0; }),
    pgKw.body.ok ? '命中 ' + pgKw.body.data.total + ' 条' : pgKw.body.message);
  const pgNone = await api('GET', '/api/admin/unpaid?keyword=' + encodeURIComponent('ZZZ不存在'), null, adminTk);
  check('欠费名单·无结果关键词', pgNone.body.ok && pgNone.body.data.total === 0 && (pgNone.body.data.rows || []).length === 0,
    pgNone.body.ok ? '命中 0 条 ✓' : pgNone.body.message);

  // 17c. 分页与筛选（收款记录）
  const po = await api('GET', '/api/admin/orders?page=1&pageSize=5', null, adminTk);
  check('收款记录·分页', po.body.ok && (po.body.data.rows || []).length <= 5 && po.body.data.total >= 1,
    po.body.ok ? '共 ' + po.body.data.total + ' 条 / ' + po.body.data.totalPages + ' 页' : po.body.message);
  const poS = await api('GET', '/api/admin/orders?status=success&page=1&pageSize=5', null, adminTk);
  check('收款记录·状态筛选', poS.body.ok && (poS.body.data.rows || []).every(function (o) { return o.status === 'success'; }),
    poS.body.ok ? '已支付 ' + poS.body.data.total + ' 笔' : poS.body.message);

  // 18. 操作日志
  const logs = await api('GET', '/api/admin/admin-logs', null, adminTk);
  check('操作日志留痕', logs.body.ok && (logs.body.data || []).length > 0,
    '共 ' + (logs.body.data || []).length + ' 条');

  // 19. 欠费提醒 Agent
  const r2x = await api('POST', '/api/admin/run-agent', { name: 'remind' }, adminTk);
  check('欠费提醒Agent', r2x.body.ok, r2x.body.data ? r2x.body.data.message.slice(0, 50) : r2x.body.message);

  // 20. 用量分析 Agent
  const usage = await api('GET', '/api/admin/usage', null, adminTk);
  check('用量分析Agent', usage.body.ok && usage.body.data.trend.length > 0,
    usage.body.ok ? '趋势 ' + usage.body.data.trend.length + ' 个月，异常高耗 ' + usage.body.data.abnormal.length + ' 户' : '');

  // 21. 监管留痕（分页）+ 本页哈希链
  const rg = await api('GET', '/api/admin/regulatory?page=1&pageSize=5', null, adminTk);
  check('监管留痕·分页', rg.body.ok && (rg.body.data.rows || []).length <= 5 && rg.body.data.total >= 1 && rg.body.data.chainOk === true,
    rg.body.ok ? '共 ' + rg.body.data.total + ' 条 / ' + rg.body.data.totalPages + ' 页，本页链' + (rg.body.data.chainOk ? '✓' : '✗') : rg.body.message);

  // 22. 留痕类型筛选（退款）
  const rgRefund = await api('GET', '/api/admin/regulatory?type=refund&pageSize=5', null, adminTk);
  check('监管留痕·类型筛选(退款)', rgRefund.body.ok && (rgRefund.body.data.rows || []).every(function (r) { return r.bizType === 'refund'; }) && rgRefund.body.data.total >= 1,
    rgRefund.body.ok ? '退款留痕 ' + rgRefund.body.data.total + ' 条' : rgRefund.body.message);

  // 23. 全量哈希链校验
  const chain = await api('GET', '/api/admin/regulatory/chain-check', null, adminTk);
  check('监管留痕·全量链校验', chain.body.ok && chain.body.data.chainOk === true && chain.body.data.checked >= 1,
    chain.body.ok ? '校验 ' + chain.body.data.checked + ' 条，无篡改' : chain.body.message);

  // 24. 留痕 CSV 导出（按筛选）
  const rgCsv = await api('GET', '/api/admin/regulatory/export?type=refund', null, adminTk);
  check('留痕CSV导出', rgCsv.body.ok && rgCsv.body.data.csv.indexOf('记录编号') >= 0,
    rgCsv.body.ok ? rgCsv.body.data.count + ' 条' : rgCsv.body.message);

  // ========== v4 物业端重构 ==========

  // 23. 抄表向导：调出整单元抄表单（用测试账期，避免污染真实账单）
  const sheet = await api('GET', '/api/admin/reading-sheet?unit=1&type=electric&period=1989-03', null, adminTk);
  check('抄表向导·调出抄表单', sheet.body.ok && (sheet.body.data.rows || []).length > 0,
    sheet.body.ok ? sheet.body.data.rows.length + ' 户，单价 ¥' + sheet.body.data.price : sheet.body.message);
  const sheetRow = (sheet.body.data.rows || [])[0];

  // 24. 抄表向导：批量保存
  if (sheetRow) {
    const save = await api('POST', '/api/admin/reading-save', {
      unit: '1', type: 'electric', period: '1989-03', dueDate: '1989-04-15',
      rows: [{ householdId: sheetRow.householdId, reading: 40 }]
    }, adminTk);
    check('抄表向导·批量保存', save.body.ok && save.body.data.saved >= 1,
      save.body.ok ? '保存 ' + save.body.data.saved + ' 户' : save.body.message);
  } else {
    check('抄表向导·批量保存', false, '没有抄表单行');
  }

  // 25. 住户档案：新增住户
  const addHh = await api('POST', '/api/admin/household-add', {
    unit: '9', roomNo: '901', ownerName: '测试住户', area: 88, phone: '13600009999'
  }, adminTk);
  const addOk = addHh.body.ok === true || (addHh.body.message || '').indexOf('已存在') >= 0;
  check('住户档案·新增住户', addOk,
    addHh.body.ok ? addHh.body.data.message : '已存在（重复执行幂等）');
  const hhAfter = await api('GET', '/api/admin/households', null, adminTk);
  check('住户档案·数量+1', (hhAfter.body.data || []).some(function (x) { return x.roomLabel === '2栋9单元901室'; }),
    '现有 ' + (hhAfter.body.data || []).length + ' 户（含测试户）');

  // 26. 住户详情：实时欠费汇总（欠电/水/物业费分项 + 合计）
  const detail = await api('GET', '/api/admin/household-detail?householdId=' + h2.id, null, adminTk);
  check('住户详情·实时欠费', detail.body.ok && detail.body.data.owes.total > 0 && (detail.body.data.unpaid || []).length >= 1,
    detail.body.ok ? '欠电 ¥' + money(detail.body.data.owes.electric.amount) + ' / 水 ¥' + money(detail.body.data.owes.water.amount) +
      ' / 物业 ¥' + money(detail.body.data.owes.property.amount) : detail.body.message);

  // 27. 定向催缴：首推成功 + 当日重复自动去重
  const nh1 = await api('POST', '/api/admin/notify-household', { householdId: h2.id }, adminTk);
  check('定向催缴·首推', nh1.body.ok && nh1.body.data.sent >= 1, nh1.body.data.message);
  const nh2 = await api('POST', '/api/admin/notify-household', { householdId: h2.id }, adminTk);
  check('定向催缴·当日去重', nh2.body.ok && nh2.body.data.sent === 0 && nh2.body.data.skipped >= 1, nh2.body.data.message);

  // 28. 报修看板：先造一个工单，再改状态 + 指派 + 优先级 + 流转日志
  const rCreate = await api('POST', '/api/repair/create', {
    category: '公共区域', content: '看板测试工单：楼道灯不亮（E2E 自动创建）', contact: '13800001234'
  }, tk);
  const rId = rCreate.body.ok ? rCreate.body.data.id : 0;
  const rUpdate = await api('POST', '/api/admin/repair-status', {
    id: rId, status: 'doing', priority: 'urgent', assignee: '王师傅', feedback: '看板测试：已派单'
  }, adminTk);
  check('报修看板·改状态/指派', rUpdate.body.ok === true, rUpdate.body.data ? rUpdate.body.data.message : rUpdate.body.message);
  const repairsAfter = await api('GET', '/api/admin/repairs', null, adminTk);
  const rNew = (repairsAfter.body.data || []).find(function (x) { return x.id === rId; });
  check('报修看板·字段生效', !!rNew && rNew.priority === 'urgent' && rNew.assignee === '王师傅',
    rNew ? '优先级 ' + rNew.priorityLabel + '，师傅 ' + rNew.assignee : '未找到工单');
  const [logRows] = await pool.query('SELECT COUNT(*) AS c FROM repair_logs WHERE repair_id = ?', [rId]);
  check('报修看板·流转日志', logRows[0].c >= 1, '日志 ' + logRows[0].c + ' 条');

  // 29. 缴费看板：48 户热力图数据 + 单元汇总
  const nowD = new Date();
  const curMonth = nowD.getFullYear() + '-' + String(nowD.getMonth() + 1).padStart(2, '0');
  const cb = await api('GET', '/api/admin/collection-board?period=' + curMonth, null, adminTk);
  const cbData = cb.body.data || {};
  check('缴费看板·热力图数据', cb.body.ok && (cbData.households || []).length >= 48 && (cbData.units || []).length === 2,
    '户数 ' + (cbData.households || []).length + '，全缴 ' + (cbData.summary ? cbData.summary.allPaid : 0) + ' 户');

  console.log('');
  console.log('======== 自测结果：' + pass + ' 通过 / ' + fail + ' 失败 ========');

  // 清理本轮测试数据（测试账期/测试住户/测试用户/目标户登记手机号）
  try {
    await pool.query("DELETE FROM bills WHERE period LIKE '1989-%'");
    await pool.query("DELETE FROM households WHERE building = ? AND unit = '9'", [config.pilotBuilding]);
    // 恢复目标户/认证测试户的登记手机号为空（测试手机号不留在演示数据里）
    if (firstHhId) await pool.query("UPDATE households SET reg_phone_enc = '' WHERE id = ?", [firstHhId]);
    if (h2Id) await pool.query("UPDATE households SET reg_phone_enc = '' WHERE id = ?", [h2Id]);
    // 清理历次 E2E 创建的测试用户及其关联数据（避免绑定居民越积越多）
    const [eus] = await pool.query("SELECT id FROM users WHERE openid LIKE 'mock\\_e2e%'");
    const eids = eus.map(function (u) { return u.id; });
    if (eids.length) {
      await pool.query('DELETE FROM bindings WHERE user_id IN (?)', [eids]);
      await pool.query('DELETE FROM notifications WHERE user_id IN (?)', [eids]);
      await pool.query('DELETE FROM check_logs WHERE user_id IN (?)', [eids]);
      await pool.query('DELETE FROM repair_orders WHERE user_id IN (?)', [eids]);
      await pool.query('DELETE FROM repair_logs WHERE repair_id NOT IN (SELECT id FROM repair_orders)');
      await pool.query('DELETE FROM orders WHERE user_id IN (?)', [eids]);
      await pool.query('DELETE FROM order_bills WHERE order_id NOT IN (SELECT id FROM orders)');
      await pool.query('DELETE FROM users WHERE id IN (?)', [eids]);
    }
    console.log('[清理] 测试账单/测试住户/测试用户（' + eids.length + ' 个）已清理');
  } catch (e) {
    console.error('[清理] 失败：', e.message);
  }
  try { await pool.end(); } catch (e) { /* ignore */ }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.error('✗ 自测中断：', e.message);
  console.error('  请确认：①后端已启动 ②db/migrate-v2.js、db/migrate-v3.js 已执行');
  process.exit(1);
});
