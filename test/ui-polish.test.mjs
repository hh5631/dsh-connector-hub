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
