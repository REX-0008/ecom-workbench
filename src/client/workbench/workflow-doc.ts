/** 工作流 ↔ 画布节点的转换（**纯函数**，与界面无关，可独立单测）。
 *
 * ## 为什么把它从画布里抽出来
 *
 * 原先这两件事住在画布组件里（`WorkflowCanvas.tsx` 的 `toWorkflowDoc` / `applyWorkflow`），
 * 于是**存档格式无法单测** —— 而它恰恰是最需要单测的地方：
 * 格式一错，用户辛苦连的流程保存后打开就对不上了，而构建、类型检查、界面渲染**全都不报错**。
 *
 * ## 抽出来时顺手修掉一个既有缺陷（2026-10-12 查出）
 *
 * **编组状态根本无法存档往返**：
 *   - 保存时 `toWorkflowDoc` **不写 `parentId`**，也不写节点的 `type`；
 *   - 分组框节点的 `defId` 是 `__group`，而 `__group` **不在节点库**里；
 *   - 读回时 `defId` 查不到 → 分组框被判为「缺类型」直接丢弃，子节点的归属也没了。
 * 也就是说：**用户编好组、保存、再打开，编组全没了**（且没有任何提示）。
 *
 * 修法：写 `type` 与 `parentId`；读回时 `type === 'group'` 但定义查不到 → 用占位定义造出分组框。
 */
import type { NodeDef } from '../../workflow/model.ts'
import { clampDesc } from './group-roster.ts'

/** 分组框节点类型定义 id（不在节点库里，读回时按需合成）。 */
export const GROUP_DEF_ID = '__group'

/** 分组框节点在画布上的 type 值。 */
export const GROUP_NODE_TYPE = 'group'

/**
 * 这个节点**是不是分组框**。
 *
 * ## 为什么判据要收在一个函数里（契约 CE，用户 m01076）
 *
 * 存档里有**三种**分组表示（见 `fromWorkflowDoc` 的迁移说明），而
 * 「要不要派发 / 要不要算缺类型 / 要不要当上游候选」这几处都要问同一个问题。
 * 判据一旦分成「一处认 `type`、另一处只认 `defId`」，新存档（写 `type`）与
 * 旧存档（只有 `defId`）就会各漏一半 —— 而且漏得**不报错**，只是组被当成节点跑。
 *
 * 目前用它的地方：`src/workflow/specs.ts`（派发前过滤）与
 * `src/workflow/env-check.ts`（缺类型检测）。两处共用本函数。
 *
 * @param n - 任何带这两个字段的东西（存档里的裸对象、画布节点都行）。
 * @returns 是分组框则 true。
 */
export function isGroupNodeShape(n: { type?: unknown, defId?: unknown }): boolean {
  return n.type === GROUP_NODE_TYPE || n.defId === GROUP_DEF_ID
}

/** 文档里一个节点的形状（存进 JSON 的样子）。 */
export interface DocNode {
  /** 实例 id。 */
  id: string
  /**
   * 节点类型（画布渲染用）。
   *
   * ⚠️ **必须写**：容器（`group` / `loop`）与普通节点（`v1`）读回时要用它区分。
   * 早期版本没写这个字段，导致容器读回来变成一个普通节点（或直接被丢弃）。
   */
  type: string
  /** 节点类型定义 id。 */
  defId: string
  /** 坐标（有父节点时是**相对父**的坐标）。 */
  position: { x: number, y: number }
  /** 实例参数。 */
  params: Record<string, unknown>
  /** 失败策略。 */
  onError: string
  /** 是否跳过。 */
  skipped?: boolean
  /** 容器归属（**只给循环这类可执行容器用**；分组框不再用父子关系）。 */
  parentId?: string
  /**
   * 所属分组框的 id（`type: 'group'` 那个节点的 id）。
   *
   * ## 为什么用「成员指向组」而不是「父容器」
   *
   * 参考项目（`refs-projects/infinite-canvas`）的组是**真节点**，成员靠
   * `metadata.groupId` 指回去 —— 用户 m01076 定案「编组照参考项目改」。
   * 这与循环的 `parentId` 父子容器是**两套**，不许混：
   *   - `parentId`：坐标变成相对父、父动子跟着动（React Flow 的父子机制）；
   *   - `groupId`：坐标始终是**绝对**的，组只是画在成员底下的一块框。
   *
   * 混用的后果是「组一动成员全飞」—— 那是旧模型踩过三次的坑。
   */
  groupId?: string
  /** 实例级显示名。 */
  label?: string
  /** 实例级备注。 */
  note?: string
  /**
   * 宽 / 高（**只有分组框写**）。
   *
   * 普通节点的尺寸由内容与 CSS 决定、不进存档；但分组框的框可以拉开也可以缩到
   * 「刚好包住成员」，用户手动调过的大小必须存下来 —— 否则每次打开框都回到
   * 按成员重算的那个尺寸，用户的调整白做。
   */
  width?: number
  height?: number
}

