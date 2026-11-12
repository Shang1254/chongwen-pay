-- ============================================================
-- 崇文兰亭便民缴费通 · 数据库初始化脚本（武汉鼎诚物业 · 2号楼试点）
-- 怎么用（二选一）：
--   ① 命令行：mysql -uroot -p < init.sql
--   ② Navicat / MySQL Workbench：新建查询窗口 → 整个文件粘贴进去 → 执行
-- 跑完就有：库和表 + 1 个物业账号 + 8 户演示住户 + 演示账单
-- 想要更多演示数据（整栋楼 48 户 + 半年账单），再跑：
--   node scripts/seed-demo.js      然后  node scripts/seed-property.js
--
-- ★ 数据安全说明：本脚本已去掉 DROP TABLE，全部是"没有才建"，
--   重复执行不会删除已有数据，可以放心重跑。
--   老库要补新字段/新表，请执行 node db/migrate-v2.js
-- ============================================================

-- 建库：utf8mb4 能存各种汉字，不会变成问号
CREATE DATABASE IF NOT EXISTS cwlt_pay DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE cwlt_pay;

-- ------------------------------------------------------------
-- 1. 住户表：小区的"户口本"，物业提前录好，居民绑定时要对得上
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS households (
  id INT AUTO_INCREMENT PRIMARY KEY,
  building VARCHAR(10) NOT NULL COMMENT '楼栋，如 2',
  unit VARCHAR(10) NOT NULL COMMENT '单元，如 1',
  room_no VARCHAR(20) NOT NULL COMMENT '房号，如 302',
  owner_name VARCHAR(30) NOT NULL COMMENT '户主姓名',
  electric_account VARCHAR(50) NOT NULL DEFAULT '' COMMENT '电户号（模拟水电局登记数据）',
  water_account VARCHAR(50) NOT NULL DEFAULT '' COMMENT '水户号',
  area DECIMAL(10,2) NOT NULL DEFAULT 90.00 COMMENT '建筑面积（㎡），算物业费用',
  reg_phone_enc VARCHAR(300) NOT NULL DEFAULT '' COMMENT '物业登记手机号（加密）',
  water_balance DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '水费代收余额（物业登记，展示用）',
  status TINYINT NOT NULL DEFAULT 1 COMMENT '1=正常 0=停用',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_room (building, unit, room_no)
) ENGINE=InnoDB COMMENT='住户户号表';

-- ------------------------------------------------------------
-- 2. 用户表：用微信打开小程序的人（物业管理员也在里面，靠 role 区分）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  openid VARCHAR(64) NOT NULL COMMENT '微信身份号，一人一个',
  nickname VARCHAR(50) NOT NULL DEFAULT '' COMMENT '昵称',
  username VARCHAR(30) DEFAULT NULL COMMENT '登录名（只有物业管理员用）',
  password VARCHAR(64) DEFAULT NULL COMMENT '密码（sha256 加密后存，看不到原文）',
  role VARCHAR(10) NOT NULL DEFAULT 'resident' COMMENT 'resident=居民 admin=物业管理员',
  test_access TINYINT NOT NULL DEFAULT 0 COMMENT '1=已用邀请码解锁2栋试点',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_openid (openid)
) ENGINE=InnoDB COMMENT='用户表';

-- ------------------------------------------------------------
-- 3. 绑定表：哪个微信用户绑了哪一户
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bindings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL COMMENT '哪个用户',
  household_id INT NOT NULL COMMENT '绑了哪户',
  role VARCHAR(10) NOT NULL DEFAULT 'owner' COMMENT 'owner=业主 tenant=租户',
  phone_enc VARCHAR(300) NOT NULL DEFAULT '' COMMENT '绑定人手机号（加密）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_bind (user_id, household_id),
  KEY idx_household (household_id)
) ENGINE=InnoDB COMMENT='用户-户号绑定表';

