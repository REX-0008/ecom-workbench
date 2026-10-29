/** `@deepseek-ai/cordis` 的最小声明（2026-10-24 契约 AK 补 `layout` / `slots`）。
 *
 * ## 为什么不装真的包
 *
 * `@deepseek-ai/cordis` 是 dsh 宿主的包，本仓库的 `node_modules` 里**没有**
 * （它是运行时由宿主注入的）。装不到真的，所以只能声明我们**用到的那几个成员**。
 *
 * ## 与 `types-react-shim.d.ts` 里那条纪律的关系
 *
 * 那边说「别写假声明」，指的是**已经有真类型的东西**（react / @xyflow/react /
 * elkjs 都有真类型，盖掉它们只会让检查失效）。这里是另一种情况：
 * 包根本不在本机，**不声明就整片报错**，声明它是唯一能做的。
 *
 * ## 只声明用到的成员，不猜其余的
 *
 * 下面这几个成员都是从 `src/client/index.ts` 的实际调用抄下来的，
 * 签名按调用方式写。**没有猜测大而全的 Context 接口** ——
 * 那样的声明会让人以为「这里有类型检查」，实际只是恰好覆盖了我们用到的那几处。
 */
declare module '@deepseek-ai/cordis' {
  /** 一个插槽注册项（只写我们传过的字段）。 */
  export interface SlotEntry {
    name: string
    id: string
    order?: number
    label?: () => string
  }

  /** `ctx.slots`：dsh 的插槽服务（UI 组件只经它注册）。 */
  export interface SlotsService {
    /** 往某个孔位挂一个工厂，返回反注册函数。 */
    inject: (name: string, factory: () => () => void) => () => void
    /** 注册一个条目，返回反注册函数。 */
    register: (entry: SlotEntry, component: (props?: { wide?: boolean }) => unknown) => () => void
  }

  /** `ctx.layout`：dsh 的布局服务。`toggleSidebar` 只有切换，没有「设成收起」。 */
  export interface LayoutService {
    toggleSidebar: () => void
    /** 下面两个我们没用到，但 dsh 那边有；不声明会让「没有这个方法」的错觉扩大。
     *  需要时再加 —— 不猜。 */
  }

  /** cordis 上下文（只声明本项目用到的那几样）。 */
  export interface Context {
    inject: (names: string[], fn: (ctx: Context) => void) => void
    effect: (fn: () => () => void, name?: string) => void
    slots: SlotsService
    layout: LayoutService
  }
}
