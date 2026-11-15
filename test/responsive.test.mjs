/**
 * ui/responsive.js 纯决策回归（v6「融入」）
 *
 * 面板是 iframe，宽度由 DSH 宿主决定。这里断言宽度 → 每页条数 /
 * 栅格列数 / 抽屉宽度 / 断点的映射，确保与 hub.css 断点一致，
 * 且非法输入不会抛错（页面在沙箱里可能拿不到宽度）。
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'ui', 'responsive.js'), 'utf8');

function load() {
  const sandbox = { globalThis: {}, module: undefined };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'responsive.js' });
  return sandbox.ConnectorResponsive;
}

const R = load();

test('导出四个纯决策函数', () => {
  for (const name of ['pageSizeFor', 'gridColumnsFor', 'drawerWidthFor', 'breakpointFor']) {
    assert.equal(typeof R[name], 'function', `${name} 应为函数`);
  }
});

test('pageSizeFor：宽面板多放、窄面板少放，有下限 6', () => {
  assert.equal(R.pageSizeFor(1600, 12), 18, '超宽面板 1.5 倍');
  assert.equal(R.pageSizeFor(1000, 12), 12, '常规宽度保持基准');
  assert.equal(R.pageSizeFor(700, 12), 9, '偏窄面板 0.75 倍');
  assert.equal(R.pageSizeFor(400, 12), 6, '窄面板 0.5 倍');
  assert.ok(R.pageSizeFor(320, 4) >= 6, '下限 6 保证分页仍可用');
});

test('gridColumnsFor：随宽度增列，最窄至少 1 列', () => {
  assert.equal(R.gridColumnsFor(320), 1);
  assert.equal(R.gridColumnsFor(700), 3);
  assert.ok(R.gridColumnsFor(1600) >= 6);
});

test('drawerWidthFor：宽面板封顶 400px，窄面板留主体可见', () => {
  assert.equal(R.drawerWidthFor(1200), 400);
  assert.ok(R.drawerWidthFor(500) < 500, '窄面板抽屉不铺满整个宽度');
  assert.ok(R.drawerWidthFor(300) >= 280, '极窄面板仍有可用下限');
});

test('breakpointFor：与 hub.css 的 560 / 860 断点一致', () => {
  assert.equal(R.breakpointFor(400), 'compact');
  assert.equal(R.breakpointFor(560), 'compact');
  assert.equal(R.breakpointFor(700), 'narrow');
  assert.equal(R.breakpointFor(860), 'narrow');
  assert.equal(R.breakpointFor(1000), 'wide');
});

test('非法/缺失宽度一律安全回退，不抛错', () => {
  assert.equal(R.pageSizeFor(undefined, 12), 12);
  assert.equal(R.pageSizeFor(NaN, 12), 12);
  assert.equal(R.pageSizeFor(-1, 12), 12);
  assert.equal(R.pageSizeFor(1000, 0), 12);
  assert.equal(R.gridColumnsFor(0), 1);
  assert.equal(R.drawerWidthFor(undefined), 400);
  assert.equal(R.breakpointFor(undefined), 'wide');
});

test('index.html 引入 responsive.js，且 hub.js 消费 ConnectorResponsive', () => {
  const html = readFileSync(join(here, '..', 'ui', 'index.html'), 'utf8');
  const hub = readFileSync(join(here, '..', 'ui', 'hub.js'), 'utf8');
  assert.match(html, /<script src="responsive\.js"><\/script>/);
  assert.match(hub, /ConnectorResponsive/);
  assert.match(hub, /pageSizeFor\(width, 12\)/);
});