/** 文档里一条连线的形状。 */
export interface DocEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

/**
 * 文档里一个**组**的形状（照 n8n 的 `IWorkflowGroup`，2026-10-13 新增）。
 *
 * ## ⚠️ 这是**只读的旧格式**（契约 CE，用户 m01076 定案后改的性质）
 *
 * 三种格式轮流用过，现在存档只写**第三种**：
 *
 * | 时间 | 组怎么表示 | 成员归属 | 成员坐标 | 现在 |
 * |---|---|---|---|---|
 * | 2026-10-13 前 | 框是节点，成员挂 `parentId` | `parentId` | **相对框** | 只读，读取时迁移 |
 * | 2026-10-13 ~ 10-25 | `nodeGroups` 名单，框**不是**节点 | `nodeGroups[].nodeIds` | 绝对 | 只读，读取时迁移 |
 * | 2026-10-26 起（参考项目） | 框是节点 | 成员的 `groupId` | 绝对 | **只写这一种** |
 *
 * 为什么又改回「框是节点」：用户 m01076 要求编组照参考项目
 * （`refs-projects/infinite-canvas`）—— 那边的组**能被选中、能拖、能改大小**，
 * 而这些能力要求它本身是一个节点（名单模型下框是渲染算出来的，拖它得自己把位移
 * 转给每个成员，见旧 `moveGroupBy`）。
 *
 * ⚠️ 名单格式的**读法**必须留着：别人手里的存档可能还是那一版，
 * 直接不认就等于「打开就把编组丢了」。
 */
export interface DocGroup {
  /** 组 id（`g-` 前缀，与节点的 `n-` 区分）。 */
  id: string
  /** 组名（不能为空）。 */
  name: string
  /** 成员节点 id。 */
  nodeIds: string[]
  /** 可选描述（上限 145 字，超长截断）。 */
  description?: string
}

/** 一份工作流文档。 */
export interface WorkflowDoc {
  version: number
  name: string
  /**
   * 这份工作流的**稳定编号**（用户 2026-10-19：「引用用编号不用名称」）。
   *
   * ## 为什么画布必须带着它往返
   *
   * `flow.workflow` 节点引用别的工作流时存的是**编号**（见 `src/workflow/ids.ts`）。
   * 若画布保存时不写 `id`，宿主半只能按**文件名**派生一个 ——
   * 而一份被改过名的存档，它原本的编号是按**旧名字**算的 → 保存一次就换了编号
   * → 所有引用它的地方全部断掉。那正是这次要修的问题。
   *
   * ⚠️ 与 `description` / `types` 同一个搬运逻辑：读出来拿着、保存时原样写回去。
   * 缺失时（老存档第一次保存）由宿主半补派生一个并写回。
   */
  id?: string
  nodes: DocNode[]
  edges: DocEdge[]
  /**
   * 一句话说明这份工作流干什么（**可选**）。
   *
   * ⚠️ **2026-10-15 补上（T9 查出的 F1，blocker）**：
   * 这个字段此前**没在接口里、也没在 `toWorkflowDoc` 里写过** ——
   * 于是「画布保存」会把它**冲掉**：实证据
   * `天猫取数.json` 的 root keys 是 `version,name,nodes,edges,description`，
   * 而画布存出的 `工作流-2026-10-14T1224.json` 是 `version,name,nodes,edges`
   * （两者 defId 序列完全相同 → 丢在保存这一步）。
   * 症状是「列表里那份工作流的说明，一存就没了」。
   *
   * 宿主半读它（`src/index.ts` 的列表路由）与生成器写它，都不是新东西 ——
   * 缺的只是**画布这一侧的往返**。
   */
  description?: string
  /**
   * 编组（照 n8n 的 `nodeGroups`）。
   *
   * ⚠️ **只读**：契约 CE 之后我们**不再写这个键**（组改回「框是节点」，
   * 见 `DocGroup` 那张表）。但读到它必须能迁移，否则老存档打开就丢编组。
   */
  nodeGroups?: DocGroup[]
  /**
   * 工作流类型（用户 m00861）。**只用于显示与筛选** ——
   * 「能不能被调用」由开始节点的类型决定（用户 m00901），与这里无关。
   *
   * ⚠️ 可选：老存档没有这个字段。它与 `description` 一样**必须往返**
   * （读回来拿着、保存时写回去），否则「打开 → 保存」一趟就没了。
   */
  types?: string[]
}

