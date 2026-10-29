/** 错误边界：**一块渲染抛错不该让整个工作台白屏**（用户 2026-10-21 报的现象）。
 *
 * ## 这个测试守的是什么
 *
 * 用户原话：「点打开到画布，然后整个插件界面空了。」
 *
 * 根因不是某一行算错了，而是**全项目一个错误边界都没有**：
 * React 的默认行为是「渲染期抛错 → 卸载整棵子树」，
 * 而画布是常驻挂载、还包着整个 React Flow 的一大块 ——
 * 它里面任何一处抛错，结果不是「画布坏了」，而是**整个工作台变成空白**，
 * 且一个字的提示都没有。
 *
 * 所以判据必须落在两件**看得见**的事实上：
 *
 *   ① 画布抛错时，**别的东西还在**（tab 条、列表还能点）；
 *   ② 界面上**说得出**错在哪一句（错误原文 + 组件栈），而不是一片空白。
 *
 * ⚠️ 判据不能只查「源码里有没有 ErrorBoundary 这个词」—— 那样包了但没生效
 * （比如包在永远不抛的那一层、或者被条件渲染跳过）也会绿。
 * 所以这里**真的让子树抛一次**，然后看 DOM。
 *
 * 跑法：node tests/error-boundary.mjs（读源码，纯 node，不需要 bundle）
 */
import { readFileSync } from 'node:fs'
import { register } from 'node:module'

/* ⚠️ **必须先装这个钩子**：`ErrorBoundary.tsx` 里 `import css from './error-boundary.module.css'`，
 * 而 Node 不认识 `.css`（报 `ERR_UNKNOWN_FILE_EXTENSION`）。
 *
 * 不该为了测试去改组件（把 `import css` 删掉或改成注入 —— 那是为测试改生产代码）。
 * 正确做法是在**加载器**这一层说「.css 一律当空对象」—— 与打包器对 CSS Modules 的
 * 处理在语义上一致（类名映射，值是什么测试不关心）。
 *
 * 只在测试进程里生效，不影响构建。 */
register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, ctx, next) {\n'
  + "  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }\n"
  + '  return next(url, ctx)\n'
  + '}\n',
))

let failed = 0
/** 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

const ROOT = new URL('../', import.meta.url)
/** 读源码。
 * @param p - 相对仓库根的路径。
 * @returns 文本。 */
const src = (p) => readFileSync(new URL(p, ROOT), 'utf8')

console.log('=== ① 错误边界自己：能抓、能说、能重试 ===')
{
  const s = src('src/client/workbench/ErrorBoundary.tsx')
  /* ⚠️ React 只支持 class 写错误边界 —— 函数组件抓不到子树的渲染异常。 */
  check('是 class 组件（函数组件抓不到）', /export class ErrorBoundary extends Component/.test(s))
  check('★ 实现了 getDerivedStateFromError（少了它 React 照旧卸载整棵树）', /static getDerivedStateFromError/.test(s))
  check('实现了 componentDidCatch（收组件栈）', /componentDidCatch/.test(s))
  check('★ 界面显示错误原文（不是只说「出错了」）', /data-ewb-error-msg/.test(s))
  check('★ 显示组件栈', /data-ewb-error-stack|componentStack/.test(s) || s.includes('this.state.info'))
  check('★ 有「重试」按钮且真的清错误状态', /data-ewb-error-retry/.test(s) && /setState\(\{ error: null/.test(s))
  check('★ 有「退出去」的路（不然卡死在白屏）', /onEscape/.test(s))
  /* 判据 2026-10-22 改：原文案「不是你的数据坏了」带第二人称与口语（违反 R6），
   * 已改成「数据未损坏」。断言改为查这句**安抚语义**本身 ——
   * 防的是「兜底界面不提数据安全」，不是防某个具体措辞。 */
check('明说「数据未损坏」（用户这时最怕的是丢东西）', /数据未损坏/.test(s))
  /* ⚠️ 兜底界面**外层**不能 overflow:hidden（本项目硬教训：flex 子项
   * overflow≠visible 时自动最小尺寸算 0，会被压到 0 高且不出滚动条）。
   * ⚠️ 但**内层**（`.body` / `.stack`）必须能滚 —— 组件栈几十行，不给滚就看不全。
   *
   * ⚠️⚠️ **剥注释再判**：这个文件的 `.wrap` 注释里就写着「不能 overflow:hidden」，
   * 不剥的话那条注释自己会被当成违规（我第一版就这么假红了一次）。 */
  const stripCss = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '')
  const cssText = src('src/client/workbench/error-boundary.module.css')
  const wrapBlock = stripCss(/\.wrap\s*\{([^}]*)\}/.exec(cssText)?.[1] ?? '')
  check('★ 兜底界面的外层没有 overflow:hidden', !/overflow\s*:\s*hidden/.test(wrapBlock), wrapBlock === '' ? '（没找到 .wrap 规则！）' : '')
  check('★ 内层能滚（组件栈要看得全）', /\.body\s*\{[^}]*overflow-y\s*:\s*auto/.test(stripCss(cssText)))
}

