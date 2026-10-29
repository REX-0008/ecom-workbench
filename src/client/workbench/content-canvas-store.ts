/** 内容画布的**纯逻辑层**：节点形状、结果落位、撤销栈、自动保存、宿主接口包装。
 *
 * ## 为什么把逻辑塞在一个文件里（2026-10-25 契约 AY）
 *
 * 画布本体会引 React Flow，而 React Flow 要真 DOM 才能跑；把「三个节点怎么算」这种
 * 纯计算混进组件里，测试就只能靠「挂上去点一点」来验 —— 那写起来慢、失败时也说不清。
 *
 * 所以这个文件**一行 React 都不 import**，只导出纯函数与几个 fetch 包装。
 * 界面（`ContentCanvas.tsx`）只做「把状态搬进来、把回调接出去」。
 *
 * ## 撤销的语义（这一条必须写清，见计划 §三 3.4）
 *
 * 撤销恢复的是**画布快照**（节点 + 连线 + 视口），它**只动画布文件**，
 * 不碰产物库：
 *
 *   · 画布上的图片节点只记「引用哪个产物 id」，**字节本体在产物库里**；
 *   · 撤销之后画布上那张图没了，但**产物库里那条还在** —— 资产库是主，节点只是引用；
 *   · 所以在撤销这条路径上**不许出现任何删除产物的调用**。
 *
 * 不写清楚，以后有人会觉得「撤销了就顺手把产物也删了吧」—— 那会一次撤销
 * 清掉别的画布上同一个产物，而且不可恢复（产物删是真删文件）。
 */
import {
  captureEnclosedNodesIntoGroup, createGroupFromNodes, findContainingGroupId,
  fitGroupToEnclosedChildren, syncGroupMembershipAfterTransform, ungroupCanvasGroup,
  type GeoNode,
} from './group-geometry.ts'

/* ── 节点形状 ───────────────────────────────────────────────────────── */

/**
 * 内容画布上的节点类型。
 *
 * ## 2026-10-26 契约 CE：多了第六种 `group`
 *
 * 用户 m01076 定「编组按参考项目的模式改」：组是**一个真节点**（有位置宽高、
 * 能选中 / 拖动 / 缩放），不是一份名单。所以它必须是一个节点类型 ——
 * 否则 React Flow 里没有它，也就谈不上拖动与缩放。
 *
 * ⚠️ 与执行画布的**循环框**不是一回事：循环框是 `parentId` 父子容器（成员坐标相对），
 * 组是 `groupId` 归属标记（成员坐标**绝对**）。两套不许混，见 `group-geometry.ts` 文件头。
 */
export type ContentNodeType = 'text' | 'image' | 'video' | 'audio' | 'config' | 'group' | 'batch'

/** 节点上真正存的东西。 */
export interface ContentNodeData {
  /** 文本节点的正文 —— 它是这个节点的**产出**，不是输入参数（用户 m01076 原话）。 */
  text?: string
  /** 图片 / 视频 / 音频节点引用的产物 id（字节在产物库，不在这个文件里）。 */
  artifact?: string
  /** 生成配置：生成什么（图 / 视频）。 */
  genType?: 'image' | 'video'
  /** 用哪个模型（设置面板里填，生成时带走）。 */
  model?: string
  /**
   * 走哪个渠道（契约 CH）。
   *
   * 后端 `pickChannel` 在没指定渠道时会**随便挑一个能做这件事的**；
   * 用户在下拉里选了「某渠道的某模型」之后再让后端去挑，可能挑到另一个渠道
   * —— 而那个渠道里根本没有这个模型，于是报「这个渠道里没有模型 xxx」。
   * 所以选模型时把渠道一起记下来。
   */
  channel?: string
  /** 尺寸（如 `1024x1024`）。 */
  size?: string
  /** 一次几张。 */
  count?: number
  /** 走哪份工作流。 */
  workflow?: string
  /** 提示词（设置面板里填，生成时带走 —— **不是**节点产出）。 */
  prompt?: string
  /** 视频 / 音频的时长（秒）。 */
  seconds?: number
  /** 视频分辨率（如 `1080x1920`）。 */
  resolution?: string
  /** 参考图 / 首帧的产物 id。 */
  reference?: string
  /**
   * 用户给这个节点起的名字（双击标题改的那个）。
   *
   * ⚠️ 它住在 `data` 里，**不在节点顶层** —— `onRename` 走的是 `renameNode`，
   * 那个函数把名字写进 `data.title`。读的时候别去节点顶层找（那永远是空的）。
   */
  title?: string
  /**
   * 这个节点属于哪个组（契约 CE）。
   *
   * ⚠️ 与执行画布循环框的 `parentId` **不是一件事**：
   *   · `parentId` 是父子容器 —— 成员坐标**相对父**，动父成员跟着动；
   *   · `groupId` 只是归属标记 —— 成员坐标**绝对**，动组不带成员（要另算）。
   * 混用会让坐标两套换算打架（执行画布为此踩过三次）。
   */
  groupId?: string
  /**
   * 批量节点的产物 id 列表（用户 m02814 #72-74）。
   *
   * 只在 `type === 'batch'` 上用。为什么不是「N 个独立的图片节点」：
   * 一次生成 4 张，画布上多 4 个节点会把整条链路挤散，而且用户心里它们是
   * **同一批**（同一份提示词、同一个模型）—— 那正是一个批量节点该有的语义。
   */
  items?: string[]
  /**
   * 批量节点对外显示哪一张（`items` 的下标）。
   *
   * 缺省 = 0（第一张）。用户点「设为主图」才改它 ——
   * 这个值决定收起状态下露哪一张，也决定「下载 / 加素材库」默认操作哪张。
   */
  mainIndex?: number
  /**
   * 批量节点是不是展开着（用户 m02814：「展开/收起两种形态」）。
   *
   * ⚠️ 它**要存盘**（不像运行态）：用户把一批摊开看着，切走再切回来发现又收起了，
   * 那是在丢他刚做的动作。运行态（转圈）才不存，那是另一回事。
   */
  expanded?: boolean
}

/** 画布上的一个节点（**存进画布文件的形状**）。 */
export interface ContentNode {
  id: string
  type: ContentNodeType
  position: { x: number, y: number }
  width?: number
  height?: number
  /** 显示名（双击标题改名；空 = 用类型名）。 */
  title?: string
  data: ContentNodeData
}

/** 画布上的一条连线。 */
export interface ContentEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

/** 视口。 */
export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

/** 一份快照（撤销的单位）。 */
export interface CanvasSnapshot {
  nodes: ContentNode[]
  edges: ContentEdge[]
  viewport: CanvasViewport
}

/** 每种节点的默认尺寸。
 *
 * ## 六个数字照参考项目逐类定死（票 34，2026-10-28）
 *
 * 出处：`refs-projects/infinite-canvas/web/src/constant/canvas.ts:13` 的
 * `NODE_DEFAULT_SIZE`：
 *
 * | 类型 | 参考 |
 * |---|---|
 * | Image | 340×240 |
 * | Text | 340×240 |
 * | Config | 340×240 |
 * | Video | 420×236 |
 * | Audio | 340×120 |
 * | Group | 760×480 |
 *
 * ## 为什么改这一版
 *
 * 改之前是「我们自己长出来的那套」（text 260×120、image 320×320、video 320×200、
 * audio 320×96、config 260×210）—— 与参考每一类都不一样，而同类的图片与文本
 * 在参考里是**同一个框**（都 340×240），我们却是两个差很远的框。
 *
 * ⚠️ **只影响新建的节点**：`sizeOf` 读的是 `n.width ?? 默认值`，
 * 已存盘的节点身上有写死的宽高，改这张表不会把它们批量改成新值
 * （这是票面「不许碰已生成的节点尺寸」那条）。
 *
 * ⚠️ `group` 与 `batch` **没动**：参考那张表里 Group 就是 760×480（与原来一致）；
 * `batch` 是我们独有的节点类型，参考没有对应项，保持原样。
 *
 * ⚠️ 别拿这张表的数字去和「图片自身比例」混为一谈：框是这一个尺寸，
 * 图在框里按自己比例 `contain`（`EcomWorkbench.module.css` 的 `.contentMedia`），
 * 两者互不影响 —— 参考也是这么做（`canvas-node-factory.ts:29` 记 `naturalWidth`
 * 只用于显示，不改框）。 */
export const NODE_SIZE: Readonly<Record<ContentNodeType, { width: number, height: number }>> = {
  text: { width: 340, height: 240 },
  image: { width: 340, height: 240 },
  video: { width: 420, height: 236 },
  audio: { width: 340, height: 120 },
  config: { width: 340, height: 240 },
  /* 组的默认尺寸照 `group-geometry.ts` 的「成员为空时给一个默认大小」（760×480）。
   * 真建组时用 `calculateGroupBoundsForNodes` 按成员算，这个默认值只在
   * 「先点『分组』再往里拖」这种还没有成员的顺序下用到。
   * 参考那张表里 Group 也是 760×480，与原来一致，没动。 */
  group: { width: 760, height: 480 },
  /* 批量节点（用户 m02814 #72-74）：收起时就是一张图那么大，展开时由组件自己撑高。
   * 参考项目没有这一类，保持原样（320×320 = 旧图片节点尺寸，视觉上与图片节点一致）。 */
  batch: { width: 320, height: 320 },
}

/** 结果长在右边时的水平间距。 */
export const RESULT_GAP = 48

/** 默认视口。 */
export const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 }

/**
 * 取一个节点的尺寸（没写死时回落到该类型的默认值）。
 * @param n - 节点。
 * @returns 宽高。
 */
export function sizeOf(n: ContentNode): { width: number, height: number } {
  const d = NODE_SIZE[n.type]
  return { width: n.width ?? d.width, height: n.height ?? d.height }
}

/**
 * 这个节点是不是**空占位**（还没有内容）。
 *
 * ## 它决定结果填哪（计划 §三 3.3）
 *
 * 空占位 → 结果填进它自己；已有内容 → 在它右边长一个新节点、原图不动。
 * 生成配置节点**永远不算空占位** —— 它不是内容，它是「要生成什么」，
 * 结果不该盖掉配置。
 *
 * @param n - 节点。
 * @returns 空占位给 true。
 */
export function isEmptyNode(n: ContentNode): boolean {
  /* 组不是内容槽 —— 它是「把几块内容框在一起」的容器（契约 CE）。
   * 不排除的话它会被判成空占位，生成结果会直接盖掉整组。 */
  if (n.type === 'group') return false
  if (n.type === 'config') return false
  if (n.type === 'text') return (n.data.text ?? '').trim() === ''
  return (n.data.artifact ?? '').trim() === ''
}

/**
 * 造一个新节点的 id。
 * @param prefix - 前缀，便于在文件里一眼认出来源。
 * @returns id。
 */
export function newNodeId(prefix: string): string {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6)
}

/**
 * 造一个新节点。
 *
 * ## 尺寸从哪来（2026-10-27 加 `size`）
 *
 * 默认按 `NODE_SIZE[type]`（每种类型不同）。但设置里「新节点宽高」填了**数字**时
 * 要统一成一个值 —— 那个判断在 `nodeSizeFrom()`（`canvas-prefs.ts`）里做，
 * 这里只收一个**已经确定的**尺寸。
 *
 * ⚠️ 为什么不让 `newNode` 自己读设置：它不知道 `null` 是什么意思，
 * 而 `null` 是设置层的概念（= 跟随类型）。分开之后
 * 「改设置会不会影响老节点」也清楚：**只影响新建的**，老节点存着自己的宽高。
 *
 * @param type - 类型。
 * @param position - 左上角坐标。
 * @param data - 初始内容。
 * @param size - 尺寸覆盖（不给就用该类型的默认值）。
 * @returns 节点。
 */
export function newNode(
  type: ContentNodeType,
  position: { x: number, y: number },
  data: ContentNodeData = {},
  size?: { width: number, height: number },
): ContentNode {
  const fallback = NODE_SIZE[type]
  const w = size === undefined ? fallback.width : Math.round(size.width)
  const h = size === undefined ? fallback.height : Math.round(size.height)
  return { id: newNodeId(type), type, position, width: w, height: h, data }
}

/** 一次生成的结果。 */
export interface GeneratedResult {
  /** 产物 id（图 / 视频 / 音频）。 */
  artifact?: string
  /** 文本结果。 */
  text?: string
}

/**
 * 把一次生成的结果放到画布上（**纯函数**，计划 §三 3.3）。
 *
 * 判据只有一条：目标节点空着就填它自己，已经有内容就在右边长一个。
 * 生成配置节点另算 —— 它永远不是「空占位」，结果一定另起一个节点（类型取 `genType`）。
 *
 * @param nodes - 当前节点（不改动入参）。
 * @param targetId - 结果要落到哪个节点上。
 * @param result - 结果。
 * @returns 新节点数组 + 落位方式（`self` / `right` / `none`）+ 实际承载的节点 id。
 */
export function placeResult(
  nodes: readonly ContentNode[],
  targetId: string,
  result: GeneratedResult,
): { nodes: ContentNode[], placed: 'self' | 'right' | 'none', id: string } {
  const i = nodes.findIndex(n => n.id === targetId)
  if (i < 0) return { nodes: [...nodes], placed: 'none', id: '' }
  const target = nodes[i]
  const patch: ContentNodeData = {}
  if (result.artifact !== undefined) patch.artifact = result.artifact
  if (result.text !== undefined) patch.text = result.text

  if (isEmptyNode(target)) {
    const next = [...nodes]
    next[i] = { ...target, data: { ...target.data, ...patch } }
    return { nodes: next, placed: 'self', id: target.id }
  }

  /* 配置节点：结果另起一个「它要生成的那种」节点，配置本身一个字都不改。 */
  const isConfig = target.type === 'config'
  const type: ContentNodeType = isConfig ? (target.data.genType ?? 'image') : target.type
  const size = NODE_SIZE[type]
  const anchor = sizeOf(target)
  const grown = newNode(type, {
    x: target.position.x + anchor.width + RESULT_GAP,
    y: target.position.y,
  }, patch)
  grown.width = size.width
  grown.height = size.height
  return { nodes: [...nodes, grown], placed: 'right', id: grown.id }
}

