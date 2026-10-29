/** 读存档时**自动纠正接入端口名**（票 04，用户 2026-10-30 裁决走甲）。
 *
 * ## 解决的是什么（画布错误 008）
 *
 * 用户在画布上打开一份老存档，报：
 *
 * ```
 * Couldn't create edge for target handle id: "in", edge id: e1
 * ```
 *
 * 意思很直白：这条线要接到一个叫 `in` 的口上，而目标节点上**没有这个 id 的入端口**。
 *
 * 根因不是新 bug —— **节点的入端口以前改过名，老存档里的连线还指着旧名字**。
 * 实测 13 份真实存档里带 `targetHandle` 的边 166 条，其中 10 条不合法：
 *
 * | 节点类型 | 老存档里存的 | 现在合法的 |
 * |---|---|---|
 * | `sys.fs.read` | `in` | `path` |
 * | `sys.fs.write` | `in` | `content` |
 *
 * ## 用户裁决：甲（打开时自动纠正 + 写回存档）
 *
 * 另外两条路被否掉的理由记在这里，免得下一个人再提一遍：
 *
 * | | 做法 | 为什么否 |
 * |---|---|---|
 * | 乙 | 把端口名改回 `in` | 一个节点只能有一个 `in`，而读写两类节点现在各自端口名有含义（`path` / `content`）；改回去会让新存档也变糊 |
 * | 丙 | 只报错、让用户手改 | 13 份存档、10 条边，用户得一条条找 JSON 改 |
 *
 * ## 三条硬约束（票面点名，违反就算做错）
 *
 * ### 1. 多入端口**不许猜**
 *
 * 目标节点有多个入口（如 `flow.merge` 有 a / b 两个）时，老值 `in` 到底该落到哪个？
 * **没有依据可循**。猜错会把数据接到别的口上 —— 那比报错更坏：报错至少用户知道坏了，
 * 接错口会让流程静默跑出错误结果。所以这种一律记进 `unfixed` 并**保留原值**。
 *
 * ### 2. 幂等
 *
 * 修过之后再读一次，`changed` 必须是空的 —— 否则每次打开都写一遍盘，
 * 文件修改时间被刷成现在，用户看不出「这份工作流到底什么时候改过」。
 *
 * ### 3. 只动该动的
 *
 * 合法的边、没写 `targetHandle` 的边，**一个字节不动**（166 条里 156 条是这两种）。
 * 约束是「不动」，不是「看不懂就当没看见」—— 动一条不该动的，就是把用户画好的图改了。
 *
 * ## 为什么是纯函数
 *
 * 不读盘、不写盘、不看环境变量，输入输出全靠参数。这样它能脱离画布与磁盘单测，
 * 也保证「怎么修」这条规则只有一份实现（`store.ts` 那边只负责决定**什么时候写回**）。
 *
 * ⚠️ **它不 import 任何 Node 内置模块**（只引 `specs.ts` 的类型），
 * 所以客户端也能引 —— 但这次只有宿主半会用它（见文件末尾那段说明）。
 */
import type { WorkflowDoc } from './specs.ts'

/** 一个节点的最小形状（只认修端口要用的字段）。 */
interface DocNodeLike {
  id?: unknown
  defId?: unknown
}

/** 一条边的最小形状。 */
interface DocEdgeLike {
  id?: unknown
  target?: unknown
  targetHandle?: unknown
}

/** 一个节点定义里修端口要用的部分。 */
export interface PortLibraryEntry {
  /** 节点类型 id（如 `sys.fs.read`）。 */
  id: string
  /** 入端口（只看 `id`）。 */
  inputs: readonly { id: string }[]
}

/** 修好的一条边的记录（给人看 / 给日志用）。 */
export interface EdgeTargetFix {
  /** 边的编号（存档里那个 `id`）。 */
  edgeId: string
  /** 目标节点编号。 */
  target: string
  /** 目标节点类型。 */
  defId: string
  /** 存档里原来写的。 */
  from: string
  /** 改成的。 */
  to: string
}

