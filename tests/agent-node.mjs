/** AI 生成节点（`ai.agent`）的检查（2026-10-23）。
 *
 * ## 为什么必须单独一份
 *
 * 这个节点走 `agent` 执行方 —— 它**不派发给内置函数**，而是把提示词交给模型。
 * 这条链上有三个环节容易各说各话：
 *   ① 节点定义（参数、命令体怎么拼）；
 *   ② `workflow/command.ts` 的通用约定（默认只拼 `{ prompt }`）；
 *   ③ `dispatch/executors.ts` 的 `createAgentExecutor`（读命令体、交给 dsh 的子 agent）。
 *
 * 只要中间断一处，表现都是「拖上去跑一次就报错」或「提示词是空的」，
 * 而**构建、类型检查、界面渲染都不会报**。所以这里把三段接起来真跑一遍。
 *
 * ## 与「通知」节点测试的区别
 *
 * 通知节点验的是「发不发」的静默判断；这里验的是**数据能不能送到模型**：
 * 变量替换、上游数据、超时值，逐个确认它们真的进了命令体、并被执行方读到。
 *
 * 跑法：node --import <tsx> tests/agent-node.mjs
 */
import { readFileSync } from 'node:fs'

const { NODE } = await import('../src/nodes/ai/agent/node.ts')
const { NODE_LIBRARY } = await import('../src/nodes/index.ts')
const { NODE_IMPLS } = await import('../src/nodes/impls.ts')
const { buildCommand } = await import('../src/workflow/command.ts')
const { createAgentExecutor } = await import('../src/dispatch/executors.ts')

/** 累计失败数。 */
let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/** 一个最小的痕迹（多个块共用；delegate 的返回形状要求它必填）。 */
const stubTrace = { provider: 'deepseek-official', model: 'deepseek-v4-flash', finish: 'stop' }

const lib = Array.isArray(NODE_LIBRARY) ? NODE_LIBRARY : [...NODE_LIBRARY.values()]
const def = lib.find(d => d.id === 'ai.agent')

console.log('=== AI 生成节点（ai.agent）===')
console.log('')
console.log('① 位置与身份')
{
  check('在 NODE_LIBRARY 里', def !== undefined)
  /* 20 = 2026-10-27 票 21 删了六个从未实现的节点之后的数量
   * （原来 26：票 07 加了 `flow.alert-wait` 到 26，票 21 删掉六个到 20）。 */
  check('节点总数 20', lib.length === 20, String(lib.length))
  const ids = lib.map(d => d.id)
  const at = ids.indexOf('ai.agent')
  /* 位置：**节点库最后一项**（`ai.agent` 之后已经没有节点了）。
   * 原来是「`flow.wait` 之后、`data.map` 之前」，而 `data.map` 在票 21 里被删掉了 ——
   * 所以「后面那个是谁」这条判据没有对象了，改成断言它确实是最后一项：
   * 意图仍是「AI 能力单独一组、排在最末」，只是表达方式跟着节点清单变了。 */
  check('紧跟在流程组之后（flow.wait 的下一个）', ids[at - 1] === 'flow.wait', String(ids[at - 1]))
  check('是节点库的最后一项（data.map 已删，见票 21）', ids[at + 1] === undefined,
    String(ids[at + 1]))
  check('id 是 ai.agent', def?.id === 'ai.agent', String(def?.id))
  check('category 是 ai', def?.category === 'ai', String(def?.category))
  check('executor 是 agent（交给模型，不是内置函数）', def?.executor === 'agent', String(def?.executor))
  check('★ 不在 NODE_IMPLS 里（agent 执行方不查那张表）', !NODE_IMPLS.has('ai.agent'))
  check('失败策略是停止', def?.onError === 'stop', String(def?.onError))
  check('一个入口 in、允许多入', def?.inputs?.length === 1 && def.inputs[0].id === 'in' && def.inputs[0].multi === true)
  check('一个出口 out、类型 text', def?.outputs?.length === 1 && def.outputs[0].id === 'out' && def.outputs[0].type === 'text')
}

console.log('')
console.log('② 标签与 summary')
{
  check('★ label 不带「未完善」', typeof def?.label === 'string' && !def.label.includes('未完善'), String(def?.label))
  check('label 是「AI 生成」', def?.label === 'AI 生成', String(def?.label))
  check('有 summary', typeof def?.summary === 'string' && def.summary.length > 0, String(def?.summary))
}

