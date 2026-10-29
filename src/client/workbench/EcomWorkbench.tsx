/** 电商工作台 · 主界面（右列叠加形式）。
 *
 * ## 骨架只做四件事（用户 2026-10-21 定的）
 *
 *   **取注册表 → 按 order 排序 → 画左栏导航 → 渲染当前板块的组件。**
 *
 * 这个文件里**不许出现任何具体板块的 id**：想加板块、改顺序、让别的插件插一块界面，
 * 都只动注册表（board-registry.ts + 默认板块的注册文件 boards.ts），不动这里。
 * （以前是一张写死的清单 + 一串按 tab 名分岔的渲染分支，每加一个板块都要来改骨架。）
 *
 * ## 版式（照 FounderOS-DEMO 的侧栏 + 内容区）
 *
 *   左栏＝一层平铺的板块导航（按 group 分组）+ 底部按钮；
 *   右栏＝面包屑 → 板块标题 → SlidingTabs 滑动 tab 条 → 板块内容。
 * 与 dsh 对话区共存：工作台作为右列叠加在对话列内，对话区可隐藏但仍在。
 * 布局基准＝对话列（centerCol），用 CSS 变量 --ewb-* 驱动。
 *
 * ## 两条不能弄坏的机制
 *
 *  ① **每个板块外面强制包一层 ErrorBoundary** —— 第三方组件的渲染异常只坏它那一块，
 *     不白屏整个工作台。这是接入契约的一部分（见 docs/指引-插件接入.md）。
 *  ② **画布常驻挂载** —— 板块可以在注册时说 keepMounted：它一旦被打开过就一直挂载，
 *     非当前时用 opacity 藏起来（不是卸载、不是 display:none）。
 *     四条坑全写在 EcomWorkbench.module.css 的 .pane / .boardPane 注释里。
 */
import { createElement as h, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getBoards, getBoardsServer, subscribeBoards, renderBoardIcon } from './board-registry.ts'
import type { BoardProps, BoardTab, RegisteredBoard } from './board-registry.ts'
/* ⚠️ 只为**副作用**注册：这份文件加载时把八个默认板块交进注册表。
 * 骨架本身不读它导出的任何东西 —— 那正是「骨架不知道有哪些板块」的意思。 */
import './boards.ts'
import { SlidingTabs } from './SlidingTabs.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import { runWorkflowFile, readUiPrefsCache, saveUiPrefs, subscribeUiPrefs, ensureUiPrefsLoaded, adoptUiPrefs } from './dispatch-client.ts'
/* 票 48：`EyeIcon` / `EyeOffIcon` 不再需要——「隐藏对话区」那颗按钮已删，
 * 动作移到 logo 上（用户：「注意，是点击logo，不是增加一个按钮」）。
 * `ArrowRightIcon` 给「隐藏工作台」——工作台是右列，收起来就是往右收，
 * 与「收起侧栏」的 `PanelLeftIcon` **不再是同一个形状**（那是票 48 要修的易误认处）。 */
import { ArrowRightIcon, ChevronDownIcon, ChevronUpIcon, PanelLeftIcon } from './icons.tsx'
/** 齿轮：工作台设置入口（画在这里，只有一个用途，不单开一个图标文件）。
 *
 * ⚠️ 返回类型**故意不写 `React.JSX.Element`** —— 本仓 React 类型是最小 shim，
 * 没有全局 `React` 命名空间，写了会给 `check:client` 多加一条 TS2503。
 */
/* ⚠️ 票 66：原来这里有个私有的 `GearIcon`（齿轮 SVG），只有侧栏底部那颗
 * 「工作台设置」按钮用它。那颗按钮已删（改成「配置」板块了），所以这个函数
 * 一并删掉 —— 留着一个没人调的函数，下一个人会以为它还在用。
 *
 * 板块用的图标是 `icons.tsx` 里的 `SettingsIcon`（同一个齿轮形状）。
 */

/* 工作台品牌标识（用户提供的图形，替换原拼图图标）。 */
import { BrandMark } from './brand-mark.tsx'
import { PageHeader } from './PageHeader.tsx'
/* ★ 票 69：内容区限宽从写死的常量搬进了工作台偏好（见文件头 `CONTENT_MAX_WIDTH` 那段）。
 * 读的是同一份 `workbench-prefs`（生图张数 / 系统提示词 / 画布明暗都住那儿），
 * 只是多了一个 `contentMaxWidth` 字段 —— 票面要求「能加一个字段就加在那里，别新建文件」。 */
import { readPrefs as readWorkbenchPrefs, currentWorkbenchPrefs, subscribeWorkbenchPrefs } from './lib/workbench-prefs.ts'
import css from './EcomWorkbench.module.css'

/** 本插件的路由前缀（板块拼自己的接口用）。 */
const API_BASE = '/api/ecom-workbench'

/** 右列宽度占对话列的默认比例（%）。 */
/**
 * 内容主体的最大宽度（px）。**用户 2026-10-28 定：1440**（票 49）。
 *
 * ## ⚠️ 2026-10-29（票 69）：这个数**从常量搬进了设置**
 *
 * 用户原话：「内容区限宽，这个做到设置里面去吧，浏览器、提醒、内容区限宽
 * 都做为一个 tab 的内容先。」
 *
 * 所以真正生效的值现在来自 `workbench-prefs` 的 `contentMaxWidth`
 * （五档：不限宽 / 1200 / 1440 / 1680 / 1920，缺省 **1440** = 这个常量）。
 * 组件里读的是 `useSyncExternalStore(subscribeWorkbenchPrefs, ...)`，
 * 改下拉**立刻生效**，不用刷新页面。
 *
 * 这个导出**保留**，理由有三：
 *   ① 它是缺省的**出处**（`workbench-prefs.ts` 的 `DEFAULT_CONTENT_MAX_WIDTH`
 *      与它同值，判据钉住这一致性）；
 *   ② `tests/dom-render.mjs` 按它验「缺省值没被改动过」；
 *   ③ 注释里那张表是「这个上限在什么窗口宽度下才看得见」的唯一说明，
 *      删了就得重算一遍。
 *
 * ## 这个上限在什么窗口宽度下才看得见（票面要我说清的那条）
 *
 * 工作台是 dsh 右列，默认占对话列的 **55%**（`DEFAULT_PCT = 55`）。
 *
 * ⚠️ **这一栏不是窗口宽度 × 55%**：`measure()`（`:140`）算的是
 * 「对话列宽度 × 55%」，再减掉侧栏与内边距。所以下面这张表**按工作台自己的宽度**列，
 * 不是按窗口宽度 —— 第一次写这段时我按窗口算，得出的数字全偏大。
 *
 * | 工作台这一列的实际宽度 | 内容主体可用宽度（减左右 px-8 共 64） | 碰到 1440 了吗 |
 * |---|---|---|
 * | 1075（2560 窗口的常态） | 约 1011px | 没有 |
 * | 1440 | 约 1376px | **还差一点** |
 * | 1504 | 约 1440px | **刚好碰到** |
 * | 1920（把右列拖到很宽 / 隐藏对话区后） | 约 1856px | **碰到**，两侧各留约 208px |
 *
 * 也就是说：**工作台这一列要宽到约 1500px 以上，这个上限才显形**。
 * 常态（默认 55%）下永远碰不到 —— 与旧注释「窗口本就不宽」并不矛盾：
 * 旧理由说的是常态，这一条管的是**把右列拖宽 / 隐藏对话区 / 超宽屏**时的阅读宽度。
 *
 * ⚠️ 想改**缺省值**动这一处；想改**用户当前那一份**去设置里改（那是偏好，不是代码）。
 */
