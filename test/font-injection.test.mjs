import test from 'node:test';
import assert from 'node:assert/strict';
import { injectPanelFonts } from '../lib/web.js';

const html = Buffer.from('<!doctype html><html><head><title>x</title></head><body></body></html>');
const readGlobal = (buf) => {
  const m = buf.toString('utf8').match(/window\.__CONNECTOR_HUB_FONTS__=(\{.*?\})<\/script>/);
  return m ? JSON.parse(m[1]) : null;
};

test('injectPanelFonts: 楷体等字族正确注入到 </head> 前', () => {
  const out = injectPanelFonts(html, { text: '"KaiTi", "楷体", serif', code: 'monospace', contentSize: 16 });
  const fonts = readGlobal(out);
  assert.equal(fonts.text, '"KaiTi", "楷体", serif');
  assert.equal(fonts.code, 'monospace');
  assert.equal(fonts.contentSize, 16);
  assert.ok(out.toString('utf8').indexOf('__CONNECTOR_HUB_FONTS__') < out.toString('utf8').indexOf('</head>'));
});

test('injectPanelFonts: 无 </head> 标记时原样返回', () => {
  const noHead = Buffer.from('<html><body>x</body></html>');
  assert.equal(injectPanelFonts(noHead, { text: 'x' }).toString('utf8'), noHead.toString('utf8'));
});

test('injectPanelFonts: 空字体对象不注入', () => {
  const out = injectPanelFonts(html, {});
  assert.equal(readGlobal(out), null);
  assert.equal(out.toString('utf8'), html.toString('utf8'));
});

test('injectPanelFonts: 非字符串/越界值被过滤', () => {
  const out = injectPanelFonts(html, { text: 123, code: {}, contentSize: -1, codeSize: 999 });
  const fonts = readGlobal(out);
  assert.equal(fonts, null, '全部非法时不注入');
});

test('injectPanelFonts: 超长字族被截断到 400', () => {
  const out = injectPanelFonts(html, { text: 'x'.repeat(999) });
  assert.equal(readGlobal(out).text.length, 400);
});

test('injectPanelFonts: 只注入白名单字段（不泄漏额外数据）', () => {
  const out = injectPanelFonts(html, { text: 'a', secret: 'token-123', __proto__: { bad: 1 } });
  const fonts = readGlobal(out);
  assert.equal(fonts.text, 'a');
  assert.equal(fonts.secret, undefined);
});

test('injectPanelFonts: null/undefined 安全返回', () => {
  assert.equal(injectPanelFonts(html, null).toString('utf8'), html.toString('utf8'));
  assert.equal(injectPanelFonts(html, undefined).toString('utf8'), html.toString('utf8'));
});
