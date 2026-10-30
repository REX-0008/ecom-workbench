/** 版本 1 · 深色发光风 —— 画布主体。
 *
 * 结构：顶部工具条（运行/停止/保存/自动布局/缩放适配）+ 左侧可折叠节点库 + 中间画布 +
 * 节点旁浮卡（属性面板，点空白关闭）。
 *
 * 两个关键实现决定：
 *   1 自动布局用 elkjs（不自己写）——分层算法 'layered' 走 RIGHT 方向，天然的左→右流程。
 *   2 连线颜色跟随源端口色（D2 两重编码）——连线颜色在数据里就算好写死，
 *     不依赖 React Flow 的主题变量，所以深色底下颜色不会被冲掉。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import css_canvas_tokens from './canvas-tokens.module.css'
import css_workflow_canvas from './workflow-canvas.module.css'
import css_node_library from './node-library.module.css'
/* 票 54：画布内悬浮条（与内容画布**共用同一份零件**）。
 *
 * 用户 2026-10-29 甲 1-4：「两边都不要顶部栏，顶部在画布中悬浮，
 * 分左右侧、只留图标、右侧加主题色切换」。共用一个组件 = 两边不可能长歪。 */
import { CanvasDock, DockButton, CanvasTopBar, TopBarButton, TopBarDivider, modeToProps, toggleMode, type CanvasMode } from './CanvasToolbar.tsx'
import { CanvasCornerControls } from './CanvasZoomControls.tsx'
import { readPrefs as readWorkbenchPrefs, writePrefs as writeWorkbenchPrefs, type CanvasTheme } from './lib/workbench-prefs.ts'
import css_node_form from './node-form.module.css'
import {
  ReactFlow, Background, BackgroundVariant, MiniMap, Panel, ViewportPortal,
  addEdge, useNodesState, useEdgesState, SelectionMode,
  type Connection, type Edge, type NodeTypes, type NodeChange,
} from '@xyflow/react'
import ELK from 'elkjs/lib/elk.bundled.js'
import { PORT_COLORS, NODE_CATEGORIES, resolveCategory, type NodeDef, type OnError, type NodeState, type PortType } from '../../workflow/model.ts'
import { V1NodeCard, type V1Node, type V1NodeData } from './WorkflowNode.tsx'
import { GroupNodeCard } from './GroupNode.tsx'
/* 循环框：**既是可运行的节点、又是容器**（可以把别的节点拖进去）。
 * 与分组框的区别见该文件顶部。 */
import { LoopNodeCard } from './LoopNode.tsx'
/* 画布的**纯逻辑帮手**（端口中文名 / 分组占位定义 / 深色探测 / 跨容器提示 /
 * 容器取名 / 名字截断）—— 2026-10-17 从本文件搬出去，见那个文件的说明。 */
import { PORT_TYPE_LABEL, GROUP_DEF, detectDark, CAT_COLOR, NODE_TYPES, crossContainerHint, containerName, namePreview } from './canvas-helpers.ts'

import { useRunStore } from './run-store.ts'
import { V1_SAMPLE_NODES, V1_SAMPLE_EDGES } from './node-sample.ts'
import { NODE_LIBRARY } from './node-library.ts'
import { isValidConnection as checkConnection, whyInvalid } from './connection-rules.ts'
import { useHistoryStore, restoreSnapshot, type Snapshot } from './history-store.ts'
import { topoSort } from '../../workflow/topo.ts'
/* 条件左边能选什么（上游节点 / 循环变量 / 开始节点的输入）—— 规则在 `if-sources.ts`
 * （纯逻辑、可单测），这里只负责把画布节点递进去。
 * 为什么搬出去：本文件 import 了 `.module.css`，Node 直接跑不起来
 * （`ERR_UNKNOWN_FILE_EXTENSION`），而那段规则错了表现为「界面能选、跑起来取不到」。 */
import { ifSourcesFor, breakSourcesFor } from './if-sources.ts'
/* 共用的调度器（画布与宿主半**只此一份跑法**）。
 * 画布这边只负责「翻译输入」与「把事件画到界面上」，跑法语义全在这里面。 */
import { runGraph, type RunEvent } from '../../workflow/run.ts'
/* 「画布节点 → 调度器规格」的翻译与宿主半那条路**同一份**（`workflow/specs.ts`）。
 * 别再在画布里手写一遍 —— 曾经因此漏掉 `parentId` 与 `sourceHandle`，两处都出过真故障。
 * ⚠️ 从 `specs.ts` 引，**不能从 `run-file.ts` 引** —— 后者引 `store.ts`（用 `node:fs`），
 * 浏览器里没有。 */
import { toRunSpecsFromCanvas } from '../../workflow/specs.ts'
import { dispatchNode, probeEngine, saveWorkflowFile, listWorkflowFiles, saveSnapshot, listSnapshots, loadSnapshot, runWorkflowFile, recordCanvasRun, saveBrowserPrefs, loadBrowserPrefs, readUiPrefsCache, saveUiPrefs, subscribeUiPrefs, ensureUiPrefsLoaded, adoptUiPrefs } from './dispatch-client.ts'
import { useNotices, NoticeBar } from './notices.tsx'
import { type BrowserPrefs, readPrefs, resolveTag } from './browser-settings.ts'
/* 浏览器偏好的**共享存储**（唯一真值来源）。设置界面在 `WorkspaceSettings.tsx`，
 * 这里只读 + 在节点设置改动时写回 —— 不再自己持有一份 useState。 */
import { useBrowserPrefs, updateBrowserPrefs } from './WorkspaceSettings.tsx'
import { useDetectedBrowsers } from './browser-detect-store.ts'
import { hiddenEdgesOf } from './hidden-edges.ts'
import { hasSession } from './session-color.ts'
import type { KnownBrowser } from './NodeBrowserSection.tsx'
import { PANEL_H_VAR, PANEL_H_MIN, PANEL_H_MAX, PANEL_H_DEFAULT } from './NodeRunPanel.tsx'
import { SettingsDrawer, NODE_W_MIN, NODE_W_MAX, NODE_W_DEFAULT, EDITOR_H_MIN, EDITOR_H_MAX, EDITOR_H_DEFAULT, LAYOUT_SPACING_MIN, LAYOUT_SPACING_MAX, CANVAS_BG_MIN, CANVAS_BG_DEFAULT } from './SettingsDrawer.tsx'
import { takePending, onPending } from './pending-load.ts'
/* 存档格式的转换（纯函数，可单测）。抽出去的理由见该文件顶部说明。 */
import {
  toWorkflowDoc as toWorkflowDocOf, fromWorkflowDoc,
  timestampName, resolveSaveTarget, docFingerprint,
  type WorkflowDoc, type WorkflowFileRef,
} from './workflow-doc.ts'
import { nextSkipValue } from '../../workflow/skip.ts'
/* 「⎌ 恢复」找快照的规则（含老目录兜底）—— 提在 `snapshot-lookup.ts` 里以便测试。 */
import { LEGACY_SNAP_DIR, resolveSnapLookup, legacySnapNotice } from './snapshot-lookup.ts'
import { computeHelperLines, type HelperLine } from './helper-lines.ts'
/* 布局（ELK 分层 + 兜底网格 + 尺寸测量）：纯计算，已拆到独立文件。 */
import { NODE_W, NODE_H, elkLayout, measureNodes, measureRunPanels, fallbackGrid, autoSpacingFor, type LayoutDirection } from './canvas-layout.ts'
/* 图形派生（连线外观 + 可用变量）：纯函数，已拆到独立文件。 */
import { decorateEdge, computeAvailableVars } from './canvas-graph.ts'
/* 示例工作流**不再在初始状态里用了** —— 画布初始为空（2026-10-22）。
 *
 * ⚠️ 那段代码（`canvas-seed.ts` 的 `seedNodes()` / `seedEdges()`）**已经删了**（票 50，2026-10-28）：
 * 它零引用，而原来那句「文件保留：测试拿它当素材」是**错的** ——
 * 测试用的是 `node-sample.ts`（那个有真引用），从来不是它。 */
/* 分组 / 解组的坐标运算（纯函数，见 tests/group-ops.mjs）。
 * ⚠️ `groupBoxOf` + `attachToGroup` 与 `ungroupNodes` 是**互为逆运算**的一对：
 * 改分组算式就必须改解组算式，否则来回一次位置就漂了。 */
import { closeUnderTransit } from './group-ops.ts'
/* 编组的**几何层**（契约 CE，用户 m01076「编组照参考项目改」）。
 *
 * 2026-10-26 起组是**真节点**（`type: 'group'`），成员靠 `data.groupId` 指回去、
 * 坐标保持**绝对** —— 与参考项目 `lib/canvas/canvas-node-geometry.ts` 同一套。
 *
 * ⚠️ 上一版的名单模型（`group-roster.ts`）**文件保留但不在这里用了**：
 * 它的 `groupBox` / `moveGroupBy` 那套是「框是渲染时算出来的」，
 * 而现在的框自己就是一个节点，坐标就是真坐标。
 * ⚠️ 循环框仍然是 `parentId` 父子容器（调度器按它认循环体），**两套不许混**。 */
/* 组描述的字数上限（145，照 n8n 的 Canvas Groups）—— **从名单模型那个文件里引**，
 * 不在这里再写一个 145。那个文件现在只剩这一个常量还被用到（`groupBox` /
 * `moveGroupBy` 那套已经随名单模型下线），但常量还有效，抄一份会漂。 */
import { GROUP_DESC_MAX } from './group-roster.ts'
import {
  GROUP_NODE_TYPE, createGroupFromNodes, fitGroupToEnclosedChildren,
  captureEnclosedNodesIntoGroup, ungroupCanvasGroup, syncGroupMembershipAfterTransform,
  findGroupDropTarget, snapNodesIntoGroup, findContainingGroupId,
  toGeoNodes, applyGeoNodes, type GeoNode,
} from './group-geometry.ts'
/* 「选节点 + 选字段」参数的候选类型（循环的输入/输出用它，照 Dify 的 ValueSelector）。 */
import type { FieldCandidate, WorkflowCandidate } from './NodeEditorPopover.tsx'
/* 容器归属运算（拖进哪个容器 / 拖出来 / 贴边）：纯逻辑、可单测。
 * 与 `group-ops.ts` 的分工见该文件顶部。 */
import { assignToContainer, containerAt, containersOf, fitLoopBox, relayoutInside, orderLoopsInnerFirst, innerAxisOf, BOX_MIN_W, BOX_MIN_H, LOOP_DEF_ID, clampIntoLoop, loopTargetsFor, loopInnerBounds } from './container-ops.ts'
/* 展开节点时**让下游让位**（纯运算，见该文件头：为什么不用 ELK 做这件事）。 */
import { settleShift, refitLoopBox, nominalHeight, type ShiftTask } from './expand-shift.ts'
/* ★ 票 59：画布偏好（背景三档 / 三个透明度）**与内容画布共用同一份**
 * （`canvas-prefs.ts`，同一个 `localStorage` 键）。
 *
 * 用户要「两边同类归一」。票 59 之前执行画布的「画布底不透明度」是它自己
 * 一个键（`ewb.canvasBg`），内容画布根本没有；现在都走这里。 */
import {
  /* ⚠️ **必须起别名**：本文件第 60 行已经 import 了
   * `useBrowserPrefs` 那边的 `readPrefs`（浏览器偏好）。
   * 两个同名函数在同一个文件里是编译错误 —— 而两个概念又都叫「偏好」，
   * 不加前缀根本分不出。所以这里统一加 `Canvas` 前缀。 */
  readPrefs as readCanvasPrefs, writePrefs as writeCanvasPrefs, patchPrefs as patchCanvasPrefs,
  patternColorOf, DEFAULT_PREFS, type CanvasPrefs, type GridMode,
} from './lib/canvas/canvas-prefs.ts'
/* ★ 票 58：侧栏的 tab 条与内容画布**共用一套外壳**（`canvasSide*` 那组类就住在
 * `EcomWorkbench.module.css` 里）。本文件原来只 import 了 `node-library.module.css`。
 *
 * ⚠️ 两个 CSS Modules 各给类名加 hash，所以「共用一套类」**必须** import 同一个文件。 */
import css from './EcomWorkbench.module.css'
/* 节点卡片「我撑高了」的报到（模块级订阅，见那个文件头：为什么不用 window 事件）。 */
import { setExpandShiftListener } from './expand-ping.ts'
/* 右键菜单（三种上下文共用，见该文件头注释）。 */
import { ContextMenu, type MenuEntries, type MenuState } from './ContextMenu.tsx'
/* 右键菜单的图标（2026-10-26 用户要求「图标统一」）。
 *
 * 原来这里是**字符**（`⤢` `▣` `🗑` …）。字符的问题：不同系统字体下粗细不一，
 * `🗑` 在部分环境还是彩色 emoji 方块；而且板块那一层用的是 `icons.tsx` 的真 SVG，
 * **两套并存**看着像两个人做的。这批图标照 lucide v0.441.0 的 path 内联，
 * 零依赖（`package.json` 一个字没动）。 */
import {
  PlayIcon, FastForwardIcon, StepForwardIcon, SkipForwardIcon,
  CopyIcon, CopyPlusIcon, ClipboardPasteIcon, TrashIcon,
  SelectAllIcon, GroupIcon, BoxSelectIcon, MaximizeIcon,
  ArrowRightIcon, ArrowDownIcon, ChevronsDownIcon,
  CornerUpRightIcon, CornerDownRightIcon, PlusIcon,
  /* ⚠️ 票 63：`FilePlusIcon` / `FileOutputIcon` / `FolderOpenIcon` 已去掉 ——
   * 它们只服务被删的那三颗按钮（新建 / 另存为 / 打开）。保存那颗仍在，所以 `SaveIcon` 留着。 */
  StopIcon, SaveIcon, CameraIcon,
  HistoryIcon, UndoIcon, RedoIcon, SettingsIcon, MapIcon, PaletteIcon,
  LockIcon, UnlockIcon,
  /* 票 54：悬浮条要用的两个（一个补侧栏开关，一对是主题两态）。 */
  PanelLeftIcon, SunIcon, MoonIcon,
  /* 票 58：侧栏折叠按钮要 SVG（原来是 `‹ / ›` 两个字符）。 */
  ChevronLeftIcon, ChevronRightIcon,
} from './icons.tsx'

/**
 * 节点分类 → 颜色。
 *
 * 与样式表里的 `--node-cat-*` 是**同一套值**（这里给 JS 用，CSS 那边给样式用）。
 * 为什么两处：小地图要按分类上色（JS 里算），节点顶部色条用 CSS 变量（样式里算）。
 * 保持一致的做法：改一处时两处一起改，注释里互相指向。
 */





/**
 * 把节点库宽度存下来（**双写**：缓存 + 文件）。
 *
 * 抽成模块级函数而不是写在 `onLibDragUp` 里，因为**两处**都要存：
 * 拖完松手一次、双击节点库边缘复位一次。两处各写一遍必然漂
 * （见 `pitfalls/同一件事写两份迟早漂.md`）。
 *
 * @param w - 要存的宽度（像素）。
 */
/**
 * 节点库（执行画布侧栏）的默认宽度（px）。
 *
 * ⚠️ **2026-10-29（票 58）212 → 260**：用户定两侧栏默认宽度统一 260。
 * 内容画布那边的回落值也是 260（`CanvasSidePanel.tsx` 的 `clampPanelWidth`）。
 */
export const LIB_W_DEFAULT = 260

/** 节点库宽度的上下限（与 `CanvasSidePanel` 的 `PANEL_MIN` / `PANEL_MAX` 同一组）。 */
export const LIB_W_MIN = 180
export const LIB_W_MAX = 460

/**
 * 把宽度夹进上下限之间（票 58）。
 *
 * ## 为什么要它
 *
 * 改之前执行画布的宽度只有下限感（`Math.max(160, …)`）而没有统一的上限常量，
 * 内容画布那边却有 `clampPanelWidth`（180–460）。两边边界不一致的后果很具体：
 * 同样拖到底，一边 460 一边 420。
 *
 * @param w - 想要的宽度。
 * @returns 夹过的宽度。
 */
export function clampLibW(w: number): number {
  if (!Number.isFinite(w)) return LIB_W_DEFAULT
  return Math.max(LIB_W_MIN, Math.min(LIB_W_MAX, Math.round(w)))
}

/**
 * Save the sidebar width in pixels, clamped to the supported range. A successful
 * response with preferences also updates the in-memory preferences. The request
 * is not awaited, and a rejected request is not handled here.
 */
function persistLibW(w: number): void {
  void saveUiPrefs({ libW: clampLibW(w) }).then(r => {
    if (r.ok && r.prefs !== undefined) adoptUiPrefs(r.prefs)
  })
}

/**
 * 版本 1 画布。
 * @param props.active - 画布是不是**当前可见**的那一屏（默认 true）。
 *   常驻挂载后画布可能被藏起来（切到别的 tab/板块），但它的全局键盘监听、
 *   React Flow 的交互都还活着 —— 不拦住的话，用户在列表页按 Ctrl+Z / Delete
 *   会**默默改到看不见的画布上**。所以隐藏时必须停掉这些入口。
 * @param props.topHidden - 顶部标题是否已收起。
 *   ⚠️ **2026-10-22 起画布不再用它**：收起顶部的按钮搬去了骨架
 *   （tab 条左端 + 侧栏底部两处，见 `EcomWorkbench.tsx` 的 `data-ewb-top-toggle`）。
 *   参数**先留着**：骨架那边还在传，删掉要同时改 `WorkflowBoard` 的转手，
 *   而这一批只搬按钮、不改接口。将来确认没人用再一起删。
 * @param props.onToggleTop - 同上，保留但画布内已无调用点。
 * @returns 画布界面元素。
 */


