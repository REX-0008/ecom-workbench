/** 工作流调度器（**共用**：宿主半与画布都用同一份）。
 *
 * ## 为什么要有这个文件
 *
 * 2026-10-11 之前，「跑工作流」的逻辑**住在画布组件里**（`WorkflowCanvas.tsx` 的 `runSeq`）：
 * 它既算执行顺序、又收上游数据、又改节点颜色、又写日志面板——四件事缠在一个函数里。
 * 后果是：**想跑工作流就必须把画布开着**（关掉工作台，那个「大脑」就没了）。
 * 而采集这类场景要的是**无界面定时跑**，按那个结构根本做不到。
 *
 * 所以按职责切开：
 *
 * | 谁 | 管什么 |
 * | --- | --- |
 * | **本文件** | 算顺序、收上游、跳过语义、失败策略、决定「下一个跑谁」 |
 * | 调用方（画布） | 把「开始了/成功了/失败了」画到界面上 |
 * | 调用方（宿主半） | 写运行记录；派发直接走本地派发器 |
 *
 * ## 一条纪律：**只此一份跑法**
 *
 * 画布与宿主半**必须**都调这里。各写一套跑法必然分叉——
 * 到时候「画布上跑得好好的、后台跑就不对」这类问题会很难查。
 *
 * ## 与旧实现的对应关系（保证行为不变）
 *
 * 旧 `runSeq` 里的每一步在这里都有对应，顺序与语义**逐条照搬**：
 *   - `topoSort` + 环排最后 → 见 `order`
 *   - 整图跑 / 点名跑（含上游）→ 见 `targets`
 *   - 跳过 = 不执行、上游原样传下去 → 见 `passthroughOf`
 *   - 失败策略 stop=中断整条 / continue=往下走 → 见 catch 里那两行
 *   - 中断（用户点停止）在每个节点前后都检查 → 见 `signal.aborted`
 */
import { topoSort, withUpstream, type TopoEdge } from './topo.ts'
import { buildCommand } from './command.ts'
import { passthroughOf } from './skip.ts'
import { LOOP_DEF_ID, containerMap, loopPlan, loopChainDepth, loopVarFields, scopedOutputOf, iterationItems, collectRound, readNodeField, resolveNodeField, buildLoopOutput, readBreakConditions, shouldBreakLoop, type BreakRule } from './loop.ts'
import { parseInputFields, parseAssignments, parseOutputFields, resolveInputs, missingRequired } from './io-fields.ts'
import { substituteDeep, reservedKeysOf, withoutReservedKeys, MODEL_KEY, type VariableScope } from './variables.ts'
import { liveHandles, edgeIsLive, BRANCH_KEY, ERROR_HANDLE, type ResolvedCondition } from './branch.ts'
import { IF_DEF_ID, planIf, resolveOperand, type IfPlan } from './if-condition.ts'
import { readRetry, readTimeout, type NodeDef, type OnError, type ReportEntry, type RunContextValues } from './model.ts'
/* 模型痕迹的形状（三方共用一份，定义在 `dispatch/llm-trace.ts`，那个文件不 import 任何东西）。 */
import type { LlmTrace } from '../dispatch/llm-trace.ts'
/* 运行现场（可存成 JSON 的那一份）—— 暂停 / 恢复用。
 * ⚠️ 那个文件是**纯逻辑**（不碰磁盘）：本文件被画布与宿主半共用，
 * 引 `node:fs` 会让画布打不出来。落盘在 `pause-store.ts`（只宿主半引）。 */
import { readWaitPlan, manualTimeoutReason, alertTimeoutReason, type RunSnapshot, type WaitPlan } from './snapshot.ts'
/* 并行体的切分与收口（纯函数、可单测）。执行在本文件，规则在那边 —— 与 `loop.ts` 同一个拆法。 */
import { parallelPlan, PARALLEL_DEF_ID } from './parallel.ts'

/** 「跑另一份工作流」节点的定义 id（照 `LOOP_DEF_ID` 的写法）。 */
export const WORKFLOW_DEF_ID = 'flow.workflow'

/** 「开始」节点的定义 id（用户 m00901 定案：输入 = 开始节点）。 */
export const START_DEF_ID = 'flow.start'

/** 「结束」节点的定义 id（用户 m00901 定案：输出 = 结束节点）。 */
export const END_DEF_ID = 'flow.end'

/**
 * 「等待」节点的定义 id（计划 Step 12 的第一步）。
 *
 * 与循环 / 子工作流 / 开始 / 结束同一类：**由调度器解释执行**，不进 `NODE_IMPLS`
 * —— 它要的是「把整个运行现场存下来并停下」，那是调度器才有能力做的事。
 */
export const WAIT_DEF_ID = 'flow.wait'

/**
 * 「Windows 通知与等待」节点的定义 id（票 07 第一轮）。
 *
 * 它由调度器解释执行，不进 `NODE_IMPLS` —— 理由与 `flow.wait` 完全一样：
 * 它要「把整个运行现场存下来并停下」，那是只有调度器才做得到的事。
 *
 * ⚠️ **`mode: 'none'` 时不挂起**。那时它只是「发一条通知 + 把上游原样传下去」，
 * 走的是普通节点那条路（引擎里把这一档交给 `dispatch`，因为发通知要 PowerShell
 * 子进程，那是执行方的事）。
 */
export const ALERT_WAIT_DEF_ID = 'flow.alert-wait'

/**
 * 「通知」节点的定义 id（`alert-wait` 发通知那一半复用它）。
 *
 * 为什么复用这个 id 而不是自己再写一套发通知：`src/nodes/flow/notify/impl.ts`
 * 里那套「按提醒设置算发不发、按级别过门槛、四种原因四种文案」是**唯一的实现**。
 * 在 `alert-wait` 里重写一遍，两处规则必然漂 —— 而用户对「为什么没收到提醒」这件事
 * 已经有四种不同处置，两处说法不一致就是灾难。
 */
export const NOTIFY_DEF_ID = 'flow.notify'

/**
 * 子工作流的最大嵌套层数。
 *
 * 为什么必须有上限：`A 调 B、B 调 A` 这样的配置会一直转下去，
 * 而每一层都要建自己的图与作用域 —— 到不了栈溢出就先卡死了，
 * 而且界面上只能看到「一直在跑」，看不出原因。
 *
 * 取 5：真实的组合层最深是 3 层（`0一键更新 → 一键下载 → 抖音表单下载`），
 * 留两层的余量给以后拆得更细。
 */
const MAX_SUB_DEPTH = 5

/**
 * 循环的最大嵌套层数（2026-10-19 加，替代原来「嵌套就报错」那道硬拦）。
 *
 * **不是技术限制，是防呆**（用户批准的那条）：
 *   - 无限嵌套会耗尽内存，且出错时日志里根本看不清是哪一层的哪一轮；
 *   - 真需要 6 层的人应该先把工作流拆开（拆成几份、用「跑另一份工作流」串起来）。
 *
 * 取 5：用户当前的真实需求是 **2 层**，留三层余量给以后。
 * 与 `MAX_SUB_DEPTH` 取同一个数只是巧合，两件事（子工作流 vs 循环层数）互不相干，
 * 将来要调也只该单独调这一个。
 */
const MAX_LOOP_DEPTH = 5

/** 要跑的一个节点（工作流文档里的一条 + 它查到的定义）。 */
export interface RunNodeSpec {
  /** 节点实例 id。 */
  id: string
  /** 节点定义（按 `defId` 查出来的）。 */
  def: NodeDef
  /** 本次实例的参数（**已合并定义里的默认值**）。 */
  params: Record<string, unknown>
  /** 这个节点的失败策略。 */
  onError: OnError
  /** 是否被用户标为「跳过」。 */
  skipped: boolean
  /**
   * 容器归属：本节点**属于**哪个容器节点（循环或分组框）。
   *
   * 与画布上的 `parentId` 同一含义（React Flow 的 Sub Flow）。
   * 调度器只关心「父是循环节点」的那一类 —— 那表示本节点是循环体。
   * 分组框的父不参与执行（它纯粹是背景），所以会被忽略。
   */
  parentId?: string
  /**
   * 实例名（节点上那个「给它起个名字」，已合并 `note` 的兜底）。
   *
   * 为什么调度器要知道它：用户 m03287 要求运行历史的节点明细
   * 「**以哪个节点的备注名称、编号为标题**」——只给 `n7` 这种编号没法认。
   * 定义文件是纯数据，存这个名字最省事（不必让历史模块再回去读一遍存档）。
   */
  label?: string
}

/** 一次运行的输入。 */
export interface RunGraphInput {
  /** 要跑的节点（不必是全部；调用方按 targets 过滤好也行，这里也会过滤）。 */
  nodes: readonly RunNodeSpec[]
  /** 连线。 */
  edges: readonly TopoEdge[]
  /**
   * 只跑这些节点（**连同它们的上游**）。
   * 不传 = 整图跑。
   */
  targets?: readonly string[]
  /**
   * 点名跑时要不要**带上上游**（默认 true）。
   *
   * 为什么需要这个开关（2026-10-11 加）：两种入口的意图不同 ——
   *   - 「**从这里跑**」：把上游先跑一遍，下游才有数据。→ true
   *   - 「**只跑这个**」（单节点调试）：就是要单独看这一个节点，不要牵连上游。→ false
   * 原先画布两个入口传的是同一组参数，于是「只跑这个」实际会连上游一起跑 ——
   * 与它自己的说明（「只运行这一个节点」）不符。这个开关把那件事说清楚。
   */
  includeUpstream?: boolean
  /** 工作目录（传给执行方）。 */
  workdir?: string
  /** 额外环境变量（变量替换的取值来源之一）。 */
  env?: Record<string, string>
  /**
   * 外部喂进来的输入（**由开始节点声明决定收哪些**）。
   *
   * ## 与 `env` / `vars` 的分工（用户 m00901 定的形态）
   *
   *   · `inputs` —— 这份工作流**声明的**输入（开始节点的「输入项」）；
   *     调用方按声明喂值，多给的一律丢掉（见 `io-fields.ts` 的 `resolveInputs`）。
   *   · `env` —— 环境变量（`{{env.名字}}`）。
   *
   * ⚠️ **不传 `inputs` 时不报错**：一份没有开始节点的工作流照样能跑
   * （用户手动跑、或它本来就自带初始数据）。这正是用户 m00901 要的语义 ——
   * 「没有开始节点 = 没法接外部输入」，而不是「不许跑」。
   *
   * ⚠️ **必须传给子工作流**（2026-10-17）：父流程调子流程时把自己这一路的
   * 输入带下去 —— 否则「一键下载」这类组合层没法把参数透给下面。
   */
  inputs?: Record<string, unknown>
  /**
   * 一份**已经挂起的运行**的现场 —— 给了它就从挂起处接着跑，而不是从头跑。
   *
   * ## 语义（三条，缺一个就会「恢复」成别的东西）
   *
   *  1. **`outputs` / `ran` / `executions` / `inputs` 从现场恢复** —— 否则恢复后
   *     下游拿不到前半段的数据，看起来像「恢复了个寂寞」。
   *  2. **`unreachable` 也恢复** —— 已经判过「未走的分支」的节点，恢复后
   *     必须还是「没走」，否则它们会突然开始跑（静默地多做了一堆事）。
   *  3. **从 `resumeAfter` 的下游开始**，不是从它本身 —— 它自己那次已经跑过了
   *     （输出就在现场里），再跑一遍会**再挂一次**，无限循环。
   *
   * ## 与 `targets` 的关系
   *
   * 恢复时**忽略 `targets`**：现场里已经定死了「这次要跑的是整张图」。
   * 两者同时给会分不清「只跑这几个」与「接着跑完」，所以后者赢 —— 由这里明说，
   * 而不是让两个参数打架。
   */
  resume?: RunSnapshot
  /**
   * 这份工作流存档的**执行指纹**（票 17，2026-10-27）—— 挂起时写进现场，恢复时拿它比对。
   *
   * ## 为什么由调用方给，不在这里算
   *
   * 算指纹要读存档、要 `node:crypto`，而本文件是**画布与宿主半共用**的
   * （`WorkflowCanvas.tsx:45` 引它）—— 引了 `node:crypto` 客户端就打不出来。
   * 所以算的地方在 `fingerprint.ts`（只宿主半引），这里只负责**把它带进现场**。
   *
   * 不传就不写这个键（`fingerprint` 在 `RunSnapshot` 上是可选的）——
   * 画布那条路本来就没有存档原文可算，行为与改动前一致。
   */
  fingerprint?: string
  /**
   * 跑另一份工作流的能力（**由调用方注入**）。
   *
   * ## 为什么是注入而不是直接 import
   *
   * 「读一份存档 → 跑它」住在 `run-file.ts`，而那个文件**已经 import 本文件** ——
   * 本文件再 import 回去就成环了。所以这个能力从外面递进来。
   *
   * 宿主半递的是 `runWorkflowFile` 自己（于是子工作流可以再套子工作流）；
   * 画布递的是「请宿主半跑这份」的 HTTP 调用（画布自己碰不到磁盘）。
   *
   * 不传 = 这张图上没人能跑子工作流（`flow.workflow` 节点会明确报错，不是静默不跑）。
   */
  runWorkflow?: SubWorkflowFn
}

/** 跑另一份工作流时用的**引用**（编号优先、名字只做老存档兼容）。
 *
 * 单独起个别名，是为了让 `run.ts` 的正文读起来还是「引用」这个业务词，
 * 而不是满地 `import('./ids.ts').WorkflowRef`。*/
type SubWorkflowRef = import('./ids.ts').WorkflowRef

/**
 * 跑另一份工作流：给它**引用**（与要喂给它的输入），它回来告诉你成没成。
 *
 * ## ⚠️ 第一参从「名字」变成了「引用」（2026-10-19）
 *
 * 用户原话：「引用用的应该是编号而不是名称。」
 *
 * 老写法只有名字，一改名引用就断（已发生过）。新写法是
 * `{ id, name }`：`id` 优先、`name` 只是兼容老存档的退路。
 *
 * ⚠️ 为了让**旧的调用点照旧能编译**（`tests/io-run.mjs` 那批桩还传字符串），
 * 这一参的类型是「引用 | 字符串」—— 给字符串等于只给名字。
 */
export type SubWorkflowFn = (
  ref: SubWorkflowRef | string,
  signal?: AbortSignal,
  /**
   * 要喂给子工作流的输入（父流程按**子流程自己声明的**字段名给）。
   *
   * ⚠️ **可选第三参**（2026-10-17）：不动前两个参数，所以画布那条
   * 「请宿主半跑这份」的 HTTP 版与宿主半那版都**照旧能编译** ——
   * 不传输入就等于「这次不给值」，由子流程的默认值兜底。
   */
  inputs?: Record<string, unknown>,
) => Promise<{ ok: boolean, ran?: string[], error?: string }>

/**
 * 节点级事件共有的那一项：这个节点住第几层。
 *
 * ## 为什么要有它（2026-10-23，修「父子同名节点在运行记录里撞车」）
 *
 * 子工作流里的节点 id 各自从 `n1` 起，与父流程**必然重名**（父的 `n3` 与子的 `n3`）。
 * 收集层若只按裸 nodeId 归并，三份流程的同名节点会被合成一条明细：
 * 后写的覆盖标题与节点类型，只要有一份失败整条就显示失败 ——
 * 用户看到的就是「父流程那个节点变成了子流程的标题，还标着失败」。
 *
 * 所以节点级事件带上层级，收集层用 `nodeKeyOf(depth, nodeId)` 当键就不会撞。
 * **nodeId 本身的业务含义一个字都不改**（`outputs` / `{{变量}}` / `parentId` / 连边仍认它）。
 *
 * 顶层是 `0`，每下钻一层子工作流 `+1`。**不给时按 0 处理** ——
 * 老调用方（只读 `kind` / `nodeId`）读不到这个键也不会出任何错。
 */
interface NodeEventBase {
  /** 节点实例 id（业务身份，未含层级）。 */
  nodeId: string
  /** 这个节点住在第几层子工作流：顶层 `0`，每下钻一层 `+1`。不给按 `0`。 */
  depth?: number
}

/** 调度过程中发出的一个事件。 */
export type RunEvent =
  | ({ kind: 'queued' } & NodeEventBase)
  /** `nodeLabel` = 实例备注名（有才带；运行历史用它当标题）。 */
  | ({ kind: 'started', label: string, executor: string, nodeLabel?: string, defId?: string } & NodeEventBase)
  | ({ kind: 'log', line: string } & NodeEventBase)
  /**
   * `output` 给下游用；调用方通常不需要它（调度器自己收着）。
   *
   * `llm` = 这个节点调模型留下的痕迹（只有 `ai.agent` 这类真的调了模型的节点才有）。
   * **没调模型就不写这个键** —— 不写 `undefined`、不写空对象，
   * 与 `depth` / `truncated` 同一条纪律（见 `workflow-runs.ts` 的 `RunNodeLine.llm`）。
   */
  | ({ kind: 'success', output: unknown, llm?: LlmTrace } & NodeEventBase)
  | ({ kind: 'skipped' } & NodeEventBase)
  /**
   * 中断之后**没轮到、这次也不会跑**的节点（2026-10-23，契约 AB）。
   *
   * ## 它说的不是三件事里的那两件
   *
   * - **不是用户点停止**：那条路由画布自己把 `running` / `queued` 复位，
   *   引擎这边连事件都不发（`signal.aborted` 只让 `runSeq` 安静地 break）；
   * - **不是跳过**：`skipped` 是「按配置主动跳过」或「这条分支这次没走」，
   *   都是正常行为；这里是**前面有人失败、整条按「停止流程」中断了**。
   *
   * ## 为什么必须有它
   *
   * `runGraph` 一开跑就把主序里每个节点发成 `queued`（界面要一眼看出这次要跑哪些）。
   * 某个节点失败 + `onError: stop` 时，只发了一条 `aborted` 就抛出去了 ——
   * 那些还在 `queued` 的节点**没有任何人改动**，收集层（`mergeNodeEvent`）
   * 只在收到事件时改状态，于是它们永远停在「排队中」。
   * 用户看到的就是「报错了，但是后续还在执行」（实际没执行）。
   *
   * 发出它的是 `runGraph` 的收尾（见那次 `aborted === true` 的分支），
   * **只对 `order` 里没进过 `ran` 的节点发**：跑过的节点不许被改写成没跑。
   */
  | ({ kind: 'cancelled' } & NodeEventBase)
  /**
   * 节点在跑的过程中**主动报的一件事**（契约 AM，2026-10-25）。
   *
   * ## 为什么用事件而不是塞进 `output`
   *
   * 汇报**不参与数据流**（纪律 1）：进 `outputs` 的话下游 `{{变量}}` 会取到它，
   * 用户写 `{{input}}` 就会拿到一句人话而不是数据。所以走独立通道，
   * 收集层（`mergeNodeEvent`）把它挂到节点明细的 `reports` 上。
   *
   * ## 与 `log` 的区别（别混成一个）
   *
   * | | `log` | `report`（本条） |
   * | --- | --- | --- |
   * | 谁写的 | 调度器与节点混着写 | **只有节点自己写**（`ctx.report()`） |
   * | 形状 | 一行字符串 | 结构化（级别 / 条数 / 文件路径 / 折叠键） |
   * | 给谁看 | 排查过程 | 任务记录（「这次交出了什么」） |
   *
   * 一条 `report` **不是**一条日志：它不参与 `MAX_NODE_LOGS` 的截断
   * （那个上限是给日志行定的）。 */
  | ({ kind: 'report', entry: ReportEntry } & NodeEventBase)
  /**
   * 模型正在吐字时**一片字**（票 14，2026-10-27）。
   *
   * ## 为什么需要这一种
   *
   * 在此之前，一个要模型说 30 秒的节点在界面上就是**卡住 30 秒**：
   * 字是一片片到了宿主半（`index.ts` 的 `llm.stream` 循环），
   * 但那里只往字符串里累，**一个字都不往外发**，用户只能等整段说完。
   *
   * ## `text` 是**增量**，不是累计全文
   *
   * 界面的 `appendStream` 现成实现就是 `s + chunk`。发累计全文的话，
   * 每一片都会把前面的字再追加一遍 —— 屏幕上看到的是「一遍一遍长出来的乱码」，
   * 而且拼 100 片就是 100 倍长度。
   *
   * ## 它**不进运行记录**（硬约束）
   *
   * 运行记录是给人回看的历史，一条记录里有几百个节点；
   * 把每片字写进去，文件会涨到几十兆，而且那些字最终就是 `success.output`，
   * 存两遍没有意义。收集层（`node-events.ts` 的 `mergeNodeEvent`）**故意不认这一种**
   * —— 不认就是丢掉，不需要额外写一行过滤。
   *
   * ## 与 `log` 的区别
   *
   * `log` 是一行**说明**（「派发给谁」「变量没找到」），是给人排查用的；
   * 这一种是**产出正在形成的那个过程本身**，只给界面实时显示用。
   */
  | ({ kind: 'stream', text: string } & NodeEventBase)
  /**
   * 节点失败。
   *
   * `llm` = 这个节点调模型留下的痕迹。**只有「派发结果失败」才有痕迹可带**
   * （模型报错 / 被截断 / 被中断 —— 那正是最需要看痕迹的两种结局）；
   * 参数没填、找不到节点、嵌套太深这类**结构错误根本没派发**，不许硬塞一个空痕迹。
   */
  | ({ kind: 'failed', error: string, llm?: LlmTrace } & NodeEventBase)
  /** 一个节点失败且策略是 stop：整条中断。 */
  | ({ kind: 'aborted' } & NodeEventBase)

/**
 * 把「层级 + 节点 id」拼成一个稳定的键（给运行记录的收集层当归并键）。
 *
 * ## 为什么是纯函数、为什么放这里
 *
 * 它是 `RunEvent.depth` 的**配套约定**：只导出字段而不给拼键规则的话，
 * 每个收集方都会自己写一遍 `depth + ':' + nodeId`，迟早有一处写成 `nodeId + depth`
 * 或漏掉缺省值。放在事件定义旁边，谁读事件谁就能拿到同一个键。
 *
 * 顶层**不带前缀**（`nodeKeyOf(0, 'n3')` 与 `nodeKeyOf(undefined, 'n3')` 都返回 `'n3'`）——
 * 这样老的运行记录、老调用方的键与现在**逐字相同**，不需要迁移。
 *
 * @param depth - 节点所在的子工作流层级（顶层 0；缺省或非法按 0）。
 * @param nodeId - 节点实例 id。
 * @returns 可以当 Map 键的字符串。
 */
export function nodeKeyOf(depth: number | undefined, nodeId: string): string {
  const d = typeof depth === 'number' && Number.isFinite(depth) && depth > 0 ? Math.floor(depth) : 0
  return d === 0 ? nodeId : String(d) + '/' + nodeId
}

