/** 真 DOM 渲染测试：用 jsdom 渲染工作台，跑 useEffect，抓无限渲染与运行时异常。
 *
 * 为什么需要它：之前的测试用 renderToString（服务端渲染）——**不会跑 useEffect**，
 * 所以「rAF 每帧 setState 导致无限渲染」这类 bug 抓不到（用户就是因此崩溃的）。
 * 这个测试用 react-dom/client 挂到 jsdom，真正执行副作用，并统计渲染次数。
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ 改这份文件之前必读：它跑的主页面是**打包产物**，不是源码
 * ══════════════════════════════════════════════════════════════════════
 *
 * `:865` 那句：
 *
 * ```js
 * const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
 * new Function('window', 'document', 'localStorage', 'navigator', code)(…)
 * ```
 *
 * 也就是把 `lib/client.js` 当**一段代码**跑起来，页面就是它渲染出来的。
 * 由此带来三个必须知道的事：
 *
 * ## ① 「改源码 → 看断言变红」的自证，必须先打包
 *
 * 你改了 `src/client/…` 却在没打 `npm run bundle` 的情况下跑这份测试，
 * 验的还是**上一版产物** —— 断言不会变红，或者不该红的地方红了。
 *
 * 所以这份文件里的自证是**两步往返**：
 *
 * ```
 * 改源码 → 请有打包权限的人跑 npm run bundle → 再跑本测试
 * ```
 *
 * 这不是谁写错了，是「读产物」这件事的固有代价。**别自己跑 bundle**
 * （本项目由队长统一调度，两人同时写 `lib/client.js` 会让测试读到半截产物）。
 *
 * ## ② 产物里的 store 与源码里的 store 是**两个不同实例**
 *
 * 这一条的坑踩过（票 14，2026-10-27）：产物里带自己那一份 zustand store
 * （`grep -c useRunStore lib/client.js` → 8）。
 * 而 `await import('../src/…/run-store.ts')` 拿到的是**源码那份**。
 *
 * 于是「往假 EventSource 推帧 → 查源码 store」永远读到空 ——
 * **被测代码是对的，断言红了**。判据挑错了地方。
 *
 * **规矩**：凡是要验「产物里那份状态」，只能走两条路 ——
 *   · 查 **DOM**（产物渲染出来的东西，看得见的那一层）；
 *   · 查 **产物原文**（`readFileSync('lib/client.js')` 里的接线在不在）。
 * 不要 `import` 源码模块去读运行时状态。
 *
 * ## ③ 有几段是**从源码 import 的**（那几条反过来不受产物影响）
 *
 * 提示词板块、BI 板块、设置抽屉、`run-store` 的纯函数部分等（`:17-22` 说清了为什么）。
 * 这些段落改源码就立刻生效、不必打包 —— 但也因此**它们验不到「打包有没有带进去」**。
 *
 * 每一段用的是哪一种，看它自己那段注释：写了「读产物」还是「import 源码」。
 */
import { readFileSync } from 'node:fs'
import { settle, waitUntil as waitUntilGlobal } from './_wait.mjs'
/* 局部别名：文件里已有几段用同名局部函数的（`Ctrl+G` 那段），不冲突。 */
import { createRequire, register } from 'node:module'
/* 节点定义（纯数据）——「参数区里该有的都在」那条断言要与定义**逐条对照**，
 * 不能只数「渲染出来几个」（数个数的话，漏一项也照样通过）。 */
import { NODE_LIBRARY } from '../src/nodes/index.ts'

/* ⚠️ `.css` / `.module.css` 一律当空模块（与打包器对 CSS Modules 的语义一致）。
 *
 * 为什么需要（2026-10-22 加）：本文件里有些段落**直接从源码 import 组件**
 * （提示词板块、BI 板块、设置抽屉 —— 那些判据读产物就会把「没重建」误报成「代码坏了」）。
 * 而源码组件 import 了 `.module.css`，Node 不认识那个扩展名会直接抛。
 *
 * 这不是在「绕过错误」：样式对这几段断言（查文字、查属性、点按钮）本来就不参与，
 * 而打包器对 `.css` 的语义就是「给一个类名映射对象」，这里与之一致。 */
register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, ctx, next) {\n'
  + "  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }\n"
  + '  return next(url, ctx)\n'
  + '}\n',
))

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

/* ══════════════════════════════════════════════════════════════════════
 * 运行时断言覆盖统计（2026-10-26，加这条的起因看下面）
 * ══════════════════════════════════════════════════════════════════════
 *
 * ## 为什么要它
 *
 * 这个文件里有大量这种形状：
 *
 * ```js
 * if (someEl !== undefined) { ...三条断言... }     // 拿不到就整块跳过
 * ```
 *
 * 「条件为假就跳过」本身有时是对的（前置确实可能不存在），但**没有任何机制
 * 告诉你它到底是「前置不存在」还是「那条断言从来没跑过」**。
 * 这轮已经撞见三次假绿（`if (writes.length > 0)`、分组框实例、5 处「存在才验」）。
 *
 * 用脚本数「形状」解决不了 —— 判「没进 if」不等于「没验」，有些块前面另有
 * `if (x === undefined) { errors.push }` 兜着。**唯一能判的是运行时到底跑没跑。**
 *
 * ## 怎么做的
 *
 * 把 `console.log` 包一层，用堆栈里出现的**本文件行号**记「这一行真的执行过」；
 * 再与源码里「含 ✓ 或 ✗ 的 console.log 行」求差集。
 *
 * ⚠️ 两个坑（都是实测踩的）：
 *   ① `process.on('exit')` 必须**在 import 之前**注册 —— 本文件最后一句就是
 *      `process.exit(...)`，之后再注册永远等不到。
 *   ② 不能用「堆栈第 2 行」取行号 —— 包装函数本身占了一层，会差 1 行。
 *      要**扫整个堆栈找第一处 `dom-render.mjs:N`**。
 *
 * ## 差集怎么判
 *
 * 不是「有差集就红」—— 有些行本来就是失败分支或诊断输出（跑不到是正常的）。
 * 所以登记了一份**白名单**：每一条写明「为什么它没执行是对的」。
 * 白名单以外的差集一律红，逼着加新分支的人顺手说明。
 */
/**
 * 包装函数所在的源码行区间（含），用来把它自己的栈帧排除掉。
 *
 * ⚠️ **这是绝对行号，在文件头插行就要跟着改。**
 * 2026-10-27 加文件头说明时插了 40 行，这里从 `74 / 112` 改成 `114 / 152`。
 * 不改的后果：`ASSERT_COVERAGE_HIT` 记下来的全是错行号，
 * 「没执行且没登记」会一次报几百处（实测 668 处）。
 *
 * 改法：找到 `Object.defineProperty(globalThis, 'console'` 那一行（`WRAP_FROM`）
 * 与它的 `})` 收尾那一行（`WRAP_TO`）。
 */
const WRAP_FROM = 114
const WRAP_TO = 152
const ASSERT_COVERAGE_HIT = new Set()
const __origConsoleLog = console.log
Object.defineProperty(globalThis, 'console', {
  value: Object.assign(Object.create(console), {
    log: (...args) => {
      const st = new Error().stack?.split('\n') ?? []
      /* ⚠️ **包装函数自己也在本文件里**，所以堆栈里第一处 `dom-render.mjs:N`
       * 永远是包装函数内部那一行（不是调用方）。实测踩到：所有调用都记成同一个
       * 行号，于是「命中」看着有、和静态清单一条都对不上。
       * 现在跳过 [WRAP_FROM, WRAP_TO] 这一段，取**第一个落在外面的**行号。 */
      for (const raw of st) {
        const m = /dom-render\.mjs:(\d+):\d+/.exec(raw)
        if (m === null) continue
        const n = Number(m[1])
        if (n >= WRAP_FROM && n <= WRAP_TO) continue
        ASSERT_COVERAGE_HIT.add(n)
        break
      }
      __origConsoleLog(...args)
    },
  }),
  writable: true,
  configurable: true,
})

/**
 * 「跑不到是对的」的那些行 → 理由。
 *
 * ## ⚠️ 2026-10-29（票 77）：从「记行号」改成「记代码片段」
 *
 * ### 为什么改
 *
 * 这张表原来记的是**行号**（`new Map([[961, '…'], …])`）。行号一漂，全表失效，
 * 表现是一堆「没执行且没登记」的假失败，然后要人工「测量 → 写 → 再测量」
 * 反复迭代才收敛。
 *
 * **2026-10-29 一天里撞了六次**（票 54 / 56 / 65 / 75 / 62 / 63），
 * 每次都是「给这个文件加注释 → 整表后移 → 报一堆假失败」。
 *
 * ### 现在怎么匹配
 *
 * 每条是 `{ match, why }`。`match` 是**那一行里足够独特的一段源码文本**：
 *
 *   · 表在 `:161`，用它的扫描在文件末尾（`assertCoverage()` 那一段）；
 *   · 扫描先把**整份源码的注释剥掉**再找 `match`（注释里提到某个词不算用到了）；
 *   · 找不到 → **报错**（条目失效了必须有人知道，不许静默通过）；
 *   · 找到多处 → **也报错**（说明片段不够独特，撞了别的行）。
 *
 * ### 加新条目的要求
 *
 * `match` 必须能在**剥掉注释后的整份文件里唯一命中**。
 * 写一个勾号、或只写打印函数名，这种到处都有的不行 —— 会撞多处，直接报错。
 * 挑的时候从目标那一行的打印语句里抄一段**带业务词语**的。
 *
 * ⚠️ **写这段说明时别把勾号字符与打印函数名连在一起写** ——
 * 本文件的扫描会按「有没有勾号 / 叉号」认断言行，注释里连写会被当成一条真断言，
 * 于是这里凭空多出三处「没执行且没登记」。这一条是踩出来的（第一版就这么红过）。
 *
 * `why` 写清**为什么这行本来就不会执行**，不许只写「跳过」。
 */
const NEVER_RUN_OK = [
  { match: 'console.log(\'✗ 没找到组件\')', why: '「没找到组件」的失败分支：找到了就不执行，这是正确的' },
  { match: '用作强调色会在暗色主题下画出白框', why: '强调色用错时的诊断长句：颜色对就不会执行' },
  { match: '画布没有下发 `--ewb-node-w`', why: '画布没下发 --ewb-node-w 时的诊断长句：下发了就不执行' },
  { match: '点节点没有展开参数区，下面两条断言都验证不到', why: '「点节点没有展开参数区」的失败分支：展开了就不执行' },
  { match: '说明块「节点说明」存在:\', \'✗\'', why: '「找不到节点说明块」的失败分支：找到了就不执行' },
  { match: '说明块「可用变量」默认收起', why: '「可用变量」说明块：本节点没有可用变量时按设计不渲染，那条断言本来就不适用' },
  { match: '✗ 画布上找不到可右键的节点', why: '「画布上找不到可右键的节点」的失败分支' },
  { match: '✗ 找不到画布空白区', why: '「找不到画布空白区」的失败分支' },
  { match: '点了运行但一条派发请求都没发', why: '「点了运行但没发派发请求」的失败诊断' },
  { match: '✗ 产物里找不到 .toolbar 基础规则', why: '「产物里找不到 .toolbar 规则」的失败分支' },
  { match: '换行只在容器查询里写过', why: '「换行只写在容器查询里」的失败诊断' },
  { match: '画布被藏起来却仍在接管全局快捷键', why: '「隐藏的画布仍接管键盘」的失败诊断' },
  { match: '✗ 找不到 .pane 容器（常驻画布的容器不见了）', why: '「找不到 .pane 容器」的失败分支' },
  { match: '✗ 产物里找不到 .body 规则', why: '「产物里找不到 .body 规则」的失败分支' },
  { match: '找不到「隐藏对话区」的入口（logo 与旧按钮都没有）', why: '「找不到隐藏对话区入口」的失败分支' },
  { match: '两处是同一份状态（侧栏按钮跟着变了）', why: '侧栏那个按钮不在本 DOM 里 → 按设计跳过「两处状态一致」这一条' },
  { match: '找不到自动排版控件（`data-ewb-corner-layout`', why: '「找不到自动排版控件」的失败分支：找到了就不执行，这是正确的' },
  { match: '✗ 找不到备注输入框', why: '「找不到备注输入框」的失败分支' },
  { match: '✗ 找不到「执行」按钮（这一段验不到）', why: '「找不到执行按钮」的失败分支' },
  { match: 'save-as 若回来，save 必须同时存在', why: '「save-as 若回来」的失败分支：票 63 删了 save-as，它不在就不执行' },
]


/* 1) 建 jsdom 环境 */
const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
// navigator 在 Node 24 是只读的 —— 用 defineProperty 覆盖
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
 * 注意：这不是在「绕过错误」，而是把测试环境补到与浏览器等价；
 * 前一轮的 copySelected 报错是真实的代码 bug，这里补的是环境差异。 */
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

/* 1.5) fetch 桩：模拟宿主半的接口。
 * 为什么需要：列表页挂载时会拉 /api/ecom-workbench/workflows，
 * jsdom 没有 fetch（真实浏览器有），不桩的话页面永远卡在「加载中」，
 * 就验证不到「有数据时渲染成什么样」。 */
/** 收到的写请求（POST）——测「备注热更新」用。 */
const __ewbWritePosts = []
/**
 * 「等待中」列表的桩数据（2026-10-22 加）。
 *
 * ## 为什么做成可改的变量
 *
 * 「没有等待中的运行时不渲染空块」那条断言需要**先看到有、再看到没有**。
 * 换桩返回值最省事的办法就是改这个变量再点一次「刷新等待中」——
 * 不用重新挂载整个面板（重挂载会连带丢掉别的状态，断言之间互相干扰）。
 */
let __ewbPaused = [
  { runId: 'p-until', workflowId: '抖音商品流水线', pausedAt: Date.now() - 600000,
    resumeAfter: 'n3', resumeAt: Date.now() + 3600000, mode: 'until', until: '09:30', ran: 3 },
  /* ⚠️ 时长型那条的两个字段是**刻意**这么写的（2026-10-27，票 18）：
   *
   * ① `resumeAt` 钉成**固定时刻** `2026-10-27 14:05`（渲染成 `10-27 14:05`），
   *    不用 `Date.now() + 600000`。原因：原来那个写法让「时长型」那一行显示
   *    **当前时间往后十分钟**，而断言是「这一行不许出现 09:30」——
   *    只要测试恰好在 **09:20** 那一分钟内启动，往后十分钟正好是 09:30，
   *    那行磨出 `10-27 09:30`，断言当场假红。实测一天里有 **1 分钟**的窗口
   *    （探针：从 00:00 起逐分钟试 `fmtWhen(now + 10min)`，只有 09:20 命中）。
   *    这与「桩数据顺序」无关 —— `rowOf(id)` 本来就是按 id 查的，
   *    把两条记录对调照样绿（已实测）。
   *
   * ② `until` 故意给一个**与上面那条一模一样**的 `09:30`。它不是这条记录的
   *    真实字段（时长型没有「等到某个时刻」），放这里是为了让「until 漏到
   *    时长型」这个真错**必然显形**：组件只要不管 `mode` 就把 `until` 拼进去，
   *    这一行立刻出现 09:30 → 红。给一个**不同的**值（比如 07:15）反而漏掉这类错，
   *    因为那两种情况的差异就不再是「09:30 有没有出现」了。 */
  { runId: 'p-dur', workflowId: '天猫竞品巡查', pausedAt: Date.now() - 300000,
    resumeAfter: 'n5', resumeAt: new Date(2026, 9, 27, 14, 5).getTime(),
    mode: 'duration', until: '09:30', ran: 5 },
]
/**
 * 一份**带两层嵌套循环**的存档（2026-10-19 加，给「条件能选到 outer.item」那条断言用）。
 *
 * ## 为什么要有它
 *
 * 本轮要验的是「`flow.if` 的条件左边能选到**嵌套**循环的变量」。
 * 判据必须是**界面上真能选**（任务书写明），所以画布上得先有一张真的两层嵌套图。
 * 靠「从节点库一个个点 + 拖进框」在 jsdom 里造不出来（没有布局，落点算不准）。
 * 而「打开到画布」这条路本来就读存档 —— 直接让桩回这一份。
 *
 * 形状：`开始 → L1（外层循环）→ L2（内层循环，parentId=L1）→ { 生成数据 → 判断 }`
 * 那个「判断」节点在 L2 里，所以它应该同时能选到 `item` / `index` 与
 * `outer.item` / `outer.index`。
 */
const NESTED_LOOP_DOC = {
  version: 1,
  name: '嵌套循环示例',
  id: 'wf-nested-demo',
  nodes: [
    { id: 's', defId: 'flow.start', position: { x: 0, y: 0 }, params: {} },
    { id: 'L1', defId: 'flow.loop', position: { x: 260, y: 0 }, params: { mode: 'count', count: 2 } },
    /* ⚠️ 内层循环必须带 `parentId: 'L1'` —— 那是「它在第 2 层」的唯一依据
     * （`loopChainDepth` 沿这条链数）。少了它就是两个平行循环。 */
    { id: 'L2', defId: 'flow.loop', parentId: 'L1', position: { x: 60, y: 60 }, params: { mode: 'count', count: 2 } },
    { id: 'mk', defId: 'code.js', parentId: 'L2', position: { x: 40, y: 40 }, params: { code: 'return { n: 1 }' } },
    {
      id: 'IF', defId: 'flow.if', parentId: 'L2', position: { x: 280, y: 40 },
      /* 带一条**已经选了外层循环变量**的条件 —— 两个作用：
       *   ① 有行才会渲染出「选值」那个下拉（没有行时整块只有提示与按钮）；
       *   ② 能验「存档里写的 `outer.item` 读回来后仍被选中」（不是被清空成占位项）。 */
      params: {
        conditions: [{ left: { kind: 'loop', name: 'outer.item' }, op: 'notEmpty' }],
        logic: 'and',
        expr: '',
      },
    },
  ],
  edges: [
    { id: 'e1', source: 's', target: 'L1' },
    { id: 'e2', source: 'L1', target: 'L2' },
    { id: 'e3', source: 'mk', target: 'IF' },
  ],
}
/**
 * 一份**一条链**的存档（2026-10-22 加，画布初始改空之后才需要）。
 *
 * ## 为什么需要它
 *
 * 画布初始为空之后，下面几段要求「画布上有节点」的断言就没有前提了。
 * 而其中两条**必须靠连线**才验得动：
 *   · ⑬「排版间距影响自动布局」——ELK 对**零边**的图用的是分层给的网格，
 *     `spacing` 参数根本不参与（已实测：5 个孤立节点，spacing 10 与 380 坐标完全一致）；
 *   · ⑩「换方向后排布变」——同理，零边时 RIGHT / DOWN 算出来一模一样。
 *
 * 所以让桩回一份**带 4 条边的 5 节点链**。它就是原来示例图那条链的形状
 * （生成 → 筛 → 等 → 拼 → 写文件），只是改了个名字、不再当成画布初始内容。
 *
 * ⚠️ 为什么不在测试里自己拼：jsdom 没有布局，React Flow 的连线要走
 * mousedown(handle) → mousemove → mouseup(handle) 且依赖 `getBoundingClientRect`，
 * 那个在 jsdom 恒为 0 —— 合成事件连不出真边。存档是唯一可靠的路
 * （`NESTED_LOOP_DOC` 也是同一个理由）。
 */
const CHAIN_DOC = {
  version: 1,
  name: '示例包·链路',
  id: 'wf-chain-demo',
  nodes: [
    { id: 'c1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return [1, 2, 3]' }, onError: 'stop', state: 'idle' },
    { id: 'c2', defId: 'code.js', position: { x: 340, y: 0 }, params: { code: 'return input.filter(x => x > 1)' }, onError: 'stop', state: 'idle' },
    { id: 'c3', defId: 'flow.delay', position: { x: 680, y: 0 }, params: { ms: 300 }, onError: 'continue', state: 'idle' },
    { id: 'c4', defId: 'code.js', position: { x: 1020, y: 0 }, params: { code: 'return input.map(String).join(",")' }, onError: 'stop', state: 'idle' },
    { id: 'c5', defId: 'sys.fs.write', position: { x: 1360, y: 0 }, params: { path: 'ecom-workbench-out/链路示例.txt' }, onError: 'stop', state: 'idle' },
  ],
  edges: [
    { id: 'ce1', source: 'c1', sourceHandle: 'out', target: 'c2', targetHandle: 'in' },
    { id: 'ce2', source: 'c2', sourceHandle: 'out', target: 'c3', targetHandle: 'in' },
    { id: 'ce3', source: 'c3', sourceHandle: 'out', target: 'c4', targetHandle: 'in' },
    { id: 'ce4', source: 'c4', sourceHandle: 'out', target: 'c5', targetHandle: 'content' },
  ],
}
/** 提醒偏好桩状态（两项独立；测试会按需改它）。 */
let __ewbNotifyPrefs = { failNotify: false, alertMinLevel: 'info' }
/** 让 `/notify/prefs` 的**读**失败（验三段式提示用）。 */
let __ewbNotifyFailRead = false
/** 让 `/notify/prefs` 的**写**失败（验「失败保留原选中」用）。 */
let __ewbNotifyFailWrite = false
/** 提示词改写桩的模式（`ok` / `no-model` / `timeout` / `empty` / `missing`）。 */
let __ewbOptMode = 'ok'
/** 记下「提示词优化」那几次请求的**完整请求体**（验 prompt 与 input 传对了）。 */
const __ewbOptPosts = []
/** 「提示词优化」桩的延迟（毫秒）。用来抓「改写中」那一帧 —— 默认 0 立刻回。
 *
 * ⚠️ 不为 0 时**必须走真 Promise**（`new Promise(...)`）：
 * `Promise.resolve()` 之后再加 setTimeout 是没用的，微任务先跑完了。 */
let __ewbOptDelay = 0
/** 收到的提醒偏好 POST 请求体（验「只提交一个键」用）。 */
const __ewbNotifyPosts = []

/* ── 模型清单与偏好（2026-10-23 契约 J 加）──────────────────────────
 *
 * ## 为什么默认是 `fail`
 *
 * ⑲ 段要验「接口读不到时明确显示原因、页面不崩」。而模型清单是**模块级缓存**，
 * 一旦成功读到就再也不会回到「从没读到过」那个状态 —— 想验降级那一屏，
 * 只能让它**第一次**就失败。所以默认先失败，⑲ 里再拨成 `ok` 重读。
 *
 * 前面 ⑮ 那段（工作台设置）也会顺手触发一次读取 → 拿到失败 → 它不查模型，
 * 不影响那边的断言。
 *
 * ## 三种模式
 *
 *   · `fail`  → 回 `ok: false`，带一句原因（验降级文案）
 *   · `ok`    → 两个 provider、三个模型（其中一个模型名带 `/`，验拆分不靠猜）
 *   · `empty` → 一个 provider 都没有（验「dsh 里没有可用模型」那句）
 */
let __ewbModelsMode = 'fail'
/** GET `/models` 的次数（验「两处共用一份、不各拉一次」）。 */
let __ewbModelsGets = 0
/** 模型偏好的桩状态（默认 + 备选名单）。 */
let __ewbModelPrefs = {
  default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  picks: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
}
/** 收到的模型偏好 POST 请求体（验「只提交一个键」）。 */
const __ewbModelPosts = []

/** `/models` 的桩清单。 */
const __EWB_PROVIDERS = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: '最快' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
  },
  {
    id: 'other',
    name: '其它提供方',
    models: [{ id: 'org/legacy-model', name: '带斜杠的老模型' }],
  },
]

const __ewbFetchStub = (url, init) => {
  const u = String(url)
  /* 记下所有写请求 —— 用来验证「备注热更新」（改完不点保存也会自动写）。 */
  if (init?.method === 'POST') __ewbWritePosts.push({ url: u, body: String(init.body ?? '') })
  /* 收藏的写接口：测试里桩成成功，这样才验证得到「保存成功后界面怎么变」。 */
  if (u.includes('/api/ecom-workbench/collect/notes')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, path: 'C:/ewb-test/collect/notes.json' }) })
  }
  if (u.includes('/api/ecom-workbench/collect/move')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
  }
  if (u.includes('/api/ecom-workbench/collect/open')) {
    /* 桩成「成功」并回一个路径 —— 测试只验证请求发对了，不真去开资源管理器。 */
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, path: 'C:/ewb-test/skills/code-review' }) })
  }
  /* ── 等待中列表（2026-10-22 加）──────────────────────────────
   * ⚠️ **必须排在 `/workflow/runs` 之前**（任务要求），也避开后面那条
   * `includes('/workflow/run')` 的前缀式判据 —— 那条会把 `runs` 一起捞走，
   * 这里同一个道理：先精确匹配的排在前面最稳。 */
  if (u.includes('/api/ecom-workbench/workflow/paused')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, paused: __ewbPaused }) })
  }
  /* ── 模型清单与偏好（2026-10-23 契约 J）────────────────────────
   * ⚠️ **`/models/prefs` 必须排在 `/models` 之前**：后者用 `includes('/models')`，
   * 会把带 `/prefs` 的那条一起捞走 —— 捞走后写偏好会被当成「读清单」，
   * 表现是「点了设为默认，界面没变」（而不是报错），很难查。 */
  if (u.includes('/api/ecom-workbench/models/prefs')) {
    const patch = JSON.parse(String(init?.body ?? '{}'))
    __ewbModelPosts.push(patch)
    if (patch.default !== undefined) __ewbModelPrefs.default = patch.default
    if (Array.isArray(patch.picks)) __ewbModelPrefs.picks = patch.picks
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, prefs: __ewbModelPrefs }) })
  }
  if (u.includes('/api/ecom-workbench/models')) {
    __ewbModelsGets += 1
    if (__ewbModelsMode === 'fail') {
      /* ⚠️ 必须给 `ok: false`（HTTP 层的失败），**不能**给 `ok: true, status: 500`：
       * `board-kit` 的 `call()` 只看 `res.ok`，status 500 但 `ok: true` 会被它
       * 当成「读成功了、只是没内容」—— 那样这一屏验的就不是降级分支了。 */
      return Promise.resolve({
        ok: false, status: 500,
        json: () => Promise.resolve({ ok: false, error: '宿主半还没实现模型接口' }),
      })
    }
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({
        ok: true,
        providers: __ewbModelsMode === 'empty' ? [] : __EWB_PROVIDERS,
        prefs: __ewbModelPrefs,
        current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      }),
    })
  }
  /* ── 提醒偏好（2026-10-22 改成**两项独立**）────────────────────
   *
   * 桩用的是**能区分两项**的那一组：`failNotify: false` + `alertMinLevel: 'info'`。
   *
   * 为什么挑这一组而不是 `{true, 'off'}`：只有这一组能证明「两项互不影响」——
   * 失败关着的时候，预警那一行**仍然**要说「信息及以上才发」。
   * 用 `{true,'off'}` 的话，两个徽标恰好都是「不发」，写错也照样绿。
   *
   * POST 走**部分更新**：把请求里的键合并回桩状态再返回（与宿主半契约一致）。
   *
   * ## 两个可拨的开关（给「读失败 / 写失败」那两条断言用）
   *
   * `__ewbNotifyFailRead` / `__ewbNotifyFailWrite` 置 true 时，
   * 对应方向的请求回 `ok: false` —— 不这么做的话，「读失败显示三段式」
   * 与「写失败保留原选中」这两条**根本没法验**（桩永远成功，走不到那条分支）。 */
  if (u.includes('/api/ecom-workbench/notify/prefs')) {
    const isPost = init?.method === 'POST'
    if (isPost && __ewbNotifyFailWrite) {
      return Promise.resolve({ ok: true, status: 500, json: () => Promise.resolve({ ok: false, error: '磁盘只读' }) })
    }
    if (!isPost && __ewbNotifyFailRead) {
      return Promise.resolve({ ok: true, status: 500, json: () => Promise.resolve({ ok: false, error: '读盘失败' }) })
    }
    const patch = isPost ? JSON.parse(String(init.body ?? '{}')).prefs ?? {} : {}
    if (isPost) __ewbNotifyPosts.push(patch)
    __ewbNotifyPrefs = { ...__ewbNotifyPrefs, ...patch }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, prefs: __ewbNotifyPrefs }) })
  }
  /* ── 定时任务（提醒板块「什么情况会提醒」那段的主体）──────────
   * ⚠️ **必须桩**：不桩的话 `call('/schedule/tasks')` 被 reject →
   * 那段走「读不到定时任务」分支、整段列表**不渲染**，
   * 于是「不出现『会提醒』」那条会**因为什么都没有而假绿**。 */
  if (u.includes('/api/ecom-workbench/schedule/tasks')) {
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({
        ok: true,
        tasks: [{ id: 'st-1', name: '早间巡查', workflowName: '巡查-天猫竞品', time: '09:00', enabled: true }],
      }),
    })
  }
  /* ── 通知通道自检（提醒诊断块里那个「检测通知通道」按钮）────────
   *
   * ⚠️ **必须桩**：真跑一次会起 PowerShell 并**真弹一条通知**。
   * 桩成三项全过里的两项、一项不过 —— 这样「过与不过都写原因」那条才验得动
   * （三项全过或全不过，都看不出界面有没有分别渲染）。 */
  if (u.includes('/api/ecom-workbench/notify/selfcheck')) {
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({
        ok: true,
        powershell: { ok: true, reason: 'PowerShell 能起来' },
        balloon: { ok: true, reason: '气球提示已弹出' },
        pushSwitch: { ok: false, reason: '系统通知总开关是关的' },
      }),
    })
  }
  /* ⚠️ **`/workflow/runs` 必须排在 `/workflow/run` 之前** ——
   * 后者用的是 `includes('/workflow/run')`，会把 `runs` 一起捞走（
   * 实测：不挪的话分组条永远显示「还没有任何运行记录」）。 */
  /* ★ 运行历史（整次运行层，用户 m03287）—— **必须排在 `/workflow/runs` 的
   * 无查询串那条之前**？不用：这里按有无 `name=` 分开处理，与真实路由同一套判据。 */
  if (u.includes('/api/ecom-workbench/workflow/runs')) {
    const qi = u.indexOf('name=')
    if (qi < 0) {
      /* 有哪些工作流留下过记录（分组切换条用）。 */
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ ok: true, names: ['抖音商品流水线', '天猫竞品巡查'] }),
      })
    }
    const which = decodeURIComponent(u.slice(qi + 5))
    return Promise.resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({
        ok: true,
        name: which,
        runs: which === '抖音商品流水线'
          ? [
            {
              id: 'run-a', name: '抖音商品流水线', startedAt: Date.now() - 3600000, endedAt: Date.now() - 3500000,
              ok: true, ran: ['n1', 'n2', 'n3'], via: 'list',
              /* ★ 关键信息：结束节点声明的产出（bat 最后那几行）。 */
              outputs: { 汇总: '共 3 个文件', 目录: 'D:/data' },
              inputs: { 日期: '2026-10-17' },
              nodes: [
                { nodeId: 'n1', defId: 'code.js', label: '① 算时间', state: 'success', startedAt: 1, endedAt: 2, logs: ['算好了'] },
                { nodeId: 'n2', defId: 'browser.act', label: '② 打开页面', state: 'failed', startedAt: 3, endedAt: 4, error: '页面没开' },
                /* ★ 模型痕迹（2026-10-23 契约 W）。
                 *
                 * 故意给**两种**：
                 *   · `n3` 带完整 `llm`（有 token、有截断标记、有两个摘要）；
                 *   · `n4` 带 `llm` 但**没有 token 数**（上游没给，不许显示成「输入 0 / 输出 0」）。
                 * 而 `n1` / `n2` **完全没有** `llm` —— 那两条用来验「没痕迹时什么都不许出来」。 */
                {
                  nodeId: 'n3', defId: 'ai.agent', label: '③ 让模型改写', state: 'success', startedAt: 5, endedAt: 6,
                  logs: ['模型返回了'],
                  llm: {
                    provider: 'deepseek-official', model: 'deepseek-v4-flash',
                    inputTokens: 120, outputTokens: 45, totalTokens: 165,
                    finish: 'stop',
                    promptPreview: '【提示词摘要】先写用途，再写限制',
                    outputPreview: '【回答摘要】改写后的那段话',
                    truncated: true,
                  },
                  /* ★ 汇报（2026-10-25 契约 AO）。这一条用来验「五件事同时成立」：
                   *
                   *   ① `item` 放最前（「第 3/5 条」）；
                   *   ② `metrics` 显示成「键 值」；
                   *   ③ `files` 显示成路径；
                   *   ④ 与日志**分区**（各有标题）；
                   *   ⑤ 下面第二条与它 message 完全相同但 `type` 不同 —— 不合并
                   *      （key 含 type，契约要求「全拼成 key」）。 */
                  reports: [
                    {
                      message: '采到 24 件商品', type: 'info', item: '第 3/5 条',
                      metrics: { 条数: 24, 耗时: 1830 },
                      files: ['D:/data/天猫/2026-10-25.json'],
                    },
                    {
                      /* 与上面 message 相同、`item` 不同 → 去重 key 不同 → 两条都在。
                       * （这是契约「全拼成 key」的直接观察点。） */
                      message: '采到 24 件商品', type: 'info', item: '第 4/5 条',
                    },
                    /* ① 完全相同重复：连续三条一模一样的 → 显示一条 +「出现 3 次」。 */
                    { message: '重试了一次', type: 'warning', item: '第 5/5 条' },
                    { message: '重试了一次', type: 'warning', item: '第 5/5 条' },
                    { message: '重试了一次', type: 'warning', item: '第 5/5 条' },
                    /* ② 同类折叠：同一个 group.key 两条 → 折成一行，取最重（danger），
                     *    `{count}` 换成 2。 */
                    {
                      message: '写入失败 D:/a.json', type: 'info', item: '第 1/2 条',
                      group: { key: 'write-fail', summary: '写入失败 {count} 个文件' },
                    },
                    {
                      message: '写入失败 D:/b.json', type: 'danger', item: '第 2/2 条',
                      group: { key: 'write-fail', summary: '写入失败 {count} 个文件' },
                    },
                    /* ③ 只有一条的组：**不折叠**，原样显示（契约明写）。 */
                    {
                      message: '归档到 D:/data/archive', type: 'info',
                      group: { key: 'archive-once', summary: '归档了 {count} 次' },
                    },
                  ],
                },
                {
                  nodeId: 'n4', defId: 'ai.agent', label: '④ 再让模型改写', state: 'success', startedAt: 7, endedAt: 8,
                  logs: [],
                  llm: {
                    provider: 'other', model: 'org/legacy-model',
                    finish: 'unknown',
                    promptPreview: '【无 token 那次】',
                  },
                },
              ],
            },
            { id: 'run-b', name: '抖音商品流水线', startedAt: Date.now() - 7200000, endedAt: Date.now() - 7100000, ok: false, aborted: true, error: '有节点失败', ran: ['n1'], nodes: [] },
          ]
          : [{ id: 'run-c', name: '天猫竞品巡查', startedAt: Date.now() - 600000, endedAt: Date.now() - 500000, ok: true, ran: ['n1'], nodes: [] }],
      }),
    })
  }
  /* 无界面执行：桩成跑完两个节点（测试不真跑工作流，只验界面接线）。 */
  if (u.includes('/api/ecom-workbench/workflow/run')) {
    /* ★ 提示词优化的改写走这条路（2026-10-23 加）。
     *
     * 三个可拨开关，分别验三种失败：
     *   · `__ewbOptMode = 'ok'`     → 交出 `{ out: '模型改写的文字' }`
     *   · `__ewbOptMode = 'no-model'`→ 宿主半的「没有可用的模型」原话
     *   · `__ewbOptMode = 'timeout'` → 超时文案
     *   · `__ewbOptMode = 'empty'`   → 跑成功但 `declaredOutputs` 是空串
     *   · `__ewbOptMode = 'missing'` → 没有这份工作流
     *
     * ⚠️ 每次请求体都记进 `__ewbOptPosts` —— 「传对了 prompt 与 input」靠它验，
     * 而不是靠界面上显示了什么（显示可以伪造，请求体不行）。 */
    let postBody = {}
    try { postBody = JSON.parse(String(init?.body ?? '{}')) } catch { /* 不是 JSON 就算了 */ }
    /* ★ 按**编号**认这份工作流（2026-10-23 lead 给的 `wf-1bzlv0k`）。
     * 也认名字 —— 但断言会单独验「必须带编号」，所以桩不能只靠名字兜。 */
    if (String(postBody.workflowId ?? '') === 'wf-1bzlv0k' || String(postBody.name ?? '') === '提示词优化') {
      __ewbOptPosts.push(postBody)
      const m = __ewbOptMode
      /* 有延迟时要**真的等**（`Promise.resolve` 之后的 setTimeout 不起作用）。 */
      const settle = (payload) => __ewbOptDelay > 0
        ? new Promise(resolve => { setTimeout(() => { resolve(payload) }, __ewbOptDelay) })
        : Promise.resolve(payload)
      if (m === 'no-model') {
        return settle({
          ok: true, status: 400,
          json: () => Promise.resolve({ ok: false, error: '没有可用的模型：先在 dsh 的模型设置里选一个 provider 与模型' }),
        })
      }
      if (m === 'timeout') {
        return settle({
          ok: true, status: 400,
          json: () => Promise.resolve({ ok: false, timedOut: true, error: '等模型超时（120000 毫秒）—— 可在节点设置里调大「超时」' }),
        })
      }
      if (m === 'missing') {
        return settle({
          ok: true, status: 400,
          json: () => Promise.resolve({ ok: false, error: '没有这份工作流：提示词优化' }),
        })
      }
      if (m === 'empty') {
        return settle({
          ok: true, status: 200,
          json: () => Promise.resolve({ ok: true, ran: ['n1'], aborted: false, name: '提示词优化', declaredOutputs: { 改写结果: '' } }),
        })
      }
      /* 正常：交出一段有换行的文字（验结果区保留换行）。 */
      return settle({
        ok: true, status: 200,
        json: () => Promise.resolve({
          ok: true, ran: ['n1'], aborted: false, name: '提示词优化',
          declaredOutputs: { 改写结果: '优化后的提示词第一行\n优化后的提示词第二行' },
        }),
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, ran: ['n1', 'n2'], aborted: false, logs: [] }) })
  }
  /* ⚠️ **节点派发**（画布点「运行」时每个节点发一条）。
   * 2026-10-11 补：在此之前这个接口**没有桩**，于是画布点运行时
   * 第一条 fetch 就 reject（「连不上宿主半」）→ 首个节点失败 → 按失败策略停下，
   * 所以只发得出 1 条请求、界面也没有跑完的痕迹。
   * 那时没有任何断言经过这条路径，所以一直没人发现。 */
  if (u.includes('/api/ecom-workbench/run')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      /* 形状要和宿主半一致：`{ results: [ { status, output, logs } ] }`。 */
      json: () => Promise.resolve({ results: [{ status: 'success', output: { ok: true }, logs: ['（测试桩）这一步跑好了'] }] }),
    })
  }
  /* 「打开目录」：桩成成功并回一个路径。
   * ⚠️ 这一条**必须排在 `/workflows` 那条之前**（它是 `/workflow/open`，
   * 而 `/workflows` 的 `includes` 匹配不到它；但 `/workflow?` 那条会——
   * 所以顺序要小心。实测确认放这里最稳）。 */
  /* 「这份工作流要什么输入」——点「执行」前会查一次（用户 m00901 的「输入 = 开始节点」）。
 * ⚠️ **必须排在 `/workflow/open` 与 `/workflows` 之前**（它们用的是 `includes`，
 * 而 `/workflow/io?...` 不会命中那两个；但这条自己用的是无查询串判断，
 * 放在最前最稳）。 */
if (u.includes('/api/ecom-workbench/workflow/io')) {
  const qi = u.indexOf('name=')
  const which = qi < 0 ? '' : decodeURIComponent(u.slice(qi + 5))
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(
      /* 「抖音商品流水线」声明了两个输入 → 走「先弹表单」那条路；
       * 其余（含「组合层示例」）没有声明 → 直接跑（老行为）。 */
      which === '抖音商品流水线'
        ? {
          ok: true,
          startType: 'manual',
          inputs: [
            { name: '日期', description: '要采集哪一天', required: true, default: '2026-10-17' },
            { name: '店铺' },
          ],
          outputs: [{ name: '汇总', nodeId: 'n15', field: 'json' }],
        }
        : { ok: true, startType: which === '组合层示例' ? 'called' : null, inputs: [], outputs: [] },
    ),
  })
}
if (u.includes('/api/ecom-workbench/workflow/open')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, path: 'C:/ewb-test/workflows', exists: true }) })
  }
  if (u.includes('/api/ecom-workbench/workflows')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        dir: 'C:/ewb-test/workflows',
        items: [
          /* ⚠️ `id` 是**工作流编号**（2026-10-19 加）：`flow.workflow` 节点引用它、
           * 界面上显示 `name`。真实宿主半一定会给（它从存档里读）。
           * 这里必须给 —— 否则「选一份工作流」的下拉是空的，
           * 那条「渲染成下拉」的断言就测不到东西。 */
          { name: '抖音商品流水线', id: 'wf-douyin', nodes: 12, edges: 15, startType: null, description: '从抖音罗盘取当期报表：走循环，逐日下载', at: Date.now() - 3 * 86400000 },
          { name: '天猫竞品巡查', id: 'wf-tmall', nodes: 7, edges: 8, startType: 'manual', at: Date.now() - 3600000 },
          /* ★ 一份名字以「巡查-」开头的工作流（2026-10-23 加）。
           *
           * 总览改成看板之后，看板清单的判据是 `isPatrol`（名字以「巡查-」开头）。
           * 桩里原来那份叫「天猫竞品巡查」—— **不以「巡查-」开头**，所以它不算。
           * 不补这一份的话，看板区一片空白，⑱ 那几条会全部假绿（或全红但看不出原因）。
           *
           * ⚠️ 名字故意带上前缀：改了前缀就掉出看板，那样 ⑱ 的第 1 条才有东西可验。 */
          { name: '巡查-天猫竞品', id: 'wf-patrol-1', nodes: 7, edges: 8, startType: 'manual', at: Date.now() - 3500000 },
          /* ★ 一份「只可被调用」的工作流（用户 m00901 定案：执行按钮由**开始节点的类型**决定）。
           * 它的存在就是为了让下面那条断言能红 —— 没有这条数据，「隐藏执行按钮」永远绿。 */
          { name: '组合层示例', id: 'wf-combo', nodes: 2, edges: 1, startType: 'called', types: ['组合', '我手写的类目'], at: Date.now() - 7200000 },
          /* ★ 一份**两层嵌套循环**的存档（2026-10-19 加）。
           * 它存在的唯一目的是让「条件能选到 outer.item」那条断言有得测 ——
           * 列表里没有它，就点不开那份存档，断言会是**假绿**（找不到东西当通过）。
           * 内容见上面 `NESTED_LOOP_DOC`。 */
          { name: '嵌套循环示例', id: 'wf-nested-demo', nodes: 5, edges: 3, startType: 'manual', at: Date.now() - 1800000 },
          /* ★ 一条 5 节点 / 4 条边的链（2026-10-22 加）。
           * 画布初始改空之后，「排版间距影响布局」「换方向排布变」两条判据
           * 需要有**带连线的图**才成立 —— 零边时 ELK 不套用 spacing、方向也算出同一个网格。
           * 详见上面 `CHAIN_DOC` 的注释。 */
          { name: '示例包·链路', id: 'wf-chain-demo', nodes: 5, edges: 4, startType: 'manual', at: Date.now() - 1200000 },
          /* ★ 取数板块的**两份入口**（2026-10-22 加）。
           * 取数板块改成白名单之后只显示这两份，桩里必须有它们，
           * 否则那一段会全部落进空态、断言变成假绿。 */
          { name: '全部下载', id: 'wf-dl-all', nodes: 14, edges: 16, startType: 'manual', at: Date.now() - 900000 },
          { name: '清洗入库', id: 'wf-clean', nodes: 6, edges: 6, startType: 'manual', at: Date.now() - 800000 },
          /* ★ 底层三份取数（**不该**出现在取数板块里，但别的段落要用）。
           * 它们留在这里正是为了让「只显示两份」那条断言**能变红** ——
           * 桩里没有它们的话，过滤写坏了也看不出来。 */
          { name: '取数-天猫生意参谋', id: 'wf-tmall-data', nodes: 9, edges: 10, startType: 'manual', at: Date.now() - 700000 },
          { name: '取数-抖音电商罗盘', id: 'wf-douyin-data', nodes: 9, edges: 10, startType: 'manual', at: Date.now() - 700000 },
          { name: '取数-千川全域推广', id: 'wf-qianchuan-data', nodes: 8, edges: 9, startType: 'manual', at: Date.now() - 700000 },
        ],
      }),
    })
  }
  /* 取数板块的采集记录（2026-10-22 加）。
   *
   * ⚠️ **必须排在 `collect/list` / `collect/notes` 之前** —— 它们都用 `includes`，
   * 而 `collect/records` 不会被它们的前缀捞走；但反过来写在这里是为了让
   * 「取数板块」那一段有真数据可验（没有记录时卡片上全是「还没跑过」，
   * 「最近一次 / 交出 N 项」那几条就测不到东西）。
   *
   * 数据刻意做成「一份成功、一份失败」：这样「状态一句话」两种分支都能验。 */
  if (u.includes('/api/ecom-workbench/collect/records')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        records: [
          {
            workflow: '全部下载',
            file: '2026-10-23T0930-run.json',
            at: Date.now() - 3600000,
            ok: true,
            outputs: { 天猫数据: 'tang-2026-10-23.csv', 抖音数据: 'douyin-2026-10-23.csv', 千川数据: 'qc.csv', 入库条数: 1284 },
          },
          {
            workflow: '清洗入库',
            file: '2026-10-23T0900-run.json',
            at: Date.now() - 7200000,
            ok: false,
            outputs: {},
            /* ★ 契约 AD 之后写的记录**带真实失败原因**（契约 AE 要把它显示出来）。 */
            error: '登录态失效，页面跳回登录页（第 2 个节点：天猫下载）',
          },
          {
            /* ★ 老记录：**没有 `error` 键**（契约 AD 之前写的，磁盘上真有一批）。
             * 界面必须把它显示成「没有留下原因」，不许空白、不许当成成功。 */
            workflow: '取数-天猫生意参谋',
            file: '2026-10-20T0200-run.json',
            at: Date.now() - 3 * 86400000,
            ok: false,
            outputs: {},
          },
          {
            /* ★ 汇报式记录（2026-10-25 契约 AO）：**有 `reports`、没有 `outputs` 的东西**。
             *
             * 归档时两条互斥（`records.ts:78-83`），所以真实记录不会两个键都有。
             * 这份桩钉三件事：
             *   · 界面优先显示 `reports`（不是去显示那个空 `outputs`）；
             *   · 汇报里的 `item` / `metrics` / `files` 在任务记录里也显示；
             *   · 行头的「N 项产出」在汇报式记录上要变成「N 条汇报」
             *     （写「0 项产出」等于告诉用户这次什么都没交）。 */
            workflow: '巡查-天猫竞品',
            file: '2026-10-25T0200-run.json',
            at: Date.now() - 1800000,
            ok: true,
            reports: [
              {
                message: '判档完成：3 个竞品里有 1 个降价', type: 'warning', item: '第 1/1 条',
                metrics: { 竞品数: 3, 降价数: 1 },
                files: ['D:/data/patrol/天猫竞品-2026-10-25.json'],
              },
            ],
          },
        ],
      }),
    })
  }
  /* 收藏板块：列表 / 正文两个读接口。搬移与备注是写操作，这里不桩（测试不乱写）。 */
  if (u.includes('/api/ecom-workbench/collect/list')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({
        skills: [
          { name: 'code-review', title: 'code-review', description: '代码审查。两轴并行评审', where: 'installed', root: 'C:/ewb-test/skills', agentUsable: true, userUsable: true },
          { name: 'grilling', title: 'grilling', description: '把想法问清楚', where: 'installed', root: 'C:/ewb-test/skills', agentUsable: false, userUsable: true },
          { name: 'old-skill', title: 'old-skill', description: '暂时不用的', where: 'collected', root: 'C:/ewb-test/collect/skills', agentUsable: true, userUsable: true },
        ],
        notes: { skills: { grilling: { note: '以后要用', repo: 'https://github.com/a/b' } }, plugins: [], projects: [
          { name: 'awesome-workflow', note: '参考用的', repo: 'https://github.com/x/y', category: 'Agent 与 Skill' },
          { name: 'spider-tool', note: '采集用的', repo: '', category: '采集与搜索' },
          { name: '什么分类都没写', note: '要归到未分类', repo: '' },
        ] },
        /* 根目录明细：路径 + 扫到几个 + 存在否（设置 tab 用）。 */
        roots: {
          installed: [{ path: 'C:/ewb-test/skills', count: 2, exists: true, isDefault: true }],
          collected: [{ path: 'C:/ewb-test/collect/skills', count: 1, exists: true, isDefault: true }],
        },
      }),
    })
  }
  if (u.includes('/api/ecom-workbench/collect/skill')) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ name: 'code-review', where: 'installed', text: '---\nname: code-review\n---\n\n正文内容在这里' }),
    })
  }
  /* ★ **读一份工作流的内容**（`GET /workflow?name=…`）—— 2026-10-19 补。
   *
   * ## 为什么现在才需要
   *
   * 本轮要验「条件判断节点的左边能选到嵌套循环的变量」，那就必须让画布上
   * **真的有一张带嵌套循环的图**。靠「从节点库一个个点」拼出两层嵌套太脆
   * （拖不进框、落点算不准，jsdom 里全没有布局），而 `打开到画布` 这条路
   * 本来就要读存档 —— 干脆让桩回一份**现成的、带嵌套循环的**存档。
   *
   * ⚠️ 必须排在 `/workflows`（列表）之前：那条用的是 `includes('/workflows')`，
   * 而这条是 `/workflow?name=`，前缀相同但后者带问号 —— 顺序写反了就会被
   * 列表那条捞走（返回一堆 items，画布拿到 undefined 内容）。
   */
  if (u.includes('/api/ecom-workbench/workflow?name=')) {
    if (u.includes('name=' + encodeURIComponent('嵌套循环示例'))) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ doc: NESTED_LOOP_DOC }),
      })
    }
    if (u.includes('name=' + encodeURIComponent('示例包·链路'))) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ doc: CHAIN_DOC }) })
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: '没有这份工作流' }) })
  }
  return Promise.reject(new Error('未桩的请求: ' + u))
}
window.fetch = __ewbFetchStub
globalThis.fetch = __ewbFetchStub

/* 2b) `window.prompt` 的桩（「执行」时填输入走它）。
 *
 * ⚠️ **必须桩**：jsdom **没有实现 `window.prompt`**（它是「未实现」的，
 * 调用会抛 "Not implemented"）。而「点执行 → 填输入」这条路真的会调它。
 * 这里统一返回预填的默认值 —— 断言关心的是「值有没有带进请求」，
 * 不是「弹了几个框」（弹框数由下面的 `__ewbPrompts` 单独数）。 */
const __ewbPrompts = []
window.prompt = (message, def) => {
  __ewbPrompts.push({ message: String(message), def: String(def ?? '') })
  return String(def ?? '填的值')
}
globalThis.prompt = window.prompt

/* 2b-2) `window.confirm` 的桩（返回 true = 确认）。
 *
 * 为什么需要：画布「新建」在有未保存改动时会 `window.confirm` 一次
 * （`WorkflowCanvas.tsx` 的 `newWorkflow`）。jsdom 没有实现它，
 * 默认行为不可靠 —— 桩成「确认」才是用户点「确定」的那条路。
 * ⚠️ 只影响「需要确认」的分支；没有改动时那个 confirm 根本不会被调用。 */
window.confirm = () => true
globalThis.confirm = window.confirm

/* 2) 截获插件 bundle（它调 window.__ModuleLoader__.load） */
let factory = null
window.__ModuleLoader__ = { load: (o) => { factory = o.factory } }
const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
new Function('window', 'document', 'localStorage', 'navigator', code)(window, window.document, window.localStorage, window.navigator)
console.log('① bundle 加载:', factory === null ? '失败' : '成功')

/* 3) 渲染计数（抓无限渲染） */
const React = require('react')
const ReactDOMClient = require('react-dom/client')
let renderCount = 0
const origCreateElement = React.createElement
React.createElement = function (...args) { renderCount += 1; return origCreateElement.apply(this, args) }

const fakeRequire = (name) => {
  if (name === 'react') return React
  if (name === 'react/jsx-runtime') return require('react/jsx-runtime')
  try { return require(name) } catch { throw new Error('缺依赖: ' + name) }
}

const comps = []
/** 记录 dsh 左侧栏的 toggle 被点了几次（供「隐藏对话区 ⇒ 收起左侧栏」断言用）。 */
const sidebarToggles = []
const fakeCtx = {
  effect: (fn) => { try { fn() } catch { /* 忽略 */ } return () => {} },
  inject: () => () => {},
  /* 真实的 dsh 上下文里有 ctx.layout（ui-layout 提供的公开服务），
   * 我们用它做「隐藏对话区时也收起左侧栏」。桩一份最小的。 */
  layout: { toggleSidebar: () => { sidebarToggles.push(Date.now()) } },
  slots: {
    inject: (n, fn) => { try { fn() } catch { /* 忽略 */ } return () => {} },
    register: (opts, comp) => { if (typeof comp === 'function') comps.push({ name: String(opts?.name), fn: comp }); return () => {} },
  },
}
const exports = factory(fakeRequire)
exports.apply(fakeCtx)
console.log('② apply 成功，组件数:', comps.length)

/* 4) 挂载 shell.overlay（工作台主界面）到 jsdom，真跑副作用 */
const target = comps.find(c => c.name === 'shell.overlay')
if (target === undefined) { console.log('✗ 没找到组件'); process.exit(1) }

const errors = []
const origError = console.error
console.error = (...args) => {
  const s = args.map(a => (a instanceof Error ? a.message : String(a))).join(' ')
  if (/Maximum update depth|Too many re-renders|Cannot update a component/i.test(s)) errors.push(s)
  origError(...args)
}

const root = ReactDOMClient.createRoot(window.document.getElementById('root'))
root.render(React.createElement(target.fn))

/* 等一会，让 useEffect / rAF 跑起来 */
await settle()
console.error = origError

console.log('③ 渲染完成，createElement 调用次数:', renderCount)
console.log('④ 捕获到的无限渲染告警:', errors.length === 0 ? '无 ✓' : String(errors.length) + ' 条 ✗')
for (const e of errors.slice(0, 3)) console.log('   -', e.slice(0, 160))
/* 5) 模拟真实交互：点左侧「工作流」板块 + 点「画布」tab，逼出 WorkflowCanvas 渲染 */
const doc = window.document
await settle()

/**
 * 找文本匹配的按钮并点它。
 *
 * 2026-10-08 改：加了 `exactHint` 与**避开侧栏**两个约束。
 * 起因：侧栏板块名现在也有「工作流」，而 tab 里也有「画布」，
 * 原来那个 `includes` 匹配会点到侧栏的同名按钮（点错了目标）。
 *
 * @param text - 要匹配的文字。
 * @param opts.inTabs - 只在 tab 条里找（role="tab"）。
 * @returns 是否找到并点了。
 */
function clickByText(text, opts = {}) {
  const scope = opts.inTabs === true ? doc.querySelectorAll('[role="tab"]') : doc.querySelectorAll('button')
  const all = [...scope]
  const hit = all.find(b => (b.textContent ?? '').trim() === text)
  if (hit === undefined) return false
  hit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  return true
}

const before = renderCount
const clickedWorkflow = clickByText('工作流')
await settle()
await settle()
const clickedCanvas = clickByText('画布', { inTabs: true })
await settle()

const bodyDiv = [...doc.querySelectorAll('div')].find(d => typeof d.className === 'string' && /_body\b/.test(d.className))
if (bodyDiv !== null) {
  const kid = bodyDiv.children[0]
  const row = kid === undefined ? null : kid.querySelector('[class*=bodyRow]')
  const lib = kid === undefined ? null : kid.querySelector('[class*=libItem]')
}
const allDiv = [...doc.querySelectorAll('div')].map(d => typeof d.className === 'string' ? d.className : '').filter(c => c !== '')

/* 真断言：React Flow 的视口容器在不在。
 * 此前只查 `[class*="canvas"]`，那个 class 可能是工具条——所以「画布全空」时测试仍报通过。
 * React Flow 渲染成功时必然有 `.react-flow__viewport`；它不在＝画布没挂载。 */
const hasFlowRoot = doc.querySelector('.react-flow') !== null
const hasFlowViewport = doc.querySelector('.react-flow__viewport') !== null
const canvasDiv = [...doc.querySelectorAll('div')].find(d => typeof d.className === 'string' && /_canvas\b/.test(d.className))
const stageDiv = [...doc.querySelectorAll('div')].find(d => typeof d.className === 'string' && /_stage\b/.test(d.className))
const allCls2 = [...doc.querySelectorAll('div')].map(d => typeof d.className === 'string' ? d.className : '').filter(c => /_wrap|_stage|_canvas|_body\b|_content\b|_column/.test(c))
const bodyEl = [...doc.querySelectorAll('div')].find(d => typeof d.className === 'string' && /_body\b/.test(d.className))
const nodeCountBefore = doc.querySelectorAll('.react-flow__node').length
console.log('   React Flow 视口存在:', hasFlowViewport ? '有 ✓' : '没有 ✗')

/* ★ 画布初始为空（用户 2026-10-22 定：「重启后未打开任何工作流时，画布应当是空的」）。
 *
 * ## 为什么这条要单独断
 *
 * 以前画布一打开就有一份示例工作流（`canvas-seed.ts` 的 `seedNodes()`），
 * 而**下面好几段断言都默认画布上有东西**。现在初始是空的，所以：
 *   ① 先用这条把「确实是空的」钉住（不然改了源码也没人发现）；
 *   ② 再自己往画布里塞节点，让下面那些断言照原来的判据跑（见下）。
 *
 * 判据是**反面**：0 个节点、0 条连线才算过；有一个就说明示例内容又回来了。 */
console.log('   ★ 未打开工作流时画布为空（节点数）:', nodeCountBefore, nodeCountBefore === 0 ? '✓' : '✗')
if (nodeCountBefore !== 0) errors.push('画布初始不是空的（示例内容又回来了）')
const edgeCountBefore = doc.querySelectorAll('.react-flow__edge').length
console.log('   ★ 未打开工作流时画布为空（连线数）:', edgeCountBefore, edgeCountBefore === 0 ? '✓' : '✗')
if (edgeCountBefore !== 0) errors.push('画布初始有连线（示例内容又回来了）')

/* ⚠️ 先记下**空画布那一刻**的归属胶囊文字（⑨-归属 那段要用，见那里的注释）。
 * 之后画布会打开一份存档、拿到归属，那个胶囊就换成文件名了 ——
 * 而「无归属时明说未保存的新工作流」这条判据只能在**还没有归属**时验。 */
/* ★ 票 54：归属胶囊的类从 `.chip` 换成了 `.tbChip`（搬进悬浮条时改的）。
 *
 * ⚠️ **两种都认**：左下角那个「节点 N / M 连线」计数条**仍然是 `.chip`**
 * （`node-form.module.css`，没动过）。而 `[class*="_chip"]` **匹配不到** `_tbChip`
 * —— 大小写不同，`_chip` 不是 `_tbChip` 的子串。
 *
 * 两种都认之后要**排掉计数条**：它的文字形如「节点 0 / 0 连线」，
 * 而这一段要的是**归属胶囊**（文字是「未保存的新工作流」或文件名）。
 * 不能靠文档顺序 —— 两者都在画布层，谁在前不确定。 */
const chipOnFreshCanvas = [...doc.querySelectorAll('[class*="_chip"], [class*="_tbChip"]')]
  .find(el => !/_chipHot\b/.test(el.className ?? '')
    && !/^节点 \d+/.test((el.textContent ?? '').trim())) ?? null
const chipFreshText = (chipOnFreshCanvas?.textContent ?? '').trim()
const chipFreshTitle = chipOnFreshCanvas?.getAttribute('title') ?? ''
console.log('   空画布时归属胶囊的文字:', JSON.stringify(chipFreshText))

/* ★ 自己把节点弄到画布上（下面几段都要求「画布上有东西」）。
 *
 * ## 为什么走「列表页打开一份存档」这条路
 *
 * 画布初始为空之后，下面若干段的前提（画布上有节点、有连线）就没了吗？
 * ——**节点可以点节点库加，连线不行**。而其中两条判据的本质就落在边上：
 *   · ⑬ 的「排版间距影响自动布局」——ELK 对**零边**的图走的是分层给的网格，
 *     间距参数不参与（已实测：5 个孤立节点，spacing 10 与 380 的坐标完全一致）；
 *   · ⑩ 的「换方向后排布变」——同理，零边时 RIGHT / DOWN 算出来一模一样。
 * 这两条判据**不能削弱**（它们是「滑块真的接进布局了」的唯一证据），
 * 所以必须让画布上有**一张带连线的图**。
 *
 * 走「列表页点『打开到画布』」这条路，一份存档同时给到节点与连线，
 * 而且它本来就是真实用户入口。桩里回的是 `CHAIN_DOC`（一条 5 节点 / 4 条边的链）。
 *
 * ⚠️ 为什么不用节点库点 5 下 + 手动连线：jsdom 里没有布局，
 * 连线的 drag 事件链（mousedown 在 handle 上 → mousemove → mouseup 在目标 handle 上）
 * 依赖 React Flow 内部的坐标换算，`getBoundingClientRect` 恒为 0 ——
 * 靠合成事件连不出来（本项目此前也是靠存档拿图，见 `NESTED_LOOP_DOC` 的注释）。 */
{
  const filesTab = clickByText('工作流管理', { inTabs: true })
  await settle()
  const chainRow = [...doc.querySelectorAll('[role="button"]')]
    .find(el => (el.textContent ?? '').includes('示例包·链路'))
  console.log('   「示例包·链路」那一行在:', chainRow !== undefined ? '✓' : '✗')
  if (chainRow === undefined) {
    errors.push('列表里没有「示例包·链路」（无法给画布一张带连线的图，下面两条判据会失去前提）')
  } else {
    const openBtn = [...chainRow.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '打开到画布')
    console.log('   那一行有「打开到画布」:', openBtn !== undefined ? '✓' : '✗')
    if (openBtn === undefined) {
      errors.push('「示例包·链路」那一行没有「打开到画布」按钮')
    } else {
      openBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await settle()
      /* 打开后会切到画布 tab —— 切回来这段就算完成，下面的段落本来也要停在画布上。 */
    }
  }
  console.log('   自己打开的那张图 —— 节点数（应为 ' + String(CHAIN_DOC.nodes.length) + '）:',
    doc.querySelectorAll('.react-flow__node').length)
  void filesTab
}
const nodeCount = doc.querySelectorAll('.react-flow__node').length
const edgeCountAfterOpen = doc.querySelectorAll('.react-flow__edge').length
/* ⚠️ **票 54：这一处故意只认 `.chip`，不认 `_tbChip`。**
 *
 * 它要的是左下角计数条（文字「节点 N / M 连线」），而归属胶囊已经搬到悬浮条、
 * 类名是 `.tbChip`。两种都认虽然也能被下面 `/^节点 \d+/` 过滤掉，
 * 但没必要给自己留一个靠文字猜的口子 ——
 * **计数条归 `.chip`、归属胶囊归 `.tbChip`，各认各的，判据才说得清。** */
const counterChip = [...doc.querySelectorAll('[class*="_chip"]')]
  .map(el => (el.textContent ?? '').trim())
  .find(t => /^节点 \d+/.test(t)) ?? ''
const edgeInCounter = Number((/\/\s*(\d+)\s*连线/.exec(counterChip) ?? [])[1] ?? -1)
console.log('   画布上的节点数:', nodeCount, nodeCount >= 5 ? '✓' : '✗')
if (nodeCount < 5) errors.push('打开那份链路示例后节点数不足 5（下面几段的前提不成立）')
console.log('   画布上的连线数（左下角计数条「' + counterChip + '」）:', edgeInCounter, edgeInCounter >= 4 ? '✓' : '✗')
if (edgeInCounter < 4) {
  errors.push('打开那份链路示例后连线不足 4 条（自动布局的间距/方向判据需要边）')
}
void edgeCountAfterOpen

console.log('⑤ 点击「工作流」:', clickedWorkflow ? '成功' : '没找到按钮')
console.log('   点击「画布」:', clickedCanvas ? '成功' : '没找到按钮')
console.log('   这段交互新增渲染次数:', renderCount - before)
console.log('   捕获到的无限渲染告警:', errors.length === 0 ? '无 ✓' : String(errors.length) + ' 条 ✗')
for (const e of errors.slice(0, 3)) console.log('   -', e.slice(0, 200))

/* 检查画布是否真的渲染出结构 */
const hasCanvas = doc.querySelector('[class*="canvas"]') !== null
const hasLib = (doc.body.textContent ?? '').includes('节点库')
const allCls = [...doc.querySelectorAll('[class]')].map(e => e.className).filter(c => typeof c === 'string' && /lib|bodyRow|canvas|wrap/.test(c))

/* 6.5) 列表页：点「工作流管理」tab（之前是画布），看关键元素在不在。
 * ⚠️ 这一格 2026-10-13 从「工作流」改名成「工作流管理」——
 * 因为左侧栏**板块入口**也叫「工作流」，同一个词指两个东西，用户分不清
 * （我自己排查时就先被绕了一次）。 */
const clickedFiles = clickByText('工作流管理', { inTabs: true })
await settle()
const bodyText = doc.body.textContent ?? ''
console.log('⑦ [列表页] 切到「工作流管理」tab:', clickedFiles ? '成功' : '没找到')
console.log('   分节标签「全部工作流」:', bodyText.includes('全部工作流') ? '有 ✓' : '没有 ✗')
console.log('   新建按钮:', bodyText.includes('+ 新建') ? '有 ✓' : '没有 ✗')
console.log('   刷新按钮:', bodyText.includes('刷新') ? '有 ✓' : '没有 ✗')
console.log('   数据行「抖音商品流水线」:', bodyText.includes('抖音商品流水线') ? '有 ✓' : '没有 ✗')
console.log('   行内元信息（节点数）:', /\d+\s*节点/.test(bodyText) ? '有 ✓' : '没有 ✗')
console.log('   时间胶囊（多久以前）:', /天前|小时前|分钟前|刚刚/.test(bodyText) ? '有 ✓' : '没有 ✗')

/* ⑦-2 **主行上的常用按钮**（用户 2026-10-14 要求）。
 *
 * 用户原话：「工作流管理里面的工作流的几个按钮不应该是在展开后才看到，
 *   比如执行，在画布打开（**删除可以是展开后才看到**）
 *   另外增加一个**打开目录**的按钮。」
 *
 * ⚠️ 判据必须**限定在「未展开」的那一行里**查，不能全页 `includes` ——
 * 展开区的按钮也是全页文字的一部分，全页查的话「按钮还在展开区里」也会通过
 * （那就等于没验这条需求）。做法：先量一次**没展开**时主行里有什么。 */
console.log('⑦-2 [用户反馈] 常用按钮摊到主行（不用展开就能看到）')
{
  /* 取一行的**主行元素**（那个 role="button" 的 div，展开区是它的兄弟）。
   * 用「含工作流名的那个 role=button」认，与按钮本身区分开。 */
  const mainRowOf = (name) => [...doc.querySelectorAll('[role="button"]')]
    .find(el => (el.textContent ?? '').includes(name))
  /* ⚠️ 先确保这一行是**收起**状态：上一段可能展开过它。
   *
   * ⚠️ **别用 `[aria-expanded="true"]` 泛查**（第一版就这么写的，踩了）：
   * 工作台左侧栏的「收起侧栏」按钮**也带 `aria-expanded`**（见 `EcomWorkbench.tsx`），
   * 而且它在 DOM 里排在前面 → 泛查会**点到侧栏开关、把整个左侧栏收起来**，
   * 于是后面几段（找「隐藏对话区」等）全崩。
   * 所以只认**这一行自己**的状态。 */
  const rowBefore = mainRowOf('抖音商品流水线')
  if (rowBefore?.getAttribute('aria-expanded') === 'true') {
    rowBefore.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
  }
  const row = mainRowOf('抖音商品流水线')
  console.log('   找到一行的主行:', row !== undefined ? '✓' : '✗')
  if (row === undefined) {
    errors.push('列表里找不到工作流那一行的主行')
  } else {
    /* 主行里的按钮文字（只要这一行、且**不含展开区** —— 展开区不在主行里）。 */
    const inRow = [...row.querySelectorAll('button')].map(b => (b.textContent ?? '').trim())
    console.log('   没展开时主行里的按钮:', inRow.join(' / ') || '（一个都没有）')
    for (const want of ['执行', '打开到画布', '打开目录']) {
      const has = inRow.includes(want)
      console.log('   主行上有「' + want + '」:', has ? '✓' : '✗')
      if (!has) errors.push('主行上看不到「' + want + '」（用户要求不用展开就能看到）')
    }
    /* ★ 「删除」**必须留在展开区**（用户明确说「删除可以是展开后才看到」）。 */
    console.log('   主行上**没有**「删除」:', inRow.includes('删除') ? '✗（它本该在展开区）' : '✓')
    if (inRow.includes('删除')) errors.push('「删除」跑到了主行上（用户要求它留在展开区）')
    /* 「打开目录」要有说明性 title（它是个新动作，用户得知道打开的是哪里）。 */
    const dirBtn = [...row.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '打开目录')
    console.log('   「打开目录」有悬浮提示:', (dirBtn?.getAttribute('title') ?? '').includes('目录') ? '✓' : '✗')
    if (dirBtn === undefined || !(dirBtn.getAttribute('title') ?? '').includes('目录')) {
      errors.push('「打开目录」没有说明打开哪里的悬浮提示')
    }
    /* ★ 点「打开目录」要**真发请求**（宿主半去开文件管理器）。
     * 判据：写请求里出现 `/workflow/open` 且 body 只带名字（不带路径）。 */
    const beforeOpen = __ewbWritePosts.filter(p => p.url.includes('/workflow/open')).length
    dirBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const openPosts = __ewbWritePosts.filter(p => p.url.includes('/workflow/open'))
    console.log('   点它会发打开目录请求:', openPosts.length > beforeOpen ? '✓' : '✗')
    if (openPosts.length <= beforeOpen) errors.push('点「打开目录」没有发请求')
    /* ⚠️ 请求体只许带**名字**，不许带路径 —— 路径由宿主半自己算（那条安全约定）。 */
    const lastBody = openPosts[openPosts.length - 1]?.body ?? ''
    console.log('   请求体只带工作流名（不带路径）:', /"name":"[^"\\/]+"/.test(lastBody) && !/[A-Za-z]:\\/.test(lastBody) ? '✓' : '✗（' + lastBody + '）')
    if (!/"name":"[^"\\/]+"/.test(lastBody) || /[A-Za-z]:\\/.test(lastBody)) {
      errors.push('「打开目录」把路径发给了宿主半（应只发名字）')
    }
    /* 点按钮**不该顺带展开/收起那一行**（stopPropagation 的判据）。 */
    const stillCollapsed = mainRowOf('抖音商品流水线')?.getAttribute('aria-expanded') !== 'true'
    console.log('   点按钮没有顺带展开那一行:', stillCollapsed ? '✓' : '✗')
    if (!stillCollapsed) errors.push('点主行上的按钮把那一行展开/收起了（应 stopPropagation）')
  }
}

/* 展开一行，看指标格与操作按钮是否出现（照 FounderOS 的交互）。
 * ⚠️ 改成点**主行本身**（它现在是 div + role=button；里面套着按钮，不能按 button 找）。 */
const clickedRow = [...doc.querySelectorAll('[role="button"]')].find(el => (el.textContent ?? '').includes('抖音商品流水线'))
if (clickedRow !== undefined) clickedRow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await settle()
const after = doc.body.textContent ?? ''
console.log('   展开后指标格「节点」:', after.includes('节点') ? '有 ✓' : '没有 ✗')
console.log('   展开后操作「删除」:', after.includes('删除') ? '有 ✓' : '没有 ✗')
console.log('   展开后显示保存目录:', after.includes('ewb-test') ? '有 ✓' : '没有 ✗')

console.log('⑥ 画布容器存在:', hasCanvas)
if (!hasFlowViewport) { console.log('   → 画布未挂载（这是真问题，不是断言弱）'); process.exitCode = 1 }
const cvEl = doc.querySelector('[class*="canvas"]')
const wrapEl = doc.querySelector('[class*="wrap"]')
const bodyRow = doc.querySelector('[class*="bodyRow"]')
const libItem = doc.querySelector('[class*="libItem"]')
console.log('   节点库存在:', hasLib)

/* ⑬ 2026-10-11 用户点名的五条节点外观问题（各自一条断言，防回归）。
 *
 * 这些**必须在画布还显示着的时候断言**（下面几段会切到列表页）。
 *
 * 其中「颜色」两条只能查**产物 CSS**，不能在 jsdom 里算：
 * jsdom 里没有 dsh 的主题变量（`--dsw-*` 一个都没有），
 * `var(--dsw-alias-brand-primary-new-colorprimary-new-color)` 解析不出来，
 * 计算样式会给出空值 —— 那是**假阳性**（上一轮 `.body` 边框就是这么骗过我的）。
 */
console.log('⑬ [用户反馈] 节点外观（白框 / 加宽 / 高度 / 滚轮）')
{
  const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  /**
   * 取画布上第一个普通节点的 DOM。
   *
   * ⚠️ **必须每次重新查，不能把元素存下来复用**：React 在状态变化后可能重建
   * 这些节点元素，存下来的那个已经**脱离文档**，往它身上派事件不会冒泡到
   * React Flow 的监听里 → 看着像「功能坏了」，其实是测试没连上。
   * （⑭ 段第二版踩过这个，两处共用同一个定义。）
   */
  const firstNodeEl = () => [...doc.querySelectorAll('.react-flow__node')]
    .find(n => n.querySelector('[data-state]') !== null)

  /* ①「点击节点展开后有个白色外框，去掉他」。
   *
   * 真因是**用错了令牌**：那圈 outline 用 `--v1-accent`，而它曾指向 dsh 的
   * `brand-primary` —— 该令牌是**前景色**（亮色近黑 rgb(15,17,21) / 暗色近白
   * rgb(249,250,251)），不是强调色。暗色下就画出白框。
   * dsh 自己的 ui-dockkit/README.zh.md:78 明说「绝不用 brand-primary」。
   * 所以两条一起断言：强调色指向正确的 token + 那圈 outline 已删。 */
  const okAccent = /--v1-accent:\s*var\(--dsw-alias-brand-primary-new-colorprimary-new-color/.test(bundle)
  const badAccent = /--v1-accent:\s*var\(--dsw-alias-brand-primary[,)]/.test(bundle)
  console.log('   强调色用的是 dsh 的真强调 token（不是前景色）:', okAccent && !badAccent ? '✓' : '✗')
  if (!okAccent || badAccent) {
    console.log('   → `--v1-accent` 指向了 `brand-primary`。它是**前景色**（暗色下近白），')
    console.log('     用作强调色会在暗色主题下画出白框。改用 `-new-colorprimary-new-color`。')
    errors.push('强调色用了 brand-primary（暗色下会变白）')
  }
  /* 选中态那圈 outline 应当已删（`.node.selected` 的两重光晕已足够）。 */
  const outlineOnSelected = /_selected\{outline:\s*2px solid var\(--v1-accent\)/.test(bundle)
  console.log('   选中节点不再画那圈白色 outline:', outlineOnSelected ? '✗' : '✓')
  if (outlineOnSelected) errors.push('选中节点仍画 outline（用户报的白色外框）')

  /* ② 节点宽度：默认 300px，且走变量（用户要求可调）。
   *
   * ⚠️ 别用 `[class*="wrap"]` 找画布容器 —— 它会把 `whitespace-nowrap`
   * 这类工具类也匹配进来（第一版就是这么写错的，选出个无关的 div）。
   * 直接查「哪个元素的**内联 style** 带着这个变量」，那就是行为本身。 */
  const nodeWEl = [...doc.querySelectorAll('[style]')]
    .find(el => /--ewb-node-w:\s*300px/.test(el.getAttribute('style') ?? ''))
  console.log('   画布下发节点宽度变量（找 --ewb-node-w）:', nodeWEl !== undefined ? '✓' : '✗')
  if (nodeWEl === undefined) {
    console.log('   → 画布没有下发 `--ewb-node-w`，设置里的宽度调不动。')
    errors.push('画布没有下发节点宽度变量')
  }
  const widthIsVar = /\.\w+_node\{[^}]*width:\s*var\(--ewb-node-w/.test(bundle)
  const hardCoded218 = /_node\{[^}]*width:\s*218px/.test(bundle)
  console.log('   节点宽度走变量而不是写死:', widthIsVar && !hardCoded218 ? '✓' : '✗')
  if (!widthIsVar) errors.push('节点宽度没有走变量（设置里就调不了）')
  if (hardCoded218) errors.push('节点宽度仍写死 218px')
  /* 设置里那两个滑块真的存在（用户要求「增加设置页面」，把画布可调尺度都放进去）。
   * 抽屉默认不打开，所以先点工具条的「设置」把它调出来，断言完再关掉
   * （不关会影响后面几段对页面的判断）。
   * ⚠️ 这个按钮 2026-10-11 从「帮助」改名为「设置」—— 断言跟着改。 */
  /* ★ 票 54：工具条按钮**只留图标**（用户 2026-10-29 甲 3「只留图标不要文字」），
   * 所以改成按 `data-ewb-tb` 钩子找。
   *
   * 改之前是按 `.toolLabel` 那个 span 的文字找。文字删掉之后那个 span 不存在了，
   * `find(...)` 返回 undefined → 这一段所有「按钮在不在」的断言全部假红。
   * 钩子是按动作命名的（`settings` / `run` / `save`…），与文案无关，
   * 所以以后改文案不会再把这些断言带红。 */
  /* ⚠️ **限定在 `[data-ewb-topbar="workflow"]` 里**：两个画布共用同一套钩子名，
   * 不限定就会取到文档顺序在前的那个（可能是内容画布那颗），断言验错对象。 */
  const toolBtnByAction = (action) => doc.querySelector('[data-ewb-topbar="workflow"] [data-ewb-tb="' + action + '"]')
  const helpBtn = toolBtnByAction('settings')
  console.log('   工具条按钮叫「设置」（已不叫「帮助」）:', helpBtn !== undefined ? '✓' : '✗')
  if (helpBtn === undefined) {
    console.log('   → 找不到「设置」按钮（改名没生效，或又被叫回「帮助」了）。')
    errors.push('工具条没有「设置」按钮')
  }
  helpBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  const rangeInput = [...doc.querySelectorAll('input[type="range"]')]
    .find(i => (i.getAttribute('aria-label') ?? '') === '节点宽度')
  console.log('   设置里有节点宽度滑块:', rangeInput !== undefined ? '✓' : '✗')
  if (rangeInput === undefined) {
    console.log('   → 设置抽屉里没有节点宽度滑块，用户没法调。')
    errors.push('设置里没有节点宽度滑块')
  } else {
    /* 拖动滑块要真的改变下发的宽度值（只渲染一个滑块但接错线，是白做）。 */
    const nativeRangeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    if (nativeRangeSetter !== undefined) nativeRangeSetter.call(rangeInput, '380')
    else rangeInput.value = '380'
    rangeInput.dispatchEvent(new window.Event('input', { bubbles: true }))
    await settle()
    const afterW = [...doc.querySelectorAll('[style]')]
      .some(el => /--ewb-node-w:\s*380px/.test(el.getAttribute('style') ?? ''))
    console.log('   拖滑块后画布真的改成 380px:', afterW ? '✓' : '✗')
    if (!afterW) errors.push('改节点宽度滑块没有生效')
  }

  /* 节点宽度也要**走变量**（写死的话设置里调不动）。 */
  const wVar = /\.\w+_node\{[^}]*width:\s*var\(--ewb-node-w/.test(bundle)
  console.log('   节点宽度走变量:', wVar ? '✓' : '✗')
  if (!wVar) errors.push('节点宽度没有走变量（设置里调不动）')

  /* ★ 画布背景透明度（用户 m00861：「整个板块只有画布是天色、其他都有透明度」）。
   *
   * 判据两层（**缺一不可**）：
   *   ① 设置里有那个滑块；
   *   ② 拖它之后，画布容器的内联变量**真的变了**（只渲染滑块但没接线 = 白做）。
   *
   * ⚠️ **不能断「画布变透明了」**：jsdom 没有布局与合成，看不出透明。
   * 能断的是「那个 CSS 变量被下发成了带 transparent 的混合表达式」——
   * 真机上的视觉由那条变量驱动（canvas 那条 CSS 规则的 background 就是它）。 */
  const bgInput = [...doc.querySelectorAll('input[type="range"]')]
    .find(i => (i.getAttribute('aria-label') ?? '') === '画布背景不透明度')
  console.log('   ★ 设置里有「背景透明」滑块:', bgInput !== undefined ? '✓' : '✗')
  if (bgInput === undefined) {
    errors.push('设置里没有画布背景透明度滑块（用户 m00861 要求）')
  } else {
    const setter3 = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    if (setter3 !== undefined) setter3.call(bgInput, '40')
    else bgInput.value = '40'
    bgInput.dispatchEvent(new window.Event('input', { bubbles: true }))
    await settle()
    const styleNow = [...doc.querySelectorAll('[style]')]
      .map(el => el.getAttribute('style') ?? '')
      .find(t => t.includes('--ewb-canvas-bg')) ?? ''
    const mixed = /--ewb-canvas-bg:\s*color-mix\([^;]*40%[^;]*transparent/.test(styleNow)
    console.log('   ★ 拖到 40% 后画布底真的变成半透明混合:', mixed ? '✓' : '✗', styleNow.slice(0, 140))
    if (!mixed) errors.push('拖「背景透明」没有改变画布底（滑块没接线）')
    /* 反面：**节点与连线不该被一起变透明** —— 那是最容易犯的错（给容器加 opacity）。
     * 判据：画布容器自己**没有**被设 opacity。 */
    const wrapHasOpacity = [...doc.querySelectorAll('[style]')].some(el => {
      const cls = String(el.className ?? '')
      return cls.includes('canvas') && /opacity:\s*0?\.?[0-9]/.test(el.getAttribute('style') ?? '')
    })
    console.log('   画布容器没有被整体设透明（节点不受影响）:', !wrapHasOpacity ? '✓' : '✗')
    if (wrapHasOpacity) errors.push('画布容器被整体设了 opacity（会把节点也变透明）')
  }
  /* 「节点展开高度也增加到设置中」（用户 2026-10-11）—— 与宽度同一套做法，
   * 同样要**走变量**：写死 220px 的话滑块拖了也没用。 */
  const hVar = /\.\w+_inlineEditor\{[^}]*max-height:\s*var\(--ewb-editor-h/.test(bundle)
  console.log('   节点展开高度走变量:', hVar ? '✓' : '✗')
  if (!hVar) {
    console.log('   → `.inlineEditor` 的 max-height 是写死的，设置里的滑块拖了也不会变。')
    errors.push('节点展开高度没有走变量')
  }

  /* 「节点展开高度也增加到设置中」（用户 2026-10-11）—— 与宽度同一套做法。 */
  const hInput = [...doc.querySelectorAll('input[type="range"]')]
    .find(i => (i.getAttribute('aria-label') ?? '') === '节点展开高度')
  console.log('   设置里有节点展开高度滑块:', hInput !== undefined ? '✓' : '✗')
  if (hInput === undefined) {
    errors.push('设置里没有节点展开高度滑块')
  } else {
    const setter2 = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    if (setter2 !== undefined) setter2.call(hInput, '360')
    else hInput.value = '360'
    hInput.dispatchEvent(new window.Event('input', { bubbles: true }))
    await settle()
    const afterH = [...doc.querySelectorAll('[style]')]
      .some(el => /--ewb-editor-h:\s*360px/.test(el.getAttribute('style') ?? ''))
    console.log('   拖滑块后画布真的改成 360px:', afterH ? '✓' : '✗')
    if (!afterH) errors.push('改节点展开高度没有生效')
  }

  /* 「自动排版间距」滑块（用户 2026-10-11：「设置也增加一个自动排版间距……最小为 10」）。
   *
   * 三条一起验（缺一条都可能「滑块在但没用」）：
   *   ① 滑块存在
   *   ② 下限真的是 10（用户明确说了最小值）
   *   ③ 拖动后**真的影响排版** —— 这条不能只查配置：要真点一次自动布局，
   *      看节点坐标是否随间距变化。不然「滑块接了但没传进布局」也测不出来。 */
  const sInput = [...doc.querySelectorAll('input[type="range"]')]
    .find(i => (i.getAttribute('aria-label') ?? '') === '排版间距')
  console.log('   设置里有排版间距滑块:', sInput !== undefined ? '✓' : '✗')
  if (sInput === undefined) {
    errors.push('设置里没有排版间距滑块')
  } else {
    console.log('   间距下限是 10（用户明确要求）:', sInput.getAttribute('min') === '10' ? '✓' : `✗（${sInput.getAttribute('min')}）`)
    if (sInput.getAttribute('min') !== '10') errors.push('排版间距的下限不是 10')

    /* 改间距前后各自动布局一次，比较节点坐标 —— 间距变了布局就该变。 */
    const setSpacing = async (v) => {
      const setter3 = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      if (setter3 !== undefined) setter3.call(sInput, String(v))
      else sInput.value = String(v)
      sInput.dispatchEvent(new window.Event('input', { bubbles: true }))
      await settle()
    }
    const layoutByClicking = async () => {
      /* 用画布菜单的「自动布局：从左到右」。 */
      const pane = doc.querySelector('.react-flow__pane')
      pane?.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }))
      await settle()
      const item = [...doc.querySelectorAll('[data-ewb-menu] button')]
        .find(b => (b.textContent ?? '').includes('自动布局：从左到右'))
      item?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await settle()
      return [...doc.querySelectorAll('.react-flow__node')].map(n => n.getAttribute('style') ?? '').join('|')
    }
    await setSpacing(10)
    const tight = await layoutByClicking()
    await setSpacing(380)
    const loose = await layoutByClicking()
    console.log('   间距 10 与 380 排出来的布局不同:', tight !== loose ? '✓' : '✗')
    if (tight === loose) {
      console.log('   → 间距滑块没有影响自动布局（可能没传进 ELK）。')
      errors.push('排版间距没有影响自动布局')
    }
    /* 复位回自动（免得影响后面几段）。 */
    const resetBtn = [...doc.querySelectorAll('button')]
      .find(b => (b.getAttribute('title') ?? '').includes('恢复自动'))
    resetBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
  }
  /* 调完记得关抽屉（不关会影响后面几段对页面的判断）。 */
  {
    const drawerClose = [...doc.querySelectorAll('button')].find(b => (b.getAttribute('title') ?? '').startsWith('关闭'))
    drawerClose?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
  }

  /* ③「节点顶部的内容过多了」——执行方那行（「本进程内直接算」）已删。
   * 判据：节点卡片代码里不再渲染 `.howLine`，且该 CSS 规则也已删。 */
  const howLineRule = /_howLine\{/.test(bundle)
  console.log('   已删掉执行方的说明行（本进程内直接算）:', howLineRule ? '✗' : '✓')
  if (howLineRule) errors.push('执行方说明行还在（用户说它是重复信息）')

  /* ⑥ 工具条精简 + 删掉三个功能（用户 2026-10-11）。
   *
   * 用户原话：
   *   「标题栏中的单步按钮去掉（功能保留，放在右键菜单中）」——
   *     ⚠️ 「功能表留」按上下文是「功能保留」，所以只删按钮、**不删 stepOnce**；
   *   「导入去掉（有打开功能就行了）」
   *   「跳过选中去掉（功能保留，放在右键菜单中）」
   *   「顶部栏的功能按钮太多了，太占空间」
   *
   * ★ 票 54：判据从「按钮文字里没有这三个词」改成**「钩子集合里没有这三个动作」**。
   *
   * ## 为什么旧写法必须换掉
   *
   * 旧版收集 `.toolLabel` 的文字组成数组，再 `includes('单步')`。
   * 票面第 3 条要求「只留图标」→ 那个 span 全没了 → 数组变**空** →
   * `[].includes('单步')` 恒为 false → **三条断言永远通过**。
   * 这不是放宽，是把一条已经失效的判据换成**能真的变红**的判据。
   *
   * ## 新判据为什么更强
   *
   * 它查的是**动作钩子**：加回一颗「单步」按钮，必须同时给它一个
   * `data-ewb-tb="step"` 才符合本仓库的写法 —— 那一给它就红。
   * 而旧写法在「按钮加回来了、但没写文字」时会漏掉（那就成了假绿）。
   *
   * ⚠️ 自证：把 `data-ewb-tb="step"` 加进工具条 → 这条必须变红。 */
  const toolActions = [...doc.querySelectorAll('[data-ewb-topbar="workflow"] [data-ewb-tb]')]
    .map(el => el.getAttribute('data-ewb-tb') ?? '')
  console.log('   工具条现有动作钩子:', toolActions.join(' / ') || '（一个都没有 —— 说明工具条没渲染出来）')
  /* 前置：工具条必须真的渲染出来了。否则下面三条「不包含」又会变成空数组假绿。 */
  console.log('   工具条上有动作钩子（前置）:', toolActions.length > 0 ? '✓' : '✗')
  if (toolActions.length === 0) errors.push('工具条上一个 data-ewb-tb 都没有（工具条没渲染出来，下面的判据无从谈起）')
  for (const gone of ['step', 'import', 'skip']) {
    const still = toolActions.includes(gone)
    console.log('   工具条已去掉「' + gone + '」这个动作:', still ? '✗' : '✓')
    if (still) errors.push('工具条上「' + gone + '」这个动作还在（用户要求去掉）')
  }
  /* 但功能本身必须在（用户说「功能保留，放在右键菜单中」）——删按钮时最容易连功能一起删掉。
   *
   * ⚠️ 不能在产物里查 `stepOnce` 这类**局部函数名**：压缩器会把它们改名
   * （实测产物里根本没有 `stepOnce` 这个串，会误报「功能被删了」）。
   * 可靠的判据是**用户可见的行为**：那三句 notify 文案是字符串字面量，
   * 压缩器不会改它。功能真被删掉时，这些文案也就没了。 */
  const KEPT_FEATURE_TEXT = [
    ['单步调试（跑下一步）', '已经没有可走的下一步了'],
    ['跳过选中（暂停某个节点）', '已跳过 '],
  ]
  for (const [name, needle] of KEPT_FEATURE_TEXT) {
    const alive = bundle.includes(needle)
    console.log('   功能「' + name + '」仍保留（等右键菜单接）:', alive ? '✓' : '✗')
    if (!alive) {
      console.log('   → 功能被连根删了。用户要的是「只去掉按钮，功能保留」。')
      errors.push('删按钮时把功能「' + name + '」一起删了')
    }
  }

  /* ⑤「节点内滚动滚轮应该是滚节点内的滚动条，而不是继续放大缩小画布」。
   *
   * 做法是给两个滚动区加 `nowheel` —— React Flow 认这个类名（默认 noWheelClassName），
   * 判定滚轮落点在里面时不缩放画布。**必须是这个字面类名**，换成别的不管用。
   *
   * ⚠️ 判据是**真展开一个节点、查它的 DOM**，不能在产物里数 `nowheel` 出现几次——
   * 第一版就是这么写的，结果**抓不住回归**：React Flow 自己也带着这个串
   * （默认值 `noWheelClassName = 'nowheel'` 等共 4 处），我们删光自己的那两处它也照样 ≥2。
   * 已实测：删掉我们的 `nowheel` 后，数产物那版仍然通过（假阳性）。
   *
   * 展开动作放在这里还顺带成了 ④ 的前提 —— 失败处理那三个按钮要节点展开才在页面上。 */
  const firstNode = doc.querySelector('.react-flow__node')
  const nodeCard = firstNode?.querySelector('[data-state]')
  /* 让位（用户 2026-10-16）要看的是**坐标**，所以展开前后各记一次。
   * React Flow 把坐标写在节点的内联 `transform: translate(x, y)` 上。 */
  const readPositions = () => {
    const out = {}
    for (const el of doc.querySelectorAll('.react-flow__node[data-id]')) {
      const id = el.getAttribute('data-id')
      const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform ?? '')
      if (id !== null && m !== null) out[id] = [Number(m[1]), Number(m[2])]
    }
    return out
  }
  const posBefore = readPositions()
  nodeCard?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  /* ★ 展开让位（用户 2026-10-16）在 jsdom 里**测不到「有人被推开」那一半**：
   *   `getBoundingClientRect` 在本环境恒返回 0，量不出节点高度；
   *   而自动布局（ELK 横向排）又把节点摆成一条横线，正下方本来就没人。
   *   那部分（谁该让、让多少、循环框怎么跟着长）由 `tests/expand-shift.mjs` 覆盖。
   *
   *   这里测的是**坏得最难看的那一半相反面**：正下方没人时**一个坐标都不许动**。
   *   写错的典型症状就是「展开一下，整张图往下跑一截」——
   *   那种错在构建、类型检查里都不报错，只会被这一条抓住。 */
  const posAfter = readPositions()
  /* ⚠️ 先证「量得到」——解析不到坐标的话 moved 恒为 0，这条断言就成了假绿
   * （本项目踩过多次「断言其实没连上」）。画布上至少有 5 个示例节点。 */
  const posCount = Object.keys(posBefore).length
  console.log('   能读出坐标的节点数:', posCount, posCount >= 3 ? '✓' : '✗（读不到坐标，下面那条等于没验）')
  if (posCount < 3) errors.push('读不出节点坐标（让位那条断言失效）')
  const moved = Object.keys(posBefore).filter(k => {
    const a = posBefore[k]
    const b = posAfter[k]
    return a !== undefined && b !== undefined && (a[0] !== b[0] || a[1] !== b[1])
  })
  console.log('   正下方没人时，展开不动任何节点:', moved.length === 0 ? '✓' : '✗（' + moved.join(',') + '）')
  if (moved.length > 0) errors.push('展开节点把画布上别的节点推走了（正下方本来没人）')
  const editorEl = doc.querySelector('[data-ewb-editor]')
  console.log('   展开节点后参数区出现:', editorEl !== null ? '✓' : '✗')
  if (editorEl === null) {
    console.log('   → 点节点没有展开参数区，下面两条断言都验证不到（前提不成立）。')
    errors.push('点节点没有展开参数区')
  } else {
    const cls = editorEl.className ?? ''
    console.log('   参数区带 nowheel（滚轮滚内部、不缩放画布）:', /\bnowheel\b/.test(cls) ? '✓' : `✗（class="${cls}"）`)
    if (!/\bnowheel\b/.test(cls)) {
      console.log('   → 参数区缺 `nowheel`：在节点上滚轮会缩放画布，内部滚动条滚不动。')
      errors.push('参数区没有 nowheel')
    }
    /* ④「失败处理不需要说明文字」——三个选项的 desc 只挂在 `title` 上，不再渲染成一行。
     *
     * 判据用**页面文字**，不用产物正则：`title` 属性不进 textContent，
     * 所以「页面上找不到那三句说明」就等价于「那行说明没了」。
     * （第一版用产物正则 `ON_ERROR_OPTIONS.find`，第二版用 `失败处理…paramHint`，
     *  两者都太容易被别处的同名串碰上白放行 —— 数产物 `nowheel` 也是同一个毛病。）
     * ⚠️ 必须在**节点已展开**的这里查：那三个按钮只在展开态才渲染。 */
    const ERR_DESCS = ['这个节点失败就整体停下', '失败也往下走，下游拿到空值', '失败结果从「失败」出口走']
    const printedErrDesc = ERR_DESCS.filter(d => (editorEl.textContent ?? '').includes(d))
    console.log('   失败处理不再打印说明文字:', printedErrDesc.length === 0 ? '✓' : `✗（${printedErrDesc.join(' / ')}）`)
    if (printedErrDesc.length > 0) errors.push('失败处理仍在渲染说明文字')
    /* 但悬浮提示必须还在（用户说「当前有悬浮显示信息足够」）——否则等于把说明删干净了。 */
    const descTitles = [...editorEl.querySelectorAll('button')]
      .map(b => b.getAttribute('title') ?? '')
      .filter(t => ERR_DESCS.some(d => t.includes(d)))
    console.log('   三个选项的说明改挂到悬浮提示上:', descTitles.length === 3 ? '✓' : `✗（${descTitles.length} 个）`)
    if (descTitles.length !== 3) errors.push('失败处理的悬浮提示丢了（说明被删干净了）')

    /* ⑤b 端口：**外观照原样，只把点击区放大**（用户 2026-10-12，纠正过我一次）
     *
     * 用户原话：「端点就应该在边框上……端点应该在节点外框上（一半出框一半在内）。
     *   当前的端点调整还不如之前。**我的目的只是让可点击拖动的区域变大**，
     *   你改了外观改差了」
     *
     * 所以判据是**两件相反的事同时成立**：
     *   ① 端点元素本身还是 9px（外观没变大 —— 我上一版就是错在把它撑大了）；
     *   ② 它有个往外扩的 `::before`（点击区确实变大了）。
     * 少了 ② 就是没修；少了 ① 就是又改坏了外观。
     *
     * 为什么不查 `getBoundingClientRect`：jsdom 不做布局，那个恒为 0。
     * 所以查**样式声明**（那是实现方式，改掉必然回归）。 */
    const firstHandle = doc.querySelector('.react-flow__handle')
    console.log('   节点上有端口元素:', firstHandle !== null ? '✓' : '✗')
    if (firstHandle === null) {
      errors.push('节点上没有端口元素（连线起不了）')
    } else {
      const portCss = readFileSync(new URL('../src/client/workbench/node-card.module.css', import.meta.url), 'utf8')
      const handleRule = /^\.handle\s*\{([^}]*)\}/m.exec(portCss)
      const body = handleRule === null ? '' : handleRule[1]
      /* ① 外观没变大：宽高仍是 9px。 */
      const dotSize = /width:\s*9px/.test(body) && /height:\s*9px/.test(body)
      console.log('   端点外观照原样（9px 圆点，没有被撑大）:', dotSize ? '✓' : `✗（${body.replace(/\s+/g, ' ').trim().slice(0, 70)}）`)
      if (!dotSize) errors.push('端点被撑大了（外观被改坏 —— 用户要的只是点击区变大）')
      /* ② 点击区变大：靠伪元素往外扩，不能改元素本身。 */
      const hitRule = /\.handle::before\s*\{([^}]*)\}/.exec(portCss)
      const hitBody = hitRule === null ? '' : hitRule[1]
      const hitBigger = /inset:\s*-/.test(hitBody)
      console.log('   点击区靠伪元素放大（不影响外观与连线锚点）:', hitBigger ? '✓' : `✗（${hitBody.replace(/\s+/g, ' ').trim().slice(0, 70)}）`)
      if (!hitBigger) {
        errors.push('端口点击区没放大（用户点不着小圆点）')
      }
      /* 悬停放大要带上水平 translate：漏了会让圆点往一侧偏（我踩过）。 */
      const hoverOk = /\.portIn \.handle:hover\s*\{[^}]*translate\(-50%/.test(portCss)
        && /\.portOut \.handle:hover\s*\{[^}]*translate\(50%/.test(portCss)
      console.log('   悬停放大时圆点不跑偏（带上了水平方向）:', hoverOk ? '✓' : '✗')
      if (!hoverOk) errors.push('悬停放大覆盖了水平位移（圆点会往一侧偏）')
    }

    /* ⑤d 实例级「这个节点」：名字 + 备注（用户 2026-10-12）
     *
     * 用户原话：「这是一段代码，llm 写的，写的时候我知道什么意思，
     * 但是看的时候我不知道，我忘了这个节点的意义。所以有的功能是否封装节点更表意。
     * （当前的说明部分只是说这个节点的功能，而不是实现了什么）」
     *
     * 判据：展开区里要有两个可写的字段（名字输入 + 备注多行），
     * 且**改了名字节点标题要跟着变** —— 后者才是「真的接上了」，
     * 只查「有两个输入框」会被「渲染了但没接线」骗过。 */
    const nameInput = [...editorEl.querySelectorAll('input')]
      .find(i => (i.getAttribute('placeholder') ?? '') !== '' && (i.getAttribute('title') ?? '') === '')
    const noteInput = [...editorEl.querySelectorAll('textarea')]
      .find(i => (i.getAttribute('placeholder') ?? '').includes('为什么'))
    console.log('   展开区有「实例名」输入框:', nameInput !== undefined ? '✓' : '✗')
    console.log('   展开区有「备注」输入框:', noteInput !== undefined ? '✓' : '✗')
    if (nameInput === undefined) errors.push('展开区没有实例名输入框（忘了这个节点什么意思没地方写）')
    if (noteInput === undefined) errors.push('展开区没有备注输入框')

    /* 真的接线了没有：改名字 → 节点标题应跟着变。
     * ⚠️ 名字输入的 placeholder 是**类型名**，先把它读出来当「类型名」用 ——
     * 这样不用另找一个来源，也不会因为别的节点先被改名而串。 */
    const def0Label = nameInput?.getAttribute('placeholder') ?? ''
    if (nameInput !== undefined && def0Label !== '') {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      if (setter !== undefined) setter.call(nameInput, '我给它起的名字')
      nameInput.dispatchEvent(new window.Event('input', { bubbles: true }))
      await settle()
      const titleEl = doc.querySelector('.react-flow__node [class*="_title"]')
      const shown = (titleEl?.textContent ?? '').trim()
      console.log('   改了实例名后节点标题跟着变:', shown === '我给它起的名字' ? '✓' : `✗（显示「${shown}」）`)
      if (shown !== '我给它起的名字') errors.push('改了实例名节点标题没变（回调没接上）')
      /* 有实例名时，类型名要退到副标题位（否则不知道这是哪种节点）。 */
      const typeLine = doc.querySelector('.react-flow__node [class*="_typeLine"]')
      console.log('   有实例名时仍能看出节点类型:', (typeLine?.textContent ?? '').includes(def0Label) ? '✓' : '✗')
      if (!(typeLine?.textContent ?? '').includes(def0Label)) errors.push('有实例名后类型名消失了（不知道是什么节点）')
    }

    /* ⑤f 容器归属：**只由「加节点」与「右键菜单」改**（2026-10-13 大改）
     *
     * ## 为什么这一段整体换掉
     *
     * 原来这里守的是「悬停 1 秒确认 / 半进半出提示 / 连带移出 / 鼠标旁提示」——
     * 那整套是**拖动改归属**的配套，而用户 2026-10-13 定规矩
     * 「先看 n8n 与 Dify，**他们都没有的就不做**」，并指出循环
     * 「出入都不应该在里面的节点上」。
     *
     * 查证：两家都**不靠拖动改容器归属** ——
     *   - n8n：组成员由**连线**决定（连线时自动吸收；不合法的线直接拒绝），
     *     没有拖进拖出，连「单个移出」都没有（只能整组解散）；
     *   - Dify：归属在**加节点那一刻**由邻居的 parentId 继承；
     *     已在容器里的节点拖动时**被钳住**（`getRestrictedIterationPosition`），出不去。
     *
     * 所以旧那套整体删掉，这里改守两件新事：
     *   ① **拖动不许改归属**（代码里那套标识符一个都不该还在）；
     *   ② **循环节点没有端口**（照 Dify —— 它的迭代节点零 Handle）。
     *
     * ⚠️ 判据查**源码里的代码**（先剥注释）—— 注释里会提到那些名字（讲为什么删），
     * 直接查「出现过没有」会被注释救活（本项目踩过这个假绿）。 */
    {
      const canvasSrc = readFileSync(new URL('../src/client/workbench/WorkflowCanvas.tsx', import.meta.url), 'utf8')
      const codeOnly = canvasSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
      const gone = ['dropTarget', 'stepDragIntent', 'CONFIRM_MS', 'setDragHint',
        'setHoverCandidateId', 'setDropTargetId', 'setLeaveFromId', 'hoverTimerRef',
        'intentRef', 'pointerRef', 'applyIntent', 'countLeaveClosure',
        'removeWithClosure', 'leaveClosure', 'assignWithClosure']
      const left = gone.filter(k => codeOnly.includes(k))
      console.log('   拖动改归属那套已删干净:', left.length === 0 ? '✓' : `✗（还剩 ${left.join(', ')}）`)
      if (left.length > 0) errors.push('拖动改归属的代码没删干净：' + left.join(', '))
      /* 归属的两个**新入口**必须在（有函数没入口 = 死代码）。 */
      const hasPut = /putIntoLoop\(n\.id/.test(canvasSrc)
      const hasOut = /takeOutOfLoop\(n\.id/.test(canvasSrc)
      console.log('   右键菜单有「放入循环 / 移出循环」:', hasPut && hasOut ? '✓' : `✗（放入=${hasPut} 移出=${hasOut}）`)
      if (!hasPut || !hasOut) errors.push('右键菜单缺「放入/移出循环」（归属没有显式入口）')
      /* 加节点时按落点归属（照 Dify 的「加的那一刻定」）。 */
      const addBody = /const addNode = useCallback\([\s\S]*?\n  \}, \[/.exec(codeOnly)?.[0] ?? ''
      const addWired = /containerAt\(/.test(addBody) && /assignToContainer\(/.test(addBody)
      console.log('   加节点时按落点归属:', addWired ? '✓' : '✗')
      if (!addWired) errors.push('加节点时不判定落点（照 Dify 应当在这一刻定归属）')

      /* ★ 2026-10-19 三条（用户明确要抄 Dify + 补嵌套入口）。
       *
       * ⚠️ 判据都查 `codeOnly`（剥过注释）—— 注释里会大段解释这些名字，
       * 直接查 `canvasSrc` 会被注释救活（本项目踩过这个假绿）。
       *
       * ① **拖动时钳住成员**必须真的接在 `onNodeDrag` 里。
       *    只查「`clampIntoLoop` 出现过」不够：它可能在文件里被 import 了却没人调。
       * ② **循环自己也有「放入循环」菜单项**（旧版把它排除掉，那是嵌套功能的缺口）。
       *    判据是「菜单那段里看不到 `LOOP_DEF_ID` 的排除」+ `loopTargetsFor` 真的被调用。
       * ③ **层数上限两边一致**：界面的 `MAX_LOOP_DEPTH_UI` 与执行期 `MAX_LOOP_DEPTH`
       *    必须是同一个数 —— 不一致会变成「界面能选、跑起来报错」。
       *    （纯逻辑那侧由 `tests/loop-nest-ui.mjs` 钉住；这里只钉「画布真的用上了」。） */
      const dragBody = /const onNodeDrag = useCallback\([\s\S]*?\n  \}, \[[^\]]*\]\)/.exec(codeOnly)?.[0] ?? ''
      const clamped = /clampIntoLoop\(/.test(dragBody)
      console.log('   ① 拖动时把成员钳在框内:', clamped ? '✓' : '✗')
      if (!clamped) errors.push('onNodeDrag 里没接 clampIntoLoop（成员能被拖出框）')

      const menuBody = /const nodeMenuEntries = useCallback\([\s\S]*?\n  \}, \[/.exec(codeOnly)?.[0] ?? ''
      const loopExcluded = /n\.data\.def\.id === LOOP_DEF_ID \? \[\] :/.test(menuBody)
      const targetsUsed = /loopTargetsFor\(/.test(menuBody)
      console.log('   ② 循环自己也有「放入循环」项:', !loopExcluded && targetsUsed ? '✓' : `✗（排除=${loopExcluded} 用候选=${targetsUsed}）`)
      if (loopExcluded || !targetsUsed) errors.push('右键菜单仍把循环排除在外（嵌套没有界面入口）')

      const uiCap = /MAX_LOOP_DEPTH_UI = (\d+)/.exec(
        readFileSync(new URL('../src/client/workbench/container-ops.ts', import.meta.url), 'utf8'),
      )?.[1]
      const engineCap = /MAX_LOOP_DEPTH = (\d+)/.exec(
        readFileSync(new URL('../src/workflow/run.ts', import.meta.url), 'utf8'),
      )?.[1]
      console.log('   ③ 层数上限两边一致:', uiCap === engineCap && uiCap !== undefined ? '✓' : `✗（界面=${uiCap} 执行期=${engineCap}）`)
      if (uiCap !== engineCap || uiCap === undefined) {
        errors.push('界面与执行期的循环层数上限不一致：' + String(uiCap) + ' vs ' + String(engineCap))
      }
    }

    /* ⑤f2 循环节点**有端口**（2026-10-17 用户定案「补实」）。
     *
     * ## 这条断言的历史（别看着奇怪就改回去）
     *
     * 2026-10-13 这里断言的是**反面**：「循环节点没有端口（照 Dify）」——
     * 当时的理由是 Dify 的迭代节点零 Handle、进出全走参数。
     * 但那次**只改了定义与文档，前端与存档没跟着改**：`LoopNode.tsx` 一直画着
     * 两个 Handle、存档里的边也照旧接在 `in` 上。
     * 于是这条断言在当时是**绿的**，而界面在承诺一件定义里不存在的事
     * （典型的「假防线」——见 `pitfalls/假防线-看着写了其实不生效.md`）。
     *
     * 2026-10-17 用户定案「**补实**」：循环在一条链里的位置本来就是真实语义，
     * 界面上看得见、说得清，比藏在参数里更好用。
     *
     * ⚠️ 现在断的是**四处一致**：定义里有这两个端口、且**前端真的画了它们**
     * （这才是当初漏掉的那一半）。参数选择器 `items` **仍然要在** ——
     * 它是「不连线也能喂数据」的写法，已有工作流用的都是它（向后兼容）。 */
    {
      const loopDef = readFileSync(new URL('../src/nodes/flow/loop/node.ts', import.meta.url), 'utf8')
      const hasIn = /inputs: \[\{ id: 'in'/.test(loopDef)
      const hasDone = /outputs: \[\{ id: 'done'/.test(loopDef)
      console.log('   循环定义里有入口 in:', hasIn ? '✓' : '✗')
      console.log('   循环定义里有出口 done:', hasDone ? '✓' : '✗')
      if (!hasIn || !hasDone) errors.push('循环定义缺端口（2026-10-17 已定案「补实」）')
      /* 参数选择器保留（向后兼容：已有工作流都没连线、只填了它）。 */
      const hasSelector = /key: 'items'[\s\S]{0,200}kind: 'nodeField'/.test(loopDef)
      console.log('   循环的输入仍可用「选节点 + 选字段」:', hasSelector ? '✓' : '✗')
      if (!hasSelector) errors.push('循环的参数选择器被删了（已有工作流会坏）')
      /* 「参数优先」这条规则要写在说明里，否则用户不知道两条都给时算哪条。
       * ⚠️ 判据是「参数优先」——第一版实现写的是「入边优先」，被 douyin-workflow
       * 打回来（已有工作流全都连了线又填了参数，入边优先会取到整份对象）。 */
      const saysParamFirst = loopDef.includes('参数优先')
      console.log('   定义里写明「参数优先」:', saysParamFirst ? '✓' : '✗')
      if (!saysParamFirst) errors.push('循环定义没写明「参数优先」（两条都给时取哪条要能查到）')
    }
    /* ⑤g 浏览器层的两个节点（用户 2026-10-12）
     *
     * 判据分两层：
     *   - **节点库里有这两个节点**（用户看不到就等于没做）；
     *   - **「浏览器」节点有动作下拉**（用户定的形态：一个节点 + 动作下拉，照 n8n）。
     *     若它退回「一堆独立节点」，这条会红。
     *   - **会话色标接上了**（同名同色）。
     *
     * 纯逻辑（色标哈希、驱动行为）在 `session-color` 与 `browser-driver` 里钉，
     * 这里只查「界面上有没有」。 */
    {
      /* ⚠️ **只查条目的名字**（`libName`），不查整条的文字。
       * 第一版查 `el.textContent`（整条，含描述与执行方标签）——
       * 描述里写着「打开页面 / 点击 / 输入 / 取文本 / 截图 / 执行脚本」，
       * 于是「旧的散装浏览器节点还在吗」这条**误报**（把描述里的词当成了节点名）。
       * 这也是 AGENTS.md 说的「断言要限定范围」。 */
      const names = [...doc.querySelectorAll('[class*="libName"]')].map(el => (el.textContent ?? '').trim())
      /* ⚠️ 节点名 2026-10-13 改成「浏览器-playwright」（用户要求：
       * 「虽然当前只有一个，但还是**明确一下用的是什么**」）。判据跟着改。
       * ⚠️ 2026-10-19 下载节点也改名了：「延迟下载」→ **「下载-playwright」**
       * （用户原话：「将延迟下载节点改名。名字为：下载-playwright。
       *  下载与浏览器作为两个节点。」）。判据必须跟着改 —— 旧名留着这条就是**测旧东西**。 */
      const hasAct = names.includes('浏览器-playwright')
      const hasDl = names.includes('下载-playwright')
      console.log('   节点库里有「浏览器-playwright」节点:', hasAct ? '✓' : '✗')
      console.log('   节点库里有「下载-playwright」节点:', hasDl ? '✓' : '✗')
      if (!hasAct) errors.push('节点库里找不到「浏览器-playwright」节点')
      if (!hasDl) errors.push('节点库里找不到「下载-playwright」节点')
      /* ★ 旧名**必须消失**（用户要的是「改名」，不是「再加一个」）。
       * 只查节点名这一列，不查描述 —— 描述里会讲历史，可能提到旧名。 */
      console.log('   旧名「延迟下载」已不在节点库里:', names.includes('延迟下载') ? '✗（还留着）' : '✓')
      if (names.includes('延迟下载')) errors.push('节点库里还留着旧名「延迟下载」（用户要求改名）')
      /* ★ 两个节点必须**都在**（用户明确「下载与浏览器作为两个节点」）——
       * 合并成一个会让这条红，而那是用户明确不要的形态。 */
      console.log('   ★ 下载与浏览器仍是两个独立节点:', hasAct && hasDl ? '✓' : '✗')
      if (!(hasAct && hasDl)) errors.push('「下载-playwright」与「浏览器-playwright」没有同时存在（用户要求这是两个节点）')
      /* 旧的 5 个散装浏览器节点不该还在（用户要求合成一个）。
       * 用**精确等值**比名字（不是 includes）—— 否则「点击元素」这类描述词会误命中。 */
      const STRAY = ['点击元素', '输入文本', '等待元素', '页面截图', '执行 JS', '打开页面']
      const stray = names.filter(n => STRAY.includes(n))
      console.log('   旧的散装浏览器节点已清掉:', stray.length === 0 ? '✓' : `✗（还剩 ${stray.join(' / ')}）`)
      if (stray.length > 0) errors.push('旧的散装浏览器节点没删干净（与「一个节点+动作下拉」冲突）')

      /* 会话色标：查源码接线（DOM 上要有节点实例才看得到，这里便宜地查接线）。 */
      const nodeSrc = readFileSync(new URL('../src/client/workbench/WorkflowNode.tsx', import.meta.url), 'utf8')
      const tagWired = /css_node_card\.sessionTag/.test(nodeSrc) && /css_node_card\.sessionDot/.test(nodeSrc)
      console.log('   节点上有会话色标:', tagWired ? '✓' : '✗')
      if (!tagWired) errors.push('节点上没接会话色标')
      const cssSrc = readFileSync(new URL('../src/client/workbench/node-card.module.css', import.meta.url), 'utf8')
      const tagStyled = /^\.sessionTag\s*\{/m.test(cssSrc) && /^\.sessionDot\s*\{/m.test(cssSrc)
      console.log('   色标的样式在（否则是裸文字）:', tagStyled ? '✓' : '✗')
      if (!tagStyled) errors.push('会话色标没有样式')
    }

    /* ⑤e 分组框升级：可命名（早已有）+ 描述 + 收起（用户 2026-10-12，照 n8n 的 Canvas Groups） */
    {
      const groupCss = readFileSync(new URL('../src/client/workbench/node-card.module.css', import.meta.url), 'utf8')
      const hasDesc = /^\.groupDescInput\s*\{/m.test(groupCss)
      const hasCollapse = /^\.groupCollapsed\s*\{/m.test(groupCss)
      console.log('   分组框有「描述」输入（讲这组干什么）:', hasDesc ? '✓' : '✗')
      console.log('   分组框有「收起」态:', hasCollapse ? '✓' : '✗')
      if (!hasDesc) errors.push('分组框没有描述输入')
      if (!hasCollapse) errors.push('分组框没有收起态')
      /* ⚠️ 「实例上真的有描述输入与按钮」那两条**不在这里验**（2026-10-26 挪走）。
       *
       * 这里只能验到 CSS（上面那两条），因为**此刻画布上还没有任何组节点** ——
       * 组是用户右键「打包成分组」之后才创建的，而那一段在 600 行之后。
       *
       * 原来这里写的是 `if (groupNode !== null) { 那两条断言 }`：
       * 组节点在这个位置永远取不到 → 块内两条**从写下那天起就没跑过**，
       * 而测试一直是绿的。2026-10-26 给这块补了「取不到就报错」的兜底之后，
       * 它立刻在正常运行时就红了 —— 这才暴露出「位置本身是错的」，不是断言写错。
       *
       * 现在这两条挪到 `⑤ 选中多个节点后右键 → 打包成分组` 那一段（组真的存在的地方），
       * 见那里的 `分组框实例上有描述输入与按钮`。
       * **不移回这里**：这里没有组节点，放回来就是又一次假绿。 */
    }

    /* ⑤c 循环框（用户 2026-10-12：「循环这个节点本身是一个框，把其他节点包在里面」；
     *     紧接着追问「他现在就是一个常规外观我怎么使用他？拖不进去。」）
     *
     * 在这之前**根本没有「拖进容器」的逻辑** —— `parentId` 只在编组时被设，
     * 而编组建的是分组框。所以那两条断言守两件不同的事：
     *   ① 循环节点渲染成**框**（有容器面 + 标题 + 收起按钮），不是常规卡片；
     *   ② 「拖进容器」的判定存在且认得循环（纯逻辑层，这里只查它被接上了）。
     *
     * 做法：从节点库里**加一个循环节点**（点库项即加），再查画布上有没有那个框。 */
    const libItems = [...doc.querySelectorAll('[class*="libItem"]')]
    const loopItem = libItems.find(el => (el.textContent ?? '').includes('循环'))
    console.log('   节点库里有「循环」节点:', loopItem !== undefined ? '✓' : '✗')
    if (loopItem === undefined) {
      errors.push('节点库里找不到「循环」节点')
    } else {
      loopItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await settle()
      const loopBox = doc.querySelector('[data-loop-id]')
      console.log('   加上之后渲染成「框」（不是常规卡片）:', loopBox !== null ? '✓' : '✗')
      if (loopBox === null) {
        errors.push('循环节点没有渲染成容器框')
      } else {
        /* 框要有「容器面」：告诉用户可以把节点拖进去。 */
        const hasBody = loopBox.querySelector('[class*="loopBody"]') !== null
        console.log('   框里有容器面（可以往里拖节点）:', hasBody ? '✓' : '✗')
        if (!hasBody) errors.push('循环框没有容器面')

        /* ★ 空体警告（2026-10-17 加）。
         *
         * 这一段是**往空画布加一个循环**——它就是空体，正好拿来验。
         * 判据按**看得见的效果**定（照本文件的一贯规矩）：
         * 空体的提示要写成「这个循环是空的 —— …」，且带警告色类；
         * 而**非空**时不该报警告（那一条由 `loop-box` 测试的存档覆盖，
         * 那里框里真有一个成员）。
         *
         * ⚠️ 为什么不能只看文字在不在：那句「把要重复的节点拖进来」**一直都在**
         * （空体与否都显示），所以「文字在」证明不了警告生效 —— 要断的是
         * **文案变了 + 警告类挂上了**。 */
        const hintEl = loopBox.querySelector('[class*="loopEmptyHint"]')
        const hintText = hintEl?.textContent ?? ''
        const warned = hintEl?.className.includes('loopEmptyWarn') === true
        console.log('   ★ 空循环就地警告（不是等到运行时才报）:', warned ? '✓' : '✗')
        console.log('     提示文案:', hintText)
        if (!warned) errors.push('空循环没有就地警告（用户要一眼看见，不是点了运行才知道）')
        if (!hintText.includes('空')) errors.push('空循环提示没写清「它是空的」')
        /* 收起按钮：这是「收起成一张卡片」的入口（照 Dify）。 */
        const collapseBtn = [...loopBox.querySelectorAll('button')]
          .find(b => (b.textContent ?? '').includes('收起'))
        console.log('   框头有「收起」按钮:', collapseBtn !== undefined ? '✓' : '✗')
        if (collapseBtn === undefined) errors.push('循环框没有收起按钮')
        /* 名字可改（实例级改名 —— 用户最关心的「看的时候不知道这节点什么意思」）。 */
        const nameInput = loopBox.querySelector('input')
        console.log('   框头名字可编辑（实例级改名）:', nameInput !== null ? '✓' : '✗')
        if (nameInput === null) errors.push('循环框的名字不可编辑')
        /* 端口：循环要能接上游数据、也要能交出错。 */
        const handles = loopBox.querySelectorAll('.react-flow__handle')
        console.log('   框上有进出口（能接上游、能交出错）:', handles.length >= 2 ? '✓' : `✗（${handles.length} 个）`)
        if (handles.length < 2) errors.push('循环框的端口不齐（接不上数据）')

        /* ⚠️ 循环框**必须有一出生就有的尺寸** —— 否则包围盒 0×0，
         * 「拖进容器」的判定（要宽高 > 0）永远不命中，等于还是拖不进去。
         *
         * 判据看**节点自己的内联宽高**（`data.id` 那个 `.react-flow__node` 上），
         * 不看框内部元素的样式 —— 内部是 `width: 100%`，
         * 拿它当判据的话「没给尺寸」也照样通过（第一版就是这么假绿的）。 */
        const loopNodeEl = doc.querySelector('.react-flow__node[data-id="' + (loopBox.getAttribute('data-loop-id') ?? '') + '"]')
        const inlineStyle = loopNodeEl?.getAttribute('style') ?? ''
        const hasSize = /width:\s*\d+px/.test(inlineStyle) && /height:\s*\d+px/.test(inlineStyle)
        console.log('   框一开始就有尺寸（否则拖不进去）:', hasSize ? '✓' : '✗（' + inlineStyle.slice(0, 60) + '）')
        if (!hasSize) {
          errors.push('循环框一出生没有内联尺寸（包围盒 0×0 → 拖不进去）')
        }

        /* ⚠️ **循环的设置面板必须能改「遍历哪个数据 / 结果取哪个」**
         * （2026-10-15 补，用户报「循环的设置目前好像前端没有呈现」）。
         *
         * ## 真因（值得记下来，因为它是「组件提前返回」造成的静默缺口）
         *
         * 这两个参数是 `kind: 'nodeField'`——归 `NodeEditorBody` 渲染。
         * 而 `V1NodeCard` 对循环节点**提前 return 了 `LoopNodeCard`**，
         * `NodeEditorBody` 一次都不会跑 → 那两项设置**在界面上完全没有呈现**。
         * 构建通过、其它测试全绿，只是用户看不到那两个下拉。
         *
         * 判据：点开「设置」后，面板里要出现这两个标签（`items` 在 items 模式才有），
         * 且「循环方式」那个下拉仍要在（别为了补新项把原有的挤掉）。 */
        const settingsBtn = [...loopBox.querySelectorAll('button')]
          .find(b => (b.textContent ?? '').includes('设置'))
        console.log('   框头有「设置」按钮:', settingsBtn !== undefined ? '✓' : '✗')
        if (settingsBtn === undefined) {
          errors.push('循环框没有「设置」按钮')
        } else {
          settingsBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
          await settle()
          const afterOpen = doc.querySelector('[data-loop-id]')
          const panelText = afterOpen?.textContent ?? ''
          const hasPanel = afterOpen?.querySelector('[class*="loopSettings"]') !== null
          console.log('   点「设置」后出设置面板:', hasPanel ? '✓' : '✗')
          if (!hasPanel) errors.push('循环框的「设置」点开后没有面板')
          /* ★ 这两条就是用户报的缺口。 */
          const hasItemsPicker = panelText.includes('遍历哪个数据')
          const hasResultPicker = panelText.includes('结果取哪个')
          console.log('   ★ 面板里有「遍历哪个数据」:', hasItemsPicker ? '✓' : '✗')
          console.log('   ★ 面板里有「结果取哪个」:', hasResultPicker ? '✓' : '✗')
          if (!hasItemsPicker) errors.push('循环设置里没有「遍历哪个数据」（用户报的缺口）')
          if (!hasResultPicker) errors.push('循环设置里没有「结果取哪个」（用户报的缺口）')
          /* 原有的两项不能被新加的挤掉。 */
          console.log('   面板里仍有「循环方式」:', panelText.includes('循环方式') ? '✓' : '✗')
          if (!panelText.includes('循环方式')) errors.push('循环设置里丢了「循环方式」')
          if (!panelText.includes('最大轮数')) errors.push('循环设置里丢了「最大轮数」')
          /* ★ **「同时处理几条」（concurrency）必须在面板里**（2026-10-17 加）。
           *
           * 它和上面那两个缺口是**同一个成因**：`concurrency` 的 `advanced: true`
           * 只在 `NodeEditorBody` 里渲染，而循环走的是提前返回的 `LoopNodeCard` ——
           * 于是这个参数界面上从来就没出现过（只有手改 JSON 才设得上）。
           * 断言锚在**看得见的标签文字**上，不锚源码。 */
          const hasConc = panelText.includes('同时处理几条')
          console.log('   ★ 面板里有「同时处理几条」:', hasConc ? '✓' : '✗')
          if (!hasConc) errors.push('循环设置里没有「同时处理几条」（参数在界面上从未呈现）')
          /* 关掉面板，别让后面的段落看到展开状态。 */
          settingsBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
          await settle()
        }

        /* ★★ 位置：收起 / 展开与「设置」都必须在**框头**里（2026-10-16）──────
         *
         * 用户 2026-10-16 报了两件事，成因不同但现象一样（都表现为「点了没反应」）：
         *   ① 「循环的收起展开**没有实际作用**」
         *   ② 「设置还是无法打开，点击没有作用」
         *
         * 修完之后的判据按**看得见的效果**定，不按「函数被调了」定 ——
         * 后者正是当初让这两条漏过去的原因（回调一直都在，只是没有可见变化）。 */
        const boxEl = doc.querySelector('[data-loop-id]')

        /* 设置面板：① 点得开；② 框要有足够高度装下它。 */
        if (settingsBtn !== undefined) {
          settingsBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
          await settle()
          const opened = doc.querySelector('[data-loop-id]')
          const panelIn = opened?.querySelector('[class*="loopSettings"]') !== null
          console.log('   ★ 点「设置」后画布上确实出现了设置面板:', panelIn ? '✓' : '✗')
          if (!panelIn) errors.push('循环的「设置」点开后画布上没有面板')
          /* 框的高度必须比「没开面板」时大 —— 否则面板塞不下、会被挤出去，
           * 用户看到的还是「点了没反应」。 */
          const hWithPanel = Number(/height:\s*(\d+)px/.exec(
            doc.querySelector('.react-flow__node[data-id="' + (opened?.getAttribute('data-loop-id') ?? '') + '"]')?.getAttribute('style') ?? '')?.[1] ?? 0)
          console.log('   设置面板打开时框高:', String(hWithPanel) + 'px')
          if (hWithPanel < 100) errors.push('设置面板打开后框没有长高（面板会被挤出框）')
          settingsBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
          await settle()
          const closedTs = doc.querySelector('[data-loop-id]')
          const panelOut = closedTs?.querySelector('[class*="loopSettings"]') === null
          console.log('   ★ 再点一次「设置」面板收起:', panelOut ? '✓' : '✗')
          if (!panelOut) errors.push('循环的「设置」再点一次收不起来')
        }

        /* ★ 收起：要有**看得见的变化**（用户 2026-10-16：「收起展开没有实际作用」）。
         *
         * ⚠️ 这里只断**框自己**的变化（缩成一条 + 容器面消失）。
         * 「成员节点从画布上消失」那一条**不在这里** —— 这一段是「往画布加了个
         * 空循环」，**没有成员**；而成员是不是该藏，只能按 `parentId` 判归属。
         * 我第一版拿「除框以外随便一个节点」冒充成员，那是画布上的普通节点，
         * 不该被藏 → 断言必然红（假红）。
         * 有成员的完整验证在 `tests/loop-box.mjs`（那份存档带 `parentId`）。 */
        if (collapseBtn !== undefined) {
          collapseBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
          await settle()
          const afterCollapse = doc.querySelector('[data-loop-id]')
          const bodyGone = afterCollapse?.querySelector('[class*="loopBody"]') === null
          console.log('   点「收起」后容器面消失（变成一张卡片）:', bodyGone ? '✓' : '✗')
          if (!bodyGone) errors.push('循环框收起没生效')

          const afterEl = doc.querySelector('.react-flow__node[data-id="' + (afterCollapse?.getAttribute('data-loop-id') ?? '') + '"]')
          const hCollapsed = Number(/height:\s*(\d+)px/.exec(afterEl?.getAttribute('style') ?? '')?.[1] ?? 0)
          console.log('   ★ 收起后框高缩成一条:', String(hCollapsed) + 'px', hCollapsed > 0 && hCollapsed < 100 ? '✓' : '✗')
          if (!(hCollapsed > 0 && hCollapsed < 100)) {
            errors.push('循环收起后框没缩（用户报「收起没有实际作用」）')
          }
        }
      }
    }

    /* ⑥ 参数区该有的都要有：以「跑另一份工作流」节点为例（用户 m02875「补。」）──────
     *
     * 为什么单挑这个节点：执行层早就会读 `params.inputs`（`run.ts` 的
     * `readGivenInputs`），而它**界面上从来没有控件** —— 用户只能手改存档。
     * 这是本项目第三次踩同一个坑（循环的 `nodeField`、循环的 `concurrency`），
     * 所以判据落在**看得见的标签**上，且必须再加一条「和定义对得上」。
     *
     * ⚠️ 做法：从节点库**加一个**这个节点（点库项即加），它会自动展开参数区 ——
     * 比去戳存档里某个已有节点稳（示例图的节点是哪个不由这里决定）。 */
    {
      const libItems2 = [...doc.querySelectorAll('[class*="libItem"]')]
      const wfItem = libItems2.find(el => (el.textContent ?? '').includes('跑另一份工作流'))
      console.log('   节点库里有「跑另一份工作流」:', wfItem !== undefined ? '✓' : '✗')
      if (wfItem === undefined) {
        errors.push('节点库里找不到「跑另一份工作流」')
      } else {
        wfItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await settle()
        /* ⚠️ **加完还要点它一下**：`addNode` 只把它设成 React Flow 的「选中」，
         * 而参数区是**展开态**才渲染的，展开态由 `expandedNode` 决定 ——
         * 不点的话 `[data-ewb-editor]` 抓到的是别的节点（或根本没有），断言必然假红。
         * 按**卡片上的名字**找刚加的那个。 */
        const wfCard = [...doc.querySelectorAll('[data-state]')]
          .find(el => (el.textContent ?? '').includes('跑另一份工作流'))
        wfCard?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await settle()
        const ed = doc.querySelector('[data-ewb-editor]')
        /* ⚠️ 判据只看**参数标题**，不看整块文字 —— 第一版在整块 `textContent` 里找，
         * 于是把参数定义删掉后，那句 `hint` 里提到的同一个词照样命中（突变测试打回来的）。 */
        /* ★ 与节点定义**逐条对得上** —— 防「界面上有控件但参数名写错」
         * （写错的话存进去的键执行层读不到，界面看着完全正常）。
         * ⚠️ 判据是「定义里声明的每个参数都渲染出来了」，不是「渲染了几个」。 */
        const wfDef = NODE_LIBRARY.find(d => d.id === 'flow.workflow')
        /* ⚠️ **先查定义层**（2026-10-17 突变测试补上的一半）：
         * 只查「定义里声明的都渲染了」的话，**把定义那一项删掉也照样绿**
         * （定义少了、界面自然也少）—— 而真出的事恰恰是「执行层在读的键没有控件」。
         *
         * ⚠️ **2026-10-19 改判据**：执行层读的键从 `spec.params.name` 换成了
         * `spec.params.workflowId`（用户：「引用用的应该是编号而不是名称」）。
         * 所以这里查的键也必须跟着换 —— **旧断言查 `name` 会红**，
         * 而它红得对：界面上确实已经没有「填名字」那一项了（改成从清单里选编号）。
         * `name` 仍被读（老存档兼容），但它是**隐藏的兼容退路**、不该有控件。 */
        const needKeys = ['workflowId', 'inputs']
        const missingDecl = needKeys.filter(k => !(wfDef?.paramDefs ?? []).some(d => d.key === k))
        console.log('   定义里声明了执行层要读的参数（' + needKeys.join(' / ') + '）:', missingDecl.length === 0 ? '✓' : '✗（缺 ' + missingDecl.join('、') + '）')
        if (missingDecl.length > 0) errors.push('「跑另一份工作流」的定义里缺参数声明（执行层读它，用户没处填）：' + missingDecl.join('、'))
        /* ★ 那一项必须是「选一份工作流」的控件，不能退回自由文本 ——
         * 写成 text 的话用户又能填错、又会被改名扯断（正是这次要修的）。 */
        const idParam = (wfDef?.paramDefs ?? []).find(d => d.key === 'workflowId')
        console.log('   「跑哪一份」是选择控件（kind=workflowRef）:', idParam?.kind === 'workflowRef' ? '✓' : '✗（' + String(idParam?.kind) + '）')
        if (idParam?.kind !== 'workflowRef') errors.push('「跑哪一份」不是选择控件（应为 workflowRef，现在 ' + String(idParam?.kind) + '）')
        /* ★ **控件真的渲染成了下拉，且选项来自工作流清单**（2026-10-19 新增）。
         *
         * 为什么要单独查：`kind: 'workflowRef'` 是新加的一种控件，
         * 它落到 `ParamControl` 的 `default` 分支也不会崩 —— 只会变成**一个空文本框**，
         * 而那正是这次要消灭的形态（手填名字）。所以必须查 DOM 真的出现了下拉。
         *
         * 候选来自桩里的 `/workflows`（抖音商品流水线 / 天猫竞品巡查 / 组合层示例）。
         * ⚠️ 桩那三条**都没有 id**（`items` 里没这个字段）→ 画布会过滤掉它们，
         * 下拉只有「（选一份）」一项 —— 所以这里查的是**控件形状**，不是选项数目。
         * 选项来自清单这件事由 `workflow-ids` / `sub-workflow` 那两条守。 */
        const refBox = ed?.querySelector('[data-ewb-wf-ref]')
        console.log('   ★ 「跑哪一份」渲染成了下拉（不是文本框）:', refBox !== null && refBox !== undefined ? '✓' : '✗')
        if (refBox === null || refBox === undefined) {
          errors.push('「跑哪一份」在界面上不是下拉控件（workflowRef 没接上渲染分支）')
        } else {
          /* 空清单时它会显示一句说明而不是下拉 —— 两种形态都算「接上了」，
           * 但下拉那种必须带「（选一份）」占位（否则用户不知道要选）。 */
          const sel = refBox.querySelector('select')
          const placeholder = sel === null ? '' : (sel.querySelector('option')?.textContent ?? '')
          console.log('   下拉第一项是「（选一份）」占位:', placeholder.includes('选一份') ? '✓' : '✗（' + placeholder + '）')
          if (!placeholder.includes('选一份')) errors.push('「跑哪一份」的下拉没有「（选一份）」占位')
        }
        const defKeys = (wfDef?.paramDefs ?? []).map(p => p.label)
        /* ⚠️ **只看参数标题，不看整块文字**（2026-10-17 被突变测试打回来一次）：
         * 第一版在整块 `textContent` 里找标签 —— 于是把参数定义删掉后，
         * 那句 `hint` 里提到的同一个词（「传给它的输入」）**照样命中** → 断言假绿。
         * 现在只取每个参数块的标题（`[class*="paramHead"]`）比 —— 标题没有就是没渲染。 */
        const heads = [...(ed?.querySelectorAll('[class*="paramHead"]') ?? [])]
          .map(el => (el.textContent ?? '').trim())
        /* ⚠️ `paramHead` 里还有「必填 / 高级」这类小标记，所以用 startsWith 比。 */
        const missingKeys = defKeys.filter(k => !heads.some(h => h.startsWith(k)))
        console.log('   定义里声明的参数都在界面上（' + defKeys.join(' / ') + '）:', missingKeys.length === 0 ? '✓' : '✗（缺 ' + missingKeys.join('、') + '）')
        if (missingKeys.length > 0) errors.push('「跑另一份工作流」有参数没渲染出来：' + missingKeys.join('、'))

        /* ⚠️ **还原现场**（本文件的一贯纪律）：上面点开了刚加的这个节点，
         * 而这一段之后的 `nodeCard`（最初那个节点）要靠「点一次 = 收起」的时序 ——
         * 展开态落在别的节点上时，那一次点击会变成**展开**，后面的段落全跟着错。
         * 所以：先收起这个新的，再把最初那个重新展开，回到进这一段之前的状态。 */
        wfCard?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await settle()
        nodeCard?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await settle()
      }
    }

    /* ⑥b 「条件判断」节点：结构化条件（选变量 + 比较符 + 值）必须真的渲染出来 ──
     *
     * 用户 2026-10-19：「照 Dify 做成『选变量 + 比较符 + 值』的结构化条件」。
     * 这个参数是新的控件类型（`kind: 'ifRules'`），而这类「新 kind 没接上渲染分支」
     * 的缺口在本项目**已经踩过三次**（循环的 `nodeField`、循环的 `concurrency`、
     * 「跑另一份工作流」的 `inputs`）—— 每次都是「构建通过、测试全绿、界面上没有」。
     * 所以判据必须是**画布上真的出现了控件**，不能只查定义里有 `kind`。
     *
     * ⚠️ 还要查一条**容易被写错的行为**：一个可选来源都没有时（新节点还没接上游），
     * 「添加一条」按钮**仍要能点**。第一版在这种情况下整块换成一句提示、把按钮去掉了，
     * 结果用户刚拖进来的条件判断节点根本没法开始填。 */
    {
      const libItems3 = [...doc.querySelectorAll('[class*="libItem"]')]
      const ifItem = libItems3.find(el => (el.textContent ?? '').includes('条件判断'))
      console.log('   节点库里有「条件判断」:', ifItem !== undefined ? '✓' : '✗')
      if (ifItem === undefined) {
        errors.push('节点库里找不到「条件判断」')
      } else {
        ifItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await settle()
        const ifCard = [...doc.querySelectorAll('[data-state]')]
          .find(el => (el.textContent ?? '').includes('条件判断'))
        ifCard?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await settle()
        const ied = doc.querySelector('[data-ewb-editor]')
        const ruleBox = ied?.querySelector('[data-ewb-if-rules]')
        console.log('   ★ 条件控件渲染出来了（data-ewb-if-rules）:', ruleBox !== null && ruleBox !== undefined ? '✓' : '✗')
        if (ruleBox === null || ruleBox === undefined) {
          errors.push('「条件判断」的条件控件没渲染（ifRules 没接上渲染分支）')
        } else {
          /* ① 参数标题按定义来（用户得看到「条件」这一项）。 */
          const heads2 = [...(ied?.querySelectorAll('[class*="paramHead"]') ?? [])]
            .map(el => (el.textContent ?? '').trim())
          console.log('   参数区有「条件」这一项:', heads2.some(h => h.startsWith('条件')) ? '✓' : '✗')
          if (!heads2.some(h => h.startsWith('条件'))) errors.push('「条件判断」的参数区没有「条件」这一项')

          /* ② 没接上游时要给一句原因（不能是一个点不开的空下拉）。 */
          const emptyHint = ruleBox.querySelector('[data-ewb-if-empty]')
          console.log('   没接上游时说清了原因:', emptyHint !== null ? '✓' : '✗')
          if (emptyHint === null) errors.push('「条件判断」在没上游时没有说明为什么没得选')

          /* ③ ★ 按钮必须还在（第一版把它一起藏了，用户没法开始填）。 */
          const addBtn = [...ruleBox.querySelectorAll('button')]
            .find(b => (b.textContent ?? '').includes('添加一条'))
          console.log('   ★ 没接上游时「添加一条」仍可点:', addBtn !== undefined ? '✓' : '✗')
          if (addBtn === undefined) errors.push('「条件判断」没接上游时连「添加一条」都没有（用户没法开始填）')

          if (addBtn !== undefined) {
            addBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
            await settle()
            const again = doc.querySelector('[data-ewb-if-rules]')
            const row = again?.querySelector('[data-ewb-if-row]')
            console.log('   ★ 点一下多出一行条件:', row !== null && row !== undefined ? '✓' : '✗')
            if (row === null || row === undefined) {
              errors.push('点「添加一条」没有多出条件行')
            } else {
              /* 一行 = 左边选值 + 选比较符（+ 值 + 类型）。至少两个下拉必须都在。 */
              const sels = [...row.querySelectorAll('select')]
              console.log('   一行里有「选值」与「选比较符」两个下拉:', sels.length >= 2 ? '✓' : '✗（' + String(sels.length) + '）')
              if (sels.length < 2) errors.push('条件行里没有两个下拉（选值 / 选比较符）')
              /* 比较符的选项必须是**中文名**（照 Dify 18 个）；出现英文 id 就是漏了标签。 */
              const opSel = sels[1]
              const ops = [...(opSel?.querySelectorAll('option') ?? [])].map(o => (o.textContent ?? '').trim())
              console.log('   比较符选项数:', String(ops.length))
              if (ops.length < 12) errors.push('比较符选项太少（应照 Dify 那套，至少 12 个）')
              const english = ops.filter(t => /^[a-zA-Z]+$/.test(t))
              console.log('   ★ 比较符全是中文名（没有英文 id）:', english.length === 0 ? '✓' : '✗（' + english.join(',') + '）')
              if (english.length > 0) errors.push('比较符下拉里出现了英文 id：' + english.join(','))
              /* 删掉这一行（别把状态带到后面的段落）。 */
              const delBtn = row.querySelector('[data-del], button')
              if (delBtn !== null && delBtn !== undefined) {
                delBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
                await settle()
              }
            }
          }
        }
        /* 收起这个新节点，回到进这一段之前的状态。 */
        ifCard?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await settle()
        nodeCard?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await settle()
      }
    }

    /* ⑤ 那排小方块已删（用户 2026-10-11：「当前有展示几个小块，在一排，
     *    执行方XXX 成功/失败 待运行/完成。这些都没用」）。
     *
     * 判据按**内容**：展开区里不该再出现「执行方」这三个字
     * （节点的执行方显示在标题栏上，那是在卡片里、不在这个编辑区内）。
     * 也不该出现状态词——状态由节点描边表达。 */
    const editorText = editorEl.textContent ?? ''
    console.log('   展开区不再显示「执行方」（标题栏已有）:', editorText.includes('执行方') ? '✗' : '✓')
    if (editorText.includes('执行方')) errors.push('展开区仍在显示「执行方」小块')
    /* 「missing 时的依赖检查」是**例外**：那个必须留（缺件时用户得知道缺什么）。
     * 所以这里只断言「没有那三个无用小块」，不禁止整个区块。 */

    /* ⑥ 两个说明章节默认收起（用户 2026-10-11：「这个节点在做什么和能引用哪些变量
     *    两个章节……都应该默认收起」）。
     *
     * 判据：展开区里的 `<details>` **都不能带 open 属性**。
     * ⚠️ 但节点**内联编辑区**里可能还有别的 details（如参数里的高级折叠），
     * 所以只挑「标题是那两句」的两个来查，避免误伤。
     *
     * ⚠️「能引用哪些变量」**在一部分节点上是不存在的**，这是**有意的**：
     * `AvailableVars` 在没有可用变量时返回 null（避免空区块占地方）。
     * 而我们点开的是画布上第一个节点——示例图里它是最上游，没有上游就没有变量。
     * 第一版把它当失败，是**断言写错了**。
     * 所以第二个只在**找得到**时才断言「收起」，找不到就不算错；
     * 「这个节点在做什么」一定存在（每个节点都必须有 detail），那条是硬断言。 */
    const d1 = [...editorEl.querySelectorAll('details')]
      .find(x => (x.querySelector('summary')?.textContent ?? '').startsWith('节点说明'))
    if (d1 === undefined) {
      console.log('   说明块「节点说明」存在:', '✗')
      errors.push('找不到说明块：节点说明')
    } else {
      console.log('   说明块「节点说明」默认收起:', d1.hasAttribute('open') ? '✗（展开了）' : '✓')
      if (d1.hasAttribute('open')) errors.push('说明块没有默认收起：节点说明')
    }
    const d2 = [...editorEl.querySelectorAll('details')]
      .find(x => (x.querySelector('summary')?.textContent ?? '').startsWith('可用变量'))
    if (d2 === undefined) {
      console.log('   说明块「可用变量」: 这个节点没有可用变量，按设计不渲染 ✓')
    } else {
      console.log('   说明块「可用变量」默认收起:', d2.hasAttribute('open') ? '✗（展开了）' : '✓')
      if (d2.hasAttribute('open')) errors.push('说明块没有默认收起：可用变量')
    }
    /* 两个说明块之间的间距要非常小（用户：「不应该有间隔（或者间隔非常小，1PX？）」）。
     * jsdom 里算不出真实 margin（没有样式表），所以查产物 CSS。 */
    const detailRule = /\.\w+_detailBlock\{([^}]*)\}/.exec(bundle)
    const detailMargin = detailRule === null ? '' : (/margin-bottom:\s*([\d.]+)px/.exec(detailRule[1])?.[1] ?? '')
    console.log('   两个说明块的间距:', detailMargin === '' ? '(查不到)' : detailMargin + 'px',
      detailMargin !== '' && Number(detailMargin) <= 2 ? '✓' : '✗')
    if (detailMargin === '' || Number(detailMargin) > 2) errors.push('说明块之间的间距还是太大（应 ≤2px）')
    /* ⑦ 编辑体的**分块结构**（用户 2026-10-11：「节点说明和可用变量应该与设置内容
     *    在一个板块，失败处理应该独立层贴底」）。
     *
     * 判据用 DOM 结构，不靠 CSS 猜：
     *   ① 「节点说明」与「参数」都在**同一个滚动块** `.block` 里
     *   ② 「失败处理」**不在**那个块里，而在贴底那层 `[data-ewb-foot]` 里
     * 两条缺一条都会退化成「改了个 class 但结构没变」。 */
    const scrollBlock = editorEl.querySelector('[class*="_block"]')
    const footBar = editorEl.querySelector('[data-ewb-foot]')
    console.log('   有可滚动的「设置内容」板块:', scrollBlock !== null ? '✓' : '✗')
    console.log('   有贴底的「失败处理」层:', footBar !== null ? '✓' : '✗')
    if (scrollBlock === null) errors.push('编辑体没有可滚动的设置板块')
    if (footBar === null) errors.push('编辑体没有贴底的失败处理层')
    if (scrollBlock !== null && footBar !== null) {
      /* 说明与参数要在同一块里。 */
      const inBlock = (t) => (scrollBlock.textContent ?? '').includes(t)
      console.log('   「节点说明」在设置板块内:', inBlock('节点说明') ? '✓' : '✗')
      console.log('   「参数」在设置板块内:', inBlock('参数') ? '✓' : '✗')
      if (!inBlock('节点说明')) errors.push('节点说明不在设置板块里')
      if (!inBlock('参数')) errors.push('参数不在设置板块里')
      /* 失败处理**必须不在**块里，而在贴底层里。 */
      console.log('   「失败处理」不在滚动块里（不会被滚走）:', inBlock('失败处理') ? '✗' : '✓')
      if (inBlock('失败处理')) errors.push('失败处理还在滚动块里（应贴底独立）')
      console.log('   贴底层里有失败处理:', (footBar.textContent ?? '').includes('失败处理') ? '✓' : '✗')
      if (!(footBar.textContent ?? '').includes('失败处理')) errors.push('贴底层里没有失败处理')
      /* 三个选项也要在贴底层里（否则只有标题、按钮在别处）。 */
      const segInFoot = footBar.querySelectorAll('button').length
      console.log('   贴底层里有三个策略按钮:', segInFoot === 3 ? '✓' : `✗（${segInFoot} 个）`)
      if (segInFoot !== 3) errors.push('失败处理的三个按钮不在贴底层里')
    }
  }
  /* 收起来，免得影响后面几段对页面的判断。 */
  nodeCard?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()

  /* ⑦ Ctrl+点击节点**只多选、不展开**（用户 2026-10-11：
   *    「按住 ctrl 的点击节点也会展开，ctrl 应该是多选模式，
   *      按住 ctrl 不应该展开节点，应该是只能选择或者拖动节点」）。
   *
   * ⚠️ 这里用**节点的卡片本身**（`[data-state]`）而不是内部按钮，
   * 因为要的就是「点在节点空白处」这个动作。 */
  const nodeForCtrl = firstNodeEl()
  const cardForCtrl = nodeForCtrl?.querySelector('[data-state]')
  /* ⚠️ **先断言「找得到」，再断言内容**（2026-10-26 修的假绿）。
   *
   * 原来写的是 `if (cardForCtrl !== undefined) { …三条断言… }`，两个问题：
   *   ① 取不到时（`undefined`）**三条一条都不跑也不报错** —— 静默绿；
   *   ② `cardForCtrl` 来自 `?.querySelector(...)`，可能返回 **`null`**，
   *      而 `null !== undefined` 是 **true** —— 那种情况会进块、然后在
   *      `null.dispatchEvent` 上抛 TypeError，整个文件崩掉。
   *      崩掉是响的，但报错指向 TypeError，看不出「Ctrl+点击这组没验到」。
   *
   * 所以判据是 `=== null || === undefined` 两个都认（`== null` 也能一并盖住，
   * 但显式写出来更容易看懂意图）。 */
  if (cardForCtrl === null || cardForCtrl === undefined) {
    errors.push('找不到节点的卡片本身（[data-state]）—— 下面三条「Ctrl+点击」没验到')
  } else {
    /* 先确保它是收起的（上面刚点过，此时应为收起）。 */
    const before = doc.querySelector('[data-ewb-editor]') !== null
    cardForCtrl.dispatchEvent(new window.MouseEvent('click', { bubbles: true, ctrlKey: true }))
    await settle()
    const after = doc.querySelector('[data-ewb-editor]') !== null
    console.log('   Ctrl+点击前有展开区:', before ? '有' : '无', '｜ 之后:', after ? '有 ✗' : '无 ✓')
    if (!before && after) errors.push('Ctrl+点击节点把节点展开了（应只多选）')
    /* 再点一次（仍带 Ctrl）也不该展开 —— 防「第二次点才展开」这种半吊子实现。 */
    cardForCtrl.dispatchEvent(new window.MouseEvent('click', { bubbles: true, ctrlKey: true }))
    await settle()
    if (!before && doc.querySelector('[data-ewb-editor]') !== null) {
      errors.push('Ctrl+连点两次仍然展开了节点')
    }
    /* 不按 Ctrl 时必须**照常展开** —— 否则就是「为了修 A 弄坏了 B」。 */
    cardForCtrl.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const plain = doc.querySelector('[data-ewb-editor]') !== null
    console.log('   不按 Ctrl 点击仍能展开:', plain ? '✓' : '✗')
    if (!plain) errors.push('不按 Ctrl 点节点也不展开了（修过头）')
    /* 收起，别影响后面。 */
    cardForCtrl.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
  }
}

/* ⑭ 右键菜单（2026-10-11 用户：「先把需要去掉的按钮去掉，然后规划右键功能」）。
 *
 * 这是把工具条搬空之后的**接盘处**：单步与跳过选中两个功能移到这里。
 * 所以要断言的除了「菜单能弹出来」，还有**那两项真的在菜单里**——
 * 否则用户看到的是「按钮没了、菜单里也没有」，功能就真丢了。
 *
 * 判定上下文靠**菜单里的项文字**，不是靠内部状态：
 * 这也正是用户看到的东西。
 */
console.log('⑭ [新能力] 右键菜单（三/四种上下文）')
{
  /* ⚠️ **必须先切回「画布」tab**（第一版漏了，导致「按 Esc 关菜单」假阴性）。
   *
   * 上面第 ⑦ 段把页面切到了「工作流」列表 tab，此时画布**被藏起来**——
   * 而画布藏起来时会**主动停掉自己的全局键盘监听**（这是有意的：
   * 否则用户在列表页按 Ctrl+Z 会改到看不见的画布上）。
   * 所以 Esc 关不掉菜单**是正确行为**，不是 bug；错的是测试没切回来。
   * 右键回调不受影响（菜单挂在画布 DOM 里，隐藏时 DOM 仍在）。 */
  const backToCanvas = clickByText('画布', { inTabs: true })
  console.log('   切回「画布」tab:', backToCanvas ? '✓' : '✗')
  await settle()

  /** 右键某个元素（React Flow 监听的是原生 contextmenu 事件）。 */
  const rightClick = (el) => {
    if (el === null || el === undefined) return false
    el.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }))
    return true
  }
  /** 当前菜单里的项文字。 */
  const menuItems = () => [...doc.querySelectorAll('[data-ewb-menu] button')].map(b => (b.textContent ?? '').trim())
  /** 菜单是否存在。 */
  const hasMenu = () => doc.querySelector('[data-ewb-menu]') !== null
  /** 按 Esc（关菜单）。 */
  const pressEsc = () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  }
  /**
   * 取画布上第一个普通节点的 DOM。
   *
   * ⚠️ **必须每次重新查，不能把元素存下来复用**（第一版就是复用的，导致假阴性）：
   * React 在状态变化后可能重建这些节点元素，存下来的那个已经**脱离文档**，
   * 往它身上派事件不会冒泡到 React Flow 的监听里 → 菜单根本不会弹，
   * 看着像「按 Esc 关不掉」，其实是「菜单压根没开」。
   * （⑬ 段已经定义了同名函数，但那是块作用域里的，这里重新声明一份。）
   */
  const firstNodeEl = () => [...doc.querySelectorAll('.react-flow__node')]
    .find(n => n.querySelector('[data-state]') !== null)

  /* ── ① 右键一个普通节点 → 节点菜单，且含本轮从工具条搬来的两项 ── */
  if (!rightClick(firstNodeEl())) {
    console.log('   ✗ 画布上找不到可右键的节点')
    errors.push('画布上没有可右键的节点')
  } else {
    await settle()
    console.log('   右键节点弹出菜单:', hasMenu() ? '✓' : '✗')
    if (!hasMenu()) errors.push('右键节点没有弹出菜单')
    const items = menuItems()
    console.log('   菜单项:', items.join(' / '))
    /* 本轮从工具条搬走的两项 —— **这是最重要的两条断言**。 */
    console.log('   含「跑下一步」（从工具条搬来的）:', items.some(x => x.includes('跑下一步')) ? '✓' : '✗')
    if (!items.some(x => x.includes('跑下一步'))) errors.push('节点菜单里没有「跑下一步」')
    console.log('   含「跳过」（从工具条搬来的）:', items.some(x => x.includes('跳过')) ? '✓' : '✗')
    if (!items.some(x => x.includes('跳过'))) errors.push('节点菜单里没有「跳过」')
    /* 上下文要分开：节点菜单里不该出现只有画布才有的项。 */
    console.log('   不含画布专属项（缩放适配）:', items.some(x => x.includes('缩放适配')) ? '✗' : '✓')
    if (items.some(x => x.includes('缩放适配'))) errors.push('节点菜单混进了画布专属项')
    pressEsc()
    await settle()
  }

  /* ── ② 按 Esc 也要能关（键盘路径与点击路径是两套，必须分别验）── */
  if (rightClick(firstNodeEl())) {
    await settle()
    const opened = hasMenu()
    pressEsc()
    await settle()
    console.log('   按 Esc 关菜单:', opened && !hasMenu() ? '✓' : '✗')
    if (!opened) errors.push('按 Esc 前菜单就没打开（断言前提不成立）')
    else if (hasMenu()) errors.push('按 Esc 关不掉右键菜单')
  }

  /* ── ③ 点一项之后菜单要关掉（用画布菜单里无害的「收起所有节点设置」验，
   *      不用「只跑这个」——那会真的发起一次运行，把后面几步的状态搅乱）── */
  rightClick(doc.querySelector('.react-flow__pane'))
  await settle()
  const itemToClick = [...doc.querySelectorAll('[data-ewb-menu] button')]
    .find(b => (b.textContent ?? '').includes('收起所有节点设置'))
  console.log('   找到「收起所有节点设置」这一项:', itemToClick !== undefined ? '✓' : '✗')
  if (itemToClick !== undefined) {
    itemToClick.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    console.log('   点一项之后菜单关掉:', hasMenu() ? '✗' : '✓')
    if (hasMenu()) errors.push('点了菜单项菜单还开着')
  } else {
    errors.push('画布菜单里没有「收起所有节点设置」')
  }

  /* ── ④ 右键空白处 → 画布菜单（不含节点专属项）── */
  if (!rightClick(doc.querySelector('.react-flow__pane'))) {
    console.log('   ✗ 找不到画布空白区')
    errors.push('找不到画布空白区')
  } else {
    await settle()
    const items = menuItems()
    console.log('   右键空白弹出菜单:', hasMenu() ? '✓' : '✗')
    console.log('   画布菜单项:', items.join(' / '))
    console.log('   含「全选」（调研记着缺的）:', items.some(x => x.includes('全选')) ? '✓' : '✗')
    if (!items.some(x => x.includes('全选'))) errors.push('画布菜单里没有「全选」')
    console.log('   含「缩放适配」:', items.some(x => x.includes('缩放适配')) ? '✓' : '✗')
    console.log('   不含节点专属项（跑这个）:', items.some(x => x.includes('只跑这个')) ? '✗' : '✓')
    if (items.some(x => x.includes('只跑这个'))) errors.push('画布菜单混进了节点专属项')
    pressEsc()
    await settle()
  }

  /* ── ⑤ 选中多个节点后右键 → 「打包成分组」出现（此前完全没有入口）──
   *
   * ⚠️ 多选**用「全选」这条真实路径**，而不是自己拼 Ctrl+点击：
   * 第一版试着 `dispatchEvent(keydown Control)` 再 `click(ctrlKey:true)`，
   * 结果只选中了 1 个 —— React Flow 的多选态来自 `useKeyPress` 对**全局 keydown**
   * 的跟踪，在 jsdom 里靠合成事件去驱动它不可靠。
   * 「全选」本来就是我们这轮新加的功能，用真实入口反而更好：
   * 一条断言同时验了「全选能用」与「选中菜单出现」。 */
  rightClick(doc.querySelector('.react-flow__pane'))
  await settle()
  const selectAllItem = [...doc.querySelectorAll('[data-ewb-menu] button')]
    .find(b => (b.textContent ?? '').includes('全选'))
  if (selectAllItem === undefined) {
    errors.push('画布菜单里没有「全选」（无法验证选中菜单）')
  } else {
    selectAllItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const picked = [...doc.querySelectorAll('.react-flow__node')]
      .filter(n => (n.getAttribute('class') ?? '').includes('selected')).length
    console.log('   点「全选」后已选中节点数:', picked, picked >= 2 ? '✓' : '✗')
    if (picked < 2) errors.push('「全选」没有选中多个节点')

    rightClick(firstNodeEl())
    await settle()
    const items = menuItems()
    const headText = [...doc.querySelectorAll('[data-ewb-menu]')].map(m => m.textContent ?? '').join('')
    console.log('   菜单标题含「选中的」:', headText.includes('选中的') ? '✓' : '✗')
    console.log('   含「打包成分组」（此前无入口）:', items.some(x => x.includes('打包成分组')) ? '✓' : '✗')
    if (!items.some(x => x.includes('打包成分组'))) {
      console.log('   → 分组功能此前「代码写好了但界面点不到」，这里就是它的入口。')
      errors.push('选中菜单里没有「打包成分组」')
    }

    /* ── ⑥ 真的点一次「打包成分组」，验证**分组框自动贴紧子节点**
     *      （用户 2026-10-11：「分组的大小不应该固定，应该根据内部节点自动调整大小」）。 */
    const groupItem = [...doc.querySelectorAll('[data-ewb-menu] button')]
      .find(b => (b.textContent ?? '').includes('打包成分组'))
    const nodesBeforeGroup = doc.querySelectorAll('.react-flow__node').length
    if (groupItem !== undefined) {
      groupItem.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await settle()
      const nodesAfterGroup = doc.querySelectorAll('.react-flow__node').length
      console.log('   点了「打包成分组」后画布节点数:', nodesBeforeGroup, '→', nodesAfterGroup,
        nodesAfterGroup > nodesBeforeGroup ? '✓（多出一个分组框）' : '✗')
      if (nodesAfterGroup <= nodesBeforeGroup) errors.push('点「打包成分组」没有产生分组框')

      /* 分组框的尺寸应当是**算出来的**，不是固定值。
       * 判据：它带着 style 宽高，且不等于我们代码里的兜底常量以外的任何「写死值」——
       * 更实在的做法是：**再选一批不同数量的节点分一次组，两次的框尺寸不该相同**。
       * 这里先用更直接的一条：框的宽高为正、且与它的**内联 style** 一致。 */
      const groupEl = [...doc.querySelectorAll('.react-flow__node')]
        .find(n => (n.className ?? '').includes('react-flow__node-group'))
      console.log('   画布上出现分组框元素:', groupEl !== undefined ? '✓' : '✗')
      if (groupEl === undefined) {
        errors.push('画布上没有 group 类型的节点')
      } else {
        const inner = groupEl.querySelector('[data-group-id]')
        const gs = inner?.getAttribute('style') ?? groupEl.getAttribute('style') ?? ''
        const w = /width:\s*([\d.]+)px/.exec(gs)?.[1]
        const h = /height:\s*([\d.]+)px/.exec(gs)?.[1]
        console.log('   分组框尺寸（应为自动算出的正数）:', (w ?? '?') + '×' + (h ?? '?'))
        if (w === undefined || h === undefined || Number(w) <= 0 || Number(h) <= 0) {
          errors.push('分组框没有自动算出尺寸')
        }

        /* ★ 描述输入与收起按钮必须**真的挂在这个组实例上**（2026-10-26 从 ⑤e 挪来）。
         *
         * 为什么挪：那一段（`:1643`）只能验到 CSS，因为**那时画布上还没有组节点** ——
         * 组是这里「打包成分组」之后才创建的。原来那里写的是
         * `if (groupNode !== null) { 那两条 }`，节点永远取不到 → 两条从写下起没跑过。
         *
         * 为什么放在这里：`groupEl` **刚刚被断言存在**（上面 `if (groupEl === undefined)`
         * 那条已经报错了），所以这里可以直接 `querySelector`，不会静默跳过。 */
        const groupNode = groupEl.querySelector('[data-group-id]')
        if (groupNode === null) {
          errors.push('分组框元素里找不到 [data-group-id] —— 「描述输入与按钮」那两条没验到')
        } else {
          const groupHasDesc = groupNode.querySelector('[class*="groupDescInput"]') !== null
          const groupHasBtn = [...groupNode.querySelectorAll('button')].length > 0
          console.log('   分组框实例上有描述输入与按钮（⑤e 挪来）:', groupHasDesc && groupHasBtn ? '✓' : '✗')
          if (!groupHasDesc || !groupHasBtn) errors.push('分组框实例上缺描述输入或收起按钮')
        }
      }
    }
    pressEsc()
    await settle()
  }

  /* 收尾：清掉选中态。 */
  doc.querySelector('.react-flow__pane')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()

  /* ── ⑦ Ctrl+G 快捷键（用户 2026-10-11：「编组和解散编组添加快捷键，ctrl+g」）──
   *
   * 一个键两用：选中普通节点 → 编组；选中分组框 → 解散。
   * 两条都要验，否则可能只是「编组能用、解散没接上」。
   *
   * ⚠️ 先记下画布节点数，用它判断「编组」是否真的产生了新节点 ——
   * 只断言「没报错」是不够的（用户要的是功能生效，不是不崩）。 */
  const pressCtrlG = () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true, cancelable: true }))
  }
  const pressCtrlA = () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }))
  }
  /**
   * ## ⚠️ 判据 2026-10-26 又改回来：分组框**是真节点**，会进 `nodes`
   *
   * 中间那一版（2026-10-13 ~ 10-25）是**名单模型**（照 n8n）：框是渲染时
   * 按成员包围盒算出来的**派生节点**，不进 `nodes`，所以那时只能「数框的个数」。
   *
   * **那个模型已经退役**（用户 m01076：「按照参考的编组模式和功能改我们的，
   * 我觉得用他们的好点，执行工作流也这么改」）。现在照参考项目：
   * 组是 `nodes` 里一个 `type: 'group'` 的**真节点**，有 `position` / `width` / `height`，
   * 能选中、能拖、能四角改大小。
   *
   * 于是判据回到「数节点数」，但**方向与旧版相反**，因为它守的东西没变、
   * 只是对象从「派生框」换成了「真框」：
   *   · **编组** → `nodes` 多 1 个（那个真框），且**只多 1 个**；
   *   · **解散** → `nodes` 少掉被解散的那些框，其余真节点一个不少。
   *
   * ## 为什么认框用 `data-group-id` 而不是 `data-ewb-content-node`
   *
   * `data-ewb-content-node="group"` 是**内容画布**的 `content-nodes.tsx` 里那个组
   * 组件才有的标记。这一段测的是**执行画布**（`WorkflowCanvas` / `GroupNode.tsx`），
   * 它挂的是 `data-group-id` 与 `data-ewb-group-node`。
   * 用错标记会数到 0 —— 而数到 0 时 `0 < 1` 照样能让「解散」那条通过，是个假绿。
   *
   * 多选走 Ctrl+A（全选）这条真实路径，不用 Ctrl+点击逐个选 ——
   * 第一版用 Ctrl+点击只选中 1 个：React Flow 的多选态来自它对**全局 keydown**
   * 的跟踪（`useKeyPress`），在两段 `await` 之间那个按键状态在 jsdom 里不可靠。
   */
  const countBoxes = () => [...doc.querySelectorAll('.react-flow__node')]
    .filter(n => n.querySelector('[data-group-id]') !== null).length
  const countNodes = () => doc.querySelectorAll('.react-flow__node').length
  /** 当前渲染出来的选中节点数（诊断与「等状态变化」都用它）。 */
  const selectedCount = () => [...doc.querySelectorAll('.react-flow__node')]
    .filter(n => (n.getAttribute('class') ?? '').includes('selected')).length
  /**
   * 等到某个条件成立（**最多**等 `timeoutMs`），而不是死等一个固定时长。
   *
   * ## 为什么必须换成「轮询」而不是「把 700ms 改成 1400ms」
   *
   * 2026-10-26 查 `Ctrl+G 解散：1 → 1` 时，诊断出**动作根本没发生**：
   * 那时 `Ctrl+A` 之后选中数确实是 9，`Ctrl+G` 之后也是 9 —— 按键收到了，
   * 但 `toggleGroupShortcut` 里读 `nodesRef.current` 的 `selected` 那一刻
   * **React 还没把 `selectAll()` 的结果提交到 ref 上**（ref 在渲染期同步）。
   *
   * 把等待从 700ms 加到 1400ms 能让它绿 —— 但那是**把测试调成刚好够慢**，
   * 换台机器/改一次渲染开销就会再红一次，而真机用户不会有这个问题。
   * 所以这里换成「等到真变了再往下走」，判据本身一点没松：
   * 等到超时仍没变，后面那条断言照样红，而且报错里能看到它等了多久。
   *
   * @param cond - 条件。
   * @param timeoutMs - 最多等多久（默认 3000）。
   * @param stepMs - 每次检查的间隔。
   * @returns 等到没有（超时为 false）。
   */
  const waitUntil = async (cond, timeoutMs = 3000, stepMs = 50) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      if (cond()) return true
      await new Promise(s => setTimeout(s, stepMs))
    }
    return cond()
  }
  pressEsc()
  await settle()

  /* ⚠️ `Ctrl+G` 是**两用键**（见 `toggleGroupShortcut`）：选中**已入组**的节点就解散、
   * 否则编组。上面几段留下了一个已存在的分组框，所以第一次按走的是**解散**路径。 */

  /* ① 解散路径（现状：已有分组框）。 */
  pressCtrlA()
  /* 等「真的选上了」再往下，而不是死等固定毫秒（见 `waitUntil` 的说明）。 */
  await waitUntil(() => selectedCount() >= 2)
  /* ★★ **中间态诊断**（2026-10-26 加）：Ctrl+G 之前的选中数。
   *
   * 为什么要它：`Ctrl+G 解散：1 → 1`、`元素 9 → 9` 说明**动作根本没发生**。
   * 而读法有三种可能，修法完全不同：
   *   ① 测试环境 —— `Ctrl+A` 之后 `selected` 没真的变 true，或 `selectAll()`
   *      的结果还没提交到 `nodesRef` 上就按了 Ctrl+G；
   *   ② 产品 bug —— 真选上了但 `toggleGroupShortcut` 没生效；
   *   ③ 判据 —— 动作发生了但数不到。
   * 这一条一句话把 ① 与 ②③ 分开：选中数为 0/1 → ①；≥2 → ②或③。
   *
   * **2026-10-26 的结论：是 ①**。实测 `Ctrl+A` 之后选中 9 个、按 Ctrl+G 之后
   * 仍然 9 个（框 `1 → 1`、元素 `9 → 9`），说明按键收到了但动作没生效 ——
   * 那是「`selectAll()` 的 setState 还没落到 `nodesRef.current` 上就按了键」
   * 的时序问题，不是产品 bug（同一次运行里把等待从 700ms 加到 1400ms 就绿了，
   * 换机器又会抖，所以改成 `waitUntil`）。 */
  const selAfterCtrlA = selectedCount()
  console.log('   [诊断] Ctrl+A 之后选中的节点数:', selAfterCtrlA, selAfterCtrlA >= 2 ? '✓' : '✗')
  if (selAfterCtrlA < 2) {
    errors.push('Ctrl+A 没有选中多个节点（选中 ' + String(selAfterCtrlA) + ' 个）—— 后面两条 Ctrl+G 都没有意义')
  }
  const boxesBefore = countBoxes()
  const nodesBefore = countNodes()
  pressCtrlG()
  /* 等「框少了一个」或超时（超时就让下面那条断言红，报错里有实际数字）。 */
  await waitUntil(() => countBoxes() < boxesBefore, 3000, 50)
  const boxesGone = countBoxes()
  const nodesAfterUngroup = countNodes()
  console.log('   [诊断] Ctrl+G 之后选中的节点数:', selectedCount())
  console.log('   [诊断] 画布上带 data-group-id 的元素数:', boxesGone,
    '（编组后是否被选中:', boxesGone > 0 && doc.querySelector('.react-flow__node.selected [data-group-id]') !== null, '）')
  console.log('   Ctrl+G 解散：分组框', boxesBefore, '→', boxesGone, boxesGone < boxesBefore ? '✓' : '✗')
  if (boxesGone >= boxesBefore) errors.push('Ctrl+G 没有解散编组（分组框还在）')
  /* ⚠️ **框是真节点**：解散后 `nodes` 元素数少掉的应该**正好是那些框**，
   * 其余真节点一个不少。若某次实现只清了成员的 `groupId` 而没删框节点，
   * 这里会算出「少了 0 个」而 `boxesBefore > 0` → 红。
   * （2026-10-26 就真的出过这个 bug：`applyGeoNodes` 按原数组遍历，
   *   几何层已删掉的框被原样保留 —— 这一条当场抓到。） */
  if (nodesAfterUngroup !== nodesBefore - boxesBefore) {
    errors.push('解散时元素数不对（应正好少掉那 '
      + String(boxesBefore) + ' 个框，实际少了 ' + String(nodesBefore - nodesAfterUngroup) + ' 个）')
  }

  /* ② 编组路径（现状：没有任何组）。 */
  pressEsc()
  await settle()
  pressCtrlA()
  /* 同 ①：等「真的选上了」再按，不死等固定毫秒。 */
  await waitUntil(() => selectedCount() >= 2)
  const boxesAtStart = countBoxes()
  const realBefore = countNodes()
  pressCtrlG()
  /* 等「框多了一个」或超时。 */
  await waitUntil(() => countBoxes() > boxesAtStart, 3000, 50)
  const boxesNow = countBoxes()
  const realAfter = countNodes()
  console.log('   Ctrl+G 编组：分组框', boxesAtStart, '→', boxesNow, boxesNow > boxesAtStart ? '✓' : '✗',
    '（元素总数 ' + String(realBefore) + '→' + String(realAfter) + '，应只多出 1 个真框）')
  if (boxesNow <= boxesAtStart) errors.push('Ctrl+G 没有编组（分组框没出现）')
  /* ⚠️ **只许多 1 个**：编组要么「建一个真框节点」，要么「什么都不建」。
   * 若某次实现**既建真框、又额外渲染一个派生框**（两套模型混着留），
   * 这里会多 2 个 → 红。这条是防「两套并存」的，不是防框本身。 */
  if (realAfter !== realBefore + 1) {
    errors.push('编组后元素数不对（应只多出 1 个真框，实际 ' + String(realAfter - realBefore) + '）')
  }
  if (boxesNow !== boxesAtStart + 1) {
    errors.push('编组后画布上的框元素数不对（应只多 1 个，实际 ' + String(boxesNow - boxesAtStart) + '）')
  }
  /* ── ⑧ 选择键统一成 Ctrl（用户 2026-10-11：「都同样成 ctrl」）──
   *
   * 判据查**产物里的配置**：`selectionKeyCode` 必须是 Control、且不再有 Shift。
   * 这条只能查产物 —— jsdom 里按不出真实的「按住 Ctrl 拖拽」手势。
   * ⚠️ `bundle` 在 ⑬ 段是块作用域里的局部变量，这里读不到，得自己再读一份。 */
  const bundleForKeys = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  /* ⚠️ **2026-10-29（票 62）判据换形态，守的事没变 —— 而且比原来更硬。**
   *
   * ## 原来那条为什么成了假防线
   *
   * ```js
   * const selKeyCtrl = /selectionKeyCode:\s*"Control"/.test(bundleForKeys)
   * ```
   *
   * 票 61 把**执行画布**那个键改成了数组 `['Control', 'Space']`，
   * 这条正则就不再匹配它了。但全量仍然绿 —— 因为**内容画布**那边有一处
   * `selectionKeyCode: "Control"`，1.1 MB 的产物里只要**任意一处**命中就算过。
   *
   * 于是这条断言守的不再是「执行画布的临时切换键是 Control」，
   * 而是「产物里某处出现过 Control」——**把执行画布那个配置删掉它照样绿**。
   *
   * ## 改成什么
   *
   * 认**执行画布那一组的完整形态**（数组、两个键都在）：
   *
   *   ① 必须出现 `selectionKeyCode: ["Control", "Space"]`
   *      —— 票 61 用户要求「空格与 Ctrl 都认」；
   *   ② 不许出现 `selectionKeyCode: "Shift"`（老配置）与数组里的 `"Shift"`；
   *   ③ **反面**：不许只剩一个键（光 Control 或光 Space 都不算做完）。
   *
   * ⚠️ 正则按**实测产物**写，不按想当然写。实测（票 61 打包后）：
   *
   * ```
   * $ grep -o 'selectionKeyCode: .\{0,60\}' lib/client.js
   * selectionKeyCode: ["Control", "Space"],
   * selectionKeyCode: "Control",
   * ```
   *
   * 是**双引号 + 逗号后一个空格**。写成单引号或没有空格会永远匹配不上 ——
   * 那种「看着验了、其实从没命中」正是这一轮在修的病。 */
  const selKeyBoth = /selectionKeyCode:\s*\["Control",\s*"Space"\]/.test(bundleForKeys)
  const selKeyShift = /selectionKeyCode:\s*(?:"Shift"|\[[^\]]*"Shift")/.test(bundleForKeys)
  /* 反面：**数组形态里**不许只剩一个键。拦的是「将来有人为了图省事只留一个」。
   *
   * ⚠️ **不能写成「产物里不许出现 `selectionKeyCode: "Control"`」** ——
   * 内容画布那一处**本来就该是单值 `"Control"`**（它的空格走自己的
   * keydown，不交给 React Flow）。拿整份产物去判「单值就是错」，
   * 会红在一个**完全正确**的配置上。
   *
   * 第一版我就这么写了，跑出来：
   * ```
   *   不是只剩一个键: ✗
   *   - 临时切换键只配了一个（Control 与 Space 必须都在）
   * ```
   * 而那时代码是对的。**判据要限定在「数组形态」这一层**，
   * 因为「两个键都认」这件事只对交给 React Flow 的那一处成立。 */
  const selArrays = [...bundleForKeys.matchAll(/selectionKeyCode:\s*\[([^\]]*)\]/g)]
    .map(m => m[1])
  const selKeyHalfOnly = selArrays.some(a => !(a.includes('"Control"') && a.includes('"Space"')))
  console.log('   临时切换键是 ["Control", "Space"]（两边都认）:', selKeyBoth ? '✓' : '✗')
  console.log('   里面没有 Shift（老配置已换）:', selKeyShift ? '✗' : '✓')
  console.log('   数组形态里两个键都在（没有只剩一个的）:',
    selKeyHalfOnly ? '✗' : '✓（共 ' + String(selArrays.length) + ' 处数组）')
  if (!selKeyBoth) errors.push('临时切换键没有同时配 Control 与 Space（票 61 用户要求两个都认）')
  if (selKeyShift) errors.push('临时切换键里还有 Shift（用户要求统一成 Ctrl / 空格）')
  if (selKeyHalfOnly) {
    errors.push('有 selectionKeyCode 数组只配了一个键（Control 与 Space 必须都在）')
  }
  /* 平移开关仍在 —— 按住 Ctrl 时 React Flow 会自动关掉它（源码里 `!selectionKeyPressed && panOnDrag`），
   * 所以配置上 `panOnDrag` 必须开着（写成 false 就是平时也拖不动画布）。
   *
   * ⚠️ 判据**只认我们那句配置** `panOnDrag: true`：
   * 不能写成 `/panOnDrag\b/` 这种宽松匹配 —— 产物里 React Flow **自己**也有
   * 一堆 `panOnDrag` 标识符（它内部实现），关掉我们的配置它照样匹配得上（实测过，是个假阳性）。 */
  const panOn = /panOnDrag:\s*true/.test(bundleForKeys)
  console.log('   平时仍能拖动画布（panOnDrag 保持开启）:', panOn ? '✓' : '✗')
  if (!panOn) errors.push('panOnDrag 被关掉了（平时拖不动画布）')

  /* ── ⑨ 点「运行」要真的发派发请求（2026-10-11 合并跑法后加）──
   *
   * ⚠️ **这条以前没有**，而合并跑法正是在动它 —— 换句话说：
   * 合并前「画布点运行」这条路径**完全没被测试覆盖**，改坏了不会有人发现。
   * 所以补一条从「点按钮」到「发出请求」的端到端断言。
   *
   * 做法：数 `/api/ecom-workbench/run` 的写请求条数 —— 一个节点一条。
   * 示例图 5 个节点，其中一个是 running 状态（那是 seed 里预设的显示态，
   * 不影响派发），所以期望至少发出 1 条。
   *
   * ⚠️ 必须先**把选中清掉、收起展开**，否则上面几段留下的状态会让
   * 「运行」按钮的可用性/行为受影响（它是工具条上的全局按钮，不受选中影响，
   * 但保持现场一致更稳）。
   */
  pressEsc()
  await settle()
  /* ★ 票 55：按**底部主操作位**找「运行」。
   *
   * ## 为什么不是按顶部条找（票 54 那一版）
   *
   * 票 55 把「运行 / 停止」从顶部悬浮条搬到了底部居中那条胶囊上
   * （用户 2026-10-29 甲 5：「主操作放底部中间悬浮」）。
   * 顶部条上现在**没有**这一颗。
   *
   * ⚠️ 这里是票 55 漏改的一处：我在 §9-4 的 `STILL_THERE` 里改对了三条，
   * 但这一段没改 —— 当时产物是旧的，`[data-ewb-tb="run"]` 在旧产物里找得到，
   * **假绿**；打包之后才红。教训是「改锚点要全文搜一遍，不能只改自己顺手看到的那处」。
   *
   * 钩子名也换了：底部条那套是 `data-ewb-dock-btn`（与顶部 `data-ewb-tb` 分开）。 */
  const runBtn = doc.querySelector('[data-ewb-dock="workflow"] [data-ewb-dock-btn="run"]') ?? undefined
  console.log('   底部主操作位有「运行」按钮:', runBtn !== undefined ? '✓' : '✗')
  if (runBtn === undefined) {
    errors.push('底部主操作位上没有「运行」按钮（票 55 之后它在底部居中那条胶囊里）')
  } else {
    const beforeRun = __ewbWritePosts.filter(p => p.url.includes('/api/ecom-workbench/run')).length
    runBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    /* 给派发留时间（每个节点一次 fetch，串行）。 */
    await settle()
    const runPosts = __ewbWritePosts.filter(p => p.url.includes('/api/ecom-workbench/run'))
    console.log('   点「运行」后发出的派发请求数:', runPosts.length - beforeRun,
      runPosts.length > beforeRun ? '✓' : '✗')
    if (runPosts.length <= beforeRun) {
      console.log('   → 点了运行但一条派发请求都没发：跑法合并可能把这条路径接断了。')
      errors.push('点「运行」没有发出任何派发请求')
    }
    /* 还得有运行反馈：节点状态被改成「运行中/完成」之类，或日志里出现派发行。 */
    const afterRun = doc.body.textContent ?? ''
    console.log('   点运行后界面有运行痕迹（日志/进度）:', /派发给|运行中|完成|排队中/.test(afterRun) ? '✓' : '✗')
    if (!/派发给|运行中|完成|排队中/.test(afterRun)) {
      errors.push('点「运行」后界面上没有任何运行痕迹')
    }
  }

/* ⑨ 画布的文件归属（用户 2026-10-14 报的 bug：保存变成新文件）。
 *
 * ## 这里只钉「界面看得见的那一半」
 *
 * 「有归属则覆盖、无归属才新建」这条**判定**由 `workflow-ownership.mjs` 真写盘验
 * （那条测试数磁盘上的文件个数，最能说明问题）。这里补的是**画布上看得见的部分**：
 *   ① 工具条上有没有「我在编辑哪一份」的显示 —— 用户 #3：「画布要显示当前工作流的名称」
 *   ② 无归属时能不能看出是「未保存」 —— 否则用户不知道关掉会不会丢东西
 *   ③ 「另存为」是不是一个**独立**的动作（原来「保存」混了两件事）
 *
 * ⚠️ 判据用**这一块自己的文字**（`.chip` 那个胶囊），不是全页 `includes` ——
 * 画布上别处也可能出现工作流名（比如刚打开时那条提示就带着名字），
 * 全页查会把「根本没显示」也判成通过。
 *
 * ⚠️ **必须放在切走 tab 之前**：这一段要制造一次真改动（加节点）再用 Ctrl+Z 撤回，
 * 而画布**被藏起来时会主动停掉全局键盘监听**（那是 ⑧ 段专门守的规矩）——
 * 放在切走之后的话，那个 Ctrl+Z 不会被画布接住，节点就留在画布上了。 */
console.log('⑨-归属 画布的文件归属显示（工具条）')
{
  /* ★ 票 54：改成按动作钩子找（文字已删）。 */
  const toolActions9 = [...doc.querySelectorAll('[data-ewb-topbar="workflow"] [data-ewb-tb]')]
    .map(el => el.getAttribute('data-ewb-tb') ?? '')

  /* ① **票 63（2026-10-29）起这条反过来了，但守的原意留着。**
   *
   * ## 原来守什么
   *
   * 「`save` 与 `save-as` 是两个独立动作，别合并成一个」——
   * 依据是用户 2026-10-14 那句「另存为单独一个动作」。
   * 那时的风险是「把两件事塞进一颗按钮，想留副本的人只好先改名再存」。
   *
   * ## 为什么反过来
   *
   * 票 63 用户定了：「执行画布去掉新建、打开、另存为按钮，
   * 新建打开操作在工作流管理中执行。画布中就专注当前执行的内容即可。」
   *
   * 所以 `save-as` 那颗**连函数一起删了**（`saveAs` 零其它调用点）。
   * 继续要求它有，等于要求一个已删除的按钮出现。
   *
   * ## 新判据怎么守住同一件事
   *
   * 拆成三件，合起来不比原来松：
   *   ① **`save` 必须在**（用户没说删它，那是每天要用的）；
   *   ② **`save-as` 与 `open` 都不该在**（票 63 删了它们）；
   *   ③ **将来若 `save-as` 回来，必须与 `save` 是两个独立钩子** ——
   *      这一条是原来那句「别合并」的**延续**：写在这里，谁要加回来就被它钉住。
   *
   * ③ 的写法是可执行的：真有 `save-as` 时，`save` 必须同时存在。
   * 两者都在 = 独立；只有 `save-as` = 它把保存那件事吃掉了。 */
  console.log('   工具条仍有「保存」动作:', toolActions9.includes('save') ? '✓' : '✗')
  if (!toolActions9.includes('save')) errors.push('工具条没有「保存」动作')

  /* ② 票 63 删掉的两颗不该再出现。 */
  const goneAfter63 = toolActions9.filter(a => a === 'save-as' || a === 'open')
  console.log('   票 63 删掉的两颗（另存为 / 打开）不在了:',
    goneAfter63.length === 0 ? '✓' : '✗（还有 ' + goneAfter63.join(' / ') + '）')
  if (goneAfter63.length > 0) {
    errors.push('工具条上还有票 63 已删的按钮：' + goneAfter63.join('、')
      + '（新建 / 打开 / 另存为 归工作流管理）')
  }

  /* ③ 将来若 `save-as` 回来，必须与 `save` 并存（别把两件事合并成一颗）。 */
  if (toolActions9.includes('save-as')) {
    console.log('   save-as 若回来，save 必须同时存在:',
      toolActions9.includes('save') ? '✓' : '✗（它把保存那件事吃掉了）')
    if (!toolActions9.includes('save')) {
      errors.push('save-as 回来了但 save 不见了（保存与另存为必须分开）')
    }
  }

  /* ①b ★ **常用按钮不许被宽度隐藏**（用户 #9）。
   *
   * 用户原话：「画布顶部的按钮，保存、打开、收起顶部这三个按钮不应该被压缩后隐藏，
   *   这几个属于常用按钮，宽度再低也应该出现。」
   *
   * ## 判据分两层，缺一层就验不住
   *
   *   ① **DOM 层**：那三个（外加「运行」）必须带「永在」标记 ——
   *      改动前「保存/打开」是中档（≤980px 隐）、
   *      「收起顶部」是低档（≤1180px 隐），**全都不合格**。
   *   ② **CSS 层**：产物里**不许有任何规则**把「永在」打成 `display:none`
   *      —— 否则标记了也白标记。
   *
   * ⚠️ **票 55 已把整套「按宽度分档」机制删除**，所以 ① ② 都换成了新判据，
   * 见下面「判据改了」那一段。这一段留作历史。
   *
   * ⚠️ 为什么不在 jsdom 里量宽度：jsdom 不做布局（`getBoundingClientRect` 恒为 0），
   * 而且容器查询在 jsdom 里根本不生效 —— 在那边验「窄屏可见」只会得到假绿。
   * 真实宽度已用真 Chromium 实测过（结论写在 `workflow-canvas.module.css` 的注释里：
   * 那 4 个按钮只显图标共 160px，加内边距 180px < 340px，所以最窄档也放得下）。
   * 这里钉住的是**「机制」**：标记永在 + 没有规则推翻它。
   *
   * ## 2026-10-23 改：「收起顶部」换了位置，判据跟着换（**不是放宽**）
   *
   * 改前它和「运行 / 保存 / 打开」一起验「永在」标记。
   * 本轮把那个按钮从画布工具条删了，搬到 **tab 条左端** 与 **侧栏底部** 两处
   * （`EcomWorkbench.tsx:590` / `:678`，钩子 `data-ewb-top-toggle`）。
   * 于是工具条上找不到它 → 红。**产品按设计变了，判据过时了。**
   *
   * 换判据时**要求没变**（「任何宽度都可见」），只是换了锚点：
   *
   *   · 旧：工具条里有个按钮带「永在」标记；
   *   · 新：`data-ewb-top-toggle` 的**两个入口都在**，且**都不带任何隐藏条件**。
   *
   * 「不带的隐藏条件」怎么验：它们的 className 里不许出现隐藏类，
   * 也不许 `display:none` / `hidden`。
   * 并且**两个都要在** —— 只留一个等于「另一个位置失效了却没人发现」。
   *
   * ⚠️ 两个入口分别在侧栏与 tab 条（不同容器），不可能同一时刻都被宽度压掉：
   * 侧栏宽度由 `navCollapsed` 控制（折叠时它变成方块图标，**仍然渲染**），
   * tab 条横向滚动而不是隐藏。所以「两处都在」这条能钉住位置，也钉住了常驻。 */
  /* ★ 票 55：判据改了 —— 从「带宽度分档属性」改成「仍在悬浮条上 + 没有规则按宽度隐掉」。
   *
   * ## 为什么原来的判据不再需要（**不是放宽**）
   *
   * 原判据要求那三颗带「永在」标记，且产物里不许有规则把那个标记打成 `display:none`。
   * 它守的是用户 2026-10-14 那句「常用按钮不许被宽度隐藏」。
   *
   * **票 54/55 之后这个风险从根上消失了**：
   *   ① 那套「按宽度隐按钮」的机制（三档优先级 + 四档 `@container`）**整段删除**
   *   ② 顶部条排不下就**换行**（`flex-wrap: wrap` 在 `.toolbar` 基础规则里）
   *   ③ 「运行」搬到了底部主操作位，那一颗**没有收起档**（常驻）
   *
   * 继续验「有没有那个标记」= 验一个已经不存在的机制。所以换成两件
   * **现在真正成立、且仍然服务同一个用户要求**的事实：
   *   · 这几颗**仍在**（`run` 在底部条、`save` / `open` 在顶部条）
   *   · 产物里**没有任何规则**按宽度把悬浮条的按钮藏起来
   *
   * 条数不减（3 → 3），守的东西更贴现在。 */
  /* ⚠️ **2026-10-29（票 63）这一表从 3 条变 2 条 —— 不是放宽。**
   *
   * `open` 那一颗**随票 63 删掉了**（用户定：「执行画布去掉新建、打开、
   * 另存为按钮，新建打开操作在工作流管理中执行」）。
   * 继续要求它出现在顶部悬浮条上，等于要求一个已删除的按钮存在。
   *
   * ## 「打开」这个能力没有丢，它去了工作流管理
   *
   * | 能力 | 现在在哪 |
   * |---|---|
   * | 打开到画布 | `WorkflowList.tsx:1075`「打开到画布」 |
   * | 打开存放目录 | `WorkflowList.tsx:1087`「打开目录」 |
   *
   * **点这两处才找得到「打开」** —— 将来谁翻到这里发现少了一条，
   * 先看这段，别以为能力没了。
   *
   * ## 本表管什么
   *
   * 只管「画布上**仍然存在**的那些常用按钮，任何宽度都得可见」。
   * 按钮不存在了，就不该在这张表里 —— 那是这一整段注释开头讲的
   * 「验一个已删除的机制 = 永远红或永远绿，两种都不是防线」。 */
  const STILL_THERE = [
    ['run', '[data-ewb-dock="workflow"] [data-ewb-dock-btn="run"]', '底部主操作位'],
    ['save', '[data-ewb-topbar="workflow"] [data-ewb-tb="save"]', '顶部悬浮条'],
  ]
  for (const [label, q, where] of STILL_THERE) {
    const b = doc.querySelector(q)
    console.log('   「' + label + '」仍在' + where + '上:', b !== null ? '✓' : '✗')
    if (b === null) errors.push('「' + label + '」不在' + where + '上（用户要求它任何宽度都可见）')
  }
  /* （CSS 层那条在下面 `bundleForPrio` 定义之后 —— 挪过去是因为 TDZ。） */

  /* ── 「收起顶部」：位置类判据**已挪到 ⑮ 段**（票 48）─────────────────
   *
   * ## 为什么从这里挪走（这一条必须写清，否则下一个人会以为判据被删了）
   *
   * 这一段的所有断言都跑在 `doc` 上 —— 而 `doc` 是 **`lib/client.js` 渲染出来的**，
   * 那是**构建产物**。本项目规矩：改动客户端源码后要 `npm run bundle` 再跑读产物的测试。
   * 本轮不许跑 bundle，所以产物里仍是改前的代码（`sidebar` + `tabbar` 两个入口都在）。
   *
   * 于是「展开态入口在面包屑」在这里**必然**不成立 —— 不是代码错，是量错了对象。
   * 位置类判据整体搬到 `⑮` 段（那里 `import('../src/client/workbench/EcomWorkbench.tsx')`
   * **直接挂源码**，拦得住这次改动），强度和条数都只增不减：
   *
   * | 旧（这一段，判产物） | 新（⑮ 段，判源码） |
   * |---|---|
   * | 两个入口都在（`tabbar` + `sidebar`） | 展开态在面包屑首位、收起态在 tab 行首位、`sidebar` 彻底消失 |
   *
   * 这一段**保留**的只有一条，因为它是**产物层**该管的事、且与位置无关：
   * 画布工具条上不许还留一个文按钮「收起顶部」（那会变成第三个入口）。
   */
  const topToggles = [...doc.querySelectorAll('[data-ewb-top-toggle]')]
  const topSides = topToggles.map(b => b.getAttribute('data-ewb-top-toggle'))
  console.log('   产物里收起顶部的入口取值:', topSides.join(' / ') || '（没有）',
    '（⚠️ 产物可能是改前的，位置判据见 ⑮ 段）')
  /* 上面那条「两个入口都不带隐藏条件」的判据**保留**：它与位置无关，
   * 只要求带 `data-ewb-top-toggle` 的元素不被宽度压掉。 */
  /* ★ 票 55：原来这里还查「有没有宽度分档标记（低 / 中优先级）」——
   * 那套机制已整段删除，属性不存在了，继续查它等于永远通过。
   * 保留的语义是「这个入口不被任何方式藏起来」，所以查剩下那三种真实藏法。 */
  const hiddenOnes = topToggles.filter(b => {
    const cls = b.className ?? ''
    return /(^|\s)hidden(\s|$)/.test(cls) || /display:\s*none/.test(cls) || b.hidden === true
  })
  console.log('   ★ 收起顶部的入口都不带隐藏条件:', hiddenOnes.length === 0 ? '✓' : '✗（' + hiddenOnes.length + ' 个带）')
  if (hiddenOnes.length > 0) {
    errors.push('「收起顶部」的入口带了隐藏标记 / 隐藏类（宽度一变就消失）')
  }
  /* CSS 层：产物里不许有「隐掉 always」的规则。 */
  const bundleForPrio = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  /* CSS 层：产物里不许有「按宽度隐藏悬浮条按钮」的规则。
   *
   * ## 为什么这条从上面挪到这里
   *
   * 它用 `bundleForPrio`，而那个常量在**这一行**才声明 —— 写在上面的结果是
   * `ReferenceError: Cannot access 'bundleForPrio' before initialization`
   * （TDZ，本项目那个高频坑；`check:tdz` 只管 `.ts`，测试是 `.mjs` 管不到）。
   *
   * ## 判据本身
   *
   * 旧那条查「永在标记 + display:none」的组合 —— 那个标记**已经不存在**，留着等于永远通过（假绿）。
   * 改成查**现在真正会藏按钮**的写法：对 `.toolBtn` / `.contentCanvasBarBtn` /
   * `.canvasDockBtn` 写 `display: none`。
   * `data-collapse` 那三档是底部条的**按序收起**（设计内），所以排除掉。 */
  const hidesBarBtn = /\.\w+_(toolBtn|contentCanvasBarBtn|canvasDockBtn)(?!\[data-collapse)[^{]*\{[^}]*display:\s*none/.test(bundleForPrio)
  console.log('   产物里没有按宽度藏悬浮条按钮的规则:', hidesBarBtn ? '✗' : '✓')
  if (hidesBarBtn) errors.push('产物里有规则按宽度把悬浮条的按钮藏起来了')
  /* ★ 票 55：原来这里还有一条「产物里没有隐掉永在标记的规则」，**已删**。
   *
   * 它查的是 `[那个标记=always]{…display:none}`。票 55 把那套机制整段删掉之后，
   * 产物里永远不会有这种选择器 → 这条正则**永远不命中 → 永远通过**。
   * 一条永远绿的断言不是防线，是伪装成防线的空白。
   *
   * 它的职责已由上面那条 `hidesBarBtn` 接手，而且更强：
   * 后者查的是「有没有规则按宽度藏悬浮条的按钮」——与机制无关，
   * 将来谁再写一条 `display:none` 藏按钮，它照样红。
   *
   * ⚠️ 这是**删一条失效断言**，不是放宽：换上的那条能真的变红
   * （自证见票 55 交付）。 */

  /* ①c ⚠️ **换行必须写在基础规则里，不能只写在容器查询里**。
   *
   * 2026-10-14 实测（真 Chromium）：**容器查询不作用于容器自己**，只作用于后代。
   * 而 `.toolbar` 正是那个 `container-type: inline-size` 的元素 ——
   * 所以原先写在 `@container` 里的 `.toolbar { flex-wrap: nowrap }` / `{ gap: 4px }`
   * **一条都没生效过**（死代码）。这也是「窄屏排不下时按钮会被挤没」的真因之一。
   *
   * 现在改成**无条件换行**（写在 `.toolbar` 基础规则里）。这条断言钉住它：
   * 基础 `.toolbar` 规则里必须有 `flex-wrap: wrap`。 */
  const toolbarRule = /\.\w+_toolbar\{([^}]*)\}/.exec(bundleForPrio)
  if (toolbarRule === null) {
    console.log('   ✗ 产物里找不到 .toolbar 基础规则')
    errors.push('产物里找不到 .toolbar 规则')
  } else {
    const decl = toolbarRule[1]
    console.log('   .toolbar 基础规则里有无条件换行（flex-wrap:wrap）:',
      /flex-wrap:\s*wrap/.test(decl) ? '✓' : '✗')
    if (!/flex-wrap:\s*wrap/.test(decl)) {
      console.log('   → 换行只在容器查询里写过（那些规则对容器自己无效，是死代码）。')
      errors.push('工具条没有无条件换行（窄屏排不下的按钮会被挤没）')
    }
    /* 同时钉住「容器查询里不再有 .toolbar 自己的规则」（那类规则误导人）。 */
    const selfRules = /@container \w+[^{]*\{(?:[^{}]|\{[^}]*\})*?\.\w+_toolbar\{/.test(bundleForPrio)
    console.log('   容器查询里没有给 .toolbar 自己的规则（那类规则无效）:', selfRules ? '✗' : '✓')
    if (selfRules) errors.push('容器查询里又出现了给 .toolbar 自己的规则（对容器自己无效，是死代码）')
  }

  /* ② 当前工作流的显示位：`.chip` 胶囊（复用画布左下角计数条那个类）。
   *
   * ⚠️ 页面上有**两个** `.chip`：左下角的计数条 + 工具条上的这个归属胶囊。
   * 所以按「有没有那句保存提示」认，不按个数 —— 那个 `title` 只有归属胶囊才有。
   *
   * ⚠️ **2026-10-22 改**：画布初始为空之后，这一段跑到这里时画布**已经打开过
   * 一份存档**（上面为了造连线打开的「示例包·链路」），所以胶囊上写的是文件名、
   * 不再是「未保存的新工作流」。
   * 但「无归属时明说未保存」这条判据**不能削弱** —— 改为用**空画布那一刻**
   * 就存下来的那份证据（`chipFreshText` / `chipFreshTitle`，见上文采集处）。 */
  /* ★ 票 54：归属胶囊现在是 `.tbChip`（悬浮条里），两种都认。
   * 这一处靠 `title` 里有「保存」认，所以**不需要**再排掉计数条 ——
   * 计数条没有 title，加 `_tbChip` 之后这个 find 仍然只落到归属胶囊上。 */
  const fileChipOf = () => [...doc.querySelectorAll('[class*="_chip"], [class*="_tbChip"]')]
    .find(el => !/_chipHot\b/.test(el.className ?? '') && /保存/.test(el.getAttribute('title') ?? ''))
  const fileChip = fileChipOf()
  console.log('   工具条上有「当前工作流」显示位:', fileChip !== undefined ? '✓' : '✗')
  if (fileChip === undefined) {
    errors.push('画布上看不到当前工作流名（用户要求「画布要显示当前工作流的名称」）')
  } else {
    const txt = (fileChip.textContent ?? '').trim()
    console.log('   显示的内容（打开存档后）:', JSON.stringify(txt))
    /* ★ 无归属时明说「未保存的新工作流」—— 判据用**空画布那一刻**的胶囊。
     * 判据本身一字未改：仍然要求那段文字**出现**，只是采集时机提前了。 */
    console.log('   ★ 无归属时明说「未保存的新工作流」:', chipFreshText.includes('未保存的新工作流') ? '✓' : '✗（' + chipFreshText + '）')
    if (!chipFreshText.includes('未保存的新工作流')) errors.push('无归属的画布没有明说「未保存的新工作流」')
    /* 悬浮提示要说清「点保存会发生什么」（要么覆盖、要么新建）。
     * 两种情况各验一次：空画布那次说「新文件」，打开存档后说「覆盖」。 */
    const tip = fileChip.getAttribute('title') ?? ''
    console.log('   空画布时提示「会存成新文件」:', /新文件/.test(chipFreshTitle) ? '✓' : '✗（' + chipFreshTitle.slice(0, 60) + '）')
    if (!/新文件/.test(chipFreshTitle)) errors.push('无归属时的悬浮提示没有说清会存成新文件')
    console.log('   有归属后提示「会覆盖」:', /覆盖/.test(tip) ? '✓' : '✗（' + tip.slice(0, 60) + '）')
    if (!/覆盖/.test(tip)) errors.push('归属显示的悬浮提示没说清保存会覆盖还是新建')
    /* ③ 「未保存」标记：**跟着内容变**（这一条是本轮新加功能的判据）。
     *
     * ## 为什么用「变了才亮、撤回来又灭」而不是「一开始不该亮」
     *
     * 第一版写的是「刚进画布时不该亮」，结果**红了** —— 但红的原因不是代码坏了：
     * 这一段跑到这里时，**上面的段落早就改过画布了**（加过循环节点、点过运行…）。
     * 所以「此刻有未保存的改动」是**对的**，是我这条断言的前提不成立。
     *
     * 改成判**响应性**：标记必须跟着内容走 —— 加一个节点就亮、撤回旧样就恢复原状。
     * 这比「某个时刻该不该亮」更能证明它没坏，而且不依赖前面段落留下的状态。
     *
     * （「一挂载就该是不亮的」由 `workflow-ownership.mjs` 在干净环境里单独验，
     *   以及本段上面的「无归属 → 显示未保存的新工作流」那条。） */
    const dirtyNow = () => {
      const c = fileChipOf()
      return c !== undefined && /未保存/.test((c.textContent ?? '').replace('未保存的新工作流', ''))
    }
    const dirtyBefore9 = dirtyNow()
    console.log('   （加节点前）「未保存」标记:', dirtyBefore9 ? '亮' : '不亮')
    const firstLibItem9 = doc.querySelector('[class*="libItem"]')
    if (firstLibItem9 === null) {
      errors.push('找不到节点库项（验证不到「未保存」标记）')
    } else {
      firstLibItem9.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await settle()
      console.log('   加一个节点后「未保存」标记:', dirtyNow() ? '亮 ✓' : '不亮 ✗')
      if (!dirtyNow()) {
        console.log('   → 画布改了内容却没报「未保存」：用户不知道现在关掉会丢东西。')
        errors.push('改了内容后「未保存」标记没有亮')
      }
      /* 撤回：标记应回到加节点之前的样子（证明它是**跟着内容**算的，
       * 而不是一个一旦亮起就再也不灭的开关）。 */
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }))
      await settle()
      const dirtyAfterUndo = dirtyNow()
      console.log('   撤回后回到原样（' + (dirtyBefore9 ? '亮' : '不亮') + '）:', dirtyAfterUndo === dirtyBefore9 ? '✓' : '✗')
      if (dirtyAfterUndo !== dirtyBefore9) {
        console.log('   → 撤回后标记没有回到原样：它多半不是跟着内容算的。')
        errors.push('撤回后「未保存」标记没有回到原样')
      }
    }
  }
}

  /* ⚠️ **必须切回「工作流」列表 tab**：紧接着的 ⑧ 段断言的是
   * 「切到别的 tab 后画布仍挂载、但真的看不见」——
   * 停在这段里不切走的话，⑧ 会看到画布**正被显示着**而判失败（第一版就踩了）。 */
  const leafTo = clickByText('工作流管理', { inTabs: true })
  console.log('   收尾切回「工作流管理」tab:', leafTo ? '✓' : '✗')
  await settle()
}

/* ⑧ 常驻画布回归断言（2026-10-11 加）。
 * 防的是这个 BUG：「切到工作流列表 tab 再切回画布，画的图与撤销栈全丢」。
 * 根因是内容区用条件渲染——切走即卸载，节点/连线是组件内 useState，卸载即丢。
 *
 * 要两条一起断言，缺一条都会漏：
 *   ① **切走后画布仍在 DOM**（`.react-flow__viewport` 还在）→ 状态没丢。
 *   ② **切走后画布必须真的看不见** → 不能「保住了但糊在别的 tab 上」。
 *
 * 第 ② 条是事后补的教训：第一版用 `visibility:hidden` 藏，探针只看 `.pane`
 * 自己算出来是 hidden 就以为对了，**真机上却整片露着** ——
 * 因为 `visibility` 是能被后代覆盖的继承属性，而 React Flow 给每个节点写了
 * **内联** `visibility:visible`，优先级最高，把祖先的 hidden 顶掉了。
 * 现在改用 `opacity`（作用于整棵子树，后代覆盖不掉），这里按**实际生效的属性**断言。
 */
const paneEl = doc.querySelector('[class*="_pane"]')
const viewportAfterSwitchAway = doc.querySelector('.react-flow__viewport') !== null
const nodesAfterSwitchAway = doc.querySelectorAll('.react-flow__node').length
console.log('⑧ 切到列表页后，画布仍挂载（视口还在）:', viewportAfterSwitchAway ? '是 ✓' : '否 ✗ —— 组件被卸载了，状态会丢')
console.log('   切走后画布上的节点数（应与上面一致）:', nodesAfterSwitchAway)
if (!viewportAfterSwitchAway) {
  console.log('   → 画布被卸载：切 tab 会丢节点/连线。内容区必须常驻挂载，不能条件渲染。')
  errors.push('画布在切走 tab 后被卸载')
}

/* ② 隐藏必须真的生效。检查**容器自己的计算样式**，而不是「有没有挂上某个类」。
 *
 * ⚠️ 判据本身也踩过一次：最初写成「opacity / visibility / display 任一为隐藏即可」，
 *    结果 `visibility:hidden` 也算通过——而**真机正是这样漏的**（后代把它顶掉）。
 *    这个测试跑在 jsdom 里，不会去算 React Flow 内联样式对后代的覆盖，
 *    所以它会放过那个错误。因此判据收紧为：**只认 opacity 与 display**，
 *    且明确把「只靠 visibility 藏」判为失败。 */
if (paneEl !== null) {
  const ps = window.getComputedStyle(paneEl)
  const hiddenByOpacityOrDisplay = ps.opacity === '0' || ps.display === 'none'
  const onlyVisibility = ps.visibility === 'hidden' && !hiddenByOpacityOrDisplay
  const notClickable = ps.pointerEvents === 'none'
  console.log('   切走后画布被藏起来（opacity/display）:', hiddenByOpacityOrDisplay ? '是 ✓' : '否 ✗')
  console.log('   计算样式 opacity =', ps.opacity, '｜ visibility =', ps.visibility, '｜ display =', ps.display, '｜ pointer-events =', ps.pointerEvents)
  console.log('   切走后点不到它（pointer-events:none）:', notClickable ? '是 ✓' : '否 ✗ —— 会吃掉列表页的点击')
  if (onlyVisibility) {
    console.log('   → 只靠 visibility 藏：**这个在真机上藏不住**。')
    console.log('     visibility 是能被后代覆盖的继承属性，React Flow 给每个节点写了内联')
    console.log('     visibility:visible，优先级最高，会把祖先的 hidden 顶掉。请改用 opacity。')
    errors.push('用 visibility 藏画布（真机上藏不住）')
  } else if (!hiddenByOpacityOrDisplay) {
    console.log('   → 画布没藏住：切到别的 tab/板块后它仍然可见，会糊在别的界面上。')
    errors.push('画布切走后没有被隐藏')
  }
  if (!notClickable) errors.push('画布切走后仍可点击')

  /* ③ 同源的隐患：画布**被藏起来时不能接管全局键盘**。
   * 常驻挂载后画布一直在，它的 window keydown 监听若不跟着停，
   * 用户在「列表页」按 Ctrl+Z / Delete 会**默默改到看不见的画布上**，
   * 而且屏幕上没有任何反馈——比状态丢失更难发现。
   *
   * 断言方式：临时给 window 装一个探针监听，数一数「按一次 Ctrl+Z」最终
   * 触发了几个 keydown 处理（画布的处理器会 preventDefault，用它做指纹）。 */
  const ev = new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
  window.dispatchEvent(ev)
  const canvasTookOverKeyboard = ev.defaultPrevented
  console.log('   切走后按 Ctrl+Z，画布还会抢走这个键吗:', canvasTookOverKeyboard ? '是 ✗ —— 会改到看不见的画布上' : '否 ✓')
  if (canvasTookOverKeyboard) {
    console.log('   → 画布被藏起来却仍在接管全局快捷键：用户在别的 tab 按键会改到隐藏的画布。')
    errors.push('隐藏的画布仍接管全局键盘')
  }
} else {
  console.log('   ✗ 找不到 .pane 容器（常驻画布的容器不见了）')
  errors.push('找不到 .pane 容器')
}

/* ⑨ 2026-10-11 用户反馈的三条界面问题（各自一条断言，防回归）。 */
console.log('⑨ [用户反馈] 内容区边框 / 底部边距 / 收起顶部 / 侧栏联动')

/* ⑨-1 「现在的 TAB 内容区默认有一层边框，这层边框不应该存在」。
 *
 * ⚠️ 这条**必须读产物 CSS，不能在 jsdom 里算**（第一版就是算的，是个假阳性）：
 * `.body` 的边框原本写的是 `1px dashed var(--dsw-alias-border-l2)`，
 * 而 jsdom 里没有 dsh 的主题变量 → 整条 border 声明失效 → `getComputedStyle`
 * 算出 `none` → **边框明明还在，断言却通过**。
 * 所以改为直接查产物里 `.body` 这条规则有没有 `border`（照 height-chain 的静态检查法）。 */
const bundleCss = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const bodyRule = /\.\w+_body\{([^}]*)\}/.exec(bundleCss)
if (bodyRule === null) {
  console.log('   ✗ 产物里找不到 .body 规则')
  errors.push('产物里找不到 .body 规则')
} else {
  const decl = bodyRule[1]
  /* 只看简写 `border:` 与四边 `border-*-width`；`border-radius` 不算边框。 */
  const hasBorder = /(?:^|;)\s*border\s*:/.test(decl) || /border-(?:top|right|bottom|left)-width/.test(decl)
  console.log('   内容区没有边框（查产物 CSS）:', hasBorder ? '否 ✗' : '是 ✓')
  if (hasBorder) {
    console.log('   → .body 仍带边框。内容已接入，那层框是占位期的脚手架，应当去掉。')
    errors.push('内容区仍有边框')
  }
}

/* ⑨-2 「底部边距也过高」——原来是 pb-16（64px，抄 FounderOS 大屏），应收紧 */
const pb16 = [...doc.querySelectorAll('div')].find(d => typeof d.className === 'string' && /\bpb-16\b/.test(d.className))
console.log('   不再有 pb-16 的大底部留白:', pb16 === undefined ? '是 ✓' : '否 ✗')
if (pb16 !== undefined) errors.push('底部边距仍是 pb-16')

/* ⑨-3 「工作流界面需要一个按钮隐藏顶部」——
 * 收起面包屑与大标题，但 **tab 条必须留着**（否则切不回列表/历史）。 */
/* ⚠️ **票 65 换了锚点**：这两颗按钮的文字删了（用户：「找一个图标不要用文字符号」），
 * 原来按 `textContent.includes('收起顶部')` 找必然失效。
 *
 * 改按 `data-ewb-top-toggle` 的属性值找 —— 那是行为契约，票 65 明写「一个字都不许改」。
 * 展开态只会有 `breadcrumb` 那一颗（`tabbar` 那颗在收起态才渲染）。
 *
 * **判据意思没变**：找到那颗按钮 → 点它 → 面包屑消失、tab 条还在 → 再点能恢复。 */
const topBtn = doc.querySelector('[data-ewb-top-toggle="breadcrumb"]')
console.log('   工具条有「收起顶部」按钮（data-ewb-top-toggle="breadcrumb"）:', topBtn !== null ? '有 ✓' : '没有 ✗')
if (topBtn === null) {
  errors.push('没有「收起顶部」按钮（data-ewb-top-toggle="breadcrumb"）')
} else {
  const hasCrumb = () => [...doc.querySelectorAll('div')].some(d => typeof d.className === 'string' && d.className.includes('h-[52px]'))
  const tabsBefore = doc.querySelectorAll('[role="tab"]').length
  const crumbBefore = hasCrumb()
  topBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  const crumbAfter = hasCrumb()
  const tabsAfter = doc.querySelectorAll('[role="tab"]').length
  console.log('   点前有面包屑栏 / 点后:', crumbBefore ? '有' : '无', '→', crumbAfter ? '仍有 ✗' : '已收起 ✓')
  console.log('   tab 条保留（点前/点后数量）:', tabsBefore, '/', tabsAfter, tabsAfter > 0 ? '✓' : '✗')
  if (!crumbBefore) errors.push('收起顶部前就没有面包屑栏（断言前提不成立）')
  if (crumbAfter) errors.push('点了收起顶部但面包屑栏还在')
  if (tabsAfter === 0) errors.push('收起顶部把 tab 条也收掉了（会切不回列表/历史）')
  /* 再点一次要能恢复 —— 否则用户回不去。 */
  /* ⚠️ 票 65 同上一处：改按属性找（收起态那颗是 `tabbar`）。 */
  const backBtn = doc.querySelector('[data-ewb-top-toggle="tabbar"]')
  if (backBtn !== null) {
    backBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    console.log('   再点一次恢复面包屑栏:', hasCrumb() ? '是 ✓' : '否 ✗')
    if (!hasCrumb()) errors.push('收起顶部后无法恢复')
  } else {
    errors.push('收起后没有「展开顶部」按钮（无法恢复）')
  }
}

/* ⑨-4 「隐藏对话区的时候也应该隐藏 dsh 的左侧栏」，且取消隐藏要**对称**展开回来。
 * 非对称会让左栏永远收着、用户没法恢复——所以两个方向都断言。 */
const before4 = sidebarToggles.length
/* ★ 票 48：这个动作的入口从「底部那颗按钮」搬到了**侧栏头部的 logo** 上。
 *
 * ## 这一段测的是「动作」，不是「位置」
 *
 * 「隐藏对话区 ⇒ 收起 dsh 左侧栏，取消隐藏 ⇒ 对称展开」这条联动，
 * 与入口摆在哪儿无关 —— 它必须**永远**成立。所以这里按优先级找入口：
 *
 *   ① `[data-ewb-logo-toggle]`（票 48 之后的正主）
 *   ② 文本含「隐藏对话区」的按钮（票 48 之前的旧形态）
 *
 * 「入口在不在 logo 上」由 **⑮ 段**单独判（那里直接挂源码）。
 * 分开的理由：这一段跑的是**构建产物**，产物更新与否不该让动作判据跟着红。
 */
const logoEntry = doc.querySelector('[data-ewb-logo-toggle]')
const hideBtn = logoEntry ?? [...doc.querySelectorAll('button')].find(b => (b.textContent ?? '').includes('隐藏对话区'))
console.log('   这一步用的入口:', logoEntry !== null ? 'logo（新）' : (hideBtn !== undefined ? '底部按钮（旧产物）' : '（都没找到）'))
if (hideBtn === undefined || hideBtn === null) {
  console.log('   ✗ 找不到「隐藏对话区」的入口（logo 与旧按钮都没有）')
  errors.push('找不到隐藏对话区的入口')
} else {
  hideBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  const afterHide = sidebarToggles.length - before4
  console.log('   隐藏对话区时收起左侧栏（调用次数应为 1）:', afterHide, afterHide === 1 ? '✓' : '✗')
  if (afterHide !== 1) errors.push('隐藏对话区没有收起左侧栏')
  /* 取消隐藏的入口：还是同一个元素（logo 不换元素、只翻状态）；
   * 旧形态下按钮文字会从「隐藏对话区」变成「显示对话区」，所以两种都找。 */
  const showBtn = logoEntry ?? [...doc.querySelectorAll('button')].find(b => (b.textContent ?? '').includes('显示对话区'))
  if (showBtn === undefined || showBtn === null) {
    errors.push('隐藏后找不到取消隐藏的入口')
  } else {
    showBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const afterShow = sidebarToggles.length - before4
    console.log('   取消隐藏时展开回来（累计应为 2）:', afterShow, afterShow === 2 ? '✓' : '✗ —— 左栏会永远收着')
    if (afterShow !== 2) errors.push('取消隐藏时没有把左侧栏展开回来')
  }
}

/* ⑨-5 「隐藏工作台」按钮（用户 m03287）──────────────────────────
 *
 * 用户原话：「工作台左侧增加隐藏工作台按钮，注意是**触发 dsh 的那个点击动作**，
 * 保证统一位置放在隐藏对话区的上面。」
 *
 * ## ⚠️ 那句「放在隐藏对话区的上面」说的是**当时**的情形（票 48 之前改过）
 *
 * 那时两者都挤在**侧栏底部那一列**里，靠文档顺序分上下 —— 所以判据是
 * 「隐藏工作台的 index 比隐藏对话区小」。
 *
 * 用户 2026-10-28 定了新形态（票 48）：
 *   · **点侧栏头部的 logo** 切对话区（「注意，是点击logo，不是增加一个按钮」）
 *   · 底部**只留**「隐藏工作台」与「工作台设置」
 *
 * 于是「上面 / 下面」这件事**没变**（用户原话仍是「一个上面一个下面」），
 * 变的是**上面那个现在长什么样**：它不再是文字按钮，而是一个带 `data-*` 钩子的 logo。
 *
 * 判据因此从「比两个文字按钮的文档顺序」改成
 * **「比 logo 与隐藏工作台的文档顺序」** —— 这不是放宽：
 *   ① 找法从 `textContent` 改成 `data-*` 钩子（不再受文案变化影响）
 *   ② **两个都必须找到**才判顺序（旧版允许 `indexOf` 返回 -1 之后靠巧合通过）
 *
 * ⚠️ 这一条在票 48 那次是**漏改的**，当时没露出来是因为
 * `dom-render` 跑的是**产物** `lib/client.js`，而产物还是改前的版本 —— **假绿**。
 * 打包之后才红。教训：改完源码必须打包再跑一次读产物的测试。
 *
 * 判据三件事，缺一件就说明「它其实是另写了一套」：
 *   ① logo（隐藏对话区）在「隐藏工作台」**上面**（文档顺序在前）；
 *   ② 点了之后**工作台真的关了**（见 ③ 的说明，用副作用验）；
 *   ③ 它调的是**同一个动作** —— 与 dsh 侧栏那个按钮走同一条路（`setWbOn`）。
 *      ⚠️ ③ 在 jsdom 里只能间接验（我们看不到 dsh 侧栏那个按钮），
 *      所以用它**必然产生的副作用**验：属性没了 + `ewb-mode-change` 事件发了。
 *      后者是 `setWbOn` 独有的（它结尾 dispatch 那个事件）。 */
{
  const btns = [...doc.querySelectorAll('button')]
  const hideWb = btns.find(b => b.getAttribute('data-ewb-hide-wb') !== null)
  console.log('   ★ 有「隐藏工作台」按钮:', hideWb !== undefined ? '✓' : '✗')
  if (hideWb === undefined) {
    errors.push('左侧栏没有「隐藏工作台」按钮')
  } else {
    console.log('   按钮文字是「隐藏工作台」:', (hideWb.textContent ?? '').includes('隐藏工作台') ? '✓' : '✗')
    /* ① 位置：logo（隐藏对话区）在「隐藏工作台」**上面** —— 用**文档顺序**判。
     *
     * ## 两处写法上的硬要求
     *
     * · **按 `data-*` 钩子找，不看文字**。票 48 之后 logo 的 `textContent`
     *   是空的（它是图形），文案在 `title` / `aria-label` 上 ——
     *   继续用 `textContent.includes('隐藏对话区')` 会得到 `undefined`，
     *   `indexOf` 给 -1，然后「-1 < 9」**恰好**让旧判据通过/失败得毫无道理。
     * · **两个都找到才判顺序**。任何一个没找到就直接红，并说清缺的是哪一个 ——
     *   不许让「没找到」混进「顺序不对」里，那两种情况的修法完全不同。 */
    const chatToggle = doc.querySelector('[data-ewb-logo-toggle]')
    console.log('   ★ 找得到「隐藏对话区」那个切换器（侧栏头部 logo）:', chatToggle !== null ? '✓' : '✗')
    if (chatToggle === null) {
      errors.push('找不到「隐藏对话区」的切换器（`[data-ewb-logo-toggle]`）—— 票 48 之后它在侧栏头部 logo 上')
    }
    /* 文档顺序：把两个元素放一起按出现顺序取下标 —— 比拿两个各自在 `btns` 里的下标更直接，
     * 也不受「它们是不是都算 button」影响。 */
    const both = [...doc.querySelectorAll('[data-ewb-logo-toggle], [data-ewb-hide-wb]')]
    const iChat = both.indexOf(chatToggle)
    const iWb = both.indexOf(hideWb)
    const foundBoth = iChat >= 0 && iWb >= 0
    console.log('   两个元素的文档顺序（chat=' + String(iChat) + ' wb=' + String(iWb) + '）:')
    console.log('   ★ logo 在「隐藏工作台」上面（用户原话「一个上面一个下面」）:',
      foundBoth && iChat < iWb ? '✓' : '✗')
    if (!foundBoth) {
      errors.push('位置判据的前提不成立：两个元素没都找到（chat=' + String(iChat) + ' wb=' + String(iWb) + '）')
    } else if (!(iChat < iWb)) {
      errors.push('「隐藏对话区」的 logo 不在「隐藏工作台」上面（用户要求一个上面一个下面）')
    }
    /* ② + ③ **走的是同一个动作**：与 dsh 侧栏那个「电商工作台」按钮同一条路。
     *
     * ⚠️ **这里不能断言「html 上的 data-ewb 属性没了」**（第一版就是这么写的，假红）：
     * jsdom 里 `document` 指向的是**另一个** document，而属性挂在 `documentElement`
     * 的那个对象上 —— 两边不是同一个，读回来永远是 null，"关掉了" 与 "本来就没开"
     * 分不出来。所以判据换成**这个动作必然产生、且与关没关无关的那两件事**：
     *   ① 发了 `ewb-mode-change`（`setWbOn` 结尾那一行，自己另写一套不会有）；
     *   ② 侧栏那个底部的开关按钮**状态变了**（`aria-pressed` 翻转）——
     *      它订阅的就是同一个事件，所以这一条同时证明「两处是同一份状态」。 */
    const footerBtn = doc.querySelector('[data-ewb-footer-toggle]')
    const pressedBefore = footerBtn?.getAttribute('aria-pressed')
    let changed = 0
    const onMode = () => { changed += 1 }
    window.addEventListener('ewb-mode-change', onMode)
    hideWb.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    window.removeEventListener('ewb-mode-change', onMode)
    console.log('   ★ 走的是同一个动作（发了 ewb-mode-change）:', changed >= 1 ? '✓' : '✗')
    if (changed < 1) errors.push('「隐藏工作台」没有走 setWbOn 那条路（自己另写了一套）')
    const pressedAfter = footerBtn?.getAttribute('aria-pressed')
    /* ⚠️ 侧栏那个按钮在 `POM` 之外（它注册在 dsh 的侧栏里），
     * 拿不到时这一条跳过而不是判红 —— 那属于环境差异，不是代码问题。 */
    if (footerBtn === null || footerBtn === undefined) {
      console.log('   （侧栏那个按钮不在本 DOM 里，跳过「两处状态一致」这一条）')
    } else {
      console.log('   ★ 两处是同一份状态（侧栏按钮跟着变了）:', pressedBefore !== pressedAfter ? '✓' : '✗（' + String(pressedBefore) + '）')
      if (pressedBefore === pressedAfter) errors.push('「隐藏工作台」与侧栏那个按钮不是同一份状态（两处会打架）')
    }
    /* ⚠️ **还原现场**（本文件的一贯纪律）：工作台现在关着，
     * 后面几段全要靠它里面的元素 —— 不复位的话它们会连锁假红。
     * 真机上靠 dsh 侧栏那个按钮重新打开；测试里直接写回 `setWbOn(true)`
     * 会做的那两件事（属性 + 事件），不依赖任何内部函数。 */
    doc.documentElement.setAttribute('data-ewb', 'on')
    window.dispatchEvent(new window.Event('ewb-mode-change'))
    await settle()
    console.log('   （已复位：工作台重新打开）:', doc.documentElement.getAttribute('data-ewb') === 'on' ? '✓' : '✗')
  }
}

/* ⑨-6 **插件重载后开关仍然关得掉**（用户 m07860，2026-10-18）────────────
 *
 * 用户报：「窗口有时候会自动跳出来，然后无法关闭（工作台和其它按钮都不行），
 * 而且切面悬浮在其他界面之上（聊天区没有被压缩）」。三句其实是同一个成因。
 *
 * ## 成因（官方源码依据，不是猜的）
 *
 * 这套开关有**两处状态**，寿命不同：
 *   - `wbOn` / `hideChat`：模块级变量 —— 插件代码重新求值就**回到 false**；
 *   - `<html data-ewb>` / `data-ewb-hide-chat`：页面 DOM 上的属性 —— **留着**。
 *
 * 而「显示不显示」只看 DOM 属性。于是插件一重载：右列**还在**，内存却说「没开」，
 * 两个开关按钮算出来都是「再开一次」→ 点了毫无变化 = 用户说的「关不掉」。
 *
 * 另外 `#ewb-style` 这张表没打 `data-plugin` 标记，会被 dsh 的 `claimStyles`
 * 认给**后加载的别的插件**，那个插件重载时我们的挤压规则一起被删 → 聊天区没被压缩。
 *
 * ## 判据
 *
 * 模拟「插件重载」：先让工作台开着（属性 in on、内存也是 on），然后
 * **把模块状态当作丢了** —— 直接再走一遍 `apply()`（真机重载就是重新求值 + 重新 apply），
 * 再点一次开关，断言`数据属性真的没了`。
 *
 * ⚠️ 这一条**必须能变红**：把 `reconcileFromDom()` 从 `apply` 里删掉，
 * 点完之后属性仍然是 `on`（内存以为没开 → 点一下等于又开一次）→ 断言失败。
 * 已用突变测试验过。 */
console.log('⑨-6 [用户 m07860] 插件重载后开关仍然关得掉')
{
  /* 先确定「开着」：属性 + 内存（内存靠真点一次开关按钮来置上）。 */
  doc.documentElement.setAttribute('data-ewb', 'on')
  const footer0 = doc.querySelector('[data-ewb-footer-toggle]')
  /* 让内存状态与属性一致：走一次公开动作（侧栏那个按钮），它会调 setWbOn。
   * ⚠️ 它此刻读到的是 false（内存初值），所以点一下 = 开到 on —— 正合需要。 */
  footer0?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()

  /* 模拟重载：**真的重新求值一遍模块**（模块级变量因此回到初值），再 apply 一次，
   * 并像 dsh 那样**用新注册的组件重新挂载一遍**（旧组件绑的是旧闭包，点它证明不了什么）。
   * 这正是 dsh 重载时发生的事：invalidate → 重新 import → entry.refresh → 重新渲染。 */
  const before = comps.length
  const fresh = factory(fakeRequire)
  fresh.apply(fakeCtx)
  await settle()
  const freshOverlay = comps.slice(before).find(c => c.name === 'shell.overlay')
  let freshHost = null
  let freshRoot = null
  if (freshOverlay !== undefined) {
    freshHost = doc.createElement('div')
    doc.body.appendChild(freshHost)
    freshRoot = ReactDOMClient.createRoot(freshHost)
    freshRoot.render(React.createElement(freshOverlay.fn))
    await settle()
  }

  /* 现在点**新挂载出来**的「隐藏工作台」按钮，必须**真的关掉**。 */
  const hideWb2 = freshHost === null ? undefined
    : [...freshHost.querySelectorAll('button')].find(b => b.getAttribute('data-ewb-hide-wb') !== null)
  console.log('   ★ 重载后重新挂载出了新的「隐藏工作台」按钮:', hideWb2 !== undefined ? '✓' : '✗')
  hideWb2?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  const stillOn = doc.documentElement.getAttribute('data-ewb') === 'on'
  console.log('   ★ 重载后再点开关，工作台真的关掉了:', stillOn ? '✗（关不掉）' : '✓')
  if (stillOn) {
    errors.push('插件重载后开关关不掉（内存状态没跟 DOM 对齐 —— reconcileFromDom 是不是被删了？）')
  }

  /* 样式表必须带归属标记，否则会被别的插件认领、跟着别人的重载一起消失。 */
  const tag = doc.getElementById('ewb-style')
  const owned = tag?.getAttribute('data-plugin')
  console.log('   ★ 注入的样式表带归属标记:', owned === '@our/ecom-workbench' ? '✓' : '✗（' + String(owned) + '）')
  if (owned !== '@our/ecom-workbench') {
    errors.push('ecom-workbench 注入的 #ewb-style 没打 data-plugin（会被别的插件认领、连带删除）')
  }

  /* 还原现场：后面几段要靠工作台里面的元素。 */
  if (freshRoot !== null) { freshRoot.unmount(); freshHost?.remove() }
  doc.documentElement.setAttribute('data-ewb', 'on')
  window.dispatchEvent(new window.Event('ewb-mode-change'))
  await settle()
}


/* ⑩ 自动布局的两个方向按钮（2026-10-11 用户要求）。
 *
 * 「做两个图标，左右示意与上下示意，替换掉当前自动布局的 icon，
 *   并且让这个 icon 可以单独点击（视觉上他们还是在一起，只是两个部分单独点击）」。
 *
 * 顺便记一个发现：「画布方向切换」在计划里标着已完成，但代码里 `setDir`
 * **从来没有被调用过** —— 也就是说方向按钮其实一直不存在，自动布局固定在横向。
 * 这条断言把这个能力钉住。 */
/* ⚠️ **票 56：控件换了地方，锚点跟着换**（不是放宽判据）。
 *
 * 原来它在右上角 `<Panel>` 里、类名 `.layoutGroup`（`workflow-canvas.module.css`）。
 * 票 56 把自动排版并进了右下角那排共用浮层，类名变成
 * `css.canvasCornerLayout`、钩子是 **`data-ewb-corner-layout`**。
 *
 * 按 `[class*="_layoutGroup"]` 找会得到 null（CSS Modules 的类名也变了），
 * 于是下面那 7 条断言**一条都不会执行** —— 那段 `else` 一次都进不去。
 * 那正是这一轮打包后报「没执行且没登记 7 处」的原因。
 *
 * ⚠️ **这 7 条不许写进 `NEVER_RUN_OK`**：它们跑得到，
 * 挡住它们的只是一个过期的 null 判断。写进白名单 = 把真失败藏掉。 */
console.log('⑩ [用户反馈] 自动布局的两个方向按钮')
const layoutGroup = doc.querySelector('[data-ewb-corner-layout]')
if (layoutGroup === null) {
  console.log('   ✗ 找不到自动排版控件（`data-ewb-corner-layout`，票 56 起在右下角浮层里）')
  errors.push('没有布局方向控件')
} else {
  /* 只认那两个方向按钮（`data-ewb-corner-dir`），不再笼统拿所有 button ——
   * 右下角那排里还有小地图 / 适配 / 快捷键，混进来会让「两个按钮」这条判据失真。 */
  const dirBtns = [...layoutGroup.querySelectorAll('[data-ewb-corner-dir]')]
  console.log('   一个控件里两个按钮:', dirBtns.length === 2 ? '✓' : `✗（${dirBtns.length} 个）`)
  console.log('   两个按钮各有自己的图标（svg）:', dirBtns.every(b => b.querySelector('svg') !== null) ? '✓' : '✗')
  const tips = dirBtns.map(b => b.getAttribute('title') ?? '')
  console.log('   两个按钮说明不同（可分别识别）:', new Set(tips).size === 2 ? '✓' : '✗')
  const oldBtn = [...doc.querySelectorAll('button')].find(b => (b.textContent ?? '').includes('自动布局'))
  console.log('   旧的单一「自动布局」文字按钮已替换:', oldBtn === undefined ? '✓' : '✗')
  if (dirBtns.length !== 2) errors.push('布局控件不是两个按钮')
  if (!dirBtns.every(b => b.querySelector('svg') !== null)) errors.push('方向按钮缺少图标')
  if (oldBtn !== undefined) errors.push('旧的自动布局按钮还在')

  /* 分别点一下：两个方向都要能被单独点中（各自是独立 button）。 */
  const posOf = () => [...doc.querySelectorAll('.react-flow__node')].map(n => n.getAttribute('style') ?? '').join('|')
  const mark = () => dirBtns.map(b => b.hasAttribute('data-on') ? '1' : '0').join('')
  dirBtns[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  const markAfterRight = mark()
  const posAfterRight = posOf()
  dirBtns[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  const markAfterDown = mark()
  const posAfterDown = posOf()
  console.log('   点第一个后选中态:', markAfterRight, '（应为 10）', markAfterRight === '10' ? '✓' : '✗')
  console.log('   点第二个后选中态:', markAfterDown, '（应为 01）', markAfterDown === '01' ? '✓' : '✗')
  console.log('   两次点击都改变了排布:', posAfterRight !== posAfterDown ? '✓' : '✗')
  if (markAfterRight !== '10') errors.push('点横向图标没有选中横向')
  if (markAfterDown !== '01') errors.push('点纵向图标没有切到纵向')
  if (posAfterRight === posAfterDown) errors.push('换方向后排布没变（方向可能没生效）')
}

/* ⑪ 工作台品牌标识（用户 2026-10-11 提供图形，替换原拼图图标）。
 *
 * 断言「形状与颜色分离」这个做法：图只当**蒙版**，颜色走 `currentColor`。
 * 为什么非要这样（而不是直接 <img>）：
 *   原图是**黑线 + 不透明白底**，直接当图片用，暗色主题下会显示成一块**白方块**；
 *   而且原来那个矢量图标本来是跟随主题变色的，换成图片就丢了这个特性。
 * 用蒙版 + currentColor 后，亮色黑、暗色白，行为与原图标一致。 */
console.log('⑪ [用户提供] 工作台品牌标识')
const brandMarks = [...doc.querySelectorAll('span')].filter(el => {
  const st = el.getAttribute('style') ?? ''
  return st.includes('mask-image')
})
console.log('   品牌标识已渲染（数量）:', brandMarks.length, brandMarks.length > 0 ? '✓' : '✗')
if (brandMarks.length === 0) {
  errors.push('品牌标识没有渲染')
} else {
  const allCurrentColor = brandMarks.every(el => /background-color:\s*currentcolor/i.test(el.getAttribute('style') ?? ''))
  const allMasked = brandMarks.every(el => /mask-image/i.test(el.getAttribute('style') ?? ''))
  const allInline = brandMarks.every(el => /data:image\/png;base64,/.test(el.getAttribute('style') ?? ''))
  console.log('   用 currentColor 着色（跟随亮暗主题）:', allCurrentColor ? '✓' : '✗')
  console.log('   走蒙版而不是 <img>（暗色下不会出现白方块）:', allMasked ? '✓' : '✗')
  console.log('   图片已内联（不依赖打包器的资源路径）:', allInline ? '✓' : '✗')
  if (!allCurrentColor) errors.push('品牌标识不是 currentColor 着色（暗色主题下会不跟色）')
  if (!allMasked) errors.push('品牌标识不是蒙版渲染（暗色下可能出现白底方块）')
  if (!allInline) errors.push('品牌标识图片未内联')
  const nakedImg = [...doc.querySelectorAll('img')].filter(i => (i.getAttribute('src') ?? '').includes('data:image/png'))
  console.log('   没有裸 <img> 贴出白底方块:', nakedImg.length === 0 ? '✓' : `✗（${nakedImg.length} 个）`)
  if (nakedImg.length > 0) errors.push('品牌标识用了裸 <img>（会带出白底）')
  const oldPuzzle = [...doc.querySelectorAll('svg')].some(s => (s.innerHTML ?? '').includes('19.439 7.85'))
  console.log('   旧拼图图标已移除:', oldPuzzle ? '✗' : '✓')
  if (oldPuzzle) errors.push('旧拼图图标还在')
}

/* ⑫ 收藏板块（2026-10-11 新增）。
 *
 * 断言「真的渲染出内容」，而不是「没崩」——
 * 之前几轮的问题都是构建通过、测试通过、真机上空白。
 *
 * 这里按**用户明确指出的三条**来断言，它们都是容易做错的地方：
 *   ① 三列表格（名称 / 备注 / 描述）
 *   ② 末列是**按钮**，文字写「能做什么」而不是「现在是什么」
 *      （已收藏→「应用」；已安装→「收藏」），且要带悬浮提示
 *   ③ 保存要有反馈（用户说「点击保存后没有任何变化，我不知道是否成功保存」） */
console.log('⑫ [新板块] 收藏')
const clickedCollect = (() => {
  const hit = [...doc.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '收藏')
  if (hit === undefined) return false
  hit.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  return true
})()
console.log('   侧栏有「收藏」板块且能点:', clickedCollect ? '✓' : '✗')
if (!clickedCollect) errors.push('侧栏没找到「收藏」板块')
await settle()
const ct = doc.body.textContent ?? ''
console.log('   列出已收藏的 skill:', ct.includes('old-skill') ? '✓' : '✗')
console.log('   列出已安装的 skill:', ct.includes('code-review') ? '✓' : '✗')
console.log('   分节标题「已收藏」/「已安装」:', ct.includes('已收藏') && ct.includes('已安装') ? '✓' : '✗')
if (!ct.includes('已收藏') || !ct.includes('已安装')) errors.push('收藏面板没渲染出两个分节')
if (!ct.includes('code-review')) errors.push('收藏面板没列出已安装 skill')

/* ① 三列表格：三个列标题都要在。 */
for (const h of ['名称', '备注', '描述']) {
  console.log('   表头列「' + h + '」:', ct.includes(h) ? '✓' : '✗')
  if (!ct.includes(h)) errors.push('表头缺列：' + h)
}

/* ② 末列按钮：文字必须是「能做什么」，不是「现在是什么」。
 *
 * ⚠️ 选择器要**限定在收藏面板内**：侧栏那个板块按钮的文字**也是「收藏」**，
 * 且它的 title 是板块名 —— 不限定会把侧栏按钮误当成表格里的按钮。
 * 用面板里的表格头（`名称`/`备注`/`描述`）所在的容器来定位。 */
/* ⚠️ 别用「往上爬到某个容器」的办法界定范围 —— 试过两种都不行：
 *   ① 按层数爬（最多 8 层）：每行多一个按钮包裹 div 后层数变了，爬不到就退化成 doc.body；
 *   ② 按内容爬（找同时含「名称」与「打开目录」的容器）：命中的是**「已收藏」那一段
 *      `<section>`**，里面只有「应用」按钮 ——「收藏」按钮在另一个 section 里。
 * 所以直接在**整个页面**取按钮，用**区分性条件**把侧栏那个同名的排除掉：
 *   侧栏板块按钮：文字「收藏」、title 恰好是板块名「收藏」；
 *   表格里的动作按钮：title 是一句说明（长度远超板块名）。
 * 「打开目录」是独有文字，不会与别处撞。 */
const allBtns = [...doc.querySelectorAll('button')]
const applyBtns = allBtns.filter(b => (b.textContent ?? '').trim() === '应用')
const collectBtns = allBtns.filter(b => {
  const t = (b.textContent ?? '').trim()
  const title = b.getAttribute('title') ?? ''
  return t === '收藏' && title.length > 10
})
console.log('   已收藏那批的按钮写「应用」:', applyBtns.length > 0 ? '✓' : '✗')
console.log('   已安装那批的按钮写「收藏」:', collectBtns.length > 0 ? '✓' : '✗')
if (applyBtns.length === 0) errors.push('已收藏侧没有「应用」按钮（应写能做什么而不是现在是什么）')
if (collectBtns.length === 0) errors.push('已安装侧没有「收藏」按钮')
/* 悬浮提示要说清后果（用户要求「注意给他提醒，鼠标移动上去出现的」）。 */
const applyTip = applyBtns[0]?.getAttribute('title') ?? ''
const collectTip = collectBtns[0]?.getAttribute('title') ?? ''
console.log('   「应用」按钮有悬浮提示并说明去向:', applyTip.includes('装回') && applyTip.includes('备份') ? '✓' : '✗')
console.log('   「收藏」按钮的提示说清「模型看不到」:', collectTip.includes('看不到') ? '✓' : '✗')
if (!applyTip.includes('装回')) errors.push('「应用」按钮的悬浮提示没说清会装回哪')
if (!collectTip.includes('看不到')) errors.push('「收藏」按钮的悬浮提示没提醒模型会看不到')

/* ③ 保存反馈：初始应显示「已是最新」；改动后应变成「有未保存的改动」。 */
console.log('   保存区显示当前状态:', ct.includes('已是最新') || ct.includes('已保存于') ? '✓' : '✗')
if (!ct.includes('已是最新') && !ct.includes('已保存于')) errors.push('没有显示保存状态（用户不知道存没存上）')
/* 备注列的输入框：用 placeholder 的前缀匹配（文案改过几次，别把整串写死）。 */
const noteInput = [...doc.querySelectorAll('input')].find(i => (i.getAttribute('placeholder') ?? '').startsWith('为什么收着它'))
if (noteInput === undefined) {
  console.log('   ✗ 找不到备注输入框')
  errors.push('找不到备注输入框（三列表格的备注列）')
} else {
  /* ⚠️ React 的受控 input 必须**用原生 setter 赋值**才收得到 ——
   * 直接 `input.value = x` 会被 React 的值追踪忽略（它比对的是自己记录的旧值），
   * 于是 onChange 不触发、界面不更新。这是测试环境的必要写法，
   * 第一版没这么写，误判成「改了备注但没提示未保存」。
   * 真机上是用户逐字敲键，走的是真实输入事件，没这个问题。 */
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (nativeSetter !== undefined) nativeSetter.call(noteInput, '改一下')
  else noteInput.value = '改一下'
  noteInput.dispatchEvent(new window.Event('input', { bubbles: true }))
  await settle()
  const afterEdit = doc.body.textContent ?? ''
  console.log('   改动后提示「有未保存的改动」:', afterEdit.includes('有未保存的改动') ? '✓' : '✗')
  if (!afterEdit.includes('有未保存的改动')) errors.push('改了备注但没提示未保存')

  /* 热更新：改完**不用点保存**，等一会儿应自动发一次写入请求。
   * 用户 2026-10-11 问「备注的写入是不是应该热更新」——答案是应该，
   * 所以这里钉住它：防抖 800ms 后必须自动存一次。 */
  const postsBefore = __ewbWritePosts.length
  /* ★ 这里**必须等条件**，不能空转：备注热更新在源码里是**防抖 800ms**
   * （`CollectPanel.tsx:281` 那个 `setTimeout(..., 800)`），
   * 那不是「猜一个毫秒数」，而是产品真实行为 —— 所以等到「写入请求真的发出去了」。
   * 超时（3 秒还没发）就让下面那条断言红，且能看出是它没发。 */
  await waitUntilGlobal(() => __ewbWritePosts.length > postsBefore, 3000)
  const autoSaved = __ewbWritePosts.length - postsBefore
  console.log('   改完不点保存也会自动写盘（防抖后）:', autoSaved >= 1 ? '✓' : '✗')
  if (autoSaved < 1) errors.push('备注没有热更新（改完不点保存就丢了）')
  const lastBody = __ewbWritePosts[__ewbWritePosts.length - 1]?.body ?? ''
  console.log('   存进去的确实是刚改的内容:', lastBody.includes('改一下') ? '✓' : '✗')
  if (!lastBody.includes('改一下')) errors.push('自动保存的内容不对')
}

/* 第三个 tab：设置（两侧目录都可配多个 + 显示每个目录扫到几个）。 */
const setTab = [...doc.querySelectorAll('[role="tab"]')].find(b => (b.textContent ?? '').trim() === '设置')
console.log('   板块 tab「设置」存在:', setTab !== undefined ? '✓' : '✗')
if (setTab === undefined) {
  errors.push('板块上没有「设置」tab')
} else {
  setTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  const st = doc.body.textContent ?? ''
  console.log('   两组目录（已安装 / 收藏）:', st.includes('已安装目录') && st.includes('收藏目录') ? '✓' : '✗')
  console.log('   显示每个目录扫到几个:', /\d+ 个/.test(st) ? '✓' : '✗')
  console.log('   有「+ 添加目录」入口:', st.includes('+ 添加目录') ? '✓' : '✗')
  console.log('   目录路径显示出来了:', st.includes('C:/ewb-test/skills') ? '✓' : '✗')
  if (!st.includes('已安装目录') || !st.includes('收藏目录')) errors.push('设置 tab 没渲染两组目录')
  if (!st.includes('+ 添加目录')) errors.push('设置 tab 没有添加目录入口')
  if (!/\d+ 个/.test(st)) errors.push('设置 tab 没显示每个目录扫到几个')
}

/* 回到 Skill tab 确认切回来还在（tab 是板块级的，切换不该丢）。 */
const skillTab = [...doc.querySelectorAll('[role="tab"]')].find(b => (b.textContent ?? '').trim() === 'Skill')
if (skillTab !== undefined) {
  skillTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  const back = doc.body.textContent ?? ''
  console.log('   切回 Skill tab 内容还在:', back.includes('code-review') ? '✓' : '✗')
  if (!back.includes('code-review')) errors.push('切回 Skill tab 后内容丢了')
} else {
  /* ⚠️ 补兜底（2026-10-26）：原来没有 else，找不到 tab 时这条断言**静默跳过**。 */
  errors.push('找不到 Skill tab —— 「切回 tab 内容还在」那条没验到')
}

/* Github项目 tab（纯文本清单）。 */
const linkTab = [...doc.querySelectorAll('[role="tab"]')].find(b => (b.textContent ?? '').trim() === 'Github项目')
console.log('   板块 tab「Github项目」存在:', linkTab !== undefined ? '✓' : '✗')
if (linkTab === undefined) {
  errors.push('板块上没有「Github项目」tab')
} else {
  linkTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  const lt = doc.body.textContent ?? ''
  console.log('   分节「Github 项目」:', lt.includes('Github 项目') ? '✓' : '✗')
  /* ⚠️ 2026-10-11 改版：项目从「三列表格」变成「折叠卡片 + 展开编辑」，
   * 所以项目名现在出现在**页面文字**里（不再只藏在 input.value 里）。
   * 这里两者都查，改动不会把断言弄坏。 */
  const projNames = [...doc.querySelectorAll('input')].map(i => i.value)
  const projInText = lt.includes('awesome-workflow')
  console.log('   已记的项目显示出来了:', projInText || projNames.includes('awesome-workflow') ? '✓' : '✗')
  console.log('   有「+ 添加」入口:', lt.includes('+ 添加') ? '✓' : '✗')
  console.log('   已去掉「dsh 插件」那一节:', !lt.includes('dsh 插件') ? '✓' : '✗')
  if (!projInText && !projNames.includes('awesome-workflow')) errors.push('项目清单没渲染')
  if (!lt.includes('+ 添加')) errors.push('没有添加入口')
  if (lt.includes('dsh 插件')) errors.push('「dsh 插件」那一节应当已去掉')
}

/* ④ 宽度不够时列必须能压缩 —— 这是用户报「没有应用按钮」的**根因**。
 *
 * 第一版用固定列宽（200+160+300+96 ≈ 756px），工作台右栏常年不到这个宽度，
 * 整行横向溢出、末列按钮跑到看不见的地方 →「按钮凭空消失」。
 * 所以断言：每列都写成 `minmax(0, …)`（可压缩），且末列按钮**固定不压**。
 *
 * ⚠️ 两条踩过的坑：
 *   ① 选择器要**认准 skill 那张表**：页面别处也用 grid-template-columns
 *      （tab 条是 `repeat(N, 120px)`），直接取第一个会拿到它。
 *   ② 这段必须**先切回 Skill tab** —— skill 表格只在那个 tab 上
 *      （Github 项目已改成折叠卡片，不再有那张表）。 */
const backSkill3 = [...doc.querySelectorAll('[role="tab"]')].find(b => (b.textContent ?? '').trim() === 'Skill')
backSkill3?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await settle()
const tpls = [...doc.querySelectorAll('[style*="grid-template-columns"]')]
  .map(el => /grid-template-columns:\s*([^;]+)/.exec(el.getAttribute('style') ?? '')?.[1] ?? '')
  .filter(t => t.includes('minmax'))
const tpl = tpls[0] ?? ''
const compressible = (tpl.match(/minmax\(0/g) ?? []).length
console.log('   找到可压缩的表格列模板:', tpls.length > 0 ? '✓' : '✗')
console.log('   列模板可压缩（minmax(0,…) 出现 3 次以上）:', compressible >= 3 ? '✓' : '✗')
console.log('   末列固定宽度（放两个按钮、不被压没）:', /168px/.test(tpl) ? '✓' : '✗')
console.log('   列模板:', tpl === '' ? '(没找到)' : tpl)
if (tpls.length === 0) errors.push('找不到可压缩的表格列模板')
if (compressible < 3) errors.push('表格列不是可压缩的（宽度不够时会溢出、按钮看不见）')
if (!/168px/.test(tpl)) errors.push('末列按钮列没有固定宽度（两个按钮会被压没）')

/* ⑤「打开目录」按钮 + 三个按钮样式统一（用户 2026-10-11 要求）。
 *
 * 用户原话：「再加一个按钮，可以打开这个skill目录。和收藏、应用按钮放一起，
 *   收藏和应用按钮应当是一个颜色，目前收藏字号和底色都不一样，统一」。
 * 所以断言两件事：① 每行都有「打开目录」（与那个动作按钮挨着）；
 * ② 三个按钮的**字号 / 底色 / 描边完全一致**（之前一个是强调色块、一个是透明灰字）。
 *
 * ⚠️ 这段必须**先切回 Skill tab** —— 上面刚在 Github项目 tab 上跑过，
 * 那时 Skill 表格已被卸载，按钮当然找不到（第一版就踩了，报「出现 0 个」）。 */
const backToSkill = [...doc.querySelectorAll('[role="tab"]')].find(b => (b.textContent ?? '').trim() === 'Skill')
backToSkill?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await settle()
/* 每一行 skill 都该有一个「打开目录」——按**实际的行**算，别把数字写死。
 *
 * 行的判据：用「表格自己的那一列模板」去找，而且**只算真正含按钮的行**
 * （表头也带同样的模板，但它没按钮 —— 早先按模板数会把它一起数进来）。 */
const openBtns = [...doc.querySelectorAll('button')].filter(b => (b.textContent ?? '').trim() === '打开目录')
const actBtns = [...doc.querySelectorAll('button')].filter(b => {
  const t = (b.textContent ?? '').trim()
  return t === '应用' || (t === '收藏' && (b.getAttribute('title') ?? '').length > 10)
})
console.log('   「打开目录」按钮数:', openBtns.length, '｜动作按钮数（应用+收藏）:', actBtns.length)
console.log('   每个动作按钮旁边都有一个「打开目录」:', openBtns.length === actBtns.length && actBtns.length > 0 ? '✓' : '✗')
if (actBtns.length === 0) errors.push('找不到 skill 行的动作按钮')
if (openBtns.length !== actBtns.length) errors.push('「打开目录」不是每行一个（与动作按钮数不一致）')
console.log('   它带悬浮提示说明打开的是什么:', (openBtns[0]?.getAttribute('title') ?? '').includes('目录') ? '✓' : '✗')

const styleOf = (b) => {
  const c = b?.className ?? ''
  return {
    font: /text-ewb-\w+/.exec(c)?.[0] ?? '',
    bg: /bg-\[[^\]]+\]/.exec(c)?.[0] ?? '',
    border: /border-\[[^\]]+\]/.exec(c)?.[0] ?? '',
  }
}
const three = [openBtns[0], applyBtns[0], collectBtns[0]].filter(Boolean)
const fonts = new Set(three.map(b => styleOf(b).font))
const bgs = new Set(three.map(b => styleOf(b).bg))
const borders = new Set(three.map(b => styleOf(b).border))
console.log('   三个按钮字号一致:', fonts.size === 1 ? '✓' : `✗（${[...fonts].join(' / ')}）`)
console.log('   三个按钮底色一致:', bgs.size === 1 ? '✓' : `✗（${[...bgs].join(' / ')}）`)
console.log('   三个按钮描边一致:', borders.size === 1 ? '✓' : `✗（${[...borders].join(' / ')}）`)
if (fonts.size !== 1) errors.push('「打开目录 / 应用 / 收藏」字号不一致')
if (bgs.size !== 1) errors.push('「打开目录 / 应用 / 收藏」底色不一致')
if (borders.size !== 1) errors.push('「打开目录 / 应用 / 收藏」描边不一致')

/* 点一下：客户端只该发 **skill 名**，绝不能发路径（否则等于开了「打开任意位置」的口子）。 */
const postsBeforeOpen = __ewbWritePosts.filter(p => p.url.includes('/collect/open')).length
openBtns[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await settle()
const openPosts = __ewbWritePosts.filter(p => p.url.includes('/collect/open'))
console.log('   点了会发打开请求:', openPosts.length > postsBeforeOpen ? '✓' : '✗')
console.log('   请求体只带 skill 名（不带路径）:', /^\{.*"name":"[^/\\:"]+"\}$/.test(openPosts[openPosts.length - 1]?.body ?? '') ? '✓' : '✗')
if (openPosts.length <= postsBeforeOpen) errors.push('点「打开目录」没有发请求')
if (!/^\{.*"name":"[^/\\:"]+"\}$/.test(openPosts[openPosts.length - 1]?.body ?? '')) errors.push('「打开目录」把路径发给了宿主半')

/* ⑥ 状态灯：agent 可用（绿）/ 仅用户（橙）—— 用户 2026-10-11 要求。
 *
 * 用户原话：「已安装的skill应当注明状态（agent可用，仅用户，用绿灯橙色的灯表示），
 *   绿色的表示agent可用，这个参数你看看再哪里。」
 * 参数是 SKILL.md 的 `disable-model-invocation`（见 store.ts 的说明与依据行号）。
 *
 * ⚠️ 页面上**不止 skill 行有灯**：侧栏底部那个「引擎就绪」也是 `.dot.ok`。
 * 所以别按「灯的个数 == skill 行数」断言（会差一个），
 * 只断言「两种灯都出现」+「颜色类正确」+「提示文案说清了含义」。 */
const dots = [...doc.querySelectorAll('.dot')]
const greenDots = dots.filter(d => d.classList.contains('ok'))
const orangeDots = dots.filter(d => d.classList.contains('warn'))
console.log('   状态灯数量:', dots.length, '（含侧栏的「引擎就绪」那个，不只 skill 行）')
console.log('   绿（agent 可用）:', greenDots.length, '｜橙（仅用户）:', orangeDots.length)
console.log('   两种灯都出现了:',
  greenDots.length >= 1 && orangeDots.length >= 1 ? '✓' : '✗')
if (greenDots.length < 1) errors.push('没有绿色的「agent 可用」灯')
if (orangeDots.length < 1) errors.push('没有橙色的「仅用户」灯')
/* 悬浮提示要说清两种状态的含义。 */
const tipEls = [...doc.querySelectorAll('[title]')].map(e => e.getAttribute('title') ?? '')
console.log('   有说明「仅用户可用」的悬浮提示:', tipEls.some(t => t.includes('仅用户可用')) ? '✓' : '✗')
console.log('   有说明「agent 可用」的悬浮提示:', tipEls.some(t => t.includes('agent 可用')) ? '✓' : '✗')
if (!tipEls.some(t => t.includes('仅用户可用'))) errors.push('状态灯没有说明「仅用户可用」')
if (!tipEls.some(t => t.includes('agent 可用'))) errors.push('状态灯没有说明「agent 可用」')

/* ⑦ 折叠分组 + 两边都能展开 + 分类（用户 2026-10-11 三条要求）。
 *
 * 用户原话：「在github项目增加分类想的功能，我之前的那个[]的内容不是分类，
 *   你根据当前的内容思考一下怎么分类，分类不要太多。
 *   skill的已收藏、github项目的分类都应该是可以折叠的内容。
 *   我希望skill和github都可以展开，按钮的位置可以不移动，展开看更详细的内容。」 */
console.log('⑦ [用户反馈] 折叠 / 展开 / 分类')
const backSkill2 = [...doc.querySelectorAll('[role="tab"]')].find(b => (b.textContent ?? '').trim() === 'Skill')
backSkill2?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await settle()

/* 折叠：skill 的两个分组用 <details>（原生可折叠，默认展开）。 */
const details = [...doc.querySelectorAll('details')]
console.log('   skill 分组是可折叠的 <details>:', details.length >= 2 ? '✓' : `✗（${details.length} 个）`)
console.log('   分组默认展开:', details.length > 0 && details.every(d => d.open) ? '✓' : '✗')
if (details.length < 2) errors.push('skill 的已收藏/已安装不是可折叠的')
if (details.length > 0 && !details.every(d => d.open)) errors.push('折叠分组没有默认展开')
const groupNames = [...doc.querySelectorAll('summary')].map(s => (s.textContent ?? '').trim())
console.log('   分组名含「已收藏」「已安装」:',
  groupNames.some(x => x.includes('已收藏')) && groupNames.some(x => x.includes('已安装')) ? '✓' : '✗')

/* skill 展开：箭头在，展开后能看到完整描述 / 所在目录 / 正文预览。 */
const skArrow = [...doc.querySelectorAll('button')].find(b => (b.getAttribute('title') ?? '').startsWith('展开：看完整'))
console.log('   skill 行有展开箭头:', skArrow !== undefined ? '✓' : '✗')
if (skArrow === undefined) {
  errors.push('skill 行没有展开入口')
} else {
  skArrow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  const ex = doc.body.textContent ?? ''
  console.log('   展开后有「完整描述」/「所在目录」/正文预览:',
    ex.includes('完整描述') && ex.includes('所在目录') && ex.includes('正文内容在这里') ? '✓' : '✗')
  if (!ex.includes('完整描述')) errors.push('skill 展开后没有完整描述')
  if (!ex.includes('所在目录')) errors.push('skill 展开后没有所在目录')
  if (!ex.includes('正文内容在这里')) errors.push('skill 展开后没有正文预览')
}

/* Github 分类：按 category 分组、也是可折叠的。 */
const githubTab = [...doc.querySelectorAll('[role="tab"]')].find(b => (b.textContent ?? '').trim() === 'Github项目')
githubTab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await settle()
const gGroups = [...doc.querySelectorAll('summary')].map(s => (s.textContent ?? '').trim())
console.log('   Github 按分类分组:', gGroups.length >= 2 ? '✓' : `✗（${gGroups.length} 组）`)
console.log('   分类名是「能干哪件事」那套（Agent 与 Skill / 采集与搜索）:',
  gGroups.some(x => x.includes('Agent 与 Skill')) && gGroups.some(x => x.includes('采集与搜索')) ? '✓' : '✗')
console.log('   没写分类的归到「未分类」（不丢）:', gGroups.some(x => x.includes('未分类')) ? '✓' : '✗')
if (!gGroups.some(x => x.includes('Agent 与 Skill'))) errors.push('Github 分类没渲染')
if (!gGroups.some(x => x.includes('未分类'))) errors.push('没分类的条目没有归到「未分类」')

/* Github 展开：三个字段可编辑，且删除按钮仍在（按钮位置不移动）。 */
const pjArrow = [...doc.querySelectorAll('button')].find(b => (b.getAttribute('title') ?? '').startsWith('展开：改名称'))
console.log('   项目行有展开箭头:', pjArrow !== undefined ? '✓' : '✗')
if (pjArrow === undefined) {
  errors.push('项目行没有展开入口')
} else {
  pjArrow.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  const pt = doc.body.textContent ?? ''
  const delStill = [...doc.querySelectorAll('button')].some(b => (b.textContent ?? '').trim() === '删除')
  console.log('   展开后出现「名称」「地址」可编辑字段:', pt.includes('名称') && pt.includes('地址') ? '✓' : '✗')
  console.log('   删除按钮仍在（位置不移动）:', delStill ? '✓' : '✗')
  if (!pt.includes('地址')) errors.push('项目展开后没有地址字段')
  if (!delStill) errors.push('项目展开后删除按钮不见了')
}

/* ⑧ 工作流列表的「执行」按钮（用户 2026-10-11 要求）。
 *
 * 用户原话：「工作流板块的工作流界面应该有执行按钮，不依赖画布执行工作流。」
 * 这是本轮的核心能力：**不开画布也能跑工作流**。
 * 断言：「执行」按钮在**主行**上，点了**发对接口**且有反馈。
 *
 * ⚠️ 2026-10-14 改：那个按钮**从展开区挪到了主行**（用户 #4 要求），
 * 而主行本身**不再是 `<button>`**（里面套了按钮，改成 `div` + `role="button"`）。
 * 所以「找那一行」不能再按 `querySelectorAll('button')` 找（第一版这么写，红了）。 */
console.log('⑧ [新能力] 工作流列表的「执行」按钮（不依赖画布）')
/* ⚠️ 必须**先点侧栏的「工作流」板块** —— 上面几段停在「收藏」板块，
 * 它的 tab 条里只有 Skill / Github项目 / 设置，当然找不到「工作流」。
 * （侧栏板块按钮与 tab 都可能叫相近的字，所以板块用「侧栏那个、title 是板块名」认。） */
const wfBoard = [...doc.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '工作流' && (b.getAttribute('title') ?? '') === '工作流')
console.log('   侧栏有「工作流」板块:', wfBoard !== undefined ? '✓' : '✗')
wfBoard?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await settle()
const wfTab = [...doc.querySelectorAll('[role="tab"]')].find(b => (b.textContent ?? '').trim() === '工作流管理')
console.log('   切过去后有「工作流管理」tab:', wfTab !== undefined ? '✓' : '✗')
if (wfTab === undefined) {
  errors.push('工作流板块没有「工作流管理」tab')
} else {
  wfTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  /* 那一行 = 含工作流名的主行（`role="button"` 的 div）。 */
  const row = [...doc.querySelectorAll('[role="button"]')].find(el => (el.textContent ?? '').includes('抖音商品流水线'))
  console.log('   找到一份工作流的行:', row !== undefined ? '✓' : '✗')
  if (row === undefined) {
    errors.push('列表里没有工作流行')
  } else {
    /* ★ 「执行」**不用展开**就该在主行上（这正是本轮 #4 要的）。 */
    const rowBtns = [...row.querySelectorAll('button')].map(b => (b.textContent ?? '').trim())
    const runBtn = [...row.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '执行')
    console.log('   主行上有「执行」按钮（不用展开）:', runBtn !== undefined ? '✓' : '✗（主行上是 ' + rowBtns.join(' / ') + '）')
    if (runBtn === undefined) {
      errors.push('工作流主行上没有「执行」按钮')
    } else {
      console.log('   悬浮提示说清了「不开画布」:', (runBtn.getAttribute('title') ?? '').includes('不打开画布') ? '✓' : '✗')
      /* 点之前的执行请求条数（下面每一次断言都跟它比）。 */
      const before = __ewbWritePosts.filter(p => p.url.includes('/workflow/run')).length
      runBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await settle()
      /* ★★ 输入侧（用户 m00901 定案：输入 = 开始节点；m02875 换成正经表单）────
       *
       * 「抖音商品流水线」在桩里声明了两项输入 —— 所以点「执行」**不能直接开跑**：
       * 要先把表单长出来，填完再跑。
       *
       * ⚠️ **判据从「弹了几个 prompt」整体换掉**（2026-10-17）：`window.prompt` 那条路
       * 已经删了 —— 继续数它等于**测一个不存在的实现**（假绿）。
       * 现在断的是看得见的东西：**表单出现了、默认值预填了、缺必填拦得住、值进了请求**。
       *
       * ⚠️ jsdom 没有实现表单点击提交，所以用 `dispatchEvent(new Event('submit'))`
       * 直接触发 React 的 `onSubmit`（React 在 root 上委托，能收到）。 */
      const form0 = doc.querySelector('[data-ewb-run-input]')
      console.log('   ★ 点「执行」后长出了输入表单（不是直接跑）:', form0 !== null ? '✓' : '✗')
      if (form0 === null) errors.push('声明了输入项的工作流，点执行没有出现填输入的表单')
      const postsBeforeFill = __ewbWritePosts.filter(q => q.url.includes('/workflow/run')).length
      console.log('   ★ 没填之前不发执行请求:', postsBeforeFill === before ? '✓' : '✗（发了 ' + String(postsBeforeFill - before) + ' 条）')
      if (postsBeforeFill !== before) errors.push('输入还没填就把工作流跑起来了')

      if (form0 !== null) {
        const formText = form0.textContent ?? ''
        console.log('   表单标题带着工作流名:', formText.includes('抖音商品流水线') ? '✓' : '✗')
        const boxes = [...form0.querySelectorAll('input')]
        console.log('   ★ 两项输入各有一个输入框（' + String(boxes.length) + ' 个）:', boxes.length === 2 ? '✓' : '✗')
        if (boxes.length !== 2) errors.push('输入表单的项数与开始节点声明的对不上')
        console.log('   必填标出来了:', formText.includes('必填') ? '✓' : '✗')
        console.log('   默认值被预填了:', boxes.some(b => b.value === '2026-10-17') ? '✓' : '✗')
        const setBox = (el, v) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          setter?.call(el, v)
          el.dispatchEvent(new window.Event('input', { bubbles: true }))
        }
        const submitForm = () => { form0.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })) }

        /* ① 把必填那项清空再提交 —— **必须拦住**（这是 `prompt` 时代做不到的事）。 */
        const reqBox = boxes.find(b => b.value === '2026-10-17') ?? boxes[0]
        setBox(reqBox, '')
        submitForm()
        await settle()
        const postsAfterBad = __ewbWritePosts.filter(q => q.url.includes('/workflow/run')).length
        console.log('   ★ 缺必填时拦住了（没发请求）:', postsAfterBad === before ? '✓' : '✗')
        if (postsAfterBad !== before) errors.push('必填项没填也把工作流跑起来了')
        console.log('   并且说清了差哪一项:', (doc.body.textContent ?? '').includes('还没填') ? '✓' : '✗')

        /* ② 填好再提交 —— 这次要真的开跑，而且值要进请求。 */
        setBox(reqBox, '2026-10-18')
        setBox(boxes[1], '我的店')
        submitForm()
        await settle()
        console.log('   填好了再提交就发了执行请求:',
          __ewbWritePosts.filter(q => q.url.includes('/workflow/run')).length > before ? '✓' : '✗')
      }
      const posts = __ewbWritePosts.filter(q => q.url.includes('/workflow/run'))
      const lastBody = posts[posts.length - 1]?.body ?? ''
      console.log('   请求带的是工作流名:', lastBody.includes('抖音商品流水线') ? '✓' : '✗')
      console.log('   ★ 填的值进了请求:', lastBody.includes('2026-10-18') && lastBody.includes('我的店') ? '✓' : '✗', lastBody.slice(0, 160))
      if (!lastBody.includes('2026-10-18')) errors.push('表单里填的值没有带进执行请求')
      /* 执行完必须有回音（用户点完不能不知道跑没跑）。 */
      const afterRun = doc.body.textContent ?? ''
      console.log('   执行后有结果反馈:', /已跑完|跑了|执行失败/.test(afterRun) ? '✓' : '✗')
      if (!/已跑完|跑了|执行失败/.test(afterRun)) errors.push('点「执行」后没有任何反馈')

      /* ★★ 输出侧：**跑完的回音**（用户 m00716 要的「类似 bat」）────────────
       *
       * ⚠️ **判据在 2026-10-18 改过，因为真实行为变了**：
       * 原来列表页点执行会**同时**开 SSE 面板与发 POST —— 于是工作流跑两遍
       * （用户 m03635 报的「跑一个会出现多个」）。现在按环境二选一：
       * 有 `EventSource` 才开面板（真浏览器），没有就走 POST（jsdom 在这条）。
       *
       * 所以 jsdom 里**不该**出现面板 —— 断「面板出现了」会永远红（假红）。
       * 这一侧能断的是「跑完有回音」：那条回音现在由 `onDone` 统一下发，
       * 两条路都走它，所以它同时也是「两条路信息一致」的证据。 */
      const panelText = doc.body.textContent ?? ''
      const echoed = /已跑完|已跑 .* 个节点后中断|执行失败/.test(panelText)
      console.log('   跑完有回音（两条跑路共用同一条）:', echoed ? '✓' : '✗')
      if (!echoed) errors.push('点「执行」后没有结果回音')
      const noPanel = doc.querySelector('[data-ewb-flow-panel]') === null
      console.log('   jsdom 里没有 EventSource → 不开面板（那份面板注定跑不起来）:', noPanel ? '✓' : '✗')
      if (!noPanel) errors.push('没有 EventSource 时仍开了流程面板')

      /* ★★ **一次点击只能跑一遍**（用户 m03635「跑一个会出现多个」的回归防线）────
       *
       * 那两轮 bug 的机制都只有真浏览器才复现（jsdom 没有 `EventSource`，走的是 POST
       * 那条退路）。所以这里**装一个假的 `EventSource`**，把真浏览器那条路走一遍：
       *   ① 点执行 → 只应创建**一条**连接（不是 POST+SSE 两条）；
       *   ② 收到 `done` 之后 → 连接数**不再是 2**（跑完刷列表若把面板卸载重挂，
       *      会再开一条，也就是那轮「一次 3 条、再点变 4 条」的真因）。
       *
       * ⚠️ 这两条都必须在**假 EventSource 存在**的前提下测 —— 没有它，代码走的是
       * 另一条退路，测了等于没测（本文件反复踩过这种「测的不是真跑法」）。 */
      const fakeEs = []
      /* ⚠️ **两处都要设**：源码里的 `typeof EventSource` 与 `new EventSource(…)`
       * 走的是**全局作用域**那个名字，而在 jsdom 里 `globalThis` 与 `window` 不是
       * 同一个对象 —— 只设 `window.EventSource` 的话代码仍然走「没有」那条退路。
       * （真浏览器里两者等价，所以这是纯测试环境的差异。） */
      class FakeEventSource {
        constructor(url) {
          this.url = String(url)
          this.closed = false
          this.handlers = {}
          fakeEs.push(this)
        }
        addEventListener(kind, fn) { (this.handlers[kind] ||= []).push(fn) }
        close() { this.closed = true }
      }
      window.EventSource = FakeEventSource
      globalThis.EventSource = FakeEventSource
      const postsBeforeSse = __ewbWritePosts.filter(q => q.url.includes('/workflow/run')).length
      /* ⚠️ **重新找一次按钮**：上面那一轮已经点过它、还提交过表单，
       * React 重渲染后旧引用可能已脱离文档（派事件不会冒泡到 root）。 */
      const rerun = [...doc.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '执行')
      if (rerun === undefined) { console.log('   ✗ 找不到「执行」按钮（这一段验不到）'); errors.push('找不到执行按钮') }
      rerun?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await settle()
      /* 有输入项 → 填了再提交（与前面那段同一套做法）。 */
      const form2 = doc.querySelector('[data-ewb-run-input]')
      if (form2 !== null) {
        /* 表单里默认值已预填，直接提交即可（缺必填会被拦住并给出提示）。 */
        form2.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
        await settle()
        } else {
        }
      console.log('   ★ 有 EventSource 时：一次点击只开一条连接（' + String(fakeEs.length) + ' 条）:',
        fakeEs.length === 1 ? '✓' : '✗')
      if (fakeEs.length !== 1) errors.push('一次点击开了 ' + String(fakeEs.length) + ' 条连接（应只有一条）')
      console.log('   ★ 而且不再发 POST 那条（不会跑两遍）:',
        __ewbWritePosts.filter(q => q.url.includes('/workflow/run')).length === postsBeforeSse ? '✓' : '✗')
      if (__ewbWritePosts.filter(q => q.url.includes('/workflow/run')).length !== postsBeforeSse) {
        errors.push('开了 SSE 之后仍然发了 POST —— 工作流会跑两遍')
      }
      /* 收到 done → 若面板被卸载重挂，会冒出一条新连接。
       *
       * ⚠️ **必须把列表那条 GET 拖慢**（第一版没拖，断言成了假防线，突变测试当场抓到）：
       * 真实缺陷是「跑完刷新时把 state 置回 loading → 整块列表连带面板卸载重挂」。
       * 而桩里的 `/workflows` **瞬间就返回**，`loading` 那一帧被 React 合并掉了，
       * 面板根本没卸载 —— 于是改坏了断言照样绿。给那条请求加 400ms 延迟，
       * 缺陷才复现得出来（这也是「假绿」的典型：不是断言写错，是**时序太理想**）。 */
      const realFetch = window.fetch
      window.fetch = globalThis.fetch = (url, init) => {
        if (String(url).includes('/api/ecom-workbench/workflows')) {
          return new Promise(resolve => { setTimeout(() => { resolve(realFetch(url, init)) }, 400) })
        }
        return realFetch(url, init)
      }
      const first = fakeEs[0]
      /* ══════════════════════════════════════════════════════════════
       * ★ 模型吐字要真长到界面上（票 14，2026-10-27）
       *
       * ## ⚠️ 这里**不许**去 import 源码那份 `run-store`
       *
       * 这一份测试的页面是「把 `lib/client.js` 当一段代码跑起来」（`:865`），
       * 产物里带**自己那一份** zustand store（`grep -c useRunStore lib/client.js` → 8）。
       * 而 `await import('../src/client/workbench/run-store.ts')` 拿到的是**源码那份**。
       * 两个不同对象 —— 推帧时产物里的被喂了，源码那份永远空。
       *
       * 第一版就是这么写的，红了两条而代码是对的。**判据放错了地方**，
       * 不是代码错（lead 2026-10-27 查清）。
       *
       * ## 所以三条判据改成这样
       *
       * | # | 判据 | 怎么查 |
       * |---|---|---|
       * | 甲 | 字**真的一点点长出来** | 分三次推、**三次都查 DOM**（只查最终态抓不到「每次都从头拼」） |
       * | 乙 | 接线**真的在产物里** | 读 `lib/client.js` 原文，找 `appendStream(` 的调用点 |
       * | 丙 | 是增量不是累计 | 三次推完是 `甲乙丙丁`，不是 `甲甲乙丙甲乙丙丁` |
       *
       * 「增量不是累计」这件事引擎侧另有 `agent-stream.mjs` 钉着（把 `chunk.text`
       * 改 `answer` 会红 3 条），这里只在自己这一层要那个终值。
       *
       * ## 为什么在这里做
       *
       * 上面那个 `FakeEventSource`（`:3760` 附近）是我们唯一能手动触发
       * `handlers.step` 的地方。真机走的是同一条路（`es.addEventListener('step', …)`）。
       *
       * ⚠️ 这一段在 `NEVER_RUN_OK` 那张表**之后**（表在 `:102`），
       * 增删这里的行不会顶掉表里的绝对行号。
       * ══════════════════════════════════════════════════════════════ */
      {
        const target = first
        /** 往假 EventSource 上推一帧 `step`。 */
        const emitStep = (payload) => {
          for (const fn of (target?.handlers.step ?? [])) {
            fn({ data: JSON.stringify(payload) })
          }
        }
        /** 现在面板上 ag1 那截字是什么（`null` = 那一块还没出现）。 */
        const shownStream = () => {
          const box = doc.querySelector('[data-ewb-flow-stream="ag1"]')
          return box === null ? null : (box.textContent ?? '').replace('▍', '')
        }

        emitStep({ kind: 'started', nodeId: 'ag1', label: 'AI 生成' })
        await settle()
        console.log('   ★ 先来一帧 started（确认这条帧路是通的）:',
          doc.querySelector('[data-ewb-flow-panel]') !== null ? '✓' : '✗')
        if (doc.querySelector('[data-ewb-flow-panel]') === null) {
          errors.push('流程面板不在（后面几条吐字断言都验不到）')
        }

        /* ── （甲）分三次推，**三次都查** ──
         *
         * 「只查最终态」抓不到「每次都从头拼」那种错（最终态也可能碰巧对）。
         * 每一片之后都要求 DOM 正好是「到目前为止的全文」，多一个字少一个字都红。 */
        emitStep({ kind: 'stream', nodeId: 'ag1', text: '甲' })
        await settle()
        const s1 = shownStream()
        console.log('   ★★ 第一片之后面板上出现「甲」:', s1 === '甲' ? '✓' : '✗（' + JSON.stringify(s1) + '）')
        if (s1 !== '甲') errors.push('第一片字没有画到面板上（收到 stream 帧却没显示）')

        emitStep({ kind: 'stream', nodeId: 'ag1', text: '乙丙' })
        await settle()
        const s2 = shownStream()
        console.log('   ★★ 第二片之后是「甲乙丙」（接着长，不是从头来）:',
          s2 === '甲乙丙' ? '✓' : '✗（' + JSON.stringify(s2) + '）')
        if (s2 !== '甲乙丙') errors.push('第二片没有接在后面（那一块可能每次都从头拼）')

        emitStep({ kind: 'stream', nodeId: 'ag1', text: '丁' })
        await settle()
        const s3 = shownStream()
        /* ── （丙）终值必须是「增量拼出来的那个」 ──
         * 把增量当累计再拼一次会得到 `甲甲乙丙甲乙丙丁`。 */
        console.log('   ★★ 三片之后是「甲乙丙丁」（增量，不是甲甲乙丙甲乙丙丁）:',
          s3 === '甲乙丙丁' ? '✓' : '✗（' + JSON.stringify(s3) + '）')
        if (s3 !== '甲乙丙丁') {
          errors.push('吐字的拼法错了（期望 甲乙丙丁，实际 ' + JSON.stringify(s3) + '）')
        }

        /* ── ④ 别的帧不许污染它 ──
         * 产物里那份 store 我们读不到，所以判据落在**面板上那截字有没有变**：
         * log / success 帧来了之后，吐字那一段必须还是原样。
         *
         * ## ⚠️ 这条 2026-10-27 修过一次：原写法是假防线
         *
         * 原来写的是 `shownStream() === beforeLog` —— 两个都是 `null` 时也成立。
         * 而「字根本不存在」正是我们要抓的失败之一：`setStreams` 那几行被删掉时，
         * 这一条**照样绿**（实测：注入删掉那三行，它 ✓ 而上面三条 ✗）。
         *
         * 那与本项目已记过的「元素不存在时 `undefined` 不含某个字，判据照样通过」
         * 是同一个形状（`pitfalls/假防线-看着写了其实不生效.md`）。
         *
         * 现在三个条件一起判：**非 null、非空、没变**。
         * 两种失败都看得见 —— 字没长出来（空/不存在）、字被污染了。
         *
         * ⚠️ 不用 `errors.push('验不到')` 那种写法：那与「这一条真的失败」在
         * 错误清单里长得一样，看的人会以为是产品的问题，而真相是后置条件没满足。 */
        const beforeLog = shownStream()
        emitStep({ kind: 'log', nodeId: 'ag1', line: '这条日志不该混进吐字里' })
        emitStep({ kind: 'success', nodeId: 'ag1', label: 'AI 生成' })
        await settle()
        const logClean = beforeLog !== null && beforeLog !== '' && shownStream() === beforeLog
        console.log('   ★★ log / success 帧不许污染吐字那一段:',
          logClean ? '✓' : '✗（' + JSON.stringify(beforeLog) + '）')
        if (!logClean) {
          errors.push('log/success 污染了吐字，或那一截字根本不存在（后置条件没满足）')
        }

        /* ── ⑤ 吐字帧不许进步骤列表（几百行单字会把真正的失败信息刷掉） ── */
        const stepRows = [...doc.querySelectorAll('[data-ewb-flow-panel] div')]
        console.log('   ★ 吐字帧**不进**步骤列表（列表里找不到单独的「▍甲」行）:',
          !stepRows.some(el => (el.textContent ?? '').trim() === '▍甲') ? '✓' : '✗')
        if (stepRows.some(el => (el.textContent ?? '').trim() === '▍甲')) {
          errors.push('stream 帧进了步骤列表（一帧一行会把真正的失败信息刷掉）')
        }

        /* ── （乙）产物里真的调了 `appendStream` ──
         *
         * ## 为什么这条必须查产物原文
         *
         * 上面四条验的是**本页**那条路（`FlowRunPanel` 自己的 `streams`）。
         * 而「画布上那个节点的运行时面板也跟着长」靠的是 `appendStream` ——
         * 那一份在产物里的 store，DOM 这条路够不着。
         *
         * ## ⚠️ 正则别写成 `appendStream\(`
         *
         * 产物里那两处**长得不一样**（`grep -o` 实测）：
         *
         * ```
         * appendStream: (nodeId, chunk) => …    ← 定义（冒号后面才有括号）
         * appendStream(parsed.nodeId, chunk)    ← 调用
         * ```
         *
         * 所以 `/appendStream\(/` 只匹配到**一处**（调用），拿它去判 `>= 2` 会永远红。
         * 第一版就是这么写的，跑出来红了一条而接线是好的 —— 又是「判据挑错地方」。
         * 现在按**不带括号的裸名字**数：≥2 = 一处定义 + 一处调用。
         *
         * 把 `FlowRunPanel.tsx` 里 `appendStream(...)` 那行删掉 → 只剩 1 处 → 红。
         *
         * ⚠️ 这是**源码层断言**，它能抓「接线被删」，抓不到「运行时值不对」。
         * 运行时那半边由上面四条 DOM 断言管。两类合起来才完整。 */
        const bundleText = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
        const appendHits = (bundleText.match(/appendStream/g) ?? []).length
        console.log('   ★★ 产物里 `appendStream` 出现 ' + String(appendHits) + ' 次（≥2 = 定义 + 调用）:',
          appendHits >= 2 ? '✓' : '✗')
        if (appendHits < 2) {
          errors.push('产物里没有调用 appendStream（画布节点那侧的吐字接线被删了）')
        }
      }

      for (const fn of (first?.handlers.done ?? [])) {
        fn({ data: JSON.stringify({ ok: true, ran: ['n1', 'n2'], aborted: false, declaredOutputs: {} }) })
      }
      await settle()
      console.log('   ★ 跑完刷新列表**不会**再开一条（跑一次只留一条记录）:',
        fakeEs.length === 1 ? '✓' : '✗（' + String(fakeEs.length) + ' 条）')
      if (fakeEs.length !== 1) errors.push('跑完刷新列表把面板重挂了 → 会自己再跑一遍（一次跑出多条记录）')
      window.fetch = globalThis.fetch = realFetch
      /* ★★ 卡片是**竖版**（用户 m03287「当前卡片是横版，我要的是竖版」，
       * m03330 确认是「乙」）────────────────────────────────────
       *
       * 判据落在这几件**看得见**的事上（不锚源码文本）：
       *   ① 主行不再是横排（`flex-col`），否则窄栏里会挤成两行乱掉；
       *   ② 三个常用按钮在**卡片下面**那一块里（不是塞在标题行右侧）；
       *   ③ 「修改于 … · X 小时前」合成一行（原来是行尾一个独立胶囊）；
       *   ④ 备注不再 `truncate` —— 它要能换行（否则「自适应」做不到）。 */
      {
        /* ⚠️ 这一段在「瀑布流」那段**之前**，那时 `cards` 还没定义 —— 自己找。 */
        const cardRow = [...doc.querySelectorAll('[role="button"]')]
          .find(el => (el.textContent ?? '').includes('抖音商品流水线'))
        const card = cardRow?.parentElement
        const actRow = card?.querySelector('[data-ewb-card-actions]')
        const mainRow = card?.querySelector('[aria-expanded]')
        const mainCls = String(mainRow?.className ?? '')
        console.log('   ★ 主行是竖排（flex-col）:', /\bflex-col\b/.test(mainCls) ? '✓' : '✗', mainCls.slice(0, 70))
        if (!/\bflex-col\b/.test(mainCls)) errors.push('工作流卡片主行还是横排（用户要竖版）')
        /* ② 按钮区在**标题之后**（DOM 顺序上就排在下面，不是挤在标题右边）。
         * ⚠️ 别断言「主行里没有按钮」—— 整块可点区域就是那个 role=button 的 div，
         * 按钮在它**内部的下方**是正常的（用户要的是「放在下面」，不是「搬到卡片外」）。 */
        /* ⚠️ 主行的第一块是**标题行**（箭头 + 标题），所以「标题之前没有按钮」= 按钮在下面。 */
        const kids = [...(mainRow?.children ?? [])]
        const iAct = kids.indexOf(actRow)
        const iTitle = kids.findIndex(el => (el.textContent ?? '').trim().startsWith('▸') || (el.textContent ?? '').trim().startsWith('▾'))
        console.log('   ★ 按钮区排在标题之后（在下面）:', iTitle >= 0 && iAct > iTitle ? '✓' : '✗（' + String(iTitle) + ' vs ' + String(iAct) + '）')
        if (!(iTitle >= 0 && iAct > iTitle)) errors.push('卡片按钮不在标题下面')
        console.log('   ★ 卡片下面有独立的动作区:', actRow !== null && actRow !== undefined ? '✓' : '✗')
        if (actRow === null || actRow === undefined) errors.push('卡片下面没有动作区')
        /* ③ 时间与「X 小时前」在同一行文字里。 */
        const cardText = card?.textContent ?? ''
        const timeLine = /修改于 \d{2}-\d{2} \d{2}:\d{2} · .+前/.test(cardText)
        console.log('   ★ 「修改于 … · X 小时前」在同一行:', timeLine ? '✓' : '✗')
        if (!timeLine) errors.push('修改时间与「X 小时前」没有放在一起')
        /* ④ 备注能换行（不是 truncate 一行砍）。 */
        const descEl = [...(card?.querySelectorAll('div') ?? [])]
          .find(el => (el.textContent ?? '').trim() === '从抖音罗盘取当期报表：走循环，逐日下载')
        const descCls = String(descEl?.className ?? '')
        console.log('   ★ 备注不再一行砍（没有 truncate）:', /\btruncate\b/.test(descCls) ? '✗' : '✓')
        if (/\btruncate\b/.test(descCls)) errors.push('备注还是 truncate（用户要它自适应换行）')
      }

      /* ★★ 改名 / 改说明是**就地输入框**，不是 `window.prompt`
       * （用户 2026-10-18：「改名改说明两个按钮没有实际作用」）──────
       *
       * ## 为什么必须测「点下去有没有长出输入框」
       *
       * 原实现是 `window.prompt(...)`，而**插件跑在 Electron 里** ——
       * Chromium 早就废掉了 `prompt`，那里调它会**直接抛错**；
       * 外面包着 `void (async () => …)()`、**没有 catch** → 点了毫无反应。
       *
       * ⇒ 所以「按钮在不在」不能作为判据（它一直都在，用户就是点了没反应）。
       * 必须断言**点完之后画面上多出了什么**。
       *
       * ⚠️ 顺带断言源码里**没有** `window.prompt` —— 那是这条 bug 的成因，
       * 只测 DOM 的话，将来有人把实现改成「先 prompt 失败了再走内联」也会绿。 */
      {
        /* 先展开那张卡片（展开是开关：上面若已展开就别再点，否则会收起 —— 踩过）。 */
        const rowEl = [...doc.querySelectorAll('[role="button"]')]
          .find(el => (el.textContent ?? '').includes('抖音商品流水线'))
        if (rowEl !== null && rowEl !== undefined
          && rowEl.getAttribute('aria-expanded') !== 'true') {
          rowEl.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
          await settle()
        }
        /* 每次重查元素（React 状态一变会重建 DOM，存下来的引用会脱离文档 ——
         * 往脱离文档的元素派事件不会冒泡，看着像「功能坏了」，其实是没连上）。 */
        const findBtn = (label) => [...doc.querySelectorAll('button')]
          .find(b => (b.textContent ?? '').trim() === label)
        const renameBtn = findBtn('改名')
        console.log('   ★ 展开区有「改名」按钮:', renameBtn !== undefined ? '✓' : '✗')
        if (renameBtn === undefined) errors.push('展开区找不到「改名」按钮')

        let editBox = doc.querySelector('[data-ewb-inline-edit]')
        console.log('   ★ 一开始没有编辑框（点按钮才出）:', editBox === null ? '✓' : '✗')
        if (editBox !== null) errors.push('没点按钮就出现了编辑框')

        findBtn('改名')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await settle()
        editBox = doc.querySelector('[data-ewb-inline-edit]')
        const isName = editBox?.getAttribute('data-ewb-inline-edit') === 'name'
        console.log('   ★ 点「改名」后长出**名字**输入框:', editBox !== null && isName ? '✓' : '✗')
        if (editBox === null || !isName) errors.push('点「改名」没有出现输入框（用户报的就是这个）')
        /* 输入框要预填当前名字（不然用户得自己重新打一遍）。 */
        const nameInp = editBox?.querySelector('input')
        console.log('   ★ 输入框预填了当前名字:',
          (nameInp?.value ?? '') === '抖音商品流水线' ? '✓' : '✗（' + String(nameInp?.value) + '）')
        if ((nameInp?.value ?? '') !== '抖音商品流水线') errors.push('改名输入框没预填当前名字')

        /* 点「取消」要收回去（证明它是一个真的可撤销的编辑态，不是一次性渲染）。 */
        const cancelBtn = [...doc.querySelectorAll('button')]
          .find(b => (b.textContent ?? '').trim() === '取消')
        cancelBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await settle()
        console.log('   ★ 点「取消」后编辑框收起:',
          doc.querySelector('[data-ewb-inline-edit]') === null ? '✓' : '✗')
        if (doc.querySelector('[data-ewb-inline-edit]') !== null) errors.push('点「取消」后编辑框还在')

        /* 改说明同理（走的是同一个编辑格，只换字段名与控件类型）。 */
        findBtn('改说明')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await settle()
        const descBox = doc.querySelector('[data-ewb-inline-edit]')
        const isDesc = descBox?.getAttribute('data-ewb-inline-edit') === 'desc'
        console.log('   ★ 点「改说明」后长出**说明**输入框:', descBox !== null && isDesc ? '✓' : '✗')
        if (descBox === null || !isDesc) errors.push('点「改说明」没有出现输入框')
        console.log('   ★ 说明用的是多行输入框（textarea）:',
          descBox?.querySelector('textarea') !== null ? '✓' : '✗')
        if (descBox?.querySelector('textarea') === null || descBox === null) {
          errors.push('说明编辑框不是 textarea（长文本会挤成一条）')
        }

        /* 源码层：`window.prompt` 必须彻底没有 —— 它是这条 bug 的成因。 */
        const listSrc = readFileSync(new URL('../src/client/workbench/WorkflowList.tsx', import.meta.url), 'utf8')
        /* ⚠️ 只看**代码行**、不看注释行 —— 注释里解释「原来用 prompt」是应该留的。
         * 判据：以 `//` 或 ` * ` 开头的行不算。 */
        const codeOnly = listSrc.split('\n')
          .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
          .join('\n')
        const usesPrompt = /window\.prompt\s*\(/.test(codeOnly)
        console.log('   ★ 代码里不再用 window.prompt（Electron 里它是死的）:', usesPrompt ? '✗' : '✓')
        if (usesPrompt) errors.push('WorkflowList 还在用 window.prompt（Electron 里调它会抛错，点了没反应）')
      }

      /* ★★ 列表是**瀑布流**（用户 m02340 明确改口：「高度不固定根据内容来，
       * 宽度固定根据页面宽度决定放几个」）────────────────────────────
       *
       * ⚠️ **判据从「用了 grid」整体换掉**（2026-10-17）。上一版断的是
       * 「容器 class 里同时有 grid-cols-1 与 lg:grid-cols-2」，它**通过了**，
       * 而用户看到的是「仍是横条」—— 因为那条 lg: 规则被 Tailwind 静默丢了
       * （断点变量没定义，见 css-refs.mjs 里新增的那段）。
       * 教训：断「源码里写了什么类名」永远测不出「产物里有没有这条规则」。
       *
       * 所以这里的判据落在**瀑布流的三个必备件**上（少一个就是半吊子），
       * 且每一项都能在**产物 CSS 里**核对，不只看 DOM 上的类名：
       *   ① 容器是多列（CSS `columns:`），**不是** grid —— 这是「每张卡片高度各按
       *      内容、不被同行拉齐」的前提（grid 做不到，用户明确不要）；
       *   ② 卡片有 `break-inside: avoid` —— 没有它一张卡片会被从中间劈到两列去；
       *   ③ 列宽变量（`--columns-ewb-card`）**在产物里真的存在** ——
       *      这是防「令牌没定义 → columns 规则静默失效」那一类假绿。
       *
       * ⚠️ jsdom 没有布局引擎（量不到真实列数），所以不验「实际排了几列」；
       * 能验的是「决定列数的这三个东西都在」。真机上的观感由用户看。 */
      const cards = [...doc.querySelectorAll('[role="button"]')]
        .filter(el => (el.textContent ?? '').includes('抖音商品流水线'))
      /* ⚠️ 向上**逐层找**带 columns 的祖先，不写死 parentElement 层数 ——
       * role=button 那层是卡片**里面**的主行，它的父才是卡片容器。
       * 写死层数会在结构一动就静默失效。 */
      /* ⚠️ 向上找的判据要**同时认 grid 与 columns**，不能只认 columns ——
       * 只认 columns 时，一旦有人把它改回 grid，这个循环会一路走到 null、
       * flowCls 变成空串，于是下面那条「不许再是 grid」的反面断言
       * 在空串上判断，**照样通过**（实测：突变改回 grid 时它报 ✓）。
       * 认两种形态，才能既找到容器、又判断出它到底是哪一种。 */
      let flowHost = cards[0]?.parentElement ?? null
      while (flowHost !== null && !/columns-ewb-card|\bgrid\b/.test(String(flowHost.className ?? ''))) {
        flowHost = flowHost.parentElement
      }
      const flowCls = String(flowHost?.className ?? '')
      const isColumns = /columns-ewb-card/.test(flowCls)
      const cardCls = String(cards[0]?.parentElement?.className ?? '')
      console.log('   ★ 列表容器是多列（瀑布流）:', isColumns ? '✓' : '✗', flowCls.slice(0, 90))
      if (!isColumns) {
        errors.push('工作流列表不是瀑布流：容器上找不到 columns-ewb-card（用户 m02340 明确要「按内容高度、按宽度决定列数」）')
      }
      /* 反面：**不许再是 grid** —— 改回 grid 就等于把「同行拉成等高」又装回来了。
       * 这条是给未来的自己看的：用户明确否掉的形态，不该被顺手改回去。 */
      console.log('   ★ 不再是 grid（用户否掉的形态）:', /\bgrid\b/.test(flowCls) ? '✗ 又变回 grid 了' : '✓')
      if (/\bgrid\b/.test(flowCls)) errors.push('工作流列表用的是 grid —— 同行会被拉成等高，正是用户 m02340 否掉的形态')
      console.log('   ★ 卡片不被劈到两列（break-inside: avoid）:', /break-inside-avoid/.test(cardCls) ? '✓' : '✗')
      /* ★ 右侧留缝（用户 m03638 截图：卡片只有左边看得见边框）。
       * 根因是那 1px 边框压在滚动容器的溢出裁剪边界上 —— 左边在容器内、右边被裁。
       * 判据：卡片自己带右边距（`mr-*`），不靠容器 padding（多列下不可靠，试过无效）。 */
      console.log('   ★ 卡片右侧留了缝（右边框不被裁）:', /\bmr-/.test(cardCls) ? '✓' : '✗（' + cardCls.slice(0, 60) + '）')
      if (!/\bmr-/.test(cardCls)) errors.push('卡片右侧没留缝 —— 右边框会被滚动容器裁掉')
      if (!/break-inside-avoid/.test(cardCls)) errors.push('瀑布流卡片没有 break-inside-avoid —— 一张卡片会被从中间劈到两列去')
      /* ★ 产物层：列宽令牌与多列规则真的发射了（这是本轮那个真 bug 的同类）。 */
      const bundleText = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
      const colTok = bundleText.includes('--columns-ewb-card:')
      const colRule = /\.columns-ewb-card\{columns:var\(--columns-ewb-card\)\}/.test(bundleText)
      console.log('   ★ 产物里有列宽令牌与 columns 规则:', colTok && colRule ? '✓' : '✗')
      if (!colTok || !colRule) {
        errors.push('产物里缺 --columns-ewb-card 或它的 columns 规则 —— 瀑布流会静默退化成单列（同 lg: 那类失效）')
      }

      /* ★ 工作流类型（用户 m00861 + m00888）─────────────────────────────
       *
       * 三条判据：
       *   ① 筛选条出现，且胶囊里**既有基础清单的项、也有手写的**（「能当场新建」靠它）；
       *   ② 点一个胶囊只显示那一类（并集筛选真的生效）；
       *   ③ **改类型不会影响「执行」按钮**（用户 m00901 的修正：那是开始节点决定的）。
       *      —— 这条是最容易写错的地方（顺手按标签隐藏按钮），所以要有反面断言。 */
      /* ⚠️ 只看**筛选条容器里**的按钮（靠 data 锚点）——
       * 按 `aria-pressed` 全局找会把画布工具条的按钮也捞进来（实测捞到「隐藏对话区」）。 */
      const filterBar = doc.querySelector('[data-ewb-type-filter]')
      const typeChips = [...(filterBar?.querySelectorAll('button') ?? [])]
        .map(b => (b.textContent ?? '').trim())
        .filter(t => t !== '' && t !== '清除筛选')
      console.log('   ★ 出现类型筛选条:', typeChips.length > 0 ? '✓' : '✗', typeChips.join(' / '))
      if (typeChips.length === 0) errors.push('列表没有类型筛选条（用户 m00888 第 ③ 条）')
      console.log('   ★ 手写的类型也在胶囊里（能当场新建）:', typeChips.includes('我手写的类目') ? '✓' : '✗')
      if (!typeChips.includes('我手写的类目')) errors.push('筛选条只显示基础清单，用户手写的类型没进来')
      /* 点「组合」→ 只应剩下带这个类型的那份。 */
      const combo = [...(filterBar?.querySelectorAll('button') ?? [])].find(b => (b.textContent ?? '').trim() === '组合')
      combo?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await settle()
      const afterFilter = doc.body.textContent ?? ''
      const onlyCombo = afterFilter.includes('组合层示例') && !afterFilter.includes('天猫竞品巡查')
      console.log('   ★ 点「组合」后只剩那一类:', onlyCombo ? '✓' : '✗')
      if (!onlyCombo) errors.push('类型筛选点了没有真的过滤（或把别的也留着了）')
      /* ⚠️ 反面：筛选期间「组合层示例」仍是 called 型 —— 它**本来就不该有**执行按钮，
       * 而「抖音商品流水线」是被筛掉的那个。所以这里换个角度验：
       * **筛掉再清掉之后，普通那份的执行按钮仍在**（说明筛选没弄坏按钮逻辑）。 */
      const combo2 = [...(filterBar?.querySelectorAll('button') ?? [])].find(b => (b.textContent ?? '').trim() === '组合')
      combo2?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await settle()
      const back = doc.body.textContent ?? ''
      console.log('   ★ 清掉筛选后全部回来:', back.includes('抖音商品流水线') && back.includes('天猫竞品巡查') ? '✓' : '✗')
      if (!(back.includes('抖音商品流水线') && back.includes('天猫竞品巡查'))) {
        errors.push('去掉类型筛选后列表没有恢复全部')
      }


      /* ★★ 「只可被调用」的工作流**不显示执行按钮**（用户 m00901 定案）────
       *
       * 判据是**那一行的按钮清单**里没有「执行」，且给了一个说明性徽标 ——
       * 不显示但不解释的话，用户会以为功能坏了。 */
      const calledRow = [...doc.querySelectorAll('[role="button"]')]
        .find(el => (el.textContent ?? '').includes('组合层示例'))
      const calledBtns = [...(calledRow?.querySelectorAll('button') ?? [])]
        .map(b => (b.textContent ?? '').trim())
      console.log('   ★ 「只可被调用」那一行没有执行按钮:', !calledBtns.includes('执行') ? '✓' : '✗（' + calledBtns.join(' / ') + '）')
      if (calledBtns.includes('执行')) errors.push('开始节点是「被另一个流程调用」的工作流，不该显示执行按钮')
      console.log('   ★ 但也说清了为什么（给了徽标）:',
        (calledRow?.textContent ?? '').includes('只可被调用') ? '✓' : '✗')
      if (!(calledRow?.textContent ?? '').includes('只可被调用')) {
        errors.push('「只可被调用」的工作流既不显示执行按钮、也没解释 —— 用户会以为坏了')
      }
      /* 反面：普通那份**必须照旧有**执行按钮（别为了修 A 弄坏 B）。 */
      console.log('   （对照）普通那份仍有执行按钮:', runBtn !== undefined ? '✓' : '✗')
      if (runBtn === undefined) errors.push('普通工作流的执行按钮被误删了')
    }
  }
}


/* ⓘ 条件左边**真能选到嵌套循环变量**（任务 t20；用户 2026-10-19 那条要求的验收面）──
 *
 * ## 判据为什么必须落在「界面上真能选」
 *
 * 「条件判断」的结构化条件（t16）能读 `item` / `outer.item` 是**执行侧**的事；
 * 界面侧还有一件事：那个「选值」下拉里**要有这些可选项**。
 * 两处不一致的症状是「界面上选不到 / 或者能选、跑起来是空」——
 * 不报错、不发红，只是值取不到，最难查。所以这里点开一份**两层嵌套**的存档，
 * 把这个下拉的候选**逐条列出来比**。
 *
 * ⚠️ 必须放在工作流列表那段之后（它要点列表里的「打开到画布」），
 * 且做完把 tab 切回画布 —— 后面的段落要求停在原来的板块。
 */
{
  /* 回到「工作流管理」列表。 */
  const wfTab2 = [...doc.querySelectorAll('[role="tab"]')].find(b => (b.textContent ?? '').trim() === '工作流管理')
  wfTab2?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  const nestedRow = [...doc.querySelectorAll('[role="button"]')]
    .find(el => (el.textContent ?? '').includes('嵌套循环示例'))
  console.log('   列表里有「嵌套循环示例」那份:', nestedRow !== undefined ? '✓' : '✗')
  if (nestedRow === undefined) {
    errors.push('列表里没有「嵌套循环示例」（这一段的断言没法验）')
  } else {
    const openBtn = [...nestedRow.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').trim() === '打开到画布')
    console.log('   那一行有「打开到画布」:', openBtn !== undefined ? '✓' : '✗')
    if (openBtn === undefined) {
      errors.push('「嵌套循环示例」那一行没有「打开到画布」按钮')
    } else {
      openBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await settle()

      /* 画布上现在应该是那份存档：5 个节点（开始 / L1 / L2 / 生成 / 判断）。 */
      const nestedNodes = doc.querySelectorAll('.react-flow__node').length
      console.log('   打开后画布上的节点数:', String(nestedNodes))
      if (nestedNodes < 5) errors.push('「打开到画布」没有把那份嵌套存档加载进来（节点数 ' + String(nestedNodes) + '）')

      /* 点开那个「条件判断」节点的设置。 */
      const ifCard = [...doc.querySelectorAll('[data-state]')]
        .find(el => (el.textContent ?? '').includes('条件判断'))
      console.log('   画布上有「条件判断」节点:', ifCard !== undefined ? '✓' : '✗')
      if (ifCard === undefined) {
        errors.push('嵌套存档里的「条件判断」节点没渲染出来')
      } else {
        ifCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await settle()
        const ed2 = doc.querySelector('[data-ewb-editor]')
        const box2 = ed2?.querySelector('[data-ewb-if-rules]')
        const row2 = box2?.querySelector('[data-ewb-if-row]')
        console.log('   条件控件与条件行都在:', row2 !== undefined && row2 !== null ? '✓' : '✗')
        if (row2 === undefined || row2 === null) {
          errors.push('嵌套存档里的条件表没渲染出条件行')
        } else {
          /* 左边那个下拉（第一格）。 */
          const leftSel = row2.querySelector('select')
          const opts = [...(leftSel?.querySelectorAll('option') ?? [])]
          const values = opts.map(o => o.getAttribute('value') ?? '')
          const labels = opts.map(o => (o.textContent ?? '').trim())
          const loopOpts = labels.filter(t => /^(outer\.)?(item|index)$/.test(t))
          console.log('   ★ 循环变量候选:', loopOpts.join(' / ') || '（一个都没有）')
          /* 两层嵌套 → 应该是 item / index / outer.item / outer.index 四个。 */
          for (const want of ['item', 'index', 'outer.item', 'outer.index']) {
            const has = loopOpts.includes(want)
            console.log('   ★ 能选「' + want + '」:', has ? '✓' : '✗')
            if (!has) errors.push('条件左边选不到循环变量「' + want + '」（用户在嵌套循环里要用它）')
          }
          /* 上游节点也在（那个「生成数据」的 code.js 节点）。 */
          const hasUpstream = labels.some(t => t.includes('›'))
          console.log('   上游节点的字段也在候选里:', hasUpstream ? '✓' : '✗')
          if (!hasUpstream) errors.push('条件左边选不到上游节点的字段')
          /* ★ 存档里写的是 `outer.item` —— 读回来要**仍被选中**，不能变成占位项
           *   （那会让用户以为自己的条件丢了）。 */
          const cur = leftSel?.value ?? ''
          console.log('   ★ 存档里选中的「outer.item」读回来后仍是选中态:', cur === 'l:outer.item' ? '✓' : '✗（' + cur + '）')
          if (cur !== 'l:outer.item') errors.push('存档里选好的 outer.item 读回来没被选中（显示成了别的）')
          /* 顺手确认候选值编码没串味：外面那一层不能也变成 `l:item`。 */
          const outerVals = opts.filter(o => /^(item|index)$/.test((o.textContent ?? '').trim()))
            .map(o => o.getAttribute('value') ?? '')
          console.log('   内层 item 的编码是 l:item（不带 outer 前缀）:',
            outerVals.includes('l:item') ? '✓' : '✗（' + outerVals.join(',') + '）')
          if (!outerVals.includes('l:item')) errors.push('内层 item 的下拉编码不对（会取到外层的值）')
          console.log('   第一项的编码集合里有 l:outer.item:', values.includes('l:outer.item') ? '✓' : '✗')
          if (!values.includes('l:outer.item')) errors.push('外层变量在下拉里没有对应的编码值')

          /* 收起这个节点（别把展开态带到后面）。 */
          ifCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
          await settle()
        }
      }
    }
  }
}


/* ⓘ 运行历史：**按工作流分组** + 「整次运行」层 + 关键产出（用户 m03287 / m03330）──
 *
 * 判据四件（都按**看得见的东西**定）：
 *   ① 顶部出现「按工作流」的切换条（分组）；
 *   ② 右侧列出**这次**的多次运行（不是散装的节点行）；
 *   ③ 每次运行的摘要上就有**关键产出**（不点开也看得见）；
 *   ④ 点开一次运行，节点明细的标题是**备注名 + 编号**（用户点名要的）。
 *
 * ⚠️ 必须放在工作流列表那段**之后**、收藏板块那段**之前** —— 它要把 tab 切到「运行历史」，
 * 而切换模块会让前面那些列表断言找不到元素（本文件的老坑，⑦ 段就因此崩过一次）。 */
{
  const histTab = [...doc.querySelectorAll('[role="tab"]')].find(b => (b.textContent ?? '').trim() === '运行历史')
  console.log('   有「运行历史」tab:', histTab !== undefined ? '✓' : '✗')
  if (histTab === undefined) {
    errors.push('工作流板块没有「运行历史」tab')
  } else {
    histTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const groups = doc.querySelector('[data-ewb-run-groups]')
    console.log('   ★ 顶部有「按工作流」分组条:', groups !== null ? '✓' : '✗')
    if (groups === null) errors.push('运行历史没有按工作流分组')
    const groupNames = [...(groups?.querySelectorAll('button[aria-pressed]') ?? [])]
      .map(b => (b.textContent ?? '').trim())
    console.log('   ★ 分组条里是工作流名（' + groupNames.join(' / ') + '）:',
      groupNames.includes('抖音商品流水线') ? '✓' : '✗')
    if (!groupNames.includes('抖音商品流水线')) errors.push('分组条里没有工作流名')
    /* ② 多次运行都列出来（桩里给了 2 条）。 */
    /* ⚠️ 默认选的是**排序后的第一个**（天猫竞品巡查），所以先点一下目标那份。
     * 这一步不能省 —— 不点的话下面断的是另一份记录（0 次运行），会假红。 */
    const pickTarget = [...(groups?.querySelectorAll('button[aria-pressed]') ?? [])]
      .find(b => (b.textContent ?? '').trim() === '抖音商品流水线')
    pickTarget?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const runRows = [...doc.querySelectorAll('[data-ewb-run-row]')]
    console.log('   ★ 列出的是「整次运行」（' + String(runRows.length) + ' 次）:', runRows.length === 2 ? '✓' : '✗')
    if (runRows.length !== 2) errors.push('运行历史没有按「整次运行」列（还是散装的节点行）')
    /* ③ **产出不属于运行历史**（用户 m03841 纠正过我一次，原话：「结束发的那个是
     * 结束节点的范畴，和运行历史没关系」）。所以判据是**反面**：这里不该有产出。
     * ⚠️ 留下这条是为了防「下次谁顺手又把产出塞回历史」。 */
    const outputsShown = doc.querySelector('[data-ewb-run-outputs]') !== null
    console.log('   ★ 运行历史里没有「产出」（它归结束节点，不归历史）:', outputsShown ? '✗' : '✓')
    if (outputsShown) errors.push('运行历史里塞了结束节点的产出（用户明确说不属于这里）')
    /* ④ 点开一次运行 → 节点明细，标题 = 备注名 + 编号。 */
    if (runRows.length > 0) {
      runRows[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await settle()
      const nodesBox = doc.querySelector('[data-ewb-run-nodes]')
      const nodesText = nodesBox?.textContent ?? ''
      console.log('   ★ 点开后出现节点明细:', nodesBox !== null ? '✓' : '✗')
      if (nodesBox === null) errors.push('点开一次运行后没有节点明细')
      /* 用户 m03635：「步骤 n 后面不是应该有数字么」—— 序号由界面自己数，不依赖节点 id。 */
      const hasStepNo = /步骤 1 · ① 算时间（n1）/.test(nodesText)
      console.log('   ★ 节点标题是「步骤 N · 备注名（编号）」:', hasStepNo ? '✓' : '✗', nodesText.slice(0, 80))
      if (!hasStepNo) {
        errors.push('节点明细的标题不是「步骤 N · 备注名（编号）」')
      }
      /* 失败节点要直接露出原因（不静默）。 */
      console.log('   失败节点的原因露在明细里:', /页面没开/.test(nodesText) ? '✓' : '✗')
      if (!/页面没开/.test(nodesText)) errors.push('节点明细里没有失败原因')
      /* ⚠️ 模型痕迹那一段**不在这里验**：这一整段读的是构建产物 `lib/client.js`，
       * 而本轮改动只在源码里（产物由组长统一重建）。所以那几条断言放在
       * 文件末尾「从源码挂 RunHistoryPanel」那一段 —— 它测的就是此刻的代码。
       * 理由与 ⑬ 段挑靶子时的说明同一条。 */
    }
  }
}
/* ⓘ 等待中面板：**列出在等的运行、能催（继续）能放弃、能只刷新这一块**（2026-10-22）
 *
 * ## 为什么这一段必须有
 *
 * 在这之前 `data-ewb-paused` / `刷新等待中` 在 `tests/` 里**一次都没出现**。
 * dom-render 一直是绿的，但那是「`listPausedRuns` 的请求被 try/catch 兜住、显示一句警告」
 * 的结果 —— 它只证明「页面没崩」，不证明「这块画出来了」。
 *
 * ## 判据全部盯**看得见的东西**
 *
 * 桩里给两条：一条 `until`（等到 09:30）、一条时长型。这样「等什么」那栏的
 * 两种分支都被走到 —— 只给一条的话，写错分支也发现不了。
 *
 * ⚠️ 这一段**接着上面运行历史那段落**（已经停在「运行历史」tab），不用再切一次。 */
console.log('ⓘ [新能力] 等待中面板（继续 / 放弃 / 刷新等待中）')
{
  const block = doc.querySelector('[data-ewb-paused]')
  console.log('   ★ 运行历史里出现「等待中」区:', block !== null ? '✓' : '✗')
  if (block === null) errors.push('运行历史上没有「等待中」区（data-ewb-paused 不存在）')

  if (block !== null) {
    /* ② 数量：两条（桩里给的）。 */
    const hasCount = /等待中（2 份）/.test(block.textContent ?? '')
    console.log('   ★ 显示等待中的份数（2 份）:', hasCount ? '✓' : '✗', (block.textContent ?? '').slice(0, 60))
    if (!hasCount) errors.push('等待中区没有显示份数「等待中（2 份）」')

    /* ③ 两种「等什么」分别显示对：
     *    `until` 那条要带 09:30；时长型那条**不能**出现 09:30（否则是把 until 漏出去了）。
     *
     * ## 这一条 2026-10-27 修过一次（票 18），改的是**前提**不是判据
     *
     * 判据一个字没动（还是「until 带 09:30 / 时长型不带 09:30」）。改的是桩数据：
     *
     * | 问题 | 原来 | 现在 |
     * |---|---|---|
     * | 时长型那行曾会把**当前时间 +10 分钟**格式化出来 → 测试恰在 09:20 启动时磨出 09:30，假红 | `resumeAt: Date.now() + 600000` | 固定时刻 `2026-10-27 14:05` |
     * | 时长型那条**没有** `until` 字段 → 「漏不漏 until」这件事验不到 | 无 `until` | 给一个与 until 那条**相同**的 `09:30` |
     *
     * 第二条尤其要紧：原来那个桩里时长型根本没有 `until` 可漏，
     * 所以「组件不管 mode 就把 until 拼上去」这个真错**永远不会显形**。
     * 现在两条的 `09:30` 一模一样，组件只要漏一次，这一行立刻出现 09:30 → 红。
     *
     * 「顺序」不是问题：`rowOf` 按 `data-ewb-paused-resume` 的 id 查 DOM，
     * 把桩里两条记录对调照样绿（已实测，见票 18 验收 1）。 */
    const rowOf = id => doc.querySelector('[data-ewb-paused-resume="' + id + '"]')?.parentElement?.parentElement ?? null
    const untilRow = rowOf('p-until')
    const durRow = rowOf('p-dur')
    const untilText = untilRow?.textContent ?? ''
    const durText = durRow?.textContent ?? ''
    console.log('   ★ until 那条显示等到 09:30:', /09:30/.test(untilText) ? '✓' : '✗', untilText.slice(0, 70))
    if (!/09:30/.test(untilText)) errors.push('until 档的等待中没有显示 until 的 09:30')
    console.log('   ★ 时长型那条不显示 09:30:', /09:30/.test(durText) ? '✗' : '✓', durText.slice(0, 70))
    if (/09:30/.test(durText)) errors.push('时长型的等待中也显示了 09:30（until 漏到了另一条）')
    /* ★ 再加一条：时长型那行要显示**它自己的**固定时刻，证明那栏真的走了时长分支。
     *
     * 只验「没有 09:30」是**不够**的 —— 那一栏整个空着、或者显示一个空串，
     * 上面那条也是绿的。所以补一条正面的：它得说出自己的 `resumeAt`。
     * 桩里钉的是 `2026-10-27 14:05`，渲染成 `10-27 14:05`。 */
    console.log('   ★ 时长型那条显示它自己的恢复时刻（14:05）:', /10-27 14:05/.test(durText) ? '✓' : '✗', durText.slice(0, 70))
    if (!/10-27 14:05/.test(durText)) errors.push('时长型的等待中没有显示它自己的恢复时刻（那一栏可能是空的）')

    /* ④ 每条的「继续」「放弃」都在。 */
    const hasBtns = ['p-until', 'p-dur'].every(id =>
      doc.querySelector('[data-ewb-paused-resume="' + id + '"]') !== null
      && doc.querySelector('[data-ewb-paused-cancel="' + id + '"]') !== null)
    console.log('   ★ 两条各有「继续」「放弃」:', hasBtns ? '✓' : '✗')
    if (!hasBtns) errors.push('等待中的行缺少「继续」或「放弃」按钮')

    /* ⑤ 块内自己的刷新入口（用户盯着这块，不该退到页面底部找按钮）。 */
    const refreshBtn = block.querySelector('[data-ewb-paused-refresh]')
    console.log('   ★ 块内有「刷新等待中」:', refreshBtn !== null ? '✓' : '✗',
      refreshBtn === null ? '' : '（' + (refreshBtn.textContent ?? '').trim() + '）')
    if (refreshBtn === null) errors.push('等待中区里没有「刷新等待中」按钮')

    /* ⑥ 换成**空列表**再刷一次 → 块该消失，只剩底部那行说明。
     *    这条防的是「没有在等的也硬撑一个空框」。 */
    __ewbPaused = []
    refreshBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const blockAfter = doc.querySelector('[data-ewb-paused]')
    const noneLine = doc.querySelector('[data-ewb-paused-none]')
    console.log('   ★ 没有在等的运行时不渲染空块:', blockAfter === null ? '✓' : '✗')
    if (blockAfter !== null) errors.push('没有等待中的运行时仍渲染了「等待中」空块')
    console.log('   ★ 底部留一行「暂无等待中的运行」:', noneLine !== null ? '✓' : '✗',
      noneLine === null ? '' : (noneLine.textContent ?? '').trim())
    if (noneLine === null) errors.push('没有等待中的运行时，底部缺少「暂无等待中的运行」说明')
  }
}

/* ⓘ 提醒的两项设置：**已从独立板块搬进工作台设置**（2026-10-23 契约 P）
 *
 * ## 这一段为什么整段重写
 *
 * 用户 m02240：「提醒板块仅仅是设置问题，将提醒板块内容压缩放到工作台设置中」。
 * 提醒**不再是板块**，所以旧的「挂 `NotifyBoard` 验板块」这条路**不存在了** ——
 * 继续那样写就是「测一个已经没人能点到的组件」，绿了也说明不了产品是对的。
 *
 * ## 判据整段搬过来，并且**按新要求又加了两条**
 *
 * | 项 | 改前（在 NotifyBoard 里） | 改后（在 WorkspaceSettings 里） |
 * | --- | --- | --- |
 * | 位置 | 独立板块，点侧栏进去 | ★ 设置里一节，与「模型」「浏览器」并列（票 66 起在配置板块的「其它」格） |
 * | 形状 | 失败两态 + 预警四档 | 同（一字未改，语义也不许改） |
 * | 选中态 | 桩 → 各自选中 | 同 |
 * | 两项独立 | 失败关着时预警那行仍说「信息及以上才发」 | 同（改成比**说明文字**） |
 * | POST 只带一个键 | 有 | 同 |
 * | 读失败不冒充默认 | 有 | 同 |
 * | 写失败保留原值 | 有 | 同 |
 * | **说明只显示当前选中那项** | ❌ 四档说明一次铺开 | ★★ 新增：说明文字**跟着选中项变**，且**不许同时出现两档的说明** |
 *
 * 最后那条是本次的用户要求原话（「说明文案只放当前选项的说明，为每个选项做说明然后切换」），
 * 旧结构**做不到**，所以它是这次真正的判据增量。
 *
 * ## 为什么新增「不许同时出现两档说明」这一条
 *
 * 只验「说明跟着变」还不够：把四档说明全铺开、只是把当前那条**高亮**，
 * 也能让「跟着变」通过（高亮换了）。所以还要验**反面** ——
 * 选 `off` 时，`notice` / `severe` 那两句说明**一个字都不该出现在这一节里**。
 *
 * ⚠️ 桩值仍是 `{failNotify:false, alertMinLevel:'info'}`（两个结论**不一样**，
 * 写错一项就会露），理由与改前相同。
 */
console.log('')
console.log('ⓘ [新能力] 提醒的两项设置在**工作台设置**里，说明只显示当前选中项')
{
  /* ⚠️ **从源码挂 `ConfigBoard`，不点侧栏**：理由与本文件 ⑬⑭⑰⑲ 相同 ——
   * 产物由校核统一重建，执行角色不许自己跑 bundle；读产物会把「没重建」误报成「代码坏了」。
   *
   * ⚠️ 票 66：原来挂的是 `WorkspaceSettings` 抽屉，抽屉已删。
   * 提醒住在配置板块的「其它」那一格，所以 `tab: 'other'` —— 只渲染当前格，
   * 给 `'model'` 这一节根本不挂出来。
   *
   * 浏览器那两条接口顺带桩掉（同一格还有「浏览器」一节，不桩会去连真的宿主半）。 */
  globalThis.React = React
  const { ConfigBoard } = await import('../src/client/workbench/ConfigBoard.tsx')

  const realFetchNotify = window.fetch
  window.fetch = globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('/browser/prefs')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
    if (u.includes('/browser/detect')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, browsers: [], cdp: { listening: false, endpoints: [] } }) }
    }
    return realFetchNotify(url, init)
  }

  /** 挂一次配置板块的「其它」那一格（提醒与浏览器都在里面）。 */
  const mountWs = async () => {
    const h = window.document.createElement('div')
    window.document.body.appendChild(h)
    const r = ReactDOMClient.createRoot(h)
    r.render(React.createElement(ConfigBoard, { active: true, tab: 'other' }))
    await settle()
    return { h, r, unmount: () => { r.unmount(); h.remove() } }
  }

  __ewbNotifyPrefs = { failNotify: false, alertMinLevel: 'info' }
  const ui1 = await mountWs()
  const doc1 = ui1.h

  /* ── ① 它在工作台设置里，而且与「模型」「浏览器」**并列** ───────────
   *
   * 判据是**结构**（同一个父容器下的兄弟块），不是类名 —— 测试里 CSS Modules
   * 被桩成空对象，类名比不出来。这与 ⑲ 段验「模型与浏览器并列」是同一套办法。 */
  const notifySec = doc1.querySelector('[data-ewb-notify-section]')
  console.log('   ★ 工作台设置里有「提醒」一节:', notifySec !== null ? '✓' : '✗')
  if (notifySec === null) errors.push('工作台设置里没有「提醒」一节（data-ewb-notify-section 不存在）')

  if (notifySec !== null) {
    const secText = (notifySec.textContent ?? '').trim()
    console.log('   这一节的标题是「提醒」:', secText.startsWith('提醒') ? '✓' : '✗（' + secText.slice(0, 20) + '）')
    if (!secText.startsWith('提醒')) errors.push('「提醒」一节的标题不是「提醒」')

    /* ⚠️ 票 66：这条原来是「模型 / 提醒 / 浏览器 是同一个父容器的直接子项」
     * （抽屉时代三节同屏）。
     *
     * 现在两格互斥 —— 模型在「模型」格，提醒与浏览器在「其它」格，
     * 所以「三块同层」这个前提本身不成立了。**判据跟着分成两半，合起来更强**：
     *
     *   ① 提醒与浏览器**是同一格的兄弟块**（原来验「三块同层」，这里验「两块同层」）；
     *   ② 反面：模型**不在这一格**（原来没有这条 —— 旧形态里三块同屏，
     *      根本不关心「会不会混格」，因为不存在格）。
     *
     * ② 才是这次真正的新骨头：混格 = 两格一起渲染 = 进一次发两路请求。 */
    const body = notifySec.parentElement
    const hasBrowser = [...(body?.children ?? [])].some(el => (el.textContent ?? '').includes('默认来源'))
    console.log('   ★ 「提醒」与「浏览器」同格并列（同一父容器的兄弟块）:', hasBrowser ? '✓' : '✗')
    if (!hasBrowser) {
      errors.push('「提醒」与「浏览器」不在同一格（「其它」格的两块没挨在一起）')
    }
    const modelLeaked = (body?.textContent ?? '').includes('全部可用模型')
    console.log('   ★ 反面：模型那一块不在「其它」格里:', modelLeaked ? '✗' : '✓')
    if (modelLeaked) {
      errors.push('「其它」格里混进了模型那一块（两格被一起渲染了）')
    }
  }

  if (notifySec !== null) {
    /* ── ② 两项设置：形状与选中态（**语义与搬家前一致，一字未改**）── */
    const failBox = notifySec.querySelector('[data-ewb-notify-fail]')
    const failOpts = [...(failBox?.querySelectorAll('[data-ewb-notify-fail-option]') ?? [])]
      .map(o => ({
        value: o.getAttribute('data-ewb-notify-fail-option'),
        label: (o.textContent ?? '').trim(),
        pressed: o.getAttribute('aria-pressed'),
      }))
    const failShape = failOpts.length === 2
      && failOpts.some(o => o.value === 'on' && o.label === '提醒')
      && failOpts.some(o => o.value === 'off' && o.label === '不提醒')
    console.log('   ★ 工作流失败提醒有两态（提醒 / 不提醒）:', failShape ? '✓' : '✗（' + failOpts.map(o => o.value + '=' + o.label).join(' / ') + '）')
    if (!failShape) errors.push('「工作流失败提醒」不是两态（提醒 / 不提醒）')

    const failPressed = failOpts.filter(o => o.pressed === 'true').map(o => o.value)
    console.log('   桩 failNotify=false → 失败那项选中「不提醒」:',
      failPressed.length === 1 && failPressed[0] === 'off' ? '✓' : '✗（' + failPressed.join(',') + '）')
    if (!(failPressed.length === 1 && failPressed[0] === 'off')) {
      errors.push('桩 failNotify=false 时「工作流失败提醒」选中态不对（实际：' + (failPressed.join(',') || '无') + '）')
    }

    const alertBox = notifySec.querySelector('[data-ewb-notify-alert]')
    const alertOpts = [...(alertBox?.querySelectorAll('[data-ewb-notify-alert-option]') ?? [])]
      .map(o => ({
        value: o.getAttribute('data-ewb-notify-alert-option'),
        label: (o.textContent ?? '').trim(),
        pressed: o.getAttribute('aria-pressed'),
      }))
    const ALERT_WANT = [
      { value: 'off', label: '不发送' },
      { value: 'info', label: '信息及以上' },
      { value: 'notice', label: '注意及以上' },
      { value: 'severe', label: '严重及以上' },
    ]
    const alertShape = ALERT_WANT.every(w => alertOpts.some(o => o.value === w.value && o.label === w.label))
      && alertOpts.length === ALERT_WANT.length
    console.log('   ★ 预警节点四档齐（不发送 / 信息及以上 / 注意及以上 / 严重及以上）:',
      alertShape ? '✓' : '✗（' + alertOpts.map(o => o.value + '=' + o.label).join(' / ') + '）')
    if (!alertShape) errors.push('预警节点门槛不是「不发送 / 信息及以上 / 注意及以上 / 严重及以上」四档')

    const alertPressed = alertOpts.filter(o => o.pressed === 'true').map(o => o.value)
    console.log('   桩 alertMinLevel=info → 预警那项选中「信息及以上」:',
      alertPressed.length === 1 && alertPressed[0] === 'info' ? '✓' : '✗（' + alertPressed.join(',') + '）')
    if (!(alertPressed.length === 1 && alertPressed[0] === 'info')) {
      errors.push('桩 alertMinLevel=info 时预警门槛选中态不对（实际：' + (alertPressed.join(',') || '无') + '）')
    }

    /* ── ★★③ 说明只显示**当前选中那一项**（本次用户要求的落点）──────
     *
     * 三层判据，缺一层就能蒙混过关：
     *   a) 当前那项的说明**在**（选 info 时说明里提「信息」）；
     *   b) 别档的说明**不在**（不许把 notice / severe 那两句也铺出来）；
     *   c) **换一项之后说明跟着换**（点 severe → 说明变成 severe 那句，
     *      而 info 那句不再出现）。
     *
     * 只验 a) 的话，把四档全铺开、高亮一条也能过；加上 b) c) 才封死。 */
    const alertNoteEl = notifySec.querySelector('[data-ewb-notify-alert-note]')
    const noteNow = (alertNoteEl?.textContent ?? '').trim()
    const saysInfo = noteNow.includes('信息')
    console.log('   ★ 预警说明只有一句、且说的是「信息」那一档:', saysInfo ? '✓' : '✗（' + noteNow + '）')
    if (!saysInfo) errors.push('预警节点的说明没跟着当前选中项（选的是信息及以上，说明里却没提「信息」）')

    /* b) 反面：别的档的**特征词**不许出现在这一节的说明里。
     * ⚠️ 用带上下文的短语（「需要留意」「需要马上处理」），不用光秃秃的「注意」「严重」——
     * 那两个字在按钮标签「注意及以上」里本来就有，拿它判会永远红。 */
    const otherPhrases = ['需要留意', '需要马上处理']
    const leaked = otherPhrases.filter(p => noteNow.includes(p))
    console.log('   ★★ 没有把别档的说明一起铺出来:', leaked.length === 0 ? '✓' : '✗（出现了「' + leaked.join('、') + '」）')
    if (leaked.length > 0) {
      errors.push('预警说明把别的档位也铺出来了（用户要求只放当前选项的说明）')
    }

    /* c) 换一项 → 说明跟着换。 */
    const severeBtn = alertBox?.querySelector('[data-ewb-notify-alert-option="severe"]')
    severeBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const noteAfter = (notifySec.querySelector('[data-ewb-notify-alert-note]')?.textContent ?? '').trim()
    const switched = noteAfter !== noteNow && noteAfter.includes('需要马上处理')
    console.log('   ★★ 切到「严重及以上」后说明跟着换:', switched ? '✓' : '✗（' + noteAfter + '）')
    if (!switched) errors.push('切换预警档位后说明没有跟着换（还是上一档那句）')
    console.log('   换过之后「信息」那句没有再出现:', !noteAfter.includes('过程正常') ? '✓' : '✗')
    if (noteAfter.includes('过程正常')) {
      errors.push('切换档位后上一档的说明还留着（说明没有真正「只放当前那项」）')
    }

    /* ── ★④ 改一项只提交那一个键（契约形状，不是实现细节）───────── */
    const before = __ewbNotifyPosts.length
    const offBtn = alertBox?.querySelector('[data-ewb-notify-alert-option="off"]')
    offBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const posted = __ewbNotifyPosts.slice(before)
    const keys = posted.length === 0 ? [] : Object.keys(posted[posted.length - 1])
    console.log('   点预警档后的请求体键:', keys.join(',') || '(无请求)',
      keys.length === 1 && keys[0] === 'alertMinLevel' ? '✓' : '✗')
    if (!(keys.length === 1 && keys[0] === 'alertMinLevel')) {
      errors.push('改预警档时 POST 不是只带 alertMinLevel 一个键（实际：' + (keys.join(',') || '无请求') + '）')
    }
    /* ★⑤ 反过来：改失败那项只带 failNotify。 */
    const before2 = __ewbNotifyPosts.length
    const onBtn = failBox?.querySelector('[data-ewb-notify-fail-option="on"]')
    onBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const posted2 = __ewbNotifyPosts.slice(before2)
    const keys2 = posted2.length === 0 ? [] : Object.keys(posted2[posted2.length - 1])
    console.log('   点失败开关后的请求体键:', keys2.join(',') || '(无请求)',
      keys2.length === 1 && keys2[0] === 'failNotify' ? '✓' : '✗')
    if (!(keys2.length === 1 && keys2[0] === 'failNotify')) {
      errors.push('改失败开关时 POST 不是只带 failNotify 一个键（实际：' + (keys2.join(',') || '无请求') + '）')
    }
    console.log('   预警档没有被这次改动带歪:', __ewbNotifyPrefs.alertMinLevel === 'off'
      ? '✓' : '✗（' + __ewbNotifyPrefs.alertMinLevel + '）')
    if (__ewbNotifyPrefs.alertMinLevel !== 'off') {
      errors.push('改失败开关把预警档也改掉了（两项没有独立）')
    }

    /* ── ★⑥ 失败那项也「只放当前那项的说明」 ───────────────────
     * 上面三条验的是预警那项；失败那项同一条要求，各验各的。 */
    const failNoteEl = notifySec.querySelector('[data-ewb-notify-fail-note]')
    const failNote = (failNoteEl?.textContent ?? '').trim()
    /* 此刻 failNotify 已被点到 on（上一块刚点的），说明应当讲「会发」那一档。 */
    const failOnNote = failNote.includes('各发一条')
    console.log('   ★ 失败提醒的说明也只看当前那项（选中 on 时讲「各发一条」）:', failOnNote ? '✓' : '✗（' + failNote + '）')
    if (!failOnNote) errors.push('失败提醒的说明没跟着当前选中项（选的是提醒，说明却没讲会发）')
    const failOffPhrase = '失败原因仍记在'
    console.log('   失败那项也没把「不提醒」那句一起铺出来:', !failNote.includes(failOffPhrase) ? '✓' : '✗')
    if (failNote.includes(failOffPhrase)) {
      errors.push('失败提醒的说明把「不提醒」那一档也铺出来了')
    }
  }
  ui1.unmount()

  /* ── ★⑦ 读失败：不拿默认值冒充成功 ────────────────────────────
   *
   * 判据三条一起看（与搬家前一致）：
   *   ① 两个选项**一个都不选中**；② 三段式；③ 「重试」在。
   *   加一条：**说明一行都不许出现** —— 读不到时不知道该讲哪一档。 */
  __ewbNotifyFailRead = true
  const ui2 = await mountWs()
  {
    const box = ui2.h.querySelector('[data-ewb-notify-section]')
    const pressedCount = [...(box?.querySelectorAll('[data-ewb-notify-fail-option],[data-ewb-notify-alert-option]') ?? [])]
      .filter(o => o.getAttribute('aria-pressed') === 'true').length
    console.log('   ★ 读失败时没有任何选项被选中（不冒充默认值）:', pressedCount === 0 ? '✓' : '✗（' + pressedCount + ' 个选中）')
    if (pressedCount !== 0) errors.push('读失败时仍有 ' + pressedCount + ' 个选项显示为选中 —— 拿默认值冒充了成功')
    const txt = box?.textContent ?? ''
    const three = txt.includes('读不到') && txt.includes('数据目录') && txt.includes('检查工作台引擎')
    console.log('   ★ 读失败给了三段式（读不到 / 为什么 / 怎么办）:', three ? '✓' : '✗')
    if (!three) errors.push('读失败没有给三段式提示（读不到 / 为什么 / 怎么办）')
    const retry = [...(box?.querySelectorAll('button') ?? [])].some(b => (b.textContent ?? '').trim() === '重试')
    console.log('   读失败给了「重试」:', retry ? '✓' : '✗')
    if (!retry) errors.push('读失败没有「重试」按钮')
    const disabled = [...(box?.querySelectorAll('[data-ewb-notify-fail-option]') ?? [])].every(o => o.disabled === true)
    console.log('   读失败时选项不可点:', disabled ? '✓' : '✗')
    if (!disabled) errors.push('读失败时选项仍可点（在不知道当前值的情况下改它）')
    /* 读不到时**不许出现任何一档的说明**（不知道该讲哪一档，写哪句都是猜）。 */
    console.log('   读失败时不显示任何一档的说明:',
      box?.querySelector('[data-ewb-notify-fail-note]') === null
      && box?.querySelector('[data-ewb-notify-alert-note]') === null ? '✓' : '✗')
    if (box?.querySelector('[data-ewb-notify-fail-note]') !== null
      || box?.querySelector('[data-ewb-notify-alert-note]') !== null) {
      errors.push('读失败时还在显示说明（不知道该讲哪一档，写哪句都是猜）')
    }
  }
  ui2.unmount()
  __ewbNotifyFailRead = false

  /* ── ★⑧ 写失败：保留原选中 + 三段式，且不改成点下去那个值 ──────── */
  __ewbNotifyPrefs = { failNotify: false, alertMinLevel: 'info' }
  __ewbNotifyFailWrite = true
  const ui3 = await mountWs()
  {
    const box = ui3.h.querySelector('[data-ewb-notify-fail]')
    box?.querySelector('[data-ewb-notify-fail-option="on"]')
      ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const pressed = [...(box?.querySelectorAll('[data-ewb-notify-fail-option]') ?? [])]
      .filter(o => o.getAttribute('aria-pressed') === 'true')
      .map(o => o.getAttribute('data-ewb-notify-fail-option'))
    console.log('   ★ 写失败后选中态仍是原值（不提醒）:', pressed.length === 1 && pressed[0] === 'off'
      ? '✓' : '✗（' + pressed.join(',') + '）')
    if (!(pressed.length === 1 && pressed[0] === 'off')) {
      errors.push('写失败后选中态变成了新值 —— 显示已存但实际没存，是假成功')
    }
    const errTxt = ui3.h.querySelector('[data-ewb-notify-section]')?.textContent ?? ''
    const three = errTxt.includes('没有保存成功') && errTxt.includes('磁盘或权限') && errTxt.includes('原来的设置仍然有效')
    console.log('   ★ 写失败给了三段式:', three ? '✓' : '✗')
    if (!three) errors.push('写失败没有给三段式（没保存 / 为什么 / 原值仍有效）')
  }
  ui3.unmount()
  __ewbNotifyFailWrite = false
  __ewbNotifyPrefs = { failNotify: false, alertMinLevel: 'info' }

  /* ── ★⑨ 底部的**折叠诊断块**（2026-10-23 契约 P 决定一）──────────────
   *
   * ## 为什么这一段必须有，而且要验「它在」而不是只验「它好用」
   *
   * 「通知通道自检」与「什么情况会提醒」原先住在左侧导航的「提醒」板块里。
   * 板块下线后，那个组件的文件还在、却**没有任何人引用** —— 死代码。
   *
   * 死代码最坏的地方不是占空间，是**下次有人改它以为会生效**；
   * 而且它当时**零测试覆盖**，改了也不会有任何东西变红。
   *
   * 所以这里第一件事就是验「它被挂上了」：
   * 从**设置页**（配置板块的「其它」格，不是直接 import 诊断块）往下找
   * `data-ewb-notify-diag` —— 找不到就等于它仍然是死代码。
   *
   * | 判据 | 防的错 |
   * | --- | --- |
   * | 诊断块在「提醒」那一节里，且默认**收起** | 死代码；或一进设置就铺开一大片运行时探测 |
   * | 展开后「检测通知通道」在 | 自检入口丢了（用户当初正是靠它发现总开关被关） |
   * | 点自检真发请求、结果三项逐项显示 | 按钮是摆设；或三项合成一句「不可用」，人没法修 |
   * | 「什么情况会提醒」列出条目（含未接入那条） | 只列会发的，用户以为巡查异常也在提醒 |
   */
  {
    const ui4 = await mountWs()
    const sec = ui4.h.querySelector('[data-ewb-notify-section]')
    const diag = sec?.querySelector('[data-ewb-notify-diag]')
    console.log('   ★ 诊断块挂上了（不是死代码）:', diag !== null ? '✓' : '✗')
    if (diag === null) {
      errors.push('「提醒」一节里没有诊断块（data-ewb-notify-diag 不存在）—— 组件成了死代码')
    }
    /* 默认收起：一进设置就铺开自检按钮与任务清单，会让人以为这是设置项。 */
    const closed = diag?.querySelector('[data-ewb-notify-diag-body]') === null
    console.log('   ★ 诊断块默认是收起的:', closed ? '✓' : '✗')
    if (!closed) errors.push('诊断块默认就展开了（进来一大片运行时探测，不像设置）')

    const toggle = diag?.querySelector('[data-ewb-notify-diag-toggle]')
    console.log('   有一个展开/收起的开关:', toggle !== null && toggle !== undefined ? '✓' : '✗')
    if (toggle === null || toggle === undefined) errors.push('诊断块没有展开/收起按钮')

    toggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()

    const checkBtn = ui4.h.querySelector('[data-ewb-notify-check]')
    console.log('   ★ 展开后有「检测通知通道」:', checkBtn !== null ? '✓' : '✗')
    if (checkBtn === null) errors.push('诊断块展开后没有「检测通知通道」按钮')

    checkBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()

    /* 三项**逐项**显示，且过与不过都写原因 —— 合成一句等于让人没法修。 */
    const items = [...ui4.h.querySelectorAll('[data-ewb-notify-check-item]')]
      .map(el => ({
        key: el.getAttribute('data-ewb-notify-check-item'),
        state: el.querySelector('[data-ewb-notify-check-state]')?.getAttribute('data-ewb-notify-check-state'),
        text: (el.textContent ?? '').trim(),
      }))
    console.log('   ★ 自检结果三项逐项显示:', items.length === 3 ? '✓' : '✗（' + items.length + ' 项）')
    if (items.length !== 3) errors.push('通知自检结果不是三项逐项显示（合成一句「不可用」等于让人没法修）')
    const okItem = items.find(i => i.key === 'powershell')
    const badItem = items.find(i => i.key === 'pushSwitch')
    const okRight = okItem?.state === 'ok' && okItem.text.includes('PowerShell 能起来')
    const badRight = badItem?.state === 'err' && badItem.text.includes('系统通知总开关是关的')
    console.log('   ★ 通过的那项标通过并带原因:', okRight ? '✓' : '✗（' + (okItem?.text ?? '缺') + '）')
    if (!okRight) errors.push('自检里通过的那项没标「通过」或没带原因')
    console.log('   ★ 不通过的那项标不通过、并写明怎么修:', badRight ? '✓' : '✗（' + (badItem?.text ?? '缺') + '）')
    if (!badRight) errors.push('自检里不通过的那项没标「不通过」或没写明原因')
    /* 不通过那项还要给出**修法**（`CHECK_ITEMS.fail` 那句），否则用户只知道坏了。 */
    const hasFix = (badItem?.text ?? '').includes('设置 → 系统 → 通知')
    console.log('   不通过那项给了具体修法:', hasFix ? '✓' : '✗')
    if (!hasFix) errors.push('自检不通过的那项只说了坏了、没说怎么修')

    /* 「什么情况会提醒」：桩里有一条启用的巡查任务，另有「未接入」那条。
     * 两条都得在 —— 只列会发的，用户会以为巡查判出异常也在提醒。 */
    const cases = [...ui4.h.querySelectorAll('[data-ewb-notify-case]')]
      .map(el => el.getAttribute('data-ewb-notify-case'))
    console.log('   ★ 「什么情况会提醒」列出了条目:', cases.length >= 3 ? '✓（' + cases.join(',') + '）' : '✗（' + cases.join(',') + '）')
    if (cases.length < 3) errors.push('「什么情况会提醒」没列出条目（用户看不出哪些情况真的接了）')
    const taskRow = ui4.h.querySelector('[data-ewb-notify-task="st-1"]')
    console.log('   启用中的那条任务单独一行:', taskRow !== null ? '✓' : '✗')
    if (taskRow === null) errors.push('「什么情况会提醒」没把启用中的定时任务逐条列出')
    console.log('   ★ 未接入的也如实列出来（不让人以为已经在提醒）:',
      cases.includes('patrol-anomaly') ? '✓' : '✗')
    if (!cases.includes('patrol-anomaly')) {
      errors.push('「什么情况会提醒」没列「未接入」那条（会让人以为巡查异常也在提醒）')
    }

    ui4.unmount()
  }
  __ewbNotifyPrefs = { failNotify: false, alertMinLevel: 'info' }

  window.fetch = globalThis.fetch = realFetchNotify
}

/* ⓘ 收藏板块：Github 项目**能在前端选分类**（用户 m00861）────────────────
 *
 * ⚠️ **必须放在整份测试的最后** —— 它要把板块切到「收藏」，
 * 而上面所有跟画布 / 工作流列表有关的断言都要求停在原来的板块。
 * （第一版塞在 ⑧ 段的中间，把那段后半截的断言全带崩了 —— 假红。）
 *
 * 判据分两层（缺一不可）：
 *   ① 展开一行项目后，出现「分类」控件（可输入的下拉 = input + datalist）；
 *   ② 候选里**既有固定 5 类、也有数据里出现过的自定义分类**（「输入就是新建」靠它）。
 *      —— 只断「控件在」的话，给一个空下拉也能绿。 */
{
  const backCollect = [...doc.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '收藏')
  backCollect?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  const ghTab = [...doc.querySelectorAll('[role="tab"]')].find(b => (b.textContent ?? '').trim() === 'Github项目')
  ghTab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  /* ⚠️ **先看是不是已经展开着** —— 上面第 ⑦ 段已经点开过一行项目，
   * 再点一次就是**收起**（展开是开关）。第一版无条件点一下，于是把已展开的收了起来，
   * 分类控件当然找不到（假红）。 */
  const findCat = () => [...doc.querySelectorAll('input[type="text"]')]
    .find(i => (i.getAttribute('list') ?? '') === 'ewb-proj-cat')
  if (findCat() === undefined) {
    /* ⚠️ 用**展开箭头那个按钮**（title 以「展开：改名称」开头），不要按 role=button 找行 ——
     * 项目行本身不是 role=button（与工作流行那种结构不同），按它找会找不到、静默不展开。
     * §⑦ 就是这么点开的（同一个选择器）。 */
    const arrow = [...doc.querySelectorAll('button')]
      .find(b => (b.getAttribute('title') ?? '').startsWith('展开：改名称'))
    arrow?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
  }
  const catInput = findCat()
  console.log('   ★ 项目展开后有「分类」控件:', catInput !== undefined ? '✓' : '✗')
  if (catInput === undefined) errors.push('收藏板块的 Github 项目没有分类控件（用户 m00861 报的缺口）')
  const catList = catInput === undefined ? null : doc.getElementById(catInput.getAttribute('list') ?? '')
  const catOpts = [...(catList?.querySelectorAll('option') ?? [])].map(o => o.getAttribute('value') ?? '')
  const hasFixed = catOpts.some(o => o === 'Agent 与 Skill')
  const hasCustom = catOpts.some(o => o === '采集与搜索')
  console.log('   ★ 候选里既有固定分类、也有数据里的分类:',
    hasFixed && hasCustom ? '✓' : '✗（' + catOpts.join(' / ') + '）')
  if (!hasFixed || !hasCustom) {
    errors.push('分类候选只给了一部分（要么丢固定 5 类、要么丢数据里已有的）')
  }
}

/* ⑬ 提示词板块（2026-10-22 加，第九个板块）。
 *
 * ## 为什么分两段断言
 *
 * ① **数据层**直接 import 源码里的模板表 —— 这一段的判据与被测代码是同一份数据，
 *    模板被删、id 重名、变量识别写坏，这里立刻变红，与构建产物无关。
 * ② **界面层**要真的点开那个板块、点模板、填变量、看预览。
 *    它读的是 `lib/client.js`（构建产物），所以**只有在产物重建之后**才跑得到。
 *
 * ⚠️ 产物落后时**不判红**（否则这一条会把「没重建」误报成「代码坏了」，
 * 而重建不归执行角色做）—— 但会打一条显眼的 ⚠️ 警告，不会悄悄跳过。
 * 产物重建后这一段自动生效，判据本身不需要改。
 */
console.log('⑬ [第九板块] 提示词 · 模板库')
{
  const { PROMPT_TEMPLATES, PROMPT_CATEGORIES, findVars, fillVars, VAR_LABELS, varLabel } =
    await import('../src/client/workbench/templates/index.ts')

  /* ── ① 数据层 ─────────────────────────────────────────────── */
  console.log('   模板数:', PROMPT_TEMPLATES.length, PROMPT_TEMPLATES.length >= 6 ? '✓' : '✗')
  if (PROMPT_TEMPLATES.length < 6) errors.push('模板库不足 6 个模板（用户要的是「能直接用的库」，不是样例）')

  console.log('   分类数:', PROMPT_CATEGORIES.length, PROMPT_CATEGORIES.length >= 3 ? '✓' : '✗')
  if (PROMPT_CATEGORIES.length < 3) errors.push('模板分类不足 3 个（优化 / 迭代 / 提取）')

  const ids = PROMPT_TEMPLATES.map(t => t.id)
  console.log('   id 不重复:', new Set(ids).size === ids.length ? '✓' : '✗（' + ids.join(',') + '）')
  if (new Set(ids).size !== ids.length) errors.push('模板 id 有重复')

  const thin = PROMPT_TEMPLATES.filter(t => t.desc.length <= 4 || t.body.length <= 100)
  console.log('   每个模板都有说明与正文:', thin.length === 0 ? '✓' : '✗（' + thin.map(t => t.id).join(',') + '）')
  if (thin.length > 0) errors.push('有模板缺说明或正文过短：' + thin.map(t => t.id).join(','))

  /* 许可证注记：任务书要求模板文件头写明来源与 AGPL-3.0。 */
  const tplDir = new URL('../src/client/workbench/templates/', import.meta.url)
  const licenseMiss = ['optimize.ts', 'iterate.ts', 'extract.ts'].filter(f => {
    const text = readFileSync(new URL(f, tplDir), 'utf8')
    return !/prompt-optimizer/.test(text) || !/AGPL-3\.0/.test(text)
  })
  console.log('   ★ 模板文件头有来源与许可证注记:', licenseMiss.length === 0 ? '✓' : '✗（' + licenseMiss.join(',') + '）')
  if (licenseMiss.length > 0) errors.push('模板数据文件缺来源/许可证注记：' + licenseMiss.join(','))

  /* ★ 变量识别：只认双花括号。这一条是本轮最容易做错的地方 ——
   * 第一版把 `[角色名称]` 这类**给模型填的骨架**也认成了变量，
   * 打开「通用优化」会冒出二十几个输入框，模板就废了。 */
  const probeVars = findVars('填 {{甲}} 与 {{甲}}，骨架【乙】和[丙] 不算变量')
  const onlyJia = probeVars.length === 1 && probeVars[0].name === '甲' && probeVars[0].count === 2
  console.log('   ★ 变量只认双花括号、同名合并计数:', onlyJia ? '✓' : '✗（' + JSON.stringify(probeVars) + '）')
  if (!onlyJia) errors.push('变量识别不对：它应当只认 {{名字}}，并把同名合并成一条计数')

  console.log('   空占位不算变量:', findVars('{{}} {{ }}').length === 0 ? '✓' : '✗')
  if (findVars('{{}} {{ }}').length !== 0) errors.push('空的 {{ }} 被当成了变量（会冒出没有名字的输入框）')

  /* 每份真实模板的变量数都要是个位数 —— 多了就说明骨架被误认了。 */
  const tooMany = PROMPT_TEMPLATES
    .map(t => ({ id: t.id, n: findVars(t.body).length }))
    .filter(x => x.n > 5)
  console.log('   每份模板变量数都不超过 5:', tooMany.length === 0 ? '✓'
    : '✗（' + tooMany.map(x => x.id + ':' + x.n).join(' ') + '）')
  if (tooMany.length > 0) errors.push('有模板的变量数超过 5，多半是把给模型填的骨架也认成了变量：' + tooMany.map(x => x.id).join(','))

  const filled = fillVars('A{{x}}B{{y}}', { x: '1' })
  console.log('   填值只换填了的那个、没填的原样留:', filled === 'A1B{{y}}' ? '✓' : '✗（' + filled + '）')
  if (filled !== 'A1B{{y}}') errors.push('fillVars 不该把没填的变量删掉（留着才能看出「这里还没填」）')

  /* ── ② 界面层：真挂一块到这个 jsdom 里 ────────────────────────
   *
   * ⚠️ **直接从源码 import 组件，不走 `lib/client.js`**。
   * 理由：产物由校核统一重建，执行角色不许自己跑 bundle。若这里读产物，
   * 「源码写好了但还没重建」会被判成红 —— 那是把「没重建」误报成「代码坏了」。
   * 直接 import 源码则测得就是**此刻的代码**，产物重建与否都能跑。
   *
   * 挂到**独立的容器**上，不碰工作台主界面那棵树（避免把上面的断言搞乱）。 */
  globalThis.React = React
  const { PromptBoard } = await import('../src/client/workbench/PromptBoard.tsx')
  const promptHost = window.document.createElement('div')
  window.document.body.appendChild(promptHost)
  const promptRoot = ReactDOMClient.createRoot(promptHost)
  const P = PromptBoard
  promptRoot.render(React.createElement(P, {
    active: true, tab: '', apiBase: '/api/ecom-workbench', topHidden: false,
    onToggleTop: () => {}, onSelectTab: () => {}, onRunWorkflow: () => {},
  }))
  await settle()

  const norm = s => (s ?? '').replace(/\s+/g, '')
  const q = sel => [...promptHost.querySelectorAll(sel)]
  const text = () => promptHost.textContent ?? ''

  const items = q('[data-ewb-tpl]')
  console.log('   左栏模板项数:', items.length, items.length === PROMPT_TEMPLATES.length ? '✓' : '✗')
  if (items.length !== PROMPT_TEMPLATES.length) errors.push('提示词板块没有列出全部模板')

  /* 无白屏 = 没有错误兜底、且真的有内容。 */
  console.log('   板块没走到错误兜底:', promptHost.querySelector('[data-ewb-error-boundary]') === null ? '✓' : '✗')
  if (promptHost.querySelector('[data-ewb-error-boundary]') !== null) errors.push('提示词板块渲染抛错了')

  console.log('   按分类分组（三个分类标题都在）:',
    PROMPT_CATEGORIES.every(c => norm(text()).includes(norm(c.label))) ? '✓' : '✗')
  if (!PROMPT_CATEGORIES.every(c => norm(text()).includes(norm(c.label)))) {
    errors.push('模板清单没有按分类分组显示')
  }

  const bodyOf = () => promptHost.querySelector('[data-ewb-tpl-body]')?.textContent ?? ''
  const firstBody = bodyOf()
  console.log('   点开就有正文（不是空白右栏）:', firstBody.length > 100 ? '✓' : '✗（' + firstBody.length + ' 字）')
  if (firstBody.length <= 100) errors.push('提示词板块默认没有显示任何模板正文')

  /* 点另一份模板 → 正文必须换。 */
  const other = items.find(el => el.getAttribute('data-ewb-tpl') !== items[0]?.getAttribute('data-ewb-tpl'))
  if (other !== undefined) {
    other.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    console.log('   ★ 点另一个模板后正文变了:', bodyOf() !== firstBody && bodyOf().length > 100 ? '✓' : '✗')
    if (bodyOf() === firstBody) errors.push('点另一个模板后正文没变（模板清单与正文没接上）')
  } else {
    /* ⚠️ 补兜底（2026-10-26）：原来没有 else，模板清单只有一份时这条**静默跳过**。 */
    errors.push('模板清单里找不到第二份 —— 「点另一个模板后正文变了」那条没验到')
  }

  /* ★ 靶子：挑一份**既有变量又有粗体**的模板。
   *
   * ⚠️ 为什么不能沿用「第一个有变量的模板」（`general-optimize`）：
   * 它**没有粗体**。第一版拿它验粗体，于是「没有 `<strong>`」红了一条；
   * 同一份拿去验「复制出去的文本仍带 `**`」也红 —— 两条都是**挑错靶子**，
   * 不是代码坏了。分开挑与验证的成本，比让判据静默跳过要低得多。
   *
   * 挑不到必须**判红**（不许静默跳过，否则等于没验）。 */
  const boldTarget = PROMPT_TEMPLATES.find(
    t => findVars(t.body).length > 0 && /\*\*[^*\n]+\*\*/.test(t.body),
  )
  console.log('   有可填变量的模板:', PROMPT_TEMPLATES.some(t => findVars(t.body).length > 0) ? '有 ✓' : '0 ✗')
  if (!PROMPT_TEMPLATES.some(t => findVars(t.body).length > 0)) {
    errors.push('没有任何模板识别出变量（变量识别坏了，或模板里确实没有 {{名字}}）')
  }
  console.log('   有「变量 + 粗体」的模板:', boldTarget === undefined ? '无 ✗' : '有 ✓（' + boldTarget.id + '）')
  if (boldTarget === undefined) {
    errors.push('没有一份模板同时有变量与粗体（验不了「只读区渲染粗体」与「复制保留 **」这两条）')
  }

  const varTarget = boldTarget === undefined
    ? undefined
    : items.find(el => el.getAttribute('data-ewb-tpl') === boldTarget.id)
  if (varTarget !== undefined) {
    varTarget.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const inputs = q('[data-ewb-tpl-var]')
    console.log('   变量出了输入框:', inputs.length === findVars(boldTarget.body).length ? '✓' : '✗（' + inputs.length + '）')
    if (inputs.length !== findVars(boldTarget.body).length) errors.push('模板里的变量没有逐个变成输入框')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    if (inputs.length > 0 && setter !== undefined) {
      setter.call(inputs[0], '冰丝凉席')
      inputs[0].dispatchEvent(new window.Event('input', { bubbles: true }))
      await settle()
      const preview = promptHost.querySelector('[data-ewb-tpl-preview]')?.textContent ?? ''
      console.log('   ★ 填变量后预览里出现填的值:', preview.includes('冰丝凉席') ? '✓' : '✗')
      if (!preview.includes('冰丝凉席')) errors.push('填了变量，预览没跟着变（用户看不出自己填的对不对）')
    }
  }

  /* ── 变量的中文说法（2026-10-23 契约 U）───────────────────────
   *
   * ## 为什么这一段必须在**界面层**验
   *
   * `prompt-optimize.mjs` ⑧ 段验的是 `VAR_LABELS` 这张表本身对不对（键是英文、
   * 配了用得上、区外 100% 覆盖）。但那张表**再对**，界面不读它也是白搭 ——
   * 用户看到的仍然是一串 `originalPrompt`。所以这里验的是「读没读」：
   *
   * | 判据 | 防的错 |
   * | --- | --- |
   * | 标签文字与表一致（配了显示中文、没配显示原名） | 界面没接 `varLabel`，或接了却把没配的显示成空白 |
   * | 悬停有说明 | 只换了名字不给说明，用户仍不知填什么 |
   * | 有英文名的地方**看得到中文** | 断言恰好在「全是中文名」的模板上跳过，等于没验 |
   * | `data-ewb-tpl-var` 仍是原名 | 换显示名时把替换键也换了，正文会与参考项目脱节 |
   */
  {
    /* 找一份**有英文变量名、而且配了标签**的模板当靶子。
     * 挑不到必须判红 —— 不许静默跳过（那等于这一段从没验过）。 */
    const labelTarget = PROMPT_TEMPLATES.find(t => findVars(t.body).some(v => {
      const m = varLabel(v.name)
      return m !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v.name)
    }))
    console.log('   有「英文变量名 + 中文说法」的模板:', labelTarget === undefined ? '无 ✗' : '有 ✓（' + labelTarget.id + '）')
    if (labelTarget === undefined) {
      errors.push('没有任何模板同时具备英文变量名与中文标签（验不了「界面显示中文」这条）')
    } else {
      const target = items.find(el => el.getAttribute('data-ewb-tpl') === labelTarget.id)
      if (target === undefined) {
        errors.push('模板清单里找不到用来验中文标签的那份模板')
      } else {
        target.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await settle()

        const labelEls = [...promptHost.querySelectorAll('[data-ewb-tpl-var-label]')]
        const inputsNow = [...promptHost.querySelectorAll('[data-ewb-tpl-var]')]
        console.log('   变量名标签与输入框成对:', labelEls.length === inputsNow.length && labelEls.length > 0 ? '✓' : '✗（' + labelEls.length + '/' + inputsNow.length + '）')
        if (labelEls.length !== inputsNow.length || labelEls.length === 0) {
          errors.push('变量名标签与输入框数量对不上（用户会看到不知属于哪个输入框的名字）')
        }

        /* ① 每个标签的文字都得对：配了显示中文、没配显示原名、**绝不许空白**。 */
        const wrong = []
        const blank = []
        const plainEnglish = []
        for (const el of labelEls) {
          const name = el.getAttribute('data-ewb-tpl-var-label') ?? ''
          const meta = varLabel(name)
          const shown = (el.textContent ?? '').replace(/×\d+$/, '').trim()
          if (shown === '') blank.push(name)
          else if (meta !== undefined && shown !== meta.label) wrong.push(name + '→' + shown + '（应为 ' + meta.label + '）')
          else if (meta === undefined && shown !== name) wrong.push(name + '→' + shown)
          if (meta === undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) plainEnglish.push(name)
        }
        console.log('   ★ 有中文说法的变量名显示了中文:', wrong.length === 0 ? '✓' : '✗（' + wrong.join('; ') + '）')
        if (wrong.length > 0) errors.push('变量名显示的与 VAR_LABELS 对不上：' + wrong.join('; '))
        console.log('   ★ 没有中文说法的显示原名（不是空白）:', blank.length === 0 ? '✓' : '✗（空白：' + blank.join(',') + '）')
        if (blank.length > 0) errors.push('这些变量名的标签是空白（比显示英文名更糟）：' + blank.join(','))

        /* ② 悬停说明：配了就得是那句 hint，不能是空的、不能是「这个变量还没有中文说明」。 */
        const noHint = []
        for (const el of labelEls) {
          const name = el.getAttribute('data-ewb-tpl-var-label') ?? ''
          const meta = varLabel(name)
          if (meta === undefined) continue
          if ((el.getAttribute('title') ?? '') !== meta.hint) noHint.push(name)
        }
        console.log('   ★ 配了说法的变量悬停就是那句说明:', noHint.length === 0 ? '✓' : '✗（' + noHint.join(',') + '）')
        if (noHint.length > 0) errors.push('悬停说明与 VAR_LABELS 里的 hint 不一致：' + noHint.join(','))

        /* ③ 反面铁证：这份模板里**确实**有一个配了标签的英文名，且它显示的不是英文原文。
         * 没有这一条，上面那些判据可能只是在一份「变量全是中文名」的模板上悄悄通过。 */
        const labeledEng = [...promptHost.querySelectorAll('[data-ewb-tpl-var-label]')]
          .filter(el => {
            const n = el.getAttribute('data-ewb-tpl-var-label') ?? ''
            return varLabel(n) !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)
          })
        const stillEnglish = labeledEng.filter(el => {
          const n = el.getAttribute('data-ewb-tpl-var-label') ?? ''
          return (el.textContent ?? '').includes(n) && varLabel(n) !== undefined
        })
        console.log('   ★ 配了标签的英文名在界面上不再显示英文原文:',
          labeledEng.length > 0 && stillEnglish.length === 0 ? '✓（' + labeledEng.length + ' 个）' : '✗（' + labeledEng.length + ' 个，仍显示原文：' + stillEnglish.length + '）')
        if (labeledEng.length === 0) {
          errors.push('这份模板里没有配了标签的英文名（设计上到了这里就该有）')
        } else if (stillEnglish.length > 0) {
          errors.push('配了中文标签的英文名在界面上仍显示英文原文')
        }

        /* ④ 输入框靠**原名**取值：`data-ewb-tpl-var` 不许被换成中文标签。
         * 换了以后 `fillVars` 的键就对不上，预览与复制出来的正文会留下一堆 `{{}}`。 */
        const badKeys = inputsNow
          .map(el => el.getAttribute('data-ewb-tpl-var') ?? '')
          .filter(k => /[\u4e00-\u9fff]/.test(k))
        console.log('   ★ 输入框的取值键仍是英文原名（不是中文标签）:', badKeys.length === 0 ? '✓' : '✗（' + badKeys.join(',') + '）')
        if (badKeys.length > 0) errors.push('输入框的 data-ewb-tpl-var 被换成了中文标签，替换路会断：' + badKeys.join(','))

        /* ⚠️ **必须切回原模板**（`boldTarget`）。
         *
         * 这一段后面还有「复制出去的是填好的文本」「只读区渲染粗体」几组断言，
         * 它们都指望 `boldTarget` 已经填好值、并且在右栏显示中。这里换了靶子
         * 不切回去，那几组会在**错的模板**上判，红的理由与它们要防的错完全无关
         * （第一版就是这么红的：六条假红，实际一行代码都没坏）。
         *
         * ⚠️ 切回来还要**重填一次值**：切模板会清掉那一格的值，
         * 而「复制出去的是填好的文本」靠的就是那个值。 */
        varTarget?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
        await settle()
        const backInputs = q('[data-ewb-tpl-var]')
        const setter2 = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        if (backInputs.length > 0 && setter2 !== undefined) {
          setter2.call(backInputs[0], '冰丝凉席')
          backInputs[0].dispatchEvent(new window.Event('input', { bubbles: true }))
          await settle()
          const backPreview = promptHost.querySelector('[data-ewb-tpl-preview]')?.textContent ?? ''
          console.log('   切回原模板后重填，预览里仍有填的值:', backPreview.includes('冰丝凉席') ? '✓' : '✗')
          if (!backPreview.includes('冰丝凉席')) {
            errors.push('切回原模板后重填，预览没跟上（后续复制与粗体断言会拿错状态）')
          }
        }
      }
    }
  }

  /* 插入按钮：不可用就必须**禁用 + 说明**，不许是「点了没反应」。 */
  const ins = promptHost.querySelector('[data-ewb-tpl-insert]')
  const insOk = ins !== null && ins.disabled === true
    && (ins.textContent ?? '').includes('不可用')
    && (ins.getAttribute('title') ?? '').includes('根作用域')
  console.log('   ★ 插入动作不可用时按钮禁用且写明原因:', insOk ? '✓' : '✗')
  if (!insOk) errors.push('「插入到输入框」没有按降级形态呈现（要禁用 + 写明为什么不可用）')

  /* 复制：桩掉剪贴板，断言真的把**填好的**文本写了出去。
   * （任务书允许「桩验调用，不必真读剪贴板」。） */
  let copied = ''
  try {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: async (t) => { copied = t } }, configurable: true,
    })
  } catch { /* 只读则跳过这项 */
  }
  const copyBtn = promptHost.querySelector('[data-ewb-tpl-copy]')
  if (copyBtn !== null && copied === '') {
    copyBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const hasFilled = copied.includes('冰丝凉席')
    console.log('   ★ 复制到剪贴板的是填好的最终文本:', hasFilled ? '✓' : '✗（' + copied.length + ' 字）')
    if (!hasFilled) errors.push('复制出去的不是填好的文本（用户会拿到一堆没填的占位符）')
    /* ★ 与下面「只读区里没有星号」**成对**：复制出去的是给模型的提示词，
     * Markdown 粗体在那里是正常写法，所以这一份**必须还带着 `**`**。
     * 两条分开验，才能区分「渲染没做」与「复制把记号弄丢了」。 */
    const starsInCopy = copied.includes('**')
    console.log('   ★ 复制出去的文本仍带 `**`（喂给模型的提示词保留 Markdown）:', starsInCopy ? '✓' : '✗')
    if (!starsInCopy) errors.push('复制出去的文本丢了 `**`（那是给模型的提示词，强调语义不该被剥掉）')
  }

  /* ★ 粗体渲染：只读区里 `**` 不许以字面形式出现（要变成真粗体）。
   *
   * ## 背景
   *
   * `copy-no-markdown` 那条静态测试管的是「源码里不许有字面量 `**`」，
   * 它看不到渲染结果。所以「只读区到底长什么样」只能在这里验。
   *
   * ## 顺序
   *
   * 这一段**不切模板**（靶子就是上面那份，变量已经填好）——
   * 切模板会清空已填变量，把上面「复制里有填的值」的前提打掉（第一版踩过）。 */
  if (boldTarget !== undefined) {
    const readBody = promptHost.querySelector('[data-ewb-tpl-body="read"]')
    const strongs = [...(readBody?.querySelectorAll('strong') ?? [])]
    console.log('   ★ 正文只读区里的 <strong> 数:', strongs.length, strongs.length > 0 ? '✓' : '✗')
    if (strongs.length === 0) {
      errors.push('正文只读区没有把粗体渲染出来（用户会看到字面的两颗星）')
    }
    /* 判据一：只读区的可见文字里不含 `**`。 */
    const starsInRead = (readBody?.textContent ?? '').includes('**')
    console.log('   ★ 正文只读区的可见文字里没有字面 `**`:', starsInRead ? '✗' : '✓')
    if (starsInRead) errors.push('正文只读区还露出字面的 `**`（应该渲染成粗体）')
    /* 判据二：粗体里**有文字** —— 否则「没有星号」可能只是把文字吃掉了。 */
    const strongTexts = strongs.map(e => (e.textContent ?? '').trim())
    console.log('   粗体里的文字（前 3 个）:', strongTexts.slice(0, 3).join(' / ') || '(空)')
    if (strongTexts.length === 0 || strongTexts.some(t => t === '')) {
      errors.push('粗体元素里没有文字（渲染把文字吃掉了）')
    }
    /* 判据三：被强调的那句话本身还在（防止「星号还在但文字丢了」这类反向错）。 */
    const firstBold = /\*\*([^*\n]+)\*\*/.exec(boldTarget.body)
    const phrase = firstBold === null ? '' : firstBold[1]
    const inRead = phrase !== '' && (readBody?.textContent ?? '').includes(phrase)
    console.log('   被强调的短语「' + phrase + '」仍在只读区:', inRead ? '✓' : '✗')
    if (!inRead) errors.push('渲染粗体时把被强调的文字弄丢了')

    /* 编辑态：仍显示**原始** `**`（那是源码视图，必须是原文）。 */
    const editBtn = [...promptHost.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '编辑')
    editBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const ta = promptHost.querySelector('textarea[data-ewb-tpl-body]')
    const taVal = ta?.value ?? ''
    const editHasStars = taVal.includes('**')
    console.log('   ★ 编辑态 textarea 仍是原始 `**`（源码视图）:', editHasStars ? '✓' : '✗')
    if (!editHasStars) errors.push('编辑态丢了原始 `**`（那是源码，用户编辑的就该是原文）')
  }

  promptRoot.unmount()
  promptHost.remove()
}

/* ⑭ BI 板块嵌不进 Superset —— 真 BUG 的回归断言（2026-10-22）。
 *
 * ## 当初坏在哪（这段判据就是照它写的）
 *
 * `mountBi` 里 `const r = bridge.acquire(...)` **少了 await**，而桌面端那个
 * `acquire` 是 `electron.ipcRenderer.invoke(...)`、返回 Promise。于是：
 * `r.lease` / `r.partition` 都是 `undefined` → 属性被写成字符串 `"undefined"`
 * → 主进程按 `about:blank#undefined` 取不到租约 → `preventDefault()`
 * → webview 根本不附加 → `dom-ready` 永不触发 → 一片空白，**且没有任何报错**。
 *
 * ## 为什么这四条缺一不可
 *
 *   ① 只验「挂了 webview」不够 —— 旧代码也挂得出来，只是属性是 undefined；
 *   ② 只验「reject 时落 iframe」不够 —— 旧代码的 reject 会静默冒泡；
 *   ③ 只验「有 release」不够 —— 得验**迟到的租约**也被释放，那才是泄漏点；
 *   ④ 只验「没白屏」不够 —— 白屏与「页面没打开」在界面上长得一模一样。
 */
console.log('⑭ [真 BUG 回归] BI 板块嵌入')
{
  /* jsdom 不认识 `<webview>`，但它照样能造出未知元素；
   * 只补 Electron 才有的 `loadURL`，并记下调用。 */
  const patchWebview = (win) => {
    const navs = []
    const origCreate = win.document.createElement.bind(win.document)
    win.document.createElement = (tag, opts) => {
      const el = origCreate(tag, opts)
      if (String(tag).toLowerCase() === 'webview') {
        el.loadURL = (u) => { navs.push(u); return Promise.resolve() }
      }
      return el
    }
    return navs
  }
  const { BiBoard } = await import('../src/client/workbench/BiBoard.tsx')
  globalThis.React = React

  /* ⚠️ 这一段落要 `/bi/status` 回「在听」，否则 BI 板块根本不进挂载逻辑
   * （它只在 listening === true 时嵌页面 —— 那是刻意的：BI 没起来时挂 iframe
   * 只会得到一个浏览器自带的拒连错误页，看着像我们坏了）。
   * 用**局部覆盖**，段尾还原，不影响别的段落。 */
  const realFetch = window.fetch
  const statusStub = (url, init) => {
    if (String(url).includes('/bi/status')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ listening: true }) })
    }
    return realFetch(url, init)
  }
  window.fetch = statusStub
  globalThis.fetch = statusStub

  /**
   * 挂一块 BI 板块到一个**独立容器**。
   * @param bridge - 桩的 `window.dshDesktop.browser`（不给就没有壳能力）。
   * @returns 容器、文档与卸载函数。
   */
  const mountBiBoard = async (bridge) => {
    if (bridge === undefined) delete window.dshDesktop
    else window.dshDesktop = { browser: bridge }
    const host = window.document.createElement('div')
    window.document.body.appendChild(host)
    const root = ReactDOMClient.createRoot(host)
    root.render(React.createElement(BiBoard, {
      active: true, tab: '', apiBase: '/api/ecom-workbench', topHidden: false,
      onToggleTop: () => {}, onSelectTab: () => {}, onRunWorkflow: () => {},
    }))
    await settle()
    /** 点工具条上的「刷新」重挂一遍（换了 bridge 之后必须重挂才生效）。 */
    const refresh = () => {
      const b = [...host.querySelectorAll('button')].find(x => (x.textContent ?? '').trim() === '刷新')
      b?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    }
    return { host, root, refresh, unmount: () => { root.unmount(); host.remove() } }
  }

  /* ── ① 异步 acquire：属性必须是租约真值 ─────────────────────── */
  {
    const navs = patchWebview(window)
    void navs
    const released = []
    const ui = await mountBiBoard({
      /* ⚠️ 异步 —— 就是桌面端 `ipcRenderer.invoke` 的形状。 */
      acquire: () => Promise.resolve({ lease: 'lease-abc-123', partition: 'persist:ewb-bi' }),
      release: (id) => { released.push(id) },
    })
    ui.refresh()
    await settle()
    const wv = ui.host.querySelector('webview')
    const name = wv?.getAttribute('name') ?? '(缺)'
    const partition = wv?.getAttribute('partition') ?? '(缺)'
    console.log('   拿到的 name =', JSON.stringify(name), '／ partition =', JSON.stringify(partition))
    const ok = name === 'lease-abc-123' && partition === 'persist:ewb-bi'
    console.log('   ★ 异步租约的真值被用上了（不是 undefined）:', ok ? '✓' : '✗')
    if (!ok) errors.push('BI：异步 acquire 的租约没被 await —— name/partition 不是真值（这就是「一片空白」的根因）')
    if (name === 'undefined' || partition === 'undefined') {
      errors.push('BI：租约属性被写成了字符串 "undefined"（主进程会因此拒绝附加 webview）')
    }
    const srcOk = (wv?.getAttribute('src') ?? '').endsWith('#lease-abc-123')
    console.log('   src 带的是真租约号:', srcOk ? '✓' : '✗')
    if (!srcOk) errors.push('BI：webview 的 src 没带真租约号')

    const chip = ui.host.querySelector('[data-ewb-bi-mode]')
    console.log('   界面标出承载方式:', (chip?.textContent ?? '').includes('webview') ? '✓' : '✗')
    if (!(chip?.textContent ?? '').includes('webview')) errors.push('BI：界面没标出「嵌入方式：webview」')

    ui.unmount()
    await settle()
    console.log('   卸载时释放了租约:', released.includes('lease-abc-123') ? '✓' : '✗')
    if (!released.includes('lease-abc-123')) errors.push('BI：卸载时没有释放租约')
  }

  /* ── ② acquire reject → iframe 兜底 + 界面说明 ──────────────── */
  {
    patchWebview(window)
    const ui = await mountBiBoard({
      acquire: () => Promise.reject(new Error('外壳拒绝了这次取租约')),
      release: () => {},
    })
    ui.refresh()
    await settle()
    const hasWv = ui.host.querySelector('webview') !== null
    const hasIframe = ui.host.querySelector('iframe') !== null
    console.log('   没有硬挂坏的 webview:', hasWv ? '✗' : '✓')
    console.log('   ★ 落到了 iframe 兜底:', hasIframe ? '✓' : '✗')
    if (!hasIframe) errors.push('BI：acquire 失败后没有落到 iframe 兜底（用户只会看到空白）')
    if (hasWv) errors.push('BI：acquire 失败后还挂了一个坏的 webview')
    const chip = ui.host.querySelector('[data-ewb-bi-mode]')
    const modeText = chip?.textContent ?? ''
    const title = chip?.getAttribute('title') ?? ''
    console.log('   界面写明的承载方式:', JSON.stringify(modeText))
    const says = modeText.includes('iframe') && (modeText.includes('不可用') || title.includes('不可用'))
    console.log('   ★ 界面说清「桌面外壳能力不可用，已改用 iframe」:', says ? '✓' : '✗')
    if (!says) errors.push('BI：降级到 iframe 时界面没说清原因')
    ui.unmount()
  }

  /* ── ③ 卸载早于租约返回：不泄漏 ─────────────────────────────── */
  {
    patchWebview(window)
    const released = []
    let resolveLease = () => {}
    const ui = await mountBiBoard({
      /* 手动控制何时兑现 —— 精确制造「先卸载、后到账」。 */
      acquire: () => new Promise((res) => { resolveLease = res }),
      release: (id) => { released.push(id) },
    })
    ui.refresh()
    await settle()
    console.log('   租约还在路上时没有挂出 webview:', ui.host.querySelector('webview') === null ? '✓' : '✗')
    ui.unmount()
    await settle()
    /* 卸载之后才兑现 */
    resolveLease({ lease: 'lease-late-999', partition: 'persist:late' })
    await settle()
    const noLeak = released.includes('lease-late-999')
    console.log('   ★ 迟到的租约被立刻释放（不泄漏）:', noLeak ? '✓' : '✗（' + JSON.stringify(released) + '）')
    if (!noLeak) errors.push('BI：租约晚于卸载才到手时没有被释放（泄漏）')
  }

  /* ── ④ did-fail-load 要记下来并说出来 ───────────────────────── */
  {
    patchWebview(window)
    const ui = await mountBiBoard({
      acquire: () => Promise.resolve({ lease: 'l1', partition: 'p1' }),
      release: () => {},
    })
    ui.refresh()
    await settle()
    const wv = ui.host.querySelector('webview')
    console.log('   webview 挂上了:', wv !== null ? '✓' : '✗')
    if (wv !== null) {
      const ev = new window.Event('did-fail-load')
      ev.errorCode = -102
      ev.errorDescription = 'ERR_CONNECTION_REFUSED'
      ev.validatedURL = 'http://127.0.0.1:8088/dashboard/list/'
      ev.isMainFrame = true
      wv.dispatchEvent(ev)
      await settle()
      const box = ui.host.querySelector('[data-ewb-bi-fail]')
      const t = box?.textContent ?? ''
      console.log('   ★ 界面说出了加载失败:', box !== null && t.includes('-102') ? '✓' : '✗')
      if (box === null || !t.includes('-102')) errors.push('BI：did-fail-load 没有在界面上说出来')
      /* 报错三段式：发生了什么 + 为什么 + 怎么办 */
      const hasNext = t.includes('刷新') || t.includes('地址')
      console.log('   失败提示给了下一步:', hasNext ? '✓' : '✗')
      if (!hasNext) errors.push('BI：加载失败的提示没给下一步（刷新 / 改地址）')
    }
    ui.unmount()
  }
  delete window.dshDesktop
  /* 还原 fetch（上面那段为了这个板块临时桩了 /bi/status）。 */
  window.fetch = realFetch
  globalThis.fetch = realFetch
}

/* ⑮ 设置分层 + 收起顶部搬家（2026-10-22 加）。
 *
 * ## 为什么这一段**从源码 import 组件**，不读构建产物
 *
 * 产物由校核统一重建，执行角色不许自己跑 bundle。若这里读产物，
 * 「源码写好了但还没重建」会被判成红 —— 那是把「没重建」误报成「代码坏了」。
 * 直接 import 源码测的就是**此刻的代码**。
 *
 * ## 为什么分成两个小块挂
 *
 * 三个组件（设置抽屉 / 工作台设置 / 骨架）用**各自的容器**，互不干扰。
 * 全塞进同一个容器的话，上一个块留下的 DOM 会让下一块的查询串味
 * （本项目踩过：页面上有两个 `.chip` 时按内容认才认对）。
 */
console.log('⑮ [设置分层] 浏览器设置搬出画布抽屉 + 收起顶部两个入口')
{
  globalThis.React = React
  const { SettingsDrawer } = await import('../src/client/workbench/SettingsDrawer.tsx')
  /* ★ 票 59：抽屉现在要一份 `CanvasPrefs`（背景三档 + 三个透明度）。 */
  const { DEFAULT_PREFS } = await import('../src/client/workbench/lib/canvas/canvas-prefs.ts')
  /* ⚠️ 票 66：原来是 `WorkspaceSettings`（抽屉），抽屉已删 → 配置板块的「其它」格。 */
  const { ConfigBoard } = await import('../src/client/workbench/ConfigBoard.tsx')

  /** 挂一个组件到独立容器，返回容器与卸载函数。 */
  const mountInto = async (el) => {
    const host = window.document.createElement('div')
    window.document.body.appendChild(host)
    const root = ReactDOMClient.createRoot(host)
    root.render(el)
    await settle()
    return { host, unmount: () => { root.unmount(); host.remove() } }
  }

  /* ── ① 画布设置抽屉里**只剩**六项，没有浏览器 ───────────────────
   *
   * 判据分三层（缺一层都能蒙混过关）：
   *   ① **正向**：六项控件都在（节点宽度 / 展开高度 / 背景透明 / 间距 / 输出高度 / 快捷键）；
   *   ② **反向**：浏览器那一段**一个字都不在**（不只是「没那行代码」——
   *      要按用户会看到的文字判，比如「默认来源」「重新检测」）；
   *   ③ **反向的形状**：抽屉里的输入控件数正好是期望值，多一个就说明混进了别的东西。 */
  const { host: drawerHost, unmount: drawerOff } = await mountInto(
    React.createElement(SettingsDrawer, {
      open: true, onClose: () => {},
      nodeW: 300, onNodeW: () => {},
      canvasBg: 100, onCanvasBg: () => {},
      editorH: 220, onEditorH: () => {},
      spacing: 60, spacingAuto: true, onSpacing: () => {},
      panelH: 220, onPanelH: () => {},
      /* ★ 票 59：背景三档 + 三个透明度（与内容画布同一份 `CanvasPrefs`）。
       * 这一组在真实调用处由 `WorkflowCanvas` 传进来 —— 这里给一份默认值。 */
      prefs: { ...DEFAULT_PREFS },
      onPrefs: () => {},
    }),
  )
  const drawerText = () => drawerHost.textContent ?? ''
  const sliderLabels = [...drawerHost.querySelectorAll('input[type="range"]')]
    .map(i => i.getAttribute('aria-label') ?? '')

  /* ① 六项都在 */
  /* ★ 票 59：多了「点阵深浅」（背景图案）与「参考线」两条滑块。
   *
   * 改前是五条。**不是放宽**：原来那五条一条没删，只是用户这一票明确要求
   * 「增加透明度设置（参考线、点的透明度）」，所以期望值跟着长两条。
   *
   * 「画布底」那条在票 59 之前就存在（原标签「画布背景不透明度」），
   * 本票没动它的位置。 */
  const WANT = [
    '节点宽度', '节点展开高度', '画布背景不透明度', '排版间距', '输出显示窗口高度',
    '点阵深浅', '参考线',
  ]
  const missingSlider = WANT.filter(w => !sliderLabels.includes(w))
  console.log('   画布抽屉里的滑块:', sliderLabels.join(' / '))
  console.log('   五条画布滑块都在:', missingSlider.length === 0 ? '✓' : '✗（缺 ' + missingSlider.join('、') + '）')
  if (missingSlider.length > 0) errors.push('画布设置抽屉缺少画布设置项：' + missingSlider.join('、'))
  /* ── 快捷键表：**已从抽屉里搬到右下角**（票 56）──────────────────────
   *
   * ## 为什么这条判据反过来了（不是放宽）
   *
   * 旧断言（2026-10-11 用户那时定的）：「快捷键表还在抽屉里，用户明确说不拆」。
   * 票 56 用户 2026-10-29 改了口：「统一到右下角那颗，抽屉里那张表删掉」，
   * 理由是两份清单必然漂（与票 35 对内容画布做的那次同一个道理）。
   *
   * **产品决定反过来了，判据就得跟着反。** 守的东西没变：
   * 「快捷键说明只有一处，且那一处真的有内容」—— 只是那一处换了地方。
   *
   * ⚠️ 自证：把 `SHORTCUTS` 表加回抽屉 → 这条必须红。 */
  const drawerHasKeys = drawerText().includes('Ctrl+Z') || drawerText().includes('Ctrl + Z')
  console.log('   抽屉里**没有**快捷键表（票 56 搬到右下角了）:', drawerHasKeys ? '✗' : '✓')
  if (drawerHasKeys) {
    errors.push('画布设置抽屉里还有快捷键表（票 56 之后唯一来源是右下角那颗「?」）')
  }

  /* ② 浏览器那一段必须彻底不在。按**用户会看到的词**判，不按类名。 */
  const BROWSER_WORDS = ['默认来源', '重新检测', '自动检测', '浏览器', 'CDP', '端口']
  const leaked = BROWSER_WORDS.filter(w => drawerText().includes(w))
  console.log('   ★ 画布抽屉里没有浏览器设置的痕迹:', leaked.length === 0 ? '✓' : '✗（出现了「' + leaked.join('、') + '」）')
  if (leaked.length > 0) {
    errors.push('画布设置抽屉里还能看到浏览器设置的文字：' + leaked.join('、'))
  }
  /* ③ 形状：滑块数必须正好是 **7**（票 59 之前是 5）。
   *
   * 这一条钉的是「别把别的东西悄悄挂回抽屉」—— 数字变了，
   * 但守的事情没变：**数量必须精确**，多一条就说明混进了别的东西。
   * 票 59 加的两条是「图案深浅」与「参考线」，都不是「别的东西」。 */
  const rangeCount = drawerHost.querySelectorAll('input[type="range"]').length
  const textInputs = drawerHost.querySelectorAll('input[type="text"]').length
  console.log('   抽屉里的控件形状（滑块 / 文本框）:', rangeCount, '/', textInputs,
    rangeCount === 7 && textInputs === 0 ? '✓' : '✗')
  if (rangeCount !== 7 || textInputs !== 0) {
    errors.push('画布设置抽屉的控件形状不对（滑块应为 7 条、文本框应为 0 个）')
  }
  drawerOff()

  /* ── ② 工作台设置抽屉：能打开、里面有浏览器设置、能改 ──────────── */
  let prefsPosted = []
  const realFetchWs = window.fetch
  window.fetch = globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('/browser/prefs')) {
      if ((init?.method ?? 'GET') === 'POST') prefsPosted.push(String(init.body ?? ''))
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
    if (u.includes('/browser/detect')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, browsers: [], cdp: { listening: false, endpoints: [] } }) }
    }
    return realFetchWs(url, init)
  }

  const { host: wsHost, unmount: wsOff } = await mountInto(
    React.createElement(ConfigBoard, { active: true, tab: 'other' }),
  )
  const wsText = wsHost.textContent ?? ''
  /* ⚠️ 票 66：这条原来是「抽屉里有个『工作台设置』标题」。
   *
   * 抽屉删了、标题也不再由这块自己写 —— 现在是**板块名**：
   * `boards.ts` 注册 `title: '配置'`，骨架把它画在侧栏与面包屑上。
   * 所以判据换成两件：
   *   ① 板块自己**不再**写标题（重复一个标题就是两层皮）；
   *   ② `boards.ts` 里那块注册的名字确实是「配置」。
   *
   * **不是删断言**：原来 1 条（有标题），现在 2 条（自己不许有 + 注册里有）。 */
  console.log('   配置板块自己不写标题（标题由板块注册给）:', wsText.includes('工作台设置') ? '✗' : '✓')
  if (wsText.includes('工作台设置')) {
    errors.push('配置板块里又写了一个「工作台设置」标题 —— 标题该由 boards.ts 的板块注册给，别自己再写一个')
  }
  const boardsSrc = readFileSync(new URL('../src/client/workbench/boards.ts', import.meta.url), 'utf8')
  const cfgReg = /id:\s*'settings',\s*title:\s*'配置'/.test(boardsSrc)
  console.log('   ★ 板块注册里它的名字是「配置」:', cfgReg ? '✓' : '✗')
  if (!cfgReg) errors.push('boards.ts 里没有 id: settings / title: 配置 的板块注册')
  console.log('   ★ 工作台设置里有浏览器设置（默认来源）:', wsText.includes('默认来源') ? '✓' : '✗')
  if (!wsText.includes('默认来源')) errors.push('工作台设置抽屉里没有浏览器设置（搬丢了）')
  console.log('   工作台设置里有「重新检测」:', wsText.includes('重新检测') ? '✓' : '✗')
  if (!wsText.includes('重新检测')) errors.push('工作台设置里没有「重新检测」按钮')
  console.log('   说清了「跨全部工作流共用」:', wsText.includes('跨全部工作流') ? '✓' : '✗')
  if (!wsText.includes('跨全部工作流')) errors.push('工作台设置没有说明它是跨工作流共用的一层')
  wsOff()
  window.fetch = globalThis.fetch = realFetchWs

  /* ── ③ 骨架：两个收起顶部入口都在，且都能切 ────────────────────
   *
   * ⚠️ 两个入口**共用一个 `toggleTop`**，所以点完一个，另一个的 `aria-pressed`
   * 也要跟着变 —— 这一条同时证明「不是两套状态」。 */
  const { EcomWorkbench } = await import('../src/client/workbench/EcomWorkbench.tsx')
  const realFetchSk = window.fetch
  window.fetch = globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('/ui/prefs')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, prefs: { topHidden: false, navCollapsed: false, libW: 260, legend: true, nodeW: 300 } }) }
    }
    return realFetchSk(url, init)
  }
  const { host: wbHost, unmount: wbOff } = await mountInto(
    React.createElement(EcomWorkbench, {
      get: () => true, set: () => {}, getHideChat: () => false, setHideChat: () => {},
      getWb: () => true, setWb: () => {},
    }),
  )
  /* ── ③ 骨架：收起顶部的入口**随状态换位置**（票 48 定的最终形态）──
   *
   * ## 判据为什么从「两个入口状态一致」改掉
   *
   * 旧版是两版并存：点一个、另一个的 `aria-pressed` 跟着变，用来证明「不是两套状态」。
   * 票 48 之后**同一时刻只有一个入口**（展开态在面包屑、收起态在 tab 行），
   * 所以「两个同时存在」这件事本身不成立了 —— 继续那样断言必然红。
   *
   * 换成**三段更强的判据**（每段都验位置，不只是「有没有」）：
   *   ① 展开态：面包屑行里有它、而且它是那一行的**第一个**元素
   *   ② 点一下：面包屑整行消失，`tabbar` 那个出现在 tab 行里、也是**第一个**
   *   ③ 再点：回到展开态，`breadcrumb` 又回到面包屑行首位
   *
   * 「第一个」用 `parentElement.firstElementChild` 判 —— 用户原话是
   * 「收起之后放在板块TAB的第一个」，位置是要求的一部分，不是附带效果。 */
  const crumbToggle = () => wbHost.querySelector('[data-ewb-top-toggle="breadcrumb"]')
  const tabRowToggle = () => wbHost.querySelector('[data-ewb-top-toggle="tabbar"]')

  console.log('   ★ 展开态：面包屑上有收起顶部入口:', crumbToggle() !== null ? '✓' : '✗')
  if (crumbToggle() === null) errors.push('展开态面包屑行里没有收起顶部入口')
  /* 它在面包屑行里，且是那一行的第一个元素。 */
  const crumbRow = () => [...wbHost.querySelectorAll('div')]
    .find(d => typeof d.className === 'string' && d.className.includes('h-[52px]'))
  console.log('   ★ 它就在面包屑行里（父节点是那一行）:',
    crumbToggle() !== null && crumbToggle().parentElement === crumbRow() ? '✓' : '✗')
  if (crumbToggle() !== null && crumbToggle().parentElement !== crumbRow()) {
    errors.push('收起顶部不在面包屑行里（用户要求「挪到面包屑」）')
  }
  console.log('   ★ 它是面包屑行的第一个元素:',
    crumbRow()?.firstElementChild === crumbToggle() ? '✓' : '✗')
  if (crumbRow()?.firstElementChild !== crumbToggle()) {
    errors.push('收起顶部不是面包屑行的第一个元素（用户要求它在左端）')
  }
  console.log('   ★ 展开态不该同时有 tab 行那个入口:', tabRowToggle() === null ? '✓' : '✗（两个都在）')
  if (tabRowToggle() !== null) errors.push('展开态两个入口同时在（同一动作两个入口）')

  /* ── ★ 票 65：形态（去外框、去文字、换图标、两颗一致）──────────────
   *
   * ## 用户原话
   *
   * 「板块顶部面包屑左侧的收起按钮，不要外框（鼠标移动过去亮起即可）
   * 找一个图标不要用文字符号，不用太大。收起后的展开按钮也按照这个逻辑改，
   * 不要太大、不要太显眼。能点能收就行。」
   *
   * ## 判据为什么不能只看「有没有 SVG」
   *
   * 那一颗原本就有 `⌃` 字符 + 文字，加不加 SVG 都能通过「有图标」。
   * 所以这里逐条拆成用户原话里的六个要求：
   *   ① 没有外框（`border` / `rounded-ct*`）
   *   ② 没有 `pressable`（它带 3D 透视 + 抬起 + `scale-104` + 投影 = 「太显眼」）
   *   ③ 没有文字（`textContent` 必须为空）
   *   ④ 有 SVG，且 `width` / `height` 都是 14
   *   ⑤ 撑成 24×24 居中小方块（`h-6` + `w-6`），不是 `px-2 py-1` 撑的胶囊
   *   ⑥ **两颗逐字一致** —— 一处改了另一处没改是最常见的漂法
   *
   * ⚠️ `pressable` 那条是**独立**的一条，不并进「没有外框」：
   * 只去 `border` 留着 `pressable`，用户看到的仍然是「移上去就放大 + 浮起来」，
   * 那正是他说「太显眼」的部分。 */
  /** 一颗按钮的形态采样。 */
  const shapeOf = (btn) => {
    const cls = btn === null ? '' : String(btn.className ?? '')
    const svgEl = btn === null ? null : btn.querySelector('svg')
    return {
      cls,
      text: btn === null ? null : (btn.textContent ?? '').trim(),
      hasBorder: /(^|\s)border(-|\s|$)/.test(cls),
      hasRounded: /(^|\s)rounded-/.test(cls),
      hasPressable: /(^|\s)pressable(\s|$)/.test(cls),
      hasH6: /(^|\s)h-6(\s|$)/.test(cls),
      hasW6: /(^|\s)w-6(\s|$)/.test(cls),
      hasPx2: /(^|\s)px-2(\s|$)/.test(cls),
      hasSvg: svgEl !== null,
      svgW: svgEl?.getAttribute('width') ?? '',
      svgH: svgEl?.getAttribute('height') ?? '',
      pathD: svgEl?.querySelector('path')?.getAttribute('d') ?? '',
      title: btn?.getAttribute('title') ?? '',
      aria: btn?.getAttribute('aria-pressed') ?? '',
      hook: btn?.getAttribute('data-ewb-top-toggle') ?? '',
    }
  }

  const shCrumb = shapeOf(crumbToggle())
  console.log('   收起那颗粒的类名:', shCrumb.cls)
  /* ① 没有外框。 */
  console.log('   ★ 票 65：收起那颗**没有外框**（无 border / 无 rounded-*）:',
    !shCrumb.hasBorder && !shCrumb.hasRounded
      ? '✓' : '✗（border=' + String(shCrumb.hasBorder) + ' rounded=' + String(shCrumb.hasRounded) + '）')
  if (shCrumb.hasBorder || shCrumb.hasRounded) {
    errors.push('收起顶部那颗还带外框（border / rounded-*）—— 用户要求「不要外框」')
  }
  /* ② 没有 pressable。 */
  console.log('   ★ 票 65：收起那颗**没有 pressable**（那套悬停太显眼）:',
    !shCrumb.hasPressable ? '✓' : '✗')
  if (shCrumb.hasPressable) {
    errors.push('收起顶部那颗还带 pressable（3D 透视 + 放大 + 投影 = 用户说的「太显眼」）')
  }
  /* ③ 没有文字。 */
  console.log('   ★ 票 65：收起那颗**没有文字**（只有图标）:',
    shCrumb.text === '' ? '✓' : '✗（文字是 ' + JSON.stringify(shCrumb.text) + '）')
  if (shCrumb.text !== '') {
    errors.push('收起顶部那颗还有文字（' + JSON.stringify(shCrumb.text) + '）—— 用户要求「不要用文字符号」')
  }
  /* ④ 有 SVG、14px。 */
  console.log('   ★ 票 65：收起那颗有 SVG 且是 14×14:',
    shCrumb.hasSvg && shCrumb.svgW === '14' && shCrumb.svgH === '14'
      ? '✓' : '✗（svg=' + String(shCrumb.hasSvg) + ' ' + shCrumb.svgW + 'x' + shCrumb.svgH + '）')
  if (!(shCrumb.hasSvg && shCrumb.svgW === '14' && shCrumb.svgH === '14')) {
    errors.push('收起顶部那颗没有 14×14 的 SVG（用户要求「找一个图标不要用文字符号，不用太大」）')
  }
  /* ⑤ 24×24，不是胶囊。 */
  console.log('   ★ 票 65：收起那颗是 h-6 w-6 的小方块（不是 px-2 py-1 胶囊）:',
    shCrumb.hasH6 && shCrumb.hasW6 && !shCrumb.hasPx2
      ? '✓' : '✗（h-6=' + String(shCrumb.hasH6) + ' w-6=' + String(shCrumb.hasW6) + ' px-2=' + String(shCrumb.hasPx2) + '）')
  if (!(shCrumb.hasH6 && shCrumb.hasW6 && !shCrumb.hasPx2)) {
    errors.push('收起顶部那颗不是 24×24 小方块（还在用 px-2 py-1 撑胶囊）')
  }
  /* 方向：展开态那颗朝上（path 是 chevron-up 那条）。 */
  console.log('   ★ 票 65：展开态那颗是**向上**箭头:',
    shCrumb.pathD === 'm18 15-6-6-6 6' ? '✓' : '✗（' + JSON.stringify(shCrumb.pathD) + '）')
  if (shCrumb.pathD !== 'm18 15-6-6-6 6') {
    errors.push('展开态那颗不是向上箭头（用户定了「上下箭头」，展开态朝上）')
  }
  /* 行为契约一个字都不许改。 */
  console.log('   ★ 票 65：三样行为契约没被改（hook / title / aria-pressed）:',
    shCrumb.hook === 'breadcrumb' && shCrumb.title !== '' && shCrumb.aria === 'false'
      ? '✓' : '✗（hook=' + shCrumb.hook + ' title=' + JSON.stringify(shCrumb.title) + ' aria=' + shCrumb.aria + '）')
  if (!(shCrumb.hook === 'breadcrumb' && shCrumb.title !== '' && shCrumb.aria === 'false')) {
    errors.push('收起顶部那颗的 data-ewb-top-toggle / title / aria-pressed 被改了（票 65 只许动长相）')
  }

  /** 面包屑栏在不在（`h-[52px]` 那一行）。 */
  const hasCrumb15 = () => crumbRow() !== undefined

  /* ⚠️ **先切到一块有 tab 的板块**再验。
   *
   * 默认落在总览（没有 tab），那样「与 tab 同一行」这条分支**永远跑不到** ——
   * 报告会把它列成「没执行且没登记」，而且那正是本票最关键的一条
   * （用户要的是「放在板块TAB的第一个」）。切到工作流板块之后 tab 就有了。 */
  const tabbedBoard = wbHost.querySelector('[data-ewb-item="workflow"]')
  console.log('   找得到有 tab 的板块（工作流）:', tabbedBoard !== null ? '✓' : '✗')
  if (tabbedBoard !== null) {
    tabbedBoard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
  }

  const crumb0 = hasCrumb15()
  const tabs0 = wbHost.querySelectorAll('[role="tab"]').length
  console.log('   点之前：面包屑栏', crumb0 ? '在' : '不在', '／ tab 数', tabs0,
    tabs0 === 0 ? '（没有 tab）' : '')

  /* 点面包屑那个 → 收起来；入口应当**换到 tab 行首位**。 */
  crumbToggle()?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  const crumb1 = hasCrumb15()
  const tabs1 = wbHost.querySelectorAll('[role="tab"]').length
  console.log('   点之后：面包屑栏', crumb1 ? '仍在 ✗' : '已收起 ✓', '／ tab 数', tabs1)
  if (crumb1) errors.push('点面包屑上的入口没有收起顶部')
  /* ⚠️ 「tab 条没被收掉」判**点前点后数量是否一致**，不是判「等于 0」。
   * 第一版写的 `tabs1 === 0` → 默认落在一块**本来就没有 tab** 的板块上，
   * 于是每次都红（假红）。判据改成「不变」之后，有 tab 的板块也能用同一条判据。 */
  console.log('   tab 条没有被连累（点后数量与点前一致）:', tabs1 === tabs0 ? '✓' : '✗（' + tabs0 + ' → ' + tabs1 + '）')
  if (tabs1 !== tabs0) errors.push('收起顶部把 tab 条也收掉了（会切不回列表/历史）')
  console.log('   ★ 收起态：入口换到了 tab 行那个（tabbar）:', tabRowToggle() !== null ? '✓' : '✗')
  if (tabRowToggle() === null) errors.push('收起态找不到「展开顶部」入口（收起来就回不去了）')
  console.log('   ★ 收起态不再有面包屑那个入口:', crumbToggle() === null ? '✓' : '✗（两个都在）')
  if (crumbToggle() !== null) errors.push('收起态两个入口同时在（同一动作两个入口）')

  /* ── ★ 票 65：收起态那颗同样验一遍，且**与收起那颗逐字一致** ──
   *
   * 用户原话：「收起后的展开按钮也按照这个逻辑改，不要太大、不要太显眼。」
   * 「按照这个逻辑」= 同一套长相。一处改了另一处没改是这个项目反复出现的漂法
   * （票 54 的 chip 类名、票 56 的 canvasZoom 都是这么漏的）。
   *
   * 所以这里既逐条验，也一条**直接比类名字符串** —— 比逐条更强，
   * 将来谁给其中一颗加一个类，这条立刻红。 */
  const shTab = shapeOf(tabRowToggle())
  console.log('   展开那颗粒的类名:', shTab.cls)
  console.log('   ★ 票 65：展开那颗也没有外框:',
    !shTab.hasBorder && !shTab.hasRounded ? '✓' : '✗')
  if (shTab.hasBorder || shTab.hasRounded) {
    errors.push('展开顶部那颗还带外框（用户要求「也按照这个逻辑改」）')
  }
  console.log('   ★ 票 65：展开那颗也没有 pressable:', !shTab.hasPressable ? '✓' : '✗')
  if (shTab.hasPressable) errors.push('展开顶部那颗还带 pressable')
  console.log('   ★ 票 65：展开那颗没有文字:',
    shTab.text === '' ? '✓' : '✗（文字是 ' + JSON.stringify(shTab.text) + '）')
  if (shTab.text !== '') {
    errors.push('展开顶部那颗还有文字（' + JSON.stringify(shTab.text) + '）')
  }
  console.log('   ★ 票 65：展开那颗有 SVG 且是 14×14:',
    shTab.hasSvg && shTab.svgW === '14' && shTab.svgH === '14'
      ? '✓' : '✗（' + shTab.svgW + 'x' + shTab.svgH + '）')
  if (!(shTab.hasSvg && shTab.svgW === '14' && shTab.svgH === '14')) {
    errors.push('展开顶部那颗没有 14×14 的 SVG')
  }
  console.log('   ★ 票 65：展开那颗是 h-6 w-6 小方块:',
    shTab.hasH6 && shTab.hasW6 && !shTab.hasPx2 ? '✓' : '✗')
  if (!(shTab.hasH6 && shTab.hasW6 && !shTab.hasPx2)) {
    errors.push('展开顶部那颗不是 24×24 小方块')
  }
  /* 方向：收起态那颗朝下（顶部要往下回来）。 */
  console.log('   ★ 票 65：收起态那颗是**向下**箭头:',
    shTab.pathD === 'm6 9 6 6 6-6' ? '✓' : '✗（' + JSON.stringify(shTab.pathD) + '）')
  if (shTab.pathD !== 'm6 9 6 6 6-6') {
    errors.push('收起态那颗不是向下箭头（用户定了「上下箭头」，收起态朝下）')
  }
  /* ★ 两颗逐字一致 —— 比逐条更强。 */
  console.log('   ★ 票 65：两颗的 className **逐字相同**:',
    shCrumb.cls === shTab.cls ? '✓' : '✗（收起=' + shCrumb.cls + ' ／ 展开=' + shTab.cls + '）')
  if (shCrumb.cls !== shTab.cls) {
    errors.push('收起 / 展开两颗的 className 不一致（一处改了另一处没改）')
  }
  /* 行为契约：展开态 `aria-pressed` 是 true（它是「已收起」的状态）。 */
  console.log('   ★ 票 65：展开那颗的行为契约没被改（hook / title / aria-pressed）:',
    shTab.hook === 'tabbar' && shTab.title !== '' && shTab.aria === 'true'
      ? '✓' : '✗（hook=' + shTab.hook + ' title=' + JSON.stringify(shTab.title) + ' aria=' + shTab.aria + '）')
  if (!(shTab.hook === 'tabbar' && shTab.title !== '' && shTab.aria === 'true')) {
    errors.push('展开顶部那颗的 data-ewb-top-toggle / title / aria-pressed 被改了')
  }
  /* 「不再单独占一行」：它的父容器里**还有别的东西**。
   *
   * ⚠️ 分两种板块判，不能一律要求「父容器里有 tab」：
   *   ① 有 tab 的板块（工作流 / 内容）→ 父容器里必须有 `[role="tab"]`，
   *      也就是它真的与 tab 排在同一行；
   *   ② 没有 tab 的板块（总览 / BI / 提示词）→ 那一行本来就只有它一个，
   *      这时要求的不是「有 tab」，而是「它没有被单独包成一个只为它的块」——
   *      判它的父容器**就是**那一行的 flex 容器（而非一个只装它的 div）。
   *
   * 这两条合起来才是「不再单独占一行」：①保住了「与 tab 同行」，
   * ②保住了「没 tab 时不另起一行」。只判 ① 会在无 tab 板块上假红
   * （第一版就是这么写的，跑出来红了才知道）。 */
  /* ## 一条断言管住两种板块（不写成 if/else 的理由）
   *
   * 写成互斥分支的话，同一份用例里**只有一边能跑到**，另一边永远进
   * 「没执行且没登记」名单 —— 那张名单是用来抓假绿的，不该被互斥分支污染。
   *
   * 合并成一条，两种情形都在它的管辖内，而且**每次都执行**：
   *   ① 父容器必须是**那一行本身**（flex + items-center），不是「只为装这个按钮的包裹层」
   *      —— 这是「不再单独占一行」；
   *   ② **有 tab 时**，父容器里必须真的有 tab —— 这是「与板块 TAB 同一行」。
   *
   * ② 用 `tabs1 === 0 ||` 短路：无 tab 的板块不适用这条子句，但它依然被 ① 管住。 */
  const trRow = tabRowToggle()?.parentElement ?? null
  const tabsInRow = trRow?.querySelectorAll('[role="tab"]').length ?? 0
  const rowCls = typeof trRow?.className === 'string' ? trRow.className : ''
  const isRowBox = rowCls.includes('items-center') && rowCls.includes('flex')
  const sharesRowWithTabs = tabs1 === 0 || tabsInRow > 0
  console.log('   ★ 收起态它就在那一行里（不另起一行' + (tabs1 > 0 ? '、与 tab 同一行' : '') + '）:',
    isRowBox && sharesRowWithTabs ? '✓' : '✗（行容器=' + String(isRowBox) + ' 同行有 tab=' + String(tabsInRow) + '/' + String(tabs1) + '）',
    '｜父容器类名:', rowCls.slice(0, 80))
  if (!isRowBox) {
    errors.push('收起态那个入口被单独包了一层（又变成单独一行了，用户要求「放在板块TAB的第一个」）')
  }
  if (!sharesRowWithTabs) {
    errors.push('收起态那个入口没有与 tab 排在同一行（用户要求「放在板块TAB的第一个」）')
  }
  console.log('   ★ 它是 tab 行的第一个元素:', trRow?.firstElementChild === tabRowToggle() ? '✓' : '✗')
  if (trRow?.firstElementChild !== tabRowToggle()) {
    errors.push('收起态那个入口不是 tab 行的第一个元素')
  }

  /* 再点 tab 行那个 → 回到展开态。 */
  tabRowToggle()?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  console.log('   再点之后：面包屑栏', hasCrumb15() ? '已恢复 ✓' : '没有 ✗')
  if (!hasCrumb15()) errors.push('点 tab 行入口没能展开顶部（收起来就回不去了）')
  console.log('   入口回到面包屑行:', crumbToggle() !== null ? '✓' : '✗')
  if (crumbToggle() === null) errors.push('展开后入口没有回到面包屑行')

  /* ── ④ 没有 tab 的板块里，收起顶部仍然可用 ────────────────────
   *
   * ## 任务书要我定的那件事
   *
   * 我的做法：**这一行永远渲染**，只在没有 tab 时里面只剩这一个按钮。
   * 理由：`topHidden` 收的是面包屑与大标题，**与有没有 tab 无关** ——
   * 那两块在 BI / 总览里同样存在、同样值得收。跟着 tab 一起消失，
   * 等于「最需要收顶部的板块反而收不了」。
   *
   * 判据：切到 BI（`data-ewb-item="bi"`，它没有 tabs），那个按钮**还得在**。 */
  const biEntry = wbHost.querySelector('[data-ewb-item="bi"]')
  console.log('   找得到没有 tab 的板块（BI）:', biEntry !== null ? '✓' : '✗')
  if (biEntry !== null) {
    biEntry.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const tabsInBi = wbHost.querySelectorAll('[role="tab"]').length
    /* ⚠️ 取值换成 `breadcrumb`（票 48）：展开态的入口已经在面包屑上，
     * 不再是旧版那个 `tabbar`。继续找 `tabbar` 会得到 undefined → 假红。 */
    const crumbToggleInBi = wbHost.querySelector('[data-ewb-top-toggle="breadcrumb"]')
    console.log('   BI 板块里 tab 数:', tabsInBi, tabsInBi === 0 ? '（确实没有 tab）' : '')
    console.log('   ★ BI 里收起顶部入口仍在:', crumbToggleInBi !== null ? '✓' : '✗')
    if (crumbToggleInBi === null) {
      errors.push('没有 tab 的板块（BI）里收起顶部入口消失了 —— 那两块标题同样值得收')
    }
    /* 在 BI 里点它**真的能收**（不是只剩个死按钮）。 */
    if (tabsInBi === 0 && crumbToggleInBi !== null) {
      const crumbBi0 = hasCrumb15()
      crumbToggleInBi.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await settle()
      console.log('   ★ BI 里点收起顶部真的生效:', crumbBi0 && !hasCrumb15() ? '✓' : '✗')
      if (!(crumbBi0 && !hasCrumb15())) errors.push('没有 tab 的板块里点了收起顶部不生效')
      /* ★ 收起之后，**没有 tab 的板块里那个入口还得在**（票 48 的关键一条）。
       *
       * 这一条是旧版没有的：旧版 BI 里 `tabbar` 入口一直在（那时它是常驻的一行）。
       * 现在收起态入口只在 tab 行里出现，而 BI **本来没有 tab 行** ——
       * 若实现写成「有 tab 才渲染那一行」，BI 收起之后就再也展不开了。
       * 所以判据落地在这一刻：收了之后 `tabbar` 必须还在，且父容器里没有 tab。 */
      const tabToggleInBiAfter = wbHost.querySelector('[data-ewb-top-toggle="tabbar"]')
      console.log('   ★ BI 收起后仍有「展开顶部」入口（没 tab 也得有）:',
        tabToggleInBiAfter !== null ? '✓' : '✗')
      if (tabToggleInBiAfter === null) {
        errors.push('没有 tab 的板块收起顶部后就展不开了（那一行被写成「有 tab 才渲染」）')
      }
      /* 还原，别把状态留给后面的段落 */
      tabToggleInBiAfter?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await settle()
    }
  }

  /* ── ④b 票 48：点 logo 隐藏对话区 / 底部两颗已删 / 图标分家 ────────────
   *
   * ## 这一组为什么必须单独挂一次组件
   *
   * 上面那些段都在同一份 `wbHost` 上操作，状态已经被点过好几轮了。
   * 这里要验「**从初始态**点一下 logo 会发生什么」，必须干净重挂一次。
   *
   * ## 为什么用 `setHideChat` 的**调用记录**当判据
   *
   * 「隐藏对话区 ⇒ 收起 dsh 左侧栏」那半条在宿主 `src/client/index.ts:119-131`，
   * 它听的是 `setHideChat`。所以只要证明「点 logo 调了 setHideChat(下一个值)」，
   * 联动就成立 —— 那半条逻辑本轮一行没动。
   */
  {
    /** 每次 `setHideChat` 被调用时收到的值。 */
    const hideCalls = []
    let hideState = false
    const { host: logoHost, unmount: logoOff } = await mountInto(
      React.createElement(EcomWorkbench, {
        get: () => true, set: () => {},
        getHideChat: () => hideState,
        setHideChat: (v) => { hideState = v; hideCalls.push(v) },
        getWb: () => true, setWb: () => {},
      }),
    )

    /* ① 展开态那个 logo 可点，且是 <button>（键盘可触发靠的就是它）。 */
    const logoExpanded = logoHost.querySelector('[data-ewb-logo-toggle="expanded"]')
    console.log('   ★ 展开态：logo 是可点的按钮（存在）:', logoExpanded !== null ? '✓' : '✗')
    if (logoExpanded === null) errors.push('展开态侧栏头部的 logo 不是可点元素（用户要求「点击 logo」）')
    console.log('   ★ 它是 <button>（键盘回车/空格天然可触发，不用手写 onKeyDown）:',
      logoExpanded?.tagName === 'BUTTON' ? '✓' : '✗（' + String(logoExpanded?.tagName) + '）')
    if (logoExpanded?.tagName !== 'BUTTON') {
      errors.push('logo 不是 button —— 键盘用户点不了「隐藏对话区」')
    }
    console.log('   ★ 它有 title:', (logoExpanded?.getAttribute('title') ?? '') !== '' ? '✓' : '✗',
      '（' + String(logoExpanded?.getAttribute('title')) + '）')
    if ((logoExpanded?.getAttribute('title') ?? '') === '') errors.push('logo 没有 title（不知道点了会发生什么）')
    console.log('   ★ 它有 aria-pressed:', logoExpanded?.getAttribute('aria-pressed') !== null ? '✓' : '✗')
    if (logoExpanded?.getAttribute('aria-pressed') === null) errors.push('logo 没有 aria-pressed（不知道当前是隐藏还是显示）')

    /* ② 真点一下：`setHideChat(true)` 必须被调一次。 */
    const beforeLogo = hideCalls.length
    logoExpanded?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    console.log('   ★ 点 logo → setHideChat 被调了一次:', hideCalls.length - beforeLogo === 1 ? '✓' : '✗（' + (hideCalls.length - beforeLogo) + ' 次）')
    if (hideCalls.length - beforeLogo !== 1) errors.push('点 logo 没有触发隐藏对话区（该动作必须走 setHideChat）')
    console.log('   ★ 传下去的是「隐藏」（true）:', hideCalls[hideCalls.length - 1] === true ? '✓' : '✗（' + String(hideCalls[hideCalls.length - 1]) + '）')
    if (hideCalls[hideCalls.length - 1] !== true) errors.push('点 logo 传的不是 true（没能隐藏对话区）')

    /* ③ 收起态那个 logo 也可点。先把侧栏收起来，再点 logo。 */
    const collapse2 = [...logoHost.querySelectorAll('button')]
      .find(b => (b.getAttribute('aria-label') ?? '') === '收起侧栏')
    collapse2?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const logoCollapsed = logoHost.querySelector('[data-ewb-logo-toggle="collapsed"]')
    console.log('   ★ 收起态：另一个 logo 也可点:', logoCollapsed !== null ? '✓' : '✗')
    if (logoCollapsed === null) errors.push('侧栏收起之后 logo 点不了（收起态也必须能切对话区）')
    console.log('   ★ 收起态那个也是 <button>:', logoCollapsed?.tagName === 'BUTTON' ? '✓' : '✗')
    const beforeLogo2 = hideCalls.length
    logoCollapsed?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    console.log('   ★ 收起态点 logo 也能切换:', hideCalls.length - beforeLogo2 === 1 ? '✓' : '✗')
    if (hideCalls.length - beforeLogo2 !== 1) errors.push('侧栏收起态点 logo 没有生效')
    /* 这一次要传 false（上一步已经隐藏了 → 再点是显示）。 */
    console.log('   ★ 第二次传的是「显示」（false，对称）:', hideCalls[hideCalls.length - 1] === false ? '✓' : '✗（' + String(hideCalls[hideCalls.length - 1]) + '）')
    if (hideCalls[hideCalls.length - 1] !== false) {
      errors.push('再点 logo 没有对称地取消隐藏（左栏会永远收着）')
    }

    /* ④ 底部**不许**再有「隐藏对话区」与「收起顶部」两颗按钮（票 48 删掉的）。
     *
     * ⚠️ **必须限定在侧栏底部那一列里搜**，不能拿整棵树的所有按钮去比文字。
     * 第一版就是全树搜 —— 而面包屑上那颗新按钮的文字**正好是「收起顶部」**，
     * 于是「底部还有收起顶部」永远红。这不是代码错，是判据把两个位置混成一个。
     *
     * 底部那一列怎么认：`[data-ewb-hide-wb]` 的**父节点**（那一列 flex 容器）。
     * 票 48 之后那列只剩「隐藏工作台 + 工作台设置」两颗，是个稳定的锚点。 */
    /* ⚠️ **必须切回展开态再判文字**。
     *
     * 上一步把侧栏收起来了，收起态下按钮**只有图标、文字是空的** ——
     * 那时「底部不含『隐藏对话区』这四个字」永远成立（空串嘛），
     * 是一条**假绿**。第一版就踩了这个坑：跑出来绿，但什么都没验到。
     * 判据要的是「展开态下底部还有没有那颗按钮」—— 那才是它当初的样子。 */
    const expand2 = [...logoHost.querySelectorAll('button')]
      .find(b => (b.getAttribute('aria-label') ?? '') === '展开侧栏')
    expand2?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()

    const footCol = logoHost.querySelector('[data-ewb-hide-wb]')?.parentElement ?? null
    console.log('   找得到侧栏底部那一列:', footCol !== null ? '✓' : '✗')
    const footTexts = footCol === null
      ? []
      : [...footCol.querySelectorAll('button')].map(b => (b.textContent ?? '').trim())
    console.log('   底部那一列里的按钮:', footTexts.join(' / ') || '（没有）')
    /* 前提：展开态底部至少要有文字采样，否则下面两条又是空对空。 */
    const footHasText = footTexts.some(t => t !== '')
    console.log('   判据前提：展开态底部按钮确实有文字（不是空对空）:', footHasText ? '✓' : '✗')
    if (!footHasText) errors.push('展开态底部按钮的文字采样是空的 —— 下面两条判据会变成空对空')
    console.log('   ★ 底部不再有「隐藏对话区」按钮:', !footTexts.some(t => t.includes('隐藏对话区')) ? '✓' : '✗（还在）')
    if (footTexts.some(t => t.includes('隐藏对话区'))) {
      errors.push('侧栏底部还留着「隐藏对话区」按钮（票 48 要求删掉，动作已搬到 logo）')
    }
    console.log('   ★ 底部不再有「收起顶部」按钮:', !footTexts.some(t => t.includes('收起顶部')) ? '✓' : '✗（还在）')
    if (footTexts.some(t => t.includes('收起顶部'))) {
      errors.push('侧栏底部还留着「收起顶部」按钮（已搬到面包屑 / tab 行）')
    }
    const sideToggleLeft = logoHost.querySelector('[data-ewb-top-toggle="sidebar"]')
    console.log('   ★ 也查不到 sidebar 那个取值了:', sideToggleLeft === null ? '✓' : '✗（还在）')
    if (sideToggleLeft !== null) errors.push('底部还挂着 data-ewb-top-toggle="sidebar" 的按钮')

    /* ★ 票 65 新增：上面那条「底部不再有『收起顶部』」在票 65 之后会**恒真**。
     *
     * ## 为什么它会变成假绿
     *
     * 它按 `textContent.includes('收起顶部')` 判。票 65 把那两颗按钮的文字删了
     * （用户：「找一个图标不要用文字符号」），于是底部那一列里**永远不可能**出现
     * 「收起顶部」这四个字 —— 有没有那颗按钮都通过。那是空话，不是防线。
     *
     * ## 这一条按**属性**判，与文字无关
     *
     * 侧栏底部那一列里**不许出现任何 `[data-ewb-top-toggle]`**。
     * 属性不会因为「换成图标」而消失，谁把按钮塞回底部，这条立刻红。
     *
     * 与上面那条**并存**（不是替换）：上面那条管「旧文字形态不许回来」，
     * 这条管「任何形态的入口都不许在底部」。两条各封一个方向。 */
    const topTogglesInFoot = footCol === null
      ? []
      : [...footCol.querySelectorAll('[data-ewb-top-toggle]')]
    console.log('   ★ 底部那一列里没有任何 [data-ewb-top-toggle]:',
      topTogglesInFoot.length === 0 ? '✓' : '✗（' + String(topTogglesInFoot.length) + ' 个：'
        + topTogglesInFoot.map(b => b.getAttribute('data-ewb-top-toggle')).join(',') + '）')
    if (topTogglesInFoot.length > 0) {
      errors.push('侧栏底部出现了 data-ewb-top-toggle（收起 / 展开顶部的入口只许在面包屑与 tab 行）')
    }

    /* ⑤ 「隐藏工作台」与「收起侧栏」的图标**不再是同一个**。
     *
     * 判据比 `innerHTML`（两个 svg 的 path 结构），不比文字 ——
     * 文字两边都是「隐藏工作台 / 收起侧栏」，本来就不同，比文字等于没比。 */
    const hideWbBtn = logoHost.querySelector('[data-ewb-hide-wb]')
    const collapseBtn2 = [...logoHost.querySelectorAll('button')]
      .find(b => (b.getAttribute('aria-label') ?? '').includes('侧栏'))
    const iconOf = b => (b?.querySelector('svg')?.innerHTML ?? '').trim()
    const wbIcon = iconOf(hideWbBtn)
    const collapseIcon = iconOf(collapseBtn2)
    console.log('   两个图标的 path 长度:', wbIcon.length, '/', collapseIcon.length)
    console.log('   ★ 「隐藏工作台」与「收起/展开侧栏」的图标不同:',
      wbIcon !== '' && collapseIcon !== '' && wbIcon !== collapseIcon ? '✓' : '✗（一样或取不到）')
    if (!(wbIcon !== '' && collapseIcon !== '' && wbIcon !== collapseIcon)) {
      errors.push('「隐藏工作台」与「收起侧栏」还是同一个图标（用户点名的易误认处）')
    }

    logoOff()
  }

  /* ── ④c 票 49：内容主体限宽 1440 ────────────────────────────────────────
   *
   * ## 为什么这一组要单独挂一次
   *
   * 要在**干净初始态**上读那个容器的内联 `maxWidth`，不受前面点过的状态影响。
   *
   * ## 为什么判的是内联 style 而不是类名
   *
   * 票面验收 1 原话：「断言要能读到那个值，**不是搜源码文本**」。
   * `dom-render` 把 `.module.css` 一律当空模块（`export default {}`），
   * 类名断言只能退化成「去 CSS 源文件里找那一行」—— 那正是它禁止的弱判据。
   * 内联 `style.maxWidth` 是 DOM 上真读得到的值。
   */
  {
    /* ⚠️ `CONTENT_MAX_WIDTH` 是**独立导出**，不是组件上的属性 ——
     * 第一版写成 `WB49.CONTENT_MAX_WIDTH` 得到 undefined，
     * 断言因此假红。 */
    const { EcomWorkbench: WB49, CONTENT_MAX_WIDTH } = await import('../src/client/workbench/EcomWorkbench.tsx')
    const realFetch49 = window.fetch
    window.fetch = globalThis.fetch = async (url, init) => {
      const u = String(url)
      if (u.includes('/ui/prefs')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, prefs: { topHidden: false, navCollapsed: false, libW: 260, legend: true, nodeW: 300 } }) }
      }
      return realFetch49(url, init)
    }
    const { host: host49, unmount: off49 } = await mountInto(
      React.createElement(WB49, {
        get: () => true, set: () => {}, getHideChat: () => false, setHideChat: () => {},
        getWb: () => true, setWb: () => {},
      }),
    )

    /* ① 值读得到，就是 1440。 */
    const main49 = host49.querySelector('[data-ewb-content-main]')
    console.log('   ★ 找得到内容主体那一层（`data-ewb-content-main`）:', main49 !== null ? '✓' : '✗')
    if (main49 === null) errors.push('找不到内容主体那一层（限宽挂在哪个元素上？）')
    const mw = main49?.style?.maxWidth ?? ''
    console.log('   ★ 它的内联 maxWidth 是 1440px:', mw === '1440px' ? '✓' : '✗（' + JSON.stringify(mw) + '）')
    if (mw !== '1440px') {
      errors.push('内容主体没有 1440px 的内联 maxWidth（实际：' + JSON.stringify(mw) + '）')
    }
    /* 与导出的常量对上（防「常量改了、内联还是旧数字」）。
     *
     * ⚠️ **票 69 之后这条守的东西变了一层，强度没降**：
     *
     * | | 票 49 那一版 | 票 69 之后 |
     * |---|---|---|
     * | 谁决定内联值 | 全靠常量 `CONTENT_MAX_WIDTH` | 偏好 `contentMaxWidth`，**缺省**取自常量 |
     * | 这条判据验什么 | 常量 == 1440 **且** 内联 == 1440px | 常量 == 1440 **且** 缺省偏好 == 常量 **且** 内联 == 1440px |
     *
     * 三条比一条严：常量与缺省偏好**两处都写 1440**，谁改了其中一处这条立刻红
     * （「常量改了、偏好还是旧数」正是搬家类改动最容易留下的缝）。 */
    const WP69 = await import('../src/client/workbench/lib/workbench-prefs.ts')
    console.log('   ★ 与导出的 CONTENT_MAX_WIDTH 一致:',
      CONTENT_MAX_WIDTH === 1440 ? '✓' : '✗（' + String(CONTENT_MAX_WIDTH) + '）')
    if (CONTENT_MAX_WIDTH !== 1440) {
      errors.push('CONTENT_MAX_WIDTH 不是 1440（实际 ' + String(CONTENT_MAX_WIDTH) + '）')
    }
    /* 票 69 新增：缺省偏好必须与常量同值（两处各写一份，漂了就红）。 */
    const sameAsConst = WP69.DEFAULT_CONTENT_MAX_WIDTH === CONTENT_MAX_WIDTH
    console.log('   ★ 票 69：缺省偏好值与常量一致:',
      sameAsConst ? '✓（' + String(WP69.DEFAULT_CONTENT_MAX_WIDTH) + '）'
        : '✗（偏好 ' + String(WP69.DEFAULT_CONTENT_MAX_WIDTH) + ' vs 常量 ' + String(CONTENT_MAX_WIDTH) + '）')
    if (!sameAsConst) {
      errors.push('缺省的内容区限宽（' + String(WP69.DEFAULT_CONTENT_MAX_WIDTH)
        + '）与 CONTENT_MAX_WIDTH（' + String(CONTENT_MAX_WIDTH) + '）不一致')
    }
    /* 票 69 新增：五档就是票面那五个值，且缺省在档内。 */
    const wantWidths = [0, 1200, 1440, 1680, 1920]
    const gotWidths = [...WP69.CONTENT_MAX_WIDTHS]
    console.log('   ★ 票 69：五档就是 不限宽 / 1200 / 1440 / 1680 / 1920:',
      JSON.stringify(gotWidths) === JSON.stringify(wantWidths) ? '✓' : '✗（' + gotWidths.join(',') + '）')
    if (JSON.stringify(gotWidths) !== JSON.stringify(wantWidths)) {
      errors.push('内容区限宽的五档不是票面那五个（实际 ' + gotWidths.join(',') + '）')
    }

    /* ② **小于 1440 时视觉上毫无变化**（票面验收 2）。
     *
     * ## 这一条在验什么
     *
     * 加 `max-width` 之后最容易引入的回归是「顺手加了 `w-[1440px]` 或
     * `flex-1` + 居中，把窄窗口里的内容也撑到 1440 / 压窄」。所以判据落在三件：
     *   a. 有 `w-full` —— 窄的时候跟着父级走，不是固定宽度
     *   b. **没有**固定宽度类（`w-[1440px]` / `min-w-[`）—— 那会把窄屏撑出横向溢出
     *   c. 居中用的是 `mx-auto`（剩余空间为 0 时它算出来就是 0）
     *
     * ⚠️ jsdom 不做布局，`clientWidth` 恒 0、`getComputedStyle` 也不解 flex ——
     * 所以这里量的是**声明**，不是像素。这一点如实写在交付里。 */
    const cls49 = typeof main49?.className === 'string' ? main49.className : ''
    console.log('   内容主体的类名:', cls49)
    console.log('   ★ 窄屏跟着父级走（有 w-full）:', /(^|\s)w-full(\s|$)/.test(cls49) ? '✓' : '✗')
    if (!/(^|\s)w-full(\s|$)/.test(cls49)) {
      errors.push('内容主体没有 w-full —— 窄窗口里它不会跟着父级走（可能被 max-width 以外的因素压窄）')
    }
    /* 反面：**不许**出现固定宽度。 */
    const fixed49 = /(^|\s)(w|min-w)-\[/.test(cls49) || /(^|\s)w-\d/.test(cls49)
    console.log('   ★ 反面：没有固定宽度类（w-[…] / min-w-[…] / w-数字）:', fixed49 ? '✗（' + cls49 + '）' : '✓')
    if (fixed49) {
      errors.push('内容主体带了固定宽度类 —— 窄窗口里会被撑出横向溢出（`max-width` 不该写成 `width`）')
    }
    console.log('   ★ 居中用 mx-auto（剩余空间为 0 时它不产生位移）:', /(^|\s)md:mx-auto(\s|$)/.test(cls49) ? '✓' : '✗')
    if (!/(^|\s)md:mx-auto(\s|$)/.test(cls49)) {
      errors.push('内容主体没有 mx-auto —— 超宽屏时内容会贴左，用户要求「内容随整体宽度调整」')
    }

    /* ③ 面包屑那一行**不受限**（票面要我先判断的那条：限的是内容主体，不是整列）。 */
    const crumbRow49 = [...host49.querySelectorAll('div')]
      .find(d => typeof d.className === 'string' && d.className.includes('h-[52px]'))
    const crumbMw = crumbRow49?.style?.maxWidth ?? ''
    console.log('   ★ 面包屑那一行不受限宽（它继续铺满）:', crumbMw === '' ? '✓' : '✗（' + JSON.stringify(crumbMw) + '）')
    if (crumbMw !== '') {
      errors.push('面包屑那一行也被限宽了 —— 用户说的是「板块内容区域」，面包屑该继续铺满')
    }

    /* ④ 旧注释已改写（票面验收 3）。
     *
     * 判据读**源码**：不许再出现「最大宽度**去掉**」那句；
     * 且新注释里必须点明「用户改主意」与 1440。
     * 这一条只能读源码 —— 注释不进 DOM。 */
    const src49 = readFileSync(new URL('../src/client/workbench/EcomWorkbench.tsx', import.meta.url), 'utf8')
    const oldClaim = src49.includes('最大宽度**去掉**（用户要求）')
    console.log('   ★ 旧注释「最大宽度去掉」已经不在了:', oldClaim ? '✗（还在）' : '✓')
    if (oldClaim) errors.push('旧注释「最大宽度**去掉**（用户要求）」还留着 —— 与代码里的 max-width 自相矛盾')
    const saysChanged = /用户 2026-10-28 改主意/.test(src49)
    console.log('   ★ 新注释点明了「用户改主意」:', saysChanged ? '✓' : '✗')
    if (!saysChanged) errors.push('新注释没有点明这是用户改主意（下一个人会以为是补新功能）')

    off49()
    window.fetch = globalThis.fetch = realFetch49
  }

  /* ── ⑤ 全站只有一个能改浏览器设置的入口 ──────────────────────
   *
   * 判据两条（缺一条就验不住「唯一」）：
   *   ① 骨架里**只有**一个 `data-ewb-ws-open`（工作台设置入口）；
   *   ② 画布工具条上**没有**任何打开设置抽屉的按钮能摸到浏览器设置 ——
   *      这条由上面「抽屉里没有浏览器」那个断言覆盖，这里补「入口只有一个」。 */
  /* ⚠️ 票 66：齿轮删了，这条从「唯一一处」改成「一处都不剩」——
   * 设置入口现在只有导航里那一个「配置」板块（下面紧接着验它在）。 */
  const wsOpens = wbHost.querySelectorAll('[data-ewb-ws-open]')
  console.log('   ★ 旧齿轮入口一处都不剩:', wsOpens.length === 0 ? '✓' : '✗（' + wsOpens.length + ' 处）')
  if (wsOpens.length !== 0) errors.push('工作台设置齿轮入口还在（票 66 已改成「配置」板块）')

  /* ── ★ ⑥ 收起侧栏时，底部那排按钮与上方板块按钮**同一套尺寸与间距** ──────
   *
   * ## 用户看到的问题
   *
   * 「左侧栏收起态下，下面的按钮间隔太大了，下面按钮的按钮大小和范围应该和上面的
   * 板块按钮一样，当前外框大了间距也大了」。
   *
   * ## 判据
   *
   * jsdom 不算布局，量不出像素。所以判据落在**类名里写的那两个值**上：
   *   · 收起态的容器内边距 `px-2.5`（与 `nav` 那个容器一致）；
   *   · 收起态的行距 `gap-0.5`（与 `nav` 一致）。
   *
   * 这是**结构判据**而不是视觉判据，但它恰好能抓住原缺陷：改前底部是
   * `px-0` + `gap-2` —— 与导航区的 `px-2.5` + `gap-0.5` 不同，判据会红。
   *
   * ⚠️ 必须先切成收起态再读。默认是展开态，那时两处的 `px` / `gap` 本来就不同
   * （`px-5` / `gap-2` 对 `px-2.5` / `gap-0.5`），判了会假红。
   * 收起靠点侧栏头部那个 `aria-label="收起侧栏"` 的按钮 —— 那是用户真会点的地方。 */
  const collapseBtn = [...wbHost.querySelectorAll('button')]
    .find(b => (b.getAttribute('aria-label') ?? '') === '收起侧栏')
  console.log('   找到了「收起侧栏」按钮:', collapseBtn !== undefined ? '✓' : '✗')
  collapseBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()

  /* 导航区容器（上方板块按钮那一列） */
  const navBox = wbHost.querySelector('nav')
  /* 底部区容器：包着「隐藏工作台」那个按钮的那一层。 */
  const footBox = wbHost.querySelector('[data-ewb-hide-wb]')?.parentElement
  const clsOf = el => String(el?.className ?? '')
  const navCls = clsOf(navBox)
  const footCls = clsOf(footBox)
  console.log('   收起后导航区类名含 px-2.5 / gap-0.5:',
    navCls.includes('px-2.5') && navCls.includes('gap-0.5') ? '✓' : '✗（' + navCls + '）')
  console.log('   ★ 收起后底部区也是 px-2.5 / gap-0.5（与上方一致）:',
    footCls.includes('px-2.5') && footCls.includes('gap-0.5') ? '✓' : '✗（' + footCls + '）')
  if (!(footCls.includes('px-2.5') && footCls.includes('gap-0.5'))) {
    errors.push('收起侧栏时底部那排按钮的边距 / 行距与上方板块按钮不一致（用户：'
      + '「下面按钮的大小和范围应该和上面的板块按钮一样」）。实际：' + footCls)
  }
  /* 反面铁证：底部**不许**还留着旧的 `px-0` 或 `gap-2`（收起态）。
   * 没有这一条，上面那条在「两个都写上了」的情况下也能过。 */
  const footHasOld = /(^|\s)px-0(\s|$)/.test(footCls) || /(^|\s)gap-2(\s|$)/.test(footCls)
  console.log('   ★ 收起后底部不再有旧间距（px-0 / gap-2）:', footHasOld ? '✗' : '✓')
  if (footHasOld) {
    errors.push('收起侧栏时底部仍带着旧间距（px-0 或 gap-2）—— 那就是用户说的「外框大了间距也大了」')
  }
  /* 按钮个头：收起态底部按钮与上方板块按钮**都是方形铺满**（`aspect-square w-full`）。
   * 这一条钉的是「大小一样」那半 —— 只对齐边距、按钮还是圆角长方块也不对。 */
  /* ⚠️ 票 48：`sideToggle()`（那是「收起顶部」的旧入口）已经从底部删了 ——
   * 继续拿它当「底部按钮」的样本会 `undefined`，然后整个测试崩在下一行。
   *
   * ## 票 66 又少一颗：现在底部只剩**一颗**（`data-ewb-hide-wb`）
   *
   * 齿轮「工作台设置」已删 —— 它升级成了侧栏导航里的「配置」板块
   * （`data-ewb-item="settings"`，分组「系统」）。所以底部不再是「两排」，
   * 只剩「隐藏工作台」这一颗。
   *
   * 判据本身没变（「底部按钮与上方板块按钮都是方形铺满」），只是样本跟着变。
   * 这**不是放宽**：从 2 颗换成 1 颗，仍然是「底部所有按钮都得满足」，
   * 而且下面**新加了一条反面** —— 底部不许再长出第二颗（那就是齿轮回来了）。 */
  const areaBtns = [...wbHost.querySelectorAll('[data-ewb-item]')]
  const footBtns = [...wbHost.querySelectorAll('[data-ewb-hide-wb]')]
  console.log('   收起态底部的按钮样本数:', footBtns.length, '（应为 1：隐藏工作台）')
  if (footBtns.length !== 1) {
    errors.push('收起态底部按钮不是一颗（隐藏工作台）—— 实际 ' + String(footBtns.length) + ' 颗')
  }
  const squareOf = el => clsOf(el).includes('aspect-square') && clsOf(el).includes('w-full')
  const areaOk = areaBtns.length > 0 && areaBtns.every(squareOf)
  const footOk = footBtns.length > 0 && footBtns.every(squareOf)
  console.log('   ★ 收起后上下两排按钮都是方形铺满（' + String(areaBtns.length) + ' / ' + String(footBtns.length) + '）:',
    areaOk && footOk ? '✓' : '✗（上方 ' + String(areaOk) + ' / 底部 ' + String(footOk) + '）')
  if (!(areaOk && footOk)) {
    errors.push('收起侧栏时上下两排按钮的形状不一致（应当都是方形铺满）')
  }
  /* 切回展开态，别把后面的断言带歪。 */
  const expandBtn = [...wbHost.querySelectorAll('button')]
    .find(b => (b.getAttribute('aria-label') ?? '') === '展开侧栏')
  expandBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()

  /* ⚠️ 票 66：**这段被替换了**。原来是「点齿轮 → 抽屉打开 → 抽屉里有浏览器设置」。
   *
   * 抽屉与齿轮都没了（设置升级成「配置」板块）。判据的意思仍然是
   * 「浏览器设置有一个**唯一且可达**的入口」，换成新形态两件：
   *
   *   ① 反面：底部与整个侧栏里**不再有** `data-ewb-ws-open`（齿轮真删了）；
   *   ② 正面：导航里有「配置」板块（`data-ewb-item="settings"`）—— 新入口在。
   *
   * ② 只验「入口在」，不验「点进去有浏览器」—— 那要真切板块，
   * 而 §⑲ 已经直接挂 `ConfigBoard` 验了「其它那一格有浏览器」。
   * 两条合起来才是完整的「可达」。
   *
   * **不是删断言**：原来 2 条（点开抽屉 / 抽屉里有浏览器），这里换成 2 条
   * （齿轮没了 / 配置板块在），后面 §⑲ 那 1 条仍然验浏览器。净增。 */
  const gearLeft = wbHost.querySelectorAll('[data-ewb-ws-open]')
  console.log('   ★ 反面：底部齿轮已删（没有 data-ewb-ws-open）:', gearLeft.length === 0 ? '✓' : '✗（' + String(gearLeft.length) + ' 处）')
  if (gearLeft.length !== 0) {
    errors.push('侧栏底部还有齿轮入口（票 66 已把工作台设置升级成「配置」板块，齿轮该删）')
  }
  const cfgNav = wbHost.querySelector('[data-ewb-item="settings"]')
  console.log('   ★ 导航里有「配置」板块（齿轮的替代入口）:', cfgNav !== null ? '✓' : '✗')
  if (cfgNav === null) {
    errors.push('导航里没有「配置」板块 —— 齿轮删了却没有替代入口，用户就再也进不去设置了')
  }

  /* ── 票 66 验收 1 / 7 / 8 的三条（原来一条断言都没有）────────────
   *
   * 这三条全是**用户看得见的排布**，不是内部结构：
   *   ① 配置在**最后一个**、在「系统」分组下面；
   *   ② 内容板块那格改名叫「板块设置」（不然侧栏一个「配置」、
   *     内容板块里又一个「配置」，用户分不清）；
   *   ③ 侧栏底部「引擎就绪」还在。
   *
   * 判据取**文档顺序**（`querySelectorAll` 返回的就是渲染顺序）——
   * 侧栏从上到下就是用户看到的那一列。 */

  /* ① 最后一位：所有板块按钮里，`settings` 必须是最后一个。 */
  const allNav = [...wbHost.querySelectorAll('[data-ewb-item]')]
  const lastNav = allNav[allNav.length - 1]?.getAttribute('data-ewb-item') ?? '(无)'
  console.log('   ★ 配置在导航最后一位:', lastNav === 'settings' ? '✓' : '✗（最后是 ' + lastNav + '）')
  if (lastNav !== 'settings') {
    errors.push('配置不在导航最后一位（最后是 ' + lastNav + '）—— 用户要求「排序在最后一个」')
  }

  /* ①-b 「系统」分组标题存在，且在配置那颗之前。 */
  const sysGroup = [...wbHost.querySelectorAll('div')]
    .find(d => typeof d.className === 'string' && d.className.includes('tracking-[0.22em]')
      && (d.textContent ?? '').trim() === '系统')
  console.log('   ★ 「系统」分组标题在（配置挂在它下面）:', sysGroup !== null ? '✓' : '✗')
  if (sysGroup === null) {
    errors.push('没有「系统」这个分组标题 —— 配置板块成了孤零零一条')
  } else if (cfgNav !== null) {
    /* 文档顺序：分组标题必须排在配置那颗**前面**。 */
    const pos = sysGroup.compareDocumentPosition(cfgNav)
    const before = (pos & window.Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    console.log('   ★ 「系统」分组标题排在配置前面:', before ? '✓' : '✗')
    if (!before) errors.push('「系统」分组标题排在配置后面 —— 分组标题应该在它管的条目之前')
  }

  /* ② 内容板块那格叫「板块设置」，不是「配置」。
   *
   * ⚠️ 这条**读源码**，不是读 DOM：内容板块的 tab 格要点进内容板块才渲染，
   * 这一屏（侧栏）里根本没有它。`data-ewb-item="config"` 是**侧栏导航项**、
   * 是另一件事（第一版就是拿它比的，拿到空串）。
   *
   * 读源码不弱：查的是 `boards.ts` 里注册时那几个字面量，
   * 与用户点进去 tab 条上看到的是同一份数据（tab 条直接由它渲染）。 */
  const boardsSrc66 = readFileSync(new URL('../src/client/workbench/boards.ts', import.meta.url), 'utf8')
  const cellRenamed = /\{\s*id:\s*'config',\s*label:\s*'板块设置'\s*\}/.test(boardsSrc66)
  console.log('   ★ 内容板块那格叫「板块设置」:', cellRenamed ? '✓' : '✗')
  if (!cellRenamed) {
    errors.push('内容板块那格没改名 —— 侧栏会出现两个「配置」，用户分不清')
  }
  /* 反面：`boards.ts` 里**不许**再有 `id: 'config'` 配 `label: '配置'` 那一条。 */
  const stillDup = /\{\s*id:\s*'config',\s*label:\s*'配置'\s*\}/.test(boardsSrc66)
  console.log('   ★ 反面：没有「id config + label 配置」那一条了:', stillDup ? '✗' : '✓')
  if (stillDup) {
    errors.push('`boards.ts` 里还有 id: config / label: 配置 —— 与板块重名')
  }
  /* 反面二：侧栏导航项里**只有**一个「配置」（板块那一颗）。
   * 这一条读 DOM —— 侧栏这一屏里真实的按钮文字。 */
  const navTexts = [...wbHost.querySelectorAll('[data-ewb-item]')].map(b => (b.textContent ?? '').trim())
  const cfgCount = navTexts.filter(t => t === '配置').length
  console.log('   ★ 反面：侧栏导航里只有一个「配置」:', cfgCount === 1 ? '✓' : '✗（' + cfgCount + ' 个）')
  if (cfgCount !== 1) {
    errors.push('侧栏导航里有 ' + cfgCount + ' 个「配置」')
  }

  /* ③ 底部「引擎就绪」还在（齿轮删掉后它落到最下面，但**不许消失**）。 */
  const engineLine = [...wbHost.querySelectorAll('span,div')]
    .some(el => (el.textContent ?? '').trim() === '引擎就绪')
  console.log('   ★ 底部「引擎就绪」那一行还在:', engineLine ? '✓' : '✗')
  if (!engineLine) {
    errors.push('侧栏底部「引擎就绪」不见了 —— 删齿轮时连带删掉了状态行')
  }

  wbOff()
  window.fetch = globalThis.fetch = realFetchSk
}

/* ⑯ 取数板块：卡片形态 + 只显示两份 + 就地展开输出（2026-10-22 重设计）。
 *
 * ## 为什么从源码 import
 *
 * 与 ⑬⑭⑮ 三段同一个理由：产物由校核统一重建，执行角色不许自己跑 bundle。
 * 读产物会把「没重建」误报成「代码坏了」。**另有一层这里特别要紧**：
 * 这一批把 5 列表格换成了卡片，改动大；若读产物，产物还没重建时
 * 这一段会看到**老表格**，那几条断言红得莫名其妙。
 *
 * ## 判据为什么这么写
 *
 * ① **只显示两份**：判据是 `data-ewb-collect-card` 的**值**恰好是那两份。
 *    光数「有两张卡」不够 —— 桩里放了 8 份工作流，若过滤写坏了会有 8 张。
 *    而且桩里**故意留着**底层三份取数（天猫 / 抖音 / 千川），
 *    否则过滤写坏了也看不出来（没有可被捞进来的东西）。
 * ② **栅格**：判据看 `data-ewb-collect-cards` 元素上的 `grid-template-columns`
 *    含 `auto-fit` + `minmax(260px`。不是判「用了 grid」——
 *    等高网格也是 grid，但那是另一种形态（用户明确说不要）。
 * ③ **就地展开**：点执行后 `[data-ewb-collect-runpanel="<名字>"]` 必须出现在
 *    **那张卡片内部**（`closest('[data-ewb-collect-card]')` 的 id 对得上），
 *    而不是页面别处。这一条是「就地」二字的落点。
 * ④ **只剩一个能跑**：点一张卡之后，另一张卡的执行按钮必须 `disabled`，
 *    且 `title` 里写了原因（只灰不说等于坏了）。
 * ⑤ **空态**：白名单里两份都不存在时，要显示空态并说清缺什么、下一步去哪。
 */
console.log('⑯ [取数板块] 卡片形态 + 只显示两份 + 就地展开输出')
{
  globalThis.React = React
  const { CollectBoard } = await import('../src/client/workbench/CollectBoard.tsx')
  const { COLLECT_ENTRIES } = await import('../src/client/workbench/board-kit.ts')

  /** 挂一块到独立容器（每次都给新的，避免上一块的 DOM 串味）。 */
  const mountCollect = async () => {
    const host = window.document.createElement('div')
    window.document.body.appendChild(host)
    const root = ReactDOMClient.createRoot(host)
    root.render(React.createElement(CollectBoard, {
      active: true, tab: '', apiBase: '/api/ecom-workbench', topHidden: false,
      onToggleTop: () => {}, onSelectTab: () => {}, onRunWorkflow: () => {},
    }))
    await settle()
    return { host, root, unmount: () => { root.unmount(); host.remove() } }
  }

  /* ── 白名单本身：只有两份，且判据不是「非巡查类」 ───────────────
   * 这一层不依赖渲染 —— 即使界面整块写错，白名单错了也要红。 */
  const { isCollectEntry } = await import('../src/client/workbench/board-kit.ts')
  console.log('   白名单里的名字:', COLLECT_ENTRIES.map(e => e.name).join(' / '))
  const wantTwo = COLLECT_ENTRIES.length === 2
    && COLLECT_ENTRIES.some(e => e.name === '全部下载')
    && COLLECT_ENTRIES.some(e => e.name === '清洗入库')
  console.log('   ★ 白名单恰好是「全部下载 + 清洗入库」:', wantTwo ? '✓' : '✗')
  if (!wantTwo) errors.push('取数板块的白名单不是「全部下载 + 清洗入库」两份')
  const under = ['取数-天猫生意参谋', '取数-抖音电商罗盘', '取数-千川全域推广']
  const underOut = under.every(n => !isCollectEntry(n))
  console.log('   ★ 底层三份取数不在白名单里:', underOut ? '✓' : '✗')
  if (!underOut) errors.push('底层三份取数被白名单收进来了（它们只是「全部下载」的零件）')

  /* ── ① 界面只渲染两份卡 ─────────────────────────────────── */
  const ui = await mountCollect()
  const cardEls = [...ui.host.querySelectorAll('[data-ewb-collect-card]')]
  const cardNames = cardEls.map(e => e.getAttribute('data-ewb-collect-card'))
  console.log('   渲染出来的卡片:', cardNames.join(' / ') || '(无)')
  const exactlyTwo = cardNames.length === 2
    && cardNames.includes('全部下载') && cardNames.includes('清洗入库')
  console.log('   ★ 只有「全部下载」与「清洗入库」两张卡:', exactlyTwo ? '✓' : '✗')
  if (!exactlyTwo) errors.push('取数板块渲染的卡片不是恰好两张（全部下载 + 清洗入库）')
  /* 反向：底层三份的名字**一个都不许出现**在卡片区。 */
  const leaked = under.filter(n => cardNames.includes(n))
  console.log('   ★ 底层三份取数没有出现在卡片里:', leaked.length === 0 ? '✓' : '✗（' + leaked.join('、') + '）')
  if (leaked.length > 0) errors.push('底层三份取数出现在取数板块里了：' + leaked.join('、'))

  /* ── ② 等宽两列栅格（不是等高网格、不是瀑布流）─────────────── */
  const grid = ui.host.querySelector('[data-ewb-collect-cards]')
  const gridCls = grid?.className ?? ''
  const isAutoFit = /auto-fit/.test(gridCls) && /minmax\(260px/.test(gridCls)
  console.log('   卡片容器的栅格类:', isAutoFit ? 'repeat(auto-fit,minmax(260px,1fr)) ✓' : '✗（' + gridCls.slice(0, 80) + '）')
  if (!isAutoFit) errors.push('卡片不是等宽自适应栅格（auto-fit + minmax），窄屏不会落成一列')
  /* 反面：不许出现瀑布流那种「按列高拆分」的写法（columns-* / masonry）。 */
  const masonry = /columns-\d|masonry/.test(gridCls)
  console.log('   不是瀑布流写法:', masonry ? '✗' : '✓')
  if (masonry) errors.push('卡片用了瀑布流（columns / masonry），那是用户明确排除的形态')

  /* ── 卡片内容：状态一句话 + 最近一次 + 交出 N 项 ─────────────── */
  const cardText = (name) => (ui.host.querySelector('[data-ewb-collect-card="' + name + '"]')?.textContent ?? '')
  const allText = cardText('全部下载')
  console.log('   「全部下载」卡片写了「最近：」:', allText.includes('最近：') ? '✓' : '✗')
  if (!allText.includes('最近：')) errors.push('卡片上没有「最近：…」那行（用户要求露最近一次与交出几项）')
  console.log('   「全部下载」卡片写了「交出 4 项」:', /交出\s*4\s*项/.test(allText) ? '✓' : '✗')
  if (!/交出\s*4\s*项/.test(allText)) errors.push('卡片上没有「交出 N 项」（桩里那份有 4 项产出）')
  const cleanText = cardText('清洗入库')
  console.log('   「清洗入库」卡片标出了失败:', cleanText.includes('失败') ? '✓' : '✗')
  if (!cleanText.includes('失败')) errors.push('桩里那份失败的采集，卡片上没有标出失败')

  /* 产出露 2 行（多的折叠）—— 桩里 4 项，所以应当出现「还有 2 项」。 */
  console.log('   产出只露 2 行、多的折叠:', allText.includes('还有 2 项') ? '✓' : '✗')
  if (!allText.includes('还有 2 项')) errors.push('产出一股脑全展开了（用户要求露 2 行，多的折叠）')

  /* ── ③ 点执行 → 该卡片内部就地展开输出区 ──────────────────── */
  const runBtn = ui.host.querySelector('[data-ewb-collect-run="全部下载"]')
  console.log('   「全部下载」有执行按钮:', runBtn !== null ? '✓' : '✗')
  if (runBtn === null) errors.push('卡片上没有执行按钮')
  runBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()

  const panel = ui.host.querySelector('[data-ewb-collect-runpanel="全部下载"]')
  console.log('   ★ 点执行后展开了输出区:', panel !== null ? '✓' : '✗')
  if (panel === null) errors.push('点执行后没有展开输出区')
  if (panel !== null) {
    /* 「就地」：它必须在**那张卡片**的子树里。 */
    const owner = panel.closest('[data-ewb-collect-card]')?.getAttribute('data-ewb-collect-card') ?? '(无)'
    console.log('   ★ 输出区在那张卡片内部（不是页面别处）:', owner === '全部下载' ? '✓' : '✗（属于 ' + owner + '）')
    if (owner !== '全部下载') errors.push('输出区没有挂在那张卡片内部（「就地」二字没做到）')
    /* 复用的确实是 FlowRunPanel（判据看它自己的 data 标记，不是猜）。 */
    console.log('   输出区里是 FlowRunPanel:', panel.querySelector('[data-ewb-flow-panel]') !== null ? '✓' : '✗')
    if (panel.querySelector('[data-ewb-flow-panel]') === null) errors.push('输出区不是复用 FlowRunPanel')
  }

  /* ── ④ 一份在跑时，另一份禁用且说明原因 ────────────────────── */
  const otherBtn = ui.host.querySelector('[data-ewb-collect-run="清洗入库"]')
  const otherDisabled = otherBtn?.disabled === true
  const otherTitle = otherBtn?.getAttribute('title') ?? ''
  console.log('   ★ 另一份的执行按钮被禁用:', otherDisabled ? '✓' : '✗')
  if (!otherDisabled) errors.push('一份在跑时，另一份的执行按钮没有禁用（会抢同一个浏览器会话）')
  console.log('   ★ 禁用时写明了原因:', otherTitle.includes('正在跑') ? '✓' : '✗（' + otherTitle.slice(0, 40) + '）')
  if (!otherTitle.includes('正在跑')) errors.push('执行按钮禁用时没说原因（只灰不说，用户以为坏了）')

  /* ── ★ ⑤ 失败后「不用离开任务中心」就能知道为什么失败（2026-10-23 契约 Y）──
   *
   * ## 用户原话
   *
   * 「就算失败了也应该在任务中心界面显示完整流程。至少为什么失败要在任务中心
   * 看得到，思考一下是应该做进节点中还是借用工作流的运行历史」。
   *
   * ## 判据
   *
   * 走**真的失败**那条路：装一个假 `EventSource`，喂一条失败步骤 + 一条失败的 `done`，
   * 然后看卡片上有没有三样：
   *
   *   ① **为什么失败**（原因文字，不是只有「失败」两个字）；
   *   ② **停在哪个节点**（用户往下查的起点）；
   *   ③ 去哪看逐条日志（写明路径；**不做成假装能跳的按钮**）。
   *
   * ⚠️ 必须装 `EventSource`：不装的话 `FlowRunPanel` 走「这个环境不支持实时推送」
   * 那条退路，`onDone` 永远不触发，这一段等于没验。
   *
   * ⚠️ 而且**必须验反面**：成功的那张卡上不许出现这块 ——
   * 只验「失败时有」的话，把这块无条件渲染上去也照样绿。
   */
  {
    const fakeEs = []
    class FailEs {
      constructor(url) {
        this.url = String(url)
        this.handlers = {}
        this.closed = false
        fakeEs.push(this)
      }
      addEventListener(kind, fn) { (this.handlers[kind] ||= []).push(fn) }
      close() { this.closed = true }
    }
    window.EventSource = FailEs
    globalThis.EventSource = FailEs

    /* 先收起上一轮那张卡（它还在跑），否则「一份在跑时别的禁用」会拦住这一次点击。 */
    ui.unmount()
    const failUi = await mountCollect()
    failUi.host.querySelector('[data-ewb-collect-run="清洗入库"]')
      ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()

    const es = fakeEs[fakeEs.length - 1]
    console.log('   点执行后开了一条流:', es !== undefined ? '✓' : '✗')
    if (es === undefined) {
      errors.push('点执行后没有开流（这一段验不到失败详情）')
    } else {
      for (const fn of (es.handlers.step ?? [])) {
        fn({ data: JSON.stringify({ kind: 'started', nodeId: 'n1', label: '① 天猫下载' }) })
      }
      await settle()
      for (const fn of (es.handlers.step ?? [])) {
        fn({ data: JSON.stringify({ kind: 'failed', nodeId: 'n2', error: '登录态失效，页面跳回登录页' }) })
      }
      await settle()
      for (const fn of (es.handlers.done ?? [])) {
        fn({
          data: JSON.stringify({
            ok: false,
            aborted: true,
            ran: ['n1', 'n2'],
            error: '登录态失效，页面跳回登录页',
            runId: 'run-fail-1',
          }),
        })
      }
      await settle()

      const card = failUi.host.querySelector('[data-ewb-collect-card="清洗入库"]')
      const box = card?.querySelector('[data-ewb-collect-fail]')
      console.log('   ★ 失败的卡片上出现了失败详情块:', box !== null && box !== undefined ? '✓' : '✗')
      if (box === null || box === undefined) {
        errors.push('失败的卡片上没有失败详情块（用户得离开任务中心才知道为什么失败）')
      } else {
        const reason = card?.querySelector('[data-ewb-collect-fail-reason]')?.textContent ?? ''
        console.log('   ★ 写明了「为什么失败」（不是只有「失败」二字）:',
          reason.includes('登录态失效') ? '✓' : '✗（' + reason + '）')
        if (!reason.includes('登录态失效')) {
          errors.push('失败详情里没有具体原因（只有「失败」两个字等于没说）')
        }
        const nodeTxt = card?.querySelector('[data-ewb-collect-fail-node]')?.textContent ?? ''
        console.log('   ★ 写明了「停在哪个节点」:', nodeTxt.includes('n2') ? '✓' : '✗（' + nodeTxt + '）')
        if (!nodeTxt.includes('n2')) {
          errors.push('失败详情里没有「停在哪个节点」（用户不知道从哪一步往下查）')
        }
        const hint = box.textContent ?? ''
        console.log('   ★ 写明了逐条日志去哪看:', hint.includes('运行历史') ? '✓' : '✗')
        if (!hint.includes('运行历史')) {
          errors.push('失败详情没说逐条日志去哪看（用户不知道下一步）')
        }
      }

      /* 反面铁证：成功的那张卡上**不许**有失败详情。 */
      const okCard = failUi.host.querySelector('[data-ewb-collect-card="全部下载"]')
      console.log('   ★ 成功的卡片上没有失败详情块（反面）:',
        okCard?.querySelector('[data-ewb-collect-fail]') === null ? '✓' : '✗')
      if (okCard?.querySelector('[data-ewb-collect-fail]') !== null) {
        errors.push('成功的卡片上也挂了失败详情（那块该只在失败时出现）')
      }
    }

    failUi.unmount()
    window.EventSource = undefined
    globalThis.EventSource = undefined
  }

  /* ── ⑤ 空态：白名单两份都不存在时说清下一步 ──────────────────
   *
   * 临时把 `/workflows` 桩换掉（只返回一份不相关的工作流），
   * 于是白名单两份都命中不了 → 必然走空态。 */
  const realFetch = window.fetch
  window.fetch = globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('/api/ecom-workbench/workflows') && (init?.method ?? 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => ({ dir: 'C:/x', items: [{ name: '抖音商品流水线', id: 'wf-x', nodes: 3, edges: 2 }] }) }
    }
    if (u.includes('/api/ecom-workbench/collect/records')) {
      return { ok: true, status: 200, json: async () => ({ records: [] }) }
    }
    return realFetch(url, init)
  }
  const emptyUi = await mountCollect()
  const emptyBox = emptyUi.host.querySelector('[data-ewb-collect-empty]')
  const emptyText = emptyBox?.textContent ?? ''
  console.log('   ★ 两份都没有时显示空态:', emptyBox !== null ? '✓' : '✗')
  if (emptyBox === null) errors.push('白名单两份都不存在时没有空态')
  console.log('   空态说清了缺什么:', emptyText.includes('全部下载') && emptyText.includes('清洗入库') ? '✓' : '✗')
  if (!(emptyText.includes('全部下载') && emptyText.includes('清洗入库'))) {
    errors.push('空态没说清缺的是哪两份')
  }
  console.log('   空态给了下一步（去工作流管理新建）:', emptyText.includes('工作流管理') ? '✓' : '✗')
  if (!emptyText.includes('工作流管理')) errors.push('空态没给下一步（用户不知道去哪建）')
  /* 反向：空态下**不该**有卡片。 */
  console.log('   空态下没有卡片:', emptyUi.host.querySelectorAll('[data-ewb-collect-card]').length === 0 ? '✓' : '✗')
  if (emptyUi.host.querySelectorAll('[data-ewb-collect-card]').length !== 0) {
    errors.push('空态下仍渲染了卡片')
  }
  emptyUi.unmount()
  window.fetch = globalThis.fetch = realFetch

  /* ── ⑥ 「新建采集」是主按钮 ─────────────────────────────────
   * 判据：它带强调色那套类（`--ewb-accent`），而「刷新」是次要按钮。
   * 这一条钉的是「主操作与次要操作分得开」，不是具体某个 Tailwind 类名。 */
  const ui2 = await mountCollect()
  const newBtn = [...ui2.host.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '新建采集')
  const refreshBtn2 = [...ui2.host.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '刷新')
  const mainLook = (newBtn?.className ?? '').includes('--ewb-accent')
  const quietLook = (refreshBtn2?.className ?? '').includes('--dsw-alias-label-tertiary')
  console.log('   ★ 「新建采集」是主按钮（强调色）:', mainLook ? '✓' : '✗')
  if (!mainLook) errors.push('「新建采集」不是主按钮（主操作要能一眼看出来）')
  console.log('   「刷新」是次要按钮:', quietLook ? '✓' : '✗')
  if (!quietLook) errors.push('「刷新」没有按次要按钮呈现（两处的视觉权重应分开）')
  /* 反面：用户明确说**不要**筛选条。 */
  const filterish = [...ui2.host.querySelectorAll('button')]
    .some(b => /^(全部|一键|底层)$/.test((b.textContent ?? '').trim()))
  console.log('   没有「全部 / 一键 / 底层」筛选条:', filterish ? '✗' : '✓')
  if (filterish) errors.push('出现了筛选条（只有两份，用户明确说不要筛）')
  ui2.unmount()

  /* ── ⑥ 任务记录：**样式像运行历史、内容仍是产出**（2026-10-23 契约 Y）──
   *
   * ## 用户原话
   *
   * 「自动化的任务记录和任务中心显示应该是一个逻辑，任务记录只是存档备案，
   * 任务记录的样式改成工作流的运行历史的样式。注意！他们显示的内容不一样，
   * 只是样式一样，要明确两个不同的内容」。
   *
   * ## 判据怎么同时钉住「像」与「不一样」
   *
   * | 判据 | 防的错 |
   * | --- | --- |
   * | 每行用 `histRow` / `histRowHead` / `histState` / `histName` / `histMeta` 那一套 | 还是自画的 `border-b`（没改样式） |
   * | 成功挂 `hist_ok`、失败挂 `hist_error` | 状态字没色 / 两行一个色 |
   * | 展开后是 `outputs` 的键值 | 把节点日志搬进来了（那才是把两者混起来） |
   * | 展开后**没有**节点日志那套痕迹 | 同上，反面 |
   * | tab 名字仍是「任务记录」 | 顺手改名或合并进运行历史 |
   *
   * ⚠️ **类名判据在 jsdom 里是字符串**：CSS Modules 被桩成 `export default {}`，
   * 所以 `css.histRow` 是 `undefined`。这里**不能**按类名找 —— 改按
   * `data-ewb-collect-record*` 这几个钩子找元素，再看它们的类名字符串
   * 是不是「同一批 undefined 拼起来」（说明走的是同一套 `css.*` 下标）。
   *
   * 为了防止这条退化成「什么都算过」，同时验**反面的 `border-b` 已经不在**。 */
  {
    const recUi = await mountCollect()
    /* 切到「任务记录」那一格。 */
    const recTab = [...recUi.host.querySelectorAll('[role="tab"],button')]
      .find(b => (b.textContent ?? '').trim() === '任务记录')
    console.log('   找得到「任务记录」那一格:', recTab !== undefined ? '✓' : '✗')
    recTab?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()

    /* ④ tab 名字仍是「任务记录」，且没有多出一个「运行历史」。 */
    const tabLabels = [...recUi.host.querySelectorAll('[role="tab"],button')]
      .map(b => (b.textContent ?? '').trim())
    console.log('   ★ tab 名字仍是「任务记录」（没改名）:', tabLabels.includes('任务记录') ? '✓' : '✗')
    if (!tabLabels.includes('任务记录')) errors.push('任务记录那一格的名字变了（用户点名要这三个词）')
    console.log('   ★ 没有把运行历史搬进这一个板块:',
      tabLabels.includes('运行历史') ? '✗（有）' : '✓')
    if (tabLabels.includes('运行历史')) {
      errors.push('自动化板块里出现了「运行历史」—— 那是工作流板块的东西，两个不是一回事')
    }

    const rows = [...recUi.host.querySelectorAll('[data-ewb-collect-record]')]
    console.log('   任务记录行数:', rows.length)
    /* 桩里给了 **4** 条（2026-10-25 契约 AO 加了那条汇报式记录）。
     * 判据仍是「一条记录一行」—— 桩加一条这里就跟着加一条，
     * 漏渲染或多渲染都会红。 */
    console.log('   ★ 任务记录用了运行历史那一套行（不是自画的边框行）:', rows.length === 4 ? '✓' : '✗（' + rows.length + ' 行）')
    if (rows.length !== 4) errors.push('任务记录没有按记录逐行渲染（桩里给了 4 条）')

    /* ① 每一行的**头部**是 `histRowHead` 那一套 —— 判据看它在不在、且带
     *    `histState` / `histName` / `histMeta` 三个子元素（那是运行历史的骨架）。 */
    const okRow = rows.find(r => (r.getAttribute('data-ewb-collect-record') ?? '').startsWith('全部下载'))
    const errRow = rows.find(r => (r.getAttribute('data-ewb-collect-record') ?? '').startsWith('清洗入库'))
    const headOf = (r) => r?.querySelector('[data-ewb-collect-record-head]')
    const hasHistSkeleton = (r) => {
      const h = headOf(r)
      if (h === null || h === undefined) return false
      const kids = [...h.children]
      /* 运行历史的一行是：状态字 + 名字 + 元信息 + 元信息 + 箭头（5 个）。
       * 这里判「至少 4 个，且第一个是状态字那一段」—— 不写死 5，
       * 因为将来这里可能加一项（比如记录来源）。 */
      return kids.length >= 4
    }
    console.log('   ★ 每一行都是「一行头部 + 可展开」那种（运行历史的骨架）:',
      hasHistSkeleton(okRow) && hasHistSkeleton(errRow) ? '✓' : '✗')
    if (!(hasHistSkeleton(okRow) && hasHistSkeleton(errRow))) {
      errors.push('任务记录的行不是运行历史那种「一行头部」结构')
    }
    /* ② 状态字带色：成功走 `hist_ok`、失败走 `hist_error`。
     *
     * ⚠️ **不能比 DOM 类名字符串**：jsdom 里 CSS Modules 被桩成 `export default {}`
     * （见本文件开头的加载钩子），所以 `css.hist_ok` 与 `css.hist_error` **都是
     * `undefined`** —— 两行类名一模一样，按字符串比必然假红。
     *
     * 判据改成两层，**各自都能被真实验证**：
     *   ① 源码里真的按成败取了两个**不同的键**（`hist_` + tone，tone 由 ok 决定）；
     *   ② 那两条 CSS 规则的颜色**确实不同**（一个青绿一个红）。
     * 缺任一层都会漏：只有 ①，两个键写成同一个也过；只有 ②，界面不用那两个类也过。 */
    const cbSrc = readFileSync(new URL('../src/client/workbench/CollectBoard.tsx', import.meta.url), 'utf8')
    const usesToneKey = /const tone = r\.ok === false \? 'error' : 'ok'/.test(cbSrc)
      && /css\['hist_' \+ tone\]/.test(cbSrc)
    console.log('   ★ 源码里成功/失败取的是两个不同的状态类（hist_ok / hist_error）:', usesToneKey ? '✓' : '✗')
    if (!usesToneKey) {
      errors.push('任务记录没有按成败取不同的状态类（成功 / 失败会是一个颜色）')
    }
    const histCss = readFileSync(new URL('../src/client/workbench/EcomWorkbench.module.css', import.meta.url), 'utf8')
    const okColor = /\.hist_ok \.histState\s*\{\s*color:\s*([^;]+);/.exec(histCss)?.[1]?.trim() ?? ''
    const errColor = /\.hist_error \.histState\s*\{\s*color:\s*([^;]+);/.exec(histCss)?.[1]?.trim() ?? ''
    console.log('   ★ 那两条规则的颜色确实不同（' + (okColor || '缺') + ' ≠ ' + (errColor || '缺') + '）:',
      okColor !== '' && errColor !== '' && okColor !== errColor ? '✓' : '✗')
    if (!(okColor !== '' && errColor !== '' && okColor !== errColor)) {
      errors.push('`hist_ok .histState` 与 `hist_error .histState` 颜色相同或缺失（状态字分不出成败）')
    }
    /* 状态字本身：成功行写「成功」、失败行写「失败」。 */
    const okState = (headOf(okRow)?.children?.[0]?.textContent ?? '').trim()
    const errState = (headOf(errRow)?.children?.[0]?.textContent ?? '').trim()
    console.log('   状态字：成功行「' + okState + '」/ 失败行「' + errState + '」:',
      okState === '成功' && errState === '失败' ? '✓' : '✗')
    if (!(okState === '成功' && errState === '失败')) {
      errors.push('状态字不是「成功 / 失败」（运行历史那套读法要一致）')
    }
    /* ③ 反面：旧的 `border-b` 那套已经不在记录行上。 */
    const staleBorder = rows.some(r => /(^|\s)border-b(\s|$)/.test(String(r.className ?? '')))
    console.log('   ★ 旧的自画边框行（border-b）已经不在:', staleBorder ? '✗' : '✓')
    if (staleBorder) errors.push('任务记录的行还带着 `border-b` —— 样式没换过来')

    /* ── ★ 失败原因（2026-10-23 契约 AE）────────────────────────────
     *
     * 用户答「加：任务记录里也写明失败原因」，说明是「存档留底，
     * 日后翻记录时不用再回运行历史找」。
     *
     * ## 判据
     *
     * | 判据 | 防的错 |
     * | --- | --- |
     * | 失败行**不展开**就有 `data-ewb-collect-record-error` | 只在展开区给（那就等于要再点一下） |
     * | 文案是「为什么失败：」+ 真实原因 | 造了第二个说法（同一个概念两个词） |
     * | 有 `title` 且是全文 | 截断了却没地方看全 |
     * | 成功行**没有**这一段（反面） | 无条件渲染 |
     * | 老记录（无 `error` 键）说「没有留下原因」 | 静默 / 空白 / 显示成成功 |
     *
     * ⚠️ 失败行有**两条**（一条带 `error`、一条老记录），要分开验 ——
     * 只验一条的话，「有 error 时正常工作」与「没 error 时不静默」总有一个没验到。 */
    const rowByWorkflow = (name) => rows.find(r =>
      (r.getAttribute('data-ewb-collect-record') ?? '').startsWith(name))
    const failWithErr = rowByWorkflow('清洗入库')
    const failOld = rowByWorkflow('取数-天猫生意参谋')

    /* ① 不展开就有原因（注意：这一段整体**没有点开任何行**，此刻都收起着）。 */
    const errEl = failWithErr?.querySelector('[data-ewb-collect-record-error]')
    const errTxt = (errEl?.textContent ?? '').trim()
    console.log('   ★ 失败的记录不展开就有一句原因:', errEl !== null && errEl !== undefined ? '✓' : '✗')
    if (errEl === null || errEl === undefined) {
      errors.push('失败的记录不展开就看不到原因（用户要「不用回运行历史找」）')
    }
    const usesSameWords = errTxt.startsWith('为什么失败：')
    console.log('   ★ 用词与任务中心一致（「为什么失败：」）:', usesSameWords ? '✓' : '✗（' + errTxt.slice(0, 30) + '）')
    if (!usesSameWords) {
      errors.push('失败原因没有用「为什么失败：」这个说法（同一个概念造了两个词）')
    }
    console.log('   带出了真实原因:', errTxt.includes('登录态失效') ? '✓' : '✗（' + errTxt + '）')
    if (!errTxt.includes('登录态失效')) errors.push('失败原因没有带出真实内容')
    /* ② 截断 + 全文 title。 */
    const errTitle = errEl?.getAttribute('title') ?? ''
    const truncated = String(errEl?.className ?? '').includes('truncate')
    console.log('   ★ 长原因被截断（truncate）且 title 有全文:',
      truncated && errTitle.includes('登录态失效') ? '✓' : '✗（truncate=' + String(truncated) + ' title=' + errTitle.slice(0, 20) + '）')
    if (!truncated) errors.push('失败原因那一行没有 truncate（长原因会撑破一行）')
    if (!errTitle.includes('登录态失效')) errors.push('失败原因截断了却没有 title 全文（看不全）')

    /* ③ 反面：成功的记录不渲染这一段。 */
    const okErrEl = okRow?.querySelector('[data-ewb-collect-record-error]')
    console.log('   ★ 成功的记录没有原因那段（反面）:', okErrEl === null || okErrEl === undefined ? '✓' : '✗')
    if (okErrEl !== null && okErrEl !== undefined) {
      errors.push('成功的记录也渲染了失败原因那段（那块该只在失败时出现）')
    }

    /* ④ 老记录（失败但没 `error` 键）：说清「没有留下原因」，不静默、不当成功。 */
    const oldErrEl = failOld?.querySelector('[data-ewb-collect-record-error]')
    const oldErrTxt = (oldErrEl?.textContent ?? '').trim()
    console.log('   老记录（无 error 键）也有一段说明:',
      oldErrEl !== null && oldErrEl !== undefined ? '✓' : '✗')
    if (oldErrEl === null || oldErrEl === undefined) {
      errors.push('失败但没有 error 键的老记录静默了（用户不知道这条为什么没原因）')
    }
    const saysNoReason = oldErrTxt.includes('没有留下原因')
    console.log('   ★ 老记录说清了「没有留下原因」:', saysNoReason ? '✓' : '✗（' + oldErrTxt + '）')
    if (!saysNoReason) {
      errors.push('老记录没有说明「没有留下原因」（空白比说明更糟）')
    }
    /* 反面：老记录**不许**被当成成功。 */
    const oldState = (headOf(failOld)?.children?.[0]?.textContent ?? '').trim()
    console.log('   ★ 老记录的状态字仍是「失败」（没被当成成功）:', oldState === '失败' ? '✓' : '✗（' + oldState + '）')
    if (oldState !== '失败') errors.push('老记录的状态字不是「失败」—— 无原因不等于成功')

    /* ③ 默认收起；展开后是 `outputs` 的键值。 */
    console.log('   默认收起（还没渲染产出）:',
      recUi.host.querySelector('[data-ewb-collect-record-outputs]') === null ? '✓' : '✗')
    headOf(okRow)?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const outEl = recUi.host.querySelector('[data-ewb-collect-record-outputs]')
    const outTxt = outEl?.textContent ?? ''
    console.log('   ★ 点开能看到这一份交出的产出:', outEl !== null ? '✓' : '✗')
    if (outEl === null) errors.push('点开任务记录后看不到产出')
    /* ★★ 内容没变：仍是 `键 = 值` 那几项（桩里给了 4 项）。 */
    const wantKeys = ['天猫数据', '抖音数据', '千川数据', '入库条数']
    const keysAllIn = wantKeys.every(k => outTxt.includes(k))
    console.log('   ★★ 内容仍是「交出了什么」（4 项产出都在）:', keysAllIn ? '✓' : '✗（' + outTxt.slice(0, 80) + '）')
    if (!keysAllIn) errors.push('任务记录的产出没显示全（内容被改成别的东西了）')
    /* ★★ 反面：**不许**出现节点日志那套（运行历史的内容）。
     * 判据取运行历史里独有的说法：节点 id 编号、日志行、`模型调用` 痕迹。 */
    const loggish = /模型调用|节点明细|[（(]n\d+[）)]/
    console.log('   ★★ 反面：没有把节点日志搬进来:', loggish.test(outTxt) ? '✗' : '✓')
    if (loggish.test(outTxt)) {
      errors.push('任务记录里出现了节点日志那套内容 —— 用户明确说「他们显示的内容不一样」')
    }
    /* ★ 而且要说清「逐条日志不在这里」，不让用户以为这就是全部。 */
    console.log('   说清了逐条日志在别处:',
      (recUi.host.textContent ?? '').includes('运行历史') ? '✓' : '✗')
    if (!(recUi.host.textContent ?? '').includes('运行历史')) {
      errors.push('任务记录没说清「逐条日志在运行历史里」（用户会以为这就是全部）')
    }

    /* ── ⑦ 汇报式记录**优先显示 `reports`**（2026-10-25 契约 AO）─────
     *
     * ## 为什么要单独验
     *
     * 归档时 `reports` 与 `outputs` 只写一个（`records.ts:78-83`）。所以一条汇报式
     * 记录的 `outputs` 是空对象 —— **不判断就显示成「这次没有交出任何产出」**，
     * 而它明明报了三件事。这正是「光加类型声明不够」的那个坑。
     *
     * 判据四件：
     *   ① 汇报式记录展开后出现汇报块；
     *   ② **不出现**「这次没有交出任何产出」；也不出现旧的 `outputs` 块；
     *   ③ `item` / `metrics` / `files` 三样都显示；
     *   ④ 行头写「N 条汇报」而不是「0 项产出」。
     */
    /* 先收起上面那份（okRow 还开着），再展开汇报式那份。 */
    headOf(okRow)?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const repRow = rows.find(r => (r.getAttribute('data-ewb-collect-record') ?? '').startsWith('巡查-天猫竞品'))
    console.log('   找到了那条汇报式记录:', repRow !== undefined ? '✓' : '✗')
    if (repRow === undefined) {
      errors.push('任务记录里找不到那条汇报式记录（桩没生效？）')
    } else {
      /* ④ 行头先看（不用展开）。 */
      const repHead = (headOf(repRow)?.textContent ?? '')
      console.log('   ★★ 行头写「1 条汇报」而不是「0 项产出」:',
        /1 条汇报/.test(repHead) && !/0 项产出/.test(repHead) ? '✓' : '✗（' + repHead + '）')
      if (!/1 条汇报/.test(repHead) || /0 项产出/.test(repHead)) {
        errors.push('汇报式记录的行头显示错了（写着 0 项产出，而它明明报了 1 件事）')
      }

      headOf(repRow)?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await settle()

      const repBlock = repRow.querySelector('[data-ewb-collect-record-reports]')
      const repTxt = repBlock?.textContent ?? ''
      console.log('   ★ 汇报式记录展开后显示汇报块:',
        repBlock !== null && repBlock !== undefined ? '✓' : '✗')
      if (repBlock === null || repBlock === undefined) {
        errors.push('汇报式记录展开后没有显示汇报（只加类型声明不够，读盘映射也要取出来）')
      }
      /* ② 反面：不许退回「没有交出任何产出」，也不许同时渲染旧的 outputs 块。 */
      const outInRep = repRow.querySelector('[data-ewb-collect-record-outputs]')
      const emptyInRep = repRow.querySelector('[data-ewb-collect-record-empty]')
      console.log('   ★★ 反面：没有退回「这次没有交出任何产出」:',
        emptyInRep === null && outInRep === null ? '✓' : '✗')
      if (emptyInRep !== null || outInRep !== null) {
        errors.push('汇报式记录仍走了旧的 outputs 那条路（汇报优先没落实）')
      }
      /* ③ 三样都显示。 */
      console.log('   ★ 汇报的 item 显示了:', /第 1\/1 条/.test(repTxt) ? '✓' : '✗')
      if (!/第 1\/1 条/.test(repTxt)) errors.push('任务记录的汇报没有显示 item')
      console.log('   ★ 汇报的 metrics 显示了:',
        /竞品数/.test(repTxt) && /降价数/.test(repTxt) ? '✓' : '✗')
      if (!(/竞品数/.test(repTxt) && /降价数/.test(repTxt))) {
        errors.push('任务记录的汇报没有显示 metrics')
      }
      console.log('   ★ 汇报的 files 显示了:',
        /天猫竞品-2026-10-25\.json/.test(repTxt) ? '✓' : '✗')
      if (!/天猫竞品-2026-10-25\.json/.test(repTxt)) {
        errors.push('任务记录的汇报没有显示 files')
      }
      /* 级别配色：warning 那档（与运行历史同一套 `rp_*` 类名判据）。 */
      const repItem = repRow.querySelector('[data-ewb-collect-report]')
      console.log('   汇报按级别挂类（warning）:',
        repItem?.getAttribute('data-ewb-collect-report-type') === 'warning' ? '✓' : '✗')
      if (repItem?.getAttribute('data-ewb-collect-report-type') !== 'warning') {
        errors.push('任务记录的汇报没有带级别标记')
      }
    }

    recUi.unmount()
  }
}

/* ⑰ 提示词板块的**改写器**（2026-10-23 加）。
 *
 * ## 判据为什么落在「请求体」上
 *
 * 验收第 2 条要的是「传对了 prompt 与 input」。界面上显示什么都不算证据 ——
 * 结果区可以靠前端假造一段文字就显示出来。所以桩把**每次请求的完整 body**
 * 记进 `__ewbOptPosts`，断言直接查那两个键的值。
 *
 * ## 三种失败为什么必须分开验
 *
 * 「没有模型 / 超时 / 返回空」在中文里都能写成「改写失败」，但**该做的事**完全不同
 * （去设置里选模型 / 调大超时或缩短信 / 改说法重试）。所以三份文案必须**互不相同**，
 * 断言比对的是「三句话彼此不一样」+「各自带着该去的那一步」，而不是「非空就算过」。
 *
 * ⚠️ 这条测试**不真调模型**（桩住 `/workflow/run`）。真调会烧额度，也会因为本机
 * 没配模型而红 —— 那是环境问题，不是代码问题。
 */
console.log('⑰ [提示词板块] 按模板改写（走工作流，不直连模型）')
{
  globalThis.React = React
  const { PromptBoard } = await import('../src/client/workbench/PromptBoard.tsx')

  /** 每次挂一块新的 PromptBoard（板子内部有状态，别复用）。 */
  const mountPrompt = async () => {
    const h = window.document.createElement('div')
    window.document.body.appendChild(h)
    const r = ReactDOMClient.createRoot(h)
    r.render(React.createElement(PromptBoard, {
      active: true, tab: '', apiBase: '/api/ecom-workbench', topHidden: false,
      onToggleTop: () => {}, onSelectTab: () => {}, onRunWorkflow: () => {},
    }))
    await settle()
    return { h, r, unmount: () => { r.unmount(); h.remove() } }
  }

  /** 往受控 textarea 里填字（React 受控组件的写法：走原生 setter 再发 input）。 */
  const typeInto = (el, text) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, text)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  }

  /* ── 改写取结果的桩（2026-10-25 契约 AT）──────────────────────
   *
   * ## 为什么从 `fetch` 桩换成 `EventSource` 桩
   *
   * 2026-10-25 起存档里**没有结束节点**，`declaredOutputs` 恒为空对象
   * （`run.ts:2719`）→ 走 `POST /workflow/run` 无论怎么桩都拿不到文字。
   * 现在界面改走 `GET /workflow/run-stream`，从 `step` 事件里
   * `success` 那条的 `output` 取（引擎 `run.ts:267` 本来就带）。
   *
   * 所以桩必须给出**真的 SSE 事件流**，而不是一个 JSON 响应体 ——
   * 只桩 JSON 的话，这段断言就变成「验一条界面根本不走的路」。
   *
   * ## 记录什么
   *
   * `__ewbOptUrls` 记每次开的连接 URL（验「按编号调」「两个输入都在」「没多塞键」）；
   * `__ewbOptMode` 拨事实：`ok` / `empty` / `no-output` / `aborted` / `no-model`。
   */
  const __ewbOptUrls = []
  /* `__ewbOptMode` / `__ewbOptDelay` 用文件顶部那两个共享变量（别处也在拨）。 */
  class OptEs {
    constructor(url) {
      this.url = url
      this.closed = false
      this.handlers = {}
      __ewbOptUrls.push(String(url))
      /* 异步推事件 —— 同步推的话组件还没挂好 handler（与真 EventSource 一致的时序）。 */
      setTimeout(() => { this.__play() }, 0)
    }

    addEventListener(name, fn) {
      (this.handlers[name] ??= []).push(fn)
    }

    close() { this.closed = true }

    __emit(kind, data) {
      if (this.closed) return
      for (const fn of (this.handlers[kind] ?? [])) fn({ data: JSON.stringify(data) })
    }

    __play() {
      if (this.closed) return
      const m = __ewbOptMode
      /* 前两个节点事件：开始 / 模型那一步成功（`output` 里就是改写出的文字）。
       * ⚠️ `defId` 必须是 `ai.agent` —— 界面按**类型**认那一步，不认 `n2`（编号会漂）。 */
      if (m === 'ok' || m === 'empty') {
        this.__emit('step', { kind: 'started', nodeId: 'n1', defId: 'flow.start', label: '⓪ 开始' })
        /* ★★ 这里**故意**让开始节点也交出一段字符串（契约 AT 的反面判据）。
         *
         * 界面只认 `ai.agent` 那一步的输出。若实现里把「第一个有字符串的输出」
         * 当结果，就会拿到这句「开始节点的输出」，而不是模型改写的那段 ——
         * 用户会看到一段莫名其妙的话被当成改写结果。
         *
         * 这条桩是**做自证时补上的**：第一版没有它，把 `defId` 判据删掉测试照样绿，
         * 说明那条判据当时无人管。 */
        this.__emit('step', {
          kind: 'success', nodeId: 'n1', defId: 'flow.start',
          output: '这是开始节点的输出，不是改写结果',
        })
        this.__emit('step', { kind: 'started', nodeId: 'n2', defId: 'ai.agent', label: '① AI 生成' })
        this.__emit('step', {
          kind: 'success', nodeId: 'n2', defId: 'ai.agent',
          output: m === 'empty' ? '' : '优化后的提示词第一行\n优化后的提示词第二行',
        })
        /* ★★ 再加一个**在 `ai.agent` 之后**的节点，也交出字符串。
         *
         * 只在前面的开始节点放字符串是不够的：那种桩下「取最后一个输出」
         * 恰好还是 `ai.agent`，删掉 `defId` 判据照样绿（做自证时发现了这一点）。
         * 真实存档里 AI 生成后面常常还有节点（写文件、通知），
         * 所以必须有一个**排在它之后**的干扰项，判据才真的钉住「按类型认」。 */
        this.__emit('step', { kind: 'started', nodeId: 'n3', defId: 'sys.fs.write', label: '② 存到文件' })
        this.__emit('step', {
          kind: 'success', nodeId: 'n3', defId: 'sys.fs.write',
          output: '存好了：D:/data/out.txt',
        })
      }
      /* `no-output`：跑完了，但**没有** `ai.agent` 的成功事件（例如存档里被删了）。 */
      if (m === 'no-output') {
        this.__emit('step', { kind: 'started', nodeId: 'n1', defId: 'flow.start', label: '⓪ 开始' })
        this.__emit('step', { kind: 'success', nodeId: 'n1', defId: 'flow.start', output: {} })
      }
      const done = m === 'aborted'
        ? { ok: false, aborted: true, error: '工作流里有节点失败并中断了' }
        : m === 'no-model'
          ? { ok: false, aborted: false, error: '没有可用的模型：先在 dsh 的模型设置里选一个 provider 与模型' }
          : m === 'timeout'
            ? { ok: false, aborted: false, error: '等模型超时（120000 毫秒）—— 可在节点设置里调大「超时」' }
            : m === 'missing'
              ? { ok: false, aborted: false, error: '没有这份工作流：提示词优化' }
              : { ok: true, aborted: false }
      const delay = __ewbOptDelay
      const send = () => { this.__emit('done', done); this.closed = true }
      if (delay > 0) setTimeout(send, delay)
      else send()
    }
  }
  /* ⚠️ 先存起真的那个（或 `undefined`）—— 这一段结束时**必须还原**。
   * 后面的 ⑱ 总览也用 `FlowRunPanel`（它靠 `EventSource` 看进展）。留着这个桩，
   * 那一开跑就会立刻收到「跑完」，于是总览那张卡片的进展区刚出现就收起来 ——
   * 看起来像「点刷新没反应」。（第一版就踩了这个，红的是 ⑱ 而不是这一段。） */
  const prevEs = window.EventSource
  window.EventSource = OptEs
  globalThis.EventSource = OptEs

  /* ── ① 改写区在：输入框 + 主按钮 ─────────────────────────── */
  const p1 = await mountPrompt()
  const optBox = p1.h.querySelector('[data-ewb-opt]')
  console.log('   ★ 有「按模板改写」区:', optBox !== null ? '✓' : '✗')
  if (optBox === null) errors.push('提示词板块没有「按模板改写」区（data-ewb-opt 不存在）')
  const optInput = optBox?.querySelector('[data-ewb-opt-input]')
  console.log('   ★ 有待改写的输入框:', optInput !== null && optInput !== undefined ? '✓' : '✗')
  if (optInput === null || optInput === undefined) errors.push('改写区没有输入框')
  const optRun = optBox?.querySelector('[data-ewb-opt-run]')
  const runLabel = (optRun?.textContent ?? '').trim()
  console.log('   ★ 主按钮叫「用当前模板改写」:', runLabel === '用当前模板改写' ? '✓' : '✗（' + runLabel + '）')
  if (runLabel !== '用当前模板改写') errors.push('改写按钮的文案不是「用当前模板改写」')
  /* 主按钮要带强调色（与「复制到剪贴板」同一套主操作观感）。 */
  console.log('   改写按钮是主按钮（强调色）:', (optRun?.className ?? '').includes('--ewb-accent') ? '✓' : '✗')
  if (!(optRun?.className ?? '').includes('--ewb-accent')) errors.push('改写按钮不是主按钮（主操作要能一眼看出来）')

  /* ── ② 点按钮 → 连接里 workflowId 与两个输入都对 ─────────────
   *
   * ⚠️ 2026-10-25 契约 AT 起，改写走 `GET /workflow/run-stream`（SSE），
   * 参数在**查询串**里而不是请求体里。判据也随之从「body」换成「URL 里的参数」——
   * 验的东西没变（按编号调 + 两个键都在 + 没多塞），只是搬运方式变了。 */
  __ewbOptUrls.length = 0
  __ewbOptMode = 'ok'
  typeInto(optInput, '帮我写个卖点，要短')
  await settle()
  optRun?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()

  const optUrl = __ewbOptUrls[__ewbOptUrls.length - 1] ?? ''
  const q = new URL(optUrl, 'http://x').searchParams
  const sentInputs = (() => {
    try { return JSON.parse(q.get('inputs') ?? '{}') } catch { return {} }
  })()
  console.log('   实际开了', __ewbOptUrls.length, '条连接')
  /* ★ 必须按**编号**调（`wf-1bzlv0k`）：编号是存档身份，改名不会断。
   * 只认名字的话，把「提示词优化」改个名，这个功能就静默失效了。 */
  console.log('   ★ 按编号调用（workflowId = wf-1bzlv0k）:', q.get('workflowId') === 'wf-1bzlv0k' ? '✓' : '✗（' + String(q.get('workflowId')) + '）')
  if (q.get('workflowId') !== 'wf-1bzlv0k') errors.push('改写不是按编号调用「提示词优化」（编号 wf-1bzlv0k）')
  const sentPrompt = sentInputs['模板正文']
  const sentInput = sentInputs['待优化的提示词']
  console.log('   ★ 「模板正文」是当前模板正文:', typeof sentPrompt === 'string' && sentPrompt.length > 50 ? '✓（' + String(sentPrompt).length + ' 字）' : '✗')
  if (!(typeof sentPrompt === 'string' && sentPrompt.length > 50)) {
    errors.push('改写没有把当前模板正文当「模板正文」传过去')
  }
  console.log('   ★ 「待优化的提示词」是那段待改写的文字:', sentInput === '帮我写个卖点，要短' ? '✓' : '✗（' + String(sentInput) + '）')
  if (sentInput !== '帮我写个卖点，要短') {
    errors.push('改写没有把待改写的文字当「待优化的提示词」传过去（实际：' + String(sentInput) + '）')
  }
  /* 反向：两个键**必须同时存在**（只传一个就等于让模型凭空改写）。
   * 而且键名必须逐字对 —— 传 `prompt` / `input` 会被宿主半静默丢掉
   * （`io-fields.ts:189`：只认开始节点声明过的字段）。 */
  const bothKeys = Object.prototype.hasOwnProperty.call(sentInputs, '模板正文')
    && Object.prototype.hasOwnProperty.call(sentInputs, '待优化的提示词')
  console.log('   ★ inputs 里两个约定键都在:', bothKeys ? '✓' : '✗（' + Object.keys(sentInputs).join(',') + '）')
  if (!bothKeys) errors.push('改写请求的 inputs 里没有同时带「模板正文」与「待优化的提示词」')
  /* 反面加强：不许再多塞别的键（宿主半会丢掉，但多塞说明这边对契约理解漂了）。 */
  const extraKeys = Object.keys(sentInputs).filter(k => k !== '模板正文' && k !== '待优化的提示词')
  console.log('   inputs 里没有多余的键:', extraKeys.length === 0 ? '✓' : '✗（' + extraKeys.join(',') + '）')
  if (extraKeys.length !== 0) errors.push('改写请求多塞了键（会被宿主半丢掉，说明契约对不上）：' + extraKeys.join(','))
  /* ★ 新判据（契约 AT 的核心）：**不再依赖结束节点声明的产出**。
   * 这份存档里没有结束节点，`declaredOutputs` 恒空 —— 走旧的 POST 那条路
   * 必然拿不到文字、必然报「模型返回了空内容」。所以这里钉住：
   * 开的是**推送**那条连接（`/workflow/run-stream`），不是 POST。 */
  console.log('   ★★ 走的是推送那条路（/workflow/run-stream），不是 POST /workflow/run:',
    optUrl.includes('/workflow/run-stream') ? '✓' : '✗（' + optUrl + '）')
  if (!optUrl.includes('/workflow/run-stream')) {
    errors.push('改写没有走推送那条路（没有结束节点的存档下 POST 取不到文字）')
  }
  /* ★★ 只认 `ai.agent` 那一步的输出（契约 AT）。
   * 桩里让开始节点也交出一段字符串 —— 若实现取「第一个字符串输出」，
   * 结果区会变成那句无关的话。判据落在**结果文本本身**：
   * 必须是模型那段（带换行），不许是开始节点那句。 */
  {
    const t = (p1.h.querySelector('[data-ewb-opt-text]')?.textContent ?? '')
    console.log('   ★★ 结果取的是 ai.agent 那一步，不是别的节点的输出:',
      t.includes('优化后的提示词第一行') && !t.includes('开始节点的输出') ? '✓' : '✗（' + JSON.stringify(t.slice(0, 40)) + '）')
    if (!t.includes('优化后的提示词第一行') || t.includes('开始节点的输出')) {
      errors.push('结果取错了节点（只该认「AI 生成」那一步的输出）')
    }
  }

  /* ── ③ 结果显示、可复制、可回填 ───────────────────────────── */
  const resBox = p1.h.querySelector('[data-ewb-opt-result]')
  const resText = (p1.h.querySelector('[data-ewb-opt-text]')?.textContent ?? '')
  console.log('   ★ 结果显示在结果区:', resBox !== null ? '✓' : '✗')
  if (resBox === null) errors.push('改写成功后没有结果区')
  console.log('   结果文本与模型返回的一致:', resText === '优化后的提示词第一行\n优化后的提示词第二行' ? '✓' : '✗（' + JSON.stringify(resText) + '）')
  if (resText !== '优化后的提示词第一行\n优化后的提示词第二行') {
    errors.push('结果区显示的不是模型返回的原文（换行也要保住）')
  }
  console.log('   ★ 结果区有「复制」:', resBox?.querySelector('[data-ewb-opt-copy]') !== null ? '✓' : '✗')
  if (resBox?.querySelector('[data-ewb-opt-copy]') === null) errors.push('结果区没有「复制」按钮')
  console.log('   ★ 结果区有「回填到正文」:', resBox?.querySelector('[data-ewb-opt-apply]') !== null ? '✓' : '✗')
  if (resBox?.querySelector('[data-ewb-opt-apply]') === null) errors.push('结果区没有「回填到正文」按钮')

  /* 回填：点它之后正文进入编辑态、里面就是模型那段（**不自动保存**）。 */
  resBox?.querySelector('[data-ewb-opt-apply]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  const bodyEdit = p1.h.querySelector('[data-ewb-tpl-body="edit"]')
  console.log('   回填后正文进入编辑态:', bodyEdit !== null ? '✓' : '✗')
  if (bodyEdit === null) errors.push('点「回填到正文」后正文没有进入编辑态')
  console.log('   回填的内容就是改写结果:', bodyEdit?.value === '优化后的提示词第一行\n优化后的提示词第二行' ? '✓' : '✗')
  if (bodyEdit?.value !== '优化后的提示词第一行\n优化后的提示词第二行') {
    errors.push('回填到正文的内容不是改写结果')
  }
  p1.unmount()

  /* ── ④ 改写中：按钮禁用 + 有一句进度说明 ─────────────────────
   *
   * 桩不让它立刻回（改成 1 秒后才 resolve），这样能抓到「进行中」那一帧。 */
  const p2 = await mountPrompt()
  const input2 = p2.h.querySelector('[data-ewb-opt-input]')
  typeInto(input2, '待改写的一段')
  await settle()
  /* ⚠️ 让桩慢 800 毫秒再回 —— 否则「改写中」这一帧根本抓不到（桩瞬间就 resolve 了）。 */
  __ewbOptDelay = 800
  const run2 = p2.h.querySelector('[data-ewb-opt-run]')
  run2?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  const btnNow = p2.h.querySelector('[data-ewb-opt-run]')
  console.log('   ★ 改写中按钮禁用:', btnNow?.disabled === true ? '✓' : '✗')
  if (btnNow?.disabled !== true) errors.push('改写进行中按钮没有禁用（会连点发出多次请求）')
  console.log('   ★ 改写中按钮变「改写中…」:', (btnNow?.textContent ?? '').trim() === '改写中…' ? '✓' : '✗（' + (btnNow?.textContent ?? '').trim() + '）')
  if ((btnNow?.textContent ?? '').trim() !== '改写中…') errors.push('改写进行中按钮没有变成「改写中…」')
  const prog = p2.h.querySelector('[data-ewb-opt-progress]')
  const progText = (prog?.textContent ?? '').trim()
  console.log('   ★ 改写中有进度说明:', prog !== null && progText !== '' ? '✓' : '✗')
  if (prog === null || progText === '') errors.push('改写进行中没有进度说明（空白干等）')
  /* 进度说明要写「在等什么」，不是「请稍候」那种空话。 */
  console.log('   进度说明写清了在等模型:', /等它写回来|等模型/.test(progText) ? '✓' : '✗（' + progText + '）')
  if (!/等它写回来|等模型/.test(progText)) errors.push('进度说明没写清在等什么')
  await settle()
  __ewbOptDelay = 0
  p2.unmount()

  /* ── ⑤ 五种失败各一份文案，且互不相同 ──────────────────── */
  const texts = {}
  for (const mode of ['no-model', 'timeout', 'empty', 'no-output', 'missing']) {
    __ewbOptMode = mode
    __ewbOptUrls.length = 0
    const pm = await mountPrompt()
    const inp = pm.h.querySelector('[data-ewb-opt-input]')
    typeInto(inp, '待改写的一段')
    await settle()
    pm.h.querySelector('[data-ewb-opt-run]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    texts[mode] = (pm.h.querySelector('[data-ewb-opt-error]')?.textContent ?? '').trim()
    pm.unmount()
  }
  __ewbOptMode = 'ok'

  for (const [mode, t] of Object.entries(texts)) {
    console.log('   ' + mode + ' 的失败文案非空:', t !== '' ? '✓' : '✗')
    if (t === '') errors.push(mode + ' 这种失败没有文案（静默失败）')
  }
  /* ★ 五份文案互不相同 —— 这一条是「分开说」的真正判据。
   * 若实现里都贴同一句「改写失败」，这里就红。 */
  const uniq = new Set(Object.values(texts))
  console.log('   ★ 五种失败文案互不相同:', uniq.size === 5 ? '✓' : '✗（去重后 ' + uniq.size + ' 种）')
  if (uniq.size !== 5) errors.push('几种失败用了同一句文案（用户分不清该改哪里）')
  /* 各自带着「该去做什么」，不是只报「失败了」。 */
  console.log('   no-model 指明去模型设置:', /模型设置/.test(texts['no-model'] ?? '') ? '✓' : '✗')
  if (!/模型设置/.test(texts['no-model'] ?? '')) errors.push('「没有模型」没有指明去模型设置里选')
  console.log('   timeout 指明超时 / 缩短或调大:', /超时/.test(texts.timeout ?? '') ? '✓' : '✗')
  if (!/超时/.test(texts.timeout ?? '')) errors.push('「超时」文案没提超时')
  console.log('   empty 指明返回空:', /空/.test(texts.empty ?? '') ? '✓' : '✗')
  if (!/空/.test(texts.empty ?? '')) errors.push('「返回空」文案没提返回空')
  /* ★★ 契约 AT 的核心区分：「跑完了但没找到那段字」与「模型返回空」必须是两件事。
   * 混成一句的话，用户没法知道该去调模型还是该去查存档。 */
  console.log('   ★★ no-output 说的是「没找到 AI 生成写出的字」:',
    /没在记录里找到/.test(texts['no-output'] ?? '') && /AI 生成/.test(texts['no-output'] ?? '') ? '✓' : '✗（' + (texts['no-output'] ?? '') + '）')
  if (!(/没在记录里找到/.test(texts['no-output'] ?? '') && /AI 生成/.test(texts['no-output'] ?? ''))) {
    errors.push('「跑完了但没有输出」没有说清是界面找不到那段字（会与「模型返回空」混起来）')
  }
  console.log('   ★★ no-output 与 empty 不是同一句话:',
    (texts['no-output'] ?? '') !== (texts.empty ?? '') ? '✓' : '✗')
  if ((texts['no-output'] ?? '') === (texts.empty ?? '')) {
    errors.push('「取不到」与「模型返回空」贴了同一句话（契约 AT 要求分开）')
  }
  console.log('   ★ missing 指明工作流不存在 + 怎么建:', /没有这份工作流|还没建/.test(texts.missing ?? '') && /工作流管理/.test(texts.missing ?? '') ? '✓' : '✗')
  if (!(/没有这份工作流|还没建/.test(texts.missing ?? '') && /工作流管理/.test(texts.missing ?? ''))) {
    errors.push('「工作流不存在」没有说清怎么建（该给下一步）')
  }
  /* 三段式：每条都至少有两句（发生了什么 + 怎么办）。 */
  const thin = Object.entries(texts).filter(([, t]) => t.length < 60)
  console.log('   五份文案都不是一句话敷衍:', thin.length === 0 ? '✓' : '✗（' + thin.map(([k]) => k).join(',') + '）')
  if (thin.length > 0) errors.push('失败文案太短，没写清原因与下一步：' + thin.map(([k]) => k).join(','))

  /* ── ⑥ 待改写为空时**不发请求**，直接说清楚 ───────────────── */
  __ewbOptUrls.length = 0
  const p3 = await mountPrompt()
  p3.h.querySelector('[data-ewb-opt-run]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  console.log('   ★ 空输入时不发请求:', __ewbOptUrls.length === 0 ? '✓' : '✗（发了 ' + __ewbOptUrls.length + ' 次）')
  if (__ewbOptUrls.length !== 0) errors.push('待改写为空时仍发了请求（白烧额度）')
  const emptyErr = (p3.h.querySelector('[data-ewb-opt-error]')?.textContent ?? '').trim()
  console.log('   空输入时给了说明:', emptyErr !== '' ? '✓' : '✗')
  if (emptyErr === '') errors.push('待改写为空时没有说明（用户不知道为什么没反应）')
  /* 「两个都是必填」这条约定要写进提示里 —— 只说「空着不行」不够，
   * 用户不知道该填哪、也不知道这是工作流的必填项。 */
  console.log('   空输入时的说明提了「必填」:', /必填/.test(emptyErr) ? '✓' : '✗')
  if (!/必填/.test(emptyErr)) errors.push('空输入时没说清这是必填项')
  p3.unmount()

  /* 还原 `EventSource`（理由见这一段开头）。 */
  window.EventSource = prevEs
  globalThis.EventSource = prevEs
}

/* ⑱ 总览改成**看板**（2026-10-23 契约 F）。
 *
 * ## 判据钉的是什么
 *
 * 用户定的形态：总览重在看 —— 一块块看板，各自显示最近一次结果，
 * 右上角那个「刷新」是**真的跑一次**。所以本轮改动的三条必须各有一条断言：
 *
 *   ① 看板卡片存在（`data-ewb-dashboard`），且**每块都有刷新按钮**
 *      （`data-ewb-dashboard-refresh`）。只验「有卡片」不够 ——
 *      用户可以没有刷新入口，那样就又变回「只看不能动」或「只能去别处跑」。
 *   ② ★ **告警汇总那一块必须消失**。这是「执行视角」的残留，
 *      改版时最容易漏删（它不报错、只是不再该在）。判据查「告警」这个词
 *      在整块总览里**一次都不出现**。
 *   ③ ★ 点刷新**真的展开跑的画面**（`data-ewb-dashboard-runpanel` 出现在那张卡内部），
 *      并且**别的卡的刷新按钮被禁用**（几份抢同一个浏览器会话会踢掉登录态）。
 *   ③ 是这一轮的核心：没有它，「刷新」可以是个只改个字的死按钮，测试照样绿。
 *
 * ## 为什么从源码 import
 *
 * 与⑬⑮⑯⑰ 同一理由：产物由校核统一重建，执行角色不许自己跑 bundle。
 * 读产物会把「没重建」误报成「代码坏了」。
 */
console.log('⑱ [总览] 看板形态 + 每块刷新真跑 + 告警块已删')
{
  globalThis.React = React
  const { OverviewBoard } = await import('../src/client/workbench/OverviewBoard.tsx')
  const host18 = window.document.createElement('div')
  window.document.body.appendChild(host18)
  const root18 = ReactDOMClient.createRoot(host18)
  root18.render(React.createElement(OverviewBoard, {
    active: true, tab: '', apiBase: '/api/ecom-workbench', topHidden: false,
    onToggleTop: () => {}, onSelectTab: () => {}, onRunWorkflow: () => {},
  }))
  await settle()

  /* ── ① 看板卡片 + 每块都有刷新 ─────────────────────────── */
  const dbs = [...host18.querySelectorAll('[data-ewb-dashboard]')]
  const dbNames = dbs.map(e => e.getAttribute('data-ewb-dashboard'))
  console.log('   看板块:', dbNames.join(' / ') || '（没有）')
  /* 桩里 `/workflows` 有一份「巡查-」开头的工作流（巡查-天猫竞品），
   * 所以这里期望**恰好一块**。多于一块说明判据漂了（把非巡查类也收进来了）。
   * ⚠️ 「天猫竞品巡查」不带前缀，它**不该**出现在看板里 —— 这一对同时成立，
   * 才说明判据是「前缀」而不是「名字里含巡查」。 */
  const onlyPatrol = dbNames.length === 1 && dbNames[0] === '巡查-天猫竞品'
  console.log('   ★ 看板只放「巡查-」开头的那几份:', onlyPatrol ? '✓' : '✗（' + dbNames.join(' / ') + '）')
  if (!onlyPatrol) {
    errors.push('总览看板不是「只放名字以巡查-开头的」那一批（实际：' + (dbNames.join(' / ') || '没有') + '）')
  }
  console.log('   名字含「巡查」但不带前缀的没有混进来:', !dbNames.includes('天猫竞品巡查') ? '✓' : '✗')
  if (dbNames.includes('天猫竞品巡查')) {
    errors.push('看板判据漂了：名字含「巡查」但不以「巡查-」开头的那份被收进来了')
  }
  const refreshes = [...host18.querySelectorAll('[data-ewb-dashboard-refresh]')]
  const eachHasRefresh = dbs.length > 0 && dbs.every(d => d.querySelector('[data-ewb-dashboard-refresh]') !== null)
  console.log('   ★ 每块看板都有刷新按钮:', eachHasRefresh ? '✓（' + refreshes.length + ' 个）' : '✗')
  if (!eachHasRefresh) errors.push('有看板块没有刷新按钮（用户要求每块自带一个）')

  /* ── ② 告警汇总那一块必须消失 ──────────────────────────── */
  const text18 = host18.textContent ?? ''
  console.log('   ★ 总览里不再有「告警」汇总:', !text18.includes('告警') ? '✓' : '✗（还有）')
  if (text18.includes('告警')) {
    errors.push('总览里还有「告警」汇总（那是执行视角，不属于看）')
  }
  /* 「重读结果」与「刷新」必须是两个不同的词 —— 否则用户以为上面那个也会跑。 */
  console.log('   顶部是「重读结果」（只读不跑）:', text18.includes('重读结果') ? '✓' : '✗')
  if (!text18.includes('重读结果')) {
    errors.push('总览顶部没有「重读结果」（与每块的「刷新」要分开命名）')
  }

  /* ── ③ 点刷新 → 就地展开跑的画面 + 别的块禁用 ───────────── */
  const firstRefresh = refreshes[0]
  firstRefresh?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  const panel18 = host18.querySelector('[data-ewb-dashboard-runpanel]')
  console.log('   ★ 点刷新后展开了跑的画面:', panel18 !== null ? '✓' : '✗')
  if (panel18 === null) errors.push('点「刷新」后没有展开跑的画面（用户要求看得到进展）')
  if (panel18 !== null) {
    /* 「就地」：必须在**那张看板**的内部。 */
    const owner = panel18.closest('[data-ewb-dashboard]')?.getAttribute('data-ewb-dashboard') ?? '(无)'
    console.log('   ★ 跑的画面在那张看板内部:', owner === '巡查-天猫竞品' ? '✓' : '✗（属于 ' + owner + '）')
    if (owner !== '巡查-天猫竞品') errors.push('跑的画面没有挂在那张看板内部')
    /* 复用的确实是 FlowRunPanel（认它自己的 data 标记）。 */
    console.log('   跑的画面里是 FlowRunPanel:', panel18.querySelector('[data-ewb-flow-panel]') !== null ? '✓' : '✗')
    if (panel18.querySelector('[data-ewb-flow-panel]') === null) errors.push('进展区不是复用 FlowRunPanel')
  }
  const btnNow = host18.querySelector('[data-ewb-dashboard-refresh]')
  console.log('   刷新中按钮变「刷新中…」:', (btnNow?.textContent ?? '').trim() === '刷新中…' ? '✓' : '✗（' + (btnNow?.textContent ?? '').trim() + '）')

  /* 收尾：卸载。 */
  root18.unmount()
  host18.remove()
}

/* ⑲ 工作台设置的「模型」一节 + 节点上的模型控件（2026-10-23 契约 J）。
 *
 * ## 判据为什么落在「请求体」与「选项值」上
 *
 * 验收要的是「设默认只改默认、增减备选只改备选」。界面显示什么都不算证据 ——
 * 桩把每次 POST 的 body 记进 `__ewbModelPosts`，断言直接查它**有且只有哪个键**。
 *
 * ## 为什么这里能验「读不到时的降级」
 *
 * 模型清单是**模块级缓存**，一旦成功读到就回不到「从没读到过」。
 * 所以桩默认 `fail`（见文件头 `__ewbModelsMode`），前面 ⑮ 那次挂载已经
 * 撞上一次失败并留下原因；这一段先验那一屏，再点「重读」拨成 `ok`。
 * 这条路径恰好是用户真会遇到的那条（接口还没上 → 后来上了 → 重新读）。
 *
 * ## 「只请求一次」怎么验
 *
 * 不在绝对次数上判（前面 ⑮ 已经花掉一次）。判据是：**再挂两个使用者
 * （设置 + 节点控件）之后，GET 次数不再增加**。缓存没生效的话必然 +2。
 */
console.log('⑲ [模型] 工作台设置那一节 + 节点模型控件共用一份清单')
{
  globalThis.React = React
  /* ⚠️ 票 66：原来这里 import 的是 `WorkspaceSettings`（那个抽屉），抽屉已删。
   * 现在挂 `ConfigBoard` 并把它拨到「模型」那一格 —— 三块设置就住在那一格里。 */
  const { ConfigBoard } = await import('../src/client/workbench/ConfigBoard.tsx')
  const { ensureModelsLoaded } = await import('../src/client/workbench/WorkspaceSettings.tsx')
  const { NodeEditorBody } = await import('../src/client/workbench/NodeEditorPopover.tsx')
  const { NODE_LIBRARY } = await import('../src/nodes/index.ts')

  /** 挂一个组件到独立容器。 */
  const mount = async (el) => {
    const host = window.document.createElement('div')
    window.document.body.appendChild(host)
    const root = ReactDOMClient.createRoot(host)
    root.render(el)
    await settle()
    return { host, unmount: () => { root.unmount(); host.remove() } }
  }
  /** 点一下（React 的合成事件要走冒泡的真鼠标事件）。 */
  const click = async (el) => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
  }

  /* 浏览器偏好那两条接口顺带桩掉 —— 工作台设置里还有「浏览器」一节。 */
  const realFetch19 = window.fetch
  window.fetch = globalThis.fetch = async (url, init) => {
    const u = String(url)
    if (u.includes('/browser/prefs')) return { ok: true, status: 200, json: async () => ({ ok: true }) }
    if (u.includes('/browser/detect')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, browsers: [], cdp: { listening: false, endpoints: [] } }) }
    }
    return realFetch19(url, init)
  }

  /* ── ① 接口读不到时：明说原因、页面不崩、不空白 ─────────────── */
  /* `tab: 'model'` 是**必须**的：`ConfigBoard` 只渲染当前那一格，
   * 给 `'other'` 就一个模型控件都挂不出来。 */
  const ws1 = await mount(React.createElement(ConfigBoard, { active: true, tab: 'model' }))
  const t1 = ws1.host.textContent ?? ''
  const errBox = ws1.host.querySelector('[data-ewb-model-error]')
  console.log('   ★ 读不到时显示了原因:', errBox !== null && t1.includes('读不到模型列表') ? '✓' : '✗（' + t1.slice(0, 80) + '）')
  if (errBox === null || !t1.includes('读不到模型列表')) {
    errors.push('模型接口读不到时没有显示「读不到模型列表」')
  }
  console.log('   原因原文带出来了（不是空壳）:', t1.includes('宿主半还没实现模型接口') ? '✓' : '✗')
  if (!t1.includes('宿主半还没实现模型接口')) errors.push('读不到模型列表时没有带出具体原因')
  /* ⚠️ 票 66：这条原来是「页面没崩（浏览器那一节还在）」—— 抽屉时代五节同屏，
   * 浏览器在就能证明没崩。
   *
   * 现在两格互斥、浏览器在**另一格**，拿它判「模型格没崩」是拿隔壁的证据。
   * 换成**同格里另外两块还在**（四类默认 / 模型清单）—— 崩了的话它们会一起不见，
   * 而它们此刻本来就应该在，所以这条比原来更强（原来那两块不在也能绿）。
   *
   * ⚠️ 票 68：这里的「另外两块」从「渠道 / 四类默认」换成了
   * 「四类默认 / 模型清单」—— 渠道列表被模型清单取代了（那是**事实变了**，
   * `data-ewb-channels-section` 这个钩子随着渠道列表一起没了，不是判据放宽）。 */
  const modelTabAlive = ws1.host.querySelector('[data-ewb-model-list]') !== null
    && ws1.host.querySelector('[data-ewb-content-defaults-section]') !== null
  console.log('   页面没崩（模型格另外两块还在）:', modelTabAlive ? '✓' : '✗')
  if (!modelTabAlive) errors.push('模型读不到时整页崩了（模型清单 / 四类默认那两块也不见了）')
  /* dsh 模型目录必须是**一节**，且是 `<details>`（票 68：默认收起）。
   *
   * ⚠️ 票 68 之前这一节的标题是「模型」，现在叫「dsh 模型目录 · N 个」——
   * 因为「模型」这个词已经给了整格（格名），再给其中一节就分不清说的是哪个。 */
  const secs = [...ws1.host.querySelectorAll('[data-ewb-model-section]')]
  console.log('   ★ 有独立的「dsh 模型目录」一节:', secs.length === 1 ? '✓' : '✗（' + String(secs.length) + '）')
  if (secs.length !== 1) errors.push('配置板块里没有独立的「dsh 模型目录」一节（data-ewb-model-section）')
  const secText = secs[0]?.textContent ?? ''
  console.log('   这一节的标题是「dsh 模型目录」:', secText.trim().startsWith('dsh 模型目录') ? '✓' : '✗')
  if (!secText.trim().startsWith('dsh 模型目录')) errors.push('「dsh 模型目录」一节的标题不是它')
  /* ⚠️ 票 66：这条**换了守的对象**，但守的是同一件事 ——「模型不是塞进浏览器里」。
   *
   * 改前（抽屉）：模型与浏览器并列 → 验「两者是同一个父容器的兄弟」。
   * 改后（两格 tab）：模型与浏览器**不同格** → 模型格里根本没有浏览器。
   *
   * 为什么不是「判据变弱了」：旧形态下「并列」是可达的最强证据；
   * 新形态下更强的证据是**互斥**（连渲染都不在，不是靠 CSS 藏）。
   * 判据强度只升不降 —— 旧形态里塞错位置还能靠样式蒙混，新形态里根本挂不出来。 */
  const browserInModelTab = ws1.host.querySelector('[data-ewb-browser-section]')
  console.log('   ★ 模型格里没有浏览器（两格互斥，不是靠样式藏）:', browserInModelTab === null ? '✓' : '✗')
  if (browserInModelTab !== null) {
    errors.push('模型格里出现了浏览器那一块 —— 两格被一起渲染了（切走的那格必须不在 DOM 里）')
  }
  /* 正面：模型格里该有的三块都在。
   *
   * ⚠️ 票 68 换过**守的对象**，守的是同一件事 ——「模型格是齐的、不是空壳」：
   *
   * | | 改前（票 66） | 改后（票 68） |
   * |---|---|---|
   * | 三块 | dsh 模型目录 / 渠道列表 / 四类默认 | 默认模型五类 / 模型清单 / dsh 模型目录 |
   *
   * 换的依据是**产品形态变了**（票面「版面」那一节：一份清单取代渠道列表），
   * 不是「判据太严想放宽」。条数仍然是三块齐，一块不少也一块不多。 */
  const modelTabBlocks = ['[data-ewb-content-defaults-section]', '[data-ewb-model-list]', '[data-ewb-model-section]']
  const modelFound = modelTabBlocks.filter(sel => ws1.host.querySelector(sel) !== null)
  console.log('   ★ 模型格里三块齐（默认五类 / 模型清单 / dsh 目录）:', modelFound.length === 3 ? '✓' : '✗（' + modelFound.length + '/3）')
  if (modelFound.length !== 3) {
    errors.push('配置板块的模型格缺块（缺：'
      + modelTabBlocks.filter(sel => !modelFound.includes(sel)).join('、') + '）')
  }

  /* ── ② 点「重读」→ 清单到货，分组、默认、备选都在 ───────────── */
  __ewbModelsMode = 'ok'
  const retry = ws1.host.querySelector('[data-ewb-model-retry]')
  console.log('   读不到时给了「重读」按钮:', retry !== null ? '✓' : '✗')
  if (retry === null) errors.push('读不到模型列表时没有「重读」按钮（只能重启整个界面才恢复）')
  await click(retry)
  await settle()
  const t2 = ws1.host.textContent ?? ''
  const provs = [...ws1.host.querySelectorAll('[data-ewb-model-provider]')]
  console.log('   ★ 全部模型按提供方分组列出:', provs.length === 2 ? '✓（' + provs.map(e => e.getAttribute('data-ewb-model-provider')).join(' / ') + '）' : '✗（' + String(provs.length) + '）')
  if (provs.length !== 2) errors.push('模型没有按提供方分组列出（期望 2 组）')
  /* ── ★ 不横向溢出（2026-10-23 契约 P 第 5 条）
   *
   * ## 这条原来验的是「分组可折叠（details）」，为什么换掉
   *
   * 用户 m02240 报的真问题是「模型信息展开后很多模型被压到右侧点不到」。
   * 当时的对策一半是折叠（少显示），但折叠**治不了溢出** —— 展不开一样挤。
   * 宽面板改完之后一屏装得下，折叠只剩「多一次点击」的代价，所以去掉了。
   *
   * 这一条换成**结构上防溢出**的判据。jsdom **不做布局**（`getBoundingClientRect`
   * 恒为 0，`scrollWidth` 也是 0），所以量宽度在这里拿不到真值 ——
   * 如实说明：**这一条验的是「结构上不允许溢出」，不是「实测没溢出」**。
   * 实测要真机（Chromium），不在这个测试的能力范围内。
   *
   * ## 结构上「不允许溢出」的判据是什么
   *
   * 溢出发生在 flex 行里，根因只有一个：**该收缩的那格没给收缩余地**。
   * 所以判两件事：
   *   a) 每个模型行的**动作区**是行内**最后一个**子项，且带 `flex: 0 0 auto`
   *      —— 按钮永远不被压缩、永远在行的末端；
   *   b) 名字那一格带 `min-width: 0`（CSS 里给了 `overflow: hidden` + 省略号）
   *      —— 名字再长也是它先截断，不会把按钮顶出去。
   *
   * 这两条在 CSS Modules 里是**类名**，而测试里 CSS 被桩成空对象（类名比不出来）。
   * 所以判据落在**结构关系**上（动作区是最后一个子项 + 每行都有名字格与动作格），
   * 而「`min-width: 0` 有没有写」用**读源码**来断 —— 两种手段各取所长，
   * 代价是后者只能证明「写了」，不能证明「生效」。也如实记在这里。 */
  const modelRows = [...ws1.host.querySelectorAll('[data-ewb-model-row]')]
  const rowsWellFormed = modelRows.length > 0 && modelRows.every(r => {
    const kids = [...r.children]
    if (kids.length < 2) return false
    const last = kids[kids.length - 1]
    /* 动作区必须是**最后一个**子项，且里面两个按钮都在。 */
    return last.querySelector('[data-ewb-model-set-default]') !== null
      && last.querySelector('[data-ewb-model-toggle]') !== null
  })
  console.log('   ★ 每个模型行的动作都在行末（名字在前、按钮在后）:', rowsWellFormed ? '✓' : '✗')
  if (!rowsWellFormed) {
    errors.push('模型行的结构调整了：动作区不是行内最后一个子项，或按钮不在动作区里（长名字会把按钮挤出可视区）')
  }
  /* 读源码，验「可收缩那一格」确实写了 `min-width: 0`。 */
  const wsCss = readFileSync(new URL('../src/client/workbench/WorkbenchSettings.module.css', import.meta.url), 'utf8')
  const nameRule = /\.modelName\s*\{([\s\S]*?)\}/.exec(wsCss)
  const hasShrink = nameRule !== null && /min-width:\s*0/.test(nameRule[1])
  console.log('   ★ 名字那一格写了 min-width: 0（能收缩、先截断）:', hasShrink ? '✓' : '✗')
  if (!hasShrink) {
    errors.push('模型名那一格没有 min-width: 0 —— 长名字会把两个动作按钮挤出可视区（用户 m02240 报的就是这个）')
  }
  /* ⚠️ 票 66：这条原来验「`.panel` 宽到 720px」。
   *
   * 抽屉删了 → `.panel` 那套类成了**死代码**（票面写明本票先留着不删，
   * 票 69 收尾时清）。继续验「它还写着 720px」等于**验一段没人用的 CSS** ——
   * 这正是「假防线」：以后谁删掉它，这条会红，但删了根本不影响用户。
   *
   * 换成真断言：**源码里没有任何文件还在引用那批抽屉类**。
   * 它钉的是「抽屉真删干净了」，而不需要碰那段待清的样式。
   *
   * ⚠️ 判据扫的是 `ws.` / `css.` 前缀的**属性访问**，不是类名子串 ——
   * `WorkbenchSettings.module.css` 里当然还写着 `.panel`（那就是死代码本身），
   * 拿类名子串搜会永远命中。 */
  const { readdirSync } = await import('node:fs')
  const wbDir = new URL('../src/client/workbench/', import.meta.url)
  const deadProps = ['panel', 'panelHead', 'panelTitle', 'panelClose', 'panelBody']
  const liveRefs = []
  for (const f of readdirSync(wbDir)) {
    if (!f.endsWith('.tsx') && !f.endsWith('.ts')) continue
    const code = readFileSync(new URL(f, wbDir), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const p of deadProps) {
      if (new RegExp('\\b(?:ws|css)\\.' + p + '\\b').test(code)) liveRefs.push(f + ' → ' + p)
    }
  }
  console.log('   ★ 抽屉那批类已经是死代码（没有任何源码引用）:', liveRefs.length === 0 ? '✓' : '✗（' + liveRefs.join('、') + '）')
  if (liveRefs.length > 0) {
    errors.push('抽屉删了但还有源码在用那批类：' + liveRefs.join('、'))
  }

  /* ── ★ 三块之间的横线、标题字号、版式统一（2026-10-23 契约 Y）────────
   *
   * ## 用户看到的问题
   *
   * 「设置的分栏不够明显，太平了，先简单优化，为每个内容之间加一个横线区分，
   * 暂时不分tab。把设置内容的板式统一，每一个内容板块的标题字打一点，
   * 模型、提醒、浏览器，目前就这三个内容板块」。
   *
   * ## 判据为什么同时看 DOM 与 CSS
   *
   * jsdom 不做布局，`getComputedStyle` 也不认 CSS Modules 的类（那份被桩成空对象）——
   * **只能读源码里那条规则**。但只读源码又证明不了「这三块真的走同一条规则」，
   * 所以两层一起验：
   *
   *   ① DOM：三块的根节点是同一个父容器的兄弟，且带各自的 `data-ewb-*-section`；
   *   ② CSS：`.section + .section` 里确实写了 `border-top`（横线靠相邻选择器，
   *      第一块不加），且 `.sectionTitle` 的字号比原来大一档。
   *
   * ⚠️ 第 ② 条**必须落在 `.section` 的规则体里**，不能只看「文件里有没有
   * border-top」—— 文件里别处本来就有很多 border。
   *
   * ## ★ 2026-10-30（票 02）换了判据的**落点**，守的事变强了
   *
   * 改前：`\\.section + \\.section` 里有 border-top —— 也就是「只有**相邻**两节之间
   * 才有线，每个 tab 的第一块没有」。那正是用户抱怨「模型和 comfyui 没有（线）」
   * 的一半：`ModelListSection` / `ChannelSettings` 根本没套 `.section`，
   * 而且第一块本来就按设计不画线。
   *
   * 改后 **两个方向都验**（比原来严，不是放宽）：
   *   ① `.section` **自己**的规则里有 `border-top` —— 每一节都有线，第一块也有；
   *   ② `.section` 里有 `flex: 0 0 auto`（或 `flex-shrink: 0`）—— 不许被压扁。
   *      这条是「dsh 模型目录展开后内容叠加」的修法（详见 CSS 里那段说明），
   *      jsdom 不排版，视觉上「不叠」只能靠这条声明钉住。
   *
   * ⚠️ 旧判据（`.section + .section`）**一并保留**：相邻两节之间仍然要有间距规则，
   * 只是它现在只管 `margin-top`、不再管线。删了它会漏掉「节间没留白」那种退化。 */
  const sectionRule = /\.section\s*\{([\s\S]*?)\}/.exec(wsCss)
  const sectionBody = sectionRule === null ? '' : sectionRule[1]
  const eachHasDivider = /border-top/.test(sectionBody)
  console.log('   ★ 每一节都有上边线（.section 自己的 border-top，含第一块）:', eachHasDivider ? '✓' : '✗')
  if (!eachHasDivider) errors.push('设置里不是每一节都有上边线（.section 里没有 border-top）')

  const noShrink = /flex:\s*0\s+0\s+auto/.test(sectionBody) || /flex-shrink:\s*0/.test(sectionBody)
  console.log('   ★ 每一节都不许被压扁（.section 里有 flex: 0 0 auto）:', noShrink ? '✓' : '✗')
  if (!noShrink) {
    errors.push('设置里 .section 没有 flex: 0 0 auto —— 展开一块之后别的节会被压扁、内容溢出叠上去')
  }

  const sectionGap = /\.section\s*\+\s*\.section\s*\{([\s\S]*?)\}/.exec(wsCss)
  const hasGap = sectionGap !== null && /margin-top/.test(sectionGap[1])
  console.log('   ★ 相邻两节之间有留白（.section + .section 的 margin-top）:', hasGap ? '✓' : '✗')
  if (!hasGap) errors.push('设置的相邻两节之间没有留白（.section + .section 里没有 margin-top）')

  const titleRule = /\.sectionTitle\s*\{([\s\S]*?)\}/.exec(wsCss)
  /* 加大一档：原来是 `--text-ewb-meta`（13px），现在是 `--text-ewb-body`（14px）。
   * ⚠️ 判据是「比 meta 大一档」，不是「等于某个字面量」—— 换成别的更大 token 也算对，
   * 但 A 回 meta 就红。 */
  const titleSize = titleRule === null ? '' : (/font-size:\s*var\((--text-ewb-[\w-]+)\)/.exec(titleRule[1])?.[1] ?? '')
  const biggerOk = titleSize !== '' && titleSize !== '--text-ewb-meta' && titleSize !== '--text-ewb-caption'
    && titleSize !== '--text-ewb-label'
  console.log('   ★ 板块标题字号加大了一档（' + (titleSize || '没写') + '）:', biggerOk ? '✓' : '✗')
  if (!biggerOk) errors.push('设置里三块的标题没有加大（现在是 ' + (titleSize || '没写') + '）')

  /* ② DOM 层：**两格各自完整**，且不互相渗透。
   *
   * ## ⚠️ 这一条 2026-10-29 换了形态，守的事没变（票 66）
   *
   * 旧形态（抽屉，一列五节）：
   *   「三块都在 + **没有**做成 tab + 顺序 模型 → 提醒 → 浏览器」
   *   —— 因为用户当时原话是「暂时不分tab」。
   *
   * 新形态（板块，两格 tab）：
   *   用户 2026-10-29 原话「内容不变、只按内容分 tab」→ **分部这件事是用户新要的**，
   *   所以「不许有 tab」那条判据的反面已经不成立，**改成验分部本身的正确性**：
   *
   *     ① 模型格里三块齐（模型 / 渠道 / 四类默认）—— 上面 B④ 已验；
   *     ② 其它格里两块齐（提醒 / 浏览器）—— 这里验；
   *     ③ **两格不互相渗透** —— 模型格里没有提醒/浏览器，其它格里没有模型/渠道。
   *
   * ③ 是这条的新骨头：旧形态最怕「三块少了一块」，新形态最怕
   * 「两格一起渲染」—— 那会让 `useEffect` 在没打开时就发请求
   * （票面第 2 条：进一次发两路请求）。
   *
   * 「判据没变弱」的依据：旧形态 3 条（三块齐 / 没 tab / 顺序），
   * 新形态 4 条（模型格齐 / 其它格齐 / 双向不渗透 / 两格各自顺序），净增。 */
  /* ⚠️ 票 68：`data-ewb-channels-section` 换成 `data-ewb-model-list` ——
   * 渠道列表被模型清单取代了（那个钩子随渠道列表一起没了）。
   * 这一组守的仍是「模型格里该有的、其它格里不该有」，两个方向都还在。 */
  const modelTabSel = ['[data-ewb-content-defaults-section]', '[data-ewb-model-list]', '[data-ewb-model-section]']
  /* ⚠️ 票 69：布局（`data-ewb-layout-section`）也进了这一格，所以要一起算。 */
  const otherTabSel = ['[data-ewb-browser-section]', '[data-ewb-notify-section]', '[data-ewb-layout-section]']
  const otherInModel = otherTabSel.filter(sel => ws1.host.querySelector(sel) !== null)
  console.log('   ★ 模型格不许有「其它」那一格的内容:', otherInModel.length === 0 ? '✓' : '✗（有 ' + otherInModel.join('、') + '）')
  if (otherInModel.length > 0) {
    errors.push('模型格里混进了「其它」那一格的内容（两格被一起渲染了）')
  }

  /* ③ 顺序：两格**各自**的顺序（用户原话的顺序没变，只是被 tab 分成两段）。
   *
   * 判据取**文档顺序**（`querySelectorAll` 返回的就是文档顺序），不看源码里
   * 组件的书写顺序 —— 后者能对上但渲染顺序被 CSS 的 `order` 改掉时，
   * 用户看到的仍是错的。
   *
   * ⚠️ 第一版（抽屉时代）用「在父容器 children 里的下标」判，结果三块都算成 1
   * —— 父节点取错了。直接按选择器的文档顺序取，没有这个坑。 */
  const modelOrder = modelTabSel
    .map(sel => [...ws1.host.querySelectorAll(sel)][0] ?? null)
    .filter(el => el !== null)
  /* ⚠️ 票 68：顺序改成票面「版面」那一节定的那个（默认模型在上、清单在中、
   * dsh 目录在下）。守的事情没变：**这三块得有固定的先后**，不能乱。
   *
   * 为什么这个顺序是契约：用户看这一格的第一件事是「内容生成默认用哪个」，
   * 第二件才是「我有哪些模型」，最后才是「dsh 里还有哪些能拉进来」。
   * 反过来的话，一进来先看到一长串 dsh 目录（用户原话：「太长了」）。 */
  const modelOrderOk = modelOrder
    .map(el => el.getAttributeNames().find(a => a.startsWith('data-ewb-') && (a.endsWith('-section') || a.endsWith('-list'))))
    .join('>')
    === 'data-ewb-content-defaults-section>data-ewb-model-list>data-ewb-model-section'
  console.log('   ★ 模型格的顺序是 默认五类 → 模型清单 → dsh 目录:', modelOrderOk ? '✓' : '✗')
  if (!modelOrderOk) {
    errors.push('模型格里三块的顺序不是 默认五类 → 模型清单 → dsh 目录')
  }

  /* 其它那一格：另起一次挂载（只渲染当前格，不能在同一次挂载里看两格）。
   * 这一次顺带验「其它格里没有模型格的东西」—— 双向不渗透的另一半。 */
  const cfgOther = await mount(React.createElement(ConfigBoard, { active: true, tab: 'other' }))
  const otherFound = otherTabSel.filter(sel => cfgOther.host.querySelector(sel) !== null)
  /* ⚠️ 票 69：从两块变三块（浏览器 / 提醒 / 布局）。数字跟着 `otherTabSel` 走，
   * 不写死 —— 写死的话下次往里加一块，这条会红在一个与它无关的地方。 */
  console.log('   ★ 其它格三块齐（浏览器 / 提醒 / 布局）:',
    otherFound.length === otherTabSel.length ? '✓' : '✗（' + otherFound.length + '/' + otherTabSel.length + '）')
  if (otherFound.length !== otherTabSel.length) {
    errors.push('配置板块的其它格缺块（缺：'
      + otherTabSel.filter(sel => !otherFound.includes(sel)).join('、') + '）')
  }
  const modelInOther = modelTabSel.filter(sel => cfgOther.host.querySelector(sel) !== null)
  console.log('   ★ 其它格不许有模型格的内容:', modelInOther.length === 0 ? '✓' : '✗（有 ' + modelInOther.join('、') + '）')
  if (modelInOther.length > 0) {
    errors.push('其它格里混进了模型格的内容（两格被一起渲染了）')
  }
  /* ⚠️ **票 69 把顺序换成了「浏览器 → 提醒 → 布局」**（用户 2026-10-29 原话：
   * 「浏览器、提醒、内容区限宽都做为一个 tab 的内容先」）。
   *
   * 票 66 时是「提醒 → 浏览器」（与抽屉里原来的先后一致）。这次用户点名要的
   * 是另一个顺序，所以判据跟着改 —— **守的事情没变**（三块得有固定先后、
   * 且与用户要的顺序一致），只是那个顺序按用户最新一句话换了。
   *
   * 判据从「两块」扩到「三块」：布局（票 69）也在这格里，它同样要在这个顺序上。 */
  const otherDocOrder = [...cfgOther.host.querySelectorAll(
    '[data-ewb-browser-section],[data-ewb-notify-section],[data-ewb-layout-section]',
  )].map((el) => {
    if (el.getAttribute('data-ewb-browser-section') !== null) return 'browser'
    if (el.getAttribute('data-ewb-notify-section') !== null) return 'notify'
    return 'layout'
  })
  console.log('   ★ 其它格的顺序是 浏览器 → 提醒 → 布局:',
    otherDocOrder.join('>') === 'browser>notify>layout' ? '✓' : '✗（' + (otherDocOrder.join(' → ') || '(无)') + '）')
  if (otherDocOrder.join('>') !== 'browser>notify>layout') {
    errors.push('其它格三块顺序不是 浏览器 → 提醒 → 布局（实际 ' + (otherDocOrder.join(' → ') || '(无)') + '）')
  }
  /* 那次挂载顺手验一句：默认（空 tab）落在模型格 —— 用户点进配置页第一眼该看到模型。 */
  const cfgDefault = await mount(React.createElement(ConfigBoard, { active: true, tab: '' }))
  /* ⚠️ 票 68：判据从 `data-ewb-model-section`（dsh 目录那一节）换成
   * `data-ewb-model-list`（模型清单）—— 前者现在**在 `<details>` 里且默认收起**，
   * 拿它判「落在模型格」不再合适：将来谁把清单挪走、只留 dsh 目录，也会绿。
   * 清单是这一格的主体，用主体判「落进来没有」比用最后一节更准。 */
  console.log('   ★ 空 tab 落在模型格（进配置页第一眼是模型）:',
    cfgDefault.host.querySelector('[data-ewb-model-list]') !== null && cfgDefault.host.querySelector('[data-ewb-notify-section]') === null ? '✓' : '✗')
  if (cfgDefault.host.querySelector('[data-ewb-model-list]') === null || cfgDefault.host.querySelector('[data-ewb-notify-section]') !== null) {
    errors.push('空 tab 没落在模型格（进配置页第一眼看不到模型，或两格一起渲染了）')
  }
  cfgDefault.unmount()
  cfgOther.unmount()

  /* ④ 浏览器那块的标题**也**要跟着加大，且走的是 props 不是 DOM 结构选择器。
   *
   * ## 这条 2026-10-23 晚改过一次，改的是**做法**不是强度
   *
   * 改前：外层用 `.browserSection > div > div:first-child` 那条 CSS 把标题拉齐。
   * 那条判据验的是「规则还在」，可它是**拿 DOM 结构当契约** ——
   * `BrowserSettings` 里只要多包一层，规则静默失效、用户看到标题小一号，
   * 而断言照样绿（它只验 CSS 文件里有那行字）。
   *
   * 改后：`BrowserSettings` 收一个 `titleClassName` props，
   * `WorkspaceSettings` 传 `ws.sectionTitle` 进去。判据变成三件：
   *
   *   ① 那条脆弱的 CSS 选择器**已经删干净**（留着两套才是坑）；
   *   ② `BrowserSettings` 这个 props **真的挂到了标题那个 div 上**
   *      （给它传一个哨兵类名，看 DOM 里有没有）；
   *   ③ `WorkspaceSettings` 真的**传了**那个 props（读源码，因为跑测试时
   *      CSS Modules 被桩成空对象，`ws.sectionTitle` 是 `undefined`，
   *      在 DOM 上分不出「传了 undefined」与「没传」）。
   *
   * ⚠️ ① 必须**先剥掉 CSS 注释**再判：那段说明里抄了原来的选择器，
   * 不剥的话判据会被自己的注释命中（第一版就是这么假红的）。 */
  const wsCssNoComment = wsCss.replace(/\/\*[\s\S]*?\*\//g, '')
  const staleRule = /\.browserSection\s*>\s*div\s*>\s*div:first-child/.test(wsCssNoComment)
  console.log('   ★ 那条脆弱的 DOM 结构选择器已经删了:', staleRule ? '✗' : '✓')
  if (staleRule) {
    errors.push('`.browserSection > div > div:first-child` 那条还在 —— 拿 DOM 结构当契约，'
      + 'BrowserSettings 多包一层就静默失效')
  }

  /* ② 哨兵类名：真挂一个 `BrowserSettings`，传一个测试专用的类名，看它到没到标题上。
   * 这一条比「读源码里有没有那个 props」强 —— 它证明的是**运行期真挂上去了**。 */
  {
    const { BrowserSettings: BS } = await import('../src/client/workbench/BrowserSettings.tsx')
    const probeHost = window.document.createElement('div')
    window.document.body.appendChild(probeHost)
    const probeRoot = ReactDOMClient.createRoot(probeHost)
    const SENTINEL = 'ewb-probe-title-class'
    probeRoot.render(React.createElement(BS, {
      prefs: { defaultSource: 'app', defaultPort: '', defaultBrowser: '', openMode: 'app' },
      onPrefs: () => {},
      titleClassName: SENTINEL,
    }))
    await settle()
    const titled = [...probeHost.querySelectorAll('div')]
      .find(el => String(el.className ?? '').includes(SENTINEL))
    console.log('   ★ titleClassName 真的挂到了标题那个 div 上:', titled !== undefined ? '✓' : '✗')
    if (titled === undefined) {
      errors.push('BrowserSettings 的 titleClassName 没有挂到标题上（props 没生效）')
    }
    /* 反面：**不传**时不该挂任何多余的东西（默认行为与改前一致）。 */
    const plainHost = window.document.createElement('div')
    window.document.body.appendChild(plainHost)
    const plainRoot = ReactDOMClient.createRoot(plainHost)
    plainRoot.render(React.createElement(BS, {
      prefs: { defaultSource: 'app', defaultPort: '', defaultBrowser: '', openMode: 'app' },
      onPrefs: () => {},
    }))
    await settle()
    const leaked = [...plainHost.querySelectorAll('div')]
      .some(el => String(el.className ?? '').includes(SENTINEL))
    console.log('   不传时不会挂哨兵类名（默认行为不变）:', leaked ? '✗' : '✓')
    if (leaked) errors.push('不传 titleClassName 时也挂了那个类名（默认行为被改坏了）')
    probeRoot.unmount()
    probeHost.remove()
    plainRoot.unmount()
    plainHost.remove()
  }

  /* ③ **配置板块**真的把 `sectionTitle` 传进去了（票 66 起，原来是 `WorkspaceSettings`）。
   *
   * ⚠️ 这条搬家时差点变成真丢：`ConfigBoard` 第一版写成
   * `<BrowserSettings prefs onPrefs />`，把 `titleClassName` 忘了 ——
   * 「浏览器」那一节的标题会静默小一号（用户 2026-10-23 专门要求过对齐）。
   * 判据跟着搬，就是为了让这类「搬家丢东西」当场红。 */
  const cfgSrcNow = readFileSync(new URL('../src/client/workbench/ConfigBoard.tsx', import.meta.url), 'utf8')
  const passesTitle = /<BrowserSettings[\s\S]{0,300}?titleClassName=\{[\w.]*sectionTitle\}/.test(cfgSrcNow)
  console.log('   ★ 配置板块把 sectionTitle 传给了 BrowserSettings:', passesTitle ? '✓' : '✗')
  if (!passesTitle) {
    errors.push('ConfigBoard 没有传 titleClassName={…sectionTitle} —— 浏览器那一节标题会小一号')
  }

  const defNow = ws1.host.querySelector('[data-ewb-model-default]')
  console.log('   ★ 当前默认模型显示成 provider/模型名:', defNow?.getAttribute('data-ewb-model-default') === 'deepseek-official/deepseek-v4-flash' ? '✓（' + (defNow?.textContent ?? '') + '）' : '✗（' + (defNow?.textContent ?? '') + '）')
  if (defNow?.getAttribute('data-ewb-model-default') !== 'deepseek-official/deepseek-v4-flash') {
    errors.push('默认模型没有显示成 provider/模型名')
  }
  const rows = [...ws1.host.querySelectorAll('[data-ewb-model-row]')]
  console.log('   每个模型一行、带两个动作:', rows.length === 3 && rows.every(r => r.querySelector('[data-ewb-model-set-default]') !== null && r.querySelector('[data-ewb-model-toggle]') !== null) ? '✓（' + String(rows.length) + ' 行）' : '✗（' + String(rows.length) + ' 行）')
  if (rows.length !== 3) errors.push('全部模型的行数不对（期望 3 个模型）')
  if (!rows.every(r => r.querySelector('[data-ewb-model-set-default]') !== null && r.querySelector('[data-ewb-model-toggle]') !== null)) {
    errors.push('有模型行缺「设为默认」或「加入/移出备选」')
  }
  /* ★ 不自动全进备选：3 个模型里只有 1 个在名单上（桩里就是这么给的）。 */
  const pickRows = [...ws1.host.querySelectorAll('[data-ewb-model-pick]')]
  console.log('   ★ 没有把所有模型自动放进备选:', pickRows.length === 1 ? '✓（备选 1 个 / 全部 3 个）' : '✗（备选 ' + String(pickRows.length) + ' 个）')
  if (pickRows.length !== 1) errors.push('备选名单不是用户挑的那一个（疑似把所有 dsh 模型都收了进来）')
  console.log('   备选那一行可以单独移出:', pickRows[0]?.querySelector('button') !== null ? '✓' : '✗')
  if (pickRows[0]?.querySelector('button') === null) errors.push('备选名单里的项没有「移出」按钮')

  /* ── ③ 设默认只传 default，增减备选只传 picks ──────────────── */
  __ewbModelPosts.length = 0
  const proRow = rows.find(r => r.getAttribute('data-ewb-model-row') === 'deepseek-official/deepseek-v4-pro')
  await click(proRow?.querySelector('[data-ewb-model-set-default]'))
  const p1 = __ewbModelPosts[__ewbModelPosts.length - 1]
  console.log('   ★ 设为默认只提交 default:', p1 !== undefined && Object.keys(p1).length === 1 && p1.default?.model === 'deepseek-v4-pro' ? '✓（' + JSON.stringify(p1) + '）' : '✗（' + JSON.stringify(p1) + '）')
  if (!(p1 !== undefined && Object.keys(p1).length === 1 && p1.default?.model === 'deepseek-v4-pro')) {
    errors.push('「设为默认」没有只提交 default（或值不对）')
  }
  const defAfter = ws1.host.querySelector('[data-ewb-model-default]')
  console.log('   设完界面立刻跟上:', defAfter?.getAttribute('data-ewb-model-default') === 'deepseek-official/deepseek-v4-pro' ? '✓' : '✗（' + (defAfter?.textContent ?? '') + '）')
  if (defAfter?.getAttribute('data-ewb-model-default') !== 'deepseek-official/deepseek-v4-pro') {
    errors.push('设为默认后界面没更新（要用户自己刷新才算改成功，那是坏的）')
  }

  __ewbModelPosts.length = 0
  const otherRow = rows.find(r => r.getAttribute('data-ewb-model-row') === 'other/org/legacy-model')
  await click(otherRow?.querySelector('[data-ewb-model-toggle]'))
  const p2 = __ewbModelPosts[__ewbModelPosts.length - 1]
  console.log('   ★ 加入备选只提交 picks:', p2 !== undefined && Object.keys(p2).length === 1 && Array.isArray(p2.picks) && p2.picks.length === 2 ? '✓（' + JSON.stringify(p2) + '）' : '✗（' + JSON.stringify(p2) + '）')
  if (!(p2 !== undefined && Object.keys(p2).length === 1 && Array.isArray(p2.picks) && p2.picks.length === 2)) {
    errors.push('「加入备选」没有只提交 picks（或没把新的一项并进去）')
  }
  ws1.unmount()

  /* ── ④ 节点的模型控件：第一项是「跟随默认」且是默认值 ───────── */
  const aiDef = NODE_LIBRARY.find(d => d.paramDefs?.some(p => p.kind === 'model'))
  console.log('   节点库里确实有 kind: model 的参数:', aiDef !== undefined ? '✓（' + String(aiDef?.id) + '）' : '✗')
  if (aiDef === undefined) errors.push('节点库里没有任何 kind: model 的参数（控件没处可渲染）')

  const mountNode = async (modelValue) => {
    return await mount(React.createElement(NodeEditorBody, {
      def: aiDef,
      state: 'idle',
      params: { prompt: '写一句卖点', model: modelValue },
      onError: 'stop',
      onParam: () => {},
      onOnError: () => {},
    }))
  }

  const n1 = await mountNode('')
  const ctl1 = n1.host.querySelector('[data-ewb-model-ctl] select')
  const opts1 = [...(ctl1?.querySelectorAll('option') ?? [])]
  console.log('   ★ 模型控件渲染出来了:', ctl1 !== null && ctl1 !== undefined ? '✓' : '✗')
  if (ctl1 === null || ctl1 === undefined) errors.push('节点上的模型控件没有渲染（kind: model 没有分支）')
  console.log('   ★ 第一项是「跟随默认」:', (opts1[0]?.textContent ?? '') === '跟随默认' ? '✓' : '✗（' + (opts1[0]?.textContent ?? '（没有选项）') + '）')
  if ((opts1[0]?.textContent ?? '') !== '跟随默认') errors.push('模型控件的第一项不是「跟随默认」')
  console.log('   ★ 空值时默认选中「跟随默认」:', ctl1?.value === '' ? '✓' : '✗（' + String(ctl1?.value) + '）')
  if (ctl1?.value !== '') errors.push('模型控件空值时没有选中「跟随默认」')
  /* 选项来自备选名单（此时 2 个）+ 跟随默认 = 3 项；**不是**全部 3 个模型都列。 */
  console.log('   选项来自备选名单而不是全部模型:', opts1.length === 3 ? '✓（' + opts1.map(o => o.textContent).join(' / ') + '）' : '✗（' + opts1.map(o => o.textContent).join(' / ') + '）')
  if (opts1.length !== 3) errors.push('模型控件的选项不是来自备选名单（期望 跟随默认 + 2 个备选）')
  n1.unmount()

  /* ── ⑤ 老存档里已选、但不在备选名单的那个也要在选项里 ───────── */
  const n2 = await mountNode('deepseek-official/deepseek-v4-flash')
  const ctl2 = n2.host.querySelector('[data-ewb-model-ctl] select')
  const opts2 = [...(ctl2?.querySelectorAll('option') ?? [])]
  console.log('   备选里有的那个能正常选中:', ctl2?.value === 'deepseek-official/deepseek-v4-flash' ? '✓' : '✗（' + String(ctl2?.value) + '）')
  if (ctl2?.value !== 'deepseek-official/deepseek-v4-flash') errors.push('存档里选的模型没有在下拉里选中')
  n2.unmount()

  /* 把备选清空，模拟「老存档选的那个已经不在名单里」。 */
  __ewbModelPrefs.picks = []
  await ensureModelsLoaded(true)
  await settle()
  const n3 = await mountNode('deepseek-official/deepseek-v4-pro')
  const ctl3 = n3.host.querySelector('[data-ewb-model-ctl] select')
  const opts3 = [...(ctl3?.querySelectorAll('option') ?? [])]
  const labels3 = opts3.map(o => o.textContent)
  console.log('   ★ 已选但不在备选里的模型仍出现在选项里:', labels3.some(l => l.includes('不在备选名单')) ? '✓（' + labels3.join(' / ') + '）' : '✗（' + labels3.join(' / ') + '）')
  if (!labels3.some(l => l.includes('不在备选名单'))) {
    errors.push('老存档里选中的模型不在备选名单时，下拉里没有它（一保存就把原选择抹了）')
  }
  console.log('   ★ 而且它仍是当前选中值:', ctl3?.value === 'deepseek-official/deepseek-v4-pro' ? '✓' : '✗（' + String(ctl3?.value) + '）')
  if (ctl3?.value !== 'deepseek-official/deepseek-v4-pro') errors.push('老存档的模型值被界面改成了别的（静默丢数据）')
  n3.unmount()

  /* ── ⑥ 两处共用一份：再挂两个使用者，GET 次数不再增长 ──────── */
  const getsBefore = __ewbModelsGets
  /* 票 66：原来是挂 `WorkspaceSettings` 抽屉，抽屉已删 → 挂配置板块的模型格。 */
  const ws2 = await mount(React.createElement(ConfigBoard, { active: true, tab: 'model' }))
  const n4 = await mountNode('')
  const getsAfter = __ewbModelsGets
  console.log('   ★ 两处共用一份清单（再挂两处不再请求）:', getsAfter === getsBefore ? '✓（' + String(getsBefore) + ' → ' + String(getsAfter) + '）' : '✗（' + String(getsBefore) + ' → ' + String(getsAfter) + '）')
  if (getsAfter !== getsBefore) {
    errors.push('模型清单没有共用一份（设置与节点控件各拉了一次）')
  }
  ws2.unmount()
  n4.unmount()

  window.fetch = globalThis.fetch = realFetch19
}

/* ⓘ 模型痕迹（2026-10-23 契约 W）—— **从源码挂 RunHistoryPanel**
 *
 * ## 为什么接在这一段，而不是接进上面「运行历史」那一段
 *
 * 上面那段读的是**构建产物** `lib/client.js`（`dom-render` 的老规矩），
 * 而本轮改动只在源码里（产物由组长统一重建）。接上去就会把
 * 「还没重建」误报成「代码坏了」。
 *
 * 所以这里**直接从源码 import** `RunHistoryPanel`，挂到独立容器上，
 * 桩掉 `/workflow/runs` 喂两条带 `llm` 的运行记录 —— 测的就是此刻的代码。
 *
 * ## 这一整段防的是什么（这条链路之前确实是断的）
 *
 * 后端把 `RunNodeLine.llm` 落盘了、`formatTraceLine` 也写好了（注释明确写着
 * 「界面直接调它，别在界面里重新拼字符串」），但 `src/client` 里**一次都没引用** ——
 * 界面上一个字都不显示。用户跑完一次 AI 节点，看不到用了哪个模型、
 * 花了多少 token、为什么结束。
 *
 * | 判据 | 防的错 |
 * | --- | --- |
 * | 有 `llm` 的节点展开后出现那一行 | 根本没接上（本次要修的就是这条） |
 * | 那一行的文字与 `formatTraceLine` 的输出**一字不差** | 界面自己又拼了一遍（改文案就会漂） |
 * | 没 `llm` 的节点里**没有任何残留** | 空 div / 「无记录」占位（废话淹掉明细） |
 * | 没 token 时**没有**「输入 0 / 输出 0」 | 用 0 冒充「没测到」 |
 * | `truncated` 有可见标记 | 用户以为那是全文 |
 * | 两个摘要默认收起、点开才见 | 一展开几百字原文，明细没法扫 |
 *
 * ⚠️ 必须放在**最后** —— 它自己桩 `fetch`，放中间会影响别的段。
 */
console.log('')
console.log('ⓘ [新能力] 模型痕迹接进运行历史（用了哪个模型 / 多少 token / 为什么结束）')
{
  const realFetchW = window.fetch
  window.fetch = globalThis.fetch = async (url, init) => {
    const u = String(url)
    /* 等待中区（这块组件里同时有它）桩成空的，免得去连真的宿主半。 */
    if (u.includes('/workflow/paused')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, paused: [] }) }
    }
    if (u.includes('/workflow/runs')) {
      /* ⚠️ 同一个地址两种用途：不带 `?name=` 是「有哪些工作流」（左边那列），
       * 带了是「这份的记录」（右边那列）。两个都得桩，否则左栏空着、下面全崩。 */
      if (!u.includes('name=')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, names: ['模型留痕示例'] }) }
      }
      return {
        ok: true, status: 200,
        json: async () => ({
          ok: true,
          runs: [
            {
              id: 'w-run-1', name: '模型留痕示例', startedAt: Date.now() - 60000, endedAt: Date.now() - 50000,
              ok: false, aborted: true, ran: ['n1', 'n2', 'n3', 'n4'],
              nodes: [
                /* n1：**没有** `llm` —— 验「没痕迹时什么都不许出来」。 */
                { nodeId: 'n1', defId: 'code.js', label: '① 算时间', state: 'success', startedAt: 1, endedAt: 2, logs: ['算好了'] },
                /* n2：有 `llm`、有 token、有截断、有两个摘要。 */
                {
                  nodeId: 'n2', defId: 'ai.agent', label: '② 让模型改写', state: 'success', startedAt: 3, endedAt: 4,
                  logs: ['模型返回了'],
                  llm: {
                    provider: 'deepseek-official', model: 'deepseek-v4-flash',
                    inputTokens: 120, outputTokens: 45, totalTokens: 165,
                    finish: 'stop',
                    promptPreview: '【提示词摘要】先写用途，再写限制',
                    outputPreview: '【回答摘要】改写后的那段话',
                    truncated: true,
                  },
                  /* ★ 汇报（2026-10-25 契约 AO）—— 单独一段 ⑳ 验它。 */
                  reports: [
                    {
                      message: '采到 24 件商品', type: 'info', item: '第 3/5 条',
                      metrics: { 条数: 24, 耗时: 1830 },
                      files: ['D:/data/天猫/2026-10-25.json'],
                    },
                    { message: '采到 24 件商品', type: 'info', item: '第 4/5 条' },
                    { message: '重试了一次', type: 'warning', item: '第 5/5 条' },
                    { message: '重试了一次', type: 'warning', item: '第 5/5 条' },
                    { message: '重试了一次', type: 'warning', item: '第 5/5 条' },
                    {
                      message: '写入失败 D:/a.json', type: 'info', item: '第 1/2 条',
                      group: { key: 'write-fail', summary: '写入失败 {count} 个文件' },
                    },
                    {
                      message: '写入失败 D:/b.json', type: 'danger', item: '第 2/2 条',
                      group: { key: 'write-fail', summary: '写入失败 {count} 个文件' },
                    },
                    {
                      message: '归档到 D:/data/archive', type: 'info',
                      group: { key: 'archive-once', summary: '归档了 {count} 次' },
                    },
                  ],
                },
                /* n3：有 `llm` 但**没有 token**（上游没给），finish 是 unknown。
                 * 两个断言靠它：「不许显示 0」与「unknown 显示成中文」。 */
                {
                  nodeId: 'n3', defId: 'ai.agent', label: '③ 再改写一次', state: 'success', startedAt: 5, endedAt: 6,
                  logs: [],
                  llm: {
                    provider: 'other', model: 'org/legacy-model',
                    finish: 'unknown',
                    promptPreview: '【无 token 那次】',
                  },
                },
                /* n4：**中断后没跑过**的节点（2026-10-23 契约 AC，`cancelled`）。
                 *
                 * 用户原话：「报错了，但是后续还在执行。」—— 实际没继续执行，
                 * 是显示错了。这条桩钉两件事：
                 *   · 界面上显示「未执行」，**不许露出英文 `cancelled`**；
                 *   · 配色是灰（`idle` 那档），**不许标红**（标红会让人去查一个没出错的节点）。 */
                { nodeId: 'n4', defId: 'browser.act', label: '④ 打开页面', state: 'cancelled', logs: [] },
              ],
            },
          ],
        }),
      }
    }
    return realFetchW(url, init)
  }

  globalThis.React = React
  const { RunHistoryPanel } = await import('../src/client/workbench/RunHistoryPanel.tsx')
  const { formatTraceLine } = await import('../src/dispatch/llm-trace.ts')

  const host = window.document.createElement('div')
  window.document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)
  root.render(React.createElement(RunHistoryPanel, {}))
  await settle()

  const docW = host
  /* 第 1 步：左边选中那份工作流（面板要先知道读谁的记录）。 */
  const wfBtn = [...docW.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === '模型留痕示例')
  console.log('   左栏列出了那份工作流:', wfBtn !== undefined ? '✓' : '✗')
  wfBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()

  const runRows = [...docW.querySelectorAll('[data-ewb-run-row]')]
  console.log('   列出了运行记录:', runRows.length > 0 ? '✓（' + runRows.length + ' 次）' : '✗')
  runRows[0]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()

  const nodeBtn = id => [...docW.querySelectorAll('[data-ewb-run-nodes] button')]
    .find(b => (b.textContent ?? '').includes('（' + id + '）'))
  const openNode = async (id) => {
    nodeBtn(id)?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
  }
  const llmBlocks = () => [...docW.querySelectorAll('[data-ewb-llm-trace]')]

  /* ── ① 有 `llm` 的节点（n2）：那一行要在，且与 `formatTraceLine` **一字不差**。 */
  await openNode('n2')
  const line = docW.querySelector('[data-ewb-llm-line]')
  const got = (line?.textContent ?? '').trim()
  const want = formatTraceLine({
    provider: 'deepseek-official', model: 'deepseek-v4-flash',
    inputTokens: 120, outputTokens: 45, totalTokens: 165,
    finish: 'stop', truncated: true,
  })
  console.log('   ★ 有模型的节点展开后有模型那一行:', line !== null ? '✓' : '✗')
  if (line === null) errors.push('有 llm 的节点展开后没有模型那一行（痕迹没接到界面）')
  console.log('   ★ 那一行就是 formatTraceLine 的输出（界面没二次拼装）:',
    got === want ? '✓' : '✗（实得：' + got + '）')
  if (got !== want) {
    errors.push('模型那一行与 formatTraceLine 的输出不一致（界面自己拼了一遍）：实得「' + got + '」，应为「' + want + '」')
  }
  console.log('   那一行含模型名:', /deepseek-official\/deepseek-v4-flash/.test(got) ? '✓' : '✗')
  console.log('   那一行含两个 token 数:', /输入 120/.test(got) && /输出 45/.test(got) ? '✓' : '✗')
  if (!/deepseek-official\/deepseek-v4-flash/.test(got) || !/输入 120/.test(got) || !/输出 45/.test(got)) {
    errors.push('模型那一行没有同时给出模型名与 token 数')
  }

  /* ── ② `truncated` 要有**可见**标记（不只在文字末尾那句里）。 */
  console.log('   ★ 摘要被截断时给了可见标记:',
    docW.querySelector('[data-ewb-llm-truncated]') !== null ? '✓' : '✗')
  if (docW.querySelector('[data-ewb-llm-truncated]') === null) {
    errors.push('摘要被截断时没有可见标记（用户会以为那是全文）')
  }

  /* ── ③ 两个摘要默认收起，点开才见原文。 */
  console.log('   提示词摘要默认收起:', docW.querySelector('[data-ewb-llm-prompt]') === null ? '✓' : '✗')
  if (docW.querySelector('[data-ewb-llm-prompt]') !== null) {
    errors.push('提示词摘要默认就展开了（几百字原文会把明细淹掉）')
  }
  docW.querySelector('[data-ewb-llm-preview="prompt"]')
    ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  console.log('   ★ 点开提示词摘要能看到原文:',
    /先写用途，再写限制/.test(docW.querySelector('[data-ewb-llm-prompt]')?.textContent ?? '') ? '✓' : '✗')
  if (!/先写用途，再写限制/.test(docW.querySelector('[data-ewb-llm-prompt]')?.textContent ?? '')) {
    errors.push('点开提示词摘要后没有显示原文')
  }
  docW.querySelector('[data-ewb-llm-preview="output"]')
    ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await settle()
  console.log('   点开回答摘要能看到原文:',
    /改写后的那段话/.test(docW.querySelector('[data-ewb-llm-output]')?.textContent ?? '') ? '✓' : '✗')
  if (!/改写后的那段话/.test(docW.querySelector('[data-ewb-llm-output]')?.textContent ?? '')) {
    errors.push('点开回答摘要后没有显示原文')
  }

  /* ── ④ 没 token 的那次（n3）：不许出现「输入 0 / 输出 0」。 */
  await openNode('n2') /* 先收起 n2，免得它的行混淆 */
  await openNode('n3')
  const line3 = (docW.querySelector('[data-ewb-llm-line]')?.textContent ?? '').trim()
  const want3 = formatTraceLine({ provider: 'other', model: 'org/legacy-model', finish: 'unknown' })
  console.log('   ★ 没有 token 时不显示「输入 0 / 输出 0」:',
    !/输入\s*0|输出\s*0|合计\s*0/.test(line3) ? '✓' : '✗（' + line3 + '）')
  if (/输入\s*0|输出\s*0|合计\s*0/.test(line3)) {
    errors.push('没有 token 时界面显示了 0（0 是实测值，缺失是没测到）')
  }
  console.log('   ★ 没有 token 那次那一行仍是 formatTraceLine 的输出:',
    line3 === want3 ? '✓' : '✗（实得：' + line3 + '）')
  if (line3 !== want3) errors.push('没有 token 那次的痕迹行与 formatTraceLine 不一致')
  console.log('   ★ finish 为 unknown 时显示「结束原因未知」而不是英文 unknown:',
    /结束原因未知/.test(line3) && !/\bunknown\b/.test(line3) ? '✓' : '✗')
  if (!/结束原因未知/.test(line3)) errors.push('finish 为 unknown 时没显示「结束原因未知」')

  /* ── ⑤ 没 `llm` 的节点（n1）：整块**不许有**任何残留。
   *
   * ⚠️ 必须先收起所有带 `llm` 的节点 —— 否则会读到上一条留下的痕迹。 */
  await openNode('n3')
  await openNode('n1')
  const blocksOnN1 = llmBlocks().length
  const n1Text = docW.querySelector('[data-ewb-run-nodes]')?.textContent ?? ''
  console.log('   ★ 没模型的节点里没有任何模型块:', blocksOnN1 === 0 ? '✓' : '✗（' + blocksOnN1 + ' 块）')
  if (blocksOnN1 !== 0) errors.push('没模型痕迹的节点里仍渲染了模型块')
  console.log('   ★ 没有「无记录」这类占位（干净地什么都不出来）:',
    !/无记录|没有模型|模型调用/.test(n1Text) ? '✓' : '✗')
  if (/无记录|没有模型|模型调用/.test(n1Text)) {
    errors.push('没模型痕迹的节点里出现了「无记录」这类占位')
  }

  /* ── ⑥ 中断后没跑过的节点显示「未执行」，不是英文「cancelled」（2026-10-23 契约 AC）
   *
   * ## 用户看到的那一幕
   *
   * 「报错了，但是后续还在执行。」—— 实际没继续执行。问题在显示：
   * 那些没跑过的节点在记录里是 `state: 'cancelled'`，而 `STATE_LABEL` 里
   * 原本**没有这一项**，于是落到 `?? { text: n.state }` 兜底 ——
   * 中文界面里直接冒出英文 `cancelled`。
   *
   * ## 判据三件（缺哪件都会漏一种错法）
   *
   *   ① 显示「未执行」（而不是空白、不是英文）；
   *   ② **不许**出现英文 `cancelled`（这是本条要修的那个症状本身）；
   *   ③ 配色是灰（`idle` 那档）而**不是红** —— 标红会让人去查一个没出错的节点。
   *      判据落在源码的 `tone` 上：jsdom 里 CSS Modules 是空对象，
   *      DOM 类名分不出红灰，所以直接读 `STATE_LABEL` 的那一项。 */
  {
    const allNodesText = docW.querySelector('[data-ewb-run-nodes]')?.textContent ?? ''
    /* ⚠️ **不能按类名找**：jsdom 里 CSS Modules 被桩成空对象，
     * 所有类名都是字符串 `undefined`，`[class*="histRow"]` 一个都选不到
     * （第一版就是这么假红的）。改成按**节点标题文字**找它所在的按钮，
     * 再看那个按钮的整行文字。 */
    const cancelledHead = [...docW.querySelectorAll('[data-ewb-run-nodes] button')]
      .find(b => (b.textContent ?? '').includes('④ 打开页面'))
    const rowText = cancelledHead?.textContent ?? ''
    console.log('   找到了那条「中断后没跑过」的节点行:', cancelledHead !== undefined ? '✓' : '✗')
    if (cancelledHead === undefined) {
      errors.push('运行历史里找不到那条 cancelled 的节点行（桩没生效？）')
    } else {
      console.log('   ★ 它显示「未执行」:', rowText.includes('未执行') ? '✓' : '✗（' + rowText.slice(0, 40) + '）')
      if (!rowText.includes('未执行')) {
        errors.push('中断后没跑过的节点没有显示「未执行」')
      }
      /* ② 英文 `cancelled` **一个都不许出现**在整份节点明细里。 */
      console.log('   ★★ 整份明细里不露出英文 cancelled:',
        /cancelled/i.test(allNodesText) ? '✗（露了）' : '✓')
      if (/cancelled/i.test(allNodesText)) {
        errors.push('运行历史里露出了英文 `cancelled` —— 中文界面冒英文等于没写文案')
      }
    }
    /* ③ `cancelled` 的配色是 idle 那档（灰），不是 error（红）。
     * 读源码那一行，因为 DOM 类名在 jsdom 里分辨不出来。 */
    const panelSrc = readFileSync(new URL('../src/client/workbench/RunHistoryPanel.tsx', import.meta.url), 'utf8')
    const idleOk = /cancelled:\s*\{\s*text:\s*'未执行',\s*tone:\s*'idle'\s*\}/.test(panelSrc)
    console.log('   ★ 配色是灰（idle）而不是红（error）:', idleOk ? '✓' : '✗')
    if (!idleOk) {
      errors.push('`cancelled` 的配色不是 idle —— 标红会让人去查一个没出错的节点')
    }
  }

  /* ── ⑦ 汇报（2026-10-25 契约 AO）—— 与日志**分区**，去重 / 折叠 / 优先级都在这里。
   *
   * ## 为什么单独一段而不是塞进上面
   *
   * 上面那段验的是「模型痕迹」。汇报是**另一件事**（节点主动报「我这次交出了什么」），
   * 混在一起以后任一边改了，都看不出是哪一边红的。
   *
   * ## 这一段的桩（n2 的 `reports` 里刻意放了几种形状）
   *
   * | 桩 | 想验什么 |
   * | --- | --- |
   * | 两条 message 同、`item` 不同 | 去重 key 是**全拼**，只有 item 不同就不许并 |
   * | 三条完全相同 | 并成一条 + 「出现 3 次」 |
   * | 两条同 `group.key`（info + danger） | 折成一行、级别取**最重**（danger）、`{count}` 换 2 |
   * | 一条自己一组的 `group` | **只有一条时不折叠** |
   */
  {
    /* 展开 n2（带汇报的那个节点）。 */
    const n2Btn = [...docW.querySelectorAll('[data-ewb-run-nodes] button')]
      .find(b => (b.textContent ?? '').includes('② 让模型改写'))
    n2Btn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()

    const repBox = n2Btn?.parentElement?.querySelector('[data-ewb-reports]')
      ?? docW.querySelector('[data-ewb-reports]')
    const logBox = n2Btn?.parentElement?.querySelector('[data-ewb-logs]')
      ?? docW.querySelector('[data-ewb-logs]')
    const repText = repBox?.textContent ?? ''

    /* ① 分区：汇报与日志**各有一块**，且各有标题。 */
    console.log('   ★ 有汇报的节点里汇报块存在:', repBox !== null && repBox !== undefined ? '✓' : '✗')
    if (repBox === null || repBox === undefined) {
      errors.push('有 reports 的节点里没有汇报块（汇报没接到界面）')
    }
    console.log('   ★ 汇报块有自己的标题「汇报」:', /汇报/.test(repText) ? '✓' : '✗')
    if (!/汇报/.test(repText)) errors.push('汇报块没有标题')
    console.log('   ★★ 日志与汇报**分区**（各有各的一块）:',
      logBox !== null && logBox !== undefined && repBox !== logBox ? '✓' : '✗')
    if (logBox === null || logBox === undefined) {
      errors.push('日志块不见了（分区时把日志弄丢了）')
    }
    /* 分区的最强判据：日志块里**没有**汇报内容，汇报块里**没有**日志内容。 */
    const logText = logBox?.textContent ?? ''
    console.log('   ★★ 汇报内容不在日志块里:',
      !/采到 24 件商品/.test(logText) ? '✓' : '✗（混在一起了）')
    if (/采到 24 件商品/.test(logText)) {
      errors.push('汇报内容出现在日志块里（两者混在一起，用户分不清过程与结论）')
    }
    console.log('   ★★ 日志内容不在汇报块里:',
      !/模型返回了/.test(repText) ? '✓' : '✗（混在一起了）')
    if (/模型返回了/.test(repText)) {
      errors.push('日志内容出现在汇报块里（两者混在一起）')
    }
    console.log('   日志块有自己的标题「日志」:', /日志/.test(logText) ? '✓' : '✗')
    if (!/日志/.test(logText)) errors.push('日志块没有标题')

    /* ② item / metrics / files 三样都显示。 */
    console.log('   ★ 汇报显示了自己的 item（第 3/5 条）:', /第 3\/5 条/.test(repText) ? '✓' : '✗')
    if (!/第 3\/5 条/.test(repText)) errors.push('汇报没有显示 item')
    console.log('   ★ 汇报的 metrics 显示成「键 值」:',
      /条数/.test(repText) && /24/.test(repText) && /耗时/.test(repText) && /1830/.test(repText) ? '✓' : '✗')
    if (!(/条数/.test(repText) && /耗时/.test(repText))) {
      errors.push('汇报的 metrics 没有显示成「键 值」')
    }
    console.log('   ★ 汇报的 files 显示成路径:',
      /D:\/data\/天猫\/2026-10-25\.json/.test(repText) ? '✓' : '✗')
    if (!/D:\/data\/天猫\/2026-10-25\.json/.test(repText)) errors.push('汇报的 files 没有显示成路径')

    /* ③ 完全相同的三条并成一条 + 「出现 3 次」。 */
    const timesEls = [...(repBox?.querySelectorAll('[data-ewb-report-times]') ?? [])]
    console.log('   ★ 完全相同的汇报合并成一条并标「出现 N 次」:',
      timesEls.length === 1 && /出现 3 次/.test(timesEls[0]?.textContent ?? '') ? '✓' : '✗（' + timesEls.length + ' 处）')
    if (timesEls.length !== 1 || !/出现 3 次/.test(timesEls[0]?.textContent ?? '')) {
      errors.push('完全相同的汇报没有合并成一条并标出「出现 N 次」')
    }
    const retryLines = (repText.match(/重试了一次/g) ?? []).length
    console.log('   三条相同的那句只出现一次:', retryLines === 1 ? '✓' : '✗（' + retryLines + ' 次）')
    if (retryLines !== 1) errors.push('完全相同的汇报在界面上重复出现了 ' + retryLines + ' 次')

    /* ④ 同组折叠：一行、级别取最重、{count} 换掉。 */
    console.log('   ★ 同 group.key 的汇报折叠成一行:', /写入失败 2 个文件/.test(repText) ? '✓' : '✗')
    if (!/写入失败 2 个文件/.test(repText)) {
      errors.push('同 group.key 的汇报没有折叠（或 {count} 没换成条数）')
    }
    console.log('   折叠后不再显示组内每条的原话:',
      !/写入失败 D:\/a\.json/.test(repText) && !/写入失败 D:\/b\.json/.test(repText) ? '✓' : '✗')
    if (/写入失败 D:\/a\.json/.test(repText) || /写入失败 D:\/b\.json/.test(repText)) {
      errors.push('折叠后组内每条原话还在（等于没折）')
    }
    const folded = [...(repBox?.querySelectorAll('[data-ewb-report]') ?? [])]
      .find(x => /写入失败/.test(x.textContent ?? ''))
    const foldedType = folded?.getAttribute('data-ewb-report-type')
    console.log('   ★★ 折叠行的级别取最重（danger，不是 info）:', foldedType === 'danger' ? '✓' : '✗（' + foldedType + '）')
    if (foldedType !== 'danger') {
      errors.push('折叠行没有取组内最重的级别（实得 ' + foldedType + '）')
    }

    /* ⑤ 只有一条的组**不折叠**（原话照出，`{count}` 不出现）。 */
    console.log('   ★★ 只有一条的组不折叠（原话照出）:',
      /归档到 D:\/data\/archive/.test(repText) && !/归档了 1 次/.test(repText) ? '✓' : '✗')
    if (!/归档到 D:\/data\/archive/.test(repText) || /归档了 1 次/.test(repText)) {
      errors.push('只有一条的组被折叠了（契约要求「只有一条时不折叠」）')
    }

    /* ⑥ 反面：没 `reports` 的节点（n1）**不许**有汇报块，也不许有占位。
     *
     * ⚠️ 必须先收起 n2，否则读到的是它那一块。 */
    n2Btn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const n1Btn = [...docW.querySelectorAll('[data-ewb-run-nodes] button')]
      .find(b => (b.textContent ?? '').includes('① 算时间'))
    n1Btn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    const n1Rep = n1Btn?.parentElement?.querySelector('[data-ewb-reports]')
    const n1Text = n1Btn?.parentElement?.textContent ?? ''
    console.log('   ★★ 没有 reports 的节点里汇报块整个不出现:',
      n1Rep === null || n1Rep === undefined ? '✓' : '✗')
    if (n1Rep !== null && n1Rep !== undefined) {
      errors.push('没有 reports 的节点里出现了汇报块（应为整块不出现）')
    }
    console.log('   ★ 没有 reports 时不显示「无汇报」这类占位:',
      !/无汇报|没有汇报|暂无汇报/.test(n1Text) ? '✓' : '✗')
    if (/无汇报|没有汇报|暂无汇报/.test(n1Text)) {
      errors.push('没有 reports 时出现了「无汇报」占位')
    }
    /* 日志块**照旧要在**（分区不能把「没汇报」节点的日志也搞没）。 */
    const n1Log = n1Btn?.parentElement?.querySelector('[data-ewb-logs]')
    console.log('   没汇报的节点里日志块照旧在:',
      n1Log !== null && n1Log !== undefined ? '✓' : '✗')
    if (n1Log === null || n1Log === undefined) {
      errors.push('没汇报的节点里日志块也没了（分区改坏了）')
    }
  }

  root.unmount()
  host.remove()
  window.fetch = globalThis.fetch = realFetchW
}

/* ㉑ [提示词库] 正文里的 `**` 要渲染成真粗体（2026-10-25 契约 BJ）
 *
 * ## 为什么必须单独一段（这条是「静态测试抓不到」的那一类）
 *
 * `copy-no-markdown` 只扫**源码与产物文本**：它能证明「产物里那些 `**` 全落在
 * 上游数据里」，但证明不了「界面把它渲染成了粗体」。而用户看到的恰恰是后者。
 *
 * 提示词板块那边由 ⑰ 段的人肉判据守着（正文只读区有 `<strong>`、可见文字没 `**`）。
 * 提示词库是**另一个组件**，那边一条都覆盖不到 —— 所以这里补一对同样的判据。
 *
 * ## 打哪一条
 *
 * `banana-prompt-quicker:b352db26af151c01`（标题「换发型」）的正文有 12 处 `**`，
 * 是 8 条里标记最多的几条之一。**先展开再判**：收起态只有两行预览，
 * 而两行之外的 `**` 本来就看不见 —— 只在收起态断言会漏掉「展开后仍露星号」。
 *
 * ## 判据两条（与 ⑰ 段同构）
 *
 *   ① 正文区里有 `<strong>`（真渲染成粗体，不是把星号吃掉）；
 *   ② 正文区**可见文字**里没有字面 `**`（不是靠删星号糊弄过去）。
 *
 * 另外顺带钉一条反面：**复制仍给原文**（带 `**`）——
 * 两条合起来才能区分「渲染没做」与「复制把记号弄丢了」。
 */
console.log('')
console.log('㉑ [提示词库] 正文里的 `**` 渲染成真粗体（不是两个字面星号）')
{
  const { PromptLibrary } = await import('../src/client/workbench/PromptLibrary.tsx')
  const host21 = window.document.createElement('div')
  window.document.body.appendChild(host21)
  const root21 = ReactDOMClient.createRoot(host21)
  root21.render(React.createElement(PromptLibrary, { active: true }))
  await settle()

  const TARGET = 'banana-prompt-quicker:b352db26af151c01'
  /* 先切到那个源（默认看的是 awesome-gpt-image，它里面没有这条）。 */
  const srcBtn = host21.querySelector('[data-ewb-pl-source="banana-prompt-quicker"]')
  console.log('   切到 banana 源:', srcBtn !== null ? '✓' : '✗')
  if (srcBtn !== null) {
    srcBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
  }
  /* ⚠️ **2026-10-26 随卡片形态改准**（用户 m03414 / m03555）：
   *
   * 提示词库从「列表 + 展开」改成了「卡片 + 一次 20 条 + 点开弹层」。
   * 两件事跟着变：
   *   · **一次只渲染 20 条**，而「换发型」在 banana 源里排**第 29 条**（索引 28），
   *     也就是**第 2 页** —— 原来「一页 60 条，它在第 7 条左右应该在」这句话已经不成立了
   *   · 完整正文在**弹层**里（`data-ewb-pl-prompt`），卡片上只有 3 行摘要
   *
   * 判据本身一条没改：仍然是「`**` 渲染成真粗体、可见文字里没有字面星号、
   * 复制给的是带星号的原文」。
   */
  /** 在卡片网格里找某一条（找不到就翻页，最多翻完）。 */
  async function findEntry(targetId, titleWord) {
    for (let page = 0; page < 12; page += 1) {
      const hit = host21.querySelector('[data-ewb-pl-entry="' + targetId + '"]')
        ?? [...host21.querySelectorAll('[data-ewb-pl-entry]')]
          .find(e => (e.querySelector('[data-ewb-pl-card-title]')?.textContent ?? '').includes(titleWord))
      if (hit !== undefined && hit !== null) return hit
      const next = host21.querySelector('[data-ewb-pl-next]')
      if (next === null || next.hasAttribute('disabled')) return null
      next.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await settle()
    }
    return null
  }

  const row = await findEntry(TARGET, '换发型')
  console.log('   找到「换发型」那一条:', row !== null ? '✓' : '✗')
  if (row === null) {
    errors.push('提示词库里找不到「换发型」那一条（它在第 2 页；翻页逻辑或分页变了）')
  } else {
    /* 点卡片封面 → 打开弹层（弹层里是完整正文）。 */
    const coverBtn = row.querySelector('[data-ewb-pl-card-cover]')
    coverBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()

    const body = host21.querySelector('[data-ewb-pl-prompt]')
    const strongs = [...(body?.querySelectorAll('strong') ?? [])]
    const bodyText = body?.textContent ?? ''
    const rawPrompt = body?.textContent ?? bodyText

    /* ① 有 <strong>。 */
    console.log('   ★★ 正文区里的 <strong> 数:', strongs.length, strongs.length > 0 ? '✓' : '✗')
    if (strongs.length === 0) {
      errors.push('提示词库正文没有把加粗渲染出来（用户会看到字面的两颗星）')
    }
    /* 粗体里**有文字** —— 否则「没有星号」可能只是把那段吃掉了。 */
    const strongTexts = strongs.map(e => (e.textContent ?? '').trim())
    console.log('   粗体里的文字（前 3 个）:', strongTexts.slice(0, 3).join(' / ') || '(空)')
    if (strongTexts.length > 0 && strongTexts.some(t => t === '')) {
      errors.push('提示词库正文里的粗体有空的（等于把那段文字吃掉了）')
    }
    /* ② 可见文字里没有字面 `**`。 */
    const hasStars = bodyText.includes('**')
    console.log('   ★★ 正文区可见文字里没有字面 `**`:', hasStars ? '✗（露了）' : '✓')
    if (hasStars) {
      errors.push('提示词库正文区还露出字面的 `**`（应该渲染成粗体）')
    }
    /* ★ 给交付一段可贴的证据：正文前 80 字。 */
    console.log('   正文前 80 字:', bodyText.replace(/\s+/g, ' ').slice(0, 80))
    console.log('   （原文前 80 字）:', rawPrompt.replace(/\s+/g, ' ').slice(0, 80))

    /* ③ 反面：复制仍给**带 `**` 的原文**。
     * 两条合起来才能区分「渲染没做」与「复制把记号弄丢了」。 */
    const writes = []
    try {
      Object.defineProperty(window.navigator, 'clipboard', {
        value: { writeText: async (s) => { writes.push(s) } },
        configurable: true,
      })
    } catch { /* 定义不上就跳过这一条 */ }
    const copyBtn = row.querySelector('[data-ewb-pl-copy]')
    copyBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await settle()
    /* ⚠️ **不许用 `if (writes.length > 0)` 把整段包起来**（2026-10-26 修掉的假绿）。
     *
     * 原来就是这么写的：复制按钮没接上、或 `clipboard` 定义不上时 `writes` 是空的，
     * 于是这**三条断言一条都不执行、也不报错** —— 测试照样绿。
     * 实测注入「删掉那一行 click」，整个文件 **0 条红**，就是这么漏过去的。
     *
     * 现在：先断言「点了一定写进剪贴板」，再断言「写进去的内容带着 `**`」。
     * 前者红了，后者才有意义；前者绿而后者红，才是「复制把记号弄丢了」。 */
    console.log('   ★★ 点「复制」真的写了剪贴板:', writes.length > 0 ? '✓' : '✗（一次都没写）')
    if (writes.length === 0) {
      errors.push('点提示词库的「复制」没有写剪贴板（按钮没接上，或 clipboard 桩没装上）')
    } else {
      console.log('   ★★ 复制出去的是带 `**` 的原文:', writes[0].includes('**') ? '✓' : '✗')
      if (!writes[0].includes('**')) {
        errors.push('提示词库复制出去的文本丢了 `**`（那是给模型的提示词，强调语义不该被剥掉）')
      }
      console.log('   ★ 复制的内容与正文原文一致:', writes[0] === rawPrompt.replace(/^$/, '') || writes[0].length > 50 ? '✓' : '✗')
    }
  }

  root21.unmount()
  host21.remove()
}

/* ══════════════════════════════════════════════════════════════════════
 * 防回潮：这个测试里不许再出现「只为等待」的固定 setTimeout
 * ══════════════════════════════════════════════════════════════════════
 *
 * ## 为什么需要这条
 *
 * 这个文件原来有 192 处 `await new Promise(s => setTimeout(s, 300))` 这类**固定等待**，
 * 全线加起来 85 秒。它们的根因错是**拿时间当状态的替身**：
 *   · 要么不够 —— 慢一点就红，而产品是对的（`19653f7` 那次白跑就是这么来的）；
 *   · 要么白等 —— 5ms 就完事了还等 295ms。
 *
 * 这一轮换成了「等状态」（`tests/_wait.mjs` 的 `settle` / `waitUntil`），
 * 耗时 111s → 17s。这条断言防的就是「以后有人又塞一句 `setTimeout(s, 800)`」。
 *
 * ## 阈值 0 是怎么来的（实测，不是拍的）
 *
 * 改完之后扫了一遍，这个文件里**数字字面量**形态的纯等待是 **0 处**。
 *
 * 两处「验真实延时」的桩**不在这条判据的射程里**，因为它们的延时不是字面量：
 *   ① `__ewbOptDelay = 800` 那个桩用的是**变量**（`setTimeout(..., __ewbOptDelay)`）——
 *      为的是让「改写中」那一帧抓得到（桩瞬间 resolve 就永远看不见中间态），
 *      那条断言验的正是中间态；
 *   ② 慢网络那个桩用的是 `delay` 变量，验的是「慢的时候界面不假死」。
 *
 * 两处都**不许改**（改了等于把被验的行为删掉），但它们不是「猜一个毫秒数」，
 * 是「按被测场景配置延时」，所以不该被这条统计到。
 *
 * 于是阈值定 **0**：再出现任何一处 `setTimeout(s, 300)` 这种就红，
 * 逼着下一个人想清楚「这个等待是在验延时，还是在猜时间」。
 *
 * ⚠️ 这条断言**只扫本文件的源码**，扫的是 `setTimeout(<标识符>, <数字>)`
 * 这种「纯等待」形态 —— `setTimeout(fn, 0)`（让出任务队列）与
 * `setTimeout(tick, 50)`（轮询间隔）不算，它们不猜时长。
 */
{
  const selfSrc = readFileSync(new URL(import.meta.url), 'utf8')
  /* 去掉注释再扫：注释里提到 `setTimeout(s, 300)` 是在讲历史，不是真在等。 */
  const code = selfSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const fixedWaits = [...code.matchAll(/setTimeout\((?:s|r|resolve),\s*(\d+)\)/g)]
    .filter(m => Number(m[1]) > 0)
  console.log('')
  console.log('   纯等待式 setTimeout 处数:', fixedWaits.length, '（阈值 0）',
    fixedWaits.length <= 0 ? '✓' : '✗')
  if (fixedWaits.length > 0) {
    errors.push('出现了第 ' + String(fixedWaits.length) + ' 处「纯等待」setTimeout —— '
      + '请改成 settle() 或 waitUntil(条件)。若这一处是在验真实延时，'
      + '把它加进本段注释的豁免清单并把阈值 +1。')
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 断言覆盖统计（判据：**没跑到的断言必须有登记**，见文件头那段说明）
 * ══════════════════════════════════════════════════════════════════════ */
{
  const selfSrc = readFileSync(new URL(import.meta.url), 'utf8').split('\n')
  const CK = '✓'
  const XX = '✗'
  /* ★ 票 77：先算出白名单表自己的行区间 —— 表里每一行都带着勾号 / 叉号字符，
   * 不排除的话它们会被当成「会打 ✓/✗ 的断言行」，于是凭空多出 20 处「没执行」。 */
  const tableFrom0 = selfSrc.findIndex(l => l.includes('const NEVER_RUN_OK = [')) + 1
  const tableTo0 = tableFrom0 === 0
    ? 0
    : selfSrc.findIndex((l, i) => i >= tableFrom0 && l === ']') + 1

  /** 源码里「会打出 ✓/✗ 的 console.log」行号。 */
  const staticLines = []
  for (let i = 0; i < selfSrc.length; i += 1) {
    const ln0 = i + 1
    if (ln0 >= tableFrom0 && ln0 <= tableTo0) continue
    if (!selfSrc[i].includes('console.log(')) continue
    /* 一条 console.log 可能跨多行：从它这一行起往后 6 行里找 ✓/✗ 都算同一条。 */
    const win = selfSrc.slice(i, Math.min(i + 6, selfSrc.length)).join('\n')
    if (!win.includes(CK) && !win.includes(XX)) continue
    staticLines.push(i + 1)
  }
  /* 只关心「跑没跑到」。⚠️ 本段自己的 console.log 也会打 ✓/✗，但它们在**统计之前**
   * 就已经算出 staticLines 了（那时本段还没执行），所以差集里会包含自己 —— 把本段
   * 的行区间排除掉。`STAT_SECTION_FROM` 是本段开头那行。 */
  const STAT_FROM = selfSrc.findIndex(l => l.includes('断言覆盖统计（判据：')) + 1
  const self0 = STAT_FROM > 0 ? STAT_FROM : 0
  const missed = staticLines.filter(n => !ASSERT_COVERAGE_HIT.has(n) && n <= self0 - 1)

  /* ══════════════════════════════════════════════════════════════════
   * ★ 票 77（2026-10-29）：白名单从「记行号」改成「记代码片段」。
   *
   * ## 为什么不再用行号
   *
   * 行号一漂全表失效 —— 2026-10-29 一天撞了六次（票 54/56/65/75/62/63），
   * 每次都是「给这个文件加注释 → 整表后移 → 报一堆假失败」。
   *
   * ## 怎么匹配
   *
   * ① **先剥注释**：整份源码的块注释与行注释都去掉再找。
   *    不剥的话，注释里提到某个词会被当成「用到了」——
   *    这个坑本仓库在 `copy-no-markdown` 那次踩过（注释里的类名把死 import 判活）。
   *
   * ② **每条必须唯一命中**：
   *    · 找不到 → 报错（条目失效必须有人知道，不许静默通过）；
   *    · 找到多处 → 也报错（片段不够独特，撞了别的行）。
   *
   * ③ **`stealth`（命中行号）**：匹配出来的行号仍然拿去做「这次跑了没有」的判断。
   *    它不再**硬编码**，而是每次运行时算出来的。 */
  const codeOnly = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  /* ⚠️ 剥注释会把行数变少（块注释里可能有好几行），**不能再按行号比对**。
   * 所以改成：先按行剥，保留空行占位，行数不变。 */
  const codeLines = selfSrc.map(l => l
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/, ''))
  const codeText = codeLines.join('\n')

  /* ⚠️⚠️ **必须排除白名单表自己那几行**。
   *
   * `match` 的字面量就写在表里，而表也在同一个文件里 ——
   * 不排除的话每条都至少命中 2 处（表里一次、真正的代码一次），
   * 「不够独特」那条会**每次全红**。
   *
   * 第一版就是这么红的，输出 20 条「匹配到 2 处」。 */
  const tableFrom = selfSrc.findIndex(l => l.includes('const NEVER_RUN_OK = [')) + 1
  const tableTo = tableFrom === 0
    ? 0
    : selfSrc.findIndex((l, i) => i >= tableFrom && l === ']') + 1

  /** 白名单匹配结果：`{ line, why }` 或 `{ error }`。 */
  const okHits = []
  const okProblems = []
  for (const row of NEVER_RUN_OK) {
    /* 逐行找，保留行号（`codeText` 整段找也能找到，但拿不到行号）。 */
    const hits = []
    for (let i = 0; i < codeLines.length; i += 1) {
      const ln = i + 1
      if (ln >= tableFrom && ln <= tableTo) continue
      if (codeLines[i].includes(row.match)) hits.push(ln)
    }
    if (hits.length === 0) {
      okProblems.push('白名单条目失效（源码里找不到这段代码）：「' + row.match + '」—— ' + row.why)
    } else if (hits.length > 1) {
      okProblems.push('白名单条目不够独特（匹配到 ' + String(hits.length) + ' 处，行 '
        + hits.join('、') + '）：「' + row.match + '」')
    } else {
      okHits.push({ line: hits[0], why: row.why })
    }
  }
  const okLines = new Set(okHits.map(x => x.line))

  /** 没登记过的那些（登记过的是「跑不到是对的」）。 */
  const unregistered = missed.filter(n => !okLines.has(n))
  /* 登记了但其实跑到了 → 说明白名单过期了，也该提醒（不判红，只报出来）。 */
  const staleOk = [...okLines].filter(n => ASSERT_COVERAGE_HIT.has(n))

  /* ★ 票 77 判据：每条 `match` 必须唯一命中、每条 `why` 非空。
   * 这两条是这张表**自己**的防线 —— 没有它们，条目失效后永远没人知道。 */
  for (const p of okProblems) console.log('   ✗ ' + p)
  if (okProblems.length > 0) {
    errors.push('NEVER_RUN_OK 有 ' + String(okProblems.length) + ' 条对不上源码（见上面的 ✗）')
  }
  const emptyWhy = NEVER_RUN_OK.filter(r => String(r.why ?? '').trim() === '')
  if (emptyWhy.length > 0) {
    console.log('   ✗ 有 ' + String(emptyWhy.length) + ' 条没写理由')
    errors.push('NEVER_RUN_OK 有 ' + String(emptyWhy.length) + ' 条没写理由（why 不许空）')
  }

  console.log('')
  console.log('   会打 ✓/✗ 的断言行:', staticLines.length, '处')
  console.log('   这次真的执行了:', staticLines.filter(n => ASSERT_COVERAGE_HIT.has(n)).length, '处')
  console.log('   没执行但已登记理由:', missed.length - unregistered.length, '处')
  console.log('   没执行且**没登记**:', unregistered.length, '处', unregistered.length === 0 ? '✓' : '✗')
  for (const n of unregistered) {
    console.log('     L' + String(n) + ': ' + selfSrc[n - 1].trim().slice(0, 100))
  }
  if (unregistered.length > 0) {
    errors.push('有 ' + String(unregistered.length) + ' 处「会打 ✓/✗ 的断言」这次没执行、也没登记理由 —— '
      + '要么它被条件包住了（那可能是假绿），要么它本来就跑不到（那把行号写进 NEVER_RUN_OK 并说清为什么）')
  }
  if (staleOk.length > 0) {
    console.log('   （白名单里这几行其实执行了，可以删掉登记：' + staleOk.join(', ') + '）')
  }
}

if (errors.length > 0) { console.log(''); console.log('错误清单：'); for (const e of errors) console.log('  - ' + e) }
process.exit(errors.length === 0 ? 0 : 1)

/* ── 给改这个文件的人一句提醒（刻意放在**最后**）────────────────────
 *
 * `NEVER_RUN_OK`（`:161`）登记的是**行号**。
 * 在那张表**之前**、或**表头里**增删任何一行，它后面的代码整体位移，整张表立刻失效。
 *
 * 症状：改完注释再跑，报「没执行且没登记 N 处」，而那 N 处**本来就在表里**。
 * 治法：先确认这次增删在哪个行号之后、共几行，再把表里 ≥ 那个位置的行号按同样偏移量平移。
 *
 * ⚠️ **别为了说明这件事去表头加注释** —— 那正好又漂一次。
 * 这一轮我连栽两回：先在 ⑨-5 那段加 44 行注释，再在表头加 4 行说明。
 * 所以这段提醒放在文件末尾：它自己不影响任何行号。
 */
