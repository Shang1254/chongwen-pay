// ============================================================
// 物业端逻辑 v4（产品化重构版）
// 侧边栏分组导航 + 工作台（今日待办/本月进度）+ 抄表向导
// + 住户档案（新增/搜索/编辑）+ 收费管理（筛选/退款/对账）
// 纯原生 JS，浏览器直接跑
// ============================================================

var TOKEN = localStorage.getItem('cwlt_admin_token') || '';

// ---------- 通用工具 ----------
function api(path, method, body) {
  return fetch('/api/admin' + path, {
    method: method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + TOKEN
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(function (r) {
    if (r.status === 401) { showLogin(); throw new Error('登录已过期，请重新登录'); }
    return r.json();
  }).then(function (res) {
    if (!res.ok) throw new Error(res.message || '请求失败');
    return res.data;
  });
}

function $(id) { return document.getElementById(id); }
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}
function money(n) { return Number(n || 0).toFixed(2); }
function pad2(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function monthStr() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
}
function daysLater(n) {
  var d = new Date();
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function downloadText(fileName, text) {
  var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ---------- 分页条（共享组件：首页/上一页/页码/下一页/末页/跳页/每页条数） ----------
// st: {total, page, pageSize, totalPages}；onPage(页码)、onSize(每页条数) 由各列表注入
function renderPager(elId, st, onPage, onSize) {
  var el = $(elId);
  if (!el) return;
  el._onPage = onPage;
  el._onSize = onSize;

  function btn(page, label, disabled) {
    if (disabled) return '<button class="btn plain small" disabled>' + label + '</button> ';
    return '<button class="btn plain small" onclick="pagerGo(\'' + elId + '\',' + page + ')">' + label + '</button> ';
  }

  // 页码窗口：当前页前后各 2 页，最多 5 个数字
  var start = Math.max(1, Math.min(st.page - 2, st.totalPages - 4));
  var end = Math.min(st.totalPages, start + 4);

  var html = '<span class="muted">共 ' + st.total + ' 条 · 第 ' + st.page + ' / ' + st.totalPages + ' 页</span> ';
  html += btn(1, '首页', st.page <= 1);
  html += btn(st.page - 1, '上一页', st.page <= 1);
  for (var i = start; i <= end; i++) {
    html += '<button class="btn small ' + (i === st.page ? 'green' : 'plain') + '" onclick="pagerGo(\'' + elId + '\',' + i + ')">' + i + '</button> ';
  }
  html += btn(st.page + 1, '下一页', st.page >= st.totalPages);
  html += btn(st.totalPages, '末页', st.page >= st.totalPages);
  html += ' <label class="muted">跳至 <input id="' + elId + '-jump" type="number" min="1" max="' + st.totalPages +
    '" style="width:64px;height:32px;border:2px solid #C5D4E8;border-radius:6px;padding:0 6px"> 页</label>';
  html += ' <select id="' + elId + '-size" class="filter-input">' +
    [20, 50, 100].map(function (n) {
      return '<option' + (n === st.pageSize ? ' selected' : '') + '>' + n + '</option>';
    }).join('') + '</select>';
  el.innerHTML = html;

  var jump = $(elId + '-jump');
  jump.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') pagerGo(elId, Number(jump.value) || 1);
  });
  var size = $(elId + '-size');
  size.addEventListener('change', function () { pagerSize(elId, Number(size.value)); });
}

window.pagerGo = function (elId, page) {
  var el = $(elId);
  if (el && el._onPage) el._onPage(Math.max(1, page));
};
window.pagerSize = function (elId, size) {
  var el = $(elId);
  if (el && el._onSize) el._onSize(size);
};

// ---------- 登录 / 退出 ----------
function showLogin() { hide($('main-view')); show($('login-view')); }
function showMain() { hide($('login-view')); show($('main-view')); loadOverview(); updateSideStatus(); }

// 侧边栏"服务状态"卡：每 60 秒自动刷新，出问题物业一眼能看到
function updateSideStatus() {
  fetch('/api/health').then(function (r) { return r.json(); }).then(function (h) {
    $('side-db').textContent = h.db ? '● 正常' : '● 异常';
    $('side-db').className = h.db ? 'dot-on' : 'dot-off';
    $('side-mode').textContent = h.mockMode ? '演示模式' : '正式模式';
  }).catch(function () {
    $('side-db').textContent = '● 未连接';
    $('side-db').className = 'dot-off';
  });
}
setInterval(updateSideStatus, 60 * 1000);

$('login-btn').onclick = function () {
  $('login-msg').textContent = '';
  fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: $('login-user').value.trim(), password: $('login-pass').value })
  }).then(function (r) { return r.json(); }).then(function (res) {
    if (!res.ok) { $('login-msg').textContent = res.message; return; }
    TOKEN = res.data.token;
    localStorage.setItem('cwlt_admin_token', TOKEN);
    window._cwltCfg = { community: res.data.community || '崇文兰亭', company: res.data.company || '武汉鼎诚物业' };
    if (res.data.mockMode) show($('mock-badge'));
    showMain();
  }).catch(function (e) { $('login-msg').textContent = '连不上服务器：' + e.message; });
};

