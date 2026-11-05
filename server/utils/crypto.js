// ============================================================
// 本地加密小工具
// 用途：报修联系方式、业主姓名等个人信息落库前先加密；
//       缴费留痕用 HMAC 做防篡改校验。
// 密钥来自 config.dataKey，换密钥后旧数据将无法解密，请谨慎。
// ============================================================
const crypto = require('crypto');
const config = require('../config');

// 把配置里的字符串派生成 32 字节密钥（AES-256 要求这么长）
const KEY = crypto.createHash('sha256').update(String(config.dataKey)).digest();

// ---------- 加密：明文 → "enc:v1:base64(iv+tag+密文)" ----------
function encryptText(plain) {
  if (plain === undefined || plain === null || String(plain) === '') return '';
  const iv = crypto.randomBytes(12);                      // 每次加密都换随机 IV
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();                        // 防篡改标签
  return 'enc:v1:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

// ---------- 解密（不是本系统加密的字符串原样返回） ----------
function decryptText(text) {
  const s = text === undefined || text === null ? '' : String(text);
  if (s.indexOf('enc:v1:') !== 0) return s;
  try {
    const raw = Buffer.from(s.slice(7), 'base64');
    const iv = raw.slice(0, 12);
    const tag = raw.slice(12, 28);
    const data = raw.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) {
    return '';
  }
}

// ---------- 防篡改摘要（同内容永远得到同一个值） ----------
function hmac(text) {
  return crypto.createHmac('sha256', KEY).update(String(text)).digest('hex');
}

// ---------- 姓名打码：张建国 → 张** ----------
function maskName(name) {
  const s = String(name || '');
  if (!s) return '**';
  if (s.length === 1) return s;
  return s[0] + '**';
}

module.exports = {
  encryptText: encryptText,
  decryptText: decryptText,
  hmac: hmac,
  maskName: maskName
};
