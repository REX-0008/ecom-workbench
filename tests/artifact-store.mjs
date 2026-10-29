/** 产物（图片 / 视频）的存与取、数据目录沙箱、节点自己的超时（契约 AV）。
 *
 * ## 这一段守的是什么
 *
 * 内容板块的地基：**字节能落盘、能取回、测试不碰真实目录**。
 * 这三件事任一没做对，画布做出来都是「图显示不出来」。
 *
 * ## 为什么走源码路（`import('../src/index.ts')`）
 *
 * 这里要验的是**宿主半的路由与目录解析**，源码路改完立刻生效、不需打包。
 * 产物路（`lib/index.js`）那条留给 `host-dispatch`，它验的是打包后的真实路径。
 * 两条都要，除非说得清为什么不用（`docs/机制-测试分两路.md`）。
 *
 * 跑法：node --import <tsx> tests/artifact-store.mjs
 */
/* 沙箱必须在载入任何模块之前设好 —— 目录解析在模块顶层之外调用，
 * 但 `apply()` 会碰磁盘，先把闸门立起来。 */
import { mkdtemp, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-art-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const { apply } = await import('../src/index.ts')
const { writeFileFn } = await import('../src/dispatch/builtins.ts')
const {
  storeArtifact, loadArtifact, listArtifacts, artifactsDir, canvasesDir,
  materialsDir, genLogsDir, promptCacheDir, mimeOf, extOfMime, isArtifactId,
} = await import('../src/schedule/artifacts.ts')
const { WorkflowDispatcher } = await import('../src/dispatch/dispatcher.ts')
const { NODE } = await import('../src/nodes/terminal/fs-write/node.ts')

let bad = 0
/**
 * 断言一条。
 * @param {string} name - 用例名。
 * @param {boolean} ok - 过没过。
 * @param {string} detail - 细节。
 */
function check(name, ok, detail) {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : ' → ' + detail))
}

/* 1×1 的透明 PNG（真图片，任何查看器都能打开）。用它当「二进制」的样本：
 * 判据是**文件头**，不是「写下去了 bytes 不为 0」—— 后者对一串被当文本写进去的
 * base64 也成立，那样断言等于没验。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/* ── ① `sys.fs.write` 的 binary 通道 ───────────────────────────────────── */
console.log('① sys.fs.write 能写二进制，且默认仍是 utf8')
{
  const dir = await mkdtemp(join(tmpdir(), 'ewb-art-w-'))
  const png = join(dir, 'a.png')
  const out = await writeFileFn(
    { node: 'sys.fs.write', params: { path: png, encoding: 'base64' } },
    { nodeId: 'w', workdir: dir, upstream: [PNG_B64] },
  )
  const data = await readFile(png)
  check('★★ 落盘文件是真 PNG（魔数对，不是一串 base64 文本）',
    data.subarray(0, 8).equals(PNG_MAGIC), data.subarray(0, 8).toString('hex'))
  check('★★ 字节数是**解码后**的（与磁盘上真实大小一致）',
    out?.bytes === data.length && out.bytes === Buffer.from(PNG_B64, 'base64').length,
    JSON.stringify({ return: out?.bytes, disk: data.length }))
  check('★ 不是 base64 文本长度（那会多出约 1/3）',
    out?.bytes !== Buffer.byteLength(PNG_B64, 'utf8'),
    JSON.stringify({ decoded: out?.bytes, text: Buffer.byteLength(PNG_B64, 'utf8') }))

  /* 反面断言：不传 encoding 时必须与改动前一模一样（utf8 原文写盘）。 */
  const txt = join(dir, 'b.txt')
  const out2 = await writeFileFn(
    { node: 'sys.fs.write', params: { path: txt } },
    { nodeId: 'w', workdir: dir, upstream: ['中文 hello'] },
  )
  check('★★ 不传 encoding 时仍按 utf8 写原文（默认行为不变）',
    (await readFile(txt, 'utf8')) === '中文 hello', await readFile(txt, 'utf8'))
  check('★★ 而且字节数按 utf8 算（不是解码后的长度）',
    out2?.bytes === Buffer.byteLength('中文 hello', 'utf8'), String(out2?.bytes))

  /* base64 + 追加 = 没有意义的组合，必须明确报错而不是写坏文件。 */
  let appendErr = ''
  try {
    await writeFileFn(
      { node: 'sys.fs.write', params: { path: png, mode: 'append', encoding: 'base64' } },
      { nodeId: 'w', workdir: dir, upstream: PNG_B64 },
    )
  } catch (e) { appendErr = e instanceof Error ? e.message : String(e) }
  check('★ base64 + 追加 → 明确报错（不是悄悄拼坏文件）',
    appendErr.includes('追加'), appendErr)

  /* 节点定义里那个参数真的存在，且默认值是 utf8。 */
  const def = (NODE.paramDefs ?? []).find(p => p.key === 'encoding')
  check('★ 节点定义里有 encoding 参数，默认 utf8',
    def !== undefined && def.default === 'utf8', JSON.stringify(def?.default))
}

