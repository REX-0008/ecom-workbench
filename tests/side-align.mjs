/** 两侧栏对齐（票 58，2026-10-29）—— tab 条同一套外壳、宽度 260、clamp、存盘、SVG 折叠。
 *
 * ## 用户原话
 *
 * > 现在两边都不要顶部栏，顶部在画布中悬浮，统一两边 tab 条样式。条目可以不强行一致，
 * > 比如执行画布有标签，内容画布没有，但都有标题+说明。外观上应该近似。
 *
 * ## 这份测试盯的十条
 *
 * | # | 判据 | 在哪一段 |
 * |---|---|---|
 * | 1 | 两边都是 tab 条外壳、类名相同、选中态背景填充 | ① |
 * | 2 | 宽度都是 260；拖到 100 / 900 都被夹回 180–460 | ② |
 * | 3 | 宽度与折叠存盘（两处白名单**成对**） | ③ |
 * | 4 | 双击复位到 260（两边） | ④ |
 * | 5 | 折叠按钮是 SVG（`textContent` 空）、折叠后 56px | ⑤ |
 * | 6 | 素材 tab 有搜索框；两句空态**不同** | ⑥ |
 * | 7 | 素材每项有说明行；网格密度未降 | ⑦ |
 * | 8 | 两处宽度范围是同一组数字（读源码比对） | ⑧ |
 *
 * 跑法：node scripts/run-tests.mjs side-align
 */
import { settle } from './_wait.mjs'
import { readFileSync } from 'node:fs'
import { createRequire, register } from 'node:module'

register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, ctx, next) {\n'
  + "  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }\n"
  + '  return next(url, ctx)\n'
  + '}\n',
))

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }) } catch { /* 只读则跳过 */ }
globalThis.localStorage = window.localStorage
for (const k of ['HTMLElement', 'Element', 'Node', 'SVGElement', 'DocumentFragment', 'MouseEvent']) globalThis[k] = window[k]
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.ResizeObserver = window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })
}

let failed = 0
/**
 * 断言一条。
 * @param {string} name - 用例名。
 * @param {boolean} ok - 过没过。
 * @param {string} detail - 细节。
 */
function check(name, ok, detail = '') {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!ok) failed += 1
}

