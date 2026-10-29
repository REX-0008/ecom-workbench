/** 票 70：节点选模型那一格按类型标签过滤（2026-10-29）。
 *
 * ## 这一段守的是什么
 *
 * 用户原话：「同时节点也根据这个标签去找到能使用的模型。」票 67 给了五类标签，
 * 本票让**选模型的那几处**按类型筛。
 *
 * 三类落点，各自的失效方式不同：
 *
 * | 位置 | 失效会怎样 | 这里怎么验 |
 * |---|---|---|
 * | 内容画布设置面板的下拉 | 列表里混进做不了这一类的模型，到生成才失败 | 纯函数层：喂一份带 `types` 的清单，看筛出来的是谁 |
 * | 配置节点的手打框 | 用户不知道这一类该填什么 | 源码层：那行小字在、措辞对 |
 * | 工作流那两处 `kind: 'model'` | 下拉内容被顺手改了（dsh 目录没有类型） | 源码层：声明在、下拉仍是 `picks` |
 *
 * ## 为什么这一份不用 jsdom
 *
 * 要验的是「筛出来的清单是哪几条」「那行字写了什么」。前者是纯函数，
 * 后者是源码里的一个字符串 —— 挂整个画布跑一遍既慢，又因为它要引
 * `EcomWorkbench.module.css` 而在这个测试环境里跑不起来
 * （`ERR_UNKNOWN_FILE_EXTENSION`，`content-canvas-fixes.mjs` 文件头记着同一件事）。
 *
 * 跑法：node --import <tsx> tests/content-node-models.mjs
 */
import { readFileSync } from 'node:fs'

const HERE = new URL('.', import.meta.url)
const read = (p) => readFileSync(new URL(p, HERE), 'utf8')

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

/* ══════════════════════════════════════════════════════════════════════
 * 一、两处工作流节点声明了 modelType: 'text'（验收 1）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== 一、工作流那两处：声明 modelType ===')
{
  const { NODE_LIBRARY } = await import('../src/nodes/index.ts')
  const agent = NODE_LIBRARY.find(d => d.id === 'ai.agent')
  const start = NODE_LIBRARY.find(d => d.id === 'flow.start')

  const modelParam = (def) => (def?.paramDefs ?? []).find(p => p.kind === 'model')

  check('★★ ai.agent 有 kind=model 的参数', modelParam(agent) !== undefined,
    JSON.stringify((agent?.paramDefs ?? []).map(p => p.key)))
  check('★★★ ai.agent 那个参数声明了 modelType: text',
    modelParam(agent)?.modelType === 'text', String(modelParam(agent)?.modelType))
  check('★★ flow.start 有 kind=model 的参数', modelParam(start) !== undefined, '')
  check('★★★ flow.start 那个参数声明了 modelType: text',
    modelParam(start)?.modelType === 'text', String(modelParam(start)?.modelType))

  /* 只有这两处有 `kind: 'model'`（票 70 不许给生图/生视频/生音频节点加）。 */
  const all = NODE_LIBRARY.flatMap(d => (d.paramDefs ?? []).filter(p => p.kind === 'model').map(p => d.id + '.' + p.key))
  check('★★★ 全仓只有这两处 kind=model（没有多出来）',
    all.length === 2 && all.includes('ai.agent.model') && all.includes('flow.start.model'),
    JSON.stringify(all))

  /* 内容画布那三个节点类型**不是** NodeDef（它们在客户端），所以这条要看源码。 */
  const nodesSrc = read('../src/client/workbench/content-nodes.tsx')
  check('★★★ 内容画布的生图/生视频/生音频节点没有新增 kind: model（验收 7）',
    !/kind:\s*'model'/.test(nodesSrc) && !/kind:\s*"model"/.test(nodesSrc),
    nodesSrc.includes('kind:') ? '（源码里有 kind: 但不是 model）' : '')
}

