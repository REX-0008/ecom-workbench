/** 工作流节点组件（深色发光风）。
 *
 * 信息层级（从上到下，用户要求「能填的参数在中间，按钮和输出在最下面」）：
 *   1 谁     —— 顶部：执行方徽标（shell / agent / http / builtin）+ 节点类型短名
 *   2 做什么 —— 节点名 + 一句话说明（**要说清「用什么动作做什么」**，不能只看名字）
 *   3 输入输出 —— 左入口 / 右出口（含**失败分支出口**，见下）
 *   4 运行时 —— 进度条 + 最近日志（跑过才出现）
 *   5 参数   —— inline 模式下的可填参数（中间区）
 *   6 运行   —— 底部：单节点 ▶ / 从这里跑 ▶▶ + 输出端点
 *
 * 失败分支出口（2026-10-08 修）：
 *   onError＝continueErrorOutput 时，节点右侧**多一个专用出口**（红色，id＝__error）。
 *   否则「走失败分支」这个选项根本无分支可走。
 *
 * missing 与 failed 的视觉区分（硬要求）：
 *   failed  = 红实心脉冲圆 + 红描边
 *   missing = 琥珀虚线描边 + 斜纹底 + 方块图标（点「缺件」，不点「出错」）
 */
import { memo, useEffect, useLayoutEffect, type CSSProperties } from 'react'
import css_node_card from './node-card.module.css'
import css_node_form from './node-form.module.css'
import { Handle, Position, NodeToolbar, useUpdateNodeInternals, type NodeProps, type Node } from '@xyflow/react'
import { NodeRunPanel } from './NodeRunPanel.tsx'
import { PORT_COLORS, STATE_META, resolveCategory, type NodeState, type NodeDef, type PortType, type OnError } from '../../workflow/model.ts'
import { NodeEditorBody, type FieldCandidate, type WorkflowCandidate, type NodeEditorBodyProps } from './NodeEditorPopover.tsx'
import { LoopNodeCard } from './LoopNode.tsx'
import { toneClass } from './node-style.ts'
import { hasSession, sessionColor } from './session-color.ts'
/* 撑高之后向画布报一声（让下游让位）。为什么不用 window 事件见那个文件头。 */
import { pingExpandShift } from './expand-ping.ts'

/** 失败分支专用出口 id（与 node-sample.ts 的 ERROR_HANDLE 对应）。 */
export const ERROR_HANDLE = '__error'

/** 循环节点的定义 id（外观要分派给循环框组件）。 */
export const LOOP_DEF_ID = 'flow.loop'

/** 执行方 → 图标 + 名称。
 *
 * ⚠️ **这里曾经还有一个 `how`（如「本进程内直接算」），2026-10-11 已删**。
 * 用户原话：「最上不是有谁来跑了吗，所以第三行是否有必要？是否只是重复信息？」
 * —— 判断成立：`BUILTIN` 已经回答了「谁来跑」，「本进程内直接算」只是它的中文翻译，
 * 而真正有用的那句（「不在页面上」）写在节点自己的 `summary` 里。
 * 26 个节点因此各矮一行。 */
const EXECUTOR_META: Record<NodeDef['executor'], { mark: string, name: string }> = {
  shell:   { mark: '>_', name: 'SHELL' },
  agent:   { mark: '\u2726', name: 'AGENT' },
  http:    { mark: '\u21c4', name: 'HTTP' },
  builtin: { mark: '\u25c6', name: 'BUILTIN' },
}

/** 六态各自的符号——形状本身就是第二重编码（色盲也能区分）。 */
const STATE_MARK: Record<NodeState, string> = {
  idle:    '\u00b7',
  queued:  '\u22ef',
  running: '\u25d0',
  success: '\u2713',
  failed:  '!',
  missing: '\u2298',
  cancelled: '\u25a0',
}

