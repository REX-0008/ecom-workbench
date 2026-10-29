/** 工作流数据模型（两版画布共用的唯一真源）。
 *
 * 设计依据：docs/机制-设计依据.md §2.2；原始调研 docs/调研-工作流节点规范.md。
 *   D3 六态：idle / queued / running / success / failed / missing
 *   D4 失败三态：stop / continue / continueErrorOutput（失败走独立出边）
 *   D2 端口两重编码：颜色 + 连线同色
 * 节点应当声明依赖（deps）——⚠️ **但「缺件 → missing 态」还没做**（2026-10-23 核实）：
 *   · `deps` **有人读**：属性面板会把四类依赖列出来给人看
 *     （`src/client/workbench/NodeEditorPopover.tsx:32-38`、`:907`、`:1073-1080`）；
 *   · 但**没有任何代码会把状态置成 `missing`** —— 判定那一步是空的，
 *     自认写在 `src/workflow/env-check.ts:110-115`（「真正的依赖检测还没做」）。
 *   所以 `deps` 现在的作用是**声明与提示，不是保证**：缺件时节点照跑、照常报 failed。
 *   写节点时 `deps` 要填全，同时必须在 `detail.cautions` 里再说一句「缺什么、怎么装」。
 */

/** 节点运行状态（六态）。 */
export type NodeState =
  | 'idle'      // 未运行
  | 'queued'    // 排队中（派发器有并发上限）
  | 'running'   // 运行中
  | 'success'   // 成功
  | 'failed'    // 失败
  | 'missing'   // 依赖缺失（与 failed 区分：这不是运行出错，是环境缺件）
  /**
   * 被取消。
   *
   * 为什么不复用 idle：idle 的意思是「还没跑过」，取消是「跑了但被叫停」——两者事实不同。
   * 原先取消直接写回 idle，等于把「用户主动停过」这个信息丢了，
   * 事后无法区分「没跑」与「跑了一半被停」。
   */
  | 'cancelled'

/** 失败处理策略（三态）。 */
export type OnError =
  | 'stop'                 // 停止整个流程
  | 'continue'             // 继续（用空值）
  | 'continueErrorOutput'  // 失败结果走独立出边

/** 执行方（派发给谁）。 */
export type ExecutorKind = 'shell' | 'agent' | 'http' | 'builtin'

/** 数据类型（决定端口与连线的颜色）。 */
export type PortType = 'data' | 'text' | 'image' | 'number' | 'any'

/** 端口定义。 */
export interface PortDef {
  /** 悬停说明（这个端口给下游什么）。 */
  hint?: string
  /** 端口 id（同一节点内唯一，连线用 sourceHandle/targetHandle 指向它）。 */
  id: string
  /** 端口显示名。 */
  label: string
  /** 数据类型（决定颜色）。 */
  type: PortType
  /**
   * 这个入口是否允许接多条线。
   *
   * 默认为 false（一个入口一条线）——因为多数情况下「一个入口接两条线」是错的，
   * 数据来源会不明确。需要汇总多路数据的节点（如「合并」节点的两个入口、
   * 「执行 JS」要处理一批上游输出时）**显式打开**它。
   *
   * 引入理由（2026-10-08 用户决定「引入」）：
   * 我们此前**一刀切禁止多入**，当时的注释还自认「Langflow 没有这条」；
   * 但核实后发现 **Langflow 是允许的**——它对 list 类型字段放行。
   * 所以改为「默认禁止、按需放行」，既有安全默认值，又不堵住合理用法。
   */
  multi?: boolean
}

/**
 * 节点依赖声明。
 *
 * ## ⚠️ 延后执行（2026-10-13 核实）
 *
 * 用户 2026-10-13：「声明赖这一点，**等工作台第一版本完善后执行**，
 * 现在有写的地方备注一下，延后执行。」
 *
 * **现状：这是一个「声明了但没有任何读取方」的死字段。**
 * 核实过（2026-10-13）：
 *   - 18 个节点目录里**一个 `deps.json` 都没有**；
 *   - 全项目 grep `deps` 只有**本文件这两处声明**，**没有代码读它**。
 *
 * 所以原设计里的「缺失依赖 → `missing` 态」**目前不会发生** ——
 * 这个功能是空的。⚠️ **不要只补 `deps.json` 文件**：补了也没人读，是无效动作。
 * 要真正启用它，需要同时做：① 读 `deps.json` 的代码；② 运行前校验；
 * ③ `missing` 态在界面上的表现（现在 `NodeState` 里也还没有 `missing`）。
 *
 * **等第一版工作台完善后再做。**
 */
export interface NodeDeps {
  /** 需要的 NPM 包。 */
  npm?: string[]
  /** 需要的外部程序。 */
  bin?: string[]
  /** 需要的环境变量。 */
  env?: string[]
  /** 需要的随附文件。 */
  files?: string[]
}

/** 节点定义（节点类型，可复用）。 */
/**
 * 节点详细说明（展开设置时显示）。
 *
 * 结构照 Node-RED 的节点帮助页（Overview / Inputs / Outputs / Details）。
 * 每一段都是可选的——没有内容的段不显示，避免空标题。
 */
export interface NodeDetail {
  /** 做什么（一段话，含「用什么方式」）。 */
  what?: string
  /** 输入什么（与入端口对应）。 */
  inputs?: string
  /** 输出什么（与出端口对应）。 */
  outputs?: string
  /** 什么时候用（典型场景）。 */
  whenToUse?: string
  /** 注意什么（坑与限制）。 */
  cautions?: string
  /** 相关文档链接（可选）。 */
  docUrl?: string
}

/** 节点级提示的严重程度（照 n8n 的 info / warning / danger 三档）。 */
export type HintLevel = 'info' | 'warning' | 'danger'

