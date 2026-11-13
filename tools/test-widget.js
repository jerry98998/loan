/* tools/test-widget.js — 在没有 Scriptable 的环境里跑一遍小组件脚本
 * 用最小 API 垫片模拟 Scriptable，检查：不报错、能出小组件、关键数字正确。
 * 用法：node tools/test-widget.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'widget', 'dist', 'mortgage-widget.js');
const E = require(path.join(ROOT, 'engine', 'loan.js'));

/* ---------------- 垫片 ---------------- */
function MockText(s) { this.text = String(s); }
MockText.prototype = {
  set font(v) { this._f = v; }, get font() { return this._f; },
  set textColor(v) { this._c = v; }, get textColor() { return this._c; },
};

function MockStack(children) {
  this.children = children || [];
  this.size = null;
  this.backgroundColor = null;
  this.cornerRadius = 0;
}
MockStack.prototype.addText = function (s) {
  const t = new MockText(s);
  this.children.push(t);
  return t;
};
MockStack.prototype.addStack = function () {
  const s = new MockStack();
  this.children.push(s);
  return s;
};
MockStack.prototype.addSpacer = function (n) { this.children.push({ spacer: n }); };
MockStack.prototype.addImage = function (img) { this.children.push(img); };
MockStack.prototype.layoutVertically = function () { this.vertical = true; };
MockStack.prototype.centerAlignContent = function () { this.center = true; };

function MockWidget() { MockStack.call(this); }
MockWidget.prototype = Object.create(MockStack.prototype);
MockWidget.prototype.presentSmall = function () { this.presented = 'small'; };
MockWidget.prototype.presentMedium = function () { this.presented = 'medium'; };
MockWidget.prototype.presentLarge = function () { this.presented = 'large'; };
MockWidget.prototype.setPadding = function (t, l, b, r) { this.padding = [t, l, b, r]; };

function Color(h, a) { this.hex = h; this.alpha = a; }
function Size(w, h) { this.width = w; this.height = h; }
function Point(x, y) { this.x = x; this.y = y; }
function LinearGradient() { this.colors = []; this.locations = []; }

const Font = {
  boldSystemFont: (n) => ({ kind: 'bold', n }),
  heavySystemFont: (n) => ({ kind: 'heavy', n }),
  systemFont: (n) => ({ kind: 'system', n }),
};

let captured = null;

function installGlobals(family) {
  globalThis.ListWidget = MockWidget;
  globalThis.Color = Color;
  globalThis.Size = Size;
  globalThis.Point = Point;
  globalThis.LinearGradient = LinearGradient;
  globalThis.Font = Font;
  globalThis.Device = { screenSize: () => new Size(390, 844) };
  globalThis.FileManager = {
    local: () => ({
      documentsDirectory: () => '/tmp',
      joinPath: (a, b) => a + '/' + b,
      fileExists: () => false,
      readString: () => '',
      writeString: () => {},
    }),
  };
  globalThis.Script = {
    setWidget: (w) => { captured = w; },
    complete: () => {},
  };
  globalThis.config = { runsInWidget: true, widgetFamily: family || 'medium' };
  globalThis.Request = function (url) {
    this.url = url;
    this.headers = {};
    this.loadJSON = async () => {
      if (GH_REPLY && String(url).indexOf('api.github.com') >= 0) return GH_REPLY;
      throw new Error('no network in test');
    };
  };
  globalThis.Data = {
    fromBase64String: (s) => ({ toRawString: () => Buffer.from(String(s), 'base64').toString('utf8') }),
  };
}

let GH_REPLY = null;

function collect(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (node instanceof MockText) { out.push(node.text); return out; }
  if (Array.isArray(node.children)) {
    node.children.forEach((c) => collect(c, out));
  }
  return out;
}

/* ---------------- 用例 ---------------- */
const DEMO = {
  v: 1,
  name: '我的房贷',
  asOf: '',
  loans: [
    {
      id: 'gj', name: '公积金贷', kind: '公积金', principal: 600000, annualRate: 2.85,
      termMonths: 300, method: 'equal_installment', firstPaymentDate: '2024-06-20',
      rateChanges: [], prepayments: [],
    },
    {
      id: 'sd', name: '商贷', kind: '商贷', principal: 400000, annualRate: 4.2,
      termMonths: 300, method: 'equal_installment', firstPaymentDate: '2024-06-20',
      rateChanges: [], prepayments: [],
    },
  ],
};

const WITH_PREPAY = JSON.parse(JSON.stringify(DEMO));
WITH_PREPAY.loans[1].prepayments = [{ date: '2026-03-20', amount: 50000, mode: 'reduce_payment' }];

const WITH_EVENTS = JSON.parse(JSON.stringify(DEMO));
WITH_EVENTS.loans[1].rateChanges = [{ fromDate: '2026-06-20', annualRate: 3.6 }];
WITH_EVENTS.loans[0].prepayments = [{ date: '2025-12-20', amount: 30000, mode: 'shorten_term' }];

let pass = 0;
const fails = [];

function ok(cond, msg) {
  if (cond) { pass += 1; } else { fails.push(msg); }
}