export const CONTENT_MAX_WIDTH = 1440

const DEFAULT_PCT = 55
/** 对话区最小宽度（px），保证聊天可用。 */
const MIN_CHAT = 360
/** 右列最小宽度（px）。 */
const MIN_COL = 320
/** tab 宽度钳制范围（px）——指示器按等宽平移，所以只改这一个值就能整体缩放。 */
const TAB_MIN = 84
const TAB_MAX = 150
/** 提示条自动消失的时长（ms）。 */
const NOTICE_MS = 3200

/** 工作台开关读写器。 */
export interface PanelHooks {
  /** 读取当前开关状态。 */
  get: () => boolean
  /** 切换开关。 */
  set: (on: boolean) => void
  /** 读取对话区是否隐藏。 */
  getHideChat: () => boolean
  /** 切换对话区隐藏。 */
  setHideChat: (v: boolean) => void
  /**
   * 读取「工作台是不是开着」。
   *
   * 用户 m03287：「工作台左侧增加隐藏工作台按钮，注意是**触发 dsh 的那个点击动作**，
   * 保证统一位置放在隐藏对话区的上面。」
   *
   * 所以这个按钮做的**不是**另一套隐藏逻辑 —— 它调的就是 dsh 侧栏那个
   * 「电商工作台」开关按钮的同一个动作（index.ts 的 setWbOn），点一下就等于点了那边一下。
   * 两处状态天然一致，不会出现「这边说开着、那边说关着」。
   */
  getWb: () => boolean
  /** 切换工作台开关（与 dsh 侧栏那个按钮同一个动作）。 */
  setWb: (on: boolean) => void
}

/**
 * 实测对话列在 frame 中的位置与宽度，写入 CSS 变量把右列约束在对话区内部。
 * @param colRef - 右列根元素。
 * @param hideChat - 是否隐藏对话区。
 * @param pct - 右列占对话列的百分比（默认 DEFAULT_PCT）。
 */
function measure(colRef: { current: HTMLDivElement | null }, hideChat: boolean, pct: number = DEFAULT_PCT): void {
  const frame = document.querySelector('[class*="frame"]')
  const center = document.querySelector('[class*="centerCol"]')
  const col = colRef.current
  if (frame === null || center === null || col === null) return
  const f = frame.getBoundingClientRect()
  const c = center.getBoundingClientRect()
  if (c.width <= 0) return
  const centerW = c.width
  let colw: number
  if (hideChat) {
    colw = centerW
  } else {
    // 拖宽时允许突破 MIN_COL/MIN_CHAT 的钳制范围（用户拖到哪就是哪），但保留上下限防止拖没
    const maxCol = Math.max(0, centerW - (pct >= 70 ? 200 : MIN_CHAT))
    const floor = Math.min(MIN_COL, maxCol)
    colw = Math.min(maxCol, Math.max(floor, centerW * (pct / 100)))
  }
  const root = document.documentElement.style
  root.setProperty('--ewb-left', (c.left - f.left + centerW - colw).toFixed(1) + 'px')
  root.setProperty('--ewb-colw', colw.toFixed(1) + 'px')
  root.setProperty('--ewb-top', Math.max(0, c.top - f.top).toFixed(1) + 'px')
  root.setProperty('--ewb-squeeze', hideChat ? '0%' : ((colw / centerW) * 100).toFixed(3) + '%')
}

/**
 * 把板块清单**按 group 切段**（同名相邻的归一组）。
 *
 * 为什么不用 Map 全聚到一起：分组名在清单里是**连续出现**的，
 * 全聚会把不同位置的两组同名板块合并、顺序全乱。照清单的相邻关系切段最稳。
 *
 * @param boards - 已排序的板块清单。
 * @returns 分组数组（每组带名字与它的板块）。
 */
function groupBoards(boards: readonly RegisteredBoard[]): { name: string, items: RegisteredBoard[] }[] {
  const out: { name: string, items: RegisteredBoard[] }[] = []
  for (const b of boards) {
    const name = b.group ?? ''
    const last = out[out.length - 1]
    if (last !== undefined && last.name === name) last.items.push(b)
    else out.push({ name, items: [b] })
  }
  return out
}

/**
 * 这个板块要不要**常驻挂载**（切走只藏起来、不卸载）。
 *
 * 判据是两处**声明**里任一处说了算，骨架里不写任何板块 id：
 *   · `tabs` 里某一格写了 `keepMounted` —— 板块内「哪一格不能卸」由板块自己声明；
 *   · 板块注册项自己写了 `keepMounted` —— 整块都不能卸。
 *
 * 为什么要这层推导：画布是「板块内的一格」，它常驻的**同时**整块板块也得跟着常驻，
 * 否则切到别的板块时画布还是会被连带卸载 —— 那正是「切走就丢节点」的老 bug。
 *
 * @param b - 板块注册项。
 * @returns 要常驻就 true。
 */
function keepsMounted(b: RegisteredBoard): boolean {
  return b.keepMounted === true || (b.tabs ?? []).some(t => t.keepMounted === true)
}

/**
 * 这个板块里**必须一直挂着的**那些格子（没声明就是空数组）。
 *
 * ## 为什么是数组而不是一个 id（2026-10-25 契约 AU）
 *
 * 以前只有一个板块声明 `keepMounted`，`.find()` 恰好够用。内容板块加进来之后
 * 「一个板块里有多格都要常驻」变成真实需求，`.find()` 只会认第一个 ——
 * 第二格会在切走时被当成「不是常驻格」而不给挂载。
 *
 * ## 为什么非激活时要把这些格告诉板块
 *
 * 板块在后台挂着，但它不该把「当前选中的那一格」也一起画出来 —— 那会让别的板块的
 * 界面藏在后台却仍然在 DOM 里（点击、文字、计数都会串）。
 * 所以非激活时统一告诉它「只画常驻那几格」。
 *
 * @param b - 板块注册项。
 * @returns 常驻格的 id 列表（按注册顺序）；没有就空数组。
 */
function keptTabsOf(b: RegisteredBoard): string[] {
  return (b.tabs ?? []).filter(t => t.keepMounted === true).map(t => t.id)
}

/**
 * 按「板块上报的可见清单」过滤 tab（2026-10-25 契约 AU）。
 *
 * ## 规则只有两条
 *
 *   · **没标 `dynamic` 的格子永远显示** —— 骨架管不着它，上报了也不影响；
 *   · **标了 `dynamic` 的格子只认上报清单** —— 在清单里显示、不在就隐藏。
 *
 * ## 默认值（硬要求）
 *
 * `visible === undefined`（这个板块从没上报过）→ **全显示**。
 * 现有七个板块都不传 `onTabsChange`，所以它们走的永远是这一支 ——
 * 这就是「现有板块一行都不用改」的保证。
 *
 * ## 顺序
 *
 * 过滤**不重排**：显不显示由这份清单决定，**排第几仍由注册时的 `tabs` 决定**。
 * 想让某一格排在第一位，就在注册时把它写在第一位 —— 骨架不替板块决定顺序。
 *
 * @param tabs - 注册时声明的格子。
 * @param visible - 板块上报的可见清单（`undefined` = 没上报过）。
 * @returns 该画出来的格子。
 */
function visibleTabs(tabs: readonly BoardTab[], visible: readonly string[] | undefined): readonly BoardTab[] {
  if (visible === undefined) return tabs
  return tabs.filter(t => t.dynamic !== true || visible.includes(t.id))
}

