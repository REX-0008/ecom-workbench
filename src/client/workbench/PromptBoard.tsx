/** 提示词板块：模板库 + 填变量 + 复制 / 插入 + **按模板改写**。
 *
 * ## 两批：先模板库，再优化器
 *
 * 第一批只做「挑模板、填变量、复制」—— 那时 `ai.agent` 节点还没落地，不调任何接口。
 * 第二批（2026-10-23）加一条**改写**路径：把「当前模板正文」当指令、把用户
 * 自己写的那段当参考资料，交给工作流里的 `ai.agent` 节点去改，取回模型写的文字。
 *
 * ## 改写为什么必须走工作流，不许直接调模型
 *
 * 项目纪律：**调模型是业务动作，做成工作流**。界面这边只发「请跑这份工作流」，
 * 模型由工作流里的节点去调 —— 于是：
 *   · 额度、超时、失败重试都在工作流那一层，界面不必各写一遍；
 *   · 改写过程会落进运行历史，出问题时能回看每一步；
 *   · 换模型、调提示词不用改界面。
 *
 * ## 三栏的理由
 *
 * 左窄右宽，与「工作流管理」同一套观感：
 *   · 左：模板清单，按分类分组（分类顺序来自 `templates/index.ts`）；
 *   · 右上：正文。**默认只读**，点「编辑」才可改 —— 模板是参照物，
 *     一进来就能改的话，下一次打开会发现原样没了（改的是内存里的副本，切模板就丢，
 *     用户会以为「改了没用」）。
 *   · 右下：变量 + 改写。改写区在变量下面：先挑模板、填变量，再看要不要交给模型加工。
 *
 * ## 「插入到输入框」为什么是降级实现
 *
 * dsh 把「往输入框插文字」的能力（`slash/input-insert-text` 那条事件 / `InputActions.insertText`）
 * **只发给 session 作用域里的组件**（`docs/subsystems/slots.md` 的标准 props 表：
 * `inputActions` 只在 `session` / `session-maybe` 两个作用域提供）。
 * 而本板块挂在 `shell.overlay`，那个槽位是 **root 作用域**（`ui-layout/src/client/index.ts:98`）——
 * 拿不到 `inputActions`，也拿不到 session 的 ctx 去调 `conversation.input.for(actx)`。
 *
 * 所以按任务书的要求**如实降级**：按钮禁用 + 旁边写明原因 + 说明替代动作（复制后手动粘贴）。
 * **不做**「点了没反应」的按钮（本项目已经踩过这个坑，见 `WorkflowList.tsx` 的改名按钮）。
 *
 * ## 文案守 R6
 *
 * 不用第二人称（写「现有提示词」，不写「你的提示词」）、不用口语词、不用疑问句做标签。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
/* 只管类型：本仓没有全局 `React` 命名空间，用 `React.ReactNode` 会给 check:client 添新错。 */
import type { ReactNode } from 'react'
import type { BoardProps } from './board-registry.ts'
import { PROMPT_CATEGORIES, PROMPT_TEMPLATES, fillVars, findVars, templatesOf, varLabel } from './templates/index.ts'
import type { PromptTemplate } from './templates/index.ts'
/* 粗体渲染：**全仓唯一一份实现**（2026-10-25 契约 BJ 从本文件抽出去的）。
 * 提示词库也要用它 —— 两处各写一份必然漂。 */
import { renderEmphasis } from './emphasis-render.tsx'
import { Badge, Label } from './terminal.tsx'

/** 做改写的那份工作流（**编号 + 名字 + 字段名都是与工作流角色的约定**）。
 *
 * ## 为什么用编号而不是名字
 *
 * 宿主半的 `POST /workflow/run` **编号优先、名字兼容**（`src/index.ts:1623`）。
 * 编号是存档里的稳定身份：把「提示词优化」改名叫「提示词润色」之后，
 * 按名字调就断了，按编号调照旧能用。名字只作为**显示**与兜底。
 *
 * ## 三个字段名必须与存档的开始 / 结束节点逐字一致
 *
 * 宿主半只认**开始节点声明过的**输入键，多给的会被丢掉（`io-fields.ts:189`），
 * 少给的等于空着跑。所以这三个名字写错不会有任何报错，只会「模型看起来在瞎写」——
 * 这类错最难查，所以要写在这里并配一条断言钉住。
 */
const OPTIMIZE_WORKFLOW_ID = 'wf-1bzlv0k'
const OPTIMIZE_WORKFLOW = '提示词优化'
/** 开始节点的两个输入（**两个都必填**）。 */
const OPT_IN_BODY = '模板正文'
const OPT_IN_TEXT = '待优化的提示词'
/** 交出文字的那个节点的类型（**改写的正文在这一步的输出上**）。 */
const OPT_AGENT_DEF = 'ai.agent'

