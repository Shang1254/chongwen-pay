// ============================================================
// 物业费演示数据：给所有住户生成"本月物业费"待缴账单
// 单价 1.20 元/㎡·月（跟 server/config.js 的 propertyFeeRate 保持一致）
// 跑法：在 server 目录执行  node scripts/seed-property.js
// 重复跑安全（同户同账期只保留一张）
// ============================================================
const { pool, testDb } = require('../db/pool');
const config = require('../config');

function pad2(n) { return String(n).padStart(2, '0'); }

async function main() {
  if (!(await testDb())) {
    console.error('✗ 数据库连不上：请先确认 MySQL 已启动、config.js 密码正确、init.sql 已执行、migrate-v2.js 已升级。');
    process.exit(1);
  }
  const d = new Date();
  const period = d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  const due = new Date();
  due.setDate(due.getDate() + 10);

  const [hs] = await pool.query(
    "SELECT id, building, unit, room_no, area FROM households WHERE building = ? AND status = 1",
    [config.pilotBuilding]
  );

  let count = 0;
  for (const h of hs) {
    const area = Number(h.area || 90);
    const amount = Math.round(area * config.propertyFeeRate * 100) / 100;
    await pool.query(
      'INSERT IGNORE INTO bills (household_id, type, period, prev_reading, curr_reading, usage_qty, unit_price, amount, due_date, status) ' +
      "VALUES (?, 'property', ?, 0, 0, 0, ?, ?, ?, 'unpaid')",
      [h.id, period, config.propertyFeeRate, amount, due.toISOString().slice(0, 10)]
    );
    count++;
  }

  console.log('✓ 物业费演示账单已生成：' + count + ' 户 × ' + period + '（单价 ' + config.propertyFeeRate + ' 元/㎡·月）');
  process.exit(0);
}

main().catch(function (e) {
  console.error('出错了：', e.message);
  process.exit(1);
});
