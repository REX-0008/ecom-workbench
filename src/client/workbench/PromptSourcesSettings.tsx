/** 配置页 · 提示词源（P3 第 4 块，用户 m03414）。
 *
 * ## 这一块解决什么
 *
 * 后端把提示词源做成了**可配置的**（`docs/机制-配置面接口.md` §四）：五个内置源
 * 能改名 / 改地址 / 停用（删不掉），用户还能加自己的源。而界面上一个入口都没有 ——
 * 用户只能看代码里写死的那五份，想加一个自己的提示词仓库没有任何办法。
 *
 * ## 五个动作 + 一条边界
 *
 * | 动作 | 路由 | 边界 |
 * |---|---|---|
 * | 列出 | `GET /prompt-sources/config` | 停用的也列（`enabled: false`），要能再开回来 |
 * | 加 | `POST /prompt-sources/config` | 只要 `name` + `url` |
 * | 改 | `PUT /prompt-sources/config/:id` | `enabled` / `name` / `url` |
 * | 删 | `DELETE /prompt-sources/config/:id` | ⚠️ **内置的删不掉：409 + `builtin:true`** |
 * | 测连通 | `POST /prompt-sources/config/:id/probe` | 只数条目、不落盘 |
 * | 刷新 | `POST /prompt-sources/:id/refresh` | 内置与自定义**都支持**（地址以配置为准） |
 *
 * ## ⚠️ 「内置的删不掉」怎么显示（这一块最容易做错的地方）
 *
 * 不能把删除按钮做成灰的却不说原因 —— 那等于让用户去猜。
 * 正确做法：内置那几条**不显示删除按钮**，显示的是「内置，只能停用」+ 一个**停用**按钮。
 * 后端若真回了 409（比如用户从别的入口触发），也要把 `builtin:true` 翻译成
 * 「这是内置源，删不掉，只能停用」，而不是把后端那句话原样甩给用户。
 *
 * ## ⚠️ 停用会真的把它从提示词库里摘掉
 *
 * 配置页与提示词库是**两个消费方**（文档 §四 那张表）：
 *   · `GET /prompt-sources/config`（本页）→ 停用的**仍在**，`enabled: false`
 *   · `GET /prompt-sources`（提示词库）→ 停用的**不在了**
 *
 * 所以停用前要确认一句，且说清「内容不会丢，随时能开回来」——
 * 用户看到提示词库里少了一份会以为数据没了。
 *
 * ## 全部停用时：空态要有话说
 *
 * `GET /prompt-sources` 在清单为空时多回一个 `emptyNote`。本页自己也要能表达
 * 「一个都没启用」这件事 —— 「没配」「停光了」「加载失败」在页面上必须长得不一样。
 */
import { useCallback, useEffect, useState } from 'react'
import { call } from './board-kit.ts'

/** 一个提示词源（`GET /prompt-sources/config` 的 `sources[]`）。 */
export interface SourceRow {
  /** 源 id。 */
  id: string
  /** 显示名。 */
  name: string
  /** 上游地址（空串 = 只用内置副本，不拉）。 */
  url: string
  /** 仓库主页。 */
  homepage: string
  /** 许可。 */
  license: string
  /** 启用没有。 */
  enabled: boolean
  /** 是不是内置的（内置的删不掉）。 */
  builtin: boolean
}

/** 测连通的回包（HTTP 200，看 ok）。 */
export interface ProbeReply {
  /** 通不通。 */
  ok?: boolean
  /** 数到几条（成功时）。 */
  count?: number
  /** 上游状态码。 */
  status?: number
  /** 实际请求的地址。 */
  url?: string
  /** 失败原因。 */
  error?: string
}

/** 刷新的回包。 */
export interface RefreshReply {
  /** 成功没有。 */
  ok?: boolean
  /** 拉到几条。 */
  count?: number
  /** 失败原因。 */
  error?: string
  /** 给人看的说明。 */
  note?: string
}

