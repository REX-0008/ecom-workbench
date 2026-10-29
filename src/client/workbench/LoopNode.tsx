/** 循环框（把循环体节点装在里面）。
 *
 * ## 为什么单独一个组件（不复用节点卡片）
 *
 * 它**既是可运行的节点、又是容器**，两者都要表达：
 *   - 作为节点：有输入口（要遍历的数据）、有出口（结果）、要能跑、能看状态；
 *   - 作为容器：有背景边框把子节点框住，拖动它时子节点跟着走。
 *
 * 复用节点卡片会让它长得像普通节点，用户不知道「可以把东西拖进去」；
 * 反过来只做成一个框（像分组框）又会丢掉「它会执行」这件事。
 * 所以它自己一个组件：**上半是节点头（名字 / 状态 / 参数），下半是容器面**。
 *
 * ## 与分组框的关键区别
 *
 * | | 分组框 | 循环框 |
 * |---|---|---|
 * | 会执行吗 | 不会（纯背景） | **会**（逐轮跑子节点） |
 * | 有端口吗 | 没有 | **有**（入 / 出） |
 * | 用户 2026-10-12 的选择 | 保持原样 | 这个 |
 *
 * ⚠️ **「有端口」这一行 2026-10-13 曾是错的**（当时定义里的端口被删掉、只认参数，
 * 这个注释与下面的 `<Handle>` 却没跟着改，界面在承诺一件定义里不存在的事）。
 * **2026-10-17 用户定案「补实」** —— 定义已加回 `in` / `done`，
 * 这一行与下面两个 `<Handle>` 现在与定义一致。详见
 * `src/nodes/flow/loop/node.ts` 的端口注释。
 *
 * ## 收起（照 Dify）
 *
 * 收起后只显示一条卡片（名字 + 轮数），子节点**不显示**。
 * 这是**显示语义**，与「跳过」不同 —— 收起不代表不执行。
 */
