/** 画布悬浮条的两类通用零件 —— 执行画布与内容画布**共用这一份**（票 54）。
 *
 * ## 2026-10-29 改：它原来是「内容画布专用的那条外置工具条」
 *
 * 那时它渲染的是 `.contentCanvasBar`：排在 `.canvasMain` **之前**的一行，
 * 吃画布上方一条高度、带底边。用户 2026-10-29 定案甲 1：
 * 「两边都不要顶部栏，顶部在画布中悬浮」。
 *
 * 于是这个文件改成**零件库**：
 *   · `CanvasTopBar` —— 悬浮条外壳（贴画布顶边、不铺底、不挡画布）
 *   · `TopBarButton` —— 一颗图标按钮（只留图标，文字进 `title`）
 *   · `TopBarDivider` —— 分组竖线
 *
 * 具体按钮由两个画布各自传进来（业务不同），**几何与外观只有这一处定义** ——
 * 这就是用户丁 20 要的「两边共用一个样式」，做成组件比只共用 CSS 更进一层。
 *
 * ⚠️ **`CanvasToolbar` 这个组件本身已删**：它的按钮分进了悬浮条的左右两组。
 * 下面那几个纯函数（`modeToProps` / `toggleMode` / `ADDABLE`）**一个没动** ——
 * `ContentCanvas.tsx` 与测试都在用。
 *
 * ## 下面这段是原来那个组件的来历，留着是因为它解释的模式切换语义没变
 *
 * ## 照参考项目
 *
 * `refs-projects/infinite-canvas/web/src/components/canvas/canvas-toolbar.tsx:98` 第一颗按钮：
 * ```jsx
 * onClick={() => onCanvasToolChange(canvasTool === "select" ? "pan" : "select")}
 * {canvasTool === "select" ? <MousePointer2 /> : <Hand />}
 * ```
 * 一个按钮在 `select` / `pan` 两态之间切。
 *
 * ## 这两个态在 React Flow 上对应什么（已核 `component-props.d.ts`）
 *
 * ```
 * selectionOnDrag?: boolean   // :289
 * panOnDrag?: boolean | number[]  // :399
 * ```
 *
 * | 模式 | `panOnDrag` | `selectionOnDrag` | 拖动的效果 |
 * |---|---|---|---|
 * | `select` | `false` | `true` | 拉出一个框选区域 |
 * | `pan` | `true` | `false` | 平移画布 |
 *
 * ⚠️ **按住 Ctrl/Space 临时切**这条 React Flow 自己就有（`panActivationKeyCode` /
 * `selectionKeyCode`），本组件**不接管它** —— 只加这个常驻按钮。用户 m01076 要的
 * 是「不用一直按着 Ctrl」。
 *
 * ## 换掉了什么
 *
 * 参考项目那一排 400 行包含扩展管理、外观设置、插件、批量操作。
 * 这里只留本单要的：模式切换 / 撤销重做 / 加五类节点 / 分组占位 / 设置侧栏开关。
 * antd 组件全部换成原生 + Tailwind（理由同侧栏）。
 */
import type { ContentNodeType } from './content-canvas-store.ts'
import css from './EcomWorkbench.module.css'

/** 操作模式。 */
export type CanvasMode = 'select' | 'pan'

/**
 * 模式 → React Flow 的两个属性（**纯函数**，验收 1 的判据落在这里）。
 *
 * @param mode - 当前模式。
 * @returns 直接摊给 `<ReactFlow>` 的两个属性。
 */
export function modeToProps(mode: CanvasMode): { panOnDrag: boolean, selectionOnDrag: boolean } {
  return mode === 'pan'
    ? { panOnDrag: true, selectionOnDrag: false }
    : { panOnDrag: false, selectionOnDrag: true }
}

/** 点一下模式按钮之后变成什么。 */
export function toggleMode(mode: CanvasMode): CanvasMode {
  return mode === 'pan' ? 'select' : 'pan'
}

/** 可添加的节点类型。 */
export const ADDABLE: readonly { type: ContentNodeType, label: string }[] = [
  { type: 'text', label: '文本' },
  { type: 'image', label: '图片' },
  { type: 'video', label: '视频' },
  { type: 'audio', label: '音频' },
  { type: 'config', label: '配置' },
]

/** 一颗图标按钮（悬浮条里的最小单位）。
 *
 * ## 为什么 `action` 与 `title` 都是必填
 *
 * 文字已经全部挪进 `title`（用户甲 3：「只留图标不要文字，文字悬浮」）。
 * 少一个 `title` 就等于一颗**没有说明的图标** —— 用户不知道点它会做什么。
 * 所以做成必填，让 TypeScript 挡住漏写。
 *
 * ## `legacy` 是给既有断言留的过渡钩子
 *
 * 内容画布那几颗在票 54 之前挂着 `data-ewb-canvas-undo` 之类的钩子，
 * `tests/content-canvas*.mjs` 有 10 处按它们找按钮。换锚点是票面允许的，
 * 但那是「顺手改别人的判据」，本票不做（票面只要求改 dom-render 那几处）。
 * 所以两套钩子并存：`data-ewb-tb` 给新判据，`legacy` 留给既有断言。
 *
 * @param props - 见下。
 * @returns 按钮。
 */