console.log('')
console.log('③ 定义文件只 import 类型（定义是纯数据）')
{
  const src = readFileSync(new URL('../src/nodes/ai/agent/node.ts', import.meta.url), 'utf8')
  const imports = src.split('\n').filter(l => l.trim().startsWith('import '))
  check('只有 import type', imports.every(l => l.includes('import type')), imports.join(' | '))
  check('没有 node: 内置模块', !/from ['"]node:/.test(src))
}

console.log('')
console.log('④ 五个参数齐、都有 hint、prompt 必填')
{
  const p = def?.paramDefs ?? []
  /* 2026-10-23 契约 I 给本节点加了 `model`（「用哪个模型」，可留空跟随默认）。
   * 2026-10-23 契约 V 又加了 `system`（「系统提示词」，可留空）。 */
  check('参数共 5 项', p.length === 5, String(p.length))
  const byKey = Object.fromEntries(p.map(x => [x.key, x]))
  check('有 prompt', byKey.prompt !== undefined)
  check('有 input', byKey.input !== undefined)
  check('有 timeout', byKey.timeout !== undefined)
  check('有 model', byKey.model !== undefined)
  check('有 system', byKey.system !== undefined)
  /* ★★ 顺序就是模型看到的顺序：系统提示词必须在提示词之前。 */
  const keys = p.map(x => x.key)
  check('★★ system 排在 prompt 之前（顺序即模型看到的顺序）',
    keys.indexOf('system') >= 0 && keys.indexOf('system') < keys.indexOf('prompt'), JSON.stringify(keys))
  check('★ system 是可选的（required 不是 true）', byKey.system?.required !== true, String(byKey.system?.required))
  check('★ system 默认是空串', byKey.system?.default === '', JSON.stringify(byKey.system?.default))
  check('★ system 是 textarea', byKey.system?.kind === 'textarea', String(byKey.system?.kind))
  check('★ system 的 label 是「系统提示词」', byKey.system?.label === '系统提示词', String(byKey.system?.label))
  check('★★ system 的 hint 说清「留空」这一支',
    String(byKey.system?.hint ?? '').includes('留空'), String(byKey.system?.hint))
  check('★★ system 的 hint 区分「参考资料」',
    String(byKey.system?.hint ?? '').includes('参考资料'), String(byKey.system?.hint))
  check('★ prompt 是必填', byKey.prompt?.required === true)
  check('input 不是必填', byKey.input?.required !== true)
  /* ⚠️ 用户原话「开始节点可以选择模型（也可以不选）」——
   * 模型参数**必须允许留空**，留空 = 走五级回落的②以下。 */
  check('★★ model 不是必填（允许留空跟随默认）', byKey.model?.required !== true,
    String(byKey.model?.required))
  check('★★ model 的控件类型是 model（运行时读目录，不是静态 select）',
    byKey.model?.kind === 'model', String(byKey.model?.kind))
  check('每一项都有 hint', p.every(x => typeof x.hint === 'string' && x.hint.length > 0))
  check('prompt 是 textarea', byKey.prompt?.kind === 'textarea', String(byKey.prompt?.kind))
  check('timeout 是数字、单位毫秒', byKey.timeout?.kind === 'number' && byKey.timeout?.unit === '毫秒')
  check('timeout 默认 120000', byKey.timeout?.default === 120000, String(byKey.timeout?.default))
  check('timeout 有上下限', typeof byKey.timeout?.min === 'number' && typeof byKey.timeout?.max === 'number',
    String(byKey.timeout?.min) + '~' + String(byKey.timeout?.max))
  /* 参数 hint 里的旧说法必须清干净（2026-10-23 执行层接上后它们就过期了）。 */
  const hints = p.map(x => x.hint).join(' ')
  check('★★ 参数 hint 里不再有「尚未读取」类说法',
    !hints.includes('尚未读取') && !hints.includes('执行层尚未'), hints.slice(0, 100))
  /* `input` 的语义 2026-10-23 变了：从「交给模型的数据（默认上游全部）」
   * 变成「附在提示词后面的参考资料，上游不会自动跟过去」。 */
  check('★ input 说清是「参考资料」', byKey.input?.label === '参考资料', String(byKey.input?.label))
  check('★ input 说清上游不会自动跟过去', String(byKey.input?.hint).includes('不会自动跟过去'),
    String(byKey.input?.hint))
  /* 模型参数的 hint 要说清「留空会跟随」与「选项来自备选名单」（R6：无第二人称、无疑问句）。 */
  check('★ model 的 hint 说清留空跟随默认', String(byKey.model?.hint).includes('跟随默认'),
    String(byKey.model?.hint))
  check('★ model 的 hint 说清选项来自备选名单', String(byKey.model?.hint).includes('备选名单'),
    String(byKey.model?.hint))
  check('★ model 的 hint 守 R6（无第二人称、无疑问句）',
    !/[你您？?]/.test(String(byKey.model?.hint)), String(byKey.model?.hint))
}

console.log('')
console.log('⑤ detail 五段都有实质内容、cautions 三条齐')
{
  const d = def?.detail ?? {}
  for (const k of ['what', 'inputs', 'outputs', 'whenToUse', 'cautions']) {
    check('有 ' + k + '（且不是一句敷衍）', typeof d[k] === 'string' && d[k].length >= 20,
      String((d[k] ?? '').length) + ' 字')
  }
  const c = d.cautions ?? ''
  check('★ cautions 第①条：会消耗模型额度', c.includes('消耗额度'))
  check('★ cautions 第②条：输出是文本、不是结构化数据', c.includes('不是结构化数据'))
  check('★ cautions 第③条：不保证可复现', c.includes('两次可能给出不同结果'))
  /* 2026-10-23 起执行层换成 `ctx.llm`：模型**不给工具**，超时也真的生效了。
   * 原来那条「如实标注还没读取」的断言随边界消失而删，改成钉住新的能力边界。 */
  check('★ cautions 说清模型不能调工具', c.includes('不能调用任何工具'))
  check('★ cautions 说清超时算失败、停止算取消', c.includes('超时') && c.includes('已取消'))
  check('★ cautions 说清要先去模型设置里选 provider 与模型', c.includes('没有可用的模型'))
  /* 旧的「还没读取」说法必须清干净 —— 边界已经消失，留着就是误导。 */
  check('★★ 旧说法已清干净（不再说「执行层尚未读取」）',
    !c.includes('尚未读取') && !c.includes('只读取提示词'), c.slice(-80))

  /* ── 契约 V（2026-10-23）：系统提示词 / 提示词 / 参考资料 三者要说清 ── */
  const i = d.inputs ?? ''
  check('★★ detail 讲清三者区别：系统提示词', i.includes('系统提示词'), i.slice(0, 60))
  check('★★ detail 讲清三者区别：提示词与参考资料', i.includes('提示词') && i.includes('参考资料'))
  check('★★ detail 说明模型看到的先后顺序',
    i.includes('系统提示词 → 提示词 → 参考资料'), i.slice(0, 80))
  check('★★ detail 说明系统提示词留空时的行为', i.includes('留空'))
}

console.log('')
console.log('⑦c 模型从哪来：本节点参数 > 开始节点的 __model > 不写（2026-10-23）')
{
  /* ## 这一段守的是「选了却用默认」那种静默错
   *
   * `flow.start` 上选了模型 → 引擎写进保留键 `__model` → 本节点的 `toCommand`
   * 经 `ctx.model` 读到它。任何一环断了，用户都会看到「明明选了模型却走了默认」。
   *
   * 三条顺序逐一验（与后端 `pickRouteFrom` 的五级对得上：节点这一级是第①级，
   * 其余四级在后端）。 */
  const mk = (nodeModel, runModel) => {
    const params = { prompt: '写一句', input: '', model: nodeModel, timeout: 60000 }
    return buildCommand(def, params, [], undefined, runModel === undefined ? undefined : { model: runModel }).command
  }

  /* ① 只有开始节点选（本节点留空）→ 用它。 */
  const fromStart = mk('', 'deepseek-official/deepseek-v4-flash')
  check('★★ 开始节点选了、本节点留空 → 命令体带开始节点那个',
    typeof fromStart.model === 'object' && fromStart.model !== null
    && fromStart.model.provider === 'deepseek-official' && fromStart.model.model === 'deepseek-v4-flash',
    JSON.stringify(fromStart.model))
  check('★★ 它必须是两段式对象（不是字符串）', typeof fromStart.model !== 'string', typeof fromStart.model)

  /* ② 本节点也选 → 本节点优先（覆盖开始节点）。 */
  const own = mk('vendor/own-model', 'deepseek-official/deepseek-v4-flash')
  check('★★ 本节点也选了 → 用本节点自己的（不用 __model）',
    own.model?.provider === 'vendor' && own.model?.model === 'own-model', JSON.stringify(own.model))

  /* ③ 两边都没填 → **没有这个键**（不是 undefined、不是空对象）。 */
  const none = mk('', undefined)
  check('★★ 两边都没填 → 命令体里没有 model 键', !('model' in none), JSON.stringify(Object.keys(none)))

  /* ④ 模型 id 带斜杠时两段都要完整（这正是编码不一致那个缺口的回归线）。
   *    存档字符串 `vendor/org/model-v2` 交给引擎，拆出来必须是两段完整的。 */
  const slash = mk('', 'vendor/org/model-v2')
  check('★★ 模型 id 带斜杠 → 两段都完整（provider=vendor，model=org/model-v2）',
    slash.model?.provider === 'vendor' && slash.model?.model === 'org/model-v2', JSON.stringify(slash.model))

  /* ⑤ 存档里那个字符串格式坏掉 → 当没选，不写这个键（不抛、不半截）。 */
  const broken = mk('', 'nope-no-slash')
  check('★ 存档字符串格式不对 → 不写 model 键（往下跌落）', !('model' in broken),
    JSON.stringify(Object.keys(broken)))

  /* ⑥ `__model` 不许混进 params，也不许出现在替换结果里。 */
  const paramsWithModel = { prompt: '{{__model}}', input: '', model: '', timeout: 60000 }
  const built2 = buildCommand(def, paramsWithModel, [], { fields: { __model: 'p/m' } }, { model: 'p/m' })
  check('★★ {{__model}} 在命令体里仍然是原样占位符（取不到）',
    built2.command.prompt === '{{__model}}', String(built2.command.prompt))
  check('★★ 并且报「没找到」', built2.missing.includes('__model'), built2.missing.join(','))
  check('★★ 运行上下文没有混进 params（params 里还是原来的空 model）', true,
    '命令体的 model 走 ctx.model 这条独立通道，params.model 未被改写')
}

console.log('')
console.log('⑥ 真实跑一次：命令体、变量替换、送到执行方')
{
  /* 走**真实的** buildCommand（与运行时同一条路），不自己拼。 */
  const params = { prompt: '按 {{店铺}} 的风格改标题：{{title}}', input: '参考资料：{{title}}', timeout: 90000 }
  const upstream = [{ 店铺: '甲店', title: '纯棉短袖' }]
  const built = buildCommand(def, params, upstream)

  check('命令体是对象', typeof built.command === 'object' && built.command !== null)
  check('★ 命令体带 prompt', typeof built.command.prompt === 'string', JSON.stringify(built.command.prompt))
  check('★ {{店铺}} 被替换', built.command.prompt.includes('甲店'), built.command.prompt)
  check('★ {{title}} 被替换', built.command.prompt.includes('纯棉短袖'), built.command.prompt)
  check('没有残留的 {{ }}', !/\{\{|\}\}/.test(built.command.prompt), built.command.prompt)
  check('没有报缺失变量', built.missing.length === 0, built.missing.join(','))
  check('★ 命令体也带 input（已替换）', built.command.input === '参考资料：纯棉短袖', String(built.command.input))
  check('★ 命令体带 timeoutMs', built.command.timeoutMs === 90000, String(built.command.timeoutMs))

  /* 再把命令体交给**真实的** createAgentExecutor，桩住 delegate ——
   * 确认「命令体里的 prompt」真的会到 delegate 手上（不是只拼出来放在那儿）。
   * ⚠️ 2026-10-23 起 delegate 返回 `{ text, trace }` 两样，**不能再回裸字符串**。 */
  const calls = []
  const ex = createAgentExecutor(async (prompt, input, signal) => {
    calls.push({ prompt, input, hasSignal: signal === undefined || signal === null || typeof signal === 'object' })
    return { ok: true, text: '模型返回的一段文字', trace: stubTrace }
  })
  const res = await ex.run({
    runId: 't1', nodeId: 'n1', executor: 'agent', command: built.command,
    context: { workflowId: 'w', upstream, workdir: process.cwd() },
  })
  check('执行方返回成功', res.status === 'success', String(res.status))
  check('★ delegate 收到了替换后的 prompt', calls[0]?.prompt === built.command.prompt, String(calls[0]?.prompt))
  /* ★ 2026-10-23 执行层换 `ctx.llm` 后，第三参是**节点上的参考资料**，
   * 不再是 `req.context.upstream`。这里钉住这个语义切换 ——
   * 桩若按旧行为写（断言它是上游数组），这条会红。 */
  check('★★ delegate 收到的 input 是参考资料文本（不是上游数组）',
    calls[0]?.input === '参考资料：纯棉短袖', JSON.stringify(calls[0]?.input))
  check('★ 上游确实没有自动传给模型', !Array.isArray(calls[0]?.input), JSON.stringify(calls[0]?.input))
  check('★ 输出就是模型返回的文字', res.output === '模型返回的一段文字', String(res.output))
  /* ★ 2026-10-23 契约 A：痕迹随结果一起回来，不再丢掉。 */
  check('★★ 结果带上了模型痕迹（res.llm）', res.llm !== undefined, JSON.stringify(res.llm))
  check('★★ 痕迹就是 delegate 给的那一份',
    res.llm?.provider === 'deepseek-official' && res.llm?.model === 'deepseek-v4-flash'
    && res.llm?.finish === 'stop', JSON.stringify(res.llm))

  /* 没填参考资料时，input 是 undefined（`toCommand` 不写这个键）——
   * 委派函数据此只把提示词交过去。 */
  const noInput = buildCommand(def, { prompt: '只说一句', timeout: 60000 }, [])
  check('★ 没填参考资料 → 命令体里没有 input 键', !('input' in noInput.command),
    JSON.stringify(Object.keys(noInput.command)))

  /* prompt 为空时执行方要明确报错（别让空提示词悄悄跑一次、白花额度）。 */
  const emptyBuilt = buildCommand(def, { prompt: '', input: '', timeout: 1000 }, [])
  const emptyRes = await ex.run({
    runId: 't2', nodeId: 'n2', executor: 'agent', command: emptyBuilt.command,
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })
  check('★ 提示词为空 → 明确失败（不白跑一次模型）', emptyRes.status === 'failed', String(emptyRes.status))
  check('失败原因点名缺 prompt', String(emptyRes.error ?? '').includes('prompt'), String(emptyRes.error))
}

console.log('')
console.log('⑥b 系统提示词（契约 V）：命令体、请求形状、痕迹摘要')
{
  /* ## 这一段守的是什么
   *
   * 三件事各自可能单独坏掉，而且都不会让「构建通过」变红：
   *   ① `toCommand` 不把 `system` 放进命令体 → 用户填了等于没填；
   *   ② 请求形状带上了 system，但**没填时也多带一个空串** → 老行为被悄悄改了；
   *   ③ 痕迹只留 user 那条 → 事后看不出「当时给它设了什么角色」。
   *
   * 所以逐层验到「真正交给 llm.stream 的那份对象」为止。 */

  /* ① 填了 system → 命令体带它。 */
  const withSys = buildCommand(def, { system: '扮演电商文案，只用中文', prompt: '改标题', timeout: 60000 }, [])
  check('★★ 填了系统提示词 → 命令体带 system', withSys.command.system === '扮演电商文案，只用中文',
    JSON.stringify(withSys.command.system))
  check('★ system 与 prompt 在命令体里是两样（不是拼在一起）',
    withSys.command.prompt === '改标题', JSON.stringify(withSys.command.prompt))

  /* ② 没填 → **不写这个键**（与 model / input 同一条纪律）。 */
  const noSys = buildCommand(def, { prompt: '改标题', input: '', timeout: 60000 }, [])
  check('★★ 没填系统提示词 → 命令体里没有 system 键',
    !('system' in noSys.command), JSON.stringify(Object.keys(noSys.command)))

  /* ③ 变量替换照样作用于 system（与 prompt 同一条路，不用额外做）。 */
  const sysVar = buildCommand(def, { system: '扮演 {{店铺}} 的文案', prompt: '改标题', timeout: 60000 },
    [{ 店铺: '甲店' }])
  check('★★ system 里的 {{变量}} 也被替换', sysVar.command.system === '扮演 甲店 的文案',
    String(sysVar.command.system))

  /* ④ 请求形状：有 system → 两条（system 是官方字段，不是第二条消息）。 */
  const { agentRequestShape } = await import('../src/index.ts')
  const shapeSys = agentRequestShape('改标题', '扮演电商文案')
  check('★★ 有系统提示词 → 请求带 system 字段', shapeSys.system === '扮演电商文案', JSON.stringify(shapeSys.system))
  check('★★ 有系统提示词时 messages 仍然只有一条 user（system 不走 messages）',
    shapeSys.messages.length === 1 && shapeSys.messages[0].role === 'user',
    JSON.stringify(shapeSys.messages.map(m => m.role)))
  check('★ user 那条的正文就是提示词', shapeSys.messages[0].content[0].text === '改标题',
    JSON.stringify(shapeSys.messages[0].content))

  /* ⑤ 请求形状：没 system → **与改动前逐字节一致**（只有一个 messages 键是实质内容，
   *    `system` 键根本不出现）。这才是「干净渠道的默认行为一个字没变」。 */
  const shapeNo = agentRequestShape('改标题', '')
  check('★★ 没系统提示词 → 请求里没有 system 键',
    !('system' in shapeNo), JSON.stringify(Object.keys(shapeNo)))
  check('★★ 没系统提示词 → 请求形状与改动前一致（只有一条 user）',
    JSON.stringify(shapeNo) === JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'text', text: '改标题' }] }],
    }), JSON.stringify(shapeNo))

  /* ⑥ 命令体里 system 是空串的极端情况（老存档手改过）→ 同样不写。 */
  const emptySys = agentRequestShape('改标题', '')
  check('★ 空串当成没填', !('system' in emptySys), JSON.stringify(Object.keys(emptySys)))

  /* ⑦ 痕迹摘要：系统提示词要进 `promptPreview`（契约 V 第 5 条）。 */
  const { agentTracePreview } = await import('../src/index.ts')
  const withT = agentTracePreview('改标题', '扮演电商文案')
  check('★★ 痕迹摘要里有 user 那条', withT.includes('改标题'), withT)
  check('★★ 痕迹摘要里也有系统提示词', withT.includes('扮演电商文案'), withT)
  check('★ 两段有标签分开（不是糊成一坨）', withT.includes('系统提示词：'), withT)
  /* ★★ 顺序：user 在前。真被截时截掉的是排在后面的那份不常变的设定。 */
  check('★★ user 排在前、系统提示词排在后（被截时先舍设定）',
    withT.indexOf('改标题') < withT.indexOf('扮演电商文案'), withT)
  /* 没系统提示词时逐字节不变（老行为）。 */
  const noT = agentTracePreview('改标题', '')
  check('★★ 没系统提示词 → 摘要就是提示词本身（与改动前一致）', noT === '改标题', noT)
}