/** 左栏一行的高度预算（只是观感，不参与逻辑）。 */
const LIST_H = 'max-h-[220px]'

/** 输入框（内凹）。 */const INPUT = [
  'min-w-0 w-full rounded-ctl border border-[var(--dsw-alias-border-l2)]',
  'bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1.5 text-ewb-meta',
  'text-[var(--dsw-alias-label-primary)] outline-none',
].join(' ')

/** 主按钮。 */
const BTN = [
  'pressable is-dark shrink-0 whitespace-nowrap rounded-ctl border px-2.5 py-1',
  'border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)] text-[var(--ewb-accent)]',
  'font-mono text-ewb-caption leading-none disabled:opacity-45',
].join(' ')

/** 次要按钮。 */
const BTN_QUIET = [
  'pressable is-dark shrink-0 whitespace-nowrap rounded-ctl border border-[var(--dsw-alias-border-l2)]',
  'px-2.5 py-1 font-mono text-ewb-caption leading-none text-[var(--dsw-alias-label-tertiary)] disabled:opacity-45',
].join(' ')

/** 插入不可用的原因（一句话，界面与悬浮提示共用，别让它漂）。 */
const INSERT_WHY = '插入动作在本环境不可用：本板块挂在根作用域，取不到会话输入框的写入能力。请先复制，再手动粘贴。'

/**
 * 改写失败的原因分类（**三种分开说**，因为修法完全不同）。
 *
 * ## 为什么要分类，而不是把宿主半的话原样贴出来
 *
 * 宿主半回的是执行层的原话（例如「没有可用的模型：先在 dsh 的模型设置里选一个
 * provider 与模型」）。把那句直接贴出来，用户看到的是「一句技术说明」——
 * 三种失败（没配模型 / 等太久 / 模型没给东西）在中文化之后长得很像，
 * 而**该做的事完全不同**：去设置里选模型、把超时调大、换个说法重试。
 *
 * 所以这里按关键字归成三类，每类给「发生了什么 / 为什么 / 怎么办」三段。
 *
 * ⚠️ 判据是**关键字匹配**，不是错误码 —— 宿主半没有给错误码。
 * 匹配不到就落到 `other`，**不猜**成上面某一类（猜错会让人去改错的地方）。
 */
type FailKind = 'no-model' | 'timeout' | 'empty' | 'missing-flow' | 'no-output' | 'other'

/**
 * 把失败原因归成六类。
 *
 * @param msg - 失败原因（宿主半原话或这里补的）。
 * @returns 类别。
 */
function classifyFail(msg: string): FailKind {
  if (msg.includes('没有这份工作流')) return 'missing-flow'
  if (msg.includes('没有可用的模型')) return 'no-model'
  if (msg.includes('超时') || msg.includes('timedOut')) return 'timeout'
  if (msg.includes('空') || msg.includes('没有返回')) return 'empty'
  return 'other'
}

/**
 * 六类失败各自的三段式文案。
 *
 * 三段式 = **发生了什么** + **为什么** + **怎么办**（本项目统一要求）。
 *
 * ⚠️ **`empty` 与 `no-output` 必须分开**（2026-10-25 契约 AT）：前者是「模型真的
 * 返回了空内容」，后者是「界面在记录里找不到它写的那段字」。两者的下一步完全不同 ——
 * 一个改说法重试，一个查存档 / 节点还在不在。混成一句会让用户白试。
 */
