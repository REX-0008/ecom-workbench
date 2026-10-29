/** 内容画布测试的**共享底座**（jsdom、假宿主、挂载器、DOM 小工具）。
 *
 * ## 为什么要抽这个文件（2026-10-26）
 *
 * `content-canvas.mjs` 长到 **2927 行 / 20.7 秒**，破了 20 秒的慢测试线
 * （`scripts/run-tests.mjs` 的 `SLOW_MS`）。拆开量过时间，两笔账：
 *
 * ```
 * act 累计     11.4s（281 次）   ← React 真渲染 + effect flush
 * settle 累计   7.7s（145 次）   ← 等任务队列跑空
 * 其余          0.6s             ← 同步断言 / 纯函数 / 模块加载
 * ```
 *
 * 所以「哪里慢」是清楚的：**没有一个可以白省的等待**。能做的只有两件：
 *   ① 把这些底座抽出来，两个测试文件共用（不然拆开后各写一份，两份会漂移）；
 *   ② 按段落拆成两个文件，各自独立挂载，让**每个进程**各自回到 15 秒以内。
 *
 * ## `settle` 一次都没删
 *
 * 拆的时候**没有**删任何一次等待、也没有把 `settle` 的轮次调小 ——
 * 那是「把测试调成刚好够慢」，本项目踩过（见 `tests/_wait.mjs` 的说明）。
 * 拆前后 145 次 `settle`、281 次 `act` 全部保留，只是分到了两个进程里跑。
 *
 * ## 用 `_` 前缀
 *
 * `scripts/run-tests.mjs` 按约定**排除** `tests/` 下以 `_` 开头的文件 ——
 * 它们是共享工具、一条断言都没有，混进「全部 N 个通过」会让计数说谎。
 *
 * ## ⚠️ `S` 里的字段是**可变的**，测试会逐段改它们
 *
 * `genReply` / `genNextId` / `genModelList` / `materialList` 会被测试重新赋值，
 * 所以它们必须是 `S` 的**属性**，不能解构成裸变量 —— 解构拿到的是赋值那一刻的值，
 * 后面 `S.genReply = …` 改不到它，假宿主就永远按老值答。
 */

import { createRequire, register } from 'node:module'
import { settle as settleRaw, waitUntil } from './_wait.mjs'

/* ⚠️ `.css` / `.module.css` 当空模块（与打包器对 CSS Modules 的语义一致）。
 * 源码组件 import 了 `.module.css`，Node 不认识那个扩展名会直接抛。 */
register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, ctx, next) {\n'
  + "  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }\n"
  + '  return next(url, ctx)\n'
  + '}\n',
))

const require = createRequire(import.meta.url)

/**
 * 建一套测试环境：jsdom + 假宿主 + 挂载器 + 断言计数器。
 *
 * 每次调用都是**全新的一份**（新 jsdom、空的内存画布库），
 * 所以两个测试文件各自调一次，互不影响。
 *
 * @returns {Promise<object>} 环境句柄。
 */