/* ══════════════════════════════════════════════════════════════════════
 * 二、工作流下拉内容：改动前后逐条相同（验收 2）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 二、工作流那两处下拉：仍是 picks，没被类型筛 ===')
{
  const popSrc = read('../src/client/workbench/NodeEditorPopover.tsx')
  check('★★★ ModelControl 的选项来源仍是 `catalog.prefs.picks`（不是按类型筛过的）',
    popSrc.includes('catalog?.prefs.picks ?? []'), '')
  check('★★★ ModelControl 里没有读 modelType（没拿它筛选项）',
    /* 只允许在注释里出现 `modelType` 这个词，不许有 `def.modelType` 这类读取。 */
    !/\.modelType\b/.test(popSrc.replace(/\/\*[\s\S]*?\*\//g, '')),
    (/\.modelType\b/.test(popSrc) ? '出现了 .modelType 的读取' : ''))

  /* `modelType` 这个字段在 `toCommandContext` 里**不该被用到**：
   * 它是给界面用的声明，不是给引擎找模型的判据（引擎那条按 `caps` 走）。 */
  const modelSrc = read('../src/workflow/model.ts')
  const ctxBlock = modelSrc.slice(
    modelSrc.indexOf('export function toCommandContext'),
    modelSrc.indexOf('export interface ParamShowWhen'),
  )
  check('★★ toCommandContext 不读 modelType（引擎那条判据没变）',
    !/modelType/.test(ctxBlock), ctxBlock.includes('modelType') ? '读到了' : '')
}

/* ══════════════════════════════════════════════════════════════════════
 * 三、内容画布：图片档同时有文生图与图生图（验收 3、4）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 三、内容画布图片档：两类都要有 ===')
{
  /* 判据是 `ContentCanvas.tsx` 里那三样东西。纯函数没抽出来（它住在组件里，
   * 而组件引 CSS 跑不起来），所以按源码断言**声明层面**的事实 ——
   * 这几条的失效方式都是「某条判据被删了」，不是「运行时算错了」。 */
  const canvasSrc = read('../src/client/workbench/ContentCanvas.tsx')

  check('★★★ 图片那一档要的是 t2i 与 i2i 两类（不是只挑一个）',
    /kind === 'image'\)\s*return \['t2i', 'i2i'\]/.test(canvasSrc),
    (/return \['t2i', 'i2i'\]/.test(canvasSrc) ? '' : '没找到 [`t2i`, `i2i`]'))

  /* ⚠️ 判据必须是「按 types 筛的那一行存在**且只有一份**」。
   *
   * 第一版只验「存在」—— 自证时把过滤删掉测试全绿，因为 `modelsFor` 与
   * `modelsFallbackNote` 里各写了一遍（改坏一处另一处还对）。现在收成
   * `pickModels` 一个函数，这条断言把「只有一份」也钉住。 */
  const typesFilterCount = (canvasSrc.match(/m\.types\.some\(/g) ?? []).length
  check('★★★ 按 types 筛的那一行存在（不是按 caps 筛）',
    typesFilterCount >= 1, String(typesFilterCount) + ' 处')
  check('★★★ 按 types 筛的判据**只有一份**（两处各写一遍会互相掩盖错误）',
    typesFilterCount === 1, String(typesFilterCount) + ' 处')
  check('★★★ 两个用它的地方都走同一个函数（`pickModels`）',
    /pickModels\(n\)/.test(canvasSrc) && (canvasSrc.match(/pickModels\(n\)/g) ?? []).length >= 2,
    String((canvasSrc.match(/pickModels\(n\)/g) ?? []).length) + ' 处调用')
  check('★★★ modelsFor 里没有退回按 caps 筛（那是前端自己推类型，票 70 不许）',
    !/m\.caps\.includes\(kind\)/.test(canvasSrc),
    (/m\.caps\.includes\(kind\)/.test(canvasSrc) ? '还在按 caps 筛' : ''))

  /* 兜底：一条都不匹配时回全部，且**要说出来**。 */
  check('★★ 一条都不匹配时回全部（兜底，藏起来会让人以为配错了）',
    /return hit\.length > 0 \? hit : all/.test(canvasSrc), '')
  check('★★★ 兜底生效时有一句说明（不是默默列全部）',
    canvasSrc.includes('清单里没有登记为') && canvasSrc.includes('下面是全部模型'),
    '')
  check('★★ 那句说明只在兜底时出现（正常过滤时是空串）',
    /if \(hit\.length > 0\) return ''/.test(canvasSrc), '')

  /* 类型中文名走共享那一份，不另写。 */
  check('★★★ 类型中文名用的是 `MODEL_TYPE_LABEL`（不另写一份）',
    canvasSrc.includes('MODEL_TYPE_LABEL'), '')
  check('★★ ContentCanvas 里没有硬写「文生图」当显示文案（只在注释里出现）',
    !/label = .*'文生图'/.test(canvasSrc), '')
}