/** 节点的 data 载荷（画布侧写入，节点侧只读）。 */
export interface V1NodeData extends Record<string, unknown> {
  /** 节点类型定义（真源）。 */
  def: NodeDef
  /**
   * 分组框的标题（**历史字段名**，只 `type === 'group'` 的节点上有）。
   *
   * ## 为什么必须在这里声明（2026-10-24 契约 AK）
   *
   * 这个接口 `extends Record<string, unknown>` —— 没声明的字段全推断成
   * `unknown`（索引签名兜底）。于是 `owner.data.groupLabel ?? '分组'` 那句里
   * `groupLabel` 是 `unknown`、`?? '分组'` 是 `string`，两者并起来仍是 `unknown`，
   * 赋给返回类型 `string` 就报 TS2322。
   *
   * **这不是补类型骗过检查**：`WorkflowCanvas.tsx` 确实在往 `data.groupLabel`
   * 写值（`:1027` / `:1425` / `:3630`），这里只是把已经在用的事实写出来。
   */
  groupLabel?: string
  /**
   * 「浏览器」一节传给编辑器的入参（只 `hasSession` 的节点上有）。
   *
   * ## 为什么要在 `V1NodeData` 里声明它（2026-10-24 契约 AK）
   *
   * `extends Record<string, unknown>` 让没声明的字段全是 `unknown`。
   * `:418` 那里 `browser={data.browser}` 把它传给 `NodeEditorBodyProps.browser`
   * （一个结构明确的类型），`unknown` 赋给它就报 TS2740。
   *
   * 形状直接借 `NodeEditorBodyProps['browser']` —— **不复制一份**：
   * 那是它的真源，复制会漂（见 `pitfalls/同一件事写两份迟早漂.md`）。
   * 用 `NonNullable<…>` 剥掉「可选」再取，正好与这里的 `?` 相容。
   */
  browser?: NodeEditorBodyProps['browser']
  /** 当前状态（六态之一）。 */
  state: NodeState
  /**
   * 缺依赖的详情（票 22，2026-10-27）。
   *
   * 由画布从 `GET /nodes/deps` 拿到的清单里按 `def.id` 查出来传进节点。
   * 只有声明了依赖且**真的不满足**的节点才有它 —— 其余节点上是 `undefined`，
   * 属性面板那一块就不出现。
   */
  depsGap?: {
    /** 缺的每一条。 */
    gaps: readonly { kind: string, name: string }[]
    /** 后端攒好的那句话（缺什么 + 各组怎么装）。 */
    reason: string
  }
  /** 进度文字（如「第 3/10 项」）。 */
  progress?: string
  /** 本实例的参数（**必须存实例**，不能改共享的 def.params —— 否则同类型节点会一起变）。 */
  params?: Record<string, unknown>
  /** 本实例的失败策略（同上，实例级）。 */
  onError?: OnError
  /** 编辑方式：popover＝贴节点右侧弹框 / inline＝节点内展开。 */
  editMode?: 'popover' | 'inline'
  /** inline 模式下该节点是否已展开。 */
  expanded?: boolean
  /** 改一个参数。 */
  onParam?: (key: string, value: unknown) => void
  /** 改失败策略。 */
  onOnError?: (v: OnError) => void
  /** 只跑这一个节点。 */
  onRunOne?: () => void
  /** 从这个节点开始跑整条链。 */
  onRunFrom?: () => void
  /**
   * 删除这个节点（工具条上那个红按钮走它）。
   *
   * 用户 m03500：「删除节点按钮我现在在节点中看不到，**放在节点外面**吧」。
   * 原来它渲染在编辑体内、靠 `NodeEditorBody` 的 `onDelete` prop ——
   * 但调用方**从来没传**，所以那个按钮根本不可达。现在改由画布注入、
   * 画在节点外的工具条上（选中时浮现）。
   */
  onDelete?: () => void
  /**
   * 本节点能引用到的变量名（由画布按连线算好传进来）。
   *
   * 计算放画布侧的原因：只有画布知道全局的连线关系，
   * 节点卡片只知道自己的定义。
   */
  availableVars?: readonly string[]
  /**
   * 「选节点 + 选字段」参数的候选清单（循环的输入/输出用它）。
   *
   * 照 Dify 的 `ValueSelector`：循环的进出不再走端口与连线，
   * 改由参数里**选一个节点 + 它的输出字段**指定。
   */
  fieldCandidates?: readonly FieldCandidate[]
  /**
   * 「选一份工作流」参数的候选清单（2026-10-19 新增）。
   *
   * `flow.workflow` 节点用它：参数从「填名字」改成「选编号」，
   * 显示的是名字（用户要求的「引用用编号不用名称」，理由见 `workflow/ids.ts`）。
   */
  workflowCandidates?: readonly WorkflowCandidate[]
  /**
   * 「条件表」参数（`kind: 'ifRules'`）的候选来源（2026-10-19 新增）。
   *
   * `flow.if` 节点的「选变量 + 比较符 + 值」用它：左边能选上游节点的字段、
   * 循环变量、开始节点的输入。三份清单都只有画布算得出来（它知道图长什么样），
   * 所以与 `fieldCandidates` 一样透传下来。
   */
  ifSources?: {
    fields: readonly FieldCandidate[]
    loopVars: readonly string[]
    inputs: readonly string[]
  }
  /**
   * 本实例的显示名（覆盖 `def.label`）——照 n8n 的 Rename node。
   *
   * 用户 2026-10-12 的原话：「这是一段代码，llm 写的，写的时候我知道什么意思，
   * 但是看的时候我不知道……当前的说明部分只是说这个节点的功能，而不是实现了什么。」
   * 所以类型说明之外，还要有一层**实例级**的名字与备注。
   */
  label?: string
  /** 本实例的备注（讲「我在这里为什么用它」）。 */
  note?: string
  /** 循环框是否收起成一张卡片（显示语义，不影响运行）。 */
  collapsed?: boolean
  /** 切换收起（循环框用）。 */
  onToggleCollapse?: () => void
  /** 改实例名（循环框等自带输入的地方用）。 */
  onRename?: (v: string) => void
  /** 改实例名（节点编辑区用；与 onRename 同义，名字不同是因两处调用方不同）。 */
  onLabel?: (v: string) => void
  /** 改实例备注。 */
  onNote?: (v: string) => void
}

