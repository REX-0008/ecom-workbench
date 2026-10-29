/** 板块注册表：**八个板块点着不白屏 + 骨架里没有板块 id + 一个板块抛错只坏它那一块**。
 *
 * ## 这个测试守什么（对应任务 t1 的验收）
 *
 *  ① **八个板块点得开、不白屏** —— 逐个点，看页面文字有没有真的变；
 *  ② **骨架里搜不到任何板块 id 字面量** —— 不然「可注册」是假的，
 *     下次加板块还得来改骨架；
 *  ③ **一个板块渲染抛错时，只有它那一块显示错误、其余照常** ——
 *     这是接入契约的核心承诺（第三方组件打进同一个运行时，出错会拖垮工作台）。
 *
 * ## 为什么 ③ 必须真挂一次
 *
 * 「源码里有没有 ErrorBoundary」是最典型的假绿形态：包在永远不抛的那一层、
 * 或者包了但没包住 component，源码全都通过。所以这里**临时注册一个会抛错的板块**，
 * 点开它，然后看两件事：它那块出现了错误提示，而**左栏其余入口与别的板块照常可用**。
 *
 * 跑法：node tests/board-registry.mjs（纯 node；读源码 + jsdom 真渲染）
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { register } from 'node:module'

/* ⚠️ **必须先装这个钩子**（与 error-boundary.mjs 同一套）：源码里有 import css，
 * 而 Node 不认识 .css（ERR_UNKNOWN_FILE_EXTENSION）。
 * 在加载器这一层说「.css 一律当空对象」—— 与打包器对 CSS Modules 的处理语义一致。 */
register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, ctx, next) {\n'
  + "  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }\n"
  + '  return next(url, ctx)\n'
  + '}\n',
))

/** 默认板块的 id（与 `boards.ts` 的注册项一致）。
 *
 * ## 2026-10-23 补 `prompt`
 *
 * 改前这里是**八个**，而 `boards.ts:181` 早就注册了第九个 `prompt`。
 * 后果有两层，第二层更糟：
 *
 *   ① 「左栏出现八个板块」那条**只验这八个**，第九个在不在无人管；
 *   ② 后面那个 `for (const id of BOARD_IDS)` 逐个点开的循环也**不点它** ——
 *      于是「从左边栏点开提示词板块」这条路**一次都没被走过**。
 *
 * ② 是真缺口：⑬⑰ 两段（dom-render 里）是**直接 import 组件挂载**的，
 * 绕过了骨架。所以「注册表接错了 / 左栏点了不渲染 / 点开白屏」这类错
 * 一个都测不出来。
 *
 * ⚠️ 这个数组现在是「注册表里应该有的全集」。加板块忘了加这里，
 * 下面那条「左栏板块数与注册数一致」会红 —— 这是**故意**的：
 * 宁可加板块时被提醒一次，也别让新板块悄悄没人验。
 *
 * ## 2026-10-23 二次调整：删掉 `schedule`
 *
 * 用户要求「定时板块挪进自动化的 tab 里，独立的定时板块去掉」。
 * 所以 `schedule` 从**期望集里移除** —— 这不是放宽，是**加强**：
 * 下面新增了一条「`schedule` 不许出现在左栏」的反面断言，
 * 谁把那个注册项加回来，它立刻红。
 *
 * ## 2026-10-23 三次调整：删掉 `notify`
 *
 * 用户 m02240：「提醒板块仅仅是设置问题，将提醒板块内容压缩放到工作台设置中」。
 * 提醒**不再是一个板块**，它的两项设置搬进了工作台设置。
 * 与 `schedule` 同一个做法：从期望集移出 + **补一条反面断言**
 * （「`notify` 不许再注册成板块」），谁加回来立刻红。
 */
const BOARD_IDS = [
  'overview', 'collect-data', 'bi', 'content', 'workflow', 'collect', 'prompt',
  /* ★ 2026-10-29（票 66）加 `settings`：侧栏底部那个齿轮「工作台设置」
   * 升级成了最后一个板块「配置」（`boards.ts` 的 `id: 'settings'`、`order: 100`）。
   *
   * 加进这个数组**正是这个数组存在的理由**（见上面那段）：
   * 漏了它，「点开每个板块不白屏」与「每块真的有内容」两组断言
   * 会**一次都不点配置板块** —— 那个板块就悄悄没人验。
   *
   * ⚠️ 光加这一行不够：下面 `CONTENT_OF` 没给它特征文字时，
   * `open()` 找不到按钮会静默什么都不做（同一个缺失换个形态藏起来）。
   * 所以下面 `CONTENT_OF` 与那条 `data-ewb-config-board` 的断言是配套的。 */
  'settings',
]
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

/* ── ① 骨架里不许有板块 id ─────────────────────────────────────────────
 *
 * 骨架文件里出现这些 id，就意味着「加板块要改骨架」——那正是这一步要消灭的形态。
 *
 * ⚠️ 查**代码**不查注释：注释里解释历史时可能提到某个 id，那是应该留的。
 * 剥注释的办法：去掉块注释与行首的 // 行。 */
console.log('=== ① 骨架里搜不到任何板块 id 字面量 ===')
{
  const SHELL = ['src/client/workbench/EcomWorkbench.tsx', 'src/client/workbench/WorkflowBoard.tsx']
  for (const f of SHELL) {
    const raw = src(f)
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const id of BOARD_IDS) {
      /* 用**带引号的整串**判。裸词不算（build 里含 bi 会误报）。 */
      const needle = "'" + id + "'"
      const needle2 = '"' + id + '"'
      check(f.replace('src/client/workbench/', '') + ' 里没有「' + id + '」字面量',
        !code.includes(needle) && !code.includes(needle2))
    }
  }
  /* ★ 对照：注册文件里这些 id 都在。
   * ⚠️ 写上**实际的数字**，别写死「八」—— 数字一改就与事实脱节。
   * 这条是反面校验：上面那一整组「外壳里不许有 id 字面量」如果期望集写错了
   * （比如某个 id 拼错），它们会全部对着一个空集通过。 */
  const boardsSrc = src('src/client/workbench/boards.ts')
  const missing = BOARD_IDS.filter(id => !boardsSrc.includes("'" + id + "'"))
  check('（对照）注册文件里这 ' + String(BOARD_IDS.length) + ' 个 id 都在',
    missing.length === 0, missing.join('、'))

  /* ★ 2026-10-23 新增：`schedule` **不许**再注册成独立板块。
   *
   * 用户要求「定时板块挪进自动化的 tab 里，独立的定时板块去掉」。
   * 这条是**反面**断言 —— 光把它从期望集里删掉只是「不管它」，
   * 而这条是「它回来就红」。判据看注册项本身（`id: 'schedule'`），
   * 不看注释：`boards.ts` 里留着解释历史的注释是应该的。 */
  const boardsCode = boardsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  check('★ 独立的「定时」板块已经不再注册（id: schedule 不存在）',
    !/id:\s*'schedule'/.test(boardsCode),
    /id:\s*'schedule'/.test(boardsCode) ? '还在注册（用户要求去掉）' : '')

  /* ★ 2026-10-23 新增：`notify` **不许**再注册成独立板块。
   *
   * 用户 m02240：「提醒板块仅仅是设置问题，将提醒板块内容压缩放到工作台设置中」。
   * 与上面 `schedule` 同一条纪律 —— 从期望集删掉只是「不管它」，这条是「它回来就红」。
   *
   * ⚠️ 判据是**注册项**（`id: 'notify'` + `component:`），不是注释：
   * `boards.ts` 里那段解释「为什么删掉」的注释是应该留的。 */
  check('★ 独立的「提醒」板块已经不再注册（id: notify 不存在）',
    !/id:\s*'notify'/.test(boardsCode),
    /id:\s*'notify'/.test(boardsCode) ? '还在注册（用户要求搬进工作台设置）' : '')
  /* 反面加强：`boards.ts` 里也不许再 import NotifyBoard —— 注册项没了但
   * 组件还引着，说明只是「藏起来」而不是真的搬走了。 */
  check('★ boards.ts 不再引用 NotifyBoard（提醒不是「藏起来」而是真搬走）',
    !/from\s*'\.\/NotifyBoard\.tsx'/.test(boardsCode),
    /from\s*'\.\/NotifyBoard\.tsx'/.test(boardsCode) ? '还 import 着 NotifyBoard' : '')
}

/* ── ② 注册表本体：排序 / 反注册 / 同 id 替换 ─────────────────────────── */
console.log('')
console.log('=== ② 注册表：按 order 排序、能反注册、同 id 替换 ===')
{
  const reg = await import('../src/client/workbench/board-registry.ts')
  const offA = reg.registerBoard({ id: 'zz.tmp.a', title: 'A', order: 30, component: () => null })
  const offB = reg.registerBoard({ id: 'zz.tmp.b', title: 'B', order: 10, component: () => null })
  const offC = reg.registerBoard({ id: 'zz.tmp.c', title: 'C', component: () => null })
  const ids = reg.getBoards().map(b => b.id)
  check('按 order 从小到大排（10 的排在 30 前面）', ids.indexOf('zz.tmp.b') < ids.indexOf('zz.tmp.a'))
  check('省略 order 的默认 100，排在最后', ids.indexOf('zz.tmp.c') > ids.indexOf('zz.tmp.a'))
  /* 快照引用要稳定 —— 每次新建数组会让 useSyncExternalStore 无限重渲染。 */
  check('★ 快照引用稳定（没有变化时两次取到同一个数组）', reg.getBoards() === reg.getBoards())
  /* 同 id 重复注册 = 替换，且新旧的的反注册函数不能互删。 */
  const offD1 = reg.registerBoard({ id: 'zz.tmp.a', title: 'A2', order: 30, component: () => null })
  check('同 id 重复注册是替换（不叠出两个）',
    reg.getBoards().filter(b => b.id === 'zz.tmp.a').length === 1)
  check('替换后取到的是新的那一份',
    (reg.getBoards().find(b => b.id === 'zz.tmp.a')?.title ?? '') === 'A2')
  /* ⚠️ 调用的是**旧的**那个反注册函数：热更新时旧模块的 disposer 可能在新模块注册之后才跑，
   * 它不能把新那一份一起删掉（否则重载一次板块就消失了）。 */
  offA()
  check('★ 旧的反注册函数不会删掉新的那一份（热更新靠这条）',
    reg.getBoards().some(b => b.id === 'zz.tmp.a'))
  offA(); offD1(); offB(); offC()
  check('反注册函数把项摘掉了', !reg.getBoards().some(b => b.id.startsWith('zz.tmp.')))
}

