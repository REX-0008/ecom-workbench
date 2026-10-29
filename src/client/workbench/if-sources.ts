/** 「条件判断」节点左边能选什么 —— **纯逻辑**（不碰 React、不碰画布状态）。
 *
 * ## 为什么搬出画布
 *
 * 三组候选（上游节点的字段 / 循环变量 / 开始节点的输入）原来写在
 * `WorkflowCanvas.tsx` 的 `useMemo` 里，而那个文件 import 了 `.module.css`
 * —— Node 直接跑不起来（`ERR_UNKNOWN_FILE_EXTENSION`），于是**这段逻辑测不到**。
 * 它的三条规则都容易错，而且错了表现为「界面上能选、跑起来取不到」：
 *
 *   ① **只给上游**（不给下游、不给同容器的兄弟）—— 用户原话
 *      「IF 前面的节点就是传入信息的」；
 *   ② **循环变量按层给**（`item` / `index` / `outer.item` / `outer.outer.item`）；
 *   ③ **开始节点的输入项**必须与调度器**同一个解析器**（`parseInputFields`）。
 *
 * 所以规则搬到这里（`canvas-graph.ts` 那个先例），画布只负责把清单递给控件。
 *
 * ## 与节点定义的分工
 *
 * 这里只回答「有哪些值可选」；「选了之后怎么取值」在执行侧
 * （`run.ts` 的 `ifPlanOf` → `if-condition.ts` 的 `resolveOperand`）。
 * 两边用同一套名字（`item` / `outer.item` / 输入项名 / `nodeId:field`），
 * 所以界面上给得出的，跑起来一定取得到 —— 这条一致性由 `tests/if-sources.mjs` 钉住。
 */
import { loopChainDepth, LOOP_DEF_ID } from '../../workflow/loop.ts'
import { parseInputFields } from '../../workflow/io-fields.ts'
/* 「开始」节点的定义 id —— 直接引调度器那一份常量，**不在这里再写一遍**：
 * 两处各写一个字面量的话，改名时一处会漏，症状是「条件里选不到开始节点的输入」。 */
import { START_DEF_ID } from '../../workflow/run.ts'
export { START_DEF_ID }

/** 一个候选节点（能选它的哪个字段）。 */
export interface IfFieldCandidate {
  /** 节点实例 id。 */
  id: string
  /** 显示名（实例名优先，退回类型名）。 */
  name: string
  /** 字段清单（它的输出端口）。 */
  fields: readonly { id: string, label: string }[]
}

/** 条件左边能选的三种来源。 */
export interface IfSources {
  /** 上游节点（含它们各自可选的字段）。 */
  fields: IfFieldCandidate[]
  /** 循环变量名（不在循环里时是空数组）。 */
  loopVars: string[]
  /** 「开始」节点声明并解析好的输入项名字。 */
  inputs: string[]
}

/** 计算时只要这些字段（画布的 `V1Node` 结构上就满足，便于单测伪造）。 */
export interface IfSourceNode {
  id: string
  /** 实例名（`data.label`，空串 = 没改过名）。 */
  label?: string
  /** 节点类型 id（`data.def.id`）。 */
  defId: string
  /** 容器的对外标识（`data.def.label`，用于显示名兜底）。 */
  defLabel: string
  /** 它的输出端口（可选字段的来源）。 */
  fields: readonly { id: string, label: string }[]
  /** 容器归属。 */
  parentId?: string
}

/** 一条连线的最小形状。 */
export interface IfSourceEdge {
  source: string
  target: string
}

/**
 * 节点显示名：改过名用改名，否则用类型名。
 *
 * @param n - 节点。
 * @returns 显示名。
 */
function nameOf(n: IfSourceNode): string {
  const custom = typeof n.label === 'string' ? n.label.trim() : ''
  return custom !== '' ? custom : n.defLabel
}

/**
 * 这个节点在哪个循环里、能写哪些循环变量。
 *
 * 规则与执行期一致（`loopVarFields` 沿 `parent` 链拼 `outer`）：
 * 第 1 层是 `item` / `index`，往外每层多一个 `outer.` 前缀。
 * 所以「界面给得出的名字」与「跑起来取得到的名字」是同一套。
 *
 * @param nodes - 全部节点。
 * @param n - 要算的那个节点。
 * @returns 可用的变量名（不在循环里时是空数组）。
 */
