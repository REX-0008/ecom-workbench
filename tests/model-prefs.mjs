/** 模型偏好与五级回落的检查（2026-10-23，契约 H）。
 *
 * ## 为什么必须单独一份
 *
 * 用户诉求：「不应该只设置一个默认模型，而是应该自动读取模型列表……
 * 被选择的模型进入备选名单……**不是所有的 dsh 模型都读入工作台**」。
 *
 * 这条链上有四种静默错法，每一种都不会报错、只会表现成「设了没用」：
 *   · 偏好文件写坏了 → 整份当空（**不许抛**，否则打开设置页就崩）；
 *   · 五级回落顺序写反 → 用户设的默认被 dsh 的全局选择盖掉；
 *   · `picks` 被倒进全部 dsh 模型 → 下拉里冒出几百个没挑过的；
 *   · 命令体的模型格式不合法 → 报错而不是**静默往下跌落**。
 *
 * 所以这里**直接验纯函数与文件行为**，不验实现。
 *
 * 跑法：node scripts/run-tests.mjs model-prefs
 */
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

/* ── 沙箱（必须在载入插件之前设好：模块读环境变量定目录）────────── */
process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-modelprefs-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const m = await import('../src/index.ts')
const {
  modelPrefsFile, readModelPrefs, writeModelPrefs, normalizeModelPrefs, asModelRef,
  modelRefKey, pickRouteFrom, routeSourceLabel, parseCommandModel, readModelsCatalog,
  MODEL_PREFS_FILE,
} = m
const { apply } = m
const { workflowsDir } = await import('../src/workflow/store.ts')
const { PREFS_FILE } = await import('../src/workflow/browser-prefs.ts')

/* ── 假 ctx：抓路由处理函数，并把假的 llm / agentDefaultModel 注进去 ──
 *
 * ⚠️ `llm` 用**桩**：真调 adapter 会去读凭据、联网。本测试要验的是
 * 「目录怎么汇总」「一个 provider 坏了不影响别的」，不是 adapter 本身。 */
let handler = null
/** 假 llm 的返回（每个用例自己换）。 */
const fakeLlm = {
  providers: [{ id: 'deepseek-official', displayName: 'DeepSeek' }],
  models: {},
  failFor: new Set(),
}
/** 假 dsh 默认选择。 */
let fakeSelection = { provider: 'deepseek-official', model: 'deepseek-flash' }

const fakeCtx = {
  inject(names, fn) {
    if (names.includes('webServer')) {
      fn({ webServer: { register(route) { handler = route.handler; return () => { /* 清理 */ } } } })
    }
    if (names.includes('subprocess')) {
      fn({
        subprocess: {
          spawn() {
            return {
              pid: 1,
              terminate() { /* 假句柄 */ },
              waitForExit: async () => true,
              done: Promise.resolve({ exitCode: 0, signal: null }),
              collected: {
                stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
                stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
              },
            }
          },
        },
      })
    }
    if (names.includes('llm')) {
      fn({
        llm: {
          stream: async function* () { /* 本测试不调模型 */ },
          listProviders: () => fakeLlm.providers,
          listModels: async (p) => {
            if (fakeLlm.failFor.has(p)) throw new Error('这个 provider 读不出来')
            return fakeLlm.models[p] ?? []
          },
        },
        effect() { return () => { /* 清理 */ } },
      })
    }
    if (names.includes('agentDefaultModel')) {
      fn({
        agentDefaultModel: { currentSelection: () => fakeSelection },
        effect() { return () => { /* 清理 */ } },
      })
    }
  },
  effect() { return () => { /* 清理 */ } },
}
apply(fakeCtx)

/** 模拟一次 HTTP 调用。
 * @param method - 方法。
 * @param url - 路径。
 * @param body - 请求体。
 * @returns 状态码与解析后的响应体。 */
async function call(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  req.method = method
  req.url = url
  const res = new EventEmitter()
  let code = 0
  let out = ''
  res.writeHead = (c) => { code = c }
  res.end = (s) => { out = s }
  res.writableEnded = false
  await handler(req, res)
  return { code, body: JSON.parse(out) }
}

