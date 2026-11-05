// ============================================================
// 表格解析：物业后台批量导入欠费账单用
// 支持两种格式：
//   1. .xlsx / .xls —— 需要安装 xlsx 组件（npm install xlsx）
//   2. .csv        —— 不用装任何东西，原生就能解析
// 返回统一格式：{ rows: [[单元格, ...], ...], source: 'xlsx' | 'csv' }
// ============================================================

function bufferFromBase64(base64) {
  const s = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
  return Buffer.from(s, 'base64');
}

// xlsx 本质是 zip，文件头是 PK
function isZip(buf) {
  return buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b;
}

// 简易 CSV 解析（支持引号包起来的逗号、换行，够导账单用了）
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuote = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else { inQuote = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ',') {
      row.push(cur); cur = '';
    } else if (c === '\n') {
      row.push(cur); rows.push(row); row = []; cur = '';
    } else if (c !== '\r') {
      cur += c;
    }
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// 主函数：把上传的文件解析成二维表格
async function parseTable(fileName, base64) {
  const buf = bufferFromBase64(base64);
  if (!buf.length) throw new Error('文件是空的');

  const isExcel = isZip(buf) || /\.xlsx?$/i.test(String(fileName || ''));
  if (isExcel) {
    let XLSX;
    try {
      XLSX = require('xlsx'); // 按需加载：没装也不影响系统其他功能
    } catch (e) {
      throw new Error('服务器还没安装 Excel 解析组件。请在 server 目录执行 npm install xlsx 后重启；或者把表格另存为 CSV 再导入（CSV 不需要装任何东西）');
    }
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) throw new Error('Excel 里没有工作表');
    // raw:true + cellDates:true → 日期单元格是 Date 对象，数字保持数字，解析更准
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
    return { rows: rows, source: 'xlsx' };
  }

  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  return { rows: parseCsv(text), source: 'csv' };
}

module.exports = { parseTable: parseTable };