/* ── ② 五个目录解析函数都认沙箱 ─────────────────────────────────────── */
console.log('')
console.log('② 新增的五个目录都落在 EWB_TEST_HOME 之下')
{
  const sandbox = process.env.EWB_TEST_HOME
  const dirs = {
    canvases: canvasesDir(), artifacts: artifactsDir(), materials: materialsDir(),
    genLogs: genLogsDir(), promptCache: promptCacheDir(),
  }
  for (const [k, v] of Object.entries(dirs)) {
    check('★ ' + k + ' 在沙箱里', v.startsWith(sandbox), v)
  }
  check('★ 五个目录互不相同', new Set(Object.values(dirs)).size === 5,
    Object.values(dirs).join(' | '))
}

/* ── ③ 存产物：本体 + 元数据 ───────────────────────────────────────── */
console.log('')
console.log('③ 存一条产物：本体与元数据都写对')
{
  const meta = await storeArtifact({
    base64: PNG_B64, mime: 'image/png', width: 1, height: 1,
    source: 'gen-image', workflowId: 'wf-test', runId: 'run-test',
    params: { prompt: '一只白猫', seed: 42 },
  })
  const file = join(artifactsDir(), meta.id + '.' + meta.ext)
  const onDisk = await readFile(file)
  check('★★ 本体文件存在且是真 PNG', onDisk.subarray(0, 8).equals(PNG_MAGIC), file)
  check('★★ 元数据字节数 = 本体真实大小', meta.bytes === onDisk.length,
    JSON.stringify({ meta: meta.bytes, disk: onDisk.length }))
  check('★★ mime 与扩展名对得上（png → image/png）',
    meta.mime === 'image/png' && meta.ext === 'png', meta.mime + ' / ' + meta.ext)

  const metaFile = JSON.parse(await readFile(join(artifactsDir(), meta.id + '.json'), 'utf8'))
  check('★★ 元数据文件里有宽高、来源、生成参数',
    metaFile.width === 1 && metaFile.height === 1
    && metaFile.source === 'gen-image' && metaFile.params?.prompt === '一只白猫',
    JSON.stringify(metaFile))
  console.log('    真实元数据：' + JSON.stringify(metaFile))

  /* 没有 base64 也没有 data → 必须报错，不许写一个空文件。 */
  let emptyErr = ''
  try { await storeArtifact({ mime: 'image/png' }) } catch (e) {
    emptyErr = e instanceof Error ? e.message : String(e)
  }
  check('★ 没给内容 → 报错（不写空文件）', emptyErr.includes('内容'), emptyErr)

  /* id 是 URL 的一部分，必须挡路径穿越。 */
  check('★★ 带 .. 的 id 被判非法（挡路径穿越）',
    !isArtifactId('../../browser-prefs') && !isArtifactId('.hidden'), '')
  let idErr = ''
  try { await storeArtifact({ base64: PNG_B64, id: '../逃逸' }) } catch (e) {
    idErr = e instanceof Error ? e.message : String(e)
  }
  check('★ 非法 id 存不进去', idErr.includes('不合法'), idErr)
}