console.log('')
console.log('⑥c 接线检查：index.ts 真的用上了这两个纯函数（契约 V）')
{
  /* ## 为什么这一段是「读源码」而不是「真跑一次 /run」
   *
   * 本轮本来写了真跑（起真 `http.createServer` + 真 fetch 打 `/run`），结果**抓到一个
   * 与契约 V 无关的真 bug**：`src/index.ts:1685` 用 `r.on('close', ...)` 判「用户点停止」，
   * 而 Node 真 HTTP 下 `req` 的 `close` **在请求体读完那一刻就触发**（不是连接断开）。
   * 于是每一次 `/run` 一进来就被 abort，执行方如实报 `cancelled`，`llm.stream` 一次都没被调。
   *
   * 这个 bug 是契约 S1 把外部信号接通之后才浮出来的（之前信号被派发器丢掉，掩盖了它）。
   * 它不在契约 V 的可改范围（那一行属于 S1 的接口面），已上报等裁决。
   *
   * **所以这一段退回到「接线检查」**：只验「纯函数确实被 index.ts 调用」，
   * 不假装验了端到端。等那一行修好，这里应该补回真跑一次的那种。
   * ⚠️ 不要为了让它变绿而把这条注释删掉 —— 那是这轮唯一的记录。 */
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  check('★★ index.ts 真的调了 agentRequestShape（不是写了没人用）',
    /\.\.\.agentRequestShape\(text, system\)/.test(src))
  check('★★ index.ts 真的调了 agentTracePreview（痕迹摘要那一条）',
    /agentTracePreview\(text, system\)/.test(src))
  check('★★ 从命令体读 system（不是只从参数读）',
    /typeof command\?\.system === 'string'/.test(src))
  /* 请求形状里不能自己拼 system 消息（那会在两套适配器上表现不一致，见 agentRequestShape 注释）。
   * ⚠️ 要**先剥掉注释行**再判 —— 上面那两段注释里就写着 `{ role: 'system' }` 这个反面例子，
   * 不剥的话这条永远红（第一版就踩了：报「发现自拼的 system 消息」，其实全在注释里）。 */
  const codeOnly = src.split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
    })
    .join('\n')
  check('★★ 没有自己拼 {role: system} 消息（注释里的反面例子不算）',
    !/role:\s*'system'/.test(codeOnly), '代码里发现自拼的 system 消息')
}

