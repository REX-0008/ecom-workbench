/** 提醒诊断：发不发得出去（通道自检）+ 什么情况会提醒。
 *
 * ## 这块从哪来
 *
 * 原名 `NotifyBoard.tsx`，是左侧导航里的「提醒」板块。2026-10-23 契约 P 把
 * 提醒的**设置项**搬进了工作台设置（`WorkspaceSettings.tsx` 的 `NotifySettings`），
 * 板块本身下线。剩下的这两部分是**运行时诊断**，不是设置：
 *
 * | 区块 | 回答什么 | 为什么不能删 |
 * | --- | --- | --- |
 * | **通道自检** | 这台机器现在能不能弹系统通知（三项**分别**报） | 用户当初就是靠它发现「系统通知总开关被关了」 |
 * | **什么情况会提醒** | 哪些情况会发提醒（读真实触发点，不是愿望清单） | 设置里只有开关，看不出「哪些情况真的接了」 |
 *
 * 所以它现在挂在「提醒」这一节的底部，**折叠**起来，需要排查时展开。
 *
 * ## 为什么三项必须分开报（`POST /notify/selfcheck` 的契约）
 *
 * 三项是**三个不同的故障**，合成一句「通知不可用」等于让人没法修：
 *
 *   ① 能不能起 PowerShell —— 起不来是系统/权限问题；
 *   ② 能不能弹 —— 起得来但弹不出来，通常是会话类型（服务会话没有桌面）；
 *   ③ 系统通知总开关 —— 注册表里 `ToastEnabled=0` 时，弹了也会被系统吞掉。
 *
 * 所以界面上一项一行，**过与不过都把原因写出来**（宿主半对成功也会给一句说明）。
 *
 * ## 「提醒项目」读的是真实触发点
 *
 * 宿主半目前只有两处发通知（`grep notify src/` 的结果）：
 *   · 定时任务跑失败（`src/schedule/runner.ts`）；
 *   · 挂起的运行恢复失败（`src/index.ts`）。
 *
 * 所以列表里只列这两类，**并且把「这个情况现在会不会发」如实标出来**。
 * 还没接的（比如「巡查判出异常但跑成功了」）也列一行并写明「未接入」——
 * 比让人误以为已经在提醒要好。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { asArray, asObject, call, isPatrol, when } from './board-kit.ts'
import { alertLevelLabel } from './dispatch-client.ts'
import type { NotifyPrefs } from './dispatch-client.ts'
import ws from './WorkbenchSettings.module.css'

/** 自检三项里的某一项（宿主半 `NotifyCheck`）。 */
interface NotifyCheck {
  ok: boolean
  reason: string
}

/** 自检结果（宿主半 `NotifySelfcheck`）。 */
interface Selfcheck {
  powershell?: NotifyCheck
  balloon?: NotifyCheck
  pushSwitch?: NotifyCheck
}

/** 一条定时任务（只取这里要用的字段）。 */
interface ScheduleTask {
  id: string
  name: string
  workflowName: string
  time: string
  enabled: boolean
  lastResult?: string
  lastRunAt?: number
}

/** 自检的三项（顺序与宿主半的判定顺序一致：先能不能起、再能不能弹、最后总开关）。 */
const CHECK_ITEMS = [
  { key: 'powershell', label: '能不能起 PowerShell', fail: '起不来 PowerShell：通知发不出去。先确认这台机器能开 PowerShell。' },
  { key: 'balloon', label: '能不能弹', fail: '弹不出来：命令跑通了但系统没显示。常见原因是当前没有可用的桌面会话。' },
  { key: 'pushSwitch', label: '系统通知总开关', fail: '系统通知被关掉了：弹了也会被吞。去「设置 → 系统 → 通知」把总开关打开。' },
] as const

/**
 * 提醒诊断（折叠）。
 *
 * @param props - `prefs` 由「提醒」那一节传下来（它已经读过一次，这里不再请求一遍）；
 *   `null` 表示设置没读到 —— 此时徽标写「设置未知」，**不猜**会不会发。
 * @returns 折叠块元素。
 */