/** 一次派发的结果（与 dispatch-client 的 RunOutcome 同形，但不依赖它）。 */
export interface RunOutcome {
  /** 是否成功。 */
  ok: boolean
  /** 节点结局。 */
  status?: 'success' | 'failed' | 'cancelled'
  /** 输出（给下游）。 */
  output?: unknown
  /** 日志行。 */
  logs?: string[]
  /** 失败原因。 */
  error?: string
  /**
   * 这次派发调模型留下的痕迹（`DispatchResult.llm` 原样传上来）。
   *
   * 只有 `ai.agent` 这类真的调了模型的执行方才会有；其余执行方**不写这个键**。
   * 它最后由 `success` 事件带到收集层，再落进运行记录的节点明细。
   */
  llm?: LlmTrace
  /**
   * 这次派发过程中节点**主动报的事**（`ctx.report()` 推上来的，按到达顺序）。
   *
   * ## 为什么走返回值而不是回调
   *
   * 回调要跨进程（画布 → 宿主半那条 HTTP 路），而派发请求/响应本来就要跑一趟 ——
   * 塞在返回值里不需要再加一条通道。而且**失败也要能汇报**（纪律 3）：
   * 失败时这条数组照样带回来，正是不该丢的那条。
   *
   * ⚠️ 没报就**不写这个键**（不写 `[]`）—— 与 `llm` 同一条纪律。
   */
  reports?: ReportEntry[]
}

/** 调度器需要的「派发一个节点」的能力（由调用方注入）。 */
export type DispatchFn = (req: {
  runId: string
  nodeId: string
  executor: string
  command: unknown
  context: { workflowId: string, upstream: unknown[], workdir: string, env?: Record<string, string> }
  /**
   * 本节点的超时（毫秒）—— 来自 `NodeDef.timeoutMs`（契约 BD）。
   *
   * ## 为什么由调度层递，而不是派发层自己查
   *
   * 派发层只拿到命令体，看不到节点定义（那是引擎的地盘：`byId` / `spec.def`）。
   * 它早就有 `DispatchRequest.timeoutMs`（契约 AV 那一半），但**没有任何人给它值** ——
   * 于是那个能力全仓没有一处用得上，每个节点都卡在全局 300 秒。
   *
   * ⚠️ **不给就不写这个键**：派发器那边 `undefined` 走全局兜底，
   * 与改动前一个字节不变（`dispatcher.ts:297-298`）。
   */
  timeoutMs?: number
}, signal?: AbortSignal) => Promise<RunOutcome>

/**
 * 「运行挂起了」——由调度器**抛出**（不是事件）。
 *
 * ## 为什么用异常而不是返回一个 `paused: true`
 *
 * 挂起发生在**任意深度**：可能在顶层节点、也可能在循环体的第 3 轮里。
 * 返回值的路要逐层往上传（`runSeq` → `runLoop` → `runSeq` → `runGraph`），
 * 每一层都要判一次「是不是挂起了」，任何一层漏判就会**继续往下跑** ——
 * 那正是「暂停没停住」这种最难查的坏行为。
 *
 * 异常天然穿透所有层，且 `runSeq` 的 catch 会**先认它**（见那里第一行），
 * 所以不会被当成「节点失败」按 `onError` 处理（那会把它记成失败，用户看到红叉）。
 *
 * 与 Dify 的 `PauseRequested` / n8n 的 `NodeExecuteFunctions` 里那类「抛出即停」
 * 是同一个思路。
 */
export class RunPausedError extends Error {
  /** 现场（已经算好、等着落盘的那一份）。 */
  readonly snapshot: RunSnapshot
  constructor(snapshot: RunSnapshot) {
    super('运行挂起，等条件满足后继续')
    this.name = 'RunPausedError'
    this.snapshot = snapshot
  }
}

/**
 * 「Windows 通知与等待」节点的输出包装：上游原样 + `__alert`。
 *
 * ## 为什么不平铺
 *
 * 提醒结果（`notified` / `level` / `reason`）与上游业务字段**平铺在一起**时，
 * 下游 `{{字段}}` 分不清哪个是数据、哪个是提醒结果；上游若正好也有个叫 `notified`
 * 的字段，就会被悄悄盖掉。挂在 `__alert` 底下之后两件事分得清：
 * 取业务数据照旧，取提醒结果写 `{{__alert.notified}}`。
 *
 * `__` 前缀与 `__handle` / `__model` 同一族记号：**这是运行期信息，不是用户数据**。
 *
 * @param upstream - 上游输出（按连线顺序）。
 * @param alert - 这次通知的结果。
 * @returns 要写进输出表的值。
 */
function alertWrap(upstream: readonly unknown[], alert: unknown): unknown {
  const through = passthroughOf(upstream)
  const a = alert === null || typeof alert !== 'object' ? {} : alert
  /* 上游是对象（非数组）就铺开——与 `flow.if` 同一条规矩：下游直接用 `{{字段}}` 取，
   * 与这个节点不存在时一模一样。其余类型包进 `value`，不丢信息。 */
  if (through !== null && typeof through === 'object' && !Array.isArray(through)) {
    return { ...(through as Record<string, unknown>), __alert: a }
  }
  return { ...through === undefined ? {} : { value: through }, __alert: a }
}

/** 一次运行的输出。 */
export interface RunGraphResult {
  /**
   * 跑过的节点（**去重**，保持首次出现顺序）。
   *
   * 为什么去重：循环体的节点会执行 N 次，而 `ran` 的语义是「这次跑过哪些节点」。
   * 含重复会让调用方（工作流列表显示「已跑 N 个节点」）数字虚高。
   * 想看总执行次数用 `executions`。
   */
  ran: string[]
  /** 实际派发次数（循环时大于 `ran.length`）。 */
  executions: number
  /** 每个节点的输出（供调用方回看）。循环节点里是汇总结果。 */
  outputs: Map<string, unknown>
  /** 是否因失败策略中断。 */
  aborted: boolean
  /**
   * 本次运行**实际生效的输入**（开始节点声明 + 外部给值合并后的结果）。
   *
   * 为什么交给调用方：前端要在跑完之后显示「这次用了什么输入」，
   * 而运行记录里也该留一份（否则事后只看得到日志，看不出当时喂了什么）。
   */
  inputs: Record<string, unknown>
  /**
   * 结束节点声明的产出（名字 → 值）。
   *
   * 没有结束节点时是**空对象**，不是 undefined —— 调用方不用再判空。
   */
  declaredOutputs: Record<string, unknown>
  /**
   * 这次运行**挂起了**（在等 `flow.wait` 的条件）。
   *
   * ## 为什么挂起不算失败
   *
   * 用户明确要求：运行历史里标「**等待中**」，不是「失败」。
   * 挂起时 `ok` 仍是 `true`、`aborted` 仍是 `false` —— 它既没跑完也没出错，
   * 只能靠这个字段区分。调用方据此：
   *   · 写运行记录时标等待中（不是失败）；
   *   · 不发「失败」通知；
   *   · 把现场落盘（`pause-store.ts`），等条件满足再恢复。
   *
   * 不挂起时**没有这个键** —— 老调用方读不到它，行为一字不变。
   */
  paused?: RunSnapshot
  /**
   * **第一个**失败节点导致中断时的失败原因（契约 AH）。
   *
   * ## 为什么要有它
   *
   * 节点失败 + `onError: stop` 时，之前只回 `aborted: true`，不回「为什么」。
   * 于是下游（`run-file.ts` → 宿主半 → 板块记录 `collect/`）只拿得到一个布尔值：
   * 磁盘上 4 条失败记录的字段里**一条都没有 `error`**，用户只看到「没跑成」，
   * 不知道是哪一步、什么原因。节点级的原因在运行记录里另有（`RunNodeLine.error`），
   * 但**板块记录只记整次运行、不记节点** —— 缺的正是这一层。
   *
   * ## 为什么是「第一个」而不是「最后一个」
   *
   * 只有 `stop` 策略才会让它有值，而 `stop` 的意思是**整条当场停** ——
   * 第一个失败的节点就是把它停下来的那个，后面根本不会再有别的失败。
   * 用「最后一个」在这个语义下等价，但一旦将来允许 `stop` 之后继续收集
   * （比如并行路里各自失败），第一个才是「最初的原因」，后面那些往往是它的后果。
   *
   * ## 与 `paused` / `depth` / `llm` 同一条纪律
   *
   * 没失败、挂起、正常跑完时**不写这个键**（不写 `undefined`、不写空串）。
   */
  error?: string
}

/** 递归执行时的现场（循环每轮一份）。 */
interface RunScope {
  /**
   * 本轮（或本层）内各节点的输出。
   *
   * 循环体**每轮重建一份**：否则第 2 轮会读到第 1 轮的值，上游语义就错了。
   */
  local?: Map<string, unknown>
  /** 本层（循环体）包含哪些节点 —— 用来判断「边的起点算不算同一层」。 */
  bodyIds?: ReadonlySet<string>
  /**
   * 本层的**入口节点**（循环体里没有体内上游的那些）。
   *
   * 它们天生没有活入边（迭代变量由循环注入，不是靠连线），所以可达性判定
   * 必须把它们排除在外 —— 否则每轮都会被误判成「未走的分支」而不执行。
   */
  heads?: ReadonlySet<string>
  /**
   * 循环注入的迭代变量（内部节点用 `{{item}}` / `{{index}}` 取）。
   *
   * ⚠️ **这一份只属于这一层**（2026-10-19 嵌套之后）。要取「外层那一份」走 `parent` 链，
   * 拼变量表的是 `loopVarFields`（`loop.ts`，纯函数可单测）：
   * `{{item}}` = 最内层、`{{outer.item}}` = 往外一层。
   * **不要**在这里把外层变量合并进来 —— 那会让内层的 `{{item}}` 被外层顶掉。
   */
  loopVars?: Record<string, unknown>
  /**
   * **外面那一层**的现场（顶层没有）。
   *
   * 为什么是链式而不是「把外层的字段复制一份」：复制会丢掉「第 3 层要读第 1 层」这条路，
   * 而沿 `parent` 往上走，`outer.outer` 天然成立（见 `loopVarFields`）。
   *
   * 它同时扛两件事（都是嵌套循环的核心）：
   *   1. **变量作用域** —— `loopVarFields(ctx)` 沿链逐层拼出 `outer`；
   *   2. **数据读取** —— `scopedOutputOf` 沿链找「起点属于哪一层」，只读那一层**本轮**。
   *
   * ⚠️ 同一个 `parent` 引用会被**同一层的每一轮**共享（外层每轮建一份新的）。
   * 轮与轮之间不串味靠的是 `local`（每轮一份），不是靠 `parent` —— 见 `scopedOutputOf`。
   */
  parent?: RunScope
  /**
   * **本轮的**「判定为不可达」名单。
   *
   * ⚠️ **必须每轮一份**（2026-10-17 改）。顶层用全局的 `unreachable`；
   * 循环体内的每一轮各自一份，理由见上面 `edgeAlive` 旁那段注释
   * （并发时两轮共用一份会互相污染）。
   */
  unreachable?: Set<string>
  /**
   * 本轮失败了几个节点（2026-10-19 加，循环级「连续失败跳出」用）。
   *
   * 为什么必须要它：节点失败后若策略是 `continue`，`runSeq` 会**吞掉**那个错
   * 继续往下走 —— 循环那边只知道「这一轮跑完了」，不知道「这一轮里有节点失败了」。
   * 所以由 `runSeq` 的 catch 在这里**记一笔**，循环每轮结束后读它判「连续失败」。
   *
   * ⚠️ **每轮一份新的**（与 `local` / `unreachable` 同一个纪律）：
   * 共用一份的话，第 1 轮的失败会被第 2 轮读到 —— 表现是「明明这轮成功了还被跳」。
   */
  failures?: { count: number }
}

/**
 * 跑一张图。
 *
 * @param input - 图与目标。
 * @param dispatch - 派发一个节点的能力（画布传 HTTP 版，宿主半传本地版）。
 * @param options.onEvent - 事件回调（画布用它画状态与日志）。
 * @param options.signal - 中断信号（用户点「停止」）。
 * @param options.workflowId - 工作流标识（写进派发上下文与运行记录）。
 * @returns 跑过哪些、各自输出、有没有中断。
 */
