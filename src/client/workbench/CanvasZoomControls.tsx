/** 画布右下角浮层（票 56）—— 执行画布与内容画布**共用这一份**。
 *
 * ## 用户 2026-10-29 定案（对照表丙组 12-17、表三、表七 #55）
 *
 * > 参考左下角的按钮，我们依旧放右下角，注意对齐原则，参考是左下角和中间栏
 * > 相对独立，中间栏对齐的是排除左侧栏后居中。我们的中间栏应该是画布居中，
 * > 画面过窄的情况下右下角（图/复位/缩放比/快捷键）隐藏。右下角文字换成图标。
 *
 * > 两边样式代码都要统一，但是有一点，执行画布多了自动排版，
 * > 这一点内容画布是不需要的，这一点不要遗漏了。
 *
 * ## 这一版改了什么
 *
 * | 改之前 | 改之后 |
 * |---|---|
 * | 两边各写一遍（内容画布 `.canvasZoom` 五件、执行画布用 React Flow 自带 `<Controls>`） | **同一个组件**，两边都 import 它 |
 * | 文字是字符（「图」「复位」「?」「⤢ 缩放适配」） | **只留图标**，文字进 `title` |
 * | 执行画布的自动排版在**右上角** `<Panel>` | 并进这一排（**只在执行画布**，靠 `showAutoLayout` 开关） |
 * | 执行画布没有撤销步数常显 | 两边都有（`undoWhat` 一条小字） |
 * | 窄屏各写各的 | 整组隐藏（`@container` 一次做完） |
 *
 * ## 为什么文件名还是 `CanvasZoomControls.tsx`
 *
 * 票面把它列为可改路径（「改造成两边共用」）。改名要动所有 import 点，
 * 而「谁引它」不在本票可改范围。**文件名里那个 zoom 已经是旧名** ——
 * 现在它管的不只是缩放（小地图 / 适配 / 步数 / 快捷键 / 自动排版）。
 * 导出名同步改成 `CanvasCornerControls`，读代码的人不会再被 `canvasZoom*` 带偏。
 */
import { useState } from 'react'
import css from './EcomWorkbench.module.css'
import { MapIcon, MaximizeIcon, CornerUpRightIcon, CornerDownRightIcon, XIcon } from './icons.tsx'

/** 缩放范围（5% – 500%）。 */
export const ZOOM_MIN = 5
export const ZOOM_MAX = 500

/**
 * 把任意缩放百分比夹进范围（**纯函数**，验收判据落在这里）。
 *
 * @param pct - 原始百分比。
 * @returns 5–500 之间的整数；不是有限数时给 100。
 */
export function clampZoomPct(pct: number): number {
  if (!Number.isFinite(pct)) return 100
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(pct)))
}

/** 一条快捷键说明。 */
export interface ShortcutRow {
  /** 键位组合。 */
  keys: string
  /** 做什么。 */
  what: string
}

/**
 * 快捷键说明（与画布的键盘处理一一对应，别各写一份）。
 *
 * ## 票 56：这里成了**唯一**的清单
 *
 * `SettingsDrawer.tsx` 里那张三组 17 条的表**已删**（票面判据 6）。
 * 删之前逐条比对过，缺的都补进来了 —— 补齐情况见下面每条的注释。
 *
 * ## 2026-10-27 从常量改成函数（票 02）
 *
 * 原来 `Ctrl + Z / Y` 那一行只写「撤销 / 重做」—— 用户不知道**现在**能撤几步。
 * 改成函数就为了把 `undoWhat` 那一句接进去。
 *
 * ⚠️ 步数**不在这里读** `depths`：画布右下角那条独立提示、底部条按钮的 title、
 * 这里，三处必须说同一个数。各读一次就总有一处显示旧值。
 *
 * @param undoWhat - 撤销 / 重做那一行写什么（默认给一句不带步数的）。
 * @returns 快捷键清单。
 */
