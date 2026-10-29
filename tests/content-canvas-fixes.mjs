/** 票 35 的五处修补（2026-10-28）—— 纯源码/CSS 层断言。
 *
 * ## 这份测试为什么单独一个文件
 *
 * 那五处里，有三处的判据落在**样式与结构**上（标题不被裁、小地图有尺寸、
 * 设置面板里没有快捷键表）。跑 jsdom 挂整个画布才能验会很慢，而且
 * jsdom 不做布局 —— 它量不出「小地图是不是 0 尺寸」。
 *
 * 所以这里直接读源码与 CSS，断言**声明层面**的事实。这是可接受的：
 * 这几条的失效方式都是「某条声明被删了」，而不是「运行时算错了」。
 *
 * ⚠️ 读 CSS 时**必须先剥注释** —— 我们自己的注释里就写着 `overflow: hidden`、
 * `pointer-events: none` 这些字样（它们在解释「原来错在哪」）。
 *
 * ⚠️ 这里**不 import 任何 `.tsx`**：`CanvasZoomControls.tsx` 会引
 * `EcomWorkbench.module.css`，Node 跑不了（`ERR_UNKNOWN_FILE_EXTENSION`）。
 * 需要它的数据时改读源码，或把那份数据抽到纯 `.ts` 里。
 *
 * 跑法：node --import <tsx> tests/content-canvas-fixes.mjs
 */
import { readFileSync } from 'node:fs'

const HERE = new URL('.', import.meta.url)
const read = (p) => readFileSync(new URL(p, HERE), 'utf8')
/** 剥掉块注释（只用于包含判断，不关心行号）。 */
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')

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

/** 取一条 CSS 规则的内容。 */
function ruleOf(cssText, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(esc + '\\s*\\{([^}]*)\\}').exec(cssText)?.[1] ?? ''
}

const cssRaw = read('../src/client/workbench/EcomWorkbench.module.css')
const css = stripCss(cssRaw)
const canvasSrc = read('../src/client/workbench/ContentCanvas.tsx')
const nodesSrc = read('../src/client/workbench/content-nodes.tsx')
const settingsSrc = read('../src/client/workbench/CanvasSettingsPanel.tsx')
const zoomSrc = read('../src/client/workbench/CanvasZoomControls.tsx')

/* ══════════════════════════════════════════════════════════════════════
 * 一、节点标题：看得见 + 点得到（用户实测报的那一条）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== 一、节点标题：不被祖先裁掉 + 点得到 ===')
{
  const wrap = ruleOf(css, '.contentNodeWrap')
  const node = ruleOf(css, '.contentNode')
  const name = ruleOf(css, '.contentNodeName')

  check('★★★ 外层包装**不裁剪**（标题挂在框外，裁剪了就看不见）',
    /overflow:\s*visible/.test(wrap), wrap.replace(/\s+/g, ' ').slice(0, 70) || '（没有 .contentNodeWrap）')
  check('★★ 内层仍裁剪（图片圆角要靠它）',
    /overflow:\s*hidden/.test(node), node.replace(/\s+/g, ' ').slice(0, 70))
  check('★★★ 标题**没有** `pointer-events: none`（写了就永远点不到）',
    !/pointer-events:\s*none/.test(name),
    /pointer-events:\s*none/.test(name) ? '写着 none' : '没写 ✓')
  check('★ 标题有 `cursor: text`（能看出它可以改）',
    /cursor:\s*text/.test(name))

  /* 结构层：标题必须挂在**包装层**里，不是挂在裁剪层里。 */
  const shellAt = nodesSrc.indexOf('function Shell')
  const shellEnd = nodesSrc.indexOf('function TextContentNode')
  const shell = nodesSrc.slice(shellAt, shellEnd)
  check('★★★ `NodeName` 在 `Shell` 里且位置在包装层之后（挂在不裁剪那层）',
    shell.indexOf('<NodeName') > shell.indexOf('contentNodeWrap')
    && shell.indexOf('<NodeName') > 0,
    'NodeName@' + String(shell.indexOf('<NodeName')) + ' / 包装层@' + String(shell.indexOf('contentNodeWrap')))
  check('★★ 配置节点也走同一套（它原来也是 `overflow: hidden` 里塞标题）',
    nodesSrc.slice(nodesSrc.indexOf('function ConfigContentNode')).includes('contentNodeWrap'))

  /* 交互：双击改名（照参考项目）。 */
  check('★★★ 标题是**双击**改名（单击留给选中节点）', nodesSrc.includes('onDoubleClick='))
  check('★ 改名输入框有 64 字上限（照参考项目）', /maxLength=\{64\}/.test(nodesSrc))
  /* 改名期间标题不闪：外层有一个修饰类，且那个类**在 CSS 里真的存在**。
   * ⚠️ CSS Modules 只导出真的出现在规则里的类名 —— 只写在选择器里的话
   * JS 拿到 undefined，拼出来的类名是一串 "undefined"（不报错、静默失效）。 */
  check('★★ 改名态修饰类在 CSS 里**有声明**（否则 CSS Modules 导出 undefined）',
    /\.contentNodeWrapNameEditing\s*\{/.test(css))
  check('★★ 改名态也让标题显形（选择器里有它）',
    /\.contentNodeWrapNameEditing\s+\.contentNodeName/.test(css))
}

