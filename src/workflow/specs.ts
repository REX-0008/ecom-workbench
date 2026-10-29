/** 把「图」翻译成调度器能吃的规格（**只有这一份**）。
 *
 * ## 为什么单独一个文件（2026-10-15）
 *
 * 同一个翻译原先有**两份**：
 *   - 宿主半：`run-file.ts` 的 `toRunSpecs`（读存档 JSON）
 *   - 画布：`WorkflowCanvas.tsx` 里就地写的一段 `map`（读内存里的节点）
 *
 * 两份就会漂，而且漂得很隐蔽 —— 换一个入口（列表里点▶ vs 画布里按▶）
 * 只有一边坏，看着像「同一个工作流换个入口就不对」。实际漂过两次：
 *   ① 画布那份漏 `parentId` → 循环体不被认出来 → `{{item.url}}` 原样发给浏览器
 *      （用户 2026-10-15 报的 `Cannot navigate to invalid URL`）；
 *   ② 画布那份漏 `sourceHandle` → **没走的分支照跑**。
 *
 * 现在两份合成一份：参数对齐只剩一处，漏字段在类型上就过不去。
 *
 * ## 为什么放在这个文件而不是 `run-file.ts`
 *
 * `run-file.ts` 会 `import './store.ts'`，而 `store.ts` 用 `node:fs` ——
 * 画布在浏览器里，**引不了**。所以纯逻辑抽到本文件（只依赖 `model.ts` 的类型），
 * 两侧都能 import。
 */
import type { NodeDef, OnError } from './model.ts'
import type { RunNodeSpec } from './run.ts'
import { ERROR_HANDLE } from './branch.ts'
/* 分组框的两个字面量（`'group'` / `'__group'`）在 `workflow-doc.ts` 定义 ——
 * 那里是存档格式的家。从那里引，不在本文件再写一遍字符串：
 * 存档格式改了一次，两处都跟着动；写死字符串就会漏一处。 */
import { GROUP_DEF_ID, GROUP_NODE_TYPE } from '../client/workbench/workflow-doc.ts'

/**
 * 按失败策略给节点定义**派生**一份出口表（`onError: 'continueErrorOutput'` 时多一个失败出口）。
 *
 * ## 为什么必须在「翻译规格」这一层做（契约 AI）
 *
 * `liveHandles`（`branch.ts:43`）只认**定义里真实存在的出口**：节点报了一个
 * 不存在的 handle 时它返回 `null`（=「全部出口都活」）。
 * 而在此之前**没有任何节点定义声明过 `__error`** —— 于是哪怕引擎发出
 * `{ __handle: '__error' }`，也会被判成「不认识的出口」→ 两条分支都跑。
 * 用户看到的正是那个病：选了「走失败分支」，红出口连上的下游永远不活，
 * 而正常出口那条照样跑。
 *
 * 所以出口要在**运行期**补进规格里那一份定义（**不改原定义对象** ——
 * 节点库里那份被所有同类型实例共享，改它会污染别人）。
 *
 * ## 为什么是「派生」而不是「给每个节点静态写一个 `__error`」
 *
 * 静态写会让**所有**节点的端口图都多一格（包括没选这一档的），
 * 而只有选了 `continueErrorOutput` 的才该有红出口 —— 界面那边也是同一个判据
 * （`src/client/workbench/WorkflowNode.tsx:245` 的 `effOnError === 'continueErrorOutput'`）。
 * 两边判据一致，画布上画得出来的红出口，引擎就认得。
 *
 * @param def - 原定义（**不改它**）。
 * @param onError - 这个实例生效的失败策略。
 * @returns 原定义，或带失败出口的一份新定义。
 */
export function withErrorOutput(def: NodeDef, onError: OnError): NodeDef {
  if (onError !== 'continueErrorOutput') return def
  /* 已经声明过就不重复追加（节点作者自己写了一个失败出口时尊重他的定义）。 */
  if (def.outputs.some(o => o.id === ERROR_HANDLE)) return def
  return {
    ...def,
    outputs: [
      ...def.outputs,
      /* 与界面上那个红出口同一个 id / 同一个名字（`WorkflowNode.tsx:362`）。 */
      { id: ERROR_HANDLE, label: '失败', type: 'any' },
    ],
  }
}

