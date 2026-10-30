/** 五种内容节点的**画法 + 节点上的交互**（内容画布用）。
 *
 * ## 观感约定（计划 §三 3.2 / §4.4，2026-10-25 定）
 *
 * 「五个节点空着摆在画布上，**看起来就是五块内容**，不是五张卡片」：
 *   ① **不画标题栏、不画边框、不画背景卡** —— 节点盒子只是内容的边界；
 *   ② **名称只在悬浮时出现**。
 *
 * ## 2026-10-26 契约 CD：交互照参考项目抄，长相不动
 *
 * 用户 m01076 点名要的三件事，做法全部照
 * `refs-projects/infinite-canvas/web/src/components/canvas/canvas-node.tsx`：
 *
 * | 行为 | 参考实现 | 这里的落点 |
 * |---|---|---|
 * | **单击只展开面板、不进编辑** | `canvas-node.tsx:372` 的 `onMouseDown` 只选中；开面板在 `project.tsx:1700-1708` | `onClick` → 上报 `onSelectNode`，不碰焦点 |
 * | **双击文本才进直接编辑** | `canvas-node.tsx:398-420` 的 `onDoubleClick`，`type !== Text` 直接 return | 文本节点双击把 `editing` 置真 |
 * | **四角 resize** | `canvas-node.tsx:467-470` 四个 `ResizeHandle` | 自己一个 `Corner` 组件（见下） |
 * | **悬浮显示连接点** | `canvas-node.tsx:473` | 已有 `.contentHandle` 的 `:hover` 规则 |
 *
 * ⚠️ **不抄它的节点长相**（它 1102 行，把标题、蒙版、批量展开、多选浮层全揉在节点里）。
 * 我们的「一块内容」观感是 2026-10-25 定的，不能因为照抄把它推翻。
 *
 * ## 为什么改内容走 context，而不是塞进 `data`
 *
 * `data` 是**要存进画布文件的形状**（`content-canvas-store.ts` 的 `ContentNodeData`）。
 * 把回调塞进去，保存时就得记着剔掉它 —— 忘一次就把函数写进 JSON。
 */
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import {
  Handle, Position, useStore, getBezierPath,
  type NodeProps, type Node, type EdgeProps,
} from '@xyflow/react'
import type { ContentNodeData } from './content-canvas-store.ts'
import { MIN_NODE_SIZE, nodeLabel, sizeOf, TYPE_LABEL, waitedText, type NodeRunState } from './content-canvas-store.ts'
import type { ContentNode } from './content-canvas-store.ts'
import { NodeHoverToolbar } from './NodeHoverToolbar.tsx'
import css from './EcomWorkbench.module.css'

/** 节点层需要往外报的事（由画布本体提供）。 */
export interface ContentNodeBridge {
  /** 改了文本节点的正文（**这是节点的产出**，不是输入参数）。 */
  onText: (id: string, text: string) => void
  /** 改了节点的数据项（提示词、尺寸、张数…）。 */
  onConfig: (id: string, patch: ContentNodeData) => void
  /** 改了尺寸（四角拖动 / 设置面板）。 */
  onResize: (id: string, width: number, height: number) => void
  /** 改了显示名。 */
  onRename: (id: string, title: string) => void
  /** 删掉一个节点（悬浮工具条上那个）。 */
  onDelete: (id: string) => void
  /** 把节点的提示词复制走。 */
  onCopyPrompt: (id: string) => void
  /** 下载节点的产物。 */
  onDownload: (id: string) => void
  /** 把节点的产物加进素材库。 */
  onSaveAsset: (id: string) => void
  /** 上传替换（打开文件选择）。 */
  onUpload: (id: string) => void
  /** 全屏查看。 */
  onView: (id: string) => void
  /** 点「生成」。 */
  onGenerate: (id: string) => void
  /** 当前是否只显示这一块的面板（面板由画布在节点下方画）。 */
  panelNodeId: string
  /**
   * 画出这个节点的设置面板（票 35：**挂进节点里**，跟着节点动、跟着画布缩）。
   *
   * ## 为什么走 bridge 传函数，而不是在这里直接 import `NodeSettingsPanel`
   *
   * `NodeSettingsPanel.tsx` 反过来要 `import { CONTENT_SIZES } from './content-nodes.tsx'`
   * —— 直接引就是循环依赖。传函数把方向理成一束：画布知道面板是什么，
   * 节点只管「在我下面这块地方把它画出来」。
   *
   * ## 为什么不传节点对象而是传 id
   *
   * 节点这一层拿得到自己的 `id`，但拿不到「存盘形状」的 `ContentNode`
   * （`data` 是 React Flow 的 payload）。让画布按 id 自己查，两边都不用转换。
   *
   * @param id - 节点 id。
   * @returns 面板元素；这个节点没面板时给 null。
   */
  renderPanel: (id: string) => React.ReactNode
  /** 点节点：只选中 + 开面板（**不**进编辑）。 */
  onSelectNode: (id: string) => void
  /** 这个组里现在有几个成员（组的框上要显示 —— 契约 CE）。 */
  groupCount: (id: string) => number
  /** 这个节点现在的运行态（契约 CH；没在跑给 idle）。 */
  runState: (id: string) => NodeRunState
  /** 点「重试」（失败态那个按钮）。 */
  onRetry: (id: string) => void
  /** 点「取消」（生成中那个按钮）。 */
  onCancel: (id: string) => void
  /**
   * 打开图像操作浮层（用户 m02814：#59 裁剪 / #62 拆图 / #65 抓帧）。
   *
   * `kind` 不同时浮层问不同的参数；像素操作由画布那边做（它拿得到元素）。
   */
  onImageOp: (id: string, kind: 'crop' | 'split' | 'frame' | 'mask') => void
  /** 打开局部重绘的蒙版面板（用户 m02814 #60）。 */
  onMask: (id: string) => void
  /** 跑一个图像操作（放大 / 超分 / 反推提示词，用户 m02814 #61 / #63）。 */
  onRunOp: (id: string, op: 'upscale' | 'superResolve') => void
  /** 批量节点展开 / 收起（用户 m02814 #72-74）。 */
  onBatchToggle: (id: string) => void
  /** 把批量节点里第 i 张设为主图。 */
  onBatchMain: (id: string, index: number) => void
  /** 从这一批里移除第 i 张（**产物本身不删**，只从列表里摘掉）。 */
  onBatchRemove: (id: string, index: number) => void
}

