/** 点「执行」时填工作流输入的表单（用户 m02875：「补。」）。
 *
 * ## 它替代了什么
 *
 * 原来这里是一个个 `window.prompt` 弹出来的（`WorkflowList.tsx` 的 `startRun`）。
 * `prompt` 的问题不是丑，是**做不了该做的事**：
 *   · 一次只能问一项，两三项就要点两三次；
 *   · 看不出「一共要填几项、还差哪几项」；
 *   · 没填必填项也没法当场拦住（只能先跑起来、等执行层报缺参数）；
 *   · 取消一个框 = 整次不跑，用户想改前面填的没门。
 *
 * ## 为什么是**内联块**而不是弹窗
 *
 * 本插件没有弹窗组件，也不该为这一件事引入一个 —— 列表页上已经有
 * 「流程级运行面板」（`FlowRunPanel`）这个内联块，两者形态一致：
 * 点了执行 → 上方长出一块 → 填完/关掉就收回去。用户不用学第二套东西。
 *
 * ## 不做什么（克制）
 *
 *   · **不猜控件类型**：开始节点声明的字段只有「名字 / 说明 / 必填 / 默认值」
 *     四项，没有类型信息 —— 所以一律普通文本框，不按名字猜「这是个日期」。
 *     要日期控件就得先在节点那边声明类型，那是另一件事。
 *   · **不做「保存这次填的值」**：没有这个需求，而且会把「默认值」的语义搞乱。
 */
import { useState } from 'react'
import type { InputField } from '../../workflow/io-fields.ts'

/**
 * 一份要填的输入。
 *
 * @param props.name - 要跑的工作流名（显示在标题上）。
 * @param props.fields - 开始节点声明的输入项。
 * @param props.onSubmit - 填好了（值已齐，必填都在）。
 * @param props.onCancel - 不跑了。
 * @returns 表单元素。
 */
export function RunInputForm(props: {
  name: string
  fields: readonly InputField[]
  onSubmit: (inputs: Record<string, unknown>) => void
  onCancel: () => void
}) {
  /** 已填的值（初值 = 各字段的默认值；没默认值的给空串）。 */
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const f of props.fields) init[f.name] = f.default ?? ''
    return init
  })
  /** 提交时才发现的问题（必填没填）—— 只在按下「开始执行」之后提示，
   *  不在打字过程中一直红着（那是 AI 生成表单的通病）。 */
  const [problem, setProblem] = useState('')

  const submit = (): void => {
    const missing = props.fields.filter(f => f.required && (values[f.name] ?? '').trim() === '')
    if (missing.length > 0) {
      setProblem('这几项必填，还没填：' + missing.map(f => f.name).join('、'))
      return
    }
    setProblem('')
    const out: Record<string, unknown> = {}
    for (const f of props.fields) out[f.name] = values[f.name] ?? ''
    props.onSubmit(out)
  }

  return (
    <form
      data-ewb-run-input=""
      onSubmit={e => { e.preventDefault(); submit() }}
      className="mb-3 rounded-card border border-[var(--ewb-accent-line)] bg-[var(--dsw-alias-bg-base)]"
    >
      <div className="border-b border-[var(--dsw-alias-border-l2)] px-4 py-2">
        <span className="text-ewb-meta font-semibold text-[var(--dsw-alias-label-primary)]">
          要跑「{props.name}」—— 这份工作流要先填 {String(props.fields.length)} 项
        </span>
      </div>

      <div className="flex flex-col gap-3 px-4 py-3">
        {props.fields.map(f => (
          <div key={f.name} className="flex flex-col gap-1">
            <label
              htmlFor={'ewb-in-' + f.name}
              className="font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
            >
              {f.name}
              {f.required && <span className="ml-1.5 text-[var(--dsw-alias-state-warning-primary)]">必填</span>}
            </label>
            <input
              id={'ewb-in-' + f.name}
              type="text"
              value={values[f.name] ?? ''}
              onChange={e => { setValues(v => ({ ...v, [f.name]: e.target.value })) }}
              className="rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2.5 py-1.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-primary)]"
            />
            {/* 说明**常显在输入框下方**（与节点参数面板同一条纪律）。 */}
            {f.description !== '' && (
              <span className="text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">{f.description}</span>
            )}
          </div>
        ))}
        {problem !== '' && (
          <div className="font-mono text-ewb-caption text-[var(--dsw-alias-state-error-primary)]">{problem}</div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-[var(--dsw-alias-border-l2)] px-4 py-2">
        <button
          type="submit"
          data-lens="c"
          className="pressable is-dark rounded-full border border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)] px-3.5 py-1.5 font-mono text-ewb-caption text-[var(--ewb-accent)]"
        >开始执行</button>
        <button
          type="button"
          data-lens="c"
          onClick={props.onCancel}
          className="pressable is-dark rounded-full border border-[var(--dsw-alias-border-l2)] px-3.5 py-1.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
        >取消</button>
      </div>
    </form>
  )
}
