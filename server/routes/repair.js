// ============================================================
// 物业报修接口（业主端）
// 提交时报修人联系电话加密存储；物业在后台查看和处理
// ============================================================
const express = require('express');
const router = express.Router();
const { pool } = require('../db/pool');
const { auth } = require('../utils/auth');
const cryptoUtil = require('../utils/crypto');

const STATUS_LABEL = { pending: '待处理', doing: '处理中', done: '已完成' };

// 把数据库记录整理成小程序好读的样子
function pack(r) {
  return {
    id: r.id,
    category: r.category,
    content: r.content,
    img: r.img_url || '',
    contact: cryptoUtil.decryptText(r.contact_enc), // 自己的联系方式，解密给自己看
    status: r.status,
    statusLabel: STATUS_LABEL[r.status] || r.status,
    feedback: r.feedback || '',
    createdAt: String(r.created_at).slice(0, 19),
    updatedAt: r.updated_at ? String(r.updated_at).slice(0, 19) : ''
  };
}

// ---------- 提交报修 ----------
router.post('/create', auth(), async function (req, res, next) {
  try {
    const b = req.body || {};
    const content = String(b.content || '').trim();
    const category = String(b.category || '其他').trim().slice(0, 30);
    const contact = String(b.contact || '').trim().slice(0, 20);

    if (content.length < 5) {
      return res.json({ ok: false, message: '请把问题描述清楚一点（至少 5 个字），方便物业师傅上门处理' });
    }

    // 顺带记下这户绑定的房子（没绑定也能报修）
    const [hs] = await pool.query(
      'SELECT household_id FROM bindings WHERE user_id = ? LIMIT 1',
      [req.user.id]
    );

    // 现场照片：只接受本系统 /api/upload 返回的路径，防路径穿越
    let imgUrl = '';
    if (b.img && String(b.img).indexOf('/uploads/') === 0 && String(b.img).indexOf('..') < 0) {
      imgUrl = String(b.img).slice(0, 300);
    }

    const [r] = await pool.query(
      'INSERT INTO repair_orders (user_id, household_id, category, content, img_url, contact_enc) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, hs[0] ? hs[0].household_id : null, category, content.slice(0, 500), imgUrl, cryptoUtil.encryptText(contact)]
    );

    res.json({ ok: true, data: { id: r.insertId, message: '报修已提交，物业会尽快联系您' } });
  } catch (e) { next(e); }
});

// ---------- 我的报修记录 ----------
router.get('/my', auth(), async function (req, res, next) {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM repair_orders WHERE user_id = ? ORDER BY id DESC LIMIT 50',
      [req.user.id]
    );
    res.json({ ok: true, data: rows.map(pack) });
  } catch (e) { next(e); }
});

module.exports = router;