async function runWidget(state, family, patches) {
  const src = fs.readFileSync(SRC, 'utf8');
  let patched = src.replace('state: null,', 'state: ' + JSON.stringify(state) + ',');
  (patches || []).forEach(function (p) { patched = patched.split(p[0]).join(p[1]); });
  if (patched === src) throw new Error('模板里没找到 "state: null,"，无法注入测试数据');
  installGlobals(family);
  captured = null;
  const fn = new Function('return (async () => {\n' + patched + '\n})()');
  await fn();
  return captured;
}

function wan(n) {
  const v = Math.abs(n) >= 10000 ? (n / 10000).toFixed(2) + '万' : E.fmtMoney(n);
  return '¥' + v;
}

function yuan(n) {
  return '¥' + E.fmtMoney(n);
}

async function caseOne(name, state, family) {
  const a = E.analyze(state, E.today());
  const w = await runWidget(state, family);
  const texts = collect(w, []);
  ok(!!w, name + ': 生成了 ListWidget');
  ok(texts.includes('剩余本金'), name + ': 有「剩余本金」');
  ok(texts.includes(wan(a.totals.remainingPrincipal)), name + ': 剩余本金 ' + wan(a.totals.remainingPrincipal));
  ok(texts.includes('已还 ' + a.totals.periodsPaid + '/' + a.totals.periodsTotal + ' 期 · ' +
    (a.totals.progress * 100).toFixed(1) + '%'), name + ': 期数与进度');

  if (family === 'small') {
    ok(texts.includes('本期 '), name + ': 小号有本期');
    ok(texts.includes(yuan(a.totals.monthlyPayment)), name + ': 本期金额');
  } else {
    ok(texts.includes('本期应还'), name + ': 有本期应还');
    ok(texts.includes('已还利息'), name + ': 有已还利息');
    ok(texts.includes('剩余利息'), name + ': 有剩余利息');
    ok(texts.includes(wan(a.totals.paidInterest + a.totals.accruedInterest)), name + ': 已还利息值');
    ok(texts.includes('下次 ' + (a.totals.nextPayment ? a.totals.nextPayment.date.slice(5) : '—')),
      name + ': 下次还款日');
  }

  if (family === 'large') {
    ok(texts.includes('公积金贷') && texts.includes('商贷'), name + ': 大号有分笔');
    ok(texts.includes('2.85%') && texts.includes('4.20%'), name + ': 大号有利率');
  }
  return w;
}

(async function main() {
  await caseOne('示例组合贷/中号', DEMO, 'medium');
  await caseOne('示例组合贷/小号', DEMO, 'small');
  await caseOne('示例组合贷/大号', DEMO, 'large');
  await caseOne('带提前还款', WITH_PREPAY, 'medium');
  await caseOne('带利率调整+缩期', WITH_EVENTS, 'large');

  // 手动「数据基准日」：小组件与网页同一口径
  const FUTURE = JSON.parse(JSON.stringify(DEMO));
  FUTURE.asOf = '2030-01-01';
  const af = E.analyze(FUTURE, '2030-01-01');
  const wf = await runWidget(FUTURE, 'medium');
  const tf = collect(wf, []);
  ok(tf.includes('截至 01-01'), '基准日: 头部显示 01-01');
  ok(tf.includes(wan(af.totals.remainingPrincipal)), '基准日: 数字按 2030-01-01 算');

  // 空数据
  installGlobals('medium');
  captured = null;
  const src = fs.readFileSync(SRC, 'utf8');
  const fn = new Function('return (async () => {\n' + src + '\n})()');
  await fn();
  const emptyTexts = collect(captured, []);
  ok(emptyTexts.includes('还没配置数据'), '空数据: 有提示');
  ok(emptyTexts.some((t) => String(t).indexOf('CONFIG.state') >= 0), '空数据: 指明配置位置');

  // GitHub 私有仓库：从 Contents API 取同一个文件
  const GH_DATA = {
    v: 1, name: '我的房贷', asOf: '',
    loans: [{
      id: 'gh1', name: '商贷', kind: '商贷', principal: 500000, annualRate: 3.8,
      termMonths: 240, method: 'equal_installment', firstPaymentDate: '2024-06-20',
      rateChanges: [], prepayments: [],
    }],
  };
  GH_REPLY = { content: Buffer.from(JSON.stringify(GH_DATA), 'utf8').toString('base64') };
  const wgh = await runWidget({ loans: [] }, 'medium', [
    ["repo: '',", "repo: 'jerry98998/loan-data',"],
    ["token: '',", "token: 'pat_x',"],
  ]);
  const tgh = collect(wgh, []);
  const agh = E.analyze(GH_DATA, E.today());
  ok(tgh.includes(wan(agh.totals.remainingPrincipal)), 'GitHub: 用的是仓库里的数据');
  ok(tgh.some(function (t) {
    return String(t).indexOf(agh.totals.periodsPaid + '/' + agh.totals.periodsTotal) >= 0;
  }), 'GitHub: 期数来自仓库数据');
  GH_REPLY = null;

  console.log('--- widget ----------');
  console.log('passed ' + pass + ' failed ' + fails.length);
  fails.forEach((f) => console.log('FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})();
