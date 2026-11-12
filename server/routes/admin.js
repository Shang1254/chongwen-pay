// ============================================================
// 物业后台接口：登录、总览、欠费名单、抄表录入、住户管理、用量分析
// 新增：Excel/CSV 批量导入、收款记录、一键催缴、报修管理、
//       物业费录入、监管留痕查询与导出
// 所有接口都要"物业管理员"通行证才能用
// ============================================================
const express = require('express');
const router = express.Router();
const config = require('../config');
const { pool } = require('../db/pool');
const tool = require('../utils/tool');
const cryptoUtil = require('../utils/crypto');
const { auth } = require('../utils/auth');
const billCheck = require('../agents/bill-check-agent');
const remindAgent = require('../agents/remind-agent');
const usageAgent = require('../agents/usage-agent');
const spreadsheet = require('../services/spreadsheet');
const orderSvc = require('../services/order');
const wxpay = require('../services/wxpay');
const voucherSvc = require('../services/voucher');

// ---------- 小工具 ----------
function feeLabel(type) {
  if (type === 'electric') return '电费';
  if (type === 'water') return '水费';
  if (type === 'property') return '物业费';
  return '其他费用';
}
function pad2(n) { return String(n).padStart(2, '0'); }
function roomLabelOf(h) {
  return h.building + '栋' + h.unit + '单元' + h.room_no + '室';
}

function channelLabel(mode) {
  if (mode === 'wechat') return '微信支付';
  if (mode === 'mock') return '演示支付';
  if (mode === 'offline') return '线下收费';
  if (mode === 'cash') return '现金';
  if (mode === 'pos') return 'POS刷卡';
  return mode || '其他';
}

function maskPhone(p) {
  const s = String(p || '');
  return s.length >= 7 ? s.slice(0, 3) + '****' + s.slice(-4) : s;
}

// 物业操作日志：后台每个动作都留痕（审计要求）
async function logAdmin(req, action, target, detail) {
  try {
    await pool.query(
      'INSERT INTO admin_logs (admin_id, action, target, detail, ip) VALUES (?, ?, ?, ?, ?)',
      [
        req.user ? req.user.id : 0,
        String(action).slice(0, 30),
        String(target || '').slice(0, 100),
        String(detail || '').slice(0, 500),
        (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || ''
      ]
    );
  } catch (e) {
    console.error('[操作日志] 写入失败：', e.message);
  }
}

// ---------- 登录 ----------
router.post('/login', async function (req, res, next) {
  try {
    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) {
      return res.json({ ok: false, message: '请输入账号和密码' });
    }
    const [rows] = await pool.query(
      "SELECT * FROM users WHERE username = ? AND role = 'admin' LIMIT 1",
      [username]
    );
    if (!rows[0] || rows[0].password !== tool.sha256(config.pwdSalt + password)) {
      return res.json({ ok: false, message: '账号或密码不对（初始账号 admin / admin123）' });
    }
    await logAdmin(req, 'login', username, '物业后台登录成功');
    res.json({
      ok: true,
      data: {
        token: tool.makeToken(rows[0].openid, 'admin'),
        nickname: rows[0].nickname,
        mockMode: config.mockMode,
        company: config.company,
        community: config.community
      }
    });
  } catch (e) { next(e); }
});

// ---------- 总览：几个关键数字 ----------
router.get('/overview', auth('admin'), async function (req, res, next) {
  try {
    const [[u]] = await pool.query(
      "SELECT COUNT(*) AS cnt, IFNULL(SUM(amount),0) AS amt FROM bills WHERE status = 'unpaid'"
    );
    const [[o]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM bills WHERE status = 'unpaid' AND due_date < CURDATE()"
    );
    const [[r]] = await pool.query('SELECT COUNT(*) AS cnt FROM bindings');
    const [[t]] = await pool.query(
      "SELECT COUNT(*) AS cnt FROM notifications WHERE send_date = CURDATE()"
    );
    const [rep] = await pool.query(
      'SELECT * FROM daily_reports ORDER BY report_date DESC LIMIT 1'
    );

    // 新增：待处理报修、今日实收（表可能还没升级，容错处理）
    let repairPending = 0;
    let todayPaidCount = 0;
    let todayPaidAmount = 0;
    let monthProgress = { households: 0, electric: 0, water: 0, property: 0 };
    try {
      const [[p]] = await pool.query("SELECT COUNT(*) AS cnt FROM repair_orders WHERE status != 'done'");
      repairPending = p.cnt;
      const [[tp]] = await pool.query(
        "SELECT COUNT(*) AS cnt, IFNULL(SUM(amount),0) AS amt FROM orders WHERE status = 'success' AND DATE(paid_at) = CURDATE()"
      );
      todayPaidCount = tp.cnt;
      todayPaidAmount = Number(tp.amt);
      // 本月抄表/录入进度：每种费用已有多少户生成账单
      const cur = tool.periodNow();
      const [[ht]] = await pool.query('SELECT COUNT(*) AS c FROM households WHERE status = 1');
      const cntBy = async function (t) {
        const [[x]] = await pool.query('SELECT COUNT(DISTINCT household_id) AS c FROM bills WHERE period = ? AND type = ?', [cur, t]);
        return x.c;
      };
      monthProgress = {
        households: ht.c,
        electric: await cntBy('electric'),
        water: await cntBy('water'),
        property: await cntBy('property')
      };
    } catch (e) { /* 还没执行升级脚本时忽略 */ }

    res.json({
      ok: true,
      data: {
        unpaidCount: u.cnt,
        unpaidAmount: Number(u.amt),
        overdueCount: o.cnt,
        boundResidents: r.cnt,
        todayNotifies: t.cnt,
        repairPending: repairPending,
        todayPaidCount: todayPaidCount,
        todayPaidAmount: todayPaidAmount,
        monthProgress: monthProgress,
        latestReport: rep[0] ? {
          date: String(rep[0].report_date).slice(0, 10),
          unpaidCount: rep[0].unpaid_count,
          unpaidAmount: Number(rep[0].unpaid_amount)
        } : null
      }
    });
  } catch (e) { next(e); }
});

// ---------- 欠费名单（服务端分页 + 筛选，1200户规模也流畅） ----------
// 参数：page/pageSize/keyword(房号或户主)/unit/type/overdue=1(只看逾期)
//       sort=overdue(按逾期天数倒序，工作台用) / all=1(不分页，导出用，上限2000)
router.get('/unpaid', auth('admin'), async function (req, res, next) {
  try {
    const q = req.query || {};
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 20));
    const keyword = String(q.keyword || '').trim();
    const unit = String(q.unit || '').trim();
    const type = String(q.type || '').trim();
    const overdueOnly = q.overdue === '1';
    const wantAll = q.all === '1';
    const sortOverdue = q.sort === 'overdue';

    const where = ["b.status = 'unpaid'"];
    const args = [];
    if (keyword) {
      where.push('(CONCAT(h.building, "栋", h.unit, "单元", h.room_no, "室") LIKE ? OR h.owner_name LIKE ?)');
      args.push('%' + keyword + '%', '%' + keyword + '%');
    }
    if (unit) { where.push('h.unit = ?'); args.push(unit); }
    if (type) { where.push('b.type = ?'); args.push(type); }
    if (overdueOnly) { where.push('b.due_date < CURDATE()'); }
    const whereSql = 'WHERE ' + where.join(' AND ');

    const [[cnt]] = await pool.query(
      'SELECT COUNT(*) AS c FROM bills b JOIN households h ON h.id = b.household_id ' + whereSql,
      args
    );
    const total = cnt.c;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const orderSql = sortOverdue
      ? 'ORDER BY DATEDIFF(CURDATE(), b.due_date) DESC, b.due_date ASC'
      : 'ORDER BY b.due_date ASC, b.id ASC';
    // 数字已经在上面做过范围校验，这里直接拼进 SQL（mysql2 占位符对 LIMIT 兼容性一般）
    const limitSql = wantAll
      ? ' LIMIT 2000'
      : ' LIMIT ' + pageSize + ' OFFSET ' + (page - 1) * pageSize;

    const [rows] = await pool.query(
      'SELECT b.id, b.type, b.period, b.amount, b.due_date, DATEDIFF(CURDATE(), b.due_date) AS overdue_days, ' +
      'h.building, h.unit, h.room_no, h.owner_name ' +
      'FROM bills b JOIN households h ON h.id = b.household_id ' + whereSql + ' ' + orderSql + limitSql,
      args
    );

    res.json({
      ok: true,
      data: {
        rows: rows.map(function (b) {
          return {
            id: b.id,
            roomLabel: roomLabelOf(b),
            ownerName: b.owner_name,
            type: b.type,
            typeLabel: feeLabel(b.type),
            period: b.period,
            amount: Number(b.amount),
            dueDate: String(b.due_date).slice(0, 10),
            overdueDays: Math.max(0, b.overdue_days)
          };
        }),
        total: total,
        page: page,
        pageSize: pageSize,
        totalPages: totalPages
      }
    });
  } catch (e) { next(e); }
});

// ---------- 一键催缴：给所有"已绑定且欠费"的住户推送提醒 ----------
router.post('/push-unpaid', auth('admin'), async function (req, res, next) {
  try {
    const r = await remindAgent.pushAllUnpaid();
    await logAdmin(req, 'push-unpaid', '一键催缴', '发出 ' + r.sent + ' 条提醒（覆盖 ' + r.bills + ' 张账单）');
    res.json({
      ok: true,
      data: {
        message: '催缴完成：成功发出 ' + r.sent + ' 条（覆盖 ' + r.bills + ' 张欠费账单；' +
          (config.mockMode ? '演示模式下消息只记录、不真实推送' : '已通过微信订阅消息推送') + '）',
        sent: r.sent,
        bills: r.bills
      }
    });
  } catch (e) { next(e); }
});