/** 没修的一条边（**必须说出来**，不许静默跳过）。 */
export interface EdgeTargetSkip {
  /** 边的编号。 */
  edgeId: string
  /** 目标节点编号。 */
  target: string
  /** 存档里原来写的。 */
  from: string
  /**
   * 为什么没修。
   *
   * 三种：
   *   - `unknown-def` —— 目标节点类型不在节点库里（删过的节点 / 别的机器上烤的档）
   *   - `multiple-inputs` —— 目标节点有多个入端口，猜不出该接哪个
   *   - `no-inputs` —— 目标节点一个入端口都没有（如 `flow.start`），修不了
   */
  reason: 'unknown-def' | 'multiple-inputs' | 'no-inputs'
}

/** 修正结果。 */
export interface EdgeTargetRepair {
  /** 修正后的存档（没改动时与传入的那一份**逐个引用相等**）。 */
  doc: unknown
  /** 修好了哪几条（空数组 = 这次一个字没改）。 */
  changed: EdgeTargetFix[]
  /** 看见但不该修的（多入端口 / 未知类型 / 无入端口）。 */
  unfixed: EdgeTargetSkip[]
}

/**
 * 从存档里取出节点表（编号 → 定义 id）。非对象 / 非数组一律当空表。
 *
 * @param doc - 存档原文。
 * @returns 编号 → defId（只收两个都是字符串的那些）。
 */
function nodeDefIds(doc: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return out
  const nodes = (doc as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) return out
  for (const n of nodes as DocNodeLike[]) {
    if (n === null || typeof n !== 'object') continue
    if (typeof n.id !== 'string' || typeof n.defId !== 'string') continue
    out.set(n.id, n.defId)
  }
  return out
}

/**
 * 按节点库判一条边该不该修，以及修成什么。
 *
 * 抽出来是因为「该不该修」有四种结局（修 / 未知类型 / 多入口 / 无入口），
 * 写在主循环里会让那个循环变成一坨分支。**猜不猜**这条判断只在这里。
 *
 * @param defId - 目标节点的类型 id。
 * @param library - 节点库。
 * @returns 该接哪个端口；不该修时给原因。
 */
function pickPort(
  defId: string,
  library: readonly PortLibraryEntry[],
): { port: string } | { reason: EdgeTargetSkip['reason'] } {
  const def = library.find(d => d.id === defId)
  if (def === undefined) return { reason: 'unknown-def' }
  /* ⚠️ 核心那条：**只有一个入口才敢填**。
   * 多个入口时「随便取第一个」会在 `flow.merge` 这种节点上把数据接到 a 而不是 b，
   * 流程照样跑完、结果却是错的那一路 —— 比报错更难查。 */
  if (def.inputs.length > 1) return { reason: 'multiple-inputs' }
  if (def.inputs.length === 0) return { reason: 'no-inputs' }
  return { port: def.inputs[0].id }
}

/**
 * 纠正存档里**不合法**的 `targetHandle`。
 *
 * ## 判据一句话
 *
 * 「这个 `targetHandle` 在目标节点的 `inputs` 里找不到」→ 不合法。
 * 找不到时，**只有目标节点恰好一个入端口**才把它换成那个端口。
 *
 * ## 为什么没改动时返回同一份 `doc`
 *
 * 调用方拿 `changed.length === 0` 判「要不要写盘」。若这里返回一个新建的对象，
 * 调用方一眼看不出「其实没变」，就只能靠再比一遍 JSON —— 那是第二份实现。
 * 返回原引用是最诚实的信号：**同一个对象 = 一个字没动**。
 *
 * @param doc - 存档原文（任意 JSON，坏形状当「没有节点/边」处理）。
 * @param library - 节点库（要带 `id` 与 `inputs`）。
 * @returns 修正后的存档 + 改了什么 + 没改什么。
 */
