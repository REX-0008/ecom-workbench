/** 配置页 · 偏好（票 05，用户 m00109）。
 *
 * ## 这一块做什么、不做什么
 *
 * | 项 | 做了吗 | 为什么 |
 * |---|---|---|
 * | 一次生成几张 | **做** | 后端链路通（`count` 从 `src/index.ts:1848` 一路到 `batch_size`） |
 * | 音频音色 / 格式 / 语速 | **不做开关** | 后端没有这三个字段（见 `workbench-prefs.ts` 的 `AUDIO_EXTRAS_SUPPORTED`） |
 * | 系统提示词 | 只做存储与界面 | 引擎侧有 `command.system`，但全局值到不了节点参数表 |
 *
 * ## 「不做」的两项为什么还要占位置
 *
 * 直接不画，用户会以为参考项目有、我们漏了 —— 然后一次一次来问。
 * 画出来、写清为什么没有、写清要接上得改哪里，才是「如实」。
 *
 * ⚠️ 这两块**不许做成灰掉的输入框**：灰框会被当成「权限不够」或者「加载中」。
 * 用一段说明文字，不用控件。
 *
 * ## 存哪
 *
 * `localStorage`（键 `ewb.workbenchPrefs`），不进任何存档 ——
 * 与画布设置同一套做法与理由（那是「这台机器的习惯」，不是「这份数据的属性」）。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  COUNT_MAX, COUNT_MIN, DEFAULT_PREFS, SYSTEM_PROMPT_NOTE, SYSTEM_PROMPT_WIRED,
  AUDIO_EXTRAS_NOTE, AUDIO_EXTRAS_SUPPORTED,
  readPrefs, writePrefs, patchPrefs,
  type WorkbenchPrefs,
} from './lib/workbench-prefs.ts'

/** 偏好的入参。 */
export interface PreferencesSettingsProps {
  /** 这一格是不是正显示着（照别的设置块的做法，只在显示时读一次盘）。 */
  active: boolean
}

/** 小标题的统一样式（与存储目录那块同一个尺度）。 */
const HEAD = 'font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]'

/**
 * 偏好设置。
 * @param props - 是否可见。
 * @returns 界面。
 */
export function PreferencesSettings({ active }: PreferencesSettingsProps): React.JSX.Element {
  const [prefs, setPrefs] = useState<WorkbenchPrefs>(DEFAULT_PREFS)
  /** 一次生成几张的输入框草稿（**字符串**：允许中途是空串，否则没法删干净重打）。 */
  const [countDraft, setCountDraft] = useState('1')
  const [saved, setSaved] = useState('')

  /* 只在显示时读一次 —— 与 `StorageSettings` 同一个做法。
   * 不放进 useState 初值：那样组件没显示也会读一次 localStorage，
   * 而它可能在 SSR / 测试环境里不存在。 */
  useEffect(() => {
    if (!active) return
    const p = readPrefs()
    setPrefs(p)
    setCountDraft(String(p.count))
  }, [active])

  /** 改一项并立刻存（偏好类设置没有「保存」按钮 —— 改了就生效）。 */
  const change = useCallback((patch: Partial<WorkbenchPrefs>): void => {
    setPrefs((cur) => {
      const next = patchPrefs(cur, patch)
      writePrefs(next)
      return next
    })
    setSaved('已保存')
  }, [])

  /* 「已保存」几秒后自己消失（与提示词库复制提示同一个做法）。 */
  useEffect(() => {
    if (saved === '') return undefined
    const t = window.setTimeout(() => { setSaved('') }, 2000)
    return () => { window.clearTimeout(t) }
  }, [saved])

  /**
   * 张数输入框失焦时定型。
   *
   * 为什么不在每次按键就夹：用户想从 `1` 改成 `3`，可能在中间按删除 ——
   * 那时是空串，立刻夹回 `1` 会让输入框「打不动」。所以：
   * 打字期间只更新草稿，失焦才夹进 1–4 并存盘。
   */
  const commitCount = useCallback((raw: string): void => {
    const n = Number(raw.trim())
    const fixed = Number.isFinite(n) && raw.trim() !== ''
      ? Math.max(COUNT_MIN, Math.min(COUNT_MAX, Math.round(n)))
      : prefs.count
    setCountDraft(String(fixed))
    if (fixed !== prefs.count) change({ count: fixed })
  }, [prefs.count, change])

  const field = 'w-20 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none'
  const note = 'rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]'

  return (
    <div className="flex flex-col gap-3" data-ewb-preferences="">
      {/* ── ① 一次生成几张 ── */}
      <section className="flex flex-col gap-2" data-ewb-prefs-section="count">
        <div className="flex items-center gap-3">
          <span className={HEAD}>一次生成几张</span>
          <span className="flex-1" />
          {saved === ''
            ? null
            : <span data-ewb-prefs-saved="" className="font-mono text-ewb-caption text-[#4ec9b0]">{saved}</span>}
        </div>
        <div className="flex items-center gap-2">
          <input
            data-ewb-prefs-count=""
            className={field}
            type="number"
            min={COUNT_MIN}
            max={COUNT_MAX}
            value={countDraft}
            onChange={(e) => { setCountDraft(e.target.value) }}
            onBlur={(e) => { commitCount(e.target.value) }}
          />
          <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
            张（{String(COUNT_MIN)}–{String(COUNT_MAX)}；打开生图 / 视频 / 音频工作台时按这个数预填）
          </span>
        </div>
        <div className={note} data-ewb-prefs-count-note="">
          只决定工作台打开时预填多少张。已经填好却没提交的那一格里写的数不会被覆盖。
        </div>
      </section>

      {/* ── ② 音频三项：不做开关，如实说明 ── */}
      <section className="flex flex-col gap-2" data-ewb-prefs-section="audio">
        <div className="flex items-center gap-3">
          <span className={HEAD}>音频默认</span>
        </div>
        {AUDIO_EXTRAS_SUPPORTED
          ? null
          : (
            <div className={note} data-ewb-prefs-audio-note="">
              {AUDIO_EXTRAS_NOTE}
            </div>
          )}
      </section>

      {/* ── ③ 系统提示词 ── */}
      <section className="flex flex-col gap-2" data-ewb-prefs-section="system">
        <div className="flex items-center gap-3">
          <span className={HEAD}>系统提示词</span>
        </div>
        <textarea
          data-ewb-prefs-system=""
          className="min-h-[80px] w-full resize-y rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 font-mono text-ewb-meta leading-relaxed text-[var(--dsw-alias-label-primary)] outline-none"
          value={prefs.systemPrompt}
          placeholder="一段给模型的设定（留空表示不发系统提示词）"
          onChange={(e) => { change({ systemPrompt: e.target.value }) }}
        />
        {/* ★ 这句不许删：这一项现在**存了但不生效**。不说的话，用户配好、
         * 生成几次发现没效果，会去查模型、查提示词、查渠道 —— 永远查不到这里。 */}
        {SYSTEM_PROMPT_WIRED
          ? null
          : (
            <div
              data-ewb-prefs-system-note=""
              className="rounded-card border border-dashed border-[#f0b42955] px-3 py-2 font-mono text-ewb-caption leading-relaxed text-[#f0b429]"
            >
              {SYSTEM_PROMPT_NOTE}
            </div>
          )}
      </section>
    </div>
  )
}