$('login-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('login-btn').click(); });

$('logout-btn').onclick = function () {
  TOKEN = '';
  localStorage.removeItem('cwlt_admin_token');
  showLogin();
};

// ---------- 侧边栏导航 ----------
var TITLES = {
  overview: '工作台', unpaid: '欠费名单', orders: '收款记录', regulatory: '监管留痕',
  wizard: '抄表向导', import: '批量导入', repairs: '报修处理',
  'repair-board': '报修看板', 'collection-board': '缴费看板',
  households: '住户档案', adminlogs: '操作日志', usage: '用量分析'
};

function activateTab(tab) {
  document.querySelectorAll('.side-item').forEach(function (b) {
    b.classList.toggle('on', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab').forEach(function (t) { hide(t); });
  show($('tab-' + tab));
  $('page-title').textContent = TITLES[tab] || tab;

  if (tab === 'overview') loadOverview();
  if (tab === 'unpaid') loadUnpaid();
  if (tab === 'orders') loadOrders();
  if (tab === 'repairs') loadRepairs();
  if (tab === 'repair-board') loadRepairBoard();
  if (tab === 'collection-board') loadCollectionBoard();
  if (tab === 'households') loadHouseholds();
  if (tab === 'usage') loadUsage($('usage-period').value);
  if (tab === 'adminlogs') loadAdminLogs();
  if (tab === 'regulatory') loadRegulatory($('rg-month').value);
}

// 侧边栏点击
document.querySelectorAll('.side-item').forEach(function (btn) {
  btn.onclick = function () { activateTab(btn.dataset.tab); };
});

// 统计卡片 / 快捷按钮跳转
window.goto = function (tab) { activateTab(tab); };

// ---------- 工作台 ----------
function loadOverview() {
  api('/overview').then(function (d) {
    $('st-unpaid-cnt').textContent = d.unpaidCount;
    $('st-unpaid-amt').textContent = money(d.unpaidAmount);
    $('st-overdue').textContent = d.overdueCount;
    $('st-repair').textContent = d.repairPending != null ? d.repairPending : '-';
    $('st-today').textContent = money(d.todayPaidAmount);
    $('st-notify').textContent = d.todayNotifies;
    $('st-bound').textContent = d.boundResidents;
    $('side-today').textContent = '¥' + money(d.todayPaidAmount);
    $('latest-report').textContent = d.latestReport
      ? d.latestReport.date + ' 汇总：未缴 ' + d.latestReport.unpaidCount + ' 笔 / ¥' + money(d.latestReport.unpaidAmount)
      : '还没有汇总（每早 8 点自动生成）';

    // 本月录入进度条
    var mp = d.monthProgress || { households: 0, electric: 0, water: 0, property: 0 };
    var rows = [
      { label: '⚡ 电费', done: mp.electric },
      { label: '💧 水费', done: mp.water },
      { label: '🏢 物业费', done: mp.property }
    ];
    var html = rows.map(function (r) {
      var pctv = mp.households ? Math.round(r.done / mp.households * 100) : 0;
      return '<div class="progress-row">' +
        '<div class="progress-label"><span>' + r.label + '</span><span>' + r.done + ' / ' + mp.households + ' 户（' + pctv + '%）</span></div>' +
        '<div class="progress-bar' + (pctv >= 100 ? ' full' : '') + '"><div style="width:' + pctv + '%"></div></div>' +
        '</div>';
    }).join('');
    $('wb-progress').innerHTML = html;
  }).catch(function (e) { $('latest-report').textContent = e.message; });

  // 今日待办：逾期账单 TOP5（按逾期天数倒序，服务端筛选） + 待处理报修
  api('/unpaid?overdue=1&sort=overdue&pageSize=5').then(function (d) {
    var rows = d.rows || [];
    $('wb-overdue-n').textContent = d.total;
    $('wb-overdue').innerHTML = rows.length
      ? rows.map(function (b) {
          return '<div class="todo-item"><span>' + esc(b.roomLabel) + ' ' + esc(b.typeLabel) + ' ' + b.period +
            '</span><span class="red">逾期 ' + b.overdueDays + ' 天 · ¥' + money(b.amount) + '</span></div>';
        }).join('')
      : '<span class="muted">没有逾期，很省心 👍</span>';
  }).catch(function (e) { $('wb-overdue').textContent = e.message; });

  api('/repairs').then(function (list) {
    var pending = list.filter(function (r) { return r.status !== 'done'; }).slice(0, 5);
    $('wb-repairs-n').textContent = list.filter(function (r) { return r.status !== 'done'; }).length;
    $('wb-repairs').innerHTML = pending.length
      ? pending.map(function (r) {
          return '<div class="todo-item"><span>' + esc(r.roomLabel) + ' ' + esc(r.category) +
            '</span><span>' + esc(r.content.slice(0, 16)) + '…</span></div>';
        }).join('')
      : '<span class="muted">没有待处理报修 👍</span>';
  }).catch(function (e) { $('wb-repairs').textContent = e.message; });
}

$('run-remind').onclick = function () {
  $('agent-result').textContent = '执行中…';
  api('/run-agent', 'POST', { name: 'remind' }).then(function (d) {
    $('agent-result').textContent = '✅ ' + d.message;
  }).catch(function (e) { $('agent-result').textContent = '❌ ' + e.message; });
};
$('run-usage').onclick = function () {
  $('agent-result').textContent = '执行中…';
  api('/run-agent', 'POST', { name: 'usage' }).then(function (d) {
    $('agent-result').textContent = '✅ ' + d.message;
  }).catch(function (e) { $('agent-result').textContent = '❌ ' + e.message; });
};

// 一键催缴（工作台和欠费名单共用）
function pushUnpaidNow(btn) {
  if (!confirm('给所有欠费的已绑定住户推送一次催缴消息？')) return;
  if (btn) btn.disabled = true;
  api('/push-unpaid', 'POST', {}).then(function (d) {
    alert('✅ ' + d.message);
  }).catch(function (e) { alert('❌ ' + e.message); }).finally(function () {
    if (btn) btn.disabled = false;
    loadOverview();
  });
}
$('wb-push').onclick = function () { pushUnpaidNow(this); };

// ---------- 欠费名单（服务端分页 + 筛选：数据量大也流畅） ----------
var unpaidCache = [];
var unpaidState = { page: 1, pageSize: 20, total: 0, totalPages: 1 };

function unpaidQuery() {
  var p = new URLSearchParams();
  p.set('page', unpaidState.page);
  p.set('pageSize', unpaidState.pageSize);
  var kw = $('f-room').value.trim();
  var unit = $('f-unit').value;
  var type = $('f-type').value;
  if (kw) p.set('keyword', kw);
  if (unit) p.set('unit', unit);
  if (type) p.set('type', type);
  if ($('f-overdue').checked) p.set('overdue', '1');
  return p.toString();
}

function loadUnpaid() {
  api('/unpaid?' + unpaidQuery()).then(function (d) {
    unpaidCache = d.rows || [];
    unpaidState = { page: d.page, pageSize: d.pageSize, total: d.total, totalPages: d.totalPages };
    renderUnpaid();
    renderPager('unpaid-pager', unpaidState,
      function (p) { unpaidState.page = p; loadUnpaid(); },
      function (s) { unpaidState.pageSize = s; unpaidState.page = 1; loadUnpaid(); });
  }).catch(function (e) {
    $('unpaid-body').innerHTML = '<tr><td colspan="8" class="red">' + esc(e.message) + '</td></tr>';
    $('unpaid-pager').innerHTML = '';
  });
}

function renderUnpaid() {
  var html = unpaidCache.map(function (b) {
    var ops = '<button class="btn plain small" onclick="offlinePay(' + b.id + ',\'cash\')">现金</button> ' +
              '<button class="btn plain small" onclick="offlinePay(' + b.id + ',\'pos\')">POS</button>';
    return '<tr>' +
      '<td>' + esc(b.roomLabel) + '</td>' +
      '<td>' + esc(b.ownerName) + '</td>' +
      '<td>' + esc(b.typeLabel) + '</td>' +
      '<td>' + b.period + '</td>' +
      '<td>¥' + money(b.amount) + '</td>' +
      '<td>' + b.dueDate + '</td>' +
      '<td class="' + (b.overdueDays > 0 ? 'red' : '') + '">' + (b.overdueDays > 0 ? '逾期 ' + b.overdueDays + ' 天' : '-') + '</td>' +
      '<td>' + ops + '</td>' +
      '</tr>';
  }).join('');
  $('unpaid-body').innerHTML = html ||
    '<tr><td colspan="8" class="muted">' + (unpaidState.total ? '本页没有数据' : '太好了，没有欠费记录') + '</td></tr>';
}

// 查询/重置/回车触发
$('f-search').onclick = function () { unpaidState.page = 1; loadUnpaid(); };
$('f-reset').onclick = function () {
  $('f-room').value = '';
  $('f-unit').value = '';
  $('f-type').value = '';
  $('f-overdue').checked = false;
  unpaidState.page = 1;
  loadUnpaid();
};
$('f-room').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('f-search').click(); });

$('export-csv').onclick = function () {
  // 导出当前筛选条件下的全部记录（all=1 不分页，上限 2000 条）
  api('/unpaid?all=1&' + unpaidQuery()).then(function (d) {
    var rows = [['房号', '户主', '类型', '账期', '金额', '到期日', '逾期天数']];
    (d.rows || []).forEach(function (b) {
      rows.push([b.roomLabel, b.ownerName, b.typeLabel, b.period, money(b.amount), b.dueDate, b.overdueDays]);
    });
    downloadText('欠费名单_' + todayStr() + '.csv',
      '\ufeff' + rows.map(function (r) { return r.join(','); }).join('\r\n'));
    alert('✅ 已导出 ' + (d.rows || []).length + ' 条（当前筛选条件下的全部记录）');
  }).catch(function (e) { alert('❌ ' + e.message); });
};

$('push-unpaid').onclick = function () { pushUnpaidNow(this); };

// 线下兜底收款登记（前台现金/POS）
window.offlinePay = function (billId, channel) {
  var label = channel === 'pos' ? 'POS刷卡' : '现金';
  if (!confirm('确认已当面收到「' + label + '」款项并登记入账？\n登记后自动销账、生成电子凭证、计入对账文件。')) return;
  api('/offline-pay', 'POST', { billIds: [billId], channel: channel }).then(function (d) {
    alert('✅ ' + d.message);
    loadUnpaid();
    loadOverview();
  }).catch(function (e) { alert('❌ ' + e.message); });
};

// ---------- 收款记录（服务端分页 + 筛选：日期/状态/关键词） ----------
var orderCache = [];
var orderState = { page: 1, pageSize: 20, total: 0, totalPages: 1 };

function ordersQuery() {
  var p = new URLSearchParams();
  p.set('page', orderState.page);
  p.set('pageSize', orderState.pageSize);
  var date = $('o-date').value;
  var status = $('o-status').value;
  var kw = $('o-kw').value.trim();
  if (date) p.set('date', date);
  if (status) p.set('status', status);
  if (kw) p.set('keyword', kw);
  return p.toString();
}

function loadOrders() {
  api('/orders?' + ordersQuery()).then(function (d) {
    orderCache = d.rows || [];
    orderState = { page: d.page, pageSize: d.pageSize, total: d.total, totalPages: d.totalPages };
    renderOrders();
    renderPager('orders-pager', orderState,
      function (p) { orderState.page = p; loadOrders(); },
      function (s) { orderState.pageSize = s; orderState.page = 1; loadOrders(); });
  }).catch(function (e) {
    $('orders-body').innerHTML = '<tr><td colspan="10" class="red">' + esc(e.message) + '</td></tr>';
    $('orders-pager').innerHTML = '';
  });
}

function renderOrders() {
  var html = orderCache.map(function (o) {
    var refundCell = o.refundStatus
      ? '<span class="' + (o.refundStatus === 'refunded' ? 'red' : 'muted') + '">' +
        (o.refundStatus === 'refunded' ? '已退款 ¥' + money(o.refundAmount) : '退款中') + '</span>'
      : '-';
    var ops = '-';
    if (o.status === 'success' && !o.refundStatus) {
      ops = '<button class="btn plain small" onclick="refundOrder(\'' + o.orderNo + '\')">退款</button>';
    }
    if (o.refundStatus === 'refunding') {
      ops = '<button class="btn plain small" onclick="refundCheck(\'' + o.orderNo + '\')">查询退款</button>';
    }
    return '<tr>' +
      '<td>' + esc(o.createdAt) + '</td>' +
      '<td>' + esc(o.rooms) + '</td>' +
      '<td>' + esc(o.typeLabel) + '</td>' +
      '<td>¥' + money(o.amount) + '</td>' +
      '<td class="' + (o.status === 'success' ? 'blue' : 'muted') + '">' + esc(o.statusLabel) + '</td>' +
      '<td>' + esc(o.payMode) + '</td>' +
      '<td>' + esc(o.transactionId || '-') + '</td>' +
      '<td>' + esc(o.voucherNo || '-') + '</td>' +
      '<td>' + refundCell + '</td>' +
      '<td>' + ops + '</td>' +
      '</tr>';
  }).join('');
  $('orders-body').innerHTML = html ||
    '<tr><td colspan="10" class="muted">' + (orderState.total ? '本页没有数据' : '还没有缴费记录') + '</td></tr>';
}

$('o-search').onclick = function () { orderState.page = 1; loadOrders(); };
$('o-reset').onclick = function () {
  $('o-date').value = '';
  $('o-status').value = '';
  $('o-kw').value = '';
  orderState.page = 1;
  loadOrders();
};
$('o-kw').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('o-search').click(); });

