// ============================================================
// 极简限流中间件（零依赖）
// 作用：防止有人狂刷接口把服务器/数据库压垮，也防登录撞库
// 原理：按 "IP + 接口组" 做固定窗口计数，超了返回 429
// 压测时可设置环境变量 CWLT_DISABLE_RATE_LIMIT=1 临时关闭
// ============================================================
const buckets = new Map();

// 每 5 分钟清一次过期计数，防止 Map 越来越大
setInterval(function () {
  const now = Date.now();
  for (const entry of buckets) {
    if (now - entry[1].start > 10 * 60 * 1000) buckets.delete(entry[0]);
  }
}, 5 * 60 * 1000).unref();

function rateLimit(opts) {
  const windowMs = opts.windowMs || 60 * 1000;
  const max = opts.max || 120;
  const name = opts.name || 'general';

  return function (req, res, next) {
    if (process.env.CWLT_DISABLE_RATE_LIMIT === '1') return next();

    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = xff || req.socket.remoteAddress || 'unknown';
    const key = name + ':' + ip;
    const now = Date.now();

    let b = buckets.get(key);
    if (!b || now - b.start > windowMs) {
      b = { start: now, count: 0 };
      buckets.set(key, b);
    }
    b.count++;

    if (b.count > max) {
      const retry = Math.ceil((b.start + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({ ok: false, message: '操作太频繁，请 ' + retry + ' 秒后再试' });
    }
    next();
  };
}

module.exports = { rateLimit: rateLimit };
