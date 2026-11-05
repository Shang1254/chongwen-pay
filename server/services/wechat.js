// ============================================================
// 微信官方服务适配层：登录、订阅消息推送，全从这一层走
// 演示模式下不真连微信，功能照常跑通；正式上线填好 config.js 即可
//
// ★ 关于"微信生活缴费开放接口"的重要说明 ★
// 微信官方"生活缴费"平台只对水电燃气事业单位及持牌服务商开放，
// 普通物业类小程序无法直接接入。本项目的做法：
//   1. 户号/账单数据 = 物业自行登记（households / bills 表），
//      相当于自建"缴费台账"，不依赖物业旧系统；
//   2. 若未来拿到公用事业接口授权，只需把
//      agents/bill-check-agent.js 里的 queryGovAccount() 换成真实接口，
//      其余代码一行不用动。
// ============================================================
const https = require('https');
const config = require('../config');
const { pool } = require('../db/pool');

// 发一个 HTTPS 请求拿 JSON（不引第三方库，Node 自带就够用）
function httpsJson(options, body) {
  return new Promise(function (resolve, reject) {
    const req = https.request(options, function (res) {
      let raw = '';
      res.on('data', function (c) { raw += c; });
      res.on('end', function () {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('微信接口返回格式异常')); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------- 登录：拿 code 换 openid ----------
// 演示模式：不真调微信，用前端传来的设备号当身份（一台设备一个，稳定不变）
async function code2Session(code, mockId) {
  if (config.mockMode) {
    return { openid: 'mock_' + (mockId || code || 'default'), mock: true };
  }
  const r = await httpsJson({
    hostname: 'api.weixin.qq.com',
    path: '/sns/jscode2session?appid=' + config.wechat.appid +
          '&secret=' + config.wechat.secret +
          '&js_code=' + code + '&grant_type=authorization_code',
    method: 'GET'
  });
  if (!r.openid) {
    throw new Error('微信登录失败：' + (r.errmsg || 'code 无效，请检查 AppID/Secret'));
  }
  return { openid: r.openid, mock: false };
}

// ---------- 订阅消息推送（欠费提醒 Agent 用） ----------
// 没配置模板 ID 时只写数据库记录，不影响系统运行
async function sendSubscribeMessage(openid, content) {
  if (config.mockMode || !config.subscribeTemplateId) {
    return { mock: true };
  }
  try {
    const token = await getAccessToken();
    const data = JSON.stringify({
      touser: openid,
      template_id: config.subscribeTemplateId,
      page: 'pages/index/index',
      data: {
        thing1: { value: content.slice(0, 20) },   // 模板字段按实际申请到的模板调整
        thing2: { value: '崇文兰庭物业' }
      }
    });
    const r = await httpsJson({
      hostname: 'api.weixin.qq.com',
      path: '/cgi-bin/message/subscribe/send?access_token=' + token,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, data);
    return r;
  } catch (e) {
    console.error('[订阅消息] 发送失败：', e.message);
    return { fail: true };
  }
}

// 拿微信 access_token：存数据库缓存，快过期才重新要（一天只要几百次，不能浪费）
async function getAccessToken() {
  const [rows] = await pool.query("SELECT v FROM config WHERE k = 'wx_access_token'");
  if (rows[0]) {
    try {
      const cached = JSON.parse(rows[0].v);
      if (cached.expire > Date.now()) return cached.token;
    } catch (e) { /* 缓存坏了就重新拿 */ }
  }
  const r = await httpsJson({
    hostname: 'api.weixin.qq.com',
    path: '/cgi-bin/token?grant_type=client_credential&appid=' + config.wechat.appid +
          '&secret=' + config.wechat.secret,
    method: 'GET'
  });
  if (!r.access_token) {
    throw new Error('获取 access_token 失败：' + (r.errmsg || ''));
  }
  const cache = JSON.stringify({ token: r.access_token, expire: Date.now() + (r.expires_in - 300) * 1000 });
  await pool.query(
    "INSERT INTO config (k, v) VALUES ('wx_access_token', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)",
    [cache]
  );
  return r.access_token;
}

module.exports = {
  code2Session: code2Session,
  sendSubscribeMessage: sendSubscribeMessage,
  getAccessToken: getAccessToken
};
