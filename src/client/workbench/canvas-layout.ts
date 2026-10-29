/** 画布布局：ELK 自动分层 + 兜底网格 + 尺寸测量。
 *
 * 为什么单独成文件（2026-10-08 拆分）：
 *   这一层是**纯计算**——输入节点与连线，输出坐标；不认识 React、不碰组件状态。
 *   它原先挤在画布主文件里（那个文件一度 1400 多行），改布局得在几百行里找。
 *   拆出来之后：布局要单独改时只开这个文件，且可以脱离界面单独验。
 *
 * 三条设计约束（都是踩出来的）：
 *   1 **不能在模块顶层 new ELK()**——它在构造期访问运行环境全局属性，
 *     模块加载期抛错会让整个插件崩掉，而不是某个功能失灵。改为懒建单例。
 *   2 **任何情况下都返回完整坐标**——ELK 抛错就走兜底网格，绝不让画布没位置。
 *   3 尺寸优先用**实测值**（从 DOM 量），量不到才用估算常量。
 */
import ELK from 'elkjs/lib/elk.bundled.js'
import type { Edge } from '@xyflow/react'
import type { V1Node } from './WorkflowNode.tsx'
/** 节点卡片的固定宽度（ELK 拿它算间距）。
 *
 * ⚠️ 真源是 `canvas-tokens.module.css` 的 `--ewb-node-w`（用户可在设置里调），
 * 这里只是**还没测量到尺寸时**的估算值。两处不一致只影响自动布局的间距精度，
 * 不影响正确性（有实测值时一律用实测值）。 */
export const NODE_W = 300
/** 节点卡片的估算高度（ELK 只用来排间距，估个偏大的值更稳）。 */
export const NODE_H = 168

/** ELK 实例（懒建单例）。
 *
 * 注意（2026-10-08 修正）：**不能在模块顶层 new ELK()**。
 * 它在构造期会访问运行环境的若干全局属性；一旦环境有差异，
 * 模块加载期抛错会让**整个插件崩掉**（而不是某个功能失灵）。
 * 改为「第一次真正要算布局时才建」，把失败限制在功能内部。 */
let elkInstance: InstanceType<typeof ELK> | undefined

/**
 * 取（必要时建）ELK 实例。
 * @returns ELK 实例。
 */
function elkOf(): InstanceType<typeof ELK> {
  elkInstance ??= new ELK()
  return elkInstance
}

/**
 * ELK 布局参数。
 *
 * 改进依据（2026-10-08，抄自 Langflow 的 `utils/layoutUtils.ts`，**MIT 可抄码**）：
 *   - `crossingMinimization.strategy: LAYER_SWEEP` —— 减少连线交叉（原配置没设，默认策略效果差）
 *   - `considerModelOrder: NODES_AND_EDGES` —— 尊重数据里的节点顺序，结果更稳定（同样输入布局不变）
 *   - `separateConnectedComponents: true` —— 不连通的几块分开排，不会挤在一起
 */
/**
 * 画布方向（用户点名的 P3 项「画布方向切换」）。
 *
 * 两种：
 *   - `RIGHT`：左→右（流程从左往右流，读起来像句子）——默认
 *   - `DOWN`：上→下（竖排，适合长链，屏幕高度通常比宽度富裕）
 *
 * 为什么值得做成可切换：看流程的习惯因人而异，且同样的图在不同的屏幕上
 * 哪个方向更清楚是不一样的（宽屏横排、窄屏竖排）。
 */
export type LayoutDirection = 'RIGHT' | 'DOWN'

/**
 * 层间（顺着流程方向）与同层（横着）的间距基准值。
 *
 * ⚠️ **这两个值曾与节点宽度脱钩，导致「加宽节点后排版变挤」**（2026-10-11 修）：
 *
 * | 时期 | 节点宽 | 层间间距 | 间距/宽 |
 * | --- | --- | --- | --- |
 * | 定这个值时 | 218 | 90 | 0.41 |
 * | 加宽后（没跟着调） | 300 | 90 | **0.30** ← 用户报「左右排版间隔太近」 |
 *
 * 所以间距改由**比例**算（见 `elkOptions` 的 `nodeWidth` 参数），
 * 基准比例取当初那个 0.41 —— 那是看着舒服时的值，不该因为节点变宽就悄悄变挤。
 * 以后调节点宽度，间距自动跟着走，不会再脱钩一次。
 */