/** 工作流文件里一个节点的形状（与画布的 `toWorkflowDoc` 对齐）。 */
export interface WorkflowDocNode {
  /** 节点实例 id。 */
  id?: unknown
  /** 节点类型 id。 */
  defId?: unknown
  /** 实例参数。 */
  params?: unknown
  /** 失败策略。 */
  onError?: unknown
  /** 是否跳过。 */
  skipped?: unknown
  /** 容器归属（循环体的节点靠它认出来是哪一圈要跑的）。 */
  parentId?: unknown
  /**
   * 实例名（节点上那个「给它起个名字」）。
   *
   * 为什么调度规格要它：用户 m03287 要求运行历史的节点明细
   * 「**以哪个节点的备注名称、编号为标题**」——只给 `n7` 这种编号认不出是谁。
   * `toWorkflowDoc` 一直在写这两个字段（画布上改名就会存），
   * 只是**执行侧从来没读过**（读了也只会得到 id）。现在补上。
   */
  label?: unknown
  /** 备注（没起名时退它）。 */
  note?: unknown
}

/** 工作流文件里一条连线的形状。 */
export interface WorkflowDocEdge {
  id?: unknown
  source?: unknown
  target?: unknown
  /** 起点接在哪个出口上（多出口节点分流要用；丢了会让未走的分支照跑）。 */
  sourceHandle?: unknown
  /** 终点接在哪个入口上。 */
  targetHandle?: unknown
}

/** 工作流文件（只声明跑起来要用到的字段）。 */
export interface WorkflowDoc {
  nodes?: unknown
  edges?: unknown
  /**
   * 一句话说明这份工作流干什么（**可选**）。
   *
   * 用户 2026-10-14 要求：「给工作流加一句「说明」并显示在列表里」——
   * 理由是列表原来只有「名称 / 节点数 / 修改时间」，
   * 而工作流是**拿来反复跑的**，「它干什么」才是判断「点不点执行」的依据。
   *
   * ⚠️ **可选**：老存档没有这个字段，读回来是 `undefined`（列表显示为空即可）。
   * 所以加它**不会破坏任何现有存档**。
   */
  description?: unknown
  version?: unknown
  name?: unknown
}

/** 画布上一个节点的**结构形状**（只列调度器要用的字段）。 */
export interface CanvasLikeNode {
  id: string
  /**
   * 画布节点类型（`'v1'` 普通节点 / `'group'` 分组框）。
   *
   * ⚠️ 2026-10-26 补（契约 CE）：分组框成了**真节点**，派发前要按它认出来。
   * 可选项 —— 老调用方（测试、别处的合成数据）不带它，那时按 `defId` 认。
   */
  type?: string
  /** 容器归属（循环体靠它认出来）。 */
  parentId?: string
  data: {
    /** 节点定义。 */
    def: NodeDef
    /** 实例参数。 */
    params?: Record<string, unknown>
    /** 实例级失败策略。 */
    onError?: OnError
    /** 是否被标为跳过。 */
    skipped?: boolean
    /** 实例名（节点上「给它起个名字」）。运行历史的节点标题用它。 */
    label?: string
    /** 备注（没起名时退它）。 */
    note?: string
  }
}

/** 画布上一条连线的**结构形状**。 */
export interface CanvasLikeEdge {
  id: string
  source: string
  target: string
  /** 接在起点的哪个出口上（条件分流必须留）。 */
  sourceHandle?: string | null
}

/** 翻译出来的连线（调度器要的形状）。 */
export interface RunSpecEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
}

/** 参数合并：实例值优先、缺的取定义默认值（**与 `effectiveParams` 同一行**）。 */
function mergeParams(def: NodeDef, params: Record<string, unknown>): Record<string, unknown> {
  return { ...(def.params ?? {}), ...params }
}

