// ============================================================
// 缴费接口：下单 + 支付回调 + 主动查单
// 演示模式：模拟支付，开发工具里能跑通全链路
// 正式模式：走微信支付 v3（JSAPI），居民付给武汉鼎盛佳物业商户号
// ============================================================
const express = require('express');
const router = express.Router();
const config = require('../config');
const { pool } = require('../db/pool');
const tool = require('../utils/tool');
const { auth } = require('../utils/auth');
const billCheck = require('../agents/bill-check-agent'); // 【Agent 1：智能账单校验】
const wxpay = require('../services/wxpay');
const orderSvc = require('../services/order');
const voucherSvc = require('../services/voucher');

// ---------- 下单：把选中的账单合并成一笔支付 ----------
// 为什么合并：老人在微信收银台上连点两次"支付"体验很差，
// 而且分开付容易出现"水费交了、电费没交"的半截状态。
// 对账不受影响：order_bills 里记录这笔钱对应哪几张账单。
router.post('/create', auth(), async function (req, res, next) {
  try {
    const body = req.body || {};
    const ids = (body.billIds || []).map(Number).filter(Boolean);
    if (!ids.length) {
      return res.json({ ok: false, message: '请先选择要缴的账单' });
    }

    // 只能缴自己家的、还没缴的账单
    const [rows] = await pool.query(
      "SELECT b.* FROM bills b JOIN bindings bd ON bd.household_id = b.household_id " +
      "WHERE bd.user_id = ? AND b.id IN (?) AND b.status = 'unpaid'",
      [req.user.id, ids]
    );
    if (!rows.length) {
      return res.json({ ok: false, message: '账单不存在或已缴过，请刷新后再试' });
    }
    // 多房产保护：一笔订单只允许缴同一户的账单，避免混着缴难对账
    const householdSet = {};
    rows.forEach(function (b) { householdSet[b.household_id] = 1; });
    if (Object.keys(householdSet).length > 1) {
      return res.json({ ok: false, message: '不同房号的账单请分开缴纳：请返回勾选同一户的账单' });
    }

    // ★ Agent 1 缴费前把关：防重复缴纳、金额异常提醒
    const check = await billCheck.checkBills(rows);
    await billCheck.log('pay', '缴费' + rows.length + '笔', check, req.user.id);
    if (check.level === 'error') {
      return res.json({ ok: false, message: check.message, agent: check });
    }
    // warn 级别（金额异常高）：让居民自己确认一下再缴，防止误缴
    if (check.level === 'warn' && !body.force) {
      return res.json({ ok: false, needConfirm: true, message: check.message, agent: check });
    }

    await orderSvc.closeStaleOrders(req.user.id, 30);

    // 金额用"分"传给微信支付，避免小数精度问题
    let total = 0;
    rows.forEach(function (b) { total += Number(b.amount); });
    total = Math.round(total * 100) / 100;
    const amountFen = Math.round(total * 100);
    const orderNo = tool.orderNo();

    // 建订单 + 建账单关联，同一事务，不会出现"建了一半"
    // ★ 并发安全：先对每张账单做"支付占位"（原子 UPDATE），
    //   抢占失败 = 有人正在支付这笔账单，直接拒绝重复提交
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const conflictBy = await orderSvc.claimBills(
        conn,
        rows.map(function (b) { return b.id; }),
        orderNo
      );
      if (conflictBy) {
        await conn.rollback();
        conn.release();
        return res.json({
          ok: false,
          message: '这笔账单正在支付中（订单 ' + conflictBy + '），请勿重复提交；如确认未支付，请等 1 分钟后再试或联系物业'
        });
      }
      await conn.query(
        "INSERT INTO orders (order_no, user_id, bill_id, amount, status, pay_mode) VALUES (?, ?, ?, ?, 'created', ?)",
        [orderNo, req.user.id, rows[0].id, total, config.mockMode ? 'mock' : 'wechat']
      );
      const [o] = await conn.query('SELECT id FROM orders WHERE order_no = ?', [orderNo]);
      for (const b of rows) {
        await conn.query('INSERT IGNORE INTO order_bills (order_id, bill_id) VALUES (?, ?)', [o[0].id, b.id]);
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback(); // 事务回滚会同时撤销占位 UPDATE，无需手动释放
      throw e;
    } finally {
      conn.release();
    }

    if (config.mockMode) {
      // 演示模式：返回订单号，小程序随后调 mock-notify 模拟"支付成功"
      return res.json({
        ok: true,
        data: { mock: true, orderNo: orderNo, orderNos: [orderNo], total: total }
      });
    }

    // ---------- 正式模式：微信支付 v3 JSAPI 下单 ----------
    if (!wxpay.isConfigured()) {
      return res.json({
        ok: false,
        message: '微信支付还没配置好：请在 server/config.js 填商户号/证书/APIv3密钥，并把 mockMode 改为 false'
      });
    }

    const prepayId = await wxpay.jsapiPrepay({
      outTradeNo: orderNo,
      description: '崇文兰亭物业代收（' + rows.length + '笔·' + (rows[0].period || '') + '）',
      amountFen: amountFen,
      openid: req.user.openid,
      attach: 'uid:' + req.user.id
    });

    res.json({
      ok: true,
      data: {
        mock: false,
        orderNo: orderNo,
        orderNos: [orderNo],
        total: total,
        payParams: wxpay.buildJsapiPayParams(prepayId)   // 小程序拿它调 wx.requestPayment
      }
    });
  } catch (e) { next(e); }
});

