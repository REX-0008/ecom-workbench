/** 提示词库：**生图 / 生视频用的提示词素材**（计划 §三 Step 6，契约 BF）。
 *
 * ## 它和「提示词」板块不是一回事（这一句要写在界面上，见下面 SHARED_NOTE）
 *
 * | | 现有「提示词」板块 | 这一格 |
 * |---|---|---|
 * | 面向什么 | **改写**：把一段提示词按模板风格改写一遍 | **找素材**：生图 / 生视频用的提示词 |
 * | 内容 | 62 个固定模板 | 外部提示词源（GitHub 上的 JSON 集合） |
 *
 * 两个都留（用户 2026-10-25 定）。标题都叫「提示词」的话，不写这句说明一定有人以为重复了。
 *
 * ## ⚠️ 数据**全部来自内置兜底副本**，不做任何网络请求
 *
 * 计划 §三 Step 6 的完成标准有一条：「断网状态下打开提示词库，仍能看到内置的那份并能复制一条」。
 * 而拉源的逻辑**还没写**（那是另一件事），所以这一版**一个 `fetch` 都不发**。
 *
 * 这不是「偷懒只做兜底」：`prompt-sources/index.ts` 那份副本是**主**而不是来源的附庸 ——
 * 源会挂（仓库改名、删库、断网），而这一格必须永远能用。
 *
 * 判据在测试里：把 `fetch` 换成会抛错的桩，整格渲染仍然正常（验收 7）。
 *
 * ## 署名是**法律要求**，不是可选装饰
 *
 * `youmind-gpt-image-2` 与 `youmind-nano-banana-pro` 是 **CC BY 4.0** —— 它要求
 * 展示时保留作者署名。所以：
 *   · 每个源头部显示 `license`（**MIT 也显示**，统一处理，不按源特判）；
 *   · 每条展开后显示 `author` 与 `sourceUrl`。
 *
 * 为什么不「只对 CC BY 那两个特判」：许可将来会变（某个源换协议、某个源换作者），
 * 而按源特判的代码不会跟着变，于是会在最不该漏的时候漏掉署名。
 *
 * ## 584 条不可能一次全渲染 —— 但**处置方式换过了**（用户 m03414 / m03555）
 *
 * 五个源合计 584 条（`banana` 那一份还被截断过，上游其实 323 条），
 * 而且**每一条都有 `coverUrl`**（53 / 76 / 200 / 126 / 129，全覆盖）。
 *
 * 上一版选了「列表文字 + 一次 60 条 + 显示更多」，理由是「584 条全渲染会同时挂
 * 584 张远程图」—— 担心是对的，**但处置错了**：它把最重要的东西（效果图）藏在了
 * 「展开之后」，于是用户看到的是列表文字，图要一条条点开才看得到。
 *
 * 参考项目的做法是 **卡片 + 一次 20 条 + 翻页**（`fetchPrompts` 的 `pageSize = 20`）：
 * 既不白拉 584 张图，又能一眼看到图。现在照这个做：
 *   · 卡片网格（`PromptCard.tsx`，照抄参考项目）
 *   · 一次 20 条 + 上一页 / 下一页（翻页回顶部）
 *   · 点卡片开大图 + 完整正文
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from 'antd'
import {
  BUILTIN_PROMPT_SOURCES, allBuiltinEntries,
  type BuiltinPromptSource, type PromptEntry,
} from './prompt-sources/index.ts'
/* 粗体渲染：与「提示词」板块**同一份实现**（2026-10-25 契约 BJ）。
 * 这里 8 条正文带 140 处 `**`，不渲染就是原样露两颗星。
 * ⚠️ 它只用于**只读展示**，复制那条路**不许**过它 —— 见 `emphasis-render.tsx` 文件头。 */