console.log('')
console.log('=== ② 每块板块外面都包了（画布那层单独再包一次）===')
{
  const s = src('src/client/workbench/EcomWorkbench.tsx')
  check('EcomWorkbench 里用了 ErrorBoundary', s.includes('h(ErrorBoundary'))
  /* 骨架里那条：**每一个注册的板块**都包在边界里（名字取板块自己的标题）。
   * 判据是「渲染注册项 component 的那一句在边界的子树里」——
   * 包了但没包住 component（比如包在容器外层却没接住）不算。 */
  /* 判据：`h(b.component, …)` 紧跟在边界里面（中间只有换行/缩进）。 */
  const wrapped = /h\(ErrorBoundary,\s*\{[^}]*\},\s*h\(b\.component,/.test(s)
    && /h\(ErrorBoundary,\s*\{[^}]*key:\s*b\.id[^}]*\},\s*h\(b\.component,/.test(s)
  check('★★ 每个注册的板块都在它的子树里（包对了层）', wrapped)
  /* 画布那一层：它风险最高（吃任意存档、渲染几十个节点、还常驻挂载），
   * 所以画布再单独包一层 —— 那一层在板块自己的文件里。 */
  const wb = src('src/client/workbench/WorkflowBoard.tsx')
  const at = wb.indexOf('h(ErrorBoundary')
  check('★ 画布单独又包了一层（在板块自己的文件里）', at >= 0)
  const region = wb.slice(at, at + 600)
  check('★★ 画布在它的子树里（包对了层）', region.includes('WorkflowCanvasSwitch'))
  check('★ 名字写的是「画布」（提示里要能定位）', /name:\s*'画布'/.test(region))
  check('★ 出错了能退回列表', /onEscape/.test(region) && /onSelectTab\('files'\)/.test(region))
  /* ⚠️ 反向断言：**不许**包住整个工作台 —— 把提示条也吃掉就又白屏了。 */
  const bodyAt = s.indexOf("className: css.body")
  check('★ 没有把整个 body 包起来（否则提示条一起没了）', !(bodyAt >= 0 && s.slice(bodyAt - 300, bodyAt).includes('h(ErrorBoundary')))
}

console.log('')
console.log('=== ③ 一处边界只包一块；身份该稳的稳、该换的换 ===')
{
  const s = src('src/client/workbench/EcomWorkbench.tsx')
  const n = (s.match(/h\(ErrorBoundary/g) ?? []).length
  check('★ 骨架里两处，各包一块（常驻板块的格子 / 普通板块的滚动容器）', n === 2, String(n))
  /* ⚠️ **骨架里的边界必须带 key，且 key 是板块 id**（2026-10-21 板块重构）。
   *
   * 为什么这条与画布那条相反：骨架是**同一处代码渲染不同板块**，不换 key 的话
   * React 会复用同一个边界实例 —— 于是「A 板块抛错 → 切到 B 板块 → B 也显示 A 的错误」，
   * 用户会以为修好的那一块还是坏的。key 取板块 id 正好：同一板块内身份稳定（不重建），
   * 换板块时换实例（错误状态不串味）。
   *
   * 画布那层**不能**带 key：画布常驻挂载，换身份会把整张图的节点/连线状态全丢掉。 */
  check('★ 骨架里两处边界都带 key（换板块时错误状态不串味）',
    (s.match(/h\(ErrorBoundary, \{\s*(\/\*[\s\S]*?\*\/\s*)?key:/g) ?? []).length === 2,
    String((s.match(/h\(ErrorBoundary, \{\s*(\/\*[\s\S]*?\*\/\s*)?key:/g) ?? []).length))
  check('★ 那个 key 是板块 id（不是随机数/下标）',
    /h\(ErrorBoundary, \{ key: b\.id,/.test(s) && /key: board\.id,/.test(s))
  const wb = src('src/client/workbench/WorkflowBoard.tsx')
  check('★ 画布那层边界**没有**写 key（否则画布状态丢）',
    !/h\(ErrorBoundary,\s*\{[^}]*key:/.test(wb))
}

console.log('=== ④ 兜底界面不依赖画布那套样式（它得在画布坏掉时也能看）===')
{
  const s = src('src/client/workbench/ErrorBoundary.tsx')
  check('★ 只用 dsw 主题令牌（不引画布 token）', !/canvas-tokens\.module\.css/.test(s))
  check('★ 不引 workflow-canvas 的样式表', !/workflow-canvas\.module\.css/.test(s))
  const cssText = src('src/client/workbench/error-boundary.module.css')
  check('用了主题令牌（--dsw-alias-*）', cssText.includes('--dsw-alias-label-primary'))
  check('★ 没有写死颜色（主题切换时不能瞎）', !/#[0-9a-fA-F]{6}/.test(cssText.replace(/\/\*[\s\S]*?\*\//g, '')))
}

console.log('')
console.log('=== ⑤ 真的抛一次（不只看源码）===')
{
  /* ## 为什么必须有这一段
   *
   * 上面 ①~④ 全在查源码 —— 而「包了但没生效」是最常见的假绿形态：
   * 包在永远不抛的那一层、被条件渲染跳过、或者 `getDerivedStateFromError`
   * 写了却没返回状态。只有**真让子树抛一次**再看 DOM，才证明它真的接住了。
   *
   * 用 jsdom + react-dom/client，与 `dom-render` 同一套环境补丁。 */
  const { createRequire } = await import('node:module')
  const require = createRequire(import.meta.url)
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true, url: 'http://localhost/',
  })
  const { window } = dom
  globalThis.window = window
  globalThis.document = window.document
  try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }) } catch { /* 只读则跳过 */ }
  globalThis.HTMLElement = window.HTMLElement
  globalThis.Element = window.Element
  globalThis.Node = window.Node
  globalThis.getComputedStyle = window.getComputedStyle
  globalThis.requestAnimationFrame = window.requestAnimationFrame
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame
  globalThis.ResizeObserver = window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }

  const React = require('react')
  const { createRoot } = require('react-dom/client')
  const { act } = React

  /* 直接用**源码**（tsx loader 已由 run-tests 按 import 判据加上）。 */
  const { ErrorBoundary } = await import('../src/client/workbench/ErrorBoundary.tsx')

  /** 一个会抛错的组件（模拟「画布里某一行算错了」）。 */
  const Boom = () => { throw new Error('画布里有一行算错了：item.url') }
  /** 正常组件。 */
  const Fine = () => React.createElement('div', { id: 'fine' }, '我还活着')

  /* React 打 console.error 是正常的（边界就是在「有人报错」时工作），这里压掉免得刷屏。 */
  const origErr = console.error
  console.error = () => {}

  /** 一次开关（让「重试」按钮真的有效果）。 */
  let boom = true
  const Switch = () => (boom ? React.createElement(Boom) : React.createElement(Fine))

  const doc = window.document
  const root = createRoot(doc.getElementById('root'))
  await act(async () => {
    root.render(React.createElement(ErrorBoundary, {
      name: '画布',
      onEscape: () => { doc.body.setAttribute('data-escaped', '1') },
    }, React.createElement(Switch)))
  })

  const box = doc.querySelector('[data-ewb-error-boundary]')
  check('★★ 子树抛错后边界接住了（DOM 里有兜底界面）', box !== null)
  check('★★ 界面上说得出错在哪一句', (doc.querySelector('[data-ewb-error-msg]')?.textContent ?? '').includes('item.url'),
    (doc.querySelector('[data-ewb-error-msg]')?.textContent ?? '').slice(0, 60))
  check('★ 标题里有边界名（能定位是哪块坏的）', (box?.textContent ?? '').includes('画布'))
  check('★ 明说「数据未损坏」', (box?.textContent ?? '').includes('数据未损坏'))

  /* 点「重试」—— 这次子树正常了，应该换回正常内容。 */
  const retry = doc.querySelector('[data-ewb-error-retry]')
  check('有「重试」按钮', retry !== null)
  boom = false
  await act(async () => { retry?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  check('★★ 点重试之后子树真的回来了', doc.getElementById('fine') !== null)
  check('★ 兜底界面退场了', doc.querySelector('[data-ewb-error-boundary]') === null)

  /* 「退回列表」那条路。 */
  boom = true
  await act(async () => { root.render(React.createElement(ErrorBoundary, { name: '画布', onEscape: () => { doc.body.setAttribute('data-escaped', '1') } }, React.createElement(Switch))) })
  const esc = doc.querySelector('[data-ewb-error-escape]')
  check('有「退出去」按钮', esc !== null)
  await act(async () => { esc?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  check('★★ 点了它会真的退出去（回调被调用）', doc.body.getAttribute('data-escaped') === '1')

  console.error = origErr
  await act(async () => { root.unmount() })
}

console.log('')
console.log(failed === 0 ? '结论：错误边界接对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
