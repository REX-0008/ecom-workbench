/** 定时执行器（宿主半）：到点**直接跑工作流**。
 *
 * ## 一条纪律：不经过 agent、不新开 Session
 *
 * 计划 §二「定时（参考已装插件）」的原话：
 * > @michengai/dsh-automation：每次定时新开独立 DSH Session 让 agent 跑。采集巡查不该这样。
 * > 我们要的：**无 AI 参与、直接调 runWorkflowFile**。dsh 自带 ctx.schedule 是「往会话投消息」，同样不适合做执行器。
 *
 * 所以这里只做三件事：**看表 → 到点 → 调 `runWorkflowFile`**。
 * 跑法、跳过语义、循环、失败策略全部复用调度器那一份（`src/workflow/run.ts`）——
 * 与画布、与列表页的「执行」是**同一条路**（不另写跑法）。
 *
 * ## 与人工跑的差别只有两处
 *
 *   ① 没有画布可画 → 结果写运行历史（`appendRun`，与列表页那条路同一份）；
 *   ② 跑完把产出再落一份到板块记录（`records.ts`，与列表页那条路同一份）。
 *
 * ## 为什么按「分钟」扫而不是算好下次时间点
 *
 * 每分钟比一次 `HH:MM` 是**幂等**的：插件重启、系统休眠唤醒、时间被改，
 * 下一秒都比得出来；而「算下次时间点再睡到那时」一旦算错（或系统时钟跳了），
 * 就要等到第二天才知道错了。代价是每分钟醒一次 —— 开销是一次数组比较。
 *
 * ⚠️ **同一天不会跑两次**：跑过就把 `lastRunDate` 写成今天（表里看得见）。
 */
import type { NodeDef } from '../workflow/model.ts'
import { runWorkflowFile } from '../workflow/run-file.ts'
import { appendRun, newRunId, type RunNodeLine } from '../workflow/workflow-runs.ts'
import type { NodeReport } from '../dispatch/executors.ts'
/* 节点事件的归并规则（2026-10-25，契约 AR）：**共用一份**，不再手抄。
 * 住在独立文件里 —— `index.ts` 引用本文件，反向 import 会成环。 */
import { mergeNodeEvent, type NodeEventLike } from '../workflow/node-events.ts'
import { NODE_LIBRARY } from '../client/workbench/node-library.ts'
import { archiveOutputs } from './records.ts'
import { loadTasks, updateTasks, type ScheduleTask } from './store.ts'
import { notify } from '../notify/index.ts'
import { readNotifyPrefs } from '../notify/prefs.ts'

/** `runWorkflowFile` 要的派发函数（与 `src/index.ts` 传给它的那个同形）。 */
export type ScheduleDispatch = (req: {
  runId: string
  nodeId: string
  executor: string
  command: unknown
  context: { workflowId: string, upstream: unknown[], workdir: string, env?: Record<string, string> }
}, signal?: AbortSignal) => Promise<{
  ok: boolean
  /** ⚠️ 这个联合类型照抄 `DispatchResult.status`（`src/dispatch/dispatcher.ts:58`）——
   * 写成 `string` 会让整条链退化成「谁都能传」，而 `runWorkflowFile` 要的是窄的。 */
  status: 'success' | 'failed' | 'cancelled'
  output: unknown
  logs: string[]
  error?: string
}>

/** 跑一次任务的结果。 */
export interface ScheduleRunResult {
  /** 跑成了没。 */
  ok: boolean
  /** 一句话结论（写进任务的 `lastResult`，也给路由回话）。 */
  summary: string
  /** 结束节点声明的产出（没有则空对象）。 */
  outputs: Record<string, unknown>
  /** 运行 id（能去运行历史里定位）。 */
  runId: string
}

/** 正在跑的任务 id（防同一任务叠着跑）。 */
const running = new Set<string>()

/**
 * 取本地日期 `YYYY-MM-DD`。
 * @param d - 时间。
 * @returns 如 `2026-10-21`。
 */
function ymd(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate())
}

/**
 * 取本地 `HH:MM`。
 * @param d - 时间。
 * @returns 如 `09:30`。
 */
function hm(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes())
}

/**
 * 跑一个任务**一次**（不管到没到点）。
 *
 * 三个副作用按顺序做，每一步都不让下一步失败：
 *   ① 跑工作流（`runWorkflowFile`）；
 *   ② 写运行历史（`appendRun`）—— 与列表页「执行」同一份；
 *   ③ 写板块记录（`archiveOutputs`）—— 与列表页「执行」同一份。
 *
 * @param task - 任务。
 * @param dispatch - 派发函数（宿主半的本地派发器）。
 * @param opts.library - 节点定义表（测试可注入）。
 * @param opts.workdir - 工作目录。
 * @param opts.prefs - 浏览器偏好（从列表/定时启动必须补，否则连不上浏览器）。
 * @param opts.via - 记到运行历史里的「谁发起」。
 * @returns 结果。
 */