-- ------------------------------------------------------------
-- 4. 账单表：水电费 + 物业费账单（物业抄表/导入产生）
--    注意：逾期不单独设状态，查询时按"到期日已过+未缴"现算
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bills (
  id INT AUTO_INCREMENT PRIMARY KEY,
  household_id INT NOT NULL COMMENT '哪一户',
  type VARCHAR(10) NOT NULL COMMENT 'electric=电费 water=水费 property=物业费',
  period VARCHAR(7) NOT NULL COMMENT '账期，如 2026-11',
  prev_reading DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '上次抄表读数',
  curr_reading DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '本次抄表读数',
  usage_qty DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '用量=本次-上次（电:度 水:吨 物业费:0）',
  unit_price DECIMAL(10,4) NOT NULL DEFAULT 0 COMMENT '单价（元）',
  amount DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '应缴金额（元）',
  due_date DATE NOT NULL COMMENT '缴费截止日',
  status VARCHAR(10) NOT NULL DEFAULT 'unpaid' COMMENT 'unpaid=待缴 paid=已缴',
  source VARCHAR(20) NOT NULL DEFAULT 'manual' COMMENT 'manual=后台录入 import=物业导入 api=厂商接口',
  active_order_no VARCHAR(32) NOT NULL DEFAULT '' COMMENT '未支付订单占位（并发防重复下单）',
  paid_at DATETIME DEFAULT NULL COMMENT '实际缴费时间',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_bill (household_id, type, period),
  KEY idx_status (status, due_date),
  KEY idx_hh_status (household_id, status)
) ENGINE=InnoDB COMMENT='水电物业账单表';

-- ------------------------------------------------------------
-- 5. 订单表：每次缴费动作留一条底，出了问题能对账
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_no VARCHAR(32) NOT NULL COMMENT '订单号',
  user_id INT NOT NULL COMMENT '谁缴的',
  bill_id INT NOT NULL COMMENT '主账单（多账单见 order_bills）',
  amount DECIMAL(10,2) NOT NULL COMMENT '金额（元）',
  status VARCHAR(10) NOT NULL DEFAULT 'created' COMMENT 'created=已下单 success=已支付 closed=已关闭 failed=失败',
  pay_mode VARCHAR(10) NOT NULL DEFAULT 'mock' COMMENT 'mock=演示 wechat=微信支付',
  transaction_id VARCHAR(64) NOT NULL DEFAULT '' COMMENT '微信支付单号（真实模式才有）',
  voucher_no VARCHAR(40) NOT NULL DEFAULT '' COMMENT '电子凭证编号',
  voucher_hash VARCHAR(64) NOT NULL DEFAULT '' COMMENT '凭证防伪哈希',
  refund_no VARCHAR(40) NOT NULL DEFAULT '' COMMENT '退款单号',
  refund_amount DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '退款金额（元）',
  refund_status VARCHAR(10) NOT NULL DEFAULT '' COMMENT 'refunding=退款中 refunded=已退款',
  refund_at DATETIME DEFAULT NULL COMMENT '退款完成时间',
  refund_reason VARCHAR(200) NOT NULL DEFAULT '' COMMENT '退款原因',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME DEFAULT NULL,
  UNIQUE KEY uniq_order (order_no),
  KEY idx_user (user_id),
  KEY idx_status (status),
  KEY idx_created (created_at)
) ENGINE=InnoDB COMMENT='缴费订单表';

-- 订单-账单关联表（一次结账可含多张账单）
CREATE TABLE IF NOT EXISTS order_bills (
  order_id INT NOT NULL COMMENT '订单id',
  bill_id INT NOT NULL COMMENT '账单id',
  PRIMARY KEY (order_id, bill_id),
  KEY idx_bill (bill_id)
) ENGINE=InnoDB COMMENT='订单与账单的对应关系';

