/** 四类执行方适配器（shell / agent / http / builtin）。
 *
 * 设计依据：docs/机制-设计依据.md §1.1；原始调研 docs/调研-派发器现成实现.md
 *   - shell：**走 dsh 自带 ctx.subprocess**（spawn / 取消 / 杀树 / 优雅终止），不手搓进程管理
 *   - agent：走 dsh 的 ctx.subagents（借用 dsh 的 agent 系统，不自己实现）
 *   - http：用内置 fetch
 *   - builtin：直接调函数（在我们的进程里跑）
 *
 * 三条钉住的实现点：
 *   1. 失败三态在派发器外面判（属图的走边策略），适配器只报 status
 *   2. 幂等 = 认领即写 + 看影响行数
 *   3. terminate() 之后必须 await waitForExit()（否则漏掉孙进程）
 */
import type { DispatchRequest, DispatchResult, Executor } from './dispatcher.ts'
/* `formatTraceLine` 是**值**导入（不是 type）：那句话的拼法只该有一份
 * （界面也用它），自己再拼一遍必然漂成「这里写『模型 a/b』、那里写『a/b 模型』」。 */
import { formatTraceLine, type LlmTrace } from './llm-trace.ts'
/* 汇报的形状由引擎定（`model.ts` 不 import 任何东西，所以这边引得动）。
 * 不在这里再定一份：两份形状不一致时多出来的字段会静静丢掉。 */
import type { ReportEntry, BuiltinCtx } from '../workflow/model.ts'

/**
 * shell 执行方用的进程句柄（由宿主半注入，来自 dsh 的 ctx.subprocess）。
 *
 * 形状照 dsh 的真接口（已核实 `packages/subprocess/subprocess/src/types.ts`）：
 *   - done —— 进程退出事实（exitCode / signal），**不再有超时/取消分类**（那是调用方的事）
 *   - terminate + waitForExit —— 终止并等**整棵进程树**清空（只 terminate 会漏掉孙进程）
 *   - collected.stdout.readFrom(0) —— 非消费式读输出，settle 之后照样能读
 */
export interface SpawnHandleLike {
  /** 进程 id（可能没有）。 */
  pid?: number
  /** 请求终止（幂等）。 */
  terminate: () => void
  /** 等整棵进程树清空（true = 已清空，false = 等待被中止）。 */
  waitForExit: () => Promise<boolean>
  /** 进程退出事实。 */
  done: Promise<{ exitCode: number | null, signal: string | null }>
  /** 读 stdout（非消费式）。 */
  stdoutText: () => string
  /** 读 stderr（非消费式）。 */
  stderrText: () => string
}

/** shell 执行方用的 spawn 实现（宿主半把 dsh 的 subprocess 适配成这个形状）。 */
export interface SpawnLike {
  /**
   * 启动一个进程。
   * @param spec - 命令行、工作目录、环境变量、取消信号。
   * @returns 进程句柄。
   */
  spawn(spec: { argv: string[], cwd?: string, env?: Record<string, string>, signal?: AbortSignal }): SpawnHandleLike
}

/**
 * shell 执行方：跑一条命令。
 * @param spawner - spawn 实现（来自 dsh ctx.subprocess）。
 * @returns 适配器。
 */