/** 删除被拒绝时的回包（409）。 */
export interface DeleteReply {
  /** 成功没有。 */
  ok?: boolean
  /** 是不是内置源（409 时带）。 */
  builtin?: boolean
  /** 原因。 */
  error?: string
}

/**
 * 一行显示成什么「状态字」。
 *
 * ⚠️ 这一句必须能区分三件事：**在用** / **停用** / **内置且在用**。
 * 「内置」不是状态而是身份，所以它不进状态字，另用一列标。
 *
 * @param s - 一个源。
 * @returns 状态字。
 */
export function stateText(s: SourceRow): string {
  return s.enabled ? '在用' : '已停用'
}

/**
 * 那一行该显示哪些按钮。
 *
 * ## 为什么抽成纯函数
 *
 * 「内置的删不掉」是本块最容易做错的地方 —— 做成灰按钮**却不说原因**等于没做。
 * 抽出来之后判据能直接钉：内置那些**不许有删除按钮**，但**必须有停用按钮**；
 * 自定义的**必须有删除按钮**。
 *
 * @param s - 一个源。
 * @returns 三个布尔：能不能改 / 能不能停用（或启用）/ 能不能删。
 */
export function rowActions(s: SourceRow): { canEdit: boolean, canToggle: boolean, canDelete: boolean } {
  return {
    /* 改名 / 改地址：内置与自定义都能改（内置的改动存在 override 里）。 */
    canEdit: true,
    /* 停用 / 启用：两种都能。 */
    canToggle: true,
    /* ★ 删除：只有自定义的能删。内置的删了下次升级还会回来，所以后端直接 409。 */
    canDelete: s.builtin !== true,
  }
}

/**
 * 把删除失败的 409 翻成人话。
 *
 * 后端原话是「「awesome-gpt-image」是内置源，删不掉（内置副本跟代码一起打包，
 * 删了下次升级还会回来）。不想用它就停用：把 enabled 改成 false。」
 *
 * 这里做两件事：
 *   ① 保底 —— 万一后端哪天把这句话改短了，界面仍然说清「只能停用」；
 *   ② 指出**下一步怎么做**（给停用按钮，而不是让用户自己去改 enabled）。
 *
 * @param reply - 后端回包。
 * @returns 给人看的一句话。
 */
export function deleteRefusal(reply: DeleteReply | null | undefined): string {
  if (reply?.builtin === true) {
    return '这是内置源，删不掉（内置副本跟代码一起打包，删了下次升级还会回来）。要用「停用」代替 —— 停用之后提示词库里就没有它了，内容不会丢。'
  }
  return reply?.error ?? '删除失败'
}

/**
 * 全部停用时的空态话。
 *
 * 后端的 `emptyNote` 会带一句（`GET /prompt-sources` 那边），但本页看的是
 * `/prompt-sources/config` —— 那一份**不会**因为全停用而空（停用的仍列出来）。
 * 所以「一个都没启用」这个状态要本页自己判断。
 *
 * @param rows - 全部源。
 * @returns 要显示的话；不需要显示时给空串。
 */
export function allDisabledNote(rows: readonly SourceRow[]): string {
  if (rows.length === 0) return '还没有任何提示词源。加一个自己的源，或者把内置的启用回来。'
  if (rows.some(r => r.enabled)) return ''
  return '提示词源全被停用了 —— 提示词库里现在一份都没有。启用至少一个，或加一个自己的源。'
}

/** 提示词源那一块的入参。 */
export interface PromptSourcesSettingsProps {
  /** 这一块是不是正显示着（不显示就不发请求）。 */
  active: boolean
}

/**
 * 提示词源设置。
 * @param props - 是否可见。
 * @returns 界面。
 */