/** 翻译一条边：**必须带上 `sourceHandle`**（丢了会让未走的分支照跑）。 */
function mapEdge(raw: { id?: unknown, source?: unknown, target?: unknown, sourceHandle?: unknown }, fallbackId: string): RunSpecEdge {
  const out: RunSpecEdge = {
    id: String(raw.id ?? fallbackId),
    source: String(raw.source ?? ''),
    target: String(raw.target ?? ''),
  }
  if (raw.sourceHandle !== undefined && raw.sourceHandle !== null && raw.sourceHandle !== '') {
    out.sourceHandle = String(raw.sourceHandle)
  }
  return out
}

/**
 * 这个节点**是不是分组框**（不是可运行节点，派发前必须丢掉）。
 *
 * ## 为什么判据要放这里、而不是各处各写一遍
 *
 * 分组框是「编组的框」，用户 m01076 定案后它变成画布上一个**真节点**
 * （`type: 'group'`、`defId: '__group'`）。但它不产出数据、不参与执行 ——
 * 一旦漏过去，`src/dispatch/executors.ts` 会走到
 * `fns.get('__group') === undefined` → 报「没有这个内置节点：__group」，
 * 用户看到的是「跑一半失败了」，而真正的原因只是画布里有个框。
 *
 * 这个判据原本只有 `env-check.ts` 里有（那里的判据是**同一对**字段）。
 * 现在两处共用本函数 —— 一处认 `type`、另一处只认 `defId`，就会漂：
 * 新存档写 `type`、旧存档只有 `defId`，漏一半。
 *
 * @param n - 任何带这两个字段的东西（存档里的裸对象、画布节点都行）。
 * @returns 是分组框则 true。
 */
export function isGroupNodeShape(n: { type?: unknown, defId?: unknown }): boolean {
  return n.type === GROUP_NODE_TYPE || n.defId === GROUP_DEF_ID
}

/**
 * 把一份工作流文件（存档 JSON）翻译成调度器能吃的规格。
 *
 * 为什么**只丢掉查不到定义的节点**而不是整份报错：
 * 与画布加载时一致（画布也是跳过认不出的类型并提示），
 * 否则用户在别的机器上存的档就整份用不了。
 *
 * @param doc - 工作流内容。
 * @param library - 节点定义表。
 * @returns 节点规格、连线、被跳过的类型名。
 */
export function toRunSpecs(
  doc: WorkflowDoc,
  library: readonly NodeDef[],
): { nodes: RunNodeSpec[], edges: RunSpecEdge[], missingTypes: string[] } {
  const byId = new Map(library.map(d => [d.id, d]))
  const nodes: RunNodeSpec[] = []
  const missingTypes: string[] = []
  const rawNodes = Array.isArray(doc.nodes) ? doc.nodes as WorkflowDocNode[] : []
  for (const raw of rawNodes) {
    /* 分组框不是可运行节点 —— 丢掉，**不进 `missingTypes`**（它不是「缺类型」，
     * 是一个本来就不该派发的东西）。判据与 `env-check.ts` 同源（见 `isGroupNodeShape`）。 */
    if (isGroupNodeShape(raw)) continue
    const defId = String(raw.defId ?? '')
    const def = byId.get(defId)
    if (def === undefined) { missingTypes.push(defId); continue }
    const id = String(raw.id ?? '')
    if (id === '') continue
    const params = (raw.params ?? {}) as Record<string, unknown>
    /* 失败策略要先算 —— 它决定出口表要不要多一格（契约 AI，见 `withErrorOutput`）。 */
    const onError = (raw.onError as OnError | undefined) ?? def.onError ?? 'stop'
    const spec: RunNodeSpec = {
      id,
      def: withErrorOutput(def, onError),
      /* 与画布**同一套**合并规则：实例值优先、缺的取定义默认值。 */
      params: mergeParams(def, params),
      onError,
      skipped: raw.skipped === true,
    }
    /* 容器归属：只在有时带上（写 `undefined` 会让下游多一层判空）。 */
    if (typeof raw.parentId === 'string' && raw.parentId !== '') spec.parentId = raw.parentId
    /* 实例名（用户 m03287：运行历史的节点明细要「备注名称 + 编号」当标题）。
     * 优先 `label`（节点上那个「给它起个名字」），没有再退 `note`（一段说明）——
     * 与画布上「有实例名就显示实例名」是同一套优先级。 */
    const shown = typeof raw.label === 'string' && raw.label.trim() !== ''
      ? raw.label.trim()
      : typeof raw.note === 'string' && raw.note.trim() !== '' ? raw.note.trim() : ''
    if (shown !== '') spec.label = shown
    nodes.push(spec)
  }
  const keep = new Set(nodes.map(n => n.id))
  const rawEdges = Array.isArray(doc.edges) ? doc.edges as WorkflowDocEdge[] : []
  const edges = rawEdges
    .map((e, i) => mapEdge(e, 'e-' + String(i)))
    /* 指向已丢节点的边要丢掉，否则拓扑排序会算进不存在的东西。 */
    .filter(e => keep.has(e.source) && keep.has(e.target))
  return { nodes, edges, missingTypes }
}

