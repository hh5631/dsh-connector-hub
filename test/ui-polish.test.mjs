/**
 * UI 打磨回归（v8「手感」）
 *
 * 只断言「可以被机器核对」的那部分设计决定，避免下次改样式时悄悄回退：
 *   1. 过渡节奏统一在 120–180ms（离开 140 / 入场 180），且 JS 的 LEAVE_MS 与
 *      CSS 的 .rows-leaving 同步——两个数字脱节会出现「内容换了、上一批还在淡出」；
 *   2. 可点控件都有 :active 反馈，键盘焦点环不被覆盖；
 *   3. 栅格卡片等高的两个前提（描述两行 + 厂商行最低高度）都还在；
 *   4. ≤420px 有专门的窄屏规则，不靠 560px 兜底；
 *   5. 空状态三处文案各自给出「下一步怎么做」，且中英词条一一对应；
 *   6. 图标沿用宿主空心描边契约（fill=none / stroke=currentColor）。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'ui/hub.css'), 'utf8');
const hub = readFileSync(join(root, 'ui/hub.js'), 'utf8');

function rule(selector) {
  const at = css.indexOf(selector);
  assert.ok(at >= 0, `缺少规则 ${selector}`);
  return css.slice(at, css.indexOf('}', at) + 1);
}

test('过渡节奏：离开 140ms / 入场 180ms，且都落在 120–180ms 区间', () => {
  assert.match(rule('.rows-leaving {'), /transition: opacity 140ms[^;]*transform 140ms/,
    '离开过渡 140ms');
  assert.match(rule('.rows-enter {'), /animation: rows-enter 180ms/, '入场动画 180ms');
  assert.match(rule('.groupbar-ink {'), /transform 180ms[\s\S]{0,60}width 180ms/,
    '分组墨条滑行收敛到 180ms（原来是 240ms，比其它过渡慢半拍）');
  // 全表扫描 transition 声明（不含持续循环的 animation，如 700ms 的加载转圈）
  const timings = [...css.matchAll(/transition:[^;{}]*?(\d{2,4})ms/g)].map((m) => Number(m[1]));
  const slow = timings.filter((ms) => ms > 180);
  assert.deepEqual(slow, [], `仍有超过 180ms 的交互过渡：${slow.join(', ')}`);
});

test('JS 的 LEAVE_MS 必须与 CSS 的 .rows-leaving 时长一致', () => {
  const leave = Number(hub.match(/const LEAVE_MS = (\d+);/)[1]);
  const cssLeave = Number(rule('.rows-leaving {').match(/transition: opacity (\d+)ms/)[1]);
  assert.equal(leave, cssLeave, '两个数字脱节会看到重影');
  assert.equal(leave, 140);
  assert.match(hub, /if \(token === swapToken\) rows\.classList\.remove\('rows-enter'\);\s*\}, 180\);/,
    'JS 清入场类的定时器与 180ms 动画对齐');
});

test('按下反馈：tbtn / tile-act / connected-btn 都有 :active，且 transition-duration 更短', () => {
  assert.match(css, /\.tbtn:active:not\(:disabled\) \{[\s\S]{0,120}transition-duration: 60ms/,
    '按钮按下时过渡更快，反馈才跟手');
  assert.match(css, /\.tile-act:active:not\(:disabled\) \{[\s\S]{0,80}translateY\(\.5px\)/,
    '卡片主操作有位移反馈');
  assert.match(css, /\.connected-btn:active \{[\s\S]{0,40}translateY\(\.5px\)/);
});

test('键盘可达：焦点环存在且没有被 outline:none 全量抹掉', () => {
  assert.match(css, /:focus-visible \{ outline: 2px solid var\(--focus\)/, '统一焦点环');
  assert.doesNotMatch(css, /(?:^|\n)\s*\*\s*\{[^}]*outline:\s*none/, '不得用 * { outline: none } 抹掉焦点');
  assert.match(css, /\.drawer:focus, \.drawer:focus-visible \{ outline: none; \}/,
    '抽屉容器本身程序化聚焦，不画环（唯一豁免）');
});

test('等高卡片：描述占两行 + 厂商行最低高度，空厂商不压矮同排卡片', () => {
  assert.match(rule('.grid-cards .tile-desc {'), /-webkit-line-clamp: 2/);
  assert.match(rule('.grid-cards .tile-desc {'), /min-height: calc\(2 \* 1\.55em\)/);
  const vendor = css.slice(css.indexOf('.grid-cards .tile-vendor {'));
  assert.match(vendor.slice(0, 200), /min-height: 1\.5em/, '厂商为空时仍占一行，卡片不再参差');
  assert.match(rule('.grid-cards {'), /grid-auto-rows: 1fr/, '行高拉平');
});

test('≤420px 有专门规则：顶栏按钮收紧、抽屉动作可换行、弹框内边距收敛', () => {
  const at = css.indexOf('@media (max-width: 420px)');
  assert.ok(at > 0, '缺少 420px 断点');
  const block = css.slice(at, css.indexOf('\n}\n', at) + 3);
  assert.ok(block.length > 300, '断点块不能是空壳');
  for (const needle of ['.topbar .tbtn', '.row-actions { flex-wrap: wrap', '.dialog {', '.empty {']) {
    assert.ok(block.includes(needle), `420px 断点缺少 ${needle}`);
  }
  assert.ok(!/@media \(max-width: 420px\)[\s\S]{0,400}display:\s*none/.test(block), '窄屏不得隐藏功能按钮');
});

test('空状态文案：三种空态都说清「下一步」，中英词条一一对应', () => {
  const load = () => {
    // 只取源码里的 `const I18N = { … };` 字面量单独求值：整份 hub.js 需要完整
    // DOM 桩，而这里要核对的只有词条本身。
    const start = hub.indexOf('const I18N = {');
    const end = hub.indexOf('\n};\n', start);
    assert.ok(start > 0 && end > start, '未找到 I18N 字典');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(`${hub.slice(start, end + 3)}\nthis.__I18N = I18N;`, sandbox, { filename: 'i18n.js' });
    return sandbox.__I18N;
  };
  const I18N = load();
  for (const [titleKey, hintKey] of [['noCatalog', 'noCatalogHint'], ['noMatch', 'noMatchHint'], ['connectedEmpty', 'connectedEmptyHint']]) {
    for (const locale of ['zh-CN', 'en']) {
      assert.ok(I18N[locale][titleKey]?.trim(), `${locale}.${titleKey} 不为空`);
      assert.ok(I18N[locale][hintKey]?.trim(), `${locale}.${hintKey} 不为空`);
      // 提示必须给出动作，而不是只有一句「空的」
      assert.match(I18N[locale][hintKey], /刷新|清除|连接|Reload|Refresh|Clear|Connect/i,
        `${locale}.${hintKey} 要给出下一步`);
    }
  }
  const zh = Object.keys(I18N['zh-CN']).sort();
  const en = Object.keys(I18N.en).sort();
  assert.deepEqual(zh, en, 'zh-CN / en 词条集合必须一致，缺一条就会漏出裸 key');
});

test('图标契约：面板与 favicon 都是空心描边，品牌记号无黑底', () => {
  const html = readFileSync(join(root, 'ui/index.html'), 'utf8');
  assert.match(html, /class="brand-mark"[\s\S]{0,400}fill="none"[^>]*stroke="currentColor"[^>]*stroke-width="1\.9"/);
  assert.match(html, /<link rel="icon"[\s\S]{0,1200}stroke='%23ffffff'[\s\S]{0,120}stroke-width='1\.9'/);
  assert.doesNotMatch(rule('.brand-mark {'), /background:/, '品牌记号不吃底色');
});

/* ── v9：设计令牌收敛 ─────────────────────────────────────────
 * 这一组断言锁的是「同一套视觉语言」而不是某个具体数值：
 * 字号只能来自阶梯、圆角只能来自阶梯、文本对比度不低于 4.5:1、
 * 图标描边换算到实际像素后粗细一致。下次改样式若又随手写字面量，
 * 这里会先红一次，而不是等人眼看出来「这块和那块不太一样」。
 */

