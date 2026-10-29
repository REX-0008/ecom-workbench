/** 渠道 · 拉取模型弹窗（P3 第 3 块，用户 m03414）。
 *
 * ## 这一块解决什么
 *
 * 渠道表单里「模型」那一格是**一个 textarea**，要求用户手打
 * `gpt-image-1|GPT Image 1|image` 这种格式。而渠道上明明配了 `baseUrl` 与密钥，
 * 上游有哪些模型是**能问出来的** —— 后端 `GET /channels/:id/models?kind=` 就是干这个的
 * （`docs/机制-配置面接口.md` §一）。
 *
 * 现在：点「拉取模型」→ 真去问上游 → 勾选 → 追加进那个 textarea。
 * **不替用户猜能力**：上游只告诉我们「有什么」，能不能生图是我们这边的标记，
 * 所以勾进来的模型 `caps` 是空的，要用户自己标（这一点界面上要写明）。
 *
 * ## 四条协议路径与四种失败（照后端文档，一个字都不自己拼）
 *
 * | 协议 | 谁拼 URL | kind 参数 |
 * |---|---|---|
 * | comfyui | 后端（`comfyModelsUrl`） | **必须带**，四个值之一 |
 * | openai | 后端（`openAiModelsUrl`） | 不用 |
 * | gemini | 后端（`geminiModelsUrl`） | 不用 |
 *
 * 四种失败 `kind`（`model-fetch.ts:42`）：`unreachable` / `auth` / `no-endpoint` / `upstream`。
 * **每种都要说清该去改什么** —— 这是后端文档那张对照表的落地。
 *
 * ⚠️ **「连不上」与「没这个接口」必须分开**：看到「连不上」会去查网络，
 * 而实际可能是「这个地址不是 OpenAI 兼容的」—— 两件事的修法完全不同。
 *
 * ## 空数组不是失败
 *
 * `ok: true` + `models: []` = 「这一类确实一个都没有」。界面要显示「这一类没装模型」，
 * **不要显示「加载失败」**（那会让用户去查一个没坏的东西）。
 */
import { useCallback, useState } from 'react'
import { Modal } from 'antd'
import { call } from './board-kit.ts'

/** ComfyUI 必须带的四个 `?kind=` 取值（照 `model-fetch.ts:45`）。 */
export const COMFY_KINDS = ['diffusion', 'text_encoder', 'checkpoint', 'vae'] as const

/**
 * `?kind=` 的中文名。
 *
 * ⚠️ 值**不许自己拼**：`text_encoder` 与 `text_encoders` 是两个名字
 * （参考项目叫 `clip`、接口叫 `text_encoders`、我们对外叫 `text_encoder`）。
 * 这里只做「值 → 中文」的映射，值本身照后端那张表抄。
 */
export const COMFY_KIND_LABEL: Record<typeof COMFY_KINDS[number], string> = {
  diffusion: '扩散模型（diffusion_models）',
  text_encoder: '文本编码器（text_encoders）',
  checkpoint: '整包模型（checkpoints）',
  vae: 'VAE',
}

/** 拉回来的一条。 */
export interface FetchedModel {
  /** 上游给的 id（存进渠道的就是这个）。 */
  id: string
  /** 上游给的显示名。 */
  label: string
}

/** 失败种类（照 `model-fetch.ts:42` 的 `FetchFailKind`）。 */
export type FetchFailKind = 'unreachable' | 'auth' | 'no-endpoint' | 'upstream' | ''

/** `GET /channels/:id/models` 的回包（照 docs §一）。 */
export interface ModelsReply {
  /** 成功没有。**HTTP 仍是 200，看这个字段。** */
  ok?: boolean
  /** 失败种类。 */
  kind?: string
  /** 上游 HTTP 状态。 */
  status?: number
  /** 实际请求的地址 —— 地址写错是最高频原因，必须显示。 */
  url?: string
  /** 拉到的模型。 */
  models?: FetchedModel[]
  /** 给人看的说明（成功与失败都可能有）。 */
  error?: string
}

