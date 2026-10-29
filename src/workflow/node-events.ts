/** 节点事件的归并规则（一条事件 → 节点明细上改哪个字段）。
 *
 * ## 为什么单独一个文件（2026-10-25，契约 AR）
 *
 * 这条规则原来有三份：
 *   ① `src/index.ts` 的 `mergeNodeEvent`（`resumePausedRun` 与 `runCollector` 共用）；
 *   ② `src/schedule/runner.ts` 的 `feed` —— **手抄的第二份**。
 *
 * 抄两份的代价已经发生过两次：
 *   · 修「父子同名节点撞车」时差点只修一处（「列表里跑」好了、「画布跑」还坏着）；
 *   · 定时那条路的 `feed` **漏了 `cancelled` 与 `llm` 两个分支** ——
 *     于是定时跑的运行记录里没有模型痕迹、中断后未执行的节点停在 `queued`
 *     （契约 AB 修的那个显示问题，在定时这条路上又回来了）。
 *     两条都没被测到（`tests/schedule-notify.mjs` 里 `cancelled` / `llm` 零命中）。
 *
 * ## 为什么不直接让 `runner.ts` 从 `index.ts` import
 *
 * 因为**有环**：`src/index.ts:567` 引用 `runner.ts`（`runTaskById` / `startScheduler`），
 * 反向再引用就成环。ESM 能处理一部分环，但代价是「谁先求值」变得依赖导入顺序 ——
 * 而这里导的是个**函数**，看起来能用，实际会在某些打包配置下变成 `undefined`。
 * 挪到独立文件是更干净的做法：两边都依赖它，它不依赖任何一边。
 *
 * ⚠️ 位置搬了，**逻辑一个字都没改**。改逻辑请另立一件事并补断言 ——
 * 这份规则现在是对的，`src/index.ts` 那份是准的。
 */
import { nodeKeyOf } from './run.ts'
import type { RunNodeLine } from './workflow-runs.ts'

/** 节点级事件的形状（收集层只关心这几项）。 */
export interface NodeEventLike {
  /**
   * 事件种类（`started` / `success` / `failed` / `skipped` / `cancelled` / `log` / `report`）。
   *
   * ⚠️ `stream`（模型逐字分片，票 14）**也在事件流里**，但下面这几个字段一个都不带、
   * 而 `mergeNodeEvent` 的 if-else 链**故意没有它那一支** —— 不认就是丢掉。
   * 这是硬约束：每片字都落盘会让运行记录涨到几十兆，而那些字最终就是节点输出。
   * 换个含义写一支 `else if` 之前，先读一遍 `run.ts` 里 `kind: 'stream'` 的那段注释。
   */
  kind: string
  /** 节点实例 id（**裸编号**，未含层级）。 */
  nodeId: string
  /** 这个节点住第几层子工作流：顶层 0 / 不给按 0。 */
  depth?: number
  /** 日志行（`kind: 'log'` 时才有）。 */
  line?: string
  /** 实例备注名（`kind: 'started'` 时才有）。 */
  nodeLabel?: string
  /** 节点类型 id（`kind: 'started'` 时才有）。 */
  defId?: string
  /** 失败原因（`kind: 'failed'` 时才有）。 */
  error?: string
  /**
   * 这次调模型留下的痕迹（`success` / `failed` 都可能带）。
   *
   * ⚠️ 这里是 `unknown` 而**不是** `LlmTrace`：事件来自调度器、也可能来自网络或画布，
   * 形状不可信。**洗字段与截断在落盘那一侧做**（`workflow-runs.ts` 的 `normalizeLlmLine`），
   * 收集层只负责原样搬过去 —— 在这里强转成 `LlmTrace` 等于替那份校验撒谎。
   */
  llm?: unknown
  /**
   * 节点主动汇报的一条（`kind: 'report'` 时才有）。
   *
   * 同样用 `unknown`：形状由引擎的 `ReportEntry` 定，但事件可能来自网络，
   * 洗字段的活落在盘那一侧（与 `llm` 同一条纪律）。
   */
  entry?: unknown
}

/**
 * 把**一条**节点事件并进 `byNode`（所有收集器共用的一份规则）。
 *
 * ## 为什么是模块级导出的纯函数
 *
 * 这段「哪条事件改哪个字段」的规则本来抄了三份（`resumePausedRun`、
 * `runCollector`、`runner.ts` 的 `feed`）。抄多份的代价见文件头。
 * 抽出来之后三处调同一个函数，测试也能直接喂事件流验归并结果。
 *
 * ## 归并键是 `nodeKeyOf(depth, nodeId)`
 *
 * 子流程的节点 id 各自从 `n1` 起，与父流程**必然重名**。用裸 `nodeId` 当归并键，
 * 父的 `n3` 与子的 `n3` 会被合成一条明细（后写的覆盖标题、一份失败整条显示失败）。
 *
 * ⚠️ **`nodeId` 字段本身仍是裸编号** —— 键只用于合并判据。界面按编号查节点、
 * `outputs` / `{{变量}}` / `parentId` / 连边读的都是裸 `nodeId`，一个字都没变。
 *
 * @param byNode - 收集表（就地改）。
 * @param e - 一条调度器事件。
 */
