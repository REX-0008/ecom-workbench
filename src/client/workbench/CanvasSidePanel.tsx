/** 画布左侧栏（契约 CD 第四节）。三个 tab：节点清单 / 素材库 / 提示词库。
 *
 * ## 照参考项目的结构
 *
 * `refs-projects/infinite-canvas/web/src/components/canvas/canvas-side-panel.tsx`（771 行）：
 *   · 顶部三个 tab（`:110` 附近，选中态一条下划线）
 *   · 「节点清单」里有类型筛 + 搜索框（`:196-199` 的 `filtered`）
 *   · 右侧一条 `w-4 cursor-col-resize` 的拖宽把手（`:118`）
 *
 * ## 我们换掉了什么（这是我判断的取舍，交付里要报）
 *
 * | 参考项目 | 这里 | 为什么 |
 * |---|---|---|
 * | antd `Input` / `Select` / `Tooltip` | 原生 `<input>` / `<button>` + Tailwind | 项目没引 antd，硬引会让两套样式体系打架（骨架是 Tailwind + CSS Modules） |
 * | `framer-motion` 的 tab 指示器 | 一条静态下划线 | 少一个依赖，少一处动画抖动 |
 * | 分组树（group 折叠） | **未做** | 分组由编组那单（CE）一起做；这里把扁平清单做对，加树是它的活 |
 * | 素材库用本地上传组件 | 调 `/materials` 列目录 | 我们后端已经有那条路由（宿主半定稿） |
 *
 * ## 拖宽为什么只能验状态、不能验手感
 *
 * jsdom 不做布局（`getBoundingClientRect` 恒 0），拖拽位移量不出真实值。
 * 所以这里把「宽度夹在上下限之间」写成**纯函数** `clampPanelWidth`，测试验它；
 * 真机上的拖动手感要人眼。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
/* 收起 / 展开那两个箭头的图标（2026-10-26 用户要求「图标统一」）。
 * 原来是单个字符 `‹` / `›` —— 不同系统字体下粗细与居中都不一样。 */
import { ChevronLeftIcon, ChevronRightIcon } from './icons.tsx'
import { call } from './board-kit.ts'
/* ★ 票 58：素材项那行「类型 · 大小」用现成的格式化（不在这里另写一份换算）。 */
import { humanBytes } from './upload-file.ts'
/* ⚠️ 删掉「节点」格之后，`FILTER_TYPES` / `filterNodes` / `TYPE_LABEL` / `nodeLabel` 都不再需要了 ——
 * 不留它们在 import 里，否则就是「引了却没人用」的死代码。
 * `ContentNode` 仍需：下面的 `nodes` 属性要它的类型。 */
import type { ContentNode } from './content-canvas-store.ts'
/* 拖放载荷（契约 CJ）：侧栏放进去、画布解出来，两边共用同一份编码。 */
import { DRAG_MIME, encodeDrag, type DragPayload } from './content-canvas-store.ts'
import { BUILTIN_PROMPT_SOURCES, allBuiltinEntries, type PromptEntry } from './prompt-sources/index.ts'
import css from './EcomWorkbench.module.css'
/* ★ 票 58：侧栏宽度与折叠状态要跨重启记住 —— 与执行画布那边共用同一份偏好。 */
import { readUiPrefsCache, saveUiPrefs, writeUiPrefsCache, type UiPrefs } from './dispatch-client.ts'

/**
 * 侧栏两个 tab（用户 m03414：「左侧栏不需要节点，顶部有所有节点了」）。
 *
 * 原来有第三个「节点」格（节点清单 + 类型筛 + 搜索），
 * **与顶部工具栏重复** —— 两处都能定位节点。删掉侧栏那个。
 *
 * ⚠️ 删掉之后 `filterNodes` / `FILTER_TYPES` **也一并退役了**：
 * 它们只为那个格服务（全仓搜过，没有别的调用点）。
 * 留着就是死代码 —— 下一个人会以为还有一处在用。
 */
export const PANEL_TABS: readonly { id: PanelTab, label: string }[] = [
  { id: 'assets', label: '素材' },
  { id: 'prompts', label: '提示词' },
]

/** tab id。 */
export type PanelTab = 'assets' | 'prompts'

/** 侧栏宽度上下限（px）。 */
export const PANEL_MIN = 180
export const PANEL_MAX = 460

