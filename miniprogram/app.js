// ============================================================
// 小程序全局入口
// ============================================================
const api = require('./utils/api');

App({
  globalData: {
    // 后端地址（★真机调试/预览必看★）：
    // 1. 模拟器：用 127.0.0.1 即可
    // 2. 真机调试/真机预览：手机访问不到电脑的 127.0.0.1，
    //    必须改成电脑的【局域网 IPv4】（cmd 里 ipconfig 查看无线网卡的 IPv4）
    //    并保证：手机和电脑连同一个 Wi-Fi/路由器
    // 当前已设为本机局域网 IP（2026-11-05 ipconfig 查得，换网络后记得改）：
    apiBase: 'http://192.168.101.143:3000',
    user: null,        // 当前登录用户
    household: null,   // 当前选中的户号信息
    households: [],    // 绑定的全部房产（支持多房产）
    serverMock: true,  // 后端是否处于演示模式（登录后由后端告知）
    testAccess: false  // 是否已用邀请码解锁"2栋试点"（没解锁不能绑定）
  },

  // 多房产：当前正在看哪一户（存本地，下次打开还是它）
  getSelectedHouseholdId() {
    return Number(wx.getStorageSync('sel_household') || 0);
  },
  setSelectedHouseholdId(id) {
    wx.setStorageSync('sel_household', Number(id) || 0);
  },

  onLaunch() {
    // 什么都不用干，登录放到页面里按需触发
  },

  // 确保已登录：有"通行证"(token)就直接过，没有就走一遍微信登录
  ensureLogin(cb) {
    if (wx.getStorageSync('token')) {
      cb && cb(true);
      return;
    }
    // 防止多个页面同时触发登录
    if (this._logging) {
      setTimeout(() => this.ensureLogin(cb), 300);
      return;
    }
    this._logging = true;

    // 演示模式下用的"设备身份号"：一台手机一个，存在本地
    // （真实上线后走微信官方登录，这个号就用不到了）
    let mockId = wx.getStorageSync('mock_user_id');
    if (!mockId) {
      mockId = 'dev' + Date.now() + Math.floor(Math.random() * 10000);
      wx.setStorageSync('mock_user_id', mockId);
    }

    wx.login({
      success: (res) => {
        api.post('/api/user/login', { code: res.code, mockId: mockId })
          .then((d) => {
            wx.setStorageSync('token', d.token);
            this.globalData.user = d.user;
            this.globalData.household = d.household;
            this.globalData.households = d.households || (d.household ? [d.household] : []);
            this.globalData.serverMock = !!d.mockMode;
            this.globalData.testAccess = !!d.testAccess;
            this._logging = false;
            cb && cb(true);
          })
          .catch(() => {
            this._logging = false;
            cb && cb(false);
          });
      },
      fail: () => {
        this._logging = false;
        cb && cb(false);
      }
    });
  },

  // 退出登录：清掉本地通行证
  logout() {
    wx.removeStorageSync('token');
    this.globalData.user = null;
    this.globalData.household = null;
    this.globalData.households = [];
    this.globalData.testAccess = false;
  }
});
