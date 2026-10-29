/** 画布设置面板（快捷键帮助 + 各项开关）。
 *
 * 为什么需要（用户点名的 P2 两项合一）：
 *   - **快捷键帮助**：画布有十来个快捷键，用户不可能全记住，得有个地方能查；
 *   - **画布设置面板**：各种开关（小地图、图例、编辑方式等）此前散在工具条上，越加越挤。
 *
 * 两者都是「低频、要看一眼」的内容，所以合用**一个侧边抽屉**：
 * 点工具条的「⌨ 帮助」打开，里面分两段——快捷键表 + 开关。
 *
 * 为什么不放弹窗（modal）：弹窗会挡住画布，而用户查快捷键时往往正想操作画布。
 * 抽屉从右侧滑出、可随时关掉，不挡视线中心。
 *
 * ## ⚠️ 这个抽屉只管**画布**（2026-10-22 拆分）
 *
 * 原来它混着 7 项，其中「浏览器」是**工作台级**的（会话与登录态，跨所有工作流共用），
 * 与「这张图怎么画」不是一回事。现在浏览器那一段搬到侧栏底部的齿轮
 * （`WorkspaceSettings.tsx`），这里只剩画布相关：
 * 节点宽度 / 展开高度 / 背景透明 / 间距 / 输出高度 + 快捷键表。
 *
 * **快捷键不拆** —— 用户明确说过没必要（画布工具条已经够挤，
 * 再开一个入口只会让人多点一次）。
 */
import css from './workflow-canvas.module.css'
/* ★ 票 57：设置面板的**整体样式**（宽 / 标题行 / 分组 / 行 / 说明）与内容画布共用，
 * 那一套住在 `EcomWorkbench.module.css` 的 `canvasFloat*` 里。
 *
 * ## 为什么两个文件都 import（而不是把这批类搬过来）
 *
 * 本文件现在还用到 `workflow-canvas.module.css` 的**控件样式**
 * （`.setRange` / `.setValue` / `.setReset`）—— 那些是滑杆与复位按钮自己的长相，
 * 用户明确说「整体样式不是控件样式」，所以它们不该进共用那套。
 *
 * 搬过去的话要动一批既有类（还可能碰到别处在用的），而收益是零：
 * 两个 import 各管一层，边界反而更清楚。 */
import float from './EcomWorkbench.module.css'
import { PANEL_H_MIN, PANEL_H_MAX, PANEL_H_DEFAULT } from './NodeRunPanel.tsx'
/* ★ 票 59：画布偏好（背景三档 + 三个透明度）与内容画布共用同一份 —— 见入参说明。 */
import {
  DEFAULT_PREFS, type CanvasPrefs,
} from './lib/canvas/canvas-prefs.ts'
/* ★ 票 59：背景三档的措辞与内容画布**共用一份**（同一个常量，不各写一套）。 */
import { GRID_OPTS } from './CanvasSettingsPanel.tsx'

/* ── 快捷键表**已删**（票 56，用户丁 21 与丙 28）──────────────────
 *
 * 这里原来有 `Shortcut` 接口与 `SHORTCUTS` 三组 17 条的常量，渲染在设置面板里。
 * 票 56 把它删了 —— 理由与票 35 对内容画布做的那次是同一个：
 * **清单只能有一处**。两份同步维护必然漂，而漂了之后用户看到的是「两处说法不同」，
 * 他没法知道该信哪个。
 *
 * ## 删表不是删内容（这是最容易做错的一步）
 *
 * 删之前逐条比对过 17 条，右下角那份 `shortcutHelp()`（`CanvasZoomControls.tsx`）
 * 缺 4 条，已经补进去了：
 *   · Ctrl + 拖拽 —— 框选一片节点
 *   · Ctrl + 点击 —— 加选 / 减选
 *   · 拖拽空白处 —— 平移画布
 *   · 右键连线 —— 删除这条连线
 *
 * 另外 3 条是**同族合并**（不算丢）：
 *   复制 / 粘贴 → 一条、「撤销 / 重做」→ 一条（且带步数）、放大 / 缩小 / 100% → 一条。
 *
 * 所以现在 `shortcutHelp()` 14 行覆盖原来 17 条的全部内容。
 *
 * ⚠️ **不要再在这里加回来**。要改快捷键说明，改 `CanvasZoomControls.tsx` 的
 * `shortcutHelp()` —— 那是唯一来源。
 */