/**
 * 一种失败该告诉用户改什么。
 *
 * ## 为什么单独一个纯函数
 *
 * 这张表是**后端文档 §一 那张对照表**的界面侧落地。抽出来有两个好处：
 *   ① 判据能直接钉「四种 kind 给四种不同的建议」，不用挂 DOM；
 *   ② 以后加第五种失败时，改一处就够。
 *
 * @param kind - 后端给的失败种类。
 * @param upstream - 上游原文（`error` 字段），拼在建议后面。
 * @returns 一句「该去改什么」。
 */
export function fixHint(kind: string, upstream: string): string {
  const tail = upstream === '' ? '' : '（上游说：' + upstream + '）'
  if (kind === 'unreachable') {
    return '连不上这个地址。先检查：地址写对没有（协议头、端口）、服务起了没有、这台机器能不能访问它。' + tail
  }
  if (kind === 'auth') {
    return '密钥不对或没权限。先检查：这个渠道的密钥填了没有、过期没有、这个账号能不能列模型。' + tail
  }
  if (kind === 'no-endpoint') {
    return '这个地址没有「列出模型」的接口。多半是协议选错了 —— OpenAI 兼容 / ComfyUI / Gemini 是三条不同的路，换对协议再试；ComfyUI 还要确认版本。' + tail
  }
  return '上游返回了它自己的一条错误。这条不是地址或密钥的问题，把下面那句原文给对方看。' + tail
}

/**
 * 一种失败拆成**三段**说：发生了什么 / 为什么 / 怎么办（票 36 的 R6 要求）。
 *
 * ## 为什么与 `fixHint` 并存而不是替换它
 *
 * `fixHint` 是「一段话把该改什么说完」，用在拉取弹窗里那块紧凑的失败条上（那里
 * 空间小，而且用户已经知道自己点的是「拉取」）。而「测连通」是在**填密钥的时候**
 * 点的 —— 那一刻用户还没保存过任何东西，光给一句「连不上」他分不清是自己填错了
 * 还是服务没起。所以要把三件事分开写清楚，各占一行。
 *
 * 两处共用同一张表（`kind` 的四种取值也来自同一处），加第五种时只改一处。
 *
 * @param kind - 后端给的失败种类。
 * @param upstream - 上游原文（后端 `error` 字段）。
 * @returns 三段文字。
 */
export function probeVerdict(kind: string, upstream: string): { title: string, reason: string, fix: string } {
  const tail = upstream === '' ? '' : '上游原文：' + upstream
  if (kind === 'unreachable') {
    return {
      title: '连不上这个地址',
      reason: '请求没有到达上游。地址写错、端口没开、服务没启动，都会走到这里。' + tail,
      fix: '核对地址与端口，确认那个服务已经启动、这台机器能访问它，再测一次。',
    }
  }
  if (kind === 'auth') {
    return {
      title: '密钥不对或没有权限',
      reason: '地址是通的，上游收到了请求并明确拒绝 —— 问题在密钥这一环。' + tail,
      fix: '核对密钥是否填错、是否过期、这个账号能不能列出模型；换一把有效的密钥再测一次。',
    }
  }
  if (kind === 'no-endpoint') {
    return {
      title: '这个地址没有列出模型的接口',
      reason: '地址能连上，但那里没有这个协议的接口 —— 多半是协议选错了。' + tail,
      fix: '把协议改成与上游一致的那一种（OpenAI 兼容 / ComfyUI / Gemini 是三条不同的路）；ComfyUI 还要确认版本。',
    }
  }
  return {
    title: '上游报错',
    reason: '上游自己返回了错误。这一条与地址、密钥都无关。' + tail,
    fix: '把上游原文交给该服务的维护方；地址与密钥不用改。',
  }
}

/**
 * 把勾选的模型追加进「模型」文本框。
 *
 * ## 三条规矩
 *
 * 1. **去重**：已经在文本框里的不再加一遍（用户可能已经手打过几个）。
 * 2. **能力留空**：上游只说「有什么」，不说「能干什么」。写死一个 `image` 会让
 *    用户在生视频时选到它然后失败。留空 → 界面上那句提示会让他自己标。
 * 3. **不加空行**：文本框末尾已经有换行时不再补一个。
 *
 * @param current - 文本框现在的内容。
 * @param picked - 勾选的模型。
 * @returns 新的文本框内容。
 */
