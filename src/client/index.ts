/** 电商工作台 · Client 半入口。
 *
 * 显示方式（照原 workbench 的挤压模式，但改为右列叠加）：
 * 1. 左栏 `sidebar.panellist` 一行：**只放品牌图标**（官方拥有那一行的按钮）。
 * 2. 左栏底部 `sidebar.footer.action`：**我们自己的开关按钮**。
 * 3. 右列注册进 `shell.overlay`：工作台界面叠加在对话列内，可拖宽。
 * 4. 挤压：开关写 html[data-ewb] → CSS 挤压对话列；另有「隐藏对话区」开关。
 *
 * 为什么不用 main 插槽：用户要求对话区保留（工作台与 agent 相关，不是两个独立的东西）。
 *
 * ⚠️ **2026-10-13 修掉一个违规注册**（用户实测：「整个左侧栏被左侧按钮遮挡」）：
 * 原来在 `sidebar.panellist` 里渲染**一整个按钮**并用 CSS 盖住官方那一行，
 * 而官方契约是「the sidebar owns the button and resolves its label from list metadata」——
 * 那个孔位只该给一个**图标**。详见 `EcomWorkbenchEntry.tsx` 顶部说明。
 */
import type { Context } from '@deepseek-ai/cordis'
import { EcomWorkbench } from './workbench/EcomWorkbench.tsx'
/* Tailwind 样式表**第一个引入**——它不带 @layer，同优先级时后面的手写表仍然赢。 */
import './styles/tailwind.css'
/* React Flow 的基础样式。
 *
 * ⚠️ **必须这样直接 import**（2026-10-10 修，这是「画布异常」的真根因）：
 * 原来写的是 `xystyle.css` 里一句 `@import '@xyflow/react/dist/style.css'` ——
 * 而构建产物把它变成 `<style>` 标签里的 `@import` 文本，**裸模块名在浏览器里解析不了**
 * （`@import` 也必须在样式表最开头、不能是运行时注入的 style 元素）。
 * 结果：**React Flow 的全部样式从未生效** —— 小地图跑回左上角、节点基础样式缺失、
 * 交互层不可点，表现为「画布异常」。
 *
 * 直接 import 则走构建器的 CSS 管线，内容会被**内联**进产物。 */
import '@xyflow/react/dist/style.css'
import { FooterToggle } from './workbench/EcomWorkbenchEntry.tsx'
/* 板块注册表：**给第三方插件的入口**（docs/指引-插件接入.md 承诺的形状）。
 * 我们自己的八个默认板块走的是同一个 registerBoard —— 没有特权通道。 */
import { registerBoard } from './workbench/board-registry.ts'

export const inject = ['slots', 'layout']

/** 面板 id（panellist 行 id 与 overlay 列 id 共用）。 */
const WB_ID = 'ecom-workbench'

/** 工作台开关（模块级；写 html 属性驱动挤压 CSS）。 */
let wbOn = false
/** 对话区是否隐藏（对话仍在，只隐内容）。 */
let hideChat = false

/**
 * 左侧栏控制器（激活时从 `ctx.layout` 存入）。
 *
 * dsh 的 `ctx.layout.toggleSidebar()` 只提供**切换**，没有「设成收起」这种绝对操作，
 * 所以我们必须先读当前状态、再决定要不要切。见 `dshSidebarCollapsed()`。
 */
let layoutCtl: { toggleSidebar: () => void } | null = null

/**
 * 「隐藏对话区」时是不是**我们**把左侧栏收起来的。
 *
 * 为什么记这个：用户可能本来就手动收着左栏。不记的话，取消隐藏对话时会
 * 把「本来就收着的」也一起展开 —— 那就改了用户自己的状态，不是我们要做的。
 */
let sidebarCollapsedByUs = false

/**
 * 读 dsh 左侧栏当前是不是收起状态。
 *
 * 依据：`AppFrame.tsx` 在收起时给 frame 挂 `data-sidebar-collapsed`（未收起则**不挂**），
 * 见 `refs/deepseek-harness@62962ee4/packages/client/ui-layout/src/client/AppFrame.tsx`。
 * 没有公开的读取接口（`ctx.layout` 只暴露动作、不暴露宽度），所以读这个属性最可靠。
 * @returns 收起则 true。
 */
function dshSidebarCollapsed(): boolean {
  return document.querySelector('[data-sidebar-collapsed]') !== null
}

/**
 * 切换工作台开关。
 * @param on - 目标状态。
 */
