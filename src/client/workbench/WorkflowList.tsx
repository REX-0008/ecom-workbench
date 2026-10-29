/**
 * 已保存的工作流列表（工作流板块的「工作流」tab）。
 *
 * 用户 2026-10-08 要求：「在工作流里面加一个 TAB，用来展示已保存的工作流」，
 * 随后指出它「就是一个几个字加两个按钮」的页面，要照 FounderOS 的做法重做。
 *
 * **形态选择**（照 FounderOS 的 `NewsletterList`）：**卡片行 + 展开**。
 *   - 为什么不用它的「分组 + 抽屉」（`DeliverablesList`）：
 *     工作流**没有天然分类**，硬分类是给用户造负担；
 *   - 单份工作流的信息量中等（节点数、连线数、时间、快照），适合展开看。
 *
 * 照搬的细节（这些是「像不像」的关键）：
 *   - 卡片：`rounded-card border bg-base`，外层 `flex flex-col gap-2.5`
 *   - 行：`pressable flex w-full items-center gap-4 px-5 py-4`，悬停微填充
 *   - 展开箭头：`h-4 w-4`，展开时从右转下
 *   - 标题：`text-ewb-meta font-semibold truncate`
 *   - 元信息：`font-mono text-ewb-caption text-dim`，拆成间距分隔的两组
 *   - 指标胶囊：`rounded-full px-2.5 py-0.5 font-mono text-ewb-caption tabular-nums`
 *   - 展开区：`border-t px-5 pb-5 pt-4` + 指标格阵
 *   - 指标格：`rounded-ctl border px-3 py-2.5`（标签 9px / 数值 17px / 副标 9.5px）
 *
 * 三条不静默（与运行历史面板一致）：
 *   - 读不到列表 → 明说原因 + 重试
 *   - 一份都没有 → 明说「还没保存过」+ 给「去画布」
 *   - 存放目录 → 显示出来（用户要知道文件存哪了）
 */
import { useCallback, useEffect, useState } from 'react'
import { loadWorkflowFile, deleteWorkflowFile, openWorkflowDir, loadWorkflowIo, saveWorkflowFile, duplicateWorkflow } from './dispatch-client.ts'
import { FlowRunPanel, type FlowDone } from './FlowRunPanel.tsx'
import { RunInputForm } from './RunInputForm.tsx'
import { TagPickerMulti } from './TagPicker.tsx'
import type { InputField } from '../../workflow/io-fields.ts'
import { typeOptions } from '../../workflow/workflow-types.ts'
import { Badge, Label, SectionHead } from './terminal.tsx'
/* 「默认浏览器」这份偏好存在 localStorage（宿主半读不到），
 * 所以「默认来源是不是 CDP / 那个端口通不通」要在**这一侧**跟机器事实对照。 */
import { readPrefs } from './browser-settings.ts'
/* 环境检测的**判定逻辑**是纯函数，住在 `src/workflow/env-check.ts`（可单测）。
 * ⚠️ 分工：**机器事实**由宿主半给（它连得了 socket、读得了存档目录），
 * **用户偏好**在这一侧（localStorage 宿主半看不到）—— 两者合起来算只能在这里做。 */
import { buildEnvReport, type EnvReport } from '../../workflow/env-check.ts'

/** 空输入表（**稳定引用**：新对象会让面板的订阅依赖每次变化 → 连接反复重开）。 */
const EMPTY_INPUTS: Record<string, unknown> = {}

/** 列表里的一条。 */
interface Row {
  /** 工作流名。 */
  name: string
  /** 节点数。 */
  nodes?: number
  /** 连线数。 */
  edges?: number
  /**
   * 「谁能启动它」——由**开始节点的类型**决定（用户 m00901 定案：不是设置项）。
   *
   * `null` = 这份工作流没有开始节点（老存档）→ **照旧显示执行按钮**
   * （它自己带初始数据，手动跑没问题；只是接不了外部输入）。
   */
  startType?: string | null
  /** 工作流类型（用户 m00861）：给人看与筛选用。 */
  types?: string[]
  /** 一句话说明（老存档没有 → 空串）。 */
  description?: string
  /** 修改时间（毫秒时间戳）。 */
  at?: number
}

/**
 * 毫秒时间戳 → 人看得懂的时间。
 * @param ms - 时间戳。
 * @returns 如 `10-08 14:03`。
 */
function fmtTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/**
 * 时间戳 → 「多久以前」。
 * @param ms - 时间戳。
 * @returns 如 `3 天前`。
 */
function ago(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return String(m) + ' 分钟前'
  const h = Math.floor(m / 60)
  if (h < 24) return String(h) + ' 小时前'
  return String(Math.floor(h / 24)) + ' 天前'
}

/**
 * 一个指标格（照 FounderOS 的 `Metric`：标签 9px / 数值 17px / 副标 9.5px）。
 * @param props.label - 指标名。
 * @param props.value - 数值。
 * @param props.sub - 可选副标。
 * @returns 指标格元素。
 */
function Metric({ label, value, sub }: { label: string, value: string, sub?: string }): React.JSX.Element {
  return (
    <div className="rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-3 py-2.5">
      <div className="font-mono text-ewb-label uppercase tracking-[0.16em] text-[var(--dsw-alias-label-tertiary)]">{label}</div>
      <div className="mt-1 font-mono text-ewb-heading font-semibold leading-none tracking-[-0.02em] text-[var(--dsw-alias-label-primary)]">{value}</div>
      {sub !== undefined && <div className="mt-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">{sub}</div>}
    </div>
  )
}

/**
 * 已保存的工作流列表。
 *
 * @param props.onOpen - 打开某一份（由上层把内容加载进画布并切到画布 tab）。
 * @param props.onGoCanvas - 切到画布（一份都没有时引导用户去那里保存）。
 * @returns 列表界面。
 */