const FAIL_TEXT: Record<FailKind, string> = {
  'no-model': '改写没有成功：dsh 里还没有选模型。这个动作要靠模型改写文字，'
    + '而当前没有可用的 provider 与模型，请求根本没发出去。'
    + '去 dsh 的模型设置里选一个 provider 与模型，再回来重试。',
  timeout: '改写没有成功：等模型等太久了，超时收口。模型这次可能卡住了，'
    + '也可能提示词太长让它在慢慢想。'
    + '稍等一会儿再试一次；反复超时就把待改写的文字缩短，或去工作流里把「超时上限」调大。',
  empty: '改写没有成功：模型返回了空内容。请求发出去了、也回来了，但里面没有文字 —— '
    + '常见原因是模型拒答，或者指令把它绕进了「没什么可改」的判断。'
    + '把待改写的文字说具体一点再试，或在模板正文里更明确地写出要改什么。',
  'missing-flow': '改写没有成功：还没建「' + OPTIMIZE_WORKFLOW + '」这份工作流。'
    + '界面这边只负责请宿主半跑它，它不存在就没法开始。'
    + '去「工作流 → 工作流管理」新建一份名为「' + OPTIMIZE_WORKFLOW + '」的工作流：'
    + '开始节点声明两个必填输入「' + OPT_IN_BODY + '」与「' + OPT_IN_TEXT + '」，'
    + '中间放一个「AI 生成」节点（提示词引用 {{' + OPT_IN_BODY + '}}、参考资料引用 {{' + OPT_IN_TEXT + '}}）。'
    + '建好回来重试。',
  'no-output': '改写没有成功：工作流跑完了，但界面没在记录里找到「AI 生成」写出的那段字。'
    + '这次不是模型的问题 —— 是「结果放在哪」对不上：这份工作流里可能没有「AI 生成」节点，'
    + '或者它的输出被改成了别的东西。'
    + '去「工作流 → 运行历史」看这一次的记录：里面每个节点都有结局，'
    + '找到「AI 生成」那一步看它到底交出了什么。',
  other: '改写没有成功：宿主半回了失败，但原因不属于已知的几类。'
    + '运行本身出错了，界面这边看不到更细的现场。'
    + '去「工作流 → 运行历史」看这一次的记录，那里的每一步都有日志；'
    + '也可以稍后重试一次。',
}

/**
 * 跑「提示词优化」的结果（判别式联合：`ok` 是字面量，`if` 之后读哪个字段就定下来了）。
 *
 * 单独起一个类型名是为了让 `check:client` 能真的收窄 —— 内联写在
 * `Promise<…>` 里时推断不到，会出现「属性不存在」的假报。
 */
type OptimizeRun =
  | { ok: true, text: string }
  | { ok: false, error: string, noOutput?: true }

/**
 * 跑「提示词优化」，把「AI 生成」那一步写出的文字取回来（2026-10-25 契约 AT）。
 *
 * ## 为什么不再从 `declaredOutputs` 取
 *
 * 2026-10-25 起存档里**不再有结束节点**，「改写结果」这个名字就没地方声明了 ——
 * 而 `declaredOutputs` 是**结束节点**的产物，没有结束时它恒为空对象
 * （`run.ts:2719` 那个 `{}`）。于是旧写法必然取到空、必然报「模型返回了空内容」，
 * 而模型其实回答成功了。这是本契约要修的断点。
 *
 * ## 路 A：从**节点事件流**里取
 *
 * `GET /workflow/run-stream` 的 `step` 事件里，`success` 那条**本来就带 `output`**
 * （引擎 `run.ts:267` 的事件类型、宿主半 `index.ts:1851` 原样转发）。所以这不是
 * 「加一条新通道」，是**接上已经在那里的一条**：
 *
 *   · 不需要改引擎、不需要改宿主半返回的结构（那正是选路 A 的前提）；
 *   · 也不改 `POST /workflow/run`（它还服务别的调用点）。
 *
 * ⚠️ 只认 `defId === 'ai.agent'` 的那个节点：这份存档里唯一干活的步骤就是它。
 * 认类型不认 id（`n2` 这类编号会随改存档漂）。
 *
 * ## 三种失败分得开
 *
 * | 情况 | 回什么 |
 * | --- | --- |
 * | 整次运行失败 / 中断 | `error`（调用方按原话归类） |
 * | 跑完了，但没找到 `ai.agent` 的 `success` 事件 | `noOutput: true` |
 * | 找到了，但内容是空串 | `noOutput: true`（与上面同一件事：都没拿到字） |
 *
 * ⚠️ 而**模型真的返回空内容**是**另一种**情况，由调用方在拿到空串时单独判 ——
 * 两者在界面上给的是两句不同的话（见 `FAIL_TEXT.empty` / `FAIL_TEXT['no-output']`）。
 *
 * @param inputs - 开始节点声明的两个键。
 * @returns 取到的文字，或失败原因。
 */
