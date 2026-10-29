/** 总览板块：**显示数据本身**（票 07，2026-10-30）。
 *
 * # 用户原话（第 9 条）
 *
 * 「总览界面的逻辑需要重新设计，这里应该是显示数据，而不是有没有采集，产物有没有交出，
 * 采集是否成功，这都不是重点，关于采集成功与否显示一个**当前数据是什么时候更新的**即可
 * （更新没有成功不要更新数据，即不是跑了就更新数据，而是成功拿到数据才更新数据。）」
 *
 * 第二块拍板：「总览第二块『今日关键数字』。目前有采集的都要放」。
 *
 * # 所以这一屏的层次变了
 *
 * ```
 * ① 当前数据更新于 …            ← 一句话，不是一堆成败徽标
 * ② 每份巡查一句话状态          ← 采到 N 项 / 未采到 / 格式不对 / 还没跑过
 * ③ 指标格子（按块分组）        ← 主角：数字本身
 * ④ 看板网格（原样保留）        ← 原来是主角，现在退到第二屏，不改判据
 * ```
 *
 * 改前这一屏是「看板」唱主角：每块显示「最近一次跑得怎么样、交出了什么」。
 * 那是**执行视角**，用户明确说不是重点。所以现在「成没成 / 交了什么」只在
 * 来源那一行用一句话交代，主展示位给了数字。
 *
 * # 四类必须分开（这是本票最容易做错的地方）
 *
 * 「没采到」不是一件事，是四件：
 *
 * | 类 | 例子（2026-10-30 实测） | 界面上那句话 |
 * |---|---|---|
 * | 采到了 | 天猫 9 项、千川 1 项 | 显示数字 |
 * | 跑了但一项没采到 | 抖音店铺那 11 项全是 `—` | 「本份巡查未采到指标」 |
 * | 有文件读不出 | 天猫活动报名（形状错） | 「这份结果格式不对，读不出指标」 |
 * | 文件不存在 | 抖音活动报名 | 「这份还没跑过」 |
 *
 * 合成一句的话，「这份坏了」与「这份还没跑过」在界面上分不清 —— 而它们的
 * 下一步动作完全不同（一个去看为什么坏，一个去跑一次）。
 *
 * # 什么叫「采到了」
 *
 * 判据是**项自己的** `state !== 'unknown'` 且 `value !== '—'`，
 * **不看那一份结果的整体 `ok`**。
 *
 * ## 为什么不看整体 `ok`
 *
 * `ok` 说的是「这一趟巡查本身有没有出错」，项上的 `state` 才是「这一项采到没有」。
 * 实测反例：`patrol-dy-qianchuan.json` 是 `ok: false`（四项里三项没匹配到），
 * 但「今日成交金额 0.00 元」那一项是真采到的 —— 按 `ok` 一刀切会把这条真数据显示丢掉。
 *
 * 而且用户那句话讲的就是这个粒度：「**成功拿到数据**才更新数据」——
 * 一项拿到了就是拿到了，没拿到的那项自己会带 `state: 'unknown'`。
 *
 * # 「当前数据更新于」只认成功的那几趟
 *
 * ⚠️ 与上面那条**不是**同一个判据，别混：
 * 指标格子看**项**的 `state`，「更新于」看**那一趟**的 `ok`。
 * `ok === false` 的那份不参与「更新于」（那是失败的一次，不能推进时间），
 * 但它里面真采到的项照样进格子。
 *
 * ## 一处这一层做不到的事（写清，免得下一个人以为是 bug）
 *
 * 票面要求「失败不覆盖上一次成功的内容」。**在只读接口这一层做不到**：
 * `patrol/` 里每份巡查只有**一个**文件，失败那趟是**覆盖写**，
 * 上一次成功的内容在盘上已经没了，接口拿不到就只能给空。
 * 要做到内容也不被覆盖，得在**写入侧**留一份上一次成功的快照 ——
 * 那是工作台·工作流的地盘。这里能做到的是：时间不推进（下面那行），
 * 且**不拿失败那趟的 `dataDate` 冒充**当前数据日期。
 *
 * # 数据从哪来（三处，各回答一个问题）
 *
 * | 要什么 | 从哪读 |
 * | --- | --- |
 * | 指标明细（主角） | `GET /patrol/results`（票 11 新开的只读路由，三栏） |
 * | 看板是哪几份 | `GET /workflows` 里名字以「巡查-」开头的 |
 * | 每份最近一次的结果（看板用） | `GET /workflow/runs?name=<名字>` |
 *
 * ⚠️ **不许**用 `GET /workflow/runs` 去拿数字：那是运行历史，只有「成没成、跑多久」。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BoardProps } from './board-registry.ts'
import { asArray, asObject, call, isPatrol, when } from './board-kit.ts'
import { Badge, Label } from './terminal.tsx'
import { FlowRunPanel } from './FlowRunPanel.tsx'
import type { FlowDone } from './FlowRunPanel.tsx'

/** 工作流列表里的一条。 */
interface WorkflowItem {
  name: string
  description?: string
}