/**
 * 节点失败后重试几次、隔多久（2026-10-19 加）。
 *
 * 参照物：源码 `douyin-ui.ts` 的 `downloadOne` —— 「效果未知」时等
 * `DL_RETRY_DELAY_MS`（5000ms）**整段重跑一次**（`attempt < 1`）。
 *
 * ## 为什么次数与间隔都做成参数
 *
 * 那条源码是**针对下载**写死的（1 次、5 秒）。但「重试几次合理」取决于节点干什么：
 *   · 点一个按钮 → 重试几乎没有代价，可以多试；
 *   · 下载一个大文件 → 重试代价高，还可能有副作用（重复扣费、重复提交）；
 *   · 查一次接口 → 3 次、间隔 1 秒是常见做法。
 *
 * 所以**次数与间隔由用户在节点设置里定**，我们只提供默认值（`NodeDef.retry`）。
 *
 * ⚠️ **不做「按错误类型分类重试」**：源码只重试「效果未知」，那是因为
 * `saveAsVerified` 能返回 `state: 'unknown'` 这种结构化结果。
 * 我们的派发结果只有 `ok` / `error` 一句话，按字符串猜「值不值得重试」
 * 等于把不可靠的规则写进核心 —— 用户想区分就自己用 `code.js` / IF 去分。
 */
export interface NodeRetry {
  /** 额外重试几次（0 = 不重试）。总尝试次数 = times + 1。 */
  times: number
  /** 两次尝试之间等多久（毫秒）。0 = 不等（测试与「立刻重试」用）。 */
  delayMs: number
}

/**
 * 从「节点定义 + 实例参数」读出这次该用多少超时（毫秒）。
 *
 * ## 三层优先级（契约 BE，2026-10-25）
 *
 * ```
 * 实例参数（params[def.timeoutParam]）   ← 用户当场填的，最高
 *   → def.timeoutMs                     ← 这类节点的物理上限
 *     → undefined                       ← 什么都没写，交给派发器的全局兜底（300 秒）
 * ```
 *
 * ## 为什么返回 `undefined` 而不是直接给 300000
 *
 * 给一个具体数字等于在这里**再定义一份全局兜底** —— 派发器那边已经有一份
 * （`DispatcherOptions.timeoutMs`，`dispatcher.ts:194`）。两份迟早漂，而漂的表现是
 * 「同一个节点换个入口跑，超时不一样」。所以这里什么都不给，让下游自己回落。
 *
 * ## 为什么是纯函数、为什么放在 `model.ts`
 *
 * `run.ts` 与将来的调用方都要这条规则；抽出来才能单测，
 * 也保证「实例参数优先」这条只在**一处**实现（写两遍必漂）。
 *
 * ⚠️ **容错**：存档可能被手改。非数字 / NaN / 负数一律当「没填」，继续往下回落 ——
 * 不能因为一个笔误的 `0` 就让节点**立刻**判超时（那种失败看着像代码坏了）。
 *
 * @param def - 节点定义（静态上限与参数名都从这里来）。
 * @param params - 本次实例参数（**已合并定义默认值**的那一份，不要再自己合一次）。
 * @returns 生效的超时（毫秒）；`undefined` = 交派发器的全局兜底。
 */
export function readTimeout(def: NodeDef, params: Record<string, unknown>): number | undefined {
  /* ① 实例参数覆盖（只有节点声明了参数名才读）。 */
  if (def.timeoutParam !== undefined && def.timeoutParam !== '') {
    const v = params[def.timeoutParam]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v)
  }
  /* ② 节点定义的静态上限。同样判 `> 0`（0 与负数当没填）。 */
  const stat = def.timeoutMs
  if (typeof stat === 'number' && Number.isFinite(stat) && stat > 0) return Math.floor(stat)
  /* ③ 都没写 → 交下游的全局兜底。 */
  return undefined
}

/**
 * 从「节点定义 + 实例参数」读出这次要重试几次、隔多久。
 *
 * ## 优先级：实例参数 > 节点定义
 *
 * 用户在节点设置里填的（`params.retryTimes` / `params.retryDelayMs`）优先；
 * 没填就退回节点定义声明的默认值（`def.retry`）。两者都没有 = 不重试。
 *
 * 为什么参数名带 `retry` 前缀而不是直接叫 `times` / `delay`：
 * 参数名会进存档、进界面的 hint，`times` 这种太泛的键名在别的节点里没法用。
 *
 * ⚠️ **容错**：存档可能被手改。负数 / NaN / 非数字一律当「没填」，
 * 且**次数上限硬拦 10**（防「重试 999 次」把界面卡死）。
 *
 * @param def - 节点定义（默认值来源）。
 * @param params - 本次实例参数（已合并定义默认值）。
 * @returns 要重试的次数与间隔（次数为 0 表示不重试）。
 */
export function readRetry(def: NodeDef, params: Record<string, unknown>): NodeRetry {
  const fromParams = (key: string): number | undefined => {
    const v = params[key]
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
    return Math.floor(v)
  }
  const timesRaw = fromParams('retryTimes')
  const delayRaw = fromParams('retryDelayMs')
  const times = timesRaw ?? def.retry?.times ?? 0
  const delayMs = delayRaw ?? def.retry?.delayMs ?? 0
  return {
    /* 小于 0 或非法一律当 0；上限 10（防御性硬拦，不是业务规则）。 */
    times: times > 0 ? Math.min(10, times) : 0,
    delayMs: delayMs > 0 ? Math.min(60_000, delayMs) : 0,
  }
}

/**
 * 节点在跑的过程中主动报的一件事（一条汇报）。
 *
 * ## 它解决什么（契约 AM，用户 2026-10-25）
 *
 * 内置节点函数只有一个返回值出口，想在跑的**过程中**说一句「我这次交出了什么」
 * 没有地方说。任务记录只能靠结束节点事后按编号去取 —— 取不到就是空，
 * 而用户看不出「是因为没东西、还是因为这个节点压根没报」。
 *
 * ## 与 n8n 的关系：同一套字段、同一条通道
 *
 * 用户定：**汇报**与 n8n 的 `hints` 是同一套东西，不拆两套。
 * 所以这里的字段直接照 n8n `IDisplayOptionsHint` 那一族，
 * `NodeHint`（静态声明）在它基础上多两个只在**静态**时有意义的键。
 *
 * ## 五条纪律（写实现的人要守）
 *
 * 1. **汇报不参与数据流**：不进 `outputs`，下游 `{{变量}}` 取不到 —— 数据流仍靠返回值。
 * 2. **一个节点可以推多次**（循环里每轮一条），按到达顺序全留，**记录层不去重**。
 * 3. **失败也要能汇报**：节点失败前推的那条要留着（那正是最需要看的一条）。
 * 4. **不写空键**：没推就不写 `reports`（与 `llm` / `depth` 同一条纪律）。
 * 5. **不许拿空话充数**：只报「完成」这类词的按没做算（用户明确要求）。
 */
