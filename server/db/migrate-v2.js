// ============================================================
// 数据库升级脚本 v2（在已有数据库上执行，不会丢数据）
// 升级内容：
//   1. 住户表加"建筑面积"（算物业费用）
//   2. 用户表加"测试访问权限"（2栋试点邀请码控制）
//   3. 订单表加"电子凭证号 / 防伪哈希"
//   4. 新建"报修单表"
//   5. 新建"监管留痕表"（武汉住建物业监管参考格式，供导出/对接）
// 跑法：在 server 目录执行  node db/migrate-v2.js
// 重复执行安全（已存在的列/表会自动跳过）
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

// 索引也做成幂等：缺了才加（查询快慢直接影响能扛多少并发）
async function ensureIndex(table, indexName, ddl) {
  try {
    const [rows] = await pool.query(
      'SELECT COUNT(*) AS c FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
      [table, indexName]
    );
    if (rows[0].c > 0) {
      console.log('= 索引 ' + table + '.' + indexName + ' 已存在，跳过');
      return;
    }
    await pool.query(ddl);
    console.log('+ 新增索引 ' + table + '.' + indexName);
  } catch (e) {
    console.error('! 索引 ' + table + '.' + indexName + ' 添加失败（不影响使用）：', e.message);
  }
}

async function main() {
  if (!(await testDb())) {
    console.error('✗ 数据库连不上：请先确认 MySQL 已启动、config.js 密码正确。');
    process.exit(1);
  }

  // ① 住户面积（物业费按面积×单价算）
  await ensureColumn('households', 'area', "area DECIMAL(10,2) NOT NULL DEFAULT 90.00 COMMENT '建筑面积（㎡），算物业费用' AFTER water_account");

  // ② 用户测试访问权限（2栋试点入口）
  await ensureColumn('users', 'test_access', "test_access TINYINT NOT NULL DEFAULT 0 COMMENT '1=已用邀请码解锁试点' AFTER role");

  // ③ 订单电子凭证
  await ensureColumn('orders', 'voucher_no', "voucher_no VARCHAR(40) NOT NULL DEFAULT '' COMMENT '电子凭证编号'");
  await ensureColumn('orders', 'voucher_hash', "voucher_hash VARCHAR(64) NOT NULL DEFAULT '' COMMENT '凭证防伪哈希'");

  // ④ 报修单表
  await pool.query(
    'CREATE TABLE IF NOT EXISTS repair_orders (' +
    ' id INT AUTO_INCREMENT PRIMARY KEY,' +
    ' user_id INT NOT NULL,' +
    ' household_id INT DEFAULT NULL,' +
    " category VARCHAR(30) NOT NULL DEFAULT '' COMMENT '报修类型'," +
    ' content VARCHAR(500) NOT NULL DEFAULT \'\' COMMENT \'问题描述\',' +
    " contact_enc VARCHAR(300) NOT NULL DEFAULT '' COMMENT '联系电话（加密存储）'," +
    " status VARCHAR(10) NOT NULL DEFAULT 'pending' COMMENT 'pending=待处理 doing=处理中 done=已完成'," +
    " feedback VARCHAR(300) NOT NULL DEFAULT '' COMMENT '物业处理回复'," +
    ' created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
    ' updated_at DATETIME DEFAULT NULL,' +
    ' KEY idx_user (user_id), KEY idx_status (status)' +
    ") ENGINE=InnoDB COMMENT='物业报修单表'"
  );
  console.log('= repair_orders 报修表就绪');

  // ⑤ 监管留痕表（收费流水，一单一记录，哈希链防篡改）
  await pool.query(
    'CREATE TABLE IF NOT EXISTS audit_logs (' +
    ' id INT AUTO_INCREMENT PRIMARY KEY,' +
    ' record_no VARCHAR(40) NOT NULL COMMENT \'留痕记录号\',' +
    " biz_type VARCHAR(20) NOT NULL DEFAULT 'payment' COMMENT 'payment=缴费'," +
    " community VARCHAR(50) NOT NULL DEFAULT '' COMMENT '小区名称'," +
    " property_company VARCHAR(100) NOT NULL DEFAULT '' COMMENT '物业企业'," +
    " house_label VARCHAR(50) NOT NULL DEFAULT '' COMMENT '房号'," +
    " owner_enc VARCHAR(200) NOT NULL DEFAULT '' COMMENT '业主姓名（加密）'," +
    " fee_type VARCHAR(20) NOT NULL DEFAULT '' COMMENT 'electric/water/property'," +
    " period VARCHAR(7) NOT NULL DEFAULT '' COMMENT '账期'," +
    ' amount DECIMAL(10,2) NOT NULL DEFAULT 0,' +
    " pay_channel VARCHAR(20) NOT NULL DEFAULT 'wechat' COMMENT '收款渠道'," +
    " transaction_id VARCHAR(64) NOT NULL DEFAULT '' COMMENT '支付单号'," +
    ' paid_at DATETIME DEFAULT NULL,' +
    " data_hash VARCHAR(64) NOT NULL DEFAULT '' COMMENT '本条哈希'," +
    " prev_hash VARCHAR(64) NOT NULL DEFAULT '' COMMENT '前序哈希（链式留痕）'," +
    ' created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
    ' UNIQUE KEY uniq_record (record_no), KEY idx_paid (paid_at)' +
    ") ENGINE=InnoDB COMMENT='监管留痕表（参考武汉物业监管常见字段）'"
  );
  console.log('= audit_logs 监管留痕表就绪');

  // ⑥ 抗压索引：账单/订单/推送/报修的高频查询列
  await ensureIndex('bills', 'idx_hh_status', 'ALTER TABLE bills ADD INDEX idx_hh_status (household_id, status)');
  await ensureIndex('orders', 'idx_status', 'ALTER TABLE orders ADD INDEX idx_status (status)');
  await ensureIndex('orders', 'idx_created', 'ALTER TABLE orders ADD INDEX idx_created (created_at)');
  await ensureIndex('notifications', 'idx_send', 'ALTER TABLE notifications ADD INDEX idx_send (send_date)');
  await ensureIndex('repair_orders', 'idx_created', 'ALTER TABLE repair_orders ADD INDEX idx_created (created_at)');

  console.log('');
  console.log('✓ 升级完成。建议再执行一次 node scripts/seed-property.js 补充物业费演示账单。');
  process.exit(0);
}

main().catch(function (e) {
  console.error('✗ 升级失败：', e.message);
  process.exit(1);
});