/** 转换时要读的最小画布节点形状（不依赖 React Flow 的类型）。 */
export interface SourceNode {
  id: string
  type?: string
  position: { x: number, y: number }
  parentId?: string
  /** 画布节点上的显式宽高（只有分组框有 —— React Flow 把它放在节点根上）。 */
  width?: number
  height?: number
  data: {
    def: { id: string, params?: Record<string, unknown>, onError?: string }
    params?: Record<string, unknown>
    onError?: string
    skipped?: boolean
    label?: string
    note?: string
    /** 分组框的标题（旧格式用的字段，读回时映射到 label）。 */
    groupLabel?: string
    /** 所属分组框的 id（成员指向组，见 `DocNode.groupId`）。 */
    groupId?: string
  }
}

/**
 * 转换时要读的最小连线形状。
 *
 * ⚠️ 字段**全部可选**（2026-10-12）。两个理由，都不是图省事：
 *   1. **客户端半的类型环境本身是坏的**（React Flow 的 `Edge` 解析不出来 →
 *      类型上等于 `unknown`），写必填字段会让本来就红的客户端类型检查
 *      再多一条**与本次改动无关**的错（实测过）。
 *   2. 这里本来就是一个**序列化边界** —— 外部存档（不可信）也走这个形状，
 *      按「可能什么都缺」来写才诚实。缺 `source` / `target` 的边在下面直接丢掉。
 */
export interface SourceEdge {
  id?: unknown
  source?: unknown
  target?: unknown
  sourceHandle?: unknown
  targetHandle?: unknown
}

/**
 * 画布节点 → 工作流文档。
 *
 * ## 写的只有一种格式（契约 CE 之后）
 *
 * 分组框在 `nodes` 里是一项（`type: 'group'`、`defId: '__group'`），
 * 成员用 `groupId` 指回去。**不再写 `nodeGroups`** —— 那个键现在只被读、不被写。
 *
 * ⚠️ **`groups` 形参保留着，但它现在一文不值**（契约 CE）。
 *
 * 上一版删它的理由是「留着一个传了没用的形参，下一个人会以为编组在这里写」。
 * 但实测删不动：`tests/workflow-ownership.mjs` 有 4 处**按位置**传参
 * （`toWorkflowDoc(nodes, [], name, [], description)`），而那个文件不在本单
 * 可改路径里。为了一个形参去动别人地盘的测试，代价远大于收益。
 *
 * 所以保留形参 + `void groups` 明说「它不写盘」+ 这段注释说清为什么。
 * 谁将来要删它，先把那 4 处调用方改完再删。
 *
 * @param nodes - 画布节点（组也是其中一项）。
 * @param edges - 画布连线（调用方已过滤掉隐藏的）。
 * @param name - 工作流名。
 * @param groups - ⚠️ **没用到的形参**（见上）。编组只从 `nodes` 里写。
 * @param description - 一句话说明（**可选**，画布从读回的存档里带着它，保存时写回去）。
 * @returns 文档。
 */
