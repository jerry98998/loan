/**
 * test-web.js — 用最小 DOM 垫片跑通前端渲染与交互（无需浏览器、无依赖）
 * 用法：node tools/test-web.js
 */
'use strict';

const path = require('path');

let pass = 0;
const failures = [];

function ok(cond, name, extra) {
  if (cond) { pass += 1; return; }
  failures.push(name + (extra ? ' → ' + extra : ''));
  console.log('  ✗ ' + name + (extra ? '  (' + extra + ')' : ''));
}
function eq(actual, expected, name) {
  ok(String(actual) === String(expected), name, 'got ' + actual + ', want ' + expected);
}
function section(t) { console.log('\n' + t); }

/* ---------------- DOM 垫片 ---------------- */

function mkClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, on) => { if (on === undefined) { set.has(c) ? set.delete(c) : set.add(c); } else if (on) set.add(c); else set.delete(c); }
  };
}

function mkEl(tag) {
  const el = {
    tagName: tag,
    innerHTML: '',
    textContent: '',
    hidden: false,
    value: '',
    files: null,
    dataset: {},
    style: {},
    scrollTop: 0,
    _attrs: {},
    classList: mkClassList(),
    listeners: {},
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null; },
    setAttribute(n, v) { this._attrs[n] = String(v); },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    querySelectorAll() { return []; },
    appendChild() {},
    remove() {},
    click() { this.clicked = true; },
    closest() { return null; }
  };
  return el;
}

const els = {};
['view', 'pageTitle', 'asOfLabel', 'tabbar', 'sheet', 'sheetBody', 'toast'].forEach((id) => { els[id] = mkEl(id); });

const TABS = ['home', 'plan', 'config', 'data'].map((t) => {
  const b = mkEl('button');
  b.setAttribute('data-tab', t);
  return b;
});
els.tabbar.querySelectorAll = (sel) => (sel === 'button' ? TABS : []);

const docListeners = {};
global.document = {
  getElementById: (id) => els[id] || null,
  addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
  createElement: () => mkEl('div'),
  body: { appendChild() {} }
};

const store = {};
global.localStorage = {
  getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; }
};

global.window = global;
global.scrollTo = () => {};
Object.defineProperty(global, 'navigator', {
  value: { clipboard: { writeText: () => Promise.resolve() } },
  configurable: true,
  writable: true
});

/* ---------------- 载入引擎与前端 ---------------- */

const ROOT = path.join(__dirname, '..');
const E = require(path.join(ROOT, 'engine', 'loan.js'));
global.LoanEngine = E;
require(path.join(ROOT, 'web', 'app.js'));

const M = global.__mortgage;
if (!M) {
  console.error('app.js 没有暴露 __mortgage 调试接口');
  process.exit(1);
}

function fireClick(attrs) {
  const el = mkEl('button');
  Object.keys(attrs).forEach((k) => {
    el._attrs[k] = String(attrs[k]);
    if (k.indexOf('data-') === 0) el.dataset[k.slice(5)] = String(attrs[k]);
  });
  el.closest = (sel) => {
    if (sel === '[data-tab]' && el._attrs['data-tab']) return el;
    if (sel === '[data-action]' && el._attrs['data-action']) return el;
    return null;
  };
  docListeners.click.forEach((fn) => fn({ target: el, preventDefault() {} }));
}

const view = () => els.view.innerHTML;
const count = (hay, needle) => hay.split(needle).length - 1;

/* ---------------- 1. 概览 ---------------- */

section('1. 概览渲染（示例组合贷）');
const home = view();
ok(home.length > 800, '概览有内容', home.length);
['剩余本金', '本期应还', '已还本息', '已产生利息', '剩余本息', '全程概览', '预计结清', '组合贷'].forEach((k) => {
  ok(home.includes(k), '包含「' + k + '」');
});
ok(home.includes('公积金贷') && home.includes('商贷'), '两笔贷款都出现');
ok(home.includes('示例数据'), '首次打开有「示例数据」提示');
ok(home.includes('¥'), '金额带货币符号');
eq(els.pageTitle.textContent, '我的房贷', '顶栏标题');
eq(els.asOfLabel.textContent.indexOf('截至 ' + E.today()), 0, '基准日为今天');