function runOptimizeStream(
  inputs: Record<string, unknown>,
): Promise<OptimizeRun> {
  return new Promise(resolve => {
    if (typeof EventSource === 'undefined') {
      resolve({ ok: false, error: '这个环境不支持实时推送（EventSource 不可用），改写要跑工作流、只能走推送这条路' })
      return
    }
    const qs = 'workflowId=' + encodeURIComponent(OPTIMIZE_WORKFLOW_ID)
      + '&name=' + encodeURIComponent(OPTIMIZE_WORKFLOW)
      + '&inputs=' + encodeURIComponent(JSON.stringify(inputs))
    const es = new EventSource('/api/ecom-workbench/workflow/run-stream?' + qs)
    /** 收到的「AI 生成」输出（可能没有 —— 那就走 noOutput）。 */
    let agentText: string | undefined
    let settled = false
    /** 收口（清连接 + 只 resolve 一次）。 */
    const finish = (v: OptimizeRun): void => {
      if (settled) return
      settled = true
      es.close()
      resolve(v)
    }
    es.addEventListener('step', (ev: MessageEvent) => {
      let e: unknown
      try { e = JSON.parse(String(ev.data)) } catch { return }
      if (e === null || typeof e !== 'object') return
      const o = e as { kind?: string, defId?: string, output?: unknown }
      if (o.kind !== 'success' || o.defId !== OPT_AGENT_DEF) return
      /* 输出是**一段纯文本**（`ai.agent` 的 `outputs` 声明就是 text）。
       * 万一上游把它包成了对象，退一步找第一个字符串 —— 与旧兜底同一个思路。 */
      const raw = o.output
      const s = typeof raw === 'string'
        ? raw
        : raw !== null && typeof raw === 'object'
          ? (Object.values(raw as Record<string, unknown>).find(v => typeof v === 'string') as string | undefined)
          : undefined
      /* ⚠️ **空串也算「找到了」**（2026-10-25 契约 AT）：模型真的返回空内容时，
       * 这里必须留下「那一步交出的是空」这个事实，由调用方判 `empty`。
       * 若这里把空串当「没找到」，用户会看到「界面找不到那段字」——
       * 而真实原因是模型没写东西，下一步完全不同（改说法重试 vs 查存档）。 */
      if (typeof s === 'string') agentText = s
    })
    es.addEventListener('done', (ev: MessageEvent) => {
      let d: unknown
      try { d = JSON.parse(String(ev.data)) } catch { d = undefined }
      const o = (d ?? {}) as { ok?: boolean, aborted?: boolean, error?: string }
      /* 先判运行本身成没成 —— 失败时**不许**拿半截输出冒充结果。 */
      if (o.ok !== true || o.aborted === true) {
        finish({ ok: false, error: o.error ?? (o.aborted === true ? '工作流里有节点失败并中断了' : '工作流没有跑成功') })
        return
      }
      if (agentText === undefined) {
        finish({ ok: false, noOutput: true, error: '工作流跑完了，但没找到「AI 生成」交出的那段字' })
        return
      }
      finish({ ok: true, text: agentText })
    })
    /* 连接断了（跑完宿主半会关连接，正常路径先到 `done`，所以这里只兜失败）。 */
    es.addEventListener('error', () => {
      finish({ ok: false, error: '实时推送断了，没收到跑完的信号 —— 改写可能还在跑，也可能中途断了。稍等再看运行历史确认' })
    })
  })
}

/**
 * 写剪贴板。
 * 优先 `navigator.clipboard`（要有 https / localhost 与用户手势）；
 * 没有就退回一个隐藏 textarea + `execCommand('copy')` —— 桌面端里后者一直可用。
 *
 * @param text - 要写的文本。
 * @returns 成功与否（失败由调用方显示提示，不抛）。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    const clip = navigator.clipboard
    if (clip !== undefined && typeof clip.writeText === 'function') {
      await clip.writeText(text)
      return true
    }
  } catch {
    /* 落到下面那条 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    /* 不能 display:none —— 那样选不中，copy 就是空。放到视口外。 */
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

/**
 * 把一段纯文本里的 `**粗体**` 渲染成真正的粗体，其余原样。
 *
 * ⚠️ **实现已抽到 `emphasis-render.tsx`**（2026-10-25 契约 BJ）。
 *
 * 抽走的理由：内容板块的**提示词库**也要渲染同一套粗体
 * （`prompt-sources/*.json` 里有 8 条正文带 140 处 `**`）。
 * 两处各写一份必漂 —— 改一处忘一处，用户会在其中一个板块里看到字面的两颗星。
 * 与 `placeDemo` 改调 `placeResult` 是同一个判断：**规则只留一份**。
 *
 * 那边文件头写清了匹配规则，以及「只作用于只读展示、绝不动复制」的边界，改之前先读它。
 */

/**
 * 预览该显示哪一段。
 *
 * ## 为什么要挑，而不是直接给末尾
 *
 * 第一版固定给**末尾 600 字**（理由是「整份太长会挤掉上面」）。但变量不一定在末尾：
 * 「分析式结构优化」的 `{{原始提示词}}` 在正文中部，于是用户填完值往下看预览，
 * **看不到自己填的那句** —— 那正是预览存在的意义。
 *
 * 现在：填了值就以**第一个填进去的值**为中心取前后一段（段首尾加省略标记）；
 * 一个都没填就仍给末尾（那时预览只是给人看结尾长什么样）。
 *
 * ## 为什么不做「整份都给」
 *
 * 预览框高度是固定的（滚动条内），整份给也行，但正文在上方已经完整显示过一次，
 * 再来一整份等于同一段连看两遍，反而找不到刚填的那处。
 *
 * @param text - 已填好的全文。
 * @param values - 变量名 → 用户填的值。
 * @returns 要显示的那一段。
 */
