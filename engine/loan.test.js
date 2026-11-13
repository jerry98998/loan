/* 运行：node engine/loan.test.js */
'use strict';
const E = require('./loan.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}
function near(name, actual, expect, tol, unit) {
  const d = Math.abs(actual - expect);
  ok(name + '  (' + actual.toFixed(2) + ' ≈ ' + expect + (unit || '') + ')', d <= tol, '差 ' + d.toFixed(4));
}
function section(t) { console.log('\n' + t); }

const base = {
  name: '商贷',
  principal: 1000000,
  annualRate: 4.9,
  termMonths: 360,
  method: 'equal_installment',
  firstPaymentDate: '2024-01-20'
};

/* ------------------------------------------------------------------ */
section('1. 等额本息 100 万 / 4.9% / 30 年');
const a = E.buildLoan(base, '2024-01-01');
ok('计算成功', a.ok, a.error);
near('月供', a.stats.monthlyPayment, 5307.27, 0.05);
near('总利息', a.stats.totalInterest, 910616.19, 3);
near('还款总额', a.stats.totalPayment, 1910616.19, 3);
near('首期利息', a.rows[0].interest, 4083.33, 0.01);
near('首期本金', a.rows[0].principal, 1223.94, 0.02);
ok('共 360 期', a.rows.length === 360, a.rows.length);
near('末期后余额为 0', a.rows[359].balance, 0, 0.01);
ok('已还 0 期', a.stats.periodsPaid === 0, a.stats.periodsPaid);
near('剩余本金 = 总额', a.stats.remainingPrincipal, 1000000, 0.01);
near('剩余利息 = 总利息', a.stats.remainingInterest, a.stats.totalInterest, 0.01);

/* ------------------------------------------------------------------ */
section('2. 等额本金 100 万 / 4.9% / 30 年');
const b = E.buildLoan(Object.assign({}, base, { method: 'equal_principal' }), '2024-01-01');
ok('计算成功', b.ok, b.error);
near('首期月供', b.rows[0].payment, 6861.11, 0.02);
near('末期月供', b.rows[359].payment, 2789.12, 0.05);
near('总利息', b.stats.totalInterest, 737041.67, 1);
near('每期本金', b.rows[10].principal, 2777.7778, 0.01);
ok('月供递减', b.rows[0].payment > b.rows[100].payment && b.rows[100].payment > b.rows[300].payment);

/* ------------------------------------------------------------------ */
section('3. 时间推导：已还期数 / 已还本息 / 提前还款');
// 24 期后
const c = E.buildLoan(base, '2026-01-20');   // 2024-01-20 起共 25 个还款日 <= 该日？(含 2026-01-20)
ok('2026-01-20 已还 25 期', c.stats.periodsPaid === 25, c.stats.periodsPaid);
ok('未还款日当天也算已还', E.buildLoan(base, '2026-01-19').stats.periodsPaid === 24);
near('已还本金 + 剩余本金 = 总额',
  c.stats.paidPrincipal + c.stats.remainingPrincipal, 1000000, 0.01);
near('已还利息 + 剩余利息 = 总利息',
  c.stats.paidInterest + c.stats.remainingInterest, c.stats.totalInterest, 0.01);
near('已还本息 = 已还本金 + 已还利息',
  c.stats.paidTotal, c.stats.paidPrincipal + c.stats.paidInterest, 0.01);
ok('下一期日期正确', c.stats.nextPayment.date === '2026-02-20', c.stats.nextPayment.date);
const c2 = E.buildLoan(base, '2026-02-05');   // 计息周期走了一半
ok('月中已计提利息 > 0', c2.stats.accruedInterest > 0, c2.stats.accruedInterest);
ok('已计提利息 < 整期利息', c2.stats.accruedInterest < c2.stats.nextPayment.interest * 0.6,
  c2.stats.accruedInterest.toFixed(2));
ok('未到还款期不计入已还', c2.stats.periodsPaid === c.stats.periodsPaid);

/* ------------------------------------------------------------------ */
section('4. 提前还款：缩短期限（月供不变）');
const d = E.buildLoan(Object.assign({}, base, {
  prepayments: [{ date: '2026-01-20', amount: 200000, mode: 'shorten_term' }]
}), '2026-01-21');   // 发生在第 25 期之后
ok('计算成功', d.ok, d.error);
near('月供基本不变', d.stats.monthlyPayment, a.stats.monthlyPayment, 1);
ok('期限缩短', d.stats.periodsTotal < 360, d.stats.periodsTotal);
ok('期限缩短约 9~10 年', 360 - d.stats.periodsTotal > 90 && 360 - d.stats.periodsTotal < 130,
  360 - d.stats.periodsTotal);
ok('省下利息 > 0', d.stats.savedInterest > 0, d.stats.savedInterest.toFixed(0));
const dRow = d.rows[24];
near('第 25 期记录提前还款额', dRow.prepay, 200000, 0.01);
near('提前还款后余额', dRow.balance, c.stats.remainingPrincipal - 200000, 0.01);

/* ------------------------------------------------------------------ */
section('5. 提前还款：降低月供（期限不变）');
const e = E.buildLoan(Object.assign({}, base, {
  prepayments: [{ date: '2026-01-20', amount: 200000, mode: 'reduce_payment' }]
}), '2026-01-21');
near('期限不变', e.stats.periodsTotal, 360, 0);
ok('月供下降', e.stats.monthlyPayment < a.stats.monthlyPayment - 500, e.stats.monthlyPayment.toFixed(2));
ok('缩期比降月供省更多利息', d.stats.savedInterest > e.stats.savedInterest,
  d.stats.savedInterest.toFixed(0) + ' vs ' + e.stats.savedInterest.toFixed(0));

/* ------------------------------------------------------------------ */
section('6. 利率调整（LPR 重定价）');
const f = E.buildLoan(Object.assign({}, base, {
  rateChanges: [{ fromDate: '2026-01-01', annualRate: 3.9 }]
}), '2026-01-01');
const row25 = f.rows[24];   // 2026-01-20 那期
ok('第 25 期按新利率计息', Math.abs(row25.annualRate - 3.9) < 1e-9, row25.annualRate);
near('第 25 期利息 = 余额 × 3.9%/12', row25.interest, f.rows[23].balance * 0.039 / 12, 0.01);
ok('降息后月供下降', row25.payment < f.rows[23].payment, row25.payment.toFixed(2));
near('总利息减少', f.stats.totalInterest < a.stats.totalInterest ? 1 : 0, 1, 0);
near('合同利率不变', f.stats.annualRate, 4.9, 0);
near('当前执行利率跟着变', f.stats.currentRate, 3.9, 0);
near('下一期利率也是新利率', f.stats.rate, 3.9, 0);
const fBefore = E.buildLoan(Object.assign({}, base, {
  rateChanges: [{ fromDate: '2026-01-01', annualRate: 3.9 }]
}), '2025-12-31');
near('调整生效前当前利率仍是 4.9', fBefore.stats.currentRate, 4.9, 0);

/* ------------------------------------------------------------------ */
section('7. 组合贷：公积金 60 万 2.85% + 商贷 40 万 4.2%');
const combo = {
  loans: [
    Object.assign({}, base, { id: 'gj', name: '公积金贷', kind: '公积金', principal: 600000, annualRate: 2.85, firstPaymentDate: '2024-03-15' }),
    Object.assign({}, base, { id: 'sd', name: '商贷', kind: '商贷', principal: 400000, annualRate: 4.2, firstPaymentDate: '2024-03-15' })
  ]
};
const g = E.analyze(combo, '2026-03-15');
ok('两笔都成功', g.ok, g.errors.join(';'));
near('总本金', g.totals.principal, 1000000, 0.01);
near('合计已还本金 = 两笔之和',
  g.totals.paidPrincipal, g.loans[0].stats.paidPrincipal + g.loans[1].stats.paidPrincipal, 0.01);
near('合计月供 = 两笔月供之和',
  g.totals.monthlyPayment, g.loans[0].stats.monthlyPayment + g.loans[1].stats.monthlyPayment, 0.01);
ok('下一期日期一致 2026-04-15', g.totals.nextPayment.date === '2026-04-15', g.totals.nextPayment && g.totals.nextPayment.date);
ok('下一期明细 2 条', g.totals.nextPayment.items.length === 2);
near('进度 = 已还本金/总本金', g.totals.progress, g.totals.paidPrincipal / g.totals.principal, 1e-9);

/* ------------------------------------------------------------------ */
section('8. 边界情况');
const z = E.buildLoan(Object.assign({}, base, { annualRate: 0, termMonths: 12, principal: 12000 }), '2024-01-01');
near('零利率月供 = 本金/期数', z.stats.monthlyPayment, 1000, 0.01);
near('零利率总利息 = 0', z.stats.totalInterest, 0, 0.01);

const payoff = E.buildLoan(Object.assign({}, base, {
  prepayments: [{ date: '2025-06-20', payoff: true, mode: 'shorten_term' }]
}), '2025-07-01');
ok('结清后无剩余', payoff.stats.cleared === true && payoff.stats.remainingPrincipal < 1, payoff.stats.remainingPrincipal);

ok('非法本金给出错误', E.buildLoan(Object.assign({}, base, { principal: 0 })).ok === false);
ok('非法日期给出错误', E.buildLoan(Object.assign({}, base, { firstPaymentDate: 'abc' })).ok === false);

const short = E.buildLoan(Object.assign({}, base, { firstPaymentDate: '2024-01-31', termMonths: 12 }), '2024-01-01');
ok('31 号顺延到 2 月 29 日', short.rows[1].date === '2024-02-29', short.rows[1].date);
ok('3 月回到 31 日', short.rows[2].date === '2024-03-31', short.rows[2].date);

/* ------------------------------------------------------------------ */
section('9. 格式化');
ok('fmtMoney', E.fmtMoney(1910616.19) === '1,910,616.19', E.fmtMoney(1910616.19));
ok('fmtWan', E.fmtWan(873456) === '87.35万', E.fmtWan(873456));
ok('fmtWan 整数', E.fmtWan(500000) === '50万', E.fmtWan(500000));
ok('fmtMonths', E.fmtMonths(28) === '2 年 4 个月', E.fmtMonths(28));
ok('fmtPct', E.fmtPct(0.049) === '4.90%', E.fmtPct(0.049));

/* ------------------------------------------------------------------ */
section('10. 不同还款日 / 提前还款计入已还本息');
const mix = E.analyze({
  loans: [
    Object.assign({}, base, { id: 'a', name: '公积金贷', kind: '公积金', principal: 600000, annualRate: 2.85, firstPaymentDate: '2024-03-20' }),
    Object.assign({}, base, { id: 'b', name: '商贷', kind: '商贷', principal: 400000, annualRate: 4.2, firstPaymentDate: '2024-03-25' })
  ]
}, '2026-03-01');
near('本期应还 = 两笔下一期之和', mix.totals.nextPayment.amount,
  mix.loans[0].stats.monthlyPayment + mix.loans[1].stats.monthlyPayment, 0.01);
ok('本期日期取最早的一笔', mix.totals.nextPayment.date === '2026-03-20', mix.totals.nextPayment.date);
ok('本期明细 2 条（不等日期也合并）', mix.totals.nextPayment.items.length === 2);

const pre = E.buildLoan(Object.assign({}, base, {
  prepayments: [{ date: '2025-06-10', amount: 100000, mode: 'shorten_term' }]
}), '2025-06-10');
ok('还款日之前就先还了，当天即计入已还本息', pre.stats.paidTotal > 100000, pre.stats.paidTotal.toFixed(2));
near('已还本金 = 已还本息 - 已还利息', pre.stats.paidPrincipal, pre.stats.paidTotal - pre.stats.paidInterest, 0.01);
near('已还本金 + 剩余本金 = 总额', pre.stats.paidPrincipal + pre.stats.remainingPrincipal, 1000000, 0.01);
near('已还本金含提前还款的 10 万', pre.stats.paidPrincipal,
  pre.rows.filter(function (r) { return r.paid; }).reduce(function (s, r) { return s + r.principal; }, 0) + 100000, 0.5);

console.log('\n' + (fail === 0 ? '全部通过' : '有失败') + '：' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