export async function runTaskOnce(
  task: ScheduleTask,
  dispatch: ScheduleDispatch,
  opts: {
    library?: readonly NodeDef[]
    workdir?: string
    prefs?: unknown
    via?: string
  } = {},
): Promise<ScheduleRunResult> {
  const library = opts.library ?? NODE_LIBRARY
  const via = opts.via ?? 'schedule'
  const startedAt = Date.now()
  /** 节点 id → 明细（与 `src/index.ts` 的 `runCollector` 同一个攒法）。 */
  const byNode = new Map<string, RunNodeLine>()
  /* ## 吃事件：调**共用的** `mergeNodeEvent`，不再手抄一份（2026-10-25，契约 AR）
   *
   * 这里原来是一段手写的分支链。它与 `index.ts` 那份**已经漏了两个分支**：
   *
   * | 分支 | index.ts | 原 runner.ts |
   * | --- | --- | --- |
   * | `cancelled` | 有 | **没有** |
   * | 挂模型痕迹（`llm`） | 有 | **没有** |
   *
   * 后果是真用户会遇到的：
   *   · 定时跑的运行记录里**没有模型痕迹**（不知道用了哪个模型、花了多少 token）；
   *   · 定时跑中断后，未执行的节点停在 `queued` 而不是 `cancelled` ——
   *     契约 AB 修的那个显示问题，在定时这条路上又回来了。
   * 两条都没被测到（`tests/schedule-notify.mjs` 里 `cancelled` / `llm` 零命中）。
   *
   * 现在与 `src/index.ts:829` 的 `resumePausedRun` **逐字一致**：一行转发。
   * 规则本体住在 `src/workflow/node-events.ts`（独立文件，避免 index ⇄ runner 成环）。 */
  const feed = (e: NodeEventLike): void => { mergeNodeEvent(byNode, e) }

  /* ## 汇报从**节点明细**里取，不从派发结果另攒一份（契约 AN）
   *
   * 早先这里包了一层 `collect`，把 `DispatchResult.reports` 往一个数组里 push。
   * 那条路已经删掉：引擎从 `RunOutcome.reports` 转成 `report` 事件（`run.ts:1320`），
   * 事件上面 `feed` 已收进 `byNode` —— 明细是**唯一**真相来源，
   * 运行历史显示的和任务记录里的必须是同一份数据。
   * 两条通道并存的症状：历史里三条、任务记录里两条，没人解释得清。 */
  const res = await runWorkflowFile({ name: task.workflowName }, library, dispatch, {
    workdir: opts.workdir ?? process.cwd(),
    ...opts.prefs === undefined ? {} : { prefs: opts.prefs },
    onEvent: (e) => { feed(e as { kind: string, nodeId: string }) },
  })

  const succeeded = res.ok && !res.aborted
  /**
   * 把已收集的节点明细里的汇报汇总成一份（契约 AN）。
   * @returns 每条都补上节点 id；一条都没有时是空数组。
   */
  const sumReports = (): NodeReport[] => {
    const out: NodeReport[] = []
    for (const line of byNode.values()) {
      for (const entry of line.reports ?? []) out.push({ ...entry, node: line.nodeId })
    }
    return out
  }  /* ⚠️ `ok` 与 `aborted` 要一起看 —— 那个坑在 `run-file.ts` 里写过两次。 */
  const summary = succeeded
    ? '跑完了（' + String(res.ran.length) + ' 个节点）'
    : '没跑成：' + (res.error ?? '有节点失败并中断')

  /* ② 运行历史：与列表页「执行」走同一份 `appendRun`。
   * 名字用**解析出来的**那份（`res.name`），与历史的分组键一致。 */
  const name = res.name ?? task.workflowName
  const runId = newRunId(startedAt)
  await appendRun({
    id: runId,
    name,
    startedAt,
    endedAt: Date.now(),
    ok: succeeded,
    ...res.aborted ? { aborted: true } : {},
    ran: res.ran,
    nodes: [...byNode.values()],
    via,
    ...res.error === undefined ? {} : { error: res.error },
    ...res.inputs === undefined ? {} : { inputs: res.inputs },
    ...res.declaredOutputs === undefined ? {} : { outputs: res.declaredOutputs },
  })

  /* ③ 板块记录：与列表页「执行」同一份 `archiveOutputs`。
   * 失败原因取**真实那条**（`res.error`，上面已经写进运行记录）；成功时不给。
   * 工作流编号（契约 AJ）：改名后靠它对上当前名字。 */
  await archiveOutputs({
    workflowName: name,
    ...res.declaredOutputs === undefined ? {} : { declaredOutputs: res.declaredOutputs },
    /* 本次运行的节点汇报（契约 AN）：从已收集的节点明细里汇总 ——
     * 与运行历史里显示的是同一份数据。 */
    ...sumReports().length === 0 ? {} : { reports: sumReports() },
    ok: succeeded,
    ...res.id === undefined ? {} : { workflowId: res.id },
    ...succeeded ? {} : { error: res.error },
    via,
    runId,
    startedAt,
    endedAt: Date.now(),
  })

  return {
    ok: succeeded,
    summary,
    outputs: res.declaredOutputs ?? {},
    runId,
  }
}

