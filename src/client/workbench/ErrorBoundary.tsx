/** 错误边界：**一块渲染抛错不该让整个工作台白屏**。
 *
 * ## 为什么要有它（用户 2026-10-21 报的现象）
 *
 * 用户原话：「点打开到画布，然后整个插件界面空了。」
 *
 * 查下来发现：**全项目一个错误边界都没有**。React 的默认行为是
 * 「渲染期抛错 → 卸载整棵子树」—— 于是画布（它常驻挂载、包着整个 React Flow）
 * 里任何一处抛错，结果不是「画布那块坏了」，而是**整个工作台变成空白页**，
 * 而且**一个字的提示都没有**，用户没法知道发生了什么、更没法自救。
 *
 * 这类 bug 的代价特别高：
 *   - 症状是「整个界面没了」，与真正出问题的那一行**看上去毫无关系**；
 *   - 报错只在 devtools console 里（用户默认不看，也没理由去看）；
 *   - 一白屏就点不了任何按钮，连「换一份工作流」都做不到。
 *
 * ## 为什么放在画布这一层，而不是包住整个工作台
 *
 * 画布是**风险最高的一块**：它要吃任意存档（人写的、老版本的、手改坏的）、
 * 要渲染几十个节点、还常驻挂载。包住它，最坏情况就是「画布这块坏了，
 * 但列表、运行历史、切 tab 都还能用」—— 用户能自己退回列表。
 *
 * 外面那层（整个工作台）**不包**：那一层自己出错的概率低，
 * 而把它包起来会连「提示条」一起吃掉 —— 那就又变成白屏了。
 *
 * ## 它做什么（三件事，一件都不多做）
 *
 *   ① 抓住子树的渲染异常，**显示**错误原文（不吞、不美化）；
 *   ② 给一个「重试」按钮：重置边界，让子树重新渲染（多数瞬时错误这样就好了）；
 *   ③ 给一个「回到列表」按钮：让用户能退出去换一份，而不是卡死。
 *
 * ⚠️ **不做的**：不上报、不写日志文件、不自动重试。
 * 那些都要有宿主半的对应接口，而「让用户先把界面救回来」才是这里的正事。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
/* ⚠️ JSX 走的是 classic runtime（本项目没配 jsx: 'react-jsx'），
 * 所以 `React` 这个名字**必须在作用域里** —— 少这一行真机报
 * `ReferenceError: React is not defined`，而且只在渲染期炸（构建不报）。 */
import { createElement } from 'react'
import css from './error-boundary.module.css'

/** 属性。 */
export interface ErrorBoundaryProps {
  /** 边界名字（提示里写「『画布』出错了」，比只写「出错了」好定位）。 */
  name: string
  /** 出错时可以喊一声（比如切回列表）。不传就只有「重试」。 */
  onEscape?: () => void
  /** 重试按钮的文字（默认「重试」）。 */
  retryLabel?: string
  /** 退出去的按钮文字（默认「回到列表」）。 */
  escapeLabel?: string
  /**
   * 子树。
   *
   * ## 为什么是**可选**（2026-10-24 契约 AK）
   *
   * 三处调用都写成 `createElement(ErrorBoundary, { key, name }, 子节点)` ——
   * 子节点是**变参**（第三个及以后的参数）传的，**不在 props 对象里**。
   * 而这里把它声明成必填，于是 `createElement` 的类型重载认为
   * 「props 少了 `children`」，报 TS2769（`EcomWorkbench.tsx:727` / `:733`、
   * `WorkflowBoard.tsx:62`）。
   *
   * 三条理由说明「改成可选」才是对的：
   *
   *   ① **React 18 自己的类型**用 `PropsWithChildren`，`children` 本来就是可选的；
   *   ② 那三处是**合法的 `createElement` 用法** —— 子节点确实传进去了，
   *      只是走的是变参而不是 props；
   *   ③ 改 props 声明**比改三处调用更对**：改调用就得把子节点硬塞进 props，
   *      与 `createElement` 的语义反着来。
   *
   * ⚠️ 已确认渲染逻辑对 `children === undefined` 安全：正常态那一支是
   * `return this.props.children`（返回 `undefined` 即什么都不渲染，不会炸）。
   */
  children?: ReactNode
}