-- ------------------------------------------------------------
-- 6. 推送记录表：欠费提醒 Agent 每次发的消息都记一笔
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL COMMENT '发给谁',
  bill_id INT DEFAULT NULL COMMENT '关联哪张账单（每日汇总类没有）',
  type VARCHAR(20) NOT NULL COMMENT 'due3=到期前3天 overdue1=逾期1天 manual_push=人工催缴 daily_report=每日汇总',
  title VARCHAR(100) NOT NULL DEFAULT '' COMMENT '标题',
  content VARCHAR(500) NOT NULL DEFAULT '' COMMENT '内容',
  status VARCHAR(10) NOT NULL DEFAULT 'mock' COMMENT 'sent=已真实推送 mock=演示记录 fail=发送失败',
  send_date DATE NOT NULL COMMENT '发送日期',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY uniq_push (bill_id, type, send_date),
  KEY idx_send (send_date)
) ENGINE=InnoDB COMMENT='推送/提醒记录表';

-- ------------------------------------------------------------
-- 7. 校验日志表：账单校验 Agent 每次拦截都有记录
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS check_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  scene VARCHAR(10) NOT NULL DEFAULT '' COMMENT 'bind=绑定 pay=缴费 admin=后台录入',
  input VARCHAR(200) NOT NULL DEFAULT '' COMMENT '当时输入了什么',
  result VARCHAR(10) NOT NULL DEFAULT '' COMMENT 'ok/warn/error',
  message VARCHAR(300) NOT NULL DEFAULT '' COMMENT '提示了什么',
  user_id INT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='账单校验日志表';

-- ------------------------------------------------------------
-- 8. 用量统计表：用量分析 Agent 每月的分析结果（JSON 存档）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_stats (
  id INT AUTO_INCREMENT PRIMARY KEY,
  period VARCHAR(7) NOT NULL COMMENT '账期，如 2026-10',
  stats LONGTEXT COMMENT '分析结果（JSON）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_period (period)
) ENGINE=InnoDB COMMENT='用量分析结果表';

-- ------------------------------------------------------------
-- 9. 每日欠费汇总表：欠费提醒 Agent 每天给物业的"催缴清单"
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_reports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  report_date DATE NOT NULL COMMENT '哪一天的汇总',
  unpaid_count INT NOT NULL DEFAULT 0 COMMENT '未缴账单笔数',
  unpaid_amount DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '未缴金额合计',
  detail LONGTEXT COMMENT '明细名单（JSON）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_date (report_date)
) ENGINE=InnoDB COMMENT='每日欠费汇总表';

-- ------------------------------------------------------------
-- 10. 系统配置表：存微信 access_token 之类的运行时缓存
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS config (
  k VARCHAR(50) PRIMARY KEY,
  v TEXT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB COMMENT='系统配置表';

-- ------------------------------------------------------------
-- 11. 报修单表：居民提交、物业处理
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repair_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  household_id INT DEFAULT NULL,
  category VARCHAR(30) NOT NULL DEFAULT '' COMMENT '报修类型',
  content VARCHAR(500) NOT NULL DEFAULT '' COMMENT '问题描述',
  img_url VARCHAR(300) NOT NULL DEFAULT '' COMMENT '现场照片路径（/uploads/xx.jpg）',
  contact_enc VARCHAR(300) NOT NULL DEFAULT '' COMMENT '联系电话（加密存储）',
  status VARCHAR(10) NOT NULL DEFAULT 'pending' COMMENT 'pending=待处理 doing=处理中 done=已完成',
  priority VARCHAR(10) NOT NULL DEFAULT 'normal' COMMENT 'normal=普通 high=加急 urgent=紧急',
  assignee VARCHAR(30) NOT NULL DEFAULT '' COMMENT '维修师傅',
  feedback VARCHAR(300) NOT NULL DEFAULT '' COMMENT '物业处理回复',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT NULL,
  KEY idx_user (user_id), KEY idx_status (status),
  KEY idx_created (created_at)
) ENGINE=InnoDB COMMENT='物业报修单表';

-- 报修工单流转日志（看板拖拽/状态变更都留痕）
CREATE TABLE IF NOT EXISTS repair_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  repair_id INT NOT NULL,
  from_status VARCHAR(10) NOT NULL DEFAULT '' COMMENT '原状态',
  to_status VARCHAR(10) NOT NULL DEFAULT '' COMMENT '新状态',
  operator VARCHAR(30) NOT NULL DEFAULT '' COMMENT '操作人',
  note VARCHAR(300) NOT NULL DEFAULT '' COMMENT '备注',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_repair (repair_id)
) ENGINE=InnoDB COMMENT='报修工单流转日志';