const total = M.analysis().totals;
ok(Math.abs(total.principal - 1000000) < 0.01, '总本金 100 万', total.principal);
ok(total.remainingPrincipal > 0 && total.remainingPrincipal < 1000000, '剩余本金在合理区间', total.remainingPrincipal.toFixed(2));
eq(total.periodsPaid, 29, '已还 29 期（组合贷按期数并行计数，取 max）');
const heroParts = E.fmtMoney(total.remainingPrincipal).split('.');
ok(home.includes('<span class="int">' + heroParts[0] + '</span>'), '主卡显示剩余本金整数位');
ok(home.includes('<span class="dec">.' + heroParts[1] + '</span>'), '主卡显示剩余本金小数位');

/* ---------------- 2. 还款计划 ---------------- */

section('2. 还款计划');
M.setTab('plan');
const PER = 30;
const PAGES = Math.ceil(300 / PER);
const plan = view();
eq(count(plan, '<div class="tr'), PER * 2, '首页每笔 ' + PER + ' 期（2 × ' + PER + '）');
ok(plan.includes('第 1 / ' + PAGES + ' 页'), '分页信息 1/' + PAGES);
eq(count(plan, 'class="pre-note"'), 0, '无提前还款时不显示标记');
ok(count(plan, 'class="chip') >= 4, '四个筛选 chip');
ok(count(plan, 'class="pager"') === 2, '顶部和底部各有一个分页条');

fireClick({ 'data-action': 'plan-page', 'data-v': '1' });
eq(count(view(), '<div class="tr'), PER * 2, '翻到第 2 页仍是 ' + PER * 2 + ' 行');
ok(view().includes('第 2 / ' + PAGES + ' 页'), '第 2 页分页信息');
for (let i = 1; i < PAGES; i++) fireClick({ 'data-action': 'plan-page', 'data-v': '1' });
const last = view();
eq(count(last, '<div class="tr'), PER * 2, '最后一页 ' + PER * 2 + ' 行');
ok(last.includes('第 ' + PAGES + ' / ' + PAGES + ' 页'), '最后一页分页信息');
ok(last.includes('data-v="1" disabled'), '末页「下一页」禁用');
ok(last.includes('data-v="-1" disabled') === false, '末页「上一页」可用');

for (let i = 1; i <= PAGES; i++) fireClick({ 'data-action': 'plan-page', 'data-v': '-1' });
const first = view();
eq(count(first, '<div class="tr'), PER * 2, '回到第 1 页');
ok(first.includes('data-v="-1" disabled'), '首页「上一页」禁用');
ok(first.includes('<span class="p">1</span>'), '首页从第 1 期开始');

fireClick({ 'data-action': 'plan-filter', 'data-v': 'future' });
const future = count(view(), '<div class="tr');
eq(future, PER * 2, '筛选「未还」首页 ' + PER * 2 + ' 行');
const paidRows = M.analysis().loans.reduce((s, x) => s + x.stats.periodsPaid, 0);
const futureRows = M.analysis().loans.reduce((s, x) => s + x.stats.periodsLeft, 0);
eq(futureRows, 600 - paidRows, '未还期数 = 总期数 - 已还期数');
ok(view().includes('第 1 / ' + Math.ceil(271 / PER) + ' 页'), '未还筛选分页信息');
ok(view().includes('data-action="plan-filter" data-v="future"') && view().includes('chip on'), '未还 chip 高亮');

fireClick({ 'data-action': 'plan-filter', 'data-v': 'paid' });
eq(count(view(), '<div class="tr'), paidRows, '筛选「已还」生效');
ok(!view().includes('pginfo'), '已还结果不足一页时不显示分页');

fireClick({ 'data-action': 'plan-filter', 'data-v': 'all' });

/* ---------------- 3. 设置 ---------------- */

section('3. 贷款设置');
M.setTab('config');
const cfg = view();
ok(cfg.includes('添加一笔贷款'), '有添加按钮');
ok(cfg.includes('等额本息'), '显示还款方式');
ok(cfg.includes('2 笔'), '显示贷款笔数');

/* ---------------- 4. 数据 ---------------- */

