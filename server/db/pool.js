// ============================================================
// 数据库连接池：整个后端共用这几个连接，不用每次现连
// ============================================================
const mysql = require('mysql2/promise');
const config = require('../config');

const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,   // 连接不够时排队等，别直接报错
  // 连接池大小：压力测试显示它是主要瓶颈之一；可用 CWLT_DB_POOL 调整（默认 10）
  connectionLimit: Number(process.env.CWLT_DB_POOL || 10),
  connectTimeout: 5000,       // 数据库连不上时 5 秒就放弃，别把请求永远挂住
  dateStrings: true,          // 日期按字符串返回，免得时区来回转换出乱子
  charset: 'utf8mb4'
});

// 探一下数据库通不通，健康检查接口用
async function testDb() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { pool, testDb };
