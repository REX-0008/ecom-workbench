/** 「整次运行」的记录（用户 m03287：「运行历史应该根据工作流做分组，可以回看是哪个工作流」）。
 *
 * ## 它补的是什么
 *
 * 在这之前，`/api/ecom-workbench/runs` 返回的是**节点级**记录（`dispatcher.ts` 的 `RunRecord`，
 * 一行一个节点的执行）。于是「跑一次工作流」在列表里散成十几行，
 * 看不出「哪一次是整份工作流跑的、成没成、产出什么」。
 *
 * 用户定的是「乙」：**再加一层「整次运行」**，点开才看下面每个节点的明细。
 * 同时「甲」的分层要兼顾 —— 节点明细的标题用**该节点的实例备注名 + 编号**
 * （用户原话：「以哪个节点的备注名称、编号为标题」）。
 *
 * ## 存哪、谁写
 *
 * 宿主半写（`src/index.ts` 的两条跑路：`POST /workflow/run` 与 `GET /workflow/run-stream`）。
 * 客户端只读。文件落在插件数据目录的 `runs/` 下，一份工作流一个文件 ——
 * **按工作流分组**这件事就交给文件系统，不必每次读全量再在内存里 group。
 *
 * ## 与「运行时输出」的分工（用户 m03330 确认的那条）
 *
 *   · **运行历史** = 全量：每次运行的时间、成没成、跑了几个节点、节点明细、日志。回看用。
 *   · **运行时输出** = 关键信息：结束节点声明的产出（`declaredOutputs`），
 *     相当于 bat 窗口最后那几行。当场用。
 *
 * 两者都从同一次运行里提取，但**不共用一份数据结构** —— 混在一起会让两边都别扭
 * （这条在 `FlowRunPanel.tsx` 的文件头也写过一次）。
 */
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { workflowsDir, safeName } from './store.ts'
/* 模型痕迹的形状**三方共用一份**（执行方产出 / 引擎写记录 / 界面显示），
 * 定义在 `dispatch/llm-trace.ts`。那个文件不 import 任何东西，所以引它不会把
 * Node 内置模块带进客户端产物。 */
import { truncateTraceText, type LlmTrace } from '../dispatch/llm-trace.ts'
/* 汇报的形状（契约 AM）：与节点定义里的 `hints` 是同一套类型，定义在 `model.ts`
 * （那个文件不 import 任何东西，客户端引它不会带进 Node 内置模块）。 */
import type { ReportEntry } from './model.ts'

/** 一条节点级明细（用户 m03287：「以哪个节点的备注名称、编号为标题」）。 */
export interface RunNodeLine {
  /** 节点实例 id（编号，如 `n7`）。 */
  nodeId: string
  /**
   * 这个节点住在第几层子工作流。
   *
   * ## 顶层**不写**这个键（不是写 0）
   *
   * 与 `llm.truncated` 同一条纪律：能省一个键就省，别让每条明细都挂一个恒为 0 的字段。
   * 读的一方按 `depth ?? 0` 理解即可。
   *
   * ## 为什么需要它
   *
   * 子工作流里的节点 id 各自从 `n1` 起，与父流程**必然重名**。收集层只按裸 `nodeId`
   * 归并时，父子同名的节点会被合成一条明细（后写的覆盖标题与类型，只要有一份失败
   * 整条就显示失败）—— 用户看到的就是「父流程那个节点变成了子流程的标题，还标着失败」。
   * 收集层用 `nodeKeyOf(depth, nodeId)` 当归并键就不会撞（见 `run.ts` 的 `nodeKeyOf`）。
   *
   * ⚠️ 这只是**记录层**的归并信息：`outputs` / `{{变量}}` / `parentId` / 连边读的
   * 仍然是裸 `nodeId`，一个字都没变。
   *
   * 下钻过的节点写 1 起（第几层子工作流）。
   */
  depth?: number
  /** 节点类型 id（如 `code.js`），给人看的兜底名。 */
  defId?: string
  /** 实例备注名（节点上那个「给它起个名字」；没填时为空）。 */
  label?: string
  /**
   * 结局。
   *
   * ⚠️ `waiting` 是 2026-10-21 加的（计划 Step 12 的红线：**「等待中」不是「失败」**）。
   * 等待节点把现场存盘后停下，这个节点既没成也没败 —— 标成 failed 会让用户
   * 以为采集出错，去查一个根本不存在的问题。
   *
   * ⚠️ `cancelled` 是 2026-10-23 加的（契约 AB：「报错了，但是后续还在执行」）。
   * 它说的是**「前面失败了，这个节点这次不会再跑」** —— 不是用户点停止
   * （那条路画布自己复位）、也不是「未走的分支」（那个是 `skipped`）。
   *
   * 与 `queued` 的区别就是它要解决的问题：`queued` 表示「排着队、等一下会跑」，
   * 而中断之后这些节点**永远不会跑**了。留着 `queued` 会让人以为后面还在执行。
   */
  state: 'success' | 'failed' | 'skipped' | 'running' | 'queued' | 'waiting' | 'cancelled'
  /** 开始时间（毫秒）。 */
  startedAt?: number
  /** 结束时间（毫秒）。 */
  endedAt?: number
  /** 失败原因。 */
  error?: string
  /** 这个节点的日志行（有上限，见 MAX_NODE_LOGS）。 */
  logs?: string[]
  /**
   * 这个节点调模型留下的痕迹（谁调的、花了多少 token、怎么结束的）。
   *
   * ⚠️ **不是模型调用的节点不写这个键**（不写 `null`、不写 `{}`）——
   * 与 `depth` / `truncated` 同一条纪律：省掉一个恒为空的键。
   */
  llm?: LlmTrace
  /**
   * 这个节点在跑的过程中**主动报的事**（按到达顺序，**不去重**）。
   *
   * ## 「不去重」是有意的
   *
   * 循环里每轮推一条、同一句话可能重复十次。**记录层全留**：那是「跑了几轮」
   * 的直接证据。折叠显示是**界面**的事（`group.key` 就是给它用的），
   * 在记录层去重的话，界面就再也没法还原「其实跑了 10 轮」。
   *
   * ## 与数据流无关
   *
   * 汇报**不进 `outputs`**：下游 `{{变量}}` 取不到。数据流仍靠节点返回值。
   *
   * ⚠️ 没汇报就**不写这个键** —— 与 `llm` / `depth` / `truncated` 同一条纪律
   * （不写 `null`、不写 `[]`）。
   */
  reports?: ReportEntry[]
}

