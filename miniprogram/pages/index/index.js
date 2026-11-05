// ============================================================
// 首页：一眼看到要交多少钱，点一下就去交（缴费第 1 步）
// 支持多房产切换：绑了多套房的业主，点房号标签即可切换
// 武汉鼎诚物业 · 崇文兰亭 2号楼试点
// ============================================================
const api = require('../../utils/api');
const util = require('../../utils/util');
const cfg = require('../../config');

Page({
  data: {
    loading: true,
    household: null,                                   // 当前选中的户号
    households: [],                                    // 绑定的全部房产
    selectedId: 0,                                     // 当前选中的户号 id
    electric: { count: 0, amount: '0.00' },            // 电费待缴汇总
    water: { count: 0, amount: '0.00' },               // 水费待缴汇总
    property: { count: 0, amount: '0.00' },            // 物业费待缴汇总
    total: '0.00',                                     // 一共要交多少
    error: '',                                         // 不为空 = 出错了（和"没绑户号"区分开）
    testAccess: true,                                  // 是否已解锁 2 栋试点
    phone: cfg.propertyPhone,
    pilotText: cfg.pilotText,
    priceNotice: cfg.priceNotice,
    companyShort: cfg.companyShort
  },

  onShow() {
    this.init();
  },

  // 下拉刷新（老年用户也会用的"使劲往下拉"习惯）
  onPullDownRefresh() {
    this.init();
  },

  init() {
    var that = this;
    that.setData({ loading: true, error: '' });
    getApp().ensureLogin(function (ok) {
      if (!ok) {
        that.setData({ loading: false, error: '连不上服务器' });
        return;
      }
      that.load();
    });
  },

  // 拉取当前房号的待缴账单汇总（多房产按选中的房号查询）
  load() {
    var that = this;
    var app = getApp();
    var selId = app.getSelectedHouseholdId();
    api.get('/api/bill/list' + (selId ? '?householdId=' + selId : '')).then(function (d) {
      var unpaid = d.unpaid || [];
      var by = function (type) { return unpaid.filter(function (b) { return b.type === type; }); };
      var e = by('electric');
      var w = by('water');
      var p = by('property');
      var sum = function (arr) {
        return arr.reduce(function (s, b) { return s + Number(b.amount); }, 0);
      };
      var households = d.households || (d.household ? [d.household] : []);
      // 后端返回的"当前房号"是权威的：同步回本地选择
      if (d.household) app.setSelectedHouseholdId(d.household.id);
      var testAccess = d.testAccess !== undefined ? !!d.testAccess : !!app.globalData.testAccess;
      that.setData({
        loading: false,
        household: d.household,
        households: households,
        selectedId: d.household ? d.household.id : 0,
        electric: { count: e.length, amount: util.fmtMoney(sum(e)) },
        water: { count: w.length, amount: util.fmtMoney(sum(w)) },
        property: { count: p.length, amount: util.fmtMoney(sum(p)) },
        total: util.fmtMoney(sum(unpaid)),
        testAccess: testAccess
      });
      app.globalData.household = d.household;
      app.globalData.households = households;
      app.globalData.testAccess = testAccess;
      // 老用户本地还存着登录状态时，这里再向服务端确认一次试点权限
      if (d.testAccess === undefined) {
        api.get('/api/user/me').then(function (me) {
          app.globalData.testAccess = !!me.testAccess;
          that.setData({ testAccess: !!me.testAccess });
        }).catch(function () { /* 查不到就按未解锁显示，不影响主流程 */ });
      }
      wx.stopPullDownRefresh();
    }).catch(function (err) {
      that.setData({ loading: false, error: err.message || '加载失败了' });
      wx.stopPullDownRefresh();
    });
  },

  // 多房产切换
  switchHousehold(e) {
    var id = Number(e.currentTarget.dataset.id || 0);
    if (!id || id === this.data.selectedId) return;
    getApp().setSelectedHouseholdId(id);
    this.setData({ loading: true });
    this.load();
  },

  // 出错后手动重试
  retry() {
    this.init();
  },

  // 2栋试点测试入口：输入物业发放的邀请码才能绑定户号
  testEntry() {
    if (this.data.testAccess) {
      wx.showToast({ title: '测试入口已解锁', icon: 'success' });
      return;
    }
    var that = this;
    wx.showModal({
      title: '2栋试点测试入口',
      content: '请输入物业发给您的测试邀请码（只发给2栋测试住户）',
      editable: true,
      placeholderText: '例如：CWLT-2-2026',
      confirmText: '解锁',
      cancelText: '取消',
      success: function (r) {
        if (!r.confirm) return;
        var code = (r.content || '').trim();
        if (!code) {
          wx.showToast({ title: '请先输入邀请码', icon: 'none' });
          return;
        }
        api.post('/api/user/test-entry', { code: code }).then(function (d) {
          getApp().globalData.testAccess = true;
          that.setData({ testAccess: true });
          wx.showModal({
            title: '已解锁',
            content: d.message || '测试入口已解锁，现在可以绑定房号了',
            showCancel: false,
            confirmText: '去绑定',
            success: function () { that.goBind(); }
          });
        }).catch(function (err) {
          wx.showModal({ title: '没解锁成功', content: err.message, showCancel: false, confirmText: '好的' });
        });
      }
    });
  },

  goBind() {
    wx.navigateTo({ url: '/pages/bind/bind' });
  },

  goPay() {
    if (!this.data.household) {
      this.goBind();
      return;
    }
    wx.navigateTo({ url: '/pages/pay/pay' });
  },

  goBills() {
    wx.navigateTo({ url: '/pages/bills/bills' });
  },

  goRepair() {
    wx.navigateTo({ url: '/pages/repair/repair' });
  },

  goProfile() {
    wx.navigateTo({ url: '/pages/profile/profile' });
  }
});