/* ══════════════════════════════════════════════════════════════════════
 * 四、设置面板：选项带类型标签（验收 4）+ 兜底那行小字（验收 6 的一半）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 四、设置面板 ===')
{
  const panelSrc = read('../src/client/workbench/NodeSettingsPanel.tsx')

  check('★★★ 选项文字带类型后缀（`typeSuffix` 被调在 option 里）',
    /typeSuffix\(m\)/.test(panelSrc), '')
  check('★★★ 后缀用共享的 `MODEL_TYPE_LABEL`',
    panelSrc.includes('MODEL_TYPE_LABEL'), '')
  check('★★ 一个类型都没有时不加后缀（不编一个假类型）',
    /types\.length === 0\) return ''/.test(panelSrc), '')
  check('★★★ 兜底那句说明能显示（有渲染分支）',
    panelSrc.includes('data-ewb-node-model-note'), '')
  check('★★ 那句是空串时不渲染',
    /modelsFallbackNote \?\? ''\) !== ''/.test(panelSrc), '')
  check('★★ 面板仍是纯展示层（没为这件事新增 fetch）',
    !/\bfetch\(/.test(panelSrc), (/fetch\(/.test(panelSrc) ? '出现了 fetch' : ''))
}

/* ══════════════════════════════════════════════════════════════════════
 * 五、配置节点：手打框旁边那行小字（验收 5、6）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 五、配置节点的手打框 ===')
{
  const nodesSrc = read('../src/client/workbench/content-nodes.tsx')

  /* ⚠️ 关键：**仍是手打框**，不许改成下拉。它守的是「清单拉不回来时还能用」。 */
  check('★★★ 仍是手打输入框（`contentConfigInput` + input），没改成下拉',
    /data-ewb-config-model=""[\s\S]{0,200}<\/input>/.test(nodesSrc)
    || /<input[\s\S]{0,300}data-ewb-config-model=""/.test(nodesSrc),
    '')
  check('★★★ 模型那一格没有变成 select',
    !/<select[\s\S]{0,120}data-ewb-config-model/.test(nodesSrc), '')

  check('★★★ 手打框下面有一行小字（`data-ewb-config-model-hint`）',
    nodesSrc.includes('data-ewb-config-model-hint'), '')
  check('★★ 小字说清了图片这一类要哪两类模型',
    nodesSrc.includes('文生图与图生图模型'), '')
  check('★★ 小字说清了视频这一类',
    nodesSrc.includes('文生视频模型'), '')
  check('★★ 小字按 `genType` 分支（不是两句话都显示）',
    /genType === 'video'/.test(nodesSrc), '')

  /* R6：不用第二人称、不用口语词、不用疑问句。 */
  const hintBlock = nodesSrc.slice(
    nodesSrc.indexOf('data-ewb-config-model-hint'),
    nodesSrc.indexOf('data-ewb-config-model-hint') + 700,
  )
  check('★★ 小字守 R6：没有第二人称「你」（验收文案规范）',
    !/你/.test(hintBlock), (/你/.test(hintBlock) ? '出现了「你」' : ''))
  check('★★ 小字守 R6：不是疑问句',
    !/？/.test(hintBlock), '')
  check('★★ 小字守 R6：没有口语词（吧 / 啦 / 哦 / 呗）',
    !/[吧啦哦呗]/.test(hintBlock), '')
}

