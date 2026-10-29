/** 图标集 —— 照 lucide-react 的组件形状内联 SVG（size / strokeWidth / className / style）。
 *
 * 为什么不直接依赖 lucide-react：本插件没装这个依赖，且 package.json 冻结不动；
 * 这里用的是 lucide 官方 v0.441.0 的 path 数据，日后若要换成 lucide-react，
 * 只需把 import 换成 `import { Package as PackageIcon } from 'lucide-react'`。
 * 默认 1.7 描边（FounderOS 导航图标的取值），随 color 继承。
 */
import type { CSSProperties, ReactNode } from 'react'

/** 图标通用入参（对齐 lucide 的 API 形状）。 */
export interface IconProps {
  /** 边长 px，默认 15（FounderOS 导航图标尺寸）。 */
  size?: number
  /** 描边粗细，默认 1.7。 */
  strokeWidth?: number
  /** 附加类名。 */
  className?: string
  /** 附加内联样式。 */
  style?: CSSProperties
}

/**
 * 渲染一个 lucide 形状的图标骨架。
 * @param children - SVG 内的路径节点。
 * @param props - 图标入参。
 * @returns SVG 元素。
 */
function svg(children: ReactNode, { size = 15, strokeWidth = 1.7, className, style }: IconProps): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/** 侧栏折叠（lucide panel-left）。FounderOS 的侧栏折叠按钮用的就是它。 */
export function PanelLeftIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <rect width="18" height="18" x="3" y="3" rx="2" />
    <path d="M9 3v18" />
  </>, props)
}

/** 商品（lucide package）。 */
export function PackageIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="m7.5 4.27 9 5.15" />
    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
  </>, props)
}

/** 客服（lucide message-square）。 */
export function MessageSquareIcon(props: IconProps): React.JSX.Element {
  return svg(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />, props)
}

/** 数据（lucide database）。 */
export function DatabaseIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5V19A9 3 0 0 0 21 19V5" />
    <path d="M3 12A9 3 0 0 0 21 12" />
  </>, props)
}

/** 内容（lucide image）。 */
export function ImageIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
  </>, props)
}

/** 工作流（lucide workflow）。 */
export function WorkflowIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <rect width="8" height="8" x="3" y="3" rx="2" />
    <path d="M7 11v4a2 2 0 0 0 2 2h4" />
    <rect width="8" height="8" x="13" y="13" rx="2" />
  </>, props)
}

/** 收藏（lucide star）。 */
export function StarIcon(props: IconProps): React.JSX.Element {
  return svg(<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />, props)
}

/** 显示对话区（lucide eye）。 */
export function EyeIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
    <circle cx="12" cy="12" r="3" />
  </>, props)
}

/** 隐藏对话区（lucide eye-off）。 */
export function EyeOffIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" />
    <path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" />
    <path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" />
    <path d="m2 2 20 20" />
  </>, props)
}

/** 总览（lucide layout-dashboard）。
 *
 * 2026-10-21 新增：八个板块重排后「总览」需要自己的图标。
 * 照 lucide v0.441.0 的 path 数据，与上面那些同一套（1.7 描边、currentColor）。 */
export function LayoutDashboardIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <rect width="7" height="9" x="3" y="3" rx="1" />
    <rect width="7" height="5" x="14" y="3" rx="1" />
    <rect width="7" height="9" x="14" y="12" rx="1" />
    <rect width="7" height="5" x="3" y="16" rx="1" />
  </>, props)
}

/** BI 看板（lucide layout-grid）。
 *
 * ⚠️ **本图标已不再用于 BI**（2026-10-23 契约 Y）。用户原话「BI 的图标与总览太像」——
 * 总览是 `LayoutDashboardIcon`（四块不等高的矩形），这个是四块等高的方块，
 * 两个都是「四宫格」，缩到 15px 几乎分不出。BI 已换成 {@link ChartColumnIcon}。
 * 保留它是因为 `LayoutGrid` 本身是个通用形状（日后别处还能用），不删。 */
export function LayoutGridIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <rect width="7" height="7" x="3" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="14" rx="1" />
    <rect width="7" height="7" x="3" y="14" rx="1" />
  </>, props)
}