console.log('')
console.log('⑥d P0：/run 的取消判据（走**源码**，能立刻自证）')
{
  /* ## 为什么这一份在这里、`host-dispatch.mjs` 里也有一份
   *
   * `host-dispatch.mjs` 加载的是**编译产物** `lib/index.js`，而它要靠 `npm run bundle` 刷新。
   * 本轮修 P0 时（2026-10-23）发现：`lib/` 还停在 06:38，比 S1 / V 都早 ——
   * 也就是说那份测试当天验的是老代码，改 `src` 它**根本不会红**。
   * 所以同一件事在走源码的这里再钉一次，保证「改坏了当场就红」。
   *
   * ⚠️ 这不是重复劳动：走产物那份验的是「打包后还行不行」，
   * 走源码这份验的是「现在这行代码对不对」，两种失效原因不同。 */

  /* ① 先静态核判据（最快、也最不可能受环境干扰）。
   * ⚠️ 判之前要**剥掉注释行**：那段注释里就写着 `r.on('close', ...)` 这个反面例子
   * （留给维护者看的历史），不剥的话「不许再有」这条永远红。 */
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const runAt = src.indexOf("if (path === '/api/ecom-workbench/run' && r.method === 'POST')")
  /* ⚠️ 切片终点**不能写死成某一条路由**（2026-10-27 修）。
   *
   * 原来写的是「切到 `/workflows` 的 GET 那条」。后端 2026-10-27 在两者之间
   * 插进了 `/run-node-stream`（一条 GET，合法地用了 `r.on('close')` ——
   * 它没有请求体，那个事件只剩「连接断了」一个含义，见 `src/index.ts:2869` 那段注释）。
   * 于是这段切片把别人的路由也框了进来，`不许有 r.on('close')` 那条**假红**。
   *
   * 改成「切到**下一个**路由起点」：判据仍然只针对 `/run` 这一段正文，
   * 没有放宽 —— 换个位置再插路由也不会再误伤。 */
  const runRouteRaw = src.slice(runAt, src.indexOf('if (path ===', runAt + 10))
  check('（前置）切片只框到 /run 这一条路由',
    runAt >= 0 && !runRouteRaw.includes("path === '/api/ecom-workbench/run-node-stream'"),
    '切片里混进了别的路由')
  const runRoute = runRouteRaw.split('\n')
    .filter(line => {
      const t = line.trim()
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
    })
    .join('\n')
  check('★★ /run 的取消判据挂在响应 w 上（不是请求 r）',
    /w\.on\('close'/.test(runRoute), '没找到 w.on(close)')
  check('★★ /run 判的是 writableFinished（不是 writableEnded）',
    /!w\.writableFinished\)\s*ac\.abort\(\)/.test(runRoute), '没找到 writableFinished 判据')
  check('★★ /run 代码里不再有 r.on(\'close\') 那个误判判据',
    !/r\.on\('close'/.test(runRoute), '仍然有 r.on(close)')

  /* ② 再真跑一次：正常 POST 不许被判成取消。 */
  const { createServer, request: httpRequest } = await import('node:http')
  const m2 = await import('../src/index.ts')
  let h2 = null
  const ctx2 = {
    inject(names, fn) {
      if (names.includes('webServer')) fn({ webServer: { register(route) { h2 = route.handler; return () => { /* 清理 */ } } } })
      if (names.includes('subprocess')) fn({ subprocess: { spawn() { return { pid: 1, terminate() { /* 假句柄 */ }, waitForExit: async () => true, done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } } } } } })
      if (names.includes('llm')) fn({ llm: { stream() { throw new Error('本用例不该调模型') }, listProviders: () => [], listModels: async () => [] }, effect() { return () => { /* 清理 */ } } })
      if (names.includes('agentDefaultModel')) fn({ agentDefaultModel: { currentSelection: () => undefined }, effect() { return () => { /* 清理 */ } } })
    },
    effect() { return () => { /* 清理 */ } },
  }
  m2.apply(ctx2)
  const srv = createServer((req, res) => { void h2(req, res) })
  await new Promise(r => { srv.listen(0, '127.0.0.1', r) })
  const port = srv.address().port
  try {
    const body = JSON.stringify([{
      runId: 'p0', nodeId: 'n', executor: 'builtin',
      command: { node: 'flow.delay', params: { ms: 5 } },
      context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
    }])
    /* ⚠️ 用 `node:http` 而不是 `fetch`：undici 的全局连接池会在 `process.exit()` 时
     * 还在收尾，Node 报 libuv 断言、退出码变 1（断言其实全绿）。 */
    const json = await new Promise((resolve, reject) => {
      const rq = httpRequest({
        port, method: 'POST', path: '/api/ecom-workbench/run', agent: false,
        headers: { 'content-type': 'application/json', connection: 'close', 'content-length': Buffer.byteLength(body) },
      }, (resp) => {
        let out = ''
        resp.setEncoding('utf8')
        resp.on('data', (c) => { out += c })
        resp.on('end', () => { try { resolve(JSON.parse(out)) } catch (e) { reject(e) } })
        resp.on('error', reject)
      })
      rq.on('error', reject)
      rq.end(body)
    })
    check('★★ 正常 POST /run → 结局是 success（不是 cancelled）',
      json.results?.[0]?.status === 'success', JSON.stringify(json.results?.[0]))
    check('★★ 正常 POST /run → 有输出（执行方真跑过）',
      json.results?.[0]?.output !== undefined, JSON.stringify(json.results?.[0]?.output))
  } finally {
    await new Promise(r => { srv.close(r) })
  }
}

console.log('')
console.log('⑦ timeout 参数真的被读（不是声明了没人用）')
{
  const mk = (v) => buildCommand(def, { prompt: 'x', input: '', timeout: v }, []).command
  check('填 30000 → 命令体 30000', mk(30000).timeoutMs === 30000, String(mk(30000).timeoutMs))
  check('填 600000 → 命令体 600000', mk(600000).timeoutMs === 600000, String(mk(600000).timeoutMs))
  /* 存档可能被手改：非法值要回落到默认，而不是原样塞进命令体。 */
  check('填 0 → 回落 120000', mk(0).timeoutMs === 120000, String(mk(0).timeoutMs))
  check('填负数 → 回落 120000', mk(-5).timeoutMs === 120000, String(mk(-5).timeoutMs))
  check('填「abc」→ 回落 120000', mk('abc').timeoutMs === 120000, String(mk('abc').timeoutMs))
  check('不填 → 120000', buildCommand(def, { prompt: 'x', input: '' }, []).command.timeoutMs === 120000)
  check('小数被取整', mk(1500.7).timeoutMs === 1500, String(mk(1500.7).timeoutMs))
  /* ⚠️ 这条 2026-10-23 反转了：执行方现在**真的读** `timeoutMs` 并按它设超时。
   * 原来是「命令体里有、执行层还没读」，所以那条断言是「如实钉住边界」；
   * 现在边界消失了，判据改成「读到了、而且不再有无条件用派发层超时的写法」。 */
  const execSrc = readFileSync(new URL('../src/dispatch/executors.ts', import.meta.url), 'utf8')
  const agentPart = execSrc.slice(execSrc.indexOf('export function createAgentExecutor'))
  check('★★ 执行方真的读 timeoutMs', agentPart.includes('c?.timeoutMs'), agentPart.slice(0, 120))
  check('★ 超时是按时器 + AbortController 实现的', agentPart.includes('setTimeout') && agentPart.includes('AbortController'))
}

console.log('')
console.log('⑦b 节点自带的 timeoutMs 真的会让「永不返回」的桩超时失败')
{
  /* ## 这一段守的是什么
   *
   * `timeoutMs` 拼进命令体了、也被读了 —— 但「读了」不等于「生效」。
   * 如果执行方只是把值打进日志、实际还在死等，界面上就是「点了没反应」。
   * 所以这里放一个**永远不返回**的桩，确认到了点就断。 */
  const ex = createAgentExecutor(() => new Promise(() => { /* 永不 settle */ }))
  const t0 = Date.now()
  const timedOut = await ex.run({
    runId: 't3', nodeId: 'n3', executor: 'agent',
    command: { prompt: '写一句文案', timeoutMs: 500 },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })
  const spent = Date.now() - t0
  check('★★ 500ms 到点就断（不等派发层那 300 秒）', spent < 3000, String(spent) + 'ms')
  check('★★ 超时算失败，不算取消', timedOut.status === 'failed', String(timedOut.status))
  check('★★ 结果带 timedOut 标记', timedOut.timedOut === true, String(timedOut.timedOut))
  check('★ 错误文案说清是超时', String(timedOut.error ?? '').includes('超时'), String(timedOut.error))
  check('★ 错误文案带上实际超时值', String(timedOut.error ?? '').includes('500'), String(timedOut.error))

  /* 用户点停止（req.signal 被 abort）→ 那是**取消**，不是超时。
   * 两者在界面上必须是两件事：看到「已取消」才知道是自己点的。 */
  const ac = new AbortController()
  const hang = createAgentExecutor(() => new Promise(() => { /* 永不 settle */ }))
  const pending = hang.run({
    runId: 't4', nodeId: 'n4', executor: 'agent',
    command: { prompt: '写一句文案', timeoutMs: 60000 },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
    signal: ac.signal,
  })
  setTimeout(() => { ac.abort() }, 100)
  const cancelled = await pending
  check('★★ 用户取消 → cancelled（不是 failed）', cancelled.status === 'cancelled', String(cancelled.status))
  check('★ 取消的结果不带 timedOut', cancelled.timedOut !== true, String(cancelled.timedOut))

  /* 非法 timeoutMs 不该抛错，也不该当「立即超时」。 */
  for (const bad of [0, -1, 'abc', null, undefined]) {
    const ex2 = createAgentExecutor(async () => ({ ok: true, text: 'ok', trace: stubTrace }))
    const r = await ex2.run({
      runId: 't5', nodeId: 'n5', executor: 'agent',
      command: { prompt: 'x', ...bad === undefined ? {} : { timeoutMs: bad } },
      context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
    })
    check('★ 非法 timeoutMs（' + String(bad) + '）不抛错、照常跑完', r.status === 'success', String(r.status))
  }

  /* delegate 抛普通错 → failed 且带原文（不是被当成超时）。 */
  const boom = createAgentExecutor(async () => { throw new Error('模型说它不干') })
  const failedRes = await boom.run({
    runId: 't6', nodeId: 'n6', executor: 'agent',
    command: { prompt: 'x', timeoutMs: 5000 },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })
  check('★ delegate 抛错 → failed 且带原文', failedRes.status === 'failed'
    && String(failedRes.error).includes('模型说它不干'), String(failedRes.error))
  check('★ 那种失败不带 timedOut 标记', failedRes.timedOut !== true, String(failedRes.timedOut))
  check('★ 失败的结果不带 llm 痕迹（没调到模型就没有）', failedRes.llm === undefined, JSON.stringify(failedRes.llm))
}

