// ============================================================
// 登录校验中间件：每个接口开口子时套一层，就能认出"这是谁"
// ============================================================
const { pool } = require('../db/pool');
const tool = require('./tool');

// 用法：router.get('/xxx', auth(), 处理函数)
//       router.get('/yyy', auth('admin'), 处理函数)  ← 限制只有物业能用
function auth(requiredRole) {
  return async function (req, res, next) {
    try {
      const raw = (req.headers.authorization || '').replace('Bearer ', '');
      const info = tool.parseToken(raw);
      if (!info) {
        return res.status(401).json({ ok: false, message: '请先登录' });
      }
      const [rows] = await pool.query('SELECT * FROM users WHERE openid = ?', [info.openid]);
      if (!rows[0]) {
        return res.status(401).json({ ok: false, message: '请先登录' });
      }
      req.user = rows[0];
      // 需要特定角色（比如物业 admin）但来的人不是 → 拒绝
      if (requiredRole && req.user.role !== requiredRole) {
        return res.status(403).json({ ok: false, message: '没有权限' });
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

module.exports = { auth: auth };
