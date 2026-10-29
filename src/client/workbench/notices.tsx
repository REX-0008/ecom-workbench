/** 画布上的轻量提示条（保存/导入/加载的结果反馈）。
 *
 * 为什么不弹 alert：alert 会打断操作，而且一次失败要用户点一下才能继续。
 * 为什么不静默：这正是本次要修的病根——「用户以为成功了，实际什么都没发生」。
 *
 * 三种语气：ok（成功，绿）/ warn（提醒，黄）/ error（失败，红）。
 * 成功 3 秒自动消失；失败**不自动消失**（要让用户看到原因），带手动关闭。
 */
/* ⚠️ **样式来自 `workflow-canvas.module.css`，那是历史原因，不代表本组件属于执行画布。**
 *
 * 2026-10-29（票 62）：内容画布也用这个组件了。它**没有一处**引用执行画布的
 * 业务（不碰 nodes / edges / 运行状态），只是当年跟着执行画布一起长出来的、
 * 样式文件就落在了那边。
 *
 * 为什么不把 `notice*` 那几个类搬过来：`workflow-canvas.module.css` 不在
 * 票 62 的可改路径里，而且执行画布还在用它们 —— 搬 = 两边各留一份 = 必然漂。
 * 等到哪天这两份 CSS 合并，再把它们归到合适的位置。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import css from './workflow-canvas.module.css'

/** 提示条语气。 */
export type NoticeTone = 'ok' | 'warn' | 'error'

/** 一条提示。 */
export interface Notice {
  /** 自增 id（同一条内容重复出现也能各自计时）。 */
  id: number
  /** 显示文字。 */
  text: string
  /** 语气。 */
  tone: NoticeTone
}

/**
 * 提示条状态管理。
 *
 * @returns 当前提示、发提示的函数、关提示的函数。
 */
export function useNotices(): {
  notices: Notice[]
  notify: (text: string, tone?: NoticeTone) => void
  dismiss: (id: number) => void
} {
  const [notices, setNotices] = useState<Notice[]>([])
  const seq = useRef(0)
  const timers = useRef<number[]>([])

  /** 关掉一条。 */
  const dismiss = useCallback((id: number): void => {
    setNotices(list => list.filter(n => n.id !== id))
  }, [])

  /**
   * 发一条提示。
   * @param text - 显示文字。
   * @param tone - 语气（默认 ok）。
   */
  const notify = useCallback((text: string, tone: NoticeTone = 'ok'): void => {
    seq.current += 1
    const id = seq.current
    setNotices(list => [...list, { id, text, tone }])
    /* 成功/提醒自动消失；失败留着，等用户看完手动关 */
    if (tone !== 'error') {
      const t = window.setTimeout(() => { dismiss(id) }, 3000)
      timers.current.push(t)
    }
  }, [dismiss])

  /* 卸载时清掉计时器，避免「组件没了还去 setState」 */
  useEffect(() => () => { timers.current.forEach(t => { window.clearTimeout(t) }) }, [])

  return { notices, notify, dismiss }
}

/**
 * 提示条容器（固定在画布右上角下方）。
 *
 * @param props.notices - 当前提示。
 * @param props.onDismiss - 关掉一条。
 * @returns 容器元素，或 null。
 */
export function NoticeBar(props: { notices: readonly Notice[], onDismiss: (id: number) => void }) {
  if (props.notices.length === 0) return null
  return (
    <div className={css.noticeWrap}>
      {props.notices.map(n => (
        <div key={n.id} className={css.notice + ' ' + css['notice_' + n.tone]}>
          <span className={css.noticeMark}>{n.tone === 'ok' ? '✓' : n.tone === 'warn' ? '!' : '✕'}</span>
          <span className={css.noticeText}>{n.text}</span>
          <button type="button" className={css.noticeClose} title="关闭" onClick={() => { props.onDismiss(n.id) }}>×</button>
        </div>
      ))}
    </div>
  )
}
