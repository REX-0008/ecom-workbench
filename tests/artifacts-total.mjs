/** 产物库超过 200 条时总数要真（票 52，2026-10-28）。
 *
 * # 这一单修的是什么
 *
 * `GET /artifacts` 的回包里 `total` **一直有这个键**，但它的值是
 * `items.length` —— 那是**截断后**的条数（`listArtifacts` 默认只读 200 条）。
 * 界面拿它显示「共 N 条」，超过 200 时那个数是假的。
 *
 * 用户拿这个数判断「要不要清理」：显示的比实际少，他会以为已经干净了。
 *
 * # 这一份盯三件事
 *
 * | 盯什么 | 为什么 |
 * |---|---|
 * | `total` 是真数（造 N+ 条，比总数） | 这是本票的目标 |
 * | 超上限时有「显示前 N 条」那句 | 票面明令：不许静默截断 |
 * | **不超过上限时显示与改动前完全一样** | 防回归 —— 大多数人没有 200 条，他们不该看到变化 |
 *
 * # 还要验一条不属于「显示」的事
 *
 * `countArtifacts` **不能**改掉 `listArtifacts` 的行为。它只是数文件，
 * 不许顺手把上限去掉、也不许改排序。这一条单独验，因为「顺手把 limit 调大」
 * 是最容易发生的越界。
 *
 * 跑法：`node scripts/run-tests.mjs artifacts-total`
 */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-arttotal-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const { listArtifacts, countArtifacts, artifactsDir } = await import('../src/schedule/artifacts.ts')

let bad = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} ok - 过没过。
 * @param {string} [detail] - 细节。
 */
function check(name, ok, detail) {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : '  → ' + detail))
}

/**
 * 造一条产物的元数据（只有 `.json`，不要本体 —— 计数与列表都只认 `.json`）。
 * @param {number} i - 序号（决定 createdAt）。
 */
