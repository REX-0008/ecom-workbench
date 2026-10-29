/** 取数板块：**采集中心**（卡片）+ **采集任务**（记录）。
 *
 * ## 2026-10-22 重设计（用户定案）
 *
 * 原来是一张 5 列表格（工作流 / 说明 / 最近一次 / 记录 / 操作），
 * 读起来像后台管理表；而且**6 份全在里面**。现在改成卡片：
 *
 * ```
 * ┌─ 采集中心 ────────────────────────────────────────────┐
 * │ [+ 新建采集]          共 2 份 · 上次全跑成功   [刷新] │
 * │ ┌──────────────────┐  ┌──────────────────┐           │
 * │ │ ● 全部下载        │  │ ● 清洗入库        │           │
 * │ │ 天猫 + 抖音…      │  │ 把已下载的…       │           │
 * │ │ ─────────────    │  │ ─────────────    │           │
 * │ │ 最近：…· 成功 · 4项│  │ 最近：还没跑过    │           │
 * │ │ ▸ 就地展开的输出区 │  │                  │           │
 * │ └──────────────────┘  └──────────────────┘           │
 * └──────────────────────────────────────────────────────┘
 * ```
 *
 * ## 只显示两份（这是本轮最重要的一条）
 *
 * 判据写在 `board-kit.ts` 的 `isCollectEntry`（**显式白名单**，不是命名规则）：
 * 「哪几份该出现在取数板块」是产品决定，不该让「名字里有没有某个词」替人决定。
 * 白名单列在 `COLLECT_ENTRIES`，顺序就是卡片顺序。
 *
 * 底层 3 份取数（天猫 / 抖音 / 千川）是「全部下载」的零件 —— 并列摆出来
 * 只会让用户在一堆半成品里挑，而它们跑完也不会自动清洗入库。
 *
 * ## 就地展开的实时输出
 *
 * 复用 `FlowRunPanel`（现成的 SSE 组件，`/workflow/run-stream`），
 * 挂在**那张卡片内部**（不是页面别处），所以「我点的是这一份、看的就是这一份」。
 *
 * ⚠️ **一次只允许跑一份**：几份取数都要抢同一个浏览器会话，
 * 同时跑会互相踢掉登录态。所以别的卡片执行按钮禁用，并把原因写在悬浮提示里。
 *
 * ## 入场动效只留一处
 *
 * 本项目已有规定：入场动效只在 `PageHeader`。这里**不加逐块淡入** ——
 * 卡片一多就是「AI 生成感」，而且每次重渲染都闪一遍。
 *
 * ## 数据从哪来（两处，各回答一个问题）
 *
 * 路 `GET /workflows` —— **有哪些取数工作流**（含说明与修改时间）；
 * 路 `GET /collect/records` —— **跑过什么、交出了什么**（宿主半在跑完时落的记录）。
 *
 * ⚠️ 两者不是一回事：运行历史记「跑过什么」，采集记录记「交出了什么」。
 * 这里两样都要，所以两个接口都读。
 *
 * ## ⚠️ `collect/` 目录与收藏板块共用
 *
 * 工作流名若是 `skills` / `notes` / `.backup`，宿主半会把它写成 `wf-` 前缀的子目录
 * （见 `src/schedule/records.ts` 的 `RESERVED`）。所以按名字对记录时**两边都要试**
 * —— 只认原名的话，这类工作流的记录数会永远显示 0。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BoardProps } from './board-registry.ts'
/* ★ 汇报的形状（2026-10-25 契约 AO）。`model.ts` 是纯类型文件（它自己不 import
 * 任何东西），客户端可以放心引。只 `import type`，不会把宿主半的依赖拖进来。 */
import type { HintLevel, ReportEntry } from '../../workflow/model.ts'
/* ⚠️ `css`：借**运行历史**那一套行样式（`histRow` / `histState` / …）。
 *
 * 用户 2026-10-23 要求「任务记录的样式改成工作流的运行历史的样式」，
 * 而那几个类住在 `EcomWorkbench.module.css`（运行历史也在用）。
 * 借外观，不改内容 —— 两处的内容差别写在这一格的文件头与那段 JSX 的注释里。
 * 那几个类的值**不许改**（改了运行历史跟着变）。 */
import css from './EcomWorkbench.module.css'
import { asArray, asObject, call, COLLECT_ENTRIES, isCollectEntry, when } from './board-kit.ts'
import { SlidingTabs } from './SlidingTabs.tsx'
import { loadWorkflowIo } from './dispatch-client.ts'
import { RunInputForm } from './RunInputForm.tsx'
import type { InputField } from '../../workflow/io-fields.ts'
/* ⚠️ `Badge` 已不再引用（2026-10-23 任务记录改用运行历史那套 `histState` 状态字）。
 * `Label` 还在用，别一起删掉。 */
import { Label } from './terminal.tsx'
import { FlowRunPanel } from './FlowRunPanel.tsx'
import type { FlowDone } from './FlowRunPanel.tsx'
/* ★ 「定时任务」那一格（2026-10-23：原独立「定时」板块整块搬进来）。
 * 搬的是**同一个组件**，不是复制的界面 —— 所以能力不会跟原板块漂：
 * 它自己管自己的读接口、新建、删除、启停、立即跑。
 * ⚠️ 传 `active` 时只在**这一格真的显示着**才给 true，否则它在后台白轮询。 */
import { ScheduleBoard } from './ScheduleBoard.tsx'

/** 工作流列表里的一条（宿主半 `GET /workflows` 的形状）。 */
interface WorkflowItem {
  name: string
  id?: string
  nodes?: number
  description?: string
  at?: number
  /**
   * 谁能启动它（由**开始节点的类型**决定，宿主半在列表里一并回）。
   *
   * | 值 | 含义 | 任务中心怎么处置 |
   * | --- | --- | --- |
   * | `'manual'` | 手动启动 | 给「执行」按钮 |
   * | `'called'` | 只可被别的流程调用 | **不给按钮**，改贴「只可被调用」并说清原因 |
   * | `null` / 缺 | 老存档没有开始节点 | **照旧给按钮** —— 它自带初始数据，手动跑没问题 |
   *
   * 照抄 `WorkflowList.tsx:1046-1067` 那套判断（票面要求「同一套判断」）。
   */
  startType?: string | null
}

