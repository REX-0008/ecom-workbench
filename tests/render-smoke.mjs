/** 渲染冒烟测试：把插件 bundle 载进假环境，真渲染 WorkflowCanvas，抓崩溃与死循环。
 *
 * 背景：2026-10-08「点工作流插件崩」——根因是 runSeq 依赖 nodes + 节点回调依赖 runSeq，
 * 形成 setNodes → 重渲染 → setNodes 的无限循环（React 会报 Maximum update depth exceeded）。
 *
 * 这个测试真调用组件的渲染函数，能捕获渲染期抛错。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToString } = require('react-dom/server')

/* 1) 造一个假 window.__ModuleLoader__ 来截获 factory */
let factory = null
globalThis.window = {
  __ModuleLoader__: {
    load: (o) => { factory = o.factory },
  },
  location: { href: 'http://localhost/' },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
}
/** 造一个够真的 style 元素（插件会写 dataset / textContent）。 */
function makeEl() {
  return {
    style: { setProperty: () => {}, removeProperty: () => {} },
    dataset: {},
    textContent: '',
    className: '',
    setAttribute: () => {},
    getAttribute: () => null,
    appendChild: () => {},
    removeChild: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    classList: { add: () => {}, remove: () => {}, contains: () => false },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
    querySelector: () => null,
    querySelectorAll: () => [],
  }
}
globalThis.document = {
  createElement: makeEl,
  createTextNode: () => ({}),
  head: { appendChild: () => {} },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  documentElement: { style: { setProperty: () => {} }, dataset: {} },
  addEventListener: () => {},
}
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
// ELK / 浏览器库可能摸的全局属性（缺了会在构造期抛错）
// navigator 在 Node 24 是只读的，跳过；location 可以设
try { globalThis.location = { href: 'http://localhost/' } } catch { /* 只读则跳过 */ }
if (globalThis.Error.stackTraceLimit === undefined) {
  try { Object.defineProperty(Error, 'stackTraceLimit', { value: 10, writable: true, configurable: true }) } catch { /* 不可写就算了 */ }
}

/* 2) 加载 bundle（它自己会调 window.__ModuleLoader__.load） */
const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
// 用 Function 执行（bundle 顶层就调 load）
new Function('window', 'document', 'localStorage', code)(globalThis.window, globalThis.document, globalThis.localStorage)
console.log('① bundle 加载:', factory === null ? '失败（没调到 load）' : '成功')

/* 3) 跑 factory 拿导出 */
if (factory !== null) {
  const fakeRequire = (name) => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return require('react/jsx-runtime')
    if (name === 'react-dom') return require('react-dom')
    if (name === 'react-dom/server') return require('react-dom/server')
    // 其余依赖（xyflow / zustand / elkjs 等）真从 node_modules 取
    try { return require(name) } catch {
      throw new Error('未预期的依赖: ' + name)
    }
  }
  try {
    const exports = factory(fakeRequire)
    console.log('② factory 执行成功，导出:', Object.keys(exports).join(', '))
  } catch (e) {
    console.log('② factory 执行失败:', e.message)
    console.log('--- 调用栈 ---')
    console.log((e.stack || '').split('\n').slice(0, 25).join('\n'))
  }
}
/* 4) 真渲染测试：渲染 WorkflowCanvas，捕获渲染期异常与无限循环 */
if (factory !== null) {
  const fakeRequire = (name) => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return require('react/jsx-runtime')
    try { return require(name) } catch { throw new Error('未预期的依赖: ' + name) }
  }
  try {
    const exports = factory(fakeRequire)
    /* 造一个最小 ctx，调用 apply，看它注册什么 */
    const registered = []
    const fakeCtx = {
      effect: (fn) => { try { fn() } catch { /* 忽略 */ } return () => {} },
      inject: (deps, fn) => { try { fn(fakeCtx) } catch (e) { registered.push('inject 失败: ' + e.message) } return () => {} },
      slots: {
        inject: (name, fn) => { registered.push('slot: ' + name); try { fn() } catch { /* 忽略 */ } return () => {} },
        register: (opts) => { registered.push('register: ' + String(opts?.name) + ':' + String(opts?.id)); return () => {} },
      },
    }
    if (typeof exports.apply === 'function') {
      exports.apply(fakeCtx)
      console.log('③ apply 执行成功（未抛错）')
      console.log('   注册动作:', registered.join(' | ') || '(无)')
    }
  } catch (e) {
    console.log('③ 失败:', e.message)
    console.log((e.stack || '').split('\n').slice(0, 12).join('\n'))
  }
}
console.log('④ 测试结束')
/* 5) 真渲染：截获 apply 注册的组件，用 react-dom/server 渲染 */
if (factory !== null) {
  const fakeRequire = (name) => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return require('react/jsx-runtime')
    try { return require(name) } catch { throw new Error('未预期的依赖: ' + name) }
  }
  const exports = factory(fakeRequire)
  const comps = []
  const fakeCtx = {
    effect: (fn) => { try { fn() } catch { /* 忽略 */ } return () => {} },
    inject: () => () => {},
    slots: {
      inject: (name, fn) => { try { fn() } catch { /* 忽略 */ } return () => {} },
      register: (opts, comp) => {
        // comp 是一个「返回组件元素」的函数（注册时包了一层）
        if (typeof comp === 'function') comps.push({ name: String(opts?.name), id: String(opts?.id), fn: comp })
        return () => {}
      },
    },
  }
  exports.apply(fakeCtx)
  console.log('⑤ 截获组件数:', comps.length)

  /* 只渲染画布那个（shell.overlay）；它是右列，内部才有 ReactFlow */
  const target = comps.find(c => c.name === 'shell.overlay')
  if (target !== undefined) {
    try {
      // 正确方式：把注册函数当「组件」渲染（它内部会返回元素）
      const Comp = target.fn
      const html = renderToString(React.createElement(Comp))
      console.log('⑥ 渲染成功，HTML 长度:', html.length)
      console.log('   含 ReactFlow 容器:', html.includes('react-flow'))
      console.log('   含板块导航:', html.includes('商品') || html.includes('客服'))
    } catch (e) {
      console.log('⑥ 渲染失败:', e.message)
      console.log((e.stack || '').split('\n').slice(0, 18).join('\n'))
    }
  } else {
    console.log('⑥ 没找到 shell.overlay 组件')
  }
}