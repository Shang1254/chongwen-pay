// ============================================================
// 缴费结果页（缴费第 3 步结束）：告诉居民缴了多少、接下来干嘛
// 支持直接查看"电子缴费凭证"，并引导开启订阅消息提醒（需用户授权）
// ============================================================
const cfg = require('../../config');

Page({
  data: {
    amount: '0.00',
    count: 0,
    orderNo: '',
    canSubscribe: false   // 物业配置了订阅消息模板才显示提醒按钮
  },

  onLoad(options) {
    this.setData({
      amount: options.amount || '0.00',
      count: Number(options.count || 0),
      orderNo: options.orderNo || '',
      canSubscribe: !!cfg.subscribeTemplateId
    });
  },

  // 查看电子缴费凭证
  goVoucher() {
    if (!this.data.orderNo) {
      wx.showToast({ title: '凭证生成中，请到"缴费记录"查看', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/voucher/voucher?orderNo=' + this.data.orderNo });
  },

  // 缴费成功后顺势引导授权订阅消息（微信要求必须由用户点击触发）
  subscribe() {
    if (!cfg.subscribeTemplateId) return;
    wx.requestSubscribeMessage({
      tmplIds: [cfg.subscribeTemplateId],
      success: function (r) {
        if (r[cfg.subscribeTemplateId] === 'accept') {
          wx.showToast({ title: '已开启，欠费会提醒您', icon: 'success' });
        }
      },
      fail: function () {
        wx.showToast({ title: '没开成功，可以到"我的"里再开', icon: 'none' });
      }
    });
  },

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' });
  },

  goBills() {
    wx.reLaunch({ url: '/pages/bills/bills' });
  }
});
