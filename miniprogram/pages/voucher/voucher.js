// ============================================================
// 电子缴费凭证：缴完费后生成，带凭证编号和防伪码
// 可按订单号查（缴费结果页进来），也可按账单ID查（缴费记录点进来）
// ============================================================
const api = require('../../utils/api');
const util = require('../../utils/util');

Page({
  data: {
    loading: true,
    v: null,
    error: ''
  },

  onLoad(options) {
    var that = this;
    var q = [];
    if (options.orderNo) q.push('orderNo=' + options.orderNo);
    if (options.billId) q.push('billId=' + options.billId);
    if (!q.length) {
      that.setData({ loading: false, error: '缺少凭证参数' });
      return;
    }
    api.get('/api/pay/voucher?' + q.join('&')).then(function (v) {
      // 金额统一格式化
      v.amountText = util.fmtMoney(v.amount);
      v.items = (v.items || []).map(function (it) {
        it.amountText = util.fmtMoney(it.amount);
        return it;
      });
      that.setData({ loading: false, v: v });
    }).catch(function (err) {
      that.setData({ loading: false, error: err.message });
    });
  },

  // 小程序不能直接存图片，提示用户截图
  saveTip() {
    wx.showModal({
      title: '保存凭证',
      content: '请长按屏幕或使用手机截图保存。需要纸质凭证可到物业办公室打印。',
      showCancel: false,
      confirmText: '知道了'
    });
  }
});
