/** 模型清单（票 75，2026-10-29）—— 配置板块「模型」格的主体。
 *
 * ## 用户原话（三条一起看）
 *
 * > 不用担心模型多，dsh模型多是因为加了很多渠道，有的渠道模型多而已，所以dsh是
 * > 选择性加载到工作台，视频和图片音频类的模型不会同时加载太多，就每行一条
 * > **不要点开看渠道类型，直接按渠道划分模型，每个模型直接可以勾选类型**。
 *
 * > 模型清单就是**先渠道**，然后每个渠道几个模型，每个模型下面 4 个选项，
 * > 文本，图片，视频，音频。手动勾选就行了。
 *
 * > dsh模型目录现在不是选择备用模型了，是**增加到模型清单**。
 *
 * ## 与票 68 那版的差别（用户把它推翻了）
 *
 * | | 票 68 | 票 75 |
 * |---|---|---|
 * | 清单结构 | 一份**平铺**列表（渠道被摊平掉） | **按渠道分组**，渠道名做小标题 |
 * | 类型 | 行右侧**只读小签**，点行展开才改 | 每行**直接四个勾选框** |
 * | 交互 | 点行展开（`data-open` / toggle / body） | **没有展开**，一屏全看得见 |
 * | 渠道级信息 | 在行展开区里 | 在**渠道小标题那一行** |
 * | dsh 目录 | 只选「备选名单」（给节点下拉用） | **加进清单**，成为「dsh 内置」一组 |
 *
 * ## 「渠道」这个词又回来了 —— 但只作为**分组标题**
 *
 * 票 68 曾把「渠道」二字从界面上取消（用户当时说「怎么还有内容渠道」）。
 * 票 75 用户改口：「直接按渠道划分模型」。所以它回来了，**作为分组的名字**，
 * 而不再是「内容渠道与并发」那种让人以为「这是内容专用」的说法。
 *
 * `channels.json` 的数据结构仍然一个字没改：密钥、并发、ComfyUI 工作流
 * 都是**渠道级**的（`channels.ts:139` 的 `CHANNEL_WORKFLOW_KEYS`）。
 *
 * ## 两类模型，两种存储
 *
 * | 组 | 是什么 | 勾选类型存哪 | 走不走 `POST /channels` |
 * |---|---|---|---|
 * | 自己的渠道 | `channels.json` 里的模型 | 那个文件（整条渠道一起发） | **走** |
 * | 「dsh 内置」 | `model-prefs.json` 的 `picks`（dsh 目录里加进来的） | **不存**（见下） | **不走** |
 *
 * 「dsh 内置」那组的类型**故意不可改**：dsh 模型是 LLM（文本模型），
 * 它们的类型不是我们这份 `channels.json` 管的事；而 `picks` 的
 * `asModelRef`（`src/index.ts:135`）只认 `{provider, model}` 两个字段，
 * 多存的 `types` 会被后端洗掉 —— 做一个存不住的开关等于假设置。
 * 那组的四个框里只有「文本」是勾上的，其余禁用，`title` 说明原因。
 *
 * ## 唯一一条后端写入路径
 *
 * 改一条**渠道模型**的类型 → `POST /channels`。**整条渠道一起发**：
 * 那个接口的语义是「存这条渠道」，`models` 是它的字段之一。
 * 不发 `apiKey`（空串在宿主那边的语义是「要清掉」），不发那 15 个工作流字段
 * （`normalizeChannel` 的 `carry` 会从旧记录沿用 —— 不发 ≠ 清掉）。
 */
import { useCallback, useEffect, useState } from 'react'
import { MODEL_TYPE_LABEL, MODEL_TYPES, typesOfModel, type ModelType } from '../../schedule/model-types.ts'
import { call } from './board-kit.ts'
/* ★ 票 75：dsh 那组要读写 `model-prefs.json` 的 `picks`。
 * 那两个函数就在 `WorkspaceSettings.tsx` 里（模块级单例，不依赖组件树位置）。 */
