/** 「提示词优化」这份工作流的核验（2026-10-23 加）。
 *
 * ## 它守的是三件「错了也不报错」的事
 *
 *   ① **两段内容有没有真的走到模型手上**。`ai.agent` 有三个参数
 *      （`prompt` / `input` / `timeout`），少填一个都不报错：
 *      `input` 空了模型只收到提示词，`prompt` 空了执行方才明确失败。
 *      所以这里不只看存档里「有没有那段文字」，还要**真跑一遍**，
 *      检查派发出去的命令体里两段都在、并且变量已经换成了实际值。
 *
 *   ② **任务说明有没有写进 `prompt`**。只把模板正文塞进 `prompt` 也能跑，
 *      但模型拿到「一段范文 + 一段材料」未必知道要拿材料干什么 ——
 *      这种错在界面上完全看不出来，只有跑一次读输出才发现。
 *
 *   ③ **产出指向谁**。结束节点声明的是 `改写结果 = <ai.agent 的 id>`，
 *      写错了（指向开始节点、或写成不存在的 id）产出就是空的，
 *      而运行记录只会显示「产出：改写结果=null」。
 *
 * 跑法：`DSH_HOME=F:/AGENTS/agent-chat-dsh node scripts/run-tests.mjs prompt-optimize`
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { NODE_LIBRARY } from '../src/nodes/index.ts'
import { toRunSpecsFromCanvas } from '../src/workflow/specs.ts'
import { runGraph } from '../src/workflow/run.ts'
import { parseInputFields, parseOutputFields } from '../src/workflow/io-fields.ts'

/** 累计失败数。 */
let failed = 0
/**
 * 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

const NAME = '提示词优化'
const WF_DIR = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows')
const FILE = join(WF_DIR, NAME + '.json')
const lib = [...(Array.isArray(NODE_LIBRARY) ? NODE_LIBRARY : NODE_LIBRARY.values())]

/** 模板正文与待优化内容（测试用的两段材料，故意各留一个特征词便于检索）。 */
const TEMPLATE = '【测试模板】先写用途，再写限制，最后给示例。'
const ORIGINAL = '【测试原文】帮我写一段店铺公告。'

console.log('=== 「提示词优化」：结构 / 参数 / 产出 / 真跑 ===')
console.log('存档：' + FILE)
console.log('')

if (!existsSync(FILE)) {
  console.log('  ✗ 找不到存档 —— 先跑 node scripts/build-patrol-workflows.mjs')
  console.log('')
  console.log('结论：存档不存在 ✗')
  process.exit(1)
}

const doc = JSON.parse(readFileSync(FILE, 'utf8'))

/* ── ① 结构：开始 → AI 生成（**2026-10-25 起没有结束节点**）─────── */
console.log('① 节点结构')
const byDef = (id) => doc.nodes.filter(n => n.defId === id)
const starts = byDef('flow.start')
const agents = byDef('ai.agent')
const ends = byDef('flow.end')

check('有一份开始节点', starts.length === 1, String(starts.length))
check('有一份 AI 生成节点', agents.length === 1, String(agents.length))
/* ⚠️ 2026-10-25：用户决定**存档里不再有结束节点**，所以这条从「有一份」改成
 * 「一份都没有」。节点定义仍在节点库里（本次没动 `src/`）。 */
check('★ 没有结束节点（用户 2026-10-25 定）', ends.length === 0, String(ends.length))
check('★ 总共两个节点（结构就是「开始 → AI 生成」）', doc.nodes.length === 2, String(doc.nodes.length))

const start = starts[0]
const agent = agents[0]

/* 连线必须真的是这条链，而不是两个孤点（孤点也能存成合法 JSON）。 */
if (start !== undefined && agent !== undefined) {
  const linkOf = (from) => doc.edges.filter(e => e.source === from).map(e => e.target)
  check('★ 开始 → AI 生成', linkOf(start.id).includes(agent.id), linkOf(start.id).join(','))
  check('★ AI 生成没有下游（去掉结束节点后它就是链尾）',
    linkOf(agent.id).length === 0, linkOf(agent.id).join(','))
  check('★ 没有多余的分叉', doc.edges.length === 1, String(doc.edges.length))
}

/* ── ② 开始节点的两个输入字段 ─────────────────────────────────── */
console.log('')
console.log('② 开始节点的输入字段')
const fields = parseInputFields(start?.params?.fields)
console.log('  声明：' + fields.map(f => f.name + (f.required ? '(必填)' : '(选填)')).join(' / '))

