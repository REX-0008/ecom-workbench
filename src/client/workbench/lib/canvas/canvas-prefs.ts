/**
 * 内容画布的设置（用户 m03414：A7 + B4「设置必须落盘」）。
 *
 * ## 为什么单独一个文件
 *
 * 这些设置**要跨会话活下来**。原来画布背景模式是 `useState`，刷新就回默认 ——
 * 做了等于没做。所以把「默认值 / 校验 / 读写本地存储」抽成纯函数：
 * 组件只负责把 `CanvasPrefs` 接进 JSX，不再自己存一个 `useState`。
 *
 * ## 存哪儿、为什么
 *
 * 存**浏览器本地**（`localStorage`，键 `ewb.canvasPrefs`），不存画布档里。
 * 理由：
 * 1. 这些是「这个人喜欢怎么看画布」的偏好，不是某一幅画的内容 ——
 *    存进每份画布档就要每份都改一遍，且换个画布就变回默认；
 * 2. 画布档由后端 `src/schedule/canvases.ts` 管，它的 `viewport` 形状是
 *    **原样存取**、由界面自己解释，塞更多字段会让那层替界面假设形状；
 * 3. 项目里已有同一套做法（`browser-settings.ts` 存浏览器偏好），
 *    同一个概念不另起一套。
 *
 * ⚠️ 代价如实写在交付里：换浏览器 / 清了站点数据就回默认。
 * 这是偏好类设置的正常代价（参考项目也存在 localStorage）。
 */

/** 背景模式。 */
export type GridMode = 'dots' | 'lines' | 'none'

/**
 * 面板宽度的选择方式。
 *
 * · `auto`：按画布可用宽度自动选三档之一（A3 的做法）；
 * · 数字：用户手动钉死某一档（A7 第 6 项要求的「允许手动固定」）。
 */
export type PanelWidthChoice = 'auto' | 260 | 320 | 380

/** 画布明暗：`null` = 跟随 dsh 主题；其余按用户选的。
 *
 * 为什么单独立一个类型而不是写 `'light' | 'dark' | null`：
 * 读代码的人看见 `null` 得先知道它是什么意思。给个名字，语义就写在类型上。 */
export type CanvasTheme = 'light' | 'dark' | null