import { modelPickKey, saveModelPrefs, useModels } from './WorkspaceSettings.tsx'
/* ★ 票 02（2026-10-30）：与「默认模型」「dsh 模型目录」共用一个外壳类，
 * 以及共用一个块标题字号 —— 用户要的是「排版统一」，不是「各写各的」。 */
import ws from './WorkbenchSettings.module.css'

/** `/channels` 回的一条模型（`types` 可能没有 —— 老数据）。 */
interface RowModel {
  id: string
  label: string
  caps: string[]
  types?: string[]
}

/** `/channels` 回的一条渠道（**不含密钥**，只有 `hasKey`）。 */
interface RowChannel {
  id: string
  name: string
  protocol: string
  baseUrl: string
  models: RowModel[]
  maxConcurrency: number
  hasKey: boolean
}

/** dsh 目录里加进清单的一条（`model-prefs.json` 的 `picks`）。 */
export interface DshPick {
  /** provider id。 */
  provider: string
  /** 模型 id。 */
  model: string
}

/** 一组的键：自己的渠道用 `ch:<id>`，dsh 用固定的 `dsh`。 */
export const DSH_GROUP = 'dsh'

/** dsh 那一条的键（`模型选择键`）。 */
export function dshKeyOf(p: DshPick): string {
  return p.provider + '/' + p.model
}

/**
 * 把 `/channels` 的回包摊成「一条模型一行」（**纯函数**，供测试直接调）。
 *
 * @param channels - 渠道数组。
 * @returns 行数组（顺序照渠道顺序、渠道内照模型顺序）。
 */
export function rowsOf(channels: readonly RowChannel[]): ModelRow[] {
  const out: ModelRow[] = []
  for (const c of channels) {
    for (const m of c.models) {
      out.push({
        channelId: c.id,
        channelName: c.name,
        protocol: c.protocol,
        baseUrl: c.baseUrl,
        maxConcurrency: c.maxConcurrency,
        hasKey: c.hasKey === true,
        modelId: m.id,
        label: m.label === '' ? m.id : m.label,
        caps: Array.isArray(m.caps) ? m.caps : [],
        types: typesOfModel({
          caps: Array.isArray(m.caps) ? m.caps : [],
          ...m.types === undefined ? {} : { types: m.types },
        }),
      })
    }
  }
  return out
}

/** 摊平之后的一行（一条模型 + 它所属渠道的那几样）。 */
export interface ModelRow {
  /** 渠道 id（模型的主键是「渠道 + 模型 id」两条一起）。 */
  channelId: string
  /** 渠道名（分组标题里显示）。 */
  channelName: string
  /** 协议（决定它归哪一组、要不要过滤）。 */
  protocol: string
  /** 接口地址。 */
  baseUrl: string
  /** 这一条渠道的并发上限（渠道级，不是模型级）。 */
  maxConcurrency: number
  /** 这一条渠道配没配密钥（布尔，没有明文）。 */
  hasKey: boolean
  /** 模型 id。 */
  modelId: string
  /** 显示名。 */
  label: string
  /** 能力（`CAPS` 四值，与「类型」是两套，见 `model-types.ts` 文件头）。 */
  caps: string[]
  /** 这一条算哪几类（`typesOfModel` 的结果，顺序按 `MODEL_TYPES`）。 */
  types: ModelType[]
}

/**
 * 一行的键（渠道 + 模型 id）。
 * @param row - 一行。
 * @returns 唯一键。
 */
export function rowKey(row: Pick<ModelRow, 'channelId' | 'modelId'>): string {
  return row.channelId + '/' + row.modelId
}

