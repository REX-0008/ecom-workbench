/** 画布的**纯逻辑帮手**（不碰 React 状态、不碰组件）。
 *
 * ## 为什么单独一个文件（2026-10-17 拆，Step 5 的「大文件拆分」）
 *
 * `WorkflowCanvas.tsx` 是 3700 行的组件文件，顶上还压着两百行与组件无关的纯函数
 * （端口名的中文表、分组框占位定义、深色探测、跨容器连线提示、容器取名、名字截断）。
 * 它们改起来与组件毫无关系，却要和 3000 行挤在同一个文件里翻。
 *
 * ⚠️ **这里只放「输入 → 输出」的纯函数**。任何要用 `useState` / 引用 DOM 的东西仍留在组件里 ——
 * 搬进来只会让这个文件变成第二个大杂烩。
 */
import { V1NodeCard, type V1Node } from './WorkflowNode.tsx'
import { GroupNodeCard } from './GroupNode.tsx'
import type { NodeTypes, Connection, Edge } from '@xyflow/react'
import type { NodeDef, PortType } from '../../workflow/model.ts'

/** 端口类型的中文名（图例用）。 */
export const PORT_TYPE_LABEL: Record<PortType, string> = {
  data: '数据',
  text: '文本',
  image: '图片',
  number: '数字',
  any: '任意',
}

/**
 * 分组框的占位「节点定义」。
 *
 * 分组框**不是可运行的节点**——它只是一块可拖动的背景 + 标题，用来把一组节点框在一起。
 * 但 React Flow 的每个节点都要有 data，而我们节点的 data 里带 def，
 * 所以给它一个这样的空定义：不参与派发、没有端口。
 */
export const GROUP_DEF: NodeDef = {
  id: '__group',
  label: '分组',
  executor: 'builtin',
  inputs: [],
  outputs: [],
}

/**
 * 探测当前是不是深色主题。
 *
 * **dsh 的真实机制**（已核实源码 `packages/client/ui-theme/src/boot-theme.ts:31-33`）：
 *   - `document.body` 上的 **`data-ds-dark-theme` 属性**（有没有它 = 是不是深色）
 *   - `<html>` 上的 `data-ds-theme-source` 是**用户偏好**（light / dark / system）
 *   - `<html>` 的 `color-scheme` 也会跟着设（light / dark）
 *
 * ⚠️ 我第一版写的是 `data-theme` / `class="dark"`——**dsh 两个都不用**，
 *    所以那个探测永远不会命中，只能落到系统偏好上，等于没跟随 dsh 设置。
 *
 * 按优先级取：dsh 的属性 → color-scheme → 系统偏好兜底。
 *
 * @returns 是深色则 true。
 */
