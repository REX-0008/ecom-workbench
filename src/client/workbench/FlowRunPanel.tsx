/** 流程级运行面板：**边跑边看**（用户 m00789 定案用 SSE；计划 Step 3.1 的「输出」）。
 *
 * ## 为什么要它
 *
 * 用户原话（m00716）：「外部输入输出到前端，输出流程进度类似 bat」。
 * 在此之前，不开画布跑一份工作流只能：
 *   · 点「执行」→ 等它跑完 → 去「运行历史」挨个点开节点看日志。
 * 一次跑十几分钟时，「跑没跑、跑到哪了」完全看不见 —— 这正是 bat 窗口
 * 那种「一行行往下滚」要解决的问题。
 *
 * ## 它怎么拿到数据
 *
 * 订阅宿主半的 `GET /api/ecom-workbench/workflow/run-stream`（SSE）：
 *   · `event: step` —— 每一步（排队 / 开始 / 成功 / 失败 / 跳过 / 中断 / 日志）；
 *   · `event: done` —— 收尾（成没成、跑了哪些、产出是什么）。
 *
 * ## 三条不做（克制）
 *
 *   ① **不复用运行历史的数据结构** —— 那是「跑完之后逐节点回看」，字段与语义都不同
 *      （它按节点聚合，这里按时间顺序）。硬合会两边都别扭。
 *   ② **不自己攒历史** —— 跑完就在那儿；要回看用「运行历史」。
 *   ③ **不做暂停/取消** —— 宿主半那条路明说「客户端断开不当作取消」，
 *      给它一个「取消」按钮反而会造出一件做不到的事。
 */
import { useEffect, useRef, useState } from 'react'
import { useRunStore } from './run-store.ts'

/** 一条按时间排开的步骤。 */
export interface FlowStep {
  /** 事件种类（与宿主半的 RunEvent 一致）。 */
  kind: string
  /** 节点实例 id。 */
  nodeId: string
  /** 日志行（kind === 'log' 时有）。 */
  line?: string
  /** 节点类型名（kind === 'started' 时有）。 */
  label?: string
  /** 失败原因（kind === 'failed' 时有）。 */
  error?: string
  /**
   * 这一段**新增**的字（`kind === 'stream'` 时有）。
   *
   * ⚠️ 是**增量**不是累计：引擎侧有断言钉着（`agent-stream.mjs` 把三片拼起来
   * 必须得到 `甲乙丙丁`，若把 `text` 当累计全文再拼一次会得到 `甲甲乙丙甲乙丙丁`）。
   * 所以这里**直接追加**，不要再自己拼一遍。
   */
  text?: string
}

/**
 * 这一帧是不是「模型正在吐字」。
 *
 * ## 它为什么不进步骤列表（票 14）
 *
 * 一帧几个字，一次生成能来几百帧。塞进 `steps` 有两个后果：
 *
 *   ① `setSteps(prev => [...prev, …])` 每帧复制整个数组 —— 越跑越慢；
 *   ② 用户看的是「跑到第几步」，中间几百行「甲」「乙」「丙」把真正的失败
 *      信息挤出视野。
 *
 * 这些字**有更好的去处**：节点自己的运行时面板（`run-store` 的 `stream` 字段，
 * 由 `NodeRunPanel` 画在节点身上）。那里会一点点长出来，正是用户要的效果。
 *
 * 所以 `stream` 帧**喂 store、不进 steps**。
 *
 * @param e - 事件。
 * @returns 是吐字帧则 true。
 */
export function isStreamFrame(e: { kind: string }): boolean {
  return e.kind === 'stream'
}

/** 收尾信息。 */
export interface FlowDone {
  ok?: boolean
  aborted?: boolean
  ran?: string[]
  error?: string
  declaredOutputs?: Record<string, unknown>
}

/**
 * 每一步前面的小标记（**形状本身就是第二重编码**，色盲也能区分）。
 *
 * 与画布上节点状态的标记同一套思路 —— 用户在哪都能认出「这是成功了」。
 */