/** 一条采集记录（宿主半 `GET /collect/records` 的形状）。 */
interface CollectRecord {
  /** 目录名（绝大多数情况就是工作流名；撞上收藏板块时带 `wf-` 前缀）。 */
  workflow: string
  file: string
  at: number
  ok?: boolean
  outputs: Record<string, unknown>
  /**
   * 失败原因（2026-10-23 契约 AD 新增，界面在契约 AE 才显示它）。
   *
   * ⚠️ **成功时不会有这个键**（不是空串，是不写）。老记录也**没有**
   * —— 那是契约 AD 之前写的，磁盘上就有一批这样的（比如 `全部下载` 那几条）。
   * 所以界面必须把「失败但没留原因」当成一个**正常存在**的状态，
   * 不能当成数据坏了、更不能当成成功。
   */
  error?: string
  /**
   * 这次运行节点主动报的事（2026-10-25 契约 AO）。
   *
   * ## 与 `outputs` 的关系：**汇报优先**
   *
   * 归档时两条只写一条（`src/schedule/records.ts:78-83`）：
   *   · 有汇报 → 写 `reports`，不写 `outputs`；
   *   · 没有汇报 → 退回写 `outputs`（老行为一字不变）。
   *
   * 所以界面上要**先看 `reports`，没有才看 `outputs`** —— 两个同时有的记录按理不存在，
   * 但老记录只会有 `outputs`，新记录只会有 `reports`，两种都得能显示。
   */
  reports?: ReportEntry[]
}

/** 本板块的**三格**（用户 2026-10-23 定，顺序就是这个顺序，别自己调）。
 *
 * ## 三格各是什么
 *
 * | 格 | 内部 id | 放什么 | 从哪来 |
 * | --- | --- | --- | --- |
 * | **任务中心** | `center` | 卡片 + 就地展开输出 + 新建采集 | 原「采集中心」，只改了名字 |
 * | **定时任务** | `scheduled` | 定时任务表（新建 / 删除 / 启停 / 立即跑） | 原独立「定时」板块，整块搬进来 |
 * | **任务记录** | `tasks` | 采集记录（`/collect/records`） | 原「采集任务」，只改了名字 |
 *
 * ⚠️ **内部 id 故意不跟着改**：`center` / `tasks` 这两个 id 已经被既有断言引用
 * （`tests/dom-render.mjs` 与 `tests/collect.mjs`），改 id 会让那些断言无缘无故红。
 * 界面上用户看到的是 label，id 只在代码里用。
 *
 * ## 「任务记录」为什么不叫「运行历史」
 *
 * 两者不是一回事（用户原话点了这一层区别）：
 *   · **运行历史**（工作流板块里）= 每一步节点的日志，排查用；
 *   · **任务记录**（这里）= 结束节点整理出来的**产出**，回答「这次交出了什么」。
 * 所以这一格读的是 `/collect/records`，不是 `/workflow/runs`。 */
const TABS = [
  { id: 'center', label: '任务中心' },
  { id: 'scheduled', label: '定时任务' },
  { id: 'tasks', label: '任务记录' },
] as const

/** 一格 tab 的 id 类型。 */
type TabId = typeof TABS[number]['id']

/** 主按钮（就是「新建采集」与「执行」这两个**主操作**用它）。 */
const BTN = [
  'pressable is-dark shrink-0 whitespace-nowrap rounded-ctl border px-2.5 py-1.5',
  'border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)] text-[var(--ewb-accent)]',
  'font-mono text-ewb-caption leading-none disabled:opacity-45',
].join(' ')

/** 次要按钮（刷新、取消新建这类）。 */
const BTN_QUIET = [
  'pressable is-dark shrink-0 whitespace-nowrap rounded-ctl border border-[var(--dsw-alias-border-l2)]',
  'px-2.5 py-1.5 font-mono text-ewb-caption leading-none text-[var(--dsw-alias-label-tertiary)] disabled:opacity-45',
].join(' ')

/** 输入框（内凹，见 AGENTS.md 的「深度」一节）。 */
const INPUT = [
  'min-w-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)]',
  'px-2 py-1.5 text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none',
].join(' ')

/** 卡片栅格：等宽两列，窄屏自动落成一列（`auto-fit` + 最小宽度，不是瀑布流）。 */
const CARD_GRID = 'grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]'

/**
 * 一次跑完的汇总（卡片上留的那一行）。
 *
 * 为什么要留它：输出区跑完会收起（用户要求的），但「跑成没成、跑了几个节点」
 * 必须还在 —— 否则收起之后那张卡片看起来跟没跑过一样。
 */
interface RunSummary {
  /** 工作流名。 */
  name: string
  /** 成没成。 */
  ok: boolean
  /** 跑了几个节点。 */
  ran: number
  /** 失败原因（成功时为空串）。 */
  error: string
  /** 交出了几项产出。 */
  outputs: number
  /**
   * 卡在哪个节点（`nodeId` + 界面上的名字）。
   *
   * ## 为什么要它（2026-10-23 契约 Y）
   *
   * 用户原话：「就算失败了也应该在任务中心界面显示完整流程。至少为什么失败
   * 要在任务中心看得到」。
   *
   * 只有 `error` 一句话时，用户知道「失败了」但不知道**停在哪一步**——
   * 那正是他要往下查的起点。所以这里记下失败事件里的 `nodeId`，
   * 卡片的失败详情里写「停在：② 打开页面（n2）」。
   */
  stuckAt?: { nodeId: string, label?: string }
  /**
   * 这一次的运行 id（宿主半 `done` 事件里的 `runId`）。
   *
   * ⚠️ **当前没有一处读它**。留着是因为宿主半确实发了这个字段、`FlowRunPanel`
   * 也确实把整个 `done` 载荷原样透传了出来（`JSON.parse(ev.data)` → `onDone`），
   * 所以拿得到；但现在「跳运行历史」那条路还没通（要骨架暴露「切到某个板块」的能力），
   * 拿到它也无处可用。
   *
   * 等那条路通了直接用这个字段定位那一次，不必再改 `onDone`。
   */
  runId?: string
}

/**
 * 记录属于哪份工作流。
 * 宿主半把撞上收藏板块的名字写成 `wf-<名字>`，所以两边都要试 —— 只认一侧的话，
 * 「skills」这种名字的记录数会永远显示 0。
 * @param record - 一条记录。
 * @param name - 工作流名。
 * @returns 属于它给 true。
 */
function sameWorkflow(record: CollectRecord, name: string): boolean {
  return record.workflow === name || record.workflow === 'wf-' + name
}

/**
 * 取数板块。
 * @param props - 骨架给板块的入参。
 * @returns 界面。
 */
