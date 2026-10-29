/** 运行现场（**可存成 JSON** 的那一份）—— 暂停与恢复用。
 *
 * ## 为什么单独一个文件
 *
 * `run.ts` 里的现场是**闭包里的内存对象**（`outputs` / `ran` / `unreachable` / 循环轮次），
 * 序列化不了。要做暂停恢复，必须先回答一个问题：
 * **「一份运行要继续下去，最少需要哪些状态？」** 答案就是本文件里的 `RunSnapshot`。
 *
 * ## 两条纪律
 *
 *  1. **纯**：不 import 任何 Node 内置模块 —— `run.ts` 是画布与宿主半**共用**的，
 *     引了 `node:fs` 画布就打不出来了。落盘在 `pause-store.ts`（只宿主半引）。
 *  2. **只存「跑出来的东西」**：节点定义与连线**不进现场** —— 它们在存档里，
 *     恢复时按引用重新读一遍。存了就会出现两份真值（现场是旧版、存档已改过）。
 *
 * ## 逐字段：少了哪一个会怎样
 *
 * | 字段 | 少了会怎样 |
 * | --- | --- |
 * | `outputs` | 恢复后下游取不到上游数据 —— 表现为「恢复后第一个节点拿不到输入」 |
 * | `ran` | 运行历史里「跑了哪些节点」从恢复处重新数，前半段凭空消失 |
 * | `executions` | 「实际派发次数」偏小（循环时它本来就会大于 `ran.length`） |
 * | `unreachable` | 已判「未走的分支」的节点恢复后会被当成「还没轮到」而照跑 |
 * | `inputs` | 恢复时拿不到开始节点声明的那批值（`{{日期}}` 之类会变空） |
 * | `resumeAfter` | 不知道从哪接着跑 —— 只能整份重跑，那就不是恢复了 |
 *
 * ## ⚠️ `undefined` 会被 JSON 吃掉
 *
 * `JSON.stringify` 会把值为 `undefined` 的键丢掉。所以存盘前**主动跳过**没产出的节点，
 * 恢复后它们等于「没跑过」—— 与 `upstreamOf` 里「过滤掉没值的上游」是同一条语义，
 * 行为一致，不会出现「存之前有、恢复后没有」的静默坏值。
 */

/**
 * 等待节点的三种恢复方式。
 *
 * - `duration` —— 等一段时长（自动继续）
 * - `until` —— 等到某个时刻（自动继续）
 * - `manual` —— **停下等人点「继续」**（2026-10-22 加；登录过期这类「等到几点都没用」的场景）
 */
export type WaitMode = 'duration' | 'until' | 'manual'

/**
 * 「一直等人」模式下的 `resumeAtMs` 取值（永不自动到点）。
 *
 * ## 为什么是这个数（JSON 往返的硬约束）
 *
 * 扫盘器（`src/index.ts`）现有的判据只有一条：`snap.wait.resumeAtMs > now` 就跳过。
 * 所以「永不自动继续」必须落成一个**永远大于当前时间**的数。
 *
 * 三个候选、两个不行：
 *   · `Number.POSITIVE_INFINITY` —— `JSON.stringify(Infinity)` 得到 `null`，
 *     读回来 `typeof` 是 object，`asSnapshot` 的 `Number.isFinite` 判失败，
 *     **整份现场作废**（挂起的运行直接消失）。
 *   · `0` —— JSON 没问题，但 `0 > now` 为假，扫盘器会**立刻把它捡起来自动续跑**，
 *     那正是「等人」最不能出现的行为。
 *   · `Number.MAX_SAFE_INTEGER`（本常量）—— 有限、JSON 往返**精确不失真**
 *     （`String(9007199254740991)` 解析回来还是它），且永远大于任何真实时刻。
 *
 * 所以选第三个：不依赖「扫盘器认识 manual」这件事，只依赖「它永远不到点」。
 * 这样也就不用改扫盘器 —— 它那一行 `resumeAtMs > now` 的判据天然跳过。
 */
export const WAIT_MANUAL_FOREVER_MS = Number.MAX_SAFE_INTEGER