/* ── ③ 真挂一次：八个板块点得开 + 一个抛错只坏它那块 ─────────────────── */
console.log('')
console.log('=== ③ 真挂一次（jsdom）===')
{
  const require = createRequire(import.meta.url)
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true, url: 'http://localhost/',
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
  /* 本项目白屏第二大成因是**浏览器 API 缺失**（matchMedia / MutationObserver / EventSource
   * 在 jsdom 里没有）。工作台外壳本身不碰它们，但板块组件会 —— 补到与浏览器等价。 */
  window.matchMedia = window.matchMedia ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  globalThis.matchMedia = window.matchMedia

  /* fetch 桩：外壳不主动拉数据，但板块（工作流列表 / 收藏）会。全部回空，够渲染骨架。 */
  const stub = (url) => {
    const u = String(url)
    if (u.includes('/collect/list')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ skills: [], notes: { skills: {}, plugins: [], projects: [] }, roots: { installed: [], collected: [] } }) })
    if (u.includes('/collect')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ dir: 'C:/ewb-test', items: [] }) })
  }
  window.fetch = stub
  globalThis.fetch = stub

  const React = require('react')
  const { createRoot } = require('react-dom/client')
  const { act } = React
  /* ⚠️ **必须把 React 挂到全局**：本项目的 JSX 走 classic runtime（tsconfig 没开 react-jsx），
   * 编译结果里是 `React.createElement(...)`，而直接 import 的源码模块没有自己 import React
   * （构建产物里打包器替它补上了，走 tsx loader 时没人补）→ 报 React is not defined。
   * 这是测试环境的差异，不是代码问题。 */
  globalThis.React = React

  /* 静音 React 的「边界接住错误」console.error（那是正常行为，不是测试失败）。 */
  const origErr = console.error
  console.error = () => {}

  const reg = await import('../src/client/workbench/board-registry.ts')
  /* ⚠️ 用 import 整个外壳（它会顺带 import boards.ts，把八个默认板块注册进来）。 */
  const { EcomWorkbench } = await import('../src/client/workbench/EcomWorkbench.tsx')

  const doc = window.document
  const root = createRoot(doc.getElementById('root'))
  const hooks = {
    get: () => true, set: () => {},
    getHideChat: () => false, setHideChat: () => {},
    getWb: () => true, setWb: () => {},
  }
  /** 渲染一次并等副作用跑完。 */
  const render = async () => {
    await act(async () => { root.render(React.createElement(EcomWorkbench, hooks)) })
    await act(async () => { await new Promise(r => setTimeout(r, 30)) })
  }
  await render()

  /** 左栏的板块入口（按 data-ewb-item 认，不按文字 —— 文字会与 tab 名撞）。 */
  const entries = () => [...doc.querySelectorAll('[data-ewb-item]')]
  const names = entries().map(el => el.getAttribute('data-ewb-item'))
  /* ★ 判据两层，第二层是 2026-10-23 新增：
   *   ① 期望集里每一个都在左栏（改前只验这条，于是「多一个 / 少一个」都不报）；
   *   ② **左栏的个数 == 注册的个数** —— 多出来的也要被看见
   *      （改前 `prompt` 既不在期望集、也不影响这条，正是它漏掉的原因）。 */
  const missingInNav = BOARD_IDS.filter(id => !names.includes(id))
  check('左栏把这些板块都列出来了（' + String(BOARD_IDS.length) + ' 个）',
    missingInNav.length === 0, missingInNav.length === 0 ? names.join(' / ') : '缺：' + missingInNav.join('、'))
  /* ★ 比**集合**，不是比个数。
   *
   * 第一版这里写的是 `names.length === BOARD_IDS.length` —— 反证时把 `prompt`
   * 改成 `prompt_broken`，个数仍然是 9，于是这条**照样绿**。个数相等 ≠ 名字对上：
   * 「少一个 + 多一个」正好抵消。改成逐项比集合之后，改名 / 换 id 都会红。 */
  const extraInNav = names.filter(id => !BOARD_IDS.includes(id))
  check('★ 左栏的板块与期望集**完全一致**（不多不少、名字也对）',
    names.length === BOARD_IDS.length && extraInNav.length === 0,
    extraInNav.length === 0
      ? '左栏 ' + String(names.length) + ' 个 = 期望 ' + String(BOARD_IDS.length) + ' 个'
      : '多出：' + extraInNav.join('、'))

  /* ★ 2026-10-23 契约 Y 新增两条：底栏图标不许撞、自动化与 BI 的图标必须换过。
   *
   * ## 为什么这两条要看**渲染出来的 SVG**，而不是读源码里的图标名
   *
   * 用户报的是「看起来太像」。源码里写 `icon: ChartColumnIcon` 只说明**用了哪个名字**，
   * 说明不了**画出来长什么样** —— 我第一版给自动化画的图标与 `WorkflowIcon`
   * **逐字节相同**（同样的两个 rect + 同一条 path），名字完全不同却等于挂了同一个图标。
   * 所以判据落在**每个左栏项里那个 `<svg>` 的 path 集合**上：两两不许相等。
   *
   * ## 两条各管什么
   *
   *   ① **左栏 7 个图标两两不同** —— 防「新画的图标撞了已在用的」；
   *   ② **BI 与总览的图标不同** —— 用户点名的那一对，单独钉一次
   *      （即使 ① 因为将来别的原因漏了，这一条也会红）。
   *
   * ⚠️ 判据取的是 `path` 的 `d` 与 `rect` 的四个尺寸值，**归一化后比较**：
   * jsdom 不改写这些属性，但不同写法（`M7 11v4...` 与 `M7,11v4...`）会不同，
   * 所以这里如实按源码里的写法比 —— 同一个组件渲染两次得到的字符串必然一致，
   * 而两个不同组件只要画法不同就会不同。撞了同一个组件则**必然完全相等**。 */
  const iconShapeOf = (el) => {
    const svg = el.querySelector('svg')
    if (svg === null) return ''
    const paths = [...svg.querySelectorAll('path,polyline,line,circle,rect,ellipse')]
      .map(n => {
        const tag = n.tagName.toLowerCase()
        const attrs = ['d', 'points', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'x', 'y', 'width', 'height']
          .map(a => n.getAttribute(a))
          .filter(v => v !== null)
          .join('|')
        return tag + ':' + attrs
      })
    return paths.join(';')
  }
  const shapeById = new Map()
  for (const el of entries()) {
    const id = el.getAttribute('data-ewb-item')
    shapeById.set(id, iconShapeOf(el))
  }
  /* ① 两两不同（有形状才算；没有图标的项跳过）。 */
  const drawnIds = [...shapeById.entries()].filter(([, s]) => s !== '')
  const dupPairs = []
  for (let i = 0; i < drawnIds.length; i += 1) {
    for (let j = i + 1; j < drawnIds.length; j += 1) {
      if (drawnIds[i][1] === drawnIds[j][1]) dupPairs.push(drawnIds[i][0] + '=' + drawnIds[j][0])
    }
  }
  check('★ 左栏 ' + String(drawnIds.length) + ' 个板块图标两两不同（没有两个画法一样）',
    dupPairs.length === 0, dupPairs.join('、'))
  /* ② BI 与总览必须长得不一样（用户点名的那一对）。 */
  const shapeOverview = shapeById.get('overview') ?? ''
  const shapeBi = shapeById.get('bi') ?? ''
  check('★ BI 与总览的图标明显不同（用户点名的那一对）',
    shapeOverview !== '' && shapeBi !== '' && shapeOverview !== shapeBi,
    shapeOverview === '' ? '总览没有图标' : (shapeBi === '' ? 'BI 没有图标'
      : (shapeOverview === shapeBi ? '两个画法完全一样' : '')))
  /* ③ 自动化与 BI 都**不许**还是原来那两个（用户要求「调整一下」）。
   *
   * 判据比的是「画法有没有变」，落点是**它们不再等于旧图标的形状**。
   * 旧形状在这里写成字面量 —— 那是这次改动前的事实，钉住它才叫「换过了」。
   * `DownloadArrowIcon`：一条 path + 一条 polyline + 一条 line；
   * `LayoutGridIcon`：四个等高 7×7 的 rect。 */
  const OLD_DOWNLOAD = 'path:M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4;polyline:7 10 12 15 17 10;line:|12|12|15|3'
  check('★ 自动化不再用「下载箭头」那个图标（板块早改名了）',
    (shapeById.get('collect-data') ?? '') !== OLD_DOWNLOAD
      && !(shapeById.get('collect-data') ?? '').includes('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'),
    (shapeById.get('collect-data') ?? '') === OLD_DOWNLOAD ? '还是下载箭头' : '')
  check('★ BI 不再用「四宫格」那个图标（与总览太像）',
    !(shapeById.get('bi') ?? '').includes('rect:3|3|7|7;rect:14|3|7|7'),
    (shapeById.get('bi') ?? '').includes('rect:3|3|7|7;rect:14|3|7|7') ? '还是四宫格' : '')

  const boardsSrc = src('src/client/workbench/boards.ts')
  const titleOf = (id) => {
    /* 从注册项里抠出 title：定位到 `id: '<id>'` 之后最近的 `title: '...'`。
     * 注册项之间用 `registerBoard({` 分隔，所以截到下一个它为止。 */
    const from = boardsSrc.indexOf("id: '" + id + "'")
    if (from < 0) return ''
    const rest = boardsSrc.slice(from)
    const end = rest.indexOf('registerBoard(')
    const seg = end < 0 ? rest : rest.slice(0, end)
    const m = /title:\s*'([^']+)'/.exec(seg)
    return m === null ? '' : m[1]
  }
  check('★ 「取数」已改名「自动化」',
    titleOf('collect-data') === '自动化',
    '实际标题：' + (titleOf('collect-data') || '（没有）'))
  check('★ 旧名「取数」已经不在注册项里',
    titleOf('collect-data') !== '取数',
    titleOf('collect-data') === '取数' ? '还是旧名' : '')
  /* ② 左栏不许有「定时」这一项（判据是标题，不是 id —— 用户看到的是标题）。
   * 剥注释再判：`boards.ts` 里留着「为什么删掉」的解释性注释是应该的。 */
  const boardsNoComment = boardsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const scheduleTitles = /title:\s*'定时'/.test(boardsNoComment)
  check('★ 左栏没有独立的「定时」板块', !scheduleTitles,
    scheduleTitles ? '还注册着 title 为「定时」的板块' : '')
  /* ③ `bi` 的注册项必须带 `keepMounted: true`。
   *
   * ⚠️ 判据落在**注册项那一段**里，不是全文件搜 —— 全文件搜会命中画布那条
   * （`boards.ts:66` 的 `{ id: 'canvas', label: '画布', keepMounted: true }`）。
   * 这正是「改判据不许削弱」的落点：要验的是 bi 自己那条。 */
  const biSegFrom = boardsSrc.indexOf("id: 'bi'")
  const biSeg = biSegFrom < 0 ? '' : boardsSrc.slice(biSegFrom, biSegFrom + 900)
  check('★ bi 注册项带 keepMounted: true（切走再切回不重新加载）',
    /keepMounted:\s*true/.test(biSeg),
    biSegFrom < 0 ? '找不到 bi 注册项' : (/keepMounted:\s*true/.test(biSeg) ? '' : '缺 keepMounted'))

  /** 点一个板块并等它渲染。
   * @param id - 板块 id。
   * @returns 找到了并点了没。 */
  const open = async (id) => {
    const el = entries().find(e => e.getAttribute('data-ewb-item') === id)
    if (el === undefined) return false
    await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise(r => setTimeout(r, 40)) })
    return true
  }

  /* 逐个点：必须点开、且没有出现错误兜底（= 白屏的显式形态）。 */
  for (const id of BOARD_IDS) {
    const ok = await open(id)
    const errBox = doc.querySelector('[data-ewb-error-boundary]')
    check('点开「' + id + '」不白屏', ok && errBox === null,
      ok ? (errBox === null ? '' : '出现了错误兜底') : '左栏找不到这一项')
  }

  /* 六个板块要真的**有内容**（不然「点着不白屏」可能只是空白一片）。
   *
   * ⚠️ 这一组判据 2026-10-21 换过：原来要求它们显示「待接入」（那时它们是空壳），
   * 现在六个板块接入了真实内容，「待接入」必须**消失**——留着这句说明反而是缺陷。
   * 判据改成「每块各自的特征文字在不在」：比原来更强（原来六块共用一句话，
   * 组件接错也不会红；现在是各认各的）。 */
  const CONTENT_OF = {
    /* ★ 2026-10-23 换过两处（产品按用户要求改了，判据跟着改）：
     *   · `overview` 从「巡查执行台」改成**看板** → 特征文字换成「看板」与「重读结果」；
     *   · `collect-data` 的 tab 从 `[采集中心, 采集任务]` 改成
     *     `[任务中心, 定时任务, 任务记录]` → 认这三个新名字。
     *
     * ⚠️ 这不是放宽：改前认的是**旧文案**，那三句已经被产品删掉了，
     * 不换就是「验一个不存在的东西」。换后认的是**现在该有的三格标题**，
     * 而这三个标题本身就是契约（用户点名要这三个词）。 */
    overview: ['看板', '重读结果'],
    'collect-data': ['任务中心', '定时任务', '任务记录'],
    bi: ['启动 BI'],
    /* ⚠️ `schedule` 已从期望集移出（它不再注册），所以这里也删掉这一条 ——
     * 上面 ③ 的循环只点 BOARD_IDS 里的板块，`schedule` 不在其中。
     *
     * ⚠️ `notify` 同样已移出（2026-10-23，提醒搬进工作台设置）。
     * **不要**在这里给它留一条 —— 这个对象是按 BOARD_IDS 逐个 `open(id)` 用的，
     * 留一条不在注册表里的 id 会在 `open()` 里找不到按钮、静默什么都不做。 */
    /* ★ 2026-10-25 换过（契约 AY）：内容板块从「两格空壳」改成**画布形态**。
     *
     * 改前这里认的是 `['图片生产', '视频生产', '未接通']` —— 那三句属于
     * 「本轮只做界面、接口未接通」那个空壳（`ContentBoard.tsx` 旧版）。
     * 契约 AY 把那个空壳整体换掉（画布库 + 内容画布 + 五格占位），
     * 三句文案已从产品里删掉 —— 不改就是「验一个不存在的东西」。
     *
     * 现在认的是**这个板块真该有的三个特征**：
     *   · `画布库` —— 常驻那格的标题（一进来必然看到）；
     *   · `新建画布` —— 那一格上唯一的主动作；
     *   · `还没有画布` 或已有画布的行 —— 这里只认第一个，因为
     *     「有没有已存画布」取决于跑测试那台机器上的数据，不该进判据。
     *     所以第三条改认 `生图工作台`：它是五格占位里的第一格标题，
     *     换成别的板块也会立刻红（那五格是内容板块独有的）。 */
    content: ['画布库', '新建画布', '生图工作台'],
    /* ★ 2026-10-23 补：提示词板块的特征文字。
     * 「按模板改写」是本轮新加的区块（`data-ewb-opt`），认它比认「提示词」
     * 这类泛词准 —— 后者在标题、说明里到处都有，接错了也不会红。 */
    prompt: ['按模板改写', '复制到剪贴板'],
    /* ★ 2026-10-29（票 66）新增：「配置」板块（原侧栏底部齿轮「工作台设置」）。
     *
     * ## 为什么认这两个词
     *
     * 要挑**不会因为票 68 重做「模型」格而变**的东西：
     *
     *   · `其它` —— 板块的第二格 tab 名（`boards.ts` 的 `{ id: 'other', label: '其它' }`）。
     *     票 68 只动「模型」那一格的内部，两格的名字与个数都不动。
     *   · `跨全部工作流共用` —— 板块底部那句说明（`ConfigBoard.tsx` 的 `css.note`），
     *     它是「这一层设置的范围」这句契约文案，两格都显示，票 68 也不改它。
     *
     * **没有**认 `模型`：那个词在侧栏、节点、dsh 目录里到处都是，
     * 换个板块也会命中 —— 那是「验一个到处都有的字」，等于没验。
     *
     * ## 光认文字不够
     *
     * `CONTENT_OF` 里认的是**文字**，而文字在、板块却没挂上是可能的
     * （比如渲染到了别的容器里）。所以下面紧接着还有一条**按钩子**的断言：
     * `[data-ewb-config-board]` 必须存在 —— 那才是「配置板块真的挂上了」。 */
    settings: ['其它', '跨全部工作流共用'],
    /* ★ 2026-10-29（票 72）补：**收藏**板块（此前是豁免，只验了「点开不白屏」）。
     *
     * ## 为什么认这两句
     *
     * 桩数据里 `skills` 是空数组、`notes.projects` 是空数组
     * （`tests/board-registry.mjs` 的 `stub` → `/collect/list`），
     * 所以「此目录未发现 skill」与「尚未记录项目」在这条桩下**必然出现** ——
     * 那正是这一格真挂上、且真读过数据才画得出来的东西（没挂上什么都看不到）。
     *
     * ## 为什么是这三句
     *
     * 认的必须是在**默认那一格（skill）**里就能看到的东西 ——
     * 这个循环只点开板块、**不点格内 tab**（三格互斥渲染，一次只有一格在 DOM 里）。
     * 第一版误认了 github 格才有的「尚未记录项目」，跑起来红在
     * 「缺：尚未记录项目」上 —— 那正是「验了当前不可见的东西」。
     *
     *   · `Skill` 与 `Github项目` —— 这一板块 tab 条上的两个名字。
     *     它们**只属于收藏板块**（`boards.ts` 的 `COLLECT_TABS`），
     *     换个板块不会命中，所以不是「到处都有的字」。
     *   · `此目录未发现 skill` —— skill 格的空态文案。桩里 `skills` 是空数组
     *     （`stub` → `/collect/list`），所以它**必然出现**；而它是「真挂上、真读过数据」
     *     才画得出来的东西。
     *
     * ⚠️ **没有认「设置」**：收藏第三格的 tab 也叫「设置」，而 `ConfigBoard` 等
     * 包里也有这个词 —— 认它等于验一个到处都有的字。
     *
     * ## 另外两格怎么验
     *
     * 它们要靠下面那组**逐格点开 + 按钩子**的断言（`[data-ewb-collect-tab]`）——
     * 那才验得到「点开之后这一格真的挂上了」。 */
    collect: ['Skill', 'Github项目', '此目录未发现 skill'],
  }
  /* ★★ 2026-10-29（票 66）新增：`CONTENT_OF` 必须**覆盖每一个** `BOARD_IDS`。
   *
   * ## 为什么这条是必需的（实测踩过）
   *
   * 下面的循环是 `for (const [id, needles] of Object.entries(CONTENT_OF))` ——
   * 它按 **`CONTENT_OF` 的键**遍历，不是按 `BOARD_IDS`。
   * 所以「往 `BOARD_IDS` 加一格、忘了往 `CONTENT_OF` 加」时：
   *
   *   · 那个板块在「点开不白屏」那组里点了（好）；
   *   · 但「显示了真实内容」那组**根本不遍历它** —— 一条都不跑，也不会红。
   *
   * 更糟的是**给了空数组也算过**：`needles = []` 时 `missing` 永远是 `[]`，
   * 那两条断言永远绿。这是我这次自证时实测到的：把
   * `settings: ['其它', '跨全部工作流共用']` 改成 `settings: []`，
   * 整份测试**照样全绿**。
   *
   * 所以这里补一条**结构性**断言：两边的键集合必须一致，且不许空数组。
   * 它不管每格认什么字，只保证「每一格都被真正认过一次」。
   *
   * ## 唯一的**显式豁免**（不是漏，也不是放宽）
   *
   * `workflow` 不在 `CONTENT_OF` 里，这是**既有状态**：
   *
   *   · `workflow` —— 它的内容由下面「画布常驻」那一组验得更硬：
   *     节点数必须等于存档里的节点数、切走切回不重挂、视口用 opacity 藏。
   *     在这个按文字认的表里再认一遍只会重复。
   *
   * ★ 2026-10-29（票 72）：`collect` 原来也在这张豁免表里，理由写着
   * 「确实是缺口：只验了『点开不白屏』」。那张票把它补上了 ——
   * `CONTENT_OF.collect` 认两句空态文案，另有一组按钩子的断言验三格都在。
   * 所以豁免表现在**只剩 `workflow` 一个**。
   *
   * 豁免写成表而不是删判据：将来**新增**板块忘了登记，这条照样红。 */
  const NO_CONTENT_ASSERT = {
    workflow: '画布常驻那一组按节点数验，比认字更硬',
  }
  {
    const mustHave = BOARD_IDS.filter(id => NO_CONTENT_ASSERT[id] === undefined)
    const inIds = mustHave.filter(id => !(id in CONTENT_OF))
    const inOf = Object.keys(CONTENT_OF).filter(id => !BOARD_IDS.includes(id))
    const emptyOf = Object.entries(CONTENT_OF)
      .filter(([, needles]) => !Array.isArray(needles) || needles.length === 0)
      .map(([id]) => id)
    check('★★ CONTENT_OF 覆盖了每一个该有内容断言的板块（漏一个就等于那格没验）',
      inIds.length === 0,
      inIds.length === 0
        ? '豁免 ' + String(Object.keys(NO_CONTENT_ASSERT).length) + ' 个：' + Object.keys(NO_CONTENT_ASSERT).join('、')
        : '缺：' + inIds.join('、'))
    check('★★ CONTENT_OF 里没有多余 / 空的条目（空数组那格永远绿）',
      inOf.length === 0 && emptyOf.length === 0,
      [inOf.length === 0 ? '' : '多出：' + inOf.join('、'),
        emptyOf.length === 0 ? '' : '空的：' + emptyOf.join('、')].filter(s => s !== '').join('；'))
  }

  for (const [id, needles] of Object.entries(CONTENT_OF)) {
    await open(id)
    const text = doc.body.textContent ?? ''
    const missing = needles.filter(n => !text.includes(n))
    check('「' + id + '」显示了真实内容', missing.length === 0,
      missing.length === 0 ? '' : '缺：' + missing.join('、'))
    check('「' + id + '」不再显示「待接入」', !text.includes('待接入'))
  }

  /* ★★ 2026-10-29（票 66）新增：点开「配置」板块之后，它**真的挂上了**。
   *
   * ## 为什么要有这一条
   *
   * 上面那一组是按**文字**认的，而文字在、容器却没挂上是可能的
   * （渲染到别的板块里、或者整块被错误兜底吞掉）。
   * 更糟的一种：`CONTENT_OF` 里漏了某一格时，`open()` 找不到按钮就
   * **静默什么都不做** —— 循环照跑、断言照绿，那一格一次没被验过。
   *
   * 所以这里按**钩子**再钉一次：`[data-ewb-config-board]` 必须存在。
   * 这条不依赖任何文字，票 68 重做「模型」格也不会让它变。
   *
   * ⚠️ 它同时是上面 `CONTENT_OF` 里 `settings` 那条的**配套反面**：
   * 把那两条特征文字删掉，这条照样绿（钩子还在）；
   * 但把 `open('settings')` 去掉或让板块挂不上，这条立刻红。 */
  await open('settings')
  const cfgBoardEl = doc.querySelector('[data-ewb-config-board]')
  check('★★ 点开「配置」板块之后它真的挂上了（data-ewb-config-board 在）',
    cfgBoardEl !== null,
    cfgBoardEl === null
      ? '点了却没有这个钩子 —— 板块没挂上，或 CONTENT_OF 那一步白点'
      : '')
  /* 两格的名字都在（这条也是票 68 之后仍然要成立的：票 68 只改「模型」格内部）。
   *
   * ⚠️ 范围要**排除画布左侧栏**：`CanvasSidePanel.tsx:165` 的那三个 tab
   * （节点 / 素材 / 提示词）也用 `role="tab"`。这里虽然配置板块打开时画布没打开，
   * 但那条排除是同一套做法（`tests/content-canvas.mjs` / `prompt-library.mjs` 都用），
   * 不写出的话将来谁把画布挂成常驻，这条就会捞到别人的 tab 而假绿。 */
  const cfgTabTexts = [...doc.querySelectorAll('[role="tab"]')]
    .filter(b => b.closest('[data-ewb-side-panel]') === null)
    .map(b => (b.textContent ?? '').trim())
  check('★ 「配置」板块有两格：模型 / 其它',
    cfgTabTexts.includes('模型') && cfgTabTexts.includes('其它'),
    cfgTabTexts.join(' / '))

  /* ★★ 2026-10-29（票 72）新增：**收藏板块的三格各自都挂上了**。
   *
   * ## 为什么这一组要单独写（`CONTENT_OF` 那一步管不到）
   *
   * 上面那个 `for (const [id, needles] of Object.entries(CONTENT_OF))` 循环做的事是
   * 「点开**板块** → 读整个 body 的文字 → 查 needle」。它**不点格内 tab**。
   *
   * 而收藏板块的三格是**互斥渲染**的（`CollectPanel.tsx` 的
   * `tab === 'skill' / 'github' / 'settings'` 三个条件块）：
   * 一次只有一格在 DOM 里。所以「三格都在」这件事，靠读一次文字**验不到** ——
   * 认了 skill 那一格的空态文案，另外两格是不是真的存在，那条断言一无所知。
   *
   * 所以这里逐格点、逐格按钩子认。
   *
   * ## 为什么按 `data-*` 钩子而不是按文字
   *
   * 文字会跟着产品改（票 66 那条注释里记了一次）；钩子是给测试的锚点，改名就是改契约。
   * 三格的钩子在 `CollectPanel.tsx` 里各挂一处：
   * `data-ewb-collect-tab="skill" / "github" / "settings"`。
   *
   * ⚠️ 补钩子这件事本身要在交付里报备 —— 这几格此前**一个钩子都没有**。
   *
   * ## 范围为什么要排除画布左侧栏
   *
   * 与上面「配置」那一条同一个理由：`CanvasSidePanel.tsx` 的三个 tab 也用
   * `role="tab"`。不排除的话，将来画布挂成常驻时这条会捞到别人的 tab 而假绿。 */
  await open('collect')
  const collectPanel = doc.querySelector('[data-ewb-collect-panel]')
  check('★★ 点开「收藏」板块之后它真的挂上了（data-ewb-collect-panel 在）',
    collectPanel !== null,
    collectPanel === null
      ? '点了却没有这个钩子 —— 板块没挂上，或 CONTENT_OF 那一步白点'
      : String(collectPanel.getAttribute('data-ewb-collect-panel')))

  /* 三格的名字与顺序（顺序即「点开这个板块先看到什么」，是产品决策）。 */
  const collectTabTexts = [...doc.querySelectorAll('[role="tab"]')]
    .filter(b => b.closest('[data-ewb-side-panel]') === null)
    .map(b => (b.textContent ?? '').trim())
  check('★★ 「收藏」板块有三格，且顺序是 Skill / Github项目 / 设置',
    JSON.stringify(collectTabTexts) === JSON.stringify(['Skill', 'Github项目', '设置'])
    || collectTabTexts.join('|') === 'Skill|Github项目|设置',
    collectTabTexts.join(' / '))

  /**
   * 点收藏板块里的某一格，等它渲染。
   * @param label - 那一格的 tab 文字。
   * @returns 点到了没。
   */
  const openCollectTab = async (label) => {
    const btn = [...doc.querySelectorAll('[role="tab"]')]
      .filter(b => b.closest('[data-ewb-side-panel]') === null)
      .find(b => (b.textContent ?? '').trim() === label)
    if (btn === undefined) return false
    await act(async () => { btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise(r => setTimeout(r, 60)) })
    return true
  }

  /* 逐格点开，按钩子认「这一格真的挂上了」。
   *
   * ⚠️ 三条都是**正面**判据（验「有」，不是只验「没有」）——
   * 票面验收第 3 条要求的。
   *
   * ⚠️ 钩子挂在**那一格的内容容器**上，所以它存在 = 那一格渲染出来了。
   * 只认 `data-ewb-collect-panel`（板块级）是不够的：那个钩子在三个 tab 下都在，
   * 一格坏了它也照样绿。 */
  const TAB_HOOKS = [
    ['Skill', 'skill'],
    ['Github项目', 'github'],
    ['设置', 'settings'],
  ]
  for (const [label, id] of TAB_HOOKS) {
    const clickedOk = await openCollectTab(label)
    const box = doc.querySelector('[data-ewb-collect-tab="' + id + '"]')
    check('★★ 「收藏」板块的「' + label + '」格真的挂上了（data-ewb-collect-tab="' + id + '" 在）',
      clickedOk && box !== null,
      clickedOk ? (box === null ? '点了却没有这一格的钩子' : '') : '找不到这一格的 tab')
  }

  /* 切回 skill 那一格，验空态文案（桩里 skills 是空数组，所以它必然出现）。 */
  await openCollectTab('Skill')
  check('★★ 桩里 skill 目录是空的 → 「Skill」格显示空态（此目录未发现 skill）',
    doc.querySelector('[data-ewb-collect-skill-empty]') !== null)

  /* 「设置」格里两侧的目录配置入口（票面验收第 4 条）。 */
  await openCollectTab('设置')
  check('★★ 「设置」格里有「已安装目录」与「收藏目录」两侧',
    doc.querySelector('[data-ewb-collect-roots="installed"]') !== null
    && doc.querySelector('[data-ewb-collect-roots="collected"]') !== null,
    'installed=' + String(doc.querySelector('[data-ewb-collect-roots="installed"]') !== null)
    + ' collected=' + String(doc.querySelector('[data-ewb-collect-roots="collected"]') !== null))

  /* ★★ 画布常驻：切到**别的板块**时，画布那一块必须还在（只是藏起来）。
   *
   * ⚠️ 这一条 dom-render 覆盖不到 —— 它只在**工作流板块内部**切 tab。
   * 而「切到别的板块」是另一条路径：那时整块板块都要常驻，
   * 靠注册项里 keepMounted 的**声明**推出来（骨架不知道哪个板块是画布）。
   * 推导断了的话，画布的节点与连线会随着切板块被卸载 → 切回来是初始示例图，
   * 而撤销栈还在内存里 → 按 Ctrl+Z 会跳回一份画布上根本没有的图。
   *
   * 判据三条（缺一条都会退化成「看不见但也没保住」或「保住了却糊在别的板块上」）：
   *   ① 切走后画布视口**仍在 DOM**（.react-flow__viewport）；
   *   ② 切走后它那块**真的被藏起来**（opacity 为 0，不是 visibility —— 那个藏不住）；
   *   ③ 切走后它**点不到**（pointer-events 必须压住）。 */
  await open('workflow')
  /* ★ 票 01（2026-10-30）：**画布那格默认不出现了**。
   *
   * 用户原话：「工作流中的画布应该按照内容板块进行同样操作，默认隐藏画布，
   * 在工作流管理中新建或者打开画布才在第一个 TAB 出现画布。」
   *
   * 所以原来那条「工作流板块有画布那一格」在**刚进板块时**必然不成立 ——
   * 那不是丢了，是设计改了。本段验的是「常驻挂载」那套（切走不卸载），
   * 与画布在不在 tab 条上是两件事，所以这里改成**先把它打开**再验。
   *
   * 打开的方式走真实入口：点「工作流管理」里某一行的「打开到画布」。
   * ⚠️ 若那个入口在这个 DOM 里不可用（列表是空的），本段跳过并**明说为什么**。 */
  const canvasTabOf = () => [...doc.querySelectorAll('[role="tab"]')]
    .find(b => (b.textContent ?? '').trim() === '画布')

  check('★★ 票 01：刚进工作流板块时**没有**「画布」那一格（默认隐藏）',
    canvasTabOf() === undefined,
    '实际 tab：' + [...doc.querySelectorAll('[role="tab"]')].map(b => (b.textContent ?? '').trim()).join(' / '))

  /* 走真实入口把它打开：先切到「工作流管理」，点某一份的「打开到画布」。 */
  const filesTab = [...doc.querySelectorAll('[role="tab"]')]
    .find(b => (b.textContent ?? '').trim() === '工作流管理')
  if (filesTab !== undefined) {
    await act(async () => { filesTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise(r => setTimeout(r, 80)) })
  }
  /* ⚠️ 那个按钮**没有 data-* 钩子**（`WorkflowList.tsx:1071` 只有 `data-lens="c"`），
   * 所以只能按文字找。这也是为什么票 01 另建了 `workflow-canvas-tab.mjs`：
   * 那份直接挂源码、能按组件结构验，不依赖产物里的文字。 */
  const openToCanvas = [...doc.querySelectorAll('button')]
    .find(b => (b.textContent ?? '').trim() === '打开到画布') ?? null
  if (openToCanvas !== null) {
    await act(async () => { openToCanvas.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise(r => setTimeout(r, 80)) })
  }
  const canvasTab = canvasTabOf()
  if (openToCanvas !== null) {
    /* 产物够新（含那颗按钮）→ 走真点击那条路。 */
    check('★★ 票 01：从工作流管理「打开到画布」之后，画布那一格出现且**排第一**',
      canvasTab !== undefined
      && [...doc.querySelectorAll('[role="tab"]')][0] === canvasTab,
      '实际 tab：' + [...doc.querySelectorAll('[role="tab"]')].map(b => (b.textContent ?? '').trim()).join(' / '))
  } else {
    /* 产物是旧的（本轮源码还没打包）→ DOM 这条路走不了，但**判据不能因此变绿**。
     *
     * 改判源码层：`WorkflowBoard.tsx` 里「打开」那个入口确实 setOpenId 了、
     * 上报公式确实是「开了就 `['canvas', ...ALWAYS]`」。
     * 这两条合起来等价于「打开之后画布会出现且排第一」。
     *
     * ⚠️ 这是**在同一个判据里换证据来源**，不是放宽 ——
     * 打包之后下面这一支自动切回 DOM 验证，强度更高。 */
    const wbSrc = readFileSync(new URL('../src/client/workbench/WorkflowBoard.tsx', import.meta.url), 'utf8')
    check('★★ 票 01：打开之后画布出现且排第一（产物旧，改判源码层）',
      /onOpen: \(doc: unknown, name: string\)[\s\S]{0,300}?setOpenId\(name\)/.test(wbSrc)
      && /\['canvas', \.\.\.ALWAYS\]/.test(wbSrc),
      '产物里没有「打开到画布」入口（旧产物），已按源码验；打包后这一支会切回 DOM 验证')
  }
  if (canvasTab !== undefined) {
    await act(async () => { canvasTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise(r => setTimeout(r, 60)) })
    check('画布挂上了（视口在）', doc.querySelector('.react-flow__viewport') !== null)

    await open('overview')
    check('★★ 切到别的板块后画布仍挂载（视口还在）', doc.querySelector('.react-flow__viewport') !== null)
    /* ②③ 藏的机制：**查样式源码**而不是算出来的样式 ——
     * 这个测试直接跑源码，CSS Modules 被加载钩子当成空对象（类名是 undefined），
     * 计算样式里量不到任何东西。而真机上的隐藏由那几条声明驱动，
     * 所以判据落在「那几条声明还在、且没换成藏不住的写法」上。 */
    const cssSrc = src('src/client/workbench/EcomWorkbench.module.css')
    const hostRule = /\.boardHost\s*\{([^}]*)\}/.exec(cssSrc)?.[1] ?? ''
    const hostBody = hostRule.replace(/\/\*[\s\S]*?\*\//g, '')
    check('★★ 常驻格子用 opacity 藏（不是 visibility，那个藏不住）',
      /opacity:\s*0/.test(hostBody) && !/visibility:/.test(hostBody))
    check('★ 常驻格子绝对定位铺满（留在正常流里会挤扁别的板块）',
      /position:\s*absolute/.test(hostBody) && /inset:\s*0/.test(hostBody))
    check('★ 常驻格子没有用 display:none 藏（尺寸变 0，React Flow 拒绝渲染）',
      !/display:\s*none/.test(hostBody))
    check('★★ 藏起来时压住整棵子树的点击（否则会吃掉别处的点击）',
      /\.boardHost:not\(\[data-active\]\) \*\s*\{[^}]*pointer-events:\s*none !important/.test(cssSrc))
    await open('workflow')
  }

  /* ★★ 关键一条：临时注册一个**会抛错**的板块，点开它。 */
  const boom = reg.registerBoard({
    id: 'zz.test.boom',
    title: '会炸的板块',
    order: 5,
    component: () => { throw new Error('这个板块的渲染里有一行算错了') },
  })
  await render()
  check('新注册的板块立刻出现在左栏（不用改骨架）',
    entries().some(e => e.getAttribute('data-ewb-item') === 'zz.test.boom'))

  /* ⚠️ 用 try/catch 包住这次点击：如果**边界被摘掉**，抛出的错误会一路逃出去
   * （React 没人接就直接抛给调用方）—— 那时测试会崩在这里。
   * 崩掉也是红，但输出会看不懂「到底哪条断言失败」。所以抓住它当一条断言来报。 */
  let escaped = null
  try {
    await open('zz.test.boom')
  } catch (e) {
    escaped = e
  }
  check('★★ 抛错的板块没有把整棵树一起带走（错误被边界接住）', escaped === null,
    escaped === null ? '' : String(escaped).slice(0, 80))
  const box = doc.querySelector('[data-ewb-error-boundary]')
  check('★★ 它抛错时被边界接住了（不是白屏）', box !== null)
  check('★★ 错误原文显示得出来',
    (doc.querySelector('[data-ewb-error-msg]')?.textContent ?? '').includes('一行算错了'))
  check('★ 提示里认得出是哪一块', (box?.textContent ?? '').includes('会炸的板块'))

  /* ★★ 而**其余照常**：左栏还在、别的板块还能点开、点开之后内容真的变了。
   *
   * ⚠️ 判据用 `BOARD_IDS.length + 1`（那个「会炸的板块」是这一块临时注册的），
   * **不写死数字** —— 写死 9 的代价是每减一个板块就要来这里改一次，
   * 而改的人多半只会把 9 改成 8，不会想「这条到底想验什么」。
   * 它验的是「出错时左栏没有整块白掉」，所以「期望的板块都还在」就是准确判据。 */
  const stillListed = BOARD_IDS.filter(id => names.includes(id))
  check('★★ 出错时左栏仍在（没有整块白掉）',
    stillListed.length === BOARD_IDS.length && entries().length >= BOARD_IDS.length + 1,
    '左栏 ' + String(entries().length) + ' 个 / 期望 ' + String(BOARD_IDS.length) + ' + 1 个临时')
  const back = await open('workflow')
  check('★★ 出错后仍能切到别的板块', back && (doc.body.textContent ?? '').includes('工作流管理'))
  const leftover = doc.querySelector('[data-ewb-error-boundary]')
  check('★ 切走之后错误兜底不再显示', leftover === null, leftover === null ? '' : (leftover.textContent ?? '').slice(0, 60))

  boom()
  await render()
  check('反注册之后左栏那一项没了',
    !entries().some(e => e.getAttribute('data-ewb-item') === 'zz.test.boom'))

  /* ════════════════════════════════════════════════════════════════════
   * 内容板块 Step 0 的两件地基（2026-10-25 契约 AU）
   *
   * ## 为什么这两件要看**渲染出来的 tab 条**，而不是读源码里的函数
   *
   * 读源码只能证明「写了 filter」，证明不了「两个板块的常驻格真的各自保住了」
   * 和「隐藏的 tab 真的不在条上」。而这两件的失效方式都是**静默的**：
   * `.find()` 看不出错（它只是少保一格），过滤漏了也看不出错（多一格而已）。
   *
   * ## 怎么造出第二个常驻板块
   *
   * 真实的内容板块由另一条任务在改（本轮不许碰 `ContentBoard.tsx`），
   * 所以这里**临时注册**一个形状相同的板块：两格都 `keepMounted`，
   * 其中一格 `dynamic`。它验的是**骨架的机制**，与那个板块的具体实现无关 ——
   * 内容板块落地后只要声明对，这里验过的东西就成立。
   */
  {
    /* 一个「像画布那样」的最小板块：**每一格各自挂载**，挂不挂由 `keptTabs` 决定。
     *
     * ## 为什么必须这样造（第一版造弱了，自证时发现了）
     *
     * 第一版只把 `keptTabs` 拼成一行字显示出来 —— 结果 `.find()` 回归时
     * 「两个板块的格子都在」那条**照样绿**：两个板块各自都还留着第一格，
     * 看不出第二格已经被丢掉。判据要落在**每一格的在/不在**上才有意义。
     *
     * ## 现在的形状
     *
     * 每一格渲染成一个带 `data-zz-pane="<板块>/<格>"` 的 div：
     *   · 正看着的那一格 → `data-on`（对应 `tab`）；
     *   · 在 `keptTabs` 里的格 → **即使 inactive 也挂载**（这就是常驻）；
     *   · 其余格 → 不渲染。
     *
     * 于是「第二格被 `.find()` 漏掉」直接表现为 `data-zz-pane="甲/y"` 消失。
     */
    const mkComp = (label) => (props) => {
      /* 挂上就上报「`c` 可见」—— 验上报通道真的接上了（与另一段同一套用法）。 */
      React.useEffect(() => { props.onTabsChange?.(['c']) }, [props])
      const panes = []
      for (const id of (props.keptTabs ?? [])) {
        const on = props.active === true && props.tab === id
        panes.push(React.createElement('div', {
          key: id,
          'data-zz-pane': label + '/' + id,
          'data-on': on ? '' : undefined,
        }, label + ' 的 ' + id))
      }
      /* 当前格不在常驻清单里时也要画（比如板块正显示着、用户在别的格）。 */
      if (!(props.keptTabs ?? []).includes(props.tab)) {
        panes.push(React.createElement('div', {
          key: 'cur', 'data-zz-pane': label + '/' + props.tab, 'data-on': '',
        }, label + ' 的 ' + props.tab))
      }
      return React.createElement('div', { 'data-zz': label },
        label + '／常驻清单 ' + String((props.keptTabs ?? []).join(',')), panes)
    }
    const offA = reg.registerBoard({
      id: 'zz.kept.a', title: '常驻甲', order: 4, component: mkComp('甲'),
      tabs: [
        { id: 'x', label: '甲一', keepMounted: true },
        { id: 'y', label: '甲二', keepMounted: true },
      ],
    })
    const offB = reg.registerBoard({
      id: 'zz.kept.b', title: '常驻乙', order: 3, component: mkComp('乙'),
      tabs: [
        { id: 'x', label: '乙一', keepMounted: true },
        { id: 'y', label: '乙二', keepMounted: true },
      ],
    })
    await render()

    /* 先进入甲、切到它的第二格（`y`）—— 两个都打开过之后才切走。 */
    await open('zz.kept.a')
    await open('zz.kept.b')
    /* ★ 关键一步：两个板块**都打开过**之后切回甲，再切到别的板块。
     * 以前 `.find()` 只认第一格（`x`），第二格 `y` 从没被当成常驻格。 */
    await open('zz.kept.a')
    const tabY = [...doc.querySelectorAll('[role="tab"]')].find(b => (b.textContent ?? '').trim() === '甲二')
    if (tabY !== undefined) {
      await act(async () => { tabY.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise(r => setTimeout(r, 60)) })
    }
    /* 切到完全无关的一块 —— 这时两个常驻板块都在后台挂着。 */
    await open('overview')
    const panes = () => [...doc.querySelectorAll('[data-zz-pane]')].map(e => e.getAttribute('data-zz-pane'))

    /* ★★ 骨架把**每一格**都保住了：甲的 x 与 y、乙的 x 与 y，四个都在。
     *
     * 这一条是 `.find()` → `.filter()` 的核心判据：`.find()` 时每块只剩第一格，
     * 甲的 `y` 与乙的 `y` 都不在 DOM 里（自证第一次就靠这条抓的）。 */
    const all = panes()
    const wantFour = ['甲/x', '甲/y', '乙/x', '乙/y']
    const missingPane = wantFour.filter(p => !all.includes(p))
    check('★★ 四个常驻格全在 DOM（两块各两格，切走后都不卸）',
      missingPane.length === 0,
      missingPane.length === 0 ? all.join(' / ') : '缺：' + missingPane.join('、'))

    /* ★★ 而且后台那几格**都不该是「正在显示」**（藏起来 ≠ 还在画面上）。
     * 判据落在 `data-on`：切到 overview 之后，甲乙的格都不该带它。 */
    const anyOn = [...doc.querySelectorAll('[data-zz-pane][data-on]')]
      .map(e => e.getAttribute('data-zz-pane'))
    check('★ 后台的常驻格没有一个是「正在显示」状态',
      anyOn.length === 0, '仍在显示的：' + (anyOn.join(' / ') || '（无）'))

    /* ★ 回到甲：它记住了上次那一格（`y`），看到的是 `y` 而不是被重置成 `x`。 */
    await open('zz.kept.a')
    const onNow = [...doc.querySelectorAll('[data-zz-pane][data-on]')]
      .map(e => e.getAttribute('data-zz-pane'))
    check('★ 切回来仍停在第二格（选中的 tab 记住了）',
      onNow.includes('甲/y'), '正在显示的：' + (onNow.join(' / ') || '（无）'))

    /* ★★ `keptTabs` 必须是**全量清单**，不是只有第一格。 */
    const keptText = (doc.querySelector('[data-zz="甲"]')?.textContent ?? '')
    check('★★ 板块拿到的是常驻格的**全量清单**（不是只有第一格）',
      keptText.includes('x,y'), '实际：' + keptText)
    offA()
    offB()
    await render()
  }

  {
    /* ── 动态 tab：出现 / 隐藏 / 排第一位 ───────────────────────── */
    const offDyn = reg.registerBoard({
      id: 'zz.dyn', title: '动态格', order: 2,
      /* ⚠️ `canvas`（dynamic）写在**第一位** —— 验收要求「出现时在第一位」。
       * 顺序由注册决定，骨架不重排（`visibleTabs` 只过滤、不排序）。 */
      tabs: [
        { id: 'canvas', label: '画布', dynamic: true },
        { id: 'files', label: '文件' },
      ],
      component: (props) => {
        /* 自己拨开关：`__zzShowCanvas` 为真才上报「画布可见」。
         * 用模块级变量而不是 props，是为了让测试能在外部拨它。 */
        React.useEffect(() => {
          props.onTabsChange?.(globalThis.__zzShowCanvas === true ? ['canvas', 'files'] : ['files'])
        }, [props, globalThis.__zzShowCanvas])
        return React.createElement('div', { 'data-zz-dyn': '' }, '动态格内容')
      },
    })
    await render()
    await open('zz.dyn')
    const tabLabels = () => [...doc.querySelectorAll('[role="tab"]')].map(b => (b.textContent ?? '').trim())

    /* ① 没上报「画布可见」时，它**不在** tab 条上。 */
    globalThis.__zzShowCanvas = false
    await render()
    await open('zz.dyn')
    const hidden = tabLabels()
    check('★★ 动态格隐藏时 tab 条上没有它（没打开画布就看不到「画布」）',
      !hidden.includes('画布'), '实际 tab：' + hidden.join(' / '))
    /* 反面：非动态的那一格**永远在**（骨架管不着它）。 */
    check('★ 没标 dynamic 的格子照旧显示（过滤不该误伤）',
      hidden.includes('文件'), '实际 tab：' + hidden.join(' / '))

    /* ② 上报「画布可见」→ 它出现，且**在第一位**。 */
    globalThis.__zzShowCanvas = true
    await render()
    await open('zz.dyn')
    const shown = tabLabels()
    check('★★ 动态格出现时在**第一位**', shown[0] === '画布', '实际 tab：' + shown.join(' / '))
    check('★ 动态格出现后不重复、不少别的格', shown.length === 2 && shown[1] === '文件',
      '实际 tab：' + shown.join(' / '))

    /* ③ 再关掉 → 重新消失。 */
    globalThis.__zzShowCanvas = false
    await render()
    await open('zz.dyn')
    check('★★ 关掉之后动态格重新消失', !tabLabels().includes('画布'),
      '实际 tab：' + tabLabels().join(' / '))

    offDyn()
    await render()
  }

  /* ★★ 默认值：**没上报过**的板块，注册时声明的 tab 全显示。
   *
   * 这一条是「现有七个板块一行都不用改」的判据 —— 它们全都不传 `onTabsChange`。
   * 没有它的话，骨架若把「没上报」当成「全都不可见」，七个板块会一起变成空 tab 条。 */
  /* ★ 票 01（2026-10-30）：**这一条换例子了，判据本身没变**。
   *
   * 「没上报过的板块 → 注册时的 tab 全显示」这条硬性规则仍然成立，
   * 只是**工作流板块不再是它的例子** —— 它现在会上报（画布是动态格）。
   *
   * 换一个真的不上报的板块来验：`history`（收藏）与 `config`（配置）都不传
   * `onTabsChange`。用「收藏」验：它的 tab 应当**一格不少**。
   *
   * ⚠️ 用 tab 数而不是列名字：文案会改，数不会（改一格文案不该让这条变红）。 */
  await open('collect')
  const colTabs = [...doc.querySelectorAll('[role="tab"]')].map(b => (b.textContent ?? '').trim())
  check('★★ 没上报过的板块按注册时的 tab 全显示（工作流已改为上报，换收藏板块验）',
    colTabs.length >= 2,
    '收藏板块的 tab：' + colTabs.join(' / '))

  /* 反面：工作流板块**确实**在上报（只有两格，画布被隐藏了）。 */
  await open('workflow')
  const wfTabs = [...doc.querySelectorAll('[role="tab"]')].map(b => (b.textContent ?? '').trim())
  check('★★ 票 01：工作流板块默认只报两格（画布默认隐藏）',
    wfTabs.length === 2 && !wfTabs.includes('画布') && wfTabs.includes('工作流管理'),
    '实际 tab：' + wfTabs.join(' / '))

  /* ════════════════════════════════════════════════════════════════════
   * ★★ 0.1 的**真双板块**完成标准（2026-10-25 契约 BJ 任务四）
   *
   * ## 这一段与上面那段假板块的分工
   *
   * 上面 `zz.kept.a` / `zz.kept.b` 验的是**机制泛化**（一个板块里多格都常驻）。
   * 那件事真板块验不了 —— 现在 `content` 与 `workflow` 各只有一个 `keepMounted` 格。
   *
   * 这一段验的是计划 §三 Step 0.1 的**完成标准原文**：
   * 「内容板块与工作流板块**同时**打开过画布后，切到别的板块再切回来，
   * 两个画布的节点都还在」。它当时只能用假板块验机制，Step 7 落地后才能真跑。
   *
   * ## 为什么必须真板块（校核点名的那件事）
   *
   * 假板块的 `keptTabs` 是**假组件自己造的**，绕过了 `boards.ts` 的真声明。
   * 真板块才有这条完整链路：
   *
   * ```
   * registerBoard 声明 tabs + keepMounted
   *   → EcomWorkbench.tsx keptTabsOf() 推导
   *   → EcomWorkbench.tsx panes 过滤
   *   → 常驻格子真的被保留挂载
   * ```
   *
   * 所以这里用**真 `ContentBoard` / 真 `WorkflowBoard`**。
   *
   * ## 抄本与源码之间钉的是什么、不钉什么（⚠️ 别把这段读大）
   *
   * 本段的注册项是**抄来的**（要换掉注册项才能挂计数器，所以不可能直接引用
   * `boards.ts` 那两行）：`tabs` 逐格照抄，`title` / `group` / `order` 也照抄，
   * `icon` **没抄**（判据用不到它）。其余字段只抄与判据相关的。
   *
   * 下面 ④ 段那两条断言**只钉住两个 `canvas` 格上的开关还在**：
   *   · `content` 的 `canvas` 仍带 `dynamic` + `keepMounted`；
   *   · `workflow` 的 `canvas` 仍带 `keepMounted`。
   *
   * **它不钉「整份 tabs 与抄本一致」** —— 这是有意的，覆盖面如实记在这里：
   *
   * | 漂移 | ④ 段会不会红 |
   * | --- | --- |
   * | 删掉 `content` 的 `prompts` 格 | 不会 |
   * | 把 `lib` 的 label 从「画布库」改成别的 | 不会 |
   * | 给 `content` 加第八格 | 不会 |
   * | `content` 的 `canvas` 去掉 `dynamic` | 会 |
   * | `content` 的 `canvas` 去掉 `keepMounted` | 会 |
   * | `workflow` 的 `canvas` 去掉 `keepMounted` | 会 |
   *
   * 为什么**不**加强成「整份 tabs 比对」：那会让「改一格 label 文案」这种正常改动
   * 也变红。判据只该钉住**本段要验的那件事** —— 常驻格声明还在。
   * 增减格子 / 改文案会不会漏掉真问题？会，但那归 `boards.ts` 那边的校验，
   * 不归这一段。
   *
   * ## 为什么「DOM 里还有它」不算判据
   *
   * 常驻格的隐藏手法是 `opacity: 0` + `pointer-events: none` —— **元素一直在 DOM 里**。
   * 卸载再挂回来同样「DOM 里有」。所以判据用两条互补的证据：
   *
   *   ① **挂载次数**（给真组件包一层计数器）：只增一次 = 没重挂；
   *   ② **组件内 `useState` 的痕迹**（画布上摆的节点 / 打开的那份存档）：
   *      重挂会让它们回到初始值 —— 那是「屏幕回来了但内容没了」，比白屏更难发现。
   */
  {
    const { ContentBoard } = await import('../src/client/workbench/ContentBoard.tsx')
    const { WorkflowBoard } = await import('../src/client/workbench/WorkflowBoard.tsx')

    /** 每个板块挂载了几次（重挂会 +1）。 */
    const mounts = new Map()
    /**
     * 给真组件包一层计数器。
     *
     * ⚠️ **不是替身**：里层原样渲染真组件、props 一个不改，只多记一个数。
     * 假组件验不出的是「`boards.ts` 的声明能不能推出常驻」——
     * 那条链路在这里完整走通（`keptTabs` 由骨架按真注册项算出来传下去）。
     *
     * @param id 板块 id（计数键）。
     * @param Inner 真组件。
     * @returns 带计数的组件。
     */
    const counted = (id, Inner) => function Counted(props) {
      React.useEffect(() => { mounts.set(id, (mounts.get(id) ?? 0) + 1) }, [])
      return React.createElement(Inner, props)
    }

    /* 这两份注册项是**抄来的**：本测试要换掉注册项才能挂计数器，所以不可能直接引用
     * `boards.ts` 那两行。`tabs` 逐格照抄，`title` / `group` / `order` 也照抄，
     * `icon` **没抄**（判据用不到它）。
     *
     * ⚠️ 下面 ④ 段只钉住两个 `canvas` 格上的 `dynamic` / `keepMounted` 还在，
     * **不钉整份 tabs 一致**（增减格子、改 label 不会红）。段首那张表列了每一项。 */
    const offContentReal = reg.registerBoard({
      id: 'content', title: '内容', group: '创作', order: 60,
      tabs: [
        { id: 'canvas', label: '画布', dynamic: true, keepMounted: true },
        { id: 'lib', label: '画布库' },
        { id: 'gen', label: '生图工作台' },
        { id: 'video', label: '视频创作台' },
        { id: 'library', label: '内容库' },
        { id: 'prompts', label: '提示词库' },
        { id: 'config', label: '板块设置' },
      ],
      /* ⚠️ `ContentBoard` 是**真组件**（`import` 进来的那个）。`counted()` 只加一个
       * 挂载计数、原样把 props 透传下去 —— **不是替身**。
       * 这一行换成假组件，"boards.ts 的声明 → keptTabsOf → 常驻" 这条链路就白验了。 */
      component: counted('content', ContentBoard),
    })
    const offWorkflowReal = reg.registerBoard({
      id: 'workflow', title: '工作流', group: '编排', order: 70,
      tabs: [
        { id: 'files', label: '工作流管理' },
        { id: 'canvas', label: '画布', keepMounted: true },
        { id: 'history', label: '运行历史' },
      ],
      /* ⚠️ 同上：`WorkflowBoard` 是**真组件**，`counted()` 只计数、不换实现。 */
      component: counted('workflow', WorkflowBoard),
    })

    /* 本段喂给工作流画布的那份存档。
     *
     * ## 为什么提成具名常量（2026-10-26 契约 BJ 补）
     *
     * 下面的断言要判「工作流画布上的节点数**等于这份存档的节点数**」，
     * 于是它必须从**这份数据本身**取数，不能写死 `2` ——
     * 写死的话以后往存档里加一个节点，断言会红在一个与它无关的地方。
     */
    const WF_DOC = {
      version: 1, name: '双画布测试工作流', id: 'wf-dual-demo',
      nodes: [
        { id: 's', defId: 'flow.start', position: { x: 0, y: 0 }, params: {} },
        { id: 'c', defId: 'code.js', position: { x: 260, y: 0 }, params: { code: 'return { ok: 1 }' } },
      ],
      edges: [{ id: 'e1', source: 's', target: 'c' }],
    }

    /* ── 宿主桩：这一段要内容画布与工作流画布都能真打开 ──
     *
     * 内容画布要 `POST/GET /canvases`；工作流画布要 `GET /workflows` + `GET /workflow`。
     * 它们各自还会拉产物清单 / 生成记录 / 渠道 —— 一律回空。 */
    const realStub = (url, init) => {
      const p = String(url).replace(/^https?:\/\/[^/]+/, '')
      const q = p.split('?')[0]
      const method = String(init?.method ?? 'GET').toUpperCase()
      const ok = (b) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) })
      if (q === '/api/ecom-workbench/canvases' && method === 'GET') return ok({ ok: true, canvases: [] })
      if (q === '/api/ecom-workbench/canvases' && method === 'POST') {
        return ok({ ok: true, canvas: { id: 'cv_dual', title: '双画布', createdAt: 1, updatedAt: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } })
      }
      if (q.startsWith('/api/ecom-workbench/canvases/')) {
        return ok({ ok: true, canvas: { id: 'cv_dual', title: '双画布', createdAt: 1, updatedAt: 1, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } })
      }
      if (q === '/api/ecom-workbench/workflows' && method === 'GET') {
        return ok({ ok: true, dir: 'C:/ewb-test', items: [{ name: '双画布测试工作流', id: 'wf-dual-demo', nodes: 2, edges: 1 }], names: ['双画布测试工作流'] })
      }
      if (q === '/api/ecom-workbench/workflow' && method === 'GET') {
        return ok({ ok: true, name: WF_DOC.name, doc: WF_DOC })
      }
      if (q === '/api/ecom-workbench/workflow/runs') return ok({ ok: true, runs: [] })
      if (q === '/api/ecom-workbench/workflow/io') return ok({ ok: true, inputs: [], outputs: [] })
      if (q.startsWith('/api/ecom-workbench/gen-logs')) return ok({ ok: true, logs: [] })
      if (q === '/api/ecom-workbench/channels') return ok({ ok: true, channels: [] })
      if (q === '/api/ecom-workbench/materials') return ok({ ok: true, materials: [] })
      if (q === '/api/ecom-workbench/artifacts') return ok({ ok: true, items: [] })
      if (q === '/api/ecom-workbench/artifacts/usage') return ok({ ok: true, usage: {} })
      if (q.includes('/collect')) return ok({})
      return ok({ dir: 'C:/ewb-test', items: [] })
    }
    window.fetch = realStub
    globalThis.fetch = realStub
    await render()

    /** 点一个带 data 钩子的元素，并等它生效。 */
    const clickSel = async (sel, wait = 700) => {
      const el = doc.querySelector(sel)
      if (el === null || el === undefined) return false
      await act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise(r => setTimeout(r, wait)) })
      return true
    }
    /** 等某个选择器出现。 */
    const waitFor = async (sel, tries = 30) => {
      for (let i = 0; i < tries; i += 1) {
        if (doc.querySelector(sel) !== null) return true
        await act(async () => { await new Promise(r => setTimeout(r, 100)) })
      }
      return false
    }
    /** 内容画布上的节点数。 */
    const contentNodes = () => doc.querySelectorAll('[data-ewb-content-pane="canvas"] .react-flow__node').length
    /**
     * **不属于内容画布**的那些 React Flow 节点（也就是工作流画布的）。
     *
     * ## ⚠️ 为什么不能直接数全局 `.react-flow__node`
     *
     * 内容板块是常驻挂载的 —— 切到工作流板块之后，**它的画布仍在 DOM 里**。
     * 所以全局计数会把内容画布那个节点一起数进去，「工作流画布有节点」这条
     * 就会被内容画布的证据蒙过去（第一版就是这么假绿的）。
     *
     * 判据：排在 `[data-ewb-content-pane]` 里的都不算。
     */
    const wfNodes = () => [...doc.querySelectorAll('.react-flow__node')]
      .filter(n => n.closest('[data-ewb-content-pane]') === null).length
    /** 同理：**不属于内容画布**的那些 React Flow 视口。 */
    const wfViewports = () => [...doc.querySelectorAll('.react-flow__viewport')]
      .filter(n => n.closest('[data-ewb-content-pane]') === null).length
    /** 等「工作流画布那个视口」出现（内容画布那个不算）。 */
    const waitWfViewport = async (tries = 40) => {
      for (let i = 0; i < tries; i += 1) {
        if (wfViewports() > 0) return true
        await act(async () => { await new Promise(r => setTimeout(r, 100)) })
      }
      return false
    }
    /** 等页面上出现某段文字。 */
    const waitText = async (text, tries = 40) => {
      for (let i = 0; i < tries; i += 1) {
        if ((doc.body.textContent ?? '').includes(text)) return true
        await act(async () => { await new Promise(r => setTimeout(r, 100)) })
      }
      return false
    }

    /** 点 tab 条上某一格（按文字）。 */
    const clickTab = async (label) => {
      const b = [...doc.querySelectorAll('[role="tab"]')].find(x => (x.textContent ?? '').trim() === label)
      if (b === undefined) return false
      await act(async () => { b.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise(r => setTimeout(r, 500)) })
      return true
    }

    /* ── ① 真的打开内容画布 ── */
    await open('content')
    check('★ 真内容板块挂上了（第一次）', (mounts.get('content') ?? 0) === 1,
      '次数=' + String(mounts.get('content') ?? 0))
    check('★ 真内容板块的画布库在', doc.querySelector('[data-ewb-canvas-lib]') !== null)
    check('★ 点了「新建画布」', await clickSel('[data-ewb-canvas-new]'))
    check('★★ 真内容画布挂上了（React Flow 视口在）',
      await waitFor('[data-ewb-content-pane="canvas"] .react-flow__viewport'))
    /* 摆一个节点：重挂会让它消失（组件内 useState）。 */
    check('★ 在内容画布上摆了一个文本节点', await clickSel('[data-ewb-canvas-add="text"]'))
    check('★★ 摆上去之后内容画布上有 1 个节点', contentNodes() === 1, '实际 ' + String(contentNodes()))
    const cMounts = mounts.get('content') ?? 0

    /* ── ② 真的打开工作流画布 ── */
    await open('workflow')
    check('★ 真工作流板块挂上了（第一次）', (mounts.get('workflow') ?? 0) === 1,
      '次数=' + String(mounts.get('workflow') ?? 0))
    /* ⚠️ **先切回「工作流管理」那一格**：上面那些段落点过「画布」，
     * 骨架按板块记住了「上次停在哪一格」（`tabOf`），所以进来时可能正停在画布上。
     * 不切回列表就找不到那份存档的行 —— 第一版就是那么假红的。 */
    const toList = await clickTab('工作流管理')
    check('★ 切回「工作流管理」那一格（列表）', toList)
    check('★★ 工作流列表里读到了那份存档（桩生效）', await waitText('双画布测试工作流'))
    /* 点那一条的「打开到画布」按钮 → 读存档、`requestOpen`、切到画布格。
     *
     * ⚠️ 判据不能靠「找那行文字」：同一个名字在列表里出现多次（标题、面包屑、按钮 title），
     * 点到哪个都不一定触发「打开」。所以要找**那行里的那个按钮**。 */
    const openBtn = [...doc.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '打开到画布')
    check('★ 列表里找得到「打开到画布」按钮', openBtn !== undefined)
    if (openBtn !== undefined) {
      await act(async () => { openBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
      await act(async () => { await new Promise(r => setTimeout(r, 1200)) })
    }
    check('★★ 真工作流画布挂上了（**不属于内容画布**的视口出现了）', await waitWfViewport(),
      '非内容画布的视口数=' + String(wfViewports()))
    check('★★ 工作流画布上的节点数**等于存档里的节点数**（那一份真的打开了）',
      wfNodes() === WF_DOC.nodes.length,
      '实际 ' + String(wfNodes()) + ' 个 / 期望 ' + String(WF_DOC.nodes.length) + ' 个')
    const wMounts = mounts.get('workflow') ?? 0

    /* ── ③ 切到第三个板块，再切回来 ── */
    await open('overview')
    check('★ 切走之后内容板块**没有重挂**（挂载次数不变）',
      (mounts.get('content') ?? 0) === cMounts,
      '切走前 ' + String(cMounts) + ' → 切走后 ' + String(mounts.get('content') ?? 0))
    check('★ 切走之后工作流板块**没有重挂**（挂载次数不变）',
      (mounts.get('workflow') ?? 0) === wMounts,
      '切走前 ' + String(wMounts) + ' → 切走后 ' + String(mounts.get('workflow') ?? 0))
    /* 判据 B：组件内状态还在（抓「没重挂但内容丢了」）。 */
    check('★★ 切走之后内容画布那个节点还在', contentNodes() === 1, '节点数=' + String(contentNodes()))
    check('★★ 切走之后工作流画布的节点还在（仍是存档里那几个）',
      wfNodes() === WF_DOC.nodes.length,
      '实际 ' + String(wfNodes()) + ' 个 / 期望 ' + String(WF_DOC.nodes.length) + ' 个')

    /* 切回内容板块。 */
    await open('content')
    check('★★ 切回内容板块仍未重挂', (mounts.get('content') ?? 0) === cMounts,
      '实际 ' + String(mounts.get('content') ?? 0))
    check('★★ 切回来内容画布那个节点还在', contentNodes() === 1, '节点数=' + String(contentNodes()))

    /* 切回工作流板块。 */
    await open('workflow')
    check('★★ 切回工作流板块仍未重挂', (mounts.get('workflow') ?? 0) === wMounts,
      '实际 ' + String(mounts.get('workflow') ?? 0))
    check('★★ 切回来工作流画布的节点还在（仍是存档里那几个）',
      wfNodes() === WF_DOC.nodes.length,
      '实际 ' + String(wfNodes()) + ' 个 / 期望 ' + String(WF_DOC.nodes.length) + ' 个')

    /* ── ④ 声明一致性：**只钉那两个 `canvas` 格上的开关**，不钉整份 tabs ──
     *
     * 抄错了就等于拿假声明验自己 —— 那正是这一段要躲开的坑。
     *
     * ⚠️ 覆盖面如实记：下面两条只认「`content` 的 `canvas` 带 `dynamic` + `keepMounted`」
     * 与「`workflow` 的 `canvas` 带 `keepMounted`」。**增减格子、改 label 不会红** ——
     * 那是刻意的（改一格文案是正常改动，不该让这条变红）。
     * 上面段首那张表把每种漂移会不会红都列出来了，读之前先看它。 */
    {
      const boardsSrc = src('src/client/workbench/boards.ts')
      const wfSeg = boardsSrc.slice(boardsSrc.indexOf('const WORKFLOW_TABS'), boardsSrc.indexOf('const COLLECT_TABS'))
      /* ★ 票 01：画布那格现在**同时**带 `dynamic` 与 `keepMounted`，且排在第一位。 */
      check('★ boards.ts 的 WORKFLOW_TABS 里画布那格标了 dynamic + keepMounted（票 01）',
        /id:\s*'canvas',\s*label:\s*'画布',\s*dynamic:\s*true,\s*keepMounted:\s*true/.test(wfSeg),
        wfSeg.includes('dynamic: true') ? '' : '没找到 dynamic')
      check('★ 票 01：画布那格排在**第一位**（用户要求「才在第一个 TAB 出现画布」）',
        wfSeg.indexOf("id: 'canvas'") < wfSeg.indexOf("id: 'files'"),
        'canvas@' + String(wfSeg.indexOf("id: 'canvas'")) + ' files@' + String(wfSeg.indexOf("id: 'files'")))
      const from = boardsSrc.indexOf("id: 'content'")
      const contentSeg = boardsSrc.slice(from, from + 1400)
      check('★ boards.ts 的 content 声明里画布那格标了 dynamic + keepMounted（与上面抄的一致）',
        /id:\s*'canvas',\s*label:\s*'画布',\s*dynamic:\s*true,\s*keepMounted:\s*true/.test(contentSeg),
        contentSeg.includes('keepMounted: true') ? '' : '没找到')
    }

    offContentReal()
    offWorkflowReal()
    window.fetch = globalThis.fetch = stub
    await render()
  }

  console.error = origErr
  await act(async () => { root.unmount() })
}

console.log('')
console.log(failed === 0 ? '结论：板块注册表接对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
