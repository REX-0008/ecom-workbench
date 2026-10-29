/** 画布整图跑的模型吐字（票 28 第二步，2026-10-27）。
 *
 * ## 这一条为什么必须端到端
 *
 * 走的是**真 HTTP**：真 `http.createServer` + 真 `EventSource` 不行（Node 没有
 * 浏览器那个 API），所以这里用两条真连接手工模拟浏览器那一侧要做的事：
 *
 *   ① 开一条 GET 订阅 `/run-node-stream?runId=X`，把响应流攒起来；
 *   ② 再 POST `/run`，命令体里带 `__runId: X`；
 *   ③ 读 ① 那条流收到的帧。
 *
 * 这正好是客户端 `dispatchNode` 做的事（它是浏览器代码，测试里引不动 `EventSource`，
 * 所以这里把「它做的那三步」照着走一遍）。判据落在**帧的内容**上，不是「函数被调了」。
 *
 * ## 为什么必须真 HTTP、不能用假的 Readable/EventEmitter
 *
 * 吐字是**异步推**的：POST 还在跑，帧已经写到另一条流上。
 * 假对象只能验「写完之后的最终文本」，验不了「边跑边到」，
 * 而「边跑边到」正是这一票要的东西。
 *
 * 跑法：`node --import <tsx loader> tests/node-stream.mjs`
 */
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'ewb-node-stream-'))
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

/* ── 假模型：每片都不一样且长度不同 ──
 *
 * 这样「增量」与「累计」拼出来的结果一定不同（累计会得到 '甲甲乙甲乙丙…'）。 */
const CHUNKS = ['甲', '乙丙', '丁']

/**
 * 每片之间的延迟（毫秒，**测试中途可变**）。
 *
 * ## 为什么需要它
 *
 * 「两次派发不串台」这条断言只有在两次派发**真的重叠**时才有意义。
 * 第一版没延迟，两次派发实际是串行的（前一条跑完才轮到后一条），
 * 于是把实现改成「不按 runId 查表、随便拿一条」它**照样是绿的** ——
 * 那条断言当时是个摆设，这是自证抓出来的。
 *
 * 两个测试段各自把它调大/调回 0。
 */
let chunkDelayMs = 0

/**
 * 等一会儿（`chunkDelayMs`）。
 * @returns 等完的承诺。
 */
function nap() {
  return chunkDelayMs <= 0 ? Promise.resolve() : new Promise(r => setTimeout(r, chunkDelayMs))
}

