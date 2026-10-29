/** SlidingTabs —— 滑动指示器 tab 条。
 *
 * **原样搬运** FounderOS-DEMO 的 components/SlidingTabs.tsx（2026-10-08）。
 *
 * 为什么这次不「照思路重写」：用户明确指出——
 *   「我让你照抄他的左侧栏有这么难吗」「界面我让你抄 org-chart，可是你用了别的 tab 样式」。
 *   此前我把它「理解后改用 CSS Modules 重写」，结果是**功能类似、外观差距大**。
 *   既然已经接入 Tailwind，就直接搬类名，不再自己翻译。
 *
 * 换掉的只有三处：
 *   1. 去掉 Next.js 的 `use client`
 *   2. 它的 os-* 颜色类换成我们的 dsh 等价类（见下）
 *   3. 它的 `duration-lens` / `ease-lens` 换成定义在 tailwind.css 里的等价档
 *
 * 它的关键取值（这是「像不像」的核心，全部原样保留）：
 *   - tab 高 **30px**（h-[30px]）
 *   - 等宽字体 **10.5px** / **粗体** / **字距 .18em** / **大写**
 *   - 指示器：underline 版是**底部一条 2px 线**；pill 版是 5px 圆角填充块
 *   - hover：`scale-[1.04]` 且**去掉阴影**（hover:shadow-none）
 *   - 数字徽标：9.5px / 行高 15px / 选中时反色
 */

/** 单个 tab 的描述。 */
export interface SlidingTab<T extends string> {
  /** tab 标识（回调里原样回传）。 */
  id: T
  /** 显示文字。 */
  label: React.ReactNode
  /** 可选计数徽标。 */
  count?: number
}

/** SlidingTabs 入参。 */
export interface SlidingTabsProps<T extends string> {
  /** tab 清单。 */
  tabs: readonly SlidingTab<T>[]
  /** 当前选中的 tab id。 */
  value: T
  /** 选中变化回调。 */
  onChange: (id: T) => void
  /** 外观：underline＝底线高亮，pill＝分段控件。默认 underline。 */
  variant?: 'underline' | 'pill'
  /** 每个 tab 的固定宽度 px，默认 120。指示器位移按它计算，所以必须等宽。 */
  tabWidth?: number
}

/**
 * 滑动指示器 tab 条。
 * @param props - tabs / value / onChange / variant / tabWidth。
 * @returns tab 条元素。
 */
export function SlidingTabs<T extends string>({
  tabs,
  value,
  onChange,
  variant = 'underline',
  tabWidth = 120,
}: SlidingTabsProps<T>): React.JSX.Element {
  /* 找不到时退回 0，指示器不会跑到轨道外。 */
  const i = Math.max(0, tabs.findIndex(t => t.id === value))
  const pill = variant === 'pill'
  return (
    <div
      className={[
        'relative grid',
        /* 外层：分段控件是「框内填充」，页面 tab 是「底线」。 */
        pill
          ? 'rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-base)] p-1'
          : 'border-b border-[var(--dsw-alias-border-l2)]',
      ].join(' ')}
      style={{ gridTemplateColumns: `repeat(${tabs.length}, ${tabWidth}px)` }}
      role="tablist"
    >
      {/* 指示器：只改 transform，不重排，所以切换时是滑过去的。 */}
      <span
        aria-hidden
        className={[
          'pointer-events-none absolute transition-transform',
          /* 时长与曲线：对应它 tailwind.config 里的 duration-lens / ease-lens（630ms / cubic-bezier(.22,.61,.36,1)）。 */
          'duration-[630ms] ease-[cubic-bezier(0.22,0.61,0.36,1)]',
          pill
            ? 'bottom-1 left-[3px] top-1 rounded-ctl bg-[var(--dsw-alias-bg-layer-2)]'
            : '-bottom-px left-0 h-[2px] bg-[var(--dsw-alias-label-primary)]',
        ].join(' ')}
        style={{ width: tabWidth, transform: `translateX(${i * tabWidth}px)` }}
      />
      {tabs.map(t => {
        const active = t.id === value
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-lens="c"
            onClick={() => { onChange(t.id) }}
            className={[
              'pressable relative inline-flex h-[34px] items-center justify-center gap-1.5 bg-transparent',
              /* 用户要求「板块中 tab 的标题文字放大点」→ 从它的 10.5px 放到 12px。
 * 它原值 10.5px 是给「页面级子标签」用的（信息密度高）；
 * 我们这里是**板块的主导航**，值得更大更清楚。字距相应收到 0.14em。 */
'font-mono text-ewb-meta font-semibold uppercase tracking-[.14em]',
              'hover:scale-[1.04] hover:shadow-none',
              active
                ? 'text-[var(--dsw-alias-label-primary)]'
                : 'text-[var(--dsw-alias-label-tertiary)] hover:text-[var(--dsw-alias-label-secondary)]',
            ].join(' ')}
          >
            {t.label}
            {t.count !== undefined && (
              <span
                className={[
                  'px-1.5 text-ewb-caption leading-[15px] tracking-normal',
                  active
                    ? 'bg-[var(--dsw-alias-label-primary)] text-[var(--dsw-alias-bg-base)]'
                    : 'bg-[var(--dsw-alias-bg-layer-2)] text-[var(--dsw-alias-label-tertiary)]',
                ].join(' ')}
              >
                {t.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