// ---------- 收款记录（订单维度，服务端分页 + 筛选） ----------
// 参数：page/pageSize/date(按支付日期)/status/keyword(订单号/支付单号/凭证号)
router.get('/orders', auth('admin'), async function (req, res, next) {
  try {
    const q = req.query || {};
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 20));
    const date = String(q.date || '').trim();
    const status = String(q.status || '').trim();
    const keyword = String(q.keyword || '').trim();

    const where = ["1 = 1"];
    const args = [];
    if (date) { where.push('DATE(o.paid_at) = ?'); args.push(date); }
    if (status) { where.push('o.status = ?'); args.push(status); }
    if (keyword) {
      where.push('(o.order_no LIKE ? OR o.transaction_id LIKE ? OR o.voucher_no LIKE ?)');
      args.push('%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%');
    }
    const whereSql = 'WHERE ' + where.join(' AND ');

    const joinSql =
      'FROM orders o ' +
      'LEFT JOIN order_bills ob ON ob.order_id = o.id ' +
      'LEFT JOIN bills b ON b.id = ob.bill_id OR (ob.bill_id IS NULL AND b.id = o.bill_id) ' +
      'LEFT JOIN households h ON h.id = b.household_id ';

    const [[cnt]] = await pool.query(
      'SELECT COUNT(*) AS c FROM (SELECT o.id FROM orders o ' +
      'LEFT JOIN order_bills ob ON ob.order_id = o.id ' +
      'LEFT JOIN bills b ON b.id = ob.bill_id OR (ob.bill_id IS NULL AND b.id = o.bill_id) ' +
      'LEFT JOIN households h ON h.id = b.household_id ' + whereSql + ' GROUP BY o.id) t',
      args
    );
    const total = cnt.c;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const [rows] = await pool.query(
      'SELECT o.id, o.order_no, o.amount, o.status, o.pay_mode, o.transaction_id, o.paid_at, o.created_at, o.voucher_no, ' +
      'o.refund_status, o.refund_amount, ' +
      "GROUP_CONCAT(DISTINCT CONCAT(h.building,'栋',h.unit,'单元',h.room_no,'室') SEPARATOR '、') AS rooms, " +
      'GROUP_CONCAT(DISTINCT b.type) AS types ' +
      joinSql + whereSql + ' GROUP BY o.id ORDER BY o.id DESC LIMIT ' + pageSize + ' OFFSET ' + (page - 1) * pageSize,
      args
    );

    const STATUS = { created: '待支付', success: '已支付', closed: '已关闭', failed: '支付失败' };
    res.json({
      ok: true,
      data: {
        rows: rows.map(function (o) {
          return {
            orderNo: o.order_no,
            rooms: o.rooms || '-',
            typeLabel: (o.types || '').split(',').filter(Boolean).map(feeLabel).join('、') || '-',
            amount: Number(o.amount),
            status: o.status,
            statusLabel: STATUS[o.status] || o.status,
            payMode: o.pay_mode === 'mock' ? '演示' : '微信支付',
            transactionId: o.transaction_id || '',
            voucherNo: o.voucher_no || '',
            refundStatus: o.refund_status || '',
            refundAmount: Number(o.refund_amount || 0),
            paidAt: o.paid_at ? String(o.paid_at).slice(0, 19) : '',
            createdAt: String(o.created_at).slice(0, 19)
          };
        }),
        total: total,
        page: page,
        pageSize: pageSize,
        totalPages: totalPages
      }
    });
  } catch (e) { next(e); }
});

// ---------- 报修管理 ----------
router.get('/repairs', auth('admin'), async function (req, res, next) {
  try {
    const [rows] = await pool.query(
      'SELECT r.*, h.building, h.unit, h.room_no FROM repair_orders r ' +
      'LEFT JOIN households h ON h.id = r.household_id ' +
      "ORDER BY (r.status = 'done') ASC, r.id DESC LIMIT 200"
    );
    const S = { pending: '待处理', doing: '处理中', done: '已完成' };
    res.json({
      ok: true,
      data: rows.map(function (r) {
        return {
          id: r.id,
          roomLabel: r.building ? roomLabelOf(r) : '未绑定房号',
          category: r.category,
          content: r.content,
          img: r.img_url || '',
          contact: cryptoUtil.decryptText(r.contact_enc),
          status: r.status,
          statusLabel: S[r.status] || r.status,
          priority: r.priority || 'normal',
          priorityLabel: r.priority === 'urgent' ? '紧急' : (r.priority === 'high' ? '加急' : '普通'),
          assignee: r.assignee || '',
          feedback: r.feedback || '',
          createdAt: String(r.created_at).slice(0, 19)
        };
      })
    });
  } catch (e) { next(e); }
});

router.post('/repair-status', auth('admin'), async function (req, res, next) {
  try {
    const b = req.body || {};
    const id = Number(b.id);
    const status = String(b.status || '');
    if (!id) return res.json({ ok: false, message: '缺少报修ID' });
    const [oldRows] = await pool.query('SELECT * FROM repair_orders WHERE id = ? LIMIT 1', [id]);
    if (!oldRows[0]) return res.json({ ok: false, message: '报修不存在' });
    const old = oldRows[0];

    const sets = [];
    const args = [];
    if (['pending', 'doing', 'done'].indexOf(status) >= 0) { sets.push('status = ?'); args.push(status); }
    if (b.assignee !== undefined) { sets.push('assignee = ?'); args.push(String(b.assignee || '').slice(0, 30)); }
    if (b.priority !== undefined && ['normal', 'high', 'urgent'].indexOf(b.priority) >= 0) {
      sets.push('priority = ?'); args.push(b.priority);
    }
    if (b.feedback !== undefined) { sets.push('feedback = ?'); args.push(String(b.feedback || '').slice(0, 300)); }
    if (!sets.length) return res.json({ ok: false, message: '没有要更新的字段' });

    sets.push('updated_at = NOW()');
    args.push(id);
    await pool.query('UPDATE repair_orders SET ' + sets.join(', ') + ' WHERE id = ?', args);

    // 看板拖拽/改派都写工单流转日志，方便追责
    const newStatus = ['pending', 'doing', 'done'].indexOf(status) >= 0 ? status : old.status;
    if (newStatus !== old.status || b.assignee !== undefined || b.priority !== undefined) {
      await pool.query(
        'INSERT INTO repair_logs (repair_id, from_status, to_status, operator, note) VALUES (?, ?, ?, ?, ?)',
        [id, old.status, newStatus, '物业管理员',
          (b.feedback ? String(b.feedback).slice(0, 300) : '') +
          (b.assignee !== undefined ? ' 指派:' + (b.assignee || '未指派') : '') +
          (b.priority !== undefined ? ' 优先级:' + ({ normal: '普通', high: '加急', urgent: '紧急' })[b.priority] : '')]
      );
    }

    await logAdmin(req, 'repair-status', '报修#' + id,
      '状态 ' + (newStatus) + (b.assignee !== undefined ? '，师傅:' + (b.assignee || '未指派') : '') +
      (b.priority !== undefined ? '，优先级:' + b.priority : '') + (b.feedback ? '，回复：' + b.feedback : ''));
    res.json({
      ok: true,
      data: {
        message: '已更新为「' + ({ pending: '待处理', doing: '处理中', done: '已完成' })[newStatus] + '」' +
          (b.assignee !== undefined && b.assignee ? '，指派给 ' + b.assignee : '')
      }
    });
  } catch (e) { next(e); }
});

// ---------- 缴费看板：按单元/楼层/房号看当期收缴情况（热力图） ----------
router.get('/collection-board', auth('admin'), async function (req, res, next) {
  try {
    const period = String((req.query && req.query.period) || '').trim() || tool.periodNow();
    const [hs] = await pool.query(
      'SELECT * FROM households WHERE status = 1 ORDER BY unit, room_no'
    );
    const [billRows] = await pool.query(
      'SELECT household_id, type, status, amount FROM bills WHERE period = ?',
      [period]
    );
    const map = {};
    billRows.forEach(function (b) {
      const m = map[b.household_id] || (map[b.household_id] = { total: 0, paid: 0, amount: 0, paidAmount: 0 });
      m.total++;
      m.amount += Number(b.amount);
      if (b.status === 'paid') { m.paid++; m.paidAmount += Number(b.amount); }
    });

    const rows = hs.map(function (h) {
      const m = map[h.id] || { total: 0, paid: 0, amount: 0, paidAmount: 0 };
      let status = 'none';
      if (m.total > 0) status = m.paid === m.total ? 'paid' : (m.paid > 0 ? 'partial' : 'unpaid');
      return {
        householdId: h.id,
        roomLabel: roomLabelOf(h),
        unit: h.unit,
        floor: Number(String(h.room_no).slice(0, 1)) || 0,
        room: h.room_no,
        total: m.total,
        paid: m.paid,
        amount: Math.round(m.amount * 100) / 100,
        paidAmount: Math.round(m.paidAmount * 100) / 100,
        status: status
      };
    });

    const units = ['1', '2'].map(function (u) {
      const rs = rows.filter(function (r) { return r.unit === u; });
      const paid = rs.filter(function (r) { return r.status === 'paid'; }).length;
      const totalAmount = Math.round(rs.reduce(function (s, r) { return s + r.amount; }, 0) * 100) / 100;
      const paidAmount = Math.round(rs.reduce(function (s, r) { return s + r.paidAmount; }, 0) * 100) / 100;
      return {
        unit: u,
        households: rs.length,
        allPaid: paid,
        rate: rs.length ? Math.round(paid / rs.length * 100) : 0,
        totalAmount: totalAmount,
        paidAmount: paidAmount,
        rateAmount: totalAmount ? Math.round(paidAmount / totalAmount * 100) : 0
      };
    });

    res.json({
      ok: true,
      data: {
        period: period,
        households: rows,
        summary: {
          households: rows.length,
          allPaid: rows.filter(function (r) { return r.status === 'paid'; }).length,
          partial: rows.filter(function (r) { return r.status === 'partial'; }).length,
          unpaid: rows.filter(function (r) { return r.status === 'unpaid'; }).length,
          none: rows.filter(function (r) { return r.status === 'none'; }).length
        },
        units: units
      }
    });
  } catch (e) { next(e); }
});