import { memo, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import css_card from './node-card.module.css'
import { PORT_COLORS, STATE_META, type NodeState, type NodeDef } from '../../workflow/model.ts'
import { toneClass } from './node-style.ts'
/* 只借类型（`FieldCandidate` 的形状定义在那里）—— 不引组件，
 * 免得把整个编辑体拖进循环框的依赖链。 */
import type { FieldCandidate, IfRulesSources } from './NodeEditorPopover.tsx'
/* ★ 「跳出条件」的控件**直接复用** `flow.if` 那一个（2026-10-19）。
 *
 * 为什么是引组件而不是抄一份：它是 150 行的条件表编辑器（18 个比较符、
 * 三种左边来源、增删行、类型下拉），抄一份两边迟早漂 ——
 * 见 `pitfalls/同一件事写两份迟早漂.md`。
 *
 * 为什么不担心依赖链：`NodeEditorPopover.tsx` 本来就在循环框的依赖链上
 * （`FieldCandidate` 那个类型 import 就是它），引一个具名组件不会多拖什么。 */
import { IfRulesControl } from './NodeEditorPopover.tsx'

/** 循环框的 data 载荷（与 V1NodeData 结构兼容，见 LoopNodeCard 的说明）。 */
export interface LoopNodeData extends Record<string, unknown> {
  /** 节点定义（真源）。 */
  def: NodeDef
  /** 当前状态。 */
  state: NodeState
  /** 进度文字（如「第 3/10 轮」）。 */
  progress?: string
  /** 本实例参数。 */
  params?: Record<string, unknown>
  /** 本实例的显示名（覆盖 def.label）。 */
  label?: string
  /** 是否收起成一张卡片。 */
  collapsed?: boolean
  /**
   * 「设置」面板是否打开。
   *
   * ⚠️ **2026-10-16 从组件内部 state 搬到节点 data**（用户报「设置点击没有作用」）。
   *
   * 原因：面板占高度，而框的高度是 `fitLoopBox` 写死的**内联** `height` ——
   * 组件内部的 `useState` 对画布不可见，框就不知道该长高，面板会被挤出框外
   * （实测：`.loopBody` 是 `flex: 1 1 auto; min-height: 60px`，它把剩余空间占满，
   * 面板只能溢出）。放进 data 后，`fitLoopBox` 能在同一拍里把高度加上去。
   */
  settingsOpen?: boolean
  /** 切换「设置」面板。 */
  onToggleSettings?: () => void
  /**
   * 框内排列的**手动**方向（用户 2026-10-21 要的「给循环加个按钮调整横排和竖排」）。
   *
   * 不给就用 `axisAuto`（画布方向推出来的）。给过就**一直是它**，
   * 不再跟着画布方向变 —— 否则用户切完、一动画布就被打回默认。
   */
  axis?: 'TB' | 'LR'
  /** 画布方向推出来的方向（只在 `axis` 没给时用）。 */
  axisAuto?: 'TB' | 'LR'
  /** 切换框内方向（竖排 ↔ 横排）。 */
  onToggleAxis?: () => void
  /**
   * 拖动时这个循环**是落点**（高亮它，提示「松手就装进这里」）。
   *
   * 用户 2026-10-12 提的加入方式：「拖到循环中，循环框高亮然后松开鼠标拖入」。
   */
  dropTarget?: boolean
  /**
   * 候选态：在它里面，但**还没停够时间**。
   *
   * 用户要的是「亮**了**才算数」（没亮时松手不会加入），所以未确认时
   * 必须与已确认**明显不同** —— 否则用户分不清「现在松手算不算」。
   */
  dropPending?: boolean
  /**
   * 正在**离开**这个容器 —— 它要**变暗**（用户：「出框 1 秒后变暗」）。
   *
   * 与 `dropTarget`（加粗变亮）方向相反：那是「要进去」、这是「要出来」。
   * 两者都做成「加粗变亮」的话，用户看不出松手到底会进还是出。
   */
  leaving?: boolean
  /** 改一个参数。 */
  onParam?: (key: string, value: unknown) => void
  /** 切换收起。 */
  onToggleCollapse?: () => void
  /** 改实例名。 */
  onSetName?: (v: string) => void
  /**
   * 把设置面板的**实测高度**报回给画布（用户 2026-10-16：
   * 「这个空间留出，你是弄的自动的，看设置有多少内容流多少，还是硬编码的」）。
   *
   * 原来是硬编码 `BOX_SETTINGS_H = 190` —— 面板内容多少变了它不会跟着变。
   * 现在面板自己量 `offsetHeight` 上报，`fitLoopBox` 按**实测值**让位。
   *
   * ⚠️ **量不到时（`offsetHeight === 0`）不要上报** —— jsdom 没有布局，
   * 恒为 0；真机上也要等布局完成。此时由 `fitLoopBox` 用它自己的估算值兜底。
   */
  onSettingsHeight?: (h: number) => void
  /** 上一次上报的面板高度（画布存的，用来避免重复上报）。 */
  settingsPanelH?: number
  /**
   * 「选节点 + 选字段」的候选清单（`items` / `result` 两个参数用）。
   *
   * ⚠️ **2026-10-15 补**：循环的两个关键设置原先**在界面上根本没有呈现** ——
   * 「遍历哪个数据」与「结果取哪个」是 `kind: 'nodeField'` 的参数，
   * 本来由 `NodeEditorBody` 渲染；而 `V1NodeCard` 对循环节点**提前返回**了
   * `LoopNodeCard`，`NodeEditorBody` 一次都不会跑（用户报的
   * 「循环的设置目前好像前端没有呈现」就是这个）。
   *
   * 现在由 `LoopNodeCard` 自己的设置面板渲染（照 `NodeFieldControl` 的两个下拉）。
   */
  fieldCandidates?: readonly FieldCandidate[]
  /**
   * 「跳出条件」左边能选什么（2026-10-19 加，`breakConditions` 用）。
   *
   * 与 `flow.if` 的 `ifSources` **同一个形状**（`IfRulesSources`），理由：跳出条件
   * 与条件判断是同一套条件结构（照 Dify「与 if-else 同一个 Condition 类型」）。
   *
   * ⚠️ 内容与 `flow.if` 的**不一样**，别混：
   *   · `fields` —— 这里是**循环体内**的节点（跳出判的是「本轮跑得怎么样」），
   *     不是「上游节点」。所以由画布按 `parentId === 本循环` 算出来传进来；
   *   · `loopVars` —— 本层及以外各层的变量名（`item` / `outer.item` …）。
   */
  breakSources?: IfRulesSources
}

/**
 * 「选节点 + 选字段」的两个下拉（循环的 `items` / `result` 用）。
 *
 * 形状照 `NodeEditorPopover.tsx` 的 `NodeFieldControl` —— 那里是给普通节点用的，
 * 但循环框**渲染不到那个组件**（见 `LoopNodeData.fieldCandidates` 的说明），
 * 所以在这里补一份等价的最小实现。
 *
 * ⚠️ 不直接 import 那个组件：它住在 `NodeEditorPopover.tsx` 里（未导出），
 * 而且把整个编辑体（含浏览器一节、参数控件全家桶）拖进循环框的依赖链没有必要。
 * 两个下拉的重复是可接受的 —— 它们是**十行级**的稳定形状，
 * 而「同一件事写两份迟早漂」那条（见 `pitfalls/同一件事写两份迟早漂.md`）
 * 针对的是**会被改的语义**（字段清单、翻译规则），不是这种纯展示形状。
 *
 * @param props.label - 这一行叫什么。
 * @param props.value - 当前值（`{ nodeId, field }`）。
 * @param props.candidates - 候选节点 + 各自字段。
 * @param props.onChange - 改值回调。
 * @param props.emptyHint - 一个候选都没有时的说明（**不静默**，照本项目规矩）。
 * @param props.optional - 是否允许「不选」（`result` 可以不选＝输出每轮完整结果）。
 * @returns 两个下拉（或一句说明）。
 */
function LoopNodeField(props: {
  label: string
  value: unknown
  candidates: readonly FieldCandidate[]
  onChange: (v: unknown) => void
  emptyHint: string
  optional?: boolean
}) {
  const cur = (props.value !== null && typeof props.value === 'object')
    ? props.value as { nodeId?: unknown, field?: unknown }
    : {}
  const curNode = typeof cur.nodeId === 'string' ? cur.nodeId : ''
  const curField = typeof cur.field === 'string' ? cur.field : ''

  if (props.candidates.length === 0) {
    /* ⚠️ **标签必须照常渲染**（2026-10-15 修正）。
     *
     * 第一版直接 return 一句说明、把标签省了 —— 结果是「空画布上刚加的循环
     * 根本看不到『遍历哪个数据』这一项」，用户会以为这个功能没做。
     * 而**空清单恰恰是最常见的初始状态**（循环前面还没放产出数据的节点）。
     *
     * 正确做法：标签留着（说明这一项**存在、叫什么**），
     * 下面那句说明「为什么现在没得选、去哪儿能有」。 */
    return (
      <label className={css_card.loopField}>
        <span>{props.label}</span>
        <span className={css_card.loopFieldNote}>{props.emptyHint}</span>
      </label>
    )
  }

  const node = props.candidates.find(c => c.id === curNode)
  /* 节点换了 → 字段清空（旧字段不属于新节点，留着执行时取不到值）。 */
  const setNode = (id: string): void => { props.onChange({ nodeId: id, field: '' }) }
  const setField = (f: string): void => { props.onChange({ nodeId: curNode, field: f }) }

  return (
    <label className={css_card.loopField}>
      <span>{props.label}</span>
      <span className={css_card.loopFieldPair}>
        <select
          className={css_card.loopFieldSelect}
          value={curNode}
          title="选哪个节点"
          onChange={e => { setNode(e.target.value) }}
        >
          <option value="">{props.optional === true ? '（不选＝输出每轮完整结果）' : '（选节点）'}</option>
          {props.candidates.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select
          className={css_card.loopFieldSelect}
          value={curField}
          title="选它的哪个输出"
          disabled={node === undefined}
          onChange={e => { setField(e.target.value) }}
        >
          {/* 空串 = 整体输出（节点只有一个输出时用户不必再选一次）。 */}
          <option value="">整个输出</option>
          {(node?.fields ?? []).map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
      </span>
    </label>
  )
}

/**
 * 循环框。
 *
 * ⚠️ **props 故意写成这个最小形状**，没用 `NodeProps<LoopNode>`：
 * 它是被 `V1NodeCard` **直接调用**的（不是由 React Flow 按 `nodeTypes` 渲染的），
 * 所以只需要这三个值。用 `NodeProps` 会要求调用方编造十几个无关字段；
 * 而把它注册进 `nodeTypes` 又要给存档加第三种 `type`（见 `V1NodeCard` 里的说明）。
 * 两头都不划算，所以在这里收窄。
 *
 * @param props.id - 节点实例 id。
 * @param props.data - 节点数据（结构上兼容 `V1NodeData`）。
 * @param props.selected - 是否被选中。
 * @returns 循环框元素。
 */
export const LoopNodeCard = memo(function LoopNodeCard(props: {
  id: string
  data: LoopNodeData
  selected?: boolean
}) {
  const { id, data, selected } = props
  /* 高度会随收起/展开变化 —— 必须通知 React Flow 重算端口位置，否则连线端点会停在旧处。
   *
   * ⚠️ **必须在 `useEffect` 里调**（2026-10-16 修的真 BUG）。
   * 这行原先在**渲染期**直接调用，而 `useUpdateNodeInternals` 内部是
   * 「`requestAnimationFrame` → 往 zustand store 写 `nodeLookup`」，
   * 写进去的是**新对象**，`NodeWrapper` 用 `shallow` 订阅 → 判「变了」→ 重渲染
   * → 又执行这行 → **每帧一次，无限循环**。真机上表现是「点什么都没反应」
   * （用户 2026-10-16 报的「设置还是无法打开，点击没有作用」就是这个）。
   *
   * ⚠️ **为什么 46 个测试全绿也发现不了**：那个内部 `doUpdate` 判据里含
   * `dimensions.width && dimensions.height`，而 **jsdom 没有布局**
   * （`offsetWidth` 恒 0）→ 一次都不写 store → 测试里完全无害。
   * 真浏览器 `offsetWidth > 0` → 每帧写。所以这类 bug 只有真浏览器
   * （或读源码断言）能抓。普通节点的 `V1NodeCard` 一直是用 `useEffect`
   * 的正确写法，只有循环这里漏了。
   * 详见 `pitfalls/假防线-看着写了其实不生效.md` ⑩ 与 §三。 */
  const updateNodeInternals = useUpdateNodeInternals()
  const def = data.def
  const state = data.state
  const meta = STATE_META[state]
  const tone = toneClass(state)
  const toneVar = { '--v1-tone': 'var(--v1-' + tone + ')' } as CSSProperties
  const collapsed = data.collapsed === true
  /** 显示名：实例名优先，退回类型名。 */
  const name = data.label ?? ''
  /** 框头上显示的名字（实例名为空时给类型名作占位提示）。 */
  const shownName = name !== '' ? name : def.label
  /** 轮数上限（给收起态显示「最多 N 轮」）。 */
  const maxIters = typeof data.params?.maxIters === 'number' ? data.params.maxIters : 100
  const mode = typeof data.params?.mode === 'string' ? data.params.mode : 'items'
  /** 设置面板开着吗（住`data`里，见 `LoopNodeData.settingsOpen` 的说明）。 */
  const showSettings = data.settingsOpen === true
  /**
   * 框内现在是竖排还是横排（用户 2026-10-21：给循环加个按钮调整横排和竖排）。
   *
   * 来源：`data.axis`（用户手动切过的值）优先；没切过就用画布方向推出来的那个
   * （`innerAxisOf(dir)`，由画布在 `refitNodes` 时写进 `data.axisAuto`）。
   *
   * ⚠️ 为什么要有「手动值优先」这一层：自动方向是「横排画布→框内竖排」，
   * 那是个省地方的默认，但用户对着某个具体的框时可能就是想横着看。
   * 手动切过之后**不再自动改它** —— 否则用户切完、一动画布就被打回默认。
   */
  const axis = data.axis === 'TB' || data.axis === 'LR'
    ? data.axis
    : (data.axisAuto === 'TB' || data.axisAuto === 'LR' ? data.axisAuto : 'TB')
  /** 设置面板的 DOM 引用（量它的实测高度上报，见 `onSettingsHeight`）。 */
  const panelRef = useRef<HTMLDivElement | null>(null)
  /* 从 data 里取出那两个（既有的解构风格：`data` 整个传进来，用不到 `props.`）。 */
  const { onSettingsHeight, settingsPanelH: reportedH } = data
  /**
   * 把面板的**实测高度**报回画布（用户 2026-10-16：
   * 「这个空间留出，你是弄的自动的，看设置有多少内容流多少，还是硬编码的」）。
   *
   * 原来让位高度是硬编码 `BOX_SETTINGS_H = 190` —— 面板内容一多（比如多出
   * 「重复几次」那一行）它不会跟着变。现在面板自己量 `offsetHeight` 上报。
   *
   * ⚠️ 量不到（`offsetHeight === 0`）时**不上报**：jsdom 没有布局、恒为 0；
   * 真机上首帧也可能还是 0。此时由 `fitLoopBox` 的估算值兜底。
   * ⚠️ 上报前判「和上次一样吗」—— 否则 setNodes → 重渲染 → 再上报 → 死循环。 */
  useEffect(() => {
    if (!showSettings) return
    const h = Math.ceil(panelRef.current?.getBoundingClientRect().height ?? 0)
    /* 量不到就不报（jsdom 没有布局恒为 0；真机首帧也可能是 0）→ 由 `fitLoopBox` 兜底。 */
    if (h <= 0) return
    /* ⚠️ 和上次一样就不报 —— 否则 setNodes → 重渲染 → 再报 → 死循环。 */
    if (reportedH === h) return
    onSettingsHeight?.(h)
  }, [showSettings, reportedH, onSettingsHeight])

  /* 端口位置随尺寸变化重算（收起后卡片矮）。
   *
   * ⚠️⚠️ **必须在 `useEffect` 里调，不能在渲染期直接调**（2026-10-16 修的真 BUG，
   * 用户报「循环的设置还是无法打开，点击没有作用」）。
   *
   * 原来这行就裸在这函数体里（渲染期副作用）。`useUpdateNodeInternals()` 返回的
   * 函数内部是「`requestAnimationFrame` → 往 zustand store 里写 `nodeLookup`」，
   * 而它写进去的是**新对象**（`handleBounds` 每次都是新的），`NodeWrapper` 用
   * `shallow` 订阅 `{node, internals}` → 判定「变了」→ 重渲染 `LoopNodeCard`
   * → 又执行这行 → 又排一帧 → **60fps 无限循环**。
   *
   * 为什么测试全绿、真机才炸：那个 rAF 回调里有
   * `doUpdate = dimensions.width && dimensions.height && (... || update.force)`，
   * 而 `useUpdateNodeInternals` 传的正是 `force: true`。**jsdom 没有布局**，
   * `offsetWidth` 恒为 0 → `doUpdate` 为假 → 一次都不写真 store（测试环境里
   * 这行是无害的）；真浏览器里 `offsetWidth > 0` → 每帧都写 → 画布一直重渲染，
   * 表现就是「点什么都没反应」。
   *
   * 判据与普通节点一致：`V1NodeCard` 一直是 `useEffect(() => { updateNodeInternals(id) }, [...])`
   * （见 `WorkflowNode.tsx`），只有这里漏了。 */
  useEffect(() => {
    updateNodeInternals(id)
  }, [id, collapsed, showSettings, updateNodeInternals])

  const cls = [
    css_card.loopBox,
    css_card[tone],
    selected === true ? css_card.loopSelected : '',
    data.dropTarget === true ? css_card.loopDropTarget : '',
    data.dropPending === true ? css_card.loopDropPending : '',
    data.leaving === true ? css_card.loopLeaving : '',
    collapsed ? css_card.loopCollapsed : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={cls} data-state={state} data-loop-id={id} style={toneVar}>
      {/* 输入口：接要遍历的数据。 */}
      <Handle
        id="in"
        type="target"
        position={Position.Left}
        className={css_card.loopHandle}
        style={{ background: PORT_COLORS.any, boxShadow: '0 0 6px ' + PORT_COLORS.any }}
      />
      {/* 出口：交出错。 */}
      <Handle
        id="done"
        type="source"
        position={Position.Right}
        className={css_card.loopHandle}
        style={{ background: PORT_COLORS.any, boxShadow: '0 0 6px ' + PORT_COLORS.any }}
      />

      {/* 头部 + 设置面板：**两者裹在一个定位壳里**。
       *
       * ⚠️ **2026-10-16 修的真 BUG**：面板原先与框头是**兄弟**，而它是
       * `position:absolute; top:100%` —— `top:100%` 相对的是最近的**定位祖先**，
       * 那时就是 `.loopBox`（`position:relative`）。于是「100%」= **整个框的底边**，
       * 面板被画到框**下面**去了（用户原话：「你倒是留出空间了，但是设置内容没出现」）。
       * 而 `fitLoopBox` 按 `BOX_SETTINGS_H` 让出的是**框头下面那一段** ——
       * 两处说的不是同一个位置，所以「空白有了、面板没来」。
       *
       * 修法：给框头套一个 `position: relative` 的壳，把面板放进壳里 ——
       * 这样 `top:100%` 才真的等于「框头下沿」，与 CSS 注释里一直以来
       * 写的「紧贴框头那一行的下沿」终于一致。 */}
      <div className={css_card.loopHeadWrap}>
        <div className={css_card.loopHead}>
          <span className={css_card.loopMark} style={{ color: 'var(--v1-accent)' }}>{'\u21bb'}</span>
          {/* 名字**可直接改**（照 n8n 的 Rename node）——用户 2026-10-12：
           * 「llm 写的，写的时候我知道什么意思，看的时候我不知道」。
           * 所以实例名要能写，且就写在框头上。 */}
          <input
            className={css_card.loopNameInput + ' nodrag'}
            value={name}
            placeholder={def.label}
            title="循环的名字（只影响显示，不影响运行）"
            onChange={e => { data.onSetName?.(e.target.value) }}
            onClick={e => { e.stopPropagation() }}
          />
          <span className={css_card.loopMeta}>{meta.label}</span>
          {data.progress !== undefined && data.progress !== '' && (
            <span className={css_card.loopProgress}>{data.progress}</span>
          )}
          <span className={css_card.spacer} />
          <button
            type="button"
            className={css_card.loopBtn + ' nodrag'}
            title={axis === 'TB'
              ? '框内现在是竖排。点一下改成横排（成员从左往右摆）'
              : '框内现在是横排。点一下改成竖排（成员从上往下摆）'}
            onClick={e => { e.stopPropagation(); data.onToggleAxis?.() }}
          >{axis === 'TB' ? '\u2261 竖排' : '\u2263 横排'}</button>
          <button
            type="button"
            className={css_card.loopBtn + ' nodrag'}
            title="展开 / 收起这个循环（收起只是不显示内部节点，不影响运行）"
            onClick={e => { e.stopPropagation(); data.onToggleCollapse?.() }}
          >{collapsed ? '\u25be 展开' : '\u25b4 收起'}</button>
          <button
            type="button"
            className={css_card.loopBtn + ' nodrag'}
            title="循环设置"
            onClick={e => { e.stopPropagation(); data.onToggleSettings?.() }}
          >设置</button>
        </div>

        {/* 设置面板：改「逐条遍历 / 固定次数」与上限。
         *
         * ⚠️ **它必须在这个壳里面**（见 `loopHeadWrap` 的 CSS 注释）——
         * `top: 100%` 相对的是最近的定位祖先，放外面那层就变成「整个框的底」。 */}
        {showSettings && !collapsed && (
          <div className={css_card.loopSettings + ' nodrag'} ref={panelRef}>
            <label className={css_card.loopField}>
              <span>循环方式</span>
              <select
                className={css_card.loopFieldSelect}
                value={mode}
                onChange={e => { data.onParam?.('mode', e.target.value) }}
              >
                <option value="items">逐条遍历数组</option>
                <option value="count">固定重复几次</option>
              </select>
            </label>

            {/* ⚠️ **遍历哪个数据 / 结果取哪个**（2026-10-15 补）。
             *
             * 这两个是 `kind: 'nodeField'` 参数（「选节点 + 选字段」，照 Dify 的
             * `iterator_selector` / `output_selector`），原先只由 `NodeEditorBody`
             * 渲染 —— 而 `V1NodeCard` 对循环节点提前返回，那个组件根本不会跑，
             * 于是**循环最关键的两项设置在界面上完全没有呈现**（用户报的那条）。
             *
             * 形状与 `NodeEditorPopover.tsx` 的 `NodeFieldControl` 保持一致：
             * 两个下拉（先选节点、再选它的字段），空清单时明说原因。 */}
            {mode === 'items' && (
              <LoopNodeField
                label="遍历哪个数据"
                value={data.params?.items}
                candidates={data.fieldCandidates ?? []}
                onChange={v => { data.onParam?.('items', v) }}
                emptyHint="还没有可选的数据来源：先在它前面放一个产出数组的节点。"
              />
            )}

            <LoopNodeField
              label="结果取哪个"
              value={data.params?.result}
              candidates={data.fieldCandidates ?? []}
              onChange={v => { data.onParam?.('result', v) }}
              emptyHint="还没有可选的节点：把节点放进循环框里，就能选它的输出。"
              optional
            />

            {mode === 'count' && (
              <label className={css_card.loopField}>
                <span>重复几次</span>
                <input
                  type="number"
                  min={1}
                  value={typeof data.params?.count === 'number' ? data.params.count : 5}
                  onChange={e => { data.onParam?.('count', Number(e.target.value)) }}
                />
              </label>
            )}
            <label className={css_card.loopField}>
              <span>最大轮数</span>
              <input
                type="number"
                min={1}
                value={maxIters}
                onChange={e => { data.onParam?.('maxIters', Number(e.target.value)) }}
              />
            </label>

            {/* ⚠️ **「同时处理几条」必须在这里渲染**（2026-10-17 加）。
             *
             * 它就是参数定义里的 `concurrency`（`node.ts` 的 `paramDefs`，`advanced: true`）。
             * 高级参数**只在 `NodeEditorBody` 里渲染**，而 `V1NodeCard` 对循环节点
             * **提前返回**（见 LoopNodeCard 的说明）—— 所以这个参数在界面上
             * 从来就没出现过，只有手改 JSON 才设得上。
             *
             * 这和上面「遍历哪个数据 / 结果取哪个」是**同一个坑**（那两项 2026-10-15
             * 同样因为没有呈现而被用户报过）。判据：**循环节点的任何可填参数，
             * 都得在这块面板里有落点** —— 光有 `paramDefs` 不算数。 */}
            <label className={css_card.loopField}>
              <span>同时处理几条</span>
              <input
                type="number"
                min={1}
                max={10}
                value={typeof data.params?.concurrency === 'number' ? data.params.concurrency : 1}
                onChange={e => { data.onParam?.('concurrency', Number(e.target.value)) }}
              />
            </label>
            <div className={css_card.loopHint}>循环体里可用 {'{{item}}'} 取本轮数据、{'{'}{'{index}}'} 取第几轮；嵌套时用 {'{{outer.item}}'} 取外层那一轮</div>

            {/* ── 跳出条件（2026-10-19，照 Dify 的 `break_conditions`）─────────
             *
             * ⚠️ **必须在这里渲染**（与上面「遍历哪个数据 / 同时处理几条」同一个坑）：
             * 循环节点的参数不走 `NodeEditorBody`（`V1NodeCard` 对它提前返回），
             * 只加 `paramDefs` 而不在这里补控件 = 「定义里有、界面上没有」。
             *
             * 用 `flow.if` 的同一个控件（`IfRulesControl`），因为条件结构完全一样。
             * 说明文字换成循环的说法 —— 「成立就停这个循环，不是报错」。 */}
            <div className={css_card.loopField} data-ewb-loop-break>
              <span>跳出条件</span>
              <IfRulesControl
                value={data.params?.breakConditions}
                onChange={v => { data.onParam?.('breakConditions', v) }}
                sources={data.breakSources}
                emptyHint="还没有可选的值：把要做判断的节点放进这个循环框里，就能选它的输出。"
                noneHint="不填 = 一直跑到底。要「跑够就停」，点下面的「添加一条」。"
              />
            </div>
            {Array.isArray(data.params?.breakConditions) && data.params.breakConditions.length > 1 && (
              <label className={css_card.loopField}>
                <span>多条怎么算成立</span>
                <select
                  className={css_card.loopFieldSelect}
                  value={typeof data.params?.breakLogic === 'string' ? data.params.breakLogic : 'and'}
                  onChange={e => { data.onParam?.('breakLogic', e.target.value) }}
                >
                  <option value="and">全部满足</option>
                  <option value="or">满足任一</option>
                </select>
              </label>
            )}
            <div className={css_card.loopHint}>跳出条件成立就停这个循环（不算报错），已经跑完的轮次结果照常给出</div>

            {/* ── 连续失败跳出（2026-10-19，照源码的 `consecutiveFails`）────────
             *
             * ⚠️ **必须在这里渲染**（与上面「跳出条件」同一个理由：循环节点不走
             * `NodeEditorBody`）。只加 `paramDefs` 而不补控件 = 「定义里有、界面上没有」。
             *
             * ⚠️ **与上面的「跳出条件」是两件事**，所以分成两块、各有各的说明：
             * 上面按**你写的条件**停，这里按**失败次数自动**停。 */}
            <label className={css_card.loopField}>
              <span>连续失败几轮就停</span>
              <input
                type="number"
                min={0}
                value={typeof data.params?.maxConsecutiveFailures === 'number' ? data.params.maxConsecutiveFailures : 0}
                onChange={e => { data.onParam?.('maxConsecutiveFailures', Number(e.target.value)) }}
                title="0 = 不启用。设成 2 就是「连续 2 轮有节点失败就停这个循环」，成功一轮就清零。"
              />
            </label>
            <div className={css_card.loopHint}>0 = 不启用。填 2 就是「连续 2 轮失败就停」，成功一轮清零；停下不算报错</div>
          </div>
        )}
      </div>

      {/* 收起态：只说明「跑几次」，并提示里面有几个节点。 */}
      {collapsed && (
        <div className={css_card.loopCollapsedHint}>
          {mode === 'items' ? '逐条遍历上游数据' : '固定重复'}
          {mode === 'count' ? '（上限 ' + String(maxIters) + ' 轮）' : ''}
        </div>
      )}

      {/* 展开态：容器面（子节点由 React Flow 画在这块区域之上）。
       *
       * ⚠️ **设置面板打开时容器面要收起来**（2026-10-16）：它带 `flex: 1 1 auto`
       * 会把剩余高度全占掉，面板就被挤出框外。面板开着时让位给面板。 */}
      {!collapsed && !showSettings && (
        <div className={css_card.loopBody}>
          {/* 空框提示：告诉用户「把节点拖进来」。
           *
           * ⚠️ **空体时改成红色警告**（2026-10-17 加）。运行时空体只会在点「运行」
           * 之后报错（run.ts 的「循环里没有节点」），而用户要的是**一眼看见**：
           * 空循环是个坏状态，不该看起来和正常循环一样。
           *
           * ⚠️ 判据用 `data.bodyEmpty`（画布按 `parentId` 数出来的），
           * **不能**用 `showSettings` 或尺寸猜 —— 成员是 React Flow 平铺画的，
           * 从来不在框的 DOM 里（见 loop-box 测试里那条「假绿」的教训）。 */}
          <div className={css_card.loopEmptyHint + (data.bodyEmpty === true ? ' ' + css_card.loopEmptyWarn : '')}>
            {data.bodyEmpty === true ? '这个循环是空的 —— 把要重复的节点拖进来' : '把要重复的节点拖进来'}
          </div>
        </div>
      )}
    </div>
  )
})
