/* ==========================================================================
 * 房贷看板 · Scriptable 桌面小组件
 *
 * 用法（3 分钟）：
 *   1. App Store 装 Scriptable（免费）
 *   2. 新建脚本，把本文件全部内容粘进去
 *   3. 改下面 CONFIG：
 *        · 零服务器：把网页「数据同步 → 复制小组件配置」的内容粘到 CONFIG.state
 *        · 有 Cloudflare Worker：填 CONFIG.remote.url / token，state 可留 null
 *   4. 长按桌面 → 左上角 + → Scriptable → 选本脚本 → 选小/中/大
 *
 * 说明：计算全部在本地完成（引擎已内联），不联网也能用；
 *       不存每期流水，只存合同参数 + 事件，所以任何一天打开都是对的。
 * ========================================================================== */

/* ======================= ① 只改这里 ======================= */
const CONFIG = {
  title: '我的房贷',

  // 本地数据（把网页「复制小组件配置」的结果粘在这里，形如 {"loans":[...]}）
  state: null,

  // 云端数据（可选）。填了地址就优先读云端，失败自动回退到 state
  remote: {
    url: '',      // 例：https://loan-sync.xxx.workers.dev
    token: '',    // 和 worker 里设置的 TOKEN 一致
  },

  // 点小组件要打开的网址（可选，比如部署在 GitHub Pages 的看板）
  openUrl: '',

  // 要不要显示「每笔贷款」明细（大号组件才有空间）
  showLoans: true,
};
/* ======================= ① 到此为止 ======================= */

