// ============================================================
// 缴费结果回写物业系统（可选 Webhook）
// ------------------------------------------------------------
// 在 config.js 填 syncWebhookUrl 后，每笔支付成功会自动 POST：
//   请求体：{ type, orderNo, amount, paidAt, channel, billIds, unlockMode }
//   请求头：X-CWLT-Sign = hmac(原始报文)  ← 物业端用同一个 dataKey 验签
// 发送失败只记日志、不影响居民缴费；物业端没准备好就留空即可，
// 此时用"监管留痕导出 / 对账文件导出"做人工对账。
// ============================================================
const https = require('https');
const config = require('../config');
const cryptoUtil = require('../utils/crypto');

function post(urlStr, bodyStr, sign) {
  return new Promise(function (resolve) {
    try {
      const url = new URL(urlStr);
      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: 'POST',
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyStr),
          'X-CWLT-Sign': sign
        }
      }, function (res) {
        res.resume();
        res.on('end', function () {
          console.log('[回写物业] 物业系统应答 ' + res.statusCode);
          resolve();
        });
      });
      req.on('timeout', function () { req.destroy(); });
      req.on('error', function (e) {
        console.error('[回写物业] 发送失败（不影响缴费）：', e.message);
        resolve();
      });
      req.write(bodyStr);
      req.end();
    } catch (e) {
      console.error('[回写物业] 地址不合法，请检查 config.syncWebhookUrl：', e.message);
      resolve();
    }
  });
}

// 支付成功后调用（fire-and-forget，绝不阻塞主流程）
function propertySettlement(payload) {
  const url = String(config.syncWebhookUrl || '').trim();
  if (!url) return Promise.resolve();
  const body = JSON.stringify(Object.assign({ type: 'payment' }, payload));
  const sign = cryptoUtil.hmac(body);
  return post(url, body, sign);
}

module.exports = { propertySettlement: propertySettlement };
