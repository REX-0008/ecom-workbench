/** 配置页 · 四类默认模型（P3 第 2 块，用户 m03414）。
 *
 * ## 它现在挂在哪（票 38，2026-10-28 搬家）
 *
 * 原来挂在**内容板块 · 配置页 · 默认模型 tab**；2026-10-28 起挂在
 * **工作台设置抽屉**里（`WorkspaceSettings.tsx` 的 `data-ewb-content-defaults-section`）。
 *
 * ## ⚠️ 与「节点默认模型」不是一回事（票 38 特意区分，别合并）
 *
 * 工作台设置里现在还有一处「节点默认模型」（`model-prefs.json` 的 `default`）。
 * 两者名字像、位置近，但**形状与链路都不同**：
 *
 * | | 本文件（`model-defaults.json`） | 节点默认模型（`model-prefs.json`） |
 * |---|---|---|
 * | 形状 | `{ channelId, modelId }`（内容渠道里的模型） | `{ provider, model }`（dsh 模型目录里的） |
 * | 谁读 | `src/schedule/generate.ts` → 直接用渠道的接口地址发请求 | `src/index.ts` 五级回落 → `ctx.llm.stream` |
 * | 谁用 | 内容生成（生图 / 视频 / 文本 / 音频） | 工作流里的 `ai.agent` 节点 |
 *
 * **不可互相回落**：把 `{provider, model}` 塞进这里，生成时会报「渠道里没有这个模型」；
 * 反过来把 `{channelId, modelId}` 塞过去，五级回落会当成没设。
 * 判据写在 `src/schedule/model-defaults.ts:29-33`（那是当初分开存时留下的）。
 *
 * ## 这一块解决什么
 *
 * 用户直接问过：「生图 / 视频 / 文本 / 音频的模型设置在哪」。后端把这件事做成了
 * 三层规则（`ce8c81c`）：
 *
 *   ① 这次提交指定了模型 → 用；
 *   ② 没指定 → 「默认模型」里这一类那条 → 用它的渠道 + 模型；
 *   ③ 默认也没设 → 报错「还没有设默认模型，去设置里选一个」。
 *
 * 后端的 ② ③ 两层全靠 `model-defaults.json`，而**界面上一个下拉都没有** ——
 * 也就是说 ② 永远走不到、③ 那句提示用户永远看不到（因为没法设）。
 *
 * ## ⚠️ 三种状态必须长得不一样（这一块最容易做错的地方）
 *
 * | 状态 | 后端怎么表达 | 界面怎么显示 |
 * |---|---|---|
 * | **未设** | `status.image === false`，`defaults` 里没这个键 | 下拉显示「未设」+ 一句「没设时生成会报错」 |
 * | **设了** | `status.image === true`，`defaults.defaultImageModel` 有值 | 下拉显示「渠道 · 模型」 |
 * | **设了但坏了** | `broken.image` 有一句原因 | **标红 + 原话**，不能显示成「未设」 |
 *
 * 为什么第三条要单独做：设了默认、那个渠道被删了 —— 用户以为设好了，生成时才失败。
 * 显示成「未设」会让他以为「我没设过」，然后去设第二个，第一个的坏引用还在。
 *
 * ## 为什么只列 caps 对得上的模型
 *
 * 生图那一栏里要是能选到只做视频的模型，选了就是「必然报错」——
 * 这与 `upscale` / `superResolve` 那条「下拉里不许出现必然失败的选项」是同一条规矩。
 * 后端 `/gen-models?kind=` 支持按能力筛，这里用它，**不在前端自己猜 caps**。
 */
import { useCallback, useEffect, useState } from 'react'
import { call } from './board-kit.ts'
/* ★ 票 02（2026-10-30）：块标题与其它几节同一个字号（`sectionTitle`）。 */
import ws from './WorkbenchSettings.module.css'