/* ---- 计算引擎（由 tools/build.js 自动内联，不要手改） ---- */
// >>> ENGINE BEGIN
    /* engine/loan.js · 构建于 2026-11-11 08:59:42 · 改引擎请改源文件再重新构建 */
    /*!
     * loan.js — 房贷计算引擎
     * 支持：等额本息 / 等额本金 / 组合贷（多笔）/ 提前还款（缩期、降月供、结清）/ 利率调整（LPR 重定价）
     * 纯函数、零依赖。浏览器（window.LoanEngine）、Node（require）、Scriptable（globalThis）通用。
     */
    (function (root, factory) {
      var api = factory();
      if (typeof module === 'object' && module.exports) module.exports = api;
      if (root && typeof root === 'object') root.LoanEngine = api;
    })(typeof globalThis !== 'undefined' ? globalThis : this, function () {
      'use strict';

      var MAX_PERIODS = 1200;   // 最多 100 年，防死循环
      var CENT = 0.005;         // 半分钱，视为 0

      /* ------------------------------------------------------------------ *
       * 基础工具
       * ------------------------------------------------------------------ */

      function num(v, dflt) {
        if (typeof v === 'number') return isFinite(v) ? v : (dflt || 0);
        if (v === null || v === undefined || v === '') return dflt || 0;
        var n = parseFloat(String(v).replace(/[,，\s¥￥]/g, ''));
        return isFinite(n) ? n : (dflt || 0);
      }

      function pad2(n) { return n < 10 ? '0' + n : '' + n; }

      /** 'YYYY-MM-DD' | Date -> Date（本地时间 12:00，规避时区/夏令时） */
      function parseDate(v) {
        if (!v) return null;
        if (v instanceof Date) {
          return isNaN(v.getTime()) ? null : new Date(v.getFullYear(), v.getMonth(), v.getDate(), 12);
        }
        var m = String(v).trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
        if (!m) return null;
        var d = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0);
        return isNaN(d.getTime()) ? null : d;
      }

      function fmtDate(d) {
        var x = d instanceof Date ? d : parseDate(d);
        if (!x) return '';
        return x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
      }

      function today() { return fmtDate(new Date()); }

      /** 加 k 个月，日期超出目标月天数时取该月最后一天（31 号 -> 2 月 28 日） */
      function addMonths(base, k) {
        var y = base.getFullYear(), m = base.getMonth() + k, d = base.getDate();
        var last = new Date(y, m + 1, 0).getDate();
        return new Date(y, m, Math.min(d, last), 12, 0, 0, 0);
      }

      function daysBetween(a, b) { return Math.round((b.getTime() - a.getTime()) / 86400000); }

      function roundC(x) { return Math.round(x * 100) / 100; }
      function roundYuan(x) { return Math.round(x); }

      /* ------------------------------------------------------------------ *
       * 房贷公式
       * ------------------------------------------------------------------ */

      /** 等额本息月供：A = P·r·(1+r)^n / ((1+r)^n − 1) */
      function pmt(P, r, n) {
        if (n <= 0) return P;
        if (r <= 1e-12) return P / n;
        var f = Math.pow(1 + r, n);
        return P * r * f / (f - 1);
      }

      /** 已知月供 A、余额 P、月利率 r，反解还需要多少期（向上取整） */
      function periodsFor(P, r, A) {
        if (P <= CENT) return 0;
        if (!(A > 0)) return MAX_PERIODS;
        if (r <= 1e-12) return Math.max(1, Math.ceil(P / A));
        if (A <= P * r) return MAX_PERIODS;      // 月供不抵利息，永远还不完
        var x = A / (A - P * r);
        if (!isFinite(x) || x <= 1) return MAX_PERIODS;
        return Math.max(1, Math.ceil(Math.log(x) / Math.log(1 + r) - 1e-9));
      }

      /** 等额本息：总利息（理论值，未含提前还款） */
      function totalInterest(P, annualRate, n) {
        var r = num(annualRate) / 1200;
        return pmt(P, r, n) * n - P;
      }

      /* ------------------------------------------------------------------ *
       * 单笔贷款模拟
       * ------------------------------------------------------------------ */

      function normRateChanges(list) {
        return (list || []).map(function (x) {
          return {
            date: parseDate(x.fromDate || x.date),
            rate: Math.max(0, num(x.annualRate, 0))
          };
        }).filter(function (x) { return x.date; })
          .sort(function (a, b) { return a.date - b.date; });
      }

      function normPrepayments(list) {
        return (list || []).map(function (x) {
          return {
            date: parseDate(x.date),
            payoff: !!x.payoff,
            amount: Math.max(0, num(x.amount, 0)),
            mode: x.mode === 'reduce_payment' ? 'reduce_payment' : 'shorten_term'
          };
        }).filter(function (x) { return x.date; })
          .sort(function (a, b) { return a.date - b.date; });
      }

      /**
       * 逐期模拟，返回完整还款计划。
       * 提前还款记在「还款日 >= 提前还款日」的那一期之后，随后按 mode 重算剩余计划。
       */
      function simulate(rawLoan) {
        var L = rawLoan || {};
        var principal0 = num(L.principal, 0);
        var term = Math.max(1, Math.round(num(L.termMonths, 360)));
        var method = L.method === 'equal_principal' ? 'equal_principal' : 'equal_installment';
        var annual = Math.max(0, num(L.annualRate, 0));
        var first = parseDate(L.firstPaymentDate);

        if (!(principal0 > 0)) return { ok: false, error: '贷款本金必须大于 0' };
        if (!first) return { ok: false, error: '首次还款日无效' };

        var rateChanges = normRateChanges(L.rateChanges);
        var preps = normPrepayments(L.prepayments);

        var rate = annual / 1200;              // 月利率（annualRate 以百分数存储，4.9 = 4.9%）
        var balance = principal0;
        var plannedEnd = term;                  // 计划最后一期的期号
        var emi = roundC(pmt(balance, rate, term));
        var step = principal0 / term;           // 等额本金：每期本金
        var rows = [];
        var rci = 0, pi = 0, p = 0;

        while (balance > CENT && p < MAX_PERIODS) {
          p += 1;
          var due = addMonths(first, p - 1);

          /* --- 利率调整：从还款日 >= 生效日的这一期开始用新利率 --- */
          var rateChanged = false;
          while (rci < rateChanges.length && rateChanges[rci].date <= due) {
            rate = rateChanges[rci].rate / 1200;
            rci += 1;
            rateChanged = true;
          }
          if (rateChanged && p <= plannedEnd && method === 'equal_installment') {
            emi = roundC(pmt(balance, rate, plannedEnd - p + 1));
          }

          /* --- 当期利息 / 本金 / 月供 --- */
          var interest = balance * rate;
          var princ, pay;
          if (method === 'equal_installment') {
            pay = emi;
            if (p >= plannedEnd || pay >= balance + interest - CENT) {
              princ = balance;
              pay = princ + interest;
            } else {
              princ = pay - interest;
            }
          } else {
            princ = step;
            if (p >= plannedEnd || princ >= balance - CENT) princ = balance;
            pay = princ + interest;
          }
          balance -= princ;
          if (balance < CENT) balance = 0;

          var row = {
            p: p,
            date: fmtDate(due),
            payment: pay,
            principal: princ,
            interest: interest,
            balance: balance,
            annualRate: rate * 1200,
            prepay: 0,
            mode: 'normal'
          };

          /* --- 提前还款：发生在当期还款之后 --- */
          var prepaySum = 0;
          var lastPrepayMode = '';
          var lastPrepayDate = '';
          while (pi < preps.length && preps[pi].date <= due) {
            var pp = preps[pi];
            pi += 1;
            lastPrepayMode = pp.mode || 'shorten_term';
            lastPrepayDate = fmtDate(pp.date);
            if (balance <= CENT) continue;
            var amt = pp.payoff ? balance : Math.min(pp.amount, balance);
            if (!(amt > CENT)) continue;
            balance -= amt;
            prepaySum += amt;
            if (balance < CENT) { balance = 0; break; }

            var left = plannedEnd - p;
            if (left > 0) {
              if (pp.mode === 'shorten_term') {
                // 月供不变，缩短期限
                if (method === 'equal_installment') {
                  plannedEnd = p + periodsFor(balance, rate, emi);
                } else {
                  plannedEnd = p + Math.max(1, Math.ceil((balance - CENT) / (step || 1)));
                }
              } else {
                // 期限不变，降低月供
                if (method === 'equal_installment') emi = roundC(pmt(balance, rate, left));
                else step = balance / left;
              }
            }
          }
          if (prepaySum > CENT) {
            row.prepay = prepaySum;
            row.balance = balance;
            row.mode = 'prepay';
            row.prepayMode = lastPrepayMode;
            row.prepayDate = lastPrepayDate;
          }

          rows.push(row);
          if (balance <= CENT || p >= plannedEnd) break;
        }

        return { ok: true, rows: rows, principal0: principal0, term: term, method: method, annualRate: annual, firstPaymentDate: fmtDate(first) };
      }

      /* ------------------------------------------------------------------ *
       * 单笔贷款：模拟 + 汇总
       * ------------------------------------------------------------------ */

      function summarize(sim, asOf) {
        var asOfT = asOf.getTime();
        var rows = sim.rows;
        var paidPrincipal = 0, paidInterest = 0, paidPayment = 0;
        var remainPrincipal = 0, remainInterest = 0, remainPayment = 0;
        var next = null, paidCount = 0;
        var i, r;

        for (i = 0; i < rows.length; i++) {
          r = rows[i];
          r.paid = parseDate(r.date).getTime() <= asOfT;
          if (r.paid) {
            paidCount += 1;
            paidPrincipal += r.principal + r.prepay;
            paidInterest += r.interest;
            paidPayment += r.payment + r.prepay;
          } else {
            remainPrincipal += r.principal;
            remainInterest += r.interest;
            remainPayment += r.payment;
            if (!next) next = r;
          }
        }

        // 已计提但未到还款日的利息（按天折算当期利息）
        var accrued = 0;
        if (next) {
          var idx = rows.indexOf(next);
          var prevDate = idx > 0 ? parseDate(rows[idx - 1].date) : addMonths(parseDate(sim.firstPaymentDate), -1);
          var dueDate = parseDate(next.date);
          var span = Math.max(1, daysBetween(prevDate, dueDate));
          var elapsed = Math.min(Math.max(0, daysBetween(prevDate, asOf)), span);
          accrued = next.interest * (elapsed / span);
          if (asOf >= dueDate) accrued = next.interest;
        }

        var totalInterest = paidInterest + remainInterest;
        var totalPayment = paidPayment + remainPayment;
        var progress = sim.principal0 > 0 ? Math.min(1, paidPrincipal / sim.principal0) : 1;

        return {
          ok: true,
          rows: rows,
          stats: {
            principal: sim.principal0,
            method: sim.method,
            methodName: sim.method === 'equal_principal' ? '等额本金' : '等额本息',
            annualRate: sim.annualRate,
            rate: (next ? next.annualRate : sim.annualRate),
            termMonths: sim.term,
            scheduleMonths: rows.length,
            firstPaymentDate: sim.firstPaymentDate,
            endDate: rows.length ? rows[rows.length - 1].date : sim.firstPaymentDate,
            periodsPaid: paidCount,
            periodsTotal: rows.length,
            periodsLeft: rows.length - paidCount,
            paidPrincipal: paidPrincipal,
            paidInterest: paidInterest,
            paidTotal: paidPrincipal + paidInterest,
            remainingPrincipal: remainPrincipal,
            remainingInterest: remainInterest,
            remainingTotal: remainPrincipal + remainInterest,
            totalInterest: totalInterest,
            totalPayment: totalPayment,
            progress: progress,
            monthlyPayment: next ? next.payment : 0,
            nextPayment: next ? { p: next.p, date: next.date, payment: next.payment, principal: next.principal, interest: next.interest } : null,
            accruedInterest: accrued,
            cleared: !next
          }
        };
      }

      /** 构建一笔贷款的完整结果（含提前还款省下的利息） */
      function buildLoan(loan, asOfInput) {
        var asOf = parseDate(asOfInput) || parseDate(today());
        var sim = simulate(loan);
        if (!sim.ok) return sim;

        var out = summarize(sim, asOf);
        var preps = (loan && loan.prepayments) || [];
        if (preps.length) {
          var baseLoan = {};
          for (var k in loan) if (Object.prototype.hasOwnProperty.call(loan, k)) baseLoan[k] = loan[k];
          baseLoan.prepayments = [];
          var baseSim = simulate(baseLoan);
          if (baseSim.ok) {
            var base = summarize(baseSim, asOf);
            out.stats.baselineInterest = base.stats.totalInterest;
            out.stats.savedInterest = Math.max(0, base.stats.totalInterest - out.stats.totalInterest);
          }
        }
        return out;
      }

      /* ------------------------------------------------------------------ *
       * 组合贷 / 多笔汇总
       * ------------------------------------------------------------------ */

      function analyze(state, asOfInput) {
        var st = state || {};
        var asOf = parseDate(asOfInput || st.asOf) || parseDate(today());
        var loans = (st.loans || []).slice();
        var outLoans = [];
        var errors = [];

        for (var i = 0; i < loans.length; i++) {
          var L = loans[i];
          var res = buildLoan(L, asOf);
          if (!res.ok) {
            errors.push((L.name || '第 ' + (i + 1) + ' 笔') + '：' + res.error);
            continue;
          }
          res.loan = {
            id: L.id || ('loan-' + i),
            name: L.name || ('贷款 ' + (i + 1)),
            kind: L.kind || '商贷',
            method: L.method,
            principal: num(L.principal),
            annualRate: num(L.annualRate)
          };
          outLoans.push(res);
        }

        var t = {
          principal: 0, paidPrincipal: 0, paidInterest: 0, paidTotal: 0,
          remainingPrincipal: 0, remainingInterest: 0, remainingTotal: 0,
          totalInterest: 0, totalPayment: 0, savedInterest: 0,
          periodsPaid: 0, periodsTotal: 0, periodsLeft: 0,
          monthlyPayment: 0, accruedInterest: 0
        };
        for (var j = 0; j < outLoans.length; j++) {
          var s = outLoans[j].stats;
          t.principal += s.principal;
          t.paidPrincipal += s.paidPrincipal;
          t.paidInterest += s.paidInterest;
          t.paidTotal += s.paidTotal;
          t.remainingPrincipal += s.remainingPrincipal;
          t.remainingInterest += s.remainingInterest;
          t.remainingTotal += s.remainingTotal;
          t.totalInterest += s.totalInterest;
          t.totalPayment += s.totalPayment;
          t.accruedInterest += s.accruedInterest;
          t.savedInterest += s.savedInterest || 0;
          t.periodsTotal = Math.max(t.periodsTotal, s.periodsTotal);
          t.periodsPaid = Math.max(t.periodsPaid, s.periodsPaid);
          t.periodsLeft = Math.max(t.periodsLeft, s.periodsLeft);
        }
        t.progress = t.principal > 0 ? Math.min(1, t.paidPrincipal / t.principal) : 1;

        // 下一期：取最早的那次还款
        var nextDate = null;
        for (var m = 0; m < outLoans.length; m++) {
          var nx = outLoans[m].stats.nextPayment;
          if (nx && (!nextDate || nx.date < nextDate)) nextDate = nx.date;
        }
        var next = null;
        if (nextDate) {
          next = { date: nextDate, amount: 0, principal: 0, interest: 0, items: [] };
          for (var n = 0; n < outLoans.length; n++) {
            var n2 = outLoans[n].stats.nextPayment;
            if (n2 && n2.date === nextDate) {
              next.amount += n2.payment;
              next.principal += n2.principal;
              next.interest += n2.interest;
              next.items.push({ name: outLoans[n].loan.name, amount: n2.payment });
            }
          }
        }
        t.nextPayment = next;
        t.monthlyPayment = next ? next.amount : 0;

        return {
          asOf: fmtDate(asOf),
          loans: outLoans,
          totals: t,
          errors: errors,
          ok: errors.length === 0
        };
      }

      /* ------------------------------------------------------------------ *
       * 展示格式化
       * ------------------------------------------------------------------ */

      function fmtMoney(x, digits) {
        var d = digits === undefined ? 2 : digits;
        var n = num(x, 0);
        var neg = n < 0;
        n = Math.abs(n);
        var s = n.toFixed(d);
        var parts = s.split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return (neg ? '-' : '') + parts.join('.');
      }

      function trimZero(s) { return s.replace(/\.?0+$/, ''); }

      /** 金额转「万/亿」，适合小屏 */
      function fmtWan(x) {
        var n = num(x, 0);
        if (Math.abs(n) >= 1e8) return trimZero((n / 1e8).toFixed(2)) + '亿';
        if (Math.abs(n) >= 1e4) return trimZero((n / 1e4).toFixed(2)) + '万';
        return fmtMoney(n, 0);
      }

      function fmtPct(x, digits) {
        var d = digits === undefined ? 2 : digits;
        return (num(x, 0) * 100).toFixed(d) + '%';
      }

      /** 剩余期数 -> 「2 年 4 个月」 */
      function fmtMonths(n) {
        n = Math.max(0, Math.round(num(n, 0)));
        var y = Math.floor(n / 12), m = n % 12;
        if (!y) return m + ' 个月';
        return m ? y + ' 年 ' + m + ' 个月' : y + ' 年';
      }

      return {
        version: '1.0.0',
        parseDate: parseDate,
        fmtDate: fmtDate,
        addMonths: addMonths,
        daysBetween: daysBetween,
        today: today,
        num: num,
        pmt: pmt,
        periodsFor: periodsFor,
        totalInterest: totalInterest,
        simulate: simulate,
        buildLoan: buildLoan,
        analyze: analyze,
        money: roundC,
        roundYuan: roundYuan,
        fmtMoney: fmtMoney,
        fmtWan: fmtWan,
        fmtPct: fmtPct,
        fmtMonths: fmtMonths
      };
    });
    // <<< ENGINE END