/** BI（lucide chart-column）。
 *
 * ## 为什么换成柱状图（2026-10-23 契约 Y）
 *
 * 用户说 BI 与总览的图标「太像了」。原来 BI 用 `LayoutGridIcon`、总览用
 * `LayoutDashboardIcon` —— 两个都是**四宫格**，缩到 15px 描边一糊就分不出。
 *
 * 柱状图与「布局网格」的区别不在细节而在**轮廓**：三条**不等高的竖线** + 底座，
 * 一眼看过去是「有高低的数据」，不是「四个方块」。判据见
 * `tests/board-registry.mjs` 的「两个图标不许是同一种轮廓」那条。
 *
 * 照 lucide v0.441.0 的 `chart-column` path 数据（1.7 描边、24 viewBox，与其余图标同一套）。 */
export function ChartColumnIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M3 3v16a2 2 0 0 0 2 2h16" />
    <path d="M18 17V9" />
    <path d="M13 17V5" />
    <path d="M8 17v-3" />
  </>, props)
}

/** 自动化（lucide repeat / 循环箭头）。
 *
 * ## 为什么换掉 `DownloadArrowIcon`（2026-10-23 契约 Y）
 *
 * 用户原话：「自动化板块暂时OK，只是左侧栏的 ICON 需要调整一下」。
 * 原来用的是**下载箭头**——那是「取数」这个动作的图标，而板块早改名成「自动化」，
 * 里面也不只下载（定时任务、任务记录、巡查都在这一块）。图标停在旧名字上。
 *
 * ## 为什么不用「方框 + 折线」那种流程形状
 *
 * 第一版画的就是它，**与 `WorkflowIcon` 逐字节相同**（`rect 8×8 @3,3` +
 * `M7 11v4a2 2 0 0 0 2 2h4` + `rect 8×8 @13,13`）—— 等于给两个板块挂了同一个图标。
 * 所以换成**两条反向的弧形箭头**：看过去是「周而复始地跑」，与「单条流程走一遍」
 * （工作流那个）在轮廓上完全不同：这个是**两个开口环 + 两个箭头**，
 * 没有实心方框，缩到 15px 也不会与带方框的混。
 *
 * 照 lucide v0.441.0 的 `repeat` path 数据（1.7 描边、24 viewBox，与其余图标同一套）。 */
export function AutomationIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="m17 2 4 4-4 4" />
    <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
    <path d="m7 22-4-4 4-4" />
    <path d="M21 13v1a4 4 0 0 1-4 4H3" />
  </>, props)
}

/** 定时（lucide clock）。 */
export function ClockIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </>, props)
}

/** 提醒（lucide bell）。 */
export function BellIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M10.268 21a2 2 0 0 0 3.464 0" />
    <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" />
  </>, props)
}

/** 取数（lucide download）。
 *
 * ⚠️ 名字带 `Arrow` 是为了与日后可能出现的「下载」类图标区分（同形状、不同用途）。 */
export function DownloadArrowIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" x2="12" y1="15" y2="3" />
  </>, props)
}

/* ══════════════════════════════════════════════════════════════════════
 * 画布那一层要用的图标（2026-10-26 用户要求「图标统一」）
 *
 * ## 为什么加这一批
 *
 * 画布的工具条、右键菜单、侧栏原来用的是**字符**（`⇢` `⤢` `▣` `🗑` …）。
 * 字符的问题：不同系统字体下粗细不一；`🗑` 在部分环境是**彩色 emoji 方块**；
 * 而且与板块那一层（本文件这些真 SVG）**两套并存**，界面看着像两个人做的。
 *
 * ## 一律照 lucide v0.441.0 的 path 数据
 *
 * 与上面已有的 17 个同一套（1.7 描边、24 viewBox、currentColor、`svg()` 骨架）。
 * 日后换成 `lucide-react` 时，本段整段删掉、import 改名即可。
 *
 * ## 命名与 lucide 对齐
 *
 * 名字尽量与 lucide 的组件名一致（`Play` / `Copy` / `Trash2` …），
 * 这样将来换库时可以批量替换；只在**语义与 lucide 原意不同**时加注释说明。
 * ══════════════════════════════════════════════════════════════════════ */

