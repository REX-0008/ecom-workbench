/** 运行历史面板（2026-10-17 重做：按工作流分组 + 「整次运行」层）。
 *
 * ## 用户定的是什么（m03287 / m03330）
 *
 * 原话：「运行历史应该根据工作流做分组，可以回看是哪个工作流」；确认走「乙」——
 * **再加一层「整次运行」**，点开才看下面每个节点的明细；同时「甲」的分层也要兼顾：
 * 节点明细**以该节点的备注名称、编号为标题**。
 *
 * ## 与旧的差别（旧的那版为什么不够）
 *
 * 旧版读的是 `/api/ecom-workbench/runs` —— 那是**节点级**的执行记录（一行一个节点）。
 * 跑一次工作流在列表里散成十几行，看不出「哪一次是整份工作流跑的、成没成、产出什么」。
 * 现在：**左侧按工作流分组**，每个工作流下面是一次次运行；点开一次运行才看节点明细。
 *
 * ## 「运行历史」与「运行时输出」的分工（用户 m03330 要我确认的那条）
 *
 *   · **运行历史（本页）** = 全量：时间、成没成、跑了几个节点、每个节点的成败与日志。回看用。
 *   · **运行时输出** = 结束节点声明的产出，像 bat 窗口最后那几行。
 *     ⚠️ **它不在这页里**（用户 m03841 纠正过我一次：结束节点发的是「结束节点」的范畴，
 *     与运行历史无关）。它出现在两处：跑的时候在 `FlowRunPanel` 里滚出来，
 *     跑完之后如果要回看，那是**工作流管理**里的事，不是运行历史。
 *
 * 两条都从同一次运行提取，但**不共用一份数据结构** —— 硬合会让两边都别扭。
 *
 * ## 三条不静默（沿用旧版一贯的规矩）
 *
 *   · 引擎没连上 → 说清「读不到」，不是空白；
 *   · 没有记录 → 说「还没跑过」，并给出「去哪跑」；
 *   · 某份工作流的记录读坏了 → 说清是哪一份，其余照常显示。
 */
import { useCallback, useEffect, useState } from 'react'
import css from './EcomWorkbench.module.css'
import { cancelPausedRun, listPausedRuns, resumePausedRun, type PausedRunItem } from './dispatch-client.ts'
/* ★ 模型痕迹（2026-10-23 契约 W）。
 *
 * ## 为什么从这里 import，而不是在界面里拼字符串
 *
 * `formatTraceLine` 的注释写得很明确：「界面直接调它，别在界面里重新拼字符串」。
 * 理由是那一行的拼法（哪几段留、用什么分隔、缺字段怎么办）是**规则**，
 * 规则只该有一份。界面各处自己拼，改一次文案就要翻好几处，必然有人漏 ——
 * 那就成了「历史面板写着『出错』、别处写着『失败』」这种认不出是同一件事的状态。
 *
 * ⚠️ `llm-trace.ts` 本身**不 import 任何东西**（连 `node:` 都不引），就是为界面准备的。
 * 同理 `workflow-runs.ts` 带 Node 内置模块，**只能 import type**、绝不能 import 值。 */
import { formatTraceLine, type LlmTrace } from '../../dispatch/llm-trace.ts'

/* ── 汇报（2026-10-25 契约 AO）────────────────────────────────────
 *
 * `ReportEntry` 住在 `workflow/model.ts:211`（引擎已落地）。那份文件的注释写明
 * 「这个文件**不 import 任何东西**（纯类型与纯数据），所以客户端能引」——
 * 正是为界面准备的，所以这里直接引用，**不另写一份同形的局部类型**。
 *
 * ⚠️ 只能 `import type`：`workflow/` 下的模块有带 Node 内置模块的，
 * 引值会把面板拖进宿主半的依赖里。
 */
import type { HintLevel, ReportEntry } from '../../workflow/model.ts'

/** 一条节点级明细（与宿主半 `workflow-runs.ts` 的 `RunNodeLine` 同形）。 */
interface NodeLine {
  nodeId: string
  defId?: string
  label?: string
  state: string
  startedAt?: number
  endedAt?: number
  error?: string
  logs?: string[]
  /** ★ 这次调用模型留下的痕迹（没调模型就没有这个键）。 */
  llm?: LlmTrace
  /** ★ 这次运行里这个节点汇报了什么（没汇报就没有这个键）。 */
  reports?: ReportEntry[]
}

/** 一次「整份工作流」的运行（与宿主半的 `WorkflowRun` 同形）。 */
interface RunItem {
  id: string
  name: string
  startedAt: number
  endedAt?: number
  ok: boolean
  aborted?: boolean
  error?: string
  ran?: string[]
  /** ★ 关键信息：结束节点声明的产出。 */
  outputs?: Record<string, unknown>
  inputs?: Record<string, unknown>
  nodes?: NodeLine[]
  via?: string
}