const E = (typeof LoanEngine !== 'undefined') ? LoanEngine : globalThis.LoanEngine;

/* ---------------- 取数据 ---------------- */
const CACHE_PATH = 'mortgage-widget-cache.json';

async function loadState() {
  const fm = FileManager.local();
  let cached = null;
  try {
    if (fm.fileExists(fm.joinPath(fm.documentsDirectory(), CACHE_PATH))) {
      cached = JSON.parse(fm.readString(fm.joinPath(fm.documentsDirectory(), CACHE_PATH)));
    }
  } catch (e) { cached = null; }

  const remote = CONFIG.remote || {};
  if (remote.url) {
    try {
      const req = new Request(remote.url.replace(/\/+$/, '') + '/api/state');
      req.timeoutInterval = 12;
      if (remote.token) req.headers = { Authorization: 'Bearer ' + remote.token };
      const st = await req.loadJSON();
      if (st && Array.isArray(st.loans)) {
        fm.writeString(fm.joinPath(fm.documentsDirectory(), CACHE_PATH), JSON.stringify(st));
        return { state: st, source: '云端' };
      }
    } catch (e) {
      // 网络失败就用缓存，缓存没有再用本地配置
    }
  }

  if (cached && Array.isArray(cached.loans)) return { state: cached, source: '缓存' };
  if (CONFIG.state && Array.isArray(CONFIG.state.loans)) return { state: CONFIG.state, source: '本地' };

  return { state: null, source: '' };
}

