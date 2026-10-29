/** 定时板块：点几点跑哪份工作流。
 *
 * ## 这里的「定时」与 dsh 的自动化插件**不是一回事**
 *
 * 计划 §二「定时」那条钉住的：`@michengai/dsh-automation` 每次定时新开一个
 * DSH Session 让 agent 去跑；采集巡查不该这样。我们的执行器（`src/schedule/runner.ts`）
 * 到点**直接调 `runWorkflowFile`**，没有 AI 参与、不新开 Session。
 *
 * 所以这块只是那张**任务表**的编辑器：谁是几点、跑哪份、上次成没成。
 *
 * ## 第一版只支持「每天一次」（`HH:MM`）
 *
 * 每周 / 工作日 / 每 N 天这些都**还没做**（计划 §七 第 3 条没定之前不发明）。
 * 界面上就照实写「每天」，而不是给一个选了不生效的频率下拉 ——
 * 那种「选了但不起作用」的控件比没有更坏。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BoardProps } from './board-registry.ts'
import { asArray, asObject, call, isPatrol, when } from './board-kit.ts'
import { Badge, Label } from './terminal.tsx'

/** 一条定时任务（宿主半 `ScheduleTask` 的形状）。 */
interface ScheduleTask {
  id: string
  name: string
  workflowName: string
  /** `HH:MM`。 */
  time: string
  enabled: boolean
  note?: string
  lastRunAt?: number
  lastResult?: string
  lastRunDate?: string
}

/** 工作流清单里的一条（新建任务时选目标用）。 */
interface WorkflowItem {
  name: string
}

/** 表格列模板（末列按钮固定不压，其余都能压缩）。 */
const ROW_COLS = 'minmax(0, 1.2fr) minmax(0, 1.4fr) 84px minmax(0, 1.6fr) 210px'

/** 表头文字。 */
const HEAD_COLS = ['任务名', '目标工作流', '频率', '上次结果', '操作'] as const

/** 输入框。 */
const INPUT = [
  'min-w-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)]',
  'px-2 py-1.5 text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none',
].join(' ')

/** 主按钮。 */
const BTN = [
  'pressable is-dark shrink-0 whitespace-nowrap rounded-ctl border px-2.5 py-1.5',
  'border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)] text-[var(--ewb-accent)]',
  'font-mono text-ewb-caption leading-none disabled:opacity-45',
].join(' ')

/** 次要按钮。 */
const BTN_QUIET = [
  'pressable is-dark shrink-0 whitespace-nowrap rounded-ctl border border-[var(--dsw-alias-border-l2)]',
  'px-2.5 py-1.5 font-mono text-ewb-caption leading-none text-[var(--dsw-alias-label-tertiary)] disabled:opacity-45',
].join(' ')

/**
 * 定时板块。
 * @param props - 骨架入参（这块只用 `active`：不在前台不轮询）。
 * @returns 界面。
 */