-- ------------------------------------------------------------
-- 12. 监管留痕表：每笔缴费一条，哈希链防篡改
--     按武汉物业监管常见字段设计，导出/对接时字段映射即可
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  record_no VARCHAR(40) NOT NULL COMMENT '留痕记录号',
  biz_type VARCHAR(20) NOT NULL DEFAULT 'payment' COMMENT 'payment=缴费',
  community VARCHAR(50) NOT NULL DEFAULT '' COMMENT '小区名称',
  property_company VARCHAR(100) NOT NULL DEFAULT '' COMMENT '物业企业',
  house_label VARCHAR(50) NOT NULL DEFAULT '' COMMENT '房号',
  owner_enc VARCHAR(200) NOT NULL DEFAULT '' COMMENT '业主姓名（加密）',
  fee_type VARCHAR(20) NOT NULL DEFAULT '' COMMENT 'electric/water/property',
  period VARCHAR(7) NOT NULL DEFAULT '' COMMENT '账期',
  amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  pay_channel VARCHAR(20) NOT NULL DEFAULT 'wechat' COMMENT '收款渠道',
  transaction_id VARCHAR(64) NOT NULL DEFAULT '' COMMENT '支付单号',
  paid_at DATETIME DEFAULT NULL,
  data_hash VARCHAR(64) NOT NULL DEFAULT '' COMMENT '本条哈希',
  prev_hash VARCHAR(64) NOT NULL DEFAULT '' COMMENT '前序哈希（链式留痕）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_record (record_no), KEY idx_paid (paid_at)
) ENGINE=InnoDB COMMENT='监管留痕表（参考武汉物业监管常见字段）';

-- ------------------------------------------------------------
-- 13. 物业操作日志表：后台每个动作都留痕（审计）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  admin_id INT NOT NULL,
  action VARCHAR(30) NOT NULL DEFAULT '' COMMENT '动作：login/addbill/offline-pay/refund...',
  target VARCHAR(100) NOT NULL DEFAULT '' COMMENT '操作对象',
  detail VARCHAR(500) NOT NULL DEFAULT '' COMMENT '明细',
  ip VARCHAR(50) NOT NULL DEFAULT '' COMMENT '操作IP',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_admin (admin_id), KEY idx_created (created_at)
) ENGINE=InnoDB COMMENT='物业操作日志表';

-- ============================================================
-- 以下写入演示数据（全部防重复，重跑安全）
-- ============================================================

-- 物业管理员账号：admin / admin123（密码是 sha256(盐+密码) 后存的）
INSERT IGNORE INTO users (openid, nickname, username, password, role)
VALUES ('admin-local', '物业管理员', 'admin', 'f89dbda7eb8d8b1cdecbce555226dc4840de669c6faaa7c8494bcbbfc2bcc004', 'admin');

-- 8 户演示住户（正式使用时由物业在后台录入全部住户）
INSERT IGNORE INTO households (building, unit, room_no, owner_name, electric_account, water_account, area) VALUES
('2', '1', '101', '张建国', 'E2010101', 'W2010101', 92.5),
('2', '1', '102', '李秀英', 'E2010102', 'W2010102', 88.0),
('2', '1', '201', '王德福', 'E2010201', 'W2010201', 95.0),
('2', '1', '202', '刘桂兰', 'E2010202', 'W2010202', 90.5),
('2', '2', '101', '陈志强', 'E2020101', 'W2020101', 91.0),
('2', '2', '102', '杨淑芬', 'E2020102', 'W2020102', 87.5),
('2', '2', '201', '赵国庆', 'E2020201', 'W2020201', 96.0),
('2', '2', '202', '孙玉兰', 'E2020202', 'W2020202', 89.0);