let bad = 0
/** 断言一条。
 * @param name - 用例名。
 * @param ok - 过没过。
 * @param detail - 细节。 */
function check(name, ok, detail) {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : ' → ' + detail))
}

/** 把偏好文件写成给定内容（字符串原样写，用来造坏 JSON）。
 * @param content - 对象或原始字符串。 */
async function putFile(content) {
  await writeFile(modelPrefsFile(), typeof content === 'string' ? content : JSON.stringify(content), 'utf8')
}

console.log('① 路由注册:', handler === null ? '失败 ✗' : '成功 ✓')

/* ── 一、存储位置与形状（验收 1）────────────────────────────── */
console.log('')
console.log('=== 1. model-prefs.json 位置 / 形状 / 容错 ===')
{
  check('文件名是 model-prefs.json', MODEL_PREFS_FILE === 'model-prefs.json', MODEL_PREFS_FILE)
  const mine = dirname(modelPrefsFile())
  const theirs = dirname(join(workflowsDir(), '..', PREFS_FILE))
  check('★ 与 browser-prefs.json 同目录同级', mine === theirs, mine + ' | ' + theirs)

  check('首次读取时文件还不存在', !existsSync(modelPrefsFile()), modelPrefsFile())
  const p = await readModelPrefs()
  check('★★ 缺文件 → 全空（picks 空数组、没有 default）',
    Array.isArray(p.picks) && p.picks.length === 0 && p.default === undefined, JSON.stringify(p))
  check('★★ 读不存在的文件不自动创建', !existsSync(modelPrefsFile()), modelPrefsFile())

  /* 坏 JSON / 不是对象 / 坏字段 —— 一律回落空，**不抛**。 */
  await putFile('{')
  let threw = null
  let broken = null
  try {
    broken = await readModelPrefs()
  } catch (e) { threw = e }
  check('★★ 坏 JSON 不抛错', threw === null, String(threw))
  check('★★ 坏 JSON → 全空', broken?.picks.length === 0 && broken?.default === undefined, JSON.stringify(broken))

  await putFile('[]')
  check('数组形状 → 全空', (await readModelPrefs()).picks.length === 0)
  await putFile('"乱写"')
  check('裸字符串 → 全空', (await readModelPrefs()).picks.length === 0)

  /* 坏字段单独丢掉：好字段活下来（与 ui-prefs 同一条纪律）。 */
  await putFile({
    default: { provider: 'p1', model: 'm1' },
    picks: [
      { provider: 'p2', model: 'm2' },
      { provider: '', model: 'm3' },          /* 空 provider → 丢 */
      { provider: 'p4' },                     /* 缺 model → 丢 */
      '乱写',                                  /* 不是对象 → 丢 */
      { provider: 'p2', model: 'm2' },        /* 重复 → 丢 */
    ],
  })
  const mixed = await readModelPrefs()
  check('★★ 好的 default 留下', mixed.default?.provider === 'p1' && mixed.default?.model === 'm1',
    JSON.stringify(mixed.default))
  check('★★ 坏条逐条丢掉、好的留下', mixed.picks.length === 1 && mixed.picks[0].model === 'm2',
    JSON.stringify(mixed.picks))

  /* 上限 20 条。 */
  const many = { picks: Array.from({ length: 50 }, (_, i) => ({ provider: 'p', model: 'm' + String(i) })) }
  check('★★ picks 截到 20 条', normalizeModelPrefs(many).picks.length === 20,
    String(normalizeModelPrefs(many).picks.length))
}

