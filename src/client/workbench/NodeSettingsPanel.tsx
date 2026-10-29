/** 节点设置面板（契约 CD 第五节）。
 *
 * ## 照参考项目的做法
 *
 * `refs-projects/infinite-canvas/web/src/components/canvas/canvas-node-prompt-panel.tsx`（397 行）：
 * 面板挂在节点**下方**（`canvas-node.tsx:483` 的 `absolute left-1/2 top-full -translate-x-1/2`），
 * 按节点类型给不同的字段。
 *
 * ## 我们换掉了什么
 *
 * | 参考项目 | 这里 | 为什么 |
 * |---|---|---|
 * | antd `Select` / `Slider` / `Modal` | 原生 `<select>` / `<input>` / 一段浮层 | 项目没引 antd |
 * | 一整套图像工具（裁剪、蒙版、放大、修复…） | **未做** | 那是图片编辑，不属于本单；工具条上没有入口 |
 * | `i18n` 文案 | 中文常量 | 项目本来就是中文界面 |
 *
 * ## 字段按类型分（用户 m01076 的要求）
 *
 * | 类型 | 字段 |
 * |---|---|
 * | 文本 | 提示词 + 模型 + 生成 |
 * | 图片 | 提示词 + 尺寸 + 张数 + 参考图 + 生成 |
 * | 视频 | 提示词 + 时长 + 分辨率 + 首帧 + 生成 |
 * | 音频 | 提示词 + 时长 + 生成 |
 * | 配置 | 用它自己节点上的那几个字段（这里只给提示词与生成） |
 *
 * ## ⚠️ 「编辑文本 = 改输出」在这块面板里不出现
 *
 * 文本节点的**正文**是它的产出，在节点本体上双击编辑（`content-nodes.tsx`）。
 * 这里那块「提示词」是**输入**，写进 `data.prompt` —— 两者分开才不会
 * 「改一次输出把要发给模型的提示词也改了」。
 */
import { useState } from 'react'
import { CONTENT_SIZES } from './content-nodes.tsx'
import {
  describeReference, withReference, filterMentions, mentionQueryAt, mentionTokenOf,
  type MentionCandidate,
  type ContentNodeData, type ContentNodeType, type GenModelOption, type RefChoice,
} from './content-canvas-store.ts'
/* 类型的中文名**只有一份**（宿主半 `model-types.ts`）。界面另写一份会漂 ——
 * 这个仓库为「生视频 / 文生视频」已经漂过一次（票 67）。 */
import { MODEL_TYPE_LABEL } from '../../schedule/model-types.ts'
import css from './EcomWorkbench.module.css'

/** 没有候选时用一个空数组常量（避免每次渲染新建一个，纯为省一点重渲染）。 */
const EMPTY_CHOICES: readonly RefChoice[] = []

/** 面板要的数据。 */
/**
 * 模型名字后面那个类型后缀（票 70）：`· 文生图`、`· 文生图 / 图生图`、`· 文生视频`。
 *
 * ## 为什么要标
 *
 * 图片那一档**同时列了文生图与图生图两类**（节点上没有静态字段能提前判断这次
 * 带不带参考图，见 `ContentCanvas` 的 `typesOf`）。不标的话用户看到一个清单，
 * 挑了一个只会文生图的模型去做图生图 —— 到生成那一刻才失败。
 *
 * ## 一个类型都没有时
 *
 * 回空串（不加后缀）。那种模型是「上游没说它能干什么」，标一个假的类型
 * 比不标更糟。`caps` 空的模型提交时会被后端拦下并说清，那比这里编一个类型好。
 *
 * @param m - 一条模型。
 * @returns 后缀（可能为空串）。
 */
function typeSuffix(m: GenModelOption): string {
  const types = Array.isArray(m.types) ? m.types : []
  if (types.length === 0) return ''
  const label = types.map(t => (MODEL_TYPE_LABEL as Record<string, string>)[t] ?? t).join(' / ')
  return ' · ' + label
}