/**
 * 把宽度夹进上下限之间（**纯函数**，拖宽那条断言落在这里）。
 * @param w - 想要的宽度。
 * @returns 夹过的宽度。
 */
export function clampPanelWidth(w: number): number {
  if (!Number.isFinite(w)) return 260
  return Math.max(PANEL_MIN, Math.min(PANEL_MAX, Math.round(w)))
}

/** 一条素材（`GET /materials` 的 `materials[]`）。
 *
 * ## 票 34 起多了 `kind` 与文本那几项（2026-10-28，后端 `da0ec12`）
 *
 * 老字段 `name` / `bytes` / `mtime` / `url` **一个没删、没改名** —— 所以图片与视频
 * 那两组的渲染一行不用改。新增的：
 *
 * | 字段 | 谁有 | 干什么 |
 * |---|---|---|
 * | `kind` | 全都有 | `image` / `video` / `text`，分组靠它 |
 * | `title` | 只有文本 | **显示名字用它**（见下） |
 * | `content` | 只有文本 | 正文摘要 |
 * | `chars` | 只有文本 | 字数 |
 * | `problem` | 坏文件 | 那一项读不出来时的一句话 |
 *
 * ⚠️ **文本的 `name` 是 `text-<时间戳>.text.json`，不含标题**（标题里有空格、引号、
 * 中文标点，塞进文件名会被安全规则挡）。所以文本那一组**必须用 `title` 显示**，
 * 用 `name` 会显示成一串没人看得懂的文件名。
 *
 * ⚠️ `kind` 缺席时按扩展名猜（老后端 / 手改过的目录）—— 不猜的话那些素材会
 * 从三组里一起消失，用户以为文件丢了。 */
interface MaterialItem {
  name: string
  bytes: number
  mtime: number
  url: string
  /** 哪一类（票 34）。缺席时按扩展名猜。 */
  kind?: 'image' | 'video' | 'text'
  /** 文本素材的标题（**显示用这个，不用 `name`**）。 */
  title?: string
  /** 文本素材的正文（列表里显示摘要）。 */
  content?: string
  /** 文本素材的字数。 */
  chars?: number
  /** 这一项读不出来时的原因。 */
  problem?: string
}

/**
 * 一条素材属于哪一类（`kind` 缺席时按扩展名猜）。
 *
 * 为什么不直接信 `kind`：老版本的目录里没有这个字段，而「文件还在、界面上没了」
 * 是最容易让人以为丢数据的那种错。
 *
 * @param m - 一条素材。
 * @returns 三选一。
 */
export function materialKindOf(m: Pick<MaterialItem, 'name' | 'kind'>): 'image' | 'video' | 'text' {
  if (m.kind === 'image' || m.kind === 'video' || m.kind === 'text') return m.kind
  const n = m.name.toLowerCase()
  if (/\.text\.json$/.test(n) || n.endsWith('.json')) return 'text'
  if (/\.(mp4|webm|mov|m4v|avi|mkv)$/.test(n)) return 'video'
  return 'image'
}

/** 三组的顺序与小标题（照参考 `canvas-side-panel.tsx:428` 的四类，我们没有音频素材）。 */
export const ASSET_GROUPS: readonly { kind: 'image' | 'video' | 'text', label: string }[] = [
  { kind: 'image', label: '图片' },
  { kind: 'video', label: '视频' },
  { kind: 'text', label: '文本' },
]

/** 素材在界面上该显示成什么名字（文本用 `title`，其余用文件名）。 */
export function materialLabelOf(m: MaterialItem): string {
  if (materialKindOf(m) === 'text') {
    const t = (m.title ?? '').trim()
    return t === '' ? '（没有标题）' : t
  }
  return m.name
}

/** 正文摘要（文本那一组显示；空白压成一行，太长截断）。 */
export function materialSummaryOf(m: MaterialItem): string {
  const s = (m.content ?? '').replace(/\s+/g, ' ').trim()
  if (s === '') return ''
  return s.length > 60 ? s.slice(0, 60) + '…' : s
}