// ---------- 住户管理 ----------
router.get('/households', auth('admin'), async function (req, res, next) {
  try {
    const [rows] = await pool.query(
      'SELECT h.*, ' +
      '(SELECT COUNT(*) FROM bindings bd WHERE bd.household_id = h.id) AS bound_count, ' +
      "(SELECT COUNT(*) FROM bills b WHERE b.household_id = h.id AND b.status = 'unpaid') AS unpaid_count " +
      'FROM households h WHERE h.status = 1 ORDER BY h.unit, h.room_no'
    );
    // 实时欠费聚合：一条 GROUP BY 查询算出每户每类费用的欠费笔数与金额
    const [agg] = await pool.query(
      "SELECT household_id, type, COUNT(*) AS c, SUM(amount) AS s FROM bills WHERE status = 'unpaid' GROUP BY household_id, type"
    );
    const owes = {};
    agg.forEach(function (r) {
      owes[r.household_id + '_' + r.type] = { count: r.c, amount: Number(r.s) };
    });

    res.json({
      ok: true,
      data: rows.map(function (h) {
        const oe = owes[h.id + '_electric'] || { count: 0, amount: 0 };
        const ow = owes[h.id + '_water'] || { count: 0, amount: 0 };
        const op = owes[h.id + '_property'] || { count: 0, amount: 0 };
        const total = Math.round((oe.amount + ow.amount + op.amount) * 100) / 100;
        return {
          id: h.id,
          roomLabel: roomLabelOf(h),
          ownerName: h.owner_name,
          area: h.area !== undefined ? Number(h.area) : 90,
          regPhone: h.reg_phone_enc ? maskPhone(cryptoUtil.decryptText(h.reg_phone_enc)) : '',
          waterBalance: Number(h.water_balance || 0),
          electricAccount: h.electric_account,
          waterAccount: h.water_account,
          boundCount: h.bound_count,
          unpaidCount: h.unpaid_count,
          owe: {
            electric: oe, water: ow, property: op,
            count: oe.count + ow.count + op.count,
            total: total
          }
        };
      })
    });
  } catch (e) { next(e); }
});

// 住户详情：实时欠费明细 + 绑定居民 + 最近缴费（点"👁"时拉取）
router.get('/household-detail', auth('admin'), async function (req, res, next) {
  try {
    const id = Number((req.query && req.query.householdId) || 0);
    if (!id) return res.json({ ok: false, message: '缺少住户ID' });
    const [hs] = await pool.query('SELECT * FROM households WHERE id = ? LIMIT 1', [id]);
    if (!hs[0]) return res.json({ ok: false, message: '住户不存在' });
    const h = hs[0];

    const [unpaid] = await pool.query(
      "SELECT * FROM bills WHERE household_id = ? AND status = 'unpaid' ORDER BY due_date ASC", [id]
    );
    const [paid] = await pool.query(
      "SELECT * FROM bills WHERE household_id = ? AND status = 'paid' ORDER BY paid_at DESC LIMIT 5", [id]
    );
    const [bs] = await pool.query(
      'SELECT u.nickname, bd.role, bd.phone_enc FROM bindings bd JOIN users u ON u.id = bd.user_id WHERE bd.household_id = ?',
      [id]
    );

    const sumBy = function (t) {
      const rows = unpaid.filter(function (b) { return b.type === t; });
      return {
        count: rows.length,
        amount: Math.round(rows.reduce(function (s, b) { return s + Number(b.amount); }, 0) * 100) / 100
      };
    };

    res.json({
      ok: true,
      data: {
        household: {
          id: h.id,
          roomLabel: roomLabelOf(h),
          ownerName: h.owner_name,
          area: Number(h.area || 90),
          regPhone: h.reg_phone_enc ? maskPhone(cryptoUtil.decryptText(h.reg_phone_enc)) : '',
          waterBalance: Number(h.water_balance || 0),
          electricAccount: h.electric_account,
          waterAccount: h.water_account
        },
        owes: {
          electric: sumBy('electric'),
          water: sumBy('water'),
          property: sumBy('property'),
          total: Math.round(unpaid.reduce(function (s, b) { return s + Number(b.amount); }, 0) * 100) / 100
        },
        unpaid: unpaid.map(function (b) {
          return {
            id: b.id, typeLabel: feeLabel(b.type), period: b.period,
            amount: Number(b.amount), dueDate: String(b.due_date).slice(0, 10),
            overdueDays: Math.max(0, -tool.daysFromToday(b.due_date))
          };
        }),
        paid: paid.map(function (b) {
          return {
            typeLabel: feeLabel(b.type), period: b.period, amount: Number(b.amount),
            paidAt: b.paid_at ? String(b.paid_at).slice(0, 10) : ''
          };
        }),
        bindings: bs.map(function (x) {
          return {
            nickname: x.nickname || ('#' + x.id),
            roleLabel: x.role === 'tenant' ? '租户' : '业主',
            phone: maskPhone(cryptoUtil.decryptText(x.phone_enc))
          };
        })
      }
    });
  } catch (e) { next(e); }
});

// 定向催缴：给某一户的绑定居民推送欠费提醒（同一天同一账单同一居民只发一次）
router.post('/notify-household', auth('admin'), async function (req, res, next) {
  try {
    const b = req.body || {};
    const id = Number(b.householdId);
    const billIds = (b.billIds || []).map(Number).filter(Boolean);
    if (!id) return res.json({ ok: false, message: '缺少住户ID' });

    const [hs] = await pool.query('SELECT * FROM households WHERE id = ? LIMIT 1', [id]);
    if (!hs[0]) return res.json({ ok: false, message: '住户不存在' });
    const h = hs[0];

    // 目标账单：指定 billIds 就只催指定的（必须是这户未缴的），否则催全部未缴
    let rows;
    if (billIds.length) {
      [rows] = await pool.query(
        "SELECT * FROM bills WHERE household_id = ? AND id IN (?) AND status = 'unpaid'",
        [id, billIds]
      );
    } else {
      [rows] = await pool.query(
        "SELECT * FROM bills WHERE household_id = ? AND status = 'unpaid' ORDER BY due_date ASC",
        [id]
      );
    }
    if (!rows.length) return res.json({ ok: false, message: '这户没有待缴账单，无需催缴' });

    const [bs] = await pool.query(
      'SELECT bd.user_id, u.openid FROM bindings bd JOIN users u ON u.id = bd.user_id WHERE bd.household_id = ?',
      [id]
    );
    if (!bs.length) {
      return res.json({
        ok: false,
        message: '这户还没有居民绑定小程序，无法在线推送。请先电话通知业主缴费（' + config.propertyPhone + '），或等业主绑定后在线催缴。'
      });
    }

    let sent = 0;
    let skipped = 0;
    for (const bd of bs) {
      for (const bill of rows) {
        // 当天同一居民同一账单只发一次，防止反复轰炸
        const [ex] = await pool.query(
          "SELECT id FROM notifications WHERE bill_id = ? AND type = 'manual_push' AND user_id = ? AND send_date = ? LIMIT 1",
          [bill.id, bd.user_id, tool.today()]
        );
        if (ex.length) { skipped++; continue; }
        const ok = await remindAgent.push(
          bd.user_id, bill.id, 'manual_push', '物业催缴',
          '您家 ' + bill.period + ' 的' + feeLabel(bill.type) + ' ¥' + Number(bill.amount).toFixed(2) +
          ' 还没缴，请尽快在"崇文兰亭缴费通"缴纳。'
        );
        if (ok) sent++; else skipped++;
      }
    }

    await logAdmin(req, 'notify-household', roomLabelOf(h),
      '定向催缴：账单 ' + rows.length + ' 笔 × 居民 ' + bs.length + ' 人，成功 ' + sent + ' 条，去重跳过 ' + skipped + ' 条');

    res.json({
      ok: true,
      data: {
        sent: sent, skipped: skipped, bills: rows.length, users: bs.length,
        message: '已向 ' + bs.length + ' 位绑定居民推送 ' + rows.length + ' 笔账单的催缴提醒' +
          '（成功 ' + sent + ' 条' + (skipped ? '，今日重复已自动跳过 ' + skipped + ' 条' : '') + '）' +
          (config.mockMode ? '。演示模式下消息只记录、不真实推送。' : '')
      }
    });
  } catch (e) { next(e); }
});

