/** 生成**组合层**工作流：把几份已经能单独跑的工作流按顺序串起来。
 *
 * ## 对应源码里那几个 bat（逐字读出，都是纯转发、零逻辑）
 *
 * | bat | 顺序 |
 * | --- | --- |
 * | `一键下载.bat`   | `call 下载抖音.bat` → `call 下载天猫.bat`（**抖音先**） |
 * | `全部下载.bat`   | `call 下载天猫.bat` → `call 下载抖音.bat`（**天猫先**，与上一条相反） |
 * | `0一键更新.bat` | `call 一键下载.bat` → `call 清洗入库.bat` |
 *
 * 「一键下载」与「全部下载」成员完全一样、只是顺序相反 —— 源码里就是这样
 * （`plans/2026-10-13-脚本拆分核验.md:37` 也记了这一点）。
 *
 * ## 2026-10-22 合并：两份并成一份，改成按「平台」分支
 *
 * 用户决定：**删掉「一键下载」，只留一份**，由开始节点的 `平台` 参数选跑哪一份。
 *   · `平台 = 全部`（默认）→ 天猫 → 抖音（顺序沿用「全部下载」，天猫在前）
 *   · `平台 = 天猫` → 只跑天猫
 *   · `平台 = 抖音` → 只跑抖音
 *
 * 分流用**两个 `flow.if`**（这个节点只有「成立 / 不成立」两个出口，三选一必须串两层）：
 *
 * ```
 * ⓪ 开始 → ① 平台不为抖音？─成立→ ② 天猫 ─┐
 *                  └─不成立──────┐        │
 *                                └→ ③ 平台不为天猫？─成立→ ④ 抖音 → ⑨ 结束
 *                                              └─不成立（平台=天猫）→ ⑨ 结束
 * ```
 *
 * ⚠️ 条件为什么写「**不为**某平台」而不是「是其中之一 天猫,全部」：
 * 正向写法下，没填 / 填了不认识的值两边都不成立 → 一份都不跑，**且不报错**
 * （看着就是「跑完了，什么都没做」）。反向写法把兜底落在「跑」上，
 * 与开始节点说明里写的「留空按全部」一致。
 *
 * 为什么**不复制节点**（天猫 / 抖音各放两份、每支一份）：那样一次运行里会有
 * 两份同内容节点，面板上看不出哪份这次没跑；而共用的做法里「没走的那支」由
 * 调度器按可达性跳过（`branch.ts` 的约定），一眼能看懂。
 *
 * ⚠️ **不接 `flow.parallel`**：三支最后汇到同一个「结束」节点是普通连线
 * （多个上游 → 一个下游，现有存档里到处都有），不属于并行的跨路汇合限制。
 *
 * ## 为什么用「跑另一份工作流」节点而不是连一条边
 *
 * 连一条边确实能定顺序，但实测**会传数据**（下游收到上游的 `out:A`），
 * 而 bat 的 `call` 是**纯顺序、两份之间没有任何数据流**。
 * 让数据串过去会让下游的 `input` 变成一份它并不认识的东西 —— 语义不对。
 * 所以照 n8n 的 Execute Sub-workflow：用专门节点，数据不串。
 *
 * ⚠️ 组合层都是**零逻辑外壳** —— 真正干活的是被调的那几份工作流。
 * 用户对这个节点的期望正是「执行流程监控，就是我在 bat 中看到的」。
 */
import { join } from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
/* 子工作流的**稳定编号**：引用用它，不写名字（用户 2026-10-19：
 * 「引用用的应该是编号而不是名称」）。规则与运行时同一份 —— 见 `ids.ts` 文件头。 */
import { deriveWorkflowId } from '../../src/workflow/ids.ts'

/** 平台参数的取值（与开始节点「输入项」里写的那三个逐字一致）。 */
export const PLATFORMS = { all: '全部', tmall: '天猫', douyin: '抖音' }

/**
 * 组合层「开始」节点声明的可选参数（天猫 / 抖音两份自己决定用不用）。
 *
 * `平台` 排第一：它决定这次跑几份，比另外三项更常改。
 * 格式照开始节点的 `list` 控件：`名字 | 说明 | 是否必填 | 默认值`。
 */
