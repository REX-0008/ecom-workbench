/** 内置节点的实现（在 dsh 进程内直接跑，不另起进程）。
 *
 * 只放**必须在本程序里做的事**：读写文件、等待、跑一小段代码。
 * 要起子进程的（跑 bat、跑 python、跑命令行）走 shell 执行方，不在这里重复实现。
 *
 * 这一批刚好覆盖示例工作流用到的四个节点：
 *   sys.fs.read / sys.fs.write / flow.delay / code.js
 */
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { builtinCancelled, type BuiltinFn } from './executors.ts'
import { BRANCH_KEY, evaluateCondition, evaluateConditions } from '../workflow/branch.ts'

/** 命令体里的参数（客户端 buildCommand 给的 { node, params }）。 */
interface BuiltinCmd {
  /** 参数键值对。 */
  params?: Record<string, unknown>
}

/** 从命令体里取参数（取不到给空对象）。 */
function paramsOf(cmd: unknown): Record<string, unknown> {
  const c = cmd as BuiltinCmd | undefined
  return c?.params ?? {}
}

/** 取字符串参数。 */
function str(p: Record<string, unknown>, key: string, fallback = ''): string {
  const v = p[key]
  return typeof v === 'string' ? v : v === undefined || v === null ? fallback : String(v)
}