/* ── 拖放（契约 CJ）────────────────────────────────────────────
 *
 * ## 为什么拖放要有一个纯函数层
 *
 * 拖动本身是 DOM 事件（`dragstart` / `dragover` / `drop`），但**载荷的编码与解析**
 * 是纯逻辑：侧栏放进去的是什么、画布收到之后要造哪种节点。
 * 把它写成纯函数有两个好处：
 *   ① 断言能直接喂数据，不必在 jsdom 里模拟一整套拖拽手势（那个模拟很容易假绿）；
 *   ② 侧栏与画布两边共用同一份编码，不会「放进去一个键、读的是另一个键」。
 *
 * `dataTransfer` 用**自定义 MIME**（`application/x-ewb+json`）而不是 `text/plain`：
 * 拖放目标是画布，而画布上可能有别的组件也在听 `text/plain`
 * （比如从浏览器外拖一张图进来）。用自己的类型就不会互相抢。
 */

/** 拖放的 MIME（见上面那段说明）。 */
export const DRAG_MIME = 'application/x-ewb+json'

/** 被拖的东西：一个素材，或一条提示词。 */
export type DragPayload =
  | { kind: 'material', name: string, url: string }
  | { kind: 'prompt', prompt: string, title: string }

/**
 * 把载荷编码成拖放时该放的字符串。
 * @param p - 载荷。
 * @returns JSON 字符串。
 */
export function encodeDrag(p: DragPayload): string {
  return JSON.stringify(p)
}

/**
 * 解出被拖的东西（**形状不对就给 `null`**，不抛）。
 *
 * 为什么宽容：拖放的数据可能来自别处（另一个标签页、甚至外部程序）。
 * 解不出来就当没拖过 —— 抛异常会让整次 drop 失败，用户看到的是「怎么都放不进去」。
 *
 * @param raw - `dataTransfer.getData(DRAG_MIME)` 的返回值。
 * @returns 载荷；不是我们的形状给 `null`。
 */
export function decodeDrag(raw: string): DragPayload | null {
  if (raw === '') return null
  let v: unknown
  try { v = JSON.parse(raw) } catch { return null }
  if (v === null || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.kind === 'material' && typeof o.name === 'string' && o.name !== '') {
    return { kind: 'material', name: o.name, url: typeof o.url === 'string' ? o.url : '' }
  }
  if (o.kind === 'prompt' && typeof o.prompt === 'string') {
    return { kind: 'prompt', prompt: o.prompt, title: typeof o.title === 'string' ? o.title : '' }
  }
  return null
}

/**
 * 落点：把「屏幕坐标」换算成「画布坐标」（拖放要给的那个位置）。
 *
 * ⚠️ 真正换算要用 React Flow 的 `screenToFlowPosition`（它知道缩放与平移）；
 * 这个函数只是**把它包成可测的形状**：调用方传进来的已经是画布坐标时，
 * 这一步就只是往下传。加这一层是为了让「落点 → 节点 position」这条断言
 * 不必起一个真 React Flow 实例。
 *
 * @param pt - 画布坐标。
 * @returns 节点左上角坐标（现在是**落点即左上角**，不做居中偏移）。
 */
export function dropPosition(pt: { x: number, y: number }): { x: number, y: number } {
  /* 不做「减去节点一半宽高」的居中：用户拖到哪儿，节点左上角就在哪儿 ——
   * 这与点按钮插入（`insertMaterial` 里那个阶梯式偏移）不同，
   * 那条是为了「连点几次不叠在一起」，拖放有明确落点就不该再偏移。 */
  return { x: Math.round(pt.x), y: Math.round(pt.y) }
}

/**
 * 把拖进来的东西变成一个**新节点**（不改 `nodes`，只造一个）。
 *
 * @param p - 载荷。
 * @param position - 落点（画布坐标）。
 * @returns 新节点；素材扩展名认不出视频时按图片处理（与侧栏那条一致）。
 */
export function nodeFromDrag(p: DragPayload, position: { x: number, y: number }): ContentNode {
  if (p.kind === 'prompt') {
    return newNode('text', position, { text: p.prompt })
  }
  const isVideo = /\.(mp4|webm|mov|m4v|avi|mkv)$/i.test(p.name)
  const n = newNode(isVideo ? 'video' : 'image', position, { artifact: '', prompt: '' })
  /* 素材没有产物 id，所以把 url 记在 reference 里让节点能显示
   * （与 `insertMaterial` 那条同一取舍，见那里的注释）。 */
  n.data.reference = p.url
  return n
}

/* ── 从系统拖文件 / 剪贴板粘图（用户 m02814 #101 / #102）────────────
 *
 * ## 两条通道为什么必须分开判
 *
 * 画布上同时有两种「拖进来」：
 *   · **侧栏拖**：`dataTransfer` 里是自定义 MIME（`application/x-ewb+json`），
 *     放的是「素材名 / 提示词」这种轻量载荷；
 *   · **从系统拖文件**：`dataTransfer.files` 里是真实 `File` 对象，
 *     要读字节、上传成产物。
 *
 * 它们的入口是**同一个 `onDrop`**。所以判的顺序很重要：
 * 先看自定义 MIME（那是我们自己放的，最可靠），解不出来再看 `files`。
 * 反过来会让「拖一个文件、但里面恰好有一份同名 JSON」被当成载荷。
 */

/** 一个文件该造哪种节点（`null` = 不认识，要明确提示）。 */
export type DropFileKind = 'image' | 'video' | 'audio' | null

/** 图片扩展名（含 `svg`：它也是图，只是不能进 canvas 再编辑）。 */
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif)$/i
/** 视频扩展名。 */
const VIDEO_EXT = /\.(mp4|webm|mov|m4v|avi|mkv)$/i
/** 音频扩展名（用户 m02814 之前音频节点已存在，这里顺带收）。 */
const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|aac|flac)$/i

/**
 * 按文件名认它是什么类型的节点。
 *
 * ⚠️ **只认扩展名，不认 MIME**：系统给的 `file.type` 在不少平台上对
 * `mov` / `mkv` 给空串（Linux 文件管理器尤其常见），而扩展名一定有。
 *
 * @param name - 文件名（可以带路径）。
 * @returns 节点类型；认不出来给 `null`（调用方要**明确提示**，不许静默丢）。
 */
export function fileKindOf(name: string): DropFileKind {
  if (IMAGE_EXT.test(name)) return 'image'
  if (VIDEO_EXT.test(name)) return 'video'
  if (AUDIO_EXT.test(name)) return 'audio'
  return null
}

/** 从拖放里解出来的一份文件（**只是描述**，不碰 `File` 对象 —— 那样才能单测）。 */
export interface DroppedFile {
  /** 文件名。 */
  name: string
  /** 该造哪种节点。 */
  kind: 'image' | 'video' | 'audio'
}

/**
 * 把一串文件名分成「能放的」与「不认识的」。
 *
 * ## 为什么要分开返回，而不是只给能放的
 *
 * 用户拖了 5 个文件、其中 1 个是 `.psd`，如果只静默丢掉那一个，
 * 他看到的是「拖进来 4 个」——**以为是全放了**。所以调用方要把
 * `rejected` 里的名字念出来（判据 3：不静态丢弃）。
 *
 * @param names - 文件名数组（顺序保留）。
 * @returns `ok` 能放的（带类型）、`rejected` 认不出的（原样回名字）。
 */
export function sortDroppedFiles(names: readonly string[]): {
  ok: DroppedFile[]
  rejected: string[]
} {
  const ok: DroppedFile[] = []
  const rejected: string[] = []
  for (const raw of names) {
    const kind = fileKindOf(raw)
    if (kind === null) rejected.push(raw)
    else ok.push({ name: raw, kind })
  }
  return { ok, rejected }
}

/**
 * 拖进来的文件该落在哪（比鼠标位置**往下错开一点**）。
 *
 * ## 为什么要错开
 *
 * 一次拖 3 个文件时，如果全落在同一个坐标上，用户看到的是「一叠」——
 * 只看得见最上面那个，会以为只放进来了 1 个。
 * 按序号错开之后，3 个文件一眼能数出来。
 *
 * @param at - 鼠标落点（画布坐标）。
 * @param index - 第几个（0 起）。
 * @param step - 每个错开多少像素。
 * @returns 该文件的落点。
 */
export function dropOffset(at: { x: number, y: number }, index: number, step: number = 28): { x: number, y: number } {
  const i = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0
  const s = Number.isFinite(step) && step > 0 ? step : 28
  return { x: Math.round(at.x + i * s), y: Math.round(at.y + i * s) }
}

/**
 * 一次粘贴该做什么（用户 m02814 #102 的核心判据：内部缓冲区优先）。
 *
 * ## 为什么要一个纯函数决定这件事
 *
 * 两种粘贴同时存在：
 *   · **画布内复制**（Ctrl+C 复制的节点，在模块级缓冲区里）；
 *   · **系统剪贴板里的图**（截图之后 Ctrl+V）。
 *
 * 用户复制了一个节点，然后粘出来**一张图** —— 那是明确的错。
 * 所以规则是：**缓冲区有东西就粘节点，不读剪贴板；缓冲区空了才看系统剪贴板**。
 *
 * 这个判断单独抽出来，才能不挂画布、不造 ClipboardEvent 就把它钉住。
 *
 * @param clipboardCount - 内部缓冲区里有几个节点。
 * @returns 该走哪条。
 */
export function pasteSourceOf(clipboardCount: number): 'nodes' | 'system' {
  return clipboardCount > 0 ? 'nodes' : 'system'
}

/* ── @ 提及画布节点（用户 m02814 #76 / #78b）─────────────────────────
 *
 * ## 为什么界面这一层要单独写候选与插入，而不是直接调 `src/schedule/mentions.ts`
 *
 * 那个文件是**后端**的（解析 + 替换）；这里要的是**界面侧的两件事**：
 * 「打 `@` 之后列出哪些节点」「插进去的那段文本长什么样」。
 * 两者共用**同一个语法**（`@[名字](节点id)`），但职责不同。
 *
 * ⚠️ 所以 `mentionTokenOf` 必须与后端语法**逐字对齐** ——
 * 它由一条**跨层断言**钉住：把界面生成的 token 喂给后端 `resolveMentions`，
 * 必须能解出来。各测一半（界面测「拼出的字符串长这样」、后端测「能解析这种字符串」）
 * 挡不住「两边都改了却改得不一样」。
 */

/** 一个可被 @ 的节点（界面侧：只关心显示名与它是什么）。 */
export interface MentionCandidate {
  /** 节点 id。 */
  id: string
  /** 显示名（用户起的名字，没起就用类型名）。 */
  name: string
  /** 类型（决定后端拿到它之后给正文还是给产物图）。 */
  type: ContentNodeType
}

/**
 * 画布上一个节点能不能被 @（**纯函数**，判据落在这里）。
 *
 * ## 为什么排掉这几种
 *
 * · **组**（`group`）：它是框、没有内容，引进来什么也换不出；
 * · **生成配置**（`config`）：同理，它只是参数；
 * · **批量节点**（`batch`）：它的 `items` 是一批产物 id，而后端
 *   `MentionTarget.kind` 里没有这一类 —— 引它等于引一个后端不认识的东西。
 *
 * 加新类型时**要回来想一遍**：这个类型能不能被引？
 * （`tests/content-canvas.mjs` 有一条按类型表遍历的断言，漏了会红。）
 *
 * @param type - 节点类型。
 * @returns 能被 @ 给 true。
 */
export function mentionableType(type: ContentNodeType): boolean {
  return type === 'text' || type === 'image' || type === 'video' || type === 'audio'
}

/**
 * 造一段提及文本：`@[名字](节点id)`。
 *
 * ## 名字里的方括号与换行怎么处理
 *
 * · **方括号保留**（后端允许嵌套，见 `mentions.ts` 文件头那条）；
 * · **换行替换成空格**：后端明确把「名字里带换行」判成畸形语法。
 *
 * @param c - 候选节点。
 * @returns 该插进提示词的那段文本。
 */
export function mentionTokenOf(c: MentionCandidate): string {
  const name = (c.name ?? '').replace(/[\r\n]+/g, ' ').trim()
  return '@[' + name + '](' + c.id + ')'
}

/**
 * 提示词里**正在输入的那个 `@`** 覆盖了哪一段（决定下拉框插到哪儿）。
 *
 * ## 为什么要算这个，而不是「在光标处直接插」
 *
 * 用户可能已经敲了 `@主`，这时选下拉里那一项，应该把 `@主` **整段替换掉**；
 * 在它后面再插一段会留下 `@主@[主图](n1)`。
 *
 * ## 判据
 *
 * 从光标往前找最近的 `@`，且它与光标之间**没有空白、没有换行、没有另一个 `@`**。
 * 找不到就给 `null`（那不是提及，是普通文字里的一个 at 符号）。
 *
 * @param text - 输入框里的全文。
 * @param caret - 光标位置（0 ~ text.length）。
 * @returns 要用 token 替换的区间 `{ from, to, query }`；不是提及给 `null`。
 */
export function mentionQueryAt(text: string, caret: number): { from: number, to: number, query: string } | null {
  const s = typeof text === 'string' ? text : ''
  const pos = Math.max(0, Math.min(s.length, Math.round(Number.isFinite(caret) ? caret : 0)))
  let i = pos - 1
  while (i >= 0) {
    const ch = s[i]
    if (ch === '@') return { from: i, to: pos, query: s.slice(i + 1, pos) }
    /* 空白 / 换行 / 另一个 @ 都说明「光标前面这个 @ 已经不属于当前这段输入」。 */
    if (/\s/.test(ch)) return null
    i -= 1
  }
  return null
}

/**
 * 按输入的那几个字筛候选。
 *
 * @param all - 全部候选。
 * @param query - 已经敲的字（`@` 之后那段）。
 * @returns 匹配的（名字或 id 含 query，忽略大小写）；`query` 为空时全给。
 */