export function shortcutHelp(undoWhat = '撤销 / 重做'): readonly ShortcutRow[] {
  return [
    { keys: 'Ctrl / Cmd + 滚轮', what: '缩放画布' },
    { keys: 'Delete / Backspace', what: '删除选中节点' },
    { keys: 'Esc', what: '取消选中、关面板' },
    { keys: 'Ctrl + A', what: '全选' },
    { keys: 'Ctrl + C / V', what: '复制 / 粘贴' },
    { keys: 'Ctrl + D', what: '原地复制一份' },
    { keys: 'Ctrl + G', what: '编组 / 解散' },
    { keys: 'Ctrl + Z / Y', what: undoWhat },
    { keys: 'Ctrl + = / - / 0', what: '放大 / 缩小 / 100%' },
    /* ★ 票 61（2026-10-29）：Ctrl 也能临时切（用户戊 25：
     * 「空格和 ctrl 都可以临时切换左键功能」）。两个键都要写在这里 ——
     * 这张表是**唯一**的快捷键清单（票 56 删掉了抽屉里那张），
     * 写半边就等于告诉用户另一半不存在。 */
    { keys: '空格 / Ctrl（按住）', what: '临时抓手' },
    /* ── 票 56：以下四条原来只有设置抽屉那张表里写着，删表时补进来 ──
     *
     * 这是「删表不是删内容」这一步的落点：抽屉里那 17 条逐条比对之后，
     * 这里缺的是下面这四条。 */
    { keys: 'Ctrl + 拖拽', what: '框选一片节点（按住时左键不再拖动画布）' },
    { keys: 'Ctrl + 点击', what: '加选 / 减选单个节点' },
    { keys: '拖拽空白处', what: '平移画布' },
    { keys: '右键连线', what: '删除这条连线' },
  ]
}

/** 不带步数的默认清单（旧名，别处还在引就用这个）。 */
export const SHORTCUT_HELP: readonly ShortcutRow[] = shortcutHelp()

/** 入参（票 56：两边共用）。 */
export interface CanvasCornerControlsProps {
  /** 当前缩放（1 = 100%）。 */
  zoom: number
  /** 改缩放。 */
  onZoom: (z: number) => void
  /** 缩放适配（把全部节点缩到可见范围）。 */
  onFit: () => void
  /** 小地图开着没有。 */
  miniMap: boolean
  /** 开关小地图。 */
  onToggleMiniMap: () => void
  /**
   * 快捷键说明里「撤销 / 重做」那一行写什么（票 02）。
   *
   * 由画布算好传下来 —— 与底部条按钮 title、这一排上的步数小字同源。
   */
  undoWhat?: string
  /**
   * 是否显示**自动排版**两颗（横向 / 纵向）。
   *
   * ## ⚠️ 只有执行画布为 true
   *
   * 用户 2026-10-29 点名：「执行画布多了自动排版，这一点内容画布是不需要的，
   * 这一点不要遗漏了。」
   * 内容画布**没有**自动排版的业务（节点是自由摆放的素材卡，没有「流程方向」）。
   *
   * 做成 prop 而不是「两边各写一份」：同一个组件、同一个开关，
   * 差别只有这一个布尔 —— 不会出现「一边改了另一边忘改」。
   */
  showAutoLayout?: boolean
  /** 当前自动排版方向（只在 `showAutoLayout` 为真时有意义）。 */
  layoutDir?: 'RIGHT' | 'DOWN'
  /** 按某个方向自动排版。 */
  onLayout?: (dir: 'RIGHT' | 'DOWN') => void
  /** 哪一边（钩子 `data-ewb-corner` 的值，测试据此区分）。 */
  kind: 'workflow' | 'content'
}

/**
 * 画布右下角浮层（两边共用）。
 *
 * ## 位置
 *
 * `absolute; right: 10px; bottom: 10px` —— 用户丙 14：「参考在左下，我们仍旧放右下角」。
 * 左边有 230px 导航栏，照抄参考的左下会撞上。
 *
 * ## 窄时**整组隐藏**
 *
 * 用户丙 16：「画面过窄的情况下右下角（图/复位/缩放比/快捷键）隐藏」。
 * 是**整组一起消失**，不是缩成图标、不是折行 —— 那一排本来就窄，
 * 再拆散就只剩几个孤零零的图标。规则在 `EcomWorkbench.module.css`
 * 的 `.canvasCorner` 那段（容器查询，按**画布区宽度**判）。
 *
 * ## 层叠
 *
 * 整组 `z-index: 11`，小地图是 6 —— 缩放条要能点到（见 `.react-flow__minimap`
 * 那条注释里记的 2026-10-26 那个 bug）。
 *
 * @param props - 见 `CanvasCornerControlsProps`。
 * @returns 浮层。
 */