/**
 * 工作台主界面。
 * @param props - 开关读写器。
 * @returns 工作台界面元素。
 */
export function EcomWorkbench({ getHideChat, setHideChat, getWb, setWb }: PanelHooks): React.JSX.Element {
  /* ── 注册表（唯一的数据源）─────────────────────────────────────────
   * useSyncExternalStore：板块增删/换顺序会自动重渲染，不用手工订阅。
   * 快照引用在注册表里缓存着（每次 getSnapshot 新建数组会变成无限重渲染）。 */
  const boards = useSyncExternalStore(subscribeBoards, getBoards, getBoardsServer)

  /* ★ 票 69：内容区限宽从偏好读（改设置里那个下拉立刻生效）。
   *
   * ## 为什么用 `useSyncExternalStore` 而不是 `useState` + `useEffect`
   *
   * 快照函数 `currentWorkbenchPrefs()` 返回的是**稳定引用**（模块级缓存，
   * 只在 `updateWorkbenchPrefs` 时换新）—— 这正是 `useSyncExternalStore` 要求的。
   * 用 `useState` + 订阅也能做（`useBrowserPrefs` 就是），但那要多一次渲染；
   * 这里一个数字，直接订阅更省。
   *
   * ⚠️ 服务端快照（第三个参数）给缺省值：这个组件只在客户端跑，
   * 但 `useSyncExternalStore` 在 SSR 水合时要求它存在。 */
  const contentMaxWidth = useSyncExternalStore(
    subscribeWorkbenchPrefs,
    () => currentWorkbenchPrefs().contentMaxWidth,
    () => CONTENT_MAX_WIDTH as number,
  )

  /** 当前板块 id（null = 还没选过 → 用清单第一个）。 */
  const [activeId, setActiveId] = useState<string | null>(null)
  /** 每个板块各自记住选中的 tab（切走再切回不丢）。 */
  const [tabOf, setTabOf] = useState<Record<string, string>>({})
  /**
   * 侧栏是否收起（照 FounderOS：收起后只留图标，宽度 56px）。
   *
   * 为什么要它：工作台嵌在对话列里，横向空间本来就紧张；
   * 收起侧栏能把空间让给内容区（尤其画布）。
   *
   * ⚠️ **首帧读缓存、文件到了再校正**（2026-10-22 改）：
   * 原来只读 `localStorage`，而启动器用 `--port 0`、端口一变缓存就读不到 →
   * 重启就把设置丢了。现在文件是权威（`dispatch-client.ts` 的 `loadUiPrefs`），
   * 但文件要走一次网络往返，首帧只能先靠缓存撑住，否则会闪一下默认值。
   */
  const [navCollapsed, setNavCollapsed] = useState<boolean>(
    () => readUiPrefsCache().navCollapsed ?? false,
  )
  const [hideChat, setLocalHideChat] = useState(getHideChat())
  /** 实测可用的 tab 宽度，让 tab 条自适应右列宽。 */
  const [tabWidth, setTabWidth] = useState(120)
  /** 提示条文字（空串 = 不显示）。 */
  const [notice, setNotice] = useState('')
  /**
   * 曾经被打开过的板块 id —— keepMounted 的板块靠它决定「挂不挂」。
   *
   * 为什么记在骨架里而不是各板块内部：常驻的是**板块这一整棵子树**，
   * 切到别的板块时它必须还在（画布的节点与连线是组件内 useState，卸载即丢；
   * 而撤销栈是模块级 store 不跟着销毁 → 切回来「屏幕」与「历史」对不上）。
   */
  const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set())

  const colRef = useRef<HTMLDivElement | null>(null)
  const tabsRef = useRef<HTMLDivElement | null>(null)
  /** 右列宽度占对话列的百分比（可拖拽调整，双击复位）。 */
  const [pct, setPct] = useState(DEFAULT_PCT)

  /**
   * 顶部标题（面包屑 + 大标题）是否收起。
   *
   * 用户 2026-10-11 要求：「工作流界面需要一个按钮隐藏顶部……使用工作流的时候
   * 画面应该尽量大」。所以做成画布工具条上的一个开关，**记住偏好**。
   * 只收面包屑与大标题，**tab 条保留**：否则想切回来就只能先去点侧栏，反而更绕。
   *
   * ⚠️ 首帧用缓存撑住，文件到货后由下面的 `subscribeUiPrefs` 校正 ——
   * 理由同 `navCollapsed` 那一段（端口每次变，缓存可能是空的）。
   */
  const [topHidden, setTopHidden] = useState<boolean>(
    () => readUiPrefsCache().topHidden ?? false,
  )

  /** 当前板块（没选过 / 注册表里没了 → 退回第一个）。 */
  const board: RegisteredBoard | undefined = boards.find(b => b.id === activeId) ?? boards[0]
  /**
   * 每个板块上报的「现在哪几格该显示」（2026-10-25 契约 AU）。
   *
   * ## 为什么住在骨架里
   *
   * 「该不该显示某一格」板块自己知道（打开过画布没有），而**骨架不许认识板块 id**。
   * 所以板块通过 `onTabsChange` 把答案报上来，骨架只做过滤这件事。
   *
   * ## 没上报过的板块在表里**没有键**
   *
   * 那正是「全显示」这一支的判据（`visible === undefined`）——
   * 现有七个板块永远不会有这个键，所以它们的行为一个字节都没变。
   */
  const [visibleTabsOf, setVisibleTabsOf] = useState<Record<string, readonly string[]>>({})
  /** 注册时声明的 tab（未按上报过滤）。 */
  const declaredTabs = board?.tabs ?? []
  /**
   * 过滤之后的 tab 清单（tab 条与「当前选中哪一格」都按它算）。
   *
   * ⚠️ 必须用它算选中格：被隐藏的那一格不该继续当「当前格」，
   * 否则 tab 条上没有一个高亮，而内容区还显示着那一格。
   */
  const tabs = visibleTabs(declaredTabs, board === undefined ? undefined : visibleTabsOf[board.id])
  /**
   * 当前选中的 tab（没有 tab 时为空串）。
   *
   * 记住的那个可能已被隐藏（比如画布关了）→ 退回第一个可见格。
   * 只**读**这份记忆、不在这里改写它：用户把画布重新打开时，应该回到他上次那一格。
   */
  const remembered = board === undefined ? '' : (tabOf[board.id] ?? '')
  const tab = tabs.some(t => t.id === remembered) ? remembered : (tabs[0]?.id ?? '')
  /** 当前板块是不是「常驻挂载型」。 */
  const boardKept = board !== undefined && keepsMounted(board)
  /** 要常驻挂载的板块：是常驻型，且打开过（或就是当前这块）。 */
  const panes = boards.filter(b => keepsMounted(b) && (seen.has(b.id) || b.id === board?.id))

  const remeasure = useCallback((): void => { measure(colRef, getHideChat(), pct) }, [getHideChat, pct])

  /* 启动时问一次文件里的偏好（幂等，两个板块共用同一次请求）；
   * 到了就校正这两个开关。**失败什么都不做** —— 界面继续用首帧那份缓存值，
   * 不许因为宿主半没起来就把用户的设置重置成默认（任务书明确要求）。
   *
   * ⚠️ **竞态**：文件要一次网络往返。用户可能在这之前就点了开关。
   * 那一下之后若还照着文件覆盖，就等于把刚点的结果吞掉（看得见地「弹回去」）。
   * 所以用 `touched` 记住「用户自己动过哪个键」，动过的就不再被文件校正。
   * 这也是 `adoptUiPrefs` 广播时不会来回打架的原因。 */
  const touched = useRef({ top: false, nav: false })
  useEffect(() => {
    void ensureUiPrefsLoaded()
    return subscribeUiPrefs(p => {
      if (!touched.current.top) setTopHidden(p.topHidden)
      if (!touched.current.nav) setNavCollapsed(p.navCollapsed)
    })
  }, [])

  /** 收起/展开顶部（**双写**：缓存 + 文件；只写一个会闪或会丢）。 */
  const toggleTop = useCallback((): void => {
    setTopHidden(prev => {
      const next = !prev
      touched.current.top = true
      /* 缓存立刻生效（下次首帧靠它），文件走网络、失败不打扰用户。 */
      void saveUiPrefs({ topHidden: next }).then(r => {
        if (r.ok && r.prefs !== undefined) adoptUiPrefs(r.prefs)
      })
      return next
    })
  }, [])

  /**
   * 切换「隐藏对话区」（票 48：从底部按钮搬到侧栏头部的 logo 上）。
   *
   * ## 为什么必须是这样一个函数、不许在 onClick 里现写
   *
   * 这个动作有**四件事**要做，漏一件就是看得见的缺陷：
   *   ① 写宿主那份状态（`setHideChat`）—— `measure` 读的是它
   *   ② 写本组件那份状态（`setLocalHideChat`）—— 决定 logo 的 `aria-pressed`
   *   ③ `remeasure()` —— 重算挤压比例
   *   ④ 宿主侧 `src/client/index.ts:119-131` 那条「隐藏对话区 ⇒ 收起 dsh 左侧栏」的联动
   *
   * ①②③ 原来就写在一起，④ 在宿主那边听 `setHideChat` 的回调。
   * 所以这里**只是把原来那三行搬进来**，一行逻辑没改 —— 现在两处 logo（展开 / 收起）
   * 各写一遍的话，迟早有一处漏掉某一步。
   *
   * ⚠️ `getHideChat()` 读**宿主**那份而不是组件 state：连点两下时 state 可能还没刷新。
   */
  const toggleChat = useCallback((): void => {
    const next = !getHideChat()
    setHideChat(next)
    setLocalHideChat(next)
    remeasure()
  }, [getHideChat, setHideChat, remeasure])

  /** 工作台设置抽屉是否打开（浏览器设置只在这里改）。 */