// ---------- 抄表录入（水电，按读数算钱） ----------
// 录一笔账单的公共函数（单笔录入和文本批量导入都走这里）
async function addOneBill(item) {
  // 找住户
  const [hs] = await pool.query(
    'SELECT * FROM households WHERE building = ? AND unit = ? AND room_no = ? AND status = 1 LIMIT 1',
    [config.pilotBuilding, item.unit, item.roomNo]
  );
  if (!hs[0]) return { ok: false, message: '没找到 ' + config.pilotBuilding + '栋' + item.unit + '单元' + item.roomNo + ' 这户' };

  const h = hs[0];
  const type = item.type;
  const period = item.period;
  const curr = Number(item.currReading);

  // 上次读数 = 这个户这种表最近一张账单的本次读数
  const [last] = await pool.query(
    'SELECT curr_reading FROM bills WHERE household_id = ? AND type = ? ORDER BY period DESC LIMIT 1',
    [h.id, type]
  );
  const prev = last[0] ? Number(last[0].curr_reading) : 0;
  const usage = Math.round((curr - prev) * 100) / 100;
  const price = type === 'electric' ? config.prices.electric : config.prices.water;
  const amount = Math.round(usage * price * 100) / 100;

  if (curr < prev) {
    return { ok: false, message: h.unit + '单元' + h.roomNo + '：本次读数（' + curr + '）比上次（' + prev + '）还小，请核对抄表数' };
  }

  // 同户同类型同账期已存在就覆盖（抄错重录不脏库）
  await pool.query(
    'INSERT INTO bills (household_id, type, period, prev_reading, curr_reading, usage_qty, unit_price, amount, due_date, status) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE prev_reading = VALUES(prev_reading), curr_reading = VALUES(curr_reading), ' +
    'usage_qty = VALUES(usage_qty), unit_price = VALUES(unit_price), amount = VALUES(amount), ' +
    'due_date = VALUES(due_date), status = "unpaid", paid_at = NULL',
    [h.id, type, period, prev, curr, usage, price, amount, item.dueDate]
  );

  // 写完让校验 Agent 把把关，提醒带给物业
  const [nb] = await pool.query(
    'SELECT * FROM bills WHERE household_id = ? AND type = ? AND period = ?',
    [h.id, type, period]
  );
  let warnMsg = '';
  if (nb[0]) {
    const check = await billCheck.checkBills([nb[0]]);
    if (check.level !== 'ok') warnMsg = check.message;
  }
  return {
    ok: true,
    roomLabel: roomLabelOf(h),
    usage: usage, amount: amount, warn: warnMsg
  };
}

router.post('/addbill', auth('admin'), async function (req, res, next) {
  try {
    const b = req.body || {};
    if (!b.unit || !b.roomNo || !b.period || b.currReading === undefined || !b.dueDate) {
      return res.json({ ok: false, message: '信息没填全：单元、房号、账期、本次读数、截止日都要填' });
    }
    const type = b.type === 'water' ? 'water' : 'electric';
    const r = await addOneBill({
      unit: String(b.unit).trim(), roomNo: String(b.roomNo).trim(),
      type: type, period: String(b.period).trim(),
      currReading: b.currReading, dueDate: String(b.dueDate).trim()
    });
    if (r.ok) await logAdmin(req, 'addbill', r.roomLabel, '抄表录入：用量 ' + r.usage + '，金额 ¥' + r.amount);
    res.json({ ok: r.ok, message: r.ok ? '' : r.message, data: r });
  } catch (e) { next(e); }
});

// ---------- 物业费录入（按面积×单价，也支持直接填金额） ----------
router.post('/addproperty', auth('admin'), async function (req, res, next) {
  try {
    const b = req.body || {};
    if (!b.unit || !b.roomNo || !b.period || !b.dueDate) {
      return res.json({ ok: false, message: '信息没填全：单元、房号、账期、截止日都要填' });
    }
    const [hs] = await pool.query(
      'SELECT * FROM households WHERE building = ? AND unit = ? AND room_no = ? AND status = 1 LIMIT 1',
      [config.pilotBuilding, String(b.unit).trim(), String(b.roomNo).trim()]
    );
    if (!hs[0]) return res.json({ ok: false, message: '没找到这户' });

    const h = hs[0];
    const area = Number(h.area || 90);
    const amount = b.amount !== undefined && b.amount !== ''
      ? Math.round(Number(b.amount) * 100) / 100
      : Math.round(area * config.propertyFeeRate * 100) / 100;
    if (!(amount > 0)) return res.json({ ok: false, message: '金额不对，请检查' });

    await pool.query(
      'INSERT INTO bills (household_id, type, period, prev_reading, curr_reading, usage_qty, unit_price, amount, due_date, status) ' +
      "VALUES (?, 'property', ?, 0, 0, 0, ?, ?, ?, 'unpaid') " +
      'ON DUPLICATE KEY UPDATE unit_price = VALUES(unit_price), amount = VALUES(amount), ' +
      'due_date = VALUES(due_date), status = "unpaid", paid_at = NULL',
      [h.id, String(b.period).trim(), config.propertyFeeRate, amount, String(b.dueDate).trim()]
    );
    await logAdmin(req, 'addproperty', roomLabelOf(h), '物业费录入 ¥' + amount + '（' + String(b.period).trim() + '）');
    res.json({
      ok: true,
      data: { roomLabel: h.building + '栋' + h.unit + '单元' + h.room_no + '室', area: area, amount: amount, message: '物业费已录入：' + roomLabelOf(h) + ' ¥' + amount }
    });
  } catch (e) { next(e); }
});

// ---------- 文本批量导入（老的 CSV 文本方式，保留） ----------
router.post('/importbills', auth('admin'), async function (req, res, next) {
  try {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) return res.json({ ok: false, message: '请粘贴导入内容' });
    const lines = text.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    const results = [];
    for (const line of lines) {
      const parts = line.split(',').map(function (s) { return s.trim(); });
      if (parts.length < 5) { results.push({ line: line, ok: false, message: '格式不对（应为 5 段，逗号隔开）' }); continue; }
      const room = parts[0].split('-');
      const type = (parts[1] === '水' || parts[1] === '水费') ? 'water' : 'electric';
      if (room.length !== 2) { results.push({ line: line, ok: false, message: '房号格式不对，应为 单元-房号' }); continue; }
      const r = await addOneBill({
        unit: room[0], roomNo: room[1], type: type,
        period: parts[2], currReading: parts[3], dueDate: parts[4]
      });
      results.push({ line: line, ok: r.ok, message: r.ok ? ('成功：' + r.roomLabel + ' 用量' + r.usage + ' ¥' + r.amount) : r.message, warn: r.warn || '' });
    }
    const fail = results.filter(function (r) { return !r.ok; }).length;
    await logAdmin(req, 'import-csv', '批量导入', '成功 ' + (results.length - fail) + ' 行，失败 ' + fail + ' 行');
    res.json({ ok: true, data: { total: results.length, fail: fail, results: results } });
  } catch (e) { next(e); }
});

// ---------- Excel / CSV 批量导入（物业重点功能） ----------
// 表头自动识别，列顺序不敏感；支持 电费/水费/物业费
// 必填列：房号（或 单元+房号）、金额（电水可只用用量）、账期
const HEADER_ALIASES = {
  unit: ['单元', '栋', '幢'],
  room: ['房号', '房间', '门牌'],
  owner: ['户主', '业主', '姓名'],
  type: ['费用类型', '收费项目', '项目', '类型'],
  period: ['账期', '所属期', '费用月份', '月份'],
  amount: ['金额', '应缴', '应收', '费用金额'],
  usage: ['用量', '读数差'],
  due: ['到期', '截止', '期限']
};

function normHeader(h) { return String(h || '').replace(/[\s　()（）]/g, ''); }

function findCol(row, aliases) {
  for (let i = 0; i < row.length; i++) {
    const h = normHeader(row[i]);
    for (const a of aliases) { if (h.indexOf(a) >= 0) return i; }
  }
  return -1;
}

function normType(v) {
  const s = String(v || '').trim();
  if (/物业/.test(s)) return 'property';
  if (/水/.test(s)) return 'water';
  if (/电/.test(s)) return 'electric';
  return '';
}

function normPeriod(v) {
  if (v === undefined || v === null || v === '') return '';
  if (v instanceof Date) return v.getFullYear() + '-' + pad2(v.getMonth() + 1);
  // 支持 2026-11 / 2026年11月 / 2026/11 等写法（年份不限 20xx，1919 也认）
  const m = String(v).match(/((?:19|20)\d{2})\D{0,3}(\d{1,2})/);
  return m ? m[1] + '-' + pad2(Number(m[2])) : '';
}

function normDate(v) {
  if (v === undefined || v === null || v === '') return '';
  if (v instanceof Date) return v.getFullYear() + '-' + pad2(v.getMonth() + 1) + '-' + pad2(v.getDate());
  const m = String(v).match(/(20\d{2})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/);
  return m ? m[1] + '-' + pad2(Number(m[2])) + '-' + pad2(Number(m[3])) : '';
}

function toNum(v) {
  if (v === undefined || v === null || v === '') return NaN;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[^\d.\-]/g, ''));
  return isFinite(n) ? n : NaN;
}

// 账期次月 15 号作为默认截止日
function defaultDue(period) {
  const p = period.split('-').map(Number);
  const d = new Date(p[0], p[1], 15);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 识别表头：扫描前 15 行，找到最像表头的一行
function analyzeSheet(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const row = rows[i] || [];
    const cols = {
      unit: findCol(row, HEADER_ALIASES.unit),
      room: findCol(row, HEADER_ALIASES.room),
      owner: findCol(row, HEADER_ALIASES.owner),
      type: findCol(row, HEADER_ALIASES.type),
      period: findCol(row, HEADER_ALIASES.period),
      amount: findCol(row, HEADER_ALIASES.amount),
      usage: findCol(row, HEADER_ALIASES.usage),
      due: findCol(row, HEADER_ALIASES.due)
    };
    const hits = Object.keys(cols).filter(function (k) { return cols[k] >= 0; }).length;
    if (cols.room >= 0 && hits >= 3) return { headerIndex: i, cols: cols };
  }
  // 没有表头：按固定顺序假设 —— 单元,房号,户主,类型,账期,金额,用量,到期日
  return {
    headerIndex: -1,
    cols: { unit: 0, room: 1, owner: 2, type: 3, period: 4, amount: 5, usage: 6, due: 7 }
  };
}