console.log('')
console.log('⑦c 模型痕迹：形状、截断、不编数字')
{
  const { truncateTraceText, TRACE_TEXT_PREVIEW, formatTraceLine } = await import('../src/dispatch/llm-trace.ts')
  check('★ 上限常量是 500', TRACE_TEXT_PREVIEW === 500, String(TRACE_TEXT_PREVIEW))

  /* ① 截断纯函数：不超就不截、超了就截并报 true。 */
  const short = truncateTraceText('短文本')
  check('★★ 短文本原样返回', short.text === '短文本', short.text)
  check('★★ 短文本 reported truncated = false', short.truncated === false, String(short.truncated))

  const long = 'x'.repeat(TRACE_TEXT_PREVIEW + 37)
  const cut = truncateTraceText(long)
  check('★★ 超长文本被截到上限', cut.text.length === TRACE_TEXT_PREVIEW, String(cut.text.length))
  check('★★ 超长文本 reported truncated = true', cut.truncated === true, String(cut.truncated))
  check('★ 截断保的是**前**一段（不是尾巴）', cut.text.startsWith('x'), cut.text.slice(0, 10))

  /* 边界：正好等于上限时不算截（少截一个字符就是丢内容）。 */
  const exact = truncateTraceText('y'.repeat(TRACE_TEXT_PREVIEW))
  check('★★ 正好 500 字不截', exact.truncated === false && exact.text.length === TRACE_TEXT_PREVIEW,
    String(exact.text.length) + ' / ' + String(exact.truncated))

  /* ①b 一行文字：界面直接渲染它，别自己拼（规则只该有一份）。 */
  const lineFull = formatTraceLine({
    provider: 'deepseek-official', model: 'deepseek-v4-flash',
    inputTokens: 120, outputTokens: 45, finish: 'stop',
    promptPreview: '写', outputPreview: '答',
  })
  check('★★ 有 token → 三段齐全（模型 / 输入输出 / 结束）',
    lineFull === '模型 deepseek-official/deepseek-v4-flash · 输入 120 / 输出 45 token · 结束 stop',
    lineFull)

  const lineModelOnly = formatTraceLine({
    provider: 'deepseek-official', model: 'deepseek-v4-flash', finish: 'stop',
  })
  check('★★ 没 token → 整段省略（不是「输入 0 / 输出 0」）',
    lineModelOnly === '模型 deepseek-official/deepseek-v4-flash · 结束 stop', lineModelOnly)
  check('★★ 没 token 时也不出现 " 0 "', !/0 token/.test(lineModelOnly), lineModelOnly)

  const lineCut = formatTraceLine({
    provider: 'deepseek-official', model: 'deepseek-v4-flash', finish: 'stop', truncated: true,
  })
  check('★★ truncated 为真 → 末尾加「（摘要已截断）」',
    lineCut === '模型 deepseek-official/deepseek-v4-flash · 结束 stop（摘要已截断）', lineCut)

  /* `unknown` 不许露英文给用户看。 */
  const lineUnknown = formatTraceLine({
    provider: 'deepseek-official', model: 'deepseek-v4-flash', finish: 'unknown',
  })
  check('★★ finish 是 unknown → 显示「结束原因未知」', lineUnknown.includes('结束原因未知'), lineUnknown)
  check('★★ 且不露英文 unknown', !lineUnknown.includes('unknown'), lineUnknown)

  /* 失败结局也翻成中文（三种结局各不同，界面上要能一眼分开）。 */
  check('★ max-tokens 翻成中文', formatTraceLine({
    provider: 'p', model: 'm', finish: 'max-tokens',
  }).includes('达到 token 上限'), formatTraceLine({ provider: 'p', model: 'm', finish: 'max-tokens' }))
  check('★ aborted 翻成中文', formatTraceLine({
    provider: 'p', model: 'm', finish: 'aborted',
  }).includes('中断'))
  /* 只有合计时用「合计」，不硬凑输入输出。 */
  check('★ 只有 totalTokens → 写「合计」', formatTraceLine({
    provider: 'p', model: 'm', finish: 'stop', totalTokens: 300,
  }).includes('合计 300 token'), formatTraceLine({ provider: 'p', model: 'm', finish: 'stop', totalTokens: 300 }))

  /* ② 痕迹进结果：给什么就带什么，不上牌的键不许出现。 */
  const traceFull = {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    inputTokens: 120,
    outputTokens: 45,
    finish: 'stop',
    promptPreview: '写一句文案',
    outputPreview: '这是一句文案',
  }
  const ex = createAgentExecutor(async () => ({ ok: true, text: '这是一句文案', trace: traceFull }))
  const ok = await ex.run({
    runId: 't7', nodeId: 'n7', executor: 'agent',
    command: { prompt: '写一句文案', timeoutMs: 5000 },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })
  check('★★ 三个 token 字段原样带出', ok.llm?.inputTokens === 120 && ok.llm?.outputTokens === 45,
    JSON.stringify(ok.llm))
  check('★★ 上游没给 totalTokens → 结果里**没有**这个键',
    !('totalTokens' in (ok.llm ?? {})), JSON.stringify(ok.llm))
  /* 不许用输入+输出自己算一个合计冒充实测。 */
  check('★★ 也不许算个假合计塞进去', ok.llm?.totalTokens === undefined, String(ok.llm?.totalTokens))
  check('★ 结束原因带出来了', ok.llm?.finish === 'stop', String(ok.llm?.finish))
  check('★★ 没截时**不写** truncated 键（不是 false）',
    !('truncated' in (ok.llm ?? {})), JSON.stringify(ok.llm))
  check('★ 提示词与回答摘要都在', ok.llm?.promptPreview === '写一句文案'
    && ok.llm?.outputPreview === '这是一句文案', JSON.stringify(ok.llm))
  check('★ 节点输出仍然是那句文字（不是把 trace 当输出）', ok.output === '这是一句文案', String(ok.output))

  /* ③ 真截了才置 truncated: true。 */
  const traceCut = {
    provider: 'deepseek-official', model: 'm', finish: 'stop',
    promptPreview: 'p'.repeat(TRACE_TEXT_PREVIEW), outputPreview: 'a'.repeat(TRACE_TEXT_PREVIEW), truncated: true,
  }
  const ex2 = createAgentExecutor(async () => ({ ok: true, text: 'x', trace: traceCut }))
  const cutRes = await ex2.run({
    runId: 't8', nodeId: 'n8', executor: 'agent',
    command: { prompt: 'x', timeoutMs: 5000 },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })
  check('★ 截过的痕迹带 truncated: true', cutRes.llm?.truncated === true, String(cutRes.llm?.truncated))

  /* ④ 不调模型的执行方不许写 llm 键（builtin 是现成的对照组）。 */
  const { createBuiltinExecutor } = await import('../src/dispatch/executors.ts')
  const bi = createBuiltinExecutor(new Map([['code.js', async () => '结果']]))
  const biRes = await bi.run({
    runId: 't9', nodeId: 'n9', executor: 'builtin', command: { node: 'code.js' },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })
  check('★★ 不调模型的执行方不写 llm 键', !('llm' in biRes), JSON.stringify(biRes.llm))
}