function setWbOn(on: boolean): void {
  wbOn = on
  if (on) document.documentElement.dataset.ewb = 'on'
  else {
    delete document.documentElement.dataset.ewb
    /* ⚠️ 关工作台时**必须连带取消「隐藏对话区」**（2026-10-08 修的真 bug）：
     *
     * 「隐藏对话区」是靠 `data-ewb-hide-chat` 这个属性让对话列内容 visibility:hidden 生效的。
     * 而工作台一关，右列被 CSS 隐藏、那个「显示对话区」的按钮也就点不到了——
     * 若不在这里连带清掉，属性会一直挂着，**对话区永远空白**，用户没有任何办法恢复。
     *
     * 所以规则是：关工作台 ⇒ 顺带把「隐藏对话」也复位。 */
    if (hideChat) setHideChat(false)
  }
  window.dispatchEvent(new window.Event('ewb-mode-change'))
}

/** 读取工作台开关。
 * @returns 当前状态。
 */
function getWbOn(): boolean { return wbOn }

/**
 * 切换对话区隐藏。
 *
 * 用户 2026-10-11 要求：「隐藏对话区的时候也应该隐藏 dsh 的左侧栏」——
 * 目的与「隐藏对话区」一致：把那块横向空间也让给工作台。
 * 反过来取消隐藏时，把**我们收的那次**展开回来（本来就收着的则不动，见
 * `sidebarCollapsedByUs` 的说明）。
 *
 * @param v - 是否隐藏。
 */
function setHideChat(v: boolean): void {
  const was = hideChat
  hideChat = v
  if (v) document.documentElement.dataset.ewbHideChat = 'on'
  else delete document.documentElement.dataset.ewbHideChat

  /* 与左侧栏联动。只在状态**真的变化**时动，避免重复调用把栏来回切。 */
  if (v !== was && layoutCtl !== null) {
    if (v) {
      /* 收起前先看是不是本来就收着（读的是点击前的 DOM，准确）。
       * 本来就收着就不动它 —— 那是用户自己的状态。 */
      if (!dshSidebarCollapsed()) {
        layoutCtl.toggleSidebar()
        sidebarCollapsedByUs = true
      }
    } else if (sidebarCollapsedByUs) {
      /* ⚠️ 这里**按标记对称地切回去**，不要再去读一次 DOM：
       * dsh 的侧栏是 React 渲染的，刚 toggle 完 DOM 未必已更新，
       * 再读一次可能读到旧值 → 该展开的没展开，左栏就永远收着、用户没法恢复。
       * 标记本身已经表达了「我们收的那一下还没撤销」，对称撤销即可。 */
      layoutCtl.toggleSidebar()
      sidebarCollapsedByUs = false
    }
  }

  window.dispatchEvent(new window.Event('ewb-mode-change'))
}

/** 读取对话区隐藏状态。
 * @returns 是否隐藏。
 */
function getHideChat(): boolean { return hideChat }

/** 注入开关行样式与挤压样式（一次）。
 *
 * ## ⚠️ 2026-10-13 重写：不再碰官方私有类名，不再覆盖官方按钮
 *
 * 原来这里用 `[class*="panelRow"]` 匹配官方**构建器生成的哈希类名**，
 * 再用 `inset:0; z-index:3` 把我们的按钮盖满整行、`stopPropagation` 拦掉官方点击、
 * `visibility:hidden` 藏掉官方文字。三个做法都违反了官方契约
 * （`sidebar.panellist` 是**图标**孔位，官方注释：
 * 「the sidebar owns the button and resolves its label from list metadata」），
 * 后果就是用户报的**「整个左侧栏被左侧按钮遮挡」**。
 *
 * 现在：
 *   - 图标孔位里**只放图标**（尺寸位置全由官方决定，我们一行布局样式都不写）；
 *   - 开关按钮改放 `sidebar.footer.action`（那个孔位官方不套按钮，是给动作用的）；
 *   - 按钮样式只锚**我们自己的** `data-ewb-*` 属性，官方改类名不受影响。
 *
 * ⚠️ 顺带一个收益：**不再有任何一条规则依赖哈希类名**。
 * 原来那种选择器失败是**静默的** —— 官方一改类名，样式不生效、不报错，
 * 表现为「界面突然乱了」而查不到原因。
 */
