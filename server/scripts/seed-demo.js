// ============================================================
// 一键灌入演示数据：
//   2号楼 2 个单元 × 6 层 × 每层 4 户 = 48 户
//   外加过去 6 个月的水电账单（都显示已缴），并有几户故意
//   弄成"异常高耗"，方便演示用量分析 Agent 的效果
// 跑法：在 server 目录执行  node scripts/seed-demo.js
// 重复跑不会产生重复数据（都用了防重复写法）
// ============================================================
const { pool, testDb } = require('../db/pool');

// 常用姓氏 + 名字，循环着给演示住户起名
const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙'];
const GIVEN = ['建国', '秀英', '桂兰', '德福', '志强', '淑芬', '国庆', '玉兰', '建军', '凤英', '永强', '丽华'];

function pad2(n) { return String(n).padStart(2, '0'); }
function periodOf(date) { return date.getFullYear() + '-' + pad2(date.getMonth() + 1); }
function shiftPeriod(period, n) {
  const p = period.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1 - n, 1);
  return periodOf(d);
}
// 简单的伪随机，每次跑数据基本一样，方便对比
let seed = 42;
function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }

async function main() {
  const dbOk = await testDb();
  if (!dbOk) {
    console.error('✗ 数据库连不上：请先确认 MySQL 已启动、config.js 密码正确、db/init.sql 已执行。');
    process.exit(1);
  }
  const periodNow = periodOf(new Date());
  const dueDate = function (days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  };

  // ---------- 造 48 户 ----------
  const households = [];
  let i = 0;
  for (const unit of ['1', '2']) {
    for (let floor = 1; floor <= 6; floor++) {
      for (let pos = 1; pos <= 4; pos++) {
        const roomNo = String(floor * 100 + pos);
        const owner = SURNAMES[i % SURNAMES.length] + GIVEN[i % GIVEN.length];
        households.push({
          building: '2', unit: unit, roomNo: roomNo, owner: owner,
          electric: 'E2' + unit + roomNo, water: 'W2' + unit + roomNo
        });
        i++;
      }
    }
  }

  for (const h of households) {
    await pool.query(
      'INSERT IGNORE INTO households (building, unit, room_no, owner_name, electric_account, water_account) VALUES (?, ?, ?, ?, ?, ?)',
      [h.building, h.unit, h.roomNo, h.owner, h.electric, h.water]
    );
  }
  console.log('✓ 住户：48 户已就位（2号楼 1、2 单元）');

  const [hs] = await pool.query("SELECT * FROM households WHERE building = '2'");
  let billCount = 0;

  // ---------- 造 6 个月账单 ----------
  // 故意弄成异常高耗的两户（演示用量分析 Agent 用）
  const abnormalElectric = '1-502';
  const abnormalWater = '2-303';

  for (const h of hs) {
    const roomKey = h.unit + '-' + h.room_no;
    let ePrev = 1000, wPrev = 500;

    for (let m = 5; m >= 0; m--) {
      const period = shiftPeriod(periodNow, m);
      const isCurrent = (m === 0);

      // 电：平时 30~60 度；异常户这期飙到 4 倍
      let eUse = 30 + Math.floor(rnd() * 30);
      if (roomKey === abnormalElectric && isCurrent) eUse = 220 + Math.floor(rnd() * 40);
      // 水：平时 4~9 吨；异常户这期飙到 4 倍
      let wUse = 4 + Math.floor(rnd() * 6);
      if (roomKey === abnormalWater && isCurrent) wUse = 30 + Math.floor(rnd() * 8);

      // 当前月留 3 户没缴（演示欠费名单、提醒 Agent）
      const unpaid = isCurrent && (h.id % 9 === 0);

      const eStatus = unpaid ? 'unpaid' : 'paid';
      await pool.query(
        'INSERT IGNORE INTO bills (household_id, type, period, prev_reading, curr_reading, usage_qty, unit_price, amount, due_date, status, paid_at) ' +
        'VALUES (?, "electric", ?, ?, ?, ?, 0.55, ?, ?, ?, ?)',
        [h.id, period, ePrev, ePrev + eUse, eUse,
         Math.round(eUse * 0.55 * 100) / 100,
         isCurrent ? dueDate(5) : dueDate(-(m * 30)),
         eStatus,
         eStatus === 'paid' ? dueDate(-(m * 30)) : null]
      );
      ePrev += eUse;

      await pool.query(
        'INSERT IGNORE INTO bills (household_id, type, period, prev_reading, curr_reading, usage_qty, unit_price, amount, due_date, status, paid_at) ' +
        'VALUES (?, "water", ?, ?, ?, ?, 3.45, ?, ?, ?, ?)',
        [h.id, period, wPrev, wPrev + wUse, wUse,
         Math.round(wUse * 3.45 * 100) / 100,
         isCurrent ? dueDate(7) : dueDate(-(m * 30)),
         eStatus,
         eStatus === 'paid' ? dueDate(-(m * 30)) : null]
      );
      wPrev += wUse;
      billCount += 2;
    }
  }
  console.log('✓ 账单：6 个月 × 48 户 × 水/电 = ' + billCount + ' 张已写入（其中当前月留了未缴样例）');
  console.log('  演示异常高耗户：1单元502（电）、2单元303（水）');
  console.log('');
  console.log('完成！打开物业后台 http://127.0.0.1:3000/admin 点"用量分析"看效果');
  process.exit(0);
}

main().catch(function (e) {
  console.error('出错了：', e.message);
  process.exit(1);
});
