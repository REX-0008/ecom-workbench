/** 分组框（把一组节点框在一起，可命名、可改大小）。
 *
 * ## 2026-10-26 契约 CE：组变成**真节点**（用户 m01076）
 *
 * 用户原话：「按照参考的编组模式和功能改我们的，我觉得用他们的好点，执行工作流也这么改。」
 *
 * 上一版（2026-10-13 ~ 10-25）是「名单模型」：组只是**一串节点 id**，
 * 框每次渲染按成员包围盒算出来、**不进 `nodes`**。那时这个组件是那个「派生假节点」的画法。
 *
 * 现在照参考项目（`refs-projects/infinite-canvas/web/src/components/canvas/canvas-node.tsx`
 * 的 `GroupNodeContent`）改成真节点：
 *
 * | 行为 | 现在 |
 * |---|---|
 * | 是否在 `nodes` 里 | 在（有 `position` / `width` / `height`） |
 * | 成员怎么认 | 成员的 `data.groupId` 指向本组（**不是** `parentId`） |
 * | 拖动 | React Flow 直接拖，框自己的坐标就是真坐标 |
 * | 改大小 | 四角手柄（下方 `Corner`），改完通知画布同步成员归属 |
 * | 收起 | 保留（框压成一条，成员照旧显示 —— 与循环框的收起语义不同，见下） |
 *
 * ## ⚠️ 成员坐标仍是**绝对坐标**，组**不是**父容器
 *
 * 循环框用的是 `parentId` 父子容器（调度器按它认循环体），组用 `groupId` 归属标记。
 * 两套**不许混** —— 混用的后果是「组一动成员全飞」（旧模型踩过三次）。
 *
 * ## 为什么收起**不藏成员**
 *
 * 循环框收起会藏掉成员（那是执行容器，收起＝先不看这一块）。
 * 组只是画在成员底下的一块框，收起成一条标题栏的意义是「别挡着我看内容」，
 * 不是「把内容藏起来」。所以这里只压高度，不动别的节点。
 */
import { useRef, memo } from 'react'
import css from './node-card.module.css'
import { useStore, type NodeProps, type Node } from '@xyflow/react'

/** 分组框的 data 形状。 */
export interface GroupNodeData extends Record<string, unknown> {
  /** 标题文字。 */
  groupLabel?: string
  /** 描述（讲这组是干什么的，照 n8n 的 Canvas Group description）。 */
  note?: string
  /** 是否收起成一条（收起只是不显示框体，不影响运行、不藏成员）。 */
  collapsed?: boolean
  /** 改名回调。 */
  onRename?: (v: string) => void
  /** 改描述。 */
  onNote?: (v: string) => void
  /** 收起 / 展开。 */
  onToggleCollapse?: () => void
  /**
   * 改大小（四角手柄拖完调一次）。
   *
   * ⚠️ 尺寸**不是**写在这里的 data 上，而是节点自己的 `width` / `height`
   * （React Flow 的节点字段，会随存档往返）。data 里只放回调。
   */
  onResize?: (w: number, h: number) => void
}

/** 画布上的分组框节点类型。 */
export type GroupNode = Node<GroupNodeData, 'group'>

/** 框的最小宽度（再小就抓不住手柄、标题也放不下）。 */
const MIN_GROUP_W = 240
/** 最小高度（标题条本身要 46px）。 */
const MIN_GROUP_H = 96

/** 当前画布缩放（四角拖动要按缩放折算像素位移，否则放大后拖 1px 会缩 3px）。 */
function useZoom(): number {
  return useStore(s => s.transform[2])
}

/**
 * 一个角上的改大小手柄。
 *
 * 照参考项目 `canvas-node.tsx:467-470` 的四个 `ResizeHandle` 的位置与行为：
 * 拖角 → 改宽高。
 *
 * 为什么不用 `@xyflow/react` 的 `NodeResizer`：那个组件把尺寸写进它自己的
 * 内部状态并直接改节点的 `style`，我们这边尺寸要**存进节点字段**（否则存不进存档），
 * 而且改完还要**同步成员归属** —— 一件自己写 pointer 事件就能说清的事。
 *
 * @param props - 角位置、当前尺寸、缩放、改大小回调。
 * @returns 手柄元素。
 */
