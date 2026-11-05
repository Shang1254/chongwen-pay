// ============================================================
// 微信支付 v3（JSAPI）适配层：真正的"收钱"接口
// ------------------------------------------------------------
// 说明：这里用的是微信支付官方 v3 API，不引第三方 SDK，
//       签名/验签/解密全部用 Node 自带的 crypto 完成。
//
// 它解决的是"居民把钱交给物业"这件事：
//   小程序下单 → 微信收银台 → 钱进武汉鼎盛佳物业的商户号
//   → 微信回调我们 → 账单自动标记已缴
//
// ⚠️ 水电公司（国家电网/武汉市水务）的缴费接口不对物业开放，
//    物业代收（总表转供）只能用这条路：钱先进物业商户号，
//    物业再统一向供水/供电公司缴费。这是合规且唯一可行的做法。
// ============================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('../config');

const API_HOST = 'api.mch.weixin.qq.com';

function payCfg() {
  return config.wechatPay || {};
}

// 证书文件路径：支持绝对路径，也支持相对 server/ 目录
function certPath(p) {
  if (!p) return '';
  return path.isAbsolute(p) ? p : path.join(__dirname, '..', p);
}

let cached = { privateKey: null, publicKey: null };

function privateKey() {
  if (cached.privateKey) return cached.privateKey;
  const p = certPath(payCfg().privateKeyPath);
  if (!p || !fs.existsSync(p)) {
    throw new Error('找不到商户API私钥文件：' + p + '，请把 apiclient_key.pem 放到 server/certs/ 下');
  }
  cached.privateKey = fs.readFileSync(p, 'utf8');
  return cached.privateKey;
}

function platformPublicKey() {
  if (cached.publicKey) return cached.publicKey;
  const p = certPath(payCfg().platformPublicKeyPath);
  if (!p || !fs.existsSync(p)) {
    throw new Error('找不到微信支付公钥文件：' + p + '，请在商户平台下载后放到 server/certs/ 下');
  }
  cached.publicKey = fs.readFileSync(p, 'utf8');
  return cached.publicKey;
}

// 配置是否齐全（缺任何一项都不允许发起真实支付）
function isConfigured() {
  const c = payCfg();
  return !!(config.wechat.appid && c.mchid && c.serialNo && c.apiV3Key &&
            c.privateKeyPath && c.notifyUrl && c.notifyUrl.indexOf('你的域名') === -1);
}

// 回调验签所需的公钥是否配好
function notifyReady() {
  const c = payCfg();
  return !!(c.platformPublicKeyPath && fs.existsSync(certPath(c.platformPublicKeyPath)) && c.apiV3Key);
}

function nonceStr() {
  return crypto.randomBytes(16).toString('hex');
}

function rsaSign(message) {
  return crypto.createSign('RSA-SHA256').update(message, 'utf8').sign(privateKey(), 'base64');
}

// 组装请求头里的 Authorization（微信支付 v3 规定的格式）
function authHeader(method, urlPath, bodyStr) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = nonceStr();
  const message = method + '\n' + urlPath + '\n' + timestamp + '\n' + nonce + '\n' + bodyStr + '\n';
  const signature = rsaSign(message);
  return 'WECHATPAY2-SHA256-RSA2048 ' +
    'mchid="' + payCfg().mchid + '",' +
    'nonce_str="' + nonce + '",' +
    'signature="' + signature + '",' +
    'timestamp="' + timestamp + '",' +
    'serial_no="' + payCfg().serialNo + '"';
}

