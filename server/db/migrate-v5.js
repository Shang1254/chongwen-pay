// ============================================================
// 数据库升级脚本 v5：账单支付占位锁（并发安全修复）
// 背景：压测发现 3 人并发给同一账单下单会生成 3 笔订单，
//       真实支付时居民可能重复付款。加"支付占位"字段，
//       下单时原子抢占，只有抢到的那个订单能走支付流程。
// 跑法：node db/migrate-v5.js（重复执行安全）
// ============================================================
const { pool, testDb } = require('./pool');

async function hasColumn(table, column) {
  const [rows] = await pool.query(
    'SELECT COUNT(*) AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
    [table, column]
  );
  return rows[0].c > 0;
}

async function ensureColumn(table, column, ddl) {
  if (await hasColumn(table, column)) {
    console.log('= ' + table + '.' + column + ' 已存在，跳过');
    return;
  }
  await pool.query('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl);
  console.log('+ 新增 ' + table + '.' + column);
}

async function main() {
  if (!(await testDb())) {
    console.error('✗ 数据库连不上：请检查 MySQL 与 config.js');
    process.exit(1);
  }
  await ensureColumn('bills', 'active_order_no',
    "active_order_no VARCHAR(32) NOT NULL DEFAULT '' COMMENT '未支付订单占位（并发防重复下单）' AFTER source");
  console.log('');
  console.log('✓ v5 升级完成。重启后端生效。');
  process.exit(0);
}

main().catch(function (e) {
  console.error('✗ 升级失败：', e.message);
  process.exit(1);
});