const START_FIELDS = [
  '平台 | 选择本次执行的平台：全部 / 天猫 / 抖音；留空按全部 | 选填 | ' + PLATFORMS.all,
  'modules | 要跑哪些模块（只对抖音那份有效），留空 = 全部 | 选填 | ',
  'from | 从哪天开始（只对抖音那份有效），留空 = 自动推算 | 选填 | ',
  'to | 到哪天结束（只对抖音那份有效），留空 = 自动推算 | 选填 | ',
]

/** 开始节点备注。 */
const START_NOTE = '「平台」决定本次执行哪几份子工作流，默认全部。'
  + 'modules / from / to 原样透传给子工作流，由各子工作流取用自己声明过的项。'

/**
 * 造一条「开始节点的「平台」不是某个平台」的条件（`notIn` 比较符）。
 *
 * ## 为什么用「不是」而不是「是其中之一」
 *
 * 用正向写法（`平台 是其中之一 天猫,全部`）时，**没填 / 填了不认识的值**
 * 两边都不成立 → 一份子工作流都不跑，而且**不报错**（看着就是「跑完了，什么都没做」）。
 * 反向写法把兜底落在「跑」上：没填、填空、填错名字都按默认的「全部」处理，
 * 与开始节点里写的「留空按全部」一致。
 *
 * @param name - 该分支要排除的平台名。
 * @returns `flow.if` 的一条条件。
 */
function platformNot(name) {
  return {
    left: { kind: 'input', name: '平台' },
    op: 'notIn',
    value: name,
  }
}

/**
 * 建「全部下载」：按开始节点的 `平台` 参数分流，跑天猫取数与抖音取数。
 *
 * @param Builder - `build-patrol-workflows.mjs` 里的那个类（与其它生成器共用）。
 * @param opts.name - 存档名（也是文件名）。
 * @param opts.description - 工作流列表里的说明。
 * @param opts.tmall - 天猫那份的子工作流名（编号由它派生）。
 * @param opts.douyin - 抖音那份的子工作流名（编号由它派生）。
 * @returns 存档对象。
 */
export function buildPlatformCombine(Builder, opts) {
  const b = new Builder(opts.name, '')
  const X = 60
  const XB = 380
  const Y = 40
  const STEP = 220

  const start = b.add('flow.start', { type: 'manual', fields: START_FIELDS },
    '⓪ 开始：选择平台与可选参数', X, Y - 220, 'stop', START_NOTE)

  /* ① 「要不要跑天猫」—— 只要平台不是「抖音」就跑天猫。
   * 这样就覆盖了「天猫」与「全部」，也把「没填 / 填了不认识的值」兜在「跑」这一侧。 */
  const askTmall = b.add('flow.if', {
    conditions: [platformNot(PLATFORMS.douyin)],
    logic: 'and',
    expr: '',
  }, '① 判断是否执行天猫取数（平台不为抖音）', X, Y, 'stop',
    '平台为天猫或全部时执行②；为抖音时不执行②，直接到③判断抖音。')

  const tmall = b.add('flow.workflow', { workflowId: deriveWorkflowId(opts.tmall) },
    '② 跑「' + opts.tmall + '」', X, Y + STEP, 'stop',
    '平台为天猫或全部时执行。平台为全部时这一份在前。')

  /* ③ 「要不要跑抖音」—— 只要平台不是「天猫」就跑抖音。
   * 两个入口：①的「不成立」（平台=抖音，天猫没跑）与②跑完之后（平台=全部或天猫）。 */
  const askDouyin = b.add('flow.if', {
    conditions: [platformNot(PLATFORMS.tmall)],
    logic: 'and',
    expr: '',
  }, '③ 判断是否执行抖音取数（平台不为天猫）', XB, Y + STEP * 2, 'stop',
    '平台为抖音或全部时执行④；为天猫时不执行④，直接到⑨结束。')

  const douyin = b.add('flow.workflow', { workflowId: deriveWorkflowId(opts.douyin) },
    '④ 跑「' + opts.douyin + '」', XB, Y + STEP * 3, 'stop',
    '平台为抖音或全部时执行。全部时在天猫之后执行。')

  /* ⑨ 结束 —— **2026-10-25 去掉**。
   *
   * 原来这里是一个 `flow.end`，把三支汇到同一个节点（普通连线，不是并行汇合），
   * 逐份声明 { workflow, ok, ran }。用户 2026-10-25 决定**存档里不再有结束节点**。
   *
   * ⚠️ 节点定义（`src/nodes/flow/end/node.ts`）原样保留在节点库里。
   *
   * ## 去掉之后图长什么样
   *
   * 原来「③ 判断抖音」的**不成立**出口（平台=天猫）是接到结束节点的。
   * 现在没有结束节点了，那条出口就**到此为止** —— 这正好是 `flow.if` 的既定语义
   * （它自己的注意事项写着「没接的那条路会断在这里（流程到此结束）」），
   * 不是漏接。所以那两条边一起删掉，不另外找个节点来接。
   *
   * 连通性不受影响：从开始节点出发仍能走到 ①②③④ 每一个（只是有两支提前收尾）。
   *
   * 代价说清楚：这份组合层不再有对外声明的产出。它本来也只交「哪一份跑成了」，
   * 而那件事在运行记录里逐节点看得见。 */

  b.link(start, askTmall)
  b.link(askTmall, tmall, 'true')
  b.link(askTmall, askDouyin, 'false')
  b.link(tmall, askDouyin)
  b.link(askDouyin, douyin, 'true')

  const doc = b.doc()
  doc.description = opts.description
  return doc
}

