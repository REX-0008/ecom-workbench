/** 工作流派发器（核心）。
 *
 * 设计依据：docs/机制-设计依据.md §1；原始调研 docs/调研-派发器现成实现.md、docs/调研-工作流引擎-设计要点.md。
 *
 * 核心思想：**引擎只决定「谁执行」，不自己执行**——这正是 dsh 的原生范式。
 *   谁执行 → 每个节点声明 executor（shell / agent / http / builtin）
 *   怎么排队 → p-queue（dsh-jobs-local 超限是「拒绝」不是「排队」，要在它前面排队）
 *   怎么起进程 → **dsh 自带 ctx.subprocess**（spawn / AbortSignal 取消 / 杀树 / 优雅终止）
 *   怎么算超时 → ctx.subprocess 的 timedOut 与 aborted 是**首次原因分类**（超时 ≠ 被取消）
 *
 * 六态：idle / queued / running / success / failed / missing
 *   queued 由本文件（p-queue）管；running 及之后由执行方适配器管。
 *
 * 三条必须钉住的实现点（调研结论）：
 *   1. 失败三态（stop/continue/continueErrorOutput）**在派发器外面判**——属图的走边策略。
 *   2. 幂等 = 认领即写 + 看影响行数（影响 0 行即没抢到）。
 *   3. terminate() 之后**必须 await waitForExit()**——只 terminate 会漏掉孙进程。
 */
import type { LlmTrace } from './llm-trace.ts'
import type { NodeReport } from './executors.ts'

/** 节点状态（六态 + 取消）。
 *
 * 取消**不复用 idle**：idle 是「还没跑过」，取消是「跑了但被叫停」，两者事实不同。
 * 原先取消直接写回 idle，等于丢掉了「用户主动停过」这个信息。 */
export type RunState = 'idle' | 'queued' | 'running' | 'success' | 'failed' | 'missing' | 'cancelled'
/** 执行方。 */
export type ExecutorKind = 'shell' | 'agent' | 'http' | 'builtin'

/** 派发给执行方的请求（要给「相对完整」的命令）。 */
export interface DispatchRequest {
  /** 本次运行 id。 */
  runId: string
  /** 节点实例 id。 */
  nodeId: string
  /** 派发给谁。 */
  executor: ExecutorKind
  /** 执行方各自解释的命令体。 */
  command: unknown
  /** 上下文：让执行方不依赖外部状态。 */
  context: {
    /** 所属工作流 id。 */
    workflowId: string
    /** 上游节点的输出（数据流）。 */
    upstream: unknown[]
    /** 工作目录。 */
    workdir: string
    /** 额外环境变量。 */
    env?: Record<string, string>
  }
  /** 可取消信号（执行层必备）。 */
  signal?: AbortSignal
  /**
   * 本节点自己的超时（毫秒，可选，2026-10-25 加，内容板块 Step 0.3）。
   *
   * ## 与 `DispatcherOptions.timeoutMs` 是**两处不同的东西**
   *
   * `DispatcherOptions.timeoutMs` 是派发器**构造时**给的全局兜底（`index.ts:516` 那份）；
   * 这里是**这一次请求**要用的值。`withTimeout` 里优先用自己的，没有才回落全局。
   *
   * ## 为什么要它
   *
   * 生图 / 生视频一条几分钟起，最长十几分钟 —— 而全局兜底是 300 秒。
   * 没有这个字段就只有两条烂路：把全局调大（让所有普通节点也失去保护），
   * 或者每生一次图就被判超时。
   *
   * ⚠️ **不填就与改动前完全一致**（`undefined` 走全局），现有工作流行为一个字节不变。
   */
  timeoutMs?: number
}

/** 执行方的返回。 */
export interface DispatchResult {
  /** 结局。 */
  status: 'success' | 'failed' | 'cancelled'
  /** 供下游节点使用的输出。 */
  output?: unknown
  /** 日志行。 */
  logs?: string[]
  /** 失败原因。 */
  error?: string
  /** 是否因超时结束（与「被取消」区分）。 */
  timedOut?: boolean
  /**
   * 这次执行留下的**模型调用痕迹**（只有 `agent` 执行方会给）。
   *
   * 2026-10-23 加：`ai.agent` 节点跑完原来只剩一句文本，谁调的模型、花了多少 token、
   * 为什么结束 —— 一样都不留。形状定义在 `llm-trace.ts`（三方共用一份）。
   * ⚠️ 不是模型调用的节点**不写这个键**（不写 `null`、不写 `{}`）。
   */
  llm?: LlmTrace
  /**
   * 本次节点**主动报上来的事**（2026-10-25 加，契约 AN）。
   *
   * 节点通过 `ctx.report(entry)` 推一条，执行方收集后随结果带回来。
   * 最终由上层汇总进「任务记录」，用户事后翻记录就能看到「哪个节点做了什么」，
   * 不必回运行历史里翻日志。
   *
   * ⚠️ 与 `llm` 同一条纪律：**没有汇报就不写这个键**（不写 `[]`、不写 `undefined`）。
   */
  reports?: NodeReport[]
}