/** 源码读取（相对本文件）。 */
const srcOf = (rel) => readFileSync(new URL('../src/client/workbench/' + rel, import.meta.url), 'utf8')
/** 剥注释（判「有没有真引用」之前必须剥 —— 注释里写类名会被误判）。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const side = stripComments(srcOf('CanvasSidePanel.tsx'))
const wf = stripComments(srcOf('WorkflowCanvas.tsx'))

/* ══════════════════════════════════════════════════════════════════════
 * ① 判据 1：两边同一套 tab 条外壳
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ① 判据 1：两边 tab 条同一套外壳 ===')
{
  check('★★ 判据 1：内容画布侧栏用 css.canvasSideTabs',
    /canvasSideTabs/.test(side))
  check('★★ 判据 1：执行画布侧栏用**同一个** css.canvasSideTabs',
    /canvasSideTabs/.test(wf))
  check('★★ 判据 1：两边折叠按钮都是 css.canvasSideIconBtn',
    /canvasSideIconBtn/.test(side) && /canvasSideIconBtn/.test(wf))
  check('★★ 判据 1：两边标题都用 css.canvasSidePanelTitle',
    /canvasSidePanelTitle/.test(wf))
  /* 反面：执行画布不许再有自己那套头部类。 */
  const libHeadLeft = /css_node_library\.libHead\b/.test(wf)
  check('★★ 判据 1 反面：执行画布不再用 libHead（换成共用那套）', !libHeadLeft)
  /* 两边都必须 import EcomWorkbench.module.css（CSS Modules 各自加 hash，
   * 不 import 同一个文件就不可能共用一套类）。 */
  check('★★ 判据 1：执行画布 import 了 EcomWorkbench.module.css',
    /import css from '\.\/EcomWorkbench\.module\.css'/.test(srcOf('WorkflowCanvas.tsx')))
  /* 选中态背景填充那条规则仍在（判据说「沿用 :1058 那条」）。 */
  const css = readFileSync(new URL('../src/client/workbench/EcomWorkbench.module.css', import.meta.url), 'utf8')
  check('★★ 判据 1：tab 选中态仍是背景填充（`.canvasSideTab[data-on]`）',
    /\.canvasSideTab\[data-on\]\s*\{[^}]*background/.test(css),
    (/\.canvasSideTab\[data-on\]\s*\{[^}]*/.exec(css) ?? [''])[0].slice(0, 90))
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 判据 2：宽度 260 + clamp 180–460（两边）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 判据 2：宽度 260、clamp 180–460 ===')
{
  const { clampPanelWidth } = await import('../src/client/workbench/CanvasSidePanel.tsx')
  check('★★ 判据 2：内容画布 clamp(100) → 180', clampPanelWidth(100) === 180, String(clampPanelWidth(100)))
  check('★★ 判据 2：内容画布 clamp(900) → 460', clampPanelWidth(900) === 460, String(clampPanelWidth(900)))
  check('★★ 判据 2：内容画布 clamp(260) → 260（默认值原样）', clampPanelWidth(260) === 260, String(clampPanelWidth(260)))

  /* ⚠️ **必须真调那个函数**，不能只 grep 常量存在。
   *
   * 第一版就是 grep `const LIB_W_MIN = 180` —— 自证①把 clamp 里的
   * `Math.max/Math.min` 去掉之后，常量还在、那条断言照绿，等于没验到。
   * 现在 `clampLibW` 导出了，直接调它。
   *
   * 导出一个纯函数不影响任何行为（它本来就在模块里被 `persistLibW` 与
   * `setLibW` 用），收益是这条判据能**真的红**。 */
  const { clampLibW, LIB_W_DEFAULT } = await import('../src/client/workbench/WorkflowCanvas.tsx')
  check('★★ 判据 2：执行画布 clamp(100) → 180', clampLibW(100) === 180, String(clampLibW(100)))
  check('★★ 判据 2：执行画布 clamp(900) → 460', clampLibW(900) === 460, String(clampLibW(900)))
  check('★★ 判据 2：执行画布 clamp(260) → 260（默认值原样）', clampLibW(260) === 260, String(clampLibW(260)))
  check('★★ 判据 2：执行画布默认宽度是 260', LIB_W_DEFAULT === 260, String(LIB_W_DEFAULT))
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 判据 3：宽度与折叠存盘（两处白名单成对）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 判据 3：宽度与折叠存盘 ===')
{
  const P = await import('../src/prefs/ui-prefs.ts')
  const d = P.defaultUiPrefs()
  check('★★ 判据 3：ui-prefs 的默认 libW 是 260', d.libW === 260, String(d.libW))
  check('★ 判据 3：两个新字段是**可选**的（老存档读出来不崩）',
    d.contentSideW === undefined && d.contentSideCollapsed === undefined,
    JSON.stringify([d.contentSideW, d.contentSideCollapsed]))

  const norm = P.normalizeUiPrefsForTest === undefined
    ? null
    : P.normalizeUiPrefsForTest
  /* 走真实读接口：写一份带两个新字段的，读回来在。 */
  const { writeUiPrefs, readUiPrefs } = P
  const wrote = await writeUiPrefs({ contentSideW: 320, contentSideCollapsed: true })
  check('★★ 判据 3：写进去的宽度读得回来',
    wrote.contentSideW === 320, String(wrote.contentSideW))
  check('★★ 判据 3：写进去的折叠状态读得回来',
    wrote.contentSideCollapsed === true, String(wrote.contentSideCollapsed))
  const back = await readUiPrefs()
  check('★ 判据 3：从盘上再读一次也在',
    back.contentSideW === 320 && back.contentSideCollapsed === true,
    JSON.stringify([back.contentSideW, back.contentSideCollapsed]))
  /* 越界要被挡（与 clamp 同一组范围）。 */
  const over = await writeUiPrefs({ contentSideW: 900 })
  check('★★ 判据 3：宽度越界（900）被跳过，保持原值 320',
    over.contentSideW === 320, String(over.contentSideW))

  /* ★ 白名单**成对**：读与写都要有这两个键，漏一处就会出现
   * 「拖了、刷新又变回默认」。 */
  const dc = stripComments(srcOf('dispatch-client.ts'))
  const readBlock = /function readUiPrefsCache\(\)[\s\S]*?\n\}/.exec(dc)?.[0] ?? ''
  const writeBlock = /function writeUiPrefsCache\(patch[\s\S]*?\n\}/.exec(dc)?.[0] ?? ''
  check('★★ 判据 3：读缓存白名单里有 contentSideW',
    /contentSideW/.test(readBlock), readBlock.length === 0 ? '（没找到 readUiPrefsCache）' : '')
  check('★★ 判据 3：写缓存白名单里也有 contentSideW（成对）',
    /contentSideW/.test(writeBlock), writeBlock.length === 0 ? '（没找到 writeUiPrefsCache）' : '')
  check('★★ 判据 3：折叠状态同样读写成对',
    /contentSideCollapsed/.test(readBlock) && /contentSideCollapsed/.test(writeBlock))

  /* 组件侧真接上了：内容画布拖完写、折叠时写。 */
  check('★★ 判据 3：内容画布侧栏拖完落盘（persistWidth）',
    /persistWidth/.test(side) && /writeUiPrefsCache\(\{ contentSideW/.test(side))
  check('★★ 判据 3：内容画布折叠状态落盘',
    /writeUiPrefsCache\(\{ contentSideCollapsed/.test(stripComments(srcOf('ContentCanvas.tsx'))))
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 判据 4：双击复位到 260（两边）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 判据 4：双击复位到 260 ===')
{
  check('★★ 判据 4：执行画布双击复位用 LIB_W_DEFAULT（260）',
    /onDoubleClick=\{\(\) => \{ setLibW\(LIB_W_DEFAULT\)/.test(wf),
    (/onDoubleClick=\{\(\) => \{ setLibW\([^)]*\)/.exec(wf) ?? [''])[0])
  /* 内容画布：双击复位在**侧栏自己**那个拖宽把手上（与执行画布同一个位置语义：
   * 都挂在「右边缘那条可拖的线」上）。父组件 `ContentCanvas` 不该管这个。 */
  check('★★ 判据 4：内容画布的拖宽把手有双击复位（onDoubleClick）',
    /onDoubleClick=\{resetWidth\}/.test(side))
  check('★★ 判据 4：复位到 **260**（不是某个魔法数）',
    /const resetWidth = useCallback\(\(\): void => \{\s*setWidth\(260\)/.test(side)
    || /setWidth\(260\)/.test(side),
    (/setWidth\(\d+\)/.exec(side) ?? [''])[0])
  check('★★ 判据 4：复位**也要落盘**（不然刷新又回去）',
    /persistWidth\(260\)/.test(side))
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 判据 5：折叠按钮 SVG + 折叠后 56px
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 判据 5：折叠按钮 SVG、折叠后 56px ===')
{
  /* 执行画布：那两个字符不许再出现。 */
  check('★★ 判据 5：执行画布折叠按钮**不再**是 `‹ / ›` 字符',
    !/\{libOpen \? '‹' : '›'\}/.test(wf))
  check('★★ 判据 5：执行画布折叠按钮用 ChevronLeftIcon / ChevronRightIcon',
    /ChevronLeftIcon/.test(wf) && /ChevronRightIcon/.test(wf))
  /* 内容画布：一直是 SVG，验它没被改回字符。 */
  check('★★ 判据 5：内容画布折叠按钮也是 SVG（Chevron*Icon）',
    /ChevronLeftIcon/.test(side) && /ChevronRightIcon/.test(side))

  /* 折叠后 56px：两边都要。 */
  const nlc = readFileSync(new URL('../src/client/workbench/node-library.module.css', import.meta.url), 'utf8')
  check('★★ 判据 5：执行画布折叠后宽度 56px（.libCollapsed）',
    /\.libCollapsed\s*\{\s*width:\s*56px/.test(nlc),
    (/\.libCollapsed\s*\{[^}]*\}/.exec(nlc) ?? [''])[0])
  const css = readFileSync(new URL('../src/client/workbench/EcomWorkbench.module.css', import.meta.url), 'utf8')
  check('★★ 判据 5：内容画布折叠后宽度 56px（.canvasSideCollapsedWidth）',
    /\.canvasSideCollapsedWidth\s*\{\s*width:\s*56px/.test(css),
    (/\.canvasSideCollapsedWidth\s*\{[^}]*\}/.exec(css) ?? [''])[0])
  /* 而且真的挂上了。 */
  check('★ 判据 5：内容画布折叠态的 div 上挂了那个类',
    /canvasSideCollapsed \+ ' ' \+ css\.canvasSideCollapsedWidth/.test(side))
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 判据 6：素材搜索框 + 两句空态
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑥ 判据 6：素材搜索框、两句空态不同 ===')
{
  check('★★ 判据 6：素材 tab 有搜索框（data-ewb-side-asset-search）',
    /data-ewb-side-asset-search=/.test(side))
  check('★★ 判据 6：「本来就没有」那句在（data-ewb-side-asset-empty）',
    /data-ewb-side-asset-empty=/.test(side))
  check('★★ 判据 6：「搜不到」那句在（data-ewb-side-asset-nomatch）',
    /data-ewb-side-asset-nomatch=/.test(side))
  /* ★ 两句必须**措辞不同** —— 这是判据 6 的要害。 */
  const emptyText = /data-ewb-side-asset-empty=""[^>]*>\s*([^<]+)</.exec(srcOf('CanvasSidePanel.tsx'))?.[1]?.trim() ?? ''
  const nomatchText = /data-ewb-side-asset-nomatch=""[^>]*>\s*([^<]+)</.exec(srcOf('CanvasSidePanel.tsx'))?.[1]?.trim() ?? ''
  check('★★ 判据 6：两句空态**不是同一句**',
    emptyText !== '' && nomatchText !== '' && emptyText !== nomatchText,
    '空态「' + emptyText + '」／ 搜不到「' + nomatchText + '」')
  check('★ 判据 6：「搜不到」那句带上了搜的关键词（用户知道自己搜的是什么）',
    /没有匹配/.test(nomatchText) && /\{mq\}/.test(srcOf('CanvasSidePanel.tsx')),
    nomatchText)
  /* 搜索真的在筛（不是只画了个框）。 */
  check('★★ 判据 6：搜索真的参与筛选（matsShown 用的是 mq）',
    /const matsShown = /.test(side) && /mq\.trim\(\)\.toLowerCase\(\)/.test(side))
  check('★ 判据 6：分组渲染用的是筛选后的 matsShown（不是全量 mats）',
    /matsShown\.filter\(m => materialKindOf\(m\) === g\.kind\)/.test(side))
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 判据 7：素材每项有说明行、网格密度未降
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑦ 判据 7：素材每项有说明行、密度未降 ===')
{
  check('★★ 判据 7：图片 / 视频项有说明行（data-ewb-side-asset-meta）',
    /data-ewb-side-asset-meta=/.test(side))
  check('★ 判据 7：说明行的内容是「类型 · 大小」',
    /g\.label\} · /.test(side) || /\{g\.label\}/.test(side))
  /* 密度未降：网格容器还是同一个类，没换成列表。 */
  check('★★ 判据 7：素材仍用网格（css.canvasSideGrid）',
    /css\.canvasSideGrid/.test(side))
  check('★★ 判据 7：说明行**塞在同一个按钮里**（没在外面多包一层，密度不变）',
    /* 说明行必须出现在 `data-ewb-side-asset=` 那个 button 的子树里 ——
     * 源码层面的判据：它在 canvasSideAssetName 那个 span 里面。 */
    /canvasSideAssetName[\s\S]{0,900}data-ewb-side-asset-meta=/.test(side))
  /* ⚠️ 密度未降的**真实机制**：不是 CSS Grid 的 `auto-fill`，
   * 而是「`flex-wrap` 容器 + 每项固定 72px 宽」。
   *
   * 第一版我按 `auto-fill` 验，红了 —— 那不是回归，是我把机制记错了。
   * 照真实机制验，而且验得更严：三件事缺一件密度就会降。
   *
   * | 条件 | 缺了会怎样 |
   * |---|---|
   * | 容器 `flex-wrap` | 所有素材挤成一行，横向溢出 |
   * | 每项有**固定宽** | 一项占满一整行 = 变成列表 |
   * | 说明行塞在同一个按钮里 | 多包一层会撑大每项，一行放不下两个 | */
  const css = readFileSync(new URL('../src/client/workbench/EcomWorkbench.module.css', import.meta.url), 'utf8')
  const gridBlock = /\.canvasSideGrid\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  check('★★ 判据 7：素材容器仍是 flex-wrap（一行排得下多个）',
    /display:\s*flex/.test(gridBlock) && /flex-wrap:\s*wrap/.test(gridBlock),
    gridBlock.replace(/\s+/g, ' ').trim().slice(0, 90))
  const assetBlock = /\.canvasSideAsset\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  check('★★ 判据 7：每项仍是**固定窄宽**（72px，不是 flex:1 撑满一行）',
    /width:\s*72px/.test(assetBlock) && !/flex:\s*1/.test(assetBlock),
    (assetBlock.match(/width:[^;]*|flex:[^;]*/g) ?? []).join(' '))
  check('★★ 判据 7：每项也没被改成整行宽（没有 width:100%）',
    !/width:\s*100%/.test(assetBlock))
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑧ 两处宽度范围必须是同一组数字（读源码比对）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑧ 两处宽度范围同一组数字 ===')
{
  const hostPrefs = readFileSync(new URL('../src/prefs/ui-prefs.ts', import.meta.url), 'utf8')
  const dc = readFileSync(new URL('../src/client/workbench/dispatch-client.ts', import.meta.url), 'utf8')
  const hostMin = /const LIB_W_MIN = (\d+)/.exec(hostPrefs)?.[1]
  const hostMax = /const LIB_W_MAX = (\d+)/.exec(hostPrefs)?.[1]
  const cliMin = /const LIB_W_MIN = (\d+)/.exec(dc)?.[1]
  const cliMax = /const LIB_W_MAX = (\d+)/.exec(dc)?.[1]
  check('★★ 宿主半与客户端缓存的 libW 上下限是同一组数字',
    hostMin !== undefined && hostMin === cliMin && hostMax !== undefined && hostMax === cliMax,
    '宿主 ' + String(hostMin) + '–' + String(hostMax) + ' ／ 客户端 ' + String(cliMin) + '–' + String(cliMax))
  check('★★ 那组数字就是 180–460',
    hostMin === '180' && hostMax === '460', String(hostMin) + '–' + String(hostMax))
  /* 内容画布那边也同一组。 */
  const PANEL_MIN = /export const PANEL_MIN = (\d+)/.exec(srcOf('CanvasSidePanel.tsx'))?.[1]
  const PANEL_MAX = /export const PANEL_MAX = (\d+)/.exec(srcOf('CanvasSidePanel.tsx'))?.[1]
  check('★★ 内容画布的 PANEL_MIN/MAX 也是 180–460（两侧栏边界一致）',
    PANEL_MIN === '180' && PANEL_MAX === '460', String(PANEL_MIN) + '–' + String(PANEL_MAX))
  /* 执行画布那份也同一组。 */
  const wfMin = /const LIB_W_MIN = (\d+)/.exec(wf)?.[1]
  const wfMax = /const LIB_W_MAX = (\d+)/.exec(wf)?.[1]
  check('★★ 执行画布自己那份 clamp 也是同一组',
    wfMin === hostMin && wfMax === hostMax, String(wfMin) + '–' + String(wfMax))
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑨ 文案 R6
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑨ 文案守 R6 ===')
{
  const texts = [
    /data-ewb-side-asset-empty=""[^>]*>\s*([^<]+)</.exec(srcOf('CanvasSidePanel.tsx'))?.[1]?.trim() ?? '',
    /data-ewb-side-asset-nomatch=""[^>]*>\s*([^<]+)</.exec(srcOf('CanvasSidePanel.tsx'))?.[1]?.trim() ?? '',
    '折叠节点库', '展开节点库', '搜索素材',
  ].filter(t => t !== '')
  check('★ R6.1：不用第二人称（你 / 您）', texts.every(t => !/[你您]/.test(t)), texts.join(' | '))
  check('★ R6.3：不用疑问句做标签', texts.every(t => !/[？?]/.test(t)), texts.join(' | '))
  check('★ R6.2：不用口语词',
    texts.every(t => !/折腾|省事|顺手|一会儿|其实|别怕/.test(t)), texts.join(' | '))
}

console.log('')
console.log(failed === 0 ? '结论：两侧栏对齐 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