function previewWindow(text: string, values: Readonly<Record<string, string>>): string {
  /** 一段前后各留多少字。 */
  const SPAN = 300
  /* 找**第一个**填进去的值在全文里出现的位置 —— 它就是用户想确认的那处。 */
  let at = -1
  for (const v of Object.values(values)) {
    if (v === undefined || v.trim() === '') continue
    const i = text.indexOf(v)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) return text.slice(-600)
  const from = Math.max(0, at - SPAN)
  const to = Math.min(text.length, at + SPAN)
  return (from > 0 ? '…（前略）\n' : '') + text.slice(from, to) + (to < text.length ? '\n（后略）…' : '')
}

/**
 * 提示词板块。
 *
 * ⚠️ 返回类型**故意不写 `React.JSX.Element`**：本仓的 React 类型是
 * `types-react-shim.d.ts` 里那份最小声明，没有全局 `React` 命名空间，
 * 写了就会给 `check:client` 多加一条 TS2503（其它板块都有这条，是既有基线的一部分）。
 * 新文件不添新错，返回值让 tsc 自己推。
 *
 * @param _props - 骨架入参（这块不用它们：不跑工作流、不调接口）。
 * @returns 界面。
 */
export function PromptBoard(_props: BoardProps) {
  /** 当前选中的模板 id（默认第一个 —— 进来就能看到内容，不是空白右边）。 */
  const [activeId, setActiveId] = useState<string>(PROMPT_TEMPLATES[0]?.id ?? '')
  /** 变量值（只对当前模板有效；切模板清空）。 */
  const [values, setValues] = useState<Record<string, string>>({})
  /** 正文是不是在编辑态。 */
  const [editing, setEditing] = useState(false)
  /** 编辑中的正文草稿。 */
  const [draft, setDraft] = useState('')
  /** 一句话提示（复制结果等）。 */
  const [note, setNote] = useState('')

  /** ★ 待改写的提示词（用户自己写的那段；交给工作流的 `input`）。 */
  const [toFix, setToFix] = useState('')
  /** 改写进行中（按钮变字 + 禁用）。 */
  const [optimizing, setOptimizing] = useState(false)
  /** 改写结果（模型写的文字；`null` = 还没跑过或已清空）。 */
  const [optimized, setOptimized] = useState<string | null>(null)
  /** 改写的失败文案（三段式，已分类）。 */
  const [optErr, setOptErr] = useState('')

  const active = useMemo(
    () => PROMPT_TEMPLATES.find(t => t.id === activeId) ?? PROMPT_TEMPLATES[0],
    [activeId],
  )
  /** 编辑过就以草稿为准（只影响本次会话，不落盘 —— 模板是参照物，不是用户数据）。 */
  const body = editing || draft !== '' ? draft : (active?.body ?? '')
  /** 正文里认出来的变量。 */
  const vars = useMemo(() => findVars(body), [body])
  /** 填好之后的最终文本（复制用）。 */
  const finalText = useMemo(() => fillVars(body, values), [body, values])

  /** 切模板：换 id、清变量、退出编辑、清提示。 */
  const pick = useCallback((t: PromptTemplate): void => {
    setActiveId(t.id)
    setValues({})
    setEditing(false)
    setDraft(t.body)
    setNote('')
  }, [])

  /* 首次进来把草稿填成第一个模板的正文 —— 否则 `body` 走的是 `draft !== ''` 分支，
   * 而这时的 draft 还是空串，正文会空着（第一版的坑）。 */
  useEffect(() => {
    if (active !== undefined) setDraft(active.body)
    /* 只在挂载时跑一次：之后由 pick 负责。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onCopy = useCallback((): void => {
    void copyText(finalText).then(ok => {
      setNote(ok
        ? '已复制到剪贴板（' + finalText.length + ' 字）'
        : '复制失败：浏览器拒绝了剪贴板写入。可以手动全选正文后复制。')
    })
  }, [finalText])

  const filledCount = vars.filter(v => (values[v.name] ?? '').trim() !== '').length

  /**
   * 用当前模板改写：把「模板正文」当指令、把「待改写的提示词」当参考资料，
   * 交给 `提示词优化` 那份工作流，取回模型写的文字。
   *
   * ## 三个判断为什么不合并
   *
   * ① **待改写的提示词为空** → 没有东西可改，直接说，不发请求（省一次额度）；
   * ② **模板正文为空** → 没有指令，模型不知道按什么改，同样不发；
   * ③ **跑完拿到空文字** → 请求真的发了、也回来了，但模型没给东西 ——
   *    这与①②不是一回事（那是「没发」，这是「发了没用」），文案要分开。
   *
   * ⚠️ **传的是开始节点声明的两个键**（`模板正文` / `待优化的提示词`），
   * 不是拼一个好看的名字。宿主半只认声明过的字段，写错不报错、只会空着跑
   * （`workflow/io-fields.ts:189`）。两个键名写死在上面的常量里。
   */
  const onOptimize = useCallback((): void => {
    if (optimizing) return
    const instruction = finalText.trim()
    const material = toFix.trim()
    setOptErr('')
    setOptimized(null)
    if (material === '') {
      setOptErr('还没有可改写的提示词：上面那个框是空的，没有东西交给模型。'
        + '这份工作流的「待优化的提示词」是必填项，空着传过去只会让模型瞎写。'
        + '先把要改的那段提示词粘进「待优化的提示词」再点改写。')
      return
    }
    if (instruction === '') {
      setOptErr('当前模板没有正文：模板是空的，模型不知道按什么改写。'
        + '这份工作流的「模板正文」是必填项，正文为空等于没有指令。'
        + '先在左边换一个有正文的模板，或点「编辑」把正文补上。')
      return
    }
    setOptimizing(true)
    /* 走**推送那条路**取结果（契约 AT 的说明见 `runOptimizeStream`）。
     * 按编号 + 名字一起给（宿主半编号优先），输入只给两个约定键。 */
    void runOptimizeStream({ [OPT_IN_BODY]: instruction, [OPT_IN_TEXT]: material })
      .then(r => {
        setOptimizing(false)
        if (r.ok === false) {
          /* 「跑完了但没找到那段字」与「模型返回空」是两件事，文案分开。 */
          setOptErr(r.noOutput === true ? FAIL_TEXT['no-output'] : FAIL_TEXT[classifyFail(r.error)])
          return
        }
        const text = r.text.trim()
        if (text === '') {
          /* 第三种失败：跑了、也成功了，模型确实回来了，但内容是空的。 */
          setOptErr(FAIL_TEXT.empty)
          return
        }
        setOptimized(text)
      })
  }, [optimizing, finalText, toFix])

  /** 把结果写进正文的编辑态（**不自动保存** —— 模板是参照物，改不改由人决定）。 */
  const applyOptimized = useCallback((): void => {
    if (optimized === null) return
    setDraft(optimized)
    setEditing(true)
    setNote('已回填到正文（编辑态）—— 满意就直接复制，不需要就点「还原」回到模板原文')
  }, [optimized])

  /** 复制改写结果。 */
  const onCopyOptimized = useCallback((): void => {
    if (optimized === null) return
    void copyText(optimized).then(ok => {
      setNote(ok
        ? '已复制改写结果到剪贴板（' + optimized.length + ' 字）'
        : '复制失败：浏览器拒绝了剪贴板写入。可以手动全选结果后复制。')
    })
  }, [optimized])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* 顶部说明：这一步到哪、改写走什么路，一进来就说清。 */}
      <div className="flex flex-none items-start gap-2 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-3 py-2">
        <span className="dot ok" style={{ marginTop: 5 }} />
        <span className="min-w-0 flex-1 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-secondary)]">
          模板本身只是参照物；底部「按模板改写」把当前模板正文当指令、把待改写的那段当参考资料，
          交给工作流里的模型改写。改写会落进运行历史，每次调用都消耗模型额度。
        </span>
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        {/* ── 左：模板清单（按分类分组）────────────────────────── */}
        <div className="flex w-[210px] flex-none flex-col gap-2 overflow-y-auto rounded-card border border-[var(--dsw-alias-border-l2)] p-2">
          {PROMPT_CATEGORIES.map(c => {
            const list = templatesOf(c.id)
            if (list.length === 0) return null
            return (
              <div key={c.id} className="flex flex-col gap-1">
                <div className="px-1 font-mono text-ewb-caption uppercase tracking-[0.18em] text-[var(--dsw-alias-label-caption)]">
                  {c.label}
                </div>
                {list.map(t => {
                  const on = t.id === activeId
                  return (
                    <button
                      key={t.id}
                      type="button"
                      data-ewb-tpl={t.id}
                      title={t.desc}
                      aria-current={on ? 'true' : undefined}
                      className={[
                        'pressable is-dark flex w-full flex-col items-start gap-0.5 rounded-ctl border px-2 py-1.5 text-left',
                        on
                          ? 'border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)] text-[var(--ewb-accent)]'
                          : 'border-transparent text-[var(--dsw-alias-label-secondary)] hover:text-[var(--dsw-alias-label-primary)]',
                      ].join(' ')}
                      onClick={() => { pick(t) }}
                    >
                      <span className="w-full truncate text-ewb-meta font-semibold">{t.name}</span>
                      <span className="line-clamp-2 w-full font-mono text-ewb-caption leading-snug text-[var(--dsw-alias-label-tertiary)]">
                        {t.desc}
                      </span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>

        {/* ── 右：正文 + 变量 ─────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-none flex-wrap items-center gap-2">
            <Label rule>{active?.name ?? '模板'}</Label>
            <span className="flex-1" />
            <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
              {'变量 ' + filledCount + ' / ' + vars.length}
            </span>
            <button
              type="button"
              className={BTN_QUIET}
              onClick={() => {
                if (editing) {
                  /* 退出编辑：放弃改动，回到模板原文（模板是参照物）。 */
                  setDraft(active?.body ?? '')
                  setEditing(false)
                  setNote('已还原为模板原文')
                } else {
                  setEditing(true)
                }
              }}
            >{editing ? '还原' : '编辑'}</button>
            <button type="button" className={BTN} data-ewb-tpl-copy="" onClick={onCopy}>复制到剪贴板</button>
            <button
              type="button"
              className={BTN_QUIET}
              disabled
              data-ewb-tpl-insert="off"
              title={INSERT_WHY}
            >插入到输入框（不可用）</button>
          </div>

          {note !== '' && (
            <div className="flex-none rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]">
              {note}
            </div>
          )}

          {/* 正文：只读时用 pre 保留换行；编辑时换成 textarea。 */}
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-card border border-[var(--dsw-alias-border-l2)]">
            {editing
              ? (
                <textarea
                  data-ewb-tpl-body="edit"
                  className={INPUT + ' h-full min-h-0 flex-1 resize-none rounded-none border-0 font-mono leading-relaxed'}
                  value={draft}
                  onChange={e => { setDraft(e.target.value) }}
                />
              )
              : (
                <pre
                  data-ewb-tpl-body="read"
                  className="m-0 min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-primary)]"
                >{renderEmphasis(body)}</pre>
              )}
          </div>

          {/* 变量区：只认 {{名字}}。一个变量都没有时明说，不留一块空白。 */}
          <div className="flex flex-none flex-col gap-1.5">
            <Label rule>变量</Label>
            {vars.length === 0
              ? (
                <div className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                  这份模板没有变量占位符，正文可以直接用。
                </div>
              )
              : (
                <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                  {vars.map(v => {
                    /* ★ 有中文说法就显示中文，没有就显示原名（2026-10-23 契约 U）。
                     *
                     * 用户 m02240：「那些变量都是写的变量名称是英文，没有说明吗？」
                     * 所以三件事都要做到：
                     *   ① 显示名用中文标签；
                     *   ② `title` 放一句说明（填什么 + 从哪来）—— 悬停可见；
                     *   ③ **没配标签的显示原名**，不许显示成空白（空白比英文名更糟：
                     *      用户连「这里该填什么」都看不出来）。
                     *
                     * ⚠️ `data-ewb-tpl-var` 与 `values[v.name]` 的键**仍然是原名** ——
                     * 那是 `fillVars` 替换时认的东西，换成中文标签整条替换路就断了。 */
                    const meta = varLabel(v.name)
                    const shown = meta === undefined ? v.name : meta.label
                    return (
                      <label key={v.name} className="flex flex-col gap-1">
                        <span
                          className="flex items-center gap-1.5 text-ewb-caption text-[var(--dsw-alias-label-tertiary)]"
                          title={meta === undefined ? '这个变量还没有中文说明' : meta.hint}
                          data-ewb-tpl-var-label={v.name}
                        >
                          {shown}
                          {v.count > 1 && <Badge tone="default" ghost>×{v.count}</Badge>}
                        </span>
                        <input
                          type="text"
                          className={INPUT}
                          data-ewb-tpl-var={v.name}
                          /* 占位符也用中文：那串英文名在这里只是注释，不该占着输入框。 */
                          placeholder={meta === undefined ? '填入' + v.name : meta.hint}
                          value={values[v.name] ?? ''}
                          onChange={e => {
                            const text = e.target.value
                            setValues(prev => ({ ...prev, [v.name]: text }))
                          }}
                        />
                      </label>
                    )
                  })}
                </div>
              )}
          </div>

          {/* 填好之后的预览。
           *
           * ⚠️ 这一块**不是固定给末尾**：填了值就以「第一个填进去的值」为中心取一段
           * （见 `previewWindow`）。第一版固定给末尾 600 字，而变量不一定在末尾
           * （「分析式结构优化」的变量在正文中部）→ 用户看不到自己填的那句，
           * 预览就白做了。
           *
           * ⚠️ 这块**也走 `renderEmphasis`**：预览是给人看的最终样子，
           * 里面再露出两颗星就白做了。 */}
          {vars.length > 0 && (
            <div className="flex flex-none flex-col gap-1">
              <Label rule>填好之后（预览）</Label>
              <pre
                data-ewb-tpl-preview=""
                className={LIST_H + ' m-0 overflow-auto whitespace-pre-wrap break-words rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-secondary)]'}
              >{renderEmphasis(previewWindow(finalText, values))}</pre>
            </div>
          )}

          {/* ── 按模板改写（2026-10-23 加）──────────────────────────
           *
           * 这一块回答的是「把现成的一段话按模板改写」—— 与上面「填变量」不是一回事：
           * 填变量是**填空**（把模板里的占位符换掉），改写是**加工**（让模型重写）。
           *
           * ⚠️ 结果**不自动写回正文**：模板是参照物，写回去要人点一下
           * （`applyOptimized` 只进编辑态，不保存）。自动写回的话，切个模板
           * 再回来就分不清「这是原文还是模型改的」。 */}
          <div className="flex flex-none flex-col gap-1.5 border-t border-[var(--dsw-alias-border-l2)] pt-2" data-ewb-opt="">
            <div className="flex flex-wrap items-center gap-2">
              <Label rule>按模板改写</Label>
              <span className="flex-1" />
              <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                走工作流「{OPTIMIZE_WORKFLOW}」（编号 {OPTIMIZE_WORKFLOW_ID}）
              </span>
            </div>

            <label className="flex flex-col gap-1">
              <span className="font-mono text-ewb-caption uppercase tracking-[0.12em] text-[var(--dsw-alias-label-tertiary)]">
                {OPT_IN_TEXT}
              </span>
              <textarea
                data-ewb-opt-input=""
                className={INPUT + ' h-[88px] resize-none font-mono leading-relaxed'}
                placeholder="把现成的那段提示词粘进来，点下面的改写"
                value={toFix}
                onChange={e => { setToFix(e.target.value) }}
              />
            </label>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={BTN}
                data-ewb-opt-run=""
                disabled={optimizing}
                title={'把当前模板正文当指令、上面那段当参考资料，交给工作流「' + OPTIMIZE_WORKFLOW + '」改写（会消耗模型额度）'}
                onClick={onOptimize}
              >{optimizing ? '改写中…' : '用当前模板改写'}</button>
              {/* ★ 进行中必须有一句说明 —— 只把按钮改字、下面空白干等，用户以为卡死了。
               * 这句话要写清「在等什么」，不是「请稍候」。 */}
              {optimizing && (
                <span
                  data-ewb-opt-progress=""
                  className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]"
                >
                  已交给模型，正在等它写回来（可能要十几秒）—— 这期间界面不会动，是正常的
                </span>
              )}
            </div>

            {/* 失败：三段式，整块显示（不折成一行 —— 要读得下去）。 */}
            {optErr !== '' && (
              <div
                data-ewb-opt-error=""
                className="rounded-ctl border border-[color-mix(in_oklab,var(--dsw-alias-state-error-primary)_35%,transparent)] px-2 py-1.5 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-state-error-primary)]"
              >{optErr}</div>
            )}

            {/* 结果区：模型写的文字 + 复制 / 回填。 */}
            {optimized !== null && !optimizing && (
              <div className="flex flex-col gap-1" data-ewb-opt-result="">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-ewb-caption uppercase tracking-[0.12em] text-[var(--dsw-alias-label-tertiary)]">
                    改写结果
                  </span>
                  <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
                    {optimized.length} 字
                  </span>
                  <span className="flex-1" />
                  <button type="button" className={BTN} data-ewb-opt-copy="" onClick={onCopyOptimized}>复制</button>
                  <button type="button" className={BTN_QUIET} data-ewb-opt-apply="" onClick={applyOptimized}>回填到正文</button>
                </div>
                {/* ⚠️ 用 `pre` 保留模型给的换行与缩进 —— 提示词的结构就是它的一部分。 */}
                <pre
                  data-ewb-opt-text=""
                  className={LIST_H + ' m-0 overflow-auto whitespace-pre-wrap break-words rounded-ctl border border-[var(--dsw-alias-border-l2)] px-2 py-1 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-primary)]'}
                >{optimized}</pre>
                <span className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
                  「回填到正文」只是把它放进编辑态，不会自动保存 —— 满意就直接复制，不需要就点「还原」。
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
