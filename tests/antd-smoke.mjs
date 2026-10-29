/** antd 6 冒烟：五个组件在 jsdom 里真的挂得出来、不报错。
 *
 * ## 为什么要这个文件
 *
 * 用户批了「照抄参考项目，可以用组件库」（m03555）。装 antd 之前必须先证明
 * **它在我们这个宿主里跑得起来**，否则后面三单（提示词卡片、工作台、配置页）
 * 全建在沙子上。这就是这道闸门。
 *
 * ## ⚠️ 这个测试验不到的一件事（必须知道）
 *
 * 本仓库 `node_modules` 里是 **React 19.3.0**（`@xyflow/react` 带进来的），
 * 而真机（dsh 桌面端）共享的是 **React 18.3.1**
 * （`refs/deepseek-harness@62962ee4/pnpm-lock.yaml` 的 `react@18.3.1`，
 * `packages/client/web/package.json` 写 `^18.2.0`，且在 `PLATFORM_MODULES` 里
 * 作为**唯一一份**共享给所有插件）。
 *
 * 所以：**这个文件跑的是 React 19，真机是 18。** 两个大版本都验过才能说「能跑」：
 *   · 这里（19）：`node scripts/run-tests.mjs antd-smoke`
 *   · 真机版本（18）：P0 报告里另附一次在隔离目录装的 React 18.3.1 下跑的同一套断言
 *
 * 本文件把 `React.version` 打进输出，就是为了让每次跑的人**看得见自己验的是哪个版本**，
 * 而不是以为「绿了就等于真机能跑」。
 *
 * ## 为什么用 `require('antd')` 而不是 `antd/es/index.js`
 *
 * 源码里必须写 `antd/es/index.js`（见下面「按需引入」那段），但**测试环境不能**：
 * antd 的 `es/` 产物内部是**不带扩展名的导入**（`from './_util/warning'`），
 * Node 的 ESM 解析器不认，只有打包器认。测试里没有打包器，所以这里走 CJS 的
 * `lib/` —— 与 `es/` 是同一份组件实现的两种编译产物。
 * 源码写法本身由下面那两条「源码断言」钉住。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')
const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = React

let failed = 0
/**
 * 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '   ✓ ' : '   ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/* ── jsdom 底座 ───────────────────────────────────────────────────────
 * antd 6 用到这几样浏览器 API，jsdom 没给全，缺一个就抛。补的都是**空实现**，
 * 它们只影响「量尺寸 / 观察变化」，不影响「组件结构对不对」这些断言。
 */
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
/* Node 24 的 `globalThis.navigator` 只有 getter，直接赋值会抛。 */
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true })
for (const key of ['HTMLElement', 'Element', 'Node', 'SVGElement', 'DocumentFragment', 'MouseEvent', 'CustomEvent']) {
  globalThis[key] = window[key]
}
/* React 18/19 的 `act()` 需要这个开关；缺了每条渲染都打「environment not configured」。 */
globalThis.IS_REACT_ACT_ENVIRONMENT = true
/* jsdom 没实现「带伪元素的 getComputedStyle」，antd 会用它量动画状态。
 * 把伪元素参数吞掉即可 —— 返回的仍是真样式声明。 */
const origGetComputedStyle = window.getComputedStyle.bind(window)
window.getComputedStyle = (el) => origGetComputedStyle(el)
globalThis.getComputedStyle = window.getComputedStyle
window.matchMedia = (query) => ({
  matches: false, media: query, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
  dispatchEvent: () => false,
})
class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }
window.ResizeObserver = ResizeObserverStub
globalThis.ResizeObserver = ResizeObserverStub

const consoleErrors = []
const origConsoleError = console.error
console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')); origConsoleError(...args) }

const antdPkg = require('antd/package.json')
console.log('')
console.log('=== antd 冒烟（React ' + React.version + ' / antd ' + antdPkg.version + '）===')

/* 按需引入：照纪律只解构需要的五个，绝不 `const antd = require('antd')` 整包拿走。 */
const { Button, Card, Input, Modal, Select, Tabs } = require('antd')