/** 四类（顺序固定，与 `src/schedule/model-types.ts` 的 `MODEL_TYPES` 一致）。
 *
 * ## ⚠️ 2026-10-29 这一天它被改了两次
 *
 * | 什么时候 | 几类 | 为什么 |
 * |---|---|---|
 * | 票 38 | 四类 `image / video / text / audio` | 最初那版 |
 * | 票 68 | **五类**（`image` 拆成 `t2i` / `i2i`） | 一条只会文生图的模型设在图生图那一栏里必然报错 |
 * | **票 74（现行）** | **四类** `text / image / video / audio` | 用户否掉了拆分；后端 `MODEL_TYPES` 也退回了四类 |
 *
 * 顺序照 `MODEL_TYPES`：`text` 在最前（用户原话的列举顺序
 * 「文本，图片，视频，音频」）。
 *
 * ⚠️ 键名跟着变（`keyOf` 里那张显式表）：回到 `defaultImageModel`。
 * 票 67 用过两天的 `defaultT2IModel` / `defaultI2IModel` 仍能被后端读出来
 * 归到 `image`（`model-defaults.ts` 的 `LEGACY_KEYS`），所以老存档不用迁移。
 */
export const DEFAULT_KINDS = ['text', 'image', 'video', 'audio'] as const

/** 一类能力。 */
export type DefaultKind = typeof DEFAULT_KINDS[number]

/**
 * 四类的中文名。
 *
 * ⚠️ 与 `src/schedule/model-types.ts` 的 `MODEL_TYPE_LABEL` **逐字一致**
 * （同一件事两处措辞必然漂）。注意「图片」不是「生图」——
 * 票 74 之后它包含文生图与图生图两种用法。
 */
export const KIND_LABEL: Record<DefaultKind, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
}

/** 一类默认指向（`channelId` + `modelId` 两条都要有）。 */
export interface ModelRef {
  /** 渠道 id。 */
  channelId: string
  /** 模型 id。 */
  modelId: string
}

/** `GET /model-defaults` 的回包形状（照 docs §二）。 */
export interface DefaultsState {
  /** 设过的类（没设的键不出现）。 */
  defaults: Partial<Record<string, ModelRef>>
  /** 四类各一个布尔值：设没设。 */
  status: Record<string, boolean>
  /** 设了但渠道 / 模型已不在时的原因。 */
  broken: Record<string, string>
}

/** 一份可选的模型（从 `/gen-models?kind=` 拿，已按能力筛过）。 */
export interface ModelChoice {
  /** 渠道 id。 */
  channelId: string
  /** 渠道名。 */
  channelName: string
  /** 模型 id。 */
  modelId: string
  /** 模型显示名。 */
  modelLabel: string
}

/**
 * 一类当前处于哪个状态。
 *
 * 三态的判定**只在这里做一次**，别在 JSX 里散着写 —— 散着写必然有一处漏掉
 * 「设了但坏了」而与「未设」混同。
 *
 * ## 「坏了」现在有三种原因（票 38，2026-10-28 补第三种）
 *
 * 后端 `GET /model-defaults` 的 `broken[kind]` 会给一句话，三种情形：
 *
 * | 原因 | 后端怎么认 | 用户要做什么 |
 * |---|---|---|
 * | 渠道不在了 | 渠道 id 在 `channels.json` 里找不到 | 重设到另一条渠道 |
 * | 模型不在了 | 渠道在，但 `models[]` 里没有那个 id | 重设，或重新拉一次模型清单 |
 * | **模型没这一类能力** | 模型在，但 `caps` 里没有这一类 | 给它标上能力，或换个模型 |
 *
 * 第三种是 2026-10-28 加的：原来只算前两种，于是「设了个只会出图的模型当视频默认」
 * 会显示成**绿色的「已设」** —— 而真跑时 `generate.ts:543-552` 的能力校验会拦下它。
 * 那种「界面说好了、跑起来报错」是最坏的一种不一致。
 *
 * ⚠️ 界面这边**不需要为第三种单独写分支**：`broken` 里只要有话就是 `broken` 态，
 * 原话照显示。这样以后后端再加第四种原因，这里一行都不用改。
 *
 * @param state - 后端回包。
 * @param kind - 哪一类。
 * @returns 状态 + 一句说明。
 */