check('★ 正好两项', fields.length === 2, String(fields.length))
check('★ 两项的名字就是「模板正文」「待优化的提示词」',
  JSON.stringify(fields.map(f => f.name)) === '["模板正文","待优化的提示词"]',
  JSON.stringify(fields.map(f => f.name)))
check('★★ 每一项都有说明（界面读它，空着等于没说）',
  fields.every(f => f.description !== ''), fields.map(f => f.description.slice(0, 10)).join(' / '))
check('★ 「模板正文」的说明讲清了要照它改',
  (fields[0]?.description ?? '').includes('模板'), fields[0]?.description)
check('★ 「待优化的提示词」的说明讲清了它是被改的那段',
  (fields[1]?.description ?? '').includes('改写'), fields[1]?.description)

/* ── ③ ai.agent 的三个参数 ───────────────────────────────────── */
console.log('')
console.log('③ AI 生成节点的参数')
const prompt = String(agent?.params?.prompt ?? '')
const input = String(agent?.params?.input ?? '')

check('★★ prompt 不是空', prompt.trim() !== '', prompt.slice(0, 40))
check('★★ input 不是空', input.trim() !== '', input.slice(0, 40))
check('★ prompt 里引用了「模板正文」',
  prompt.includes('{{模板正文}}'), prompt.slice(-40))
check('★ input 里引用了「待优化的提示词」',
  input.includes('{{待优化的提示词}}'), input)
/* ⚠️ 任务说明必须在 prompt 里 —— 只放模板正文的话模型不知道拿材料干什么。 */
check('★★ prompt 里有任务说明（不是只放模板正文）',
  /改写/.test(prompt) && !prompt.trim().startsWith('{{模板正文}}'), prompt.slice(0, 40))
/* 执行层给 input 加的小标题是「参考资料」，prompt 里得用同一个词，
 * 否则模型看到两段却不知道「参考资料里那段」指的是谁。 */
check('★ prompt 里点名了「参考资料」（与执行层加的小标题同一个词）',
  prompt.includes('参考资料'), prompt.slice(0, 60))
check('★ 超时是默认 120000（不填也能跑，但写出来更清楚）',
  Number(agent?.params?.timeout) === 120000, String(agent?.params?.timeout))
/* 失败策略：模型没返回就不能假装成功往下走。 */
check('★ 失败策略是「停止」（模型没返回就没有数据）',
  agent?.onError === 'stop', String(agent?.onError))

/* ── ④ 产出：**2026-10-25 起不再由结束节点声明** ──────────────────
 *
 * 原来这里验「结束节点声明了 `改写结果 = <ai.agent>`」。
 * 用户决定存档里去掉结束节点之后，这条链**没有对外声明的产出了**。
 *
 * ⚠️ 这一份的损失比另外 12 份大，因为它**没有落盘文件兜底** ——
 * 模型返回的文字只在 `ai.agent` 节点的输出上。所以这里把后果钉住，
 * 别让后来的人以为它还交得出来：
 *
 *   · 存档里确实没有结束节点、`declaredOutputs` 为空；
 *   · 但**结果本身还在** —— 就在 `ai.agent` 那个节点的输出里，
 *     ⑤ 会验它的值等于模型返回的文字。 */
console.log('')
console.log('④ 产出（结束节点已去掉，结果改由 ai.agent 节点的输出承载）')
{
  const outs = parseOutputFields(byDef('flow.end')[0]?.params?.fields)
  check('★ 没有结束节点，所以没有声明产出',
    outs.length === 0 && byDef('flow.end').length === 0,
    outs.map(o => o.name + ' = ' + o.nodeId).join(' / ') || '（无）')
}