export interface ReportEntry {
  /** 一句话说清这条报的是什么（必填）。 */
  message: string
  /** 级别，决定配色。默认 `'info'`。 */
  type?: HintLevel
  /**
   * 显示在哪一栏。
   *
   * ⚠️ 我们现在**只有「节点明细」一栏**，所以实际值固定 `'ndv'`。
   * 字段先留着（与 n8n 对齐），等有了多栏再让它生效 —— 不留的话将来加栏要改全部调用点。
   */
  location?: 'ndv' | 'outputPane' | 'inputPane'
  /**
   * 同类折叠：多条同类汇报合成一组显示。
   *
   * `summary` 里的 `{count}` 由界面替换成条数（例如「已写入 {count} 个文件」）。
   */
  group?: { key: string, summary: string, label?: string }
  /** 这次报的是哪一条（循环里靠它区分「第 3/5 条」）。 */
  item?: string
  /** 可量的数（条数 / 耗时 / 金额）。 */
  metrics?: Record<string, number>
  /** 这次交出的文件路径。 */
  files?: string[]
}

/**
 * 节点定义里**静态声明**的提示。
 *
 * 比 `ReportEntry` 多两个键 —— 它们只在「写死在节点定义里」时有意义：
 * 「什么时候显示」「什么条件下显示」。运行时推上来的汇报**不带这两个键**
 * （与 n8n 用 `Omit` 掐掉是同一条道理：运行时那条已经是「就现在、就要说」）。
 */
export interface NodeHint extends ReportEntry {
  /** 何时显示。**运行时推的汇报不带这个键**（照 n8n 的 Omit）。 */
  whenToDisplay?: 'always' | 'beforeExecution' | 'afterExecution'
  /** 显示条件（表达式）。只有静态声明有。 */
  displayCondition?: string
}

/**
 * 内置节点函数的上下文（`BuiltinFn` 的第二个参数）。
 *
 * ## 为什么它住在 `model.ts`
 *
 * 这个文件**不 import 任何东西**（纯类型与纯数据），所以：
 *   · 客户端能引（节点定义与界面都要它）；
 *   · 宿主半能引；
 *   · 派发层能引 —— `src/dispatch/executors.ts` 那边的 `BuiltinFn` 可以
 *     直接把 ctx 类型换成引本接口（**那样形状就只有一份**，不会漂）。
 *
 * ⚠️ 历史包袱：`executors.ts` 现在用的是它自己的匿名对象类型，与本接口同形。
 * 这次（契约 AM）**没有动它**（那是后端地盘）。两边形状要一致 ——
 * 加字段时两处都要加，或者由后端把签名换成 `ctx: BuiltinCtx`。
 */
export interface BuiltinCtx {
  /** 节点实例 id。 */
  nodeId: string
  /** 工作目录（节点里相对路径的基准）。 */
  workdir: string
  /** 上游节点的输出（按连线顺序）。 */
  upstream: unknown[]
  /**
   * 取消信号。
   *
   * **可选**：不传就是「这次不可取消」（与 2026-10-23 之前一样）。
   * 有它时，会等的内置函数（延迟 / 代码）要监听它并立刻结束。
   */
  signal?: AbortSignal
  /**
   * 往这次执行里追加一条汇报（`ReportEntry`）。
   *
   * ## 为什么是可选的
   *
   * 纪律 5：「`report` 在非『跑起来』的场景（如编译器 / 预览）必须可缺省」——
   * 不要因为加了它就要求所有调用方都传。节点实现里要判一下再用。
   *
   * 调度器收到后挂在**当前节点**名下（见 `run.ts`），循环里多轮的多条按到达顺序都留着。
   */
  report?: (entry: ReportEntry) => void
}

