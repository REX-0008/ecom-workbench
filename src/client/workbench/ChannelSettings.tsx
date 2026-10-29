/** 渠道与并发：**内容生成走哪条上游**（计划 §三 Step 2 / Step 7，契约 BB）。
 *
 * ## 它现在挂在哪（票 38，2026-10-28 搬家）
 *
 * 这一块原来挂在**内容板块 · 配置页 · 渠道 tab**；2026-10-28 起挂在
 * **配置板块 · 模型格**里（2026-10-29 票 68 之前是那里）。
 *
 * 为什么搬：用户原话（票 37 条目一）「模型方面的配置，工作台级设置其实有这个内容了，
 * 是不是这里的渠道、默认模型应该放到工作台设置中」。渠道是跨板块共用的资源，
 * 作用范围与「工作台级」一致。
 *
 * ⚠️ **不要再把它挂回内容板块** —— 同一个设置两处入口，改一边另边不生效时没人知道是哪边。
 *
 * ## ⚠️ 旧约定已推翻（别照着老注释做）
 *
 * 这里原来写着「默认用哪个模型继续在工作台设置里配。所以这里没有『默认模型』这一项，别加。」
 * —— 那条是 2026-10-26 的临时分工，**票 38 已推翻**：
 *
 * | 什么 | 在哪配 |
 * |---|---|
 * | 内容生成的四类默认模型（生图 / 视频 / 文本 / 音频） | 工作台设置 · 内容默认模型（`DefaultsSettings.tsx`） |
 * | 工作流 `ai.agent` 节点用的大模型 | 工作台设置 · 模型 · 节点默认模型（`model-prefs.json`） |
 * | 渠道与并发 | 本文件 |
 *
 * 注意后两者**不是一件事**（形状都不同：一个是 `{channelId, modelId}`、一个是
 * `{provider, model}`），所以名字必须能自证身份 —— 这是它们现在同居一个抽屉后
 * 最容易被看成一个的地方。判据见 `src/schedule/model-defaults.ts:29-33`。
 *
 * ## 密钥为什么只能写、不能读
 *
 * 宿主把渠道分两个文件存：`channels.json`（可回前端）与 `channels.secret.json`
 * （只有宿主读）。`GET /channels` 回报的每条只有一个布尔 `hasKey`，
 * **没有任何密钥信息**（`src/schedule/channels.ts` 文件头写了这个设计）。
 *
 * 所以界面这一侧：
 *   · 输入框是**写**的（`apiKey`），保存时随请求体发出去；
 *   · 读回来只显示「已配置 / 未配置」；
 *   · **绝不把密钥放进任何 state 之外的地方**（不回填、不显示、不进 DOM 文本）。
 *
 * ⚠️ 本文件里不许出现「把读回来的密钥放进 input.value」这种写法 ——
 * 读回来的东西里根本没有密钥，写了也只会是一个空框，但它会让人以为「服务器没存」。
 *
 * ## 协议只有三种
 *
 * `openai` / `comfyui` / `gemini`（`src/schedule/channels.ts` 的 `PROTOCOLS`）。
 * `gemini` 本期只存不调用，计划 §三 2.1 已定。
 */
import { useCallback, useEffect, useState } from 'react'
import { call } from './board-kit.ts'
/* 工作流的类别清单与候选**直接读内置注册表**（验收 10 的判据就是这条：
 * 选项数必须跟着 registry 的类别数走，不许在界面里另写一份名单）。
 *
 * ⚠️ 这是客户端 import `src/schedule/` 的唯一一处，理由与边界：
 *  · `registry.ts` 只导出**纯数据**（类别枚举 + 名字 + 说明），不碰 fs / 网络 / Node 内置；
 *  · 那 16 份 JSON 由打包器内联（`with { type: 'json' }`），部署后不需要 `src/` 目录；
 *  · 换成「让宿主开一条接口回这份清单」会多一次往返、多一处漂移点（两边各写一份 → 迟早不一致）。
 * 这条取舍写在这里，免得以后有人以为「客户端不该碰 schedule」而把它搬走。 */