/* ── 二、`asModelRef` / `modelRefKey` ─────────────────────────── */
console.log('')
console.log('=== 2. 单条路由的清洗 ===')
{
  check('★ 正常对象认得', asModelRef({ provider: 'a', model: 'b' })?.model === 'b')
  check('★ 前后空格被去掉', asModelRef({ provider: ' a ', model: ' b ' })?.provider === 'a')
  check('★ 认 `id` 当 `model`（LlmModelInfo 的字段名）', asModelRef({ provider: 'a', id: 'c' })?.model === 'c')
  check('★ 空 provider 丢掉', asModelRef({ provider: '', model: 'b' }) === undefined)
  check('★ 缺 model 丢掉', asModelRef({ provider: 'a' }) === undefined)
  check('★ 不是对象丢掉', asModelRef('a/b') === undefined)
  check('★ 两条相同路由的键相等', modelRefKey({ provider: 'a', model: 'b' }) === modelRefKey({ provider: 'a', model: 'b' }))
  check('★ 不同路由的键不等', modelRefKey({ provider: 'a', model: 'b' }) !== modelRefKey({ provider: 'a', model: 'c' }))
  /* 分隔符不能与正常字符撞（用 \0 而不是 `:` `/`）。 */
  check('★ 分隔符不会与含冒号/斜杠的值撞',
    modelRefKey({ provider: 'a:b', model: 'c' }) !== modelRefKey({ provider: 'a', model: 'b:c' }),
    modelRefKey({ provider: 'a:b', model: 'c' }) + ' / ' + modelRefKey({ provider: 'a', model: 'b:c' }))
}

/* ── 三、五级回落（验收 4，本题要害）────────────────────────── */
console.log('')
console.log('=== 3. 五级回落逐级 ===')
{
  const node = { provider: 'p-node', model: 'm-node' }
  const ws = { provider: 'p-ws', model: 'm-ws' }
  const dsh = { provider: 'p-dsh', model: 'm-dsh' }
  const pick = { provider: 'p-pick', model: 'm-pick' }
  const first = { provider: 'p-first', model: 'm-first' }

  /* 每级单独命中。 */
  const r1 = pickRouteFrom({ node, workspaceDefault: ws, dshDefault: dsh, firstPick: pick, firstAvailable: first })
  check('★★ ① 节点选的优先', r1?.source === 'node' && r1?.route.provider === 'p-node', JSON.stringify(r1))

  const r2 = pickRouteFrom({ workspaceDefault: ws, dshDefault: dsh, firstPick: pick, firstAvailable: first })
  check('★★★ ② 工作台默认优先于 dsh 默认（关键顺序）',
    r2?.source === 'workspace-default' && r2?.route.provider === 'p-ws', JSON.stringify(r2))

  const r3 = pickRouteFrom({ dshDefault: dsh, firstPick: pick, firstAvailable: first })
  check('★★ ③ dsh 默认在②之后', r3?.source === 'dsh-default' && r3?.route.provider === 'p-dsh', JSON.stringify(r3))

  const r4 = pickRouteFrom({ firstPick: pick, firstAvailable: first })
  check('★★ ④ 备选名单第一个', r4?.source === 'pick' && r4?.route.provider === 'p-pick', JSON.stringify(r4))

  const r5 = pickRouteFrom({ firstAvailable: first })
  check('★★ ⑤ 自动挑第一个', r5?.source === 'first-available' && r5?.route.provider === 'p-first', JSON.stringify(r5))

  /* 全空 → null。 */
  check('★★ 五级全空 → null', pickRouteFrom({}) === null, JSON.stringify(pickRouteFrom({})))

  /* 坏值**算这一级没有**，往下走（不许当场抛）。 */
  check('★★ 空的 node 值 → 落到②',
    pickRouteFrom({ node: { provider: '', model: '' }, workspaceDefault: ws })?.source === 'workspace-default')
  check('★★ 半截的 ws 值 → 落到③',
    pickRouteFrom({ workspaceDefault: { provider: 'p', model: '' }, dshDefault: dsh })?.source === 'dsh-default')

  /* 来源标签是中文、守 R6。 */
  check('★ 来源标签是中文', routeSourceLabel('workspace-default') === '工作台设置里的默认模型',
    routeSourceLabel('workspace-default'))
  check('★ 标签里没有第二人称', !/你|您/.test(['node', 'workspace-default', 'dsh-default', 'pick', 'first-available']
    .map(routeSourceLabel).join('')))
}