/** 空通道（没人提供时用，全部不做任何事）。 */
const EMPTY_BRIDGE: ContentNodeBridge = {
  onText: () => {}, onConfig: () => {}, onResize: () => {}, onRename: () => {},
  onDelete: () => {}, onCopyPrompt: () => {}, onDownload: () => {}, onSaveAsset: () => {},
  onUpload: () => {}, onView: () => {}, onGenerate: () => {}, panelNodeId: '', onSelectNode: () => {},
  renderPanel: () => null,
  groupCount: () => 0,
  runState: () => ({ kind: 'idle' }),
  onRetry: () => {}, onCancel: () => {},
  onImageOp: () => {}, onMask: () => {}, onRunOp: () => {},
  onBatchToggle: () => {}, onBatchMain: () => {}, onBatchRemove: () => {},
}

const Bridge = createContext<ContentNodeBridge>(EMPTY_BRIDGE)

/** 提供通道（画布本体用）。 */
export const ContentNodeBridgeProvider = Bridge.Provider

/**
 * 取通道。
 * @returns 通道。
 */
function useBridge(): ContentNodeBridge {
  return useContext(Bridge)
}

/**
 * 当前缩放到多少（四角拖动要按缩放折算像素位移，否则放大后拖 1px 会缩 3px）。
 * @returns 缩放倍数。
 */
function useZoom(): number {
  return useStore(s => s.transform[2])
}

/** 节点数据（React Flow 要求 `data` 是 `Record<string, unknown>`）。 */
export interface ContentNodePayload extends Record<string, unknown>, ContentNodeData { }

/** 本模块认的节点类型。 */
export type ContentFlowNode = Node<ContentNodePayload>

/**
 * 产物 id → 可显示的地址（宿主半的二进制路由）。
 * @param id - 产物 id。
 * @returns 地址。
 */
export function artifactUrl(id: string): string {
  return '/api/ecom-workbench/artifact/' + encodeURIComponent(id)
}

/**
 * 名称标签：**平时透明**，悬浮 / 选中 / 正在改名时出现；**双击改名**。
 *
 * ## 票 35（2026-10-28）：这个组件原来「既看不见也点不到」
 *
 * 两处缺陷都在 CSS 里（`EcomWorkbench.module.css`），组件本身没写错：
 *   · 看不见 —— 它挂在 `.contentNode` 里，而那哥们 `overflow: hidden`，
 *     `bottom: 100%` 把它放在框**外面**，被整块裁掉；
 *   · 点不到 —— `.contentNodeName` 上有 `pointer-events: none`。
 * 两处都已修（见那段 CSS 的说明）。这里配套改三件：
 *
 * 1. **改双击**（照参考项目 `canvas-node.tsx:372`）。用户以前说过单击改名，
 *    但那时名字在框**外**、单击不冲突的假设是错的：单击要留给「选中节点」
 *    （选中才开设置面板，那是这个画布的主交互）。双击才是两家都不打架的做法。
 * 2. **加 `maxLength 64`**（照参考 `:353`）。不设上限的话名字能有几千字，
 *    而标签是 `max-width` + `ellipsis` —— 存进去就改不回来了。
 * 3. **改名期间也给显形**：以前只有 hover / selected 两档，一进改名态
 *    鼠标移到输入框上、而输入框不在 hover 链上，标题就闪没了。
 *    现在由外层包装加 `contentNodeWrapNameEditing` 修饰类（`editing` 状态驱动）。
 *
 * ⚠️ 组件必须能被外层读到 `editing` —— 所以不在这里包 wrapper，
 * 而是**由调用方**（`Shell` / 配置节点 / 编组）把 `onEditingChange` 接出去。
 * 这一条是刻意的：wrapper 的类名影响整个节点的显隐，只能由节点那一层决定。
 *
 * @param props.id - 节点 id。
 * @param props.title - 当前名字（空 = 用类型名）。
 * @param props.onEditingChange - 改名态变了（外层据此加修饰类）。
 * @returns 标签或输入框。
 */
function NodeName({ id, title, onEditingChange }: {
  id: string
  title: string
  /** 改名态变化时通知外层（外层用它控制标题的显隐）。 */
  onEditingChange?: (editing: boolean) => void
}): React.JSX.Element {
  const bridge = useBridge()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const boxRef = useRef<HTMLInputElement | null>(null)

  /* 进入改名态就聚焦并全选 —— 不然用户得再点一次才打得进去。 */
  useEffect(() => {
    if (!editing) return
    const el = boxRef.current
    if (el === null) return
    el.focus()
    el.select()
  }, [editing])

  /**
   * 进出改名态（**顺带通知外层**）。
   *
   * 为什么收成一个函数：原来三处 `setEditing(false)` 各写一遍，
   * 加了通知之后漏一处就是「标题在改名时闪没」——那种 bug 只有真机看得见。
   * @param next - 要进还是出。
   */
  const setEditingBoth = (next: boolean): void => {
    setEditing(next)
    if (onEditingChange !== undefined) onEditingChange(next)
  }

  if (editing) {
    return (
      <input
        ref={boxRef}
        className={css.contentNodeNameInput + ' nodrag nowheel'}
        data-ewb-node-rename={id}
        value={draft}
        /* ★ 64 是照参考项目取的（`canvas-node.tsx:353`）。 */
        maxLength={64}
        onChange={e => { setDraft(e.target.value) }}
        onBlur={() => { bridge.onRename(id, draft); setEditingBoth(false) }}
        onKeyDown={(e) => {
          /* stopPropagation：不然画布的快捷键会先吃掉 Esc / Delete。 */
          e.stopPropagation()
          if (e.key === 'Enter') { bridge.onRename(id, draft); setEditingBoth(false) }
          if (e.key === 'Escape') { setDraft(title); setEditingBoth(false) }
        }}
      />
    )
  }
  return (
    <button
      type="button"
      className={css.contentNodeName}
      data-ewb-content-name=""
      title="双击改名"
      /* ★ **双击**改名（票 35 照参考项目改）。
       *
       * 单击留给「选中节点 + 开设置面板」—— 那是这个画布的主交互。
       * 两件事都挂在同一个元素上的话，用户点一下想改名字，结果先弹了面板。
       *
       * ⚠️ `stopPropagation` 不能去 —— 否则双击会同时触发画布的选中（两次单击）。 */
      onDoubleClick={(e) => {
        e.stopPropagation()
        setDraft(title)
        setEditingBoth(true)
      }}
      /* 单击也要挡住：不挡的话「双击的第一下」会先把节点选中、弹出面板，
       * 第二下才进改名 —— 用户看到的是面板闪一下。 */
      onClick={(e) => { e.stopPropagation() }}
    >{title}</button>
  )
}

