// ============================================================
// 物业报修：填问题、拍现场照片、留电话，物业后台处理
// 照片流程：拍照/选图 → 压缩 → base64 上传 → 返回 /uploads/ 路径
// ============================================================
const api = require('../../utils/api');

Page({
  data: {
    categories: ['水龙头/管道漏水', '电路/灯具', '门窗/门锁', '公共区域', '其他'],
    catIndex: 0,
    content: '',
    contact: '',
    imgUrl: '',      // 相对路径（/uploads/xx.jpg），提交时用
    absImg: '',      // 绝对路径（页面预览用）
    submitting: false,
    list: [],
    loading: true
  },

  onShow() {
    this.loadMy();
  },

  // 下拉刷新我的报修
  onPullDownRefresh() {
    this.loadMy();
  },

  onCat(e) { this.setData({ catIndex: Number(e.detail.value) }); },
  onContent(e) { this.setData({ content: e.detail.value }); },
  onContact(e) { this.setData({ contact: e.detail.value }); },

  // 相对路径 → 绝对路径（图片组件需要完整地址）
  absUrl(u) {
    if (!u) return '';
    return u.indexOf('http') === 0 ? u : getApp().globalData.apiBase + u;
  },

  // 拍照 / 从相册选图（自动压缩后再上传，省流量）
  chooseImg() {
    var that = this;
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: function (r) {
        var src = r.tempFiles[0].tempFilePath;
        wx.compressImage({
          src: src,
          quality: 60,
          success: function (c) { that.uploadFile(c.tempFilePath); },
          fail: function () { that.uploadFile(src); } // 老手机不支持压缩就直接传原图
        });
      }
    });
  },

  uploadFile(filePath) {
    var that = this;
    wx.showLoading({ title: '上传照片…', mask: true });
    wx.getFileSystemManager().readFile({
      filePath: filePath,
      encoding: 'base64',
      success: function (r) {
        api.post('/api/upload', { base64: r.data }).then(function (d) {
          wx.hideLoading();
          that.setData({ imgUrl: d.url, absImg: that.absUrl(d.url) });
          wx.showToast({ title: '照片已添加', icon: 'success' });
        }).catch(function (e) {
          wx.hideLoading();
          wx.showModal({ title: '上传失败', content: e.message, showCancel: false, confirmText: '好的' });
        });
      },
      fail: function () {
        wx.hideLoading();
        wx.showToast({ title: '读取照片失败', icon: 'none' });
      }
    });
  },

  delImg() { this.setData({ imgUrl: '', absImg: '' }); },

  previewImg() {
    if (this.data.absImg) wx.previewImage({ urls: [this.data.absImg] });
  },

  previewListItem(e) {
    var url = e.currentTarget.dataset.url;
    if (url) wx.previewImage({ urls: [url] });
  },

  submit() {
    var that = this;
    if (this.data.submitting) return;
    var content = (this.data.content || '').trim();
    if (content.length < 5) {
      wx.showModal({ title: '再写清楚一点', content: '请把问题描述清楚（至少5个字），方便维修师傅上门处理', showCancel: false, confirmText: '好的' });
      return;
    }
    this.setData({ submitting: true });
    api.post('/api/repair/create', {
      category: this.data.categories[this.data.catIndex],
      content: content,
      contact: (this.data.contact || '').trim(),
      img: this.data.imgUrl
    }).then(function (d) {
      that.setData({ submitting: false, content: '', contact: '', imgUrl: '', absImg: '' });
      wx.showModal({ title: '报修已提交', content: d.message || '物业会尽快联系您', showCancel: false, confirmText: '好的' });
      that.loadMy();
    }).catch(function (err) {
      that.setData({ submitting: false });
      wx.showModal({ title: '没提交成功', content: err.message, showCancel: false, confirmText: '知道了' });
    });
  },

  loadMy() {
    var that = this;
    api.get('/api/repair/my').then(function (list) {
      var rows = (list || []).map(function (x) {
        x.img = that.absUrl(x.img); // 列表缩略图用绝对地址
        return x;
      });
      that.setData({ loading: false, list: rows });
      wx.stopPullDownRefresh();
    }).catch(function () {
      that.setData({ loading: false });
      wx.stopPullDownRefresh();
    });
  }
});
