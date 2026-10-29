/** 宿主半的「跑一份工作流文件」（无界面执行）。
 *
 * ## 为什么需要它（用户 2026-10-11 要求）
 *
 * 「工作流板块的工作流界面应该有执行按钮，不依赖画布执行工作流。」
 * 在那之前，跑工作流的逻辑住在画布组件里 —— 想跑就必须把画布开着。
 *
 * ## 一条纪律：**不另写跑法**
 *
 * 这里**复用** `src/workflow/run.ts` 的调度器（画布也用它）。
 * 各写一套跑法必然分叉：画布上跑得好好的、后台跑就不对，这类问题极难查。
 * 本文件只做三件事：**读文件 → 查节点定义 → 把派发接到本地派发器**。
 *
 * ## 与画布跑法的唯一区别
 *
 * 派发不走 HTTP（不用绕一圈回自己），直接调本地 `WorkflowDispatcher`；
 * 状态不画到节点上（没有节点可画），改为**写运行记录**。
 */
import type { NodeDef } from './model.ts'
import { runGraph, type RunOutcome } from './run.ts'
/* 挂起现场（可存成 JSON 的那一份）—— 暂停恢复用。纯逻辑，不碰磁盘。 */
import type { RunSnapshot } from './snapshot.ts'
import { toRunSpecs, type WorkflowDoc } from './specs.ts'
import { loadWorkflowByRef } from './store.ts'
import { readWorkflowId, type WorkflowRef } from './ids.ts'
import { applyPrefsToSpecs, normalizePrefs } from './browser-prefs.ts'
/* 工作流执行指纹（票 17）：挂起时写进现场，恢复时先核一次。 */
import { docFingerprint, checkResumeFingerprint } from './fingerprint.ts'

/* 图的翻译与其形状声明都在 `./specs.ts`。
 *
 * 为什么抽出去：画布也要用**同一份**翻译（它引不了本文件 —— 本文件引 `store.ts`，
 * 那个用 `node:fs`，浏览器里没有）。原先画布自己写了一遍，于是漂了两次：
 * 漏 `parentId`（循环体不被认出来）与漏 `sourceHandle`（未走的分支照跑），
 * 两次都是「换个入口跑就不对」这类难查的现象。
 *
 * 这里重导出，保持既有 import 点不用改。 */
export { toRunSpecs, type WorkflowDoc, type WorkflowDocNode, type WorkflowDocEdge } from './specs.ts'

/** 跑一份工作流的结果。 */
export interface RunFileResult {
  ok: boolean
  /**
   * 实际跑到的那一份的**名字**（文件名）。
   *
   * ⚠️ 2026-10-19 加：调用方传进来的是**引用**（可能只有编号），
   * 而界面要显示的是名字 —— 由这里把解析结果带回去，免得它再查一次。
   */
  name?: string
  /** 实际跑到的那一份的**编号**（同上）。 */
  id?: string
  /** 跑了哪些节点（按顺序）。 */
  ran: string[]
  /** 是否因失败策略中断。 */
  aborted: boolean
  /** 查不到定义的节点类型（这些节点被跳过了）。 */
  missingTypes: string[]
  /** 本次运行实际生效的输入（开始节点声明 + 外部给值合并后）。 */
  inputs?: Record<string, unknown>
  /** 结束节点声明的产出（名字 → 值）。没有结束节点时是空对象。 */
  declaredOutputs?: Record<string, unknown>
  /**
   * 失败原因。**两条来源都写这里**（契约 AH，2026-10-24 扩口径）。
   *
   * ## 原来的口径（不够用）
   *
   * 只说「整份跑不起来时才有」：读不到存档、节点类型一个都认不出。
   * 而「跑起来了、中途有节点失败并中断」那条路**只回 `aborted: true`**，
   * 不回原因。后果实测过：`collect/` 下 4 条失败记录字段里**一条都没有 `error`**，
   * 用户只看到「没跑成」，不知道是哪一步、什么原因
   * （节点级原因在运行记录里另有，但板块记录只记整次运行、不记节点）。
   *
   * ## 现在的口径
   *
   *   · **档跑不起来** → 上面几处 return 各自给的那句话（原文照旧）；
   *   · **跑起来但中断** → `runGraph` 收的**第一个**失败节点那句话（`r.error`）。
   *
   * ⚠️ 挂起时**没有这个键**（挂起不是失败），正常跑完时也没有 ——
   * 与 `paused` / `depth` / `llm` 同一条纪律：能省一个键就省，不写 `undefined`、不写空串。
   */
  error?: string
  /**
   * 这次运行**挂起了**（在等 `flow.wait` 的条件）。
   *
   * ⚠️ 挂起**不是失败**：`ok` 仍为 `true`、`aborted` 仍为 `false`。
   * 调用方要做的三件事：
   *   ① 把现场落盘（`pause-store.ts` 的 `savePausedRun`）；
   *   ② 运行记录标「等待中」而不是成功 / 失败；
   *   ③ **不要**发失败通知。
   *
   * 不挂起时**没有这个键**（老调用方读不到，行为不变）。
   */
  paused?: RunSnapshot
}

