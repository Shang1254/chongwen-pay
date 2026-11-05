// ============================================================
// 缴费确认页（缴费第 2 步）：勾选账单 → 看清金额 → 点支付
// ============================================================
const api = require('../../utils/api');
const util = require('../../utils/util');

Page({
  data: {
    loading: true,
    bills: [],       // 待缴账单列表（每条带 checked 是否选中）
    roomLabel: '',   // 当前缴的是哪套房（多房产时必须看清）
    total: '0.00',   // 选中的合计
    count: 0,        // 选中几笔
    paying: false    // 正在支付中（防连点）
  },

  onLoad() {
    this.load();
  },

  load() {
    var that = this;
    api.get('/api/bill/list').then(function (d) {
      var bills = (d.unpaid || []).map(function (b) {
        return {
          id: b.id,
          type: b.type,
          label: util.typeLabel(b.type),
          emoji: util.typeEmoji(b.type),
          period: b.period,
          usage: b.usage,
          amount: util.fmtMoney(b.amount),
          dueDate: util.fmtDate(b.dueDate),
          overdueDays: b.overdueDays || 0,
          checked: true   // 默认全选，符合"一键缴完"的习惯
        };
      });
      that.setData({ loading: false, bills: bills, roomLabel: d.household ? d.household.roomLabel : '' });
      that.recalc();
    }).catch(function (err) {
      that.setData({ loading: false });
      wx.showModal({ title: '加载失败', content: err.message, showCancel: false, confirmText: '好的' });
    });
  },

  // 点卡片切换选中
  toggle(e) {
    var id = e.currentTarget.dataset.id;
    var bills = this.data.bills.map(function (b) {
      if (b.id === id) b.checked = !b.checked;
      return b;
    });
    this.setData({ bills: bills });
    this.recalc();
  },

  // 全选 / 全不选
  toggleAll() {
    var all = this.data.bills.every(function (b) { return b.checked; });
    var bills = this.data.bills.map(function (b) { b.checked = !all; return b; });
    this.setData({ bills: bills });
    this.recalc();
  },

  // 重算合计
  recalc() {
    var sum = 0, count = 0;
    this.data.bills.forEach(function (b) {
      if (b.checked) { sum += Number(b.amount); count++; }
    });
    this.setData({ total: util.fmtMoney(sum), count: count });
  },

  // 去支付（缴费第 3 步）
  submit() {
    var that = this;
    if (this.data.paying) return;
    var ids = this.data.bills.filter(function (b) { return b.checked; }).map(function (b) { return b.id; });
    if (!ids.length) {
      wx.showToast({ title: '请先勾选要缴的账单', icon: 'none' });
      return;
    }

    this.setData({ paying: true });
    this.createOrder(ids, false);
  },

  // 支付后确认：问后端这笔钱到底到没到（微信回调可能有几秒延迟）
  confirmPaid(orderNo, fromFail) {
    var that = this;
    wx.showLoading({ title: '正在确认…', mask: true });
    api.post('/api/pay/sync', { orderNo: orderNo }).then(function (r) {
      wx.hideLoading();
      if (r && r.paid) {
        wx.redirectTo({
          url: '/pages/result/result?amount=' + that.data.total + '&count=' + that.data.count +
            '&orderNo=' + orderNo
        });
        return;
      }
      that.setData({ paying: false });
      wx.showModal({
        title: fromFail ? '支付没走完' : '还没收到钱',
        content: fromFail
          ? '如果微信已经扣款，请等 1 分钟后打开"缴费记录"查看；仍不对请联系物业，别重复付款。'
          : '这笔缴费还没到账，可以再点一次"确认缴费"。',
        showCancel: false,
        confirmText: '好的'
      });
    }).catch(function (err) {
      wx.hideLoading();
      that.setData({ paying: false });
      wx.showModal({
        title: '确认失败',
        content: err.message + '\n\n如果微信已经扣款，请不要重复支付，联系物业核对。',
        showCancel: false,
        confirmText: '知道了'
      });
    });
  },

  // 下单：force=true 表示用户已经确认过金额异常提醒，坚持要缴
  createOrder(ids, force) {
    var that = this;
    api.post('/api/pay/create', { billIds: ids, force: force }).then(function (d) {
      if (d.mock) {
        // 演示模式：模拟支付成功
        api.post('/api/pay/mock-notify', { orderNos: d.orderNos }).then(function () {
          wx.redirectTo({
            url: '/pages/result/result?amount=' + that.data.total + '&count=' + that.data.count +
              '&orderNo=' + (d.orderNos && d.orderNos[0] ? d.orderNos[0] : '')
          });
        }).catch(function (err) {
          that.setData({ paying: false });
          wx.showModal({ title: '没成功', content: err.message, showCancel: false, confirmText: '好的' });
        });
        return;
      }
      // ---------- 正式模式：拉起微信收银台 ----------
      wx.requestPayment({
        timeStamp: d.payParams.timeStamp,
        nonceStr: d.payParams.nonceStr,
        package: d.payParams.package,
        signType: d.payParams.signType,
        paySign: d.payParams.paySign,
        success: function () {
          // 付完了，再问后端确认一次是否真的到账（防止回调延迟）
          that.confirmPaid(d.orderNo);
        },
        fail: function (err) {
          var msg = (err && err.errMsg) || '';
          if (msg.indexOf('cancel') > -1) {
            // 居民自己点了取消：不吓唬人，随时可以再点一次
            that.setData({ paying: false });
            wx.showToast({ title: '已取消，可以再试一次', icon: 'none' });
            return;
          }
          // 其他异常：可能钱已扣、回调没回，主动查一次最稳妥
          that.confirmPaid(d.orderNo, true);
        }
      });
      return;
    }).catch(function (err) {
      // 账单校验 Agent 提醒"金额异常"：弹窗让居民自己确认
      if (err.needConfirm) {
        wx.showModal({
          title: (err.agent && err.agent.title) || '请确认',
          content: err.message + '\n\n确认没问题，就点"继续缴费"。',
          confirmText: '继续缴费',
          cancelText: '再看看',
          success: function (r) {
            if (r.confirm) {
              that.createOrder(ids, true);
            } else {
              that.setData({ paying: false });
            }
          }
        });
        return;
      }
      that.setData({ paying: false });
      wx.showModal({
        title: (err.agent && err.agent.title) || '缴费没成功',
        content: err.message,
        showCancel: false,
        confirmText: '知道了'
      });
    });
  }
});