const SPACING_RATIO_BETWEEN_LAYERS = 0.41
/** 同层间距比例。原来 42/218 ≈ 0.19，这里取整到 0.2。 */
const SPACING_RATIO_SAME_LAYER = 0.2
/** 间距的兜底值（没传节点宽度时用）。 */
const SPACING_FALLBACK = { between: 90, same: 42 }
/**
 * 同层间距相对层间间距的比例。
 *
 * 用户只能调**一个**数（见 `elkOptions` 的 `spacing` 参数），
 * 而同层间距另有自己的观感需求，所以由它按这个比例推出来。
 * 取值来自两个原始比例之比：`0.2 / 0.41 ≈ 0.49` ——
 * 也就是**保持与「按宽度自动算」时一样的相对关系**，用户调大调小都成比例。
 */
const SAME_OVER_BETWEEN = SPACING_RATIO_SAME_LAYER / SPACING_RATIO_BETWEEN_LAYERS

/**
 * 自动排版间距的**默认值**（按默认节点宽度算出来的层间间距）。
 *
 * 用途：设置里的滑块要显示一个「当前值」，而用户还没拖动过时它应当是自动算出来的那个数。
 * 算式复用 `autoSpacingFor` —— 分开写两份迟早对不上（本项目已经因为「两处各写一份」踩过坑）。
 */
export const DEFAULT_LAYOUT_SPACING = Math.round(NODE_W * SPACING_RATIO_BETWEEN_LAYERS)

/**
 * 某个节点宽度下、自动算出的层间间距。
 *
 * 为什么导出它：设置面板要**显示当前间距**，而那个数在「自动模式」下是从节点宽度算出来的。
 * 面板自己再写一遍算式就会与这里分叉（本项目因「两处各写一份」踩过坑），
 * 所以算式只留这一份，面板调它。
 *
 * @param nodeWidth - 节点卡片宽度（px）。
 * @returns 自动模式下的层间间距（px）。
 */
export function autoSpacingFor(nodeWidth: number): number {
  return Math.round(nodeWidth * SPACING_RATIO_BETWEEN_LAYERS)
}

/**
 * 生成 ELK 配置（按方向）。
 *
 * @param dir - 方向。
 * @param nodeWidth - 当前节点卡片宽度（没显式间距时用它按比例算）。不传则用兜底值。
 * @param spacing - 用户显式设的**层间间距**（px）。不传 = 按节点宽度自动算。
 *   ⚠️ 两者的关系（2026-10-11 用户要求加这个设置）：
 *   - **不传** = 自动模式，间距跟节点宽度成比例（上次修的那个「加宽后变挤」靠它）；
 *   - **传了** = 用户自己定了数，就照他的来（拉宽节点也不会动，这是他选的）。
 * @returns ELK 的 layoutOptions。
 */
function elkOptions(dir: LayoutDirection, nodeWidth?: number, spacing?: number): Record<string, string> {
  /* 层间间距：显式值优先，否则按节点宽度成比例算。
   * 取整避免出现小数坐标（ELK 会照单全收，但对齐辅助线会看着别扭）。 */
  const between = spacing !== undefined
    ? Math.round(spacing)
    : nodeWidth === undefined
      ? SPACING_FALLBACK.between
      : Math.round(nodeWidth * SPACING_RATIO_BETWEEN_LAYERS)
  /* 同层间距：显式模式下按比例从用户那个数推；自动模式下照旧按宽度算。 */
  const same = spacing !== undefined
    ? Math.round(between * SAME_OVER_BETWEEN)
    : nodeWidth === undefined
      ? SPACING_FALLBACK.same
      : Math.round(nodeWidth * SPACING_RATIO_SAME_LAYER)
  return {
    'elk.algorithm': 'layered',
    'elk.direction': dir,
  'elk.layered.spacing.nodeNodeBetweenLayers': String(between),
  'elk.spacing.nodeNode': String(same),
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
    'elk.separateConnectedComponents': 'true',
    'elk.spacing.componentComponent': '80',
  }
}