import { listBuiltinWorkflows, WORKFLOW_CATEGORIES, type WorkflowCategory } from '../../schedule/comfyui-workflows/registry.ts'
/* 拉取模型弹窗（用户 m03414：新增渠道连拉取模型都没有）。
 *
 * ⚠️ 本文件**只负责渠道与并发**。四类默认模型在 `DefaultsSettings.tsx`
 * （它现在与本文件一起挂在工作台设置里）；存储目录 / 提示词源 / 偏好留在
 * 内容板块的配置页。别把那些加回这里（加回就等于同一个设置有两处入口）。 */
import { FetchModelsDialog } from './FetchModelsDialog.tsx'
/* ★ 票 02（2026-10-30）：与其它几节共用一个外壳类与块标题字号。 */
import ws from './WorkbenchSettings.module.css'

/** 类别 → 渠道上那个字段名（照宿主 `generate.ts` 的 `CATEGORY_FIELD`，两边必须一致）。 */
export const CATEGORY_FIELD: Readonly<Record<WorkflowCategory, string>> = {
  t2i: 'comfyuiT2iWorkflow',
  i2i: 'comfyuiI2iWorkflow',
  inpaint: 'comfyuiInpaintWorkflow',
  text: 'comfyuiTextWorkflow',
  omniVideo: 'comfyuiVideoWorkflow',
  frameVideo: 'comfyuiFrameVideoWorkflow',
  audio: 'comfyuiAudioWorkflow',
  faceRefine: 'comfyuiFaceRefineWorkflow',
  depthVideo: 'comfyuiDepthVideoWorkflow',
  superResolve: 'comfyuiSuperResolveWorkflow',
  angle: 'comfyuiAngleWorkflow',
  upscale: 'comfyuiUpscaleWorkflow',
}

/** 类别 → 界面上的中文名。 */
export const CATEGORY_LABEL: Readonly<Record<WorkflowCategory, string>> = {
  t2i: '文生图',
  i2i: '图生图',
  inpaint: '局部编辑',
  text: '文生文本',
  omniVideo: '全能视频',
  frameVideo: '首尾帧视频',
  audio: '音频',
  faceRefine: '人脸修复',
  depthVideo: '深度视频',
  superResolve: '超分',
  angle: '多角度',
  upscale: '放大',
}

/**
 * 每个类别可选的工作流（`用内置默认` + 候选清单）。
 *
 * 为什么「用内置默认」是空串而不是某个 id：**空值有语义** ——
 * 「不填就用默认」，而默认本身将来可能换（上游换了一份）。存 id 的话，
 * 用户什么都没选也会被记成「明确选了当初那一份」，以后改默认他就收不到。
 *
 * @param category - 类别。
 * @returns 下拉选项（第一项是「用内置默认」）。
 */
export function workflowOptions(category: WorkflowCategory): { value: string, label: string }[] {
  const list = listBuiltinWorkflows(category)
  const def = list.find(w => w.isDefault)
  return [
    { value: '', label: '用内置默认' + (def === undefined ? '（这一类没有内置的）' : '：' + def.name) },
    ...list.map(w => ({ value: w.id, label: w.name })),
  ]
}

/** 一条渠道（`GET /channels` 的 `channels[]`，**不含密钥**）。 */
export interface ChannelRow {
  id: string
  name: string
  protocol: string
  baseUrl: string
  models: { id: string, label: string, caps: string[] }[]
  maxConcurrency: number
  /** 配过密钥就 true。**只有布尔，没有任何密钥信息**。 */
  hasKey: boolean
  /* 契约 CA 加的 12 个 ComfyUI 工作流字段 + 2 个代理字段。
   * 形状是 `unknown`（宿主那边也是），所以这里照实写 `unknown` 而不是编一个类型。 */
  comfyuiProxyUrl?: unknown
  comfyuiProxyToken?: unknown
  comfyuiT2iWorkflow?: unknown
  comfyuiI2iWorkflow?: unknown
  comfyuiInpaintWorkflow?: unknown
  comfyuiTextWorkflow?: unknown
  comfyuiVideoWorkflow?: unknown
  comfyuiFrameVideoWorkflow?: unknown
  comfyuiSuperResolveWorkflow?: unknown
  comfyuiAngleWorkflow?: unknown
  comfyuiUpscaleWorkflow?: unknown
  comfyuiAudioWorkflow?: unknown
  comfyuiFaceRefineWorkflow?: unknown
  comfyuiDepthVideoWorkflow?: unknown
}

