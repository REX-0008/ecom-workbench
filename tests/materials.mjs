/** 素材库（契约 BA，2026-10-25）。
 *
 * ## 这一段守的是什么
 *
 * 计划 §三 4.2 的「读目录，不建索引」：放进目录就算有、删掉就消失、
 * 只认图片与视频、其余类型忽略。
 *
 * ## 判据为什么带「目录不存在」那一条
 *
 * 新装的工作台里 `materials/` 是不存在的。回 500 或者抛错就等于
 * 「素材库打不开」—— 而它本来就该是空的。这条最容易漏。
 *
 * 跑法：node --import <tsx> tests/materials.mjs
 */
import { mkdtemp, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-mat-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const { apply } = await import('../src/index.ts')
const {
  listMaterials, saveMaterial, loadMaterial, deleteMaterial, isMaterialSafe, isMaterialName,
} = await import('../src/schedule/materials.ts')
const { materialsDir } = await import('../src/schedule/artifacts.ts')

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
 * 模拟一次 HTTP 调用（保留原始响应 —— 二进制路由回的是 Buffer）。
 * @param {string} method - 方法。
 * @param {string} url - 路径。
 * @param {object} [body] - 请求体。
 * @returns {Promise<{code:number, headers:object, raw:any, json:any}>} 响应。
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
  let json = null
  try { json = JSON.parse(String(raw ?? '')) } catch { json = null }
  return { code, headers, raw, json }
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

/** 1×1 PNG（真图片，能验 content-type 与字节）。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/* ── ① 目录不存在 → 空数组不报错 ─────────────────────────────────── */
console.log('① materials/ 不存在时回空数组（新装状态）')
{
  const s = await stat(materialsDir()).catch(() => null)
  check('★ 沙箱里现在还没有 materials/ 目录', s === null, String(s))
  const r = await call('GET', '/api/ecom-workbench/materials')
  check('★★ 目录不存在 → 200 且空数组（不是 500、不是抛错）',
    r.code === 200 && r.json?.ok === true && Array.isArray(r.json?.materials) && r.json.materials.length === 0,
    JSON.stringify({ code: r.code, n: r.json?.materials?.length }))
}

/* ── ② 上传（base64）→ 列出来 → 取字节 ───────────────────────────── */
console.log('')
console.log('② 上传走 base64 + JSON')
{
  const up = await call('POST', '/api/ecom-workbench/materials', { name: 'cat.png', base64: PNG_B64 })
  check('★★ 上传成功', up.code === 200 && up.json?.ok === true, String(up.json?.ok))
  check('★★ 落盘的字节是真 PNG',
    (await readFileOrNull(join(materialsDir(), 'cat.png')))?.subarray(0, 8).equals(PNG_MAGIC),
    '')

  const list = await call('GET', '/api/ecom-workbench/materials')
  const items = list.json?.materials ?? []
  const cat = items.find(m => m.name === 'cat.png')
  check('★★ 列表里出现了（带 name / bytes / mtime / url）',
    cat !== undefined && cat.bytes > 0 && typeof cat.mtime === 'number'
    && cat.url === '/api/ecom-workbench/material/cat.png',
    JSON.stringify(cat))
  /* 契约 BC 的约定：具名键与 `items` 同时给、内容一致。 */
  check('★★ 具名键与 items 两个键内容一致（列表类接口的约定）',
    JSON.stringify(list.json?.materials) === JSON.stringify(list.json?.items)
    && Array.isArray(list.json?.items),
    JSON.stringify({ named: (list.json?.materials ?? []).length, items: (list.json?.items ?? []).length }))
  check('★★ 没有索引文件（读目录就有，目录里只有素材本身）',
    (await readdir(materialsDir())).every(n => !n.endsWith('.json')),
    (await readdir(materialsDir())).join(','))

  const got = await call('GET', '/api/ecom-workbench/material/cat.png')
  const buf = Buffer.isBuffer(got.raw) ? got.raw : Buffer.from(String(got.raw ?? ''))
  check('★★ GET /material/<name> 吐出正确 content-type 的字节',
    got.code === 200 && String(got.headers['content-type']) === 'image/png'
    && buf.subarray(0, 8).equals(PNG_MAGIC),
    String(got.headers['content-type']))
}

/**
 * 读文件，不存在给 null（避免 `readFile` 抛错让测试崩掉而不是变红）。
 * @param {string} p - 路径。
 * @returns {Promise<Buffer|null>} 内容。
 */
async function readFileOrNull(p) {
  try { return await (await import('node:fs/promises')).readFile(p) } catch { return null }
}

/* ── ③ 只认图片与视频，其余忽略 ───────────────────────────────────── */
console.log('')
console.log('③ 只列图片与视频')
{
  await mkdir(materialsDir(), { recursive: true })
  await writeFile(join(materialsDir(), 'note.txt'), '不是素材', 'utf8')
  await writeFile(join(materialsDir(), 'data.json'), '{}', 'utf8')
  await writeFile(join(materialsDir(), 'clip.mp4'), Buffer.from([0, 0, 0, 1]), 'utf8')
  await writeFile(join(materialsDir(), 'sound.mp3'), Buffer.from([0x49, 0x44, 0x33]), 'utf8')
  const names = (await listMaterials()).map(m => m.name)
  check('★★ 图片与视频列出来了', names.includes('cat.png') && names.includes('clip.mp4'), names.join(','))
  check('★★ .txt 与 .json 被忽略', !names.includes('note.txt') && !names.includes('data.json'), names.join(','))
  check('★★ 音频也被忽略（第一版只认图片与视频，计划 §6.2 第一条）',
    !names.includes('sound.mp3'), names.join(','))

  check('★ isMaterialName 判定对',
    isMaterialName('a.png') && isMaterialName('b.MP4') && !isMaterialName('c.txt'),
    '')
}

/* ── ④ 名字校验：挡目录穿越 ───────────────────────────────────────── */
console.log('')
console.log('④ 名字校验')
{
  check('★★ 含 .. 的名字非法', !isMaterialSafe('../escape.png'), '')
  check('★★ 带路径分隔符的非法', !isMaterialSafe('a/b.png') && !isMaterialSafe('a\\b.png'), '')
  check('★ 以点开头（隐藏文件）非法', !isMaterialSafe('.hidden.png'), '')
  check('★ 正常名字合法', isMaterialSafe('cat_01.png') && isMaterialSafe('my-photo.v2.jpg'), '')

  const evil = await call('POST', '/api/ecom-workbench/materials', { name: '../escape.png', base64: PNG_B64 })
  check('★★ 带 .. 的上传 → 400', evil.code === 400, String(evil.code))
  check('★ 错误话说清了规则', String(evil.json?.error).includes('不合法'), String(evil.json?.error))

  const badType = await call('POST', '/api/ecom-workbench/materials', { name: 'x.txt', base64: PNG_B64 })
  check('★★ 非图片/视频类型 → 400', badType.code === 400, String(badType.json?.error))

  const noBase64 = await call('POST', '/api/ecom-workbench/materials', { name: 'y.png' })
  check('★ 没给内容 → 400', noBase64.code === 400, String(noBase64.json?.error))

  const junk = await call('POST', '/api/ecom-workbench/materials', { name: 'z.png', base64: '!!!' })
  check('★★ 坏 base64 → 400（不写一个 0 字节文件）',
    junk.code === 400 && String(junk.json?.error).includes('base64'), String(junk.json?.error))
  check('★★ 而且真没留下 0 字节文件',
    (await stat(join(materialsDir(), 'z.png')).catch(() => null)) === null, '')
}

/* ── ⑤ 删除 ───────────────────────────────────────────────────────── */
console.log('')
console.log('⑤ 删除')
{
  const s = await stat(join(materialsDir(), 'clip.mp4')).catch(() => null)
  check('★ 删之前文件在', s !== null, '')
  const del = await call('DELETE', '/api/ecom-workbench/materials/clip.mp4')
  check('★★ 删除成功', del.code === 200 && del.json?.ok === true, String(del.code))
  check('★★ 文件真没了', (await stat(join(materialsDir(), 'clip.mp4')).catch(() => null)) === null, '')
  check('★★ 列表里也没了', !(await listMaterials()).some(m => m.name === 'clip.mp4'), '')

  const again = await call('DELETE', '/api/ecom-workbench/materials/clip.mp4')
  check('★★ 删不存在的 → 404 + 说明',
    again.code === 404 && String(again.json?.error).includes('没有这个素材'),
    String(again.json?.error))

  check('★ 直接调 deleteMaterial 删不存在的 → false', (await deleteMaterial('nope.png')) === false, '')
  check('★★ 非法名字直接调也是 false（不删目录外的东西）',
    (await deleteMaterial('../x.png')) === false, '')
}

/* ── ⑥ 取不存在的素材 / 非法名字 ──────────────────────────────────── */
console.log('')
console.log('⑥ 取不存在的素材')
{
  const miss = await call('GET', '/api/ecom-workbench/material/nope.png')
  check('★★ 404 且给 JSON 说明', miss.code === 404, String(miss.code))
  const evil = await call('GET', '/api/ecom-workbench/material/..%2F..%2Fbrowser-prefs.json')
  check('★★ 非法名字 → 404（不读目录外的文件）',
    evil.code === 404 && (await loadMaterial('../../browser-prefs.json')) === null, String(evil.code))
}

/* ── ⑦ 产物与素材是两个池子 ───────────────────────────────────────── */
console.log('')
console.log('⑦ 素材不混进产物目录')
{
  const { artifactsDir } = await import('../src/schedule/artifacts.ts')
  check('★★ 素材存在 materials/ 下，不是 artifacts/',
    (await readdir(materialsDir())).includes('cat.png')
    && !(await readdir(artifactsDir()).catch(() => [])).includes('cat.png'),
    '')
}

console.log('')
console.log(bad === 0 ? '结论：素材库（读目录 / 上传 / 删除 / 取字节）全部通过 ✓' : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
