/** 「开始 / 结束」节点在**取数工作流**上的接线核验（t22）。
 *
 * ## 为什么单独一个测试
 *
 * 开始/结束节点本身早有单测（`io-fields.mjs` / `io-run.mjs` 那些）。
 * 这里钉的是**这份具体的工作流有没有真的接上** —— 那是另一类错：
 * 机制是好的，但生成器没写、或者写了却没连边，界面上看起来少了点什么，
 * 而没有任何测试会红。
 *
 * ## 钉哪几条（每条都对应一个「错了也不报错」的坑）
 *
 * 1. **三个输入都是「选填」** —— 标成必填的话，「日常增量跑」这个最常用的情况
 *    必须先填东西，而用户的原则是「兼容，不是为了一部分去删基础结构」。
 * 2. **三个都留空 = 跑全部模块 + 自动推算日期** —— 向后兼容的硬判据。
 * 3. **开始节点真的连到了下游**（不是孤点）—— 不连的话它不「跑」，
 *    界面上不显示它交出了什么，值也只是靠「全局可见」碰巧能用。
 * 4. **结束节点声明了产出，且那两项真的取得到值**。
 * 5. **组合层的参数真的透传到子工作流** —— 组合层原来没有开始节点，
 *    于是 `runSubWorkflow` 的「原样透传」永远传的是空对象：
 *    用户填的参数被**静默丢掉**。
 *
 * 跑法：node --import <tsx> tests/start-end-params.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

/* 沙箱要在 import 存档层之前设好（与其它端到端测试一致）。 */
const HOME = mkdtempSync(join(tmpdir(), 'ewb-startend-'))
process.env.EWB_TEST_HOME = HOME
mkdirSync(join(HOME, 'workflows'), { recursive: true })

const { parseInputFields, parseOutputFields, resolveInputs, missingRequired } =
  await import('../src/workflow/io-fields.ts')
const { NODE_LIBRARY } = await import('../src/nodes/index.ts')
const { toRunSpecsFromCanvas } = await import('../src/workflow/specs.ts')
const { runGraph } = await import('../src/workflow/run.ts')

let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} [detail] - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const WF_DIR = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench', 'workflows')
const lib = [...(Array.isArray(NODE_LIBRARY) ? NODE_LIBRARY : NODE_LIBRARY.values())]

/**
 * 读一份真实存档并翻成 specs（与画布、宿主半同一份映射）。
 *
 * @param name - 工作流名（存档文件名）。
 * @returns 存档与 specs；文件不在时返回 null。
 */
function load(name) {
  let doc = null
  try { doc = JSON.parse(readFileSync(join(WF_DIR, name + '.json'), 'utf8')) } catch { return null }
  const specs = toRunSpecsFromCanvas(
    doc.nodes.map(n => ({
      id: n.id,
      ...n.parentId === undefined ? {} : { parentId: n.parentId },
      data: {
        def: lib.find(d => d.id === n.defId),
        params: n.params,
        onError: n.onError,
        skipped: n.skipped === true,
      },
    })),
    doc.edges,
  )
  return { doc, specs }
}

console.log('=== 开始 / 结束节点在取数工作流上的接线（t22）===')