/**
 * 建一份**线性**组合层工作流（一串子工作流按顺序跑）。
 *
 * ## ⚠️ 2026-10-19：引用从「名字」改成「编号」
 *
 * 以前这里写 `{ name: '天猫取数' }` —— 于是子工作流一改名，组合层就跑不动了
 * （实测：「取数-抖音电商罗盘」改名后，组合层还写着旧名字）。
 * 现在写 `{ workflowId: deriveWorkflowId('天猫取数') }`：编号永不变。
 *
 * @param Builder - `build-patrol-workflows.mjs` 里的那个类。
 * @param opts.name - 这份工作流的名字（也是存档文件名）。
 * @param opts.description - 显示在工作流列表里的说明。
 * @param opts.steps - 要串起来的子工作流**名**（按执行顺序；编号由它派生）。
 * @returns 存档对象。
 */
export function buildCombine(Builder, opts) {
  const b = new Builder(opts.name, '')
  const X = 60
  const Y = 140
  const STEP = 220

  /* ── ⓪ 开始（2026-10-19 加：让子工作流的参数能从组合层透下去）──────────
   *
   * ## 为什么组合层也要一个开始节点
   *
   * 「跑另一份工作流」节点有个既定行为（`run.ts` 的 `runSubWorkflow`）：
   * **节点的 inputs 一项都不填时，把本层这次拿到的输入原样带下去**。
   * 而「本层拿到的输入」来自**本层自己的开始节点** —— 组合层没有开始节点，
   * 那个值就永远是空对象，于是跑抖音时**一个参数都传不进去**。
   *
   * 用户 2026-10-19 要的就是「我要能说只跑某几个模块」。
   * 少这个开始节点，那条需求在组合层上根本做不到（不是难用，是做不到），
   * 而且**不报错**：参数被静默丢掉。
   *
   * ⚠️ 这不是「把抖音的参数硬塞给天猫」，而是「组合层声明它接受的参数，
   * 然后整条链透传」—— 哪份用得上由那份自己决定。 */
  const start = b.add('flow.start', { type: 'manual', fields: START_FIELDS.slice(1) },
    '⓪ 开始：可选参数（会透传给子工作流）', X, Y - 160, 'stop',
    '三项都选填。这里填的值会原样透传给下面每一份子工作流；'
    + '哪一份用得上由它自己决定（天猫那份没有这些参数，会自动忽略）。')

  let prev = start
  opts.steps.forEach((step, i) => {
    const n = b.add(
      'flow.workflow',
      { workflowId: deriveWorkflowId(step.name) },
      String(i + 1) + '. 跑「' + step.name + '」',
      X,
      Y + i * STEP,
      'stop',
      step.note,
    )
    /* 纯顺序：前一个跑完才跑下一个（与 bat 里一行一个 `call` 一模一样）。
     * 第一个接在「开始」后面 —— 这既定了顺序，也让开始节点不是孤点。 */
    b.link(prev, n)
    prev = n
  })

  /* ── ⑨ 结束（2026-10-21 加，**2026-10-25 去掉**）──────────────────────
   *
   * 原来这里是一个 `flow.end`，逐份声明 { workflow, ok, ran } ——
   * 组合层自己不干活，产出就是「每份子工作流跑没跑成」。
   *
   * 用户 2026-10-25 决定**存档里不再有结束节点**，所以节点与那条边都不建了，
   * 最后一个「跑另一份工作流」节点就是这条链的尾。
   *
   * ⚠️ 节点定义（`src/nodes/flow/end/node.ts`）原样保留在节点库里。
   *
   * 代价说清楚：这份组合层不再有对外声明的产出。而它本来也只交
   * 「哪一份跑成了」，那件事在运行记录里逐节点看得见。 */

  const doc = b.doc()
  doc.description = opts.description
  return doc
}