/**
 * 跑一份已保存的工作流（无界面）。
 *
 * ## ⚠️ 第一参是**引用**不是名字（2026-10-19 改）
 *
 * 以前只能给名字。名字是给人看的标签，一改名引用就断
 * （用户：「引用用的应该是编号而不是名称」）。
 * 现在给 `{ id, name }`：**先按编号找、找不到再按名字找**（老存档兼容）。
 * 直接给字符串也照旧能跑（当作名字）—— 调用点不必全改。
 *
 * @param ref - 工作流引用（编号 / 名字；给字符串等于只给名字）。
 * @param library - 节点定义表。
 * @param dispatch - 派发函数（宿主半传本地派发器那版）。
 * @param opts.workdir - 工作目录。
 * @returns 结果（**不抛异常**，失败也返回 ok:false + error）。
 */
export async function runWorkflowFile(
  ref: WorkflowRef | string,
  library: readonly NodeDef[],
  dispatch: (req: {
    runId: string
    nodeId: string
    executor: string
    command: unknown
    context: { workflowId: string, upstream: unknown[], workdir: string, env?: Record<string, string> }
  }, signal?: AbortSignal) => Promise<RunOutcome>,
  opts: {
    workdir?: string,
    signal?: AbortSignal,
    onLog?: (nodeId: string, line: string) => void,
    /**
     * 事件流（**给 SSE / 流程级日志面板用**）。
     *
     * 与 `onLog` 的分工：`onLog` 只给日志行（运行记录写它）；这个给**全部事件**
     * （排队 / 开始 / 成功 / 失败 / 跳过 / 中断 / 日志 / 汇报 / 流式分片）——
     * 面板要按时间摊开每一步的成败，光有日志看不出「某节点什么时候开始跑的」。
     *
     * ⚠️ **流式分片（`kind: 'stream'`）也在里面，但它不进运行记录** ——
     * 收集层（`node-events.ts` 的 `mergeNodeEvent`）故意不认这一种：
     * 每片字都落盘会让记录涨到几十兆，而那些字最终就是节点的输出，存两遍没有意义。
     */
    onEvent?: (e: { kind: string, nodeId: string, line?: string, label?: string, executor?: string, output?: unknown, error?: string, depth?: number }) => void,
    depth?: number,
    /** 外部喂进来的输入（由这份工作流的「开始」节点声明决定收哪些）。 */
    inputs?: Record<string, unknown>,
    /**
     * 浏览器偏好（宿主半从磁盘读到、传进来）。
     *
     * ## 为什么必须传（用户 2026-10-20：「从列表启动找不到浏览器」）
     *
     * 存档里的浏览器节点只有 session（标签名），launcher / exePath / port
     * 是画布在打开时才补进去的（syncBrowserLayer）。从列表启动不经过画布，
     * 于是驱动拿到的端口是空，报「连不上浏览器」。
     *
     * 这里补的是同一套规则（browser-prefs.ts 的 applyPrefsToSpecs），
     * 只补缺的、不覆盖用户显式填过的。
     */
    prefs?: unknown,
    /**
     * 一份**已经挂起的运行**的现场 —— 给了它就从挂起处接着跑（见 `RunGraphInput.resume`）。
     *
     * 恢复时不重新解析输入（用现场里的那批），也不重新决定「跑哪些节点」
     * （现场里已经定死了）。所以这条路**只认现场 + 存档**，别的一概不看。
     */
    resume?: RunSnapshot,
    /**
     * 这次运行的 id（挂起现场的文件名用它）。
     *
     * 由入口（`src/index.ts` 的 `runCollector` / 定时执行器）先定好，
     * 与运行历史里那条记录**同一个 id** —— 各造一个的话「等待中的那条」
     * 与磁盘上的现场对不上，恢复时找不到。
     */
    runId?: string,
    /** 这次运行的开始时刻（毫秒）。恢复时传现场里的那个，免得记录显示「刚跑」而实际跑了很久。 */
    startedAt?: number,
  } = {},
): Promise<RunFileResult> {
  let doc: WorkflowDoc | null
  /* 引用归一：字符串 = 只给名字（老调用点）。 */
  const want: WorkflowRef = typeof ref === 'string' ? { name: ref } : ref
  let resolvedName = (want.name ?? '').trim()
  let resolvedId = (want.id ?? '').trim()
  try {
    const hit = await loadWorkflowByRef(want)
    if (hit === null) {
      /* ⚠️ 报错里要**两种标识都写出来**：用户看到的是名字，
       * 而存档里生效的是编号 —— 只说一个会让「明明选过」与「报没有」对不上。 */
      const shown = resolvedName !== '' ? resolvedName : resolvedId
      return {
        ok: false, ran: [], aborted: false, missingTypes: [],
        error: (resolvedId !== '' && resolvedName === '' ? '没有编号为 ' + resolvedId + ' 的工作流'
          : '没有这份工作流：' + shown),
      }
    }
    doc = hit.doc as WorkflowDoc | null
    resolvedName = hit.name
    resolvedId = hit.id
  } catch (e) {
    return { ok: false, ran: [], aborted: false, missingTypes: [], error: '读工作流失败：' + (e instanceof Error ? e.message : String(e)) }
  }
  if (doc === null) {
    return { ok: false, ran: [], aborted: false, missingTypes: [], error: '没有这份工作流：' + (resolvedName || resolvedId) }
  }

  const { nodes, edges, missingTypes } = toRunSpecs(doc, library)

  /* ★ 恢复前核一次工作流指纹（票 17，2026-10-27）。
   *
   * ## 为什么判在这里
   *
   * 这里是**唯一**同时拿到「读回来的存档原文」与「现场」的地方 ——
   * 上面 `doc` 刚读出来，`opts.resume` 就在手边。放到更上层（`index.ts` 的
   * `resumePausedRun`）就得在那里再读一次存档，于是同一个判断有两处实现。
   *
   * ## ⚠️ 必须在 `applyPrefsToSpecs` **之前**
   *
   * 算指纹用的是存档**原文**。浏览器偏好会把 `port` / `launcher` 补进节点参数里，
   * 那是「这台机器的设置」，不是「这份工作流的内容」——
   * 用户改一下端口偏好就会让所有等待中的现场被误判成「工作流已改动」。
   *
   * ## 不通过就当场返回，一个字都不跑
   *
   * 返回 `ok: false` 而不是抛：调用方要的是一句话与一个可判断的结果，
   * 抛出去会让四条恢复入口各写一遍 try/catch。 */
  if (opts.resume !== undefined) {
    const verdict = checkResumeFingerprint(opts.resume.fingerprint, doc)
    if (verdict.ok === false) {
      return { ok: false, ran: [], aborted: false, missingTypes, error: verdict.reason }
    }
    /* 老现场（加这个字段之前存的）没有指纹可比 —— 放行，但要记一笔，
     * 免得以后有人查「为什么这次没核」。走事件流而不是只写内存：
     * 恢复入口（界面 / 定时器）都接了 `onEvent`，那一行会进日志。 */
    if (verdict.legacy) {
      opts.onEvent?.({
        kind: 'log',
        nodeId: opts.resume.resumeAfter,
        line: 'ⓘ 这份现场是加「工作流指纹」之前存的，没法核对工作流改过没有 —— 按原样继续',
      })
    }
  }

  /* ★ 把浏览器偏好补进节点规格（2026-10-20）。
   *
   * 存档里没有 port，那是画布打开时才写的。从列表 / 定时启动不经过画布，
   * 不补的话驱动会报「连不上浏览器的调试端口」。
   * 幂等：已经有的值不覆盖（用户显式填过的以他为准）。 */
  if (opts.prefs !== undefined && opts.prefs !== null) {
    applyPrefsToSpecs(nodes, normalizePrefs(opts.prefs))
  }
  if (nodes.length === 0) {
    return {
      ok: false, ran: [], aborted: false, missingTypes,
      error: missingTypes.length > 0
        ? '这份工作流里的节点类型一个都认不出：' + [...new Set(missingTypes)].join('、')
        : '这份工作流里没有节点',
    }
  }

  /* 自己递给自己：于是子工作流里还能再有子工作流（`0一键更新 → 一键下载 → 抖音`）。
   * `depth + 1` 是套娃保护的计数器（见 run.ts 的 MAX_SUB_DEPTH）。 */
  const depth = opts.depth ?? 0

  const r = await runGraph(
    {
      nodes,
      edges,
      workdir: opts.workdir ?? process.cwd(),
      inputs: opts.inputs,
      /* ★ 恢复：现场从外面递进来（见 `RunGraphInput.resume` 的三条语义）。
       * 不传时这里就是 `undefined`，整条路与改动前**逐字一致**。 */
      ...opts.resume === undefined ? {} : { resume: opts.resume },
      /* ★ 这份存档的执行指纹（票 17）：跑起来之后它会被写进挂起现场，
       * 下次恢复时拿它判断「这份档后来改过没有」。
       *
       * 算的是**存档原文** `doc`（与恢复时比对用的那一份同源），
       * 不是上面补过浏览器偏好的 `nodes` —— 理由见上面那段注释。 */
      fingerprint: docFingerprint(doc),
      runWorkflow: async (sub, subSignal, subInputs) => {
        const subRes = await runWorkflowFile(sub, library, dispatch, {
          workdir: opts.workdir,
          signal: subSignal ?? opts.signal,
          onLog: opts.onLog,
          onEvent: opts.onEvent,
          depth: depth + 1,
          /* ⚠️ **把父流程给的输入传下去**（2026-10-17）：
           * 没有这一行，「一键下载」这类组合层没法把参数透给下面的子流程。
           * 子流程自己按**它声明的**字段收（多给的由它的 `resolveInputs` 丢掉），
           * 所以这里不做校验，原样转发。 */
          inputs: subInputs,
          /* ⚠️ **浏览器偏好也要逐层传下去**（2026-10-23，用户：CDP 已开着却报「没填端口」）。
           *
           * 上面 `:183-185` 的补端口只作用在**这一份**工作流的节点上 ——
           * 子工作流是另一次 `runWorkflowFile` 调用，它自己那份 `opts.prefs` 是空的话，
           * 里面 `browser.act` 的 `port` 就没人补，驱动拿着空端口去连、报「没填调试端口」。
           *
           * 现场：天猫那份的「③ 打开生意参谋」（`n5`）参数里**本来就没有 `port`** ——
           * 设计如此，端口由偏好补。父流程补上了、子流程没补，于是只有子流程里的节点报错。
           *
           * **必须原样透传 `opts.prefs`（不是重新读盘）**，这样有两个好处：
           *   · 同一次运行里父子用的是**同一份**偏好，不会中途漂；
           *   · 递归天然成立 —— 孙工作流由子工作流照同一行代码再传一层（三层嵌套测过）。
           * 补的规则仍是 `applyPrefsToSpecs` 那一套：**只补缺、不覆盖用户显式填过的**。 */
          prefs: opts.prefs,
        })
        /* ⚠️ **`ok` 与 `aborted` 要一起看**（这里踩过一次）：
         * `RunFileResult.ok` 的语义是「这份档读得出来、真的跑了」，
         * 不是「跑成功了」—— 子工作流里某个节点失败并中断时，它照样是 `ok: true`
         * 而 `aborted: true`。只认 `ok` 的话，子工作流的失败**在父流程看来是成功**，
         * 于是「一键更新」会在下载失败后照样宣称跑完了。 */
        const succeeded = subRes.ok && !subRes.aborted
        return {
          ok: succeeded,
          ran: subRes.ran,
          error: subRes.error ?? (succeeded ? undefined : '子工作流里有节点失败并中断了'),
        }
      },
    },
    dispatch,
    {
      /* 运行记录的分组键用**解析出来的名字**（不是用户传进来的引用）——
       * 名字才是给人看的那个，而引用里可能只有编号。 */
      workflowId: resolvedName !== '' ? resolvedName : resolvedId,
      signal: opts.signal,
      depth,
      /* ★ 运行 id 与开始时刻**由入口给**（见 `opts.runId` 的说明）：
       * 挂起现场的文件名与运行历史里那条记录必须是同一个 id，
       * 各造一个的话「等待中的那条」与磁盘上的现场对不上，恢复时找不到。 */
      ...opts.runId === undefined ? {} : { runId: opts.runId },
      ...opts.startedAt === undefined ? {} : { startedAt: opts.startedAt },
      onEvent: (e) => {
        /* 无界面时没有节点可画：
         *   · 日志交给 `onLog`（调用方写运行记录）；
         *   · **全部事件**交给 `onEvent`（SSE / 流程级日志面板要按时间摊开每一步）。
         * 两者都走，各有各的观察者，谁也不需要另一个。
         *
         * ⚠️ **原样把整个事件交出去，不挑字段**（2026-10-23）：子工作流的事件带
         * `depth`（它住在第几层），收集层靠 `nodeKeyOf(depth, nodeId)` 才不会把父与子的
         * 同名节点合并成一条。这里若改成只挑 `kind` / `nodeId` / `line` 重建一个对象，
         * `depth` 就丢了 —— 撞车问题会原样回来。所以是传引用，不是新建。 */
        opts.onEvent?.(e as { kind: string, nodeId: string, line?: string, depth?: number })
        if (e.kind === 'log') opts.onLog?.(e.nodeId, e.line)
      },
    },
  )
  return {
    ok: true,
    /* 把解析出来的身份带回去（调用方传的是引用，界面要看名字）。 */
    name: resolvedName,
    id: resolvedId,
    ran: r.ran,
    aborted: r.aborted,
    missingTypes,
    inputs: r.inputs,
    declaredOutputs: r.declaredOutputs,
    /* ★ 挂起时把现场交回去（`ok` 仍为真 —— 挂起不是失败）。
     * 不挂起时这个键不存在，老调用方读不到，行为不变。 */
    ...r.paused === undefined ? {} : { paused: r.paused },
    /* ★ 整次运行的失败原因也透传（契约 AH，2026-10-24）。
     *
     * ## 为什么原来这里是空的
     *
     * 上面 `error` 那个字段以前**只在「这份档跑不起来」时**才有值（读不到存档、
     * 节点类型一个都认不出）。而「跑起来了、中途有节点失败并中断」这条路
     * 只回 `aborted: true`，不回原因 —— 于是调用方（宿主半四处）读 `res.error`
     * 永远是 `undefined`，板块记录 `collect/` 里 4 条失败记录一条都没有 `error`。
     *
     * ## 现在的语义（两条来源，都写进同一个字段）
     *
     *   · 档跑不起来 → 上面那几处 return 各自给的那句话；
     *   · 跑起来但中断 → 这里从 `r.error` 取（`runGraph` 收的**第一个**失败原因）。
     *
     * ⚠️ 挂起时 `r.error` 不存在（挂起不是失败），所以这里天然不会写这个键 ——
     * 与「挂起时不发失败通知」那条红线是同一件事，不用再单独判一次。 */
    ...r.error === undefined ? {} : { error: r.error },
  }
}