export interface NodeDef {
  /** 唯一 id，如 'collect.douyin'。 */
  id: string
  /** 显示名。 */
  label: string
  /** 一句话说明（画布上显示，也用作悬停提示；**不超过 2 行**）。 */
  summary?: string
  /**
   * 详细说明（展开设置时显示在参数上方）。
   *
   * 结构照 Node-RED 的节点帮助页（理由见 docs/机制-设计依据.md §2.1；原始调研 docs/调研-节点说明写法与UX规范.md）：
   *   - 做什么：一段话讲清（含「用什么方式」）
   *   - 输入 / 输出：分别说明（与端口对应）
   *   - 何时用：典型场景
   *   - 注意：坑与限制
   */
  detail?: NodeDetail
  /** 节点级提示（按条件、分级显示；照 n8n 的 hints 机制）。 */
  hints?: readonly NodeHint[]
  /** 派发给谁。 */
  executor: ExecutorKind
  /** 入口端口。 */
  inputs: PortDef[]
  /** 出口端口。 */
  outputs: PortDef[]
  /**
   * 依赖声明。
   *
   * ⚠️ **延后执行**（2026-10-13）：目前**没有任何代码读这个字段** ——
   * 原设计的「缺失依赖 → `missing` 态」是空的。
   * 详见 `NodeDeps` 的说明；**等第一版工作台完善后再做**。
   */
  deps?: NodeDeps
  /** 默认失败策略。 */
  onError?: OnError
  /**
   * 这一类节点自己的超时（毫秒）。不写就用全局值（300 秒）。
   *
   * ## 为什么它要住在**节点定义**上，而不是节点参数里
   *
   * 节点参数（`paramDefs`）是给用户改的；超时上限是**这一类节点**的物理属性
   * （生图要几分钟、写文件是毫秒级），不该让每个实例各调一遍。
   * 需要用户自己调的节点（如「执行命令」）已经在 `params.timeout` 里另有一个 ——
   * 那是**这条命令**的长短，两件事分开记。
   *
   * ## 链路（契约 BD 补上的后半段）
   *
   * ```
   * NodeDef.timeoutMs
   *   → run.ts 构 DispatchRequest 时透传（`spec.def.timeoutMs`）
   *   → 派发器 withTimeout：本请求优先，没有才回落全局 300 秒（dispatcher.ts:297-298）
   * ```
   *
   * ⚠️ **不写就完全不变**：`undefined` 走全局兜底，现有工作流行为一个字节不变。
   * 与 `depth` / `llm` 同一条纪律 —— 能省一个键就省，不写 `undefined`。
   */
  timeoutMs?: number
  /**
   * 让用户在**节点实例**上覆盖超时的**参数名**（契约 BE，2026-10-25）。
   *
   * 写 `'timeout'` 表示「取这个实例参数里的 `timeout` 当超时值」。
   * 不写就只用上面那个 `timeoutMs` 静态值。
   *
   * ## 为什么用声明，而不是在调度层按执行方特判
   *
   * 特判（「if 执行方是 shell 就读 params.timeout」）会把「哪些节点能调超时」
   * 写死在调度器里：以后浏览器动作想开放，还得再改 `run.ts` 一次 ——
   * 而调度器本来不该认识具体节点。声明式的代价只是节点定义多一行。
   *
   * ## 优先级（三层，逐层回落）
   *
   * ```
   * 实例参数（params[timeoutParam]）   ← 用户当场填的，最高
   *   → NodeDef.timeoutMs              ← 这类节点的物理上限
   *     → 派发器的全局兜底 300 秒       ← 什么都没写
   * ```
   *
   * ⚠️ **不写就与现在完全一致**：不会多读任何参数。
   */
  timeoutParam?: string
  /**
   * 默认重试（2026-10-19 加，照源码 `douyin-ui.ts` 的 `downloadOne` 重跑一次）。
   *
   * ## 为什么是「声明式」而不是让调度器自己分类
   *
   * 源码那条重试**只重试「效果未知」**（saveAs 被取消 / 文件没落盘），
   * 明确失败（`state === 'failed'`）不重试。判断「这类错值不值得重试」
   * 只有**节点自己**知道 —— 调度器手上只有一句 `error` 字符串，
   * 按字符串猜等于把不可靠的规则写进核心。
   *
   * 所以：**用户**在节点设置里填「重试几次、隔多久」（`paramDefs` 的参数），
   * **节点定义**决定默认值（就是这个字段）。调度器不做分类，只管按次数重试。
   *
   * ## 与 `onError` 的关系（最容易混的一处，别合并）
   *
   * | | 回答什么问题 |
   * |---|---|
   * | `onError` | 失败后**走不走**（`stop` 中断 / `continue` 往下） |
   * | `retry` | 失败后**再试几次** |
   *
   * 叠加语义：`continue` + `retry: 2` = 先重试 2 次，还失败就按 continue 往下走。
   *
   * ⚠️ **不配 = 不重试**（老存档行为一字不变）。
   */
  retry?: NodeRetry
  /** 默认参数（键值对，运行时用）。 */
  params?: Record<string, unknown>
  /**
   * 把参数拼成「派发给执行方的命令」。
   *
   * 不写就用通用约定（见 workflow/command.ts）——内置节点按 id 找函数，
   * HTTP 节点按 method/url/headers 拼。只有约定套不上的节点才需要自己写。
   * @param params - 本次实例的参数（**已做变量替换**）。
   * @param ctx - 运行上下文（可选，见 {@link CommandContext}）。
   * @returns 执行方各自解释的命令体。
   */
  toCommand?: (params: Record<string, unknown>, ctx?: CommandContext) => unknown
  /** 参数的表单定义（渲染表单用：控件类型、联动、折叠）。 */
  paramDefs?: ParamDef[]
  /** 默认分类 id（可选）。
   * 节点可自己声明属于哪一类；不声明时，由工作流侧的 CategoryAssignment 记录。
   * 见 model.ts 顶部的「节点分类」说明。 */
  category?: string
}

/** 画布上的节点实例。 */
export interface CanvasNode {
  /** 实例 id。 */
  id: string
  /** 引用的节点类型 id。 */
  defId: string
  /** 画布坐标。 */
  position: { x: number, y: number }
  /** 本次实例的参数（覆盖 def 的默认值）。 */
  params: Record<string, unknown>
  /** 本次实例的失败策略（覆盖 def 的默认值）。 */
  onError: OnError
  /** 运行状态。 */
  state: NodeState
  /**
   * 容器归属：本节点属于哪个容器节点（循环或分组框）。
   *
   * 与画布上的 `parentId` 同义（React Flow 的 Sub Flow 机制）：
   *   子节点挂 `parentId`，坐标从绝对变成**相对父节点**，拖动父时子跟着走。
   * 调度器只关心「父是循环节点」的那一类（那表示本节点是循环体）。
   */
  parentId?: string
  /**
   * 实例级显示名（覆盖 def.label）。
   *
   * 为什么需要（用户 2026-10-12）：LLM 写下的节点，「写的时候知道什么意思，
   * 看的时候忘了这个节点的意义」——类型说明说的是「这类节点干什么」，
   * 而这个字段说的是「**我在这里为什么用它**」。照 n8n 的 Rename node。
   */
  label?: string
  /**
   * 实例级备注（照 n8n 的 Notes，可选显示成节点副标题）。
   *
   * 与 `label` 的分工：label 是一句话的名字（节点上直接显示），
   * note 可以长一些（讲意图、讲背景），界面按需展开。
   */
  note?: string
  /** 运行进度说明（如「第 3/10 项」）。 */
  progress?: string
  /**
   * 是否跳过这个节点（用户点名的 P3 项）。
   *
   * 语义：**跳过 ＝ 不执行，但把它上游的输出原样传给下游**。
   * 为什么不等于「删掉」：调试时常常只想临时跳过一个费时的步骤（比如真的去下载），
   * 又不想断开连线、事后还得重连。
   *
   * 为什么不是「禁用」：禁用会让下游拿不到数据、整条链断掉；
   * 跳过是「透明地穿过去」，链还是通的——这才是调试时真正需要的。
   */
  skipped?: boolean
  /**
   * 是否折叠成一条（用户点名的 P2 项）。
   *
   * 折叠后的样子**照 ComfyUI**：只剩标题头 + 左右各一个合并的端口点，
   * 而不是「缩成一个小方块」——后者会让人不知道这节点是什么、能不能连。
   *
   * 与「跳过」的区别：跳过是**运行语义**（不执行），折叠是**显示语义**（只是收起来）。
   */
  collapsed?: boolean
}

/** 画布上的连线。 */
export interface CanvasEdge {
  /** 连线 id。 */
  id: string
  /** 起点节点。 */
  source: string
  /** 终点节点。 */
  target: string
  /** 起点端口（多出口时必须）。 */
  sourceHandle?: string
  /** 终点端口（多入口时必须）。 */
  targetHandle?: string
}