/** 运行 / 播放（lucide play）。 */
export function PlayIcon(props: IconProps): React.JSX.Element {
  return svg(<polygon points="6 3 20 12 6 21 6 3" />, props)
}

/** 「从这里跑」——双播放头（lucide fast-forward 去掉末条竖线的手工变体）。
 *
 * ⚠️ lucide 的 `fast-forward` 是**两个实心三角 + 一条竖线**（`<polygon>` + `<line x1="21">`）。
 * 我们只需要「两个三角」，所以只取两个 polygon —— 与 lucide 的差别仅此一处，
 * 因为那条竖线在 13px 下会糊成一团（它表示「到末尾」，「带上上游再跑」没有这个意思）。 */
export function FastForwardIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <polygon points="5 3 15 12 5 21 5 3" />
    <polygon points="14 3 24 12 14 21 14 3" />
  </>, props)
}

/** 跑下一步（lucide step-forward）。 */
export function StepForwardIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <line x1="6" x2="6" y1="4" y2="20" />
    <polygon points="10 4 20 12 10 20 10 4" />
  </>, props)
}

/** 跳过 / 全部恢复（lucide skip-forward）。 */
export function SkipForwardIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <polygon points="5 4 15 12 5 20 5 4" />
    <line x1="19" x2="19" y1="5" y2="19" />
  </>, props)
}

/** 复制（lucide copy）。 */
export function CopyIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </>, props)
}

/** 原地复制一份（lucide copy-plus）。
 *
 * 与 {@link CopyIcon} 的区别是右下角多一个 `+` —— 「复制一份新的出来」，
 * 正好对上「原地复制一份」（Ctrl+D）与「复制到剪贴板」（Ctrl+C）的差别。 */
export function CopyPlusIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <line x1="15" x2="15" y1="12" y2="18" />
    <line x1="12" x2="18" y1="15" y2="15" />
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
  </>, props)
}

/** 粘贴（lucide clipboard-paste）。 */
export function ClipboardPasteIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M15 2H9a1 1 0 0 0-1 1v2c0 .6.4 1 1 1h6c.6 0 1-.4 1-1V3c0-.6-.4-1-1-1Z" />
    <path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2" />
    <path d="M9 14h6" />
    <path d="M12 11v6" />
  </>, props)
}

/** 删除（lucide trash-2）。 */
export function TrashIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    <line x1="10" x2="10" y1="11" y2="17" />
    <line x1="14" x2="14" y1="11" y2="17" />
  </>, props)
}

/** 全选 / 选中这一批（lucide square-dashed）。
 *
 * ⚠️ 用 `square-dashed`（虚线方框）而不是 `check-square`：
 * 「全选」这个动作在画布上选中的是**一片区域里的节点**，虚线边框正好表达
 * 「框住的这些」；打勾那版会被读成「已完成的待办」。 */
export function SelectAllIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M5 3a2 2 0 0 0-2 2" />
    <path d="M19 3a2 2 0 0 1 2 2" />
    <path d="M21 19a2 2 0 0 1-2 2" />
    <path d="M5 21a2 2 0 0 1-2-2" />
    <path d="M9 3h1" />
    <path d="M9 21h1" />
    <path d="M14 3h1" />
    <path d="M14 21h1" />
    <path d="M3 9v1" />
    <path d="M21 9v1" />
    <path d="M3 14v1" />
    <path d="M21 14v1" />
  </>, props)
}

/** 分组（lucide group —— 一个虚线外框 + 两个实心小方块）。
 *
 * 与 {@link UngroupIcon} 的区别：这个是**外框包着东西**，那个是**外框断开**。
 * 两个必须能一眼分开，因为它们在同一个菜单里上下相邻。 */
export function GroupIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M3 7V5c0-1.1.9-2 2-2h2" />
    <path d="M17 3h2c1.1 0 2 .9 2 2v2" />
    <path d="M21 17v2c0 1.1-.9 2-2 2h-2" />
    <path d="M7 21H5c-1.1 0-2-.9-2-2v-2" />
    <rect width="7" height="5" x="7" y="7" rx="1" />
    <rect width="7" height="5" x="10" y="12" rx="1" />
  </>, props)
}