/** 一次挂起要等什么、什么时候该继续。 */
export interface WaitPlan {
  /** 怎么恢复。 */
  mode: WaitMode
  /**
   * 计划恢复的时刻（毫秒时间戳）。
   *
   * `manual` 模式没有超时时是 `WAIT_MANUAL_FOREVER_MS`（永不自动继续）；
   * 设了超时则是**超时的那个时刻** —— 到点由扫盘器捡起，恢复时判为失败。
   */
  resumeAtMs: number
  /** 实际要等的毫秒数（`until` 模式下是算出来的剩余量；`manual` 无超时时是 0）。 */
  ms: number
  /** `until` 模式填的时刻文本（`HH:MM`，便于回看「当时等的是几点」）。 */
  until?: string
  /**
   * `manual` 模式的超时时刻（毫秒时间戳）；不限超时时没有这个字段。
   *
   * 为什么单独存一份而不是从 `resumeAtMs` 反推：无超时时 `resumeAtMs` 是
   * `WAIT_MANUAL_FOREVER_MS`，那个值反推不出「有没有设超时」。
   */
  timeoutAtMs?: number
  /** `manual` 模式设的超时小时数（回看「当时填的是几小时」）。 */
  timeoutHours?: number
}

/** 一份运行继续下去需要的全部状态。 */
export interface RunSnapshot {
  /** 形状版本（以后改字段时靠它判断能不能读）。 */
  version: 1
  /** 这次运行的 id（也是 `paused/<runId>.json` 的文件名）。 */
  runId: string
  /** 哪份工作流（解析出来的名字 —— 恢复时按它重新读存档）。 */
  workflowId: string
  /** 这次运行开始的时间（毫秒）。 */
  startedAt: number
  /** 挂起的时刻（毫秒）。 */
  pausedAt: number
  /**
   * 从**哪个节点之后**继续（= 挂起那个等待节点的 id）。
   *
   * 恢复时跳过它本身、从它的下游接着跑。为什么不是「从哪个节点开始」：
   * 等待节点自己的输出（上游原样穿过去）已经存在 `outputs` 里了，
   * 再跑一次它会再挂一次 —— 无限循环。
   */
  resumeAfter: string
  /** 已经跑过的节点（去重，顺序即执行顺序）。 */
  ran: string[]
  /** 实际派发次数。 */
  executions: number
  /** 每个节点的输出（JSON 化的那份）。 */
  outputs: Record<string, unknown>
  /** 已判定「未走的分支」的节点 id。 */
  unreachable: string[]
  /** 本次运行实际生效的输入（开始节点声明 + 外部给值）。 */
  inputs: Record<string, unknown>
  /** 挂起在等什么。 */
  wait: WaitPlan
  /**
   * 挂起那一刻，这份工作流存档的**执行指纹**（票 17，2026-10-27）。
   *
   * ## 它防的是什么
   *
   * 存了现场但没存「当时工作流长什么样」，恢复时不管改没改都按旧现场往下跑。
   * 用户改过节点参数、删过节点，点「继续」后界面显示成功，实际跑的是旧数据 ——
   * **这比报错更糟，因为看不出来**。恢复前拿它比一次，不一致就拒绝。
   *
   * ## ⚠️ 可选：老现场没有这个键
   *
   * 加了它之后，磁盘上已有的现场都读不到指纹。那种情况按**「当它一致」**处理
   * 并记一笔日志 —— 拒绝一个本来能恢复的现场，用户会失去一次已跑一半的工作
   * （那比「多跑一次旧数据」更让人心疼，而且旧数据至少是他自己改之前的样子）。
   * 算法与算哪些字段见 `fingerprint.ts`。
   */
  fingerprint?: string
  /**
   * 这份现场**已经被拒绝恢复过**，以及拒绝的原因（票 17）。
   *
   * ## 为什么必须有它
   *
   * 自动恢复每 30 秒扫一遍盘。指纹对不上时若只是「拒绝并留现场」，
   * 扫盘器会**每一轮都把它捡起来、每一轮都拒一次**，于是用户每分钟收到一条
   * 「恢复失败」通知，直到他手动点取消 —— 一次改动变成持续噪音。
   *
   * 所以拒绝时把它写回现场，扫盘器看到它就跳过。**现场仍然留着**：
   * 用户可能把工作流改回挂起时的样子，那时手动点「继续」会重新核一次，核过就放行
   * （放行这条路会把现场删掉，标记自然跟着消失）。
   */
  resumeBlocked?: string
}

