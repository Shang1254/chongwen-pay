// ============================================================
// 微信支付结果回调：微信服务器通知"这笔钱收到了"
// 必须做三件事：①验签（防伪造）②解密 ③幂等销账
// 注意：这个路由挂在 express.json() 之前，拿的是原始请求体，
//       因为验签要用原样的字符串，JSON 解析过就验不过了。
// ============================================================
const express = require('express');
const router = express.Router();
const wxpay = require('../services/wxpay');
const orderSvc = require('../services/order');

router.post('/', express.raw({ type: '*/*', limit: '1mb' }), async function (req, res) {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');

    // 没配公钥就不处理（宁可让物业看到报错，也不能被伪造回调骗过）
    if (!wxpay.notifyReady()) {
      console.error('[微信支付回调] 未配置微信支付公钥，已拒绝。请把 wechatpay_pub.pem 放到 server/certs/ 并在 config.js 填好路径');
      return res.status(500).json({ code: 'FAIL', message: '公钥未配置' });
    }

    if (!wxpay.verifyNotify(req.headers, raw)) {
      console.error('[微信支付回调] 验签失败，可能有人伪造回调，已拒绝');
      return res.status(401).json({ code: 'FAIL', message: '验签失败' });
    }

    const body = JSON.parse(raw || '{}');
    // 不是支付成功事件就忽略（但也要回 SUCCESS，否则微信会一直重发）
    if (body.event_type && body.event_type !== 'TRANSACTION.SUCCESS') {
      return res.json({ code: 'SUCCESS', message: '非支付成功事件，已忽略' });
    }

    const data = wxpay.decryptResource(body.resource);
    if (data.trade_state === 'SUCCESS') {
      const sr = await orderSvc.settleOrder(data.out_trade_no, data.transaction_id);
      if (!sr.ok) {
        console.error('[微信支付回调] 订单销账未生效：' + data.out_trade_no + '（可能订单不存在）');
        // 返回 FAIL 让微信稍后重发，避免漏单
        return res.status(500).json({ code: 'FAIL', message: '订单未找到' });
      }
      // 重复回调（sr.newly=false）同样返回 SUCCESS，微信就不会再重发
      console.log('[微信支付回调] 收款成功' + (sr.newly ? '' : '（重复回调，幂等处理）') + '：' + data.out_trade_no + '，¥' + (data.amount.total / 100).toFixed(2));
    }
    res.json({ code: 'SUCCESS', message: '成功' });
  } catch (e) {
    console.error('[微信支付回调] 处理失败：', e.message);
    res.status(500).json({ code: 'FAIL', message: e.message });
  }
});

module.exports = router;