export function filterMentions(all: readonly MentionCandidate[], query: string): MentionCandidate[] {
  const q = (query ?? '').trim().toLowerCase()
  if (q === '') return [...all]
  return all.filter(c => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
}

/**
 * 把一个画布节点变成后端 `MentionLookup` 认的样子（用户 m02814 补漏）。
 *
 * ## 为什么这一步单独一个函数
 *
 * `resolveMentions` 只认 `MentionTarget`（`kind` / `name` / `text` / `artifact`），
 * 它**不认识画布存档的形状**（那是刻意解耦的，见 `mentions.ts` 文件头）。
 * 中间这层映射写错，表现是「@ 了但什么也没插进去」——**不报错**。
 *
 * · 文本 → `kind: 'text'` + `text`（正文插进提示词）；
 * · 图 / 视频 / 音频 → `kind` 原样 + `artifact`（后端拿它进 `refs`）；
 * · 组 / 配置 / 批量 → `kind: 'other'`（后端按「找不到」处理，原文保留）；
 *   批量节点的 `items` 是一批 id，后端 `MentionTarget` 里没有这一类。
 *
 * @param n - 画布节点（存盘形状）。
 * @returns 后端认的目标。
 */
export function mentionTargetOf(n: ContentNode): {
  kind: 'text' | 'image' | 'video' | 'audio' | 'config' | 'other'
  name?: string
  text?: string
  artifact?: string
} {
  const named = (n.title ?? '').trim() !== '' ? (n.title ?? '').trim() : ((n.data.title ?? '') as string).trim()
  const base = named !== '' ? { name: named } : {}
  if (n.type === 'text') {
    return { kind: 'text', ...base, text: n.data.text ?? '' }
  }
  if (n.type === 'image' || n.type === 'video' || n.type === 'audio') {
    return { kind: n.type, ...base, artifact: (n.data.artifact ?? '').trim() }
  }
  /* 组 / 配置 / 批量：没有可直接引用的内容。 */
  return { kind: 'other', ...base }
}

/**
 * 合并两批 `refs`，**底图永远排第一**（用户 m02814 判据 4）。
 *
 * ## 为什么顺序要紧
 *
 * `inpaint` 那条路把 `refs[0]` 当底图（要重绘的那张）。如果 @ 出来的图排到前面，
 * 后端会把**参考图**当成底图去重绘 —— 结果完全不对，而且不报错。
 *
 * 去重按 `base64` 比：同一个产物取两次字节是一样的字符串。
 *
 * @param baseRef - 底图（`inpaint` 用；没有给空数组）。
 * @param mentioned - @ 提及带出来的图（字节）。
 * @returns 合并后的清单，底图在前。
 */
export function mergeRefs(
  baseRef: readonly { mime: string, base64: string }[],
  mentioned: readonly { mime: string, base64: string }[],
): { mime: string, base64: string }[] {
  const out: { mime: string, base64: string }[] = []
  const seen = new Set<string>()
  for (const r of [...baseRef, ...mentioned]) {
    if (r.base64 === '') continue
    if (seen.has(r.base64)) continue
    seen.add(r.base64)
    out.push(r)
  }
  return out
}

/* ── 快照与撤销栈 ───────────────────────────────────────────────────── */

/** 撤销栈的上限（计划 §三 3.4：上限 50）。 */
export const HISTORY_LIMIT = 50

/**
 * 复制一份快照。
 *
 * 为什么要逐层手抄而不是 `structuredClone`：快照里只有「节点数组 + 连线数组 + 三个数」，
 * 手抄一遍最省事，也不会在某天把某个不可克隆的东西（函数、类实例）悄悄带进节点里。
 *
 * @param nodes - 节点。
 * @param edges - 连线。
 * @param viewport - 视口。
 * @returns 一份独立快照。
 */
export function snapshotOf(
  nodes: readonly ContentNode[],
  edges: readonly ContentEdge[],
  viewport: CanvasViewport,
): CanvasSnapshot {
  return {
    nodes: nodes.map(n => ({ ...n, position: { ...n.position }, data: { ...n.data } })),
    edges: edges.map(e => ({ ...e })),
    viewport: { ...viewport },
  }
}

/**
 * 两份快照内容是否一样（判断「这次改动值得记一笔吗」）。
 * @param a - 快照。
 * @param b - 快照。
 * @returns 一样给 true。
 */
export function sameSnapshot(a: CanvasSnapshot, b: CanvasSnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 撤销栈。 */
export interface History {
  /** 记一笔「改动之前是什么样」。 */
  record: (s: CanvasSnapshot) => void
  /** 撤销：传入当前状态，返回要恢复的状态（没得撤给 null）。 */
  undo: (current: CanvasSnapshot) => CanvasSnapshot | null
  /** 重做：传入当前状态，返回要恢复的状态（没得重做给 null）。 */
  redo: (current: CanvasSnapshot) => CanvasSnapshot | null
  /** 还能撤几次 / 还能重做几次（界面上「按钮灰不灰」与测试都用它）。 */
  depths: () => { past: number, future: number }
  /** 清空（换一份画布时用）。 */
  clear: () => void
}

/**
 * 造一个撤销栈。
 *
 * ## 语义（别改，改了「摆三个 → 撤销回到两个」就不成立）
 *
 * `record` 记的是**改动之前**的样子；`undo(当前)` 把当前推进重做栈、吐出上一份。
 * 这样「初始空 → 加 A → 加 B → 加 C」之后按一次撤销，回到两个节点。
 *
 * ## 上限为什么是「丢最老的」
 *
 * 到 50 之后继续记，丢的是最早那份快照 —— 用户按满 50 次撤销会停在
 * 「最早还留着的那一版」，而不是忽然撤不动。两种都有代价，选这个是因为
 * 「撤不动」会让人以为功能坏了。
 *
 * @param limit - 上限（默认 50）。
 * @returns 撤销栈。
 */
export function createHistory(limit: number = HISTORY_LIMIT): History {
  const past: CanvasSnapshot[] = []
  const future: CanvasSnapshot[] = []
  return {
    record(s: CanvasSnapshot): void {
      past.push(snapshotOf(s.nodes, s.edges, s.viewport))
      while (past.length > limit) past.shift()
      /* 新的改动会让「重做」失去意义 —— 与所有编辑器一致。 */
      future.length = 0
    },
    undo(current: CanvasSnapshot): CanvasSnapshot | null {
      const prev = past.pop()
      if (prev === undefined) return null
      future.push(snapshotOf(current.nodes, current.edges, current.viewport))
      return prev
    },
    redo(current: CanvasSnapshot): CanvasSnapshot | null {
      const next = future.pop()
      if (next === undefined) return null
      past.push(snapshotOf(current.nodes, current.edges, current.viewport))
      while (past.length > limit) past.shift()
      return next
    },
    depths(): { past: number, future: number } {
      return { past: past.length, future: future.length }
    },
    clear(): void {
      past.length = 0
      future.length = 0
    },
  }
}

/* ── 自动保存（防抖）────────────────────────────────────────────────── */

/** 自动保存的防抖时长（计划 §三 3.1：照参考项目 400ms 量级）。 */
export const AUTOSAVE_DELAY = 400

/** 自动保存器。 */
export interface Autosave {
  /** 排队一次保存（会重置防抖计时）。 */
  queue: (s: CanvasSnapshot) => void
  /** 立刻把排队那次存掉（换画布 / 关掉画布前用）。 */
  flush: () => void
  /** 丢掉排队那次，不存。 */
  cancel: () => void
}

/**
 * 造一个防抖自动保存器。
 *
 * 为什么必须有它：拖一下节点会连出几十次变更，每次写一次盘既慢又毫无意义 ——
 * 用户要的是「停下来之后存住」，不是「每移动一像素存一次」。
 *
 * @param save - 真正落盘的那一步。
 * @param delay - 防抖毫秒。
 * @returns 自动保存器。
 */
export function createAutosave(save: (s: CanvasSnapshot) => void, delay: number = AUTOSAVE_DELAY): Autosave {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: CanvasSnapshot | null = null
  const stop = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null }
  }
  return {
    queue(s: CanvasSnapshot): void {
      pending = s
      stop()
      timer = setTimeout(() => {
        timer = null
        const p = pending
        pending = null
        if (p !== null) save(p)
      }, delay)
    },
    flush(): void {
      stop()
      const p = pending
      pending = null
      if (p !== null) save(p)
    },
    cancel(): void {
      stop()
      pending = null
    },
  }
}

/* ── 宿主接口（契约 AX 已落地，这里只包一层）────────────────────────────
 *
 * ⚠️ 契约书里写列表回 `{ ok, items }`，而宿主实际回的是 `{ ok, canvases }`
 * （`src/index.ts:1575-1577` → `listCanvases()`）。**两个都认**：
 * 服务端已经上线，界面不该因为契约书写了另一个键名就取不到数据。
 */

/** 画布库里的一条。 */
export interface CanvasListItem {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  nodeCount: number
  /**
   * 缩略图用的产物 id（用户 m02814 #105）。
   *
   * ⚠️ 它是**算出来的**（`canvasThumbOf`），宿主半的清单接口不回这个键。
   * 清单页拿到节点之后调一次那个纯函数填上。
   */
  thumb?: string
}

/**
 * 一份画布该拿哪个产物当缩略图（用户 m02814 #105）。
 *
 * ## 为什么只认「图 / 视频」，不认文本
 *
 * 缩略图要一张**能看的画面**。文本节点的 `text` 是一段字，塞进 40×40 的格子里
 * 什么也看不出来；而 `artifact` 空着的文本节点更是什么都没有。
 *
 * ## 为什么优先「有产物」而不是「位置最靠左上」
 *
 * 用户打开画布第一眼看到的通常是**他生成出来的东西**。取位置最左上的可能是个
 * 空的配置节点或一段还没跑的提示词 —— 那张缩略图什么信息都不给。
 * 所以：**有产物的优先**，同类里再按「左上」排（左上通常是链路起点，更符合直觉）。
 *
 * ## 为什么视频排在图片后面
 *
 * `<video>` 当缩略图在某些环境下不出首帧（`preload="metadata"` 只拿到时长）。
 * 有图片可用时优先图片，只有视频时再用视频。
 *
 * @param nodes - 画布上的节点（存盘形状）。
 * @returns 产物 id；一个能当缩略图的都没有时给 `undefined`（界面画占位）。
 */
export function canvasThumbOf(nodes: readonly ContentNode[]): string | undefined {
  /** 能当缩略图的候选，带排序键。 */
  const cands: { art: string, type: ContentNodeType, x: number, y: number }[] = []
  for (const n of nodes) {
    if (n.type !== 'image' && n.type !== 'video') continue
    const art = (n.data.artifact ?? '').trim()
    if (art === '') continue
    cands.push({ art, type: n.type, x: n.position.x, y: n.position.y })
  }
  if (cands.length === 0) return undefined
  cands.sort((a, b) => {
    /* 图片优先于视频。 */
    if (a.type !== b.type) return a.type === 'image' ? -1 : 1
    /* 同一类里按左上。 */
    if (a.y !== b.y) return a.y - b.y
    return a.x - b.x
  })
  return cands[0].art
}

/** 一份完整画布。 */
export interface CanvasDoc extends CanvasListItem {
  nodes: ContentNode[]
  edges: ContentEdge[]
  viewport: CanvasViewport
}

/** 一次接口调用的结果（永不抛）。 */
export interface ApiResult<T> {
  ok: boolean
  data?: T
  error?: string
}

/**
 * 调一个内容板块接口。
 * @param path - 前缀之后的路径。
 * @param init - fetch 选项。
 * @returns 结果（永不抛）。
 */
async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response
  try {
    res = await fetch('/api/ecom-workbench' + path, init)
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
  let body: Record<string, unknown> = {}
  try { body = await res.json() as Record<string, unknown> } catch { /* 空响应按空对象 */ }
  if (!res.ok || body.ok === false) {
    const why = typeof body.error === 'string' ? body.error : '宿主半返回 ' + String(res.status)
    return { ok: false, error: why }
  }
  return { ok: true, data: body as T }
}

/**
 * 列画布库。
 * @returns 摘要数组（失败给空数组 + 原因）。
 */
export async function listCanvases(): Promise<ApiResult<CanvasListItem[]>> {
  const r = await api<{ canvases?: unknown, items?: unknown }>('/canvases')
  if (!r.ok) return { ok: false, error: r.error }
  const raw = r.data?.canvases ?? r.data?.items
  if (!Array.isArray(raw)) return { ok: true, data: [] }
  return { ok: true, data: raw.map(oneSummary).filter((x): x is CanvasListItem => x !== null) }
}

/**
 * 把一条来自磁盘的记录收成摘要（字段缺失就退回默认值，不让一条坏记录弄崩列表）。
 * @param v - 未知形状。
 * @returns 摘要；连 id 都没有给 null。
 */
function oneSummary(v: unknown): CanvasListItem | null {
  if (v === null || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id === '') return null
  return {
    id: o.id,
    title: typeof o.title === 'string' ? o.title : '未命名画布',
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    nodeCount: typeof o.nodeCount === 'number' ? o.nodeCount : 0,
  }
}

/**
 * 读一份画布。
 * @param id - 画布 id。
 * @returns 完整画布（失败给原因）。
 */
export async function loadCanvas(id: string): Promise<ApiResult<CanvasDoc>> {
  const r = await api<{ canvas?: unknown }>('/canvases/' + encodeURIComponent(id))
  if (!r.ok) return { ok: false, error: r.error }
  const doc = oneDoc(r.data?.canvas)
  return doc === null ? { ok: false, error: '画布内容读不出来' } : { ok: true, data: doc }
}

/**
 * 把一份记录收成完整画布（字段逐层判类型，缺哪层退回空）。
 * @param v - 未知形状。
 * @returns 画布；连 id 都没有给 null。
 */
export function oneDoc(v: unknown): CanvasDoc | null {
  if (v === null || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const base = oneSummary(o)
  if (base === null) return null
  return {
    ...base,
    nodes: Array.isArray(o.nodes) ? o.nodes.filter(isContentNode) : [],
    edges: Array.isArray(o.edges) ? o.edges.filter(isContentEdge) : [],
    viewport: oneViewport(o.viewport),
  }
}

/**
 * 一条记录像不像内容节点。
 * @param v - 未知形状。
 * @returns 像给 true。
 */
export function isContentNode(v: unknown): v is ContentNode {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id === '') return false
  if (!isNodeType(o.type)) return false
  const p = o.position
  if (p === null || typeof p !== 'object') return false
  return typeof (p as { x?: unknown }).x === 'number' && typeof (p as { y?: unknown }).y === 'number'
}