const h = React.createElement
const root = createRoot(window.document.getElementById('root'))

let renderError = null
try {
  await act(async () => {
    root.render(
      h('div', null,
        h(Card, {
          title: '卡片标题',
          hoverable: true,
          cover: h('img', { src: 'x.png', alt: '封面', loading: 'lazy' }),
        }, '卡片正文'),
        h(Input, { placeholder: '输入点什么', defaultValue: 'abc' }),
        h(Select, { placeholder: '选一个', options: [{ label: '甲', value: 'a' }, { label: '乙', value: 'b' }] }),
        h(Tabs, { items: [{ key: '1', label: '素材', children: '素材内容' }, { key: '2', label: '提示词', children: '提示词内容' }] }),
        h(Modal, { open: true, title: '对话框', footer: null }, '对话框正文'),
        h(Button, null, '复制'),
      ),
    )
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
} catch (error) {
  renderError = error
}

const hostHtml = window.document.getElementById('root').innerHTML
/* Modal 走 portal 挂到 body，不在容器里，所以整页一起查。 */
const pageHtml = window.document.body.innerHTML

/* ── 判据 1：五个组件都渲染成功、无报错 ── */
check('五个组件渲染不抛异常', renderError === null, renderError === null ? 'ok' : String(renderError && renderError.message))
check('Card 渲染出来了', hostHtml.includes('卡片标题') && hostHtml.includes('卡片正文'))
check('Card 的封面图带 loading="lazy"（P1 的图必须懒加载）',
  /<img[^>]+loading="lazy"/.test(hostHtml))
check('Input 渲染出来了', /<input/.test(hostHtml) && hostHtml.includes('abc'))
/* Select 收着时选项面板**不渲染**（只在展开后才挂下拉层），
 * 所以这里验结构（`.ant-select` 在、占位文字在），不验「甲」两个字 ——
 * 那属于「点开下拉之后」，不是这个冒烟要证明的事。 */
check('Select 渲染出来了（容器类名 + 占位文字）',
  /class="[^"]*ant-select[^"]*"/.test(hostHtml) && hostHtml.includes('选一个'))
check('Tabs 渲染出来了', hostHtml.includes('素材') && hostHtml.includes('提示词'))
check('Modal 渲染出来了（portal 在 body 上）', pageHtml.includes('对话框正文'))
check('Button 渲染出来了', hostHtml.includes('复'))
check('渲染过程 console.error 为空（React / antd 都没抱怨）',
  consoleErrors.length === 0,
  consoleErrors.length === 0 ? 'ok' : consoleErrors.slice(0, 2).map(s => s.slice(0, 200)).join(' | '))

/* ── 判据 4：按需引入（源码断言） ─────────────────────────────────────
 * 这一条不能靠「渲染成功」间接证明：整包引入照样渲染成功，只是产物大一倍。
 * 所以直接读源码，钉住两条纪律。
 */
{
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const WORKBENCH = 'src/client/workbench'

  /** 递归列出某目录下所有 .ts / .tsx 源文件。 */
  function walk(dir) {
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { out.push(...walk(full)); continue }
      if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
    }
    return out
  }

  const files = walk(WORKBENCH)
  /* ## 这一组断言 2026-10-26 改过一次口径（不是放宽，是保住它真正要防的东西）
   *
   * 原来这里是「禁止 `from 'antd'` 裸根入口」，理由是当时 **`mainFields` 没配**，
   * 裸根入口会解析到 CJS 的 `lib/`，整包 650 个文件全进产物（+4.20 MB）。
   *
   * 后来 `tsdown.preset.ts` 加了 `mainFields: ['browser','module','main']`，
   * 裸根入口已经能正确走 `es/`（实测同 5 个组件 177 个文件 / +0.97 MB）。
   * 于是「禁止裸根入口」变成了**一条过时的禁令** —— 它会挡掉完全正确的照抄写法。
   *
   * 现在改成**守真正的那件事**：只要按需解构引入就行，写不写 `/es/` 都可以；
   * 真正不许的是 **①整包默认导入**（`import antd from 'antd'`，那会整包进产物，
   * 再好的 tree-shaking 也救不回来）与 **②引 `@ant-design/icons`**（用户要求用自己的图标）。
   *
   * 另加一条**构建侧**的守卫（见本文件末尾 `mainFields` 那段），
   * 保证「裸根入口能摇」这个前提本身不被人改回去。 */
  const barrelImports = []
  const antdIcons = []
  const wholePackage = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('import ')) continue
      /* 裸根入口现在**允许**，但记下来，好让输出里看得见「我们确实在用它」。 */
      if (/from\s+['"]antd['"]/.test(trimmed)) barrelImports.push(`${file}: ${trimmed}`)
      if (trimmed.includes('@ant-design/icons')) antdIcons.push(`${file}: ${trimmed}`)
      if (/import\s+\w+\s+from\s+['"]antd['"]/.test(trimmed)) wholePackage.push(`${file}: ${trimmed}`)
    }
  }
  check('★★ 没有整包默认导入（`import antd from \'antd\'` —— 那会整包进产物）',
    wholePackage.length === 0, wholePackage.length === 0 ? 'ok' : wholePackage.slice(0, 3).join(' | '))
  check('★★ 没有引 `@ant-design/icons`（用户要求用我们自己的 icons.tsx）',
    antdIcons.length === 0, antdIcons.length === 0 ? 'ok' : antdIcons.slice(0, 3).join(' | '))
  console.log('   （裸根入口用了几处：' + String(barrelImports.length) + ' 处 —— 允许，靠 mainFields 摇）')
  check('@ant-design/icons 不在 package.json 的依赖里（是 antd 的传递依赖，不是我们要的）',
    !Object.keys(require('./../package.json').dependencies ?? {}).includes('@ant-design/icons'))

  /* ── 构建侧守卫：`mainFields` 这个前提本身不许被人改回去 ──
   *
   * 「裸根入口能摇」**完全依赖** `tsdown.preset.ts` 里那句
   * `mainFields: ['browser', 'module', 'main']`。少了它，同一个 `from 'antd'`
   * 会解析到 CJS 的 `lib/`，产物从 7.33 MB 涨到 10.72 MB（实测 4.2 MB 白占），
   * **而上面的源码断言一条都不会红** —— 因为它只看引入写法，不看解析结果。
   *
   * 所以这条断言守的是「前提」，不是「写法」：源码怎么写都行，
   * 但 `mainFields` 必须在。这一条才真正防回潮。 */
  {
    const preset = readFileSync('tsdown.preset.ts', 'utf8')
    const code = preset.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    check('★★ 构建配置里有 `mainFields`（裸根入口能按需摇的前提，缺了产物涨 4.2 MB）',
      /mainFields:\s*\[\s*'browser'\s*,\s*'module'\s*,\s*'main'\s*\]/.test(code),
      /mainFields:\s*\[/.test(code) ? '在' : '找不到 mainFields —— from \'antd\' 会退回 CJS 整包')
    check('★ `conditionNames` 没被顺手删掉（删了会改变别的包的双产解析）',
      /conditionNames:\s*\[/.test(code))
  }

  /* 目录里出现过多少 .tsx：只在有源码时上面几条才有意义，这里给个数免得「0 个文件 0 违规」假绿。 */
  console.log(`   （扫了 ${files.length} 个源文件，其中引 antd 的 ${files.filter(f => readFileSync(f, 'utf8').includes("'antd")).length} 个）`)
  check('扫描范围非空（防止「一个文件都没扫到」被当成全绿）', files.length > 50, String(files.length))
}

await act(async () => { root.unmount() })

console.log(failed === 0 ? '\n结论：全部通过 ✓' : `\n结论：有 ${failed} 条不通过 ✗`)
process.exit(failed === 0 ? 0 : 1)