/**
 * ELK 失败时的网格兜底（照 Langflow 的 `getFallbackGridPositions`）。
 *
 * 为什么需要：ELK 抛错时若不给坐标，React Flow 会拿到 `position: undefined` 的节点，
 * 表现为「所有节点堆在左上角」甚至渲染异常。兜底网格保证每个节点都有合法坐标。
 * @param nodes - 节点列表。
 * @param measured - 实测尺寸（可选）。
 * @returns 坐标表（id → 位置）。
 */
export function fallbackGrid(
  nodes: V1Node[],
  measured?: Map<string, { w: number, h: number }>,
): Record<string, { x: number, y: number }> {
  const n = Math.max(1, nodes.length)
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)))
  const out: Record<string, { x: number, y: number }> = {}
  nodes.forEach((node, i) => {
    const m = measured?.get(node.id)
    const w = m?.w ?? NODE_W
    const h = m?.h ?? NODE_H
    out[node.id] = {
      x: (i % cols) * (w + 60),
      y: Math.floor(i / cols) * (h + 50),
    }
  })
  return out
}

/**
 * 用 ELK 算自动布局（分层，从左到右）。
 * @param nodes - 当前节点。
 * @param edges - 当前连线。
 * @param measured - 实测尺寸（可选）。
 * @param dir - 方向。
 * @param nodeWidth - 节点卡片宽度（算间距用）。不传则用兜底间距。
 * @returns 新坐标表（id → 位置）。**任何情况下都返回完整坐标**（失败走网格兜底）。
 */