export function TopBarButton(props: {
  /** `data-ewb-tb` 的值（测试按它找按钮；票 63 也用这套）。 */
  action: string
  /** 悬停提示（必填，理由见上）。 */
  title: string
  onClick: () => void
  children: React.ReactNode
  /** 禁用（无历史可撤销 / 没开画布时）。 */
  disabled?: boolean
  /** 开关类按钮的「已开」态（设置浮窗开着、锁定着、侧栏开着）。 */
  on?: boolean
  /** 需要注意的强调色（「未保存」这类）。 */
  hot?: boolean
  /** 兼容用的旧钩子（只给既有断言，不参与新判据）。 */
  legacy?: Record<string, string>
  /** 额外类名（内容画布那侧用它挂自己的按钮样式）。 */
  className?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-ewb-tb={props.action}
      {...props.legacy ?? {}}
      data-on={props.on === true ? '' : undefined}
      data-hot={props.hot === true ? '' : undefined}
      className={[css.contentCanvasBarBtn, props.className ?? ''].join(' ').trim()}
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled === true}
      onClick={props.onClick}
    >{props.children}</button>
  )
}

/** 分组竖线（照参考的 `<Divider>`）。 */
export function TopBarDivider(): React.JSX.Element {
  return <span className={css.contentCanvasBarDivider} aria-hidden="true" />
}

/** 悬浮条入参。 */
export interface CanvasTopBarProps {
  /** 左侧内容（侧栏开关、画布名称、保存态）。 */
  left: React.ReactNode
  /** 右侧内容（文件类、撤销重做、锁定、设置、主题）。 */
  right: React.ReactNode
  /** 哪一边（钩子 `data-ewb-topbar` 的值，测试据此区分两个画布）。 */
  kind: 'workflow' | 'content'
}

/**
 * 画布内顶部悬浮条（两边共用）。
 *
 * ## 几何与参考一致
 *
 * `refs-projects/infinite-canvas/web/src/components/canvas/canvas-top-bar.tsx:82`：
 * `absolute left-0 right-0 top-0`，浮在**画布内**、不占画布上方一行。
 * 容器 `pointer-events: none`、组件内的按钮自己 `auto` ——
 * 所以**容器不挡画布**：用户在顶部条那片空白处照样能拖画布、拉框选。
 * **不铺背景底板**（参考只有按钮自己有底，用户说的是「背景就是画布」）。
 *
 * ⚠️ **必须挂在画布容器里**（执行画布 `.canvas`、内容画布 `.contentCanvasStage`），
 * 不是在它外面 —— 否则又变成「画布上方一行」。判据 1 查的就是这个祖先链。
 *
 * @param props - 见 `CanvasTopBarProps`。
 * @returns 悬浮条。
 */
export function CanvasTopBar(props: CanvasTopBarProps): React.JSX.Element {
  return (
    <div data-ewb-topbar={props.kind} className={css.contentCanvasBar}>
      {/* 两组各自 `pointer-events: none`（组内空白穿透），
       * 组里的每一个子元素自己 `auto` —— 见 `.contentCanvasBarSide` 的注释。 */}
      <div className={css.contentCanvasBarSide}>{props.left}</div>
      <div className={css.contentCanvasBarGap} />
      <div className={css.contentCanvasBarSide}>{props.right}</div>
    </div>
  )
}

/**
 * 底部胶囊条里的一颗按钮（票 55）。
 *
 * ## 与 `TopBarButton` 的差别
 *
 * | | `TopBarButton`（顶部） | `DockButton`（底部） |
 * |---|---|---|
 * | 尺寸 | 28×28 | 36×36（56 高的条里放 36，上下各留 10） |
 * | 底色 | 有（小胶囊） | 无（透明，靠 `hover` 才显） |
 * | `data-ewb-tb` | 有 | **无** —— 挂 `data-ewb-dock-btn`，两套不混 |
 * | 窄屏 | 顶部条那套 | `collapse` 三档（判据 6） |
 *
 * ## `collapse` 三档（判据 6：锁定 → 主题 → 撤销/重做 依次少显示）
 *
 * · `1` —— **扩展入口**（快照、恢复、小地图、图例、文件类）。最先收。
 * · `2` —— **主题切换**。用户指定的第二档。
 * · `3` —— **撤销 / 重做**。用户指定的最后一档（它们有快捷键）。
 * · **不给** —— 常驻（模式切换、主操作、设置）。
 *
 * 阈值与规则在 `EcomWorkbench.module.css` 的 `.canvasDockWrap` 那段（容器查询）。
 *
 * @param props - 见下。
 * @returns 按钮。
 */
