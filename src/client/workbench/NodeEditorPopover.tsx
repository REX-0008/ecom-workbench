/** 节点属性表单（浮卡与节点内展开共用）。
 *
 * 设计依据：docs/机制-设计依据.md §2；原始调研 docs/调研-节点说明写法与UX规范.md、docs/调研-工作流节点规范.md。
 *   - **参数说明常显在输入框下方**（n8n 的 parameter hint），不藏在悬停里 —— 用户明确要求
 *   - **节点详细说明**照 Node-RED 五段式（做什么 / 输入输出 / 何时用 / 注意）
 *   - **按 kind 给正确控件**（能穷举用下拉、是否用开关、能数用数字、代码用多行）
 *   - **高级参数折叠**（advanced），避免一屏全是参数
 *   - **选项可带说明**（options[].description：讲「选了会怎样」）
 *   - **节点级提示分级**（hints：info / warning / danger）
 *
 * 注意：渲染**优先用 `paramDefs`**（有完整定义），没有时才回退到「按值的类型猜控件」。
 */
import { useState, type CSSProperties } from 'react'
import css_node_form from './node-form.module.css'
import { type HintLevel, type NodeDef, type NodeState, type OnError, type ParamDef, type PortType } from '../../workflow/model.ts'
import { decodeModelPick, encodeModelPick } from '../../workflow/model.ts'
import { useModels } from './WorkspaceSettings.tsx'
import { IF_OPERATORS, operatorIsUnary, type IfCondition, type IfOperand } from '../../workflow/branch.ts'
import { toneClass } from './node-style.ts'
import { NodeBrowserSection, type KnownBrowser } from './NodeBrowserSection.tsx'
import type { DetectResult } from './browser-detect-store.ts'
import type { BrowserPrefs } from './browser-settings.ts'

/** 失败三态的显示名与说明（D4）。 */
const ON_ERROR_OPTIONS: readonly { value: OnError, label: string, desc: string, cls: string }[] = [
  { value: 'stop', label: '停止流程', desc: '这个节点失败就整体停下，等人工处理', cls: css_node_form.errOn },
  { value: 'continue', label: '继续跑', desc: '失败也往下走，下游拿到空值', cls: css_node_form.warnOn },
  { value: 'continueErrorOutput', label: '走失败分支', desc: '失败结果从「失败」出口走，不污染正常下游', cls: css_node_form.segOn },
]

/** 依赖项的中文名（缺件的会标黄）。 */
const DEP_KIND: readonly { key: 'npm' | 'bin' | 'env' | 'files', name: string }[] = [
  { key: 'npm', name: 'NPM 包' },
  { key: 'bin', name: '外部程序' },
  { key: 'env', name: '环境变量' },
  { key: 'files', name: '随附文件' },
]

/** 出端口类型的中文名（详细说明里用）。 */
const PORT_TYPE_NAME: Record<PortType, string> = {
  data: '数据', text: '文本', image: '图片', number: '数字', any: '任意',
}

/**
 * 「选节点 + 选字段」的一个候选（配合 `kind: 'nodeField'`）。
 *
 * 照 Dify 的 `ValueSelector`：它让用户**先选节点、再选字段**。
 * 这里把两者摊平成清单，用户不必记 id。
 */
export interface FieldCandidate {
  /** 节点 id（存进参数的就是它）。 */
  id: string
  /** 显示名（实例名优先，退回类型名）。 */
  name: string
  /** 该节点的输出字段（`[]` = 整体输出，界面上用「整个输出」表示）。 */
  fields: readonly { id: string, label: string }[]
}

/**
 * 「条件表」参数（`kind: 'ifRules'`）的候选来源。
 *
 * 三组来源，对应结构化条件里「左边取哪个值」的三种可能：
 *   · `fields` —— 能选到的节点字段；
 *   · `loopVars` —— 循环变量名（`item` / `index`；嵌套时还有 `outer.item`）；
 *   · `inputs` —— 「开始」节点声明的输入项名字。
 *
 * ⚠️ **为什么由调用方传、不在控件里自己算**：节点定义是纯数据、拿不到图，
 * 而「能选哪些节点」「这个节点在不在循环里」只有画布知道。
 *
 * ⚠️ **为什么单独导出这个类型**（2026-10-19）：循环的「跳出条件」
 * （`breakConditions`，`LoopNode.tsx` 里渲染）用的是**同一个控件**，
 * 它需要照着这个形状组一份来源。原先这个形状在文件里内联写了 4 遍 ——
 * 循环那边再抄第 5 遍就会漂（少一个字段，编译能过、运行期那个分组是空的）。
 */
export interface IfRulesSources {
  /** 「选节点 + 选字段」的候选。 */
  fields: readonly FieldCandidate[]
  /** 可用的循环变量名（不在循环里时是空数组）。 */
  loopVars: readonly string[]
  /** 「开始」节点声明的输入项名字。 */
  inputs: readonly string[]
}

/**
 * 「选一份工作流」的一个候选（配合 `kind: 'workflowRef'`，2026-10-19 新增）。
 *
 * 与 `FieldCandidate` 的区别：那个选的是**本图里的节点**，这个选的是
 * **本机另一份存档**。两者都不是自由文本 —— 理由相同：打错字要到运行时才发现。
 *
 * ⚠️ `id` 是存档里的**稳定编号**（`doc.id`），不是名字。名字只用来显示。
 */
export interface WorkflowCandidate {
  /** 稳定编号（存进参数的就是它）。 */
  id: string
  /** 显示名（= 文件名）。 */
  name: string
}

