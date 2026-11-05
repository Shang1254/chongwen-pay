// ============================================================
// 数据库升级脚本 v3（在已有数据库上执行，不会丢数据）
// 升级内容：
//   1. 住户表：物业登记手机号（加密）、水费代收余额（展示用）
//   2. 绑定表：业主/租户身份、绑定人手机号（加密）→ 支持多房产
//   3. 账单表：数据来源标记（账单口径以物业系统为准）
//   4. 订单表：退款字段（退款三件套之一）
//   5. 新建"物业操作日志表"（后台每个动作都留痕）
// 跑法：在 server 目录执行  node db/migrate-v3.js
// 重复执行安全
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
    console.error('✗ 数据库连不上：请先确认 MySQL 已启动、config.js 密码正确。');
    process.exit(1);
  }

  // ① 住户：物业登记手机号（绑定校验用）+ 水费代收余额（只读展示）
  await ensureColumn('households', 'reg_phone_enc',
    "reg_phone_enc VARCHAR(300) NOT NULL DEFAULT '' COMMENT '物业登记手机号（加密）' AFTER area");
  await ensureColumn('households', 'water_balance',
    "water_balance DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '水费代收余额（物业登记，展示用）' AFTER reg_phone_enc");

  // ② 绑定：业主/租户 + 绑定人手机号；一个微信可绑多套房（多房产）
  await ensureColumn('bindings', 'role',
    "role VARCHAR(10) NOT NULL DEFAULT 'owner' COMMENT 'owner=业主 tenant=租户' AFTER household_id");
  await ensureColumn('bindings', 'phone_enc',
    "phone_enc VARCHAR(300) NOT NULL DEFAULT '' COMMENT '绑定人手机号（加密）' AFTER role");

  // ③ 账单来源：账单口径以物业系统为准，小程序只做展示和支付入口
  await ensureColumn('bills', 'source',
    "source VARCHAR(20) NOT NULL DEFAULT 'manual' COMMENT 'manual=后台录入 import=物业导入 api=厂商接口' AFTER status");

  // ④ 订单退款字段（退款三件套：回调/退款/对账）
  await ensureColumn('orders', 'refund_no',
    "refund_no VARCHAR(40) NOT NULL DEFAULT '' COMMENT '退款单号' AFTER voucher_hash");
  await ensureColumn('orders', 'refund_amount',
    'refund_amount DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT \'退款金额（元）\'');
  await ensureColumn('orders', 'refund_status',
    "refund_status VARCHAR(10) NOT NULL DEFAULT '' COMMENT 'refunding=退款中 refunded=已退款'");
  await ensureColumn('orders', 'refund_at',
    'refund_at DATETIME DEFAULT NULL COMMENT \'退款完成时间\'');
  await ensureColumn('orders', 'refund_reason',
    "refund_reason VARCHAR(200) NOT NULL DEFAULT '' COMMENT '退款原因'");

  // ⑤ 物业操作日志（审计：谁在什么时候做了什么）
  await pool.query(
    'CREATE TABLE IF NOT EXISTS admin_logs (' +
    ' id INT AUTO_INCREMENT PRIMARY KEY,' +
    ' admin_id INT NOT NULL,' +
    " action VARCHAR(30) NOT NULL DEFAULT '' COMMENT '动作：login/addbill/offline-pay/refund...'," +
    " target VARCHAR(100) NOT NULL DEFAULT '' COMMENT '操作对象'," +
    " detail VARCHAR(500) NOT NULL DEFAULT '' COMMENT '明细'," +
    " ip VARCHAR(50) NOT NULL DEFAULT '' COMMENT '操作IP'," +
    ' created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
    ' KEY idx_admin (admin_id), KEY idx_created (created_at)' +
    ") ENGINE=InnoDB COMMENT='物业操作日志表'"
  );
  console.log('= admin_logs 操作日志表就绪');

  console.log('');
  console.log('✓ v3 升级完成。重启后端即可使用新功能。');
  process.exit(0);
}

main().catch(function (e) {
  console.error('✗ 升级失败：', e.message);
  process.exit(1);
});