export function createShellExecutor(spawner: SpawnLike): Executor {
  return {
    kind: 'shell',
    async run(req: DispatchRequest): Promise<DispatchResult> {
      const cmd = req.command as { argv?: string[], cwd?: string, env?: Record<string, string> } | undefined
      const argv = cmd?.argv
      if (argv === undefined || argv.length === 0) {
        return { status: 'failed', error: 'shell 命令为空（command.argv 缺失）' }
      }

      const logs: string[] = ['$ ' + argv.join(' ')]
      const child = spawner.spawn({
        argv,
        cwd: cmd?.cwd ?? req.context.workdir,
        env: { ...req.context.env, ...cmd?.env },
        signal: req.signal,
      })

      // 进程被取消（超时或手动）时，主动终止，并**等整棵树清空**
      if (req.signal !== undefined) {
        req.signal.addEventListener('abort', () => {
          try { child.terminate() } catch { /* 已退出 */ }
        }, { once: true })
      }

      /* 等退出事实。spawn 失败时会 reject（如找不到可执行文件），当成失败上报。 */
      let exit: { exitCode: number | null, signal: string | null }
      try {
        exit = await child.done
      } catch (e) {
        try { child.terminate() } catch { /* 已退出 */ }
        return { status: 'failed', error: e instanceof Error ? e.message : String(e), logs }
      }

      const out = child.stdoutText()
      const err = child.stderrText()
      if (out !== '') logs.push(out.trim())
      if (err !== '') logs.push('[stderr] ' + err.trim())

      if (req.signal?.aborted === true) {
        /* 被取消：终止并**等整棵树清空**，否则孙进程会留下来（dsh 明文提醒过这一点）。 */
        try { child.terminate() } catch { /* 已退出 */ }
        try { await child.waitForExit() } catch { /* 观察不到就算了，不能因此卡住 */ }
        return { status: 'cancelled', logs }
      }
      if (exit.exitCode === 0) return { status: 'success', output: out.trim(), logs }
      const why = err.trim() !== '' ? err.trim() : '退出码 ' + String(exit.exitCode)
      return { status: 'failed', error: why, logs }
    },
  }
}

/**
 * http 执行方：发一个 HTTP 请求（用内置 fetch）。
 * @returns 适配器。
 */
export function createHttpExecutor(): Executor {
  return {
    kind: 'http',
    async run(req: DispatchRequest): Promise<DispatchResult> {
      /* ⚠️ 命令体里的 `timeoutMs` **在这里不读**（契约 CG，2026-10-26）。
       *
       * 原来这里声明过 `timeoutMs?: number` 却一次都没用 —— 那正是「看着写了
       * 其实不生效」的典型：类型里有、行为里没有，下一个人读代码会以为超时归它管。
       *
       * 现在超时的唯一出口是**派发器**：`run.ts:1292` 的 `readTimeout` 读出三层
       * 优先级（实例参数 → 节点静态值 → 全局兜底）→ `DispatchRequest.timeoutMs`
       * → `withTimeout` 的定时器。执行方自己再算一次就有两套算法，迟早不一致。
       *
       * 所以类型里只留真正会读的字段，`timeoutMs` 删掉。
       * （`sys.http` 那边补上了 `timeoutParam: 'timeout'`，用户填的值现在真生效。） */
      const c = req.command as { method?: string, url?: string, headers?: Record<string, string>, body?: unknown } | undefined
      if (c?.url === undefined || c.url === '') {
        return { status: 'failed', error: 'http 请求缺少 url' }
      }
      const logs = ['→ ' + (c.method ?? 'GET') + ' ' + c.url]
      try {
        const init: RequestInit = { method: c.method ?? 'GET', headers: c.headers, signal: req.signal }
        if (c.body !== undefined && (c.method ?? 'GET') !== 'GET') init.body = JSON.stringify(c.body)
        const res = await fetch(c.url, init)
        const text = await res.text()
        logs.push('← ' + String(res.status) + ' （' + String(text.length) + ' 字节）')
        if (!res.ok) return { status: 'failed', error: 'HTTP ' + String(res.status), logs }
        return { status: 'success', output: text, logs }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return req.signal?.aborted === true
          ? { status: 'cancelled', logs }
          : { status: 'failed', error: msg, logs }
      }
    },
  }
}

/**
 * 一条**进了某次运行**的汇报：节点主动报的那条 + 是哪个节点报的。
 *
 * ⚠️ 汇报本身的形状**不在这里定义** —— 引擎已定在 `src/workflow/model.ts` 的
 * `ReportEntry`（2026-10-25 契约 AM，提交 `2751156`）。这里只补一层「谁报的」：
 * `ReportEntry` 是节点写的，它不知道自己在画布上叫什么编号；
 * 而任务记录要能回答「哪个节点报了什么」。补这一层的是**收集方**，不是节点。
 *
 * 复用引擎那份而不是自己再定一份：两份形状不一致时，节点按引擎那份写、
 * 执行方按这份收，多出来的字段（`type` / `group` / `item`）会静静丢掉。
 */