/**
 * 一个字符串是不是节点类型。
 * @param v - 未知值。
 * @returns 是给 true。
 */
export function isNodeType(v: unknown): v is ContentNodeType {
  return v === 'text' || v === 'image' || v === 'video' || v === 'audio' || v === 'config' || v === 'group' || v === 'batch'
}

/**
 * 一条记录像不像连线。
 * @param v - 未知形状。
 * @returns 像给 true。
 */
export function isContentEdge(v: unknown): v is ContentEdge {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.source === 'string' && typeof o.target === 'string'
}

/**
 * 把视口收成三个数。
 * @param v - 未知形状。
 * @returns 视口。
 */
export function oneViewport(v: unknown): CanvasViewport {
  if (v === null || typeof v !== 'object') return { ...DEFAULT_VIEWPORT }
  const o = v as Record<string, unknown>
  return {
    x: typeof o.x === 'number' ? o.x : 0,
    y: typeof o.y === 'number' ? o.y : 0,
    zoom: typeof o.zoom === 'number' && o.zoom > 0 ? o.zoom : 1,
  }
}

/**
 * 新建一份画布。
 *
 * ## ★ 2026-10-28（票 46）：多了一个可选 `snap`
 *
 * 加它是为了**复制画布**：副本要连节点、连线、视口一起建出来。
 *
 * ## 为什么必须一次提交，而不是「先新建空画布、再 PUT 节点」
 *
 * 两步会留下半成品：新建成功、PUT 失败 → 磁盘上多出一份空画布，
 * 用户还得自己去删。一次提交则要么成了一份完整副本，要么什么都没留下。
 *
 * ## 后端一行没改（核实过）
 *
 * `POST /canvases` 把请求体原样交给 `createCanvas(raw)`（`src/schedule/canvases.ts:148`），
 * 而 `normalizeCanvas`（`:84-100`）本来就读 `raw.nodes` / `raw.edges` / `raw.viewport`。
 * 也就是说「带节点一起建」后端一直支持，只是前端封装没往外透。
 *
 * ## 副本的 id 由后端现造（`canvases.ts:151` 撞了就换一个）
 *
 * 所以这里**不许**传 `id` —— 传了原件 id 反而会与原件撞，后端会换一个（结果对，
 * 但那是碰运气对，不是设计对）。副本内部节点 / 边的 id 原样保留，
 * 理由见 `duplicateCanvas`。
 *
 * @param title - 标题。
 * @param snap - 可选：一起建出来的初始快照（复制时用）。
 * @returns 建好的画布。
 */
export async function createCanvas(title: string, snap?: CanvasSnapshot): Promise<ApiResult<CanvasDoc>> {
  const body: Record<string, unknown> = { title }
  /* 只在这三样**真的给了**的时候才放进请求体：老调用方（只给 title）走的
   * 请求体与改动之前逐字相同。 */
  if (snap !== undefined) {
    body.nodes = snap.nodes
    body.edges = snap.edges
    body.viewport = snap.viewport
  }
  const r = await api<{ canvas?: unknown }>('/canvases', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) return { ok: false, error: r.error }
  const doc = oneDoc(r.data?.canvas)
  return doc === null ? { ok: false, error: '新建后读不出画布' } : { ok: true, data: doc }
}

/**
 * 保存一份画布（整份覆盖）。
 * @param id - 画布 id。
 * @param title - 标题。
 * @param snap - 快照。
 * @returns 保存后的画布。
 */
export async function saveCanvas(id: string, title: string, snap: CanvasSnapshot): Promise<ApiResult<CanvasDoc>> {
  const r = await api<{ canvas?: unknown }>('/canvases/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, nodes: snap.nodes, edges: snap.edges, viewport: snap.viewport }),
  })
  if (!r.ok) return { ok: false, error: r.error }
  const doc = oneDoc(r.data?.canvas)
  return doc === null ? { ok: false, error: '保存后读不出画布' } : { ok: true, data: doc }
}

/**
 * 改标题（只发 title，节点由宿主沿用旧值）。
 * @param id - 画布 id。
 * @param title - 新标题。
 * @returns 结果。
 */
export async function renameCanvas(id: string, title: string): Promise<ApiResult<null>> {
  const r = await api<unknown>('/canvases/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  return r.ok ? { ok: true, data: null } : { ok: false, error: r.error }
}

/**
 * 删一份画布。
 * @param id - 画布 id。
 * @returns 结果。
 */
export async function deleteCanvas(id: string): Promise<ApiResult<null>> {
  const r = await api<unknown>('/canvases/' + encodeURIComponent(id), { method: 'DELETE' })
  return r.ok ? { ok: true, data: null } : { ok: false, error: r.error }
}

/* ── 复制（票 46，2026-10-28）───────────────────────────────────────
 *
 * ## 节点 id / 边 id **不重生成** —— 这是判断过的，不是省事
 *
 * 三条依据（都核过）：
 *
 * 1. **节点 id 只在同一个画布内部被引用，没有跨画布的查找。**
 *    grep 过 `canvasNodeId` 的全部用法：只有「写进生成记录」
 *    （`src/schedule/gen-logs.ts:71`）与「从请求体读出来存」（`src/index.ts:2057`），
 *    **一处反查都没有**。所以两个画布有同名节点 id，不会互相影响。
 * 2. **画布内的引用是自洽的一整套**：`edges[].source/target` 指节点 id，
 *    `data.groupId` 指组节点 id（`group-geometry.ts:15`、`:189`）。
 *    整份复制过去这套引用天然成立；反过来，**重生成节点 id 却漏改 `edges`
 *    或 `groupId`，才会把它们指空** —— 那才是真正的串数据。
 * 3. `data.artifact` 指的是**产物**（字节在产物库，不在画布里）。副本与原件
 *    共用同一张图是对的：用户要的就是「照着这份改」。
 *
 * ## 所以要换的只有画布自己的 id，而那由后端现造（`canvases.ts:151` 撞了就换）
 */

/** 副本名的后缀（第一次复制用它，之后接序号）。
 *
 * ⚠️ **不要加 `export`**（2026-10-28 实测）。
 *
 * 加了之后 `npm run bundle` 会直接 panic，报：
 *   `SymbolRef { … } "COPY_SUFFIX" is not in any chunk, which is unexpected`
 * 这是打包工具 rolldown 的 bug（它自己说「This is a bug in Rolldown, not your code」），
 * 触发条件是「客户端的模块导出一个纯字符串常量、而没有任何别的模块 import 它」。
 *
 * 本文件与 `dispatch-client.ts` 的 `WF_COPY_SUFFIX` 各踩了一次。
 * 全仓没有一处 import 这两个常量（它们只在本文件内部用），所以不 export 是零代价。
 * 将来真要跨文件用它，先确认 rolldown 修了没有。 */
const COPY_SUFFIX = '副本'

/**
 * 从一个名字算出一个**没人用过**的副本名。
 *
 * ## 规则
 *
 * 原名 `X` → `X 副本`；已有 `X 副本` → `X 副本 2` → `X 副本 3` ……
 *
 * ## 为什么要把「`X 副本 2` 已在」也算进去（不能只判 `X 副本`）
 *
 * 用户连着复制两次、或手动改过名字，都会让中间某个序号被占。只判第一个的话
 * 第二次复制就会撞上「X 副本」—— 而工作流那边撞名是**覆盖写**，直接毁掉一份存档。
 * 所以这里从 2 开始往后找**第一个空位**。
 *
 * ## 为什么不带时间戳
 *
 * 时间戳（`X 副本 20261028-1815`）可读性差，而且用户**看不出**它是不是自己刚点的那份。
 * 序号制的坏处是「删掉中间一个之后会复用那个号」，但那不会撞（空位才用），
 * 可以接受。
 *
 * @param name - 原名（可以是「X 副本 2」这种已经带后缀的，照样往后数）。
 * @param taken - 已经被占用的名字集合。
 * @returns 一个不在 `taken` 里的名字。
 */
export function copyNameOf(name: string, taken: ReadonlySet<string>): string {
  /* 去掉已有后缀再往后数：从「X 副本 3」再复制，应得「X 副本」（若空位）
   * 或「X 副本 4」，而不是「X 副本 3 副本」。 */
  const stripped = name.replace(new RegExp(' ' + COPY_SUFFIX + '( \\d+)?$'), '').trim()
  const base = stripped === '' ? name : stripped
  const first = base + ' ' + COPY_SUFFIX
  if (!taken.has(first)) return first
  for (let i = 2; i <= 999; i += 1) {
    const cand = first + ' ' + String(i)
    if (!taken.has(cand)) return cand
  }
  /* 999 个副本还没空位 —— 用时间戳兜底，总之**必须**返回一个不撞的。 */
  return first + ' ' + String(Date.now())
}

/**
 * 复制一份画布。
 *
 * @param id - 原件 id。
 * @param takenTitles - 画布库里已用的**标题**集合（标题不是 id，但界面上一模一样会分不清）。
 * @returns 新画布（失败给原因）。
 */
export async function duplicateCanvas(
  id: string,
  takenTitles: ReadonlySet<string>,
): Promise<ApiResult<CanvasDoc>> {
  const got = await loadCanvas(id)
  if (!got.ok || got.data === undefined) return { ok: false, error: got.error ?? '读不到原件' }
  const src = got.data
  const title = copyNameOf(src.title, takenTitles)
  /* 一次提交带节点：不留半成品（理由见 `createCanvas`）。
   * **不传 id** —— 副本 id 由后端现造，传了反而是碰运气。 */
  return await createCanvas(title, {
    nodes: src.nodes,
    edges: src.edges,
    viewport: src.viewport,
  })
}

/* ── 生成链路（契约 CH，用户 m01076）─────────────────────────────────
 *
 * ## 后端已经有的四条路由（我核过 `src/index.ts:1613-1700`，照它的读法写）
 *
 * | 方法 | 路径 | 回什么 |
 * |---|---|---|
 * | GET | `/gen-models?kind=image` | `{ ok, models, items }`，每条 `{ channelId, channelName, protocol, modelId, modelLabel, caps }` |
 * | POST | `/generate` | `{ ok, id, task }`，立刻回（长的任务在后台） |
 * | GET | `/generate/:id` | `{ ok, task }`，`task.status` 四档 `submitted/running/success/failed` |
 * | POST | `/generate/:id/cancel` | `{ ok }`；404 表示「不存在或已结束」 |
 *
 * ⚠️ 模型清单的路径是 **`/gen-models` 不是 `/models`** —— `/models` 已被 dsh
 * 的模型目录占着（`src/index.ts:1692` 那段注释讲了踩坑经过）。
 *
 * ## 「已等多久」不用前端计时
 *
 * 后端 `GenerateTask.waitedMs` 每次轮询都更新（见 `generate.ts:111`）。
 * 前端自己从 `createdAt` 算会和后端的口径漂 —— 用户看到的秒数跟记录里对不上。
 */

/** 模型的用途（与后端 `GenKind` 同名）。 */
export type GenKind = 'image' | 'video' | 'text' | 'audio'

/** `/gen-models` 回的一条。 */
export interface GenModelOption {
  /** 渠道 id（提交时带上）。 */
  channelId: string
  /** 渠道名（界面显示「本地 / 云端」用）。 */
  channelName: string
  /** 协议（`openai` / `gemini` / `comfyui`）。 */
  protocol: string
  /** 模型 id（提交时带上）。 */
  modelId: string
  /** 模型显示名。 */
  modelLabel: string
  /** 这个模型的能力。 */
  caps: string[]
  /**
   * 这个模型算哪几类（票 70，2026-10-29）。
   *
   * ## ⚠️ 前端**不许自己从 `caps` 推**：这个值由宿主半给
   *
   * `caps` 分不出文生图与图生图（两者都是 `image`）。前端想筛就得自己写一遍
   * 「`caps` → 类型」的推导 —— 那是同一件事第二套判据，票 67 刚把它收进
   * `src/schedule/model-types.ts` 的 `typesOfModel` 一处（这个仓库为「同一件事
   * 写两份」踩过多次，见 `pitfalls/同一件事写两份迟早漂.md`）。
   *
   * 所以 `/gen-models` 回包每条都带 `types`（`listModels()` 里调的 `typesOfModel`）。
   * 前端只负责**读**，不推导。
   *
   * 一条模型可以同时在两类里：`caps` 有 `image` 的会同时算文生图与图生图，
   * 所以 `types` 常常是 `['t2i','i2i']` 两个值。
   */
  types: string[]
}

/** 任务状态（与后端 `TaskStatus` 同名同义）。 */
export type GenStatus = 'submitted' | 'running' | 'success' | 'failed'

/** 产物。 */
export interface GenArtifact {
  id: string
  mime: string
  bytes: number
  url: string
  width?: number
  height?: number
}

/** 一次生成任务（只抄界面要用的字段）。 */
export interface GenTask {
  id: string
  kind: GenKind
  status: GenStatus
  stage: string
  prompt: string
  model: string
  channelId: string
  channelName: string
  createdAt: number
  endedAt?: number
  /** 已经等了多久（ms，**后端算的**）。 */
  waitedMs: number
  artifacts: GenArtifact[]
  error?: string
}

/**
 * 把一条来自宿主半的任务收成界面形状（字段缺失就退回默认值）。
 * @param v - 未知形状。
 * @returns 任务；连 id 都没有给 null。
 */
function oneTask(v: unknown): GenTask | null {
  if (v === null || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id === '') return null
  const statusRaw = typeof o.status === 'string' ? o.status : ''
  const status: GenStatus = statusRaw === 'running' || statusRaw === 'success' || statusRaw === 'failed'
    ? statusRaw
    : 'submitted'
  const kindRaw = typeof o.kind === 'string' ? o.kind : ''
  const kind: GenKind = kindRaw === 'video' || kindRaw === 'text' || kindRaw === 'audio' ? kindRaw : 'image'
  const arts: GenArtifact[] = []
  if (Array.isArray(o.artifacts)) {
    for (const one of o.artifacts) {
      if (one === null || typeof one !== 'object') continue
      const a = one as Record<string, unknown>
      if (typeof a.id !== 'string' || a.id === '') continue
      arts.push({
        id: a.id,
        mime: typeof a.mime === 'string' ? a.mime : '',
        bytes: typeof a.bytes === 'number' ? a.bytes : 0,
        url: typeof a.url === 'string' ? a.url : '',
        ...typeof a.width === 'number' ? { width: a.width } : {},
        ...typeof a.height === 'number' ? { height: a.height } : {},
      })
    }
  }
  return {
    id: o.id,
    kind,
    status,
    stage: typeof o.stage === 'string' ? o.stage : '',
    prompt: typeof o.prompt === 'string' ? o.prompt : '',
    model: typeof o.model === 'string' ? o.model : '',
    channelId: typeof o.channelId === 'string' ? o.channelId : '',
    channelName: typeof o.channelName === 'string' ? o.channelName : '',
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    ...typeof o.endedAt === 'number' ? { endedAt: o.endedAt } : {},
    waitedMs: typeof o.waitedMs === 'number' ? o.waitedMs : 0,
    artifacts: arts,
    ...typeof o.error === 'string' && o.error !== '' ? { error: o.error } : {},
  }
}

/**
 * 列「能做这件事」的模型（跨渠道合并）。
 * @param kind - 生成什么（不传 = 全部）。
 * @returns 模型清单（失败给空数组 + 原因）。
 */
export async function listGenModels(kind?: GenKind, op?: GenOp): Promise<ApiResult<GenModelOption[]>> {
  /* ★ `op` 参数（用户 m02814 #61 / 判据 3）：扩图 / 超分在内置清单里**没有工作流**，
   * 所以不给 `?op=` 的话用户能选到一个「选了必然报错」的模型。
   * 带上它之后，宿主半只列**真能给这个 op 提供工作流**的渠道的模型。 */
  const parts: string[] = []
  if (kind !== undefined) parts.push('kind=' + encodeURIComponent(kind))
  if (op !== undefined) parts.push('op=' + encodeURIComponent(op))
  const q = parts.length === 0 ? '' : '?' + parts.join('&')
  const r = await api<{ models?: unknown, items?: unknown }>('/gen-models' + q)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, data: parseGenModels(r.data?.models ?? r.data?.items) }
}

