/** 节点体内的运行时数据显示面板（通用预览版）。
 *
 * 设计依据：docs/机制-设计依据.md §3；原始调研 docs/调研-节点运行时数据显示.md。
 *   - 没有现成 npm 组件，自己做通用预览版（抄 MIT 的 Langflow 结构：内联在节点卡片里）
 *   - 数据走 zustand store，不塞 React Flow 的 data（否则整节点重渲染）
 *   - 高度封顶 + 只留最近 50 行（否则节点无限长高、elkjs 布局崩）
 *   - 流式文本自动滚到底用 use-stick-to-bottom（MIT，零依赖，用户上滑不抢滚动条）
 *
 * 两档显示强度（2026-10-08 修正）：
 *   **活跃态**（queued / running）：展开显示完整日志 + 进度条 —— 用户此刻在看它跑。
 *   **完成态**（success / failed / missing）：**只显示一行摘要**；
 *       鼠标悬停或节点被选中时才展开完整日志。
 *   理由：原来所有终态都展开 108px 日志区，跑完后画布被一堆日志框塞满，
 *        而用户真正关心的是「当前在跑什么」。
 */
import { memo, useLayoutEffect, useState } from 'react'
import css from './node-card.module.css'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'
import type { NodeState } from '../../workflow/model.ts'
import { useNodeRun } from './run-store.ts'
import { pingExpandShift } from './expand-ping.ts'

/** 面板最大高度（px）——**兜底值**；实际用 CSS 变量（见下面 `PANEL_H_VAR`）。
 *
 * ⚠️ 原来这里是写死的 108，用户在设置里改不了（2026-10-13 的要求：
 * 「将输出显示窗口的高度也添加到画布设置中」）。
 * 现在设置面板写 CSS 变量 `--ewb-run-panel-h`，这里读它、读不到才用这个兜底。
 * 之所以走 CSS 变量而不是 React prop：**日志面板在节点卡片里、层级很深**，
 * 一路传 prop 会碰一大片组件；而它是个纯显示尺寸，用变量最省事且不引起重渲染。 */
const PANEL_MAX_H = 108

/** 输出面板高度的 CSS 变量名（设置面板写它，这里读它）。 */
export const PANEL_H_VAR = '--ewb-run-panel-h'

/** 输出面板高度的可调范围（px）与默认值（与上面的兜底一致）。 */
export const PANEL_H_MIN = 60
export const PANEL_H_MAX = 600
export const PANEL_H_DEFAULT = PANEL_MAX_H

/**
 * 复制文本到剪贴板。
 *
 * ⚠️ **失败静默**：剪贴板 API 在非 https / 无权限时会抛
 * （dsh 的界面是 `http://127.0.0.1:…`，localhost 通常被视为安全上下文，
 * 但用户也可能用局域网 IP 打开）。复制不了不该让节点报错。
 *
 * @param text - 要复制的文本。
 */
async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text) } catch { /* 剪贴板不可用就跳过 */ }
}

/** 活跃态：完整展开（用户此刻在看它跑）。 */
const ACTIVE_STATES: readonly NodeState[] = ['queued', 'running']

/** 终态：默认只显示一行摘要，悬停/选中才展开。 */
const DONE_STATES: readonly NodeState[] = ['success', 'failed', 'missing']

/** 自动滚到底的内容容器（StickToBottom 的 context 消费方）。
 *
 * ⚠️ `nowheel` 是 React Flow 认的约定类名（默认 `noWheelClassName`）：
 * 滚轮落在这里面时不缩放画布，改由本容器自己滚 —— 否则日志区有滚动条却滚不动。 */
function LogBody(props: { lines: readonly string[], stream?: string }) {
  const { scrollRef, contentRef } = useStickToBottomContext()
  return (
    <div ref={scrollRef} className={css.runScroll + ' nowheel'}>
      <div ref={contentRef} className={css.runLines}>
        {props.lines.map((l, i) => (
          <div key={i} className={css.runLine}>{l}</div>
        ))}
        {props.stream !== undefined && props.stream !== '' && (
          <div className={css.runLine + ' ' + css.runStream}>{props.stream}</div>
        )}
      </div>
    </div>
  )
}

/**
 * 节点体内的运行时数据面板。
 * @param props.state - 节点当前状态（不在活跃/终态里则不渲染）。
 * @param props.nodeId - 节点实例 id（用于订阅 store）。
 * @param props.selected - 节点是否被选中（终态时选中即展开）。
 * @returns 面板元素，或 null。
 */