export function appendModels(current: string, picked: readonly FetchedModel[]): string {
  const lines = current.split('\n')
  /** 已有模型的 id（只取每行第一个 `|` 之前那段）。 */
  const have = new Set(lines.map(l => l.split('|')[0].trim()).filter(id => id !== ''))
  const add: string[] = []
  for (const m of picked) {
    const id = m.id.trim()
    if (id === '' || have.has(id)) continue
    have.add(id)
    /* `id|显示名|` —— 最后那个空的能力是有意的，见上面第 2 条。 */
    add.push(id + '|' + (m.label.trim() === '' ? id : m.label.trim()) + '|')
  }
  if (add.length === 0) return current
  const base = current.replace(/\n+$/, '')
  return base === '' ? add.join('\n') : base + '\n' + add.join('\n')
}

/** 拉取模型弹窗的入参。 */
export interface FetchModelsDialogProps {
  /** 开着没有。 */
  open: boolean
  /** 渠道 id（空串表示还没保存的渠道）。 */
  channelId: string
  /** 协议（决定要不要选 kind）。 */
  protocol: string
  /** 接口地址（**草稿里的值**，不是盘上的）。没保存时靠它去问上游。 */
  baseUrl?: string
  /** 密钥（**草稿里的值**）。只在没保存的渠道上用来做一次预检，不发去别处。 */
  apiKey?: string
  /** 当前「模型」文本框的内容。 */
  current: string
  /** 追加之后的回调。 */
  onAppend: (next: string) => void
  /** 关掉。 */
  onClose: () => void
}

/**
 * 拉取模型弹窗。
 * @param props - 见入参。
 * @returns 弹窗。
 */