/** 节点宽度的可调范围（px）。 */
export const NODE_W_MIN = 200
export const NODE_W_MAX = 520
/** 节点宽度默认值（与 canvas-tokens.module.css 的 `--ewb-node-w` 保持一致）。 */
export const NODE_W_DEFAULT = 300
/** 节点展开后参数区的可调高度范围（px）。 */
export const EDITOR_H_MIN = 140
export const EDITOR_H_MAX = 700
/** 参数区高度默认值（与 canvas-tokens.module.css 的 `--ewb-editor-h` 保持一致）。 */
export const EDITOR_H_DEFAULT = 220
/**
 * 自动排版间距的可调范围（px）。
 *
 * 用户 2026-10-11：「设置也增加一个自动排版间距。和前面两个一样，
 * 拖动设置间距大小，**最小为 10**。」所以下限就是 10，上限取 400
 * （再大就一个节点占一屏，没有实用价值）。
 */
export const LAYOUT_SPACING_MIN = 10
export const LAYOUT_SPACING_MAX = 400

/**
 * 画布底色的可调不透明度（%）。
 *
 * 用户 m00861：「画布背景增加一个透明度设置 —— 有的 UI 是透明的，应用背景，
 * 这时候整个板块只有画布是天色、其他都有透明度。」
 *
 * **下限取 0**：0 = 完全透明（画布底不画任何颜色，直接透出外壳背景）。
 * 留 0 而不是留 20 是因为这就是这条设置的用途本身 —— 「要跟外壳一致」时
 * 用户会一路拖到底。
 */
export const CANVAS_BG_MIN = 0
/** 画布底不透明度默认值（100 = 不透明，与改造前逐像素一致）。 */
export const CANVAS_BG_DEFAULT = 100

/**
 * 设置抽屉。
 *
 * @param props.open - 是否打开。
 * @param props.onClose - 关闭回调。
 * @param props.nodeW - 当前节点宽度（px）。
 * @param props.onNodeW - 改节点宽度。
 * @param props.editorH - 节点展开后参数区的最大高度（px）。
 * @param props.onEditorH - 改参数区高度。
 * @param props.spacing - 当前**实际生效**的自动排版间距（px）。自动模式下是按节点宽度算出来的。
 * @param props.spacingAuto - 现在是不是「自动」模式（间距跟节点宽度走）。
 * @param props.onSpacing - 改排版间距；传 `null` 表示回到自动。
 * @param props.panelH - 输出显示窗口的高度（px）。
 * @param props.onPanelH - 改输出面板高度。
 * @returns 抽屉元素，或 null。
 */
