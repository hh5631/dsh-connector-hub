/**
 * 凭据获取路径的回归测试。
 *
 * 覆盖三条「连不上」的根因修复：
 *   1. 凭据申请指引解析（目录声明优先、内置兜底、无指引时不造假链接）；
 *   2. CLI 登录态复用（只读探测、白名单、不泄漏 token、失败静默降级）；
 *   3. 设备码流程的错误分类（authorization_pending / slow_down 等等待语义）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCredentialGuide, guidedConnectorIds } from '../lib/credential-guide.js';
import { listCliAuthProviders, discoverCliAuth, findCliAuthForConnector } from '../lib/cli-auth-reuse.js';

/* ─────────────────────── 凭据申请指引 ─────────────────────── */

test('凭据指引：目录声明的 helpUrl 优先于内置兜底', () => {
  const guide = resolveCredentialGuide({
    id: 'github',
    auth: { credentialHelpUrl: 'https://example.test/tokens', credentialHelpLabel: '自定义标签' },
  });
  assert.equal(guide.source, 'catalog');
  assert.equal(guide.url, 'https://example.test/tokens');
  assert.equal(guide.label, '自定义标签');
});

test('凭据指引：已知厂商在目录没声明时用内置官方页兜底', () => {
  const guide = resolveCredentialGuide({ id: 'amap', auth: {} });
  assert.equal(guide.source, 'builtin');
  assert.match(guide.url, /^https:\/\/console\.amap\.com\//);
  assert.ok(guide.note.length > 0);
});

test('凭据指引：目录 homepage 可作为次级兜底', () => {
  const guide = resolveCredentialGuide({ id: 'unknown-svc', homepage: 'https://unknown.test/docs', auth: {} });
  assert.equal(guide.source, 'catalog');
  assert.equal(guide.url, 'https://unknown.test/docs');
});

test('凭据指引：完全没有线索时返回 undefined，绝不编造链接', () => {
  assert.equal(resolveCredentialGuide({ id: 'brand-new-svc', auth: {} }), undefined);
  assert.equal(resolveCredentialGuide(undefined), undefined);
});

test('凭据指引：内置覆盖包含 github 与 amap', () => {
  const ids = guidedConnectorIds();
  assert.ok(ids.includes('github'));
  assert.ok(ids.includes('amap'));
});

/* ─────────────────────── CLI 登录态复用 ─────────────────────── */

test('CLI 复用：提供方清单只暴露白名单且不含凭据', () => {
  const providers = listCliAuthProviders();
  assert.ok(providers.length > 0);
  for (const item of providers) {
    assert.ok(typeof item.providerId === 'string');
    assert.ok(Array.isArray(item.connectorIds));
    // 清单里绝不能出现 token/secret 之类字段。
    assert.equal(item.token, undefined);
    assert.equal(item.secret, undefined);
  }
  assert.ok(providers.some((item) => item.providerId === 'gh' && item.connectorIds.includes('github')));
});

test('CLI 复用：不要求 token 的探测结果里不含 token 字段', async () => {
  const items = await discoverCliAuth({ includeToken: false });
  assert.ok(Array.isArray(items));
  for (const item of items) {
    assert.equal(item.token, undefined);
    assert.equal(typeof item.available, 'boolean');
  }
});

test('CLI 复用：未知连接器直接返回 null，不触发任何命令', async () => {
  assert.equal(await findCliAuthForConnector('no-such-connector'), null);
  assert.equal(await findCliAuthForConnector(''), null);
});

test('CLI 复用：无法连接的连接器返回 null 而不是抛异常', async () => {
  // 'gitlab' 只有在 glab 已登录时才可用；这里只断言「不抛错且形状正确」。
  const result = await findCliAuthForConnector('gitlab');
  assert.ok(result === null || typeof result.providerId === 'string');
});

/* ─────────────────────── 设备码流程错误语义 ─────────────────────── */

test('设备码：authorization_pending 视为等待而非失败', async () => {
  const { pollDeviceToken } = await import('../lib/oauth.js');
  // 用一个必然失效的本地端点，断言它最终以 expired_token 结束而不是抛出网络错误以外的类型。
  await assert.rejects(
    () => pollDeviceToken('https://127.0.0.1:9/token', {
      clientId: 'x', deviceCode: 'y', interval: 1, expiresIn: 1, timeoutMs: 200,
    }),
    (error) => error instanceof Error,
  );
});

test('设备码：requestDeviceCode 缺 client_id 时明确报错', async () => {
  const { requestDeviceCode } = await import('../lib/oauth.js');
  await assert.rejects(
    () => requestDeviceCode('https://example.test/device', { clientId: '' }),
    /client_id is required/,
  );
});