function injectCss(): void {
  if (document.getElementById('ewb-style') !== null) return
  const s = document.createElement('style')
  s.id = 'ewb-style'
  /* ⚠️ **必须打上归属标记**（2026-10-18）。dsh 的客户端模块系统在每次实例化插件
   * 代码之后会扫 `style:not([data-plugin])`，把**所有没有标记的 style 标签**
   * 认成「刚加载的那个插件的」（`packages/client/modules/src/client/system.ts`
   * 的 `claimStyles`，官方注释：*any untagged tag is claimed for the materializing plugin*）。
   * 而插件重载/卸载时它会 `removeOwnedStyles(id)` 把该插件名下的标签全删掉
   * （`entry-lifecycle.ts`）。
   *
   * 不打标记的后果：**我们这张表会被后加载的某个插件认领** → 那个插件一重载，
   * 我们的挤压规则（`html[data-ewb="on"] [class*="centerCol"]`）就**消失了** ——
   * 表现是「工作台还浮在右边，但聊天区没被压缩」。用户 m07860 报的就是这个组合。
   *
   * 标成我们自己的 id 之后：只有我们自己的重载会删它，而那时 `apply` 会重新注入。 */
  s.dataset.plugin = '@our/ecom-workbench'
  s.textContent = [
    /* ── 底部开关按钮（我们自己的按钮，官方不套 <button>）──────────────
     * 只锚 `data-ewb-footer-toggle` —— 不碰官方任何类名。
     * 视觉参照官方设置键：宽态「图标 + 文字」，收起态只留图标。 */
    '[data-ewb-footer-toggle] { display:flex; align-items:center; gap:8px; width:100%;',
    '  min-height:36px; padding:7px 8px; margin:0; box-sizing:border-box;',
    '  background:transparent; border:none; cursor:pointer; color:inherit; font:inherit;',
    '  text-align:left; border-radius:var(--dsw-radius-md, 12px);',
    '  transition: background-color 200ms cubic-bezier(.22,.61,.36,1), color 200ms cubic-bezier(.22,.61,.36,1); }',
    '[data-ewb-footer-toggle]:hover { background: var(--dsw-alias-interactive-bg-hover); }',
    '[data-ewb-footer-toggle]:focus-visible { outline:var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4a9eff)); outline-offset:-2px; }',
    /* 开启态取品牌色（与未开启区分开），与图标孔位同一套语义。 */
    '[data-ewb-footer-toggle][data-on="on"] { color: var(--dsw-alias-brand-primary); }',
    '[data-ewb-footer-label] { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
    /* 收起态（56px rail）：只留图标、居中、不占满宽 —— 官方收起时
     * 底部那一排也是这个形态（我们不猜像素，只跟随父容器宽度）。 */
    ':is([class*="collapsed"]) [data-ewb-footer-toggle] { width:auto; justify-content:center; }',
    ':is([class*="collapsed"]) [data-ewb-footer-label] { display:none; }',
    /* ── 挤压官方对话列 ──────────────────────────────────────────────
     * ⚠️ `centerCol` 也是**官方哈希类名**。这一条暂时必须留着（没有别的
     * 公开接口能改中间列的宽度），但它是**已知的脆弱点**：
     * 官方改类名则挤压失效（表现是「开着工作台但对话区没让位」）。
     * 记在这里，将来若有公开的列宽接口要换掉。 */
    'html[data-ewb="on"] [class*="centerCol"] { padding-right: var(--ewb-squeeze, 42%) !important; box-sizing: border-box; }',
    /* 隐藏对话区：只隐对话列的内容（列本身保留占位，避免网格重排导致右列错位） */
    'html[data-ewb-hide-chat] [class*="centerCol"] > * { visibility: hidden !important; }',
    'html[data-ewb-hide-chat] [class*="centerCol"] { padding-right: 0 !important; }',
    /* 右列显示/隐藏由开关驱动 */
    'html:not([data-ewb="on"]) [data-ewb-column] { display: none !important; }',
  ].join('\n')
  document.head.appendChild(s)
}

/** 开关读写器（传给组件）。 */
const hooks = { get: getWbOn, set: setWbOn, getHideChat, setHideChat, getWb: getWbOn, setWb: setWbOn }

/**
 * 把模块级状态**与 DOM 对齐**。
 *
 * ## 为什么必须有（2026-10-18，用户报「窗口自动跳出来、关不掉」）
 *
 * 这套开关有**两处状态**，它们的寿命完全不同：
 *
 * | 状态 | 存在哪 | 插件重载后 |
 * | --- | --- | --- |
 * | `wbOn` / `hideChat` | 模块级变量 | **回到初始的 false** |
 * | `<html data-ewb>` / `<html data-ewb-hide-chat>` | 页面 DOM 上的属性 | **留着** |
 *
 * 于是插件代码一被重新求值（dsh 的客户端插件重载、HMR、插件管理器操作），
 * 两边就对不上了 —— 而**显示与否只看 DOM 属性**，所以：
 *
 * - 工作台**还显示着**（属性仍是 on），浮在对话区上面；
 * - 两个开关按钮都算 `!getWb()` = `!false` = **true**，点一下等于**又开一次**，
 *   属性本来就是 on，界面上**毫无变化** → 用户看到的「关不掉」；
 * - 「隐藏工作台」与侧栏那个按钮**同一动作**，所以两边都按不动。
 *
 * 修法不是加个 try/catch，而是**认 DOM 为唯一真相**：进入插件先回读一遍，
 * 让内存状态追上页面实际状态。这样重载之后第一次点击就是「真的关掉」。
 */