export async function createEnv() {
  const { JSDOM } = require('jsdom')

  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  })
  const { window } = dom
  globalThis.window = window
  globalThis.document = window.document
  try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }) } catch { /* 只读则跳过 */ }
  globalThis.localStorage = window.localStorage
  globalThis.HTMLElement = window.HTMLElement
  globalThis.Element = window.Element
  globalThis.Node = window.Node
  globalThis.getComputedStyle = window.getComputedStyle
  globalThis.requestAnimationFrame = window.requestAnimationFrame
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame
  globalThis.ResizeObserver = window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }

  /* jsdom 缺这些浏览器 API，React Flow 会用到 —— 补最小实现（真实浏览器自带）。
   * 与 `tests/dom-render.mjs` 里那一段同一套，不是绕错，是把环境补到与浏览器等价。 */
  class DOMMatrixStub {
    m22 = 1; a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    constructor(init) { if (Array.isArray(init)) { [this.a, this.b, this.c, this.d, this.e, this.f] = init } }
    inverse() { return new DOMMatrixStub() }
    multiply() { return new DOMMatrixStub() }
    translate() { return new DOMMatrixStub() }
    scale() { return new DOMMatrixStub() }
  }
  window.DOMMatrixReadOnly = window.DOMMatrixReadOnly ?? DOMMatrixStub
  window.DOMMatrix = window.DOMMatrix ?? DOMMatrixStub
  globalThis.DOMMatrixReadOnly = window.DOMMatrixReadOnly
  globalThis.DOMMatrix = window.DOMMatrix
  window.SVGElement = window.SVGElement ?? window.HTMLElement
  globalThis.SVGElement = window.SVGElement
  window.matchMedia = window.matchMedia ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  globalThis.matchMedia = window.matchMedia

  /* ── 断言计数 ───────────────────────────────────────────────────────── */
  let failed = 0
  /**
   * 断言。
   * @param name - 断言名。
   * @param cond - 是否通过。
   * @param detail - 附注。
   */
  function check(name, cond, detail = '') {
    console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
    if (!cond) failed += 1
  }

  /* ── 可变状态（测试逐段改它，所以必须是属性） ────────────────────────── */
  const S = {
    /** 内存里的一份画布（形状照 `src/schedule/canvases.ts` 的 `CanvasDoc`）。 */
    mem: new Map(),
    /** 收到的写请求（断言直接查它，比查界面文字准）。 */
    puts: [],
    /** 收到的生成提交（断言查它）。 */
    genPosts: [],
    /** 收到的轮询（验「轮询真的在跑」）。 */
    genPolls: [],
    /** 收到的取消。 */
    genCancels: [],
    /** 收到的素材上传。 */
    materialPosts: [],
    /** 收到的 `POST /artifact`（用户 m02814 #101：拖文件 / 粘图都要走这条存成产物）。 */
    artifactPosts: [],
    /** 下一次 `GET /generate/:id` 该怎么答（测试逐段改它）。 */
    genReply: { status: 'running', waitedMs: 3000, artifacts: [], error: '' },
    /** `GET /materials` 被调了几次（契约 CJ：断言「点了才拉」，不是挂载就拉）。 */
    materialGets: [],
    /** `GET /materials` 回什么（测试可逐段改）。 */
    materialList: [
      { name: '素材-甲.png', bytes: 100, mtime: 1, url: '/api/ecom-workbench/material/%E7%B4%A0%E6%9D%90-%E7%94%B2.png' },
      { name: '素材-乙.png', bytes: 200, mtime: 2, url: '/api/ecom-workbench/material/%E7%B4%A0%E6%9D%90-%E4%B9%99.png' },
    ],
    /** `/gen-models` 回什么（默认一条能做图片 + 视频的）。 */
    genModelList: [
      {
        channelId: 'ch_local', channelName: '本地 ComfyUI', protocol: 'comfyui',
        modelId: 'flux-pro', modelLabel: 'Flux Pro', caps: ['image', 'video'],
      },
    ],
    /** 下一次 `POST /generate` 回的任务 id。 */
    genNextId: 'task-1',
  }

  /**
   * 造一份画布记录。
   * @param id - id。
   * @param title - 标题。
   * @param nodes - 节点。
   * @param edges - 连线。
   * @param viewport - 视口。
   * @returns 记录。
   */
  function mkDoc(id, title, nodes = [], edges = [], viewport = { x: 0, y: 0, zoom: 1 }) {
    const now = Date.now()
    return { id, title, createdAt: now, updatedAt: now, nodes, edges, viewport }
  }

  /** 造一条画布库摘要（宿主列表只回这个，不回节点内容）。 */
  function summary(d) {
    return { id: d.id, title: d.title, createdAt: d.createdAt, updatedAt: d.updatedAt, nodeCount: d.nodes.length }
  }

  /** 取路径部分。 */
  function pathOf(url) {
    return String(url).replace(/^https?:\/\/[^/]+/, '')
  }

  /** 桩宿主：按 `src/index.ts:1575-1620` 那几条路由的形状回。 */
  /* ── 生成链路的假宿主（契约 CH，形状照 `src/index.ts:1613-1700`）──
   *
   *   ① GET  /gen-models?kind=x   → { ok, models, items }
   *   ② POST /generate            → { ok, id, task }
   *   ③ GET  /generate/:id        → { ok, task }
   *   ④ POST /generate/:id/cancel → { ok }
   *
   * **全是内存桩**，绝不连真后端。
   */
  const host = async (url, init) => {
    const p = pathOf(url)
    const method = String(init?.method ?? 'GET').toUpperCase()
    const ok = (body) => ({ ok: true, status: 200, json: async () => body })
    const notFound = (id) => ({ ok: false, status: 404, json: async () => ({ ok: false, error: '没有这个画布：' + id }) })

    /* ── 生成链路四条路由（契约 CH）── */
    if (p.startsWith('/api/ecom-workbench/gen-models') && method === 'GET') {
      return ok({ ok: true, models: S.genModelList, items: S.genModelList })
    }
    if (p === '/api/ecom-workbench/generate' && method === 'POST') {
      S.genPosts.push(JSON.parse(String(init?.body ?? '{}')))
      return ok({
        ok: true,
        id: S.genNextId,
        task: {
          id: S.genNextId, kind: 'image', status: 'submitted', stage: 'submitted',
          prompt: '', model: '', channelId: '', channelName: '',
          createdAt: Date.now(), waitedMs: 0, artifacts: [], history: [],
        },
      })
    }
    if (p.startsWith('/api/ecom-workbench/generate/') && p.endsWith('/cancel') && method === 'POST') {
      S.genCancels.push(decodeURIComponent(p.slice('/api/ecom-workbench/generate/'.length, -'/cancel'.length)))
      return ok({ ok: true })
    }
    if (p.startsWith('/api/ecom-workbench/generate/') && method === 'GET') {
      const id = decodeURIComponent(p.slice('/api/ecom-workbench/generate/'.length))
      S.genPolls.push(id)
      const reply = S.genReply
      return ok({
        ok: true,
        task: {
          id, kind: 'image', status: reply.status, stage: reply.status,
          prompt: '一只猫', model: 'flux-pro', channelId: 'ch_local', channelName: '本地 ComfyUI',
          createdAt: Date.now(), waitedMs: reply.waitedMs,
          artifacts: reply.artifacts,
          ...reply.error === '' ? {} : { error: reply.error },
          history: [],
        },
      })
    }
    /* `POST /artifact`（用户 m02814）：拖文件 / 粘图 / 裁剪结果都存到这里。 */
    if (p === '/api/ecom-workbench/artifact' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      S.artifactPosts.push(body)
      return ok({ ok: true, id: 'art-test-' + String(S.artifactPosts.length), ext: 'png', mime: 'image/png', bytes: 3, createdAt: Date.now(), url: '/api/ecom-workbench/artifact/art-test-1' })
    }
    if (p === '/api/ecom-workbench/materials' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      S.materialPosts.push(body)
      return ok({ ok: true, material: { name: body.name ?? '上传的.png', bytes: 10, createdAt: Date.now() } })
    }
    /* `GET /materials`（契约 CJ）：参考图选择器与侧栏素材 tab **共用**这条路。
     * 记一次调用，断言要能证明「点了才拉」。 */
    if (p === '/api/ecom-workbench/materials' && method === 'GET') {
      S.materialGets.push(1)
      return ok({ ok: true, dir: '/tmp/materials', materials: S.materialList, items: S.materialList })
    }
    /* 产物字节（二进制路由）：`onSaveAsset` 要先把产物取回来再 base64 传上去。 */
    if (p.startsWith('/api/ecom-workbench/artifact/')) {
      return {
        ok: true, status: 200,
        json: async () => ({}),
        arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]).buffer,
      }
    }

    if (p === '/api/ecom-workbench/canvases' && method === 'GET') {
      return ok({ ok: true, canvases: [...S.mem.values()].map(summary) })
    }
    if (p === '/api/ecom-workbench/canvases' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}'))
      const id = 'cv_test' + String(S.mem.size + 1)
      /* ★ 照 `src/schedule/canvases.ts:148-156` 的 `createCanvas` 真实行为：
       * 请求体里带了 `nodes` / `edges` / `viewport` 就一起建出来（票 46：
       * 复制画布靠这一条一次提交，不留半成品）。不带就空着。 */
      const d = mkDoc(
        id,
        typeof body.title === 'string' && body.title !== '' ? body.title : '未命名画布',
        Array.isArray(body.nodes) ? body.nodes : [],
        Array.isArray(body.edges) ? body.edges : [],
        body.viewport !== undefined ? body.viewport : { x: 0, y: 0, zoom: 1 },
      )
      S.mem.set(id, d)
      return ok({ ok: true, canvas: d })
    }
    if (p.startsWith('/api/ecom-workbench/canvases/')) {
      const id = decodeURIComponent(p.slice('/api/ecom-workbench/canvases/'.length))
      const cur = S.mem.get(id)
      if (cur === undefined) return notFound(id)
      if (method === 'GET') return ok({ ok: true, canvas: cur })
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body ?? '{}'))
        S.puts.push({ id, body })
        const next = {
          ...cur,
          title: typeof body.title === 'string' && body.title !== '' ? body.title : cur.title,
          updatedAt: Date.now(),
          nodes: Array.isArray(body.nodes) ? body.nodes : cur.nodes,
          edges: Array.isArray(body.edges) ? body.edges : cur.edges,
          viewport: body.viewport !== undefined ? body.viewport : cur.viewport,
        }
        S.mem.set(id, next)
        return ok({ ok: true, canvas: next })
      }
      if (method === 'DELETE') { S.mem.delete(id); return ok({ ok: true }) }
    }
    /* 其余接口一律空成功（骨架别的地方会拉工作流列表这些）。 */
    return ok({ ok: true, items: [] })
  }
  window.fetch = host
  globalThis.fetch = host

  const React = require('react')
  const { createRoot } = require('react-dom/client')
  const { act } = React
  globalThis.React = React

  /** 挂一个组件，等副作用跑完。 */
  async function mount(el) {
    const hostEl = window.document.createElement('div')
    window.document.body.appendChild(hostEl)
    const root = createRoot(hostEl)
    await act(async () => { root.render(el) })
    /* ★ 挂载后等副作用跑完：**等任务队列跑空**，不再死等一个猜出来的毫秒数。
     * 见 `tests/_wait.mjs` 的说明。这一段一次都没删过。 */
    await act(async () => { await settleRaw() })
    return {
      el: hostEl,
      async rerender(next) { await act(async () => { root.render(next) }); await act(async () => { await settleRaw() }) },
      unmount() { act(() => { root.unmount() }); hostEl.remove() },
    }
  }

  /** 点一下（React 合成事件要走冒泡的真鼠标事件）。 */
  async function click(el) {
    if (el === null || el === undefined) return
    await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await act(async () => { await settleRaw() })
  }

  /**
   * 点一个节点的内层盒子。
   *
   * ⚠️ 必须派在内层那个 `[data-ewb-content-node]` 上：`.react-flow__node` 只是
   * React Flow 的包装层，事件不会往下冒泡 —— 派在外层会误报成「单击没反应」。
   *
   * @param mm - 挂载句柄。
   * @param id - 节点 id。
   */
  async function clickInner(mm, id) {
    await click(mm.el.querySelector('.react-flow__node[data-id="' + id + '"] [data-ewb-content-node]'))
  }

  /**
   * 造一个带 `dataTransfer` 的事件。
   *
   * jsdom 里 `DragEvent` 不是构造器，而 `new Event('dragstart')` 又没有
   * `dataTransfer` 属性。所以用 `Event` 起一个，再把 `dataTransfer`
   * 与坐标**手动挂上去** —— 验的是我们自己的回调怎么用它，不是浏览器的实现。
   *
   * @param {string} type 事件名。
   * @param {object} dt `DataTransfer` 桩。
   * @param {object} [pt] 可选的坐标（drop 落点要用）。
   * @returns {Event} 事件。
   */
  function dragEvent(type, dt, pt = {}) {
    const e = new window.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(e, 'dataTransfer', { value: dt, configurable: true })
    if (pt.clientX !== undefined) Object.defineProperty(e, 'clientX', { value: pt.clientX, configurable: true })
    if (pt.clientY !== undefined) Object.defineProperty(e, 'clientY', { value: pt.clientY, configurable: true })
    return e
  }

  /* `settle` 保持原来那个真家伙（不调轮次）。 */
  const settle = (opts) => settleRaw(opts)

  const { ContentCanvas } = await import('../src/client/workbench/ContentCanvas.tsx')

  return {
    window, document: window.document, React, act,
    S, mkDoc, summary, host, check,
    mount, click, clickInner, dragEvent, settle, waitUntil,
    ContentCanvas,
    /** 已失败的断言条数（文件末尾据此定退出码）。 */
    getFailed: () => failed,
  }
}
