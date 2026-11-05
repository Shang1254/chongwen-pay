// ============================================================
// 缴费记录页：待缴的、已缴过的，一目了然
// 已缴的账单点一下可以看电子缴费凭证
// ============================================================
const api = require('../../utils/api');
const util = require('../../utils/util');

Page({
  data: {
    loading: true,
    unpaid: [],
    paid: [],
    roomLabel: '',   // 当前查看的房号（多房产时提示）
    hhCount: 0       // 绑定的房产数
  },

  onShow() {
    this.load();
  },

  onPullDownRefresh() {
    this.load();
  },

  load() {
    var that = this;
    var app = getApp();
    var selId = app.getSelectedHouseholdId();
    api.get('/api/bill/list' + (selId ? '?householdId=' + selId : '')).then(function (d) {
      var pack = function (b) {
        return {
          id: b.id,
          label: util.typeLabel(b.type),
          emoji: util.typeEmoji(b.type),
          period: b.period,
          usage: b.usage,
          amount: util.fmtMoney(b.amount),
          dueDate: util.fmtDate(b.dueDate),
          paidAt: b.paidAt ? String(b.paidAt).slice(0, 10) : '',
          overdueDays: b.overdueDays || 0
        };
      };
      if (d.household) app.setSelectedHouseholdId(d.household.id);
      app.globalData.households = d.households || (d.household ? [d.household] : []);
      that.setData({
        loading: false,
        unpaid: (d.unpaid || []).map(pack),
        paid: (d.paid || []).map(pack),
        roomLabel: d.household ? d.household.roomLabel : '',
        hhCount: (d.households || []).length
      });
      wx.stopPullDownRefresh();
    }).catch(function (err) {
      that.setData({ loading: false });
      wx.stopPullDownRefresh();
      wx.showToast({ title: err.message, icon: 'none' });
    });
  },

  goPay() {
    wx.navigateTo({ url: '/pages/pay/pay' });
  },

  // 查看电子缴费凭证（已缴账单才有）
  goVoucher(e) {
    var id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/voucher/voucher?billId=' + id });
  }
});