export const NodeRunPanel = memo(function NodeRunPanel(props: { state: NodeState, nodeId: string, selected?: boolean }) {
  const run = useNodeRun(props.nodeId)
  /** 终态下悬停展开（鼠标移入才展开，移出收起）。 */
  const [hover, setHover] = useState(false)
  /** 「已复制」的短反馈（1.2 秒后自动还原）。 */
  const [copied, setCopied] = useState(false)

  const active = ACTIVE_STATES.includes(props.state)
  const done = DONE_STATES.includes(props.state)

  const hasProgress = run.total !== undefined && run.total > 0
  const empty = run.lines.length === 0 && (run.stream ?? '') === '' && !hasProgress
  /* 终态默认收起，除非悬停或选中 */
  const showFull = active || hover || props.selected === true

  /**
   * 面板自己报到：我的高度可能变了，请画布重算让位（用户 m00631 要求
   * 「输出内容那个弹出的时候，也自动偏移一下」）。
   *
   * ## 为什么必须由面板自己说，不能等节点卡片
   *
   * 面板的数据来自 zustand 的 `run-store`、**不进 React Flow 的 data**
   * （见文件头：塞进 data 会让整个节点重渲染）。所以「节点卡片」与「日志内容」
   * 是两条互不相干的渲染路径 —— 面板长高时节点卡片那一层**未必重渲染**，
   * 它的 layout effect 就不跑，让位会漏。
   *
   * ## 为什么是 layout effect
   *
   * 与节点卡片同一个理由：要在「DOM 已更新、浏览器还没画这一帧」量到最终高度，
   * 并把移动赶在同一帧画出来（否则用户会看到「先长高、下一帧别人再让开」那一跳）。
   *
   * ⚠️ **钩子不能放在早退之后**（`if (!active && !done) return null`）——
   * 同一个组件在「有面板 / 没面板」之间切换时钩子数量会变，React 直接报错。
   * 所以它排在上面，由下面的早退决定要不要渲染。
   *
   * `showFull` 在依赖里：终态下**悬停展开**也是高度变化
   * （用户 m00794 原话：「也让，只要展开就让」）。
   */
  useLayoutEffect(() => {
    /* 面板不存在（state 不在两档里）就没什么可报的。 */
    if (!active && !done) return
    pingExpandShift(props.nodeId)
  }, [props.nodeId, props.state, active, done, showFull, run.lines.length, run.total, run.stream])

  if (!active && !done) return null

  // 终态收起时：只显示最后一行作为摘要（没有就只显示状态词）
  const lastLine = run.lines.length > 0 ? run.lines[run.lines.length - 1] : ''

  return (
    <div
      className={css.runPanel}
      /* 画布靠这个属性量面板高度（`measureRunPanels` 在节点卡片里找它）——
       * 让位时要把它从节点的实测高度里扣掉。 */
      data-ewb-run-panel=''
      data-state={props.state}
      data-collapsed={!showFull}
      style={{ maxHeight: showFull ? 'var(' + PANEL_H_VAR + ', ' + String(PANEL_MAX_H) + 'px)' : undefined }}
      onPointerEnter={() => { setHover(true) }}
      onPointerLeave={() => { setHover(false) }}
    >
      {showFull ? (
        <>
          {/* 复制按钮（用户 2026-10-13：「给输出增加一个复制按钮，复制输出内容」）。
           *
           * ⚠️ 三点讲究：
           *   ① `stopPropagation` —— 它在节点卡片里，不拦会让点击穿透到节点（选中/展开）
           *   ② `nodrag` —— React Flow 认的约定类名，不拦会影响节点拖动
           *   ③ 复制的是**已经看到的全部内容**（日志行 + 流式尾巴），不是只有滚动可见的那几行 */}
          {!(empty && !hasProgress) && (
            <div className={css.runCopyRow}>
              <button
                type="button"
                className={css.runCopy + ' nodrag'}
                title="复制这段输出（全部行，不只是看得见的部分）"
                onClick={(e) => {
                  e.stopPropagation()
                  const text = run.lines.join('\n') + ((run.stream ?? '') === '' ? '' : '\n' + String(run.stream))
                  void copyText(text)
                  setCopied(true)
                  window.setTimeout(() => { setCopied(false) }, 1200)
                }}
              >{copied ? '已复制' : '复制'}</button>
            </div>
          )}
          {hasProgress && (
            <div className={css.runProgressRow}>
              <div className={css.runProgressTrack}>
                <div
                  className={css.runProgressFill}
                  style={{ width: Math.min(100, Math.round(((run.done ?? 0) / (run.total ?? 1)) * 100)) + '%' }}
                />
              </div>
              <span className={css.runProgressText}>{run.done ?? 0}/{run.total}</span>
            </div>
          )}
          {empty
            ? <div className={css.runEmpty}>(暂无输出)</div>
            : (
              <StickToBottom className={css.runStick} resize='smooth' initial='smooth'>
                <LogBody lines={run.lines} stream={run.stream} />
              </StickToBottom>
            )}
        </>
      ) : (
        /* 收起态：一行摘要（日志最后一行，或提示可展开） */
        <div className={css.runSummary} title="悬停或用鼠标移入可展开完整日志">
          <span className={css.runSummaryMark}>›</span>
          <span className={css.runSummaryText}>{lastLine !== '' ? lastLine : '（无输出）'}</span>
          {run.lines.length > 1 && <span className={css.runSummaryCount}>{run.lines.length} 行</span>}
        </div>
      )}
    </div>
  )
})