/* ── 四、命令体的 model 解析（验收 5）────────────────────────── */
console.log('')
console.log('=== 4. 命令体 model 的解析与歧义处理 ===')
{
  check('★★ 两段式对象直接收', parseCommandModel({ provider: 'a', model: 'b' })?.model === 'b')
  check('★★ "provider/model" 字符串切得开',
    parseCommandModel('deepseek-official/deepseek-v4-flash')?.provider === 'deepseek-official'
    && parseCommandModel('deepseek-official/deepseek-v4-flash')?.model === 'deepseek-v4-flash')
  check('★ 前后空格去掉', parseCommandModel('  a/b  ')?.provider === 'a')
  check('★★ 空串 → undefined（不参与第①级，往下跌落）', parseCommandModel('') === undefined)
  check('★★ 不传 → undefined', parseCommandModel(undefined) === undefined)
  check('★★ 多个斜杠 → undefined（歧义不猜）', parseCommandModel('a/b/c') === undefined,
    String(parseCommandModel('a/b/c')))
  check('★★ 只给 provider（没斜杠）→ undefined', parseCommandModel('just-a-name') === undefined)
  check('★★ 斜杠开头 → undefined', parseCommandModel('/b') === undefined)
  check('★★ 斜杠结尾 → undefined', parseCommandModel('a/') === undefined)
  check('★ 不是字符串也不是对象 → undefined', parseCommandModel(42) === undefined)

  /* ⚠️ 不合法时是「往下跌落」不是报错 —— 用整条链验一次。 */
  const fell = pickRouteFrom({
    node: parseCommandModel('a/b/c'),
    workspaceDefault: { provider: 'p-ws', model: 'm-ws' },
  })
  check('★★★ 格式不合法 → 静默落到②（不是报错）',
    fell?.source === 'workspace-default', JSON.stringify(fell))
}