/** 状态。 */
interface ErrorBoundaryState {
  /** 捕获到的错误（null = 正常）。 */
  error: Error | null
  /** 错误的组件栈（React 给的，比 JS 栈更能指出「哪个组件」）。 */
  info: string
}

/**
 * 错误边界（React 只支持用 class 写这个 —— `getDerivedStateFromError` 是 class 生命周期）。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, info: '' }

  /**
   * 抓到错误 → 记下来（这一句让 React 改渲染兜底界面，而不是卸载整棵树）。
   *
   * @param error - 抛出来的错误。
   * @returns 新的状态。
   */
  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  /**
   * 错误信息收齐之后跑（React 在这里给组件栈）。
   *
   * ⚠️ 这里**只记录，不 setState** —— 在 `componentDidCatch` 里 setState
   * 会让 React 再渲染一轮，配合下面「重试」的重置逻辑容易绕成环。
   *
   * @param _error - 错误（`getDerivedStateFromError` 已经存了，这里不用）。
   * @param info - 组件栈。
   */
  override componentDidCatch(_error: Error, info: ErrorInfo): void {
    /* 直接改 state 上的 info（不走 setState，避免多一轮渲染）。 */
    this.state.info = info.componentStack ?? ''
    /* 同时打到 console —— 用户要贴给我们看时，devtools 里那一份更完整。 */
    console.error('[' + this.props.name + '] 渲染出错：', _error, info.componentStack)
  }

  /**
   * 清掉错误状态，让子树重新渲染。
   */
  private readonly retry = (): void => {
    this.setState({ error: null, info: '' })
  }

  /**
   * 渲染：正常时给子树，出错时给兜底界面。
   *
   * @returns 元素。
   */
  override render(): ReactNode {
    const err = this.state.error
    if (err === null) return this.props.children
    /* ⚠️ 用 `createElement` 而不是 JSX：这个文件在测试里会被 tsx 直接编译，
     * 而 JSX 的 classic runtime 要求 `React` 这个名字在作用域里 ——
     * 只 import 了 `createElement` 是拿不到 `React` 的（构建能过、渲染期炸）。
     * 这里全部走显式 `createElement`，两个环境都一样。 */
    return createElement('div', { className: css.wrap, 'data-ewb-error-boundary': '' },
      createElement('div', { className: css.head },
        createElement('span', { className: css.mark, 'aria-hidden': 'true' }, '✕'),
        createElement('span', { className: css.title }, '「' + this.props.name + '」这一块出错了')),
      createElement('div', { className: css.body },
        /* 原文照登：不美化、不截断 —— 用户要能复制给我们。 */
        createElement('div', { className: css.msg, 'data-ewb-error-msg': '' }, err.message === '' ? String(err) : err.message),
        this.state.info !== '' && createElement('details', { className: css.details },
          createElement('summary', { className: css.summary }, '出错位置（组件栈）'),
          createElement('pre', { className: css.stack }, this.state.info.trim())),
        createElement('div', { className: css.hint },
          '界面渲染出错，数据未损坏：存档仍在磁盘，未被修改。')),
      createElement('div', { className: css.foot },
        createElement('button', {
          type: 'button',
          className: css.btn,
          'data-ewb-error-retry': '',
          onClick: this.retry,
        }, this.props.retryLabel ?? '重试'),
        this.props.onEscape !== undefined && createElement('button', {
          type: 'button',
          className: css.btn,
          'data-ewb-error-escape': '',
          onClick: () => { this.props.onEscape?.() },
        }, this.props.escapeLabel ?? '回到列表')))
  }
}
