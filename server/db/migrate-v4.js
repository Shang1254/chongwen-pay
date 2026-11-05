// ============================================================
// 数据库升级脚本 v4：报修单支持现场照片
// 跑法：node db/migrate-v4.js（重复执行安全）
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
  await ensureColumn('repair_orders', 'img_url',
    "img_url VARCHAR(300) NOT NULL DEFAULT '' COMMENT '现场照片路径（/uploads/xx.jpg）' AFTER content");
  console.log('');
  console.log('✓ v4 升级完成。');
  process.exit(0);
}

main().catch(function (e) {
  console.error('✗ 升级失败：', e.message);
  process.exit(1);
});