/** 一次「整份工作流」的运行记录。 */
export interface WorkflowRun {
  /** 运行 id（时间戳 + 随机后缀，同一毫秒也不撞）。 */
  id: string
  /** 哪份工作流（分组键）。 */
  name: string
  /** 开始 / 结束时间（毫秒）。 */
  startedAt: number
  endedAt?: number
  /** 结局：跑完 / 中断 / 起了但没跑（读不到存档之类）。 */
  ok: boolean
  /** 是不是因为节点失败而中断。 */
  aborted?: boolean
  /** 起因（失败原因或读不到存档的原因）。 */
  error?: string
  /** 跑了哪些节点（顺序即执行顺序）。 */
  ran: string[]
  /** ★ **关键信息**：结束节点声明的产出（bat 最后那几行）。 */
  outputs?: Record<string, unknown>
  /** 本次生效的输入。 */
  inputs?: Record<string, unknown>
  /** 节点明细（「点开才看」的那一层）。 */
  nodes: RunNodeLine[]
  /** 谁发起的：`list`（列表点执行）/ `canvas`（画布整图跑）/ `sub`（被别的流程调用）。 */
  via?: string
  /**
   * 这次运行**挂起在等**（`flow.wait` 的条件还没满足）。
   *
   * ## 为什么不是 `ok: false` 就够了
   *
   * 挂起与失败在存储层长得一样（都没跑完、都 `ok: false`），但**含义完全相反**：
   * 失败要人去查、要发通知；挂起是**正常的**，到点自己会继续。
   * 只靠 `ok` 区分的话，界面只能显示红叉，用户会去查一个没出错的采集。
   *
   * ⚠️ **判据优先级**：读记录的一方先看 `waiting`，再看 `ok`。
   */
  waiting?: boolean
  /**
   * 预计什么时候继续（毫秒时间戳；`waiting` 为真时才有）。
   *
   * 为什么存它：界面要显示「约 09:30 继续」，而不用再去读 `paused/` 里的现场文件。
   */
  resumeAt?: number
}

/** 每份工作流最多留几次运行（超出删最旧的）。 */
const MAX_RUNS = 60
/** 每个节点最多留几行日志。 */
const MAX_NODE_LOGS = 40
/** 单条运行记录文件里，节点明细最多几条（防一份大工作流把文件撑爆）。 */
const MAX_NODE_LINES = 400