/* ── ④ 取产物：元数据 + 字节；手工丢一张图也能取 ────────────────────── */
console.log('')
console.log('④ 取产物：按 id 拿回字节')
{
  const stored = await storeArtifact({ base64: PNG_B64, mime: 'image/png' })
  const got = await loadArtifact(stored.id)
  check('★★ 取回来的字节与原图逐字节相同',
    got !== null && got.data.equals(Buffer.from(PNG_B64, 'base64')),
    String(got?.data.length))
  check('★ mime 从元数据里带出来了', got?.meta.mime === 'image/png', String(got?.meta.mime))

  /* 计划 §三 Step 1 的完成标准：手工放一张图进去就能取 —— 那时没有 .json。 */
  const manual = 'manual-png'
  await mkdir(artifactsDir(), { recursive: true })
  await writeFile(join(artifactsDir(), manual + '.png'), Buffer.from(PNG_B64, 'base64'))
  const got2 = await loadArtifact(manual)
  check('★★ 没有元数据文件也能取（手工放进去的图）',
    got2 !== null && got2.data.subarray(0, 8).equals(PNG_MAGIC),
    String(got2?.data.length))
  check('★ 现场推出来的 mime 也正确', got2?.meta.mime === 'image/png', String(got2?.meta.mime))

  check('★ 不存在的 id → null（不是抛异常）', (await loadArtifact('never-existed')) === null, '')
  check('★ 非法 id → null（不读目录外的文件）', (await loadArtifact('../../x')) === null, '')

  const list = await listArtifacts()
  check('★★ 清单读得到（新的在前）', list.length >= 2 && list[0].createdAt >= list[list.length - 1].createdAt,
    list.map(x => x.id).join(','))
}

/* ── ⑤ 二进制路由：真的把字节吐回去 ───────────────────────────────── */
console.log('')
console.log('⑤ 二进制路由：content-type 正确、字节原样')
{
  /* 抓 `apply()` 注册进来的那个路由处理函数（与 `notify-prefs` 同一个手法）。 */
  let handler = null
  const fakeCtx = {
    inject(names, fn) {
      if (names.includes('webServer')) {
        fn({ webServer: { register(route) { handler = route.handler } } })
      }
      if (names.includes('subprocess')) {
        fn({ subprocess: { spawn: () => ({ terminate() {}, waitForExit: async () => true }) } })
      }
    },
    effect() { return () => { /* 清理 */ } },
  }
  apply(fakeCtx)

  /**
   * 模拟一次 HTTP 调用，保留原始响应（二进制路由回的可能是 Buffer）。
   * @param {string} method - 方法。
   * @param {string} url - 路径。
   * @param {object} [body] - 请求体。
   * @returns {Promise<{code:number, headers:object, raw:any}>} 响应。
   */
  async function call(method, url, body) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
    req.method = method
    req.url = url
    const res = new EventEmitter()
    let code = 0
    let headers = {}
    let raw
    res.writeHead = (c, h) => { code = c; headers = h ?? {} }
    res.end = (s) => { raw = s }
    res.writableEnded = false
    await handler(req, res)
    return { code, headers, raw }
  }

  const stored = await storeArtifact({ base64: PNG_B64, mime: 'image/png', source: 'test' })
  const r = await call('GET', '/api/ecom-workbench/artifact/' + stored.id)
  const rawBuf = Buffer.isBuffer(r.raw) ? r.raw : Buffer.from(String(r.raw ?? ''))
  check('★★ 路由返回 200 且回的是字节（不是 JSON）',
    r.code === 200 && rawBuf.subarray(0, 8).equals(PNG_MAGIC),
    JSON.stringify({ code: r.code, head: rawBuf.subarray(0, 8).toString('hex') }))
  check('★★ content-type 是 image/png（不是 application/json）',
    String(r.headers['content-type']) === 'image/png', String(r.headers['content-type']))
  check('★ content-length 等于真实字节数',
    String(r.headers['content-length']) === String(rawBuf.length), String(r.headers['content-length']))
  check('★ 带缓存头（no-cache + etag）',
    String(r.headers['cache-control']) === 'no-cache' && typeof r.headers.etag === 'string',
    JSON.stringify(r.headers))

  const miss = await call('GET', '/api/ecom-workbench/artifact/never-existed')
  check('★ 取不到 → 404 且给 JSON 说明（不是空白页）', miss.code === 404, String(miss.code))

  /* 存的路由：POST 一个 base64，回 id 与 url。 */
  const saved = await call('POST', '/api/ecom-workbench/artifact', {
    base64: PNG_B64, mime: 'image/png', width: 1, height: 1, source: 'route-test',
  })
  const savedBody = JSON.parse(String(saved.raw ?? '{}'))
  check('★★ 存的路由回 id + url（界面直接塞 img src）',
    savedBody.ok === true && typeof savedBody.id === 'string'
    && savedBody.url === '/api/ecom-workbench/artifact/' + savedBody.id,
    JSON.stringify({ id: savedBody.id, url: savedBody.url }))
  const again = await call('GET', savedBody.url)
  check('★★ 存完立刻取得到同一张图',
    Buffer.from(again.raw ?? '').equals(Buffer.from(PNG_B64, 'base64')), String(again.code))

  /* 目录自检路由只报路径、不建目录（GET 不该有副作用）。 */
  const dirs = await call('GET', '/api/ecom-workbench/content/dirs')
  const dirsBody = JSON.parse(String(dirs.raw ?? '{}'))
  check('★ 目录自检路由报出五个路径', dirsBody.ok === true && dirsBody.artifacts === artifactsDir(),
    JSON.stringify(dirsBody.artifacts))
}