export function ScheduleBoard({ active }: BoardProps): React.JSX.Element {
  const [tasks, setTasks] = useState<ScheduleTask[] | null>(null)
  const [flows, setFlows] = useState<WorkflowItem[]>([])
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  /** 顶部提示条。 */
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err', text: string } | null>(null)
  /** 正在跑的那条任务 id（防连点）。 */
  const [running, setRunning] = useState('')
  /** 新建表单展开着吗。 */
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newFlow, setNewFlow] = useState('')
  const [newTime, setNewTime] = useState('09:30')
  const [busy, setBusy] = useState(false)

  /**
   * 拉任务表 + 工作流清单。
   * @param silent - 不显示加载态。
   */
  const refresh = useCallback((silent = false): void => {
    if (!silent) setLoading(true)
    void (async () => {
      const [tk, wf] = await Promise.all([
        call<{ tasks?: unknown }>('/schedule/tasks'),
        call<{ items?: unknown }>('/workflows'),
      ])
      setFlows(wf.ok
        ? asArray(wf.body?.items).map(x => {
            const o = asObject(x)
            return { name: typeof o.name === 'string' ? o.name : '' }
          }).filter(x => x.name !== '')
        : [])
      if (!tk.ok) { setErr(tk.error ?? '读不到定时任务'); setLoading(false); return }
      setErr('')
      setTasks(asArray(tk.body?.tasks).map(x => {
        const o = asObject(x)
        return {
          id: String(o.id ?? ''),
          name: String(o.name ?? ''),
          workflowName: String(o.workflowName ?? ''),
          time: String(o.time ?? ''),
          enabled: o.enabled !== false,
          ...typeof o.note === 'string' ? { note: o.note } : {},
          ...typeof o.lastRunAt === 'number' ? { lastRunAt: o.lastRunAt } : {},
          ...typeof o.lastResult === 'string' ? { lastResult: o.lastResult } : {},
          ...typeof o.lastRunDate === 'string' ? { lastRunDate: o.lastRunDate } : {},
        }
      }))
      setLoading(false)
    })()
  }, [])

  useEffect(() => { refresh() }, [refresh])

  /* 任务表带「上次结果」，它会随执行器变化 —— 回到这块时重读一次。
   * 不轮询：定时器一分钟扫一次，界面没必要跟着每秒问。 */
  useEffect(() => {
    if (active) refresh(true)
  }, [active, refresh])

  /** 新建一条。 */
  const create = useCallback((): void => {
    if (newFlow === '') { setMsg({ tone: 'err', text: '先选一份要跑的工作流' }); return }
    if (newTime.trim() === '') { setMsg({ tone: 'err', text: '要填时间（HH:MM，如 09:30）' }); return }
    setBusy(true)
    void call<{ ok?: boolean, error?: string }>('/schedule/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: newName.trim() === '' ? newFlow : newName.trim(),
        workflowName: newFlow,
        time: newTime.trim(),
        enabled: true,
      }),
    }).then(r => {
      setBusy(false)
      if (!r.ok) { setMsg({ tone: 'err', text: '新建失败：' + (r.error ?? '未知原因') }); return }
      setMsg({ tone: 'ok', text: '已加一条定时任务' })
      setCreating(false)
      setNewName('')
      setNewFlow('')
      refresh(true)
    })
  }, [newFlow, newName, newTime, refresh])

  /**
   * 改一条（开关 / 时间）。
   * @param id - 任务 id。
   * @param patch - 要改的字段。
   */
  const patch = useCallback((id: string, patchIn: Record<string, unknown>): void => {
    setMsg(null)
    void call<{ ok?: boolean, error?: string }>('/schedule/tasks', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, ...patchIn }),
    }).then(r => {
      if (!r.ok) { setMsg({ tone: 'err', text: '改不了：' + (r.error ?? '未知原因') }); return }
      refresh(true)
    })
  }, [refresh])

  /**
   * 删一条。
   *
   * ⚠️ `window.confirm` 在 Electron 桌面端**可能不可用**（`window.prompt` 就是这样，
   * 见 `WorkflowList.tsx` 里那个真 bug）。所以这里**不弹确认框**，改成
   * 「连点两次才删」：按钮第一下变成「确认删除」，第二下才真的发请求。
   * 这个做法在桌面端与浏览器里表现完全一致。
   *
   * @param task - 要删的任务。
   */
  const remove = useCallback((task: ScheduleTask): void => {
    setMsg(null)
    void call<{ ok?: boolean, error?: string }>('/schedule/tasks?id=' + encodeURIComponent(task.id), { method: 'DELETE' })
      .then(r => {
        if (!r.ok) { setMsg({ tone: 'err', text: '删不掉：' + (r.error ?? '未知原因') }); return }
        setMsg({ tone: 'ok', text: '已删除「' + task.name + '」' })
        refresh(true)
      })
  }, [refresh])

  /** 待确认删除的那条 id（第二次点才真删）。 */
  const [confirming, setConfirming] = useState('')

  /**
   * 现在就跑一次。
   * @param task - 任务。
   */
  const runNow = useCallback((task: ScheduleTask): void => {
    setRunning(task.id)
    setMsg(null)
    void call<{ ok?: boolean, summary?: string, error?: string }>('/schedule/run/' + encodeURIComponent(task.id), { method: 'POST' })
      .then(r => {
        setRunning('')
        const summary = r.body?.summary ?? ''
        if (!r.ok) {
          setMsg({ tone: 'err', text: '执行失败：' + (summary === '' ? (r.error ?? '未知原因') : summary) })
        } else {
          setMsg({ tone: 'ok', text: '已跑一次：' + summary })
        }
        refresh(true)
      })
  }, [refresh])

  /** 巡查类的任务名（宿主半首次启动自动生成的那五条，界面上单独说一句）。 */
  const patrolCount = useMemo(() => (tasks ?? []).filter(t => isPatrol(t.workflowName)).length, [tasks])

  const gate = loading
    ? <div className="p-6 text-center font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">加载中…</div>
    : err !== ''
      ? (
        <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-10">
          <div className="font-mono text-ewb-meta text-[var(--dsw-alias-state-error-primary)]">读不到定时任务</div>
          <div className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">{err}</div>
          <button type="button" className={BTN_QUIET} onClick={() => { refresh() }}>重试</button>
        </div>
      )
      : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {msg !== null && (
        <div
          className={[
            'mb-2 flex-none rounded-ctl border px-3 py-2 font-mono text-ewb-caption',
            msg.tone === 'ok'
              ? 'border-[color-mix(in_oklab,var(--dsw-alias-state-success-primary)_35%,transparent)] text-[var(--dsw-alias-state-success-primary)]'
              : 'border-[color-mix(in_oklab,var(--dsw-alias-state-error-primary)_35%,transparent)] text-[var(--dsw-alias-state-error-primary)]',
          ].join(' ')}
        >{msg.text}</div>
      )}
      {gate}

      {!loading && err === '' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="mb-2 flex flex-none flex-wrap items-center gap-2">
            <button
              type="button"
              className={BTN}
              title="加一条：每天某个时刻跑一份工作流"
              onClick={() => { setCreating(v => !v); setMsg(null) }}
            >{creating ? '取消' : '新建定时任务'}</button>
            <button type="button" className={BTN_QUIET} title="重新读一次任务表" onClick={() => { refresh() }}>刷新</button>
            <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
              共 {(tasks ?? []).length} 条{patrolCount > 0 ? '（其中 ' + String(patrolCount) + ' 条巡查）' : ''}
            </span>
          </div>

          {creating && (
            <div className="mb-3 flex flex-none flex-col gap-2 rounded-card border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-3 py-3">
              <Label rule>新建定时任务（每天一次）</Label>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">目标</span>
                <select className={INPUT} value={newFlow} onChange={e => { setNewFlow(e.target.value) }}>
                  <option value="">（选一份工作流）</option>
                  {flows.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
                </select>
                <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">每天</span>
                <input
                  type="text"
                  className={INPUT}
                  style={{ width: 88 }}
                  placeholder="09:30"
                  value={newTime}
                  onChange={e => { setNewTime(e.target.value) }}
                />
                <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">任务名</span>
                <input
                  type="text"
                  className={INPUT}
                  placeholder="（不填就用工作流名）"
                  value={newName}
                  onChange={e => { setNewName(e.target.value) }}
                />
                <button type="button" className={BTN} disabled={busy} onClick={create}>{busy ? '保存中…' : '创建'}</button>
              </div>
              <div className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
                只支持「每天一次」。每周、工作日、每 N 天这些都还没做。
                同一天不会跑两次；错过了（比如那会儿没开电脑）就等第二天，不自动补跑。
              </div>
            </div>
          )}

          {(tasks ?? []).length === 0
            ? (
              <div className="rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-8 text-center font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                还没有定时任务
              </div>
            )
            : (
              <>
                <div
                  className="grid items-center gap-2 border-b border-[var(--dsw-alias-border-l2)] pb-1.5"
                  style={{ gridTemplateColumns: ROW_COLS }}
                >
                  {HEAD_COLS.map(t => (
                    <span key={t} className="truncate font-mono text-ewb-caption uppercase tracking-[0.16em] text-[var(--dsw-alias-label-tertiary)]">{t}</span>
                  ))}
                </div>
                {(tasks ?? []).map(t => (
                  <div
                    key={t.id}
                    className="grid items-center gap-2 border-b border-[var(--dsw-alias-border-l2)] py-2"
                    style={{ gridTemplateColumns: ROW_COLS }}
                  >
                    <span className="min-w-0 truncate text-ewb-meta font-semibold text-[var(--dsw-alias-label-primary)]" title={t.name}>
                      {t.name}
                    </span>
                    <span className="min-w-0 truncate font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]" title={t.workflowName}>
                      {t.workflowName}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Badge tone={t.enabled ? 'ok' : 'default'}>{t.enabled ? '每天' : '已停'}</Badge>
                      <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">{t.time}</span>
                    </span>
                    <span className="flex min-w-0 flex-col gap-0.5">
                      {t.lastResult === undefined
                        ? <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">还没跑过</span>
                        : (
                          <>
                            <span
                              className={[
                                'min-w-0 truncate font-mono text-ewb-caption',
                                t.lastResult.startsWith('失败')
                                  ? 'text-[var(--dsw-alias-state-error-primary)]'
                                  : 'text-[var(--dsw-alias-label-secondary)]',
                              ].join(' ')}
                              title={t.lastResult}
                            >{t.lastResult}</span>
                            <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">{when(t.lastRunAt)}</span>
                          </>
                        )}
                    </span>
                    <span className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        className={BTN_QUIET}
                        title={t.enabled ? '停用：到点不再自动跑（任务留在表里）' : '启用：到点自动跑'}
                        onClick={() => { patch(t.id, { enabled: !t.enabled }) }}
                      >{t.enabled ? '停用' : '启用'}</button>
                      <button
                        type="button"
                        className={BTN}
                        disabled={running !== ''}
                        title="现在就跑一次（不等时间点）"
                        onClick={() => { runNow(t) }}
                      >{running === t.id ? '跑着…' : '立即运行'}</button>
                      <button
                        type="button"
                        className={[
                          'pressable is-dark shrink-0 whitespace-nowrap font-mono text-ewb-caption',
                          confirming === t.id
                            ? 'text-[var(--dsw-alias-state-error-primary)]'
                            : 'text-[var(--dsw-alias-label-tertiary)]',
                        ].join(' ')}
                        title={confirming === t.id ? '再点一次就删掉这条任务（不影响工作流存档）' : '删除这条定时任务'}
                        onClick={() => {
                          if (confirming === t.id) { setConfirming(''); remove(t); return }
                          setConfirming(t.id)
                          setMsg({ tone: 'ok', text: '再点一次「确认删除」就删掉「' + t.name + '」' })
                        }}
                      >{confirming === t.id ? '确认删除' : '删除'}</button>
                    </span>
                  </div>
                ))}
              </>
            )}

          {/* ⚠️ 末尾那句「逐个执行」是**用户 2026-10-30 定下的事实说明**（票 16）。
           * 他明确要求「保持串行」，只要界面上有一句话交代这件事。
           *
           * 只陈述事实、不解释为什么（他的原话是「说明文字尽量不写」）。
           * 为什么串行 —— 五份巡查只共用三套浏览器会话，并行会互相踩页面 ——
           * 写在 `src/schedule/runner.ts` 的 `tick()` 上面，给人看代码时读。
           * 两处别改成同一份详略：界面这一处一长就变成没人读的说明书。 */}
          <div className="pt-3 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
            执行器每分钟扫一次任务表；到点就直接跑工作流，不新开对话、不经过模型。
            失败会发一条系统通知（设置见「提醒」板块）。
            多个任务到同一时间点时，按任务表顺序逐个执行。
          </div>
        </div>
      )}
    </div>
  )
}
