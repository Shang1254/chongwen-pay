// ============================================================
// 我的页：多房产列表（业主/租户标识、解绑、切换）、价格公示、客服
// ============================================================
const api = require('../../utils/api');
const cfg = require('../../config');

Page({
  data: {
    households: [],      // 绑定的全部房产
    household: null,     // 当前选中的
    mockMode: true,
    testAccess: false,
    phone: cfg.propertyPhone,
    company: cfg.company,
    community: cfg.community,
    priceNotice: cfg.priceNotice
  },

  onShow() {
    var that = this;
    var app = getApp();
    that.setData({
      households: app.globalData.households || [],
      household: app.globalData.household,
      mockMode: app.globalData.serverMock,
      testAccess: !!app.globalData.testAccess
    });
    app.ensureLogin(function (ok) {
      if (!ok) return;
      // 每次进来都刷新一遍（绑定/解绑/缴费后数据可能变了）
      api.get('/api/user/me').then(function (d) {
        app.globalData.households = d.households || [];
        app.globalData.household = d.household || null;
        app.globalData.testAccess = !!d.testAccess;
        that.setData({
          households: app.globalData.households,
          household: app.globalData.household,
          mockMode: !!d.mockMode,
          testAccess: !!d.testAccess
        });
      }).catch(function () { /* 安静处理 */ });
    });
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind/bind' });
  },

  goBills() {
    wx.navigateTo({ url: '/pages/bills/bills' });
  },

  goRepair() {
    wx.navigateTo({ url: '/pages/repair/repair' });
  },

  // 回首页并把选中房号切到这一户（多房产切换入口）
  goHomeFor(e) {
    var id = Number(e.currentTarget.dataset.id || 0);
    if (id) getApp().setSelectedHouseholdId(id);
    wx.reLaunch({ url: '/pages/index/index' });
  },

  // 解绑某一套房（不影响其他房）
  unbindHousehold(e) {
    var that = this;
    var id = Number(e.currentTarget.dataset.id || 0);
    if (!id) return;
    wx.showModal({
      title: '确定解绑这套房吗？',
      content: '解绑后将看不到这套房的账单；其他绑定的房产不受影响。',
      confirmText: '确定解绑',
      cancelText: '再想想',
      confirmColor: '#C62828',
      success: function (r) {
        if (!r.confirm) return;
        api.post('/api/user/unbind', { householdId: id }).then(function () {
          var left = that.data.households.filter(function (h) { return h.id !== id; });
          getApp().globalData.households = left;
          getApp().globalData.household = left[0] || null;
          getApp().setSelectedHouseholdId(left[0] ? left[0].id : 0);
          that.setData({ households: left, household: left[0] || null });
          wx.showToast({ title: '已解绑', icon: 'success' });
        }).catch(function (err) {
          wx.showModal({ title: '没成功', content: err.message, showCancel: false, confirmText: '好的' });
        });
      }
    });
  },

  // 拨打物业电话
  callProperty() {
    wx.makePhoneCall({ phoneNumber: cfg.propertyPhone });
  },

  // 开启欠费提醒：微信官方"订阅消息"，需要物业在公众平台申请模板后填模板 ID
  // 居民授权一次 = 收到一次提醒；下次提醒前最好再引导授权（微信官方规则）
  subscribeRemind() {
    if (!cfg.subscribeTemplateId) {
      wx.showModal({
        title: '欠费提醒',
        content: '物业还没开通推送服务，开通后在这里点一下，欠费时微信就会提醒您。',
        showCancel: false,
        confirmText: '好的'
      });
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: [cfg.subscribeTemplateId],
      success: function (r) {
        if (r[cfg.subscribeTemplateId] === 'accept') {
          wx.showToast({ title: '已开启，欠费会提醒您', icon: 'success' });
        }
      },
      fail: function () {
        wx.showToast({ title: '没开成功，请再试一次', icon: 'none' });
      }
    });
  },

  // 查看用户隐私保护指引
  openPrivacy() {
    if (wx.openPrivacyContract) {
      wx.openPrivacyContract({
        fail: function () {
          wx.showToast({ title: '暂时打不开，请稍后再试', icon: 'none' });
        }
      });
    } else {
      wx.showToast({ title: '当前微信版本太旧，请升级微信', icon: 'none' });
    }
  }
});