/**
 * 画布内存里的节点 → 调度器规格。
 *
 * 与 `toRunSpecs` **同一套规则**（上面那些漂走的字段就是靠这一点根治的）——
 * 区别只有「从哪读」：一个读存档 JSON，一个读 React Flow 的内存节点。
 *
 * @param nodes - 画布节点。
 * @param edges - 画布连线。
 * @returns 调度器规格与连线。
 */
/**
 * 画布节点上「给人看的那个名字」：优先实例名（`label`），没有再退备注（`note`）。
 *
 * @param n - 画布节点。
 * @returns 名字（空串 = 没起名）。
 */
function shownNameOf(n: CanvasLikeNode): string {
  const label = n.data.label
  if (typeof label === 'string' && label.trim() !== '') return label.trim()
  const note = n.data.note
  if (typeof note === 'string' && note.trim() !== '') return note.trim()
  return ''
}

export function toRunSpecsFromCanvas(
  nodes: readonly CanvasLikeNode[],
  edges: readonly CanvasLikeEdge[],
): { nodes: RunNodeSpec[], edges: RunSpecEdge[] } {
  /* 分组框在画布上**是一个真节点**（用户 m01076 定案），但它不参与执行。
   * 漏过去的后果：派发时 `fns.get('__group')` 是 undefined →
   * 报「没有这个内置节点：__group」，看着像「跑一半失败」。
   *
   * ⚠️ 判据与 `toRunSpecs`（存档那条路）以及 `env-check.ts` **同源** ——
   * 三处都用 `isGroupNodeShape`，一处认 `type`、另一处只认 `defId` 就会漂。 */
  const runnable = nodes.filter(n => !isGroupNodeShape({ type: n.type, defId: n.data.def.id }))
  const specs: RunNodeSpec[] = runnable.map(n => {
    /* 失败策略先算 —— 它决定出口表要不要多一格（与 `toRunSpecs` 逐字同一条规则）。 */
    const onError = n.data.onError ?? n.data.def.onError ?? 'stop'
    return {
      id: n.id,
      def: withErrorOutput(n.data.def, onError),
      params: mergeParams(n.data.def, n.data.params ?? {}),
      onError,
      skipped: n.data.skipped === true,
      ...n.parentId === undefined ? {} : { parentId: n.parentId },
      /* 实例名（同上）。画布内存里 `label`/`note` 都在 `data` 上。 */
      ...shownNameOf(n) === '' ? {} : { label: shownNameOf(n) },
    }
  })
  /* ⚠️ 连线按**留下的规格**过滤 —— 连到分组框的边端点已不存在，
   * 留着会让拓扑排序算出幽灵依赖。这一句与原来判据一致，只是现在
   * `specs` 里可能少了几项。 */
  const keep = new Set(specs.map(s => s.id))
  const out = edges.map(e => mapEdge(e, e.id)).filter(e => keep.has(e.source) && keep.has(e.target))
  return { nodes: specs, edges: out }
}