async function putMeta(i) {
  const dir = artifactsDir()
  await mkdir(dir, { recursive: true })
  const id = '20261028-' + String(i).padStart(3, '0') + '-aa' + String(i).padStart(2, '0')
  const meta = { id, ext: 'png', mime: 'image/png', bytes: 10, createdAt: 1000 + i, width: 8, height: 8 }
  await writeFile(join(dir, id + '.json'), JSON.stringify(meta), 'utf8')
  return id
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 空目录与少量产物：两个数一致
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 目录不存在 / 少量产物：两个数一致 ===')
{
  check('★★ 目录不存在时总数是 0（不是报错）', (await countArtifacts()) === 0, String(await countArtifacts()))
  check('★ 同一情况下列表也是空的', (await listArtifacts()).length === 0)

  await putMeta(1)
  await putMeta(2)
  await putMeta(3)
  check('★★ 3 条时总数是 3', (await countArtifacts()) === 3, String(await countArtifacts()))
  check('★ 3 条时列表也是 3 条', (await listArtifacts()).length === 3)
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 关键一条：超过 200 条时，总数是真数而列表仍被截断
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 造 260 条：列表 200 条，总数 260（这就是本票修的假数）===')
{
  for (let i = 4; i <= 260; i += 1) await putMeta(i)

  const total = await countArtifacts()
  const list = await listArtifacts()
  check('★★★ 总数是磁盘上的真实条数 260', total === 260, String(total))
  check('★★ 列表仍只有 200 条（**没有**把 limit 调大）', list.length === 200, String(list.length))
  check('★★★ 两个数不同 —— 这正是原来那个假数：`items.length` 会是 200',
    list.length !== total, list.length + ' vs ' + String(total))
  check('★★ 修好之后：总数 > 已显示条数（界面据此显示「显示前 N 条」）',
    total > list.length, String(total) + ' > ' + String(list.length))
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 计数不许改列表的行为（防「顺手把上限去掉」）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ `countArtifacts` 不改 `listArtifacts` 的行为 ===')
{
  const a = await listArtifacts()
  await countArtifacts()
  const b = await listArtifacts()
  check('★★★ 调过计数之后列表内容与之前逐条相同（没有副作用）',
    JSON.stringify(a) === JSON.stringify(b), '条数 ' + String(a.length) + ' / ' + String(b.length))
  check('★★ 列表仍是**新的在前**（`createdAt` 倒序，不是最旧的在前）',
    a.length >= 2 && a[0].createdAt > a[a.length - 1].createdAt,
    '第一条 ' + String(a[0]?.createdAt) + ' / 最后一条 ' + String(a[a.length - 1]?.createdAt))
  check('★★ 显示的是**最新那 200 条**（最旧的那批被截掉了）',
    !a.some(m => m.createdAt <= 1000 + 60),
    '列表里最早的 createdAt = ' + String(Math.min(...a.map(m => m.createdAt))))
  check('★ `listArtifacts(5)` 仍然只给 5 条（默认上限没被改掉）',
    (await listArtifacts(5)).length === 5, String((await listArtifacts(5)).length))
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 口径：坏 JSON 算不算一条
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 口径：坏元数据算进总数、但列不出来 ===')
{
  const before = await countArtifacts()
  const beforeList = (await listArtifacts()).length
  await writeFile(join(artifactsDir(), 'broken-meta.json'), '{ 这不是 JSON', 'utf8')

  check('★★ 坏文件**算**进总数（它确实占着磁盘，藏掉就是又一次「总数比实际少」）',
    (await countArtifacts()) === before + 1, String(await countArtifacts()))
  check('★★ 但它列不出来（列表跳过读不出来的）',
    (await listArtifacts()).length === beforeList, String((await listArtifacts()).length))
  /* 这一条是「两个数可以不一致」的合法情形 —— 记下来，免得以后把它当 bug 修。 */
  check('★ 所以「总数 − 已显示」可能比「被截掉的条数」多，那是正常的',
    (await countArtifacts()) > (await listArtifacts()).length)
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 路由：`GET /artifacts` 回的 `total` 是真数（端到端那一段）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 路由回的 total 是真数，不是 items.length ===')
{
  /* 起真路由（照 `tests/canvases.mjs` 的桩 ctx 做法）。 */
  const { Readable } = await import('node:stream')
  const { EventEmitter } = await import('node:events')
  const { apply } = await import('../src/index.ts')

  let handler = null
  apply({
    inject(names, fn) {
      if (names.includes('webServer')) fn({ webServer: { register(route) { handler = route.handler } } })
      if (names.includes('subprocess')) fn({ subprocess: { spawn: () => ({ terminate() {}, waitForExit: async () => true }) } })
    },
    effect() { return () => { /* 清理 */ } },
  })

  /**
   * 调一次路由。
   * @param {string} url - 路径。
   * @returns {Promise<object>} 响应（code + json）。
   */
  async function get(url) {
    const req = Readable.from([])
    req.method = 'GET'
    req.url = url
    const res = new EventEmitter()
    let code = 0
    let text = ''
    res.writeHead = (c) => { code = c }
    res.end = (s) => { text = String(s ?? '') }
    res.writableEnded = false
    await handler(req, res)
    let json = null
    try { json = JSON.parse(text) } catch { json = null }
    return { code, json }
  }

  const r = await get('/api/ecom-workbench/artifacts')
  const real = await countArtifacts()
  const listed = (await listArtifacts()).length

  check('★★ 路由通（200）', r.code === 200, String(r.code))
  check('★★★ 路由回的 total 是磁盘上的真实条数（不是 items.length）',
    r.json?.total === real, 'total=' + String(r.json?.total) + ' 真实=' + String(real))
  check('★★★ 真数比已显示的条数多（超过 200 时正是它）',
    real > listed, String(real) + ' > ' + String(listed))
  check('★★ 回包里同时有 `items` 与 `artifacts` 两个键（契约 BC：内容一致）',
    Array.isArray(r.json?.items) && Array.isArray(r.json?.artifacts)
    && JSON.stringify(r.json.items) === JSON.stringify(r.json.artifacts),
    'items=' + String(r.json?.items?.length) + ' artifacts=' + String(r.json?.artifacts?.length))
  check('★ `items` 的条数仍是 200（没有为了总数把上限调大）',
    r.json?.items?.length === listed, String(r.json?.items?.length))
}

console.log('')
console.log(bad === 0 ? '全部通过 ✓' : '有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