$('orders-refresh').onclick = loadOrders;

window.refundOrder = function (orderNo) {
  var reason = window.prompt('退款原因（原路退回；对应账单恢复为待缴）：', '业主重复缴费/多缴退回');
  if (reason === null) return;
  api('/refund', 'POST', { orderNo: orderNo, reason: reason }).then(function (d) {
    alert('✅ ' + d.message);
    loadOrders();
    loadOverview();
  }).catch(function (e) { alert('❌ ' + e.message); });
};

window.refundCheck = function (orderNo) {
  api('/refund-check', 'POST', { orderNo: orderNo }).then(function (d) {
    alert('✅ ' + d.message);
    loadOrders();
  }).catch(function (e) { alert('❌ ' + e.message); });
};

$('settlement-btn').onclick = function () {
  var date = $('stl-date').value || todayStr();
  api('/settlement?date=' + date).then(function (d) {
    downloadText(d.fileName, d.csv);
    alert('✅ 已导出 ' + d.count + ' 笔：实收 ¥' + money(d.summary.totalPay) +
      '，退款 ¥' + money(d.summary.totalRefund) + '，净额 ¥' + money(d.summary.net));
  }).catch(function (e) { alert('❌ ' + e.message); });
};

// ---------- 抄表向导 ----------
var wzCache = { rows: [], price: 0 };