export function PromptSourcesSettings({ active }: PromptSourcesSettingsProps): React.JSX.Element {
  const [rows, setRows] = useState<SourceRow[]>([])
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  /** 正在忙的那一项（按钮显示进度），键是 `id:动作`。 */
  const [busy, setBusy] = useState('')
  /** 每一条的测连通结论（没测过的键不存在 —— 不显示假结论）。 */
  const [probed, setProbed] = useState<Record<string, ProbeReply>>({})
  /** 新增源的草稿。 */
  const [adding, setAdding] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftUrl, setDraftUrl] = useState('')
  /** 正在改名的那一条（空串 = 没有）。 */
  const [editing, setEditing] = useState('')
  const [editName, setEditName] = useState('')
  const [editUrl, setEditUrl] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const r = await call<{ sources?: SourceRow[] }>('/prompt-sources/config')
    setLoading(false)
    if (!r.ok) { setErr(r.error ?? '读不到提示词源'); return }
    setErr('')
    setRows(Array.isArray(r.body?.sources) ? r.body.sources : [])
  }, [])

  useEffect(() => {
    if (active) void load()
  }, [active, load])

  /** 开关一条。 */
  const toggle = async (s: SourceRow): Promise<void> => {
    /* ★ 停用会真的从提示词库摘掉 —— 必须先确认，且说清「内容不会丢」。 */
    if (s.enabled) {
      const yes = window.confirm('停用「' + s.name + '」？停用之后提示词库里就没有它了（内容不会丢，随时能开回来）。')
      if (!yes) return
    }
    setBusy(s.id + ':toggle')
    setNote('')
    const r = await call<unknown>('/prompt-sources/config/' + encodeURIComponent(s.id), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: !s.enabled }),
    })
    setBusy('')
    if (!r.ok) { setErr(r.error ?? '改不了这一条'); return }
    setErr('')
    setNote((s.enabled ? '已停用：' : '已启用：') + s.name + (s.enabled ? '（提示词库里现在没有它了）' : ''))
    await load()
  }

  /** 删一条（只有自定义的能删）。 */
  const remove = async (s: SourceRow): Promise<void> => {
    const yes = window.confirm('删除自定义源「' + s.name + '」？删了要重新加。')
    if (!yes) return
    setBusy(s.id + ':delete')
    setNote('')
    const r = await call<DeleteReply>('/prompt-sources/config/' + encodeURIComponent(s.id), { method: 'DELETE' })
    setBusy('')
    if (!r.ok) {
      /* ★ 409 + builtin:true 不许原样甩给用户 —— 翻成「只能停用」并指出下一步。 */
      setErr(deleteRefusal(r.body))
      return
    }
    setErr('')
    setNote('已删除：' + s.name)
    await load()
  }

  /** 测连通（只数条目，不落盘）。 */
  const probe = async (s: SourceRow): Promise<void> => {
    setBusy(s.id + ':probe')
    const r = await call<ProbeReply>('/prompt-sources/config/' + encodeURIComponent(s.id) + '/probe', { method: 'POST' })
    setBusy('')
    if (!r.ok) {
      setProbed(prev => ({ ...prev, [s.id]: { ok: false, error: r.error ?? '测不出结论' } }))
      return
    }
    setProbed(prev => ({ ...prev, [s.id]: r.body ?? { ok: false, error: '测不出结论' } }))
  }

  /** 刷新（真拉上游并写进缓存）。
   *
   * ## 三种结果都要说清
   *
   * | 结果 | 后端回什么 | 界面 |
   * |---|---|---|
   * | 成功 | `{ ok: true, count: 53, fetchedAt }` | 「已刷新：名字（53 条）」 |
   * | 有 ok 但失败 | `{ ok: false, error: '连不上：…' }` | 后端原话 |
   * | 没配地址 | `{ ok: false, error: '这个源没有配上游地址（它只用内置副本）' }` | 后端原话 |
   * | 已停用 | 拒绝：「这个源已停用」 | 后端原话 |
   *
   * ⚠️ **不自己编错误文案**：`refreshSource` 那四句都是照着
   * 「用户该去改什么」写的（地址写错 / 检查网络 / 这个源不需要拉），
   * 界面翻译一遍只会丢信息。
   *
   * ## 刷完为什么要重新 `load()`
   *
   * 刷新会改 `count` / `fetchedAt`（配置页列表上要显示更新后的条数），
   * 也会让提示词库那边读到新内容。不重读的话界面还挂着旧的条数。
   *
   * @param s - 那一行。
   */
  const refresh = async (s: SourceRow): Promise<void> => {
    setBusy(s.id + ':refresh')
    setNote('')
    const r = await call<RefreshReply>('/prompt-sources/' + encodeURIComponent(s.id) + '/refresh', { method: 'POST' })
    setBusy('')
    if (!r.ok) { setErr(r.error ?? '刷新失败'); return }
    const body = r.body ?? {}
    if (body.ok === false) { setErr(body.error ?? '刷新失败'); return }
    setErr('')
    setNote('已刷新：' + s.name + '（' + String(body.count ?? 0) + ' 条）' + (body.note === undefined ? '' : ' · ' + body.note))
    await load()
  }

  /** 加一个自定义源。 */
  const add = async (): Promise<void> => {
    const name = draftName.trim()
    const url = draftUrl.trim()
    if (name === '' || url === '') { setErr('名字与地址都要填'); return }
    setBusy('add')
    setNote('')
    const r = await call<unknown>('/prompt-sources/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, url }),
    })
    setBusy('')
    if (!r.ok) { setErr(r.error ?? '加不了这个源'); return }
    setErr('')
    setAdding(false)
    setDraftName('')
    setDraftUrl('')
    setNote('已新增：' + name)
    await load()
  }

  /** 保存改名 / 改地址。 */
  const saveEdit = async (s: SourceRow): Promise<void> => {
    setBusy(s.id + ':edit')
    setNote('')
    const body: Record<string, unknown> = { name: editName.trim() }
    /* 地址只在用户这次填了的时候才发（空串会让后端以为「要清掉地址」）。 */
    if (editUrl.trim() !== '') body.url = editUrl.trim()
    const r = await call<unknown>('/prompt-sources/config/' + encodeURIComponent(s.id), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    setBusy('')
    if (!r.ok) { setErr(r.error ?? '改不了这一条'); return }
    setErr('')
    setEditing('')
    /* 生效依据：配置改了立刻影响「清单与单条读取」—— `prompt-cache.ts` 的
     * `readSource` 每次先问配置。地址改过这件事现在由后端自己判
     * （`cacheIsStale`：缓存里的 `url` 与配置里的不同就算过期），
     * 读路径不再把旧地址拉的内容冒充成「现在的缓存」。
     *
     * ⚠️ 这一句只说本页能保证的事：内容要换成新地址的，仍然得刷一次（读路径不联网）。
     *    「过期这件事在后端已经说清了」不给用户看 —— 提示词库那一格现在读的是
     *    随代码发布的副本、一个请求都不发（`PromptLibrary.tsx` 文件头），
     *    所以界面上暂时看不到那句话。写进来就成了替别人承诺。 */
    setNote('已保存：' + s.name + '。名字立刻生效；改过地址的，旧内容仍按旧地址算，点一次「刷新」才会按新地址拉下来。')
    await load()
  }

  const field = 'min-w-0 flex-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none'
  const btn = 'pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]'
  const disabledNote = allDisabledNote(rows)

  return (
    <div className="flex flex-col gap-2" data-ewb-sources="">
      <div className="flex items-center gap-3">
        <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">提示词源</span>
        <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" data-ewb-sources-total="">
          共 {String(rows.length)} 个 / 在用 {String(rows.filter(r => r.enabled).length)} 个
        </span>
        <span className="flex-1" />
        <button
          type="button"
          data-ewb-sources-reload=""
          className={btn}
          onClick={() => { void load() }}
        >重新读取</button>
        <button
          type="button"
          data-ewb-sources-add=""
          className={btn}
          onClick={() => { setAdding(v => !v); setErr('') }}
        >{adding ? '取消新增' : '新增源'}</button>
      </div>

      <div className="rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]" data-ewb-sources-note="">
        内置的五个源删不掉（跟代码一起打包，删了下次升级还会回来），不想用就停用。
        停用之后提示词库里就没有它了 —— 内容不会丢，随时能开回来。
      </div>

      {err === ''
        ? null
        : (
          <div data-ewb-sources-error="" className="flex items-start gap-2 rounded-card border border-dashed border-[#ff5f6d] px-3 py-2">
            <span className="dot warn" style={{ marginTop: 5 }} />
            <span className="min-w-0 flex-1 font-mono text-ewb-caption leading-relaxed text-[#ff8a8a]">{err}</span>
          </div>
        )}

      {note === ''
        ? null
        : (
          <div data-ewb-sources-done="" className="rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2 font-mono text-ewb-caption text-[#4ec9b0]">{note}</div>
        )}

      {/* 全部停用：必须说清，否则用户以为「提示词库坏了」。 */}
      {disabledNote === ''
        ? null
        : (
          <div data-ewb-sources-alldisabled="" className="rounded-card border border-dashed border-[#f0b429] px-3 py-2 font-mono text-ewb-caption leading-relaxed text-[#f0b429]">
            {disabledNote}
          </div>
        )}

      {/* 新增表单 */}
      {!adding
        ? null
        : (
          <div data-ewb-sources-new="" className="flex flex-col gap-1.5 rounded-card border border-[var(--dsw-alias-border-l2)] px-3 py-2">
            <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
              <span className="w-14 shrink-0">名字</span>
              <input data-ewb-sources-new-name="" className={field} value={draftName} onChange={e => { setDraftName(e.target.value) }} placeholder="如 我自己的提示词库" />
            </label>
            <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
              <span className="w-14 shrink-0">地址</span>
              <input data-ewb-sources-new-url="" className={field} value={draftUrl} onChange={e => { setDraftUrl(e.target.value) }} placeholder="指向一个顶层是数组的 JSON" />
            </label>
            <div className="flex items-center gap-2">
              <span className="flex-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                加完可以先「测连通」看地址对不对，再「刷新」把内容拉下来。
              </span>
              <button type="button" data-ewb-sources-new-save="" disabled={busy === 'add'} className={btn} onClick={() => { void add() }}>加它</button>
            </div>
          </div>
        )}

      {loading && rows.length === 0
        ? <div className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">读取中…</div>
        : null}

      {rows.map(s => {
        const act = rowActions(s)
        const pb = probed[s.id]
        const editingThis = editing === s.id
        return (
          <div
            key={s.id}
            data-ewb-sources-row={s.id}
            data-ewb-sources-enabled={s.enabled ? '' : undefined}
            data-ewb-sources-builtin={s.builtin ? '' : undefined}
            className="flex flex-col gap-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1.5"
          >
            {editingThis
              ? (
                <div className="flex flex-col gap-1">
                  <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
                    <span className="w-14 shrink-0">名字</span>
                    <input data-ewb-sources-edit-name="" className={field} value={editName} onChange={e => { setEditName(e.target.value) }} />
                  </label>
                  <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
                    <span className="w-14 shrink-0">地址</span>
                    <input data-ewb-sources-edit-url="" className={field} value={editUrl} onChange={e => { setEditUrl(e.target.value) }} placeholder="留空表示不改" />
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="flex-1" />
                    <button type="button" data-ewb-sources-edit-cancel="" className={btn} onClick={() => { setEditing('') }}>取消</button>
                    <button type="button" data-ewb-sources-edit-save="" disabled={busy === s.id + ':edit'} className={btn} onClick={() => { void saveEdit(s) }}>保存</button>
                  </div>
                </div>
              )
              : (
                <>
                  <div className="flex items-center gap-2">
                    <span className="w-16 shrink-0 font-mono text-ewb-caption text-[var(--dsw-alias-label-primary)]" data-ewb-sources-name={s.id}>{s.name}</span>
                    {/* ★ 状态字：在用 / 已停用。三态「没配 / 停光了 / 加载失败」要分得开。 */}
                    <span
                      data-ewb-sources-state={s.id}
                      className={[
                        'shrink-0 font-mono text-ewb-caption',
                        s.enabled ? 'text-[#4ec9b0]' : 'text-[var(--dsw-alias-label-tertiary)]',
                      ].join(' ')}
                    >{stateText(s)}</span>
                    {/* ★ 身份：内置 / 自定义。它不是状态，所以单独一列。 */}
                    <span data-ewb-sources-kind={s.id} className="shrink-0 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                      {s.builtin ? '内置' : '自定义'}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" data-ewb-sources-url={s.id} title={s.url}>
                      {s.url === '' ? '（没有上游地址，只用内置副本）' : s.url}
                    </span>
                    <span className="flex-1" />
                    {/* ★ 内置的**不给删除按钮**，但要给停用按钮，并说明「只能停用」。
                     * 做成灰按钮却不解释，等于让用户去猜 —— 那是这一块最容易做错的地方。 */}
                    {act.canDelete
                      ? (
                        <button type="button" data-ewb-sources-delete={s.id} disabled={busy === s.id + ':delete'} className={btn} onClick={() => { void remove(s) }}>删除</button>
                      )
                      : (
                        <span data-ewb-sources-nodelete={s.id} className="shrink-0 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">内置 · 只能停用</span>
                      )}
                    {act.canToggle
                      ? (
                        <button type="button" data-ewb-sources-toggle={s.id} disabled={busy === s.id + ':toggle'} className={btn} onClick={() => { void toggle(s) }}>
                          {s.enabled ? '停用' : '启用'}
                        </button>
                      )
                      : null}
                    <button type="button" data-ewb-sources-edit={s.id} className={btn} onClick={() => { setEditing(s.id); setEditName(s.name); setEditUrl('') }}>改名</button>
                    <button type="button" data-ewb-sources-probe={s.id} disabled={busy === s.id + ':probe'} className={btn} onClick={() => { void probe(s) }}>测连通</button>
                    {/* 「刷新」：真去上游拉一次并写缓存（`POST /prompt-sources/:id/refresh`）。
                     *
                     * ## 为什么内置与自定义都给这个按钮
                     *
                     * `refreshSource`（`prompt-cache.ts:311-325`）取地址的方式是
                     * `configuredOrNull(id)` → `cfg.url`，**地址以配置为准**：
                     *   · 内置源：地址能被用户改过，改了就用改过的那个；
                     *   · 自定义源：地址只在配置里，照样能拉。
                     *
                     * 所以只要那一行**配了地址**就能刷。没配地址时后端会回
                     * 「这个源没有配上游地址（它只用内置副本）」—— 那句话原样显示，
                     * 不自己编一句「不能刷新」。
                     *
                     * ## 与「测连通」的区别（按钮上要分得开）
                     *
                     * · 测连通：只数条目、**不落盘**（`probeSource` 里没有任何 writeFile）；
                     * · 刷新：真拉、**写进缓存**（`prompt-cache/<id>.json`），刷完提示词库那边
                     *   就能读到内容。
                     * 两件事都会去访问上游，混在一起会让人以为「测通了就拉下来了」。 */}
                    <button
                      type="button"
                      data-ewb-sources-refresh={s.id}
                      disabled={busy === s.id + ':refresh'}
                      className={btn}
                      title="真去上游拉一次，并写进缓存（刷完提示词库那边就能读到）"
                      onClick={() => { void refresh(s) }}
                    >{busy === s.id + ':refresh' ? '刷新中…' : '刷新'}</button>
                  </div>
                  {/* 测连通的结论：只有测过才显示（不显示假结论）。 */}
                  {pb === undefined
                    ? null
                    : (
                      <span
                        data-ewb-sources-probed={s.id}
                        data-ok={pb.ok === true ? '' : undefined}
                        className={['font-mono text-ewb-caption leading-relaxed', pb.ok === true ? 'text-[#4ec9b0]' : 'text-[#ff8a8a]'].join(' ')}
                      >
                        {pb.ok === true
                          ? '连通：上游有 ' + String(pb.count ?? 0) + ' 条（没有落盘，只是数了一下）'
                          : '测不通：' + (pb.error ?? '')}
                      </span>
                    )}
                </>
              )}
          </div>
        )
      })}
    </div>
  )
}
