/** 高度链静态检查：验证「从外到内」每一层都具备撑满高度的条件。
 *
 * 背景：2026-10-08 用户报告「节点库下面的内容看不到、没有滚动条」。
 * 根因是高度链断裂——某一层没有 min-height:0 或缺 overflow 控制，
 * 导致内部 overflow-y:auto 失效。这类问题「构建通过但显示不对」，只能靠静态检查兜。
 *
 * 检查规则（每一层都要满足）：
 *   1. 作为 flex 子项的层：必须有 min-height: 0（否则收缩下限是内容高度）
 *   2. 需要裁掉溢出的层：必须有 overflow: hidden（或 auto/scroll）
 *   3. 滚动容器：必须有 overflow-y: auto + min-height: 0
 */
import { readFileSync } from 'node:fs'

/**
 * 读取一个 CSS 文件并抽出类的声明块。
 * 只取「纯类选择器」的块 —— 排除伪类/伪元素（:hover / ::-webkit-scrollbar 等），
 * 否则后面的伪类块会覆盖真实规则，导致检查误报。
 * @param path - 相对本文件的 CSS 路径。
 * @returns 类名 → 声明文本（同名多块合并）。
 */
function parseCss(path) {
  const text = readFileSync(new URL(path, import.meta.url), 'utf8')
  const out = new Map()
  /* 只匹配「行首就是 .类名 {」的块，天然排除 .a:hover / .a .b / .a::x */
  const re = /^\.([A-Za-z][\w-]*)\s*\{([\s\S]*?)^\}/gm
  let m
  while ((m = re.exec(text)) !== null) {
    const prev = out.get(m[1]) ?? ''
    out.set(m[1], prev + ' ' + m[2])
  }
  return out
}

/** 检查一条规则是否满足。 */
function need(cls, body, checks, label) {
  const bad = []
  for (const [prop, why] of checks) {
    if (!body.includes(prop)) bad.push(prop + '（' + why + '）')
  }
  if (bad.length > 0) console.log('  ✗ ' + label + ' → 缺: ' + bad.join('、'))
  else console.log('  ✓ ' + label)
  return bad.length === 0
}

let allOk = true
console.log('=== 高度链检查 ===')

/* 链：.column → .content → .body → .stage → .wrap → .bodyRow → .lib/.libList */
const wb = parseCss('../src/client/workbench/EcomWorkbench.module.css')
const sw = parseCss('../src/client/workbench/canvas-switch.module.css')
/* 2026-10-08：workflow-canvas 按职责拆成 5 个文件（令牌/节点库/节点卡片/表单/画布本体）。
 * 本测试原先只读一个文件，拆分后读不到类 → 改为**合并查找**：任一文件里找到即算。 */
const cvFiles = [
  'canvas-tokens.module.css',
  'node-library.module.css',
  'node-card.module.css',
  'node-form.module.css',
  'workflow-canvas.module.css',
]
const cv = new Map()
for (const f of cvFiles) {
  for (const [k, v] of parseCss('../src/client/workbench/' + f)) {
    cv.set(k, (cv.get(k) ?? '') + ' ' + v)
  }
}

const MINH = ['min-height:', 'flex 子项的收缩下限默认是内容高度']

/* .column：fixed 定位，高度由 top/bottom 决定 → 只需 flex 容器 */
allOk = need('column', wb.get('column') ?? '', [['display: flex', '要作为 flex 容器']], '.column') && allOk

/* .content：flex 子项 + 纵向容器 */
allOk = need('content', wb.get('content') ?? '', [MINH, ['overflow', '裁掉溢出']], '.content') && allOk

/* .body：flex 子项 + 纵向容器 */
const bodyCss = wb.get('body') ?? ''
allOk = need('body', bodyCss, [MINH, ['overflow', '裁掉溢出'], ['flex-direction: column', '只有一个子项，纵向更明确']], '.body') && allOk

/* .stage（canvas-switch）*/
allOk = need('stage', sw.get('stage') ?? '', [MINH, ['overflow', '裁掉溢出']], '.stage') && allOk