$('wz-load').onclick = function () {
  var unit = $('wz-unit').value;
  var type = $('wz-type').value;
  var period = $('wz-period').value;
  if (!period) { alert('请选择账期'); return; }
  $('wz-info').textContent = '调取中…';
  api('/reading-sheet?unit=' + unit + '&type=' + type + '&period=' + period).then(function (d) {
    wzCache = d;
    $('wz-info').textContent = '✅ ' + unit + '单元 ' + (type === 'electric' ? '电费' : '水费') +
      ' ' + d.period + '，单价 ¥' + d.price + '，共 ' + d.rows.length + ' 户（已保存的行会标注）';
    show($('wz-table'));
    show($('wz-save'));
    $('wz-body').innerHTML = d.rows.map(function (r) {
      return '<tr>' +
        '<td>' + esc(r.room) + '室</td>' +
        '<td>' + esc(r.owner) + '</td>' +
        '<td>' + r.prev + '</td>' +
        '<td><input class="wz-reading" type="number" data-hid="' + r.householdId + '" data-prev="' + r.prev + '" value="' + (r.curr === '' ? '' : r.curr) + '" placeholder="本次读数"></td>' +
        '<td class="wz-amount" id="amt-' + r.householdId + '">-</td>' +
        '<td>' + (r.saved ? '<span class="saved-chip">' + r.status + '</span>' : '<span class="muted">未录</span>') + '</td>' +
        '</tr>';
    }).join('');
    // 输入时实时估算金额
    document.querySelectorAll('.wz-reading').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var prev = Number(inp.dataset.prev);
        var curr = Number(inp.value);
        var amtEl = $('amt-' + inp.dataset.hid);
        if (inp.value !== '' && isFinite(curr) && curr >= prev) {
          amtEl.textContent = '¥' + money((curr - prev) * d.price);
        } else {
          amtEl.textContent = inp.value !== '' ? '读数异常' : '-';
        }
      });
    });
  }).catch(function (e) {
    $('wz-info').textContent = '❌ ' + e.message;
  });
};

$('wz-save').onclick = function () {
  var rows = [];
  document.querySelectorAll('.wz-reading').forEach(function (inp) {
    if (inp.value !== '') rows.push({ householdId: Number(inp.dataset.hid), reading: inp.value });
  });
  if (!rows.length) { alert('请至少填写一户的本次读数'); return; }
  if (!confirm('保存 ' + rows.length + ' 户的抄表读数？')) return;
  $('wz-save').disabled = true;
  api('/reading-save', 'POST', {
    unit: $('wz-unit').value,
    type: $('wz-type').value,
    period: $('wz-period').value,
    dueDate: $('wz-due').value,
    rows: rows
  }).then(function (d) {
    $('wz-save').disabled = false;
    var msg = '✅ 保存 ' + d.saved + ' 户，跳过 ' + d.skipped + ' 户';
    if (d.errors && d.errors.length) msg += '；异常：' + d.errors.join('；');
    $('wz-result').textContent = msg;
    $('wz-result').style.color = d.errors.length ? '#E67E22' : '#2F855A';
    $('wz-load').click(); // 重新调出，刷新保存状态
  }).catch(function (e) {
    $('wz-save').disabled = false;
    $('wz-result').textContent = '❌ ' + e.message;
  });
};

// ---------- 物业费录入 ----------
$('pb-submit').onclick = function () {
  $('pb-result').textContent = '';
  $('pb-result').style.color = '';
  api('/addproperty', 'POST', {
    unit: $('pb-unit').value.trim(),
    roomNo: $('pb-room').value.trim(),
    period: $('pb-period').value,
    amount: $('pb-amount').value.trim(),
    dueDate: $('pb-due').value
  }).then(function (d) {
    $('pb-result').textContent = '✅ ' + d.message + '（面积 ' + d.area + '㎡）';
    $('pb-result').style.color = '#2F855A';
  }).catch(function (e) {
    $('pb-result').textContent = '❌ ' + e.message;
  });
};

// ---------- 批量导入 ----------
$('template-btn').onclick = function () {
  var csv = '\ufeff单元,房号,户主,费用类型,账期,金额,用量,到期日\r\n' +
    '1,101,张建国,电费,' + monthStr() + ',44.00,80,' + daysLater(30) + '\r\n' +
    '1,101,张建国,水费,' + monthStr() + ',27.60,8,' + daysLater(30) + '\r\n' +
    '1,101,张建国,物业费,' + monthStr() + ',108.00,,' + daysLater(30) + '\r\n';
  downloadText('账单导入模板.csv', csv);
};

$('imp-file').addEventListener('change', function (e) {
  var f = e.target.files[0];
  if (!f) return;
  var reader = new FileReader();
  reader.onload = function () {
    var base64 = String(reader.result || '').split(',')[1] || '';
    $('imp-result').textContent = '正在导入 ' + f.name + '（' + Math.round(f.size / 1024) + ' KB）…';
    $('imp-result').style.color = '#6B7A8C';
    hide($('imp-table'));
    api('/import-excel', 'POST', { fileName: f.name, base64: base64 }).then(function (d) {
      var color = d.fail ? '#E67E22' : '#2F855A';
      $('imp-result').textContent = '✅ 导入完成（' + (d.source === 'xlsx' ? 'Excel' : 'CSV') + '）：共 ' +
        d.total + ' 行，成功 ' + d.ok + ' 行，失败 ' + d.fail + ' 行';
      $('imp-result').style.color = color;
      var rows = (d.results || []).map(function (r) {
        return '<tr><td>' + esc(r.line) + '</td><td class="' + (r.ok ? 'blue' : 'red') + '">' + (r.ok ? '成功' : '失败') +
          '</td><td class="wrap">' + esc(r.message) + (r.warn ? '（⚠️ ' + esc(r.warn) + '）' : '') + '</td></tr>';
      }).join('');
      $('imp-body').innerHTML = rows || '<tr><td colspan="3" class="muted">没有数据行</td></tr>';
      show($('imp-table'));
    }).catch(function (err) {
      $('imp-result').textContent = '❌ ' + err.message;
      $('imp-result').style.color = '#C62828';
    });
  };
  reader.readAsDataURL(f);
  e.target.value = '';
});

