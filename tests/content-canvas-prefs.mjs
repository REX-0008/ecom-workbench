/**
 * 内容画布的**纯函数判据**（背景参数、设置面板三档、名字位置、选中描边、显示名）。
 *
 * ## 为什么从 `content-canvas.mjs` 拆出来
 *
 * 那个文件已经 445 条断言 / 20.1s（阈值 20s），**余量是 0**。
 * 而这一段**一个 DOM 都不碰** —— 只 import store 与 `canvas-prefs.ts`，再读几个
 * 源文件比对。挂在 jsdom 那一套里跑纯属白花时间。
 *
 * 拆完两份各自都留有余量，后面再加判据不用再动这里。
 */

import { readFileSync } from 'node:fs'

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

/* ══════════════════════════════════════════════════════════════════════
 * ㉑ 画布返修 A3–A7（用户 m03414）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ㉑ 设置面板三档 / 名字在框上 / 选中描边 / 「综合」 / 设置落盘 ===')
{
  const store = await import('../src/client/workbench/content-canvas-store.ts')
  const prefs = await import('../src/client/workbench/lib/canvas/canvas-prefs.ts')
  const { PANEL_WIDTHS, panelWidthFor, panelPlacement } = store
  const fs = await import('node:fs')

  /* ── A3 判据 3：三档 + 出现在节点下方 + 不随缩放变形 ── */
  check('★★ 面板宽度是**三档**（不是固定 268px）',
    PANEL_WIDTHS.length === 3, PANEL_WIDTHS.join(','))
  check('★★ 窄画布（< 720）用最窄那档', panelWidthFor(600) === 260, String(panelWidthFor(600)))
  check('★★ 常见窗口（720–1100）用中间那档', panelWidthFor(900) === 320, String(panelWidthFor(900)))
  check('★★ 宽屏（≥ 1100）用最宽那档', panelWidthFor(1400) === 380, String(panelWidthFor(1400)))
  check('★ 宽度读不到（0 / NaN）不炸，给中间那档',
    panelWidthFor(0) === 320 && panelWidthFor(Number.NaN) === 320)

  /* 出现在节点**下方**：锚点是节点底边，面板顶边在它下面一点。 */
  {
    const place = panelPlacement(
      { x: 500, y: 400 }, 200,
      { w: 320, h: 260, boxW: 1200, boxH: 900 },
    )
    check('★★ 判据 3：面板出现在节点**下方**（顶边在锚点之下）',
      place.top > 400 && place.flipped === false, String(place.top))
    check('★★ 水平居中在节点上（面板中心 ≈ 节点横中心）',
      Math.abs((place.left + 160) - 500) < 1, String(place.left))
  }
  /* 节点在屏幕底部 → 往上翻（否则面板跑出可视区）。 */
  {
    const place = panelPlacement(
      { x: 500, y: 840 }, 700,
      { w: 320, h: 260, boxW: 1200, boxH: 900 },
    )
    check('★★ 判据 3：节点在底部时面板**往上翻**（不许跑出可视区）',
      place.flipped === true && place.top < 700, String(place.top))
    check('★ 往上翻之后**顶边不低于 8px**（不跑出上边）', place.top >= 8, String(place.top))
  }
  /* 靠近右墙 → 往左挤，但不越过左边界。 */
  {
    const place = panelPlacement(
      { x: 1180, y: 300 }, 100,
      { w: 320, h: 200, boxW: 1200, boxH: 900 },
    )
    check('★★ 靠右墙时往左挤，不越过右边界',
      place.left + 320 <= 1200 - 8 + 0.01, String(place.left))
  }

  /* ★ 不随缩放变形：两个纯函数的入参里**没有 zoom**，且宽度只由画布宽度决定。 */
  {
    const src = fs.readFileSync('src/client/workbench/lib/canvas/canvas-prefs.ts', 'utf8')
      + fs.readFileSync('src/client/workbench/content-canvas-store.ts', 'utf8')
    const body = src.slice(src.indexOf('export function panelWidthFor'), src.indexOf('export interface PanelPlacement'))
    check('★★ 判据 3：宽度函数**只看画布宽度**，不看 zoom（缩放不变形）',
      body.includes('canvasWidth') && !body.includes('zoom'), '')
  }

  /* ── A4 判据 4：标题看得见 + 点得到（票 35 重写） ──
   *
   * ## 为什么这一段整段换掉（2026-10-28）
   *
   * 原来这里有两条**假绿**，用户实测报「我在当前画布中没看到标题，也没看到能改标题的地方」，
   * 而它们一直是绿的：
   *
   * | 原断言 | 为什么是假绿 |
   * |---|---|
   * | 查 CSS 里有没有 `opacity: 0` + hover 时 `opacity: 1` | **只查了透明度，没查会不会被裁掉**。`.contentNode` 有 `overflow: hidden`，而标题用 `bottom: 100%` 挂在框外 → `opacity: 1` 也一个像素看不见 |
   * | 查源码切片里有没有改名逻辑 | **只查代码存在，没查它能不能被执行**。`pointer-events: none` 让标签永远收不到点击，那段 `onClick` 一次都跑不到 |
   *
   * 教训与新换成什么见下面每条。**判断准则：判据要证明「用户看得见 / 点得到」，
   * 而不是「源码里写了这几个词」。**
   */
  {
    /* ⚠️ **先剥掉注释**再比：那几段注释里就写着 `overflow: hidden`、`pointer-events: none`
     * 这些字样（它们在解释「原来错在哪」）—— 不剥的话新判据会永远红，
     * 而红的原因恰恰是它要防的那件事被**注释**匹配到了。 */
    const cssRaw = fs.readFileSync('src/client/workbench/EcomWorkbench.module.css', 'utf8')
    const cssText = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '')
    const ruleOf = (sel) => {
      const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(cssText)
      return m?.[1] ?? ''
    }

    check('★☆ 判据 4a：名字仍在**框上方**（`bottom: 100%`，不是在框内底部）',
      ruleOf('.contentNodeName').includes('bottom: 100%'))

    /* ★ 真断言一：**不被祖先裁掉**。
     *
     * 判据落在结构上而不是「有没有 overflow 这个词」：
     *   ① 标题所在的那一层（`.contentNodeWrap`）必须是 `overflow: visible`；
     *   ② 裁剪只许发生在**内层** `.contentNode`（图片圆角要用）。
     * 两条合起来才等于「标题画在框外也看得见」。 */
    check('★★★ 判据 4b：标题所在那层**不裁剪**（`.contentNodeWrap` 是 visible）',
      /overflow:\s*visible/.test(ruleOf('.contentNodeWrap')),
      ruleOf('.contentNodeWrap').replace(/\s+/g, ' ').slice(0, 80) || '（没有 .contentNodeWrap 规则）')
    check('★★★ 判据 4c：裁剪只在**内层**（`.contentNode` 仍是 hidden，管图片圆角）',
      /overflow:\s*hidden/.test(ruleOf('.contentNode')),
      ruleOf('.contentNode').replace(/\s+/g, ' ').slice(0, 80) || '（没有 .contentNode 规则）')

    /* ★ 真断言二：**点得到**。
     *
     * 直接查 `pointer-events` —— 那个属性就是「能不能收到指针事件」的本体，
     * 比「源码里有没有 onClick」具体得多。
     * 缺省值是 `auto`，所以「没写」也算能点；只有明确写 `none` 才是缺陷。 */
    const nameRule = ruleOf('.contentNodeName')
    check('★★★ 判据 4d：标题**不是** `pointer-events: none`（写了就永远点不到）',
      !/pointer-events:\s*none/.test(nameRule),
      /pointer-events:\s*none/.test(nameRule) ? '写着 none —— 一次点击都收不到' : '没写 none ✓')

    /* ★ 真断言三：**是双击改名**（照参考项目 `canvas-node.tsx:372`）。
     *
     * ⚠️ 这一条**换了期望值**，理由是原来那条写错了：
     * 旧断言要求「单击改名」，而落地时发现单击必须留给「选中节点 + 开设置面板」
     * （那是这个画布的主交互）。票 35 重读参考项目后定为双击 ——
     * 用户以前那句「可以点击后修改」描述的是**意图**（能改），不是**手势**（单击还是双击）。 */
    const nodeSrc = fs.readFileSync('src/client/workbench/content-nodes.tsx', 'utf8')
    const startAt = nodeSrc.indexOf('function NodeName')
    const rest = nodeSrc.slice(startAt + 1)
    const nextFn = rest.search(/\nfunction [A-Z]/)
    const nameComp = nodeSrc.slice(startAt, nextFn < 0 ? nodeSrc.length : startAt + 1 + nextFn)
    check('★★★ 判据 4e：**双击**改名（单击留给选中节点，照参考项目）',
      nameComp.includes('onDoubleClick='), nameComp.includes('onDoubleClick=') ? '' : '没有 onDoubleClick')
    check('★★ 判据 4f：双击仍然 `stopPropagation`（否则会连带触发画布选中/开面板）',
      /onDoubleClick=\{\(e\) => \{\s*\n\s*e\.stopPropagation\(\)/.test(nameComp))
    check('★ 判据 4g：改名输入框有 `maxLength`（照参考项目 64；不设上限会存进几千字再也改不回来）',
      /maxLength=\{64\}/.test(nameComp))
  }

  /* ── A5 判据 5：选中描边，且与分组框区分 ── */
  {
    const cssText = fs.readFileSync('src/client/workbench/EcomWorkbench.module.css', 'utf8')
    check('★★ 判据 5：选中时 `.contentNode` 有可见描边（`box-shadow` 贴边实线）',
      /\.react-flow__node\.selected \.contentNode \{[^}]*inset 0 0 0 1\.5px/.test(cssText))
    check('★★ 判据 5：还有一层外发光（不只是细描边）',
      /\.react-flow__node\.selected \.contentNode \{[^}]*0 0 14px/.test(cssText))
    const groupSel = cssText.slice(
      cssText.indexOf('.react-flow__node.selected .contentGroup'),
      cssText.indexOf('.react-flow__node.selected .contentGroup') + 300,
    )
    check('★★ 判据 5：分组框选中态**只有外光、没有贴边实线**（保住虚线观感，与内容节点肉眼可分）',
      groupSel.includes('box-shadow') && !groupSel.includes('inset'), groupSel.slice(0, 120))
  }

  /* ── A6 判据 6：显示「综合」，存档仍是 config ── */
  check('★★ 判据 6：显示名是「综合」', store.TYPE_LABEL.config === '综合', store.TYPE_LABEL.config)
  check('★★ 判据 6：**节点类型仍是 `config`**（老存档能打开）',
    store.isNodeType('config') === true && store.TYPE_LABEL.config !== 'config')
  check('★ 存档里形状未变：`type` 的取值集合还是那六个',
    ['text', 'image', 'video', 'audio', 'config', 'group'].every(t => store.isNodeType(t)))

  /* ── A7 / 判据 7：设置能改、能落盘、刷新后还在、能恢复默认 ── */
  check('★ 默认值是点阵背景、20% 线格深浅、小地图开',
    prefs.DEFAULT_PREFS.grid === 'dots'
    && prefs.DEFAULT_PREFS.lineOpacity === 0.2
    && prefs.DEFAULT_PREFS.miniMap === true)
  /* 存 → 读回来（等价于刷新后仍在） */
  {
    const changed = prefs.patchPrefs(prefs.DEFAULT_PREFS, {
      grid: 'lines', lineOpacity: 0.35, miniMap: false, dropGap: 40, panelWidth: 380, nodeW: 360,
    })
    const back = prefs.readPrefs(JSON.stringify(changed))
    check('★★ 判据 7：改了七项 → 存 → 读回来**每一项都在**（刷新后仍在）',
      back.grid === 'lines' && back.lineOpacity === 0.35 && back.miniMap === false
      && back.dropGap === 40 && back.panelWidth === 380 && back.nodeW === 360,
      JSON.stringify(back))
    check('★★ 判据 7：恢复默认之后与 `DEFAULT_PREFS` 逐字段一致',
      prefs.isDefaultPrefs({ ...prefs.DEFAULT_PREFS }) === true)
    check('★★ 判据 7：改过的**不**算默认（「恢复默认」按钮有活的余地）',
      prefs.isDefaultPrefs(changed) === false)
  }
  /* 容错：坏存档不许把画布搞崩 */
  check('★★ 坏存档（不是 JSON）→ 退回默认，不抛',
    prefs.readPrefs('{{{bad').grid === prefs.DEFAULT_PREFS.grid)
  check('★★ 越界值被夹回范围（手改成 99999 不许把界面撑坏）',
    prefs.readPrefs('{"nodeW":99999,"dropGap":-5}').nodeW === 800
    && prefs.readPrefs('{"nodeW":99999,"dropGap":-5}').dropGap === 0)
  check('★ 非法面板档位退回 auto',
    prefs.readPrefs('{"panelWidth":999}').panelWidth === 'auto')
  check('★★ `miniMap` 只有明确 true 才算开（手改成字符串 "true" 不算）',
    prefs.readPrefs('{"miniMap":"true"}').miniMap === false)

  /* 线格深浅换算 */
  check('★★ 线格深浅 0.2 → `color-mix` 里是 20%（A2 那个值现在由设置决定）',
    prefs.lineColorOf(0.2).includes('20%'), prefs.lineColorOf(0.2))
  check('★ 0.35 不许出 `35.000000000000004%` 这种串',
    prefs.lineColorOf(0.35).includes('35%') && !prefs.lineColorOf(0.35).includes('0000'),
    prefs.lineColorOf(0.35))

  /* 源码层：原来那两个裸 `useState` 必须已经不在了 */
  {
    const canvasSrc = fs.readFileSync('src/client/workbench/ContentCanvas.tsx', 'utf8')
    check('★★ 判据 7（根因）：背景模式**不再是裸 `useState`**（原来刷新就回默认）',
      !/useState<'dots' \| 'lines' \| 'none'>/.test(canvasSrc))
    check('★★ 判据 7：改设置会写回本地存储（`writePrefs` 在改的那条路上被调）',
      canvasSrc.includes('writePrefs(next)'))
    check('★★ 设置面板真的挂在画布上（有入口按钮 + 面板组件）',
      canvasSrc.includes('data-ewb-settings-open') && canvasSrc.includes('<CanvasSettingsPanel'))
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑳ 画布背景：线格与点阵不许共用参数（用户 m03414）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 用户原话：「线格过于明显过于密集，间距增加 4 倍、（透明）度下降」。
 * 原来的实现是**点阵与线格共用 `gap={18}`**，所以改线格就得连点阵一起改 ——
 * 那不是用户要的（他只说了线格）。
 */
console.log('')
console.log('=== ⑳ 线格间距 4 倍、透明度 20%，点阵保持原样 ===')
{
  const {
    DOT_GAP, DOT_SIZE, LINE_GAP, LINE_SIZE,
  } = await import('../src/client/workbench/content-canvas-store.ts')
  /* 线格颜色现在由设置算（常量 `LINE_COLOR` 已退役），从偏好模块取。 */
  const { lineColorOf, DEFAULT_PREFS } = await import('../src/client/workbench/lib/canvas/canvas-prefs.ts')

  check('★★ 判据 2：线格间距 = 点阵的 **4 倍**',
    LINE_GAP === DOT_GAP * 4, DOT_GAP + ' → ' + LINE_GAP)
  check('★★ 点阵间距保持原样（用户只说了线格，动它就是擅自改需求）',
    DOT_GAP === 18, String(DOT_GAP))
  check('★ 点阵点径也保持原样', DOT_SIZE === 1, String(DOT_SIZE))
  check('★★ 线格线更细（72px 一格的粗线反而比点阵更抢眼）',
    LINE_SIZE < DOT_SIZE, LINE_SIZE + ' < ' + DOT_SIZE)
  /* ⚠️ 2026-10-27 改准（不是放宽）：这两条原来断言的是**常量 `LINE_COLOR`**
   * 里带 20% 与 `--v1-edge`。常量随这一单退役了（20% 现在由设置
   * `lineOpacity` 决定），所以改成断言**默认设置下取出来的那个值**。
   *
   * 意图一字没变：线格半透明、颜色跟主题走。换的只是取值来源。 */
  check('★★ 线格颜色带 20% 透明度（不是纯色）',
    lineColorOf(DEFAULT_PREFS.lineOpacity).includes('20%'),
    lineColorOf(DEFAULT_PREFS.lineOpacity))
  check('★ 颜色跟主题走（用 `--v1-edge`，写死灰色在深色主题下会看不见）',
    lineColorOf(DEFAULT_PREFS.lineOpacity).includes('--v1-edge'),
    lineColorOf(DEFAULT_PREFS.lineOpacity))

  /* 源码层面：JSX 里两个 gap 必须**分开算**，不许再是一个常量 */
  const fs = await import('node:fs')
  const src = fs.readFileSync('src/client/workbench/ContentCanvas.tsx', 'utf8')
  check('★★ `Background` 的 gap 是按模式分开给的（不是一个数给两种模式）',
    /gap=\{[^}]*grid === 'lines'[^}]*LINE_GAP[^}]*DOT_GAP/.test(src.replace(/\n\s*/g, ' '))
    || /gap=\{grid === 'lines' \? LINE_GAP : DOT_GAP\}/.test(src))
  /* ⚠️ 2026-10-27 改准（不是放宽）：颜色值从**常量 `LINE_COLOR`** 换成
   * **设置 `lineColorOf(prefs.lineOpacity)`** —— 这正是这一单要做的
   * 「让线格深浅真的生效」。
   *
   * 判据强度没变：仍然断言「**只有线格**给颜色、点阵不变」，也就是 `color`
   * 必须包在 `grid === 'lines'` 的条件里。变的是那一条判断的**取值来源**，
   * 从常量换成偏好 —— 如果哪天有人把条件去掉（点阵也吃到 color），这条照样红。 */
  /* ⚠️ **2026-10-29（票 59）判据换了形态，守的事情没变**。
   *
   * ## 改前守的是什么
   *
   * 「`color` 必须包在 `grid === 'lines'` 这个条件里」—— 因为那时
   * **只有线格**有颜色，点阵走 React Flow 默认值。那条断言真正的目的是
   * 「**线格深浅**这条设置只影响线格，不许顺带把点阵也改了」。
   *
   * ## 票 59 为什么要改它
   *
   * 用户要求「增加透明度设置（参考线、**点**的透明度）」。
   * 点阵原来根本没拿到 `color`，所以那条「点阵不变」在**新需求下不成立**了 ——
   * 点阵现在也要有颜色（带透明度）。这不是放宽，是**被守的对象变了**。
   *
   * ## 新判据怎么守同一件事
   *
   * 拆成三条，合起来比原来那条更强：
   *   ① 两档都给 `color`（都用 `patternColorOf` —— 一个函数，算法一致）；
   *   ② 线格档读的是 `lineOpacity`（那条老滑块**仍然只管线格**）；
   *   ③ 点阵档读的是 `patternOpacity`（新字段），**不是** `lineOpacity`。
   *
   * 第 ③ 条正是原来那条断言真正守着的东西：调「线格深浅」不该动点阵。 */
  check('★★ 票 59：两档都用 patternColorOf 给 color（点阵现在也有颜色了）',
    /color=\{patternColorOf\(/.test(src))
  check('★★ 票 59：线格档读 lineOpacity（那条老滑块仍只管线格）',
    /grid === 'lines'\s*\?\s*Math\.round\(prefs\.lineOpacity \* 100\)/.test(src),
    (/grid === 'lines'[\s\S]{0,80}/.exec(src) ?? [''])[0].slice(0, 80))
  check('★★ 票 59：点阵档读 patternOpacity（**不是** lineOpacity —— 调线格不该动点阵）',
    /:\s*\(prefs\.patternOpacity \?\? 20\)/.test(src),
    (/:\s*\(prefs\.patternOpacity[\s\S]{0,40}/.exec(src) ?? [''])[0])
}

/* ══════════════════════════════════════════════════════════════════════
 * ㉒ 四项设置「真的用上了」（用户 m01921）
 *
 * ## 为什么这一段必须存在
 *
 * 上一轮（`8cbc702`）把七项设置做进了面板、落进了 `localStorage`、判据也全绿 ——
 * 但其中**四项画布根本没读**：
 *
 * | 设置项 | 面板 | 落盘 | 谁读它 |
 * |---|---|---|---|
 * | `nodeW` / `nodeH` | ✓ | ✓ | **没人**（`newNode` 用 `NODE_SIZE`） |
 * | `lineOpacity` | ✓ | ✓ | **没人**（`Background` 用常量 `LINE_COLOR`） |
 * | `dropGap` | ✓ | ✓ | **没人**（`addNode` 写死 `nodes.length * 24`） |
 * | `panelWidth` | ✓ | ✓ | **只读了一半**（`panelWidthFor` 只收画布宽度） |
 *
 * 这就是 lead 说的**假绿**：`canvas-prefs.mjs` 验的是「`patchPrefs` 之后
 * `localStorage` 里那个值对不对」，它**验不到「画布用没用它」**。
 *
 * 所以这一段的方法固定成三条：
 *   ① **注入不同的值，看输出变不变**（不是「函数返回写死的数」）；
 *   ② 需要源码证的那一条，**剥注释再比**（注释里也会写旧实现）；
 *   ③ 每条都配一个「值没变时结果也不变」的反向锚，防止误杀默认路径。
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ㉒ 四项设置真的用上了（节点尺寸 / 线格深浅 / 落位间距 / 面板档位） ===')
{
  const prefs = await import('../src/client/workbench/lib/canvas/canvas-prefs.ts')
  const store = await import('../src/client/workbench/content-canvas-store.ts')
  const { nodeSizeFrom, DEFAULT_PREFS, lineColorOf } = prefs
  const { NODE_SIZE, newNode, panelWidthFor, PANEL_WIDTHS } = store

  /* ── ① 节点默认宽高（`nodeW` / `nodeH`） ── */

  check('★★ 默认设置下「跟随类型」—— `nodeW` / `nodeH` 是 `null` 不是数字',
    DEFAULT_PREFS.nodeW === null && DEFAULT_PREFS.nodeH === null,
    JSON.stringify({ w: DEFAULT_PREFS.nodeW, h: DEFAULT_PREFS.nodeH }))

  /* 这条是整个「跟随类型」设计的根：默认值必须让每种类型拿到自己那份尺寸。
   * 如果哪天有人给默认塞了个数字，各类型就都会被压成同一个框。 */
  const imgDefault = nodeSizeFrom(DEFAULT_PREFS, NODE_SIZE.image)
  const textDefault = nodeSizeFrom(DEFAULT_PREFS, NODE_SIZE.text)
  /* ★ 数字在票 34 换成了参考项目那一套（`constant/canvas.ts:13`）。
   * 判据强度不变 —— 仍然是「某个具体数字对得上」，只是对的是新口径。 */
  check('★★ 默认设置下：图片用 340×240（参考那一套，不是老的 320×320）',
    imgDefault.width === 340 && imgDefault.height === 240,
    imgDefault.width + '×' + imgDefault.height)
  check('★★ 默认设置下：文本用 340×240（与图片同框，参考就是这么定的）',
    textDefault.width === 340 && textDefault.height === 240,
    textDefault.width + '×' + textDefault.height)
  check('★ 默认设置下：音频用 340×120（第三类，证明不是只对图片特判）',
    nodeSizeFrom(DEFAULT_PREFS, NODE_SIZE.audio).width === 340
    && nodeSizeFrom(DEFAULT_PREFS, NODE_SIZE.audio).height === 120,
    nodeSizeFrom(DEFAULT_PREFS, NODE_SIZE.audio).width + '×'
    + nodeSizeFrom(DEFAULT_PREFS, NODE_SIZE.audio).height)

  /* ══════════════════════════════════════════════════════════════════
   * ★★★ 逐类比对 `NODE_SIZE` 与参考项目那张表（票 34 判据 3）
   *
   * ## 为什么把数字**写死在断言里**
   *
   * 不从 `refs-projects/.../constant/canvas.ts` 读 —— 那是**另一个仓库的文件**，
   * 读它等于「测试依赖参考项目还在硬盘上」，换台机器就红。
   * 更糟的是：若哪天有人把这张表改成从参考项目动态读，那就成了
   * **自己和自己比**，改错也发现不了。
   *
   * 所以这里照抄参考那六个数字，一共两处数字、互不引用 —— 这才叫比对。
   *
   * 出处：`refs-projects/infinite-canvas/web/src/constant/canvas.ts:13`
   * ```ts
   * export const NODE_DEFAULT_SIZE = {
   *     Image:  { width: 340, height: 240 },
   *     Text:   { width: 340, height: 240 },
   *     Config: { width: 340, height: 240 },
   *     Video:  { width: 420, height: 236 },
   *     Audio:  { width: 340, height: 120 },
   *     Group:  { width: 760, height: 480 },
   * }
   * ```
   * ══════════════════════════════════════════════════════════════════ */
  const REF_SIZE = {
    image: { w: 340, h: 240 },
    text: { w: 340, h: 240 },
    config: { w: 340, h: 240 },
    video: { w: 420, h: 236 },
    audio: { w: 340, h: 120 },
    group: { w: 760, h: 480 },
  }
  for (const [kind, want] of Object.entries(REF_SIZE)) {
    const got = NODE_SIZE[kind]
    check('★★★ 尺寸照参考逐类一致：' + kind + ' → ' + String(want.w) + '×' + String(want.h),
      got !== undefined && got.width === want.w && got.height === want.h,
      got === undefined ? 'NODE_SIZE 里没有这一类' : got.width + '×' + got.height)
  }
  /* 反面：`batch` 是我们独有的类型，参考没有对应项 —— 它**不许**被顺手改成参考里的数。 */
  check('★★ `batch`（我们独有）不是参考那六个之一，保持 320×320',
    NODE_SIZE.batch.width === 320 && NODE_SIZE.batch.height === 320,
    NODE_SIZE.batch.width + '×' + NODE_SIZE.batch.height)
  /* 反面：五类里不能有「两个类型恰好共用一个框」以外的巧合 —— 逐类都不许退化成同一个。
   * （图片与文本参考里本来就同框，所以这里只断言 video 与 audio 与那两类的差异还在。） */
  check('★★ video 与 image 不是同一个框（参考里差在 420×236 对 340×240）',
    NODE_SIZE.video.width !== NODE_SIZE.image.width
    || NODE_SIZE.video.height !== NODE_SIZE.image.height)

  /* 填了数字 → 统一覆盖（注入两个不同的值，看输出跟着变）。
   * ⚠️ `nodeW` / `nodeH` 在票 34 起已退役（界面没有入口、画布不读），
   * 但 `nodeSizeFrom` 这个纯函数与它的解析逻辑**还在**（老存档兼容）。
   * 下面几条验的是「函数本身还对」，不是「界面还能配」。 */
  const wide = nodeSizeFrom({ nodeW: 400, nodeH: 400 }, NODE_SIZE.text)
  check('★★ 设置填了 400×400 → 文本节点被覆盖成 400×400（纯函数逻辑还在）',
    wide.width === 400 && wide.height === 400, wide.width + '×' + wide.height)
  const wide2 = nodeSizeFrom({ nodeW: 500, nodeH: 300 }, NODE_SIZE.image)
  check('★ 换成 500×300 也跟着变（不是恰好等于某条写死的数）',
    wide2.width === 500 && wide2.height === 300, wide2.width + '×' + wide2.height)

  /* 宽高**分开**判：只填宽不填高 */
  const onlyW = nodeSizeFrom({ nodeW: 420, nodeH: null }, NODE_SIZE.image)
  check('★★ 只填宽、不填高 → 宽 420、高仍是图片类型的 240（宽高分别判）',
    onlyW.width === 420 && onlyW.height === 240, onlyW.width + '×' + onlyW.height)
  const onlyH = nodeSizeFrom({ nodeW: null, nodeH: 260 }, NODE_SIZE.video)
  check('★ 只填高、不填宽 → 高 260、宽仍是视频类型的 420',
    onlyH.width === 420 && onlyH.height === 260, onlyH.width + '×' + onlyH.height)

  /* 真造一个节点，确认尺寸落进节点本身（不是只算出来给人看） */
  const realNode = newNode('image', { x: 0, y: 0 }, {}, nodeSizeFrom({ nodeW: 380, nodeH: 380 }, NODE_SIZE.image))
  check('★★ 新建节点真的带上那个尺寸（`newNode` 用了第四个参数）',
    realNode.width === 380 && realNode.height === 380,
    realNode.width + '×' + realNode.height)
  const plainNode = newNode('image', { x: 0, y: 0 })
  check('★ 不传尺寸 → 退回类型默认 340×240（老调用点不受影响）',
    plainNode.width === 340 && plainNode.height === 240,
    plainNode.width + '×' + plainNode.height)

  /* ── ② 线格深浅（`lineOpacity`） ── */

  check('★★ 0.2 与改之前那个常量**等价**（默认外观一字不差）',
    lineColorOf(0.2) === 'color-mix(in srgb, var(--v1-edge) 20%, transparent)',
    lineColorOf(0.2))
  /* 注入两档不同的透明度，输出必须不同 —— 否则「拖滑块没反应」还会回来 */
  check('★★ 0.5 给出 50%（注入不同值，结果跟着变）',
    lineColorOf(0.5).includes('50%'), lineColorOf(0.5))
  check('★★ 0.08 给出 8%（第二档，证明不是写死 50%）',
    lineColorOf(0.08).includes('8%'), lineColorOf(0.08))
  check('★ 0 → 0%，1 → 100%（两端不炸）',
    lineColorOf(0).includes(' 0%') && lineColorOf(1).includes('100%'),
    lineColorOf(0) + ' / ' + lineColorOf(1))
  check('★★ 越界的值被夹住（-3 → 0%，9 → 100%）',
    lineColorOf(-3).includes(' 0%') && lineColorOf(9).includes('100%'))

  /* ── ③ 落位间距（`dropGap`） ── */
  /* 这条只能走源码：`offset` 在 `addNode` 的闭包里，纯函数层看不到。
   * ⚠️ 要比的是**剥掉注释之后**的代码 —— 注释里就写着旧实现 `nodes.length * 24`，
   * 不剥的话「代码里没有 24」永远假绿。 */
  const fs2 = await import('node:fs')
  const rawSrc = fs2.readFileSync('src/client/workbench/ContentCanvas.tsx', 'utf8')
  /* 只留代码：先把块注释与行注释清掉，再压掉换行与缩进。 */
  const codeOnly = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
  check('★★ 落位间距读的是设置（`nodes.length * prefs.dropGap`）',
    codeOnly.includes('nodes.length * prefs.dropGap'))
  check('★★ 代码里**没有**写死的 `nodes.length * 24`（注释里提到它不算）',
    !codeOnly.includes('nodes.length * 24'))
  check('★ `addNode` 的依赖里有 `prefs`（改了设置下一次就能生效，不是闭包旧值）',
    /addNode = useCallback\([\s\S]*?\}, \[[^\]]*prefs[^\]]*\]\)/.test(codeOnly))

  /* ── ④ 面板宽度档位（`panelWidth`） ── */

  /* `'auto'` 仍按画布宽度选 —— 这是改之前的行为，必须留住。 */
  check('★★ `auto` 且画布很窄 → 260（自动档行为没变）',
    panelWidthFor(600, 'auto') === 260, String(panelWidthFor(600, 'auto')))
  check('★★ `auto` 且宽屏 → 380（自动档行为没变）',
    panelWidthFor(1400, 'auto') === 380, String(panelWidthFor(1400, 'auto')))
  /* 固定档**不吃画布宽度**：这是「固定」的定义 */
  check('★★ 固定 380 时，画布很窄也仍是 380（固定档不缩）',
    panelWidthFor(600, 380) === 380, String(panelWidthFor(600, 380)))
  check('★★ 固定 260 时，宽屏也仍是 260（不是又被自动撑开）',
    panelWidthFor(1400, 260) === 260, String(panelWidthFor(1400, 260)))
  check('★ 固定 320 时任何宽度都是 320',
    panelWidthFor(0, 320) === 320 && panelWidthFor(2000, 320) === 320)
  check('★ 三档都认得（260 / 320 / 380 各自返回自己）',
    PANEL_WIDTHS.every(w => panelWidthFor(900, w) === w))

  /* 画布真的把偏好传进去了（源码层）
   *
   * ⚠️ 票 35（2026-10-28）**改准了匹配位置，判据强度没降**：
   * 面板搬进节点之后，那段 JSX 从画布层的内联代码变成了 `renderPanel` 回调。
   * 但「传了 `prefs.panelWidth`」这条事实一个字没变 —— 面板宽度那个设置
   * 必须仍然生效（那是已经验过的功能，搬结构不许把它丢掉）。 */
  check('★★ 画布调 `panelWidthFor` 时传了 `prefs.panelWidth`（不是只传宽度）',
    /panelWidthFor\([^)]*prefs\.panelWidth[^)]*\)/.test(codeOnly))
  check('★★ 面板宽度**真的用到渲染上**了（`renderPanel` 里有 style.width）',
    /const w = panelWidthFor\([^)]*prefs\.panelWidth\)/.test(codeOnly)
    && /style=\{\{ width: w \}\}/.test(codeOnly))

  /* ── ⑤ 默认值不变：这四项的默认值与改之前逐字相同 ── */
  check('★★ 四项默认值不变（dropGap 24 / lineOpacity 0.2 / panelWidth auto / 尺寸 null）',
    DEFAULT_PREFS.dropGap === 24 && DEFAULT_PREFS.lineOpacity === 0.2
    && DEFAULT_PREFS.panelWidth === 'auto'
    && DEFAULT_PREFS.nodeW === null && DEFAULT_PREFS.nodeH === null,
    JSON.stringify({
      dropGap: DEFAULT_PREFS.dropGap,
      lineOpacity: DEFAULT_PREFS.lineOpacity,
      panelWidth: DEFAULT_PREFS.panelWidth,
      nodeW: DEFAULT_PREFS.nodeW,
    }))

  /* ── ⑥ 输入框那一层：清空 = 跟随类型，不是改成 0 ── */
  const { parseSizeOrNull } = prefs
  check('★★ 清空输入框 → `null`（跟随类型），**不是 0**',
    parseSizeOrNull('') === null && parseSizeOrNull('   ') === null,
    String(parseSizeOrNull('')))
  check('★★ 填 400 → 400（不是把 400 当字符串）',
    parseSizeOrNull('400') === 400 && typeof parseSizeOrNull('400') === 'number')
  check('★ 乱填（"abc"）→ `null`，不炸也不写 NaN',
    parseSizeOrNull('abc') === null && parseSizeOrNull('--') === null)
  /* ★ 源码层（票 34 换锚点，2026-10-28）。
   *
   * ## 原来验的是什么、为什么它现在必然红
   *
   * 原来两条断言验的是「设置面板里那对宽高输入框读 `null` 时显空串」与
   * 「改动走 `parseSizeOrNull`」。票 34 把那对输入框**删了** ——
   * 节点尺寸照参考项目逐类定死，不再有全局覆盖。所以那两条的红是对的。
   *
   * ## 换成什么（判据强度没降，反而多了半条）
   *
   * | 原来 | 现在 |
   * |---|---|
   * | 面板里有输入框、且 null 显空 | **面板里没有输入框了**（真的删干净） |
   * | 改动走 `parseSizeOrNull` | **字段本身留着**（老存档兼容，不许顺手清掉） |
   * | —— | **画布不再读它**（不读了才叫退役；还在读就是假退役） |
   *
   * 第三条是新增的：只删界面不删读取，等于「用户还能从老存档里把尺寸改回去」，
   * 那不是「定死」。 */
  const panelSrc = fs2.readFileSync('src/client/workbench/CanvasSettingsPanel.tsx', 'utf8')
  /* ⚠️ **先剥注释再比** —— 那段注释里就写着「『新节点尺寸』那一项已删」，
   * 不剥的话这条断言会一直红，而红的原因恰恰是它在解释「已经删了」。
   * 这一轮已经踩过两次同类问题（另一处是 `nodeSizeFrom` 的退役说明）。 */
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const panelCode = strip(panelSrc)
  check('★★★ 设置面板里**没有**新节点尺寸那一项了（票 34 删掉）',
    !panelCode.includes('data-ewb-settings-node-w')
    && !panelCode.includes('data-ewb-settings-node-h')
    && !panelCode.includes('新节点尺寸'), '')
  /* 字段留在 `CanvasPrefs` 里 —— 老存档里有值，删了会让「恢复默认」状态对不上。 */
  const prefsSrc = fs2.readFileSync('src/client/workbench/lib/canvas/canvas-prefs.ts', 'utf8')
  check('★★★ `nodeW` / `nodeH` 字段**留着**（老存档兼容，不是漏删）',
    /nodeW: number \| null/.test(prefsSrc) && /nodeH: number \| null/.test(prefsSrc))
  check('★★ 源码里写明了它们是退役字段（`@deprecated`）',
    /@deprecated/.test(prefsSrc), prefsSrc.includes('@deprecated') ? '' : '没有 @deprecated 标记')
  /* 画布不再读它们 —— 不读了才叫退役。同样要剥注释（退役说明里写着这个名字）。 */
  const canvasCode = strip(fs2.readFileSync('src/client/workbench/ContentCanvas.tsx', 'utf8'))
  check('★★★ 画布**不再调** `nodeSizeFrom`（尺寸回到 `NODE_SIZE[type]`）',
    !/nodeSizeFrom\(/.test(canvasCode), /nodeSizeFrom\(/.test(canvasCode) ? '还在调' : '已回退 ✓')
  check('★★ 新建节点直接用 `NODE_SIZE[type]`',
    /newNode\(type,[\s\S]{0,80}NODE_SIZE\[type\]\)/.test(canvasCode))
  /* ⚠️ 这个纯函数**不许**留在 `.tsx` 里：留在那里，验它的测试就得加载 CSS。 */
  check('★ `parseSizeOrNull` 住在 `canvas-prefs.ts`，不在 `.tsx` 里',
    !panelSrc.includes('export function parseSizeOrNull'),
    '面板里那份本地定义已挪走')
}
/* ══════════════════════════════════════════════════════════════════════
 * ㉖ 对齐参考线与吸附的纯函数层（票 01，用户 C2）
 *
 * 算法在 `lib/canvas/canvas-align.ts`，这里只喂坐标、看结果。
 * 组件那一侧的接线（`onDrag` / `onDragStop` / 那个开关）由
 * `content-canvas-ops.mjs` 的 ㉗ 段钉。
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ㉖ 对齐参考线与吸附：六条边、阈值、松手落点 ===')
{
  const align = await import('../src/client/workbench/lib/canvas/canvas-align.ts')
  const { ALIGN_THRESHOLD, computeAlign, snappedPosition, NO_ALIGN } = align
  /* 参照基准：一个 200×120 的节点放在 (100,100)。它的六个锚点：
   *   横向 100 / 200 / 300；纵向 100 / 160 / 220。 */
  const base = { id: 'a', x: 100, y: 100, width: 200, height: 120 }

  /* ── 判据 1：阈值内 → 给出位移与参考线 ── */
  {
    /* 左边差 3：挪到 (103,100)。阈值 6 之内，该吸回 x=100。 */
    const r = computeAlign({ ...base, id: 'b', x: 103 }, [base])
    check('★★ 左边差 3px（阈值内）→ 位移 -3，吸回左边', r.dx === -3, String(r.dx))
    check('★★ 命中时给出**一条竖线**，位置在 100', r.vertical.length === 1 && r.vertical[0].at === 100,
      JSON.stringify(r.vertical))
    check('★ 竖线画在两条边的纵向范围里（from 100 / to 220 那一带）',
      r.vertical.length === 1 && r.vertical[0].from <= 100 && r.vertical[0].to >= 220,
      r.vertical.length === 0
        ? '（没有线）'
        : String(r.vertical[0].from) + '→' + String(r.vertical[0].to))
  }

  /* ── 判据 1：阈值外 → 原样返回 ── */
  {
    const r = computeAlign({ ...base, id: 'b', x: 120 }, [base])
    check('★★ 左边差 20px（阈值外）→ 位移 0、没有线',
      r.dx === 0 && r.vertical.length === 0, String(r.dx))
    check('★ 阈值外 `dy` 也是 0（没命中就不许挪）', r.dy === 0, String(r.dy))
  }

  /* ── 六条边都真的参与（票里点名的左/中/右、上/中/下）── */
  {
    /* 横向三条：中缝对齐（200 对 200）、右边对齐（300 对 300）。 */
    const mid = computeAlign({ ...base, id: 'b', x: 202 }, [base])
    check('★★ 中缝差 2px → 吸上（第二组锚点也在比，不只比左边）',
      mid.dx === -2, String(mid.dx))
    const right = computeAlign({ ...base, id: 'b', x: 303 }, [base])
    check('★★ 右边差 3px → 吸上（第三组锚点也在比）',
      right.dx === -3, String(right.dx))
    /* 纵向三条。 */
    const top = computeAlign({ ...base, id: 'b', y: 104 }, [base])
    check('★★ 上边差 4px → 吸上', top.dy === -4, String(top.dy))
    const vmid = computeAlign({ ...base, id: 'b', y: 164 }, [base])
    check('★★ 纵向中缝差 4px → 吸上', vmid.dy === -4, String(vmid.dy))
    const bottom = computeAlign({ ...base, id: 'b', y: 224 }, [base])
    check('★★ 下边差 4px → 吸上', bottom.dy === -4, String(bottom.dy))
  }

  /* ── 两个轴互不影响 ── */
  {
    const r = computeAlign({ ...base, id: 'b', x: 103, y: 400 }, [base])
    check('★★ 横向命中、纵向离得远 → 只给竖线，`dy` 是 0',
      r.dx === -3 && r.dy === 0 && r.vertical.length === 1 && r.horizontal.length === 0,
      'dx=' + String(r.dx) + ' dy=' + String(r.dy))
  }

  /* ── 只取最近的一条：两条都在阈值内时，取差得少的 ── */
  {
    /* 左边差 1、中缝差 4（这里造一个让两个锚点同时命中的情形）。 */
    const r = computeAlign({ ...base, id: 'b', x: 101 }, [base])
    check('★★ 两个锚点同时命中时取差得最少的那条（不是碰到的第一条）',
      Math.abs(r.dx) === 1, String(r.dx))
  }

  /* ── 不跟自己对齐 ── */
  {
    const r = computeAlign(base, [base])
    check('★★ 只有自己一个节点时什么都不吸（不会自吸）',
      r.dx === 0 && r.dy === 0, 'dx=' + String(r.dx))
  }

  /* ── 判据 4 的自证锚点：阈值 0 = 关掉，不是「像素级相等才算」── */
  {
    const exact = computeAlign({ ...base, id: 'b', x: 100 }, [base], 0)
    check('★★ 阈值 0 → **完全重合也不吸**（0 的含义是关掉，不是「相等才吸」）',
      exact.dx === 0 && exact.vertical.length === 0, String(exact.dx))
    const neg = computeAlign({ ...base, id: 'b', x: 103 }, [base], -1)
    check('★ 负阈值同样当关掉（不炸、不反着算）', neg.dx === 0)
  }

  /* ── 默认阈值就是文件里那个常量 ── */
  {
    check('★ 默认阈值取的是 `ALIGN_THRESHOLD`（6，不是 Dify 的 5）',
      ALIGN_THRESHOLD === 6, String(ALIGN_THRESHOLD))
    /* 差 6 刚好命中（`>` 阈值才放过），差 7 不命中。 */
    check('★★ 差 6 命中（边界含）、差 7 不命中',
      computeAlign({ ...base, id: 'b', x: 106 }, [base]).dx === -6
      && computeAlign({ ...base, id: 'b', x: 107 }, [base]).dx === 0,
      String(computeAlign({ ...base, id: 'b', x: 106 }, [base]).dx))
  }

  /* ── 松手落点 ── */
  {
    const r = computeAlign({ ...base, id: 'b', x: 103, y: 104 }, [base])
    const at = snappedPosition({ x: 103, y: 104 }, r)
    check('★★ 松手落点 = 原位置 + 位移', at.x === 100 && at.y === 100,
      JSON.stringify(at))
    const none = snappedPosition({ x: 500, y: 500 }, NO_ALIGN)
    check('★ 没命中时松手位置原样（不会莫名其妙挪一下）',
      none.x === 500 && none.y === 500, JSON.stringify(none))
  }

  /* ── 参考线长度照 Dify：从最靠边的那个对齐节点拉到我这个节点 ── */
  {
    /* 目标在上方 (100,40) 高 120 → 纵向 40~160；我在 (103,300) 高 120 → 300~420。 */
    const far = { id: 'c', x: 100, y: 40, width: 200, height: 120 }
    const r = computeAlign({ id: 'd', x: 103, y: 300, width: 200, height: 120 }, [far])
    check('★★ 竖线把两个节点都罩住（40→420），不是整屏一条也不是只画自己那截',
      r.vertical.length === 1 && r.vertical[0].from === 40 && r.vertical[0].to === 420,
      String(r.vertical[0]?.from) + '→' + String(r.vertical[0]?.to))
  }

  /* ── 源码层：`ALIGN_READY` 已退役，别再冒出来 ── */
  {
    const prefsSrc = readFileSync('src/client/workbench/lib/canvas/canvas-prefs.ts', 'utf8')
    const panelSrc2 = readFileSync('src/client/workbench/CanvasSettingsPanel.tsx', 'utf8')
    check('★★ `ALIGN_READY` 已删（不许留一个「做了没有」的常量说假话）',
      !prefsSrc.includes('export const ALIGN_READY'))
    check('★★ 设置面板不再显示「本轮未实现」（那句话已不成立）',
      !panelSrc2.includes('本轮未实现'), '面板里已改成正常说明')
    check('★ 设置面板仍然有一个对齐开关',
      panelSrc2.includes('data-ewb-settings-align='))
  }
}

console.log('')
if (failed === 0) console.log('结论：画布返修的纯函数判据全部通过 ✓')
else console.log('结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