section('4. 数据同步');
M.setTab('data');
const data = view();
ok(data.includes('导出 JSON') && data.includes('导入 JSON'), '导入导出');
ok(data.includes('云同步'), '云同步区块');
ok(data.includes('iPhone 小组件'), '小组件说明');
ok(data.includes('数据地址'), '小组件数据地址占位');

/* ---------------- 5. 新增贷款 ---------------- */

section('5. 新增贷款（弹层 + 保存）');
M.setTab('home');
fireClick({ 'data-action': 'add-loan' });
eq(els.sheet.hidden, false, '弹层打开');
ok(els.sheetBody.innerHTML.includes('添加贷款'), '弹层标题');

const draft = M.S.draft;
draft.name = '测试贷';
draft.kind = '商贷';
draft.principal = '500000';
draft.annualRate = '3.1';
draft.termMonths = '240';
draft.method = 'equal_installment';
draft.firstPaymentDate = '2025-01-15';
M.saveLoan();

eq(M.S.state.loans.length, 3, '贷款数 3');
eq(els.sheet.hidden, true, '保存后弹层关闭');
const added = M.S.state.loans[2];
eq(added.name, '测试贷', '名称保存');
ok(added.principal === 500000 && added.annualRate === 3.1, '数值转成了 number');
ok(JSON.parse(store['mortgage.dashboard.v1']).loans.length === 3, '已写入 localStorage');
M.setTab('home');
ok(!view().includes('示例数据'), '保存后不再显示示例数据提示');

/* ---------------- 6. 校验 ---------------- */

section('6. 非法输入拦截');
fireClick({ 'data-action': 'add-loan' });
M.S.draft.principal = '0';
M.S.draft.termMonths = '240';
M.S.draft.firstPaymentDate = '2025-01-15';
M.saveLoan();
eq(M.S.state.loans.length, 3, '本金为 0 不新增');
eq(els.toast.textContent, '贷款本金要大于 0', '给出提示');
eq(els.sheet.hidden, false, '弹层保持打开');

M.S.draft.principal = '300000';
M.S.draft.firstPaymentDate = '';
M.saveLoan();
eq(els.toast.textContent, '请选择首次还款日', '缺日期给出提示');
M.closeSheet();

/* ---------------- 7. 编辑 ---------------- */

section('7. 编辑已有贷款');
M.openEditor('gj');
eq(M.S.draft.name, '公积金贷', '回填名称');
M.S.draft.annualRate = '3.0';
M.saveLoan();
const gj = M.S.state.loans.filter((l) => l.id === 'gj')[0];
eq(gj.annualRate, 3, '利率已改为 3.0');

/* ---------------- 8. 提前还款 ---------------- */

section('8. 提前还款');
M.openEditor('sd');
M.S.draft.prepayments.push({ date: '2025-06-20', amount: '100000', mode: 'shorten_term' });
M.saveLoan();
const sd = M.S.state.loans.filter((l) => l.id === 'sd')[0];
eq(sd.prepayments.length, 1, '提前还款已保存');
ok(sd.prepayments[0].amount === 100000, '金额为 number');

M.setTab('plan');
const plan2 = view();
ok(plan2.includes('提前还'), '计划页出现提前还款说明');
ok(plan2.includes('缩期限'), '说明里写明处理方式');
const sdRows = M.analysis().loans.filter((x) => x.loan.id === 'sd')[0];
ok(sdRows.rows.length < 300, '商贷期数被缩短', sdRows.rows.length);
ok(sdRows.stats.savedInterest > 0, '省下利息 > 0', sdRows.stats.savedInterest.toFixed(2));

/* ---------------- 9. 删除 ---------------- */

section('9. 删除贷款');
M.openEditor('gj');
const before = M.S.state.loans.length;
M.__del = before;
fireClick({ 'data-action': 'edit-loan', 'data-id': 'gj' });
// deleteLoan 通过弹层按钮触发，这里直接调用
els.sheetBody.listeners.click[0]({
  target: { closest: () => ({ getAttribute: (n) => (n === 'data-act' ? 'delete' : null) }) }
});
eq(M.S.state.loans.length, before - 1, '删除后少一笔');
eq(els.sheet.hidden, true, '删除后弹层关闭');

