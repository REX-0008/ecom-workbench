/** 文本素材（票 34，2026-10-28）。
 *
 * ## 这一段守的是什么
 *
 * 素材库原来只收图片与视频（`materials.mjs` 那条断言钉着 `isMaterialName('c.txt') === false`）。
 * 票 34 要收「文本」：标题 + 正文两段，**和图片视频一起从 `/materials` 读出来**，
 * 且能分清类型。
 *
 * ## 为什么另起一个文件，而不是往 `materials.mjs` 里加
 *
 * `materials.mjs` 守的是「读目录、不建索引」那套老判据，里面有一条
 * 「目录里只有素材本身，没有一个 `.json`」—— 那句话**现在的前提变了**：
 * 文本素材本来就是 `.text.json`。两条判据放在一个文件里会互相打架，
 * 改哪条都会让人以为是在迁就另一条。分开之后各自的前提都写在自己文件头。
 *
 * ⚠️ 但那条老断言**没有被我改掉**：它现在守的是「`.text.json` 之外不许有索引文件」，
 * 仍然为真（见 `materials.mjs:114`）。真正要防的是「一份装着所有条目的清单」。
 *
 * 跑法：node --import <tsx> tests/materials-text.mjs
 */
import { mkdtemp, mkdir, writeFile, readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-mat-text-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const { apply } = await import('../src/index.ts')
const {
  listMaterials, saveMaterial, saveTextMaterial, loadMaterial, deleteMaterial,
  isMaterialName, isTextMaterialName, kindOfName,
  TEXT_MATERIAL_SUFFIX, TEXT_MATERIAL_MAX_CHARS, TEXT_MATERIAL_MAX_TITLE,
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
 * 模拟一次 HTTP 调用。
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

/** 1×1 PNG（用来验「老的存法一个字节没变」）。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/* ── ① 存一条文本素材 → 列表里读回来 ─────────────────────────────── */
console.log('① 存一条文本素材，从 /materials 读回来')
{
  const r = await call('POST', '/api/ecom-workbench/materials/text', {
    title: '一段开场白', content: '第一句。\n第二句。',
  })
  check('★★ 存文本素材成功', r.code === 200 && r.json?.ok === true, JSON.stringify(r.json?.error))
  const m = r.json?.material
  check('★★ 回包带 kind=text', m?.kind === 'text', String(m?.kind))
  check('★★ 回包带标题与正文', m?.title === '一段开场白' && m?.content === '第一句。\n第二句。',
    JSON.stringify({ title: m?.title, content: m?.content }))
  /* '第一句。\n第二句。' = 第 一 句 。 \n 第 二 句 。 → 9 个字符（换行也算一个）。 */
  check('★★ 回包带字符数（界面显示摘要要用）', m?.chars === 9, String(m?.chars))
  check('★★ 文件名以 ' + TEXT_MATERIAL_SUFFIX + ' 结尾', String(m?.name).endsWith(TEXT_MATERIAL_SUFFIX), String(m?.name))

  const list = await call('GET', '/api/ecom-workbench/materials')
  const items = list.json?.materials ?? []
  const got = items.find(x => x.name === m?.name)
  check('★★ 列表里出现了这条文本素材', got !== undefined, JSON.stringify(items.map(x => x.name)))
  check('★★ 列表里类型是 text、标题正文都对',
    got?.kind === 'text' && got?.title === '一段开场白' && got?.content === '第一句。\n第二句。',
    JSON.stringify({ kind: got?.kind, title: got?.title }))
  check('★★ 列表里也有 name / bytes / mtime / url（老字段一个没少）',
    typeof got?.bytes === 'number' && got.bytes > 0
    && typeof got?.mtime === 'number'
    && got?.url === '/api/ecom-workbench/material/' + encodeURIComponent(String(m?.name)),
    JSON.stringify({ bytes: got?.bytes, url: got?.url }))
  check('★★ 具名键与 items 两个键内容一致（列表类接口的约定没被破坏）',
    JSON.stringify(list.json?.materials) === JSON.stringify(list.json?.items),
    JSON.stringify({ named: (list.json?.materials ?? []).length }))
}

/* ── ② 三类一起列，能分清 ─────────────────────────────────────────── */
console.log('')
console.log('② 图片、视频、文本三类一起列，类型分得清')
{
  await call('POST', '/api/ecom-workbench/materials', { name: 'cat.png', base64: PNG_B64 })
  await mkdir(materialsDir(), { recursive: true })
  await writeFile(join(materialsDir(), 'clip.mp4'), Buffer.from([0, 0, 0, 1]))
  /* 目录里不是素材的东西也该被忽略（老判据继续有效）。 */
  await writeFile(join(materialsDir(), 'note.txt'), '不是素材', 'utf8')
  await writeFile(join(materialsDir(), 'data.json'), '{}', 'utf8')

  const items = (await call('GET', '/api/ecom-workbench/materials')).json?.materials ?? []
  const k = (n) => items.find(x => x.name === n)?.kind
  check('★★ 图片的 kind 是 image', k('cat.png') === 'image', String(k('cat.png')))
  check('★★ 视频的 kind 是 video', k('clip.mp4') === 'video', String(k('clip.mp4')))
  check('★★ 有一条文本的 kind 是 text', items.some(x => x.kind === 'text'),
    JSON.stringify(items.filter(x => x.kind === 'text').map(x => x.name)))
  check('★★ note.txt 被忽略（老判据仍有效）', k('note.txt') === undefined, String(k('note.txt')))
  check('★★ 普通 data.json 被忽略（只有 .text.json 才算文本素材）',
    k('data.json') === undefined, String(k('data.json')))
  check('★★ 每一项都有 kind（没有漏掉的）', items.every(x => x.kind === 'image' || x.kind === 'video' || x.kind === 'text'),
    JSON.stringify(items.map(x => [x.name, x.kind])))
}

/* ── ③ 判定函数各管一类 ───────────────────────────────────────────── */
console.log('')
console.log('③ 判定函数')
{
  check('★★ 老的 isMaterialName 仍只认图片视频（没被文本污染）',
    isMaterialName('a.png') && isMaterialName('b.MP4') && !isMaterialName('c.txt')
    && !isMaterialName('x.text.json'),
    JSON.stringify({ png: isMaterialName('a.png'), txt: isMaterialName('c.txt'), textJson: isMaterialName('x.text.json') }))
  check('★★ isTextMaterialName 认 .text.json', isTextMaterialName('x.text.json') && !isTextMaterialName('data.json'), '')
  check('★★ kindOfName 三分都对',
    kindOfName('a.png') === 'image' && kindOfName('b.mp4') === 'video'
    && kindOfName('c.text.json') === 'text' && kindOfName('note.txt') === null,
    JSON.stringify([kindOfName('a.png'), kindOfName('b.mp4'), kindOfName('c.text.json'), kindOfName('note.txt')]))
}

/* ── ④ 不建索引：一条文本素材就是一个文件 ─────────────────────────── */
console.log('')
console.log('④ 不建索引（「放进去就算有」这条原则没被破坏）')
{
  const names = await readdir(materialsDir())
  const texts = names.filter(n => n.endsWith(TEXT_MATERIAL_SUFFIX))
  check('★★ 文本素材一条一个文件', texts.length === 1, texts.join(','))
  /* 关键判据：目录里除了 `.text.json`，没有别的 `.json`。
   * 有的话那才是索引文件（一份装着所有条目的清单）。
   *
   * ⚠️ `data.json` 是 ② 段**故意**丢进去的干扰项（证明普通 json 不是素材）。
   * 它在那儿不影响这条判据的意思 —— 要防的是「一份清单能改写列表」，
   * 而不是「目录里不许有 json 文件」。所以这里单独把它排除掉，
   * 并另加一条断言：无论有没有它，列表内容都由目录里真有的文件决定。 */
  check('★★ 除了 .text.json 之外没有别的 .json（没有索引文件）',
    names.filter(n => n.endsWith('.json') && !n.endsWith(TEXT_MATERIAL_SUFFIX) && n !== 'data.json').length === 0,
    names.join(','))

  /* 更强的一条：存一条文本素材，目录里**只多一个文件**。
   * 有索引文件的话这会多两个（素材本体 + 清单）。这条不依赖上面那种「排除法」。 */
  {
    const before = new Set(await readdir(materialsDir()))
    const one = await saveTextMaterial({ title: '只多一个文件', content: '存它就只该多一个文件' })
    const after = await readdir(materialsDir())
    const added = after.filter(n => !before.has(n))
    check('★★ 存一条文本素材，目录里只多一个文件（不另写清单）',
      added.length === 1 && added[0] === one.name, JSON.stringify(added))
    await deleteMaterial(one.name)
    const back = await readdir(materialsDir())
    check('★★ 删掉它，目录回到原样（没有残留的条目）',
      JSON.stringify([...back].sort()) === JSON.stringify([...before].sort()), JSON.stringify(back))
  }

  /* 手工往目录里丢一个 `.text.json` → 列表里立刻能看到（这就是「放进去就算有」）。 */
  await writeFile(join(materialsDir(), 'hand-made.text.json'),
    JSON.stringify({ title: '手放的', content: '直接丢进目录也能看到' }), 'utf8')
  const items = (await call('GET', '/api/ecom-workbench/materials')).json?.materials ?? []
  const hand = items.find(x => x.name === 'hand-made.text.json')
  check('★★ 手工丢进目录的文本素材立刻能看到（不需要登记）',
    hand !== undefined && hand.title === '手放的' && hand.kind === 'text',
    JSON.stringify({ title: hand?.title, kind: hand?.kind }))

  /* 删掉文件 → 列表里消失（同一件事的另一面）。 */
  await deleteMaterial('hand-made.text.json')
  const after = (await call('GET', '/api/ecom-workbench/materials')).json?.materials ?? []
  check('★★ 删掉文件就从列表消失', !after.some(x => x.name === 'hand-made.text.json'), '')
}

/* ── ⑤ 正文坏了要说出来，不许静默跳过 ─────────────────────────────── */
console.log('')
console.log('⑤ 文件坏了要显式说，不许凭空消失')
{
  await writeFile(join(materialsDir(), 'broken.text.json'), '这不是 JSON', 'utf8')
  const items = (await call('GET', '/api/ecom-workbench/materials')).json?.materials ?? []
  const b = items.find(x => x.name === 'broken.text.json')
  check('★★ 坏文件仍然列出来（不静默跳过）', b !== undefined, JSON.stringify(items.map(x => x.name)))
  check('★★ 而且带一句 problem 说清坏了',
    typeof b?.problem === 'string' && b.problem.includes('读不出来'), JSON.stringify(b?.problem))
  check('★★ 坏的那条 kind 仍是 text（类型由文件名定，不靠内容）', b?.kind === 'text', String(b?.kind))
  await deleteMaterial('broken.text.json')
}

/* ── ⑥ 校验：空正文、超长、名字、类型 ─────────────────────────────── */
console.log('')
console.log('⑥ 校验')
{
  const empty = await call('POST', '/api/ecom-workbench/materials/text', { title: '有标题', content: '   ' })
  check('★★ 正文是空白 → 400', empty.code === 400, String(empty.json?.error))
  check('★ 错误话说清了缺什么', String(empty.json?.error).includes('正文'), String(empty.json?.error))

  const noBody = await call('POST', '/api/ecom-workbench/materials/text', { title: '只有标题' })
  check('★★ 没给正文 → 400', noBody.code === 400, String(noBody.json?.error))

  const tooLong = await call('POST', '/api/ecom-workbench/materials/text', {
    title: '长', content: 'x'.repeat(TEXT_MATERIAL_MAX_CHARS + 1),
  })
  check('★★ 正文超长 → 400', tooLong.code === 400, String(tooLong.json?.error))
  check('★ 错误话里给了上限', String(tooLong.json?.error).includes(String(TEXT_MATERIAL_MAX_CHARS)), String(tooLong.json?.error))

  const titleLong = await call('POST', '/api/ecom-workbench/materials/text', {
    title: 'y'.repeat(TEXT_MATERIAL_MAX_TITLE + 1), content: '正文',
  })
  check('★★ 标题超长 → 400', titleLong.code === 400, String(titleLong.json?.error))

  /* 标题可以空，落盘时报「未命名文本」（不写一个没有标题的素材）。 */
  const noTitle = await call('POST', '/api/ecom-workbench/materials/text', { content: '只有正文' })
  check('★★ 标题空 → 存进去，标题回落成「未命名文本」',
    noTitle.code === 200 && noTitle.json?.material?.title === '未命名文本',
    JSON.stringify(noTitle.json?.material?.title))
  await deleteMaterial(String(noTitle.json?.material?.name))

  /* ⚠️ 老那条 POST 不许被文本素材蹭进去。 */
  const sneaky = await call('POST', '/api/ecom-workbench/materials', {
    name: 'x.text.json', base64: PNG_B64,
  })
  check('★★ 拿 base64 往 .text.json 存 → 400（两条路不许混）',
    sneaky.code === 400 && String(sneaky.json?.error).includes('文本素材请走'), String(sneaky.json?.error))
  check('★★ 而且真没留下那个文件（不是写了再报错）',
    (await stat(join(materialsDir(), 'x.text.json')).catch(() => null)) === null, '')

  const evil = await call('POST', '/api/ecom-workbench/materials/text', {
    content: '正文', name: '../逃出去.text.json',
  })
  check('★★ 名字带 .. → 400（安全边界照旧）', evil.code === 400, String(evil.json?.error))

  const wrongSuffix = await call('POST', '/api/ecom-workbench/materials/text', {
    content: '正文', name: 'x.json',
  })
  check('★★ 名字不以 .text.json 结尾 → 400', wrongSuffix.code === 400, String(wrongSuffix.json?.error))
}

/* ── ⑦ 取字节：文本素材也能按地址读回来 ───────────────────────────── */
console.log('')
console.log('⑦ 文本素材的 url 读得出内容')
{
  const saved = await saveTextMaterial({ title: '取回来', content: '这段话要读得出来' })
  const got = await call('GET', saved.url)
  const buf = Buffer.isBuffer(got.raw) ? got.raw : Buffer.from(String(got.raw ?? ''))
  const parsed = JSON.parse(buf.toString('utf8'))
  check('★★ GET /material/<name> 取文本素材，content-type 是 JSON',
    got.code === 200 && String(got.headers['content-type']).includes('json'),
    String(got.headers['content-type']))
  check('★★ 内容就是标题 + 正文', parsed.title === '取回来' && parsed.content === '这段话要读得出来',
    JSON.stringify({ title: parsed.title }))
  await deleteMaterial(saved.name)

  /* 老的二进制那条路没被碰到。 */
  const bin = await call('GET', '/api/ecom-workbench/material/cat.png')
  const binBuf = Buffer.isBuffer(bin.raw) ? bin.raw : Buffer.from(String(bin.raw ?? ''))
  check('★★ 图片仍然按 image/png 吐字节（老路一个字节没变）',
    bin.code === 200 && String(bin.headers['content-type']) === 'image/png'
    && binBuf.subarray(0, 8).equals(PNG_MAGIC),
    String(bin.headers['content-type']))
}

/* ── ⑧ 直接调函数也守规矩 ─────────────────────────────────────────── */
console.log('')
console.log('⑧ 直接调函数')
{
  const r = await saveTextMaterial({ title: '直调', content: '直调也能存', name: 'direct.text.json' })
  check('★★ 指定名字能存进去', r.name === 'direct.text.json' && r.kind === 'text', r.name)
  const list = await listMaterials()
  check('★★ 列表里读得到它', list.some(m => m.name === 'direct.text.json' && m.title === '直调'), '')
  check('★★ 直接删也删得掉', (await deleteMaterial('direct.text.json')) === true, '')
  check('★ 删第二次是 false', (await deleteMaterial('direct.text.json')) === false, '')

  /* 老的 saveMaterial 不许收文本素材。 */
  let threw = ''
  try { await saveMaterial('via-old.text.json', PNG_B64) } catch (e) { threw = String(e?.message ?? e) }
  check('★★ 老的 saveMaterial 拒绝文本素材', threw.includes('文本素材请走'), threw)
  check('★★ 也没留下文件', (await stat(join(materialsDir(), 'via-old.text.json')).catch(() => null)) === null, '')
}

console.log('')
console.log(bad === 0
  ? '结论：文本素材（存 / 列 / 分型 / 不建索引 / 坏文件说出来）全部通过 ✓'
  : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