/**
 * 一次挂起最多等多久（上限）。
 *
 * 为什么要上限：`setTimeout` 超过约 24.8 天就会**立刻触发**（32 位上限），
 * 那会让「等 30 天」变成「马上继续」—— 静默的坏行为。所以这里明着拦，
 * 取 20 天（留余量），超了就给一句可读的错。
 */
export const WAIT_MAX_MS = 20 * 24 * 60 * 60 * 1000

/**
 * 把 `HH:MM` 解析成「下一个这个时刻」。
 *
 * 语义：**今天这个点还没到就是今天，过了就是明天**（与「等到明天 09:30」的直觉一致）。
 *
 * @param text - 形如 `09:30` 的文本。
 * @param now - 现在（毫秒时间戳）。
 * @returns 目标时刻；格式不对给 null。
 */
export function nextHm(text: string, now: number): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (m === null) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null
  const d = new Date(now)
  d.setSeconds(0, 0)
  d.setHours(h, min, 0, 0)
  let at = d.getTime()
  if (at <= now) at += 24 * 60 * 60 * 1000
  return at
}

/**
 * 从等待节点的参数读出「等多久 / 等到几点 / 等人点继续」。
 *
 * ⚠️ 一律**不猜**：参数不完整、时刻写错、超过上限，都返回一句可读的错，
 * 由调用方（`runWait`）当节点失败报出去。静默给个默认值最难查
 * （用户明明填了 09:30，它却按 5 秒跑）。
 *
 * ## `manual`（等人点继续，2026-10-22 加）
 *
 * 不算时刻、不设「等到几点」；`resumeAtMs` 取 `WAIT_MANUAL_FOREVER_MS`（永不到点，
 * 理由见那个常量的说明）。
 *
 * **可选超时**（借 Dify 的 `timeout`，不借它的表单与邮件）：`timeoutHours` 填了
 * 就是「最多等 N 小时」。到点后**判为失败**、不是静默继续 —— 登录过期这种事
 * 静默继续只会让后面的步骤继续失败，而失败原因看起来与本节点无关。
 *
 * @param params - 节点实例参数（已合并定义默认值）。
 * @param now - 现在（毫秒；测试可注入）。
 * @returns 计划，或一句错。
 */
export function readWaitPlan(
  params: Record<string, unknown>,
  now: number,
): { ok: boolean, plan?: WaitPlan, error?: string } {
  const mode: WaitMode = params.mode === 'until'
    ? 'until'
    : params.mode === 'manual' ? 'manual' : 'duration'
  if (mode === 'manual') {
    const rawHours = params.timeoutHours
    /* 非法值按「不限」处理：它是可选的防呆，写错不该让整条流程跑不起来。
     * 但**负数**要拦住 —— 那看起来像「设了超时」，实际会算出一个过去的时刻。 */
    const hours = typeof rawHours === 'number' && Number.isFinite(rawHours) ? rawHours : 0
    if (hours < 0) return { ok: false, error: '「超时」不能是负数（0 = 一直等人点继续）：' + String(hours) }
    if (hours === 0) {
      return { ok: true, plan: { mode, resumeAtMs: WAIT_MANUAL_FOREVER_MS, ms: 0 } }
    }
    const timeoutMs = Math.round(hours * 3600 * 1000)
    if (timeoutMs > WAIT_MAX_MS) {
      return { ok: false, error: '「超时」太久了（上限 20 天，这次填了 ' + String(hours) + ' 小时）' }
    }
    const at = now + timeoutMs
    return { ok: true, plan: { mode, resumeAtMs: at, ms: timeoutMs, timeoutAtMs: at, timeoutHours: hours } }
  }
  if (mode === 'until') {
    const text = typeof params.until === 'string' ? params.until.trim() : ''
    if (text === '') return { ok: false, error: '「等到几点」没填（形如 09:30）' }
    const at = nextHm(text, now)
    if (at === null) return { ok: false, error: '「等到几点」格式不对（要 HH:MM，如 09:30）：' + text }
    const ms = at - now
    if (ms > WAIT_MAX_MS) {
      return { ok: false, error: '等太久了（上限 20 天，这次要等 ' + String(Math.round(ms / 3600000)) + ' 小时）' }
    }
    return { ok: true, plan: { mode, resumeAtMs: at, ms, until: text } }
  }
  const raw = params.ms
  const ms = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 5000
  if (ms > WAIT_MAX_MS) {
    return { ok: false, error: '等太久了（上限 20 天，这次要等 ' + String(Math.round(ms / 3600000)) + ' 小时）' }
  }
  return { ok: true, plan: { mode, resumeAtMs: now + ms, ms } }
}