import { renderEmphasis } from './emphasis-render.tsx'
/* 卡片本体：照抄参考项目的 `prompt-card.tsx`（见那个文件头写的改动清单）。 */
import { PromptCard } from './PromptCard.tsx'
/* 向后端问这个源的**真实状态**（票 27）。
 *
 * ⚠️ 请求**必须走这个模块**，不在本文件里写 `fetch(`：本文件的源码层判据
 * （`tests/prompt-library.mjs` 第 ④ 段）守着「这一格自己不直接发请求」。
 * 那条判据仍然成立而且仍然有意义 —— 它保证网络这一层集中在 `dispatch-client`
 * 一处，这一格只消费结果。 */
import { loadPromptSource } from './dispatch-client.ts'

/**
 * 这一格与「提示词」板块的分工（要显示在界面顶部）。
 *
 * 文案守 R6：**不用第二人称、不用口语词、不是疑问句**。
 */
export const SHARED_NOTE = '这里放生图 / 生视频用的提示词素材；那个「提示词」板块是把一段提示词按模板改写。两边职责不同，模板不重复。'

/** 每页多少条。
 *
 * ★ **从 60 改成 20**（用户 m03414 / m03555）。理由不是「60 显示不下」，
 * 是每张卡要挂**一张远程效果图** —— 20 张同时拉是合理的，60 张会卡。
 * 参考项目 `fetchPrompts` 的 `pageSize` 也是 20。
 *
 * 导出着：判据要拿它断言「一次渲染 20 条」（而不是在测试里硬写 20，
 * 那样改了值测试照样绿）。 */
export const PAGE_SIZE = 20

/**
 * 一条提示词是否命中搜索词。
 *
 * ## 为什么搜正文（而不是只搜标题）
 *
 * 用户找素材时想到的往往是**画面里有什么**（「电影院的柜台」），
 * 而那种词几乎总在正文里、不在标题里。只搜标题等于搜不到。
 *
 * 搜索范围：标题 + 正文 + 说明。**不搜作者名** —— 那是另一个维度，
 * 混进来会让「搜画面词」的结果里塞满某个作者的全部作品。
 *
 * @param e - 一条提示词。
 * @param q - 搜索词（已 trim 且小写）。
 * @returns 命中给 true。
 */
export function matchesQuery(e: PromptEntry, q: string): boolean {
  if (q === '') return true
  const hay = (e.title + '\n' + e.prompt + '\n' + e.description).toLowerCase()
  return hay.includes(q)
}

/**
 * 按标签与搜索词筛条目。
 *
 * @param entries - 候选条目。
 * @param q - 搜索词（已小写；空串表示不筛）。
 * @param tag - 标签（空串表示不筛）。
 * @returns 筛出来的条目。
 */
export function filterEntries(entries: readonly PromptEntry[], q: string, tag: string): PromptEntry[] {
  const needle = q.trim().toLowerCase()
  return entries.filter(e => (tag === '' || (Array.isArray(e.tags) && e.tags.includes(tag))) && matchesQuery(e, needle))
}

/**
 * 一份条目里出现过的标签（按出现次数倒序，只留前 `limit` 个）。
 *
 * 为什么限量：`banana` 那一份有 84 种标签，全铺出来是一面墙。
 * 常用的那几个才值得占位置。
 *
 * @param entries - 条目。
 * @param limit - 最多几个（默认 24）。
 * @returns 标签数组。
 */