export interface NodeSettingsPanelProps {
  /** 节点 id。 */
  id: string
  /** 节点类型。 */
  type: ContentNodeType
  /** 当前数据。 */
  data: ContentNodeData
  /** 改一项。 */
  onChange: (patch: ContentNodeData) => void
  /** 点生成。 */
  onGenerate: () => void
  /** 收起面板。 */
  onClose: () => void
  /**
   * 现在能不能点生成。
   *
   * ⚠️ 它是**查出来的**，不是常量（契约 CH 改的）：挂载时问一次
   * `GET /gen-models?kind=…`，拿到非空清单才为真。
   */
  canGenerate: boolean
  /**
   * 不能生成时**为什么**（契约 CH 验收 1：「回空 → 按钮禁用且文案说清为什么」）。
   *
   * 只说「未接通」不够 —— 用户分不清「没配渠道」「模型没这个能力」「还没查回来」
   * 三种完全不同的下一步。
   */
  generateHint: string
  /** 能用的模型（`GET /gen-models` 查回来的；空数组时模型那一格退回手填）。 */
  models: readonly GenModelOption[]
  /**
   * 按类型一条都没筛到时的那句说明（票 70）。
   *
   * ## 为什么这行必须有
   *
   * `ContentCanvas` 的兜底是「一条都不匹配 → 回全部」，理由是藏起来会让人以为
   * 配错了。但**不说的话**用户看到一列包含视频模型的清单，只会以为过滤坏了 ——
   * 而不是「这一类没有登记任何模型」。
   *
   * 空串 = 正常过滤，这行不出现（有断言钉住）。
   */
  modelsFallbackNote?: string
  /**
   * 可以当参考图的东西（素材库 + 画布上已有产物的节点，契约 CJ）。
   *
   * ⚠️ 它是**外部给的**，不是面板自己去拉：拉素材要用 `fetch`，
   * 而面板是纯展示层（这个文件从不发请求，`tests` 里有一条断言钉这件事）。
   */
  refChoices?: readonly RefChoice[]
  /**
   * 点「选择参考图」时通知外面去加载候选（第一次点才拉，不在挂载时拉 ——
   * 每开一次面板就打一次 `/materials` 是白花）。
   */
  onLoadRefChoices?: () => void
  /**
   * 能被 @ 的节点（用户 m02814 #76）。
   *
   * 由画布传进来（它知道自己有哪些节点）；面板只管「按输入筛 + 插进去」。
   */
  mentionCandidates?: readonly MentionCandidate[]
}

/** 视频常见分辨率。 */
const RESOLUTIONS: readonly string[] = ['1080x1920', '1920x1080', '1024x1024', '720x1280']

/**
 * 这一块面板该显示哪些字段（**纯函数**，方便断言）。
 * @param type - 节点类型。
 * @returns 字段 id 数组。
 */
export function panelFields(type: ContentNodeType): string[] {
  if (type === 'text') return ['prompt', 'model', 'generate']
  /* ⚠️ 2026-10-26 契约 CH 补上 `model`：图片 / 视频 / 音频三类节点**本来就要指定模型**
   * （`data.model` 一直存在、提交生成时也要带走），但面板此前没有这一格 ——
   * 结果是用户只能手改存档才能换模型。生成真接上之后这条必须补，
   * 否则每个节点都会用空模型去提交，被后端一句「要指定模型」拒掉。 */
  if (type === 'image') return ['prompt', 'model', 'size', 'count', 'reference', 'generate']
  if (type === 'video') return ['prompt', 'model', 'seconds', 'resolution', 'reference', 'generate']
  if (type === 'audio') return ['prompt', 'model', 'seconds', 'generate']
  if (type === 'group') return []
  return ['prompt', 'model', 'generate']
}

/**
 * 节点设置面板。
 * @param props - 见 `NodeSettingsPanelProps`。
 * @returns 面板。
 */