/** 一份完整工作流。 */
export interface WorkflowDef {
  /** 格式版本（便于以后迁移）。 */
  version: 1
  /** 工作流名。 */
  name: string
  /** 说明。 */
  description?: string
  /** 节点实例。 */
  nodes: CanvasNode[]
  /** 连线。 */
  edges: CanvasEdge[]
}


/* ── 参数定义（渲染表单用）─────────────────────────────────
 * 调研发现：原 NodeDef.params 只有「默认值」，缺「怎么渲染表单」。
 * 补这层后，节点表单可以：
 *   - 按类型渲染控件（text/number/bool/select/secret...）
 *   - 参数联动显隐（showWhen：选了 A 才显示 B）
 *   - 折叠到「高级设置」（advanced：界面显示简化版，详细设置选中后展开）
 * 这两条是 n8n 全部节点共用的规律（调研已验证）。
 */

/** 参数控件类型。 */
export type ParamKind =
  | 'text'      // 单行文本
  | 'textarea'  // 多行文本
  | 'number'    // 数字
  | 'boolean'   // 开关
  | 'select'    // 下拉单选
  | 'secret'    // 密钥（界面上打码）
  | 'json'      // JSON 文本
  | 'list'      // 字符串数组（一行一项）
  | 'kv'        // 键值对（如请求头、环境变量）
  | 'date'      // 日期（用系统日期控件）
  /**
   * **选「某个节点的某个输出字段」**（照 Dify 的 `ValueSelector`，2026-10-13 新增）。
   *
   * ## 为什么需要它
   *
   * 用户 2026-10-13 定规矩：「先看 n8n 与 Dify，**两家都没有的就不做**」，
   * 据此要拆掉我们循环节点上的进出端口（两家都没有这个做法）。
   *
   * 拆掉端口后「循环要遍历的数组从哪来」就必须换个地方说 —— Dify 的做法是
   * **参数选择器**：它的迭代节点**零 Handle**（我在 `nodes/iteration/node.tsx`
   * 里逐个找过，一个都没有），进出全靠
   * `iterator_selector: ValueSelector` 与 `output_selector: ValueSelector`。
   *
   * 所以本类型就是那个 `ValueSelector`：**两个下拉**（先选节点、再选它的输出字段），
   * 值存成 `{ nodeId, field }`。
   *
   * ⚠️ 与 `text` + `{{变量}}` 的分工：`{{变量}}` 适合「随手引用一个值」；
   * 本类型适合「**指定一个数据源**」—— 它有自己的候选列表（哪个节点、哪个字段），
   * 用户不用记变量名，也不会打错。
   *
   * 参照物原文（Dify `nodes/iteration/types.ts`）：
   * ```ts
   * export type IterationNodeType = CommonNodeType & {
   *   start_node_id: string
   *   iterator_selector: ValueSelector
   *   output_selector: ValueSelector
   * }
   * ```
   */
  | 'nodeField'
  /**
   * **选另一份工作流**（2026-10-19 新增，配合存档编号）。
   *
   * ## 为什么不能继续用 `text` 填名字
   *
   * 用户原话：「引用不要用名称匹配，当前工作流除了名称没有编号之类的吗？
   * 引用用的应该是编号而不是名称。」
   *
   * 名字是**给人看的标签**，用户随时会改；把它当程序里的键，一改名引用就断
   * （已发生过：`取数-抖音电商罗盘` 改名后，「一键下载」里还写着旧名字）。
   *
   * 所以本控件：**存的是编号 `doc.id`，显示的是名字**。
   * 与 n8n 的 Execute Sub-workflow 节点存 `workflowId` 完全一致。
   *
   * 值形状：`{ workflowId: string, name?: string }`
   *   - `workflowId` 是真正生效的那个（永不变）；
   *   - `name` 只是**显示缓存**（编号在后面某个存档里找到时用它的名字，
   *     找不到时退这个，好让用户看出「原来指的是谁」）。
   *
   * ⚠️ 候选项由**调用方**传（`workflowCandidates`）—— 工作流清单在宿主半手上，
   * 节点定义是纯数据、不能自己去读。
   */
  | 'workflowRef'
  /**
   * **结构化条件表**（2026-10-19 新增，`flow.if` 用）。
   *
   * ## 为什么不能继续用 `text` 填一段 JS 表达式
   *
   * 用户 2026-10-19：「照 Dify 做成『选变量 + 比较符 + 值』的结构化条件」。
   * 原来那一栏要用户写 `input.curfewTop !== true` —— 那是一行代码：
   * 打错一个字符运行时才报、看不懂的人完全没法用、也选不到循环变量。
   *
   * Dify 的 IF/ELSE 是**三格一组**：选变量（节点 + 字段）、选比较符、填值。
   * 我们把「一组」做成一行，可增删、可换「全部满足 / 满足任一」—— 那就是本控件。
   *
   * 值形状：`{ left: { kind, … }, op, value?, valueType? }[]`
   * （见 `workflow/branch.ts` 的 `IfCondition`）。
   * 左边三种来源（节点字段 / 循环变量 / 开始节点的输入）由控件按候选清单一并给出，
   * 用户不用记 id、也不会打错。
   *
   * ⚠️ 候选清单由**调用方**传（`fieldCandidates` + 循环变量 + 输入字段）——
   * 节点定义是纯数据、不能自己去读图，与 `nodeField` / `workflowRef` 同一条纪律。
   */
  | 'ifRules'
  /**
   * **选一个模型**（2026-10-23 新增，`ai.agent` 与 `flow.start` 用）。
   *
   * ## 为什么新起一个类型、不复用 `select`
   *
   * `select` 的 `options` 是**静态**写在节点定义里的，而模型清单是**运行时**
   * 从 dsh 读出来的（见计划 §2.5）。硬塞进 `select` 只能靠「界面认 key 叫 model」
   * 这种暗规则 —— 那正是要避免的：改一次 key 就要在两处同时改，且没有类型拦。
   *
   * ## 值形状：字符串 `"provider/model"`，**允许留空**
   *
   * 留空（空串）= 「跟随默认」，走计划 §2.2 的回落链。
   * 用户原话：「开始节点可以选择模型（也可以不选）」。
   *
   * ⚠️ **不要在调用方直接拼/拆这个字符串** —— 一律走 {@link encodeModelPick} 与
   * {@link decodeModelPick}。`/` 作为分隔符有歧义（模型名里可能带 `/`），
   * 将来形状若改成两段式对象，**只改那两个函数的实现**即可，调用方一行都不用动。
   */
  | 'model'