/* ── ① 取数-抖音电商罗盘：开始节点的三个输入 ── */
console.log('')
console.log('① 取数-抖音电商罗盘 的开始节点')
const dy = load('取数-抖音电商罗盘')
if (dy === null) {
  console.log('  （跳过：找不到存档，先跑 scripts/build-patrol-workflows.mjs）')
} else {
  const startNode = dy.doc.nodes.find(n => n.defId === 'flow.start')

  check('有一份开始节点', startNode !== undefined)
  /* ⚠️ 2026-10-25：用户决定**存档里不再有结束节点**（节点定义仍保留在节点库，
   * `tests/io-fields.mjs` 那些钉节点本身的断言一条没动）。
   * 所以这里从「有一份结束节点」改成「没有」，并接着验「去掉之后链尾还是完整的」。
   *
   * 这一段原来还验过「结束节点声明了产出、那两项取得到值、它接在后面」——
   * 那三条的前提都是结束节点存在，随节点一起去掉。**替代品是下面那条**：
   * 链尾必须是一个真正的业务节点（有入边、没有出边），否则就是「砍掉尾巴没接上」。 */
  const endNodes = dy.doc.nodes.filter(n => n.defId === 'flow.end')
  check('★ 存档里没有结束节点（用户 2026-10-25 定）',
    endNodes.length === 0, String(endNodes.length))

  /* 链尾判据：没有出边的非开始节点 = 这条链的尾。它必须存在、且只有它一个「尾」
   * 会让人以为图断了 —— 所以允许有多个（抖音这份有分支），但至少要有一个。 */
  const tails = dy.doc.nodes
    .filter(n => n.defId !== 'flow.start')
    .filter(n => !dy.doc.edges.some(e => e.source === n.id))
  check('★★ 去掉结束节点后仍有链尾（有入边、没有出边的业务节点）',
    tails.length >= 1 && tails.every(n => dy.doc.edges.some(e => e.target === n.id)),
    tails.map(n => n.id + ':' + String(n.label ?? '')).join(' / ') || '一个尾都没有（图断了）')

  if (startNode !== undefined) {
    const fields = parseInputFields(startNode.params.fields)
    console.log('  声明的输入: ' + fields.map(f => f.name + (f.required ? '(必填)' : '(选填)')).join(' / '))
    check('★ 声明了三项：modules / from / to',
      JSON.stringify(fields.map(f => f.name)) === '["modules","from","to"]',
      JSON.stringify(fields.map(f => f.name)))
    /* ★★ 三项**都不能是必填** —— 这是用户原则（兼容，不是为一部分删基础结构）。
     * 标成必填的话，「日常增量跑」必须先填东西才让跑。 */
    check('★★ 三项全是选填（必填会把最常用的「日常增量」堵死）',
      fields.every(f => !f.required), fields.filter(f => f.required).map(f => f.name).join(',') || '没有必填项')
    check('★ 每项都有说明（用户看得到该填什么）',
      fields.every(f => f.description !== ''), fields.map(f => f.description.slice(0, 12)).join(' / '))

    /* ★★ 三个都留空时：不漏报必填、解析出空表 → 下游走自动推算。 */
    const blank = resolveInputs(fields, undefined)
    check('★★ 三项都留空 → 解析出空表（下游据此走自动推算）',
      Object.keys(blank).length === 0, JSON.stringify(blank))
    check('★★ 三项都留空 → 不报「缺必填项」',
      missingRequired(fields, blank).length === 0, JSON.stringify(missingRequired(fields, blank)))

    /* 填了就用填的。 */
    const filled = resolveInputs(fields, { modules: '交易', from: '2026-09-01', to: '2026-09-03' })
    check('★ 填了就生效', filled.modules === '交易' && filled.from === '2026-09-01', JSON.stringify(filled))

    /* ★ 开始节点真的连到了下游（不是孤点）。 */
    const outEdges = dy.doc.edges.filter(e => e.source === startNode.id)
    check('★ 开始节点连到了下游（不是孤点）', outEdges.length >= 1,
      '出边 ' + String(outEdges.length) + ' 条')
  }

  /* ⚠️ 2026-10-25：这里原来是「结束节点声明了产出 / 引用的节点存在 / 它有入边」
   * 三条。结束节点已被用户从存档里去掉，三条的前提都不在了，随它一起去掉。
   * 它们想守的「链尾接得上、不是孤点」由上面那条「仍有链尾」接管；
   * 而 `parseOutputFields` 这个函数本身的正确性由 `io-fields.mjs` 钉着，没丢覆盖。
   * `parseOutputFields` 仍在本文件顶部 import —— ② 段验组合层时要用不到它，
   * 留着是为了不惊动其它段落；若日后确认无用，删掉那个 import 即可。 */
}