export function DockButton(props: {
  /** `data-ewb-dock-btn` 的值（测试按它找按钮）。 */
  action: string
  /** 悬停提示（必填：文字已无，没 title 就等于没说明）。 */
  title: string
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
  /** 开关类的「已开」态。 */
  on?: boolean
  /** 主操作（语义色强调）。 */
  primary?: boolean
  /** 危险动作（运行中点它 = 停止）。 */
  danger?: boolean
  /** 窄屏收起的档位（1/2/3；不给 = 常驻）。 */
  collapse?: 1 | 2 | 3
  /**
   * 兼容用的旧钩子。**只给内容画布那 10 处既有断言留**。
   *
   * 与 `TopBarButton.legacy` 不是同一件事：
   * · 顶部那个是「票 54 之前挂过的钩子」；
   * · 这个是「**按钮从顶部搬到下面，钩子跟着走**」——
   *   `tests/content-canvas*.mjs` 按 `data-ewb-canvas-mode` / `-add` /
   *   `-undo` / `-redo` 找它们，换锚点不是票 55 的活。
   */
  legacy?: Record<string, string>
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-ewb-dock-btn={props.action}
      {...props.legacy ?? {}}
      data-on={props.on === true ? '' : undefined}
      data-primary={props.primary === true ? '' : undefined}
      data-danger={props.danger === true ? '' : undefined}
      data-collapse={props.collapse === undefined ? undefined : String(props.collapse)}
      className={css.canvasDockBtn}
      title={props.title}
      aria-label={props.title}
      disabled={props.disabled === true}
      onClick={props.onClick}
    >{props.children}</button>
  )
}

/** 底部主操作位入参（票 55）。 */
export interface CanvasDockProps {
  /** 左段：鼠标模式切换（一个按钮两态）。 */
  mode: React.ReactNode
  /** 中段：撤销 / 重做。 */
  history: React.ReactNode
  /** 右段：各自的主操作（执行画布＝运行/停止；内容画布＝加节点组 + 分组）。 */
  main: React.ReactNode
  /** 哪一边（钩子 `data-ewb-dock` 的值，测试据此区分两个画布）。 */
  kind: 'workflow' | 'content'
}

/**
 * 画布内**底部居中**的主操作位（票 55，用户 2026-10-29 甲 5、6 与戊 22）。
 *
 * ## 用户原话
 *
 * > 主操作放底部中间悬浮，也就是用参考的模式。注意，内容画布的节点按钮
 * > 就是执行画布的开始停止等执行按钮一个级别的。二者逻辑不一样但定位相同，
 * > 这些内容在主操作位。
 *
 * > 拖动方式当前内容化画布也没有按钮，他俩都要补中间的主操作位悬浮框。
 *
 * ## 几何（判据 2）
 *
 * `position: absolute; bottom: 20px; left: 0; right: 0; justify-content: center`
 * —— **相对画布区居中**，不是相对整列居中。
 * 参考的 `canvas-toolbar.tsx:95` 写 `left: 300` 是为了让开它的会话栏；
 * 我们的浮层挂在画布容器里，左边界天然就是画布左边界，不用让。
 *
 * ⚠️ **不要写成 `left: 50%; transform: translateX(-50%)`** —— 那是「相对自身宽度居中」，
 * 在 `left: 0; right: 0` 的容器里两者等价，但前者在容器有 padding / 滚动条时会偏。
 * 判据 2 用「左右两端空白相等」钉住这件事。
 *
 * ## 胶囊条形状（照参考 `canvas-toolbar.tsx:99`）
 *
 * 高 56、圆角 12、1px 边框、轻模糊底色、阴影。内容按竖线分组。
 * ⚠️ **这一条与顶部悬浮条不同：它铺底**。顶部条不铺底（用户「背景就是画布」），
 * 底部主操作位是一条胶囊 —— 参考那里也是 `rounded-xl border backdrop-blur`，
 * 有底的目的是让「主操作」从画布里浮出来。
 *
 * @param props - 见 `CanvasDockProps`。
 * @returns 底部悬浮条。
 */
export function CanvasDock(props: CanvasDockProps): React.JSX.Element {
  return (
    <div data-ewb-dock={props.kind} className={css.canvasDockWrap}>
      <div className={css.canvasDock}>
        <div className={css.canvasDockGroup}>{props.mode}</div>
        <span className={css.canvasDockDivider} aria-hidden="true" />
        <div className={css.canvasDockGroup}>{props.history}</div>
        <span className={css.canvasDockDivider} aria-hidden="true" />
        <div className={css.canvasDockGroup}>{props.main}</div>
      </div>
    </div>
  )
}
