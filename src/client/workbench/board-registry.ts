/** 板块注册表：**工作台的骨架只认这个注册表，不认任何具体板块**。
 *
 * ## 为什么要有它（用户 2026-10-21 定的）
 *
 * 原先是 `boards.ts` 里一张写死的清单 + `EcomWorkbench.tsx` 里一串
 * `tab === 'workflow.canvas' ? … : …` 的分支。后果：**每加一个板块、每改一次顺序，
 * 都要动骨架代码**；别的插件想插一块界面，只能来改我们这张表。
 *
 * 现在骨架只做四件事：取注册表 → 按 order 排序 → 画左栏导航 → 渲染当前板块的 component。
 * 八个默认板块与第三方插件**走同一个 registerBoard**，没有特权通道。
 *
 * ## 做法照 dock-base（本机 `profiles/desktop/node_modules/dock-base/lib/types/client/contract.d.ts`）
 *
 * 注册时**直接传 React 组件**：不用 iframe、不用动态加载 bundle。
 * 好处是同进程、同 React 运行时、样式统一，没有跨窗口通信；
 * 代价如实记：**React 版本必须一致（18）**，对方组件的样式冲突由它自己负责。
 * 另有一条硬规矩：**每个注册的板块外面强制包一层 ErrorBoundary**（见 EcomWorkbench.tsx）——
 * 一个板块渲染抛错不该白屏整个工作台。
 *
 * ## 接入说明
 *
 * 给第三方看的完整说明在 `docs/指引-插件接入.md`；这里只保证那份文档承诺的形状能兑现。
 */
import { createElement } from 'react'
import type { ComponentType, ReactNode } from 'react'
import type { IconProps } from './icons.tsx'

/** 板块里的一个 tab。 */
export interface BoardTab {
  /** tab 标识（只需在**本板块内**唯一）。 */
  id: string
  /** 显示文字。 */
  label: string
  /**
   * 这一格**一旦打开过就一直挂载**，切走只是藏起来（`opacity`），不卸载。
   *
   * 为什么需要它：画布的节点与连线是组件内的 `useState`，卸载即丢；
   * 而撤销栈是模块级 store、不随卸载销毁 —— 卸载后切回来「屏幕」与「历史」对不上。
   * 详见 `EcomWorkbench.module.css` 的 `.pane` 注释（四条坑）。
   *
   * 用**声明**而不是「骨架里判断某个 id」：这样骨架仍然不知道有哪些板块。
   *
   * ⚠️ **可以有多格**（2026-10-25 契约 AU）：骨架把它当集合处理
   * （`keptTabsOf` 用 `filter` 不是 `find`），非激活时**全部**保留挂载。
   * 以前只有一个板块声明它，`.find()` 恰好够用；内容板块加进来之后就撞了。
   */
  keepMounted?: boolean
  /**
   * 这一格**在运行时出现 / 消失**（2026-10-25 契约 AU）。
   *
   * ## 它解决什么
   *
   * 「打开一份画布，tab 条上才多出一格」—— 而这种「该不该显示」板块自己知道，
   * 骨架不知道（骨架不许认识任何板块的 id）。
   *
   * ## 谁说了算：**板块上报，骨架只过滤**
   *
   * 板块通过 `BoardProps.onTabsChange` 报「现在哪几格该显示」。
   * `dynamic: true` 的格子**只**听那份上报；没有 `dynamic` 的格子**永远显示**
   * （骨架管不着它）。
   *
   * ## 默认值（这是硬要求，别改）
   *
   * 没上报过 → 按注册时的 `tabs` **全显示**。所以现有七个板块
   * **一行都不用改**：它们不传 `onTabsChange`，也就永远走「全显示」这一支。
   *
   * ⚠️ 与 `keepMounted` 是两件独立的事：一个管「在不在 tab 条上」，
   * 一个管「切走后卸不卸载」。动态格可以被隐藏但仍然常驻（画布就是这样）。
   */
  dynamic?: boolean
}