export function repairEdgeTargets(
  doc: unknown,
  library: readonly PortLibraryEntry[],
): EdgeTargetRepair {
  const unchanged: EdgeTargetRepair = { doc, changed: [], unfixed: [] }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return unchanged
  const edgesRaw = (doc as { edges?: unknown }).edges
  if (!Array.isArray(edgesRaw)) return unchanged

  const defOf = nodeDefIds(doc)
  const changed: EdgeTargetFix[] = []
  const unfixed: EdgeTargetSkip[] = []
  /* 保留原下标：改完要按同一个顺序放回去（顺序变了存档的 diff 会很难读）。 */
  const nextEdges: unknown[] = []
  let touched = false

  for (const e of edgesRaw as DocEdgeLike[]) {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) { nextEdges.push(e); continue }
    /* 没写 `targetHandle` 的边：**一个字节不动**（判据 3）。 */
    if (e.targetHandle === undefined || e.targetHandle === null || e.targetHandle === '') {
      nextEdges.push(e)
      continue
    }
    const target = typeof e.target === 'string' ? e.target : ''
    const defId = defOf.get(target)
    const edgeId = typeof e.id === 'string' && e.id !== '' ? e.id : '(没有编号)'
    const from = String(e.targetHandle)
    /* 目标节点在存档里找不到（边指向一个不存在的节点）：不动、不报。
     * 这与「未知类型」不是一回事 —— 那种图本来就坏了，但不是这次要修的东西。 */
    if (defId === undefined) { nextEdges.push(e); continue }

    const def = library.find(d => d.id === defId)
    /* 合法（这个口真的存在）→ 不动（判据 2）。 */
    if (def !== undefined && def.inputs.some(i => i.id === from)) { nextEdges.push(e); continue }

    const verdict = pickPort(defId, library)
    if ('reason' in verdict) {
      unfixed.push({ edgeId, target, from, reason: verdict.reason })
      nextEdges.push(e)
      continue
    }
    changed.push({ edgeId, target, defId, from, to: verdict.port })
    nextEdges.push({ ...e, targetHandle: verdict.port })
    touched = true
  }

  if (!touched) return { doc, changed, unfixed }
  return {
    doc: { ...(doc as Record<string, unknown>), edges: nextEdges },
    changed,
    unfixed,
  }
}

/**
 * 修完之后扫一遍，还剩几条不合法（给「真数据验证」用，也可当回归断言）。
 *
 * 与 `repairEdgeTargets` **共用 `pickPort`**：两份判据若各写一遍，
 * 「修的时候认为能修、扫的时候认为不能修」这种分歧迟早出现。
 *
 * @param doc - 存档。
 * @param library - 节点库。
 * @returns 还不合法的那些（空数组 = 干净）。
 */
export function scanBadEdgeTargets(
  doc: unknown,
  library: readonly PortLibraryEntry[],
): { edgeId: string, target: string, from: string }[] {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return []
  const edgesRaw = (doc as { edges?: unknown }).edges
  if (!Array.isArray(edgesRaw)) return []
  const defOf = nodeDefIds(doc)
  const out: { edgeId: string, target: string, from: string }[] = []
  for (const e of edgesRaw as DocEdgeLike[]) {
    if (e === null || typeof e !== 'object' || Array.isArray(e)) continue
    if (e.targetHandle === undefined || e.targetHandle === null || e.targetHandle === '') continue
    const target = typeof e.target === 'string' ? e.target : ''
    const defId = defOf.get(target)
    if (defId === undefined) continue
    const def = library.find(d => d.id === defId)
    if (def === undefined) { out.push({ edgeId: String(e.id ?? ''), target, from: String(e.targetHandle) }); continue }
    const from = String(e.targetHandle)
    if (!def.inputs.some(i => i.id === from)) out.push({ edgeId: String(e.id ?? ''), target, from })
  }
  return out
}

/* ## 为什么这次**不**在客户端也接一份（票面要的「四条路」里的画布执行）
 *
 * 画布上按▶执行，走的是 `WorkflowCanvas.tsx` 里 `toRunSpecsFromCanvas` 那一份
 * **内存里的节点**，而它的输入是 `GET /workflow?name=` 读回来的存档 ——
 * 那条路由走 `loadWorkflowByRef` → `loadWorkflow`，也就是本文件接上的那一处。
 * 所以修在 `store.ts` 一处，四条路（画布打开 / 列表页执行 / 定时跑 / 画布上执行）都吃到。
 *
 * 若哪天有人让画布**绕过** store 自己读文件，那四条路就只剩三条 ——
 * 到时候要修的是那个绕过，而不是在这里再抄一份修正逻辑。
 */

/** 仅用于类型检查时确认 `WorkflowDoc` 与本文件认的字段不漂（编译期，运行时零开销）。 */
export type RepairDocShape = WorkflowDoc