// ---------- 报修处理 ----------
function loadRepairs() {
  api('/repairs').then(function (list) {
    var html = list.map(function (r) {
      var actions = '';
      if (r.status === 'pending') actions += '<button class="btn plain small" onclick="setRepair(' + r.id + ',\'doing\')">开始处理</button> ';
      if (r.status !== 'done') actions += '<button class="btn green small" onclick="setRepair(' + r.id + ',\'done\')">已完成</button>';
      if (r.status === 'done') actions = '<span class="muted">已办结</span>';
      var tel = r.contact ? '<a href="tel:' + esc(r.contact) + '">' + esc(r.contact) + '</a>' : '-';
      return '<tr>' +
        '<td>' + esc(r.createdAt) + '</td>' +
        '<td>' + esc(r.roomLabel) + '</td>' +
        '<td>' + esc(r.category) + '</td>' +
        '<td class="wrap">' + esc(r.content) + (r.img ? ' <a href="' + esc(r.img) + '" target="_blank">📷 照片</a>' : '') + '</td>' +
        '<td>' + tel + '</td>' +
        '<td class="' + (r.status === 'done' ? 'blue' : 'red') + '">' + esc(r.statusLabel) + '</td>' +
        '<td>' + actions + '</td>' +
        '</tr>';
    }).join('');
    $('repairs-body').innerHTML = html || '<tr><td colspan="7" class="muted">暂时没有报修</td></tr>';
  }).catch(function (e) {
    $('repairs-body').innerHTML = '<tr><td colspan="7" class="red">' + esc(e.message) + '</td></tr>';
  });
}
$('repairs-refresh').onclick = loadRepairs;

window.setRepair = function (id, status) {
  var fb = window.prompt('给业主的回复（可留空）：', '');
  if (fb === null) return;
  api('/repair-status', 'POST', { id: id, status: status, feedback: fb }).then(function (d) {
    alert('✅ ' + d.message);
    loadRepairs();
  }).catch(function (e) { alert('❌ ' + e.message); });
};

// ---------- 住户档案（搜索 + 新增 + 编辑） ----------
var hhCache = [];

function loadHouseholds() {
  api('/households').then(function (list) {
    hhCache = list;
    $('hh-count').textContent = list.length;
    renderHouseholds();
  }).catch(function (e) {
    $('hh-body').innerHTML = '<tr><td colspan="8" class="red">' + esc(e.message) + '</td></tr>';
  });
}

function renderHouseholds() {
  var kw = $('hh-search').value.trim();
  var list = hhCache.filter(function (h) {
    return !kw || (h.roomLabel + h.ownerName).indexOf(kw) >= 0;
  });
  var html = list.map(function (h) {
    var owe = h.owe || { electric: { amount: 0 }, water: { amount: 0 }, property: { amount: 0 }, total: 0, count: 0 };
    function oweCell(v) {
      return v.amount > 0 ? '<span class="red">¥' + money(v.amount) + '</span>' : '<span class="muted">-</span>';
    }
    var oweHtml =
      '<div class="owe-line">⚡' + oweCell(owe.electric.amount) + '　💧' + oweCell(owe.water.amount) + '　🏢' + oweCell(owe.property.amount) + '</div>' +
      '<div class="owe-total' + (owe.total > 0 ? ' red' : '') + '">合计 ¥' + money(owe.total) + '（' + owe.count + ' 笔）</div>';
    var ops = '<button class="btn plain small" onclick="showHouseholdDetail(' + h.id + ')">👁</button> ' +
              '<button class="btn green small" onclick="notifyHousehold(' + h.id + ')">📣</button> ' +
              '<button class="btn plain small" onclick="setPhone(' + h.id + ')">📱</button> ' +
              '<button class="btn plain small" onclick="setBalance(' + h.id + ')">💰</button> ' +
              '<button class="btn plain small" onclick="editHousehold(' + h.id + ')">✏️</button>';
    return '<tr>' +
      '<td>' + esc(h.roomLabel) + '</td>' +
      '<td>' + esc(h.ownerName) + '</td>' +
      '<td>' + h.area + '</td>' +
      '<td>' + esc(h.regPhone || '-') + '</td>' +
      '<td>¥' + money(h.waterBalance) + '</td>' +
      '<td>' + h.boundCount + '</td>' +
      '<td>' + oweHtml + '</td>' +
      '<td>' + ops + '</td>' +
      '</tr>';
  }).join('');
  $('hh-body').innerHTML = html || '<tr><td colspan="8" class="muted">' + (hhCache.length ? '没有匹配的住户' : '还没有住户，请先新增或批量导入') + '</td></tr>';
}

$('hh-search').addEventListener('input', renderHouseholds);

$('ha-add').onclick = function () {
  $('ha-result').textContent = '';
  $('ha-result').style.color = '';
  api('/household-add', 'POST', {
    unit: $('ha-unit').value.trim(),
    roomNo: $('ha-room').value.trim(),
    ownerName: $('ha-name').value.trim(),
    area: $('ha-area').value.trim(),
    phone: $('ha-phone').value.trim()
  }).then(function (d) {
    $('ha-result').textContent = '✅ ' + d.message;
    $('ha-result').style.color = '#2F855A';
    loadHouseholds();
  }).catch(function (e) {
    $('ha-result').textContent = '❌ ' + e.message;
  });
};

window.setPhone = function (id) {
  var p = window.prompt('输入该户在物业登记的手机号（业主绑定时必须填一致；留空=清除登记）：', '');
  if (p === null) return;
  api('/household-setphone', 'POST', { householdId: id, phone: p }).then(function (d) {
    alert('✅ ' + d.message);
    loadHouseholds();
  }).catch(function (e) { alert('❌ ' + e.message); });
};

window.setBalance = function (id) {
  var v = window.prompt('输入该户的水费代收余额（元）：', '0');
  if (v === null) return;
  api('/household-setbalance', 'POST', { householdId: id, waterBalance: v }).then(function (d) {
    alert('✅ ' + d.message);
    loadHouseholds();
  }).catch(function (e) { alert('❌ ' + e.message); });
};

window.editHousehold = function (id) {
  var h = hhCache.find(function (x) { return x.id === id; });
  if (!h) return;
  var area = window.prompt('面积（㎡，当前 ' + h.area + '）：', h.area);
  if (area === null) return;
  var name = window.prompt('户主姓名（当前 ' + h.ownerName + '）：', h.ownerName);
  if (name === null) return;
  api('/household-edit', 'POST', { householdId: id, area: area, ownerName: name }).then(function (d) {
    alert('✅ ' + d.message);
    loadHouseholds();
  }).catch(function (e) { alert('❌ ' + e.message); });
};

