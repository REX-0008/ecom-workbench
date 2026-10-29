/** 内容画布项目的 CRUD（契约 AX，2026-10-25）。
 *
 * ## 这一段守的是什么
 *
 * 计划 §三 3.1：画布存得进去、取得回来、列表能看到、删得掉。
 * 界面那侧（拖拽、400ms 防抖自动保存、撤销栈）全建立在这一层之上。
 *
 * ## 为什么专门验「列表不回节点内容」
 *
 * 一个画布几十个节点、每个节点带位置与参数，列表页会把整份 JSON 搬一遍。
 * 计划明确要求列表只回 `nodeCount`。这条不验的话，实现里一个 `...doc` 就把它泄了。
 *
 * 跑法：node --import <tsx> tests/canvases.mjs
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-cv-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const { apply } = await import('../src/index.ts')
const { canvasesDir } = await import('../src/schedule/artifacts.ts')

let handler = null
const fakeCtx = {
  inject(names, fn) {
    if (names.includes('webServer')) fn({ webServer: { register(route) { handler = route.handler } } })
    if (names.includes('subprocess')) fn({ subprocess: { spawn: () => ({ terminate() {}, waitForExit: async () => true }) } })
  },
  effect() { return () => { /* 清理 */ } },
}
apply(fakeCtx)

/**
 * 模拟一次 HTTP 调用。
 * @param {string} method - 方法。
 * @param {string} url - 路径。
 * @param {object} [body] - 请求体。
 * @returns {Promise<{code:number, text:string, json:any}>} 响应。
 */
async function call(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  req.method = method
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
  return { code, text, json }
}

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

/* 造一份「界面上真会长这样」的画布内容：节点带位置与参数，连线带 id。 */
const NODES = [
  { id: 'n1', type: 'text', position: { x: 0, y: 0 }, data: { text: '一只白猫' } },
  { id: 'n2', type: 'image', position: { x: 320, y: 0 }, data: { artifactId: 'a-1' } },
  { id: 'n3', type: 'config', position: { x: -320, y: 0 }, data: { model: 'gpt-image-1' } },
]
const EDGES = [{ id: 'e1', source: 'n1', target: 'n2' }, { id: 'e2', source: 'n3', target: 'n2' }]
const VIEWPORT = { x: -120, y: 40, zoom: 0.8 }

let canvasId = ''

/* ── ① 新建 → 列表 → 取完整 ─────────────────────────────────────── */
console.log('① 新建 → 列表能看到（带 nodeCount）→ 取完整')
{
  const made = await call('POST', '/api/ecom-workbench/canvases', {
    title: '第一张画布', nodes: NODES, edges: EDGES, viewport: VIEWPORT,
  })
  const doc = made.json?.canvas
  canvasId = doc?.id ?? ''
  check('★★ 新建成功并给了 id', made.code === 200 && typeof doc?.id === 'string' && doc.id !== '',
    String(doc?.id))
  check('★★ 新建就带上了时间戳', typeof doc?.createdAt === 'number' && typeof doc?.updatedAt === 'number',
    JSON.stringify({ c: doc?.createdAt, u: doc?.updatedAt }))
  check('★★ nodes / edges / viewport 原样存下来了（不解释）',
    JSON.stringify(doc?.nodes) === JSON.stringify(NODES)
    && JSON.stringify(doc?.edges) === JSON.stringify(EDGES)
    && JSON.stringify(doc?.viewport) === JSON.stringify(VIEWPORT),
    JSON.stringify({ n: doc?.nodes?.length, e: doc?.edges?.length }))

  const file = JSON.parse(await readFile(join(canvasesDir(), canvasId + '.json'), 'utf8'))
  check('★★ 文件真落到 canvases/ 下了（一个画布一个文件）', file.id === canvasId,
    join('canvases', canvasId + '.json'))

  const list = await call('GET', '/api/ecom-workbench/canvases')
  const items = list.json?.canvases ?? []
  const mine = items.find(c => c.id === canvasId)
  check('★★ 列表里能看到它', mine !== undefined, items.map(c => c.id).join(','))
  /* 契约 BC 的约定：具名键与 `items` 同时给、内容一致（deepEqual —— HTTP 传过来
   * 必然是两份独立的数组实例，比引用没有意义）。 */
  check('★★ 具名键与 items 两个键内容一致（列表类接口的约定）',
    JSON.stringify(list.json?.canvases) === JSON.stringify(list.json?.items)
    && Array.isArray(list.json?.items),
    JSON.stringify({ named: (list.json?.canvases ?? []).length, items: (list.json?.items ?? []).length }))
  check('★★ 列表带 nodeCount = 3', mine?.nodeCount === 3, String(mine?.nodeCount))
  check('★★ 列表**不回节点内容**（界面列表页不该搬整份 JSON）',
    mine !== undefined && mine.nodes === undefined && mine.edges === undefined
    && mine.viewport === undefined, JSON.stringify(Object.keys(mine ?? {})))

  const full = await call('GET', '/api/ecom-workbench/canvases/' + canvasId)
  check('★★ 按 id 取回完整记录（含 nodes）',
    full.code === 200 && full.json?.canvas?.nodes?.length === 3,
    String(full.json?.canvas?.nodes?.length))
}