/** 取消分组（lucide ungroup —— 两个小方块被箭头分开，没有外框）。 */
export function UngroupIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <rect width="8" height="6" x="5" y="4" rx="1" />
    <rect width="8" height="6" x="11" y="14" rx="1" />
  </>, props)
}

/** 选中组内全部成员（lucide box-select）。
 *
 * 照 lucide v0.441.0 的 `box-select`：一个虚线大框 + 中间一个实心小框 ——
 * 「把框里的东西都选上」。 */
export function BoxSelectIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M5 3a2 2 0 0 0-2 2" />
    <path d="M19 3a2 2 0 0 1 2 2" />
    <path d="M21 19a2 2 0 0 1-2 2" />
    <path d="M5 21a2 2 0 0 1-2-2" />
    <path d="M9 3h1" />
    <path d="M9 21h1" />
    <path d="M14 3h1" />
    <path d="M14 21h1" />
    <path d="M3 9v1" />
    <path d="M21 9v1" />
    <path d="M3 14v1" />
    <path d="M21 14v1" />
    <rect width="6" height="6" x="9" y="9" rx="1" />
  </>, props)
}

/** 适应成员 / 适应画布（lucide maximize —— 四角箭头朝外）。
 *
 * 语义：「把视图 / 框撑到刚好装下里面的东西」。 */
export function MaximizeIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M8 3H5a2 2 0 0 0-2 2v3" />
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
    <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
  </>, props)
}

/** 一键收纳（lucide minimize —— 四角箭头朝内）。
 *
 * 与 {@link MaximizeIcon} 正好相反：「把框外的东西收进框里」。
 * 两个配对使用（收纳 / 适应）时轮廓是镜像的，用户不会认错。 */
export function MinimizeIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M8 3v3a2 2 0 0 1-2 2H3" />
    <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
    <path d="M3 16h3a2 2 0 0 1 2 2v3" />
    <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
  </>, props)
}

/** 加一个（lucide plus）。 */
export function PlusIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </>, props)
}

/** 关闭 / 删除这一块（lucide x）。 */
export function XIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </>, props)
}

/** 自动布局：从左到右（lucide arrow-right）。 */
export function ArrowRightIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </>, props)
}

/** 自动布局：从上到下（lucide arrow-down）。 */
export function ArrowDownIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M12 5v14" />
    <path d="m19 12-7 7-7-7" />
  </>, props)
}

/** 移出容器（lucide corner-up-right —— 一个朝右上的折角箭头）。 */
export function CornerUpRightIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <polyline points="15 14 20 9 15 4" />
    <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
  </>, props)
}

/** 放入容器（lucide corner-down-right —— 朝右下的折角箭头）。 */
export function CornerDownRightIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <polyline points="15 10 20 15 15 20" />
    <path d="M4 4v7a4 4 0 0 0 4 4h12" />
  </>, props)
}

/** 收起（lucide chevrons-down / 两个朝下的箭头）。
 *
 * 用于「收起所有节点设置」——「全部往下收」，与单个 chevron 的「收一个」区分开。 */
export function ChevronsDownIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="m7 6 5 5 5-5" />
    <path d="m7 13 5 5 5-5" />
  </>, props)
}

/** 收起侧栏（lucide chevron-left）。 */
export function ChevronLeftIcon(props: IconProps): React.JSX.Element {
  return svg(<path d="m15 18-6-6 6-6" />, props)
}

/** 展开侧栏（lucide chevron-right）。 */
export function ChevronRightIcon(props: IconProps): React.JSX.Element {
  return svg(<path d="m9 18 6-6-6-6" />, props)
}

/** 网格 / 布局开关（lucide layout-panel-left）。 */
export function LayoutPanelLeftIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <rect width="7" height="18" x="3" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="3" rx="1" />
    <rect width="7" height="7" x="14" y="14" rx="1" />
  </>, props)
}

/** 复制提示词（lucide clipboard-copy）。 */
export function ClipboardCopyIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <rect width="8" height="4" x="8" y="2" rx="1" ry="1" />
    <path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    <path d="M16 4h2a2 2 0 0 1 2 2v4" />
    <path d="M21 14H11" />
    <path d="m15 10-4 4 4 4" />
  </>, props)
}

