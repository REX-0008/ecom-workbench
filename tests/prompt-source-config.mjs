/** 提示词源可配（2026-10-26，T-B-后端）。
 *
 * # 三条规矩各验一遍
 *
 * 1. 内置五个**删不掉，只能停用**；
 * 2. 用户能加 / 改 / 停用自己的源；
 * 3. 每个源能测连通（三种失败分开说）。
 *
 * 跑法：node scripts/run-tests.mjs prompt-source-config
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-pscfg-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const {
  listConfiguredSources, addSource, updateSource, deleteSource, probeSource,
  readSourcesFile, saveSourcesFile, isPromptSourceId, PROMPT_SOURCES_FILE,
} = await import('../src/schedule/prompt-source-config.ts')
const { BUILTIN_PROMPT_SOURCES } = await import('../src/client/workbench/prompt-sources/index.ts')

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

/** 假 fetch。 */
function fakeFetch(make) {
  const calls = []
  const impl = async (url) => {
    calls.push(String(url))
    const one = make(String(url)) ?? {}
    if (one.throw !== undefined) throw new Error(one.throw)
    return new Response(one.raw !== undefined ? one.raw : JSON.stringify(one.body ?? []), {
      status: one.status ?? 200, headers: { 'content-type': 'application/json' },
    })
  }
  impl.calls = calls
  return impl
}

/* ── ① 起步：内置五个都在 ───────────────────────────────────────────── */

console.log('① 一开始：内置五个都在、都启用、都标成内置')
{
  const list = await listConfiguredSources()
  check('★★ 列出五个内置源', list.length === BUILTIN_PROMPT_SOURCES.length,
    String(list.length) + ' vs ' + String(BUILTIN_PROMPT_SOURCES.length))
  check('★★ 五个都标成 builtin:true', list.every(s => s.builtin === true), '')
  check('★★ 五个默认都启用', list.every(s => s.enabled === true), '')
  check('★★ 每个都带名字与地址', list.every(s => s.name !== '' && s.url !== ''), '')
  check('★ 不带 entries（那是 800KB，配置页不该搬）',
    list.every(s => s.entries === undefined), '')
}

/* ── ② 内置的删不掉（只能停用） ─────────────────────────────────────── */

console.log('② 内置五个删不掉')
{
  const first = BUILTIN_PROMPT_SOURCES[0].id
  const out = await deleteSource(first)
  check('★★ 删内置 → 拒绝', out.ok === false, String(out.ok))
  check('★★ 拒绝时标 builtin:true（界面据此显示「只能停用」）', out.builtin === true, String(out.builtin))
  check('★★ 那句话说清「删了下次升级还会回来，改用停用」',
    String(out.error).includes('删不掉') && String(out.error).includes('停用'), String(out.error))
  const still = await listConfiguredSources()
  check('★★ 它还在（没被删掉）', still.some(s => s.id === first), '')

  /* 停用是可以的。 */
  const off = await updateSource(first, { enabled: false })
  check('★★ 停用内置 → 允许', 'error' in off === false, JSON.stringify(off))
  const after = await listConfiguredSources()
  check('★★ 停用后 enabled 变 false', after.find(s => s.id === first)?.enabled === false, '')
  check('★★ 停用后**还在清单里**（不是消失 —— 停用与删除是两件事）',
    after.length === BUILTIN_PROMPT_SOURCES.length, String(after.length))

  /* 再启用回来。 */
  const on = await updateSource(first, { enabled: true })
  check('★★ 能再启用回来', 'error' in on === false
    && (await listConfiguredSources()).find(s => s.id === first)?.enabled === true, '')

  /* 改显示名与地址（内置的改动落在覆盖层，不动内置常量）。 */
  await updateSource(first, { name: '改过的名字', url: 'https://my.example.com/p.json' })
  const renamed = (await listConfiguredSources()).find(s => s.id === first)
  check('★★ 内置的显示名能改', renamed?.name === '改过的名字', renamed?.name)
  check('★★ 内置的地址能改', renamed?.url === 'https://my.example.com/p.json', renamed?.url)
  check('★★ **不改内置常量本身**（升级时还跟得上上游）',
    BUILTIN_PROMPT_SOURCES[0].name !== '改过的名字', BUILTIN_PROMPT_SOURCES[0].name)
}

