// ============================================================
// 用户相关接口：登录、业主/租户认证绑定（支持多房产）、解绑
// 认证规则：
//   业主：房号 + 户主姓名必须与物业登记一致；物业登记了手机号的，
//         绑定时填的手机号必须一致（防止冒绑别人家）。
//   租户：房号存在即可绑定，需填本人手机号（联系用），身份记为"租户"。
//   一个微信可以绑定多套房（多房产）。
// ============================================================
const express = require('express');
const router = express.Router();
const config = require('../config');
const { pool } = require('../db/pool');
const tool = require('../utils/tool');
const cryptoUtil = require('../utils/crypto');
const { auth } = require('../utils/auth');
const wechat = require('../services/wechat');
const billCheck = require('../agents/bill-check-agent'); // 【Agent 1：智能账单校验】

function packHousehold(h, role) {
  if (!h) return null;
  return {
    id: h.id,
    building: h.building,
    unit: h.unit,
    room_no: h.room_no,
    owner_name: h.owner_name,
    electric_account: h.electric_account,
    water_account: h.water_account,
    waterBalance: Number(h.water_balance || 0),
    role: role || 'owner',
    roomLabel: h.building + '栋' + h.unit + '单元' + h.room_no + '室'
  };
}

function digits(s) {
  return String(s || '').replace(/\D/g, '');
}

// 查某个微信用户绑定的全部房产（含业主/租户身份）
async function listHouseholds(userId) {
  const [rows] = await pool.query(
    'SELECT h.*, bd.role AS bind_role FROM bindings bd ' +
    'JOIN households h ON h.id = bd.household_id ' +
    'WHERE bd.user_id = ? AND h.status = 1 ORDER BY h.unit, h.room_no',
    [userId]
  );
  return rows.map(function (r) { return packHousehold(r, r.bind_role); });
}

// ---------- 登录：第一次用会自动建档 ----------
router.post('/login', async function (req, res, next) {
  try {
    const body = req.body || {};
    const session = await wechat.code2Session(body.code, body.mockId);

    let [rows] = await pool.query('SELECT * FROM users WHERE openid = ?', [session.openid]);
    let user = rows[0];
    if (!user) {
      const [r] = await pool.query(
        'INSERT INTO users (openid, nickname, role) VALUES (?, ?, ?)',
        [session.openid, session.mock ? '演示用户' : '邻居', 'resident']
      );
      user = { id: r.insertId, openid: session.openid, nickname: session.mock ? '演示用户' : '邻居', role: 'resident' };
    }

    const households = await listHouseholds(user.id);

    res.json({
      ok: true,
      data: {
        token: tool.makeToken(session.openid, user.role),
        user: { id: user.id, nickname: user.nickname },
        household: households[0] || null,
        households: households,
        mockMode: !!session.mock,
        testAccess: !!user.test_access,
        pilotOnly: !!config.pilotOnly
      }
    });
  } catch (e) { next(e); }
});

// ---------- 2号楼试点测试入口：邀请码解锁 ----------
router.post('/test-entry', auth(), async function (req, res, next) {
  try {
    if (!config.pilotOnly) {
      return res.json({ ok: true, data: { testAccess: true, message: '试点限制已关闭，可直接绑定' } });
    }
    const code = String((req.body && req.body.code) || '').trim();
    if (!code) {
      return res.json({ ok: false, message: '请输入物业发给您的测试邀请码' });
    }
    if (code.toUpperCase() !== String(config.testInviteCode).toUpperCase()) {
      return res.json({ ok: false, message: '邀请码不对。试点阶段请向物业索取邀请码（只发给2栋测试住户）' });
    }
    await pool.query('UPDATE users SET test_access = 1 WHERE id = ?', [req.user.id]);
    res.json({ ok: true, data: { testAccess: true, message: '测试入口已解锁，现在可以绑定房号了' } });
  } catch (e) { next(e); }
});