/** 画布节点类型别名。 */
export type V1Node = Node<V1NodeData, 'v1'>

/**
 * 一个端口行（点 + 名字 + 类型色）。
 *
 * ⚠️ 关于「端点不好点」这件事（用户 2026-10-12）：
 *   **端点元素本身一点没改** —— 它仍是 9px 的圆点，仍在节点外框上、一半出框。
 *   放大的只是它的**点击区**（CSS 里 `.handle::before` 往外扩一圈）。
 *   为什么不直接放大这个元素：React Flow 用它的 `getBoundingClientRect()`
 *   算连线锚点（见 `getHandleBounds`），元素一变，**连线的落点就跟着变** ——
 *   那正是「改了外观、反而改差」的原因（我上一版就是这么错的）。
 *   伪元素的溢出**不计入** `getBoundingClientRect`，所以扩点击区不碰外观与锚点。
 */
function PortRow(props: { portId: string, label: string, type: PortType, kind: 'in' | 'out', tone?: string }) {
  const color = props.tone ?? PORT_COLORS[props.type]
  const isIn = props.kind === 'in'
  return (
    <div className={isIn ? css_node_card.portIn : css_node_card.portOut} title={props.label + ' · ' + props.type}>
      <Handle
        id={props.portId}
        type={isIn ? 'target' : 'source'}
        position={isIn ? Position.Left : Position.Right}
        className={css_node_card.handle}
        /* 圆点的颜色与发光仍走内联样式（照原样）—— 内联管不到伪元素，
         * 但圆点就是元素自己的背景，不需要伪元素。 */
        style={{ background: color, boxShadow: '0 0 6px ' + color }}
      />
      <span className={css_node_card.portLabel}>{props.label}</span>
      <span className={css_node_card.portType} style={{ color }}>{props.type}</span>
    </div>
  )
}

/**
 * 工作流节点卡片。
 * @param props - React Flow 注入的节点属性。
 * @returns 节点元素。
 */