/**
 * 判断一个读回来的对象是不是能用的现场（`paused/` 里的文件可能被手改坏）。
 *
 * @param value - 从磁盘读回来的任意值。
 * @returns 能用就返回它，否则 null（调用方当「没有这份现场」处理，不抛）。
 */
export function asSnapshot(value: unknown): RunSnapshot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (v.version !== 1) return null
  if (typeof v.runId !== 'string' || v.runId === '') return null
  if (typeof v.workflowId !== 'string' || v.workflowId === '') return null
  if (typeof v.resumeAfter !== 'string' || v.resumeAfter === '') return null
  if (typeof v.pausedAt !== 'number' || !Number.isFinite(v.pausedAt)) return null
  if (v.wait === null || typeof v.wait !== 'object') return null
  const w = v.wait as Record<string, unknown>
  if (typeof w.resumeAtMs !== 'number' || !Number.isFinite(w.resumeAtMs)) return null
  /* ⚠️ 老现场（`duration` / `until` 时代）没有 `mode: 'manual'`，落成两档之一即可 ——
   * 那两种的行为**一个字节都不许变**（这是本轮的红线）。 */
  const mode: WaitMode = w.mode === 'manual' ? 'manual' : w.mode === 'until' ? 'until' : 'duration'
  return {
    version: 1,
    runId: v.runId,
    workflowId: v.workflowId,
    startedAt: typeof v.startedAt === 'number' ? v.startedAt : v.pausedAt,
    pausedAt: v.pausedAt,
    resumeAfter: v.resumeAfter,
    ran: Array.isArray(v.ran) ? v.ran.filter((x): x is string => typeof x === 'string') : [],
    executions: typeof v.executions === 'number' && Number.isFinite(v.executions) ? v.executions : 0,
    outputs: v.outputs !== null && typeof v.outputs === 'object' && !Array.isArray(v.outputs)
      ? v.outputs as Record<string, unknown>
      : {},
    unreachable: Array.isArray(v.unreachable) ? v.unreachable.filter((x): x is string => typeof x === 'string') : [],
    inputs: v.inputs !== null && typeof v.inputs === 'object' && !Array.isArray(v.inputs)
      ? v.inputs as Record<string, unknown>
      : {},
    wait: {
      mode,
      resumeAtMs: w.resumeAtMs,
      ms: typeof w.ms === 'number' && Number.isFinite(w.ms) ? w.ms : Math.max(0, w.resumeAtMs - v.pausedAt),
      ...typeof w.until === 'string' ? { until: w.until } : {},
      ...typeof w.timeoutAtMs === 'number' && Number.isFinite(w.timeoutAtMs) ? { timeoutAtMs: w.timeoutAtMs } : {},
      ...typeof w.timeoutHours === 'number' && Number.isFinite(w.timeoutHours) ? { timeoutHours: w.timeoutHours } : {},
    },
    /* 指纹可选（票 17）：老现场没有这个键，读回来就是 `undefined` ——
     * 与 `until` / `timeoutAtMs` 同一条「没有就不写这个键」的纪律。 */
    ...typeof v.fingerprint === 'string' && v.fingerprint !== '' ? { fingerprint: v.fingerprint } : {},
    /* 「已拒绝恢复」的标记（票 17）：扫盘器据此跳过，别每分钟重复拒一次。 */
    ...typeof v.resumeBlocked === 'string' && v.resumeBlocked !== '' ? { resumeBlocked: v.resumeBlocked } : {},
  }
}