/** 全屏查看（lucide expand —— 四角朝外的双折角）。
 *
 * 与 {@link MaximizeIcon} 的区别：`expand` 是**两道折角**（更像「全屏」），
 * `maximize` 是**四道单向折角**（更像「撑满」）。此处用前者表达「全屏看这张图」。 */
export function ExpandIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="m21 21-6-6m6 6v-4.8m0 4.8h-4.8" />
    <path d="M3 16.2V21m0 0h4.8M3 21l6-6" />
    <path d="M21 7.8V3m0 0h-4.8M21 3l-6 6" />
    <path d="M3 7.8V3m0 0h4.8M3 3l6 6" />
  </>, props)
}

/** 上传替换（lucide upload）。 */
export function UploadIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" x2="12" y1="3" y2="15" />
  </>, props)
}

/** 存进素材库（lucide library / 书架）。
 *
 * 照 lucide `library`：几条竖线 + 一个斜的矩形 —— 读作「收进库里」。 */
export function LibraryIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="m16 6 4 14" />
    <path d="M12 6v14" />
    <path d="M8 8v12" />
    <path d="M4 4v16" />
  </>, props)
}

/* ── 执行画布顶部工具条那一批（2026-10-26 同一轮统一）──────────────
 *
 * 那一排原来是字符（`▶` `✚` `⇩` `⇪` `◇` `⎘` `⎌` `↶` `↷` `⚙` `◱` `◑` `🔒`）。
 * `🔒` / `🔓` 尤其糟：那是**彩色 emoji**，在部分环境是方块色块，且不跟随主题色。
 */

/** 停止（lucide square）。运行中那个按钮用它替换 `■`。 */
export function StopIcon(props: IconProps): React.JSX.Element {
  return svg(<rect width="14" height="14" x="5" y="5" rx="1" />, props)
}

/** 新建（lucide file-plus）。替换 `✚` —— 「新开一份文件」比光一个加号准确。 */
export function FilePlusIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M9 15h6" />
    <path d="M12 18v-6" />
  </>, props)
}

/** 没有效果图（lucide file-text）。
 *
 * 用途：提示词卡片的封面位**无图时的占位**（用户 m03414 / m03555）。
 * 参考项目那里用的就是这个图标（`prompt-card.tsx` 的 `FileText`），
 * 而**不是**一个灰块 —— 灰块会被当成「图没加载出来」，图标说明「本来就没有」。
 */
export function FileTextIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M10 9H8" />
    <path d="M16 13H8" />
    <path d="M16 17H8" />
  </>, props)
}

/** 保存（lucide save）。替换 `⇩`。
 *
 * ⚠️ 原来那个 `⇩` 是「下载」的形状，而这里是「存进本机工作流目录」——
 * lucide 的 `save`（软盘）正好表达这个，也与「另存为」的区分更清楚。 */
export function SaveIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
    <path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7" />
    <path d="M7 3v4a1 1 0 0 0 1 1h7" />
  </>, props)
}

/** 另存为（lucide file-output）。替换 `⇪`。 */
export function FileOutputIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    <path d="M4 7V4a2 2 0 0 1 2-2 2 2 0 0 0-2 2" />
    <path d="M4.063 20.999a2 2 0 0 0 2 1L18 22a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2" />
    <path d="m5 11-3 3" />
    <path d="m5 17-3-3h10" />
  </>, props)
}

/** 打开（lucide folder-open）。替换 `◇` —— 「打开一份已存的」是文件夹语义。 */
export function FolderOpenIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
  </>, props)
}

/** 快照（lucide camera）。替换 `⎘`。 */
export function CameraIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
    <circle cx="12" cy="13" r="3" />
  </>, props)
}

/** 恢复（lucide history）。替换 `⎌`。 */
export function HistoryIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l4 2" />
  </>, props)
}

/** 撤销（lucide undo-2）。替换 `↶`。 */
export function UndoIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
  </>, props)
}

/** 重做（lucide redo-2）。替换 `↷`。 */
export function RedoIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="m15 14 5-5-5-5" />
    <path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5A5.5 5.5 0 0 0 9.5 20H13" />
  </>, props)
}