/**
 * 跑一个任务并**把结果写回任务表**（到点跑与手动「立即执行」都走它）。
 *
 * @param taskId - 任务 id。
 * @param dispatch - 派发函数。
 * @param opts - 同 `runTaskOnce`。
 * @returns 结果；任务不存在给 `ok:false`。
 */
export async function runTaskById(
  taskId: string,
  dispatch: ScheduleDispatch,
  opts: {
    library?: readonly NodeDef[]
    workdir?: string
    prefs?: unknown
    via?: string
  } = {},
): Promise<ScheduleRunResult> {
  const tasks = await loadTasks()
  const task = tasks.find(t => t.id === taskId)
  if (task === undefined) return { ok: false, summary: '没有这个任务：' + taskId, outputs: {}, runId: '' }
  if (running.has(taskId)) return { ok: false, summary: '这个任务正在跑，别叠着开', outputs: {}, runId: '' }
  running.add(taskId)
  try {
    const r = await runTaskOnce(task, dispatch, opts)
    const now = Date.now()
    await updateTasks(list => list.map(t => t.id === taskId
      ? { ...t, lastRunAt: now, lastResult: (r.ok ? '成功：' : '失败：') + r.summary, lastRunDate: ymd(new Date(now)) }
      : t))
    return r
  } finally {
    running.delete(taskId)
  }
}

/**
 * 扫一遍任务表，把「到点了、今天还没跑」的那些跑掉。
 *
 * @param dispatch - 派发函数。
 * @param opts - 同 `runTaskOnce`。
 * @param now - 当前时间（测试可注入）。
 * @returns 这次跑了哪几个任务 id。
 */