/* .wrap（画布最外层）*/
allOk = need('wrap', cv.get('wrap') ?? '', [MINH, ['overflow', '裁掉溢出']], '.wrap') && allOk

/* .bodyRow */
allOk = need('bodyRow', cv.get('bodyRow') ?? '', [MINH, ['overflow', '裁掉溢出']], '.bodyRow') && allOk

/* .lib */
allOk = need('lib', cv.get('lib') ?? '', [MINH, ['overflow', '裁掉溢出']], '.lib') && allOk

/* .libList：滚动容器 */
allOk = need('libList', cv.get('libList') ?? '', [MINH, ['overflow-y: auto', '必须能纵向滚动']], '.libList') && allOk

/* ── 节点展开区：可滚动块 + 子项不许被压扁（2026-10-11 修的真 BUG）──────────
 *
 * 症状（用户报的）：「节点下面的内容多的时候，节点说明的文字展开后会被压缩到
 * 看不到，**且没有滚动条**」。
 *
 * 真因是一条 flexbox 规矩：**flex 子项的 `overflow` 不是 `visible` 时，
 * 它的「自动最小尺寸」算作 0**，于是它成了唯一可被压扁的子项。
 * `.detailBlock` 为了圆角带了 `overflow: hidden`，正好中招 ——
 * 参数块不肯缩，它被压到 0 高；一压扁内容就永不溢出，滚动条也就不出现。
 *
 * 两条一起查（只查一条抓不住）：
 *   ① `.block` 自己是滚动容器
 *   ② `.block > *` 声明了 `flex: 0 0 auto`（子项取内容高度、不参与收缩）
 * ② 是关键那条 —— 少了它，滚动条永远不出现，而**任何测试都不会报错**。 */
const BLOCK = ['overflow-y: auto', '必须能纵向滚动']
allOk = need('block', cv.get('block') ?? '', [MINH, BLOCK], '.block（节点展开的可滚动区）') && allOk

/* ⚠️ 这条选择器是 `.block > *`（带子选择器），`parseCss` 只认「行首纯类名」，
 * 所以它取不到 —— 直接读原文来找。**不去放宽 `parseCss`**：那个正则被上面十来条
 * 检查共用，一放宽就可能让它们匹配到 `:hover` 之类的块而误报。
 *
 * ⚠️ 用 `[^}]*` 而不是 `[\s\S]*?^\}`：**这条规则写在一行里**
 * （`.block > * { flex: 0 0 auto; }`），`}` 不在行首，那个写法会一路吃到
 * 后面某个行首的 `}`，把别的规则的声明也吞进来 —— 于是「把 flex 改坏」也照样通过。
 * 实测踩过：`footBar` 里也有 `flex: 0 0 auto`，被吞进来后断言就成了假阳性。 */
const formCss = readFileSync(new URL('../src/client/workbench/node-form.module.css', import.meta.url), 'utf8')
const childRule = /^\.block\s*>\s*\*\s*\{([^}]*)\}/m.exec(formCss)
if (childRule === null) {
  console.log('  ✗ .block > *（子项不许被压扁） → 找不到这条规则')
  allOk = false
} else {
  allOk = need('block > *', childRule[1],
    [['flex: 0 0 auto', '子项不许被压缩 —— 否则说明块会被压到 0 高且不出滚动条']],
    '.block > *（子项不许被压扁）') && allOk
}

/* ── 非画布 tab 的滚动容器（2026-10-14，用户 #8）────────────────────────
 *
 * 用户原话：「工作流管理 tab 是不是没有做滚动条，后面的内容看不到。」
 * 真机实测过：`.body` 高 390px / `overflow: hidden`，内容真实高 1296px，
 * **里面一层可滚动的都没有** → 超出部分被裁掉且够不着。
 *
 * `.tabScroll` 就是补上的那一层。这三条一起查，缺任一条都会退化成「还是看不到」：
 *   ① `flex: 1 1 auto` —— 吃掉 `.body` 的剩余高度（否则高度是 0）
 *   ② `min-height: 0`  —— flex 子项收缩下限否则是内容高度，`overflow-y` 不触发
 *   ③ `overflow-y: auto` —— 真正的滚动
 *
 * ⚠️ **这里原来还有第 ④ 条：`.tabScroll > * { flex: 0 0 auto }`。
 * 2026-10-14 那条规则**已从 CSS 删掉**（T4 查出它被 Tailwind 的 `.flex-1` 覆盖、
 * 是死规则；我实测确认它还**不能**按建议加权重 —— 会回退，见下面第 ④′ 条），
 * 所以断言也跟着换掉了。 */