export function CollectBoard({ active }: BoardProps): React.JSX.Element {
  /** 当前在采集中心还是在采集任务。板块自己没有注册 tab，所以这一层由板块自己画。 */
  const [tab, setTab] = useState<TabId>('center')
  const [workflows, setWorkflows] = useState<WorkflowItem[] | null>(null)
  const [records, setRecords] = useState<CollectRecord[]>([])
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  /**
   * 正在跑的那一份（空串 = 没在跑）。
   *
   * ⚠️ 它同时是「全局只有一个能跑」的锁：别的卡片的执行按钮据此禁用。
   */
  const [running, setRunning] = useState('')
  /** 最近一次跑完的汇总（只留一条 —— 卡片上那一行说「刚才那次」就够了）。 */
  const [summary, setSummary] = useState<RunSummary | null>(null)
  /** 顶部提示条。 */
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err', text: string } | null>(null)
  /** 「新建采集」表单展开着吗。 */
  const [creating, setCreating] = useState(false)
  /**
   * 任务记录里展开着哪一条（`workflow/file` 那个键；`null` = 都收起）。
   *
   * 为什么做成展开而不是默认铺开：一条记录可能交出十几项产出，
   * 全铺开这张列表就没法扫了 —— 与运行历史的做法一致（那里点开才看节点明细）。
   */
  const [openRecord, setOpenRecord] = useState<string | null>(null)
  /** 新采集的名字（默认按来源推一个，用户可改）。 */
  const [newName, setNewName] = useState('')
  /** 复制哪一份（空串 = 还没选）。 */
  const [sourceName, setSourceName] = useState('')
  const [busy, setBusy] = useState(false)
  /**
   * 正在填输入的那一份（`null` = 没在填）。
   *
   * 用户第 7 条：「任务创建后读取开始节点的设置项目，然后点击任务中心的
   * 某个任务可以展开可选项执行」。所以点「执行」时**先读开始节点声明**：
   *
   *   · `fields` 为空 → 直接跑（不长一块空表单）；
   *   · 有 `fields` → 就地展开 `RunInputForm`（现成的，不新写一套），
   *     填完再跑，值带进运行。
   */
  const [inputAsk, setInputAsk] = useState<{ name: string, fields: readonly InputField[] } | null>(null)
  /**
   * 这次运行要带给它的输入（空对象 = 没填过 / 不需要填）。
   *
   * ⚠️ 它要进 `FlowRunPanel` 的 `inputs`（组件内走查询串发出去），
   * 并且**放进依赖数组** —— `FlowRunPanel` 那个 effect 的依赖里有 `props.inputs`，
   * 变了会重连 SSE（= 重跑一次）。所以这一份只在真正开始跑那一刻设一次，
   * 不在渲染里现造对象（现造的话每次渲染都是一个新引用 → 每次都重连运行）。
   */
  const [runInputs, setRunInputs] = useState<Record<string, unknown>>({})

  /**
   * 拉一次（工作流清单 + 采集记录）。
   *
   * @param silent - 不显示加载态（跑完刷新时用，避免整块闪一下）。
   */
  const refresh = useCallback((silent = false): void => {
    if (!silent) setLoading(true)
    void (async () => {
      const [wf, rec] = await Promise.all([
        call<{ items?: unknown }>('/workflows'),
        call<{ records?: unknown }>('/collect/records?limit=300'),
      ])
      if (!wf.ok) { setErr(wf.error ?? '读不到工作流清单'); setLoading(false); return }
      setErr('')
      setWorkflows(asArray(wf.body?.items).map(x => asObject(x)) as unknown as WorkflowItem[])
      /* 记录读不到时**不算失败**：工作流清单还在，卡片照样能看能跑；
       * 只是「最近一次」会变成「还没跑过」。所以这里只吞掉原因，不覆盖上面的错。 */
      setRecords(rec.ok
        ? asArray(rec.body?.records).map(x => {
            const o = asObject(x)
            return {
              workflow: typeof o.workflow === 'string' ? o.workflow : '',
              file: typeof o.file === 'string' ? o.file : '',
              at: typeof o.at === 'number' ? o.at : 0,
              ...typeof o.ok === 'boolean' ? { ok: o.ok } : {},
              outputs: asObject(o.outputs),
              /* ★ 失败原因（2026-10-23 契约 AE）。
               *
               * ⚠️ **这一行不加，界面就永远显示「没有留下原因」** —— 类型上声明了
               * `error?: string` 只是说「可以有」，读盘时这里是一个**白名单式映射**，
               * 没在这里取出来的字段会被整个丢掉。第一版就漏了这一行，
               * 结果带 `error` 的记录也显示成「这条记录没有留下原因」。
               *
               * 只收非空字符串：`error: ''` 与「没这个键」在界面上是同一件事
               * （都没有可看的原因），没必要在类型里留一个空串状态。 */
              ...typeof o.error === 'string' && o.error !== '' ? { error: o.error } : {},
              /* ★ 汇报（2026-10-25 契约 AO）。
               *
               * ⚠️ **同样不加这一行就永远显示不出来** —— 与上面 `error` 那条是同一个坑：
               * 这里是白名单式映射，没在这一行取出来的字段会被整条丢掉。
               * 光在 `CollectRecord` 里声明 `reports?` 是不够的。
               *
               * 只收非空数组：`reports: []` 与「没这个键」在界面上是同一件事
               * （都没有可看的汇报），没必要留一个空数组状态。 */
              ...Array.isArray(o.reports) && o.reports.length > 0
                ? { reports: o.reports as ReportEntry[] }
                : {},
            }
          })
        : [])
      setLoading(false)
    })()
  }, [])

  useEffect(() => { refresh() }, [refresh])

  /* 切到本板块、或切回来时再拉一次 —— 别在别的板块上白跑请求（BoardProps.active 的约定）。 */
  useEffect(() => {
    if (active) refresh(true)
  }, [active, refresh])

  /**
   * 本板块要显示的卡片（**白名单过滤**，顺序按 `COLLECT_ENTRIES`）。
   *
   * 三层都缺一不可：
   *   ① `isCollectEntry` 白名单 —— 底层取数不进列表；
   *   ② 必须**真的存在**这份存档（白名单写了但盘上没有 = 不显示，不能只显示一句空卡片）；
   *   ③ 顺序按 `COLLECT_ENTRIES`（「全部下载」在前，它才是日常要点的那个）。
   *
   * ⚠️ ①**必须真的走 `isCollectEntry`**。早先这里是直接 `COLLECT_ENTRIES.map(...)`
   * —— 那样也能得到正确结果，但白名单就成了「只用来排序的名单」，
   * 而这个函数被 import 却没人调用。反证时把 `isCollectEntry` 改成「非巡查类」，
   * 界面**一点没变**，那条「只显示两份」的断言照样绿 —— 说明它钉的其实不是过滤。
   *
   * 现在方向反过来：**从盘上的工作流里筛**（`filter(w => isCollectEntry(w.name))`），
   * 再按 `COLLECT_ENTRIES` 的顺序排。这样「谁该出现」完全由那个函数决定，
   * 它一改，界面立刻跟着变 —— 判据与断言是同一处逻辑。
   */
  const cards = useMemo(() => {
    const order = new Map(COLLECT_ENTRIES.map((e, i) => [e.name, i]))
    return (workflows ?? [])
      .filter(w => isCollectEntry(w.name))
      .map(w => ({
        w,
        /* 名单里有就用名单的说明；没有（白名单放宽了）就留空，
         * 渲染时会退回工作流自己的说明 —— **不要在这一步按名单再筛一次**，
         * 否则 `isCollectEntry` 又变成摆设（反证时会假绿，见上）。 */
        entry: COLLECT_ENTRIES.find(e => e.name === w.name.trim()) ?? { name: w.name.trim(), note: '' },
      }))
      .sort((a, b) => (order.get(a.w.name.trim()) ?? 99) - (order.get(b.w.name.trim()) ?? 99))
  }, [workflows])

  /** 白名单里有、但盘上没有的（用来在空态里说清「缺什么」，不是一句「什么都没有」）。 */
  const missing = useMemo(() => {
    const have = new Set((workflows ?? []).map(w => w.name.trim()))
    return COLLECT_ENTRIES.filter(e => !have.has(e.name)).map(e => e.name)
  }, [workflows])

  /**
   * 一份工作流在本目录里的采集记录（新的在前 —— 宿主半已经排好序了）。
   * @param name - 工作流名。
   * @returns 记录数组。
   */
  const recordsOf = useCallback(
    (name: string): CollectRecord[] => records.filter(r => sameWorkflow(r, name)),
    [records],
  )

  /** 全部记录（采集任务那一格用，已是倒序）。 */
  const latestRecords = useMemo(() => records.slice(0, 200), [records])

  /** 状态摘要（**只在有真数据时说**：以卡片为准，不看白名单）。 */
  const digest = useMemo(() => {
    if (cards.length === 0) return ''
    const ran = cards.map(c => recordsOf(c.w.name)[0]).filter(r => r !== undefined)
    if (ran.length === 0) return '共 ' + String(cards.length) + ' 份采集，都还没跑过'
    const failed = ran.filter(r => r.ok === false).length
    return '共 ' + String(cards.length) + ' 份采集，' + (failed === 0 ? '上次全跑成功' : '上次有 ' + String(failed) + ' 份失败')
  }, [cards, recordsOf])

  /**
   * 真正开始跑。
   *
   * ⚠️ 与 `run` 拆开是有原因的：`runInputs` 一变，`FlowRunPanel` 那个 effect
   * 的依赖就变，会**重连 SSE = 再跑一遍**。所以它只在**这一刻**设一次，
   * 且 `setRunning` 与它同一批更新（React 会合批，effect 只跑一次）。
   *
   * ⚠️ **必须定义在 `run` 之前** —— `run` 的依赖数组里引用了它。
   * 放在后面就是本项目那个高频坑（「用在定义之前」，`npm run check:tdz` 会抓）。
   *
   * @param name - 要跑的工作流名。
   * @param inputs - 填好的输入（空对象 = 不需要填）。
   */
  const startRun = useCallback((name: string, inputs: Record<string, unknown>): void => {
    setInputAsk(null)
    setRunInputs(inputs)
    setRunning(name)
  }, [])

  /**
   * 点「执行」：**先读开始节点声明**，再决定是直接跑还是先填参数。
   *
   * ⚠️ 不再走骨架的 `onRunWorkflow`（那是「弹条提示、结果看不到」的老路）。
   * 这里的 SSE 是**唯一真正跑**的那条 —— 两边都发会把工作流跑两遍
   * （`FlowRunPanel` 的 `onDone` 注释里记着这个真 bug）。
   *
   * ## 用户第 7 条（2026-10-30）
   *
   * 「任务创建后读取开始节点的设置项目，然后点击任务中心的某个任务可以展开可选项执行」。
   * 所以点执行先问一次 `GET /workflow/io`：
   *
   * | 读到什么 | 做什么 |
   * | --- | --- |
   * | 路由不通 / 没有这份 | **直接跑**（照 `WorkflowList.startRun` 的做法：附加能力不可用不该让「执行」整个坏掉） |
   * | `inputs` 为空 | **直接跑**，不长空表单（票面第 5 条） |
   * | `inputs` 非空 | 就地展开 `RunInputForm`，填完再跑 |
   *
   * @param name - 要跑的工作流名。
   */
  const run = useCallback((name: string): void => {
    if (running !== '') return
    setMsg(null)
    setSummary(null)
    void (async () => {
      const io = await loadWorkflowIo(name)
      /* 查不到声明**不拦**：拦下来的话「执行」会因为一个附加能力不可用而整个坏掉。 */
      if (!io.ok) { startRun(name, {}); return }
      const fields = io.inputs ?? []
      if (fields.length === 0) { startRun(name, {}); return }
      /* 有输入项 → 就地展开表单（不弹空表单：票面第 5 条）。 */
      setInputAsk({ name, fields })
    })()
  }, [running, startRun])

  /**
   * 跑完了：收起输出区，留一行汇总。
   *
   * ## 失败时要留下什么（2026-10-23 契约 Y）
   *
   * 用户原话：「至少为什么失败要在任务中心看得到」。
   * 所以失败时除了那句 `error`，还要留住**卡在哪个节点**与**这次的 runId**：
   *
   *   · 停在哪个节点 → 用户知道往下查的起点；
   *   · `runId` → 「看完整明细」按钮据此跳到运行历史的那一次，
   *     不用用户自己在一堆记录里翻。
   *
   * ⚠️ **`stuckAt` 只能从 `ran` 的最后一个推** —— 这一批的可改范围不含
   * `FlowRunPanel.tsx`，而它的 `FlowDone` 没有「失败节点」这个字段
   * （它收 `failed` 事件时只把那一行写进内部 `steps`，没往 `onDone` 里带）。
   * 退回这一层有语义依据，**不是猜**：失败策略是 `stop`（中断）时，
   * **失败的那个节点必然是最后开始跑的那个**，而 `ran` 按执行顺序追加。
   * 绝不会去日志字符串里抠节点 id。
   *
   * 若要精确到「失败节点自己的名字」，得让 `FlowRunPanel` 在 `FlowDone` 里多带
   * 一个 `stuckAt` —— 那是另一件事，已回报给 lead。
   *
   * @param name - 哪一份跑完了。
   * @param res - 收尾信息。
   */
  const onDone = useCallback((name: string, res: FlowDone): void => {
    const ok = res.ok === true && res.aborted !== true
    /* 卡在哪个节点（只在失败时留）。 */
    const ranList = res.ran ?? []
    const lastRan = ranList.length === 0 ? undefined : ranList[ranList.length - 1]
    const stuckAt = ok || lastRan === undefined ? undefined : { nodeId: lastRan }
    /* `runId` 是宿主半 `done` 载荷里的字段，`FlowRunPanel` 原样透传了整个载荷，
     * 所以这里读得到（`FlowDone` 类型里没声明它，用一层的结构断言取）。 */
    const rawRunId = (res as unknown as { runId?: unknown }).runId
    setSummary({
      name,
      ok,
      ran: ranList.length,
      error: res.error ?? '',
      outputs: res.declaredOutputs === undefined ? 0 : Object.keys(res.declaredOutputs).length,
      ...stuckAt === undefined ? {} : { stuckAt },
      ...typeof rawRunId === 'string' ? { runId: rawRunId } : {},
    })
    setRunning('')
    /* 跑完静默刷一次：卡片上的「最近一次」与记录数要跟上，
     * 不刷新的话用户会以为没跑（这是老版本就有的做法）。 */
    window.setTimeout(() => { refresh(true) }, 600)
  }, [refresh])

  /**
   * 新建采集：**复制一份存档改名**。
   *
   * 三步：读来源存档 → 换名字 → 存成新的一档。
   * 编号（`id`）由宿主半在保存时重新定，所以这里把它从副本里去掉 ——
   * 带着别人的编号存会让两份存档抢同一个编号。
   */
  const createCollector = useCallback((): void => {
    const name = newName.trim()
    if (sourceName === '') { setMsg({ tone: 'err', text: '先选一份要复制的来源' }); return }
    if (name === '') { setMsg({ tone: 'err', text: '新采集要有名字' }); return }
    if ((workflows ?? []).some(w => w.name === name)) {
      setMsg({ tone: 'err', text: '已经有叫「' + name + '」的工作流了，换个名字' })
      return
    }
    setBusy(true)
    void (async () => {
      const got = await call<{ doc?: unknown }>('/workflow?name=' + encodeURIComponent(sourceName))
      if (!got.ok || got.body?.doc === undefined) {
        setBusy(false)
        setMsg({ tone: 'err', text: '读不到来源存档：' + (got.error ?? '未知原因') })
        return
      }
      const doc = asObject(got.body.doc)
      const copy: Record<string, unknown> = { ...doc, name }
      delete copy.id
      const saved = await call<{ ok?: boolean, name?: string }>('/workflows', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, doc: copy }),
      })
      setBusy(false)
      if (!saved.ok) { setMsg({ tone: 'err', text: '保存失败：' + (saved.error ?? '未知原因') }); return }
      setMsg({ tone: 'ok', text: '已新建「' + (saved.body?.name ?? name) + '」：在「工作流 → 工作流管理」里可以进画布改它' })
      setCreating(false)
      setNewName('')
      refresh(true)
    })()
  }, [newName, sourceName, workflows, refresh])

  /** tab 条（板块自身没有注册 tab，所以这一层由板块自己画）。 */
  const tabBar = (
    <div className="mb-3 flex flex-none items-center gap-3">
      <SlidingTabs<TabId>
        tabs={TABS as unknown as { id: TabId, label: string }[]}
        value={tab}
        tabWidth={104}
        onChange={setTab}
      />
    </div>
  )

  /** 提示条（新建、执行的结果都从这里说，不静默）。 */
  const notice = msg === null
    ? null
    : (
      <div
        className={[
          'mb-3 flex-none rounded-ctl border px-3 py-2 font-mono text-ewb-caption',
          msg.tone === 'ok'
            ? 'border-[color-mix(in_oklab,var(--dsw-alias-state-success-primary)_35%,transparent)] text-[var(--dsw-alias-state-success-primary)]'
            : 'border-[color-mix(in_oklab,var(--dsw-alias-state-error-primary)_35%,transparent)] text-[var(--dsw-alias-state-error-primary)]',
        ].join(' ')}
      >{msg.text}</div>
    )

  /** 加载中 / 读不到（两种都只占一块，不占满整版）。 */
  const gate = loading
    ? <div className="p-6 text-center font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">加载中…</div>
    : err !== ''
      ? (
        <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-10">
          <div className="font-mono text-ewb-meta text-[var(--dsw-alias-state-error-primary)]">读不到取数数据</div>
          <div className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">{err}</div>
          <button type="button" className={BTN_QUIET} onClick={() => { refresh() }}>重试</button>
        </div>
      )
      : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tabBar}
      {notice}
      {gate}

      {/* ── 采集中心 ─────────────────────────────────────────── */}
      {!loading && err === '' && tab === 'center' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {/* 顶部 = 主操作区：左边主按钮，右边摘要与刷新。
           * ⚠️ **不做筛选条**（全部 / 一键 / 底层）：只有两份，筛它没意义。 */}
          <div className="mb-3 flex flex-none flex-wrap items-center gap-2">
            <button
              type="button"
              className={BTN}
              title="复制一份已有的采集工作流，改名成一档新的（改流程要进画布）"
              onClick={() => {
                setCreating(v => !v)
                setMsg(null)
                if (sourceName === '' && cards.length > 0) setSourceName(cards[0].w.name)
              }}
            >{creating ? '取消新建' : '新建采集'}</button>
            <span className="flex-1" />
            {digest !== '' && (
              <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" data-ewb-collect-digest="">
                {digest}
              </span>
            )}
            <button type="button" className={BTN_QUIET} title="重新读一次工作流清单与采集记录" onClick={() => { refresh() }}>刷新</button>
          </div>

          {creating && (
            <div className="mb-3 flex flex-none flex-col gap-2 rounded-card border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-3 py-3">
              <Label rule>新建采集（复制一份存档，改名）</Label>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">复制自</span>
                <select
                  className={INPUT}
                  value={sourceName}
                  onChange={e => {
                    const v = e.target.value
                    setSourceName(v)
                    /* 名字跟着来源给一个默认值，用户可以改 —— 不给默认值等于让用户手打一遍。 */
                    if (v !== '') setNewName(v + '-副本')
                  }}
                >
                  <option value="">（选一份）</option>
                  {(workflows ?? []).map(w => <option key={w.name} value={w.name}>{w.name}</option>)}
                </select>
                <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">新名字</span>
                <input
                  type="text"
                  className={INPUT}
                  placeholder="如 取数-天猫生意参谋-新店"
                  value={newName}
                  onChange={e => { setNewName(e.target.value) }}
                />
                <button type="button" className={BTN} disabled={busy} onClick={createCollector}>
                  {busy ? '保存中…' : '创建'}
                </button>
              </div>
              <div className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
                复制出来的是同一套节点，只换了名字。要改采集目标，进「工作流 → 工作流管理」打开它。
              </div>
            </div>
          )}

          {cards.length === 0
            ? (
              /* 空态：说清**缺什么**、下一步去哪，而不是一句「暂无数据」。 */
              <div className="flex flex-col items-start gap-2 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-8"
                data-ewb-collect-empty="">
                <div className="font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)]">还没有可执行的采集工作流</div>
                <div className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
                  这个板块只放两份：{COLLECT_ENTRIES.map(e => e.name).join('、')}
                  {missing.length > 0 ? '。现在缺 ' + missing.join('、') + '。' : '。'}
                </div>
                <div className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
                  下一步：去「工作流 → 工作流管理」用这两个名字新建（或打开已有存档改个名），回来点「刷新」。
                </div>
              </div>
            )
            : (
              <div className={CARD_GRID} data-ewb-collect-cards="">
                {cards.map(({ w, entry }) => {
                  const own = recordsOf(w.name)
                  const last = own[0]
                  const isRunning = running === w.name
                  const blocked = running !== '' && !isRunning
                  const sum = summary !== null && summary.name === w.name ? summary : null
                  return (
                    <div
                      key={w.name}
                      data-ewb-collect-card={w.name}
                      className="flex min-w-0 flex-col rounded-card border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-base)] px-3 py-2.5"
                    >
                      {/* 卡头：状态灯 + 名字 + 执行 */}
                      <div className="flex items-start gap-2">
                        <span
                          className={'dot ' + (isRunning ? 'ok pulse' : last === undefined ? 'off' : last.ok === false ? 'err' : 'ok')}
                          style={{ marginTop: 6 }}
                        />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate text-ewb-meta font-semibold text-[var(--dsw-alias-label-primary)]" title={w.name}>
                            {w.name}
                          </span>
                          <span className="font-mono text-ewb-caption leading-snug text-[var(--dsw-alias-label-tertiary)]">
                            {w.description === undefined || w.description === ''
                              ? (entry.note === '' ? '不在取数白名单里的工作流' : entry.note)
                              : w.description}
                          </span>
                        </div>
                        {/* ★ 票 05（2026-10-30）：开始节点是「只可被调用」的，**不给执行按钮**
                         * （跑了必然缺输入），但要说明为什么 —— 只不显示同样会让用户以为坏了。
                         * 判断照抄 `WorkflowList.tsx:1046-1067`：`'called'` 才拦，
                         * `null`（老存档没有开始节点）照旧给按钮。 */}
                        {w.startType === 'called'
                          ? (
                            <span
                              data-ewb-collect-called={w.name}
                              className="whitespace-nowrap rounded-full border border-[var(--dsw-alias-border-l2)] px-2.5 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]"
                              title="它的开始节点是「被另一个流程调用」—— 手动跑会缺输入，所以这里不给执行按钮。要跑它，用一份工作流里的「跑另一份工作流」节点。"
                            >只可被调用</span>
                          )
                          : (
                        <button
                          type="button"
                          className={BTN}
                          data-ewb-collect-run={w.name}
                          disabled={running !== ''}
                          /* 禁用时要说清**为什么** —— 只灰不说，用户会以为坏了。 */
                          title={blocked
                            ? '「' + running + '」正在跑，等它跑完再执行（几份取数抢同一个浏览器会话，同时跑会踢掉登录态）'
                            : isRunning
                              ? '正在跑，跑完会自动收起输出'
                              : '跑一次「' + w.name + '」（跑完写运行历史与采集记录）'}
                          onClick={() => { run(w.name) }}
                        >{isRunning ? '执行中…' : '执行'}</button>
                          )}
                      </div>

                      {/* 分隔线 + 最近一次（一盏灯一句话，不堆徽标） */}
                      <div className="mt-2 border-t border-[var(--dsw-alias-border-l2)] pt-1.5 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
                        {last === undefined
                          ? '最近：还没跑过'
                          : (
                            <>
                              {'最近：'}{when(last.at)}
                              {' · '}
                              <span className={last.ok === false ? 'text-[var(--dsw-alias-state-error-primary)]' : 'text-[var(--dsw-alias-state-success-primary)]'}>
                                {last.ok === false ? '失败' : '成功'}
                              </span>
                              {' · 交出 '}{Object.keys(last.outputs).length}{' 项'}
                              {own.length > 1 ? '（共 ' + String(own.length) + ' 次）' : ''}
                            </>
                          )}
                      </div>

                      {/* 上次交出了什么：露 2 行，多的折叠（用户要求「露 2 行，多的折叠」）。 */}
                      {last !== undefined && Object.keys(last.outputs).length > 0 && (
                        <div className="mt-1 flex flex-col gap-0.5">
                          {Object.entries(last.outputs).slice(0, 2).map(([k, v]) => (
                            <div key={k} className="truncate font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                              title={k + ' = ' + JSON.stringify(v)}>
                              <span className="text-[var(--dsw-alias-label-tertiary)]">{k}</span>
                              {' = '}{typeof v === 'string' ? v : JSON.stringify(v)}
                            </div>
                          ))}
                          {Object.keys(last.outputs).length > 2 && (
                            <div className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                              还有 {Object.keys(last.outputs).length - 2} 项（进「采集任务」看全部）
                            </div>
                          )}
                        </div>
                      )}

                      {/* 跑完留的那一行（输出区收起后，这张卡片还得看出「刚跑过」）。 */}
                      {sum !== null && !isRunning && (
                        <div
                          data-ewb-collect-summary=""
                          data-ewb-collect-summary-ok={sum.ok ? '1' : '0'}
                          className={
                            'mt-1.5 font-mono text-ewb-caption leading-relaxed ' +
                            (sum.ok
                              ? 'text-[var(--dsw-alias-state-success-primary)]'
                              : 'text-[var(--dsw-alias-state-error-primary)]')
                          }
                        >
                          {sum.ok
                            ? '跑完了：' + String(sum.ran) + ' 个节点成功，交出 ' + String(sum.outputs) + ' 项'
                            : '跑完了：中断 —— ' + (sum.error === '' ? '有节点失败' : sum.error) + '（已跑 ' + String(sum.ran) + ' 个节点）'}
                        </div>
                      )}

                      {/* ★ 失败详情（2026-10-23 契约 Y）：**不用离开任务中心**就知道为什么失败。
                       *
                       * ## 用户原话与我的取舍
                       *
                       * 「就算失败了也应该在任务中心界面显示完整流程。至少为什么失败要在任务中心
                       * 看得到，思考一下是应该做进节点中还是借用工作流的运行历史」。
                       *
                       * 取舍：**原因与停在哪个节点留在卡片上**（那是「为什么失败」的答案，
                       * 必须一眼可见），**每个节点的逐条日志不进卡片**（那是运行历史的活，
                       * 搬进来会变成第二个运行历史面板）。
                       *
                       * 所以这块给三样：一句原因、停在哪个节点、一行「去哪看完整明细」。
                       *
                       * ⚠️ 「逐条日志」那条路**这一批没接通**：跳到运行历史需要骨架暴露
                       * 「切到某个板块」的能力（`BoardProps` 里没有），而 `board-registry.ts`
                       * 不在本批可改范围。所以这里只**说明去哪看**，不做成假装能跳的按钮 ——
                       * 一个点了没反应的按钮比没有更糟。已回报给 lead 定。 */}
                      {sum !== null && !isRunning && !sum.ok && (
                        <div
                          data-ewb-collect-fail=""
                          className="mt-1.5 flex flex-col gap-1 rounded-ctl border border-[color-mix(in_oklab,var(--dsw-alias-state-error-primary)_35%,transparent)] px-2.5 py-2"
                        >
                          <div className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-state-error-primary)]"
                            data-ewb-collect-fail-reason="">
                            {'为什么失败：' + (sum.error === '' ? '有节点失败，宿主半没有给出原因' : sum.error)}
                          </div>
                          <div className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-secondary)]"
                            data-ewb-collect-fail-node="">
                            {sum.stuckAt === undefined
                              ? '停在哪个节点：宿主半没有报出具体节点（已跑 ' + String(sum.ran) + ' 个）'
                              : '停在哪个节点：' + (sum.stuckAt.label === undefined
                                ? sum.stuckAt.nodeId
                                : sum.stuckAt.label + '（' + sum.stuckAt.nodeId + '）')}
                          </div>
                          <div className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
                            这一份的逐条节点日志在「工作流 → 运行历史」里，按工作流名「{w.name}」找最近一次。
                          </div>
                        </div>
                      )}

                      {/* ★ 票 05（2026-10-30）：填输入的入口。
                       *
                       * 用户第 7 条：「任务创建后读取开始节点的设置项目，然后点击任务中心的
                       * 某个任务可以展开可选项执行」。所以点「执行」时先读开始节点声明：
                       * 有 `fields` 就在**这张卡片内部**长出这个表单（与输出区同一形态），
                       * 填完点「开始执行」才真的跑。
                       *
                       * ⚠️ 用的就是现成的 `RunInputForm`（票面明令「不要新写一套表单」）——
                       * 它的必填拦截、缺项点名、默认值都是现成的。 */}
                      {inputAsk !== null && inputAsk.name === w.name && !isRunning && (
                        <div className="mt-2" data-ewb-collect-input={w.name}>
                          <RunInputForm
                            name={w.name}
                            fields={inputAsk.fields}
                            onSubmit={inputs => { startRun(w.name, inputs) }}
                            onCancel={() => { setInputAsk(null) }}
                          />
                        </div>
                      )}

                      {/* ★ 就地展开的输出区（点执行后出现在**这张卡片内部**）。
                       * 复用 `FlowRunPanel`（现成 SSE 组件），不动它内部实现。 */}
                      {isRunning && (
                        <div className="mt-2" data-ewb-collect-runpanel={w.name}>
                          <FlowRunPanel
                            name={w.name}
                            inputs={runInputs}
                            /* ★ 票 05：**只显示汇报**（任务记录），不显示节点级运行历史。
                             * 用户原话：「工作流在跑的时候下半部分显示不是任务记录类型的
                             * 工作输出，而是运行历史类型的」—— 这一行就是那件事的开关。
                             * 默认模式（画布 / 列表页）不传这个参数，行为一个字节不变。 */
                            reportsOnly
                            onClose={() => { setRunning('') }}
                            onDone={res => { onDone(w.name, res) }}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
        </div>
      )}

      {/* ── 定时任务（原独立「定时」板块整块搬进来，2026-10-23）────────
       *
       * ⚠️ 这里**不是重画一遍界面**，而是直接挂 `ScheduleBoard` ——
       * 复制一份界面的话，两处迟早会漂（本项目踩过「同一件事写两份」的坑）。
       *
       * ⚠️ 传 `active` 时只看**这一格现在是不是显示着**：
       * 挂在「任务中心」那一格时它是 false，于是 `ScheduleBoard` 内部
       * 不会因为 `active` 变化去白跑请求（它的 `active` 约定就是这个意思）。
       *
       * ⚠️ 不加 `keepMounted`：切到别的格就卸载、切回来重新读一次任务表。
       * 定时任务表是几十行的轻数据，重读一次比让它常驻便宜 ——
       * 而且不常驻才不会出现「在别处改了任务表、这一格还是旧的」。 */}
      {tab === 'scheduled' && (
        <div className="flex min-h-0 flex-1 flex-col" data-ewb-collect-tab="scheduled">
          <ScheduleBoard
            active={active}
            tab=""
            apiBase="/api/ecom-workbench"
            topHidden={false}
            onToggleTop={() => {}}
            onSelectTab={() => {}}
            onRunWorkflow={() => {}}
          />
        </div>
      )}

      {/* ── 任务记录（原「采集任务」，记录倒序）─────────────────────
       *
       * ## 这一格是什么、不是什么（2026-10-23 用户特意强调）
       *
       * 用户原话：「自动化的任务记录和任务中心显示应该是一个逻辑，任务记录只是存档备案，
       * 任务记录的样式改成工作流的运行历史的样式。注意！他们显示的内容不一样，
       * 只是样式一样，要明确两个不同的内容」。
       *
       * | | 任务记录（这里） | 工作流的运行历史 |
       * | --- | --- | --- |
       * | 回答 | **这次交出了什么**（`outputs` 的键值） | 每一步跑了什么（节点日志） |
       * | 粒度 | 一份工作流一次 | 一次运行里的每个节点 |
       * | 数据 | `/collect/records` | `/workflow/runs` |
       *
       * **样式照抄，内容不合并。** 复用 `EcomWorkbench.module.css` 的
       * `histRow` / `histRowHead` / `histState` / `histName` / `histMeta` /
       * `histBlock` / `histPre` 这一套（运行历史也在用，所以那些类的值不许改），
       * 这样两处读起来是同一种东西，用户不必学两套。
       *
       * ⚠️ 但那几个类是**运行历史**的资产：这里只是「借用外观」，
       * 不要把任务记录的内容往节点日志的方向改（那才是把两者混起来）。 */}
      {!loading && err === '' && tab === 'tasks' && (
        <div className={`${css.histList}`} data-ewb-collect-records=""
          style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
          {latestRecords.length === 0
            ? (
              <div className={css.histEmpty}>
                还没有采集记录。跑完之后，「结束节点」声明的产出会落到这里。
              </div>
            )
            : latestRecords.map(r => {
              const keys = Object.keys(r.outputs)
              const key = r.workflow + '/' + r.file
              const open = openRecord === key
              /* ★ 汇报优先（2026-10-25 契约 AO）：归档时两条只写一条，
               * 有汇报就没有 `outputs`。所以这里是二选一，不是叠加。 */
              const reports = r.reports !== undefined && r.reports.length > 0 ? r.reports : undefined
              /* 状态字与配色：照运行历史那套（`hist_ok` 青绿 / `hist_error` 红）。 */
              const tone = r.ok === false ? 'error' : 'ok'
              return (
                <div key={key}
                  className={css.histRow + ' ' + css['hist_' + tone]}
                  data-ewb-collect-record={key}>
                  <button
                    type="button"
                    className={css.histRowHead}
                    data-ewb-collect-record-head=""
                    aria-expanded={open}
                    onClick={() => { setOpenRecord(open ? null : key) }}
                  >
                    <span className={css.histState}>{r.ok === false ? '失败' : '成功'}</span>
                    <span className={css.histName} title={r.file}>{r.workflow}</span>
                    <span className={css.histMeta}>{when(r.at)}</span>
                    <span className={css.histMeta}>{reports !== undefined ? reports.length + ' 条汇报' : keys.length + ' 项产出'}</span>
                    <span className={css.histCaret}>{open ? '▾' : '▸'}</span>
                  </button>
                  {/* ★ 失败原因露在**行头下面一行**，不展开也看得到（2026-10-23 契约 AE）。
                   *
                   * ## 为什么不塞在 `histState` 与 `histName` 之间
                   *
                   * 那个位置是**一行 flex**：原因再短也可能很长（「登录态失效，页面跳回登录页」
                   * 这种），塞进去会把工作流名与时间挤走 —— 一行三件事抢位置，
                   * 最后三件都看不清。
                   *
                   * 所以放成**行头之下独立一行**：行头保持「状态 / 名字 / 时间 / 产出数」
                   * 四个字位不动，原因单独一行、单行截断、悬停看全文。
                   * 用户「日后翻记录时不用再回运行历史找」要的就是**看得见有原因**，
                   * 而「看清全部」由展开区负责（两个需求，两处地方）。
                   *
                   * ## 三种情况各是什么
                   *
                   * | 记录 | 显示 |
                   * | --- | --- |
                   * | 成功 | **什么都不渲染**（没有原因这回事） |
                   * | 失败 + 有 `error` | `为什么失败：<原因>`（截断一行，`title` 全文） |
                   * | 失败 + 无 `error` 键（老记录） | `为什么失败：这条记录没有留下原因` —— 不静默、不显示成空白、更不显示成成功 |
                   *
                   * ⚠️ 用词与任务中心那张卡片的失败详情块**必须一致**（都用「为什么失败：」）
                   * —— 同一个概念不造两个词。 */}
                  {r.ok === false && (
                    <div
                      className={`${css.histMeta} truncate`}
                      data-ewb-collect-record-error=""
                      title={typeof r.error === 'string' && r.error !== ''
                        ? r.error
                        : '这条记录没有留下原因（契约 AD 之前写的记录不含这个字段）'}
                    >
                      {typeof r.error === 'string' && r.error !== ''
                        ? '为什么失败：' + r.error
                        : '为什么失败：这条记录没有留下原因'}
                    </div>
                  )}
                  {/* ★ 展开后是**这次交出了什么**（`outputs` 的键值），不是节点日志。
                   * 这正是「样式一样、内容不同」那条要求的落点。 */}
                  {open && (
                    <div className={css.histBody}>
                      {/* ★ 完整失败原因（不截断）—— 2026-10-23 契约 AE。
                       *
                       * 行头上那一行是**截断**的（保一行的高度），
                       * 展开区这里给**全文**。两个需求分开：
                       *   · 行头 → 「有没有原因」一眼可见（日常翻记录够用）；
                       *   · 展开 → 「原因到底是什么」看全（排查时要全文）。
                       *
                       * 行头已经能看全时这里也不重复 —— 判断依据是 `title` 与正文是否
                       * 真的一致太脆；这里统一给全文，因为展开本来就是「我要细看」的动作。
                       *
                       * 老记录（没有 `error` 键）在这里也照实说，不留空白。 */}
                      {r.ok === false && (
                        <div className={css.histBlock}>
                          <div className={css.histBlockTitle}>为什么失败（完整原因）</div>
                          <pre className={css.histPre} data-ewb-collect-record-error-full="">
                            {typeof r.error === 'string' && r.error !== ''
                              ? r.error
                              : '这条记录没有留下原因 —— 它是契约 AD 之前写下的记录，'
                                + '那个版本不往记录里写 error 字段。要查那一次为什么失败，'
                                + '只能在「工作流 → 运行历史」里按工作流名找当时那次运行的日志。'}
                          </pre>
                        </div>
                      )}
                      {/* ★ 汇报优先（2026-10-25 契约 AO）。
                       *
                       * 两条路二选一：有 `reports` 就显示汇报，没有才退回旧的 `outputs`。
                       * **不是两个都显示** —— 归档时只会写其中一个（`records.ts:78-83`），
                       * 两个都渲染的后果是用户以为这次交了两份东西。 */}
                      {reports !== undefined
                        ? (
                          <div className={css.histBlock} data-ewb-collect-record-reports="">
                            <div className={css.histBlockTitle}>
                              汇报（{reports.length} 条）· 这份记录的文件：{r.file}
                            </div>
                            <div className={css.rpList}>
                              {reports.map((rp, i) => (
                                <div key={i}
                                  className={css.rpItem + ' ' + css['rp_' + (rp.type ?? 'info')]}
                                  data-ewb-collect-report=""
                                  data-ewb-collect-report-type={rp.type ?? 'info'}>
                                  {rp.item !== undefined && rp.item !== '' && (
                                    <span className={css.rpItemTag}>{rp.item}</span>
                                  )}
                                  <span className={css.rpMsg}>{rp.message}</span>
                                  {rp.metrics !== undefined && (
                                    <span className={css.rpMetrics}>
                                      {Object.entries(rp.metrics).map(([k, v]) => (
                                        <span key={k} className={css.rpMetric}>
                                          <span className={css.rpMetricKey}>{k}</span>
                                          {' '}
                                          <span className={css.rpMetricVal}>{String(v)}</span>
                                        </span>
                                      ))}
                                    </span>
                                  )}
                                  {rp.files !== undefined && rp.files.length > 0 && (
                                    <span className={css.rpFiles}>
                                      {rp.files.map(f => <span key={f} className={css.rpFile}>{f}</span>)}
                                    </span>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )
                        : (
                          <div className={css.histBlock}>
                            <div className={css.histBlockTitle}>
                              交出的产出（{keys.length} 项）· 这份记录的文件：{r.file}
                            </div>
                            {keys.length === 0
                              ? (
                                <div className={css.histEmpty} data-ewb-collect-record-empty="">
                                  这次没有交出任何产出。
                                </div>
                              )
                              : (
                                <pre className={css.histPre} data-ewb-collect-record-outputs="">{keys
                                  .map(k => k + ' = ' + JSON.stringify(r.outputs[k]))
                                  .join('\n')}</pre>
                              )}
                          </div>
                        )}
                      <div className={css.histBlockTitle} style={{ marginTop: 8 }}>
                        每一节点的逐条日志不在这里 —— 在「工作流 → 运行历史」里按工作流名找。
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}