export function detectDark(): boolean {
  if (typeof document === 'undefined') return true
  /* ① dsh 的权威标记：body 上有 data-ds-dark-theme 就是深色。 */
  const body = document.body
  if (body !== null && body.hasAttribute('data-ds-dark-theme')) return true
  /* ② html 的 color-scheme（dsh bootstrap 会设）。 */
  const scheme = document.documentElement.style.colorScheme
  if (scheme === 'dark') return true
  if (scheme === 'light') return false
  /* ③ 兜底：系统偏好。
   * 要防 matchMedia 不存在——测试环境（jsdom）没有它，真实浏览器有。 */
  if (typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export const CAT_COLOR: Record<string, string> = {
  flow: '#8b93ff',
  collect: '#f0b429',
  browser: '#e5709b',
  code: '#4ec9b0',
  ecom: '#ff8f5e',
  terminal: '#9aa7bd',
  data: '#4fd6ff',
  ai: '#c792ea',
  other: '#6b7794',
}

export const NODE_TYPES: NodeTypes = { v1: V1NodeCard, group: GroupNodeCard }

/**
 * 这条线跨了循环框吗？跨了就返回一句说明，没跨返回空串。
 *
 * ## 为什么要有它（用户 2026-10-17 问的）
 *
 * > 「循环外的节点直接连循环内的节点是否是合法的？如果是合法的，
 * >   意思是循环内的节点没有连线到循环这个节点是什么意思？循环内的节点末尾是否可以连接外部？」
 *
 * 答案是**都合法、都有意义**，但**连线校验完全不管容器**
 * （`connection-rules.ts` 只管自己连自己 / 成圈 / 单入口 / 类型）。
 * 所以用户拖完一条跨容器的线，界面上**看不出它意味着什么** —— 这里补一句。
 *
 * 语义（与 `src/workflow/run.ts` 的 `upstreamOf` 一致）：
 *   - **外 → 内**：体内节点多了一条**显式上游**，它会读到外层的输出；
 *   - **内 → 外**：框外的下游照常拿到**本轮**的结果（每轮都会流出去）；
 *   - 循环节点自己**接不接上游都能跑**（数据本来可以从参数来），
 *     接了只是多一层先后顺序。
 *
 * @param conn - 待校验的连接。
 * @param nodes - 当前全部节点。
 * @returns 提示文字；不跨容器返回空串。
 */
export function crossContainerHint(
  conn: Connection | Edge,
  nodes: readonly { id: string, parentId?: string }[],
): string {
  const ownerOf = (id: string | null | undefined): string | undefined =>
    nodes.find(n => n.id === id)?.parentId
  const a = ownerOf(conn.source)
  const b = ownerOf(conn.target)
  /* 同一个框里、或两边都没框 —— 不提示。 */
  if (a === b) return ''
  const loopName = (owner: string | undefined): string => {
    if (owner === undefined) return '循环外'
    const label = nodes.find(n => n.id === owner) as { label?: string } | undefined
    return '「' + (label?.label ?? owner) + '」里'
  }
  if (a === undefined && b !== undefined) {
    return '这条线从' + loopName(a) + '连到' + loopName(b) + '的节点：'
      + '循环体内那个节点会把它当作「显式上游」（能读到外层的这份输出）。'
  }
  if (a !== undefined && b === undefined) {
    return '这条线从' + loopName(a) + '的节点连到' + loopName(b) + '：'
      + '每一轮的结果都会流到框外，下游会逐轮收到。'
  }
  return '这条线跨了两个循环框：两个框各自算自己那一轮，'
    + '数据按连线的先后传递（跨框连线合法，但容易被误读，确认是否符合预期）。'
}

/**
 * 取容器（分组框 / 循环框）的**显示名**，用于提示与菜单文案。
 *
 * ## 为什么要抽出来（原来同一段在本文件里抄了 3 份）
 *
 * 三处写法逐字相同（`owner.type === 'group' ? groupLabel : label ?? def.label`）——
 * 改一处忘另两处，就会出现「提示里叫 A、菜单里叫 B」这种自相矛盾的界面。
 *
 * 取名规则：
 *   - 分组框 → 它的自定义名（`groupLabel`），没起名就叫「分组」；
 *   - 循环等其它容器 → 实例名（`label`），没有就退回类型名（`def.label`）；
 *   - 找不到那个节点 → 「容器」（兜底，不让文案里出现空字符串）。
 *
 * @param nodes - 全部节点。
 * @param id - 容器 id。
 * @returns 显示名。
 */
export function containerName(nodes: readonly V1Node[], id: string): string {
  const owner = nodes.find(n => n.id === id)
  if (owner === undefined) return '容器'
  if (owner.type === 'group') return owner.data.groupLabel ?? '分组'
  return owner.data.label ?? owner.data.def.label
}

/**
 * 工具条上显示工作流名时的截断（太长的名字会把工具条挤垮）。
 *
 * @param name - 归属名。
 * @returns 显示用的一小段（超长则在够显示双字节字符的地方截断）。
 */
export function namePreview(name: string): string {
  /* 截断用**码点**计数，不是 `slice(0, n)` —— 后者按 UTF-16 单元切，
   * 中文没问题，但 emoji（代理对）会被切成半个字符，屏幕上是一个乱码方块。
   * 用户给工作流起名时完全可能带 emoji。 */
  const chars = [...name]
  if (chars.length <= 22) return name
  return chars.slice(0, 21).join('') + '…'
}