/* ── ② 改（整份覆盖 + updatedAt 前进）────────────────────────────── */
console.log('')
console.log('② 整份覆盖保存')
{
  const before = (await call('GET', '/api/ecom-workbench/canvases/' + canvasId)).json?.canvas
  /* 时间戳精度是毫秒，稍等一下才能看出「更新了」。 */
  await new Promise(r => setTimeout(r, 8))
  const nextNodes = [...NODES, { id: 'n4', type: 'video', position: { x: 640, y: 0 }, data: {} }]
  const put = await call('PUT', '/api/ecom-workbench/canvases/' + canvasId, {
    title: '改了名字的画布', nodes: nextNodes, edges: EDGES,
    viewport: { x: 0, y: 0, zoom: 1 },
  })
  check('★★ 保存成功', put.code === 200 && put.json?.ok === true, String(put.code))
  check('★★ nodes 被整份换掉了（4 个）',
    put.json?.canvas?.nodes?.length === 4, String(put.json?.canvas?.nodes?.length))
  check('★★ 名字改过来了', put.json?.canvas?.title === '改了名字的画布', String(put.json?.canvas?.title))
  check('★★ updatedAt 前进了（界面靠它排序）',
    put.json?.canvas?.updatedAt > before?.updatedAt,
    JSON.stringify({ before: before?.updatedAt, after: put.json?.canvas?.updatedAt }))
  check('★★ createdAt 没被改（创建时间是历史事实）',
    put.json?.canvas?.createdAt === before?.createdAt,
    JSON.stringify({ before: before?.createdAt, after: put.json?.canvas?.createdAt }))

  const reread = (await call('GET', '/api/ecom-workbench/canvases/' + canvasId)).json?.canvas
  check('★★ 重新读回来是新的那份（真落盘了）', reread?.nodes?.length === 4,
    String(reread?.nodes?.length))
}

/* ── ③ 404：不存在 / 非法 id ──────────────────────────────────────── */
console.log('')
console.log('③ 不存在与非法 id')
{
  const g = await call('GET', '/api/ecom-workbench/canvases/cv_never')
  check('★★ GET 不存在的 → 404 + 那句原文',
    g.code === 404 && g.json?.ok === false && g.json?.error === '没有这个画布：cv_never',
    String(g.json?.error))

  const p = await call('PUT', '/api/ecom-workbench/canvases/cv_never', { title: 'x' })
  check('★★ PUT 不存在的 → 404（不顺手建出来）', p.code === 404 && p.json?.ok === false,
    String(p.json?.error))

  const d = await call('DELETE', '/api/ecom-workbench/canvases/cv_never')
  check('★★ DELETE 不存在的 → 404', d.code === 404 && d.json?.ok === false, String(d.json?.error))

  const evil = await call('GET', '/api/ecom-workbench/canvases/..%2F..%2Fbrowser-prefs')
  check('★★ 非法 id（路径穿越）→ 404 而不是读到目录外的文件',
    evil.code === 404, String(evil.code))
}

/* ── ④ 删 → 再取 404 ─────────────────────────────────────────────── */
console.log('')
console.log('④ 删除')
{
  const del = await call('DELETE', '/api/ecom-workbench/canvases/' + canvasId)
  check('★★ 删除成功', del.code === 200 && del.json?.ok === true, String(del.code))
  const again = await call('GET', '/api/ecom-workbench/canvases/' + canvasId)
  check('★★ 删完再取 → 404', again.code === 404, String(again.code))
  const list = await call('GET', '/api/ecom-workbench/canvases')
  check('★★ 列表里也没了', !(list.json?.canvases ?? []).some(c => c.id === canvasId),
    (list.json?.canvases ?? []).map(c => c.id).join(','))
}

/* ── ⑤ 不传 title 给默认名；坏文件跳过不拖垮列表 ─────────────────── */
console.log('')
console.log('⑤ 默认名与坏文件')
{
  const made = await call('POST', '/api/ecom-workbench/canvases', {})
  check('★ 不带 title → 「未命名画布」', made.json?.canvas?.title === '未命名画布',
    String(made.json?.canvas?.title))
  check('★ 不带 nodes → 空数组（不是 undefined）',
    Array.isArray(made.json?.canvas?.nodes) && made.json.canvas.nodes.length === 0,
    JSON.stringify(made.json?.canvas?.nodes))
  check('★ 不带 viewport → 给一份原点视口',
    JSON.stringify(made.json?.canvas?.viewport) === JSON.stringify({ x: 0, y: 0, zoom: 1 }),
    JSON.stringify(made.json?.canvas?.viewport))

  /* 手工塞一个坏 JSON 进目录：列表不该整份失败（那会让画布库打不开）。 */
  const { writeFile, mkdir } = await import('node:fs/promises')
  await mkdir(canvasesDir(), { recursive: true })
  await writeFile(join(canvasesDir(), 'cv_broken.json'), '{ 这不是 JSON', 'utf8')
  const list = await call('GET', '/api/ecom-workbench/canvases')
  check('★★ 目录里有一个坏文件时列表照样能用（坏的那条跳过）',
    list.code === 200 && list.json?.ok === true
    && (list.json?.canvases ?? []).some(c => c.id === made.json?.canvas?.id),
    (list.json?.canvases ?? []).map(c => c.id).join(','))
  check('★★ 坏文件不在列表里', !(list.json?.canvases ?? []).some(c => c.id === 'cv_broken'),
    '')
}

console.log('')
console.log(bad === 0 ? '结论：画布 CRUD 全部通过 ✓' : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