/** 节点结局 → 中文与配色键。
 *
 * ## 三个「没跑成」必须分开说（2026-10-23 契约 AC）
 *
 * 用户原话：「报错了，但是后续还在执行。」—— 实际没继续执行。
 * 问题在**显示**：一开跑就把每个节点标成「排队中」，某个节点失败中断后
 * 没人把那些「排队中」撤掉，看着像还在跑。
 *
 * | 状态 | 显示 | 意思 | 为什么不能合并 |
 * | --- | --- | --- | --- |
 * | `failed` | 失败（红） | **跑了，出错** | 这是要人去查的 |
 * | `cancelled` | **未执行**（灰） | **因为前面中断，它根本没跑** | 标红会让人去查一个没出错的节点 |
 * | `skipped` | 跳过（灰） | **按配置主动跳过**（用户标的、或分支没走） | 是正常行为，不是被中断 |
 *
 * `cancelled` 用 `tone: 'idle'`（灰）而不是 `error`：它不是失败。
 *
 * ⚠️ **加这一条之前，`cancelled` 会落到下面那个 `?? { text: n.state }` 兜底，
 * 界面上露出英文 `cancelled`** —— 中文界面里冒英文，等于没写文案。 */
const STATE_LABEL: Record<string, { text: string, tone: string }> = {
  idle: { text: '已停止', tone: 'idle' },
  queued: { text: '排队', tone: 'queued' },
  running: { text: '运行中', tone: 'running' },
  success: { text: '成功', tone: 'ok' },
  failed: { text: '失败', tone: 'error' },
  skipped: { text: '跳过', tone: 'idle' },
  /* 中断后**没跑过**的节点。不是失败（标红会误导人去查一个没出错的节点）。 */
  cancelled: { text: '未执行', tone: 'idle' },
}

/**
 * 毫秒 → 本地时间文字（带日期，因为历史跨天）。
 * @param ms - 毫秒时间戳。
 * @returns 如 `10-17 14:03`。
 */