/**
 * 把一条明细上的模型痕迹**收一遍**（截断 + 白名单），坏掉就丢掉这个字段。
 *
 * ## 为什么要在这里再截一次
 *
 * `llm-trace.ts` 的 `TRACE_TEXT_PREVIEW` 是上游（执行方与 `src/index.ts` 的洗字段）
 * 也该遵守的上限。但**落盘这一层是最后一道闸**：任何一条上游路径漏截，写出来的就是
 * 一份能把记录文件撑爆的记录，而这个文件还没有任何清理机制。
 *
 * 所以这里按同一个上限**再截一次**，并且把 `truncated` 按**实际结果**重算：
 * 上游标了 `truncated: true` 就保留（它确实截过），这次又截了也置 true。
 * **真截了才是 true**，没截就不写这个键（与 `LlmTrace.truncated` 的注释一致）。
 *
 * ## 为什么整个包在 try 里
 *
 * `llm` 是**附带信息**：它坏了不该让「这次运行」从历史上消失。
 * 上层可能塞进任意形状（客户端手改、旧版本存档、未来字段改名），
 * 任何一处抛出都要退回「这条明细没有 llm」而不是「整条记录写失败」。
 *
 * @param line - 一条节点明细（可能带 `llm`）。
 * @returns 收过的明细；`llm` 不可用时**不含这个键**。
 */
function normalizeLlmLine(line: RunNodeLine): RunNodeLine {
  if (line.llm === undefined || line.llm === null) {
    /* 没有就不要这个键 —— 不写 `null`、不写 `{}`。
     * （`...line` 里若带了个 `llm: undefined`，JSON.stringify 会把它丢掉，
     * 但显式删掉更明确，也让内存里的对象与落盘的一致。） */
    const { llm: _drop, ...rest } = line
    return rest
  }
  try {
    const raw = line.llm as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      const { llm: _drop, ...rest } = line
      return rest
    }
    const o = raw as Record<string, unknown>
    /* 三个必填字段缺一个就没有可读的痕迹（同上层的判据，不另立一套）。 */
    if (typeof o.provider !== 'string' || o.provider === '') {
      const { llm: _drop, ...rest } = line
      return rest
    }
    if (typeof o.model !== 'string' || o.model === '') {
      const { llm: _drop, ...rest } = line
      return rest
    }
    if (typeof o.finish !== 'string' || o.finish === '') {
      const { llm: _drop, ...rest } = line
      return rest
    }
    const trace: LlmTrace = { provider: o.provider, model: o.model, finish: o.finish }
    /** 只收有限非负数（0 是实测值，合法；负数与 NaN 是坏数据）。 */
    const take = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
    const input = take(o.inputTokens)
    const output = take(o.outputTokens)
    const total = take(o.totalTokens)
    if (input !== undefined) trace.inputTokens = input
    if (output !== undefined) trace.outputTokens = output
    if (total !== undefined) trace.totalTokens = total
    /* ★ 二次截断：上游漏截也截不住这一道。 */
    let cut = o.truncated === true
    if (typeof o.promptPreview === 'string') {
      const p = truncateTraceText(o.promptPreview)
      if (p.text !== '') trace.promptPreview = p.text
      cut = cut || p.truncated
    }
    if (typeof o.outputPreview === 'string') {
      const a = truncateTraceText(o.outputPreview)
      if (a.text !== '') trace.outputPreview = a.text
      cut = cut || a.truncated
    }
    if (cut) trace.truncated = true
    return { ...line, llm: trace }
  } catch {
    /* 形状再怪也不许连累整条记录（见上面「为什么整个包在 try 里」）。
     * 静默丢掉这个字段：痕迹是附带信息，丢了不改变这次运行的成败。 */
    const { llm: _drop, ...rest } = line
    return rest
  }
}

/**
 * 运行记录目录。
 *
 * 与工作流存档**同级**（`workflows/` 旁边的 `runs/`）—— 两者一起备份/搬迁，
 * 而且「按工作流分组」是文件级的事，不必扫全量。
 *
 * @param dshHome - 数据根（测试可注入）。
 * @param profile - profile 名（测试可注入）。
 * @returns 绝对路径。
 */
export function runsDir(dshHome?: string, profile?: string): string {
  /* ⚠️ 用 `workflowsDir` 的**父目录**再拼 `runs` —— 这样沙箱（`EWB_TEST_HOME`）
   * 与降级路径都自动一致，不必在这里再写一遍解析规则（写两遍必漂）。 */
  return join(workflowsDir(dshHome, profile), '..', 'runs')
}

/**
 * 一份工作流的运行记录文件路径。
 *
 * @param name - 工作流名（走 `safeName`，防越界）。
 * @param dshHome - 数据根。
 * @param profile - profile 名。
 * @returns 绝对路径。
 */
function runsFile(name: string, dshHome?: string, profile?: string): string {
  return join(runsDir(dshHome, profile), safeName(name) + '.json')
}

/**
 * 读一份工作流的历史（新的在前）。
 *
 * 读不到文件 / 内容坏了都返回空数组 —— **不抛**。理由：历史是附带能力，
 * 它坏了不该让「打开运行历史页」整个失败（那会变成一个空白页面 + 一堆报错）。
 *
 * @param name - 工作流名。
 * @returns 运行记录（新的在前）。
 */