export function toWorkflowDoc(
  nodes: readonly SourceNode[],
  edges: readonly SourceEdge[],
  name = '',
  groups: readonly DocGroup[] = [],
  description?: string,
  /**
   * 工作流类型（用户 m00861 提出的「几十份工作流里分清谁是什么」）。
   *
   * ⚠️ **它不是执行条件** —— 用户 m00901 定案：「能不能被调用由**开始节点的类型**决定」，
   * 类型标签**只用来给人看与筛选**。所以这里只是一个显示字段，
   * 与 flow.start 的 type 参数是两件事（别把两者合成一个）。
   *
   * ⚠️ 它**进 docFingerprint**（与 description 同一取舍）—— 改类型就是改内容。
   */
  types: readonly string[] = [],
  /** 这份工作流的稳定编号（读回来时拿着，保存时原样写回去 —— 见 `WorkflowDoc.id`）。 */
  id = '',
): WorkflowDoc {
  const doc: WorkflowDoc = {
    version: 1,
    name,
    nodes: nodes.map(n => {
      const out: DocNode = {
        id: n.id,
        type: n.type ?? 'v1',
        defId: n.data.def.id,
        position: { x: n.position.x, y: n.position.y },
        params: n.data.params ?? n.data.def.params ?? {},
        onError: n.data.onError ?? n.data.def.onError ?? 'stop',
        skipped: n.data.skipped === true,
      }
      /* 容器归属：只在有时写。写 `undefined` 会让存档出现无意义的键。 */
      if (n.parentId !== undefined) out.parentId = n.parentId
      /* 分组归属（契约 CE）：成员 → 它所属的那个框。与 `parentId` 是两套，见 `DocNode.groupId`。 */
      if (n.data.groupId !== undefined && n.data.groupId !== '') out.groupId = n.data.groupId
      /* 分组框自己的宽高：用户拉开过的尺寸必须存下来，否则每次打开都回到按成员重算的大小。 */
      if (n.width !== undefined && n.width > 0) out.width = n.width
      if (n.height !== undefined && n.height > 0) out.height = n.height
      /* 实例级名字与备注：分组框的标题存在 data.groupLabel，归一化到 label。 */
      const label = n.data.label ?? n.data.groupLabel
      if (label !== undefined && label !== '') out.label = label
      if (n.data.note !== undefined && n.data.note !== '') out.note = n.data.note
      return out
    }),
    edges: edges
      /* 缺端点的边丢掉 —— 它无法成立（外部存档可能带脏数据）。 */
      .filter(e => e.source !== undefined && e.source !== null && e.target !== undefined && e.target !== null)
      .map((e, i) => {
        /* 统一 String()：输入是 `unknown`（见 SourceEdge 的说明）。 */
        const out: DocEdge = {
          id: e.id === undefined || e.id === null ? 'e-' + String(i) : String(e.id),
          source: String(e.source),
          target: String(e.target),
        }
        if (e.sourceHandle !== undefined && e.sourceHandle !== null) out.sourceHandle = String(e.sourceHandle)
        if (e.targetHandle !== undefined && e.targetHandle !== null) out.targetHandle = String(e.targetHandle)
        return out
      }),
  }
  /* ── root 级说明（2026-10-15 补，T9 的 F1）───────────────────────────
   *
   * ⚠️ **这一行就是那个 blocker 的修法**：此前 `description` 只在**编组**那段里写过
   * （`out.description`），root 级**一次都没写** —— 所以画布一保存，
   * 存档里原有的「说明」就被冲掉，列表里那一行随之消失。
   *
   * 与编组同一个取舍：**空则不写**（不留 `"description": ""` 这种无意义的键，
   * 也避免把「没说明」与「说明是空串」混成两种表示）。
   */
  if (description !== undefined && description.trim() !== '') doc.description = description
  /* 编号：只在**有**时写这个键。没有的话宿主半会按文件名派生一个
   * （老存档第一次保存就是这条路）—— 所以这里不能写空串占位。 */
  if (id !== '') doc.id = id
  /* 类型：只在**有**时写这个键（没填过就不写空数组，存档干净些）。 */
  if (types.length > 0) (doc as { types?: string[] }).types = [...types]
  /* ── 编组：**不再写** `nodeGroups`（契约 CE，用户 m01076）──────────────
   *
   * 组改回「框是节点」，成员靠 `data.groupId` 指回去，上面那个 `nodes.map`
   * 已经把两者都写进 `doc.nodes` 了 —— 再写一份名单就是**同一件事存两份**，
   * 而两份迟早漂（`pitfalls/同一件事写两份迟早漂.md`）。
   *
   * ⚠️ 代价：老存档（`nodeGroups` 格式）保存一次之后就变成新格式。
   * 这正是我们要的（迁移是单向的，读取时已经把它变成新格式了）。
   */
  void groups
  return doc
}

/** 读回时的产出。 */
export interface RestoredDoc<D> {
  /** 能还原的节点（已按容器归属排序：父在子之前）。 */
  nodes: RestoredNode<D>[]
  /** 能还原的连线（两端都在的才算）。 */
  edges: { id: string, source: string, target: string, sourceHandle?: string, targetHandle?: string }[]
  /** 认不出的节点类型 id（去重）。 */
  missingTypes: string[]
  /**
   * 这份存档的**一句话说明**（没有则是空串）。
   *
   * ⚠️ **2026-10-15 加（T9 的 F1）**：画布必须把它**读出来并拿着**，
   * 否则「打开 → 保存」这一趟会把存档里原有的说明冲掉 ——
   * 因为 `toWorkflowDoc` 写不出一个它根本不知道的值。
   */
  description: string
  /**
   * 编组（照参考项目的模型：框是节点 + 成员 `groupId`）。
   *
   * ⚠️ **字段保留但永远为空数组**（契约 CE）。组现在是 `nodes` 里的一项，
   * 成员靠 `data.groupId` 指回去 —— 调用方不再需要一份单独的名单。
   *
   * 为什么还把字段留在接口上：`WorkflowCanvas` 的 `setGroups` 与指纹计算
   * 都还读它（那些是别处的代码，改签名会牵动一大片）。留着空数组，
   * 那些地方自然「读到零个组」，不需要跟着改。
   */
  groups: DocGroup[]
  // 工作流类型（用户 m00861）。空数组 = 没填过（老存档没有这个字段）。
  // 调用方必须带回去，否则「打开 → 保存」会把列表里填的类型冲掉。
  types: string[]
  /**
   * 这份存档的**稳定编号**（没有 = 老存档，第一次保存时由宿主半补）。
   *
   * ⚠️ 调用方必须带着它往返，理由见 `WorkflowDoc.id` 的说明。
   */
  id: string
}