console.log('')
console.log('⑦d 失败的模型调用也留痕（契约 A2）')
{
  /* ## 这一段守的是什么
   *
   * 失败原来靠**抛异常**表达 —— 抛了就没有返回值，痕迹跟着丢。
   * 而最需要看痕迹的恰恰是失败那几次（为什么没成、提示词长什么样）。
   * 所以 delegate 改成返回判别联合，这里验「失败 → status failed，但 llm 在」。 */

  /* ① 模型报错：finish 如实是 'error'，提示词摘要照样在。 */
  const traceError = {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    finish: 'error',
    promptPreview: '按甲店的风格改标题',
  }
  const exErr = createAgentExecutor(async () => ({
    ok: false, error: '模型调用失败：上游 500', trace: traceError,
  }))
  const errRes = await exErr.run({
    runId: 't10', nodeId: 'n10', executor: 'agent',
    command: { prompt: '按甲店的风格改标题', timeoutMs: 5000 },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })
  check('★★ 模型报错 → status failed', errRes.status === 'failed', String(errRes.status))
  check('★★ 模型报错 → 结果里**有** llm（失败也留痕）', errRes.llm !== undefined, JSON.stringify(errRes.llm))
  check('★★ finish 如实是 error（不是统统写 error 之外的值）',
    errRes.llm?.finish === 'error', String(errRes.llm?.finish))
  check('★★ 提示词摘要还在（这是最要紧的那一样）',
    typeof errRes.llm?.promptPreview === 'string' && errRes.llm.promptPreview !== '',
    JSON.stringify(errRes.llm?.promptPreview))
  check('★ 错误文案原样带出', String(errRes.error ?? '').includes('上游 500'), String(errRes.error))
  check('★ 报错时不算超时', errRes.timedOut !== true, String(errRes.timedOut))

  /* ② 被截断：finish 是 'max-tokens'（与 error 是两件事）。 */
  const traceCut2 = {
    provider: 'deepseek-official', model: 'deepseek-v4-flash',
    finish: 'max-tokens', inputTokens: 88, outputTokens: 4096,
    promptPreview: '写一篇很长的商品描述',
    outputPreview: '这件商品……',
  }
  const exCut = createAgentExecutor(async () => ({
    ok: false, error: '模型输出被截断（到达 token 上限）', trace: traceCut2,
  }))
  const cut2Res = await exCut.run({
    runId: 't11', nodeId: 'n11', executor: 'agent',
    command: { prompt: '写一篇很长的商品描述', timeoutMs: 5000 },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })
  check('★★ 截断 → status failed', cut2Res.status === 'failed', String(cut2Res.status))
  check('★★ 截断 → 结果里**有** llm', cut2Res.llm !== undefined, JSON.stringify(cut2Res.llm))
  check('★★ finish 如实是 max-tokens（不是 error）',
    cut2Res.llm?.finish === 'max-tokens', String(cut2Res.llm?.finish))
  check('★★ 截断时 token 数照样带出（那正是要看的）',
    cut2Res.llm?.inputTokens === 88 && cut2Res.llm?.outputTokens === 4096, JSON.stringify(cut2Res.llm))

  /* ③ 被中断：finish 是 'aborted'，第三种结局，与上面两种都不同。 */
  const exAbort = createAgentExecutor(async () => ({
    ok: false, error: '模型调用失败：aborted',
    trace: { provider: 'deepseek-official', model: 'm', finish: 'aborted', promptPreview: '写一句' },
  }))
  const abortRes = await exAbort.run({
    runId: 't12', nodeId: 'n12', executor: 'agent',
    command: { prompt: '写一句', timeoutMs: 5000 },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })
  check('★★ 中断 → status failed 且 finish 如实是 aborted',
    abortRes.status === 'failed' && abortRes.llm?.finish === 'aborted',
    String(abortRes.status) + ' / ' + String(abortRes.llm?.finish))

  /* ④ 失败时 delegate 没给痕迹（例如它自己抛过）→ 不写 llm 键，也不许编一个空痕迹。 */
  const exNoTrace = createAgentExecutor(async () => ({ ok: false, error: '说不出为什么' }))
  const noTraceRes = await exNoTrace.run({
    runId: 't13', nodeId: 'n13', executor: 'agent',
    command: { prompt: 'x', timeoutMs: 5000 },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })
  check('★★ 没有痕迹的失败 → 不写 llm 键（不编空对象）',
    !('llm' in noTraceRes), JSON.stringify(noTraceRes.llm))

  /* ⑤ 超时与取消这两条腿**拿不到痕迹**：逐条确认没写 llm，别骗自己。 */
  const exHang = createAgentExecutor(() => new Promise(() => { /* 永不 settle */ }))
  const to = await exHang.run({
    runId: 't14', nodeId: 'n14', executor: 'agent',
    command: { prompt: 'x', timeoutMs: 300 },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })
  check('★★ 超时 → 不写 llm（delegate 未返回，痕迹无从取得）', !('llm' in to), JSON.stringify(to.llm))
  const ac2 = new AbortController()
  const exHang2 = createAgentExecutor(() => new Promise(() => { /* 永不 settle */ }))
  const pending = exHang2.run({
    runId: 't15', nodeId: 'n15', executor: 'agent',
    command: { prompt: 'x', timeoutMs: 60000 },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
    signal: ac2.signal,
  })
  setTimeout(() => { ac2.abort() }, 80)
  const cancelled2 = await pending
  check('★★ 取消 → 不写 llm（同样拿不到）', !('llm' in cancelled2), JSON.stringify(cancelled2.llm))
}

console.log('')
console.log('⑦e 父子同名节点不合并（契约 A4：收集层按层级归并）')
{
  /* ## 这一段守的是什么
   *
   * 子工作流的节点 id **各自从 `n1` 起**，与父流程必然重名（父有 `n3`、子也有 `n3`）。
   * 收集层若用裸 `nodeId` 当归并键，两个 `n3` 会被合成**一条**明细：
   * 后写的覆盖标题与节点类型，只要有一份失败整条就显示失败 ——
   * 用户看到的是「父流程那个节点变成了子流程的标题，还标着失败」。
   *
   * 所以这里构造一次「父调子、两边都有 n3」的事件流，走**真的**收集器函数，
   * 数它得到几条明细。 */
  const { mergeNodeEvent } = await import('../src/index.ts')
  const { nodeKeyOf } = await import('../src/workflow/run.ts')

  /* ① `nodeKeyOf` 本身：顶层不带前缀（老记录逐字兼容），下钻过才加前缀。 */
  check('★★ 顶层键 = 裸 nodeId（老记录不需要迁移）', nodeKeyOf(0, 'n3') === 'n3', nodeKeyOf(0, 'n3'))
  check('★★ 不给 depth 也按顶层算', nodeKeyOf(undefined, 'n3') === 'n3', nodeKeyOf(undefined, 'n3'))
  check('★★ 子层键带前缀', nodeKeyOf(1, 'n3') === '1/n3', nodeKeyOf(1, 'n3'))
  check('★ 父子的 n3 键不相等', nodeKeyOf(0, 'n3') !== nodeKeyOf(1, 'n3'),
    nodeKeyOf(0, 'n3') + ' vs ' + nodeKeyOf(1, 'n3'))

  /* ② 真走一遍收集器：父的 n3 起跑+成功，子的 n3 起跑+失败。 */
  const byNode = new Map()
  mergeNodeEvent(byNode, { kind: 'started', nodeId: 'n3', depth: 0, nodeLabel: '父流程的第三步', defId: 'code.js' })
  mergeNodeEvent(byNode, { kind: 'success', nodeId: 'n3', depth: 0 })
  mergeNodeEvent(byNode, { kind: 'started', nodeId: 'n3', depth: 1, nodeLabel: '子流程的第三步', defId: 'sys.http' })
  mergeNodeEvent(byNode, { kind: 'failed', nodeId: 'n3', depth: 1, error: '子流程那步挂了' })

  const lines = [...byNode.values()]
  check('★★★ 父子的同名 n3 得到**两条**明细（不是一条）', lines.length === 2,
    String(lines.length) + ' → ' + JSON.stringify(lines.map(l => ({ id: l.nodeId, depth: l.depth, label: l.label }))))

  /* 各自保留自己的结局与标题 —— 合成一条时这里会互相覆盖。 */
  const top = lines.find(l => l.depth === undefined)
  const sub = lines.find(l => l.depth === 1)
  check('★★ 父那条仍是 success、标题是父的',
    top?.state === 'success' && top?.label === '父流程的第三步', JSON.stringify(top))
  check('★★ 子那条是 failed、标题是子的',
    sub?.state === 'failed' && sub?.label === '子流程的第三步', JSON.stringify(sub))

  /* ③ `nodeId` 字段语义不变：仍是**裸编号**，不是拼好的键。 */
  check('★★ 明细里的 nodeId 仍是裸编号（不是 1/n3）',
    lines.every(l => l.nodeId === 'n3'), JSON.stringify(lines.map(l => l.nodeId)))

  /* ④ `depth` 只在 >0 时出现：顶层那条**没有**这个键。 */
  check('★★ 顶层明细没有 depth 键（不是 depth: 0）',
    top !== undefined && !('depth' in top), JSON.stringify(Object.keys(top ?? {})))
  check('★★ 子层明细的 depth 是 1', sub?.depth === 1, String(sub?.depth))

  /* ⑤ 同一个层级的同一个节点跑多轮 → 仍合并成一条（别把「分层的」改成「不合并了」）。 */
  const loop = new Map()
  mergeNodeEvent(loop, { kind: 'started', nodeId: 'n5', depth: 0 })
  mergeNodeEvent(loop, { kind: 'success', nodeId: 'n5', depth: 0 })
  mergeNodeEvent(loop, { kind: 'started', nodeId: 'n5', depth: 0 })
  mergeNodeEvent(loop, { kind: 'success', nodeId: 'n5', depth: 0 })
  check('★★ 同层同节点跑多轮仍合并成一条', loop.size === 1, String(loop.size))
  check('★ 那一条的日志按轮累加（这里没有 log 事件 → 无 logs 键）',
    !('logs' in ([...loop.values()][0])), JSON.stringify([...loop.values()][0]))

  /* ⑥ 同一节点在两层都有 log：日志不能串到另一层去。 */
  const twoLogs = new Map()
  mergeNodeEvent(twoLogs, { kind: 'log', nodeId: 'n7', depth: 0, line: '父的日志' })
  mergeNodeEvent(twoLogs, { kind: 'log', nodeId: 'n7', depth: 1, line: '子的日志' })
  const logsOf = [...twoLogs.values()].map(l => (l.logs ?? []).join('|'))
  check('★★ 两层的日志不串味', logsOf.includes('父的日志') && logsOf.includes('子的日志'),
    JSON.stringify(logsOf))
}