function fmtWhen(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/**
 * 毫秒 → 时长文字。
 * @param ms - 毫秒。
 * @returns 如 `1.2 秒` / `340 毫秒`。
 */
function fmtDuration(ms: number): string {
  if (ms < 1000) return String(Math.round(ms)) + ' 毫秒'
  return (ms / 1000).toFixed(1) + ' 秒'
}

/**
 * 节点明细该叫什么（用户 m03387：「以哪个节点的备注名称、编号为标题」）。
 *
 * 规则：**有实例名就用实例名 + 编号**（如「⑤ 取报表名单（n7）」），
 * 没有实例名就用节点类型 id + 编号（如「code.js（n7）」）——
 * 反正**编号一定要在**，否则同一类型有多个实例时认不出是哪个。
 *
 * @param n - 节点明细。
 * @returns 标题。
 */
/**
 * 一次运行是**从哪条路发起**的（`via`）→ 给人看的说法。
 *
 * 为什么显示它：2026-10-18 用户报「跑一个会出现多个」，根因是列表页同时发了
 * POST 与 SSE **两条跑路**（各自都真的跑一遍）。修掉之后 `via` 只剩 `stream`；
 * 留着这个标签是为了下次再出现「跑了两遍」时，一眼能看出多出来的是哪条路。
 *
 * @param via - 宿主半记的来源（`stream` / `list` / `sub`）。
 * @returns 短标签（空串 = 不显示）。
 */
function viaLabel(via: string | undefined): string {
  if (via === 'list') return '列表'
  if (via === 'stream') return '边跑边看'
  if (via === 'sub') return '被别的流程调用'
  return ''
}

/**
 * 节点明细该叫什么。
 *
 * 用户 m03635（原话）：「步骤 n 后面不是应该有数字么，现在是没有的」。
 *
 * ## 为什么会「没有数字」
 *
 * 原来标题用的是**节点实例 id**（`n1` / `n7`）。手搓或生成的工作流里 id 确实是 `n1` 起，
 * 但也有 `n-gen` / `n-filter` / `n-wait` 这种——**没有数字**，于是看起来像「步骤 n」后面断了。
 * 节点 id 是程序造的内部名，不该要求它带序号。
 *
 * ## 现在怎么给
 *
 * **序号由这里自己数**（`order`，从 1 起，按记录顺序 = 执行顺序）：
 *   有实例备注名 → `① 步骤 3 · 算时间（n1）`
 *   没有备注名   → `步骤 3 · code.js（n-gen）`
 * 序号永远在，编号（`n1`）也永远在——前者是「第几步」，后者是「画布上哪个节点」。
 *
 * @param n - 节点明细。
 * @param order - 第几步（1 起）。
 * @returns 标题。
 */
function nodeTitle(n: NodeLine, order: number): string {
  const name = n.label !== undefined && n.label !== '' ? n.label : (n.defId ?? '节点')
  return '步骤 ' + String(order) + ' · ' + name + '（' + n.nodeId + '）'
}

/**
 * 一个值 → 一行可读的文本（产出区用）。
 * @param v - 任意值。
 * @returns 短文本（对象走 JSON）。
 */
function brief(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return '—'
  try {
    const s = JSON.stringify(v)
    return s.length > 160 ? s.slice(0, 160) + '…' : s
  } catch {
    return String(v)
  }
}

/**
 * 模型痕迹那一块：一行摘要 + 两个可展开的原文摘要。
 *
 * ## 三条纪律
 *
 * ① **那一行必须整段来自 `formatTraceLine`**，界面不拼任何一段。这里唯一加的东西
 *    是一个前缀标签，且那个标签不参与那句文字（分开渲染成两个元素）。
 * ② **`truncated` 为真时给一条可见提示**（`formatTraceLine` 已在行末写
 *    「（摘要已截断）」，但那是文字里的；这里再加一个明确的标记元素，
 *    让「这段不是全文」这件事一眼看得见）。
 * ③ **两个摘要各自折叠**，默认收起。它们是原文片段（各最多 500 字），
 *    默认铺开会让节点明细长得没法扫。
 *
 * @param props.trace - 一份模型痕迹。
 * @returns 痕迹块元素。
 */
function LlmTraceBlock({ trace }: { trace: LlmTrace }) {
  const [openPrompt, setOpenPrompt] = useState(false)
  const [openOutput, setOpenOutput] = useState(false)
  const hasPrompt = trace.promptPreview !== undefined && trace.promptPreview !== ''
  const hasOutput = trace.outputPreview !== undefined && trace.outputPreview !== ''
  const truncated = trace.truncated === true

  return (
    <div className={css.histBlock} data-ewb-llm-trace="">
      <div className={css.histBlockTitle}>
        模型调用
        {truncated && (
          <span className={css.histMeta} data-ewb-llm-truncated=""> · 摘要已截断</span>
        )}
      </div>
      {/* 那一行直接用现成的 `histPre`（等宽、暗底、可换行）——
       * 它是机器生成的一行，不该与手写说明混在一起。 */}
      <div className={css.histPre} data-ewb-llm-line="">
        {formatTraceLine(trace)}
      </div>

      {hasPrompt && (
        <div className={css.histBlock}>
          <button
            type="button"
            className={css.histBtn}
            data-ewb-llm-preview="prompt"
            aria-expanded={openPrompt}
            onClick={() => { setOpenPrompt(v => !v) }}
          >{openPrompt ? '收起提示词摘要' : '展开提示词摘要'}</button>
          {openPrompt && (
            <pre className={css.histPre} data-ewb-llm-prompt="">{trace.promptPreview}</pre>
          )}
        </div>
      )}

      {hasOutput && (
        <div className={css.histBlock}>
          <button
            type="button"
            className={css.histBtn}
            data-ewb-llm-preview="output"
            aria-expanded={openOutput}
            onClick={() => { setOpenOutput(v => !v) }}
          >{openOutput ? '收起回答摘要' : '展开回答摘要'}</button>
          {openOutput && (
            <pre className={css.histPre} data-ewb-llm-output="">{trace.outputPreview}</pre>
          )}
        </div>
      )}
    </div>
  )
}

/* ── 汇报的**显示期**整理：去重 + 同类折叠（2026-10-25 契约 AO）──────
 *
 * ## ⚠️ 先分清两件事
 *
 * | | 谁做 | 做什么 |
 * | --- | --- | --- |
 * | **记录层** | 引擎 | **全留**，一条不改、一条不并 |
 * | **显示层** | 这里 | 去重 + 折叠，只为「读得下去」 |
 *
 * 这个区分是契约明确要求的：「记录层不去重（引擎那边全留）；去重只发生在显示时」。
 * 所以下面这些函数**只读不改** —— 不动 `reports` 数组本身，返回的是新结构。
 */

/** 级别轻重（折叠时取最重的那一条）。 */
const TYPE_WEIGHT: Record<HintLevel, number> = { info: 0, warning: 1, danger: 2 }

/** 一条整理后的汇报（显示用）。 */
interface ShownReport {
  /** 用于 React key。 */
  key: string
  type: HintLevel
  /** 主句。折叠行里是 `summary`（`{count}` 已替换）。 */
  message: string
  /** 位置（有就显示）。 */
  location?: string
  /** 逐条进度（有就显示在最前）。 */
  item?: string
  /** 数值指标。 */
  metrics?: [string, string][]
  /** 文件路径。 */
  files?: readonly string[]
  /** 完全相同的那几条有几份（1 = 只出现一次，不显示「出现 N 次」）。 */
  times: number
}

/** 一条汇报的去重 key（照 n8n：message + type + location + group + item 全拼）。 */
function reportKey(r: ReportEntry): string {
  return [
    r.message,
    r.type ?? '',
    r.location ?? '',
    r.group === undefined ? '' : r.group.key,
    r.item ?? '',
  ].join('\u0000')
}

/** 值 → 一行短文本（指标用）。 */
function metricText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return '—'
  try {
    return typeof v === 'object' ? JSON.stringify(v) : String(v)
  } catch {
    return String(v)
  }
}

/**
 * 把一堆汇报整理成「能读的几行」。
 *
 * ## 三步（顺序不能换）
 *
 * ① **完全相同去重**：key 一样的并成一条，记 `times`；
 * ② **同类折叠**：有 `group` 且 `group.summary` 非空、且组内**多于一条** 才折，
 *    级别取组内**最重**；
 * ③ 其余原样。
 *
 * ⚠️ 「只有一条时不折叠」是契约明写的 —— 一条也折，用户就得多点一下才看到内容，
 * 那是净损失。
 *
 * @param reports - 原始汇报（引擎写的，可能带重复）。
 * @returns 显示用的行（已去重、已折叠）。
 */