// ---------- 操作日志 ----------
function loadAdminLogs() {
  api('/admin-logs').then(function (list) {
    var html = list.map(function (l) {
      return '<tr>' +
        '<td>' + esc(l.time) + '</td>' +
        '<td>' + esc(l.admin) + '</td>' +
        '<td>' + esc(l.action) + '</td>' +
        '<td>' + esc(l.target) + '</td>' +
        '<td class="wrap">' + esc(l.detail) + '</td>' +
        '<td>' + esc(l.ip) + '</td>' +
        '</tr>';
    }).join('');
    $('logs-body').innerHTML = html || '<tr><td colspan="6" class="muted">还没有操作记录</td></tr>';
  }).catch(function (e) {
    $('logs-body').innerHTML = '<tr><td colspan="6" class="red">' + esc(e.message) + '</td></tr>';
  });
}
$('logs-refresh').onclick = loadAdminLogs;

// ---------- 用量分析 ----------
$('usage-load').onclick = function () { loadUsage($('usage-period').value); };

function loadUsage(period) {
  $('usage-summary').textContent = '分析中…';
  api('/usage' + (period ? '?period=' + period : '')).then(function (s) {
    var bh = s.buildings.map(function (b) {
      return '<p>栋 ' + esc(b.building) + '：电 ' + b.electricUsage + ' 度（¥' + money(b.electricAmount) +
        '）· 水 ' + b.waterUsage + ' 吨（¥' + money(b.waterAmount) + '）· ' + b.households + ' 户</p>';
    }).join('') || '<p>这个账期还没有账单数据</p>';
    $('usage-summary').innerHTML = '<p><b>账期 ' + esc(s.period) + '</b>（分析于 ' + esc(s.generatedAt) + '）</p>' + bh;

    var maxUse = 1;
    s.trend.forEach(function (t) { maxUse = Math.max(maxUse, t.electric, t.water); });
    var chart = s.trend.map(function (t) {
      var he = Math.max(4, Math.round(t.electric / maxUse * 118));
      var hw = Math.max(4, Math.round(t.water / maxUse * 118));
      return '<div class="bar-group"><div class="bars">' +
        '<div class="bar e" style="height:' + he + 'px" title="电 ' + t.electric + ' 度"></div>' +
        '<div class="bar w" style="height:' + hw + 'px" title="水 ' + t.water + ' 吨"></div>' +
        '</div><div class="bar-label">' + t.period.slice(2) + '</div></div>';
    }).join('');
    $('trend-chart').innerHTML = chart +
      '<div class="chart-legend"><span class="dot" style="background:#2B6CB0"></span>电（度）' +
      '<span class="dot" style="background:#4FA3C7"></span>水（吨）</div>';

    $('abnormal-list').innerHTML = s.abnormal.length
      ? s.abnormal.map(function (a) {
          return '<div class="abnormal-item"><b>' + esc(a.roomLabel) + '（' + a.typeLabel + '）</b>：本月 ' +
            a.usage + '，' + esc(a.reason) + '。<br>' + esc(a.advice) + '</div>';
        }).join('')
      : '本账期没有发现异常高耗户 👍';
  }).catch(function (e) {
    $('usage-summary').textContent = e.message;
  });
}

// ---------- 监管留痕（服务端分页 + 筛选 + 两级哈希链校验） ----------
var regCache = [];
var regState = { page: 1, pageSize: 20, total: 0, totalPages: 1, amount: 0, chainOk: true, brokenAt: '' };

function regQuery() {
  var p = new URLSearchParams();
  p.set('page', regState.page);
  p.set('pageSize', regState.pageSize);
  var month = $('rg-month').value;
  var type = $('rg-type').value;
  var kw = $('rg-kw').value.trim();
  if (month) p.set('month', month);
  if (type) p.set('type', type);
  if (kw) p.set('keyword', kw);
  return p.toString();
}

function loadRegulatory() {
  $('rg-summary').textContent = '查询中…';
  api('/regulatory?' + regQuery()).then(function (d) {
    regCache = d.rows || [];
    regState = {
      page: d.page, pageSize: d.pageSize, total: d.total, totalPages: d.totalPages,
      amount: d.amount, chainOk: d.chainOk, brokenAt: d.brokenAt
    };
    renderRegulatory();
    renderPager('rg-pager', regState,
      function (p) { regState.page = p; loadRegulatory(); },
      function (s) { regState.pageSize = s; regState.page = 1; loadRegulatory(); });
  }).catch(function (e) {
    $('rg-summary').textContent = e.message;
    $('rg-body').innerHTML = '<tr><td colspan="9" class="red">' + esc(e.message) + '</td></tr>';
    $('rg-pager').innerHTML = '';
  });
}

function renderRegulatory() {
  var cfg2 = window._cwltCfg || {};
  var chain = regState.chainOk
    ? '<span class="chain-ok">本页哈希链 ✓</span>'
    : '<span class="chain-bad">本页哈希链异常（' + esc(regState.brokenAt) + '）</span>';
  $('rg-summary').innerHTML = '共 ' + regState.total + ' 条 / 涉及金额 ¥' + money(regState.amount) +
    ' · ' + chain + '（全量校验请点上方按钮）' +
    ' · ' + esc(cfg2.community || '崇文兰亭') + ' · ' + esc(cfg2.company || '武汉鼎诚物业');
  var html = regCache.map(function (r) {
    return '<tr>' +
      '<td class="' + (r.bizType === 'refund' ? 'red' : '') + '">' + esc(r.bizLabel) + '</td>' +
      '<td>' + esc(r.recordNo) + '</td>' +
      '<td>' + esc(r.houseLabel || '-') + '</td>' +
      '<td>' + esc(r.owner || '-') + '</td>' +
      '<td>' + esc(r.feeTypeLabel) + '</td>' +
      '<td>' + esc(r.period || '-') + '</td>' +
      '<td>¥' + money(r.amount) + '</td>' +
      '<td>' + esc(r.channel) + '</td>' +
      '<td>' + esc(r.paidAt) + '</td>' +
      '</tr>';
  }).join('');
  $('rg-body').innerHTML = html ||
    '<tr><td colspan="9" class="muted">' + (regState.total ? '本页没有数据' : '当前条件下还没有留痕记录') + '</td></tr>';
}

$('rg-search').onclick = function () { regState.page = 1; loadRegulatory(); };
$('rg-reset').onclick = function () {
  $('rg-month').value = monthStr();
  $('rg-type').value = '';
  $('rg-kw').value = '';
  regState.page = 1;
  loadRegulatory();
};
$('rg-kw').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('rg-search').click(); });