export function kindState(state: DefaultsState | null, kind: DefaultKind): {
  /** 三态之一。 */
  phase: 'unset' | 'set' | 'broken'
  /** 给人看的一句话。 */
  text: string
} {
  if (state === null) return { phase: 'unset', text: '读取中…' }
  /* ★ broken 优先于 status：设了但坏了也是 `status: true`，
   * 先判 status 会把「坏了」显示成「设好了」。 */
  const why = state.broken?.[kind]
  if (typeof why === 'string' && why !== '') return { phase: 'broken', text: why }
  const ref = state.defaults?.[keyOf(kind)]
  if (state.status?.[kind] === true && ref !== undefined) {
    return { phase: 'set', text: '已设：' + ref.channelId + ' · ' + ref.modelId }
  }
  return { phase: 'unset', text: '未设 —— 没设时这一类的生成会报错，要先去下面选一个' }
}

/**
 * 一类对应的存储键名。
 *
 * ## ⚠️ 必须是显式表，不能靠「首字母大写」拼（票 68 实测的一个真 bug）
 *
 * 原来是 `'default' + kind[0].toUpperCase() + kind.slice(1) + 'Model'`。
 * 四类时四个值全是纯小写单词，拼出来正好对，看不出问题。
 *
 * 票 68 扩成五类时 `t2i` / `i2i` 带**数字**，拼出来是
 * `defaultT2iModel`，而后端契约是 `defaultT2IModel` —— 差一个字母，
 * 后端读不到 → 那一类永远显示「未设」，设了等于没设。
 *
 * **票 74 退回四类之后**，四个值又都是纯小写，拼也能拼对。
 * 但表**不再改回拼接**：这个坑的代价是「设了不生效」，
 * 而一个拼错只会在**下次有人加带数字的类**时再炸一次 —— 那时离现在很远，
 * 没人会记得这条注释。表只多四行，留着。
 *
 * 与 `src/schedule/model-defaults.ts` 的 `DEFAULT_KEYS` 逐字一致；
 * `tests/config-defaults.mjs` 有一条断言钉它。
 *
 * @param kind - 哪一类。
 * @returns 存储键名。
 */
export function keyOf(kind: DefaultKind): string {
  const map: Record<DefaultKind, string> = {
    text: 'defaultTextModel',
    image: 'defaultImageModel',
    video: 'defaultVideoModel',
    audio: 'defaultAudioModel',
  }
  return map[kind]
}

/**
 * 造 `PUT /model-defaults` 的请求体。
 *
 * ## ⚠️ 整份覆盖 —— 所以四类**全部**要发
 *
 * 后端规矩：没给的类就被清掉（`null` / 缺键 = 回到「未设」）。
 * 所以「只发改过的那一类」= **把另外三类全清掉**。这与存储目录那条是同一个坑。
 *
 * ## 半条引用不许发
 *
 * 只有 `channelId` 没有 `modelId`（或反过来）比没有更糟 —— 会让人以为设过了。
 * 后端也会拒，但界面这边就不该造出来。
 *
 * @param picks - 四类各自选了什么（空串 / 缺键 = 这一类不设）。
 * @returns PUT 的 body。
 */
export function toSaveBody(picks: Partial<Record<DefaultKind, ModelRef | undefined>>): Record<string, ModelRef | null> {
  const out: Record<string, ModelRef | null> = {}
  for (const kind of DEFAULT_KINDS) {
    const p = picks[kind]
    const ok = p !== undefined && typeof p.channelId === 'string' && p.channelId !== ''
      && typeof p.modelId === 'string' && p.modelId !== ''
    /* ★ 一定要发 `null`（不是省略这个键）：「整份覆盖」下省略与 null 同效，
     * 但显式 null 让读请求体的人一眼看出「这一类是被清掉的」。 */
    out[keyOf(kind)] = ok ? { channelId: p.channelId, modelId: p.modelId } : null
  }
  return out
}

