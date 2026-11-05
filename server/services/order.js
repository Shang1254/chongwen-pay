// ============================================================
// 订单服务：建表、关旧单、支付占位、支付成功后销账（回调/主动查单共用）
// 一次结账 = 一笔订单（可含多张账单），居民只拉一次微信收银台
//
// 并发安全（v5 修复）：
//   下单时对每张账单做"支付占位"——原子 UPDATE bills SET active_order_no=订单号
//   WHERE ... AND active_order_no=''。谁占位成功谁能建订单，
//   并发重复提交会占位失败直接拒绝，从根上防止重复下单/重复付款。
//   支付成功销账、订单超时关闭时都会释放占位。
// ============================================================
const { pool } = require('../db/pool');
const voucherSvc = require('./voucher');

// 建关联表（幂等，老库也能自动补上，不用手工执行 SQL）
async function ensureSchema() {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS order_bills (" +
    "  order_id INT NOT NULL COMMENT '订单id'," +
    "  bill_id INT NOT NULL COMMENT '账单id'," +
    "  PRIMARY KEY (order_id, bill_id)," +
    "  KEY idx_bill (bill_id)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单与账单的对应关系（一次结账可含多张账单）'"
  );
}

// 关掉 30 分钟前还挂着"已下单没付款"的旧订单，防止垃圾订单越积越多
// 关单的同时释放账单的支付占位，让居民可以重新下单
async function closeStaleOrders(userId, minutes) {
  const [r] = await pool.query(
    "UPDATE orders SET status = 'closed' WHERE user_id = ? AND status = 'created' " +
    "AND created_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)",
    [userId, minutes || 30]
  );
  if (r.affectedRows > 0) {
    await pool.query(
      "UPDATE bills b JOIN order_bills ob ON ob.bill_id = b.id " +
      "JOIN orders o ON o.id = ob.order_id " +
      "SET b.active_order_no = '' WHERE o.user_id = ? AND o.status = 'closed' AND b.active_order_no = o.order_no",
      [userId]
    );
  }
  return r.affectedRows;
}

// 支付占位：对一批账单原子抢占（同一事务里调用）
// 返回 null = 全部占位成功；返回字符串 = 被谁占用了（提示冲突）
async function claimBills(conn, billIds, orderNo) {
  for (const id of billIds) {
    const [r] = await conn.query(
      "UPDATE bills SET active_order_no = ? WHERE id = ? AND status = 'unpaid' AND active_order_no = ''",
      [orderNo, id]
    );
    if (r.affectedRows === 0) {
      // 有人正在支付这张账单：查出占用者，回滚并提示
      const [who] = await conn.query('SELECT active_order_no FROM bills WHERE id = ?', [id]);
      return who[0] ? who[0].active_order_no : '其他订单';
    }
  }
  return null;
}

// 释放占位（下单事务回滚 / 订单关闭时调用）
async function releaseBills(conn, billIds) {
  if (!billIds.length) return;
  await conn.query('UPDATE bills SET active_order_no = ? WHERE id IN (?) AND status = "unpaid"', ['', billIds]);
}

// 支付成功销账：订单置为 success，并把关联的账单全部标记已缴
// 幂等：重复回调/重复查单都安全（只会生效一次）
// 返回 { ok, newly }：ok=订单处于已支付状态；newly=本次调用才真正销的账
async function settleOrder(orderNo, transactionId) {
  const [r] = await pool.query(
    "UPDATE orders SET status = 'success', transaction_id = ?, paid_at = NOW() " +
    "WHERE order_no = ? AND status IN ('created', 'closed')",
    [transactionId || '', orderNo]
  );

  const [orders] = await pool.query('SELECT id, bill_id, status, amount FROM orders WHERE order_no = ?', [orderNo]);
  const order = orders[0];
  if (!order) return { ok: false, newly: false };

  // 已经是 success（之前销过账）：不重复销账，但确保账单/凭证一致
  if (r.affectedRows === 0 && order.status === 'success') {
    try { await voucherSvc.issue(orderNo); } catch (e) { /* 凭证失败不影响查单 */ }
    return { ok: true, newly: false };
  }
  if (r.affectedRows === 0) return { ok: false, newly: false };

  const [links] = await pool.query('SELECT bill_id FROM order_bills WHERE order_id = ?', [order.id]);
  const billIds = links.map(function (l) { return l.bill_id; });
  // 兼容老数据：没有关联记录时，用订单自带的 bill_id
  if (!billIds.length && order.bill_id) billIds.push(order.bill_id);

  if (billIds.length) {
    await pool.query(
      "UPDATE bills SET status = 'paid', paid_at = NOW(), active_order_no = '' " +
      "WHERE id IN (?) AND status = 'unpaid'",
      [billIds]
    );
  }

  // 销账成功后自动发"电子缴费凭证"+写"监管留痕"
  // 失败不影响缴费结果（钱已经到账了，凭证可以补发）
  try {
    await voucherSvc.issue(orderNo);
  } catch (e) {
    console.error('[销账] 凭证/留痕生成失败：', e.message);
  }

  // 缴费结果回写物业系统（config.syncWebhookUrl 配了才发；失败不影响缴费）
  try {
    require('./notify').propertySettlement({
      orderNo: orderNo,
      amount: Number(order.amount),
      paidAt: new Date().toISOString(),
      channel: 'wechat',
      billIds: billIds,
      unlockMode: require('../config').waterUnlockMode
    });
  } catch (e) {
    console.error('[销账] 回写物业失败：', e.message);
  }
  return { ok: true, newly: true };
}

module.exports = {
  ensureSchema: ensureSchema,
  closeStaleOrders: closeStaleOrders,
  claimBills: claimBills,
  releaseBills: releaseBills,
  settleOrder: settleOrder
};