/**
 * 从存下来的工作流值里读出「选的是内置的哪一份」。
 *
 * 三种形状都认（用户导入的形状本来就不统一）：
 *   · `{ id, name, json }`（我们存的）
 *   · `{ name, json }`（早期存的 / 用户自己导入的）
 *   · 裸 JSON 工作流（键是一串数字，那是 ComfyUI 的节点号）
 *
 * @param v - 存下来的值。
 * @returns 内置 id；认不出来给空串（显示成「用内置默认」并保留原值）。
 */
export function workflowIdOf(v: unknown): string {
  if (typeof v !== 'object' || v === null) return ''
  const rec = v as Record<string, unknown>
  if (typeof rec.id === 'string' && listBuiltinWorkflows().some(w => w.id === rec.id)) return rec.id
  const found = listBuiltinWorkflows().find(w => w.name === rec.name)
  return found === undefined ? '' : found.id
}

/** 三种协议（与宿主 `PROTOCOLS` 一致）。 */
export const PROTOCOLS: readonly { v: string, label: string }[] = [
  { v: 'openai', label: 'OpenAI 兼容' },
  { v: 'comfyui', label: 'ComfyUI（本地直连）' },
  { v: 'gemini', label: 'Gemini' },
]

/** 一条渠道显示成什么（协议的中文名）。 */
export function protocolLabel(v: string): string {
  return PROTOCOLS.find(p => p.v === v)?.label ?? (v === '' ? '—' : v)
}

/** 「配没配密钥」的文案。 */
export function keyText(hasKey: boolean): string {
  return hasKey ? '已配置' : '未配置'
}

/** 表单里的草稿（新建 / 编辑共用）。 */
interface Draft {
  /** 编辑已有渠道时是它的 id；新建时是空串。 */
  id: string
  name: string
  protocol: string
  baseUrl: string
  apiKey: string
  modelsText: string
  maxConcurrency: string
  /** 12 个类别各选了哪一份（内置 id，空串 = 用内置默认）。 */
  workflows: Record<string, string>
  /** 代理地址 / token（ComfyUI 那一块）。 */
  proxyUrl: string
  proxyToken: string
}

/** 空草稿（默认值照宿主：`maxConcurrency` 5、协议 `openai`）。 */
const EMPTY_DRAFT: Draft = {
  id: '', name: '', protocol: 'openai', baseUrl: '', apiKey: '', modelsText: '', maxConcurrency: '5',
  workflows: {}, proxyUrl: '', proxyToken: '',
}

/**
 * 把「一行一个模型」的文本收成模型数组。
 *
 * 写法是 `模型id` 或 `模型id|显示名|能力,能力` —— 后端也接受更复杂的形状，
 * 但界面上不需要把它做成表格（那是「以后要更精细时」的事）。
 *
 * @param text - 多行文本。
 * @returns 模型数组。
 */
export function parseModels(text: string): { id: string, label: string, caps: string[] }[] {
  const out: { id: string, label: string, caps: string[] }[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const [idPart, labelPart, capsPart] = line.split('|')
    const id = (idPart ?? '').trim()
    if (id === '') continue
    out.push({
      id,
      label: (labelPart ?? '').trim() === '' ? id : (labelPart ?? '').trim(),
      caps: (capsPart ?? '').split(',').map(s => s.trim()).filter(s => s !== ''),
    })
  }
  return out
}

/** 配置格的入参。 */
export interface ChannelSettingsProps {
  /** 这一格是不是正显示着。 */
  active: boolean
  /**
   * 只列某一种协议的渠道（可选；不传 = 不过滤，行为与票 68 之前**一字不差**）。
   *
   * ## 为什么加这个入参（票 75，2026-10-29）
   *
   * 用户原话：「comfyui 给他单独做个设置来兼容他吧。不要把他放在模型里面，
   * 独立一个 tab 吧。他是通过工作流来确定类型，所以不需要设置类型。」
   *
   * 于是配置板块从两格变成三格：`模型 / ComfyUI / 其它`。
   * 模型格只列 **OpenAI / Gemini** 那类（模型自带类型），
   * ComfyUI 格列 ComfyUI 那类（类型由 12 份工作流绑定决定）。
   *
   * ## 为什么是「加入参」而不是「另写一个组件」
   *
   * `tests/workbenches.mjs` 与 `tests/channels-workflow.mjs` **直接挂这个组件**，
   * 按 `data-ewb-channel-row` / `-new` / `-form` 找。另写一个组件意味着
   * 那两份测试验的是一个**界面上已经不用的东西** —— 那是最坏的一种绿。
   *
   * 加入参之后：不传就完全照旧（那两份测试一行都不用改），
   * 传了就多一层过滤。**过滤只影响「列哪些行」，不影响表单与任何按钮。**
   */
  onlyProtocol?: string
}