export async function runGraph(
  input: RunGraphInput,
  dispatch: DispatchFn,
  options: {
    onEvent?: (e: RunEvent) => void
    signal?: AbortSignal
    workflowId?: string
    /** 已嵌套几层子工作流（外部一般不用传）。 */
    depth?: number
    /**
     * 这次运行的 id（**挂起现场的文件名就用它**）。
     *
     * 为什么不在这里自己造：运行 id 由入口（`src/index.ts` 的 `runCollector`）
     * 先定好、写进运行历史，挂起现场必须与那条记录**同一个 id** ——
     * 各造一个的话「等待中的那条」与「磁盘上的现场」对不上，恢复时找不到。
     *
     * 不给就现造一个（画布单跑之类，那种情况本来也不恢复）。
     */
    runId?: string
    /** 这次运行的开始时刻（毫秒）。不给就用当前时间。 */
    startedAt?: number
  } = {},
): Promise<RunGraphResult> {
  /* ── 事件出口：在这里补层级，所有 `emit(...)` 调用点一个字都不用改 ──────────
   *
   * ## 为什么写成「已有就不覆盖」（这是**防御性**的，不是当前必需的）
   *
   * `run-file.ts:213` 把**父层的 `onEvent` 原函数**直接交给子流程（`onEvent: opts.onEvent`
   * 配 `depth: depth + 1`），所以子流程的事件**不经过父层的这道包装** ——
   * 它自己那层 `runGraph` 补好自己的 depth 就交给调用方，父层再也碰不到它。
   *
   * 也就是说：现在把这里改成无条件覆盖 `{ ...e, depth }`，**不会**把子流程的层级抹掉，
   * 因为不会有事件穿两道包装。这一点是**实测过的**（2026-10-23 按任务书改成无条件覆盖，
   * `sub-workflow` 仍然全绿）。
   *
   * ## ⚠️ 所以这里**没有测试保护**，别以为有
   *
   * `tests/sub-workflow.mjs` 的 ⑧ 段只钉住「depth 有没有接上」（父 0 / 子 1 / 键不相等），
   * 它**抓不到「无条件覆盖」这种退化** —— 上面那次实测就是证据：改了写法，测试照样绿。
   *
   * 保留这个写法的理由只有一个：将来若新增了「把事件层层转发」的路径（例如某个入口
   * 为了过滤而包一层再转发），无条件覆盖就会开始抹层级。那时这个写法能兜住，
   * 而当时代码里**不会**有测试告诉你它兜住了 —— 读到这里的人自己去补一条。
   *
   * `aborted` 也带上层级：它同样是「某个节点出了事」的事件，
   * 不带的话收集层分不清是哪一层中断的。 */
  const rawEmit = options.onEvent ?? ((): void => { /* 没人听 */ })
  const curDepth = options.depth ?? 0
  /**
   * 发过 `started` 的节点（判「这个节点真的开始跑过」）。
   *
   * ⚠️ 在 `emit` 里顺手记，而**不是**在七处发 `started` 的地方各写一遍：
   * 那七处（普通节点 / 循环 / 并行 / 子工作流 / 等待 / 开始 / 结束）将来还会加，
   * 每加一处忘一次就是「中断后把正在跑的节点标成没跑」。写在一处，加节点不用管。
   */
  const startedIds = new Set<string>()
  /**
   * 已经拿到**终局**的节点（成功 / 失败 / 跳过 / 已取消）。
   *
   * 为什么补发 `cancelled` 时也要看这一份：**跳过**的节点不进 `ran`
   * （`runNode` 判完可达性就 return），但它已经有过一个明确的结局 `skipped`。
   * 若只按 `ran` 判，中断时会把「按配置跳过」改写成「因为中断没跑」——
   * 两件事实不同（`RunHistoryPanel` 那三个「没跑成」就是分开说的），
   * 而真实存档里确实有这种节点（`全部下载` 的子层 `n3` 就是 skipped）。
   */
  const settledIds = new Set<string>()
  const emit = (e: RunEvent): void => {
    if (e.kind === 'started') startedIds.add(e.nodeId)
    else if (e.kind === 'success' || e.kind === 'failed' || e.kind === 'skipped' || e.kind === 'cancelled') {
      settledIds.add(e.nodeId)
    }
    rawEmit(e.depth === undefined ? { ...e, depth: curDepth } : e)
  }

  /* ── 「这次给谁发过排队」的台账（2026-10-23，契约 AB）────────────────────
   *
   * ## 为什么要单独记一份
   *
   * 中断之后要补发 `cancelled`，得知道「这次到底给谁发过 `queued`」。
   * **光看 `order` 不够**：循环体与并行体的成员不在主序里，它们的排队是在
   * 每轮 / 每一路开始时单独发的（`runRound` 与 `runParallel` 各一处）。
   * 只扫 `order` 的话，循环体里那些「排着队、这一轮没轮到就中断了」的节点
   * 仍然停在「排队中」—— 正是用户报的那个现象，只是换了一层。
   *
   * ## 为什么是「列表 + Set」两件
   *
   * 列表保**首次出现顺序**（补发顺序稳定，同一次运行两次跑出来一样，便于对照日志）；
   * Set 只管判重（循环每轮会重复发同一批排队事件，不去重会让台账无限长）。
   *
   * ⚠️ 三个发 `queued` 的地方（主序 / 循环每轮 / 并行每一路）**都必须走 `noteQueued`** ——
   * 漏一处，那一处的节点在中断后就收不到 `cancelled`。
   */
  const queuedIds: string[] = []
  const queuedSet = new Set<string>()

  /**
   * 记一次「这个节点被标成排队中」。
   *
   * @param id - 节点实例 id。
   */
  const noteQueued = (id: string): void => {
    if (queuedSet.has(id)) return
    queuedSet.add(id)
    queuedIds.push(id)
  }

  const signal = options.signal
  const workflowId = options.workflowId ?? ''
  const workdir = input.workdir ?? ''
  const depth = curDepth

  const all = input.nodes
  const byId = new Map(all.map(n => [n.id, n]))
  const edges = input.edges

  /* ── 开始 / 结束节点（用户 m00901 定案：输入=开始节点、输出=结束节点）──────
   *
   * ## 为什么要在这里先算一次
   *
   * 开始节点声明的字段，**这次运行全程都要可见**（每个节点都能写 `{{日期}}`）——
   * 所以它在跑任何节点之前解析一次，之后当作常量用。
   *
   * ## 三条纪律（都是用户定的，见节点定义的文件头）
   *
   *  1. **最多一个**：两个开始节点是配置错误，**明确报错**而不是随便挑一个
   *     （挑一个的话用户永远不知道另一个没生效）。
   *  2. **没有开始节点 ≠ 把参数发给第一个节点** —— 用户明确不接受这种兜底。
   *     没有开始节点就是「这份工作流没法接外部输入」：照常跑，只是外部给的值
   *     一个都进不来（`{{日期}}` 会原样保留 + 一条警告）。
   *  3. 结束节点的产出在跑完之后取（它要读别的节点的输出，现在还没跑）。 */
  const startNodes = all.filter(n => n.def.id === START_DEF_ID)
  const endNodes = all.filter(n => n.def.id === END_DEF_ID)
  if (startNodes.length > 1) {
    /* 与「循环里不能套循环」同一类**配置错误**：说清是哪几个，别让用户猜。 */
    throw new Error('这份工作流里有 ' + String(startNodes.length)
      + ' 个「开始」节点（只能有一个）：' + startNodes.map(n => n.id).join('、'))
  }
  const declaredInputs = startNodes.length === 1 ? parseInputFields(startNodes[0]?.params.fields) : []
  /* ★ **恢复时用现场里的输入**（见 `RunGraphInput.resume`）：
   * 这次运行当时收到的值就是那批 —— 重新解析一遍 `input.inputs` 会拿到
   * 恢复入口「这次没给」的空表，于是 `{{日期}}` 之类全变空（静默的坏值）。 */
  const resume = input.resume
  /* ── 保留键的口子（2026-10-23，本次唯一的引擎语义改动）───────────────────
   *
   * ## 为什么要有这个口子
   *
   * `resolveInputs` 的纪律是「**只认开始节点声明过的字段，外部多给的一律丢掉**」
   * （用户 m00901 定的：接什么由开始节点说了算）。这条纪律对**用户输入**是对的。
   *
   * 但「用哪个模型」不是用户输入 —— 它是**运行上下文里的一项传递**：
   * 父流程开始节点选了模型，子流程自己没选时应当沿用（计划 §2.6）。
   * 如果照样被 `resolveInputs` 丢掉，那条链路就断了：子流程会走回落链，
   * 用户看到的症状是「父流程明明选了模型，子流程却用了默认」。
   *
   * ## 口子只对 `__` 开头的键开
   *
   * `reservedKeysOf` 只挑 `__` 前缀的键（判据见 `variables.ts` 的
   * `RESERVED_KEY_PREFIX`），普通键仍然一个都进不来 ——
   * 所以「外部多给的一律丢掉」这条纪律**没有被削弱**。
   *
   * ## 谁写进去、谁读出来
   *
   *   · 写：开始节点的 `model` 参数（见下面 `ownModel` 那几行）——
   *     它在跑任何节点之前算好，于是**每个节点**都看得见这份运行上下文；
   *   · 传：`runSubWorkflow` 把 `given` 交给子流程时它已在里面（不用改那里）；
   *   · 读：子流程的同一段代码（`reservedKeysOf(input.inputs)`）。 */
  const inheritedReserved = resume !== undefined ? {} : reservedKeysOf(input.inputs)
  const resolvedInputs: Record<string, unknown> = resume !== undefined
    ? { ...resume.inputs }
    : { ...resolveInputs(declaredInputs, input.inputs), ...inheritedReserved }
  /* ★ 本份工作流自己的开始节点选了模型 → **覆盖**从父流程继承来的那个。
   * 语义：越靠近当前这份工作流的设置越优先（与五级回落链的排列一致 ——
   * 节点上选的永远压倒默认）。留空（空串）不写键，让继承来的那个继续生效。 */
  const ownModel = startNodes.length === 1 ? String(startNodes[0]?.params.model ?? '').trim() : ''
  if (resume === undefined && ownModel !== '') resolvedInputs[MODEL_KEY] = ownModel
  const lackedInputs = missingRequired(declaredInputs, resolvedInputs)

  /**
   * 交给 `toCommand` 的运行上下文（**每次调用现算**，所以循环里也拿得到）。
   *
   * ## 为什么是函数而不是一个常量
   *
   * 它要读 `resolvedInputs`（可能被恢复流程改写），而 `runNode` 在循环体里会被反复调用；
   * 写成常量就会捕获一份快照，将来有人在中途改 `resolvedInputs` 时两边不一致。
   *
   * ## 只摘「该给节点的」，不把整张作用域交出去
   *
   * 见 `model.ts` 的 `CommandContext` 注释：最小授权 + `node.ts` 只许 `import type`。
   *
   * @returns 运行上下文（没选模型时是空对象，展开后不多一个键）。
   */
  const runCtxValues = (): RunContextValues => {
    const m = resolvedInputs[MODEL_KEY]
    return typeof m === 'string' && m.trim() !== '' ? { model: m } : {}
  }

  /* ① 顺序：拓扑序 + 环里的排最后（照旧实现）。 */
  const graph = topoSort(all.map(n => ({ id: n.id })), edges)
  /* ② 要跑哪些：整图 = 全部；否则 = 点名的（默认再带上它们的所有上游）。 */
  const includeUpstream = input.includeUpstream !== false
  const want = input.targets === undefined
    ? new Set(all.map(n => n.id))
    : new Set(input.targets.flatMap(id => includeUpstream ? [...withUpstream(id, edges)] : [id]))

  /* ③ 容器归属：哪些节点属于循环（由循环驱动，不进主序）。
   * 判定不用节点类型字样，而用「父节点是不是循环节点」——见 `containerMap`。
   * 循环体节点**不进主序**：它们由 `runLoop` 每轮驱动，不是按拓扑跑一遍。
   *
   * ★ **并行体同一条纪律**（2026-10-22）：父节点是并行节点的成员也不进主序，
   * 它们由 `runParallel` 按路驱动。判据与 `containerMap` 完全一样（只看 `parentId`
   * 指向的那个节点是不是并行节点）—— **不另造一套归属机制**（AGENTS.md「容器现状」）。 */
  const inLoop = containerMap(all.map(n => ({ id: n.id, defId: n.def.id, parentId: n.parentId })))
  const parallelIds = new Set(all.filter(n => n.def.id === PARALLEL_DEF_ID).map(n => n.id))
  const inParallel = new Set(all.filter(n => n.parentId !== undefined && parallelIds.has(n.parentId)).map(n => n.id))
  const loopOwned = new Set(inLoop.keys())
  const containerOwned = new Set([...loopOwned, ...inParallel])
  const mainOrder = graph.order.filter(id => want.has(id) && !containerOwned.has(id))
    .concat(graph.cycles.filter(id => want.has(id) && !containerOwned.has(id)))

  /* ── ★ 恢复：把要跑的顺序**裁到挂起点的下游**（见 `RunGraphInput.resume`）──
   *
   * ## 为什么在「排队事件」之前裁
   *
   * 排队事件是给界面看的「这次要跑哪些」。恢复时前半段已经跑过了，
   * 若照样把它们发成 queued，界面上会出现一排「排队中」却永远不动 —— 看着像卡住。
   *
   * ## 为什么是「从挂起点的下游」而不是「把挂起点删掉重排」
   *
   * 拓扑序里挂起点的下游**本来就是它之后那些**，所以「取挂起点之后」与
   * 「从下游开始」在**同一张图上等价**，而前者不必重算可达性
   * （`withUpstream` 那套是给「点名跑」用的，与恢复的语义不同）。
   *
   * ⚠️ **挂起点不在主序里**（它在循环体内）时**不裁**：循环体的恢复由
   * `runLoop` 自己处理不了，那种情形本版本明确不支持（见 `runWait` 里的报错）。
   * 这里只做「顶层挂起」这条真能走通的路径。 */
  const resumeFrom = resume === undefined ? -1 : mainOrder.indexOf(resume.resumeAfter)
  const resumeOrder = resumeFrom < 0 ? mainOrder : mainOrder.slice(resumeFrom + 1)

  /* ── ★ 「等人点继续」超时了 → **判为失败**，不再往下跑 ─────────────────
   *
   * ## 为什么在恢复入口判，而不是在挂起时定时
   *
   * 扫盘器只认一条：`resumeAtMs > now` 就跳过。设了超时的 `manual` 现场
   * `resumeAtMs` 就是超时时刻 —— 于是到点它会被自动捡起来恢复（见 `snapshot.ts`
   * 的 `manualTimeoutReason`）。到这一步才知道「人始终没来」，所以结论在这里下。
   *
   * ## 为什么是失败而不是静默继续
   *
   * 登录过期这类挂起，超时意味着人没处理过登录。这时往下跑，后面每一步都会因为
   * 没登录而失败，而错误看起来与本节点无关 —— 用户要去查一串莫名其妙的错。
   * 所以当场说清「等超时了」，按失败上报（`aborted` 为真，调用方据此写失败记录并提醒）。 */
  const manualPausedAt = resume === undefined ? '' : resume.resumeAfter
  const manualPausedSpec = manualPausedAt === '' ? undefined : byId.get(manualPausedAt)
  const manualIsAlertWait = manualPausedSpec !== undefined && manualPausedSpec.def.id === ALERT_WAIT_DEF_ID
  /* 两句超时原因**分开**（见 `snapshot.ts` 里 `alertTimeoutReason` 的对照表）：
   * 老节点说「这次运行按失败结束」，新节点说「人没有处理」—— 后者之后还会往下跑，
   * 沿用前者那句话就是假话。 */
  const manualExpired = resume === undefined
    ? null
    : (manualIsAlertWait ? alertTimeoutReason(resume.wait, Date.now()) : manualTimeoutReason(resume.wait, Date.now()))
  /* ── 超时之后怎么走：交给**这个节点自己的失败策略**（票 07，用户 2026-10-27 定甲）──
   *
   * ## 改了什么
   *
   * 原来这里是一刀切：`order = []`，后面的节点一个都不跑，整次运行按失败结束。
   * 后果是「等人超时」**没有出口可走** —— 用户在节点上选了「走失败分支」，
   * 红出口连上的下游永远不会活，因为整条已经被清空了。
   *
   * 现在按节点自己的 `onError` 分三种：
   *   · `stop`              → 仍然清空后续、整次中断（与改动前一致）；
   *   · `continue`          → 输出留空、后续照跑、不算中断；
   *   · `continueErrorOutput` → 输出带 `__handle: '__error'`，只有失败出口活、后续照跑。
   *
   * ## 只对 `flow.alert-wait` 生效，`flow.wait` 一个字不动
   *
   * ⚠️ **这是有意的，不是漏了**：
   *   ① 票里写明「不许碰 `flow.wait` 三种模式的既有语义」；
   *   ② `flow.wait` 默认 `onError: 'continue'` —— 若也切到局部策略，它超时之后会
   *      **继续往下跑**，而 `snapshot.ts` 的 `manualTimeoutReason` 注释早就写清了这有多坏：
   *      「登录过期这类挂起，超时意味着人始终没来处理。这时继续往下跑，后面每一步都会
   *      因为没登录而失败，而错误看起来与本节点无关」。三份真实存档用的正是 `flow.wait`。
   *
   * 所以判据看**节点定义 id**：只有新节点才走局部失败策略，老的挂起现场恢复行为一个字节不变。 */
  const manualPolicy: OnError = manualPausedSpec?.onError ?? 'stop'
  /** 超时被判成「这个节点失败、但整条继续」吗（只有新节点 + 非 stop 才成立）。 */
  let manualLocalContinue = false
  let order = resumeOrder
  if (manualExpired !== null) {
    emit({ kind: 'log', nodeId: manualPausedAt, line: '✕ ' + manualExpired })
    emit({ kind: 'failed', nodeId: manualPausedAt, error: manualExpired })
    /* ⚠️ 这里**不往 `failedEmitted` 记账**，两个原因：
     *   ① 那个集合声明在下面（在它之前用会撞「用在定义之前」）；
     *   ② 也**不需要** —— 恢复时 `order` 是从挂起点**之后**切片的，
     *      挂起点自己不会再被跑一遍，所以不可能出现重复的 `failed`。 */
    if (manualIsAlertWait && manualPolicy !== 'stop') {
      manualLocalContinue = true
      emit({
        kind: 'log', nodeId: manualPausedAt,
        line: manualPolicy === 'continueErrorOutput'
          ? '按「走失败分支」继续（下游只有失败出口那条路是活的）'
          : '按「继续」策略往下走（下游拿不到这个节点的值）',
      })
    } else {
      order = []
    }
  }

  /* 排队事件：先全部置为「排队中」，界面能一眼看出这次要跑哪些。
   * ⚠️ 循环体节点**不在主序里**，不在此发 queued —— 它们的排队由每轮驱动时发。 */
  for (const id of order) { noteQueued(id); emit({ kind: 'queued', nodeId: id }) }

  /* 输入已经解析好了 —— 把它与「缺了哪个必填项」都明说（不静默）。 */
  if (startNodes.length === 1) {
    const sid = startNodes[0]?.id ?? ''
    /* ⚠️ 日志里**只列普通键**：`__model` 是运行上下文，不是用户填的输入项，
     * 混进「输入：…」那一行会让人以为自己填过一个叫 `__model` 的字段。 */
    const visibleInputs = withoutReservedKeys(resolvedInputs)
    const names = Object.keys(visibleInputs)
    emit({
      kind: 'log', nodeId: sid,
      line: names.length === 0
        ? 'ⓘ 「开始」节点没有声明输入项 —— 这份工作流不接受外部输入'
        : 'ⓘ 输入：' + names.map(n => n + '=' + String(visibleInputs[n])).join('、'),
    })
    if (lackedInputs.length > 0) {
      /* 必填缺了**只在日志里说**，不拦 —— 有默认值的流程照样能跑，
       * 而缺的那一项在下游会表现为「变量没找到」（那条警告已经在了）。
       * 拦住的话「我只想跑一部分」这种调试就没法做了。 */
      emit({ kind: 'log', nodeId: sid, line: '⚠ 必填的输入没给：' + lackedInputs.join('、') })
    }
  } else if (startNodes.length === 0 && input.inputs !== undefined && Object.keys(input.inputs).length > 0) {
    /* 外部给了值、但这份工作流没有开始节点 —— **明确说清值被丢掉了**。
     * 这正是用户 m00901 要的语义：不是「换个地方接」，是「接不了」。 */
    emit({
      kind: 'log', nodeId: mainOrder[0] ?? '',
      line: '⚠ 外面给了 ' + Object.keys(withoutReservedKeys(input.inputs)).join('、') + ' 这些输入，但这份工作流没有「开始」节点，'
        + '所以一个都接不进来（不是发给了第一个节点）',
    })
  }



  /** 每个节点的输出（给下游用）。顶层一份；循环每轮另开一份 local。
   *
   * ★ **恢复时从现场灌回来**：没有这一步，恢复后第一个节点拿不到上游数据 ——
   * 症状是「恢复完下游全是空值」，而运行记录里看不出任何异常。 */
  const outputs = new Map<string, unknown>(
    resume === undefined ? [] : Object.entries(resume.outputs),
  )
  const ran: string[] = resume === undefined ? [] : [...resume.ran]
  const ranSet = new Set<string>(ran)
  let executions = resume === undefined ? 0 : resume.executions
  let aborted = false
  /* ── 超时之后把「这个节点的输出」写对（票 07）───────────────────────────
   *
   * 光把 `order` 留下来还不够：失败出口的下游能不能跑，判据在 `edgeAlive` ——
   * 它看的是**上游节点的输出里报的是哪个出口**。超时这条路上这个节点根本没被派发过，
   * 输出表里留着的是它挂起**前**写进去的那份（`__alert` 那个成功形状），
   * 于是 `liveHandles` 认为出口全活 → 正常出口那条照样跑、失败出口那条也跑。
   *
   * 所以这里按 `continueErrorOutput` 的同一个形状覆盖一份：
   * `{ [BRANCH_KEY]: ERROR_HANDLE, error }` —— 与 `runSeq` 的 catch 里写的那份一致，
   * 下游拿到的失败原因也就对得上了。
   *
   * ⚠️ 只有「局部继续 + 走失败分支」这一档才写。`continue` 那一档**留空**
   * （与 `runSeq` 里 `continue` 的既有语义一致：下游拿不到值）；`stop` 那一档
   * 后面根本不跑，写不写都一样。 */
  if (manualExpired !== null && manualLocalContinue) {
    if (manualPolicy === 'continueErrorOutput') {
      const handles = { [BRANCH_KEY]: ERROR_HANDLE, error: manualExpired }
      outputs.set(manualPausedAt, handles)
    } else {
      outputs.delete(manualPausedAt)
    }
  }
  /**
   * 第一个「按停止流程中断」的失败原因（契约 AH）。
   *
   * ## 为什么放在这个作用域
   *
   * `runSeq` 是**递归**的（循环体、并行每一路都走它），失败发生在**任意一层**。
   * 记在 `runSeq` 的局部变量里，抛出去就没了；放在 `runGraph` 这一层，
   * 所有层的 catch 都能改到同一个格子。
   *
   * ## 为什么只记第一个（`??=` 语义）
   *
   * 只有 `onError: stop` 那条路才会写它，而 `stop` 的意思是**整条当场停** ——
   * 写完之后不会再有第二次失败。将来若允许「中断但继续收集」，
   * 第一个才是最初的原因，后面那些多半是它的后果。
   *
   * 子工作流是另一次 `runGraph`，它自己那一层各记自己的 —— 那正是对的：
   * 父层看到的是「子工作流「xxx」失败：…」那句（`runSubWorkflow` 里拼的），
   * 而不是子流程里某个节点的原话。
   */
  let firstFailureError: string | undefined
  /**
   * 挂起的现场（跑到 `flow.wait` 时填，`RunPausedError` 带着它抛出去）。
   *
   * 为什么放这个作用域：`runWait` 要读「已经跑了哪些、每个节点输出什么」——
   * 那是 `runGraph` 的局部变量，`runWait` 是这里的闭包，天然看得到。
   */
  let pauseSnapshot: RunSnapshot | null = null

  /** 记一次「跑过这个节点」（去重，保持首次出现顺序）。 */
  const noteRan = (id: string): void => {
    if (ranSet.has(id)) return
    ranSet.add(id)
    ran.push(id)
  }

  /**
   * 因「未走的分支」而**判定不可达**的节点。
   *
   * 为什么需要单独记：判断一条边活不活，有两种「起点没输出」的情形，
   * 必须区分开（2026-10-12 被 ⑲ 的断言抓出来）：
   *   - **起点不可达**（本集合里）→ 那条路根本没走 → 边是死的
   *   - **起点只是还没轮到**（如环里的节点，拓扑序不确定）→ 边是活的，照常等它
   * 只看「有没有输出」分不清这两者，会把环里的节点误杀。
   *
   * ★ **恢复时从现场灌回来**：已经判过「未走」的节点，恢复后必须还是没走。
   * 不清空的话它们会被当成「还没轮到」而**开始跑** —— 静默地多做了一堆事，
   * 而且做的事（采集、写文件）往往有副作用。
   */
  const unreachable = new Set<string>(resume === undefined ? [] : resume.unreachable)

  /**
   * 已经发过 `failed` 事件的节点（避免同一件事说两次）。
   *
   * 为什么需要它（2026-10-13）：`runNode` 与 `runLoop` 的常见错误都**自己发** `failed`，
   * 而 `runSeq` 的 catch 也可能需要补发（循环里 `iterationItems` 抛的配置错误
   * 原先从没被说过）。没有这个集合的话，补发会让普通节点失败时出现两条 failed。
   */
  const failedEmitted = new Set<string>()


  /**
   * 取一个节点的上游输出。
   *
   * 来源按「边的起点属于**哪一层**」分流（2026-10-19 嵌套改法）：
   *   - 起点在本层 → **只读本轮的 `local`**，读不到就是没有
   *   - 起点在外层体里 → 读**外层那一轮**的 `local`
   *   - 起点在顶层 → 读全局 `outputs`
   *
   * ⚠️ **不能用「local 里有没有这个键」来判**（2026-10-12 被自己的测试抓出来的真 BUG）：
   * 若写成 `local?.has(src) ? local.get(src) : outputs.get(src)`，
   * 那么「本层起点、但本轮还没跑」会**回落到外层的 `outputs`** ——
   * 而体内节点每轮都会把结果写进 `outputs`，于是第 2 轮读到的是**第 1 轮的残留**。
   * 症状是「循环数据莫名串味」，极难查。现在按**边的起点属于哪一层**判，
   * 归属层永远只认那一层本轮 —— 判据落在 `scopedOutputOf` 里（可单测，见 `loop.ts`）。
   *
   * ⚠️ **嵌套后这是同一类问题深一层**：内层若把「外层体里的起点」当成「全局」，
   * 就会读到外层**上一轮**写进 `outputs` 的残留。所以判据必须沿 `parent` 链
   * 找到**最近的那一层**，而不是「本层 / 其它」二分。
   *
   * **分支可达性**（2026-10-12 Step 4）：起点报过「只走某个出口」时，
   * 接在别的出口上的边**不算上游**（那条分支根本没走）。
   * 起点**自身不可达**时同理 —— 那条路整体没走。
   * 于是「未走的分支下游」自然失去全部上游 → 被判不可达 → 不派发。
   *
   * ## 重复边只算一份（票 25，2026-10-27）
   *
   * 两条**完全一样**的连线（同一个起点、同一个出口、同一个终点）会让下游的
   * 上游数组从 `[{v:1}]` 变成 `[{v:1},{v:1}]` —— 同一份数据拿两遍。
   * `topo.ts` 的 `topoSort` 早就按 `source \u0000 target` 去重了（节点不会跑两遍），
   * 但这里原来没有，于是「跑得一、拿得两份」。
   *
   * 现在没有炸，只是因为节点都按 `input.字段` 取值、不按下标取。
   * **换成按下标取的节点就是静默错值** —— 不报错、值不对，最难查的那一类。
   *
   * ### 去重键为什么是「起点 + 出口」而不是只有起点
   *
   * 实测（2026-10-27 探针，两种情形分别跑真调度器）：
   *
   * | 情形 | 两条边能不能同时活 | 上游数组 |
   * | --- | --- | --- |
   * | `flow.if` 的 `true` / `false` 两口连到同一个下游 | **不能**（走 `true` 时 `false` 那条不活） | 1 份 |
   * | `code.shell` 的 `out` / `code` 两口连到同一个下游（它不报 `__handle`） | **能** | 2 份 |
   *
   * 所以「只有起点」这个键会**改变第二种情形的行为**（把 2 份合成 1 份）——
   * 那不是这次要修的「重复」，是两个不同出口。
   * 键取「起点 + 出口」，与 `tests/archive-edges.mjs` 判「存档里重复连线」的
   * 口径也一致（那里用的是 `source|sourceHandle|target|targetHandle` 四元组）。
   *
   * ⚠️ **终点端口（`targetHandle`）不进键**：我们的上游是一个**平铺数组**，
   * 今天没有「按输入端口分流」这回事（所有入边的值按连线顺序排进同一个数组）。
   * 同一个起点的同一个出口连到两个输入端口，两个端口拿到的是**同一个值**，
   * 留两份仍是这里要去的重复。13 份真实存档里目前一条这种边都没有。
   *
   * @param id - 目标节点 id。
   * @param ctx - 当前层现场（`local` 为空表示顶层）。
   * @returns 上游输出数组（按连线顺序，跳过没值的、跳过未走分支的、重复边只算一份）。
   */
  const upstreamOf = (id: string, ctx: RunScope): unknown[] => {
    /* 先去重再取值：`seen` 记的是「起点 + 出口」，与上面注释同一个键。
     * 只在**活着的入边**之间去重（死边本来就不该占位）。 */
    const seen = new Set<string>()
    const out: unknown[] = []
    for (const e of edges) {
      if (e.target !== id) continue
      if (!edgeAlive(e, ctx)) continue
      const key = e.source + '\u0000' + (e.sourceHandle ?? '')
      if (seen.has(key)) continue
      seen.add(key)
      const v = outOf(e.source, ctx)
      if (v !== undefined) out.push(v)
    }
    return out
  }

  /**
   * 这条入边这次算不算「活的」。
   *
   * 三种不活的情形：
   *   ① 起点节点不存在（脏数据）；
   *   ② 起点**本身不可达**（它在未走的那条分支上，整条路没走）；
   *   ③ 起点报了「只走某个出口」，而这条边接在**别的**出口上。
   *
   * @param e - 入边。
   * @param ctx - 当前层现场。
   * @returns 是否活的。
   */
  const edgeAlive = (e: TopoEdge, ctx: RunScope): boolean => {
    const src = byId.get(e.source)
    if (src === undefined) return false
    if (unreachable.has(e.source)) return false
    /* 「本轮没走」的名单要**沿 `parent` 链都看一遍**（2026-10-19 嵌套）。
     *
     * 原来看的是当前这一份。嵌套后外层那一轮记下的「某节点这次没走」住在
     * **外层**的 `unreachable` 里，内层只看自己那份会漏判 —— 于是内层会去读一个
     * 外层本轮根本没产出的节点，拿到「没有」而不是「那条路没走」。
     * 沿链都看一遍，与 `scopedOutputOf` 同一条纪律：归属哪一层就看哪一层。 */
    for (let s: RunScope | undefined = ctx; s !== undefined; s = s.parent) {
      if (s.unreachable !== undefined && s.unreachable.has(e.source)) return false
    }
    /* ── 声明了失败出口的节点：两个出口**都要判准**（契约 AI）──────────────
     *
     * `liveHandles` 的老规矩是「输出里没有 `__handle` 就返回 `null` = 全部出口都活」。
     * 那对**单出口**节点完全正确（存档里绝大多数边甚至连 `sourceHandle` 都不写）。
     * 但「走失败分支」的节点现在有**两个**出口，两个方向都会出事：
     *
     *   · **失败时**：只有 `__error` 活。而接在正常出口上的边**往往没写 handle**
     *     （真实存档 30 条边都不带 `sourceHandle`）—— 照老规矩「有活出口就算活」
     *     它会被判成活的，于是失败分支跑了、正常分支也照跑（正是要修的那个病）。
     *   · **成功时**：`__handle` 不存在 → `null` → 红出口那条边也被判活，
     *     于是接在失败出口上的下游在成功时也跑了（对称的另一种错）。
     *
     * 所以这一层把两个方向都收到「只有一个出口活」：
     *   · 有 `__handle` → 就用它（`liveHandles` 已认得 `__error`，因为
     *     `specs.ts` 的 `withErrorOutput` 把这个出口派生进了定义）；
     *   · 没有 `__handle`（= 成功）→ 活的是**除 `__error` 之外**那些出口。
     *
     * ⚠️ **为什么不在 `edgeIsLive` 里改**：它是纯函数，`tests/branch.mjs` 直接钉着
     * 「没写 handle 且有活出口 → 活」那条老语义（`['true']` 那种形状）。
     * 改它会连带影响条件判断的老存档 —— 那是另一件事，不该被这次改动拖着走。 */
    const raw = liveHandles(outOf(e.source, ctx), src.def)
    const declaresError = src.def.outputs.some(o => o.id === ERROR_HANDLE)
    const handles = raw !== null || !declaresError
      ? raw
      : src.def.outputs.filter(o => o.id !== ERROR_HANDLE).map(o => o.id)
    /* 「没写出口」的边指的是**正常出口**。失败时正常出口不活 → 这条边不活。
     * 不补这一句的话，`edgeIsLive(undefined, ['__error'])` 会返回 true
     * （它的老规矩是「有活出口就算活」），正常分支照样跑。 */
    if (e.sourceHandle === undefined && handles !== null && handles.length === 1 && handles[0] === ERROR_HANDLE) {
      return false
    }
    return edgeIsLive(e.sourceHandle, handles)
  }

  /**
   * 本层（循环体内）判定不可达的节点。
   *
   * 为什么每轮要重置：循环体里「这一轮没走」不代表「下一轮不走」——
   * 每轮的 item 不同，条件判断的结果可能相反。
   * 顶层用全局的 `unreachable`。
   *
   * ⚠️ **2026-10-17 改**：从「整层共用一份」改成**每轮一份**（住在 `ctx.unreachable`）。
   *
   * 为什么必须改：并发循环时两个轮次同时跑，如果共用一份记录，A 轮判定的
   * 「某节点这次没走」会**污染 B 轮**（B 轮明明在用它，却被判成没走）。
   * 每轮一份之后，两轮互不可见，串行行为**完全不变**（串行时只有一个轮次在用）。
   *
   * 放在 `ctx` 里而不是闭包变量里，就是为了让它跟着「轮次现场」走。
   */

  /**
   * 取一个节点的输出，**按它所属的最近那一层**取。分支判定与上游解析都要用。
   *
   * ## 2026-10-19 改（嵌套循环）：判据从「本层有没有这个键」改成「它属于哪一层」
   *
   * 原来是 `ctx.local?.has(id) ? ctx.local.get(id) : outputs.get(id)`。
   * 那个写法对内层循环有两处错：
   *   ① **内层体里的节点**若本轮还没跑，会回落读 `outputs` —— 那是它**上一轮**的残留；
   *   ② **外层体里的节点**在本层 `local` 里当然没有，于是也回落读 `outputs`
   *      —— 读到外层**上一轮**的残留。
   * 两处都是「循环数据串味」那一类（见 `upstreamOf` 上面的长注释）。
   *
   * 现在交给 `scopedOutputOf`：沿 `parent` 链找到**归属层**，只认那一层本轮。
   * 不属于任何一层（顶层节点）才读全局 `outputs`。
   *
   * ⚠️ 行为变化只有一处（**是修，不是改语义**）：本层体里的节点「本轮还没跑」时
   * 现在返回 `undefined`，不再回落到上一轮的值 —— 那条回落路径正是 ① 那个 bug。
   *
   * @param id - 节点 id。
   * @param ctx - 当前层现场。
   * @returns 输出；归属层本轮没产出它时是 `undefined`。
   */
  const outOf = (id: string, ctx: RunScope): unknown =>
    scopedOutputOf(id, ctx, outputs).value

  /**
   * 这个节点还有没有「活的」入边。
   *
   * 没有入边的节点**不一定不可达**：循环体的入口节点天生没有入边
   * （迭代变量由循环注入），所以调用方要把 `heads` 排除在外。
   *
   * @param id - 节点 id。
   * @param ctx - 当前层现场。
   * @returns 是否有至少一条活入边。
   */
  const hasLiveInput = (id: string, ctx: RunScope): boolean =>
    edges.some(e => e.target === id && edgeAlive(e, ctx))

  /** 这个节点**有没有**入边（不管活不活）。用来区分「流程起点」与「分支死角」。 */
  const hasAnyInput = (id: string): boolean => edges.some(e => e.target === id)

  /**
   * 条件判断节点（`flow.if`）这次的「左边取什么值」——**在派发前解析好**。
   *
   * ## 为什么必须由调度器解析，而不是节点实现自己去取
   *
   *   ① 只有调度器手上有「所有节点的输出」这张表（`outputs` 与本轮 `local`）；
   *   ② 循环变量住在 `ctx.loopVars` 里，节点实现只看得到 `upstream`；
   *   ③ 命令要能序列化成 JSON 过 HTTP（画布 → 宿主半），**带不了闭包**。
   *
   * 所以做法与循环的 `items: { nodeId, field }` 完全一样：
   * 参数里存的是「指向」（`{ kind, nodeId, field }`），调度器把它换成**值**再发出去。
   *
   * 返回的 `__judge` 挂进命令体（不是参数表），节点实现据此只做「比大小」——
   * 这样两半的职责很清楚：调度器管「取到什么」，节点实现管「怎么比」。
   *
   * @param id - 本节点 id。
   * @param spec - 本节点规格。
   * @param ctx - 当前层现场。
   * @returns 要走哪条路，以及（结构化条件时）解析好的条件。
   */
  const ifPlanOf = (id: string, spec: RunNodeSpec, ctx: RunScope): IfPlan =>
    planIf(spec.params, {
      outOf: (nodeId: string) => outOf(nodeId, ctx),
      /* 日志与界面里说「哪个节点」时用实例名（`n4` 认不出是谁）。 */
      labelOf: (nodeId: string) => {
        const s = byId.get(nodeId)
        if (s === undefined) return nodeId
        const shown = s.label !== undefined && s.label !== '' ? s.label : s.def.label
        return shown + '（' + nodeId + '）'
      },
      /* 条件判断的「输入」来源只给**普通键**：`__model` 属于运行上下文，
       * 不该成为可选、可比的输入项（与 `{{__model}}` 取不到同一条纪律）。 */
      inputs: withoutReservedKeys(resolvedInputs),
      /* ⚠️ 用 `loopVarFields(ctx)` 而不是 `ctx.loopVars`（2026-10-19）：
       * 前者沿 `parent` 链拼出 `{ item, index, outer: { item, index, … } }`，
       * 所以条件里能写 `outer.item.url`。只传 `ctx.loopVars` 的话，
       * 界面上给出了 `outer.item` 却取不到值 —— 那种「能选、跑起来是空」最难查。
       * 顶层时两者都返回 `{}`，行为不变。 */
      loopVars: loopVarFields(ctx),
    })

  /**
   * 跑一个节点。抛错表示这个节点失败（由调用处决定停还是继续）。
   *
   * @param id - 节点实例 id。
   * @param ctx - 当前层现场。
   */
  const runNode = async (id: string, ctx: RunScope): Promise<void> => {
    const spec = byId.get(id)
    if (spec === undefined) return

    /**
     * 用户点「停止」了吗（**包一层**，避开 TypeScript 的控制流窄化）。
     *
     * ⚠️ 为什么不能裸写 `signal?.aborted === true`（2026-10-19 由前端开发者抓到的
     * TS2367：`'false' 与 'true' 没有交集`）：
     * 重试循环里第一次判过之后，TS 就把 `signal.aborted` 窄化成「已经证明不为 true」；
     * 等到 `await` 之后再判第二次，它认为那个比较**永远不成立** → 编译报错。
     * 运行时语义其实完全正确（`await` 期间用户完全可能点了停止），
     * 只是类型检查器看不到那个变更。
     *
     * 包成函数后每次调用都是新的读取，窄化就不会跨过 `await` 传播。
     * 这与 `runLoop` 里的 `stopped()` 是**同一个写法**（那个是 2026-10-17 为同一个原因加的）。
     */
    const stopped = (): boolean => signal?.aborted === true

    /* 可达性（2026-10-12 Step 4）：这个节点的**全部入边**都来自「没走的分支」时，
     * 它就没有任何活上游 —— 判为不可达，**跳过且不派发**。
     *
     * 两个例外，都不能当成不可达：
     *   ① **循环体的入口节点**（`ctx.heads`）—— 它天生没有入边，迭代变量由循环注入；
     *   ② **完全没有入边的节点**（`inDegree === 0`）—— 那是流程起点，不是分支死角。
     * 判据用「有入边但全都不是活的」，而不是「没有活入边」——后者会把 ① ② 一起误杀。 */
    if (!hasLiveInput(id, ctx) && hasAnyInput(id) && ctx.heads?.has(id) !== true) {
      /* 记下来：它的下游据此判断「那条路没走」（见 edgeAlive 的说明）。 */
      if (ctx.local === undefined) unreachable.add(id)
      else ctx.unreachable?.add(id)
      emit({ kind: 'log', nodeId: id, line: '⏭ 未走的分支，跳过（上游那条路这次没走）' })
      emit({ kind: 'skipped', nodeId: id })
      return
    }

    noteRan(id)

    /* 跳过：**不执行，把上游输出原样传给下游**。
     * 为什么不等于「不跑」：那样下游拿不到数据、链会断。
     * 跳过是「透明地穿过去」，这才是它作为调试手段的价值。 */
    if (spec.skipped) {
      emit({ kind: 'log', nodeId: id, line: '⏭ 已跳过（不执行，上游数据原样传给下游）' })
      const through = passthroughOf(upstreamOf(id, ctx))
      if (through !== undefined) {
        outputs.set(id, through)
        ctx.local?.set(id, through)
      }
      emit({ kind: 'skipped', nodeId: id })
      return
    }

    emit({ kind: 'started', nodeId: id, label: spec.def.label, executor: spec.def.executor, defId: spec.def.id, ...spec.label === undefined ? {} : { nodeLabel: spec.label } })
    emit({ kind: 'log', nodeId: id, line: '【' + spec.def.label + '】派发给「' + spec.def.executor + '」执行方' })

    const upstream = upstreamOf(id, ctx)
    /* 迭代变量（item / index）经 scope.fields 注入，与上游字段**叠加**（见 command.ts 的说明）。
     *
     * ⚠️ **工作流的输入也在这里注入**（2026-10-17）：开始节点声明的字段
     * （`resolvedInputs`）对**每个**节点都可见，所以节点里直接写 `{{日期}}` 就能取到，
     * 不必先从开始节点拉一条线。这与「入边那是显式上游」并不冲突 ——
     * 两处都能取到值，谁也不会把谁挤掉（`buildCommand` 是叠加语义）。
     *
     * 没有开始节点时 `resolvedInputs` 是空对象 —— 于是 `{{日期}}` 原样保留 + 一条警告，
     * 正是用户 m00901 要的「没法接外部输入」的表现（不是静默给个 undefined）。
     *
     * ⚠️ **迭代变量走 `loopVarFields(ctx)`**（2026-10-19 嵌套）：它沿 `parent` 链
     * 拼出 `{ item, index, outer: { item, index, outer: … } }`。
     * 顶层 / 第一层时它返回的正是 `{ item, index }` —— 与改动前逐字一致，
     * 老存档里所有 `{{item}}` / `{{index}}` 的行为不变（硬判据）。 */
    const scope = {
      fields: { ...resolvedInputs, ...loopVarFields(ctx) },
      env: input.env,
    }
    const built = buildCommand(spec.def, spec.params, upstream, scope, runCtxValues())
    /* 变量没找到**不是静默失败**：原样保留 + 明说一条，用户最怕「什么都没发生」。 */
    for (const name of built.missing) {
      emit({ kind: 'log', nodeId: id, line: '⚠ 未找到变量 ' + name + '（原样保留，没替换）' })
    }

    /* ── 条件判断：把「左边取什么值」在这里解析好，塞进命令体（2026-10-19）──
     *
     * 用户的第二、三条要求靠这一步兑现：
     *   · 「判断完了后面的节点还得知道干嘛」→ 输出带上游原样（见 `branchFn`），
     *     这里只负责把「判什么」算准；
     *   · 「IF 前面的节点就是传入信息的，这个判断应该交给 IF」→ 左边可以直接选
     *     上游某节点的字段 / 循环变量 / 开始节点的输入，用户不必为了取一个值而多放一个节点。
     *
     * ⚠️ **不能解析的条件要在派发前就说清**：
     *   · 一条合法条件都没有、也没有旧表达式 → 直接报一句可读的错
     *     （不然 `branchFn` 收到空条件会「永远成立」，静默变成一条直通线）；
     *   · 走旧表达式时**明说**「上面的条件没生效」—— 两样都填了还静默二选一最难查。 */
    let judge: IfPlan | null = null
    if (spec.def.id === IF_DEF_ID) {
      judge = ifPlanOf(id, spec, ctx)
      if (judge.mode === 'none') {
        const msg = '条件判断没填任何条件（左边选一个值、再选怎么比）'
        emit({ kind: 'log', nodeId: id, line: '✕ ' + msg })
        emit({ kind: 'failed', nodeId: id, error: msg })
        failedEmitted.add(id)
        throw new Error(msg)
      }
      if (judge.mode === 'expr') {
        emit({
          kind: 'log', nodeId: id,
          line: 'ⓘ 用的是老写法（高级参数里的表达式）：' + judge.expr
            + (Array.isArray(spec.params.conditions) && spec.params.conditions.length > 0
              ? ' —— 上面的「条件」这次没生效，想用请把表达式清空' : ''),
        })
      } else {
        /* 日志里逐条说清「取到了什么」：空值时要能一眼看出是「没这个字段」
         * 还是「字段是空」—— 否则用户只能盯着「没走这条路」猜。 */
        for (const line of judge.describe) emit({ kind: 'log', nodeId: id, line: 'ⓘ ' + line })
        if (judge.dropped > 0) {
          emit({ kind: 'log', nodeId: id, line: '⚠ 有 ' + String(judge.dropped) + ' 条条件不完整（没选值），已忽略' })
        }
        emit({
          kind: 'log', nodeId: id,
          line: 'ⓘ 共 ' + String(judge.conds.length) + ' 条条件，按「'
            + (judge.logic === 'or' ? '满足任一' : '全部满足') + '」合成一个结果',
        })
      }
    }

    executions += 1
    /* ── 派发（失败时按 `retry` 重试，2026-10-19）────────────────────────
     *
     * 照源码 `downloadOne` 的做法：失败后等一会儿**整段重跑一次**。
     * 差别在于次数与间隔由用户定（`readRetry` 优先读实例参数、退回定义默认值）。
     *
     * ## 三条纪律
     *
     * 1. **重试期间不发 `failed`** —— 还没判死刑。只有**用尽**之后才发一条
     *    （发多次会让界面与运行记录里出现一串红叉，与「最终失败了 1 次」不符）。
     * 2. **每次重试都要有日志**：第几次、还剩几次、为什么、间隔多久。
     *    用户最怕「它自己悄悄重试了」——账单 / 重复提交这类后果要能事前看出来。
     * 3. **用尽后照原样抛错** —— 与没有重试时**完全一致**（`runSeq` 的 catch
     *    按 `onError` 决定 stop / continue）。所以 `continue + retry` 的叠加
     *    语义自然成立：先重试，还失败就往下走。
     *
     * ⚠️ 用户点「停止」时**不再重试**（`signal.aborted` 一检查就走）——
     * 否则点了停止还要再等几轮，是明显的坏体验。 */
    const retry = readRetry(spec.def, spec.params)
    /* ★ 本节点这次真正生效的超时（契约 BD + BE，2026-10-25）。
     *
     * ## 三层优先级，只在 `readTimeout` 里实现一次
     *
     * ```
     * 实例参数（params[def.timeoutParam]）   ← 用户当场填的，最高
     *   → def.timeoutMs                     ← 这类节点的物理上限
     *     → 不写这个键                       ← 派发器走它的全局兜底（300 秒）
     * ```
     *
     * ⚠️ **取参用的是 `spec.params`**（`toRunSpecs` 里已经按「实例值优先、缺的回落
     * 节点默认」合过的那一份）—— 不在这里再合一次，否则同一个值会有两处算法。
     *
     * ## 两件事一起解决
     *
     * · 契约 BD：派发器早就有 `DispatchRequest.timeoutMs`（契约 AV），但没人给它值，
     *   所以那个能力全仓一处都用不上；
     * · 契约 BE：「执行命令」节点上那个「超时上限」参数界面上写着能调，
     *   而 `commandOf` 的 shell 分支只拼 `argv` / `cwd`，一个字都没读它 ——
     *   用户在节点上填 20 分钟，实际还是 300 秒被杀。现在它真的生效了。 */
    const effTimeout = readTimeout(spec.def, spec.params)
    /* ── 「Windows 通知与等待」的 `mode: 'none'`：命令体换成**发通知**（票 07）──
     *
     * 它不挂起，所以走普通节点这条路。但派发出去的命令体不能是它自己的
     * （`flow.alert-wait` 在实现表里没有对应函数 —— 它由调度器解释）。
     * 这里换成 `flow.notify`：发通知那一半的实现是**唯一一份**，不在这里重写。
     *
     * ⚠️ 参数只传 `content` / `level` / `system` 三个 —— `mode` / `ms` / `until` /
     * `timeoutHours` 是「等什么」的事，与发通知无关，传过去只会让实现那边多几个没用到的键。
     *
     * ⚠️ 输出还要**再包一层**（上游原样 + `__alert`），见下面成功那一支。 */
    const alertOnly = spec.def.id === ALERT_WAIT_DEF_ID
    /* ★ 模型吐字的实时通道（票 14，2026-10-27）。
     *
     * ## 为什么塞进命令体，而不是给派发请求加一个字段
     *
     * 吐字发生在**宿主半**（`src/index.ts` 的 `llm.stream` 循环里），
     * 而 `emit` 在**引擎**（本文件）。两头要说话，中间隔着派发器、执行方、
     * 委派函数三层 —— 能把东西递过去的位置只有**命令体**：它是 `unknown`，
     * 一路原样传到委派函数手上，中间谁也不用改签名。
     * `__judge`（条件判断的现场）走的就是这条，同一个做法。
     *
     * ## 为什么只给 agent 执行方挂
     *
     * 只有它会调模型。给所有节点都挂一个空回调，等于每个节点的命令体里
     * 都多一个没人用的键 —— 而且 user 在界面上看到的命令体预览会变得奇怪。
     *
     * ## ⚠️ 这条通道**过不了 HTTP**
     *
     * 函数没法 JSON 序列化。走 HTTP 派发的路径（画布整图跑：浏览器里 `runGraph`
     * → `POST /run` → 宿主半）到这里会**静静丢掉这个键** ——
     * 所以那条路上看不到逐字增长，只能等整段。这是如实交代的边界，不是忘做：
     * 要让它也实时，得把 `/run` 改成流式响应，那属于宿主半路由的改动。
     * 本文件这一侧已经把事件发出来了，接上就能用。 */
    const onStream = spec.def.executor === 'agent'
      ? (text: string): void => { emit({ kind: 'stream', nodeId: id, text }) }
      : undefined
    const dispatchCommand = alertOnly
      ? {
          node: NOTIFY_DEF_ID,
          params: {
            content: spec.params.content,
            level: spec.params.level,
            system: spec.params.system,
          },
        }
      : judge !== null && judge.mode === 'rules'
        ? { ...(built.command as Record<string, unknown>), __judge: judge, ...onStream === undefined ? {} : { __onStream: onStream } }
        : onStream === undefined
          ? built.command
          : { ...(built.command as Record<string, unknown>), __onStream: onStream }
    let outcome = await dispatch({
      runId: 'run-' + id + '-' + String(Date.now()),
      nodeId: id,
      executor: spec.def.executor,
      /* `__judge` 与 `params` **并列**放在命令体里（不进参数表）——
       * 它是一次运行现场的产物，不该混进用户可编辑的参数；节点实现从命令体顶层读它。 */
      command: dispatchCommand,
      context: { workflowId, upstream, workdir, ...input.env === undefined ? {} : { env: input.env } },
      /* 形状照本文件其它「能省一个键就省」的写法（`depth` / `llm` / `paused`）：
       * 算不出来就**不写这个键** → 派发器走全局兜底 → 与改动前一个字节不变。 */
      ...effTimeout === undefined ? {} : { timeoutMs: effTimeout },
    }, signal)

    for (let attempt = 1; attempt <= retry.times; attempt += 1) {
      if (stopped()) break
      if (outcome.ok && outcome.status === 'success') break
      const reason = outcome.error ?? '执行失败'
      emit({
        kind: 'log', nodeId: id,
        line: '↻ 第 ' + String(attempt) + '/' + String(retry.times) + ' 次重试（'
          + (retry.delayMs > 0 ? '等 ' + String(retry.delayMs) + ' 毫秒后' : '立刻') + '重跑）'
          + ' 原因：' + reason,
      })
      if (retry.delayMs > 0) {
        /* 等的时候也要能被「停止」打断 —— 不能让人干等 5 秒。 */
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retry.delayMs)
          signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
        })
        if (stopped()) break
      }
      emit({ kind: 'log', nodeId: id, line: '【' + spec.def.label + '】重试第 ' + String(attempt) + ' 次' })
      outcome = await dispatch({
        runId: 'run-' + id + '-' + String(Date.now()),
        nodeId: id,
        executor: spec.def.executor,
        command: dispatchCommand,
        context: { workflowId, upstream, workdir, ...input.env === undefined ? {} : { env: input.env } },
        /* 重试那次**用同一个超时**（与第一次那处逐字一致）：两次派发是同一件事的
         * 两次尝试，超时预算不该在重试时悄悄变回全局 300 秒。
         * ⚠️ 用的是上面算好的 `effTimeout`，**不重算** —— 重算一次就多一处算法。 */
        ...effTimeout === undefined ? {} : { timeoutMs: effTimeout },
      }, signal)
    }

    if (signal?.aborted === true) return
    for (const line of outcome.logs ?? []) emit({ kind: 'log', nodeId: id, line })

    /* ★ 节点主动报的事（契约 AM）：**每条都照原样转发**，一条不丢。
     *
     * ## 为什么放在成功 / 失败分叉**之前**
     *
     * 纪律 3：「失败也要能汇报 —— 节点失败前推的那条要留着」。
     * 放进成功分支就只留成功的那几条，而失败那一刻推的往往正是最需要看的。
     *
     * ## 为什么不去重、不合并
     *
     * 纪律 2：循环里每轮一条，按到达顺序全留，**记录层不去重**
     * （折叠显示是界面的事，靠 `group.key`）。
     *
     * ## 为什么不进 `outputs`
     *
     * 纪律 1：汇报不参与数据流 —— 下游 `{{变量}}` 必须取不到它。
     * 这里只发事件，一个字都不写进 `outputs`。 */
    for (const entry of outcome.reports ?? []) emit({ kind: 'report', nodeId: id, entry })

    if (outcome.ok && outcome.status === 'success') {
      /* 条件判断：把「结果 + 走哪个出口」记成一条日志（用户 2026-10-19 要求
       * 「注意流程事件的完整性，不要只顾着判断」）。
       *
       * 为什么不在这里重算一遍：`branchFn` 才是真正下结论的那一处，
       * 它的结论就写在输出的 `__handle` 里 —— 从**实际输出**读回来，
       * 永远不会与真正走的那条路分叉（重算就会有两个真值来源）。
       * 也不放进 `branchFn` 里发：内置函数只有返回值这一个出口，没有日志通道。 */
      if (judge !== null) {
        const handles = liveHandles(outcome.output, spec.def)
        const went = handles === null || handles.length === 0
          ? '（没报出口，全部下游照常）'
          : '走「' + (handles[0] === 'true' ? '成立' : handles[0] === 'false' ? '不成立' : handles[0]) + '」这条出口'
        emit({ kind: 'log', nodeId: id, line: '✓ 判断结果：' + went })
      }
      /* 「Windows 通知与等待」的输出要**再包一层**：上游原样 + `__alert`。
       * 不平铺 —— 提醒结果不该与业务字段同级，用户取它得写 `{{__alert.notified}}`。 */
      const out = alertOnly ? alertWrap(upstream, outcome.output) : outcome.output
      outputs.set(id, out)
      ctx.local?.set(id, out)
      /* 透传模型痕迹（2026-10-23）：`outcome` 是**这次派发**的结果，
       * 痕迹就在它身上。没有就**不写这个键**（展开后为空对象，事件里不会多一个 `llm: undefined`）。 */
      emit({ kind: 'success', nodeId: id, output: out, ...outcome.llm === undefined ? {} : { llm: outcome.llm } })
      return
    }
    const msg = outcome.error ?? '执行失败'
    /* ── 「Windows 通知与等待」发通知失败：**吞掉，不算这个节点失败**（票 07）──
     *
     * 为什么：那个节点的 `onError` 是「走失败分支」，而它只为「等人超时」设。
     * 通知是附带动作，发不出去（不是 Windows、PowerShell 起不来）不该让下游走失败分支 ——
     * 那会让用户以为业务失败了，实际只是没弹出一条提醒。
     *
     * 处置：记一行日志、输出照常交出去（`__alert.notified` 为假、`reason` 写清是没发出去），
     * 整条流程照走。用户去查那一行就能知道提醒为什么没收到。 */
    if (alertOnly) {
      emit({ kind: 'log', nodeId: id, line: '⚠ 通知发送失败（不影响流程继续）：' + msg })
      const out = alertWrap(upstream, { notified: false, level: String(spec.params.level ?? 'notice'), reason: '发送失败：' + msg })
      outputs.set(id, out)
      ctx.local?.set(id, out)
      emit({ kind: 'success', nodeId: id, output: out })
      return
    }
    /* 透传模型痕迹（2026-10-23，与上面 success 那处同一写法）：
     * 模型报错 / 被截断时 `outcome.llm` 照样有（见 `executors.ts` 的失败分支）——
     * 那两种结局**最需要**看痕迹（哪个模型、花了多少、为什么结束）。
     * 没有就不写这个键。 */
    emit({ kind: 'log', nodeId: id, line: '✕ ' + msg })
    emit({ kind: 'failed', nodeId: id, error: msg, ...outcome.llm === undefined ? {} : { llm: outcome.llm } })
    failedEmitted.add(id)
    throw new Error(msg)
  }

  /**
   * 跑一个循环节点：把循环体重复执行 N 轮。
   *
   * ## 与「子图」的区别（用户定的形态）
   *
   * 循环体不是独立的子图，而是**容器里的节点**：`循环 → 头`、`尾 → 循环` 两条边
   * **隐式补上**（画布上不画），内部节点之间仍走真实连线。
   *
   * ## 四个必须做对的地方
   *
   * 1. **每轮一份 `local` 输出表** —— 否则第 2 轮会读到第 1 轮的值，上游语义就错了。
   * 2. **迭代变量经 `scope.fields` 注入**（与上游字段叠加，见 command.ts）——
   *    体内节点直接用 `{{item}}` / `{{index}}`，不必为此连线。
   * 3. **上限必须硬拦** —— 数据集异常大时不能无限跑（`iterationItems` 负责截断 + 给警告）。
   * 4. **嵌套时把 `parent` 传下去**（2026-10-19）—— 每一轮的现场要记住「我在谁里面」，
   *    `{{outer.item}}` 与「内层读外层本轮的值」全靠这条链。
   *
   * ## 嵌套循环（2026-10-19 放开，方案见 `plans/2026-10-19-嵌套循环-最终方案.md`）
   *
   * 原来这里有一道硬拦：查 `nestedLoops()`，有内层就抛错。现在改成**层数上限**
   * （`MAX_LOOP_DEPTH`）：不是技术限制，是防呆 —— 真要 6 层的人该先把工作流拆开。
   *
   * @param id - 循环节点 id。
   * @param ctx - 当前层现场（顶层是 `{}`；嵌在别的循环里时带着那一层的 `parent` 链）。
   */
  const runLoop = async (id: string, ctx: RunScope): Promise<void> => {
    const spec = byId.get(id)
    if (spec === undefined) return

    /* ── 可达性：与另外四处**逐字一致**（2026-10-22 补上这道缺口）──────────
     *
     * ## 这道闸门原来是漏的
     *
     * `runNode` / `runParallel` / `runSubWorkflow` / `runWait` 四处都有它，
     * **唯独循环没有**。后果是「挂在未走分支上的循环照样启动、真的去采集」——
     * 实测场景：「取数-抖音电商罗盘」的登录检测未登录时走失败分支，主流程那条路没走，
     * 而主流程里的取数循环照跑。当时只能在存档里加一个「主动抛错中断」的节点绕开，
     * 那是补在存档层，根因在这里。
     *
     * ## 为什么放在 `noteRan` **之前**
     *
     * ① **与另外四处一致**：它们都是先判可达性、再 `noteRan`（见 `runNode`）。
     * ② **语义**：`noteRan` 记的是「这次跑了哪些节点」，它进运行历史的 `ran`。
     *    一个被跳过、一个节点都没派发的循环**不该算跑过** —— 算了会让用户看到
     *    「跑了这个循环」却查不到任何轮次，反而更难判断。
     * ③ 另外四处跳过的节点也不进 `ran`，这里不一样的话同一件事就有两种记法。
     *
     * ⚠️ 三个条件缺一不可，**照抄，别简化**（简化的后果见 `tests/loop-unreachable.mjs`
     * 里那组「条件不能简化」的用例）：
     *   ① `!hasLiveInput` —— 上游那条路这次没走；
     *   ② `hasAnyInput`  —— 这个节点**确实有入边**。没有入边的是流程起点，不是死角；
     *   ③ `ctx.heads?.has(id) !== true` —— 它在循环体里是某个 head 时靠 `heads` 进来，
     *      不算「未走」（循环体首节点天生没有体内入边）。 */
    if (!hasLiveInput(id, ctx) && hasAnyInput(id) && ctx.heads?.has(id) !== true) {
      if (ctx.local === undefined) unreachable.add(id)
      else ctx.unreachable?.add(id)
      emit({ kind: 'log', nodeId: id, line: '⏭ 未走的分支，跳过（上游那条路这次没走）' })
      emit({ kind: 'skipped', nodeId: id })
      return
    }

    noteRan(id)

    /* 层数上限（2026-10-19：替代原来那道「嵌套就报错」的硬拦）。
     *
     * 判据是**这个循环自己嵌在几层里**（`loopChainDepth` 沿 `parentId` 链数），
     * 而不是「它体内还有没有循环」—— 后者只看得到一层。 */
    const depth = loopChainDepth(all.map(n => ({ id: n.id, defId: n.def.id, parentId: n.parentId })), id)
    if (depth > MAX_LOOP_DEPTH) {
      const msg = '循环嵌套太深（第 ' + String(depth) + ' 层，上限 ' + String(MAX_LOOP_DEPTH)
        + ' 层）：' + id + '。层数太多时先把工作流拆成几份，别硬套。'
      emit({ kind: 'log', nodeId: id, line: '✕ ' + msg })
      emit({ kind: 'failed', nodeId: id, error: msg })
      failedEmitted.add(id)
      throw new Error(msg)
    }

    const plan = loopPlan(all.map(n => ({ id: n.id, defId: n.def.id, parentId: n.parentId })), edges, id)
    if (plan === null) {
      const msg = '循环里没有节点（把要重复的节点拖进循环框里）'
      emit({ kind: 'log', nodeId: id, line: '✕ ' + msg })
      emit({ kind: 'failed', nodeId: id, error: msg })
      failedEmitted.add(id)
      throw new Error(msg)
    }

    /* ── 循环的输入：**参数优先，没填才用入边**（2026-10-17 用户定案「端口补实」）──
     *
     * 历史：2026-10-13 曾把端口删掉、只认参数 `items`（照 Dify 的零 Handle）。
     * 但那次前端与存档都没跟着改（界面照画端口、存档照往端口上接线），
     * 于是「定义说没有端口、实际数据里有」—— 见 `src/nodes/flow/loop/node.ts` 的端口注释。
     *
     * 现在两条路都认。**优先级是「参数优先」**：
     *   ① 填了 `items` → 用它（选节点 + 选字段，`resolveNodeField` 从**外层** `outputs` 取）；
     *   ② 没填 → 用**第一条活入边**的上游输出（跨边界连线是「显式上游」，见 `upstreamOf`）；
     *   ③ 两条都没有 → 交给 `iterationItems` 给一句可读的报错（统一出口，不在这里抛）。
     *
     * ⚠️⚠️ **为什么是「参数优先」而不是「入边优先」**（这是实测改过来的，别想当然翻转）：
     *
     * 第一版写的是「入边优先」，理由听起来很顺（连了线当然用线）。跑全套测试当场红：
     * 抖音那份工作流里 `n1 → n2` 这条边**本来就存在**（它同时承担「顺序依赖」），
     * 而循环真正要的数据是参数 `items: { nodeId: n1, field: 'modules' }`
     * —— 取的是 n1 输出里的 `modules` 字段。入边优先拿到的是 **n1 的整个输出对象**
     * （`{ modules, count, shop }`），不是数组 → `iterationItems` 直接报
     * 「选到的不是一个列表（object）」。
     *
     * 也就是说：**已有工作流全都「连了线 + 填了参数」**（生成器就是这么写的），
     * 「入边优先」会把它们**全部弄坏**。参数是**明确的字段选择**，比「整份输出」精确，
     * 所以让参数赢。想看「哪条生效」不必猜 —— 下面会记一条日志。 */
    const itemsRef = readNodeField(spec.params.items)
    const inEdges = edges.filter(e => e.target === id && edgeAlive(e, ctx))
    let loopInput: unknown
    let from = ''
    if (spec.params.mode === 'count') {
      /* 「固定重复几次」不看数据，两处来源都不用。 */
      loopInput = undefined
    } else if (itemsRef !== null) {
      /* ⚠️ 第三个参数传 `ctx`（2026-10-19 嵌套）：内层的「遍历哪个数据」可以选
       * **外层循环体里**某个节点的输出 —— 那张表在全局 `outputs` 里只有最后一轮的残留，
       * 必须按归属层读。不传 `ctx` 时行为与改动前一致（只用 `outputs`）。 */
      loopInput = resolveNodeField(itemsRef, outputs, ctx)
      from = '「遍历哪个数据」参数（' + itemsRef.nodeId + '）'
      /* 「选的那一步这次跑没跑」要按**归属层**判（嵌套时它可能在外层本轮里，
       * 不在全局 `outputs` 里 —— 只看 `outputs` 会误报「这次没有跑」）。 */
      if (loopInput === undefined && !scopedOutputOf(itemsRef.nodeId, ctx, outputs).found) {
        /* 选的节点**这次没跑**（例如在未走的分支上）→ 说清是哪一步，别让用户对着
         * 「循环没有拿到数据」猜。 */
        emit({
          kind: 'log', nodeId: id,
          line: '⚠ 选的数据来源「' + itemsRef.nodeId + '」这次没有跑（它可能在未走的分支上）',
        })
      } else {
        emit({ kind: 'log', nodeId: id, line: 'ⓘ 遍历数据取自' + from })
      }
    } else if (inEdges.length > 0) {
      /* 没填参数 → 用入边那份数据（新增的能力：只连线、不填参数也能喂数据）。 */
      const srcId = (inEdges[0] as TopoEdge).source
      loopInput = outOf(srcId, ctx)
      from = '入边（来自节点「' + srcId + '」）'
      emit({ kind: 'log', nodeId: id, line: 'ⓘ 遍历数据取自' + from })
    }
    const { items, warning } = iterationItems(spec.params, loopInput)
    if (warning !== '') emit({ kind: 'log', nodeId: id, line: '⚠ ' + warning })

    emit({ kind: 'started', nodeId: id, label: spec.def.label, executor: spec.def.executor, defId: spec.def.id, ...spec.label === undefined ? {} : { nodeLabel: spec.label } })
    emit({ kind: 'log', nodeId: id, line: '【' + spec.def.label + '】开始循环，共 ' + String(items.length) + ' 轮' })

    /* ── 并发度（2026-10-17 实现；此前界面上能填、执行层从没读过）─────────────
     *
     * 取值 1..10（与 `paramDefs` 的 `min/max` 一致），非数字回落 1。
     * 1 = 老行为（一轮一轮按顺序）。 */
    const concRaw = Number(spec.params.concurrency)
    const concurrency = Number.isFinite(concRaw) ? Math.min(10, Math.max(1, Math.floor(concRaw))) : 1
    if (concurrency > 1) {
      emit({
        kind: 'log', nodeId: id,
        line: 'ⓘ 并发跑 ' + String(concurrency) + ' 条 —— 结果顺序仍与一条一条跑完全一致；'
          + '但日志的先后可能交错。若循环体在操作浏览器，同一个页面上并发会互相踩，慎用。',
      })
    }

    /* ⚠️ **结果按轮次下标回填**（不是「跑完一个 push 一个」）——
     * 这是并发下「结果顺序与串行一致」的实现方式。断掉时只保留真跑完的那些。 */
    const done: { i: number, result: unknown, local: Map<string, unknown> }[] = []

    /* ── 条件跳出（2026-10-19，照 Dify 的 `break_conditions`）───────────────
     *
     * ## 为什么解析一次、判定放在每轮之后
     *
     * 左边的三种来源里，「图里某节点的字段」取的是**本轮**的值（`outOf` 读本轮 `local`），
     * 而「循环变量」取的是**这一层**的本轮值 —— 两者都是**每轮才确定**的。
     * 所以条件在这里读一次形状（`readBreakConditions`，纯逻辑），
     * 每轮跑完之后再解析左边的值并比（`shouldBreakLoop`）。
     *
     * ## 没配 = 一条都不多跑
     *
     * `breakRule === null` 时下面那次判定根本不会发生 —— 老存档走的正是这条路，
     * 行为与改动前**一字不变**（硬要求）。
     *
     * ## 每层各判各的
     *
     * 条件里的 `loop` 来源用 `loopVarFields(ctx)`（本层现场，含 `outer.*`），
     * `field` 来源用 `outOf(…, ctx)`（按归属层读）—— 都是**这一层**的视角，
     * 所以内层的跳出条件看不到外层的进度，外层也看不到内层的。
     * 这是「内层跳出不该停外层」的实现方式：不是靠额外判断，而是靠**各拿各的现场**。
     */
    const breakRaw = readBreakConditions(spec.params.breakConditions)
    if (breakRaw.dropped > 0) {
      emit({
        kind: 'log', nodeId: id,
        line: '⚠ 有 ' + String(breakRaw.dropped) + ' 条「跳出条件」不完整（没选值），已忽略',
      })
    }
    const breakLogic: 'and' | 'or' = spec.params.breakLogic === 'or' ? 'or' : 'and'
    const breakConds = breakRaw.conds
    if (breakConds.length > 0) {
      emit({
        kind: 'log', nodeId: id,
        line: 'ⓘ 配了 ' + String(breakConds.length) + ' 条跳出条件，按「'
          + (breakLogic === 'or' ? '满足任一' : '全部满足') + '」判；成立就停这个循环（不算失败）',
      })
    }

    /* ── 连续失败跳出（2026-10-19，照源码的 `consecutiveFails`）───────────────
     *
     * 与上面的 `breakConditions` 是**两件事**（任务书明确要求别混成一个参数）：
     *   · `breakConditions` —— 按用户写的**条件**跳出；
     *   · `maxConsecutiveFailures` —— 按**失败次数**自动跳出。
     *
     * ⚠️ **默认 0 = 不启用**（老存档行为一字不变）。判据用 `> 0` 而不是 `!== 0`：
     * 负数 / NaN 也当作没配（存档被手改时不能变成「每轮都跳」）。 */
    const maxConsecutiveRaw = spec.params.maxConsecutiveFailures
    const maxConsecutive = typeof maxConsecutiveRaw === 'number' && Number.isFinite(maxConsecutiveRaw)
      ? Math.max(0, Math.floor(maxConsecutiveRaw))
      : 0
    if (maxConsecutive > 0) {
      emit({
        kind: 'log', nodeId: id,
        line: 'ⓘ 连续失败 ' + String(maxConsecutive) + ' 轮就停这个循环（成功一轮就清零）',
      })
    }
    /** 「连续失败」累计数（成功一轮清零）。 */
    let consecutiveFails = 0
    /** 这次跳出是「连续失败」触发的吗（用来在结果里记下被跳过的轮次）。 */
    let failedRoundsBreak = false

    /**
     * 本轮的跳出判定现场。
     *
     * @param ctx - 本轮现场（`local` / `loopVars` / `parent` 都在里面）。
     * @returns 可以直接比的条件（`null` = 没配跳出）。
     */
    const breakRuleFor = (ctx: RunScope): BreakRule | null => {
      if (breakConds.length === 0) return null
      const loopVars = loopVarFields(ctx)
      const conds: ResolvedCondition[] = breakConds.map((c) => {
        const { value, label } = resolveOperand(c.left as NonNullable<typeof c.left>, {
          outOf: (nodeId: string) => outOf(nodeId, ctx),
          labelOf: (nodeId: string) => {
            const s = byId.get(nodeId)
            if (s === undefined) return nodeId
            const shown = s.label !== undefined && s.label !== '' ? s.label : s.def.label
            return shown + '（' + nodeId + '）'
          },
          /* 只给普通键（`__model` 是运行上下文，不该出现在可比/可选的输入项里）。 */
          inputs: withoutReservedKeys(resolvedInputs),
          loopVars,
        })
        const r: ResolvedCondition = { left: value, op: c.op ?? 'notEmpty', label }
        if (c.value !== undefined) r.value = c.value
        if (c.valueType !== undefined) r.valueType = c.valueType
        return r
      })
      return { conds, logic: breakLogic }
    }

    /**
     * 跑一轮。
     * @param i - 轮次下标。
     * @returns 这一轮跑完后是否**该跳出**（`true` = 停后续轮次）。
     */
    const runRound = async (i: number): Promise<boolean> => {
      if (signal?.aborted === true) return false
      emit({ kind: 'log', nodeId: id, line: '第 ' + String(i + 1) + '/' + String(items.length) + ' 轮' })
      /* 每轮一份新的输出表 —— 这是「轮与轮之间不串味」的关键。
       * `bodyIds` 一并传下去：`upstreamOf` 靠它判断「边的起点算不算本层」，
       * 否则本层没跑过的起点会回落读外层、读到上一轮的残留（见那里的说明）。 */
      const local = new Map<string, unknown>()
      const bodySet = new Set(plan.bodyIds)
      /* 每轮**各自一份**「本轮不可达」名单（2026-10-17 改：原先整层共用一份，
       * 并发时会互相污染 —— 见 `ctx.unreachable` 的注释）。 */
      const roundUnreachable = new Set<string>()
      /* 体内节点先排「排队中」，跟顶层一样给界面一个交代。
       * ⚠️ 走 `noteQueued` 记账（契约 AB）：中断时这些也要收到 `cancelled`。 */
      for (const b of plan.order) { noteQueued(b); emit({ kind: 'queued', nodeId: b }) }
      /* ★ 本轮的失败计数（2026-10-19，连续失败跳出用）。
       * 每轮**一份新的** `{ count: 0 }` —— 与 `local` / `unreachable` 同一个纪律，
       * 共用一份的话第 1 轮的失败会被第 2 轮读到。 */
      const roundFailures = { count: 0 }
      await runSeq(plan.order, {
        local,
        bodyIds: bodySet,
        heads: new Set(plan.heads),
        loopVars: { item: items[i], index: i },
        /* ★ **把「我在谁里面」传下去**（2026-10-19 嵌套循环的核心一条）。
         *
         * 顶层循环时 `ctx` 是 `{}`（没有 `loopVars`），于是这条链在这里就断了 ——
         * `loopVarFields` 返回 `{ item, index }`，与改动前**逐字一致**（老存档不变）。
         *
         * 嵌在别的循环里时，`ctx` 是**外层那一轮**的现场，于是：
         *   · `{{outer.item}}` 取到外层本轮的值（`loopVarFields` 沿链拼）；
         *   · 体内节点读「外层体里的起点」时读的是**外层本轮**的 `local`（`scopedOutputOf`）。
         *
         * ⚠️ 同一层的每一轮共用**同一个** `parent` 引用 —— 那是外层那一轮，本来就该共享；
         * 轮与轮之间不串味靠的是上面这行 `new Map()`（每轮一份 `local`）。 */
        parent: ctx,
        unreachable: roundUnreachable,
        failures: roundFailures,
      })
      /* 留着这一轮的输出表 —— 「结果取哪个」要在里面逐轮取值。 */
      done.push({ i, result: collectRound(plan.tails, local), local })

      /* ── ① 连续失败计数（2026-10-19，照源码的 `consecutiveFails`）────────────
       *
       * 源码原样：
       * ```ts
       * let consecutiveFails = 0;
       * for (...) { try { ... } catch { consecutiveFails++; if (consecutiveFails >= 2) { 停这个模块 } } }
       * ```
       * 语义：**连续** N 次失败就停这个循环；**成功一次就清零**。
       *
       * ⚠️ 与下面的 `breakConditions` 是**两件事**（任务书明确要求别混）：
       *   · 这里 —— 按**失败次数自动**跳出；
       *   · 那里 —— 按**用户写的条件**跳出。
       * 两个独立参数、各自生效、可以同时配（谁先命中谁生效）。
       *
       * ⚠️ 「成功」的判据是 `roundFailures.count === 0`（本轮**没有任何**节点失败），
       * 不是「这轮跑完了」—— 后者在 `continue` 策略下永远成立，等于永不清零。 */
      if (maxConsecutive > 0) {
        if (roundFailures.count > 0) {
          consecutiveFails += 1
          emit({
            kind: 'log', nodeId: id,
            line: '⚠ 第 ' + String(i + 1) + ' 轮有 ' + String(roundFailures.count) + ' 个节点失败（连续第 '
              + String(consecutiveFails) + ' 次）',
          })
        } else {
          /* 成功一次就清零 —— 不写这一行的话「失败-成功-失败」会被当成「连续 2 次」。 */
          if (consecutiveFails > 0) {
            emit({ kind: 'log', nodeId: id, line: 'ⓘ 第 ' + String(i + 1) + ' 轮成功，连续失败计数清零（原为 ' + String(consecutiveFails) + '）' })
          }
          consecutiveFails = 0
        }
      }

      /* ── 本轮跑完 → 判一次「该不该跳出」（2026-10-19）─────────────────
       *
       * 位置必须在**整轮跑完之后**：
       *   · 条件可能引用的正是本轮体内某节点的输出（`chk.ok === false` 这种写法）；
       *   · 放在轮中间的话，用户的直觉是「这一轮跑了一半被砍」—— 那不是跳出，是中断。
       *
       * ⚠️ **`shouldBreakLoop` 抛错时按本节点的失败策略走**（`runSeq` 的 catch）——
       * 比较符写坏（存档被手改）属于**配置错误**，不该被静默当成「不跳」。
       * 这与 `flow.if` 那边「不认识的比较符要报错」是同一条纪律。 */
      const rule = breakRuleFor({
        local,
        bodyIds: bodySet,
        heads: new Set(plan.heads),
        loopVars: { item: items[i], index: i },
        parent: ctx,
        unreachable: roundUnreachable,
      })
      const verdict = shouldBreakLoop(rule)
      for (const line of verdict.detail) emit({ kind: 'log', nodeId: id, line: 'ⓘ 跳出条件：' + line })
      /* ★ 连续失败超限 → 也是「跳出」（不是失败），与条件跳出走同一条路。
       * 这样下面 `brokeAt` 的处理（不发 failed、结果照给）自然共用。 */
      if (maxConsecutive > 0 && consecutiveFails >= maxConsecutive) {
        emit({
          kind: 'log', nodeId: id,
          line: '⏹ 连续 ' + String(consecutiveFails) + ' 轮失败（上限 ' + String(maxConsecutive)
            + '），停这个循环 —— 不算报错，已跑完的轮次结果照常给出',
        })
        failedRoundsBreak = true
        return true
      }
      return verdict.break
    }

    /** 用户点「停止」了吗（包一层，避开 TypeScript 的控制流窄化，见下面那处调用）。 */
    const stopped = (): boolean => signal?.aborted === true

    /** 已经按条件跳出了吗（跳出后不再开新的一批）。 */
    let brokeAt = -1

    for (let start = 0; start < items.length; start += concurrency) {
      if (stopped()) break
      /* 上一批里有轮次判定「该跳出」→ 不再开新的一批（外层跳出时内层也就不会再有新一轮）。
       * 判据放在**批与批之间**：同一批里已经开跑的轮次照常跑完（`concurrency > 1` 时
       * 那些是并发的，中途砍掉它们属于「中断」而不是「跳出」）。 */
      if (brokeAt >= 0) break
      const batch: Promise<boolean>[] = []
      for (let i = start; i < Math.min(start + concurrency, items.length); i++) batch.push(runRound(i))
      /* ⚠️ 用 `allSettled` 而不是 `all`：某一轮失败时**其余轮次也要等它跑完**
       * （`all` 会立刻 reject，剩下几轮还在后台跑，出错现场就乱了）。
       * 之后再按失败策略把第一个错抛出去 —— 与串行时的语义一致。 */
      const settled = await Promise.allSettled(batch)
      const firstErr = settled.find(s => s.status === 'rejected')
      /* 有轮次失败 → 按失败策略抛出去（`runSeq` 里已经判过 stop/continue 并设好 `aborted`）。 */
      if (firstErr !== undefined) throw (firstErr as PromiseRejectedResult).reason
      /* 这一批里有人要求跳出 → 记下**最早那个**轮次下标（并发时可能多个）。
       * 结果仍然照常收集（跳出不是失败、也不丢已跑的轮次）。 */
      for (let k = 0; k < settled.length; k += 1) {
        const s = settled[k]
        if (s.status === 'fulfilled' && s.value === true) {
          const at = start + k
          if (brokeAt < 0 || at < brokeAt) brokeAt = at
        }
      }
      /* 被用户中断（点「停止」）→ 别再开新的一批。
       * ⚠️ 走 `stopped()` 而不是直接写 `signal?.aborted === true`：
       * TypeScript 的控制流分析会把上面那几处判断当成「已经证明它不为真」，
       * 于是这一行被窄化成恒假、报 TS2367（这个比较永远不成立）。
       * 包一层函数就绕开了窄化，语义完全一样。 */
      if (stopped()) break
    }

    /* 跳出时说清「第几轮之后停的」—— 用 log 不用 failed（跳出不是失败）。
     * ⚠️ 这条必须在 `buildLoopOutput` 之前发，否则界面上的顺序会看着像「先出结果后说原因」。 */
    if (brokeAt >= 0) {
      emit({
        kind: 'log', nodeId: id,
        line: '⏹ 第 ' + String(brokeAt + 1) + ' 轮后按条件跳出（还剩 '
          + String(Math.max(0, items.length - (brokeAt + 1))) + ' 轮没跑；'
          + '已跑完的 ' + String(brokeAt + 1) + ' 轮结果照常给出）',
      })
    }

    /* 按轮次下标排序 —— 并发的完成先后不影响结果顺序（这是硬判据，有测试钉住）。 */
    done.sort((a, b) => a.i - b.i)
    const results: unknown[] = done.map(d => d.result)
    const roundLocals: Map<string, unknown>[] = done.map(d => d.local)

    /* 按「结果取哪个」收窄输出（照 Dify 的 output_selector）。
     * 没选则照 n8n：把每轮结果全给出（旧行为，向后兼容）。 */
    const out = buildLoopOutput(results, readNodeField(spec.params.result), roundLocals)
    /* ★ **被跳过的轮次要记下来**（2026-10-19，任务书硬要求：
     * 「被跳出的那几轮要记进结果，说明『因为连续失败被跳过』，不能静默丢」）。
     *
     * 为什么不能只发一条日志：运行记录与运行历史读的是**输出对象**，
     * 日志只在画布的日志面板里。事后回看「这次为什么只有 2 条结果」时，
     * 只能在输出里找答案 —— 日志那行早被刷走了。
     *
     * 只在「连续失败跳出」时加这两个字段（条件跳出时不加）：
     *   · 条件跳出是用户**主动**设计的停止点，结果少是预期的；
     *   · 连续失败跳出是**意外**，必须显式说明，否则看起来像「循环少跑了」。
     *
     * ⚠️ 形状是**追加字段**，不改 `count` / `results` 的含义：
     * 老代码读 `out.count` / `out.results` 完全不受影响（向后兼容）。 */
    if (failedRoundsBreak && brokeAt >= 0) {
      const skipped: number[] = []
      for (let i = brokeAt + 1; i < items.length; i += 1) skipped.push(i + 1)
      Object.assign(out, {
        skippedRounds: skipped,
        skippedReason: '连续 ' + String(maxConsecutive) + ' 轮失败，按上限停了这个循环',
      })
    }
    outputs.set(id, out)
    /* ★ **三处都写**（2026-10-19 嵌套）：全局 + 本层 + **外层本轮**。
     *
     * 原先只有前两行（「写全局 + 写本层」）。嵌套之后多出第三处，理由是
     * 「结果只交上一层，不做自动嵌套数组」这条定案：
     *
     *   内层循环对外层来说**就是一个普通节点**（它住在 `parentId` 指向外层的那个框里）。
     *   所以它跑完要把输出交进**外层那一轮**的 `local` —— 外层的 `collectRound`
     *   只看本轮 `local`，交进去了它自然能取到，**不需要任何新的合并逻辑**。
     *
     * ⚠️ 别改成「自动拼成嵌套数组」：那是 Dify `flatten_output` 那一套，
     * 用户明确不要（见方案 §五 选择 2）。
     *
     * ⚠️ 写成 `ctx.local?.set` 而不是直接 set：顶层调用时 `ctx` 是 `{}`，
     * 没有 `local` —— 那种情况下这一行本来就不该有作用（全局那行已经写了）。 */
    ctx.local?.set(id, out)
    emit({ kind: 'success', nodeId: id, output: out })
  }

  /**
   * 跑一个并行节点：把框内的成员切成几路，**路与路并发、每路内部保持顺序**。
   *
   * ## 为什么它不进 `NODE_IMPLS`
   *
   * 与 `runLoop` 同一个理由：它要的是「把框里的成员按图切成几路、并发调度」，
   * 而一个普通内置函数只看得到自己的参数与上游 —— 看不见图，也开不出几条执行流。
   *
   * ## 四条语义（用户 2026-10-21 / 22 定，写死不许另发明）
   *
   *  1. 一路 = 框内一个「没有来自框内的入边」的成员 + 它在框内的全部下游；
   *     切分规则在 `parallel.ts`（纯函数、有单测），这里只负责跑。
   *  2. 每路内部保持顺序，路与路并发，上限取 `concurrency`（默认 1）。
   *  3. 某一路失败**不打断其它**：`Promise.allSettled` 收口，该路位置给失败原因，
   *     其余照常（所以本节点只在「框里根本没有成员」时抛错）。
   *  4. 输出 = 按「每路起点在拓扑序里的位置」排好序的数组。
   *
   * ## 为什么每一路各一份 `local` / `unreachable` / `failures`
   *
   * 与循环「每轮一份」同一条纪律：几路并发时共用一份会互相污染 ——
   * A 路判定的「某节点这次没走」会把 B 路误杀，A 路的失败会被记到 B 路头上。
   *
   * ## 已知限制
   *
   * 画布当前**不能**把节点放进并行框（`container-ops.ts` 的 `isContainer` 只认分组框与循环），
   * 所以并行体只能通过改存档里成员的 `parentId` 建立。节点说明里已如实写明。
   *
   * @param id - 并行节点 id。
   * @param ctx - 当前层现场。
   */
  const runParallel = async (id: string, ctx: RunScope): Promise<void> => {
    const spec = byId.get(id)
    if (spec === undefined) return

    /* 可达性：与 `runNode` 同一条判据（框可能挂在没走的那条分支上）。 */
    if (!hasLiveInput(id, ctx) && hasAnyInput(id) && ctx.heads?.has(id) !== true) {
      if (ctx.local === undefined) unreachable.add(id)
      else ctx.unreachable?.add(id)
      emit({ kind: 'log', nodeId: id, line: '⏭ 未走的分支，跳过（上游那条路这次没走）' })
      emit({ kind: 'skipped', nodeId: id })
      return
    }

    /* 被标为「跳过」：与普通节点一致 —— 不执行，上游原样传给下游。 */
    if (spec.skipped) {
      emit({ kind: 'log', nodeId: id, line: '⏭ 已跳过（不执行，上游数据原样传给下游）' })
      const through = passthroughOf(upstreamOf(id, ctx))
      if (through !== undefined) {
        outputs.set(id, through)
        ctx.local?.set(id, through)
      }
      emit({ kind: 'skipped', nodeId: id })
      return
    }

    noteRan(id)

    const plan = parallelPlan(all.map(n => ({ id: n.id, defId: n.def.id, parentId: n.parentId })), edges, id)
    if (plan === null) {
      const msg = '没有这个并行节点：' + id
      emit({ kind: 'log', nodeId: id, line: '✕ ' + msg })
      emit({ kind: 'failed', nodeId: id, error: msg })
      failedEmitted.add(id)
      throw new Error(msg)
    }

    /* ── 框里没有成员 ────────────────────────────────────────────────
     *
     * 与「跨路汇合」是**两件不同的事**（所以计划里有两种 `kind`，不合成一个 null）：
     * 这里是「还没往里放东西」，那里是「放进去的形状不支持」。 */
    if (plan.kind === 'empty') {
      const msg = '并行框里没有节点：需要把要同时做的事放进并行框（当前只能在存档里设置成员的 parentId）'
      emit({ kind: 'log', nodeId: id, line: '✕ ' + msg })
      emit({ kind: 'failed', nodeId: id, error: msg })
      failedEmitted.add(id)
      throw new Error(msg)
    }

    /* ── 框内多路汇到同一个节点 → **明确拒绝**（2026-10-22）─────────────
     *
     * ## 为什么不是「尽力跑」
     *
     * 让汇合点「等两边都到」等于在并行内部再实现一套依赖调度；n8n 与 Dify
     * 也都不隐式支持跨分支汇合，而是靠显式合并节点 —— 我们有 `flow.merge`。
     *
     * 更要紧的是**上一版的实际行为**：它不报错、静静给出一个结果，而那个结果
     * 还随并发上限变化（同一个图，`concurrency` 1 与 2 输出不同）。
     * 这是最坏的一类 —— 不报错、不丢数据的模样、但结果不对。
     * 本项目一贯的取舍是「与其静默降级，不如当场明确报错」。 */
    if (plan.kind === 'cross-lane-merge') {
      const where = plan.merges.map(m => m.sources.join('、') + ' 都指向 ' + m.target).join('；')
      const msg = '框内有多路汇到同一个节点（' + where + '）：并行框不支持跨路汇合。'
        + '请先用「合并」节点把这几路并成一路，或改成串联。'
      emit({ kind: 'log', nodeId: id, line: '✕ ' + msg })
      emit({ kind: 'failed', nodeId: id, error: msg })
      failedEmitted.add(id)
      throw new Error(msg)
    }

    /* 并发度：取值 1..10（与参数 min/max 一致），非数字回落 1。 */
    const concRaw = Number(spec.params.concurrency)
    const concurrency = Number.isFinite(concRaw) ? Math.min(10, Math.max(1, Math.floor(concRaw))) : 1

    /* ── 并形体里**不许**放等待 ────────────────────────────────────
     *
     * 与循环体那条同源：现场里记的是「从哪个节点之后继续」，而恢复时按**主序**切片
     * （`mainOrder.indexOf`）—— 并行体的成员不在主序里，切片会落空，
     * 结果是「恢复 = 整份从头跑」，那会**再挂一次**，永远跑不完。
     *
     * 与其静默地那样，不如当场明确报错：说清是配置不支持，不是出了故障。 */
    const waitInside = plan.bodyIds.filter(b => byId.get(b)?.def.id === WAIT_DEF_ID)
    if (waitInside.length > 0) {
      const msg = '「等待」节点不能放在并行框里（并行体的恢复本版本还不支持）：' + waitInside.join('、')
        + '。并形体里如需等待，请使用「延迟」节点。'
      emit({ kind: 'log', nodeId: id, line: '✕ ' + msg })
      emit({ kind: 'failed', nodeId: id, error: msg })
      failedEmitted.add(id)
      throw new Error(msg)
    }

    emit({ kind: 'started', nodeId: id, label: spec.def.label, executor: spec.def.executor, defId: spec.def.id, ...spec.label === undefined ? {} : { nodeLabel: spec.label } })
    emit({
      kind: 'log', nodeId: id,
      line: '【' + spec.def.label + '】' + String(plan.lanes.length) + ' 路并发（上限 ' + String(concurrency)
        + '）：' + plan.lanes.map((l, i) => String(i + 1) + '=' + l.head).join('、'),
    })

    /* 体内节点先排「排队中」，与循环体内同一个做法（界面要一眼看出这次要跑哪些）。
     * ⚠️ 同样走 `noteQueued` 记账（契约 AB）。 */
    for (const b of plan.order) { noteQueued(b); emit({ kind: 'queued', nodeId: b }) }

    /* 结果按「路下标」回填 —— 并发的完成先后不影响结果顺序（硬判据，有测试钉住）。 */
    const done: { i: number, result: unknown }[] = []

    /**
     * 某一路挂起了（框里放了「等待」节点）。
     *
     * ⚠️ **挂起不是失败**：`runLane` 的 catch 会把异常当「这一路失败」吞掉，
     * 那样挂起就变成了一条失败原因 —— 恢复也再不会发生。所以这里单独留一格，
     * 让它原样穿出去（与 `runSeq` 里「先认 `RunPausedError`」同一条纪律）。
     */
    let lanePause: unknown = null

    /**
     * 跑一路，并把「这一路的结果」或「这一路的失败原因」填回它自己的位置。
     *
     * ⚠️ **不抛错**（除挂起）：一路失败只影响它自己那一位（用户定的「一路失败不打断其它」）。
     *
     * @param i - 路下标。
     */
    const runLane = async (i: number): Promise<void> => {
      const lane = plan.lanes[i] as (typeof plan.lanes)[number]
      const local = new Map<string, unknown>()
      /* 这一路失败了几次（`continue` 策略下 `runSeq` 会吞掉错，只在这里记数）。 */
      const laneFailures = { count: 0 }
      let laneError = ''
      try {
        await runSeq(lane.ids, {
          local,
          bodyIds: new Set(lane.ids),
          heads: new Set([lane.head]),
          parent: ctx,
          unreachable: new Set<string>(),
          failures: laneFailures,
        })
      } catch (e) {
        /* 挂起要**原样往上穿**（见 `lanePause` 的说明）。 */
        if (e instanceof RunPausedError) {
          lanePause = e
          throw e
        }
        /* 路内某节点失败且策略是 `stop` → `runSeq` 抛出来。停的只是**这一路**
         * （同一路的后续节点不再跑），其它路照常 —— 所以这里吞掉，只记原因。 */
        laneError = e instanceof Error ? e.message : String(e)
      }
      if (laneError === '' && laneFailures.count > 0) {
        laneError = '这一路有 ' + String(laneFailures.count) + ' 个节点失败'
      }
      if (laneError !== '') {
        emit({ kind: 'log', nodeId: id, line: '⚠ 第 ' + String(i + 1) + ' 路失败（其余几路照常）：' + laneError })
        done.push({ i, result: laneError })
        return
      }
      done.push({ i, result: collectRound(lane.tails, local) })
    }

    /** 用户点「停止」了吗（包一层，避开 TypeScript 的控制流窄化 —— 见 `runLoop` 里那段说明）。 */
    const stopped = (): boolean => signal?.aborted === true

    for (let start = 0; start < plan.lanes.length; start += concurrency) {
      if (stopped()) break
      const batch: Promise<void>[] = []
      for (let i = start; i < Math.min(start + concurrency, plan.lanes.length); i++) batch.push(runLane(i))
      /* ⚠️ 用 `allSettled` 而不是 `all`：一路的异常不该让其余几路的结果丢失
       * （`runLane` 内部已经吞掉异常，这里再收一道 —— 防的是将来有人在 `runLane` 里加了会抛的语句）。 */
      await Promise.allSettled(batch)
      /* 这一批里有路挂起了 → 整份运行挂起（其余几路已经收口，结果是半截的，
       * 但挂起本来就不是「跑完」，调用方写的是运行现场，不写结果）。 */
      if (lanePause !== null) throw lanePause
      if (stopped()) break
    }

    /* 用户中断时只保留真跑完的那几路 —— 按路下标排序，顺序与「一路一路串着跑」一致。 */
    done.sort((a, b) => a.i - b.i)
    const results: unknown[] = done.map(d => d.result)

    outputs.set(id, results)
    ctx.local?.set(id, results)
    emit({ kind: 'success', nodeId: id, output: results })
  }

  /**
   * 跑一个「开始」节点：把本次运行的输入发下去。
   *
   * ## 为什么它几乎什么都不做（这是有意的）
   *
   * 输入在 `runGraph` 开头就解析好了（`resolvedInputs`），并且对**每个**节点可见 ——
   * 所以下游拿值**不必**先等开始节点跑完，写 `{{日期}}` 就直接能用。
   *
   * 那它为什么还要存在、还要"跑"一次？
   *   ① **顺序**：用户把它连在链头，「先跑开始、再跑下游」这个次序要成立；
   *   ② **可达性**：不跑它，它的下游会因为没有活入边而被判成「未走的分支」跳过；
   *   ③ **界面反馈**：节点要变色（否则用户以为它没执行）。
   *
   * @param id - 节点实例 id。
   * @param ctx - 当前层现场。
   */
  const runStart = async (id: string, ctx: RunScope): Promise<void> => {
    const spec = byId.get(id)
    if (spec === undefined) return
    noteRan(id)
    emit({ kind: 'started', nodeId: id, label: spec.def.label, executor: spec.def.executor, defId: spec.def.id, ...spec.label === undefined ? {} : { nodeLabel: spec.label } })
    const names = Object.keys(resolvedInputs)
    /* 开始节点的**输出**要交下游：那只该含用户声明的输入项。
     * `__model` 这类保留键属于运行上下文，由 `resolvedInputs` 直接供引擎使用，
     * **不**混进这份输出（否则它会被 `fieldsFromUpstream` 当字段带去下一个节点）。 */
    const out = withoutReservedKeys(resolvedInputs)
    emit({
      kind: 'log', nodeId: id,
      line: Object.keys(out).length === 0
        ? 'ⓘ 没有声明的输入项，直接往下走'
        : 'ⓘ 交出 ' + Object.keys(out).length + ' 项输入：' + Object.keys(out).join('、'),
    })
    outputs.set(id, out)
    ctx.local?.set(id, out)
    emit({ kind: 'success', nodeId: id, output: out })
  }

  /**
   * 跑一个「结束」节点：收口标记。
   *
   * 与 `runStart` 同一个形态 —— 产出的**值**在所有节点跑完后由 `runGraph` 统一取
   * （见那里 `declaredOutputs` 的说明），这里只负责把顺序与状态走完。
   *
   * @param id - 节点实例 id。
   * @param ctx - 当前层现场。
   */
  const runEnd = async (id: string, ctx: RunScope): Promise<void> => {
    const spec = byId.get(id)
    if (spec === undefined) return
    noteRan(id)
    emit({ kind: 'started', nodeId: id, label: spec.def.label, executor: spec.def.executor, defId: spec.def.id, ...spec.label === undefined ? {} : { nodeLabel: spec.label } })
    /* 上游照原样收下（它的入线是「接在谁后面」；但产出另有声明，不看这个）。 */
    const through = passthroughOf(upstreamOf(id, ctx))
    /* ★ 「什么时候显示」= `when`（用户 m03330 要的那个设置）。
     *   · `end`（默认）：什么都不做，跑完后由 `runGraph` 统一打一行 —— 与 bat 一样；
     *   · `live`：**当场**取一次并打出来。值完全一样，只是露脸的时机不同。 */
    if (spec.params.when === 'live') {
      const live = collectEndOutputs(spec)
      const liveNames = Object.keys(live)
      emit({
        kind: 'log', nodeId: id,
        line: liveNames.length === 0
          ? 'ⓘ 收口（没有声明「交出哪些值」）'
          : 'ⓘ 产出（现在就显示）：' + liveNames.map(n => n + '=' + JSON.stringify(live[n] ?? null)).join('、'),
      })
    } else {
      emit({ kind: 'log', nodeId: id, line: 'ⓘ 收口（产出按「交出哪些值」的声明取，跑完后统一收）' })
    }
    if (through !== undefined) {
      outputs.set(id, through)
      ctx.local?.set(id, through)
    }
    emit({ kind: 'success', nodeId: id, output: through })
  }

  /**
   * 跑一个「跑另一份工作流」节点：按名字把另一份存档整份跑一遍。
   *
   * ## 为什么它不进 `NODE_IMPLS`
   *
   * 与 `runLoop` 同一个理由：它不是「派发一个节点」那类东西 ——
   * 它要的是「**再跑一遍调度器**」，而派发器那一层拿不到调度器。
   * 所以它由调度器自己解释执行（照 `flow.loop` 的先例）。
   *
   * ## 三个必须做对的地方
   *
   * 1. **不传上游数据** —— 子工作流从它自己的起点跑。上游那条线只表示「接在谁后面」
   *    （bat 的 `call` 也是这个语义：纯顺序，两份之间没有数据流）。
   * 2. **深度上限** —— `A 调 B、B 调 A` 会一直转下去，必须明确拦下并说清原因。
   * 3. **失败要抛** —— 抛出去由 `runSeq` 按本节点的失败策略决定停还是继续；
   *    这样「子工作流失败」与「普通节点失败」在下游看来完全一样，不必特判。
   *
   * @param id - 节点实例 id。
   * @param ctx - 当前层现场。
   */
  /**
   * 把「喂给子工作流」的输入从节点参数里读出来。
   *
   * 参数形状：一行一项的文本清单（`kind: 'list'`），格式 `名字 = 值`；
   * 值里可以写 `{{变量}}`（走与普通节点**同一个**替换器，所以能引用上游字段、
   * 也能引用这份工作流自己的输入）。只写一个名字（没有 `=`）时，
   * 取**同名变量**的值。
   *
   * ⚠️ **参数为空时返回空对象**，由调用方退回「原样透传本层输入」——
   * 这个函数不猜那个回退，两件事分开写才不会互相干扰。
   *
   * @param raw - 节点参数 `inputs` 的原值。
   * @param scope - 变量取值来源（上游字段 + 本层输入）。
   * @returns 字段名 → 值。
   */
  const readGivenInputs = (
    forNode: string,
    raw: unknown,
    scope: VariableScope,
  ): Record<string, unknown> => {
    const lines = parseAssignments(raw)
    const out: Record<string, unknown> = {}
    for (const f of lines) {
      /* 没写值 → 取同名变量（`f.name`）—— 这让「原样透传某个字段」写成一行名字就够。 */
      const rawVal = f.value
      if (rawVal === undefined) {
        const direct = scope.fields?.[f.name]
        if (direct !== undefined) out[f.name] = direct
        continue
      }
      /* 值里可能有 `{{变量}}` → 走共用的替换器（只替换这一条）。
       * 替换后仍是字符串是**正常的**（命令体最终要发给子流程，
       * 而子流程那边按声明合并，类型由它决定）。 */
      const sub = substituteDeep(rawVal, scope)
      if (sub.missing.length > 0) {
        emit({
          kind: 'log', nodeId: forNode,
          line: '⚠ 传给子工作流的「' + f.name + '」里有没找到的变量：' + sub.missing.join('、'),
        })
      }
      out[f.name] = sub.value
    }
    return out
  }

  const runSubWorkflow = async (id: string, ctx: RunScope): Promise<void> => {
    const spec = byId.get(id)
    if (spec === undefined) return

    /* 可达性：与 `runNode` 同一条判据（循环节点没端口所以用不上，这个节点有端口）。
     * 少了这一段，挂在「没走的那条分支」上的子工作流**照跑**——
     * 症状是「条件明明没成立，子流程却跑了」，很难查。 */
    if (!hasLiveInput(id, ctx) && hasAnyInput(id) && ctx.heads?.has(id) !== true) {
      if (ctx.local === undefined) unreachable.add(id)
      else ctx.unreachable?.add(id)
      emit({ kind: 'log', nodeId: id, line: '⏭ 未走的分支，跳过（上游那条路这次没走）' })
      emit({ kind: 'skipped', nodeId: id })
      return
    }

    /* 被用户标为「跳过」：与普通节点一致 —— 不执行，上游原样传给下游。 */
    if (spec.skipped) {
      emit({ kind: 'log', nodeId: id, line: '⏭ 已跳过（不执行，上游数据原样传给下游）' })
      const through = passthroughOf(upstreamOf(id, ctx))
      if (through !== undefined) {
        outputs.set(id, through)
        ctx.local?.set(id, through)
      }
      emit({ kind: 'skipped', nodeId: id })
      return
    }

    noteRan(id)
    emit({ kind: 'started', nodeId: id, label: spec.def.label, executor: spec.def.executor, defId: spec.def.id, ...spec.label === undefined ? {} : { nodeLabel: spec.label } })

    /* ── 读「跑哪一份」（2026-10-19 改成编号优先）─────────────────────
     *
     * ## 两种写法都认，顺序不能说反
     *
     *   ① `params.workflowId` —— 新写法，**生效的是它**。编号永不变，
     *      所以子工作流改名之后这里照样跟着走。
     *   ② `params.name` —— 老写法（存档里还是名字）。只有在①**为空**时才用。
     *
     * ⚠️ **不能反过来「有名字就用名字」**：那样一份已经迁过编号的节点，
     * 只要还留着 `name`（缓存/手改），改名的那个 bug 就又回来了。
     * `migrateWorkflowRefs` 会顺手删掉 `name`，这条顺序是它的保险。
     */
    const refId = String(spec.params.workflowId ?? '').trim()
    const legacyName = String(spec.params.name ?? '').trim()
    const ref: SubWorkflowRef = refId !== '' ? { id: refId } : { name: legacyName }
    /* 日志与报错里给人看的那个 —— 老写法下是名字，新写法下先给编号，
     * 真名由 `run` 那侧解析完再补一条日志（画布/宿主半都看得到）。 */
    const shownRef = refId !== '' ? refId : legacyName
    if (shownRef === '') {
      const msg = '没填要跑哪份工作流（在节点设置里选一份）'
      emit({ kind: 'log', nodeId: id, line: '✕ ' + msg })
      emit({ kind: 'failed', nodeId: id, error: msg })
      failedEmitted.add(id)
      throw new Error(msg)
    }

    /* 套娃保护：递归层数到顶就明确报错，别一直转下去。 */
    if (depth >= MAX_SUB_DEPTH) {
      const msg = '子工作流嵌套太深（第 ' + String(depth + 1) + ' 层，上限 ' + String(MAX_SUB_DEPTH)
        + ' 层）：' + shownRef + '。是不是有工作流互相调用了？'
      emit({ kind: 'log', nodeId: id, line: '✕ ' + msg })
      emit({ kind: 'failed', nodeId: id, error: msg })
      failedEmitted.add(id)
      throw new Error(msg)
    }

    const run = input.runWorkflow
    if (run === undefined) {
      /* 不传这个能力 = 这次运行的入口不支持子工作流（比如画布没接宿主半）。
       * **明说**，不要静默跳过 —— 静默跳过会让人以为「跑过了、只是没效果」。 */
      const msg = '这次运行没法跑子工作流（入口没提供「跑另一份工作流」的能力）'
      emit({ kind: 'log', nodeId: id, line: '✕ ' + msg })
      emit({ kind: 'failed', nodeId: id, error: msg })
      failedEmitted.add(id)
      throw new Error(msg)
    }

    /* 喂给子工作流的输入（2026-10-17）。
     *
     * ## 两种写法都认（这是「谁说了算」的问题，必须定死）
     *
     *   ① 节点参数 `inputs` 里手填了字段（`名字 = 值` 一行一项）→ **用它**，
     *      值里可以写 `{{变量}}`（走与普通节点同一个替换器，所以能引用上游、
     *      也能引用这份工作流自己的输入）；
     *   ② 没填 → 把**本层这次拿到的输入原样带下去**（`resolvedInputs`）。
     *
     * ⚠️ 为什么 ② 要有：组合层（「一键下载」这种只按顺序调别人的工作流）
     * **自己不产生数据**，它的作用就是把外面喂进来的参数透下去。少了这条，
     * 组合层就永远只能调用那些「不需要输入」的子流程。
     *
     * ⚠️ 为什么 ① 优先：手填的是**明确的映射**（可以用 `{{变量}}` 换名字、
     * 换来源），比「原样透传」精确。这与循环那边「参数优先、没填才用入边」
     * 是同一条纪律（实测打回来过，见 runLoop 那段）。
     *
     * 注：**不校验子流程声明了哪些字段** —— 多给的由子流程自己的
     * `resolveInputs` 丢掉（它只认自己声明的）。父流程这里看不到子流程的存档
     * （那在宿主半手上），所以校验放在子流程那一侧，只有一处。 */
    /* ⚠️ **没填就原样透传本层输入**（这个回退必须在这里，不能在 readGivenInputs 里 ——
     * 那个函数分不清「用户写了空清单」与「参数根本没配」，而这两者的后果完全不同：
     * 前者是「我明确不想传任何输入」，后者是「我没配，请把外面给的透下去」）。
     *
     * 组合层（「一键下载」这类只按顺序调别人的工作流）靠这条把参数传下去 ——
     * 少了它，组合层就永远只能调用那些「不需要输入」的子流程。 */
    const filled = readGivenInputs(id, spec.params.inputs, {
      /* 与 `runNode` 同一套（`loopVarFields`）：嵌在循环里时，传给子工作流的
       * 参数也能写 `{{item}}` / `{{outer.item}}`。顶层时它返回 `{}`，行为不变。 */
      fields: { ...resolvedInputs, ...loopVarFields(ctx) },
    })
    /* ★ 保留键**永远跟着往下走**（2026-10-23，`__model` 继承靠这一行）。
     *
     * 为什么不能只靠上面那个 `{ ...resolvedInputs }` 回退：**用户手填了输入项**时
     * 走的是 `filled` 那条路，它只有用户写的那几项 —— 保留键会丢，
     * 于是「父流程选了模型、子流程没选」在这类工作流上就断链了。
     * 所以单独合一次：手填的在上、保留键在下（手填写不出 `__` 开头的键，
     * 因为 `parseAssignments` 收的是用户文本，而真写了也会被这里覆盖成运行上下文的真值）。 */
    const given = { ...(Object.keys(filled).length > 0 ? filled : { ...resolvedInputs }), ...reservedKeysOf(resolvedInputs) }

    emit({ kind: 'log', nodeId: id, line: '【' + spec.def.label + '】开始跑「' + shownRef + '」（第 ' + String(depth + 1) + ' 层）' })
    /* 日志只列**普通键**：`__model` 不是用户输入，报出来会让人以为要自己填。 */
    const givenNames = Object.keys(withoutReservedKeys(given))
    if (givenNames.length > 0) {
      emit({ kind: 'log', nodeId: id, line: 'ⓘ 传给它的输入：' + givenNames.join('、') })
    }

    executions += 1
    const res = await run(ref, signal, given)

    if (signal?.aborted === true) return

    if (res.ok) {
      /* 子工作流不产出数据（它自己从起点跑），所以输出只是一个**信号**。
       * 为什么要给一个非 undefined 的值：下游若用 passthrough 之类的语义
       * 拿到 undefined 会被当成「没跑」。 */
      const out = { workflow: shownRef, ok: true, ran: res.ran ?? [] }
      emit({ kind: 'log', nodeId: id, line: '✓「' + shownRef + '」跑完了（' + String((res.ran ?? []).length) + ' 个节点）' })
      /* ★ 主动报一条（票 30 乙，2026-10-27）——
       * 与「跑另一份工作流」这类节点有关的记录原先**一句话都没有**，
       * 于是「0一键更新 / 全部下载」这种只由子工作流串起来的工作流
       * 跑成功了也不写任务记录（`records.ts` 那条「成功 + 无产出声明 + 无汇报 → 不写」）。
       *
       * 报三样：哪一份、跑了几个节点、成没成。
       * ⚠️ 名字那一格用的是 `shownRef`（节点参数里的引用：新写法是编号、老存档是名字），
       * **不是**宿主半解析出来的文件名 —— `SubWorkflowFn` 的返回值里没有它，
       * 而拿它要改 `run-file.ts`（不在本单可改路径内）。这一格与上面那行日志、
       * 与写进 `outputs.workflow` 的值是**同一个**，三处说法一致。 */
      emit({
        kind: 'report', nodeId: id,
        entry: {
          message: '跑完子工作流「' + shownRef + '」：' + String((res.ran ?? []).length) + ' 个节点，成功',
          type: 'info',
          location: 'ndv',
          metrics: { nodes: (res.ran ?? []).length },
        },
      })
      outputs.set(id, out)
      ctx.local?.set(id, out)
      emit({ kind: 'success', nodeId: id, output: out })
      return
    }

    const msg = '子工作流「' + shownRef + '」失败：' + (res.error ?? '没说原因')
    emit({ kind: 'log', nodeId: id, line: '✕ ' + msg })
    /* 失败也报一条（纪律 3：最需要看汇报的恰恰是失败那一次）。
     * 放在 `failed` 之前发 —— 与 `runNode` 里那段「汇报在成功 / 失败分叉之前」同一个顺序。 */
    emit({
      kind: 'report', nodeId: id,
      entry: { message: msg, type: 'danger', location: 'ndv' },
    })
    emit({ kind: 'failed', nodeId: id, error: msg })
    failedEmitted.add(id)
    throw new Error(msg)
  }

  /**
   * 跑一个「等待」节点：把**整个运行现场**存下来，然后停下。
   *
   * ## 为什么它由调度器解释执行（不进 `NODE_IMPLS`）
   *
   * 与循环 / 子工作流同一个理由：它要的东西**只有调度器有** ——
   * 「这次跑到哪了、每个节点输出什么、谁被判过不可达」。
   * 一个普通的 builtin 函数只看得到自己的参数与上游，存不出「现场」。
   *
   * ## 照两家的哪一半
   *
   * | | 做法 | 我们取的 |
   * | --- | --- | --- |
   * | **n8n Wait** | 挂起时把执行数据写进 DB，恢复时**重新载入**整份执行数据 | 存现场 + 重新载入（形状见 `snapshot.ts`） |
   * | **Dify human_input** | 存运行现场，表单提交后沿 action 边继续 | 只借「从挂起点继续」，**不做**那套表单引擎 |
   *
   * 三种恢复方式（2026-10-22 补齐第三种「等人点继续」）：
   *   · 等一段时长 / 等到某个时刻 —— 由扫盘器到点自动恢复；
   *   · 等人点继续 —— 落到「永不到点」的 `resumeAtMs`，扫盘器天然跳过，
   *     只能由 `POST /workflow/resume` 手工触发（见 `snapshot.ts` 的
   *     `WAIT_MANUAL_FOREVER_MS`）。可设超时：到点被扫盘器捡起，恢复入口判失败。
   *
   * ## 三条必须做对的地方
   *
   * 1. **上游原样穿下去** —— 等待不该改变数据流（与「延迟」「跳过」同一语义）。
   *    所以恢复后下游照样能拿到它上游的值，不必为等待节点特意连线。
   * 2. **挂起 = 抛 `RunPausedError`，不是返回** —— 见那个类的说明（任意深度都要停住）。
   * 3. **现场存不下就报失败**，不要假装挂起 —— 那样用户会等一个永远不会来的恢复。
   *
   * @param id - 节点实例 id。
   * @param ctx - 当前层现场。
   */
  const runWait = async (id: string, ctx: RunScope, opts?: { alert?: boolean }): Promise<void> => {
    const spec = byId.get(id)
    if (spec === undefined) return

    /* 可达性 / 跳过：与普通节点同一条判据（等待节点有端口，所以两条都要走）。 */
    if (!hasLiveInput(id, ctx) && hasAnyInput(id) && ctx.heads?.has(id) !== true) {
      if (ctx.local === undefined) unreachable.add(id)
      else ctx.unreachable?.add(id)
      emit({ kind: 'log', nodeId: id, line: '⏭ 未走的分支，跳过（上游那条路这次没走）' })
      emit({ kind: 'skipped', nodeId: id })
      return
    }
    if (spec.skipped) {
      emit({ kind: 'log', nodeId: id, line: '⏭ 已跳过（不执行，上游数据原样传给下游）' })
      const through = passthroughOf(upstreamOf(id, ctx))
      if (through !== undefined) {
        outputs.set(id, through)
        ctx.local?.set(id, through)
      }
      emit({ kind: 'skipped', nodeId: id })
      return
    }

    /* ── ⓪ 循环体里**不许**放等待 ─────────────────────────────────
     *
     * 现场里记的是「从哪个节点之后继续」，而恢复时是按**主序**切片的
     * （`mainOrder.indexOf`）—— 循环体的节点不在主序里，切片会落空，
     * 结果是「恢复 = 整份从头跑」，而那会**再挂一次**，永远跑不完。
     *
     * 与其静默地那样，不如当场明确报错：说清是配置不支持，不是出了故障。
     * 真要「循环里等一会儿」用「延迟」节点（它不跨运行）。 */
    if (loopOwned.has(id)) {
      /* ⚠️ 用 `spec.def.label` 而不是写死「等待」：`flow.alert-wait` 也走这条拦，
       * 而它叫「Windows 通知与等待」—— 写死会让用户对着一个不存在的节点名找。
       * 「延迟」那句不用换：那是建议用的节点，与自报家门无关。 */
      const msg = '「' + spec.def.label + '」节点不能放在循环里（循环体的恢复本版本还不支持）：' + id
        + '。循环体内如需等待，请使用「延迟」节点。'
      emit({ kind: 'log', nodeId: id, line: '✕ ' + msg })
      emit({ kind: 'failed', nodeId: id, error: msg })
      failedEmitted.add(id)
      throw new Error(msg)
    }

    noteRan(id)
    emit({ kind: 'started', nodeId: id, label: spec.def.label, executor: spec.def.executor, defId: spec.def.id, ...spec.label === undefined ? {} : { nodeLabel: spec.label } })

    /* ── ① 上游原样穿下去（与「跳过」「延迟」同一语义）─────────────────
     *
     * 为什么先写输出再挂起：恢复之后下游要读它这一路的值。
     * 不写的话「等待」会变成「断链」—— 用户会看到恢复后第一个节点拿不到输入。
     *
     * ★ **`flow.alert-wait` 要先发通知**（`opts.alert`）：通知必须在挂起前发出，
     * 否则人根本不知道要去点继续。发完再把「上游 + `__alert`」写进输出。 */
    const upstreamForWait = upstreamOf(id, ctx)
    if (opts?.alert === true) {
      const alert = await notifyForAlertWait(id, ctx, upstreamForWait)
      const out = alertWrap(upstreamForWait, alert)
      outputs.set(id, out)
      ctx.local?.set(id, out)
    } else {
      const through = passthroughOf(upstreamForWait)
      if (through !== undefined) {
        outputs.set(id, through)
        ctx.local?.set(id, through)
      }
    }

    /* ── ② 算「等什么、什么时候继续」──────────────────────────────── */
    const read = readWaitPlan(spec.params, Date.now())
    /* ⚠️ 判据用 `plan === undefined` 而不是 `!read.ok`：本项目 tsconfig 的
     * `strict` 是关的（`strictNullChecks` 也跟着关），那种模式下
     * TypeScript **不会**按 `ok` 这个布尔字面量收窄联合类型 ——
     * 写成 `!read.ok` 之后取 `read.error` 会报「属性不存在」。
     * 判 `plan` 有没有反而是最强的判据（成功时一定有它）。 */
    if (read.plan === undefined) {
      /* 参数不完整 / 写错 / 超过上限 → **当节点失败报出去**（不是静默等 0 秒）。
       * 抛错后由 `runSeq` 的 catch 按本节点的 `onError` 决定停还是继续 ——
       * 与其它节点的失败完全同一条路，下游不必特判。 */
      const msg = read.error
      emit({ kind: 'log', nodeId: id, line: '✕ ' + msg })
      emit({ kind: 'failed', nodeId: id, error: msg })
      failedEmitted.add(id)
      throw new Error(msg)
    }
    const plan: WaitPlan = read.plan

    /* ── ③ 组现场 ───────────────────────────────────────────────────
     *
     * ⚠️ **`undefined` 要被跳过**：`JSON.stringify` 会把值为 undefined 的键删掉，
     * 恢复后它们等于「没跑过」。这与 `upstreamOf` 里「过滤掉没值的上游」同一条语义，
     * 所以行为一致；但**在存之前显式跳过**能避免「存之前有、恢复后没有」这种错觉。 */
    const dump: Record<string, unknown> = {}
    for (const [nodeId, value] of outputs) {
      if (value === undefined) continue
      dump[nodeId] = value
    }
    const snap: RunSnapshot = {
      version: 1,
      runId: options.runId ?? ('run-' + String(Date.now()) + '-' + Math.random().toString(36).slice(2, 6)),
      workflowId: workflowId === '' ? '(未命名)' : workflowId,
      startedAt: options.startedAt ?? Date.now(),
      pausedAt: Date.now(),
      resumeAfter: id,
      ran: [...ran],
      executions,
      outputs: dump,
      unreachable: [...unreachable],
      inputs: resolvedInputs,
      wait: plan,
      /* 工作流的执行指纹（票 17）：恢复时拿它判断「这份档后来改过没有」。
       * 调用方没给就不写这个键（老现场与画布那条路都是这样）。 */
      ...input.fingerprint === undefined ? {} : { fingerprint: input.fingerprint },
    }
    pauseSnapshot = snap

    const how = plan.mode === 'manual'
      ? (plan.timeoutAtMs === undefined
        ? '等人点「继续」（不限超时）'
        : '等人点「继续」（最多等 ' + String(plan.timeoutHours ?? 0) + ' 小时，到点按失败结束）')
      : plan.mode === 'until'
        ? '等到 ' + String(plan.until ?? '') + '（约 ' + String(Math.round(plan.ms / 60000)) + ' 分钟后）'
        : '等 ' + String(Math.round(plan.ms / 1000)) + ' 秒后'
    emit({
      kind: 'log', nodeId: id,
      line: '⏸ 挂起：' + how + '继续。现场已存（运行 id ' + snap.runId + '）',
    })

    /* ── ④ 停下 ────────────────────────────────────────────────────
     *
     * ⚠️ **必须是异常**：返回的话 `runSeq` 会以为「这个节点跑完了」，
     * 于是后面的节点**照常往下跑** —— 那正是「暂停没停住」这个坏行为。
     * `runSeq` 的 catch 第一行就认它，所以不会被记成失败。 */
    throw new RunPausedError(snap)
  }

  /**
   * 跑一个「Windows 通知与等待」节点（`flow.alert-wait`，票 07 第一轮）。
   *
   * ## 它比 `runWait` 多什么
   *
   * 前半段：先发一条通知。后半段：四种模式里只有三种要挂起，`none` 直接往下走。
   *
   * ## 为什么发通知要**派发一次**、而不是自己在引擎里弹
   *
   * 「发不发、按级别过不过门槛、为什么没发」那套规则住在
   * `src/nodes/flow/notify/impl.ts`（`decideNotify` + 四种原因四种文案）。
   * 引擎里再写一遍必然与它漂 —— 而用户对「为什么没收到提醒」已经有四种不同处置。
   * 所以这里把 `flow.alert-wait` 的参数原样交给 `flow.notify` 的实现跑一次，
   * **只借它算结论**（`notified` / `level` / `reason`）。
   *
   * ## 发通知失败**不算这个节点失败**（这条是 `onError` 那个矛盾的解法）
   *
   * 一个节点的 `onError` 只有一个值，而这里有两个意图：
   *   · 通知发不出去 → 附带动作失败，流程该照走；
   *   · 等人超时 → 业务失败，要走失败分支。
   *
   * 解法：**把「发通知失败」在这一层吞掉**（记一行日志、把结果照常放进输出），
   * 只有「等人超时」才抛出去交给失败策略。于是 `onError: 'continueErrorOutput'`
   * 可以安全地设成默认值 —— 它只对「超时」这一个意图生效。
   *
   * ## `mode: 'none'` 走的是**普通节点**那条路
   *
   * 不挂起时它就是个普通节点（发通知 + 把上游原样带下去），所以直接交给 `runNode`。
   * 那也顺带让「填 `ms: 0`」与 `mode: 'none'` 行为一致 —— 两者都不挂起
   * （计划里那条 C7 要求「同一个意图不能有两种行为」）。
   *
   * @param id - 节点实例 id。
   * @param ctx - 当前层现场。
   */
  const runAlertWait = async (id: string, ctx: RunScope): Promise<void> => {
    const spec = byId.get(id)
    if (spec === undefined) return
    /* 只有 `none` 不挂起（`ms: 0` 也归这一档）—— 其余三种交给 `runWait` 那一套，
     * 因为它们要的是同一件事：算计划、组现场、抛 `RunPausedError`。
     * 发通知由 `runWait` 里的 `beforePause` 钩子做，顺序才是「started → 通知 → 挂起」。 */
    const mode = spec.params.mode
    const ms = spec.params.ms
    const stays = mode === 'duration' && typeof ms === 'number' && Number.isFinite(ms) && ms <= 0
    if (mode === 'none' || stays) {
      /* 不挂起：当普通节点跑。`runNode` 内部认这个节点 id，
       * 会把「派发 `flow.notify` 的实现」与「输出包成上游 + __alert」两步做掉，
       * 且发通知失败同样吞掉、不算这个节点失败。 */
      await runNode(id, ctx)
      return
    }
    /* 要挂起的那三种：先发通知，再存现场停下。 */
    await runWait(id, ctx, { alert: true })
  }

  /**
   * 给 `flow.alert-wait` 发一条通知，返回这次通知的结果。
   *
   * ⚠️ 失败**不抛**：通知是附带动作，发不出去不该让这个节点失败
   * （否则 `onError: 'continueErrorOutput'` 会把下游带到失败分支上，
   * 而用户只是没收到一条提醒，业务并没有失败）。
   *
   * @param id - 节点实例 id。
   * @param ctx - 当前层现场。
   * @param upstream - 上游输出（调用方已经取过，不再算一遍）。
   * @returns 通知结果（一定有值，失败时 `notified` 为假、`reason` 写清原因）。
   */
  const notifyForAlertWait = async (id: string, ctx: RunScope, upstream: readonly unknown[]): Promise<unknown> => {
    const spec = byId.get(id)
    if (spec === undefined) return {}
    /* 发通知**复用 `flow.notify` 的实现**（见 `runAlertWait` 函数头的说明）。 */
    let alert: Record<string, unknown> = { notified: false, level: String(spec.params.level ?? 'notice'), reason: '没有发出（原因见日志）' }
    try {
      const outcome = await dispatch({
        runId: 'run-' + id + '-alert-' + String(Date.now()),
        nodeId: id,
        executor: 'builtin',
        /* 命令体里的 `node` 必须是 `flow.notify`：执行方按它查实现表。
         * 参数原样照抄（content / level / system 三个键的名字两边一致）。 */
        command: {
          node: NOTIFY_DEF_ID,
          params: {
            content: spec.params.content,
            level: spec.params.level,
            system: spec.params.system,
          },
        },
        context: { workflowId, upstream: [...upstream], workdir, ...input.env === undefined ? {} : { env: input.env } },
      }, signal)
      for (const line of outcome.logs ?? []) emit({ kind: 'log', nodeId: id, line })
      if (outcome.ok && outcome.status === 'success' && outcome.output !== null && typeof outcome.output === 'object') {
        alert = outcome.output as Record<string, unknown>
        emit({
          kind: 'log', nodeId: id,
          line: alert.notified === true ? '✓ 通知已发出' : 'ⓘ 通知没发：' + String(alert.reason ?? ''),
        })
      } else {
        const why = String(outcome.error ?? '没说原因')
        alert = { notified: false, level: String(spec.params.level ?? 'notice'), reason: '发送失败：' + why }
        /* ⚠️ **吞掉**：通知发不出去不走失败分支（见函数头）。 */
        emit({ kind: 'log', nodeId: id, line: '⚠ 通知发送失败（不影响流程继续）：' + why })
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      alert = { notified: false, level: String(spec.params.level ?? 'notice'), reason: '发送失败：' + why }
      emit({ kind: 'log', nodeId: id, line: '⚠ 通知发送失败（不影响流程继续）：' + why })
    }
    return alert
  }

  /**
   * 按顺序跑一串节点（可递归：循环体走的就是本函数）。
   *
   * @param ids - 要跑的节点 id（已排好序）。
   * @param ctx - 当前层现场。
   */
  const runSeq = async (ids: readonly string[], ctx: RunScope): Promise<void> => {
    for (const id of ids) {
      if (signal?.aborted === true) break
      try {
        /* **五类**节点不派发，由调度器解释执行（它们不是「派发一个节点」那类东西）：
         *   - 循环：把循环体重复 N 轮
         *   - 并行：把框内成员切成几路并发跑，再按顺序收口
         *   - 跑另一份工作流：再跑一遍调度器
         *   - 开始：把解析好的输入发下去（**不派发** —— 它没有执行方，
         *     值是调度器在跑之前就算好的，见上面 `resolvedInputs`）
         *   - 结束：收口（**不派发** —— 它的产出在所有节点跑完后统一取）
         *
         * ⚠️ 开始 / 结束**没有对应的 `NODE_IMPLS`**：它们天生由调度器解释，
         * 放进实现表反而会被当普通 builtin 去派发（找不到实现就报错）。 */
        if (byId.get(id)?.def.id === LOOP_DEF_ID) await runLoop(id, ctx)
        else if (byId.get(id)?.def.id === PARALLEL_DEF_ID) await runParallel(id, ctx)
        else if (byId.get(id)?.def.id === WORKFLOW_DEF_ID) await runSubWorkflow(id, ctx)
        else if (byId.get(id)?.def.id === WAIT_DEF_ID) await runWait(id, ctx)
        /* ★ 「Windows 通知与等待」（票 07）：四种模式里三种要挂起，一种当普通节点跑。
         * 分支放在 `runNode` 之前 —— 否则挂起那三种会被当普通 builtin 派发，
         * 而它在实现表里没有对应函数。 */
        else if (byId.get(id)?.def.id === ALERT_WAIT_DEF_ID) await runAlertWait(id, ctx)
        else if (byId.get(id)?.def.id === START_DEF_ID) await runStart(id, ctx)
        else if (byId.get(id)?.def.id === END_DEF_ID) await runEnd(id, ctx)
        else await runNode(id, ctx)
      } catch (e) {
        /* ★ **挂起不是失败** —— 必须排在失败策略之前认掉（计划 Step 12 的红线：
         * 运行历史里标「等待中」而不是「失败」）。
         *
         * 认掉之后**原样再抛**：一路穿到 `runGraph` 外面，由调用方落盘。
         * 在这里「吞掉并继续」就会变成「暂停没停住」，那是最坏的坏行为。 */
        if (e instanceof RunPausedError) throw e
        /* 失败怎么办**由节点自己定**：
         *   stop     = 中断整条（后面的不跑）
         *   continue = 往下走（下游拿不到这个值）
         *
         * ⚠️ 这里**必须把失败原因记下来**（`failed` 事件在 runNode 里已发过，
         * 但那是节点级；下面这条是「整条因此中断」这件事本身）。
         * 2026-10-11 踩到：没有这条日志时，只看到 `aborted:true` 而不知道
         * 是谁失败的、为什么 —— 排查时全靠猜。 */
        const err = e instanceof Error ? e.message : String(e)
        const policy = byId.get(id)?.onError ?? 'stop'
        if (policy === 'stop') {
          /* ⚠️ `failed` 事件**可能已经发过了**：
           *   - `runNode` 失败时它自己发（`outcome.error` 那条路）；
           *   - `runLoop` 的**常见**错误（空体、嵌套）也自己发。
           * 所以这里只补「**还没说过原因**」的情形 —— 判据是「这一轮该节点还没发过 failed」。
           * 2026-10-13 实测到的缺口：循环里 `iterationItems` 抛的错（没选数据来源 /
           * 选到的不是列表）**从没被说过**，界面上只有「按停止流程中断」，
           * 用户看不到原因。那时事件序列是 queued → log → aborted，**没有 failed**。 */
          if (!failedEmitted.has(id)) {
            emit({ kind: 'log', nodeId: id, line: '✕ ' + err })
            emit({ kind: 'failed', nodeId: id, error: err })
          }
          emit({ kind: 'log', nodeId: id, line: '按「停止流程」中断后面的节点' })
          emit({ kind: 'aborted', nodeId: id })
          aborted = true
          /* ★ 把「为什么中断」记到整次运行那一层（契约 AH）。
           *
           * 上面那两条 `log` / `failed` 是**节点级**的（进 `RunNodeLine.error`、
           * 进日志面板）；这里记的是**整次运行级**的汇总原因 ——
           * 板块记录（`collect/`）只记整次运行、不记节点，没有这一格它就只剩
           * `ok: false` 一个布尔值，用户看得到「没跑成」、看不到原因。
           *
           * `??=` 语义：**第一个**失败才算。见 `firstFailureError` 的说明。 */
          if (firstFailureError === undefined) firstFailureError = err
          throw e instanceof Error ? e : new Error(err)
        }
        /* ── 其余两档（`continue` / `continueErrorOutput`）都不中断整条 ──
         *
         * ⚠️ 这里**必须写 `else if`**，不能靠「不是 stop 就继续」兜住两档：
         * 两档的后果完全不同（见下面那段），兜成一档就是「选了走失败分支、
         * 实际按继续办」—— 那正是契约 AI 要修的病。
         * 也**不能写 `return`**：本 catch 在 `for` 里，`return` 会把整个 `runSeq`
         * 结束掉（后面还没跑的节点全被跳过），看着像「后面没跑」但没有任何交代。 */
        if (policy === 'continueErrorOutput') {
          /* ── 走失败分支（契约 AI）─────────────────────────────────────
           *
           * ## 与 n8n 的对照
           *
           * n8n 在节点**正常返回数据、但数据项里带 `error`** 时按 item 分流
           * （`refs-projects/n8n/packages/core/src/execution-engine/workflow-execute.ts:3027-3133`
           * 的 `handleNodeErrorOutput`），失败出口是**追加在正常出口之后**、
           * 靠位置索引区分。
           *
           * 我们这套模型有两处结构性不同，各自怎么处理：
           *
           * | | n8n | 我们 | 怎么处理 |
           * | --- | --- | --- | --- |
           * | 出口识别 | 位置索引（最后一个 outlet） | 命名 handle（`sourceHandle`） | **照它的语义**、用命名：输出带 `__handle: '__error'` |
           * | 数据形状 | item 数组，可 item 级分流 | 输出是**单个值**（`unknown`） | **必须不同**：只做节点级分流，不做 item 级 |
           * | 失败判定 | 数据项带 `item.error` | 节点**抛错**（就是本 catch） | 照我们的：抛错即整节点失败 |
           *
           * 出口「真实存在于定义里」那一半在 `specs.ts` 的 `withErrorOutput` ——
           * 不补那一步，`liveHandles` 会把 `__error` 判成不认识的出口（返回 `null`
           * = 全部出口都活），两条分支都跑。
           *
           * ## 三条纪律
           *
           * ① **不中断整条**（与 `continue` 一样）：`aborted` 保持假。
           * ② **输出写一个带出口标记的对象** —— `liveHandles` 于是返回 `['__error']`，
           *    接在红出口上的边活、接在正常出口上的边死。
           * ③ **`failed` 事件照发**（若还没发过）：不中断不等于「没失败」，
           *    界面与运行记录里那个红叉必须留着 —— 那是给用户查的线索。
           *
           * ## 与 `continue` 的区别（两档不能混）
           *
           * · `continue` → 输出是**空值**（下游拿不到东西），**出口全活**；
           * · 本档 → 输出是**带 `__error` 标记的对象**（下游拿得到失败原因），
           *   **只有红出口活**。 */
          const handles = { [BRANCH_KEY]: ERROR_HANDLE, error: err }
          if (!failedEmitted.has(id)) {
            emit({ kind: 'log', nodeId: id, line: '✕ ' + err })
            emit({ kind: 'failed', nodeId: id, error: err })
            failedEmitted.add(id)
          }
          emit({ kind: 'log', nodeId: id, line: '按「走失败分支」继续（下游只有失败出口那条路是活的）' })
          /* 输出同时进两处（与成功那条路一致：`outputs` 给下游 / 跨层读，`ctx.local` 给本层）。
           * ⚠️ 是**覆盖**：这个节点这次失败了，正常产出不存在 ——
           * 留上一次的值会让下游读到一份「其实没成功」的数据。 */
          outputs.set(id, handles)
          ctx.local?.set(id, handles)
          if (ctx.failures !== undefined) ctx.failures.count += 1
        } else {
          /* ── 继续（`continue`）：输出留空，出口全活 ─────────────────────
           *
           * 与上一档的区别见那段注释。这里**不动 `outputs`** ——
           * 下游取不到这个节点的值（`continue` 的既有语义，一个字不改）。 */
          emit({ kind: 'log', nodeId: id, line: '按「继续」策略往下走（下游拿不到这个节点的值）' })
          /* ★ 记一笔「本轮有节点失败了」（2026-10-19，循环的连续失败跳出用）。
           *
           * 为什么在这里记而不是在 `runNode` 里：**四类节点**都可能失败
           * （普通节点 / 循环 / 子工作流），而它们全都经过这个 catch。
           * 记在 `runNode` 里会漏掉「循环失败了」「子工作流失败了」两种。
           *
           * ⚠️ 只记这两条「不中断」的路：`stop` 那条已经 `throw` 出去了，
           * 循环那边会按失败策略整条中断，不需要再数「连续几次」。 */
          if (ctx.failures !== undefined) ctx.failures.count += 1
          void err
        }
      }
    }
  }

  /* ── 跑主序 ──────────────────────────────────────────────────────
   *
   * ★ **挂起要单独认**（2026-10-21，计划 Step 12）：
   * `runSeq` 里遇到 `flow.wait` 会抛 `RunPausedError`，这里必须把它与
   * 「节点失败」分开处理 —— 混在一起的话挂起会被当成失败，用户看到红叉，
   * 而计划的红线明确要求「运行历史里标等待中而不是失败」。
   *
   * 挂起时**照常返回结果**（`ok` 为真、`aborted` 为假），只是多带一个 `paused`。
   * 为什么不直接在这里抛给调用方：调用方要的东西一样多（跑了哪些、输出什么、
   * 现场是什么），包在返回值里它一次就能拿全，不必 try/catch 两遍。 */
  let pausedAtEnd: RunSnapshot | null = null
  try {
    await runSeq(order, {})
  } catch (e) {
    if (e instanceof RunPausedError) {
      pausedAtEnd = e.snapshot
    }
    /* 其余异常照旧吞掉：失败事件已经在 `runSeq` 里记过了，
     * 这里只需停止往下跑（与改动前逐字一致）。 */
  }

  /* 「等人点继续」超时了 → 按**这个节点的失败策略**收尾（票 07 改，此前一律 `aborted = true`）。
   *
   * 为什么在这里收而不是抛异常：异常会被上面那个 catch 吞成「什么都不做」，
   * 调用方只看得到 `ok: true` + 没有产出 —— 又是一次「不报错的失败」。
   *
   * ## 两档，判据是 `manualLocalContinue`
   *
   * · **不成立**（`flow.wait` 那条老路 / 新节点选了 `stop`）→ 与改动前**逐字一致**：
   *   `aborted` 为真、记下整次运行的原因。
   * · **成立**（`flow.alert-wait` 选了继续或走失败分支）→ **不算中断**：
   *   失败已经被局部处理掉了，后续节点还在跑（上面 `order` 没被清空）。
   *   这时置 `aborted = true` 会把「跑完了」误报成「中断了」，任务记录与运行历史
   *   都会按失败收尾 —— 而实际产出是全的。
   *
   * ⚠️ **局部继续那一档不写 `error`**：`error` 的语义是「整次运行为什么没跑成」，
   * 而这一档的整次运行是跑完了的。节点自己那条失败原因已经在节点明细的 `error` 里
   * （运行历史点开那个节点就能看到），不需要再冒充成整次运行的原因。 */
  if (manualExpired !== null && !manualLocalContinue) {
    aborted = true
    /* ★ 这条路也是「整次运行失败」，同样要给原因（契约 AH）。
     * 与节点失败互斥：`manualExpired` 只有**恢复**时非空，那时 `runSeq` 根本没跑节点。
     * 不加这一格，等待超时那种失败在板块记录里又是「没跑成、不知道为什么」。 */
    if (firstFailureError === undefined) firstFailureError = manualExpired
  }

  /* ── 中断收尾：把「排着队、这次不会再跑」的节点撤成 `cancelled`（契约 AB）──
   *
   * ## 不补这一下的后果（用户原话）
   *
   * 「报错了，但是后续还在执行。」—— 实际没继续执行，是**记录与界面**把
   * 「排队中」当成了还在跑。`runGraph` 一开跑就把每个节点发成 `queued`（对，
   * 界面要一眼看出这次要跑哪些），而失败 + `onError: stop` 时只发了一条
   * `aborted` 就抛出去了，**没有任何人把那些 `queued` 撤掉**。
   * 收集层（`mergeNodeEvent`）只在收到事件时改状态，收不到就永远停在「排队中」。
   *
   * ## 三条纪律
   *
   * ① **只在 `aborted === true` 时做**。挂起（`flow.wait` 等人点继续）时
   *    `aborted` 为假，那些「还没轮到」的节点**真的会继续跑** ——
   *    这时发 `cancelled` 就是把「等继续」误报成「没跑」，恢复后界面对不上。
   * ② **跑过的不许发**（判据：进了 `ran` 或发过 `started`）。
   *    失败的那个节点自己是 `failed`，不能因为「这次没跑完」就被改写成「没跑」——
   *    用户要去查的是它，被抹掉等于把唯一线索藏了。
   * ③ **判据用「曾经发过排队」而不是「在主序里」**：循环体与并行体的成员
   *    不在 `order` 里，但它们同样会停在「排队中」（`noteQueued` 记得它们）。
   *
   * ## 为什么在这里而不是在 `runSeq` 的 catch 里
   *
   * `runSeq` 是**递归**的（循环体内、并行每一路都走它），在那里发会让同一批节点
   * 被补发好几次，且分不清「这一层中断了」还是「只有这一路失败了」。
   * 放在 `runGraph` 收尾，**每一层子工作流各自的 `runGraph` 各管自己那一层** ——
   * 子层因此天然也被收干净，不需要额外接线。 */
  if (aborted) {
    for (const id of queuedIds) {
      if (ranSet.has(id) || startedIds.has(id) || settledIds.has(id)) continue
      emit({ kind: 'cancelled', nodeId: id })
    }
  }


  /* ── 结束节点：把声明的产出收出来（用户 m00901 定案：输出=结束节点）────────
   *
   * 为什么放在**全部跑完之后**：它声明的是「取哪个节点的哪个字段」，
   * 那些节点跑完了才有值。
   *
   * 三条：
   *   · **最多一个**（多个是配置错误，说清是哪几个）；
   *   · 取不到值的项**照旧列出来**（值是 undefined）—— 不静默丢掉，
   *     调用方能看出「声明了但没取到」；
   *   · 没有结束节点 → 空对象（这份工作流没有对外产出），不报错。 */
  /**
   * 按结束节点声明的清单取值。
   *
   * 抽成函数而不是内联：**两处要用** —— 收尾统一取一次；若结束节点选了
   * 「跑到这一步就显示」，`runEnd` 里还要当场取一次（用户 m03330 要的那个设置）。
   *
   * @param node - 结束节点。
   * @returns 名字 → 值。
   */
  const collectEndOutputs = (node: RunNodeSpec): Record<string, unknown> => {
    const got: Record<string, unknown> = {}
    for (const o of parseOutputFields(node.params.fields)) {
      /* 只认**本次真的跑过**的节点：没跑过的（未走的分支 / 被跳过）取不到，
       * 值就是 undefined —— 交给调用方判断，不在这里静默丢。 */
      const src = outputs.get(o.nodeId)
      if (o.field === '') { got[o.name] = src; continue }
      got[o.name] = (src !== null && typeof src === 'object')
        ? (src as Record<string, unknown>)[o.field]
        : undefined
    }
    return got
  }

  /* 挂起时**不收口**：结束节点声明的是「跑完之后交出的值」，
   * 而这次还没跑完 —— 打一行「产出：…」会让人以为跑完了（值是半截的，更坏）。 */
  const declaredOutputs: Record<string, unknown> = {}
  if (endNodes.length > 1) {
    emit({
      kind: 'log', nodeId: endNodes[0]?.id ?? '',
      line: '✕ 这份工作流里有 ' + String(endNodes.length) + ' 个「结束」节点（只能有一个）：'
        + endNodes.map(n => n.id).join('、') + ' —— 只用了第一个',
    })
  }
  /* ★ 挂起时**整段跳过**（不发产出日志、也不取值）：
   * 结束节点声明的是「跑完之后交出的值」，而这次还没跑完 ——
   * 打一行「产出：…」会让人以为跑完了，而值是半截的，比不打更坏。 */
  const paused = pausedAtEnd ?? pauseSnapshot
  const endSpec = endNodes[0]
  if (endSpec !== undefined && paused === null) {
    const outs = parseOutputFields(endSpec.params.fields)
    Object.assign(declaredOutputs, collectEndOutputs(endSpec))
    /* 「跑完才显示」（默认）：这里统一打一行。选「跑到这一步就显示」的已在
     * `runEnd` 里打过，这里不再重复（否则一次产出出现两遍）。 */
    if (outs.length > 0 && endSpec.params.when !== 'live') {
      emit({
        kind: 'log', nodeId: endSpec.id,
        line: 'ⓘ 产出：' + outs.map(o => o.name + '=' + JSON.stringify(declaredOutputs[o.name] ?? null)).join('、'),
      })
    }
  }

  return {
    ran,
    executions,
    outputs,
    aborted,
    /* ⚠️ 这里给的是**普通键**（2026-10-23）：`inputs` 会被写进运行记录、
     * 显示成「这次用了什么输入」，而 `__model` 是运行上下文、不是用户填的输入。
     * 恢复不受影响 —— 挂起现场（上面 `snap.inputs`）用的是带保留键的全量那份。 */
    inputs: withoutReservedKeys(resolvedInputs),
    declaredOutputs,
    ...paused === null ? {} : { paused },
    /* ★ 整次运行的汇总失败原因（契约 AH）：节点失败中断时才有。
     * 与 `paused` 同一条纪律 —— 没有就不写这个键（不写 `undefined`、不写空串）。 */
    ...firstFailureError === undefined ? {} : { error: firstFailureError },
  }
}