export function CanvasCornerControls(props: CanvasCornerControlsProps): React.JSX.Element {
  const [help, setHelp] = useState(false)
  const pct = clampZoomPct(props.zoom * 100)

  return (
    <div
      className={css.canvasCorner}
      data-ewb-corner={props.kind}
      /* 点这一排不该穿透到画布（否则点按钮顺带平移了画布）。 */
      onPointerDown={e => { e.stopPropagation() }}
    >
      {/* ── 自动排版（只有执行画布有，判据 3 的反面断言守这一条）──
       *
       * 两个方向各一个按钮，视觉上合在一个小容器里（照 2026-10-11 那次的要求：
       * 「视觉上他们还是在一起，只是两个部分单独点击」）。
       * 旧实现是 `<Panel position="top-right">` 里的 `.layoutGroup`，搬到这里。 */}
      {props.showAutoLayout === true
        ? (
          <div className={css.canvasCornerLayout} data-ewb-corner-layout="">
            <button
              type="button"
              data-ewb-corner-dir="RIGHT"
              data-on={props.layoutDir === 'RIGHT' ? '' : undefined}
              className={css.canvasCornerLayoutBtn}
              title="自动排版：从左到右（横向）"
              aria-pressed={props.layoutDir === 'RIGHT'}
              onClick={() => { props.onLayout?.('RIGHT') }}
            ><CornerUpRightIcon size={14} /></button>
            <button
              type="button"
              data-ewb-corner-dir="DOWN"
              data-on={props.layoutDir === 'DOWN' ? '' : undefined}
              className={css.canvasCornerLayoutBtn}
              title="自动排版：从上到下（纵向）"
              aria-pressed={props.layoutDir === 'DOWN'}
              onClick={() => { props.onLayout?.('DOWN') }}
            ><CornerDownRightIcon size={14} /></button>
          </div>
        )
        : null}

      {/* ── 小地图开关（票 56：从顶部条搬进来，用户丙 26）── */}
      <button
        type="button"
        data-ewb-corner-minimap=""
        /* ⚠️ 旧钩子别名（过渡）：票 56 之前它叫 `data-ewb-zoom-minimap`。
         * 既有断言仍按旧名找它。 */
        data-ewb-zoom-minimap=""
        data-on={props.miniMap ? '' : undefined}
        className={css.canvasCornerBtn}
        title={props.miniMap ? '关掉小地图' : '打开小地图'}
        aria-pressed={props.miniMap}
        onClick={props.onToggleMiniMap}
      ><MapIcon size={14} /></button>

      {/* ── 缩放适配（票 56：从右上角那颗「⤢ 缩放适配」并进来，只留一处）── */}
      <button
        type="button"
        data-ewb-corner-fit=""
        data-ewb-zoom-reset=""
        className={css.canvasCornerBtn}
        title="缩放适配：把所有节点缩到可见范围"
        onClick={props.onFit}
      ><MaximizeIcon size={14} /></button>

      {/* ── 缩放滑杆 + 百分比 ── */}
      <input
        type="range"
        data-ewb-corner-slider=""
        data-ewb-zoom-slider=""
        className={css.canvasCornerSlider}
        min={ZOOM_MIN}
        max={ZOOM_MAX}
        step={1}
        value={pct}
        aria-label="缩放"
        onChange={(e) => { props.onZoom(clampZoomPct(Number(e.target.value)) / 100) }}
      />
      <span className={css.canvasCornerPct} data-ewb-corner-pct="" data-ewb-zoom-pct="">{pct}%</span>

      {/* ── 撤销步数常显（判据 5：与按钮 `disabled` 同源）──
       *
       * 内容画布原来就在右下角有一条（`[data-ewb-undo-hint]`），
       * 执行画布只有 `title` 里能看到。两边现在都在这里。 */}
      {props.undoWhat === undefined || props.undoWhat === ''
        ? null
        : (
          /* ⚠️ **同元素挂两个钩子**：
           *   · `data-ewb-corner-undo` —— 票 56 的新判据用它
           *   · `data-ewb-undo-hint` —— `tests/content-canvas-ops.mjs` 三处按它找
           *     （`data-ewb-undo-hint` 是这条小字原来的钩子；换锚点不是本票的活）
           * 两套并存是**过渡**，不是「两套机制」—— 它们指向同一个元素、同一个值。 */
          <span
            className={css.canvasCornerHint}
            data-ewb-corner-undo=""
            data-ewb-undo-hint=""
          >{props.undoWhat}</span>
        )}

      {/* ── 快捷键（判据 6：这张清单现在是**唯一**一份）── */}
      <button
        type="button"
        data-ewb-corner-help=""
        data-ewb-zoom-help=""
        className={css.canvasCornerBtn}
        title="快捷键"
        aria-expanded={help}
        onClick={() => { setHelp(v => !v) }}
      >{help ? <XIcon size={14} /> : <span className={css.canvasCornerHelpMark}>?</span>}</button>

      {help
        ? (
          <div className={css.canvasShortcuts} data-ewb-shortcuts="">
            <div className={css.canvasShortcutsHead}>快捷键</div>
            {shortcutHelp(props.undoWhat).map(s => (
              <div key={s.keys} className={css.canvasShortcutsRow}>
                <span className={css.canvasShortcutsKeys}>{s.keys}</span>
                <span className={css.canvasShortcutsWhat}>{s.what}</span>
              </div>
            ))}
          </div>
        )
        : null}
    </div>
  )
}