/**
 * 配置格（渠道 + 并发）。
 * @param props - 是否可见、要不要按协议过滤。
 * @returns 界面。
 */
export function ChannelSettings({ active, onlyProtocol }: ChannelSettingsProps): React.JSX.Element {
  const [rows, setRows] = useState<ChannelRow[]>([])
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [editing, setEditing] = useState(false)
  /** 正在测的那条（按钮显示「测试中…」）。 */
  const [testing, setTesting] = useState('')
  /** 「拉取模型」弹窗开着没有（P3 第 3 块）。 */
  const [fetchOpen, setFetchOpen] = useState(false)
  /** 测过的结论（按渠道 id）。没测过的键不存在 —— 不显示假结论。 */
  const [tested, setTested] = useState<Record<string, { ok: boolean, message: string }>>({})
  /** 保存成功后的那句话（含「什么时候生效」）。 */
  const [saved, setSaved] = useState('')

  /**
   * 测一条渠道通不通。
   *
   * ⚠️ 宿主那条路由**失败也回 200**（那是「测试结果」不是「接口失败」），
   * 结论在 `result` / `error` 里。所以这里不按 HTTP 状态判成功，按 `result.ok`。
   *
   * @param id - 渠道 id。
   */
  const testOne = async (id: string): Promise<void> => {
    setTesting(id)
    const r = await call<{ ok?: boolean, result?: { ok: boolean, message: string }, error?: string }>(
      '/channels/' + encodeURIComponent(id) + '/test', { method: 'POST' },
    )
    setTesting('')
    const body = r.body
    if (body?.result !== undefined) {
      setTested(prev => ({ ...prev, [id]: { ok: body.result.ok, message: body.result.message } }))
      return
    }
    setTested(prev => ({ ...prev, [id]: { ok: false, message: r.error ?? body?.error ?? '测不出结论' } }))
  }

  /** 重读渠道表。 */
  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const r = await call<{ channels?: ChannelRow[] }>('/channels')
    setLoading(false)
    if (!r.ok) { setErr(r.error ?? '读不到渠道表'); return }
    setErr('')
    setRows(Array.isArray(r.body?.channels) ? r.body.channels : [])
  }, [])

  useEffect(() => {
    if (active) void load()
  }, [active, load])

  /** 开始编辑某一条（**不回填密钥** —— 读回来的东西里没有它）。 */
  const edit = (c: ChannelRow): void => {
    const wf: Record<string, string> = {}
    for (const cat of WORKFLOW_CATEGORIES) {
      const field = CATEGORY_FIELD[cat]
      wf[cat] = workflowIdOf((c as unknown as Record<string, unknown>)[field])
    }
    setDraft({
      id: c.id,
      name: c.name,
      protocol: c.protocol,
      baseUrl: c.baseUrl,
      apiKey: '',
      modelsText: c.models.map(m => m.id + '|' + m.label + '|' + m.caps.join(',')).join('\n'),
      maxConcurrency: String(c.maxConcurrency),
      workflows: wf,
      proxyUrl: typeof c.comfyuiProxyUrl === 'string' ? c.comfyuiProxyUrl : '',
      proxyToken: typeof c.comfyuiProxyToken === 'string' ? c.comfyuiProxyToken : '',
    })
    setEditing(true)
  }

  /** 保存。 */
  const save = async (): Promise<void> => {
    const body: Record<string, unknown> = {
      name: draft.name.trim(),
      protocol: draft.protocol,
      baseUrl: draft.baseUrl.trim(),
      models: parseModels(draft.modelsText),
      maxConcurrency: Number(draft.maxConcurrency) || 5,
    }
    if (draft.id !== '') body.id = draft.id
    /* 工作流：空串 = 用内置默认 → **不发那个键**（发空值会让宿主记成「明确选了空」）。 */
    for (const cat of WORKFLOW_CATEGORIES) {
      const id = draft.workflows[cat] ?? ''
      if (id === '') continue
      const hit = listBuiltinWorkflows(cat).find(w => w.id === id)
      if (hit === undefined) continue
      body[CATEGORY_FIELD[cat]] = { id: hit.id, name: hit.name }
    }
    if (draft.proxyUrl.trim() !== '') body.comfyuiProxyUrl = draft.proxyUrl.trim()
    if (draft.proxyToken.trim() !== '') body.comfyuiProxyToken = draft.proxyToken.trim()
    /* 密钥**只在用户这次填了**的时候才发出去。空串不发 —— 发空串会让宿主
     * 以为「要清掉」，而用户只是没改它。 */
    if (draft.apiKey !== '') body.apiKey = draft.apiKey
    const r = await call<unknown>('/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!r.ok) { setErr(r.error ?? '保存失败'); return }
    setErr('')
    /* 生效依据：渠道表没有内存缓存 —— `channels.ts:290` 的 `readChannels` 每次
     * readFile；生成那条路（`generate.ts:312` / `comfyui.ts:563`）也是每次现读。
     * 所以存完下一次生成就用新地址与新的并发上限，不用重启，也不用刷新页面。
     * ⚠️ 已经在跑的任务不受影响：它们开跑时已经拿到了那一刻的渠道快照。 */
    setSaved('已保存。下一次生成就按新的地址与并发上限走，立刻生效，不用重启。正在跑的任务不受影响，下次提交才用新配置。')
    setDraft(EMPTY_DRAFT)
    setEditing(false)
    await load()
  }

  /** 删一条渠道。 */
  const remove = async (c: ChannelRow): Promise<void> => {
    const yes = window.confirm('删除渠道「' + c.name + '」？它的密钥也会一起删掉。')
    if (!yes) return
    const r = await call<unknown>('/channels/' + encodeURIComponent(c.id), { method: 'DELETE' })
    if (!r.ok) { setErr(r.error ?? '删除失败'); return }
    await load()
  }

  const field = 'min-w-0 flex-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none'

  /* ★ 票 75：按协议过滤要**列出来的行**（不传 = 全部，与改动前完全一样）。
   *
   * ⚠️ 只过滤「列哪些行」，**不过滤存盘**：`load()` 拿到的 `rows` 仍是整份，
   * 保存 / 测试 / 删除都按原渠道走。否则「只显示 comfyui」会把别的渠道
   * 在保存时抹掉 —— 那是本票最容易踩的坑（与 `models` 整份发是同一类）。 */
  const shown = onlyProtocol === undefined ? rows : rows.filter(c => c.protocol === onlyProtocol)

  return (
    /* ★ 票 02（2026-10-30）：套上 `ws.section`，与「默认模型」「模型清单」
     * 「dsh 模型目录」共用同一个外壳（上边线、间距同一套）。
     *
     * ## 同时去掉了 `flex-1` 与 `overflow-y-auto`
     *
     * 原来这里自己是 `flex min-h-0 flex-1 flex-col overflow-y-auto` ——
     * **一个滚动容器套在另一个滚动容器里**（外层 `ConfigBoard` 已经是
     * `overflow-y-auto`）。两层滚动正是「展开/折叠一块之后内容错位」的常见来源：
     * 内层自己滚，外层量不到真实高度。
     *
     * 现在只留纵向排列，滚动交给外层的 `ConfigBoard` —— 与其它几节一致。
     *
     * ⚠️ `data-ewb-channels` 钩子留在根上（测试按它找），只多挂了一个类。
     * ⚠️ **12 类工作流绑定等行为一个字没动** —— 这一票只碰呈现与类名。 */
    <div className={'flex flex-col ' + ws.section} data-ewb-channels="">
      <div className="mb-2 flex flex-none items-center gap-3">
        {/* ★ 票 75：这一格的标题按`onlyProtocol` 说话。
         *
         * 用户原话：「怎么还有内容渠道与并发，应该不分内容渠道了」——
         * 那个标题在模型格里已经没有意义（模型格里列的是模型，不是渠道）。
         * 但同一个组件给 ComfyUI 格用时又必须说清「这是 ComfyUI 渠道」，
         * 所以标题跟着入参走，**不写死**。
         *
         * ⚠️ 不传 `onlyProtocol` 时保持原样 —— `tests/workbenches.mjs` 按
         * `data-ewb-channel-head` 找这颗，它那一侧的断言不必改。 */}
        <span className={ws.sectionTitle} style={{ marginBottom: 0 }} data-ewb-channel-head="">{onlyProtocol === undefined ? '内容渠道与并发' : (onlyProtocol === 'comfyui' ? 'ComfyUI 渠道' : '渠道与并发')}</span>
        <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" data-ewb-channel-total="">
          共 {String(shown.length)} 条
        </span>
        <span className="flex-1" />
        <button
          type="button"
          data-ewb-channel-new=""
          className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
          onClick={() => { setDraft(EMPTY_DRAFT); setEditing(true); setSaved('') }}
        >新建渠道</button>
        <button
          type="button"
          data-ewb-channel-refresh=""
          className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
          onClick={() => { void load() }}
        >刷新</button>
      </div>

      <div className="mb-2 flex flex-none items-start gap-2 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2">
        <span className="dot warn" style={{ marginTop: 5 }} />
        <span className="min-w-0 flex-1 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-secondary)]">
          密钥只写不读：保存之后这里只显示「已配置 / 未配置」，看不到内容。这一格只管渠道与并发；四类默认模型在下面「内容默认模型」里配，工作流节点用的大模型在「模型」那一节，三者互不影响。
        </span>
      </div>

      {err === ''
        ? null
        : (
          <div data-ewb-channel-error="" className="mb-2 flex flex-none items-start gap-2 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2">
            <span className="dot warn" style={{ marginTop: 5 }} />
            <span className="min-w-0 flex-1 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-secondary)]">{err}</span>
          </div>
        )}

      {/* 生效说明：这一块最容易以为「要重启」，所以单独一行说出来。 */}
      {saved === ''
        ? null
        : (
          <div data-ewb-channel-saved="" className="mb-2 flex flex-none items-start gap-2 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2">
            <span className="min-w-0 flex-1 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-state-success-primary)]">{saved}</span>
          </div>
        )}

      {/* 表单：新建或编辑。 */}
      {!editing
        ? null
        : (
          <div data-ewb-channel-form="" className="mb-3 flex flex-none flex-col gap-1.5 rounded-card border border-[var(--dsw-alias-border-l2)] px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">
                {draft.id === '' ? '新建渠道' : '编辑 ' + draft.id}
              </span>
              <span className="flex-1" />
              <button
                type="button"
                data-ewb-channel-cancel=""
                className="pressable is-dark rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                onClick={() => { setEditing(false); setDraft(EMPTY_DRAFT) }}
              >取消</button>
              <button
                type="button"
                data-ewb-channel-save=""
                className="pressable is-dark rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-primary)]"
                onClick={() => { void save() }}
              >保存</button>
            </div>
            <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
              <span className="w-14 shrink-0">名称</span>
              <input data-ewb-channel-name="" className={field} value={draft.name} onChange={e => { setDraft(d => ({ ...d, name: e.target.value })) }} placeholder="如 本地 ComfyUI" />
            </label>
            <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
              <span className="w-14 shrink-0">协议</span>
              <select data-ewb-channel-protocol="" className={field} value={draft.protocol} onChange={e => { setDraft(d => ({ ...d, protocol: e.target.value })) }}>
                {PROTOCOLS.map(p => <option key={p.v} value={p.v}>{p.label}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
              <span className="w-14 shrink-0">接口地址</span>
              <input data-ewb-channel-baseurl="" className={field} value={draft.baseUrl} onChange={e => { setDraft(d => ({ ...d, baseUrl: e.target.value })) }} placeholder="如 http://127.0.0.1:8188" />
            </label>
            <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
              <span className="w-14 shrink-0">密钥</span>
              <input
                data-ewb-channel-apikey=""
                type="password"
                autoComplete="off"
                className={field}
                value={draft.apiKey}
                onChange={e => { setDraft(d => ({ ...d, apiKey: e.target.value })) }}
                placeholder={draft.id === '' ? '填了才会存；留空表示没有密钥' : '留空表示不改（已配置的不会因为留空被清掉）'}
              />
            </label>
            <label className="flex items-start gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
              <span className="w-14 shrink-0 pt-1">模型</span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <textarea
                  data-ewb-channel-models=""
                  className={field + ' min-h-[64px] resize-y'}
                  value={draft.modelsText}
                  onChange={e => { setDraft(d => ({ ...d, modelsText: e.target.value })) }}
                  placeholder={'一行一个，格式 模型id|显示名|能力,能力\n如 gpt-image-1|GPT Image 1|image'}
                />
                {/* ★ 「拉取模型」（P3 第 3 块，用户 m03414）。
                 *
                 * 用户原话：「配置中的新增渠道，连拉取模型都没有，你是在敷衍我吗？」
                 * 上游有哪些模型是**能问出来的**（后端 `/channels/:id/models`），
                 * 不该让用户照着别处手抄 id。
                 *
                 * ★ 2026-10-28（票 36）改了前置条件：**新建渠道时也能点**。
                 * 原来这里只有存过的渠道才显示按钮，新建时给一句「保存之后才能拉」——
                 * 于是「先存一次、密钥瞎填、存完才发现不对」成了唯一的路。
                 * 现在没保存时按钮照样在，弹窗走 `POST /channels/probe`，
                 * 拿**表单里这一份**地址与密钥去问一次，不落盘。 */}
                <button
                  type="button"
                  data-ewb-channel-fetch=""
                  className="pressable is-dark self-start rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                  onClick={() => { setFetchOpen(true) }}
                >{draft.id === '' ? '测连通并列出模型' : '拉取模型'}</button>
                {draft.id === ''
                  ? (
                    <span data-ewb-channel-fetch-hint="" className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                      用上面填的地址与密钥去问一次上游，不需要先保存这条渠道。
                    </span>
                  )
                  : null}
              </div>
            </label>
            <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
              <span className="w-14 shrink-0">并发</span>
              <input data-ewb-channel-concurrency="" className={field} type="number" min={1} max={50} value={draft.maxConcurrency} onChange={e => { setDraft(d => ({ ...d, maxConcurrency: e.target.value })) }} />
              <span className="shrink-0 text-[var(--dsw-alias-label-tertiary)]">最多同时几个</span>
            </label>

            {/* ── ComfyUI 专属：12 类工作流 + 代理（契约 CF，用户 m01076）──
             *
             * 只在这条渠道的协议是 `comfyui` 时出现。理由：工作流是 ComfyUI 的概念，
             * OpenAI 兼容与 Gemini 的渠道上出现「文生图用哪份工作流」只会让人困惑。 */}
            {draft.protocol !== 'comfyui'
              ? null
              : (
                <div data-ewb-channel-workflows="" className="mt-1 flex flex-col gap-1 border-t border-[var(--dsw-alias-border-l2)] pt-2">
                  <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">
                    工作流（每个类别一份，不选就用内置默认）
                  </span>
                  {WORKFLOW_CATEGORIES.map(cat => (
                    <label key={cat} className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
                      <span className="w-20 shrink-0">{CATEGORY_LABEL[cat]}</span>
                      <select
                        data-ewb-channel-workflow={cat}
                        className={field}
                        value={draft.workflows[cat] ?? ''}
                        onChange={e => { setDraft(d => ({ ...d, workflows: { ...d.workflows, [cat]: e.target.value } })) }}
                      >
                        {workflowOptions(cat).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </label>
                  ))}
                  <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
                    <span className="w-20 shrink-0">代理地址</span>
                    <input
                      data-ewb-channel-proxyurl=""
                      className={field}
                      value={draft.proxyUrl}
                      onChange={e => { setDraft(d => ({ ...d, proxyUrl: e.target.value })) }}
                      placeholder="可选：留空表示直连"
                    />
                  </label>
                  <label className="flex items-center gap-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
                    <span className="w-20 shrink-0">代理 token</span>
                    <input
                      data-ewb-channel-proxytoken=""
                      type="password"
                      autoComplete="off"
                      className={field}
                      value={draft.proxyToken}
                      onChange={e => { setDraft(d => ({ ...d, proxyToken: e.target.value })) }}
                      placeholder="与上面的地址配套，留空表示不带"
                    />
                  </label>
                </div>
              )}
          </div>
        )}

      <div className="flex min-h-0 flex-1 flex-col" data-ewb-channel-list="">
        {loading && rows.length === 0
          ? <div className="px-1 py-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">读取中…</div>
          : null}
        {!loading && shown.length === 0 && err === ''
          ? (
            <div data-ewb-channel-empty="" className="rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-5">
              <span className="font-mono text-ewb-meta text-[var(--dsw-alias-label-secondary)]">
                {onlyProtocol === undefined ? '还没有配渠道' : (onlyProtocol === 'comfyui' ? '还没有配 ComfyUI 渠道' : '还没有配这类渠道')}
              </span>
              <span className="mt-1 block font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
                {onlyProtocol === 'comfyui'
                  ? 'ComfyUI 渠道填本地地址（如 http://127.0.0.1:8188），12 类工作流各自绑一份，类型由工作流决定，不需要给模型标类型。'
                  : '生成要走渠道（OpenAI 兼容接口或 Gemini）。'}
              </span>
            </div>
          )
          : null}

        {shown.map(c => (
          <div
            key={c.id}
            data-ewb-channel-row={c.id}
            className="mb-1.5 rounded-card border border-[var(--dsw-alias-border-l2)] px-2.5 py-2"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)]" data-ewb-channel-title="">{c.name}</span>
              {/* ★ 「已配置 / 未配置」—— 只有布尔，没有明文。 */}
              <span
                data-ewb-channel-haskey={c.hasKey ? 'yes' : 'no'}
                className={[
                  'shrink-0 font-mono text-ewb-caption',
                  c.hasKey ? 'text-[var(--dsw-alias-state-success-primary)]' : 'text-[var(--dsw-alias-label-tertiary)]',
                ].join(' ')}
              >{keyText(c.hasKey)}</span>
              <button
                type="button"
                data-ewb-channel-test={c.id}
                className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                onClick={() => { void testOne(c.id) }}
              >{testing === c.id ? '测试中…' : '测试连接'}</button>
              <button
                type="button"
                data-ewb-channel-edit={c.id}
                className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                onClick={() => { edit(c) }}
              >编辑</button>
              <button
                type="button"
                data-ewb-channel-del={c.id}
                className="pressable is-dark shrink-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                onClick={() => { void remove(c) }}
              >删除</button>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
              <span data-ewb-channel-proto="">{protocolLabel(c.protocol)}</span>
              <span data-ewb-channel-addr="">{c.baseUrl}</span>
              <span data-ewb-channel-models-n="">{String(c.models.length)} 个模型</span>
              <span data-ewb-channel-conc="">并发 {String(c.maxConcurrency)}</span>
            </div>
            {/* ★ 「测试连接」的结论：成功绿色、失败红色。
             * 只有点过的那一条才有这块（没点过不该显示一个假结论）。 */}
            {tested[c.id] === undefined
              ? null
              : (
                <div
                  data-ewb-channel-testresult={c.id}
                  data-ok={tested[c.id].ok ? '' : undefined}
                  className={[
                    'mt-1 font-mono text-ewb-caption',
                    tested[c.id].ok ? 'text-[var(--dsw-alias-state-success-primary)]' : 'text-[var(--dsw-alias-state-error-primary)]',
                  ].join(' ')}
                >{tested[c.id].message}</div>
              )}
          </div>
        ))}
      </div>

      {/* ══ 四类默认模型已上收到工作台设置（票 38，2026-10-28）══
       *
       * 原来「存储目录 / 默认模型 / 提示词源」三块各自是配置页的一个 tab
       * （2026-10-27 票 10 的分法）。2026-10-28 起：
       *   · 四类默认模型 → 工作台设置（`DefaultsSettings.tsx`，挂在
       *     `WorkspaceSettings.tsx` 的 `data-ewb-content-defaults-section`）；
       *   · 存储目录 / 提示词源 / 偏好 → 仍留在内容板块的配置页。
       *
       * ⚠️ 别加回这里：同一个设置两处入口，改一边另边不生效时没人知道是哪边。 */}

      {/* 「拉取模型」弹窗（P3 第 3 块）。
       * 挂在这里而不是表单行内：antd 的 Modal 自己管显隐，
       * 挪进 `<label>` 里会让点击行为变得奇怪（label 会转发点击到第一个控件）。 */}
      <FetchModelsDialog
        open={fetchOpen}
        channelId={draft.id}
        protocol={draft.protocol}
        baseUrl={draft.baseUrl}
        apiKey={draft.apiKey}
        current={draft.modelsText}
        onAppend={(next) => { setDraft(d => ({ ...d, modelsText: next })) }}
        onClose={() => { setFetchOpen(false) }}
      />
    </div>
  )
}