export function mergeNodeEvent(byNode: Map<string, RunNodeLine>, e: NodeEventLike): void {
  const key = nodeKeyOf(e.depth, e.nodeId)
  let line = byNode.get(key)
  if (line === undefined) {
    line = { nodeId: e.nodeId, state: 'queued' }
    /* 层级只在**下钻过的节点**上写（顶层不写这个键，与 `truncated` 同一条纪律：
     * 能省一个键就省，别让每条明细都挂一个恒为 0 的字段）。 */
    if (typeof e.depth === 'number' && Number.isFinite(e.depth) && e.depth > 0) {
      line.depth = Math.floor(e.depth)
    }
    byNode.set(key, line)
  }
  if (e.kind === 'started') {
    line.state = 'running'
    if (line.startedAt === undefined) line.startedAt = Date.now()
    /* 实例名（「给它起个名字」）—— 用户要的标题就是它 + 编号。 */
    if (typeof e.nodeLabel === 'string' && e.nodeLabel !== '') line.label = e.nodeLabel
    /* 节点类型（如 `code.js`）—— 没起实例名时用它当标题，
     * 否则历史里只剩光秃秃的 `n1` / `n-gen`，认不出是干什么的。 */
    if (typeof e.defId === 'string' && e.defId !== '') line.defId = e.defId
  } else if (e.kind === 'success') {
    line.state = 'success'
    line.endedAt = Date.now()
    attachLlm(line, e.llm)
  } else if (e.kind === 'failed') {
    line.state = 'failed'
    line.endedAt = Date.now()
    if (typeof e.error === 'string') line.error = e.error
    /* 失败也要搬痕迹（契约 A2 立的规矩：最需要看痕迹的恰恰是失败那几次）。 */
    attachLlm(line, e.llm)
  } else if (e.kind === 'skipped') {
    line.state = 'skipped'
    line.endedAt = Date.now()
  } else if (e.kind === 'cancelled') {
    /* 中断之后**没轮到、这次也不会跑**（契约 AB）。
     * 与 `skipped` 分开：那个是「按配置跳过 / 这条分支没走」，是正常行为；
     * 这个是「前面有人失败、整条中断了」。
     * `endedAt` 照样写 —— 界面按它算时长，留着空会让那条明细显示成「跑了很久」。 */
    line.state = 'cancelled'
    line.endedAt = Date.now()
  } else if (e.kind === 'log' && typeof e.line === 'string') {
    const logs = line.logs ?? []
    logs.push(e.line)
    line.logs = logs
  } else if (e.kind === 'report') {
    /* ## 节点主动汇报（2026-10-25，契约 AN 的关键一环）
     *
     * 引擎那边已经做完了：节点 `ctx.report(entry)` → 执行方随派发结果交回
     * → `run.ts:1320` 把它 emit 成 `{ kind: 'report', nodeId, entry }` 事件。
     *
     * **事件到了这里如果没人接，整条汇报链就断在这一步** ——
     * 运行记录里永远不会有 `reports`，任务记录更取不到。而「三处都传了 onEvent」
     * 之类的断言照样是绿的（它们只证明事件发出去了，不证明事件被用上了）。
     *
     * 三条纪律照引擎那份（`model.ts:205-209`）：
     *   1. 不进 `outputs`，下游取不到 —— 这里只挂到明细上；
     *   2. 多轮多条**按到达顺序全留**，不去重（折叠显示是界面的事）；
     *   3. **不写空键**：一条都没推就不出现 `reports`。
     *
     * ⚠️ 形状用 `unknown` 搬过去（与 `llm` 同一条纪律）：事件可能来自网络，
     * 洗字段在落盘那一侧的 `normalizeReportLine`。 */
    if (e.entry !== undefined) {
      const list = line.reports ?? []
      list.push(e.entry as NonNullable<RunNodeLine['reports']>[number])
      line.reports = list
    }
  }
}

/**
 * 把事件里的痕迹挂到明细上（没有就**不写这个键**）。
 *
 * @param line - 明细（就地改）。
 * @param llm - 事件里带的痕迹（`unknown`，形状由落盘那侧洗）。
 */
function attachLlm(line: RunNodeLine, llm: unknown): void {
  if (llm !== undefined) line.llm = llm as RunNodeLine['llm']
}