/**
 * 一个角的拖动手柄（照参考项目 `canvas-node.tsx:467-470` 的 `ResizeHandle`）。
 *
 * ## 为什么用 `pointerdown` + window 监听，而不是 pointermove 事件绑在手上
 *
 * 鼠标一移出手柄，绑定在它身上的 move 就收不到了 —— 拖到一半断掉。
 * 参考项目也是这个做法（`handleResizeMouseDown` 里加 window 监听）。
 *
 * ## 缩放要折算
 *
 * 画布放大 2 倍时，鼠标移 10px 对应画布坐标 5px。不折算的话
 * 「拖了一点，节点缩一大截」。
 *
 * @param props.corner - 哪个角。
 * @param props.id - 节点 id。
 * @param props.size - 当前宽高。
 * @returns 手柄。
 */
function Corner({ corner, id, size }: {
  corner: 'tl' | 'tr' | 'bl' | 'br'
  id: string
  size: { width: number, height: number }
}): React.JSX.Element {
  const bridge = useBridge()
  const zoom = useZoom()
  const startRef = useRef<{ x: number, y: number, w: number, h: number } | null>(null)

  return (
    <span
      className={css.contentResize + ' ' + css['contentResize_' + corner]}
      data-ewb-node-resize={corner}
      onPointerDown={(e) => {
        e.stopPropagation()
        e.preventDefault()
        startRef.current = { x: e.clientX, y: e.clientY, w: size.width, h: size.height }
        const z = zoom > 0 ? zoom : 1
        /**
         * 拖动中。
         * @param ev - 指针事件。
         */
        const move = (ev: PointerEvent): void => {
          const s = startRef.current
          if (s === null) return
          const dx = (ev.clientX - s.x) / z
          const dy = (ev.clientY - s.y) / z
          let w = s.w
          let h = s.h
          if (corner === 'tl' || corner === 'bl') w = s.w - dx
          else w = s.w + dx
          if (corner === 'tl' || corner === 'tr') h = s.h - dy
          else h = s.h + dy
          bridge.onResize(id, Math.max(MIN_NODE_SIZE, w), Math.max(MIN_NODE_SIZE, h))
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
 * 左右两个连接点（平时透明，悬浮 / 选中时显形 —— 照 `canvas-node.tsx:473`）。
 * @returns 两个 Handle。
 */
function Ports(): React.JSX.Element {
  return (
    <>
      <Handle type="target" position={Position.Left} className={css.contentHandle} />
      <Handle type="source" position={Position.Right} className={css.contentHandle} />
    </>
  )
}

/**
 * 节点的三个运行态覆盖层（契约 CH，照参考项目 `canvas-node.tsx:491-495`）。
 *
 * ## 三态各显示什么
 *
 * | 态 | 显示 | 为什么 |
 * |---|---|---|
 * | `idle` | 什么都不加 | 没在跑、没出错，节点就该是它本来的样子 |
 * | `running` | 转圈 + 「已等 N 秒」 | **不给百分比**（用户 m01114 定过，参考项目也没有）—— 后台跑多久是黑盒 |
 * | `failed` | 错误原文 + 重试 | 只说「失败」用户不知道该改什么；原文是唯一能查的东西 |
 *
 * ## 为什么这一层盖在节点上，而不是替换节点内容
 *
 * 生成中的节点里**已经有内容**（重跑时）—— 把内容换掉会让用户以为图丢了。
 * 所以是一层半透明覆盖：底下还能看见原来那张，上面写着正在干什么。
 *
 * @param props.id - 节点 id。
 * @param props.run - 运行态。
 * @param props.onRetry - 点重试。
 * @param props.onCancel - 点取消（只有 running 时有）。
 * @returns 覆盖层；`idle` 时是 null。
 */
function RunOverlay({ id, run, onRetry, onCancel }: {
  id: string
  run: NodeRunState
  onRetry: () => void
  onCancel: () => void
}): React.JSX.Element | null {
  if (run.kind === 'idle') return null
  if (run.kind === 'running') {
    return (
      <div className={css.contentRunOverlay} data-ewb-node-running={id} data-ewb-run-state="running">
        <span className={css.contentRunSpinner} />
        {/* ⚠️ 「已等 N 秒」由**后端**的 `waitedMs` 算（`waitedText`），
         * 前端不计时 —— 自己算会和记录里的口径漂。 */}
        <span className={css.contentRunText} data-ewb-node-waited="">{waitedText(run.waitedMs)}</span>
        <button
          type="button"
          className={css.contentRunBtn + ' nodrag'}
          data-ewb-node-cancel={id}
          onClick={(e) => { e.stopPropagation(); onCancel() }}
        >取消</button>
      </div>
    )
  }
  return (
    <div className={css.contentRunOverlay + ' ' + css.contentRunFailed} data-ewb-node-failed={id} data-ewb-run-state="failed">
      <div className={css.contentRunErr} data-ewb-node-error="">{run.error}</div>
      <button
        type="button"
        className={css.contentRunBtn + ' nodrag'}
        data-ewb-node-retry={id}
        onClick={(e) => { e.stopPropagation(); onRetry() }}
      >重试</button>
    </div>
  )
}

/** 节点外壳要的公共入参。 */
interface ShellProps {
  id: string
  type: string
  title: string
  width: number
  height: number
  hasArtifact: boolean
  hasPrompt: boolean
  children: React.ReactNode
  /** 点节点本身的处理（默认 = 只选中 + 开面板）。 */
  onClick?: () => void
}

/**
 * 所有内容节点共用的外壳：选中 / 开面板 / 四角 resize / 名称 / 悬浮工具条 / 运行态。
 *
 * @param props - 见 `ShellProps`。
 * @returns 外壳。
 */
function Shell({ id, type, title, width, height, hasArtifact, hasPrompt, children, onClick }: ShellProps): React.JSX.Element {
  const bridge = useBridge()
  const run = bridge.runState(id)
  /** 标题正在改名（票 35）：改名期间标题要显形，而显隐的类名在外层包装上。 */
  const [renaming, setRenaming] = useState(false)
  return (
    /* ★ 外层包装：**不裁剪**，负责标题 / 悬浮工具条 / 四角手柄这些挂在框外的东西。
     * 内层 `.contentNode` 才 `overflow: hidden`，管图片圆角。
     * 分两层是票 35 照参考项目（`canvas-node.tsx:346-384`）改的 —— 理由见那段 CSS。 */
    <div
      className={css.contentNodeWrap + (renaming ? ' ' + css.contentNodeWrapNameEditing : '')}
      data-ewb-content-wrap={type}
    >
      <div
        className={css.contentNode}
        data-ewb-content-node={type}
        data-node-id={id}
        onClick={(e) => {
          /* 单击：**只选中 + 开面板**，绝不进编辑（用户 m01076 点名）。
           * 这里不调 focus()，所以 textarea 拿不到焦点 —— 验收 6 就判这一点。 */
          e.stopPropagation()
          if (onClick !== undefined) onClick()
          else bridge.onSelectNode(id)
        }}
      >
        {children}
        <RunOverlay
          id={id} run={run}
          onRetry={() => { bridge.onRetry(id) }}
          onCancel={() => { bridge.onCancel(id) }}
        />
        <Ports />
      </div>
      {/* 标题挂在**外层**（不裁剪的那一层），所以 `bottom: 100%` 真的看得见。 */}
      <NodeName id={id} title={title} onEditingChange={setRenaming} />
      <NodeHoverToolbar
        id={id} type={type} hasArtifact={hasArtifact} hasPrompt={hasPrompt}
        onDownload={() => { bridge.onDownload(id) }}
        onSaveAsset={() => { bridge.onSaveAsset(id) }}
        onCopyPrompt={() => { bridge.onCopyPrompt(id) }}
        onView={() => { bridge.onView(id) }}
        onUpload={() => { bridge.onUpload(id) }}
        onDelete={() => { bridge.onDelete(id) }}
        /* ★ 视频 → 抓帧；图片 → 裁剪。
         * 局部重绘另有入口（见下面的 `onMask`），因为它的交互是「涂」而不是「填参数」。 */
        onImageOp={() => { bridge.onImageOp(id, type === 'video' ? 'frame' : 'crop') }}
        onMask={() => { bridge.onMask(id) }}
        onRunOp={(op) => { bridge.onRunOp(id, op) }}
      />
      <Corner corner="tl" id={id} size={{ width, height }} />
      <Corner corner="tr" id={id} size={{ width, height }} />
      <Corner corner="bl" id={id} size={{ width, height }} />
      <Corner corner="br" id={id} size={{ width, height }} />
      {/* ★ 设置面板挂在**节点里面**（票 35，照参考项目 `canvas-node.tsx:483`
       * 的 `absolute left-1/2 top-full -translate-x-1/2`）。
       *
       * ## 为什么现在才敢这么做
       *
       * 原来（`ContentCanvas.tsx` 那段注释）的理由是「节点有 `overflow: hidden`，
       * 塞进去会被裁掉」。票 35 把外壳拆成两层之后（`.contentNodeWrap` 不裁剪），
       * 这个理由不成立了 —— 面板挂在包装层里，天然跟着节点移动、跟着画布缩放。
       *
       * ## 代价（如实记）
       *
       * 面板现在会跟着画布一起缩：放大 2 倍时面板也大一倍。参考项目也是这样
       * （它是节点的子元素），所以这不是退化，是「与参考一致」的必然结果。
       *
       * ⚠️ 面板的**字段与顺序**一个都没动 —— 它仍然是 `renderPanel(id)` 画出来的那一个。 */}
      {bridge.panelNodeId === id ? bridge.renderPanel(id) : null}
    </div>
  )
}

/**
 * 文本节点：**一块文字**。
 *
 * ## 单击不编辑、双击才编辑（用户 m01076 点名）
 *
 * 平时渲染成 `<div>`（不可编辑、点它只开面板）；双击之后才换成 `<textarea>`
 * 并聚焦。这样「单击进编辑」这个毛病从结构上就不存在 —— 不是靠 `blur` 兜。
 *
 * ## 编辑文本 = 直接改输出
 *
 * 写进 `data.text`，那是这个节点的**产出**；提示词在 `data.prompt`（设置面板里填）。
 * 两者混了的话，用户改一次输出就会把要发给模型的提示词也改掉。
 *
 * @param props - React Flow 给的节点入参。
 * @returns 节点。
 */
export function TextContentNode({ id, data, width, height }: NodeProps<ContentFlowNode>): React.JSX.Element {
  const bridge = useBridge()
  const [editing, setEditing] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const size = sizeOf({ id, type: 'text', position: { x: 0, y: 0 }, width: width ?? undefined, height: height ?? undefined, data } as ContentNode)

  /* 进入编辑态就聚焦 —— 「双击才进编辑」的另一半：进了就该能直接打字。 */
  useEffect(() => {
    if (!editing) return
    const el = areaRef.current
    if (el === null) return
    el.focus()
    const n = el.value.length
    el.setSelectionRange(n, n)
  }, [editing])

  /** 退出编辑（存一次）。 */
  const finish = (): void => { setEditing(false) }

  return (
    <Shell
      id={id}
      type="text"
      title={nodeLabel({ id, type: 'text', position: { x: 0, y: 0 }, data, title: typeof data.title === 'string' ? data.title : undefined } as ContentNode)}
      width={size.width}
      height={size.height}
      hasArtifact={false}
      hasPrompt={(data.prompt ?? '').trim() !== ''}
    >
      {editing
        ? (
          <textarea
            ref={areaRef}
            className={css.contentTextArea + ' nodrag nowheel'}
            data-ewb-content-text=""
            data-editing=""
            value={data.text ?? ''}
            onChange={(e) => { bridge.onText(id, e.target.value) }}
            onBlur={finish}
            onKeyDown={(e) => {
              /* Esc 退出编辑；其余键**不冒泡**给画布（否则在框里按 Delete 会删节点）。 */
              e.stopPropagation()
              if (e.key === 'Escape') finish()
            }}
          />
        )
        : (
          <div
            className={css.contentTextView}
            data-ewb-content-textview=""
            onDoubleClick={(e) => { e.stopPropagation(); setEditing(true) }}
          >{(data.text ?? '') === '' ? <span className={css.contentEmptyText}>双击编辑文字</span> : data.text}</div>
        )}
    </Shell>
  )
}

/**
 * 图片节点：**就是那张图，铺满节点**。还没有图时给一个空占位。
 * @param props - React Flow 给的节点入参。
 * @returns 节点。
 */
export function ImageContentNode({ id, data, width, height }: NodeProps<ContentFlowNode>): React.JSX.Element {
  const art = data.artifact ?? ''
  const size = sizeOf({ id, type: 'image', position: { x: 0, y: 0 }, width: width ?? undefined, height: height ?? undefined, data } as ContentNode)
  return (
    <Shell
      id={id} type="image" width={size.width} height={size.height}
      title={nodeLabel({ id, type: 'image', position: { x: 0, y: 0 }, data, title: typeof data.title === 'string' ? data.title : undefined } as ContentNode)}
      hasArtifact={art !== ''} hasPrompt={(data.prompt ?? '').trim() !== ''}
    >
      {art === ''
        ? <div className={css.contentEmpty} data-ewb-content-empty="">还没有图</div>
        : <img className={css.contentMedia} data-ewb-content-img="" src={artifactUrl(art)} alt="" draggable={false} />}
    </Shell>
  )
}

/**
 * 视频节点：视频帧 / 播放器。
 * @param props - React Flow 给的节点入参。
 * @returns 节点。
 */
export function VideoContentNode({ id, data, width, height }: NodeProps<ContentFlowNode>): React.JSX.Element {
  const art = data.artifact ?? ''
  const size = sizeOf({ id, type: 'video', position: { x: 0, y: 0 }, width: width ?? undefined, height: height ?? undefined, data } as ContentNode)
  return (
    <Shell
      id={id} type="video" width={size.width} height={size.height}
      title={nodeLabel({ id, type: 'video', position: { x: 0, y: 0 }, data, title: typeof data.title === 'string' ? data.title : undefined } as ContentNode)}
      hasArtifact={art !== ''} hasPrompt={(data.prompt ?? '').trim() !== ''}
    >
      {art === ''
        ? <div className={css.contentEmpty} data-ewb-content-empty="">还没有视频</div>
        : <video className={css.contentMedia + ' nodrag'} data-ewb-content-video="" src={artifactUrl(art)} controls preload="metadata" />}
    </Shell>
  )
}

/**
 * 批量节点：一次生成多张时落的那个（用户 m02814 #72–74）。
 *
 * ## 为什么合成一个节点、而不是散成 N 个
 *
 * 一次生成 4 张，散成 4 个节点会把链路挤散；而且用户心里它们是**同一批**
 * （同一份提示词、同一个模型、同一次提交）。合成一个节点之后：
 *   · 收起态只占一张图的位置，露出**主图**；
 *   · 展开态摊开每张，各自可「设主图 / 单张下载 / 单张删除」。
 *
 * ## ⚠️ 幽灵图过滤（判据 6）
 *
 * `items` 里存的是产物 id。产物**可能已经被删**（用户清过产物库、
 * 或另一台机器上没有那份文件）。这时如果照 id 画 `<img>`，
 * 界面上会出现一堆**裂图/白框** —— 那就是「幽灵图」。
 *
 * 过滤规则与 `src/schedule/artifact-usage.ts` 定的同一条原则一致：
 * **先按磁盘上真实存在的文件过滤，再显示**。这里拿不到磁盘，
 * 所以由画布在 `toFlow` 之前用 `GET /artifacts` 的清单过滤一次，
 * 组件这层只负责「拿到什么显示什么」。
 *
 * @param props - React Flow 给的节点入参。
 * @returns 节点。
 */
export function BatchContentNode({ id, data, width, height }: NodeProps<ContentFlowNode>): React.JSX.Element {
  const bridge = useBridge()
  const items = Array.isArray(data.items) ? (data.items as unknown[]).filter((x): x is string => typeof x === 'string') : []
  const rawIdx = typeof data.mainIndex === 'number' ? data.mainIndex : 0
  /* 主图下标越界时报 0：产物被删之后 `mainIndex` 可能指到外面去了。 */
  const mainIdx = items.length === 0 ? 0 : Math.max(0, Math.min(items.length - 1, rawIdx))
  const main = items[mainIdx] ?? ''
  const expanded = data.expanded === true
  const size = sizeOf({ id, type: 'batch', position: { x: 0, y: 0 }, width: width ?? undefined, height: height ?? undefined, data } as ContentNode)
  return (
    <Shell
      id={id} type="batch" width={size.width} height={size.height}
      title={nodeLabel({ id, type: 'batch', position: { x: 0, y: 0 }, data, title: typeof data.title === 'string' ? data.title : undefined } as ContentNode)}
      hasArtifact={items.length > 0} hasPrompt={(data.prompt ?? '').trim() !== ''}
    >
      <div className={css.contentBatch} data-ewb-batch={id}>
        <div className={css.contentBatchHead}>
          <span data-ewb-batch-count="">{String(items.length)} 张</span>
          <span className="flex-1" />
          {/* 展开 / 收起。收起态只露主图，展开态摊开全部。 */}
          <button
            type="button"
            data-ewb-batch-toggle=""
            data-expanded={expanded ? '' : undefined}
            className={css.contentHoverBtn + ' nodrag'}
            onPointerDown={e => { e.stopPropagation() }}
            onClick={(e) => { e.stopPropagation(); bridge.onBatchToggle(id) }}
          >{expanded ? '收起' : '展开'}</button>
        </div>
        {items.length === 0
          ? <div className={css.contentEmpty} data-ewb-content-empty="">还没有图</div>
          : expanded
            ? (
              <div className={css.contentBatchGrid} data-ewb-batch-grid="">
                {items.map((art, i) => (
                  <div key={art + ':' + String(i)} className={css.contentBatchCell} data-ewb-batch-item={String(i)}>
                    <img className={css.contentBatchThumb} src={artifactUrl(art)} alt="" draggable={false} />
                    <div className={css.contentBatchOps}>
                      <button
                        type="button"
                        data-ewb-batch-main={String(i)}
                        data-active={i === mainIdx ? '' : undefined}
                        className={css.contentHoverBtn + ' nodrag'}
                        title={i === mainIdx ? '当前主图' : '设为主图'}
                        onPointerDown={e => { e.stopPropagation() }}
                        onClick={(e) => { e.stopPropagation(); bridge.onBatchMain(id, i) }}
                      >{i === mainIdx ? '主图' : '设主图'}</button>
                      <button
                        type="button"
                        data-ewb-batch-del={String(i)}
                        className={css.contentHoverBtn + ' nodrag'}
                        title="从这一批里移除这一张（产物本身不删）"
                        onPointerDown={e => { e.stopPropagation() }}
                        onClick={(e) => { e.stopPropagation(); bridge.onBatchRemove(id, i) }}
                      >移除</button>
                      <a
                        data-ewb-batch-dl={String(i)}
                        className={css.contentHoverBtn + ' nodrag'}
                        title="下载这一张"
                        href={artifactUrl(art)}
                        download=""
                        onPointerDown={e => { e.stopPropagation() }}
                        onClick={(e) => { e.stopPropagation() }}
                      >下载</a>
                    </div>
                  </div>
                ))}
              </div>
            )
            : (
              <img
                className={css.contentMedia} data-ewb-batch-main-img=""
                src={artifactUrl(main)} alt="" draggable={false}
              />
            )}
      </div>
    </Shell>
  )
}

/**
 * 音频节点：播放按钮。
 *
 * ⚠️ **不自己画波形**：真波形要 decode 整段音频再算峰值，那是
 * 「素材库 + 音频编辑」那一层的事。计划 §三 3.2 的写法是「波形**或**播放按钮」，取后者。
 *
 * @param props - React Flow 给的节点入参。
 * @returns 节点。
 */
export function AudioContentNode({ id, data, width, height }: NodeProps<ContentFlowNode>): React.JSX.Element {
  const art = data.artifact ?? ''
  const size = sizeOf({ id, type: 'audio', position: { x: 0, y: 0 }, width: width ?? undefined, height: height ?? undefined, data } as ContentNode)
  return (
    <Shell
      id={id} type="audio" width={size.width} height={size.height}
      title={nodeLabel({ id, type: 'audio', position: { x: 0, y: 0 }, data, title: typeof data.title === 'string' ? data.title : undefined } as ContentNode)}
      hasArtifact={art !== ''} hasPrompt={(data.prompt ?? '').trim() !== ''}
    >
      {art === ''
        ? <div className={css.contentEmpty} data-ewb-content-empty="">还没有音频</div>
        : <audio className={css.contentAudio + ' nodrag'} data-ewb-content-audio="" src={artifactUrl(art)} controls preload="metadata" />}
    </Shell>
  )
}

/** 生成类型的选项（照参考项目的「图片 / 视频」两档）。 */
const GEN_TYPES: readonly { v: 'image' | 'video', label: string }[] = [
  { v: 'image', label: '图片' },
  { v: 'video', label: '视频' },
]

/** 尺寸的常见档位。 */
export const CONTENT_SIZES: readonly string[] = ['1024x1024', '832x1216', '1216x832', '768x1344', '1344x768']

/**
 * 生成配置节点：类型切换 + 模型 + 尺寸 + 张数 + 走哪份工作流。
 *
 * ## ⚠️ 它**没有出口**（参考项目就是这样）
 *
 * 它描述「要生成什么」，本身不产出内容 —— 结果由它生成、落在**新的**节点上。
 * 所以这里只有 `type="target"` 的入口，**没有** `type="source"`。
 *
 * @param props - React Flow 给的节点入参。
 * @returns 节点。
 */
export function ConfigContentNode({ id, data, width, height }: NodeProps<ContentFlowNode>): React.JSX.Element {
  const bridge = useBridge()
  const genType = data.genType ?? 'image'
  const size = sizeOf({ id, type: 'config', position: { x: 0, y: 0 }, width: width ?? undefined, height: height ?? undefined, data } as ContentNode)
  const patch = (p: ContentNodeData): void => { bridge.onConfig(id, p) }
  /* 标题改名态（票 35）：改名期间标题要显形，显隐的类名挂在外层包装上。 */
  const [renaming, setRenaming] = useState(false)
  return (
    /* ★ 与 `Shell` 同一个外层包装（票 35）：配置节点原来把 `NodeName` 塞在
     * `.contentConfig` 里，而那哥们也是 `overflow: hidden` —— 同一个病，
     * 同一个修法。参考项目所有节点类型都是「外层不裁剪 + 内层裁剪」。 */
    <div className={css.contentNodeWrap + (renaming ? ' ' + css.contentNodeWrapNameEditing : '')} data-ewb-content-wrap="config">
      <div className={css.contentConfig} data-ewb-content-node="config" data-node-id={id}
        onClick={(e) => { e.stopPropagation(); bridge.onSelectNode(id) }}
      >
      <div className={css.contentConfigRow}>
        <span className={css.contentConfigKey}>类型</span>
        <div className={css.contentSeg}>
          {GEN_TYPES.map(t => (
            <button
              key={t.v}
              type="button"
              data-ewb-config-type={t.v}
              data-on={genType === t.v ? '' : undefined}
              className={css.contentSegBtn + ' nodrag'}
              onClick={(e) => { e.stopPropagation(); patch({ genType: t.v }) }}
            >{t.label}</button>
          ))}
        </div>
      </div>
      <div className={css.contentConfigRow}>
        <span className={css.contentConfigKey}>模型</span>
        <input
          className={css.contentConfigInput + ' nodrag'}
          data-ewb-config-model=""
          value={data.model ?? ''}
          placeholder="如 gpt-image-1"
          onChange={(e) => { patch({ model: e.target.value }) }}
        />
      </div>
      {/* ★ 票 70（2026-10-29）：手打框下面加一行小字说清这个节点属于哪一类。
       *
       * ## 为什么不改成下拉
       *
       * 它守的是「清单拉不回来时还能用」—— 渠道没配好、宿主半没起来、请求超时，
       * 这些时候下拉里一个选项都没有，用户就被堵死了。手打框是那条退路。
       *
       * ## 为什么要加这行字
       *
       * 手打时**没有任何提示**：用户不知道这里该填文生图的模型还是图生图的，
       * 也不知道两类是不同的东西（票 67 才把它们拆开）。这行字只做一件事：
       * 说清当前这一类是什么。
       *
       * 设置面板那边有下拉，选项后面带「· 文生图」这类标签 —— 两处说的是同一件事。 */}
      <div
        data-ewb-config-model-hint=""
        style={{
          paddingLeft: 40,
          fontSize: 'var(--text-ewb-meta)',
          color: 'var(--v1-dim)',
          lineHeight: 1.4,
        }}
      >
        {genType === 'video'
          ? '这一类用文生视频模型，填模型 id'
          : '这一类要文生图与图生图模型，填模型 id；带参考图时按图生图走'}
      </div>
      <div className={css.contentConfigRow}>
        <span className={css.contentConfigKey}>尺寸</span>
        <select
          className={css.contentConfigInput + ' nodrag'}
          data-ewb-config-size=""
          value={data.size ?? CONTENT_SIZES[0]}
          onChange={(e) => { patch({ size: e.target.value }) }}
        >
          {CONTENT_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className={css.contentConfigRow}>
        <span className={css.contentConfigKey}>张数</span>
        <input
          className={css.contentConfigInput + ' nodrag'}
          data-ewb-config-count=""
          type="number"
          min={1}
          max={8}
          value={String(data.count ?? 1)}
          onChange={(e) => { patch({ count: Number(e.target.value) || 1 }) }}
        />
      </div>
      <div className={css.contentConfigRow}>
        <span className={css.contentConfigKey}>工作流</span>
        <input
          className={css.contentConfigInput + ' nodrag'}
          data-ewb-config-workflow=""
          value={data.workflow ?? ''}
          placeholder="可选：走哪份工作流"
          onChange={(e) => { patch({ workflow: e.target.value }) }}
        />
      </div>
      <NodeName
        id={id}
        title={nodeLabel({ id, type: 'config', position: { x: 0, y: 0 }, data, title: typeof data.title === 'string' ? data.title : undefined } as ContentNode)}
        onEditingChange={setRenaming}
      />
      <NodeHoverToolbar
        id={id} type="config" hasArtifact={false} hasPrompt={(data.prompt ?? '').trim() !== ''}
        onDownload={() => {}}
        onSaveAsset={() => { bridge.onSaveAsset(id) }}
        onCopyPrompt={() => { bridge.onCopyPrompt(id) }}
        onView={() => {}}
        onUpload={() => {}}
        onDelete={() => { bridge.onDelete(id) }}
        onImageOp={() => {}}
        onMask={() => {}}
        onRunOp={() => {}}
      />
      <Corner corner="tl" id={id} size={size} />
      <Corner corner="tr" id={id} size={size} />
      <Corner corner="bl" id={id} size={size} />
      <Corner corner="br" id={id} size={size} />
      {/* ⚠️ 只有入口，**没有出口** —— 见本组件顶部的说明。 */}
      <Handle type="target" position={Position.Left} className={css.contentHandle} />
      </div>
    </div>
  )
}

/** 组的图标的（照参考项目 `GroupNodeContent` 左上角那个 `Group` 图标）。 */
const GROUP_GLYPH = '\u25a4'

/**
 * 分组框（契约 CE，照参考项目 `canvas-node.tsx:516` 的 `GroupNodeContent`）。
 *
 * ## 它是一个**真节点**，不是一层装饰
 *
 * 用户 m01076 定「编组按参考项目的模式改」：组有位置、有宽高、能选中、能拖动、
 * 能四角缩放。所以它必须走 React Flow 的节点通道 —— 这样选中 / 拖动 / 层级 / 右键命中
 * 全部免费得到（自己画浮层就得把这些重写一遍）。
 *
 * ## 与「一块内容」的观感差别（故意的）
 *
 * 计划 §三 3.2 定「五种内容节点不画边框、不画标题栏」。组**反过来**：
 * 虚线边框 + 左上角名字 + 成员数 —— 参考项目也是这么画的（`borderStyle: 'dashed'`）。
 * 不这么画的话，用户根本看不出那块空白是个框。
 *
 * ## 成员坐标是绝对的
 *
 * 组**不是**父容器（成员没有 `parentId`）。所以拖框**不会**带成员走 ——
 * 那是 `syncGroupsAfterDrag` 在拖完后重算归属的事（见 `group-geometry.ts` 文件头）。
 *
 * @param props - React Flow 给的节点入参。
 * @returns 分组框。
 */
export function GroupContentNode({ id, data, width, height, selected }: NodeProps<ContentFlowNode>): React.JSX.Element {
  const bridge = useBridge()
  const size = {
    width: width ?? 760,
    height: height ?? 480,
  }
  const label = typeof data.title === 'string' && data.title !== '' ? data.title : TYPE_LABEL.group
  /* 标题改名态（票 35）。组的标题在 `.contentGroupHead` 里、组是 `overflow: visible`，
   * 所以它**一直看得见**（这条是「普通节点看不见」的反证）。仍加这一档是为了
   * 与普通节点同一套行为：改名期间标题不闪。 */
  const [renaming, setRenaming] = useState(false)
  return (
    <div
      className={css.contentGroup + (selected === true ? ' ' + css.contentGroupSelected : '') + (renaming ? ' ' + css.contentNodeWrapNameEditing : '')}
      data-ewb-content-node="group"
      data-ewb-group={id}
      data-node-id={id}
      style={{ width: size.width, height: size.height }}
      onClick={(e) => { e.stopPropagation(); bridge.onSelectNode(id) }}
    >
      <div className={css.contentGroupHead}>
        <span className={css.contentGroupGlyph}>{GROUP_GLYPH}</span>
        <NodeName id={id} title={label} onEditingChange={setRenaming} />
        <span className={css.contentGroupCount} data-ewb-group-count={id}>{bridge.groupCount(id)}</span>
      </div>
      {/* ⚠️ 组**没有连接点** —— 它不是数据流里的一环，只是一个框。 */}
      <Corner corner="tl" id={id} size={size} />
      <Corner corner="tr" id={id} size={size} />
      <Corner corner="bl" id={id} size={size} />
      <Corner corner="br" id={id} size={size} />
    </div>
  )
}

/**
 * 节点类型表（交给 `<ReactFlow nodeTypes>`）。
 *
 * ⚠️ **必须是模块级的稳定引用**：每次渲染新建一个对象会让 React Flow
 * 认为节点类型变了、把所有节点重建一遍（本项目在别处踩过同类坑）。
 */
export const CONTENT_NODE_TYPES = {
  text: TextContentNode,
  image: ImageContentNode,
  video: VideoContentNode,
  audio: AudioContentNode,
  config: ConfigContentNode,
  group: GroupContentNode,
  /* 批量节点（用户 m02814 #72-74）。 */
  batch: BatchContentNode,
} as const

/** 类型名（左侧栏与设置面板用）。 */
export { TYPE_LABEL }


/* ══════════════════════════════════════════════════════════════════════
 * 连线（票 60，2026-10-29）
 * ══════════════════════════════════════════════════════════════════════
 *
 * ## 为什么放在这个文件、而不是新建一个
 *
 * 票 60 的可改路径只列了三个 `.tsx`（`ContentCanvas` / `content-nodes` /
 * `ContextMenu`），没有「新建文件」这一项。这个组件只服务内容画布的边，
 * 与节点组件同属「画布上画什么」，放一起是相邻的，不牵强。
 *
 * ## 形状照参考项目
 *
 * `refs-projects/infinite-canvas/web/src/components/canvas/canvas-connections.tsx:33-57`：
 *
 *   · **一条**透明粗描边 `strokeWidth=16`，只负责接点击（`pointerEvents: 'stroke'`）；
 *   · **一条**可见细线，`pointerEvents: 'none'` —— 它不挡点击；
 *   · 选中时**换描边色 + 加一层发光**（参考 `:52-56`）。
 *
 * ## 与参考的两处不同（都写在这里，免得下一个人以为是漏了）
 *
 * | | 参考项目 | 我们 |
 * |---|---|---|
 * | 路径算法 | 自己算三次贝塞尔（`:23-29`） | `getBezierPath()`（React Flow 自带，端点已经算好） |
 * | 选中态怎么来的 | 自己维护 `active` | React Flow 传进来的 `selected` |
 *
 * 两处都是「用现成的」，不是抄不动 —— 参考项目那是自己画整个 SVG 层，
 * 我们的边跑在 React Flow 里，它的端点坐标与命中区机制本来就给了。
 *
 * ## ⚠️ 为什么不用默认边
 *
 * React Flow 的默认边**只有一条 1px 细线**，点击命中区就是那条线本身 ——
 * 用户「点不中」是常态（这一条在参考项目的 16px 命中区注释里明说）。
 * 所以必须自己画，才有那条粗的。
 */

/**
 * 内容画布的一条连线（自定义边类型）。
 *
 * 挂在 `edgeTypes` 上，React Flow 渲染每条边时调它。
 *
 * @param props - React Flow 给的边属性（端点坐标、position、选中态等）。
 * @returns 一组 SVG path（命中区 + 可见线）。
 */
export function ContentEdgeView({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected,
}: EdgeProps): React.JSX.Element {
  const [path] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  })
  /* ⚠️ 两个钩子都要：`data-ewb-edge` 用来**找得到**这条边，
   * `data-ewb-edge-selected` 只在选中时出现 —— 判据 2 靠它判「点中了」。 */
  return (
    <g data-ewb-edge={id} data-ewb-edge-selected={selected === true ? '' : undefined}>
      {/* ★ 命中区：透明、16px 粗。`pointerEvents: 'stroke'` 是必须的 ——
       * 透明 path 默认不接事件（`pointer-events: visiblePainted` 下
       * 「画了但看不见」的东西点不中）。 */}
      <path
        className={css.contentEdgeHit}
        d={path}
        stroke="transparent"
        strokeWidth={16}
        fill="none"
      />
      {/* ★ 看得见的那一条：选中时换色 + 加粗 + 发光（照参考项目 `:52-56`）。
       *
       * `pointerEvents: 'none'` —— 它压在命中区上面，能接事件的话
       * 会把点击吃掉，于是「点线选中」变成只有粗描边边缘能点中。 */}
      <path
        className={css.contentEdgeLine}
        d={path}
        stroke={selected === true ? 'var(--v1-edge-hot)' : 'var(--v1-edge)'}
        strokeWidth={selected === true ? 3 : 2}
        strokeOpacity={selected === true ? 1 : 0.82}
        fill="none"
        style={{
          pointerEvents: 'none',
          filter: selected === true
            ? 'drop-shadow(0 0 8px var(--v1-edge-hot))'
            : undefined,
        }}
      />
    </g>
  )
}

/** 内容画布的边类型表（每一条边都走 `ContentEdgeView`）。 */
export const CONTENT_EDGE_TYPES = { content: ContentEdgeView } as const