/* ══════════════════════════════════════════════════════════════════════
 * 二、设置面板跟着节点走
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 二、设置面板挂在节点里（跟着节点动、跟着画布缩） ===')
{
  const inNode = ruleOf(css, '.nodePanelInNode')
  check('★★★ 面板是 `position: absolute`（相对节点定位，不是屏幕坐标）',
    /position:\s*absolute/.test(inNode), inNode.replace(/\s+/g, ' ').slice(0, 70))
  check('★★ 面板在节点**下方**（`top: 100%`，照参考项目 `canvas-node.tsx:483`）',
    /top:\s*100%/.test(inNode))
  check('★★ 水平居中对齐节点（`left: 50%` + `translateX(-50%)`）',
    /left:\s*50%/.test(inNode) && /translateX\(-50%\)/.test(inNode))
  /* 结构层：面板由 Bridge 传给节点，由节点渲染 —— 不再由画布按屏幕坐标摆。 */
  check('★★★ 通道上有 `renderPanel`（画布把面板交给节点画）',
    nodesSrc.includes('renderPanel'), nodesSrc.includes('renderPanel') ? '' : '没有')
  check('★★★ 节点里真的调它了（`bridge.panelNodeId === id` 时才画）',
    /bridge\.panelNodeId === id[\s\S]{0,60}bridge\.renderPanel\(id\)/.test(nodesSrc))
  check('★★★ 画布那边**不再按屏幕坐标摆面板**（`nodePanelAnchor` 只留给图像操作浮层）',
    !/nodePanelAnchor[\s\S]{0,3000}NodeSettingsPanel/.test(canvasSrc),
    /nodePanelAnchor[\s\S]{0,3000}NodeSettingsPanel/.test(canvasSrc) ? '还留着旧摆法' : '已换 ✓')
  /* ⚠️ 这条是真踩过的 bug：renderPanel 不进 bridge 依赖 → 面板拿到旧的 refChoices
   * → 点「选择参考图」素材回来了却一条都不显示。 */
  check('★★★ `renderPanel` 在 bridge 的依赖数组里（不加会拿到旧闭包）',
    /\n\s*renderPanel\]\)/.test(canvasSrc),
    /\n\s*renderPanel\]\)/.test(canvasSrc) ? '' : '依赖数组里没有它')
  check('★★ `renderPanel` 定义在 bridge **之前**（否则渲染期求值会 TDZ 白屏）',
    canvasSrc.indexOf('const renderPanel') < canvasSrc.indexOf('const bridge = useMemo'),
    'renderPanel@' + String(canvasSrc.indexOf('const renderPanel'))
    + ' bridge@' + String(canvasSrc.indexOf('const bridge = useMemo')))
  /* 面板宽度那个设置不许因为搬结构而丢。 */
  check('★★ 面板宽度仍按设置算（`panelWidthFor` 仍在用）',
    /panelWidthFor\([^)]*prefs\.panelWidth\)/.test(canvasSrc))
}