export async function elkLayout(
  nodes: V1Node[],
  edges: Edge[],
  measured?: Map<string, { w: number, h: number }>,
  dir: LayoutDirection = 'RIGHT',
  nodeWidth?: number,
  spacing?: number,
): Promise<Record<string, { x: number, y: number }>> {
  /* ⚠️ **容器成员不交给 ELK**（2026-10-15 修的真 BUG）。
   *
   * 症状：点「自动布局」后，循环体里的节点**跑到循环框外面**（一字排开），
   * 刚打开一份带循环的工作流时也一样。
   *
   * 根因是**两套坐标系混了**：ELK 算出来的是**绝对坐标**，而成员节点存在
   * `position` 里的数是**相对容器**的（React Flow 的 `parentId` 语义）。
   * 把绝对值写进相对字段，成员就等于被"平移了容器原点"这么多 ——
   * 实测一份 5 成员的循环：n2 在 x=402、n3 算出 x=792，写进去后
   * n3 的实际位置变成 402+792=1194，而框只到 902 → 飞到框外。
   *
   * 而且 ELK 把成员当**平级的流程节点**排（它不知道谁是循环体），
   * 于是循环的语义在布局上也丢了。
   *
   * 修法：只把**顶层节点**（没有 `parentId` 的）交给 ELK；
   * 成员的排列由「框内竖排」负责（`container-ops.ts` 的 `relayoutInside`），
   * 框的尺寸位置由 `fitLoopBox` 负责 —— 两者都在画布的 `refitAll` 里，
   * 布局完接一次 `refitAll` 即可。
   *
   * 跨边界的边（循环 → 体内成员）也一并去掉：它是容器**内部**的关系，
   * 不该在顶层分层里占一层，否则循环后面那一段会被推得很远。
   */
  const isChild = (n: V1Node): boolean =>
    typeof (n as { parentId?: unknown }).parentId === 'string'
    && (n as { parentId?: string }).parentId !== ''
  const top = nodes.filter(n => !isChild(n))
  const topIds = new Set(top.map(n => n.id))
  const topEdges = edges.filter(e => topIds.has(e.source) && topIds.has(e.target))

  /* ⚠️ 端口 id 必须**全局唯一**（2026-10-11 修的真 BUG）。
   *
   * 原先直接用 `sourceHandle` 那串名字（`'out'` / `'in'`）当端口 id ——
   * 而**每个节点都有同名端口**，于是 ELK 眼里全图只有一个 `out`、一个 `in`，
   * 端口归属彻底乱了、分层约束失效：布局**退化成方块**。
   * 实测同一张图：错的写法 308×524px（横向方向却排出竖方形），
   * 改对后 924×266px（正确的横长条）。方向切换也因此一直"看着没效果"。
   *
   * 修法：给端口 id 加节点前缀（`节点id:端口名`），边两端也映射到同一个前缀规则。
   * 用 `: `分隔而不是 `-`：句柄名本身可能含连字符（如 `list-out`），
   * 前缀用连字符会与句柄名混淆，冒号不会出现在我们的句柄命名里。 */
  const pid = (nodeId: string, handle: unknown): string => nodeId + ':' + String(handle)
  try {
    const graph = {
      id: 'root',
      layoutOptions: elkOptions(dir, nodeWidth, spacing),
      children: top.map(n => {
        const m = measured?.get(n.id)
        /* 端口固定顺序 —— 抄 Langflow 的关键一步：
         * 告诉 ELK 端口的相对次序，能明显减少连线交叉。
         * 端口 id 必须是字符串（ELK 拒绝 undefined），所以过滤掉没有 handle 的边。 */
        const outPorts = topEdges
          .filter(e => e.source === n.id && e.sourceHandle != null)
          .map(e => ({ id: pid(n.id, e.sourceHandle), properties: { side: 'EAST' } }))
        const inPorts = topEdges
          .filter(e => e.target === n.id && e.targetHandle != null)
          .map(e => ({ id: pid(n.id, e.targetHandle), properties: { side: 'WEST' } }))
        return {
          id: n.id,
          width: m?.w ?? NODE_W,
          height: m?.h ?? NODE_H,
          properties: { 'org.eclipse.elk.portConstraints': 'FIXED_ORDER' },
          /* 第一个端口用节点自身 id —— 没有 handle 的边会落到它上面，不会丢 */
          ports: [{ id: n.id }, ...inPorts, ...outPorts],
        }
      }),
      edges: topEdges.map((e, i) => ({
        /* ELK 要求边必须有 id；程序的图可能没有，这里补一个 */
        id: e.id === '' ? 'elk-edge-' + String(i) : e.id,
        sources: [e.sourceHandle == null ? e.source : pid(e.source, e.sourceHandle)],
        targets: [e.targetHandle == null ? e.target : pid(e.target, e.targetHandle)],
      })),
    }
    const laid = await elkOf().layout(graph)
    const out: Record<string, { x: number, y: number }> = {}
    for (const c of laid.children ?? []) out[c.id] = { x: c.x ?? 0, y: c.y ?? 0 }
    /* 防御：ELK 可能对某些节点不给坐标，缺失的用兜底网格补上。
     * ⚠️ 补的是**顶层节点**的网格 —— 成员的坐标不能在这里给（它是相对的，
     * 由 `relayoutInside` 负责）。 */
    for (const n of top) {
      if (out[n.id] === undefined) {
        const grid = fallbackGrid(top, measured)
        Object.assign(out, grid)
        break
      }
    }
    return out
  } catch (e) {
    /* ELK 失败不能让画布崩 —— 退回网格并留下记录 */
    console.warn('[ecom-workbench] ELK 布局失败，改用网格兜底：', e)
    return fallbackGrid(top, measured)
  }
}

