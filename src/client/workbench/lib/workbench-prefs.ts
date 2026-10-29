/** 工作台偏好（票 05）：一次生成几张 / 音频默认 / 系统提示词。
 *
 * ## 为什么单独一份，不塞进 `canvas-prefs.ts`
 *
 * 那一份是**画布的**（线格、节点尺寸、面板宽度）—— 它的读取点在画布内部。
 * 这一份是**工作台的**（生图 / 视频 / 音频三格的行为）。两者生命周期一样
 * （都存 localStorage、都可能被手改），但**用处不重叠**。
 * 塞一起的后果是：画布代码为了读一个「生成张数」要把整个画布设置对象拖进来。
 *
 * ## 照 `canvas-prefs.ts` 那套做法（同一份纪律）
 *
 * · 存浏览器本地（`localStorage`，键 `ewb.workbenchPrefs`），不进任何存档；
 * · **读必须容错**：`localStorage` 可能被手改、可能是更早版本存的形状。
 *   抛错会让整个配置页打不开 —— 那比「读回默认值」严重得多；
 * · 每个字段**单独校验**，坏的那一个退回默认，其余照用。
 *
 * ## 三条判定（本票动手前核过的，写在这里免得下一个人重查）
 *
 * | 项 | 我们的链路支不支持 | 本票做了什么 |
 * |---|---|---|
 * | 一次生成几张 `count` | **支持** —— `src/index.ts:1848` 收，`generate.ts:582/694/810` 透传，ComfyUI 填 `batch_size` | 做：工作台打开时按它预填 |
 * | 音频音色 / 格式 / 语速 | **不支持** —— `GenRequest`（`net-gen.ts:61-110`）与 `ComfyBindings`（`comfyui.ts:77-152`）都没有这三个字段；内置音频工作流是 MiniMax Music3（音乐生成），槽位只有 caption / lyrics / seed / duration | **不做开关**，界面上如实说明 |
 * | 系统提示词 | 引擎侧有 `command.system`（`src/index.ts:1177` → 官方 `GenerateOptions.system`），但**全局偏好到不了节点的参数表**（节点参数在存档里，偏好在 localStorage） | 做存储与界面，**界面如实写它还没接进调用** |
 *
 * ⚠️ 「不支持的那两项不做开关」是这张票的核心取舍：一个改了不生效的开关
 * 比没有更糟 —— 用户会以为已经配好了，然后一直查不出为什么没效果。
 */

/** 一次生成几张的上下限。 */
export const COUNT_MIN = 1
export const COUNT_MAX = 4

/** 系统提示词的长度上限（防止一屏塞几 MB 进 localStorage）。 */
export const SYSTEM_PROMPT_MAX = 4000

/** 执行画布的明暗：`null` = 跟随 dsh 主题；其余按用户选的（票 54）。 */
export type CanvasTheme = 'light' | 'dark' | null

/**
 * 内容区限宽的五档（票 69，用户 2026-10-29）。
 *
 * ## 为什么是这五个值
 *
 * `0` = 不限宽（铺满），其余四档是**常见屏幕的阅读宽度**：
 *
 * | 值 | 典型来源 |
 * |---|---|
 * | `0` | 想要铺满的人（超宽屏，或就是想看大图） |
 * | `1200` | 笔记本 13–14 寸的舒适阅读宽 |
 * | `1440` | **缺省**，票 49 用户定的那个数（升级后观感不变） |
 * | `1680` | 2K 屏 |
 * | `1920` | 1080p 满宽 |
 *
 * ⚠️ **不给任意数值输入框**：这一项用户看不出「1387 和 1440 差在哪」，
 * 给了手填只会让人反复试。五档够用，且每一档都能说出它服务谁。
 */
export const CONTENT_MAX_WIDTHS = [0, 1200, 1440, 1680, 1920] as const

/** 一档。 */
export type ContentMaxWidth = typeof CONTENT_MAX_WIDTHS[number]

/** 缺省档（票 49 定的是 1440；升级后界面一个像素都不变）。 */
export const DEFAULT_CONTENT_MAX_WIDTH: ContentMaxWidth = 1440

