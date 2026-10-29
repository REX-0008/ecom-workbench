/** 节点定义（纯数据：不 import 任何 Node 内置模块，客户端与宿主半共用这一份）。
 *
 * 一个节点一个目录 —— 见 `plans/2026-10-08-板块范式与目录规划.md` §2 与总纲「节点化」条。
 * 注册表在 `src/nodes/index.ts` 集中维护（加节点要在这里补一行，原因见那里的说明）。
 */
import type { NodeDef } from '../../../workflow/model.ts'

export const NODE: NodeDef = {
  id: 'flow.loop',
  category: 'flow',
  label: '循环',
  summary: '把循环体里的节点重复跑 N 轮',
  executor: 'builtin',
  /**
   * ## 端口：**有**（`in` / `done`）—— 2026-10-17 用户定案「补实」
   *
   * ### 历史（别只看结论，这段走过一个来回）
   *
   * 2026-10-13 曾**删掉**这两个端口，理由是「照 Dify 的零 Handle」：
   *   - n8n 的循环不是容器（一条回边 + 一个 IF），本来就没有容器端口；
   *   - Dify 的迭代节点是容器，但是**零 Handle**，进出全走参数
   *     （`iterator_selector` / `output_selector`）。
   * 于是当时把「数据从哪来」改由 `items` 参数指定。
   *
   * **但那次只改了定义与文档，前端与存档没跟着改**：
   *   - `LoopNode.tsx` 一直画着 `<Handle id="in">` 与 `<Handle id="done">`；
   *   - 生成的存档里，边真的接在这两个口上（`targetHandle: "in"`）。
   * 也就是说界面在承诺一件定义里不存在的事（见 `pitfalls/假防线-看着写了其实不生效.md`）。
   *
   * 2026-10-17 用户定案：**补实**（把定义改成真有这两个端口），
   * 理由：循环在一条链里的**位置**（接在谁后面、跑完交给谁）本来就是真实语义，
   * 界面上看得见、说得清，比藏在参数里更好用。
   *
   * ### 补实之后的取值规则
   *
   * - **参数优先**：填了「遍历哪个数据」（`items`，选节点 + 选字段）就用它；
   * - 没填才用**入边**那份数据（只连线、不填参数也能喂数据）；
   * - 两条都没有 → `mode: 'items'` 时明确报错（由 `iterationItems` 说清），不静默跑 0 轮。
   *
   * ⚠️⚠️ **为什么是「参数优先」**（一开始写成「入边优先」，被测试打回来了）：
   * 已有工作流（生成器产的）**全都「连了线 + 填了参数」**，而那条边同时承担
   * 「顺序依赖」。入边优先取到的是**整份输出对象**，而参数取的是**指定字段**
   * （如 `modules`）—— 前者不是数组，循环当场报「选到的不是一个列表」。
   * 参数更精确，所以让它赢。运行时记一条日志说明用了哪条，免得用户猜。
   */
  inputs: [{ id: 'in', label: '输入', type: 'any' }],
  outputs: [{ id: 'done', label: '输出', type: 'any' }],
  onError: 'stop',
  params: { mode: 'items', items: null, result: null, count: 5, maxIters: 100, concurrency: 1, breakConditions: [], breakLogic: 'and', maxConsecutiveFailures: 0 },
  detail: {
    what: '把循环体里的节点重复跑 N 轮（逐条遍历一个数组，或固定重复几次），'
      + '跑完给出每轮的结果总表。',
    inputs: '要遍历的数据有两处来源，填了参数就用参数，没填才用连线：'
      + '① 用「遍历哪个数据」指定（选节点 + 选字段，更精确）；'
      + '② 没指定时，把上游节点连到循环的入口也管用。'
      + '两条都没有会明确报错，不会静默跑 0 轮。选「固定重复几次」时两处都不需要。',
    outputs: '循环的出口把结果交给下游；本轮的结果取体内哪个节点，'
      + '用「结果取哪个」指定（不选则给每轮的完整结果）。',
    whenToUse: '对一批数据逐条处理；把某个动作重复 N 次（如逐日补数）。',
    cautions: '循环体是把节点放进循环框里（从节点库拖进去，或用右键菜单「放入循环」），'
      + '不是连回边 —— 框的边界由程序自动处理。'
      + '循环体里可以用 `{{item}}` 取本轮数据、`{{index}}` 取第几轮。\n'
      + '关于连线（容易误解，说清四条）：'
      + '① 循环外的节点「可以直接连循环里的节点」—— 那条线是「显式上游」，'
      + '体内节点能读到外层的输出；'
      + '② 循环里的节点可以连到框外的节点，下游照常拿到本轮结果；'
      + '③ 循环节点自己不接上游也能跑（数据从参数来），'
      + '但接了上游就按那条线的先后顺序执行；'
      + '④ 连线的合法性检查只管「不能自己连自己 / 不能成环 / 一个入口一条线 / 类型要配」，'
      + '不限制跨容器连线 —— 跨进跨出都是允许的。\n'
      + '循环里可以再放循环（上限 5 层）。嵌套时写法是：'
      + '`{{item}}` / `{{index}}` 取最内层本轮的值，'
      + '`{{outer.item}}` / `{{outer.index}}` 取往外一层那份，'
      + '`{{outer.outer.item}}` 再往外一层，依此类推。'
      + '内层循环的输出会交到外层那一轮的结果里 —— 外层用它自己的「结果取哪个」去收。',
  },
  paramDefs: [
    { key: 'mode', label: '循环方式', kind: 'select', default: 'items', options: [
      { value: 'items', label: '逐条遍历数组', description: '如逐个处理 20 个商品' },
      { value: 'count', label: '固定重复几次', description: '如重试 3 次' },
    ], hint: '上游给出一批数据时选第一种；仅需重复某动作 N 次时选第二种。' },
    { key: 'items', label: '遍历哪个数据', kind: 'nodeField',
      showWhen: { key: 'mode', equals: ['items'] },
      hint: '先选节点、再选它的输出字段（照 Dify 的做法）。选到的必须是一个数组或列表，'
        + '循环会逐条取出来跑；取到的不是列表时会明确报错，不会静默当成一条。'
        + '⚠️ 这一项比入口连线优先 —— 选了它，入口那条线只表示先后顺序、不提供数据。' },
    { key: 'count', label: '重复几次', kind: 'number', default: 5, unit: '次', min: 1,
      showWhen: { key: 'mode', equals: ['count'] },
      hint: '要重复的次数。' },
    { key: 'result', label: '结果取哪个', kind: 'nodeField', advanced: true,
      hint: '不选：输出每轮的完整结果（照 n8n 的 `done` 出口 —— 把所有轮合并）。'
        + '选了：只取该节点的这一项，逐轮组成数组（照 Dify 的 `output_selector`）。'
        + '如循环里跑一个「下载」节点、只想要它的文件路径，就选它。' },
    { key: 'maxIters', label: '最大轮数', kind: 'number', default: 100, unit: '轮', min: 1, advanced: true,
      hint: '防止无限跑的安全上限。默认 100 轮，超出的部分不跑，并在日志里说明（不会静默截断）。数据量大时调大。' },
    { key: 'concurrency', label: '同时处理几条', kind: 'number', default: 1, unit: '条', min: 1, max: 10, advanced: true,
      hint: '1 = 一轮一轮按顺序跑（默认）。大于 1 时同时跑几条 —— '
        + '结果顺序与串行完全一致（按轮次下标回填，不按完成先后）。'
        + '⚠️ 采集类循环体不建议调大：同一个浏览器上并发操作同一个页面会互相踩。' },
    /* ── 条件跳出（2026-10-19，照 Dify 的 `break_conditions`）───────────────
     *
     * 用户要的那个真实场景：「连续 2 天失败就停这个模块」。
     * 形状与「条件判断」节点**完全一样**（同一个 `ifRules` 控件、同一批比较符、
     * 同一套左边来源）—— 照 Dify「与 if-else 同一个 Condition 类型」。
     *
     * 三条要在界面上说清的（`hint` 里都写了，不许静默）：
     *   ① 成立就**停这个循环**（不是停整个工作流、也不是失败）；
     *   ② 已经跑完的轮次结果**照常给出**；
     *   ③ 每层各判各的（内层跳出不影响外层）。
     *
     * ⚠️ **必须在这个面板里渲染**：循环节点的参数不走 `NodeEditorBody`
     * （`V1NodeCard` 对循环节点提前返回），见 `LoopNode.tsx` 那段长注释。
     * 只加 `paramDefs` 而不在 `LoopNode.tsx` 补控件，等于「定义里有、界面上没有」——
     * 「遍历哪个数据」「同时处理几条」都踩过这个坑。 */
    { key: 'breakConditions', label: '跳出条件', kind: 'ifRules',
      hint: '这些条件成立就停止这个循环（不是报错，也不是停整个工作流）。'
        + '不填 = 一直跑到底。左边可以选循环变量（item / index）、体内节点的输出、开始节点的输入。'
        + '典型用法：「连续 2 天失败就停这个模块」—— 用体内节点的成败字段配「等于 假」。' },
    { key: 'breakLogic', label: '多条跳出条件怎么算成立', kind: 'select', default: 'and',
      options: [
        { value: 'and', label: '全部满足', description: '有一条不成立就继续跑' },
        { value: 'or', label: '满足任一', description: '任意一条成立就停' },
      ],
      hint: '只有一条条件时这一项不起作用。' },
    /* ── 连续失败跳出（2026-10-19，照源码 `douyin-ui.ts` 的 `consecutiveFails`）──
     *
     * 源码原样：
     * ```ts
     * let consecutiveFails = 0;
     * for (...) { try { ... } catch { consecutiveFails++; if (consecutiveFails >= 2) { 停这个模块 } } }
     * ```
     *
     * ⚠️ **与上面「跳出条件」是两件事**（任务书明确要求别混成一个参数）：
     *   · `breakConditions` —— 按你写的**条件**跳出；
     *   · `maxConsecutiveFailures` —— 按**失败次数自动**跳出。
     * 两个都配时谁先命中谁生效。
     *
     * ⚠️ **默认 0 = 不启用**（老存档行为一字不变）。 */
    { key: 'maxConsecutiveFailures', label: '连续失败几轮就停', kind: 'number', default: 0, unit: '轮', min: 0,
      advanced: true,
      hint: '0 = 不启用（默认，一直跑到底）。设成 2 就是「连续 2 轮有节点失败就停这个循环」——'
        + '成功一轮就清零。停下不算报错，已跑完的轮次结果照常给出，'
        + '被跳过的轮次会记在输出的 skippedRounds 里（说明「因连续失败被跳过」）。'
        + '与上面的「跳出条件」互不相干，可以同时配。' },
  ],
}