router.post('/import-excel', auth('admin'), async function (req, res, next) {
  try {
    const body = req.body || {};
    if (!body.base64) return res.json({ ok: false, message: '没有收到文件，请重新选择' });

    let parsed;
    try {
      parsed = await spreadsheet.parseTable(body.fileName, body.base64);
    } catch (e) {
      return res.json({ ok: false, message: e.message });
    }

    const rows = parsed.rows || [];
    if (rows.length > 2000) {
      return res.json({ ok: false, message: '一次最多导入 2000 行，请拆分文件' });
    }
    const sheet = analyzeSheet(rows);
    const cols = sheet.cols;
    const results = [];
    let ok = 0;

    for (let i = sheet.headerIndex + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      if (!row.length || row.every(function (c) { return c === '' || c === null; })) continue;
      const lineNo = i + 1;

      // 取各列的值
      let unit = cols.unit >= 0 ? String(row[cols.unit] || '').trim() : '';
      let roomNo = cols.room >= 0 ? String(row[cols.room] || '').trim() : '';
      const owner = cols.owner >= 0 ? String(row[cols.owner] || '').trim() : '';
      let type = normType(cols.type >= 0 ? row[cols.type] : '');
      const period = normPeriod(cols.period >= 0 ? row[cols.period] : '');
      let amount = cols.amount >= 0 ? toNum(row[cols.amount]) : NaN;
      const usageIn = cols.usage >= 0 ? toNum(row[cols.usage]) : NaN;
      let due = cols.due >= 0 ? normDate(row[cols.due]) : '';

      // 房号可能写成 "1-302"
      if ((!unit || !roomNo) && roomNo.indexOf('-') > 0) {
        const parts = roomNo.split('-');
        unit = unit || parts[0].trim();
        roomNo = parts.slice(1).join('-').trim();
      }
      if (!unit) unit = config.pilotBuilding; // 只写房号时默认试点楼栋
      if (!roomNo) { results.push({ line: '第' + lineNo + '行', ok: false, message: '缺房号' }); continue; }
      if (!period) { results.push({ line: '第' + lineNo + '行', ok: false, message: '缺账期（如 2026-11）' }); continue; }
      if (!type) type = 'electric'; // 没写类型默认按电费
      if (!due) due = defaultDue(period);

      // 找住户
      const [hs] = await pool.query(
        'SELECT * FROM households WHERE building = ? AND unit = ? AND room_no = ? AND status = 1 LIMIT 1',
        [config.pilotBuilding, unit, roomNo]
      );
      if (!hs[0]) {
        results.push({ line: '第' + lineNo + '行', ok: false, message: '没找到 ' + config.pilotBuilding + '栋' + unit + '单元' + roomNo + ' 这户' });
        continue;
      }
      const h = hs[0];
      let warn = '';
      if (owner && owner !== h.owner_name) warn = '户主写的是"' + owner + '"，系统登记是"' + h.owner_name + '"，已按房号入库';

      // 算金额
      let usage = usageIn;
      if (!isFinite(usage)) usage = 0;
      let price = 0;
      if (type === 'property') {
        price = config.propertyFeeRate;
        usage = 0;
        if (!isFinite(amount) || amount <= 0) {
          const area = Number(h.area || 90);
          amount = Math.round(area * price * 100) / 100;
        }
      } else {
        if (isFinite(amount) && amount > 0) {
          price = usage > 0 ? Math.round(amount / usage * 10000) / 10000 : (type === 'electric' ? config.prices.electric : config.prices.water);
        } else if (usage > 0) {
          price = type === 'electric' ? config.prices.electric : config.prices.water;
          amount = Math.round(usage * price * 100) / 100;
        } else {
          results.push({ line: '第' + lineNo + '行', ok: false, message: '金额或用量至少要有一个' });
          continue;
        }
      }
      amount = Math.round(amount * 100) / 100;

      await pool.query(
        'INSERT INTO bills (household_id, type, period, prev_reading, curr_reading, usage_qty, unit_price, amount, due_date, status) ' +
        'VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?, ?) ' +
        'ON DUPLICATE KEY UPDATE usage_qty = VALUES(usage_qty), unit_price = VALUES(unit_price), ' +
        'amount = VALUES(amount), due_date = VALUES(due_date), status = "unpaid", paid_at = NULL',
        [h.id, type, period, usage, price, amount, due, 'unpaid']
      );

      ok++;
      results.push({
        line: '第' + lineNo + '行',
        ok: true,
        message: roomLabelOf(h) + ' ' + feeLabel(type) + ' ' + period + ' ¥' + amount,
        warn: warn
      });
    }

    await logAdmin(req, 'import-excel', '批量导入', '成功 ' + ok + ' 行，失败 ' + (results.length - ok) + ' 行（来源 ' + parsed.source + '）');
    res.json({
      ok: true,
      data: {
        source: parsed.source,
        total: results.length,
        ok: ok,
        fail: results.length - ok,
        results: results.slice(0, 300)
      }
    });
  } catch (e) { next(e); }
});

// ---------- 线下兜底收费登记（前台现金/POS，与线上统一对账） ----------
// 老人、不会用微信的业主到前台缴费，物业在这里登记，
// 系统自动销账 + 生成电子凭证 + 写监管留痕，和线上缴费完全同一套口径。
router.post('/offline-pay', auth('admin'), async function (req, res, next) {
  try {
    const b = req.body || {};
    const ids = (b.billIds || []).map(Number).filter(Boolean);
    const channel = (b.channel === 'pos') ? 'pos' : 'cash';
    const receiptNo = String(b.receiptNo || '').trim().slice(0, 40);
    if (!ids.length) return res.json({ ok: false, message: '请选择要登记的账单' });

    const [rows] = await pool.query(
      "SELECT b.* FROM bills b WHERE b.id IN (?) AND b.status = 'unpaid'", [ids]
    );
    if (!rows.length) return res.json({ ok: false, message: '账单不存在或已缴过' });

    // 并发保护：居民正在微信支付中的账单，不能同时线下登记（防止两边都收钱）
    for (const r of rows) {
      if (r.active_order_no) {
        return res.json({ ok: false, message: '该账单居民正在线上支付中，请等 1 分钟后再确认；若确认未支付可稍后重试' });
      }
    }

    const hhSet = {};
    rows.forEach(function (r) { hhSet[r.household_id] = 1; });
    if (Object.keys(hhSet).length > 1) return res.json({ ok: false, message: '一次只能登记同一户的账单' });

    let total = 0;
    rows.forEach(function (r) { total += Number(r.amount); });
    total = Math.round(total * 100) / 100;

    const orderNo = tool.orderNo();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        "INSERT INTO orders (order_no, user_id, bill_id, amount, status, pay_mode) VALUES (?, ?, ?, ?, 'created', ?)",
        [orderNo, req.user.id, rows[0].id, total, channel]
      );
      const [o] = await conn.query('SELECT id FROM orders WHERE order_no = ?', [orderNo]);
      for (const r of rows) {
        await conn.query('INSERT IGNORE INTO order_bills (order_id, bill_id) VALUES (?, ?)', [o[0].id, r.id]);
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    // 线下收款直接销账（幂等：settleOrder 只会生效一次）
    const sr = await orderSvc.settleOrder(orderNo, receiptNo ? 'OFFLINE-' + receiptNo : 'OFFLINE' + Date.now());
    if (!sr.ok) return res.json({ ok: false, message: '登记失败，请重试' });

    await logAdmin(req, 'offline-pay', orderNo,
      rows.length + ' 笔 ¥' + total + ' 渠道:' + voucherSvc.channelLabel(channel) + (receiptNo ? ' 收据号:' + receiptNo : ''));

    res.json({
      ok: true,
      data: {
        orderNo: orderNo, count: rows.length, total: total,
        message: '线下收款登记成功（¥' + total + '，' + voucherSvc.channelLabel(channel) + '），已生成电子凭证'
      }
    });
  } catch (e) { next(e); }
});

// ---------- 退款（原路退回；回调/退款/对账三件套之一） ----------
async function finalizeRefund(req, order, reason) {
  const refundNo = order.refund_no || ('R' + order.order_no);
  // 幂等：只有"未退/退款中"能改成"已退款"，重复调用不会重复退
  const [r] = await pool.query(
    "UPDATE orders SET refund_no = ?, refund_amount = ?, refund_status = 'refunded', refund_at = NOW(), refund_reason = ? " +
    "WHERE id = ? AND refund_status IN ('', 'refunding')",
    [refundNo, order.amount, String(reason || '').slice(0, 200), order.id]
  );
  if (r.affectedRows === 0) return false;

  const [links] = await pool.query('SELECT bill_id FROM order_bills WHERE order_id = ?', [order.id]);
  const billIds = links.map(function (l) { return l.bill_id; });
  if (!billIds.length && order.bill_id) billIds.push(order.bill_id);
  if (billIds.length) {
    await pool.query("UPDATE bills SET status = 'unpaid', paid_at = NULL WHERE id IN (?) AND status = 'paid'", [billIds]);
  }

  // 退款也写监管留痕（哈希链，方便对账时看到资金去向）
  try {
    const [last] = await pool.query('SELECT data_hash FROM audit_logs ORDER BY id DESC LIMIT 1');
    let prev = last[0] ? last[0].data_hash : 'GENESIS';
    const recordNo = 'WH-R' + Date.now() + Math.floor(Math.random() * 900 + 100);
    const payload = [
      recordNo, config.community, config.company, '退款', order.order_no,
      Number(order.amount).toFixed(2), voucherSvc.channelLabel(order.pay_mode), order.transaction_id || '', String(new Date()), prev
    ].join('|');
    const dataHash = cryptoUtil.hmac(payload);
    await pool.query(
      'INSERT IGNORE INTO audit_logs (record_no, biz_type, community, property_company, house_label, owner_enc, fee_type, period, amount, pay_channel, transaction_id, paid_at, data_hash, prev_hash) ' +
      "VALUES (?, 'refund', ?, ?, '', '', '', '', ?, ?, ?, NOW(), ?, ?)",
      [recordNo, config.community, config.company, Number(order.amount), voucherSvc.channelLabel(order.pay_mode), order.transaction_id || '', dataHash, prev]
    );
  } catch (e) {
    console.error('[退款] 留痕写入失败：', e.message);
  }
  return true;
}