// 全量校验哈希链（按当前筛选，上限 50000 条；数据被人为改动会在这里被发现）
$('rg-chain').onclick = function () {
  $('rg-chain').disabled = true;
  api('/regulatory/chain-check?' + regQuery()).then(function (d) {
    $('rg-chain').disabled = false;
    if (d.chainOk) {
      alert('✅ 全量校验通过：共校验 ' + d.checked + ' 条留痕，哈希链完整无篡改');
    } else {
      alert('❌ 哈希链异常！断点记录：' + d.brokenAt + '（共校验 ' + d.checked + ' 条）。请立即核查数据库是否被人为改动。');
    }
  }).catch(function (e) {
    $('rg-chain').disabled = false;
    alert('❌ ' + e.message);
  });
};

$('rg-export').onclick = function () {
  api('/regulatory/export?' + regQuery()).then(function (d) {
    downloadText(d.fileName, d.csv);
    alert('✅ 已导出 ' + d.count + ' 条留痕记录' + (d.chainOk ? '，哈希链校验通过' : '，⚠️ 哈希链校验异常'));
  }).catch(function (e) { alert('❌ ' + e.message); });
};

// ---------- 报修看板（拖拽改状态） ----------
var kbCache = [];

function loadRepairBoard() {
  api('/repairs').then(function (list) {
    kbCache = list;
    renderKanban();
  }).catch(function (e) {
    $('kb-pending').innerHTML = '<div class="kb-empty red">' + esc(e.message) + '</div>';
  });
}