/**
 * 把 `/gen-models?kind=` 的回包摊成下拉选项。
 *
 * @param body - 回包（`models` 或 `items`，后端两种都回过，见 docs §一）。
 * @returns 选项（同渠道同模型去重）。
 */
export function toChoices(body: { models?: ModelChoice[], items?: ModelChoice[] } | null | undefined): ModelChoice[] {
  const raw = Array.isArray(body?.models) ? body.models : Array.isArray(body?.items) ? body.items : []
  const seen = new Set<string>()
  const out: ModelChoice[] = []
  for (const m of raw) {
    if (typeof m?.channelId !== 'string' || typeof m?.modelId !== 'string') continue
    const key = m.channelId + '/' + m.modelId
    if (seen.has(key)) continue
    seen.add(key)
    out.push(m)
  }
  return out
}

/** 四类默认模型那一块的入参。 */
export interface DefaultsSettingsProps {
  /** 这一块是不是正显示着（不显示就不发请求）。 */
  active: boolean
}

/**
 * 四类默认模型。
 * @param props - 是否可见。
 * @returns 界面。
 */
export function DefaultsSettings({ active }: DefaultsSettingsProps): React.JSX.Element {
  const [state, setState] = useState<DefaultsState | null>(null)
  const [picks, setPicks] = useState<Partial<Record<DefaultKind, ModelRef>>>({})
  /** 每类可选的模型（按需拉，只拉当前显示的那几类）。 */
  const [choices, setChoices] = useState<Partial<Record<DefaultKind, ModelChoice[]>>>({})
  const [err, setErr] = useState('')
  const [saved, setSaved] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const r = await call<DefaultsState>('/model-defaults')
    if (!r.ok) { setErr(r.error ?? '读不到默认模型'); return }
    setErr('')
    const next = r.body ?? { defaults: {}, status: {}, broken: {} }
    setState(next)
    /* 把已设的摊进 picks（**没设的就不给键**，让「未设」在界面上真的是空的）。 */
    const p: Partial<Record<DefaultKind, ModelRef>> = {}
    for (const kind of DEFAULT_KINDS) {
      const ref = next.defaults?.[keyOf(kind)]
      if (ref !== undefined) p[kind] = { channelId: ref.channelId, modelId: ref.modelId }
    }
    setPicks(p)
  }, [])

  /* 四类的可选模型各拉一次。**按 kind 筛** —— 生图下拉里不该出现只做视频的模型。 */
  const loadChoices = useCallback(async (): Promise<void> => {
    const next: Partial<Record<DefaultKind, ModelChoice[]>> = {}
    for (const kind of DEFAULT_KINDS) {
      const r = await call<{ models?: ModelChoice[], items?: ModelChoice[] }>('/gen-models?kind=' + kind)
      next[kind] = toChoices(r.body)
    }
    setChoices(next)
  }, [])

  useEffect(() => {
    if (!active) return
    void load()
    void loadChoices()
  }, [active, load, loadChoices])

  /** 保存（整份四类）。 */
  const save = async (): Promise<void> => {
    setSaving(true)
    setSaved('')
    const r = await call<unknown>('/model-defaults', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(toSaveBody(picks)),
    })
    setSaving(false)
    if (!r.ok) { setErr(r.error ?? '保存失败'); return }
    setErr('')
    /* 生效依据：生成时现读盘 —— `src/schedule/generate.ts:375` 每次
     * `await readModelDefaults()`，`model-defaults.ts:128` 直接 readFile，没有内存缓存。
     * 所以存完下一次生成就用新的，不用重启，也不用刷新页面。 */
    setSaved('已保存。下一次生成就按这里选的那条走，立刻生效，不用重启，也不用刷新页面。')
    await load()
  }

  const field = 'min-w-0 flex-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none'

  return (
    /* ★ 票 02（2026-10-30）：**这里不加 `ws.section`** —— 它已经被外面那层
     * `ConfigBoard` 的 `<div className={css.section} data-ewb-content-defaults-section>`
     * 包着了（`ConfigBoard.tsx:168`）。再套一层会画出**两条横线**、间距也翻倍。
     *
     * 三块的统一方式是：**外层的 `.section` 只加一次**。
     * 有的是组件自己带（`ModelListSection` / `ChannelSettings`），
     * 有的是外面包（这一块）。判据只要求「这块最终落在一个 `.section` 里」，
     * 不要求它自己带 —— 那才是「统一」的实话。 */
    <div className="flex flex-col gap-2" data-ewb-defaults="">
      <div className="flex items-center gap-3">
        <span className={ws.sectionTitle} style={{ marginBottom: 0 }} data-ewb-defaults-head="">默认模型</span>
        <span className="flex-1" />
        <button
          type="button"
          data-ewb-defaults-reload=""
          className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
          onClick={() => { void load() }}
        >重新读取</button>
        <button
          type="button"
          data-ewb-defaults-save=""
          disabled={saving}
          className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-3 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)] disabled:opacity-40"
          onClick={() => { void save() }}
        >{saving ? '保存中…' : '保存'}</button>
      </div>

      {err === ''
        ? null
        : (
          <div data-ewb-defaults-error="" className="flex items-start gap-2 rounded-card border border-dashed border-[#ff5f6d] px-3 py-2">
            <span className="dot warn" style={{ marginTop: 5 }} />
            <span className="min-w-0 flex-1 font-mono text-ewb-caption leading-relaxed text-[#ff8a8a]">{err}</span>
          </div>
        )}

      {saved === ''
        ? null
        : (
          <div data-ewb-defaults-saved="" className="rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2 font-mono text-ewb-caption text-[#4ec9b0]">{saved}</div>
        )}

      {/* ★ 票 75：**块状**排版（用户：「当前默认模型说明文字太多了」，且要求按宽度自动排）。
       *
       * ## 为什么用内联 style 的 grid 而不用 Tailwind 断点变体
       *
       * 本仓库**故意不引 tailwind 默认主题**（`pitfalls/假防线` 第 11 条）——
       * `lg:grid-cols-4` / `2xl:grid-cols-5` 这类断点变体**静默不发射**，
       * 写了也当没写。所以要「按容器宽度自动排一行几个」，只能走
       * `repeat(auto-fill, minmax(…))` —— 那是 CSS 自己的能力，与断点无关。
       *
       * `minmax(150px, 1fr)`：一块至少 150px（够放「文生图」三个字 + 一个下拉），
       * 容器宽就多排几块。配置板块最宽 720，两个下拉一行放得下两块半。 */}
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }} data-ewb-defaults-grid="">
      {DEFAULT_KINDS.map(kind => {
        const st = kindState(state, kind)
        const list = choices[kind] ?? []
        const cur = picks[kind]
        const value = cur === undefined ? '' : cur.channelId + '/' + cur.modelId
        return (
          <div
            key={kind}
            data-ewb-defaults-row={kind}
            data-ewb-defaults-phase={st.phase}
            className={[
              'flex flex-col gap-1 rounded-ctl border px-2 py-1.5',
              st.phase === 'broken' ? 'border-[#ff5f6d]' : 'border-[var(--dsw-alias-border-l2)]',
            ].join(' ')}
          >
            <div className="flex items-center gap-2">
              <span className="w-16 shrink-0 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]" data-ewb-defaults-label={kind}>{KIND_LABEL[kind]}</span>
              <select
                data-ewb-defaults-select={kind}
                className={field}
                value={value}
                onChange={(e) => {
                  const v = e.target.value
                  setPicks(prev => {
                    const next = { ...prev }
                    if (v === '') { delete next[kind]; return next }
                    const hit = list.find(c => c.channelId + '/' + c.modelId === v)
                    if (hit === undefined) { delete next[kind]; return next }
                    next[kind] = { channelId: hit.channelId, modelId: hit.modelId }
                    return next
                  })
                  setSaved('')
                }}
              >
                {/* ★ 「未设」是一个真实选项，不是空 `<option>` 占位 ——
                 * 用户要能明确地把某一类改回「不设」。 */}
                <option value="" data-ewb-defaults-unset={kind}>未设（不设默认）</option>
                {list.map(c => (
                  <option key={c.channelId + '/' + c.modelId} value={c.channelId + '/' + c.modelId}>
                    {c.channelName} · {c.modelLabel === '' ? c.modelId : c.modelLabel}
                  </option>
                ))}
              </select>
            </div>
            <span
              data-ewb-defaults-state={kind}
              className={[
                'font-mono text-ewb-caption leading-relaxed',
                st.phase === 'broken' ? 'text-[#ff8a8a]'
                  : st.phase === 'set' ? 'text-[#4ec9b0]' : 'text-[var(--dsw-alias-label-tertiary)]',
              ].join(' ')}
            >{st.text}</span>
            {/* ★ 「文本」这一格的说明（票 38，2026-10-28；票 02 精简，2026-10-30）。
             *
             * ## 票 02 为什么从三句裁到一句
             *
             * 用户原话（第 3 条）：「设置中的默认模型说明文字太多。
             * 当前排版有问题……」
             *
             * 判据是那句老规矩：**删掉这句用户会不会做错事？** 逐句过：
             *
             * | 原句 | 删掉会做错事吗 | 处置 |
             * |---|---|---|
             * | 「内容画布的文本节点生成文字时用这一格。反推提示词也用它。」 | **不会** —— 下拉里写着「文本」，用户配的就是文本用途，不需要被告知谁在用 | 删 |
             * | 「各协议对文字的支持不同：ComfyUI 与 Gemini 协议都能生成文字」 | **不会** —— 「能生成」是默认预期，支持的选择本来就在下拉里（`/gen-models?kind=text` 已按能力筛过） | 删 |
             * | 「OpenAI 协议当前只做图像与视频」 | **会** —— 用户拿 OpenAI 那条渠道去配文本，会以为配了就生效，实际生成时被拒 | **留** |
             *
             * ## 留下的这一句为什么是这个说法
             *
             * 只保留**会让人做错事的那一条**（OpenAI 不支持文字），且只说他需要知道的：
             * 「不能生成文字」。不解释为什么、不给替代方案 —— 那些是他真去点了才会遇到的问题，
             * 写在这里只是让这一格更像说明书。
             *
             * ## 协议支持的真实现（核过的出处，别把句子改回排他句）
             *
             * | 协议 | 文字 | 出处 |
             * |---|---|---|
             * | `comfyui` | 支持（走 `text` 类别的工作流） | `generate.ts:202` `categoryOf` 的 `caption → 'text'`；`net-gen.ts:241` 那条拦截对 `kind === 'text'` 不生效 |
             * | `gemini` | 支持（同一路能做文字与图） | `net-gen.ts:279` `req.kind === 'image' \|\| req.kind === 'text'` |
             * | `openai` | **不支持**，明确拒绝 | `net-gen.ts:268` 抛「文字请用 dsh 自己的模型（`ai.agent` 节点）」 |
             *
             * ⚠️ **不许改成更长的解释**（票面明令）。要补细节宁可补在注释里，
             * 不要搬回界面上 —— 用户 2026-10-23 说过「说明文字尽量不写，
             * 只有看不出后果的开关才写一句」。
             *
             * ⚠️ 这段只在 `text` 那一格出现：别的四类（文生图 / 图生图 / 视频 / 音频）
             * 的协议支持是另一套判据，写在这里反而误导。 */}
            {kind === 'text'
              ? (
                <span
                  data-ewb-defaults-text-note=""
                  className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]"
                >
                  OpenAI 协议不能生成文字。
                </span>
              )
              : null}
            {/* 可选模型一个都没有：说清为什么（否则下拉里只有「未设」，像坏了）。 */}
            {list.length === 0
              ? (
                <span data-ewb-defaults-empty={kind} className="font-mono text-ewb-caption text-[#f0b429]">
                  还没有这一类型的模型 —— 先在下面的清单里给模型标上「{KIND_LABEL[kind]}」。
                </span>
              )
              : null}
          </div>
        )
      })}
      </div>
    </div>
  )
}