router.post('/refund', auth('admin'), async function (req, res, next) {
  try {
    const b = req.body || {};
    const orderNo = String(b.orderNo || '').trim();
    const reason = String(b.reason || '').trim() || '物业核实后退款';
    const [orders] = await pool.query('SELECT * FROM orders WHERE order_no = ?', [orderNo]);
    const order = orders[0];
    if (!order || order.status !== 'success') return res.json({ ok: false, message: '订单不存在或未支付，不能退款' });
    if (order.refund_status === 'refunded') return res.json({ ok: false, message: '这笔订单已经退款过了，不能重复退款' });
    if (order.refund_status === 'refunding') return res.json({ ok: false, message: '退款处理中，请稍后点"查询退款"确认' });

    const refundNo = 'R' + order.order_no;
    if (config.mockMode) {
      const ok = await finalizeRefund(req, order, reason);
      if (!ok) return res.json({ ok: false, message: '退款未生效（可能已退过）' });
      await logAdmin(req, 'refund', orderNo, '演示退款 ¥' + order.amount + ' 原因:' + reason);
      return res.json({ ok: true, data: { message: '退款成功（演示原路退回）：¥' + order.amount + '，对应账单已恢复为待缴' } });
    }

    if (!wxpay.isConfigured()) return res.json({ ok: false, message: '微信支付还没配置好，不能发起真实退款' });
    const refundFen = Math.round(Number(order.amount) * 100);
    const r = await wxpay.refund({
      outTradeNo: order.order_no,
      outRefundNo: refundNo,
      refundFen: refundFen,
      totalFen: refundFen,
      reason: reason
    });
    if (r.status === 'SUCCESS') {
      await finalizeRefund(req, order, reason);
      await logAdmin(req, 'refund', orderNo, '微信退款成功 ¥' + order.amount + ' 原因:' + reason);
      return res.json({ ok: true, data: { message: '退款成功：¥' + order.amount + '，对应账单已恢复为待缴' } });
    }
    await pool.query(
      "UPDATE orders SET refund_no = ?, refund_amount = ?, refund_status = 'refunding', refund_reason = ? WHERE id = ?",
      [refundNo, order.amount, reason, order.id]
    );
    await logAdmin(req, 'refund-submit', orderNo, '微信退款已提交（' + (r.status || 'PROCESSING') + '）');
    return res.json({ ok: true, data: { message: '退款已提交微信处理，到账后请点"查询退款"确认' } });
  } catch (e) { next(e); }
});

// 退款状态兜底确认（微信返回 PROCESSING 时用它）
router.post('/refund-check', auth('admin'), async function (req, res, next) {
  try {
    const orderNo = String((req.body && req.body.orderNo) || '').trim();
    const [orders] = await pool.query('SELECT * FROM orders WHERE order_no = ?', [orderNo]);
    const order = orders[0];
    if (!order || order.refund_status !== 'refunding') {
      return res.json({ ok: false, message: '没有需要确认的退款' });
    }
    const r = await wxpay.queryRefund(order.refund_no, order.order_no);
    if (r.status === 'SUCCESS') {
      const ok = await finalizeRefund(req, order, order.refund_reason || '退款确认');
      await logAdmin(req, 'refund-check', orderNo, ok ? '退款确认成功' : '退款确认（幂等，已退过）');
      return res.json({ ok: true, data: { message: '退款已完成：¥' + order.amount } });
    }
    res.json({ ok: true, data: { message: '退款仍在处理中（' + (r.status || 'UNKNOWN') + '），请稍后再查' } });
  } catch (e) { next(e); }
});

// 退款记录
router.get('/refunds', auth('admin'), async function (req, res, next) {
  try {
    const [rows] = await pool.query(
      "SELECT o.*, GROUP_CONCAT(DISTINCT CONCAT(h.building,'栋',h.unit,'单元',h.room_no,'室') SEPARATOR '、') AS rooms " +
      'FROM orders o LEFT JOIN order_bills ob ON ob.order_id = o.id ' +
      'LEFT JOIN bills b ON b.id = ob.bill_id LEFT JOIN households h ON h.id = b.household_id ' +
      "WHERE o.refund_status <> '' GROUP BY o.id ORDER BY o.refund_at DESC LIMIT 100"
    );
    res.json({
      ok: true,
      data: rows.map(function (o) {
        return {
          orderNo: o.order_no,
          rooms: o.rooms || '-',
          amount: Number(o.amount),
          refundNo: o.refund_no,
          refundAmount: Number(o.refund_amount),
          refundStatus: o.refund_status,
          refundStatusLabel: o.refund_status === 'refunded' ? '已退款' : '退款中',
          reason: o.refund_reason || '',
          refundAt: o.refund_at ? String(o.refund_at).slice(0, 19) : ''
        };
      })
    });
  } catch (e) { next(e); }
});

// ---------- 对账文件导出（支付回调/退款/对账三件套之一） ----------
// 按天导出全部成功收款（线上微信 + 线下现金/POS）和当天退款，
// 金额、渠道、微信支付单号可直接与商户平台流水逐笔核对。
router.get('/settlement', auth('admin'), async function (req, res, next) {
  try {
    const date = String((req.query && req.query.date) || '').trim() || tool.today();
    const [rows] = await pool.query(
      'SELECT o.*, GROUP_CONCAT(DISTINCT CONCAT(h.building,\'栋\',h.unit,\'单元\',h.room_no,\'室\') SEPARATOR \'、\') AS rooms, ' +
      'GROUP_CONCAT(DISTINCT b.type) AS types, GROUP_CONCAT(DISTINCT b.period) AS periods ' +
      'FROM orders o LEFT JOIN order_bills ob ON ob.order_id = o.id ' +
      'LEFT JOIN bills b ON b.id = ob.bill_id ' +
      'LEFT JOIN households h ON h.id = b.household_id ' +
      "WHERE o.status = 'success' AND (DATE(o.paid_at) = ? OR DATE(o.refund_at) = ?) " +
      'GROUP BY o.id ORDER BY o.id ASC',
      [date, date]
    );
    const list = rows.map(function (o) {
      return {
        orderNo: o.order_no,
        rooms: o.rooms || '-',
        typeLabel: (o.types || '').split(',').filter(Boolean).map(feeLabel).join('、') || '-',
        period: (o.periods || '').split(',').filter(Boolean).join('、') || '-',
        amount: Number(o.amount),
        channel: voucherSvc.channelLabel(o.pay_mode),
        transactionId: o.transaction_id || '',
        voucherNo: o.voucher_no || '',
        refundStatus: o.refund_status === 'refunded' ? '已退款' : (o.refund_status === 'refunding' ? '退款中' : ''),
        refundAmount: Number(o.refund_amount || 0),
        paidAt: o.paid_at ? String(o.paid_at).slice(0, 19) : ''
      };
    });
    const totalPay = list.filter(function (r) { return r.refundStatus !== '已退款'; }).reduce(function (s, r) { return s + r.amount; }, 0);
    const totalRefund = list.reduce(function (s, r) { return s + r.refundAmount; }, 0);
    const cell = function (v) { return '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"'; };
    const header = ['对账日期', '订单号', '房号', '费用项目', '账期', '金额(元)', '收款渠道', '微信支付单号', '电子凭证号', '退款状态', '退款金额(元)', '缴费时间'];
    const lines = [header.map(cell).join(',')];
    list.forEach(function (r) {
      lines.push([
        date, r.orderNo, r.rooms, r.typeLabel, r.period, r.amount.toFixed(2), r.channel,
        r.transactionId, r.voucherNo, r.refundStatus, r.refundAmount.toFixed(2), r.paidAt
      ].map(cell).join(','));
    });
    res.json({
      ok: true,
      data: {
        date: date,
        count: list.length,
        summary: {
          totalPay: Math.round(totalPay * 100) / 100,
          totalRefund: Math.round(totalRefund * 100) / 100,
          net: Math.round((totalPay - totalRefund) * 100) / 100
        },
        csv: '\ufeff' + lines.join('\r\n'),
        fileName: '对账文件_' + config.community + '_' + date + '.csv'
      }
    });
  } catch (e) { next(e); }
});

// ---------- 住户资料：登记手机号（业主认证校验用）/ 水费代收余额 ----------
router.post('/household-setphone', auth('admin'), async function (req, res, next) {
  try {
    const b = req.body || {};
    const id = Number(b.householdId);
    const phone = String(b.phone || '').replace(/\D/g, '');
    if (!id) return res.json({ ok: false, message: '缺少住户ID' });
    if (phone && (phone.length < 7 || phone.length > 15)) return res.json({ ok: false, message: '手机号格式不对' });
    await pool.query('UPDATE households SET reg_phone_enc = ? WHERE id = ?', [cryptoUtil.encryptText(phone), id]);
    await logAdmin(req, 'set-phone', '住户#' + id, phone ? '登记手机号 ' + maskPhone(phone) : '清除登记手机号');
    res.json({ ok: true, data: { message: phone ? '已登记手机号 ' + maskPhone(phone) + '，业主绑定时必须填一致' : '已清除登记手机号' } });
  } catch (e) { next(e); }
});