/** 表单体入参（节点内展开用；浮卡那一档已删除，见下）。 */
export interface NodeEditorBodyProps {
  /** 节点类型定义。 */
  def: NodeDef
  /** 当前状态。 */
  state: NodeState
  /** 进度文字。 */
  progress?: string
  /** 本次实例的参数。 */
  params: Record<string, unknown>
  /** 本次实例的失败策略。 */
  onError: OnError
  /** 改一个参数。 */
  onParam: (key: string, value: unknown) => void
  /** 改失败策略。 */
  onOnError: (v: OnError) => void
  /**
   * 本节点能引用到的变量名（上游输出的字段 + 环境变量 + 全局变量）。
   *
   * 为什么要传它：光实现 `{{}}` 替换还不够——用户得**知道有哪些名字可写**，
   * 否则仍然是猜。这里把清单摊开，点一下就能插进参数里。
   */
  availableVars?: readonly string[]
  /**
   * 「选节点 + 选字段」参数的候选清单（2026-10-13 新增，配合 `kind: 'nodeField'`）。
   *
   * 为什么要有它：循环节点上的端口已删（照 Dify —— 它的迭代节点零 Handle），
   * 输入改由 `items: { nodeId, field }` 指定。用户得**从清单里挑**，
   * 而不是记住节点 id —— 与 `availableVars` 同一个道理
   * （「光实现替换还不够，用户得知道有哪些名字可选」）。
   *
   * 每一项：节点 id + 显示名 + 它的输出字段清单。
   */
  fieldCandidates?: readonly FieldCandidate[]
  /**
   * 「选一份工作流」参数的候选清单（2026-10-19 新增，配合 `kind: 'workflowRef'`）。
   *
   * 来源是**本机已保存的工作流清单**（宿主半给的：名字 + 编号）。
   * 为什么由画布传而不在这里自己取：节点定义是纯数据、不能发请求；
   * 而清单只有画布拿得到（它已经在读存档列表了）。
   */
  workflowCandidates?: readonly WorkflowCandidate[]
  /**
   * 「条件表」参数（`kind: 'ifRules'`）的候选来源（2026-10-19 新增）。
   *
   * 三组来源，对应结构化条件里「左边取哪个值」的三种可能：
   *   · `fields` —— 图里能选到的节点字段（与 `fieldCandidates` 是**同一份**内容，
   *     只是这里只留「在它上游」的那些）；
   *   · `loopVars` —— 循环变量名（`item` / `index`；嵌套时还有 `outer.item`）；
   *   · `inputs` —— 「开始」节点声明的输入项名字。
   *
   * ⚠️ **为什么由画布传、不在控件里自己算**：节点定义是纯数据、拿不到图，
   * 而「上游有哪些节点」「这个节点在不在循环里」只有画布知道。
   * 这跟 `fieldCandidates` / `workflowCandidates` 是同一个路子。
   */
  ifSources?: IfRulesSources
  /**
   * 本实例的显示名（覆盖类型名）—— 照 n8n 的 Rename node。
   *
   * 用户 2026-10-12：「llm 写的，写的时候我知道什么意思，看的时候我不知道……
   * 当前的说明部分只是说这个节点的功能，而不是实现了什么。」
   */
  label?: string
  /** 本实例的备注（讲「我在这里为什么用它」）。 */
  note?: string
  /** 改实例名。 */
  onLabel?: (v: string) => void
  /** 改备注。 */
  onNote?: (v: string) => void
  /**
   * 浏览器一节（用户 2026-10-13：「标签→浏览器应该是在**节点设置**而不是设置中设置」）。
   *
   * 只有**管会话的节点**才传它（浏览器节点有 `session` 参数）——
   * 其他节点传 undefined，那一节就不出现。
   *
   * ⚠️ 第二层（用哪个 / 怎么开）改的是**标签的设置**，不是这个节点的，
   * 所以 `onPrefs` 走的是全局偏好那一路（见 `NodeBrowserSection` 的说明）。
   */
  browser?: {
    /** 当前标签名（= 节点的 `session` 参数）。 */
    tag: string
    /** 改标签名。 */
    onTag: (t: string) => void
    /** 全局偏好（含各标签的第二层配置）。 */
    prefs: BrowserPrefs
    /** 改偏好。 */
    onPrefs: (p: BrowserPrefs) => void
    /** 检测到的浏览器清单。 */
    browsers: readonly KnownBrowser[]
    /**
     * 宿主半的检测结果（含**扫到的 CDP 端点**）。
     *
     * ⚠️ 2026-10-14 加（用户 #7）：端口改成手填之后，界面上要能**列出扫到的端口**
     * 让用户一条点击就填上，而不是自己抄。
     */
    detect?: DetectResult | null
    /** 画布上其他标签（下拉里给它们，方便复用）。 */
    otherTags: readonly string[]
  }
  /**
   * 依赖判定结果（票 22，2026-10-27）。
   *
   * ## 为什么不再只看 `state === 'missing'`
   *
   * 原来那一块（`missingDeps`）靠「节点状态是 missing」来显示，
   * 可那时候没有任何东西会把状态置成 missing —— 所以那一块从来没显示过。
   * 现在后端会判（`GET /nodes/deps`），画布把缺的节点标成 `missing`，
   * 同时把「缺什么、怎么装」那句话带进来。
   *
   * 只有 `missing` 时才有意义；其它状态传 `undefined`。
   */
  depsGap?: {
    /** 缺的每一条。 */
    gaps: readonly { kind: string, name: string }[]
    /** 后端攒好的那句话（缺什么 + 各组怎么装）。 */
    reason: string
  }
}

/** 参数值 → 传给控件的字符串。 */
function asText(v: unknown): string {
  if (v === undefined || v === null) return ''
  return typeof v === 'string' ? v : JSON.stringify(v)
}

/** 多行文本 → 字符串数组（去掉空行与两端空白）。 */
function splitLines(text: string): string[] {
  return text.split('\n').map(s => s.trim()).filter(s => s !== '')
}

/** 键值对 → 多行文本（每行「键=值」）。 */
function kvToText(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'string') return v
  if (typeof v !== 'object' || Array.isArray(v)) return ''
  return Object.entries(v as Record<string, unknown>).map(([k, val]) => k + '=' + String(val)).join('\n')
}

/** 多行文本 → 键值对（第一个等号左边是键，右边是值，值里的等号保留）。 */
function textToKv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    const at = line.indexOf('=')
    if (at < 0) { out[line] = ''; continue }
    out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

/**
 * 「选节点 + 选字段」控件（`kind: 'nodeField'`）。
 *
 * ## 为什么是「两个下拉」而不是一个长列表
 *
 * 照 Dify 的 `ValueSelector`：它让用户**先选节点、再选字段**。
 * 合成一个列表的话，节点一多就有几十项（每个节点的每个字段各一行），
 * 而且「同一个节点的几个字段」会散开，反而更难找。
 *
 * ## 空清单要说清原因
 *
 * 候选来自「上游节点 + 容器内节点」。一个都没有时（比如循环是整张图的第一个节点），
 * 下拉是空的 —— 那时必须**明确说「还没有可选的数据来源」**，
 * 否则用户会以为控件坏了（照本项目一贯的「不静默失败」）。
 *
 * @param props.def - 参数定义。
 * @param props.value - 当前值（`{ nodeId, field }`）。
 * @param props.onChange - 改值回调。
 * @param props.candidates - 候选清单。
 * @returns 两个下拉。
 */
