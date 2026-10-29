/** 配置页 · 存储目录（P3 第 1 块，用户 m03414）。
 *
 * ## 这一块解决什么
 *
 * 用户那张「什么都点不到」的表里，**本地存储目录**是四个路径 —— 后端全做好了
 * （`GET/PUT /storage`，见 `docs/机制-配置面接口.md` §三），但界面一个输入框都没有。
 * 产物只能堆在数据根下，想换盘没有任何入口。
 *
 * ## 三条规矩，界面必须如实反映（全在后端文档里）
 *
 * 1. **空串 = 恢复默认**。所以「清空输入框再保存」是「回到默认」，不是「删掉这一格」。
 *    界面要在输入框旁边写清这件事，否则用户以为清空是「不改」。
 * 2. **改前逐格验可写**（后端建目录 + 真写临时文件再删）。所以保存可能**整份失败**，
 *    回包带 `key` 指是哪一格 —— 界面必须把那一格标出来，而不是笼统说「保存失败」。
 * 3. **任一格不过就整份不存**（半存会让产物散在两个地方）。所以成功时是整份生效，
 *    失败时是一格都没改 —— 界面不要把失败说成「部分成功」。
 *
 * ## 与「重启」的关系
 *
 * 存完**立刻热生效**，但内存里的覆盖表重启就空 —— `apply()` 启动时会从盘上再套一次
 * （`src/index.ts:1304`）。那一套后端已经接好了，界面这边只需保证**存得下去**。
 * 所以这里不提示「重启后生效」（那不准确），只说「已保存，新产物会进新目录」。
 */
import { useCallback, useEffect, useState } from 'react'
import { call } from './board-kit.ts'

/** 五个存储键（顺序照后端 `STORAGE_KEYS`，界面不自己重排）。 */
export const STORAGE_KEYS = ['canvases', 'artifacts', 'materials', 'genLogs', 'promptCache'] as const

/** 一个目录格。 */
export interface StorageDir {
  /** 存储键。 */
  key: string
  /** 中文名（画布 / 产物 / 素材 / 生成记录 / 提示词缓存）。 */
  label: string
  /** 当前生效的路径（改过就是改过的，没改过是默认）。 */
  path: string
  /** 是不是还在用默认路径。 */
  isDefault: boolean
  /** 默认路径（界面上做「恢复默认」的提示用）。 */
  defaultPath: string
}

/**
 * 把 `GET /storage` 的回包摊成界面要的形状。
 *
 * ## 为什么单独抽一个纯函数
 *
 * 「哪一格改过、哪一格是默认」这件事**判据能直接钉**，不用挂 DOM 去点。
 * 而且后端可能只回一部分（`dirs` 少一格）—— 摊平的时候要补齐五格，
 * 否则界面上会少一个输入框，用户以为那格不存在。
 *
 * @param body - `GET /storage` 的回包（可能是 undefined）。
 * @returns 五格（顺序固定）。
 */
export function toDirRows(body: { dirs?: StorageDir[], config?: Record<string, string> } | null | undefined): StorageDir[] {
  const got = Array.isArray(body?.dirs) ? body.dirs : []
  const out: StorageDir[] = []
  for (const key of STORAGE_KEYS) {
    const hit = got.find(d => d.key === key)
    if (hit !== undefined) { out.push(hit); continue }
    /* 后端没给这一格：给一个「空路径 + 算默认」的占位，**不要跳过** ——
     * 少一行会让用户以为那一格不存在。 */
    out.push({ key, label: key, path: '', isDefault: true, defaultPath: '' })
  }
  return out
}

/**
 * 保存体该发什么。
 *
 * 空串**要发**（那是「恢复默认」的约定），所以这里不能用「空就不发」那套过滤 ——
 * 与渠道表单里 `apiKey` 的处理**正好相反**，别照抄那一段。
 *
 * @param drafts - 界面上五格当前的值。
 * @returns PUT 的 body。
 */
export function toSaveBody(drafts: Record<string, string>): { dirs: Record<string, string> } {
  const dirs: Record<string, string> = {}
  for (const key of STORAGE_KEYS) {
    const v = drafts[key]
    if (typeof v !== 'string') continue
    dirs[key] = v.trim()
  }
  return { dirs }
}

/** 存储目录那一块的入参。 */
export interface StorageSettingsProps {
  /** 这一块是不是正显示着（不显示就不发请求）。 */
  active: boolean
}

/**
 * 存储目录设置。
 * @param props - 是否可见。
 * @returns 界面。
 */
