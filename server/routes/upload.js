// ============================================================
// 图片上传接口（报修现场照片用）
// 安全措施：登录才能传；只收 jpg/png（魔数校验）；单张 ≤5MB；
//           文件名随机，存到 server/uploads/ 下由静态服务对外提供
// ============================================================
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { auth } = require('../utils/auth');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const MAX_BYTES = 5 * 1024 * 1024;

router.post('/', auth(), function (req, res) {
  const b = req.body || {};
  const b64 = String(b.base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!b64) return res.json({ ok: false, message: '没有收到图片' });

  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return res.json({ ok: false, message: '图片是空的' });
  if (buf.length > MAX_BYTES) return res.json({ ok: false, message: '图片超过 5MB，请压缩后再试' });

  // 魔数校验：防止把任意文件改名成图片传上来
  const isJpg = buf[0] === 0xFF && buf[1] === 0xD8;
  const isPng = buf[0] === 0x89 && buf[1] === 0x50;
  if (!isJpg && !isPng) return res.json({ ok: false, message: '只支持 jpg / png 图片' });

  try {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const name = 'r' + Date.now() + Math.floor(Math.random() * 9000 + 1000) + (isPng ? '.png' : '.jpg');
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    res.json({ ok: true, data: { url: '/uploads/' + name } });
  } catch (e) {
    res.json({ ok: false, message: '保存失败：' + e.message });
  }
});

module.exports = router;