/**
 * 把「提供方 + 模型」拼成存档里的那个字符串。
 *
 * ## 为什么要有这个函数（而不是让各处直接拼）
 *
 * 值形状是**跨三方**的约定：节点定义声明它、引擎把它传下去、界面渲染与回写它。
 * 三处各拼一遍字符串，必然有一处写成 `model + '/' + provider` 或忘了判空 ——
 * 那种错不会当场报，只会表现为「选了模型却没生效」。
 * 收成一个函数后，**形状要变只改这里**。
 *
 * @param pick - 提供方与模型 id。
 * @returns `"provider/model"`；任何一段为空时返回**空串**（= 跟随默认）。
 */
export function encodeModelPick(pick: { provider: string, model: string }): string {
  const provider = typeof pick?.provider === 'string' ? pick.provider.trim() : ''
  const model = typeof pick?.model === 'string' ? pick.model.trim() : ''
  /* 缺一段就没有意义 —— 返回空串表示「没选」，而不是拼出 `"p/"` 这种半截值。
   * 半截值会让界面显示成一个不存在的模型，用户还找不到原因。 */
  if (provider === '' || model === '') return ''
  return provider + '/' + model
}

/**
 * 把存档里的那个字符串拆回「提供方 + 模型」。
 *
 * ## 歧义怎么处理（`/` 既当分隔符又可能出现在模型名里）
 *
 * 按**第一个** `/` 切：前半是 `provider`，后半整个是 `model`。
 * 这样 `openai/gpt-4o-mini` 与 `vendor/org/model` 都能正确还原
 * （provider id 里不会出现 `/`，模型名里可能有）。
 *
 * ## 什么时候返回 null（= 按「没选」处理）
 *
 *   · 不是字符串 / 空串 / 全空白；
 *   · 没有 `/`，或 `/` 在开头或结尾（缺了某一段）。
 *
 * **一律不抛**：存档可能被手改、也可能是别的版本写的 —— 读坏了就不认，
 * 退回落落链即可，不该让整份工作流打不开。
 *
 * @param s - 存档里的字符串。
 * @returns 拆出来的两段；不合法时 `null`。
 */
export function decodeModelPick(s: string): { provider: string, model: string } | null {
  if (typeof s !== 'string') return null
  const text = s.trim()
  if (text === '') return null
  const at = text.indexOf('/')
  /* `/` 不在中间 = 缺了 provider 或 model，两份都不完整。 */
  if (at <= 0 || at === text.length - 1) return null
  const provider = text.slice(0, at).trim()
  const model = text.slice(at + 1).trim()
  if (provider === '' || model === '') return null
  return { provider, model }
}

/**
 * 交给 `toCommand` 的**运行上下文**（与 `params` 分开，绝不混进去）。
 *
 * ## 为什么要有它
 *
 * `toCommand` 原来只拿得到节点自己的参数。但有些值**不是这个节点填的**、
 * 而是这次运行的环境给的 —— 第一个成员就是「开始节点选的模型」：
 * 用户在开始节点上选了模型、`ai.agent` 节点留空时就该沿用它。
 * 没有这个通道，那句话就是装饰性的。
 *
 * ## 为什么只放这一个字段，而不是把整张 `VariableScope` 交过去
 *
 * ① **最小授权**：节点定义只需要一个值。给它整张作用域（上游字段 + 环境变量 +
 *    全局变量）等于授予它读一切的能力，将来谁写错一行就把运行上下文混进命令体；
 * ② **可见性**：`node.ts` 是纯数据文件，按 `nodes-layout` 的纪律**只许 `import type`** ——
 *    它读不到 `__model` 那个常量，只能写字面量。所以「从保留键里摘出来」这一步
 *    必须由 `command.ts`（可以 import 值）做，节点定义只拿摘好的结果。
 *
 * ⚠️ **本对象里的东西一律不进 `params`**：`params` 是用户填的参数，
 * 混进去会让运行上下文伪装成用户输入（连变量替换都会去替换它）。
 */
export interface CommandContext {
  /**
   * 这次运行继承来的模型，**已经拆成两段**（没选时整个键不出现）。
   *
   * ## 为什么是对象而不是 `"provider/model"` 字符串
   *
   * 两个理由：
   *   ① 模型 id 里可能带 `/`（pi-ai 那条多 provider 通道、用户自配的名字）。
   *      交给下游的是**拆好的两段**，歧义在这个函数里一次性消掉，
   *      不会出现「我们按第一个 `/` 切、下游按恰好两段切」这种两侧不一致
   *      ——  那种不一致的后果是**静默回落到默认模型**，最难查；
   *   ② `node.ts` 只许 `import type`，它读不到 `decodeModelPick`。
   *      若这里给字符串，节点定义就得自己再切一次 —— 那就有了第二份切法。
   *
   * 拆的动作在 {@link toCommandContext} 里做（同一文件，能调 `decodeModelPick`）。
   */
  model?: { provider: string, model: string }
}

/**
 * 一次运行里「不是这个节点填的、但这次运行要用」的值（`CommandContext` 的来源）。
 *
 * 由 `run.ts` 从运行现场组装、`command.ts` 交给 `toCommand`。
 * 与 `CommandContext` 分开的理由：这一份是**引擎内部**的形状（可以有多个来源），
 * 交给节点定义的那一份是**最小授权**的面（只留该给节点的）。
 */
export interface RunContextValues {
  /** 开始节点选的模型（`"provider/model"` 字符串）；没选 = 不写这个键。 */
  model?: string
}

/**
 * 交出模型痕迹的那一份「运行上下文」。
 *
 * 纯函数 + 不 import 任何东西，所以节点定义也能引用它的**类型**。
 *
 * @param values - 引擎内部的运行上下文。
 * @param def - 节点定义（用它找 `kind: 'model'` 的参数，见下）。
 * @param params - 本次实例参数（已做变量替换）。
 * @returns 只含该给节点的那几项的 `CommandContext`。
 */