export async function loadRuns(name: string, opts: { dshHome?: string, profile?: string } = {}): Promise<WorkflowRun[]> {
  try {
    const text = await readFile(runsFile(name, opts.dshHome, opts.profile), 'utf8')
    const parsed = JSON.parse(text) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(r => r !== null && typeof r === 'object') as WorkflowRun[]
  } catch {
    return []
  }
}

/**
 * 把一次运行追加进历史（新的在前，超上限删最旧的）。
 *
 * ⚠️ 写失败**只警告不抛**：跑都跑完了，历史没存上不该让「执行」报失败。
 *
 * @param run - 要存的那次。
 * @returns 存成功了没。
 */
/**
 * 每份工作流一条写入队列（**读-改-写要串起来**）。
 *
 * ## 为什么必须串
 *
 * `appendRun` 是「读整份 → 插到最前 → 整份写回」。两个调用并发时：
 * 两份都读到同一份旧数组、各自插自己的那条、后写的把先写的**整条覆盖掉**。
 *
 * 实测踩到（2026-10-18，用户 m03635「跑一个会出现多个」一起查出来的）：
 * 同一次点击会同时走 SSE 与 POST 两条跑路，两条都往同一个文件追加 →
 * 其中一条的记录**凭空消失**，看起来像「跑了好几次、但只留下一个」。
 *
 * 修法用「一条 Promise 链」：同一个文件名的写入排成队列，互不穿插。
 * 这是本文件里唯一需要并发保护的地方（读与清空不参与）。
 */
const writeQueues = new Map<string, Promise<unknown>>()

/**
 * 把一次写入排进该文件的队列，等前面那些都做完再跑。
 *
 * @param file - 文件名（队列键）。
 * @param job - 要做的写入。
 * @returns 这次写入的结果。
 */
function serialize<K>(file: string, job: () => Promise<K>): Promise<K> {
  const prev = writeQueues.get(file) ?? Promise.resolve()
  /* 前一次失败不该把后面全卡住 —— 所以 `catch` 掉再排队。 */
  const next = prev.catch(() => { /* 上一次的失败与这一次无关 */ }).then(job)
  writeQueues.set(file, next)
  /* 队列跑完就摘掉，免得这个 Map 随工作流数量一直长。 */
  void next.finally(() => { if (writeQueues.get(file) === next) writeQueues.delete(file) })
  return next
}

export async function appendRun(run: WorkflowRun, opts: { dshHome?: string, profile?: string } = {}): Promise<boolean> {
  const file = safeName(run.name) + '.json'
  /* ⚠️ 整个「读-改-写」必须在队列里跑完 —— 只串「写」那一步没用，
   * 因为两个调用会先各自读到同一份旧数据。 */
  return serialize(file, async () => {
    try {
      const dir = runsDir(opts.dshHome, opts.profile)
      await mkdir(dir, { recursive: true })
      const old = await loadRuns(run.name, opts)
      const nodes = run.nodes.slice(0, MAX_NODE_LINES).map(n => normalizeLlmLine({
        ...n,
        logs: (n.logs ?? []).slice(-MAX_NODE_LOGS),
      }))
      const next = [{ ...run, nodes }, ...old].slice(0, MAX_RUNS)
      await writeFile(runsFile(run.name, opts.dshHome, opts.profile), JSON.stringify(next, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  })
}

/**
 * 清掉某份工作流的全部历史。
 *
 * @param name - 工作流名。
 * @returns 删掉了没（本来就没有也算成功）。
 */
export async function clearRuns(name: string, opts: { dshHome?: string, profile?: string } = {}): Promise<boolean> {
  try {
    await unlink(runsFile(name, opts.dshHome, opts.profile))
    return true
  } catch {
    return true
  }
}

/**
 * 有哪些工作流留下过运行记录（给「按工作流分组」的列表用）。
 *
 * @returns 工作流名（不带扩展名）。
 */
export async function listRunNames(opts: { dshHome?: string, profile?: string } = {}): Promise<string[]> {
  try {
    const dir = runsDir(opts.dshHome, opts.profile)
    const files = await readdir(dir)
    return files.filter(f => f.endsWith('.json')).map(f => f.slice(0, -5))
  } catch {
    return []
  }
}

/**
 * 给一次运行生成 id。
 *
 * @returns 如 `20261017-143021-a1b2`。
 */
export function newRunId(now: number = Date.now()): string {
  const d = new Date(now)
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp = String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate())
    + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  const rnd = Math.random().toString(36).slice(2, 6)
  return stamp + '-' + rnd
}
