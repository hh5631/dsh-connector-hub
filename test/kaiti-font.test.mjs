import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * 楷体链路回归测试。
 *
 * 真实故障：主人用「壁纸引擎」插件把界面字体改成楷体，但 Connector Hub 面板
 * 仍显示默认字体。根因是壁纸引擎把字族写在 `--dsw-font-family`（DSH 基准令牌）
 * 且**不落配置文件**，而面板最初只读 `--dsh-font-family-text`（DSH 官方设置项），
 * 所以读不到。修复后父页面改用 `getComputedStyle(body).fontFamily` 取真实生效
 * 字体，再 postMessage 给面板。
 *
 * 这些断言锁定该路径，避免以后回归成「只认官方设置项」。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function boot({ injectedFonts } = {}) {
  const rootProps = new Map();
  const nodes = new Map();
  const mk = (id) => ({
    id, hidden: false, textContent: '', innerHTML: '', value: '', placeholder: '',
    dataset: {}, options: { length: 0 }, disabled: false, className: '',
    addEventListener() {}, setAttribute() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  });
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, mk(id)); return nodes.get(id); };
  const listeners = [];
  const document = {
    title: '', hidden: false,
    documentElement: {
      lang: 'zh-CN',
      style: {
        setProperty: (k, v) => rootProps.set(k, v),
        removeProperty: (k) => rootProps.delete(k),
        getPropertyValue: (k) => rootProps.get(k) ?? '',
      },
    },
    getElementById: get,
    querySelectorAll: () => [],
    createElement: () => mk('t'),
    addEventListener() {},
  };
  const window = {
    location: { origin: 'http://127.0.0.1:4175', search: '' },
    __CONNECTOR_HUB_LOCALE__: 'zh-CN',
    __CONNECTOR_HUB_FONTS__: injectedFonts,
    parent: { postMessage() {} },
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
  };
  const ctx = {
    document, window, location: window.location,
    EventSource: class { addEventListener() {} close() {} },
    URLSearchParams, setTimeout, clearTimeout, AbortController, console,
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, detail: { items: [], total: 0, connections: [] } }) }),
    confirm: () => false,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(join(root, 'ui/hub.js'), 'utf8'), ctx, { filename: 'hub.js' });
  const dispatch = (data, origin = window.location.origin) => {
    for (const fn of listeners) fn({ origin, data });
  };
  return { rootProps, dispatch };
}

test('楷体：Host 只能注入字号时，字族靠父页面计算样式补上', () => {
  const { rootProps, dispatch } = boot({ injectedFonts: { contentSize: 17 } });
  // 首帧：只有字号（壁纸引擎的字族不落配置，Host 读不到）
  assert.equal(rootProps.get('--dsh-content-font-size'), '17px');
  assert.equal(rootProps.has('--dsh-font-family-text'), false);

  // 父页面 getComputedStyle 拿到楷体后推送 —— 修复的核心路径
  const kaiti = 'KaiTi, STKaiti, "楷体", serif';
  dispatch({
    type: 'connector-hub:theme-fonts',
    fonts: { text: kaiti, code: '"JetBrains Mono", monospace', contentSize: '17px', codeSize: '12px' },
  });
  assert.equal(rootProps.get('--dsh-font-family-text'), kaiti, '楷体写入面板 :root');
  assert.equal(rootProps.get('--dsh-font-family-code'), '"JetBrains Mono", monospace');
  assert.equal(rootProps.get('--dsh-code-font-size'), '12px', '代码字号（新增档位）');
});

test('楷体：壁纸引擎换字体后实时同步', () => {
  const { rootProps, dispatch } = boot({ injectedFonts: { contentSize: 17 } });
  dispatch({ type: 'connector-hub:theme-fonts', fonts: { text: 'KaiTi, serif', contentSize: '17px' } });
  assert.equal(rootProps.get('--dsh-font-family-text'), 'KaiTi, serif');

  // 换成宋体 + 更小字号：不需要刷新
  dispatch({ type: 'connector-hub:theme-fonts', fonts: { text: 'SimSun, serif', contentSize: '15px' } });
  assert.equal(rootProps.get('--dsh-font-family-text'), 'SimSun, serif');
  assert.equal(rootProps.get('--dsh-content-font-size'), '15px');
});

test('楷体：清空后回退系统字体栈', () => {
  const { rootProps, dispatch } = boot({ injectedFonts: { contentSize: 17 } });
  dispatch({ type: 'connector-hub:theme-fonts', fonts: { text: 'KaiTi, serif' } });
  assert.ok(rootProps.has('--dsh-font-family-text'));
  dispatch({ type: 'connector-hub:theme-fonts', fonts: { text: '', code: '', contentSize: '' } });
  assert.equal(rootProps.has('--dsh-font-family-text'), false, '空字族移除变量，回退内置栈');
});

test('楷体：跨源消息不能篡改字体', () => {
  const { rootProps, dispatch } = boot({ injectedFonts: { contentSize: 17 } });
  dispatch({ type: 'connector-hub:theme-fonts', fonts: { text: 'KaiTi, serif' } });
  dispatch({ type: 'connector-hub:theme-fonts', fonts: { text: 'HACKED' } }, 'https://evil.example');
  assert.equal(rootProps.get('--dsh-font-family-text'), 'KaiTi, serif');
});

test('楷体：字号接受 16 与 "16px" 两种形态', () => {
  const { rootProps, dispatch } = boot({ injectedFonts: { contentSize: 16 } });
  assert.equal(rootProps.get('--dsh-content-font-size'), '16px', '数字形态');
  dispatch({ type: 'connector-hub:theme-fonts', fonts: { contentSize: '18px' } });
  assert.equal(rootProps.get('--dsh-content-font-size'), '18px', '带 px 字符串形态');
});
