/** 电商工作台 · 侧栏入口（2026-10-13 定：**只在底部**）。
 *
 * ## 历史：这里踩过两次
 *
 * ### 第一次：在顶部孔位里画了一个整行按钮（违规，造成遮挡）
 *
 * 原来我们在 `sidebar.panellist` 里渲染**一整个铺满整行的按钮**，
 * 再用 CSS（`position:absolute; inset:0; z-index:3`）盖住官方那一行、
 * 用 `stopPropagation` 拦掉官方点击、用 `visibility:hidden` 藏掉官方文字。
 *
 * **那与官方契约相反。** 官方 `SidebarRoot.tsx` 里 `sidebar.panellist`
 * 渲染在**官方自己的 `<button>` 内部**，官方注释原话：
 * 「Global panel icons. Each list id addresses the matching main panel;
 * **the sidebar owns the button and resolves its label from list metadata.**」
 * 我们又在里面画一个按钮，就必然要覆盖官方的东西 —— 那就是用户报的
 * 「整个左侧栏被左侧按钮遮挡」。
 *
 * ### 第二次：改成「只放图标」—— 但仍然不对（用户否掉了）
 *
 * 那个孔位的语义其实是「**一个指向同名中央面板（`main`）的指针**」：
 * 点图标 = 官方执行 `ctx.layout.selectPanel(图标 id)` = 切到中间那块。
 * 而官方在 `ui-layout/service.ts:73` 里**没有同名 `main` 面板就抛错**
 * （「layout.selectPanel: main panel "..." is not registered」）。
 *
 * 我们要的是**叠加在右侧、对话保留**，不是「切走中间那块」——
 * 与那个语义不一致。**用户决定不要它**（原话：
 * 「去掉顶部的，保留底部的两个按钮」）。
 *
 * ## 现在的做法：**只在侧栏底部**（`sidebar.footer.action`）
 *
 * 这个孔位官方渲染在 `<div className={css.footerActions}>` 里
 * （`SidebarRoot.tsx:308`），**不是包在官方按钮里** —— 所以这里**可以**
 * 放我们自己的按钮，孔位注释也写明它是「Optional actions beside Settings
 * at the sidebar foot」。
 *
 * ⚠️ 好处：**完全不依赖官方私有类名、不覆盖任何官方元素**。
 * 原来那套用 `[class*="panelRow"]` 匹配构建器生成的哈希类名，
 * 官方一改就**静默失效**（样式不生效、不报错）。
 */
import { useEffect, useState } from 'react'
/* 工作台品牌标识（用户提供的图形）。 */
import { BrandMark } from './brand-mark.tsx'

/** 工作台开关状态读写器（由 index.ts 注入，避免循环依赖）。 */
export interface ToggleHooks {
  /** 读取当前开关状态。 */
  get: () => boolean
  /** 切换开关。 */
  set: (on: boolean) => void
}

/** 开关状态的订阅 hook（模块级状态 → React 状态）。 */
function useToggleState(get: () => boolean): boolean {
  const [on, setOn] = useState(get)
  useEffect(() => {
    const sync = (): void => { setOn(get()) }
    window.addEventListener('ewb-mode-change', sync)
    return () => { window.removeEventListener('ewb-mode-change', sync) }
  }, [get])
  return on
}

/**
 * 侧栏底部的**开关按钮**（注册进 `sidebar.footer.action`）。
 *
 * ## 为什么这个孔位可以放按钮
 *
 * 官方渲染它时**没有**套自己的按钮（`SidebarRoot.tsx:308` 是一个
 * `<div className={css.footerActions}>`），孔位注释也写明它是
 * 「Optional actions beside Settings at the sidebar foot」——
 * 就是给「一个动作」用的。所以这里放我们自己的 `<button>` 是**符合契约**的。
 *
 * 官方喂的属性是 `wide`（侧栏是宽态还是 56px 收起态）。
 * ⚠️ **不像 `panellist` 那样有两态尺寸要求**：`wide` 为假时只留图标，
 * 为真时图标 + 文字 —— 与官方设置键同一套表现。
 *
 * @param props.hooks - 开关读写器。
 * @param props.wide - 侧栏是否宽态（官方给）。
 * @returns 我们自己的开关按钮。
 */
export function FooterToggle({ hooks, wide = true }: {
  hooks: ToggleHooks
  wide?: boolean
}): React.JSX.Element {
  const on = useToggleState(hooks.get)
  const label = on ? '关闭电商工作台' : '打开电商工作台'
  return (
    <button
      type="button"
      data-ewb-footer-toggle=""
      data-on={on ? 'on' : undefined}
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={() => { hooks.set(!hooks.get()) }}
    >
      <BrandMark size={16} />
      {/* 收起态（56px rail）只留图标 —— 与官方设置键同理。 */}
      {wide && <span data-ewb-footer-label="">电商工作台</span>}
    </button>
  )
}