/**
 * 把 `/gen-models` 回的原始数组收成 `GenModelOption[]`。
 * @param raw - 原始数组。
 * @returns 收好的清单。
 */
function parseGenModels(raw: unknown): GenModelOption[] {
  if (!Array.isArray(raw)) return []
  const out: GenModelOption[] = []
  for (const one of raw) {
    if (one === null || typeof one !== 'object') continue
    const o = one as Record<string, unknown>
    if (typeof o.modelId !== 'string' || o.modelId === '') continue
    out.push({
      channelId: typeof o.channelId === 'string' ? o.channelId : '',
      channelName: typeof o.channelName === 'string' ? o.channelName : '',
      protocol: typeof o.protocol === 'string' ? o.protocol : '',
      modelId: o.modelId,
      modelLabel: typeof o.modelLabel === 'string' && o.modelLabel !== '' ? o.modelLabel : o.modelId,
      caps: Array.isArray(o.caps) ? (o.caps as unknown[]).map(String) : [],
      types: Array.isArray(o.types) ? (o.types as unknown[]).map(String) : [],
    })
  }
  return out
}

/**
 * 列素材库里的文件（契约 CJ：参考图选择器用它当数据源）。
 *
 * ⚠️ 与侧栏（`CanvasSidePanel`）读的是**同一条路由** `GET /materials`，
 * 这里只是把形状收成前端要的那两个字段。**不另写一份路由**——
 * 两份数据源迟早漂（这个项目为「同一件事写两份」踩过坑）。
 *
 * @returns 素材清单（失败给原因）。
 */
export async function listMaterials(): Promise<ApiResult<{ name: string, url: string }[]>> {
  const r = await api<{ materials?: unknown, items?: unknown }>('/materials')
  if (!r.ok) return { ok: false, error: r.error }
  const raw = r.data?.materials ?? r.data?.items
  if (!Array.isArray(raw)) return { ok: true, data: [] }
  const out: { name: string, url: string }[] = []
  for (const one of raw) {
    if (one === null || typeof one !== 'object') continue
    const o = one as Record<string, unknown>
    if (typeof o.name !== 'string' || o.name === '') continue
    out.push({ name: o.name, url: typeof o.url === 'string' ? o.url : '' })
  }
  return { ok: true, data: out }
}

/** 提交一次生成的入参。 */
export interface SubmitGenInput {
  kind: GenKind
  prompt: string
  /**
   * 模型。
   *
   * ★ **可以不给**（用户 m03555）：后端把「用哪个模型」做成了三层规则
   * （指定 → 配置里的默认模型 → 报错并指路，见 `ce8c81c` 与
   * `docs/机制-配置面接口.md`）。界面不该替它挑，更不该回落到「清单第一个」。
   *
   * ⚠️ 原来这里是必填 `model: string`，于是界面被迫自己兜底 —— 那一兜就把
   * 后端的第 ② 层永远挡住了。 */
  model?: string
  channelId?: string
  size?: string
  count?: number
  seconds?: number
  source?: string
  canvasId?: string
  canvasNodeId?: string
  /**
   * 操作类型（用户 m02814 #60/#61/#63）。
   *
   * 与 `kind` 不是一回事：`kind` 是「生成什么」（图 / 视频 / 文本），
   * `op` 是「对已有内容做什么」（局部重绘 / 放大 / 超分 / 反推提示词）。
   * 后端用 `op` 挑工作流类别（`generate.ts:193` 的 `categoryOf`）。
   */
  op?: GenOp
  /**
   * 底图 / 参考图（产物 id 列表）—— `op` 用得上，普通生成不用。
   *
   * ⚠️ 至少一项：`inpaint` / `upscale` / `superResolve` / `caption`
   * **全都必须给底图**，缺了后端会用占位图而任务照样成功。
   */
  refs?: { mime: string, base64: string }[]
  /**
   * 蒙版（局部重绘用）—— **像素走 base64**，与 `POST /artifact` 同一条通道。
   *
   * ⚠️ 没涂就**不许提交**：后端不校验这个，缺了它会用工作流自带的占位遮罩，
   * 任务成功、结果完全不对（这一批最危险的失败方式）。
   */
  mask?: { mime: string, base64: string }
}

/** 生成操作的类别（与后端 `net-gen.ts:46` 的 `GenOp` 同一套）。 */
export type GenOp = 'inpaint' | 'upscale' | 'superResolve' | 'caption' | 'angle'

/**
 * 提交一次生成（**立刻返回**，真正跑的活在后台）。
 * @param input - 见 `SubmitGenInput`。
 * @returns 任务 id + 任务本身。
 */
export async function submitGen(input: SubmitGenInput): Promise<ApiResult<{ id: string, task: GenTask | null }>> {
  const body: Record<string, unknown> = {
    kind: input.kind,
    prompt: input.prompt,
    model: input.model,
  }
  if (input.channelId !== undefined && input.channelId !== '') body.channelId = input.channelId
  if (input.size !== undefined && input.size !== '') body.size = input.size
  if (input.count !== undefined) body.count = input.count
  if (input.seconds !== undefined) body.seconds = input.seconds
  if (input.source !== undefined && input.source !== '') body.source = input.source
  if (input.canvasId !== undefined && input.canvasId !== '') body.canvasId = input.canvasId
  if (input.canvasNodeId !== undefined && input.canvasNodeId !== '') body.canvasNodeId = input.canvasNodeId
  /* 操作类型与它带的东西（用户 m02814 #60/#61/#63）。
   *
   * ⚠️ `refs` 的形状是**字节**（`{ mime, base64 }`），不是产物 id ——
   * 后端 `src/index.ts:1650` 逐个读 `rec.base64`。产物 id 在这条路上没用，
   * 因为宿主半要的是能直接喂给 ComfyUI 的字节。
   * 所以调 `submitGen` 之前，调用方已经用 `artifactBase64` 把 id 换成了字节。 */
  if (input.op !== undefined) body.op = input.op
  if (input.refs !== undefined && input.refs.length > 0) body.refs = input.refs
  if (input.mask !== undefined) body.mask = input.mask
  const r = await api<{ id?: unknown, task?: unknown }>('/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) return { ok: false, error: r.error }
  const id = typeof r.data?.id === 'string' ? r.data.id : ''
  if (id === '') return { ok: false, error: '宿主半没回任务编号' }
  return { ok: true, data: { id, task: oneTask(r.data?.task) } }
}

/**
 * 查一次任务状态。
 * @param id - 任务 id。
 * @returns 任务（失败给原因）。
 */
export async function getGenTask(id: string): Promise<ApiResult<GenTask>> {
  const r = await api<{ task?: unknown }>('/generate/' + encodeURIComponent(id))
  if (!r.ok) return { ok: false, error: r.error }
  const t = oneTask(r.data?.task)
  if (t === null) return { ok: false, error: '宿主半回的任务形状不对' }
  return { ok: true, data: t }
}

/**
 * 取消一个任务。
 * @param id - 任务 id。
 * @returns 结果（404 时 `error` 说清「不存在或已结束」）。
 */
export async function cancelGen(id: string): Promise<ApiResult<null>> {
  const r = await api<unknown>('/generate/' + encodeURIComponent(id) + '/cancel', { method: 'POST' })
  return r.ok ? { ok: true, data: null } : { ok: false, error: r.error }
}

/**
 * 把一个素材（base64）传进素材库。
 * @param name - 文件名。
 * @param base64 - 内容（不含 `data:` 前缀）。
 * @returns 存进去的素材名。
 */
export async function uploadMaterial(name: string, base64: string): Promise<ApiResult<string>> {
  const r = await api<{ material?: unknown }>('/materials', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, base64 }),
  })
  if (!r.ok) return { ok: false, error: r.error }
  const raw = r.data?.material
  if (raw === null || typeof raw !== 'object') return { ok: true, data: name }
  const o = raw as Record<string, unknown>
  return { ok: true, data: typeof o.name === 'string' ? o.name : name }
}

/**
 * 把一个 base64 存成**产物**，回产物 id（用户 m02814：裁剪 / 拆图 / 抓帧的结果都走这条路）。
 *
 * ## 为什么用 `/artifact` 而不是 `/materials`
 *
 * 两者都能存图，但语义不同：
 *   · **产物**（artifact）是「生成 / 加工出来的东西」，画布节点引用的是它的 id，
 *     工具条上的「下载 / 加素材库」都按 id 走 `artifactHref`；
 *   · **素材**（material）是「用户自己的原始文件」，另一条存储、另一套路由。
 *
 * 裁剪出来的图属于前者 —— 它是从原图加工出来的新东西，用户接下来大概率还要
 * 再生成、再加素材库，那条链路上的所有代码都认产物 id。
 *
 * @param base64 - 图像字节（**不含** `data:` 前缀）。
 * @param mime - MIME（如 `image/png`）。
 * @param ext - 扩展名（不带点）。给了就用它，不靠 mime 推。
 * @returns 产物 id；失败给原因。
 */
export async function uploadArtifact(
  base64: string,
  mime: string,
  ext: string,
): Promise<ApiResult<string>> {
  const r = await api<{ id?: unknown }>('/artifact', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base64, mime, ext }),
  })
  if (!r.ok) return { ok: false, error: r.error }
  const id = typeof r.data?.id === 'string' ? r.data.id : ''
  if (id === '') return { ok: false, error: '宿主半没回产物编号' }
  return { ok: true, data: id }
}

/**
 * 产物 id → 可下载的地址。
 * @param id - 产物 id。
 * @returns 地址（宿主半的二进制路由）。
 */
export function artifactHref(id: string): string {
  return '/api/ecom-workbench/artifact/' + encodeURIComponent(id)
}

/* ── 参考图取字节（票 71，2026-10-29）──────────────────────────────
 *
 * ## 它修的是什么
 *
 * 内容画布上用户**选了参考图**（缩略图也显示了），点「生成」时那张图**根本没送出去**。
 * `data.reference` 存了值，但 `doGenerate` 拼 `refs` 时从来没读过它。
 *
 * 修法不是「多读一个字段」，而是先要有一处能回答「这个值是哪条路由的、键是什么」。
 * 那个值有**五种形状**（见 `refBytes`），来源各不相同 —— 靠 `if` 散在调用点必然漏。
 */

/** 参考图值解析出来的路由。 */
export interface RefRoute {
  /** 走哪条二进制路由。 */
  route: 'artifact' | 'material'
  /** 路由后面那个键（产物 id / 素材名）。 */
  key: string
}

/** 带 `material/` 前缀但**不带** `/api/ecom-workbench` 的那种（上传替换写的）。 */
const MATERIAL_SHORT_PREFIX = 'material/'
/** 素材路由的完整前缀（`refFromMaterial` 写的是 `m.url`，带这个前缀）。 */
const MATERIAL_FULL_PREFIX = '/api/ecom-workbench/material/'
/** 产物 id 的合法形状（与后端 `isArtifactId` 同一条规则）。 */
const ARTIFACT_ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 把 `data.reference` 的值解析成「走哪条路由、键是什么」（**纯函数**）。
 *
 * ## 五种形状（一条都不许少 —— 少一种就有一种素材静默失效）
 *
 * | 形状 | 例子 | 谁写的 |
 * |---|---|---|
 * | 素材完整路径 | `/api/ecom-workbench/material/a.png` | `refFromMaterial`（它写的是 `m.url`，不是名字） |
 * | 素材短前缀 | `material/a.png` | 上传替换（`ContentCanvas.tsx:2811`） |
 * | 产物 id | `art-20261026-xxxx` | `refFromNode`、以及老存档 |
 * | 纯名字 | `a.png` | 老存档手填（那时还没有「从列表选」这套） |
 * | 认不出 | `http://…`、空、含 `..` | — |
 *
 * ## ⚠️ 第 3 与第 4 形状**不可区分**
 *
 * `art-xxx` 与 `a.png` 都满足 `ARTIFACT_ID_SHAPE`。所以这里统一判成产物，
 * **取不回时由调用方再当素材名试一次**（`refBase64` 里那条回退）。
 *
 * 那条回退不是补丁，它就是**把这两个形状分开的唯一判据** —— 没有它，
 * 老存档里手填的 `a.png` 会永远取不回。
 *
 * ⚠️ 但回退**只对纯 id 形状生效**：带路径的（第 1、2 种）直接走各自的路。
 * 让一个写错的路径也去「换个路由试一次」，会把「路径写错」变成
 * 「悄悄换条路取到了别的东西」—— 那种错比取不回更难查。
 *
 * ## 为什么不用 `describeReference` 的判据
 *
 * 那个是给**显示**用的：认不出来就回落成原值、不报错（老存档里那个值不该
 * 凭空消失）。这里要的是「认不出来就说取不回」，两者对同一个输入的处理**相反**。
 * 共用一个函数必然把其中一边做坏。
 *
 * @param ref - `data.reference` 的值。
 * @returns 路由与键；认不出给 `null`。
 */
