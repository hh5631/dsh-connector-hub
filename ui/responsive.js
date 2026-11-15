/* 连接器 — 尺寸自适应决策（纯逻辑，无 DOM 依赖）
 *
 * 面板是 iframe，宽度由 DSH 宿主决定，可能很宽也可能很窄。
 * 把「宽度 → 每页条数 / 栅格列数 / 抽屉宽度」的判断集中在这里，
 * UI 只负责应用结果；这样决策可单测，也不需要为了试断点反复开浏览器。
 *
 * 同时供浏览器（普通 <script>）与 Node 侧 vm 测试加载：
 * 末尾的 globalThis 赋值在浏览器里指向 window，在 vm 里指向沙箱。
 */
(function (root) {
  'use strict';

  /** 每页条数：宽面板多放，窄面板少放；下限 6 保证分页仍可用。 */
  function pageSizeFor(width, base) {
    const w = Number(width);
    const b = Number(base);
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(b) || b <= 0) return 12;
    if (w < 480) return Math.max(6, Math.round(b * 0.5));
    if (w < 760) return Math.max(6, Math.round(b * 0.75));
    if (w > 1400) return Math.round(b * 1.5);
    return Math.round(b);
  }

  /** 栅格视图列数：仅用于断言/提示，真实列数由 CSS auto-fill 决定。 */
  function gridColumnsFor(width, minColumn = 220, gap = 12) {
    const w = Number(width);
    if (!Number.isFinite(w) || w <= 0) return 1;
    return Math.max(1, Math.floor((w + gap) / (minColumn + gap)));
  }

  /** 抽屉宽度：窄面板铺满，宽面板封顶 400px，始终留一点主体可见。 */
  function drawerWidthFor(panelWidth, maxWidth = 400) {
    const w = Number(panelWidth);
    if (!Number.isFinite(w) || w <= 0) return maxWidth;
    return Math.min(maxWidth, Math.max(280, Math.round(w * 0.92)));
  }

  /** 断点：与 hub.css 的 max-width 断点保持一致，供 JS 侧同步类名。 */
  function breakpointFor(width) {
    const w = Number(width);
    if (!Number.isFinite(w)) return 'wide';
    if (w <= 560) return 'compact';
    if (w <= 860) return 'narrow';
    return 'wide';
  }

  const api = { pageSizeFor, gridColumnsFor, drawerWidthFor, breakpointFor };
  root.ConnectorResponsive = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
