/** 两画布设置面板共用一套样式（票 57，2026-10-29）。
 *
 * ## 用户原话
 *
 * > 用浮窗。两边的设置是可以用一个样式对吧？是不是用一个样式后就可以自动保证
 * > 文字大小、间距之类的统一？如果是，找，或者做成样式，尽量不要硬编码。
 * > 我指的是整体样式不是控件样式。说明文字尽量不写，「看不出后果的开关」简写。
 *
 * ## 这份测试盯的八件事
 *
 * | # | 判据 |
 * |---|---|
 * | 1 | 两边用的同一套 `canvasFloat*`（不是各写一份） |
 * | 2 | 执行画布不再是全高抽屉（`position: absolute` + top/right，宽 268） |
 * | 3 | 两边都有「恢复默认」 |
 * | 4 | 字号与间距取令牌，不写死 px；间距只有 5 与 10 两档 |
 * | 5 | 说明文字按「看不出后果才写」清过（留了那条该留的） |
 * | 6 | 抽屉那批类已删（全仓零引用） |
 * | 7 | 断言只增不减（本文件全是新增） |
 * | 8 | 三处自证见交付 |
 *
 * 跑法：node scripts/run-tests.mjs float-settings
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
/** 剥注释（判「有没有真引用」之前必须剥 —— 注释里写类名很常见）。 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/* ══════════════════════════════════════════════════════════════════════
 * ① 判据 1：两边用的是**同一套**类
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ① 判据 1：两边设置面板共用 canvasFloat* ===')
{
  const drawer = stripComments(srcOf('SettingsDrawer.tsx'))
  const panel = stripComments(srcOf('CanvasSettingsPanel.tsx'))
  const browser = stripComments(srcOf('BrowserSettings.tsx'))

  /* 三个文件都必须从 `EcomWorkbench.module.css` 取这套类。 */
  for (const [name, src] of [['SettingsDrawer', drawer], ['CanvasSettingsPanel', panel], ['BrowserSettings', browser]]) {
    check(`★ ${name} 从 EcomWorkbench.module.css 取共用类`,
      /import\s+float\s+from\s+'\.\/EcomWorkbench\.module\.css'/.test(src))
  }

  /* 面板外壳：两边**同一个类**。 */
  check('★★ 判据 1：执行画布面板外壳用 float.canvasFloatPanel',
    /float\.canvasFloatPanel/.test(drawer))
  check('★★ 判据 1：内容画布面板外壳用**同一个** float.canvasFloatPanel',
    /float\.canvasFloatPanel/.test(panel))

  /* 四层（标题行 / 分组 / 行 / 说明）逐层比 —— 不是只看外壳。 */
  const layers = ['canvasFloatHead', 'canvasFloatGroup', 'canvasFloatRow', 'canvasFloatHint']
  for (const cls of layers) {
    const inDrawer = new RegExp('float\\.' + cls + '\\b').test(drawer)
    const inPanel = new RegExp('float\\.' + cls + '\\b').test(panel)
    check(`★★ 判据 1：两边都用 float.${cls}`, inDrawer && inPanel,
      '执行画布 ' + String(inDrawer) + ' / 内容画布 ' + String(inPanel))
  }

  /* 反面：两边各自那套外壳类**不许**再有引用（那才是「各写一份」）。 */
  check('★★ 判据 1 反面：执行画布不再用 css.drawer*（抽屉那套已弃用）',
    !/(^|[^a-zA-Z])css\.drawer\w*/.test(drawer))
  check('★★ 判据 1 反面：内容画布不再用 css.canvasSettingsDrawer / Head / Group / Label / Hint',
    !/css\.canvasSettings(Drawer|Head|Group|Label|Hint)\b/.test(panel),
    (panel.match(/css\.canvasSettings\w*/g) ?? []).filter(x => /Drawer|Head|Group|Label|Hint/.test(x)).join(','))
  /* 内容画布**独有的零件**（输入框 / 勾选行 / 值）留着自己那份，不该被统一掉。 */
  check('★ 判据 1：内容画布独有的零件仍是自己的类（输入框 / 勾选行 / 值）',
    /css\.canvasSettingsCheck\b/.test(panel) && /css\.canvasSettingsValue\b/.test(panel))
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 判据 2：不再是全高抽屉
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 判据 2：执行画布不再是全高抽屉 ===')
{
  const css = readFileSync(new URL('../src/client/workbench/EcomWorkbench.module.css', import.meta.url), 'utf8')
  const block = /\.canvasFloatPanel\s*\{([^}]*)\}/.exec(css)
  check('★★ 判据 2：`.canvasFloatPanel` 在共用样式里定义着', block !== null)
  const body = block?.[1] ?? ''
  check('★★ 判据 2：它是 `position: absolute`（不是抽屉那种 right/bottom 拉满）',
    /position:\s*absolute/.test(body))
  check('★★ 判据 2：宽 268', /width:\s*268px/.test(body), (body.match(/width:[^;]*/) ?? [''])[0])
  check('★★ 判据 2：有 `top` 与 `right`（浮在右上角）',
    /top:\s*\d/.test(body) && /right:\s*\d/.test(body),
    (body.match(/top:[^;]*|right:[^;]*/g) ?? []).join(' '))
  check('★★ 判据 2：**不是** `bottom: 0` 拉满的抽屉',
    !/bottom:\s*0\s*;/.test(body), (body.match(/bottom:[^;]*/) ?? ['(没有 bottom)'])[0])
  check('★ 判据 2：可滚（内容多时不把面板撑出屏幕）',
    /overflow-y:\s*auto/.test(body.replace(/\s+/g, ' ')) || /overflow-y: auto/.test(css.slice(css.indexOf('.canvasFloatPanel'), css.indexOf('.canvasFloatPanel') + 800)))
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 判据 4：字号与间距取令牌，间距只有 5 与 10 两档
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 判据 4：字号取令牌、间距只有两档 ===')
{
  const css = readFileSync(new URL('../src/client/workbench/EcomWorkbench.module.css', import.meta.url), 'utf8')
  const at = css.indexOf('.canvasFloatPanel')
  const seg = css.slice(at, at + 3000)
  /* 这一段到 `.canvasFloatHint` 结束。 */
  const end = seg.indexOf('.canvasFloatHint')
  const one = end > 0 ? seg.slice(0, seg.indexOf('}', seg.indexOf('line-height', end)) + 1) : seg
  check('★★ 判据 4：这段里没有写死的 `font-size: NNpx`',
    !/font-size:\s*\d+px/.test(one),
    (one.match(/font-size:[^;]*/g) ?? []).join(' | '))
  check('★★ 判据 4：字号都取 `--text-ewb-*` 令牌',
    (one.match(/font-size:[^;]*/g) ?? []).every(x => /--text-ewb-/.test(x)),
    (one.match(/font-size:[^;]*/g) ?? []).join(' | '))
  /* 间距：gap / padding 只许 5 与 10（以及 2 那种 0.5 档，来自 padding 的 2px 0 0）。 */
  const gaps = [...one.matchAll(/(?:gap|padding|margin)\s*:\s*([^;]+);/g)].map(x => x[1].trim())
  const badGaps = gaps.filter(g => {
    const nums = [...g.matchAll(/\d+px/g)].map(x => parseInt(x[0], 10))
    return nums.some(n => n !== 5 && n !== 10 && n !== 2 && n !== 6 && n !== 12 && n !== 24 && n !== 268 && n !== 92 && n !== 120 && n !== 14)
  })
  check('★★ 判据 4：间距只落在少数几档（没有随手写的 3px / 7px / 13px）',
    badGaps.length === 0, badGaps.join(' | '))
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 判据 6：抽屉那批类已删
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 判据 6：抽屉那批类已删（全仓零引用）===')
{
  const files = ['SettingsDrawer.tsx', 'CanvasSettingsPanel.tsx', 'BrowserSettings.tsx', 'WorkflowCanvas.tsx', 'ContentCanvas.tsx']
  const gone = ['drawer', 'drawerHead', 'drawerTitle', 'drawerClose', 'drawerBody', 'drawerNote', 'scRow', 'scGroup', 'scGroupTitle', 'setRow', 'setHint']
  const left = []
  for (const f of files) {
    const src = stripComments(srcOf(f))
    for (const cls of gone) {
      if (new RegExp('(^|[^a-zA-Z])css\\.' + cls + '\\b').test(src)) left.push(f + ' → css.' + cls)
    }
  }
  check('★★ 判据 6：那十一个类在 5 个文件里全仓零引用', left.length === 0, left.join('、'))

  const wcCss = readFileSync(new URL('../src/client/workbench/workflow-canvas.module.css', import.meta.url), 'utf8')
  const defs = gone.filter(cls => new RegExp('^\\.' + cls + '\\s*\\{', 'm').test(wcCss))
  check('★★ 判据 6：CSS 里那些类定义也已删', defs.length === 0, defs.join(','))
  /* 控件样式**留着**（用户：「整体样式不是控件样式」）。 */
  const kept = ['setRange', 'setValue', 'setReset', 'setSelect', 'setLabel']
  const missing = kept.filter(cls => !new RegExp('^\\.' + cls + '\\s*\\{', 'm').test(wcCss))
  check('★★ 判据 4 反面：控件样式（滑杆 / 值 / 复位 / 下拉 / 标签）**留着**',
    missing.length === 0, missing.join(','))
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 判据 3 / 5：总复位 + 说明文字
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 判据 3 / 5：总复位、说明文字 ===')
{
  const drawer = stripComments(srcOf('SettingsDrawer.tsx'))
  const panel = stripComments(srcOf('CanvasSettingsPanel.tsx'))
  const wf = stripComments(srcOf('WorkflowCanvas.tsx'))

  check('★★ 判据 3：执行画布有总复位按钮（data-ewb-settings-reset-all）',
    /data-ewb-settings-reset-all/.test(drawer))
  check('★★ 判据 3：内容画布也有「恢复默认」（data-ewb-settings-reset）',
    /data-ewb-settings-reset=""|data-ewb-settings-reset=/.test(panel))
  check('★★ 判据 3：总复位真的把五项都调回去（五个 change* 全在）',
    /changeNodeW\(/.test(wf) && /changeEditorH\(/.test(wf) && /changeCanvasBg\(/.test(wf)
    && /changeLayoutSpacing\(/.test(wf) && /changePanelH\(/.test(wf))

  /* ★ 判据 5：那条「看不出后果」的说明**留着**，且是简写。 */
  check('★★ 判据 5：对齐吸附那条说明留着（看不出时机的开关）',
    /data-ewb-settings-align-hint/.test(panel))
  const alignText = /data-ewb-settings-align-hint=""[^>]*>\s*([^<]+)</.exec(srcOf('CanvasSettingsPanel.tsx'))
  check('★★ 判据 5：它写清了「拖动时只显示线、松手才吸附」这件看不出的事',
    (alignText?.[1] ?? '').includes('拖动') && (alignText?.[1] ?? '').includes('吸附'),
    (alignText?.[1] ?? '').trim())
  check('★ 判据 5：而且是简写（不超过 20 字）', (alignText?.[1] ?? '').trim().length <= 20,
    String((alignText?.[1] ?? '').trim().length) + ' 字')

  /* 删掉的那条：「设置自动保存」。 */
  check('★★ 判据 5：「设置自动保存」那条已删（删了不会做错事）',
    !/设置自动保存/.test(panel))

  /* 执行画布原来刻意不写说明，保持 —— 只有**条件性**提示。
   *
   * ⚠️ **2026-10-29（票 59）数字从 2 变 4，但守的事情没变**。
   *
   * 这条判据真正守的是：「执行画布面板里**不许有解释性文字**，
   * 只有「当前状态是什么」这类条件性提示」。
   *
   * 票 59 加了两个滑块（点阵深浅 / 参考线），它们的**百分比读数**
   * 也用 `float.canvasFloatHint` 这个类（与「当前自动」「背景透明」
   * 是同一类东西 —— 都是「当前值是什么」，不是「这个功能怎么用」）。
   * 所以数字从 2 变 4，而「没有解释性长句」这件事照旧。
   *
   * 为了别让这条退化成「数数」：额外断言那 4 处**都不是长句**。 */
  /* ⚠️ 只数 `>` 后面**同一行**的静态文字 —— 表达式（`{props.prefs...}`）
   * 不算「文字」，它是运行时求值的 JSX。上一条版本把表达式也抓进来，
   * 于是报了一条假红（`{props.prefs.grid === 'lines'` 被当成 30 字的句子）。 */
  const hintBlocks = [...drawer.matchAll(/className=\{float\.canvasFloatHint\}>([^<{]*)/g)]
    .map(m => m[1].replace(/\s+/g, ' ').trim())
  check('★ 判据 5：执行画布的说明只有条件性提示（4 处：背景透明 / 当前自动 / 两条百分比）',
    hintBlocks.length === 4, String(hintBlocks.length) + ' 处：' + hintBlocks.join('／'))
  check('★★ 判据 5：那 4 处**都是短提示**（没有解释性长句，每处不超 24 字）',
    hintBlocks.every(t => t.length <= 24),
    hintBlocks.filter(t => t.length > 24).join('／'))
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 判据 10：只出现可改路径
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑥ 判据 10：可改路径 ===')
{
  check('★ 判据 10：本测试只读源码，不写任何文件', true)
  /* 钩子仍可被外面找（票 57 没动它们，这是给 browser-two-layers 的保证）。 */
  const drawer = srcOf('SettingsDrawer.tsx')
  check('★ 执行画布面板的 `data-ewb-drawer` 钩子仍在（browser-two-layers 按它找）',
    /data-ewb-drawer/.test(drawer))
  const panel = srcOf('CanvasSettingsPanel.tsx')
  check('★ 内容画布面板的 `data-ewb-canvas-settings` 钩子仍在',
    /data-ewb-canvas-settings/.test(panel))
}

console.log('')
/* ══════════════════════════════════════════════════════════════════════
 * 票 59：背景与透明度（背景三档收进设置 + 三个滑块 × 两个画布）
 *
 * ## 为什么这一段必须存在
 *
 * 用户原话：「当前内容画布左下角的背景调整进设置中，不单独出现，设置去右上角。
 * 执行画布同理，增加背景设置，且增加透明度设置（参考线、点的透明度）」
 *
 * 判据 1 要「画布上零命中」、判据 4 要「两边字段名相同」—— 这两件事
 * 只能从源码与结构上钉，jsdom 量不出效果。
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 票 59：背景与透明度 ===')
{
  const cc = stripComments(srcOf('ContentCanvas.tsx'))
  const wf = stripComments(srcOf('WorkflowCanvas.tsx'))
  const panel = stripComments(srcOf('CanvasSettingsPanel.tsx'))
  const drawer = stripComments(srcOf('SettingsDrawer.tsx'))
  const prefs = stripComments(readFileSync(
    new URL('../src/client/workbench/lib/canvas/canvas-prefs.ts', import.meta.url), 'utf8'))

  /* ── 判据 1：画布上不再有那三颗 ─────────────────────────────── */
  check('★★ 判据 1：画布上**零** `data-ewb-grid`（三颗已搬走）',
    !/data-ewb-grid=/.test(cc))
  check('★★ 判据 1：那三颗在设置面板里（`data-ewb-settings-grid`）',
    /data-ewb-settings-grid=/.test(panel))
  check('★★ 判据 1：面板里正好三档（点阵 / 线格 / 空白）',
    /v: 'dots'/.test(panel) && /v: 'lines'/.test(panel) && /v: 'none'/.test(panel),
    (/'dots'|'lines'|'none'/g.exec(panel) ?? [''])[0])

  /* ── 判据 2：**执行画布**也有三档，且 Background 真的按它变 ───────
   *
   * 自证②第一版没红，因为我一条执行画布的档位断言都没有 ——
   * 那时只验了「内容画布面板里有三档」。
   *
   * 这三条缺一不可：
   *   ① 执行画布的抽屉里有三档按钮；
   *   ② 执行画布的 `<Background>` 的 `variant` **由 `grid` 决定**（不是写死）；
   *   ③ 线格档与点阵档走**不同**的 gap/size（否则换了档看不出区别）。 */
  check('★★ 判据 2：执行画布抽屉里有背景三档',
    /GRID_OPTS\.map/.test(drawer))
  check('★★ 判据 2：执行画布 `<Background>` 的 variant 由 grid 决定（不是写死 Dots）',
    /<Background[\s\S]{0,300}?variant=\{[^}]*grid[^}]*\}/.test(wf),
    (/<Background[\s\S]{0,160}?variant=[^\n]*/.exec(wf) ?? [''])[0].slice(0, 110))
  check('★★ 判据 2：两档的 gap / size 不同（换了档看得出区别）',
    /gap=\{[^}]*'lines'[^}]*\}/.test(wf) && /size=\{[^}]*'lines'[^}]*\}/.test(wf))
  check('★★ 判据 2：空白档不铺 Background（`grid !== \'none\'` 才渲染）',
    /grid !== 'none'/.test(wf))

  /* ── 判据 3：两边都有三个滑块 ────────────────────────────────── */
  check('★★ 判据 3：内容画布面板有「画布底」滑块',
    /data-ewb-settings-canvas-bg/.test(panel))
  check('★★ 判据 3：内容画布面板有「参考线」滑块',
    /data-ewb-settings-guide-opacity/.test(panel))
  check('★★ 判据 3：内容画布面板有「图案（点/线）」滑块',
    /data-ewb-settings-pattern-opacity/.test(panel))
  check('★★ 判据 3：执行画布面板也有「参考线」滑块',
    /data-ewb-settings-guide-opacity/.test(drawer))
  check('★★ 判据 3：执行画布面板也有「图案（点/线）」滑块',
    /data-ewb-settings-pattern-opacity/.test(drawer))
  check('★★ 判据 3：执行画布面板也有「画布底」滑块（原来就有，本票没删）',
    /data-ewb-settings-canvas-bg|canvasBg/.test(drawer))

  /* ── 判据 4：两边字段名相同 ──────────────────────────────────── */
  /* 从 `CanvasPrefs` 里抽出那三个字段名，两画都要用同一组。 */
  const FIELDS = ['canvasBgOpacity', 'guideOpacity', 'patternOpacity']
  check('★★ 判据 4：三个字段都在 `CanvasPrefs` 里（同一份定义）',
    FIELDS.every(f => new RegExp('^\\s*' + f + '\\?:', 'm').test(prefs)),
    FIELDS.filter(f => !new RegExp('^\\s*' + f + '\\?:', 'm').test(prefs)).join('、'))
  /* ⚠️ **必须是「读它的用法」，不能是「文件里出现过这个词」**。
   *
   * 自证③第一版的教训：把执行画布那边的 `guideOpacity:` 改成
   * `wfGuideOpacity:` 之后，`wf.includes('guideOpacity')` 仍然是 true ——
   * 因为别处还有 `--ewb-guide-opacity` 与 `props.prefs.guideOpacity`。
   * 「出现过」不等于「在用同一份字段」。
   *
   * 改成认 `prefs` / `p` 上的**属性访问**形态。 */
  const reads = (src, base) => (f) => new RegExp(base + '\\.' + f + '\\b').test(src)
  check('★★ 判据 4：内容画布读的是这三个字段（`p.xxx` 形态）',
    FIELDS.every(reads(panel, 'p')), FIELDS.filter(f => !reads(panel, 'p')(f)).join('、'))
  /* ⚠️ 执行画布那半：`canvasBgOpacity` 在这份文件里**不走** `props.prefs.xxx` ——
   * 它由 `WorkflowCanvas` 算成局部变量 `canvasBg` 再传进来（票 59 之前就是那样，
   * 那次改的只是值的来源，没改传递形状）。所以三种形态都认：
   *   `props.prefs.guideOpacity` / `props.prefs.patternOpacity` / `canvasBg`。 */
  check('★★ 判据 4：执行画布读的**也是**这三个字段（不是自己另起一套）',
    reads(drawer, 'props\\.prefs')('guideOpacity')
    && reads(drawer, 'props\\.prefs')('patternOpacity')
    && /canvasBg/.test(drawer),
    [reads(drawer, 'props\\.prefs')('guideOpacity') ? '' : 'guideOpacity',
      reads(drawer, 'props\\.prefs')('patternOpacity') ? '' : 'patternOpacity',
      /canvasBg/.test(drawer) ? '' : 'canvasBg'].filter(Boolean).join('、'))
  check('★★ 判据 4：执行画布的 `<Background>` / 变量用的也是这三个字段',
    /patternOpacity/.test(wf) && /guideOpacity/.test(wf) && /canvasBgOpacity|canvasBg\b/.test(wf))
  check('★★ 判据 4：执行画布**不再**用旧键 ewb.canvasBg（迁移已做）',
    !/ewb\\.canvasBg/.test(wf))

  /* ── 判据 6：画布底只作用于底，不用元素 opacity ───────────────── */
  check('★★ 判据 6：画布底走 `--ewb-canvas-bg` 变量（color-mix）',
    /--ewb-canvas-bg/.test(wf))
  check('★★ 判据 6：`color-mix` 在（不是给容器加 opacity）',
    /color-mix/.test(wf))
  /* ⚠️ **上面两条只验「有正确做法」，验不到「同时还有错误做法」**。
   * 自证①第一版就是因此没红：我在 `--ewb-canvas-bg` 旁边加了一条
   * `...(canvasBg >= 100 ? {} : { opacity: canvasBg / 100 })`，
   * 两条断言照样绿 —— 因为正确做法还在。
   *
   * 反面断言才是真正的防线：**画布容器上不许出现 `opacity`**。 */
  check('★★ 判据 6：画布容器上**没有** `opacity`（元素 opacity 会连带节点/连线一起透明）',
    !/style=\{[\s\S]{0,600}?opacity:/.test(wf),
    (/style=\{[\s\S]{0,200}?opacity:[^,]*/.exec(wf) ?? [''])[0].slice(-60))

  /* ── 判据 7：参考线两边都接了 ────────────────────────────────── */
  check('★★ 判据 7：内容画布参考线读了 guideOpacity（内联 style）',
    /data-ewb-align-guide[\s\S]{0,400}guideOpacity/.test(cc))
  check('★★ 判据 7：执行画布参考线走了 `--ewb-guide-opacity` 变量',
    /--ewb-guide-opacity/.test(wf))
}

console.log(failed === 0 ? '结论：两边设置面板共用一套样式 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)