function foldReports(reports: readonly ReportEntry[]): ShownReport[] {
  /* ① 去重（保持首次出现顺序 —— 用户读的是「发生顺序」，不是字母序）。 */
  const uniq: { entry: ReportEntry, times: number }[] = []
  const seen = new Map<string, number>()
  for (const r of reports) {
    const k = reportKey(r)
    const at = seen.get(k)
    if (at !== undefined) {
      uniq[at] = { entry: uniq[at].entry, times: uniq[at].times + 1 }
      continue
    }
    seen.set(k, uniq.length)
    uniq.push({ entry: r, times: 1 })
  }

  /* ② 分组：只有「有 key 且有非空 summary」的才进组。 */
  type Bucket = { summary: string, worst: HintLevel, count: number }
  const buckets = new Map<string, Bucket>()
  for (const { entry, times } of uniq) {
    const g = entry.group
    if (g === undefined || g.summary === '') continue
    const t: HintLevel = entry.type ?? 'info'
    const b = buckets.get(g.key)
    if (b === undefined) {
      buckets.set(g.key, { summary: g.summary, worst: t, count: times })
      continue
    }
    b.count += times
    if (TYPE_WEIGHT[t] > TYPE_WEIGHT[b.worst]) b.worst = t
  }

  /* ③ 输出：折叠行插在组内**第一条**的位置，组内其余条目丢掉。
   *    「只有一条」的组不折（那个 bucket.count 会是 1）。 */
  const emittedGroup = new Set<string>()
  const out: ShownReport[] = []
  for (const { entry, times } of uniq) {
    const g = entry.group
    const foldable = g !== undefined && g.summary !== ''
      && (buckets.get(g.key)?.count ?? 0) > 1
    if (foldable && g !== undefined) {
      if (emittedGroup.has(g.key)) continue
      emittedGroup.add(g.key)
      const b = buckets.get(g.key)
      if (b === undefined) continue
      out.push({
        key: 'g:' + g.key,
        type: b.worst,
        /* `{count}` 换成组内条数（照 n8n 的 summary 模板）。没有占位符就原样。 */
        message: b.summary.replace(/\{count\}/g, String(b.count)),
        times: 1,
      })
      continue
    }
    const metrics = entry.metrics === undefined
      ? undefined
      : Object.entries(entry.metrics).map(([k, v]): [string, string] => [k, metricText(v)])
    out.push({
      key: 'r:' + reportKey(entry),
      type: entry.type ?? 'info',
      message: entry.message,
      /* `location` 是枚举（'ndv' / 'outputPane' / 'inputPane'），不是自由文本 ——
       * 直接显示 `ndv` 没人看得懂，走 `locationLabel` 换成中文。 */
      ...entry.location === undefined ? {} : { location: locationLabel(entry.location) },
      /* `item` 是**一句话**（如「第 3/5 条」），引擎那边已经拼好了，直接显示。 */
      ...entry.item === undefined || entry.item === '' ? {} : { item: entry.item },
      ...metrics === undefined || metrics.length === 0 ? {} : { metrics },
      ...entry.files === undefined || entry.files.length === 0 ? {} : { files: entry.files },
      times,
    })
  }
  return out
}

/**
 * 汇报「显示在哪一栏」的中文说法。
 *
 * ⚠️ 我们现在**只有「节点明细」一栏**（`location` 实际值固定 `'ndv'`），
 * 另外两个枚举值是给将来多栏留的。所以这里把 `ndv` 显示成「节点明细」，
 * 另两个也各给一个说法 —— 万一引擎哪天真的往里推，界面不会漏成空白。
 *
 * @param loc - 引擎给的栏位。
 * @returns 中文说法。
 */
function locationLabel(loc: NonNullable<ReportEntry['location']>): string {
  if (loc === 'outputPane') return '输出栏'
  if (loc === 'inputPane') return '输入栏'
  return '节点明细'
}

/**
 * 一个节点在这一轮汇报了什么（**与日志分开的一块**）。
 *
 * ## 为什么不与日志混在一起
 *
 * 日志是「我在跑」的流水（一行一动，几十行），汇报是「我这次交出了什么」的结论
 * （几条）。混在一起的后果：结论被流水冲走，用户要往上翻几十行才看到一句总结。
 * 所以两块各有自己的小标题，且汇报在上（结论比过程先看）。
 *
 * ⚠️ **没有 `reports` 时整块不出现** —— 不显示「无汇报」占位。
 * 绝大多数节点本来就不汇报，每个都挂一句占位，明细会被废话淹掉。
 *
 * @param props.reports - 这个节点的汇报（引擎写的原始数组）。
 * @returns 汇报块元素，或 null。
 */