/** 读回后的节点（data 里的 `def` 由调用方按类型查好填入）。 */
export interface RestoredNode<D> {
  id: string
  type: string
  position: { x: number, y: number }
  parentId?: string
  /** 分组框的显式宽高（只有 `type === 'group'` 的节点有）。 */
  width?: number
  height?: number
  data: {
    def: D
    params: Record<string, unknown>
    onError: string
    skipped: boolean
    label?: string
    note?: string
    /** 所属分组框的 id（成员指向组）。 */
    groupId?: string
  }
}

/**
 * 从一份存档里读编号（读不到给空串）。
 *
 * 存档来源不可信（可能被手改），所以只认非空字符串 —— 与
 * `src/workflow/ids.ts` 的 `readWorkflowId` 同一条判据。
 * ⚠️ 不直接 import 那个文件：它是宿主半/引擎侧的模块，而本文件要能单独单测。
 * 两处都是三行逻辑，重复的代价小于多一条依赖。
 *
 * @param d - 存档对象。
 * @returns 编号（空串 = 没有）。
 */
function readId(d: unknown): string {
  if (d === null || typeof d !== 'object') return ''
  const raw = (d as { id?: unknown }).id
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * 工作流文档 → 画布节点。
 *
 * 两条纪律：
 *   1. **认不出的类型不整份拒绝** —— 缺一个节点就整份打不开，用户会丢掉整份工作。
 *      改为「能加载的先加载 + 列出缺什么」。
 *   2. **父节点必须排在子节点之前**（React Flow 的硬要求，否则坐标算错）。
 *      所以末尾按 `parentId` 做一次稳定排序。
 *
 * @param raw - 文档内容（来源不可信，先校验）。
 * @param library - 节点类型表（id → 定义）。
 * @param makeGroupDef - 合成分组框占位定义（分组框不在节点库里，由调用方提供）。
 * @returns 节点、连线、缺失类型；`raw` 不是一份工作流时返回 null。
 */
export function fromWorkflowDoc(
  raw: unknown,
  library: ReadonlyMap<string, NodeDef>,
  makeGroupDef: () => NodeDef,
): RestoredDoc<NodeDef> | null {
  const d = raw as { nodes?: unknown, edges?: unknown } | null
  if (d === null || typeof d !== 'object' || !Array.isArray(d.nodes)) return null

  const missingTypes: string[] = []
  const nodes: RestoredNode<NodeDef>[] = []
  for (const rawNode of d.nodes as Record<string, unknown>[]) {
    const defId = String(rawNode.defId ?? '')
    /* ⚠️ 老存档**不写 `type`**（那时还没有这个字段），所以 `?? 'v1'` 会把一个
     * 分组框读成普通节点 —— 而 `type` 是后面所有判据（谁算缺类型、谁要被派发、
     * 框排在哪）的分流依据。所以先按**两个字段任一**认出它是框，再把 type 归一。 */
    const asGroup = isGroupNodeShape(rawNode)
    const type = asGroup ? GROUP_NODE_TYPE : String(rawNode.type ?? 'v1')
    let def = library.get(defId)
    /* 分组框：它的类型不在节点库里（它不是可运行的节点），按 type 合成。
     * 这一步同时兼容**旧存档**：旧档没写 type，但 defId 恰好是 '__group'。 */
    if (def === undefined && asGroup) {
      def = makeGroupDef()
    }
    if (def === undefined) { missingTypes.push(defId); continue }

    const pos = rawNode.position as { x?: number, y?: number } | undefined
    const data: RestoredNode<NodeDef>['data'] = {
      def,
      params: (rawNode.params as Record<string, unknown> | undefined) ?? def.params ?? {},
      onError: String(rawNode.onError ?? def.onError ?? 'stop'),
      skipped: rawNode.skipped === true,
    }
    const label = rawNode.label
    if (typeof label === 'string' && label !== '') data.label = label
    const note = rawNode.note
    if (typeof note === 'string' && note !== '') data.note = note

    const node: RestoredNode<NodeDef> = {
      id: String(rawNode.id ?? ('n-' + String(nodes.length + 1))),
      type,
      position: { x: pos?.x ?? 60, y: pos?.y ?? 60 },
      data,
    }
    const parentId = rawNode.parentId
    if (typeof parentId === 'string' && parentId !== '') node.parentId = parentId
    /* 分组归属（新格式就有；旧格式在下面迁移时补上）。 */
    const groupId = rawNode.groupId
    if (typeof groupId === 'string' && groupId !== '') data.groupId = groupId
    /* 分组框的显式宽高（只有它有；普通节点的尺寸由内容决定、不进存档）。 */
    const w = rawNode.width
    const h = rawNode.height
    if (typeof w === 'number' && w > 0) node.width = w
    if (typeof h === 'number' && h > 0) node.height = h
    nodes.push(node)
  }

  /* 父不存在 → 丢掉这个归属（不让脏数据挂在半空，那会让坐标算错）。 */
  const known = new Set(nodes.map(n => n.id))
  for (const n of nodes) {
    if (n.parentId !== undefined && !known.has(n.parentId)) delete n.parentId
  }

  /* 父必须排在子之前（React Flow 硬要求）：稳定排序，同层保持原顺序。 */
  const ordered = [...nodes].sort((a, b) => {
    const ra = a.parentId === undefined ? 0 : 1
    const rb = b.parentId === undefined ? 0 : 1
    return ra - rb
  })

  const keep = new Set(ordered.map(n => n.id))
  const edges = (Array.isArray(d.edges) ? d.edges as Record<string, unknown>[] : [])
    .filter(e => keep.has(String(e.source)) && keep.has(String(e.target)))
    .map((e, i) => {
      const out: { id: string, source: string, target: string, sourceHandle?: string, targetHandle?: string } = {
        id: String(e.id ?? ('e-' + String(i))),
        source: String(e.source),
        target: String(e.target),
      }
      if (e.sourceHandle !== undefined && e.sourceHandle !== null) out.sourceHandle = String(e.sourceHandle)
      if (e.targetHandle !== undefined && e.targetHandle !== null) out.targetHandle = String(e.targetHandle)
      return out
    })

  /* ── 编组：三种格式统一读成「框是节点 + 成员 `groupId`」（契约 CE）──────
   *
   * 三种格式都要认，因为**别人的存档可能是任何一种**（见 `DocGroup` 那张表）：
   *
   * ① **新格式**（我们现在只写这一种）：框在 `nodes` 里、成员有 `groupId`。
   *    什么都不要做 —— 上面的循环已经把它读进来了。
   * ② **名单格式**（2026-10-13 ~ 10-25）：`nodeGroups: [{id,name,nodeIds}]`，
   *    框**不是**节点。要替它**造一个框节点**，位置尺寸按成员包围盒算。
   * ③ **老格式**（2026-10-13 前）：框是节点，成员挂 `parentId`、坐标**相对框**。
   *    要把成员坐标 `相对 → 绝对`、摘 `parentId`、打上 `groupId`。
   *    **框节点本身保留** —— 这一点与名单格式那一版正好相反，那版会把框丢掉。
   *
   * ⚠️ **只迁 `group`，不迁循环**：循环框仍是 `parentId` 容器（它要执行），
   * 所以循环与它的体内节点归属原样保留。
   *
   * ⚠️ 三种格式里**只有老格式要转坐标**。另外两种的成员坐标本来就是绝对的 ——
   * 多转一次会让成员整体飘一个框的位置。
   */
  const groupNodeIds = new Set(
    (d.nodes as Record<string, unknown>[]).filter(rn => isGroupNodeShape(rn)).map(rn => String(rn.id ?? '')),
  )

  /* ── 格式 ③：老格式迁移（成员挂 `parentId`）──────────────────────────
   *
   * 判据是「成员的 `parentId` 指向一个分组框」，而不是「有没有 `nodeGroups`」——
   * 一份存档可能同时有这两种痕迹（用户升级过程中保存过），两边都要处理。 */
  if (groupNodeIds.size > 0) {
    for (const n of ordered) {
      if (n.parentId === undefined || !groupNodeIds.has(n.parentId)) continue
      const box = ordered.find(x => x.id === n.parentId)
      if (box !== undefined) {
        n.position = { x: n.position.x + box.position.x, y: n.position.y + box.position.y }
      }
      n.data.groupId = n.parentId
      delete n.parentId
    }
  }

  /* ── 格式 ②：名单迁移（造框节点）────────────────────────────────────
   *
   * 框的位置尺寸照**当前成员的包围盒**算（老存档里没存框的尺寸）。
   * 内边距与 `group-geometry.ts` 的 `calculateGroupBoundsForNodes` 用同一组数 ——
   * 但本文件**不 import 那个模块**（它是客户端渲染层，本文件要能单独单测），
   * 所以这里就地算一遍。⚠️ 两处数改了要一起改（`GROUP_PAD_*` 那一组常量）。 */
  const groups: DocGroup[] = []
  if (Array.isArray((d as { nodeGroups?: unknown }).nodeGroups)) {
    for (const rawG of (d as { nodeGroups: Record<string, unknown>[] }).nodeGroups) {
      const id = String(rawG.id ?? '')
      const name = String(rawG.name ?? '').trim()
      const ids = Array.isArray(rawG.nodeIds) ? (rawG.nodeIds as unknown[]).map(String) : []
      /* 存档不可信：缺 id / 缺名 / 空组一律丢（与 n8n 同一条规则）。 */
      if (id === '' || name === '' || ids.length === 0) continue
      /* 幽灵成员丢掉（存档被手改或删节点时留下的）。 */
      const live = ids.filter(x => known.has(x))
      if (live.length === 0) continue
      const desc = clampDesc(String(rawG.description ?? ''))
      groups.push({ id, name, nodeIds: live, ...desc === '' ? {} : { description: desc } })

      /* 已经有同名框节点 → 不重复造（免得同一组出现两个框）。 */
      if (groupNodeIds.has(id)) continue
      const members = ordered.filter(n => live.includes(n.id))
      if (members.length === 0) continue
      const restoredBox: RestoredNode<NodeDef> = {
        id,
        type: GROUP_NODE_TYPE,
        position: { x: 0, y: 0 },
        data: {
          def: makeGroupDef(),
          params: {},
          onError: 'stop',
          skipped: false,
          label: name,
          ...desc === '' ? {} : { note: desc },
        },
      }
      const b = groupBoundsOf(members)
      restoredBox.position = { x: b.x, y: b.y }
      restoredBox.width = b.width
      restoredBox.height = b.height
      ordered.push(restoredBox)
      groupNodeIds.add(id)
      for (const m of members) m.data.groupId = id
    }
  }

  /* 组必须排在成员**之前**（React Flow 靠 `zIndex` 定层级，但同 zIndex 看数组顺序；
   * 框要在底下才不挡成员）。所以整段读完再排一次。 */
  const finalNodes = [...ordered].sort((a, b) => {
    const ra = a.type === GROUP_NODE_TYPE ? 0 : 1
    const rb = b.type === GROUP_NODE_TYPE ? 0 : 1
    return ra - rb
  })

  /* 幽灵归属清掉：`groupId` 指向一个不存在的框 → 当作不属于任何组。
   * 不清的话，画布上会出现「找不到父组」的成员，几何层算包围盒时把它算进去、
   * 表现为「框莫名其妙变大」。 */
  const liveGroupIds = new Set(finalNodes.filter(n => n.type === GROUP_NODE_TYPE).map(n => n.id))
  for (const n of finalNodes) {
    const gid = n.data.groupId
    if (gid !== undefined && !liveGroupIds.has(gid)) delete n.data.groupId
  }

  /* ── root 级说明（读出来交给调用方拿着，2026-10-15 的 F1）─────────────
   *
   * 存档不可信，所以照 `WorkflowDoc` 的约定只认字符串；非字符串一律当「没有」。
   * 空串也归一成空串（调用方据此判断「要不要写回去」）。 */
  const rawDesc = (d as { description?: unknown }).description
  const description = typeof rawDesc === 'string' ? rawDesc : ''

  // 工作流类型（用户 m00861）。存档不可信：只留字符串项，去过空白后仍非空的才要。
  const rawTypes = (d as { types?: unknown }).types
  const types = Array.isArray(rawTypes)
    ? rawTypes
      .filter((x): x is string => typeof x === 'string')
      .map(x => x.trim())
      .filter(x => x !== '')
    : []

  return { nodes: finalNodes, edges, missingTypes, description, groups, types, id: readId(d) }
}

/**
 * 一组节点的包围盒 + 内边距（迁移名单格式时用来给框定尺寸）。
 *
 * ⚠️ **与 `group-geometry.ts` 的 `calculateGroupBoundsForNodes` 是同一套数**
 * （`padX=36 / padTop=44 / padBottom=36`，最小 280×200）。这里就地算一遍而不是
 * import 那份，是因为本文件要能在**没有浏览器环境**的测试里单独跑
 * （`group-geometry.ts` 也纯，但它属于渲染层，不该被存档格式反向依赖）。
 * 两处数改了一个就得改另一个 —— 否则迁移出来的框与新建的框内边距不一样。
 *
 * @param members - 成员节点（只读它们的 `position` 与宽高）。
 * @returns 框的位置与尺寸。
 */
function groupBoundsOf(
  members: readonly { position: { x: number, y: number }, width?: number, height?: number }[],
): { x: number, y: number, width: number, height: number } {
  const padX = 36
  const padTop = 44
  const padBottom = 36
  /* 普通节点的宽高不进存档 —— 量不到就按画布默认卡片尺寸估（`canvas-layout.ts` 的
   * `NODE_W` / `NODE_H`）。框开得略大一点比开小了强：小了会把成员盖在框外。 */
  const wOf = (n: { width?: number }): number => (typeof n.width === 'number' && n.width > 0 ? n.width : 300)
  const hOf = (n: { height?: number }): number => (typeof n.height === 'number' && n.height > 0 ? n.height : 168)
  if (members.length === 0) return { x: 0, y: 0, width: 760, height: 480 }
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const m of members) {
    left = Math.min(left, m.position.x)
    top = Math.min(top, m.position.y)
    right = Math.max(right, m.position.x + wOf(m))
    bottom = Math.max(bottom, m.position.y + hOf(m))
  }
  const contentW = right - left + padX * 2
  const contentH = bottom - top + padTop + padBottom
  const extraW = Math.max(0, 280 - contentW)
  const extraH = Math.max(0, 200 - contentH)
  return {
    x: left - padX - extraW / 2,
    y: top - padTop - extraH / 2,
    width: contentW + extraW,
    height: contentH + extraH,
  }
}