/* ---------------- 小工具 ---------------- */
const C = {
  bg1: '#12203a',
  bg2: '#070b14',
  mint: '#3ddc97',
  amber: '#ffb454',
  blue: '#6aa6ff',
  text: '#e8eefc',
  mute: '#8b9bb4',
  line: '#1d2a44',
};

function text(parent, str, size, color, weight) {
  const t = parent.addText(String(str));
  t.font = weight === 'bold' ? Font.boldSystemFont(size)
    : weight === 'heavy' ? Font.heavySystemFont(size)
    : Font.systemFont(size);
  t.textColor = new Color(color || C.text, 1);
  t.minimumScaleFactor = 0.6;
  t.lineLimit = 1;
  return t;
}

function bar(parent, pct, width) {
  const w = Math.max(0, Math.min(1, pct || 0));
  const track = parent.addStack();
  track.size = new Size(width, 5);
  track.backgroundColor = new Color(C.line, 1);
  track.cornerRadius = 2.5;

  const fill = track.addStack();
  fill.size = new Size(Math.max(2, Math.round(width * w)), 5);
  fill.backgroundColor = new Color(C.mint, 1);
  fill.cornerRadius = 2.5;
  track.addSpacer(0);
}

function wan(n) {
  const v = Math.abs(n) >= 10000 ? (n / 10000).toFixed(2) + '万' : E.fmtMoney(n);
  return '¥' + v;
}