/** 相对亮度 / 对比度（WCAG 2.1 定义）。 */
function luminance(hex) {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
/** 取 :root / 暗色 :root 里的某个令牌值。 */
function token(name, dark = false) {
  const start = dark ? css.indexOf('@media (prefers-color-scheme: dark)') : css.indexOf(':root {');
  const block = css.slice(start, css.indexOf('\n}', start));
  const m = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`));
  assert.ok(m, `缺少令牌 ${name}（dark=${dark}）`);
  return m[1];
}

test('字号全部来自阶梯：不再有 11.5 / 12.5 / 13.5 这类半像素值', () => {
  const literals = [...css.matchAll(/font-size:\s*([\d.]+px)/g)].map((m) => m[1]);
  assert.deepEqual(literals, [], `字号必须用 --fs-* 令牌，发现字面量：${literals.join(', ')}`);
  for (const t of ['--fs-xs', '--fs-s', '--fs-m', '--fs-l', '--fs-xl']) {
    assert.ok(css.includes(`${t}:`), `缺少字号令牌 ${t}`);
  }
});

test('圆角全部来自阶梯：图标框 / 分段控件 / 卡片 / 弹层各归其位', () => {
  for (const t of ['--r', '--r-inner', '--r-card', '--r-pop', '--r-pill']) {
    assert.ok(css.includes(`${t}:`), `缺少圆角令牌 ${t}`);
  }
  // 图标框与分段控件此前分别写死 9px / 7px，现在都走 --r-inner
  assert.match(rule('.tile-icon {'), /border-radius: var\(--r-inner\)/);
  assert.match(rule('.row-icon {'), /border-radius: var\(--r-inner\)/);
  assert.match(rule('.layout-switch {'), /border-radius: var\(--r-inner\)/);
  // 除 50%（圆点/竖脊）与 2px（发丝墨条）外不应有其它字面量
  const literals = [...css.matchAll(/border-radius:\s*([\d.]+px)/g)].map((m) => m[1]).filter((v) => v !== '2px');
  assert.deepEqual(literals, [], `圆角字面量：${literals.join(', ')}`);
});

test('文本对比度：亮/暗两套的次要文字与语义色都 ≥ 4.5:1', () => {
  const pairs = [
    ['--text-3', '--bg', false], ['--text-3', '--surface-2', false],
    ['--text-2', '--bg', false], ['--ok', '--bg', false],
    ['--warn', '--bg', false], ['--bad', '--bg', false],
    ['--text-3', '--bg', true], ['--text-3', '--surface-2', true],
    ['--text-2', '--bg', true], ['--ok', '--bg', true],
    ['--warn', '--bg', true], ['--bad', '--bg', true],
  ];
  for (const [fg, bg, dark] of pairs) {
    const ratio = contrast(token(fg, dark), token(bg, dark));
    assert.ok(ratio >= 4.5, `${dark ? '暗色' : '亮色'} ${fg} on ${bg} = ${ratio.toFixed(2)}，低于 4.5:1`);
  }
});

test('顶栏控件同高：搜索框 / 文字按钮 / 已连接胶囊共用 --control-h', () => {
  assert.match(rule('.search {'), /height: var\(--control-h\)/);
  assert.match(rule('.connected-btn {'), /height: var\(--control-h\)/);
  assert.match(css, /\.topbar \.tbtn \{[^}]*height: var\(--control-h\)/);
});

test('间距令牌：抽屉与卡片共用一套节奏，抽屉标题与行图标左边缘对齐', () => {
  const drawerBody = rule('.drawer-body {');
  const row = rule('.row {');
  // 抽屉标题 20px 起点 = 行内 12 + 容器 8
  assert.match(rule('.drawer-head {'), /padding: 18px var\(--sp-5\) 14px/);
  assert.match(drawerBody, /var\(--sp-2\)/, '抽屉容器左右 8px');
  assert.match(row, /padding: var\(--sp-3\)/, '行内 12px');
});

test('图标描边：所有内联字形换算到实际像素后落在 1.26–1.37px', () => {
  const html = readFileSync(join(root, 'ui/index.html'), 'utf8');
  const widths = [];
  // 收集 width / viewBox / stroke-width 三元组
  for (const m of html.matchAll(/<svg[^>]*viewBox="0 0 (\d+) (\d+)"[^>]*width="([\d.]+)"[^>]*stroke-width="([\d.]+)"/g)) {
    widths.push(Number(m[4]) * Number(m[3]) / Number(m[1]));
  }
  for (const m of html.matchAll(/<svg[^>]*viewBox="0 0 (\d+) (\d+)"[^>]*stroke-width="([\d.]+)"[^>]*width="([\d.]+)"/g)) {
    widths.push(Number(m[3]) * Number(m[4]) / Number(m[1]));
  }
  assert.ok(widths.length >= 3, `至少要核对 3 枚字形，实际 ${widths.length}`);
  for (const w of widths) {
    assert.ok(w >= 1.26 && w <= 1.37, `描边实际 ${w.toFixed(2)}px 不在 1.26–1.37 区间`);
  }
});

test('空状态标题：无 {q} 占位符的词条用自己的标题，不被改写成「这个分类下…」', () => {
  const html = readFileSync(join(root, 'ui/hub.js'), 'utf8');
  // 回归：renderCatalog 的目录空态曾一律回退成 noMatchPlain，
  // 于是「目录还没有内容」和抽屉的「还没有连接任何应用」都变成了分类空态文案。
  assert.match(html, /const raw = t\(titleKey\);[\s\S]{0,220}raw\.includes\('\{q\}'\)/,
    '有 {q} 才回填关键词，没有就用自己的标题');
  assert.match(html, /el\('rows'\)\.innerHTML = emptyHtml\(\n\s+filtered \? 'noMatch' : 'noCatalog'/,
    '目录空态按「有没有筛选」二选一');
});