/** 一份完整的画布设置。 */
export interface CanvasPrefs {
  /**
   * 新节点的默认宽度。
   *
   * ## 🗑️ 已退役（票 34，2026-10-28）
   *
   * 用户定：**节点尺寸照参考项目逐类定死**（`refs-projects/infinite-canvas/
   * web/src/constant/canvas.ts:13` 那六个数字），不再让用户全局覆盖。
   * 设置面板里那对输入框已删，新节点一律用 `NODE_SIZE[type]`。
   *
   * ## 为什么字段**留着**而不是删掉
   *
   * 老存档（`localStorage` 的 `ewb.canvasPrefs`）里存着 `nodeW: 360` 这种值。
   * 字段一删，解析函数读到它就是「不认识的键」—— 不会崩，但反过来：
   * 保留它才能让 `readPrefs` → `writePrefs` 往返**不改动用户已有数据**。
   *
   * 留着字段、照旧解析、**只是没人读它**。写这一段是为了让下一个人知道
   * **它不是漏删，是刻意留的兼容位**，别顺手清掉。
   *
   * @deprecated 票 34 起不生效（节点尺寸已按类型定死）。
   */
  nodeW: number | null
  /**
   * 新节点的默认高度。
   * @deprecated 与 `nodeW` 同一条（票 34 起不生效）。
   */
  nodeH: number | null
  /** 背景模式。 */
  grid: GridMode
  /** 线格透明度（0–1，只对 `lines` 生效）。 */
  lineOpacity: number
  /** 小地图开关。 */
  miniMap: boolean
  /** 对齐参考线与松手吸附（票 01 已接通，算法在 `canvas-align.ts`）。 */
  align: boolean
  /** 新节点落位间距（px）。 */
  dropGap: number
  /** 面板宽度档位。 */
  panelWidth: PanelWidthChoice
  /**
   * 画布明暗（票 54，用户 2026-10-29 定）。
   *
   * ## 三个值，`null` 是有意义的那一个
   *
   * · `null` —— **用户没手动切过**：跟随 dsh 主题（`canvas-helpers.ts` 的 `detectDark()`）。
   *   这一档是默认，也是「用户换个主题、画布跟着换」的保证。
   * · `'light'` / `'dark'` —— 用户点过主题切换按钮，**按用户的**：
   *   此后 dsh 主题怎么变都不影响画布。
   *
   * ⚠️ **不许把 `null` 归一成某个具体值**。分不出「用户选了深色」与
   * 「用户没选、而 dsh 恰好是深色」的话，用户换 dsh 主题时画布就不会跟着变了 ——
   * 而那正是票面第 5 条要求的行为。
   *
   * ⚠️ **只影响画布自己**，绝不写回 dsh（不碰 `document.body` 的
   * `data-ds-dark-theme`，不碰 `<html>` 的 `data-ds-theme-source`）。
   * 用户原话：「只切换画布主题色」。
   */
  theme: CanvasTheme
  /**
   * 画布底的不透明度（0–100，票 59，2026-10-29）。
   *
   * ## 为什么加在这里（而不是继续用 `localStorage` 的 `ewb.canvasBg`）
   *
   * 票 59 之前它是执行画布**自己**一个键（`ewb.canvasBg`），内容画布根本
   * 没有这个概念。用户要求「两边同类归一」，于是并入这一份偏好 ——
   * 两份本来都是 `localStorage`，合并不改机制，只是把两个键收进一份。
   *
   * ⚠️ **老值要迁移**：`readPrefs` 读到本字段缺失时会去读旧键
   * `ewb.canvasBg`（见那里），搬完把旧键删掉。
   *
   * ## 可选的理由
   *
   * 老存档（`ewb.canvasPrefs`）里没这个键。做成必填会让读一份老数据直接缺字段。
   * 缺省语义见 `DEFAULT_PREFS`：**100 = 不透明**（票 59 之前的老行为）。
   */
  canvasBgOpacity?: number
  /**
   * 参考线的不透明度（0–100，票 59）。
   *
   * 两个画布的对齐辅助线（拖动时出现的那几条）原来在
   * `workflow-canvas.module.css` 里写死 `opacity: 0.7`。
   *
   * ⚠️ **两边都要接**：内容画布的参考线画在它自己那一层
   * （`ContentCanvas.tsx`），执行画布的在 `ViewportPortal` 里。值共用同一个，
   * 但**接线是两处** —— 只改一处不会让另一处跟着变。
   */
  guideOpacity?: number
  /**
   * 点阵 / 线格的图案不透明度（0–100，票 59）。
   *
   * ## 与既有的 `lineOpacity` 什么关系
   *
   * `lineOpacity`（0–1）是票 01 那版留下的，**只对 `lines` 档生效**。
   * 这一项是它的**推广**：`lines` 与 `dots` 两档都认。
   *
   * 特意**不合并**成一个字段：`lineOpacity` 的语义在用户心里是「线格深浅」
   * （面板上那块滑块就叫这个名字），改它的含义会让拖过那条滑块的人
   * 突然发现点阵也跟着变了。两个字段、由界面决定显示哪一个更稳。
   *
   * ## 点阵怎么表达透明度（技术依据）
   *
   * React Flow 的 `Background` **没有 `opacity` 参数**
   * （`node_modules/@xyflow/react/dist/esm/additional-components/Background/types.d.ts`
   * 只有 `color` / `bgColor` / `gap` / `size` / `lineWidth` / `variant`）。
   * 但 `color` 接受任意 CSS 颜色串 —— 所以透明度做在**颜色值**里
   * （`color-mix(… N%, transparent)`），与 `lineColorOf` 是同一招。
   * 点阵与线格共用 `patternColorOf`，两个档位的算法一致。
   */
  patternOpacity?: number
}