export function topTags(entries: readonly PromptEntry[], limit = 24): string[] {
  const n = new Map<string, number>()
  for (const e of entries) {
    if (!Array.isArray(e.tags)) continue
    for (const t of e.tags) {
      if (typeof t !== 'string' || t === '') continue
      n.set(t, (n.get(t) ?? 0) + 1)
    }
  }
  return [...n.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .slice(0, limit)
    .map(([t]) => t)
}

/**
 * 源是不是**截断过的**（内置副本比上游少）。
 *
 * @param s - 源。
 * @returns 截断过给 true。
 */
export function isTruncated(s: BuiltinPromptSource): boolean {
  return s.upstreamCount > s.count
}

/**
 * 把一段文字写进剪贴板。
 *
 * ## 为什么要有两条路
 *
 * `navigator.clipboard` 只在**安全上下文**（https 或 localhost）里可用，
 * 而且需要用户手势。工作台跑在 `http://127.0.0.1:<port>` —— 那是安全上下文，
 * 但用户可能从局域网地址打开，那时整条 API 都不存在。
 *
 * 所以失败时退回「临时 textarea + `document.execCommand('copy')`」：
 * 那个 API 已经废弃，但它是唯一在旧环境里能用的办法。
 *
 * @param text - 要复制的文字。
 * @returns 成功给 true（**不抛错**：复制失败不该把界面带崩）。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    const nav = navigator as unknown as { clipboard?: { writeText?: (s: string) => Promise<void> } }
    if (nav.clipboard !== undefined && typeof nav.clipboard.writeText === 'function') {
      await nav.clipboard.writeText(text)
      return true
    }
  } catch { /* 掉到下面的回退路 */ }
  try {
    const el = document.createElement('textarea')
    el.value = text
    /* 挪出视口：不挪的话页面会跳一下（用户会以为点错了）。 */
    el.style.position = 'fixed'
    el.style.left = '-9999px'
    el.setAttribute('readonly', '')
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}

/** 提示词库的入参。 */
export interface PromptLibraryProps {
  /** 这一格是不是正显示着。 */
  active: boolean
}

/** 后端回来的一个源的真实状态（票 27）。 */
interface RemoteSource {
  /** 条目（后端给的那份；为空时用内置副本顶上）。 */
  entries: PromptEntry[]
  /** 从哪来：`cache` 拉过存下的 / `builtin` 内置副本 / `custom` 自定义源。 */
  from?: 'cache' | 'builtin' | 'custom'
  /** 后端原话的说明。**界面直接显示，不改写** —— 改了就前后端两份话，迟早对不上。 */
  note?: string
}

/**
 * 提示词库。
 * @param props - 是否可见。
 * @returns 界面。
 */