const wbCssText = readFileSync(new URL('../src/client/workbench/EcomWorkbench.module.css', import.meta.url), 'utf8')
const tabScroll = wb.get('tabScroll') ?? ''
allOk = need('tabScroll', tabScroll,
  [['flex: 1 1 auto', '要吃掉 .body 的剩余高度，否则高度为 0'],
    MINH,
    ['overflow-y: auto', '必须能纵向滚动']],
  '.tabScroll（非画布 tab 的滚动容器）') && allOk

/* ④′ **面板自己要负责撑高**（三条，替代原来那条被覆盖的通用规则）。
 *
 * 为什么判据从「通用规则」换成「逐面板声明」：
 *   `.tabScroll > *` 那条与 Tailwind 同优先级、产物里 Tailwind 后注入 → 对
 *   `CollectPanel`（根带 `flex-1`）**被覆盖** = 死规则。
 *   而**按 T4 建议加权重反而会回退**（实测：「刷新」行被滚出视野 −952px）——
 *   因为 `CollectPanel` 的根**必须撑满**，它内部那层才是滚动层、面板头一行要固定。
 *   所以撑高这件事只能由**各面板自己的声明**负责，断言也就该盯那些声明：
 *   「谁把撑高删了」会当场变红，而不是被一条没生效的通用规则**假安全**盖过去。
 *
 *   ① `CollectPanel.tsx` 根：`flex ... flex-1 ... flex-col`（内层列表才是滚动层）
 *   ② `RunHistoryPanel` 的 `.histWrap`：`height: 100%`（表头固定、列表内滚）
 *   ③ `WorkflowList` 的根是裸 `<div>` —— **不需要**撑高（内容多高就多高，外层滚） */
{
  const cpSrc = readFileSync(new URL('../src/client/workbench/CollectPanel.tsx', import.meta.url), 'utf8')
  /* ⚠️ 判据必须按**实质**判：找那个 `className="flex min-h-0 flex-1 flex-col"` 的元素，
   * 并确认它**不带 `overflow`**。
   *
   * ## 为什么不能照字面精确匹配（第一版的做法，已废）
   *
   * 第一版是 `cpSrc.includes('<div className="flex min-h-0 flex-1 flex-col">')`
   * —— 要求 `flex-col` 后**立刻收引号**。它在 2026-10-29 `0fe6bbd` 之后**变红**：
   * 根元素加了 `data-ewb-collect-panel={tab}`，`>` 前面不再是引号，
   * 于是「找不到这个根元素」。代码是对的，错的是判据。
   *
   * ## 为什么也不能放宽成「含这几个类名就算数」（会退回更早的假绿）
   *
   * 那个文件里有 **4 处** `flex min-h-0 flex-1 flex-col`
   * （根 + 三个内层滚动层，后者都带 `overflow-y-auto`）。
   * 只查「存在任一」的话，把**根**的 `flex-1` 去掉，另外 3 处照样匹配得上 → 断言不红。
   *
   * ## 所以现在的判据是两条合起来
   *
   *   ① 取所有以这几个类名开头的 `<div ...>`，按「标签里有没有 `overflow`」分开；
   *   ② 断言**不带 overflow 的那种恰好只有一个** —— 那个就是根。
   *
   * ② 的两个方向都能红：
   *   · 根的 `flex-1` 被删 → 它不再进候选集 → 一个都不剩 → 红；
   *   · 根被换成带 `overflow-y-auto` 的 → 唯一的候选也丢了 → 红。
   *
   * 用 `overflow` 这个词判而不是 `overflow-y-auto`：`overflow` / `overflow-x` /
   * `overflow-hidden` 都会让这个元素变成滚动容器，它们同样不该出现在根上。 */
  const OPEN = /<div\b[^>]*className="flex min-h-0 flex-1 flex-col[^"]*"[^>]*>/g
  const tags = [...cpSrc.matchAll(OPEN)].map(m => m[0])
  const withOverflow = tags.filter(t => t.includes('overflow'))
  const rootLike = tags.filter(t => !t.includes('overflow'))
  const okCp = rootLike.length === 1
  console.log('  ' + (okCp ? '✓' : '✗')
    + ' CollectPanel 根元素撑满（flex + min-h-0 + flex-1 + flex-col 且不带 overflow）'
    + (okCp ? ' → ' + rootLike[0] : '')
    + (okCp ? '' : ' → 找到 ' + String(rootLike.length) + ' 个这样的元素（应当恰好 1 个）'))
  if (!okCp) {
    console.log('     （根不撑满 → 面板头一行会被滚走：实测它会跑到视野外 −952px）')
    console.log('     ⚠️ 那个文件里有 ' + String(tags.length) + ' 处同前缀的 class，其中 '
      + String(withOverflow.length) + ' 处是内层滚动层 —— 别把它们当根。')
    if (withOverflow.length > 0) {
      console.log('     带 overflow 的那几处（不是根）：')
      for (const t of withOverflow) console.log('       ' + t.slice(0, 130))
    }
    allOk = false
  }

  const histWrap = wb.get('histWrap') ?? ''
  allOk = need('histWrap', histWrap,
    [['height: 100%', '运行历史面板靠它撑满 —— 否则内部列表不再滚、表头会跟着滚走']],
    '.histWrap（运行历史面板撑满）') && allOk

  /* ⚠️ 反向断言：那条被覆盖的死规则**不该回来**。
   * 没有它时「加权重」看起来是个自然的「加固」，而实测证明它会回退 ——
   * 留这条防止有人（包括未来的我）再把它加回去。 */
  const backAgain = /^\.tabScroll\s*>\s*\*/m.test(wbCssText)
  console.log('  ' + (backAgain ? '✗' : '✓') + ' 没有 `.tabScroll > *` 通用规则'
    + (backAgain ? ' → 它会被 Tailwind 的 .flex-1 覆盖，且加权重会回退（实测 −952px）' : ''))
  if (backAgain) allOk = false
}

