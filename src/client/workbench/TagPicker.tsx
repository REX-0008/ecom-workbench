/** 「能选能打」的标签栏 —— **一处实现，两处使用**（用户 m00901 定案）。
 *
 * ## 用户要的形态（原话）
 *
 * > 「做成**可输入的选项栏**，输入就是新建或者筛选以后分类。」
 *
 * 也就是「下拉 + 能打字」：列表里已有的点一下就选上；列表里没有的打进去就**当场新建**。
 *
 * ## 为什么抽成一份（而不是各写各的）
 *
 * 两处用同一形态：
 *   · **收藏板块的 Github 项目分类**（单值，见 CollectPanel.tsx）；
 *   · **工作流类型**（多值，见 WorkflowList.tsx / 存档的 types 字段）。
 *
 * 用户 m00901 明确要求「**公用一份**」。本项目有一条踩过多次的坑：
 * 同一件事写两份迟早漂（pitfalls/同一件事写两份迟早漂.md）——
 * 所以这里带一个 multi 开关，而不是两个组件。
 *
 * ## 为什么用 input[list] + datalist
 *
 * 那是**浏览器原生**的「可输入下拉」：打字会筛选、能输入新值、键盘上下选、
 * 移动端也会弹原生选择器。自己撸一个下拉要管定位、外点关闭、键盘导航、
 * 无障碍 —— 而那些原生已经给了。
 *
 * ⚠️ 已知代价：datalist 的**样式由浏览器决定、改不了**（暗色主题下
 * 各浏览器观感不一）。这是有意的取舍 —— 换来的是「一次写对」。
 */
import { useState } from 'react'

/** 输入框样式（与 CollectPanel / WorkflowList 同一套，不另造比例）。 */
const INPUT_CLS = 'rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1.5 text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none'

/**
 * 单值版：一个可输入的下拉。
 *
 * @param props.value - 当前值（空串 = 没选）。
 * @param props.options - 已有的候选（下拉里的那一串）。
 * @param props.onChange - 改值（用户打进去的新值也走这里 —— 那就是「当场新建」）。
 * @param props.id - 给 datalist 用的唯一 id（同一页可能有多个）。
 * @param props.placeholder - 占位提示。
 * @returns 控件。
 */
export function TagPickerSingle(props: {
  value: string
  options: readonly string[]
  onChange: (v: string) => void
  id: string
  placeholder?: string
}) {
  return (
    <>
      <input
        type="text"
        list={props.id}
        className={INPUT_CLS + ' font-mono text-ewb-caption'}
        value={props.value}
        placeholder={props.placeholder ?? '选一个，或直接打一个新名字'}
        onChange={e => { props.onChange(e.target.value) }}
      />
      <datalist id={props.id}>
        {props.options.map(o => <option key={o} value={o} />)}
      </datalist>
    </>
  )
}

/**
 * 多值版：一排小胶囊 + 一个可输入的下拉。
 *
 * ## 交互（都要有）
 *
 *   ① 下拉里选 / 打字新建 → **加进去**（已存在则不加，避免重复）；
 *   ② 每个胶囊上的 × → **拿掉**。
 *
 * ⚠️ 输入框在选择后**清空**（否则用户以为还能输入，而值已经加上去了）。
 *
 * @param props.values - 当前选中的值（顺序即显示顺序）。
 * @param props.options - 已有的候选。
 * @param props.onChange - 改整份值（加 / 删都走它）。
 * @param props.id - 给 datalist 用的唯一 id。
 * @param props.placeholder - 占位提示。
 * @returns 控件。
 */
export function TagPickerMulti(props: {
  values: readonly string[]
  options: readonly string[]
  onChange: (v: string[]) => void
  id: string
  placeholder?: string
}) {
  const [draft, setDraft] = useState('')

  /**
   * 把 draft 里的值加进去（空的、已有的都不加）。
   * @param raw - 用户刚打进去的原文。
   */
  const commit = (raw: string): void => {
    const v = raw.trim()
    if (v === '') return
    if (props.values.includes(v)) { setDraft(''); return }
    props.onChange([...props.values, v])
    setDraft('')
  }

  return (
    <div className="flex flex-col gap-1.5">
      {props.values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {props.values.map(v => (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-mono text-ewb-caption"
              style={{ background: 'var(--ewb-accent-soft)', color: 'var(--ewb-accent)' }}
            >
              {v}
              <button
                type="button"
                title={'去掉「' + v + '」'}
                onClick={() => { props.onChange(props.values.filter(x => x !== v)) }}
                className="shrink-0 leading-none opacity-70 hover:opacity-100"
              >×</button>
            </span>
          ))}
        </div>
      )}
      <input
        type="text"
        list={props.id}
        className={INPUT_CLS + ' font-mono text-ewb-caption'}
        value={draft}
        placeholder={props.placeholder ?? '选一个，或直接打一个新名字后回车'}
        onChange={e => { setDraft(e.target.value) }}
        onKeyDown={e => {
          /* 回车提交；逗号也提交（连续打多个时不用回车）。 */
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(draft) }
          /* 退格删最后一个（输入框已空时）—— 与常见标签输入一致。 */
          if (e.key === 'Backspace' && draft === '' && props.values.length > 0) {
            props.onChange(props.values.slice(0, -1))
          }
        }}
        /* 从下拉里点选时浏览器会把值填进输入框；失焦且是已有项 → 提交。
         * 这样「点一下」就等于选中，不必再按回车。 */
        onBlur={() => { if (draft !== '' && props.options.includes(draft)) commit(draft) }}
      />
      <datalist id={props.id}>
        {props.options.map(o => <option key={o} value={o} />)}
      </datalist>
    </div>
  )
}