/* ══════════════════════════════════════════════════════════════════════
 * 六、后端：每条模型都带 types（票 70 补的契约）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 六、`/gen-models` 每条带 types ===')
{
  const { listModels } = await import('../src/schedule/generate.ts')
  const { saveChannel } = await import('../src/schedule/channels.ts')
  const { typesOfModel } = await import('../src/schedule/model-types.ts')
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  process.env.EWB_TEST_HOME = process.env.EWB_TEST_HOME ?? await mkdtemp(join(tmpdir(), 'ewb-cnm-'))
  process.env.EWB_TEST_SKILLS = process.env.EWB_TEST_SKILLS ?? join(process.env.EWB_TEST_HOME, 'skills')

  await saveChannel({
    id: 'ch-cnm', name: '票70渠道', protocol: 'openai', baseUrl: 'https://cnm.example.com',
    models: [
      { id: 'cnm-img', label: '图', caps: ['image'] },
      { id: 'cnm-t2i', label: '只文生图', caps: ['image'], types: ['t2i'] },
      { id: 'cnm-vid', label: '视频', caps: ['video'] },
    ],
  })
  const list = await listModels()
  const mine = list.filter(m => m.channelId === 'ch-cnm')
  check('★★★ 每条都带 `types`（数组）',
    mine.every(m => Array.isArray(m.types)), JSON.stringify(mine.map(m => m.types)))
  check('★★★ `types` 就是 `typesOfModel` 的结论（不另写推导）',
    mine.every(m => JSON.stringify(m.types) === JSON.stringify(typesOfModel(m))),
    JSON.stringify(mine.map(m => [m.modelId, m.types])))
  /* ★ 2026-10-29（票 74）：**类型从五类退回四类**（`text` / `image` / `video` / `audio`）。
   *
   * ## 这条断言守的事情没变，期望值变了
   *
   * | | 五类那版（票 67 / 68） | 四类这版（票 74） |
   * |---|---|---|
   * | `caps: ['image']` 推出什么 | `['t2i', 'i2i']`（拆两种） | `['image']`（一类） |
   * | 手标 `types: ['t2i']` 呢 | `['t2i']`（手标优先，不推导） | `['image']`（旧取值映射当 image） |
   *
   * ## 为什么手标 `t2i` 在四类之后是 `image` 而不是被拒掉
   *
   * 见 `src/schedule/model-types.ts` 的旧取值映射：老存档里可能存着五类时代的
   * `t2i` / `i2i`。四类之后它们不该让那条模型变成「一个类型都没有」——
   * 而 `t2i` / `i2i` 本来就是 `image` 的子集，归到 `image` 是**语义安全的**
   * （放宽范围不会选到做不了这件事的模型）。
   *
   * ⚠️ 这条仍钉「`typesOfModel` 对两种输入都给出合理的类」：
   * 一个没手标（走推导）、一个手标了旧值（走映射）。两者现在**结果相同**
   * （都是 `['image']`），但走的路不同 —— 这正是这条要如实记录的事，
   * 不是「反正都是 image 所以不用管」。 */
  check('★★★ caps 有 image 就推 image；手标的旧取值 t2i 也归到 image（四类）',
    JSON.stringify(mine.find(m => m.modelId === 'cnm-img')?.types) === JSON.stringify(['image'])
    && JSON.stringify(mine.find(m => m.modelId === 'cnm-t2i')?.types) === JSON.stringify(['image']),
    JSON.stringify(mine.map(m => [m.modelId, m.types])))
  check('★★ 老六键一个没少（加 types 不影响既有调用方）',
    mine.every(m => typeof m.channelId === 'string' && typeof m.channelName === 'string'
      && typeof m.protocol === 'string' && typeof m.modelId === 'string'
      && typeof m.modelLabel === 'string' && Array.isArray(m.caps)),
    JSON.stringify(Object.keys(mine[0] ?? {})))
}

console.log('')
console.log(failed === 0
  ? '结论：两处声明、下拉标签、兜底说明、手打框小字、每条带 types 全部通过 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