/**
 * 建「提示词优化」：把一段提示词按给定模板的风格改写一遍。
 *
 * ## 它为什么也放这个文件
 *
 * 它不调用别的子工作流，所以严格说不是「组合层」。放这里只是因为它与组合层
 * **同属「几个现成节点串起来、零业务逻辑」的那一类**，且与本文件的
 * `combineDocs` / `writeCombine` 共用同一套落盘路径 —— 另开一个生成器
 * 要多一份「输出目录 + 写盘」的重复代码。
 *
 * ## 结构（三个节点，没有分支）
 *
 * ```
 * ⓪ 开始（模板正文 / 待优化的提示词）
 *   → ① AI 生成（ai.agent）
 *   → ② 结束（交出「改写结果」）
 * ```
 *
 * ## ⚠️ `prompt` 与 `input` 的分工（这是本份唯一的设计选择）
 *
 * `ai.agent` 的执行层会把两段拼成**一条**用户消息（`src/index.ts` 的
 * `createLlmDelegate`）：
 *
 * ```
 * <prompt 原文>
 *
 * 参考资料：
 * <input 原文>
 * ```
 *
 * 所以分工按「**哪段是规矩、哪段是材料**」来切：
 *   · `prompt` = 任务说明 + 模板正文 —— 规矩（照什么风格改）
 *   · `input`  = 待优化的提示词 —— 材料（要改的那段）
 *
 * 反过来（`prompt` 只放模板正文）不行的原因：模板正文往往只是一段范文，
 * 模型拿到一段范文加一段材料，**不知道要拿材料干什么** —— 可能照模板另写一段，
 * 也可能只做格式对齐。任务说明必须写在 `prompt` 里。
 *
 * 而把待优化的提示词也塞进 `prompt`、`input` 留空的写法更差：`input` 是
 * 这个节点专门留给「材料」的入口，空着等于把两段内容挤在一处，
 * 节点设置里看不出边界，改的时候容易只改一半。
 *
 * @param Builder - 生成器类。
 * @param opts - 见 `combineDocs`。
 * @returns 存档对象。
 */
export function buildPromptOptimize(Builder, opts) {
  const b = new Builder(opts.name, '')
  const X = 60
  const Y = 40
  const STEP = 220

  /* ⓪ 开始：两项都必填 —— 缺任何一项这次改写都没有意义
   * （没模板 = 没有风格可依，没原文 = 没有东西可改）。
   * 界面按 `required` 拦，所以不会「跑了但什么都没做」。 */
  const start = b.add('flow.start', {
    type: 'manual',
    fields: [
      '模板正文 | 要照这个模板的风格改写：把模板全文粘进来（可以是一段范例，也可以是带占位符的骨架）| 必填 | ',
      '待优化的提示词 | 需要按模板改写的那段提示词，原样粘进来即可 | 必填 | ',
    ],
  }, '⓪ 开始：模板正文与待优化的提示词', X, Y, 'stop',
    '两项都必填。模板正文决定改成什么风格，待优化的提示词是要改的那段。'
    + '两项都在下游用 {{名字}} 取用。')

  /* ★ `prompt` 里显式点出「参考资料里那段」—— 因为执行层给 `input` 加的小标题
   * 就是「参考资料」，两处用同一个词，模型才分得清哪段是材料。
   * ⚠️ 这句话里不要出现第二人称与问号（R6）。 */
  const agent = b.add('ai.agent', {
    prompt: '按下面这段模板的风格，改写「参考资料」里给出的提示词。\n\n'
      + '改写要求：保留原意与原文里已有的具体信息（店铺名、数量、时间范围等一律不改）；'
      + '只调整结构、措辞与颗粒度，使写法符合模板。\n'
      + '只输出改写后的提示词本身，不要解释、不要加前后缀说明。\n\n'
      + '模板正文：\n{{模板正文}}',
    input: '{{待优化的提示词}}',
    timeout: 120000,
  }, '① AI 生成：按模板改写提示词', X, Y + STEP, 'stop',
    '把模板正文与待优化的提示词一起交给模型，拿回改写结果。'
    + '用的是 dsh 里配好的模型通道：不带系统提示词、不提供工具。')

  /* ① 结束 —— **2026-10-25 去掉**。
   *
   * 原来这里是一个 `flow.end`，声明「改写结果 = ①」。
   * 用户 2026-10-25 决定**存档里不再有结束节点**，所以节点与那条边都不建了，
   * ① AI 生成 就是这条链的尾。
   *
   * ⚠️ 节点定义（`src/nodes/flow/end/node.ts`）原样保留在节点库里。
   *
   * ⚠️⚠️ **这一份的代价与另外 12 份不同，要知道**：
   * 另外那些的「产出」只是给人看（结果同时也落在文件里），去掉只是少一层便利；
   * 而这一份的产出是**唯一**的产物 —— 模型返回的文字在 `ai.agent` 节点的
   * 输出上（`out`），原来靠结束节点把它命名成「改写结果」交出去。
   * 去掉之后，读结果的人得直接读 `ai.agent` 那个节点的输出，
   * 不能再按「产出名」找。 */
  b.link(start, agent)

  const doc = b.doc()
  doc.description = opts.description
  return doc
}