/** 取数字参数。 */
function num(p: Record<string, unknown>, key: string, fallback: number): number {
  const v = p[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/**
 * 读一个本地文件。
 *
 * 编码支持 utf8 / gbk / base64：**中文乱码时把编码改成 gbk** 通常就好了。
 * @param cmd - 命令体。
 * @returns 文件内容（文本，或 base64 字符串）。
 */
export const readFileFn: BuiltinFn = async (cmd, ctx) => {
  const p = paramsOf(cmd)
  const path = str(p, 'path')
  if (path === '') throw new Error('没填文件路径')
  const encoding = str(p, 'encoding', 'utf8')
  /* 只读一次盘：字节数要按**磁盘上真实的大小**报（`buf.length`），
   * 不能按解码后的字符数或 base64 文本长度算 —— 那两种都对不上文件属性。 */
  const buf = await readFile(path)
  const bytes = buf.length
  const reporter = ctx.report
  /* 汇报一句话说清「读的是哪个文件、多大」。空文件要单独说明：
   * 「读到 0 字节」与「没读到」在排查时是两件事，前者往上走会得到一个空字符串，
   * 后者的症状是下游全是 undefined。 */
  reporter?.({
    message: '读到 ' + path + '，' + String(bytes) + ' 字节' + encodingNote(encoding, bytes),
    type: 'info',
    location: 'ndv',
    metrics: { bytes },
    files: [path],
  })
  if (encoding === 'base64') return buf.toString('base64')
  if (encoding === 'gbk') return new TextDecoder('gbk').decode(buf)
  return buf.toString('utf8')
}

/**
 * 读文件那条汇报的后缀（说清「按什么读出来的 / 是不是空文件」）。
 *
 * @param encoding - 参数里的编码名。
 * @param bytes - 磁盘上的字节数。
 * @returns 括注（含括号本身，或空串以外的内容）。
 */
function encodingNote(encoding: string, bytes: number): string {
  if (bytes === 0) return '（空文件）'
  if (encoding === 'base64') return '（base64 编码）'
  if (encoding === 'gbk') return '（gbk 文本）'
  return '（utf8 文本）'
}

/**
 * 写一个本地文件（覆盖或追加）。
 *
 * 内容优先取上游输出；上游没给就取 params.content。
 * 对象和数组自动转成 JSON 文本。
 *
 * ## 它也是「节点主动汇报」的第一个节点（契约 AM，2026-10-25）
 *
 * 跑完推一条：**写到哪个文件、多大、什么模式**。用户点开任务记录要能一眼看出
 * 「这次到底交出了什么」—— 而不是只有一个绿勾。
 *
 * ⚠️ 不许拿「完成」两个字充数（用户明确要求）：那条话里必须带着
 * 路径与字节数，否则等于没报。
 *
 * ⚠️ `ctx.report` **是可选的**（纪律 5）：编译器 / 预览那类场景不传它，
 * 节点照样要能跑。所以这里判一下再推，不是 `ctx.report(...)` 直接调。
 *
 * @param cmd - 命令体。
 * @param ctx - 节点上下文。
 * @returns 实际写入的路径与字节数。
 */
export const writeFileFn: BuiltinFn = async (cmd, ctx) => {
  const p = paramsOf(cmd)
  const path = str(p, 'path')
  if (path === '') throw new Error('没填写入路径')
  const raw = ctx.upstream.length > 0 ? ctx.upstream[0] : p.content
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
  /* ## 二进制通道（契约 AV，2026-10-25）
   *
   * 以前这里写死 `'utf8'`，于是「生图 → 存文件」这条链路**根本走不通**：
   * base64 文本会被当普通文本写进去，落盘的是一串可读字符而不是图片字节。
   *
   * 现在按参数选：`base64` 时先解码成 Buffer 再写；**默认仍是 utf8**，
   * 现有工作流的行为一个字节都不变（这条是硬要求，不是顺手）。
   *
   * ⚠️ 字节数按**解码后**算（`buf.length`）—— 汇报里的数字是磁盘上真实的大小。
   * 按 base64 文本长度算会多出约 1/3，用户拿它核对文件大小会对不上。
   * ⚠️ 追加模式遇到 base64 会直接报错而不是悄悄写坏：二进制「追加」没有意义
   * （不是拼接图片），拼出来的文件任何查看器都打不开。 */
  const encoding = str(p, 'encoding', 'utf8')
  const binary = encoding === 'base64'
  const mode = str(p, 'mode', 'overwrite')
  if (binary && mode === 'append') {
    throw new Error('Base64 编码不支持「追加」模式：二进制内容无法拼接，请改成「覆盖」')
  }
  const data = binary ? Buffer.from(text, 'base64') : text
  if (p.mkdir !== false) await mkdir(dirname(path), { recursive: true })
  if (mode === 'append') await appendFile(path, data)
  else await writeFile(path, data)
  const bytes = binary ? (data as Buffer).length : Buffer.byteLength(text, 'utf8')
  /* 汇报一句话说清「写到哪、多大、怎么写的」。三类信息缺一条都不够用：
   * 路径让人去找文件，字节数判「是不是写了空文件」，模式解释「原内容还在不在」。
   *
   * ⚠️ **`ctx.report` 是可选的，必须判存在**（`model.ts` 的纪律 5）：
   * `BuiltinFn` 的 ctx 已经换成引擎那份 `BuiltinCtx`（`executors.ts` 里传了
   * `report`），所以这里不用再绕 `Partial<BuiltinCtx>`；但**不是所有调用方都传**
   * （编译器 / 预览那类场景没有它），所以仍是可选调用。 */
  const reporter = ctx.report
  reporter?.({
    message: (mode === 'append' ? '追加到 ' : '写到 ') + path + '，' + String(bytes) + ' 字节'
      + (mode === 'append' ? '（原内容保留）' : '（覆盖原内容）'),
    type: 'info',
    location: 'ndv',
    metrics: { bytes },
    files: [path],
  })
  return { path, bytes }
}

/**
 * 等一会儿（用来控制访问节奏，别让平台把请求判成爬虫）。
 *
 * 打开「随机抖动」时，实际时长在设定值的一半到一倍半之间随机。
 *
 * ## 为什么要监听取消（2026-10-23）
 *
 * 原来这里只有一个 `setTimeout`，**没有任何能被打断的点** —— 用户点了「停止」，
 * 那个延迟照样睡满，节点照跑。界面上的停止按钮对延迟节点是假的。
 *
 * 现在监听 `ctx.signal`：一 abort 就**立刻 reject 成「取消」**。
 * 用 reject 而不是 resolve 成某个值：取消不该给下游交出一份「看起来正常」的输出，
 * 那会让后面的节点以为「等完了、继续吧」。执行方见到取消标记会把结局报成 `cancelled`。
 *
 * @param cmd - 命令体。
 * @param ctx - 节点上下文。
 * @returns 原样把上游输出传下去。
 */
export const delayFn: BuiltinFn = async (cmd, ctx) => {
  const p = paramsOf(cmd)
  const base = num(p, 'ms', 1000)
  const ms = p.random === true ? Math.round(base * (0.5 + Math.random())) : base
  await sleepUnlessCancelled(Math.max(0, ms), ctx.signal)
  return ctx.upstream.length > 0 ? ctx.upstream[0] : { waitedMs: ms }
}

/**
 * 睡一会儿，但**随时可以被取消**。
 *
 * @param ms - 要睡多少毫秒。
 * @param signal - 取消信号（不给就是普通 sleep）。
 * @returns 睡满就 resolve；被取消时 reject 成「已取消」。
 */
async function sleepUnlessCancelled(ms: number, signal?: AbortSignal): Promise<void> {
  /* 已经取消就别等（否则会白睡满再抛，用户看到的是「点了很久才停」）。 */
  if (signal?.aborted === true) throw builtinCancelled()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); resolve() }, ms)
    /** 收尾：清定时器 + 摘监听（派发器是长寿命单例，监听不摘会累积）。 */
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    /** 被取消：立刻收口。 */
    const onAbort = (): void => { cleanup(); reject(builtinCancelled()) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 条件判断（`flow.if`）。
 *
 * ## 输出为什么要带 `__handle`
 *
 * 调度器按**可达性**决定哪些下游不跑：节点输出里带 `__handle: 'true'|'false'` 时，
 * **只有那个出口是活的**，接在另一个出口上的边就不算上游 —— 于是那条分支的下游
 * 全部失去活入边、被判不可达、**不派发**。
 *
 * 这是「一个约定」而不是「调度器特判这个节点」——理由见 `workflow/branch.ts`。
 *
 * ## 输出为什么必须带**上游原样**（2026-10-19，用户明确要求）
 *
 * 用户原话：「这个节点要足够兼容且能够往下传数据（这个节点做的不只是判断，
 * 判断完了后面的节点还得知道干嘛对吧？）」
 *
 * 所以输出是**上游那个值本身**，只多一个 `__handle` 标记从哪个出口走 ——
 * 而不是 `{ __handle, ok: true }` 这种「只剩一个结论」的东西。
 * n8n 与 Dify 都是这样：IF 不改数据，只决定数据走哪条路。
 *
 * ⚠️ 这里有一个**对象不能直接铺平**的陷阱：上游如果是 `{ ok: false }`，
 * 写成 `{ ...upstream, __handle }` 看起来没问题；但上游是 `null` / 字符串 / 数组时
 * 铺平就丢信息了（`{ ...'abc' }` 得到 `{0:'a',1:'b',2:'c'}`）。
 * 所以判据是「对象且不是数组才铺平，否则原样包进 `value`」——
 * 后者是老存档时代就有的形状，下游的 `code.js` 一直在剥这层壳（见 `CODE_UNWRAP`）。
 *
 * ## 两种条件写法
 *
 *   · **结构化**（新）：调度器把「左边取什么值」解析好后放在命令体的 `__judge` 里，
 *     这里只负责**比**（`evaluateConditions`）。取值的活不归这里干 —— 只有调度器
 *     手上有「所有节点的输出」与循环变量。
 *   · **JS 表达式**（旧，`params.expr`）：老存档的写法，原样照跑。
 *
 * @param cmd - 命令体（可能带 `__judge`）。
 * @param ctx - 节点上下文。
 * @returns 上游原样 + `__handle`。
 */
export const branchFn: BuiltinFn = (cmd, ctx) => {
  const p = paramsOf(cmd)
  const input = ctx.upstream.length === 1 ? ctx.upstream[0] : ctx.upstream
  const judge = (cmd as { __judge?: unknown } | undefined)?.__judge

  let pass: boolean
  if (judge !== null && typeof judge === 'object' && (judge as { mode?: unknown }).mode === 'rules') {
    const j = judge as { conds: Parameters<typeof evaluateConditions>[0], logic?: string }
    pass = evaluateConditions(j.conds, j.logic).pass
  } else {
    /* 老写法。空表达式由 `evaluateCondition` 抛「没填判断条件」，
     * 但调度器已经在派发前拦过一次了 —— 走到这里说明是别处直接调这个函数。 */
    pass = evaluateCondition(str(p, 'expr'), input)
  }

  const tag = pass ? 'true' : 'false'
  /* 对象（非数组）就铺平 —— 下游直接用 `{{字段}}` 取上游数据，与 IF 不存在时一模一样；
   * 其余类型包进 `value`（老存档时代一直是这个形状，`CODE_UNWRAP` 在剥这层壳）。 */
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return { ...(input as Record<string, unknown>), [BRANCH_KEY]: tag }
  }
  return { [BRANCH_KEY]: tag, value: input }
}