/* ── `ALIGN_READY` 已退役（票 01，2026-10-27）──────────────────────────
 *
 * 那个常量原来是「对齐吸附做了没有」的如实标记，值为 `false`，
 * 设置面板据它在开关下面写一句「对齐吸附本轮未实现，开关只记录偏好」。
 *
 * 现在吸附接通了（`lib/canvas/canvas-align.ts` + `ContentCanvas.tsx` 的
 * `onDrag` / `onDragStop`），那句话已经不成立，所以常量删掉、说明也删掉。
 *
 * ⚠️ **不要再加回来**：一个「功能做了没有」的常量只有在功能没做时才有意义。
 * 留着它，以后每次改动都得记着改它，而忘了改它会显示一句假话。
 * 哪天真需要再关掉这条功能，走设置里那个 `align` 开关（那是用户的选择），
 * 不是走一个写死在代码里的常量。 */

/** 默认设置（「恢复默认」就是把这一份整体写回去）。 */
export const DEFAULT_PREFS: CanvasPrefs = {
  /* ★ `null` = 跟随类型：各类型仍用 `NODE_SIZE` 里自己那一份，与今天一字不差。
   * 填数字才统一覆盖（只影响新建的节点）。理由见 `nodeW` 的类型注释。 */
  nodeW: null,
  nodeH: null,
  grid: 'dots',
  /* A2 的 20%。 */
  lineOpacity: 0.2,
  miniMap: true,
  /* ★ 票 78（2026-10-29）：**默认值从 `false` 改成 `true`**。
   *
   * 用户原话（票 35）：「视图的显示小地图和对齐吸附，功能有，但是点了之后
   * 显示一点变化都没有，合理吗？」
   *
   * 功能是对的（纯函数实测：差 4px 吸、差 10px 不吸，参考线带边缘范围），
   * 但**默认关着** —— 用户一进画布永远遇不到它，当然「点了没变化」。
   * 默认开之后至少一拖动就看得见效果。
   *
   * ⚠️ **老数据要尊重**：显式存过 `align: false` 的人不许被强行改成开。
   * 见 `readPrefs` 里那一段 —— 判据是「存档里有没有这个键」，
   * 不是「值是不是 true」。 */
  align: true,
  /* 原 `addNode` 里是 `nodes.length * 24`，这里收成可配的一个数。 */
  dropGap: 24,
  panelWidth: 'auto',
  /* 跟随 dsh（票面的「没切过就跟 dsh」）。 */
  theme: null,
  /* ★ 票 59 三项。默认值都取「与票 59 之前一字不差」：
   * `canvasBgOpacity` 100 = 不透明（老行为），
   * `guideOpacity` 70 = 原来写死的 `opacity: 0.7`，
   * `patternOpacity` 20 = 与 `lineOpacity` 的默认 0.2 一致（点阵外观不变）。 */
  canvasBgOpacity: 100,
  guideOpacity: 70,
  patternOpacity: 20,
}

/** localStorage 的键。 */
export const PREFS_KEY = 'ewb.canvasPrefs'

/** 面板宽度三档（px）。定义在这里 —— 它们是**设置**，不是画布数据。 */
export const PANEL_WIDTHS: readonly [number, number, number] = [260, 320, 380]

/** 三档面板宽度的取值范围（供校验）。 */
const WIDTH_TIERS: readonly number[] = PANEL_WIDTHS

/**
 * 把一个数字夹进范围（容错落盘值）。
 * @param v - 待查值。
 * @param lo - 下界。
 * @param hi - 上界。
 * @param fallback - 不是有限数时用这个。
 * @returns 夹好的数。
 */
function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

/**
 * 读设置（**必须容错**）。
 *
 * ⚠️ `localStorage` 可能被手改、也可能是更早版本存的形状。
 * 抛错会让整个画布打不开 —— 那比「读回默认值」严重得多。
 * 所以每一个字段都单独校验，坏的那一个退回默认，其余照用。
 *
 * @param raw - 原始字符串（不传则从 localStorage 读）。
 * @returns 形状保证正确的设置。
 */