export function PromptLibrary({ active }: PromptLibraryProps): React.JSX.Element {
  /* ⚠️ `active` 只影响「要不要做活」这件小事：数据首屏来自内置副本，
   * 不靠任何请求。它在这里几乎不做事，但签名与别的格保持一致。 */
  void active

  /** 当前看的源（`all` = 跨源）。 */
  const [sourceId, setSourceId] = useState<string>(BUILTIN_PROMPT_SOURCES[0]?.id ?? 'all')
  const [q, setQ] = useState('')
  const [tag, setTag] = useState('')
  /** 展开的那一条（空串 = 都收起）。 */
  const [openId, setOpenId] = useState('')
  /** 当前第几页（**从 1 开始**，翻页用）。 */
  const [page, setPage] = useState(1)
  /** 列表滚动容器：翻页后要回到顶部。 */
  const listRef = useRef<HTMLDivElement | null>(null)
  /** 复制结果的提示（几秒后自己消失）。 */
  const [copied, setCopied] = useState('')
  /** 后端回来的真实状态（按源 id 存，票 27）。
   *
   * 初始是空对象 —— 首屏一定走内置副本，**没有「正在加载」这个状态**。
   * 请求回来后才有条目，才有 `note`；失败就当没发生过（副本还在）。
   * 这是本票的全部取舍：断网能用与看到真实状态同时成立，靠的就是这两个时序。 */
  const [remote, setRemote] = useState<Record<string, RemoteSource>>({})

  /* 换源时问一次后端。**异步**，不阻塞首屏 —— `await` 在这里没有出现，
   * 首屏那一屏是内置副本画的，这个 effect 回来才替换。
   *
   * `alive` 守卫：换源很快时上一个请求可能后回来，不挡的话会把
   * 上一个源的内容盖到当前源上。 */
  useEffect(() => {
    if (sourceId === 'all') return undefined
    let alive = true
    void loadPromptSource(sourceId).then(r => {
      if (!alive || !r.ok || r.source === undefined) return
      const entries = Array.isArray(r.source.entries) ? (r.source.entries as PromptEntry[]) : []
      setRemote(prev => ({
        ...prev,
        [sourceId]: {
          /* 空条目**不覆盖**本地副本：自定义源还没拉过时后端回空清单，
           * 覆盖了就是「刚才还在，一问就空了」。 */
          entries: entries.length > 0 ? entries : (prev[sourceId]?.entries ?? []),
          from: r.from,
          note: r.note,
        },
      }))
    })
    return () => { alive = false }
  }, [sourceId])

  /** 当前源的条目（`all` 时是全部）。
   *
   * 顺序：后端回来的那份 → 内置副本。**后端那份排前面**，因为它可能更新。 */
  const pool = useMemo<readonly PromptEntry[]>(() => {
    if (sourceId === 'all') return allBuiltinEntries()
    const got = remote[sourceId]
    if (got !== undefined && got.entries.length > 0) return got.entries
    const s = BUILTIN_PROMPT_SOURCES.find(x => x.id === sourceId)
    return s === undefined ? [] : s.entries
  }, [sourceId, remote])

  /** 后端对当前源的那句说明（没有就不显示）。 */
  const originNote = sourceId === 'all' ? '' : (remote[sourceId]?.note ?? '')

  /** 当前池子里出现过的标签（换源就换一批）。 */
  const tags = useMemo(() => topTags(pool), [pool])

  /** 筛完的条目。 */
  const hits = useMemo(() => filterEntries(pool, q, tag), [pool, q, tag])

  /* 换源 / 改搜索词 / 改标签时，回到**第一页** ——
   * 否则「搜索之后再清空」会停在上一轮的位置，看着像少了一截。 */
  useEffect(() => { setPage(1) }, [sourceId, q, tag])

  /** 总页数（至少 1 页，空结果时也显示「第 1 / 1 页」而不是 0）。 */
  const pageCount = Math.max(1, Math.ceil(hits.length / PAGE_SIZE))

  /* 结果变少时页码可能越界（比如第 5 页时搜了个只剩 3 条的词）——
   * 夹回最后一页，否则会看到一片空白还以为搜坏了。 */
  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

  /** 当前页的条目。 */
  const pageItems = useMemo(
    () => hits.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [hits, page],
  )

  /**
   * 翻到某一页，并**回到列表顶部**。
   *
   * 为什么必须回顶：翻完页还停在底部的话，看到的是新一页的**末尾**，
   * 会以为「这页只有两条」。用户原话要的就是别停在底部。
   */
  const goPage = useCallback((next: number): void => {
    setPage(next)
    const el = listRef.current
    if (el !== null) el.scrollTop = 0
  }, [])

  /** 复制一条。 */
  const doCopy = useCallback(async (e: PromptEntry): Promise<void> => {
    const ok = await copyText(e.prompt)
    setCopied(ok ? ('已复制：' + e.title) : '复制失败：浏览器不允许写剪贴板，请手动选中正文复制')
    window.setTimeout(() => { setCopied('') }, 4000)
  }, [])

  /** 当前源的清单项（`all` 时是 null）。 */
  const curSource = sourceId === 'all' ? null : (BUILTIN_PROMPT_SOURCES.find(x => x.id === sourceId) ?? null)

  /**
   * 某条属于哪个源的许可。
   *
   * 为什么要按**条目自己的 sourceId** 找而不是用 `curSource`：
   * 看「全部」时 `curSource` 是 null，而卡片上仍要显示那条的许可。
   * 许可与署名是法律要求，不能因为「正在看全部」就不显示。
   */
  const licenseOf = useCallback((e: PromptEntry): string => {
    return BUILTIN_PROMPT_SOURCES.find(x => x.id === e.sourceId)?.license ?? ''
  }, [])

  /** 弹层里那条（空串 / 找不到时给 null）。 */
  const curEntry = openId === '' ? null : (hits.find(x => x.id === openId) ?? null)

  return (
    /* ★ 页面底走 `--dsw-alias-bg-base`（票 36）。
     *
     * 原来这一格根元素**没有底色**，卡片底色来自 antd `Card` 的默认值 ——
     * 而本项目没有 `ConfigProvider`（全仓 0 处），antd 永远用它的默认亮色算法，
     * 于是暗色主题下卡片是白的、页面底是透的，整格与主题脱节。
     * 两处一起修：这一层给页面底，卡片自己给底色（见 `PromptCard.tsx`）。
     *
     * 为什么不引入 `ConfigProvider`：它一改就影响**全部** antd 组件
     * （配置页那几个 tab 也归别的票在改），属于扩范围。这里只把这一格的
     * 三层（页面 / 卡片 / 弹层）逐处钉到令牌上，改动面与票面一致。 */
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--dsw-alias-bg-base)]" data-ewb-prompt-library="">
      {/* 分工说明（验收 8：不用第二人称、不是疑问句）。 */}
      <div className="mb-2 flex flex-none items-start gap-2 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2" data-ewb-pl-note="">
        <span className="dot warn" style={{ marginTop: 5 }} />
        <span className="min-w-0 flex-1 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-secondary)]">
          {SHARED_NOTE}
        </span>
      </div>

      {/* 源清单：五个源 + 「全部」。每个显示 name 与 license。 */}
      <div className="mb-2 flex flex-none flex-wrap items-center gap-1.5" data-ewb-pl-sources="">
        <button
          type="button"
          data-ewb-pl-source="all"
          data-on={sourceId === 'all' ? '' : undefined}
          className={[
            'rounded-ctl border px-2 py-1 font-mono text-ewb-caption',
            sourceId === 'all'
              ? 'border-[var(--dsw-alias-border-l2)] text-[var(--dsw-alias-label-primary)]'
              : 'border-transparent text-[var(--dsw-alias-label-tertiary)]',
          ].join(' ')}
          onClick={() => { setSourceId('all'); setTag('') }}
        >全部（{String(allBuiltinEntries().length)}）</button>
        {BUILTIN_PROMPT_SOURCES.map(s => (
          <button
            key={s.id}
            type="button"
            data-ewb-pl-source={s.id}
            data-on={sourceId === s.id ? '' : undefined}
            className={[
              'flex items-center gap-1.5 rounded-ctl border px-2 py-1 font-mono text-ewb-caption',
              sourceId === s.id
                ? 'border-[var(--dsw-alias-border-l2)] text-[var(--dsw-alias-label-primary)]'
                : 'border-transparent text-[var(--dsw-alias-label-tertiary)]',
            ].join(' ')}
            onClick={() => { setSourceId(s.id); setTag('') }}
          >
            <span data-ewb-pl-source-name="">{s.name}</span>
            <span className="text-[var(--dsw-alias-label-tertiary)]" data-ewb-pl-source-count="">{String(s.count)}</span>
            {/* ★ 许可：**每个源都显示**（MIT 也显示）。 */}
            <span
              data-ewb-pl-source-license=""
              className={[
                'rounded-ctl px-1 text-ewb-caption',
                /* ★ 原来是硬编码 `bg-[rgba(255,255,255,0.10)]` —— 那点白在亮色主题下**看不见**
                 * （白底上叠 10% 白），在暗色下又是另一个亮度。改用悬停底令牌：
                 * 它就是「比底色亮一档」的语义色，两套主题各给各的值。 */
                s.license.includes('CC BY')
                  ? 'bg-[var(--dsw-alias-interactive-bg-hover)] text-[var(--dsw-alias-label-secondary)]'
                  : 'text-[var(--dsw-alias-label-tertiary)]',
              ].join(' ')}
            >{s.license}</span>
          </button>
        ))}
      </div>

      {/* 当前源的头部信息：主页 + 截断提示。 */}
      {curSource === null
        ? null
        : (
          <div className="mb-2 flex flex-none flex-wrap items-center gap-x-3 gap-y-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" data-ewb-pl-head="">
            <span data-ewb-pl-head-license="">许可 {curSource.license}</span>
            <a
              data-ewb-pl-head-home=""
              href={curSource.homepage}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[var(--dsw-alias-link)] underline-offset-2 hover:underline"
            >上游仓库</a>
            <span>内置 {String(curSource.count)} 条</span>
            {/* ★ 截断必须说清，否则读的人会以为上游只有这么多。
             * 颜色走 `--dsw-alias-state-warn-primary`（票 36 换的，原来是硬编码 #f0b429）：
             * 那是「需要注意但没坏」的语义色，亮暗两套各给各的值。 */}
            {isTruncated(curSource)
              ? (
                <span className="text-[var(--dsw-alias-state-warn-primary)]" data-ewb-pl-truncated="">
                  内置副本只到第 {String(curSource.count)} 条（上游共 {String(curSource.upstreamCount)} 条）
                </span>
              )
              : null}
          </div>
        )}

      {/* ★ 后端那句「这份内容从哪来」（票 27）。
       *
       * 比上面那一行**显眼一档**：上面说的是「副本有多少条」（常态信息），
       * 这里说的是「看到的可能不是你配的那个地址」（要用户动手的信息）。
       * 两句同时在场时用户会看错地方 —— 所以颜色与位置都分开。 */}
      {originNote === ''
        ? null
        : (
          <div
            className="mb-2 flex flex-none items-start gap-2 rounded-card border border-dashed border-[color-mix(in_oklab,var(--dsw-alias-state-warn-primary)_35%,transparent)] px-3 py-2"
            data-ewb-pl-origin-note=""
            data-ewb-pl-origin-from={remote[sourceId]?.from ?? ''}
          >
            <span className="dot warn" style={{ marginTop: 5 }} />
            <span className="min-w-0 flex-1 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-state-warn-primary)]">
              {originNote}
            </span>
          </div>
        )}

      {/* 搜索 + 标签筛。 */}
      <div className="mb-2 flex flex-none flex-wrap items-center gap-1.5">
        <input
          data-ewb-pl-search=""
          className="min-w-0 flex-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none"
          value={q}
          placeholder="搜标题与正文（如 电影院 海报 特写）"
          onChange={(e) => { setQ(e.target.value) }}
        />
        <span className="flex-none font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" data-ewb-pl-hit-count="">
          {String(hits.length)} 条
        </span>
        {q === '' && tag === ''
          ? null
          : (
            <button
              type="button"
              data-ewb-pl-clear=""
              className="pressable is-dark flex-none rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
              onClick={() => { setQ(''); setTag('') }}
            >清空条件</button>
          )}
      </div>

      {/* 标签筛：只有当前池子里真有标签才显示（没有就不占位）。 */}
      {tags.length === 0
        ? null
        : (
          <div className="mb-2 flex flex-none flex-wrap items-center gap-1" data-ewb-pl-tags="">
            {tags.map(t => (
              <button
                key={t}
                type="button"
                data-ewb-pl-tag={t}
                data-on={tag === t ? '' : undefined}
                className={[
                  'rounded-ctl border px-1.5 py-0.5 font-mono text-ewb-caption',
                  tag === t
                    ? 'border-[var(--dsw-alias-border-l2)] text-[var(--dsw-alias-label-primary)]'
                    : 'border-transparent text-[var(--dsw-alias-label-tertiary)]',
                ].join(' ')}
                onClick={() => { setTag(tag === t ? '' : t) }}
              >{t}</button>
            ))}
          </div>
        )}

      {/* 复制结果提示。 */}
      {copied === ''
        ? null
        : (
          <div data-ewb-pl-copied="" className="mb-2 flex flex-none items-center gap-2 rounded-card border border-[var(--dsw-alias-border-l2)] px-3 py-1.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
            {copied}
          </div>
        )}

      <div ref={listRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-ewb-pl-list="">
        {hits.length === 0
          ? (
            <div data-ewb-pl-empty="" className="rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-5">
              <span className="font-mono text-ewb-meta text-[var(--dsw-alias-label-secondary)]">没有命中</span>
              <span className="mt-1 block font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
                内置副本里没有匹配的条目。换个词，或者把标签清掉。
              </span>
            </div>
          )
          : null}

        {/* ★ 卡片网格（票 36，2026-10-28）：**列数随宽度连续自适应**。
         *
         * 原来写的是两个断点各跳一档（2 列 / 3 列）—— 中间一大段宽度要么白浪费
         * （刚过断点时卡片很窄）要么被挤（差一点到断点时）。
         * 用户原话：「不应该固定一行3个，应该是根据宽度调整卡片宽度、每行显示数量」。
         *
         * ## 卡片最小宽度取 200px 的依据
         *
         * 卡片里全是 `text-ewb-caption`（11px）等宽字：标题 1 行、摘要 3 行、
         * 最多 3 个标签、底部署名 + 复制按钮。200px 减去左右内边距（各 10px）
         * 与复制按钮，正文区约 130~150px，一行放得下 12~14 个汉字 —— 摘要在
         * 3 行内仍能读出「这张图是什么」。低于 200 时摘要会被挤成每行两三个词，
         * 卡片的用途（一眼认出效果图配的提示词）就没了。
         * 高于 200 则右列窄的时候只剩一列，浪费横向空间。
         *
         * 用 `auto-fill` 而不是 `auto-fit`：条目少于一行能放下的个数时，
         * `auto-fit` 会把空列折叠、把剩下几张卡拉得很宽（3 张卡铺满 900px
         * 每张 300px，图会糊）；`auto-fill` 保留空列，卡片宽度保持稳定。
         *
         * ⚠️ 写在这里而不是 CSS 文件里：与 `ContentLibrary.tsx:289`、
         * `ImageWorkbench.tsx:1220` 同一套做法（同一个值就地可见，不必跳文件）。
         * ⚠️ **注释里不写断点类名** —— `tests/css-refs.mjs` 会把注释里的断点类名
         * 当成真实使用，产物里找不到就红（那个文件头记了这次教训）。 */}
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}
          data-ewb-pl-grid=""
        >
          {pageItems.map(e => (
            <div key={e.id} data-ewb-pl-entry={e.id}>
              <PromptCard
                entry={e}
                license={licenseOf(e)}
                onOpen={() => { setOpenId(openId === e.id ? '' : e.id) }}
                onCopy={() => { void doCopy(e) }}
              />
            </div>
          ))}
        </div>

        {/* ★ 翻页：上一页 / 页码 / 下一页。一次 20 条，翻页回顶部（见上面 goPage）。 */}
        {hits.length <= PAGE_SIZE
          ? null
          : (
            <div data-ewb-pl-pager="" className="mt-3 mb-3 flex flex-none items-center justify-center gap-2">
              <button
                type="button"
                data-ewb-pl-prev=""
                disabled={page <= 1}
                className="pressable is-dark rounded-ctl border border-[var(--dsw-alias-border-l2)] px-3 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)] disabled:opacity-40"
                onClick={() => { goPage(Math.max(1, page - 1)) }}
              >上一页</button>
              <span data-ewb-pl-pageno="" className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                第 {String(page)} / {String(pageCount)} 页
              </span>
              <button
                type="button"
                data-ewb-pl-next=""
                disabled={page >= pageCount}
                className="pressable is-dark rounded-ctl border border-[var(--dsw-alias-border-l2)] px-3 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)] disabled:opacity-40"
                onClick={() => { goPage(Math.min(pageCount, page + 1)) }}
              >下一页</button>
            </div>
          )}
      </div>

      {/* ★ 大图 + 完整正文（用户 m03414 判据 5：「卡片能点开看大图」）。
       *
       * ⚠️ `getContainer={false}` 是**刻意的**：默认 antd 会把弹层 portal 到
       * `document.body`，而测试挂在自己的容器里查 DOM —— portal 出去就查不到，
       * 判据会变成「点了没反应」。关闭 portal 后它渲染在原位，既好验也好读。
       *
       * 展开态原来的「明细块」（作者 / 原帖 / 许可 / 标签 / 模型）也在这里：
       * 卡片上只留标题 + 3 行摘要 + 标签 + 许可署名 + 复制，其余收进弹层，
       * 否则窄列里每张卡会高得像一篇文章。 */}
      <Modal
        open={openId !== ''}
        title={curEntry === null ? '' : (curEntry.title === '' ? '（没有标题）' : curEntry.title)}
        footer={null}
        width={720}
        centered
        getContainer={false}
        onCancel={() => { setOpenId('') }}
        data-ewb-pl-modal=""
        /* ★ 弹层底色与标题色也走令牌（票 36）。
         * 不写的话 antd 用自带亮色默认值 —— 暗色主题下一弹出来就是一整块白。
         * `container` 是 antd 6 那个「面板本体」的语义位（探针查过：
         * 它的类名是 `ant-modal-container`，正是要盖的那一层）。 */
        styles={{
          container: { background: 'var(--dsw-alias-bg-layer-1)' },
          title: { color: 'var(--dsw-alias-label-primary)' },
          body: { color: 'var(--dsw-alias-label-secondary)' },
        }}
      >
        {curEntry === null
          ? null
          : (
            <div data-ewb-pl-detail={curEntry.id} className="flex max-h-[70vh] min-h-0 flex-col">
              {curEntry.coverUrl === ''
                ? (
                  <span
                    data-ewb-pl-modal-noimg=""
                    className="grid h-48 w-full place-items-center rounded-ctl border border-dashed border-[var(--dsw-alias-border-l2)] text-[var(--dsw-alias-label-tertiary)]"
                  >
                    <span className="flex flex-col items-center gap-1">
                      <span className="font-mono text-ewb-meta">无效果图</span>
                      <span className="font-mono text-ewb-caption">上游这条没有给图</span>
                    </span>
                  </span>
                )
                : (
                  <img
                    data-ewb-pl-cover=""
                    src={curEntry.coverUrl}
                    alt={curEntry.title}
                    loading="lazy"
                    className="max-h-56 w-full rounded-ctl object-contain"
                  />
                )}
              <div className="mt-3 min-h-0 flex-1 overflow-y-auto border-t border-[var(--dsw-alias-border-l2)] pt-3">
                {/* ★ 全部正文（不截断）。走 renderEmphasis 把 `**` 渲染成粗体；
                 * 复制那条路**不过**它（复制出去的是给模型的原文）。 */}
                <div
                  data-ewb-pl-prompt=""
                  className="whitespace-pre-wrap break-words font-mono text-ewb-meta leading-relaxed text-[var(--dsw-alias-label-primary)]"
                >{renderEmphasis(curEntry.prompt)}</div>
                <div className="mt-3 flex flex-col gap-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                  {curEntry.description === ''
                    ? null
                    : <span data-ewb-pl-desc="">说明 {curEntry.description}</span>}
                  {/* ★ 署名：CC BY 4.0 要求保留作者。**每个源都显示**，不按源特判。 */}
                  <span data-ewb-pl-author="">作者 {curEntry.author === '' ? '（上游没有写）' : curEntry.author}</span>
                  <a
                    data-ewb-pl-sourceurl=""
                    href={curEntry.sourceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="truncate text-[var(--dsw-alias-link)] underline-offset-2 hover:underline"
                  >{curEntry.sourceUrl === '' ? '（上游没有给原帖地址）' : curEntry.sourceUrl}</a>
                  <span data-ewb-pl-license="">许可 {licenseOf(curEntry)}</span>
                  {Array.isArray(curEntry.tags) && curEntry.tags.length > 0
                    ? <span data-ewb-pl-entrytags="">标签 {curEntry.tags.join(' · ')}</span>
                    : null}
                  {curEntry.imageModel === '' && curEntry.imageMode === ''
                    ? null
                    : <span data-ewb-pl-model="">模型 {curEntry.imageModel === '' ? '—' : curEntry.imageModel}{curEntry.imageMode === '' ? '' : ' · ' + curEntry.imageMode}</span>}
                </div>
              </div>
              <div className="mt-3 flex flex-none items-center gap-2">
                <button
                  type="button"
                  data-ewb-pl-modal-copy=""
                  className="pressable is-dark rounded-ctl border border-[var(--dsw-alias-border-l2)] px-3 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                  onClick={() => { void doCopy(curEntry) }}
                >复制正文</button>
              </div>
            </div>
          )}
      </Modal>
    </div>
  )
}