/**
 * 在本程序里跑一小段 JavaScript（加工上游数据）。
 *
 * 代码里用 'input' 取上游数据、用 'return' 把结果交出去，可以用 await。
 * 跑在本进程内，**读不到网页内容**（那是浏览器版「执行 JS」的事）。
 *
 * ## 取消在这里怎么生效（2026-10-23）
 *
 * 用户写的代码是**同步跑在事件循环里**的，没法从外面掐断它（同一个线程）。
 * 能做的只有一件事：**不再等它** —— 把取消也放进 `Promise.race`，
 * 一 abort 就立刻收口成「取消」，用户点了停止当场有反应（而不是等代码自己跑完）。
 *
 * ⚠️ 那段代码本身可能还在跑完（它已经在事件循环里了）。这是**如实的技术边界**，
 * 不是偷懒：要真掐断得把 `code.js` 挪进 `worker_threads` 或子进程，那是另一件事。
 * 至少上层不会再挂着、并发槽也会释放。
 *
 * @param cmd - 命令体。
 * @param ctx - 节点上下文。
 * @returns 代码 return 的东西。
 */
export const runCodeFn: BuiltinFn = async (cmd, ctx) => {
  const p = paramsOf(cmd)
  const code = str(p, 'code')
  if (code.trim() === '') throw new Error('没填代码')
  if (ctx.signal?.aborted === true) throw builtinCancelled()
  const input = ctx.upstream.length === 1 ? ctx.upstream[0] : ctx.upstream
  const runner = new Function('input', '"use strict";return (async () => {' + code + '})()') as (i: unknown) => Promise<unknown>
  const timeoutMs = num(p, 'timeout', 30000)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error('代码运行超时（' + String(timeoutMs) + ' 毫秒）')) }, timeoutMs)
  })
  /* 取消也参与竞争：点停止立刻收口（代码本身不保证能被打断，见上面的注释）。 */
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => { reject(builtinCancelled()) }
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const out = await Promise.race([runner(input), timeout, cancelled])
    /* ## 汇报「算出了什么」（票 08 第二条）
     *
     * 用户点开任务记录要能看出这一步交出了什么，而不是只有一个绿勾。
     * **不许倒全文**：代码节点的输出可能是一整页数据，塞进汇报会把记录撑爆；
     * 所以只说形状与规模（几条 / 几个键 / 多少字），要看内容就去输出面板。
     *
     * ⚠️ 空数组、空字符串、`undefined` 都要单独说清 —— 它们都是「跑成功了但下游
     * 拿不到东西」的几种不同病，混成一句「算出了结果」就查不出问题在哪。 */
    const reporter = ctx.report
    /* ★ 节点自己上报的那句话优先（票 20 后半，2026-10-27）。
     *
     * ## 为什么需要这个入口
     *
     * `code.js` 原来只能报**形状**（「算出了对象，4 个键」），因为它没有任何
     * 「我想说这句话」的通道。而真实采集的汇总节点（`取数-抖音电商罗盘` 的 n30）
     * 算出来的正是业务总账 —— 它知道「采了 32 条、跳过 2 条」，却只能报成
     * 「算出了对象，4 个键」。用户点开任务记录看到的是一句没信息的话。
     *
     * ## 怎么用：输出里带 `__report`
     *
     * ```js
     * return { total: 32, okCount: 30, ..., __report: '共采到 32 条，跳过 2 条' }
     * ```
     *
     * ## ⚠️ 它必须从输出里**摘掉**（不是留着不管）
     *
     * 留着的话它会：① 出现在下游 `{{变量}}` 的可选字段里，用户会以为那是业务数据；
     * ② 被 `sys.fs.write` 原样写进结果文件，把内部标记落成业务字段。
     * 这与 `__alert` / `__handle` / `__error` 是**同一套 `__` 前缀约定**
     * （见 `variables.ts` 的 `RESERVED_KEY_PREFIX`）—— 保留键不给用户看、不参与替换。
     *
     * 摘的时候是**浅拷贝**：只删 `__report` 这一个键，其余键（含嵌套对象）
     * 原样保留。所以 `stoppedModules` 这类业务字段不会丢。 */
    const own = ownReportOf(out)
    const visible = own === undefined ? out : withoutReportKey(out)
    const metrics = outputMetrics(visible)
    reporter?.({
      message: own ?? describeOutput(visible),
      type: 'info',
      location: 'ndv',
      ...metrics === undefined ? {} : { metrics },
    })
    return visible
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) ctx.signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * 合并两路数据（`flow.merge`）。
 *
 * ## 它为什么存在（2026-10-27，票 21）
 *
 * 引擎里有两处把用户指向这个节点：
 *   · `run.ts` 的并行节点遇到「框内多路汇到同一节点」时报
 *     「请先用「合并」节点把这几路并成一路，或改成串联」；
 *   · `parallel.ts` 的文件头写「靠显式合并节点做 —— 我们有 `flow.merge`」。
 *
 * 在那之前这个节点**没有实现**（点了报「没有这个内置节点」），
 * 于是那两句话是在让人去找一个不存在的东西。补上实现，那两句话才成立。
 *
 * ## 三种模式，**只做这三种**（不照抄 n8n 的 Match / SQL）
 *
 * | 模式 | 干什么 | 典型场合 |
 * | --- | --- | --- |
 * | `array` | A、B 拼成一个数组 | 并行几路的结果并起来 |
 * | `object` | 两边的字段拼成一个对象 | 两条分支各产出几个字段，汇合后一起用 |
 * | `concat` | 文本首尾相接 | 两段日志 / 两段说明接成一段 |
 *
 * ⚠️ n8n 的 Merge 还有「按字段配对（inner/left/right join 那套）」「按位置配对」
 * 「写 SQL」三组模式。**有意不做**：我们现在的场景（并行汇合、两条互斥分支汇合）
 * 用不上，而那三组各要一套独立语义。等真有按字段对账的需求再加，别先造三个没人用的。
 *
 * ## 输入端口当不当事
 *
 * **不当**。上游数组是按连线顺序平铺的（`upstreamOf` 决定了这一点，见那里的说明），
 * 端口 `a` / `b` 只是画布上的两个孔，引擎递进来的是一个数组。
 * 所以这里按「数组里的前两个值」算 A 和 B，多于两个的**并进数组模式**、其余模式忽略。
 * 这是如实的边界：真要按端口区分得先让引擎按 `targetHandle` 分流，那是另一件事。
 *
 * @param cmd - 命令体。
 * @param ctx - 节点上下文。
 * @returns 合并结果。
 */