// ---------- 主动查单：支付完回到小程序时确认一次 ----------
// 作用：万一微信回调延迟或丢了，居民点"我付好了"就能立刻销账，
//       不用等物业手工处理。
router.post('/sync', auth(), async function (req, res, next) {
  try {
    const orderNo = String((req.body && req.body.orderNo) || '');
    if (!orderNo) return res.json({ ok: false, message: '缺少订单号' });

    const [orders] = await pool.query(
      'SELECT * FROM orders WHERE order_no = ? AND user_id = ?',
      [orderNo, req.user.id]
    );
    if (!orders[0]) return res.json({ ok: false, message: '订单不存在' });

    if (orders[0].status === 'success') {
      return res.json({ ok: true, data: { paid: true, tradeState: 'SUCCESS' } });
    }
    if (config.mockMode) {
      return res.json({ ok: true, data: { paid: false, tradeState: 'MOCK_NOT_PAID' } });
    }

    const r = await wxpay.queryOrder(orderNo);
    if (r.trade_state === 'SUCCESS') {
      const sr = await orderSvc.settleOrder(orderNo, r.transaction_id);
      return res.json({ ok: true, data: { paid: sr.ok, tradeState: r.trade_state } });
    }
    res.json({ ok: true, data: { paid: false, tradeState: r.trade_state || 'UNKNOWN' } });
  } catch (e) { next(e); }
});

// ---------- 演示模式：模拟"支付成功"回调 ----------
// 真实环境中，这一步由微信支付服务器回调 /api/pay/notify 完成
// ★ 安全护栏：只在演示模式开放。正式模式下谁都不能自己把订单标成"已支付"
router.post('/mock-notify', auth(), async function (req, res, next) {
  try {
    if (!config.mockMode) {
      return res.status(403).json({
        ok: false,
        message: '演示回调只在演示模式可用，正式缴费以微信支付服务器的回调为准'
      });
    }
    const orderNos = (req.body && req.body.orderNos) || [];
    let success = 0;
    for (const no of orderNos) {
      const [o] = await pool.query('SELECT user_id FROM orders WHERE order_no = ? AND user_id = ?', [no, req.user.id]);
      if (!o[0]) continue; // 只能销自己的订单
      // newly=true 才算"本次真正入账"；重复回调幂等返回但不计数
      const sr = await orderSvc.settleOrder(no, 'MOCK' + Date.now());
      if (sr.ok && sr.newly) success++;
    }
    res.json({ ok: true, data: { success: success } });
  } catch (e) { next(e); }
});

// ---------- 电子缴费凭证 ----------
// 按订单号或账单ID查（凭证在支付销账时自动生成）
router.get('/voucher', auth(), async function (req, res, next) {
  try {
    const v = await voucherSvc.getForUser(req.user.id, {
      orderNo: req.query.orderNo,
      billId: req.query.billId
    });
    if (!v) {
      return res.json({ ok: false, message: '没找到这笔缴费的电子凭证（可能还没缴费成功）' });
    }
    res.json({ ok: true, data: v });
  } catch (e) { next(e); }
});

// ---------- 查自己的缴费记录（订单维度） ----------
router.get('/orders', auth(), async function (req, res, next) {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 100',
      [req.user.id]
    );
    res.json({
      ok: true,
      data: rows.map(function (o) {
        return {
          orderNo: o.order_no,
          amount: Number(o.amount),
          status: o.status,
          payMode: o.pay_mode,
          createdAt: String(o.created_at).slice(0, 19),
          paidAt: o.paid_at ? String(o.paid_at).slice(0, 19) : null
        };
      })
    });
  } catch (e) { next(e); }
});

module.exports = router;
