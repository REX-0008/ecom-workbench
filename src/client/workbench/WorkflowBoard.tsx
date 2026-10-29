/** 「工作流」板块的内容 —— 画布 + 工作流管理 + 运行历史。
 *
 * ## 为什么单拎一个文件出来
 *
 * 2026-10-21 的板块重构：**骨架只认注册表，不许出现任何板块 id 的字面量**。
 * 而画布这块有个绕不开的特殊性 —— 它**必须常驻挂载**（切走只藏起来、不卸载），
 * 否则节点与连线是组件内的 `useState`，卸载即丢，而撤销栈是模块级 store 不跟着销毁，
 * 切回来「屏幕」与「历史」对不上。这套逻辑原先写在骨架里、还带着
 * `board.id === 'workflow' && tab === 'workflow.canvas'` 这种字面量判断。
 *
 * 现在它搬到这里：板块自己知道哪一格是画布，骨架只管「按注册表渲染」。
 *
 * ## 常驻挂载的两步（缺一步就退化成「切走就丢」）
 *
 *   ① **见过就永远挂载**：`canvasSeen` 一旦为真不再回落（骨架也有同样的一道闸门，
 *      它管的是「页签级」的常驻；这里这道管的是「本板块内」）。
 *   ② **非当前时藏起来**：靠 `css.pane` 的 `opacity` 与 `data-active` ——
 *      四条坑（不能用 visibility / display、必须绝对定位、pointer-events 要 !important）
 *      全写在 `EcomWorkbench.module.css` 的 `.pane` 注释里，别在别处重写一套。
 *
 * `active` 必须传下去：画布隐藏时要**停掉自己的全局键盘监听**，
 * 否则用户在别的界面上按 Ctrl+Z，会默默改到看不见的画布上。
 */
import { createElement as h, useEffect, useState } from 'react'
import type { BoardProps } from './board-registry.ts'
import { WorkflowCanvasSwitch } from './WorkflowCanvasSwitch.tsx'
import { RunHistoryPanel } from './RunHistoryPanel.tsx'
import { WorkflowList } from './WorkflowList.tsx'
import { requestOpen } from './pending-load.ts'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import css from './EcomWorkbench.module.css'

/**
 * 工作流板块。
 *
 * @param props - 注册项给的入参（`active` / `tab` / `topHidden` / 回调）。
 * @returns 画布格子 + 非画布 tab 的内容。
 */
/** 除「画布」之外永远显示的那两格（顺序与 `boards.ts` 的 `tabs` 一致）。 */
const ALWAYS: readonly string[] = ['files', 'history']

/**
 * 工作流板块。
 *
 * @param props - 注册项给的入参（`active` / `tab` / `topHidden` / 回调）。
 * @returns 画布格子 + 非画布 tab 的内容。
 */