/**
 * 从 DOM 量出各节点的实际尺寸（用于自动布局）。
 *
 * ⚠️ **必须除掉画布缩放**（2026-10-11 修的真 BUG）。
 *
 * `getBoundingClientRect()` 给的是**屏幕**尺寸，会被画布的缩放系数乘过。
 * 而 ELK 要的是**画布坐标**下的尺寸（节点自己声明的宽高就是画布坐标）。
 *
 * 不看这一层会怎样：把画布缩到 50% 再点自动布局，
 * 量到节点宽 150，ELK 按 150 排版；而节点在画布坐标里其实是 300 宽 →
 * **排出来真的会互相重叠**。布局越排越乱，但控制台一声不响。
 *
 * 缩放的来源：React Flow 的 viewport 用 CSS `transform: scale(k)`。
 * 用 `offsetWidth/offsetHeight` 也能避开缩放，但它在 jsdom 里恒为 0
 * （测试环境量不到尺寸会退化成兜底值），所以这里仍用 rect、再除以系数。
 *
 * @param wrap - 画布容器元素。
 * @returns 节点 id → 尺寸表（量不到的节点不在表里）。
 */
export function measureNodes(wrap: HTMLElement | null): Map<string, { w: number, h: number }> {
  const out = new Map<string, { w: number, h: number }>()
  if (wrap === null) return out
  const k = zoomOf(wrap)
  for (const el of wrap.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')) {
    const id = el.dataset.id
    if (id === undefined) continue
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) out.set(id, { w: r.width / k, h: r.height / k })
  }
  return out
}

/**
 * 量出各节点卡片里**输出面板**的高度（画布坐标）。
 *
 * ## 为什么要单独量它
 *
 * 「让位」要回答「这个节点比**素净的卡片**高了多少」。素净卡片的基准高
 * 是取实测高度的**众数** —— 而画布一跑起来，一堆节点同时挂着输出面板，
 * 众数就变成「卡片 + 面板」，于是每个节点的「高了多少」都算成 0，
 * 让位**整个失效且不报错**（看着就是「没反应」）。
 *
 * 所以先量出面板高度、从实测高里减掉，才拿得到「卡片本身多高」。
 * 与 `measureNodes` 同一条纪律：**必须除掉画布缩放**（见那里的长注释）。
 *
 * @param wrap - 画布容器元素。
 * @returns 节点 id → 面板高度（没有面板的节点不在表里）。
 */
export function measureRunPanels(wrap: HTMLElement | null): Map<string, number> {
  const out = new Map<string, number>()
  if (wrap === null) return out
  const k = zoomOf(wrap)
  const sel = '.react-flow__node[data-id]'
  for (const el of wrap.querySelectorAll<HTMLElement>(sel)) {
    const id = el.dataset.id
    if (id === undefined) continue
    const panel = el.querySelector<HTMLElement>('[data-ewb-run-panel]')
    if (panel === null) continue
    const h = panel.getBoundingClientRect().height / k
    if (h > 0) out.set(id, h)
  }
  return out
}

/**
 * 取画布当前的缩放系数。
 *
 * 从 React Flow 的 viewport 元素读——它带着 `transform: matrix(a,b,c,d,e,f)`，
 * `a`（或 `d`）就是缩放。读不到就当作 1（不缩放），**不抛错**：
 * 这个值只影响尺寸精度，不值得让布局挂掉。
 *
 * @param wrap - 画布容器元素。
 * @returns 缩放系数（> 0）。
 */
function zoomOf(wrap: HTMLElement): number {
  const vp = wrap.querySelector<HTMLElement>('.react-flow__viewport')
  if (vp === null) return 1
  /* ⚠️ `window` 可能不存在（纯 Node 单测环境）——这个模块被 `elk-layout` 直接 import，
   * 所以凡是用到浏览器全局的地方都要先判存在（与本文件其它地方同一套防护）。 */
  const computed = typeof window === 'undefined' ? '' : window.getComputedStyle(vp).transform
  const m = /matrix\(([^)]+)\)/.exec(vp.style.transform) ?? /matrix\(([^)]+)\)/.exec(computed)
  if (m === null) return 1
  const a = Number(m[1].split(',')[0])
  return Number.isFinite(a) && a > 0 ? a : 1
}