/* ---------------- 10. 空数据 ---------------- */

section('10. 空数据 / 重置');
M.setTab('home');
fireClick({ 'data-action': 'reset' });
eq(M.S.state.loans.length, 2, '恢复示例数据');
ok(view().includes('剩余本金'), '重置后正常渲染');

/* ---------------- 11. GitHub 同步 ---------------- */

section('11. GitHub 同步');

eq(M.gh.encode('{"a":1}'), 'eyJhIjoxfQ==', 'base64 编码与标准一致');
const zhText = '贷款 ¥93.58万';
eq(M.gh.decode(M.gh.encode(zhText)), zhText, '中文金额编解码往返一致');
eq(M.gh.encode(''), '', '空字符串编码');
eq(M.gh.decode(''), '', '空字符串解码');

eq(M.gh.url({ repo: 'me/loan-data', path: 'state.json' }), 'https://api.github.com/repos/me/loan-data/contents/state.json', 'Contents URL');
eq(M.gh.url({ repo: 'me/loan-data', path: 'd/state.json', branch: 'dev' }, true),
  'https://api.github.com/repos/me/loan-data/contents/d/state.json?ref=dev', '带分支的读取 URL');

const hdr = M.gh.headers({ repo: 'me/x', token: 'tok123' });
eq(hdr.Authorization, 'Bearer tok123', 'Bearer 令牌');
eq(hdr['X-GitHub-Api-Version'], '2022-11-28', 'API 版本头');

/* 用一个假 fetch 走完整的 push / pull */
const calls = [];
let remote = null;
function resp(status, obj) {
  const text = JSON.stringify(obj);
  return {
    status: status,
    ok: status >= 200 && status < 300,
    text: function () { return Promise.resolve(text); },
    json: function () { return Promise.resolve(JSON.parse(text)); }
  };
}
global.fetch = function (url, opt) {
  calls.push({ url: url, method: (opt && opt.method) || 'GET', body: opt && opt.body });
  if ((opt && opt.method) === 'PUT') {
    const body = JSON.parse(opt.body);
    remote = { content: body.content.replace(/\n/g, ''), sha: 'abc1234567890' };
    return Promise.resolve(resp(200, { commit: { sha: 'fedcba9876543' } }));
  }
  if (remote === null) return Promise.resolve(resp(404, { message: 'Not Found' }));
  return Promise.resolve(resp(200, { content: remote.content, sha: remote.sha }));
};

const ghPushIn = async function () {
  M.S.state.github = { repo: 'me/loan-data', path: 'state.json', branch: 'main', token: 'tok123' };
  await M.gh.push();
  return calls.slice();
};

const ghPullIn = async function () {
  M.S.state.loans = [];
  await M.gh.pull();
  return M.S.state.loans.length;
};

(async function () {
  const pushCalls = await ghPushIn();
  eq(pushCalls.length, 2, 'push 先 GET 拿 sha 再 PUT');
  eq(pushCalls[1].method, 'PUT', '第二次是 PUT');
  const sent = JSON.parse(pushCalls[1].body);
  eq(sent.branch, 'main', 'PUT 带分支');
  ok(typeof sent.message === 'string' && sent.message.length > 0, 'PUT 带 commit message');
  ok(sent.sha === undefined, '文件不存在时不带 sha（新建）');
  const decoded = JSON.parse(M.gh.decode(sent.content));
  eq(decoded.loans.length, 2, '上传内容含两笔贷款');
  ok(M.S.state.loans.length === 2, '上传后本地数据不变');
  eq(M.S.state.github.token, 'tok123', '上传后 token 仍保留');

  const n = await ghPullIn();
  eq(n, 2, '从 GitHub 拉回两笔贷款');
  eq(M.S.state.github.repo, 'me/loan-data', '拉取后保留仓库配置');
  eq(M.S.state.github.token, 'tok123', '拉取后保留 token');

  finish();
})();

/* ---------------- 结果 ---------------- */

function finish() {
  console.log('\n' + '='.repeat(46));
  if (failures.length === 0) {
    console.log('全部通过：' + pass + ' passed, 0 failed');
    process.exit(0);
  } else {
    console.log('失败：' + pass + ' passed, ' + failures.length + ' failed');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
}