/* ── ⑥ 派发器的「按请求指定超时」────────────────────────────────────── */
console.log('')
console.log('⑥ 超时可按请求指定，默认不变')
{
  /** 造一个只会等的执行方。
   * @param {number} waitMs - 等多久。
   * @returns {object} 执行方。 */
  const slow = (waitMs) => ({
    kind: 'builtin',
    async run() {
      await new Promise(r => setTimeout(r, waitMs))
      return { status: 'success', output: 'done' }
    },
  })
  /**
   * 建一个派发器。
   * @param {number} globalMs - 全局兜底。
   * @param {object} ex - 执行方。
   * @returns {object} 派发器。
   */
  const mk = (globalMs, ex) => { const d = new WorkflowDispatcher({ timeoutMs: globalMs }); d.register(ex); return d }
  /**
   * 造一条请求。
   * @param {number} [own] - 自己的超时。
   * @returns {object} 请求。
   */
  const req = (own) => ({
    runId: '', nodeId: 'n1', executor: 'builtin', command: {},
    context: { workflowId: 'w', upstream: [], workdir: process.cwd() },
    ...own === undefined ? {} : { timeoutMs: own },
  })

  /* ① 请求自己给了短超时 → 它生效（全局给得很长也不管用）。 */
  const r1 = await mk(60_000, slow(200)).dispatch(req(30))
  check('★★ 请求自己的超时生效（30ms 把 200ms 的节点判超时）',
    r1.status === 'failed' && r1.timedOut === true, JSON.stringify({ s: r1.status, t: r1.timedOut }))

  /* ② 请求给了长超时 → 它比全局长，所以**不**被判超时。 */
  const r2 = await mk(30, slow(120)).dispatch(req(60_000))
  check('★★ 请求的长超时压过全局短超时（120ms 的节点不被 30ms 砍掉）',
    r2.status === 'success', JSON.stringify({ s: r2.status, e: r2.error }))

  /* ③ 不填 → 用全局（默认行为不变）。 */
  const r3 = await mk(30, slow(120)).dispatch(req())
  check('★★ 不填时仍走全局兜底（默认行为一个字节不变）',
    r3.status === 'failed' && r3.timedOut === true, JSON.stringify({ s: r3.status }))

  /* ④ 填 0 / 负数 → 当没填（否则笔误会让节点立刻超时）。 */
  const r4 = await mk(60_000, slow(50)).dispatch(req(0))
  check('★ 填 0 当没填（不会立刻判超时）', r4.status === 'success', String(r4.status))
}

/* ── ⑦ 沙箱：真实数据目录零新增 ─────────────────────────────────────── */
console.log('')
console.log('⑦ 沙箱护栏')
{
  /* 判据不能只看「路径在沙箱里」—— 还要证明**真的东西都写到了沙箱**。
   * 真实目录的 mtime 比对由调用方用 `find -newermt` 做（回报里贴输出）。 */
  const s = await stat(artifactsDir())
  check('★ 产物目录已真实建出来（在沙箱里）',
    s.isDirectory() && artifactsDir().startsWith(process.env.EWB_TEST_HOME), artifactsDir())
}

console.log('')
console.log(bad === 0
  ? '结论：产物存取、二进制写入、目录沙箱全部通过 ✓'
  : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