export function WorkflowCanvas({ active = true, topHidden = false, onToggleTop }: {
  active?: boolean
  topHidden?: boolean
  onToggleTop?: () => void
} = {}) {
  /* 两个参数现在都没有调用点 —— 显式 void 一下，让读代码的人知道是**故意**保留的，
   * 也让 lint / tsc 不把它们当成「漏用」。 */
  void topHidden
  void onToggleTop
  const defs = useMemo(() => new Map(NODE_LIBRARY.map(d => [d.id, d])), [])
  /* ⚠️ **初始为空**（用户 2026-10-22 定：「重启后未打开任何工作流时，画布应当是空的」）。
   *
   * 以前这里是 `seedNodes()` / `seedEdges()` —— 打开画布先看到一份示例工作流。
   * 那份示例本意是「第一眼知道画布长什么样」，实际效果是**用户分不清
   * 「这是我建的吗」**，还以为自己有一份没保存的活儿。
   *
   * 清空能力本来就有（工具条「新建」走 `newWorkflow`），这里让初始态与它一致。
   *
   * ## 保留下来的只有 `node-sample.ts`
   *
   * 它有真引用（`WorkflowCanvas.tsx:33` 直接 import 它、`canvas-seed` 删掉之后
   * 它仍是「往画布塞节点」的素材来源）。
   *
   * ⚠️ **`canvas-seed.ts` 已经删了**（票 50，2026-10-28）。
   *
   * 这里原来把「它」与 `node-sample.ts` 一起算作**还在用的素材来源**，
   * 而**那个判断是错的**：它在整个仓库里零引用（`import` / `export from` /
   * `require` / `await import()` 四种形态全零命中），
   * 测试用的从来是 `node-sample.ts`。
   *
   * 给「留着」编一个理由，比不写理由更糟 —— 下一个人会照着那个理由去找一个
   * 不该在的文件，找一个不存在的东西时还会以为是自己找错了。 */
  const [nodes, setNodes, onNodesChange] = useNodesState<V1Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [libOpen, setLibOpen] = useState(true)
  /**
   * 底部主操作位那个常驻的模式开关（票 55，用户甲 7）。
   *
   * ## 与按住 Ctrl 的关系
   *
   * 两件事，不冲突：
   *   · **这个按钮** = 常驻模式（`select` 框选 / `pan` 平移），不用一直按键
   *   · **按住 Ctrl** = React Flow 自己的临时切换（`selectionKeyCode="Control"`）
   *
   * 内容画布从票 02 起就是这个模型（`CanvasToolbar.tsx` 的 `modeToProps`），
   * 这里**直接复用同一个纯函数**，不另写一套规则 —— 两边语义必须一致。
   */
  /* ★ 票 01（2026-10-30）：**默认鼠标逻辑改成「移动」**（与内容画布同一个理由）。
   *
   * 用户原话：「将两个画布默认的鼠标逻辑切换到移动。」
   *
   * 框选没有丢：`selectionKeyCode={['Control', 'Space']}` 仍在，
   * 按住 Ctrl 或空格拖动就是框选。 */
  const [dockMode, setDockMode] = useState<CanvasMode>('pan')
  const [selected, setSelected] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  /** 运行回调的稳定引用（避免把 runSeq 放进 useEffect 依赖导致无限重渲染）。 */
  const runOneRef = useRef<(id: string) => void>(() => { /* 挂载前为空 */ })
  const runFromRef = useRef<(id: string) => void>(() => { /* 挂载前为空 */ })
  const onParamRef = useRef<(id: string, key: string, value: unknown) => void>(() => { /* 挂载前为空 */ })
  const onOnErrorRef = useRef<(id: string, v: OnError) => void>(() => { /* 挂载前为空 */ })

  /**
   * 记录一次操作前的状态（在会改动画布的操作**之前**调用）。
   *
   * ⚠️ **定义位置是硬约束**：它必须排在所有使用它的回调之前。
   * 这个坑踩过三次——放在后面时，依赖数组在渲染期求值就会报
   * 「Cannot access X before initialization」（暂时性死区），**整个插件崩掉**。
   * 所以现在固定在 ref 声明之后、所有 useCallback 之前。
   */
  const recordHistory = useCallback((): void => {
    useHistoryStore.getState().push(nodesRef.current, edgesRef.current)
  }, [])

  /**
   * 清空让位的**记账本**。
   *
   * 为什么必须有这一步：撤销/重做/恢复/打开会把坐标整批换掉，
   * 而记账本还记着「谁被推了多少」—— 下一次收起就会把这份偏移
   * 加到**撤销之后**的坐标上，表现为「什么都没干，节点自己动了」。
   * 所以这四个换图的入口都要清一次。
   */
  /**
   * 上一轮让位的**输入签名**（`id:取整后的长高量` 拼起来）。
   *
   * 用来挡住「高度每帧抖 1px → 每轮都 setNodes → 更新深度超限」那条环
   * （React #185，用户 2026-10-21 白屏的成因）。详见 `runShift` 里的长注释。
   *
   * 空串 = 还没有过有效输入（第一轮一定要让它算）。
   *
   * ⚠️ 声明在 `clearShift` **之前** —— 它要清这个值，而 `check:tdz` 抓
   * 「用在定义之前」（本项目高频白屏坑）。
   */
  const shiftSigRef = useRef<string>('')

  const clearShift = useCallback((): void => {
    /* ⚠️ 清成**空 Map** 而不是 null：让位量是「节点 id → 加在它自己 y 上的量」，
     * 空表就是「没有任何让位」—— 与「没算过」是同一个意思，少一个空值分支。 */
    shiftRef.current = new Map()
    /* 换图之后上一次的签名没有意义了 —— 不清的话「同一份图重新打开」
     * 第一轮就会被闸门挡掉（看着像「打开后布局没生效」）。 */
    shiftSigRef.current = ''
  }, [])

  /** 节点列表的稳定引用（runSeq 里读它，避免把 nodes 拖进依赖链）。 */
  const nodesRef = useRef<V1Node[]>([])
  /** 连线列表的稳定引用（复制时读它，避免依赖链）。 */
  const edgesRef = useRef<Edge[]>([])
  /** 浏览器偏好的稳定引用（同步第二层时读它，避免拖进依赖链）。 */
  const browserPrefsRef = useRef<BrowserPrefs>(readPrefs())
/** 编组名单的稳定引用 —— **2026-10-26 已不需要**（契约 CE：组变成真节点，
 * 不再有一份独立的名单要同步）。这里留着这个注释，是为了让下一个人知道
 * 「以前这里有个 `groupsRef`，它随名单模型一起删掉了」，而不是以为漏了。 */
  /** 剪贴板的稳定引用（复制/粘贴用，模块内存储，不跨页面）。 */
  const clipboard = useRef<{ nodes: V1Node[], edges: Edge[] } | null>(null)
  /**
   * 正在拖的那个**组**的起点（框 + 它当时的成员起点）。
   *
   * 为什么需要：框不是父容器（成员没有 `parentId`），React Flow 不会让成员跟着走。
   * `onNodeDragStart` 记起点、`onNodeDrag` 按总位移同步推走成员、`onNodeDragStop` 清掉。
   * 清不掉的话，下一次拖**普通节点**时会用上一组的成员表推一批不相干的节点。
   */
  const groupDragRef = useRef<{ id: string, origin: { x: number, y: number }, members: Map<string, { x: number, y: number }> } | null>(null)
  /**
   * `refitNodes` 的稳定引用（收起/展开要在 `setNodes` 里连着重算尺寸用它）。
   *
   * 为什么要 ref：`toggleCollapseRef` 的赋值在文件很早处（`refitNodes` 定义之前），
   * 而收起必须**先翻 `collapsed`、再让 `fitLoopBox` 按新值重算高度** ——
   * 两件事得在同一拍里做（两次 `setNodes` 会互相覆盖）。
   * 直接用 `refitNodes` 会命中「用在定义之前」（`check:tdz` 专抓，本项目的高频白屏坑）。
   */
  const refitNodesRef = useRef<(base: V1Node[]) => V1Node[]>((b) => b)
  /**
   * 展开让位的**记账本**：这次展开推了谁、推了多少。
   *
   * 为什么需要它：收起时要**一模一样地退回去**。不记账就只能重算一遍，
   * 而重算的判据是「谁被压住」—— 那时节点已经移过位，算出来的是另一批（回不干净）。
   *
   * 用 ref 不用 state：它只在事件与 effect 里读写，不参与渲染。
   */
  const shiftRef = useRef<Map<string, number>>(new Map())
  /**
   * 已经算好、**还没被渲染消费**的那一版节点数组。
   *
   * 为什么需要它：一次提交里可能有好几个节点同时报到（比如一次程序化地展开/收起一片），
   * 每一次报到都会跑一遍 `runShift`，而 `nodesRef.current` 要等渲染才更新 ——
   * 不接着上一版算，后一次就会把前一次的结果**整个覆盖掉**。
   * 每次渲染（`nodesRef.current = nodes` 那一行）会把它清掉，所以它不会过期。
   */
  const shiftPendingRef = useRef<V1Node[] | null>(null)
  /**
   * 各节点**输出面板**的实测高度（画布坐标）。
   *
   * 让位的算式要的是「节点比素净卡片高了多少」，所以每轮都要把面板那一截
   * 从实测高度里减掉（见 `nominalHeight` 的第二个参数）。
   */
  const shiftPanelRef = useRef<Map<string, number>>(new Map())
  /**
   * 最近一次实测的节点尺寸表（`useLayoutEffect` 里量）。
   *
   * 为什么记在 ref 里：`measureNodes` 读 DOM，只能在渲染之后跑；
   * 而让位还要知道**循环框**的尺寸（它写在 `style` 上、量得到。
   * `measureNodes` 的宽高都取自 `getBoundingClientRect`，**已经除过缩放**）。
   */
  const shiftSizeRef = useRef<Map<string, { w: number, h: number }>>(new Map())
  /**
   * 上一轮让位的**输入签名**（`id:取整后的长高量` 拼起来）。
   *
   * 用来挡住「高度每帧抖 1px → 每轮都 setNodes → 更新深度超限」那条环
   * （React #185，用户 2026-10-21 白屏的成因）。详见 `runShift` 里的长注释。
   *
   * 空串 = 还没有过有效输入（第一轮一定要让它算）。
   */
  /* ⚠️ 这个 ref 的**唯一声明**在 `clearShift` 之前（那里要清它）。
   * 这里原来又声明了一次（我第一版加的），重复 `const` 会让整个文件语法错误。 */

  /** React Flow 实例 API（拖入落位用它换算坐标；由 onInit 填）。 */
  const flowToScreenApi = useRef<{
    screenToFlowPosition: (p: { x: number, y: number }) => { x: number, y: number }
    fitView: (o?: { padding?: number }) => void
    /** 放大一档（缩放快捷键用）。 */
    zoomIn?: (o?: { duration?: number }) => void
    /** 缩小一档。 */
    zoomOut?: (o?: { duration?: number }) => void
    /** 直接设缩放值（Ctrl+1 回到 100%）。 */
    zoomTo?: (level: number, o?: { duration?: number }) => void
    /** 把视野移到某点（搜索定位用）。 */
    setCenter?: (x: number, y: number, o?: { zoom?: number, duration?: number }) => void
    /** 取当前缩放级别。 */
    getZoom?: () => number
  } | null>(null)

  /* 编辑方式**已固化**为「节点内展开」（2026-10-08 用户定：弹框不要了）。
   * 原先有 popover / inline 两种可切换，现已删除弹框那一档。
   * 节点 data 里的 editMode 字段仍保留（值恒为 inline），因为节点组件读它判断是否展开。 */
  /** inline 模式下当前展开的节点 id（点其他节点/点画布收起）。 */
  const [expandedNode, setExpandedNode] = useState<string | null>(null)
  /** 节点库里哪些分类是展开的（默认全展开；空集合表示全折叠）。 */
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({})

  /** 节点库搜索关键词（空＝不过滤）。 */
  const [libQuery, setLibQuery] = useState('')
  /**
   * 节点库宽度（可拖拽调整，参考 Langflow 的 resizable 侧栏）。
   *
   * ⚠️ **首帧读缓存、文件到了再校正**（2026-10-22）：缓存住在 `localStorage`，
   * 而它按「域名 + 端口」隔离 —— 启动器用 `--port 0`、端口每次变，
   * 所以缓存经常是空的。文件（`ui-prefs.json`）才是权威，见 `dispatch-client.ts`。
   */
  /* ★ 票 58：默认宽度 212 → **260**（与内容画布那个侧栏统一）。
   *
   * 兜底也写 260 —— 只改一边会出现「首帧 212、文件到货跳 260」。 */
  const [libW, setLibW] = useState<number>(() => readUiPrefsCache().libW ?? LIB_W_DEFAULT)
  /**
   * 三个与文件偏好相关的键：用户是不是**自己动过**。
   *
   * 文件要一次网络往返，用户可能在这之前就拖了节点库、点了图例、拉了宽度滑块。
   * 动过之后还照文件覆盖，就等于把刚做的操作吞掉（画面上是「自己弹回去」）。
   * 所以这三道闸门一旦置 true 就不再被文件校正。
   *
   * ⚠️ 声明位置**必须在下面的 `onLibDragUp` 之前** —— 它要读这个 ref。
   * 放在后面对运行时也没事（回调是后执行的），但读代码的人会以为踩了 TDZ。
   *
   * 用 ref 而不是 state：只用来「读一眼」，改了不需要重渲染
   * （本项目对多余渲染很敏感，见 `EcomWorkbench` 的注释）。
   */
  const prefsTouched = useRef({ libW: false, legend: false, nodeW: false })
  /** 节点库拖宽是否进行中。 */
  const libDrag = useRef(false)

  /** 开始拖节点库宽度。 */
  const onLibDragDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    libDrag.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }, [])

  /** 拖节点库宽度中（钳制 160~420）。 */
  const onLibDragMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!libDrag.current) return
    const wrap = wrapRef.current
    if (wrap === null) return
    const left = wrap.getBoundingClientRect().left
    const next = Math.min(420, Math.max(160, e.clientX - left))
    setLibW(next)
  }, [])

  /**
   * 结束拖节点库宽度并记住。
   *
   * ⚠️ **只在松手时写**，不是拖动过程中每一帧都写 —— 拖动一次会经过几十个宽度，
   * 每帧发一个请求既没必要也会把宿主半刷满。松手时的那个宽度才是用户要的。
   * 写是**双写**（缓存 + 文件），只写一个会闪或会丢。
   */
  const onLibDragUp = useCallback(() => {
    if (!libDrag.current) return
    libDrag.current = false
    prefsTouched.current.libW = true
    persistLibW(libW)
  }, [libW])

  /** 按分类给节点分组（委托人的两层规则：节点可声明 category，也可不声明归到兜底）。
   * 带搜索过滤：匹配「名称 / id / 说明」任一即命中。 */
  const libByCat = useMemo(() => {
    const q = libQuery.trim().toLowerCase()
    const hit = (d: NodeDef): boolean => q === ''
      || d.label.toLowerCase().includes(q)
      || d.id.toLowerCase().includes(q)
      || (d.summary ?? '').toLowerCase().includes(q)
    const m = new Map<string, NodeDef[]>()
    for (const d of NODE_LIBRARY) {
      if (!hit(d)) continue
      const c = resolveCategory(d)
      const arr = m.get(c) ?? []
      arr.push(d)
      m.set(c, arr)
    }
    // 按 NODE_CATEGORIES 的顺序输出，空分类不显示
    return NODE_CATEGORIES
      .map(c => ({ cat: c, defs: m.get(c.id) ?? [] }))
      .filter(x => x.defs.length > 0)
  }, [libQuery])

  /**
   * 连线颜色图例是否展开（记住选择）。
   *
   * ⚠️ 这里原来写的是 `!== '0'`（缓存里没有就当作开）—— 那个判据会把
   * 「文件里明确存了 false」当成没存。现在改成从 `readUiPrefsCache()` 取：
   * 缓存里**没有**这个键时才回落默认 `true`，有 `false` 就照 false 渲染。
   */
  const [legend, setLegend] = useState<boolean>(() => readUiPrefsCache().legend ?? true)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  /* 注：React Flow 实例统一放 flowToScreenApi（见上），不再另设 wrapFlow。 */
  const idRef = useRef(100)
  /** 画布上的提示条（保存/导入/加载的成败都从这里说出来）。 */
  const { notices, notify, dismiss } = useNotices()
  /**
   * React Flow 内部报错的转发（如「容器尺寸为 0」）。
   *
   * ⚠️ **必须用 `useCallback` 包成稳定引用**（2026-10-21 修的真 BUG，React #185）：
   * 这个函数最后传给 `<ReactFlow onError={…}>`，而 React Flow 的 `StoreUpdater`
   * 把 `onError` 列进了 `fieldsToTrack` —— 它的 effect 依赖就是这一串 props，
   * **引用一变 effect 就重跑**，重跑里 `store.setState({ onError })` 又让订阅者重渲染。
   * 原来写内联箭头函数 → 每帧新引用 → 环闭合 → 更新深度超限，整块画布白屏。
   */
  const onFlowError = useCallback((code: string, msg: string): void => {
    notify('画布错误 ' + code + '：' + msg, 'error')
  }, [notify])
  /** 拖动时显示的对齐辅助线（空数组＝没在拖或没对齐）。 */
  const [helperLines, setHelperLines] = useState<HelperLine[]>([])
  /**
   * ## 编组：**没有独立的名单了**（2026-10-26 契约 CE）
   *
   * 用户 m01076 定案「编组照参考项目改」，组从「一份名单」变成 `nodes` 里的**真节点**
   * （`type: 'group'`），成员靠 `data.groupId` 指回去、坐标保持**绝对**。
   *
   * 上一版（2026-10-13 ~ 10-25，照 n8n）这里有一份 `groups: NodeGroup[]`，
   * 框是渲染时按成员包围盒算出来的假节点。现在那份名单**不存在了** ——
   * 它带来的所有同步点（改名、改描述、删节点时摘成员、拖框转位移给成员）一起消失。
   *
   * ⚠️ **循环框仍是 `parentId` 父子容器**（调度器按它认循环体），
   * 与组的 `groupId` 是**两套**，不许混 —— 混用会让「组一动成员全飞」。
   */


  /**
   * **当前编辑的是哪一份工作流文件**（照 n8n 的 `workflowId` + `isNewWorkflow`）。
   *
   * ## 为什么要有它（2026-10-14 用户报的 bug）
   *
   * 用户原话：「我打开的明明是天猫取数，但是我保存的时候成了保存新文件：
   * 工作流-2026-10-14T1224。是不是当前画布根本没有记录当前编辑的是哪个工作流，
   * 每次都是一个没有归属的画布，这个功能要补齐。」
   *
   * 事实：改动前画布**确实不记录**归属，`save` 里**永远**生成时间戳名字 ——
   * 所以「覆盖原文件」这件事在代码里根本不可能发生，用户看到的是必然结果。
   *
   * ## 做法（用户 2026-10-14 定：「用 N8N 那套」）
   *
   * 一个可空的归属 + 一个「是不是新的」：有归属 → 保存**覆盖**那个文件；
   * 没归属（`isNew: true`）→ 保存**新建**一个时间戳名字，并**当场获得归属**。
   * 完整说明与三个名字（文件名 / 文件里的 name / 显示名）的关系见
   * `workflow-doc.ts` 的「存档归属」一节。
   *
   * 归属只在两处改变：**打开一份已存的工作流**（得到归属）、
   * **保存 / 另存为成功**（得到归属）。清空画布不在这里做（见交付说明）。
   */
  const [file, setFile] = useState<WorkflowFileRef>({ name: '', isNew: true })
  /**
   * 归属名的**稳定引用**（`runSeq` 跑完要拿它上报运行历史）。
   *
   * 为什么用 ref 不用 state：`runSeq` 的依赖数组里放 `file` 会让它每次保存
   * 都换新引用 → 连带 `runAll` / `runOne` / `runFrom` 全换 → 节点 data 的回调
   * 也换 → 触发那个 `setNodes` effect。那条链正是本文件反复防的死循环来源
   * （见文件头「关键防循环措施」）。上报只需要**那一刻的值**，不需要触发重渲染。
   */
  const fileRef = useRef<WorkflowFileRef>({ name: '', isNew: true })
  /**
   * 从存档里读出来的**一句话说明**（工作流列表里显示的那一行）。
   *
   * ⚠️ **画布上现在没有编辑它的入口，但必须持有并回写** ——
   * 2026-10-15 的 F1（T9 查出）：`toWorkflowDoc` 此前根本不写 root 级 `description`，
   * 于是「在画布上点一次保存」就把存档里原有的说明**冲掉**，列表里那行随之消失。
   * 实证据：`天猫取数.json` 有 `description`，而画布存出的
   * `工作流-2026-10-14T1224.json` 没有（两者节点序列完全相同）。
   *
   * 所以这里只做「读进来 → 原样写回去」的搬运。将来加编辑入口时，改这个 state 即可。
   */
  const [description, setDescription] = useState('')
  /**
   * 这份工作流的**稳定编号**（2026-10-19 加，用户「引用用编号不用名称」）。
   *
   * ## 为什么画布必须持有并回写
   *
   * `flow.workflow` 节点引用别的工作流时存的是编号。若画布保存时不写 `id`，
   * 宿主半只能按**文件名**派生 —— 而一份改过名的存档，它原本的编号是按旧名字算的，
   * 保存一次就换编号 → 所有引用它的地方全断。
   *
   * ⚠️ 与 `description` / `types` 同一套搬运：打开时读出来、保存时写回去。
   * 空串 = 这份存档还没有编号（老存档第一次保存时由宿主半补，画布不猜）。
   */
  const [wfId, setWfId] = useState('')
  /**
   * 工作流类型（用户 m00861：「几十份工作流才能分清谁是什么」）。
   *
   * ⚠️ 与 `description` **同一个搬运逻辑**：读出来拿着、保存时原样写回去。
   * 不带回去的话，「打开 → 保存」一趟会把列表页里填的类型冲掉 ——
   * 那个坑 `description` 已经踩过一次（见上面那段）。
   *
   * ⚠️ 它与 `flow.start` 节点的「谁能启动它」是**两件事**（用户 m00901 定案）：
   * 那一个是**执行判据**（决定能不能被别的流程调），这个只是给人看的标签。
   */
  const [types, setTypes] = useState<string[]>([])
  /**
   * 上一次写盘时的内容指纹（`''` = 从没存过，或内容已经变了）。
   *
   * 判据是**内容指纹**而不是「有没有人在操作」——后者必然误报：
   * 打开后随便点一下节点也算「改动」，用户会一直看到「未保存」而不再相信这个标记。
   * 指纹怎么算见 `workflow-doc.ts` 的 `docFingerprint`（故意排除 `name` 与运行状态）。
   */
  const [savedFp, setSavedFp] = useState<string>('')
  /**
   * 本机已保存的工作流清单（名字 + 编号）—— `flow.workflow` 节点的「选一份」控件用它。
   *
   * ## 为什么要在这里持有（2026-10-19）
   *
   * 「跑另一份工作流」的参数从「填名字」改成「选编号」之后，控件需要一个候选清单。
   * 清单只有宿主半知道（存档目录在磁盘上），而节点定义是**纯数据、不能发请求** ——
   * 所以由画布取一次、随 `data` 传进节点卡片。
   *
   * ## 为什么在挂载时取、且失败不报错
   *
   * 它是**辅助信息**：取不到时控件会显示「本机还没有别的工作流可选」，
   * 而画布本身照常能用（真正要跑的时候宿主半还会再解析一次引用）。
   * 为了一条辅助清单把画布卡住或弹一堆错误，不值得。
   *
   * ⚠️ 刷新时机：保存 / 另存为成功之后（新存的那份要出现在清单里）。
   * 别的时机（比如在列表页新建了一份）不刷新 —— 画布看不到那个 tab 的动作，
   * 但**不影响正确性**：候选少一项而已，不会指错。
   */
  const [wfCandidates, setWfCandidates] = useState<WorkflowCandidate[]>([])
  const reloadWfCandidates = useCallback((): void => {
    void (async () => {
      const list = await listWorkflowFiles()
      if (!list.ok) return
      /* ⚠️ **只收有编号的**：编号是参数里存的值，没有编号的条目选了也存不进去。
       * （宿主半一定会给编号；这条是防「接口被换掉 / 老版本宿主半」那种情况 ——
       * 没有它，候选里会混进一批 `id: ''` 的项，下拉的 `key` 也不唯一，
       * React 会报「two children with the same key」并可能渲染出重复项。） */
      setWfCandidates(list.items.filter(x => x.id !== '').map(x => ({ id: x.id, name: x.name })))
    })()
  }, [])
  useEffect(() => { reloadWfCandidates() }, [reloadWfCandidates])
  /* ── 拖动改归属那套已整体删除（2026-10-13）──────────────────────────
   *
   * 删掉的状态：`dropTargetId` / `hoverCandidateId` / `leaveFromId` /
   * `hoverTimerRef` / `intentRef` / `dragHint` / `pointerRef`。
   *
   * ## 为什么删（用户定的规矩 + 直接判定）
   *
   * 用户 2026-10-13：「改一下 agents.md，将之前的参考 N8N 改为参考 N8N 和 dify，
   * **他们都没有的就不做**」，并指出「循环就应该从循环内部开始，
   * 出入都不应该在里面的节点上」。
   *
   * 查证：**两家都不靠拖动改容器归属** ——
   *   - n8n：组的成员由**连线**决定（连线时自动吸收；不合法的线直接拒绝），
   *     没有「拖进拖出」，连「单个移出」都没有（只能整组解散）；
   *   - Dify：归属在**加节点那一刻**由邻居的 `parentId` 继承；
   *     已在容器里的节点**拖动时被钳住**（`getRestrictedIterationPosition`），出不去。
   *
   * 我们原来那套（悬停 1 秒确认 + 半进半出 + 连带移出 + 鼠标旁提示）是**自己发明的**，
   * 也正是最费时间、最容易出问题的那部分（踩过框跳走、覆盖移出、假绿断言多次）。
   * 按新规矩删掉。
   *
   * 归属改由两处确定（见 `addNode` 与右键菜单）：
   *   1. 从节点库加到画布时，落点在容器内 → 归它（「加的那一刻定」，与 Dify 同）；
   *   2. 右键菜单「放入循环 / 移出循环」（显式、可控）。
   */
  /**
   * 当前是亮色还是暗色（React Flow 的 colorMode 用）。
   *
   * 为什么需要：`<ReactFlow colorMode="dark">` 是**写死**的，
   * 它会让 React Flow 套用它自带的深色默认值（底色 #141414 等），
   * 于是画布**永远深色**、不跟 dsh 主题走。这就是「画布底还是黑的」的根因。
   *
   * 探测方式（dsh 用 data-theme 属性 + 系统偏好兜底）：
   *   1. 先看 <html> 上的 data-theme / class 有没有 dark 标记
   *   2. 没有就跟随系统的「深色模式」偏好
   * 用 MutationObserver 监听属性变化，用户切主题时画布立刻跟上。
   */
  const [dark, setDark] = useState<boolean>(() => detectDark())
  useEffect(() => {
    const el = document.documentElement
    const sync = (): void => { setDark(detectDark()) }
    sync()
    /* dsh 把主题属性挂在 <body> 上（data-ds-dark-theme），所以两个元素都要看。
     * MutationObserver 要防不存在——测试环境（jsdom）没有它，真实浏览器有。 */
    const mo = typeof MutationObserver === 'function' ? new MutationObserver(sync) : null
    mo?.observe(el, { attributes: true, attributeFilter: ['data-ds-theme-source', 'style', 'class'] })
    if (document.body !== null) mo?.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
    /* matchMedia 可能不存在（测试环境），存在时才监听。 */
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
    mq?.addEventListener('change', sync)
    return () => {
      mo?.disconnect()
      mq?.removeEventListener('change', sync)
    }
  }, [])

  /**
   * 启动时问一次文件里的偏好；到了就校正画布这三个尺寸 / 开关。
   *
   * ⚠️ 闸门见上面 `prefsTouched` 的说明：用户动过的那个键不再被文件覆盖。
   */
  useEffect(() => {
    /* 这个组件是常驻挂载的（切走只藏起来），所以这次 effect 一辈子只跑一次；
     * `ensureUiPrefsLoaded` 本身也是幂等的，与骨架那边共用同一次请求。 */
    void ensureUiPrefsLoaded()
    return subscribeUiPrefs(p => {
      if (!prefsTouched.current.libW) setLibW(p.libW)
      if (!prefsTouched.current.legend) setLegend(p.legend)
      if (!prefsTouched.current.nodeW) setNodeW(p.nodeW)
    })
  }, [])

  /** 设置抽屉是否打开（快捷键帮助 + 开关）。 */
  const [drawerOpen, setDrawerOpen] = useState(false)
  /**
   * 节点卡片宽度（用户 2026-10-11 要求：加宽到 300，并在设置里可调）。
   *
   * 作用方式：写到画布容器的**内联 CSS 变量** `--ewb-node-w` 上。
   * 为什么用变量而不是直接改每个节点的 style：宽度是**所有节点共用**的一个值，
   * 按 CSS 的继承一次生效；逐节点写 style 会让 React Flow 认为全部节点都变了。
   * 默认值仍在 canvas-tokens.module.css（这里没设过偏好时不下发内联值）。
   */
  const [nodeW, setNodeW] = useState<number>(
    () => readUiPrefsCache().nodeW ?? NODE_W_DEFAULT,
  )
  /** 改节点宽度并记住（**双写**；同时通知 React Flow 重测量，否则连线的端点会停在旧位置）。 */
  const changeNodeW = useCallback((w: number): void => {
    setNodeW(w)
    prefsTouched.current.nodeW = true
    void saveUiPrefs({ nodeW: w }).then(r => {
      if (r.ok && r.prefs !== undefined) adoptUiPrefs(r.prefs)
    })
  }, [])
  /**
   * 节点宽度的稳定引用。
   *
   * 为什么需要：**进场那次自动布局**（只跑一次的 effect）要拿宽度算间距，
   * 但它的依赖数组是空的 —— 直接读 `nodeW` 会永远拿到初始值。
   * 所以另存一个 ref，effect 里读 ref 即可拿到最新值，
   * 又不用把 effect 变成「宽度一变就重排」（那会把用户手动摆好的位置冲掉）。
   */
  const nodeWRef = useRef<number>(nodeW)
  /**
   * 节点展开后参数区的最大高度（用户 2026-10-11 要求「节点展开高度也增加到设置中」）。
   *
   * 与节点宽度同一套路：写到画布容器的内联 CSS 变量 `--ewb-editor-h`，
   * 节点靠继承拿到（见 node-form.module.css 的 `.inlineEditor`）。
   * 默认值在 canvas-tokens.module.css 里。
   */
  const [editorH, setEditorH] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem('ewb.editorH'))
      return Number.isFinite(v) && v >= EDITOR_H_MIN && v <= EDITOR_H_MAX ? v : EDITOR_H_DEFAULT
    } catch { return EDITOR_H_DEFAULT }
  })
  /** 改参数区高度并记住。 */
  const changeEditorH = useCallback((h: number): void => {
    setEditorH(h)
    try { localStorage.setItem('ewb.editorH', String(h)) } catch { /* 忽略 */ }
  }, [])
  /**
   * 自动排版间距（用户 2026-10-11：「设置也增加一个自动排版间距」）。
   *
   * **两种模式**（`null` 与数字的区别，这是这个设置的关键）：
   *   - `null` = **自动**（默认）：间距跟节点宽度成比例。
   *     为什么默认是自动：上次刚修过「加宽节点后排版变挤」，靠的就是这个比例关系。
   *     如果默认改成固定值，那个修复就白做了。
   *   - 数字 = 用户**显式**定的值，照他的来（拉宽节点也不动，那是他选的）。
   *
   * 复位按钮回到 `null`（自动），而不是回到某个默认数字 —— 那样才能恢复「跟着宽度走」。
   */
  const [layoutSpacing, setLayoutSpacing] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem('ewb.layoutSpacing')
      /* 存的是空串 = 用户选过「自动」，与「没设过」等价。 */
      if (raw === null || raw === '') return null
      const v = Number(raw)
      return Number.isFinite(v) && v >= LAYOUT_SPACING_MIN && v <= LAYOUT_SPACING_MAX ? v : null
    } catch { return null }
  })
  /** 改排版间距并记住（`null` = 回到自动）。 */
  const changeLayoutSpacing = useCallback((s: number | null): void => {
    setLayoutSpacing(s)
    try { localStorage.setItem('ewb.layoutSpacing', s === null ? '' : String(s)) } catch { /* 忽略 */ }
  }, [])
  /** 当前**实际生效**的间距（自动模式下按节点宽度算出来）——给设置面板显示用。 */
  const effectiveSpacing = layoutSpacing ?? autoSpacingFor(nodeW)

  /**
   * 画布底色的**不透明度**（%，用户 m00861：「有的 UI 是透明的，应用背景，
   * 这时候整个板块只有画布是天色、其他都有透明度」）。
   *
   * 100 = 不透明（默认，老行为）。调到 100 以下时画布底让位给外壳背景，
   * 画布与整体融为一体。
   *
   * ⚠️ **只影响画布底那一层**（`background` 里的颜色混合）。
   * 给元素加 `opacity` 会把节点、连线、工具条一起变透明 —— 那是另一件事，
   * 用户要的是「底能透出外壳」，不是「整块画布看不见」。
   */
  /* ★ 票 59：画布底不透明度**改用 `canvas-prefs`**（与内容画布同一份偏好）。
   *
   * ## 为什么不再用自己的 `ewb.canvasBg`
   *
   * 票 59 之前它是执行画布单独一个键，内容画布根本没有这个概念。
   * 用户要求「两边同类归一」，所以并入 `canvas-prefs.ts` 的
   * `canvasBgOpacity` —— 两份本来都是 `localStorage`，合并不改机制。
   *
   * ## 老值迁移在 `readPrefs` 里
   *
   * 它读到 `canvasBgOpacity` 缺失时会去读旧键 `ewb.canvasBg` 并删掉旧键
   * （见 `canvas-prefs.ts` 的 `legacyCanvasBg`）。所以用户之前设过的值不会丢。
   *
   * ⚠️ 这里**不再写 `ewb.canvasBg`** —— 迁移是一次性的，写回去等于把它复活。 */
  const [canvasPrefs, setCanvasPrefs] = useState<CanvasPrefs>(() => readCanvasPrefs())
  /** 改一项画布设置（整份写回 `canvas-prefs`）。 */
  const applyCanvasPrefs = useCallback((patch: Partial<CanvasPrefs>): void => {
    setCanvasPrefs((cur) => {
      const next = patchCanvasPrefs(cur, patch)
      writeCanvasPrefs(next)
      return next
    })
  }, [])
  /** 画布底不透明度（%，与内容画布同一个字段）。 */
  const canvasBg = canvasPrefs.canvasBgOpacity ?? 100
  /** 改画布底不透明度。 */
  const changeCanvasBg = useCallback((v: number): void => {
    applyCanvasPrefs({ canvasBgOpacity: v })
  }, [applyCanvasPrefs])

  /**
   * 画布明暗（票 54，用户 2026-10-29 甲 4）。
   *
   * ## 三态，`null` 是有意义的
   *
   * `null` = 用户没切过 → **跟随 dsh 主题**（`detectDark()`）。
   * 用户点过之后写死 `'light'` / `'dark'`，此后 dsh 换主题不影响画布。
   *
   * ## 存在 `lib/workbench-prefs.ts` 的 `canvasTheme`
   *
   * 为什么不与内容画布共用同一个键：两套偏好是各自独立的 localStorage 键
   * （`ewb.workbenchPrefs` / `ewb.canvasPrefs`），共用会让「改生图工作台的张数」
   * 把「画布明暗」一起改掉。
   */
  const [workflowTheme, setWorkflowTheme] = useState<CanvasTheme>(() => readWorkbenchPrefs().canvasTheme)

  /**
   * 正在保存。
   *
   * ⚠️ 这是**真实状态**，不是装饰：只由 `save` 那条路置位、存完复位。
   * 不要在别处给它赋值 —— 一个三天两头亮着的「保存中」比没有更坏。
   */
  const [saving, setSaving] = useState(false)

  /**
   * 当前实际上是不是深色。
   *
   * `workflowTheme` 有值时按它，没值时跟随 dsh。
   * ⚠️ **每次渲染算一次**，不要 `useState(() => detectDark())` 缓存 ——
   * 那样 dsh 换主题后画布不跟（用户甲 4 的默认行为正是「没切过就跟 dsh」）。
   */
  const darkNow = workflowTheme === null ? detectDark() : workflowTheme === 'dark'

  /** 切换画布明暗：只切画布，不碰 dsh 主题。 */
  const toggleWorkflowTheme = useCallback((): void => {
    /* 翻到现在显示的反面，并**写死** —— 从这一次点击开始不再跟随 dsh。 */
    const next: CanvasTheme = darkNow ? 'light' : 'dark'
    setWorkflowTheme(next)
    /* ⚠️ 走本地偏好，**不走 `saveUiPrefs`** —— 那是宿主半的 `UiPrefs` 契约
     * （`src/prefs/ui-prefs.ts:46`），加字段要动 `src/prefs/` 与 `src/index.ts`，
     * 两者都在本票可改路径之外。`workbench-prefs.ts` 是纯 localStorage，够用。 */
    writeWorkbenchPrefs({ ...readWorkbenchPrefs(), canvasTheme: next })
  }, [darkNow])

  /* ── 浏览器偏好（两层：标签 → 浏览器 + 启动方式）───────────────────
   * 用户 2026-10-13：设置里加「默认使用浏览器」+ 自动检测 + 把我们的 CDP 也列进去。
   * 逻辑全在 `browser-settings.ts`（纯函数、有单测）。
   *
   * ## 状态已搬到 `WorkspaceSettings.tsx` 的共享存储（2026-10-22）
   *
   * 原来这里有一份 `useState`，设置抽屉也在这里。两处各持一份的后果是
   * 「在工作台设置里改完，画布上的节点还算着旧偏好」。现在：
   *   · **读**：`useBrowserPrefs()`（跟着共享状态变）；
   *   · **写**：`updateBrowserPrefs()`（那边改，这边自动收到）。
   *
   * 画布自己**不再有**改浏览器偏好的入口 —— 它在节点设置里只读「这个标签用哪个」。
   */
  const browserPrefs = useBrowserPrefs()
  /**
   * 改浏览器偏好（给**节点设置**里那个「标签」用，不是工作台设置）。
   *
   * 为什么画布还留着这个：节点上的 `session` 参数改了之后要把第二层重新解析进去
   * （第一层决定第二层）。它走的是共享存储，所以设置抽屉那边也是同一份。
   */
  const changeBrowserPrefs = useCallback((p: BrowserPrefs): void => {
    updateBrowserPrefs(p)
  }, [])
  /**
   * 画布上**用到过**的标签名（去重）。
   *
   * 为什么需要：用户可能先在节点上写了「淘宝」这个标签，但设置里还没给它配第二层 ——
   * 那它也要出现在设置里，否则用户看不见、也就配不了。
   */
  const browserTags = useMemo(() => {
    const s = new Set<string>()
    for (const n of nodes) {
      const t = n.data.params.session
      if (typeof t === 'string' && t.trim() !== '') s.add(t)
    }
    return [...s]
  }, [nodes])

  /**
   * 检测到的浏览器清单（给节点设置里的「用哪个浏览器」下拉用）。
   *
   * 走**共享缓存**（`browser-detect-store.ts`）—— 全局设置那边读的是同一份，
   * 所以两处不会出现「一边检测完了、另一边还是空的」。
   * 第一次用到时自动检测（用户要的「这个检测过程能否自动」）。
   */
  const detectState = useDetectedBrowsers()
  const detectedBrowsers: readonly KnownBrowser[] = useMemo(
    () => (detectState?.browsers ?? []).map(b => ({ id: b.id, name: b.name, path: b.path })),
    [detectState],
  )

  /**
   * 把「标签解析出的第二层」**同步进浏览器节点的 params**。
   *
   * ## 为什么必须写进 params（这是整套两层的落地点）
   *
   * 宿主半跑在 Node 进程里，**读不到 localStorage**（设置在浏览器那边）。
   * 而 params 是存档的一部分、客户端写、宿主半读 —— 所以「这个节点用哪个浏览器、
   * 怎么开」必须**落到 params 上**才能被执行方看到。
   *
   * ## 为什么这样就保证了「同名标签 → 同一个浏览器」
   *
   * 这个函数**按标签统一算**：同一标签的每个节点都拿到**同一份**解析结果。
   * 节点自己**没有地方**存第二套值（那两个键只由这里写）——
   * 所以「同名不同浏览器」在结构上不可能出现，而不是靠事后校验去拦。
   *
   * ⚠️ 幂等：值没变时返回**原数组引用**，避免无限重渲染（本项目踩过这个坑）。
   */
  const syncBrowserLayer = useCallback((base: V1Node[]): V1Node[] => {
    /** 缓存：同一标签只解析一次（顺便保证同标签结果**完全一致**）。 */
    const cache = new Map<string, { launcher: string, exePath: string, port: string }>()
    let changed = false
    const next = base.map(n => {
      if (n.data.def.id !== 'browser.act' && n.data.def.id !== 'browser.download') return n
      const tag = String(n.data.params.session ?? '默认')
      let r = cache.get(tag)
      if (r === undefined) {
        const t = resolveTag(browserPrefsRef.current, tag)
        /* ⚠️ **`port` 也要同步进去**（2026-10-14 加）——
         * 它是用户手填的调试端口，宿主半（Node 进程）读不到 localStorage，
         * 只能经 params 传（理由与 launcher / exePath 完全一样）。 */
        r = { launcher: t.launcher, exePath: t.exePath, port: t.port }
        cache.set(tag, r)
      }
      const cur = n.data.params
      if (cur.launcher === r.launcher && cur.exePath === r.exePath && cur.port === r.port) return n
      changed = true
      return {
        ...n,
        data: {
          ...n.data,
          params: {
            ...cur,
            launcher: r.launcher,
            exePath: r.exePath,
            port: r.port,
          },
        },
      }
    })
    return changed ? next : base
  }, [])

  /**
   * 输出显示窗口的高度（px）。用户 2026-10-13：「将输出显示窗口的高度也添加到画布设置中」。
   *
   * ⚠️ 它写成 **CSS 变量**（`--ewb-run-panel-h`）而不是逐个传 prop ——
   * 日志面板在节点卡片里层级很深，一路传 prop 会碰一大片组件；
   * 而它纯是显示尺寸，变量最省事且不引起重渲染。
   */
  const [panelH, setPanelH] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem('ewb.panelH'))
      return Number.isFinite(v) && v >= PANEL_H_MIN && v <= PANEL_H_MAX ? v : PANEL_H_DEFAULT
    } catch { return PANEL_H_DEFAULT }
  })
  /** 改输出高度并记住（同时写 CSS 变量，让已在渲染的面板立刻跟随）。 */
  const changePanelH = useCallback((h: number): void => {
    const v = Math.min(PANEL_H_MAX, Math.max(PANEL_H_MIN, Math.round(h)))
    setPanelH(v)
    try { localStorage.setItem('ewb.panelH', String(v)) } catch { /* 忽略 */ }
  }, [])
  /* 把高度写到根元素上 —— 日志面板读 `var(--ewb-run-panel-h)`。 */
  useEffect(() => {
    document.documentElement.style.setProperty(PANEL_H_VAR, String(panelH) + 'px')
  }, [panelH])
  /**
   * 一次把所有画布设置恢复默认（票 57 第 3 条）。
   *
   * ## 为什么在这里拼、而不是在 `SettingsDrawer` 里
   *
   * 「什么算默认」分散在两个地方：五个数值的缺省在 `SettingsDrawer.tsx` 的常量里，
   * 而「自动」这种**状态**（间距 `null`、输出高度有单独缺省）的真值在本文件 ——
   * 它才是这些偏好的持有者。放在按钮那一侧拼，等于把规则抄两份。
   *
   * ## 为什么逐项调那五个 setter 而不是直接 setState
   *
   * 那五个 setter 各自还要写 `localStorage` 与 CSS 变量（`changePanelH` 写
   * `--ewb-run-panel-h` 那条）。绕过它们直接改 state，会出现「面板变了、
   * 已渲染的日志面板高度没变」这种半生效。
   */
  const resetAllSettings = useCallback((): void => {
    changeNodeW(NODE_W_DEFAULT)
    changeEditorH(EDITOR_H_DEFAULT)
    changeCanvasBg(CANVAS_BG_DEFAULT)
    /* 间距的默认是**自动**（`null`），不是某个数字 —— 见 `SettingsDrawer` 那颗单项复位的说明。 */
    changeLayoutSpacing(null)
    changePanelH(PANEL_H_DEFAULT)
    /* ★ 票 59：三个透明度也要跟着复位 —— 不然「恢复默认」只还原了一半，
     * 而 `isDefaultPrefs` 说它们本来就该是默认值。 */
    applyCanvasPrefs({
      canvasBgOpacity: DEFAULT_PREFS.canvasBgOpacity,
      guideOpacity: DEFAULT_PREFS.guideOpacity,
      patternOpacity: DEFAULT_PREFS.patternOpacity,
    })
  }, [changeNodeW, changeEditorH, changeCanvasBg, changeLayoutSpacing, changePanelH, applyCanvasPrefs])
  /**
   * 排版间距的稳定引用（理由同 `nodeWRef`：进场那次自动布局只跑一次，
   * 直接读 state 会永远拿到初始值）。
   */
  const spacingRef = useRef<number | null>(layoutSpacing)
  /** 画布布局方向（左→右 / 上→下）。记住偏好。 */
  const [dir, setDir] = useState<LayoutDirection>(() => {
    try { return localStorage.getItem('ewb.dir') === 'DOWN' ? 'DOWN' : 'RIGHT' } catch { return 'RIGHT' }
  })
  /**
   * 方向的**稳定引用** —— `refitNodes` 要读它，而那里是 `useCallback(..., [])`。
   *
   * ⚠️ **为什么不能让 `refitNodes` 依赖 `dir`**：它被 `refitAll` 包着，
   * 而 `refitAll` 是十几个回调与两个 effect 的依赖。换一次引用就会连锁重建，
   * 这个文件对「渲染期新建回调」极其敏感（文件头记着一整族死循环）。
   *
   * 所以照 `nodeWRef` / `spacingRef` 同一套做法：**渲染期同步 + 空依赖**，
   * 见下面 `dirRef.current = dir` 那一行。
   */
  const dirRef = useRef<LayoutDirection>(dir)
  /**
   * 画布是否锁定（只读）。锁上后所有编辑动作都不生效——防止误改跑通的流程。
   *
   * 做法照 Langflow：**用一个派生值统管所有交互**，而不是在每个回调里各写一遍 if。
   * 理由：交互入口有十来个（拖动、连线、删除、粘贴、改参数…），逐个加判断必漏；
   * 集中成一个 `locked` 变量，改一处就全生效。
   */
  const [locked, setLocked] = useState<boolean>(() => {
    try { return localStorage.getItem('ewb.locked') === '1' } catch { return false }
  })

  /* ── 编组（契约 CE，照参考项目的模型）────────────────────────────────
   *
   * 六个动作全部只是「调几何层纯函数 → 把结果写回节点」，本文件不自己算坐标。
   *
   * ⚠️ **几何层只回写四样东西**（位置 / 宽 / 高 / `data.groupId`），
   * 见 `applyGeoNodes`。别在这里顺手 map 整个 `data` —— 那会把 `def` / `params`
   * 与运行状态一起抹掉。
   */

  /** 把当前画布拍成几何层认的形状（量不到尺寸就按画布默认卡片尺寸估）。 */
  const geoOf = useCallback((list: readonly V1Node[]): GeoNode[] =>
    toGeoNodes(list, measureNodes(wrapRef.current), { w: NODE_W, h: NODE_H }), [])

  /** 当前画布上有哪些组节点。 */
  const groupNodesOf = useCallback((list: readonly V1Node[]): V1Node[] =>
    list.filter(n => n.type === GROUP_NODE_TYPE), [])

  /**
   * 把选中的节点**编成一个组**（用户 m01076：「编组照参考项目的模式改」）。
   *
   * ## 与上一版（名单模型）的区别
   *
   * 上一版只往一份 `groups` 名单里加一条，框是渲染时算出来的假节点。
   * 现在**真的建一个节点**（`type: 'group'`、有位置宽高），成员打上 `groupId`、
   * 坐标**一动不动**（绝对坐标）。
   *
   * ## 「连贯」规则保留（用户 2026-10-11 定的）
   *
   * 用户原话：「编组必须满足连贯……编组的意思类似于一个小工作流」。
   * 所以先 `closeUnderTransit` 补齐「夹在选中节点之间」的节点。
   * 补齐后比用户选的多时**明确告诉他多了哪些** ——
   * 这种「我替你做主」的动作必须说出来。
   *
   * ⚠️ 只补**不在循环里**的节点：循环体里的节点有 `parentId`，
   * 拉进组会与循环的归属冲突（一个节点既在组里又在循环里，语义会乱）。
   */
  const groupSelected = useCallback((): void => {
    if (locked) { notify('画布已锁定，先解锁才能编组', 'warn'); return }
    const picked = nodesRef.current.filter(n => n.selected === true)
    if (picked.length < 2) { notify('至少选中 2 个节点才能编组', 'warn'); return }
    const pickedIds = new Set(picked.map(n => n.id))
    const fullIds = closeUnderTransit(pickedIds, edgesRef.current)
    const byId = new Map(nodesRef.current.map(n => [n.id, n]))
    const members = [...fullIds]
      .map(id => byId.get(id))
      .filter((n): n is V1Node => n !== undefined && n.parentId === undefined && n.type !== GROUP_NODE_TYPE)
    if (members.length < 2) { notify('至少选中 2 个节点才能编组', 'warn'); return }
    const added = members.filter(n => !pickedIds.has(n.id))

    recordHistory()
    idRef.current += 1
    const gid = 'g-' + String(idRef.current)
    const made = createGroupFromNodes(gid, geoOf(members), '')
    const groupNode: V1Node = {
      id: gid,
      type: 'group',
      position: { x: made.group.position.x, y: made.group.position.y },
      width: made.group.width,
      height: made.group.height,
      data: {
        def: GROUP_DEF,
        state: 'idle' as NodeState,
        params: {},
        onError: 'stop',
        groupLabel: '',
      },
      /* 组画在成员**底下**（参考项目 `z-index: 5` 的做法）。 */
      zIndex: 0,
      selected: false,
    } as unknown as V1Node
    /* 组排在最前 —— 同 `zIndex` 时 React Flow 看数组顺序，两边都安排才保证框不挡成员。 */
    setNodes([groupNode as V1Node, ...applyGeoNodes(nodesRef.current, made.nodes)])
    notify(added.length === 0
      ? '已把 ' + String(members.length) + ' 个节点编成一组（点名字可改，右键可解散）'
      : '已编组 ' + String(members.length) + ' 个节点——为保持连贯，自动纳入了夹在中间的 '
        + String(added.length) + ' 个', 'ok')
  }, [locked, notify, recordHistory, geoOf, setNodes])

  /**
   * 解散一个组（用户 2026-10-11 要求「打包分组有必要」的**必要另一半**）。
   *
   * 几何层的 `ungroupCanvasGroup` 做两件事：删掉组节点 + 清掉成员的 `groupId`。
   * 成员坐标本来就是绝对的，**不用还原任何坐标**。
   *
   * @param groupId - 要解散的组 id。
   */
  const ungroupById = useCallback((groupId: string): void => {
    if (locked) { notify('画布已锁定，先解锁才能解散分组', 'warn'); return }
    const g = nodesRef.current.find(x => x.id === groupId && x.type === GROUP_NODE_TYPE)
    if (g === undefined) return
    const kids = nodesRef.current.filter(x => x.data.groupId === groupId).length
    recordHistory()
    /* ⚠️ **框要显式删掉**（2026-10-26 修的 bug）。
     *
     * `ungroupCanvasGroup` 返回的数组里已经没有那个框了，而 `applyGeoNodes`
     * 按**原数组**遍历、缺 id 的原样保留（它不负责删，见那个函数的注释）。
     * 所以这里必须先 filter 掉框，否则「解散」只清了成员的 `groupId`、
     * 框还画在画布上 —— 用户按 Ctrl+G 看到的就是「框还在」。
     * `tests/dom-render.mjs` 的「Ctrl+G 解散：分组框 1 → 1」抓到过这个。 */
    const kept = nodesRef.current.filter(x => x.id !== groupId)
    setNodes(applyGeoNodes(kept, ungroupCanvasGroup(groupId, geoOf(nodesRef.current))))
    notify('已解散「' + (typeof g.data.groupLabel === 'string' && g.data.groupLabel !== '' ? g.data.groupLabel : '分组')
      + '」，' + String(kids) + ' 个节点留在原处', 'ok')
  }, [locked, notify, recordHistory, geoOf, setNodes])

  /**
   * 选出「这次要解散哪些组」（快捷键与菜单共用）。
   *
   * 判据两条取并集（用户视角里「我选中了这一组」有两种表达方式）：
   *   ① 直接选中了框节点本身；
   *   ② 选中了组里的成员（新模型里框和成员是两个节点，用户很难只点中框）。
   *
   * @param list - 画布节点。
   * @param pickedIds - 选中的 id。
   * @returns 要解散的组 id（去重）。
   */
  const groupsOfSelection = useCallback((list: readonly V1Node[], pickedIds: ReadonlySet<string>): string[] => {
    const out = new Set<string>()
    for (const n of list) {
      if (n.type === GROUP_NODE_TYPE && pickedIds.has(n.id)) out.add(n.id)
      const gid = n.data.groupId
      if (typeof gid === 'string' && gid !== '' && pickedIds.has(n.id)) out.add(gid)
    }
    return [...out]
  }, [])

  /**
   * 解散选中的组（快捷键 / 右键菜单共用）。
   *
   * 为什么单开一个：`ungroupById` 要一个明确的组 id（右键菜单知道点的是哪个），
   * 而快捷键只知道「当前选中了什么」。
   */
  const ungroupSelected = useCallback((): void => {
    if (locked) { notify('画布已锁定，先解锁才能解散分组', 'warn'); return }
    const pickedIds = new Set(nodesRef.current.filter(n => n.selected === true).map(n => n.id))
    const hit = groupsOfSelection(nodesRef.current, pickedIds)
    if (hit.length === 0) { notify('先选中组里的节点或组本身，再按 Ctrl+G 解散', 'warn'); return }
    recordHistory()
    let nextGeo = geoOf(nodesRef.current)
    for (const gid of hit) nextGeo = ungroupCanvasGroup(gid, nextGeo)
    /* ⚠️ 同 `ungroupById`：框要显式 filter 掉（`applyGeoNodes` 不负责删）。 */
    const gone = new Set(hit)
    setNodes(applyGeoNodes(nodesRef.current.filter(n => !gone.has(n.id)), nextGeo))
    notify('已解散 ' + String(hit.length) + ' 个分组', 'ok')
  }, [locked, notify, recordHistory, geoOf, setNodes, groupsOfSelection])

  /**
   * 改组的标题 / 描述（**写进组节点自己的 data**，不再写一份名单）。
   *
   * 组名**不能为空**（照 n8n 的规则）：用户清空重打时会出现中间态，
   * 那时保留上一个名字比让框标题变空好。
   *
   * 描述上限 145 字（n8n 的 `GROUP_DESC_MAX`）—— 超长**截断**而不是拒绝。
   *
   * @param groupId - 组 id。
   * @param patch - 要改的字段。
   */
  const patchGroup = useCallback((groupId: string, patch: { groupLabel?: string, note?: string }): void => {
    if (locked) return
    setNodes(ns => ns.map(n => {
      if (n.id !== groupId || n.type !== GROUP_NODE_TYPE) return n
      const data: Record<string, unknown> = { ...n.data }
      if (patch.groupLabel !== undefined && patch.groupLabel.trim() !== '') data.groupLabel = patch.groupLabel
      if (patch.note !== undefined) {
        const t = patch.note.trim()
        data.note = t.length <= GROUP_DESC_MAX ? t : t.slice(0, GROUP_DESC_MAX)
      }
      return { ...n, data: data as V1NodeData }
    }))
  }, [locked, setNodes])

  /**
   * 「适应成员」：把框缩到刚好包住成员（内边距 36 / 顶 44 / 底 36）。
   * @param groupId - 组 id。
   */
  const fitGroup = useCallback((groupId: string): void => {
    if (locked) return
    recordHistory()
    setNodes(applyGeoNodes(nodesRef.current, fitGroupToEnclosedChildren(groupId, geoOf(nodesRef.current))))
  }, [locked, recordHistory, geoOf, setNodes])

  /**
   * 「一键收纳」：几何上落在框里的节点都归进这一组。
   *
   * 参考项目 `captureEnclosedNodesIntoGroup` 的行为 —— 判据是**中心点在框内**，
   * 不是「完全包含」（大节点拖到框上沿时完全包含永远不成立，用户会觉得拖不进去）。
   *
   * @param groupId - 组 id。
   */
  const captureGroup = useCallback((groupId: string): void => {
    if (locked) return
    recordHistory()
    const r = captureEnclosedNodesIntoGroup(groupId, geoOf(nodesRef.current))
    setNodes(applyGeoNodes(nodesRef.current, r.nextNodes))
    notify(r.capturedCount > 0 ? '已把框内的 ' + String(r.capturedCount) + ' 个节点收进这一组' : '框里没有可收的节点',
      r.capturedCount > 0 ? 'ok' : 'warn')
  }, [locked, recordHistory, geoOf, setNodes, notify])

  /**
   * 选中某个组的全部成员（右键菜单用）。
   *
   * 为什么要这一条：框和成员是**两个节点**，想让「整个组一起被拖动」得先把成员选上 ——
   * 否则用户拖框只挪走一块虚线（参考项目同样给这个入口）。
   *
   * @param groupId - 组 id。
   */
  const selectGroupChildren = useCallback((groupId: string): void => {
    const want = new Set([groupId, ...nodesRef.current.filter(n => n.data.groupId === groupId).map(n => n.id)])
    setNodes(ns => ns.map(n => ({ ...n, selected: want.has(n.id) })))
  }, [setNodes])

  /**
   * 四角改完大小 → 同步成员归属（参考项目 `syncGroupMembershipAfterTransform`）。
   *
   * ⚠️ 这是「改框」那条路的**唯一**收尾：框不是父容器，改大小不会自动改变归属，
   * 所以「谁还在框里」必须重算一次。不调它，框就退化成「只是画了条线」。
   *
   * @param groupId - 组 id。
   * @param w - 新宽。
   * @param h - 新高。
   */
  const resizeGroup = useCallback((groupId: string, w: number, h: number): void => {
    if (locked) return
    setNodes(ns => {
      const resized = ns.map(n => (n.id === groupId ? { ...n, width: w, height: h } : n))
      return applyGeoNodes(resized, syncGroupMembershipAfterTransform(groupId, geoOf(resized)))
    })
  }, [locked, geoOf, setNodes])

  /**
   * 拖动结束后同步归属（拖进框 → 归入 + 吸附；拖出框 → 脱离）。
   *
   * 规则照参考项目 `finishNodeDrag`：
   *   ① 被拖的里面有组 → 对每个组调 `syncGroupMembershipAfterTransform`（框变了，成员跟着重算）；
   *   ② 否则按被拖节点的落点，用 `findContainingGroupId` 重设它的 `groupId`；
   *   ③ 有明确的落点组时先 `snapNodesIntoGroup` 吸附（不吸附的话节点看着一半在框外，
   *      而它其实已经属于那组了 —— 用户没法从画面判断归属）。
   *
   * @param movedIds - 这次被拖的节点 id。
   */
  const syncGroupsAfterDrag = useCallback((movedIds: readonly string[]): void => {
    const ids = new Set(movedIds)
    if (ids.size === 0) return
    if (!nodesRef.current.some(n => n.type === GROUP_NODE_TYPE)) return
    /* ⚠️ 拖的是**框**（含「连成员一起拖」那次）走另一条路：框变了要重算「谁还在框里」，
     * 不能按「落点归属」处理 —— 否则框一移动，它的成员会被判成「拖进框外」而全部脱离。 */
    const draggedGroups = nodesRef.current
      .filter(n => ids.has(n.id) && n.type === GROUP_NODE_TYPE).map(n => n.id)
    let geo = geoOf(nodesRef.current)
    if (draggedGroups.length > 0) {
      for (const gid of draggedGroups) geo = syncGroupMembershipAfterTransform(gid, geo)
      setNodes(applyGeoNodes(nodesRef.current, geo))
      return
    }
    const target = findGroupDropTarget(ids, geo)
    if (target !== null) {
      geo = snapNodesIntoGroup(ids, geo, target)
    } else {
      geo = geo.map(g => {
        if (!ids.has(g.id) || g.type === GROUP_NODE_TYPE) return g
        const owner = findContainingGroupId(g, geo)
        if (g.data?.groupId === owner) return g
        return { ...g, data: { ...g.data, groupId: owner } }
      })
    }
    setNodes(applyGeoNodes(nodesRef.current, geo))
  }, [geoOf, setNodes])

  /**
   * 编组 / 解散编组的快捷键入口（Ctrl+G）。
   *
   * **一键两用**：选中的东西**已经和某个组有关**（选中了框、或选中了组里的成员）
   * → 解散那个组；否则 → 编组。两者都能从「选中了什么」判断出来，不需要两个键。
   */
  const toggleGroupShortcut = useCallback((): void => {
    const pickedIds = new Set(nodesRef.current.filter(n => n.selected === true).map(n => n.id))
    if (groupsOfSelection(nodesRef.current, pickedIds).length > 0) { ungroupSelected(); return }
    groupSelected()
  }, [groupSelected, ungroupSelected, groupsOfSelection])

  /* ⚠️ 这三个 `*Stable` 包装是**稳定引用**（空依赖 + 走 ref），给节点 data 用。
   *
   * 为什么必须稳定：节点的 `data` 每次重渲染都新建一个对象，React Flow 拿它判断
   * 「这个节点变了没有」。回调若写成内联箭头，引用每次都不同 → 它认为全图都更新
   * → 反复重测量、重置视口状态 → **节点挤在一起、拖动失效**（本项目踩过三次）。 */
  const groupRenameRef = useRef<(id: string, v: string) => void>(() => { /* 挂载前为空 */ })
  groupRenameRef.current = (id, v) => { patchGroup(id, { groupLabel: v }) }
  const onGroupRenameStable = useCallback((id: string, v: string): void => { groupRenameRef.current(id, v) }, [])

  const groupNoteRef = useRef<(id: string, v: string) => void>(() => { /* 挂载前为空 */ })
  groupNoteRef.current = (id, v) => { patchGroup(id, { note: v }) }
  const onGroupNoteStable = useCallback((id: string, v: string): void => { groupNoteRef.current(id, v) }, [])

  const groupResizeRef = useRef<(id: string, w: number, h: number) => void>(() => { /* 挂载前为空 */ })
  groupResizeRef.current = (id, w, h) => { resizeGroup(id, w, h) }
  const onGroupResizeStable = useCallback((id: string, w: number, h: number): void => { groupResizeRef.current(id, w, h) }, [])

  /** 小地图是否显示（记住偏好；默认显示）。 */
  const [minimapOpen, setMinimapOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('ewb.minimap') !== '0' } catch { return true }
  })
  /** 本次运行的取消器（停止时用它把取消信号发到宿主半）。 */
  const runAbort = useRef<AbortController | null>(null)
  /** 执行时的工作目录（宿主半探回来的；拿不到就用空串让宿主用默认值）。 */
  const workdirRef = useRef<string>('')
  /* ── 票 54：`engineOk` 这个 state **已删** ──
   *
   * 引擎状态显示（`engineDot` / `engineText`）随顶部条一起删掉了
   * （用户 2026-10-29：「画布中不需要出现，简约点」），全仓再没有地方读它。
   * 留着一个「只写不读」的 state 会让人误以为画布还在显示连接状态。
   *
   * ⚠️ **但下面 `probeEngine()` 那次探测不能删** ——
   * 它还要拿 `r.workdir` 填 `workdirRef.current`（运行时的 cwd 靠它）。
   * 只删 `setEngineOk` 那一行，保留 `workdirRef` 那一行。
   *
   * 引擎健康检测本身用户已定「记进后期备忘，这一批不做」
   * （`docs/备忘-延后开发功能.md` 第 13 条）。 */

  /** 显式把节点集整体换掉（React Flow 的 computed 属性需要过一遍 onNodesChange）。 */
  const applyNodes = useCallback((next: V1Node[]): void => {
    setNodes(next)
  }, [setNodes])

  /**
   * 注入「可用变量」后的节点（派生，不写回状态）。
   *
   * 为什么不直接改 nodes：那个数组是权威状态，写回会触发无谓的重渲染与历史快照；
   * 这里只是在传给画布那一刻补一份展示用的数据。
   */
  /*
   * 分组框改名：用一个**稳定的入口**，而不是每个节点一个新建函数。
   *
   * ⚠️ 为什么必须稳定（2026-10-10 修，这是「画布异常」的真根因）：
   * React Flow 靠**对象引用**判断节点是否变化。若 `data` 里每次渲染都塞一个新的
   * 内联函数，则**每个节点的 data 引用每次都变** → React Flow 认为全部节点都更新了 →
   * 反复重测量、重置内部视口状态 → 节点挤在一起、拖动失效、交互异常。
   *
   * 做法：函数只建一次（空依赖），靠 ref 读到当前 id。
   */
  const renameRef = useRef<(id: string, v: string) => void>(() => { /* 挂载前为空 */ })
  renameRef.current = (id: string, v: string): void => {
    setNodes(ns => ns.map(x => x.id !== id ? x : { ...x, data: { ...x.data, groupLabel: v } }))
  }
  const onRenameStable = useCallback((id: string, v: string): void => { renameRef.current(id, v) }, [])

  /* 循环框的收起 / 改名：与上面同一条纪律 —— **回调必须是稳定引用**，
   * 否则每个节点的 data 引用每次都变，React Flow 会认为全图都更新（节点挤在一起、拖动失效）。 */
  const toggleCollapseRef = useRef<(id: string) => void>(() => { /* 挂载前为空 */ })
  toggleCollapseRef.current = (id: string): void => {
    /* ⚠️ **必须先算出新 collapsed、再 refit**（2026-10-16 修）。
     *
     * 只翻 `collapsed` 那一位的话，用户看到的是「按钮文字变了、框的样子一点没变」
     * —— 因为框的尺寸是 `fitLoopBox` 算的，而它读的正是 `data.collapsed`。
     * 所以这里把两件事连着做：翻位 → `refitNodes` 重算尺寸。
     *
     * 用 `refitNodes`（纯计算）而不是 `refitAll`：我们要在**同一拍**里基于
     * 刚翻好的数组继续算，写成两次 setNodes 会互相覆盖。 */
    setNodes(ns => {
      const flipped = ns.map(x => x.id !== id
        ? x
        : { ...x, data: { ...x.data, collapsed: x.data.collapsed !== true } })
      return refitNodesRef.current(flipped)
    })
  }
  const onToggleCollapseStable = useCallback((id: string): void => { toggleCollapseRef.current(id) }, [])
  /* 循环的「设置」面板开关：与收起同一条纪律（翻位之后要 refit，框才让得出高度）。 */
  const toggleSettingsRef = useRef<(id: string) => void>(() => { /* 挂载前为空 */ })
  toggleSettingsRef.current = (id: string): void => {
    setNodes(ns => {
      const flipped = ns.map(x => x.id !== id
        ? x
        : { ...x, data: { ...x.data, settingsOpen: x.data.settingsOpen !== true } })
      return refitNodesRef.current(flipped)
    })
  }
  const onToggleSettingsStable = useCallback((id: string): void => { toggleSettingsRef.current(id) }, [])
  /**
   * 循环框内**手动**切竖排 / 横排（用户 2026-10-21：
   * 「同时给循环加个按钮调整横排和竖排吧」）。
   *
   * 与收起 / 设置同一条纪律：翻位之后要在**同一拍**里 `refitNodes`
   * （框内排列变了，框的尺寸也得跟着重算，否则成员会露到框外）。
   *
   * 判据用「当前实际生效的方向」取反，而不是取反 `data.axis`：
   * 用户第一次点的时候 `data.axis` 还是 undefined（在用自动方向），
   * 这时要切成「自动方向的反面」，而不是切成某个固定值。
   *
   * @param id - 循环节点 id。
   * @param currentAuto - 画布方向推出来的方向（用户还没手动切过时生效的那个）。
   */
  const toggleAxisRef = useRef<(id: string, currentAuto: 'TB' | 'LR') => void>(() => { /* 挂载前为空 */ })
  toggleAxisRef.current = (id: string, currentAuto: 'TB' | 'LR'): void => {
    setNodes(ns => {
      const flipped = ns.map(x => {
        if (x.id !== id) return x
        const d = x.data as { axis?: unknown }
        const curAxis = d.axis === 'TB' || d.axis === 'LR' ? d.axis : currentAuto
        const next = curAxis === 'TB' ? 'LR' : 'TB'
        return { ...x, data: { ...x.data, axis: next } }
      })
      return refitNodesRef.current(flipped)
    })
  }
  const onToggleAxisStable = useCallback((id: string, auto: 'TB' | 'LR'): void => {
    toggleAxisRef.current(id, auto)
  }, [])
  /**
   * 循环设置面板**实测高度**的回写（用户 2026-10-16）。
   *
   * 面板自己量 `offsetHeight` 后报上来，`fitLoopBox` 按它让位 —— 这样
   * 「面板内容多高就让多少」，不再是硬编码的 `BOX_SETTINGS_H`。
   *
   * ⚠️ **必须判「和上次一样吗」再写**：不判的话 setNodes → 重渲染 →
   * 面板重新量（值相同）→ 又上报 → 死循环。`fitLoopBox` 那边虽然也幂等，
   * 但这里少一次 setNodes 更直接。
   * ⚠️ 只有**真变了**才 setNodes；否则返回原数组引用（React 会跳过重渲染）。 */
  const onSettingsHeightStable = useCallback((id: string, h: number): void => {
    setNodes(ns => {
      const t = ns.find(x => x.id === id)
      if (t === undefined || t.data.settingsPanelH === h) return ns
      return refitNodesRef.current(ns.map(x => x.id !== id
        ? x
        : { ...x, data: { ...x.data, settingsPanelH: h } }))
    })
  }, [setNodes])
  const setNameRef = useRef<(id: string, v: string) => void>(() => { /* 挂载前为空 */ })
  setNameRef.current = (id: string, v: string): void => {
    setNodes(ns => ns.map(x => x.id !== id ? x : { ...x, data: { ...x.data, label: v } }))
  }
  const onSetNameStable = useCallback((id: string, v: string): void => { setNameRef.current(id, v) }, [])

  /** 改实例备注（讲「我在这里为什么用它」）。 */
  const setNoteRef = useRef<(id: string, v: string) => void>(() => { /* 挂载前为空 */ })
  setNoteRef.current = (id: string, v: string): void => {
    setNodes(ns => ns.map(x => x.id !== id ? x : { ...x, data: { ...x.data, note: v } }))
  }
  const onSetNoteStable = useCallback((id: string, v: string): void => { setNoteRef.current(id, v) }, [])

  /* ⚠️ 改参数用的稳定引用。
   *
   * **为什么以前这里是坏的**（2026-10-15 修，实测出来的）：这段注释原来写着
   * 「`onParamRef` / `onParamStable` 已有，见文件上方」，但**上方只有 `onParamRef`
   * 那个 ref，从来没有 `onParamStable` 这个函数**。于是第 926 行
   * `onTag: (t) => { onParamStable(n.id, 'session', t) }` 指向一个**不存在的名字** ——
   * 类型检查一直在报（`error TS2304: Cannot find name 'onParamStable'`，
   * 归在 `check:client` 那 158 条里，而那个命令**基线就是红的**，所以这条真错被淹没了）。
   *
   * 症状（用户 2026-10-15 报的「标签不可编辑」）：在浏览器一节里改标签、
   * 输入框**打不进字**（每次按键都抛 `ReferenceError`，值写不回去）。
   *
   * 教训：**基线红的检查命令 = 失去报警能力**。真错会混在既存噪音里。
   * 所以新增代码宁可自己写一条判据（见 `tests/node-editor-order.mjs`），
   * 也不要指望「反正 `check:client` 是红的」。
   *
   * 做法与上面几个 Stable 完全一样：函数只建一次（空依赖），靠 ref 读最新实现。 */
  const onParamStable = useCallback((id: string, key: string, value: unknown): void => {
    onParamRef.current(id, key, value)
  }, [])

  /* ⚠️ 删除节点的稳定引用 —— 给的是**节点工具条**上那个删除按钮
   * （用户 m03500：「删除节点按钮我现在在节点中看不到，**放在节点外面**吧」）。
   *
   * 原来那个按钮渲染在编辑体的 `.popFoot` 里，但调用方从来没传 `onDelete`，
   * 所以**根本不可达**。搬到工具条后它成了每张卡片都会拿到的回调，
   * 因此必须照上面几个 Stable 的写法（函数只建一次、空依赖、靠 ref 读最新实现），
   * 否则每次渲染都换新引用 → 节点 data 的 `same` 判据永远为假 → 无限 setNodes。 */
  const deleteRef = useRef<(id: string) => void>(() => { /* 挂载前为空 */ })
  const onDeleteStable = useCallback((id: string): void => {
    deleteRef.current(id)
  }, [])

  /* 浏览器偏好（第二层，改的是标签的设置）的稳定引用。 */
  const prefsSetterRef = useRef<(p: BrowserPrefs) => void>(() => { /* 挂载前为空 */ })
  const changeBrowserPrefsStable = useCallback((p: BrowserPrefs): void => {
    prefsSetterRef.current(p)
  }, [])

  const nodesWithVars = useMemo(() => {
    const vars = computeAvailableVars(nodes, edges)
    /** 节点显示名（实例名优先，退回类型名）—— 候选清单里用它，用户认得出。 */
    const nameOf = (n: V1Node): string => {
      const custom = typeof n.data.label === 'string' ? n.data.label.trim() : ''
      return custom !== '' ? custom : n.data.def.label
    }
    /**
     * 「选节点 + 选字段」的候选（照 Dify 的 ValueSelector）。
     *
     * 候选来源按用途分两种：
     *   - **上游节点**：循环的「遍历哪个数据」要从**它前面**产出的数组里选；
     *   - **容器内节点**：循环的「结果取哪个」只能从**循环体里**选。
     *
     * 所以这里给的是「上游 ∪ 体内」并集，由**参数自己**决定用得上哪些 ——
     * 分两套清单会让界面要传两个 prop，而现在一个就够（用户可以选错，
     * 但执行侧会明确报错说「这次没跑」或「不是列表」，不会静默）。
     */
    const upstreamOfNode = (id: string): Set<string> => {
      /* 沿入边往上走到不动点（带环保护）。 */
      const seen = new Set<string>()
      const stack = edges.filter(e => e.target === id).map(e => e.source)
      while (stack.length > 0) {
        const cur = stack.pop() as string
        if (seen.has(cur)) continue
        seen.add(cur)
        for (const e of edges) if (e.target === cur) stack.push(e.source)
      }
      return seen
    }
    const fieldsOf = (n: V1Node): { id: string, label: string }[] =>
      n.data.def.outputs.map(o => ({ id: o.id, label: o.label }))

    /**
     * 条件左边能选什么（上游节点 / 循环变量 / 开始节点的输入）。
     *
     * 规则本身在 `if-sources.ts`（纯逻辑、可单测），这里只把画布节点翻译成
     * 它的入参形状。搬出去的理由：本文件 import 了 `.module.css`，Node 直接跑不起来
     * （`ERR_UNKNOWN_FILE_EXTENSION`），而那三条规则错了表现为
     * 「界面上能选、跑起来取不到」—— 那种错必须能单测。
     */
    const sourceNodes = nodes
      /* 分组框不是真节点（`type: 'group'`，`__group` 占位定义）—— 它不产出数据，
       * 列进「上游节点」里只会让用户选到一个永远取不到的值。 */
      .filter(n => n.type !== 'group')
      .map(n => ({
        id: n.id,
        label: n.data.label,
        defId: n.data.def.id,
        defLabel: n.data.def.label,
        fields: n.data.def.outputs.map(o => ({ id: o.id, label: o.label })),
        parentId: n.parentId,
      }))
    const paramsOfNode = (id: string): Record<string, unknown> =>
      nodes.find(x => x.id === id)?.data.params ?? {}

    return nodes.map(n => {
      /* 本节点的候选：上游 + 同容器内的兄弟（排除自己）。 */
      const ups = upstreamOfNode(n.id)
      const siblings = n.parentId === undefined
        ? []
        : nodes.filter(x => x.parentId === n.parentId && x.id !== n.id).map(x => x.id)
      const pool = new Set([...ups, ...siblings])
      const fieldCandidates: FieldCandidate[] = nodes
        .filter(x => pool.has(x.id) && x.type !== 'group')
        .map(x => ({ id: x.id, name: nameOf(x), fields: fieldsOf(x) }))
      return {
        ...n,
        data: {
          ...n.data,
          /* 分组框的标题 / 描述 / 收起 —— 分组框用的是 `groupLabel`（历史字段名），
           * 描述与收起与普通节点共用 `note` / `collapsed`。
           * 三个回调都只在 `type === 'group'` 时挂（其他节点忽略）。 */
          onRename: (v: string) => { onRenameStable(n.id, v) },
          availableVars: vars[n.id] ?? [],
          fieldCandidates,
          /* 「跑另一份工作流」的候选（2026-10-19）：那个节点的参数从「填名字」
           * 改成了「选编号」，控件要一份清单。**只给用得上它的节点挂**
           * （判据是参数里真有 `kind: 'workflowRef'` 的项，与 `hasSession` 同一个路子），
           * 免得每个节点都带着一份几十项的清单。 */
          ...(n.data.def.paramDefs ?? []).some(p => p.kind === 'workflowRef')
            ? { workflowCandidates: wfCandidates }
            : {},
          /* 条件表的候选来源（`flow.if` 的「选变量 + 比较符 + 值」）。
           * 与 `workflowCandidates` 同一个路子：**只给用得上它的节点挂**，
           * 免得每个节点都带着一份清单（那会让整张图的 memo 变重）。
           *
           * ⚠️ 左边只给**上游**节点，不给同容器的兄弟（与循环的 `fieldCandidates`
           * 不同）。理由：循环要能从体内兄弟取结果，而 IF 判的是「前面传来的东西」
           * —— 用户原话「IF 前面的节点就是传入信息的」。把下游兄弟列进来只会让人选错，
           * 然后运行期报「没取到」。 */
          ...(n.data.def.paramDefs ?? []).some(p => p.kind === 'ifRules')
            ? { ifSources: ifSourcesFor(sourceNodes, edges, n.id, paramsOfNode) }
            : {},
          /* 浏览器一节（用户 2026-10-13：「标签→浏览器应该是在节点设置」）。
           *
           * ⚠️ **只给管会话的节点挂**（`session` 参数 = 浏览器节点）——
           * 别的节点传 undefined，那一节就不出现。判据用 `hasSession(def.paramDefs)`
           * （与节点上的会话色标同一个判据，见 `session-color.ts`），
           * 不写死节点 id：将来再有管会话的节点会自动带上。 */
          ...hasSession(n.data.def.paramDefs)
            ? {
              browser: {
                tag: String(n.data.params.session ?? '默认'),
                onTag: (t: string) => { onParamStable(n.id, 'session', t) },
                /* ⚠️ **直接读 state，不读 ref**（2026-10-14 修）：
                 * ref 是在**提交后的 effect** 里才写的，而这段是渲染期的 `useMemo`
                 * —— 同一轮里 memo 先跑、effect 后跑，所以读 ref 会拿到**上一轮**的值
                 * （表现是「改完设置界面不变，要再动一下才更新」）。
                 * 现在 `browserPrefs` 已在依赖数组里，直接用它就是**同一轮的值**。 */
                prefs: browserPrefs,
                onPrefs: changeBrowserPrefsStable,
                browsers: detectedBrowsers,
                /* ⚠️ 把宿主半的检测结果一起传下去（2026-10-14 加）。
                 * 它的用途 2026-10-15 收窄了：现在**只剩**给端口下拉提供候选值
                 * （`cdp.endpoints`）—— 原来那排「点一下填上」的按钮已按
                 * 用户 m03425 的要求删掉，「端口在不在」交给设置那边检测。 */
                detect: detectState,
                otherTags: browserTags,
              },
            }
            : {},
        /* 删除节点（用户 m03500：按钮放在**节点外面**的工具条上）。
         * 这里只传回调，按钮本体在 `WorkflowNode.tsx` 的 `NodeToolbar` 里。 */
        onDelete: () => { onDeleteStable(n.id) },
        /* 分组框的四个回调（契约 CE）：改名 / 改描述 / 收起 / 四角改大小。
         *
         * ⚠️ 它们的实现都在**节点自己的 data 上**写，不再改一份外部名单 ——
         * 所以这里传的是稳定引用的包装（`*Stable`），否则每个节点的 data 引用每次渲染都变，
         * React Flow 会认为整图都更新（节点挤在一起、拖动失效，本项目踩过）。 */
        ...n.type === 'group'
          ? {
            onRename: (v: string) => { onGroupRenameStable(n.id, v) },
            onNote: (v: string) => { onGroupNoteStable(n.id, v) },
            onToggleCollapse: () => { onToggleCollapseStable(n.id) },
            onResize: (w: number, h: number) => { onGroupResizeStable(n.id, w, h) },
          }
          : { onLabel: (v: string) => { onSetNameStable(n.id, v) }, onNote: (v: string) => { onSetNoteStable(n.id, v) } },
        /* ⚠️ 循环框的收起 / 改名回调放**这里**（渲染期派生），不放那个 effect。
         *
         * 为什么：那个 effect 只在 `expandedNode` 变化时跑，而循环框的按钮是**常显**的
         * （普通节点要先点开才用得到回调）。新加的循环节点若等不到那次 effect，
         * 收起按钮就是个死按钮 —— 实测踩到过。
         * 这里是 `useMemo`，`nodes` 一变就重算，天然覆盖「刚加进来」这一刻。 */
        ...n.data.def.id === LOOP_DEF_ID
          ? {
            onToggleCollapse: () => { onToggleCollapseStable(n.id) },
            onSetName: (v: string) => { onSetNameStable(n.id, v) },
            onToggleSettings: () => { onToggleSettingsStable(n.id) },
            /* ★ 框内竖排 / 横排的切换（用户 2026-10-21）。
             *
             * `axisAuto` 是「画布方向推出来的那个」（用户没手动切过时生效）。
             * 它要一起传下去 —— 否则第一次点击时组件不知道「当前实际是哪个方向」，
             * 取反就会切错（比如自动是竖排，点一下应该变横排，而不是又变竖排）。
             *
             * ⚠️ `dir` 必须在依赖里（那个 useMemo 的依赖数组末尾），
             * 否则换画布方向之后 `axisAuto` 还是旧值。 */
            axisAuto: innerAxisOf(dir),
            onToggleAxis: () => { onToggleAxisStable(n.id, innerAxisOf(dir)) },
            onSettingsHeight: (h: number) => { onSettingsHeightStable(n.id, h) },
            /* 空体警告（2026-10-17 加）：循环框里一个节点都没有时，
             * 就地显示红色提示 —— 不必等到点「运行」才报错。
             *
             * 判据与执行层**同源**：`loopPlan` 的 `bodyIds` 就是
             * 「`parentId` 指向这个循环的节点」，不看类型。两边一致才不会出现
             * 「界面说它空、运行却跑起来了」这种自相矛盾。 */
            bodyEmpty: nodes.every(x => x.parentId !== n.id),
            /* ★ 跳出条件能选什么（2026-10-19，`breakConditions`）。
             *
             * 与 `ifSources` **形状相同、内容不同**：这里的 `fields` 是
             * **这个循环体内**的节点（判的是「这一轮跑得怎么样」），
             * 不是「上游节点」。规则住在 `if-sources.ts` 的 `breakSourcesFor`
             * （纯逻辑、可单测），这里只把画布节点翻译成它的入参形状。
             *
             * ⚠️ 必须传：`LoopNode.tsx` 里那个条件控件拿不到来源就是一个空下拉，
             * 用户点了「添加一条」却选不到任何值 —— 那正是
             * 「定义里有、界面上没有」的同一类坑。 */
            breakSources: breakSourcesFor(sourceNodes, n.id, paramsOfNode),
          }
          : {},
        },
      }
    })
  }, [
    nodes, edges, onRenameStable, onToggleCollapseStable, onSetNameStable, onSetNoteStable,
    /* 分组框的改名 / 改描述 / 改大小（契约 CE）—— 同样是稳定引用，放进来不留隐患。 */
    onGroupRenameStable, onGroupNoteStable, onGroupResizeStable,
    /* 循环的「设置」开关也要 —— 它是稳定引用，放进来只是不留隐患（同下面 onParamStable）。 */
    onToggleSettingsStable,
    /* ★ 框内竖排/横排的切换（用户 2026-10-21）。同样稳定，放进来不留隐患。 */
    onToggleAxisStable,
    /* ⚠️ **`dir` 必须在依赖里**：循环框的 `axisAuto` 由 `innerAxisOf(dir)` 算，
     * 换画布方向之后不重算的话，那个框的「自动方向」还停在旧值上 ——
     * 表现是「切了画布方向，循环框里的排法没跟着变」。 */
    dir,
    /* 循环设置面板的实测高度回调 —— 同样是稳定引用，放进来不留隐患。 */
    onSettingsHeightStable,
    /* ⚠️ `onParamStable` 也要在里面 —— 浏览器一节的「标签」回调经它改 `session`。
     * 它是 `useCallback` 空依赖，引用恒定，放进来只是为了不留隐患。 */
    onParamStable,
    /* ⚠️ **`browserPrefs` 与 `detectedBrowsers` 也要在依赖里**（2026-10-14 加）：
     * 浏览器一节读到的是 `browserPrefsRef.current` 与 `detectedBrowsers`，
     * 它们变了这段 `useMemo` 必须重算 —— 否则「改了设置 / 检测到了浏览器」
     * 要等到下次动节点才显示（T7 实测到的既存 bug，详见下面 effect 的说明）。 */
    browserPrefs, detectedBrowsers,
    /* ⚠️ **工作流清单也要**（2026-10-19）：「选一份工作流」的候选取自它，
     * 少了这一项，清单晚一步到（画布挂载后 fetch 才回来）时控件会一直是空的 ——
     * 而那份清单恰恰是**异步**来的，这个依赖不是可有可无的。 */
    wfCandidates,
  ])

  /* ⚠️ 偏好或标签变了 → 把第二层重新解析进节点 params。
   * 这是「第一层决定第二层、其他节点自动统一」的**唯一执行点**。
   * 幂等（值没变返回原引用），所以不会无限重渲染。 */
  useEffect(() => {
    setNodes(ns => syncBrowserLayer(ns))
  }, [browserPrefs, syncBrowserLayer, setNodes])

  /** 当前选中的节点数（计数条要显示）。 */
  const selCount = useMemo(() => nodes.filter(n => n.selected === true).length, [nodes])


  /**
   * ## 分组框**不再是派生出来的假节点**（2026-10-26 契约 CE）
   *
   * 上一版这里有个 `groupBoxNodes` memo：按成员包围盒算出框的坐标尺寸、拼成假节点。
   * 组变成真节点之后它**整个不需要了** —— 框的坐标就是节点自己的 `position`，
   * 尺寸就是节点自己的 `width` / `height`（React Flow 直接读），
   * 下面 `shownNodes` 直接把 `nodesWithVars` 交出去。
   *
   * ⚠️ 组节点的**层级仍然要压在最底下**：建组时给了 `zIndex: 0`，
   * 且数组顺序上把组放最前（两样都做，React Flow 才稳定地画在成员底下）。
   * 存档读回时也是这个顺序（见 `workflow-doc.ts` 的 `finalNodes`）。
   */

  /**
   * 真正交给 React Flow 渲染的节点。
   *
   * ⚠️ **必须用 `useMemo` 且依赖 `[nodesWithVars, nodes]`** —— 直接写
   * `nodes={nodesWithVars}` 会让每次渲染都新建数组，React Flow 认为整图都变了。
   */
  const shownNodes = useMemo<V1Node[]>(() => {
    /* ⚠️ **收起态要把循环体成员从画布上藏掉**（2026-10-16 加，用户原话：
     * 「循环的收起展开**没有实际作用**」）。
     *
     * 原来只翻 `collapsed` 那一位，而 `LoopNodeCard` 收起时仅仅不画
     * `.loopBody` 那块**空白背景** —— 成员节点是 React Flow 平铺画的
     * （实测：`.react-flow__node[data-id=k1]` 与循环框是**兄弟**，不在框里），
     * 所以它们照旧原样显示。用户点了收起，看到的就是「什么都没变」。
     *
     * 只在**交出去的这一份**上打 `hidden`，不回写 `nodes`：
     * 收起是显示语义（照 Dify），不能影响存档、也不能影响执行 ——
     * `nodes` 里成员始终在，`runGraph` 读的也是 `nodes`。
     *
     * 判据是「它的 `parentId` 指向的那个循环框收起了」。
     * ⚠️ **这条只服务循环框**：分组框用的是 `groupId`（不是 `parentId`），
     * 而且组收起时**不该**藏成员（组只是画在成员底下的一块框，见 `GroupNode.tsx` 文件头）。
     */
    const collapsedLoops = new Set(
      nodes.filter(n => n.data.def.id === LOOP_DEF_ID && n.data.collapsed === true).map(n => n.id),
    )
    const list = nodesWithVars
    if (collapsedLoops.size === 0) return list
    return list.map(n => {
      const pid = n.parentId
      if (pid === undefined || !collapsedLoops.has(pid)) return n
      return { ...n, hidden: true }
    })
  }, [nodesWithVars, nodes])

  /**
   * 连线颜色跟随源端口色——节点状态一变就得重算，所以连线在这里派生。
   *
   * ## ⚠️ 收起态的成员：**连到它的边也要藏起来**（2026-10-21 修的 008）
   *
   * 用户报：`Error code 008：Couldn't create edge for target handle id: "in", edge id: e6.`
   *
   * React Flow 的 008 = 「按这条边去找端点的端口，没找着」。
   * 成因：`shownNodes` 把「父循环已收起」的成员打了 `hidden` —— **节点不渲染**，
   * 于是它身上那个 `in` 端口也不存在；而这条边还在 `edges` 里点名要那个端口
   * → 每次渲染都报一次 008（画布上还会留一条连到空气的线）。
   *
   * 注释里原先写着「React Flow 自己会让相关边一起不画」—— **那是错的**
   * （实测报了 008）。它只在「端点节点存在但 hidden」时不画边；
   * 而我们是**从 nodes 数组里把渲染交出去的那份里打了 hidden**，
   * 端口随之消失，React Flow 只能报错。
   *
   * 修法：自己也藏 —— 判据与 `shownNodes` 那条**同源**（父循环收起了）。
   * 两处必须用同一个判据，否则又会漂成「节点藏了、边还在」或反过来。
   */
  const shownEdges = useMemo(() => {
    /* 规则住在 `hidden-edges.ts`（纯函数，有单测）。
     * ⚠️ 为什么不写在这里：jsdom 没有布局、React Flow 一条边都画不出来，
     * 「边有没有被藏」在 DOM 上**测不到**（收起前就是 0 条 → 断言永远绿）。
     * 抽出去之后 `tests/edge-hidden.mjs` 能直接喂数据看结果。 */
    const hidden = hiddenEdgesOf(nodes, edges)
    return edges.map((e, i) => {
      const decorated = decorateEdge(defs, nodes, e)
      return hidden[i] === true ? { ...decorated, hidden: true } : decorated
    })
  }, [edges, nodes, defs])

  // 把展开态 / 运行回调 / 编辑回调 同步进节点 data
  useEffect(() => {
    setNodes(ns => ns.map(n => {
      const shouldExpand = expandedNode === n.id
      const d = n.data
      const isLoop = d.def.id === LOOP_DEF_ID
      /* 循环框不需要「展开参数区」那套（它自己带设置面板），但需要收起 / 改名回调。
       *
       * ⚠️ 判据必须看**回调在不在**，不能看 `collapsed !== undefined`
       * （2026-10-12 踩到）：`collapsed` 本来就可以是 undefined（表示展开态），
       * 拿它当「注入过没有」的标志会让 `same` **永远是假** →
       * 每次渲染都 `setNodes` → 无限重渲染。
       * （`dom-render` 的「无限渲染告警」断言当时没抓到，因为它看的是 React 的告警文案，
       *   而这一处只是白重渲染、没触发 React 的循环告警。） */
      const same = isLoop
        ? d.onToggleCollapse !== undefined && d.onSetName !== undefined
        : d.editMode === 'inline' && d.expanded === shouldExpand
          && d.onRunOne !== undefined && d.onRunFrom !== undefined
          && d.onParam !== undefined && d.onDelete !== undefined
      if (same) return n
      const id = n.id
      return {
        ...n,
        data: {
          ...d,
          editMode: 'inline' as const,
          expanded: isLoop ? false : shouldExpand,
          /* 回调包装成「稳定引用」，从 ref 读最新实现 —— 避免把 runSeq 拖进依赖链 */
          onRunOne: () => { runOneRef.current(id) },
          onRunFrom: () => { runFromRef.current(id) },
          onParam: (key: string, value: unknown) => { onParamRef.current(id, key, value) },
          onOnError: (v: OnError) => { onOnErrorRef.current(id, v) },
          /* 循环框用这两个（普通节点忽略）。 */
          onToggleCollapse: () => { onToggleCollapseStable(id) },
          onSetName: (v: string) => { onSetNameStable(id, v) },
        },
      }
    }))
  }, [expandedNode, setNodes, onToggleCollapseStable, onSetNameStable])

  /**
   * 进场先跑一次 ELK 自动布局 + 缩放适配。
   *
   * ⚠️ **必须等 React Flow 把节点渲染出来再跑**（2026-10-10 修）：
   * `measureNodes` 靠读节点的 `getBoundingClientRect()` 拿真实尺寸；
   * 挂载瞬间节点还没进 DOM，它返回**空表** → ELK 用默认尺寸算布局 →
   * 所有节点坐标**挤在一起**（表现为画布上只有左上角一小块有东西）。
   *
   * 等待方式：轮询到「节点 DOM 数与节点数一致且尺寸都非 0」为止，最多等 2 秒。
   * 用轮询而不是固定 setTimeout：节点数量与渲染耗时都会变，固定延时不可靠。
   */
  useEffect(() => {
    let cancelled = false
    const started = Date.now()

    /** 检查节点是否都已渲染且有尺寸。 */
    const ready = (): boolean => {
      const el = wrapRef.current
      if (el === null) return false
      const doms = el.querySelectorAll('.react-flow__node[data-id]')
      if (doms.length === 0 || doms.length < nodes.length) return false
      /* 尺寸也必须有 —— 光有 DOM 不够，React Flow 可能还没测量。 */
      const measured = measureNodes(el)
      return measured.size >= nodes.length
    }

    const tick = (): void => {
      if (cancelled) return
      if (ready()) {
        void (async () => {
          const pos = await elkLayout(nodes, edges, measureNodes(wrapRef.current), dir, nodeWRef.current, spacingRef.current ?? undefined)
          if (cancelled) return
          /* ⚠️ 与 `runLayout` 同一件事：`pos` 里**只有顶层节点**（容器成员不在里面，
           * 它们存的是相对坐标）。所以要走 `refitNodes` 把成员的框内排列与框的尺寸
           * 一起算出来 —— 少了这一步，「刚打开一份带循环的工作流」成员就会散在框外
           * （用户 2026-10-15 报的第二个现象）。
           *
           * ⚠️⚠️ **必须走函数式 setNodes，不能写 `refitAll(nodes.map(...))`**
           * （2026-10-15 我自己踩的坑，`browser-two-layers` 当场抓到）：
           * 这个 effect 的依赖是 `[]`，闭包里的 `nodes` 是**首次渲染那一份**
           * （往往是空的 —— 存档是异步加载的）。原来这里是
           * `setNodes(ns => ns.map(...))`，即使 pos 算出来是空表也只是
           * 「谁都不动」；改成传值之后，空数组会**整个覆盖掉后来加载的节点**
           * → 画布空白、`[class*="_block"]` 找不到、切来源后界面不更新。 */
          setNodes(ns => refitNodes(ns.map(n => pos[n.id] === undefined ? n : { ...n, position: pos[n.id] })))
          window.setTimeout(() => { flowToScreenApi.current?.fitView({ padding: 0.22 }) }, 80)
        })()
        return
      }
      /* 最多等 2 秒；超时也跑一次（用兜底尺寸），总比不布局好。 */
      if (Date.now() - started > 2000) {
        void (async () => {
          const pos = await elkLayout(nodes, edges, measureNodes(wrapRef.current), dir, nodeWRef.current, spacingRef.current ?? undefined)
          if (cancelled) return
          /* 同上：走函数式，闭包里的 `nodes`（依赖为 []）是首帧那一份。 */
          setNodes(ns => refitNodes(ns.map(n => pos[n.id] === undefined ? n : { ...n, position: pos[n.id] })))
          window.setTimeout(() => { flowToScreenApi.current?.fitView({ padding: 0.22 }) }, 80)
        })()
        return
      }
      window.setTimeout(tick, 50)
    }
    tick()

    return () => { cancelled = true }
    // 只在挂载时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])


  /**
   * 启动自检（2026-10-10）：把画布容器的实测尺寸与 React Flow 的状态说出来。
   *
   * 为什么需要：用户报「画布完全空白」，但自动化测试（jsdom 无布局）测不出来。
   * 这段在真机挂载后 800ms 检查一次，只在**异常时**提示——正常时不打扰。
   * 判据：容器宽或高为 0（React Flow 不渲染视口）、或节点数为 0（本该有示例节点）。
   */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const el = wrapRef.current
      if (el === null) { notify('画布容器没挂上（wrapRef 为空）', 'error'); return }
      const r = el.getBoundingClientRect()
      const flow = el.querySelector('.react-flow')
      const nodes = el.querySelectorAll('.react-flow__node').length
      if (r.width === 0 || r.height === 0) {
        notify('画布尺寸为 0（' + Math.round(r.width) + '×' + Math.round(r.height) + '）——React Flow 不会渲染视口。检查父级高度链', 'error')
      } else if (flow === null) {
        notify('画布尺寸正常（' + Math.round(r.width) + '×' + Math.round(r.height) + '）但 React Flow 未挂载', 'error')
      } else if (nodes === 0) {
        notify('React Flow 已挂载但画布上 0 个节点（示例内容没加载进来）', 'warn')
      }
    }, 800)
    return () => { window.clearTimeout(timer) }
    /* 只在挂载后跑一次 */
  }, [notify])

  // 卸载时取消在跑的派发（否则关了页面后台还在跑）
  useEffect(() => () => { runAbort.current?.abort() }, [])

  // 挂载时探一次宿主半：拿到它的工作目录，并判断引擎是否连上
  useEffect(() => {
    void (async () => {
      const r = await probeEngine()
      /* ⚠️ 只留这一行：探测的**唯一用处**是拿到工作目录。
       * 原来这里还有 `setEngineOk(r.ok)`，那个 state 已随引擎状态显示一起删掉。 */
      if (r.workdir !== undefined) workdirRef.current = r.workdir
    })()
  }, [])

  /**
   * 缺依赖的节点类型（`def.id` → 缺什么 + 怎么装）。
   *
   * ## 为什么是 ref 而不是 state
   *
   * 它只在「标记节点状态」那一刻被读一次，读完就交给 `nodes[].data` ——
   * 放进 state 会让「取到清单」这件事本身触发一次全画布重渲染，
   * 而重渲染会把运行中的节点状态、坐标抖动等一起带上（这个文件对那条极敏感，
   * 见 `shiftSigRef` 那段注释讲的白屏事故）。
   *
   * 判据来源：`GET /nodes/deps`（票 22），每次取都现查，不缓存 ——
   * 用户装完东西回来重开画布就该看到它是好的。
   */
  const depsGapRef = useRef<Map<string, { gaps: { kind: string, name: string }[], reason: string }>>(new Map())

  /**
   * 按缺件清单把节点标成 `missing`。
   *
   * ⚠️ 不动正在跑的节点：`running` / `queued` 的状态是运行事实，
   * 拿一个静态检查去覆盖它会让人以为「跑着的节点突然缺件了」。
   * 也只标 `idle`（以及原本就是 `missing` 的）—— `success` / `failed` / `cancelled`
   * 是跑过之后的事实，比静态检查更准。
   *
   * @param list - 节点集。
   * @returns 新的节点集（没变时返回原数组，避免无意义的重渲染）。
   */
  const markMissingDeps = useCallback((list: V1Node[]): V1Node[] => {
    const gaps = depsGapRef.current
    if (gaps.size === 0) return list
    let changed = false
    const next = list.map(n => {
      const gap = gaps.get(n.data.def.id)
      if (gap === undefined) return n
      const st = n.data.state
      const touchable = st === 'idle' || st === 'missing'
      if (!touchable) return n
      if (st === 'missing' && n.data.depsGap !== undefined) return n
      changed = true
      return { ...n, data: { ...n.data, state: 'missing' as NodeState, depsGap: gap } }
    })
    return changed ? next : list
  }, [])

  /* 取一次缺件清单，然后标记。只在挂载时取一次 —— 它要回答的是
   * 「现在这台机器上哪些节点跑不了」，改完环境重开画布就该重新问一遍。 */
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/ecom-workbench/nodes/deps')
        if (!res.ok) return
        const body = await res.json() as {
          missing?: { id: string, gaps: { kind: string, name: string }[], reason: string }[]
        }
        const m = new Map<string, { gaps: { kind: string, name: string }[], reason: string }>()
        for (const one of body.missing ?? []) {
          if (typeof one?.id !== 'string' || one.id === '') continue
          m.set(one.id, { gaps: Array.isArray(one.gaps) ? one.gaps : [], reason: String(one.reason ?? '') })
        }
        depsGapRef.current = m
        /* 清单到了才标 —— 顺序很重要：先标再取清单的话，
         * 那一轮 `gaps.size === 0` 会立刻 return，等于没标。 */
        setNodes(ns => markMissingDeps(ns))
      } catch { /* 取不到就不标：宁可不显示，也不许瞎标「缺件」 */ }
    })()
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [])

  /** 新增一个节点（从节点库拖入，或点库项）。 */
  const addNode = useCallback((def: NodeDef, pos?: { x: number, y: number }): void => {
    recordHistory()
    idRef.current += 1
    const id = 'n-' + String(idRef.current)
    const fallback = { x: 120 + (idRef.current % 5) * 30, y: 90 + (idRef.current % 4) * 40 }
    const node: V1Node = {
      id,
      type: 'v1',
      position: pos ?? fallback,
      selected: true,
      // 参数与失败策略**拷到实例**（独立副本，改一个不影响同类型的其他节点）
      data: { def, state: 'idle' as NodeState, progress: undefined, params: { ...(def.params ?? {}) }, onError: def.onError },
    }
    /* 新增的节点如果缺依赖，一出生就是 `missing`（票 22）——
     * 不等「下一次重开画布」。判据与挂载时那一遍是同一份（`markMissingDeps`）。 */
    const freshGap = depsGapRef.current.get(def.id)
    if (freshGap !== undefined) {
      node.data.state = 'missing' as NodeState
      node.data.depsGap = freshGap
    }
    /* 循环框一出生就得有尺寸 —— 否则它的包围盒是 0×0，
     * 「拖进容器」的判定（`containerAt` 要宽高 > 0）永远不命中，等于还是拖不进去。
     * 之后每次拖完 `fitLoopBox` 会按子节点重算。
     *
     * ⚠️ 起始尺寸用**最小尺寸**（`BOX_MIN_W/H`）而不是随便一个小值 ——
     * 用户 2026-10-13 报「加入后叠一起 / 拖不进去」，一个原因就是框太小没地方放。
     * 与 `fitLoopBox` 用**同一组常量**，两边不会漂。 */
    if (def.id === LOOP_DEF_ID) {
      node.style = { width: BOX_MIN_W, height: BOX_MIN_H, zIndex: 1 }
    }
    /* 加到**容器内**的落点 → 直接归它（照 Dify 的「归属在加的那一刻定」）。
     *
     * 为什么在这里定归属（而不是拖完再判）：用户 2026-10-13 定规矩
     * 「先看 n8n 与 Dify，**他们都没有的就不做**」—— Dify 的做法就是
     * 「新增节点时继承邻居的 parentId」（`use-nodes-interactions.ts:893`），
     * 它**没有**「把已存在的节点拖进容器」这件事（已进容器的节点拖动时被钳住）。
     *
     * ⚠️ 容器自己不能被放进容器里（否则「谁先谁后」成环）—— 所以限定非循环节点。 */
    const containerId = pos === undefined
      ? null
      : containerAt(containersOf(nodesRef.current, measureNodes(wrapRef.current)), pos)
    if (containerId !== null && def.id !== LOOP_DEF_ID) {
      /* `assignToContainer` 会把坐标转成**相对容器** —— 不转的话节点会跳到框外。 */
      const withNode = [...nodesRef.current.map(n => ({ ...n, selected: false })), node]
      setNodes(assignToContainer(withNode, id, containerId))
      setSelected(id)
      return
    }
    /* ⚠️ 显式标 `V1Node[]`（2026-10-24 契约 AK）。
     *
     * 不标的话 TS 把 `{ ...n, selected: false }` 推断成一个**对象字面量类型**
     * （`selected: boolean` 必填），而 `V1Node.selected` 是**可选**的 ——
     * `.concat(node)` 要把 `V1Node` 塞进那个更窄的元素类型，就报 TS2769。
     * 这不是代码错，是「推断出的类型比该有的更窄」；显式标一下即回正。 */
    setNodes(ns => {
      const cleared: V1Node[] = ns.map(n => ({ ...n, selected: false }))
      return cleared.concat(node)
    })
    setSelected(id)
  }, [setNodes])

  /** 从节点库拖到画布。 */
  /** 从节点库拖到画布。
   *
   * 修正（2026-10-08）：原来按屏幕坐标 1:1 落位，**缩放/平移后落点会错**。
   * 现在用 React Flow 的 screenToFlowPosition 正确换算。 */
  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const defId = e.dataTransfer.getData('application/v1-node')
    const def = defs.get(defId)
    if (def === undefined) return
    const pos = flowToScreenApi.current?.screenToFlowPosition
      ? flowToScreenApi.current.screenToFlowPosition({ x: e.clientX, y: e.clientY })
      : (() => {
        // 还没拿到实例时退回旧算法（至少能落位）
        const wrap = wrapRef.current
        const b = wrap?.getBoundingClientRect()
        return { x: e.clientX - (b?.left ?? 0), y: e.clientY - (b?.top ?? 0) }
      })()
    addNode(def, pos)
  }, [defs, addNode])

  /** 拖动时把「为什么连不上 / 这条线意味着什么」显示到工具条上（用户不用猜）。
   *
   * ⚠️ 这个 `useState` 必须放在下面 `onIsValidConnection` **之前** ——
   * 那个回调里会调 `setConnHint`，放在后面会踩「用在定义之前」（TS2448，本项目已踩五次）。
   */
  const [connHint, setConnHint] = useState('')

  const connCtx = useMemo(() => ({
    defs,
    nodeDefId: new Map(nodes.map(n => [n.id, n.data.def.id])),
    edges: edgesRef.current,
  }), [defs, nodes])

  /** 连这条线合法吗（React Flow 在拖拽时调用，不合法会显示禁止光标）。
   *
   * ⚠️ **2026-10-17 加了一条「跨容器说明」**（用户问过「循环外的节点直接连循环内的节点
   * 合法吗、循环内的节点能连到外面吗」）。
   *
   * 答案：**都合法**，而且都有意义 ——
   *   - 外 → 内：那条线是体内节点的**显式上游**（体内节点能读到外层的输出）；
   *   - 内 → 外：框外的下游照常拿到本轮结果。
   * 但**校验本身不管容器**（`connection-rules.ts` 只查自己连自己 / 成圈 / 单入口 / 类型），
   * 所以拖线的当时看不出「这条线跨了容器」。这里补一条提示，说明它意味着什么 ——
   * 免得用户以为连错了。
   */
  const onIsValidConnection = useCallback((conn: Connection | Edge): boolean => {
    const ok = checkConnection(conn, { ...connCtx, edges: edgesRef.current })
    setConnHint(ok ? crossContainerHint(conn, nodesRef.current) : '')
    return ok
  }, [connCtx])

  const onConnectStart = useCallback((): void => { setConnHint('') }, [])
  const onConnectEnd = useCallback((): void => { setConnHint('') }, [])

  /** 连一条新线（颜色稍后由 decorateEdge 按源端口补）。 */
  const onConnect = useCallback((c: Connection): void => {
    // 双重保险：拖拽时校验过，这里再校验一次（防止程序化添加绕过）
    if (!checkConnection(c, { ...connCtx, edges: edgesRef.current })) {
      setConnHint(whyInvalid(c, { ...connCtx, edges: edgesRef.current }))
      return
    }
    recordHistory()
    setConnHint('')
    /* 一个入口只能接一条线：连新的之前把该入口上旧的去掉 */
    setEdges(es => {
      const cleaned = es.filter(e => !(e.target === c.target && e.targetHandle === c.targetHandle))
      return addEdge({ ...c, id: 'e' + String(Date.now()) }, cleaned)
    })
  }, [setEdges, connCtx])

  /** 重连一条已有连线（拖端点改目标）。
   * @param oldEdge - 原连线。
   * @param conn - 新的连接信息。
   */
  const onReconnect = useCallback((oldEdge: Edge, conn: Connection): void => {
    recordHistory()
    setEdges(es => es.map(e => e.id !== oldEdge.id ? e : {
      ...e,
      source: conn.source ?? e.source,
      target: conn.target ?? e.target,
      sourceHandle: conn.sourceHandle ?? e.sourceHandle,
      targetHandle: conn.targetHandle ?? e.targetHandle,
    }))
  }, [setEdges])

  /** 节点变化：React Flow 的原生变更 + 同步选中态到浮卡。
   *
   * ## 分组框**不再需要在这里拦截**（2026-10-26 契约 CE）
   *
   * 上一版框是派生出来的假节点，所以拖它要「把位移转给每个成员、然后丢掉这条变更」。
   * 现在框是**真节点**：它有自己的 `position`，React Flow 的位移变更照传就是对的，
   * 成员不会跟着动 —— 那是「拖完重算归属」（`syncGroupsAfterDrag`）的事。
   *
   * ⚠️ 拖动**开始时**把成员一起加进被拖集合，才能做到「拖框，成员跟着走」
   * （参考项目 `project.tsx:1628-1633` 就是这么干的）。这一步在 `onNodeDragStart` 里。
   */
  const handleNodesChange = useCallback((changes: NodeChange<V1Node>[]): void => {
    onNodesChange(changes)
    for (const c of changes) {
      if (c.type === 'select' && c.selected) setSelected(c.id)
    }
  }, [onNodesChange])

  /**
   * 开始拖动时记一次历史（**不是结束时**）。
   *
   * 为什么在开始记：撤销要回到「拖动前」的坐标。若在结束时记，记下的是拖完的位置，
   * 撤销就变成「回到拖完的位置」——等于没撤销。
   * 同一次拖动里会触发很多次 onNodeDrag，但 onNodeDragStart 只触发一次，天然不会重复入栈。
   *
   * ## 拖**框**时把成员一起带上（契约 CE，照参考项目 `project.tsx:1628-1633`）
   *
   * 框不是父容器（成员没有 `parentId`），所以 React Flow **不会**自动让成员跟着走。
   * 参考项目的做法是「拖动开始时把成员的 id 一起加进 `dragIds`」；
   * 我们这边 React Flow 的「一起拖」靠**选中集**，而改选中会有视觉副作用。
   *
   * 所以改成：**记下组和成员各自的起点**，`onNodeDrag` 里按组的位移把成员同步推走。
   * 效果与参考项目一致（框动成员动），且不动选中态。
   *
   * @param _e - 事件（不用）。
   * @param node - 正在拖的节点。
   */
  const onNodeDragStart = useCallback((_e: unknown, node: V1Node): void => {
    recordHistory()
    if (node.type !== GROUP_NODE_TYPE) { groupDragRef.current = null; return }
    const members = new Map<string, { x: number, y: number }>()
    for (const n of nodesRef.current) {
      if (n.data.groupId === node.id) members.set(n.id, { x: n.position.x, y: n.position.y })
    }
    groupDragRef.current = { id: node.id, origin: { x: node.position.x, y: node.position.y }, members }
  }, [recordHistory])

  /**
   * 拖动节点：重算浮卡位置 + 算对齐辅助线。
   *
   * 只在拖动时算（事件驱动）——不用每帧轮询，拖完就清空辅助线。
   *
   * @param _e - React Flow 的事件（不用）。
   * @param node - 正在拖的节点。
   */
  const onNodeDrag = useCallback((_e: unknown, node: V1Node): void => {
    /* ⚠️ 这里**不再算容器归属**（2026-10-13 删）—— 归属改由「加节点那一刻」与
     * 右键菜单决定，拖动只管位置与对齐辅助线。
     * 为什么删见文件上方那段说明（n8n/Dify 都不靠拖动改归属）。 */

    /* ★ **拖框时把成员一起推走**（契约 CE）。
     *
     * 框不是父容器，React Flow 不会自动带成员。这里按「组的位移」把成员的
     * 起点同步平移 —— 效果与参考项目（拖动开始就把成员加进 `dragIds`）一致，
     * 但不动选中态（改选中会让用户看到一堆节点莫名其妙被选上）。
     *
     * ⚠️ 用**起点 + 总位移**算，不用增量累加：React Flow 每次给的是「现在在哪」，
     * 增量累加会把误差攒起来（框走 100px，成员走 103px）。 */
    const gd = groupDragRef.current
    if (gd !== null && gd.id === node.id && gd.members.size > 0) {
      const dx = node.position.x - gd.origin.x
      const dy = node.position.y - gd.origin.y
      setNodes(ns => ns.map(n => {
        const start = gd.members.get(n.id)
        if (start === undefined) return n
        return { ...n, position: { x: start.x + dx, y: start.y + dy } }
      }))
    }

    /* ★ **把成员钳在框内**（照 Dify 的 `getRestrictedIterationPosition`，2026-10-19 用户要）。
     *
     * Dify 的做法：成员一旦进了迭代框，拖动时被钳住、出不去 —— 因为它没有
     * 「拖出即移出」这个动作，成员能拖到框外就会变成「看着在外面、其实还属于它」。
     * 我们的归属也由右键菜单改，所以同样要钳。
     *
     * ⚠️ **只在「自己就在框里」且「框没收起」时钳**（判据在 `clampIntoLoop` 里）。
     * ⚠️ **不碰 `parentId`** —— 钳位置，不改归属。
     * ⚠️ **只服务循环框**：分组框走的是「拖出即脱离」（`syncGroupsAfterDrag`），
     *    钳住就和参考项目的行为反了。 */
    const clamped = clampIntoLoop(nodesRef.current, node.id, measureNodes(wrapRef.current), { w: NODE_W, h: NODE_H })
    if (clamped !== null) {
      setNodes(ns => ns.map(n => (n.id === node.id ? { ...n, position: clamped } : n)))
    }

    /* 其它节点的中心点（用实测尺寸，量不到就用估计值） */
    const w = wrapRef.current
    const centers = nodesRef.current.map(n => {
      const el = w?.querySelector<HTMLElement>('.react-flow__node[data-id="' + n.id + '"]')
      const r = el?.getBoundingClientRect()
      const nw = r?.width ?? NODE_W
      const nh = r?.height ?? NODE_H
      return { id: n.id, centerX: n.position.x + nw / 2, centerY: n.position.y + nh / 2 }
    })
    const self = centers.find(c => c.id === node.id)
    if (self === undefined) return
    const r = computeHelperLines(self, centers, node.position)
    setHelperLines(r.lines)
  }, [setNodes])

  /**
   * 让**所有容器**（分组框 + 循环框）贴紧各自的子节点，**一次** setNodes。
   *
   * ## 为什么收成一个函数（这里有两个真 bug 的教训）
   *
   * ① **贴边函数不许自己读 `nodesRef.current`**。
   *    `nodesRef.current = nodes` 在**渲染期**才同步，所以
   *    `setNodes(移出结果)` 之后立刻调贴边函数时，它读到的是**移出前**的数组 →
   *    算出「框里还有那个节点」→ `setNodes(旧数组)` → **把移出覆盖掉**。
   *    实测（`fitLoopBox` 对旧数组确实返回新数组，于是真的 setNodes）：
   *    覆盖后 `parentId` 变回 `L`，现象就是用户报的
   *    「有悬浮窗提醒和顶部提醒，但是实际没有移出」。
   *
   * ② **两个贴边函数连着调会互相覆盖**。
   *    `setNodes` 传的是**值**（不是更新函数），后调用的那个赢 ——
   *    于是先算出来的那份尺寸变化丢掉。
   *    这也是「加进去之后框不立刻变大」的另一半原因。
   *    （2026-10-13 编组换成名单模型后，分组框这一侧已经不需要贴边；
   *    这条纪律现在只服务**循环框**与将来可能加的贴边逻辑。）
   *
   * 收成一个函数、**中间结果在局部变量里传递、最后只 setNodes 一次**，两个问题一起消掉。
   *
   * @param base - 要基于的节点数组（调用方刚算出来的那个）。
   * @returns 无。
   */
  const refitNodes = useCallback((base: V1Node[]): V1Node[] => {
    /* ⚠️ **分组框不需要贴边了**（2026-10-13 新模型）：
     * 它的位置尺寸是**渲染时按成员包围盒算出来的**，没有任何存在节点上的尺寸要更新。
     * 这一条正是换模型换来的好处 —— 旧模型那族「贴边读到旧数组把改动覆盖掉」
     * 的 bug 从根上不存在。
     * 剩下要处理的只有**循环框**（它仍是 parentId 容器）。 */
    let next = base
    const sizes = measureNodes(wrapRef.current)
    /* ② 循环框：**先重排框内成员，再贴边**。
     *
     * ⚠️ 顺序不能反：贴边算的是「成员包围盒 + 内边距」，
     * 若先贴边再重排，那一轮贴出的尺寸就是错的（要等下一次拖拽才修正）。
     *
     * 重排是用户 2026-10-13 的要求：「加入拖动加入循环后应该立即自动排版，
     * 不然一开始加入的时候叠一起了。」
     *
     * ⚠️ **循环框的遍历顺序是「内层先、外层后」**（2026-10-19，见 `orderLoopsInnerFirst`）：
     * 外层要给内层循环留位，留的必须是内层**这一轮**的尺寸。
     * 按数组原顺序走就可能先排外层、读到的还是内层上一轮的尺寸
     * → 内层框长出来之后压住外层的下一个成员。 */
    /* 轴向：所有嵌套层用**同一个**（用户 2026-10-21：「不应该每次转」）。
     * 某个框想不一样，由用户在框头上手动切（LoopNodeData.axis）。 */
    for (const loopId of orderLoopsInnerFirst(next)) {
      const laid = relayoutInside(next, loopId, edgesRef.current, sizes, { w: NODE_W, h: NODE_H }, dirRef.current)
      if (laid !== next) next = laid
      const r = fitLoopBox(next, loopId, sizes, { w: NODE_W, h: NODE_H })
      if (r !== next) next = r
    }
    return next
  }, [])

  /**
   * 重排容器内部 + 贴边，然后写回。
   *
   * ⚠️ **2026-10-15 改成「纯函数 + 调用方自己 setNodes」**，不再在这里判「有没有变化」。
   *
   * 原来它做的是一次**值比较 + 条件 setNodes**（`if (next !== base) setNodes(next)`），
   * 意图是「无变化就别 setNodes」（防无限重渲染）。但那个判据用错了地方：
   * `base` 常常是调用方**刚 map 出来的新数组**（自动布局写新坐标、`assignToContainer`
   * 都是），此时 `refitNodes` 若判「循环框没变化」会**原样返回 base**（引用相等）→
   * 这里就认定「无变化」→ **不 setNodes** → 新坐标被静默丢掉。
   * 症状是「点自动布局没反应」，`dom-render` 的「间距 10 与 380 排出来不同」
   * 那条当场抓到（2026-10-15）。
   *
   * 现在契约清晰：**`refitNodes` 只算不写，写回由调用方做**。
   * 幂等不再靠这个判据 —— `setNodes(同一个引用)` React 本来就会跳过重渲染。
   *
   * @param base - 要基于的节点数组。
   * @returns 无。
   */
  const refitAll = useCallback((base: V1Node[]): void => {
    setNodes(refitNodes(base))
  }, [refitNodes, setNodes])
  /* 收起/展开要用它（见 `refitNodesRef` 的说明）—— 在**渲染期**同步最新实现。 */
  refitNodesRef.current = refitNodes

  /**
   * 拖完：清辅助线 + 让容器贴紧。
   *
   * ## ⚠️ 这里**不再改容器归属**（2026-10-13 删）
   *
   * 原来拖完会按落点判定「进哪个容器 / 出哪个容器」，还带悬停 1 秒确认、
   * 半进半出提示、连带下游移出 —— **那整套是两家都没有的做法**：
   *   - n8n：组成员由**连线**决定（连线时自动吸收），没有拖进拖出，
   *     连「单个移出」都没有（只能整组解散）；
   *   - Dify：归属在**加节点那一刻**由邻居继承，已进容器的节点**拖动时被钳住**、出不去。
   *
   * 用户 2026-10-13 定规矩：「先看 n8n 与 Dify，**他们都没有的就不做**」，
   * 并指出循环的「出入都不应该在里面的节点上」。所以整套删掉。
   *
   * 归属现在由两处确定：
   *   1. **从节点库加到画布时**：落点在容器内 → 归它（「加的那一刻定」，与 Dify 同）；
   *   2. **右键菜单**：「放入循环 / 移出循环」（显式、可控）。
   *
   * 拖动只负责两件事：位置（React Flow 自己管）+ 让容器重新贴边。
   */
  const onNodeDragStop = useCallback((): void => {
    setHelperLines([])
    /* 拖框的记账作废：下一次拖别的节点不能沿用这一组的成员表。 */
    const dragged = groupDragRef.current
    groupDragRef.current = null
    /* ★ 拖完同步编组归属（契约 CE，照参考项目 `finishNodeDrag`）：
     * 拖进框 → 归入 + 吸附；拖出框 → 脱离；拖的是框 → 框内成员重算归属。 */
    const moved = dragged === null
      ? nodesRef.current.filter(n => n.selected === true).map(n => n.id)
      : [dragged.id, ...dragged.members.keys()]
    /* ⚠️ **这两条都必须跑，不许 `return`**（2026-10-26 修的真回归）。
     *
     * 我第一版写的是 `syncGroupsAfterDrag(moved); return` —— 于是只要画布上
     * **有一个组**，拖**任何**节点（包括循环框里的节点）松手后都不再贴边，
     * 循环框的尺寸停在旧值上。用户报过「不拖一下框不变」，是同一个病。
     * `tests/refit-base.mjs` 的「松手后无条件贴边」当场抓到。
     *
     * ## 顺序：先同步编组，再贴边（两次都是函数式 setNodes）
     *
     * `syncGroupsAfterDrag` 自己是 `setNodes(fn)` 形式，不会立刻改 `nodesRef.current`；
     * `refitAll(nodesRef.current)` 传的是值，读的是编辑前的数组。
     *
     * 这样对不对？**对**，因为两件事动的是**不相交的字段**：
     *   · 编组同步只改 `data.groupId`（吸附挪位置只发生在拖框那条路上）；
     *   · 贴边只改**循环框**的尺寸与体内重排（`parentId` 那条线）。
     * 组与循环是两套归属（`groupId` vs `parentId`），互不影响；
     * 两次 `setNodes` 都是函数式，按顺序作用在最新状态上，不互相覆盖。
     *
     * 我**没有**把 `refitAll` 塞进 `syncGroupsAfterDrag` 的 setNodes 回调里：
     * 那会让「贴边」这个纯计算隐式依赖编组结果，而贴边读 `edgesRef` / `sizes` / `dirRef`，
     * 塞进异步回调等于把它的输入也拖进去，以后更难查。分开两次更直白，效果一样。 */
    if (moved.length > 0 && nodesRef.current.some(n => n.type === GROUP_NODE_TYPE)) {
      syncGroupsAfterDrag(moved)
    }
    /* 容器贴紧：每次松手都重算（**只服务循环框** —— 分组框的尺寸是用户自己拉的，
     * 不能再按成员包围盒重算，否则用户拉完一下就被打回去）。
     * ⚠️ 基于 nodesRef.current —— 这条路径**不改归属**，读当前数组正是对的。 */
    refitAll(nodesRef.current)
  }, [refitAll, syncGroupsAfterDrag])

  /** 画布平移/缩放（本身无操作；关菜单的动作在下面 `onMove` 里，那里能引用到 closeMenu）。 */

  /**
   * 把一个节点**放进循环**（右键菜单用）。
   *
   * ## 为什么要有这个显式动作（归属不再靠拖动）
   *
   * 用户 2026-10-13 定规矩：「先看 n8n 与 Dify，**他们都没有的就不做**」。
   * 查证结论：两家都**不靠拖动改容器归属** ——
   *   - n8n：组成员由**连线**决定（连线时自动吸收新节点，不合法的线直接拒绝），
   *     连「单个移出」都没有，只能整组解散；
   *   - Dify：归属在**加节点那一刻**由邻居的 parentId 继承；
   *     已进容器的节点拖动时**被钳住**（`getRestrictedIterationPosition`），出不去。
   *
   * 我们原来的「拖进拖出 + 悬停 1 秒确认 + 连带移出」是**自己发明的**（两家都没有），
   * 也正是最费时间、最容易出错的那部分。按规矩删掉后，必须有一个**显式**入口 ——
   * 就是这两个菜单项（比拖动更可控：不会因为手抖而改变归属）。
   *
   * ⚠️ 坐标要转成**相对容器**（`assignToContainer` 负责），否则节点会跳位置。
   *
   * @param nodeId - 要放进去的节点。
   * @param loopId - 目标循环节点。
   */
  const putIntoLoop = useCallback((nodeId: string, loopId: string): void => {
    if (locked) { notify('画布已锁定，先解锁才能改归属', 'warn'); return }
    const node = nodesRef.current.find(n => n.id === nodeId)
    if (node === undefined) return
    if (node.parentId === loopId) return
    const loopName = containerName(nodesRef.current, loopId)
    recordHistory()
    refitAll(assignToContainer(nodesRef.current, nodeId, loopId))
    notify('已放入「' + loopName + '」', 'ok')
  }, [locked, notify, recordHistory, refitAll])

  /**
   * 把一个节点**移出循环**（右键菜单用）。
   *
   * 与「放入」对称；`assignToContainer(…, null)` 会把坐标还原成**绝对**，
   * 所以节点待在原地、只是不再属于那个框（不会跳位置）。
   *
   * ⚠️ **不连带下游**（2026-10-13 删掉了连带那套）。
   * 理由：连带是「拖动改归属」时代的补丁（那时拖中间节点会剪断链）。
   * 现在归属由**显式菜单**改，用户明确知道自己在动哪一个 ——
   * 再自动带走几个反而意外。而且 n8n 连「单个移出」都没有，我们没有参照可抄。
   *
   * @param nodeId - 要移出的节点。
   */
  const takeOutOfLoop = useCallback((nodeId: string): void => {
    if (locked) { notify('画布已锁定，先解锁才能改归属', 'warn'); return }
    const node = nodesRef.current.find(n => n.id === nodeId)
    if (node === undefined || node.parentId === undefined) return
    const ownerName = containerName(nodesRef.current, node.parentId)
    recordHistory()
    refitAll(assignToContainer(nodesRef.current, nodeId, null))
    notify('已从「' + ownerName + '」移出', 'ok')
  }, [locked, notify, recordHistory, refitAll])


  /**
   * 让位：**按当前所有「长高了」的节点把整张图重算一遍**（用户 2026-10-16 要求的功能）。
   *
   * ## 机制（2026-10-16 大改，别改回「记账本」）
   *
   * 原来是谁展开就让谁算一次、把「推了谁、推了多少」记在本子上，收起按本子退回。
   * 那套只够对付**一件事**。用户接着要求「输出内容那个弹出的时候也自动偏移一下」，
   * 于是同一时刻会有**一堆节点**各自长高：
   *
   *   - 参数区展开（节点自己长高，上限是设置里的 EDITOR_H）；
   *   - 输出面板出现（活跃态常显、终态只留一行摘要）；
   *   - 输出面板**悬停展开**（终态下鼠标移入才展开完整日志 —— 用户 m00794 原话
   *     「也让，只要展开就让」）。
   *
   * 一件事的账本管不了这么多互相叠在一起的涨落。
   *
   * 现在的机制只有一条不变量（算式在 `expand-shift.ts` 的 `settleShift`）：
   *
   *   当前位置 = 基线位置 + 让位量
   *
   * `shiftRef` 记的就是「让位量」（节点 id → 加在它**自己 y** 上的量）。
   * 每次重算：① 从当前坐标还原基线；② 在基线上把每个长高请求的正下方推开；
   * ③ 新让位量与旧让位量的**差值**加到真实节点上。
   *
   * 好处正是用户要的三条：
   *   - 面板弹出 / 悬停 / 终态收起 —— 只是请求变了，自动跟着走；
   *   - **收起不需要记账**：请求消失，节点自然回基线；
   *   - 用户自己拖过的节点**不会被打回原处**（拖动只改位置、不改让位量，
   *     于是它被算进基线）。
   *
   * ## 谁在触发（三条路，缺一条就会「有些情况不回避」）
   *
   * 1. **节点卡片报到**（`expand-ping.ts`）：它刚渲染完，此刻量高度最准；
   * 2. **输出面板自己报到**（`NodeRunPanel` 的一个 `useLayoutEffect`）：
   *    面板订阅的是 zustand 的 `run-store`、**不在 React Flow 的 data 里**，
   *    所以它出现/长高时节点卡片那一层未必重渲染 —— 只能由它自己说一声；
   * 3. **跑起来之后每秒一次的心跳**（见下面那个 effect）：终态摘要互相替换、
   *    流式日志把面板撑高，都是连续变化，靠「渲染完报一次」追不干净。
   *
   * ## 报到只说一句话，不算计划
   *
   * 「有个节点高矮可能变了，重算一遍」。**不要**在这里算具体推谁 ——
   * 那要把「扣掉面板高度」等一堆前提搬进来，而那些前提属于算法层
   * （`nominalHeight` 的第二个参数 `panels` 就是为此存在的）。
   */
  const runShift = useCallback((): void => {
    const wrap = wrapRef.current
    const sizes = measureNodes(wrap)
    shiftSizeRef.current = sizes
    /* ★ 输出面板的高度**必须单独量**（2026-10-16）：
     * 跑起来之后一堆节点同时挂面板，`nominalHeight` 的众数会变成
     * 「卡片 + 面板」，于是每个节点算出的「长高多少」都是 0 ——
     * 让位整个失效，而且**不报错、看着就是没反应**。 */
    const panels = measureRunPanels(wrap)
    /** 一个节点**素净时**有多高（众数，内部已扣掉各节点自己的面板）。 */
    const nominal = nominalHeight(sizes, panels)

    /** 所有「比素净时高」的节点，就是这次要往下推的源头。 */
    const tasks: ShiftTask[] = []
    for (const n of nodesRef.current) {
      /* 循环框不按「节点长高」处理 —— 它的尺寸归 `fitLoopBox` / `refitLoopBox`。 */
      if (n.data.def.id === LOOP_DEF_ID) continue
      const h = sizes.get(n.id)?.h
      if (h === undefined) continue
      /* ⚠️⚠️ **这里不许再减一次面板高度**（2026-10-20 修的真 BUG）。
       *
       * ## 症状（用户原话：「输出显示栏展开的时候其他节点自动避开，只是偶尔生效，
       * 多数时候没有」—— 那个「偶尔」正是本条的唯一线索）
       *
       * 只有 **参数区展开** 会推开别人；**只把输出栏展开 / 悬停**时，一个节点都不动。
       *
       * ## 根因
       *
       * `nominalHeight(sizes, panels)` 内部已经按节点各自的面板高度扣过了
       * （它的众数算的是「卡片本体的高」，见那个函数的注释）。所以 `nominal`
       * 是**扣完面板的**基准。而这里原来又减一次 `panels.get(n.id)`：
       *
       *     实测 276（卡片 168 + 面板 108）
       *     cardH = 276 − 108 = 168
       *     extra = 168 − 168 = 0        ← 不认为它长高了
       *
       * 参数区展开时卡片本体确实变高，减完还剩净值，所以那种情况「侥幸」有效 ——
       * 这就是「偶尔生效」的全部来源。
       *
       * ## 修法
       *
       * 两边用同一基准：`h` 本身就是实测总高，`nominal` 是扣完面板的素净高，
       * 所以 `extra = h − nominal`。面板与参数区两种长高都会被正确算出来
       * （面板那种：276 − 168 = 108；参数区那种：330 − 168 = 162）。
       *
       * ## 为什么 `panels` 这个变量还留着
       *
       * `nominalHeight` 需要它（那是唯一该扣的地方）。本循环不再读它。 */
      const extra = h - nominal
      if (extra <= 1) continue
      tasks.push({ id: n.id, h: nominal, extra })
    }

    /* 当前坐标里**含着上次的让位量**，`settleShift` 自己会减掉 —— 直接给当前数组。 */
    const base: V1Node[] = shiftPendingRef.current ?? nodesRef.current
    const r = settleShift(base, edgesRef.current, tasks, shiftRef.current, sizes)
    /* 记账：下一轮要用它还原基线（收起时它就是「该退回多少」）。 */
    shiftRef.current = r.shift
    const moved = r.nodes !== (base as unknown as V1Node[])
    if (!moved) {
      /* ⚠️ **没有位移也要清「节流闸门」** —— 否则一次真实位移之后就永久锁住，
       * 后面的让位再也不会发生（那比死循环更难发现：功能静默失效）。 */
      shiftSigRef.current = ''
      return
    }

    /* ── 防「更新深度超限」（React #185）────────────────────────────
     *
     * ## 症状（用户 2026-10-21 报的）
     *
     * 点「打开到画布」→ 整个工作台白屏，错误边界显示
     * `Minified React error #185`。那是「一次提交里 setState 太多次」。
     *
     * ## 环在哪（探针实测，`tests/_probe-loop185.mjs`）
     *
     *   `useLayoutEffect` ping → `runShift` → `setNodes` → 重渲染 → ping → …
     *
     * `settleShift` 在**输入完全相同**时是幂等的（返回原数组，环会自己停）。
     * 但真机上量到的高度**每帧都在微调**（文字换行、滚动条出现、面板动画）——
     * 实测把「高度抖动 ±1px」喂 20 轮，**20 轮全都返回新数组** → 环闭合。
     *
     * jsdom 里量不到高度（`getBoundingClientRect` 恒 0），所以 70 个测试全绿、
     * 真机才炸 —— 这也是它必须靠「闸门」而不是靠「幂等」来兜的原因。
     *
     * ## 闸门怎么设
     *
     * 把「这轮的输入」压成一个签名：每个请求的 `id + 取整后的 extra`。
     * 签名与上一轮**相同**就判定「抖了一下、不值得再动一次」，直接跳过。
     *
     * ⚠️ `extra` **四舍五入到 1px**：小于 1px 的长高肉眼不可见，
     * 为它挪一次节点只会让画面抖。这是用户能接受的最小粒度。
     * ⚠️ 签名**不含坐标** —— 坐标是我们自己改的，含进来就永远不相等了。
     */
    const sig = tasks.map(t => t.id + ':' + String(Math.round(t.extra))).join('|')
    if (sig !== '' && sig === shiftSigRef.current) return
    shiftSigRef.current = sig

    /* 被推的里面有循环成员 → 框要按内容重算尺寸（用户 2026-10-16 的第二条：
     * 「如果是循环内的节点，循环内外节点都挪，且循环框也跟着变大」）。
     * 幂等：没变化的框返回原引用，所以对没被涉及的循环框是空操作。 */
    let working: V1Node[] = r.nodes
    for (const n of working) {
      if (n.data.def.id !== LOOP_DEF_ID) continue
      working = refitLoopBox(working, n.id, sizes, { w: NODE_W, h: NODE_H }) as V1Node[]
      /* ⚠️ 循环框的让位量**不留账**：它接下去会被 `fitLoopBox` / `refitLoopBox`
       * 改位置与尺寸，而那两个函数认的是「框现在在哪」，不是「框本该在哪」。
       * 留着旧账会在下一轮还原基线时把框**拽回去**，越跑越歪。 */
      r.shift.delete(n.id)
    }
    shiftPendingRef.current = working
    setNodes(working)
  }, [setNodes])

  /**
   * 报到：某个节点（或它里面的输出面板）刚渲染完，**此刻量高度最准**。
   *
   * 用模块级订阅（而不是把回调塞进节点 data）的原因：
   * 节点侧只要一行函数调用，不必为一件事多穿一个回调进 data
   * （那个 data 每渲染一次都要比一遍，多一个字段就多一处要同步）。
   * 具体见 `expand-ping.ts` 的文件头。
   *
   * ⚠️ 这个 effect **必须排在 `runShift` 之后** —— 排在它前面会命中
   * 「用在定义之前」（依赖数组在渲染期求值），整个画布白屏。`check:tdz` 专抓这个。
   */
  useEffect(() => {
    setExpandShiftListener(() => { runShift() })
    return () => { setExpandShiftListener(null) }
  }, [runShift])

  /**
   * **把已有的浏览器偏好推一份到宿主半**（2026-10-20，用户报「从列表启动找不到浏览器」）。
   *
   * ## 为什么需要这一次「补推」
   *
   * 偏好原来只存 `localStorage`。加 `saveBrowserPrefs` 之后，**以后再改**才会写文件；
   * 而用户**早就配好了端口**（不然从画布也跑不起来）—— 那份配置只在浏览器里。
   *
   * 所以不补推的话：新代码上线后，从列表启动**照样**报「没填端口」，
   * 用户会以为「修了但没用」。
   *
   * ## 为什么是「先读、仅在文件里缺东西时写」
   *
   * 直接覆盖会**用旧缓存盖掉**别处刚写的新值（比如另一台标签页刚改过）。
   * 判据：宿主半那份为空 / 端口为空，而本地有 —— 才推。
   *
   * ⚠️ 一次性（挂载跑一次），不跟着 `browserPrefs` 变 —— 那由 `changeBrowserPrefs` 负责。
   */
  useEffect(() => {
    void (async () => {
      const got = await loadBrowserPrefs()
      if (!got.ok) return
      const remote = got.prefs as BrowserPrefs | undefined
      const local = browserPrefsRef.current
      const remoteHasPort = remote !== undefined
        && (remote.defaultPort !== '' || Object.values(remote.tags ?? {}).some(t => (t?.port ?? '') !== ''))
      const localHasPort = local.defaultPort !== ''
        || Object.values(local.tags ?? {}).some(t => (t?.port ?? '') !== '')
      /* 只在「本地有、宿主半没有」时补推。 */
      if (localHasPort && !remoteHasPort) {
        const r = await saveBrowserPrefs(local)
        if (!r.ok) console.warn('[浏览器偏好] 补推失败：' + String(r.error ?? ''))
      }
    })()
    /* 空依赖：只在挂载时跑一次（理由见上）。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 跑的时候的**让位心跳**：每秒重算一次。
   *
   * 为什么事件不够（三条都要它兜）：① 终态「一行摘要」之间互相替换，换行 /
   * 行数徽标会让高度跳；② 流式日志把面板撑高（面板自己有 max-height，撑到顶之前
   * 高度一直在动）；③ 一批节点同时跑完、摘要批量替换。
   * 这些都是「没长东西 → 长东西」的中间态，靠 `pingExpandShift` 那种
   * 「渲染完报一次」追不干净（面板内部重渲染不一定路过节点卡片那一层）。
   *
   * 代价可以接受：重算只读几个 `getBoundingClientRect` + 纯数组运算，
   * **没有位移时一次 `setNodes` 都不发**（`settleShift` 返回原数组引用）。
   *
   * 只在 `running` 期间跑：跑完了还每秒重算没有意义，而且终态之后
   * 用户会自己拖节点 —— 那时的布局是他的，不该被我们动。
   */
  useEffect(() => {
    if (!running) return
    /* 1000ms：人眼看「让开」与「跑」是同一拍就够了，不必每帧量 DOM。 */
    const t = window.setInterval(() => { runShift() }, 1000)
    return () => { window.clearInterval(t) }
  }, [running, runShift])


  /** 点节点：展开/收起它的内联设置（编辑方式已固化为节点内展开）。
   *
   * 关键修正（2026-10-08）：**点节点内部的表单区不触发折叠**。
   * 原来「点同一个节点＝切换展开/收起」——用户在参数输入框里点一下，
   * React Flow 仍会派发 nodeClick，导致节点当场缩起来、参数没法填。
   * 现在先判断事件目标是否在编辑区（[data-ewb-editor]）或按钮里，是就只保持选中、不动展开态。
   *
   * 第二处修正（2026-10-11，用户原话）：
   *   「按住 ctrl 的点击节点也会展开，ctrl 应该是多选模式，
   *     按住 ctrl 不应该展开节点，应该是只能选择或者拖动节点。」
   *
   * 判断依据用**事件的 `ctrlKey` / `metaKey`**，不看 React Flow 内部的多选态：
   *   - 用户实际按下的就是 Ctrl（macOS 是 Cmd），这是最直接的信号；
   *   - React Flow 的多选态只在按住期间有效，松开后再看已经晚了。
   * 两者一致时行为一致，不一致时以「用户此刻按着什么」为准，更符合直觉。
   *
   * ⚠️ 多选时**什么都不做**（不展开、也不收起）——正在框选一批节点时，
   * 任何一个节点的展开/收起都是干扰（节点高度一变，框选的落点也跟着偏）。
   */
  const onNodeClick = useCallback((e: unknown, n: V1Node): void => {
    const ev = e as { target?: HTMLElement, ctrlKey?: boolean, metaKey?: boolean } | undefined
    /* Ctrl / Cmd 按下 = 多选模式：只选中，不动展开态。 */
    if (ev?.ctrlKey === true || ev?.metaKey === true) {
      setSelected(n.id)
      return
    }
    setSelected(n.id)
    // 事件来自节点内部的可交互区（表单 / 按钮）→ 不折叠
    const target = ev?.target
    if (target !== undefined && target.closest('[data-ewb-editor], .nodrag, button, input, select, textarea, label') !== null) {
      setExpandedNode(n.id)
      return
    }
    /* ⚠️ 这里**不直接调 runShift**：此刻 DOM 还是旧高度，量出来的不对。
     * 让位由节点卡片自己的 `useLayoutEffect` 在「DOM 已更新、还没画这一帧」时报到
     * （见 `expand-ping.ts`）—— 展开与收起都会报到，所以这一处不必管。 */
    const opening = expandedNode !== n.id
    setExpandedNode(opening ? n.id : null)
  }, [expandedNode])

  /** 点空白 → 关浮卡。 */
  /** 点空白：关浮卡 + 收起 inline 展开（用户要求「点画布收起」）。
   * 注意：点节点内部的表单不会走到这里（React Flow 会先派发 nodeClick）。 */
  const onPaneClick = useCallback((): void => {
    setSelected(null)
    /* 点空白 = 收起。收起后让位**自动退回**（见 runShift：收起只是那些请求消失）。
     * 同样不必在这里调它 —— 节点的 layout effect 会报到。 */
    setExpandedNode(null)
    setNodes(ns => ns.map(n => (n.selected === true || n.data.expanded === true) ? { ...n, selected: false, data: { ...n.data, expanded: false } } : n))
  }, [setNodes])


  /** 改指定节点的参数（浮卡与 inline 共用）。
   *
   * 修正（2026-10-08）：**参数写到节点实例**（data.params），不写共享的 def.params。
   * 原来改 def.params 会让同类型的所有节点一起变（def 是节点类型定义的共享引用）。 */
  const onParamFor = useCallback((id: string, key: string, value: unknown): void => {
    /* 改参数要能撤销。先记「改之前」，再去改。 */
    recordHistory()
    /* ⚠️ 改完参数**立刻同步第二层** —— 因为改的可能就是「标签」（`session`），
     * 换了标签就该按新标签重新解析用哪个浏览器（否则节点会继续用旧标签的配置）。 */
    setNodes(ns => syncBrowserLayer(ns.map(n => {
      if (n.id !== id) return n
      const cur = n.data.params ?? n.data.def.params ?? {}
      return { ...n, data: { ...n.data, params: { ...cur, [key]: value } } }
    })))
  }, [setNodes, recordHistory, syncBrowserLayer])

  /* 把稳定引用接到真实实现上（渲染期赋值 —— 与上面几个 ref 同一条纪律）。
   * 浏览器一节里的「标签」走这里：它其实就是在改 `session` 参数。 */
  onParamRef.current = onParamFor
  prefsSetterRef.current = changeBrowserPrefs

  /** 改指定节点的失败策略（写实例级，理由同上）。 */
  const onOnErrorFor = useCallback((id: string, v: OnError): void => {
    /* 改失败策略同样要能撤销。 */
    recordHistory()
    setNodes(ns => ns.map(n => n.id !== id ? n : { ...n, data: { ...n.data, onError: v } }))
  }, [setNodes, recordHistory])

  /**
   * 切换选中节点的「跳过」状态（用户点名的 P3 项）。
   *
   * 一次作用于所有选中节点：**若其中有未跳过的，就全部设为跳过；否则全部恢复**。
   * 这样「一键全跳 / 一键全恢复」都只需要点一下。
   */
  const toggleSkipSelected = useCallback((): void => {
    if (locked) { notify('画布已锁定，先解锁才能改跳过状态', 'warn'); return }
    const targets = nodesRef.current.filter(n => n.selected === true)
    if (targets.length === 0) return
    const on = nextSkipValue(targets.map(n => n.data.skipped === true))
    recordHistory()
    const ids = new Set(targets.map(n => n.id))
    setNodes(ns => ns.map(n => ids.has(n.id) ? { ...n, data: { ...n.data, skipped: on } } : n))
    notify(on ? '已跳过 ' + String(targets.length) + ' 个节点' : '已恢复 ' + String(targets.length) + ' 个节点', 'ok')
  }, [locked, notify, recordHistory, setNodes])

  /**
   * 右键点一条连线 → 直接删掉它（用户点名的 P3 项）。
   *
   * 为什么值得做：此前删连线只能「先选中再按退格」，而连线很细、不好点中；
   * 右键是更符合直觉的方式。删除也记一次历史，可按 Ctrl+Z 恢复。
   *
   * @param e - 鼠标事件（要拦掉浏览器默认右键菜单）。
   * @param edge - 被右键的连线。
   */
  const onEdgeContextMenu = useCallback((e: React.MouseEvent, edge: Edge): void => {
    e.preventDefault()
    if (locked) { notify('画布已锁定，先解锁才能改连线', 'warn'); return }
    recordHistory()
    setEdges(es => es.filter(x => x.id !== edge.id))
    notify('已删除这条连线（Ctrl+Z 可恢复）', 'ok')
  }, [setEdges, recordHistory, notify, locked])

  /** 删除选中的节点（连同它们的连线）。
   *
   * 修正（2026-10-08）：原来只看 `selected`（单个），**多选时只删一个**。
   * 现在收集所有 `n.selected === true` 的节点一起删。 */
  const deleteSelected = useCallback((): number => {
    if (locked) { notify('画布已锁定，先解锁才能删除', 'warn'); return 0 }
    const doomed = new Set<string>()
    for (const n of nodesRef.current) {
      if (n.selected === true) doomed.add(n.id)
    }
    if (doomed.size === 0 && selected !== null) doomed.add(selected)
    /* 没东西可删就**不要记历史**——否则撤销栈里会多出一格「什么都没变」，
     * 用户按一次 Ctrl+Z 看不出变化。 */
    if (doomed.size === 0) return 0
    recordHistory()
    /* 被删的节点可能正是让位的记账对象 → 记账本失效，清掉（见 clearShift）。 */
    clearShift()
    setNodes(ns => ns.filter(n => !doomed.has(n.id)))
    setEdges(es => es.filter(e => !doomed.has(e.source) && !doomed.has(e.target)))
    /* 删掉的节点可能是**分组框本身** → 它的成员必须同时脱离（清 `groupId`），
     * 否则存档里会留下「指向一个不存在的框」的幽灵归属，
     * 读回来时 `fromWorkflowDoc` 会把它当脏值清掉，但这一趟保存出去是脏的。 */
    setNodes(ns => ns.filter(n => !doomed.has(n.id)).map(n => {
      const gid = n.data.groupId
      if (typeof gid !== 'string' || !doomed.has(gid)) return n
      const data: Record<string, unknown> = { ...n.data }
      delete data.groupId
      return { ...n, data: data as V1NodeData }
    }))
    setSelected(null)
    setExpandedNode(null)
    return doomed.size
  }, [selected, setNodes, setEdges, recordHistory, locked, notify, clearShift])

  /** 删除**指定**的一个节点（节点工具条上那个删除按钮走这里）。

   * ## 为什么要单开一个（用户 m03500）
   *
   * 用户原话：「删除节点按钮我现在在节点中看不到，**放在节点外面**吧」。
   * 工具条上的按钮只作用于**它自己那个节点**，语义与「删除选中的一批」不同：
   * 后者依赖 `selected` 状态，而工具条出现时那个节点未必是唯一选中的。
   * 所以这里**只按 id 删**，不动别人的选中态。
   *
   * @param id - 要删除的节点 id。
   * @returns 删掉的节点数（0 表示没删，调用方据此决定要不要提示）。
   */
  const deleteOne = useCallback((id: string): number => {
    if (locked) { notify('画布已锁定，先解锁才能删除', 'warn'); return 0 }
    if (!nodesRef.current.some(n => n.id === id)) return 0
    recordHistory()
    /* 同 deleteSelected：记账本可能记着这个节点，删了它就失效。 */
    clearShift()
    setNodes(ns => ns.filter(n => n.id !== id).map(n => {
      const gid = n.data.groupId
      if (typeof gid !== 'string' || gid !== id) return n
      const data: Record<string, unknown> = { ...n.data }
      delete data.groupId
      return { ...n, data: data as V1NodeData }
    }))
    setEdges(es => es.filter(e => e.source !== id && e.target !== id))
    /* 只在删的正是「当前展开/选中」那个时才清 —— 不然会顺手把别的节点收起来。 */
    setSelected(cur => (cur === id ? null : cur))
    setExpandedNode(cur => (cur === id ? null : cur))
    return 1
  }, [setNodes, setEdges, recordHistory, locked, notify, clearShift])

  /**
   * 复制选中的节点（连同它们之间的连线）。
   * @returns 复制的节点数。
   */
  const copySelected = useCallback((): number => {
    const picked = nodesRef.current.filter(n => n.selected === true)
    if (picked.length === 0) return 0
    const ids = new Set(picked.map(n => n.id))
    clipboard.current = {
      nodes: picked.map(n => ({ ...n, data: { ...n.data }, selected: false })),
      // 只复制两端都在选中集内的连线（避免粘出悬空边）
      edges: edgesRef.current.filter(e => ids.has(e.source) && ids.has(e.target)),
    }
    return picked.length
  }, [])

  /**
   * 粘贴：把剪贴板里的节点整体偏移后加入画布，并选中新节点。
   * @returns 粘贴的节点数。
   */
  const pasteClipboard = useCallback((): number => {
    if (locked) { notify('画布已锁定，先解锁才能粘贴', 'warn'); return 0 }
    const clip = clipboard.current
    if (clip === null) return 0
    const OFFSET = 32
    /** 旧 id → 新 id 的映射（连线要跟着换）。 */
    const idMap = new Map<string, string>()
    const newNodes: V1Node[] = clip.nodes.map(n => {
      idRef.current += 1
      const id = 'n-' + String(idRef.current)
      idMap.set(n.id, id)
      return {
        ...n,
        id,
        position: { x: n.position.x + OFFSET, y: n.position.y + OFFSET },
        selected: true,
        // 参数/失败策略**深拷一份实例**，避免新节点与源节点共享对象
        data: { ...n.data, params: { ...(n.data.params ?? {}) }, state: 'idle' as NodeState, progress: undefined },
      }
    })
    const newEdges: Edge[] = clip.edges.map((e, i) => ({
      ...e,
      id: 'e-copy-' + String(Date.now()) + '-' + String(i),
      source: idMap.get(e.source) ?? e.source,
      target: idMap.get(e.target) ?? e.target,
    }))
    /* 同上（`:1696` 那条的注释）：显式标类型，否则推断出的元素类型比 `V1Node` 更窄。 */
    setNodes(ns => {
      const cleared: V1Node[] = ns.map(n => ({ ...n, selected: false }))
      return cleared.concat(newNodes)
    })
    setEdges(es => es.concat(newEdges))
    if (newNodes.length > 0) setSelected(newNodes[newNodes.length - 1].id)
    return newNodes.length
  }, [setNodes, setEdges])

  /** 当前画布快照（撤销/重做用）。 */
  const snapshot = useCallback((): Snapshot => ({ nodes: nodesRef.current, edges: edgesRef.current }), [])

  /** 撤销一步。 */
  const doUndo = useCallback((): void => {
    const snap = useHistoryStore.getState().undo(snapshot())
    if (snap === null) return
    /* 撤销会把坐标整批换回去 → 让位记账本失效，清掉（见 clearShift）。 */
    clearShift()
    setNodes(restoreSnapshot(snap, nodesRef.current))
    setEdges(snap.edges)
    setSelected(null)
    setExpandedNode(null)
  }, [setNodes, setEdges, snapshot, clearShift])

  /** 重做一步。 */
  const doRedo = useCallback((): void => {
    const snap = useHistoryStore.getState().redo(snapshot())
    if (snap === null) return
    clearShift()
    setNodes(restoreSnapshot(snap, nodesRef.current))
    setEdges(snap.edges)
    setSelected(null)
    setExpandedNode(null)
  }, [setNodes, setEdges, snapshot, clearShift])

  /** 撤销/重做的可用性（供按钮禁用）。 */
  const [histDepth, setHistDepth] = useState({ past: 0, future: 0 })
  useEffect(() => {
    const sync = (): void => { setHistDepth(useHistoryStore.getState().depth()) }
    sync()
    return useHistoryStore.subscribe(sync)
  }, [nodes, edges])

  /* ── 右键菜单的**状态与两个共用回调** ────────────────────────────
   *
   * ⚠️ **位置是硬约束：必须在下面那段键盘处理之前。**
   * 键盘处理要把 `selectAll`（Ctrl+A）与 `closeMenu`（Esc 关菜单）放进依赖数组，
   * 而依赖数组在**渲染期求值** —— 放在后面就会报
   * `Block-scoped variable used before its declaration`（暂时性死区），
   * 症状是**打开画布整体白屏**。这个坑本项目踩过五次，`check:tdz` 会拦住。
   *
   * 菜单**内容**的装配在下面（要引用一堆运行/编辑回调，那些还没定义）。
   */
  const [menu, setMenu] = useState<MenuState | null>(null)

  /** 关菜单（点项、点外面、按 Esc、画布动、窗口变尺寸都会调到它）。 */
  const closeMenu = useCallback((): void => { setMenu(null) }, [])

  /** 画布平移/缩放时关掉右键菜单。
   *
   * 为什么必须：菜单用的是 `position: fixed`（屏幕坐标），
   * 画布一动它就**留在原地、与它所指的对象对不上了** ——
   * 那种「菜单飘在空处」的状态比菜单消失更让人困惑。 */
  /**
   * 当前缩放百分比（票 56：右下角那排要显示它）。
   *
   * 执行画布原来没有这个 state —— 缩放只靠快捷键与 React Flow 自带的 `<Controls>`，
   * 界面从不显示「现在几成」。两边共用同一个右下角组件之后要有，
   * 所以由 `<ReactFlow onMove>` 同步（那个回调本来就挂着，只是原来只关右键菜单）。
   *
   * ⚠️ 存**整数百分比**而不是 1 那种小数：显示与滑杆都用整数，存小数要到处取整。
   */
  const [zoomPct, setZoomPct] = useState(100)

  /* ⚠️ 参数类型用 React Flow 自己的 `OnMove`（`(event, viewport) => void`）——
   * 手写一个 `{ zoom }` 的形状对不上它的签名。第二个参数才是视口变换。 */
  const onMove = useCallback((_e: unknown, vp?: { zoom?: number }): void => {
    closeMenu()
    /* `onMove` 的第二个参数是 `{ x, y, zoom }`（视口变换）。
     * 拿不到就保持原值 —— 不为一个可选的显示数字去猜。 */
    if (typeof vp?.zoom === 'number' && Number.isFinite(vp.zoom)) {
      setZoomPct(Math.round(vp.zoom * 100))
    }
  }, [closeMenu])

  /**
   * 全选画布上的节点（调研记着这个缺，快捷键 Ctrl+A）。
   *
   * 只选**顶层节点**：分组框里面的子节点不单独选——它们跟着框走，
   * 单独选中会让「选中数」虚高、也不好操作。
   *
   * ⚠️ **不弹提示**（用户 2026-10-11：「全选不用弹提醒」）——
   * 选中结果就画在屏幕上（每个节点都亮起选中描边），再弹一条是噪音。
   * 这条判断也适用于别处：**只在「结果看不见」时才需要提示**。
   */
  const selectAll = useCallback((): void => {
    setNodes(ns => ns.map(n => ({ ...n, selected: n.parentId === undefined })))
  }, [setNodes])

  /* 键盘快捷键：Ctrl/Cmd+C 复制选中、Ctrl/Cmd+V 粘贴、Ctrl/Cmd+D 原地复制。
   *
   * ⚠️ 注意位置：**必须定义在 copySelected / pasteClipboard 之后**。
   * 2026-10-08 曾把这段放在它们之前，依赖数组里引用未初始化的 const
   * → 报 `Cannot access 'copySelected' before initialization`（暂时性死区）
   * → **整个插件崩溃**。函数组件渲染时就执行到依赖数组求值，所以顺序是硬约束。
   *
   * 只在焦点不在输入框里时生效（否则会抢用户在参数里打字的快捷键）。
   * 另外**画布被藏起来时完全不接管**：常驻挂载后画布一直在，不拦住的话
   * 用户在「列表页」按 Ctrl+Z 会把看不见的画布改掉（还不进撤销栈的可见反馈）。 */
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      const typing = t !== null && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      if (typing) return
      const mod = e.ctrlKey || e.metaKey
      /* 不带 Ctrl 的键：只处理 Delete / Backspace / Esc。
       * 删除原先走 React Flow 内置键，**绕过 deleteSelected 所以不进撤销栈**——
       * 键盘删了节点按 Ctrl+Z 回不来。这里接管它。 */
      if (!mod) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (deleteSelected() > 0) e.preventDefault()
        } else if (e.key === 'Escape') {
          /* Esc 要**同时**关掉右键菜单与抽屉。
           * 菜单另开了一个全局 pointerdown 监听，但它管不到键盘——
           * 不在这里关的话，按 Esc 菜单会留在屏幕上（用户以为卡住了）。 */
          closeMenu()
          setSelected(null)
          /* 收起后由节点的 layout effect 报到，见 onNodeClick 的说明。 */
          setExpandedNode(null)
          setDrawerOpen(false)
        }
        return
      }
      if (e.key === 'c') {
        const n = copySelected()
        if (n > 0) { e.preventDefault() }
      } else if (e.key === 'v') {
        const n = pasteClipboard()
        if (n > 0) { e.preventDefault() }
      } else if (e.key === 'a') {
        /* 全选（调研记着这条缺）。浏览器默认的 Ctrl+A 会选中整个页面的文字，
         * 在画布上那不是用户要的，所以拦掉。 */
        e.preventDefault()
        selectAll()
      } else if (e.key === 'g') {
        /* 编组 / 解散编组（用户 2026-10-11：「编组和解散编组添加快捷键，ctrl+g」）。
         * 一个键两用，按「选中了什么」决定——见 `toggleGroupShortcut`。 */
        e.preventDefault()
        toggleGroupShortcut()
      } else if (e.key === 'd') {
        if (copySelected() > 0) { e.preventDefault(); pasteClipboard() }
      } else if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault(); doUndo()
      } else if (e.key === 'y' || (e.key === 'z' && e.shiftKey)) {
        e.preventDefault(); doRedo()
      } else if (e.key === '=' || e.key === '+') {
        /* 缩放快捷键（用户点名的 P3 项）：Ctrl+= 放大、Ctrl+- 缩小、Ctrl+0 回 100%。
         * 用 = 与 + 都接受，因为多数键盘的 + 需要按 Shift，用户不会特意按 Shift。 */
        e.preventDefault()
        flowToScreenApi.current?.zoomIn?.({ duration: 150 })
      } else if (e.key === '-') {
        e.preventDefault()
        flowToScreenApi.current?.zoomOut?.({ duration: 150 })
      } else if (e.key === '0') {
        e.preventDefault()
        flowToScreenApi.current?.zoomTo?.(1, { duration: 150 })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [active, copySelected, pasteClipboard, doUndo, doRedo, deleteSelected, selectAll, closeMenu, toggleGroupShortcut, expandedNode])

  /** 手动触发自动布局。
   *
   * @param d - 用哪个方向排。不传则用当前方向（点「自动布局」本体时）。
   *
   * 用户 2026-10-11 要求：两个方向各是一个可单独的图标，
   * **点哪个就按哪个方向排**，不用先切方向再点布局。
   * 之前只有 `dir` 状态、`setDir` 从没被调用过——
   * 也就是说「画布方向切换」从来就没出现在界面上（计划里标着 ✅，实际是空的）。
   */
  const runLayout = useCallback((d?: LayoutDirection): void => {
    const useDir = d ?? dir
    /* 点了某个方向按钮就把偏好记下来，下次进来默认用它。 */
    if (d !== undefined && d !== dir) {
      setDir(d)
      try { localStorage.setItem('ewb.dir', d) } catch { /* 忽略 */ }
    }
    void (async () => {
      const pos = await elkLayout(nodes, shownEdges, measureNodes(wrapRef.current), useDir, nodeWRef.current, spacingRef.current ?? undefined)
      /* ⚠️ 重排后**必须让分组框跟着重贴**：ELK 只管按连线排位置，
       * 不知道谁是分组框的子节点（父子关系不是连线），
       * 不重贴的话框会留在旧位置、与子节点脱节。
       * 顺带说明：分组框**本身也是 ELK 的一个节点**（它没有端口，所以不参与分层约束），
       * 它的最终位置由这次重贴决定，ELK 给它的坐标会被覆盖。
       *
       * ⚠️ **容器成员不在 `pos` 里**（2026-10-15 修的真 BUG）：
       * ELK 给的是绝对坐标，而成员的 `position` 存的是**相对容器**的 ——
       * 直接写进去，成员会被平移一个容器原点、飞到框外（用户报的
       * 「自动排序时循环被当普通节点，内容不在循环里」）。
       * 现在 `elkLayout` 只收顶层节点；成员的排列与框的尺寸交给下面的
       * `refitAll`（它做 `relayoutInside` + `fitLoopBox`），
       * **必须先排顶层、再 refit**，否则框里还是旧坐标。 */
      const moved = nodes.map(n => pos[n.id] === undefined ? n : { ...n, position: pos[n.id] })
      /* 与上面挂载那条同一个写法：先 refit（算容器内部），再写回。 */
      refitAll(moved)
      window.setTimeout(() => { flowToScreenApi.current?.fitView({ padding: 0.22 }) }, 60)
    })()
  }, [nodes, shownEdges, refitAll, dir])

  /** 改一个节点的状态与进度文字（贴到节点上的颜色与文字）。 */
  const markNode = useCallback((id: string, state: NodeState, progress: string): void => {
    setNodes(ns => ns.map(n => n.id !== id ? n : { ...n, data: { ...n.data, state, progress } }))
  }, [setNodes])

  /** 停止运行：取消在跑的派发 + **把还在跑/排队的节点复位为 idle**。
   *
   * 修正（2026-10-08）：原来只清定时器，停止后节点仍显示「运行中」，状态与事实不符。
   * 接引擎后是真的取消：取消信号发到宿主半，子进程被终止。 */
  const stopRun = useCallback((): void => {
    runAbort.current?.abort()
    runAbort.current = null
    setRunning(false)
    setNodes(ns => ns.map(n => {
      const s = n.data.state
      if (s !== 'running' && s !== 'queued') return n
      return { ...n, data: { ...n.data, state: 'idle' as NodeState, progress: '已停止' } }
    }))
  }, [setNodes])

  /**
   * 跑一串节点（**真派发**：命令发给宿主半，由它起进程或调函数）。
   *
   * ## 2026-10-11：合并成**只此一份跑法**
   *
   * 这里原来是**一整套自己的调度实现**（算拓扑序、带上游、跳过语义、失败策略、
   * 中断检查——四件事和界面状态缠在一起）。宿主半那边为了「不开画布也能跑」
   * 另写了一份，于是**同一套跑法有两份**，改一处忘另一处就是「画布上跑得好好的、
   * 后台跑就不对」这类极难查的问题。
   *
   * 现在改成：**跑法全部交给 `runGraph`**，这里只做两件事——
   *   ① 把画布状态翻译成调度器要的输入（节点规格、连线、目标、环境）
   *   ② 把调度器发来的事件**画到界面上**（节点颜色、日志面板、进度条）
   *
   * 这不是「为了整齐而重构」：合并后**行为差异无处藏身**。
   * 合并当时就查出两处真实差异（见下面 `includeUpstream` 那段的注释）。
   *
   * 单步 / 跳过 / 重跑这些入口**不需要独立跑法** —— 它们只是「换一组 targets」，
   * 调度器本来就支持（`targets` + `includeUpstream`）。
   *
   * @param targets - 点名要跑的节点 id 列表。
   * @param wholeGraph - 是否整图跑（true 时不看 targets，直接跑全图）。
   * @param includeUpstream - 点名跑时是否带上上游（默认带；「只跑这个」传 false）。
   */
  const runSeq = useCallback((targets: readonly string[], wholeGraph: boolean, includeUpstream = true): void => {
    stopRun()
    const ac = new AbortController()
    runAbort.current = ac
    setRunning(true)
    /** 这次的开始时刻（上报运行历史要用，见下面那段）。 */
    const startedAt = Date.now()
    const store = useRunStore.getState()
    store.clearAll()

    /* 光标一：把画布节点翻译成调度器规格。
     *
     * ⚠️ **2026-10-15 改：翻译挪进 `toRunSpecsFromCanvas`（`workflow/specs.ts`）**。
     *
     * 原先在这里就地写了一遍 `map`，与宿主半的 `toRunSpecs` 是**两份独立的翻译** ——
     * 于是漂了：这份漏了 `parentId` 与 `sourceHandle`。
     * 前者让「画布里按▶」一进循环就把 `{{item.url}}` 原样发给浏览器
     * （用户 2026-10-15 报的 `Cannot navigate to invalid URL`），
     * 后者让**没走的分支照跑**。而「列表里点▶跑」那条路一直是好的，
     * 所以现象看着像「同一个工作流换个入口就不对」。
     *
     * 现在两份合成一份：翻译规则只有一处，漏字段在类型上就过不去。 */
    const specs = toRunSpecsFromCanvas(nodesRef.current, edgesRef.current)

    /* 光标二：把事件画到界面上。 */
    const onEvent = (e: RunEvent): void => {
      const rs = useRunStore.getState()
      switch (e.kind) {
        case 'queued':
          markNode(e.nodeId, 'queued', '排队中')
          return
        case 'started':
          markNode(e.nodeId, 'running', '运行中')
          return
        /* ★ 模型吐字（票 28，2026-10-27）：把这一片**追加**到那个节点的 `run-stream` 上。
         *
         * ## 这一步只把接收端准备好，传输还没接
         *
         * 画布那条路现在（`POST /run` + `JSON.stringify`）**根本收不到**这个帧 ——
         * `__onStream` 是个函数，JSON 序列化时被静静丢掉（`run.ts:1517-1521` 那段注释写着）。
         * 所以加完这一支之后，**画布上仍然不会吐字**：不是这里的问题，是上面没数据来。
         *
         * 传输那头要单独做（票 28 判定的「丙」：宿主半另开一条订阅 SSE）。
         * 先加这是有独立价值的：**不论最后走哪条传输，这一支都必须有** ——
         * 没有它，回调真的送到了也是从 switch 掉出去、界面一动不动，
         * 那种「送到了但界面不动」比现在难查得多。
         *
         * ## 为什么是 `appendStream` 而不是别处
         *
         * 节点卡片读的是 `run-store` 的 `byNode[nodeId].stream`
         * （`NodeRunPanel.tsx:87` 的 `useNodeRun`），而**画布这条路从来没人往里写**。
         * 列表页那条（`FlowRunPanel.tsx:203`）调的就是同一个函数 ——
         * 两处写进同一份数据、渲染用同一套组件，长相天然一致。
         *
         * ⚠️ `text` 是**这一片新增的字**，不是累计全文（引擎侧 `run.ts:1523` 钉着）。
         * 传累计的话每个字会重复 N 遍。 */
        case 'stream':
          rs.appendStream(e.nodeId, e.text)
          return
        case 'log':
          rs.pushLine(e.nodeId, e.line)
          /* ★ **轮次进度贴到循环框头上**（2026-10-17 加，计划 Step 1.5）。
           *
           * 循环框头本来就有一个 `.loopProgress` 位置（`data.progress`），
           * 但在此之前它只显示「运行中」这种**状态词** —— 用户看不到跑到第几轮，
           * 只能点开节点看日志。执行层每轮都发一条 `第 N/M 轮` 的日志，
           * 这里把它顺手提到框头上（同一份事实，不多算一次）。
           *
           * ⚠️ 判据用**整行相等**而不是 `includes('轮')`：
           * 日志里别的句子也可能带「轮」字（如「共 3 轮」），
           * 用 includes 会把它们也当成进度。 */
          {
            const m = /^第 (\d+)\/(\d+) 轮$/.exec(e.line)
            if (m !== null) markNode(e.nodeId, 'running', e.line)
          }
          return
        case 'success':
          markNode(e.nodeId, 'success', '完成')
          rs.setProgress(e.nodeId, 1, 1)
          return
        case 'skipped':
          markNode(e.nodeId, 'success', '已跳过')
          return
        case 'failed':
          /* 状态文字取失败原因的前 40 字（节点上放不下更多）。 */
          markNode(e.nodeId, 'failed', e.error.slice(0, 40))
          return
        case 'aborted':
          /* 中断事件本身不用改颜色（那个节点已经是 failed 了），
           * 但**必须有**：上面的循环靠它知道「为什么后面的没跑」。
           *
           * ⚠️ 那些「后面没跑的」节点这里**不处理** —— 引擎会为它们各发一条
           * `cancelled`（见下面那条）；万一事件没到，跑完后还有一道兜底扫描
           * （`r.aborted === true` 那一段）。两处分工：
           *   · `cancelled` 事件到了 → **立刻**画对，中途就能看见；
           *   · 兜底扫描 → 跑完再核一遍，不留悬挂的「排队中」。 */
          return
        /* ── 中断后没跑过的节点（2026-10-23 契约 AC）──────────────────
         *
         * ## 用户看到的那一幕
         *
         * 原话：「报错了，但是后续还在执行。」—— 实际没继续执行。
         * 一开跑就把每个节点标成「排队中」，某个节点失败中断后没人撤掉那些排队，
         * 于是画布上看着像还在跑。
         *
         * ## 为什么是 `cancelled` 而不是 `idle`
         *
         * `idle` = 「还没跑过」，`cancelled` = 「因为前面中断所以没跑」——
         * 两者事实不同（`workflow/model.ts` 里 `cancelled` 那条注释就在讲这个）。
         * 状态文字写 **「未执行」**，不是「已停止」：后者听起来像用户主动停的。
         *
         * ## 引擎侧的前提（2026-10-23 晚已核实）
         *
         * `RunEvent` 联合类型里有 `{ kind: 'cancelled' }`（`workflow/run.ts:290`），
         * 且 `runGraph` 收尾时对「发过 queued 但没进 ran / started / settled」的
         * 节点逐个 emit（同文件 `:2479`）。它对 `skipped` 也做了保护 ——
         * 「按配置跳过」的不会被改写成「因为中断没跑」。 */
        case 'cancelled':
          markNode(e.nodeId, 'cancelled', '未执行')
          return
      }
    }

    void (async () => {
      try {
        const r = await runGraph(
          {
            nodes: specs.nodes,
            /* 连线的翻译（含 `sourceHandle`）也在 `toRunSpecsFromCanvas` 里。
             * 原先这里手写了一遍并漏掉 `sourceHandle` —— 后果是**没走的分支照跑**：
             * `edgeIsLive(undefined, ['false'])` 返回 true。 */
            edges: specs.edges,
            targets: wholeGraph ? undefined : targets,
            includeUpstream,
            workdir: workdirRef.current,
            /* 画布在浏览器里，**碰不到磁盘** —— 所以「跑另一份工作流」这一环
             * 转交给宿主半（它有存档目录、节点定义表、本地派发器）。
             * 宿主半会自己递归处理子工作流里再套子工作流的情形。 */
            runWorkflow: async (ref, signal) => {
              const out = await runWorkflowFile(ref, signal)
              return { ok: out.ok, error: out.error }
            },
          },
          /* 派发走 HTTP（宿主半在本进程外）。调度器只认这个函数签名。
           *
           * ★ 第三个参数是**流式分片的消费方**（票 28 第二步）：`dispatchNode` 会
           * 用 `req.runId` 先开一条订阅，把宿主半推进来的每一片字交给这里，
           * 直接走与列表页同一条路（`appendStream`）。
           *
           * ⚠️ 这里**不能用 `onEvent`**：`onEvent` 认的是引擎的 `RunEvent`，
           * 而这一片字是宿主半直接从 SSE 送来的，两者是两条不同的通道。
           * 用 `appendStream` 让它们**落到同一份数据**上（渲染也只有一套组件）。 */
          (req, signal) => dispatchNode(req, signal, (chunk) => {
            useRunStore.getState().appendStream(chunk.nodeId, chunk.text)
          }),
          { onEvent, signal: ac.signal, workflowId: 'v1-canvas' },
        )
        void r

        /* ★ **中断之后，把还挂着「排队中」的节点撤掉**（2026-10-23 契约 AC）。
         *
         * ## 用户看到的那一幕
         *
         * 原话：「报错了，但是后续还在执行。」—— 实际没继续执行。
         * 问题是**显示**：一开跑就把每个节点标成「排队中」（引擎的 `queued` 事件），
         * 3 号节点失败中断后，**没有任何代码把那些「排队中」撤掉**，
         * 于是画布上看着像后面还在跑。
         *
         * ## 为什么放在这里，而不是只靠事件
         *
         * `onEvent` 那条路只处理**引擎真发了**的事件。引擎可能还没发 `cancelled`
         * （那是 `工作台·引擎` 正在加的东西），也可能因为流断了没收到最后几条 ——
         * 于是这里**跑完再核一遍**：万一事件没到，也不留悬挂的「排队中」。
         *
         * 两处都做，分工是：
         *   · `onEvent` 里那条 → 事件来了**立刻**画对（中途就能看到）；
         *   · 这里 → 跑完**兜底**一次（不留悬挂）。
         *
         * ## 三条纪律
         *
         * ① **只动 `queued`**。已经 `failed` 的那个节点是**真失败**，不许被这条改写 ——
         *    否则用户查了半天发现「红叉被改成了未执行」，真正的错因就找不着了。
         *    同理 `success` / `running` 都不碰。
         * ② **只在 `aborted === true` 时做**。正常跑完时队列里本来就都跑完了，
         *    这时再扫一遍没有意义，反而有把「刚派发出去还没回来的节点」误标的险。
         * ③ 标成 **`cancelled` + 「未执行」**，不是 `idle` + 「已停止」——
         *    `idle` 的意思是「还没跑过」，这里的节点是「因为前面中断所以没跑」，
         *    两者事实不同（`NodeState` 里 `cancelled` 那条注释就在讲这个）。
         *
         * ## ⚠️ 为什么先把结果算出来，而不是把映射函数交给 `setNodes`（2026-10-23 补丁）
         *
         * 原先写的是 `setNodes(ns => ns.map(...))`。那个回调的入参 `ns` 是
         * **上一版**状态，函数体里能改，但**外面拿不到结果** ——
         * 于是紧接着的上报只能去读 `nodesRef.current`，而那个 ref 是**渲染期**
         * 才同步的（见下面 `nodesRef.current = nodes` 那一处）。
         *
         * 后果：兜底刚把节点改成 `cancelled`，上报却把**旧的 `queued`** 送出去 ——
         * 兜底在画面上生效、在记录里等于没做。
         *
         * 现在改成：**先读 ref 算出一份新数组**，`setNodes(算好的)` 与上报
         * 用的是**同一个结果**（`finalNodes`）。这样「上报读到的是最终状态」
         * 是结构上成立的，不靠时序赌。
         *
         * ⚠️ 边界：`nodesRef.current` 在跑完这一刻就是「事件都处理完的那一版」
         * （`onEvent` 每次都走 `setNodes` → 渲染 → 同步 ref），所以拿它当输入是对的。
         * 这里唯一会漏的是「同一轮里更晚的 setNodes」，而这条路径上不存在那样的调用。 */
        const finalNodes: V1Node[] = r.aborted === true
          ? nodesRef.current.map(n => {
            if (n.data.state !== 'queued') return n
            return { ...n, data: { ...n.data, state: 'cancelled' as NodeState, progress: '未执行' } }
          })
          : nodesRef.current
        /* 只有真改过才 setNodes —— 正常跑完与改动前完全一致（不多一次重渲染）。 */
        if (r.aborted === true) setNodes(finalNodes)

        /* ★ **把这次跑上报成「运行历史」的一条记录**（用户 m14827：
         *   「我在画布中运行的，运行历史没有出现记录」）。
         *
         * ## 为什么画布要自己报
         *
         * `appendRun` 原来只在**宿主半自己跑整份工作流**的两条路径上调
         * （`/workflow/run`、`/workflow/run-stream`）。而画布是**客户端自己跑的** ——
         * 它调 `runGraph`、逐节点 `POST /run` 派发，宿主半全程不知道
         * 「这是一次整份运行的开始与结束」，所以没法自己写。
         * 于是「列表里点▶跑」有历史、「画布上点▶运行」没有。
         *
         * ## 数据从哪来
         *
         * 节点结局与日志都在 `useRunStore`（`onEvent` 一路喂进去的），
         * 这里只负责**搬运**，不重算 —— 免得「同一件事写两份」再漂一次
         * （见 `pitfalls/同一件事写两份迟早漂.md`）。
         *
         * ⚠️ **没归属名时不报**（`fileRef.current.name === ''`）：那种运行
         * 没有可归属的工作流，硬塞一个名字只会污染历史列表。
         * 宿主半也会拦一次（双保险）。
         *
         * ⚠️ **失败不打扰用户**：历史没记上不该在跑完之后冒一个错误框，
         * 只在控制台留一句（用 `void` 吃掉 rejection）。 */
        {
          const owner = fileRef.current.name
          if (owner !== '') {
            const rs = useRunStore.getState().byNode
            /* ⚠️ **这里用 `finalNodes`，不用 `nodesRef.current`**（2026-10-23 补丁）。
             *
             * 理由见上面那段注释：ref 是**渲染期**才同步的，同步代码里刚 setNodes
             * 立刻读 ref 拿到的是上一版。兜底改的状态会因此丢失 ——
             * 画面上是「未执行」、记录里却是「排队」。
             *
             * `finalNodes` 与 `setNodes` 用的是**同一个结果**，所以读到的
             * 一定是这一轮的最终状态。 */
            const byId = new Map(finalNodes.map(n => [n.id, n]))
            const nodeLines = Object.entries(rs).map(([nodeId, d]) => {
              const n = byId.get(nodeId)
              /* `useRunStore` 只存日志与进度，**没有**结局 —— 那个在 `nodes[].data.state` 上。
               * 两边合起来才是一条完整明细。 */
              const st = n?.data.state
              return {
                nodeId,
                ...n?.data.def.id === undefined ? {} : { defId: n.data.def.id },
                ...typeof n?.data.label === 'string' && n.data.label !== '' ? { label: n.data.label } : {},
                /* ## 白名单：哪些状态**原样**写进记录
                 *
                 * `success` / `failed` / `running` / `queued` / **`cancelled`**。
                 *
                 * ⚠️ **`cancelled` 是 2026-10-23 补上的**。它原先不在这里，
                 * 于是画布自报的「未执行」会落到 `'skipped'` —— 而「跳过」的意思是
                 * 「手动跳过 / 这条分支没走」，与「前面失败了它没轮到」是两件事，
                 * 用户点开记录会对不上。宿主半那条路（`src/index.ts` 的
                 * `mergeNodeEvent`）一直是对的，能记成 `cancelled`；
                 * **只有画布这条自报路径错**，两条路写同一件事却不一样 ——
                 * 正是「同一件事写两份迟早漂」（见 `pitfalls/同一件事写两份迟早漂.md`）。
                 *
                 * ## `idle` / `missing` 为什么仍然落到 `skipped`（这次**故意不动**）
                 *
                 * | 状态 | 现在的落点 | 为什么暂不改 |
                 * | --- | --- | --- |
                 * | `idle` | → `skipped` | 「还没跑过」与「跳过」确实不同，但要改它得先决定「没跑过的节点该不该进记录」—— 那是另一件事，牵到记录体积与列表可读性 |
                 * | `missing` | → `skipped` | 依赖缺失目前只在节点外观上用，记录层还没有它的语义约定 |
                 *
                 * 这两条不属于本单，改动面越大越容易出新问题 —— 记在这里，
                 * 等真要做时再一起想「记录里该不该有它们」。 */
                state: st === 'success' || st === 'failed' || st === 'running' || st === 'queued'
                  || st === 'cancelled'
                  ? st : 'skipped',
                logs: d.lines.slice(-40),
              }
            })
            void recordCanvasRun({
              name: owner,
              startedAt,
              endedAt: Date.now(),
              /* ⚠️ `runGraph` 的返回**没有 `ok` / `error` 两个字段**
               * （见 `RunGraphResult`）：它要么跑完、要么 `aborted` 为真。
               * 「失败但有节点跑过」也算 `ok: false` —— 与宿主半 `finish()` 里
               * 「`ok` 与 `aborted` 一起看」那条判据同源。 */
              ok: r.aborted !== true,
              ...r.aborted === true ? { aborted: true } : {},
              ran: Array.isArray(r.ran) ? r.ran : [],
              nodes: nodeLines,
              ...Object.keys(r.declaredOutputs ?? {}).length === 0 ? {} : { outputs: r.declaredOutputs },
              ...Object.keys(r.inputs ?? {}).length === 0 ? {} : { inputs: r.inputs },
            }).then((out) => {
              if (!out.ok) console.warn('[运行历史] 这次没记上：' + String(out.error ?? ''))
            })
          }
        }
      } finally {
        if (!ac.signal.aborted) setRunning(false)
      }
    })()
  }, [setNodes, stopRun, markNode])

  /**
   * 单步调试（用户点名的 P3 项）：一次只跑一个节点，并停下来等用户看结果。
   *
   * 为什么需要：整条跑一遍要等很久，中间哪一步出了问题、输入是什么，
   * 都看不到。单步能「跑一个、看一眼、再跑下一个」。
   *
   * 与「▶ 跑这个」的区别：那个是**独立**跑一个节点（上游输出不参与，
   * 拿到的是空的）；这里是**沿着链**跑下一个该跑的节点，上游数据是真的。
   */
  const [stepping, setStepping] = useState(false)

  /**
   * 走一步：按拓扑序找出「还没跑过的、且上游都跑过了」的第一个节点，跑它。
   *
   * ⚠️ **这个函数暂时没有调用方，是有意的**（用户 2026-10-11）：
   * 「标题栏中的单步按钮去掉（功能保留，放在右键菜单中）」。
   * 工具条上那个「⤼ 单步」按钮已删（顶部太挤），功能留着等右键菜单接上。
   * 计划见 `plans/2026-10-11-右键菜单与分组.md`。
   */
  const stepOnce = useCallback((): void => {
    if (locked) { notify('画布已锁定，先解锁才能运行', 'warn'); return }
    const all = nodesRef.current
    const order = topoSort(all.map(n => ({ id: n.id })), edgesRef.current).order
    const done = new Set(all.filter(n => n.data.state === 'success').map(n => n.id))
    const nextId = order.find(id => {
      if (done.has(id)) return false
      const ups = edgesRef.current.filter(e => e.target === id).map(e => e.source)
      return ups.every(u => done.has(u))
    })
    if (nextId === undefined) { notify('已经没有可走的下一步了（都跑过了）', 'ok'); return }
    setStepping(true)
    runSeq([nextId], false)
    /* runSeq 是异步的；这里只负责发起，跑完由状态变化体现 */
    window.setTimeout(() => { setStepping(false) }, 300)
  }, [locked, notify, runSeq])

  /** 整条跑（工具条 ▸ 运行）。 */
  const runAll = useCallback((): void => { runSeq([], true) }, [runSeq])

  /**
   * 只跑一个节点（节点上的 ▶ 与右键「只跑这个」）——单节点调试。
   *
   * ⚠️ `includeUpstream = false`（2026-10-11 修）：这个入口的说明写着
   * 「只运行这一个节点（调试用）」，但**原先与 `runFrom` 传的是同一组参数**，
   * 于是实际上会连上游一起跑 —— 说明与行为不符。
   * 合并跑法时才发现这处差异（两份实现里都写着 `runSeq([id], false)`）。
   *
   * 为什么「独立跑」有价值：看**这一个节点**在正常输入下行为对不对、
   * 改完参数立刻验证，不必等上游那串。要带数据就用「从这里跑」。
   */
  const runOne = useCallback((id: string): void => { runSeq([id], false, false) }, [runSeq])

  /** 从这个节点开始跑（节点上的 ▶▶）：先跑它所有上游，再跑它。 */
  const runFrom = useCallback((id: string): void => { runSeq([id], false) }, [runSeq])

  /* ── 右键菜单的**内容装配**（状态与 closeMenu / selectAll 在上面，见那里的位置说明）
   *
   * 三种上下文，见 `ContextMenu.tsx` 的头注释。每个项都指向一个已有的函数，
   * **没有为菜单新写业务逻辑**（唯一新写的是「全选」，已在上面）。
   *
   * ⚠️ 这段**必须放在所有它引用的回调之后**（`groupSelected` / `ungroupById` /
   * `stepOnce` / `toggleSkipSelected` / `copySelected` / `pasteClipboard` /
   * `deleteSelected` / `runLayout`）——理由同上，提交前跑 `npm run check:tdz`。
   */

  /** 收起所有节点的展开设置（等价于点一次空白）。 */
  const collapseAll = useCallback((): void => {
    /* 收起后让位自动退回（见 runShift）—— 由节点的 layout effect 报到，
     * 这里不必逐个 schedule。 */
    setExpandedNode(null)
    setSelected(null)
    setNodes(ns => ns.map(n => (n.selected === true || n.data.expanded === true)
      ? { ...n, selected: false, data: { ...n.data, expanded: false } }
      : n))
  }, [setNodes])

  /** 锁定 / 解锁（与工具条那个按钮同一套逻辑，抽出来给菜单复用）。 */
  const toggleLocked = useCallback((): void => {
    const next = !locked
    setLocked(next)
    try { localStorage.setItem('ewb.locked', next ? '1' : '0') } catch { /* 忽略 */ }
    notify(next ? '画布已锁定（只读）' : '已解锁，可以编辑了', next ? 'warn' : 'ok')
  }, [locked, notify])

  /**
   * 右键点在**一个普通节点**上 → 节点菜单。
   *
   * ## 加入 / 移出容器（用户 2026-10-12 问「怎么算加入怎么脱出」）
   *
   * 两条路都给了，各管一种场合：
   *   - **拖进去 / 拖出来**：常规操作，拖动时容器会高亮（见 `dropTargetId`）。
   *   - **右键菜单**：容器很大、框里挤、或节点小不好抓的时候用。
   *
   * 「移出」的菜单项**只在节点确实属于某个容器时才出现** ——
   * 不属于任何容器时显示它只会让人以为点错了。
   *
   * @param n - 被右键的节点。
   * @returns 菜单项。
   */
  const nodeMenuEntries = useCallback((n: V1Node): MenuEntries => {
    const skipped = n.data.skipped === true
    const idle = !running
    /* 它现在属于哪个容器（分组框或循环）。 */
    const owner = n.parentId === undefined ? undefined : nodesRef.current.find(x => x.id === n.parentId)
    const ownerName = owner === undefined ? ''
      : owner.type === 'group' ? (owner.data.groupLabel ?? '分组')
        : (owner.data.label ?? owner.data.def.label)
    return [
      /* 容器归属（2026-10-13 改）：**显式菜单**，不再靠拖动。
       *
       * 为什么：用户定规矩「先看 n8n 与 Dify，他们都没有的就不做」，
       * 而两家都不靠拖动改容器归属（n8n 靠连线、Dify 靠加节点时继承）。
       * 菜单比拖动可控：不会因为手抖而改变归属。
       *
       * ⚠️ **2026-10-19 改：循环自己也有这两项**（用户原话：「右键菜单不复杂吧？
       *   别人没有我们才自研对吧？」）。
       *
       * 旧版把循环排除掉（`n.data.def.id === LOOP_DEF_ID ? [] : …`），理由是
       * 「容器不能被放进容器」。但 2026-10-19 起**嵌套循环是真的**（t17 已实现），
       * 那条排除就变成了缺口：想改嵌套结构只能改存档。
       *
       * ⚠️ Dify **明确禁止**把迭代/循环放进容器（`use-available-blocks.ts:9-16`），
       * 所以这一项在 Dify 那边**抄不到**，属于自研 —— 但它是「嵌套循环」这个
       * 我们已经做了的能力的**必要配套**：能力有了、界面没入口，等于半个功能。
       * 与「拖进拖出」的区别：那个连能力都没有（两家都没这个交互），
       * 这个的能力与执行期判据都已存在（`MAX_LOOP_DEPTH` / `loopChainDepth`）。 */
      ...(n.type === 'group' ? [] : (() => {
        const all = nodesRef.current
        const owner = n.parentId === undefined ? undefined : all.find(x => x.id === n.parentId)
        const inLoop = owner !== undefined && owner.data.def.id === LOOP_DEF_ID
        /* 候选由 `loopTargetsFor` 算（它排除自己、自己的后代、以及会超 5 层的）。
         * 与执行期判据同源 —— 见那个函数的注释。 */
        const targets = loopTargetsFor(all, n.id)
        const entries: MenuEntries = []
        if (inLoop) {
          entries.push({ id: 'outOfLoop', icon: <CornerUpRightIcon />, label: '移出循环', run: () => { takeOutOfLoop(n.id) }, disabled: locked })
        }
        /* 一个可放的都没有时**说清为什么**，不静默藏起来：
         * 用户看不到菜单项会以为功能坏了。 */
        if (targets.length === 0) {
          if (!inLoop) {
            entries.push({
              id: 'intoLoopNone', icon: <CornerDownRightIcon />, label: '没有可放入的循环', run: () => { /* 只是提示，不做事 */ }, disabled: true,
            })
          }
        } else {
          /* **每个候选一行**（扁平，不做子菜单）。
           *
           * 为什么不做子菜单：`ContextMenu.tsx` 是扁平的（`MenuItems = (MenuItem|null)[]`），
           * 加子菜单要配套悬停展开、二级定位、点外关闭三套新逻辑；
           * 而 n8n 与 Dify 的右键菜单**都是扁平的**（Dify 只有 8 项、没有二级）。
           * 画布上的循环一般两三个，一行一个看得全、点得快。
           * 只有一个候选时也不特殊处理 —— 统一形状比省一行更省心。 */
          for (const t of targets) {
            entries.push({
              id: 'intoLoop:' + t,
              icon: <CornerDownRightIcon />,
              label: '放入「' + containerName(all, t) + '」',
              run: () => { putIntoLoop(n.id, t) },
              disabled: locked,
            })
          }
        }
        return entries.length === 0 ? [] : [...entries, null]
      })()),
      { id: 'runOne', icon: <PlayIcon />, label: '只跑这个', run: () => { runOne(n.id) }, disabled: !idle },
      { id: 'runFrom', icon: <FastForwardIcon />, label: '从这里跑（带上上游）', run: () => { runFrom(n.id) }, disabled: !idle },
      /* 「跑下一步」是本轮从工具条搬来的（用户：「功能保留，放在右键菜单中」）。 */
      { id: 'step', icon: <StepForwardIcon />, label: '跑下一步', run: () => { stepOnce() }, disabled: !idle },
      null,
      {
        id: 'skip',
        icon: <SkipForwardIcon />,
        label: skipped ? '恢复这个节点（不再跳过）' : '跳过这个节点',
        run: () => {
          /* 先把这个节点选上，再调用批量切换——那个函数作用于「选中的全部」，
           * 这里只有一个，所以效果就是「只切它」。复用而不是另写一份，
           * 保证与批量版的语义（含 notify 文案）完全一致。 */
          setNodes(ns => ns.map(x => ({ ...x, selected: x.id === n.id })))
          toggleSkipSelected()
        },
        disabled: locked,
      },
      null,
      {
        id: 'copy',
        icon: <CopyIcon />,
        label: '复制',
        key: 'Ctrl+C',
        run: () => { setNodes(ns => ns.map(x => ({ ...x, selected: x.id === n.id }))); copySelected() },
      },
      {
        id: 'dup',
        icon: <CopyPlusIcon />,
        label: '原地复制一份',
        key: 'Ctrl+D',
        run: () => {
          setNodes(ns => ns.map(x => ({ ...x, selected: x.id === n.id })))
          if (copySelected() > 0) pasteClipboard()
        },
        disabled: locked,
      },
      null,
      {
        id: 'del',
        icon: <TrashIcon />,
        label: '删除',
        key: 'Delete',
        danger: true,
        run: () => { setNodes(ns => ns.map(x => ({ ...x, selected: x.id === n.id }))); deleteSelected() },
        disabled: locked,
      },
    ]
  }, [running, locked, runOne, runFrom, stepOnce, toggleSkipSelected, copySelected, pasteClipboard, deleteSelected, setNodes])

  /**
   * 右键点在**多个选中的节点**上 → 批量菜单。
   * @param pickedCount - 选中的节点数。
   * @returns 菜单项。
   */
  const selectionMenuEntries = useCallback((pickedCount: number): MenuEntries => {
    const picked = nodesRef.current.filter(n => n.selected === true)
    /* 全都被跳过时，这一项的含义是「全部恢复」。 */
    const allSkipped = picked.length > 0 && picked.every(n => n.data.skipped === true)
    return [
      /* 「打包成分组」是本轮接上的（用户：「打包分组有必要，和右键功能一起规划」）。
       * 它此前**代码写好但从没过界面**，等于不存在。 */
      {
        id: 'group',
        icon: <SelectAllIcon />,
        label: '打包成分组（' + String(pickedCount) + ' 个）',
        key: 'Ctrl+G',
        run: () => { groupSelected() },
        disabled: locked,
      },
      null,
      {
        id: 'skipAll',
        icon: <SkipForwardIcon />,
        label: allSkipped ? '全部恢复（不再跳过）' : '全部跳过',
        run: () => { toggleSkipSelected() },
        disabled: locked,
      },
      { id: 'copyAll', icon: <CopyIcon />, label: '复制这 ' + String(pickedCount) + ' 个', key: 'Ctrl+C', run: () => { copySelected() } },
      {
        id: 'delAll',
        icon: <TrashIcon />,
        label: '删除这 ' + String(pickedCount) + ' 个',
        key: 'Delete',
        danger: true,
        run: () => { deleteSelected() },
        disabled: locked,
      },
    ]
  }, [locked, groupSelected, toggleSkipSelected, copySelected, deleteSelected])

  /**
   * 右键点在**分组框**上 → 分组菜单（契约 CE，照参考项目 `canvas-context-menu.tsx`）。
   *
   * 成员数**从节点的 `groupId` 数**（框是真节点，成员不在它身上）。
   *
   * 四件事，都是参考项目有的：
   *   - 解散（删框 + 清成员归属）
   *   - 适应成员（框缩到刚好包住成员）
   *   - 收纳框内节点（几何上落在框里的都归进来）
   *   - 选中组内全部成员（拖一整组之前要先选上）
   *
   * @param gid - 组 id。
   * @returns 菜单项。
   */
  const groupMenuEntries = useCallback((gid: string): MenuEntries => {
    const kids = nodesRef.current.filter(x => x.data.groupId === gid).map(x => x.id)
    const n = kids.length
    return [
      {
        id: 'ungroup',
        icon: <GroupIcon />,
        label: '解散分组（' + String(n) + ' 个节点留在原处）',
        key: 'Ctrl+G',
        run: () => { ungroupById(gid) },
        disabled: locked,
      },
      {
        id: 'fitGroup',
        icon: <MaximizeIcon />,
        label: '适应成员（把框缩到刚好包住它们）',
        run: () => { fitGroup(gid) },
        disabled: locked || n === 0,
      },
      {
        id: 'captureGroup',
        icon: <BoxSelectIcon />,
        label: '把框内的节点收进这一组',
        run: () => { captureGroup(gid) },
        disabled: locked,
      },
      null,
      {
        id: 'selectMembers',
        icon: <SelectAllIcon />,
        label: '选中组内全部成员（' + String(n) + ' 个）',
        run: () => { selectGroupChildren(gid) },
        disabled: n === 0,
      },
      null,
      {
        id: 'delGroupMembers',
        icon: <TrashIcon />,
        label: '解散并删除这 ' + String(n) + ' 个节点',
        danger: true,
        /* 先选出成员再走统一的删除（它进撤销栈 —— 不要自己 map+filter）。
         * ⚠️ 框本身也要选上，否则删完成员、框还在画布上孤零零留着。 */
        run: () => {
          const ids = new Set([...kids, gid])
          setNodes(ns => ns.map(x => ({ ...x, selected: ids.has(x.id) })))
          deleteSelected()
        },
        disabled: locked,
      },
    ]
  }, [locked, ungroupById, deleteSelected, setNodes, fitGroup, captureGroup, selectGroupChildren])

  /**
   * 右键点在**空白处** → 画布菜单。
   * @returns 菜单项。
   */
  const paneMenuEntries = useCallback((): MenuEntries => [
    {
      id: 'paste',
      icon: <CopyIcon />,
      label: '粘贴',
      key: 'Ctrl+V',
      run: () => { pasteClipboard() },
      disabled: locked,
    },
    { id: 'selectAll', icon: <SelectAllIcon />, label: '全选', key: 'Ctrl+A', run: () => { selectAll() } },
    null,
    { id: 'layoutR', icon: <ArrowRightIcon />, label: '自动布局：从左到右', run: () => { runLayout('RIGHT') } },
    { id: 'layoutD', icon: <ArrowDownIcon />, label: '自动布局：从上到下', run: () => { runLayout('DOWN') } },
    { id: 'fit', icon: <MaximizeIcon />, label: '缩放适配', run: () => { flowToScreenApi.current?.fitView({ padding: 0.22 }) } },
    null,
    { id: 'collapseAll', icon: <ChevronsDownIcon />, label: '收起所有节点设置', run: () => { collapseAll() } },
    /* ⚠️ 这一处是**上一轮漏掉的**（2026-10-26 补齐）。
     *
     * 那一轮把画布层的字符图标统一换成 `icons.tsx` 的真 SVG 时，工具条上
     * `<LockIcon />` / `<UnlockIcon />` 换好了（见 `toolIcon` 那一处），
     * 但**右键菜单这一行还留着 emoji** `🔒` / `🔓`。
     *
     * emoji 的问题在别处说过：不跟随 `currentColor`（它在部分环境是**彩色方块**），
     * 而且与真 SVG 的 1.7 描边摆在一起粗细不一。同一个「锁定」在两处长得不一样，
     * 用户会以为是两个功能。 */
    { id: 'lock', icon: locked ? <UnlockIcon /> : <LockIcon />, label: locked ? '解锁画布（可以编辑了）' : '锁定画布（只读）', run: () => { toggleLocked() } },
  ], [locked, pasteClipboard, selectAll, runLayout, collapseAll, toggleLocked])

  /**
   * 右键一个节点。
   *
   * 判定顺序很重要：**先看它是不是分组框、再看是不是「多选中的一员」**。
   * 分组框永远走它自己的菜单（它不能被「打包成分组」，也不能单独跑）。
   */
  const onNodeContextMenu = useCallback((e: React.MouseEvent, n: V1Node): void => {
    e.preventDefault()
    /* 锁定只拦「会改动画布」的项，运行与定位类照常可用——所以这里不提前 return。 */
    if (n.type === 'group') {
      setMenu({ x: e.clientX, y: e.clientY, title: '分组框', entries: groupMenuEntries(n.id) })
      return
    }
    const pickedCount = nodesRef.current.filter(x => x.selected === true && x.parentId === undefined).length
    if (pickedCount > 1) {
      setMenu({ x: e.clientX, y: e.clientY, title: '选中的 ' + String(pickedCount) + ' 个节点', entries: selectionMenuEntries(pickedCount) })
      return
    }
    /* 单选：先把这个节点选上，让「选中态」与菜单说的对象一致。 */
    setNodes(ns => ns.map(x => ({ ...x, selected: x.id === n.id })))
    setMenu({ x: e.clientX, y: e.clientY, title: n.data.def.label, entries: nodeMenuEntries(n) })
  }, [groupMenuEntries, selectionMenuEntries, nodeMenuEntries, setNodes])

  /** 右键空白处：画布菜单。 */
  const onPaneContextMenu = useCallback((e: React.MouseEvent | MouseEvent): void => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, title: '画布', entries: paneMenuEntries() })
  }, [paneMenuEntries])

  /** 右键选中的一批（React Flow 在选区上右键时走这个回调）。 */
  const onSelectionContextMenu = useCallback((e: React.MouseEvent): void => {
    e.preventDefault()
    const pickedCount = nodesRef.current.filter(x => x.selected === true).length
    setMenu({
      x: e.clientX, y: e.clientY,
      title: '选中的 ' + String(pickedCount) + ' 个节点',
      entries: selectionMenuEntries(pickedCount),
    })
  }, [selectionMenuEntries])

  /* 把最新实现写入 ref —— 节点 data 里的包装函数只认 ref，不进 React 依赖链。
   * 这是本文件的关键防循环措施：否则 runSeq → nodes → 回调重建 → useEffect → setNodes → 死循环。 */
  useEffect(() => {
    runOneRef.current = (id: string) => { runOne(id) }
    runFromRef.current = (id: string) => { runFrom(id) }
    onParamRef.current = (id: string, key: string, value: unknown) => { onParamFor(id, key, value) }
    onOnErrorRef.current = (id: string, v: OnError) => { onOnErrorFor(id, v) }
    deleteRef.current = (id: string) => { deleteOne(id) }
    nodesRef.current = nodes
  /* 渲染拿到最新的节点数组了 → 让位那本「还没被消费的草稿」作废（见 shiftPendingRef）。 */
  shiftPendingRef.current = null
    edgesRef.current = edges
    browserPrefsRef.current = browserPrefs
    /* 归属名：上报运行历史时读它（见 `fileRef` 的注释）。 */
    fileRef.current = file
    nodeWRef.current = nodeW
    spacingRef.current = layoutSpacing
    /* 方向：`refitNodes`（空依赖）在**下一拍**读它 —— 渲染期同步，见 `dirRef` 的说明。 */
    dirRef.current = dir
    /* ⚠️ **`browserPrefs` 必须在依赖里**（2026-10-14 修，T7 发现的既存 bug）。
     *
     * 它原来漏了：于是 `setBrowserPrefs` 之后所有别的依赖都没变
     * → 这个 effect **不跑** → `browserPrefsRef.current` 仍是旧值。
     * 而节点那一段是 `useMemo`（依赖 `[nodes, edges, ...]`）、同样不会重算，
     * 所以**改完浏览器设置，界面上看不到任何变化**（要等到下次动节点才生效）。
     *
     * 为什么以前没人发现：改成 CDP「端口写死 9222」那阵，第二层只有
     * `browserId` / `launcher` 两个几乎不变的字段，改它的人少、影响也小；
     * T7 把它变成**要在节点里当场切换**的东西（来源 / 端口 / 打开方式），
     * 这个漏依赖就立刻表现为「切了来源，下面那一套控件不跟着换」。
     *
     * ⚠️ 顺带：`detectState` 也要进依赖 —— 它经 `detectedBrowsers` → `useMemo` → data，
     * 检测结果回来时那段也要重算（否则「检测到了浏览器」也要等下次动节点才显示）。 */
  }, [
    runOne, runFrom, onParamFor, onOnErrorFor, nodes, edges,
    browserPrefs, nodeW, layoutSpacing,
    /* ⚠️ `file` 也要在依赖里（2026-10-20）：漏了的话「另存为」之后
     * `fileRef.current` 还是旧名字 → 画布跑完上报历史会记到**上一个名字**上
     * （与上面 `browserPrefs` 漏依赖是同一类 bug）。 */
    file,
  ])

  /**
   * 把当前画布导成可存档的工作流对象。
   *
   * 导出的是**实例级**的值（节点自己的参数与失败策略），不是共享的类型定义——
   * 否则会存出一份「改一个节点、所有同类型节点跟着变」的错档。
   *
   * @returns 工作流对象。
   */
  /**
   * 组装工作流文档（存档格式）。
   *
   * ⚠️ 转换逻辑在 `workflow-doc.ts`（纯函数、可单测）——2026-10-12 抽出去，
   * 因为**存档格式无法单测**是最要命的一类：格式错了，用户保存后打开就对不上，
   * 而构建、类型检查、界面渲染**全都不报错**。抽出去后有了往返断言。
   */
  /* 存档写的**只有 `nodes` / `edges` 与几个 root 级字段**（契约 CE）。
   *
   * ⚠️ 写的是**真节点**（`nodes`），不是 `shownNodes` —— `shownNodes` 里可能有
   * 「循环收起时打了 `hidden`」的临时标记，存进存档就是脏数据。
   *
   * ⚠️ **编组不再有第二份数据要带**：组是 `nodes` 里的一项，成员归属在
   * `data.groupId` 上。上一版这里要额外传一份 `groups` 名单、还要把它放进依赖数组
   * 才不会有「改了编组却显示已保存」的问题 —— 那整类问题随名单模型一起消失了。 */
  const toWorkflowDoc = useCallback(
    (name: string): WorkflowDoc => toWorkflowDocOf(nodes, shownEdges, name, [], description, types, wfId),
    [nodes, shownEdges, description, types, wfId],
  )

  /**
   * 当前画布内容与「上次写盘时」是否不同（→ 工具条上的「未保存」标记）。
   *
   * 判据是**内容指纹对比**，不是「有没有人操作过」——后者必然误报
   * （点一下节点也算改动），用户会一直看到「未保存」而不再相信这个标记。
   * 指纹怎么算见 `workflow-doc.ts` 的 `docFingerprint`（故意排除 `name` 与运行状态）。
   */
  const dirty = useMemo(
    () => docFingerprint(toWorkflowDoc(file.name)) !== savedFp,
    [toWorkflowDoc, file.name, savedFp],
  )

  /**
   * 装一次「基线指纹」：把**挂载时画布上的那份内容**当作已保存的状态。
   *
   * ## 为什么必须有这一步（我的第一版漏了，被 `dom-render` 的新断言当场抓到）
   *
   * `savedFp` 初值是空串，于是 `dirty` = 「当前内容 ≠ 空」= **恒真** ——
   * 画布一打开就顶着「未保存」。那不是「有改动」，是**恒亮的标记**，
   * 而恒亮的标记等于没有标记：用户会立刻学会忽略它（这正是最坏的结局，
   * 因为它本该是「你敢不敢关掉」的唯一依据）。
   *
   * 用 ref 守卫保证**只设一次**：之后 `savedFp` 归保存 / 打开 / 新建三条路径管。
   * 放在 `dirty` 之后是为了避开本项目的高频坑「用在定义之前」（`check:tdz` 专抓这个）。
   */
  const baselineSet = useRef(false)
  useEffect(() => {
    if (baselineSet.current) return
    baselineSet.current = true
    setSavedFp(docFingerprint(toWorkflowDoc(file.name)))
  }, [toWorkflowDoc, file.name])

  /**
   * 写一份工作流到本机，成功后**把归属记下来**。
   *
   * 「有归属则覆盖、无归属才新建」这条判断在 `resolveSaveTarget` 里（纯函数、有单测）——
   * 这里只负责调它、写盘、把结果说给用户听。
   *
   * @param name - 要写的名字（调用方已决定：覆盖还是新建）。
   * @param creates - 这次是不是新建（决定提示语）。
   */
  const writeFile = useCallback((name: string, creates: boolean): void => {
    const rs = useRunStore.getState()
    const doc = toWorkflowDoc(name)
    /* 票 54：悬浮条上的「保存中…」由这两行点亮/熄灭。
     * ⚠️ 放在 `void (async …)()` **之前**与 `finally` 里 —— 早退分支（保存失败）
     * 也必须把它清掉，否则那句「保存中…」会一直挂着。 */
    setSaving(true)
    void (async () => {
      const r = await saveWorkflowFile(name, doc)
      setSaving(false)
      if (r.ok) {
        /* ⚠️ 用**宿主半回的名字**（它做过安全清洗）而不是我们请求的那个 ——
         * 否则「名字里有非法字符」时归属名与磁盘上的文件名会对不上，
         * 下一次保存就又变成写一个新文件（那正是这次要修的 bug）。 */
        const real = r.name ?? name
        setFile({ name: real, isNew: false })
        /* 编号也要收下：宿主半可能刚给这份老存档补了一个。
         * 不收的话画布仍以为「没有编号」→ 下一次保存又按文件名派生一个，
         * 而两次派生的种子可能不同（改过名的存档）→ 编号变了 → 引用全断。 */
        if (r.id !== undefined && r.id !== '') setWfId(r.id)
        setSavedFp(docFingerprint(doc))
        notify(creates ? '已保存为新文件「' + real + '」' : '已保存到「' + real + '」', 'ok')
        /* 新存的这份要出现在「跑另一份工作流」的候选清单里（2026-10-19）。 */
        reloadWfCandidates()
      } else {
        notify('保存失败：' + (r.error ?? '未知原因'), 'error')
      }
      if (workdirRef.current !== '') rs.setProgress('__save__', 1, 1)
    })()
  }, [toWorkflowDoc, notify, reloadWfCandidates])

  /**
   * **保存**（工具条的 ⇩）—— 用户 2026-10-14 报的那个 bug 的修法。
   *
   * 有归属 → **覆盖那一份**（磁盘上不新增文件）；
   * 没有归属（刚打开画布 / 刚点「新建」）→ 生成时间戳名字新建一份，
   * 并**当场获得归属** —— 所以再点一次是覆盖，不会又生成一个。
   *
   * 改动前这里是「永远用时间戳新建」，所以「打开天猫取数 → 保存 → 变成新文件」
   * 是**必然结果**，不是偶发。
   */
  const save = useCallback((): void => {
    const target = resolveSaveTarget(file, timestampName())
    writeFile(target.name, target.creates)
  }, [file, writeFile])




  /**
   * 把一份工作流内容加载到画布上（从列表打开 / 新建空白 / 从快照恢复，共用）。
   *
   * 关键设计：**节点类型找不到时不整份拒绝**——
   * 缺一个节点就整份打不开，用户会丢掉整份工作。改为「能加载的先加载 + 列出缺什么」。
   * 加载前记一次撤销快照，Ctrl+Z 能回到导入前。
   *
   * ## 归属（2026-10-14 加）
   *
   * **加载一份内容的同时就把「这是哪份文件」记下来** —— 这正是用户报的 bug 的修法：
   * 以前打开一份内容，画布**不知道它是谁**，于是保存只能新建。
   *
   * 判据是**有没有名字**：
   *   - 有名字（从列表打开 / 从工具条「打开」）→ 得到归属，保存**覆盖它**；
   *   - 没名字（「+ 新建」送来的空白内容）→ 无归属，保存**新建一份**。
   *
   * ⚠️ **受控渲染期不能改状态**：这是 async 回调（打开成功之后才走到），
   * 不是渲染路径，所以在里面 `setFile` 是安全的。
   *
   * @param doc - 工作流内容（来源不可信，先校验）。
   * @param from - 来源描述（用于提示文字）。
   * @param ownName - 归属名（空串 = 还没有归属，是一份新工作流）。
   */
  const applyWorkflow = useCallback((doc: unknown, from: string, ownName = ''): void => {
    /* 转换走纯函数（可单测）。它同时修掉了「编组存档往返丢失」这个既有缺陷 ——
     * 详见 workflow-doc.ts 顶部的说明。 */
    const restored = fromWorkflowDoc(doc, defs, () => GROUP_DEF)
    if (restored === null) {
      notify(from + '：内容不是一份工作流（缺少节点清单）', 'error')
      return
    }
    recordHistory()
    const nextNodes: V1Node[] = restored.nodes.map(r => {
      const isGroup = r.type === 'group'
      const data: Record<string, unknown> = {
        def: r.data.def,
        state: 'idle' as NodeState,
        params: r.data.params,
        onError: r.data.onError as OnError,
        skipped: r.data.skipped,
        /* 分组框的标题沿用旧字段名（渲染器读 groupLabel）。 */
        ...isGroup
          ? { groupLabel: r.data.label ?? '分组' }
          : r.data.label === undefined ? {} : { label: r.data.label },
        ...r.data.note === undefined ? {} : { note: r.data.note },
      }
      /* 成员归属（契约 CE）：读回来的 `groupId` 必须带上，否则「打开一次组就散了」。 */
      if (r.data.groupId !== undefined && r.data.groupId !== '') data.groupId = r.data.groupId
      return {
        id: r.id,
        /* 分组框要回到 'group' 类型（它的渲染器不同）；其余都是 'v1'。 */
        type: (isGroup ? 'group' : 'v1') as 'v1',
        position: r.position,
        ...r.parentId === undefined ? {} : { parentId: r.parentId },
        /* 框的宽高是用户拉开过的尺寸，必须带回来（否则每次打开都回到默认大小）。 */
        ...isGroup && r.width !== undefined ? { width: r.width } : {},
        ...isGroup && r.height !== undefined ? { height: r.height } : {},
        /* 组画在成员底下（同 `zIndex` 时 React Flow 看数组顺序，读回来的顺序已保证组在前）。 */
        ...isGroup ? { zIndex: 0 } : {},
        data,
        selected: false,
      } as V1Node
    })
    const nextEdges: Edge[] = restored.edges
    /* ⚠️ 读回时**也要同步第二层**：旧存档里的浏览器节点可能没有
     * `launcher` / `exePath`（它们是新加的字段），不同步的话
     * 那些节点会带着默认值跑，而不是按用户在设置里配的标签。
     * 幂等，所以对已有正确值的存档无影响。 */
    const syncedNodes = syncBrowserLayer(nextNodes)
    /* 换了一整张图 → 让位记账本失效，清掉（见 clearShift）。 */
    clearShift()
    /* 缺依赖的节点按清单标 `missing`（票 22）。
     * 放在这里而不是每个入口各写一遍：打开存档、恢复快照、撤销都走这条路，
     * 一处标上三处都成立。 `markMissingDeps` 只动 idle / missing，别的不碰。 */
    setNodes(markMissingDeps(syncedNodes))
    setEdges(nextEdges)
    /* 编组：**没有独立名单要读了**（契约 CE）。组就是 `syncedNodes` 里的一项，
     * 成员归属在 `data.groupId` 上 —— 上面那次 map 已经把两者都接上了。 */
    setSelected(null)
    /* ── 归属（2026-10-14 加）：记下「现在编辑的是哪份文件」──
     *
     * 这一步就是用户要的「每次打开的画布都应该是个有文件归属的」。
     * 指纹也跟着重算：刚打开的内容与磁盘上那份**一致**，所以不该显示「未保存」。
     *
     * ⚠️ 两处都踩过（`bundle-identifiers` 的断言当场抓到）：
     *   1. **要用 `syncedNodes`，不是 `nextNodes`** —— 同步第二层会给浏览器节点
     *      补上 `launcher` / `exePath`，拿同步前的数组算指纹，打开完立刻就是「未保存」。
     *   2. **名字要用 `ownName`** —— 加载后 `dirty` 是拿现在的 `file.name` 去算的，
     *      两者不一致同样一打开就报未保存。 */
    setFile({ name: ownName, isNew: ownName === '' })
    /* 说明：读出来拿着，保存时原样写回去（F1 的修法，见那个 state 的说明）。 */
    setDescription(restored.description)
    setTypes(restored.types)
    /* 编号（2026-10-19）：同样读出来拿着、保存时写回去。老存档这里是空串，
     * 第一次保存时由宿主半补一个并把结果回传（见 `writeFile`）。 */
    setWfId(restored.id)
    setSavedFp(docFingerprint(toWorkflowDocOf(
      syncedNodes, nextEdges, ownName, [], restored.description, restored.types, restored.id,
    )))
    const groupNote = restored.nodes.some(n => n.type === 'group')
      ? '、' + String(restored.nodes.filter(n => n.type === 'group').length) + ' 个分组'
      : ''
    const missingTypes = restored.missingTypes
    if (missingTypes.length > 0) {
      notify(from + '：已加载 ' + String(nextNodes.length) + ' 个节点' + groupNote
        + '，但缺 ' + String(missingTypes.length) + ' 种节点类型（' + [...new Set(missingTypes)].join('、') + '）', 'warn')
    } else {
      notify(from + '：已加载 ' + String(nextNodes.length) + ' 个节点、' + String(nextEdges.length) + ' 条连线' + groupNote, 'ok')
    }
    window.setTimeout(() => { flowToScreenApi.current?.fitView({ padding: 0.22 }) }, 60)
  }, [notify, recordHistory, setNodes, setEdges, clearShift])

  /**
   * 接住「从工作流列表点开的那一份」。
   *
   * 两个触发点：① 本组件刚挂载时（从列表切过来会重新挂载）；
   * ② 已经挂在画布上时列表又送来一份（此时靠订阅通知）。
   *
   * ⚠️ `p.name` 现在**同时**是提示文字与归属名（原来只用来拼提示）——
   * 列表送来的一定是一份已存的工作流，所以归属名就是它。
   */
  useEffect(() => {
    const take = (): void => {
      const p = takePending()
      if (p === null) return
      applyWorkflow(p.doc, '打开 ' + p.name, p.name)
    }
    take()
    return onPending(take)
  }, [applyWorkflow])


  return (
    <div
      className={css_canvas_tokens.wrap}
      ref={wrapRef}
      /* 两个可调尺度都通过 CSS 变量下发（节点靠继承拿到）。
       * 值一变，节点的 ResizeObserver 会自动通知 React Flow 重测量，
       * 所以连线的端点会跟着走到新位置，不用手动 updateNodeInternals。 */
      style={{
        '--ewb-node-w': String(nodeW) + 'px',
        '--ewb-editor-h': String(editorH) + 'px',
        /* 画布底：不透明时直接用语义层的底色（与老行为逐像素一致），
         * 调低时按百分比与「透明」混合 —— 见 `.canvas` 的注释。 */
        /* ★ 票 59：参考线的不透明度也走变量（原来写死 `opacity: 0.7`）。 */
        '--ewb-guide-opacity': String((canvasPrefs.guideOpacity ?? 70) / 100),
        '--ewb-canvas-bg': canvasBg >= 100
          ? 'var(--v1-bg)'
          : 'color-mix(in oklab, var(--v1-bg) ' + String(canvasBg) + '%, transparent)',
      } as CSSProperties}
    >
      {/* ── 顶部工具条 ──────────────────────────────────────
       * 精简原则（用户 2026-10-08 要求）：
       *   1 运行/停止合成**一个状态按钮**（没跑时显示「运行」，跑着显示「停止」）
       *   2 自动布局 / 缩放适配**移到画布右上角**（属画布内操作）
       *   3 只保留真正全局的几个：运行状态按钮、保存、撤销重做
       *
       * 第 2 轮精简（用户 2026-10-11）：「顶部栏的功能按钮太多了，太占空间」。删掉：
       *   - **单步** —— 只删按钮，`stepOnce` **留着**（用户：「功能保留，放在右键菜单中」）
       *   - **导入** —— 整个功能删掉（用户：「有打开功能就行了」）。
       *     二者确实是两件事（导入=任选一个 .json 文件，打开=从已存列表里挑），
       *     但用户认为前者可省，所以连同 `importFromFile` 一起删了。
       *   - **跳过选中** —— 只删按钮，`toggleSkipSelected` **留着**（同上，改挂右键菜单）
       * 并把「帮助」改名为「设置」（那个抽屉现在主要是设置）。
       *
       * ⚠️ 删按钮时**区分「只删按钮」与「连功能一起删」**——
       * 单步与跳过是前者（功能等右键菜单接），导入是后者。别一律删光。
       * 待接的功能见 `plans/2026-10-11-右键菜单与分组.md`。 */}
      {/* ── 旧的外置工具条**已删**（票 54，用户 2026-10-29 甲 1）────────
       *
       * 它原来就在这里：`.canvas` **外面**的一整行，`flex: 0 0 auto` +
       * `border-bottom` + 背景，吃掉画布上方一条高度。
       * 用户原话：「两边都不要顶部栏，顶部在画布中悬浮」。
       *
       * 现在整条搬进下面 `<div className={css_workflow_canvas.canvas}>` 里，
       * 变成 `absolute left:0 right:0 top:0` 的悬浮条（`CanvasTopBar`，与内容画布共用一份零件）。
       *
       * ## 这一轮的去向（**只搬位置，一颗按钮都没删**）
       *
       * | 原按钮 | 去哪 |
       * |---|---|
       * | 归属胶囊（名称 + `· 未保存`） | 悬浮条**左组** |
       * | 引擎状态点（`engineDot` / `engineText`） | **删掉**（用户：「画布中不需要出现」） |
       * | 运行 / 停止 | 悬浮条右组（票 55 会搬到底部主操作位） |
       * | 新建 / 打开 / 另存为 / 保存 | 悬浮条右组（票 63 会删前三颗，归工作流管理） |
       * | 快照 / 恢复 | 悬浮条右组 |
       * | 撤销 / 重做 | 悬浮条右组（票 55 会搬到底部） |
       * | 锁定 / 设置 | 悬浮条右组 |
       * | 小地图 / 图例 | 悬浮条右组（票 56 会把小地图开关搬去右下角） |
       * | 主题色切换 | **新增**（用户甲 4） |
       *
       * ⚠️ **为什么只搬不删**：票 63 要「删掉新建、打开、另存为三颗」、
       * 票 55 要把「运行/停止」搬到底部。本票先把它们删掉的话，
       * 54 到 55 之间画布**不能跑、不能存**（真实功能回退），
       * 而且票 63 会变成空票（要删的已经没了）。
       * 所以这一票的边界是**换位置**，删减留给各自那两张票。
       *
       * ⚠️ 引擎状态那一段是**真删**（票面判据 + lead 2026-10-29 明确要求）：
       * `engineDot` / `engineText` 那两个 span 连同它们的 `title` 一起删掉。
       * 左侧栏底部那行「引擎就绪」是写死的，**不归本票管、也不许顺手接真状态**。
       * 那个「按工具条宽度隐按钮」的老机制（宽度分档属性三档 + 四档 `@container`）
       * **票 55 已整段删除** —— 理由见 `.toolbar` 那条 CSS 的「窄屏」一节。 */}

      {/* ── 连线颜色图例（可隐藏）── */}
      {legend && (
        <div className={css_workflow_canvas.legend}>
          <span className={css_workflow_canvas.legendTitle}>端口 / 连线颜色</span>
          {(Object.keys(PORT_COLORS) as PortType[]).map((k) => (
            <span key={k} className={css_workflow_canvas.legendItem}>
              <i className={css_workflow_canvas.legendDot} style={{ background: PORT_COLORS[k] }} />
              {PORT_TYPE_LABEL[k]}
            </span>
          ))}
          <span className={css_workflow_canvas.legendNote}>连线颜色跟随「源端口」的颜色</span>
        </div>
      )}

      <div className={css_node_library.bodyRow}>
        {/* ── 左侧：可折叠节点库 ── */}
        <aside className={libOpen ? css_node_library.lib : css_node_library.lib + ' ' + css_node_library.libCollapsed} style={libOpen ? { width: libW } : undefined}>
          {/* ★ 票 58：头部与内容画布那个侧栏**同一套外壳**（`canvasSide*` 那组类）。
           *
           * ## 用户原话
           *
           * 「现在两边都不要顶部栏，顶部在画布中悬浮，统一两边 tab 条样式。
           * 条目可以不强行一致，比如执行画布有标签，内容画布没有，但都有标题+说明。
           * 外观上应该近似。」
           *
           * ## 这一处改了什么
           *
           * | | 改前 | 改后 |
           * |---|---|---|
           * | 头部容器 | `node-library` 自己的 `libHead` | 共用的 `canvasSideTabs` 那套 |
           * | 折叠按钮 | 字符 `‹ / ›` | **SVG**（`ChevronLeftIcon` / `ChevronRightIcon`） |
           * | 标题 | `libTitle` | 与内容画布同档 |
           *
           * ⚠️ **按钮文字清空**（判据 5：`textContent` 为空）——
           * 说明进 `title`，不占地方。 */}
          <div className={css.canvasSideTabs} role="tablist" data-ewb-lib-tabs="">
            {libOpen && <span className={css.canvasSidePanelTitle} data-ewb-lib-title="">节点库</span>}
            <span className="flex-1" />
            <button
              type="button"
              className={css.canvasSideIconBtn}
              data-ewb-lib-toggle=""
              title={libOpen ? '折叠节点库' : '展开节点库'}
              onClick={() => { setLibOpen(o => !o) }}
            >{libOpen ? <ChevronLeftIcon size={13} /> : <ChevronRightIcon size={13} />}</button>
          </div>
          {libOpen && (
            <div className={css_node_library.libSearch}>
              <input
                type="search"
                className={css_node_library.libSearchInput}
                placeholder="搜索节点…"
                value={libQuery}
                onChange={e => { setLibQuery(e.target.value) }}
                aria-label="搜索节点"
              />
              {libQuery !== '' && (
                <button type="button" className={css_node_library.libSearchClear} title="清空搜索" onClick={() => { setLibQuery('') }}>×</button>
              )}
            </div>
          )}
          {libOpen && (
            <>
              <div className={css_node_library.libList}>
                {libByCat.map(({ cat, defs }) => {
                  const open = openCats[cat.id] !== false
                  return (
                    <div key={cat.id} className={css_node_library.catBlock}>
                      <button
                        type="button"
                        className={css_node_library.catHead}
                        onClick={() => { setOpenCats(s => ({ ...s, [cat.id]: !open })) }}
                      >
                        <span className={css_node_library.catCaret}>{open ? '▾' : '▸'}</span>
                        <span className={css_node_library.catName}>{cat.label}</span>
                        <span className={css_node_library.catCount}>{defs.length}</span>
                      </button>
                      {open && defs.map(d => (
                        <div
                          key={d.id}
                          className={css_node_library.libItem}
                          draggable
                          title={'拖到画布，或单击添加：' + d.id}
                          onDragStart={e => { e.dataTransfer.setData('application/v1-node', d.id); e.dataTransfer.effectAllowed = 'move' }}
                          onClick={() => { addNode(d) }}
                        >
                          <div className={css_node_library.libItemTop}>
                            <span className={css_node_library.libExec}>{d.executor}</span>
                            <span className={css_node_library.libName}>{d.label}</span>
                          </div>
                          {d.summary !== undefined && <div className={css_node_library.libDesc}>{d.summary}</div>}
                        </div>
                      ))}
                    </div>
                  )
                })}
              </div>
              {libByCat.length === 0 && (
                <div className={css_node_library.libEmpty}>没有匹配「{libQuery}」的节点</div>
              )}
              <div className={css_node_library.libHint}>拖进画布，或单击直接添加</div>
            </>
          )}
        </aside>

        {/* 节点库右边缘的拖宽把手（只有展开时可拖） */}
        {libOpen && (
          <div
            className={css_node_library.libResizer}
            role="separator"
            aria-orientation="vertical"
            aria-label="拖拽调整节点库宽度"
            title="拖拽调整节点库宽度（双击复位）"
            onPointerDown={onLibDragDown}
            onPointerMove={onLibDragMove}
            onPointerUp={onLibDragUp}
            onPointerCancel={onLibDragUp}
            onDoubleClick={() => { setLibW(LIB_W_DEFAULT); persistLibW(LIB_W_DEFAULT) }}
          />
        )}

        {/* ── 中间：画布 ── */}
        <div className={css_workflow_canvas.canvas} onDrop={onDrop} onDragOver={e => { e.preventDefault() }}>
          {/* ══ 顶部悬浮条（票 54，用户 2026-10-29 甲 1、2、3、4、8）═══════════
           *
           * ## 为什么挂在这里
           *
           * `.canvas` 是**画布本体**（`position: relative`，撑满剩余宽高）。
           * 悬浮条挂在它里面 = 祖先链里有画布容器 → 浮在画布之上、随画布区缩放。
           * 挂在外面（改之前）就是「画布上方另一行」。
           *
           * ## 左右分工（甲 2、8）
           *
           * 左：侧栏开关 · 画布名称（+ 未保存标记）· 保存态
           * 右：文件类 · 撤销 · 重做 · 锁定 · 小地图 · 图例 · 设置 · 主题色
           *
           * ## 只留图标（甲 3）
           *
           * 每颗按钮只有 SVG，说明进 `title`。图标全部取自 `icons.tsx`。
           *
           * ## 「按宽度隐按钮」那套机制已删（票 55）
           *
           * 票 54 当时保留了「宽度分档属性」三档与四档 `@container` ——
           * 它守的是「窗口很宽、右侧栏拖窄时收按钮」。但票 54 之后悬浮条宽度
           * = 画布宽度，语义已经不对。**票 55 整段删掉**，换成：
           *   · 顶部条：排不下就换行（`flex-wrap: wrap` 在基础规则里）
           *   · 底部主操作位：按 `data-collapse` 三档依次少显示 */}
          <CanvasTopBar
            kind="workflow"
            left={(
              <>
                {/* 侧栏（节点库）开关：原来在工具条最左边那颗。 */}
                <TopBarButton
                  action="side"
                  title={libOpen ? '收起节点库' : '展开节点库'}
                  on={libOpen}
                  onClick={() => { setLibOpen(o => !o) }}
                ><PanelLeftIcon /></TopBarButton>
                {/* 归属胶囊：名称 + `· 未保存`。
                 *
                 * ⚠️ 它**不是按钮**（点它没有动作），所以不用 `TopBarButton`；
                 * 但它必须 `pointer-events: auto`（父组是 none），
                 * 否则 `title` 悬浮提示出不来。`.tbChip` 那条 CSS 管这件事。 */}
                <span
                  data-ewb-canvas-name="workflow"
                  className={css_workflow_canvas.tbChip}
                  /* ⚠️ 两句 title 都必须说清「点了保存会怎样」——**覆盖还是新建**。
                   * 这是用户 2026-10-14 那个 bug（保存变成新文件）留下的说明，
                   * 我重写悬浮条时一度把「有归属」那句缩成只剩文件名，等于把说明删了。
                   * `dom-render.mjs` 的 `fileChipOf` 靠 `title` 里有「保存」认这颗胶囊，
                   * 那次回退当场被它抓出来。 */
                  title={file.isNew
                    ? '还没有归属：保存时会存成一份新文件'
                    : '当前编辑的是「' + file.name + '」：保存会覆盖这一份，不新增文件'}
                >
                  {file.isNew ? '未保存的新工作流' : namePreview(file.name)}
                  {dirty && <span className={css_workflow_canvas.tbChipHot}>· 未保存</span>}
                </span>
                {/* 保存态：只有「正在存 / 存失败」时说话。
                 *
                 * 「已保存」不显示 —— 一直挂一句「已保存」是噪音，
                 * 用户只在**出问题**时需要知道。保存成功本身有 `notify` 提示。
                 * 这与内容画布那侧的三态**有意不同**：那边原本就有 `saveState`
                 * 三态（票面判据 4 要求渲染「已保存」），这边原本没有状态机。 */}
                {saving
                  ? <span data-ewb-canvas-save="saving" className={css_workflow_canvas.tbHint}>保存中…</span>
                  : null}
              </>
            )}
            right={(
              <>
                {/* ── 文件类 ──
                 *
                 * ## 票 63（2026-10-29）：新建 / 另存为 / 打开**三颗已删**
                 *
                 * 用户原话（定案己组 26、27）：
                 *
                 * > 执行画布去掉新建、打开、另存为按钮，同内容画布一个逻辑，
                 * > 新建打开操作在工作流管理中执行。画布中就专注当前执行的内容即可。
                 *
                 * ## 能力没丢，只是换了地方
                 *
                 * | 原按钮 | 现在在哪 |
                 * |---|---|
                 * | 新建 | 工作流管理的「+ 新建」（`WorkflowList.tsx`） |
                 * | 打开 | 工作流管理的「打开到画布」/「打开目录」 |
                 * | 另存为 | **没有单独入口了** —— 见下面那句说明 |
                 *
                 * ## ⚠️ 「另存为」是真的没有了，不是搬走
                 *
                 * 它原来是 `saveAs`：另起一个名字写**新文件**，原文件不动。
                 * 工作流管理里没有这个动作（那边是「新建一份 → 在新画布上编辑 → 保存」，
                 * 同样达到「不动原来那份」的目的，只是多一步清空画布）。
                 *
                 * 所以 `saveAs` 函数连同按钮一起删了 —— 它没有别的调用点（票 63 核过）。
                 * 想留副本的用户路径：工作流管理新建一份 → 从那边打开 → 复制节点过去。
                 *
                 * ## 「⇩ 保存」保留
                 *
                 * 用户只说要删那三颗，保存是他每天要用的。它的语义没变：
                 * 没有归属时存成新文件，有归属时覆盖自己那份。 */}
                <TopBarButton
                  action="save"
                  title={file.isNew ? '存成一份新文件（还没有归属）' : '覆盖「' + file.name + '」（不新增文件）'}
                  legacy={{ 'data-ewb-save': '' }}
                  onClick={save}
                ><SaveIcon /></TopBarButton>
                <TopBarButton
                  action="snap"
                  title="把当前画布存一份版本快照（改坏了可以退回来）"
                  onClick={() => {
                    /* 快照名跟着归属走（原来恒为「当前工作流」）——
                     * 归属是同一份文件的概念，快照挂在同一份文件下才找得回来。 */
                    const snapName = file.isNew ? LEGACY_SNAP_DIR : file.name
                    void (async () => {
                      const r = await saveSnapshot(snapName, toWorkflowDoc(snapName))
                      if (r.ok) notify('已存版本快照 ' + (r.snap ?? ''), 'ok')
                      else notify('存快照失败：' + (r.error ?? '未知原因'), 'error')
                    })()
                  }}
                ><CameraIcon /></TopBarButton>
                <TopBarButton
                  action="restore"
                  title="从之前的某个版本快照恢复"
                  onClick={() => {
                    const snapName = file.isNew ? LEGACY_SNAP_DIR : file.name
                    void (async () => {
                      /* ── 找哪一批快照（含老目录兜底）─────────────────────────
                       *
                       * 规则提在 `snapshot-lookup.ts` 的 `resolveSnapLookup` 里 ——
                       * **为了能测**：那个文件是纯函数、没有 `.module.css` 依赖，
                       * 所以 node 测试 import 的是**同一份**实现。
                       * （写在按钮闭包里就测不到，只能在测试里抄一遍规则 —— 那是假绿。）
                       * 为什么需要兜底、为什么不做迁移，见那个文件的顶部长注释。 */
                      const look = await resolveSnapLookup(snapName, listSnapshots)
                      if (look.error !== undefined) {
                        notify('读不到快照列表：' + look.error, 'error')
                        return
                      }
                      if (look.snaps.length === 0) { notify('还没有存过快照（点快照按钮存一份）', 'warn'); return }
                      /* 说清来源：让用户知道这些是**改版前**存的、**不一定属于当前这份**。
                       * 不说的话他会以为「这版工作流本来就有这些快照」，然后恢复一份别的流。 */
                      const notice = legacySnapNotice(look)
                      const pick = window.prompt((notice === '' ? '' : notice + '\n') + '恢复到哪一版？\n'
                        + look.snaps.map((x, k) => String(k + 1) + '. ' + x).join('\n'), '1')
                      if (pick === null) return
                      const name = look.snaps[Number(pick) - 1]
                      if (name === undefined) { notify('没有第 ' + pick + ' 版', 'warn'); return }
                      /* ⚠️ 用 `look.dir`（**实际列出快照的那个目录**）去读，不能 `snapName` ——
                       * 兜底时两者不同，用错必然报「没有这份快照」。 */
                      const got = await loadSnapshot(look.dir, name)
                      if (!got.ok) { notify('读快照失败：' + (got.error ?? '未知原因'), 'error'); return }
                      /* ⚠️ 恢复快照**不改归属**：它恢复的还是同一份文件的内容。
                       * 所以把当前的归属名传进去（不是快照名 —— 那是时间戳）。 */
                      applyWorkflow(got.doc, '恢复到 ' + name, file.isNew ? '' : file.name)
                    })()
                  }}
                ><HistoryIcon /></TopBarButton>
                <TopBarDivider />
                {/* ── 锁定（锁上后所有编辑动作都不生效，防误改）──
                 *
                 * ⚠️ 「撤销 / 重做」**已搬到下面那个底部主操作位**
                 * （票 55，用户甲 7「回撤也按照参考来」）。 */}
                <TopBarButton
                  action="lock"
                  title={locked ? '画布已锁定（只读）。点一下解锁才能编辑' : '锁定画布，防止误拖动/误删（再点一下解锁）'}
                  on={locked}
                  hot={locked}
                  onClick={() => {
                    const next = !locked
                    setLocked(next)
                    try { localStorage.setItem('ewb.locked', next ? '1' : '0') } catch { /* 忽略 */ }
                    notify(next ? '画布已锁定（只读）' : '已解锁，可以编辑了', next ? 'warn' : 'ok')
                  }}
                >{locked ? <LockIcon /> : <UnlockIcon />}</TopBarButton>
                {/* ⚠️ 小地图开关**已搬进右下角那一排**（票 56，用户丙 26：
                 * 「开关都进右下角那一组」）。两处都给会变成「同一个开关两个入口」，
                 * 而它们的显示状态可能不同步 —— 用户会看到一处亮一处灭。 */}
                {/* ── 图例（连线颜色说明）── */}
                <TopBarButton
                  action="legend"
                  title="显示/隐藏连线颜色说明"
                  on={legend}
                  onClick={() => {
                    const next = !legend
                    setLegend(next)
                    prefsTouched.current.legend = true
                    /* `saveUiPrefs` **自己就会写缓存**，所以这里不再单独 setItem ——
                     * 两处各写一遍迟早会漂（一处改了另一处忘改）。 */
                    void saveUiPrefs({ legend: next }).then(r => {
                      if (r.ok && r.prefs !== undefined) adoptUiPrefs(r.prefs)
                    })
                  }}
                ><PaletteIcon /></TopBarButton>
                {/* ── 设置（用户甲 8：去右上角，两边统一）── */}
                <TopBarButton
                  action="settings"
                  title="画布设置（节点宽度、节点展开高度）与快捷键说明"
                  on={drawerOpen}
                  onClick={() => { setDrawerOpen(o => !o) }}
                ><SettingsIcon /></TopBarButton>
                {/* ── 主题色切换（用户甲 4）──
                 * 只切**画布自己的明暗**，不碰 dsh 主题。
                 * `title` 说「点了会变成什么」（按钮是动作）。 */}
                <TopBarButton
                  action="theme"
                  title={darkNow ? '画布切到浅色' : '画布切到深色'}
                  on={workflowTheme !== null}
                  onClick={toggleWorkflowTheme}
                >{darkNow ? <MoonIcon /> : <SunIcon />}</TopBarButton>
              </>
            )}
          />

          {/* ══ 底部主操作位（票 55，用户 2026-10-29 甲 5、6 与戊 22）══════════════
           *
           * ## 用户原话
           *
           * > 主操作放底部中间悬浮，也就是用参考的模式。注意，内容画布的节点按钮
           * > 就是执行画布的开始停止等执行按钮一个级别的。二者逻辑不一样但定位相同。
           *
           * ## 为什么它也挂在 `.canvas` 里
           *
           * 与顶部条同一个理由：浮层要在**画布中**（用户丁 18「浮层在画布中，
           * 不是单独一条压在画布上面」）。所以 `absolute bottom: 20px` 的基准
           * 就是这个 `.canvas` —— 天然相对画布区居中。
           *
           * ## 模式切换按钮为什么在这里而不是顶部
           *
           * 用户甲 7 把「点击切换鼠标模式」与「回撤」并列说的，两者都是**动作**；
           * 而顶部条是「这一份是什么 + 设置类」。票面也写明底部条左段就是它。 */}
          <CanvasDock
            kind="workflow"
            mode={(
              /* 一个按钮两态：图标随态变。
               * 框选（`select`）用 `BoxSelectIcon`、移动（`pan`）用 `ArrowRightIcon`
               * —— `icons.tsx` 里没有手形/指针图标，这两个是最接近的语义。 */
              <DockButton
                action="mode"
                title={dockMode === 'select' ? '现在是框选，点一下切成移动' : '现在是移动，点一下切成框选'}
                on={dockMode === 'pan'}
                onClick={() => { setDockMode(toggleMode(dockMode)) }}
              >{dockMode === 'select' ? <BoxSelectIcon /> : <ArrowRightIcon />}</DockButton>
            )}
            history={(
              <>
                <DockButton
                  action="undo"
                  title={histDepth.past === 0 ? '没有可撤销的操作' : '撤销（Ctrl+Z），可撤销 ' + String(histDepth.past) + ' 步'}
                  disabled={histDepth.past === 0}
                  collapse={3}
                  onClick={doUndo}
                ><UndoIcon /></DockButton>
                <DockButton
                  action="redo"
                  title={histDepth.future === 0 ? '没有可重做的操作' : '重做（Ctrl+Y）'}
                  disabled={histDepth.future === 0}
                  collapse={3}
                  onClick={doRedo}
                ><RedoIcon /></DockButton>
              </>
            )}
            main={(
              /* 主操作：一个按钮两态（没跑时「运行」、跑着「停止」）。
               * 它**常驻**（不参与窄屏少显示）—— 它就是这个画布的主操作。 */
              <DockButton
                action="run"
                title={running ? '停止当前运行' : '从头跑整条工作流'}
                on={running}
                primary={!running}
                danger={running}
                onClick={running ? stopRun : runAll}
              >{running ? <StopIcon /> : <PlayIcon />}</DockButton>
            )}
          />

          <NoticeBar notices={notices} onDismiss={dismiss} />
          <SettingsDrawer
            open={drawerOpen}
            onClose={() => { setDrawerOpen(false) }}
            nodeW={nodeW}
            onNodeW={changeNodeW}
            canvasBg={canvasBg}
            onCanvasBg={changeCanvasBg}
            editorH={editorH}
            onEditorH={changeEditorH}
            spacing={effectiveSpacing}
            spacingAuto={layoutSpacing === null}
            onSpacing={changeLayoutSpacing}
            panelH={panelH}
            onPanelH={changePanelH}
            onReset={resetAllSettings}
            /* ★ 票 59：背景三档 + 三个透明度（与内容画布同一份 `CanvasPrefs`）。 */
            prefs={canvasPrefs}
            onPrefs={applyCanvasPrefs}
          />
          <ContextMenu menu={menu} onClose={closeMenu} />
          <ReactFlow
            nodes={shownNodes}
            edges={shownEdges}
            nodeTypes={NODE_TYPES}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            /* 锁定＝只读：一次性关掉这些交互（与 Langflow 的 effectiveLocked 同思路） */
            nodesDraggable={!locked}
            nodesConnectable={!locked}
            elementsSelectable={!locked}
            edgesReconnectable={!locked}
            onConnect={locked ? undefined : onConnect}
            /* React Flow 的内部报错（如「容器尺寸为 0」）默认只进控制台，用户看不到。
             * 转成提示条说出来——排查「画布空白」时这是第一手线索。
             *
             * ⚠️ **必须是稳定引用**（2026-10-21 修的真 BUG，React #185）：
             * React Flow 的 `StoreUpdater` 把 `onError` 列在 `fieldsToTrack` 里，
             * 它的 effect 依赖就是这一串 props。原来这里是**内联箭头函数**
             * → 每次渲染都是新引用 → effect 重跑 → `store.setState({onError})`
             * → 订阅者重渲染 → …→「更新深度超限」（#185），表现为整块画布白屏。
             *
             * 判据：`fieldsToTrack` 里的每一个 prop 都必须是**稳定引用**。
             * 这份清单在 `@xyflow/react` 的 `StoreUpdater` 里（`nodes` 之后那一长串），
             * 改这一带代码前先对着它数一遍。 */
            onError={onFlowError}
            /* 拖拽时就判定能不能连（不合法显示禁止光标） */
            isValidConnection={onIsValidConnection}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            /* 允许拖端点重连（改连线目标，不用删了重画） */
            onReconnect={onReconnect}
            /* 右键点连线 → 直接删（比「先选中再按退格」好用） */
            onEdgeContextMenu={onEdgeContextMenu}
            /* 右键菜单：节点 / 选中的一批 / 分组框 / 空白，四种上下文（见 onNodeContextMenu） */
            onNodeContextMenu={onNodeContextMenu}
            onPaneContextMenu={onPaneContextMenu}
            onSelectionContextMenu={onSelectionContextMenu}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            onNodeDrag={onNodeDrag}
            onNodeDragStart={onNodeDragStart}
            onNodeDragStop={onNodeDragStop}
            onMove={onMove}
            /* 存下 React Flow 实例：拖入落位（screenToFlowPosition）与缩放适配（fitView）都用它 */
            onInit={inst => { flowToScreenApi.current = inst as unknown as typeof flowToScreenApi.current }}
            /* 跟随 dsh 主题（原来写死 "dark"，导致画布永远深色）。 */
            colorMode={dark ? 'dark' : 'light'}
            proOptions={{ hideAttribution: true }}
            /* 关掉内置删除键：它绕过我们自己的删除函数，**导致删了节点不进撤销栈**
             * （按 Ctrl+Z 回不来）。删除改由下面的键盘处理接管，走 deleteSelected。 */
            deleteKeyCode={null}
            /* ── 选择键统一成 Ctrl（用户 2026-10-11 要求）──────────────────
             *
             * 用户原话：「按住 ctrl 的时候进入选择模式（当前是 shift 框选 ctrl 点选，
             * 没必要，都同样成 ctrl），点击左键不再拖动画布，
             * 可以执行框选 + 单个点击添加/排除多选。」
             *
             * 所以把 `selectionKeyCode` 从 `Shift` 改成 **Ctrl**，与多选键同一个：
             *   - 按住 Ctrl + 拖左键 → **框选**（不再拖动画布）
             *   - 按住 Ctrl + 点节点 → **加选 / 减选**
             * 一个键同时管两件事，比原来 Shift 框选 / Ctrl 点选两套好记。
             *
             * ⚠️ 「按住时左键不拖动画布」**不用自己写** —— React Flow 内部就是
             * `panOnDrag: !selectionKeyPressed && panOnDrag`（源码 `index.js` 的 FlowRenderer），
             * 按住选择键时它自己会把平移关掉。这正是选「配置」而不是「自己写事件」的原因。 */
            /* ★ 票 55：`panOnDrag` / `selectionOnDrag` 改由**底部那个模式按钮**决定。
             * 用与内容画布**同一个纯函数**（`modeToProps`），两边语义不可能分叉。
             *
             * ⚠️ `selectionKeyCode="Control"` **保留** —— 它是「按住临时切」，
             * 与常驻模式是两件事（用户戊 25：「空格与 Ctrl 都能临时切换左键功能」）。 */
            {...modeToProps(dockMode)}
            panOnScroll={false}
            /* ★ 票 61（2026-10-29）：临时切换键**空格与 Ctrl 都认**
             * （用户戊 25：「空格和 ctrl 都可以临时切换左键功能」）。
             *
             * React Flow 的 `selectionKeyCode` 收的是 `KeyCode`
             * （`string | Array<string>`，见 `@xyflow/system` 的
             * `types/general.d.ts:178`），所以可以直接给数组。
             *
             * ⚠️ 空格要写 `'Space'` **不是** `' '`：React Flow 的 `useKeyOrCode`
             * （`node_modules/@xyflow/react/dist/esm/index.mjs:500-502`）判的是
             * 「`keysToWatch` 里有没有这个 `event.code`」——`event.code` 对空格是
             * `'Space'`，写 `' '` 永远匹配不上。
             *
             * ⚠️ 与内容画布的差别：那边空格走它自己的 keydown（要处理
             * `e.repeat` 与 restore 两道闸，票 35 的真机 bug），这里交给
             * React Flow 内部 —— 它按 `keydown/keyup` 的配对自动复位，
             * 没有「切不回去」那类问题，不需要再加闸。 */
            selectionKeyCode={['Control', 'Space']}
            selectionMode={SelectionMode.Partial}
            multiSelectionKeyCode={['Meta', 'Control']}
            fitView
          >
            {/* ── 右上角那一块**已删**（票 56）────────────────────────────
             *
             * 它原来装两样：
             *   · 自动排版的**两个方向按钮**（`.layoutGroup`）
             *   · 「⤢ 缩放适配」一颗（`.canvasToolBtn`）
             *
             * 现在两样都在**右下角那一排**（用户丙 13：执行画布多一颗自动排版，
             * 点名不许遗漏；丙 25：缩放适配只留一处，右上角那颗删掉）。
             *
             * 那几段 CSS（`.canvasTools` / `.layoutGroup` / `.layoutBtn` /
             * `.canvasToolBtn`）也随之删了 —— 见 `workflow-canvas.module.css`。
             */}
            {/* 连线不合法的原因提示（拖动时出现） */}
            {connHint !== '' && (
              <Panel position="bottom-center" className={css_workflow_canvas.connHint}>{connHint}</Panel>
            )}

            {/* 网格：点距 22→20、点大小 1→2、颜色改用变量（原有效透明度约 0.14，太淡） */}
            {/* ★ 票 59：背景三档 + 图案透明度（与内容画布同一套字段）。
             *
             * ## 用户原话
             *
             * 「当前内容画布左下角的背景调整进设置中，不单独出现，设置去右上角。
             * 执行画布同理，增加背景设置，且增加透明度设置（参考线、点的透明度）」
             *
             * ## 改前是写死的
             *
             * `<Background variant={Dots} gap={20} size={2} color="var(--grid-color)" />`
             * —— 只有点阵，没法换、也没法调深淡。
             *
             * ## `patternOpacity` 落在 `color` 里
             *
             * React Flow 的 `Background` **没有 `opacity` 参数**（核过类型定义）。
             * 所以透明度做在颜色串里，`patternColorOf` 负责换算 ——
             * 点阵取 `--grid-color`、线格取 `--v1-edge`（与内容画布同一套）。 */}
            {canvasPrefs.grid !== 'none' && (
              <Background
                variant={canvasPrefs.grid === 'lines' ? BackgroundVariant.Lines : BackgroundVariant.Dots}
                gap={canvasPrefs.grid === 'lines' ? 24 : 20}
                size={canvasPrefs.grid === 'lines' ? 1 : 2}
                color={patternColorOf(
                  canvasPrefs.grid === 'lines' ? 'lines' : 'dots',
                  canvasPrefs.patternOpacity ?? 20,
                )}
              />
            )}
            {/* 对齐辅助线：画在画布坐标系里（跟着平移缩放走） */}
            {helperLines.length > 0 && (
              <ViewportPortal>
                {helperLines.map((l, i) => (
                  <div
                    key={i}
                    className={l.type === 'vertical' ? css_workflow_canvas.helperV : css_workflow_canvas.helperH}
                    style={l.type === 'vertical' ? { left: l.position } : { top: l.position }}
                  />
                ))}
              </ViewportPortal>
            )}
            {/* ⚠️ `<Controls>` **已删**（票 56，用户丙 14）。
             * 它是 React Flow 自带的缩放控件、在**左下角**，样式也是它自己的默认样子。
             * 两边现在都用右下角那排自制浮层（同一个组件）——
             * 留两套缩放控件等于「同一件事有两个入口，长得还不一样」。 */}
            {/* 小地图：**可按开关显示**（用户点名的 P3 项）。
             * 上色用**分类色**（与节点顶部色条同一套）——
             * 这样小地图上能同时看出「哪块是什么类型」，而不只是状态。 */}
            {minimapOpen && (
              <MiniMap
                pannable
                zoomable
                maskColor="rgba(6,9,15,0.75)"
                nodeColor={n => CAT_COLOR[(n as { data?: { def?: NodeDef } }).data?.def?.category ?? 'other'] ?? CAT_COLOR.other}
              />
            )}
            {/* 节点计数（票 56：从**左下角**挪到右下角那排**上方**）。
             *
             * ## 为什么挪
             *
             * 用户丙 15：「我们的中间栏应该是画布居中」。左下角一个块 +
             * 右下角一排，视觉上把画布切成两半，中间那一栏没人看得出居中在哪儿。
             *
             * ## 为什么用 `<Panel>` 而不是自己 absolute
             *
             * `<Panel>` 是 React Flow 在**画布变换之外**渲染的层 ——
             * 缩放画布时它不跟着动（它本来就该固定）。
             * `position="bottom-right"` + 一个负的 `marginBottom` 让它落在
             * 右下角那排**上方**，两者是兄弟节点、有间距（判据 8）。
             *
             * ⚠️ 间距不靠 margin 猜：右下角那排高 32（22 按钮 + 上下各 5 padding）
             * + `bottom: 10`，所以计数块离底边至少 50px 就不会叠上。
             * 这里给 48px 的落差（`marginBottom: 44` + 它自己的高度）。 */}
            {/* ══ 右下角浮层（票 56：两边共用同一个组件）══════════════════════
             *
             * ## 为什么挂在 `<ReactFlow>` 里面
             *
             * 它是 `position: absolute` 的浮层，基准应该是**画布区**。
             * 挂在 `<ReactFlow>` 的 children 里，React Flow 会把它渲染在
             * 视口变换**之外**（`<Panel>` 也是这样）—— 所以缩放/平移画布时它不动。
             *
             * ## 与原实现的差别
             *
             * | 原来 | 现在 |
             * |---|---|
             * | React Flow 自带 `<Controls>`（左下、三颗、默认样式） | **删掉**，用这一排 |
             * | 右上角 `<Panel>` 的自动排版 + 「⤢ 缩放适配」 | 并进这一排（前两段） |
             * | 顶部条的 `minimap` 开关 | 并进这一排 |
             * | 撤销步数只在按钮 `title` 里 | 这一排常显一条 |
             *
             * ## `showAutoLayout` 只在这里给 true
             *
             * 用户丙 13：「执行画布多了自动排版，这一点内容画布是不需要的，
             * 这一点不要遗漏了。」内容画布那侧**不传这个 prop** —— 判据 3 的反面断言守它。 */}
            <Panel position="bottom-right" className={css_workflow_canvas.cornerPanel}>
              <CanvasCornerControls
                kind="workflow"
                showAutoLayout
                layoutDir={dir}
                onLayout={runLayout}
                zoom={zoomPct / 100}
                onZoom={(z) => {
                  /* 与内容画布同一套：本地先记一笔（jsdom 里 `zoomTo` 不一定回调
                   * `onMove`，那时百分比永远不动），再让 React Flow 真缩放。 */
                  setZoomPct(Math.round(z * 100))
                  flowToScreenApi.current?.zoomTo?.(z, { duration: 120 })
                }}
                onFit={() => { flowToScreenApi.current?.fitView({ padding: 0.22 }) }}
                miniMap={minimapOpen}
                onToggleMiniMap={() => {
                  const next = !minimapOpen
                  setMinimapOpen(next)
                  try { localStorage.setItem('ewb.minimap', next ? '1' : '0') } catch { /* 忽略 */ }
                }}
                /* 判据 5：撤销步数常显，且与底部条那两颗的 `disabled` 同源
                 * —— 都读这一份 `histDepth`。 */
                undoWhat={histDepth.past === 0 && histDepth.future === 0
                  ? '没有可撤销的操作'
                  : '可撤销 ' + String(histDepth.past) + ' 步 / 可重做 ' + String(histDepth.future) + ' 步'}
              />
            </Panel>

            <Panel position="bottom-right" className={css_workflow_canvas.nodeCountPanel}>
              <div className={css_node_form.chip} data-ewb-node-count="">
                节点 {nodes.length}
                {' / ' + String(shownEdges.length) + ' 连线'}
                {selCount > 0 && <span className={css_node_form.chipHot}>· 选中 {selCount}</span>}
              </div>
            </Panel>
          </ReactFlow>

        </div>
      </div>
    </div>
  )
}