export function WorkflowList(props: {
  onOpen: (doc: unknown, name: string) => void
  onGoCanvas: () => void
}) {
  const [rows, setRows] = useState<Row[]>([])
  const [dir, setDir] = useState('')
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [err, setErr] = useState('')
  /** 当前展开的那一份（null = 都收起；照它的 openId 单开模式）。 */
  const [openName, setOpenName] = useState<string | null>(null)
  /**
   * 环境检测结果（用户 m03425 第 6 条要求「在工作流管理 tab 中增加一个环境检测按钮」）。
   *
   * ⚠️ **不在挂载时自动跑**：它会去探机器的端口（约 2 秒），
   * 用户只是来看工作流列表时不该付这个等待。点按钮才跑。
   */
  const [env, setEnv] = useState<EnvReport | null>(null)
  const [envBusy, setEnvBusy] = useState(false)

  /**
   * 展开区里正在编辑的字段（`null` = 没在编辑）。
   *
   * ## 为什么要有这个（2026-10-18 修的真 bug）
   *
   * 「改名」「改说明」两个按钮原先调 `window.prompt` —— 而这个插件跑在
   * **Electron 桌面端**里，`window.prompt` 在那里**直接抛错**
   * （Chromium 从很早就不再实现 `prompt`，Electron 继承了这个行为）。
   * 调用外面是 `void (async () => …)()`，**没有 catch** → 点了完全没反应、
   * 控制台之外看不到任何迹象。用户报的「两个按钮没有实际作用」就是它。
   *
   * 现在改成**展开区里的内联输入框**：点按钮 → 那一格变成输入框 + 存/取消。
   * 这也与列表页既有形态一致（`RunInputForm` 那块的注释写着同一个理由：
   * 本插件没有弹窗组件，也不该为一件小事引入一个）。
   */
  const [editing, setEditing] = useState<{ name: string, field: 'name' | 'desc' } | null>(null)
  /** 编辑框里的草稿值（切到另一份时重置）。 */
  const [draft, setDraft] = useState('')

  /**
   * 拉一次列表。
   *
   * @param silent - 不显示「正在读取」的加载态（**跑完刷列表必须用它**）。
   *
   * ## 为什么 silent 不是可选项而是必需（2026-10-18 修的真 bug）
   *
   * 跑完时调了一次 `refresh()`，它把 `state` 置回 `'loading'`；
   * 而 `state === 'loading'` 时本组件**提前 return**（整块列表卸载）——
   * 于是下面的 `FlowRunPanel` 一起被卸载、等列表回来又重新挂载，
   * 而它一挂载就会开一条新的 SSE 跑路……**跑完 → 刷新 → 重挂 → 再跑**，
   * 于是「跑一个会出现多个」，而且每次间隔正好是一个运行时长（实测 3 秒一条）。
   *
   * 这轮之前「一次点击跑两遍（POST + SSE）」是另一半原因，两个叠在一起就是
   * 用户看到的现象。
   */
  const refresh = useCallback((silent = false): void => {
    if (!silent) setState('loading')
    void (async () => {
      const res = await fetch('/api/ecom-workbench/workflows')
      if (!res.ok) {
        setState('error')
        setErr('宿主半返回 ' + String(res.status))
        return
      }
      const body = await res.json() as { dir?: string, items?: Row[] }
      setRows(body.items ?? [])
      setDir(body.dir ?? '')
      setState('ok')
    })().catch((e: unknown) => {
      setState('error')
      setErr('连不上宿主半：' + (e instanceof Error ? e.message : String(e)))
    })
  }, [])

  useEffect(() => { refresh() }, [refresh])


  /**
   * 环境检测（用户 m03425 第 6 条：「在工作流管理 tab 中增加一个环境检测按钮，
   * 你思考一下应该检测些什么，节点依赖，浏览器准备……」）。
   *
   * ## 检测什么、为什么是这些
   *
   * 用户明说「现在不必求全，因为依赖声明这个部分还没做」。所以只报
   * **现在真能查、且用户真会遇到**的：
   *
   *   ① **存档引用的节点类型还在不在** —— 「节点依赖」目前唯一可验证的一半。
   *      节点库删掉一个定义、老存档还引用它 → 那份工作流打开就缺节点。
   *   ② **浏览器准备** —— 机器上有没有能用的浏览器。
   *   ③ **默认浏览器这条配置通不通** —— 这是用户点名的那一条：
   *      「特别是默认浏览器是否可用，比如默认浏览器如果是 cdp，
   *      那么这个 cdp 接口是否可用需要验证」。
   *      做法是把机器事实（宿主半探到的端口）跟**本地偏好**（localStorage 里的
   *      `defaultSource` / `defaultPort`）对照 —— 宿主半读不到 localStorage，
   *      所以这一步只能在这一侧做，接口只给机器事实。
   *
   * ⚠️ 2026-10-27 改（票 22）：上一版这里写着「真正的 npm 包 / 外部程序 /
   * 环境变量依赖检测现在做不了」，报告里显式说「声明式依赖尚未实现」。
   * 那句话现在已经不成立 —— 后端会逐节点判四类依赖，缺的节点连缺什么都带回来了。
   * 所以下面改成如实报：缺哪几个节点、每个缺什么、怎么装。
   */
  const checkEnv = useCallback((): void => {
    setEnvBusy(true)
    void (async () => {
      const res = await fetch('/api/ecom-workbench/env-check')
      if (!res.ok) throw new Error('宿主半返回 ' + String(res.status))
      const body = await res.json() as {
        nodes?: {
          library?: number
          workflows?: number
          gaps?: { workflow: string, defId: string }[]
          depsImplemented?: boolean
          depsMissing?: { id: string, gaps: { kind: string, name: string }[], reason: string }[]
        }
        browsers?: { total?: number, usable?: number, found?: string[] }
        cdp?: { endpoints?: { port: number }[] }
      }
      const usable = body.browsers?.usable ?? 0
      const cdpPorts = (body.cdp?.endpoints ?? []).map(e => e.port)
      /* 本地偏好与机器事实交叉 —— **判定本身是纯函数**（`buildEnvReport`），
       * 这里只负责把两侧的输入凑齐（这也正是两侧分工的落点）。 */
      const prefs = readPrefs()
      setEnv(buildEnvReport({
        library: body.nodes?.library ?? 0,
        workflows: body.nodes?.workflows ?? 0,
        gaps: body.nodes?.gaps ?? [],
        depsImplemented: body.nodes?.depsImplemented === true,
        /* 读不到这个键 = 老宿主半（票 22 之前）—— 留空数组，
         * 下面的提示会按 `depsImplemented` 分开说，不会把「没查」说成「没缺」。 */
        depsMissing: body.nodes?.depsMissing ?? [],
        browsersUsable: usable,
        browserNames: body.browsers?.found ?? [],
        cdpPorts,
      }, {
        defaultSource: prefs.defaultSource,
        defaultPort: prefs.defaultPort,
      }))
    })().catch((e: unknown) => {
      setEnv(null)
      setErr('环境检测失败：' + (e instanceof Error ? e.message : String(e)))
    }).finally(() => { setEnvBusy(false) })
  }, [])

  /**
   * **不开画布**直接跑这份工作流（用户 2026-10-11 要求）。
   *
   * 与画布上点 ▶ 的区别：那条会把过程画在节点上；这条**没有画布**，
   * 结果只能从「运行历史」看。所以这里跑完提示去看运行历史。
   */
  const [runningName, setRunningName] = useState<string | null>(null)
  /**
   * 一条结果提示。
   *
   * ⚠️ **带 `tone`，不靠文字猜**（2026-10-11 改）。
   * 原来只有一个字符串，配色靠 `err.startsWith('已跑完')` 去猜是不是成功 ——
   * 于是**改一次文案就可能把配色改错**（这轮文案规范化就差点踩到：
   * 「跑了」改成「已跑」时那个前缀判断跟着要改）。
   * 把语气做成数据，文案怎么改都不影响显示。
   */
  const [notice, setNotice] = useState<{ text: string, tone: 'ok' | 'error' } | null>(null)
  /**
   * 正在「边跑边看」的那一份（`null` = 面板不显示）。
   *
   * 用户 m00716 要的「输出流程进度类似 bat」——这份 state 一置上，
   * 下面的 `FlowRunPanel` 就订阅 SSE 把每一步摊出来。
   *
   * `inputs` 是**那一刻填好的那一份值**（存下来，不在渲染期重算）——
   * 面板的订阅依赖它，重算会造出新对象、把连接反复重开。
   */
  const [liveRun, setLiveRun] = useState<{ name: string, inputs: Record<string, unknown> } | null>(null)
  /**
   * 正在等着填输入的那一份（`null` = 不显示表单）。
   *
   * 用户 m02875「补。」—— 原来这里是 `window.prompt` 一个个弹：一次只能问一项、
   * 看不出还差几项、没填必填也拦不住、取消一个框整次就不跑了。
   * 现在换成 `RunInputForm`（内联块，与下面的流程面板同一形态）。
   */
  const [inputAsk, setInputAsk] = useState<{ name: string, fields: readonly InputField[] } | null>(null)
  /**
   * 类型筛选（用户 m00888 第 ③ 条：「列表要能按类型筛选」）。
   *
   * 空集 = 不筛（显示全部）。多个取**并集**（用户 m00888 的要求）。
   */
  const [typeFilter, setTypeFilter] = useState<string[]>([])

  /**
   * 搜索词（票 45，2026-10-28）。
   *
   * 用户原话：「给这三个都增加搜索功能，他们都是可能会很多的东西需要搜索功能」。
   *
   * ## 搜哪些字段
   *
   * **名字 + 说明**。为什么不搜节点里的内容：那是「这份工作流做什么」的实现细节，
   * 而列表上区分两份的依据是「它叫什么、它是干什么的」。搜实现细节会让
   * 「搜一个词，冒出一堆我认不出的名字」，反而更难找。
   *
   * ## 与类型筛选的关系：**与（AND）**
   *
   * 两个条件同时生效。理由不是「顺手」，是照提示词库
   * （`PromptLibrary.tsx:113` 的 `filterEntries(entries, q, tag)` 就是 AND）。
   *
   * 反过来（搜索时清掉类型筛选）会丢掉一个真实需求：**在某一类里搜**。
   * 用户给 12 份存档打过标签之后，最常做的正是「只在采集类里找那个下载的」。
   *
   * 一键全清见下面那颗「清空条件」按钮 —— 与提示词库同一做法。
   */
  const [q, setQ] = useState('')

  /** 本机出现过的全部类型（给筛选条与候选共用）。 */
  const allTypes = (() => {
    const seen = new Set<string>()
    for (const r of rows) for (const t of r.types ?? []) seen.add(t)
    return [...seen].sort()
  })()

  /** 搜索词是否命中一份工作流（名字 + 说明，**不**搜节点内容）。 */
  const hitOf = (r: Row, needle: string): boolean => {
    if (needle === '') return true
    const hay = (r.name + '\n' + (r.description ?? '')).toLowerCase()
    return hay.includes(needle)
  }

  /**
   * 筛过之后的清单。
   *
   * 判据：**空集 = 不筛**（显示全部）；选了多个取**并集**（用户 m00888 的要求）；
   * 类型与搜索词之间是**与**关系（见 `q` 那段注释）。
   */
  const shownRows = rows.filter(r => {
    if (typeFilter.length > 0 && !(r.types ?? []).some(t => typeFilter.includes(t))) return false
    return hitOf(r, q.trim().toLowerCase())
  })
  /**
   * 「跑完了」的回调（SSE 面板交回来的）。
   *
   * ⚠️ 2026-10-18 起**列表页不再发 POST**（那条会让工作流跑第二遍），
   * 所以「跑完了」这件事只能从面板拿到。三件事：
   *   ① 收起 running 态；
   *   ② 给一条回音（用户点了执行必须知道结果）；
   *   ③ 刷新列表（跑完时间/规模会变）。
   *
   * @param res - 面板收到的 `done` 帧。
   */
  const onRunDone = useCallback((res: FlowDone): void => {
    setRunningName(null)
    /* `ok` 与 `aborted` 要一起看（老坑：`ok` 只表示「档读得出来、真的跑了」）。 */
    if (res.ok !== true) {
      setNotice({ text: '执行失败：' + (res.error ?? '有节点失败'), tone: 'error' })
    } else if (res.aborted === true) {
      setNotice({
        text: '已跑 ' + String(res.ran?.length ?? 0) + ' 个节点后中断（有节点失败），详情见「运行历史」',
        tone: 'error',
      })
    } else {
      setNotice({
        text: '已跑完 ' + String(res.ran?.length ?? 0) + ' 个节点，详情见「运行历史」',
        tone: 'ok',
      })
    }
    /* ⚠️ **必须 silent** —— 见 `refresh` 的说明：置回 loading 会卸载面板，
     * 面板一重挂就再开一条跑路，于是「跑完一次多一条记录」且无限自跑。 */
    refresh(true)
  }, [refresh])

  const runHeadless = useCallback((name: string, inputs?: Record<string, unknown>): void => {
    /* ★ **一次点击只跑一遍**（2026-10-18 改，起因是一个真 bug）：
     *
     * 原来这里**同时**发 `POST /workflow/run` 与开下面的 SSE 面板 —— 而两条
     * 路由**各自都会把整份工作流跑一遍**。于是点一次「执行」：
     *   · 工作流真的跑两遍（采集类会重复下载）；
     *   · 运行历史里一次点击出现两条记录（用户 m03635 报的「跑一个会出现多个」）。
     *
     * 现在按**环境**二选一（互斥，不会同时跑）：
     *   · 有 `EventSource`（真浏览器）→ **只开 SSE 面板**跑，收尾由 `onDone` 交回；
     *   · 没有（jsdom / 老浏览器）→ 退回 POST 那条，界面行为不变。
     *
     * 为什么不干脆删掉 POST：测试环境没有 `EventSource`，删了「点执行」就什么都不跑，
     * 那些断言会退化成空转。两条路互相排斥，不算「两套跑法」。 */
    setRunningName(name)
    setNotice(null)
    if (typeof EventSource === 'undefined') {
      void (async () => {
        const res = await fetch('/api/ecom-workbench/workflow/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(inputs === undefined ? { name } : { name, inputs }),
        })
        const got = await res.json() as { ok?: boolean, ran?: string[], aborted?: boolean, error?: string }
        setRunningName(null)
        if (!res.ok || got.ok !== true) {
          setNotice({ text: '执行失败：' + (got.error ?? ('宿主半返回 ' + String(res.status))), tone: 'error' })
          return
        }
            onRunDone({ ok: true, aborted: got.aborted, ran: got.ran, error: got.error })
      })().catch((e: unknown) => {
        setRunningName(null)
        setErr('连不上宿主半：' + (e instanceof Error ? e.message : String(e)))
      })
      return
    }
    setLiveRun({ name, inputs: inputs ?? {} })
  }, [onRunDone])

  /**
   * 点「执行」：先看这份工作流**要什么输入**（开始节点声明的），再决定怎么跑。
   *
   * ## 为什么要有这一步（用户 m00901 定案「输入 = 开始节点」之后）
   *
   * 以前点「执行」就是直接 POST `{name}` —— 一份声明了输入的工作流
   * （比如「要采集哪一天」）只能拿到默认值，或者干脆报缺参数。
   *
   * ## 三种情形，三种走法
   *
   *   ① 声明了输入项 → 弹出小表单让用户填，填完再跑；
   *   ② 没声明 → 直接跑（**老行为一字不变**）；
   *   ③ **开始节点是「被另一个流程调用」** → 不显示执行按钮（见 `runnable`），
   *      所以这里不会走到。
   *
   * ⚠️ 弹的表单用的是 `window.prompt`（与画布上「打开第几份」同一个做法）——
   * 本插件没有弹窗组件、也不该为这一件事引入一个。`prompt` 的第二个参数
   * 正好用来预填默认值。
   */
  const startRun = useCallback((name: string): void => {
    void (async () => {
      const io = await loadWorkflowIo(name)
      if (!io.ok) {
        /* 查不到声明**不拦**（老存档/老宿主可能没有这条路由），直接按老方式跑 ——
         * 拦下来的话「列表上点执行」会因为这个附加能力不可用而**整个坏掉**。 */
        runHeadless(name)
        return
      }
      const fields = io.inputs ?? []
      if (fields.length === 0) { runHeadless(name); return }
      /* 要填输入 → **在列表上方长出一块表单**（不再一个个弹 `window.prompt`）。 */
      setInputAsk({ name, fields })
    })()
  }, [runHeadless])

  /**
   * 改名（用户 m00861：「增加编辑工作流名称与说明的按钮」）。
   *
   * ## 为什么是「另存为新名 + 删掉旧的」而不是「改文件里的 name」
   *
   * 存档的**文件名就是工作流名**（见 store.ts 的 safeName）。
   * 「改 name 字段」不会改文件名 → 列表读的仍是文件名 → 看起来没改。
   * 所以真改名 = 用新名字存一份、把旧的删掉。
   *
   * ⚠️ **重名要拦**：两份同名工作流会让「按名字调用」（flow.workflow 节点）
   * 变得不确定 —— 那比「覆盖了一份」更难查。
   *
   * ⚠️ 顺序是**先存新的、再删旧的**：反过来的话，中途失败就两头都没了。
   */
  const rename = useCallback((oldName: string, next: string): void => {
    void (async () => {
      const name = next.trim()
      if (name === '' || name === oldName) return
      if (rows.some(r => r.name === name)) {
        setErr('已有一份叫「' + name + '」的工作流了 —— 重名会让「按名字调用」变得不确定，换一个。')
        return
      }
      const got = await loadWorkflowFile(oldName)
      if (!got.ok) { setErr('改名失败：' + (got.error ?? '读不到原存档')); return }
      const saved = await saveWorkflowFile(name, got.doc)
      if (!saved.ok) { setErr('改名失败：' + (saved.error ?? '存不进去')); return }
      const gone = await deleteWorkflowFile(oldName)
      const tail = gone.ok ? '' : '（旧的那份没删掉：' + String(gone.error ?? '未知原因') + '）'
      setNotice({ text: '已改名为「' + name + '」' + tail, tone: gone.ok ? 'ok' : 'error' })
      refresh()
    })()
  }, [rows, refresh])

  /**
   * 改说明（用户 m00861 的同一句要求：「编辑工作流名称与说明」）。
   *
   * ⚠️ 说明**是存档内容**（workflow-doc.ts 的 docFingerprint 把它算进指纹，
   * 与 name 不同）—— 所以改完之后画布那边再打开会看到「有未保存的改动」，
   * 那是**正确的**：内容确实变了。
   */
  const editDesc = useCallback((name: string, next: string): void => {
    void (async () => {
      const got = await loadWorkflowFile(name)
      if (!got.ok) { setErr('改说明失败：' + (got.error ?? '读不到存档')); return }
      const doc = (got.doc !== null && typeof got.doc === 'object' ? got.doc : {}) as Record<string, unknown>
      const text = next.trim()
      if (text === '') delete doc.description
      else doc.description = text
      const saved = await saveWorkflowFile(name, doc)
      if (!saved.ok) { setErr('改说明失败：' + (saved.error ?? '存不进去')); return }
      setNotice({ text: '已更新「' + name + '」的说明', tone: 'ok' })
      refresh()
    })()
  }, [refresh])

  /**
   * 改这份工作流的类型（用户 m00861：「增加编辑工作流名称与说明的按钮」——
   * 同一条要求里还有类型；m00888 定它**可多选、可自由填、能当场新建**）。
   *
   * ⚠️ **与「可被调用」无关**（用户 m00901 的修正）：那个由开始节点的类型算，
   * 这里改的只是给人看的标签。
   */
  const editTypes = useCallback((name: string, next: string[]): void => {
    void (async () => {
      const got = await loadWorkflowFile(name)
      if (!got.ok) { setErr('改类型失败：' + (got.error ?? '读不到存档')); return }
      const doc = (got.doc !== null && typeof got.doc === 'object' ? got.doc : {}) as Record<string, unknown>
      if (next.length === 0) delete doc.types
      else doc.types = next
      const saved = await saveWorkflowFile(name, doc)
      if (!saved.ok) { setErr('改类型失败：' + (saved.error ?? '存不进去')); return }
      refresh()
    })()
  }, [refresh])

  /** 打开一份工作流。 */
  const open = useCallback((name: string): void => {
    void (async () => {
      const got = await loadWorkflowFile(name)
      if (!got.ok) {
        setErr('打开失败：' + (got.error ?? '未知原因'))
        return
      }
      props.onOpen(got.doc, name)
    })()
  }, [props])

  /** 删掉一份（要用户确认——不可逆）。 */
  const remove = useCallback((name: string): void => {
    if (!window.confirm('删除「' + name + '」？这会删掉磁盘上的文件，不能撤销。')) return
    void (async () => {
      const got = await deleteWorkflowFile(name)
      if (!got.ok) {
        setErr('删除失败：' + (got.error ?? '未知原因'))
        return
      }
      refresh()
    })()
  }, [refresh])

  /**
   * 打开这份工作流所在的目录（用户 2026-10-14 要求的新按钮）。
   *
   * 走宿主半（浏览器里开不了文件管理器）。成败都给回音 ——
   * 「点了没反应」是这次要消灭的那类体验（用户明说过「点击保存后没有任何变化」）。
   */
  const openDir = useCallback((name: string): void => {
    void (async () => {
      const got = await openWorkflowDir(name)
      if (!got.ok) {
        setErr('打开目录失败：' + (got.error ?? '未知原因'))
        return
      }
      setNotice({
        text: '已在文件管理器里打开 ' + String(got.path ?? '目录')
          + (got.exists === false ? '（「' + name + '」不在里面 —— 可能刚被删或改名了）' : ''),
        tone: got.exists === false ? 'error' : 'ok',
      })
    })()
  }, [])

  /**
   * 复制一份（票 46，用户 2026-10-28：「执行和内容的工作流管理与画布库都增加复制功能」）。
   *
   * ## 为什么复制完**不自动打开**副本
   *
   * 用户要的是「复制出第二份，再在副本上改」。连着复制三份的人不想被切走三次 ——
   * 副本出现在列表里就已经达成目的，打开是一个额外动作。
   *
   * ## 撞名与编号的处理全在 `duplicateWorkflow` 里
   *
   * 那里做两件这里做不了的事：先查名字（`saveWorkflow` 是覆盖写，撞了会毁存档）、
   * 删掉原件的 `id` 再按新名派生（否则副本与原件同 id，`flow.workflow` 引用会串）。
   * 这里只负责「点了 → 刷列表 → 说一句副本叫什么」。
   *
   * @param name - 原件名。
   */
  const duplicate = useCallback((name: string): void => {
    void (async () => {
      const got = await duplicateWorkflow(name)
      if (!got.ok) {
        setErr('复制失败：' + (got.error ?? '未知原因'))
        return
      }
      setErr('')
      /* 告诉用户副本叫什么 —— 名字是自动加的「副本 / 副本 2」，不说的话
       * 用户得自己在列表里找哪份是新的。 */
      setNotice({ text: '已复制出一份：「' + String(got.name ?? '') + '」', tone: 'ok' })
      refresh(true)
    })()
  }, [refresh])

  if (state === 'loading') {
    return <div className="py-10 text-center text-ewb-body text-[var(--dsw-alias-label-tertiary)]">正在读取已保存的工作流…</div>
  }
  if (state === 'error') {
    return (
      <div className="py-10 text-center">
        <div className="mb-3 text-ewb-meta text-[var(--dsw-alias-state-error-primary)]">无法读取工作流列表：{err}</div>
        <button
          type="button"
          data-lens="c"
          /* ⚠️ **必须包一层箭头**（2026-10-24 契约 AK 修）。
           *
           * 原来直接写 `onClick={refresh}` —— React 会把**事件对象**当第一个参数传进去，
           * 而 `refresh(silent = false)` 的 `silent` 收到的是那个对象（真值！）。
           * 后果：点「重试」时 `if (!silent) setState('loading')` **不进**，
           * 界面看着像没反应。这是类型检查这次真抓出来的一个**行为 bug**，
           * 不是纯类型噪音。 */
          onClick={() => { refresh() }}
          className="pressable is-dark rounded-full border border-[var(--dsw-alias-border-l2)] px-3.5 py-1.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
        >
          重试
        </button>
      </div>
    )
  }

  return (
    <>
    <div>
      <SectionHead
        label="全部工作流"
        count={rows.length}
        right={(
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              data-lens="c"
              onClick={props.onGoCanvas}
              className="pressable is-dark rounded-full border border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)] px-3.5 py-1.5 font-mono text-ewb-caption text-[var(--ewb-accent)]"
            >
              + 新建
            </button>
            <button
              type="button"
              data-lens="c"
              onClick={checkEnv}
              disabled={envBusy}
              title="查一遍这台机器跑不跑得起来：节点类型齐不齐、浏览器能不能用、默认端口通不通"
              className="pressable is-dark rounded-full border border-[var(--dsw-alias-border-l2)] px-3.5 py-1.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)] disabled:opacity-50"
            >
              {envBusy ? '检测中…' : '环境检测'}
            </button>
            <button
              type="button"
              data-lens="c"
              /* 同上：不包一层的话 `silent` 会收到事件对象（真值），
               * 点「刷新」不会进加载态。 */
              onClick={() => { refresh() }}
              className="pressable is-dark rounded-full border border-[var(--dsw-alias-border-l2)] px-3.5 py-1.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
            >
              刷新
            </button>
          </div>
        )}
      />

      {/* 提示条分两条：执行结果（带语气）与真正的错误（读列表 / 打开 / 删除失败）。
       * **执行成功的反馈也必须显示** —— 用户点了「执行」却没有任何回音，
       * 会不知道到底跑没跑。 */}
      {/* 执行结果提示（带语气，不靠文字猜配色）。 */}
      {notice !== null && (
        <div
          className={[
            'mb-3 rounded-ctl border px-3 py-2 font-mono text-ewb-caption',
            notice.tone === 'ok'
              ? 'border-[color-mix(in_oklab,var(--dsw-alias-state-success-primary)_35%,transparent)] text-[var(--dsw-alias-state-success-primary)]'
              : 'border-[color-mix(in_oklab,var(--dsw-alias-state-error-primary)_35%,transparent)] text-[var(--dsw-alias-state-error-primary)]',
          ].join(' ')}
        >{notice.text}</div>
      )}

      {/* ★ 要填输入时的表单（用户 m02875「补。」）—— 在流程面板上方，
       * 因为「先填完才开跑」，顺序与用户做的事一致。 */}
      {inputAsk !== null && (
        <RunInputForm
          name={inputAsk.name}
          fields={inputAsk.fields}
          onSubmit={inputs => {
            const n = inputAsk.name
            setInputAsk(null)
            runHeadless(n, inputs)
          }}
          onCancel={() => { setInputAsk(null) }}
        />
      )}

      {/* ★ 流程级运行面板：**边跑边看**（用户 m00716 要的「类似 bat」）。 */}
      <FlowRunPanel
        name={liveRun?.name ?? null}
        inputs={liveRun?.inputs ?? EMPTY_INPUTS}
        onClose={() => { setLiveRun(null) }}
        onDone={onRunDone}
      />

      {/* 真正的错误（读列表 / 打开 / 删除失败）。 */}
      {err !== '' && (
        <div className="mb-3 rounded-ctl border border-[color-mix(in_oklab,var(--dsw-alias-state-error-primary)_35%,transparent)] px-3 py-2 font-mono text-ewb-caption text-[var(--dsw-alias-state-error-primary)]">{err}</div>
      )}

      {/* ── 环境检测报告 ──────────────────────────────────────────────
       * 形态：**结论在前、明细在后**（用户要的是「能不能跑」，不是一堆字段）。
       * 结论用一行说清「就绪 / 有 N 件事要先解决」，明细用胶囊列出事实。 */}
      {env !== null && (
        <div className="mb-3 rounded-card border border-[var(--dsw-alias-border-l2)] px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-ewb-meta font-semibold text-[var(--dsw-alias-label-primary)]">
              {env.blockers.length === 0 ? '环境就绪' : '有 ' + String(env.blockers.length) + ' 件事要先解决'}
            </span>
            <button
              type="button"
              data-lens="c"
              onClick={() => { setEnv(null) }}
              className="pressable is-dark rounded-full border border-[var(--dsw-alias-border-l2)] px-2.5 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]"
            >收起</button>
          </div>

          {env.blockers.length > 0 && (
            <div className="mt-3 flex flex-col gap-1.5">
              {env.blockers.map(b => (
                <div key={b} className="font-mono text-ewb-caption text-[var(--dsw-alias-state-warning-primary)]">· {b}</div>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-x-2 gap-y-1.5">
            {[
              ['节点类型', String(env.library) + ' 种'],
              ['工作流', String(env.workflows) + ' 份'],
              ['可用浏览器', String(env.browsersUsable) + (env.browserNames.length > 0 ? '（' + env.browserNames.join('、') + '）' : '')],
              ['CDP 端口', env.cdpPorts.length > 0 ? env.cdpPorts.join(' / ') : '没扫到'],
              ['默认来源', env.defaultSource === 'cdp' ? '已开的调试端口（CDP）' : '本机装着的浏览器'],
            ].map(([k, v]) => (
              <span key={k} className="rounded-full bg-[var(--dsw-alias-interactive-bg-hover)] px-2.5 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
                {k} {v}
              </span>
            ))}
          </div>

          {/* 缺的类型逐条列出 —— 只报数量的话用户不知道该去修谁。 */}
          {env.gaps.length > 0 && (
            <div className="mt-3 flex flex-col gap-1">
              {env.gaps.map(g => (
                <div key={g.workflow + g.defId} className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                  {g.workflow} 用到的「{g.defId}」已经不在节点库里了
                </div>
              ))}
            </div>
          )}

          {/* 依赖缺件（票 22）：逐条说清哪个节点缺什么、怎么装。
           *
           * 两条分开说，不合并成一句：
           *   · 缺依赖 = 节点在，但这台机器上跑不了它（装包 / 装程序 / 设变量 / 补文件）；
           *   · `!depsImplemented` = 老宿主半根本没查（升级前后台还是旧的）。
           * 合成一句会让「没查」被读成「没缺」，那是假安心。 */}
          {env.depsImplemented && env.depsMissing.length > 0 && (
            <div className="mt-3 flex flex-col gap-1" data-ewb-env-deps="">
              <div className="font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
                这 {String(env.depsMissing.length)} 个节点在这台机器上跑不了（缺依赖）：
              </div>
              {env.depsMissing.map(d => (
                <div key={d.id} className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]" data-ewb-env-dep-node={d.id}>
                  <span data-ewb-env-dep-id={d.id}>{d.id}</span>
                  {' · '}
                  <span data-ewb-env-dep-reason={d.id}>{d.reason}</span>
                </div>
              ))}
            </div>
          )}
          {/* 全查过、一个都不缺 —— 说一句，让「环境就绪」有据可依。 */}
          {env.depsImplemented && env.depsMissing.length === 0 && (
            <div className="mt-3 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" data-ewb-env-deps-ok="">
              节点依赖已查过（NPM 包 / 外部程序 / 环境变量 / 随附文件四类），声明的都齐。
            </div>
          )}

          {/* 老宿主半：`depsImplemented` 是假 —— 如实说「没查」，不许说成「没缺」。 */}
          {!env.depsImplemented && (
            <div className="mt-3 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
              节点依赖这一项没查（当前宿主半还不会判），上面只覆盖「节点类型齐不齐」与「浏览器能不能用」。
            </div>
          )}
        </div>
      )}

      {/* 空状态：实线细框（原来用虚线框，用户明确要求去掉虚线）。 */}
      {rows.length === 0 && (
        <div className="rounded-card border border-[var(--dsw-alias-border-l2)] py-12 text-center">
          <div className="text-ewb-meta text-[var(--dsw-alias-label-secondary)]">尚未保存过工作流</div>
          <div className="mt-1.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
            去「画布」连好流程后，点工具条的「⇩ 保存」，它就会出现在这里
          </div>
          <button
            type="button"
            data-lens="c"
            onClick={props.onGoCanvas}
            className="pressable is-dark mt-4 rounded-full border border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)] px-3.5 py-1.5 font-mono text-ewb-caption text-[var(--ewb-accent)]"
          >
            去画布
          </button>
        </div>
      )}

      {/* ★ 搜索（票 45，2026-10-28）。位置照提示词库：在列表正上方、与筛选条分开。
       *
       * ## 为什么与类型筛选条分成两块（不并成一行）
       *
       * 两者是**与**关系，但语义不同：搜索是「找特定的那一份」，类型是「缩小范围」。
       * 并成一行会让用户以为二选一 —— 而提示词库那两个控件是分开的，对齐过去。 */}
      {rows.length > 0 && (
        <div data-ewb-wf-search-bar="" className="mb-2 flex flex-wrap items-center gap-1.5">
          <input
            data-ewb-wf-search=""
            className="min-w-0 flex-1 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1 font-mono text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none"
            value={q}
            placeholder="搜名字与说明"
            onChange={(e) => { setQ(e.target.value) }}
          />
          <span data-ewb-wf-hit-count="" className="flex-none font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
            {String(shownRows.length)} 份
          </span>
          {q === '' && typeFilter.length === 0
            ? null
            : (
              <button
                type="button"
                data-ewb-wf-clear=""
                data-lens="c"
                className="pressable is-dark flex-none rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]"
                onClick={() => { setQ(''); setTypeFilter([]) }}
              >清空条件</button>
            )}
        </div>
      )}

      {/* ★ 类型筛选条（用户 m00888 第 ③ 条：「列表要能按类型筛选」）──────
       *
       * 形态照顶部的 tab：一排可点的胶囊，可多选（**并集**，用户 m00888 的要求）。
       *
       * ⚠️ **2026-10-17 改成常驻**（原来是「一份类型都没填过就整条不显示」）。
       * 那个条件让入口**几乎从不出现** —— 用户本机 12 份存档里只有 1 份填过类型，
       * 于是他一次都没见过这排胶囊，以为「分类选择」这个功能根本不存在。
       * 现在：只要有工作流就显示，没填过时**明说去哪填**（不静默）。 */}
      {rows.length > 0 && (
        /* ⚠️ data-ewb-type-filter 是给测试用的**锚点**（2026-10-17 加）：
         * 不加的话测试只能按 aria-pressed 找，而画布工具条的按钮也带那个属性 ——
         * 选择器一宽就把别的按钮捞进来（实测捞到了「隐藏对话区」）。 */
        <div data-ewb-type-filter="" className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">类型</span>
          {allTypes.length === 0 && (
            <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
              （还没给任何一份打过标签 —— 展开某一份，在里面加）
            </span>
          )}
          {allTypes.map(t => {
            const on = typeFilter.includes(t)
            return (
              <button
                key={t}
                type="button"
                data-lens="c"
                aria-pressed={on}
                title={on ? '去掉这个筛选' : '只看这一类'}
                onClick={() => {
                  setTypeFilter(on ? typeFilter.filter(x => x !== t) : [...typeFilter, t])
                }}
                className={
                  'pressable rounded-full px-2.5 py-0.5 font-mono text-ewb-caption ' +
                  (on
                    ? 'border border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)] text-[var(--ewb-accent)]'
                    : 'border border-[var(--dsw-alias-border-l2)] text-[var(--dsw-alias-label-secondary)]')
                }
              >{t}</button>
            )
          })}
          {typeFilter.length > 0 && (
            <button
              type="button"
              onClick={() => { setTypeFilter([]) }}
              className="pressable font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)] underline"
            >清除筛选</button>
          )}
          {/* ⚠️ 筛完一份都没有时**要说清是什么筛掉的**，不是「列表空了」。
           *
           * ★ 票 45 改：原来只说「这一组类型下没有工作流」—— 现在多了搜索，
           * 那句话会把「搜不到」误报成「这一类没有」。两种原因分开说。 */}
          {shownRows.length === 0 && (
            <span data-ewb-wf-no-hit="" className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
              {q.trim() === ''
                ? '（这一组类型下没有工作流）'
                : '（没有名字或说明含「' + q.trim() + '」的工作流）'}
            </span>
          )}
        </div>
      )}
      {/* ★ **瀑布流**（用户 m02540 / m02546：「高度不固定根据内容来，宽度固定
       * 根据页面宽度决定放几个」）─────────────────────────────────────────
       *
       * ⚠️ **从 grid 换成 CSS 多列**（2026-10-17）：这不是风格偏好，是能力问题 ——
       *   · grid 的每行会被**拉成等高**（`items-start` 只让卡片自己不被拉伸，
       *     同一行的行高仍由最高的那张决定）→ 卡片之间留出大片空白，
       *     正是用户说的「不是我要的」；
       *   · 多列则是「**列宽固定、列数随容器宽度自动算**、每张卡片高度各按内容、
       *     按列顺序从上往下填」—— 就是他要的形态。
       *
       * 三处必须一起写，少一处就退化成半吊子（逐条都有理由）：
       *   ① `columns-ewb-card` —— 列宽 320px（令牌在 tailwind.css 的 @theme 里）。
       *      浏览器按容器宽度自己算能放几列，**不再需要 lg/2xl 断点**：
       *      这个容器在右栏里、宽度不是视口宽度，断点本来就只是近似。
       *   ② `break-inside-avoid` —— 没有它，一张卡片会被**从中间劈到两列去**。
       *   ③ `mb-2.5` —— `gap` 只管**列之间**的横向间隔；多列布局里卡片是按块级
       *      顺序流的，**纵向间隔得自己给**（grid 时代由行高自动留）。
       *
       * ⚠️ 多列布局下卡片的走向是「**先填满第一列，再填第二列**」（竖着走），
       * 不是网格那种横着走。对「几十份工作流按名字排」这个场景，竖着走反而更好找。
       *
       * ⚠️ 已知取舍：某张卡片**展开**后自身变高，它所在列之后的内容会下移，
       * 其它列不动。这是多列布局的固有行为，不是 bug —— 换来的是「未展开时不留空白」。
       * 用户明确要的就是这个（「高度不固定根据内容来」）。 */}
      {rows.length > 0 && (
        /* ⚠️ **`px-1` 是补「右侧边界看不见」的**（用户 m03635 第 1 条）：
         * 卡片自己有 `border`，右边那一像素贴着滚动容器的裁剪边缘 ——
         * 左边有页面留白看得见、右边看不见，于是像「卡片没有右边框」。
         * 给容器一点内边距，两边就对称了（不是改卡片宽度，宽度由列宽令牌管）。 */
        <div className="columns-ewb-card gap-2.5">
          {shownRows.map(r => {
            const expanded = openName === r.name
            return (
              <div
                key={r.name}
                /* ⚠️ **`mr-2.5` 是补「右侧边框看不见」的**（用户 m03638 截图）：
                 * 卡片那 1px 边框正好压在滚动容器的裁剪边界上（`.tabScroll` 是
                 * `overflow-x: hidden`），左边还在容器内、右边被裁掉 ——
                 * 于是「只有左边看得见边框」。给右侧留一条真正的缝。
                 *
                 * ⚠️ 不用容器的 `px-1`：多列布局下容器的 padding 只影响列盒，
                 * 最后一列会不会被裁仍取决于内容宽度，不可靠（试过，无效）。 */
                className="mb-2.5 mr-2.5 break-inside-avoid overflow-hidden rounded-card border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-base)]"
              >
                {/* ── 主行（用户 2026-10-14 要求：常用按钮**不用展开就能看到**）──
                 *
                 * 用户原话：「工作流管理里面的工作流的几个按钮不应该是在展开后才看到，
                 * 比如执行，在画布打开（**删除可以是展开后才看到**）
                 * 另外增加一个**打开目录**的按钮。」
                 *
                 * ⚠️ 原来是**一个整行 `<button>`**（点哪都展开）。现在主行上有按钮了，
                 * 而 **HTML 不允许按钮嵌套按钮**（React 会警告、浏览器行为未定）——
                 * 所以整行改成 `div`，用 `onClick` 承担「点空白处展开」，
                 * 各按钮自己 `stopPropagation`（点按钮不该顺带展开/收起）。
                 *
                 * 展开箭头仍是行内元素，点箭头与点行空白等效（都是展开/收起）。 */}
                <div
                  data-lens="r"
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  onClick={() => { setOpenName(expanded ? null : r.name) }}
                  onKeyDown={e => {
                    /* 键盘可用（无障碍）：Enter / 空格与点击等效。 */
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setOpenName(expanded ? null : r.name)
                    }
                  }}
                  /* ★ **竖版排版**（用户 m03287：「当前卡片是横版，我要的是竖版」，
                   * 并在 m03330 确认是「乙」：按钮挪到卡片下面、标题与备注各自独立、
                   * 时间与「X 小时前」放一起、卡片高度随内容）。
                   *
                   * ⚠️ 原来是 `flex-wrap items-center`（横着一行：箭头 + 标题 + 元信息 +
                   * 三个按钮 + 时间胶囊）。竖版之后右栏窄时不会再挤成两行乱掉。 */
                  className="pressable flex w-full cursor-pointer flex-col gap-1 px-5 py-4 text-left hover:bg-[color-mix(in_oklab,var(--dsw-alias-label-primary)_4%,transparent)]"
                >
                  {/* 标题行：箭头 + 标题在同一行（竖版后箭头若单独占一行会很怪）。 */}
                  <div className="flex min-w-0 items-center gap-2">
                    {/* 展开箭头：收起是右，展开是下（照它的 chevron）。 */}
                    <span className="shrink-0 text-[var(--dsw-alias-label-tertiary)]" aria-hidden="true">
                      {expanded ? '▾' : '▸'}
                    </span>
                    {/* 标题：**一行**（用户 m03330：「标题一行」）。 */}
                    <div className="min-w-0 flex-1 truncate text-ewb-body font-semibold text-[var(--dsw-alias-label-primary)]">{r.name}</div>
                  </div>
                  <div className="min-w-0">
                    {/* 一句话说明（用户 2026-10-14 要求）。
                     * ⚠️ **老存档没有这个字段 → 不显示这一行**（不留空行、不写「无」）——
                     * 空着比写「无」干净，而且那些工作流本来就该由用户补说明。 */}
                    {/* 备注：**自适应多行**（用户 m03330：「备注自适应」）。
                     * 原来是 `truncate`（一行就砍），现在正常换行 —— 卡片高度随内容走，
                     * 这正是瀑布流要的前提（列宽固定、高度各按内容）。 */}
                    {typeof r.description === 'string' && r.description !== '' && (
                      /* 备注比小字大一号（用户 m03635：「备注文字大一号」）——
                       * 原来与「节点 / 连线」那些元信息同级，读起来像附带注释；
                       * 它其实是**这张卡片的第二重要信息**。 */
                      <div className="mt-1 text-ewb-meta leading-relaxed text-[var(--dsw-alias-label-secondary)]" style={{ overflowWrap: 'anywhere' }}>{r.description}</div>
                    )}
                    {/* 元信息（最后一排）：规模 + 「修改于 … · X 小时前」，**挤在一排**。
                     *
                     * 用户 m03287：「修改时间和 X 小时前应该放一起」（原来「X 小时前」是行尾
                     * 独立的胶囊、「修改时间」在展开区指标格里 —— 同一件事分两处）；
                     * m03330：「用小字就行了」；m03635：「放最后一排、限制一排、去掉多余空行」。
                     *
                     * ⚠️ **这一处注释曾经写成了不带花括号的块注释**，于是 JSX 把注释文本
                     * 当成 children **直接渲染到卡片上**了（用户截图里那行「⚠️ 这一排要贴紧…」）。
                     * JSX 里的注释**必须**包在 `{…}` 里，否则它就是文本。 */}
                    <div className="mt-0.5 flex min-w-0 items-center gap-x-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)] whitespace-nowrap">
                      <span className="min-w-0 truncate">
                        {r.nodes !== undefined && String(r.nodes) + ' 节点'}
                        {r.edges !== undefined && ' / ' + String(r.edges) + ' 连线'}
                      </span>
                      {r.at !== undefined && (
                        <span className="min-w-0 truncate">修改于 {fmtTime(r.at)} · {ago(r.at)}</span>
                      )}
                    </div>
                  </div>

                  {/* 动作区（横排小按钮，宽度不够就换行）。
                   * ⚠️ `data-ewb-card-actions` 是给测试的锚点：没有它，「按钮在卡片下面」
                   * 只能靠猜层级去断言，一改结构就静默失效。 */}
                  <div data-ewb-card-actions="" className="mt-2 flex flex-wrap items-center gap-1.5">
                    {/* ▶ 执行：**不开画布**直接跑（用户 2026-10-11 要求）。
                     *
                     * ⚠️ **开始节点是「被另一个流程调用」时不显示这个按钮**
                     * （用户 m00901 定案：「可被调用不是设置项，而是开始节点是什么决定的」，
                     * 且「可被他人调用也不是有开始节点就有」）。
                     * 理由：那种工作流手动跑**会缺输入**（它的输入是父流程喂的），
                     * 给了按钮只会让人点出一个必然失败的运行。
                     *
                     * ⚠️ 没有开始节点（`startType` 为 null，老存档）**照旧显示** ——
                     * 它自己带初始数据，手动跑没问题；只是接不了外部输入。
                     * 这与「没有开始节点 = 没法接外部输入」是同一条语义的两面。 */}
                    {r.startType !== 'called' && (
                      <button
                        type="button"
                        data-lens="c"
                        disabled={runningName !== null}
                        onClick={e => { e.stopPropagation(); startRun(r.name) }}
                        title={r.startType === 'manual'
                          ? '不打开画布，直接在本机执行该工作流（必填输入会先弹出表单）'
                          : '不打开画布，直接在本机跑完这份工作流（跑完去「运行历史」看细节）'}
                        className="pressable is-dark inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)] px-3 py-1 text-ewb-meta text-[var(--ewb-accent)] disabled:opacity-45"
                      >
                        {runningName === r.name ? '执行中…' : '执行'}
                      </button>
                    )}
                    {/* 「只可被调用」的说明 —— 不显示按钮但**要说清为什么**，
                     * 否则用户会以为这个功能坏了（本文件一贯的「不静默」）。 */}
                    {r.startType === 'called' && (
                      <span
                        className="whitespace-nowrap rounded-full border border-[var(--dsw-alias-border-l2)] px-3 py-1 text-ewb-meta text-[var(--dsw-alias-label-tertiary)]"
                        title="它的开始节点是「被另一个流程调用」—— 手动跑会缺输入，所以这里不给执行按钮。要跑它，用一份工作流里的「跑另一份工作流」节点。"
                      >只可被调用</span>
                    )}
                    <button
                      type="button"
                      data-lens="c"
                      onClick={e => { e.stopPropagation(); open(r.name) }}
                      title="把这份工作流的内容加载到画布上编辑"
                      className="pressable is-dark inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--dsw-alias-border-l2)] px-3 py-1 text-ewb-meta text-[var(--ewb-accent)]"
                    >
                      打开到画布
                    </button>
                    {/* 🗀 打开目录（本轮新增，用户点名）。
                     * 它打开的是**工作流存放目录** —— 因为所有工作流存在同一个平铺目录里
                     * （详见宿主半那条路由的注释），所以就是那个目录。 */}
                    <button
                      type="button"
                      data-lens="c"
                      onClick={e => { e.stopPropagation(); openDir(r.name) }}
                      title="在文件管理器里打开工作流存放目录（就在本机数据目录下）"
                      className="pressable is-dark inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--dsw-alias-border-l2)] px-3 py-1 text-ewb-meta text-[var(--dsw-alias-label-secondary)]"
                    >
                      打开目录
                    </button>
                    {/* ⧉ 复制（票 46，用户 2026-10-28）。
                     * 放在主行动作区（与「打开到画布」「打开目录」并列），
                     * 因为它与它们同一档：都是「对这份工作流做一件事、不打开画布」。
                     * 删除仍在展开区 —— 那是不可逆的，刻意降级。 */}
                    <button
                      type="button"
                      data-lens="c"
                      data-ewb-wf-duplicate={r.name}
                      onClick={e => { e.stopPropagation(); duplicate(r.name) }}
                      title="复制出一份新的工作流，名字自动加「副本」；原件不动"
                      className="pressable is-dark inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--dsw-alias-border-l2)] px-3 py-1 text-ewb-meta text-[var(--dsw-alias-label-secondary)]"
                    >
                      复制
                    </button>
                  </div>
                </div>

                {/* 展开区：指标格阵 + 次要操作（照它的展开结构）。
                 * ⚠️ **删除留在这里**（用户明确：「删除可以是展开后才看到」）——
                 * 它不可逆，放在要展开才看到的地方是刻意的降级。 */}
                {expanded && (
                  <div className="border-t border-[var(--dsw-alias-border-l2)] px-5 pb-5 pt-4">
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                      <Metric label="节点" value={String(r.nodes ?? 0)} />
                      <Metric label="连线" value={String(r.edges ?? 0)} />
                      <Metric label="类型" value={(r.types ?? []).length === 0 ? '未分类' : (r.types ?? []).join('、')} sub="展开区可改" />
                      <Metric label="状态" value="已保存" sub="本机文件" />
                    </div>
                    <div className="mt-4 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        data-lens="c"
                        onClick={() => { remove(r.name) }}
                        className="pressable is-dark inline-flex items-center gap-1.5 rounded-full border border-[color-mix(in_oklab,var(--dsw-alias-state-error-primary)_35%,transparent)] px-3.5 py-1.5 text-ewb-meta text-[var(--dsw-alias-state-error-primary)]"
                      >
                        删除
                      </button>
                      {/* ★ 类型（用户 m00861）：**可多选、可自由填、能当场新建**
                       * （m00888 定的三条）。控件与收藏分类**共用一份**（TagPicker，
                       * 用户 m00901 要求「公用一份」）—— 这里用多值版。
                       *
                       * ⚠️ 它**只是给人看的标签**：「能不能被调用」由开始节点的类型算
                       * （用户 m00901 的修正），所以这里改它**不会**改变执行行为。 */}
                      <div className="flex w-full flex-col gap-1">
                        <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">类型</span>
                        <TagPickerMulti
                          id={'ewb-wf-types-' + r.name}
                          values={r.types ?? []}
                          options={typeOptions(allTypes)}
                          onChange={next => { editTypes(r.name, next) }}
                          placeholder="选一个，或打一个新名字后回车（可多个）"
                        />
                      </div>
                      {/* ★ 改名 / 改说明（用户 m00861：「增加编辑工作流名称与说明的按钮」）。
                       *
                       * ⚠️ 放在**展开区**而不是主行：这两个不是高频动作，而主行已经
                       * 有「执行 / 打开到画布 / 打开目录」三个常用按钮了（挤一起会换行）。
                       * 删除也在这块里，同类动作聚在一起。
                       *
                       * ★ 2026-10-18 改造（用户：「改名改说明两个按钮没有实际作用」）：
                       * 原来点它们调 `window.prompt` —— **在 Electron 里直接抛错**
                       * （Chromium 早已不实现 `prompt`），外面又没有 catch，
                       * 于是点了毫无反应。现在改成**就地展开一个输入框**，
                       * 点按钮才把那一格换成编辑态，点「存」才真写。
                       *
                       * ⚠️ 「改名」的输入框放在这排按钮**之后**（与「改说明」同一块），
                       * 因为改名会重排整张卡片（名字变了、按名字排序的位置也变了），
                       * 塞在按钮中间会让点击目标在按下的同一帧里跳走。 */}
                      <button
                        type="button"
                        data-lens="c"
                        onClick={() => { setEditing({ name: r.name, field: 'name' }); setDraft(r.name) }}
                        title="改工作流名字（存档文件名会跟着改）"
                        className="pressable is-dark inline-flex items-center gap-1.5 rounded-full border border-[var(--dsw-alias-border-l2)] px-3.5 py-1.5 text-ewb-meta text-[var(--dsw-alias-label-secondary)]"
                      >改名</button>
                      <button
                        type="button"
                        data-lens="c"
                        onClick={() => { setEditing({ name: r.name, field: 'desc' }); setDraft(r.description ?? '') }}
                        title="写一句「这份工作流是做什么的」，显示在列表里"
                        className="pressable is-dark inline-flex items-center gap-1.5 rounded-full border border-[var(--dsw-alias-border-l2)] px-3.5 py-1.5 text-ewb-meta text-[var(--dsw-alias-label-secondary)]"
                      >改说明</button>
                      <span className="ml-auto font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]" title={dir}>
                        {dir !== '' ? dir : ''}
                      </span>
                    </div>

                    {/* ★ 就地编辑格（用户 2026-10-18）。
                     *
                     * 独立成一排、**跨满整行**：说明可能很长，挤在按钮那排会把它压成一条。
                     * `data-ewb-inline-edit` 是给测试的锚点（与 `data-ewb-card-actions` 同理）。 */}
                    {editing !== null && editing.name === r.name && (
                      <div className="mt-3 flex flex-col gap-1.5" data-ewb-inline-edit={editing.field}>
                        <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">
                          {editing.field === 'name' ? '新名字（文件名会跟着改）' : '说明（留空 = 不显示）'}
                        </span>
                        {editing.field === 'name' ? (
                          <input
                            type="text"
                            value={draft}
                            autoFocus
                            aria-label="工作流新名字"
                            placeholder={r.name}
                            onChange={e => { setDraft(e.target.value) }}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                rename(r.name, draft)
                                setEditing(null)
                              } else if (e.key === 'Escape') {
                                setEditing(null)
                              }
                            }}
                            className="rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1.5 text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none"
                          />
                        ) : (
                          <textarea
                            value={draft}
                            autoFocus
                            rows={2}
                            aria-label="工作流说明"
                            placeholder="一句话说清这份工作流是做什么的"
                            onChange={e => { setDraft(e.target.value) }}
                            onKeyDown={e => {
                              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                                e.preventDefault()
                                editDesc(r.name, draft)
                                setEditing(null)
                              } else if (e.key === 'Escape') {
                                setEditing(null)
                              }
                            }}
                            className="rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1.5 text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none"
                          />
                        )}
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            data-lens="c"
                            onClick={() => {
                              if (editing.field === 'name') rename(r.name, draft)
                              else editDesc(r.name, draft)
                              setEditing(null)
                            }}
                            className="pressable is-dark rounded-full border border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)] px-3 py-1 text-ewb-meta text-[var(--ewb-accent)]"
                          >存</button>
                          <button
                            type="button"
                            data-lens="c"
                            onClick={() => { setEditing(null) }}
                            className="pressable is-dark rounded-full border border-[var(--dsw-alias-border-l2)] px-3 py-1 text-ewb-meta text-[var(--dsw-alias-label-secondary)]"
                          >取消</button>
                          <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                            {editing.field === 'name' ? '回车 = 存，Esc = 取消' : 'Ctrl+回车 = 存，Esc = 取消'}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
    </>
  )
}
