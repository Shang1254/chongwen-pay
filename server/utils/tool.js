// ============================================================
// 公共小工具：加密、通行证、日期、单号
// ============================================================
const crypto = require('crypto');
const config = require('../config');

// sha256 加密（存密码用，数据库里看不到原文）
function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

// ---------- 登录通行证（token） ----------
// 原理：把"用户身份|角色"用密钥签个名，谁改过一个字都会验不过
function hmacSign(payload) {
  return crypto.createHmac('sha256', config.tokenSecret).update(payload).digest('hex');
}

function makeToken(openid, role) {
  const payload = openid + '|' + role;
  return Buffer.from(payload).toString('base64') + '.' + hmacSign(payload);
}

function parseToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  let payload;
  try {
    payload = Buffer.from(parts[0], 'base64').toString('utf8');
  } catch (e) {
    return null;
  }
  if (hmacSign(payload) !== parts[1]) return null; // 签名对不上 = 伪造的
  const idx = payload.lastIndexOf('|');
  if (idx < 0) return null;
  const openid = payload.slice(0, idx);
  const role = payload.slice(idx + 1);
  return openid && role ? { openid: openid, role: role } : null;
}

// ---------- 日期 ----------
function pad2(n) { return String(n).padStart(2, '0'); }

// 今天，格式 2026-11-03
function today() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 当前账期，格式 2026-11
function periodNow() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
}

// 某个到期日距离今天几天：正数=还有几天，0=今天到期，负数=已逾期几天
function daysFromToday(dateStr) {
  if (!dateStr) return 0;
  const t = String(dateStr).slice(0, 10).split('-').map(Number);
  if (t.length !== 3 || isNaN(t[0])) return 0;
  const due = new Date(t[0], t[1] - 1, t[2]);
  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today0) / 86400000);
}

// ---------- 订单号：C + 时间戳 + 随机数，基本不会撞 ----------
function orderNo() {
  return 'C' + Date.now() + Math.floor(Math.random() * 1000).toString().padStart(3, '0');
}

// ---------- 费用类型的中文叫法（电费/水费/物业费） ----------
function feeLabel(type) {
  if (type === 'electric') return '电费';
  if (type === 'water') return '水费';
  if (type === 'property') return '物业费';
  return '其他费用';
}

module.exports = {
  sha256: sha256,
  makeToken: makeToken,
  parseToken: parseToken,
  today: today,
  periodNow: periodNow,
  daysFromToday: daysFromToday,
  orderNo: orderNo,
  feeLabel: feeLabel
};
