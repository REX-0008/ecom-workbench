/** 画布库：内容板里「已经有哪些画布」的清单页（计划 §三 3.1）。
 *
 * ## 它做什么
 *
 * 新建、打开、重命名、**复制**、删除；每行显示**节点数**与**更新时间**。
 *
 * ## 为什么清单要单独一个文件
 *
 * 清单页与画布本体是两件不同的事：清单只要列表数据，画布要 React Flow。
 * 放一个文件里的话，一进内容板就会为了「可能要显示画布」把 React Flow 拉起来
 * （那是几百 KB 与一次布局）。分开之后，没有打开画布的人一个字节都不用付。
 *
 * ## 删之前为什么不再弹一次确认
 *
 * 弹。这不是「多问一句」，而是**真的会丢东西**：画布文件里是节点与位置，
 * 删了只能重建。`window.confirm` 是这里能用的最轻的办法 —— 换成自绘对话框
 * 会把这一格撑出几百行，而它只是列表页上的一个动作。
 *
 * ## 复制（票 46，2026-10-28）
 *
 * 用户原话：「执行和内容的工作流管理与画布库都增加复制功能」。
 *
 * 副本的节点 / 边 id **原样保留**，只换画布 id —— 理由与核实过的三条依据写在
 * `content-canvas-store.ts` 的 `duplicateCanvas` 上面。一句话：
 * 节点 id 只在一个画布内部被引用，跨画布没有反查；而重生成却漏改 `edges` /
 * `groupId` 才会把引用指空。
 */
import { useCallback, useEffect, useState } from 'react'
import { Badge, Label } from './terminal.tsx'
import { when } from './board-kit.ts'
import type { CanvasListItem } from './content-canvas-store.ts'
import { artifactHref, canvasThumbOf, createCanvas, deleteCanvas, duplicateCanvas, listCanvases, loadCanvas, renameCanvas } from './content-canvas-store.ts'

/** 画布库的入参。 */
export interface ContentCanvasLibProps {
  /** 打开一份画布（由内容板转给骨架：切到画布那一格）。 */
  onOpen: (id: string) => void
  /** 这一格是不是正显示着（隐藏时不去拉数据）。 */
  active: boolean
}

/**
 * 画布库清单页。
 * @param props - 打开回调与是否可见。
 * @returns 界面。
 */