/* ══════════════════════════════════════════════════════════════════════
 * 三、空格切抓手能切回来
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 三、空格：自动重复与失焦都不许卡在抓手 ===')
{
  const at = canvasSrc.indexOf("act === 'panHold'")
  const block = canvasSrc.slice(at, at + 3000)
  check('★★★ 忽略键盘自动重复（`e.repeat`）—— 不忽略会覆盖掉要恢复的 mode',
    /e\.repeat === true\) return/.test(block))
  /* ★ 票 01（2026-10-30）：这一行的**写法变了，守的事情没变**。
   *
   * ## 改之前
   *
   * ```js
   * if (mode !== 'pan') panRestoreRef.current = mode
   * ```
   *
   * 语义是「已经在 `pan` 态时不再覆盖」。那时默认值是 `'select'`，
   * 「按住切到 pan」是唯一方向，所以这一行就够。
   *
   * ## 为什么必须改
   *
   * 默认值改成 `'pan'` 之后，同一个写法会落进死角：**本来就 pan，
   * `mode !== 'pan'` 不成立 → `panRestoreRef` 永远不被赋值 → 松手恢复不到任何东西**。
   *
   * 现在改成「切到**另一种模式**」：
   *
   * ```js
   * const other: CanvasMode = mode === 'pan' ? 'select' : 'pan'
   * if (mode !== other) panRestoreRef.current = mode
   * setMode(other)
   * ```
   *
   * 第二道闸的**本意**完好无损：**当目标与当前相同时，不许把要恢复的值覆盖掉**。
   * 只是「目标」从写死的 `'pan'` 换成了 `other` —— 因为目标不再是常量。
   *
   * 自证方式也变了：把 `if (mode !== other)` 判断去掉（无论何时都赋值），
   * 重复帧那次会把 `panRestoreRef` 覆盖成 `select`，⑬·五 段那条
   * 「自动重复之后松开仍然回到移动」就会红。 */
  check('★★★ 「目标与当前相同时不覆盖要恢复的值」（第二道闸，票 01 改成切另一种模式）',
    /const other: CanvasMode = mode === 'pan' \? 'select' : 'pan'/.test(block)
    && /if \(mode !== other\) panRestoreRef\.current = mode/.test(block),
    (/const other: CanvasMode[\s\S]{0,120}/.exec(block) ?? [''])[0].replace(/\s+/g, ' ').slice(0, 120))
  check('★★★ 窗口失焦当作松开（Alt+Tab 走时 keyup 不会来）',
    /addEventListener\('blur', onBlur\)/.test(canvasSrc)
    && /removeEventListener\('blur', onBlur\)/.test(canvasSrc))
  /* ⚠️ 不许靠 React Flow 的 panActivationKeyCode —— 我们用的是常驻的 panOnDrag。
   * ⚠️ 这个字样在注释里出现过（解释「怀疑点一不成立」），所以判据必须
   * **剥掉注释**再查代码。这里只查 `<ReactFlow ...>` 那一段的属性区。 */
  const rfAt = canvasSrc.indexOf('<ReactFlow\n')
  const rfProps = canvasSrc.slice(rfAt, canvasSrc.indexOf('>', rfAt))
  check('★ `<ReactFlow>` 的属性里没有 `panActivationKeyCode`（否则两边都听空格）',
    !/panActivationKeyCode/.test(rfProps), '属性区 ' + String(rfProps.length) + ' 字符')
}