export function loopVarsOf(nodes: readonly IfSourceNode[], n: IfSourceNode): string[] {
  if (n.parentId === undefined) return []
  const depth = loopChainDepth(
    nodes.map(x => ({ id: x.id, defId: x.defId, parentId: x.parentId })),
    n.parentId,
  )
  if (depth <= 0) return []
  const names: string[] = []
  for (let k = 0; k < depth; k += 1) {
    const prefix = k === 0 ? '' : 'outer.'.repeat(k)
    names.push(prefix + 'item', prefix + 'index')
  }
  return names
}

/**
 * 「开始」节点声明了哪些输入项。
 *
 * ⚠️ 用 `parseInputFields` 这**同一个**解析器（调度器那边也用它）——
 * 另写一套会让「界面能选、跑起来取不到」。一份工作流最多一个开始节点
 * （两个会明确报错），所以取第一个就够。
 *
 * @param nodes - 全部节点（要看它们的参数）。
 * @param paramsOf - 取某个节点的参数（测试里给个假函数即可）。
 * @returns 输入项名字（没有开始节点时是空数组）。
 */
export function startInputNames(
  nodes: readonly { id: string, defId: string }[],
  paramsOf: (id: string) => Record<string, unknown>,
): string[] {
  const start = nodes.find(x => x.defId === START_DEF_ID)
  if (start === undefined) return []
  return parseInputFields(paramsOf(start.id).fields).map(f => f.name)
}

/**
 * 这个节点**能选到**哪些上游节点。
 *
 * 沿入边往上走到不动点（带环保护），只返回能走到的那些。
 * **不含自己、不含下游、不含同容器的兄弟** —— 与循环的 `fieldCandidates`
 * （那里要「上游 ∪ 兄弟」）刻意不同：IF 判的是「前面传来的东西」。
 *
 * @param nodes - 全部节点。
 * @param edges - 全部连线。
 * @param nodeId - 要算的那个节点。
 * @returns 上游节点 id 集合。
 */
export function upstreamOf(
  nodes: readonly { id: string }[],
  edges: readonly IfSourceEdge[],
  nodeId: string,
): Set<string> {
  const seen = new Set<string>()
  const stack = edges.filter(e => e.target === nodeId).map(e => e.source)
  /* 防环：走不了超过「节点数 + 1」步（存档被手改出错环时不能死循环）。 */
  let guard = nodes.length + 1
  while (stack.length > 0 && guard > 0) {
    const cur = stack.pop() as string
    guard -= 1
    if (seen.has(cur) || cur === nodeId) continue
    seen.add(cur)
    for (const e of edges) if (e.target === cur) stack.push(e.source)
  }
  return seen
}

/**
 * 一个节点的三组可选来源（条件左边下拉的内容）。
 *
 * @param nodes - 全部节点。
 * @param edges - 全部连线。
 * @param nodeId - 要算的那个节点。
 * @param paramsOf - 取某节点的参数（给「开始节点的输入项」用）。
 * @returns 三组来源。
 */
export function ifSourcesFor(
  nodes: readonly IfSourceNode[],
  edges: readonly IfSourceEdge[],
  nodeId: string,
  paramsOf: (id: string) => Record<string, unknown>,
): IfSources {
  const ups = upstreamOf(nodes, edges, nodeId)
  const self = nodes.find(x => x.id === nodeId)
  return {
    fields: nodes
      .filter(x => ups.has(x.id))
      .map(x => ({ id: x.id, name: nameOf(x), fields: x.fields })),
    loopVars: self === undefined ? [] : loopVarsOf(nodes, self),
    inputs: startInputNames(nodes, paramsOf),
  }
}