export function ContentCanvasLib({ onOpen, active }: ContentCanvasLibProps): React.JSX.Element {
  const [items, setItems] = useState<CanvasListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  /** 正在改名的画布 id（空串 = 没有）。 */
  const [renaming, setRenaming] = useState('')
  const [draft, setDraft] = useState('')

  /**
   * 搜索词（票 45，2026-10-28）。
   *
   * 用户原话：「给这三个都增加搜索功能，他们都是可能会很多的东西需要搜索功能」。
   *
   * ## 搜什么：**只搜标题**
   *
   * 画布上除了标题没有别的「给人认它」的东西。节点内容不在清单里
   * （清单只回标题与时间），而要让搜索覆盖节点内容就得逐份读 JSON ——
   * 那正是这个清单当初拆出来要避免的事（见文件头「为什么清单要单独一个文件」）。
   */
  const [q, setQ] = useState('')

  /**
   * 按搜索词筛过的清单。
   *
   * 空串 = 不筛（显示全部），与提示词库的 `filterEntries` 同一判据。
   */
  const shownItems = q.trim() === ''
    ? items
    : items.filter(it => it.title.toLowerCase().includes(q.trim().toLowerCase()))

  /**
   * 重读清单。
   * @param silent - 静默（重命名等动作之后不该闪一下「读取中」）。
   */
  const reload = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true)
    const r = await listCanvases()
    setLoading(false)
    if (!r.ok) { setErr(r.error ?? '读不到画布清单'); return }
    setErr('')
    const list = r.data ?? []
    setItems(list)
    /* ★ 缩略图（用户 m02814 #105）：清单接口只回摘要，不回节点，
     * 所以每条要再读一次完整画布才拿得到产物 id。**逐条异步填**，
     * 不阻塞清单显示 —— 先让用户看到行，缩略图晚一拍出现。
     *
     * 为什么不用「让宿主半在清单里带缩略图」：那要改 `src/index.ts`（后端地盘），
     * 而且清单接口现在只读文件名、不解析内容，加进去会变成「每列一次要读 N 份 JSON」。 */
    for (const it of list) {
      void (async () => {
        const doc = await loadCanvas(it.id)
        if (!doc.ok || doc.data === undefined) return
        const thumb = canvasThumbOf(doc.data.nodes)
        if (thumb === undefined) return
        /* 只补自己这一条；用函数式更新，避免等回来的顺序把别人的改动盖掉。 */
        setItems(prev => prev.map(x => (x.id === it.id ? { ...x, thumb } : x)))
      })()
    }
  }, [])

  /* 只在**显示着**的时候读：切走后还去拉一次接口是白花。 */
  useEffect(() => {
    if (active) void reload()
  }, [active, reload])

  /** 新建并直接打开。 */
  const onCreate = async (): Promise<void> => {
    const r = await createCanvas('新画布')
    if (!r.ok || r.data === undefined) { setErr(r.error ?? '新建失败'); return }
    await reload(true)
    onOpen(r.data.id)
  }

  /** 提交改名。 */
  const commitRename = async (): Promise<void> => {
    const id = renaming
    const title = draft.trim()
    setRenaming('')
    if (id === '' || title === '') return
    const r = await renameCanvas(id, title)
    if (!r.ok) { setErr(r.error ?? '改名失败'); return }
    await reload(true)
  }

  /** 删一份。 */
  const onDelete = async (it: CanvasListItem): Promise<void> => {
    const yes = window.confirm('删除画布「' + it.title + '」？画布里的节点与位置会一起消失。')
    if (!yes) return
    const r = await deleteCanvas(it.id)
    if (!r.ok) { setErr(r.error ?? '删除失败'); return }
    await reload(true)
  }

  /**
   * 复制一份（票 46，2026-10-28）。
   *
   * ## 为什么不复用「新建 + 打开」
   *
   * 用户要的是「拿一份已有的复制出第二份，再在副本上改」。复制完**不自动打开** ——
   * 打开是一个额外动作，连着复制三份的人不想被切走三次。副本出现在列表里就已经达成目的。
   *
   * ## 撞名
   *
   * 画布的 id 后端本来就会防撞（`canvases.ts:151`），但**标题**会重（title 不是 id）。
   * 所以这里把现有标题都传下去，让 `copyNameOf` 算出「X 副本 / X 副本 2」。
   *
   * @param it - 要复制的那一份。
   */
  const onDuplicate = async (it: CanvasListItem): Promise<void> => {
    setErr('')
    const taken = new Set(items.map(x => x.title))
    const r = await duplicateCanvas(it.id, taken)
    if (!r.ok) { setErr(r.error ?? '复制失败'); return }
    await reload(true)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-ewb-canvas-lib="">
      <div className="mb-2 flex flex-none items-center gap-3">
        <Label rule>画布库</Label>
        <span className="flex-1" />
        <Badge tone="default" ghost>{String(items.length)} 份</Badge>
        <button
          type="button"
          data-ewb-canvas-new=""
          className="pressable is-dark shrink-0 whitespace-nowrap rounded-ctl border border-[var(--dsw-alias-border-l2)] px-3 py-1.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-primary)]"
          onClick={() => { void onCreate() }}
        >新建画布</button>
      </div>

      {err === ''
        ? null
        : (
          <div
            data-ewb-canvas-lib-error=""
            className="mb-2 flex flex-none items-start gap-2 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2"
          >
            <span className="dot warn" style={{ marginTop: 5 }} />
            <span className="min-w-0 flex-1 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-secondary)]">{err}</span>
            <button
              type="button"
              className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
              onClick={() => { void reload() }}
            >重试</button>
          </div>
        )}

      {/* ★ 搜索（票 45，2026-10-28）。位置照提示词库：列表正上方。
       *
       * 只在**有画布时**才显示 —— 一份都没有时搜索框没有意义，
       * 摆在那里只会让人以为「是不是该搜一下」。
       *
       * 计数显示的是**筛完之后的份数**（不是总数），与提示词库那个「N 条」一致。 */}
      {items.length > 0
        ? (
          <div data-ewb-canvas-search-bar="" className="mb-2 flex flex-none flex-wrap items-center gap-1.5">
            <input
              data-ewb-canvas-search=""
              className="min-w-0 flex-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none"
              value={q}
              placeholder="搜画布标题"
              onChange={(e) => { setQ(e.target.value) }}
            />
            <span data-ewb-canvas-hit-count="" className="flex-none font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
              {String(shownItems.length)} 份
            </span>
            {q.trim() === ''
              ? null
              : (
                <button
                  type="button"
                  data-ewb-canvas-clear=""
                  className="pressable is-dark flex-none rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                  onClick={() => { setQ('') }}
                >清空搜索</button>
              )}
          </div>
        )
        : null}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-ewb-canvas-rows="">
        {loading && items.length === 0
          ? (
            <div className="px-1 py-3 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
              读取中…
            </div>
          )
          : null}
        {!loading && items.length === 0 && err === ''
          ? (
            <div
              data-ewb-canvas-empty=""
              className="mt-1 flex flex-col items-start gap-1.5 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-6"
            >
              <span className="font-mono text-ewb-meta text-[var(--dsw-alias-label-secondary)]">还没有画布</span>
              <span className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
                新建一份之后，节点、连线、视口都会存在宿主里；刷新页面不会丢。
              </span>
            </div>
          )
          : null}

        {/* ★ 「没搜到」单独一句（票 45，2026-10-28）。
         *
         * 与上面那句「还没有画布」**不能共用** —— 两者的下一步完全不同：
         * 没有就新建，搜不到就换个词。共用一句话会让用户去新建一份本来就有的画布。 */}
        {!loading && items.length > 0 && shownItems.length === 0 && err === ''
          ? (
            <div
              data-ewb-canvas-no-hit=""
              className="mt-1 flex flex-col items-start gap-1.5 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-6"
            >
              <span className="font-mono text-ewb-meta text-[var(--dsw-alias-label-secondary)]">没有匹配的画布</span>
              <span className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
                共 {String(items.length)} 份画布，标题里都没有「{q.trim()}」。换个词，或者清空搜索。
              </span>
            </div>
          )
          : null}

        {shownItems.map(it => (
          <div
            key={it.id}
            data-ewb-canvas-row={it.id}
            className="flex items-center gap-3 border-b border-[var(--dsw-alias-border-l2)] px-1 py-2"
          >
            {/* ★ 缩略图（用户 m02814 #105）：这个画布里第一张能当缩略图的产物。
             * 没有产物时画一个占位框 —— 比留白好，用户能看出「这一格本来该有图」。 */}
            {it.thumb === undefined
              ? (
                <span
                  data-ewb-canvas-thumb-empty={it.id}
                  className="flex h-10 w-10 flex-none items-center justify-center rounded-ctl border border-dashed border-[var(--dsw-alias-border-l2)] font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]"
                  title="这一份画布里还没有能当缩略图的产物"
                >—</span>
              )
              : (
                <img
                  data-ewb-canvas-thumb={it.id}
                  className="h-10 w-10 flex-none rounded-ctl border border-[var(--dsw-alias-border-l2)] object-cover"
                  src={artifactHref(it.thumb)}
                  alt=""
                  draggable={false}
                />
              )}
            {renaming === it.id
              ? (
                <input
                  autoFocus
                  data-ewb-canvas-rename-input=""
                  className="min-w-0 flex-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none"
                  value={draft}
                  onChange={(e) => { setDraft(e.target.value) }}
                  onBlur={() => { void commitRename() }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename()
                    if (e.key === 'Escape') setRenaming('')
                  }}
                />
              )
              : (
                <button
                  type="button"
                  data-ewb-canvas-open={it.id}
                  className="min-w-0 flex-1 truncate rounded-ctl border border-transparent px-1 py-1 text-left text-ewb-meta text-[var(--dsw-alias-label-primary)] hover:border-[var(--dsw-alias-border-l2)]"
                  title={'打开「' + it.title + '」'}
                  onClick={() => { onOpen(it.id) }}
                >{it.title}</button>
              )}
            <span
              data-ewb-canvas-count={it.id}
              className="flex-none font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]"
            >{String(it.nodeCount)} 个节点</span>
            <span
              data-ewb-canvas-updated={it.id}
              className="flex-none font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]"
            >{when(it.updatedAt)}</span>
            <button
              type="button"
              data-ewb-canvas-rename={it.id}
              className="pressable is-dark flex-none rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
              onClick={() => { setRenaming(it.id); setDraft(it.title) }}
            >改名</button>
            {/* ★ 复制（票 46，用户 2026-10-28：「执行和内容的工作流管理与画布库都增加复制功能」）。
             * 放在「改名」与「删除」之间：三个都是对**这一份**的动作，聚在一起；
             * 复制是比删除轻、比改名重的一步，夹在中间刚好。 */}
            <button
              type="button"
              data-ewb-canvas-duplicate={it.id}
              className="pressable is-dark flex-none rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
              title="复制出一份新的画布，节点、连线、位置都会带过去"
              onClick={() => { void onDuplicate(it) }}
            >复制</button>
            <button
              type="button"
              data-ewb-canvas-delete={it.id}
              className="pressable is-dark flex-none rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
              onClick={() => { void onDelete(it) }}
            >删除</button>
          </div>
        ))}
      </div>
    </div>
  )
}