export function refBytes(ref: unknown): RefRoute | null {
  if (typeof ref !== 'string') return null
  const v = ref.trim()
  if (v === '') return null
  /* 含 `..` 的一律不认：这是个名字，不是路径，放它过去就是一次目录穿越。 */
  if (v.includes('..')) return null
  if (v.startsWith(MATERIAL_FULL_PREFIX)) {
    const key = v.slice(MATERIAL_FULL_PREFIX.length)
    return key === '' ? null : { route: 'material', key }
  }
  if (v.startsWith(MATERIAL_SHORT_PREFIX)) {
    const key = v.slice(MATERIAL_SHORT_PREFIX.length)
    return key === '' ? null : { route: 'material', key }
  }
  /* 其余带斜杠的（`http://…`、写错的路径）不认 —— 不许猜。 */
  if (v.includes('/')) return null
  if (!ARTIFACT_ID_SHAPE.test(v)) return null
  return { route: 'artifact', key: v }
}

/**
 * 把一个产物 id 取回来、变成 `refs` 那一项的字节形状（用户 m02814 #60/#61/#63）。
 *
 * ## 为什么界面要自己取一遍
 *
 * `POST /generate` 的 `refs` 要的是**字节**（`{ mime, base64 }`），不是产物 id ——
 * 宿主半要把它们原样喂给 ComfyUI 的上传槽位。所以界面先 `GET /artifact/<id>`
 * 拿回来、再 base64（与「加素材库」那条工具条动作同一条做法）。
 *
 * ⚠️ 取不到就**报错**，不许静默跳过：`refs` 为空时后端会用占位图而任务照样成功，
 * 那是最难发现的一种失败（不报错、结果不对）。
 *
 * @param id - 产物 id。
 * @param mime - MIME（不给按 `image/png` 算）。
 * @returns 那一项；失败给原因。
 */
export async function artifactBase64(
  id: string,
  mime: string = 'image/png',
): Promise<ApiResult<{ mime: string, base64: string }>> {
  if (id === '') return { ok: false, error: '没有底图（产物 id 是空的）' }
  /* 薄壳：取字节那一层（`fetchRef`）只有一份，这里只把「走产物路由」钉死。
   *
   * ⚠️ 这里**故意不走 `refBase64`**：那个函数有一条「产物 404 就再当素材名试一次」
   * 的回退，那是给 `data.reference`（形状不可区分）用的。
   * 本函数的入参**明确就是产物 id**，没有不确定可言 —— 跟着回退的话，
   * 既有多出来的那次请求，话术也会从「取不回底图：宿主半返回 404」
   * 变成「两条路都试过了」，那是既有调用方的可见变化（自证时抓到的）。 */
  return fetchRef({ route: 'artifact', key: id }, '底图', mime)
}

/**
 * 素材名 → 可下载的地址。
 * @param name - 素材名（含扩展名）。
 * @returns 地址（宿主半的二进制路由）。
 */
export function materialHref(name: string): string {
  return '/api/ecom-workbench/material/' + encodeURIComponent(name)
}

/**
 * 把一个参考图的值取回来、变成 `refs` 那一项的字节形状（票 71，2026-10-29）。
 *
 * ## 全仓**只有这一处**取参考图字节
 *
 * 票 71 之前只有 `artifactBase64`（产物那条），素材根本没有取字节的函数。
 * 要是在旁边再写一个 `materialBase64`，调用方就要在两处之间选 ——
 * 而这个仓库的教训是「同一件事写两份必然漂」（`pitfalls/同一件事写两份迟早漂.md`）。
 * 所以：一处 `refBytes` 判形状 + 一处 `refBase64` 取字节，别的都是薄壳。
 *
 * ## `label` **只影响话术，不参与任何分支**
 *
 * ⚠️ 这一句是硬要求，别在将来改坏：判形状只由 `refBytes` 一处决定。
 * 谁要是为了「首帧走另一条路」在下面某个 `if` 里加判断，两件事就混了 ——
 * 表现是「某种形状的参考图在某个节点上取不回」，而判据看起来还在。
 *
 * label 的用处只有一个：错误话术里那个词。同一个值在底图那条路上说「底图」，
 * 在参考图那条路上说「参考图」—— 说错了用户会去找错的东西。
 *
 * @param ref - `data.reference` 的值（五种形状见 `refBytes`）。
 * @param label - 这次取的是什么（「底图」/「参考图」/「首帧」）。
 * @param mime - MIME（不给按 `image/png` 算）。
 * @returns 那一项；失败给原因（点名是哪一张、试过哪条路）。
 */
export async function refBase64(
  ref: unknown,
  label: string,
  mime: string = 'image/png',
): Promise<ApiResult<{ mime: string, base64: string }>> {
  const isLabel = label === '' ? '图' : label
  const one = refBytes(ref)
  if (one === null) {
    return {
      ok: false,
      error: '这条' + isLabel + '的取值认不出来（既不是产物编号，也不是素材名）：'
        + (typeof ref === 'string' && ref.trim() !== '' ? ref : '（空）')
        + '。到节点设置里重新选一次。',
    }
  }
  const first = await fetchRef(one, isLabel, mime)
  if (first.ok) return first
  /* ⚠️ 回退：**只对纯 id 形状生效**（`refBytes` 判成 artifact 的那些）。
   *
   * 理由：产物 id 与老存档手填的纯名字**形状不可区分**（都满足 `ARTIFACT_ID_SHAPE`）。
   * 老存档里 `a.png` 那种手填值本来就是素材名 —— 不试一次等于
   * 「升级之后老画布突然用不了」，而它本来能用。
   *
   * 带路径的（`/api/…/material/x`、`material/x`）**不走这条**：
   * 那会把「路径写错」变成「悄悄换条路取到了别的东西」。 */
  if (one.route === 'artifact') {
    const again = await fetchRef({ route: 'material', key: one.key }, isLabel, mime)
    if (again.ok) return again
    return {
      ok: false,
      error: '取不回这条' + isLabel + '（' + one.key + '）：产物与素材两条路都试过了。'
        + '它可能已经被删掉 —— 到节点设置里重新选一次。',
    }
  }
  return first
}

/**
 * 按解析好的路由真的去取字节（`refBase64` 内部用，**不导出**）。
 *
 * ## 为什么单独一层
 *
 * `refBase64` 那条回退要**试第二条路**，两条路共用同一段「fetch → 转 base64 →
 * 失败说原因」。写两遍就是两份会漂的逻辑。
 *
 * @param one - 解析好的路由。
 * @param label - 话术里那个词。
 * @param mime - MIME。
 * @returns 字节；失败给原因。
 */
