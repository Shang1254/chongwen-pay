// ============================================================
// 统一网络请求封装：所有页面都走这里发请求
// 后端地址只存在 app.js 里，换地址只改那一处
// ============================================================

function request(method, url, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: getApp().globalData.apiBase + url,
      method: method,
      data: data || {},
      timeout: 20000,
      header: {
        // 每个请求都带上"通行证"，后端好认人
        Authorization: 'Bearer ' + (wx.getStorageSync('token') || '')
      },
      success(res) {
        // 通行证过期了：清掉重新登录
        if (res.statusCode === 401) {
          getApp().logout();
          wx.reLaunch({ url: '/pages/index/index' });
          reject(new Error('登录已过期，请重试'));
          return;
        }
        if (res.data && res.data.ok) {
          resolve(res.data.data);
          return;
        }
        var err = new Error((res.data && res.data.message) || '服务开小差了，请稍后再试');
        // 账单校验 Agent 的提示原样带给页面，方便弹窗
        if (res.data && res.data.agent) err.agent = res.data.agent;
        // 后端要求"用户确认后重试"（比如金额异常提醒）
        if (res.data && res.data.needConfirm) err.needConfirm = true;
        reject(err);
      },
      fail() {
        reject(new Error('连不上服务器：请先启动后端（双击 server/scripts/start.bat）'));
      }
    });
  });
}

module.exports = {
  get: function (u, d) { return request('GET', u, d); },
  post: function (u, d) { return request('POST', u, d); }
};