/**
 * 存一条渠道时的请求体（**只发会被改的那几个字段**）。
 *
 * ## 为什么不发 `apiKey` 与那 15 个工作流字段
 *
 * `saveChannel` → `normalizeChannel` 的语义是「**给了才改**」：
 *   · `apiKey` 空串 = 不改（发空串会让宿主以为「要清掉」）；
 *   · 工作流字段走 `carry`，**不发**就从旧记录沿用；发 `null` 才是「清掉」。
 *
 * 所以这里只发结构字段 + 整份 `models`。少发不是偷懒 —— 多发一样会出事。
 *
 * @param c - 那条渠道（摊平前的原始形状）。
 * @param models - 这次要写的整份模型清单（只取这四个字段）。
 * @returns POST 的 body。
 */
export function saveBodyOf(
  c: RowChannel,
  models: readonly Pick<ModelRow, 'modelId' | 'label' | 'caps' | 'types'>[],
): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    protocol: c.protocol,
    baseUrl: c.baseUrl,
    maxConcurrency: c.maxConcurrency,
    /* ⚠️ 整份发 —— 这个接口是「存这条渠道」，只发一条模型等于把其余的清掉。 */
    models: models.map(m => ({
      id: m.modelId,
      label: m.label,
      caps: m.caps,
      ...m.types.length === 0 ? {} : { types: m.types },
    })),
  }
}

/**
 * 按渠道把行分组（**纯函数**）。
 *
 * @param rows - 摊平后的行。
 * @returns 一组一条渠道（顺序照行顺序，同渠道的连续排一起）。
 */
export function groupRows(rows: readonly ModelRow[]): { channel: ModelRow, models: ModelRow[] }[] {
  const out: { channel: ModelRow, models: ModelRow[] }[] = []
  for (const r of rows) {
    const last = out[out.length - 1]
    if (last !== undefined && last.channel.channelId === r.channelId) {
      last.models.push(r)
      continue
    }
    out.push({ channel: r, models: [r] })
  }
  return out
}

/** 模型的入参。 */
export interface ModelListSectionProps {
  /** 这一格是不是正显示着（不显示就不发请求）。 */
  active: boolean
}

/**
 * 模型清单（按渠道分组）。
 *
 * @param props - 见 `ModelListSectionProps`。
 * @returns 界面。
 */