export type NodeReport = ReportEntry & {
  /** 节点实例 id（画布上的编号，如 `n23`）。 */
  node: string
}

/**
 * builtin 函数的签名（在我们的进程里跑）。
 *
 * @param cmd - 本节点的命令体（{ node, params }，来自客户端的 buildCommand）。
 * @param ctx - 节点上下文。**直接用引擎那份 `BuiltinCtx`**（`src/workflow/model.ts:266`），
 *   理由见那个接口的注释：形状只有一份才不会漂。它已经含 `nodeId` / `workdir` /
 *   `upstream` / `signal?` / `report?`。
 * @returns 本节点的输出，交给下游。
 */
export type BuiltinFn = (
  cmd: unknown,
  ctx: BuiltinCtx,
) => Promise<unknown> | unknown

/**
 * 内置函数被取消时用的错误码（`code` 字段）。
 *
 * ## 为什么要有专门的标记
 *
 * 内置函数抛错时，执行方默认把结局判成 `failed`。而「用户点停止」不是失败 ——
 * 界面上那是两件事（「已取消」不该让人去查错）。所以取消走一个**可识别**的错误，
 * 执行方见到它就返回 `status: 'cancelled'`。
 */
const BUILTIN_CANCELLED = 'EWB_BUILTIN_CANCELLED'

/**
 * 造一个「被取消」的错误（内置函数用）。
 *
 * @returns 带标记的错误。
 */
export function builtinCancelled(): Error {
  const e = new Error('已取消')
  ;(e as Error & { code?: string }).code = BUILTIN_CANCELLED
  return e
}

/**
 * 判断一个抛出来的东西是不是「被取消」。
 *
 * @param e - 捕获到的值。
 * @returns 是取消就 true。
 */
function isBuiltinCancelled(e: unknown): boolean {
  return e !== null && typeof e === 'object' && (e as { code?: unknown }).code === BUILTIN_CANCELLED
}

/**
 * builtin 执行方：直接调函数（注册表由调用方填）。
 * @param fns - 函数注册表（节点 id → 函数）。
 * @returns 适配器。
 */
export function createBuiltinExecutor(fns: ReadonlyMap<string, BuiltinFn>): Executor {
  return {
    kind: 'builtin',
    async run(req: DispatchRequest): Promise<DispatchResult> {
      /* 查的是**节点类型**（如 sys.fs.write），不是画布上的实例编号——
       * 命令体里的 node 字段由客户端的 buildCommand 填。旧式请求没带就退回实例编号。 */
      const cmdNode = (req.command as { node?: string } | undefined)?.node
      const key = cmdNode !== undefined && cmdNode !== '' ? cmdNode : req.nodeId
      const fn = fns.get(key)
      if (fn === undefined) return { status: 'failed', error: '没有这个内置节点：' + key }
      const logs: string[] = ['调用内置 ' + key]
      /* ## 汇报的收集容器（契约 AN）
       *
       * 建在**本次调用内**、不跨节点共享：一个节点报的事只属于这一个节点，
       * 共享一个数组会让「哪个节点报了什么」永远对不上（并发跑两个节点时更明显）。
       *
       * `report` 往里 push；节点跑完后随结果交回（见下面的 `withReports`）。
       * 为什么不做成全局登记表：那样一旦节点抛错就漏了清理，下一次同 id 的运行会读到脏数据。
       * 局部数组随函数一起死 —— 没有清理问题。 */
      const reports: NodeReport[] = []
      const report = (entry: ReportEntry): void => {
        /* ⚠️ 只收对象、只收有 message 的。节点实现手抖传个字符串进来时，
         * 宁可丢掉也不能把半个坏条目写进任务记录（那里是给人看的最终产物）。 */
        if (entry === null || typeof entry !== 'object') return
        if (typeof entry.message !== 'string' || entry.message === '') return
        reports.push({ ...entry, node: req.nodeId })
      }
      try {
        /* `signal` 必须传下去：会等的内置函数（延迟 / 代码）靠它才能被「停止」打断。 */
        const out = await fn(req.command, {
          nodeId: req.nodeId,
          workdir: req.context.workdir,
          upstream: req.context.upstream,
          ...req.signal === undefined ? {} : { signal: req.signal },
          report,
        })
        logs.push('完成')
        return { status: 'success', output: out, logs, ...reportsOf(reports) }
      } catch (e) {
        /* 取消与失败必须分开报（见 `BUILTIN_CANCELLED` 的注释）。 */
        if (isBuiltinCancelled(e) || req.signal?.aborted === true) {
          logs.push('已取消')
          /* 失败/取消也把已经报上来的带上 —— 恰恰是没跑完的那次更需要看它做到哪了。 */
          return { status: 'cancelled', logs, ...reportsOf(reports) }
        }
        return { status: 'failed', error: e instanceof Error ? e.message : String(e), logs, ...reportsOf(reports) }
      }
    },
  }
}

