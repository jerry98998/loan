/* 房贷看板 — 前端逻辑（无框架，无构建） */
(function () {
  'use strict';

  var E = window.LoanEngine;
  var KEY = 'mortgage.dashboard.v1';

  var S = {
    state: null,
    tab: 'home',
    planFilter: 'all',
    draft: null,
    editing: null,
    isDemo: false
  };

  /* ================================================================
   * 数据
   * ================================================================ */

  function demoState() {
    return {
      v: 1,
      name: '我的房贷',
      asOf: '',
      loans: [
        {
          id: 'gj', name: '公积金贷', kind: '公积金', principal: 600000, annualRate: 2.85,
          termMonths: 300, method: 'equal_installment', firstPaymentDate: '2024-06-20',
          rateChanges: [], prepayments: []
        },
        {
          id: 'sd', name: '商贷', kind: '商贷', principal: 400000, annualRate: 4.2,
          termMonths: 300, method: 'equal_installment', firstPaymentDate: '2024-06-20',
          rateChanges: [], prepayments: []
        }
      ],
      sync: { url: '', token: '' }
    };
  }

  function normState(st) {
    var out = st && typeof st === 'object' ? st : {};
    out.v = 1;
    out.name = out.name || '我的房贷';
    out.asOf = out.asOf || '';
    out.sync = out.sync || { url: '', token: '' };
    out.loans = (Array.isArray(out.loans) ? out.loans : []).map(function (l, i) {
      return {
        id: l.id || ('loan-' + i + '-' + Math.random().toString(36).slice(2, 7)),
        name: l.name || ('贷款 ' + (i + 1)),
        kind: l.kind === '公积金' ? '公积金' : '商贷',
        principal: E.num(l.principal),
        annualRate: E.num(l.annualRate),
        termMonths: Math.round(E.num(l.termMonths, 360)),
        method: l.method === 'equal_principal' ? 'equal_principal' : 'equal_installment',
        firstPaymentDate: l.firstPaymentDate || E.today(),
        rateChanges: Array.isArray(l.rateChanges) ? l.rateChanges : [],
        prepayments: Array.isArray(l.prepayments) ? l.prepayments : []
      };
    });
    return out;
  }

  function load() {
    var raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { /* 隐私模式 */ }
    if (!raw) { S.isDemo = true; return demoState(); }
    try { S.isDemo = false; return normState(JSON.parse(raw)); }
    catch (e) { S.isDemo = true; return demoState(); }
  }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(S.state)); } catch (e) {}
  }

  function payload() {
    return { v: 1, name: S.state.name, asOf: S.state.asOf || '', loans: S.state.loans, updatedAt: new Date().toISOString() };
  }

  /* ================================================================
   * 小工具
   * ================================================================ */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(x, d) { return '¥' + E.fmtMoney(x, d === undefined ? 2 : d); }
  function wan(x) { return E.fmtWan(x); }
  function shortDate(d) { return d ? String(d).slice(5) : '—'; }
  function pct(x, d) { return (x * 100).toFixed(d === undefined ? 1 : d) + '%'; }
  function splitMoney(x) {
    var s = E.fmtMoney(Math.abs(x));
    var i = s.indexOf('.');
    return { int: s.slice(0, i), dec: s.slice(i) };
  }
  function $(id) { return document.getElementById(id); }

  var toastTimer = null;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 2000);
  }

  function analysis() { return E.analyze(S.state, S.state.asOf || null); }

  /* ================================================================
   * 渲染入口
   * ================================================================ */

  function render() {
    var a = analysis();
    $('pageTitle').textContent = S.state.name || '房贷看板';
    $('asOfLabel').textContent = '截至 ' + a.asOf + (S.state.asOf ? ' · 手动基准日' : ' · 自动');

    var btns = $('tabbar').querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-tab') === S.tab);
    }

    var html = '';
    if (S.tab === 'home') html = viewHome(a);
    else if (S.tab === 'plan') html = viewPlan(a);
    else if (S.tab === 'config') html = viewConfig(a);
    else html = viewData(a);

    $('view').innerHTML = html;
    window.scrollTo(0, 0);
  }

  function setTab(tab) {
    S.tab = tab;
    render();
  }

  /* ================================================================
   * 概览
   * ================================================================ */

  function statCard(k, v, sub, cls) {
    return '<div class="card stat"><div class="k">' + k + '</div>' +
      '<div class="v ' + (cls || '') + '">' + v + '</div>' +
      '<div class="s">' + sub + '</div></div>';
  }

  function viewHome(a) {
    var t = a.totals;

    if (!a.loans.length) {
      return '<div class="empty">还没有贷款数据<br><br>' +
        '<button class="ghost-btn" data-action="add-loan">＋ 添加第一笔贷款</button></div>' +
        (a.errors.length ? '<p class="hint">' + a.errors.map(esc).join('<br>') + '</p>' : '');
    }

    var p = splitMoney(t.remainingPrincipal);
    var avgRate = t.principal > 0
      ? a.loans.reduce(function (s, x) { return s + x.loan.principal * x.loan.annualRate; }, 0) / t.principal
      : 0;
    var h = '';

    if (S.isDemo) {
      h += '<button class="demo-note" data-action="goto-config">' +
        '<b>示例数据</b>　点这里改成你自己的贷款 <span class="arr">›</span></button>';
    }

    /* 主卡 */
    h += '<section class="card hero">' +
      '<div class="hero-top"><span class="label">剩余本金</span>' +
      '<span class="pill">' + (a.loans.length > 1 ? '组合贷 ' + a.loans.length + ' 笔 · ' : '') + avgRate.toFixed(2) + '%</span></div>' +
      '<div class="hero-num"><span class="cur">¥</span><span class="int">' + p.int + '</span><span class="dec">' + p.dec + '</span></div>' +
      '<div class="bar"><i style="width:' + (t.progress * 100).toFixed(2) + '%"></i></div>' +
      '<div class="hero-foot"><span>已还 ' + t.periodsPaid + ' / ' + t.periodsTotal + ' 期 · ' + pct(t.progress) + '</span>' +
      '<span>' + (t.periodsLeft > 0 ? '还剩 ' + t.periodsLeft + ' 期' : '已结清') + '</span></div>' +
      '</section>';

    /* 四宫格 */
    h += '<div class="grid2">';
    h += statCard('本期应还', money(t.monthlyPayment),
      t.nextPayment ? '下次 ' + shortDate(t.nextPayment.date) + ' · 共 ' + t.periodsLeft + ' 期' : '已结清', 'mint');
    h += statCard('已还本息', money(t.paidTotal),
      '本金 ' + wan(t.paidPrincipal) + ' · 利息 ' + wan(t.paidInterest));
    h += statCard('已产生利息', money(t.paidInterest + t.accruedInterest),
      '本期已计提 ' + money(t.accruedInterest), 'amber');
    h += statCard('剩余本息', money(t.remainingTotal),
      '含利息 ' + wan(t.remainingInterest), 'blue');
    h += '</div>';

    /* 全程概览 */
    h += '<div class="card"><h2>全程概览</h2><div class="rows">' +
      '<div class="row"><span class="k">贷款总额</span><span class="v">' + money(t.principal) + '</span></div>' +
      '<div class="row"><span class="k">全程利息</span><span class="v">' + money(t.totalInterest) + '</span></div>' +
      '<div class="row"><span class="k">还款总额</span><span class="v">' + money(t.totalPayment) + '</span></div>' +
      '<div class="row"><span class="k">预计结清</span><span class="v">' + (a.loans[0] ? a.loans[0].stats.endDate : '—') + '</span></div>' +
      (t.savedInterest > 0.5 ? '<div class="row"><span class="k">提前还款已省利息</span><span class="v mint">' + money(t.savedInterest) + '</span></div>' : '') +
      '</div></div>';

    /* 分笔 */
    a.loans.forEach(function (res) {
      var s = res.stats;
      h += '<div class="card">' +
        '<div class="loan-head"><div class="loan-name">' + esc(res.loan.name) +
        '<span class="tag ' + (res.loan.kind === '公积金' ? 'gj' : '') + '">' + esc(res.loan.kind) + '</span></div>' +
        '<span class="pill">' + s.annualRate.toFixed(2) + '%</span></div>' +
        '<div class="rows">' +
        '<div class="row"><span class="k">剩余本金</span><span class="v">' + money(s.remainingPrincipal) + '</span></div>' +
        '<div class="row"><span class="k">下期应还</span><span class="v">' + money(s.monthlyPayment) + ' · ' + (s.nextPayment ? shortDate(s.nextPayment.date) : '—') + '</span></div>' +
        '<div class="row"><span class="k">已还期数</span><span class="v">' + s.periodsPaid + ' / ' + s.periodsTotal + ' 期</span></div>' +
        '<div class="row"><span class="k">已付利息</span><span class="v">' + money(s.paidInterest) + '</span></div>' +
        '<div class="row"><span class="k">' + s.methodName + ' · ' + E.fmtMonths(s.periodsLeft) + '后结清</span><span class="v">' +
        '<button class="ghost-btn" data-action="edit-loan" data-id="' + esc(res.loan.id) + '">调整</button></span></div>' +
        '</div></div>';
    });

    if (a.errors.length) {
      h += '<p class="hint" style="color:var(--red)">' + a.errors.map(esc).join('<br>') + '</p>';
    }
    return h;
  }

  /* ================================================================
   * 还款计划
   * ================================================================ */

  function viewPlan(a) {
    if (!a.loans.length) return '<div class="empty">还没有贷款数据</div>';

    var h = '<div class="toolbar">';
    [['all', '全部'], ['paid', '已还'], ['future', '未还'], ['pre', '提前还款']].forEach(function (f) {
      h += '<button class="chip ' + (S.planFilter === f[0] ? 'on' : '') + '" data-action="plan-filter" data-v="' + f[0] + '">' + f[1] + '</button>';
    });
    h += '</div>';

    a.loans.forEach(function (res) {
      var s = res.stats;
      h += '<div class="sec-title">' + esc(res.loan.name) + ' · ' + s.methodName + ' · ' + money(s.principal, 0) + '</div>';
      h += '<div class="tbl"><div class="thead"><span>期</span><span>日期</span><span>月供</span><span>利息</span><span>余额</span></div>';

      var rows = res.rows;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (S.planFilter === 'paid' && !r.paid) continue;
        if (S.planFilter === 'future' && r.paid) continue;
        if (S.planFilter === 'pre' && r.mode !== 'prepay') continue;

        var cls = r.paid ? '' : 'future';
        if (!r.paid && r.p === s.periodsPaid + 1) cls += ' now';
        h += '<div class="tr ' + cls + '">' +
          '<span class="p">' + r.p + '</span>' +
          '<span class="d">' + (r.mode === 'prepay' ? '<span class="pp">提前</span>' : shortDate(r.date)) + '</span>' +
          '<span class="amt">' + E.fmtMoney(r.payment, 2) + '</span>' +
          '<span>' + E.fmtMoney(r.interest, 2) + '</span>' +
          '<span>' + E.fmtMoney(r.balance, 2) + '</span>' +
          '</div>';
        if (r.mode === 'prepay') {
          h += '<div class="pre-note">' + shortDate(r.date) + ' 提前还 ' + wan(r.prepay) +
            ' · ' + (r.prepayMode === 'reduce_payment' ? '降月供、期限不变' : '缩期限、月供不变') + '</div>';
        }
      }
      h += '</div>';
    });

    h += '<p class="hint">月供 = 当期本金 + 利息；余额为当期还款后的剩余本金。提前还款记在「还款日 ≥ 提前还款日」的那一期之后。</p>';
    return h;
  }

  /* ================================================================
   * 设置
   * ================================================================ */

  function viewConfig(a) {
    var h = '';

    h += '<div class="card"><h2>看板</h2>' +
      '<div class="field"><label>名称</label><input class="input" data-cfg="name" value="' + esc(S.state.name) + '"></div>' +
      '<div class="field"><label>数据基准日（留空 = 今天）</label>' +
      '<input class="input" type="date" data-cfg="asOf" value="' + esc(S.state.asOf || '') + '"></div>' +
      '<p class="hint">想看「如果提前还 20 万，明年这时候还剩多少」，把基准日改成未来的某天即可。</p>' +
      '</div>';

    h += '<div class="sec-title">贷款（' + S.state.loans.length + ' 笔）</div>';

    if (!S.state.loans.length) {
      h += '<div class="empty">还没有贷款</div>';
    }

    S.state.loans.forEach(function (l) {
      var res = E.buildLoan(l);
      var rateTxt = l.annualRate.toFixed(2) + '%';
      if (res.ok && Math.abs(res.stats.rate - l.annualRate) > 1e-9) {
        rateTxt += ' → ' + res.stats.rate.toFixed(2) + '%';
      }
      h += '<div class="card">' +
        '<div class="loan-head"><div class="loan-name">' + esc(l.name) +
        '<span class="tag ' + (l.kind === '公积金' ? 'gj' : '') + '">' + esc(l.kind) + '</span></div>' +
        '<button class="ghost-btn" data-action="edit-loan" data-id="' + esc(l.id) + '">编辑</button></div>' +
        '<div class="rows">' +
        '<div class="row"><span class="k">本金</span><span class="v">' + money(l.principal, 0) + '</span></div>' +
        '<div class="row"><span class="k">年利率</span><span class="v">' + rateTxt + '</span></div>' +
        '<div class="row"><span class="k">期限</span><span class="v">' + l.termMonths + ' 期 · ' + E.fmtMonths(l.termMonths) + '</span></div>' +
        '<div class="row"><span class="k">还款方式</span><span class="v">' + (l.method === 'equal_principal' ? '等额本金' : '等额本息') + '</span></div>' +
        '<div class="row"><span class="k">首次还款</span><span class="v">' + esc(l.firstPaymentDate) + '</span></div>' +
        ((l.rateChanges || []).length ? '<div class="row"><span class="k">利率调整</span><span class="v">' + l.rateChanges.length + ' 次</span></div>' : '') +
        ((l.prepayments || []).length ? '<div class="row"><span class="k">提前还款</span><span class="v">' + l.prepayments.length + ' 次</span></div>' : '') +
        '</div></div>';
    });

    h += '<button class="btn-primary" data-action="add-loan">＋ 添加一笔贷款</button>';
    h += '<p class="hint">组合贷 = 在这里分别添加「公积金贷」和「商贷」两笔，概览会自动合并。</p>';
    return h;
  }

  /* ================================================================
   * 数据 / 同步
   * ================================================================ */

  function viewData(a) {
    var h = '';
    var sync = S.state.sync || { url: '', token: '' };
    var base = (sync.url || '').replace(/\/+$/, '');
    var widgetUrl = base ? base + '/api/state' : '（填写同步地址后生成）';

    h += '<div class="card"><h2>备份与恢复</h2>' +
      '<div class="inline">' +
      '<button class="ghost-btn" data-action="export">导出 JSON</button>' +
      '<button class="ghost-btn" data-action="import">导入 JSON</button>' +
      '</div>' +
      '<button class="ghost-btn" data-action="copy" style="width:100%;margin-top:8px">复制数据到剪贴板</button>' +
      '<p class="hint">数据只保存在这台手机的浏览器里（localStorage）。换手机、清缓存、换浏览器之前，先导出备份。</p>' +
      '<input type="file" id="fileInput" accept=".json,application/json" style="display:none">' +
      '</div>';

    h += '<div class="card"><h2>云同步（可选，小组件需要）</h2>' +
      '<div class="field"><label>同步地址</label>' +
      '<input class="input" data-cfg="sync.url" placeholder="https://loan-sync.xxx.workers.dev" value="' + esc(sync.url) + '"></div>' +
      '<div class="field"><label>访问令牌</label>' +
      '<input class="input" data-cfg="sync.token" placeholder="自己设的一串随机字符" value="' + esc(sync.token) + '"></div>' +
      '<div class="inline">' +
      '<button class="ghost-btn" data-action="push">上传到云端</button>' +
      '<button class="ghost-btn" data-action="pull">从云端拉取</button>' +
      '</div>' +
      '<p class="hint">不用服务器也能用：这个页面 + 导出的 JSON 就够了。想要小组件自动更新，再花 5 分钟部署 <code>worker/</code>（Cloudflare 免费额度足够）。</p>' +
      '</div>';

    h += '<div class="card"><h2>iPhone 小组件</h2>' +
      '<button class="btn-primary" data-action="widget-config" style="margin-bottom:10px">复制小组件配置</button>' +
      '<div class="rows">' +
      '<div class="row"><span class="k">数据地址</span><span class="v" style="font-size:12px;word-break:break-all">' + esc(widgetUrl) + '</span></div>' +
      '<div class="row"><span class="k">访问令牌</span><span class="v" style="font-size:12px">' + (sync.token ? '已设置' : '未设置') + '</span></div>' +
      '</div>' +
      '<p class="hint">零服务器用法：点上面按钮复制，粘到 <code>widget/mortgage-widget.js</code> 开头的 <code>CONFIG.state</code>，整个文件粘进 Scriptable 即可。想让小组件自动跟着页面变，再部署 <code>worker/</code>，把地址和令牌填进 <code>CONFIG.remote</code>。</p>' +
      '</div>';

    h += '<div class="card"><h2>重置</h2>' +
      '<button class="ghost-btn btn-danger" data-action="reset">恢复示例数据（会覆盖当前数据）</button>' +
      '</div>';
    return h;
  }

  /* ================================================================
   * 编辑弹层
   * ================================================================ */

  function blankLoan() {
    return {
      id: 'l' + Date.now().toString(36),
      name: '', kind: '商贷', principal: '', annualRate: '', termMonths: 360,
      method: 'equal_installment', firstPaymentDate: '', rateChanges: [], prepayments: []
    };
  }

  function findLoan(id) {
    for (var i = 0; i < S.state.loans.length; i++) if (S.state.loans[i].id === id) return S.state.loans[i];
    return null;
  }

  function openEditor(id) {
    var loan = id ? findLoan(id) : null;
    S.editing = id || null;
    S.draft = loan ? JSON.parse(JSON.stringify(loan)) : blankLoan();
    if (!S.draft.rateChanges) S.draft.rateChanges = [];
    if (!S.draft.prepayments) S.draft.prepayments = [];
    renderEditor();
    $('sheet').hidden = false;
  }

  function closeSheet() {
    $('sheet').hidden = true;
    S.draft = null;
    S.editing = null;
  }

  function renderEditor() {
    var d = S.draft;
    var html = '<div class="sheet-grab"></div>' +
      '<div class="sheet-head"><h3>' + (S.editing ? '编辑贷款' : '添加贷款') + '</h3>' +
      '<button class="ghost-btn" data-act="close">关闭</button></div>';

    html += '<div class="field"><label>名称</label>' +
      '<input class="input" data-f="name" value="' + esc(d.name) + '" placeholder="如 公积金贷 / 商贷"></div>';

    html += '<div class="inline">' +
      '<div class="field"><label>类型</label><select class="input" data-f="kind">' +
      '<option value="商贷"' + (d.kind !== '公积金' ? ' selected' : '') + '>商业贷款</option>' +
      '<option value="公积金"' + (d.kind === '公积金' ? ' selected' : '') + '>公积金贷款</option>' +
      '</select></div>' +
      '<div class="field"><label>还款方式</label><select class="input" data-f="method">' +
      '<option value="equal_installment"' + (d.method !== 'equal_principal' ? ' selected' : '') + '>等额本息</option>' +
      '<option value="equal_principal"' + (d.method === 'equal_principal' ? ' selected' : '') + '>等额本金</option>' +
      '</select></div>' +
      '</div>';

    html += '<div class="inline">' +
      '<div class="field"><label>贷款本金</label><div class="suffix">' +
      '<input class="input" type="number" inputmode="decimal" data-f="principal" value="' + esc(d.principal) + '" placeholder="1000000"><span class="unit">元</span></div></div>' +
      '<div class="field"><label>年利率</label><div class="suffix">' +
      '<input class="input" type="number" inputmode="decimal" step="0.01" data-f="annualRate" value="' + esc(d.annualRate) + '" placeholder="4.2"><span class="unit">%</span></div></div>' +
      '</div>';

    html += '<div class="inline">' +
      '<div class="field"><label>期限</label><div class="suffix">' +
      '<input class="input" type="number" inputmode="numeric" data-f="termMonths" value="' + esc(d.termMonths) + '" placeholder="360"><span class="unit">期</span></div>' +
      '<p class="hint" id="termHint">= ' + E.fmtMonths(E.num(d.termMonths)) + '</p></div>' +
      '<div class="field"><label>首次还款日</label>' +
      '<input class="input" type="date" data-f="firstPaymentDate" value="' + esc(d.firstPaymentDate) + '"></div>' +
      '</div>';

    html += '<div class="field"><label>利率调整（LPR 重定价 / 每年 1 月 1 日调整，可选）</label>' +
      '<div class="sub-list">';
    (d.rateChanges || []).forEach(function (r, i) {
      html += '<div class="sub-item">' +
        '<input class="input" type="date" data-l="rateChanges" data-i="' + i + '" data-f="fromDate" value="' + esc(r.fromDate) + '">' +
        '<div class="suffix"><input class="input" type="number" step="0.01" inputmode="decimal" data-l="rateChanges" data-i="' + i + '" data-f="annualRate" value="' + esc(r.annualRate) + '" placeholder="新利率"><span class="unit">%</span></div>' +
        '<button class="del" data-act="del-rate" data-i="' + i + '">×</button>' +
        '</div>';
    });
    html += '</div><button class="add-btn" data-act="add-rate">＋ 添加一次利率调整</button></div>';

    html += '<div class="field"><label>提前还款（可选）</label><div class="sub-list">';
    (d.prepayments || []).forEach(function (p, i) {
      html += '<div class="sub-item three">' +
        '<input class="input" type="date" data-l="prepayments" data-i="' + i + '" data-f="date" value="' + esc(p.date) + '">' +
        '<input class="input" type="number" inputmode="decimal" data-l="prepayments" data-i="' + i + '" data-f="amount" value="' + esc(p.mode === 'payoff' ? '' : p.amount) + '" placeholder="金额" ' + (p.mode === 'payoff' ? 'disabled' : '') + '>' +
        '<select class="input" data-l="prepayments" data-i="' + i + '" data-f="mode">' +
        '<option value="shorten_term"' + (p.mode !== 'reduce_payment' && p.mode !== 'payoff' ? ' selected' : '') + '>缩期</option>' +
        '<option value="reduce_payment"' + (p.mode === 'reduce_payment' ? ' selected' : '') + '>降月供</option>' +
        '<option value="payoff"' + (p.mode === 'payoff' ? ' selected' : '') + '>结清</option>' +
        '</select>' +
        '<button class="del" data-act="del-pre" data-i="' + i + '">×</button>' +
        '</div>';
    });
    html += '</div><button class="add-btn" data-act="add-pre">＋ 添加一次提前还款</button>' +
      '<p class="hint">缩期 = 月供不变、缩短年限（省息更多）；降月供 = 年限不变、月供降低。</p></div>';

    html += '<button class="btn-primary" data-act="save">保存</button>';
    if (S.editing) {
      html += '<button class="btn-primary btn-danger" data-act="delete" style="background:transparent;border:1px solid rgba(255,107,107,.35);margin-top:10px">删除这笔贷款</button>';
    }

    $('sheetBody').innerHTML = html;
    $('sheetBody').scrollTop = 0;
  }

  function saveLoan() {
    var d = S.draft;
    var loan = {
      id: d.id,
      name: (d.name || '').trim() || '贷款',
      kind: d.kind === '公积金' ? '公积金' : '商贷',
      principal: E.num(d.principal),
      annualRate: E.num(d.annualRate),
      termMonths: Math.round(E.num(d.termMonths)),
      method: d.method === 'equal_principal' ? 'equal_principal' : 'equal_installment',
      firstPaymentDate: d.firstPaymentDate,
      rateChanges: [],
      prepayments: []
    };

    (d.rateChanges || []).forEach(function (r) {
      if (r.fromDate && r.annualRate !== '' && E.num(r.annualRate) >= 0) {
        loan.rateChanges.push({ fromDate: r.fromDate, annualRate: E.num(r.annualRate) });
      }
    });
    (d.prepayments || []).forEach(function (p) {
      if (!p.date) return;
      if (p.mode === 'payoff') loan.prepayments.push({ date: p.date, payoff: true, mode: 'shorten_term' });
      else if (E.num(p.amount) > 0) loan.prepayments.push({ date: p.date, amount: E.num(p.amount), mode: p.mode });
    });

    if (!(loan.principal > 0)) return toast('贷款本金要大于 0');
    if (!(loan.termMonths >= 1)) return toast('期限至少 1 期');
    if (!loan.firstPaymentDate) return toast('请选择首次还款日');

    var check = E.buildLoan(loan);
    if (!check.ok) return toast(check.error);

    if (S.editing) {
      for (var i = 0; i < S.state.loans.length; i++) {
        if (S.state.loans[i].id === S.editing) { S.state.loans[i] = loan; break; }
      }
    } else {
      S.state.loans.push(loan);
    }
    S.isDemo = false;
    persist();
    closeSheet();
    render();
    toast('已保存，概览已重算');
  }

  function deleteLoan() {
    if (!S.editing) return;
    S.state.loans = S.state.loans.filter(function (l) { return l.id !== S.editing; });
    persist();
    closeSheet();
    render();
    toast('已删除');
  }

  /* ================================================================
   * 事件
   * ================================================================ */

  function bindSheet() {
    var sheet = $('sheet');
    var body = $('sheetBody');

    sheet.addEventListener('click', function (e) {
      if (e.target === sheet) closeSheet();
    });

    body.addEventListener('input', function (e) {
      var t = e.target;
      var f = t.getAttribute('data-f');
      if (!f || !S.draft) return;
      var list = t.getAttribute('data-l');
      if (list) {
        S.draft[list][+t.getAttribute('data-i')][f] = t.value;
      } else {
        S.draft[f] = t.value;
        if (f === 'termMonths') {
          var hint = $('termHint');
          if (hint) hint.textContent = '= ' + E.fmtMonths(E.num(t.value));
        }
      }
    });

    body.addEventListener('change', function (e) {
      var t = e.target;
      if (t.getAttribute('data-f') === 'method' || t.getAttribute('data-f') === 'kind') {
        // 仅记录，无需重绘
      }
    });

    body.addEventListener('click', function (e) {
      var el = e.target.closest('[data-act]');
      if (!el) return;
      var act = el.getAttribute('data-act');
      var i = +el.getAttribute('data-i');

      if (act === 'close') return closeSheet();
      if (act === 'save') return saveLoan();
      if (act === 'delete') return deleteLoan();
      if (act === 'add-rate') {
        S.draft.rateChanges.push({ fromDate: '', annualRate: '' });
        return renderEditor();
      }
      if (act === 'del-rate') {
        S.draft.rateChanges.splice(i, 1);
        return renderEditor();
      }
      if (act === 'add-pre') {
        S.draft.prepayments.push({ date: '', amount: '', mode: 'shorten_term' });
        return renderEditor();
      }
      if (act === 'del-pre') {
        S.draft.prepayments.splice(i, 1);
        return renderEditor();
      }
    });
  }

  function setCfg(path, value) {
    if (path.indexOf('.') >= 0) {
      var parts = path.split('.');
      S.state[parts[0]] = S.state[parts[0]] || {};
      S.state[parts[0]][parts[1]] = value;
    } else {
      S.state[path] = value;
    }
    persist();
  }

  function exportJson() {
    var blob = new Blob([JSON.stringify(payload(), null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'mortgage-' + (S.state.asOf || E.today()) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    toast('已导出，可在「文件」里找到');
  }

  function importJson(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var st = JSON.parse(String(fr.result));
        if (!st || !Array.isArray(st.loans)) throw new Error('不是房贷看板的数据文件');
        S.state = normState(st);
        S.isDemo = false;
        persist();
        render();
        toast('已导入 ' + S.state.loans.length + ' 笔贷款');
      } catch (err) {
        toast('导入失败：' + err.message);
      }
    };
    fr.readAsText(file);
  }

  function pushCloud() {
    var base = (S.state.sync.url || '').replace(/\/+$/, '');
    if (!base) return toast('先填写同步地址');
    fetch(base + '/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (S.state.sync.token || '') },
      body: JSON.stringify(payload())
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      toast('已上传，小组件下次刷新可见');
    }).catch(function (err) {
      toast('上传失败：' + err.message);
    });
  }

  function pullCloud() {
    var base = (S.state.sync.url || '').replace(/\/+$/, '');
    if (!base) return toast('先填写同步地址');
    fetch(base + '/api/state', {
      headers: { 'Authorization': 'Bearer ' + (S.state.sync.token || '') }
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (st) {
      if (!st || !Array.isArray(st.loans)) throw new Error('云端数据格式不对');
      S.state = normState(st);
      S.isDemo = false;
      persist();
      render();
      toast('已从云端拉取');
    }).catch(function (err) {
      toast('拉取失败：' + err.message);
    });
  }

  function doAction(act, ds) {
    if (act === 'add-loan') return openEditor(null);
    if (act === 'edit-loan') return openEditor(ds.id);
    if (act === 'goto-config') return setTab('config');
    if (act === 'plan-filter') { S.planFilter = ds.v; return render(); }
    if (act === 'reload') { render(); return toast('已按当前日期重算'); }
    if (act === 'export') return exportJson();
    if (act === 'import') return $('fileInput') && $('fileInput').click();
    if (act === 'copy') {
      navigator.clipboard.writeText(JSON.stringify(payload(), null, 2))
        .then(function () { toast('已复制'); })
        .catch(function () { toast('复制失败，请用导出'); });
      return;
    }
    if (act === 'push') return pushCloud();
    if (act === 'pull') return pullCloud();
    if (act === 'widget-config') {
      navigator.clipboard.writeText(JSON.stringify(payload()))
        .then(function () { toast('已复制，粘到脚本的 CONFIG.state'); })
        .catch(function () { toast('复制失败，请用导出 JSON'); });
      return;
    }
    if (act === 'reset') {
      S.state = demoState();
      S.isDemo = true;
      persist();
      render();
      return toast('已恢复示例数据');
    }
  }

  function bindGlobal() {
    document.addEventListener('click', function (e) {
      var tab = e.target.closest('[data-tab]');
      if (tab) { setTab(tab.getAttribute('data-tab')); return; }

      var el = e.target.closest('[data-action]');
      if (el) {
        e.preventDefault();
        doAction(el.getAttribute('data-action'), el.dataset || {});
      }
    });

    document.addEventListener('input', function (e) {
      var cfg = e.target.getAttribute && e.target.getAttribute('data-cfg');
      if (!cfg) return;
      setCfg(cfg, e.target.value);
      if (cfg === 'name') $('pageTitle').textContent = e.target.value || '房贷看板';
      if (cfg === 'asOf') $('asOfLabel').textContent = '截至 ' + (e.target.value || E.today()) + (e.target.value ? ' · 手动基准日' : ' · 自动');
    });

    document.addEventListener('change', function (e) {
      var cfg = e.target.getAttribute && e.target.getAttribute('data-cfg');
      if (cfg === 'asOf') render();
      if (cfg === 'sync.url') render();
      if (e.target.id === 'fileInput' && e.target.files && e.target.files[0]) {
        importJson(e.target.files[0]);
        e.target.value = '';
      }
    });
  }

  /* ================================================================
   * 启动
   * ================================================================ */

  S.state = load();
  bindGlobal();
  bindSheet();
  render();

  // 暴露给调试 / 冒烟测试
  window.__mortgage = {
    S: S,
    render: render,
    setTab: setTab,
    openEditor: openEditor,
    closeSheet: closeSheet,
    saveLoan: saveLoan,
    analysis: analysis
  };
})();