export async function tick(
  dispatch: ScheduleDispatch,
  opts: {
    library?: readonly NodeDef[]
    workdir?: string
    prefs?: () => Promise<unknown>
    via?: string
  } = {},
  now: Date = new Date(),
): Promise<string[]> {
  const tasks = await loadTasks()
  const today = ymd(now)
  const minute = hm(now)
  const due = tasks.filter(t => t.enabled && t.time === minute && t.lastRunDate !== today)
  const ran: string[] = []
  /* ## 这里是**串行**，不是漏写 `Promise.all`
   *
   * 一个任务 `await` 完才进下一个。下面四条写清为什么 ——
   * 别把这一行当成「顺手就改了」的性能优化点。
   *
   * ### 一、为什么不能并行：五份巡查只共用**三套**浏览器会话
   *
   * 会话标签由 `scripts/build-patrol-workflows.mjs` 的 `session: spec.tag` 决定
   * （名单在 `scripts/patrol/jobs.mjs` 的 `PATROL_JOBS[].tag`）：
   *
   * | 任务 | 会话 |
   * | --- | --- |
   * | 巡查-天猫-店铺数据 / 巡查-天猫-活动报名 | 天猫 |
   * | 巡查-抖音-店铺数据 / 巡查-抖音-活动报名 | 抖音 |
   * | 巡查-抖音-千川余额 | 千川 |
   *
   * 同会话的两份是**同一个已登录浏览器**。并行就等于两个工作流同时在一个页面上
   * `goto` / `eval`，互相把对方的页面导航走，读到的文本是另一份的。
   * 这种坏法**不报错**：结果照样落盘，只是数字不是那一页的。
   *
   * ### 二、用户 2026-10-30 已决定**不做并行**
   *
   * 原话：「保持串行……如果并行的话，要做防护手段，又要调试怕出错什么的，
   * 但是其实这些任务本身就一会就跑完了，现在并没有并行刚需，
   * 并行又好处，但是只是看起来美好实际意义不大。」
   *
   * 即：省下的时间是分钟级，换来的是「按会话加锁 + 出错时的并发排查」，不值。
   *
   * ### 三、将来真要并行，先做这两件事
   *
   *   ① **按 `session` 分组**：同会话的排队、不同会话的才可同时。
   *      分组信息要从工作流存档里的 `browser.act` 节点读，不能按任务名猜。
   *   ② 接上 `sharedRunQueue`（`src/workflow/run-queue.ts:189`，宿主半那个模块级单例），
   *      否则同一会话的锁与「立即运行」那条入口各管一段，等于没锁。
   *      ⚠️ 它现在**按工作流名排队**（`src/index.ts:1084` 传的是 `snap.workflowId`），
   *      要按会话串就得先能拿到「这次要用哪个会话」—— 那是新能力，不是改个参数。
   *
   * 加完这两件事之前，别把下面的 `for` 换成 `Promise.all`。
   * `tests/schedule-serial.mjs` 有一条断言盯着「五个任务里至少两份共用会话」，
   * 换成并行时它会红 —— 那不是测试老，那是它在提醒这件事。 */
  for (const t of due) {
    if (running.has(t.id)) continue
    running.add(t.id)
    try {
      const prefs = opts.prefs === undefined ? undefined : await opts.prefs()
      const r = await runTaskOnce(t, dispatch, { ...opts, prefs })
      const at = Date.now()
      await updateTasks(list => list.map(x => x.id === t.id
        ? { ...x, lastRunAt: at, lastResult: (r.ok ? '成功：' : '失败：') + r.summary, lastRunDate: ymd(new Date(at)) }
        : x))
      /* 失败才发系统通知 —— 成功不必打扰（用户定的是「失败并提醒」，
       * 见计划 §七 未决问题第 3 条：不自动重试，失败并提醒）。
       *
       * ⚠️ 用户 2026-10-22 把提醒拆成**两项独立设置**（`src/notify/prefs.ts`）：
       * 这里只看 `failNotify`（失败类发不发）。`alertMinLevel` 管的是预警节点，
       * 与定时任务失败无关。
       * **只影响发不发通知**，`lastResult` 那两处写法一个字都不动
       * （记录是「跑过什么」，通知是「要不要打扰人」—— 两件事）。
       * 读偏好失败由 `readNotifyPrefs()` 自己吞掉并回默认值，不会把这一轮扫表搞崩。 */
      if (!r.ok && (await readNotifyPrefs()).failNotify) {
        void notify('定时任务失败：' + t.name, r.summary)
      }
      ran.push(t.id)
    } finally {
      running.delete(t.id)
    }
  }
  return ran
}

/**
 * 起「每分钟扫一次」的定时器。
 *
 * ## 为什么返回 stop 而不是自己管生命周期
 *
 * 定时器必须能被 `ctx.effect` 收掉 —— 插件卸载、测试收尾、热重载时
 * 留一个走得动的 `setInterval` 会**一直跑**（还带着旧闭包）。所以这里只造、只返回清理函数，
 * 注册与清理由调用方（`src/index.ts` 的 `ctx.effect`）负责。
 *
 * @param dispatch - 派发函数。
 * @param opts - 同 `tick`。
 * @param opts.intervalMs - 扫描间隔（默认 60 秒；测试给小值）。
 * @returns 停止函数。
 */
export function startScheduler(
  dispatch: ScheduleDispatch,
  opts: {
    library?: readonly NodeDef[]
    workdir?: string
    prefs?: () => Promise<unknown>
    via?: string
    intervalMs?: number
  } = {},
): () => void {
  const every = opts.intervalMs !== undefined && opts.intervalMs > 0 ? opts.intervalMs : 60_000
  let stopped = false
  let busy = false
  /** 一次扫描（上一轮没跑完就跳过，不叠）。 */
  const beat = (): void => {
    if (stopped || busy) return
    busy = true
    void tick(dispatch, opts).catch(() => { /* 单次失败不影响下一分钟 */ }).finally(() => { busy = false })
  }
  const timer = setInterval(beat, every)
  /* 不因为「多了一个定时器」而让进程退不掉（dsh 本身是常驻服务，这一条只是礼貌）。 */
  if (typeof timer.unref === 'function') timer.unref()
  /* 起来时先扫一次：万一正好是那一分钟（或插件在 09:30 之后才起来、又刚好同一分钟）。
   * ⚠️ 不补跑**错过的时间**（09:31 才起来不会补 09:30）—— 见计划 §七 第 3 条：
   * 失败了提醒、不自动重试；错过就等明天，别在用户不知情时突然开采集。 */
  beat()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