/** 一次运行的记录（宿主半 `WorkflowRun` 的子集，只取这里要用的）。 */
interface RunRecord {
  id: string
  name: string
  startedAt?: number
  endedAt?: number
  ok?: boolean
  aborted?: boolean
  error?: string
  waiting?: boolean
  outputs?: Record<string, unknown>
}

/** 一块看板。 */
interface Board {
  /** 工作流名（也是看板标题）。 */
  name: string
  /** 最近一次运行（没跑过为 undefined）。 */
  last?: RunRecord
  /** 这次交出的产出（键 = 结束节点声明的名字）。 */
  outputs: Record<string, unknown>
}

/* ══════════════════════════════════════════════════════════════════════
 * 巡查结果（`GET /patrol/results` 的形状，名字照 `src/schedule/patrol-results.ts`）
 * ══════════════════════════════════════════════════════════════════════ */

/** 一格指标（`blocks[].items[]` 的一项，字段原样透传）。 */
interface MetricItem {
  label: string
  value: string
  state: string
  note?: string
}

/** 一个指标块（`blocks[]` 的一块）。 */
interface MetricBlock {
  title: string
  items: MetricItem[]
}

/** 一份正常的巡查结果。 */
interface PatrolOne {
  file: string
  name: string
  platform: string
  runAt: string
  dataDate: string
  ok: boolean | null
  error: string | null
  blocks: MetricBlock[]
}

/** 三栏。 */
interface PatrolAll {
  items: PatrolOne[]
  broken: { file: string, name: string, why: string }[]
  missing: { file: string, name: string }[]
}

/** 一份巡查在界面上属于哪一类（四类分开）。 */
type SourceState = 'metrics' | 'none' | 'broken' | 'missing'

/** 来源那一行要显示的东西。 */
interface SourceLine {
  /** 面板显示名。 */
  name: string
  /** 哪一类。 */
  state: SourceState
  /** 采到几项（`state === 'metrics'` 时才有意义）。 */
  got: number
}

/** 一组指标格子。 */
interface MetricGroup {
  /** `block.title`。 */
  title: string
  /** 组内的格子（已按「采到了」筛过）。 */
  cells: MetricItem[]
}

/**
 * 这一格**真采到了吗**。
 *
 * 判据两条都要成立：`state !== 'unknown'` **且** `value !== '—'`。
 *
 * ## 为什么两条都要（缺一条就有假数据进格子）
 *
 * 实测 `patrol-dy-shop.json` 里「待发货」是 `state: 'ok'` 但 `value: '—'`
 * —— 只看 `state` 的话，一个破折号会被当成「采到了」摆进格子，
 * 而它恰恰是「没匹配到」。
 *
 * @param item - 一格。
 * @returns 采到了则 true。
 */
export function capturesValue(item: MetricItem): boolean {
  return item.state !== 'unknown' && item.value.trim() !== '' && item.value.trim() !== '—'
}

/**
 * 把一份结果拆成「采到的格子」与「采到几项」。
 *
 * 导出的理由是判据 1 / 3 / 4 要能**直接**验这条口径，不必绕界面
 * （界面那一层只能看形状，看不出「该不该显示」）。
 *
 * @param one - 一份结果。
 * @returns 采到的块（空块不出现）。
 */