/** 一个执行方适配器。 */
export interface Executor {
  /** 适配器名（与 ExecutorKind 对应）。 */
  kind: ExecutorKind
  /**
   * 执行一次派发。
   * @param req - 派发请求。
   * @returns 执行结果。
   */
  run(req: DispatchRequest): Promise<DispatchResult>
}

/** 一次运行在派发器里的记录。 */
export interface RunRecord {
  /** 运行 id。 */
  id: string
  /** 节点实例 id。 */
  nodeId: string
  /** 当前状态（六态）。 */
  state: RunState
  /** 开始时间（ms）。 */
  startedAt: number
  /** 结束时间（ms）。 */
  endedAt?: number
  /** 日志（最近的，上限见 MAX_LOGS）。 */
  logs: string[]
  /** 失败原因。 */
  error?: string
  /**
   * 本节点的输出（截断后）。
   *
   * 为什么要存进记录：用户跑完最想看的就是「这一步到底产出了什么」。
   * 截断是因为输出可能很大（一份商品列表 JSON），记录里只留能看懂的前一段。
   */
  outputPreview?: string
  /** 输出是否被截断（界面要据此提示「只显示了前一段」）。 */
  outputTruncated?: boolean
  /** 本次请求的节点类型 id（`def.id`），供界面显示成人看得懂的名字。 */
  defId?: string
}

/** 每次运行最多保留的日志行数。 */
const MAX_LOGS = 200

/**
 * 记录里保留的输出字符上限。
 *
 * 定 4000：够看清一份小结果（几个字段的 JSON），又不至于让记录列表变成大文件。
 * 超出会标记「已截断」，界面据此提示用户去看完整输出。
 */
const OUTPUT_PREVIEW = 4000

/** 派发器配置。 */
export interface DispatcherOptions {
  /** 同时最多跑几个节点。 */
  concurrency?: number
  /** 单节点超时（ms）。 */
  timeoutMs?: number
  /** 状态变化回调（供 UI 推送）。 */
  onChange?: (rec: RunRecord) => void
  /** 需要子进程时的 spawn 实现（从 dsh 的 ctx.subprocess 取，没有则回退到 node 内置）。 */
  spawn?: (spec: { argv: string[], cwd?: string, env?: Record<string, string>, signal?: AbortSignal }) => {
    pid?: number
    terminate: () => void
    waitForExit: () => Promise<boolean>
    stdoutText: () => string
    stderrText: () => string
  }
}

/**
 * 工作流派发器。
 *
 * 用法：register(适配器) → dispatch(请求) → onState 读状态。
 * 排队由内部 p-queue 负责（并发超限时新任务进入 queued，而不是像 dsh-jobs-local 那样直接拒绝）。
 */
export class WorkflowDispatcher {
  private readonly runs = new Map<string, RunRecord>()
  private readonly executors = new Map<ExecutorKind, Executor>()
  private readonly opts: Required<Omit<DispatcherOptions, 'spawn'>> & Pick<DispatcherOptions, 'spawn'>
  private queue: { add: <T>(fn: () => Promise<T>) => Promise<T>, clear: () => void, size: number, pending: number } | null = null
  private seq = 0

  /**
   * 建派发器。
   * @param options - 配置。
   */
  constructor(options: DispatcherOptions = {}) {
    this.opts = {
      concurrency: options.concurrency ?? 2,
      timeoutMs: options.timeoutMs ?? 300000,
      onChange: options.onChange ?? (() => { /* 无订阅者 */ }),
      spawn: options.spawn,
    }
  }

  /**
   * 注册一个执行方适配器（重复注册同名会覆盖）。
   * @param ex - 适配器。
   */
  register(ex: Executor): void {
    this.executors.set(ex.kind, ex)
  }

  /**
   * 用外部队列工厂初始化（避免直接 import p-queue，便于测试替换）。
   * @param factory - 返回队列实例的工厂。
   */
  useQueue(factory: () => { add: <T>(fn: () => Promise<T>) => Promise<T>, clear: () => void, size: number, pending: number }): void {
    this.queue = factory()
  }

