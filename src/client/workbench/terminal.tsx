/**
 * 列表页共享原语 —— 原样搬运 FounderOS-DEMO 的 components/terminal.tsx（2026-10-08）。
 *
 * 搬的是「形态与尺寸」，颜色类映射到 dsh 的语义 token：
 *   os-border → --dsw-alias-border-l2 ｜ os-surface → bg-layer-2
 *   os-text → label-primary ｜ os-muted → label-secondary ｜ os-dim → label-tertiary
 *   os-accent / --accent-soft / --accent-line → --ewb-accent / -soft / -line（已在 tailwind.css 定义）
 *   os-ok / os-warn / os-err → --dsw-alias-state-success-primary / -warning / -danger
 *
 * 它注释里的一条设计原则也照搬：**服务端组件友好（无状态、无回调）**，
 * 这样这些原语可以在任何地方用，不牵扯渲染时机。
 */

/** 状态点可能的四种状态。 */
export type DotState = 'ok' | 'warn' | 'err' | 'off'

/** 业务状态词 → 状态点状态的映射（照它的 DOT_FOR）。 */
const DOT_FOR: Record<string, DotState> = {
  connected: 'ok',
  active: 'ok',
  ok: 'ok',
  success: 'ok',
  running: 'ok',
  available: 'warn',
  warn: 'warn',
  idle: 'warn',
  queued: 'warn',
  error: 'err',
  fail: 'err',
  failed: 'err',
  not_configured: 'off',
  planned: 'off',
  off: 'off',
}

/**
 * 业务状态词 → 状态点状态。
 * @param state - 业务状态词。
 * @returns 状态点的状态（认不出归 off）。
 */
export function dotState(state: string): DotState {
  return DOT_FOR[state] ?? 'off'
}

/**
 * 状态点（6×6 圆点；ok 且要脉冲时是阶梯式闪烁，照 FounderOS 的 .dot）。
 * @param props.state - 业务状态词。
 * @param props.pulse - 是否闪烁（只在 ok 时生效）。
 * @returns 状态点元素。
 */
export function Dot({ state, pulse = false }: { state: string, pulse?: boolean }): React.JSX.Element {
  const cls = dotState(state)
  return <span className={`dot ${cls}${pulse && cls === 'ok' ? ' pulse' : ''}`} />
}

/** 徽标色调。 */
export type BadgeTone = 'default' | 'accent' | 'ok' | 'warn' | 'err'

/** 色调 → 类（照它的 BADGE_TONE，颜色换成 dsh token）。 */
const BADGE_TONE: Record<BadgeTone, string> = {
  default: 'border-[var(--dsw-alias-border-l3)] text-[var(--dsw-alias-label-secondary)]',
  accent: 'border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)] text-[var(--ewb-accent)]',
  ok: 'border-[color-mix(in_oklab,var(--dsw-alias-state-success-primary)_35%,transparent)] bg-[color-mix(in_oklab,var(--dsw-alias-state-success-primary)_9%,transparent)] text-[var(--dsw-alias-state-success-primary)]',
  warn: 'border-[color-mix(in_oklab,var(--dsw-alias-state-warn-primary)_35%,transparent)] bg-[color-mix(in_oklab,var(--dsw-alias-state-warn-primary)_9%,transparent)] text-[var(--dsw-alias-state-warn-primary)]',
  err: 'border-[color-mix(in_oklab,var(--dsw-alias-state-error-primary)_35%,transparent)] bg-[color-mix(in_oklab,var(--dsw-alias-state-error-primary)_9%,transparent)] text-[var(--dsw-alias-state-error-primary)]',
}

/**
 * 胶囊徽标（照它：rounded-full + 9.5px 等宽大写 + 字距 0.14em）。
 * @param props.tone - 色调。
 * @param props.ghost - 是否虚线边框（表示「还没定」）。
 * @param props.children - 内容。
 * @returns 徽标元素。
 */
export function Badge({ tone = 'default', ghost = false, children }: {
  tone?: BadgeTone
  ghost?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-1',
        'font-mono text-ewb-caption uppercase tracking-[0.14em]',
        BADGE_TONE[tone],
        ghost ? 'border-dashed' : '',
      ].join(' ')}
    >
      {children}
    </span>
  )
}

/**
 * 分节标签（照它：10px 等宽粗体大写 + 字距 0.26em，可选计数与后方一条淡线）。
 * @param props.children - 标签文字。
 * @param props.count - 可选计数。
 * @param props.rule - 是否在后方画一条延伸的淡线。
 * @returns 标签元素。
 */
export function Label({ children, count, rule = false }: {
  children: React.ReactNode
  count?: string | number
  rule?: boolean
}): React.JSX.Element {
  return (
    <div
      data-part="label"
      /* T2（支撑信息）→ 字重 400。分节标签是「路牌」不是「标题」，
       * 用等宽 + 宽字距已经足够区分，再加粗就与 T1 抢注意力了（§2.2）。 */
      className="flex items-center gap-2 font-mono text-ewb-label uppercase tracking-[0.26em] text-[var(--dsw-alias-label-tertiary)]"
    >
      <span className="whitespace-nowrap">{children}</span>
      {count !== undefined && <span className="text-[var(--dsw-alias-label-secondary)]">{count}</span>}
      {rule && <span className="h-px flex-1 bg-[var(--dsw-alias-border-l2)]" />}
    </div>
  )
}

/**
 * 分节头（标签 + 右侧控件，带入场动画）。
 * @param props.label - 标签文字。
 * @param props.count - 可选计数。
 * @param props.right - 右侧控件。
 * @returns 分节头元素。
 */
export function SectionHead({ label, count, right }: {
  label: string
  count?: string | number
  right?: React.ReactNode
}): React.JSX.Element {
  return (
    /* 去掉入场动画（2026-10-08）。
     * 依据 `frontend-design`：「每块淡入上滑是通用默认，读起来就是 AI 生成的；
     * **一个编排好的瞬间**胜过零散效果。」
     * 全页只留 PageHeader 那一次入场，其余静态出现。 */
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <div className="min-w-0 flex-1">
        <Label count={count} rule>{label}</Label>
      </div>
      {right}
    </div>
  )
}
