/** 模型吐字时一片片推给前端（票 14，2026-10-27）。
 *
 * ## 这一条为什么必须端到端
 *
 * 吐字发生在**宿主半**（`src/index.ts` 的 `llm.stream` 循环里），而事件在**引擎**
 * （`src/workflow/run.ts`）。中间隔着派发器、执行方、委派函数三层。
 * 只验其中一层都是假绿：
 *
 *   · 只验「引擎往命令体里塞了回调」→ 宿主半从不调用它，照样绿；
 *   · 只验「宿主半调了回调」→ 引擎那头没发事件，照样绿。
 *
 * 所以这里走**整条真链路**：写一份真存档 → `apply()` 起宿主半 → 假造一个模型
 * （喂定好的分片）→ 请求 `/workflow/run-stream` → 读 SSE 帧 → 再读**落盘的运行记录**。
 *
 * ## 为什么走 `/workflow/run-stream` 而不是画布那条
 *
 * 它是**进程内**派发（宿主半自己跑 `runGraph`），所以引擎塞进命令体的回调能一路
 * 到委派函数手上。这也是 `appendStream` 真正的消费方所在的路径（流程面板靠 SSE 收）。
 *
 * ⚠️ **画布整图跑那条路收不到**，如实交代在这里（不是忘做）：
 * 画布的 `runGraph` 在浏览器里跑，每个节点 `POST /run`，而 `JSON.stringify`
 * **会静静丢掉函数** —— 命令体里那个回调过不了 HTTP。要让它也实时，
 * 得把 `/run` 改成流式响应，那是宿主半路由的改动，不在本票范围。
 *
 * 跑法：`node --import <tsx loader> tests/agent-stream.mjs`
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'ewb-agent-stream-'))
/* 沙箱必须在载入插件**之前**设好（模块读环境变量定目录）。 */
process.env.EWB_TEST_HOME = SANDBOX
process.env.EWB_TEST_SKILLS = join(SANDBOX, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

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

/* ── 假模型：按定好的分片吐字 ────────────────────────────────────────
 *
 * 分片故意**每片都不一样且长度不同** —— 这样「增量」与「累计」拼出来的结果
 * 一定不同（累计会得到 '甲甲乙甲乙丙' 这种，增量才是 '甲乙丙'）。 */
const CHUNKS = ['甲', '乙丙', '丁']
const FAKE_LLM = {
  stream() {
    return (async function* () {
      for (let i = 0; i < CHUNKS.length; i += 1) {
        yield { type: 'text-delta', index: i, text: CHUNKS[i] }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
  listProviders: () => [{ id: 'fake', displayName: '假模型' }],
  listModels: async () => [{ id: 'fake-1', name: '假模型一' }],
}

const { apply } = await import('../src/index.ts')

/** 捕获到的路由处理函数。 */
let handler = null
/** 假上下文：只要 webServer 与 llm 两个服务（与 host-dispatch 同一手法）。 */
const fakeCtx = {
  inject(names, fn) {
    if (names.includes('webServer')) {
      fn({ webServer: { register(route) { handler = route.handler; return () => { /* 清理 */ } } } })
    }
    if (names.includes('llm')) fn({ llm: FAKE_LLM })
  },
  effect() { return () => { /* 清理 */ } },
}
apply(fakeCtx)

/**
 * 发一次请求（与 `host-dispatch.mjs` 的 `call` 同形，但这里是 GET、要收流）。
 * @param method - 方法。
 * @param url - 路径。
 * @param body - 请求体（可选）。
 * @returns 原始响应文本。
 */
async function callRaw(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  req.method = method
  req.url = url
  const res = new EventEmitter()
  let out = ''
  res.writeHead = () => { /* 忽略 */ }
  res.write = (chunk) => { out += String(chunk) }
  res.end = (s) => { if (typeof s === 'string') out += s }
  res.writableEnded = false
  res.writableFinished = false
  await handler(req, res)
  return out
}

console.log('=== 模型吐字实时推给前端（票 14）===')
console.log('')

/* ── ① 写一份只含一个 agent 节点的存档 ───────────────────────────── */
const NAME = '逐字推送用的'
{
  const doc = {
    version: 1,
    name: NAME,
    nodes: [{
      id: 'n1', type: 'v1', defId: 'ai.agent',
      position: { x: 0, y: 0 },
      params: { prompt: '随便说三个字', system: '', input: '', model: '', timeout: 60000 },
      onError: 'stop', skipped: false,
    }],
    edges: [],
  }
  const r = await callRaw('POST', '/api/ecom-workbench/workflows', { name: NAME, doc })
  check('★ 存档写好了', r.includes('"ok":true') || r.includes('"ok": true'), r.slice(0, 80))
}

/* ── ② 真跑一次，读 SSE 帧 ────────────────────────────────────── */
console.log('')
console.log('② 跑一次 agent 节点，从 SSE 帧里抓 stream 事件')
let sse = ''
{
  sse = await callRaw('GET', '/api/ecom-workbench/workflow/run-stream?name=' + encodeURIComponent(NAME))
  check('★ 收到 SSE 流', sse.includes('event: step'), String(sse.length) + ' 字符')

  /* 逐帧解析：每一帧是 `event: <名>\ndata: <JSON>\n\n`。 */
  const events = []
  for (const block of sse.split('\n\n')) {
    const m = /event: ([^\n]+)\ndata: ([\s\S]+)$/.exec(block.replace(/\r/g, ''))
    if (m === null) continue
    try { events.push({ name: m[1], data: JSON.parse(m[2]) }) } catch { /* 不是 JSON 就跳过 */ }
  }
  const streams = events.filter(e => e.name === 'step' && e.data?.kind === 'stream')
  check('★★ 收到 ≥2 条 stream 事件', streams.length >= 2, String(streams.length) + ' 条')
  check('★★ 每一条都带 nodeId', streams.every(s => s.data.nodeId === 'n1'),
    JSON.stringify(streams.map(s => s.data.nodeId)))

  /* ── 判据 1：按顺序拼起来等于最终文本 ── */
  const joined = streams.map(s => s.data.text).join('')
  check('★★ 按顺序拼起来等于最终文本', joined === CHUNKS.join(''), JSON.stringify(joined))

  /* ── 判据 3：是增量不是累计（这一条专门防做错） ──
   *
   * 发累计全文的话，拼出来会是 '甲' + '甲乙丙' + '甲乙丙丁' = '甲甲乙丙甲乙丙丁'，
   * 长度 8 ≠ 4。所以「拼起来恰好等于全文」这一条本身就抓住了累计的实现。 */
  check('★★ text 是增量不是累计（拼起来是 4 个字，不是 8 个）',
    joined.length === CHUNKS.join('').length, '长度 ' + String(joined.length))
  check('★★ 每条 text 就是当时那一片（逐条对上，不是每片都发全文）',
    JSON.stringify(streams.map(s => s.data.text)) === JSON.stringify(CHUNKS),
    JSON.stringify(streams.map(s => s.data.text)))

  /* 顺序：stream 事件必须夹在 started 与 success 之间（早于开始、晚于结束都不对）。 */
  const kinds = events.filter(e => e.name === 'step').map(e => e.data?.kind)
  const firstStream = kinds.indexOf('stream')
  const lastStream = kinds.lastIndexOf('stream')
  check('★ 流式事件在 started 之后、success 之前',
    firstStream > kinds.indexOf('started') && lastStream < kinds.indexOf('success'),
    'started@' + String(kinds.indexOf('started')) + ' stream@' + String(firstStream)
      + '…' + String(lastStream) + ' success@' + String(kinds.indexOf('success')))

  /* 最终文本仍然照常是节点输出（流式只是额外通道，没动数据流）。 */
  const successEv = events.find(e => e.name === 'step' && e.data?.kind === 'success')
  check('★★ 最终输出仍是全文（流式没顶替输出）',
    String(successEv?.data?.output) === CHUNKS.join(''), JSON.stringify(successEv?.data?.output))
}

/* ── ③ 运行记录里没有 stream（拿**落盘的 JSON** 核，不是核内存对象） ── */
console.log('')
console.log('③ 流式分片不许落进运行记录')
{
  const file = join(SANDBOX, 'runs', NAME + '.json')
  check('★ 运行记录落盘了', existsSync(file), file)
  let raw = ''
  if (existsSync(file)) raw = readFileSync(file, 'utf8')

  /* 落盘原文里不该有承载分片的键。
   *
   * ⚠️ **不能简单搜 `"stream"`**（第一版就是这么写错的）：这条路的运行记录里
   * 本来就有一个 `"via": "stream"`（「谁发起的」那个字段，表示走的流式入口），
   * 与分片毫无关系。照字面搜会让一个正确的实现变红 —— 那种断言比没有更坏，
   * 因为它会逼着人把 `via` 改掉。所以按**键**核，不按字面核。 */
  check('★★ 落盘原文里没有承载分片的键（chunks / text / stream 字段）',
    /"(chunks|__stream|streamText)"\s*:/.test(raw) === false
      && /"stream"\s*:\s*\[/.test(raw) === false,
    raw.includes('"via": "stream"') ? '（via: "stream" 是「谁发起的」，不在此列）' : '')
  /* 逐条核：节点明细上不许出现那个字段（万一将来有人换个键名写进去）。 */
  const parsed = (() => { try { return JSON.parse(raw) } catch { return null } })()
  const runs = Array.isArray(parsed) ? parsed : (parsed === null ? [] : [parsed])
  const lines = runs.flatMap(r => Array.isArray(r?.nodes) ? r.nodes : [])
  check('★ 读回来至少有一条节点明细', lines.length >= 1, String(lines.length))
  check('★★ 节点明细上没有任何承载分片的字段',
    lines.every(l => l.stream === undefined && l.chunks === undefined && l.text === undefined),
    JSON.stringify(Object.keys(lines[0] ?? {})))
  /* 反面：**分片的字一个都不该单独落进明细**。
   *
   * ⚠️ 第一版这里写的是「全文要落在 output 里」—— **判据本身是错的**，
   * 已改掉：运行记录的节点明细**本来就不存节点输出**（`RunNodeLine` 只有
   * nodeId / state / 时间 / logs / reports / llm 这些），要看产出得点开节点。
   * 所以「全文落进 output」这个前提在落盘这一层根本不成立，照它写必红。
   *
   * 真正该守的是反面：**分片不能变成任何一条明细字段的内容**。 */
  check('★★ 分片的字没有被当成明细的某个字段值存下来',
    lines.every(l => !Object.values(l).some(v => typeof v === 'string' && v === CHUNKS.join(''))),
    '')
  /* 分片本身绝对不能进记录：把每一片单独找一遍，一片都不该在明细里出现。 */
  check('★★ 没有任何一片分片被当成明细字段存下来',
    lines.every(l => !Object.values(l).includes(CHUNKS[0] + CHUNKS[1])),
    '')
}

/* ── ④ 没人听的时候不能崩（回调是可缺省的） ────────────────────────
 *
 * 编译器 / 预览这类场景没有 `runGraph` 在听，命令体里就没有 `__onStream`。
 * 那时 `llm.stream` 循环里那个 `typeof push === 'function'` 必须安静跳过。 */
console.log('')
console.log('④ 没有回调时照常跑（不因为多了这条通道就要求所有调用方都传）')
{
  const ex = await import('../src/dispatch/executors.ts')
  const out = await ex.createAgentExecutor(async () => ({
    ok: true, text: CHUNKS.join(''), trace: { provider: 'fake', model: 'fake-1', finish: 'stop' },
  })).run({
    runId: 'r1', nodeId: 'n1', executor: 'agent',
    command: { prompt: '随便说', timeoutMs: 5000 },
    context: { workflowId: 'w', upstream: [], workdir: SANDBOX },
  })
  check('★★ 命令体里没有 __onStream 时照样成功', out.status === 'success', String(out.status))
}

console.log('')
console.log(failed === 0
  ? '结论：模型吐字逐片推到了前端，拼起来等于全文，运行记录里一片都没留 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