export function ModelListSection({ active }: ModelListSectionProps): React.JSX.Element {
  /* ★ 票 75：「dsh 内置」那组的数据就是 `model-prefs.json` 的 `picks`。
   *
   * ## 为什么不新开一份名单文件（票面「必答一」的那个判断）
   *
   * `picks` 的语义本来就是「工作台认可的 dsh 模型」——
   * `src/index.ts:78` 那里写着它「是模型目录的一个**子集**，一个默认 + 一份备选名单」。
   * 票 75 只是把它的**界面说法**从「备选名单」改成「加进清单」，
   * 底层那份名单回答的问题一个字没变：**哪几个 dsh 模型被带进工作台**。
   *
   * 新开一份文件的代价是多一处格式、多一处迁移、多一处「两份名单谁说了算」。
   * 而收益是零 —— 这两份名单永远同步。 */
  const { catalog } = useModels()
  const dshPicks: readonly DshPick[] = catalog?.prefs.picks ?? []
  const [dshBusy, setDshBusy] = useState(false)

  /**
   * 存一份新的 picks（加进清单 / 移出清单）。
   *
   * ⚠️ **不走 `POST /channels`** —— dsh 模型不是渠道，它们没有地址、没有密钥、
   * 没有并发。走 `POST /model-prefs`（`/models/prefs`）才是对的那条路。
   * 判据 9 专门钉这一条。
   *
   * @param next - 新名单。
   */
  const commitPicks = async (next: readonly DshPick[]): Promise<void> => {
    setDshBusy(true)
    const r = await saveModelPrefs({ picks: next })
    setDshBusy(false)
    if (!r.ok) setErr('没保存成功：' + (r.error ?? '原因不明'))
  }
  const [channels, setChannels] = useState<RowChannel[]>([])
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState('')
  /** 新建表单开着没有。 */
  const [creating, setCreating] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const r = await call<{ channels?: RowChannel[] }>('/channels')
    setLoading(false)
    if (!r.ok) { setErr(r.error ?? '读不到模型清单'); return }
    setErr('')
    setChannels(Array.isArray(r.body?.channels) ? r.body.channels : [])
  }, [])

  useEffect(() => {
    if (active) void load()
  }, [active, load])

  /* ★ 票 75：**模型格只列 OpenAI / Gemini 那类**。
   *
   * ComfyUI 有自己的格（`ConfigBoard` 的 `comfyui` 那一支），它的类型由
   * 12 份工作流绑定决定，不在这里。判据 13 钉这一条。 */
  const rows = rowsOf(channels.filter(c => c.protocol !== 'comfyui'))
  const groups = groupRows(rows)

  /**
   * 改一条模型的类型 → 整条渠道一起发。
   *
   * @param row - 哪一条。
   * @param nextTypes - 新的类型集合（按 `MODEL_TYPES` 顺序存）。
   */
  const saveTypes = async (row: ModelRow, nextTypes: ModelType[]): Promise<void> => {
    const key = rowKey(row)
    const chan = channels.find(c => c.id === row.channelId)
    if (chan === undefined) { setErr('这条模型所属的渠道已经不在了'); return }
    /* ⚠️ 只重算**同一条渠道**的整份清单 —— 别的渠道一行都不碰。 */
    const next = rowsOf([chan]).map(r => (rowKey(r) === key ? { ...r, types: nextTypes } : r))
    setSaving(key)
    setNote('')
    const r = await call<unknown>('/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(saveBodyOf(chan, next)),
    })
    setSaving('')
    if (!r.ok) { setErr(r.error ?? '保存失败'); return }
    setErr('')
    /* ★ 存完必须重读 —— 不重读的话勾选框还是旧状态（票 68 那里写过同一句）。 */
    await load()
  }

  /**
   * 勾 / 取消一个类型（**立即写回**，用户原话「手动勾选就行了」）。
   *
   * @param row - 哪一条。
   * @param t - 哪一类。
   * @param on - 勾上还是取消。
   */
  const toggleType = (row: ModelRow, t: ModelType, on: boolean): void => {
    const cur = new Set(row.types)
    if (on) cur.add(t)
    else cur.delete(t)
    /* 按 `MODEL_TYPES` 顺序存 —— 手点的顺序不该影响显示。 */
    void saveTypes(row, MODEL_TYPES.filter(x => cur.has(x)))
  }

  const field = 'min-w-0 flex-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none'
  const btn = 'pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]'

  /** 一条模型的四个勾选框（渠道模型用，可改）。 */
  const boxesOf = (row: ModelRow): React.JSX.Element => {
    const key = rowKey(row)
    const cur = new Set(row.types)
    return (
      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1" data-ewb-model-types={key}>
        {MODEL_TYPES.map(t => (
          <label key={t} className="flex items-center gap-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
            <input
              type="checkbox"
              data-ewb-model-type={key + ':' + t}
              checked={cur.has(t)}
              disabled={saving === key}
              onChange={(e) => { toggleType(row, t, e.target.checked) }}
            />
            {MODEL_TYPE_LABEL[t]}
          </label>
        ))}
      </span>
    )
  }

  return (
    /* ★ 票 02（2026-10-30）：套上 `ws.section` —— 与「默认模型」「dsh 模型目录」
     * 用同一个外壳，这样三节的上边线与间距是同一套。
     *
     * 原来这里是 Tailwind 现写的 `flex min-h-0 flex-col gap-2`：
     *   · 没有 `border-top` → 用户看到的「模型这一块没有横线」就是它；
     *   · `min-h-0` 让它**可被压扁**（父容器是纵向 flex + 滚动），
     *     压扁之后内容溢出来盖住邻居 —— 那条「dsh 目录展开后内容叠加」的一半原因。
     *
     * ⚠️ `data-ewb-model-list` 钩子留在根上（`tests/dom-render.mjs` 与
     * `tests/model-list.mjs` 都按它找），只是**多挂了一个类**。 */
    <div className={'flex flex-col gap-2 ' + ws.section} data-ewb-model-list="">
      <div className="flex flex-none items-center gap-3">
        <span className={ws.sectionTitle} style={{ marginBottom: 0 }} data-ewb-model-list-head="">模型清单</span>
        <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" data-ewb-model-list-total="">
          {String(groups.length)} 条渠道 · {String(rows.length + dshPicks.length)} 个模型
        </span>
        <span className="flex-1" />
        <button
          type="button"
          data-ewb-model-new=""
          className={btn}
          onClick={() => { setCreating(true); setNote('') }}
        >新建模型</button>
        <button
          type="button"
          data-ewb-model-list-refresh=""
          className={btn}
          onClick={() => { void load() }}
        >刷新</button>
      </div>

      {err === ''
        ? null
        : (
          <div data-ewb-model-list-error="" className="flex flex-none items-start gap-2 rounded-card border border-dashed border-[#ff5f6d] px-3 py-2">
            <span className="dot warn" style={{ marginTop: 5 }} />
            <span className="min-w-0 flex-1 font-mono text-ewb-caption leading-relaxed text-[#ff8a8a]">{err}</span>
          </div>
        )}

      {note === ''
        ? null
        : (
          <div data-ewb-model-list-saved="" className="flex-none rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2 font-mono text-ewb-caption text-[#4ec9b0]">{note}</div>
        )}

      {!creating
        ? null
        : (
          <NewModelForm
            channels={channels.filter(c => c.protocol !== 'comfyui')}
            field={field}
            btn={btn}
            onCancel={() => { setCreating(false) }}
            onDone={async (msg) => {
              setCreating(false)
              setNote(msg)
              await load()
            }}
            onError={(msg) => { setErr(msg) }}
          />
        )}

      {loading && groups.length === 0 && dshPicks.length === 0
        ? <div className="px-1 py-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">读取中…</div>
        : null}

      {!loading && groups.length === 0 && dshPicks.length === 0 && err === ''
        ? (
          <div data-ewb-model-list-empty="" className="rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-5">
            <span className="font-mono text-ewb-meta text-[var(--dsw-alias-label-secondary)]">还没有模型</span>
            <span className="mt-1 block font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
              点上面的「新建模型」加一条，或到下面的 dsh 模型目录里把模型加进清单。
            </span>
          </div>
        )
        : null}

      {/* ── 按渠道分组 ─────────────────────────────────────────────
       *
       * ## 渠道小标题那一行放什么
       *
       * 票 68 把渠道级信息（密钥 / 并发）塞在「行展开区」里，用户点开才看得见。
       * 票 75 删掉了展开交互，所以那些信息必须有新地方 —— 就在小标题这一行。
       *
       * 这样也符合用户「按渠道扫」的用法：一眼看到「这条渠道配没配密钥、并发几」。 */}
      <div className="flex min-h-0 flex-col" data-ewb-model-groups="">
        {groups.map(g => {
          const c = g.channel
          return (
            <div key={c.channelId} className="mb-2" data-ewb-model-group={c.channelId}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--dsw-alias-border-l2)] pb-1 font-mono text-ewb-caption" data-ewb-model-group-head={c.channelId}>
                <span className="text-ewb-meta font-semibold text-[var(--dsw-alias-label-primary)]" data-ewb-model-group-name={c.channelId}>{c.channelName}</span>
                <span className={c.hasKey ? 'text-[var(--dsw-alias-state-success-primary)]' : 'text-[var(--dsw-alias-label-tertiary)]'} data-ewb-model-group-haskey={c.hasKey ? 'yes' : 'no'}>
                  {c.hasKey ? '已配置密钥' : '未配置密钥'}
                </span>
                <span className="text-[var(--dsw-alias-label-tertiary)]" data-ewb-model-group-conc={c.channelId}>并发 {String(c.maxConcurrency)}</span>
                <span className="text-[var(--dsw-alias-label-tertiary)]">{String(g.models.length)} 个模型</span>
              </div>
              {g.models.map(row => {
                const key = rowKey(row)
                return (
                  <div key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-1" data-ewb-model-item={key}>
                    <span className="min-w-0 max-w-[40%] truncate font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)]" title={key} data-ewb-model-item-name={key}>{row.label}</span>
                    {boxesOf(row)}
                    {saving === key ? <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">保存中…</span> : null}
                  </div>
                )
              })}
            </div>
          )
        })}

        {/* ── 「dsh 内置」一组 ────────────────────────────────────────
         *
         * 用户原话：「dsh模型目录现在不是选择备用模型了，是增加到模型清单。」
         *
         * ## 为什么这组的勾选框**只有文本**且禁用
         *
         * dsh 模型是 LLM（文本模型）—— 它们不做图片 / 视频 / 音频生成。
         * 而且 `picks` 的形状由 `src/index.ts:135` 的 `asModelRef` 决定，
         * **只收 `{provider, model}` 两个字段**：多存一个 `types` 会被后端洗掉。
         *
         * 做一个「能勾但存不住」的开关，就是票 68 那次「假设置」的翻版 ——
         * 用户勾了、看着像生效、实际什么都没发生。所以这里如实：
         * 文本勾着、其余禁用，`title` 说明原因。
         *
         * 判据 9 钉的是「这组的任何操作都不发 `POST /channels`」。 */}
        {dshPicks.length === 0
          ? null
          : (
            <div className="mb-2" data-ewb-model-group={DSH_GROUP}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--dsw-alias-border-l2)] pb-1 font-mono text-ewb-caption" data-ewb-model-group-head={DSH_GROUP}>
                <span className="text-ewb-meta font-semibold text-[var(--dsw-alias-label-primary)]" data-ewb-model-group-name={DSH_GROUP}>dsh 内置</span>
                <span className="text-[var(--dsw-alias-label-tertiary)]">来自 dsh 模型目录</span>
                <span className="text-[var(--dsw-alias-label-tertiary)]">{String(dshPicks.length)} 个模型</span>
              </div>
              {dshPicks.map((p) => {
                const key = dshKeyOf(p)
                return (
                  <div key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-1" data-ewb-model-item={DSH_GROUP + '/' + key} data-ewb-dsh-row={key}>
                    <span className="min-w-0 max-w-[40%] truncate font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)]" title={key}>{key}</span>
                    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1" data-ewb-model-types={DSH_GROUP + '/' + key}>
                      {/* ⚠️ 票 76（2026-10-29）：dsh 模型那三个勾选框**全部去掉**了。
                       *
                       * ## 原来为什么有
                       *
                       * 票 75 那一版给 dsh 模型也画了一排只读勾选框，标着「文本」并勾上 ——
                       * 意图是「它是文本模型，类型不用改」。
                       *
                       * ## 现在为什么不能有
                       *
                       * 票 76 把「文本」这一类从渠道里去掉（文本统一走 dsh），
                       * `MODEL_TYPES` 只剩图片 / 视频 / 音频三类。dsh 目录里的模型
                       * 是**文本模型**，它在新的三类里**一格都不属于** ——
                       * 画三个全不勾的灰框，用户会问「为什么它什么都不是」。
                       *
                       * 所以改成一句话说明。那段「它是文本模型、名单只存哪几个加进来了」
                       * 的意思一个字没丢，只是不再用勾选框承载。 */}
                      <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                        文本模型（走 dsh，不属于图片 / 视频 / 音频任何一类）
                      </span>
                    </span>
                    <button
                      type="button"
                      data-ewb-dsh-remove={key}
                      className={btn}
                      disabled={dshBusy}
                      onClick={() => { void commitPicks(dshPicks.filter(x => dshKeyOf(x) !== key)) }}
                    >移出清单</button>
                  </div>
                )
              })}
            </div>
          )}
      </div>
    </div>
  )
}