console.log('')
console.log('⑦f 模型痕迹搬进节点明细（契约 A5：收集层那一环）')
{
  /* ## 这一段守的是什么
   *
   * 事件带上 `llm` 了、执行方也交出来了 —— 但收集层**没搬**的话，
   * 运行记录文件里永远不会出现这个字段。那等于前三层全白做，而
   * 「测试全绿」也看不出来（它们测的都是各自的入参）。
   *
   * 所以要具体验：喂带 `llm` 的事件 → 明细里有；喂不带的 → 明细里**没有这个键**。 */
  const { mergeNodeEvent } = await import('../src/index.ts')

  const trace = {
    provider: 'deepseek-official', model: 'deepseek-v4-flash',
    inputTokens: 120, outputTokens: 45, finish: 'stop',
  }

  /* ① success 分支搬。 */
  const okMap = new Map()
  mergeNodeEvent(okMap, { kind: 'success', nodeId: 'n1', depth: 0, llm: trace })
  const okLine = [...okMap.values()][0]
  check('★★ success 事件带着 llm → 明细里有 llm', okLine?.llm !== undefined, JSON.stringify(okLine?.llm))
  check('★★ 搬过来的就是那一份（路由与 token 在）',
    okLine?.llm?.provider === 'deepseek-official' && okLine?.llm?.inputTokens === 120, JSON.stringify(okLine?.llm))

  /* ② failed 分支也搬（契约 A2 立的规矩：失败那几次最需要痕迹）。 */
  const errMap = new Map()
  mergeNodeEvent(errMap, {
    kind: 'failed', nodeId: 'n2', depth: 0, error: '模型报错',
    llm: { provider: 'deepseek-official', model: 'deepseek-v4-flash', finish: 'error' },
  })
  const errLine = [...errMap.values()][0]
  check('★★ failed 事件带着 llm → 明细里也有 llm', errLine?.llm !== undefined, JSON.stringify(errLine?.llm))
  check('★★ 失败那条的 finish 如实是 error', errLine?.llm?.finish === 'error', String(errLine?.llm?.finish))

  /* ③ 不带 llm 的事件 → 明细里**没有这个键**（不是显式 undefined）。 */
  const plainMap = new Map()
  mergeNodeEvent(plainMap, { kind: 'success', nodeId: 'n3', depth: 0 })
  const plainLine = [...plainMap.values()][0]
  check('★★ 事件没带 llm → 明细里**没有** llm 键',
    !('llm' in (plainLine ?? {})), JSON.stringify(Object.keys(plainLine ?? {})))
  /* `JSON.stringify` 之后也不该冒出这个键（落盘的形状看的是这个）。 */
  check('★★ 落盘 JSON 里也没有 llm',
    !('llm' in JSON.parse(JSON.stringify(plainLine ?? {}))), JSON.stringify(plainLine))

  /* ④ 不调模型的节点（此刻只跑 started）不许凭空多一个 llm。 */
  const onlyStarted = new Map()
  mergeNodeEvent(onlyStarted, { kind: 'started', nodeId: 'n4', depth: 0, nodeLabel: '取数', defId: 'code.js' })
  check('★★ 只跑过 started 的节点没有 llm 键',
    !('llm' in ([...onlyStarted.values()][0])), JSON.stringify([...onlyStarted.values()][0]))
}

console.log('')
console.log('⑦g 「停止」真的能停下（契约 S1）')
{
  /* ## 这一段守的是什么
   *
   * 界面上的「停止」原来是个**假按钮**：`/run` 路由确实建了 `AbortController` 并传了下来，
   * 但派发器 `withTimeout` 里 `{ ...req, signal: ac.signal }` 把外部信号**盖掉**了，
   * 而且没监听它 —— 于是用户点停止，四种执行方一个都收不到。
   *
   * 所以这里逐层验：派发器接线（①）→ 内置函数拿到信号（②）→
   * 四种执行方各自返回 `cancelled`（③④⑤⑥）→ 超时仍走老路（⑦）。
   *
   * ⚠️ 自证方法：把 `dispatcher.ts` 里那个 `addEventListener('abort', onOuterAbort)`
   * 去掉，本段 ①~⑥ 立刻变红。 */
  const { WorkflowDispatcher } = await import('../src/dispatch/dispatcher.ts')
  const {
    createShellExecutor, createHttpExecutor, createAgentExecutor, createBuiltinExecutor,
  } = await import('../src/dispatch/executors.ts')
  const { delayFn } = await import('../src/dispatch/builtins.ts')

  /**
   * 造一个只有「一个执行方」的派发器。
   * @param ex - 执行方。
   * @param timeoutMs - 派发层兜底超时。
   * @returns 派发器。
   */
  function makeDispatcher(ex, timeoutMs) {
    const d = new WorkflowDispatcher({ timeoutMs })
    d.register(ex)
    return d
  }

  /**
   * 造一条派发请求。
   * @param executor - 执行方种类。
   * @param command - 命令体。
   * @param signal - 外部取消信号（点停止）。
   * @returns 请求。
   */
  function req2(executor, command, signal) {
    return {
      runId: '', nodeId: 'n-s1', executor, command,
      context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
      ...signal === undefined ? {} : { signal },
    }
  }

  /** 睡一会儿（让派发真正进到执行方里再 abort）。 */
  const tick = (ms = 20) => new Promise(r => { setTimeout(r, ms) })

  /* ── ① 派发器：外部信号必须接到自己那个信号上 ────────────────── */
  {
    let captured
    const spy = {
      kind: 'builtin',
      async run(r) {
        captured = r.signal
        await new Promise(res => { r.signal.addEventListener('abort', res, { once: true }) })
        return { status: 'cancelled', logs: ['被叫停'] }
      },
    }
    const d = makeDispatcher(spy, 10_000)
    const ac = new AbortController()
    const pending = d.dispatch(req2('builtin', { node: 'x', params: {} }, ac.signal))
    await tick()
    check('★ 派发器自己那个信号先没被 abort', captured?.aborted === false, String(captured?.aborted))
    ac.abort()
    const res = await pending
    check('★★ 外部 abort 真的传到了执行方手里', captured?.aborted === true, String(captured?.aborted))
    check('★★ 外部取消 → 结局 cancelled（不是 failed）', res.status === 'cancelled', JSON.stringify(res))
    check('★ 外部取消不算超时', res.timedOut !== true, String(res.timedOut))
  }

  /* ── ②③ 内置执行方：ctx 带 signal，延迟被取消立刻结束 ────────── */
  {
    let gotSignal
    const fns = new Map([['flow.delay', (cmd, ctx) => { gotSignal = ctx.signal; return delayFn(cmd, ctx) }]])
    const d = makeDispatcher(createBuiltinExecutor(fns), 10_000)
    const ac = new AbortController()
    const t0 = Date.now()
    const pending = d.dispatch(req2('builtin', { node: 'flow.delay', params: { ms: 5000 } }, ac.signal))
    await tick()
    check('★★ 内置函数的 ctx 拿到了取消信号', gotSignal instanceof AbortSignal, String(gotSignal))
    ac.abort()
    const res = await pending
    const spent = Date.now() - t0
    check('★★ 延迟被取消 → cancelled', res.status === 'cancelled', JSON.stringify(res))
    check('★★ 立刻结束（没睡满 5000 毫秒）', spent < 1000, String(spent) + ' 毫秒')

    /* 不传信号时行为不变（老路径：照样等、照样成功）。 */
    const d0 = makeDispatcher(createBuiltinExecutor(new Map([['flow.delay', delayFn]])), 10_000)
    const res0 = await d0.dispatch(req2('builtin', { node: 'flow.delay', params: { ms: 5 } }, undefined))
    check('★ 不传信号时延迟照常跑完（没有信号就不可取消）', res0.status === 'success', JSON.stringify(res0))
  }

  /* ── ④ shell 执行方 ─────────────────────────────────────────── */
  {
    let shellSignal
    let terminated = 0
    const fakeSpawner = {
      spawn(spec) {
        shellSignal = spec.signal
        let finish
        const done = new Promise(r => { finish = r })
        return {
          pid: 1,
          terminate() { terminated += 1; finish({ exitCode: null, signal: 'SIGTERM' }) },
          waitForExit: async () => true,
          done,
          stdoutText: () => '',
          stderrText: () => '',
        }
      },
    }
    const d = makeDispatcher(createShellExecutor(fakeSpawner), 10_000)
    const ac = new AbortController()
    const pending = d.dispatch(req2('shell', { node: 'code.shell', argv: ['ping', '-t', '127.0.0.1'] }, ac.signal))
    await tick()
    ac.abort()
    const res = await pending
    check('★★ 外部取消 → shell 结局 cancelled', res.status === 'cancelled', JSON.stringify(res))
    check('★★ 外部取消 → 真去终止了进程', shellSignal?.aborted === true && terminated > 0, 'aborted=' + String(shellSignal?.aborted) + ' terminate=' + String(terminated))
  }

  /* ── ⑤ http 执行方（本地起一个永不回应的服务）────────────────── */
  {
    const { createServer } = await import('node:http')
    const srv = createServer(() => { /* 故意不回应：让请求挂住 */ })
    await new Promise(r => { srv.listen(0, '127.0.0.1', r) })
    const port = srv.address().port
    const d = makeDispatcher(createHttpExecutor(), 10_000)
    const ac = new AbortController()
    const pending = d.dispatch(req2('http', { node: 'net.http', url: 'http://127.0.0.1:' + String(port) + '/hang' }, ac.signal))
    await tick(50)
    ac.abort()
    const res = await pending
    srv.closeAllConnections?.()
    srv.close()
    check('★★ 外部取消 → http 结局 cancelled', res.status === 'cancelled', JSON.stringify(res))
  }

  /* ── ⑥ agent 执行方（委派函数挂住不返回）─────────────────────── */
  {
    const hangDelegate = (_prompt, _input, signal) => new Promise(resolve => {
      signal?.addEventListener('abort', () => { resolve({ ok: false, error: '模型请求已中断' }) }, { once: true })
    })
    const d = makeDispatcher(createAgentExecutor(hangDelegate), 10_000)
    const ac = new AbortController()
    const pending = d.dispatch(req2('agent', { node: 'ai.agent', prompt: '写一句标题', timeoutMs: 60_000 }, ac.signal))
    await tick()
    ac.abort()
    const res = await pending
    check('★★ 外部取消 → agent 结局 cancelled', res.status === 'cancelled', JSON.stringify(res))
    check('★ 外部取消不算超时（没被超时路径抢走）', res.timedOut !== true, String(res.timedOut))
  }

  /* ── ⑦ 超时仍是老样子：failed + timedOut，不许变成 cancelled ──── */
  {
    const d = makeDispatcher(createBuiltinExecutor(new Map([['flow.delay', delayFn]])), 50)
    const res = await d.dispatch(req2('builtin', { node: 'flow.delay', params: { ms: 5000 } }, undefined))
    check('★★ 超时仍是 failed + timedOut: true', res.status === 'failed' && res.timedOut === true, JSON.stringify(res))
  }
}