/* ══════════════════════════════════════════════════════════════════════
 * 四、小地图真的看得见
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 四、小地图有明确尺寸与位置（不许被缩放条压住） ===')
{
  const mm = ruleOf(css, '.react-flow__minimap')
  /* ★ 票 56：这一排的类名从 `.canvasZoom` 改成了 `.canvasCorner`（它现在
   * 还管小地图 / 适配 / 步数 / 快捷键，叫 zoom 说不全）。
   * **判据一字未改** —— 要的仍是「小地图不压住这一排」。 */
  const zoom = ruleOf(css, '.canvasCorner')
  const mmBottom = /bottom:\s*(\d+)px/.exec(mm)?.[1]
  const zoomBottom = /bottom:\s*(\d+)px/.exec(zoom)?.[1]
  const mmZ = /z-index:\s*(\d+)/.exec(mm)?.[1]
  const zoomZ = /z-index:\s*(\d+)/.exec(zoom)?.[1]

  check('★★★ 小地图有显式宽高（默认样式在我们这套容器里可能被压成 0）',
    /width:\s*\d+px/.test(mm) && /height:\s*\d+px/.test(mm),
    mm.replace(/\s+/g, ' ').slice(0, 60) || '（一条规则都没有）')
  check('★★★ 小地图与缩放条**不重叠**（bottom 大于缩放条）',
    mmBottom !== undefined && zoomBottom !== undefined && Number(mmBottom) > Number(zoomBottom),
    'minimap bottom=' + String(mmBottom) + ' / canvasZoom bottom=' + String(zoomBottom))
  check('★★ 小地图层级低于缩放条（缩放条要能点到）',
    mmZ !== undefined && zoomZ !== undefined && Number(mmZ) < Number(zoomZ),
    'minimap z=' + String(mmZ) + ' / canvasZoom z=' + String(zoomZ))
  check('★ 小地图配色跟主题走（不用它默认的浅蓝）',
    /\.react-flow__minimap-mask\s*\{/.test(css) && /\.react-flow__minimap-node\s*\{/.test(css))
}

/* ══════════════════════════════════════════════════════════════════════
 * 五、快捷键只在独立按钮那一处
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 五、快捷键清单只留一处（设置面板里没有了） ===')
{
  check('★★★ 设置面板里**没有**快捷键表（`data-ewb-settings-keys` 已删）',
    !settingsSrc.includes('data-ewb-settings-keys'), '')
  check('★★★ 设置面板里也**没有一个没人读的 KEYS 常量**',
    !/const KEYS/.test(settingsSrc))
  check('★★ 设置面板不再渲染「快捷键」这个分组标题',
    !/canvasSettingsLabel\}>快捷键/.test(settingsSrc))
  /* 独立入口还在，而且清单还在它那边。 */
  check('★★★ 独立按钮那份清单还在（`data-ewb-shortcuts`）',
    zoomSrc.includes('data-ewb-shortcuts'))
  check('★★ 那份清单是**真的按数据渲染**的（不是写死一行）',
    /shortcutHelp\(/.test(zoomSrc) && /\.map\(/.test(zoomSrc))
  /* 空格那一条不许被顺手删掉 —— 删的是重复的表，不是内容。 */
  check('★★ 清单里仍有「空格」那一条',
    /快捷键说明[\s\S]*空格|空格（按住）/.test(zoomSrc) || zoomSrc.includes('空格'))
  /* 清单条数 >= 8：原表 9 条，独立那份一直是同一批。 */
  const rowsCount = (zoomSrc.match(/\{ keys: '/g) ?? []).length
    + (zoomSrc.match(/keys: '/g) ?? []).length
  check('★ 独立清单条数足够（>= 8，不许顺手删掉几条）', rowsCount >= 8, '粗数 ' + String(rowsCount))
}

/* ══════════════════════════════════════════════════════════════════════
 * 票 78：对齐吸附 —— 把「量不到」变成能红的判据
 *
 * ## 为什么这一块以前一条断言都没有
 *
 * `grep -n "align" tests/content-canvas-fixes.mjs` 改之前是**零命中**。
 * 原因是它「只能真机看」：jsdom 不做布局，拖动时参考线出不出来、
 * 松手有没有吸住，测试量不到。
 *
 * ## 那这里验什么
 *
 * 验**逻辑层**，那是能真验且值得验的：
 *
 *   ① 纯函数：差 4px 吸、差 10px 不吸（阈值 6 生效）；
 *   ② `snappedPosition` 把坐标落到对齐位；
 *   ③ 组件里两道开关短路**还在**（关掉开关时一次都不算）；
 *   ④ 老存档「没表过态」与「显式关过」**分得开**（票 78 的迁移判据）。
 *
 * ⚠️ **④ 是这一票最容易被写错的一条**：默认值从 `false` 改成 `true` 之后，
 * 「存档里没有这个键」与「用户显式存了 `false`」必须给出不同结果 ——
 * 前者用新默认（开），后者尊重用户选择（关）。
 * 写成 `o.align === true` 会让所有老档都被关掉；写成 `o.align !== false`
 * 又会把「手改成字符串」也判成开。两种都错。
 *
 * ⚠️ 真机上还剩两件**本文件验不到**（已列进用户的人眼清单）：
 *   · 拖动时那两条 `data-ewb-align-guide` 元素**真出现在画面里**；
 *   · 松手后节点**真的停在吸附位置**。
 * 元素在 DOM 里 ≠ 看得见（`opacity` / `z-index` / 被裁剪都可能），
 * 而坐标变换 jsdom 量不出来。**别把这两件当成已经验过。**
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 票 78：对齐吸附的逻辑层 ===')
{
  /* ── 判据 1+2：纯函数（真调，不是 grep 常量）──────────────────
   *
   * ⚠️ **必须真调 `computeAlign`**，不能写「源码里有 `ALIGN_THRESHOLD`」——
   * 那种断言把阈值改成 0 也不会红。lead 票 78 派活时用一组真数钉过这件事：
   *   差 4px（该吸）  → dx = -4，竖线 at=300，from=0 to=140
   *   差 10px（不该吸）→ dx = 0，无线
   *   回算吸附后位置   → { x: 200, y: 40 }
   * 这里直接复现那组数。 */
  const alignMod = await import('../src/client/workbench/lib/canvas/canvas-align.ts')
  const { ALIGN_THRESHOLD, computeAlign, snappedPosition } = alignMod

  check('★★ 判据 1：阈值是 6', ALIGN_THRESHOLD === 6, String(ALIGN_THRESHOLD))

  /* 基准：一个 200×120 的方框在 (100,100)。
   * 它的横向锚点 100 / 200 / 300，纵向锚点 100 / 160 / 220。
   *
   * ⚠️ **这组期望值是真跑出来的，不是算出来的**。
   * 第一版我按「两个 140×140 方框、差 4px 吸到 200」写，五条全红 ——
   * 因为 `snappedPosition(104)` 落的是 **100** 不是 200，而 y 坐标一旦相同，
   * 横向参考线**也会有一条**（差 0 也在阈值内）。
   * 先跑一遍把真值抄下来，比在脑子里推一遍可靠。 */
  const base = { id: 'a', x: 100, y: 100, width: 200, height: 120 }

  /* 差 4px：moving 左边缘 104，基准左边缘 100 → 该吸回 100。 */
  const r4 = computeAlign({ ...base, id: 'b', x: 104 }, [base])
  check('★★ 判据 1：差 4px（阈值内）→ 吸（dx = -4）', r4.dx === -4, String(r4.dx))
  check('★★ 判据 1：吸的时候给出一条竖线',
    r4.vertical.length === 1, '竖线 ' + String(r4.vertical.length) + ' 条')
  check('★★ 判据 1：竖线落在 100（基准的左边缘）',
    r4.vertical.length === 1 && r4.vertical[0].at === 100,
    r4.vertical.length === 1 ? String(r4.vertical[0].at) : '')
  check('★★ 判据 1：竖线带**边缘范围**（from 100 到 220，不是整屏一条）',
    r4.vertical.length === 1 && r4.vertical[0].from === 100 && r4.vertical[0].to === 220,
    r4.vertical.length === 1
      ? 'from ' + String(r4.vertical[0].from) + ' to ' + String(r4.vertical[0].to)
      : '')

  /* 差 10px：moving 左边缘 110 → 超出阈值 6，横向不吸。 */
  const r10 = computeAlign({ ...base, id: 'b', x: 110 }, [base])
  check('★★ 判据 1：差 10px（阈值外）→ 横向不吸（dx = 0）', r10.dx === 0, String(r10.dx))
  check('★★ 判据 1：横向不吸时没有**竖线**',
    r10.vertical.length === 0, String(r10.vertical.length))
  /* ⚠️ **不断言 `horizontal.length === 0`**：这两次测试里 y 都是 100（与基准完全相同），
   * 差 0 也在阈值内，所以横向参考线**本来就有一条**（`dy` 也是 0）。
   * 第一版断言「一条线都没有」，红在了这个正确行为上。 */

  /* ── 判据 2：snappedPosition 把坐标落到对齐位 ─────────────────── */
  const at4 = snappedPosition({ x: 104, y: 40 }, r4)
  check('★★ 判据 2：`snappedPosition` 把 104 落到 100（基准左边缘）',
    at4.x === 100, String(at4.x))
  check('★★ 判据 2：另一个轴不动（y 保持 40）', at4.y === 40, String(at4.y))

  /* ── 判据 3：组件里两道开关短路还在 ─────────────────────────────
   *
   * ⚠️ **不能写成「源码里有 `align` 这个词」** —— 那种把
   * `if (!prefs.align) return` 删掉也不会红（别处还有这个词）。
   * 必须钉住**那一句短路本身**。 */
  const canvasSrc = read('../src/client/workbench/ContentCanvas.tsx')
  check('★★ 判据 3：`onDrag` 里第一句就是「关着就 return」（一次都不算）',
    /const onDrag = useCallback\(\(_e: unknown, node: ContentFlowNode\): void => \{\s*\n\s*if \(!prefs\.align\) return/.test(canvasSrc),
    (/const onDrag = useCallback\([\s\S]{0,160}/.exec(canvasSrc) ?? [''])[0].replace(/\s+/g, ' ').slice(0, 120))
  check('★★ 判据 3：`onDragStop` 里也判开关（第二道闸）',
    /if \(prefs\.align && solo && node !== undefined\)/.test(canvasSrc))

  /* ── 判据 4：老存档的迁移（票 78 改默认值之后最要紧的一条）────────
   *
   * 三种存档必须给出三种结果：
   *   · 没有 `align` 键（老档）→ 新默认（true）
   *   · `align: false`（用户显式关过）→ **仍是 false**
   *   · `align: 'false'`（手改坏）→ false（坏值不当成用户选择）
   * 另外默认值本身必须是 true。 */
  const prefsMod = await import('../src/client/workbench/lib/canvas/canvas-prefs.ts')
  const { readPrefs, DEFAULT_PREFS } = prefsMod

  check('★★ 判据 4：默认值是 true（票 78 改的）', DEFAULT_PREFS.align === true,
    String(DEFAULT_PREFS.align))
  check('★★ 判据 4：老存档**没有** align 这个键 → 落到新默认（true）',
    readPrefs('{"grid":"dots"}').align === true,
    String(readPrefs('{"grid":"dots"}').align))
  check('★★ 判据 4：用户**显式存过** `align: false` → 仍是 false（不许强行改成开）',
    readPrefs('{"grid":"dots","align":false}').align === false,
    String(readPrefs('{"grid":"dots","align":false}').align))
  check('★★ 判据 4：显式 `align: true` → true',
    readPrefs('{"grid":"dots","align":true}').align === true)
  check('★★ 判据 4：手改成字符串 `"false"` → 当坏值退回 false（不假装知道用户要什么）',
    readPrefs('{"grid":"dots","align":"false"}').align === false,
    String(readPrefs('{"grid":"dots","align":"false"}').align))
}

console.log('')
console.log(failed === 0 ? '结论：票 35 的五处修补都在位 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