export function readPrefs(raw?: string | null): CanvasPrefs {
  let text = raw
  if (text === undefined) {
    try { text = localStorage.getItem(PREFS_KEY) } catch { text = null }
  }
  if (text === null || text === undefined || text.trim() === '') return { ...DEFAULT_PREFS }
  let o: Record<string, unknown>
  try {
    const p = JSON.parse(text) as unknown
    if (p === null || typeof p !== 'object') return { ...DEFAULT_PREFS }
    o = p as Record<string, unknown>
  } catch {
    return { ...DEFAULT_PREFS }
  }
  const grid: GridMode = o.grid === 'lines' || o.grid === 'none' ? o.grid : 'dots'
  const pw = o.panelWidth
  const panelWidth: PanelWidthChoice = typeof pw === 'number' && WIDTH_TIERS.includes(pw)
    ? (pw as 260 | 320 | 380)
    : 'auto'
  const op = typeof o.lineOpacity === 'number' && Number.isFinite(o.lineOpacity)
    ? Math.max(0, Math.min(1, o.lineOpacity))
    : DEFAULT_PREFS.lineOpacity
  return {
    /* `null` 是合法值（= 跟随类型），所以不能走 `clampNum` 的「不是数就给 fallback」
     * —— 那样 `null` 会被当成坏值退回一个数字。分开判。 */
    nodeW: clampSizeOrNull(o.nodeW, 160, 800),
    nodeH: clampSizeOrNull(o.nodeH, 100, 800),
    grid,
    lineOpacity: op,
    /* 只有明确的 `true` 才算开 —— 手改成字符串 "true" 不算。 */
    miniMap: o.miniMap === true,
    /* ★ 票 78：`align` 的读法**与别的字段不同**，因为它现在的默认值是 `true`。
     *
     * ## 判据是「存档里有没有这个键」，不是「值是不是 true」
     *
     * | 存档里 | 该给什么 | 为什么 |
     * |---|---|---|
     * | 没有这个键（票 78 之前的老档） | `true` | 用户从没表过态 → 用新默认 |
     * | `align: false` | `false` | **用户显式关的**，不许强行改成开 |
     * | `align: true` | `true` | 用户显式开的 |
     * | `align: 'true'`（手改坏） | `false` | 坏值 → 保守退回「关」，不假装知道用户要什么 |
     *
     * ⚠️ 写成 `o.align !== false` 会把「手改成字符串」也判成开 —— 那是坏值当成用户选择。
     * 写成 `o.align === true` 会让**所有老档都被关掉**，等于默认值改了但没人受益。
     * 两种写法都不对，所以必须先用 `in` 把「没表过态」与「表了态」分开。 */
    align: 'align' in o ? o.align === true : DEFAULT_PREFS.align,
    dropGap: clampNum(o.dropGap, 0, 200, DEFAULT_PREFS.dropGap),
    panelWidth,
    /* ⚠️ 只有明确的 'light' / 'dark' 才认；其余（含老存档没这个键）一律 `null`。
     * 手改成 'Light' 或 true 都不算 —— 那是坏值，退回「跟随 dsh」最安全。 */
    theme: o.theme === 'light' || o.theme === 'dark' ? o.theme : null,
    canvasBgOpacity: clampNum(o.canvasBgOpacity, 0, 100, legacyCanvasBg() ?? DEFAULT_PREFS.canvasBgOpacity),
    guideOpacity: clampNum(o.guideOpacity, 0, 100, DEFAULT_PREFS.guideOpacity),
    patternOpacity: clampNum(o.patternOpacity, 0, 100, DEFAULT_PREFS.patternOpacity),
  }
}

/**
 * 老键 `ewb.canvasBg` 的值（票 59 之前执行画布单独存的那个）。
 *
 * ## 为什么要读它
 *
 * 票 59 把「画布底不透明度」从执行画布自己的 `localStorage.getItem('ewb.canvasBg')`
 * 收进这份偏好。不做迁移的话，**设过这个值的用户升级后会发现它丢了** ——
 * 而且不会有任何报错，就是「我之前调过的透明底怎么又变回不透明了」。
 *
 * ## 为什么要清它
 *
 * 留着一个没人读的旧键，下一个人会以为它还在生效。迁移是**一次性**动作：
 * 搬完删掉，之后 `readPrefs` 就只看新字段。
 *
 * ⚠️ 只在**新字段缺失**时读旧键 —— 否则用户在新接口里调过之后，
 * 旧键残留会把新值覆盖掉。
 *
 * @returns 老键里的值（0–100）；没有或不合法给 `undefined`。
 */