/** 新建表单的入参。 */
interface NewModelFormProps {
  /** 现有渠道（下拉里能选「建在哪条渠道下」）。**已过滤掉 ComfyUI**。 */
  channels: RowChannel[]
  /** 输入框公共类名（与清单同一档）。 */
  field: string
  /** 按钮公共类名。 */
  btn: string
  /** 取消。 */
  onCancel: () => void
  /** 存成功（参数是给人看的那句话）。 */
  onDone: (msg: string) => void
  /** 存失败（原话）。 */
  onError: (msg: string) => void
}

/**
 * 新建模型表单。
 *
 * ## 一条模型 = 一条渠道 + 一个模型 id
 *
 * 底层是「渠道 → 多个模型」，所以表单要么挑一条已有渠道，
 * 要么顺手建一条新的（协议 / 地址 / 密钥 / 并发是渠道级的，绕不过）。
 *
 * ## 只有「密钥」与「类型」写一句短的
 *
 * 用户 2026-10-29 原话：「说明文字尽量不写，看不出后果的开关简写。」
 * 这两处属于「看不出后果」：密钥没配会静默失败、类型没选对会选不到模型。
 *
 * @param props - 见 `NewModelFormProps`。
 * @returns 表单。
 */
function NewModelForm({
  channels, field, btn, onCancel, onDone, onError,
}: NewModelFormProps): React.JSX.Element {
  /** 空串 = 新建一条渠道。 */
  const [channelId, setChannelId] = useState('')
  const [newName, setNewName] = useState('')
  const [protocol, setProtocol] = useState('openai')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [maxConcurrency, setMaxConcurrency] = useState('5')
  const [modelId, setModelId] = useState('')
  const [label, setLabel] = useState('')
  const [types, setTypes] = useState<ModelType[]>([])
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    if (modelId.trim() === '') { onError('模型 id 不能为空。'); return }
    const newModel: RowModel = {
      id: modelId.trim(),
      label: label.trim() === '' ? modelId.trim() : label.trim(),
      /* ⚠️ `caps` 是另一套（四值），这里**不按类型反推** —— 反推会静默改掉
       * 「上游能做哪些活」这件事。留空，由 `types` 明确说它算哪几类。 */
      caps: [],
      ...types.length === 0 ? {} : { types },
    }
    setBusy(true)
    const target = channels.find(c => c.id === channelId)
    let body: Record<string, unknown>
    if (target === undefined) {
      /* 新建一条渠道 + 它的第一条模型。`id` 不发 —— 宿主自己生成。 */
      if (newName.trim() === '' || baseUrl.trim() === '') {
        setBusy(false)
        onError('新建渠道要填名称与接口地址。')
        return
      }
      body = {
        name: newName.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
        maxConcurrency: Number(maxConcurrency) || 5,
        models: [{ ...newModel }],
        ...apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() },
      }
    } else {
      /* 往已有渠道里加一条：整份模型清单一起发（漏了就等于把其余的删掉）。 */
      const merged = rowsOf([target]).map(r => ({
        modelId: r.modelId, label: r.label, caps: r.caps, types: r.types,
      }))
      if (merged.some(m => m.modelId === newModel.id)) {
        setBusy(false)
        onError('这条渠道里已经有 id 为「' + newModel.id + '」的模型了。')
        return
      }
      body = {
        ...saveBodyOf(target, [...merged, {
          modelId: newModel.id, label: newModel.label, caps: newModel.caps, types,
        }]),
        /* 密钥：这次填了才发（留空 = 不改）。 */
        ...apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() },
      }
    }
    const r = await call<unknown>('/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    setBusy(false)
    if (!r.ok) { onError(r.error ?? '保存失败'); return }
    onDone('已加进清单。')
  }

  return (
    <div data-ewb-model-new-form="" className="mb-1.5 flex flex-none flex-col gap-1.5 rounded-card border border-[var(--dsw-alias-border-l2)] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">新建模型</span>
        <span className="flex-1" />
        <button type="button" data-ewb-model-new-cancel="" className={btn} onClick={onCancel}>取消</button>
        <button type="button" data-ewb-model-new-submit="" className={btn} disabled={busy} onClick={() => { void submit() }}>{busy ? '保存中…' : '保存'}</button>
      </div>
      <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
        <span className="w-24 shrink-0">建在哪条渠道下</span>
        <select
          data-ewb-model-new-channel=""
          className={field}
          value={channelId}
          onChange={(e) => { setChannelId(e.target.value) }}
        >
          <option value="">新建一条渠道</option>
          {channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </label>
      {channelId === ''
        ? (
          <>
            <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
              <span className="w-24 shrink-0">渠道名称</span>
              <input data-ewb-model-new-channelname="" className={field} value={newName} onChange={(e) => { setNewName(e.target.value) }} placeholder="如 官方接口" />
            </label>
            <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
              <span className="w-24 shrink-0">协议</span>
              <select data-ewb-model-new-protocol="" className={field} value={protocol} onChange={(e) => { setProtocol(e.target.value) }}>
                {/* ⚠️ 这里**没有 comfyui**：ComfyUI 走自己那一格（票 75）。
                 * 给模型格留一个 comfyui 选项，等于让用户从这里建出一条
                 * 界面上看不到的渠道 —— 那是最难查的一种。 */}
                <option value="openai">OpenAI 兼容</option>
                <option value="gemini">Gemini</option>
              </select>
            </label>
            <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
              <span className="w-24 shrink-0">接口地址</span>
              <input data-ewb-model-new-baseurl="" className={field} value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value) }} placeholder="如 https://api.example.com" />
            </label>
            <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
              <span className="w-24 shrink-0">并发</span>
              <input data-ewb-model-new-concurrency="" className={field} type="number" min={1} max={50} value={maxConcurrency} onChange={(e) => { setMaxConcurrency(e.target.value) }} />
            </label>
          </>
        )
        : null}
      <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
        <span className="w-24 shrink-0">模型 id</span>
        <input data-ewb-model-new-id="" className={field} value={modelId} onChange={(e) => { setModelId(e.target.value) }} placeholder="上游要的那个名字，如 gpt-image-1" />
      </label>
      <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
        <span className="w-24 shrink-0">显示名</span>
        <input data-ewb-model-new-label="" className={field} value={label} onChange={(e) => { setLabel(e.target.value) }} placeholder="留空就用模型 id" />
      </label>
      <label className="flex items-start gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
        <span className="w-24 shrink-0 pt-1">类型</span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {MODEL_TYPES.map(t => (
              <label key={t} className="flex items-center gap-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
                <input
                  type="checkbox"
                  data-ewb-model-new-type={t}
                  checked={types.includes(t)}
                  onChange={(e) => {
                    const on = e.target.checked
                    setTypes(prev => MODEL_TYPES.filter(x => (x === t ? on : prev.includes(x))))
                  }}
                />
                {MODEL_TYPE_LABEL[t]}
              </label>
            ))}
          </div>
          <span data-ewb-model-new-typehint="" className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
            不勾类型的话，这一条不会出现在上面任何一行的默认模型下拉里。
          </span>
        </div>
      </label>
      <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
        <span className="w-24 shrink-0">密钥</span>
        <input
          data-ewb-model-new-apikey=""
          type="password"
          autoComplete="off"
          className={field}
          value={apiKey}
          onChange={(e) => { setApiKey(e.target.value) }}
          placeholder="留空表示没有密钥或不改"
        />
      </label>
    </div>
  )
}