export const mergeFn: BuiltinFn = (cmd, ctx) => {
  const p = paramsOf(cmd)
  const mode = str(p, 'mode', 'array')
  const up = ctx.upstream
  /* ⚠️ **一路都没有 = 明确报错**，不返回空数组：
   * 「合并」拿到零路输入时，安静地给出 `[]` 会让下游以为「合并成功了，结果是空的」，
   * 而真相是「上游一条都没连上 / 都走了别的分支」。这两种在排查时完全不同。 */
  if (up.length === 0) {
    throw new Error('合并节点没有收到任何上游数据：确认两条入线都接上了，'
      + '并检查上游是否走了别的分支（未走的分支不算上游）。')
  }
  const a = up[0]
  const b = up.length > 1 ? up[1] : undefined

  if (mode === 'object') {
    /* 两边都是对象（非数组）才铺平；否则把值挂到 `a` / `b` 底下 ——
     * 与 `flow.if` / `flow.alert-wait` 同一条规矩：不因为「不是对象」就把数据丢了。 */
    const flat = (v: unknown): Record<string, unknown> | null =>
      v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    const fa = flat(a)
    const fb = flat(b)
    const out: Record<string, unknown> = {}
    if (fa !== null) Object.assign(out, fa)
    /* B 的字段**覆盖** A 的同名字段（与 n8n 的「Clash 时优先 Input 2」同一个取向：
     * 后一路是更靠下游的加工结果，通常才是想留的那份）。 */
    if (fb !== null) Object.assign(out, fb)
    if (fa === null) out.a = a
    if (b !== undefined && fb === null) out.b = b
    return out
  }

  if (mode === 'concat') {
    /* 非文本一律 `JSON.stringify` —— 让「对象接成文本」也有个确定结果，
     * 而不是变成 `[object Object]`（那个字符串拿去做任何事都没用）。 */
    const text = (v: unknown): string => {
      if (v === undefined) return ''
      if (typeof v === 'string') return v
      return JSON.stringify(v)
    }
    return text(a) + text(b)
  }

  /* `array`：A 是数组就摊开，不是就当成一个元素；B 同理。多于两路的一并接上。 */
  const out: unknown[] = []
  for (const v of up) {
    if (v === undefined) continue
    if (Array.isArray(v)) out.push(...v)
    else out.push(v)
  }
  if (p.dedupe !== true) return out
  /* 「去重」按**值的 JSON 文本**判 —— 对象/数组也能判（`Set` 直接放对象永远不相等）。 */
  const seen = new Set<string>()
  return out.filter((v) => {
    const key = JSON.stringify(v) ?? String(v)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 一句话说清代码节点算出了什么（形状 + 规模，不倒内容）。
 *
 * @param out - 代码 return 的东西。
 * @returns 给人看的一句话。
 */
function describeOutput(out: unknown): string {
  if (out === undefined) return '算出了空值（代码没有 return 任何东西，下游取不到值）'
  if (out === null) return '算出了 null（下游取不到值）'
  if (Array.isArray(out)) {
    if (out.length === 0) return '算出了 0 条（空数组）'
    return '算出了 ' + String(out.length) + ' 条（数组）'
  }
  if (typeof out === 'string') {
    if (out === '') return '算出了空文本（下游拿到空字符串）'
    return '算出了一段文本，共 ' + String(out.length) + ' 字'
  }
  if (typeof out === 'object') {
    const keys = Object.keys(out as Record<string, unknown>)
    if (keys.length === 0) return '算出了空对象（没有任何键）'
    /* 键名最多列 6 个：再多的列出来句子会撑成一段噪音，而「有几个键」已经够判断了。 */
    const shown = keys.slice(0, 6).join('、')
    return '算出了对象，' + String(keys.length) + ' 个键：' + shown + (keys.length > 6 ? ' 等' : '')
  }
  if (typeof out === 'number') return '算出了数字 ' + String(out)
  if (typeof out === 'boolean') return '算出了 ' + String(out)
  return '算出了 ' + typeof out + ' 类型的值'
}

/**
 * 代码节点自己指定的那句汇报（输出里的 `__report`）。
 *
 * 只在**输出是对象**且那个键是**非空字符串**时认；其余一律 `undefined`
 * （带类型不对的值不算，免得用户手抖让它报出一句 `[object Object]`）。
 *
 * @param out - 代码 return 的东西。
 * @returns 那句话；没有就 `undefined`。
 */
function ownReportOf(out: unknown): string | undefined {
  if (out === null || typeof out !== 'object' || Array.isArray(out)) return undefined
  const v = (out as Record<string, unknown>).__report
  if (typeof v !== 'string') return undefined
  const text = v.trim()
  return text === '' ? undefined : text
}

/**
 * 把输出里的 `__report` 摘掉（**浅拷贝**，其余键原样保留）。
 *
 * 为什么是浅拷贝而不是深拷贝：业务对象里可能有很大的数组（一整批商品），
 * 深拷贝一遍纯属浪费；而 `__report` 只可能出现在**最外层**
 * （约定如此 —— 引擎只读最外层那个键，写进里层也没人认）。
 *
 * @param out - 代码 return 的东西（已知是对象）。
 * @returns 摘掉 `__report` 的新对象。
 */
function withoutReportKey(out: unknown): unknown {
  if (out === null || typeof out !== 'object' || Array.isArray(out)) return out
  const copy: Record<string, unknown> = { ...(out as Record<string, unknown>) }
  delete copy.__report
  return copy
}

/**
 * 代码节点那条汇报的量化数字（条数 / 字数 / 键数）。
 *
 * @param out - 代码 return 的东西。
 * @returns 有可量的数就返回对象，否则 `undefined`（不写空 `metrics` 键）。
 */
function outputMetrics(out: unknown): Record<string, number> | undefined {
  if (Array.isArray(out)) return { count: out.length }
  if (typeof out === 'string') return { chars: out.length }
  if (out !== null && typeof out === 'object') return { keys: Object.keys(out as Record<string, unknown>).length }
  return undefined
}
