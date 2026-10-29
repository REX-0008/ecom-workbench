/** 画布渲染测试：真渲染 WorkflowCanvas，抓渲染期崩溃。
 *
 * 背景：用户多次报告「点工作流插件崩」。之前的冒烟测试只渲染到 EcomWorkbench，
 * 但 ReactFlow 需要浏览器环境才渲染，所以真正的错误没被捕获。
 * 这个测试**直接把 WorkflowCanvas 单独渲染**（不经过 ReactFlow 的完整树）。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const React = require('react')
const { renderToString } = require('react-dom/server')

function makeEl() {
  return {
    style: { setProperty: () => {}, removeProperty: () => {} },
    dataset: {}, textContent: '', className: '',
    setAttribute: () => {}, getAttribute: () => null,
    appendChild: () => {}, removeChild: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    classList: { add: () => {}, remove: () => {}, contains: () => false },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 }),
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null,
  }
}

let factory = null
globalThis.window = {
  __ModuleLoader__: { load: (o) => { factory = o.factory } },
  location: { href: 'http://localhost/' },
  addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: (cb) => { setTimeout(cb, 0); return 1 },
  cancelAnimationFrame: () => {},
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
}
globalThis.document = {
  createElement: makeEl, createTextNode: () => ({}),
  /* ⚠️ `head` / `body` 必须都是**完整元素**（带 querySelectorAll / appendChild / style），
   * 不能只是 `{ appendChild }` 的壳（2026-10-27 改准）。
   *
   * 为什么：产物里现在有 **antd**（`PromptCard.tsx` 引入的），它的 cssinjs 在
   * `createCache` 里第一件事就是
   *   `document.body.querySelectorAll('style[data-css-hash]')`
   * 壳里没有 querySelectorAll 就直接抛
   *   `TypeError: document.body.querySelectorAll is not a function`
   * —— 而那个错**在产物加载阶段**抛，报错栈指着 antd 内部某一行，
   * 看着完全不像环境问题（会让人以为组件写坏了）。
   *
   * 补的是「把环境补到与浏览器等价」，不是绕错：真实浏览器里 `document.body`
   * 本来就是一个完整元素。 */
  head: Object.assign(makeEl(), {
    appendChild: () => {}, removeChild: () => {},
    querySelector: () => null, querySelectorAll: () => [],
  }),
  body: Object.assign(makeEl(), {
    appendChild: () => {}, removeChild: () => {}, insertBefore: () => {},
    querySelector: () => null, querySelectorAll: () => [],
    contains: () => false,
  }),
  getElementById: () => null,
  querySelector: () => null, querySelectorAll: () => [],
  getElementsByTagName: () => [],
  documentElement: Object.assign(makeEl(), {
    style: { setProperty: () => {}, removeProperty: () => {} }, dataset: {},
  }),
  addEventListener: () => {}, removeEventListener: () => {},
}
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
try { globalThis.location = { href: 'http://localhost/' } } catch { /* 只读则跳过 */ }
globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame
globalThis.cancelAnimationFrame = globalThis.window.cancelAnimationFrame
globalThis.ResizeObserver = globalThis.window.ResizeObserver

const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
new Function('window', 'document', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', code)(
  globalThis.window, globalThis.document, globalThis.localStorage,
  globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame, globalThis.ResizeObserver,
)
console.log('① bundle 加载:', factory === null ? '失败' : '成功')

const fakeRequire = (name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return require('react/jsx-runtime')
  try { return require(name) } catch { throw new Error('缺依赖: ' + name) }
}

const comps = []
const fakeCtx = {
  effect: (fn) => { try { fn() } catch { /* 忽略 */ } return () => {} },
  inject: () => () => {},
  slots: {
    inject: (n, fn) => { try { fn() } catch { /* 忽略 */ } return () => {} },
    register: (opts, comp) => { if (typeof comp === 'function') comps.push({ name: String(opts?.name), fn: comp }); return () => {} },
  },
}
const exports = factory(fakeRequire)
exports.apply(fakeCtx)

/* 渲染 shell.overlay（工作台主界面，内部含 WorkflowCanvas） */
const target = comps.find(c => c.name === 'shell.overlay')
if (target === undefined) { console.log('✗ 没找到组件'); process.exit(1) }

try {
  const html = renderToString(React.createElement(target.fn))
  console.log('② 工作台渲染成功，HTML', html.length, '字符')
  console.log('   含板块导航:', html.includes('商品'))
  console.log('   含内容占位:', html.includes('内容待接入') || html.includes('工作流'))
} catch (e) {
  console.log('✗ 工作台渲染失败:', e.message)
  console.log((e.stack || '').split('\n').slice(0, 20).join('\n'))
  process.exit(1)
}
console.log('③ 测试结束')