/* ⚠️ 票 66：`wsOpen` 状态**已删** —— 工作台设置从抽屉变成了「配置」板块，
 * 不再有「开着 / 关着」这回事（板块的显示由骨架的 tab 决定）。 */

  /**
   * 切到某个板块的某一格。
   * @param boardId - 板块 id。
   * @param tabId - 那一格的 id。
   */
  const selectTab = useCallback((boardId: string, tabId: string): void => {
    setTabOf(prev => ({ ...prev, [boardId]: tabId }))
  }, [])

  /**
   * 发一条提示（几秒后自己消失）。
   * @param text - 要显示的文字。
   */
  const say = useCallback((text: string): void => {
    setNotice(text)
    window.setTimeout(() => { setNotice(cur => (cur === text ? '' : cur)) }, NOTICE_MS)
  }, [])

  /**
   * 直接跑一份工作流（交给板块的回调，板块不必自己写跑法）。
   * @param name - 工作流名。
   */
  const onRunWorkflow = useCallback((name: string): void => {
    void (async () => {
      const r = await runWorkflowFile(name)
      say(r.ok ? ('「' + name + '」已跑完') : ('「' + name + '」执行失败：' + (r.error ?? '原因不明')))
    })()
  }, [say])

  /* 记下「哪些板块被打开过」—— 常驻板块靠它决定挂不挂。 */
  useEffect(() => {
    if (board === undefined) return
    const id = board.id
    setSeen(prev => (prev.has(id) ? prev : new Set(prev).add(id)))
  }, [board])

  /**
   * 板块上报「现在哪几格该显示」（2026-10-25 契约 AU）。
   *
   * ## 为什么要有「内容没变就不设」这道闸门
   *
   * 板块通常在渲染后或某个 effect 里上报。若每次都 `setState` 一个新数组，
   * 骨架重渲染 → 板块再上报 → 无限循环。所以比对**内容**（不是引用），
   * 一样就直接返回，连 `setState` 都不调。
   *
   * ## 为什么存整张表而不是只存一份
   *
   * 多个板块都可能有动态格；存一份会互相覆盖。
   *
   * @param boardId - 谁上报的（键）。
   * @param visible - 该显示的 tab id。
   */
  const reportTabs = useCallback((boardId: string, visible: readonly string[]): void => {
    setVisibleTabsOf(prev => {
      const cur = prev[boardId]
      if (cur !== undefined && cur.length === visible.length && cur.every((v, i) => v === visible[i])) {
        return prev
      }
      return { ...prev, [boardId]: [...visible] }
    })
  }, [])

  // 尺寸变化（左栏开关、窗口缩放）时重新实测右列几何
  useEffect(() => {
    remeasure()
    const frame = document.querySelector('[class*="frame"]')
    const center = document.querySelector('[class*="centerCol"]')
    const ro = new ResizeObserver(() => { remeasure() })
    if (center !== null) ro.observe(center)
    if (frame !== null) ro.observe(frame)
    window.addEventListener('resize', remeasure)
    window.addEventListener('ewb-mode-change', remeasure)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', remeasure)
      window.removeEventListener('ewb-mode-change', remeasure)
    }
  }, [remeasure])

  // tab 宽度随内容区宽度自适应：总宽够就放到上限，不够就均分（下限 84px，超出靠横向滚动）
  useLayoutEffect(() => {
    const el = tabsRef.current
    if (el === null) return
    const fit = (): void => {
      const avail = el.clientWidth
      if (avail <= 0) return
      const n = tabs.length
      if (n === 0) return
      const next = Math.max(TAB_MIN, Math.min(TAB_MAX, Math.floor(avail / n)))
      setTabWidth(prev => (prev === next ? prev : next))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [tabs])

  // ── 右列宽度拖拽（照原 workbench 的做法：pointer 事件 + 按对话列宽度算比例） ──
  const dragRef = useRef(false)

  /** 拖拽开始：捕获指针，避免移出元素后丢事件。
   * @param e - 指针事件。 */
  const onDragDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }, [])

  /** 拖拽中：以对话列右边缘为基准，算右列占对话列的比例。
   * @param e - 指针事件。 */
  const onDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    const center = document.querySelector('[class*="centerCol"]')
    const box = center?.getBoundingClientRect()
    if (box === undefined || box.width === 0) return
    const W_MIN = 25
    const W_MAX = 92
    const next = Math.min(W_MAX, Math.max(W_MIN, ((box.right - e.clientX) / box.width) * 100))
    setPct(next)
    measure(colRef, getHideChat(), next)
  }, [getHideChat])

  /** 拖拽结束。 */
  const onDragUp = useCallback(() => { dragRef.current = false }, [])

  /**
   * 给某个板块准备的入参。
   * @param b - 板块注册项。
   * @param on - 它是不是正显示着。
   * @returns 板块组件入参。
   */
  const propsFor = (b: RegisteredBoard, on: boolean): BoardProps => ({
    active: on,
    /* 非激活时常驻板块只画「常驻那几格」，别把别的格子的界面也留在 DOM 里。 */
    tab: on ? (tabOf[b.id] ?? b.tabs?.[0]?.id ?? '') : (keptTabsOf(b)[0] ?? ''),
    apiBase: API_BASE,
    topHidden,
    onToggleTop: toggleTop,
    onSelectTab: (tabId: string) => { selectTab(b.id, tabId) },
    onRunWorkflow,
    /* ★ 2026-10-25 契约 AU：常驻格的**全量**清单（`tab` 只能表达一格）。
     * 板块按集合判断「哪几格必须留」；没声明的板块拿到空数组，行为不变。 */
    keptTabs: keptTabsOf(b),
    /* ★ 同上：板块上报「现在哪几格该显示」。骨架只存、只按它过滤，
     * **不认识任何板块的 id**。现有七个板块不传这个键 → 永远走「全显示」。 */
    onTabsChange: (visible: readonly string[]) => { reportTabs(b.id, visible) },
  })

  return h('div', { ref: colRef, 'data-ewb-column': '', className: css.column },
    // 左边缘拖拽把手（拖宽/拖窄整个工作台）
    h('div', {
      className: css.dragHandle,
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': '拖拽调整工作台宽度',
      title: '拖拽调整工作台宽度（双击复位）',
      onPointerDown: onDragDown,
      onPointerMove: onDragMove,
      onPointerUp: onDragUp,
      onPointerCancel: onDragUp,
      onDoubleClick: () => { setPct(DEFAULT_PCT); measure(colRef, getHideChat(), DEFAULT_PCT) },
    }),
    // ── 左：板块导航 ──────────────────────────────────────────
    /* 这一段**直接用 Tailwind 类**，类名与结构照 FounderOS 的 Sidebar.tsx 搬，
     * 只把它的颜色 token（os-*）换成本地那份（见 styles/tailwind.css 的说明）。 */
    h('aside', {
      className: [
        'flex flex-none flex-col min-h-0 overflow-hidden',
        /* 底用 **bg-base**（与页面底同色）——照 FounderOS 的 mono 主题：
         * 它的 --bg 与 --bg-2 是同一个色（注释：boxes are gone, surfaces flatten to bg），
         * 侧栏**没有独立底色**。 */
        'border-r border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-base)]',
      ].join(' '),
      style: { width: navCollapsed ? 56 : 232 },
    },
      /* 头部：未收起时 flex-row 两端对齐；收起时纵向居中堆叠（照 FounderOS） */
      h('div', {
        className: [
          'flex pb-5 pt-5',
          navCollapsed ? 'flex-col items-center gap-2 px-0' : 'items-center justify-between px-5',
        ].join(' '),
      },
        /* ★ 点 logo 切换「隐藏对话区」（票 48，用户：「注意，是点击logo，不是增加一个按钮」）。
         *
         * ## 为什么用 <button> 而不是给 span 加 onClick
         *
         * 用 `<button>` **一次拿到三件东西**：键盘可触发（回车 / 空格浏览器原生支持）、
         * 焦点环（`focus-visible`）、`aria-pressed` 的语义归属。手写 `onKeyDown` +
         * `tabIndex` + `role="button"` 是同一件事的三份实现，而且极易漏掉空格键。
         *
         * ## 为什么两个态各包一层、里面还是 BrandMark
         *
         * 展开态 logo 在「品牌标识 + 两行文字」那一组的左边，收起态单独居中。
         * 两处的**尺寸不同**（34 / 30）、**包裹形状不同**，所以不能共用一个外层；
         * 但里面那颗 `BrandMark` 是同一个组件 —— 图标本身没有第二份。 */
        navCollapsed
          ? h('button', {
              type: 'button',
              'data-ewb-logo-toggle': 'collapsed',
              className: 'pressable is-dark flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-ctl border border-transparent text-[var(--dsw-alias-label-secondary)] hover:text-[var(--dsw-alias-label-primary)]',
              title: hideChat ? '显示对话区' : '隐藏对话区',
              'aria-label': hideChat ? '显示对话区' : '隐藏对话区',
              'aria-pressed': hideChat,
              onClick: toggleChat,
            }, h(BrandMark, { size: 30 }))
          : h('div', { className: 'flex items-center gap-3 min-w-0' },
              h('button', {
                type: 'button',
                'data-ewb-logo-toggle': 'expanded',
                /* `-m-1 p-1`：给焦点环与 pressable 的位移留一点地方，
                 * 又不改变 logo 在视觉上的落点（负外边距抵掉内边距）。 */
                className: 'pressable is-dark -m-1 flex shrink-0 items-center justify-center rounded-ctl border border-transparent p-1 text-[var(--dsw-alias-label-secondary)] hover:text-[var(--dsw-alias-label-primary)]',
                title: hideChat ? '显示对话区' : '隐藏对话区',
                'aria-label': hideChat ? '显示对话区' : '隐藏对话区',
                'aria-pressed': hideChat,
                onClick: toggleChat,
              }, h(BrandMark, { size: 34 })),
              h('div', { className: 'min-w-0' },
                h('div', { className: 'text-ewb-body font-semibold tracking-[0.14em] whitespace-nowrap' }, '电商工作台'),
                h('div', {
                  className: 'mt-1 whitespace-nowrap font-mono text-ewb-caption uppercase tracking-[0.16em] text-[var(--dsw-alias-label-tertiary)]',
                }, 'v0.1 OPERATOR'),
              ),
            ),
        h('button', {
          type: 'button',
          'data-lens': 'c',
          /* 照 FounderOS 的折叠按钮：28×28（h-7 w-7）+ 15px 图标 + 1px 透明边框 + pressable。 */
          className: [
            'pressable is-dark flex h-7 w-7 shrink-0 items-center justify-center rounded-ctl',
            'border border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)]',
            'text-[var(--ewb-accent)]',
          ].join(' '),
          title: navCollapsed ? '展开侧栏' : '收起侧栏',
          'aria-label': navCollapsed ? '展开侧栏' : '收起侧栏',
          'aria-expanded': !navCollapsed,
          onClick: () => {
            const next = !navCollapsed
            setNavCollapsed(next)
            touched.current.nav = true
            /* **双写**：缓存 + 文件。只写缓存 → 端口一变就丢（这次的病）；
             * 只写文件 → 下次首帧还是旧值，会闪。 */
            void saveUiPrefs({ navCollapsed: next }).then(r => {
              if (r.ok && r.prefs !== undefined) adoptUiPrefs(r.prefs)
            })
          },
        }, h(PanelLeftIcon, { size: 15 })),
      ),
      /* 导航区：gap-0.5 px-2.5 pb-2（照 FounderOS） */
      h('nav', {
        /* 收起态必须 items-center：按钮是固定宽度方框、列宽 56px，默认 stretch 会左对齐看着贴边。 */
        className: 'flex flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 pb-2',
      },
        ...groupBoards(boards).flatMap(g => [
          /* 分组标题（照 FounderOS 的 NavGroup.title）：小号大写 + 宽字距的「眉标」；
           * 收起时换成一条分隔线（让图标列仍读得出分组）。 */
          g.name === ''
            ? null
            : navCollapsed
              ? h('div', { key: 'g-' + g.name, className: 'mx-2 my-1.5 border-t border-[var(--dsw-alias-border-l2)]', 'aria-label': g.name })
              : h('div', {
                  key: 'g-' + g.name,
                  /* 分组标题（分类）与板块名（条目）分层：
                   *   - **颜色退一档**：tertiary → caption（dsh 里更淡的文字档）
                   *   - **字距再放宽**：0.18em → 0.22em（小字靠字距显轻，不靠变小） */
                  className: 'px-2.5 pb-1.5 pt-3.5 font-mono text-ewb-caption uppercase tracking-[0.22em] text-[var(--dsw-alias-label-caption)]',
                }, g.name),
          ...g.items.map(b => {
            const on = b.id === board?.id
            return h('button', {
              key: b.id,
              type: 'button',
              title: b.title,
              'aria-current': on ? 'page' : undefined,
              /* ⚠️ 关键在选中态（照 FounderOS 的 NavGroup 原文）：
               *   - **未选中：border-transparent + 无背景**（它没有「默认就有框」）
               *   - 选中：accent-line 描边 + accent-soft 填充 + accent 文字 */
              'data-lens': 'r',
              'data-ewb-item': b.id,
              className: [
                /* 收起态：**铺满容器 + 方形**（w-full aspect-square），不写死尺寸 ——
                 * 56px 减两侧 px-2.5（10px）= 36px 是**结果不是原因**。 */
                'pressable is-dark flex items-center rounded-ctl border text-ewb-meta font-semibold',
                navCollapsed ? 'aspect-square w-full shrink-0 justify-center' : 'w-full gap-2.5 px-2.5 py-2',
                on
                  ? 'border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)] text-[var(--ewb-accent)]'
                  : 'border-transparent text-[var(--dsw-alias-label-secondary)] hover:text-[var(--dsw-alias-label-primary)]',
              ].join(' '),
              onClick: () => { setActiveId(b.id) },
            },
              /* 图标与文字**不同色**：图标退一档用 tertiary，文字用 secondary/primary。 */
              h('span', { className: 'flex shrink-0 items-center justify-center text-[var(--dsw-alias-label-tertiary)]', style: { display: 'flex' } },
                renderBoardIcon(b.icon, 15)),
              navCollapsed ? null : h('span', { className: 'min-w-0 overflow-hidden whitespace-nowrap text-ellipsis' }, b.title),
            )
          }),
        ]),
      ),
      /* 底部区（照 FounderOS）：border-t py-3.5；未收起 px-5 / 收起时与导航区同边距。
       *
       * ## ⚠️ 收起态为什么必须与导航区用同一套（2026-10-23 契约 Y）
       *
       * 用户原话：「左侧栏收起态下，下面的按钮间隔太大了，下面按钮的按钮大小和范围
       * 应该和上面的板块按钮一样，当前外框大了间距也大了」。
       *
       * 原来这里收起时是 `px-0` + `gap-2`，而导航区是 `px-2.5` + `gap-0.5` ——
       * 同一列图标，**上面的框 36px 宽、下面的框 56px 宽，还多出一倍的行距**。
       * 现在收起态一律照抄导航区那两个值：`px-2.5` + `gap-0.5`。
       * 按钮个头本来就一样（都是 `aspect-square w-full`），所以边距对齐后
       * 上下两组的框**逐像素重合**。 */
      h('div', {
        className: [
          'flex flex-none flex-col border-t border-[var(--dsw-alias-border-l2)] py-3.5',
          navCollapsed ? 'items-center gap-0.5 px-2.5' : 'gap-2 px-5',
        ].join(' '),
      },
        /* ★ 「隐藏工作台」按钮（用户 m03287）。**位置在「隐藏对话区」上面**。
         *
         * ⚠️ 它做的是**同一个动作** —— 调 setWb(!getWb())，与 dsh 侧栏底部那个
         * 「电商工作台」按钮完全一样，不是另写一套隐藏逻辑。 */
        h('button', {
          type: 'button',
          'data-lens': 'r',
          'data-ewb-hide-wb': '',
          className: [
            'pressable is-dark flex items-center rounded-ctl border border-transparent text-[var(--dsw-alias-label-secondary)]',
            navCollapsed ? 'aspect-square w-full shrink-0 justify-center' : 'w-full gap-2 px-2.5 py-2',
            'hover:border-[var(--dsw-alias-border-l2)] hover:text-[var(--dsw-alias-label-primary)]',
          ].join(' '),
          title: '隐藏工作台（与侧栏那个按钮同一个动作）',
          onClick: () => { setWb(!getWb()) },
        },
          /* ★ 图标换掉了（票 48）。原来这里是 `PanelLeftIcon` —— 与上面「收起侧栏」
           * **是同一个形状**，两块挨着放，用户说「图标一样我看到了」。
           * 换成 `ArrowRightIcon`：工作台是**右列**，隐藏它就是往右收。
           * 「收起侧栏」保持 `PanelLeftIcon`（那确实是左侧栏的收放），
           * 两个动作从此在形状上就能分开。 */
          h(ArrowRightIcon, { size: 15 }),
          navCollapsed ? null : h('span', { className: 'whitespace-nowrap text-ewb-meta' }, '隐藏工作台'),
        ),
        /* ★ 票 48 从这里删掉了两颗按钮：
         *
         * 1. **「隐藏对话区」**（原 `:664-685`）—— 动作搬到**侧栏头部的 logo** 上。
         *    用户原话：「点击顶部logo（注意，是点击logo，不是增加一个按钮）隐藏dsh对话区」。
         * 2. **「收起顶部 · 版本 B」**（原 `:693-708`）—— 搬到面包屑 / tab 行。
         *    那是「两版并存观察」留下来的第二个入口，用户要的只有一个。
         *
         * 删的两颗都在底部这一列，而这一列本来就只有 4 项、其中 2 项与头部/面包屑重复。
         * 现在剩「隐藏工作台」与「工作台设置」两颗，动作各自唯一。 */
        /* ★ 工作台设置（2026-10-22）：齿轮。**浏览器设置只在这里**。
         *
         * 为什么放侧栏底部而不是画布工具条：浏览器是**工作台级**设置
         * （会话与登录态，跨所有工作流共用），而这个位置是「工作台这一层」的首页 ——
         * 它的作用范围与位置对上了。在 BI / 取数 / 定时里也摸得到。 */
        /* ⚠️ 齿轮「工作台设置」按钮**已删**（票 66，用户 2026-10-29）。
         *
         * 用户原话：「把左侧栏底部齿轮『工作台设置』改成一个板块，板块名『配置』，
         * 排序在最后一个」。所以它现在是侧栏导航里的一块（`boards.ts` 的
         * `id: 'settings'`，分组「系统」，order 100），不再是一个底部按钮。
         *
         * ## 为什么删掉之后「引擎就绪」那行会落到最下面 —— 这是对的
         *
         * 原来底部是「齿轮 → 引擎就绪」两行，现在只剩后者。用户没要求把别的东西
         * 补上去，而那一行**本来就该在最底下**（它是状态，不是入口）。
         *
         * ⚠️ 那一行是**写死的**（`dot ok pulse` + 「引擎就绪」恒定文案）。
         * 引擎健康检测被用户定「记进后期备忘，这一批不做」
         * （`docs/备忘-延后开发功能.md` 第 13 条），所以**别顺手给它接真状态**。
         */
        /* 状态行（照 FounderOS 的底部）：状态点 + 一行等宽小字。 */
        h('div', {
          className: 'flex items-center gap-2 whitespace-nowrap font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]',
        },
          h('span', { className: 'dot ok pulse' }),
          navCollapsed ? null : h('span', null, '引擎就绪'),
        ),
      ),
    ),
    // ── 右：内容区 ────────────────────────────────────────────
    h('section', { className: css.content },
      /* 顶部面包屑栏 —— 照 FounderOS 的 Topbar：产品名 / 当前板块。 */
      /* ── 面包屑行（`topHidden` 为真时整行不渲染）──────────────────────
       *
       * ★ 票 48：「收起顶部」搬到这里，**左端第一颗**（用户：「收起顶部按钮挪到面包屑」）。
       *
       * 原来它在两个地方（侧栏底部 + tab 行上方单独一行），是「两版并存观察」的遗留。
       * 现在只剩两个位置，且**同一时刻只出现一个**：
       *   展开态 → 在这一行左端（本处）
       *   收起态 → 这一行整个没了，按钮进 tab 行首位（见下面那段）
       *
       * `data-ewb-top-toggle` 的取值也跟着换了：`sidebar` 那个位置已经不存在，
       * 继续用那个名字会让下一个人照着去找一颗不存在的按钮。 */
      topHidden
        ? null
        : h('div', {
            className: 'flex h-[52px] shrink-0 items-center gap-3.5 border-b border-[var(--dsw-alias-border-l2)] px-6',
          },
            h('button', {
              type: 'button',
              'data-ewb-top-toggle': 'breadcrumb',
              /* ★ 票 65：去外框、去文字、换图标（用户 2026-10-29）。
               *
               * 用户原话：「板块顶部面包屑左侧的收起按钮，不要外框（鼠标移动过去
               * 亮起即可）找一个图标不要用文字符号，不用太大。」
               *
               * ## 逐项对照（改前 → 改后）
               *
               * | | 改前 | 改后 |
               * |---|---|---|
               * | 外框 | `border border-…` + `rounded-ctl` | **没有**（鼠标移上去才亮） |
               * | 悬停 | `pressable is-dark`（3D 透视 + 抬起 + 放大 1.05 + 投影） | **去掉**，只留 `hover:text-…` 变色 |
               * | 尺寸 | `px-2 py-1`（按内容撑成胶囊） | `h-6 w-6`（24×24 居中小方块） |
               * | 内容 | `⌃` 字符 + 文字「收起顶部」 | **只有 SVG**（`ChevronUpIcon`，14px） |
               *
               * ⚠️ `pressable is-dark` 必须去掉，不能只去 `border` ——
               * 那个类自带 `hover:scale-[1.04]` 与投影，用户说的「太显眼」
               * 主要就是它。留着等于只做了一半。
               *
               * ⚠️ **`title` / `aria-pressed` / `data-ewb-top-toggle` 一个字都不许改**：
               * 它们是行为契约（测试与无障碍都按它们找），这次只动**长相**。 */
              className: [
                'flex h-6 w-6 shrink-0 items-center justify-center',
                'bg-transparent text-[var(--dsw-alias-label-tertiary)]',
                'hover:text-[var(--dsw-alias-label-primary)]',
              ].join(' '),
              title: '收起顶部标题，把画面让给内容区',
              'aria-pressed': topHidden,
              onClick: toggleTop,
            },
              h(ChevronUpIcon, { size: 14 }),
            ),
            h('div', {
              className: 'flex items-center gap-2 whitespace-nowrap font-mono text-ewb-caption tracking-[0.04em] text-[var(--dsw-alias-label-tertiary)]',
            },
              h('span', null, '电商工作台'),
              h('span', { className: 'opacity-45' }, '/'),
              h('span', { className: 'text-[var(--dsw-alias-label-primary)]' }, board?.title ?? ''),
            ),
          ),
      h('div', {
        className: [
          'flex min-h-0 flex-1 flex-col pb-4 pt-5',
          /* ★ 票 73：收起态横向边距**归零**（用户 2026-10-29）。
           *
           * 用户原话：「收起顶部栏后两边边距取消，内容区域宽度也不应该限制这个模式……
           * 画布使用时不该被限制宽度，而其他的界面如果不限制宽度很多内容会过宽
           * 导致视觉不好看。可能有更好的方式处理，但是先手动把。」
           *
           * 改前是 `px-2` —— 收起态仍然白占 2 档横向空间。收起顶部的目的是
           * 「把画面让给内容」，留边距与那个目的相矛盾。
           *
           * ⚠️ **上下两档（`pb-4 pt-5`）不动**：用户只说了「两边边距」。
           * 那不是遗漏 —— 上下留白是为了内容不贴着 tab 行与窗口底，与横向无关。 */
          topHidden ? 'px-0' : 'px-8',
        ].join(' '),
      },
        /* ── 内容主体限宽 1440（**用户 2026-10-28 改主意**，票 49）───────────
         *
         * ## 这里原来写的是「不要最大宽度」
         *
         * 旧注释的立场是：这是执行工作流的操作台，窗口本就不宽，
         * 再收窄只会浪费横向空间 —— 所以当时**刻意不加**上限。
         *
         * 那个前提在当时成立（右列只占对话列的一半多一点）。**现在用户改主意了**，
         * 要求「板块内容区域最大宽度限制在 1440，板块边与内容随整体宽度调整」。
         *
         * 所以这一条不是「补一个从没做过的功能」，是**推翻一条既有决定** ——
         * 注释必须跟着改成新理由，不能直接删：代码里明明有 `maxWidth`、
         * 注释却说「最大宽度去掉」，下一个人会更困惑。
         *
         * ## 限的是哪一层（票面要我先判断的那条）
         *
         * **只有内容主体**（大标题 + tab 行 + 板块本体），**面包屑那一行继续铺满**。
         * 依据是用户的原话是「**板块内容区域**」而不是「整个右列」：
         * 面包屑是「你在哪」的导航，它铺满整行时与窗口边缘对齐，反倒更像一条顶栏；
         * 而大标题与板块本体才是「内容」，它们该有自己的阅读宽度。
         *
         * ## 为什么用内联 `style` 而不是 CSS Modules 的类
         *
         * 判据要求「能读到那个值」（票面验收 1 原话：**不是搜源码文本**）。
         * `dom-render` 把 `.module.css` 一律当**空模块**（`export default {}`），
         * 于是类名断言只能退化成「读 CSS 源文件找那一行」—— 那正是票面禁止的弱判据。
         * 内联 `style.maxWidth` 是 DOM 上**真读得到**的值，断言直接比字符串。
         *
         * ## 为什么同时写 `w-full` + `md:mx-auto`
         *
         * · `w-full` 保住「窄屏时仍跟父级一样宽」—— 只写 `max-width` 而不给宽度，
         *   块级元素本来就是满宽，但这里父级是 flex 容器，不加 `w-full` 会被
         *   `align-items: stretch` 之外的因素影响（`flex-col` 下 cross axis 是水平方向，
         *   stretch 会满宽；显式写 `w-full` 是把这件事钉住，不靠默认行为）。
         * · `mx-auto` 只在**宽度真的被钳住时**才产生非零外边距：窄于 1440 时
         *   剩余空间为 0，`auto` 算出来就是 0 —— **窄屏视觉上毫无变化**（验收 2）。
         *
         * ⚠️ **不许改成 `w-[1440px]`**：那会把窄窗口里的内容也撑到 1440
         * （横向溢出），而这正是票面点名要防的回归。 */
        h('div', {
          'data-ewb-content-main': '',
          className: 'flex min-h-0 w-full flex-1 flex-col md:mx-auto',
          /* ★ 票 69：值来自偏好（五档，`0` = 不限宽 → 不写这个样式）。
           *
           * ⚠️ `0` 时**不写 `maxWidth`**，不是写 `maxWidth: 0` 也不是写
           * `maxWidth: 'none'`：前者会把内容压成一条线，后者在 jsdom 里读回来是
           * `'none'`、判据分不清「没写」与「写了 none」。不写这个属性是**最直接的**
           * 「没有限制」表达，DOM 上也验得干净（`style.maxWidth === ''`）。
           *
           * ## ★ 票 73（2026-10-29）：**收起态也让限宽失效**
           *
           * 用户原话：「内容区域宽度设置**只是显示顶部栏展开的时候**，
           * 顶部栏收起后内容区域宽度设置失效 —— 其实这个设置主要是给两个画布用的，
           * 画布使用时不该被限制宽度，而其他的界面如果不限制宽度很多内容会过宽
           * 导致视觉不好看。可能有更好的方式处理，但是先手动把。」
           *
           * ## 两个条件合成一个表达式（这里的选择，票面让我自己定）
           *
           * | 条件 | 谁的 | 表达的意思 |
           * |---|---|---|
           * | `contentMaxWidth === 0` | 票 69 | 用户在下拉里选了「不限宽」 |
           * | `topHidden` | 票 73 | 顶部收起 → 正在干活（多半是在画布上），别钳他 |
           *
           * 合成一个 `||` 而不是分两层包 `style`：两者的**结果完全一样**
           * （都是 `undefined`），分两层只会多一层缩进、多一个「两处会不会不一致」
           * 的问题。分开的是**理由**，所以理由写在注释里，不写在代码结构里。
           *
           * ⚠️ **偏好值本身不改、不清**（票面第 4 条）：收起再展开，
           * 用户之前选的那一档要还在。这里只控制「这次渲不渲染」，不碰
           * `workbench-prefs.ts` 里存的值。
           *
           * ⚠️ 用户自己说「可能有更好的方式处理，但是先手动把」——
           * 所以**不要**自己升级成「画布板块永远不限宽」这种更聪明的规则。
           * 他明确选了先按手动挡做。 */
          style: contentMaxWidth === 0 || topHidden ? undefined : { maxWidth: contentMaxWidth },
        },
          topHidden ? null : h(PageHeader, { key: board?.id ?? '', title: board?.title ?? '' }),
          /* ── tab 行：**收起态时「展开顶部」是这一行的第一个元素**（票 48）──
           *
           * 用户原话：「收起之后放在板块TAB的第一个」。
           *
           * ## 与改之前的三处差别
           *
           * | | 改之前 | 现在 |
           * |---|---|---|
           * | 收起态按钮在哪 | **单独一行**（`pt-1` 那个 div） | 与 tab 同一行、排在最前 |
           * | 展开态按钮在哪 | 也是那一行（两个入口并存） | 面包屑行左端，**这一行不再有它** |
           * | `data-ewb-top-toggle` | `tabbar` + `sidebar` 两个都在 | 展开 `breadcrumb` / 收起 `tabbar`，**同一时刻只有一个** |
           *
           * ## 为什么这一行在「没有 tab 的板块」也渲染
           *
           * 总览 / 自动化 / BI / 提示词没有 tab，但**收起态下它们同样需要「展开顶部」**
           * —— 那是它们回到面包屑与大标题的唯一入口。所以这一行的条件是
           * `topHidden || tabs.length > 0`：有 tab 就永远在；没 tab 时只在**收起态**出现
           * （展开态它们什么都不缺，不该凭空多出一条空行）。
           *
           * ## 为什么 `tabsRef` 挪到内层那个包 tab 的 div 上
           *
           * `tabsRef` 是用来量「tab 可用宽度」的（`:440` 那个 `useLayoutEffect` 读
           * `el.clientWidth` 再除以 tab 数量）。混进按钮之后那个 div 变宽了，
           * 量出来的宽度会**把按钮也算进 tab 的地盘** → 每个 tab 被算窄。
           * 所以把 ref 挪到真正只装 tab 的那一层。 */
          topHidden || tabs.length > 0
            ? h('div', { className: 'flex flex-none items-center gap-2 pt-1' },
                topHidden
                  ? h('button', {
                      type: 'button',
                      'data-ewb-top-toggle': 'tabbar',
                      /* ★ 票 65：与面包屑那颗同一套（去外框、去文字、换图标）。
                       *
                       * 用户原话：「收起后的展开按钮也按照这个逻辑改，
                       * 不要太大、不要太显眼。能点能收就行。」
                       *
                       * 方向约定见 `icons.tsx` 的 `ChevronUpIcon`：
                       * 收起态用**向下**箭头（顶部那块要往下回来）。
                       *
                       * ⚠️ 两颗按钮的 `className` **逐字相同** —— 它们本来就该长得一样，
                       * 一处改了另一处没改是最常见的漂法。判据里有一条专门查这个。 */
                      className: [
                        'flex h-6 w-6 shrink-0 items-center justify-center',
                        'bg-transparent text-[var(--dsw-alias-label-tertiary)]',
                        'hover:text-[var(--dsw-alias-label-primary)]',
                      ].join(' '),
                      title: '展开顶部标题（恢复面包屑与大标题）',
                      'aria-pressed': topHidden,
                      onClick: toggleTop,
                    },
                      h(ChevronDownIcon, { size: 14 }),
                    )
                  : null,
                tabs.length === 0
                  ? null
                  : h('div', { ref: tabsRef, className: css.tabs + ' min-w-0 flex-1' },
                      h(SlidingTabs<string>, {
                        tabs,
                        value: tab,
                        tabWidth,
                        variant: 'underline',
                        onChange: (id: string) => { if (board !== undefined) selectTab(board.id, id) },
                      }),
                    ),
              )
            : null,
          /* ── 内容：常驻板块各自一个绝对定位的格子，其余一个滚动容器 ─────────
           *
           * ⚠️ 常驻板块**不能条件渲染**：切走就卸载 → 画布的节点/连线（组件内 useState）丢失，
           * 而撤销栈是模块级 store 不跟着销毁 → 切回来「屏幕」与「历史」对不上。
           * 藏的机制与四个坑写在 EcomWorkbench.module.css 的 .boardPane 注释里。 */
          h('div', { className: css.body },
            ...panes.map(b => h('div', {
              key: b.id,
              className: css.boardHost,
              'data-active': b.id === board?.id || undefined,
            },
              /* ⚠️ **每个板块外面强制包一层 ErrorBoundary** —— 第三方组件渲染抛错
               * 只坏它那一块，其余照常（这是接入契约的一部分）。 */
              h(ErrorBoundary, { key: b.id, name: b.title },
                h(b.component, propsFor(b, b.id === board?.id))),
            )),
            board === undefined || boardKept
              ? null
              : h('div', { className: css.tabScroll },
                  h(ErrorBoundary, {
                    /* ⚠️ key 取板块 id：换一块时**换一个边界实例**，把上一块的错误状态丢掉。
                     * 不写的话 React 会复用同一个实例 → 修好的那一块仍显示上一块的错误。 */
                    key: board.id,
                    name: board.title,
                    /* 出错了能退回别的板块 —— 否则白屏就点不了任何东西，连换一块都做不到。 */
                    onEscape: () => { setActiveId(boards[0]?.id ?? null) },
                    retryLabel: '重试这块',
                  },
                  h(board.component, propsFor(board, true))),
                ),
            notice === ''
              ? null
              : h('div', {
                  'data-ewb-notice': '',
                  className: 'pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-2)] px-3 py-1.5 text-ewb-meta text-[var(--dsw-alias-label-primary)]',
                }, notice),
          ),
        ),
      ),
      /* 工作台设置抽屉：挂在右列这一层（不是某个板块里）——
       * 它是**工作台级**的，切板块时不该跟着卸载。 */
    ),
  )
}