/* ── ② 组合层：参数真的透传到子工作流 ── */
console.log('')
console.log('② 组合层的参数透传到子工作流（漏了这条，参数被静默丢掉）')
{
  /* ⚠️ 2026-10-22：「一键下载」已按用户决定删除，两份合并成一份「全部下载」
   * （按开始节点的「平台」参数分流）。这里跟着改到合并后的那份 ——
   * 不改的话这条断言会因为「找不到存档」而**静默跳过**，看着还是绿的。 */
  const combo = load('全部下载')
  if (combo === null) {
    console.log('  （跳过：找不到「全部下载」存档）')
  } else {
    const startNode = combo.doc.nodes.find(n => n.defId === 'flow.start')
    /* ★★ 组合层必须有开始节点 —— 这是本条的全部意义。
     * 没有它，`runSubWorkflow` 的「没填 inputs 就原样透传本层输入」传的是**空对象**。 */
    check('★★ 组合层有开始节点（没有它，填的参数传不进去）', startNode !== undefined)

    /* 用真调度器跑，把「跑另一份工作流」换成记录桩 —— 看它实际收到了什么。
     * ⚠️ `flow.if` 必须用**真实现**：桩给不出 `__handle`，两条分支会被判成
     * 「都活」，于是每次都跑两份 —— 那是靠巧合通过，不是行为正确。 */
    const { branchFn } = await import('../src/dispatch/builtins.ts')
    const calls = []
    const runWorkflow = async (ref, signal, inputs) => {
      calls.push({ ref, inputs })
      return { ok: true, ran: ['n1'] }
    }
    const out = await runGraph(
      {
        nodes: combo.specs.nodes, edges: combo.specs.edges, workdir: HOME,
        /* 平台选「全部」→ 两份子工作流都该跑，才验得到「参数逐份透传」。 */
        inputs: { 平台: '全部', modules: '交易', from: '2026-09-01', to: '2026-09-03' },
        runWorkflow,
      },
      async (req) => {
        const defId = combo.doc.nodes.find(n => n.id === req.nodeId)?.defId
        if (defId === 'flow.if') {
          return { ok: true, status: 'success', output: branchFn(req.command, { nodeId: req.nodeId, workdir: HOME, upstream: req.context.upstream }), logs: [] }
        }
        return { ok: true, status: 'success', output: {}, logs: [] }
      },
      { onEvent: () => { /* 不要日志 */ } },
    )

    check('★ 整条跑通（没中断）', out.aborted !== true, String(out.error ?? ''))
    check('★ 平台=全部 时两份子工作流都被调用了', calls.length === 2, String(calls.length))
    const first = calls[0]?.inputs ?? {}
    check('★★ 子工作流真的收到了 modules', first.modules === '交易', JSON.stringify(first))
    check('★★ 子工作流真的收到了 from / to',
      first.from === '2026-09-01' && first.to === '2026-09-03', JSON.stringify(first))
  }
}

/* ── ③ 模型参数与保留键 `__model` ─────────────────────────────────────
 *
 * ## 钉的是这条链（2026-10-23，计划 §2.5 / §2.6）
 *
 *   ① 两个节点上有 `kind: 'model'` 的参数，且**允许留空**（用户原话「也可以不选」）；
 *   ② `encodeModelPick` / `decodeModelPick` 互为逆运算、非法输入返回 null；
 *   ③ 开始节点填了模型 → 引擎把它写进保留键 `__model`；
 *   ④ 这个键**不给用户看**：不出现在输入日志、开始节点输出、`resolvedInputs` 的可见部分，
 *      也**取不到**（`{{__model}}` 必须走「没找到」那条路）。
 *
 * ⚠️ 第 ④ 条最容易做漏：多一处没挡，用户就会在某处突然看到一个叫 `__model` 的输入项。 */