async function fetchRef(
  one: RefRoute,
  label: string,
  mime: string,
): Promise<ApiResult<{ mime: string, base64: string }>> {
  const url = one.route === 'material' ? materialHref(one.key) : artifactHref(one.key)
  let res: Response
  try {
    res = await fetch(url)
  } catch (e) {
    return { ok: false, error: '取不回' + label + '：' + (e instanceof Error ? e.message : String(e)) }
  }
  if (!res.ok) return { ok: false, error: '取不回' + label + '：宿主半返回 ' + String(res.status) }
  try {
    const buf = await res.arrayBuffer()
    return { ok: true, data: { mime, base64: bytesToBase64(new Uint8Array(buf)) } }
  } catch (e) {
    return { ok: false, error: '读不出' + label + '字节：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/* ── 节点的三个运行态（契约 CH）─────────────────────────────────────
 *
 * ## 为什么**不**塞进 `data`
 *
 * `data` 是**要存进画布文件**的形状。生成到一半的状态存进去，下次打开画布
 * 会看到一个永远转圈的节点 —— 而那次生成早随进程重启没了（任务只在内存里，
 * 见 `src/index.ts:1605` 那段注释）。所以运行态住在 React 状态里，不落盘。
 */

/** 节点现在的运行态。 */
export type NodeRunState =
  | { kind: 'idle' }
  | { kind: 'running', taskId: string, waitedMs: number }
  | { kind: 'failed', error: string, retry: SubmitGenInput }

/**
 * 「已等 N 秒」的文案。
 *
 * ⚠️ **不给百分比**（用户 m01114 定过，参考项目也没有）。后台跑多久是黑盒，
 * 编一个百分比等于骗人；秒数是能真实数出来的。
 *
 * @param waitedMs - 已经等了多久（毫秒，**后端算的**）。
 * @returns 文案。
 */
export function waitedText(waitedMs: number): string {
  const s = Math.max(0, Math.floor(waitedMs / 1000))
  if (s < 60) return '已等 ' + String(s) + ' 秒'
  return '已等 ' + String(Math.floor(s / 60)) + ' 分 ' + String(s % 60) + ' 秒'
}

/**
 * 字节 → base64（不含 `data:` 前缀）。
 *
 * 为什么不用 `btoa(String.fromCharCode(...bytes))`：一次展开几万个参数会爆栈
 * （大图几十 MB）。这里按 8 KB 一段分块拼，稳妥。
 *
 * @param bytes - 字节。
 * @returns base64 字符串。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x2000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

/**
 * 触发一次浏览器下载（产物 id → 二进制路由）。
 *
 * 为什么不用 `window.open`：产物是图片 / 视频，浏览器会**在新标签里打开它**而不是
 * 下载 —— 用户点了「下载」却看到一张图铺满屏幕，会觉得点错了。
 *
 * @param href - 地址。
 * @param filename - 存成什么名字。
 */
export function triggerDownload(href: string, filename: string): void {
  const a = document.createElement('a')
  a.href = href
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

/* ── 键盘与选中（契约 CD，用户 m01076）─────────────────────────────────
 *
 * ## 为什么这些是纯函数而不是写在组件里
 *
 * 「焦点在输入框里时**完全不接管**键盘」这条判据是这一单最要紧的一条
 * （`WorkflowCanvas.tsx:2606-2610` 那里已经踩过一次：不拦的话用户在参数里打字会被吃掉）。
 * 它是一条**规则**，不是一段交互；写在组件里就只能靠「挂上去按一下」来验。
 *
 * 抽成 `typingTarget` 之后，「textarea 里按 Delete 不删节点」可以真的被断言。
 */

/**
 * 这个键盘事件的目标是不是**正在输入**。
 *
 * ⚠️ 它命中时调用方必须**完全不接管**（连 `preventDefault` 都不要做）。
 *
 * 三种都要算：`INPUT`（单行）、`TEXTAREA`（多行）、`isContentEditable`（富文本）。
 * 只判前两种的话，将来某个可编辑区就会被吃掉按键。
 *
 * @param target - 事件目标（可能是 null / 非元素）。
 * @returns 正在输入给 true。
 */
export function typingTarget(target: unknown): boolean {
  if (target === null || target === undefined) return false
  if (typeof target !== 'object') return false
  const t = target as { tagName?: unknown, isContentEditable?: unknown }
  const tag = typeof t.tagName === 'string' ? t.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return t.isContentEditable === true
}

/** 快捷键动作（纯数据，便于逐条断言）。 */
export type CanvasAction =
  | 'delete' | 'escape' | 'selectAll' | 'copy' | 'paste' | 'duplicate'
  | 'group' | 'undo' | 'redo' | 'zoomIn' | 'zoomOut' | 'zoomReset'
  /**
   * 按住空格 = 临时切「抓手 / 平移」（用户 m02814，照 Figma / PS 的手感）。
   *
   * ⚠️ **按下与松开是两个动作，不是一个**。如果只回 `'panHold'`，
   * 按一下就切过去、松开再也回不来 —— 那是「一次性」的坏手感。
   */
  | 'panHold'
  /** 松开空格 = 恢复按住之前那个工具。 */
  | 'panRelease'

/**
 * 把一个键盘事件翻译成画布动作。
 *
 * ## 为什么单独一个函数（而不是在 handler 里一串 if）
 *
 * 九个快捷键要**逐条断言**（验收 2）。翻译规则抽出来之后，
 * 每条断言只需要造一个事件对象问它「该做什么」，不用挂画布、不用点 DOM。
 *
 * ## 焦点在输入框里 → 一律 null
 *
 * 这条在最前面，任何键都拦不住它 —— 见 `typingTarget` 的说明。
 *
 * @param e - 一个长得像 KeyboardEvent 的对象（只用到几个字段）。
 * @returns 该做的动作；不该接管给 `null`。
 */
export function shortcutOf(e: {
  key?: string, ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean, target?: unknown,
}): CanvasAction | null {
  if (typingTarget(e.target)) return null
  const k = typeof e.key === 'string' ? e.key : ''
  const mod = e.ctrlKey === true || e.metaKey === true

  /* ★ 空格临时切「抓手 / 平移」（用户 m02814）。
   *
   * ## 为什么放在 `mod` 判断之外
   *
   * 它**不吃 Ctrl**：`Ctrl+空格` 在很多系统里是输入法切换，抢过来会让人打不出字。
   * 所以 Ctrl / Cmd 按着时**不认空格**（下面 `!mod` 分支才不会走到）。
   *
   * ## 为什么 `key` 要认两种
   *
   * 空格键的 `event.key` 在不同环境里是 `' '`（现代浏览器、含 jsdom）
   * 或 `'Spacebar'`（很老的 Edge / IE）。`event.code` 才是 `'Space'`，
   * 但 `shortcutOf` 的入参里没有 `code` —— 加它要改一批调用点，
   * 而 `' '` 与 `'Spacebar'` 两种已经盖住实际会遇到的。
   *
   * ## 按下与松开
   *
   * 这里只处理**按下**。松开由调用方在 `keyup` 里单独判（返回 `'panRelease'`）——
   * 因为「一个函数同时翻两个方向」要靠 event.type，而 `shortcutOf` 的入参里
   * 没有 type（加进去会让九条既有断言都得传它）。见下方的 `isPanReleaseKey`。 */
  if (!mod && (k === ' ' || k === 'Spacebar')) return 'panHold'

  if (!mod) {
    if (k === 'Delete' || k === 'Backspace') return 'delete'
    if (k === 'Escape') return 'escape'
    return null
  }
  const low = k.toLowerCase()
  if (low === 'z') return e.shiftKey === true ? 'redo' : 'undo'
  if (low === 'y') return 'redo'
  if (low === 'a') return 'selectAll'
  if (low === 'c') return 'copy'
  if (low === 'v') return 'paste'
  if (low === 'd') return 'duplicate'
  if (low === 'g') return 'group'
  /* `+` 要按 Shift 才打得出来，所以 `=` 与 `+` 都收（照执行画布的做法）。 */
  if (k === '=' || k === '+') return 'zoomIn'
  if (k === '-') return 'zoomOut'
  if (k === '0') return 'zoomReset'
  return null
}

/**
 * 这次 `keyup` 是不是「松开空格」（→ `'panRelease'`）。
 *
 * ## 为什么单独一个函数、而不是塞进 `shortcutOf`
 *
 * `shortcutOf` 只看「按了什么键」，不看「按下还是松开」——
 * 它的入参里没有 `event.type`，加进去会让九条既有断言都得跟着传一个 type。
 * 而「松开」只需要判两件事：**是空格** + **光标不在输入框里**。
 *
 * ⚠️ **不判 `typingTarget` 的后果**：在输入框里松开空格也会走 `panRelease`，
 * 而那时画布根本没切过（`panHold` 被 `typingTarget` 拦掉了）→ 会白恢复一次。
 * 恢复本身幂等，不会有可见问题，但**判掉更干净**：没切过就不该有「恢复」这个动作。
 *
 * @param e - 长得像 KeyboardEvent 的对象（只用到 key 与 target）。
 * @returns 是松开空格给 true。
 */
export function isPanReleaseKey(e: { key?: string, target?: unknown }): boolean {
  if (typingTarget(e.target)) return false
  const k = typeof e.key === 'string' ? e.key : ''
  return k === ' ' || k === 'Spacebar'
}

/** 复制缓冲区（模块级，与执行画布同一个思路：剪切板不是 React 状态）。 */
let clipboard: ContentNode[] = []

/**
 * 复制一批节点到内部缓冲区（不动系统剪贴板）。
 *
 * 为什么不用系统剪贴板：节点是对象，写进去要序列化、读回来要校验；
 * 而「画布内复制粘贴」从来只在一个画布内用，系统剪贴板反而会粘进别的应用。
 *
 * @param nodes - 要复制的节点（只取传进来的那些）。
 * @returns 复制了几个。
 */
export function copyNodes(nodes: readonly ContentNode[]): number {
  clipboard = nodes.map(n => ({ ...n, position: { ...n.position }, data: { ...n.data } }))
  return clipboard.length
}

/** 缓冲区里有几个（测试与「粘贴」按钮的可用性判据）。 */
export function clipboardSize(): number {
  return clipboard.length
}

/**
 * 把缓冲区里的节点粘出来（每粘一次往右下错开一点，避免完全叠住）。
 *
 * @param offset - 错开多少像素。
 * @returns 新节点（id 全是新的）。
 */
export function pasteNodes(offset = 32): ContentNode[] {
  const out = clipboard.map(n => ({
    ...n,
    id: newNodeId(n.type),
    position: { x: n.position.x + offset, y: n.position.y + offset },
    data: { ...n.data },
  }))
  /* 粘出来的那一批成为新的缓冲区：连按两次 Ctrl+V 得到的是错开的第二份，
   * 而不是在同一个位置叠两层。 */
  clipboard = out.map(n => ({ ...n, position: { ...n.position }, data: { ...n.data } }))
  return out
}

/**
 * 原地复制（Ctrl+D）：不经过缓冲区，直接在原节点右下方各长一个。
 * @param nodes - 要复制的节点。
 * @param offset - 错开多少像素。
 * @returns 新节点。
 */
export function duplicateNodes(nodes: readonly ContentNode[], offset = 24): ContentNode[] {
  return nodes.map(n => ({
    ...n,
    id: newNodeId(n.type),
    position: { x: n.position.x + offset, y: n.position.y + offset },
    data: { ...n.data },
  }))
}

/** 清空复制缓冲区（换画布时用，免得把上一份的节点粘过来）。 */
export function clearClipboard(): void {
  clipboard = []
}

/**
 * 改一个节点的尺寸。
 *
 * 尺寸有下限：缩到 0 会让节点在画布上彻底消失，用户只会以为「节点没了」。
 *
 * @param nodes - 当前节点。
 * @param id - 改哪个。
 * @param width - 新宽（px）。
 * @param height - 新高（px）。
 * @returns 新节点数组。
 */
export function resizeNode(
  nodes: readonly ContentNode[],
  id: string,
  width: number,
  height: number,
): ContentNode[] {
  const w = Math.max(MIN_NODE_SIZE, Math.round(width))
  const h = Math.max(MIN_NODE_SIZE, Math.round(height))
  return nodes.map(n => (n.id === id ? { ...n, width: w, height: h } : n))
}

/** 节点尺寸下限（px）。 */
export const MIN_NODE_SIZE = 48

/**
 * 改一个节点的显示名。
 * @param nodes - 当前节点。
 * @param id - 改哪个。
 * @param title - 新名字（空串 = 清掉，回落成类型名）。
 * @returns 新节点数组。
 */
export function renameNode(nodes: readonly ContentNode[], id: string, title: string): ContentNode[] {
  const t = title.trim()
  return nodes.map(n => {
    if (n.id !== id) return n
    const next = { ...n }
    if (t === '') delete next.title
    else next.title = t
    return next
  })
}

/**
 * 节点的显示名（没起名时用类型名）。
 * @param n - 节点。
 * @returns 名字。
 */
export function nodeLabel(n: ContentNode): string {
  const t = (n.title ?? '').trim()
  if (t !== '') return t
  return TYPE_LABEL[n.type]
}

/** 类型的显示名。 */
export const TYPE_LABEL: Readonly<Record<ContentNodeType, string>> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
  /* ★ 显示名改成「综合」（用户 m03414：「『生成配置』改名『综合』」）。
   *
   * ⚠️ **只改显示名**，存档里仍是 `type: 'config'` —— 动了类型值老存档全废。 */
  config: '综合',
  group: '分组',
  batch: '批量',
}

/**
 * 全选 / 取消全选。
 *
 * ⚠️ 泛型而不是 `ContentNode`：`selected` 是 **React Flow 的运行态**，
 * 不属于存盘形状（`ContentNode` 里没有这个字段，存进去下次读回来会带着上一轮的选中态）。
 * 所以这个函数只对「有 `selected` 的那种节点」生效，由调用方传 React Flow 的节点进来。
 *
 * @param nodes - 当前节点。
 * @param on - true = 全选，false = 全部取消。
 * @returns 新节点数组。
 */
export function setAllSelected<T extends { selected?: boolean }>(nodes: readonly T[], on: boolean): T[] {
  return nodes.map(n => ({ ...n, selected: on }))
}

/* ── 节点设置面板：宽度三档与位置（用户 m03414）───────────────
 *
 * 用户原话：「点击节点后设置的位置不对，不应该是按照画布坐标出现，
 * 我们不是默认画布全屏要改一下，点击节点后节点设置出现在节点下方，
 * 宽度定 3 档按照画布显示宽度自动调整。」
 *
 * 两件事分开算：宽度由画布**可用宽度**决定；位置由节点的**屏幕坐标**
 * 与可视区高度决定。两者都不能随画布缩放变化 —— 面板是 DOM，不在
 * React Flow 的 viewport 变换里，这正是用户要的。
 */

/* 面板宽度三档已挪到 `lib/canvas/canvas-prefs.ts`（它们是设置），这里转导一下。 */
export { PANEL_WIDTHS } from './lib/canvas/canvas-prefs.ts'
import { PANEL_WIDTHS, type PanelWidthChoice } from './lib/canvas/canvas-prefs.ts'

/**
 * 按画布可用宽度选一档（**纯函数**，判据 3 落在这里）。
 *
 * 三个分界：
 * · `< 720`：窄（侧栏开着就这么窄）→ 260，再宽就遮住节点了；
 * · `720 – 1100`：常见窗口 → 320；
 * · `≥ 1100`：宽屏 → 380。
 *
 * ⚠️ 不能写成「窗口宽的百分比」——面板过宽会把节点自己盖住，
 * 而节点宽度不跟窗口走。
 *
 * @param canvasWidth - 画布容器的实际宽度（px）。
 * @param choice - 用户选的档位（`'auto'` = 按画布宽度自动；给数字 = 固定那一档）。
 * @returns 三档里的一档。
 */
export function panelWidthFor(canvasWidth: number, choice: PanelWidthChoice = 'auto'): number {
  /* ★ 固定档**不吃画布宽度**：用户明确选了 380，就该是 380 ——
   * 画布再窄也不缩（那是「按画布自动」这一档才管的事）。 */
  if (typeof choice === 'number' && PANEL_WIDTHS.includes(choice)) return choice
  if (!Number.isFinite(canvasWidth) || canvasWidth <= 0) return PANEL_WIDTHS[1]
  if (canvasWidth < 720) return PANEL_WIDTHS[0]
  if (canvasWidth < 1100) return PANEL_WIDTHS[1]
  return PANEL_WIDTHS[2]
}

/** 面板放哪儿（相对画布容器的 left/top）。 */
export interface PanelPlacement {
  /** 左边（已居中并挤进界内）。 */
  left: number
  /** 上边（已算上翻转与夹取）。 */
  top: number
  /** 是否往上翻了（供测试与调试看）。 */
  flipped: boolean
}

/**
 * 计算面板放哪儿（**纯函数**，判据 3 的另一半）。
 *
 * 三条规则：
 * 1. **水平居中在节点下方** —— 面板中心 = 节点横向中心；
 * 2. **不许出左右边** —— 靠墙时往里挤；
 * 3. **底部放不下就往上翻** —— 否则节点在屏幕底部时面板跑出可视区，
 *    用户会以为“没点上”。
 *
 * @param anchor - 节点底边中点在画布容器内的坐标。
 * @param nodeTop - 节点顶边的纵坐标（往上翻时用）。
 * @param size - `{ w, h }` 面板尺寸，`{ boxW, boxH }` 画布可视尺寸。
 * @returns 放哪儿。
 */
export function panelPlacement(
  anchor: { x: number, y: number },
  nodeTop: number,
  size: { w: number, h: number, boxW: number, boxH: number },
): PanelPlacement {
  const gap = 12
  const EDGE = 8
  /* 水平：先居中，再挤进左右界内。 */
  let left = anchor.x - size.w / 2
  if (left + size.w > size.boxW - EDGE) left = size.boxW - EDGE - size.w
  if (left < EDGE) left = EDGE
  /* 垂直：先放下方。 */
  const below = anchor.y + gap
  if (below + size.h <= size.boxH - EDGE) {
    return { left, top: below, flipped: false }
  }
  /* 放不下 → 改放节点上方；上面也不够就贴顶。 */
  const above = nodeTop - gap - size.h
  return { left, top: Math.max(EDGE, above), flipped: true }
}

/* ── 画布背景的四个数（用户 m03414）────────────────────────────
 *
 * 用户原话：「线格过于明显过于密集，间距增加 4 倍、（透明度）下降」。
 *
 * 为什么放在这里而不是直写在 JSX 里：它们是**可验的数**，而 `tests/` 能
 * 直接 import 这个文件（不用挂画布）。线格与点阵的差异就是一条断言。
 */

/** 点阵间距（原样，未动）。 */
export const DOT_GAP = 18
/** 点阵点的直径（原样，未动）。 */
export const DOT_SIZE = 1
/** 线格间距 = 点阵的 **4 倍**（18×4=72）。 */
export const LINE_GAP = DOT_GAP * 4
/** 线格线宽：比点阵细，否则 72px 一格的线反而更抢眼。 */
export const LINE_SIZE = 0.6
/* ── 线格颜色常量：**已退役**（用户 m01921）─────────────────────────
 *
 * 这里原来是
 * `export const LINE_COLOR = 'color-mix(in srgb, var(--v1-edge) 20%, transparent)'`。
 *
 * 为什么退役：用户要求「画布设置里的线格深浅真的生效」。那个 20% 从常量变成
 * 设置项 `prefs.lineOpacity`，取色改走 `lineColorOf()`（`canvas-prefs.ts`）——
 * 常量留着就是**死代码**，而且是个陷阱：下一个人改它以为调了线格深浅，
 * 实际界面用的是设置里那个值。
 *
 * 默认 `lineOpacity = 0.2` 时 `lineColorOf(0.2)` 的输出与这个常量**逐字相同**，
 * 所以默认外观一字未变。
 */

/* ── 左侧栏的筛选：**已退役**（用户 m03414）───────────────────────
 *
 * 这里原来有 `FILTER_TYPES` / `nodeMatches` / `filterNodes` 三个导出，
 * 专为侧栏那个「节点」格服务。用户要求删掉那个格
 * （「左侧栏不需要节点，顶部有所有节点了」），它们就没有调用点了。
 *
 * **留着死代码比删掉更糟**：下一个人看到导出会以为还有一处在用，
 * 而真正的「找节点」入口已经只剩顶部工具栏与画布上直接点。
 *
 * ⚠️ 不要因为「将来可能要筛选」而把它们加回来 —— 真要用的时候现写，
 * 到那时的需求形状大概率不一样。代码库里不存在“以备不时之需”的导出。
 */

/* ── 编组（契约 CE，用户 m01076「按参考项目的模式改」）─────────────── */

/**
 * 存盘节点 → 几何层认的形状。
 *
 * 几何层（`group-geometry.ts`）只认 `id / type / position / width / height / data.groupId`，
 * 不认 `ContentNode` 的其它字段 —— 这是刻意的：那一份能从执行画布与内容画布**两边**
 * 共用，只认最小交集。所以这里做一次显式换算，而不是让几何层去认两种节点。
 *
 * @param n - 存盘节点。
 * @returns 几何层节点。
 */
export function toGeo(n: ContentNode): GeoNode {
  const size = sizeOf(n)
  return {
    id: n.id,
    type: n.type,
    position: { x: n.position.x, y: n.position.y },
    width: size.width,
    height: size.height,
    data: { groupId: n.data.groupId },
  }
}

/**
 * 几何层节点 → 存盘节点。
 *
 * ⚠️ **只回写归属与框的位置尺寸**，不重建整个节点 —— 几何层手里那份没有
 * `data.text` / `data.prompt` 这些东西，重建会把用户的内容抹掉。
 *
 * @param orig - 原来的存盘节点。
 * @param geo - 几何层算出来的同一 id 的节点。
 * @returns 新的存盘节点。
 */
export function fromGeo(orig: ContentNode, geo: GeoNode): ContentNode {
  const next: ContentNode = { ...orig, position: { x: geo.position.x, y: geo.position.y } }
  if (geo.width !== undefined) next.width = geo.width
  if (geo.height !== undefined) next.height = geo.height
  const gid = geo.data?.groupId
  if (gid === undefined || gid === '') {
    if (next.data.groupId !== undefined) {
      const data = { ...next.data }
      delete data.groupId
      next.data = data
    }
    return next
  }
  if (next.data.groupId !== gid) next.data = { ...next.data, groupId: gid }
  return next
}

/**
 * 按几何层的结果整片回写（节点数不变，只改位置 / 尺寸 / 归属）。
 * @param before - 原节点。
 * @param after - 几何层算出来的节点（同 id 集合）。
 * @returns 新节点数组。
 */
export function applyGeo(before: readonly ContentNode[], after: readonly GeoNode[]): ContentNode[] {
  const byId = new Map(after.map(g => [g.id, g]))
  return before.map(n => {
    const g = byId.get(n.id)
    return g === undefined ? n : fromGeo(n, g)
  })
}

/**
 * 把选中的节点编成一个组。
 *
 * ## 与执行画布那条「连贯」规则的区别
 *
 * 执行画布编组时会先 `closeUnderTransit` 补上「夹在中间」的节点（用户 2026-10-11 定的
 * 「编组必须满足连贯」）。内容画布**不补** —— 这里的节点之间没有数据流，
 * 「夹在中间」没有意义；用户框了哪几块就编哪几块。
 *
 * @param nodes - 全部节点。
 * @param ids - 要编进去的节点 id（至少 2 个才有意义）。
 * @param name - 组名（空则用「分组」）。
 * @returns 新节点数组 + 新组 id；不够 2 个成员时原样返回、组 id 为空串。
 */
export function groupNodes(
  nodes: readonly ContentNode[],
  ids: readonly string[],
  name = '',
): { nodes: ContentNode[], groupId: string } {
  const wanted = new Set(ids)
  /* 组不能进组（参考项目同样不支持）—— 也顺便挡住「把框自己编进去」。 */
  const members = nodes.filter(n => wanted.has(n.id) && n.type !== 'group')
  if (members.length < 2) return { nodes: [...nodes], groupId: '' }
  const gid = newNodeId('g')
  const made = createGroupFromNodes(gid, members.map(toGeo), name)
  const groupNode: ContentNode = {
    id: gid,
    type: 'group',
    position: { x: made.group.position.x, y: made.group.position.y },
    width: made.group.width,
    height: made.group.height,
    title: name.trim() === '' ? undefined : name.trim(),
    data: {},
  }
  /* 组排在最前 —— 与 `migrateRosterGroups` 同一个取法：渲染时要让框在成员底下。 */
  const withMembers = applyGeo(nodes, made.nodes)
  return { nodes: [groupNode, ...withMembers], groupId: gid }
}

/**
 * 解散一个组：删掉组节点 + 清成员的归属。
 * @param nodes - 全部节点。
 * @param groupId - 组 id。
 * @returns 新节点数组。
 */
export function ungroupNodes(nodes: readonly ContentNode[], groupId: string): ContentNode[] {
  const kept = nodes.filter(n => n.id !== groupId)
  return applyGeo(kept, ungroupCanvasGroup(groupId, kept.map(toGeo)))
}

/**
 * 点「适应成员」：把框缩到刚好包住成员。
 * @param nodes - 全部节点。
 * @param groupId - 组 id。
 * @returns 新节点数组。
 */
export function fitGroup(nodes: readonly ContentNode[], groupId: string): ContentNode[] {
  return applyGeo(nodes, fitGroupToEnclosedChildren(groupId, nodes.map(toGeo)))
}

/**
 * 点「收纳框内的节点」：几何上落在框里的都归进来。
 * @param nodes - 全部节点。
 * @param groupId - 组 id。
 * @returns 新节点数组 + 这次收进去几个。
 */
export function captureIntoGroup(
  nodes: readonly ContentNode[],
  groupId: string,
): { nodes: ContentNode[], captured: number } {
  const r = captureEnclosedNodesIntoGroup(groupId, nodes.map(toGeo))
  return { nodes: applyGeo(nodes, r.nextNodes), captured: r.capturedCount }
}

/**
 * 拖动结束之后同步归属（拖进框 → 归入；拖出框 → 脱离）。
 *
 * 三件事由 `syncGroupMembershipAfterTransform` 负责，这里只做「哪些组要重算」的分派：
 * 被拖的是**某个组本身** → 重算那个组；被拖的是**普通节点** → 给每个组都重算一遍
 * （因为拖出去的节点可能落进别的组）。
 *
 * @param nodes - 拖完之后的全部节点。
 * @param movedIds - 这次被拖的节点 id。
 * @returns 新节点数组。
 */
export function syncGroupsAfterDrag(nodes: readonly ContentNode[], movedIds: readonly string[]): ContentNode[] {
  const moved = new Set(movedIds)
  const groupIds = nodes.filter(n => n.type === 'group').map(n => n.id)
  if (groupIds.length === 0) return [...nodes]
  const draggedGroups = groupIds.filter(id => moved.has(id))
  if (draggedGroups.length > 0) {
    let cur = [...nodes]
    for (const gid of draggedGroups) cur = applyGeo(cur, syncGroupMembershipAfterTransform(gid, cur.map(toGeo)))
    return cur
  }
  /* 普通节点：先算「落进了哪个组」，再清掉原来那个组里的过期归属。 */
  const geo = nodes.map(toGeo)
  const nextGeo = geo.map(g => {
    if (!moved.has(g.id) || g.type === 'group') return g
    const gid = findContainingGroupId(g, geo)
    if (gid === g.data?.groupId) return g
    return { ...g, data: { ...g.data, groupId: gid } }
  })
  return applyGeo(nodes, nextGeo)
}

/**
 * 组节点里现在有几个成员。
 * @param nodes - 全部节点。
 * @param groupId - 组 id。
 * @returns 成员数。
 */
export function groupMemberCount(nodes: readonly ContentNode[], groupId: string): number {
  return nodes.filter(n => n.data.groupId === groupId).length
}

/* ── 参考图 / 首帧（契约 CJ）─────────────────────────────────────
 *
 * ## 为什么要有这一段
 *
 * 原来面板上这一格是**让用户手填产物 id 的输入框**（`placeholder="产物 id（留空表示不用）"`）。
 * 校核报告点出来的原话是「用户根本不知道自己那张图的 id 是什么（那串 `art-xxxx.png`
 * 他从来没见过）」——那是个**看着有、实际用不了**的字段。
 *
 * 所以界面改成「从列表里挑一张」，但**存档形状一个字节都不动**：`data.reference`
 * 仍然是一个字符串（不改成对象、不改字段名），老存档里有什么值就照读什么值。
 *
 * ## ⚠️ 这个值**不是**「只有产物 id」—— 它有五种形状
 *
 * 这一段原先写着「仍然是产物 id 字符串（不是名称、不是网址）」，那是**假的**：
 * 紧接下面 `RefChoice.id` 的注释说「素材名进 `data.reference`」，而
 * `refFromMaterial` 实际写的是 `m.url`（带 `/api/ecom-workbench/material/` 前缀的
 * **完整路径**）。三处说法互相打架，漂了很久。
 *
 * 2026-10-29（票 71）以**代码实际行为**为准重写：五种形状全部收进
 * `refBytes` 一处（那里有完整表格）。一句话概括：
 *
 * ```
 * 素材完整路径 /api/ecom-workbench/material/x.png   ← refFromMaterial 写的
 * 素材短前缀   material/x.png                       ← 上传替换写的
 * 产物 id      art-20261026-xxxx                    ← refFromNode 写的、老存档
 * 纯名字       a.png                                ← 老存档手填
 * 认不出       http://… / 空 / 含 ..                 ← 报错，不猜
 * ```
 *
 * 为什么不统一成「只许产物 id」：那要先有「素材 → 产物」的转换接口（后端还没有），
 * 而且会让已有素材的选择全部失效。真要统一是另一票的事。
 */

/**
 * 一张可当参考图的候选（素材库的一项，或画布上某个节点的产物）。
 *
 * ⚠️ 两条来源的 `id` 含义**不同**，这是有意的、也是这一块最容易搞错的地方：
 *   · 来自**素材库**：`id` 是**素材名**（`a.png`），`url` 是 `/material/a.png`；
 *   · 来自**画布上的节点**：`id` 是**产物 id**（`art-xxx`），`url` 是 `/artifact/art-xxx`。
 *
 * 为什么允许素材名进 `data.reference`：`data.reference` 的历史取值本来就是
 * 「能在 `<img src>` 里显示的地址来源」，而素材与产物是两条并列的存储。
 * 真要统一成「只许产物 id」，得先有「素材 → 产物」的转换接口（后端还没有），
 * 那不在本单范围内 —— 见交付里写明的那条缺口。
 */
export interface RefChoice {
  /** 存进 `data.reference` 的那个值。 */
  id: string
  /** 显示用的名字（素材名 / 产物文件名 / 节点标题）。 */
  name: string
  /** 缩略图地址。 */
  url: string
  /** 从哪来的（给界面上分组显示用）。 */
  from: 'material' | 'artifact'
}

/**
 * 素材库的一项 → 参考图候选。
 * @param m - `GET /materials` 返回的一项。
 * @returns 候选。
 */
export function refFromMaterial(m: { name: string, url: string }): RefChoice {
  return { id: m.url, name: m.name, url: m.url, from: 'material' }
}

/**
 * 画布上一个节点 → 参考图候选（**它自己有产物时才给**）。
 *
 * 这条路的用途：用户从画布上就能串起来（「用刚生成的那张当首帧」），
 * 不必先去素材库找一遍。
 *
 * @param n - 画布节点。
 * @returns 候选；节点没有产物时给 `null`。
 */
export function refFromNode(n: ContentNode): RefChoice | null {
  const art = (n.data.artifact ?? '').trim()
  if (art === '') return null
  const name = (n.title ?? '').trim() !== '' ? (n.title as string) : TYPE_LABEL[n.type]
  return { id: art, name, url: artifactHref(art), from: 'artifact' }
}

/**
 * 把 `data.reference` 换成一个候选（或清掉）。
 *
 * ## ⚠️ 清除时写 `undefined`，**不能** `delete`（与 `groupId` 那条规矩不同）
 *
 * 这个值最终是通过**合并**落到节点上的：`{ ...n.data, ...patch }`。
 * 而 `delete patch.reference` **什么也删不掉** —— 补丁对象里没有这个键，
 * 合并时原节点那个键就原样留着。第一版就是这么写的，界面上表现为
 * 「点了移除，参考图还在」。
 *
 * 写 `reference: undefined` 才能让合并结果里它的值是 undefined；
 * 而存档是 `JSON.stringify`，`undefined` 的键会被**整条省略**，
 * 所以存下来同样干净（不会出现 `"reference": null` 那种脏值）。
 *
 * @param data - 原 data。
 * @param choice - 选中的候选；`null` 表示移除。
 * @returns 新 data（不修改入参）。
 */
export function withReference(data: ContentNodeData, choice: RefChoice | null): ContentNodeData {
  if (choice === null || choice.id === '') return { ...data, reference: undefined }
  return { ...data, reference: choice.id }
}

/**
 * 已选的那个参考图**显示成什么**（缩略图 + 名字）。
 *
 * 为什么需要它：`data.reference` 里存的是地址/名字，直接显示给用户是一串
 * `/api/ecom-workbench/material/xx.png` —— 和原来手填 id 一样没法看。
 * 这里把它兜回「能显示的东西」；**认不出来时给名字就是原值**（不给空白，
 * 否则老存档里那个值会凭空消失，用户以为设置丢了）。
 *
 * @param reference - `data.reference` 的值。
 * @param choices - 这次加载到的候选（素材列表 + 画布上的产物）。
 * @returns 显示用的缩略图与名字。
 */
export function describeReference(
  reference: string,
  choices: readonly RefChoice[],
): { url: string, name: string, known: boolean } {
  const hit = choices.find(c => c.id === reference)
  if (hit !== undefined) return { url: hit.url, name: hit.name, known: true }
  /* 认不出来：值是产物 id 就拼产物路由，是路径就原样当图片地址，两者都不是就给文字。 */
  if (/^\/api\//.test(reference)) return { url: reference, name: reference.split('/').pop() ?? reference, known: false }
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(reference)) return { url: artifactHref(reference), name: reference, known: false }
  return { url: '', name: reference, known: false }
}