/**
 * 一份**从磁盘读回来的**现场，它的 `manual` 超时是不是已经过了。
 *
 * ## 为什么这个判断在这里（而不是扫盘器里）
 *
 * 扫盘器（`src/index.ts`）只认一条：`resumeAtMs > now` 就跳过。设了超时的
 * `manual` 现场 `resumeAtMs` 就是超时时刻，于是扫盘器会**到点把它捡起来恢复** ——
 * 而「超时」的结论只能在恢复时下（那时才知道要判失败）。
 *
 * ## 为什么超时 = 失败，不是静默继续
 *
 * 登录过期这类挂起，超时意味着**人始终没来处理**。这时继续往下跑，后面每一步都会
 * 因为没登录而失败，而错误看起来与本节点无关 —— 用户要去查一串莫名其妙的错。
 * 所以当场说清「等超时了」，由恢复入口按失败上报并提醒。
 *
 * @param wait - 现场的等待计划。
 * @param now - 现在（毫秒；测试可注入）。
 * @returns 超时了就返回一句可读的原因，否则 null。
 */
export function manualTimeoutReason(wait: WaitPlan, now: number): string | null {
  if (wait.mode !== 'manual') return null
  const at = wait.timeoutAtMs
  if (at === undefined || !Number.isFinite(at)) return null
  /* 到点那一刻就算超时（扫盘器的判据是 `resumeAtMs > now` 才跳过，
   * 所以 `now === at` 时它会把这份捡起来恢复 —— 这里必须同样认「已到点」。 */
  if (now < at) return null
  const hours = wait.timeoutHours === undefined ? String(Math.round((at - 0) / 3600000)) : String(wait.timeoutHours)
  return '「等待」节点的超时到了（等了 ' + hours + ' 小时仍没有人点继续）：'
    + '这次运行按失败结束，不会再自动继续。重新跑一次，或先处理好再手动恢复。'
}

/**
 * 「通知与等待」节点（`flow.alert-wait`）等人超时的原因。
 *
 * 与 `manualTimeoutReason` 是**两句话、两种处置**，所以不合并：
 *
 * | | `flow.wait` | `flow.alert-wait` |
 * | --- | --- | --- |
 * | 超时之后 | 整次运行按失败结束，后面一步都不跑 | 这个节点失败，**由失败出口上的下游接手** |
 * | 说给用户的话 | 「按失败结束，重新跑或手动恢复」 | 「人没有处理」—— 因为流程会自己往下走 |
 *
 * 把两句合成一句的后果：新节点超时之后流程还在跑，而文案说「这次运行按失败结束」——
 * 用户会以为整条停了，实际后面照跑，那个说法就是假的。
 *
 * ⚠️ 措辞是 lead 定的（票 07）：「等人超时（N 小时）：人没有处理」。
 * 前半截说清是什么失败，后半截点明是**人没来**而不是系统出错 ——
 * 运行历史里那个红节点因此能被正确理解。
 *
 * @param wait - 现场的等待计划。
 * @param now - 现在（毫秒；测试可注入）。
 * @returns 超时了就返回一句可读的原因，否则 null。
 */
export function alertTimeoutReason(wait: WaitPlan, now: number): string | null {
  if (wait.mode !== 'manual') return null
  const at = wait.timeoutAtMs
  if (at === undefined || !Number.isFinite(at)) return null
  if (now < at) return null
  const hours = wait.timeoutHours === undefined ? String(Math.round((at - 0) / 3600000)) : String(wait.timeoutHours)
  return '等人超时（' + hours + ' 小时）：人没有处理'
}