export function toCommandContext(
  values: RunContextValues | undefined,
  def?: NodeDef,
  params?: Record<string, unknown>,
): CommandContext {
  const out: CommandContext = {}
  /* ① 本节点自己填的（`paramDefs` 里 `kind: 'model'` 的那几项）。
   *    按**声明**找，不按参数名找 —— 将来别的节点也能有模型参数，不用改这里。
   *    有多个时取第一个（当前只有 `ai.agent` 有一个）。 */
  let own: string | undefined
  for (const p of def?.paramDefs ?? []) {
    if (p.kind !== 'model') continue
    const v = params?.[p.key]
    if (typeof v === 'string' && v.trim() !== '') { own = v.trim(); break }
  }
  /* ② 没有就继承这次运行带来的那个（开始节点的保留键 `__model`）。
   *
   * **这个顺序就是节点级的优先级**：本节点填的 > 运行上下文带来的 > 都没有就不写。 */
  const raw = own ?? (typeof values?.model === 'string' ? values.model.trim() : '')
  /* 拆成两段（`decodeModelPick` 返回 null = 格式不合法 → 当没有，往下跌落）。
   * ⚠️ 只在这里切一次：节点定义拿到的是拆好的对象，不再自己切。
   * 这也是为什么 `node.ts` 只 `import type` 也够用 —— 它根本不需要那个函数。 */
  const picked = raw === '' ? null : decodeModelPick(raw)
  if (picked !== null) out.model = picked
  return out
}

/** 参数联动条件：当另一个参数等于某个值时，本参数才显示。 */
export interface ParamShowWhen {
  /** 依赖的参数名。 */
  key: string
  /** 依赖参数的期望值（等于其中之一即显示）。 */
  equals: readonly (string | number | boolean)[]
}

/**
 * 一个参数的完整定义。
 *
 * 设计依据：docs/机制-设计依据.md §2.2（照 n8n 的 hints 机制）；原始调研 docs/调研-节点说明写法与UX规范.md。
 *   - `hint` **常显在输入框下方**（n8n 的 parameter hint），不是藏在悬停里
 *   - 有默认值要写明「默认 …」（n8n：Explain this in the field description）
 *   - 下拉的说明要讲「选不同值有何不同」，不要复述选项名
 *   - 文本/数字要写「格式 / 单位 / 边界」，示例用「如」
 */
export interface ParamDef {
  /** 参数名（也是 params 里的键）。 */
  key: string
  /** 界面显示名（中文；用「标题式」写法，与 n8n 的 Title case 对应）。 */
  label: string
  /** 控件类型。 */
  kind: ParamKind
  /** 默认值。 */
  default?: unknown
  /** 是否必填。 */
  required?: boolean
  /**
   * 选项（kind 为 select 时）。**能给选项就给选项**，别用自由文本。
   *
   * `description` 是**每个选项自己的一句话**（如「最快，但页面可能还没内容」），
   * 选的时候能看出差别 —— 26 个节点的选项里一直在用它、界面也一直在显示它，
   * 只是这个类型定义漏了这个字段（2026-10-11 补：让宿主半 import 节点库后，
   * 类型检查才覆盖到这个文件，53 处报错全是它）。
   */
  options?: readonly { value: string, label: string, description?: string }[]
  /**
   * 一句话说明——**常显在输入框下方**（必填项）。
   *
   * 写法要求（n8n / Dify 写作指南）：
   *   - 说「**影响什么**」，不说「它是什么」（别写「请输入超时时间」这种同义反复）
   *   - 开关用「是否 …」开头；有默认值补「默认 …」
   *   - 下拉讲「选不同值的区别」；文本/数字讲「格式 / 单位 / 边界」，示例用「如」
   *   - 判据：**读者读完这句会不会换个做法？不会就该删**
   */
  hint: string
  /** 输入框占位提示（只在输入框为空时显示，适合给格式样例）。 */
  placeholder?: string
  /** 联动显隐条件（不满足则不显示）。 */
  showWhen?: ParamShowWhen
  /**
   * **界面上不渲染这个参数，但它的值照旧存在、照旧被用**。
   *
   * ## 两家参照物都有这一条（所以不是我们发明的）
   *
   *   · **n8n**：`NodePropertyTypes` 里有 `'hidden'`，而参数面板的判据是
   *     `useNodeSettingsParameters.ts` 里一行**写得很直白**的短路：
   *     `// Fast path: hidden parameters are never displayed` →
   *     `if (parameter.type === 'hidden') return false`。
   *   · **Dify**：`web/app/components/workflow/types.ts:257` 的 `hide?: boolean`，
   *     面板按 `v.hide !== true` 过滤。
   *
   * ## 为什么需要它（用户 2026-10-16 报的重复）
   *
   * 用户原话：「playwright节点，现在还有用哪个浏览器设置，这个设置和浏览器中的
   * 标签重复了对吧？看一下，如果是重复了就去掉他。」
   *
   * 确认属实：`browser.act` 的 `session` 参数在**参数区**渲染成一个普通文本框，
   * 而下面「浏览器」一节里的「标签」输入框**写的是同一个 `params.session`** ——
   * 同一个值、两个入口，改哪个都行但看着像两件事。
   *
   * 保留参数定义（而不是删掉它）有三个理由，缺一个都会引入新问题：
   *   ① `def.params.session` 的默认值、以及编辑器/执行链读的都是**这个键**；
   *   ② 节点卡片上的**会话色标**靠 `hasSession(paramDefs)` 判断该不该显示 ——
   *      判据就是「有没有这个参数」，删了它色标也没了；
   *   ③ 「浏览器」一节的**出现条件**用的也是同一条判据。
   *
   * ⚠️ 与 `showWhen` 的分工：`showWhen` 是**条件显示**（用户能通过别的选择让它出现）；
   * `hidden` 是**永不在参数区出现**（它的界面在别处，这里只是数据的落地位置）。
   */
  hidden?: boolean
  /** 是否高级参数：界面默认折叠，展开详细设置后才显示。 */
  advanced?: boolean
  /** 单位（数字类，如 ms / 秒 / 条）。 */
  unit?: string
  /** 数字下限（kind 为 number 时）。 */
  min?: number
  /** 数字上限（kind 为 number 时）。 */
  max?: number
  /** 数字步长（kind 为 number 时，如 1 / 0.1）。 */
  step?: number
  /**
   * 这个参数要**哪一类**模型（票 70，2026-10-29）。只有 `kind: 'model'` 时才有意义。
   *
   * ## 为什么现在只声明、不拿来过滤
   *
   * 工作流这边 `kind: 'model'` 的选项来自 dsh 的模型目录
   * （`model-prefs.json` 的备选名单）。而 dsh 适配层**不给类型**
   * —— `readModelsCatalog()` 每条只有 `id / name / description`
   * （`src/index.ts:384-392`），`description` 是自由文本，不能当判据。
   *
   * 所以现在声明它**不改变下拉内容**（有一条第 2 项验收钉着「改动前后逐条相同」）。
   * 它为的是将来：一旦出现「要图片模型」的节点，凭这个字段就不会误列文本模型。
   *
   * ## 取值
   *
   * `MODEL_TYPES` 的五个之一（`text` / `t2i` / `i2i` / `video` / `audio`）。
   * 用 `string` 而不是那个类型是为了不让 `workflow/` 依赖 `schedule/`
   * —— 两边分层在 `docs/指引-工程结构与边界.md` 里写着。
   *
   * ⚠️ **必须可选**：老节点定义没有这个字段，改成必填会让所有存档里的节点读出来就崩。
   */
  modelType?: string
}