/** 工作台偏好。 */
export interface WorkbenchPrefs {
  /** 一次生成几张（1–4，默认 1）。生图 / 视频工作台打开时按它预填。 */
  count: number
  /** 系统提示词（默认空串 = 不发这个字段）。 */
  systemPrompt: string
  /**
   * 执行画布的明暗（票 54）。
   *
   * 与内容画布那份 `CanvasPrefs.theme` **同语义、不同存储键** ——
   * 两套偏好是各自独立的 localStorage 键，不能顶替（顶替会让改一边动另一边）。
   * `null` = 跟随 dsh。
   */
  canvasTheme: CanvasTheme
  /**
   * 内容区限宽（票 69，用户 2026-10-29：把写死的 `CONTENT_MAX_WIDTH` 搬进设置）。
   *
   * `0` = 不限宽。取值见 `CONTENT_MAX_WIDTHS`。
   *
   * ⚠️ 为什么塞进**这一份**而不是新开一个 `layout-prefs.json`：
   * 票面写着「先看已有的怎么写的，能加一个字段就加在那里，别新建文件 ——
   * 少一个文件少一处要记的地方」。这一份就是「工作台级偏好」，限宽是其中一项，
   * 生命周期与另外三项完全一样（都存 localStorage、都可能被手改、都要容错）。
   */
  contentMaxWidth: ContentMaxWidth
}

/** 默认值。
 *
 * `count: 1` 与改动前的 `EMPTY_DRAFT.count`（`ImageWorkbench.tsx` 里写死的 `'1'`）
 * **逐字相同** —— 默认设置下界面一个像素都不变。 */
export const DEFAULT_PREFS: WorkbenchPrefs = {
  count: 1,
  systemPrompt: '',
  canvasTheme: null,
  contentMaxWidth: DEFAULT_CONTENT_MAX_WIDTH,
}

/**
 * 把落盘值收成一个合法档位（**坏值回缺省，不抛错**）。
 *
 * ## 为什么不在 `CONTENT_MAX_WIDTHS` 里就回 1440，而不是夹到最近的档
 *
 * 「夹」是一种**猜**：存了 `1500` 时夹到 1440 还是 1680 都说得通，猜错的那一次
 * 用户看到的是「我没设成，但界面显示我设了」。回缺省至少是**诚实**的 ——
 * 而且下一个人看到界面上是 1440、文件里是 1500，能立刻发现是文件被人手改过。
 *
 * ## 为什么 `"1440"` 这种字符串也收
 *
 * `localStorage` 里什么都可能有；早期手改的用户会把数字写成字符串。
 * 能无歧义读成数字就认，认不出来才回缺省。
 *
 * @param v - 落盘值。
 * @returns 合法档位。
 */
export function normalizeContentMaxWidth(v: unknown): ContentMaxWidth {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN)
  if (!Number.isFinite(n)) return DEFAULT_CONTENT_MAX_WIDTH
  return (CONTENT_MAX_WIDTHS as readonly number[]).includes(n)
    ? n as ContentMaxWidth
    : DEFAULT_CONTENT_MAX_WIDTH
}

/** localStorage 的键。 */
export const PREFS_KEY = 'ewb.workbenchPrefs'

/**
 * 把一个数字夹进上下限（容错落盘值）。
 * @param v - 待查值。
 * @param lo - 下界。
 * @param hi - 上界。
 * @param fallback - 不是有限数时用这个。
 * @returns 夹好的整数。
 */
function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

/**
 * 读偏好（**必须容错**）。
 *
 * @param raw - 原始字符串（不传则从 localStorage 读）。
 * @returns 形状保证正确的偏好。
 */
