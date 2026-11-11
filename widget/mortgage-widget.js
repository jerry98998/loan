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