/**
 * 组合层工作流的定义（2026-10-22 起两份：全部下载 / 0一键更新；
 * 2026-10-23 多一份「提示词优化」—— 它不是组合层，见 `buildPromptOptimize` 的说明）。
 *
 * 这里写的 `name` 只是**派生编号用的种子**，不是存档里的参数值 ——
 * 所以它必须与那份工作流**生成时用的名字逐字一致**
 * （生成器给「取数-天猫生意参谋.json」写的 `name` 仍是「天猫取数」，
 *  编号就是按「天猫取数」算的；这里也按「天猫取数」算才对得上）。
 *
 * ⚠️ 对不上的后果是运行时明确报「没有编号为 wf-xxx 的工作流」——
 * 故意做的可读报错，不是静默失败。
 */
export function combineDocs(Builder) {
  return [
    buildPlatformCombine(Builder, {
      name: '全部下载',
      description: '组合层：按「平台」执行天猫取数与抖音取数（全部 / 天猫 / 抖音，默认全部）。本身不干活，只按顺序调用子工作流。',
      tmall: '取数-天猫生意参谋',
      douyin: '取数-抖音电商罗盘',
    }),
    buildCombine(Builder, {
      name: '0一键更新',
      description: '组合层：全部下载（天猫+抖音）之后接着清洗入库（照 0一键更新.bat）。一条链跑完就是「更新」。',
      steps: [
        /* ⚠️ 2026-10-22：原来这里调的是「一键下载」，那份已按要求删除 ——
         * 不改成「全部下载」的话，这条链跑到第一份就报「没有这份工作流」。
         * 合并后的「全部下载」默认「平台=全部」，行为与原来的「一键下载」等价。 */
        { name: '全部下载', note: '它自己也是一份组合层工作流 —— 所以这里是三层嵌套（0一键更新 → 全部下载 → 天猫/抖音）。' },
        { name: '清洗入库', note: '对应 清洗入库.bat（ingest.ts + sync_superset.ts）：把刚下下来的 Excel 清洗进库。' },
      ],
    }),
    buildPromptOptimize(Builder, {
      name: '提示词优化',
      description: '给一段提示词与一份模板，按模板的风格把提示词改写一遍。提示词板块第二步用它调模型。',
    }),
  ]
}

/**
 * 落盘组合层工作流。
 *
 * @param Builder - 生成器类。
 * @param opts.outDir - 输出目录（工作流存档目录）。
 * @param opts.write - 写文件的能力（`writeFileSync`，测试可替身）。
 * @param opts.remove - 2026-10-22 起要**删掉**的旧存档文件名（合并掉的「一键下载」）。
 *   由生成器负责清场：手删的话下次重生成又会回来。
 * @returns 写好的存档对象数组。
 */
export function writeCombine(Builder, opts) {
  const docs = combineDocs(Builder)
  for (const doc of docs) {
    opts.write(join(opts.outDir, doc.name + '.json'), JSON.stringify(doc, null, 2))
  }
  for (const name of opts.remove ?? []) {
    const p = join(opts.outDir, name)
    if (existsSync(p)) unlinkSync(p)
  }
  return docs
}