/* ── ③ 用户能加自己的源 ─────────────────────────────────────────────── */

console.log('③ 用户能加 / 改 / 删自己的源')
{
  const added = await addSource({ id: 'my-src', name: '我的源', url: 'https://a.example.com/p.json' })
  check('★★ 加成功', 'error' in added === false, JSON.stringify(added))
  const list = await listConfiguredSources()
  const mine = list.find(s => s.id === 'my-src')
  check('★★ 加进去了且标 builtin:false', mine !== undefined && mine.builtin === false, JSON.stringify(mine?.builtin))
  check('★★ 排在最后（内置在前）', list[list.length - 1].id === 'my-src', list[list.length - 1].id)

  const dup = await addSource({ id: 'my-src', name: '重复', url: 'https://b.example.com/p.json' })
  check('★★ 同 id 加第二次 → 拒绝', 'error' in dup && String(dup.error).includes('已经有'), String(dup.error))

  const clash = await addSource({ id: BUILTIN_PROMPT_SOURCES[0].id, url: 'https://c.example.com/p.json' })
  check('★★ 用内置的 id → 拒绝（两处同 id 谁赢说不清）',
    'error' in clash && String(clash.error).includes('内置'), String(clash.error))

  const noUrl = await addSource({ name: '没地址', url: '' })
  check('★★ 没地址 → 拒绝', 'error' in noUrl && String(noUrl.error).includes('不能为空'), String(noUrl.error))

  const badId = await addSource({ id: '有中文', url: 'https://d.example.com/p.json' })
  check('★★ 非法 id → 拒绝（id 会进文件名）',
    'error' in badId && String(badId.error).includes('只能'), String(badId.error))

  /* 改自己的 */
  const up = await updateSource('my-src', { name: '改了名', url: 'https://e.example.com/p.json' })
  check('★★ 改自己的源', 'error' in up === false
    && (await listConfiguredSources()).find(s => s.id === 'my-src')?.name === '改了名', '')

  /* 删自己的 */
  const del = await deleteSource('my-src')
  check('★★ 删自己的源 → 成功', 'error' in del === false, JSON.stringify(del))
  check('★★ 删完清单里没了', (await listConfiguredSources()).every(s => s.id !== 'my-src'), '')

  const delMiss = await deleteSource('never-exist')
  check('★★ 删不存在的 → 拒绝并说没这个源',
    'error' in delMiss && String(delMiss.error).includes('没有这个源'), String(delMiss.error))
}

/* ── ④ 只存差异（内置的字段不冻结） ─────────────────────────────────── */

console.log('④ 文件里只存用户改的那部分')
{
  const file = await readSourcesFile()
  check('★★ 有 overrides 段', typeof file.overrides === 'object' && file.overrides !== null,
    JSON.stringify(Object.keys(file.overrides ?? {})))
  const first = BUILTIN_PROMPT_SOURCES[0].id
  check('★★ 只记改过的那个源（没改的不写进去）',
    Object.keys(file.overrides ?? {}).length === 1, JSON.stringify(Object.keys(file.overrides ?? {})))
  check('★★ 记的是改过的那几项，不是整份快照',
    Object.keys(file.overrides?.[first] ?? {}).every(k => ['enabled', 'name', 'url'].includes(k)),
    JSON.stringify(file.overrides?.[first]))
  check('★ 文件名是 prompt-sources.json', PROMPT_SOURCES_FILE === 'prompt-sources.json', PROMPT_SOURCES_FILE)
}

/* ── ⑤ 测连通：三种失败分开说 ───────────────────────────────────────── */