export function metricGroupsOf(one: PatrolOne): MetricGroup[] {
  const out: MetricGroup[] = []
  for (const b of one.blocks) {
    const cells = b.items.filter(capturesValue)
    if (cells.length > 0) out.push({ title: b.title, cells })
  }
  return out
}

/**
 * `runAt`（ISO 字符串）→ 「今天 14:03」那种句子；解析不出来就原样给。
 *
 * 为什么要有这一层：`runAt` 在文件里是 `2026-10-19T22:54:00.205Z` 这种
 * 带时区的字符串，直接摆出来没人看得懂「是哪天几点」。`when()` 那个
 * 格式化函数只吃毫秒时间戳，所以先解析。
 *
 * @param runAt - 原始字符串。
 * @returns 给人看的时间。
 */
export function showRunAt(runAt: string): string {
  const ms = Date.parse(runAt)
  return Number.isFinite(ms) ? when(ms) : runAt
}

/** 主按钮（刷新 = 真跑一次，它是这一屏唯一的主操作）。 */
const BTN = [
  'pressable is-dark shrink-0 whitespace-nowrap rounded-ctl border px-2.5 py-1.5',
  'border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)] text-[var(--ewb-accent)]',
  'font-mono text-ewb-caption leading-none disabled:opacity-45',
].join(' ')

/** 次要按钮。 */
const BTN_QUIET = [
  'pressable is-dark shrink-0 whitespace-nowrap rounded-ctl border border-[var(--dsw-alias-border-l2)]',
  'px-2.5 py-1.5 font-mono text-ewb-caption leading-none text-[var(--dsw-alias-label-tertiary)] disabled:opacity-45',
].join(' ')

/**
 * 一块看板里「最近一次交出了什么」该显示几行。
 *
 * 露三行、多的折叠：产出常常是五六个字段，全铺开会把整屏撑长，
 * 而看板的用处是**扫一眼**，细节该去运行历史里看。
 */
const SHOW_OUTPUTS = 3

/** 四类各自的**一句话**（不许混成一句 —— 下一步动作完全不同）。 */
const SOURCE_TEXT: Record<SourceState, string> = {
  metrics: '采到指标',
  none: '本份巡查未采到指标',
  broken: '这份结果格式不对，读不出指标',
  missing: '这份还没跑过',
}

/** 状态灯的档位（**只看这一类的结局**，不掺别的）。 */
function toneOf(b: Board): 'ok' | 'warn' | 'err' | 'off' {
  if (b.last === undefined) return 'off'
  if (b.last.waiting === true) return 'warn'
  if (b.last.ok === false) return 'err'
  return 'ok'
}

/** 一句话说清这次怎么样（状态灯旁边的字）。 */
function verdictOf(b: Board): string {
  if (b.last === undefined) return '还没跑过'
  if (b.last.waiting === true) return '等待中'
  if (b.last.ok === false) return '失败'
  if (b.last.aborted === true) return '中断'
  return '成功'
}

/**
 * 总览板块。
 * @param props - 骨架给板块的入参（这块只用 `active`）。
 * @returns 界面。
 */