/** 注册时交给板块组件的入参。 */
export interface BoardProps {
  /**
   * 这一块是不是正显示着。
   *
   * ⚠️ 常驻挂载的格子（`keepMounted`）在切走之后**仍然挂载**，只是 `active: false` ——
   * 不是就别轮询、别接全局键盘（否则用户在别的界面上按键会改到看不见的画布上）。
   */
  active: boolean
  /** 当前 tab（本板块没有 tab 时为空串）。 */
  tab: string
  /** 本插件的路由前缀（取数/巡查/存档这些接口都在它下面）。 */
  apiBase: string
  /** 顶部（面包屑 + 大标题）是否收起。 */
  topHidden: boolean
  /** 收起/展开顶部。 */
  onToggleTop: () => void
  /** 切到本板块的某一格 tab。 */
  onSelectTab: (tabId: string) => void
  /** 直接跑一份工作流（传工作流名），板块不必自己写跑法。 */
  onRunWorkflow: (name: string) => void
  /**
   * 本板块里**声明了常驻**的那些格子（2026-10-25 契约 AU，**可选**）。
   *
   * ## 为什么要把这个告诉板块
   *
   * 板块切走之后仍然挂着（常驻），但它**不该**把「当前选中的那一格」也画出来 ——
   * 那会让后台藏着的界面仍然在 DOM 里（点击、文字、计数都会串）。
   * 所以骨架把「哪几格必须留」告诉它，由板块自己只画那几格、其余不渲染。
   *
   * ## 为什么是数组
   *
   * 一个板块可以有多格常驻（内容板块就有）。以前只能表达一格，
   * 靠 `tab` 传一个 id 凑合；现在传全量，板块按集合判断。
   *
   * @defaultValue 空数组（没声明的板块拿到的就是空数组）
   */
  keptTabs?: readonly string[]
  /**
   * 上报「现在哪几格该显示」（2026-10-25 契约 AU，**可选**）。
   *
   * ## 只影响标了 `dynamic: true` 的格子
   *
   * 骨架按这份清单过滤 tab 条：在清单里的显示、不在的隐藏。
   * 没标 `dynamic` 的格子**不看这份清单** —— 上报了也不影响它们。
   *
   * ## 不传会怎样
   *
   * **什么都不发生**：没上报过就按注册时的 `tabs` 全显示。
   * 这是现有七个板块「一行都不用改」的保证（它们全都不传）。
   *
   * @param visible - 该显示的 tab id（顺序无关，骨架按注册顺序排）。
   */
  onTabsChange?: (visible: readonly string[]) => void
}

/** 一次注册要交的东西。 */
export interface BoardRegistration {
  /** 唯一标识，建议带前缀：`'myplugin.materials'`。重复注册时**后注册的替换先注册的**。 */
  id: string
  /** 左栏显示的名字（也用作面包屑与标题）。 */
  title: string
  /** 左栏图标：组件，或 `{ path: 'M…' }` 的 SVG 路径。省略则不留图标位。 */
  icon?: BoardIcon
  /** 排序，小的在前；省略 = 100。 */
  order?: number
  /** 侧栏里的分组名（省略 = 不分组）。同名相邻的会归到一组。 */
  group?: string
  /** 板块内的 tab；省略/空 = 不画 tab 条，内容直接铺满。 */
  tabs?: readonly BoardTab[]
  /**
   * 整块**常驻挂载**（切走不卸载，只藏起来）。
   *
   * ## 为什么这个字段必须补进类型（2026-10-23）
   *
   * 骨架的 `keepsMounted()`（`EcomWorkbench.tsx:171`）一直在读它：
   * `b.keepMounted === true || (b.tabs ?? []).some(t => t.keepMounted === true)`。
   * 但 `BoardRegistration` 里**没有声明这个字段** —— 于是给 `bi` 加上
   * `keepMounted: true` 时报 `TS2353: 'keepMounted' does not exist in type
   * 'BoardRegistration'`。
   *
   * 那是一条**类型缺口**，不是「这个功能不能用」：画布一直靠 `tabs[i].keepMounted`
   * 走同一条判断（那条路绕过了这层类型），所以缺字段从来没暴露出来。
   *
   * ⚠️ 补它只是把**已有行为**写进类型，**没有改任何运行期逻辑**：
   * 骨架的判断、CSS 的隐藏规则（`.boardPane` / `.pane` 那四条）一处都没动。
   */
  keepMounted?: boolean
  /** 板块内容组件。**同步组件**（暂不支持懒加载）。 */
  component: ComponentType<BoardProps>
}

/**
 * 图标可以是三种形态（照 dock-base 的 IconRef，只收这两种 + 任意现成节点）：
 *   · **组件**（内置那套 icon 都是）—— 由我们传 size 进去；
 *   · **SVG 路径** `{ path: 'M…' }` —— 我们替你画成 24×24、用 currentColor 填充；
 *   · **任意现成节点**（emoji、`<svg>`、字符串）—— 原样放进导航项。
 */