/**
 * 把收集到的汇报摊进结果对象；**一条都没有时不写这个键**。
 *
 * ## 为什么单独抽出来
 *
 * 三条返回路径（成功 / 取消 / 失败）都要带汇报，写三遍必然有一处漏。
 * 更要紧的是「空就不写键」这条纪律 —— 与 `llm` / `depth` / `timedOut` 同一条：
 * 写个空数组进去，读的人还得自己判 `length === 0`，
 * 等于多一种「有值但看不出来」的状态。
 *
 * @param reports - 本次节点报上来的条目（可能为空）。
 * @returns 有就 `{ reports }`，没有就 `{}`（可以直接展开进返回值）。
 */
function reportsOf(reports: readonly NodeReport[]): { reports?: NodeReport[] } {
  return reports.length === 0 ? {} : { reports: [...reports] }
}

/**
 * `ai.agent` 成功那一趟报的那句话（票 30 甲）。
 *
 * ## 内容三样，缺一样都算没报清
 *
 *   · **回答多少字** —— 「跑完了」是空话，「回了 128 字」才是可核对的量；
 *   · **哪条路由** —— 用户排查「为什么用的不是我以为的模型」全靠这一段；
 *   · **怎么结束的** —— `formatTraceLine` 那句里带着（`结束 stop` / `结束 截断上限`）。
 *
 * ## 为什么不自己拼路由那一段
 *
 * 拼法（哪几段、用什么分隔、`finish` 怎么翻中文）是**规则**，规则只该有一份。
 * 界面显示痕迹调的就是 `formatTraceLine`；这里另写一遍，
 * 迟早出现「任务记录写 `模型 a/b`、运行历史写 `a/b · 结束 stop`」这种同一件事两种说法。
 *
 * ## 没有 trace 时也要有话说
 *
 * 委派函数**成功时一定带 trace**（`AgentDelegateResult` 的 `ok: true` 分支要求的），
 * 但那是类型上的保证，运行时仍可能收到残缺对象。缺了就只报字数 ——
 * 不编一个假路由（编出来的路由比没有更坏：用户会照着它去查一个不存在的模型）。
 *
 * @param text - 模型回答的原文。
 * @param trace - 这次调用的痕迹（可能有、可能残缺）。
 * @returns 一条汇报（`node` 由调用方补）。
 */
function agentReportOf(text: string, trace: LlmTrace | undefined): ReportEntry {
  const chars = text.length
  const head = '回了 ' + String(chars) + ' 字'
  /* `formatTraceLine` 只读 `provider` / `model` / `finish` 等字段；缺了这两个就等于没路由。 */
  const hasRoute = trace !== undefined && trace.provider !== '' && trace.model !== ''
  const message = hasRoute ? head + ' · ' + formatTraceLine(trace) : head + '（这次没留下模型路由）'
  return {
    message,
    type: 'info',
    location: 'ndv',
    metrics: {
      chars,
      /* token 是实测值才算数：上游没给就不写这个键（与 `LlmTrace.totalTokens` 同一条纪律）。 */
      ...trace?.outputTokens === undefined ? {} : { outputTokens: trace.outputTokens },
    },
  }
}

