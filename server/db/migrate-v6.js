// ============================================================
// 数据库升级脚本 v6：报修看板所需的优先级/维修师傅/流转日志
// 跑法：node db/migrate-v6.js（重复执行安全）
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
  await ensureColumn('repair_orders', 'priority',
    "priority VARCHAR(10) NOT NULL DEFAULT 'normal' COMMENT 'normal=普通 high=加急 urgent=紧急' AFTER status");
  await ensureColumn('repair_orders', 'assignee',
    "assignee VARCHAR(30) NOT NULL DEFAULT '' COMMENT '维修师傅' AFTER priority");

  await pool.query(
    'CREATE TABLE IF NOT EXISTS repair_logs (' +
    ' id INT AUTO_INCREMENT PRIMARY KEY,' +
    ' repair_id INT NOT NULL,' +
    " from_status VARCHAR(10) NOT NULL DEFAULT '' COMMENT '原状态'," +
    " to_status VARCHAR(10) NOT NULL DEFAULT '' COMMENT '新状态'," +
    " operator VARCHAR(30) NOT NULL DEFAULT '' COMMENT '操作人'," +
    " note VARCHAR(300) NOT NULL DEFAULT '' COMMENT '备注'," +
    ' created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
    ' KEY idx_repair (repair_id)' +
    ") ENGINE=InnoDB COMMENT='报修工单流转日志'"
  );
  console.log('= repair_logs 工单流转日志表就绪');

  console.log('');
  console.log('✓ v6 升级完成。重启后端生效。');
  process.exit(0);
}

main().catch(function (e) {
  console.error('✗ 升级失败：', e.message);
  process.exit(1);
});