function reconcileFromDom(): void {
  wbOn = document.documentElement.dataset.ewb === 'on'
  hideChat = document.documentElement.dataset.ewbHideChat === 'on'
  /* 上次是不是我们收的侧栏，已经无法知道（那次会话的标记随重载丢了）。
   * 保守取 false：不再代用户动侧栏，比乱展开安全。 */
  sidebarCollapsedByUs = false
}

/** 插件激活入口（Client 半）。
 * @param ctx - cordis 上下文。
 */
export function apply(ctx: Context): void {
  /* ⚠️ 必须在 injectCss 与任何渲染**之前**跑：下面注册的组件会立刻用
   * `hooks.getWb()` 决定按钮文案与状态，读到 false 就是上面那个「关不掉」。 */
  reconcileFromDom()
  injectCss()

  /* 存下布局控制器，供「隐藏对话区 ⇒ 收起左侧栏」用。
   * 用 ctx.effect 包住是为了在插件卸载时把引用清掉（不留悬空指针）。 */
  ctx.effect(() => {
    layoutCtl = { toggleSidebar: () => { ctx.layout.toggleSidebar() } }
    return () => { layoutCtl = null }
  }, 'ecom-workbench: layout control')

  /* ── 左栏入口：**只在底部**（2026-10-13 第二轮定）──────────────────
   *
   * 用户决定（原话）：「去掉顶部的，**保留底部的两个按钮**」。
   *
   * ## 为什么不用顶部 `sidebar.panellist`
   *
   * 那个孔位**不是一个可以塞东西的容器** —— 它的语义是
   * 「**一个指向同名中央面板（`main`）的指针**」。官方注释：
   * 「Each list id addresses the **matching main panel**; the sidebar owns the button…」
   *
   * 用它的正路是「注册一个 key = 本插件 id 的 `main` 面板，点图标 = 官方切过去」。
   * 而我们要的是**叠加在右侧、对话保留**，不是「切走中间那块」——
   * 与那个语义不一致，所以**不用它**。
   *
   * ⚠️ 这条决定还顺带解掉一个**我上一轮引入的 bug**：
   * 我删掉 `stopPropagation` 之后，官方那一下点击会真的执行
   * `ctx.layout.selectPanel('ecom-workbench')`，而官方在
   * `ui-layout/service.ts:73` 里**没有同名 `main` 面板就抛错**：
   * 「layout.selectPanel: main panel "..." is not registered」。
   * 现在**根本不注册那个图标**，也就没人触发它 —— 从源头消除。
   *
   * 底部 `sidebar.footer.action` 是「一个动作」的席位，放我们自己的按钮合规。 */
  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: WB_ID,
    order: 40,
    label: () => '电商工作台',
  }, props => FooterToggle({
    hooks,
    wide: props?.wide !== false,
  }))), 'ecom-workbench: footer toggle')

  /* ── 把注册表本身挂到 ctx 上（第三方插件从这里接进来）──────────────
   *
   * 形状见 docs/指引-插件接入.md：
   *   ctx.effect(() => ctx.ecomWorkbench.registerBoard({ id, title, component }))
   * 返回**反注册函数**，交给 ctx.effect —— 插件停用或热更新时自动摘掉，
   * 不交的话热更新后会叠出两个同名板块（注册表对同 id 重复注册是按「替换」处理的，
   * 那是兜底，不是正路）。
   *
   * ⚠️ 这里必须**判存在再 provide**：cordis 的 reflect 在某些宿主壳里没有，
   * 而测试桩（dom-render 的 fakeCtx）也没有它 —— 直接调会把 apply 整个炸掉，
   * 表现是「工作台打不开」。 */
  ctx.effect(() => {
    const reflect = (ctx as unknown as {
      reflect?: { provide?: (name: string, value: unknown) => () => void }
    }).reflect
    if (reflect === undefined || typeof reflect.provide !== 'function') return () => { /* 没有就退场 */ }
    return reflect.provide('ecomWorkbench', { registerBoard })
  }, 'ecom-workbench: board registry service')

  // 2) 右列（shell.overlay）
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: WB_ID,
  }, () => EcomWorkbench(hooks))), 'ecom-workbench: overlay column')
}