/** 设置（lucide settings）。替换 `⚙`。 */
export function SettingsIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </>, props)
}

/** 小地图开关（lucide map）。替换 `◱`。 */
export function MapIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z" />
    <path d="M15 5.764v15" />
    <path d="M9 3.236v15" />
  </>, props)
}

/** 图例（lucide palette）。替换 `◑`。 */
export function PaletteIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" />
    <circle cx="13.5" cy="6.5" r=".5" fill="currentColor" />
    <circle cx="17.5" cy="10.5" r=".5" fill="currentColor" />
    <circle cx="8.5" cy="7.5" r=".5" fill="currentColor" />
    <circle cx="6.5" cy="12.5" r=".5" fill="currentColor" />
  </>, props)
}

/** 已锁定（lucide lock）。替换 `🔒` —— 那个是**彩色 emoji**，不跟主题色。 */
export function LockIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </>, props)
}

/** 已解锁（lucide unlock）。替换 `🔓`。 */
export function UnlockIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 9.9-1" />
  </>, props)
}

/** 文本（lucide type）。加文本节点那一颗（票 54）。 */
export function TypeIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M12 4v16" />
    <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" />
    <path d="M9 20h6" />
  </>, props)
}

/** 视频（lucide video）。加视频节点那一颗（票 54）。 */
export function VideoIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />
    <rect x="2" y="6" width="14" height="12" rx="2" />
  </>, props)
}

/** 音频（lucide music）。加音频节点那一颗（票 54）。 */
export function MusicIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M9 18V5l12-2v13" />
    <circle cx="6" cy="18" r="3" />
    <circle cx="18" cy="16" r="3" />
  </>, props)
}

/** 亮色（lucide sun）。画布主题切换的两态之一（票 54）。 */
export function SunIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.93 4.93 1.41 1.41" />
    <path d="m17.66 17.66 1.41 1.41" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.34 17.66-1.41 1.41" />
    <path d="m19.07 4.93-1.41 1.41" />
  </>, props)
}

/** 暗色（lucide moon）。画布主题切换的两态之一（票 54）。 */
export function MoonIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </>, props)
}

/** 向上箭头（lucide chevron-up）。收起顶部的按钮用它（票 65）。
 *
 * ## 用户为什么点名「上下箭头」
 *
 * 2026-10-29 原话：「板块顶部面包屑左侧的收起按钮，不要外框（鼠标移动过去亮起即可）
 * 找一个图标不要用文字符号，不用太大。收起后的展开按钮也按照这个逻辑改，
 * 不要太大、不要太显眼。能点能收就行。」
 *
 * 「找一个图标不要用文字符号」针对的是原来那两颗 —— 它们写的是 `⌃` / `⌄`
 * 这样的**文字字符**，字形依赖系统字体，不同机器上大小与基线都不一样。
 * SVG 是矢量，给 14px 就是 14px。
 *
 * ## 方向约定（票面定的）
 *
 * | 状态 | 图标 | 点它会 |
 * |---|---|---|
 * | 展开态（顶部在） | **向上** `ChevronUpIcon` | 收起 |
 * | 收起态（顶部没了） | **向下** `ChevronDownIcon` | 展开 |
 *
 * 读法：箭头指的方向 = 「顶部那块东西会往哪去」。收起 → 往上走；
 * 展开 → 往下回来。 */
export function ChevronUpIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="m18 15-6-6-6 6" />
  </>, props)
}

/** 向下箭头（lucide chevron-down）。展开顶部的按钮用它（票 65）。方向约定见 `ChevronUpIcon`。 */
export function ChevronDownIcon(props: IconProps): React.JSX.Element {
  return svg(<>
    <path d="m6 9 6 6 6-6" />
  </>, props)
}

/* 工作台标识原来是这里的一个 lucide「拼图」图标（`PuzzleIcon`）。
 * 2026-10-11 用户提供了自己的工作台图形并要求替换 → 已移到
 * `brand-mark.tsx`（用蒙版 + currentColor 渲染，同样跟随主题）。
 * 这里不再保留 PuzzleIcon：保留会让人以为它还在用，实际已无任何引用。 */
