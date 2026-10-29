/** 画布右键菜单（三种上下文共用）。
 *
 * ## 为什么自己做，不引库
 *
 * 候选都过了一遍（照 `ponytail` 的梯子，先看已装的东西能不能解决）：
 *   - `react-contexify` / `@radix-ui/react-context-menu`：都是新依赖；
 *     且 radix 新版要 React 19，而 dsh 客户端是 18（调研已记这条坑）。
 *   - **React Flow 本身就提供了上下文菜单的事件与坐标**
 *     （`onNodeContextMenu` / `onPaneContextMenu` / `onEdgeContextMenu`）。
 *
 * 所以缺的只是一个渲染层，约百行。**引库反而更重。**
 *
 * ## 三种上下文（「右键点在哪」决定菜单内容）
 *
 * 这是右键菜单的价值所在：菜单项**跟着你点的东西变**，而不是一个万能长菜单。
 *
 *   | 点在哪 | 菜单 |
 *   | --- | --- |
 *   | 节点上 | 跑这个 / 从这里跑 / 跑下一步 / 跳过 / 复制 / 删除 |
 *   | 选中多个时 | 打包成分组 / 批量跳过 / 复制 / 删除 |
 *   | 空白处 | 粘贴 / 自动布局 / 缩放适配 / 全选 / 收起所有设置 / 锁定 |
 *   | 分组框上 | 解散分组 / 删除 |
 *
 * ## 关闭时机（四条都要，漏一条就会「关不掉」）
 *
 *   1. 点任意菜单项；
 *   2. 点菜单外任何地方 —— 用 `pointerdown` **捕获阶段**监听，
 *      否则画布自己的 handler 会先把事件吃掉；
 *   3. 按 Esc（与画布已有的 Esc 处理合并，不另加监听）；
 *   4. 画布平移 / 缩放 / 窗口尺寸变化。
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import css from './context-menu.module.css'

/** 一个菜单项。 */
export interface MenuItem {
  /** 唯一 id（React key）。 */
  id: string
  /**
   * 显示的图标。
   *
   * ## 2026-10-26 从 `string` 放宽成 `ReactNode`（用户要求图标统一）
   *
   * 原来这里是**单字符**（`⤢` `▣` `🗑` …）。用户要求把画布那层的字符图标换成
   * `icons.tsx` 里的真 SVG（那批是照 lucide path 内联的，零依赖），
   * 所以这个字段必须能收一个元素。
   *
   * ⚠️ 放宽成 `ReactNode` 而不是收紧成 `React.JSX.Element`：字符也是一种 `ReactNode`，
   * 这样**没换完的地方仍然能编译**，不会因为一次大改把别处卡住。
   * 全换完之后想收紧是后续清理，不是这次的事。
   */
  icon: ReactNode
  /** 显示的文字。 */
  label: string
  /** 右侧的快捷键提示（可选）。 */
  key?: string
  /** 点了做什么。 */
  run: () => void
  /** 是否禁用（画布锁定时会改动画布的项都禁用）。 */
  disabled?: boolean
  /** 是不是危险操作（删除这类）——会用语义红。 */
  danger?: boolean
}

/** 菜单内容：一串菜单项，`null` 表示分段线。 */
export type MenuEntries = (MenuItem | null)[]

/** 菜单状态：位置 + 内容 + 标题。 */
export interface MenuState {
  /** 屏幕坐标（clientX / clientY）。 */
  x: number
  /** 屏幕坐标。 */
  y: number
  /** 顶部标题（说清「这是对谁的操作」）。 */
  title: string
  /** 菜单项。 */
  entries: MenuEntries
}

/**
 * 右键菜单本体。
 *
 * @param props.menu - 菜单状态；`null` 表示不显示。
 * @param props.onClose - 关闭回调。
 * @returns 菜单元素，或 null。
 */
export function ContextMenu(props: { menu: MenuState | null, onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  /** 翻转后的位置（渲染后量过尺寸才知道要不要翻）。 */
  const [pos, setPos] = useState<{ x: number, y: number } | null>(null)
  const menu = props.menu

  /**
   * 渲染后量一次尺寸，决定要不要**翻转**到另一侧。
   *
   * 为什么必须量：`position: fixed` 的菜单在靠近窗口右下角时会**被截掉**，
   * 用户看不到（也点不到）最后几项。这是 fixed 定位的固有代价。
   * 用 `useLayoutEffect`（不是 `useEffect`）——它在浏览器绘制前跑，
   * 所以用户**看不到菜单先闪到错误位置再跳回来**。
   */
  useLayoutEffect(() => {
    if (menu === null) { setPos(null); return }
    const el = ref.current
    if (el === null) return
    const r = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    /* 留 6px 边距，别贴着窗口边缘。 */
    const x = menu.x + r.width > vw - 6 ? Math.max(6, menu.x - r.width) : menu.x
    const y = menu.y + r.height > vh - 6 ? Math.max(6, menu.y - r.height) : menu.y
    setPos({ x, y })
  }, [menu])

  /**
   * 点菜单外任何地方 → 关。
   *
   * ⚠️ 用**捕获阶段**（第三个参数 true）：画布自己也有 pointerdown 处理
   * （拖动、框选），冒泡阶段才监听得的话，画布可能已经先处理掉了。
   */
  useEffect(() => {
    if (menu === null) return
    const onDown = (e: PointerEvent): void => {
      const el = ref.current
      if (el !== null && e.target instanceof Node && el.contains(e.target)) return
      props.onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => { document.removeEventListener('pointerdown', onDown, true) }
  }, [menu, props])

  if (menu === null) return null

  /** 点一项：先执行、再关闭（顺序反了会在关闭时丢掉点击目标）。 */
  const onClick = (item: MenuItem): void => {
    if (item.disabled === true) return
    props.onClose()
    item.run()
  }

  return (
    <div
      ref={ref}
      className={css.menu}
      data-ewb-menu=''
      role="menu"
      /* 位置：量完之前先按原始坐标放（看不见闪，因为 useLayoutEffect 在绘制前跑）。 */
      style={{ left: (pos?.x ?? menu.x), top: (pos?.y ?? menu.y) } as CSSProperties}
      /* 别让点击穿透到画布（否则点菜单会同时拖动画布）。 */
      onPointerDown={e => { e.stopPropagation() }}
      onContextMenu={e => { e.preventDefault() }}
    >
      <div className={css.head}>{menu.title}</div>
      {menu.entries.map((it, i) => it === null
        ? <div key={'sep' + String(i)} className={css.sep} />
        : (
          <button
            key={it.id}
            type="button"
            role="menuitem"
            className={css.item + (it.danger === true ? ' ' + css.danger : '')}
            disabled={it.disabled === true}
            onClick={() => { onClick(it) }}
          >
            <span className={css.itemIcon}>{it.icon}</span>
            <span className={css.itemText}>{it.label}</span>
            {it.key !== undefined && <span className={css.itemKey}>{it.key}</span>}
          </button>
        ))}
    </div>
  )
}
