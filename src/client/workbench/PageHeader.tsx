/** 页面标题栏 —— 原样搬运 FounderOS-DEMO 的 components/PageHeader.tsx（2026-10-08）。
 *
 * 它的排版规则（原样保留，这是「像不像」的核心）：
 *   - eyebrow：`mb-2 font-mono text-ewb-caption uppercase tracking-[0.32em]`，前缀 `//` 由 CSS 的 ::before 加
 *   - 标题：`text-ewb-heading font-semibold uppercase leading-[1.2] tracking-[0.06em]`
 *   - 整块与下方内容的间距：它用 `mb-6`（24px）；我们收到 `mb-4`（16px）
 *   - 右上角可选放一个控件（right 槽）
 *
 * 它注释里的一条设计决定也照抄：**标题下不写说明文字**——
 * 「操作的人是自己搭的，他本来就知道这是干什么的」。
 */

/** PageHeader 入参。 */
export interface PageHeaderProps {
  /** 标题上方的眉标（小号大写等宽）。 */
  eyebrow?: string
  /** 页面标题（会转大写显示）。 */
  title: string
  /** 右上角的可选控件。 */
  right?: React.ReactNode
}

/**
 * 页面标题栏。
 * @param props - eyebrow / title / right。
 * @returns 标题栏元素。
 */
export function PageHeader({ eyebrow, title, right }: PageHeaderProps): React.JSX.Element {
  return (
    <header /* 用户要求「将板块标题的下方的间隔缩小点」→ mb-6(24px) → mb-4(16px)。
 * 参考对象是 24px，但它标题下**还有一整排数据**；我们下面是 tab 条，
 * 间距紧凑一点更合适。 */
className="animate-ewb-rise mb-4 flex items-end justify-between gap-4">
      <div className="min-w-0 shrink-0">
        {/* 眉标已去掉（2026-10-08）。
         * 依据：`frontend-design` 把「每个标题上方一条加宽字距的全大写眉标」列为
         * AI 生成的通病第 5 条——它是**默认值而不是选择**。
         * 且我们顶部已有面包屑（电商工作台 / 板块名），此处信息重复。
         *
         * eyebrow 参数保留：调用方仍可传，用于将来真有副标题需求的页面。 */}
        {/* 标题从 24px 收到 **16px**（用户：「顶部文字过大……可考虑缩小到常规字号」）。
         *
         * 为什么这**不违背**层级：§2.2 说「字号不单独扛层级，先动字重与颜色」。
         * 我们还是 T1（`font-semibold` + `label-primary`），只是不再用一个
         * 24px 的大字去占据整个视觉重心——它是**一颗标识**，不是一屏的主角。
         *
         * 参照：FounderOS 用 25px 是因为它是 BI 大屏，标题下面是一整屏数据；
         * 我们是执行工作台，标题下面是 tab 与内容，标题不必那么大。 */}
        <h1 className="text-ewb-title font-semibold uppercase leading-[1.2] tracking-[0.06em] text-[var(--dsw-alias-label-primary)]">
          {title}
        </h1>
      </div>
      {right !== undefined && (
        <div className="flex shrink-0 items-center gap-2">{right}</div>
      )}
    </header>
  )
}