/* ══ 存档归属与「未保存」判断（2026-10-14 新增）════════════════════════════
 *
 * ## 用户报的 bug
 *
 * 「我打开的明明是天猫取数，但是我保存的时候成了保存新文件：工作流-2026-10-14T1224。
 *   是不是当前画布根本没有记录当前编辑的是哪个工作流？」
 *
 * 事实：画布确实**不记录**当前打开的是哪一份，保存时**永远**生成时间戳名字 ——
 * 所以「覆盖原文件」这件事在代码里根本不可能发生。
 *
 * 做法照 **n8n**（用户 2026-10-14 定：「用 N8N 那套」）：
 * 一个可空的归属 + 一个「是不是新的」，由它决定保存走**覆盖**还是**新建**。
 * 出处：`packages/frontend/editor-ui/src/app/stores/workflows.store.ts:53-71`
 * （`workflowId` / `isNewWorkflow`）；保存的两条分支在
 * `composables/useWorkflowSaving.ts` 的 `updateWorkflow`（约 497 行）与
 * `createNewWorkflow`（约 683 行）。
 *
 * ## 三个名字的关系（这里定下的规矩 —— 也是本次改动的设计决定）
 *
 * | | 是什么 | 以谁为准 |
 * |---|---|---|
 * | **文件名** | 磁盘上的 `<名>.json`（宿主半 `safeName` 清洗过） | **权威** |
 * | **文件里的 `name`** | 存档 JSON 的 `name` 字段 | 写档时**同步成文件名** |
 * | **显示名** | 画布工具条上显示的那个 | 就用归属名 |
 *
 * 为什么以**文件名**为准：列表、打开、再次保存走的全是文件名
 * （`/workflows` 的 `items[].name` 与 `/workflow?name=`）。
 * 若以文件里的 `name` 为准，一份被手改过内容的存档会让
 * 「列表里点开的是哪份」与「保存覆盖的是哪份」错位 —— 那正是这次要修的那类 bug。
 * 代价：改过文件名的旧存档里 `name` 会短暂地对不上，
 * 但**下一次保存就会自愈**（写档时同步成文件名），而且读档一律忽略它。
 */