/* ── 节点分类 ─────────────────────────────────────────────
 * 委托人要求：「节点可以自己声明是什么类型，也可以不声明、在工作流里面自己记录自己分」。
 * 所以分两层：
 *   1. NodeDef.category —— 节点自带默认分类（可选，方便复用）
 *   2. WorkflowCategoryMap —— 工作流里对该节点实例的分类覆盖（可选）
 * 取值优先级：工作流覆盖 > 节点声明 > 兜底分类（'other'）。
 */

/** 节点分类定义。 */
export interface NodeCategory {
  /** 分类 id。 */
  id: string
  /** 显示名。 */
  label: string
  /** 排序权重（小的在前）。 */
  order: number
}

/** 兜底分类（节点既没声明、工作流也没记录时归到这里）。 */
export const CATEGORY_FALLBACK = 'other'

/** 内置分类清单（顺序即显示顺序）。
 *
 * ⚠️ `ecom`（电商业务）与 `data`（数据处理）两个分类**保留在清单里，但当前没有节点**。
 *
 * 2026-10-27（票 21）把六个「未完善」节点删掉了，其中五个是 `ecom` 组的
 * （`product.get` / `sku.update` / `order.pull` / `image.gen` / `copy.gen`）、
 * 一个是 `data` 组的（`data.map`）。删的理由是「通用节点能覆盖，留一个永远不完善的
 * 按钮比没有更糟」，判定写在票 21 的评论里。
 *
 * **为什么分类本身不删**：节点库按分类渲染，空分类**不会显示**（`WorkflowCanvas.tsx:416`
 * 的 `filter(x => x.defs.length > 0)`）。保留 id 有两个用处：
 *   ① 存档里记着分类（`WorkflowCategoryMap` 按节点实例 id 存分类 id），
 *      删掉的话老存档里那些 id 会变成未定义分类；
 *   ② 将来真要做电商取数（要先定平台接口与鉴权）或字段映射时，直接往这两个分类里加节点。
 */
export const NODE_CATEGORIES: readonly NodeCategory[] = [
  { id: 'flow', label: '流程控制', order: 10 },
  { id: 'collect', label: '爬虫采集', order: 20 },
  { id: 'browser', label: '浏览器操作', order: 30 },
  { id: 'code', label: '代码执行', order: 40 },
  { id: 'ecom', label: '电商业务', order: 50 },
  { id: 'terminal', label: '终端系统', order: 60 },
  { id: 'data', label: '数据处理', order: 70 },
  { id: 'ai', label: 'AI 能力', order: 80 },
  { id: CATEGORY_FALLBACK, label: '其他', order: 999 },
]

/** 工作流里对某个节点实例的分类记录（覆盖节点自带声明）。 */
export interface WorkflowCategoryMap {
  /** 节点实例 id → 分类 id。 */
  [nodeId: string]: string
}

/**
 * 解析一个节点最终属于哪个分类。
 * @param def - 节点定义（可能带 category）。
 * @param override - 工作流里对该实例的分类覆盖（优先）。
 * @returns 分类 id。
 */
export function resolveCategory(def: { category?: string }, override?: string): string {
  if (override !== undefined && override !== '') return override
  if (def.category !== undefined && def.category !== '') return def.category
  return CATEGORY_FALLBACK
}

/** 端口类型 → 颜色（两版共用；D2 ＝颜色+连线同色）。
 *
 * ## ⚠️ `any` 必须**醒目**（2026-10-15 改，用户反馈）
 *
 * 用户原话：「**连线给任意也加一种颜色吧，到处是灰色的线不好看**」
 * （后来澄清：「连线颜色指的是 `any` 这种常见的没有颜色」）。
 *
 * 事实依据（我统计过）：全仓端口类型用得最多的是 **`any`（19 次，5 种里最多）**，
 * 而它原来是 `#9aa4b2`（**灰蓝色**）。
 * 原因很直接：`any` 是「任意类型」的兜底口，几乎每个节点都有进/出口 ——
 * 它一变灰，整张画布就是一片灰线。
 *
 * 新色 `#a78bfa`（紫）：与另外四种**色相差得开**（蓝 / 琥珀 / 粉 / 青），
 * 且不是灰，所以「一条 `any` 线」在画布上看得见。
 * 亮度中等，深色底与浅色底都够对比。
 */
export const PORT_COLORS: Record<PortType, string> = {
  data: '#7c9cff',
  text: '#f0b429',
  image: '#e5709b',
  number: '#4ec9b0',
  any: '#a78bfa',
}

/** 状态 → 显示信息（两版共用文案）。 */
export const STATE_META: Record<NodeState, { label: string, tone: string }> = {
  idle:    { label: '待运行', tone: 'neutral' },
  queued:  { label: '排队中', tone: 'neutral' },
  running: { label: '运行中', tone: 'active' },
  success: { label: '成功',   tone: 'ok' },
  failed:  { label: '失败',   tone: 'error' },
  missing: { label: '缺依赖', tone: 'warn' },
  cancelled: { label: '已取消', tone: 'neutral' },
}