function ReportsBlock({ reports }: { reports: readonly ReportEntry[] }) {
  const shown = foldReports(reports)
  if (shown.length === 0) return null
  return (
    <div className={css.histBlock} data-ewb-reports="">
      <div className={css.histBlockTitle}>汇报</div>
      <div className={css.rpList}>
        {shown.map(row => (
          <div key={row.key} className={css.rpItem + ' ' + css['rp_' + row.type]}
            data-ewb-report={row.key}
            data-ewb-report-type={row.type}>
            {/* 逐条进度（「第 3/5 条」）放最前 —— 用户先知道这是第几条。 */}
            {row.item !== undefined && (
              <span className={css.rpItemTag} data-ewb-report-item="">{row.item}</span>
            )}
            <span className={css.rpMsg} data-ewb-report-msg="">
              {row.message}
              {row.times > 1 && (
                <span className={css.rpTimes} data-ewb-report-times="">（出现 {row.times} 次）</span>
              )}
            </span>
            {row.location !== undefined && (
              <span className={css.rpLoc} data-ewb-report-loc="">{row.location}</span>
            )}
            {row.metrics !== undefined && (
              <span className={css.rpMetrics} data-ewb-report-metrics="">
                {row.metrics.map(([k, v]) => (
                  <span key={k} className={css.rpMetric}>
                    <span className={css.rpMetricKey}>{k}</span>
                    {' '}
                    <span className={css.rpMetricVal}>{v}</span>
                  </span>
                ))}
              </span>
            )}
            {row.files !== undefined && (
              <span className={css.rpFiles} data-ewb-report-files="">
                {row.files.map(f => (
                  /* 纯文本，不是链接：运行历史是**回看**，文件可能早就被移走 / 改名，
                   * 给一个点了打不开的链接比给路径更糟（用户会以为文件还在那儿）。 */
                  <span key={f} className={css.rpFile}>{f}</span>
                ))}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * 运行历史面板。
 *
 * @returns 面板元素。
 */
export function RunHistoryPanel() {  /** 有记录的工作流名（分组键，新的在前）。 */
  const [names, setNames] = useState<string[]>([])
  /** 当前选中的工作流（null = 还没选，自动选第一个）。 */
  const [picked, setPicked] = useState<string | null>(null)
  /** 选中那份的运行记录（新的在前）。 */
  const [runs, setRuns] = useState<RunItem[]>([])
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [err, setErr] = useState('')
  /** 展开到哪一层：运行 id（看节点明细），以及再往下哪个节点（看日志）。 */
  const [openRun, setOpenRun] = useState<string | null>(null)
  const [openNode, setOpenNode] = useState<string | null>(null)
  /** ★ 等待中的运行（还没结束、挂在宿主半等条件的那几份）。
   *
   * ⚠️ 它们**不是运行记录**：记录是「跑完了/中断了」的账，这些还在等。
   * 放在这一页是因为用户在这里回看运行，而「有哪些在等、等什么」是同一件事的另一半。 */
  const [paused, setPaused] = useState<PausedRunItem[]>([])
  /** 读等待中列表 / 点「继续」失败的原因（与运行记录读失败分开，免得互相顶掉）。 */
  const [pausedErr, setPausedErr] = useState('')
  /** 一句话结果（续上了 / 已经不在等待了 / 又挂起了）。 */
  const [notice, setNotice] = useState('')
  /** 正在等宿主半回话的那一行（runId）—— 防连点重复提交。 */
  const [busy, setBusy] = useState('')
  /** 自增一次就重拉当前那份的记录（续跑完 / 放弃后要用它刷新）。 */
  const [reload, setReload] = useState(0)

  /** 拉一次「有哪些工作流留下过记录」。 */
  const loadNames = useCallback((): void => {
    setState('loading')
    void (async () => {
      try {
        const res = await fetch('/api/ecom-workbench/workflow/runs')
        if (!res.ok) { setState('error'); setErr('宿主半返回 ' + String(res.status)); return }
        const body = await res.json() as { names?: string[] }
        const list = (body.names ?? []).slice().sort()
        setNames(list)
        setPicked(prev => prev ?? (list[0] ?? null))
        setState('ok')
      } catch (e) {
        setState('error')
        setErr('连不上宿主半：' + (e instanceof Error ? e.message : String(e)))
      }
    })()
  }, [])

  useEffect(() => { loadNames() }, [loadNames])

  /** 拉一次「现在有哪些运行在等」。 */
  const loadPaused = useCallback((): void => {
    void (async () => {
      const r = await listPausedRuns()
      if (!r.ok) {
        /* ⚠️ 这里指名的按钮必须是**屏幕上真能找到**的那个（「刷新等待中」）。
         * 为了让它在读失败时也在（那时 `paused` 是空的、块本会被藏掉），
         * 下面的 `pausedBlock` 改成「有错误时也渲染」——否则这句「怎么办」是假话。 */
        setPausedErr('读不到等待中的运行：' + (r.error ?? '宿主半没有回应') + '。这些运行仍在宿主半照常等，点「刷新等待中」重试即可。')
        return
      }
      setPausedErr('')
      setPaused(r.paused)
    })()
  }, [])

  useEffect(() => { loadPaused() }, [loadPaused])

  /**
   * 一键刷新**两样都重拉**：工作流分组 + 等待中列表。
   *
   * ⚠️ 为什么必须两样一起（上一轮被 lead 抓出来的真缺陷）：
   * 界面上三处「刷新 / 重试」原来只调 `loadNames`，而 `loadPaused` 只在挂载时跑一次，
   * 于是等待中那条报错里写的「点刷新重试」是假话（点了不重试等待中列表）。
   * 报错三段式的「怎么办」必须真能解决，否则比不写更糟。
   */
  const refreshAll = useCallback((): void => {
    loadNames()
    loadPaused()
  }, [loadNames, loadPaused])

  /**
   * 等待中列表**自动刷新**（30 秒一次）。
   *
   * ## 为什么做（成本低，收益明确）
   *
   * 三件事都在宿主半那边自己发生，界面不去问就永远不知道：
   * 定时器到点把某份**自动续跑**了、别处新挂起一份、某人手改了 `paused/` 目录。
   * 不做的话用户只能切走板块再切回来（靠重挂载）才看得到。
   *
   * ## 为什么是 30 秒、为什么 `busy` 时跳过
   *
   * 这个接口只读目录 + 逐个读 JSON，一份几百字节，30 秒一问没有成本。
   * 但**有一次在途操作时必须跳过**：用户点了「继续」正在等宿主半，此时拉一次列表
   * 会把刚摘掉的那行按旧数据塞回来 —— 一次莫名回魂比不刷新更糟。
   *
   * ## 不会跟 `dom-render` 打架
   *
   * 它跑完整份断言只要十几秒，30 秒的定时器根本轮不到触发；卸载时清掉（返回的清理函数）。
   */
  useEffect(() => {
    const timer = setInterval(() => { if (busy === '') loadPaused() }, 30000)
    return () => { clearInterval(timer) }
  }, [loadPaused, busy])

  /**
   * 点「继续」：让宿主半立刻续跑这一份。
   *
   * 三种结局分别处理（验收第 3、4 条）：
   *   · `gone` —— 这份已经不在等待了（被别人续过 / 已放弃），**不报成网络错误**；
   *   · `waiting` —— 续跑后又挂起了：行**留在原处**，只把「等到几点」换成新的；
   *   · 续完没再挂 —— 该行从等待中区消失，并顺手刷新运行记录。
   *
   * @param id - 运行 id。
   */
  const onResume = useCallback((id: string): void => {
    if (busy !== '') return
    setBusy(id)
    setNotice('')
    void (async () => {
      const r = await resumePausedRun(id)
      setBusy('')
      if (r.gone === true) {
        /* 现场不在了：把它从列表里摘掉，并说清为什么（不是出错）。 */
        setPaused(prev => prev.filter(p => p.runId !== id))
        setNotice('这份已经不在等待了，可能已被自动继续或已放弃。')
        setReload(n => n + 1)
        return
      }
      if (!r.ok) {
        setPausedErr('继续没有成功：' + (r.error ?? '宿主半没有说明原因') + '。这份现场还在（行未移除），可再点一次「继续」。')
        return
      }
      if (r.waiting === true) {
        /* 又挂起了 —— 留行，只更新等到的时刻。 */
        const at = r.resumeAt
        if (at !== undefined) {
          setPaused(prev => prev.map(p => p.runId === id ? { ...p, resumeAt: at } : p))
        }
        setNotice(r.summary ?? '又挂起了，等下一个条件。')
        return
      }
      setPaused(prev => prev.filter(p => p.runId !== id))
      setNotice(r.summary ?? '已继续。')
      setReload(n => n + 1)
    })()
  }, [busy])

  /**
   * 点「放弃」：删掉现场，之后不再自动恢复。
   *
   * ⚠️ **二次确认**（破坏性操作，R6 的三处例外之一，允许写具体）：
   * 删掉之后这份运行再也接不上，只能整份重跑。
   *
   * @param id - 运行 id。
   */
  const onCancel = useCallback((id: string): void => {
    if (busy !== '') return
    if (!window.confirm('放弃这次运行？它的挂起现场会被删掉，之后不再自动继续，只能整份重跑。')) return
    setBusy(id)
    setNotice('')
    void (async () => {
      const r = await cancelPausedRun(id)
      setBusy('')
      if (!r.ok) { setPausedErr('放弃没有成功：' + (r.error ?? '宿主半没有说明原因') + '。这份现场还在，可再点一次「放弃」。'); return }
      setPaused(prev => prev.filter(p => p.runId !== id))
      setNotice('已放弃这次运行。')
    })()
  }, [busy])

  /** 选中变了 → 拉那份的记录。 */
  useEffect(() => {
    if (picked === null) { setRuns([]); return }
    void (async () => {
      try {
        const res = await fetch('/api/ecom-workbench/workflow/runs?name=' + encodeURIComponent(picked))
        if (!res.ok) { setErr('读「' + picked + '」的记录失败：宿主半返回 ' + String(res.status)); return }
        const body = await res.json() as { runs?: RunItem[] }
        setRuns(body.runs ?? [])
      } catch (e) {
        setErr('读「' + picked + '」的记录失败：' + (e instanceof Error ? e.message : String(e)))
      }
    })()
  }, [picked, reload])

  /**
   * 「等待中」区（验收第 1、2、5 条；缺陷 1 修在这里）。
   *
   * 放在早退分支**之前**算好，并在**三个分支里都渲染**（尤其 `state === 'error'`）：
   * 运行记录与等待中列表同时读失败时，用户最需要知道的恰恰是「有没有东西在等」——
   * 那时只剩这一块能告诉他。原来只在「无记录」分支渲染，等于同时失败就整块消失。
   *
   * ⚠️ **读失败时也要渲染**（`pausedErr !== ''`）：那句「点「刷新等待中」重试即可」
   * 指名的按钮必须在屏幕上真能找到，否则「怎么办」是假话。
   * 读成功且没有等待中的运行（`paused` 空、无错）→ 不渲染空块（第 5 条），
   * 只在列表底部留一行说明。
   */
  const pausedBlock = paused.length === 0 && pausedErr === ''
    ? null
    : (
      <div data-ewb-paused="" className="mb-3 flex max-h-60 flex-none flex-col gap-1.5 overflow-y-auto">
        {/* 标题行右侧的刷新入口：用户在等待中区里盯着这份列表，
         * 不该为了刷新它退到页面底部找按钮。只重拉等待中，不动工作流分组。 */}
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
            等待中{paused.length === 0 ? '' : '（' + String(paused.length) + ' 份）'}
          </span>
          <button
            type="button"
            data-ewb-paused-refresh=""
            className={css.histBtn}
            disabled={busy !== ''}
            onClick={loadPaused}
          >刷新等待中</button>
        </div>
        {pausedErr !== '' && <div className={css.histWarn}>{pausedErr}</div>}
        {paused.map(p => (
          <div key={p.runId} className={css.histRow + ' ' + css.hist_warn}>
            <div className={css.histRowHead} style={{ cursor: 'default' }}>
              <span className={css.histState}>等待中</span>
              <span className={css.histName} title={p.workflowId}>{p.workflowId}</span>
              <span className={css.histMeta}>
                {p.mode === 'until'
                  ? '等到 ' + (p.until ?? '') + '（' + fmtWhen(p.resumeAt) + '）'
                  : '等到 ' + fmtWhen(p.resumeAt)}
                {' · ' + String(p.ran) + ' 个节点'}
              </span>
            </div>
            <div className="flex items-center gap-1.5 px-2.5 pb-2">
              <button
                type="button"
                data-ewb-paused-resume={p.runId}
                className={css.histBtn}
                disabled={busy !== ''}
                onClick={() => { onResume(p.runId) }}
              >继续</button>
              <button
                type="button"
                data-ewb-paused-cancel={p.runId}
                className={css.histBtn}
                disabled={busy !== ''}
                onClick={() => { onCancel(p.runId) }}
              >放弃</button>
            </div>
          </div>
        ))}
      </div>
    )

  if (state === 'loading') return <div className={css.histEmpty}>正在读取运行记录…</div>
  if (state === 'error') {
    /* ⚠️ **等待中区必须在这里也渲染**（缺陷 1）：两个接口同时读失败时，
     * 用户最需要知道的恰恰是「有没有东西在等」——那是唯一还能自救的线索。 */
    return (
      <div className={css.histEmpty}>
        {pausedBlock}
        <div className={css.histWarn}>无法读取运行记录：{err}</div>
        <button type="button" data-ewb-paused-retry="" className={css.histBtn} onClick={refreshAll}>重试</button>
      </div>
    )
  }
  if (names.length === 0) {
    return (
      <div className={css.histEmpty}>
        {pausedBlock}
        {notice !== '' && <div data-ewb-paused-notice="">{notice}</div>}
        <div>还没有任何运行记录。在「工作流管理」里点「执行」，或从画布跑一次，这里就会出现。</div>
        <button type="button" className={css.histBtn} onClick={refreshAll}>刷新</button>
      </div>
    )
  }

  return (
    <div className={css.histWrap}>
      {pausedBlock}
      {notice !== '' && (
        <div data-ewb-paused-notice="" className="mb-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">{notice}</div>
      )}
      {/* ── 顶部：**按工作流分组**的切换条（用户 m03287：「根据工作流做分组」）── */}
      <div data-ewb-run-groups="" className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">工作流</span>
        {names.map(n => {
          const on = picked === n
          return (
            <button
              key={n}
              type="button"
              data-lens="c"
              aria-pressed={on}
              onClick={() => { setPicked(n); setOpenRun(null); setOpenNode(null) }}
              className={
                'pressable rounded-full px-2.5 py-0.5 font-mono text-ewb-caption ' +
                (on
                  ? 'border border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)] text-[var(--ewb-accent)]'
                  : 'border border-[var(--dsw-alias-border-l2)] text-[var(--dsw-alias-label-secondary)]')
              }
            >{n}</button>
          )
        })}
        <button type="button" data-ewb-paused-refresh-all="" className={css.histBtn} onClick={refreshAll}>刷新</button>
      </div>

      {err !== '' && <div className={css.histWarn}>{err}</div>}

      <div className={css.histList}>
        {runs.length === 0 && <div className={css.histEmpty}>「{picked}」还没有运行记录。</div>}
        {runs.map(r => {
          const isOpen = openRun === r.id
          const dur = r.endedAt === undefined ? undefined : r.endedAt - r.startedAt
          return (
            <div key={r.id} className={css.histRow + ' ' + css['hist_' + (r.ok ? 'ok' : 'error')]}>
              <button
                type="button"
                className={css.histRowHead}
                data-ewb-run-row=""
                onClick={() => { setOpenRun(isOpen ? null : r.id); setOpenNode(null) }}
              >
                <span className={css.histState}>{r.ok ? '成功' : (r.aborted === true ? '中断' : '失败')}</span>
                <span className={css.histName}>{fmtWhen(r.startedAt)}</span>
                <span className={css.histMeta}>
                  {viaLabel(r.via) !== '' && viaLabel(r.via) + ' · '}
                  {dur !== undefined && fmtDuration(dur)}
                  {r.ran !== undefined && ' · ' + String(r.ran.length) + ' 个节点'}
                </span>
                <span className={css.histCaret}>{isOpen ? '▾' : '▸'}</span>
              </button>

              {r.error !== undefined && <div className={css.histErr}>✕ {r.error}</div>}

              {isOpen && (
                <div className={css.histBody}>
                  {/* 输入（这次跑用了什么参数）—— 回看时最常要的上下文。 */}
                  {r.inputs !== undefined && Object.keys(r.inputs).length > 0 && (
                    <div className={css.histBlock}>
                      <div className={css.histBlockTitle}>输入</div>
                      <pre className={css.histPre}>
                        {Object.entries(r.inputs).map(([k, v]) => k + ' = ' + brief(v)).join('\n')}
                      </pre>
                    </div>
                  )}

                  {/* ── 节点明细（「甲」的分层：标题 = 实例备注名 + 编号）── */}
                  <div className={css.histBlock} data-ewb-run-nodes="">
                    <div className={css.histBlockTitle}>节点明细（{String(r.nodes?.length ?? 0)} 个）</div>
                    {(r.nodes ?? []).length === 0 && <div className={css.histEmpty}>这次运行没有留下节点明细。</div>}
                    {(r.nodes ?? []).map((n, idx) => {
                      const meta = STATE_LABEL[n.state] ?? { text: n.state, tone: 'idle' }
                      const key = r.id + ':' + n.nodeId
                      const nOpen = openNode === key
                      const nDur = n.startedAt === undefined || n.endedAt === undefined ? undefined : n.endedAt - n.startedAt
                      return (
                        <div key={key} className={css.histRow + ' ' + css['hist_' + meta.tone]}>
                          <button
                            type="button"
                            className={css.histRowHead}
                            onClick={() => { setOpenNode(nOpen ? null : key) }}
                          >
                            <span className={css.histState}>{meta.text}</span>
                            <span className={css.histName}>{nodeTitle(n, idx + 1)}</span>
                            <span className={css.histMeta}>{nDur === undefined ? '' : fmtDuration(nDur)}</span>
                            <span className={css.histCaret}>{nOpen ? '▾' : '▸'}</span>
                          </button>
                          {n.error !== undefined && <div className={css.histErr}>✕ {n.error}</div>}
                          {nOpen && (
                            <div className={css.histBody}>
                              {/* ★ 模型痕迹：**有 `llm` 才渲染整块**（2026-10-23 契约 W）。
                               *
                               * ⚠️ 没有 `llm` 时**什么都不出来** —— 不是空 div、不是「无记录」。
                               * 绝大多数节点（读写文件、判断、循环）本来就不调模型，
                               * 每个都挂一句「没有模型记录」，明细会被这堆废话淹掉。 */}
                              {n.llm !== undefined && <LlmTraceBlock trace={n.llm} />}
                              {/* ★ 汇报（2026-10-25 契约 AO）：**与日志分区**，各有小标题。
                               * 汇报在上（结论比过程先看）；没有 `reports` 时整块不出现。 */}
                              {n.reports !== undefined && n.reports.length > 0 && (
                                <ReportsBlock reports={n.reports} />
                              )}
                              {/* ★ 日志：与上面的汇报**分开一块**，自己的小标题。
                               * 之前这里没有标题（直接一坨 pre），与汇报并列时读不出
                               * 「哪块是过程、哪块是结论」—— 契约第 2 条要求分区。 */}
                              <div className={css.histBlock} data-ewb-logs="">
                                <div className={css.histBlockTitle}>日志</div>
                                {(n.logs ?? []).length === 0
                                  ? <div className={css.histEmpty}>这个节点没有日志。</div>
                                  : <pre className={css.histPre} data-ewb-log-lines="">{(n.logs ?? []).join('\n')}</pre>}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* 验收第 5 条：没有等待中的运行**不渲染空块**，只在底部留一行说明。
       * 读失败时不写这句（那时块本身就在，里面写着原因）。 */}
      {paused.length === 0 && pausedErr === '' && (
        <div data-ewb-paused-none="" className={css.histEmpty}>暂无等待中的运行。</div>
      )}
    </div>
  )
}