/* ── 浏览器一节**必须在 `.block` 里面**（2026-10-14，用户 #2）───────────
 *
 * 用户原话：「浏览器选择这个模块应该就是插件内容的一部分而不是一个独立模块，
 * 他应该是 playwright 这个节点的**第一块内容**，而不是独立板块。」
 *
 * 为什么这条属于「高度链」检查：它**就是这个测试管的那条 flex 规矩的又一个实例**。
 * 移出去放成 `.inlineEditor` 的兄弟时，它会以「内容高度」占位（实测 153px），
 * 把 `min-height: 0` 的 `.block` 挤到 **0 高** —— 用户看到的「参数被压成很小一块」
 * 就是这个。所以**真正要守的判据是「它在 `.block` 里面」**。
 *
 * ⚠️ **2026-10-16 跟着用户 m03425 第 1 条改过**：他重排了编辑区，
 * 新顺序是「0 备注 → 1 节点提示 → 2 依赖检查 → 3 节点说明 → 4 可用变量
 * → 5 浏览器 → 6 参数 → 7 失败处理」。所以
 *   · 「第一块内容」**不再成立、也不该成立**（第一块现在是备注）——
 *     旧注释里那句「它必须是可滚动内容里的第一块」已删；
 *   · 浏览器仍在 `.block` 内（`browserAt > blockAt`）—— 这条**照旧成立**，
 *     它才是防「压成 0 高」的那一条；
 *   · 仍在「参数」**之前**（`paramLabelAt > browserAt`）—— 新顺序里依然如此。
 *
 * ⚠️ 查渲染源码而不是产物：产物的 JSX 被压缩过，按缩进/顺序断言很脆。
 * 这里查的是「`NodeBrowserSection` 的调用点出现在 `block` 与第一个「参数」之间」。 */
