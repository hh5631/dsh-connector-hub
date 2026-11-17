/**
 * 回归：schemastery 的 Config schema 里不许用 zod 独有的 API。
 *
 * 事故：`Config` 用了 `z.enum([...])`，但 lib/index.js 的 `z` 来自
 * `@deepseek-ai/schemastery`（不是 zod）。schemastery **没有** `z.enum`，于是
 * 模块求值阶段直接抛 `TypeError: z.enum is not a function`，整个插件 import 失败：
 * 侧边栏连接器图标消失、面板 404、启动日志里只有一行 "failed to import"。
 *
 * 为什么已有 132 条测试全绿却没抓到：测试只 import lib/ 下的纯模块，
 * 从来没有 import 过 lib/index.js（它依赖 profile 才有的 dsh-storage-domain），
 * 所以插件级的求值错误落在测试视野之外。这条静态契约补上这个缺口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = join(dirname(dirname(fileURLToPath(import.meta.url))), 'lib');

/** schemastery 不提供、只有 zod 才有的静态方法。 */
const ZOD_ONLY = ['enum', 'literal', 'nativeEnum', 'coerce', 'discriminatedUnion', 'effects', 'lazy'];

/** 该文件是否 import 了 schemastery 作为 `z`。 */
function usesSchemastery(source) {
  return /^\s*import\s+z\s+from\s+['"]@deepseek-ai\/schemastery['"]/m.test(source);
}

test('引用 schemastery 的文件不使用 zod 独有 API', () => {
  const files = readdirSync(LIB).filter((name) => name.endsWith('.js'));
  const offenders = [];
  for (const name of files) {
    const source = readFileSync(join(LIB, name), 'utf8');
    if (!usesSchemastery(source)) continue;
    for (const method of ZOD_ONLY) {
      // 只匹配 `z.method(`，避免命中注释里的散文。
      const pattern = new RegExp(`\\bz\\.${method}\\s*\\(`);
      const hit = source.split('\n').findIndex((line) => pattern.test(line) && !/^\s*(\*|\/\/)/.test(line));
      if (hit !== -1) offenders.push(`${name}:${hit + 1} 用了 z.${method}()`);
    }
  }
  assert.deepEqual(offenders, [], `schemastery 没有这些方法：\n${offenders.join('\n')}`);
});

test('Config 用 union([const…]) 表达枚举，且缺省值为 session', () => {
  const source = readFileSync(join(LIB, 'index.js'), 'utf8');
  assert.match(
    source,
    /defaultInjectionMode:\s*z\.union\(\[z\.const\('always'\),\s*z\.const\('session'\)\]\)\.default\('session'\)/,
    'defaultInjectionMode 必须用 schemastery 支持的 z.union([z.const…])，缺省 session',
  );
});

test('schemastery 的 union+const 真的能按预期校验（直接跑一遍语义）', async () => {
  const { default: z } = await import('@deepseek-ai/schemastery');
  const schema = z.union([z.const('always'), z.const('session')]).default('session');
  assert.equal(schema(undefined), 'session', '未配置时必须是 session（补丁移除后的兜底）');
  assert.equal(schema('always'), 'always');
  assert.throws(() => schema('nope'), /always|session/);
});