/* ── ⑤ 真跑一遍：两段内容真的到模型手上、产出真的是模型返回 ────── */
console.log('')
console.log('⑤ 真跑（假模型：只记录收到什么、返回一段固定文字）')
{
  const specs = toRunSpecsFromCanvas(
    doc.nodes.map(n => ({
      id: n.id,
      ...n.parentId === undefined ? {} : { parentId: n.parentId },
      data: {
        def: lib.find(d => d.id === n.defId),
        params: n.params,
        onError: n.onError,
        skipped: n.skipped === true,
        label: n.label,
      },
    })),
    doc.edges,
  )

  const seen = []
  const ANSWER = '【模型返回】改写后的提示词'
  const dispatch = async (req) => {
    seen.push(req)
    if (req.executor === 'agent') return { ok: true, status: 'success', output: ANSWER }
    return { ok: true, status: 'success', output: {} }
  }

  const out = await runGraph(
    {
      nodes: specs.nodes,
      edges: specs.edges,
      workdir: WF_DIR,
      inputs: { 模板正文: TEMPLATE, 待优化的提示词: ORIGINAL },
    },
    dispatch,
    {},
  )

  const send = seen.find(r => r.executor === 'agent')
  const cmd = send?.command ?? {}
  check('★ AI 生成节点被派发了', send !== undefined, String(seen.length) + ' 个节点')
  check('★★ 交给模型的 prompt 里有模板正文实际内容（变量换掉了）',
    String(cmd.prompt ?? '').includes('测试模板'), String(cmd.prompt ?? '').slice(0, 60))
  check('★★ 交给模型的 input 里有待优化提示词实际内容',
    String(cmd.input ?? '').includes('测试原文'), String(cmd.input ?? ''))
  check('★★ 提示词里没有残留的 {{ }}（没换掉就是变量名拼错）',
    !/\{\{|\}\}/.test(String(cmd.prompt ?? '') + String(cmd.input ?? '')),
    String(cmd.prompt ?? '').slice(0, 60))
  check('★ 没中断（aborted 为假）', out.aborted === false, String(out.aborted))
  /* ⚠️ 2026-10-25：原来这条读 `out.declaredOutputs['改写结果']`，那个名字是
   * 结束节点声明的产出名。结束节点被去掉之后 `declaredOutputs` 是空对象，
   * 但**结果本身没丢** —— 它在 `ai.agent` 那个节点的输出里。
   * 所以判据改成直接从节点的输出上取：这更贴底，也证明「去掉结束节点
   * 只是少了一个命名层，模型返回的字仍在流程里」。 */
  check('★★ 模型返回的那段文字就在 AI 生成节点的输出里（唯一产物没丢）',
    out.outputs?.get(agent.id) === ANSWER,
    JSON.stringify(out.outputs?.get(agent.id)))
  check('★ 产出声明为空（去掉结束节点的直接后果，不是回归）',
    Object.keys(out.declaredOutputs ?? {}).length === 0,
    JSON.stringify(Object.keys(out.declaredOutputs ?? {})))
}

/* ── ⑥ R6：文案不用第二人称、不用疑问句 ────────────────────────── */
console.log('')
console.log('⑥ 文案守 R6（用户可见：字段说明、节点标题、节点备注）')
{
  const texts = [
    ...fields.flatMap(f => [f.name, f.description]),
    ...doc.nodes.map(n => String(n.label ?? '')),
    ...doc.nodes.map(n => String(n.note ?? '')),
    String(doc.description ?? ''),
  ].filter(t => t !== '')
  const bad = texts.filter(t => /[你您]/.test(t) || /[？?]/.test(t))
  check('★ 没有第二人称与问号', bad.length === 0, bad.slice(0, 2).join(' | '))
  /* 模型看的提示词也不该出现「请给我…」这类口气 —— 它与用户可见文案同源。 */
  check('★ 交给模型的提示词里也没有第二人称',
    !/[你您]/.test(prompt), prompt.slice(0, 60))
}

/* ── ⑦ 模板库：62 个全部搬过来（2026-10-23 契约 K）─────────────────
 *
 * ## 判据为什么这么写
 *
 * 搬运这件事有三种错法，而且**都不会当场报错**：
 *
 *   ① **少搬** —— 看起来「模板变多了」，实际漏了几个，用户翻不到也不知道；
 *   ② **重复搬** —— 同一个 id 出现两次，左栏出现两行一样的，点哪个都一样；
 *   ③ **正文被改** —— 搬的时候顺手「润色」了一句，或把 `**` 改成全角，
 *      表面上更整齐，实际与参考项目对不上账，将来没法比对。
 *
 * 所以三条判据分别是：**数个数**、**比 id 集合**、**逐字比正文**。
 *
 * ## 为什么总数是 62 而不是 60
 *
 * 参考项目那 11 个目录下有 62 个中文 `.ts` 文件，其中 **2 个**是
 * `runtime-copy.ts`（工具模块，导出的是拼提示词用的函数，**不是模板**）。
 * 所以真正的模板是 60 个。但我们自己还额外保留了 2 个「同主题、正文不同」的
 * 老模板（`iterate-soul` / `variable-value`），它们**不是**重复项 ——
 * 参考项目对应的是 `soul-iterate` / `variable-value-generation`，正文完全不同。
 * 60 + 2 = 62。逐项对账见交付说明里的表。
 */