export function NodeSettingsPanel(props: NodeSettingsPanelProps): React.JSX.Element {
  const { id, type, data } = props
  const fields = panelFields(type)
  const has = (f: string): boolean => fields.includes(f)
  const patch = (p: ContentNodeData): void => { props.onChange(p) }
  /** 「选择参考图」的浮层开没开（点了才拉候选，见 `onLoadRefChoices`）。 */
  const [refOpen, setRefOpen] = useState(false)
  /** @ 提及下拉当前覆盖的那一段（`null` = 没在提及）。 */
  const [mentionAt, setMentionAt] = useState<{ from: number, to: number, query: string } | null>(null)
  /**
   * 把一个候选插进提示词（替换 `@query` 那一段）。
   * @param c - 选中的候选。
   */
  const insertMention = (c: MentionCandidate): void => {
    if (mentionAt === null) return
    const cur = data.prompt ?? ''
    const next = cur.slice(0, mentionAt.from) + mentionTokenOf(c) + cur.slice(mentionAt.to)
    props.onChange({ prompt: next })
    setMentionAt(null)
  }
  const refChoices = props.refChoices ?? EMPTY_CHOICES
  /** 当前已选的那个（把它显示成缩略图 + 名字，而不是那串地址）。 */
  const pickedRef = (data.reference ?? '') === ''
    ? null
    : describeReference(data.reference as string, refChoices)

  return (
    <div className={css.nodePanel} data-ewb-node-panel={id} onPointerDown={e => { e.stopPropagation() }}>
      <div className={css.nodePanelHead}>
        <span className={css.nodePanelTitle}>设置</span>
        <span className="flex-1" />
        <button
          type="button"
          data-ewb-node-panel-close=""
          className={css.nodePanelBtn}
          onClick={props.onClose}
        >收起</button>
      </div>

      {has('prompt')
        ? (
          <div className={css.nodePanelRow}>
            <span className={css.nodePanelKey}>提示词</span>
            <div className={css.mentionWrap}>
              <textarea
                className={css.nodePanelArea + ' nodrag nowheel'}
                data-ewb-node-prompt=""
                value={data.prompt ?? ''}
                placeholder="写清楚要生成什么；打 @ 可以引用画布上别的节点"
                onChange={(e) => {
                  patch({ prompt: e.target.value })
                  /* ★ @ 提及（用户 m02814 #76）：打完字就看光标前是不是一个 @ 开头。
                   * `selectionStart` 在受控 textarea 里是同步可读的。 */
                  setMentionAt(mentionQueryAt(e.target.value, e.target.selectionStart ?? 0))
                }}
                onKeyDown={(e) => {
                  /* ⚠️ 提及下拉开着时，上/下/回车/Tab 归下拉；Esc 关掉。
                   * 其余一律 `stopPropagation` —— 否则画布的九个快捷键会吃掉按键。 */
                  if (mentionAt !== null) {
                    if (e.key === 'Escape') { e.stopPropagation(); setMentionAt(null); return }
                    if (e.key === 'Enter' || e.key === 'Tab') {
                      const first = props.mentionCandidates === undefined
                        ? undefined
                        : filterMentions(props.mentionCandidates, mentionAt.query)[0]
                      if (first !== undefined) {
                        e.preventDefault()
                        e.stopPropagation()
                        insertMention(first)
                        return
                      }
                    }
                  }
                  e.stopPropagation()
                }}
                onBlur={() => { setMentionAt(null) }}
              />
              {mentionAt === null || props.mentionCandidates === undefined
                ? null
                : (() => {
                  const list = filterMentions(props.mentionCandidates, mentionAt.query)
                  return (
                    <div className={css.mentionList} data-ewb-mention-list="">
                      {list.length === 0
                        ? <span className={css.nodePanelHint}>画布上没有能引用的节点</span>
                        : list.map(c => (
                          <button
                            key={c.id}
                            type="button"
                            data-ewb-mention-item={c.id}
                            className={css.mentionItem + ' nodrag'}
                            /* `onMouseDown` 而不是 `onClick`：点下去时 textarea 还没失焦，
                             * `selectionStart` 还读得到 —— 用 click 的话已经被 `onBlur` 清掉了。 */
                            onMouseDown={(e) => { e.preventDefault(); insertMention(c) }}
                          >{c.name}</button>
                        ))}
                    </div>
                  )
                })()}
            </div>
          </div>
        )
        : null}

      {has('model') && (props.modelsFallbackNote ?? '') !== ''
        ? <div className={css.nodePanelHint} data-ewb-node-model-note="">{props.modelsFallbackNote}</div>
        : null}
      {has('model')
        ? (
          <label className={css.nodePanelRow}>
            <span className={css.nodePanelKey}>模型</span>
            {/* 有清单时给下拉（契约 CH）—— 手打模型 id 极易打错，而后端会直接
                报「这个渠道里没有模型 xxx」。没有清单时退回手填（老画布那样）。 */}
            {props.models.length === 0
              ? (
                <input
                  className={css.nodePanelInput + ' nodrag'}
                  data-ewb-node-model=""
                  value={data.model ?? ''}
                  placeholder="如 gpt-image-1"
                  onChange={(e) => { patch({ model: e.target.value }) }}
                  onKeyDown={(e) => { e.stopPropagation() }}
                />
              )
              : (
                <select
                  className={css.nodePanelInput + ' nodrag'}
                  data-ewb-node-model=""
                  value={data.model ?? ''}
                  onChange={(e) => {
                    /* 模型与渠道是一对：选了模型就把它的渠道一起记上，
                     * 否则提交时会去「随便挑一个渠道」，可能挑到不能做这件事的。 */
                    const hit = props.models.find(m => m.modelId === e.target.value)
                    patch({ model: e.target.value, ...hit === undefined ? {} : { channel: hit.channelId } })
                  }}
                  onKeyDown={(e) => { e.stopPropagation() }}
                >
                  <option value="">选一个模型</option>
                  {props.models.map(m => (
                    <option key={m.channelId + '/' + m.modelId} value={m.modelId}>
                      {m.modelLabel + '（' + m.channelName + '）' + typeSuffix(m)}
                    </option>
                  ))}
                </select>
              )}
          </label>
        )
        : null}

      {has('size')
        ? (
          <label className={css.nodePanelRow}>
            <span className={css.nodePanelKey}>尺寸</span>
            <select
              className={css.nodePanelInput + ' nodrag'}
              data-ewb-node-size=""
              value={data.size ?? CONTENT_SIZES[0]}
              onChange={(e) => { patch({ size: e.target.value }) }}
            >
              {CONTENT_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        )
        : null}

      {has('count')
        ? (
          <label className={css.nodePanelRow}>
            <span className={css.nodePanelKey}>张数</span>
            <input
              className={css.nodePanelInput + ' nodrag'}
              data-ewb-node-count=""
              type="number"
              min={1}
              max={8}
              value={String(data.count ?? 1)}
              onChange={(e) => { patch({ count: Number(e.target.value) || 1 }) }}
            />
          </label>
        )
        : null}

      {has('seconds')
        ? (
          <label className={css.nodePanelRow}>
            <span className={css.nodePanelKey}>时长</span>
            <input
              className={css.nodePanelInput + ' nodrag'}
              data-ewb-node-seconds=""
              type="number"
              min={1}
              max={300}
              value={String(data.seconds ?? 5)}
              onChange={(e) => { patch({ seconds: Number(e.target.value) || 5 }) }}
            />
            <span className={css.nodePanelUnit}>秒</span>
          </label>
        )
        : null}

      {has('resolution')
        ? (
          <label className={css.nodePanelRow}>
            <span className={css.nodePanelKey}>分辨率</span>
            <select
              className={css.nodePanelInput + ' nodrag'}
              data-ewb-node-resolution=""
              value={data.resolution ?? RESOLUTIONS[0]}
              onChange={(e) => { patch({ resolution: e.target.value }) }}
            >
              {RESOLUTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
        )
        : null}

      {has('reference')
        ? (
          /* 参考图 / 首帧（契约 CJ 重做）。
           *
           * ## 原来是什么、为什么不行
           *
           * 原来是一个 `<input placeholder="产物 id（留空表示不用）">`，让用户
           * **手填产物 id**。而产物 id 是 `art-xxxx` 这种，用户在界面上见过它的次数是 0 ——
           * 校核报告原话：「用户根本不知道自己那张图的 id 是什么」。
           * 那是**看着有、实际用不了**的字段。
           *
           * ## 现在怎么用
           *
           * 一个按钮打开列表 → 从「素材库」或「画布上已有产物的节点」里挑一张 →
           * 显示缩略图 + 名字 → 可以移除。
           *
           * ⚠️ **`data.reference` 存什么没变**（`withReference` 里写的就是候选的 `id`）：
           * 存档形状一个字节都不动，老存档照读。
           */
          <div className={css.nodePanelRow} data-ewb-node-reference-row="">
            <span className={css.nodePanelKey}>{type === 'video' ? '首帧' : '参考图'}</span>
            <div className={css.nodePanelRefBox} data-ewb-node-reference="">
              {pickedRef === null
                ? (
                  <button
                    type="button"
                    data-ewb-node-ref-pick=""
                    className={css.nodePanelBtn + ' nodrag'}
                    onClick={() => {
                      props.onLoadRefChoices?.()
                      setRefOpen(v => !v)
                    }}
                  >选择参考图</button>
                )
                : (
                  <>
                    {pickedRef.url === ''
                      ? null
                      : <img className={css.nodePanelRefThumb} data-ewb-node-ref-thumb="" src={pickedRef.url} alt="" draggable={false} />}
                    <span className={css.nodePanelRefName} data-ewb-node-ref-name="">{pickedRef.name}</span>
                    <button
                      type="button"
                      data-ewb-node-ref-clear=""
                      className={css.nodePanelBtn + ' nodrag'}
                      title="移除参考图"
                      onClick={() => {
                        props.onChange(withReference(data, null))
                        setRefOpen(false)
                      }}
                    >移除</button>
                  </>
                )}
            </div>
          </div>
        )
        : null}

      {has('reference') && refOpen
        ? (
          <div className={css.nodePanelRefList} data-ewb-node-ref-list="">
            {refChoices.length === 0
              ? <span className={css.nodePanelHint}>素材库是空的，画布上也没有带产物的图 / 视频</span>
              : refChoices.map(c => (
                <button
                  key={c.from + ':' + c.id}
                  type="button"
                  data-ewb-node-ref-item={c.id}
                  className={css.nodePanelRefItem + ' nodrag'}
                  title={c.name}
                  onClick={() => {
                    /* 这里**只**写 reference —— 名称、地址都不进存档（`id` 才是要存的那份）。 */
                    props.onChange(withReference(data, c))
                    setRefOpen(false)
                  }}
                >
                  <img className={css.nodePanelRefItemThumb} src={c.url} alt="" draggable={false} />
                  <span className={css.nodePanelRefItemName}>{c.name}</span>
                  <span className={css.nodePanelRefItemFrom}>{c.from === 'material' ? '素材' : '画布'}</span>
                </button>
              ))}
          </div>
        )
        : null}

      {has('generate')
        ? (
          <div className={css.nodePanelRow}>
            {/* 不能生成时把原因写出来（验收 1：文案要说清为什么）。
                「未接通」这种笼统说法分不出「没配渠道」与「还没查回来」。 */}
            {props.canGenerate
              ? <span className="flex-1" />
              : (
                <span className={css.nodePanelHint} data-ewb-generate-hint="">
                  {props.generateHint}
                </span>
              )}
            <button
              type="button"
              data-ewb-node-generate=""
              data-enabled={props.canGenerate ? '' : undefined}
              disabled={!props.canGenerate}
              className={css.nodePanelPrimary + (props.canGenerate ? '' : ' opacity-45 cursor-not-allowed')}
              title={props.canGenerate ? '按当前设置生成' : props.generateHint}
              onClick={() => { props.onGenerate() }}
            >{props.canGenerate ? '生成' : '生成（不可用）'}</button>
          </div>
        )
        : null}
    </div>
  )
}
