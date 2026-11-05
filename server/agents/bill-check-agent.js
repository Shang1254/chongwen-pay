// ============================================================
// 【Agent 1：智能账单校验】
// 干什么的：居民绑户号、缴钱之前，先帮他检查一遍——
//   1. 房号 / 户主姓名对不对（对不上就是输错了，当场拦下）
//   2. 这笔账单是不是已经缴过（防止重复缴）
//   3. 金额有没有异常（比平时高出好几倍，提醒确认，防误缴）
//   4. 水电登记户号齐不齐（不齐先找物业补录）
// 每次校验都写进 check_logs 表，物业可以回查拦截记录。
//
// ★ 怎么升级成真的"对接水电局公开数据"：
//   把 queryGovAccount() 里的演示逻辑换成水电局 / 微信生活缴费
//   的查询接口即可，其余代码一行不用动。
// ============================================================
const { pool } = require('../db/pool');
const config = require('../config');

// 费用类型的中文叫法
function labelOf(type) {
  if (type === 'electric') return '电费';
  if (type === 'water') return '水费';
  if (type === 'property') return '物业费';
  return '其他费用';
}

// 三种校验结果：ok=没问题 warn=提醒确认 error=当场拦下
function ok(message, extra) { return { level: 'ok', title: '校验通过', message: message, extra: extra || {} }; }
function warn(message, extra) { return { level: 'warn', title: '请留意', message: message, extra: extra || {} }; }
function err(message, extra) { return { level: 'error', title: '不能继续', message: message, extra: extra || {} }; }

// 把校验结果记到日志表（顺手记，不影响主流程）
async function log(scene, input, check, userId) {
  try {
    await pool.query(
      'INSERT INTO check_logs (scene, input, result, message, user_id) VALUES (?, ?, ?, ?, ?)',
      [scene, String(input).slice(0, 200), check.level, String(check.message).slice(0, 300), userId || null]
    );
  } catch (e) {
    console.error('[校验Agent] 日志写入失败：', e.message);
  }
}

// ---------- 模拟"水电局公开数据"查询 ----------
// 演示数据 = 我们自己数据库里的住户登记信息。
// 真实接入时：换成对外的户号查询接口，入参 type + accountNo，返回 null 或 { ownerName, address }
async function queryGovAccount(type, accountNo) {
  if (!accountNo) return null;
  const col = type === 'electric' ? 'electric_account' : 'water_account';
  const [rows] = await pool.query(
    'SELECT * FROM households WHERE ' + col + ' = ? AND status = 1 LIMIT 1',
    [accountNo]
  );
  return rows[0] || null;
}

// ---------- 绑定户号前的校验 ----------
async function checkBind(input) {
  const unit = String(input.unit || '').trim();
  const roomNo = String(input.roomNo || '').trim();
  const ownerName = String(input.ownerName || '').trim();

  // 姓名格式先过一遍：2~10 个汉字
  if (!/^[\u4e00-\u9fa5]{2,10}$/.test(ownerName)) {
    return err('户主姓名看着不对：请填 2~10 个汉字，和水电缴费单上的"户主"一致。');
  }

  // 房号必须存在
  const [rows] = await pool.query(
    'SELECT * FROM households WHERE building = ? AND unit = ? AND room_no = ? AND status = 1 LIMIT 1',
    [config.pilotBuilding, unit, roomNo]
  );
  if (!rows.length) {
    return err('没找到 ' + config.pilotBuilding + '栋' + unit + '单元' + roomNo + ' 这户。\n请检查房号是否写对；确认没写错，请联系物业登记住户信息。');
  }
  const h = rows[0];

  // 姓名必须对得上
  if (h.owner_name !== ownerName) {
    return err('房号和户主姓名对不上（本户登记的户主是"' + h.owner_name + '"）。\n请对照水电缴费单再试一次。');
  }

  // 水电登记户号要齐全，否则后面没法对账
  if (!h.electric_account || !h.water_account) {
    return warn('这户的水/电登记户号不全，可能影响账单显示，建议联系物业补录。', { household: h });
  }

  return ok('校验通过', { household: h });
}

// ---------- 缴费前的校验（一批账单挨个查） ----------
async function checkBills(bills) {
  for (const b of bills) {
    const label = labelOf(b.type);

    // 1. 已缴过的拦下
    if (b.status !== 'unpaid') {
      return err('有一笔 ' + b.period + ' 的' + label + '已经缴过了，不用重复缴。');
    }

    // 2. 金额不对劲的提醒
    const amount = Number(b.amount);
    if (isNaN(amount) || amount < 0) {
      return err('有一笔' + label + '金额异常（¥' + b.amount + '），请联系物业核对后再缴。');
    }

    // 3. 比最近几个月的平均值高出 3 倍 → 提醒确认（可能是漏电漏水，也可能真的用得多）
    const [hist] = await pool.query(
      "SELECT AVG(amount) AS avgAmt FROM bills WHERE household_id = ? AND type = ? AND status = 'paid' " +
      'AND created_at > DATE_SUB(NOW(), INTERVAL 120 DAY)',
      [b.household_id, b.type]
    );
    const avg = Number(hist[0].avgAmt || 0);
    if (avg > 0 && amount > avg * 3) {
      return warn(
        '这笔' + label + '（' + b.period + '，¥' + amount.toFixed(2) + '）是您平时（约 ¥' + avg.toFixed(2) +
        '）的 ' + (amount / avg).toFixed(1) + ' 倍。\n如果家里没多用电/水，可能是漏水漏电，建议先联系物业查一下再缴。',
        { billId: b.id }
      );
    }
  }
  return ok('账单正常');
}

// ---------- 直接核验户号（按户号查，预留的独立入口） ----------
async function checkAccount(type, accountNo) {
  const h = await queryGovAccount(type, accountNo);
  if (!h) {
    return err('户号 ' + accountNo + ' 在登记数据里查不到，请核对后重试。');
  }
  return ok('户号正常：' + h.building + '栋' + h.unit + '单元' + h.room_no + '室 ' + h.owner_name, { household: h });
}

module.exports = {
  checkBind: checkBind,
  checkBills: checkBills,
  checkAccount: checkAccount,
  queryGovAccount: queryGovAccount,
  log: log
};