export function StorageSettings({ active }: StorageSettingsProps): React.JSX.Element {
  /** 后端回的原始格子（含 label / isDefault / defaultPath）。 */
  const [rows, setRows] = useState<StorageDir[]>([])
  /** 界面上五个输入框的值（按 key）。 */
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [err, setErr] = useState('')
  /** 哪一格出了问题（后端 400 回包里的 `key`）。空串 = 不是某一格的问题。 */
  const [badKey, setBadKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  /** 保存成功后的那句话。 */
  const [saved, setSaved] = useState('')

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const r = await call<{ dirs?: StorageDir[] }>('/storage')
    setLoading(false)
    if (!r.ok) { setErr(r.error ?? '读不到存储目录'); return }
    setErr('')
    setBadKey('')
    const list = toDirRows(r.body)
    setRows(list)
    const next: Record<string, string> = {}
    for (const d of list) next[d.key] = d.path
    setDrafts(next)
  }, [])

  useEffect(() => {
    if (active) void load()
  }, [active, load])

  /** 保存（整份）。 */
  const save = async (): Promise<void> => {
    setSaving(true)
    setSaved('')
    const r = await call<{ ok?: boolean, key?: string, error?: string }>('/storage', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toSaveBody(drafts)),
    })
    setSaving(false)
    if (!r.ok) {
      setErr(r.error ?? '保存失败')
      /* ★ 后端 400 时回包带 `key`，指是哪一格不过。把它标出来 ——
       * 只说「保存失败」等于让用户自己猜五格里哪一格错了。 */
      setBadKey(typeof r.body?.key === 'string' ? r.body.key : '')
      return
    }
    setErr('')
    setBadKey('')
    /* 「什么时候生效」必须说，而且这一块是唯一能说「立刻」的：
     * 目录是每次调用现算的（`artifacts.ts:81-87` 的 `dirOf` 现读内存覆盖表），
     * 存完下一次写盘就进新目录；重启也不会丢 —— `apply()` 启动时会从盘上再套一次
     * （`src/index.ts:1328` 的 `applyStorageConfig()`）。 */
    setSaved('已保存，立刻生效，不用重启。新产物会进新目录，老产物留在原处（这里不搬旧文件）。')
    await load()
  }

  const field = 'min-w-0 flex-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none'

  return (
    <div className="flex flex-col gap-2" data-ewb-storage="">
      <div className="flex items-center gap-3">
        <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">本地存储目录</span>
        <span className="flex-1" />
        <button
          type="button"
          data-ewb-storage-reload=""
          className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
          onClick={() => { void load() }}
        >重新读取</button>
        <button
          type="button"
          data-ewb-storage-save=""
          disabled={saving}
          className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-3 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)] disabled:opacity-40"
          onClick={() => { void save() }}
        >{saving ? '保存中…' : '保存'}</button>
      </div>

      {/* 三条规矩要写在界面上，否则用户会把「清空」当成「不改」。 */}
      <div className="rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]" data-ewb-storage-note="">
        要写完整路径（形如 D:\ecom\artifacts）。留空表示用回默认目录。保存前会逐格试着写一个临时文件；
        任何一格写不进去就整份不存 —— 不会出现「改了一半」。
      </div>

      {err === ''
        ? null
        : (
          <div data-ewb-storage-error="" className="flex items-start gap-2 rounded-card border border-dashed border-[#ff5f6d] px-3 py-2">
            <span className="dot warn" style={{ marginTop: 5 }} />
            <span className="min-w-0 flex-1 font-mono text-ewb-caption leading-relaxed text-[#ff8a8a]">{err}</span>
          </div>
        )}

      {saved === ''
        ? null
        : (
          <div data-ewb-storage-saved="" className="rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2 font-mono text-ewb-caption text-[#4ec9b0]">{saved}</div>
        )}

      {loading && rows.length === 0
        ? <div className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">读取中…</div>
        : null}

      {rows.map(d => (
        <div
          key={d.key}
          data-ewb-storage-row={d.key}
          data-ewb-storage-bad={badKey === d.key ? '' : undefined}
          className={[
            'flex items-center gap-2 rounded-ctl border px-2 py-1.5',
            badKey === d.key
              ? 'border-[#ff5f6d]'
              : 'border-[var(--dsw-alias-border-l2)]',
          ].join(' ')}
        >
          <span className="w-20 shrink-0 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]" data-ewb-storage-label={d.key}>{d.label}</span>
          <input
            data-ewb-storage-input={d.key}
            className={field}
            value={drafts[d.key] ?? ''}
            placeholder={d.defaultPath === '' ? '留空用默认' : d.defaultPath}
            onChange={(e) => { setDrafts(prev => ({ ...prev, [d.key]: e.target.value })); setSaved('') }}
          />
          {/* 这一格是不是还在用默认 —— 用两个字说清，不用颜色。 */}
          <span
            data-ewb-storage-default={d.key}
            className="w-14 shrink-0 text-right font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]"
          >{d.isDefault ? '默认' : '已改'}</span>
          <button
            type="button"
            data-ewb-storage-reset={d.key}
            className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
            title="清空这一格（保存后回到默认目录）"
            onClick={() => { setDrafts(prev => ({ ...prev, [d.key]: '' })); setSaved('') }}
          >恢复默认</button>
        </div>
      ))}
    </div>
  )
}