console.log('⑤ 测连通')
{
  /* 成功 */
  const okf = fakeFetch(() => ({ body: [{ id: 'a' }, { id: 'b' }] }))
  const ok = await probeSource(BUILTIN_PROMPT_SOURCES[0].id, okf)
  check('★★ 通 → ok:true 且报出条目数', ok.ok === true && ok.count === 2, JSON.stringify(ok))
  check('★★ 报出问的是哪个地址（排查必看）', String(ok.url).length > 0, String(ok.url))

  /* 连不上 */
  const un = await probeSource(BUILTIN_PROMPT_SOURCES[0].id, fakeFetch(() => ({ throw: 'ENOTFOUND' })))
  check('★★ 连不上 → 说「连不上」+ 带上原文',
    un.ok === false && String(un.error).includes('连不上') && String(un.error).includes('ENOTFOUND'),
    String(un.error))

  /* 404 */
  const nf = await probeSource(BUILTIN_PROMPT_SOURCES[0].id, fakeFetch(() => ({ status: 404 })))
  check('★★ 404 → 说「地址没有东西 / 仓库改名没有」',
    nf.ok === false && String(nf.error).includes('404') && String(nf.error).includes('仓库改名'), String(nf.error))

  /* 回的不是 JSON */
  const notJson = await probeSource(BUILTIN_PROMPT_SOURCES[0].id, fakeFetch(() => ({ raw: '<html>hi</html>' })))
  check('★★ 不是 JSON → 说「多半是一个网页，不是提示词 JSON」',
    notJson.ok === false && String(notJson.error).includes('网页'), String(notJson.error))

  /* 是 JSON 但顶层不是数组 */
  const notArr = await probeSource(BUILTIN_PROMPT_SOURCES[0].id, fakeFetch(() => ({ body: { entries: [] } })))
  check('★★ 是 JSON 但不是数组 → 说清「这个源要求顶层是条目数组」',
    notArr.ok === false && String(notArr.error).includes('数组'), String(notArr.error))

  /* 没地址的源 */
  await updateSource(BUILTIN_PROMPT_SOURCES[1].id, { url: '' })
  const noUrl = await probeSource(BUILTIN_PROMPT_SOURCES[1].id, fakeFetch(() => ({ body: [] })))
  check('★★ 没地址 → 说「只用内置副本，探不了」（不是假装成功）',
    noUrl.ok === false && String(noUrl.error).includes('探不了'), String(noUrl.error))

  const miss = await probeSource('never-exist', fakeFetch(() => ({ body: [] })))
  check('★★ 测不存在的源 → 说没这个源', miss.ok === false && String(miss.error).includes('没有这个源'), '')
}

/* ── ⑥ 容错 ───────────────────────────────────────────────────────── */

console.log('⑥ 容错')
{
  check('★ id 判据：字母数字开头、只含 . _ -', isPromptSourceId('a.b-c_1') && !isPromptSourceId('../x')
    && !isPromptSourceId(''), '')
  /* 写一份垃圾进文件，读的时候不该崩。 */
  await saveSourcesFile({
    overrides: { '不合法 id': { enabled: false }, [BUILTIN_PROMPT_SOURCES[0].id]: { enabled: false } },
    custom: [{ id: 'ok-src', name: 'ok', url: 'https://x.example.com/p.json' }, { id: 'bad id', url: 'https://y' }],
  })
  const list = await listConfiguredSources()
  check('★★ 垃圾 id 跳过、合法 id 留下', list.some(s => s.id === 'ok-src'), JSON.stringify(list.map(s => s.id)))
  check('★★ 但合法的 override 仍然生效',
    list.find(s => s.id === BUILTIN_PROMPT_SOURCES[0].id)?.enabled === false, '')
}

console.log('')
if (bad === 0) console.log('全部通过 ✓')
else { console.log('有 ' + String(bad) + ' 条不通过 ✗'); process.exitCode = 1 }