function mmdd(iso) {
  if (!iso) return '—';
  const p = String(iso).split('-');
  return p.length === 3 ? p[1] + '-' + p[2] : iso;
}

/* ---------------- 组装 ---------------- */
function build(a, family) {
  const w = new ListWidget();
  const g = new LinearGradient();
  g.colors = [new Color(C.bg1, 1), new Color(C.bg2, 1)];
  g.locations = [0, 1];
  g.startPoint = new Point(0, 0);
  g.endPoint = new Point(1, 1);
  w.backgroundGradient = g;

  const small = family === 'small';
  w.setPadding(small ? 12 : 14, small ? 12 : 16, small ? 12 : 14, small ? 12 : 16);

  const t = a.totals;

  /* 顶部一行：剩余本金 + 截至 */
  const head = w.addStack();
  head.centerAlignContent();
  text(head, '剩余本金', small ? 10 : 11, C.mute);
  head.addSpacer();
  text(head, '截至 ' + mmdd(a.asOf), 10, C.mute);

  w.addSpacer(small ? 3 : 2);

  const big = text(w, wan(t.remainingPrincipal), small ? 22 : 27, C.text, 'heavy');
  big.minimumScaleFactor = 0.5;

  w.addSpacer(5);
  const barW = small ? 118 : Math.round(Device.screenSize().width * 0.78);
  bar(w, t.progress, barW);
  w.addSpacer(4);

  const sub = w.addStack();
  text(sub, '已还 ' + t.periodsPaid + '/' + t.periodsTotal + ' 期 · ' + (t.progress * 100).toFixed(1) + '%', 10, C.mute);
  sub.addSpacer();
  text(sub, '下次 ' + mmdd(t.nextPayment && t.nextPayment.date), 10, C.mute);

  if (small) {
    w.addSpacer(6);
    const line = w.addStack();
    line.centerAlignContent();
    text(line, '本期 ', 10, C.mute);
    text(line, '¥' + E.fmtMoney(t.monthlyPayment), 15, C.mint, 'bold');
    w.addSpacer();
    if (CONFIG.openUrl) w.url = CONFIG.openUrl;
    w.refreshAfterDate = new Date(Date.now() + 3 * 60 * 60 * 1000);
    return w;
  }

  /* 中/大号：三列数字 */
  w.addSpacer(8);
  const row = w.addStack();
  const cells = [
    ['本期应还', '¥' + E.fmtMoney(t.monthlyPayment), C.mint],
    ['已还利息', wan(t.paidInterest + t.accruedInterest), C.amber],
    ['剩余利息', wan(t.remainingInterest), C.blue],
  ];
  cells.forEach((c, i) => {
    const col = row.addStack();
    col.layoutVertically();
    text(col, c[0], 10, C.mute);
    text(col, c[1], 14, c[2], 'bold');
    if (i < cells.length - 1) row.addSpacer();
  });

  /* 大号：全程概览 + 每笔贷款 */
  if (family === 'large') {
    w.addSpacer(10);
    const ends = a.loans.map((x) => x.stats.endDate).filter(Boolean).sort();
    const rows = [
      ['贷款总额', wan(t.principal)],
      ['已还本息', wan(t.paidTotal)],
      ['剩余本息', wan(t.remainingTotal)],
      ['全程利息', wan(t.totalInterest)],
      ['预计结清', ends.length ? ends[ends.length - 1].slice(0, 7) : '—'],
    ];
    rows.forEach((r) => {
      const line = w.addStack();
      text(line, r[0], 10, C.mute);
      line.addSpacer();
      text(line, r[1], 10, C.text);
    });

    if (CONFIG.showLoans) {
      w.addSpacer(10);
      a.loans.forEach((item) => {
        const l = item.loan;
        const line = w.addStack();
        line.centerAlignContent();
        const dot = line.addStack();
        dot.size = new Size(6, 6);
        dot.cornerRadius = 3;
        dot.backgroundColor = new Color(l.kind === '公积金' ? C.mint : C.blue, 1);
        line.addSpacer(6);
        text(line, l.name, 11, C.text);
        line.addSpacer();
        text(line, (l.annualRate || 0).toFixed(2) + '%', 10, C.mute);
        line.addSpacer(8);
        text(line, wan(item.stats.remainingPrincipal), 11, C.text, 'bold');
      });
    }
  }

  w.addSpacer();
  if (CONFIG.openUrl) w.url = CONFIG.openUrl;
  w.refreshAfterDate = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return w;
}

/* ---------------- 入口 ---------------- */
const family = config.widgetFamily || 'medium';
const loaded = await loadState();

if (!loaded.state) {
  const w = new ListWidget();
  w.backgroundColor = new Color(C.bg2, 1);
  w.setPadding(14, 14, 14, 14);
  text(w, '还没配置数据', 13, C.text, 'bold');
  w.addSpacer(6);
  text(w, '打开网页看板 → 数据同步 → 复制小组件配置 → 粘到脚本的 CONFIG.state', 10, C.mute).lineLimit = 4;
  w.addSpacer();
  if (CONFIG.openUrl) w.url = CONFIG.openUrl;
  Script.setWidget(w);
  if (!config.runsInWidget) w.presentMedium();
  Script.complete();
} else {
  const a = E.analyze(loaded.state, E.today());
  const w = build(a, family);
  Script.setWidget(w);
  if (!config.runsInWidget) {
    if (family === 'small') w.presentSmall();
    else if (family === 'large') w.presentLarge();
    else w.presentMedium();
  }
  Script.complete();
}
