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
    var remainInterest = 0, remainPayment = 0;
    var next = null, paidCount = 0;
    var i, r;

    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      r.paid = parseDate(r.date).getTime() <= asOfT;
      if (r.paid) {
        paidCount += 1;
        paidPrincipal += r.principal;
        paidInterest += r.interest;
        paidPayment += r.payment;
      } else {
        remainInterest += r.interest;
        remainPayment += r.payment;
        if (!next) next = r;
      }
    }

    // 已发生的提前还款：按提前还款日判断，不等那一期还款日
    var paidPrepay = 0;
    for (i = 0; i < rows.length; i++) {
      r = rows[i];
      if (r.prepay > 0) {
        var ppDate = parseDate(r.prepayDate);
        if (ppDate && ppDate.getTime() <= asOfT) {
          paidPrepay += r.prepay;
          paidPayment += r.prepay;
        }
      }
    }
    paidPrincipal += paidPrepay;
    var remainPrincipal = Math.max(0, sim.principal0 - paidPrincipal);

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
        if (n2) {
          next.amount += n2.payment;
          next.principal += n2.principal;
          next.interest += n2.interest;
          next.items.push({ name: outLoans[n].loan.name, amount: n2.payment, date: n2.date });
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