const popSrc = readFileSync(new URL('../src/client/workbench/NodeEditorPopover.tsx', import.meta.url), 'utf8')
{
  const blockAt = popSrc.indexOf("css_node_form.block")
  const browserAt = popSrc.indexOf('<NodeBrowserSection')
  const paramLabelAt = popSrc.indexOf('>' + '参数' + '<')
  const ok = blockAt >= 0 && browserAt > blockAt && paramLabelAt > browserAt
  console.log('  ' + (ok ? '✓' : '✗') + ' 浏览器一节在 .block 里、且在「参数」之前'
    + (ok ? '' : ' → block@' + String(blockAt) + ' browser@' + String(browserAt) + ' 参数@' + String(paramLabelAt)))
  if (!ok) {
    console.log('     （它必须在可滚动内容里 —— 放成兄弟 flex 项会把参数区挤成 0 高）')
    allOk = false
  }
}

console.log('')
console.log('⑧ 输出面板的高度链（用户 2026-10-20：「输出高度似乎限制最高只到 120」）')
{
  /* ## 为什么这条要有
   *
   * 输出高度是**三层链**，用户能在设置里调的只有最外层：
   *
   *   .runPanel   max-height: var(--ewb-run-panel-h, 108px)   ← 滑杆写这个变量
   *     └ .runStick   flex: 1 1 auto; min-height: 0
   *         └ .runScroll   ← 曾经写死 max-height: 74px
   *
   * 最内层写死 74，上面调多大都白搭 —— 而且**不报错**，只是「拖滑杆没什么效果」。
   * 用户量出来的「最高一百二十几」正是 74 + 边框/内边距/复制行的总和。
   *
   * 判据：最内层**不许出现写死的 px `max-height`**。
   * 允许的是相对值（`100%` / `var(--…)`）—— 它们跟随父级，正是修好后的写法。
   *
   * ⚠️ 第一版判据写成「固定值必须 ≥ 60」，结果 `74` 也算通过 → **假绿**
   * （自证「改回 74px」时没变红才发现）。正确的门槛是**面板能调到的最大值**
   * （`PANEL_H_MAX` = 600）：只要最内层写死一个比它小的数，滑杆就白拖。
   * 而实际上没有任何一个写死的数是对的 —— 面板高度是用户可调的，
   * 最内层只能跟随。所以这里直接禁止写死的 px。 */
  const cssSrc = readFileSync(new URL('../src/client/workbench/node-card.module.css', import.meta.url), 'utf8')
  const body = /\.runScroll\s*\{([^}]*)\}/.exec(cssSrc)?.[1] ?? ''
  const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, '')
  const fixed = /max-height\s*:\s*(\d+)px/.exec(withoutComments)
  const fixedVal = fixed === null ? null : Number(fixed[1])
  const ok = body !== '' && fixedVal === null
  console.log('  ' + (ok ? '✓' : '✗') + ' .runScroll 的 max-height 不写死像素值'
    + (ok ? '' : ' → 现在是 ' + String(fixedVal) + 'px，设置里的滑杆调多大都会被它卡住'))
  if (!ok) {
    console.log('     （三层链：runPanel 的 max-height 由滑杆控制 → runStick 吃剩余 → runScroll 跟随；')
    console.log('       最内层写死数值会把上面两层全部废掉）')
    allOk = false
  }
  /* 中间那层必须仍是「可被压扁」的：flex + min-height:0。
   * 它要是变成 flex:0 0 auto，面板就撑不回滑杆设的高度。 */
  const stick = /\.runStick\s*\{([^}]*)\}/.exec(cssSrc)?.[1] ?? ''
  const stickOk = /min-height\s*:\s*0/.test(stick.replace(/\/\*[\s\S]*?\*\//g, ''))
  console.log('  ' + (stickOk ? '✓' : '✗') + ' .runStick 仍有 min-height: 0（可被压扁的前提）')
  if (!stickOk) allOk = false
}

console.log('')
console.log(allOk ? '结论：高度链完整 ✓' : '结论：高度链有缺口 ✗')
process.exit(allOk ? 0 : 1)