router.post('/household-setbalance', auth('admin'), async function (req, res, next) {
  try {
    const b = req.body || {};
    const id = Number(b.householdId);
    const val = Number(b.waterBalance);
    if (!id || !isFinite(val) || val < 0) return res.json({ ok: false, message: '参数不对（余额需为非负数字）' });
    await pool.query('UPDATE households SET water_balance = ? WHERE id = ?', [val, id]);
    await logAdmin(req, 'set-balance', '住户#' + id, '水费代收余额设为 ¥' + val.toFixed(2));
    res.json({ ok: true, data: { message: '已更新水费代收余额 ¥' + val.toFixed(2) + '（仅展示，扣减规则以物业系统为准）' } });
  } catch (e) { next(e); }
});

// ---------- 操作日志（审计） ----------
router.get('/admin-logs', auth('admin'), async function (req, res, next) {
  try {
    const [rows] = await pool.query(
      'SELECT l.*, u.nickname AS admin_name FROM admin_logs l ' +
      'LEFT JOIN users u ON u.id = l.admin_id ORDER BY l.id DESC LIMIT 200'
    );
    res.json({
      ok: true,
      data: rows.map(function (l) {
        return {
          time: String(l.created_at).slice(0, 19),
          admin: l.admin_name || ('#' + l.admin_id),
          action: l.action,
          target: l.target,
          detail: l.detail,
          ip: l.ip
        };
      })
    });
  } catch (e) { next(e); }
});

// ---------- 抄表向导：一屏列出整单元的户，填完一次保存 ----------
// 设计动机：旧表单要凭记忆填 6 个字段，物业最容易错；
// 向导自动带出上次读数，物业只填"本次读数"一列。
router.get('/reading-sheet', auth('admin'), async function (req, res, next) {
  try {
    const unit = String((req.query && req.query.unit) || '').trim();
    const type = (req.query && req.query.type) === 'water' ? 'water' : 'electric';
    const period = String((req.query && req.query.period) || '').trim() || tool.periodNow();
    if (!unit) return res.json({ ok: false, message: '请选择单元' });

    // 该单元全部住户
    const [hs] = await pool.query(
      'SELECT * FROM households WHERE building = ? AND unit = ? AND status = 1 ORDER BY room_no',
      [config.pilotBuilding, unit]
    );

    // 每户该类型最近一期读数（period 字符串比较即按时间排序）
    const [lastRows] = await pool.query(
      'SELECT b.household_id, b.curr_reading FROM bills b JOIN households h ON h.id = b.household_id ' +
      'WHERE h.building = ? AND h.unit = ? AND b.type = ? AND b.period < ? ORDER BY b.period DESC',
      [config.pilotBuilding, unit, type, period]
    );
    const lastMap = {};
    lastRows.forEach(function (r) { if (!lastMap[r.household_id]) lastMap[r.household_id] = Number(r.curr_reading); });

    // 本期已录的（避免重复劳动，展示为"已保存"）
    const [curRows] = await pool.query(
      'SELECT b.household_id, b.curr_reading, b.status FROM bills b JOIN households h ON h.id = b.household_id ' +
      'WHERE h.building = ? AND h.unit = ? AND b.type = ? AND b.period = ?',
      [config.pilotBuilding, unit, type, period]
    );
    const curMap = {};
    curRows.forEach(function (r) { curMap[r.household_id] = r; });

    const rows = hs.map(function (h) {
      const saved = curMap[h.id];
      return {
        householdId: h.id,
        room: h.room_no,
        owner: h.owner_name,
        prev: lastMap[h.id] || 0,
        curr: saved ? Number(saved.curr_reading) : '',
        saved: !!saved,
        status: saved ? (saved.status === 'paid' ? '已缴' : '已保存') : ''
      };
    });

    res.json({
      ok: true,
      data: {
        unit: unit, type: type, period: period,
        price: type === 'electric' ? config.prices.electric : config.prices.water,
        rows: rows
      }
    });
  } catch (e) { next(e); }
});

// 批量保存抄表结果（只保存填了本次读数的行）
router.post('/reading-save', auth('admin'), async function (req, res, next) {
  try {
    const b = req.body || {};
    const unit = String(b.unit || '').trim();
    const type = b.type === 'water' ? 'water' : 'electric';
    const period = String(b.period || '').trim();
    const dueDate = String(b.dueDate || '').trim() || defaultDue(period);
    const rows = Array.isArray(b.rows) ? b.rows : [];
    if (!unit || !period || !rows.length) return res.json({ ok: false, message: '参数不全：单元/账期/读数行' });

    const price = type === 'electric' ? config.prices.electric : config.prices.water;
    let saved = 0;
    let skipped = 0;
    const errors = [];

    for (const r of rows) {
      const raw = r.reading === undefined || r.reading === null ? '' : String(r.reading).trim();
      if (raw === '') { skipped++; continue; }
      const curr = Number(raw);
      const [hs] = await pool.query('SELECT * FROM households WHERE id = ? AND status = 1 LIMIT 1', [Number(r.householdId)]);
      if (!hs[0] || !isFinite(curr)) { skipped++; continue; }
      const h = hs[0];
      const [last] = await pool.query(
        'SELECT curr_reading FROM bills WHERE household_id = ? AND type = ? AND period < ? ORDER BY period DESC LIMIT 1',
        [h.id, type, period]
      );
      const prev = last[0] ? Number(last[0].curr_reading) : 0;
      if (curr < prev) {
        errors.push(h.room_no + '室：本次读数（' + curr + '）小于上次（' + prev + '）');
        skipped++;
        continue;
      }
      const usage = Math.round((curr - prev) * 100) / 100;
      const amount = Math.round(usage * price * 100) / 100;
      await pool.query(
        'INSERT INTO bills (household_id, type, period, prev_reading, curr_reading, usage_qty, unit_price, amount, due_date, status, source) ' +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', 'manual') " +
        'ON DUPLICATE KEY UPDATE prev_reading = VALUES(prev_reading), curr_reading = VALUES(curr_reading), ' +
        'usage_qty = VALUES(usage_qty), unit_price = VALUES(unit_price), amount = VALUES(amount), ' +
        'due_date = VALUES(due_date), status = "unpaid", paid_at = NULL',
        [h.id, type, period, prev, curr, usage, price, amount, dueDate]
      );
      saved++;
    }

    await logAdmin(req, 'reading-save', config.pilotBuilding + '栋' + unit + '单元 ' + (type === 'electric' ? '电' : '水') + ' ' + period,
      '保存 ' + saved + ' 户，跳过 ' + skipped + ' 户' + (errors.length ? '，异常 ' + errors.length : ''));
    res.json({ ok: true, data: { saved: saved, skipped: skipped, errors: errors, dueDate: dueDate } });
  } catch (e) { next(e); }
});

// ---------- 住户档案：新增 / 编辑（不用再进数据库加人） ----------
router.post('/household-add', auth('admin'), async function (req, res, next) {
  try {
    const b = req.body || {};
    const unit = String(b.unit || '').trim();
    const roomNo = String(b.roomNo || '').trim();
    const ownerName = String(b.ownerName || '').trim();
    const area = Number(b.area || 90);
    const phone = String(b.phone || '').replace(/\D/g, '');

    if (!unit || !roomNo || !ownerName) return res.json({ ok: false, message: '单元、房号、户主姓名必填' });
    if (!/^[\u4e00-\u9fa5]{2,10}$/.test(ownerName)) return res.json({ ok: false, message: '户主姓名应为 2~10 个汉字' });
    if (!isFinite(area) || area <= 0 || area > 500) return res.json({ ok: false, message: '面积不合理（1~500 ㎡）' });
    if (phone && (phone.length < 7 || phone.length > 15)) return res.json({ ok: false, message: '手机号格式不对' });

    const [dup] = await pool.query(
      'SELECT id FROM households WHERE building = ? AND unit = ? AND room_no = ?',
      [config.pilotBuilding, unit, roomNo]
    );
    if (dup[0]) return res.json({ ok: false, message: config.pilotBuilding + '栋' + unit + '单元' + roomNo + ' 已存在，不能重复添加' });

    const [r] = await pool.query(
      'INSERT INTO households (building, unit, room_no, owner_name, area, reg_phone_enc, electric_account, water_account) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [config.pilotBuilding, unit, roomNo, ownerName, area,
        phone ? cryptoUtil.encryptText(phone) : '',
        '', ''] // 水电户号可后续在数据库/导入里补录
    );
    const label = config.pilotBuilding + '栋' + unit + '单元' + roomNo + '室';
    await logAdmin(req, 'household-add', label, '新增住户 ' + ownerName + '，面积 ' + area + '㎡' + (phone ? '，手机 ' + maskPhone(phone) : ''));
    res.json({ ok: true, data: { id: r.insertId, message: '已新增：' + label } });
  } catch (e) { next(e); }
});