const MARK: Record<string, string> = {
  queued: '·',
  started: '▸',
  success: '✓',
  failed: '✕',
  skipped: '⏭',
  aborted: '■',
  log: ' ',
  /* ⚠️ **故意不给 `report` 加标记**（票 05，2026-10-30）。
   *
   * 「只显示汇报」那一支用的是 `MARK[e.kind] ?? '●'`，缺键时自然落回 `●`，
   * 不需要在这里注册。反过来，在这里注册会**改掉默认模式的画面**：
   *
   * 默认模式（画布 / 列表页）里 `report` 帧本来也会进 `steps`，渲染成
   * 「` ` + nodeId + ` report`」（MARK 里没这个键 → 一个空格）。
   * 一旦补上 `report: '●'`，那些行会从「空格」变成「●」——
   * 而票面要求默认模式的输出**逐字不变**（`tests/collect-live-report.mjs`
   * 的 ⑤ 段拿字面量钉着这一行）。
   *
   * 那个「空格 + report」的旧观感不好看，但它是**既有行为**，
   * 要改得单独立票，不在本单里顺手改。 */
}

/**
 * 一个步骤该不该显示。
 *
 * ⚠️ **`queued` 不显示**：一份大工作流一开跑就是几十条「排队中」，
 * 会把真正在看的东西刷掉。它对应的事实（「这次要跑哪些」）由收尾的
 * 「跑了 N 个节点」回答了。
 *
 * ⚠️ **`stream` 也不显示**：它根本不进 `steps`（见 `isStreamFrame`），
 * 但这里仍然排一次 —— 万一哪天有人改回「先进 steps 再分流」，
 * 这一条能兜住「几百行单字把结果刷掉」那个后果。两道闸比一道稳。
 *
 * @param e - 事件。
 * @returns 该显示则 true。
 */
function worthShowing(e: FlowStep): boolean {
  if (e.kind === 'queued' || e.kind === 'stream') return false
  return e.kind !== 'log' || (e.line ?? '') !== ''
}

/**
 * 流程级运行面板。
 *
 * @param props.name - 要跑的工作流名（`null` = 不显示面板）。
 * @param props.inputs - 要喂给它的输入（已填好的值）。
 * @param props.onClose - 关掉面板。
 * @returns 面板元素。
 */
/**
 * 流程级运行面板。
 *
 * @param props.name - 要跑的工作流名（`null` = 不显示面板）。
 * @param props.inputs - 要喂给它的输入。
 * @param props.onClose - 关掉面板。
 * @param props.onDone - 跑完时回调（带结果）。
 *   ⚠️ **2026-10-18 新增，起因是一个真 bug**：列表页点「执行」原来会**同时**
 *   发 `POST /workflow/run` 与开这条 SSE —— 于是整份工作流**跑两遍**、
 *   运行历史里一次点击出两条记录（用户 m03635 报的「跑一个会出现多个」）。
 *   现在 SSE 是**唯一真正跑**的那条，收尾结果交给这个回调去更新界面。
 * @returns 面板元素。
 */