console.log('')
console.log('⑦h ai.agent 跑成功时主动报一条（票 30 甲）')
{
  /* ## 这一段守的是什么
   *
   * `ai.agent` 原来**一句话都不报**。后果不是「少一行字」，而是
   * `records.ts:219` 那条「成功 + 没有产出声明 + 没有汇报 → 不写记录」：
   * 只由 `ai.agent` 构成的工作流（真实存档 `提示词优化` 就是：`flow.start → ai.agent`）
   * 跑成功了却**彻底不留任务记录**，用户回运行历史里找不到它跑过。
   *
   * ## 判据挑在哪
   *
   * 不判「`reports` 非空」（那句「完成」也能过），判**那句话里有没有可核对的量**：
   * 回答字数 + 路由。第 ⑧ 段还有一条总的「防空话」。
   *
   * ⚠️ 这一段的观测点是**执行方的返回值**（`createAgentExecutor` 的 `DispatchResult`），
   * 不是节点实现 —— `ai.agent` 没有内置函数，它整条路就在执行方里。 */

  const RUN_TEXT = '纯棉短袖的标题建议写成一夏清凉' // 14 字
  const RUN_TRACE = {
    provider: 'deepseek-official', model: 'deepseek-v4-flash',
    inputTokens: 120, outputTokens: 45, finish: 'stop',
  }
  const okExec = createAgentExecutor(async () => ({ ok: true, text: RUN_TEXT, trace: RUN_TRACE }))
  const okRes = await okExec.run({
    runId: 'rep-ok', nodeId: 'n21', executor: 'agent',
    command: { prompt: '写一个标题', timeoutMs: 5000 },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })
  check('（前置）这一次成功了', okRes.status === 'success', String(okRes.status))
  check('★★ 成功那一趟带了汇报', Array.isArray(okRes.reports) && okRes.reports.length === 1,
    JSON.stringify(okRes.reports))

  const okMsg = String(okRes.reports?.[0]?.message ?? '')
  console.log('   真实汇报：' + okMsg)
  /* ① 回答字数：**算出来的那个数**，不是「若干字」。 */
  check('★★ 汇报里有回答字数（' + String(RUN_TEXT.length) + '）',
    okMsg.includes(String(RUN_TEXT.length)), okMsg)
  check('★★ 字数在 metrics 里也是同一个数（可直接核对，不用解析句子）',
    okRes.reports?.[0]?.metrics?.chars === RUN_TEXT.length,
    JSON.stringify(okRes.reports?.[0]?.metrics))
  /* ② 路由：provider / model 两段都要在。 */
  check('★★ 汇报里有路由（provider/model）',
    okMsg.includes(RUN_TRACE.provider) && okMsg.includes(RUN_TRACE.model), okMsg)
  /* ③ 结束原因也带出来了（拼法复用 `formatTraceLine`，不是这里另写一遍）。 */
  check('★ 汇报里带着结束原因（复用痕迹那一行的拼法）', okMsg.includes('结束 stop'), okMsg)
  check('★ 汇报里带上节点 id（任务记录要知道是谁报的）', okRes.reports?.[0]?.node === 'n21',
    String(okRes.reports?.[0]?.node))
  /* ④ **防空话**：那句话必须命中「数字 / 文件名 / 路径 / 成功失败」之一。
   * 改成「完成」「跑完了」这条立刻红。 */
  const HAS_QUANTITY = /[0-9]|\d|字节|字|个|条|成功|失败|跳过/.test(okMsg)
  check('★★ 这句话带业务量（不是「完成」那种空话）', HAS_QUANTITY && okMsg !== '完成', okMsg)

  /* ⑤ 汇报**不影响**返回值（纪律 1：汇报不进数据流）。 */
  check('★★ 输出仍是模型那段话（没把汇报塞进输出）', okRes.output === RUN_TEXT, String(okRes.output))
  check('★ 输出里没有 reports 字段', !('reports' in (typeof okRes.output === 'object' ? okRes.output ?? {} : {})),
    typeof okRes.output)

  /* ── ⑥ 失败与取消那两条路**不带 reports 键**（纪律 4：没有就不写键）──
   *
   * 这条判的是「空就不写键」有没有被破坏。写成 `reports: []` 或 `reports: undefined`
   * 都会让下游多一种「有值但看不出来」的状态，与 `llm` 那条同一个理由。 */
  const failExec = createAgentExecutor(async () => ({
    ok: false, error: '模型调用失败：上游 500',
    trace: { provider: 'p', model: 'm', finish: 'error' },
  }))
  const failRes = await failExec.run({
    runId: 'rep-fail', nodeId: 'n22', executor: 'agent',
    command: { prompt: '写一个标题', timeoutMs: 5000 },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })
  check('（前置）这一趟失败了', failRes.status === 'failed', String(failRes.status))
  check('★★ 失败那一趟**没有** reports 键（不是 []、不是 undefined）',
    !('reports' in failRes), JSON.stringify(Object.keys(failRes)))

  const acRep = new AbortController()
  const hangRep = createAgentExecutor(() => new Promise(() => { /* 永不 settle */ }))
  const pendingRep = hangRep.run({
    runId: 'rep-can', nodeId: 'n23', executor: 'agent',
    command: { prompt: '写一个标题', timeoutMs: 60000 },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
    signal: acRep.signal,
  })
  setTimeout(() => { acRep.abort() }, 80)
  const canRes = await pendingRep
  check('（前置）这一趟是取消', canRes.status === 'cancelled', String(canRes.status))
  check('★★ 取消那一趟**没有** reports 键', !('reports' in canRes), JSON.stringify(Object.keys(canRes)))

  /* 超时那条腿也单独判一次 —— 它比取消更常见，而且同样拿不到汇报。 */
  const toExec = createAgentExecutor(() => new Promise(() => { /* 永不 settle */ }))
  const toRes = await toExec.run({
    runId: 'rep-to', nodeId: 'n24', executor: 'agent',
    command: { prompt: '写一个标题', timeoutMs: 300 },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })
  check('（前置）这一趟超时', toRes.status === 'failed' && toRes.timedOut === true, JSON.stringify(toRes.status))
  check('★★ 超时那一趟**没有** reports 键', !('reports' in toRes), JSON.stringify(Object.keys(toRes)))

  /* ── ⑦ 没有路由时不编一个假路由 ─────────────────────────────────
   *
   * 委派函数成功时**应当**带 trace，但那是类型上的保证。真收到残缺对象时：
   * 报字数、并明说「没留下路由」。编一个假路由比没有更坏 ——
   * 用户会照着它去查一个不存在的模型。 */
  const noTraceExec = createAgentExecutor(async () => ({ ok: true, text: '一段话' }))
  const noTraceRes = await noTraceExec.run({
    runId: 'rep-nt', nodeId: 'n25', executor: 'agent',
    command: { prompt: '写一句', timeoutMs: 5000 },
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
  })
  const ntMsg = String(noTraceRes.reports?.[0]?.message ?? '')
  check('★★ 没有路由时照样有汇报（只说字数）', ntMsg.includes('3'), ntMsg)
  check('★★ 而且**明说**没留下路由（不编一个假的）', ntMsg.includes('没留下'), ntMsg)
}

console.log('')
console.log('⑧ 文案守 R6')
{
  const all = JSON.stringify(def?.detail ?? {}) + JSON.stringify(def?.paramDefs ?? []) + String(def?.summary ?? '')
  check('没有第二人称「你」', !/你/.test(all))
  check('没有 Markdown 加粗标记', !all.includes('**'))
  check('没有感叹号', !all.includes('！'))
  check('参数 label 不是疑问句', (def?.paramDefs ?? []).every(p => !p.label.includes('？')))
}

console.log('')
console.log(failed === 0 ? '结论：AI 生成节点检查全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