export function FetchModelsDialog({ open, channelId, protocol, baseUrl = '', apiKey = '', current, onAppend, onClose }: FetchModelsDialogProps): React.JSX.Element {
  const [kind, setKind] = useState<typeof COMFY_KINDS[number]>('diffusion')
  const [models, setModels] = useState<FetchedModel[]>([])
  const [reply, setReply] = useState<ModelsReply | null>(null)
  const [picked, setPicked] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  const isComfy = protocol === 'comfyui'
  /** 这条渠道存过没有。没存过时 `channelId` 是空串。 */
  const saved = channelId !== ''

  /**
   * 没保存的渠道：拿表单里的地址与密钥**先问一次上游**（票 36）。
   *
   * ## 为什么这条路能行
   *
   * 后端新开了 `POST /channels/probe`：它**只读请求体**里那三样（协议 / 地址 / 密钥），
   * 不碰盘上的 `channels.json`，也就不需要渠道 id。所以「先验后存」成立了。
   *
   * ## 与「开始拉取」分开的理由
   *
   * 已保存的渠道走 `/channels/:id/models`（读盘上那份配置，用户可能手改过盘）；
   * 没保存的只能走 probe（读表单草稿）。两条路的**输入来源不同**，
   * 混成一条会让「问的是哪一份配置」说不清。
   *
   * @param k - ComfyUI 的类别（其余协议忽略）。
   */
  const probeOnce = useCallback(async (k: string): Promise<void> => {
    setLoading(true)
    setErr('')
    setReply(null)
    setModels([])
    setPicked({})
    const r = await call<ModelsReply>('/channels/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol,
        baseUrl,
        apiKey,
        ...protocol === 'comfyui' ? { kind: k } : {},
      }),
    })
    setLoading(false)
    if (!r.ok) { setErr(r.error ?? '测不出结论'); return }
    const body = r.body ?? {}
    setReply(body)
    setModels(Array.isArray(body.models) ? body.models : [])
  }, [protocol, baseUrl, apiKey])

  /** 拉一次。 */
  const fetchOnce = useCallback(async (k: string): Promise<void> => {
    if (channelId === '') { setErr('先把这条渠道保存一次 —— 拉取模型要按渠道 id 去问上游。'); return }
    setLoading(true)
    setErr('')
    setReply(null)
    setModels([])
    setPicked({})
    /* ★ ComfyUI 必须带 kinds（后端不带会给一条 `no-endpoint` 并说明要哪一类）。
     * 其它两条协议带了也不报错，但**没必要带**，所以只在 comfyui 时加。 */
    const q = isComfy ? '?kind=' + encodeURIComponent(k) : ''
    const r = await call<ModelsReply>('/channels/' + encodeURIComponent(channelId) + '/models' + q)
    setLoading(false)
    if (!r.ok) { setErr(r.error ?? '拉取失败'); return }
    const body = r.body ?? {}
    setReply(body)
    const list = Array.isArray(body.models) ? body.models : []
    setModels(list)
    /* 默认全不勾 —— 用户要自己挑。全勾会把「上游有一百个」一次性灌进文本框。 */
  }, [channelId, isComfy])

  const field = 'min-w-0 flex-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none'

  return (
    <Modal
      open={open}
      title="拉取模型"
      footer={null}
      width={680}
      centered
      getContainer={false}
      onCancel={onClose}
    >
      <div data-ewb-fetch="" className="flex max-h-[70vh] min-h-0 flex-col gap-2">
        {/* ComfyUI 要先选「哪一类」—— 它的四个类别是四次不同的请求。 */}
        {isComfy
          ? (
            <div className="flex items-center gap-2">
              <span className="shrink-0 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">类别</span>
              <select
                data-ewb-fetch-kind=""
                className={field}
                value={kind}
                onChange={(e) => { setKind(e.target.value as typeof COMFY_KINDS[number]) }}
              >
                {COMFY_KINDS.map(k => (
                  <option key={k} value={k}>{COMFY_KIND_LABEL[k]}</option>
                ))}
              </select>
            </div>
          )
          : null}

        <div className="flex items-center gap-2">
          {/* ★ 两条路共用一个按钮位置，但标签与行为不同（票 36）：
           *   · 存过的渠道 → 「开始拉取」，走 `/channels/:id/models`（读盘上那份配置）
           *   · 还没存的渠道 → 「测连通并列出模型」，走 `/channels/probe`（读表单草稿）
           * 分成两个按钮会更糟：用户得先判断「我存过没有」才知道点哪个。 */}
          <button
            type="button"
            data-ewb-fetch-go=""
            data-ewb-fetch-probe={saved ? undefined : ''}
            disabled={loading}
            className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-3 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)] disabled:opacity-40"
            onClick={() => { void (saved ? fetchOnce(kind) : probeOnce(kind)) }}
          >{loading
              ? (saved ? '拉取中…' : '测试中…')
              : (saved ? '开始拉取' : '测连通并列出模型')}</button>
          <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
            {isComfy
              ? 'ComfyUI 一次只列一类，四类要分别拉'
              : saved ? '用这条渠道的地址与密钥去问上游' : '用表单里填的地址与密钥去问一次上游，不需要先保存'}
          </span>
        </div>

        {err === ''
          ? null
          : (
            <div data-ewb-fetch-error="" className="rounded-card border border-dashed border-[var(--dsw-alias-state-error-primary)] px-3 py-2 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-state-error-primary)]">{err}</div>
          )}

        {/* ★ 实际请求的地址：地址写错是最高频的原因，而它是唯一能一眼看出的地方。 */}
        {reply?.url === undefined
          ? null
          : <div data-ewb-fetch-url="" className="break-all font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">请求地址：{reply.url}</div>}

        {/* ── 失败：四种 kind 各说清该改什么（后端文档那张对照表）── */}
        {reply !== null && reply.ok === false
          ? (
            <div data-ewb-fetch-fail={reply.kind ?? 'upstream'} className="rounded-card border border-dashed border-[var(--dsw-alias-state-error-primary)] px-3 py-2">
              <div className="font-mono text-ewb-caption text-[var(--dsw-alias-state-error-primary)]" data-ewb-fetch-fail-kind="">
                {reply.kind === 'unreachable' ? '连不上'
                  : reply.kind === 'auth' ? '密钥不对'
                    : reply.kind === 'no-endpoint' ? '这个地址没有列模型的接口'
                      : '上游报错'}
                {reply.status === undefined ? '' : '（HTTP ' + String(reply.status) + '）'}
              </div>
              <div className="mt-1 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-secondary)]" data-ewb-fetch-fail-hint="">
                {fixHint(reply.kind ?? 'upstream', reply.error ?? '')}
              </div>
              {/* ★ 还没保存时的「测连通」多给两段（票 36）：那一刻用户刚填完密钥，
               * 只给一句笼统建议他分不清是填错了还是服务没起。三段各占一行：
               * 发生了什么（上面那行）→ 为什么 → 怎么办。 */}
              {saved
                ? null
                : (() => {
                  const v = probeVerdict(reply.kind ?? 'upstream', reply.error ?? '')
                  return (
                    <>
                      <div className="mt-1 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-secondary)]" data-ewb-fetch-why="">
                        原因：{v.reason}
                      </div>
                      <div className="mt-1 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-secondary)]" data-ewb-fetch-fix="">
                        怎么办：{v.fix}
                      </div>
                    </>
                  )
                })()}
            </div>
          )
          : null}

        {/* ── 成功但空：说「这一类没装模型」，不许说成加载失败 ── */}
        {reply !== null && reply.ok === true && models.length === 0
          ? (
            <div data-ewb-fetch-empty="" className="rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-secondary)]">
              这一类一个模型都没有（不是加载失败）。
              {isComfy ? '换个类别看看，或者先在 ComfyUI 那边装模型。' : '这个地址能连上，但它没有可列的模型。'}
            </div>
          )
          : null}

        {/* ── 成功有货：勾选列表 ── */}
        {models.length === 0
          ? null
          : (
            <div className="min-h-0 flex-1 overflow-y-auto rounded-card border border-[var(--dsw-alias-border-l2)]" data-ewb-fetch-list="">
              {models.map(m => (
                <label key={m.id} className="flex items-center gap-2 border-b border-[var(--dsw-alias-border-l2)] px-2 py-1 last:border-b-0">
                  <input
                    type="checkbox"
                    data-ewb-fetch-item={m.id}
                    checked={picked[m.id] === true}
                    onChange={(e) => { setPicked(prev => ({ ...prev, [m.id]: e.target.checked })) }}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)]" title={m.label}>{m.label === '' ? m.id : m.label}</span>
                  <span className="shrink-0 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">{m.id}</span>
                </label>
              ))}
            </div>
          )}

        {/* ★ 能力留空必须说明：上游只说「有什么」，不说「能干什么」。 */}
        {models.length === 0
          ? null
          : (
            <div className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]" data-ewb-fetch-capsnote="">
              勾进来的模型能力是空的 —— 上游只告诉我们它有什么，不说它能生图还是能生视频。
              保存之后到「默认模型」那四栏里给它们标上能力，否则生成时选到会用不了。
            </div>
          )}

        <div className="flex items-center gap-2">
          <span className="flex-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" data-ewb-fetch-picked="">
            已勾 {String(Object.values(picked).filter(Boolean).length)} 个
          </span>
          <button
            type="button"
            data-ewb-fetch-cancel=""
            className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-3 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
            onClick={onClose}
          >关闭</button>
          <button
            type="button"
            data-ewb-fetch-append=""
            className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-3 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
            onClick={() => {
              /* 只取**勾了的**，按上游给的顺序（不重排 —— 用户看到什么顺序就是什么顺序）。 */
              const take = models.filter(m => picked[m.id] === true)
              onAppend(appendModels(current, take))
              onClose()
            }}
          >加入文本框</button>
        </div>

        {/* 生效说明：这一块最容易被误解成「拉完就配好了」。
         * 依据：`onAppend` 只改渠道表单的草稿（`ChannelSettings.tsx:633`
         * `setDraft(d => ({ ...d, modelsText: next }))`），渠道真正写盘要等用户在表单上
         * 点「保存」。而渠道表没有内存缓存（`channels.ts:290` 每次 readFile），
         * 所以保存那一刻之后就生效，不用重启，也不用刷新页面。 */}
        <div className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]" data-ewb-fetch-when="">
          加入文本框只是填进渠道表单，还没有存下来 —— 回到表单点一次「保存」才算配好。
          保存那一刻起就生效，不用重启，也不用刷新页面。
        </div>
      </div>
    </Modal>
  )
}