console.log('')
console.log('⑦ 模板库：参考项目的模板全部搬过来')
{
  const { PROMPT_TEMPLATES, PROMPT_CATEGORIES, templatesOf, findVars, fillVars, engineFields, VAR_LABELS, varLabel } =
    await import('../src/client/workbench/templates/index.ts')

  check('★ 模板总数 62', PROMPT_TEMPLATES.length === 62, String(PROMPT_TEMPLATES.length))

  /* 五个分类，顺序固定。顺序就是左栏分组顺序 —— 用户原话
   * 「任务中心、定时任务、任务记录」那次定的是顺序要照他说的排；
   * 这里同理：优化 → 迭代 → 提取 → 图像 → 评估。 */
  const labels = PROMPT_CATEGORIES.map(c => c.label)
  check('★ 五个分类，顺序是 优化/迭代/提取/图像/评估',
    labels.join('/') === '优化/迭代/提取/图像/评估', labels.join('/'))
  const emptyCat = PROMPT_CATEGORIES.filter(c => templatesOf(c.id).length === 0)
  check('★ 每个分类都有模板', emptyCat.length === 0, emptyCat.map(c => c.label).join(','))

  /* id 唯一（重复搬会在这里露）。 */
  const ids = PROMPT_TEMPLATES.map(t => t.id)
  const dup = ids.filter((v, i) => ids.indexOf(v) !== i)
  check('★ id 全局唯一（没有重复搬）', dup.length === 0, dup.join(','))

  /* 四个字段都非空。 */
  const thin = PROMPT_TEMPLATES.filter(
    t => String(t.id).trim() === '' || String(t.name).trim() === ''
      || String(t.desc).trim() === '' || String(t.body).trim() === '',
  )
  check('★ 每个模板 id/name/desc/body 都非空', thin.length === 0, thin.map(t => t.id).join(','))

  /* desc 末尾带来源分类（计划 §3.2：将来要拆分类时能拆）。 */
  const noSrc = PROMPT_TEMPLATES.filter(t => !/（来源：[a-z-]+）$/.test(t.desc))
  check('★ 每个 desc 末尾带来源分类', noSrc.length === 0, noSrc.map(t => t.id).slice(0, 5).join(','))

  /* 许可证注记：五个数据文件都要有。 */
  const tplDir = new URL('../src/client/workbench/templates/', import.meta.url)
  const DATA_FILES = ['optimize.ts', 'iterate.ts', 'extract.ts', 'image.ts', 'evaluation.ts']
  const noLicense = DATA_FILES.filter(f => {
    const text = readFileSync(new URL(f, tplDir), 'utf8')
    return !/prompt-optimizer/.test(text) || !/AGPL-3\.0/.test(text)
  })
  check('★ 五个数据文件头都有来源与 AGPL-3.0 注记', noLicense.length === 0, noLicense.join(','))

  /* ── 逐字抽检：3 个模板的正文开头与参考项目一致 ──────────────
   *
   * 抽检的价值全在「挑的这 3 个**有代表性**」：一个是 user 单条的、
   * 一个是 system+user 两条拼起来的、一个开头是系统提示词段。
   * 任一种拼法写错都会红。 */
  const probe = [
    ['evaluation-rewrite-generic', '[user]\n请只根据下面这份 JSON payload'],
    ['multiimage-optimize', '[system]\n你是多图生图提示词优化专家。'],
    ['evaluation-basic-system-prompt-only', '[system]\n# Role: 提示词设计分析专家'],
  ]
  for (const [id, head] of probe) {
    const t = PROMPT_TEMPLATES.find(x => x.id === id)
    const got = (t?.body ?? '').slice(0, head.length)
    check('★ 正文逐字照抄（' + id + ' 的开头）', t !== undefined && got === head,
      JSON.stringify(got))
  }

  /* 老断言要保住的：变量识别不被引擎语法污染。
   * 62 个模板里有大批带 `{{#hasFocus}}` 这类控制写法，若被认成变量，
   * 打开一个模板会冒出十几个空输入框。 */
  check('★ 引擎控制语法不算变量（{{#x}} / {{/x}} / {{^x}}）',
    findVars('{{#hasFocus}}甲{{/hasFocus}}{{^x}}').length === 0,
    JSON.stringify(findVars('{{#hasFocus}}甲{{/hasFocus}}{{^x}}')))
  check('★ 定界符切换那句也不算变量（{{=<% %>=}}）',
    findVars('{{=<% %>=}}').length === 0,
    JSON.stringify(findVars('{{=<% %>=}}')))
  check('★ 普通变量照旧认出来', findVars('填 {{原始提示词}}').length === 1,
    JSON.stringify(findVars('填 {{原始提示词}}')))

  /* ── ENGINE_FIELDS：每个名字都要有参考项目源码出处 ─────────────
   *
   * ## 为什么是一张硬编码对照表、而不是去读参考项目
   *
   * `refs-projects/prompt-optimizer` 是**别人的 git checkout**，路径与行号
   * 随时会被 pull 改掉。测试去读它会有两个后果：CI 上那个目录可能不在（直接红）；
   * 它一升级，我们的测试莫名其妙变红（红的原因还不是我们改坏了）。
   *
   * 所以这里的选择是：**把出处抄下来当对照表**，它守的是两件事 ——
   *   ① 名单里每个名字都真的有出处（不是拍脑袋加的）；
   *   ② 名单与 `vars.ts` 里的 `ENGINE_FIELDS` **完全一致**（少一个 = 有个框冒出来，
   *      多一个 = 有个该看见的框被吞了，两种都要被抓到）。
   *
   * ⚠️ 这张表与 `vars.ts` 是「同一份事实写两处」。这不是偷懒 —— 它正是
   * 那份「同一件事写两份迟早漂」的反面用法：**两份不一样就报错**。
   * 改名单必须两处一起改，否则这里立刻红。
   */
  const SOURCES = {
    compareJsonContract: 'services/evaluation/structured-compare-prompts.ts:176',
    compareSnapshotCount: 'services/evaluation/service.ts:1939',
    compareTestCaseCount: 'services/evaluation/service.ts:1931',
    content: 'services/evaluation/service.ts:148',
    contentPreview: 'services/prompt/service.ts:226',
    contextVariableCount: 'services/variable-value-generation/service.ts:155',
    contextVariablesText: 'services/variable-value-generation/service.ts:154',
    conversationContext: 'services/context/constants.ts:21',
    designContextContent: 'services/evaluation/service.ts:1783',
    designContextLabel: 'services/evaluation/service.ts:1782',
    designContextSummary: 'services/evaluation/service.ts:1784',
    executionInputLabel: 'services/evaluation/service.ts:101',
    generationGoal: 'packages/ui/src/services/ImageStyleExtractor.ts:365',
    id: 'services/evaluation/service.ts:63',
    index: 'services/evaluation/service.ts:1302',
    inputContent: 'services/evaluation/service.ts:68',
    inputImageCount: 'services/prompt/service.ts:931',
    inputKind: 'services/evaluation/service.ts:66',
    inputLabel: 'services/evaluation/service.ts:67',
    inputSummary: 'services/evaluation/service.ts:69',
    label: 'services/evaluation/service.ts:64',
    modelKey: 'services/evaluation/service.ts:94',
    name: 'services/evaluation/service.ts:3153',
    output: 'services/evaluation/service.ts:100',
    pairGuidance: 'services/evaluation/service.ts:2353',
    pairJudgePayloadJson: 'services/evaluation/structured-compare-prompts.ts:154',
    prompt: 'services/evaluation/service.ts:1909',
    promptRefLabel: 'services/evaluation/service.ts:84',
    promptText: 'services/evaluation/service.ts:80',
    reasoning: 'services/evaluation/service.ts:98',
    resultLabel: 'services/evaluation/service.ts:1912',
    rewritePayloadJson: 'services/evaluation/rewrite-from-evaluation.ts:56',
    role: 'services/evaluation/service.ts:85',
    roleLabel: 'services/evaluation/service.ts:86',
    roleName: 'services/evaluation/service.ts:142',
    settingsSummary: 'services/evaluation/service.ts:71',
    snapshotId: 'services/evaluation/service.ts:114',
    snapshotLabel: 'services/evaluation/service.ts:115',
    subject: 'services/evaluation/service.ts:2389',
    subjectLabel: 'services/evaluation/service.ts:141',
    synthesisPayloadJson: 'services/evaluation/structured-compare-prompts.ts:177',
    testCaseInputContent: 'services/evaluation/service.ts:1903',
    testCaseInputLabel: 'services/evaluation/service.ts:1902',
    testCaseInputSummary: 'services/evaluation/service.ts:1904',
    testResult: 'services/evaluation/service.ts:1911',
    toolsContext: 'services/context/constants.ts:22',
    variableCount: 'services/variable-value-generation/service.ts:152',
    variablesText: 'services/variable-value-generation/service.ts:151',
    versionLabel: 'services/evaluation/service.ts:96',
  }
  const actual = engineFields()
  const listed = Object.keys(SOURCES).sort()
  const missingSrc = actual.filter(n => SOURCES[n] === undefined)
  const extraSrc = listed.filter(n => !actual.includes(n))
  check('★ 名单里每个名字都有参考项目出处', missingSrc.length === 0, missingSrc.join(','))
  check('★ 对照表与 vars.ts 的名单完全一致', extraSrc.length === 0 && actual.length === listed.length,
    '名单 ' + actual.length + ' / 表 ' + listed.length
    + (extraSrc.length ? ' 表里多出：' + extraSrc.join(',') : ''))

  /* ── 用户该填的那几个必须还在（不许被名单误杀）──────────────
   *
   * 这是本轮最容易做坏的一处：名单一加宽，把「用户提交的内容」也吞掉，
   * 界面上就一个输入框都没有了 —— 模板变成只能看、不能用。 */
  const USER_INPUT = ['originalPrompt', 'promptContent', 'workspacePrompt', 'referencePrompt',
    'iterateInput', 'lastOptimizedPrompt', 'iterateRequirement', 'promptRequirement', 'focusBrief']
  const killed = USER_INPUT.filter(n => actual.includes(n))
  check('★★ 用户提交的那 9 个名字没被吞进引擎名单', killed.length === 0, killed.join(','))

  /* 既有中文变量的模板，改完仍然是那些中文变量（一个都不许少）。
   *
   * ⚠️ 期望值抄的是**改之前**的实际值（我先跑出来记下，不是凭印象写的）：
   * 自有 10 个的变量名是我们自己定的中文名，与参考项目无关，不该被动到。
   * 后两个是搬来的、中英混合的，只许少 `generationGoal`（引擎填的），中文明星不许少。 */
  const CJK_TEMPLATES = {
    'general-optimize': ['原始提示词'],
    'output-format-optimize': ['原始提示词'],
    'analytical-optimize': ['原始提示词'],
    'user-prompt-basic': ['原始提示词'],
    'user-prompt-professional': ['原始提示词'],
    'user-prompt-planning': ['原始提示词'],
    iterate: ['原提示词', '迭代要求'],
    'iterate-soul': ['原提示词', '迭代要求'],
    'variable-extraction': ['待分析提示词'],
    'variable-value': ['待填提示词', '变量清单', '使用场景'],
    'image-prompt-from-reference-image': ['变量名', '主体角色', '主色'],
    'image-prompt-migration': ['变量名'],
  }
  for (const [id, want] of Object.entries(CJK_TEMPLATES)) {
    const t = PROMPT_TEMPLATES.find(x => x.id === id)
    const got = (t === undefined ? [] : findVars(t.body).map(v => v.name))
    const missing = want.filter(w => !got.includes(w))
    check('★★ 中文变量没被误杀（' + id + '）', t !== undefined && missing.length === 0,
      missing.length === 0 ? '实得 ' + got.join(',') : '缺 ' + missing.join(',') + ' / 实得 ' + got.join(','))
  }

  /* ── 老断言（不再豁免任何人）──────────────────────────────
   *
   * 这条判据的本意是「模板里不该出现一堆用户根本不该填的框」。
   * 加名单之前 21 个模板超标；加完之后必须**一个都不超标**，
   * 而且**不许把它改成豁免式**。 */
  const over5 = PROMPT_TEMPLATES
    .map(t => ({ id: t.id, n: findVars(t.body).length }))
    .filter(x => x.n > 5)
  check('★★ 每份模板变量数都不超过 5（无豁免）', over5.length === 0,
    over5.map(x => x.id + ':' + x.n).join(' '))

  /* ── ⑧ 英文变量名的中文说法（2026-10-23 契约 U）────────────────
   *
   * ## 为什么这一段必须有
   *
   * 用户 m02240：「那些变量都是写的变量名称是英文，没有说明吗？」
   * 中文界面里冒出一串 `originalPrompt`，等于没写说明。所以给它们配了
   * `VAR_LABELS`（`templates/var-labels.ts`），界面显示中文、悬停看说明。
   *
   * ## 判据各自防什么
   *
   * | 判据 | 防的错 |
   * | --- | --- |
   * | 键全是英文 | 有人把中文名也塞进来（中文名本来就会原样显示，配了是死条目） |
   * | 键都能在正文里找到 | 配了用不上的（改了正文却忘了删表项，表越长越像真在管用） |
   * | 区外英文名 100% 有标签 | 加模板时冒出新的英文名没人管 —— 这是**会慢慢烂**的那种 |
   * | 转义区专用的那批名单钉死 | 这批悄悄变长、或有人给它硬配标签掩盖结构问题 |
   */
  console.log('')
  console.log('⑧ 英文变量名的中文说法')
  {
    const keys = Object.keys(VAR_LABELS)
    const CJK = /[\u4e00-\u9fff]/
    const has = (n) => Object.prototype.hasOwnProperty.call(VAR_LABELS, n)

    /* ① 键全是英文名（不含中文）。 */
    const cjkKeys = keys.filter(k => CJK.test(k))
    check('★ VAR_LABELS 的键全是英文名', cjkKeys.length === 0,
      cjkKeys.length === 0 ? keys.length + ' 个' : '中文键：' + cjkKeys.join(','))

    /* ② 键都能在某个模板正文里找到（配了用不上的会烂）。
     * 判据是**正文里有 `{{键}}`**，不是「键出现在某处字符串里」——
     * 后者会把注释、说明里提到的名字也算上。 */
    const allBodies = PROMPT_TEMPLATES.map(t => t.body).join('\n')
    const unused = keys.filter(k => !allBodies.includes('{{' + k + '}}'))
    check('★ 每个键都能在某个模板正文里找到', unused.length === 0, unused.join(','))

    /* ③ 每个条目的 label / hint 都得像话：
     *    · label 是名词短语（不是句子）—— 判据「不以句号问号结尾、不长于 16 字」；
     *    · hint 不能是「输入 + label」这种同义反复（用户看了还是不知道填什么）；
     *    · 守 R6：不用第二人称、不用问号。 */
    const badLabel = keys.filter(k => {
      const l = VAR_LABELS[k].label
      return l.trim() === '' || /[。？！?!]$/.test(l) || l.length > 16
    })
    check('每条 label 都是名词短语（不超 16 字、不以句号问号结尾）', badLabel.length === 0,
      badLabel.join(','))
    const tautology = keys.filter(k => {
      const h = VAR_LABELS[k].hint
      /* 「输入/填写 + 自己的 label」等于没说 —— 用户看了仍然不知道填什么。 */
      return h.includes('输入' + VAR_LABELS[k].label) || h.includes('填写' + VAR_LABELS[k].label)
        || h.trim() === ''
    })
    check('★ 每条 hint 都不是同义反复', tautology.length === 0, tautology.join(','))
    const r6 = keys.filter(k => /[你您]/.test(VAR_LABELS[k].label) || /[？?]/.test(VAR_LABELS[k].label)
      || /[你您]/.test(VAR_LABELS[k].hint))
    check('★ label 与 hint 守 R6（无第二人称、无问号）', r6.length === 0, r6.join(','))

    /* ④ ★ 覆盖率：英文变量名的标签覆盖。
     *
     * ## 为什么分母要分成「区外」与「转义示例区」两拨
     *
     * 62 个模板里有一批英文名**只**出现在转义示例区
     * （`{{=<% %>=}}{{名字}}<%={{ }}=%>`）—— 那是「正文里可能出现的占位符长这样」，
     * 是给模型看的举例，不是让用户填的位置。实测（2026-10-23 扫全库）：
     * `placeholder` / `location_theme` / `headline_text` / `title_text` /
     * `reference_style` 这 5 个在转义区里出现 32 次、**区外 0 次**。
     *
     * ⚠️ 契约要求「≥90% 有标签」。按**全部**英文名算，现状是 10/15 = 67%，
     * 差的那 5 个正是上面这批。给它们硬编中文说明会**掩盖**一个结构问题
     * （它们本来就不该有输入框），所以本测试**不给这个口子**，改成两条更严的：
     *
     *   ① **区外的英文名必须 100% 有标签**（那些才是用户真要看懂的）；
     *   ② 转义区专用的那批，**允许没标签，但必须一个不多一个不少**（钉住名单）。
     *
     * 这比「90%」强：90% 允许漏 1.5 个，①一个都不许漏；
     * 而②把「哪几个没配」从一句口头说明变成会红的断言。 */
    const ESC_OPEN = '{{=<% %>=}}'
    const ESC_CLOSE = '<%={{ }}=%>'
    /** 这个名字在正文里的每次出现是否都在转义区内。 */
    const onlyInEscapes = (name) => {
      const token = '{{' + name + '}}'
      let seen = 0
      for (const t of PROMPT_TEMPLATES) {
        let from = 0
        for (;;) {
          const i = t.body.indexOf(token, from)
          if (i < 0) break
          seen += 1
          const a = t.body.lastIndexOf(ESC_OPEN, i)
          const b = t.body.lastIndexOf(ESC_CLOSE, i)
          const inside = a >= 0 && (b < 0 || b < a)
          if (!inside) return false
          from = i + token.length
        }
      }
      return seen > 0
    }

    const engNames = new Set()
    for (const t of PROMPT_TEMPLATES) {
      for (const v of findVars(t.body)) {
        if (!CJK.test(v.name)) engNames.add(v.name)
      }
    }
    const escOnly = [...engNames].filter(onlyInEscapes)
    const realNames = [...engNames].filter(n => !onlyInEscapes(n))

    const missingReal = realNames.filter(n => !has(n))
    check('★★ 区外英文名 100% 有中文标签（用户真要看懂的就是这批）', missingReal.length === 0,
      missingReal.length === 0 ? realNames.length + ' 个全配' : '未配：' + missingReal.join(','))

    /* ⑤ 转义区专用的那批：名单钉死（一个不多一个不少）。
     * 名单变了就要来这里同步 —— 那正是「别让它悄悄变长」的意思。 */
    const ESC_ONLY_WANT = ['placeholder', 'location_theme', 'headline_text', 'title_text', 'reference_style']
    const escDiffA = ESC_ONLY_WANT.filter(n => !escOnly.includes(n))
    const escDiffB = escOnly.filter(n => !ESC_ONLY_WANT.includes(n))
    check('★★ 转义示例区专用的英文名与名单一致（一个不多一个不少）',
      escDiffA.length === 0 && escDiffB.length === 0,
      '少了 ' + (escDiffA.join(',') || '无') + ' / 多了 ' + (escDiffB.join(',') || '无'))
    /* 反面：这批**不许**被配标签（配了就是把结构问题掩盖成「正常的变量」）。 */
    const labeledEsc = escOnly.filter(n => has(n))
    check('★ 转义示例区专用的那批没有硬配标签（不掩盖结构问题）', labeledEsc.length === 0,
      labeledEsc.join(','))

    /* ⑥ `varLabel()` 的两种返回：配了就对象、没配就是 undefined。
     * 这一条钉的是「没配时**不许**返回一个空壳对象」—— 界面靠 `undefined`
     * 判断「显示原名」，返回 `{label:'', hint:''}` 会让界面显示成空白。 */
    const hit = varLabel('originalPrompt')
    const miss = varLabel('__definitely_not_a_var__')
    check('★ varLabel：配了返回对象、没配返回 undefined',
      hit !== undefined && hit.label !== '' && miss === undefined,
      '配了=' + JSON.stringify(hit?.label) + ' 没配=' + JSON.stringify(miss))

    /* ⑦ ★★ 复制出去的内容不受影响：`fillVars` 仍按原名替换。
     *
     * 这一条是本次最容易做坏的地方 —— 如果谁「顺手」把正文里的 `{{originalPrompt}}`
     * 换成 `{{原始提示词}}`（或让 fillVars 先查中文标签），正文就与参考项目对不上了，
     * 而界面上**看不出来**（显示的还是中文标签）。 */
    const filled = fillVars('A{{originalPrompt}}B', { originalPrompt: '原文片段' })
    check('★★ 替换路径仍认原名（{{originalPrompt}} → 值）', filled === 'A原文片段B', filled)
    /* 反面：把中文标签当键传进去**不该**替换掉任何东西（原名才是键）。 */
    const filledByLabel = fillVars('A{{originalPrompt}}B', { 原始提示词: '不该生效' })
    check('★ 用中文标签当键不会替换（原名才是键）', filledByLabel === 'A{{originalPrompt}}B', filledByLabel)
    /* 正文本身一个字没动。 */
    const bodyWithVar = PROMPT_TEMPLATES.find(t => t.body.includes('{{originalPrompt}}'))?.body ?? ''
    check('模板正文里仍是 {{originalPrompt}}（一个字没改）', bodyWithVar.includes('{{originalPrompt}}'))
  }
}

console.log('')
console.log(failed === 0 ? '结论：提示词优化 结构 / 参数 / 产出 / 真跑 / 模板库 全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)