export type BoardIcon =
  | ((props: IconProps) => React.JSX.Element)
  | { path: string, viewBox?: string }
  | ReactNode

/** 注册表里的一条（对外只读）。 */
export interface RegisteredBoard extends BoardRegistration {
  /** 排好序用的最终值（省略时已填上 100）。 */
  order: number
}

/** 省略 order 时的默认值（照 dock-base：默认 100）。 */
const DEFAULT_ORDER = 100

/**
 * 注册项本体。`seq` 是注册次序，用来在同 order 时保持稳定排序
 * （没有它，排序结果取决于 Map 的实现细节，第三方插入一块界面就可能让别人的顺序乱跳）。
 */
const items = new Map<string, { def: BoardRegistration, seq: number }>()

/** 注册次序计数（同 order 的稳定排序依据）。 */
let seq = 0

/**
 * 排好序的快照。
 *
 * ⚠️ **必须缓存成一个稳定的引用**：`useSyncExternalStore` 每帧都拿它比，
 * 每次 getSnapshot 都新建数组的话会「永远觉得变了」→ 无限重渲染（本项目踩过这类坑）。
 */
let snapshot: readonly RegisteredBoard[] = []

/** 订阅者（注册表变化时通知骨架重渲染）。 */
const listeners = new Set<() => void>()

/**
 * 重算快照并通知订阅者。
 */
function rebuild(): void {
  snapshot = [...items.values()]
    .sort((a, b) => (a.def.order ?? DEFAULT_ORDER) - (b.def.order ?? DEFAULT_ORDER) || a.seq - b.seq)
    .map(x => ({ ...x.def, order: x.def.order ?? DEFAULT_ORDER }))
  for (const fn of listeners) fn()
}

/**
 * 注册一个板块。
 *
 * @param def - 板块定义。
 * @returns **反注册函数**。交给 `ctx.effect(...)`，插件停用或热更新时自动摘掉 ——
 *          不交的话热更新后会出现两个同名板块。
 */
export function registerBoard(def: BoardRegistration): () => void {
  if (def.id === '') throw new Error('registerBoard: id 不能为空')
  /* 同 id 重复注册 = 替换（热更新会重新跑一遍注册代码，不能因此报错或叠出两块）。 */
  seq += 1
  items.set(def.id, { def, seq })
  rebuild()
  return () => {
    /* 只摘自己那一次：热更新后旧的反注册函数可能在新项之后才被调用，
     * 不能把新的那一份一起删掉。 */
    const cur = items.get(def.id)
    if (cur !== undefined && cur.def === def) {
      items.delete(def.id)
      rebuild()
    }
  }
}

/**
 * 取当前注册表快照（已按 order 排好）。
 *
 * @returns 只读数组（引用稳定，可直接给 useSyncExternalStore）。
 */
export function getBoards(): readonly RegisteredBoard[] {
  return snapshot
}

/** 订阅注册表变化前先给一次快照 —— 供 `useSyncExternalStore` 的 getServerSnapshot。 */
export function getBoardsServer(): readonly RegisteredBoard[] {
  return snapshot
}

/**
 * 订阅注册表变化。
 *
 * @param fn - 变化回调。
 * @returns 退订函数。
 */
export function subscribeBoards(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * 渲染一个板块图标（组件或 SVG 路径两种形态都接）。
 *
 * 颜色用 `currentColor`，跟随导航项的选中态/主题 —— 与内置图标同一套表现。
 *
 * @param icon - 注册时给的图标。
 * @param size - 边长 px。
 * @returns 可渲染的节点；没给图标时返回 null。
 */
export function renderBoardIcon(icon: BoardIcon | undefined, size = 15): ReactNode {
  if (icon === undefined || icon === null) return null
  if (typeof icon === 'function') return createElement(icon, { size })
  /* 不是函数、也没有 path 键 → 当作现成的节点原样交出去（emoji / 自己画的 svg）。 */
  if (typeof icon !== 'object' || (icon as { path?: string }).path === undefined) return icon as ReactNode
  const spec = icon as { path: string, viewBox?: string }
  return createElement('svg', {
    xmlns: 'http://www.w3.org/2000/svg',
    width: size,
    height: size,
    viewBox: spec.viewBox ?? '0 0 24 24',
    fill: 'currentColor',
    'aria-hidden': 'true',
    focusable: 'false',
  }, createElement('path', { d: spec.path }))
}
