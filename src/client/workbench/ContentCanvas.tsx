/** 内容画布本体：一份画布的编辑界面。
 *
 * ## 用了什么
 *
 * `@xyflow/react` 12 —— 与执行画布**同一套库**（计划 §4.4 定的）。
 *
 * ## 2026-10-26 契约 CD：补全交互（用户 m01076）
 *
 * 用户看了画布后指出「缺的东西很多」，要求照参考项目补。本文件补进来的是：
 *
 * | 件 | 住哪 |
 * |---|---|
 * | 操作模式切换（框选 / 移动） | `CanvasToolbar.tsx` |
 * | 九个快捷键 + 焦点判断 | `shortcutOf`（`content-canvas-store.ts`，纯函数） |
 * | 右键菜单 | 复用 `ContextMenu.tsx`（工作流画布用了很久那个） |
 * | 左侧栏三 tab | `CanvasSidePanel.tsx` |
 * | 节点设置面板 | `NodeSettingsPanel.tsx` |
 * | 悬浮工具条 | `NodeHoverToolbar.tsx` |
 * | 缩放控件 + 快捷键说明 | `CanvasZoomControls.tsx` |
 * | 四角改尺寸 / 双击改名 | `content-nodes.tsx` |
 *
 * ## 这个文件自己只做四件事
 *
 *   ① 把存下的节点 / 连线 / 视口搬进 React Flow，改完再搬回去；
 *   ② 改动后**防抖自动保存**（400ms）；
 *   ③ 撤销 / 重做；
 *   ④ 把上面那些组件的回调接起来。
 *
 * ## ④ 键盘只在**这一格显示着**时挂 —— 为什么重要（不是洁癖）
 *
 * 内容板与工作流板都可能常驻挂载。不判断 `active` 的话，用户在**别的板块**里
 * 按 Ctrl+Z，会默默把看不见的那份画布撤销一步。
 *
 * ## ⚠️ 焦点在输入框里**完全不接管**
 *
 * 这条判据在 `shortcutOf` 的第一行（`typingTarget`）。它不进这个文件，
 * 因为它是一条**规则**，写在组件里就只能靠「挂上去按一下」来验。
 * 执行画布在 `WorkflowCanvas.tsx:2606-2610` 已经踩过一次这个坑。
 *
 * ## 撤销**不删产物**
 *
 * 撤销只恢复画布快照。图片节点的 `artifact` 只是 id，字节在产物库 ——
 * 撤销之后画布上那张图没了，**产物库里那条还在**（产物库是主，节点只是引用）。
 * 所以撤销这条路径上**不许出现任何删产物的调用**。改这里之前先读
 * `content-canvas-store.ts` 文件头。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background, BackgroundVariant, MiniMap, ReactFlow, ReactFlowProvider,
  addEdge, applyEdgeChanges, applyNodeChanges,
  type Connection, type Edge, type EdgeChange, type NodeChange, type Viewport,
  type ReactFlowInstance, useReactFlow,
} from '@xyflow/react'
import type { BoardProps } from './board-registry.ts'
import {
  DEFAULT_VIEWPORT, applyGeo, artifactHref, bytesToBase64, cancelGen, captureIntoGroup,
  clearClipboard, copyNodes, createAutosave, createHistory,
  duplicateNodes, fitGroup, getGenTask, groupMemberCount, groupNodes, listGenModels,
  loadCanvas, newNode, nodeLabel, pasteNodes, placeResult, renameNode, resizeNode, saveCanvas,
  setAllSelected, shortcutOf, isPanReleaseKey, typingTarget, sizeOf, snapshotOf, submitGen, syncGroupsAfterDrag, triggerDownload,
  ungroupNodes, uploadMaterial, toGeo, listMaterials,
  /* 拖放（契约 CJ）：编码在侧栏用、解析与造节点在这里用。 */
  DRAG_MIME, decodeDrag, dropPosition, nodeFromDrag, type DragPayload,
  /* 从系统拖文件 / 剪贴板粘图（用户 m02814 #101 / #102）。 */
  sortDroppedFiles, dropOffset, pasteSourceOf, clipboardSize, RESULT_GAP,
  /* @ 提及（用户 m02814 #76）：候选、token 生成、按输入筛。 */
  mentionableType, mentionTokenOf, mentionQueryAt, filterMentions, mentionTargetOf, mergeRefs,
  TYPE_LABEL, type MentionCandidate,
  /* 图像操作（用户 m02814）：几何算在 store 里，像素在组件里，上传走 uploadArtifact。 */
  uploadArtifact, artifactBase64, refBase64,
  /* 参考图选择（契约 CJ）：候选、写回、显示。 */
  refFromMaterial, refFromNode, describeReference,
  type CanvasAction, type CanvasSnapshot, type ContentNode, type ContentNodeData, type ContentNodeType,
  type GenKind, type GenModelOption, type NodeRunState, type RefChoice, type SubmitGenInput,
  DOT_GAP, DOT_SIZE, LINE_GAP, LINE_SIZE, NODE_SIZE,
  panelWidthFor, panelPlacement,

} from './content-canvas-store.ts'
import {
  CONTENT_NODE_TYPES, ContentNodeBridgeProvider,
  type ContentFlowNode, type ContentNodePayload,
} from './content-nodes.tsx'

/**
 * 老存档的边没有 `type` 字段 —— 不设这个兜底，它们会退回 React Flow 的
 * 默认细线（1px，点不中），等于「老画布上的线右键不出来」。
 *
 * ⚠️ **必须是模块级常量**（不能写成 JSX 里的对象字面量）。
 * 写成 `defaultEdgeOptions={{ type: 'content' }}` 的话，每次渲染都是新引用 →
 * React Flow 的 store 认为入参变了 → 触发一轮更新 → 又一次渲染。
 * 实测这会让测试里的 act 警告从 1130 条涨到 1689 条，把汇总脚本的缓冲区撑爆。
 */
const CONTENT_EDGE_DEFAULTS = { type: 'content' } as const
import { CanvasDock, CanvasTopBar, DockButton, modeToProps, toggleMode, TopBarButton, TopBarDivider, type CanvasMode } from './CanvasToolbar.tsx'
import { CanvasSettingsPanel } from './CanvasSettingsPanel.tsx'
import {
  readPrefs, writePrefs, patchPrefs, isDefaultPrefs, lineColorOf, patternColorOf, DEFAULT_PREFS,
  type CanvasPrefs, type CanvasTheme, type GridMode,
} from './lib/canvas/canvas-prefs.ts'
import {
  ALIGN_THRESHOLD, NO_ALIGN, computeAlign, snappedPosition,
  type AlignBox, type AlignResult,
} from './lib/canvas/canvas-align.ts'
import { detectDark } from './canvas-helpers.ts'
import { CanvasSidePanel } from './CanvasSidePanel.tsx'
import { NodeSettingsPanel } from './NodeSettingsPanel.tsx'
/* ★ 票 60：内容画布的连线（自定义边类型，见那个文件末尾的说明）。 */
import { CONTENT_EDGE_TYPES } from './content-nodes.tsx'
import { CanvasCornerControls } from './CanvasZoomControls.tsx'
/* ★ 票 62：通知条**复用**执行画布那个组件（不复制样式）。
 *
 * 它没有一处引用执行画布的业务，只是当年跟着执行画布一起长出来的 ——
 * 说明写在 `notices.tsx` 的文件头。 */
import { useNotices, NoticeBar } from './notices.tsx'
import { ImageOpPanel, type ImageOpKind } from './ImageOpPanel.tsx'
import { MaskOpMount } from './MaskPanel.tsx'
import { resolveMentions } from '../../schedule/mentions.ts'
/* 类型的中文名**只有一份**（宿主半 `model-types.ts` 的 `MODEL_TYPE_LABEL`）。
 * 界面另写一份就会漂 —— 这个仓库为「生视频 / 文生视频」已经漂过一次（票 67）。 */
import { MODEL_TYPE_LABEL } from '../../schedule/model-types.ts'
import { missingForOp, opAvailable, opSpecOf, opUnavailableReason } from './lib/canvas/op-specs.ts'
import { cropPixelRect, frameTimeOf, splitRects, type CropRect } from './lib/canvas/image-ops.ts'
import { ContextMenu, type MenuState } from './ContextMenu.tsx'
/* 右键菜单的图标（2026-10-26 用户要求「图标统一」）。
 *
 * 原来这里是**字符**（`⎘` `▣` `🗑` …）。字符的问题：不同系统字体下粗细不一，
 * `🗑` 在部分环境是彩色 emoji 方块；而且板块那一层用的是 `icons.tsx` 的真 SVG，
 * **两套并存**看着像两个人做的。这批图标照 lucide v0.441.0 的 path 内联，零依赖。 */
import {
  ClipboardPasteIcon, SelectAllIcon, MaximizeIcon, MinimizeIcon, PlusIcon, XIcon,
  CopyIcon, GroupIcon, UngroupIcon, BoxSelectIcon,
  /* 票 54：悬浮条那批（只留图标 → 这批必须有）。 */
  PanelLeftIcon, UndoIcon, RedoIcon, SettingsIcon, SunIcon, MoonIcon,
  ImageIcon, ArrowRightIcon,
  /* 票 54：加节点那几颗的专用图标。文本 / 视频 / 音频三个是 lead 2026-10-29
   * 批的追加（`icons.tsx` 原本没有）。**配置节点仍然没有专用图标**，
   * 它继续用 `PlusIcon` + `title` —— 那是唯一还剩的缺口，见交付说明。 */
  TypeIcon, VideoIcon, MusicIcon,
  /* 票 62：锁定按钮（`icons.tsx` 里现成的，不是新造）。 */
  LockIcon, UnlockIcon,
} from './icons.tsx'
import type { PromptEntry } from './prompt-sources/index.ts'
import css from './EcomWorkbench.module.css'
/* ★ 票 58：侧栏折叠状态要跨重启记住（与执行画布共用 `ui-prefs`）。 */
import { readUiPrefsCache, saveUiPrefs, writeUiPrefsCache, type UiPrefs } from './dispatch-client.ts'

/**
 * 存盘节点 → React Flow 节点。
 *
 * ⚠️ `data` 必须是**新对象**（React Flow 里 data 是不可变判断依据）。
 *
 * @param n - 存盘形状的节点。
 * @returns React Flow 节点。
 */
function toFlow(n: ContentNode): ContentFlowNode {
  const size = sizeOf(n)
  return {
    id: n.id,
    type: n.type,
    position: { ...n.position },
    width: size.width,
    height: size.height,
    /* ⚠️ 名字要带进 `data` —— 节点卡片的标题、@ 提及的候选名都从
     * `data.title` 读（`fromFlow` 那条白名单也只从 `data` 抄）。
     * 原来这里只抄 `n.data`，而存档里的名字在**节点顶层** `n.title`，
     * 于是「改了名 → 画布上显示的还是类型名」这件事一直存在。 */
    data: { ...n.data, ...(n.title === undefined || n.title === '' ? {} : { title: n.title }) } as ContentNodePayload,
  }
}

/**
 * React Flow 节点 → 存盘形状。
 *
 * ⚠️ 只抄**要存的那几个键**（白名单式）：多抄一个 `measured` / `selected` / `dragging`
 * 就会被写进画布文件，下次读回来 React Flow 会拿着上一轮的运行态当初始值。
 *
 * @param n - React Flow 节点。
 * @returns 存盘形状。
 */
function fromFlow(n: ContentFlowNode): ContentNode {
  const d = n.data
  const data: ContentNodeData = {}
  if (typeof d.text === 'string') data.text = d.text
  if (typeof d.artifact === 'string') data.artifact = d.artifact
  if (d.genType === 'image' || d.genType === 'video') data.genType = d.genType
  if (typeof d.model === 'string') data.model = d.model
  if (typeof d.channel === 'string') data.channel = d.channel
  if (typeof d.size === 'string') data.size = d.size
  if (typeof d.count === 'number') data.count = d.count
  if (typeof d.workflow === 'string') data.workflow = d.workflow
  if (typeof d.prompt === 'string') data.prompt = d.prompt
  if (typeof d.seconds === 'number') data.seconds = d.seconds
  if (typeof d.resolution === 'string') data.resolution = d.resolution
  if (typeof d.reference === 'string') data.reference = d.reference
  /* 归属（契约 CE）：成员记着自己在哪个组里。白名单式映射的坑在这里同样适用 ——
   * 不在这一行加，组一存盘成员归属就全丢了（执行画布在 `error` 字段上踩过同一个坑）。 */
  if (typeof d.groupId === 'string' && d.groupId !== '') data.groupId = d.groupId
  /* 批量节点（用户 m02814 #72-74）：白名单式映射，不加这里一存盘就全丢。 */
  if (Array.isArray(d.items)) data.items = (d.items as unknown[]).filter((x): x is string => typeof x === 'string')
  if (typeof d.mainIndex === 'number') data.mainIndex = d.mainIndex
  if (d.expanded === true) data.expanded = true
  const out: ContentNode = {
    id: n.id,
    type: (n.type ?? 'text') as ContentNodeType,
    position: { x: n.position.x, y: n.position.y },
    width: n.width ?? undefined,
    height: n.height ?? undefined,
    data,
  }
  if (typeof d.title === 'string' && d.title !== '') out.title = d.title
  return out
}

/** 保存状态的三种样子。 */
type SaveState = 'idle' | 'saving' | 'saved' | 'error'

/**
 * 把一个 React Flow 节点转成「对齐算法认的方框」（票 01）。
 *
 * 尺寸取 `n.measured` 优先、再退到 `width` / `height`、最后退到 `NODE_SIZE` ——
 * 三级回退的理由：
 *
 *   ① `measured` 是 React Flow 真量出来的（拖过的节点一定有）；
 *   ② `width` / `height` 是我们写进存盘的（四角改过尺寸的节点有）；
 *   ③ 都没有时（刚加进来还没量过）用类型的默认尺寸 —— 不给回退就会是 0×0，
 *      那种节点参与对齐会算出错的参考线。
 *
 * @param n - React Flow 节点。
 * @returns 对齐算法要的那个方框。
 */
function toAlignBox(n: ContentFlowNode): AlignBox {
  const type = (n.type ?? 'text') as ContentNodeType
  const fallback = NODE_SIZE[type]
  const measured = (n as { measured?: { width?: number, height?: number } }).measured
  return {
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    width: measured?.width ?? n.width ?? fallback.width,
    height: measured?.height ?? n.height ?? fallback.height,
  }
}

/**
 * 「连点两次才删」的等待时长（毫秒）。
 *
 * 照排期板块 `ScheduleBoard.tsx` 那个做法的量级定的 —— 短到不用等，长到够看清文案。
 * 超时之后那一项自己退回「删除节点」，用户不会停在一个「确认删除」上不敢点。
 */
export const DELETE_CONFIRM_MS = 3000

/**
 * 画布上那句「还能撤销几步」（票 02）。
 *
 * ## 为什么不直接写进 `depths`
 *
 * 步数必须与撤销按钮的**可用性同源**（都是 `depths`）。写成两处各判一次，
 * 就会出现「按钮灰着、提示却说可撤销 3 步」这种自相矛盾 —— 比不显示更糟。
 *
 * ## 措辞照执行画布
 *
 * `WorkflowCanvas.tsx:4172` 用的是 `'没有可撤销的操作'` / `'可撤销 N 步'`。
 * 这里逐字沿用，两个画布的说法不漂移。
 *
 * ## 三个地方共用这一句（lead 2026-10-27 批的）
 *
 * | 哪里 | 怎么看见 |
 * |---|---|
 * | 画布右下角那条独立提示 | 随时看得见 |
 * | 顶部工具条「撤销」按钮的 `title` | 悬停才看得见 |
 * | 快捷键说明里 `Ctrl + Z` 那一行 | 点「?」才看得见 |
 *
 * **三处必须是同一个数**。做法：都由这个函数从 `depths` 算出来，
 * 再把**字符串**当 prop 传下去 —— 不让子组件自己去读 `depths`。
 * 子组件各读一次的话，谁漏了谁就显示旧值，而这种不同步在看代码时看不出来。
 *
 * ⚠️ 不要在渲染时另起一个变量算它 —— 那样与 `depths` 分家，自证注入固定值时判据抓不到。
 *
 * @param past - 还能撤销几步（`depths.past`）。
 * @param future - 还能重做几步（`depths.future`）。
 * @returns 一句话。
 */
export function undoHint(past: number, future: number): string {
  const undo = past === 0 ? '没有可撤销的操作' : '可撤销 ' + String(past) + ' 步'
  if (future === 0) return undo
  return undo + '，可重做 ' + String(future) + ' 步'
}

/**
 * 重做按钮的悬停提示（票 02）。
 *
 * 与 `undoHint` 对称：0 步说「没有可重做的操作」，否则说「重做（Ctrl+Y），可重做 N 步」。
 * 快捷键直接写进文案里 —— 用户悬停在按钮上就是在找「怎么用键盘做这件事」。
 *
 * @param future - 还能重做几步（`depths.future`）。
 * @returns 一句话。
 */
export function redoHint(future: number): string {
  return future === 0 ? '没有可重做的操作' : '重做（Ctrl+Y），可重做 ' + String(future) + ' 步'
}

/** 画布本体的入参。 */
export interface ContentCanvasProps extends Pick<BoardProps, 'active'> {
  /** 正在编辑哪一份画布。 */
  canvasId: string
  /** 关闭这一份（回到画布库）。 */
  onClose: () => void
}

/**
 * 内容画布（带 React Flow 上下文）。
 * @param props - 画布 id、是否显示、关闭回调。
 * @returns 界面。
 */
export function ContentCanvas(props: ContentCanvasProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <ContentCanvasInner {...props} />
    </ReactFlowProvider>
  )
}

/**
 * 画布本体（真正干活的那一层）。
 * @param props - 画布 id、是否显示、关闭回调。
 * @returns 界面。
 */
