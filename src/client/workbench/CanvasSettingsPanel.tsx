/**
 * 内容画布的设置面板（用户 m03414：A7）。
 *
 * ## 为什么单独一个组件而不是塞进 `CanvasToolbar`
 *
 * 工具栏是「一次动作」（切换模式、加节点、撤销），设置是「长期偏好」——
 * 两件事的生命周期不一样：动作做完就结束，偏好要留着且要落盘。
 * 混在一起会让工具栏的 props 一路膨胀成二十多个。
 *
 * ## 与执行画布 `SettingsDrawer.tsx` 的关系
 *
 * 照它的骨架（分组标题 + 一行一个设置 + 快捷键表 + 恢复默认），
 * 但**内容画布特有的项**是这些：背景三种模式、线格深浅、小地图、
 * 对齐参考线、新节点落位间距、面板宽度档位。
 *
 * ## 一条纪律
 *
 * 每一项**改完立刻落盘**（`onChange` 一路写到 localStorage），不做「保存」按钮 ——
 * 用户不会记得点它，而这类偏好丢了没人会觉得是自己没保存。
 */

import { PANEL_WIDTHS } from './lib/canvas/canvas-prefs.ts'
import type { CanvasPrefs, GridMode, PanelWidthChoice } from './lib/canvas/canvas-prefs.ts'
import css from './EcomWorkbench.module.css'
/* ★ 票 57：面板的**整体样式**与执行画布共用（`canvasFloat*`，就在同一个文件里，
 * 只是分成两块：`canvasFloat*` 是两边共用的壳，`canvasSettings*` 是内容画布
 * 独有的零件）。这里同一个 import 出两个名字只为在代码里一眼看出
 * 「哪些类是共用的」。 */
import float from './EcomWorkbench.module.css'

/** 入参。 */
export interface CanvasSettingsPanelProps {  /** 当前设置。 */
  prefs: CanvasPrefs
  /** 改一项（外层负责落盘）。 */
  onChange: (patch: Partial<CanvasPrefs>) => void
  /** 恢复默认。 */
  onReset: () => void
  /** 关掉。 */
  onClose: () => void
}

/** 背景模式的三个选项（顺序即按钮顺序）。 */
/** 背景三档（**导出**：票 59 起执行画布的设置面板也用它，两边同一份措辞）。 */
export const GRID_OPTS: readonly { v: GridMode, label: string }[] = [
  { v: 'dots', label: '点阵' },
  { v: 'lines', label: '线格' },
  { v: 'none', label: '空白' },
]

/** 面板宽度的四个选项（`auto` 加三档）。 */
const WIDTH_OPTS: readonly { v: PanelWidthChoice, label: string }[] = [
  { v: 'auto', label: '自动' },
  { v: 260, label: '窄 260' },
  { v: 320, label: '中 320' },
  { v: 380, label: '宽 380' },
]

/* ★ 快捷键表常量**已删**（票 35，2026-10-28）。
 *
 * 用户原话：「快捷键既然有了独立的展示按钮，那么就不要再设置中放了，重复了没必要。」
 * 清单的唯一来源现在是 `CanvasZoomControls.tsx`（右下角那个按钮点开就是）。
 *
 * 留着这个数组的后果很具体：它不会被任何地方读到，但下一个人改快捷键时
 * 会先看到它、以为那才是正本 ——「有一份没人读的清单」比没有更坑。 */

/**
 * 设置面板。
 * @param props - 见 `CanvasSettingsPanelProps`。
 * @returns 面板。
 */
