// ============================================================
// 电子缴费凭证 + 物业监管留痕
// ------------------------------------------------------------
// 居民每缴成功一笔，就自动生成：
//   1. 凭证编号 + 防伪哈希（订单表 voucher_no / voucher_hash）
//   2. 一条或多条监管留痕（audit_logs，按武汉物业监管常见字段设计，
//      用哈希链串起来，后一条包含前一条的哈希，改动任何一条都会断链）
// 真实对接武汉住建监管系统时，只需按对方接口调整导出字段映射。
// ============================================================
const { pool } = require('../db/pool');
const config = require('../config');
const cryptoUtil = require('../utils/crypto');

function pad2(n) { return String(n).padStart(2, '0'); }
function stamp(d) {
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

function feeLabel(type) {
  if (type === 'electric') return '电费';
  if (type === 'water') return '水费';
  if (type === 'property') return '物业费';
  return '其他费用';
}

// 收款渠道的中文叫法（对账文件、留痕都用它）
function channelLabel(mode) {
  if (mode === 'wechat') return '微信支付';
  if (mode === 'mock') return '演示支付';
  if (mode === 'offline') return '线下收费';
  if (mode === 'cash') return '现金';
  if (mode === 'pos') return 'POS刷卡';
  return mode || '其他';
}

// 取一笔订单关联的所有账单（兼容没有 order_bills 记录的老订单）
async function orderBills(order) {
  const [links] = await pool.query(
    'SELECT b.*, h.building, h.unit, h.room_no, h.owner_name ' +
    'FROM order_bills ob JOIN bills b ON b.id = ob.bill_id JOIN households h ON h.id = b.household_id ' +
    'WHERE ob.order_id = ?',
    [order.id]
  );
  if (links.length) return links;
  if (!order.bill_id) return [];
  const [one] = await pool.query(
    'SELECT b.*, h.building, h.unit, h.room_no, h.owner_name ' +
    'FROM bills b JOIN households h ON h.id = b.household_id WHERE b.id = ?',
    [order.bill_id]
  );
  return one;
}

// ---------- 发凭证 + 写留痕（幂等：同一订单只会发一次） ----------
async function issue(orderNo) {
  const [orders] = await pool.query('SELECT * FROM orders WHERE order_no = ?', [orderNo]);
  const o = orders[0];
  if (!o || o.status !== 'success') return null;
  if (o.voucher_no) return o.voucher_no;   // 已经发过，直接返回

  const bills = await orderBills(o);
  if (!bills.length) return null;

  const paidAt = o.paid_at ? new Date(o.paid_at) : new Date();
  const voucherNo = 'PJ' + stamp(paidAt) + Math.floor(1000 + Math.random() * 9000);
  const hash = cryptoUtil.hmac([
    'CWLT-VOUCHER', orderNo, String(o.amount), String(paidAt),
    bills.map(function (b) { return b.id; }).join(',')
  ].join('|'));

  // 只在还是空凭证号时写入，并发回调也不会重复发
  const [r] = await pool.query(
    "UPDATE orders SET voucher_no = ?, voucher_hash = ? WHERE id = ? AND voucher_no = ''",
    [voucherNo, hash, o.id]
  );
  if (r.affectedRows === 0) {
    const [again] = await pool.query('SELECT voucher_no FROM orders WHERE id = ?', [o.id]);
    return again[0] ? again[0].voucher_no : voucherNo;
  }

  // ---------- 写监管留痕（每张账单一条，哈希链式） ----------
  try {
    const [last] = await pool.query('SELECT data_hash FROM audit_logs ORDER BY id DESC LIMIT 1');
    let prev = last[0] ? last[0].data_hash : 'GENESIS';
    for (const b of bills) {
      const recordNo = 'WH' + stamp(paidAt) + String(b.id).padStart(5, '0') + Math.floor(Math.random() * 9);
      const houseLabel = b.building + '栋' + b.unit + '单元' + b.room_no + '室';
      const payload = [
        recordNo, config.community, config.company, houseLabel, b.type, b.period,
        Number(b.amount).toFixed(2), channelLabel(o.pay_mode), o.transaction_id || '', String(paidAt), prev
      ].join('|');
      const dataHash = cryptoUtil.hmac(payload);
      await pool.query(
        'INSERT IGNORE INTO audit_logs ' +
        '(record_no, biz_type, community, property_company, house_label, owner_enc, fee_type, period, amount, pay_channel, transaction_id, paid_at, data_hash, prev_hash) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          recordNo, 'payment', config.community, config.company, houseLabel,
          cryptoUtil.encryptText(b.owner_name), b.type, b.period, Number(b.amount),
          channelLabel(o.pay_mode), o.transaction_id || '', paidAt, dataHash, prev
        ]
      );
      prev = dataHash;
    }
  } catch (e) {
    // 留痕失败不影响居民缴费，但要留日志让物业知道
    console.error('[凭证] 监管留痕写入失败：', e.message);
  }

  return voucherNo;
}

// ---------- 居民查自己的凭证（可按订单号或账单ID查） ----------
async function getForUser(userId, opts) {
  const orderNo = opts.orderNo ? String(opts.orderNo) : '';
  const billId = Number(opts.billId || 0);

  let sql = 'SELECT o.* FROM orders o WHERE o.user_id = ? AND o.status = "success"';
  const args = [userId];
  if (orderNo) { sql += ' AND o.order_no = ?'; args.push(orderNo); }
  if (billId) {
    sql += ' AND o.id IN (SELECT order_id FROM order_bills WHERE bill_id = ?)';
    args.push(billId);
  }
  sql += ' ORDER BY o.id DESC LIMIT 1';

  const [orders] = await pool.query(sql, args);
  const o = orders[0];
  if (!o) return null;

  // 老订单可能还没发凭证，补发一次
  if (!o.voucher_no) {
    await issue(o.order_no);
    const [again] = await pool.query('SELECT * FROM orders WHERE id = ?', [o.id]);
    if (again[0]) Object.assign(o, again[0]);
  }

  const bills = await orderBills(o);
  if (!bills.length) return null;
  const h = bills[0];
  const paidAt = o.paid_at ? String(o.paid_at).slice(0, 19) : '';

  return {
    voucherNo: o.voucher_no,
    verifyCode: String(o.voucher_hash || '').slice(-8).toUpperCase(), // 防伪码（口头核对用）
    orderNo: o.order_no,
    amount: Number(o.amount),
    paidAt: paidAt,
    channel: channelLabel(o.pay_mode),
    transactionId: o.transaction_id || '',
    community: config.community,
    company: config.company,
    houseLabel: h.building + '栋' + h.unit + '单元' + h.room_no + '室',
    ownerMasked: cryptoUtil.maskName(h.owner_name),
    items: bills.map(function (b) {
      return {
        type: b.type,
        typeLabel: feeLabel(b.type),
        period: b.period,
        usage: Number(b.usage_qty),
        unitPrice: Number(b.unit_price),
        amount: Number(b.amount)
      };
    }),
    priceNotice: config.priceNotice,
    note: '本凭证为电子缴费记录，可在"缴费记录"中随时查看；如需纸质凭证请联系物业打印。'
  };
}

module.exports = {
  issue: issue,
  getForUser: getForUser,
  feeLabel: feeLabel,
  channelLabel: channelLabel
};