export function NotifyDiagnostics({ prefs }: { prefs: NotifyPrefs | null }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [check, setCheck] = useState<Selfcheck | null>(null)
  /** 自检正在跑（真弹一条要几秒，得给反馈）。 */
  const [checking, setChecking] = useState(false)
  const [checkErr, setCheckErr] = useState('')
  /** 上次自检的时间（提醒用户这不是实时状态）。 */
  const [checkedAt, setCheckedAt] = useState(0)
  const [tasks, setTasks] = useState<ScheduleTask[] | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  /**
   * 拉定时任务（「什么情况会提醒」的主体来源）。
   *
   * ⚠️ **展开时才拉**：折叠状态下不请求。这块是排查用的，不是每次开设置都该有的开销。
   *
   * @param silent - 不显示加载中的那一行（重复拉取时用）。
   */
  const refresh = useCallback((silent = false): void => {
    if (!silent) setLoading(true)
    void call<{ tasks?: unknown }>('/schedule/tasks').then(r => {
      if (!r.ok) { setErr(r.error ?? '读不到定时任务'); setLoading(false); return }
      setErr('')
      setTasks(asArray(r.body?.tasks).map(x => {
        const o = asObject(x)
        return {
          id: String(o.id ?? ''),
          name: String(o.name ?? ''),
          workflowName: String(o.workflowName ?? ''),
          time: String(o.time ?? ''),
          enabled: o.enabled !== false,
          ...typeof o.lastResult === 'string' ? { lastResult: o.lastResult } : {},
          ...typeof o.lastRunAt === 'number' ? { lastRunAt: o.lastRunAt } : {},
        }
      }))
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (!open) return
    /* 展开时第一次拉；`tasks === null` 才拉，收起再展开不重复请求。 */
    if (tasks === null) refresh()
  }, [open, tasks, refresh])

  /**
   * 跑一次通道自检。
   *
   * ⚠️ 它会**真的弹一条**系统通知（宿主半的 `selfcheck` 就是这么设计的：
   * 「能不能弹」只有真弹才知道）。所以不做成展开就自动跑。
   */
  const runCheck = useCallback((): void => {
    setChecking(true)
    setCheckErr('')
    void call<Selfcheck>('/notify/selfcheck', { method: 'POST' }).then(r => {
      setChecking(false)
      if (!r.ok) { setCheck(null); setCheckErr(r.error ?? '自检失败'); return }
      setCheck(r.body ?? {})
      setCheckedAt(Date.now())
    })
  }, [])

  /** 过没过（一项都没跑时不算通过）。 */
  const passed = check === null ? 0 : CHECK_ITEMS.filter(i => check[i.key]?.ok === true).length

  /** 启用中的定时任务（只有它们会真的到点跑、失败才会提醒）。 */
  const liveTasks = useMemo(() => (tasks ?? []).filter(t => t.enabled), [tasks])
  /** 上次跑失败的那些（下一次跑之前，它们就是「已经该提醒过」的那批）。 */
  const failedTasks = useMemo(() => liveTasks.filter(t => (t.lastResult ?? '').startsWith('失败')), [liveTasks])
  /** 启用中的巡查任务条数（提示语里要说清巡查也走同一条失败提醒）。 */
  const patrolLiveCount = useMemo(() => liveTasks.filter(t => isPatrol(t.workflowName)).length, [liveTasks])

  /**
   * 两项设置各自「会不会真的发」。
   *
   * ⚠️ 判据只认「偏好读到没有」：`prefs === null`（读失败）时**不下结论**，
   * 徽标写「设置未知」—— 否则会在读失败时错误地声称「会提醒」。
   */
  const failOn = prefs?.failNotify === true
  /** 预警节点那一路：`off` = 一律不发；否则「X 及以上才发」。 */
  const alertOn = prefs !== null && prefs.alertMinLevel !== 'off'
  /** 预警门槛的文案（读到之前为空 —— 不猜）。 */
  const alertThr = prefs === null ? '' : alertLevelLabel(prefs.alertMinLevel)

  const failText = prefs === null ? '设置未知' : failOn ? '会提醒' : '不发（失败提醒已关）'
  const nodeText = prefs === null ? '设置未知' : alertOn ? alertThr + '才发' : '不发（预警节点已关）'

  return (
    <div className={ws.section} data-ewb-notify-diag="">
      <button
        type="button"
        className={ws.btn}
        data-ewb-notify-diag-toggle=""
        aria-expanded={open}
        onClick={() => { setOpen(v => !v) }}
      >
        {open ? '收起诊断' : '诊断：发不发得出去、什么情况会提醒'}
      </button>

      {open && (
        <div data-ewb-notify-diag-body="">
          {/* ── 通道自检 ─────────────────────────────────────── */}
          <div className={ws.row} style={{ marginTop: '10px' }}>
            <span className={ws.rowLabel}>通知通道</span>
            <button
              type="button"
              className={ws.btn}
              data-ewb-notify-check=""
              disabled={checking}
              title="真起一次 PowerShell 并弹一条通知（会看到一条气球提示）"
              onClick={runCheck}
            >{checking ? '检测中…' : '检测通知通道'}</button>
            {checkedAt > 0 && <span className={ws.note}>上次检测 {when(checkedAt)}</span>}
          </div>

          {checkErr !== '' && (
            <div className={ws.note} data-ewb-notify-check-err="">自检没跑成：{checkErr}</div>
          )}

          {check === null && checkErr === ''
            ? (
              <div className={ws.note}>
                还没检测。点上面的按钮，会真的弹一条通知 —— 能不能弹只有真弹才知道。
              </div>
            )
            : (
              <div data-ewb-notify-check-result="">
                {CHECK_ITEMS.map(item => {
                  const got = check?.[item.key]
                  const ok = got?.ok === true
                  return (
                    <div key={item.key} className={ws.row} data-ewb-notify-check-item={item.key}>
                      <span className={ws.rowLabel}>{item.label}</span>
                      <span className={ws.note} data-ewb-notify-check-state={ok ? 'ok' : 'err'}>
                        {ok ? '通过' : '不通过'}
                        {' · '}
                        {got === undefined ? '（没有结果）' : got.reason}
                        {!ok && got !== undefined && <> · {item.fail}</>}
                      </span>
                    </div>
                  )
                })}
                <div className={ws.note}>
                  {passed} / {CHECK_ITEMS.length} 项通过
                  {passed < CHECK_ITEMS.length ? ' —— 哪项不通过就先修哪项，上面的原因写着怎么修' : ' —— 通知这条路是通的'}
                </div>
              </div>
            )}

          {/* ── 什么情况会提醒 ───────────────────────────────── */}
          <div className={ws.sectionTitle} style={{ marginTop: '12px' }}>什么情况会提醒</div>
          {loading && <div className={ws.note}>加载中…</div>}
          {!loading && err !== '' && (
            <>
              <div className={ws.note}>读不到定时任务：{err}</div>
              <button type="button" className={ws.btn} onClick={() => { refresh() }}>重试</button>
            </>
          )}

          {!loading && err === '' && (
            <div data-ewb-notify-cases="">
              {/* 触发点一：定时任务失败（一条任务一行）。 */}
              <div className={ws.row} data-ewb-notify-case="schedule">
                <span className={ws.rowLabel}>定时任务跑失败</span>
                <span className={ws.note}>
                  {liveTasks.length === 0
                    ? '没有启用中的任务'
                    : liveTasks.length + ' 条启用中，' + (!failOn ? '当前已关闭失败提醒' : '失败各发一条')}
                </span>
              </div>
              {prefs === null && (
                <div className={ws.note}>设置尚未读到，下面标的是「设置未知」，实际发不发以设置为准。</div>
              )}
              {liveTasks.length > 0 && liveTasks.map(t => (
                <div key={t.id} className={ws.row} data-ewb-notify-task={t.id}>
                  <span className={ws.rowLabel}>{t.name}</span>
                  <span className={ws.note}>
                    {t.workflowName} · 每天 {t.time}
                    {' · '}{failText}
                    {' · '}{t.lastResult === undefined ? '还没跑过' : when(t.lastRunAt)}
                  </span>
                </div>
              ))}

              {failedTasks.length > 0 && (
                <div className={ws.note}>
                  有 {failedTasks.length} 条任务上次是失败的（{failedTasks.map(t => t.name).join('、')}）——
                  {!failOn
                    ? '失败提醒已关闭，那几条失败没有发通知，去「自动化 → 定时任务」看失败原因。'
                    : '那几条提醒已经发过了，去「自动化 → 定时任务」看失败原因。'}
                </div>
              )}

              {/* 触发点二：挂起的运行恢复失败（与定时任务失败**共用「失败是否提醒」那一项**）。 */}
              <div className={ws.row} data-ewb-notify-case="resume">
                <span className={ws.rowLabel}>挂起的运行恢复失败</span>
                <span className={ws.note}>
                  工作流跑到「等待」节点后，到点续不上 · {failText} · 与失败提醒同一项
                </span>
              </div>

              {/* 触发点三：通知节点（`flow.notify`）——**由「预警节点什么级别才提醒」这一项管**。 */}
              <div className={ws.row} data-ewb-notify-case="notify-node">
                <span className={ws.rowLabel}>工作流里的「通知」节点</span>
                <span className={ws.note}>
                  {prefs === null ? '按设置里的级别门槛' : alertOn ? '级别达到「' + alertThr + '」才弹' : '一律不发'}
                  {' · '}{nodeText} · 按级别
                </span>
              </div>

              {/* 还没接的：如实列出来，不让人以为已经在提醒。 */}
              <div className={ws.row} data-ewb-notify-case="patrol-anomaly">
                <span className={ws.rowLabel}>巡查判出异常（但这次跑成功了）</span>
                <span className={ws.note}>
                  {!failOn
                    ? '失败提醒已关闭，这类本就不会发；即使打开失败提醒也不发，判档出 warn / crit 暂无通知'
                    : '现在只在「跑失败」时提醒；判档出 warn / crit 不发通知'}
                  {' · 未接入'}
                </span>
              </div>

              <div className={ws.note} style={{ marginTop: '6px' }}>
                系统通知本身还受一个总开关管：系统通知被关掉时，这里发出去也不会显示。
                每条任务的开关在「自动化 → 定时任务」—— 停用的任务既不会跑，也不会提醒。
                {!failOn && !alertOn ? ' 两项都已关闭，上面这些一条都不会发出。' : ''}
                {patrolLiveCount > 0
                  ? ' 目前有 ' + String(patrolLiveCount) + ' 条巡查任务走这条失败提醒。'
                  : ''}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
