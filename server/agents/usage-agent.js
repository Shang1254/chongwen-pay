// ============================================================
// 【Agent 3：用量分析统计】
// 每月 1 号自动算上个月的数据，物业后台也能点"立即分析"手动跑：
//   1) 按楼栋/月份汇总水电用量（画趋势图用）
//   2) 找异常高耗户：比自己平时高 2 倍以上，或比同楼邻居平均高 2.5 倍以上
//      （帮物业早点发现漏水漏电的隐患点）
//   3) 结果存进 usage_stats 表，物业后台图表直接读
// ============================================================
const config = require('../config');
const { pool } = require('../db/pool');
const tool = require('../utils/tool');

// 把 2026-11 往前推 n 个月（自动处理跨年）
function shiftPeriod(period, n) {
  const p = period.split('-').map(Number);
  const d = new Date(p[0], p[1] - 1 - n, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

// 核心分析：算某个账期的楼栋汇总 + 趋势 + 异常户
async function computeStats(period) {
  if (!period) period = shiftPeriod(tool.periodNow(), 1); // 默认算上个月

  // ---------- ① 该账期每户的用量 ----------
  // 只统计水电（物业费没有用量，不能混进来）
  const [rows] = await pool.query(
    "SELECT h.building, h.unit, h.room_no, b.type, b.usage_qty, b.amount " +
    "FROM bills b JOIN households h ON h.id = b.household_id WHERE b.period = ? AND b.type IN ('electric','water')",
    [period]
  );

  // 按楼栋汇总
  const buildings = {};   // key: 楼栋号
  const householdUse = {}; // key: household维度，先攒着
  for (const r of rows) {
    const bk = r.building;
    if (!buildings[bk]) {
      buildings[bk] = { building: bk, electricUsage: 0, waterUsage: 0, electricAmount: 0, waterAmount: 0, households: new Set() };
    }
    const b = buildings[bk];
    if (r.type === 'electric') {
      b.electricUsage += Number(r.usage_qty);
      b.electricAmount += Number(r.amount);
    } else {
      b.waterUsage += Number(r.usage_qty);
      b.waterAmount += Number(r.amount);
    }
    b.households.add(r.building + '-' + r.unit + '-' + r.room_no);

    const hk = r.building + '-' + r.unit + '-' + r.room_no + '-' + r.type;
    if (!householdUse[hk]) {
      householdUse[hk] = { building: r.building, unit: r.unit, room_no: r.room_no, type: r.type, usage: 0 };
    }
    householdUse[hk].usage += Number(r.usage_qty);
  }

  // 楼栋平均（算"比邻居高多少"用）
  const buildingAvg = {};
  for (const bk in buildings) {
    const b = buildings[bk];
    const cnt = Math.max(1, b.households.size);
    buildingAvg[bk + '-electric'] = b.electricUsage / cnt;
    buildingAvg[bk + '-water'] = b.waterUsage / cnt;
  }

  // ---------- ② 最近 6 个月的每户平均用量（"比自己平时高"用） ----------
  const sixAgo = shiftPeriod(period, 6);
  const [histRows] = await pool.query(
    "SELECT h.building, h.unit, h.room_no, b.type, AVG(b.usage_qty) AS avgUse " +
    "FROM bills b JOIN households h ON h.id = b.household_id " +
    "WHERE b.period > ? AND b.period <= ? AND b.type IN ('electric','water') " +
    'GROUP BY h.building, h.unit, h.room_no, b.type',
    [sixAgo, period]
  );
  const myAvg = {};
  for (const r of histRows) {
    myAvg[r.building + '-' + r.unit + '-' + r.room_no + '-' + r.type] = Number(r.avgUse);
  }

  // ---------- ③ 找异常高耗户 ----------
  const abnormal = [];
  // 每种类型设个起步线，用量太小的就不折腾了（比如空置房）
  const FLOOR = { electric: 30, water: 5 };
  for (const hk in householdUse) {
    const u = householdUse[hk];
    if (u.usage < FLOOR[u.type]) continue;

    const prev = myAvg[hk] || 0;
    const bAvg = buildingAvg[u.building + '-' + u.type] || 0;
    let reason = '';
    if (prev > 0 && u.usage >= prev * 2) {
      reason = '是自家前 6 个月平均（' + prev.toFixed(1) + '）的 ' + (u.usage / prev).toFixed(1) + ' 倍';
    } else if (bAvg > 0 && u.usage >= bAvg * 2.5) {
      reason = '是同楼平均（' + bAvg.toFixed(1) + '）的 ' + (u.usage / bAvg).toFixed(1) + ' 倍';
    }
    if (reason) {
      abnormal.push({
        roomLabel: u.building + '栋' + u.unit + '单元' + u.room_no + '室',
        type: u.type,
        typeLabel: u.type === 'electric' ? '电' : '水',
        usage: Math.round(u.usage * 100) / 100,
        reason: reason,
        advice: u.type === 'electric'
          ? '建议排查：电器故障、线路漏电'
          : '建议排查：水龙头/马桶漏水、管道渗漏'
      });
    }
  }
  abnormal.sort(function (a, b) { return b.usage - a.usage; });

  // ---------- ④ 近 6 个月小区总用量趋势（画图用） ----------
  const [trendRows] = await pool.query(
    "SELECT period, type, SUM(usage_qty) AS totalUse, SUM(amount) AS totalAmt " +
    "FROM bills WHERE period > ? AND period <= ? AND type IN ('electric','water') " +
    'GROUP BY period, type ORDER BY period ASC',
    [sixAgo, period]
  );
  const trendMap = {};
  for (const r of trendRows) {
    if (!trendMap[r.period]) trendMap[r.period] = { period: r.period, electric: 0, water: 0, electricAmount: 0, waterAmount: 0 };
    const t = trendMap[r.period];
    if (r.type === 'electric') {
      t.electric = Number(r.totalUse);
      t.electricAmount = Number(r.totalAmt);
    } else {
      t.water = Number(r.totalUse);
      t.waterAmount = Number(r.totalAmt);
    }
  }

  return {
    period: period,
    buildings: Object.keys(buildings).map(function (bk) {
      const b = buildings[bk];
      return {
        building: b.building,
        electricUsage: Math.round(b.electricUsage * 100) / 100,
        waterUsage: Math.round(b.waterUsage * 100) / 100,
        electricAmount: Math.round(b.electricAmount * 100) / 100,
        waterAmount: Math.round(b.waterAmount * 100) / 100,
        households: b.households.size
      };
    }),
    trend: Object.keys(trendMap).sort().map(function (k) { return trendMap[k]; }),
    abnormal: abnormal,
    generatedAt: new Date().toLocaleString()
  };
}

// 跑分析并存档（重复跑会覆盖同一账期的结果，放心点）
async function runAnalysis(period) {
  const stats = await computeStats(period);
  await pool.query(
    'INSERT INTO usage_stats (period, stats) VALUES (?, ?) ' +
    'ON DUPLICATE KEY UPDATE stats = VALUES(stats), created_at = NOW()',
    [stats.period, JSON.stringify(stats)]
  );
  return stats;
}

// ---------- 排班：每月 1 号早上自动算上个月 ----------
let lastPeriodRun = '';

function tick() {
  const d = new Date();
  if (d.getDate() !== 1) return;                 // 只在每月 1 号干活
  if (d.getHours() < 8) return;                  // 早上 8 点后再干
  const key = tool.periodNow();
  if (lastPeriodRun === key) return;             // 这个月跑过了
  lastPeriodRun = key;
  runAnalysis()
    .then(function (s) {
      console.log('[用量Agent] ' + s.period + ' 分析完成：异常高耗户 ' + s.abnormal.length + ' 户');
    })
    .catch(function (e) {
      console.error('[用量Agent] 出错了：', e.message);
      lastPeriodRun = '';
    });
}

function start() {
  setInterval(tick, 30 * 60 * 1000);
}

module.exports = {
  computeStats: computeStats,
  runAnalysis: runAnalysis,
  start: start
};