// 编辑住户（传哪个字段改哪个）
router.post('/household-edit', auth('admin'), async function (req, res, next) {
  try {
    const b = req.body || {};
    const id = Number(b.householdId);
    if (!id) return res.json({ ok: false, message: '缺少住户ID' });
    const [hs] = await pool.query('SELECT * FROM households WHERE id = ? AND status = 1 LIMIT 1', [id]);
    if (!hs[0]) return res.json({ ok: false, message: '住户不存在' });

    const sets = [];
    const args = [];
    const changes = [];
    if (b.ownerName !== undefined && String(b.ownerName).trim()) {
      sets.push('owner_name = ?'); args.push(String(b.ownerName).trim());
      changes.push('户主改为 ' + String(b.ownerName).trim());
    }
    if (b.area !== undefined && b.area !== '') {
      const area = Number(b.area);
      if (!isFinite(area) || area <= 0 || area > 500) return res.json({ ok: false, message: '面积不合理' });
      sets.push('area = ?'); args.push(area);
      changes.push('面积改为 ' + area + '㎡');
    }
    if (b.phone !== undefined) {
      const phone = String(b.phone || '').replace(/\D/g, '');
      if (phone && (phone.length < 7 || phone.length > 15)) return res.json({ ok: false, message: '手机号格式不对' });
      sets.push('reg_phone_enc = ?'); args.push(cryptoUtil.encryptText(phone));
      changes.push(phone ? '登记手机号改为 ' + maskPhone(phone) : '清除登记手机号');
    }
    if (b.waterBalance !== undefined && b.waterBalance !== '') {
      const val = Number(b.waterBalance);
      if (!isFinite(val) || val < 0) return res.json({ ok: false, message: '水费余额需为非负数字' });
      sets.push('water_balance = ?'); args.push(val);
      changes.push('水费余额改为 ¥' + val.toFixed(2));
    }
    if (!sets.length) return res.json({ ok: false, message: '没有要修改的字段' });

    args.push(id);
    await pool.query('UPDATE households SET ' + sets.join(', ') + ' WHERE id = ?', args);
    await logAdmin(req, 'household-edit', roomLabelOf(hs[0]), changes.join('；'));
    res.json({ ok: true, data: { message: '已修改：' + changes.join('；') } });
  } catch (e) { next(e); }
});

// ---------- 用量分析（有缓存读缓存，没有就现算并存档） ----------
router.get('/usage', auth('admin'), async function (req, res, next) {
  try {
    const period = String((req.query && req.query.period) || '').trim() || null;
    // 指定了账期且有存档 → 直接用
    if (period) {
      const [rows] = await pool.query('SELECT stats FROM usage_stats WHERE period = ?', [period]);
      if (rows[0]) return res.json({ ok: true, data: JSON.parse(rows[0].stats) });
    }
    const stats = await usageAgent.runAnalysis(period);
    res.json({ ok: true, data: stats });
  } catch (e) { next(e); }
});

// ---------- 手动触发 Agent ----------
router.post('/run-agent', auth('admin'), async function (req, res, next) {
  try {
    const name = (req.body && req.body.name) || '';
    if (name === 'remind') {
      const r = await remindAgent.runDaily();
      return res.json({
        ok: true,
        data: {
          message: '欠费提醒已执行：到期提醒 ' + r.due3 + ' 条，逾期提醒 ' + r.overdue1 +
            ' 条；当前未缴 ' + r.unpaidCount + ' 笔 / ¥' + r.unpaidAmount + '（演示模式消息只记录不真实推送）'
        }
      });
    }
    if (name === 'usage') {
      const s = await usageAgent.runAnalysis();
      return res.json({
        ok: true,
        data: { message: s.period + ' 用量分析完成：异常高耗户 ' + s.abnormal.length + ' 户' }
      });
    }
    res.json({ ok: false, message: '不认识的 Agent 名字：' + name });
  } catch (e) { next(e); }
});

// ---------- 校验拦截记录（回查用） ----------
router.get('/checklogs', auth('admin'), async function (req, res, next) {
  try {
    const [rows] = await pool.query(
      'SELECT c.* FROM check_logs c ORDER BY c.id DESC LIMIT 100'
    );
    res.json({
      ok: true,
      data: rows.map(function (c) {
        return {
          scene: c.scene, input: c.input, result: c.result,
          message: c.message, time: String(c.created_at).slice(0, 19)
        };
      })
    });
  } catch (e) { next(e); }
});

// ---------- 监管留痕：分页查询 + 筛选 + 哈希链校验 + 导出 ----------
// 全小区 1200 户投用后留痕表会持续增长，所以查询必须分页；
// 哈希链校验分两级：翻页时只校验当前页窗口，"全量校验"按钮走独立接口。
function csvCell(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return '"' + s.replace(/"/g, '""') + '"';
}

// 筛选条件构造（月份 / 业务类型 / 关键词：记录编号、房号、支付单号、账期）
function regFilter(q) {
  const where = ['1 = 1'];
  const args = [];
  const month = String(q.month || '').trim();
  if (month) { where.push("DATE_FORMAT(paid_at, '%Y-%m') = ?"); args.push(month); }
  const type = String(q.type || '').trim();
  if (type) { where.push('biz_type = ?'); args.push(type); }
  const keyword = String(q.keyword || '').trim();
  if (keyword) {
    where.push('(record_no LIKE ? OR house_label LIKE ? OR transaction_id LIKE ? OR period LIKE ?)');
    args.push('%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%', '%' + keyword + '%');
  }
  return { whereSql: 'WHERE ' + where.join(' AND '), args: args };
}

// 校验一段（按 id 升序的连续区间）留痕的哈希链
// 规则：每一行的 prev_hash 必须等于"前一行"的 data_hash；
//       区间第一行没有前一行可比（它的前序可能指向区间外），跳过比对。
function verifyChain(rows) {
  let prev = '';
  let chainOk = true;
  let brokenAt = '';
  rows.forEach(function (r, idx) {
    if (idx > 0 && r.prev_hash !== prev) {
      chainOk = false;
      brokenAt = brokenAt || r.record_no;
    }
    prev = r.data_hash;
  });
  return { ok: chainOk, brokenAt: brokenAt };
}

function packRegRecord(r) {
  return {
    recordNo: r.record_no,
    bizType: r.biz_type,
    bizLabel: r.biz_type === 'refund' ? '退款' : '缴费',
    community: r.community,
    company: r.property_company,
    houseLabel: r.house_label,
    owner: cryptoUtil.decryptText(r.owner_enc),
    feeType: r.fee_type,
    feeTypeLabel: feeLabel(r.fee_type),
    period: r.period,
    amount: Number(r.amount),
    channel: r.pay_channel || '',
    transactionId: r.transaction_id || '',
    paidAt: r.paid_at ? String(r.paid_at).slice(0, 19) : '',
    dataHash: r.data_hash,
    prevHash: r.prev_hash
  };
}

// 分页查询（id 升序取当前页 → 校验这一页的链 → 倒序展示，最新在前）
router.get('/regulatory', auth('admin'), async function (req, res, next) {
  try {
    const q = req.query || {};
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 20));
    const f = regFilter(q);

    const [[cnt]] = await pool.query(
      'SELECT COUNT(*) AS c, IFNULL(SUM(amount),0) AS s FROM audit_logs ' + f.whereSql,
      f.args
    );
    const total = cnt.c;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const [rows] = await pool.query(
      'SELECT * FROM audit_logs ' + f.whereSql +
      ' ORDER BY id ASC LIMIT ' + pageSize + ' OFFSET ' + (page - 1) * pageSize,
      f.args
    );
    const chain = verifyChain(rows);
    const records = rows.map(packRegRecord).reverse();

    res.json({
      ok: true,
      data: {
        rows: records,
        total: total,
        amount: Math.round(Number(cnt.s) * 100) / 100,
        page: page,
        pageSize: pageSize,
        totalPages: totalPages,
        chainOk: chain.ok,
        brokenAt: chain.brokenAt,
        summary: { company: config.company, community: config.community }
      }
    });
  } catch (e) { next(e); }
});

// 全量哈希链校验（独立按钮触发，避免每次翻页都扫全表）
router.get('/regulatory/chain-check', auth('admin'), async function (req, res, next) {
  try {
    const q = req.query || {};
    const f = regFilter(q);
    const [rows] = await pool.query(
      'SELECT * FROM audit_logs ' + f.whereSql + ' ORDER BY id ASC LIMIT 50000',
      f.args
    );
    const chain = verifyChain(rows);
    await logAdmin(req, 'chain-check', '监管留痕',
      '全量校验 ' + rows.length + ' 条：' + (chain.ok ? '通过' : '断点 ' + chain.brokenAt));
    res.json({
      ok: true,
      data: { checked: rows.length, chainOk: chain.ok, brokenAt: chain.brokenAt }
    });
  } catch (e) { next(e); }
});

// 导出 CSV（按当前筛选导出全部，含缴费/退款类型列，上限 50000 条）
router.get('/regulatory/export', auth('admin'), async function (req, res, next) {
  try {
    const q = req.query || {};
    const f = regFilter(q);
    const month = String(q.month || '').trim();
    const [rows] = await pool.query(
      'SELECT * FROM audit_logs ' + f.whereSql + ' ORDER BY id ASC LIMIT 50000',
      f.args
    );
    const chain = verifyChain(rows);
    const header = ['记录编号', '业务类型', '小区', '物业企业', '房号', '业主姓名', '费用类型', '账期', '金额(元)', '收款渠道', '支付单号', '缴费/退款时间', '数据哈希', '前序哈希'];
    const lines = [header.map(csvCell).join(',')];
    rows.forEach(function (r) {
      const rec = packRegRecord(r);
      lines.push([
        rec.recordNo, rec.bizLabel, rec.community, rec.company, rec.houseLabel, rec.owner,
        rec.feeTypeLabel, rec.period, rec.amount.toFixed(2), rec.channel, rec.transactionId,
        rec.paidAt, rec.dataHash, rec.prevHash
      ].map(csvCell).join(','));
    });
    res.json({
      ok: true,
      data: {
        fileName: '监管留痕_' + config.community + '_' + (month || '全部') + '.csv',
        csv: '\ufeff' + lines.join('\r\n'),
        count: rows.length,
        chainOk: chain.ok,
        brokenAt: chain.brokenAt
      }
    });
  } catch (e) { next(e); }
});

module.exports = router;