function ContentCanvasInner({ canvasId, active, onClose }: ContentCanvasProps): React.JSX.Element {
  const [nodes, setNodes] = useState<ContentFlowNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [title, setTitle] = useState('')
  const [err, setErr] = useState('')
  const [ready, setReady] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  /**
   * 画布明暗（票 54，用户 2026-10-29 甲 4）。
   *
   * ## 三态，`null` 是有意义的
   *
   * `null` = 用户没切过 → **跟随 dsh 主题**（`detectDark()`）。
   * 用户点过之后写死 `'light'` / `'dark'`，此后 dsh 换主题不影响画布。
   *
   * ## 只改画布自己
   *
   * 落成一个 CSS 变量 `--ewb-canvas-base`（画布底用的就是它），
   * **不碰 `document.body` 的 `data-ds-dark-theme`、不碰 `<html>` 的 `data-ds-theme-source`** ——
   * 用户原话「只切换画布主题色」。判据 5 就是查这一点。
   */
  const [canvasTheme, setCanvasTheme] = useState<CanvasTheme>(() => readPrefs().theme)
  const [depths, setDepths] = useState<{ past: number, future: number }>({ past: 0, future: 0 })
  /** 操作模式（框选 / 移动）。 */
  /* ★ 票 01（2026-10-30）：**默认鼠标逻辑改成「移动」**。
   *
   * 用户原话：「将两个画布默认的鼠标逻辑切换到移动。」
   *
   * ## 为什么默认是「移动」而不是「框选」
   *
   * 画布上最常见的动作是**看**（拖来拖去看全局），不是框选。
   * 框选是个明确的意图，按住 Ctrl 就能切 —— 反过来让「看」需要按住键，
   * 代价更大。
   *
   * ## 框选没有丢
   *
   * `selectionKeyCode="Control"` 仍在（React Flow 的临时切换）：
   * 按住 Ctrl 拖动就是框选。**这一条本票不动。**
   *
   * ⚠️ `panRestoreRef` 那套（按住键临时切、松开恢复）**恢复目标必须跟着这个初值走**，
   * 不是写死 `'select'` —— 见 `panRestoreRef` 那段。 */
  const [mode, setMode] = useState<CanvasMode>('pan')

  /**
   * 画布锁定（票 62，2026-10-29）。
   *
   * ## 拦住哪四件事（少一件等于没锁）
   *
   * | 拦什么 | 拦在哪 |
   * |---|---|
   * | 拖动节点 | `<ReactFlow nodesDraggable={!locked}>` |
   * | 拉新连线 | `<ReactFlow nodesConnectable={!locked}>` |
   * | 改尺寸 | `onNodesChange` 里丢掉 `type === 'dimensions'` 的变更 |
   * | 删除（右键菜单 / `Delete`） | `buildNodeMenu` 的删除项 + `deleteSelected()` |
   *
   * ## ⚠️ 与执行画布**有意不同**的一处：`elementsSelectable` 不动
   *
   * 执行画布锁定时连选中都关掉（`elementsSelectable={!locked}`），因为它那边
   * 选中的主要用途就是删 / 改。内容画布锁住之后**仍然要能点开节点看侧栏详情** ——
   * 那是只读操作，锁掉它就等于「锁了连看都不能看」。
   *
   * **别顺手统一**：看到两处写法不一样就把这边也加上 `elementsSelectable={!locked}`，
   * 会把只读能力一起锁掉。这一条是用户 2026-10-29 明确认可的。
   *
   * ## 为什么用 `ewb.contentLocked` 而不是与执行画布共用 `ewb.locked`
   *
   * 两个画布是两件事。共用会让人困惑：「我只锁了内容画布，怎么执行画布也拖不动了」。
   * 技术上两边的 `locked` 各自绑定在自己的 `<ReactFlow>` 实例上，运行期天然独立。
   */
  /** 通知条（票 62）：自动保存失败 / 素材存失败 / 上传失败都进这里。 */
  const { notices, notify, dismiss } = useNotices()

  const [locked, setLocked] = useState<boolean>(() => {
    try { return localStorage.getItem('ewb.contentLocked') === '1' } catch { return false }
  })
  /** 切换锁定并存盘。 */
  const toggleLocked = useCallback((): void => {
    setLocked((cur) => {
      const next = !cur
      try { localStorage.setItem('ewb.contentLocked', next ? '1' : '0') } catch { /* 存不了就跳过 */ }
      return next
    })
  }, [])
  /* 按住空格之前是哪个工具（松开时回到它，不是一律回「框选」）。 */
  const panRestoreRef = useRef<CanvasMode | null>(null)
  /** 侧栏开着没有。 */
  /* ★ 票 58：侧栏折叠状态**存盘**（原来哪里都不存，刷新就回展开）。
   *
   * 走 `ui-prefs`（与执行画布那边同一份偏好、同一个键名体系），
   * 首帧读缓存撑住、改了立刻写缓存 + 文件。
   *
   * ⚠️ 默认仍是**展开**（`true`）—— 老存档里没有这个键时与改动前行为一致。 */
  const [sideOpen, setSideOpen] = useState<boolean>(
    () => readUiPrefsCache().contentSideCollapsed !== true,
  )
  /**
   * 切换侧栏折叠并记住。
   *
   * ⚠️ 写的是**取反后的那个值**（`contentSideCollapsed` 存的是「折叠了吗」，
   * 而 `sideOpen` 是「展开着吗」—— 两个语义相反，别直接存 `sideOpen`）。
   */
  const toggleSide = useCallback((): void => {
    setSideOpen((v) => {
      const next = !v
      writeUiPrefsCache({ contentSideCollapsed: !next })
      void saveUiPrefs({ contentSideCollapsed: !next } as Partial<UiPrefs>).catch(() => { /* 存不了不影响 */ })
      return next
    })
  }, [])
  /** 面板开着的是哪个节点（空串 = 都收起）。 */
  const [panelId, setPanelId] = useState('')
  /** 正在跑「反推提示词」的节点（结果回来时填进它的 `data.prompt`）。 */
  const captionNodeRef = useRef<string>('')
  /** 打开着的蒙版面板对应哪个节点（空 = 没开）。 */
  const [maskNodeId, setMaskNodeId] = useState('')
  /** 打开着的图像操作浮层（用户 m02814；空 = 没开）。 */
  const [imageOp, setImageOp] = useState<{ id: string, kind: ImageOpKind } | null>(null)
  /** 右键菜单。 */
  const [menu, setMenu] = useState<MenuState | null>(null)
  /**
   * 对齐参考线（票 01）。
   *
   * 拖动中每一帧由 `onDrag` 重算，松手清空。放在 state 里而不是 ref，
   * 因为它是**画出来的东西**（要触发重渲染）。
   *
   * ⚠️ 松手时**重新算一次**（用松手那一刻的坐标），不读这里的值 ——
   * 读旧值会有一个「最后一帧到松手之间」的时间差，吸附位置可能差一两像素。
   */
  const [align, setAlign] = useState<AlignResult>(NO_ALIGN)
  /**
   * 删除确认的计时器 + 那一刻的菜单现场（票 03）。
   *
   * ⚠️ 这里只管**菜单那一项长什么样**，不碰删除语义 ——
   * 真删那一下走的仍是原来那三行（`record('delete')` + 过滤节点 + 过滤连线）。
   */
  const delTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const delCtxRef = useRef<{ e: { clientX: number, clientY: number }, node: ContentFlowNode } | null>(null)
  /** 重摊菜单的函数（`buildNodeMenu` 定义好之后挂上；3 秒超时靠它把文案退回去）。 */
  const rebuildMenuRef = useRef<((at: { clientX: number, clientY: number }, node: ContentFlowNode, pending: boolean) => void) | null>(null)
  /**
   * 菜单此刻开着没有。
   *
   * ⚠️ 3 秒超时那一下要靠它判断：菜单已经被用户关掉（点别处 / Esc），
   * 就**不许**又把菜单弹回来 —— 那会变成「点空白处关掉菜单，三秒后它自己又出来了」。
   */
  const menuOpenRef = useRef(false)
  menuOpenRef.current = menu !== null

  /** 撤掉「等第二次确认」这件事（关菜单 / 超时 / 真删之后都要做）。 */
  const disarmDelete = useCallback((): void => {
    if (delTimerRef.current !== null) { clearTimeout(delTimerRef.current); delTimerRef.current = null }
    delCtxRef.current = null
  }, [])

  /**
   * 起 3 秒的「等第二次确认」（票 03）。
   *
   * 超时之后：菜单还开着就把那一项退回「删除节点」，用户不用自己关掉重开。
   * 菜单已经关了（点了别处 / Esc）就只清掉状态，什么都不用改。
   *
   * @param e - 那次右键的坐标（重摊菜单时原位放回）。
   * @param node - 右键点的那个节点。
   */
  const armDeleteConfirm = useCallback((e: { clientX: number, clientY: number }, node: ContentFlowNode): void => {
    disarmDelete()
    delCtxRef.current = { e, node }
    delTimerRef.current = setTimeout(() => {
      delTimerRef.current = null
      const ctx = delCtxRef.current
      delCtxRef.current = null
      if (ctx === null) return
      /* 菜单已经被用户关掉（点别处 / Esc）→ 什么都不做。
       * 否则会变成「点空白处关掉菜单，三秒后它自己又弹出来」。 */
      if (!menuOpenRef.current) return
      rebuildMenuRef.current?.(ctx.e, ctx.node, false)
    }, DELETE_CONFIRM_MS)
  }, [disarmDelete])
  /** 小地图开关。 */
  /* ★ 画布设置落盘（用户 m03414：「所有画布设置必须落盘，不能只在内存」）。
   *
   * 原来 `miniMap` 与 `grid` 是两个裸 `useState` —— **刷新就回默认**。
   * 现在整份设置从 `localStorage` 读（容错），每次改完写回去。 */
  const [prefs, setPrefs] = useState<CanvasPrefs>(() => readPrefs())
  /** 改一项并落盘（改不了就只改内存里的，不影响这次使用）。 */
  const putPrefs = useCallback((patch: Partial<CanvasPrefs>): void => {
    setPrefs((cur) => {
      const next = patchPrefs(cur, patch)
      writePrefs(next)
      return next
    })
  }, [])
  /** 设置面板开着吗。 */
  const [settingsOpen, setSettingsOpen] = useState(false)
  const miniMap = prefs.miniMap
  const grid: GridMode = prefs.grid
  /** 网格样式（点阵 / 线格 / 空白）。 */
  /** 当前缩放（滑块与百分比用）。 */
  const [zoom, setZoom] = useState(1)
  /**
   * 能做生成的模型清单（契约 CH）。
   *
   * `null` = 还没查回来（界面显示「正在查模型」）；`[]` = 查回来了但一个都没有。
   * 两者要分开 —— 前者不该显示「没有可用模型」这种既定结论。
   */
  const [genModels, setGenModels] = useState<GenModelOption[] | null>(null)
  /** 查模型失败的原因（查不到时说清为什么，而不是干等着）。 */
  const [genModelErr, setGenModelErr] = useState('')
  /** 每个节点的运行态（`idle` / `running` / `failed`）。**不落盘**，见 `NodeRunState`。 */
  const [runs, setRuns] = useState<Record<string, NodeRunState>>({})

  const flow = useReactFlow()
  const instRef = useRef<ReactFlowInstance<ContentFlowNode, Edge> | null>(null)
  const viewportRef = useRef<Viewport>({ ...DEFAULT_VIEWPORT })
  const histRef = useRef(createHistory())
  const lastRecordRef = useRef<{ at: number, key: string }>({ at: 0, key: '' })
  const dragSnapRef = useRef<CanvasSnapshot | null>(null)
  /** 这次拖动动了哪些节点（拖完要按它同步组归属 —— 契约 CE）。 */
  const dragMovedRef = useRef<string[]>([])
  const saveRef = useRef<(s: CanvasSnapshot) => void>(() => {})
  const autosaveRef = useRef(createAutosave(s => { saveRef.current(s) }))
  /** 文件选择框（「替换」用）。 */
  const fileRef = useRef<HTMLInputElement | null>(null)
  /** 哪个节点正在等替换。 */
  const uploadTargetRef = useRef('')

  /** 当前画布的存盘形状。 */
  const snapNow = useCallback((): CanvasSnapshot => snapshotOf(
    nodes.map(fromFlow),
    edges.map(e => ({
      id: e.id, source: e.source, target: e.target,
      ...(e.sourceHandle == null ? {} : { sourceHandle: e.sourceHandle }),
      ...(e.targetHandle == null ? {} : { targetHandle: e.targetHandle }),
    })),
    viewportRef.current,
  ), [nodes, edges])
  const snapRef = useRef(snapNow)
  snapRef.current = snapNow
  /** 节点数组的稳定引用（拖动回调里读「这次拖了哪些」，不能挂在依赖链上）。 */
  const nodesRef = useRef<ContentFlowNode[]>([])
  nodesRef.current = nodes

  /** 记一笔「改动之前」的快照。 */
  const record = useCallback((key: string, coalesceMs = 0): void => {
    const now = Date.now()
    const last = lastRecordRef.current
    if (coalesceMs > 0 && last.key === key && now - last.at < coalesceMs) {
      lastRecordRef.current = { at: now, key }
      return
    }
    lastRecordRef.current = { at: now, key }
    histRef.current.record(snapRef.current())
    setDepths(histRef.current.depths())
  }, [])

  /* ── 读一份画布 ─────────────────────────────────────────────── */
  useEffect(() => {
    let alive = true
    setReady(false)
    setErr('')
    setPanelId('')
    clearClipboard()
    histRef.current.clear()
    setDepths({ past: 0, future: 0 })
    void (async () => {
      const r = await loadCanvas(canvasId)
      if (!alive) return
      if (!r.ok || r.data === undefined) { setErr(r.error ?? '读不到这份画布'); setReady(true); return }
      const doc = r.data
      setTitle(doc.title)
      setNodes(doc.nodes.map(toFlow))
      setEdges(doc.edges.map(e => ({
        id: e.id, source: e.source, target: e.target,
        ...(e.sourceHandle === undefined ? {} : { sourceHandle: e.sourceHandle }),
        ...(e.targetHandle === undefined ? {} : { targetHandle: e.targetHandle }),
      })))
      viewportRef.current = { ...doc.viewport }
      setZoom(doc.viewport.zoom)
      setReady(true)
      setTimeout(() => { void flow.setViewport(doc.viewport) }, 0)
    })()
    return () => { alive = false }
  }, [canvasId, flow])

  /* ── 自动保存 ───────────────────────────────────────────────── */
  saveRef.current = (s: CanvasSnapshot): void => {
    setSaveState('saving')
    void (async () => {
      const r = await saveCanvas(canvasId, title, s)
      /* ★ 票 62：**失败进通知条**（那行红字看一眼就没了，而保存失败必须留住）。
       *
       * 用户原话（票面）：「内容画布只有一行红字，看一眼就没了」。
       * 通知条的 `error` 语气**不自动消失**，带手动关闭 —— 正是为这种场景做的。
       *
       * ⚠️ 两处都写（红字 + 通知条）是有意的：红字贴在图下方、离操作最近，
       * 通知条在右上角、能堆叠、要看才关。撤掉红字会让「刚刚那一下」和
       * 「之前攒下的失败」混在一起分不清。 */
      if (r.ok) { setSaveState('saved'); setErr('') }
      else {
        const why = r.error ?? '保存失败'
        setSaveState('error')
        setErr(why)
        notify('自动保存失败：' + why, 'error')
      }
    })()
  }

  useEffect(() => {
    if (!ready) return
    autosaveRef.current.queue(snapshotOf(nodes.map(fromFlow), edges.map(e => ({
      id: e.id, source: e.source, target: e.target,
    })), viewportRef.current))
  }, [nodes, edges, ready])

  useEffect(() => () => { autosaveRef.current.flush() }, [])

  /* ── 撤销 / 重做 ────────────────────────────────────────────── */
  const apply = useCallback((s: CanvasSnapshot): void => {
    setNodes(s.nodes.map(toFlow))
    setEdges(s.edges.map(e => ({
      id: e.id, source: e.source, target: e.target,
      ...(e.sourceHandle === undefined ? {} : { sourceHandle: e.sourceHandle }),
      ...(e.targetHandle === undefined ? {} : { targetHandle: e.targetHandle }),
    })))
    viewportRef.current = { ...s.viewport }
    setZoom(s.viewport.zoom)
    void flow.setViewport(s.viewport)
    /* ⚠️ 这里**不许**出现任何删产物的调用 —— 见文件头「撤销不删产物」。 */
  }, [flow])

  const doUndo = useCallback((): void => {
    const prev = histRef.current.undo(snapRef.current())
    if (prev === null) return
    setDepths(histRef.current.depths())
    apply(prev)
  }, [apply])

  const doRedo = useCallback((): void => {
    const next = histRef.current.redo(snapRef.current())
    if (next === null) return
    setDepths(histRef.current.depths())
    apply(next)
  }, [apply])

  /* ── 选中与增删 ─────────────────────────────────────────────── */
  /** 选中的那些（存盘形状）。 */
  const selected = useCallback((): ContentNode[] => nodes.filter(n => n.selected === true).map(fromFlow), [nodes])

  /**
   * 删掉选中的节点。
   *
   * ## 返回值的三种取值（⚠️ 调用方必须分清）
   *
   * | 返回 | 含义 | 调用方该怎么反应 |
   * |---|---|---|
   * | `> 0` | 真删了几个 | `preventDefault`、提示「已删除 N 个」 |
   * | `0` | **没有选中项**，什么都没做 | 不提示（用户本来就没选） |
   * | `< 0`（即 `-1`） | **画布锁着，被拦了** | 提示「先解锁才能删」，**不是**「没选中」 |
   *
   * 为什么用负数而不是也返回 `0`：这两种情况对用户的含义完全不同 ——
   * 一个是「你什么都没选」，一个是「你选了但删不掉，去解锁」。
   * 混成 `0` 的话，将来谁加一句「没选中也能删」的提示就会张冠李戴。
   *
   * @returns 删掉的个数；没选中给 0；锁着给 -1。
   */
  const deleteSelected = useCallback((): number => {
    /* ★ 票 62：锁定时拦住删除（四条之一，见 `locked` 那段注释）。 */
    if (locked) return -1
    const gone = new Set(nodes.filter(n => n.selected === true).map(n => n.id))
    if (gone.size === 0) return 0
    record('delete')
    setNodes(prev => prev.filter(n => !gone.has(n.id)))
    setEdges(prev => prev.filter(e => !gone.has(e.source) && !gone.has(e.target)))
    setPanelId(cur => (gone.has(cur) ? '' : cur))
    return gone.size
  }, [locked, nodes, record])

  /** 全选。 */
  const selectAll = useCallback((): number => {
    if (nodes.length === 0) return 0
    setNodes(prev => setAllSelected(prev, true))
    return nodes.length
  }, [nodes.length])

  /** 复制选中。 */
  const doCopy = useCallback((): number => copyNodes(selected()), [selected])

  /** 粘贴。 */
  const doPaste = useCallback((): number => {
    const fresh = pasteNodes()
    if (fresh.length === 0) return 0
    record('paste')
    setNodes(prev => [...prev.map(n => ({ ...n, selected: false })), ...fresh.map(toFlow)])
    return fresh.length
  }, [record])

  /** 原地复制。 */
  const doDuplicate = useCallback((): number => {
    const src = selected()
    if (src.length === 0) return 0
    record('duplicate')
    setNodes(prev => [...prev.map(n => ({ ...n, selected: false })), ...duplicateNodes(src).map(toFlow)])
    return src.length
  }, [record, selected])

  /** 加一个节点。
   *
   * ## 落位间距从设置读（2026-10-27 接通）；尺寸不再可配（票 34，2026-10-28）
   *
   * 原来这里写死 `const offset = nodes.length * 24`，设置面板里那项**存了却没人读**。
   * 现在读 `prefs.dropGap`（默认 24，与改之前一字不差）。
   *
   * ★ **尺寸**这一半已经回退成「直接用 `NODE_SIZE[type]`」：
   * 用户定节点尺寸照参考项目逐类定死，不再有全局覆盖。所以这里不再调
   * `nodeSizeFrom(prefs, …)`（那个函数与 `nodeW` / `nodeH` 一起退役了）。
   *
   * ⚠️ `nodeW` / `nodeH` 两个字段还在 `CanvasPrefs` 里（老存档兼容），
   * **只是这里不读它们** —— 别看到字段还在就以为还能配。 */
  const addNode = useCallback((type: ContentNodeType): void => {
    record('add')
    const offset = nodes.length * prefs.dropGap
    const init: ContentNodeData = type === 'config' ? { genType: 'image', count: 1 } : {}
    /* 尺寸直接用这一类的默认值（票 34：照参考逐类定死，不再有全局覆盖）。 */
    const n = newNode(type, { x: 80 + offset, y: 80 + offset }, init, NODE_SIZE[type])
    setNodes(prev => [...prev, toFlow(n)])
    setPanelId('')
  }, [nodes.length, record, prefs.dropGap, setPanelId])

  /** 改尺寸。 */
  const onResize = useCallback((id: string, w: number, h: number): void => {
    record('resize:' + id, 600)
    setNodes(prev => prev.map(n => (n.id === id ? { ...n, width: Math.round(w), height: Math.round(h) } : n)))
  }, [record])

  /** 改名。 */
  const onRename = useCallback((id: string, next: string): void => {
    record('rename:' + id)
    const before = snapRef.current().nodes
    const after = renameNode(before, id, next)
    setNodes(prev => prev.map(n => {
      if (n.id !== id) return n
      const hit = after.find(x => x.id === id)
      const data = { ...n.data }
      if (hit?.title === undefined) delete data.title
      else data.title = hit.title
      return { ...n, data }
    }))
  }, [record])

  /** 改文本（**节点的产出**，不是输入参数）。 */
  const onText = useCallback((id: string, text: string): void => {
    record('text:' + id, 800)
    setNodes(prev => prev.map(n => (n.id === id ? { ...n, data: { ...n.data, text } } : n)))
  }, [record])

  /** 改数据项。 */
  const onConfig = useCallback((id: string, patch: ContentNodeData): void => {
    record('cfg:' + id, 800)
    setNodes(prev => prev.map(n => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)))
  }, [record])

  /** 删一个节点（悬浮工具条用）。 */
  const deleteOne = useCallback((id: string): void => {
    record('delete')
    setNodes(prev => prev.filter(n => n.id !== id))
    setEdges(prev => prev.filter(e => e.source !== id && e.target !== id))
    setPanelId(cur => (cur === id ? '' : cur))
  }, [record])

  /* ── 编组（契约 CE，照参考项目的模式）────────────────────────── */

  /**
   * 把选中的节点编成一组。
   *
   * 参考项目的行为（`project.tsx:1008` `groupSelectedNodes`）：选中 ≥2 个 → 建一个组节点、
   * 框住它们、成员的 `groupId` 指向它、**选中态换成那个组**。
   *
   * ⚠️ 成员**至少 2 个**才有意义（一个节点的框看起来像画错了）。
   * 执行画布那边也是同一条门槛，提示语统一。
   */
  const doGroup = useCallback((): number => {
    const ids = nodes.filter(n => n.selected === true && n.type !== 'group').map(n => n.id)
    if (ids.length < 2) { setErr('至少选中 2 个节点才能编组'); return 0 }
    record('group')
    const r = groupNodes(nodes.map(fromFlow), ids, '')
    if (r.groupId === '') { setErr('至少选中 2 个节点才能编组'); return 0 }
    setNodes(r.nodes.map(toFlow))
    setErr('')
    return ids.length
  }, [nodes, record])

  /** 选中那些节点所属的组（解散 / 适应成员都要先知道「操作哪个组」）。 */
  const groupsOfSelection = useCallback((): string[] => {
    const picked = new Set(nodes.filter(n => n.selected === true).map(n => n.id))
    const out: string[] = []
    for (const n of nodes) {
      if (n.type === 'group' && picked.has(n.id)) out.push(n.id)
    }
    /* 选中组里的成员 = 选中了这个组（新模型里框和成员是两个节点，
     * 用户很难「只点中框」而不碰里面的东西）。 */
    for (const n of nodes) {
      const gid = n.data.groupId
      if (gid !== undefined && gid !== '' && picked.has(n.id) && !out.includes(gid)) out.push(gid)
    }
    return out
  }, [nodes])

  /** 解散。 */
  const doUngroup = useCallback((): number => {
    const hit = groupsOfSelection()
    if (hit.length === 0) { setErr('先选中组里的节点，再取消分组'); return 0 }
    record('ungroup')
    let cur = nodes.map(fromFlow)
    for (const gid of hit) cur = ungroupNodes(cur, gid)
    setNodes(cur.map(toFlow))
    setErr('')
    return hit.length
  }, [groupsOfSelection, nodes, record])

  /** 框适应成员。 */
  const doFitGroup = useCallback((groupId: string): void => {
    record('fit:' + groupId, 600)
    setNodes(fitGroup(nodes.map(fromFlow), groupId).map(toFlow))
  }, [nodes, record])

  /** 收纳框内的节点。 */
  const doCapture = useCallback((groupId: string): void => {
    record('capture:' + groupId)
    const r = captureIntoGroup(nodes.map(fromFlow), groupId)
    setNodes(r.nodes.map(toFlow))
  }, [nodes, record])

  /**
   * 选中某个组的全部成员（参考项目 `handleSelectGroupChildren`）。
   *
   * 为什么要这一条：新模型里框和成员是**两个节点**，双击 / 右键框时
   * 想让「整个组都能一起被拖动」，得先把成员选上 —— 否则用户拖框只挪走一条虚线。
   *
   * @param groupId - 组 id。
   * @returns 选中了几个。
   */
  const selectGroupChildren = useCallback((groupId: string): number => {
    const kids = nodes.filter(n => n.data.groupId === groupId).map(n => n.id)
    if (kids.length === 0) { setErr('这个组里还没有成员'); return 0 }
    const want = new Set([...kids, groupId])
    setNodes(prev => prev.map(n => (want.has(n.id) ? { ...n, selected: true } : n)))
    setErr('')
    return kids.length
  }, [nodes])

  /** 拖动结束时同步归属（拖进框 → 归入；拖出框 → 脱离）。 */  const doSyncGroups = useCallback((): void => {
    if (!nodes.some(n => n.type === 'group')) return
    const moved = (dragMovedRef.current.length > 0 ? dragMovedRef.current : nodes.filter(n => n.selected === true).map(n => n.id))
    if (moved.length === 0) return
    setNodes(syncGroupsAfterDrag(nodes.map(fromFlow), moved).map(toFlow))
  }, [nodes])

  /** 把一段文字写进剪贴板（与提示词库同一个回退套路）。 */
  const copyText = useCallback(async (text: string): Promise<void> => {
    try {
      const nav = navigator as unknown as { clipboard?: { writeText?: (s: string) => Promise<void> } }
      if (nav.clipboard?.writeText !== undefined) { await nav.clipboard.writeText(text); return }
    } catch { /* 掉到回退 */ }
    try {
      const el = document.createElement('textarea')
      el.value = text
      el.style.position = 'fixed'
      el.style.left = '-9999px'
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
    } catch { /* 复制不了就算了，不把界面带崩 */ }
  }, [])

  /** 定位到某个节点（侧栏点一行）。 */
  const focusNode = useCallback((id: string): void => {
    const n = nodes.find(x => x.id === id)
    if (n === undefined) return
    const size = sizeOf(fromFlow(n))
    void flow.setCenter(n.position.x + size.width / 2, n.position.y + size.height / 2, { zoom: Math.max(0.4, zoom), duration: 300 })
    setNodes(prev => setAllSelected(prev, false).map(x => (x.id === id ? { ...x, selected: true } : x)))
    setPanelId(id)
  }, [flow, nodes, zoom])

  /* ── 插入素材 / 提示词（侧栏另外两个 tab）───────────────────── */
  const insertMaterial = useCallback((m: { name: string, url: string }): void => {
    record('insert')
    const isVideo = /\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(m.name)
    const n = newNode(isVideo ? 'video' : 'image', { x: 120 + nodes.length * 20, y: 160 + nodes.length * 20 }, {
      /* 素材地址直接用它的 url（不是产物 id）—— 素材库那条路由与产物路由是两条。 */
      artifact: '',
      prompt: '',
    })
    /* 素材没有产物 id，所以把 url 记在 reference 里让节点能显示。
     * ⚠️ 这是本单的临时做法：真正的「素材转产物」要后端做，见交付说明。 */
    n.data.reference = m.url
    setNodes(prev => [...prev, toFlow(n)])
  }, [nodes.length, record])

  /**
   * 拖放落位（契约 CJ）：把拖进来的东西放成一个新节点。
   *
   * ⚠️ 与 `insertMaterial` **刻意分开**：
   *   · 点击插入用的是**阶梯偏移**（连点几次不叠在一起）；
   *   · 拖放有明确落点，位置就是用户松手那里（`dropPosition` 不再偏移）。
   * 两条都留着 —— 验收 9 要求「点击仍然可用」。
   *
   * @param p - 拖放载荷（`decodeDrag` 解出来的）。
   * @param position - 落点（画布坐标）。
   */
  const dropOnCanvas = useCallback((p: DragPayload, position: { x: number, y: number }): void => {
    record('insert')
    const n = nodeFromDrag(p, position)
    setNodes(prev => [...prev, toFlow(n)])
  }, [record])

  /**
   * 把**文件**读成产物再建节点（用户 m02814 #101 / #102 共用这一条）。
   *
   * ## 为什么拖进来与粘贴走同一个函数
   *
   * 两件事在语义上是同一件：「用户给了一份本地文件，要它变成画布上的节点」。
   * 区别只在**从哪儿拿到 `File`**（`dataTransfer.files` 还是 `clipboardData.files`）。
   * 写两份的话，'不支持的类型' 提示、上传、落位这些细节迟早会漂。
   *
   * ## 不认识的类型：**明确提示**，不静默丢（判据 3）
   *
   * `sortDroppedFiles` 把认不出的名字原样回给我们，这里念出来。
   *
   * @param files - 用户的文件。
   * @param at - 落点（画布坐标；多个文件会依次错开）。
   * @returns 无（异步上传，失败写 `err`）。
   */
  const dropFiles = useCallback((files: readonly File[], at: { x: number, y: number }): void => {
    const sorted = sortDroppedFiles(files.map(f => f.name))
    if (sorted.rejected.length > 0) {
      setErr('这些文件放不进来（只收图片 / 视频 / 音频）：' + sorted.rejected.join('、'))
    } else {
      setErr('')
    }
    if (sorted.ok.length === 0) return
    record('insert')
    void (async () => {
      for (let i = 0; i < sorted.ok.length; i += 1) {
        const want = sorted.ok[i]
        /* ⚠️ 按**名字**回查原始 File：`sortDroppedFiles` 只处理名字，
         * 同名的两个文件会拿到同一个 —— 那也比「按下标配对」稳，
         * 因为 `ok` 的顺序与 `files` 的顺序可能被过滤打乱。 */
        const file = files.find(f => f.name === want.name)
        if (file === undefined) continue
        const buf = new Uint8Array(await file.arrayBuffer())
        const ext = (want.name.split('.').pop() ?? '').toLowerCase()
        const up = await uploadArtifact(bytesToBase64(buf), file.type !== '' ? file.type : 'application/octet-stream', ext)
        if (!up.ok || up.data === undefined) {
          const why = up.error ?? '存成产物失败'
          setErr('「' + want.name + '」' + why)
          /* ★ 票 62：上传失败也进通知条（用户原话：「上传失败都进通知条」）。 */
          notify('「' + want.name + '」' + why, 'error')
          continue
        }
        const pos = dropOffset(at, i)
        setNodes(prev => [...prev, toFlow(newNode(want.kind, pos, { artifact: up.data, prompt: '' }))])
      }
    })()
  }, [record, notify, setErr])

  /**
   * 从系统剪贴板粘一张图（用户 m02814 #102）。
   *
   * ⚠️ **只在内部缓冲区为空时才走这里** —— 判据由 `pasteSourceOf` 定，
   * 由 `doPaste` 调用前先问它。复制了节点却粘出一张图是明确的错。
   *
   * @param ev - 粘贴事件。
   * @returns 粘了给 true（调用方据此 `preventDefault`）。
   */
  const pasteFromSystem = useCallback((ev: ClipboardEvent): boolean => {
    const items = ev.clipboardData?.items
    if (items === undefined || items === null) return false
    const files: File[] = []
    for (const it of items) {
      if (it.kind !== 'file') continue
      const f = it.getAsFile()
      if (f !== null) files.push(f)
    }
    if (files.length === 0) return false
    /* 粘进来的图落在视口中心（粘贴没有鼠标位置）。 */
    dropFiles(files, dropPosition({ x: 200 + nodesRef.current.length * 20, y: 160 + nodesRef.current.length * 20 }))
    return true
  }, [dropFiles])


  const insertPrompt = useCallback((p: PromptEntry): void => {
    record('insert')
    const n = newNode('text', { x: 120 + nodes.length * 20, y: 160 + nodes.length * 20 }, { text: p.prompt })
    setNodes(prev => [...prev, toFlow(n)])
  }, [nodes.length, record])

  /* ══════════════════════════════════════════════════════════════════
   * 连线（票 60，2026-10-29）
   * ══════════════════════════════════════════════════════════════════
   *
   * 用户原话：「内容画布怎么就没连线了？不是有吗？只是规矩相对执行画布
   * 没那么多，别漏了，看参考。」
   *
   * 补三件事：选中态（由边组件做掉）、右键菜单删线、`Delete` 删线。
   *
   * ⚠️ **这一组必须定义在键盘那段之前** —— 那个 `useEffect` 的依赖数组里
   * 用到 `disarmEdgeDelete` / `deleteSelectedEdge`。放在后面会 TS2448
   * （白屏那个坑），`check:tdz` 会红。
   */

  /** 正在等第二次确认的那条边（`null` = 没有）。 */
  const edgePendingRef = useRef<string | null>(null)
  /** 连线的确认计时器（与节点那个分开，两条互不影响）。 */
  const edgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** 撤掉「等第二次确认删线」。 */
  const disarmEdgeDelete = useCallback((): void => {
    if (edgeTimerRef.current !== null) { clearTimeout(edgeTimerRef.current); edgeTimerRef.current = null }
    edgePendingRef.current = null
  }, [])

  /**
   * 真删一条线（**这里是唯一一处删线**）。
   *
   * 右键菜单第二下、`Delete` 键都走它 —— 一处删，两处入口就不会出现
   * 「菜单删了不进撤销栈、按键删了进」这种不一致。
   *
   * @param edgeId - 要删的那条边的 id。
   */
  const removeEdge = useCallback((edgeId: string): void => {
    disarmEdgeDelete()
    /* ★ `record` 是撤销栈的唯一入口 —— 少了这一行，判据 3 的
     * 「Ctrl+Z 能撤回」就做不到，而线看着是被删掉了。 */
    record('delete-edge')
    setEdges(prev => prev.filter(x => x.id !== edgeId))
  }, [disarmEdgeDelete, record])

  /**
   * 右键一条线：摊开菜单。
   *
   * 删除走**连点两次**，与节点右键菜单那一套同款（票 03 定的，
   * 不用 `window.confirm` —— Electron 桌面端弹框行为与浏览器不一致）。
   *
   * @param e - 那次右键事件（要 `clientX/clientY` 摆菜单）。
   * @param edge - 右键点到的那条边。
   */
  const edgeMenu = useCallback((e: React.MouseEvent, edge: Edge): void => {
    e.preventDefault()
    const pending = edgePendingRef.current === edge.id
    setMenu({
      x: e.clientX, y: e.clientY,
      title: '连线',
      entries: [
        {
          id: 'delEdge',
          icon: <XIcon />,
          label: pending ? '确认删除' : '删除连线',
          key: pending ? '再点一次' : 'Delete',
          danger: true,
          run: () => {
            if (!pending) {
              /* 第一下：只换文案、起 3 秒计时，线一条都不动。
               * 与节点那套同一手法 —— 菜单留在原地，用户接着点第二下。 */
              edgePendingRef.current = edge.id
              if (edgeTimerRef.current !== null) clearTimeout(edgeTimerRef.current)
              edgeTimerRef.current = setTimeout(() => {
                edgeTimerRef.current = null
                edgePendingRef.current = null
              }, DELETE_CONFIRM_MS)
              edgeMenu(e, edge)
              return
            }
            removeEdge(edge.id)
          },
        },
      ],
    })
  }, [removeEdge])

  /**
   * 选中一条线时按 `Delete`。
   *
   * ## ⚠️ 这里**一次就删**，与 `Delete` 键删节点一致
   *
   * 票面判据 4 写「与节点删除一样走一次确认」。核了节点的实际行为，
   * **它分两条路、手感本来就不一样**：
   *
   * | 入口 | 现在的行为 | 代码 |
   * |---|---|---|
   * | 右键菜单「删除节点」 | 连点两次（票 03 定的，避免误删） | `buildNodeMenu` 的 `del` 项 |
   * | 选中 + `Delete` 键 | **一次就删** | `deleteSelected()` |
   *
   * 所以「与节点一样」有两种读法。按**同一入口对齐**：
   * `Delete` 键删线 = `Delete` 键删节点（一次就删，且都进撤销栈）。
   *
   * 理由：`Delete` 键本身就是个有意识的动作，删错 `Ctrl+Z` 一次就回来。
   * 反过来给键加确认会出现「按一次没反应、按两次才删」这种比菜单更差的手感
   * —— 而节点那边并没有那样做。**右键菜单那条路两边都是连点两次**。
   *
   * @returns 这次按键**处理掉了**没有（`true` = 调用方要 `preventDefault`）。
   */
  const deleteSelectedEdge = useCallback((): boolean => {
    const sel = edges.filter(x => x.selected === true)
    if (sel.length === 0) return false
    for (const x of sel) removeEdge(x.id)
    return true
  }, [edges, removeEdge])

  /* ── 键盘：九个快捷键（判据全在 `shortcutOf` 里）─────────────── */
  useEffect(() => {
    if (!active) return
    /**
     * 键处理。
     * @param e - 键盘事件。
     */
    const onKey = (e: KeyboardEvent): void => {
      const act: CanvasAction | null = shortcutOf({
        key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, target: e.target,
      })
      /* ⚠️ `null` = 不接管（焦点在输入框里、或不是我们的键）。
       * 这里**不许**调 preventDefault —— 会把用户在文本框里的按键吃掉。 */
      if (act === null) return
      if (act === 'undo') { e.preventDefault(); doUndo(); return }
      if (act === 'redo') { e.preventDefault(); doRedo(); return }
      if (act === 'delete') {
        /* ★ 票 60：`Delete` 现在**同时**管节点与连线。
         *
         * 顺序：先删选中的节点（连带删它们的线，那是既有语义），
         * 再删「单独选中的线」—— 两者可能同时被选中（按住 Shift 点节点与线）。
         *
         * ⚠️ 只删线时也要 `preventDefault`，否则浏览器会拿这一次按键去做别的。 */
        const nodesGone = deleteSelected()
        const edgeGone = deleteSelectedEdge()
        /* ⚠️ `nodesGone < 0` = 画布锁着被拦了。那种情况**也要** `preventDefault`
         * —— 否则浏览器会拿这次 Delete 去做别的（比如后退）。
         * 判断写成 `!== 0` 而不是 `> 0` 就是为了盖住这一支。 */
        if (nodesGone !== 0 || edgeGone) e.preventDefault()
        return
      }
      if (act === 'escape') {
        e.preventDefault()
        setMenu(null)
        /* 关菜单同时把「等第二次确认」撤掉 —— 不然三秒后那一项会自己又弹回来。 */
        disarmDelete()
        /* ★ 票 60：连线的确认也一样撤。 */
        disarmEdgeDelete()
        setPanelId('')
        setNodes(prev => setAllSelected(prev, false))
        return
      }
      if (act === 'selectAll') { e.preventDefault(); selectAll(); return }
      if (act === 'copy') { if (doCopy() > 0) e.preventDefault(); return }
      if (act === 'paste') {
        /* ★ 两条粘贴通道（用户 m02814 #102）：
         *   · 内部缓冲区有节点 → 粘节点（**不读系统剪贴板**）；
         *   · 缓冲区为空 → 不拦，交给下面的 `onPaste` 去读剪贴板里的图。
         *
         * 判据由 `pasteSourceOf` 定，这里只照它走。
         * ⚠️ 缓冲区非空时**不许**去碰剪贴板 —— 用户复制了一个节点却粘出一张图，
         * 那是明确的错（判据 6 就是钉这一条）。 */
        if (pasteSourceOf(clipboardSize()) === 'nodes') { if (doPaste() > 0) e.preventDefault() }
        return
      }
      if (act === 'duplicate') { if (doDuplicate() > 0) e.preventDefault(); return }
      if (act === 'group') {
        /* 编组（契约 CE）。Ctrl+G 一键两用，与执行画布同一条规则：
         * 选中的已经在某个组里 → 解散；否则 → 编组。 */
        e.preventDefault()
        if (groupsOfSelection().length > 0) doUngroup()
        else doGroup()
        return
      }
      if (act === 'zoomIn') { e.preventDefault(); void flow.zoomIn({ duration: 150 }); return }
      if (act === 'zoomOut') { e.preventDefault(); void flow.zoomOut({ duration: 150 }); return }
      if (act === 'zoomReset') { e.preventDefault(); void flow.zoomTo(1, { duration: 150 }); return }
      /* ★ 票 61（2026-10-29）：**按住 Ctrl / Cmd 临时切左键功能**（用户戊 25：
       * 「空格和 ctrl 都可以临时切换左键功能」）。
       *
       * ## ⚠️ 2026-10-30（票 01）这里必须跟着默认值一起改
       *
       * 默认模式从 `'select'` 改成了 `'pan'`。这套逻辑原来写的是
       * 「按住 Ctrl → `setMode('pan')`」，那是**默认是框选**时才成立的语义
       * （按下切走、松开回来）。
       *
       * 默认变成移动之后，同一个写法会变成：**已经 pan 了又 setMode('pan')**
       * —— `panRestoreRef` 不会被赋值（`mode !== 'pan'` 那行不成立），
       * 于是松手时恢复不到任何东西，Ctrl 形同虚设。
       *
       * 所以这里改成**切换**：按 Ctrl 时切到「另一种模式」，松手回原来的。
       * 哪一种算「另一种」由当前模式决定 —— 默认 pan 时 Ctrl 给框选，
       * 用户手动切成 select 之后 Ctrl 给移动。**两种处境下都符合
       * 用户那句「临时切换左键功能」**。
       *
       * ## 为什么不改 `shortcutOf` 加一条
       *
       * 它在 `content-canvas-store.ts` 里，不在票 61 的可改路径。判定放这里一行够。
       *
       * ⚠️ 与空格那条**共用同一套闸**（`e.repeat` 直接 return、
       * 已经与恢复目标相同时不覆盖 restore）—— 票 35 那个真机 bug 的修法不能只护空格。 */
      const ctrlHold = (e.key === 'Control' || e.key === 'Meta')
        && !typingTarget(e.target)
      if (ctrlHold) {
        e.preventDefault()
        if (e.repeat === true) return
        /* 切到「另一种模式」：默认 pan → 给框选；已是 select → 给移动。 */
        const other: CanvasMode = mode === 'pan' ? 'select' : 'pan'
        if (mode !== other) panRestoreRef.current = mode
        setMode(other)
        return
      }
      if (act === 'panHold') {
        /* ★ 按住空格 = 临时切「抓手 / 平移」（用户 m02814）。
         *
         * `preventDefault` 是必须的：空格在浏览器里默认是「滚动页面」。
         * 不挡的话按住空格画面会往下滚，而画布本身并不滚，看着像卡住。
         *
         * 记下切之前的工具：松开时要**回到它**，不是一律回到「框选」。
         * 用户可能是先手动切成抓手、再按住空格拖一段 —— 松手后应该还是抓手。
         *
         * ## ⚠️ 「切不回去」的真因就在这里（票 35，2026-10-28 定位）
         *
         * 用户报：「按空格切换到了拖动的逻辑，然后就切不回去了」。
         *
         * **不是 React Flow 也在听空格**（怀疑点一，实测不成立：我们没有传
         * `panActivationKeyCode` / `selectionKeyCode`，用的是 `panOnDrag` 常驻属性）。
         * 真因是**键盘自动重复**：
         *
         *   1. 第一次 `keydown`：`panRestoreRef = 'select'`，`setMode('pan')`；
         *   2. 组件重渲染，这个 effect 的依赖里有 `mode`，于是**换了一份新闭包**，
         *      新闭包里的 `mode` 已经是 `'pan'`；
         *   3. 手还按着 → 浏览器每 ~30ms 再发一次 `keydown`（`e.repeat === true`）；
         *   4. 那一次走同一行，把 `panRestoreRef` **覆盖成 `'pan'`**；
         *   5. 松手 → `setMode('pan')` → **永远停在抓手**。
         *
         * 所以 ①②③ 都在，只有「按住的中间过程」被漏了 —— 单测只派一次
         * `keydown` + 一次 `keyup`，正好绕开这个循环，于是测试绿而真机坏。
         *
         * 修法两条一起（缺一条都不够）：
         *   · `e.repeat` 直接 return —— 自动重复不该改变状态；
         *   · 已经是 `'pan'` 时**不再覆盖** `panRestoreRef` —— 这是第二道闸，
         *     防的是「用户本来就在抓手态，按空格」那一路（那时也不该记成 pan）。 */
        e.preventDefault()
        if (e.repeat === true) return
        /* ★ 票 01（2026-10-30）：**默认是移动之后，空格给框选**。
         *
         * 原来这里是「按空格 → `setMode('pan')`」，那是「默认框选」时的语义。
         * 默认变成 pan 之后同样会落进「本来就 pan，按了也没变化」的死角 ——
         * 与上面 Ctrl 那条是同一个问题，改法也一样：按「另一种模式」。
         *
         * 用户那句「临时切换左键功能」在两种默认值下都成立：
         * 默认移动时按住空格 → 框选；用户手动切成框选后按住空格 → 移动。 */
        const other: CanvasMode = mode === 'pan' ? 'select' : 'pan'
        if (mode !== other) panRestoreRef.current = mode
        setMode(other)
        return
      }
    }
    /**
     * 松开空格 = 恢复。
     *
     * ⚠️ 必须单独听 `keyup`：`shortcutOf` 只看键、不看方向，
     * 而「按住」与「松开」是两个相反的动作（见 `CanvasAction` 里那对说明）。
     */
    const onKeyUp = (ev: KeyboardEvent): void => {
      /* ★ 票 61：Ctrl / Cmd 松开也算 —— 与上面那条 `ctrlHold` **成对**。
       * 只加按下不加松开，按住 Ctrl 就会切过去再也回不来
       * （与票 35「切不回去」同一形状）。 */
      const ctrlRelease = ev.key === 'Control' || ev.key === 'Meta'
      if (!ctrlRelease && !isPanReleaseKey({ key: ev.key, target: ev.target })) return
      const back = panRestoreRef.current
      if (back === null) return
      panRestoreRef.current = null
      setMode(back)
    }
    /**
     * 窗口失焦 = 当作松开（票 35 补的兜底）。
     *
     * ## 为什么必须有这一条
     *
     * 用户在按住空格的时候切走窗口（Alt+Tab、点别的应用），`keyup` **永远不会来** ——
     * 它就停在「抓手」态。切回来一看：画布拖不动框选了，也不知道为什么。
     * 这与上面那个自动重复是同一类问题：「按下」与「松开」之间隔着的所有意外。
     *
     * 恢复本身幂等（`panRestoreRef` 是 null 时直接 return），所以多调几次无害。
     */
    const onBlur = (): void => {
      const back = panRestoreRef.current
      if (back === null) return
      panRestoreRef.current = null
      setMode(back)
    }
    /* ★ 从系统剪贴板粘图（用户 m02814 #102）。挂在 window 上：
     * 粘贴事件的 target 是焦点元素，焦点可能在画布空白处（body）。
     *
     * ⚠️ 只在**内部缓冲区为空**时才处理 —— 有节点要粘的时候走 `onKey` 那条，
     * 两处都判 `pasteSourceOf`，谁先到都不会抢。 */
    const onPaste = (ev: ClipboardEvent): void => {
      if (pasteSourceOf(clipboardSize()) === 'nodes') return
      if (pasteFromSystem(ev)) ev.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('paste', onPaste)
    window.addEventListener('keyup', onKeyUp)
    /* 失焦当作松开（票 35）：Alt+Tab 走的时候 `keyup` 不会来。 */
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('paste', onPaste)
      window.removeEventListener('blur', onBlur)
    }
  }, [active, disarmDelete, disarmEdgeDelete, doUndo, doRedo, deleteSelected, deleteSelectedEdge, selectAll, doCopy, doPaste, doDuplicate, flow, mode, pasteFromSystem])

  /* ── React Flow 回调 ───────────────────────────────────────── */
  const onNodesChange = useCallback((changes: NodeChange<ContentFlowNode>[]): void => {
    /* ★ 票 62：锁定时丢掉「改尺寸」这一类变更（四条拦截里的第三条）。
     *
     * ⚠️ 必须在 `applyNodeChanges` **之前**过滤 —— 交给它之后再往回改等于
     * 先动了一下再撤回，中间那一帧用户看得见（四角手柄会跟着鼠标走）。
     *
     * 只丢 `dimensions`，**不丢别的**：`position` 那类由
     * `nodesDraggable={false}` 在上游拦掉，这里再拦一遍会和框选/多选的
     * 内部变更打架（那些也走 `position`）。 */
    const next = locked ? changes.filter(c => c.type !== 'dimensions') : changes
    setNodes(prev => applyNodeChanges(next, prev))
  }, [locked])

  const onEdgesChange = useCallback((changes: EdgeChange<Edge>[]): void => {
    setEdges(prev => applyEdgeChanges(changes, prev))
  }, [])

  const onConnect = useCallback((c: Connection): void => {
    record('connect')
    /* ★ 票 60：`type: 'content'` 让这条边走自定义边组件（命中区 + 选中态）。
     *
     * ⚠️ 这一项**不进存档**：`snapNow()` 只挑 `id/source/target/*Handle`
     * 四个字段（见那里），`type` 是渲染期的。老存档里的边没有 `type`，
     * 读回来时由下面的 `edgeTypes` + `defaultEdgeOptions` 兜住。 */
    setEdges(prev => addEdge({ ...c, id: 'e_' + Date.now().toString(36), type: 'content' }, prev))
  }, [record])

  const onMove = useCallback((_e: unknown, v: Viewport): void => {
    viewportRef.current = { x: v.x, y: v.y, zoom: v.zoom }
    setZoom(v.zoom)
    if (ready) autosaveRef.current.queue(snapRef.current())
  }, [ready])

  const onDragStart = useCallback((_e: unknown, node: { id: string }): void => {
    dragSnapRef.current = snapRef.current()
    /* 记下这次拖了哪些 —— 拖停之后要按它同步组归属（契约 CE）。
     * 参考项目在 `project.tsx:1657` 也是从「这次拖的初始选中集合」取。 */
    const picked = nodesRef.current.filter(n => n.selected === true).map(n => n.id)
    dragMovedRef.current = picked.includes(node.id) ? picked : [node.id]
    /* 换一次拖动，上一次的参考线不许留着（否则松手后线还挂在画布上）。 */
    setAlign(NO_ALIGN)
  }, [])

  /**
   * 拖动中：算对齐参考线（票 01）。
   *
   * ## 为什么在这里只算线、不改坐标
   *
   * Dify（`use-nodes-interactions.ts:282`）是拖动中直接把 `currentNode.position`
   * 改成目标坐标 —— 那样**拖不过去**：节点在阈值内被粘在线上，想微调 3px 挪不动。
   * 我们改成「拖动中只画线、松手才吸」，微调不被挡。
   *
   * ## 哪些节点不参与对齐
   *
   * `dragMovedRef` 里那些**正在一起移动的**要剔掉 —— 多选拖三个节点时，
   * 它们互相之间不该对齐（会一边拖一边互相吸，越拖越乱）。
   *
   * ## 关掉开关时
   *
   * `prefs.align` 为假就**一次都不调** `computeAlign`（不是调了再丢结果）——
   * 判据 3 的注入点就是这里：关掉开关后那个函数不该被走到。
   *
   * @param _e - 拖拽事件（用不上）。
   * @param node - 正在拖的那个节点（React Flow 给的是新坐标）。
   */
  const onDrag = useCallback((_e: unknown, node: ContentFlowNode): void => {
    if (!prefs.align) return
    const moving = toAlignBox(node)
    const movingIds = new Set(dragMovedRef.current.length > 0 ? dragMovedRef.current : [node.id])
    const others = nodesRef.current
      .filter(n => !movingIds.has(n.id))
      .map(toAlignBox)
    setAlign(computeAlign(moving, others))
  }, [prefs.align])

  const onDragStop = useCallback((_e: unknown, node?: ContentFlowNode): void => {
    const before = dragSnapRef.current
    dragSnapRef.current = null
    const moved = dragMovedRef.current
    dragMovedRef.current = []
    /* 松手：把刚才那条参考线落成真坐标（票 01）。
     *
     * ⚠️ 重新算一次 `computeAlign`，不读 `alignRef` —— 松手回调给的是**松手那一刻**
     * 的坐标，用旧的位移会有一个「最后一帧到松手之间」的时间差，差一两像素。
     *
     * 多选拖动（`moved.length > 1`）不吸附：三个节点各自吸到不同线，
     * 相对位置会被打散。单选拖动（最常见的那种）才吸。
     * `prefs.align` 为假时一次都不调 `computeAlign` —— 判据 3 的注入点就是这里。 */
    const solo = moved.length <= 1
    if (before === null) { setAlign(NO_ALIGN); return }
    histRef.current.record(before)
    setDepths(histRef.current.depths())
    if (prefs.align && solo && node !== undefined) {
      const moving = toAlignBox(node)
      const others = nodesRef.current.filter(n => n.id !== node.id).map(toAlignBox)
      const r = computeAlign(moving, others)
      if (r.dx !== 0 || r.dy !== 0) {
        const at = snappedPosition({ x: node.position.x, y: node.position.y }, r)
        setNodes(prev => prev.map(n => (n.id === node.id ? { ...n, position: at } : n)))
      }
    }
    setAlign(NO_ALIGN)
    /* 拖完同步组归属：拖进框的归入、拖出框的脱离（契约 CE，验收 3 / 4）。
     * ⚠️ 顺序要紧：先把吸附后的坐标写进去，再按**新坐标**算归属。
     * 反过来的话，吸上去那一小段位移不会参与「在不在框里」的判断。 */
    if (moved.length > 0) {
      setNodes(prev => {
        if (!prev.some(n => n.type === 'group')) return prev
        return syncGroupsAfterDrag(prev.map(fromFlow), moved).map(toFlow)
      })
    }
  }, [prefs.align])

  /* ── 右键菜单（照参考项目 `canvas-context-menu.tsx` 的三种上下文）── */
  const paneMenu = useCallback((e: React.MouseEvent | MouseEvent): void => {
    e.preventDefault()
    /* 空白处右键 = 换了个上下文，之前那个「等确认」作废。 */
    disarmDelete()
    const sel = nodes.filter(n => n.selected === true).length
    setMenu({
      x: e.clientX, y: e.clientY,
      title: '画布',
      entries: [
        { id: 'paste', icon: <ClipboardPasteIcon />, label: '粘贴', run: () => { doPaste() } },
        null,
        { id: 'selectAll', icon: <SelectAllIcon />, label: '全选', key: 'Ctrl+A', run: () => { selectAll() } },
        {
          id: 'fit',
          icon: <MaximizeIcon />,
          label: '适应画布',
          run: () => { void flow.fitView({ duration: 300 }) },
        },
        null,
        { id: 'addText', icon: <PlusIcon />, label: '加文本', run: () => { addNode('text') } },
        { id: 'addImage', icon: <PlusIcon />, label: '加图片', run: () => { addNode('image') } },
      ],
      ...(sel === 0 ? {} : {}),
    })
  }, [addNode, disarmDelete, doPaste, flow, nodes, selectAll])

  /**
   * 摊开节点右键菜单（`pendingDel` 决定「删除节点」那一项显示成什么）。
   *
   * ## 为什么单独一个函数（票 03）
   *
   * 「连点两次才删」要求第一次点击之后**菜单还在、只是那一项变了**。
   * `ContextMenu` 的点击顺序是先 `onClose()` 再 `run()`（见 `ContextMenu.tsx:134-138`），
   * 所以第一次点击之后由这里**把菜单重新摊开一次**，带着「确认删除」那一项。
   * 两处（右键开菜单 / 第一次点击后重开 / 3 秒超时退回）用同一份菜单内容，
   * 才不会有一处漏改。
   *
   * @param at - 摆放坐标（屏幕坐标）。数组对象而不是事件，因为超时那条路手里
   *   只有坐标、没有当时的那个事件对象。
   * @param node - 右键点在哪个节点上。
   * @param pendingDel - 这一项是不是已经点过一次、正在等第二次。
   */
  const buildNodeMenu = useCallback((
    at: { clientX: number, clientY: number },
    node: ContentFlowNode,
    pendingDel: boolean,
  ): void => {
    const selIds = nodes.filter(n => n.selected === true).map(n => n.id)
    const ids = selIds.includes(node.id) ? selIds : [node.id]
    const many = ids.length >= 2
    const isGroup = node.type === 'group'
    const hasGroupParent = (node.data.groupId ?? '') !== ''
    setMenu({
      x: at.clientX, y: at.clientY,
      title: nodeLabel(fromFlow(node)),
      entries: [
        {
          id: 'copy', icon: <CopyIcon />, label: '复制节点', key: 'Ctrl+C',
          run: () => { copyNodes(nodes.filter(n => ids.includes(n.id)).map(fromFlow)) },
        },
        {
          /* ★ 删除要连点两次才真删（票 03，照排期板块 `ScheduleBoard.tsx:179` 的做法）。
           *
           * 为什么不用 `window.confirm`：Electron 桌面端**可能不可用**
           * （`window.prompt` 就是这样，见 `WorkflowList.tsx` 里那个真 bug），
           * 弹框在桌面端与浏览器里表现不一致。连点两次两边完全一样。
           *
           * 第一次点击：只把这一项换成「确认删除」，节点一个都不动。
           * 三秒内再点一次才真删；超时自动退回「删除节点」。 */
          id: 'del',
          icon: <XIcon />,
          label: pendingDel ? '确认删除' : '删除节点',
          key: pendingDel ? '再点一次' : 'Delete',
          danger: true,
          run: () => {
            if (!pendingDel) {
              /* 第一下：只换文案，节点一个不动，并起 3 秒的退回计时。 */
              armDeleteConfirm(at, node)
              buildNodeMenu(at, node, true)
              return
            }
            /* ★ 票 62：锁着时**在第一下就拦住**，别让用户点两次才发现删不掉。
             *
             * 为什么放在这里是安全的：这一支在 `pendingDel` 之后，
             * 而第一下只换文案、不动节点 —— 锁着时连文案都不该换。 */
            if (locked) {
              disarmDelete()
              setErr('画布已锁定，先解锁才能删除')
              return
            }
            /* 第二下：真删。这三行与改之前**一字不差**（删除语义不动）。 */
            disarmDelete()
            record('delete')
            setNodes(prev => prev.filter(n => !ids.includes(n.id)))
            setEdges(prev => prev.filter(x => !ids.includes(x.source) && !ids.includes(x.target)))
          },
        },
        null,
        /* 编组（契约 CE）：与参考项目 `canvas-context-menu.tsx:71-79` 同一组菜单项。
         *
         * ⚠️ 三项**始终显示、不适用时置灰**，不按上下文增减。
         * 参考项目是「有就渲染」（`isGroupNode ? [...] : null`），我们这边的既有测试
         * （`tests/content-canvas.mjs` 验收 4）钉的是「右键菜单里能看到这三项」——
         * 增减会让菜单长度跳变、也让用户找不到「为什么这次没有取消分组」。
         * 置灰还能说明「这一项存在，但当前不适用」。 */
        {
          id: 'group', icon: <GroupIcon />, label: '分组', key: 'Ctrl+G',
          run: () => { doGroup() },
          disabled: !many,
        },
        {
          id: 'ungroup', icon: <UngroupIcon />, label: '取消分组',
          run: () => { doUngroup() },
          disabled: !isGroup && !hasGroupParent,
        },
        {
          id: 'groupAll', icon: <BoxSelectIcon />, label: '选中组内全部成员',
          run: () => { selectGroupChildren(node.id) },
          disabled: !isGroup,
        },
        ...(isGroup
          ? ([
            { id: 'capture', icon: <MinimizeIcon />, label: '收纳框内的节点', run: () => { doCapture(node.id) } },
            { id: 'fitGroup', icon: <MaximizeIcon />, label: '适应成员', run: () => { doFitGroup(node.id) } },
          ])
          : []),
        null,
        {
          id: 'fit', icon: <MaximizeIcon />, label: '适应画布',
          run: () => { void flow.fitView({ duration: 300 }) },
        },
      ],
    })
  }, [doCapture, doFitGroup, doGroup, doUngroup, flow, nodes, record, selectGroupChildren])

  /* 3 秒超时要能重摊菜单 —— 把刚定义好的那个函数挂上去。
   * 与 `nodesRef.current = nodes` 同一个用法：渲染期赋一个最新引用给 ref。 */
  rebuildMenuRef.current = buildNodeMenu

  /**
   * 在节点上右键：摊开菜单。
   *
   * ⚠️ 每次重开都从「删除节点」这个初始文案开始（不是接着等第二次确认）——
   * 用户换了目标节点、或隔了一会儿又来右键，都不该继承上一次的待确认状态。
   *
   * @param e - 右键事件。
   * @param node - 右键点在哪个节点上。
   */
  const nodeMenu = useCallback((e: React.MouseEvent, node: ContentFlowNode): void => {
    e.preventDefault()
    disarmDelete()
    buildNodeMenu({ clientX: e.clientX, clientY: e.clientY }, node, false)
  }, [buildNodeMenu, disarmDelete])

  /* ── 生成链路（契约 CH）────────────────────────────────────────── */

  /**
   * 某个节点要生成「什么」（从节点类型 / 配置节点上的 `genType` 推）。
   * @param n - 存盘形状的节点。
   * @returns 生成种类。
   */
  const genKindOf = (n: ContentNode): GenKind => {
    if (n.type === 'config') return n.data.genType ?? 'image'
    if (n.type === 'video') return 'video'
    if (n.type === 'audio') return 'audio'
    /* 文本节点不生成内容 —— 它的正文是用户写的。但面板上有「生成」那一格
     * （用模型润色），所以按 `text` 走，后端认这一档。 */
    if (n.type === 'text') return 'text'
    return 'image'
  }

  /**
   * 这个节点要哪几类模型（票 70）。
   *
   * ## 图片档要同时要文生图与图生图（**不替用户二选一**）
   *
   * 配置节点的 `genType` 只有 `image` / `video` 两档，而它到底走文生图还是图生图
   * **取决于这次带不带参考图** —— 那是在点「生成」那一刻才从 `preset` 与 `@提及`
   * 合并出来的（`doGenerate` 里那句 `mergeRefs`），节点上没有任何静态字段能提前判断。
   *
   * 所以两类的模型都列，界面上用标签区分。挑错时后端 `generate.ts` 的 `caps`
   * 校验会拦住并说清缺什么能力 —— 那比「下拉里干脆没有」好查。
   *
   * ## 兜底说明用的那句话（与 `modelsFor` 配成一对）
   *
   * 只在一类都没要时为空（目前不存在这种节点）。
   */
  const typesOf = (n: ContentNode): string[] => {
    const kind = genKindOf(n)
    if (kind === 'image') return ['t2i', 'i2i']
    return [kind]
  }

  /**
   * 这个节点可选的那批模型（票 70）。
   *
   * ## ⚠️ 判据**只有这一份**
   *
   * `modelsFor` 与 `modelsFallbackNote` 都要知道「按类型筛剩下几条」。
   * 一开始我在这两处各写了一遍 `filter(...)` —— 改坏一处另一处仍然对，
   * 断言就测不出问题（自证时发现的：把 `modelsFor` 的过滤删掉，测试全绿）。
   *
   * 所以收成一个函数，返回两样东西：筛出来的清单，以及「是不是退回了全部」。
   *
   * @param n - 存盘形状的节点。
   * @returns `hit`（按类型筛到的）与 `want`（这次要哪几类）。
   */
  const pickModels = useCallback((n: ContentNode): { hit: GenModelOption[], want: string[] } => {
    const want = typesOf(n)
    const all = genModels ?? []
    /* 按 `m.types` 筛，不按 `m.caps` —— 理由见 `content-canvas-store.ts` 的
     * `GenModelOption.types`：`caps` 分不出文生图与图生图，而那个推导属于宿主半。
     * 一条模型能同时命中两类（`caps` 有 `image` 的同时算文生图与图生图），
     * 所以是 `some` 不是「等于」。 */
    return { hit: all.filter(m => m.types.some(t => want.includes(t))), want }
  }, [genModels])

  /** 能用的模型里，属于这个节点那一档的那些。 */
  const modelsFor = useCallback((n: ContentNode): GenModelOption[] => {
    const { hit } = pickModels(n)
    const all = genModels ?? []
    /* 能力没登记的模型也别藏起来 —— 用户手上有的是渠道，藏了只会让人以为配错了。
     * 后端提交时会给出「这个模型没有 X 能力」的明确错误，比「下拉里没有」好查。
     *
     * ⚠️ 兜底生效时**必须说明**（票 70 验收）：不说的话用户看到一列包含视频模型的
     * 清单，会以为过滤坏了 —— 而不是「这一类没有登记任何模型」。 */
    return hit.length > 0 ? hit : all
  }, [pickModels, genModels])

  /**
   * 兜底生效时要显示的那句话（票 70）。
   *
   * 只在「按类型一条都没筛到、退回全部」时出现；正常过滤时是空串
   * （有断言钉住「正常时不许出现」）。
   */
  const modelsFallbackNote = useCallback((n: ContentNode): string => {
    const all = genModels ?? []
    if (all.length === 0) return ''
    const { hit, want } = pickModels(n)
    if (hit.length > 0) return ''
    const label = want.map(t => MODEL_TYPE_LABEL[t] ?? t).join(' / ')
    return '清单里没有登记为「' + label + '」的模型，下面是全部模型'
  }, [pickModels, genModels])

  /** 能不能点生成：查回来非空就算能（查没查回来与查回来是空，文案不一样）。 */
  const canGenerate = (genModels?.length ?? 0) > 0

  /** 不能生成时那句文案（验收 1：说清为什么）。 */
  const generateHint = genModelErr !== ''
    ? '查不到可用模型：' + genModelErr
    : genModels === null
      ? '正在查可用模型…'
      : '还没有配任何能做生成的模型。先去「配置」格配一条渠道、登记一个模型。'

  /* 挂载时查一次模型清单。 */
  useEffect(() => {
    let alive = true
    void (async () => {
      const r = await listGenModels()
      if (!alive) return
      if (!r.ok) { setGenModelErr(r.error ?? '查不到可用模型'); setGenModels([]); return }
      setGenModelErr('')
      setGenModels(r.data ?? [])
    })()
    return () => { alive = false }
  }, [])

  /* ── 参考图候选（契约 CJ）───────────────────────────────────────
   *
   * ## 为什么是「点了才拉」而不是挂载时拉
   *
   * `/materials` 是一次磁盘目录读。每个画布、每开一次面板都拉一次，纯白花；
   * 而绝大多数节点根本不用参考图。所以 `onLoadRefChoices` 由面板在
   * 用户点「选择参考图」时触发，这里只负责拉一次并缓存。
   */
  const [refMats, setRefMats] = useState<readonly { name: string, url: string }[]>([])
  const [refLoaded, setRefLoaded] = useState(false)
  /**
   * 拉一次素材目录（已拉过就不重复拉）。
   */
  const loadRefChoices = useCallback((): void => {
    if (refLoaded) return
    setRefLoaded(true)
    void (async () => {
      /* 复用侧栏那条数据源（`GET /materials`，走 store 里的 `listMaterials`），
       * 不另写一份路由 —— 两份数据源迟早漂。 */
      const r = await listMaterials()
      if (!r.ok) return
      setRefMats(r.data ?? [])
    })()
  }, [refLoaded])
  /**
   * 候选 = 素材库 + 画布上**已有产物**的节点。
   *
   * 画画上那几个是「从画布直接串起来」用的（用户 m01076 那条：图节点上已有产物时
   * 也能当参考图），不必先去素材库存一遍。
   */
  const refChoices = useMemo<RefChoice[]>(() => {
    const fromMats = refMats.map(refFromMaterial)
    const fromNodes = nodes
      .map(n => refFromNode(fromFlow(n)))
      .filter((c): c is RefChoice => c !== null)
    /* 同一个 id 只留一条（例如某张图既在素材库、又挂在画布上）。 */
    const seen = new Set<string>()
    const out: RefChoice[] = []
    for (const c of [...fromMats, ...fromNodes]) {
      if (seen.has(c.id)) continue
      seen.add(c.id)
      out.push(c)
    }
    return out
  }, [refMats, nodes])

  /** 改一个节点的运行态。 */
  const setRun = useCallback((id: string, next: NodeRunState): void => {
    setRuns(prev => {
      if (next.kind === 'idle') {
        if (prev[id] === undefined) return prev
        const cp = { ...prev }
        delete cp[id]
        return cp
      }
      return { ...prev, [id]: next }
    })
  }, [])

  /**
   * 轮询一个任务直到它结束。
   *
   * 间隔照参考项目量级（1 秒）；连续失败 3 次就停 —— 网络断了还一直打
   * 只会把日志刷满，而用户看到的是「一直转圈」。
   *
   * @param nodeId - 哪个节点在等。
   * @param taskId - 任务 id。
   * @param req - 这次提交用的参数（失败重试要原样再用一次）。
   */
  const pollTask = useCallback((nodeId: string, taskId: string, req: SubmitGenInput): void => {
    let misses = 0
    const tick = async (): Promise<void> => {
      const r = await getGenTask(taskId)
      if (!r.ok || r.data === undefined) {
        misses += 1
        if (misses >= 3) {
          setRun(nodeId, { kind: 'failed', error: '查不到任务进度：' + (r.error ?? '未知原因'), retry: req })
          return
        }
        timer = setTimeout(() => { void tick() }, 1000)
        return
      }
      const t = r.data
      misses = 0
      if (t.status === 'success') {
        /* ★ 反推提示词（用户 m02814 #63，判据 4）：结果**填进 `data.prompt`**。
         *
         * ⚠️ 不是 `data.text` —— 那是这个节点的**产出**，而反推出来的提示词
         * 是他下一步要拿去生成的**输入**。填错地方的表现是：提示词框还是空的，
         * 产出区多了一段字，下次生成用旧提示词（不报错，很难发现）。
         *
         * ⚠️ 而且结果**不在 `task.text` 里** —— 后端把文本产出也存成产物
         * （`generate.ts:512`，mime = `text/plain`），所以要先按 mime 找到那个产物、
         * 把字节取回来读成文本。判据由 `op-specs.ts` 的 `resultFieldOf` 钉住。 */
        if (captionNodeRef.current === nodeId) {
          captionNodeRef.current = ''
          const textArt = t.artifacts.find(a => a.mime.startsWith('text/'))
          if (textArt === undefined) {
            setRun(nodeId, { kind: 'failed', error: '反推没有交出文字产物', retry: req })
            return
          }
          void (async () => {
            let text = ''
            try {
              const res = await fetch(artifactHref(textArt.id))
              text = res.ok ? (await res.text()).trim() : ''
            } catch { text = '' }
            if (text === '') {
              setRun(nodeId, { kind: 'failed', error: '反推的文字取不回来', retry: req })
              return
            }
            setNodes(prev => prev.map(n => (
              n.id !== nodeId ? n : { ...n, data: { ...n.data, prompt: text } }
            )))
            /* 提示词改了要落盘（与设置面板里改提示词同一条路）。 */
            autosaveRef.current.queue(snapRef.current())
            setRun(nodeId, { kind: 'idle' })
          })()
          return
        }
        /* ★ 落位**走现成的纯函数**（`placeResult`：空的填自己、有内容长右边）。
         * 不另写一份 —— 那条规则被单独验过（`tests/content-canvas.mjs` ① 段）。 */
        const art = t.artifacts[0]
        if (art === undefined) {
          setRun(nodeId, { kind: 'failed', error: '任务成功了，但没交出产物', retry: req })
          return
        }
        /* ★ 一次生成多张 → 落成**一个批量节点**（用户 m02814 #72-74）。
         *
         * 为什么不是「走 placeResult 放第一张、其余散着长」：4 张散成 4 个节点
         * 会把链路挤散，而用户心里它们是同一批（同一份提示词、同一次提交）。
         *
         * 只出 1 张时**仍然走 placeResult** —— 那时候批量节点是多余的
         * （一个只装一张的批量节点，展开态和收起态看起来一样）。 */
        const all = t.artifacts.map(a => a.id)
        if (all.length > 1) {
          setNodes(prev => {
            const list = prev.map(fromFlow)
            const anchor = list.find(n => n.id === nodeId)
            if (anchor === undefined) return prev
            /* 落点：锚点右边（与 `placeResult` 的 right 那一支同一个间距口径）。 */
            const size = sizeOf(anchor)
            const batch = newNode('batch', {
              x: anchor.position.x + size.width + RESULT_GAP,
              y: anchor.position.y,
            }, { items: all, mainIndex: 0, prompt: '' })
            return [...list, batch].map(toFlow)
          })
          setRun(nodeId, { kind: 'idle' })
          return
        }
        setNodes(prev => {
          const out = placeResult(prev.map(fromFlow), nodeId, { artifact: art.id })
          return out.placed === 'none' ? prev : out.nodes.map(toFlow)
        })
        setRun(nodeId, { kind: 'idle' })
        return
      }
      if (t.status === 'failed') {
        setRun(nodeId, { kind: 'failed', error: t.error ?? '生成失败（宿主半没给原因）', retry: req })
        return
      }
      /* 还在跑：把后端算的「已等多久」带回来显示（前端不计时）。 */
      setRun(nodeId, { kind: 'running', taskId, waitedMs: t.waitedMs })
      timer = setTimeout(() => { void tick() }, 1000)
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    pollTimers.current[nodeId] = () => { if (timer !== null) clearTimeout(timer) }
    void tick()
  }, [setRun])

  /** 每个节点在跑的轮询器（换任务 / 取消时要把它停掉）。 */
  const pollTimers = useRef<Record<string, () => void>>({})

  /**
   * 提交一次生成（点面板上的「生成」、或点失败态上的「重试」都走这里）。
   *
   * ## ★ 提交前必须解析 @ 提及（用户 m02814 补漏）
   *
   * 用户插进提示词的是 `@[参考主图](m2)` 这种**标记**，模型看不懂它，
   * 而被引用的那张图也不会自己进 `refs`。所以这里要：
   *   1. 把标记换成被引用节点的**内容**（文本给正文、图给产物）；
   *   2. 图 / 视频 / 音频引出来的产物 id 取回**字节**追加进 `refs`。
   *
   * ⚠️ **`retry` 那条路不解析第二遍**：`run.retry` 里存的 `req` 是**已经解析过**的
   * （prompt 里是正文、refs 里是字节）。再解析一遍虽然匹配不到（标记已被换掉），
   * 但如果正文里恰好有一句 `@[x](n1)` 就会被二次替换 —— 所以直接跳过。
   *
   * @param nodeId - 哪个节点。
   * @param retry - 重试时用上一次的参数（不给就按节点当前设置现算）。
   */
  const doGenerate = useCallback((nodeId: string, preset?: SubmitGenInput, mode: 'fresh' | 'retry' = 'fresh'): void => {
    const n = nodes.find(x => x.id === nodeId)
    if (n === undefined) return
    const cur = fromFlow(n)
    if (mode === 'retry' && preset !== undefined) {
      /* 重试：原样重发（见上面那条 ⚠️，**不再解析**）。 */
      const prev = preset
      if (prev.prompt.trim() === '') { setErr('提示词是空的，先填再生成'); return }
      /* ⚠️ **不再挡「没选模型」**（用户 m03555）：
       * 模型的三层规则在后端（指定 → 默认 → 报错并指路）。
       * 界面在这里先拦一道的话，用户的“默认模型”配置就永远派不上用场。 */
      setErr('')
      setRun(nodeId, { kind: 'running', taskId: '', waitedMs: 0 })
      void (async () => {
        const r = await submitGen(prev)
        if (!r.ok || r.data === undefined) {
          setRun(nodeId, { kind: 'failed', error: r.error ?? '提交失败', retry: prev })
          return
        }
        setRun(nodeId, { kind: 'running', taskId: r.data.id, waitedMs: 0 })
        pollTask(nodeId, r.data.id, prev)
      })()
      return
    }
    const rawPrompt = (cur.data.prompt ?? '').trim()
    const model = (cur.data.model ?? '').trim()
    if (rawPrompt === '') { setErr('提示词是空的，先填再生成'); return }
    setErr('')
    setRun(nodeId, { kind: 'running', taskId: '', waitedMs: 0 })
    void (async () => {
      /* ① 解析 @ 提及。`lookup` 按节点类型给内容（映射在 store 里，有单独判据）。 */
      const resolved = resolveMentions(rawPrompt, (id) => {
        const target = nodes.find(x => x.id === id)
        if (target === undefined) return undefined
        const t = mentionTargetOf(fromFlow(target))
        /* `other` 类型要让后端按「找不到」处理，所以回 `undefined`。 */
        return t.kind === 'other' ? undefined : t
      })
      /* ② @ 出来的图要变成字节追加进 refs。
       *
       * ⚠️ 2026-10-29（票 71）：label 传「参考图」—— 原先走 `artifactBase64`，
       * 取不回时说的是「取不回底图」。这取的明明是 @ 提及的参考图，不是底图，
       * 用户看到那句话会去找错的东西。 */
      const mentioned: { mime: string, base64: string }[] = []
      for (const artId of resolved.refs) {
        const b = await refBase64(artId, '参考图')
        if (b.ok && b.data !== undefined) mentioned.push(b.data)
      }
      /* ③ 节点上选的那张参考图 / 首帧（票 71 补上的一段）。
       *
       * ## 这里原来漏了一整条
       *
       * 设置面板里「参考图」那一格早就能选、能显示缩略图，但**生成时一次都没读过**它。
       * 用户看着缩略图以为这次会用那张图，结果出来一张与它无关的图 ——
       * 不报错、不提示，只是结果不对。
       *
       * ## 位置：preset.refs 之后、@ 提及之前
       *
       * 底图（`preset.refs[0]`）仍排第一：后端把 `refs[0]` 当要处理的那张。
       * 而用户**显式选的那张**比 @ 提及更明确，所以排在 mentioned 前面。
       *
       * ## ⚠️ 取不回就停下报错，不许静默跳过
       *
       * 跳过一张的后果是「结果与参考图无关」—— 正是这票要消灭的症状。
       * 报错要点名是哪一张、试过哪条路（`refBase64` 里已经这么说）。 */
      const picked: { mime: string, base64: string }[] = []
      const pickedRef = (cur.data.reference ?? '').trim()
      if (pickedRef !== '') {
        const one = await refBase64(pickedRef, cur.type === 'video' ? '首帧' : '参考图')
        if (!one.ok || one.data === undefined) {
          setErr(one.error ?? '取不回这张参考图')
          setRun(nodeId, { kind: 'idle' })
          return
        }
        picked.push(one.data)
      }
      /* ④ 三段合并：底图 → 节点选的 → @ 提及（判据 4 的顺序）。 */
      /* 底图（`inpaint` / 放大那条路带来的）永远排第一：后端把 `refs[0]`
       * 当要处理的那张，被 @ 出来的参考图排到前面就会处理错对象。 */
      const refs = mergeRefs([...(preset?.refs ?? []), ...picked], mentioned)
      /* `preset` 里别的字段（`op` / 底图 / 模型 / 渠道）优先于节点当前设置 ——
       * 放大、局部重绘那两条路是**算好了参数**才进来的。 */
      const req: SubmitGenInput = {
        ...preset ?? {},
        kind: preset?.kind ?? genKindOf(cur),
        /* ★ prompt 用**解析后**的（判据 1 / 2 / 5）。 */
        prompt: resolved.prompt,
        /* 没选就**不给这个字段**，交给后端按默认模型解析。 */
        ...(preset?.model ?? model) === '' ? {} : { model: preset?.model ?? model },
        ...(preset?.channelId ?? cur.data.channel ?? '') === '' ? {} : { channelId: preset?.channelId ?? cur.data.channel },
        ...(preset?.size ?? cur.data.size ?? '') === '' ? {} : { size: preset?.size ?? cur.data.size },
        ...(preset?.count ?? cur.data.count) === undefined ? {} : { count: preset?.count ?? cur.data.count },
        ...(preset?.seconds ?? cur.data.seconds) === undefined ? {} : { seconds: preset?.seconds ?? cur.data.seconds },
        ...refs.length === 0 ? {} : { refs },
        source: 'canvas',
        canvasId,
        canvasNodeId: nodeId,
      }
      /* ④ `missing` 非空要提示（不许静默）：那个节点的名字还在提示词里，
       * 但引用不到内容 —— 用户会以为它生效了。 */
      if (resolved.missing.length > 0) {
        setErr('这些引用找不到（节点可能已被删），提示词里保留了原文：' + resolved.missing.join('、'))
      }
      const r = await submitGen(req)
      if (!r.ok || r.data === undefined) {
        setRun(nodeId, { kind: 'failed', error: r.error ?? '提交失败', retry: req })
        return
      }
      setRun(nodeId, { kind: 'running', taskId: r.data.id, waitedMs: 0 })
      pollTask(nodeId, r.data.id, req)
    })()
  }, [canvasId, nodes, pollTask, setRun])

  /** 取消一个节点的生成（验收 7）。 */
  const doCancel = useCallback((nodeId: string): void => {
    const run = runs[nodeId]
    if (run === undefined || run.kind !== 'running' || run.taskId === '') return
    pollTimers.current[nodeId]?.()
    delete pollTimers.current[nodeId]
    const taskId = run.taskId
    setRun(nodeId, { kind: 'idle' })
    void cancelGen(taskId)
  }, [runs, setRun])

  /* ── 图像操作：裁剪 / 拆图 / 抓帧（用户 m02814）───────────────────
   *
   * ## 像素在哪做、为什么不能在这里测
   *
   * 这三件事的「算」全在 `lib/canvas/image-ops.ts`（纯函数、`tests/image-ops.mjs`
   * 逐条验过）；这里只做**最后那一步像素活**：把 `<img>` / `<video>` 画到
   * `<canvas>` 上、`getImageData`、`toDataURL`、上传成新产物。
   *
   * ⚠️ 那一步**在 jsdom 里跑不了**（`getContext('2d')` 返回 `null`），
   * 所以自动化只能验「算得对」，验不了「图画得对」。交付里单独列出这一点。
   */

  /**
   * 能被 @ 的候选节点（用户 m02814 #76）。
   *
   * 只收 `mentionableType` 认的那几种；名字取「用户起的名字，没起就用类型名」。
   */
  const mentionCandidates = useMemo<MentionCandidate[]>(
    () => nodes
      .map(fromFlow)
      .filter(n => mentionableType(n.type))
      .map(n => {
        /* ⚠️ 显示名可能在三处之一（这个项目里它们同时存在，别只读一处）：
         *   · `n.title` —— 存档里节点顶层的字段（`renameNode` 写的是这里）；
         *   · `n.data.title` —— 画布上的 React Flow 节点（`onRename` 写的是这里）；
         *   · 两处都没有 → 用类型名。
         *
         * 第一版只读 `n.title`，而画布上的节点名字在 `data.title` 里，
         * 于是候选全显示成「文本 / 图片」这种类型名（当场红了 3 条）。 */
        const fromTop = typeof n.title === 'string' ? n.title.trim() : ''
        const fromData = typeof n.data.title === 'string' ? n.data.title.trim() : ''
        return {
          id: n.id,
          name: fromTop !== '' ? fromTop : (fromData !== '' ? fromData : TYPE_LABEL[n.type]),
          type: n.type,
        }
      }),
    [nodes],
  )

  /** 当前浮层对应的节点（拿元素、拿尺寸都要它）。 */
  const imageOpNode = imageOp === null ? null : (nodes.find(n => n.id === imageOp.id) ?? null)

  /**
   * 一个产物 id 的原图尺寸（图 / 视频都行）。
   *
   * @returns 宽高；拿不到给 `undefined`（浮层会说「原图尺寸未知」）。
   */
  const [opImage, setOpImage] = useState<{ width: number, height: number } | null>(null)
  useEffect(() => {
    setOpImage(null)
    if (imageOpNode === null) return
    const art = (fromFlow(imageOpNode).data.artifact ?? '').trim()
    if (art === '') return
    let alive = true
    const el = window.document.createElement(imageOpNode.type === 'video' ? 'video' : 'img')
    const done = (): void => {
      if (!alive) return
      const w = el instanceof window.HTMLVideoElement ? el.videoWidth : (el as HTMLImageElement).naturalWidth
      const h = el instanceof window.HTMLVideoElement ? el.videoHeight : (el as HTMLImageElement).naturalHeight
      /* 宽高为 0 = 还没解出来（jsdom 里永远 0）→ 保持 null，浮层会说明。 */
      if (w > 0 && h > 0) setOpImage({ width: w, height: h })
    }
    el.addEventListener('load', done)
    el.addEventListener('loadedmetadata', done)
    el.src = artifactHref(art)
    return () => { alive = false }
  }, [imageOpNode])

  /**
   * 把画布上的像素存成新产物，并用 `placeResult` 落位。
   *
   * @param nodeId - 从哪个节点加工出来的（落位锚点）。
   * @param blob - 结果（PNG）。
   * @returns 无（失败会写 `err`）。
   */
  const saveOpResult = useCallback(async (nodeId: string, blob: Blob | null): Promise<void> => {
    if (blob === null) { setErr('画布导出失败（浏览器没给出图像数据）'); return }
    const buf = new Uint8Array(await blob.arrayBuffer())
    const up = await uploadArtifact(bytesToBase64(buf), 'image/png', 'png')
    if (!up.ok || up.data === undefined) { setErr(up.error ?? '存成产物失败'); return }
    setErr('')
    /* 落位走现成规则：空的填自己、有内容长右边（与生成结果同一条）。 */
    setNodes(prev => {
      const out = placeResult(prev.map(fromFlow), nodeId, { artifact: up.data })
      return out.placed === 'none' ? prev : out.nodes.map(toFlow)
    })
    setImageOp(null)
  }, [setErr])

  /**
   * 裁剪：按归一化矩形从原图取一块。
   *
   * @param rect - 归一化矩形（浮层给的）。
   * @returns 无。
   */
  const doCrop = useCallback((rect: CropRect): void => {
    if (imageOpNode === null) return
    const art = (fromFlow(imageOpNode).data.artifact ?? '').trim()
    if (art === '') { setErr('这个节点还没有图，没东西可裁'); return }
    const img = new window.Image()
    img.onload = (): void => {
      const pr = cropPixelRect(rect, img.naturalWidth, img.naturalHeight)
      const cv = window.document.createElement('canvas')
      cv.width = pr.width
      cv.height = pr.height
      const ctx = cv.getContext('2d')
      /* jsdom / 老浏览器可能给 null —— 当场说清，不许静默。 */
      if (ctx === null) { setErr('这个环境不支持画布取像素（拿不到 2d 上下文）'); return }
      ctx.drawImage(img, pr.x, pr.y, pr.width, pr.height, 0, 0, pr.width, pr.height)
      cv.toBlob((b) => { void saveOpResult(imageOpNode.id, b) }, 'image/png')
    }
    img.onerror = (): void => { setErr('原图取不回来，无法裁剪') }
    img.src = artifactHref(art)
  }, [imageOpNode, saveOpResult, setErr])

  /**
   * 拆图：按行 × 列切，每块存一个产物，排成一组。
   *
   * @param rows - 行数。
   * @param cols - 列数。
   * @returns 无。
   */
  const doSplit = useCallback((rows: number, cols: number): void => {
    if (imageOpNode === null) return
    const art = (fromFlow(imageOpNode).data.artifact ?? '').trim()
    if (art === '') { setErr('这个节点还没有图，没东西可拆'); return }
    const img = new window.Image()
    img.onload = (): void => {
      const pieces = splitRects(img.naturalWidth, img.naturalHeight, rows, cols)
      void (async () => {
        const ids: string[] = []
        for (const p of pieces) {
          const pr = cropPixelRect(p, img.naturalWidth, img.naturalHeight)
          const cv = window.document.createElement('canvas')
          cv.width = pr.width
          cv.height = pr.height
          const ctx = cv.getContext('2d')
          if (ctx === null) { setErr('这个环境不支持画布取像素（拿不到 2d 上下文）'); return }
          ctx.drawImage(img, pr.x, pr.y, pr.width, pr.height, 0, 0, pr.width, pr.height)
          const blob = await new Promise<Blob | null>(res => { cv.toBlob(b => { res(b) }, 'image/png') })
          if (blob === null) { setErr('切出的第 ' + String(ids.length + 1) + ' 块导出失败'); return }
          const buf = new Uint8Array(await blob.arrayBuffer())
          const up = await uploadArtifact(bytesToBase64(buf), 'image/png', 'png')
          if (!up.ok || up.data === undefined) {
            setErr(up.error ?? '切出的第 ' + String(ids.length + 1) + ' 块存失败')
            return
          }
          ids.push(up.data)
        }
        if (ids.length === 0) { setErr('一块都没切出来'); return }
        /* 排成一组：新节点从原节点右边开始，按行排（每行 cols 个）。 */
        setNodes((prev) => {
          let list = prev.map(fromFlow)
          const base = sizeOf(fromFlow(imageOpNode))
          let groupId = ''
          ids.forEach((id, i) => {
            const r = Math.floor(i / cols)
            const c = i % cols
            const n = newNode('image', {
              x: imageOpNode.position.x + c * (base.width + 24),
              y: imageOpNode.position.y + r * (base.height + 24) + base.height + 40,
            }, { artifact: id, prompt: '' })
            list = [...list, n]
            if (i === 0) {
              /* 第一块就建组：`groupNodes` 会把组排最前、并把这几块挂进去。 */
              const g = groupNodes([...list], [n.id], '拆图 ' + String(rows) + '×' + String(cols))
              list = g.nodes
              groupId = g.groupId
            } else if (groupId !== '') {
              list = list.map(x => (x.id === n.id ? { ...x, data: { ...x.data, groupId } } : x))
            }
          })
          return list.map(toFlow)
        })
        setErr('')
        setImageOp(null)
      })()
    }
    img.onerror = (): void => { setErr('原图取不回来，无法拆图') }
    img.src = artifactHref(art)
  }, [imageOpNode, setErr])

  /**
   * 抓帧：把 `<video>` 某一时刻的画面存成新产物。
   *
   * @param which - 首帧 / 尾帧 / 当前帧。
   * @returns 无。
   */
  const doFrame = useCallback((which: 'first' | 'last' | 'current'): void => {
    if (imageOpNode === null) return
    const art = (fromFlow(imageOpNode).data.artifact ?? '').trim()
    if (art === '') { setErr('这个节点还没有视频，没东西可抓'); return }
    const v = window.document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.onerror = (): void => { setErr('视频取不回来，无法抓帧') }
    v.onloadeddata = (): void => {
      const t = frameTimeOf(v.duration, which, v.currentTime)
      v.currentTime = t
      /* 设完 currentTime 要等 `seeked` —— 立刻画会画到上一帧（视频还没解到目标位置）。 */
      v.onseeked = (): void => {
        const cv = window.document.createElement('canvas')
        cv.width = v.videoWidth
        cv.height = v.videoHeight
        const ctx = cv.getContext('2d')
        if (ctx === null) { setErr('这个环境不支持画布取像素（拿不到 2d 上下文）'); return }
        ctx.drawImage(v, 0, 0)
        cv.toBlob((b) => { void saveOpResult(imageOpNode.id, b) }, 'image/png')
      }
    }
    v.src = artifactHref(art)
  }, [imageOpNode, saveOpResult, setErr])


  /* 卸载时把还在跑的轮询都停掉 —— 否则切走板块之后它还在后台打接口。 */
  useEffect(() => () => {
    for (const stop of Object.values(pollTimers.current)) stop()
    pollTimers.current = {}
    /* 那颗「等第二次确认」的定时器同样要停 —— 卸载之后它还开着会去 setState。 */
    if (delTimerRef.current !== null) { clearTimeout(delTimerRef.current); delTimerRef.current = null }
  }, [])

  /**
   * 画一个节点的设置面板（票 35：**挂进节点里**）。
   *
   * ## 与改动前的关系
   *
   * 改动前这段 JSX 在画布层，位置按节点的**屏幕坐标**每帧算（`flowToScreenPosition`
   * 减容器左上角）。那是「挂在节点外面」的必然代价，而且缩放时面板不跟着缩。
   *
   * 现在整块搬进节点（由 `content-nodes.tsx` 的 `Shell` 调 `bridge.renderPanel`），
   * 位置交给 CSS（`left-1/2 top-full -translate-x-1/2`，照参考项目）。
   * **面板里的字段与顺序一个字没动** —— 仍是同一个 `<NodeSettingsPanel>` 同一批 props。
   *
   * ⚠️ 用 `useCallback` 且依赖里带全 `modelsFor` / `fromFlow` 之类，否则面板里
   * 模型下拉拿到的是旧的。这一处原来是内联 JSX（每次渲染新建），不涉及这件事；
   * 改成函数之后就必须显式钉住。
   *
   * @param id - 节点 id。
   * @returns 面板元素（节点不在时给 null）。
   */
  const renderPanel = useCallback((id: string): React.ReactNode => {
    const n = nodes.find(x => x.id === id)
    if (n === undefined) return null
    /* ★ 「面板宽度」那个设置**仍然生效**（票 35）。
     *
     * 面板搬进节点之后位置交给 CSS 了，但**宽度不许跟着丢** ——
     * 那是已经验过的功能（三档 260 / 320 / 380，`panelWidthFor`）。
     * 所以这里仍然按画布实际宽度算一次，用内联样式给 `.nodePanelInNode`。
     *
     * ⚠️ 量的是 `stageRef`（画布可视区）而不是窗口：面板挂在节点里，
     * 但「画布有多宽」仍然是决定档位的那个事实 —— 与搬之前一致。 */
    const boxW = stageRef.current?.getBoundingClientRect().width ?? 0
    const w = panelWidthFor(boxW, prefs.panelWidth)
    return (
      <div
        className={css.nodePanelInNode}
        data-ewb-panel-anchor=""
        data-ewb-panel-in-node={id}
        style={{ width: w }}
      >
        <NodeSettingsPanel
          id={n.id}
          type={(n.type ?? 'text') as ContentNodeType}
          data={fromFlow(n).data}
          onChange={(patch) => { onConfig(n.id, patch) }}
          onGenerate={() => { doGenerate(n.id) }}
          onClose={() => { setPanelId('') }}
          canGenerate={canGenerate}
          generateHint={generateHint}
          models={modelsFor(fromFlow(n))}
          modelsFallbackNote={modelsFallbackNote(fromFlow(n))}
          refChoices={refChoices}
          onLoadRefChoices={loadRefChoices}
          mentionCandidates={mentionCandidates}
        />
      </div>
    )
  }, [nodes, onConfig, doGenerate, canGenerate, generateHint, modelsFor, refChoices, loadRefChoices, mentionCandidates, prefs.panelWidth])

  /* ── 悬浮工具条要的那几个动作 ──────────────────────────────── */
  const bridge = useMemo(() => ({
    onText, onConfig, onResize, onRename,
    onDelete: deleteOne,
    onCopyPrompt: (id: string) => {
      const n = nodes.find(x => x.id === id)
      if (n === undefined) return
      void copyText(fromFlow(n).data.prompt ?? fromFlow(n).data.text ?? '')
    },
    onDownload: (id: string) => {
      /* 产物 id → 二进制路由 → 触发浏览器下载（契约 CH 第三节）。 */
      const art = fromFlow(nodes.find(x => x.id === id) ?? { id, type: 'image', position: { x: 0, y: 0 }, data: {} }).data.artifact ?? ''
      if (art === '') return
      triggerDownload(artifactHref(art), art)
    },
    onSaveAsset: (id: string) => {
      /* ── 文本节点：走 `POST /materials/text`（票 34，2026-10-28）──
       *
       * ## 改之前它点了没反应
       *
       * `NodeHoverToolbar.tsx:76` 那条 `if (item === 'saveAsset') return hasArtifact || type === 'text'`
       * **让文本节点也显示这个按钮**，但这个函数第一句就读 `data.artifact` ——
       * 文本节点没有这个字段，`art === ''` 直接 return。按钮在、点了什么都不发生。
       *
       * ## 为什么标题取 `data.title` 而不是 `data.text`
       *
       * `data.text` 是**正文**（节点的产出），标题是 `data.title`（用户起的名字）。
       * 没起名就回落成类型名 —— 与节点上那个标签一致，用户看着是同一个东西。
       *
       * ## 正文为空要明确说
       *
       * 空正文存进去是一条「什么都没有」的素材，用户以后翻素材库会看到一个空条目。
       * 静默失败与静默存空都不可接受，所以这里拦下来并给一句人话。 */
      const node = nodes.find(x => x.id === id)
      if (node?.type === 'text') {
        const data = fromFlow(node).data
        const content = (data.text ?? '').trim()
        const rawTitle = (data.title ?? '').trim()
        const title = rawTitle === '' ? '文本' : rawTitle
        if (content === '') {
          setErr('这个文本节点还没有正文，没有可存的内容。先在节点上双击写点字。')
          return
        }
        void (async () => {
          /* ⚠️ 直接 `fetch` 带全路径，不走 store 里那个 `api()` 包装：
           * 那是模块内私有函数（未导出），而 `content-canvas-store.ts` 不在本票可改路径里。
           * 这条路由的契约很短（`{ title, content }` → `{ ok, material }`），
           * 就地写清楚比绕一层更容易看。 */
          try {
            const res = await fetch('/api/ecom-workbench/materials/text', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ title, content }),
            })
            const body = await res.json().catch(() => null) as { ok?: boolean, error?: string } | null
            if (!res.ok || body?.ok !== true) {
              const why = body?.error ?? ('宿主半返回 ' + String(res.status))
              setErr('存进素材库失败：' + why)
              /* ★ 票 62：进通知条（失败不自动消失，要看才关）。 */
              notify('存进素材库失败：' + why, 'error')
              return
            }
            setErr('')
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e)
            setErr('存进素材库失败：' + why)
            notify('存进素材库失败：' + why, 'error')
          }
        })()
        return
      }
      /* ── 图片 / 视频：老路不动 ──
       *
       * 产物字节在宿主半，浏览器读不到 —— 所以「加进素材库」走宿主半那条
       * 「产物 → 素材」的复制：先把产物取回来、再 base64 传上去。
       * 一个来回，但不用在浏览器里碰文件系统。 */
      const art = fromFlow(nodes.find(x => x.id === id) ?? { id, type: 'image', position: { x: 0, y: 0 }, data: {} }).data.artifact ?? ''
      if (art === '') return
      void (async () => {
        try {
          const res = await fetch(artifactHref(art))
          if (!res.ok) { setErr('取不回产物：宿主半返回 ' + String(res.status)); return }
          const buf = await res.arrayBuffer()
          const b64 = bytesToBase64(new Uint8Array(buf))
          const sent = await uploadMaterial(art + '.png', b64)
          if (!sent.ok) { setErr(sent.error ?? '存进素材库失败'); return }
          setErr('')
        } catch (e) {
          setErr('存进素材库失败：' + (e instanceof Error ? e.message : String(e)))
        }
      })()
    },
    onUpload: (id: string) => {
      uploadTargetRef.current = id
      fileRef.current?.click()
    },
    onView: (id: string) => {
      const art = fromFlow(nodes.find(x => x.id === id) ?? { id, type: 'image', position: { x: 0, y: 0 }, data: {} }).data.artifact ?? ''
      if (art === '') return
      window.open(artifactHref(art), '_blank')
    },
    /* 面板上的「生成」：真提交（契约 CH）。 */
    onGenerate: (id: string) => { doGenerate(id) },
    panelNodeId: panelId,
    renderPanel,
    onSelectNode: (id: string) => {
      /* 单击：只选中 + 开面板。**绝不 focus 任何输入框**（验收 6）。 */
      setNodes(prev => setAllSelected(prev, false).map(n => (n.id === id ? { ...n, selected: true } : n)))
      setPanelId(id)
    },
    /* 组框上那个成员数（契约 CE）。用 `useCallback` 之外的小函数看着更简单，
     * 但桥的依赖里必须带上 `nodes` —— 否则拖完一次成员变了数字不更新。 */
    groupCount: (id: string) => groupMemberCount(nodes.map(fromFlow), id),
    /* 运行态与两个按钮（契约 CH）。 */
    runState: (id: string) => runs[id] ?? { kind: 'idle' },
    onRetry: (id: string) => {
      const run = runs[id]
      if (run !== undefined && run.kind === 'failed') doGenerate(id, run.retry, 'retry')
      else doGenerate(id)
    },
    onCancel: (id: string) => { doCancel(id) },
    /* ★ 打开图像操作浮层（用户 m02814）。记下节点 id 与要开哪个面板，
     * 浮层本体在画布这一层渲染（它要拿节点的 <img>/<video> 做像素操作）。 */
    onImageOp: (id: string, kind: ImageOpKind) => { setImageOp({ id, kind }) },
    /* ★ 局部重绘开的是单独的蒙版面板（它要 canvas 与指针交互）。 */
    onMask: (id: string) => { setMaskNodeId(id) },
    /* ★ 放大 / 超分 / 反推（用户 m02814 #61 / #63）：点了直接跑，没有参数要填。
     *
     * 三种都**先取回底图字节**（后端的 `refs` 要字节，不是产物 id），
     * 取不到就报错停下 —— 缺 refs 时后端会用占位图而任务照样成功。
     *
     * `caption` 的结果走 `onPrompt` 填进 `data.prompt`（**输入**），
     * 不是 `data.text`（产出）—— 见 `op-specs.ts` 的 `resultFieldOf`。 */
    onRunOp: (id: string, op: 'upscale' | 'superResolve') => {
      const cur = nodes.find(x => x.id === id)
      if (cur === undefined) return
      const d = fromFlow(cur).data
      const art = (d.artifact ?? '').trim()
      const spec = opSpecOf(op)
      if (spec === undefined) return
      /* ★ 票 76（2026-10-29）：停用的 op 在这里**明确拒绝**。
       *
       * 工具栏已经不给那颗按钮了，所以正常走不到这里。留着这道是给
       * 「老画布 + 手改过的存档 / 将来别处调这个函数」兜底 ——
       * 静默 return 会让调用方以为跑成功了。
       *
       * 面子上它看起来是死代码，但它是**唯一**一处能保证
       * 「停用的操作不会偷偷跑」的地方（规格表在这一层才读得到）。 */
      if (spec.disabled === true) {
        setErr('「' + spec.label + '」已停用：' + (spec.disabledWhy ?? '这条入口暂时不可用'))
        return
      }
      void (async () => {
        const bad = missingForOp(spec, { ref: art, prompt: d.prompt ?? '' })
        if (bad !== '') { setErr(bad); return }
        const ref = await refBase64(art, '底图')
        if (!ref.ok || ref.data === undefined) { setErr(ref.error ?? '取不回底图'); return }
        /* 先问一句这个 op 现在做不做得了（判据 3：没有渠道挂了对应工作流时先拦住）。
         * `upscale` / `superResolve` 在内置清单里没有工作流，没挂渠道必然失败。 */
        const ms = await listGenModels('image', op)
        if (!ms.ok || ms.data === undefined) { setErr(ms.error ?? '读不到模型清单'); return }
        if (!opAvailable(ms.data)) { setErr(opUnavailableReason(spec)); return }
        /* ★ **模型不自己兜底**（用户 m03555：「节点是怎么知道自己该用什么模型的？」）。
         *
         * 后端已经把三层规则定死了（`ce8c81c`）：
         *   ① 指定了模型 → 用；
         *   ② 没指定 → 默认模型里这一类那条 → 用它的渠道与模型；
         *   ③ 默认也没设 → 报「还没有设默认模型，去设置里选一个」。
         *
         * ⚠️ **不许在这里回落到 `ms.data[0]`** —— 那等于按渠道顺序撞运气，
         * 而且会**盖住后端那句提示**：界面先挑了一个，后端就永远走不到 ③。 */
        setErr('')
        doGenerate(id, {
          kind: 'image',
          op,
          prompt: (d.prompt ?? '').trim(),
          ...(d.model ?? '').trim() === '' ? {} : { model: (d.model ?? '').trim() },
          ...(d.channel ?? '').trim() === '' ? {} : { channelId: d.channel },
          refs: [ref.data],
          source: 'canvas',
          canvasId,
          canvasNodeId: id,
        })
        /* ⚠️ 票 76（2026-10-29）：原来这里有一句 `if (op === 'caption') captionNodeRef.current = id`。
         *
         * 反推停用之后 `op` 只剩 `upscale` / `superResolve`，那一句永远不成立，
         * `check:client` 直接报「两个类型没有重叠」。删掉它。
         *
         * **但结果回填那一整段留着**（`captionNodeRef` 与 `:1483` 起的处理）——
         * 那是「停用不删」：以后接上 dsh 的视觉模型，只要把那句赋值加回来、
         * 把 `op-specs.ts` 的 `disabled` 去掉，整条路就复活。
         * 删了它等于要让下一个人重写「文本产物按 mime 取回来」那一整套。 */
      })()
    },
    /* ★ 批量节点（用户 m02814 #72-74）三个动作都走 `onConfig` 改 `data`，
     * 不另开一套状态 —— 它们改的都是要存盘的东西。 */
    onBatchToggle: (id: string) => {
      const cur = nodes.find(x => x.id === id)
      if (cur === undefined) return
      onConfig(id, { expanded: fromFlow(cur).data.expanded !== true })
    },
    onBatchMain: (id: string, index: number) => { onConfig(id, { mainIndex: index }) },
    onBatchRemove: (id: string, index: number) => {
      const cur = nodes.find(x => x.id === id)
      if (cur === undefined) return
      const d = fromFlow(cur).data
      const items = (d.items ?? []).filter((_, i) => i !== index)
      const main = typeof d.mainIndex === 'number' ? d.mainIndex : 0
      /* 删掉的正好是主图 → 主图退回第一张（`items` 为空时归 0）。 */
      const nextMain = index === main ? 0 : (main > index ? main - 1 : main)
      onConfig(id, { items, mainIndex: Math.max(0, Math.min(Math.max(0, items.length - 1), nextMain)) })
    },
  }), [copyText, deleteOne, doCancel, doGenerate, nodes, onConfig, onRename, onResize, onText, panelId, runs,
    /* ★ `renderPanel` **必须在依赖里**（票 35，2026-10-28 实测踩到）。
     *
     * 它搬进节点之后是经 bridge 传下去的。不进依赖 → bridge 一直是老的闭包 →
     * 面板拿到的是**旧的** `refChoices`（空列表）。表现是：点「选择参考图」
     * 明明发了 `GET /materials`、素材也回来了，**候选列表里却一条素材都没有**
     * （只剩画布自己算出来的那一条）。
     *
     * 这个 bug 抓得很准：`content-canvas-ops.mjs` ⑩ 段「候选列表渲染出来了
     * （素材两条 + 画布上那个有产物的图）」直接红了 —— 它等的是 3 条、实际 1 条。
     * 单测「面板能不能渲染」是绿的，只有把「数据从哪来」也串起来才抓得到。 */
    renderPanel])

  /** 保存状态文案。 */
  const saveText = saveState === 'saving'
    ? '保存中…'
    : saveState === 'saved' ? '已保存' : saveState === 'error' ? '保存失败' : '未改动'

  /* ══ 票 54：画布明暗 ══════════════════════════════════════════════════
   *
   * ## 当前实际上是深色吗
   *
   * `canvasTheme` 有值时按它，没值时跟随 dsh（`detectDark()`）。
   * 这里**每次渲染都算一次**：`detectDark()` 读的是 DOM 属性，很便宜；
   * 而且 dsh 主题可能在运行中切换（用户去设置里改），算一次就够跟随。
   *
   * ⚠️ 不要用 `useState(() => detectDark())` 缓存 —— 那样 dsh 换主题后画布不跟。 */
  const darkNow = canvasTheme === null ? detectDark() : canvasTheme === 'dark'

  /** 切换画布明暗（只切画布，不碰 dsh 主题）。 */
  const toggleCanvasTheme = useCallback((): void => {
    /* 现在是按哪个值显示的，就翻到它的反面，并**写死**成那个值 ——
     * 从这一次点击开始，画布不再跟随 dsh（票面第 5 条）。 */
    const next: CanvasTheme = darkNow ? 'light' : 'dark'
    setCanvasTheme(next)
    putPrefs({ theme: next })
  }, [darkNow, putPrefs])

  /** 画布可视区那一层（图像操作浮层按它的实际宽高算位置与三档宽度）。 */
  const stageRef = useRef<HTMLDivElement | null>(null)
  /** 面板实际高度（图像操作浮层量一下，供“底部放不放得下”判断）。 */
  const panelHeightRef = useRef<number>(320)
  const panelRef = useRef<HTMLDivElement | null>(null)
  /** 选中形状（全选 / 无选择）。 */
  const selCount = nodes.filter(n => n.selected === true).length


  return (
    <div className={css.contentCanvas} data-ewb-content-canvas={canvasId}>
      <div className={css.canvasMain}>
        <CanvasSidePanel
          nodes={nodes.map(fromFlow)}
          selectedId={selCount === 1 ? (nodes.find(n => n.selected === true)?.id ?? '') : ''}
          onFocus={focusNode}
          onInsertMaterial={insertMaterial}
          /* ★ 文本素材插成文本节点（票 34）：正文进 `text`，标题进 `title`。
           * 与 `insertPrompt` 是**同一件事的两个来源**（一个来自提示词库副本、
           * 一个来自用户自己存的素材），所以形状一样、都造文本节点。 */
          onInsertTextMaterial={(m) => {
            record('insert')
            const n = newNode(
              'text',
              { x: 120 + nodes.length * 20, y: 160 + nodes.length * 20 },
              { text: m.content, ...m.title === '' ? {} : { title: m.title } },
            )
            setNodes(prev => [...prev, toFlow(n)])
          }}
          onInsertPrompt={insertPrompt}
          open={sideOpen}
          onToggleOpen={toggleSide}
        />

        <div
          className={css.contentCanvasStage}
          data-ewb-canvas-stage=""
          ref={stageRef}
          /* ★ 票 54：画布明暗**只在这一层生效**。
           *
           * 为什么是这两个变量：
           *   · `--ewb-canvas-base` 是画布底的兜底色（`workflow-canvas.module.css`
           *     的 `.canvas` 用它）；
           *   · `--ewb-canvas-underglow` 是它下面那层（内容画布没有 `--ewb-canvas-bg`
           *     那条可调透明度的路，所以直接换底）。
           *
           * ⚠️ **写在这一层而不是 `document.body`**：用户要的是「只切换画布主题色」。
           * 写到 body 上就是改整个 dsh（判据 5 明令不许）。 */
          style={{
            '--ewb-canvas-base': darkNow ? 'var(--dsw-alias-bg-base, #151517)' : 'var(--dsw-alias-bg-base, #ffffff)',
            '--ewb-canvas-underglow': darkNow ? 'var(--dsw-alias-bg-module-platform, #353638)' : 'var(--dsw-alias-bg-module-platform, #f5f6f7)',
            background: darkNow
              ? 'var(--dsw-alias-bg-base, #151517)'
              : 'var(--dsw-alias-bg-base, #ffffff)',
            colorScheme: darkNow ? 'dark' : 'light',
          } as React.CSSProperties}
        >
          {/* ══ 顶部悬浮条（票 54）════════════════════════════════════════
           *
           * ## 为什么挂在 stage 里而不是外面
           *
           * 用户 2026-10-29 甲 1：「两边都不要顶部栏，顶部在画布中悬浮」。
           * 挂在 stage 内 = 祖先链里有画布容器 → 它浮在画布之上、随画布区缩放。
           * 挂在外面（改之前那样）就是「画布上方另一行」。
           *
           * ## 左右分工（甲 2、8）
           *
           * 左：侧栏开关 · 画布名称 · 保存态
           * 右：加节点 · 分组 · 撤销 · 重做 · 设置 · 主题色
           *
           * ## 加节点那一组为什么先放在右侧
           *
           * 票面把它定为主操作、进**底部**主操作位（票 55）。本票不搬，
           * 先放右侧（不然那几颗按钮没地方去，删掉就等于砍功能）。
           * 票 55 会把它们整体挪到底部胶囊条 —— 交付里已写明。 */}
          <CanvasTopBar
            kind="content"
            left={(
              <>
                <TopBarButton
                  action="side"
                  title={sideOpen ? '收起素材与提示词侧栏' : '展开素材与提示词侧栏'}
                  on={sideOpen}
                  legacy={{ 'data-ewb-canvas-side': '' }}
                  onClick={() => { setSideOpen(v => !v) }}
                ><PanelLeftIcon /></TopBarButton>
                {/* 画布名称（票 54 才真正渲染出来 —— 之前 `.contentCanvasTitle`
                 * 这个类没有任何地方引用，`title` 状态也只在内部用）。
                 *
                 * 空标题时给一句占位：用户要能看出「这里能显示名字」，
                 * 而不是看到一片空白以为坏了。 */}
                <span
                  data-ewb-canvas-name=""
                  className={css.contentCanvasTitle}
                  title={title === '' ? '这份画布还没有名字' : title}
                >{title === '' ? '未命名画布' : title}</span>
                {/* 保存态（票 54 才真正渲染 —— `saveState` 之前算了但一次没用）。
                 * 三态文案：保存中… / 已保存 / 保存失败。
                 * `idle`（未改动）**不显示** —— 一直挂着一句「未改动」是噪音。 */}
                {saveState === 'idle'
                  ? null
                  : (
                    <span
                      data-ewb-canvas-save={saveState}
                      className={css.contentCanvasHint}
                    >{saveText}</span>
                  )}
              </>
            )}
            right={(
              <>
                {/* ── 右组现在只有「设置类」────────────────────────────────
                 *
                 * 票 55 之后顶部条只剩六件：侧栏开关、名称、保存态（左组）
                 * + 设置、主题、关闭（右组）。
                 *
                 * ## 搬走的是什么
                 *
                 * 模式切换、加节点 5 颗、分组、撤销/重做 —— 全去了**下面那个
                 * 底部主操作位**。理由：顶部条是「这一份是什么 + 设置类」，
                 * 底部是「动作」（用户 2026-10-29 甲 5「主操作放底部中间悬浮」）。
                 *
                 * ⚠️ **功能一个没删**：这几颗只是换了位置，钩子也从
                 * `data-ewb-tb` 换成了 `data-ewb-dock-btn`（两套不混）。
                 * `data-ewb-canvas-mode` / `-add` / `-undo` / `-redo` 那几个
                 * **旧钩子照旧挂着** —— `tests/content-canvas*.mjs` 有 10 处按它们找，
                 * 换锚点不是这票的活。 */}
                {/* ★ 票 62：节点与连线计数（三条数，选中为 0 时不显示那一项）。
                 *
                 * ## 为什么放在右组最左
                 *
                 * 右组是「这一份现在什么样 + 设置类」。计数属于「现在什么样」，
                 * 挨着设置/主题/关闭放，比塞在左组（那是「这是什么文件」）更顺。
                 *
                 * ## 窄屏收起顺序（写在这里，免得以后靠猜）
                 *
                 * 容器窄下来时**先收计数条**，再收主题，设置与关闭最后收：
                 *   · 计数是「看一眼就好」的信息，收掉不损失能力；
                 *   · 主题在设置面板里也能改；
                 *   · 设置与关闭是入口，收掉就进不去了。
                 *
                 * ⚠️ 收起靠 `EcomWorkbench.module.css` 末尾那段容器查询，
                 * 不在这里判宽度 —— 两边各判一次必然漂。 */}
                <span
                  className={css.contentCanvasCount}
                  data-ewb-content-count=""
                  title="节点数 / 连线数 / 选中数"
                >
                  节点 {nodes.length}
                  {' / ' + String(edges.length) + ' 连线'}
                  {/* 选中为 0 时不显示这一项 —— 与执行画布那条计数一致。 */}
                  {selCount > 0 && <span className={css.contentCanvasCountHot}>· 选中 {selCount}</span>}
                </span>
                {/* ★ 票 62：锁定画布。
                 *
                 * 拦住四件事：拖动 / 拉线 / 改尺寸 / 删除（右键菜单与 Delete）。
                 * ⚠️ **不锁选中** —— 锁着也要能点开节点看侧栏详情（只读）。
                 * 这一处与执行画布有意不同，理由见 `locked` 那段注释。 */}
                <TopBarButton
                  action="lock"
                  title={locked ? '画布已锁定（只读）。点一下解锁才能编辑' : '锁定画布，防止误拖动 / 误删'}
                  on={locked}
                  onClick={toggleLocked}
                >{locked ? <LockIcon /> : <UnlockIcon />}</TopBarButton>
                {/* ── 设置（用户甲 8：设置按钮去右上角，两边统一）──
                 * 原来它和网格切换挤在右下角一排里。搬上来之后
                 * 右下角只剩网格切换与缩放那一组。 */}
                <TopBarButton
                  action="settings"
                  title="画布设置"
                  on={settingsOpen}
                  legacy={{ 'data-ewb-settings-open': '' }}
                  onClick={() => { setSettingsOpen(v => !v) }}
                ><SettingsIcon /></TopBarButton>
                {/* ── 主题色切换（用户甲 4）──
                 * 一个按钮两态。`title` 说「点了会变成什么」而不是「现在是什么」——
                 * 按钮是动作，标题该说动作的结果。 */}
                <TopBarButton
                  action="theme"
                  title={darkNow ? '画布切到浅色' : '画布切到深色'}
                  on={canvasTheme !== null}
                  onClick={toggleCanvasTheme}
                >{darkNow ? <MoonIcon /> : <SunIcon />}</TopBarButton>
                <TopBarDivider />
                {/* ── 关闭画布（回列表）──
                 * ⚠️ 关闭前必须 `flush` 自动保存（原来那颗就是这么做的）——
                 * 直接 `onClose()` 会把最后一次改动丢掉。 */}
                <TopBarButton
                  action="close"
                  title="关闭这份画布，回到画布库"
                  legacy={{ 'data-ewb-canvas-close': '' }}
                  onClick={() => { autosaveRef.current.flush(); onClose() }}
                ><XIcon /></TopBarButton>
              </>
            )}
          />

          {/* ══ 底部主操作位（票 55，用户 2026-10-29 甲 5、6 与戊 22）══════════════
           *
           * > 主操作放底部中间悬浮……注意，内容画布的节点按钮就是执行画布的
           * > 开始停止等执行按钮一个级别的。二者逻辑不一样但定位相同。
           *
           * ## 左右分工照票面
           *
           *   左：模式切换（一个按钮两态）
           *   中：撤销 / 重做
           *   右：加节点 5 颗 + 分组（内容画布的「主操作」）
           *
           * ## 与执行画布**同一个组件**
           *
           * `CanvasDock` 是两边共用的（票 54 定的那条路：几何与外观只定义一处）。
           * 内容不同，形状相同。
           *
           * ## 旧钩子照旧挂着
           *
           * `data-ewb-canvas-mode` / `-add` / `-undo` / `-redo` 四个钩子在
           * `tests/content-canvas*.mjs` 里有 10 处引用。票面没让改那些断言，
           * 所以 `DockButton` 之外**多挂一层旧钩子**（用 `legacy` 传）。
           * 这不是「两套并存」—— `data-ewb-dock-btn` 是新判据的锚点，
           * 旧钩子只是让既有断言不必跟着改（换锚点是另一张票的活）。 */}
          <CanvasDock
            kind="content"
            mode={(
              <DockButton
                action="mode"
                title={mode === 'select' ? '现在是框选，点一下切成移动' : '现在是移动，点一下切成框选'}
                on={mode === 'pan'}
                legacy={{ 'data-ewb-canvas-mode': mode }}
                onClick={() => { setMode(toggleMode(mode)) }}
              >{mode === 'select' ? <BoxSelectIcon /> : <ArrowRightIcon />}</DockButton>
            )}
            history={(
              <>
                <DockButton
                  action="undo"
                  title={undoHint(depths.past, depths.future)}
                  disabled={depths.past === 0}
                  collapse={3}
                  legacy={{ 'data-ewb-canvas-undo': '' }}
                  onClick={doUndo}
                ><UndoIcon /></DockButton>
                <DockButton
                  action="redo"
                  title={redoHint(depths.future)}
                  disabled={depths.future === 0}
                  collapse={3}
                  legacy={{ 'data-ewb-canvas-redo': '' }}
                  onClick={doRedo}
                ><RedoIcon /></DockButton>
              </>
            )}
            main={(
              <>
                {/* 加节点 5 颗：这是内容画布的主操作（判据 4）。 */}
                <DockButton
                  action="add-text"
                  title="加文本节点"
                  legacy={{ 'data-ewb-canvas-add': 'text' }}
                  onClick={() => { addNode('text') }}
                ><TypeIcon /></DockButton>
                <DockButton
                  action="add-image"
                  title="加图片节点"
                  legacy={{ 'data-ewb-canvas-add': 'image' }}
                  onClick={() => { addNode('image') }}
                ><ImageIcon /></DockButton>
                <DockButton
                  action="add-video"
                  title="加视频节点"
                  legacy={{ 'data-ewb-canvas-add': 'video' }}
                  onClick={() => { addNode('video') }}
                ><VideoIcon /></DockButton>
                <DockButton
                  action="add-audio"
                  title="加音频节点"
                  legacy={{ 'data-ewb-canvas-add': 'audio' }}
                  onClick={() => { addNode('audio') }}
                ><MusicIcon /></DockButton>
                <DockButton
                  action="add-config"
                  title="加配置节点"
                  legacy={{ 'data-ewb-canvas-add': 'config' }}
                  onClick={() => { addNode('config') }}
                ><PlusIcon /></DockButton>
                <DockButton
                  action="group"
                  title="把选中的节点编成一组"
                  legacy={{ 'data-ewb-canvas-group': '' }}
                  onClick={() => { doGroup() }}
                ><GroupIcon /></DockButton>
              </>
            )}
          />

          {err === ''
            ? null
            : (
              <div className={css.contentCanvasErr} data-ewb-canvas-error="">
                <span className="dot warn" style={{ marginTop: 5 }} />
                <span className="min-w-0 flex-1">{err}</span>
              </div>
            )}

          {/* ★ 票 62：通知条（复用执行画布那个组件，不复制样式）。
           *
           * ## 它和上面那行红字什么关系
           *
           * 两样都留，各管一段：
           *   · 红字 —— 贴在图下方，**离操作最近**，说的是「刚刚那一下失败了」；
           *   · 通知条 —— 右上角，**可堆叠、不自动消失**，说的是「之前攒下的失败」。
           *
           * 只留红字的话，第二次失败会把第一次盖掉（那正是票面说的
           * 「看一眼就没了」）；只留通知条的话，红字消失之后
           * 「刚才为什么没保存上」就没有就地提示了。 */}
          <NoticeBar notices={notices} onDismiss={dismiss} />

          <ContentNodeBridgeProvider value={bridge}>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={CONTENT_NODE_TYPES}
              /* ★ 票 60：连线走自定义边（命中区加粗到 16、选中态换色发光）。
               *
               * `defaultEdgeOptions.type` 是给**老存档**用的 —— 那些边没有 `type` 字段，
               * 不设它就会退回 React Flow 的默认细线（点不中）。 */
              edgeTypes={CONTENT_EDGE_TYPES}
              defaultEdgeOptions={CONTENT_EDGE_DEFAULTS}
              /* ★ 拖放落位（契约 CJ）：侧栏的素材 / 提示词拖进来放成一个新节点。
               *
               * `onDragOver` 必须 `preventDefault`，否则浏览器认为这个位置不接受放置，
               * `drop` 根本不会触发（这一条是最容易漏的，漏了表现为「拖上去有个禁止图标」）。 */
              onDragOver={(e) => {
                /* ★ 两种拖放都接受（用户 m02814 #101 加了系统文件那一支）：
                 *   · 侧栏拖 → 自定义 MIME；
                 *   · 从系统拖文件 → `types` 里有 `'Files'`。
                 * 两个分支都要 `preventDefault`，否则浏览器认为这里不接受放置。 */
                const hasOurs = e.dataTransfer.types.includes(DRAG_MIME)
                const hasFiles = e.dataTransfer.types.includes('Files')
                if (!hasOurs && !hasFiles) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
              }}
              onDrop={(e) => {
                /* ★ **先看自定义 MIME**（那是我们自己放的，最可靠）。
                 * 反过来的话，「拖一个文件、里面恰好有一份同名 JSON」会被当成载荷。
                 * 见 `content-canvas-store.ts` 里 #101/#102 那段的说明。 */
                const raw = e.dataTransfer.getData(DRAG_MIME)
                const p = decodeDrag(raw)
                /* 屏幕坐标 → 画布坐标：缩放与平移只有 React Flow 知道，
                 * 所以走它的 `screenToFlowPosition`，再交给 `dropPosition` 取整。 */
                const at = instRef.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY })
                  ?? { x: e.clientX, y: e.clientY }
                if (p !== null) {
                  e.preventDefault()
                  dropOnCanvas(p, dropPosition(at))
                  return
                }
                /* 侧栏那条解不出来 → 看是不是从系统拖进来的文件。 */
                const files = [...(e.dataTransfer.files ?? [])]
                if (files.length === 0) return
                e.preventDefault()
                dropFiles(files, dropPosition(at))
              }}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onMove={onMove}
              onNodeDragStart={onDragStart}
              /* ★ 拖动中算参考线（票 01）。这个回调每帧都会来，
               * 关掉开关时 `onDrag` 第一行就 return，一次计算都不做。 */
              onNodeDrag={onDrag}
              onNodeDragStop={onDragStop}
              onPaneContextMenu={paneMenu}
              onNodeContextMenu={nodeMenu}
              /* ★ 票 60：右键一条线出菜单（票面判据 3）。 */
              onEdgeContextMenu={edgeMenu}
              onInit={(inst) => { instRef.current = inst }}
              /* ★ 操作模式：两个属性都由 `modeToProps` 决定（验收 1 的判据）。 */
              {...modeToProps(mode)}
              /* ★ 票 62：锁定时拦拖动与拉线（四条里的前两条）。
               *
               * ⚠️ `elementsSelectable` **故意不加** —— 锁着也要能点开节点看详情。
               * 与执行画布有意不同，理由见上面 `locked` 那段注释。 */
              nodesDraggable={!locked}
              nodesConnectable={!locked}
              /* ★ 票 61：多选键统一成 `['Meta','Control']`（与执行画布同一个）。
               *
               * React Flow 的默认值是 `'Meta'`（Mac 的 Cmd）—— 在 Windows 上
               * 等于「加选只能用 Ctrl 点」，而两端代码不一致会让快捷键说明
               * 只能写半边。显式声明之后两边**一个值**。 */
              multiSelectionKeyCode={['Meta', 'Control']}
              /* ★ 票 61：内容画布原来**没有** `selectionKeyCode`（它靠自己的
               * `panOnDrag` 常驻属性 + 上面的 Ctrl 特判）。这里补上，
               * 让 React Flow 自己也认 Ctrl —— 效果是「按住 Ctrl 拖动 = 框选」，
               * 与执行画布同一个行为。
               *
               * ⚠️ 空格**不**写进来：React Flow 认的是 `event.code`（`'Space'`），
               * 而它内部会对空格 `preventDefault`，与上面那条 `panHold`
               * 自己写的切换打架（两套都在切模式）。空格仍由我们自己的 keydown 管。 */
              selectionKeyCode="Control"
              /* React Flow 自带的删除键要关掉：它会绕过 deleteSelected，不进撤销栈。
               * 我们自己在 `shortcutOf` 里接管 Delete / Backspace。 */
              deleteKeyCode={null}
              fitView={false}
              minZoom={0.05}
              maxZoom={5}
              proOptions={{ hideAttribution: false }}
            >
              {grid === 'none' ? null : (
                /* ★ 线格与点阵**不共用参数**（用户 m03414：「线格过于明显过于密集，
                 * 间距增加 4 倍、（透明度）下降”）。
                 *
                 * 点阵保持原样（用户只说了线格）：`gap=18`、`size=1`、默认不透明。
                 * 线格：`gap=72`（18×4）、`size` 收细到 `0.6`（不让它比点阵还抢眼）、
                 * 颜色压到 **20% 透明度**。两者颜色都用 `--v1-edge`（点阵不给 color，
                 * 走 React Flow 默认）—— 线格单独给一个带透明度的值。 */
                <Background
                  variant={grid === 'lines' ? BackgroundVariant.Lines : BackgroundVariant.Dots}
                  gap={grid === 'lines' ? LINE_GAP : DOT_GAP}
                  size={grid === 'lines' ? LINE_SIZE : DOT_SIZE}
                  /* ★ 线格颜色现在**跟着设置走**（2026-10-27 接通）。
                   *
                   * 原来这里写死 `LINE_COLOR`（= 20% 透明），而面板里那个
                   * 「线格深浅」滑块存进了 localStorage 却没人读 ——
                   * 用户拖了滑块毫无反应（`canvas-prefs.mjs` 只验了「存得对」，
                   * 验不到「用没上」，那是一类假绿）。
                   *
                   * 默认 `lineOpacity = 0.2` 时 `lineColorOf(0.2)` 给出的串与
                   * `LINE_COLOR` **等价**（同一句 `color-mix(in srgb, … 20%, transparent)`），
                   * 所以默认外观一字不差。 */
                  /* ★ 票 59：**点阵也认透明度了**。
                   *
                   * 改前只有 `lines` 档给了 `color`（走 `lineColorOf(lineOpacity)`），
                   * 点阵档走 React Flow 默认值 —— 所以「线格深浅」那条滑块
                   * 拖到 0 时点阵毫无反应。
                   *
                   * 现在两档都走 `patternColorOf`：线格取 `--v1-edge`、
                   * 点阵取 `--grid-color`，透明度共用 `patternOpacity`。
                   *
                   * ⚠️ 线格那一档仍**优先**用 `lineOpacity`（那条滑块还在面板上、
                   * 用户可能已经调过它）—— 两套并存容易让人困惑，所以
                   * 面板上会把「线格深浅」与「图案深浅」按档位显示其中一条。 */
                  color={patternColorOf(
                    grid === 'lines' ? 'lines' : 'dots',
                    grid === 'lines'
                      ? Math.round(prefs.lineOpacity * 100)
                      : (prefs.patternOpacity ?? 20),
                  )}
                />
              )}
              {miniMap ? <MiniMap pannable zoomable /> : null}
            </ReactFlow>
          </ContentNodeBridgeProvider>

          {/* ★ 对齐参考线（票 01，用户 C2）。
           *
           * ## 画在哪一层
           *
           * 挂在画布舞台上、`ReactFlow` **外面** —— 放进去会被它的 `transform`
           * 再缩一遍（我们已经在算屏幕坐标了）。
           *
           * ## 坐标换算照 Dify
           *
           * `help-line/index.tsx` 是 `top * zoom + y` / `left * zoom + x`。
           * 因为 `align` 里存的是**画布坐标**（那样纯函数才能单测，不用知道视口），
           * 到这一层才换成屏幕坐标。
           *
           * ## 为什么 pointer-events-none
           *
           * 它是看得见的辅助线，不该挡住下面画布的拖动与框选。
           *
           * ## 关掉开关时
           *
           * `onDrag` 一次都不跑，`align` 一直是 `NO_ALIGN`（两个数组都空），
           * 这里自然什么都不画 —— 不需要额外判 `prefs.align`。 */}
          {align.vertical.length === 0 && align.horizontal.length === 0
            ? null
            : (
              <div className="pointer-events-none absolute inset-0 z-[6]" data-ewb-align-layer="">
                {align.vertical.map(g => (
                  <div
                    key={'v' + String(g.at) + '-' + String(g.from)}
                    data-ewb-align-guide="x"
                    className="absolute w-px bg-[var(--v1-edge-hot)]"
                    style={{
                      left: g.at * zoom + viewportRef.current.x,
                      top: g.from * zoom + viewportRef.current.y,
                      height: Math.max(0, (g.to - g.from) * zoom),
                      /* ★ 票 59：参考线透明度可调（默认 70% = 改动前的外观）。
                       *
                       * ⚠️ 内容画布的参考线**不是** CSS 类，是内联 Tailwind ——
                       * 所以这里直接给 style，不像执行画布那样走 CSS 变量
                       * （那边的 `.helperV` 在 `workflow-canvas.module.css` 里）。
                       * **两处都要接**，只改一处另一边不会跟着变。 */
                      opacity: (prefs.guideOpacity ?? 70) / 100,
                    }}
                  />
                ))}
                {align.horizontal.map(g => (
                  <div
                    key={'h' + String(g.at) + '-' + String(g.from)}
                    data-ewb-align-guide="y"
                    className="absolute h-px bg-[var(--v1-edge-hot)]"
                    style={{
                      left: g.from * zoom + viewportRef.current.x,
                      top: g.at * zoom + viewportRef.current.y,
                      width: Math.max(0, (g.to - g.from) * zoom),
                      /* ★ 票 59：同上，参考线透明度。 */
                      opacity: (prefs.guideOpacity ?? 70) / 100,
                    }}
                  />
                ))}
              </div>
            )}

          {/* ★ 空态引导（票 06，用户 C4）。
           *
           * 新建画布之后是一片纯空白 + 点阵，**没有一个字**告诉用户下一步该干什么。
           * 参考项目也是这样（它的空画布只有一个居中 logo），所以我们按自己的工具条写。
           *
           * ## 三层约束（判据 3 就钉这一条）
           *
           *   ① **不是遮罩**：`pointer-events-none` —— 它底下的画布照样能拖、能框选、
           *      能右键。做成全屏遮罩会让「空画布上先拖一下试试」这个动作失效。
           *   ② **不拦任何点击**：没有按钮、没有「关闭」—— 节点一加进来它自己就消失，
           *      不需要用户处理它。
           *   ③ **不抢注意力**：低对比度、居偏上、不描边填充。
           *
           * `nodes.length === 0` 是唯一条件。用 `nodes` 而不是「存盘里的节点数」——
           * 加节点那一刻 `nodes` 就变了，引导当帧消失，不用等自动保存。
           *
           * ⚠️ 缩放的初始行为不动（票里点名）：不去 `fitView`、不改 viewport。 */}
          {nodes.length === 0
            ? (
              <div
                data-ewb-canvas-guide=""
                className="pointer-events-none absolute inset-0 z-[5] flex flex-col items-center justify-center gap-1.5"
              >
                <span className="font-mono text-ewb-body text-[var(--dsw-alias-label-secondary)]">
                  从顶部工具条添加节点开始
                </span>
                <span className="font-mono text-ewb-caption text-[var(--v1-dim)]">
                  文本 / 图片 / 视频 / 音频 / 配置，也可以从左侧栏拖素材或提示词进来
                </span>
                <span className="font-mono text-ewb-caption text-[var(--v1-dim)]">
                  右键空白处也能加；节点上加好之后，点一下展开设置
                </span>
              </div>
            )
            : null}

           {/* ★ 设置面板已经不在这里了（票 35，2026-10-28）。
           *
           * 它搬进了节点内部（`content-nodes.tsx` 的 `Shell` 调 `bridge.renderPanel`），
           * 于是跟着节点移动、跟着画布缩放 —— 照参考项目 `canvas-node.tsx:483` 的做法。
           *
           * ⚠️ 原来这条注释写的理由「节点有 `overflow: hidden`，塞进去会被裁掉」
           * **已经不成立**：票 35 把节点外壳拆成两层（`.contentNodeWrap` 不裁剪）。
           * 这段历史留着，是因为下一个人可能又会看到「为什么不用屏幕坐标算」这个问题。 */}

           {/* 局部重绘的蒙版面板（用户 m02814 #60）。
           *
           * 与上面那个浮层同样挂在画布这一层（节点有 overflow:hidden，塞不进去）。 */}
          <MaskOpMount
            nodeId={maskNodeId}
            nodes={nodes}
            onDone={(mask) => {
              const cur = nodes.find(n => n.id === maskNodeId)
              if (cur === undefined) { setMaskNodeId(''); return }
              const art = (fromFlow(cur).data.artifact ?? '').trim()
              if (art === '') { setErr('这个节点还没有图，没东西可重绘'); setMaskNodeId(''); return }
              void (async () => {
                /* ★ 底图必须先取回来变成字节：后端的 `refs` 要字节，不要产物 id。
                 * 取不到就停下报错 —— 缺 refs 时任务会成功但结果是错的。 */
                const ref = await refBase64(art, '底图')
                if (!ref.ok || ref.data === undefined) {
                  setErr(ref.error ?? '取不回底图，无法局部重绘')
                  setMaskNodeId('')
                  return
                }
                const req: SubmitGenInput = {
                  kind: 'image',
                  op: 'inpaint',
                  prompt: (fromFlow(cur).data.prompt ?? '').trim(),
                  ...(fromFlow(cur).data.model ?? '').trim() === ''
                    ? {}
                    : { model: (fromFlow(cur).data.model ?? '').trim() },
                  ...(fromFlow(cur).data.channel ?? '') === '' ? {} : { channelId: fromFlow(cur).data.channel },
                  refs: [ref.data],
                  mask,
                  source: 'canvas',
                  canvasId,
                  canvasNodeId: maskNodeId,
                }
                if (req.prompt === '') { setErr('局部重绘要写提示词：想把这块改成什么'); setMaskNodeId(''); return }
                setMaskNodeId('')
                setErr('')
                doGenerate(maskNodeId, req, 'fresh')
              })()
            }}
            onClose={() => { setMaskNodeId('') }}
          />

          {/* 图像操作浮层（用户 m02814）：裁剪 / 拆图 / 抓帧。
           *
           * 挂在画布这一层（不在节点里）：节点有 `overflow: hidden`，
           * 浮层比节点宽，塞进去会被裁掉。位置按节点的屏幕坐标算。 */}
          {imageOpNode === null || imageOp === null
            ? null
            : (
              <div
                className={css.nodePanelAnchor}
                data-ewb-image-op-anchor=""
                style={(() => {
                  const pos = instRef.current?.flowToScreenPosition({
                    x: imageOpNode.position.x,
                    y: imageOpNode.position.y + (sizeOf(fromFlow(imageOpNode)).height) + 12,
                  })
                  return { left: pos?.x ?? 0, top: pos?.y ?? 0 }
                })()}
              >
                <ImageOpPanel
                  kind={imageOp.kind}
                  image={opImage ?? undefined}
                  /* 拿不到原图尺寸时**不当成不能做**，只是提示「按比例裁剪」——
                   * 裁剪的几何是归一化的，不知道像素也能裁（只是算不出会切出多大）。 */
                  blockedReason={undefined}
                  onCrop={doCrop}
                  onSplit={doSplit}
                  onFrame={doFrame}
                  onClose={() => { setImageOp(null) }}
                />
              </div>
            )}

          {/* ★ 右下角浮层（票 56：两边共用同一个组件）。
           *
           * ## 内容画布**不传** `showAutoLayout`
           *
           * 用户 2026-10-29 点名：「执行画布多了自动排版，这一点内容画布是不需要的，
           * 这一点不要遗漏了。」内容画布的节点是自由摆放的素材卡，
           * 没有「流程方向」这回事 —— 给它自动排版等于替用户乱挪图。
           *
           * 不传就是 false，**不是漏传** —— 判据 3 的反面断言守这一条。 */}
          <CanvasCornerControls
            kind="content"
            zoom={zoom}
            /* ⚠️ 本地先记下申请的缩放：React Flow 的 `onMove` 在真浏览器里紧接着会回来确认，
             * 但 jsdom 不做布局、`zoomTo` 不一定触发 `onMove`，那时界面上的百分比就永远不动。
             * 先记一笔让「拖了滑杆 → 百分比变」这条路在两边都成立。 */
            onZoom={(z) => { setZoom(z); void flow.zoomTo(z, { duration: 120 }) }}
            onFit={() => { void flow.fitView({ duration: 300 }) }}
            miniMap={miniMap}
            onToggleMiniMap={() => { putPrefs({ miniMap: !prefs.miniMap }) }}
            /* ★ 快捷键说明里 `Ctrl + Z / Y` 那一行也带上步数（票 02 第三处）。
             * 与底部条按钮 title、这一排上的步数小字同一个来源。 */
            undoWhat={undoHint(depths.past, depths.future)}
          />

          {/* ★ 还能撤销几步（票 02，用户 C3）。
           *
           * 改之前只有两个灰不灰的按钮，按下去之前不知道会撤几步 ——
           * 撤销栈最多 50 步，用户不知道自己停在第几步。
           *
           * ⚠️ 步数**直接取自 `depths`**（与按钮的 `disabled` 同一个 state）。
           * 另算一个数就会出现「按钮灰着却说可撤销 3 步」这种自相矛盾。
           *
           * 样式走 Tailwind 行内类（`pointer-events-none` 让它不挡画布点击）——
           * 本票的可改路径不含 `EcomWorkbench.module.css`，所以不往那里加类。 */}
          {/* ★ 撤销步数那条小字**已并进右下角那一排**（票 56，判据 5：
           * 「撤销步数在两边都常显」）。它现在的钩子是 `data-ewb-corner-undo`，
           * 由 `CanvasCornerControls` 渲染 —— 与按钮 `disabled` 同一个 `depths`。
           *
           * ⚠️ 原来那条 `[data-ewb-undo-hint]` 钩子**搬进了组件里**（同元素挂两个钩子），
           * 因为 `tests/content-canvas-ops.mjs` 有三处按旧钩子找它，而换锚点不是本票的活。 */}

          {/* ★ 左下角那排「点阵 / 线格 / 空白」**已整段删掉**（票 59，2026-10-29）。
           *
           * ## 用户原话
           *
           * 「当前内容画布左下角的背景调整进设置中，不单独出现，设置去右上角。」
           *
           * ## 搬去哪了
           *
           * 设置浮窗里的「背景」那一组（`CanvasSettingsPanel`，
           * 钩子 `data-ewb-settings-grid`）。那一组本来就存在 ——
           * 改前是**两处入口同时在**（画布上一排、面板里一排），
           * 这一票删掉画布上那排，只留面板里那排。
           *
           * ## 为什么整段删、不是 `display: none`
           *
           * 判据 1 要求 `[data-ewb-grid]` 在画布上**零命中**。
           * 用 `display: none` 藏起来的话，DOM 里还在、`querySelectorAll` 照样数得到，
           * 而用户按 Tab 键还能摸到一颗看不见的按钮 —— 那是真隐患，不是形式问题。
           *
           * 设置入口本身是票 54 搬走的（顶部悬浮条右端的 `data-ewb-tb="settings"`，
           * 同时保留 `data-ewb-settings-open` 钩子），那一处本票不动。
           *
           * ⚠️ **不许再加回来**：两处入口都能改时，用户不知道哪一处是对。 */}

          {/* ★ 画布设置（用户 m03414：「给内容画布加设置，参考执行画布的设置」）。
           * 每改一项都进 `putPrefs`，它会同步写进 `localStorage` —— 刷新不丢。 */}
          {settingsOpen
            ? (
              <CanvasSettingsPanel
                prefs={prefs}
                onChange={putPrefs}
                onReset={() => { putPrefs({ ...DEFAULT_PREFS }) }}
                onClose={() => { setSettingsOpen(false) }}
              />
            )
            : null}

          {/* 「替换」用的文件选择框（悬浮工具条触发）。 */}
          <input
            ref={fileRef}
            type="file"
            accept="image/*,video/*,audio/*"
            data-ewb-canvas-upload=""
            className="hidden"
            onChange={(e) => {
              /* 上传替换（契约 CH）：读文件 → `POST /materials` → 把返回的名字记进节点的
               * `reference`。素材与产物是两条路由（`/material/<name>` vs `/artifact/<id>`），
               * 所以这里记的是素材名，不是产物 id —— 见 `insertMaterial` 的同一条取舍。 */
              const id = uploadTargetRef.current
              uploadTargetRef.current = ''
              const file = e.target.files?.[0]
              e.target.value = ''
              if (id === '' || file === undefined) return
              void (async () => {
                try {
                  const buf = await file.arrayBuffer()
                  const sent = await uploadMaterial(file.name, bytesToBase64(new Uint8Array(buf)))
                  if (!sent.ok) { setErr(sent.error ?? '上传失败'); return }
                  record('upload:' + id)
                  setNodes(prev => prev.map(n => (n.id === id
                    ? { ...n, data: { ...n.data, reference: 'material/' + (sent.data ?? file.name) } }
                    : n)))
                  setErr('')
                } catch (err) {
                  setErr('上传失败：' + (err instanceof Error ? err.message : String(err)))
                }
              })()
            }}
          />
        </div>
      </div>

      <ContextMenu menu={menu} onClose={() => { setMenu(null); disarmDelete() }} />

      {/* 「模拟落位」保留：它验的是 `placeResult` 那条纯函数在界面上的接线。
       * 真生成接上之后这个按钮会去掉。 */}
      <button
        type="button"
        data-ewb-canvas-place=""
        className={css.canvasHiddenTestBtn}
        title="把一次生成结果放到选中的节点上（只验落位规则）"
        onClick={() => {
          const target = nodes.find(n => n.selected === true) ?? nodes[nodes.length - 1]
          if (target === undefined) return
          record('place')
          void import('./content-canvas-store.ts').then(({ placeResult }) => {
            const out = placeResult(nodes.map(fromFlow), target.id, { artifact: 'demo-' + Date.now().toString(36) })
            if (out.placed === 'none') return
            setNodes(out.nodes.map(toFlow))
          })
        }}
      >模拟落位</button>
    </div>
  )
}