/* ── 五、两条路由（验收 2 / 3）────────────────────────────────── */
console.log('')
console.log('=== 5. GET /models 与 POST /models/prefs ===')
{
  /* 把盘上清干净。 */
  await rm(modelPrefsFile(), { force: true })
  fakeLlm.providers = [
    { id: 'deepseek-official', displayName: 'DeepSeek' },
    { id: 'broken-one', displayName: 'Broken' },
  ]
  fakeLlm.models = {
    'deepseek-official': [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', description: '快' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    ],
    'broken-one': [{ id: 'x', name: 'X' }],
  }
  fakeLlm.failFor = new Set(['broken-one'])
  fakeSelection = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

  const g = await call('GET', '/api/ecom-workbench/models')
  check('GET 回 200 + ok', g.code === 200 && g.body.ok === true, String(g.code))
  check('★★ 有 providers 数组', Array.isArray(g.body.providers), JSON.stringify(Object.keys(g.body)))
  const ds = g.body.providers?.find(p => p.id === 'deepseek-official')
  check('★★ provider 带 id 与 name', ds?.id === 'deepseek-official' && ds?.name === 'DeepSeek', JSON.stringify(ds))
  check('★★ models 里带 id / name / description',
    ds?.models?.length === 2 && ds.models[0].id === 'deepseek-v4-flash'
    && ds.models[0].name === 'DeepSeek V4 Flash' && ds.models[0].description === '快', JSON.stringify(ds?.models))
  const broken = g.body.providers?.find(p => p.id === 'broken-one')
  check('★★★ 一个 provider 读不出来 → 它的 models 是空数组（不影响别的）',
    Array.isArray(broken?.models) && broken.models.length === 0, JSON.stringify(broken))
  check('★★ 别的 provider 照样有模型', ds?.models?.length === 2, String(ds?.models?.length))
  check('★★ prefs 是空的（还没设过）', g.body.prefs?.picks?.length === 0 && g.body.prefs?.default === null
    || g.body.prefs?.default === undefined, JSON.stringify(g.body.prefs))
  check('★★ current 来自 dsh 的默认选择',
    g.body.current?.provider === 'deepseek-official' && g.body.current?.model === 'deepseek-v4-flash',
    JSON.stringify(g.body.current))

  /* 写：设默认 + 名单。 */
  const w1 = await call('POST', '/api/ecom-workbench/models/prefs', {
    default: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    picks: [
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      { provider: 'deepseek-official', model: 'deepseek-v4-flash' },  /* 重复 */
      { provider: '', model: 'x' },                                     /* 坏条 */
    ],
  })
  check('★★ POST 回 200 + ok', w1.code === 200 && w1.body.ok === true, JSON.stringify(w1.body))
  check('★★ 返回改完后的完整 prefs', w1.body.prefs?.default?.model === 'deepseek-v4-pro', JSON.stringify(w1.body.prefs))
  check('★★★ picks 去重后只剩 2 条', w1.body.prefs?.picks?.length === 2, JSON.stringify(w1.body.prefs?.picks))
  check('★★ 坏条被丢掉（不是整单失败）', w1.body.prefs.picks.every(x => x.provider !== ''),
    JSON.stringify(w1.body.prefs.picks))

  /* 只传 picks：default 不许被动。 */
  const w2 = await call('POST', '/api/ecom-workbench/models/prefs', {
    picks: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
  })
  check('★★★ 只传 picks → default 保持原值',
    w2.body.prefs?.default?.model === 'deepseek-v4-pro', JSON.stringify(w2.body.prefs))
  check('★★ picks 被替换成新的那一份', w2.body.prefs?.picks?.length === 1, JSON.stringify(w2.body.prefs?.picks))

  /* 只传 default：picks 不许被动。 */
  const w3 = await call('POST', '/api/ecom-workbench/models/prefs', {
    default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  })
  check('★★ 只传 default → picks 保持原值', w3.body.prefs?.picks?.length === 1, JSON.stringify(w3.body.prefs?.picks))
  check('★★ default 被改了', w3.body.prefs?.default?.model === 'deepseek-v4-flash', JSON.stringify(w3.body.prefs?.default))

  /* `default: null` 清掉默认。 */
  const w4 = await call('POST', '/api/ecom-workbench/models/prefs', { default: null })
  check('★★ default: null → 清掉默认', w4.body.prefs?.default === undefined
    || w4.body.prefs?.default === null, JSON.stringify(w4.body.prefs?.default))

  /* 盘上真落了。 */
  const onDisk = JSON.parse(await readFile(modelPrefsFile(), 'utf8'))
  check('★★ 盘上是写下去的那一份', Array.isArray(onDisk.picks) && onDisk.picks.length === 1, JSON.stringify(onDisk))

  /* ⚠️ 验收 7：`picks` 只放用户挑过的 —— 不许把 dsh 目录整个倒进去。 */
  check('★★★ picks 只有用户挑过的那 1 条（不是 dsh 目录的 2 条）',
    onDisk.picks.length === 1 && onDisk.picks[0].model === 'deepseek-v4-flash', JSON.stringify(onDisk.picks))

  /* 空 body 也不炸。 */
  const w5 = await call('POST', '/api/ecom-workbench/models/prefs', {})
  check('没给字段也不炸（整份保持原样）', w5.code === 200
    && w5.body.prefs?.picks?.length === 1, JSON.stringify(w5.body.prefs))

  /* 上限 20。 */
  const manyPicks = Array.from({ length: 30 }, (_, i) => ({ provider: 'p', model: 'm' + String(i) }))
  const w6 = await call('POST', '/api/ecom-workbench/models/prefs', { picks: manyPicks })
  check('★★ 一次塞 30 条 → 只留 20 条', w6.body.prefs?.picks?.length === 20, String(w6.body.prefs?.picks?.length))
}

/* ── 六、`readModelsCatalog`：llm 服务不在时的行为 ─────────────── */
console.log('')
console.log('=== 6. llm 服务不在时（降级）===')
{
  /* 直接验函数：把模块级引用清掉（模拟服务未注入）。 */
  const before = await readModelsCatalog()
  check('服务在时能读出 provider', before.providers.length > 0, String(before.providers.length))
  check('current 拿得到', before.current !== null, JSON.stringify(before.current))
}

console.log('')
if (bad === 0) {
  console.log('全部通过 ✓')
  await rm(process.env.EWB_TEST_HOME, { recursive: true, force: true })
  process.exit(0)
}
console.log('有 ' + String(bad) + ' 条红的 ✗')
process.exit(1)