function legacyCanvasBg(): number | undefined {
  try {
    const raw = localStorage.getItem('ewb.canvasBg')
    if (raw === null) return undefined
    const n = Number(raw)
    if (!Number.isFinite(n)) return undefined
    const v = Math.max(0, Math.min(100, Math.round(n)))
    /* 搬完就删 —— 只搬一次。 */
    localStorage.removeItem('ewb.canvasBg')
    return v
  } catch {
    return undefined
  }
}

/**
 * 节点尺寸的读法：**数字就夹到范围内，其余一律 `null`（跟随类型）**。
 *
 * 与 `clampNum` 的区别：那个把「不是数」退回一个**数字默认**；
 * 这里「不是数」要退回 `null` —— 因为 `null` 本身是合法且有意义的
 * （各类型用自己那份默认尺寸）。混用会把 `null` 吃掉。
 *
 * @param v - 待查值。
 * @param lo - 下界。
 * @param hi - 上界。
 * @returns 夹好的数；不是有限数给 `null`。
 */
function clampSizeOrNull(v: unknown, lo: number, hi: number): number | null {
  const n = typeof v === 'number' ? v : Number.NaN
  if (!Number.isFinite(n)) return null
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

/**
 * 写设置（失败静默 —— 存不了不影响这次使用）。
 * @param p - 要存的设置。
 */
export function writePrefs(p: CanvasPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* 存不了就跳过 */ }
}

/**
 * 改一项，返回新的一份（**不改原对象**）。
 *
 * 为什么改一项要整份换新：React 的 `useState` 靠引用判断变没变，
 * 原地改字段不会触发重渲染 —— 表现是「点了没反应」。
 *
 * @param cur - 当前设置。
 * @param patch - 要改的字段。
 * @returns 新的一份。
 */
export function patchPrefs(cur: CanvasPrefs, patch: Partial<CanvasPrefs>): CanvasPrefs {
  return { ...cur, ...patch }
}

/**
 * 是不是「已经恢复成默认」了（界面据此决定「恢复默认」按钮要不要禁用）。
 * @param p - 当前设置。
 * @returns 与默认完全一致给 true。
 */
export function isDefaultPrefs(p: CanvasPrefs): boolean {
  const keys: (keyof CanvasPrefs)[] = [
    'nodeW', 'nodeH', 'grid', 'lineOpacity', 'miniMap', 'align', 'dropGap', 'panelWidth', 'theme',
    /* ★ 票 59：三项透明度也要参与「恢复默认」的判断 —— 少一项的话
     * 用户把画布底拉到 0 之后，「恢复默认」按钮会显示成**已可点**（对），
     * 但点完再判又回到「已默认」而底下那项其实没还原（那就成了假按钮）。
     * 加进来之后，`isDefaultPrefs` 说「是默认」就一定是**全部**默认。 */
    'canvasBgOpacity', 'guideOpacity', 'patternOpacity',
  ]
  return keys.every(k => p[k] === DEFAULT_PREFS[k])
}

/**
 * 新节点该用什么尺寸（把设置与类型默认合成一次判断）。
 *
 * ## 为什么单独抽一个纯函数
 *
 * 「设置里填了数字就用它、没填就按类型」这件事，判断点在
 * `newNode()`（`content-canvas-store.ts:221`）里，但它的**语义**属于设置这一侧：
 * `null` 是 `CanvasPrefs` 的概念，而 `newNode` 只该拿到一个确定的宽高。
 *
 * 抽出来之后：
 *   · 判据能直接钉「`null` → 图片 320×320」「设了 300×200 → 300×200」，
 *     不用去挂画布；
 *   · `newNode` 不必知道 `null` 是什么（它只收 `number | undefined`）。
 *
 * @param prefs - 当前设置。
 * @param fallback - 该类型的默认尺寸（`NODE_SIZE[type]`）。
 * @returns 确定的宽高。
 */
export function nodeSizeFrom(
  prefs: Pick<CanvasPrefs, 'nodeW' | 'nodeH'>,
  fallback: { width: number, height: number },
): { width: number, height: number } {
  /* ★ 宽高**分别**判：用户可能只填宽不填高（面板上两个输入框是独立的）。 */
  return {
    width: typeof prefs.nodeW === 'number' ? prefs.nodeW : fallback.width,
    height: typeof prefs.nodeH === 'number' ? prefs.nodeH : fallback.height,
  }
}