export function readPrefs(raw?: string | null): WorkbenchPrefs {
  let text = raw
  if (text === undefined) {
    try { text = localStorage.getItem(PREFS_KEY) } catch { text = null }
  }
  if (text === null || text === undefined || text.trim() === '') return { ...DEFAULT_PREFS }
  let o: Record<string, unknown>
  try {
    const p = JSON.parse(text) as unknown
    if (p === null || typeof p !== 'object') return { ...DEFAULT_PREFS }
    o = p as Record<string, unknown>
  } catch {
    return { ...DEFAULT_PREFS }
  }
  return {
    count: clampNum(o.count, COUNT_MIN, COUNT_MAX, DEFAULT_PREFS.count),
    systemPrompt: typeof o.systemPrompt === 'string'
      ? o.systemPrompt.slice(0, SYSTEM_PROMPT_MAX)
      : DEFAULT_PREFS.systemPrompt,
    /* 只有明确的 'light' / 'dark' 才认；老存档没这个键 → `null`（跟随 dsh）。 */
    canvasTheme: o.canvasTheme === 'light' || o.canvasTheme === 'dark' ? o.canvasTheme : null,
    /* 票 69：坏值回 1440、不抛错（`normalizeContentMaxWidth` 里说明了为什么不「夹」）。 */
    contentMaxWidth: normalizeContentMaxWidth(o.contentMaxWidth),
  }
}

/**
 * 写偏好（失败静默 —— 存不了不影响这次使用）。
 * @param p - 要存的偏好。
 */
export function writePrefs(p: WorkbenchPrefs): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)) } catch { /* 存不了就跳过 */ }
}

/**
 * 改一项，返回新的一份（**不改原对象**）。
 *
 * 为什么改一项要整份换新：React 的 `useState` 靠引用判断变没变，
 * 原地改字段不会触发重渲染 —— 表现是「点了没反应」。
 *
 * @param cur - 当前偏好。
 * @param patch - 要改的字段。
 * @returns 新的一份。
 */
export function patchPrefs(cur: WorkbenchPrefs, patch: Partial<WorkbenchPrefs>): WorkbenchPrefs {
  return { ...cur, ...patch }
}

/* ── 模块级共享状态 + 订阅（票 69）─────────────────────────────────────
 *
 * ## 为什么需要这一套
 *
 * 「改了下拉**立刻生效**，不用刷新页面」是票面验收第 5 条。设置面板在
 * `ConfigBoard` 里，而限宽用在 `EcomWorkbench` 那一层 —— 两个组件不相邻，
 * 靠 props 传要穿好几层。
 *
 * 本仓库既有的做法就是**模块级状态 + 订阅**（`WorkspaceSettings.tsx:80-141`
 * 的 `useBrowserPrefs` / `subscribeBrowserPrefs` 那一套），照抄它。
 *
 * ## 为什么读的仍是 localStorage，不是新开一份内存
 *
 * 真值来源只能有一个。这份偏好的真值一直就是 `localStorage`（`PREFS_KEY`），
 * 上面加个内存缓存只是为了「改完立刻通知」，不是为了另存一处 ——
 * 每次写都 `writePrefs` 落盘，每次读都从盘上那份 `readPrefs` 起算。
 */

/** 内存里的当前值（订阅者拿到的就是它）。 */
let current: WorkbenchPrefs | null = null

/** 订阅者。 */
const prefListeners = new Set<() => void>()

/**
 * 读当前偏好（**带内存缓存**）。
 *
 * 缓存只在第一次读时从 localStorage 取一次；之后由 `updateWorkbenchPrefs` 维护。
 * 这样做的好处是 `useSyncExternalStore` 的 `getSnapshot` 能拿到**稳定引用**
 * （每次 `readPrefs()` 都新建对象 → 快照永远不等 → 无限重渲染，
 * `EcomWorkbench` 里 `subscribeBoards` 那段注释写的同一个坑）。
 *
 * @returns 当前偏好（引用稳定）。
 */
export function currentWorkbenchPrefs(): WorkbenchPrefs {
  if (current === null) current = readPrefs()
  return current
}

/**
 * 改偏好：更新内存 → 落盘 → 通知订阅者。
 *
 * @param patch - 要改的字段。
 * @returns 新的一份。
 */
export function updateWorkbenchPrefs(patch: Partial<WorkbenchPrefs>): WorkbenchPrefs {
  const next = patchPrefs(currentWorkbenchPrefs(), patch)
  current = next
  writePrefs(next)
  for (const cb of prefListeners) {
    try { cb() } catch { /* 一个订阅者抛错不该拖垮别的 */ }
  }
  return next
}