function renderKanban() {
  var cols = { pending: [], doing: [], done: [] };
  kbCache.forEach(function (r) { (cols[r.status] || cols.pending).push(r); });
  ['pending', 'doing', 'done'].forEach(function (s) {
    var box = $('kb-' + s);
    var n = $('kb-count-' + s);
    if (n) n.textContent = cols[s].length;
    if (!box) return;
    box.innerHTML = cols[s].map(function (r) {
      var pri = r.priority && r.priority !== 'normal'
        ? '<span class="kb-pri ' + r.priority + '">' + esc(r.priorityLabel) + '</span>' : '';
      return '<div class="kb-card p-' + (r.priority || 'normal') + '" draggable="true" data-id="' + r.id + '">' +
        '<div class="kb-card-top"><span class="kb-room">' + esc(r.roomLabel) + '</span>' + pri + '</div>' +
        '<div class="kb-cat">' + esc(r.category) + '</div>' +
        '<div class="kb-content">' + esc(r.content.slice(0, 42)) + '</div>' +
        '<div class="kb-meta">' + (r.assignee ? '👷 ' + esc(r.assignee) + ' · ' : '') + esc(r.createdAt.slice(5, 16)) + '</div>' +
        '</div>';
    }).join('') || '<div class="kb-empty">暂无工单</div>';

    box.querySelectorAll('.kb-card').forEach(function (card) {
      card.addEventListener('dragstart', function (e) {
        e.dataTransfer.setData('text/plain', card.dataset.id);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', function () { card.classList.remove('dragging'); });
      card.addEventListener('click', function () { openRepairDrawer(Number(card.dataset.id)); });
    });
  });
}

// 列拖放只绑定一次
function setupKanbanDnd() {
  document.querySelectorAll('.kanban-col').forEach(function (col) {
    col.addEventListener('dragover', function (e) { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', function () { col.classList.remove('drag-over'); });
    col.addEventListener('drop', function (e) {
      e.preventDefault();
      col.classList.remove('drag-over');
      var id = Number(e.dataTransfer.getData('text/plain'));
      if (!id) return;
      var r = kbCache.find(function (x) { return x.id === id; });
      var status = col.dataset.status;
      if (!r || r.status === status) return;
      api('/repair-status', 'POST', { id: id, status: status }).then(function () {
        loadRepairBoard();
        loadOverview();
      }).catch(function (err) { alert('❌ ' + err.message); });
    });
  });
}

function openRepairDrawer(id) {
  var r = kbCache.find(function (x) { return x.id === id; });
  if (!r) return;
  $('rp-title').textContent = r.roomLabel + ' · ' + r.category;
  $('rp-sub').textContent = '提交于 ' + r.createdAt + ' · 当前状态：' + r.statusLabel;
  var html =
    '<div class="drawer-sec"><b>📝 问题描述</b><div class="mt8">' + esc(r.content) + '</div>' +
    (r.img ? '<div class="mt8"><a href="' + esc(r.img) + '" target="_blank">📷 查看现场照片</a></div>' : '') + '</div>' +
    '<div class="drawer-sec"><b>📞 联系电话</b><div class="mt8">' +
    (r.contact ? '<a href="tel:' + esc(r.contact) + '">' + esc(r.contact) + '</a>' : '-') + '</div></div>' +
    '<div class="drawer-sec"><b>🔧 处理设置</b>' +
    '<div class="form-grid mt8">' +
    '<div><label>状态</label><select id="rp-status">' +
    '<option value="pending"' + (r.status === 'pending' ? ' selected' : '') + '>待处理</option>' +
    '<option value="doing"' + (r.status === 'doing' ? ' selected' : '') + '>处理中</option>' +
    '<option value="done"' + (r.status === 'done' ? ' selected' : '') + '>已完成</option></select></div>' +
    '<div><label>优先级</label><select id="rp-priority">' +
    '<option value="normal"' + (r.priority === 'normal' ? ' selected' : '') + '>普通</option>' +
    '<option value="high"' + (r.priority === 'high' ? ' selected' : '') + '>加急</option>' +
    '<option value="urgent"' + (r.priority === 'urgent' ? ' selected' : '') + '>紧急</option></select></div>' +
    '<div><label>维修师傅</label><input id="rp-assignee" value="' + esc(r.assignee || '') + '" placeholder="例如：王师傅"></div>' +
    '</div>' +
    '<div class="form-grid mt8"><div style="grid-column:1/-1"><label>给业主的回复</label>' +
    '<input id="rp-feedback" value="' + esc(r.feedback || '') + '" placeholder="例如：已安排师傅下午上门"></div></div>' +
    '<div class="btn-row mt8"><button class="btn green" onclick="saveRepair(' + r.id + ')">保存并留痕</button></div>' +
    '</div>';
  $('rp-body').innerHTML = html;
  show($('rp-drawer'));
}

window.saveRepair = function (id) {
  api('/repair-status', 'POST', {
    id: id,
    status: $('rp-status').value,
    priority: $('rp-priority').value,
    assignee: $('rp-assignee').value.trim(),
    feedback: $('rp-feedback').value.trim()
  }).then(function (d) {
    alert('✅ ' + d.message);
    hide($('rp-drawer'));
    loadRepairBoard();
    loadOverview();
  }).catch(function (e) { alert('❌ ' + e.message); });
};

// ---------- 缴费看板（楼栋热力图） ----------
function loadCollectionBoard() {
  var period = $('cb-period').value || monthStr();
  $('cb-units').textContent = '加载中…';
  api('/collection-board?period=' + period).then(function (d) {
    renderCollectionBoard(d);
  }).catch(function (e) {
    $('cb-units').innerHTML = '<div class="red">' + esc(e.message) + '</div>';
  });
}

function renderCollectionBoard(d) {
  var s = d.summary;
  var cards = [
    { label: '全部缴清', value: s.allPaid + ' 户', cls: 'green' },
    { label: '部分缴纳', value: s.partial + ' 户', cls: 'orange' },
    { label: '未缴', value: s.unpaid + ' 户', cls: 'red' },
    { label: '未出账', value: s.none + ' 户', cls: 'muted' }
  ];
  $('cb-summary').innerHTML = cards.map(function (c) {
    return '<div class="stat-card"><div class="stat-num ' + c.cls + '">' + c.value + '</div><div class="stat-label">' + c.label + '</div></div>';
  }).join('');

  var unitSummary = d.units.map(function (u) {
    return '<div class="cb-unit"><div class="cb-unit-head"><b>' + u.unit + '单元</b>' +
      '<span class="muted">全缴 ' + u.allPaid + '/' + u.households + ' 户 · 金额收缴率 ' + u.rateAmount + '%</span></div>' +
      '<div class="progress-bar"><div style="width:' + u.rateAmount + '%"></div></div></div>';
  }).join('');

  var grids = d.units.map(function (u) {
    var rows = d.households.filter(function (h) { return h.unit === u.unit; });
    var floors = {};
    rows.forEach(function (h) { (floors[h.floor] = floors[h.floor] || []).push(h); });
    var grid = Object.keys(floors).sort().map(function (f) {
      var cells = floors[f].sort(function (a, b) { return a.room < b.room ? -1 : 1; }).map(function (h) {
        return '<div class="cb-cell ' + h.status + '" onclick="showHouseholdDetail(' + h.householdId + ')" ' +
          'title="' + esc(h.roomLabel) + '：' + h.paid + '/' + h.total + ' 笔已缴，应缴 ¥' + money(h.amount) + '">' +
          esc(h.room) + '</div>';
      }).join('');
      return '<div class="cb-floor"><div class="cb-floor-label">' + f + '层</div>' + cells + '</div>';
    }).join('');
    return '<div class="cb-grid-wrap"><div class="cb-grid-title">🏢 ' + u.unit + '单元（点击房号看详情）</div>' + grid + '</div>';
  }).join('');

  $('cb-units').innerHTML = '<div class="cb-units-summary">' + unitSummary + '</div>' + grids;
}

// ---------- 打印催缴单（当前筛选，全部记录） ----------
$('print-unpaid').onclick = function () {
  api('/unpaid?all=1&' + unpaidQuery()).then(function (d) {
    var rows = d.rows || [];
    if (!rows.length) { alert('当前筛选条件下没有欠费记录'); return; }
    var total = rows.reduce(function (s, b) { return s + Number(b.amount); }, 0);
    var html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>催缴单</title>' +
      '<style>body{font-family:"Microsoft YaHei";padding:22px;color:#1B2735}' +
      'h1{font-size:22px;text-align:center;margin-bottom:6px}' +
      '.sub{text-align:center;color:#666;font-size:13px;margin-bottom:14px}' +
      'table{width:100%;border-collapse:collapse;font-size:14px}th,td{border:1px solid #999;padding:6px 8px;text-align:left}' +
      'th{background:#eef4fb}.note{margin-top:16px;font-size:13px;color:#555;line-height:1.8}' +
      '@media print{@page{margin:12mm}}</style></head><body>' +
      '<h1>崇文兰亭 · 物业费/水电费催缴单</h1>' +
      '<div class="sub">生成时间：' + new Date().toLocaleString() + '　共 ' + rows.length + ' 笔，合计 ¥' + money(total) + '</div>' +
      '<table><thead><tr><th>房号</th><th>户主</th><th>类型</th><th>账期</th><th>金额</th><th>到期日</th><th>逾期</th></tr></thead><tbody>' +
      rows.map(function (b) {
        return '<tr><td>' + esc(b.roomLabel) + '</td><td>' + esc(b.ownerName) + '</td><td>' + esc(b.typeLabel) +
          '</td><td>' + esc(b.period) + '</td><td>¥' + money(b.amount) + '</td><td>' + esc(b.dueDate) +
          '</td><td>' + (b.overdueDays > 0 ? '逾期 ' + b.overdueDays + ' 天' : '') + '</td></tr>';
      }).join('') +
      '</tbody></table><div class="note">缴费方式：微信搜索“崇文兰亭缴费通”小程序，或到物业前台现金 / POS 缴纳。<br>' +
      '咨询电话：88398808　·　武汉鼎诚物业</div></body></html>';
    var w = window.open('', '_blank');
    if (!w) { alert('浏览器拦截了弹窗，请允许后重试'); return; }
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(function () { w.print(); }, 350);
  }).catch(function (e) { alert('❌ ' + e.message); });
};

// ---------- 语音播报（适老化） ----------
$('wb-speak').onclick = function () {
  if (!('speechSynthesis' in window)) { alert('当前浏览器不支持语音播报，请用 Chrome / Edge'); return; }
  api('/overview').then(function (d) {
    var text = '崇文兰亭物业缴费播报。当前未缴账单 ' + d.unpaidCount + ' 笔，合计 ' +
      money(d.unpaidAmount) + ' 元；已逾期 ' + d.overdueCount + ' 笔；待处理报修 ' +
      d.repairPending + ' 单；今日实收 ' + money(d.todayPaidAmount) + ' 元。';
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 0.95;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }).catch(function (e) { alert('❌ ' + e.message); });
};

$('rb-refresh').onclick = loadRepairBoard;
$('rp-close').onclick = function () { hide($('rp-drawer')); };
$('cb-load').onclick = loadCollectionBoard;

// ---------- 启动 ----------
(function init() {
  var nowMonth = monthStr();
  $('usage-period').value = nowMonth;
  $('rg-month').value = nowMonth;
  $('wz-period').value = nowMonth;
  $('pb-period').value = nowMonth;
  $('cb-period').value = nowMonth;
  $('wz-due').value = daysLater(15);
  $('pb-due').value = daysLater(15);
  $('stl-date').value = todayStr();
  setupKanbanDnd();
  if (!TOKEN) { showLogin(); return; }
  showMain();
})();