export function SettingsDrawer(props: {
  open: boolean
  onClose: () => void
  nodeW: number
  onNodeW: (w: number) => void
  /** 画布底色的不透明度（%，100 = 不透明）。 */
  canvasBg: number
  /** 改画布底不透明度。 */
  onCanvasBg: (v: number) => void
  editorH: number
  onEditorH: (h: number) => void
  spacing: number
  spacingAuto: boolean
  onSpacing: (s: number | null) => void
  /** 输出显示窗口的高度（px，用户 2026-10-13 要求可调）。 */
  panelH: number
  /** 改输出面板高度。 */
  onPanelH: (h: number) => void
  /**
   * 画布偏好（票 59 起：背景三档 + 三个透明度与内容画布**共用同一份**）。
   *
   * ⚠️ 这份偏好的真身在 `lib/canvas/canvas-prefs.ts` 的 `CanvasPrefs`，
   * 由 `WorkflowCanvas` 持有并传进来 —— 本组件不自己读写 `localStorage`。
   * 理由：同一个值在别处也要用（`<Background>` 的 `color`、参考线的 `opacity`），
   * 两处各存一份必然漂。
   */
  prefs: CanvasPrefs
  /** 改画布偏好的一项或几项。 */
  onPrefs: (patch: Partial<CanvasPrefs>) => void
  /**
   * 把所有项恢复默认（票 57 第 3 条）。
   *
   * ## 为什么由外面传进来、而不是在这里自己调那五个 on*
   *
   * 五个值的默认值分别来自 `SettingsDrawer.tsx` 的常量（`NODE_W_DEFAULT` 等），
   * 看起来这里调五次就行 —— 但**「恢复默认」还包括清掉那些「自动」状态**
   * （间距的 `null`、输出高度的 `PANEL_H_DEFAULT`），而那些状态的真值在
   * `WorkflowCanvas.tsx` 里（它才是这些偏好的持有者）。
   *
   * 在这里拼五次调用等于把「什么算默认」在两处各写一份 —— 迟早漂。
   * 所以外面给一个动作，这里只负责按钮。
   */
  onReset: () => void
}) {
  if (!props.open) return null
  return (
    <div className={float.canvasFloatPanel} data-ewb-drawer='' data-ewb-canvas-settings-float=''>
      <div className={float.canvasFloatHead}>
        <span className={float.canvasFloatTitle}>画布设置</span>
        <span className="flex-1" />
        {/* ★ 票 57 第 3 条：补一颗**总复位**。原来只有每项后面一颗单项复位，
         * 要把五个滑块都调回去得点五次。 */}
        <button
          type="button"
          data-ewb-settings-reset-all=""
          className={css.setReset}
          title="把所有设置恢复成默认值"
          onClick={props.onReset}
        >恢复默认</button>
        <button type="button" className={float.canvasFloatClose} title="关闭（Esc）" onClick={props.onClose}>×</button>
      </div>
      {/* 内容区不再包一层 `.drawerBody`：浮窗容器自己就是 `overflow-y: auto` 的
       * 滚动区（见 `EcomWorkbench.module.css` 的 `.canvasFloatPanel`）。
       * 再包一层只会出现两个滚动条。 */}
        {/* ── 画布设置 ────────────────────────────────────────────────
         * 用户 2026-10-11：「节点宽度和展开高度的说明文案去掉」。
         * 两条滑块下面原本各有一段解释，删掉。判据：**控件的意义从标签与单位就能看懂**
         * （「节点宽度 300px」不需要再解释什么），写了反而是噪音。
         * 复杂的地方（比如这个值影响什么）应当写在文档里，不占设置面板的地方。 */}
        <div className={float.canvasFloatGroup}>
          <div className={float.canvasFloatTitle}>节点尺寸</div>
          <div className={float.canvasFloatRow}>
            <span className={css.setLabel}>节点宽度</span>
            <input
              type="range"
              className={css.setRange}
              min={NODE_W_MIN}
              max={NODE_W_MAX}
              step={10}
              value={props.nodeW}
              aria-label="节点宽度"
              onChange={e => { props.onNodeW(Number(e.target.value)) }}
            />
            <span className={css.setValue}>{props.nodeW}px</span>
            <button
              type="button"
              className={css.setReset}
              title={'恢复默认宽度（' + String(NODE_W_DEFAULT) + 'px）'}
              onClick={() => { props.onNodeW(NODE_W_DEFAULT) }}
            >复位</button>
          </div>

          <div className={float.canvasFloatRow}>
            <span className={css.setLabel}>展开高度</span>
            <input
              type="range"
              className={css.setRange}
              min={EDITOR_H_MIN}
              max={EDITOR_H_MAX}
              step={20}
              value={props.editorH}
              aria-label="节点展开高度"
              onChange={e => { props.onEditorH(Number(e.target.value)) }}
            />
            <span className={css.setValue}>{props.editorH}px</span>
            <button
              type="button"
              className={css.setReset}
              title={'恢复默认高度（' + String(EDITOR_H_DEFAULT) + 'px）'}
              onClick={() => { props.onEditorH(EDITOR_H_DEFAULT) }}
            >复位</button>
          </div>

          {/* 画布底不透明度（用户 m00861）。**只动底那一层** —— 见 WorkflowCanvas
           * 里 `--ewb-canvas-bg` 的说明（给元素加 opacity 会把节点一起变透明）。 */}
          <div className={float.canvasFloatRow}>
            <span className={css.setLabel}>背景透明</span>
            <input
              type="range"
              className={css.setRange}
              min={CANVAS_BG_MIN}
              max={100}
              step={5}
              value={props.canvasBg}
              aria-label="画布背景不透明度"
              onChange={e => { props.onCanvasBg(Number(e.target.value)) }}
            />
            <span className={css.setValue}>{props.canvasBg}%</span>
            <button
              type="button"
              className={css.setReset}
              title={'恢复不透明（' + String(CANVAS_BG_DEFAULT) + '%）'}
              onClick={() => { props.onCanvasBg(CANVAS_BG_DEFAULT) }}
            >复位</button>
          </div>
          {props.canvasBg < 100 && (
            <div className={float.canvasFloatHint}>画布底透出外壳背景；节点与连线不受影响</div>
          )}
        </div>

        {/* ── 自动排版 ──────────────────────────────────────────────
         * 用户 2026-10-11：「设置也增加一个自动排版间距。和前面两个一样，
         * 拖动设置间距大小，最小为 10。」 */}
        <div className={float.canvasFloatGroup}>
          <div className={float.canvasFloatTitle}>自动排版</div>
          <div className={float.canvasFloatRow}>
            <span className={css.setLabel}>间距</span>
            <input
              type="range"
              className={css.setRange}
              min={LAYOUT_SPACING_MIN}
              max={LAYOUT_SPACING_MAX}
              step={10}
              value={props.spacing}
              aria-label="排版间距"
              onChange={e => { props.onSpacing(Number(e.target.value)) }}
            />
            <span className={css.setValue}>{props.spacing}px</span>
            <button
              type="button"
              className={css.setReset}
              /* 复位 = 回到**自动**（间距跟节点宽度走），不是回到某个数字 ——
               * 那才是「没调过」的状态。 */
              title={props.spacingAuto ? '当前已是自动（随节点宽度调整）' : '恢复自动：间距随节点宽度调整'}
              onClick={() => { props.onSpacing(null) }}
            >{props.spacingAuto ? '自动' : '复位'}</button>
          </div>
          {/* 自动模式下点明「这个数是算出来的」，否则用户以为它是个固定值。 */}
          {props.spacingAuto && <div className={float.canvasFloatHint}>当前为自动：随节点宽度调整</div>}
        </div>

        {/* ── 输出显示（用户 2026-10-13：「将输出显示窗口的高度也添加到画布设置中」）──
         * 写作 CSS 变量而不是传 prop —— 理由见 NodeRunPanel 的 PANEL_H_VAR 说明
         * （日志面板在节点卡片里层级很深，一路传 prop 会碰一大片组件）。 */}
        <div className={float.canvasFloatGroup}>
          <div className={float.canvasFloatTitle}>输出显示</div>
          <div className={float.canvasFloatRow}>
            <span className={css.setLabel}>输出高度</span>
            <input
              type="range"
              className={css.setRange}
              min={PANEL_H_MIN}
              max={PANEL_H_MAX}
              step={10}
              value={props.panelH}
              aria-label="输出显示窗口高度"
              onChange={e => { props.onPanelH(Number(e.target.value)) }}
            />
            <span className={css.setValue}>{props.panelH}px</span>
            <button
              type="button"
              className={css.setReset}
              title={'恢复默认输出高度（' + String(PANEL_H_DEFAULT) + 'px）'}
              onClick={() => { props.onPanelH(PANEL_H_DEFAULT) }}
            >复位</button>
          </div>
        </div>

        {/* ── 背景（票 59，2026-10-29）────────────────────────────────
         *
         * 用户原话：「执行画布同理，增加背景设置，且增加透明度设置
         * （参考线、点的透明度）」
         *
         * 三档 + 两个透明度都在这一组。**画布底**那一条在下一组
         * （它在执行画布上原来就在「节点尺寸」里，位置没动）。
         *
         * ⚠️ 与内容画布**同一套字段**（`CanvasPrefs` 的 `grid` /
         * `patternOpacity` / `guideOpacity`），不是各写一套。 */}
        <div className={float.canvasFloatGroup} data-ewb-settings-group="bg">
          <span className={float.canvasFloatTitle}>背景</span>
          <div className={float.canvasFloatRow}>
            {GRID_OPTS.map(o => (
              <button
                key={o.v}
                type="button"
                data-ewb-settings-grid={o.v}
                data-on={props.prefs.grid === o.v ? '' : undefined}
                className={float.canvasSideChip}
                onClick={() => { props.onPrefs({ grid: o.v }) }}
              >{o.label}</button>
            ))}
          </div>
          {props.prefs.grid === 'none'
            ? null
            : (
              <label className={float.canvasFloatRow}>
                <span className={float.canvasFloatTitle}>
                  {props.prefs.grid === 'lines' ? '线格深浅' : '点阵深浅'}
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  /* ⚠️ `aria-label` 跟着档位变：这一条滑块在点阵档叫「点阵深浅」、
                   * 在线格档叫「线格深浅」。读屏与测试都靠它认控件，两档不能同名。 */
                  aria-label={props.prefs.grid === 'lines' ? '线格深浅' : '点阵深浅'}
                  data-ewb-settings-pattern-opacity=""
                  value={props.prefs.grid === 'lines'
                    ? Math.round(props.prefs.lineOpacity * 100)
                    : (props.prefs.patternOpacity ?? DEFAULT_PREFS.patternOpacity ?? 20)}
                  onChange={(e) => {
                    const v = Number(e.target.value)
                    props.onPrefs(props.prefs.grid === 'lines'
                      ? { lineOpacity: v / 100 }
                      : { patternOpacity: v })
                  }}
                />
                <span className={float.canvasFloatHint}>
                  {props.prefs.grid === 'lines'
                    ? Math.round(props.prefs.lineOpacity * 100)
                    : (props.prefs.patternOpacity ?? DEFAULT_PREFS.patternOpacity ?? 20)}%
                </span>
              </label>
            )}
          <label className={float.canvasFloatRow}>
            <span className={float.canvasFloatTitle}>参考线</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              aria-label="参考线"
              data-ewb-settings-guide-opacity=""
              value={props.prefs.guideOpacity ?? DEFAULT_PREFS.guideOpacity ?? 70}
              onChange={(e) => { props.onPrefs({ guideOpacity: Number(e.target.value) }) }}
            />
            <span className={float.canvasFloatHint}>
              {props.prefs.guideOpacity ?? DEFAULT_PREFS.guideOpacity ?? 70}%
            </span>
          </label>
        </div>

        {/* ── 浏览器那一段**已搬走**（2026-10-22）────────────────────────
         * 搬到侧栏底部的齿轮（`WorkspaceSettings.tsx`）。
         *
         * 为什么搬：浏览器是**工作台级**设置（会话与登录态，跨所有工作流共用），
         * 而这个抽屉是「这张图怎么画」。混在一起有两个后果：
         *   ① 要改浏览器得先进画布、再点设置，路径与作用范围不匹配；
         *   ② 在别的板块（取数 / 定时）想确认浏览器选对没有，根本进不去。
         *
         * ⚠️ **只保留一个入口**：这里不要再加回来。两处都能改比没有更糟 ——
         * 一边改完另一边还显示旧值，用户会以为没生效。 */}

        {/* ── 快捷键表**已删**（票 56）──
         *
         * 它原来在这里渲染三组 17 条。现在唯一来源是右下角那颗「?」按钮
         * （`CanvasZoomControls.tsx` 的 `shortcutHelp()`）。
         *
         * ⚠️ **不要再在这里加回来**：两份清单必然漂，
         * 而漂了之后用户没法知道该信哪个。要改说明就去改那个函数。 */}
    </div>
  )
}