export function WorkflowBoard({
  active, tab, topHidden, onToggleTop, onSelectTab, keptTabs, onTabsChange,
}: BoardProps): React.JSX.Element {
  /**
   * 画布是**打开**着的（票 01，2026-10-30）。
   *
   * ## 语义：不是「有没有画布组件」，是「用户打开了一份东西」
   *
   * 用户原话：「默认隐藏画布，在工作流管理中新建或者打开画布才在第一个 TAB 出现画布。」
   *
   * `false` → 不报 `canvas`，tab 条上只有「工作流管理」与「运行历史」；
   * `true`  → 报 `['canvas', 'files', 'history']`，画布排第一。
   *
   * ## 与 `seen` 的区别（别合并成一个）
   *
   * · `openId` 管「**在不在 tab 条上**」—— 用户能看见的那件事；
   * · `seen` 管「**组件挂没挂**」—— 常驻挂载，用户看不见但状态靠它。
   *
   * 关掉画布之后 `openId` 清空（那一格消失），但 `seen` 仍为真（组件还挂着），
   * 下次打开不用重挂、也不丢撤销栈。
   */
  const [openId, setOpenId] = useState('')

  /* 上报「现在哪几格该显示」：只有画布是动态格，打开了一份才出现。 */
  useEffect(() => {
    onTabsChange?.(openId === '' ? ALWAYS : ['canvas', ...ALWAYS])
  }, [openId, onTabsChange])

  /** 画布这一格是不是正显示着（板块本身没显示时当然也不是）。 */
  const canvasActive = active && tab === 'canvas'

  /**
   * 骨架声明的「必须一直挂着的格子」（2026-10-25 契约 AU）。
   *
   * ⚠️ **按格判断，不假设只有一格**：以前常驻格只有一个，代码里到处是
   * 「非激活时 `tab` 一定是画布」这种隐含假设。现在骨架把全量清单传下来，
   * 这里就问「画布在不在清单里」，而不是「`tab` 是不是画布」。
   * 将来本板块要是加第二格常驻（比如运行历史），这里的判据不用改。
   */
  const canvasKept = (keptTabs ?? []).includes('canvas')

  /**
   * 画布是否已经「见过」（一旦打开过就永远保留）。
   *
   * 为什么要有这道闸门：常驻挂载是为了**切 tab 不丢状态**，
   * 但没必要一进这个板块就挂一个 React Flow —— 白费一次渲染。
   *
   * ⚠️ **「见过」一旦为真不再回落**：这道闸门管的是「本板块内切 tab」；
   * 「页签级」的常驻由骨架的 `panes` 那道管。两道都必须在，
   * 少一道就退化成「切走就丢」。
   */
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    /* ⚠️ 票 01：判据从「此刻看着画布」扩成「看着画布**或**打开了一份」。
     *
     * 原来只有 `canvasActive` —— 那时画布常显，打开就等于看着。
     * 现在「打开」这个动作可能不伴随「切过去」（见下面 `openWorkflow`），
     * 只看 `canvasActive` 会漏掉那一路：用户从列表点了「打开到画布」，
     * 骨架切过去了才算见过 —— 而 `openWorkflow` 已经切了，所以其实还是够。
     *
     * 但**保险起见**加 `openId !== ''`：`seen` 是「组件挂没挂」，
     * 一旦用户表达过「我要用画布」就该挂上，不该依赖某一刻的 `tab` 值。
     * 两条任一成立即挂，语义更直白。 */
    if ((canvasActive || openId !== '') && !seen) setSeen(true)
  }, [canvasActive, openId, seen])

  /* 挂不挂画布：见过、或此刻正看着、或骨架说它是常驻格（切走也不许卸）。 */
  const canvasMounted = seen || canvasActive || canvasKept
  /* 此刻该不该显示：只有「板块激活 + 当前 tab 是画布 + 真的开着一份」才算。
   *
   * ★ 票 01：**第三个条件是新加的**，与 `ContentBoard.tsx:96` 那个兜底同一个道理。
   *
   * 画布那格写在 `tabs` **第一位**（用户要求「才在第一个 TAB 出现画布」），
   * 而骨架的「当前格」默认取 `tabs[0]` —— 于是**第一次进这个板块时，
   * 骨架给的 `tab` 就是 `'canvas'`，但一份画布都没打开**。
   * 不加这个条件的话，进板块先看到一片空白（画布挂着一个空的）。
   *
   * ⚠️ 下面那个 `tab === 'canvas' ? null : …` 也跟着改了 `shownTab` ——
   * 只改这里不改那里，会出现「画布没显示、列表也没显示」的全白。 */
  const canvasShown = canvasActive && openId !== ''

  /**
   * 这一格实际该显示什么（照 `ContentBoard.tsx:96`）。
   *
   * 骨架说「当前是画布」而一份都没开 → 实际显示「工作流管理」。
   * 上面 `canvasShown` 用了同一个判据，两处必须一致，否则会两头空。
   */
  const shownTab = tab === 'canvas' && openId === '' ? 'files' : tab
  return h('div', { className: 'flex min-h-0 flex-1 flex-col' },
    /* ⚠️ 画布**永远挂载**（见过之后），只**藏起来** —— 不能条件渲染，理由见文件头。 */
    canvasMounted
      ? h('div', { className: css.pane, 'data-active': canvasShown || undefined },
          /* 画布这一格单独再包一层：它风险最高（要吃任意存档、渲染几十个节点、还常驻挂载）。
           * 包在这里，最坏情况是「画布坏了、列表与运行历史还能用」——
           * 用户能自己切回列表换一份，而不是整个工作台白掉。 */
          h(ErrorBoundary, {
            /* 同一层的边界不换 key：画布常驻，换身份会把画布状态全丢掉。 */
            name: '画布',
            onEscape: () => { onSelectTab('files') },
            retryLabel: '重试画布',
          }, h(WorkflowCanvasSwitch, { active: canvasShown, topHidden, onToggleTop })))
      : null,
    /* ⚠️ 这里的判据是 `shownTab === 'canvas'`（不是 `canvasShown`）：
     * 非激活时骨架传下来的 `tab` 是「第一个常驻格」，它现在**就是画布**；
     * 用 `canvasShown` 会把列表也一起藏掉 —— 后台挂着的板块就成了一片空白。
     * 判「当前格是不是画布」看的是**兜过底**的那个值（`shownTab`），
     * 判「该不该显示画布」才要 `canvasShown`。
     *
     * ★ 票 01（2026-10-30）：判据从 `tab === 'canvas'` 换成 `shownTab === 'canvas'`。
     * 差别只在**一份画布都没打开**时：那时 `tab` 是 `'canvas'`（骨架默认给第一格），
     * 而 `shownTab` 兜成了 `'files'` —— 于是列表照常显示，不会两头空。 */
    shownTab === 'canvas'
      ? null
      : h('div', { className: css.tabScroll },
          shownTab === 'history'
            ? h(RunHistoryPanel)
            : h(WorkflowList, {
                onOpen: (doc: unknown, name: string) => {
                  /* 打开一份：① 记下「画布开着」（于是 tab 条上出现那一格）； */
                  setOpenId(name)
                  /* ② 交接给画布：先把内容放下，再切过去（画布常驻，订阅后取走）。 */
                  requestOpen(doc, name)
                  onSelectTab('canvas')
                },
                onGoCanvas: () => {
                  /* ★ 票 01：**「+ 新建」也算打开了一份**。
                   *
                   * 用户原话：「在工作流管理中新建或者打开画布才在第一个 TAB 出现画布。」
                   * 所以「新建」与「打开」走同一条路 —— 都要让画布那格出现。
                   *
                   * ⚠️ 这里用的是 `ON_NEW_MARK` 而不是 `name`：新建时还没有名字，
                   * 但 `openId` 只当「开着没有」用，值是什么不影响显示。
                   * 写空串不行 —— 空串的语义是「没开」，那一格就不会出现。 */
                  setOpenId(ON_NEW_MARK)
                  onSelectTab('canvas')
                },
              }),
        ),
  )
}

/**
 * 「从工作流管理点了 + 新建」这个动作的标记值（票 01）。
 *
 * ## 为什么不直接置空串
 *
 * `openId` 的语义是「画布开着没有」：空串 = 没开（那一格不出现）。
 * 新建时用户**还没有名字**，但画布确实是开着的 —— 用空串会让
 * 「+ 新建」点了没反应（tab 条上不出现画布）。
 *
 * ## 为什么不用真名字
 *
 * 新建出来的还没有名字，硬造一个（比如 `'未命名'`）会与 `WorkflowList`
 * 里真实存在的同名文件混起来。用一个**不可能与文件名冲突**的标记更干净：
 * 文件名里不许出现换行（宿主半会清洗），所以这个带前缀的值撞不上。
 *
 * ⚠️ 这个值**只用于「有没有开」这一件事**，不会被当作文件名传给任何接口。
 */
const ON_NEW_MARK = '__new__'