/**
 * agent 执行方的委派函数（由宿主半注入；实现见 `src/index.ts` 的 `createLlmDelegate`）。
 *
 * ## 为什么返回对象而不是字符串
 *
 * 2026-10-23 起要**留痕**：调完模型不能只剩一句文本，还得带回「哪条路由、花了多少 token、
 * 为什么结束、提示词与回答长什么样」。这些信息只有委派函数拿得到（它在流里），
 * 派发层拿不到 —— 所以形状上必须一起交出来，不能事后补。
 *
 * ## 为什么失败也是「返回」而不是抛
 *
 * 抛异常是「函数没跑完」，它**没有返回值**，痕迹就跟着丢了。
 * 而最需要看痕迹的恰恰是失败那几次（为什么没成、模型说了什么、提示词长什么样）。
 * 所以失败也走正常返回：`{ ok: false, error, trace }` —— 判别联合而不是异常。
 *
 * ⚠️ 真正的**意外**（代码 bug、拿不到模型路由）仍然抛；能预期到的模型结局一律返回。
 * 判别看 `ok`：`true` 一定是成功，`false` 一定有 `error`。
 *
 * ## `logs`：委派函数自己知道、而执行方不知道的事
 *
 * 目前只有一条用得上：**这次路由是从哪一级回落来的**（节点选的 / 工作台默认 / dsh 默认 /
 * 备选名单 / 自动挑第一个）。这一行只在委派函数里算得出来，所以随结果一起交回，
 * 由执行方并进 `DispatchResult.logs` 落到运行记录里 —— 用户排查「为什么用的不是我以为的模型」
 * 靠的就是它。
 */
export type AgentDelegateResult =
  | { ok: true, text: string, trace: LlmTrace, logs?: string[] }
  | { ok: false, error: string, trace?: LlmTrace, logs?: string[] }

/**
 * 委派函数。
 *
 * @param prompt - 提示词（变量已替换）。
 * @param input - 节点上的「参考资料」（没填时 `undefined`）。
 * @param signal - 取消信号（用户点停止 / 超时都会 abort 它）。
 * @param command - 命令体（委派函数从这里读 `model`、`system` 等参数）。
 */
export type AgentDelegate = (
  prompt: string,
  input: unknown,
  signal?: AbortSignal,
  command?: { model?: unknown, system?: unknown },
) => Promise<AgentDelegateResult>

/**
 * 节点自带的超时（毫秒）。
 *
 * 为什么执行方要自己管：派发层那个 300000ms 是**兜底**（所有节点共用），
 * 而 `ai.agent` 节点自己的 `timeout` 参数要按节点算 —— 用户填 30 秒就该 30 秒断，
 * 不能因为派发层还没到点就一直等模型。
 *
 * ⚠️ 非法值不用担心：`toCommand` 已把 0 / 负数 / 非数字回落成 120000、小数取整。
 * 这里只是再兜一层，免得将来别的入口直接构造命令体时传进一个怪值。
 */
const AGENT_DEFAULT_TIMEOUT_MS = 120_000

/**
 * agent 执行方：把提示词交给模型（委派函数由宿主半注入，见 `src/index.ts`）。
 *
 * ## 超时算失败，不算取消
 *
 * 取消是**用户点的**（界面上的停止、客户端断开），超时是**等太久**。
 * 两者不能让界面显示成同一件事：用户看到「已取消」会以为自己点过停止。
 * 所以超时返回 `failed` + `timedOut: true`，且错误文案点名「超时」。
 *
 * ## 为什么信号要往下传
 *
 * 真相是模型请求自己得能被中断 —— 光靠 `Promise.race` 只是**我们不等了**，
 * 底下那个请求还在跑、还在烧额度。所以超时与用户取消都通过同一个 `AbortSignal`
 * 传给委派函数，让它去掐掉真正的请求。
 *
 * @param delegate - 委派函数（来自宿主半，内部走 `ctx.llm`）。
 * @returns 适配器。
 */
