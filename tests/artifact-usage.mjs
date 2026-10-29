/** 产物引用计数 + 产物删除（契约 BA，2026-10-25）。
 *
 * ## 这一段守的是什么
 *
 * 计划 §三 4.1 的两件：**删产物前要知道它被谁引用**、**删就是真删文件**。
 * 两者合在一条断言链上验：被两处引用 → 计数回两处 → 删掉 → 计数里不再有它。
 *
 * ## 判据为什么是「再调一次计数接口」
 *
 * 只验「删完 GET /artifact 回 404」不够 —— 那只证明读不到。计数接口里还留着
 * 一条幽灵引用（`{ id: [两处] }`）才是最难查的那种：界面会提示「被 2 个画布引用，
 * 删了会显示图已删除」，而那个图已经不存在了。
 *
 * 跑法：node --import <tsx> tests/artifact-usage.mjs
 */
import { mkdtemp, writeFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-au-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const { apply } = await import('../src/index.ts')
const { storeArtifact, artifactsDir, canvasesDir, deleteArtifact } = await import('../src/schedule/artifacts.ts')
const { artifactUsage, usageOf } = await import('../src/schedule/artifact-usage.ts')

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
 * @returns {Promise<{code:number, json:any}>} 响应。
 */
async function call(method, url) {
  const req = Readable.from([])
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
  return { code, json }
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

/** 1×1 PNG，当产物的样本。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/* 造两份画布，都引用同一个产物 id（形状照 `content-canvas-store.ts:30-55`：
 * 图片节点的产物 id 存在 `data.artifact`；另造一个节点用网址形式，验两种都认）。 */
const ART_ID = 'art-shared'

/* ── ① 两份画布引用同一产物 → 计数回两处 ──────────────────────────── */
console.log('① 两份画布引用同一产物 → 计数回两处')
{
  /* ⚠️ 先把产物**真存下来**（计数只列还存在的产物 —— 见实现里那段说明）。 */
  await storeArtifact({ id: ART_ID, base64: PNG_B64, mime: 'image/png' })
  await mkdir(canvasesDir(), { recursive: true })
  await writeFile(join(canvasesDir(), 'cv_one.json'), JSON.stringify({
    id: 'cv_one', title: '第一张画布', createdAt: 1, updatedAt: 2,
    nodes: [
      { id: 'n1', type: 'text', position: { x: 0, y: 0 }, data: { text: '写点什么' } },
      { id: 'n2', type: 'image', position: { x: 100, y: 0 }, data: { artifact: ART_ID } },
    ],
    edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  }, null, 2), 'utf8')
  await writeFile(join(canvasesDir(), 'cv_two.json'), JSON.stringify({
    id: 'cv_two', title: '第二张画布', createdAt: 1, updatedAt: 2,
    nodes: [
      /* 这里用网址形式（有人直接把 `/api/.../artifact/<id>` 存进 src）。 */
      { id: 'm9', type: 'image', position: { x: 0, y: 0 },
        data: { src: '/api/ecom-workbench/artifact/' + ART_ID } },
    ],
    edges: [], viewport: { x: 0, y: 0, zoom: 1 },
  }, null, 2), 'utf8')

  const usage = await artifactUsage()
  const refs = usage[ART_ID] ?? []
  check('★★ 那个产物被数到 2 处引用', refs.length === 2, JSON.stringify(refs))
  check('★★ 两处来自两个不同画布',
    new Set(refs.map(r => r.canvasId)).size === 2, refs.map(r => r.canvasId).join(','))
  check('★★ 每处都带了画布名与节点 id（悬浮时要显示）',
    refs.every(r => typeof r.canvasTitle === 'string' && r.canvasTitle !== '' && r.nodeId !== ''),
    JSON.stringify(refs.map(r => ({ t: r.canvasTitle, n: r.nodeId }))))
  check('★ 画布名取的是存档里的 title（不是文件名）',
    refs.some(r => r.canvasTitle === '第一张画布') && refs.some(r => r.canvasTitle === '第二张画布'),
    refs.map(r => r.canvasTitle).join(','))

  /* 路由那条也要回同一份。 */
  const route = await call('GET', '/api/ecom-workbench/artifacts/usage')
  check('★★ 计数路由回的是同一份',
    route.code === 200 && (route.json?.usage?.[ART_ID] ?? []).length === 2,
    JSON.stringify(Object.keys(route.json?.usage ?? {})))

  check('★ usageOf 单独查也是 2 处', (await usageOf(ART_ID)).length === 2, '')
  check('★ 没被引用的产物查出来是空数组', (await usageOf('art-nobody')).length === 0, '')

  /* 契约 BC 的约定：产物列表那条也同时给具名键与 `items`。
   * 这条测试原本不碰 `/artifacts`，为了验约定加一段（产物是真的，上面存过）。 */
  const arts = await call('GET', '/api/ecom-workbench/artifacts')
  check('★★ 产物列表的具名键与 items 两个键内容一致',
    JSON.stringify(arts.json?.artifacts) === JSON.stringify(arts.json?.items)
    && Array.isArray(arts.json?.items) && arts.json.items.length > 0,
    JSON.stringify({ named: (arts.json?.artifacts ?? []).length, items: (arts.json?.items ?? []).length }))
  check('★ 既有键没少（dir / total 还在）',
    typeof arts.json?.dir === 'string' && typeof arts.json?.total === 'number',
    JSON.stringify({ dir: typeof arts.json?.dir, total: arts.json?.total }))
}

/* ── ② 同一节点既存 id 又存网址 → 只算一处 ───────────────────────── */
console.log('')
console.log('② 一个节点里重复出现只算一处')
{
  await mkdir(canvasesDir(), { recursive: true })
  await writeFile(join(canvasesDir(), 'cv_dup.json'), JSON.stringify({
    id: 'cv_dup', title: '重复引用画布',
    nodes: [{
      id: 'd1', type: 'image', position: { x: 0, y: 0 },
      data: { artifact: ART_ID, src: '/api/ecom-workbench/artifact/' + ART_ID },
    }],
  }, null, 2), 'utf8')
  const refs = (await artifactUsage())[ART_ID] ?? []
  const fromDup = refs.filter(r => r.canvasId === 'cv_dup')
  check('★★ 同一节点里既存 id 又存网址 → 只算 1 处', fromDup.length === 1,
    String(fromDup.length))
}

/* ── ③ 删产物：本体 + 元数据都删 ──────────────────────────────────── */
console.log('')
console.log('③ 删产物要真删两个文件')
{
  const meta = await storeArtifact({ id: ART_ID, base64: PNG_B64, mime: 'image/png' })
  const bodyFile = join(artifactsDir(), ART_ID + '.' + meta.ext)
  const metaFile = join(artifactsDir(), ART_ID + '.json')
  check('★ 删之前本体在', (await stat(bodyFile).catch(() => null)) !== null, bodyFile)
  check('★ 删之前元数据在', (await stat(metaFile).catch(() => null)) !== null, metaFile)
  check('★ 删之前计数里列着它', ((await artifactUsage())[ART_ID] ?? []).length > 0, '')

  const del = await call('DELETE', '/api/ecom-workbench/artifact/' + ART_ID)
  check('★★ 删除成功（200）', del.code === 200 && del.json?.ok === true, String(del.code))
  check('★★ **本体文件没了**', (await stat(bodyFile).catch(() => null)) === null, bodyFile)
  check('★★ **元数据文件也没了**', (await stat(metaFile).catch(() => null)) === null, metaFile)

  /* 删了之后：读不到，且计数里不再列它。 */
  const got = await call('GET', '/api/ecom-workbench/artifact/' + ART_ID)
  check('★★ 删完之后 GET /artifact 回 404', got.code === 404, String(got.code))

  /* ⚠️ 这一条是计划 §五 的替代判据：「删完后两个画布上那个节点都显示图已删除」
   * 属界面那侧；宿主侧能验的是「计数接口不再列它」。 */
  const usageAfter = (await artifactUsage())[ART_ID] ?? []
  check('★★ 删掉之后计数接口**不再列它**（不留在表里）', usageAfter.length === 0,
    JSON.stringify(usageAfter))

  /* 删不存在的 → 404。 */
  const again = await call('DELETE', '/api/ecom-workbench/artifact/art-never')
  check('★★ 删不存在的 → 404 + 说明',
    again.code === 404 && String(again.json?.error).includes('没有这个产物'),
    String(again.json?.error))

  /* `deleteArtifact` 直接调也返回布尔。 */
  check('★ 直接调 deleteArtifact 删不存在的 → false', (await deleteArtifact('art-never')) === false, '')
  check('★ 非法 id → false（不删目录外的东西）', (await deleteArtifact('../../x')) === false, '')
}

/* ── ④ 目录不存在时给空表，不报错 ─────────────────────────────────── */
console.log('')
console.log('④ 新装状态（目录不存在）不报错')
{
  /* 用一个新的沙箱：`canvases/` 还没建。 */
  const fresh = await mkdtemp(join(tmpdir(), 'ewb-au-fresh-'))
  const old = process.env.EWB_TEST_HOME
  process.env.EWB_TEST_HOME = fresh
  try {
    /* ⚠️ `canvasesDir()` 每次现算（不缓存路径），所以改环境变量立刻生效。
     * 这条本身也值得一验：缓存了路径的话，沙箱切换会失效。 */
    const usage = await artifactUsage()
    check('★★ 没有画布目录 → 空对象（不是抛错）',
      usage !== null && typeof usage === 'object' && Object.keys(usage).length === 0,
      JSON.stringify(usage))
  } finally {
    process.env.EWB_TEST_HOME = old
  }
}

console.log('')
console.log(bad === 0 ? '结论：引用计数与产物删除全部通过 ✓' : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
