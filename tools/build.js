/* tools/build.js — 把计算引擎内联进小组件模板
 * 用法：node tools/build.js
 * 输入：engine/loan.js + widget/mortgage-widget.js（模板，含 ENGINE BEGIN/END 标记）
 * 输出：widget/dist/mortgage-widget.js（直接粘进 Scriptable 的单文件）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(ROOT, 'engine', 'loan.js');
const TPL = path.join(ROOT, 'widget', 'mortgage-widget.js');
const OUT_DIR = path.join(ROOT, 'widget', 'dist');
const OUT = path.join(OUT_DIR, 'mortgage-widget.js');

const BEGIN = '// >>> ENGINE BEGIN';
const END = '// <<< ENGINE END';

function read(p) {
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

const engine = read(ENGINE);
const tpl = read(TPL);

const i = tpl.indexOf(BEGIN);
const j = tpl.indexOf(END);
if (i < 0 || j < 0 || j < i) {
  console.error('模板里找不到 ENGINE BEGIN/END 标记：' + TPL);
  process.exit(1);
}

// 引擎包一层，缩进 4 格，便于在 Scriptable 里折叠
const body = engine
  .split('\n')
  .map((line) => (line ? '    ' + line : line))
  .join('\n')
  .replace(/\s+$/, '');

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

const out =
  tpl.slice(0, i) +
  BEGIN + '\n' +
  '    /* engine/loan.js · 构建于 ' + stamp + ' · 改引擎请改源文件再重新构建 */\n' +
  body + '\n' +
  '    ' + END +
  tpl.slice(j + END.length);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, out, 'utf8');

const lines = out.split('\n').length;
console.log('built ' + path.relative(ROOT, OUT) + '  ' + lines + ' 行 / ' +
  (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1) + ' KB');
