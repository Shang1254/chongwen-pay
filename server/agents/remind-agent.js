// ============================================================
// 【Agent 2：欠费自动提醒】
// 后端服务开着它就自动干活，每天上午 8 点后第一轮跑：
//   1) 账单到期前 3 天 → 给居民发缴费提醒
//   2) 逾期第 1 天 → 再催一次
//   3) 当天所有没缴的名单 → 汇总存进 daily_reports 表，物业后台直接看
// 推送通道：演示模式只写 notifications 表记录；
//   正式启用需在 config.js 填 subscribeTemplateId（微信订阅消息），
//   且居民在小程序里点过"允许提醒"授权。
// 同一天、同一账单、同一类型只发一次（数据库唯一索引兜底防轰炸）。
// ============================================================
const config = require('../config');
const { pool } = require('../db/pool');
const tool = require('../utils/tool');
const wechat = require('../services/wechat');

// 发一条提醒：写数据库 + （正式模式）走微信订阅消息
// 返回 true 表示这条通知是新写入的（不是重复推送）
async function push(userId, billId, type, title, content) {
  const [r] = await pool.query(
    'INSERT IGNORE INTO notifications (user_id, bill_id, type, title, content, status, send_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, billId, type, title, content, config.mockMode ? 'mock' : 'sent', tool.today()]
  );
  // 找到这个用户的微信身份号，尝试真实推送（演示模式下它只打日志）
  try {
    const [u] = await pool.query('SELECT openid FROM users WHERE id = ?', [userId]);
    if (u[0]) {
      await wechat.sendSubscribeMessage(u[0].openid, title + '：' + content);
    }
  } catch (e) {
    console.error('[提醒Agent] 推送失败：', e.message);
  }
  return r.affectedRows > 0;
}

// 找出"某天到期/逾期"的未缴账单，连带绑定用户信息一起返回
async function findBills(offsetDays) {
  const [rows] = await pool.query(
    "SELECT b.id AS bill_id, b.type, b.period, b.amount, b.due_date, b.household_id, " +
    'bd.user_id, h.unit, h.room_no ' +
    'FROM bills b ' +
    'JOIN households h ON h.id = b.household_id ' +
    'JOIN bindings bd ON bd.household_id = b.household_id ' +
    'JOIN users u ON u.id = bd.user_id ' +
    "WHERE b.status = 'unpaid' AND b.due_date = DATE_ADD(CURDATE(), INTERVAL ? DAY)",
    [offsetDays]
  );
  return rows;
}

// 每天的主任务
async function runDaily() {
  const result = { due3: 0, overdue1: 0, unpaidCount: 0, unpaidAmount: 0 };

  // ① 到期前 3 天的账单 → 温和提醒
  const due3 = await findBills(3);
  for (const b of due3) {
    const label = tool.feeLabel(b.type);
    await push(
      b.user_id, b.bill_id, 'due3',
      '缴费提醒',
      '您家 ' + b.period + ' 的' + label + ' ¥' + Number(b.amount).toFixed(2) +
      ' 将在 3 天后到期，打开"崇文兰庭缴费通"就能交。'
    );
    result.due3++;
  }

  // ② 逾期第 1 天 → 再催一次
  const od1 = await findBills(-1);
  for (const b of od1) {
    const label = tool.feeLabel(b.type);
    await push(
      b.user_id, b.bill_id, 'overdue1',
      '账单已逾期',
      '您家 ' + b.period + ' 的' + label + ' ¥' + Number(b.amount).toFixed(2) +
      ' 已逾期 1 天，请尽快缴纳，以免影响正常使用。'
    );
    result.overdue1++;
  }

  // ③ 当天欠费名单汇总 → 存表给物业看
  const [unpaid] = await pool.query(
    "SELECT b.id, b.type, b.period, b.amount, b.due_date, DATEDIFF(CURDATE(), b.due_date) AS overdue_days, " +
    'h.building, h.unit, h.room_no ' +
    'FROM bills b JOIN households h ON h.id = b.household_id ' +
    "WHERE b.status = 'unpaid' ORDER BY b.due_date ASC"
  );
  result.unpaidCount = unpaid.length;
  result.unpaidAmount = Math.round(unpaid.reduce(function (s, b) { return s + Number(b.amount); }, 0) * 100) / 100;
  await pool.query(
    'INSERT INTO daily_reports (report_date, unpaid_count, unpaid_amount, detail) VALUES (?, ?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE unpaid_count = VALUES(unpaid_count), unpaid_amount = VALUES(unpaid_amount), detail = VALUES(detail)',
    [tool.today(), result.unpaidCount, result.unpaidAmount, JSON.stringify(unpaid)]
  );

  return result;
}

// ---------- 排班：启动 3 秒后先跑一次，之后每 30 分钟看一眼（每天只真正跑一轮） ----------
let lastRunDate = '';

function tick() {
  const t = tool.today();
  if (lastRunDate === t) return;      // 今天跑过了，歇着
  if (new Date().getHours() < 8) return; // 早上 8 点前不吵人
  lastRunDate = t;
  runDaily()
    .then(function (r) {
      console.log('[提醒Agent] 今日任务完成：到期提醒 ' + r.due3 + ' 条，逾期提醒 ' + r.overdue1 +
        ' 条；当前未缴 ' + r.unpaidCount + ' 笔 / ¥' + r.unpaidAmount);
    })
    .catch(function (e) {
      console.error('[提醒Agent] 出错了：', e.message);
      lastRunDate = ''; // 失败了下轮再试
    });
}

function start() {
  setTimeout(tick, 3000);
  setInterval(tick, 30 * 60 * 1000);
}

// ---------- 一键催缴：物业后台点按钮，给所有"欠费且已绑定"的住户发一遍 ----------
// 同一张账单一天只催一次（先查当天是否已发过）
async function pushAllUnpaid() {
  const [rows] = await pool.query(
    "SELECT b.id AS bill_id, b.type, b.period, b.amount, bd.user_id " +
    'FROM bills b JOIN households h ON h.id = b.household_id ' +
    'JOIN bindings bd ON bd.household_id = b.household_id ' +
    "WHERE b.status = 'unpaid' ORDER BY b.due_date ASC"
  );
  let sent = 0;
  for (const b of rows) {
    const [ex] = await pool.query(
      "SELECT id FROM notifications WHERE bill_id = ? AND type = 'manual_push' AND send_date = ? LIMIT 1",
      [b.bill_id, tool.today()]
    );
    if (ex.length) continue; // 今天已经催过这张账单
    const ok = await push(
      b.user_id, b.bill_id, 'manual_push', '物业催缴',
      '您家 ' + b.period + ' 的' + tool.feeLabel(b.type) + ' ¥' + Number(b.amount).toFixed(2) +
      ' 还没缴，请尽快在"崇文兰亭缴费通"缴纳，谢谢配合。'
    );
    if (ok) sent++;
  }
  return { sent: sent, bills: rows.length };
}

module.exports = {
  runDaily: runDaily,
  pushAllUnpaid: pushAllUnpaid,
  push: push,
  start: start
};