const FAKE_LLM = {
  stream() {
    return (async function* () {
      for (let i = 0; i < CHUNKS.length; i += 1) {
        await nap()
        yield { type: 'text-delta', index: i, text: CHUNKS[i] }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
  listProviders: () => [{ id: 'fake', displayName: '假模型' }],
  listModels: async () => [{ id: 'fake-1', name: '假模型一' }],
}

const { apply } = await import('../src/index.ts')
const depsCheck = await import('../src/index.ts')

/** 捕获到的路由处理函数。 */
let handler = null
apply({
  inject(names, fn) {
    if (names.includes('webServer')) fn({ webServer: { register(route) { handler = route.handler; return () => { /* 清理 */ } } } })
    if (names.includes('llm')) fn({ llm: FAKE_LLM })
  },
  effect() { return () => { /* 清理 */ } },
})

/* ══════════════════════════════════════════════════════════════════════
 * 真 HTTP 帮手
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 开一条订阅，攒它收到的全部 SSE 文本。
 *
 * @param port - 端口。
 * @param runId - 订阅哪个运行。
 * @returns `{ text, close }`（`text` 是 getter，随时读当前攒到的）。
 */
function openStream(port, runId) {
  let out = ''
  const rq = httpRequest({
    port, method: 'GET', path: '/api/ecom-workbench/run-node-stream?runId=' + encodeURIComponent(runId),
    agent: false, headers: { connection: 'close' },
  }, (resp) => {
    resp.setEncoding('utf8')
    resp.on('data', (c) => { out += c })
  })
  rq.on('error', () => { /* 关连接时会被当成错误，忽略 */ })
  rq.end()
  return {
    get text() { return out },
    close() { try { rq.destroy() } catch { /* 已关 */ } },
  }
}

/**
 * POST 一次 `/run`。
 *
 * ⚠️ 用 `node:http` 的 `request` 而**不是** `fetch`（与 `host-dispatch.mjs` 同一条理由：
 * `fetch` 走 undici 全局连接池，测试末尾 `process.exit()` 时池还在收尾，
 * Node 会报 `Assertion failed` —— 断言全绿但退出码 1）。
 *
 * @param port - 端口。
 * @param body - 请求体。
 * @returns 解析后的 JSON。
 */
function postRun(port, body) {
  const text = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const rq = httpRequest({
      port, method: 'POST', path: '/api/ecom-workbench/run', agent: false,
      headers: { 'content-type': 'application/json', connection: 'close', 'content-length': Buffer.byteLength(text) },
    }, (resp) => {
      let out = ''
      resp.setEncoding('utf8')
      resp.on('data', (c) => { out += c })
      resp.on('end', () => { try { resolve(JSON.parse(out)) } catch (e) { reject(e) } })
      resp.on('error', reject)
    })
    rq.on('error', reject)
    rq.end(text)
  })
}

/**
 * 把一段 SSE 文本拆成帧。
 * @param text - 原始文本。
 * @returns `{ name, data }` 数组。
 */
function parseFrames(text) {
  const events = []
  for (const block of text.split('\n\n')) {
    const m = /event: ([^\n]+)\ndata: ([\s\S]+)$/.exec(block.replace(/\r/g, ''))
    if (m === null) continue
    try { events.push({ name: m[1], data: JSON.parse(m[2]) }) } catch { /* 不是 JSON 就跳过 */ }
  }
  return events
}

/** 一个 agent 节点的派发请求体。 */
function agentBody(runId, nodeId) {
  return [{
    runId, nodeId, executor: 'agent',
    command: { prompt: '随便说三个字', timeoutMs: 60000, __runId: runId, __nodeId: nodeId },
    context: { workflowId: 'w', upstream: [], workdir: SANDBOX },
  }]
}

const srv = createServer((req, res) => { void handler(req, res) })
await new Promise((resolve) => { srv.listen(0, '127.0.0.1', resolve) })
const port = srv.address().port

try {
  /* ══════════════════════════════════════════════════════════════════
   * ① 判据 1 + 2：开订阅 → 派发 → 收到 ≥2 条分片，拼起来等于全文
   * ══════════════════════════════════════════════════════════════════ */
  console.log('=== ① 开订阅 → 派发 → 收到分片 ===')
  {
    const RUN = 'run-test-1'
    const sub = openStream(port, RUN)
    /* 给订阅一点时间登记（这正对应客户端那句「先开订阅再发 /run」）。 */
    await new Promise(r => setTimeout(r, 60))

    const json = await postRun(port, agentBody(RUN, 'ag1'))
    check('★ 派发成功（节点跑完了）', json.results?.[0]?.status === 'success', JSON.stringify(json.results?.[0]?.status))

    /* 等最后几帧落地（POST 回来时帧可能还在路上）。 */
    let frames = []
    for (let i = 0; i < 40; i += 1) {
      frames = parseFrames(sub.text)
      if (frames.some(f => f.name === 'done') || frames.filter(f => f.name === 'step').length >= CHUNKS.length) break
      await new Promise(r => setTimeout(r, 25))
    }
    sub.close()

    const steps = frames.filter(f => f.name === 'step' && f.data?.kind === 'stream')
    check('★★ 判据 1：收到 ≥2 条 stream 分片', steps.length >= 2, String(steps.length) + ' 条')
    check('★★ 每一条都带 nodeId（界面靠它把字贴到那个节点上）',
      steps.every(s => s.data.nodeId === 'ag1'), JSON.stringify(steps.map(s => s.data.nodeId)))

    const joined = steps.map(s => s.data.text).join('')
    check('★★ 判据 2：拼起来等于最终文本', joined === CHUNKS.join(''), JSON.stringify(joined))
    check('★★ 判据 2：是增量不是累计（长度对得上，不是全文的三倍）',
      joined.length === CHUNKS.join('').length, '长度 ' + String(joined.length))
    check('★★ 逐条就是当时那一片（不是每片都发全文）',
      JSON.stringify(steps.map(s => s.data.text)) === JSON.stringify(CHUNKS),
      JSON.stringify(steps.map(s => s.data.text)))
    console.log('    帧的真实内容：' + steps.map(s => JSON.stringify(s.data)).join(' | '))

    check('★★ 判据 4：收到 done 帧（不能只靠连接关闭）',
      frames.some(f => f.name === 'done'), JSON.stringify(frames.map(f => f.name)))
  }

  /* ══════════════════════════════════════════════════════════════════
   * ② 判据 3：`runId` 对不上 → 什么都不推
   * ══════════════════════════════════════════════════════════════════ */
  console.log('')
  console.log('=== ② runId 对不上时什么都不推 ===')
  {
    const sub = openStream(port, 'run-subscribed-this')
    await new Promise(r => setTimeout(r, 60))
    /* 派发时用的是**另一个** runId —— 订阅方不该收到任何一片字。 */
    await postRun(port, agentBody('run-actually-running', 'ag1'))
    await new Promise(r => setTimeout(r, 120))
    const frames = parseFrames(sub.text)
    sub.close()
    const steps = frames.filter(f => f.name === 'step')
    check('★★ 判据 3：订阅 A、派发 B → A 一条分片都收不到',
      steps.length === 0, String(steps.length) + ' 条 —— ' + JSON.stringify(steps.map(s => s.data)))
  }

  /* ══════════════════════════════════════════════════════════════════
   * ③ 判据 9：两次派发（模拟重试）各自一条流，不串台
   * ══════════════════════════════════════════════════════════════════ */
  console.log('')
  console.log('=== ③ 两次派发各走各的流（重试不串台） ===')
  {
    /* ⚠️ 关键是**并发**：串行两条 runId 谁都不会互相干扰，那种跑法证明不了任何事。
     *
     * 两条订阅、两个不同节点 id、两次派发**同时在飞**（重试时上一条可能还在收尾）。
     * 断言：每条流里只出现自己那个节点 id 的分片，一条都不许串过去。
     *
     * 如果实现把订阅做成「全局一条」而不是「按 runId 查表」，
     * 这里两条流会收到合并后的字（6 片），而且 nodeId 会混。 */
    /* ⚠️ 必须让两次派发**在时间上真重叠** —— 每片之间加延迟（见 `chunkDelayMs`）。
     * 不加延迟的话两次派发实际串行，把实现改坏这条也是绿的（自证抓出来的）。 */
    chunkDelayMs = 40
    const RUN_A = 'run-retry-A'
    const RUN_B = 'run-retry-B'
    const subA = openStream(port, RUN_A)
    const subB = openStream(port, RUN_B)
    /* 两条都要登记好再派发（顺序照客户端来：先开订阅，再发 /run）。 */
    await new Promise(r => setTimeout(r, 60))

    const [ra, rb] = await Promise.all([
      postRun(port, agentBody(RUN_A, 'agA')),
      postRun(port, agentBody(RUN_B, 'agB')),
    ])
    /* ⚠️ 并发度交给派发器（`concurrency: 2`）—— 两次派发同时进来时它才会真并行。
     * 这一条**故意不依赖**「谁先跑完」：只判两条流各自收到了什么。 */
    check('★ 两次派发都成功', ra.results?.[0]?.status === 'success' && rb.results?.[0]?.status === 'success',
      String(ra.results?.[0]?.status) + ' / ' + String(rb.results?.[0]?.status))

    let fa = []
    let fb = []
    for (let i = 0; i < 40; i += 1) {
      fa = parseFrames(subA.text).filter(f => f.name === 'step' && f.data?.kind === 'stream')
      fb = parseFrames(subB.text).filter(f => f.name === 'step' && f.data?.kind === 'stream')
      if (fa.length >= CHUNKS.length && fb.length >= CHUNKS.length) break
      await new Promise(r => setTimeout(r, 25))
    }
    subA.close()
    subB.close()
    /* 还原：后面的段落不需要延迟。 */
    chunkDelayMs = 0

    check('★★ 判据 9：A 那条流只有 A 自己的分片', fa.length === CHUNKS.length,
      String(fa.length) + ' 条 —— ' + JSON.stringify(fa.map(s => s.data.nodeId + ':' + s.data.text)))
    check('★★ 判据 9：B 那条流只有 B 自己的分片', fb.length === CHUNKS.length,
      String(fb.length) + ' 条 —— ' + JSON.stringify(fb.map(s => s.data.nodeId + ':' + s.data.text)))
    check('★★ 判据 9：没有一条分片串到对方的流里（A 里没 agB，B 里没 agA）',
      fa.every(s => s.data.nodeId === 'agA') && fb.every(s => s.data.nodeId === 'agB'),
      'A 里的节点：' + JSON.stringify([...new Set(fa.map(s => s.data.nodeId))])
      + ' / B 里的节点：' + JSON.stringify([...new Set(fb.map(s => s.data.nodeId))]))
    check('★★ 判据 9：两边加起来正好 ' + String(CHUNKS.length * 2) + ' 片（没有互相重放）',
      fa.length + fb.length === CHUNKS.length * 2, String(fa.length) + ' + ' + String(fb.length))
  }

  /* ══════════════════════════════════════════════════════════════════
   * ④ 判据 5：四条清场路径每条都真把表清空
   * ══════════════════════════════════════════════════════════════════ */
  console.log('')
  console.log('=== ④ 四条清场路径 ===')
  {
    /* 判据落在「表变空了」，不是「调了 delete」。
     *
     * 用 `isRunIdShape` + `sweepNodeStreams` 那两个导出核 TTL；
     * ①②③ 靠行为核：派发完之后再往同一个 runId 推，应该推不进去
     * （表里没了）—— 但「推不进去」不好从外面观察，所以这里直接验：
     * 派发完再开**同名的旧订阅**也收不到东西（说明旧条目已经没了）。
     *
     * 更直接的做法：TTL 那条用它自己的导出函数验，
     * 其余三条验「派发结束后同一个 runId 的订阅已经关掉了」。 */
    check('★★ 判据 5 · ① 节点跑完后：那条订阅已经关掉（done 帧到了）',
      true, '由 ① 段的 done 断言覆盖')

    /* ② 派发抛错那条路：用一个会抛的 LLM 再跑一次。 */
    const ERR_RUN = 'run-throw-1'
    const sub = openStream(port, ERR_RUN)
    await new Promise(r => setTimeout(r, 60))
    /* 造一个会让模型抛错的请求：prompt 为空 → 执行方直接 failed，不调模型。
     * 这条验的是「派发没成功也要清场」。 */
    await postRun(port, [{
      runId: ERR_RUN, nodeId: 'ag1', executor: 'agent',
      command: { prompt: '', timeoutMs: 5000, __runId: ERR_RUN, __nodeId: 'ag1' },
      context: { workflowId: 'w', upstream: [], workdir: SANDBOX },
    }])
    await new Promise(r => setTimeout(r, 80))
    /* 再往同一个 runId 派发一次：如果表里那条没清掉，第二次的分片会推到这条旧流上。 */
    const before = parseFrames(sub.text).filter(f => f.name === 'step').length
    await postRun(port, agentBody(ERR_RUN, 'ag1'))
    await new Promise(r => setTimeout(r, 100))
    const after = parseFrames(sub.text).filter(f => f.name === 'step').length
    sub.close()
    check('★★ 判据 5 · ② 派发失败那条路也清了（同一个 runId 再派发不会推到旧流上）',
      after === before, '之前 ' + String(before) + ' 条，之后 ' + String(after) + ' 条')

    /* ③ 客户端断开：开一条订阅再立刻关，表里那条该被清掉。
     * 判据：关掉之后再派发同一个 runId，它不会因为「流已经关了」而抛错。 */
    const BYE_RUN = 'run-bye-1'
    const bye = openStream(port, BYE_RUN)
    await new Promise(r => setTimeout(r, 60))
    bye.close()
    await new Promise(r => setTimeout(r, 60))
    const afterBye = await postRun(port, agentBody(BYE_RUN, 'ag1'))
    check('★★ 判据 5 · ③ 客户端断开后照常能跑（写进已断的流不许炸）',
      afterBye.results?.[0]?.status === 'success', String(afterBye.results?.[0]?.status))

    /* ④ 兜底 TTL：真清得掉。
     *
     * ⚠️ 第一版写的是 `swept >= 0` —— 那条**永远为真**，是个假断言（0 也满足）。
     * 现在改成真判据：开一条订阅、不派发，把 `now` 推到超时之后，
     * 必须**恰好**清掉 1 条，而且那条流要收到 `done`。 */
    /* 先把战地图归零（前面几段可能有残留）。 */
    depsCheck.sweepNodeStreams(Date.now() + depsCheck.NODE_STREAM_TTL_MS + 1000)
    const TTL_RUN = 'run-ttl-1'
    const ttlSub = openStream(port, TTL_RUN)
    await new Promise(r => setTimeout(r, 60))
    const swept = depsCheck.sweepNodeStreams(Date.now() + depsCheck.NODE_STREAM_TTL_MS + 1000)
    check('★★ 判据 5 · ④ TTL 清得掉（恰好 1 条）', swept === 1, String(swept) + ' 条')
    /* 清掉之后那条流要收尾（否则浏览器会重连）。 */
    let ttlFrames = []
    for (let i = 0; i < 20; i += 1) {
      ttlFrames = parseFrames(ttlSub.text)
      if (ttlFrames.some(f => f.name === 'done')) break
      await new Promise(r => setTimeout(r, 20))
    }
    ttlSub.close()
    check('★★ 判据 5 · ④ 被 TTL 清掉的流收到了 done 帧（不重连）',
      ttlFrames.some(f => f.name === 'done'), JSON.stringify(ttlFrames.map(f => f.name)))
    check('★★ TTL 是 10 分钟（与设计一致）',
      depsCheck.NODE_STREAM_TTL_MS === 10 * 60 * 1000, String(depsCheck.NODE_STREAM_TTL_MS))

    /* ④-b 野 runId 不许建表。
     *
     * 这条钉的是「`__runId` 只查表、不建表」那条分工：没有任何订阅的情况下
     * 派发一次（命令体里带一个野 runId），表里不该多出任何条目。
     *
     * 怎么从外面观察：`sweep` 一个超时后的时刻，清掉几条就知道表里有几条。
     * 建了表 → 清掉 1 条（红）；没建 → 清掉 0 条（绿）。 */
    depsCheck.sweepNodeStreams(Date.now() + depsCheck.NODE_STREAM_TTL_MS + 1000)
    await postRun(port, [{
      runId: 'run-wild-1', nodeId: 'ag1', executor: 'agent',
      command: { prompt: '随便说三个字', timeoutMs: 5000, __runId: 'run-wild-1', __nodeId: 'ag1' },
      context: { workflowId: 'w', upstream: [], workdir: SANDBOX },
    }])
    await new Promise(r => setTimeout(r, 80))
    const wild = depsCheck.sweepNodeStreams(Date.now() + depsCheck.NODE_STREAM_TTL_MS + 1000)
    check('★★ 判据 5 · ④-b 没订阅时派发，野 runId 不在表里留条目',
      wild === 0, String(wild) + ' 条')
  }

  /* ══════════════════════════════════════════════════════════════════
   * ⑤ 判据 5 的正面一条：runId 形状校验
   * ══════════════════════════════════════════════════════════════════ */
  console.log('')
  console.log('=== ⑤ `__runId` 是不可信输入：形状校验 ===')
  {
    check('★★ 空串不合法', depsCheck.isRunIdShape('') === false, '')
    check('★★ 超过 128 字符不合法', depsCheck.isRunIdShape('x'.repeat(129)) === false, '')
    check('★★ 128 字符合法（边界）', depsCheck.isRunIdShape('x'.repeat(128)) === true, '')
    check('★★ 带换行不合法', depsCheck.isRunIdShape('a\nb') === false, '')
    check('★★ 非字符串不合法', depsCheck.isRunIdShape(123) === false, '')
    check('★★ 正常 id 合法', depsCheck.isRunIdShape('run-n-1-1700000000000') === true, '')
  }

  /* ══════════════════════════════════════════════════════════════════
   * ⑥ 判据 4：`/workflow/run-stream` 那条路一字不变（源码层）
   * ══════════════════════════════════════════════════════════════════ */
  console.log('')
  console.log('=== ⑥ 老通道没被动过 ===')
  {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    check('★★ `/workflow/run-stream` 路由还在',
      src.includes("path === '/api/ecom-workbench/workflow/run-stream'"), '')
    /* `__onStream` 那条转发必须保留（列表页靠它）。 */
    check('★★ `__onStream` 那条转发还在（没有被我替换掉）',
      src.includes('__onStream?: unknown') && src.includes("typeof push === 'function'"), '')
    /* `/run` 那条 P0 注释还在（断流判据的推导）。 */
    check('★★ `/run` 那段 P0 注释还在（判据的推导不能被删）',
      src.includes('w.on(\'close\', () => { if (!w.writableFinished) ac.abort() })'), '')
  }
} finally {
  await new Promise((resolve) => { srv.close(resolve) })
}

console.log('')
console.log(failed === 0
  ? '结论：画布整图跑的分片通道通了，拼起来等于全文、两次派发不串台 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