// ---------- 绑定户号：业主/租户认证，支持一户多房产 ----------
router.post('/bind', auth(), async function (req, res, next) {
  try {
    const body = req.body || {};
    const unit = String(body.unit || '').trim();
    const roomNo = String(body.roomNo || '').trim();
    const ownerName = String(body.ownerName || '').trim();
    const phone = String(body.phone || '').trim();
    const role = body.role === 'tenant' ? 'tenant' : 'owner';

    if (!unit || !roomNo || !ownerName) {
      return res.json({ ok: false, message: '请把单元、房号、姓名都填上' });
    }

    // 试点门槛：2号楼测试期，没输邀请码的用户绑不了
    if (config.pilotOnly && !req.user.test_access) {
      return res.json({
        ok: false,
        message: '试点阶段：请先回到首页，点击「2栋试点测试入口」输入物业发放的邀请码，再绑定房号。'
      });
    }

    let h = null;
    if (role === 'tenant') {
      // ---- 租户：房号存在即可，手机号必填（方便维修联系），姓名不与户主比对 ----
      if (digits(phone).length < 7) {
        return res.json({ ok: false, message: '租户绑定需要填写联系电话（方便物业/维修联系您）' });
      }
      const [hs] = await pool.query(
        'SELECT * FROM households WHERE building = ? AND unit = ? AND room_no = ? AND status = 1 LIMIT 1',
        [config.pilotBuilding, unit, roomNo]
      );
      if (!hs[0]) {
        return res.json({ ok: false, message: '没找到 ' + config.pilotBuilding + '栋' + unit + '单元' + roomNo + ' 这户，请核对房号' });
      }
      h = hs[0];
      await billCheck.log('bind', unit + '-' + roomNo + ' 租户绑定', { level: 'ok', message: '租户绑定' }, req.user.id);
    } else {
      // ---- 业主：走 Agent 校验（姓名必须与登记一致、水电户号齐全） ----
      const check = await billCheck.checkBind({ unit: unit, roomNo: roomNo, ownerName: ownerName });
      await billCheck.log('bind', unit + '-' + roomNo + ' ' + ownerName, check, req.user.id);
      if (check.level === 'error') {
        return res.json({ ok: false, message: check.message, agent: check });
      }
      h = check.extra.household;

      // ★ 手机号核验：物业登记了手机号的，必须填一致的号码
      if (h.reg_phone_enc) {
        const regPhone = digits(cryptoUtil.decryptText(h.reg_phone_enc));
        if (!digits(phone)) {
          return res.json({ ok: false, message: '该房号在物业登记了手机号，请填写登记的手机号完成认证' });
        }
        if (digits(phone) !== regPhone) {
          return res.json({ ok: false, message: '手机号与物业登记的不一致。请核对后重试，或到物业前台处理（电话 ' + config.propertyPhone + '）' });
        }
      }
    }

    // 绑定（同一微信同一房号只保留一条记录，重复绑定会更新身份/手机号）
    await pool.query(
      'INSERT INTO bindings (user_id, household_id, role, phone_enc) VALUES (?, ?, ?, ?) ' +
      'ON DUPLICATE KEY UPDATE role = VALUES(role), phone_enc = VALUES(phone_enc)',
      [req.user.id, h.id, role, cryptoUtil.encryptText(phone)]
    );

    const households = await listHouseholds(req.user.id);
    res.json({
      ok: true,
      data: {
        household: packHousehold(h, role),
        households: households,
        warn: (role === 'owner' && false) ? null : null
      }
    });
  } catch (e) { next(e); }
});

// ---------- 我的个人信息（含全部绑定房产） ----------
router.get('/me', auth(), async function (req, res, next) {
  try {
    const households = await listHouseholds(req.user.id);
    res.json({
      ok: true,
      data: {
        user: { id: req.user.id, nickname: req.user.nickname },
        household: households[0] || null,
        households: households,
        mockMode: req.user.openid.indexOf('mock_') === 0,
        testAccess: !!req.user.test_access,
        pilotOnly: !!config.pilotOnly
      }
    });
  } catch (e) { next(e); }
});

// ---------- 解绑：带 householdId 解绑指定房产，不带则全部解绑 ----------
router.post('/unbind', auth(), async function (req, res, next) {
  try {
    const householdId = Number((req.body && req.body.householdId) || 0);
    if (householdId) {
      await pool.query('DELETE FROM bindings WHERE user_id = ? AND household_id = ?', [req.user.id, householdId]);
    } else {
      await pool.query('DELETE FROM bindings WHERE user_id = ?', [req.user.id]);
    }
    res.json({ ok: true, data: {} });
  } catch (e) { next(e); }
});

module.exports = router;