/** 画布当前编辑的是哪份工作流文件（照 n8n 的 `workflowId` + `isNewWorkflow`）。 */
export interface WorkflowFileRef {
  /** 归属名（= 文件名，不含扩展名）。没有归属时是空串。 */
  name: string
  /** 还没有归属：保存时会**新建**一个文件，而不是覆盖。 */
  isNew: boolean
}

/**
 * 一份新工作流的名字（时间戳，沿用改动前的写法）。
 * @param now - 取时间的来源（测试可注入，默认当前时刻）。
 * @returns 如 `工作流-2026-10-14T1224`。
 */
export function timestampName(now: Date = new Date()): string {
  return '工作流-' + now.toISOString().slice(0, 16).replace(':', '')
}

/**
 * 决定这次「保存」写哪一个名字。
 *
 * 这就是用户要的「n8n 那套」：**有归属则覆盖，没归属才新建**。
 *
 * @param file - 当前归属。
 * @param stamp - 没有归属时用的新名字（`timestampName()`）。
 * @returns 目标名，以及这次是不是**新建**（用于给用户不同的提示语）。
 */
export function resolveSaveTarget(file: WorkflowFileRef, stamp: string): { name: string, creates: boolean } {
  if (file.isNew || file.name === '') return { name: stamp, creates: true }
  return { name: file.name, creates: false }
}

/**
 * 文档内容的指纹（判断「有没有未保存的改动」用）。
 *
 * 三条**故意**的取舍：
 *   1. **不含 `name`** —— 改名（保存 / 另存为）不算内容改动。
 *      含了的话，刚保存完会立刻显示成「有未保存的改动」。
 *   2. **不含节点运行状态**（state / progress）—— 它们本来就不进存档，
 *      不写进 JSON 的东西不该影响「存没存」。
 *   3. **含 `description`** —— 它确实是存档内容的一部分（2026-10-15 的 F1 修复），
 *      而画布上现在没有改它的入口，所以不会造成误报。
 *
 * @param doc - 文档。
 * @returns 指纹字符串（同样内容必得同样字符串）。
 */
export function docFingerprint(doc: WorkflowDoc): string {
  return JSON.stringify([
    doc.version, doc.description ?? '', doc.nodes, doc.edges, doc.nodeGroups ?? [],
    // 类型也进指纹：它是内容（存档里的一个字段），与 name 不同（name 只是文件名）。
    doc.types ?? [],
  ])
}
