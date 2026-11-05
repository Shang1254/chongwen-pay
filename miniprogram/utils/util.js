// ============================================================
// 小工具：金额、日期、文案格式化
// ============================================================

// 金额统一显示两位小数，比如 44 -> "44.00"
function fmtMoney(n) {
  return Number(n || 0).toFixed(2);
}

// 账单类型的中文叫法（电费/水费/物业费）
function typeLabel(t) {
  if (t === 'electric') return '电费';
  if (t === 'water') return '水费';
  if (t === 'property') return '物业费';
  return '其他费用';
}

// 账单类型配的图标（用表情，不用图片，省事又好看）
function typeEmoji(t) {
  if (t === 'electric') return '⚡';
  if (t === 'water') return '💧';
  if (t === 'property') return '🏢';
  return '🧾';
}

// 日期只留年月日部分
function fmtDate(s) {
  return (s || '').slice(0, 10);
}

module.exports = {
  fmtMoney: fmtMoney,
  typeLabel: typeLabel,
  typeEmoji: typeEmoji,
  fmtDate: fmtDate
};