export function CanvasSettingsPanel(props: CanvasSettingsPanelProps): React.JSX.Element {
  const p = props.prefs
  /**
   * 改一项（统一入口，省得每处都写一遍）。
   * @param patch - 要改的字段。
   */
  const set = (patch: Partial<CanvasPrefs>): void => { props.onChange(patch) }
  return (
    <div className={float.canvasFloatPanel} data-ewb-canvas-settings="">
      <div className={float.canvasFloatHead}>
        <span className={float.canvasFloatTitle}>画布设置</span>
        <span className="flex-1" />
        <button
          type="button"
          data-ewb-settings-reset=""
          className={css.canvasSideChip}
          title="把所有设置恢复成默认值"
          onClick={props.onReset}
        >恢复默认</button>
        <button
          type="button"
          data-ewb-settings-close=""
          className={float.canvasFloatClose}
          title="关闭设置"
          onClick={props.onClose}
        >×</button>
      </div>

      {/* ★「新节点尺寸」那一项**已删**（票 34，2026-10-28）。
       *
       * 用户定：节点尺寸照参考项目（`refs-projects/infinite-canvas/web/src/
       * constant/canvas.ts:13`）**逐类定死**，不再提供全局覆盖。
       *
       * 原来这里那对宽高输入框已经没意义了 —— 留着它用户改了不生效，
       * 那正是这一整轮反复在修的「假开关」。
       *
       * ⚠️ `nodeW` / `nodeH` 两个字段**留在 `CanvasPrefs` 里**（见 `canvas-prefs.ts`
       * 的说明）：老存档里有值，删字段会让「恢复默认」按钮状态对不上。
       * 字段在、解析照旧、只是没有界面入口也不生效。 */}

      {/* ── 背景 ── */}
      <div className={float.canvasFloatGroup} data-ewb-settings-group="grid">
        <span className={float.canvasFloatTitle}>背景</span>
        <div className={float.canvasFloatRow}>
          {GRID_OPTS.map(o => (
            <button
              key={o.v}
              type="button"
              data-ewb-settings-grid={o.v}
              data-on={p.grid === o.v ? '' : undefined}
              className={css.canvasSideChip}
              onClick={() => { set({ grid: o.v }) }}
            >{o.label}</button>
          ))}
        </div>
        {/* ★ 票 59：这一块从「只有线格深浅」扩成**三个透明度**。
         *
         * ## 用户原话
         *
         * 「执行画布同理，增加背景设置，且增加透明度设置（参考线、点的透明度）」
         *
         * ## 三个滑块
         *
         * | 滑块 | 字段 | 落到哪 |
         * |---|---|---|
         * | 图案深浅 | `patternOpacity`（点阵）/ `lineOpacity`（线格） | `Background` 的 `color` 串 |
         * | 画布底 | `canvasBgOpacity` | `--ewb-canvas-bg` 的 `color-mix` |
         * | 参考线 | `guideOpacity` | 两画的辅助线（两边各自接线） |
         *
         * ## 为什么图案那条按档位换字段
         *
         * `lineOpacity` 是票 01 留下的、**只对线格生效**的旧字段，用户可能
         * 已经调过那条「线格深浅」。点阵档没有对应旧字段，所以用新的
         * `patternOpacity`。两档各读写自己的 —— 合并成一个会让
         * 「调过线格的人突然发现点阵也跟着变了」。
         *
         * ⚠️ 空白档**不显示**这一条（不是禁用）：拖了没反应的滑块
         * 正是这一整轮反复在修的「假开关」。 */}
        {p.grid === 'none'
          ? null
          : (
            <label className={float.canvasFloatRow}>
              <span className={float.canvasFloatTitle}>{p.grid === 'lines' ? '线格深浅' : '点阵深浅'}</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                data-ewb-settings-pattern-opacity=""
                value={p.grid === 'lines' ? Math.round(p.lineOpacity * 100) : (p.patternOpacity ?? 20)}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (p.grid === 'lines') set({ lineOpacity: v / 100 })
                  else set({ patternOpacity: v })
                }}
              />
              <span className={float.canvasFloatHint}>
                {p.grid === 'lines' ? Math.round(p.lineOpacity * 100) : (p.patternOpacity ?? 20)}%
              </span>
            </label>
          )}

        {/* 画布底（票 59：内容画布新增；执行画布原来就有，现在走同一个字段）。
         *
         * ⚠️ 它**只作用于画布底那一层**（`--ewb-canvas-bg` 的 `color-mix`），
         * 不是给元素加 `opacity` —— 后者会把节点、连线一起变透明。
         * 判据 6 钉这一条。 */}
        <label className={float.canvasFloatRow}>
          <span className={float.canvasFloatTitle}>画布底</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            data-ewb-settings-canvas-bg=""
            value={p.canvasBgOpacity ?? 100}
            onChange={(e) => { set({ canvasBgOpacity: Number(e.target.value) }) }}
          />
          <span className={float.canvasFloatHint}>{p.canvasBgOpacity ?? 100}%</span>
        </label>

        {/* 参考线（票 59）。
         *
         * 「参考线」= 拖动时出现的那几条对齐辅助线，原来写死 `opacity: 0.7`。
         * ⚠️ 值共用、**接线两处**：内容画布画在自己那一层，
         * 执行画布画在 `ViewportPortal` 里。只改一处另一边不会跟着变。 */}
        <label className={float.canvasFloatRow}>
          <span className={float.canvasFloatTitle}>参考线</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            data-ewb-settings-guide-opacity=""
            value={p.guideOpacity ?? 70}
            onChange={(e) => { set({ guideOpacity: Number(e.target.value) }) }}
          />
          <span className={float.canvasFloatHint}>{p.guideOpacity ?? 70}%</span>
        </label>
      </div>

      {/* ── 视图 ── */}
      <div className={float.canvasFloatGroup} data-ewb-settings-group="view">
        <span className={float.canvasFloatTitle}>视图</span>
        <label className={css.canvasSettingsCheck}>
          <input
            type="checkbox"
            data-ewb-settings-minimap=""
            checked={p.miniMap}
            onChange={(e) => { set({ miniMap: e.target.checked }) }}
          />
          <span>显示小地图</span>
        </label>
        <label className={css.canvasSettingsCheck}>
          <input
            type="checkbox"
            data-ewb-settings-align=""
            checked={p.align}
            onChange={(e) => { set({ align: e.target.checked }) }}
          />
          <span>对齐参考线与吸附</span>
        </label>
        {/* 说明行为，不说「做没做」—— 票 01 接通之后原来那句「尚未生效」已不成立。
         * 设置项说明属 R6 允许具体的那几处，所以把「只在松手时吸」讲清楚：
         * 用户要知道「拖动中为什么只是出现线、没有马上贴上去」。 */}
        {/* ★ 票 57 第 5 条：这条**留，但简写**。
         *
         * ## 为什么这一条属于「看不出后果的开关」
         *
         * 「对齐参考线与吸附」这个标签看不出**时机**：拖动时只出现线、松手才贴上去。
         * 不写清这一点，用户会觉得「我开了吸附，为什么拖的时候没贴上」——
         * 那是会让人重复试、甚至误以为坏了的一种困惑。
         *
         * 原句 47 字，删掉的是「开关关掉则既不显示也不吸附」——
         * 关掉不生效是**开关的定义**，不需要解释（用户 2026-10-29 丁 21：
         * 「看不出后果的开关」才写，能靠标签看懂的删）。 */}
        <span className={float.canvasFloatHint} data-ewb-settings-align-hint="">
          拖动时显示参考线，松手吸附
        </span>
      </div>

      {/* ── 落位 ── */}
      <div className={float.canvasFloatGroup} data-ewb-settings-group="drop">
        <span className={float.canvasFloatTitle}>新节点落位间距</span>
        <label className={float.canvasFloatRow}>
          <input
            type="range"
            min={0}
            max={120}
            step={4}
            data-ewb-settings-drop-gap=""
            value={p.dropGap}
            onChange={(e) => { set({ dropGap: Number(e.target.value) }) }}
          />
          <span className={css.canvasSettingsValue}>{p.dropGap}px</span>
        </label>
      </div>

      {/* ── 设置面板宽度 ── */}
      <div className={float.canvasFloatGroup} data-ewb-settings-group="panel">
        <span className={float.canvasFloatTitle}>节点设置面板宽度</span>
        <div className={float.canvasFloatRow}>
          {WIDTH_OPTS.map(o => (
            <button
              key={String(o.v)}
              type="button"
              data-ewb-settings-panel-width={String(o.v)}
              data-on={p.panelWidth === o.v ? '' : undefined}
              className={css.canvasSideChip}
              onClick={() => { set({ panelWidth: o.v }) }}
            >{o.label}</button>
          ))}
        </div>
        {/* ★ 票 57：「自动」这个词看不出**怎么**自动 —— 保留一句短的。
         *
         * 原句把四档宽度也列了出来（`自动 = 按画布可用宽度选 260 / 300 / …`）——
         * 那四档本来就印在旁边的按钮上，重复一遍是噪音，删掉。 */}
        <span className={float.canvasFloatHint}>
          自动按画布宽度选一档
        </span>
      </div>

      {/* ★ 快捷键表**已删**（票 35，2026-10-28，用户原话：
       * 「快捷键既然有了独立的展示按钮，那么就不要再设置中放了，重复了没必要」）。
       *
       * 独立入口在右下角（`CanvasZoomControls.tsx` 那个「快捷键」按钮），
       * 点它展开同一批清单。**两处只留一处** —— 改快捷键文案时也只有一处要改。
       *
       * ⚠️ `KEYS` 常量也一起删了：留着它就是「有一份没人读的清单」，
       * 下一个人会以为改它有用。清单的唯一来源现在是 `CanvasZoomControls`。 */}

      {/* ★ 票 57：这条路原来写「设置自动保存，刷新后仍在」—— **删了**。
       *
       * 判据（R6 那条）：删掉这句用户会不会做错事？不会 —— 它既不解释某个开关的
       * 后果，也不给补救步骤。而它每一屏都在，占的是一行说明的位置。
       * 「改完自动存住了」这件事用户刷新一次就会知道。
       *
       * ⚠️ 钩子 `data-ewb-settings-saved` 一起删了：留着它是「有一个没人读的钩子」，
       * 下一个人会以为这里有东西可断言。 */}
    </div>
  )
}