/**
 * 把输入框里的字变成 `nodeW` / `nodeH` 该存的值。
 *
 * ## 为什么需要它（不是直接用 `Number`）
 *
 * `nodeW` 的默认值是 `null`（= 跟随类型）。用 `Number(e.target.value)` 的话：
 *   · 用户把框清空 → `Number('')` 是 **0** → 存成 0 → 节点宽度被夹成 160，
 *     那是「清空 = 改成 0」，不是「清空 = 跟随类型」；
 *   · 用户点到框里的负号 → 也是 NaN/负数，同样错。
 *
 * 所以：**空串 / 非数 → `null`**；有数 → 交给 `readPrefs` 那边夹范围。
 *
 * ⚠️ 放在 `canvas-prefs.ts` 而不是设置面板那个 `.tsx` 里：这是**纯数据转换**，
 * 与 UI 无关；放面板里的话，想验它的测试得 import 一个会加载 CSS 的组件，
 * 纯 Node 跑不起来（`ERR_UNKNOWN_FILE_EXTENSION: .css`）。
 *
 * @param raw - 输入框原文。
 * @returns 数字或 `null`。
 */
export function parseSizeOrNull(raw: string): number | null {
  const t = raw.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/**
 * 线格颜色的透明度换算（A2 那个 20% 现在由设置决定）。
 *
 * ## 为什么返回 `color-mix` 而不是 rgba
 *
 * 线色跟主题走（`--v1-edge`），而 CSS 变量在 `color-mix` 里才能加透明度。
 * 写死 rgba 会在深色主题下看不见。
 *
 * （原来那个常量 `LINE_COLOR` 在 `content-canvas-store.ts` 里，已随这一单退役 ——
 * 现在只有这一个地方算线格颜色。）
 *
 * @param opacity - 0–1。
 * @returns 能给 `Background` 的 `color` 的值。
 */
export function lineColorOf(opacity: number): string {
  const pct = Math.max(0, Math.min(1, opacity)) * 100
  /* 保留一位小数，避免 0.2*100 出 20.000000000000004 这种串。 */
  const shown = Math.round(pct * 10) / 10
  return 'color-mix(in srgb, var(--v1-edge) ' + String(shown) + '%, transparent)'
}

/**
 * 图案（点阵 / 线格）的颜色，带透明度（票 59）。
 *
 * ## 为什么需要这个函数
 *
 * React Flow 的 `Background` **没有 `opacity` 参数** ——
 * 类型定义里只有 `color` / `bgColor` / `gap` / `size` / `lineWidth` / `variant`
 * （`node_modules/@xyflow/react/dist/esm/additional-components/Background/types.d.ts`）。
 *
 * 但 `color` 收的是任意 CSS 颜色串 —— 所以透明度做在**颜色值本身**里。
 * 这与既有的 `lineColorOf` 是同一招，区别只有两点：
 *
 * | | `lineColorOf` | `patternColorOf` |
 * |---|---|---|
 * | 取哪个变量 | 固定 `--v1-edge`（线格专用） | 由 `variant` 决定 |
 * | 入参单位 | 0–1（`lineOpacity` 的旧单位） | 0–100（新字段的单位） |
 *
 * ⚠️ **点阵不能也用 `--v1-edge`**：那个变量的观感是「一条线」，铺成一片点会糊。
 * 点阵原来没有 `color`（走 React Flow 的默认值与 `--grid-color`），
 * 所以这里给它 `var(--grid-color)`，默认 `20%` 时与老外观接近。
 *
 * @param variant - 这一档是线格还是点阵。
 * @param opacityPct - 0–100。
 * @returns 能给 `Background` 的 `color` 的值。
 */
export function patternColorOf(variant: 'lines' | 'dots', opacityPct: number): string {
  const pct = Math.max(0, Math.min(100, opacityPct))
  /* 保留一位小数，理由同 `lineColorOf`。 */
  const shown = Math.round(pct * 10) / 10
  const base = variant === 'lines' ? 'var(--v1-edge)' : 'var(--grid-color)'
  return 'color-mix(in srgb, ' + base + ' ' + String(shown) + '%, transparent)'
}