export function OverviewBoard({ active }: BoardProps): React.JSX.Element {
  const [cards, setCards] = useState<Board[]>([])
  /** 巡查结果三栏（`null` = 还没读到）。 */
  const [patrol, setPatrol] = useState<PatrolAll | null>(null)
  /** 巡查结果读不到的原因（**不挡看板**：指标那一层坏了，运行层照样能看）。 */
  const [patrolErr, setPatrolErr] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  /** 正在跑的那一份（空串 = 没有在跑）。 */
  const [running, setRunning] = useState('')
  /** 这一份跑完之后卡片上留的那一行汇总。 */
  const [summary, setSummary] = useState<{ name: string, ok: boolean, text: string } | null>(null)

  /**
   * 拉一次全部数据（巡查结果 + 看板）。
   * @param silent - 不显示加载态（跑完刷新时用）。
   */
  const refresh = useCallback((silent = false): void => {
    if (!silent) setLoading(true)
    void (async () => {
      /* 两条路**并行**读：一条读指标（主角），一条读运行层（看板）。
       * 分开处理失败 —— 巡查结果读不到不该让整页只剩一个错误页。 */
      const [wf, pr] = await Promise.all([
        call<{ items?: unknown }>('/workflows'),
        call<{ items?: unknown, broken?: unknown, missing?: unknown }>('/patrol/results'),
      ])
      if (!wf.ok) { setErr(wf.error ?? '读不到工作流清单'); setLoading(false); return }
      setErr('')

      /* ── 巡查结果：形状不可信，逐层判类型（它与看板各自独立，坏了只影响自己那块）。 ── */
      if (!pr.ok) {
        setPatrolErr(pr.error ?? '读不到巡查结果')
        setPatrol(null)
      } else {
        setPatrolErr('')
        setPatrol({
          items: asArray(pr.body?.items).map(x => {
            const o = asObject(x)
            return {
              file: typeof o.file === 'string' ? o.file : '',
              name: typeof o.name === 'string' ? o.name : '',
              platform: typeof o.platform === 'string' ? o.platform : '',
              runAt: typeof o.runAt === 'string' ? o.runAt : '',
              dataDate: typeof o.dataDate === 'string' ? o.dataDate : '',
              ok: typeof o.ok === 'boolean' ? o.ok : null,
              error: typeof o.error === 'string' ? o.error : null,
              blocks: asArray(o.blocks).map(b => {
                const bo = asObject(b)
                return {
                  title: typeof bo.title === 'string' && bo.title !== '' ? bo.title : '未命名',
                  items: asArray(bo.items).map(it => {
                    const io = asObject(it)
                    return {
                      label: typeof io.label === 'string' ? io.label : '',
                      /* ⚠️ 单位不许在这里加：`value` 里已经带了（`¥0` / `0.00 元` / `5.00`）。 */
                      value: typeof io.value === 'string' ? io.value : String(io.value ?? ''),
                      state: typeof io.state === 'string' ? io.state : 'unknown',
                      ...typeof io.note === 'string' && io.note !== '' ? { note: io.note } : {},
                    }
                  }),
                }
              }),
            }
          }),
          broken: asArray(pr.body?.broken).map(x => {
            const o = asObject(x)
            return {
              file: typeof o.file === 'string' ? o.file : '',
              name: typeof o.name === 'string' ? o.name : '',
              why: typeof o.why === 'string' ? o.why : '',
            }
          }),
          missing: asArray(pr.body?.missing).map(x => {
            const o = asObject(x)
            return { file: typeof o.file === 'string' ? o.file : '', name: typeof o.name === 'string' ? o.name : '' }
          }),
        })
      }

      /* ── 看板：判据与宿主半、与自动化板块同一条（名字以「巡查-」开头）。 ── */
      const items = asArray(wf.body?.items).map(x => {
        const o = asObject(x)
        return {
          name: typeof o.name === 'string' ? o.name : '',
          ...typeof o.description === 'string' ? { description: o.description } : {},
        }
      })
      const names = items.filter(w => isPatrol(w.name)).map(w => w.name)

      const next: Board[] = []
      for (const name of names) {
        const runs = await call<{ runs?: unknown }>('/workflow/runs?name=' + encodeURIComponent(name))
        const list = runs.ok ? asArray(runs.body?.runs).map(x => asObject(x) as unknown as RunRecord) : []
        const last = list.length > 0 ? list[0] : undefined
        next.push({
          name,
          ...last === undefined ? {} : { last },
          outputs: last?.outputs === undefined ? {} : asObject(last.outputs),
        })
      }
      setCards(next)
      setLoading(false)
    })()
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { if (active) refresh(true) }, [active, refresh])

  /**
   * 点「刷新」→ **真的跑一次**那份工作流。
   *
   * ## 为什么走 `FlowRunPanel` 而不是直接 fetch
   *
   * `FlowRunPanel` 是现成的 SSE 组件：它自己订阅 `/workflow/run-stream`，
   * 边跑边把每一步刷出来。自己再写一遍等于两套跑法，迟早漂
   * （项目踩过「同一件事写两份」的坑）。
   *
   * ⚠️ 它跑完会回调 `onDone`，这里据此：清 `running`（输出区随之收起）、
   * 留一行汇总、并静默重读一次数据（否则「最近一次」还是旧的）。
   *
   * @param name - 工作流名。
   */
  const run = useCallback((name: string): void => {
    setRunning(name)
    setSummary(null)
  }, [])

  /** 跑完的收尾（输出区收起 + 留一行 + 重读）。 */
  const onDone = useCallback((name: string, res: FlowDone): void => {
    const ok = res.ok === true && res.aborted !== true
    const outs = res.declaredOutputs === undefined ? 0 : Object.keys(res.declaredOutputs).length
    setSummary({
      name,
      ok,
      text: ok
        ? '跑完了：' + String(outs) + ' 项产出'
        : '跑完了：中断 —— ' + (res.error === undefined || res.error === '' ? '有节点失败' : res.error),
    })
    setRunning('')
    window.setTimeout(() => { refresh(true) }, 600)
  }, [refresh])

  /** 有看板在跑时，其余的按钮要禁用（几份抢同一个浏览器会话）。 */
  const blocked = running !== ''

  /** 有没有一块真的跑过（决定「全都还没跑过」那句空态提示要不要出现）。 */
  const anyRan = useMemo(() => cards.some(c => c.last !== undefined), [cards])

  /**
   * 每份巡查那一句话（四类分开，顺序：先有数字的，再没采到的，再坏的，再没跑过的）。
   *
   * ⚠️ **不许把 `broken` 与 `missing` 合成一句** —— 下一步动作完全不同。
   */
  const sources = useMemo<SourceLine[]>(() => {
    if (patrol === null) return []
    const rank: Record<SourceState, number> = { metrics: 0, none: 1, broken: 2, missing: 3 }
    const out: SourceLine[] = [
      ...patrol.items.map(o => {
        const got = metricGroupsOf(o).reduce((n, g) => n + g.cells.length, 0)
        return { name: o.name, state: got > 0 ? 'metrics' : 'none', got } as SourceLine
      }),
      ...patrol.broken.map(b => ({ name: b.name, state: 'broken', got: 0 }) as SourceLine),
      ...patrol.missing.map(m => ({ name: m.name, state: 'missing', got: 0 }) as SourceLine),
    ]
    return out.sort((a, b) => (rank[a.state] - rank[b.state]))
  }, [patrol])

  /**
   * 指标格子，按 `block.title` 分组。
   *
   * 同名块（比如两份结果都有一块叫「天猫」）合并成一组 —— 它们是同一件事。
   */
  const groups = useMemo<MetricGroup[]>(() => {
    if (patrol === null) return []
    const byTitle = new Map<string, MetricItem[]>()
    for (const one of patrol.items) {
      for (const g of metricGroupsOf(one)) {
        const cur = byTitle.get(g.title)
        if (cur === undefined) byTitle.set(g.title, [...g.cells])
        else cur.push(...g.cells)
      }
    }
    return [...byTitle.entries()].map(([title, cells]) => ({ title, cells }))
  }, [patrol])

  /**
   * 「当前数据更新于」用哪一份、哪个时间。
   *
   * ## 判据三条（缺一条就会显示假时间）
   *
   *   ① 那一趟**没失败**（`ok !== false`）—— 失败的一次不推进时间；
   *   ② 那一趟**真采到了数据**（至少一块有 `capturesValue` 的项）——
   *      用户原话是「不是跑了就更新数据，而是**成功拿到数据**才更新数据」。
   *      ⚠️ 这一条是本票里**最容易漏**的一条：抖音店铺那份 `ok: true`、跑成功了，
   *      但 11 项全是 `—`。只看 `ok` 的话屏上会写「当前数据更新于 10-22」，
   *      而格子里真正显示的数字是**天猫 10-19** 的 —— 时间与内容对不上，
   *      看起来对，实际是错的。
   *   ③ 在满足①②的里面取 `runAt` 最新的那一份；一份都没有 → `null`，
   *      界面说「还没有可用数据」，**不许**拿失败那趟的时间冒充。
   *
   * ⚠️ `ok: null`（文件里没写这个键）算「没说不成功」，照常参与 ——
   * 老结果文件没有这个字段，把它当失败会让一批真数据消失。
   */
  const updated = useMemo<{ name: string, text: string } | null>(() => {
    if (patrol === null) return null
    let best: { name: string, ms: number, text: string } | null = null
    for (const one of patrol.items) {
      if (one.ok === false) continue
      /* ② 一项都没采到的那趟不算「数据更新」。 */
      if (metricGroupsOf(one).length === 0) continue
      const ms = Date.parse(one.runAt)
      const text = Number.isFinite(ms) ? when(ms) : (one.dataDate !== '' ? one.dataDate : '时间不明')
      const key = Number.isFinite(ms) ? ms : 0
      if (best === null || key > best.ms) best = { name: one.name, ms: key, text }
    }
    return best === null ? null : { name: best.name, text: best.text }
  }, [patrol])

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="p-6 text-center font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">加载中…</div>
      </div>
    )
  }

  if (err !== '') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center gap-2 pt-10">
        <div className="font-mono text-ewb-meta text-[var(--dsw-alias-state-error-primary)]">读不到总览数据</div>
        <div className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">{err}</div>
        <button type="button" className={BTN_QUIET} onClick={() => { refresh() }}>重试</button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/* ══════════════════════════════════════════════════════════════
       * ① 数据（主角）：当前更新于 + 每份巡查一句话 + 指标格子
       * ══════════════════════════════════════════════════════════════ */}
      <div data-ewb-ov="" className="mb-5 flex flex-none flex-col gap-3">

        {/* ── 当前数据更新于（一句话，不是一堆成败徽标）── */}
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--dsw-alias-border-l2)] pb-2">
          <Label rule>数据</Label>
          {updated === null
            ? (
              <span
                data-ewb-ov-nodata=""
                className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]"
              >还没有可用数据</span>
            )
            : (
              <span
                data-ewb-ov-updated={updated.name}
                className="font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
              >
                当前数据更新于 {updated.text}
              </span>
            )}
          <span className="flex-1" />
          {patrolErr !== '' && (
            <span
              data-ewb-ov-patrol-err=""
              className="font-mono text-ewb-caption text-[var(--dsw-alias-state-error-primary)]"
            >{patrolErr}</span>
          )}
        </div>

        {/* ── 每份巡查一句话（四类分开，缺哪类说哪类）── */}
        {sources.length > 0 && (
          <div data-ewb-ov-sources="" className="flex flex-col gap-0.5">
            {sources.map(s => (
              <div
                key={s.name}
                data-ewb-ov-source={s.name}
                data-ewb-ov-source-state={s.state}
                className="flex items-baseline gap-1.5 font-mono text-ewb-caption leading-relaxed"
              >
                <span className="shrink-0 text-[var(--dsw-alias-label-tertiary)]">{s.name}</span>
                <span className="shrink-0 text-[var(--dsw-alias-label-tertiary)]">·</span>
                <span className={
                  s.state === 'metrics' ? 'text-[var(--dsw-alias-label-secondary)]'
                    : s.state === 'broken' ? 'text-[var(--dsw-alias-state-warn-primary)]'
                      : 'text-[var(--dsw-alias-label-tertiary)]'
                }>
                  {s.state === 'metrics' ? '采到 ' + String(s.got) + ' 项指标' : SOURCE_TEXT[s.state]}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* ── 指标格子：按 block.title 分组，宽屏并排、窄屏单列 ──
         * ⚠️ 栅格用 `repeat(auto-fit, minmax(...))`，**不用 Tailwind 断点变体**：
         * 断点变体要给每个尺寸各写一套类名，而这里只需要一句「装得下就并排」。 */}
        {groups.length === 0
          ? (
            <div
              data-ewb-ov-metrics-empty=""
              className="flex flex-col items-start gap-1 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-6"
            >
              <div className="font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)]">还没有采到任何指标</div>
              <div className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
                跑一次巡查之后，这份结果里采到的数字会出现在这里；没采到的项不会占位置。
              </div>
            </div>
          )
          : (
            <div
              data-ewb-ov-metrics=""
              className="grid gap-3"
              style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}
            >
              {groups.map(g => (
                <div
                  key={g.title}
                  data-ewb-ov-group={g.title}
                  className="flex min-w-0 flex-col rounded-card border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-base)] px-3 py-2.5"
                >
                  <div className="mb-1.5 truncate font-mono text-ewb-caption font-semibold text-[var(--dsw-alias-label-tertiary)]" title={g.title}>
                    {g.title}
                  </div>
                  {g.cells.map(c => (
                    <div
                      key={c.label}
                      data-ewb-ov-metric={c.label}
                      data-ewb-ov-metric-state={c.state}
                      className="flex items-baseline justify-between gap-2 py-0.5"
                      title={c.note === undefined ? undefined : c.note}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
                        {c.label}
                      </span>
                      {/* ⚠️ **`value` 原样摆出，外面不许再包一层单位** ——
                       * 它自己已经带了（`¥0` / `0.00 元` / `5.00`）。再包一层会变成 `¥¥0`。 */}
                      <span
                        data-ewb-ov-metric-value=""
                        className={
                          'shrink-0 font-mono text-ewb-meta ' +
                          (c.state === 'warn'
                            ? 'text-[var(--dsw-alias-state-warn-primary)]'
                            : 'text-[var(--dsw-alias-label-primary)]')
                        }
                      >{c.value}</span>
                      {c.state === 'warn' && (
                        <span
                          data-ewb-ov-warn=""
                          className="shrink-0 font-mono text-ewb-caption text-[var(--dsw-alias-state-warn-primary)]"
                        >需留意</span>
                      )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
      </div>

      {/* ══════════════════════════════════════════════════════════════
       * ② 看板（原样保留，退到第二屏）
       *
       * ⚠️ 这一段的判据、钩子、交互**一个都没改** —— 票面明确要求
       * 「本票不改它的判据、不做自选清单」。改动只在它**前面**多了数据那一层。
       * ══════════════════════════════════════════════════════════════ */}
      <div data-ewb-dashboards="" className="flex flex-none flex-col">
        {/* 顶部：标题 + 说明 + 重读。
         * ⚠️ 这个「重读」是**只重读、不跑**（与每块看板里的「刷新」不是一回事）。
         * 两者必须分开命名，否则用户会以为点上面那个也会跑一遍、白烧额度。 */}
        <div className="mb-3 flex flex-none flex-wrap items-center gap-2 border-b border-[var(--dsw-alias-border-l2)] pb-2">
          <Label rule>看板</Label>
          <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
            共 {cards.length} 块 · 各自最近一次的执行情况
          </span>
          <span className="flex-1" />
          <button
            type="button"
            className={BTN_QUIET}
            title="只重读一次最近的结果，不跑工作流（要跑请点每块看板右上角的「刷新」）"
            onClick={() => { refresh() }}
          >重读结果</button>
        </div>

        {/* 一块都没有：说清缺什么、下一步去哪，不是一句「暂无数据」。 */}
        {cards.length === 0
          ? (
            <div
              data-ewb-dashboards-empty=""
              className="flex flex-col items-start gap-2 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-8"
            >
              <div className="font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)]">还没有可看的看板</div>
              <div className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
                总览只放名字以「巡查-」开头的工作流，一份都没有时这里就是空的。
              </div>
              <div className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
                下一步：去「工作流 → 工作流管理」建一份（名字以「巡查-」开头），回来点右上角「重读结果」。
              </div>
            </div>
          )
          : (
            <>
              {!anyRan && (
                <div className="mb-3 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
                  这几块都还没跑过。点某一块右上角的「刷新」会真的跑一次，跑完这块就显示这一次的结果。
                </div>
              )}
              <div
                className="grid gap-3"
                style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}
              >
                {cards.map(card => {
                  const tone = toneOf(card)
                  const isRunning = running === card.name
                  const sum = summary !== null && summary.name === card.name ? summary : null
                  const keys = Object.keys(card.outputs)
                  return (
                    <div
                      key={card.name}
                      data-ewb-dashboard={card.name}
                      className="flex min-w-0 flex-col rounded-card border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-base)] px-3 py-2.5"
                    >
                      {/* 卡头：状态灯 + 名字 + 刷新（唯一的操作）。 */}
                      <div className="flex items-start gap-2">
                        <span className={'dot ' + (isRunning ? 'ok pulse' : tone === 'off' ? 'off' : tone)} style={{ marginTop: 6 }} />
                        <span className="min-w-0 flex-1 truncate text-ewb-meta font-semibold text-[var(--dsw-alias-label-primary)]" title={card.name}>
                          {card.name}
                        </span>
                        <button
                          type="button"
                          className={BTN}
                          data-ewb-dashboard-refresh={card.name}
                          disabled={blocked}
                          /* 禁用时写清**为什么** —— 只灰不说，用户会以为坏了。 */
                          title={blocked
                            ? '「' + running + '」正在跑，等它跑完再刷新（几份巡查抢同一个浏览器会话，同时跑会踢掉登录态）'
                            : isRunning
                              ? '正在跑，跑完会自动收起输出'
                              : '真的跑一次「' + card.name + '」，跑完这块就显示这一次的结果'}
                          onClick={() => { run(card.name) }}
                        >{isRunning ? '刷新中…' : '刷新'}</button>
                      </div>

                      {/* 一句话说清这次怎么样（状态灯旁边的字，不堆徽标）。 */}
                      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[var(--dsw-alias-border-l2)] pt-1.5">
                        <Badge tone={tone === 'off' ? 'default' : tone}>{verdictOf(card)}</Badge>
                        <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                          {card.last === undefined
                            ? '点「刷新」跑一次'
                            : when(card.last.startedAt ?? card.last.endedAt)}
                        </span>
                      </div>

                      {/* 交出了什么：露三行，多的折叠。 */}
                      {keys.length === 0
                        ? (
                          <div className="mt-1 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
                            {card.last === undefined
                              ? '跑一次之后这里会显示它交出了什么'
                              : card.last.ok === false
                                ? '这次没跑成，没有产出'
                                : '这次没有交出产出（结束节点没声明，或这段还没跑到）'}
                          </div>
                        )
                        : (
                          <div className="mt-1 flex flex-col gap-0.5">
                            {keys.slice(0, SHOW_OUTPUTS).map(k => (
                              <div
                                key={k}
                                className="truncate font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                                title={k + ' = ' + JSON.stringify(card.outputs[k])}
                              >
                                <span className="text-[var(--dsw-alias-label-tertiary)]">{k}</span>
                                {' = '}
                                {typeof card.outputs[k] === 'string'
                                  ? String(card.outputs[k])
                                  : JSON.stringify(card.outputs[k]) ?? 'null'}
                              </div>
                            ))}
                            {keys.length > SHOW_OUTPUTS && (
                              <div className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                                还有 {keys.length - SHOW_OUTPUTS} 项（进「工作流 → 运行历史」看全部）
                              </div>
                            )}
                          </div>
                        )}

                      {/* 跑完留的那一行（输出区收起后，这块还得看出「刚跑过」）。 */}
                      {sum !== null && !isRunning && (
                        <div
                          data-ewb-dashboard-summary=""
                          className={
                            'mt-1.5 font-mono text-ewb-caption leading-relaxed ' +
                            (sum.ok
                              ? 'text-[var(--dsw-alias-state-success-primary)]'
                              : 'text-[var(--dsw-alias-state-error-primary)]')
                          }
                        >{sum.text}</div>
                      )}

                      {/* ★ 就地展开的进展区（跑的时候才出现，复用现成的 SSE 组件）。 */}
                      {isRunning && (
                        <div className="mt-2" data-ewb-dashboard-runpanel={card.name}>
                          <FlowRunPanel
                            name={card.name}
                            inputs={{}}
                            onClose={() => { setRunning('') }}
                            onDone={res => { onDone(card.name, res) }}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </>
          )}
      </div>
    </div>
  )
}
