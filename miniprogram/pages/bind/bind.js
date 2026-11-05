// ============================================================
// 绑定户号页：业主/租户认证
//   业主：房号 + 户主姓名（与登记一致）+ 手机号（登记过则必须一致）
//   租户：房号 + 本人姓名 + 本人手机号（必填，方便维修联系）
//   一个微信可以绑定多套房（多房产），绑完可回"我的"里查看/解绑
// ============================================================
const api = require('../../utils/api');
const cfg = require('../../config');

Page({
  data: {
    unit: '',
    roomNo: '',
    ownerName: '',   // 业主=户主姓名；租户=本人姓名
    phone: '',       // 手机号（业主：登记过必须一致；租户：必填）
    role: 'owner',   // owner=业主 tenant=租户
    propertyPhone: cfg.propertyPhone,  // 页面提示用的物业电话
    submitting: false
  },

  onUnit(e) { this.setData({ unit: e.detail.value }); },
  onRoom(e) { this.setData({ roomNo: e.detail.value }); },
  onName(e) { this.setData({ ownerName: e.detail.value }); },
  onPhone(e) { this.setData({ phone: e.detail.value }); },

  // 身份切换：业主 / 租户
  setRole(e) {
    this.setData({ role: e.currentTarget.dataset.role || 'owner' });
  },

  submit() {
    var that = this;
    if (this.data.submitting) return;

    var unit = (this.data.unit || '').trim();
    var roomNo = (this.data.roomNo || '').trim();
    var ownerName = (this.data.ownerName || '').trim();
    var phone = (this.data.phone || '').trim();
    var role = this.data.role;

    if (!unit || !roomNo) {
      wx.showModal({ title: '还差一点', content: '请先把单元号和房号填完整', showCancel: false, confirmText: '好的' });
      return;
    }
    if (!ownerName) {
      wx.showModal({ title: '还差一点', content: '请填写姓名（业主填缴费单上的"户主"）', showCancel: false, confirmText: '好的' });
      return;
    }
    if (role === 'tenant' && phone.replace(/\D/g, '').length < 7) {
      wx.showModal({ title: '还差一点', content: '租户绑定需要填写联系电话，方便物业联系您', showCancel: false, confirmText: '好的' });
      return;
    }

    this.setData({ submitting: true });
    api.post('/api/user/bind', {
      unit: unit,
      roomNo: roomNo,
      ownerName: ownerName,
      phone: phone,
      role: role
    }).then(function (d) {
      that.setData({ submitting: false });
      var app = getApp();
      app.globalData.household = d.household;
      app.globalData.households = d.households || [d.household];
      app.setSelectedHouseholdId(d.household.id);
      var identity = role === 'tenant' ? '租户' : '业主';
      wx.showModal({
        title: '绑定成功',
        content: '已认证为「' + identity + '」：' + d.household.roomLabel +
          '。绑了多套房的话，可以在首页顶部切换房号。',
        showCancel: false,
        confirmText: '好的',
        success: function () { wx.navigateBack(); }
      });
    }).catch(function (err) {
      that.setData({ submitting: false });
      wx.showModal({
        title: (err.agent && err.agent.title) || '绑定没成功',
        content: err.message,
        showCancel: false,
        confirmText: '知道了'
      });
    });
  }
});