export function FlowRunPanel(props: {
  name: string | null
  inputs: Record<string, unknown>
  onClose: () => void
  onDone?: (res: FlowDone) => void
  /**
   * 只显示**节点主动汇报**（票 05，2026-10-30）。
   *
   * ## 为什么加这个入参，而不是另写一套订阅
   *
   * 用户第 6 条要的是「跑的时候下半部分显示**任务记录**，不是运行历史」。
   * 两条路都能做到：
   *
   *   (a) 给这个组件加一个「只显示汇报」模式；
   *   (b) 任务中心自己订阅同一条 SSE、只收 `report`。
   *
   * **选了 (a)**。理由：`(b)` 等于把 SSE 那套搬一遍 —— 连接、坏帧丢弃、
   * `done` 之后主动 `close()`（防 EventSource 自动重连把工作流跑第二遍）、
   * 输入走查询串 —— 这四条哪一条漏了都出真 bug，而两份代码迟早会漂。
   * 共用一份，「怎么收事件」只有一处。
   *
   * ## 默认 `false`，画布与列表页的行为**一个字节不变**
   *
   * 传这个参数的两条路（画布 / 列表页）都不传它 → 走原来的分支。
   * 有一条断言钉着：同一批事件喂进去，默认模式渲染的行数 / 行内容 / 顺序
   * 必须与加这个参数之前一致（`tests/collect-live-report.mjs` 的 ⑤ 段）。
   *
   * ## 收什么、不收什么
   *
   * `kind === 'report'` 才进列表（形状见 `src/workflow/model.ts:253` 的 `ReportEntry`）。
   * `queued` / `started` / `success` / `failed` / `skipped` / `log` 全不进 ——
   * 那些是**节点级运行历史**，用户明确说任务中心不该显示它们。
   *
   * ⚠️ 汇报**不随 done 清空**（用户原话「跑完了不清楚而是直接显示」）。
   * 清空的时机是「下一次重新跑」—— 那由 `props.name`/`props.inputs` 变化时
   * effect 里那次 `setSteps([])` 管（下面那行，跑新的一份或重跑同一份都会走到）。
   */
  reportsOnly?: boolean
}) {
  const [steps, setSteps] = useState<FlowStep[]>([])
  const [done, setDone] = useState<FlowDone | null>(null)
  const [err, setErr] = useState('')
  /**
   * 哪些节点正在吐字、已经吐到哪儿（票 14）。
   *
   * 键是节点实例 id，值是**到目前为止的全文**（由一片片追加出来）。
   * 与 `run-store` 里那份是两条路：那份给画布上的节点，
   * 这份给**本页**（用户就在这一页看着它跑，不该要求他切到画布）。
   */
  const [streams, setStreams] = useState<Record<string, string>>({})
  /** 滚动容器（跑起来要**自动滚到底**，否则新行看不见）。 */
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (props.name === null) return
    setSteps([])
    setDone(null)
    setErr('')
    setStreams({})
    /* ⚠️ **`EventSource` 不存在时要退场**（2026-10-17 加）。
     * jsdom 里没有它（本项目的老坑：`matchMedia` / `MutationObserver` 同样缺席），
     * 不判存在的话一挂载就抛 ReferenceError → 整个列表页白屏。
     * 真机上它一直在（所有现代浏览器都有），这层只是防护。 */
    if (typeof EventSource === 'undefined') {
      setErr('这个环境不支持实时推送（EventSource 不可用）')
      return
    }
    /* 输入走查询串：`EventSource` 只能发 GET、带不了请求体。 */
    const qs = 'name=' + encodeURIComponent(props.name)
      + '&inputs=' + encodeURIComponent(JSON.stringify(props.inputs))
    const es = new EventSource('/api/ecom-workbench/workflow/run-stream?' + qs)
    es.addEventListener('step', (ev: MessageEvent<string>) => {
      let parsed: FlowStep
      try {
        parsed = JSON.parse(ev.data) as FlowStep
      } catch {
        /* 坏帧丢掉，不该因此断掉整条流 */
        return
      }
      /* ★ 模型吐字那一支（票 14，2026-10-27）。
       *
       * 引擎在 `run.ts` 的 `llm.stream` 循环里逐片发 `{ kind:'stream', nodeId, text }`，
       * `text` 是**这一段新增的字**。这里直接追进 `run-store` —— 节点身上的运行时
       * 面板（`NodeRunPanel` 的 `run.stream`）会在下一帧渲染出来。
       *
       * 不放进 `steps` 的理由见 `isStreamFrame` 上面那段。
       *
       * ⚠️ **不要**在这里改成累积：引擎发的是增量，再拼一次全文会变成
       * `甲甲乙丙甲乙丙丁` —— `agent-stream.mjs` 那条断言钉的正是这一点。 */
      if (isStreamFrame(parsed)) {
        const chunk = parsed.text ?? ''
        /* 两条路都要喂（票 14）：
         *
         * ① `run-store` —— 画布上那个节点身上的运行时面板（`NodeRunPanel.run.stream`）。
         *    画布在别的 tab 也挂着，用户切过去就能看到那截已经长出来的字。
         * ② 这个面板自己的 `streams` —— 用户就是在**这一页**看着它跑，
         *    不能要求他切到画布才看得见。两份数据来源不同、用途不同，
         *    不是「同一件事写两份」：一个是画布节点，一个是本页的步骤流。 */
        if (chunk !== '') {
          useRunStore.getState().appendStream(parsed.nodeId, chunk)
          setStreams(prev => {
            const next = { ...prev }
            next[parsed.nodeId] = (next[parsed.nodeId] ?? '') + chunk
            return next
          })
        }
        return
      }
      /* ★ 票 05（2026-10-30）：只收汇报的模式。
       *
       * 放在**收进 `steps` 之前**判 —— 用户第 6 条要的是「任务中心那半部分
       * 不显示运行历史类型的输出」，所以节点级事件连进都不该进。
       *
       * ⚠️ **`report` 事件里带的不是 `line`/`label`，而是 `entry`**
       * （引擎那边是 `emit({ kind:'report', nodeId, entry })`，见 `run.ts:1603`）。
       * 直接把它当普通 step 塞进列表的话，渲染那行会变成「n1 report」这种
       * 认不出的东西 —— `MARK` 表里也没有 `report`（`:87-95` 只有七种）。
       *
       * 所以这里把 `entry` 摊到 step 的字段上：`line` 放 `message`，
       * 于是下面那一套渲染（`e.kind === 'log' ? e.line : …`）能直接画出人话。
       * 同时补一个 `report` 标记进 `MARK`，让这一行有个可辨的小图标。 */
      if (props.reportsOnly === true) {
        if (parsed.kind !== 'report') return
        const entry = (parsed as unknown as { entry?: { message?: unknown, files?: unknown } }).entry
        const message = entry !== undefined && typeof entry.message === 'string' ? entry.message : ''
        if (message === '') return
        setSteps(prev => [...prev, { ...parsed, kind: 'report', line: message }])
        return
      }
      setSteps(prev => [...prev, parsed])
    })
    es.addEventListener('done', (ev: MessageEvent<string>) => {
      let parsed: FlowDone | null = null
      try { parsed = JSON.parse(ev.data) as FlowDone } catch { /* 同上 */ }
      if (parsed !== null) {
        setDone(parsed)
        /* 通知外面（列表页据此刷新列表与提示）—— 两条跑路合成一条之后，
         * 收尾信息只有这里拿得到。 */
        props.onDone?.(parsed)
      }
      /* ⚠️ 服务器发完 `done` 就 `end()` 了；这里主动关一次，免得
       * `EventSource` 按规范**自动重连**、把整份工作流跑第二遍。 */
      es.close()
    })
    es.onerror = () => {
      /* 服务器正常收尾断开时也会触发 onerror —— 那时已经有 done 了，
       * 不当成错误报。真正连不上时才显示原因。 */
      setErr(prev => (prev === '' ? '连接断了（要么跑完了，要么宿主半没在）' : prev))
      es.close()
    }
    return () => { es.close() }
  }, [props.name, props.inputs, props.onDone])

  /* 有新行就滚到底（bat 窗口的行为）。
   *
   * ⚠️ **吐字也要滚**（票 14）：`streams` 每来一片就是新对象，把它放进依赖里，
   * 那截字往上长的时候视口跟着走。不放的话用户得自己往下拖。 */
  useEffect(() => {
    const el = boxRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [steps.length, done, streams])

  if (props.name === null) return null

  return (
    <div data-ewb-flow-panel="" className="mb-3 rounded-card border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-base)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--dsw-alias-border-l2)] px-4 py-2">
        <span className="truncate text-ewb-meta font-semibold text-[var(--dsw-alias-label-primary)]">
          {done === null ? '正在跑：' : (done.ok === true && done.aborted !== true ? '跑完了：' : '中断了：')}{props.name}
        </span>
        <button
          type="button"
          data-lens="c"
          onClick={props.onClose}
          className="pressable is-dark shrink-0 rounded-full border border-[var(--dsw-alias-border-l2)] px-2.5 py-0.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]"
        >收起</button>
      </div>

      {/* ★ 票 05（2026-10-30）：只显示汇报的模式下，这一块整体换一套渲染。
       *
       * 为什么不复用下面那段：下面那段是**节点级运行历史**的行
       * （`nodeId + label` / `log 行` / 成败着色），而汇报要显示的是
       * `entry.message` 那一句人话 —— 结构不同，硬套只会让两边都别扭。
       *
       * ⚠️ 但**默认模式那一支一个字符都没动**（就是下面原来那段），
       * 两条分支各自完整，不共享渲染代码 —— 这样「画布与列表页不变」
       * 是**看一眼就能确认的**，不需要靠推理。 */}
      {props.reportsOnly === true
        ? (
          <div
            ref={boxRef}
            data-ewb-flow-reports=""
            className="max-h-[38vh] overflow-y-auto px-4 py-2 font-mono text-ewb-caption leading-relaxed"
          >
            {steps.length === 0 && done === null && err === ''
              ? <div className="text-[var(--dsw-alias-label-tertiary)]">正在启动…（还没有节点汇报）</div>
              : null}
            {steps.map((e, i) => (
              <div
                key={String(i)}
                data-ewb-flow-report={String(i)}
                className="flex items-start gap-1.5 text-[var(--dsw-alias-label-secondary)]"
              >
                <span className="shrink-0 opacity-70">{MARK[e.kind] ?? '●'}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap">{e.line ?? e.label ?? e.nodeId}</span>
              </div>
            ))}
            {err !== '' && <div className="text-[var(--dsw-alias-state-error-primary)]">⚠ {err}</div>}
          </div>
        )
        : (
      <div ref={boxRef} className="max-h-[38vh] overflow-y-auto px-4 py-2 font-mono text-ewb-caption leading-relaxed">
        {steps.filter(worthShowing).map((e, i) => (
          <div
            key={String(i)}
            className={
              e.kind === 'failed' ? 'text-[var(--dsw-alias-state-error-primary)]'
                : e.kind === 'success' ? 'text-[var(--dsw-alias-state-success-primary)]'
                  : e.kind === 'skipped' ? 'text-[var(--dsw-alias-label-tertiary)]'
                    : 'text-[var(--dsw-alias-label-secondary)]'
            }
          >
            <span className="mr-1.5 opacity-70">{MARK[e.kind] ?? ' '}</span>
            {e.kind === 'log'
              ? e.line
              : (e.kind === 'failed' ? e.nodeId + '：' + (e.error ?? '失败') : e.nodeId + ' ' + (e.label ?? e.kind))}
          </div>
        ))}
        {/* ★ 正在吐的字（票 14）。放在步骤列表**末尾** —— 它就是最新的东西，
         * 跟着那条「有新内容就滚到底」一起滚，用户不用自己往下拖。
         *
         * `whitespace-pre-wrap`：模型会吐换行，不保留的话整段会挤成一行。
         * `data-ewb-flow-stream`：断言与眼睛都靠它找这一块。 */}
        {Object.entries(streams).map(([id, text]) => (
          text === ''
            ? null
            : (
              <div
                key={'stream-' + id}
                data-ewb-flow-stream={id}
                className="whitespace-pre-wrap text-[var(--dsw-alias-label-primary)]"
              >
                <span className="mr-1.5 opacity-70">▍</span>
                {text}
              </div>
            )
        ))}
        {steps.length === 0 && done === null && err === '' && (
          <div className="text-[var(--dsw-alias-label-tertiary)]">正在启动…（这一步要等宿主半派发第一个节点）</div>
        )}
        {err !== '' && <div className="text-[var(--dsw-alias-state-error-primary)]">⚠ {err}</div>}
      </div>
        )}

      {done !== null && (
        <div className="border-t border-[var(--dsw-alias-border-l2)] px-4 py-2">
          {/* 结论一行说清：成没成、跑了几个。
           *
           * ⚠️ 票 05：这一行**不替换**上面的汇报内容，是**追加**在下面。
           * 用户原话：「跑完了之后只显示是否成功，这个逻辑不对……跑完了不清楚
           * 而是直接显示」。所以汇报留在原地，这一行只是补充一句结论。 */}
          <div className="font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
            {done.ok === true && done.aborted !== true
              ? '执行完成，共跑 ' + String(done.ran?.length ?? 0) + ' 个节点'
              : '执行中断：' + (done.error ?? '有节点失败') + '（已跑 ' + String(done.ran?.length ?? 0) + ' 个节点）'}
          </div>
          {/* 产出：结束节点声明了什么就给什么（没有结束节点时这里是空的）。 */}
          {done.declaredOutputs !== undefined && Object.keys(done.declaredOutputs).length > 0 && (
            <div className="mt-1.5 font-mono text-ewb-caption">
              <span className="text-[var(--dsw-alias-label-tertiary)]">产出 </span>
              <span className="text-[var(--dsw-alias-label-primary)]">
                {Object.entries(done.declaredOutputs)
                  .map(([k, v]) => k + ' = ' + (typeof v === 'string' ? v : JSON.stringify(v)))
                  .join(' ｜ ')}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
