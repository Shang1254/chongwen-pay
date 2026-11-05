// ============================================================
// 崇文兰亭便民缴费通 · 后端入口（武汉鼎诚物业 · 2号楼试点）
// 启动：node app.js（或双击 scripts/start.bat）
// 起来之后：
//   小程序接口  http://127.0.0.1:3000/api/...
//   物业后台    http://127.0.0.1:3000/admin
//   健康检查    http://127.0.0.1:3000/api/health
// ============================================================
const express = require('express');
const path = require('path');
const config = require('./config');
const { testDb } = require('./db/pool');
const { rateLimit } = require('./middleware/rate-limit');

const app = express();
app.set('trust proxy', 1); // 以后放到 Nginx 后面时，限流能拿到真实 IP

// ★ 微信支付回调必须原样拿到请求体（验签要用原始字符串），
//   所以它要挂在 express.json() 之前，否则签名永远对不上。
app.use('/api/pay/notify', require('./routes/pay-notify'));

// 文件上传走 base64 JSON（Excel 导入），所以把请求体上限放宽到 20MB
app.use(express.json({ limit: '20mb' }));

// ---------- 限流：防止狂刷/撞库/误操作把系统压垮 ----------
app.use('/api', rateLimit({ name: 'api', windowMs: 60 * 1000, max: 300 }));          // 普通接口：300 次/分钟/IP
app.use('/api/user/login', rateLimit({ name: 'login', windowMs: 60 * 1000, max: 30 }));      // 登录：30 次/分钟
app.use('/api/user/test-entry', rateLimit({ name: 'invite', windowMs: 60 * 1000, max: 20 })); // 邀请码：防暴力猜
app.use('/api/user/bind', rateLimit({ name: 'bind', windowMs: 60 * 1000, max: 20 }));        // 绑定：防批量试户号
app.use('/api/pay/create', rateLimit({ name: 'pay', windowMs: 60 * 1000, max: 60 }));        // 下单：60 次/分钟
app.use('/api/repair/create', rateLimit({ name: 'repair', windowMs: 60 * 1000, max: 20 }));  // 报修：防刷单
app.use('/api/admin/login', rateLimit({ name: 'adminlogin', windowMs: 60 * 1000, max: 20 })); // 物业登录：防撞库

// 允许物业后台跨域访问（比如后台页面从别的端口打开也能用）
app.use(function (req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// 物业后台静态页面（纯 HTML，不需要构建工具）
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));

// 报修现场照片：居民上传后存 server/uploads/，从这里对外展示
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 小程序接口
app.use('/api/user', require('./routes/user'));
app.use('/api/bill', require('./routes/bill'));
app.use('/api/pay', require('./routes/pay'));
app.use('/api/repair', require('./routes/repair'));
app.use('/api/upload', require('./routes/upload'));
app.use('/api/admin', require('./routes/admin'));

// 健康检查：浏览器打开能看到服务器和数据库的状态
app.get('/api/health', async function (req, res) {
  const db = await testDb();
  res.json({
    ok: true,
    db: db,
    mockMode: config.mockMode,
    pilotBuilding: config.pilotBuilding,
    time: new Date().toLocaleString()
  });
});

// 兜底：没有这个接口就明说
app.use(function (req, res) {
  res.status(404).json({ ok: false, message: '接口不存在：' + req.path });
});

// 兜底：代码出错了也别让服务挂掉
app.use(function (err, req, res, next) {
  // 请求体本身有问题（格式错/太大）时给明确的状态码，别一律 500
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, message: '请求内容格式不对（不是合法 JSON）' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, message: '文件太大，单次最多 20MB，请拆分后再上传' });
  }
  console.error('[出错了]', err.message);
  res.status(500).json({ ok: false, message: '服务器开小差了：' + err.message });
});

// ---------- 上线自检 ----------
// 正式模式（mockMode=false）下，关键配置没填就拒绝启动，
// 避免"以为上线了，其实还是演示模式"这种最危险的情况。
if (!config.mockMode) {
  const missing = [];
  const path = require('path');
  const fs = require('fs');
  if (!config.wechat.appid || config.wechat.appid.indexOf('换成') === 0) missing.push('wechat.appid（小程序AppID）');
  if (!config.wechat.secret || config.wechat.secret.indexOf('换成') === 0) missing.push('wechat.secret（小程序Secret）');
  if (!config.wechatPay.mchid) missing.push('wechatPay.mchid（商户号）');
  if (!config.wechatPay.serialNo) missing.push('wechatPay.serialNo（商户API证书序列号）');
  if (!config.wechatPay.apiV3Key || String(config.wechatPay.apiV3Key).length !== 32) missing.push('wechatPay.apiV3Key（必须是32位）');
  if (!config.wechatPay.notifyUrl || config.wechatPay.notifyUrl.indexOf('你的域名') !== -1) missing.push('wechatPay.notifyUrl（https 公网回调地址）');
  if (config.tokenSecret.indexOf('please-change') !== -1) missing.push('tokenSecret（不许用默认值，请改成一长串随机字符）');

  // 证书文件是否真的存在
  const certs = [
    ['商户API私钥', config.wechatPay.privateKeyPath],
    ['微信支付公钥', config.wechatPay.platformPublicKeyPath]
  ];
  certs.forEach(function (c) {
    if (!c[1]) return;
    const abs = path.isAbsolute(c[1]) ? c[1] : path.join(__dirname, c[1]);
    if (!fs.existsSync(abs)) missing.push(c[0] + '文件不存在：' + abs);
  });

  if (missing.length) {
    console.error('==========================================');
    console.error(' ✗ 正式模式启动失败：以下配置还没填好——');
    missing.forEach(function (m) { console.error('   · ' + m); });
    console.error(' 请打开 server/config.js 补齐后重启（证书放 server/certs/ 下）；');
    console.error(' 如果只是想本地演示，把 config.js 里 mockMode 改回 true 即可。');
    console.error('==========================================');
    process.exit(1);
  }
}

const server = app.listen(config.port, async function () {
  console.log('==========================================');
  console.log(' 崇文兰亭便民缴费通 · 后端已启动（' + config.companyShort + '）');
  console.log(' 物业后台: http://127.0.0.1:' + config.port + '/admin  （账号 admin / admin123）');
  console.log(' 健康检查: http://127.0.0.1:' + config.port + '/api/health');
  console.log(' 运行模式: ' + (config.mockMode ? '演示模式（不连真实微信支付）' : '正式模式'));
  console.log('==========================================');

  const dbOk = await testDb();
  console.log(dbOk ? ' 数据库连接正常 ✓' : ' ✗ 数据库连不上！请检查 config.js 的数据库配置，并确认已执行 db/init.sql');

  // 老库自动补表：order_bills（一次结账可对应多张账单），不用手工执行 SQL
  if (dbOk) {
    try {
      await require('./services/order').ensureSchema();
    } catch (e) {
      console.error(' 补建 order_bills 表失败：', e.message);
    }
  }

  // 两个后台 AI Agent 开始值班（欠费提醒 + 用量分析）
  try {
    require('./agents/remind-agent').start();
    require('./agents/usage-agent').start();
  } catch (e) {
    console.error(' Agent 启动失败：', e.message);
  }
});

// ---------- 抗压参数：请求别无限期挂着 ----------
server.requestTimeout = 60 * 1000;    // 一个请求最多 60 秒（Excel 大文件也够）
server.headersTimeout = 20 * 1000;    // 请求头 20 秒内必须发完
server.keepAliveTimeout = 65 * 1000;  // 长连接保持 65 秒