function Corner({ corner, size, zoom, onResize }: {
  corner: 'tl' | 'tr' | 'bl' | 'br'
  size: { width: number, height: number }
  zoom: number
  onResize: (w: number, h: number) => void
}): React.JSX.Element {
  const startRef = useRef<{ x: number, y: number, w: number, h: number } | null>(null)
  /* ⚠️ **不加 CSS 类**（只给 `nodrag` 防拖动）：`node-card.module.css` 不在本单
   * 可改路径里，手柄的观感全在下面那段 inline style 里，不依赖样式表。 */
  return (
    <span
      className="nodrag"
      data-ewb-group-resize={corner}
      style={{
        position: 'absolute',
        width: 10,
        height: 10,
        borderRadius: 2,
        border: '1px solid var(--c-accent)',
        background: 'var(--c-surface, #fff)',
        opacity: 0.75,
        cursor: corner === 'tl' || corner === 'br' ? 'nwse-resize' : 'nesw-resize',
        ...(corner === 'tl' ? { left: -5, top: -5 }
          : corner === 'tr' ? { right: -5, top: -5 }
            : corner === 'bl' ? { left: -5, bottom: -5 }
              : { right: -5, bottom: -5 }),
      }}
      onPointerDown={(e) => {
        e.stopPropagation()
        e.preventDefault()
        startRef.current = { x: e.clientX, y: e.clientY, w: size.width, h: size.height }
        const z = zoom > 0 ? zoom : 1
        /**
         * 拖动中：按角的方向折算宽高。
         * @param ev - 指针事件。
         */
        const move = (ev: PointerEvent): void => {
          const s = startRef.current
          if (s === null) return
          const dx = (ev.clientX - s.x) / z
          const dy = (ev.clientY - s.y) / z
          const w = corner === 'tl' || corner === 'bl' ? s.w - dx : s.w + dx
          const h = corner === 'tl' || corner === 'tr' ? s.h - dy : s.h + dy
          onResize(Math.max(MIN_GROUP_W, w), Math.max(MIN_GROUP_H, h))
        }
        /**
         * 松手：摘监听。
         */
        const up = (): void => {
          startRef.current = null
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
      }}
    />
  )
}

/**
 * 分组框。
 * @param props - React Flow 注入的节点属性。
 * @returns 分组框元素。
 */
export const GroupNodeCard = memo(function GroupNodeCard({ id, data, selected, width, height }: NodeProps<GroupNode>) {
  const collapsed = data.collapsed === true
  const zoom = useZoom()
  const size = { width: width ?? 760, height: height ?? 480 }
  return (
    <div
      className={css.groupBox + (selected === true ? ' ' + css.groupSelected : '') + (collapsed ? ' ' + css.groupCollapsed : '')}
      data-group-id={id}
      data-ewb-group-node={id}
      style={{ position: 'relative', width: size.width, height: size.height }}
    >
      <div className={css.groupHead}>
        <input
          className={css.groupTitleInput + ' nodrag'}
          value={data.groupLabel ?? ''}
          placeholder="分组"
          title="给这组起个名字（只影响显示）"
          onChange={e => { data.onRename?.(e.target.value) }}
          onClick={e => { e.stopPropagation() }}
        />
        {/* 收起按钮（用户 2026-10-12 要求，照 n8n 的 Canvas Groups）。
         * 收起后框压成一条标题栏，**成员照旧显示** —— 组是画在成员底下的框，
         * 不是容器（见文件头）。 */}
        <button
          type="button"
          className={css.groupBtn + ' nodrag'}
          title="收起 / 展开这个框（只是不显示框体，里面的节点不受影响）"
          onClick={e => { e.stopPropagation(); data.onToggleCollapse?.() }}
        >{collapsed ? '\u25be' : '\u25b4'}</button>
      </div>
      {/* 描述：收起时也能看到（讲这组是干什么的）。
       * 用户 2026-10-12：「llm 写的，看的时候不知道什么意思」——
       * 一组节点更需要一句话说明它的用途。 */}
      {!collapsed && (
        <input
          className={css.groupDescInput + ' nodrag'}
          value={data.note ?? ''}
          placeholder="这组是干什么的…"
          title="这一组的说明（展开时显示在名字下面）"
          onChange={e => { data.onNote?.(e.target.value) }}
          onClick={e => { e.stopPropagation() }}
        />
      )}
      {collapsed && data.note !== undefined && data.note !== '' && (
        <div className={css.groupDescReadonly}>{data.note}</div>
      )}
      {/* 四角改大小（照参考项目 `canvas-node.tsx:467-470`）。收起态不显示 ——
       * 压成一条时改高度没有意义，只会让用户抓不住框。 */}
      {!collapsed && (
        <Corner corner="tl" size={size} zoom={zoom} onResize={(w, h) => { data.onResize?.(w, h) }} />
      )}
      {!collapsed && (
        <Corner corner="tr" size={size} zoom={zoom} onResize={(w, h) => { data.onResize?.(w, h) }} />
      )}
      {!collapsed && (
        <Corner corner="bl" size={size} zoom={zoom} onResize={(w, h) => { data.onResize?.(w, h) }} />
      )}
      {!collapsed && (
        <Corner corner="br" size={size} zoom={zoom} onResize={(w, h) => { data.onResize?.(w, h) }} />
      )}
    </div>
  )
})
