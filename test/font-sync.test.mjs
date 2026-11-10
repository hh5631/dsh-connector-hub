import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 复刻 hub.js 在 iframe 里的运行环境，验证「收到主题字体 → 写入 :root」全链路
const rootProps = new Map();
const nodes = new Map();
const mk = (id) => ({ id, hidden:false, textContent:'', innerHTML:'', value:'', placeholder:'', dataset:{}, options:{length:0}, disabled:false, className:'', addEventListener(){}, setAttribute(){}, focus(){}, querySelector(){return null;}, querySelectorAll(){return [];} });
const get = (id) => { if(!nodes.has(id)) nodes.set(id,mk(id)); return nodes.get(id); };
const listeners = [];
const document = {
  title:'', hidden:false,
  documentElement:{ lang:'zh-CN', style:{ setProperty:(k,v)=>rootProps.set(k,v), removeProperty:(k)=>rootProps.delete(k), getPropertyValue:(k)=>rootProps.get(k)??'' } },
  getElementById:get, querySelectorAll:()=>[], createElement:()=>mk('t'),
  addEventListener:(t,f)=>{ if(t==='keydown') listeners.push(f); },
};
const posted = [];
const window = {
  location:{origin:'http://127.0.0.1:4174', search:''},
  __CONNECTOR_HUB_LOCALE__:'zh-CN',
  parent:{ postMessage:(msg)=>posted.push(msg) },
  addEventListener:(t,f)=>{ if(t==='message') listeners.push(f); if(t==='pagehide') {} },
};
const ctx = { document, window, location:window.location, EventSource: class { addEventListener(){} close(){} },
  URLSearchParams, setTimeout, clearTimeout, AbortController, console,
  fetch: async () => ({ ok:true, json: async () => ({ ok:true, detail:{ items:[], total:0, connections:[] } }) }),
  confirm:()=>false };
ctx.globalThis = ctx;
vm.createContext(ctx);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
vm.runInContext(readFileSync(join(root, 'ui/hub.js'), 'utf8'), ctx, { filename: 'hub.js' });

test('宿主字体同步（iframe 消息契约）', () => {

// 1) 面板应主动请求字体
  assert(posted.some(m=>m.type==='connector-hub:theme-fonts-request'), '面板启动时请求宿主字体');

// 2) 模拟宿主推送字体
  const msg = { type:'connector-hub:theme-fonts', fonts:{
  text:'"Source Han Sans", "PingFang SC", sans-serif',
  code:'"Fira Code", monospace',
  contentSize:'17px',
}};
  for (const f of listeners) f({ origin:'http://127.0.0.1:4174', data:msg });
  assert(rootProps.get('--dsh-font-family-text')==='"Source Han Sans", "PingFang SC", sans-serif', '收到字体：text 写入 :root');
  assert(rootProps.get('--dsh-font-family-code')==='"Fira Code", monospace', '收到字体：code 写入 :root');
  assert(rootProps.get('--dsh-content-font-size')==='17px', '收到字体：字号写入 :root');

// 3) 模拟宿主切换到另一套字体（实时切换）
  const msg2 = { type:'connector-hub:theme-fonts', fonts:{
  text:'"LXGW WenKai", serif', code:'"Cascadia Code", monospace', contentSize:'15px',
}};
  for (const f of listeners) f({ origin:'http://127.0.0.1:4174', data:msg2 });
  assert(rootProps.get('--dsh-font-family-text')==='"LXGW WenKai", serif', '切换字体：text 已更新');
  assert(rootProps.get('--dsh-content-font-size')==='15px', '切换字号：已更新');

// 4) 跨源消息必须被拒绝
  const before = rootProps.get('--dsh-font-family-text');
  for (const f of listeners) f({ origin:'https://evil.example', data:{ type:'connector-hub:theme-fonts', fonts:{ text:'hacked', code:'x', contentSize:'99px' } } });
  assert(rootProps.get('--dsh-font-family-text')===before, '跨源消息被拒绝（字体未被篡改）');

// 5) 清空字体 → 回退系统栈
  for (const f of listeners) f({ origin:'http://127.0.0.1:4174', data:{ type:'connector-hub:theme-fonts', fonts:{ text:'', code:'', contentSize:'' } } });
  assert(!rootProps.has('--dsh-font-family-text'), '清空后移除变量（回退系统字体栈）');

});