-- 演示账单①：过去 5 个月电费（都已缴）
INSERT IGNORE INTO bills (household_id, type, period, prev_reading, curr_reading, usage_qty, unit_price, amount, due_date, status, paid_at)
SELECT h.id, 'electric',
       DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL n.n MONTH), '%Y-%m'),
       1000 + (6 - n.n) * 50,
       1000 + (6 - n.n) * 50 + 30 + n.n * 2,
       30 + n.n * 2,
       0.55,
       ROUND((30 + n.n * 2) * 0.55, 2),
       DATE_SUB(CURDATE(), INTERVAL n.n - 1 MONTH),
       'paid',
       DATE_SUB(CURDATE(), INTERVAL n.n - 1 MONTH)
FROM households h
JOIN (SELECT 1 n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5) n
WHERE h.building = '2';

-- 演示账单②：过去 5 个月水费（都已缴）。1 单元 101 跳过，下面单独造逾期账单
INSERT IGNORE INTO bills (household_id, type, period, prev_reading, curr_reading, usage_qty, unit_price, amount, due_date, status, paid_at)
SELECT h.id, 'water',
       DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL n.n MONTH), '%Y-%m'),
       500 + (6 - n.n) * 10,
       500 + (6 - n.n) * 10 + 6 + h.id % 3,
       6 + h.id % 3,
       3.45,
       ROUND((6 + h.id % 3) * 3.45, 2),
       DATE_SUB(CURDATE(), INTERVAL n.n - 1 MONTH),
       'paid',
       DATE_SUB(CURDATE(), INTERVAL n.n - 1 MONTH)
FROM households h
JOIN (SELECT 1 n UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5) n
WHERE h.building = '2' AND NOT (h.unit = '1' AND h.room_no = '101');

-- 演示账单③：本月电费，5 天后到期
INSERT IGNORE INTO bills (household_id, type, period, prev_reading, curr_reading, usage_qty, unit_price, amount, due_date, status)
SELECT h.id, 'electric',
       DATE_FORMAT(CURDATE(), '%Y-%m'),
       1150, 1150 + 60 + h.id * 3, 60 + h.id * 3,
       0.55, ROUND((60 + h.id * 3) * 0.55, 2),
       DATE_ADD(CURDATE(), INTERVAL 5 DAY), 'unpaid'
FROM households h WHERE h.building = '2';

-- 演示账单④：本月水费，7 天后到期
INSERT IGNORE INTO bills (household_id, type, period, prev_reading, curr_reading, usage_qty, unit_price, amount, due_date, status)
SELECT h.id, 'water',
       DATE_FORMAT(CURDATE(), '%Y-%m'),
       560, 568 + h.id % 4, 8 + h.id % 4,
       3.45, ROUND((8 + h.id % 4) * 3.45, 2),
       DATE_ADD(CURDATE(), INTERVAL 7 DAY), 'unpaid'
FROM households h WHERE h.building = '2';

-- 说明：物业费演示账单由 `node scripts/seed-property.js` 生成
-- （放在单独脚本里，老库还没升级"面积"字段时也能安全执行）

-- 演示账单⑤：给 1 单元 101 造一笔"逾期 1 天"的水费（演示逾期提醒）
INSERT IGNORE INTO bills (household_id, type, period, prev_reading, curr_reading, usage_qty, unit_price, amount, due_date, status)
SELECT h.id, 'water',
       DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m'),
       500, 512, 12, 3.45, ROUND(12 * 3.45, 2),
       DATE_SUB(CURDATE(), INTERVAL 1 DAY), 'unpaid'
FROM households h WHERE h.unit = '1' AND h.room_no = '101';

-- 演示账单⑥：把 1 单元 102 的本月电费改成"3 天后到期"（演示到期前 3 天提醒）
UPDATE bills
SET due_date = DATE_ADD(CURDATE(), INTERVAL 3 DAY)
WHERE status = 'unpaid' AND type = 'electric'
  AND household_id = (SELECT id FROM households WHERE unit = '1' AND room_no = '102' AND building = '2');

-- 完成！物业后台：http://127.0.0.1:3000/admin  账号 admin 密码 admin123