/**
 * 订阅偏好变化（给 `useSyncExternalStore` 用）。
 *
 * @param cb - 变化时调用。
 * @returns 退订函数。
 */
export function subscribeWorkbenchPrefs(cb: () => void): () => void {
  prefListeners.add(cb)
  return () => { prefListeners.delete(cb) }
}

/**
 * 是不是默认值（用来决定要不要显示「已经改过」）。
 * @param p - 偏好。
 * @returns 全是默认值给 true。
 */
export function isDefaultPrefs(p: WorkbenchPrefs): boolean {
  return p.count === DEFAULT_PREFS.count && p.systemPrompt === DEFAULT_PREFS.systemPrompt
    && p.canvasTheme === DEFAULT_PREFS.canvasTheme
    && p.contentMaxWidth === DEFAULT_PREFS.contentMaxWidth
}

/* ══════════════════════════════════════════════════════════════════════
 * 音频三项：**能力探测**（票 05 判定 ② 的落点）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 音频链路支不支持「音色 / 格式 / 语速」。
 *
 * **写死 `false`，不是留个开关等以后打开。** 理由：
 *
 * 1. `GenRequest`（`net-gen.ts:61-110`）没有这三个字段；
 * 2. `ComfyBindings`（`comfyui.ts:77-152`）的槽位里也没有；
 * 3. 内置的 `audio_minimax_music_3_api.json` 是**音乐生成**（MiniMax Music3），
 *    它的槽位是 `caption` / `lyrics` / `seed` / `duration` —— 音乐生成本来就没有
 *    「音色」这个维度（那是 TTS 的参数）。
 *
 * 所以这三项不是「界面还没做」，是**后端链路里没有这条数据通路**。
 * 做成开关就是假设置：用户配了、看着像生效、实际一个字都没发出去。
 *
 * 这个常量存在的作用是**让判据能断言它** —— 哪天后端接上了，
 * 改这一处、判据跟着红，逼着下一个人把开关一起做出来。
 */
export const AUDIO_EXTRAS_SUPPORTED = false

/** 音频三项不支持的说明（界面原话；判据要断言它出现）。 */
export const AUDIO_EXTRAS_NOTE = '音频链路暂不支持音色、格式、语速这三项：内置音频工作流是音乐生成（MiniMax Music3），它的参数只有提示词（caption）、歌词（lyrics）、种子与时长，没有这三项。要接这三项得先在生成请求与 ComfyUI 槽位里加上对应字段。'

/* ══════════════════════════════════════════════════════════════════════
 * 系统提示词：**接进模型调用了没有**（票 05 判定 ③ 的落点）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 系统提示词有没有真的进模型调用。
 *
 * **写死 `false`。** 理由（核过的，不是推断）：
 *
 * · 引擎侧**有**这条路：`ai.agent` 节点的 `params.system` 非空时会写进命令体
 *   （`src/nodes/ai/agent/node.ts:88-90`），宿主侧 `src/index.ts:1177` 读
 *   `command.system` 塞进官方 `GenerateOptions.system`。这一段是通的。
 * · 但**节点的参数存在画布存档里**（`specs.ts:241` 的 `raw.params`），
 *   而全局偏好在 `localStorage` 里 —— 两者到不了同一个地方。
 *   三层回落（节点填的 → 全局偏好 → 空）要在 `run.ts` 拼，那在 `src/workflow/`，
 *   **不在本票的可改路径**。
 *
 * 所以本票只做「存储 + 界面」，界面上**如实写它还没接上**。
 * 与音频那三项的区别：这三项是**差一段接线**（接线在引擎侧），
 * 音频三项是**差一条数据通路**（后端根本没有这些字段）。
 * 但那句话对用户的含义一样：配了不生效。所以同样不装作能用。
 */
export const SYSTEM_PROMPT_WIRED = false

/** 系统提示词还没接上的说明（界面原话；判据要断言它出现）。 */
export const SYSTEM_PROMPT_NOTE = '这一项还没有接进模型调用：现在保存的是这一段文字，但生成与工作流运行时不会读它。要让它生效，得先在引擎侧加一条回落（节点自己的系统提示词 → 这里的全局值 → 空）。'