/**
 * 一个**循环**的「跳出条件」能选哪些值（2026-10-19 加）。
 *
 * ## 与 `ifSourcesFor` 的两处关键不同（别照抄）
 *
 * | | `ifSourcesFor`（条件判断节点） | `breakSourcesFor`（循环的跳出条件） |
 * |---|---|---|
 * | `fields` | 它的**上游**节点 | **循环体内**的节点（`parentId === 循环 id`） |
 * | `loopVars` | 它自己所在层的变量 | 这个**循环自己**那层 + 往外各层的变量 |
 *
 * 为什么 `fields` 要换成「体内节点」：跳出条件判的是「**这一轮跑得怎么样**」——
 * 用户要的那个真实场景是「连续 2 天失败就停这个模块」，
 * 而那个「失败」是体内某个节点（如下载节点）本轮的输出。
 * 循环外面的节点跟「这一轮跑成什么样」无关，列进来只会让人选错。
 *
 * 为什么 `loopVars` 取这个循环自己：跳出条件是在**每一轮之内**判的
 * （`run.ts` 的 `breakRuleFor(ctx)` 拿到的 `ctx.loopVars` 就是这个循环本轮那份），
 * 所以条件里写 `{{item}}` 取的是**这个循环**的本轮项。
 *
 * ⚠️ **不能拿 `loopVarsOf(nodes, loop)` 换掉它**（船长 2026-10-19 建议按
 * `parentId` 算 —— 那是错的，正好差一层）：`loopVarsOf` 算的是「一个节点**所在**的层」，
 * 对循环节点本身来说等于算它**外面**那层 —— 顶层循环的 `parentId` 是 `undefined`，
 * 会得到 `[]`，于是顶层循环的跳出条件一个变量都选不到，而它的**体内**明明有
 * `item` / `index`。所以这里用 `ownLayerLoopVars`（`loopChainDepth` 把循环自己算一层）。
 *
 * **判据是「跑起来取得到什么」，不是「界面上叫什么」**：`run.ts` 的 `breakRuleFor`
 * 传的 `ctx` 带着本轮的 `loopVars: { item, index }` 与 `parent`，
 * `loopVarFields(ctx)` 展开成 `{ item, index, outer: {...} }` ——
 * 与 `ownLayerLoopVars` 给的名单逐个对得上。这套一致性由 `tests/if-sources.mjs` ④ 钉住。
 *
 * ⚠️ **不含循环自己**：循环节点自身不在 `parentId === 自己` 的集合里，天然排除。
 * 它是个会产出结果的节点（`done` 端口），但那一轮还没跑完、取不到值。
 *
 * ⚠️ **不含体内嵌套的子循环**（`defId !== LOOP_DEF_ID`）：内层循环的输出是
 * `{ count, results, picked? }` 这种**聚合对象**，而这里的字段下拉给的是节点**端口**
 * （对循环就是 `done` 一个口），选它只能拿到整个对象、够不着里面的 `count` / `results`，
 * 配「大于 / 为空」这类比较符等于一个死胡同。真要「内层一条都没跑出来就停外层」，
 * 在内层后面接一个 `code.js` 算一个布尔再判。
 *
 * @param nodes - 全部节点。
 * @param loopId - 这个循环的节点 id。
 * @param paramsOf - 取某节点的参数（给「开始节点的输入项」用）。
 * @returns 三组来源。
 */
export function breakSourcesFor(
  nodes: readonly IfSourceNode[],
  loopId: string,
  paramsOf: (id: string) => Record<string, unknown>,
): IfSources {
  const loop = nodes.find(x => x.id === loopId)
  return {
    /* ★ 体内节点（直接子节点），**排除体内嵌套的子循环**（理由见函数头）。 */
    fields: nodes
      .filter(x => x.parentId === loopId && x.defId !== LOOP_DEF_ID)
      .map(x => ({ id: x.id, name: nameOf(x), fields: x.fields })),
    /* 循环自己那层的变量名。
     *
     * ⚠️ **不能直接调 `loopVarsOf(nodes, loop)`**：那个函数算的是「这个节点
     * **所在**的层」（它看 `n.parentId`），对循环节点来说等于算它**外面**那层。
     * 举例：顶层循环 L1 的 `parentId` 是 undefined → `loopVarsOf` 返回 `[]`，
     * 而它的**体内**明明有 `item` / `index`（体内节点是第 1 层）。
     * 所以这里要按「循环自己算不算一层」来数：`loopChainDepth(nodes, loopId)`。 */
    loopVars: loop === undefined ? [] : ownLayerLoopVars(nodes, loopId),
    inputs: startInputNames(nodes, paramsOf),
  }
}

/**
 * 一个**循环自己那层**可见的循环变量名。
 *
 * 与 `loopVarsOf` 的区别只在一处起点：那个算「节点所在的层」（看 `parentId`），
 * 这个算「循环本身是第几层」（`loopChainDepth` 把循环自己也算进去）。
 *
 * 为什么要区分：循环的「跳出条件」判的是**它的体内这一轮**，所以变量名要按
 * 它自己那层给，否则顶层循环会一个都拿不到（`loopVarsOf` 对顶层返回 `[]`）。
 *
 * @param nodes - 全部节点。
 * @param loopId - 循环节点 id。
 * @returns 变量名（第 1 层 `item`/`index`，往外每层一个 `outer.` 前缀）。
 */
export function ownLayerLoopVars(nodes: readonly IfSourceNode[], loopId: string): string[] {
  const depth = loopChainDepth(nodes.map(x => ({ id: x.id, defId: x.defId, parentId: x.parentId })), loopId)
  if (depth <= 0) return []
  const names: string[] = []
  for (let k = 0; k < depth; k += 1) {
    const prefix = k === 0 ? '' : 'outer.'.repeat(k)
    names.push(prefix + 'item', prefix + 'index')
  }
  return names
}
