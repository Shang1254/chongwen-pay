// ============================================================
// 账单相关接口：多房产账单查询（欠费 + 历史）
// 可用 ?householdId= 指定看哪一户；不传默认第一户
// 账单口径说明：账单数据以物业系统（导入/录入）为准，小程序只做展示与支付入口
// ============================================================
const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const tool = require('../utils/tool');
const { auth } = require('../utils/auth');
const billCheck = require('../agents/bill-check-agent'); // 【Agent 1：智能账单校验】

// 把数据库里的一条账单整理成小程序好读的样子
function packBill(b) {
  return {
    id: b.id,
    type: b.type,
    period: b.period,
    prevReading: Number(b.prev_reading),
    currReading: Number(b.curr_reading),
    usage: Number(b.usage_qty),
    unitPrice: Number(b.unit_price),
    amount: Number(b.amount),
    dueDate: String(b.due_date).slice(0, 10),
    status: b.status,
    source: b.source || 'manual',
    overdueDays: (b.status === 'unpaid' && tool.daysFromToday(b.due_date) < 0) ? -tool.daysFromToday(b.due_date) : 0
  };
}

// ---------- 查账单列表（支持多房产，按房号筛选） ----------
router.get('/list', auth(), async function (req, res, next) {
  try {
    // 该用户绑定的全部房产
    const [hs] = await pool.query(
      'SELECT h.*, bd.role AS bind_role FROM bindings bd ' +
      'JOIN households h ON h.id = bd.household_id ' +
      'WHERE bd.user_id = ? AND h.status = 1 ORDER BY h.unit, h.room_no',
      [req.user.id]
    );
    if (!hs.length) {
      return res.json({ ok: true, data: { household: null, households: [], unpaid: [], paid: [] } });
    }

    // 选中的房号：优先用参数指定的，参数不合法就用第一户
    let selectedId = Number((req.query && req.query.householdId) || 0);
    if (!hs.some(function (h) { return h.id === selectedId; })) {
      selectedId = hs[0].id;
    }
    const sel = hs.find(function (h) { return h.id === selectedId; });

    const [unpaidRows] = await pool.query(
      "SELECT * FROM bills WHERE household_id = ? AND status = 'unpaid' ORDER BY due_date ASC",
      [selectedId]
    );
    const [paidRows] = await pool.query(
      "SELECT * FROM bills WHERE household_id = ? AND status = 'paid' ORDER BY paid_at DESC LIMIT 50",
      [selectedId]
    );

    res.json({
      ok: true,
      data: {
        household: {
          id: sel.id,
          roomLabel: sel.building + '栋' + sel.unit + '单元' + sel.room_no + '室',
          owner_name: sel.owner_name,
          electric_account: sel.electric_account,
          water_account: sel.water_account,
          waterBalance: Number(sel.water_balance || 0),
          role: sel.bind_role
        },
        households: hs.map(function (h) {
          return {
            id: h.id,
            roomLabel: h.building + '栋' + h.unit + '单元' + h.room_no + '室',
            role: h.bind_role,
            waterBalance: Number(h.water_balance || 0)
          };
        }),
        unpaid: unpaidRows.map(packBill),
        paid: paidRows.map(packBill)
      }
    });
  } catch (e) { next(e); }
});

// ---------- 手动触发一次账单校验 ----------
router.post('/check', auth(), async function (req, res, next) {
  try {
    const ids = ((req.body && req.body.billIds) || []).map(Number).filter(Boolean);
    if (!ids.length) {
      return res.json({ ok: false, message: '没有要校验的账单' });
    }
    // 只允许校验自己家（含租户绑定）的账单
    const [rows] = await pool.query(
      'SELECT b.* FROM bills b JOIN bindings bd ON bd.household_id = b.household_id WHERE bd.user_id = ? AND b.id IN (?)',
      [req.user.id, ids]
    );
    const check = await billCheck.checkBills(rows);
    await billCheck.log('pay', '账单' + ids.join(','), check, req.user.id);
    res.json({ ok: true, data: check });
  } catch (e) { next(e); }
});

module.exports = router;