  /**
   * 派发一个节点。
   * @param req - 派发请求。
   * @returns 执行结果。
   */
  async dispatch(req: DispatchRequest): Promise<DispatchResult> {
    const id = req.runId === '' ? 'run-' + String(++this.seq) : req.runId
    const rec: RunRecord = {
      id, nodeId: req.nodeId, state: 'queued', startedAt: Date.now(), logs: [],
      defId: (req.command as { node?: string } | undefined)?.node,
    }
    this.runs.set(id, rec)
    this.emit(rec)

    /** 实际执行（交给队列）。 */
    const exec = async (): Promise<DispatchResult> => {
      rec.state = 'running'
      rec.startedAt = Date.now()
      this.emit(rec)

      const ex = this.executors.get(req.executor)
      if (ex === undefined) {
        rec.state = 'failed'
        rec.error = '没有注册执行方：' + req.executor
        this.emit(rec)
        return { status: 'failed', error: rec.error }
      }

      try {
        const result = await this.withTimeout(ex, req, id)
        rec.logs = (rec.logs).concat(result.logs ?? []).slice(-MAX_LOGS)
        rec.state = result.status === 'success' ? 'success' : result.status === 'cancelled' ? 'cancelled' : 'failed'
        rec.error = result.error
        /* 输出摘要：用户跑完最想看「这一步产出了什么」。 */
        if (result.output !== undefined) {
          const text = typeof result.output === 'string' ? result.output : JSON.stringify(result.output)
          rec.outputTruncated = text.length > OUTPUT_PREVIEW
          rec.outputPreview = rec.outputTruncated ? text.slice(0, OUTPUT_PREVIEW) + ' …' : text
        }
        rec.endedAt = Date.now()
        this.emit(rec)
        return result
      } catch (e) {
        rec.state = 'failed'
        rec.error = e instanceof Error ? e.message : String(e)
        rec.endedAt = Date.now()
        this.emit(rec)
        return { status: 'failed', error: rec.error }
      }
    }

    return this.queue === null ? exec() : this.queue.add(exec)
  }

  /**
   * 带超时的执行（超时与「被取消」分开报告）。
   *
   * ## 为什么要把外部信号接到自己那个 `ac` 上（2026-10-23）
   *
   * 这里原本自己建了一个 `AbortController` 给执行方用（为了能区分「超时」与其它失败），
   * 但 `{ ...req, signal: ac.signal }` 那一行**把调用方传进来的信号盖掉了**，
   * 而且没监听它 —— 于是用户点「停止」（`/run` 路由的 `ac.abort()`）传到这里就断了，
   * 界面上的停止按钮是个**假按钮**：节点照跑，直到自己结束或撞到 300 秒。
   *
   * 现在两路都接到同一个 `ac` 上：
   *   - 超时 → `timedOut = true` + abort（结果标 `failed` + `timedOut: true`）；
   *   - 用户取消 → 只 abort，**不动 `timedOut`**（执行方据此返回 `cancelled`）。
   *
   * ⚠️ 监听用 `{ once: true }` 并在 `finally` 里移除 —— 派发器是长寿命单例，
   * 每次派发挂一个不移除的监听会一直累积（一份运行跑几百个节点就是几百个监听）。
   *
   * @param ex - 执行方。
   * @param req - 请求。
   * @param id - 运行 id。
   * @returns 结果。
   */
  private async withTimeout(ex: Executor, req: DispatchRequest, id: string): Promise<DispatchResult> {
    let timedOut = false
    /* 本请求自己的超时优先（契约 AV Step 0.3）：没给才回落全局兜底。
     * ⚠️ 判 `> 0` 而不是 `!== undefined` —— 0 与负数当「没填」处理，
     * 否则一个笔误的 0 会让节点**立刻**判超时（那种失败看着像代码坏了）。 */
    const own = req.timeoutMs
    const budget = typeof own === 'number' && Number.isFinite(own) && own > 0 ? own : this.opts.timeoutMs
    const ac = new AbortController()
    const timer = setTimeout(() => { timedOut = true; ac.abort() }, budget)
    /* 外部取消（用户点停止 / 客户端断开）接到自己的信号上。 */
    const outer = req.signal
    const onOuterAbort = (): void => { ac.abort() }
    if (outer !== undefined) {
      if (outer.aborted) onOuterAbort()
      else outer.addEventListener('abort', onOuterAbort, { once: true })
    }
    try {
      const merged: DispatchRequest = { ...req, runId: id, signal: ac.signal }
      const r = await ex.run(merged)
      if (!timedOut) return r
      /* ## 超时必须报成 `failed`，即使执行方说 `cancelled`（2026-10-23 加）
       *
       * 超时是**从上面 abort 的**，执行方看到的只是一个「信号被 abort」——
       * 它分不清是超时还是用户点停止，于是如实报 `cancelled`。
       * 但界面上这是两件事：用户看到「已取消」会以为自己点过停止、去查是谁停的。
       * 所以这个判定归**知道真相的这层**：`timedOut` 为真就改判成 `failed` 并带上标记。 */
      return {
        ...r,
        status: 'failed',
        timedOut: true,
        error: r.error ?? '执行超时（' + String(budget) + ' 毫秒）',
      }
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    }
  }

  /**
   * 推送状态变化。
   * @param rec - 运行记录。
   */
  private emit(rec: RunRecord): void {
    try { this.opts.onChange(rec) } catch { /* 订阅者出错不影响派发 */ }
  }

  /**
   * 读所有运行记录。
   * @returns 记录数组。
   */
  list(): RunRecord[] {
    return [...this.runs.values()]
  }

  /**
   * 读一条运行记录。
   * @param id - 运行 id。
   * @returns 记录或 undefined。
   */
  get(id: string): RunRecord | undefined {
    return this.runs.get(id)
  }

  /** 清空所有记录（队列里等待的也一起清）。 */
  clear(): void {
    this.runs.clear()
    this.queue?.clear()
  }
}