function NodeFieldControl(props: {
  def: ParamDef
  value: unknown
  onChange: (v: unknown) => void
  candidates: readonly FieldCandidate[]
}) {
  const { candidates, onChange } = props
  /* 读当前值（形状不对就当没选）。 */
  const cur = (props.value !== null && typeof props.value === 'object')
    ? props.value as { nodeId?: unknown, field?: unknown }
    : {}
  const curNode = typeof cur.nodeId === 'string' ? cur.nodeId : ''
  const curField = typeof cur.field === 'string' ? cur.field : ''

  if (candidates.length === 0) {
    return (
      <div className={css_node_form.paramHint} data-ewb-field-empty>
        还没有可选的数据来源：先在它前面放一个产出数据的节点（连到它这一路上）。
      </div>
    )
  }

  const node = candidates.find(c => c.id === curNode)
  /* 节点换了 → 字段清空（旧字段不属于新节点，留着会让执行时取不到值）。 */
  const setNode = (id: string): void => { onChange({ nodeId: id, field: '' }) }
  const setField = (f: string): void => { onChange({ nodeId: curNode, field: f }) }

  return (
    <div className={css_node_form.ctlRow} data-ewb-nodefield>
      <select className={css_node_form.select} value={curNode} onChange={e => { setNode(e.target.value) }} title="选哪个节点">
        <option value="">（选节点）</option>
        {candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <select className={css_node_form.select} value={curField} onChange={e => { setField(e.target.value) }} disabled={node === undefined} title="选它的哪个输出">
        {/* 空串 = 整体输出（节点只有一个输出时用户不必再选一次）。 */}
        <option value="">整个输出</option>
        {(node?.fields ?? []).map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
      </select>
    </div>
  )
}

/**
 * 「选另一份工作流」控件（`kind: 'workflowRef'`，2026-10-19 新增）。
 *
 * ## 为什么是一个下拉，而不是让人手填名字
 *
 * 用户原话：「引用不要用名称匹配……引用用的应该是编号而不是名称。」
 *
 * 手填名字有两个毛病：① 打错一个字运行时才报；② 子工作流改名之后引用就断了
 * （`取数-抖音电商罗盘` 那份已经踩过）。所以改成**从清单里选**：
 * 存的是那份工作流的**编号**，界面上显示它的名字。
 *
 * ## 三种状态都要说清（照本项目「不静默」的规矩）
 *
 *   ① 正常：下拉里列出全部工作流，选中项显示名字；
 *   ② **还没选**（值是空）：提示「先选一份」，不是空白控件；
 *   ③ **选过但找不到**（编号不在清单里，比如那份被删了 / 存档来自别的机器）：
 *      明确说「原来指的是 X，它已经找不到了」，并保留原值让人看见它指过谁 ——
 *      直接清空会让人以为「我没选过」。
 *
 * @param props.value - 当前值（`{ workflowId, name? }`；老存档可能是裸字符串名字）。
 * @param props.onChange - 改值回调（存进去的一定是 `{ workflowId }`）。
 * @param props.candidates - 可选的工作流清单（名字 + 编号）。
 * @returns 一个下拉（或一句说明）。
 */
function WorkflowRefControl(props: {
  value: unknown
  onChange: (v: unknown) => void
  candidates: readonly WorkflowCandidate[]
}) {
  const { candidates, onChange } = props
  /* 读当前值。两种形状都认：
   *   · 新写法 `{ workflowId, name }`
   *   · 老写法裸字符串（`params.name` 时期留下的，迁移会处理，但界面别崩） */
  const cur = (props.value !== null && typeof props.value === 'object')
    ? props.value as { workflowId?: unknown, name?: unknown, id?: unknown }
    : {}
  const curId = typeof cur.workflowId === 'string' ? cur.workflowId
    : typeof cur.id === 'string' ? cur.id
      : typeof props.value === 'string' ? '' : ''
  const curName = typeof cur.name === 'string' ? cur.name : ''

  const known = candidates.some(c => c.id === curId)

  if (candidates.length === 0) {
    return (
      <div className={css_node_form.paramHint} data-ewb-wf-ref-empty>
        本机还没有别的工作流可选：先在「工作流管理」里存一份，这里就能选到了。
      </div>
    )
  }

  return (
    <div data-ewb-wf-ref>
      <select
        className={css_node_form.select}
        value={known ? curId : ''}
        onChange={e => {
          const picked = candidates.find(c => c.id === e.target.value)
          /* 存编号；名字只当显示缓存（编号找不到时还能告诉用户它指过谁）。 */
          onChange(picked === undefined
            ? { workflowId: '' }
            : { workflowId: picked.id, name: picked.name })
        }}
        title="选一份本机已保存的工作流（存的是它的编号，改名不影响）"
      >
        <option value="">（选一份）</option>
        {candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      {curId !== '' && !known && (
        <div className={css_node_form.paramHint}>
          {'选过的那一份现在找不到了（原来指的是「' + (curName !== '' ? curName : curId)
            + '」）—— 它可能被删了，或者这份存档来自另一台机器。请重新选一份。'}
        </div>
      )}
    </div>
  )
}

/**
 * 结构化条件控件（`kind: 'ifRules'`，2026-10-19 新增）。
 *
 * ## 为什么要有它
 *
 * 用户原话：「照 Dify 做成『选变量 + 比较符 + 值』的结构化条件」。
 * 原来「条件判断」节点的参数是一个文本框，要用户写 `input.curfewTop !== true`
 * —— 那是代码：看不懂的人没法用、打错一个字要到运行时才报、也选不到循环变量。
 *
 * ## 一行长什么样（照 Dify 的 if-else）
 *
 *   ① 左边选一个值（下拉，分三组：上游节点 / 循环变量 / 开始节点的输入）
 *   ② 选怎么比（`IF_OPERATORS`，18 个，中文名）
 *   ③ 填要比较的值（单目比较符如「为空」不需要，那一格会收起来）
 *   ④ 右边还有一个「按什么类型比」（文本 / 数字 / 真假）—— 这是 Dify 的 `varType`
 *
 * ## 为什么左边是**一个**下拉而不是「先选节点再选字段」
 *
 * 循环那边用了两个下拉（照 Dify 的 `ValueSelector`），因为它的候选只有「节点 + 字段」。
 * 这里多了两种来源（循环变量、输入），若再拆成两个下拉，用户要先想「这是哪个空间的值」。
 * 一个带分组的下拉能直接扫，选完就是完整的一项 —— 少一次点击。
 *
 * ## 候选为空时要说清原因（本项目一贯的「不静默」）
 *
 * 节点还没有上游时左栏是空的。那时给一句「先在它前面放一个产出数据的节点」，
 * 而不是一个点不开的空下拉。
 *
 * @param props.value - 当前值（条件数组）。
 * @param props.onChange - 改值回调。
 * @param props.sources - 可选来源（节点字段 / 循环变量 / 输入字段）。
 * @param props.emptyHint - 一个可选来源都没有时的说明（不传用 IF 节点的默认说法）。
 * @param props.noneHint - 一条条件都没填时的说明（不传用默认说法）。
 * @returns 条件表编辑器。
 */
export function IfRulesControl(props: {
  value: unknown
  onChange: (v: unknown) => void
  sources?: IfRulesSources
  emptyHint?: string
  noneHint?: string
}) {
  const sources = props.sources ?? { fields: [], loopVars: [], inputs: [] }
  const rows: IfCondition[] = Array.isArray(props.value)
    ? props.value.filter((x): x is IfCondition => x !== null && typeof x === 'object' && !Array.isArray(x))
    : []
  /** 一个可选来源都没有（新节点还没接上下游、也不在循环里）。 */
  const noSources = sources.fields.length === 0 && sources.loopVars.length === 0 && sources.inputs.length === 0

  /** 改某一行（其余行原样）。 */
  const patch = (i: number, next: IfCondition): void => {
    const out = rows.map((r, j) => (j === i ? next : r))
    props.onChange(out)
  }
  /** 删某一行。 */
  const remove = (i: number): void => { props.onChange(rows.filter((_, j) => j !== i)) }
  /**
   * 加一行（默认「不为空」—— 常见的起点是「有没有值」）。
   *
   * ⚠️ **一个可选来源都没有时也要能加**（2026-10-19 改）。
   * 第一版在这种情况下整块换成一句提示、不给按钮 —— 于是用户刚加进来的
   * 「条件判断」节点根本没法开始填（得先回去接上游再回来）。
   * 现在提示照给、按钮照留：行的左边先空着（下拉里只有「（选一个值）」），
   * 接上下游之后那个下拉自然就有内容了。跑的时候没选值的行会被读条件的
   * 那一层丢掉并报数（见 `if-condition.ts` 的 `readIfConditions`），不会静默当成成立。
   */
  const add = (): void => { props.onChange([...rows, { op: 'notEmpty' }]) }

  /** 左边编码成下拉的一个选项值。 */
  const enc = (o: IfOperand | undefined): string => {
    if (o === undefined) return ''
    if (o.kind === 'field') return 'f:' + o.nodeId + ':' + o.field
    if (o.kind === 'loop') return 'l:' + o.name
    return 'i:' + o.name
  }
  /** 下拉选项值 → 左边定义。 */
  const dec = (v: string): IfOperand | undefined => {
    if (v.startsWith('f:')) {
      const rest = v.slice(2)
      const at = rest.indexOf(':')
      if (at < 0) return { kind: 'field', nodeId: rest, field: '' }
      return { kind: 'field', nodeId: rest.slice(0, at), field: rest.slice(at + 1) }
    }
    if (v.startsWith('l:')) return { kind: 'loop', name: v.slice(2) }
    if (v.startsWith('i:')) return { kind: 'input', name: v.slice(2) }
    return undefined
  }

  return (
    <div data-ewb-if-rules>
      {noSources && (
        <div className={css_node_form.paramHint} data-ewb-if-empty>
          {props.emptyHint ?? '还没有可选的值：先在它前面接一个产出数据的节点，或者把它放进循环里（那样能选 item）。'}
        </div>
      )}
      {rows.length === 0 && (
        <div className={css_node_form.paramHint} data-ewb-if-none>
          {props.noneHint ?? '还没填条件。点下面的「添加一条」——一条都不填时这个节点会直接报错（不会静默当成成立）。'}
        </div>
      )}
      {rows.map((r, i) => {
        const unary = operatorIsUnary(r.op ?? 'notEmpty')
        return (
          <div className={css_node_form.ifRow} key={i} data-ewb-if-row>
            <select
              className={css_node_form.select}
              value={enc(r.left)}
              title="左边取哪个值"
              onChange={e => { patch(i, { ...r, left: dec(e.target.value) }) }}
            >
              <option value="">（选一个值）</option>
              {sources.fields.length > 0 && (
                <optgroup label="上游节点">
                  {sources.fields.flatMap(c => c.fields.map(f => (
                    <option key={c.id + ':' + f.id} value={'f:' + c.id + ':' + f.id}>
                      {c.name} › {f.label}
                    </option>
                  )))}
                  {/* 「整个输出」单独一项（字段下拉在循环那边有它，这里也要有，
                   * 否则「判断上游整体是不是空」没法表达）。 */}
                  {sources.fields.map(c => (
                    <option key={'whole:' + c.id} value={'f:' + c.id + ':'}>{c.name} › 整个输出</option>
                  ))}
                </optgroup>
              )}
              {sources.loopVars.length > 0 && (
                <optgroup label="循环变量（本轮）">
                  {sources.loopVars.map(n => <option key={'l' + n} value={'l:' + n}>{n}</option>)}
                </optgroup>
              )}
              {sources.inputs.length > 0 && (
                <optgroup label="开始节点的输入">
                  {sources.inputs.map(n => <option key={'i' + n} value={'i:' + n}>{n}</option>)}
                </optgroup>
              )}
            </select>
            <select
              className={css_node_form.select}
              value={r.op ?? 'notEmpty'}
              title="怎么比"
              onChange={e => { patch(i, { ...r, op: e.target.value }) }}
            >
              {IF_OPERATORS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            {!unary && (
              <>
                <input
                  className={css_node_form.input}
                  type="text"
                  value={r.value ?? ''}
                  placeholder="比什么"
                  title="比什么"
                  onChange={e => { patch(i, { ...r, value: e.target.value }) }}
                />
                <select
                  className={css_node_form.select + ' ' + css_node_form.ifType}
                  value={r.valueType ?? 'text'}
                  title="右边按什么类型比"
                  onChange={e => { patch(i, { ...r, valueType: e.target.value as IfCondition['valueType'] }) }}
                >
                  <option value="text">文本</option>
                  <option value="number">数字</option>
                  <option value="boolean">真假</option>
                </select>
              </>
            )}
            <button
              type="button"
              className={css_node_form.ifDel}
              title="删掉这一条"
              onClick={() => { remove(i) }}
            >×</button>
          </div>
        )
      })}
      <button type="button" className={css_node_form.advToggle} onClick={add} data-ewb-if-add>
        ＋ 添加一条
      </button>
      <div className={css_node_form.paramHint}>
        {'「真假」那格填 true / false；「是其中之一」那格用逗号隔开多个值。'
          + '条件判断不改数据 —— 上游给什么，下游就拿到什么。'}
      </div>
    </div>
  )
}

/**
 * 「选一个模型」控件（`kind: 'model'`，2026-10-23 加）。
 *
 * ## 选项从哪来：备选名单，不是 dsh 的全部模型
 *
 * 用户原话「不是所有的 dsh 模型都读入工作台」。所以下拉的内容是
 * `/models` 回的 `picks`（工作台设置里挑进名单的那几个），**不是** `providers`。
 *
 * ## 三项硬要求
 *
 * ① **第一项固定是「跟随默认」**，值空串，且是**默认选中**（存档里没值就是它）。
 *    空串 = 走回落链（工作台默认 → dsh 当前 → 备选第一个 → 第一个可用）。
 * ② **存档里已选、但不在名单里的那个也要出现**。否则老存档一打开，
 *    下拉显示成「跟随默认」，用户一保存就把原选择抹了 —— 这是静默丢数据。
 *    这种项后面标「（不在备选名单）」并把值原样留着。
 * ③ **不再发一次请求**：清单走 `useModels()`（模块级缓存 + 订阅，
 *    与工作台设置共用一份）。节点要频繁开关，每个节点各拉一次很浪费，
 *    而且两处可能看到不一样的清单。
 *
 * ## 值形状
 *
 * 存的是 `"provider/model"` 字符串。**拼与拆都走 `encodeModelPick` /
 * `decodeModelPick`**，不在这里自己 `split('/')` —— 模型名里可能带 `/`，
 * 且将来形状若改成两段式对象，只改那两个函数。
 *
 * @param props.value - 当前值（存档里的那个字符串）。
 * @param props.onChange - 改值回调。
 * @returns 控件元素。
 */
function ModelControl(props: { value: unknown, onChange: (v: unknown) => void }) {
  const { catalog, error, loading } = useModels()
  const cur = decodeModelPick(typeof props.value === 'string' ? props.value : '')
  const curKey = cur === null ? '' : encodeModelPick(cur)
  const picks = catalog?.prefs.picks ?? []

  /** 下拉里的选项：跟随默认 → 备选名单 → （必要时）存档里那个。 */
  const options: { key: string, label: string }[] = [{ key: '', label: '跟随默认' }]
  for (const p of picks) {
    const key = encodeModelPick(p)
    if (key === '' || options.some(o => o.key === key)) continue
    options.push({ key, label: key })
  }
  if (curKey !== '' && !options.some(o => o.key === curKey)) {
    options.push({ key: curKey, label: curKey + '（不在备选名单）' })
  }

  /* 读不到的提示：**说清原因**，但控件照旧渲染 —— 留空 / 已选都还能保存，
   * 不至于因为读不到清单就把这个参数锁死。 */
  const why = loading
    ? '正在读取模型列表…'
    : (error !== undefined && catalog === null ? '读不到模型列表：' + error : '')

  return (
    <div data-ewb-model-ctl="">
      <select
        className={css_node_form.select}
        value={curKey}
        aria-label="模型"
        onChange={e => { props.onChange(e.target.value) }}
      >
        {options.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
      </select>
      {why !== '' && <div className={css_node_form.paramHint}>{why}</div>}
      {why === '' && picks.length === 0 && curKey === '' && (
        <div className={css_node_form.paramHint}>
          工作台设置里的备选名单为空，所以只能「跟随默认」。
        </div>
      )}
    </div>
  )
}

/**
 * 渲染一个参数的控件（按 paramDef.kind 决定）。
 * @param props.def - 参数定义。
 * @param props.value - 当前值。
 * @param props.onChange - 改值回调。
 * @param props.fieldCandidates - 「选节点 + 选字段」参数的可选清单（`kind: 'nodeField'` 用）。
 * @param props.workflowCandidates - 「选一份工作流」参数的可选清单（`kind: 'workflowRef'` 用）。
 * @param props.ifSources - 「条件表」参数的可选来源（`kind: 'ifRules'` 用）。
 * @returns 控件元素。
 */
function ParamControl(props: {
  def: ParamDef
  value: unknown
  onChange: (v: unknown) => void
  fieldCandidates?: readonly FieldCandidate[]
  workflowCandidates?: readonly WorkflowCandidate[]
  ifSources?: IfRulesSources
}) {
  const { def, value, onChange } = props
  switch (def.kind) {
    case 'boolean':
      return (
        <label className={css_node_form.ctlRow}>
          <input type="checkbox" className={css_node_form.checkbox} checked={value === true} onChange={e => { onChange(e.target.checked) }} />
          <span className={css_node_form.ctlBoolText}>{value === true ? '开启' : '关闭'}</span>
        </label>
      )
    case 'nodeField':
      return <NodeFieldControl def={def} value={value} onChange={onChange} candidates={props.fieldCandidates ?? []} />
    case 'workflowRef':
      return <WorkflowRefControl value={value} onChange={onChange} candidates={props.workflowCandidates ?? []} />
    case 'ifRules':
      return <IfRulesControl value={value} onChange={onChange} sources={props.ifSources} />
    case 'model':
      return <ModelControl value={value} onChange={onChange} />
    case 'select':
      return (
        <select className={css_node_form.select} value={asText(value)} onChange={e => { onChange(e.target.value) }}>
          {def.options?.map(o => (
            <option key={o.value} value={o.value}>{o.label}{o.description === undefined ? '' : ' — ' + o.description}</option>
          ))}
        </select>
      )
    case 'number':
      return (
        <div className={css_node_form.ctlRow}>
          <input
            className={css_node_form.input}
            type="number"
            value={asText(value)}
            placeholder={def.placeholder}
            min={def.min}
            max={def.max}
            step={def.step}
            onChange={e => { const n = Number(e.target.value); onChange(Number.isNaN(n) ? 0 : n) }}
          />
          {def.unit !== undefined && <span className={css_node_form.unit}>{def.unit}</span>}
        </div>
      )
    case 'textarea':
    case 'json':
      return (
        <textarea
          className={css_node_form.textarea}
          rows={def.kind === 'json' ? 3 : 4}
          value={asText(value)}
          placeholder={def.placeholder}
          spellCheck={false}
          onChange={e => { onChange(e.target.value) }}
        />
      )
    case 'secret':
      return (
        <input className={css_node_form.input} type="password" value={asText(value)} placeholder={def.placeholder}
          onChange={e => { onChange(e.target.value) }} />
      )
    case 'date':
      return (
        <input className={css_node_form.input} type="date" value={asText(value)}
          onChange={e => { onChange(e.target.value) }} />
      )
    case 'list':
      return (
        <textarea
          className={css_node_form.textarea}
          rows={3}
          value={Array.isArray(value) ? value.join('\n') : asText(value)}
          placeholder={def.placeholder}
          spellCheck={false}
          onChange={e => { onChange(splitLines(e.target.value)) }}
        />
      )
    case 'kv':
      return (
        <textarea
          className={css_node_form.textarea}
          rows={3}
          value={kvToText(value)}
          placeholder={def.placeholder ?? '每行一条：键=值'}
          spellCheck={false}
          onChange={e => { onChange(textToKv(e.target.value)) }}
        />
      )
    default:
      return (
        <input className={css_node_form.input} type="text" value={asText(value)} placeholder={def.placeholder}
          onChange={e => { onChange(e.target.value) }} />
      )
  }
}

/**
 * 一个参数块：标签 + 控件 + **常显说明**（用户要求：参数的意义必须说明）。
 * @param props.def - 参数定义。
 * @param props.value - 当前值。
 * @param props.onChange - 改值回调。
 * @param props.fieldCandidates - 「选节点 + 选字段」参数的候选（透传给控件）。
 * @param props.ifSources - 「条件表」参数的候选来源（透传给控件）。
 * @returns 参数块元素。
 */
function ParamBlock(props: {
  def: ParamDef
  value: unknown
  onChange: (v: unknown) => void
  fieldCandidates?: readonly FieldCandidate[]
  workflowCandidates?: readonly WorkflowCandidate[]
  ifSources?: IfRulesSources
}) {
  const { def } = props
  const required = def.required === true
  return (
    <div className={css_node_form.param}>
      <div className={css_node_form.paramHead}>
        <span className={css_node_form.paramLabel}>{def.label}</span>
        {required && <span className={css_node_form.paramReq}>必填</span>}
        {def.advanced === true && <span className={css_node_form.paramAdv}>高级</span>}
      </div>
      <ParamControl def={def} value={props.value} onChange={props.onChange} fieldCandidates={props.fieldCandidates} workflowCandidates={props.workflowCandidates} ifSources={props.ifSources} />
      {/* 说明常显（n8n 的 parameter hint 做法） */}
      {def.hint !== '' && <div className={css_node_form.paramHint}>{def.hint}</div>}
    </div>
  )
}

/**
 * 失败处理选择器（三态）。
 *
 * 为什么单独抽成一个组件（2026-10-11）：用户要求
 * 「失败处理应该独立层贴底」—— 它要从编辑体里**搬出去**，
 * 固定贴在节点展开区的底部（不随参数一起滚动）。
 * 搬出去之后，节点内展开与浮卡两处都要能放它，所以抽成独立组件复用。
 *
 * @param props.value - 当前策略。
 * @param props.onChange - 改策略。
 * @returns 三选一控件（不含外层容器）。
 */
export function OnErrorPicker(props: { value: OnError, onChange: (v: OnError) => void }) {
  return (
    <div className={css_node_form.seg}>
      {ON_ERROR_OPTIONS.map(o => (
        <button
          key={o.value}
          type="button"
          className={props.value === o.value ? css_node_form.segBtn + ' ' + o.cls : css_node_form.segBtn}
          title={o.label + '：' + o.desc}
          onClick={() => { props.onChange(o.value) }}
        >{o.label}</button>
      ))}
    </div>
  )
}

/**
 * 节点详细说明区（照 Node-RED 五段式；有内容才显示对应段）。
 *
 * ⚠️ **默认收起**（用户 2026-10-11：「这个节点在做什么和能引用哪些变量两个章节的
 * 功能很好，但是他们都应该默认收起」）。原来写死了 `open`。
 * 理由：这两个是**查阅型**内容（第一次用这个节点时看一遍），不是每次调参都要看；
 * 展开时它会把参数区往下挤，用户每次都得先滚过它才能改参数。
 *
 * @param props.def - 节点定义。
 * @returns 说明区元素，或 null。
 */
function NodeDetailBlock(props: { def: NodeDef }) {
  const d = props.def.detail
  if (d === undefined) return null
  const rows: { k: string, v: string }[] = []
  if (d.what !== undefined) rows.push({ k: '做什么', v: d.what })
  if (d.inputs !== undefined) rows.push({ k: '输入', v: d.inputs })
  if (d.outputs !== undefined) rows.push({ k: '输出', v: d.outputs })
  if (d.whenToUse !== undefined) rows.push({ k: '何时用', v: d.whenToUse })
  if (d.cautions !== undefined) rows.push({ k: '注意', v: d.cautions })
  if (rows.length === 0 && d.docUrl === undefined) return null
  return (
    <details className={css_node_form.detailBlock}>
      <summary className={css_node_form.detailSum}>节点说明</summary>
      <div className={css_node_form.detailBody}>
        {rows.map(r => (
          <div key={r.k} className={css_node_form.detailRow}>
            <span className={css_node_form.detailKey}>{r.k}</span>
            <span className={css_node_form.detailVal}>{r.v}</span>
          </div>
        ))}
        {d.docUrl !== undefined && (
          <a className={css_node_form.detailLink} href={d.docUrl} target="_blank" rel="noreferrer">查看文档 ↗</a>
        )}
      </div>
    </details>
  )
}

/**
 * 节点级提示（照 n8n 的 hints：info / warning / danger 三档配色）。
 *
 * ⚠️ 字段名是 **`type`**，不是 `level`（2026-10-25 契约 AO：引擎把 `NodeHint.level`
 * 改名成 `type` —— 因为运行时汇报 `ReportEntry` 与静态提示 `NodeHint` 现在是
 * 同一套字段，`NodeHint` 只是在它基础上多了 `whenToDisplay` / `displayCondition`）。
 *
 * @param props.def - 节点定义。
 * @returns 提示区元素，或 null。
 */
function NodeHints(props: { def: NodeDef }) {
  const hints = props.def.hints
  if (hints === undefined || hints.length === 0) return null
  return (
    <>
      {hints.map((h, i) => {
        /* 缺 `type` 按 info（灰）—— 提示本身还要显示，不该因为缺字段整条消失。 */
        const t: HintLevel = h.type ?? 'info'
        return (
          <div key={i} className={css_node_form.hint + ' ' + css_node_form['hint_' + t]}>
            <span className={css_node_form.hintMark}>{t === 'danger' ? '✕' : t === 'warning' ? '!' : 'i'}</span>
            <span>{h.message}</span>
          </div>
        )
      })}
    </>
  )
}

/**
 * 可用变量清单（告诉用户「这里能写哪些 {{名字}}」）。
 *
 * 点一个名字就把它复制到剪贴板，省得手打错。没有可用变量时不显示（避免空区块占地方）。
 *
 * @param props.vars - 变量名列表。
 * @returns 区块元素，或 null。
 */
function AvailableVars(props: { vars: readonly string[] }) {
  if (props.vars.length === 0) return null
  return (
    <details className={css_node_form.detailBlock}>
      <summary className={css_node_form.detailSum}>可用变量（{props.vars.length} 个）</summary>
      <div className={css_node_form.varList}>
        {props.vars.map(name => (
          <button
            key={name}
            type="button"
            className={css_node_form.varChip}
            title="点击复制这个变量名"
            onClick={() => { void copyText('{{' + name + '}}') }}
          >{'{{' + name + '}}'}</button>
        ))}
      </div>
      <div className={css_node_form.paramHint}>
        写在任意参数里即可，运行时会被上游的实际值替换；也可用 env.名字 / vars.名字 取环境变量与全局变量。
      </div>
    </details>
  )
}

/**
 * 复制文本到剪贴板（失败静默——复制不了不影响填参数）。
 * @param text - 要复制的内容。
 */
async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text) } catch { /* 剪贴板不可用就跳过 */ }
}

/**
 * 属性表单体（浮卡与节点内展开共用）。
 * @param props - 见 NodeEditorBodyProps。
 * @returns 表单元素。
 */
export function NodeEditorBody(props: NodeEditorBodyProps) {
  const def = props.def
  const deps = def.deps
  /**
   * 缺件时的显示（票 22，2026-10-27 改）。
   *
   * 原来只有 `props.state === 'missing'` 一条判据 —— 而那时候没有任何东西
   * 会把状态置成 missing，所以下面整块从来没显示过。
   * 现在：状态由画布按后端判定标上去，同时把「缺什么 + 怎么装」带进来。
   * 两者任一成立就显示 —— 画布还没取到判定结果时（刚挂载那一瞬）也不会突然不显示。
   */
  const missingDeps = props.state === 'missing' || props.depsGap !== undefined
  /** 高级参数是否展开（默认收起）。 */
  const [showAdv, setShowAdv] = useState(false)

  /* ── 两块可收展的默认开合（用户 m03425 第 2 条）──────────────────────
   *
   * 用户原话：「当前节点说明做了默认收缩，备注、浏览器这两个，**有参数的时候
   * 默认收缩，没有参数的时候默认展开**。」并进一步确认判据是
   * **「这块自己有没有内容」**：已经写过备注 / 已经配过这个标签 → 收起；
   * 空白 → 展开（空着还收起来，用户就得先点一下才能发现那里能填）。
   *
   * ⚠️ 用 `useState` 的惰性初值、**只在挂载那一刻按内容定一次**，
   * 不直接把 `open` 写成 `!hasContent`：后者会让「用户刚开始打字 → 内容一出现
   * → 面板立刻收起」，字还没打完框就没了。之后开合交给用户自己。
   * （编辑体是「节点展开时才挂载」的，所以每次重新打开节点会重新判一次。） */
  const hasIdentity = (props.label ?? '').trim() !== '' || (props.note ?? '').trim() !== ''
  const tagConfigured = props.browser === undefined
    ? false
    : props.browser.prefs.tags[props.browser.tag] !== undefined
  const [noteOpen, setNoteOpen] = useState(() => !hasIdentity)
  const [browserOpen, setBrowserOpen] = useState(() => !tagConfigured)

  const paramDefs = def.paramDefs ?? []

  /**
   * 一个参数**现在该不该显示**（`showWhen`）。
   *
   * ## 为什么必须有它（用户 2026-10-13 报的问题）
   *
   * 用户原话：「浏览器这个节点，他明明是几个功能选择，但是他的界面是**将所有功能
   * 都列出来了**，这个不对，应该**只列出所选功能**。」
   *
   * 根因：`showWhen` 早就写在参数定义里了（全项目 27 处），
   * 但**客户端从来没有读它** —— 所以界面把 12 个参数全列出来，
   * 其中「选择器」「要填的内容」「截哪一块」这些跟当前动作毫无关系。
   *
   * ## 判据
   *
   * `showWhen.equals` 里**命中任一**即显示（原设计就是这样，见 `ParamShowWhen`）。
   * 没写 `showWhen` 的参数**永远显示**。
   *
   * ⚠️ 比较用**松散相等**（`==` 的语义）：参数值可能来自存档（数字存成字符串），
   * 用严格相等会让「选了但界面不显示」—— 那是很难查的。
   * 所以先归一化成字符串再比。
   *
   * @param p - 参数定义。
   * @returns 该显示则 true。
   */
  const visible = (p: ParamDef): boolean => {
    const w = p.showWhen
    if (w === undefined) return true
    /* 依赖的那个参数当前值（实例值优先，退回默认值）。 */
    const raw = props.params[w.key]
    const cur = raw === undefined
      ? (paramDefs.find(x => x.key === w.key)?.default)
      : raw
    const curText = cur === undefined || cur === null ? '' : String(cur)
    return w.equals.some(eq => String(eq) === curText)
  }

  /* 按 paramDefs 渲染；若节点没写 paramDefs，回退到「按值猜控件」（老节点兼容）。
   *
   * ⚠️ `hidden` 的参数**在这里被去掉**（用户 2026-10-16 报的重复）。
   * 它的界面在别处（如「浏览器」一节的「标签」），参数区不该再出一遍。
   * **值照旧存在、照旧被用** —— 只是这里不画控件（照 n8n 的 `type: 'hidden'`，
   * 它的理由是 `// Fast path: hidden parameters are never displayed`）。
   * 判据放在这里而不是 `visible()` 里：`visible()` 的表达力是「条件显示」，
   * 而这一条是「永不在参数区出现」，两件事分开写才不会互相干扰。 */
  const shownDefs = paramDefs.filter(p => p.hidden !== true).filter(visible)
  const common = shownDefs.filter(p => p.advanced !== true)
  const adv = shownDefs.filter(p => p.advanced === true)
  const legacy = paramDefs.length === 0
    ? Object.entries(props.params).map(([k, v]) => ({
      key: k, label: k, kind: (typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? 'number' : 'text') as ParamDef['kind'],
      hint: '（这个节点还没写参数说明）', default: v,
    } as ParamDef))
    : []

  /** 渲染一个参数块（值优先取实例 params，退回 def 默认值）。 */
  const renderParam = (p: ParamDef) => {
    const raw = props.params[p.key]
    const val = raw === undefined ? p.default : raw
    return <ParamBlock key={p.key} def={p} value={val} onChange={v => { props.onParam(p.key, v) }} fieldCandidates={props.fieldCandidates} workflowCandidates={props.workflowCandidates} ifSources={props.ifSources} />
  }

  return (
    <>
      {/* ⚠️ 这里曾有一排小方块：「执行方 BUILTIN · 成功 · 完成」。
       * 用户 2026-10-11 判定「这些都没用」，已整体删掉。逐条理由：
       *   - **执行方**：节点的标题栏上已经写着（节点顶部那行 `◆ BUILTIN`），
       *     且它**就是节点颜色**的来源 —— 重复一次没有新信息；
       *   - **状态词（成功/失败/待运行）**：节点自己的描边与发光已经表达了
       *     （失败变红、运行中 breathing），而且**看有没有输出**比看这个词更直接；
       *   - **progress（完成/排队中）**：同上，运行面板本来就在显示进度。
       * 结论：这三个都是「界面上已经说过的话，再说一遍」。 */}

      {/* ══ 可滚动区：除贴底的失败处理外，**全部内容都在这块里**
       * （用户 m03425 第 3 条：「除了底部的失败处理固定，其他全部进滚动区域」）。
       *
       * ⚠️ 块里的子项一律受 `.block > * { flex: 0 0 auto }` 保护，不许被压扁。
       * 那条 CSS 规矩的来历写在 `node-form.module.css` 里（曾经参数区被压成 0 高）。
       *
       * ## 顺序（用户 m03425 第 1 条钦定，别再顺手调）
       *
       *   0 备注 → 1 节点提示 → 2 依赖检查 → 3 节点说明
       *   → 4 可用变量 → 5 浏览器 → 6 参数
       *
       * 这个顺序是**从「这是什么」到「怎么配」**：先把身份与警告说清，
       * 再给背景资料（说明 / 变量），最后才是要动手填的配置。
       * 删除节点（第 8 位）**不在这里** —— 用户 m03500 判定它该在**节点外面**
       * （见 `WorkflowNode.tsx` 的 `NodeToolbar`）。 */}
      <div className={css_node_form.block}>
        {/* ── 0 备注（原「这个节点」，用户 m03425 改名）────────────────────
         *
         * 用户 2026-10-12 点出的真问题：「当前的说明部分只是说这个节点的功能，
         * 而不是实现了什么」——「功能」是类型级的（随类型固定），
         * 而「实现了什么」是实例级的（我在这里为什么这么写）。
         * 后者没有地方可写，时间一久就彻底忘了。所以这两栏必须有。
         *
         * 照 n8n：Rename node（改实例名）+ Notes（备注）。
         *
         * ★ 可收展（用户 m03425 第 2 条）：**有内容就收起、空白就展开**。
         * 收起来时只占一行（`.detailBlock` 的 `margin-bottom` 是 1px，
         * 见 CSS 里那条「两个章节之间不该有间隔」）。 */}
        {(props.onLabel !== undefined || props.onNote !== undefined) && (
          <details
            className={css_node_form.detailBlock}
            open={noteOpen}
            onToggle={e => { setNoteOpen(e.currentTarget.open) }}
          >
            <summary className={css_node_form.detailSum}>备注</summary>
            <div className={css_node_form.detailBody}>
              {props.onLabel !== undefined && (
                <>
                  <input
                    className={css_node_form.identInput}
                    value={props.label ?? ''}
                    placeholder={def.label}
                    onChange={e => { props.onLabel?.(e.target.value) }}
                  />
                  <div className={css_node_form.identHint}>
                    给它起个名字（不填就显示类型名「{def.label}」）。只影响显示，不影响运行。
                  </div>
                </>
              )}
              {props.onNote !== undefined && (
                <>
                  <textarea
                    className={css_node_form.identNote}
                    value={props.note ?? ''}
                    placeholder="写一句「我为什么在这里用它」——比如「先判断有没有登录，没登录就停」"
                    rows={2}
                    onChange={e => { props.onNote?.(e.target.value) }}
                  />
                  <div className={css_node_form.identHint}>填了备注后，节点上会显示它，替掉那行类型说明。</div>
                </>
              )}
            </div>
          </details>
        )}

        {/* ── 1 节点提示 ──────────────────────────────────────────── */}
        <NodeHints def={def} />

        {/* ── 2 依赖检查（缺件时才有）─────────────────────────────────
         *
         * 票 22：只列真正缺的那几条，不再把声明全列一遍再统一标「缺失」。
         *
         * 为什么改：旧写法 `DEP_KIND.flatMap(k => deps[k])` 会把并不缺的依赖
         * 也标成「缺失」—— 声明了 `npm:['playwright']` 而机器上有它，
         * 那块仍会写「playwright · 缺失」。那是这一轮反复出现的那类假话：
         * 看起来报了，其实报错了。现在缺什么由后端判、把清单带进来。 */}
        {missingDeps && (
          <div className={css_node_form.field} data-ewb-node-deps="">
            <label className={css_node_form.fieldLabel}>依赖检查（缺这些就跑不了）</label>
            <div className={css_node_form.depList}>
              {props.depsGap !== undefined
                ? props.depsGap.gaps.map(g => (
                  <div className={css_node_form.dep} key={g.kind + g.name} data-ewb-node-dep={g.kind + ':' + g.name}>
                    <span className={css_node_form.depKind}>{DEP_KIND.find(k => k.key === g.kind)?.name ?? g.kind}</span>
                    <span className={css_node_form.depWarn}>{g.name} · 缺失</span>
                  </div>
                ))
                : /* 后端判定还没到（刚挂载那一瞬）：把声明列出来，但话要说清
                   * 「这是这个节点要的」而不是「这些缺了」—— 不许拿声明冒充缺口。 */
                  DEP_KIND.flatMap(k => (deps?.[k.key] ?? []).map(item => (
                    <div className={css_node_form.dep} key={k.key + item}>
                      <span className={css_node_form.depKind}>{k.name}</span>
                      <span className={css_node_form.depWarn}>{item} · 需要</span>
                    </div>
                  )))}
            </div>
            {/* 「缺什么」之后必须给「怎么装」—— 只说缺的话用户还得自己去查。 */}
            {props.depsGap !== undefined && (
              <div className={css_node_form.depFix} data-ewb-node-deps-fix="">{props.depsGap.reason}</div>
            )}
          </div>
        )}

        {/* ── 3 节点说明 + 4 可用变量 ─────────────────────────────────
         * 两者都默认收起（用户 2026-10-11：「这个节点在做什么和能引用哪些变量
         * 两个章节……都应该默认收起」），收起时像一组可展开的行。
         * 它们是「这是什么节点」的上下文，所以排在要动手填的配置**之前**。 */}
        <NodeDetailBlock def={def} />
        <AvailableVars vars={props.availableVars ?? []} />

        {/* ── 5 浏览器 ───────────────────────────────────────────────
         * 用户 2026-10-14：「浏览器选择这个模块应该就是插件内容的一部分
         * 而不是一个独立模块，他应该是 playwright 这个节点的**第一块内容**。」
         * （那条「必须是第一块」已被 m03425 的新顺序取代 —— 现在它在说明与变量之后。）
         *
         * ## 为什么必须留在 `.block` 里（实测出来的根因，不是猜的）
         *
         * 它曾经写在 `.block` **之外**、`.footBar` 之前，于是成了
         * `.inlineEditor`（`max-height` + `overflow: hidden` + 纵向 flex）的
         * **兄弟 flex 项**。而在这条 flex 链上 `.block` 带 `min-height: 0`，
         * 它是**唯一能被压到 0 的子项** —— 真 Chromium 实测：`.block` 可见高度
         * **0px**（内容真实高 426px）。搬进来后同样条件 **93px 且能滚动**。
         *
         * ⚠️ 与 CSS 里 `.block > *` 那条是**同一个病根**：flex 子项能不能被压缩，
         * 取决于它的 `overflow` 是不是 `visible`。本项踩过三次。
         *
         * ★ 可收展（用户 m03425 第 2 条）：**已配过这个标签 → 收起**，
         * 空白 → 展开。判据是「这块自己有没有内容」。 */}
        {props.browser !== undefined && (
          <details
            className={css_node_form.detailBlock}
            open={browserOpen}
            onToggle={e => { setBrowserOpen(e.currentTarget.open) }}
          >
            <summary className={css_node_form.detailSum}>浏览器</summary>
            <div className={css_node_form.detailBody}>
              <NodeBrowserSection
                tag={props.browser.tag}
                onTag={props.browser.onTag}
                prefs={props.browser.prefs}
                onPrefs={props.browser.onPrefs}
                browsers={props.browser.browsers}
                detect={props.browser.detect}
                otherTags={props.browser.otherTags}
              />
            </div>
          </details>
        )}

        {/* ── 6 参数 ──────────────────────────────────────────────── */}
        <div className={css_node_form.field}>
          <label className={css_node_form.fieldLabel}>参数</label>
          {common.length === 0 && legacy.length === 0 && adv.length === 0
            ? <div className={css_node_form.paramHint}>该节点没有可填参数</div>
            : (
              <>
                {common.map(renderParam)}
                {legacy.map(renderParam)}
                {adv.length > 0 && (
                  <>
                    <button
                      type="button"
                      className={css_node_form.advToggle}
                      onClick={() => { setShowAdv(v => !v) }}
                    >{showAdv ? '▾ 收起高级参数' : '▸ 高级参数（' + String(adv.length) + '）'}</button>
                    {showAdv && adv.map(renderParam)}
                  </>
                )}
              </>
            )}
        </div>
      </div>

      {/* ── 7 失败处理：**贴底独立层**，唯一不进滚动区的一块 ──────────────
       * 它是对**整个节点**的策略，不是某个参数的一部分；贴在底部才符合它的身份，
       * 也不会被滚走 —— 用户滚参数时它始终看得见。 */}
      <div className={css_node_form.footBar} data-ewb-foot=''>
        <span className={css_node_form.footLabel}>失败处理</span>
        <OnErrorPicker value={props.onError} onChange={v => { props.onOnError(v) }} />
        {/* ★ 重试（2026-10-19 加，照源码 `douyin-ui.ts` 的 `downloadOne`）。
         *
         * ⚠️ **与上面的「失败处理」是两件事，别合并成一个下拉**：
         *   · 失败处理 = 失败后**走不走**（中断整条 / 继续往下）；
         *   · 重试     = 失败后**再试几次**。
         * 两者叠加：继续 + 重试 2 = 先重试 2 次，还失败就往下走。
         *
         * 值存在 `params.retryTimes` / `params.retryDelayMs`（`readRetry` 读它们），
         * **不是** `paramDefs` 里的项 —— 因为它俩对所有节点都成立、都长一样，
         * 塞进每个节点的 `paramDefs` 要改 30 个定义文件，而「失败处理」本来就是
         * 贴底的**跨节点**策略区。放这里与它的身份一致（同一块「整个节点的策略」）。
         *
         * ⚠️ **必须带 `retryNum` 类**：`.input` 本身是 `width: 100%`（给竖排表单用的），
         * 直接放进 flex 行会各占满、把整行撑到卡片外面 —— 那正是 268px 溢出的成因之一。
         * `.retryNum` 把宽度写死 3.2rem（≈51px）+ `flex: 0 0 auto`。
         *
         * 2026-10-19 真 Chrome 实测（284px 容器）：`.footBar` 的 `flex-wrap` 兜底 +
         * 两个 51px 输入框 → 不溢出、整块高 65px。宽节点上会自动并回一排。 */}
        <span className={css_node_form.footLabel}>失败后重试</span>
        <input
          type="number"
          min={0}
          max={10}
          className={css_node_form.input + ' ' + css_node_form.retryNum}
          value={typeof props.params.retryTimes === 'number' ? props.params.retryTimes : 0}
          title="失败后额外重试几次（0 = 不重试）。与上面的「失败处理」叠加：先重试，还失败再按那个策略走。"
          onChange={e => { props.onParam('retryTimes', Math.max(0, Math.min(10, Number(e.target.value) || 0))) }}
        />
        <span className={css_node_form.paramHint}>次，间隔</span>
        <input
          type="number"
          min={0}
          step={500}
          className={css_node_form.input + ' ' + css_node_form.retryNum}
          value={typeof props.params.retryDelayMs === 'number' ? props.params.retryDelayMs : 0}
          title="两次重试之间等多久（毫秒）。0 = 立刻重试。"
          onChange={e => { props.onParam('retryDelayMs', Math.max(0, Number(e.target.value) || 0)) }}
        />
        <span className={css_node_form.paramHint}>毫秒</span>
      </div>

      {/* ── 8 删除节点 ──────────────────────────────────────────────
       * ⚠️ **不在这里**。它原来渲染在 `.popFoot` 里，但调用方
       * （`WorkflowNode.tsx`）从来没传 `onDelete` → 用户根本看不到这个按钮
       * （用户 m03500 报的就是这个）。现已照用户裁定搬到**节点工具条**
       * （`WorkflowNode.tsx` 的 `NodeToolbar`，选中节点时浮现）。 */}
    </>
  )
}

/**
 * ⚠️ **浮卡（`V1Popover`）已删除**（2026-10-11 清理死代码）。
 *
 * 编辑方式早在 2026-10-08 就**固化**为「节点内展开」（用户定：弹框不要了），
 * 但那个浮卡组件一直没删 —— 它没有调用方，只有自己的定义。
 * 保留它的代价：这一轮的「失败处理贴底」要改两处（浮卡与内联），
 * 而浮卡那条路根本没人走。删掉后只需维护一条路径。
 *
 * 一并删掉的还有它的入参类型 `V1PopoverProps`。
 * 表单体 `NodeEditorBody` 仍在用 —— 那是内联展开的实体。
 */