console.log('')
console.log('③ 模型参数与保留键 __model')
{
  const { encodeModelPick, decodeModelPick } = await import('../src/workflow/model.ts')
  const { isReservedKey, withoutReservedKeys, reservedKeysOf, MODEL_KEY } = await import('../src/workflow/variables.ts')
  const { substituteText } = await import('../src/workflow/variables.ts')

  /* ① 两个节点的参数声明。 */
  const aiNode = lib.find(d => d.id === 'ai.agent')
  const startDef = lib.find(d => d.id === 'flow.start')
  const aiModel = (aiNode?.paramDefs ?? []).find(p => p.key === 'model')
  const startModel = (startDef?.paramDefs ?? []).find(p => p.key === 'model')
  check('★ ai.agent 有 model 参数', aiModel !== undefined)
  check('★★ ai.agent 的 model 允许留空（required 不是 true）', aiModel?.required !== true, String(aiModel?.required))
  check('★ ai.agent 的 model 控件类型是 model', aiModel?.kind === 'model', String(aiModel?.kind))
  check('★ ai.agent 的 model 默认是空串（= 跟随默认）', aiModel?.default === '', String(aiModel?.default))
  check('★ ai.agent 的 hint 说清「留空跟随默认」+ 默认从哪来',
    String(aiModel?.hint).includes('跟随默认') && String(aiModel?.hint).includes('工作台设置里的默认模型'),
    String(aiModel?.hint).slice(0, 60))
  check('★ flow.start 有 model 参数', startModel !== undefined)
  check('★ flow.start 的 model 也允许留空', startModel?.required !== true, String(startModel?.required))
  check('★ flow.start 的 model 控件类型是 model', startModel?.kind === 'model', String(startModel?.kind))
  /* 它是**配置**不是输入：不能出现在「输入项」那个字段清单里（那是另一个参数 fields）。 */
  check('★★ 它不是「输入项」参数（是配置，不进执行表单）',
    (startDef?.paramDefs ?? []).filter(p => p.key === 'fields').length === 1
    && startModel?.key === 'model', 'fields 与 model 是两个独立参数')

  /* detail 第 ⑥ 条的旧说法必须清干净（加了参数之后那句就不准了）。 */
  const cautions = String(aiNode?.detail?.cautions ?? '')
  check('★★ cautions 不再说「本节点用的是 dsh 模型设置里选定的」',
    !cautions.includes('本节点用的是 dsh 模型设置里选定的'), cautions.slice(-90))
  check('★ cautions 第 ⑥ 条改说「按顺序定 + 都没选才跟随默认」',
    cautions.includes('两边都没选则跟随默认'), cautions.slice(-90))

  /* ② 两个纯函数互为逆运算。 */
  const enc = encodeModelPick({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })
  check('★ encode 拼成 provider/model', enc === 'deepseek-official/deepseek-v4-flash', enc)
  check('★ decode 拆回来相等', JSON.stringify(decodeModelPick(enc))
    === JSON.stringify({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }), JSON.stringify(decodeModelPick(enc)))
  /* 模型名里带 `/` 也要能还原（按第一个 `/` 切）。 */
  const deep = encodeModelPick({ provider: 'vendor', model: 'org/model-v2' })
  check('★ 模型名带斜杠也能还原', JSON.stringify(decodeModelPick(deep))
    === JSON.stringify({ provider: 'vendor', model: 'org/model-v2' }), deep)
  /* 缺一段就是空串 / null（不拼出半截值）。 */
  check('★ 缺 provider → encode 给空串', encodeModelPick({ provider: '', model: 'm' }) === '')
  check('★ 缺 model → encode 给空串', encodeModelPick({ provider: 'p', model: '' }) === '')
  for (const bad of ['', '   ', 'nope', '/m', 'p/', 'p / ']) {
    check('★ decode 非法输入（' + JSON.stringify(bad) + '）返回 null', decodeModelPick(bad) === null,
      String(decodeModelPick(bad)))
  }

  /* ③ + ④ 真跑一次：开始节点填了模型。 */
  check('★ 保留键前缀判据正确', isReservedKey('__model') && !isReservedKey('model') && !isReservedKey('_x'))
  check('★ 剥保留键只去掉 __ 开头的', JSON.stringify(withoutReservedKeys({ a: 1, __model: 'p/m' })) === '{"a":1}',
    JSON.stringify(withoutReservedKeys({ a: 1, __model: 'p/m' })))
  /* 空值不带 —— 语义是「上层没选就走回落链」。 */
  check('★ 空串 / null 的保留键不带下去',
    Object.keys(reservedKeysOf({ __model: '', __other: null, __ok: 'p/m' })).join(',') === '__ok',
    JSON.stringify(reservedKeysOf({ __model: '', __other: null, __ok: 'p/m' })))

  const startSpec = {
    id: 's1',
    def: startDef,
    params: { type: 'manual', fields: ['日期 | 要采集哪一天'], model: 'deepseek-official/deepseek-v4-flash' },
    onError: 'stop',
    skipped: false,
  }
  const aiSpec = {
    id: 'a1',
    def: aiNode,
    params: { prompt: '写一句文案', input: '', model: '', timeout: 60000 },
    onError: 'continue',
    skipped: false,
  }
  const events = []
  const out2 = await runGraph(
    { nodes: [startSpec, aiSpec], edges: [{ id: 'e1', source: 's1', target: 'a1' }], workdir: HOME, inputs: { 日期: '2026-10-23' } },
    async () => ({ ok: true, status: 'success', output: {}, logs: [] }),
    { onEvent: (e) => events.push(e) },
  )
  check('★ 这份小工作流跑通了', out2.aborted !== true, String(out2.error ?? ''))

  /* 开始节点的**输出**里不能有 __model。 */
  const startOut = out2.outputs.get('s1') ?? {}
  check('★★ 开始节点的输出里没有 __model', !('__model' in startOut), JSON.stringify(startOut))
  check('★ 开始节点的输出里照旧有用户声明的输入', startOut['日期'] === '2026-10-23', JSON.stringify(startOut))
  /* 运行结果的 inputs（会被写进运行记录、显示成「这次用了什么输入」）也不能有它。 */
  check('★★ 运行结果的 inputs 里没有 __model', !('__model' in out2.inputs), JSON.stringify(out2.inputs))
  /* 输入日志那行也不能提它。 */
  const inputLogs = events.filter(e => e.kind === 'log' && String(e.line).includes('输入')).map(e => e.line)
  check('★★ 输入日志里没提 __model', inputLogs.every(l => !l.includes('__model')), inputLogs.join(' | ').slice(0, 120))

  /* ④ 最关键的一条：`{{__model}}` **取不到**（原样保留 + 报缺失）。 */
  const reserved = substituteText('模型是 {{__model}}', { fields: { __model: 'p/m', 日期: '2026-10-23' } })
  check('★★ {{__model}} 取不到（原样保留）', reserved.value === '模型是 {{__model}}', reserved.value)
  check('★★ 并且报「没找到」（不是静默给空）', reserved.missing.includes('__model'), reserved.missing.join(','))
  /* 反向：普通变量照旧取得到。 */
  const normal = substituteText('{{日期}}', { fields: { 日期: '2026-10-23' } })
  check('★ 普通变量照旧能取（没有误伤）', normal.value === '2026-10-23', normal.value)
  check('★ 保留键常量就是 __model', MODEL_KEY === '__model', MODEL_KEY)
}

rmSync(HOME, { recursive: true, force: true })
rmSync(join(tmpdir(), 'ewb-startend-'), { recursive: true, force: true })
void writeFileSync
console.log('')
console.log(failed === 0 ? '结论：开始/结束节点接线正确，组合层参数能透传 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