export function createAgentExecutor(delegate: AgentDelegate): Executor {
  return {
    kind: 'agent',
    async run(req: DispatchRequest): Promise<DispatchResult> {
      const c = req.command as { prompt?: string, input?: unknown, timeoutMs?: number, model?: unknown, system?: unknown } | undefined
      const prompt = c?.prompt ?? ''
      if (prompt === '') return { status: 'failed', error: 'agent 节点缺少 prompt' }
      /* 命令体里的 timeoutMs 才是本节点的超时；缺了/怪了用默认。 */
      const raw = c?.timeoutMs
      const timeoutMs = typeof raw === 'number' && Number.isFinite(raw) && raw > 0
        ? Math.round(raw)
        : AGENT_DEFAULT_TIMEOUT_MS
      const logs: string[] = ['交给模型（超时 ' + String(timeoutMs) + ' 毫秒）']

      /* 「到点 / 被叫停」这条腿：只要其中一件发生，就立刻收口，不等 delegate 自己回来。
       * ⚠️ 为什么要这条腿：委派函数可能卡在一个不返回的请求上、且不理会信号。
       * 光 abort 信号的话我们这边会一直挂着 —— 用户点了停止却半天没反应。
       *
       * `ac` 是我们自己的信号（用户取消 + 超时都并进来），传给 delegate 让它掐真请求；
       * `timedOut` 记「这次是不是等太久」，用来把超时与取消分开报。 */
      const ac = new AbortController()
      let timedOut = false
      let settleStop: (why: 'timeout' | 'cancelled') => void = () => { /* 到点前不会调 */ }
      const stopLeg = new Promise<'timeout' | 'cancelled'>((resolve) => {
        settleStop = (why) => { resolve(why) }
      })
      /** 到点：标记超时 + 掐掉底下那个请求。 */
      const onTimeout = (): void => { timedOut = true; ac.abort(); settleStop('timeout') }
      const timer = setTimeout(onTimeout, timeoutMs)
      /** 用户点停止：算取消，不算超时。 */
      const onUserAbort = (): void => { ac.abort(); settleStop('cancelled') }
      req.signal?.addEventListener('abort', onUserAbort, { once: true })
      /* 已经处于取消态（调用前就 abort 了）时补一次，免得白等到超时。 */
      if (req.signal?.aborted === true) onUserAbort()

      try {
        /* 命令体原样交给委派函数（它从里面读 `model`；`timeoutMs` 由本层自己管）。 */
        const work = delegate(prompt, c?.input, ac.signal, c)
        /* 委派结果带回「文字 + 痕迹」两样（见 `AgentDelegateResult` 的注释）。
         * 痕迹随 `DispatchResult.llm` 交出去，派发层之后由引擎写进运行记录。
         *
         * ⚠️ 用 `typeof === 'string'` 把「到点/被叫停」那两条腿先分出去：
         * 它们与 delegate 的返回是两种东西，混在同一个判别里 TS 收不窄。 */
        const done = await Promise.race([work, stopLeg])
        if (typeof done === 'string') {
          /* race 赢了 → 底下的 work 还在跑；它回来后的失败不许冒成未处理拒绝。 */
          void work.catch(() => { /* 已经按超时/取消报过了 */ })
          if (done === 'timeout') {
            logs.push('超时收口（' + String(timeoutMs) + ' 毫秒）')
            /* ⚠️ **不写 `llm`**：delegate 还没返回，痕迹根本不存在。
             * 编一个 `finish: 'aborted'` 的空痕迹只会让界面显示「模型没调」的假象。 */
            return {
              status: 'failed',
              timedOut: true,
              error: '等模型超时（' + String(timeoutMs) + ' 毫秒）—— 可在节点设置里调大「超时」',
              logs,
            }
          }
          logs.push('已停止')
          /* ⚠️ 同样**不写 `llm`**：delegate 被叫停、结果没回来，痕迹无从取得。 */
          return { status: 'cancelled', logs }
        }
        /* 失败也是**返回**（不是抛）—— 这样痕迹留得下来（契约 A2 的要害）。
         * `trace` 有就带（模型已经报了结束原因的那种），没有就不写这个键。
         * ⚠️ 显式赋给带类型的局部变量再判：本仓 `strict: false`，
         * 直接 `!done.ok` 在联合上收不窄（TS 不会把 boolean 判别属性的否定当收窄）。 */
        const result: AgentDelegateResult = done
        /* 委派函数自己知道的日志（目前只有「路由来源」那条）并进来，一起落到运行记录。 */
        if (result.logs !== undefined) logs.push(...result.logs)
        if (result.ok === false) {
          /* ⚠️ 顺序要紧（2026-10-23 加）：委派函数**看见信号 abort 后自己返回一条失败**是很常见的
           * 收尾方式（它把请求掐了、顺手报个错）。那不是「模型出错」，是**用户点了停止**。
           * 不先判这个的话，用户点停止会看到「失败」，以为出了问题。
           * 超时排最前：两者都表现为 abort，但「我们等太久了」优先。 */
          if (timedOut) {
            logs.push('超时收口（' + String(timeoutMs) + ' 毫秒）')
            return {
              status: 'failed',
              timedOut: true,
              error: '等模型超时（' + String(timeoutMs) + ' 毫秒）—— 可在节点设置里调大「超时」',
              ...result.trace === undefined ? {} : { llm: result.trace },
              logs,
            }
          }
          if (ac.signal.aborted || req.signal?.aborted === true) {
            logs.push('已停止')
            return {
              status: 'cancelled',
              ...result.trace === undefined ? {} : { llm: result.trace },
              logs,
            }
          }
          logs.push('模型调用未成（' + result.error + '）')
          return {
            status: 'failed',
            error: result.error,
            ...result.trace === undefined ? {} : { llm: result.trace },
            logs,
          }
        }
        logs.push('模型返回（' + String(result.text.length) + ' 字）')
        /* ★ 主动报一条（票 30 甲，2026-10-27）。
         *
         * ## 要解决的问题
         *
         * `ai.agent` 原来**一句话都不报**。后果不是「记录里少一行字」，而是
         * `records.ts` 那条「成功 + 没有产出声明 + 没有汇报 → 不写记录」——
         * 于是「提示词优化」这类只由 `ai.agent` 构成的工作流**跑成功了却彻底不留记录**，
         * 用户回运行历史里找不到它跑过。
         *
         * ## 报什么
         *
         * 回答字数 + 路由。路由那句话**不自己拼**，用 `formatTraceLine`
         * （界面显示痕迹用的是同一个函数，拼法只有一份）。
         *
         * ⚠️ 只在这条**成功**路径带 `reports`：失败与取消那几条不带 ——
         * 「没有汇报就不写这个键」与 `llm` 同一条纪律（`dispatcher.ts:99`）。 */
        return {
          status: 'success', output: result.text, llm: result.trace, logs,
          reports: [{ ...agentReportOf(result.text, result.trace), node: req.nodeId }],
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        /* 走到这里说明 delegate **抛了**（能预期到的模型结局已经走上面的返回，不抛）。
         * 抛的那一刻没有返回值 → **没有痕迹可带**，所以这几条分支都不写 `llm`。 */
        /* 顺序要紧：先判超时。两者都可能是 abort，但「我们等太久了」优先。 */
        if (timedOut) {
          return {
            status: 'failed',
            timedOut: true,
            error: '等模型超时（' + String(timeoutMs) + ' 毫秒）—— 可在节点设置里调大「超时」',
            logs,
          }
        }
        return ac.signal.aborted || req.signal?.aborted === true
          ? { status: 'cancelled', logs }
          : { status: 'failed', error: msg, logs }
      } finally {
        clearTimeout(timer)
        req.signal?.removeEventListener('abort', onUserAbort)
      }
    },
  }
}