export const V1NodeCard = memo(function V1NodeCard({ id, data, selected }: NodeProps<V1Node>) {
  /* ⚠️ **循环节点走另一套外观**（用户 2026-10-12：「循环这个节点本身是一个框，
   * 把其他节点包在里面」）。
   *
   * 为什么要在这里分派、而不是给它单独的 `type`：
   *   1. 存档里的 `type` 只认 `v1` / `group`，加第三种要动存档格式与读回逻辑；
   *   2. 它**仍然是普通节点身份**（有 `def`、能被 `runGraph` 派发语义识别、
   *      参数存法一致），只是长得像框 —— 换 `type` 会让这些地方全要跟着改。
   * 所以外观分派放在这里：**一个 switch，不动数据模型**。 */
  if (data.def.id === LOOP_DEF_ID) {
    /* ⚠️ `fieldCandidates` 必须传下去 —— 2026-10-15 补。
     * 循环的两个关键设置（「遍历哪个数据」/「结果取哪个」）是 `kind: 'nodeField'`
     * 参数，本来归 `NodeEditorBody` 渲染；而这个函数对循环**提前返回**，
     * 那个组件一次都不会跑 → 那两项设置**在界面上完全没有呈现**（用户报的）。 */
    return <LoopNodeCard id={id} data={data} selected={selected} />
  }

  /* 节点高度会随运行时面板/参数区出现而变化 —— 必须通知 React Flow 重算端口位置，
   * 否则连线的端点会停在旧位置（调研明确的已知坑，Langflow 同样处理）。 */
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => { updateNodeInternals(id) }, [id, data.state, data.expanded, updateNodeInternals])

  /**
   * 报到：我这次**撑高（或缩回）**了，让画布去算下游让位。
   *
   * 为什么用 `useLayoutEffect` 而不是 `useEffect`：要让位的计算发生在
   * DOM 已经更新、浏览器**还没画这一帧**的时刻 —— 那时量到的高度才是最终高度，
   * 而移动又赶在同一帧画出来，用户看不到中间态。
   * `useEffect` 在绘制之后跑，会看见节点先长高、下一帧别人再让开（那一跳）。
   *
   * ⚠️ 只报「我变了」，**不带高度** ——让位那一侧统一用 `measureNodes` 量，
   * 保证「算让位用的尺寸」与「自动布局用的尺寸」是同一套（除过画布缩放）。
   */
  useLayoutEffect(() => {
    pingExpandShift(id)
    /* 依赖里为什么要 `data.state`：输出面板是**按状态**出现的（活跃态常显、
     * 终态留一行摘要）。状态一变节点就长高了一截，也得让位。 */
  }, [id, data.expanded, data.state])

  const def = data.def
  const state = data.state
  const progress = data.progress
  const meta = STATE_META[state]
  const ex = EXECUTOR_META[def.executor]
  const tone = toneClass(state)
  const toneVar = { '--v1-tone': 'var(--v1-' + tone + ')' } as CSSProperties
  /** 本实例是否被跳过（跳过时不执行，上游数据原样传下去）。 */
  const skipped = data.skipped === true
  const cls = [css_node_card.node, css_node_card[tone], skipped ? css_node_card.skipped : '', selected === true ? css_node_card.selected : ''].filter(Boolean).join(' ')
  const shortId = def.id.slice(def.id.indexOf('.') + 1)
  /** 本实例的失败策略（优先实例级，退回类型定义级）。 */
  const effOnError = data.onError ?? def.onError ?? 'stop'
  /** 本实例的参数（优先实例级，退回类型定义级）。 */
  const effParams = data.params ?? def.params ?? {}
  /** 是否声明了失败分支出口（onError 三态里的第三态）。 */
  const hasErrBranch = effOnError === 'continueErrorOutput'
  /**
   * 实例级显示名与备注（用户 2026-10-12 要求）。
   *
   * 「实例名」说的是**我在这里为什么用它**（LLM 写下这行代码时的意图）；
   * 而 `def.label` 说的是**这类节点是干什么的**。两者都要有：
   * 只看类型名 → 时间久了不知道当初为什么这么写；
   * 只看实例名 → 不知道它是什么类型的节点、能接什么。
   */
  const instanceName = typeof data.label === 'string' ? data.label.trim() : ''
  const hasCustomName = instanceName !== ''
  /** 标题：有实例名用实例名，否则用类型名。 */
  const shownName = hasCustomName ? instanceName : def.label
  /** 副标题位置的文字：有备注用备注（讲意图），否则用类型说明（讲功能）。 */
  const noteText = typeof data.note === 'string' ? data.note.trim() : ''
  const expanded = data.editMode === 'inline' && data.expanded === true
  /**
   * 会话色标（用户 2026-10-12：「节点上色标」）。
   *
   * 判据是**节点定义里有没有 `session` 参数**（不是「id 是不是 browser.*」）——
   * 前者是「它真的用会话」，将来别的节点用会话时自动覆盖。
   * 颜色按**名字哈希**得出：同名恒同色，加删节点不会让别的节点变颜色。
   *
   * ⚠️ 位置：必须放在 `effParams`（上面）**之后** ——
   * 本项目「用在定义之前」会让整块画布白屏，靠 `npm run check:tdz` 拦。
   */
  const showSession = hasSession(def.paramDefs)
  const sessRaw = String(effParams.session ?? '').trim()
  const sessName = sessRaw === '' ? '默认' : sessRaw
  const sessColor = sessionColor(sessName)

  /* 节点分类：用于顶部色条（用户要求「不同节点类型应是不同颜色」）。
   * 取节点自己声明的 category，没声明就归兜底类。 */
  const category = resolveCategory(def)
  return (
    <div className={cls} data-state={state} data-cat={category}>
      {/* 类型色条：常驻在节点顶部，表示「我是哪一类」。
       * 与状态色（描边/发光）是两个正交通道——「是什么」和「怎么样了」分开看。 */}
      <div className={css_node_card.catBar} aria-hidden="true" />
      {/* 跳过标记：整块压暗 + 右上角一个「跳过」角标（一眼看出这个不参与运行）。 */}
      {skipped && <div className={css_node_card.skipBadge} title="这个节点被跳过：不执行，上游数据原样传给下游">跳过</div>}
      {/* 官方节点工具条（@xyflow/react 的 NodeToolbar，MIT）：选中时才浮现，不占节点常驻空间。 */}
      {/* 为什么改用工具条：常显按钮要占掉节点一行高度，而运行是低频操作。 */}
      <NodeToolbar isVisible={selected === true} position={Position.Top} offset={8}>
        <div className={css_node_card.nodeToolbar}>
          <button
            type="button"
            className={css_node_card.nodeToolBtn}
            title="只运行这一个节点（调试用）"
            disabled={state === 'running'}
            onClick={e => { e.stopPropagation(); data.onRunOne?.() }}
          >▶ 跑这个</button>
          <button
            type="button"
            className={css_node_card.nodeToolBtn}
            title="从这个节点开始，往下跑整条链"
            disabled={state === 'running'}
            onClick={e => { e.stopPropagation(); data.onRunFrom?.() }}
          >▶▶ 从这里跑</button>
          {/* 删除（用户 m03500：放在**节点外面**的工具条上）。
           * 为什么用红色描边类而不是默认样式：它是破坏性操作，得与上面两个
           * 「跑」按钮一眼分开（`.nodeToolDanger` 复用状态色，见 node-card.module.css）。 */}
          <button
            type="button"
            className={css_node_card.nodeToolBtn + ' ' + css_node_card.nodeToolDanger}
            title="删掉这个节点（连同它的连线，Ctrl+Z 可恢复）"
            onClick={e => { e.stopPropagation(); data.onDelete?.() }}
          >✕ 删除</button>
        </div>
      </NodeToolbar>

      {/* 1 谁 —— 执行方（图标 + 名称）
       *
       * 浏览器类节点额外挂一个**会话色标**（用户 2026-10-12 要求「节点上色标」）：
       * 同一个会话名 = 同一个颜色，让「这几个节点是不是在同一台浏览器上跑」
       * 在画布上一眼可见。**会话名不同其实是错的**（取不到上一步的页面），
       * 色标就是让这种错直接看得见 —— 不然只能跑起来才发现。 */}
      <div className={css_node_card.head}>
        <span className={css_node_card.execMark}>{ex.mark}</span>
        <span className={css_node_card.execName}>{ex.name}</span>
        {showSession && (
          <span
            className={css_node_card.sessionTag}
            style={{ '--session-color': sessColor } as CSSProperties}
            title={'浏览器会话：' + sessName + '（同名 = 同一台浏览器）'}
          >
            <span className={css_node_card.sessionDot} />
            {sessName}
          </span>
        )}
        <span className={css_node_card.spacer} />
        <span className={css_node_card.badge}>{shortId}</span>
      </div>

      {/* 2 做什么 —— 节点名 + 说明（说清「用什么动作做什么」）
       *
       * ⚠️ **标题优先显示实例名**（用户 2026-10-12 要求，照 n8n 的 Rename node）。
       * 用户原话：「这是一段代码，llm 写的，写的时候我知道什么意思，但是看的时候我不知道……
       * 当前的说明部分只是说这个节点的功能，而不是实现了什么。」
       * 所以「类型名（这类节点是干什么的）」与「实例名（我在这里为什么用它）」分成两层：
       *   - 有实例名 → 标题显示实例名，类型名退到副标题位（不然用户不知道它是什么类型的节点）；
       *   - 没有实例名 → 照旧显示类型名。 */}
      <div className={css_node_card.title} title={shownName === def.label ? def.label : def.label + '（实例名：' + shownName + '）'}>
        {shownName}
      </div>
      {/* 实例名存在时，把类型名放出来 —— 否则「这是哪种节点」的信息就丢了。 */}
      {hasCustomName && <div className={css_node_card.typeLine}>{def.label}</div>}
      {def.summary !== undefined && <div className={css_node_card.summary}>{noteText !== '' ? noteText : def.summary}</div>}

      {/* 3 输入输出 —— 端口（含失败分支专用出口） */}
      <div className={css_node_card.ports}>
        <div className={css_node_card.portsCol}>
          {def.inputs.map(p => <PortRow key={'i' + p.id} portId={p.id} label={p.label} type={p.type} kind="in" />)}
        </div>
        <div className={css_node_card.portsCol}>
          {def.outputs.map(p => <PortRow key={'o' + p.id} portId={p.id} label={p.label} type={p.type} kind="out" />)}
          {hasErrBranch && (
            <PortRow portId={ERROR_HANDLE} label="失败" type="any" kind="out" tone="#ff5f56" />
          )}
        </div>
      </div>

      {/* 4 运行时数据 —— 进度条 + 最近日志 */}
      <NodeRunPanel state={state} nodeId={id} selected={selected === true} />

      {/* 5 参数（inline 模式）—— 放中间，用户在节点上直接填 */}
      {expanded && (
        /* ⚠️ `nowheel` 这个类名是 **React Flow 认的约定**（默认 `noWheelClassName`）：
         * 它判断到滚轮事件的 target 落在 `.nowheel` 里面时，就**不缩放画布**、
         * 让事件照常冒泡给这个容器自己的滚动条。
         *
         * 不加会怎样（用户 2026-10-11 报的）：节点展开后内容超高、出现内部滚动条，
         * 但用户在节点上滚轮，滚的却是**画布缩放**——内部滚动条永远滚不动，
         * 调参数时根本看不到下面的字段。 */
        <div className={css_node_form.inlineEditor + ' nowheel'} data-ewb-editor=''>
          <NodeEditorBody
            def={def}
            state={state}
            progress={progress}
            params={effParams}
            onError={effOnError}
            onParam={data.onParam ?? (() => { /* 未接回调 */ })}
            onOnError={data.onOnError ?? (() => { /* 未接回调 */ })}
            availableVars={data.availableVars ?? []}
            /* 「选节点 + 选字段」参数的候选（循环的输入/输出用它）。
             * 照 Dify 的 ValueSelector —— 用户从清单里挑，不用记节点 id。 */
            fieldCandidates={data.fieldCandidates ?? []}
            /* 「选一份工作流」的候选（`flow.workflow` 节点的参数用它）。 */
            workflowCandidates={data.workflowCandidates ?? []}
            /* 条件表的候选来源（`flow.if` 用）—— 与 `fieldCandidates` 一样透传。 */
            ifSources={data.ifSources}
            /* 实例级名字与备注（照 n8n 的 Rename node + Notes）。 */
            label={data.label ?? ''}
            note={data.note ?? ''}
            onLabel={data.onLabel}
            onNote={data.onNote}
            /* 浏览器一节（用户 2026-10-13：「标签→浏览器应该是在节点设置」）。
             * ⚠️ 只有**管会话的节点**才挂它（由画布按 `hasSession` 决定），
             * 别的节点这里是 undefined，那一节不出现。 */
            browser={data.browser}
            /* 缺依赖的详情（票 22）：缺哪些、怎么装。只有 `missing` 的节点有。 */
            depsGap={data.depsGap}
          />
        </div>
      )}

    </div>
  )
})