// 统一请求：返回解析后的 JSON；失败抛错（带微信的 code/message，方便排查）
function apiRequest(method, urlPath, body) {
  const bodyStr = body ? JSON.stringify(body) : '';
  return new Promise(function (resolve, reject) {
    const headers = {
      Authorization: authHeader(method, urlPath, bodyStr),
      Accept: 'application/json',
      'User-Agent': 'cwlt-pay/1.0'
    };
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = https.request({
      hostname: API_HOST,
      port: 443,
      path: urlPath,
      method: method,
      headers: headers,
      timeout: 15000
    }, function (res) {
      let raw = '';
      res.on('data', function (c) { raw += c; });
      res.on('end', function () {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch (e) { data = { raw: raw }; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data);
        const err = new Error((data && data.message) || ('微信支付接口出错（HTTP ' + res.statusCode + '）'));
        err.code = data && data.code;
        err.statusCode = res.statusCode;
        reject(err);
      });
    });
    req.on('timeout', function () { req.destroy(new Error('微信支付接口超时，请稍后重试')); });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------- 下单：拿到 prepay_id ----------
// outTradeNo 用本地订单号（≤32 位），金额单位是"分"
async function jsapiPrepay(opts) {
  if (!isConfigured()) {
    throw new Error('微信支付参数还没配齐，请检查 server/config.js 的 wechatPay 配置');
  }
  const openid = opts.openid || '';
  if (!openid || openid.indexOf('mock_') === 0) {
    throw new Error('当前是演示账号，不能发起真实微信支付。请用真实微信登录后再试');
  }
  const r = await apiRequest('POST', '/v3/pay/transactions/jsapi', {
    appid: config.wechat.appid,
    mchid: payCfg().mchid,
    description: String(opts.description || '物业水电费').slice(0, 127),
    out_trade_no: opts.outTradeNo,
    notify_url: payCfg().notifyUrl,
    amount: { total: opts.amountFen, currency: 'CNY' },
    payer: { openid: openid },
    attach: opts.attach || undefined
  });
  if (!r.prepay_id) throw new Error('微信支付下单失败：没有返回 prepay_id');
  return r.prepay_id;
}

// ---------- 给小程序 wx.requestPayment 用的参数 ----------
function buildJsapiPayParams(prepayId) {
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const nonce = nonceStr();
  const pkg = 'prepay_id=' + prepayId;
  // 签名串格式：appId\ntimeStamp\nnonceStr\npackage\n
  const paySign = rsaSign([config.wechat.appid, timeStamp, nonce, pkg].join('\n') + '\n');
  return {
    appId: config.wechat.appid,
    timeStamp: timeStamp,
    nonceStr: nonce,
    package: pkg,
    signType: 'RSA',
    paySign: paySign
  };
}

// ---------- 主动查单（支付回调没到时兜底，防止"钱扣了账单没销"）----------
async function queryOrder(outTradeNo) {
  const urlPath = '/v3/pay/transactions/out-trade-no/' + encodeURIComponent(outTradeNo) +
                  '?mchid=' + encodeURIComponent(payCfg().mchid);
  return apiRequest('GET', urlPath);
}

// ---------- 回调验签 ----------
// 微信要求验证 Wechatpay-Signature，防止有人伪造"支付成功"通知
function verifyNotify(headers, rawBody) {
  const timestamp = String(headers['wechatpay-timestamp'] || '');
  const nonce = String(headers['wechatpay-nonce'] || '');
  const signature = String(headers['wechatpay-signature'] || '');
  const serial = String(headers['wechatpay-serial'] || '');
  if (!timestamp || !nonce || !signature) return false;

  // 防重放：时间戳偏差超过 5 分钟直接拒绝
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  // 如果配置了公钥ID，校验回调头里的 serial 是否对得上
  if (payCfg().platformPublicKeyId && serial && serial !== payCfg().platformPublicKeyId) {
    console.error('[微信支付] 回调公钥ID不匹配：收到 ' + serial + '，配置的是 ' + payCfg().platformPublicKeyId);
    return false;
  }

  const message = timestamp + '\n' + nonce + '\n' + rawBody + '\n';
  try {
    return crypto.createVerify('RSA-SHA256')
      .update(message, 'utf8')
      .verify(platformPublicKey(), signature, 'base64');
  } catch (e) {
    console.error('[微信支付] 验签异常：', e.message);
    return false;
  }
}

// ---------- 解密回调里的 resource（AES-256-GCM）----------
function decryptResource(resource) {
  if (!resource || !resource.ciphertext) throw new Error('回调数据为空');
  const key = Buffer.from(String(payCfg().apiV3Key), 'utf8');
  if (key.length !== 32) throw new Error('APIv3密钥必须是 32 位字符，请检查 config.js');
  const raw = Buffer.from(resource.ciphertext, 'base64');
  const authTag = raw.subarray(raw.length - 16);
  const data = raw.subarray(0, raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'));
  decipher.setAuthTag(authTag);
  if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

// ---------- 退款（退款三件套之一：回调/退款/对账） ----------
// 原路退回：钱从物业商户号原路退回居民微信。out_refund_no 必须全局唯一。
async function refund(opts) {
  if (!isConfigured()) throw new Error('微信支付参数还没配齐，无法发起退款');
  const r = await apiRequest('POST', '/v3/refund/domestic/refunds', {
    out_trade_no: opts.outTradeNo,
    out_refund_no: opts.outRefundNo,
    reason: opts.reason ? String(opts.reason).slice(0, 80) : undefined,
    amount: { refund: opts.refundFen, total: opts.totalFen, currency: 'CNY' }
  });
  return r; // { refund_id, out_refund_no, status: SUCCESS / PROCESSING / ABNORMAL }
}

// 查退款状态（退款提交后是 PROCESSING 时，用它兜底确认）
async function queryRefund(outRefundNo, outTradeNo) {
  let path = '/v3/refund/domestic/refunds/' + encodeURIComponent(outRefundNo);
  if (outTradeNo) path += '?out_trade_no=' + encodeURIComponent(outTradeNo);
  return apiRequest('GET', path);
}

module.exports = {
  isConfigured: isConfigured,
  notifyReady: notifyReady,
  jsapiPrepay: jsapiPrepay,
  buildJsapiPayParams: buildJsapiPayParams,
  queryOrder: queryOrder,
  refund: refund,
  queryRefund: queryRefund,
  verifyNotify: verifyNotify,
  decryptResource: decryptResource
};