/** 入参。 */
export interface CanvasSidePanelProps {
  /** 画布上的节点（存盘形状）。 */
  nodes: readonly ContentNode[]
  /** 当前选中的节点 id。 */
  selectedId: string
  /** 点一行 → 定位到那个节点。 */
  onFocus: (id: string) => void
  /** 插入一个素材（成为图片 / 视频节点）。 */
  onInsertMaterial: (m: { name: string, url: string }) => void
  /**
   * 插入一条**文本素材**（成为文本节点，票 34）。
   *
   * 为什么单独一个而不是塞进 `onInsertMaterial`：那个接口的形状是
   * `{ name, url }`，而文本没有 `url` —— 它带的是正文。共用一个的话，
   * 画布那边每次都要先判「这个 url 是不是空」，两处容易判得不一致。
   */
  onInsertTextMaterial: (m: { name: string, title: string, content: string }) => void
  /** 插入一条提示词（成为文本节点）。 */
  onInsertPrompt: (p: PromptEntry) => void
  /** 侧栏收起时不渲染内容。 */
  open: boolean
  /** 收起 / 展开。 */
  onToggleOpen: () => void
}

/**
 * 左侧栏。
 * @param props - 见 `CanvasSidePanelProps`。
 * @returns 侧栏。
 */
export function CanvasSidePanel(props: CanvasSidePanelProps): React.JSX.Element {
  /* 默认开「提示词」：它是**内置副本**，不发请求。
   * 若默认开「素材」，画布一挂上就要请求一次 `/materials` ——
   * 用户可能压根不打开侧栏。切到素材时才拉。 */
  const [tab, setTab] = useState<PanelTab>('prompts')
  /* ★ 票 58：宽度从**偏好**起算（不是写死 260）。
   *
   * ## 为什么首帧读缓存
   *
   * 真值是宿主半那份 `ui-prefs.json`，但它要走一次网络往返。
   * 只等文件的话，刷新时侧栏会先按默认 260 画一帧、到货再跳到用户设的值
   * —— 那一跳很难看。所以首帧用 `localStorage` 缓存撑住
   * （与 `WorkflowCanvas` 的 `libW`、`EcomWorkbench` 的 `navCollapsed` 同一个手法）。
   */
  const [width, setWidth] = useState<number>(() => {
    const cached = readUiPrefsCache().contentSideW
    return cached === undefined ? 260 : clampPanelWidth(cached)
  })
  /* ★ 票 58：拖宽之后存盘（缓存 + 宿主半那份文件，两处都写 —— 与
   * `WorkflowCanvas` 的 `persistLibW` 同一条纪律：只写缓存的话
   * 「从列表页进画布」读不到，只写文件的话首帧会闪）。 */
  const persistWidth = useCallback((w: number): void => {
    const v = clampPanelWidth(w)
    writeUiPrefsCache({ contentSideW: v })
    void saveUiPrefs({ contentSideW: v } as Partial<UiPrefs>).catch(() => { /* 存不了不影响这次使用 */ })
  }, [])
  /* ── 素材库 ── */
  const [mats, setMats] = useState<MaterialItem[]>([])
  const [matErr, setMatErr] = useState('')
  /* ── 提示词库 ── */
  const [pq, setPq] = useState('')
  /* ★ 票 58 第 9 条：素材 tab 也补一个搜索框（原来只有提示词 tab 有）。
   *
   * 用户要的是「两边都能搜」—— 只在一个 tab 有搜索框，用户切到素材那边
   * 会找不到入口。搜的是文件名 + 文本素材的标题与正文。 */
  const [mq, setMq] = useState('')

  /** 拉素材目录。 */
  const loadMats = useCallback(async (): Promise<void> => {
    const r = await call<{ materials?: MaterialItem[] }>('/materials')
    if (!r.ok) { setMatErr(r.error ?? '读不到素材目录'); return }
    setMatErr('')
    setMats(Array.isArray(r.body?.materials) ? r.body.materials : [])
  }, [])

  /* 只有切到素材那一个 tab、且侧栏开着时才拉 —— 别在后台白花一次请求。 */
  useEffect(() => {
    if (props.open && tab === 'assets') void loadMats()
  }, [props.open, tab, loadMats])

  /**
   * 「存成素材」失败时的说法（票 39）。
   *
   * 用组件内状态而不是通知条：侧栏是自成一格的浮层，通知条在画布右上角，
   * 用户盯着侧栏点按钮、结果提示跑到画布另一头去了 —— 那是错位。
   */
  const [saveErr, setSaveErr] = useState('')
  /** 正在存哪一条（存的过程中按钮禁用，防止连点存出好几份）。 */
  const [savingId, setSavingId] = useState('')

  /**
   * 把一条提示词存成文本素材（票 39 判据 5）。
   *
   * ## 走的是已有路由
   *
   * `POST /api/ecom-workbench/materials/text`（`src/index.ts:2627`），
   * 请求体 `{ title, content, name? }`。存完在**素材 tab 的文本组**里出现
   * （那三组由 `ASSET_GROUPS` 定义，本票不改）。
   *
   * ## 为什么 `title` 与 `content` 分别取什么
   *
   *   · `content` = 这条提示词的正文（`e.prompt`）—— 它就是用户要留下的东西；
   *   · `title` = 它的名字（`e.title`）。
   *
   * ⚠️ **空正文要拦**：存进去会是一条「什么都没有」的素材，
   * 用户以后翻素材库看到一个空条目。静默存空与静默失败一样不可接受。
   *
   * @param e - 那一条提示词。
   */
  const savePromptAsMaterial = useCallback(async (e: PromptEntry): Promise<void> => {
    const content = (e.prompt ?? '').trim()
    const title = (e.title ?? '').trim()
    if (content === '') {
      setSaveErr('这条提示词没有正文，没有可存的内容。')
      return
    }
    setSavingId(e.id)
    setSaveErr('')
    try {
      const res = await fetch('/api/ecom-workbench/materials/text', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: title === '' ? '提示词' : title, content }),
      })
      const body = await res.json().catch(() => null) as { ok?: boolean, error?: string } | null
      if (!res.ok || body?.ok !== true) {
        /* ⚠️ **失败要说原因**，不许静默 —— 本仓库一贯要求。 */
        setSaveErr('存进素材库失败：' + (body?.error ?? ('宿主半返回 ' + String(res.status))))
        return
      }
      setSaveErr('')
      /* 存完刷新素材清单 —— 否则切到素材 tab 时列表还是旧的，用户以为没存上。
       * `reload` 是组件里已有的那个（切 tab 时也用它）。 */
      await loadMats()
    } catch (err) {
      setSaveErr('存进素材库失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSavingId('')
    }
  }, [loadMats])


  /**
   * 双击复位到默认宽度（票 58 第 6 条）。
   *
   * ⚠️ 两边都要 —— 执行画布早就有（那条 resize 把手上的 `onDoubleClick`），
   * 内容画布没有。没有复位的话，拖窄到 180 之后只能一格一格拖回来。
   *
   * @returns 无。
   */
  const resetWidth = useCallback((): void => {
    setWidth(260)
    persistWidth(260)
  }, [persistWidth])

  /** 拖宽（指针按下才挂 window 监听 —— 与节点 resize 同一手法）。 */
  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    /**
     * 拖动中。
     * @param ev - 指针事件。
     */
    const move = (ev: PointerEvent): void => {
      setWidth(clampPanelWidth(startW + (ev.clientX - startX)))
    }
    /**
     * 松手：摘监听 + **落盘**（票 58）。
     *
     * ⚠️ 只在松手时存，不在 `pointermove` 里存 —— 拖动过程中每移动一像素
     * 写一次文件，那是几十次磁盘写。用户要的是「拖完记住」。
     */
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setWidth((w) => { persistWidth(w); return w })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /**
   * 素材的候选（票 58）。
   *
   * 搜的是**文件名 + 文本素材的标题与正文** —— 图片没有别的可搜字段，
   * 视频同理。不搜 `mtime`（那是个时间戳，搜它没人会做）。
   */
  const matsShown = (() => {
    const needle = mq.trim().toLowerCase()
    if (needle === '') return mats
    return mats.filter(m => {
      const hay = (m.name + '\n' + (m.title ?? '') + '\n' + (m.content ?? '')).toLowerCase()
      return hay.includes(needle)
    })
  })()

  /** 提示词库的候选（只搜标题与正文，与提示词库那一格同一套判据）。 */
  const promptsShown = (() => {
    const needle = pq.trim().toLowerCase()
    const all = allBuiltinEntries()
    if (needle === '') return all.slice(0, 80)
    return all.filter(e => (e.title + '\n' + e.prompt).toLowerCase().includes(needle)).slice(0, 80)
  })()

  if (!props.open) {
    return (
      <div className={css.canvasSideCollapsed + ' ' + css.canvasSideCollapsedWidth} data-ewb-side-panel="closed">
        <button
          type="button"
          data-ewb-side-toggle=""
          className={css.contentCanvasBtn + ' nodrag'}
          title="展开左侧栏"
          onClick={props.onToggleOpen}
        ><ChevronRightIcon size={13} /></button>
      </div>
    )
  }

  return (
    <div className={css.canvasSide} data-ewb-side-panel="open" style={{ width }}>
      <div className={css.canvasSideTabs} role="tablist">
        {PANEL_TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            data-ewb-side-tab={t.id}
            data-on={tab === t.id ? '' : undefined}
            className={css.canvasSideTab}
            onClick={() => { setTab(t.id) }}
          >{t.label}</button>
        ))}
        <span className="flex-1" />
        <button
          type="button"
          data-ewb-side-toggle=""
          className={css.canvasSideIconBtn}
          title="收起左侧栏"
          onClick={props.onToggleOpen}
        ><ChevronLeftIcon size={13} /></button>
      </div>

      {tab === 'assets'
        ? (
          <div className={css.canvasSideBody} data-ewb-side-assets="">
              <div className={css.canvasSideFilters}>
                <span className={css.canvasSideCount}>目录里 {mats.length} 个文件</span>
                <span className="flex-1" />
                <button
                  type="button"
                  data-ewb-side-asset-refresh=""
                  className={css.canvasSideChip}
                  onClick={() => { void loadMats() }}
                >刷新</button>
              </div>
              {/* ★ 票 58 第 9 条：素材 tab 的搜索框（与提示词那个同一档长相）。 */}
              <div className={css.canvasSideFilters}>
                <input
                  type="search"
                  data-ewb-side-asset-search=""
                  className={css.canvasSideSearch}
                  placeholder="搜索素材…"
                  value={mq}
                  onChange={(e) => { setMq(e.target.value) }}
                  aria-label="搜索素材"
                />
                {mq === ''
                  ? null
                  : (
                    <button
                      type="button"
                      data-ewb-side-asset-search-clear=""
                      className={css.canvasSideChip}
                      onClick={() => { setMq('') }}
                    >清空</button>
                  )}
              </div>
              {matErr === ''
                ? null
                : <span className={css.canvasSideEmpty} data-ewb-side-asset-error="">{matErr}</span>}
              {/* ★ 按 `kind` 分三组（票 34，2026-10-28，照参考 `canvas-side-panel.tsx:428`）。
               *
               * ## 为什么必须分组
               *
               * 文本素材混在图片网格里长这样：一张 `<img>` 加载失败的空框 +
               * 一个 `text-1750000000.text.json` 文件名。用户既看不出它是什么，
               * 也认不出是哪一条。分组之后文本那一组显示**标题 + 正文摘要**。
               *
               * ⚠️ 空组**不画**：三个标题下面挂着「（0）」比只画有内容的那组更乱。
               * 但三组都空时要给一句空态（否则是一片空白）。 */}
              {ASSET_GROUPS.map(g => {
                const items = matsShown.filter(m => materialKindOf(m) === g.kind)
                if (items.length === 0) return null
                return (
                  <div key={g.kind} data-ewb-side-asset-group={g.kind}>
                    <div className={css.canvasSideGroupHead} data-ewb-side-asset-group-head={g.kind}>
                      <span>{g.label}</span>
                      <span className={css.canvasSideGroupCount}>{items.length}</span>
                    </div>
                    <div className={css.canvasSideGrid}>
                      {items.map(m => (
                        <button
                          key={m.name}
                          type="button"
                          data-ewb-side-asset={m.name}
                          data-ewb-side-asset-kind={g.kind}
                          className={css.canvasSideAsset}
                          title={g.kind === 'text'
                            ? ('拖到画布，或点一下插入：' + materialLabelOf(m))
                            : ('拖到画布，或点一下插入：' + m.name)}
                          /* ★ 可拖（契约 CJ）：拖到画布落位，**点击仍然插入**（两条都在）。 */
                          draggable
                          onDragStart={(e) => {
                            /* ★ 文本素材的拖拽载荷用**已有的 `prompt` 形状**
                             * （`{ kind: 'prompt', prompt, title }`）。
                             *
                             * 为什么不给 `material` 加 `text` / `title` 两个字段：
                             * `DragPayload` 定义在 `content-canvas-store.ts`，那不在本票
                             * 可改路径里。而「插入一段文字」这个语义本来就有现成的载荷 ——
                             * 造出来同样是文本节点，一个字都不用新增类型。
                             *
                             * ⚠️ 不许沿用 `material` + 空 `url`：那会让画布造出一个
                             * `src` 为空的图片节点（看着像裂图，其实是没内容）。 */
                            const p: DragPayload = g.kind === 'text'
                              ? { kind: 'prompt', prompt: m.content ?? '', title: materialLabelOf(m) }
                              : { kind: 'material', name: m.name, url: m.url }
                            e.dataTransfer.setData(DRAG_MIME, encodeDrag(p))
                            e.dataTransfer.setData('text/plain', materialLabelOf(m))
                            e.dataTransfer.effectAllowed = 'copy'
                          }}
                          onClick={() => {
                            if (g.kind === 'text') {
                              props.onInsertTextMaterial({ name: m.name, title: materialLabelOf(m), content: m.content ?? '' })
                              return
                            }
                            props.onInsertMaterial({ name: m.name, url: m.url })
                          }}
                        >
                          {g.kind === 'text'
                            ? (
                              /* 文本：**不画媒体占位**（画一个裂图的空框比不画更糟）。
                               * 标题 + 正文摘要，两行都读得出来。 */
                              <span className={css.canvasSideAssetText} data-ewb-side-asset-title={m.name}>
                                <span className={css.canvasSideAssetTextTitle}>{materialLabelOf(m)}</span>
                                <span className={css.canvasSideAssetTextBody}>
                                  {materialSummaryOf(m) === '' ? '（没有正文）' : materialSummaryOf(m)}
                                </span>
                                {m.chars === undefined
                                  ? null
                                  : <span className={css.canvasSideAssetTextMeta}>{m.chars} 字</span>}
                              </span>
                            )
                            : g.kind === 'video'
                              ? <video src={m.url} className={css.canvasSideAssetMedia} preload="metadata" />
                              : <img src={m.url} alt="" className={css.canvasSideAssetMedia} />}
                          {g.kind === 'text'
                            ? null
                            : (
                              <span className={css.canvasSideAssetName}>
                                {m.name}
                                {/* ★ 票 58 第 2 条：每一项都有**说明行**。
                                 *
                                 * 用户：「条目可以不强行一致……但都有标题+说明。外观上应该近似。」
                                 * 文本那组本来就有（标题 + 正文摘要 + 字数）；
                                 * 图片 / 视频原来只有文件名 —— 补一行「类型 · 尺寸」。
                                 *
                                 * ⚠️ 网格密度**不降**：这一行塞在同一个按钮里，
                                 * 不改 `canvasSideGrid` 的列数（判据 7 钉着）。 */}
                                <span className={css.canvasSideAssetMeta} data-ewb-side-asset-meta={m.name}>
                                  {g.label} · {m.bytes === undefined ? '大小未知' : humanBytes(m.bytes)}
                                </span>
                              </span>
                            )}
                          {/* 读不出来的那一项：把它自己的原因显示出来，不要静默成一张裂图。 */}
                          {m.problem === undefined
                            ? null
                            : <span className={css.canvasSideAssetProblem} data-ewb-side-asset-problem={m.name}>{m.problem}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
              {/* ★ 票 58 第 10 条：**空态分两句**。
               *
               * 「本来就没有」与「搜不到」是两件事，用同一句会让人以为目录空了：
               *   · 目录是空的 → 该去生成 / 上传；
               *   · 搜不到 → 换个词，或清空搜索。
               *
               * 两句措辞必须**不同**（判据 6 钉这一条），而且都带上「怎么办」。 */}
              {mats.length === 0 && matErr === ''
                ? (
                  <span className={css.canvasSideEmpty} data-ewb-side-asset-empty="">
                    素材目录是空的 —— 先去生成或上传，素材会出现在这里
                  </span>
                )
                : null}
              {mats.length > 0 && matsShown.length === 0
                ? (
                  <span className={css.canvasSideEmpty} data-ewb-side-asset-nomatch="">
                    没有匹配「{mq}」的素材 —— 换个词，或清空上面的搜索
                  </span>
                )
                : null}
            </div>
          )
          : (
            <div className={css.canvasSideBody} data-ewb-side-prompts="">
              <div className={css.canvasSideFilters}>
                <span className={css.canvasSideCount}>
                  内置 {allBuiltinEntries().length} 条 / {BUILTIN_PROMPT_SOURCES.length} 个源
                </span>
              </div>
              <input
                className={css.canvasSideSearch}
                data-ewb-side-prompt-search=""
                value={pq}
                placeholder="搜提示词"
                onChange={(e) => { setPq(e.target.value) }}
              />
              {/* 存成素材失败时的说法（票 39）。**不许静默** —— 点了没反应与
               * 存失败是两件事，用户必须能分清。 */}
              {saveErr === ''
                ? null
                : (
                  <div
                    data-ewb-side-save-err=""
                    style={{
                      margin: '0 0 4px',
                      padding: '2px 6px',
                      borderRadius: 4,
                      fontSize: 'var(--text-ewb-meta)',
                      color: 'var(--dsw-alias-state-error-primary, #d9534f)',
                      background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary, #d9534f) 12%, transparent)',
                    }}
                  >{saveErr}</div>
                )}
              <div className={css.canvasSideList}>
                {promptsShown.map(e => (
                  /* ★ 票 39（2026-10-29）：外面多包一层 `<div>` 放「存成素材」那颗。
                   *
                   * ## 为什么不能把新按钮塞进原来那个 `<button>` 里
                   *
                   * `<button>` 套 `<button>` 是非法 HTML —— 浏览器会把内层**拆出去**，
                   * 实际 DOM 与源码不一致，点哪一颗、事件冒到谁身上都变得不可预测。
                   * 所以外层换成 `<div>` 容器，里面并排放「插入」与「存成素材」两颗真按钮。
                   *
                   * ## 原来那个按钮的行为一个字没动
                   *
                   * `data-ewb-side-prompt` / `draggable` / `onDragStart` / `onClick`
                   * 全部原样留在它身上 —— `tests/content-canvas.mjs` 有按那个钩子找它的断言。 */
                  <div
                    key={e.id}
                    /* ⚠️ **票 39 不改任何 `.module.css`**（票面明令），
                     * 所以这一层的排布用行内样式，不新增 CSS 类。
                     * 两件事：① 一行放得下「插入」与「存成素材」；
                     * ② 存成素材那颗不挤压原来那一行（`flex: 1 1 auto` + `min-width: 0`）。 */
                    style={{ display: 'flex', alignItems: 'stretch', gap: 2 }}
                  >
                    <button
                      type="button"
                      data-ewb-side-prompt={e.id}
                      className={css.canvasSideRow}
                      style={{ flex: '1 1 auto', minWidth: 0 }}
                      title={e.title}
                      /* ★ 可拖（契约 CJ）：拖到画布落位；点击仍然插入。 */
                      draggable
                      onDragStart={(ev) => {
                        const p: DragPayload = { kind: 'prompt', prompt: e.prompt, title: e.title }
                        ev.dataTransfer.setData(DRAG_MIME, encodeDrag(p))
                        ev.dataTransfer.setData('text/plain', e.prompt)
                        ev.dataTransfer.effectAllowed = 'copy'
                      }}
                      onClick={() => { props.onInsertPrompt(e) }}
                    >
                      <span className={css.canvasSideRowType}>{e.sourceId}</span>
                      <span className={css.canvasSideRowName}>{e.title}</span>
                    </button>
                    {/* 存成素材（票 39 判据 5）。
                     *
                     * 文案「存成素材」：动作 + 结果，无第二人称、无口语词、不是疑问句（R6）。
                     * `title` 说清存到哪 —— 用户点之前该知道东西会去哪。 */}
                    <button
                      type="button"
                      data-ewb-side-prompt-save={e.id}
                      style={{
                        flex: '0 0 auto',
                        padding: '0 6px',
                        border: '1px solid var(--v1-line)',
                        borderRadius: 4,
                        background: 'transparent',
                        color: 'var(--dsw-alias-label-secondary)',
                        fontSize: 'var(--text-ewb-meta)',
                        cursor: savingId === e.id ? 'default' : 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                      disabled={savingId === e.id}
                      title="把这条提示词存成文本素材（存完在「素材」那一格的文本组里）"
                      onClick={() => { void savePromptAsMaterial(e) }}
                    >{savingId === e.id ? '正在存…' : '存成素材'}</button>
                  </div>
                ))}
              </div>
            </div>
          )}
      {/* 拖宽把手：照参考项目 `:118` 的做法（贴着右边缘、半挂在外面）。 */}
      <div
        className={css.canvasSideResize}
        data-ewb-side-resize=""
        role="separator"
        aria-orientation="vertical"
        aria-label="拖拽调整侧栏宽度（双击复位）"
        title="拖拽调整侧栏宽度（双击复位 260）"
        onPointerDown={onResizeDown}
        onDoubleClick={resetWidth}
      />
    </div>
  )
}
