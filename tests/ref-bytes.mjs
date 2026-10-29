/** 参考图取字节（票 71，2026-10-29）。
 *
 * ## 这一段守的是什么
 *
 * 内容画布上用户选了参考图（缩略图也显示了），点「生成」时那张图**根本没送出去**。
 * `data.reference` 存了值，`doGenerate` 拼 `refs` 时从来没读过。
 *
 * 修法的关键不是「多读一个字段」，而是**先把那个值认出来**：
 * 它有五种形状，来源各不相同（素材完整路径 / 素材短前缀 / 产物 id / 纯名字 / 认不出）。
 *
 * ## 为什么这一份必须单测
 *
 * 五种形状靠 `if` 串在调用点里必然漏一种，而漏的那种表现是「某类素材静默失效」——
 * 不报错、结果不对。所以判形状必须是**纯函数**，五种形状各一条断言。
 *
 * 跑法：node --import <tsx> tests/ref-bytes.mjs
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-refb-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')

const { refBytes, refBase64, artifactBase64, materialHref, artifactHref } =
  await import('../src/client/workbench/content-canvas-store.ts')

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

/* ══════════════════════════════════════════════════════════════════════
 * 一、五种形状逐个对上（判据 2）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== 一、refBytes 五种形状 ===')
{
  /* ① 素材完整路径 —— `refFromMaterial` 写的是 `m.url`，带 `/api/ecom-workbench` */
  const full = refBytes('/api/ecom-workbench/material/a.png')
  check('★★★ ① 素材完整路径 → 走素材路由，键是文件名',
    full !== null && full.route === 'material' && full.key === 'a.png', JSON.stringify(full))

  /* ② 素材短前缀 —— 上传替换（`ContentCanvas.tsx:2811`）写的是 `'material/' + name` */
  const short = refBytes('material/a.png')
  check('★★★ ② 素材短前缀 → 同样走素材路由（要剥前缀）',
    short !== null && short.route === 'material' && short.key === 'a.png', JSON.stringify(short))

  /* ③ 产物 id */
  const art = refBytes('art-20261026-abcd')
  check('★★★ ③ 产物 id → 走产物路由',
    art !== null && art.route === 'artifact' && art.key === 'art-20261026-abcd', JSON.stringify(art))

  /* ④ 纯名字（老存档手填）—— 判成产物，取不回时由 refBase64 再当素材名试 */
  const bare = refBytes('a.png')
  check('★★★ ④ 纯名字 → 先判成产物（形状与产物 id 不可区分）',
    bare !== null && bare.route === 'artifact' && bare.key === 'a.png', JSON.stringify(bare))

  /* ⑤ 认不出 */
  check('★★★ ⑤ http 地址认不出', refBytes('http://x.com/a.png') === null, JSON.stringify(refBytes('http://x.com/a.png')))
  check('★★★ ⑤ 空串认不出', refBytes('') === null, '')
  check('★★★ ⑤ 空白认不出', refBytes('   ') === null, '')
  check('★★★ ⑤ 非字符串认不出',
    refBytes(null) === null && refBytes(undefined) === null && refBytes(123) === null, '')
  check('★★★ ⑤ 含 .. 认不出（挡目录穿越）',
    refBytes('../x.png') === null && refBytes('material/../x.png') === null,
    JSON.stringify([refBytes('../x.png'), refBytes('material/../x.png')]))
  check('★★★ ⑤ 只是前缀、后面空的认不出',
    refBytes('material/') === null && refBytes('/api/ecom-workbench/material/') === null, '')

  /* 形状不可区分这件事本身：④ 与 ③ 落在同一条判据上。 */
  check('★★★ ③④ 两种形状**确实不可区分**（都满足 id 形状，所以都要靠回退分开）',
    refBytes('a.png')?.route === refBytes('art-20261026-abcd')?.route,
    JSON.stringify([refBytes('a.png'), refBytes('art-20261026-abcd')]))
}

/* ══════════════════════════════════════════════════════════════════════
 * 二、两条路由地址拼得对
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 二、两条路由 ===')
{
  check('★★ 产物地址拼对',
    artifactHref('art-1') === '/api/ecom-workbench/artifact/art-1', artifactHref('art-1'))
  check('★★ 素材地址拼对（名字要 encode）',
    materialHref('a b.png') === '/api/ecom-workbench/material/a%20b.png', materialHref('a b.png'))
  check('★★ 素材名里带斜杠会被 encode（不给路径穿越留口子）',
    materialHref('../x.png') === '/api/ecom-workbench/material/..%2Fx.png', materialHref('../x.png'))
}

/* ══════════════════════════════════════════════════════════════════════
 * 三、refBase64：label 只影响话术、不影响判形状
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 三、refBase64 的取字节与话术 ===')
{
  /** 记录每次 fetch 打的是哪个地址。 */
  const hits = []
  const realFetch = globalThis.fetch
  /**
   * 假 fetch：`gone` 里那些返回 404，其余回一段字节。
   * @param url - 地址。
   * @returns 响应。
   */
  globalThis.fetch = async (url) => {
    const u = String(url)
    hits.push(u)
    if (u.includes('gone')) return { ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0) } }
    /* 「只在素材那边存在」的一个名字：产物路由 404、素材路由 200。
     * 这正是老存档手填纯名字的处境（`a.png` 是素材名，不是产物 id）。 */
    if (u.includes('/artifact/mat-only')) return { ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0) } }
    return {
      ok: true, status: 200,
      async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer },
    }
  }

  try {
    hits.length = 0
    const art = await refBase64('art-ok', '底图')
    check('★★★ 产物 id 取得到字节', art.ok === true && typeof art.data?.base64 === 'string', JSON.stringify(art.ok))
    check('★★ 打的是产物路由', hits.length === 1 && hits[0] === '/api/ecom-workbench/artifact/art-ok', hits.join(','))

    hits.length = 0
    const mat = await refBase64('/api/ecom-workbench/material/a.png', '参考图')
    check('★★★ 素材完整路径取得到字节', mat.ok === true, JSON.stringify(mat.error))
    check('★★ 打的是素材路由（不是产物路由）',
      hits.length === 1 && hits[0] === '/api/ecom-workbench/material/a.png', hits.join(','))

    hits.length = 0
    const sh = await refBase64('material/a.png', '首帧')
    check('★★★ 素材短前缀也取得到（剥前缀后打素材路由）',
      sh.ok === true && hits[0] === '/api/ecom-workbench/material/a.png', hits.join(','))

    /* 认不出：直接报错，**一次都不 fetch**。 */
    hits.length = 0
    const bad = await refBase64('http://x.com/a.png', '参考图')
    check('★★★ 认不出的取值报错（不是静默跳过）',
      bad.ok === false && String(bad.error).includes('认不出来'), String(bad.error))
    check('★★★ 认不出时一次 fetch 都没发（不猜）', hits.length === 0, String(hits.length) + ' 次')

    /* ⚠️ label 只影响话术：同一个值换 label，报错里的词跟着换，判形状不变。 */
    const a1 = await refBase64('http://x.com/a.png', '底图')
    const a2 = await refBase64('http://x.com/a.png', '参考图')
    check('★★★ label 只影响话术：换 label 报错里的词跟着换',
      String(a1.error).includes('底图') && String(a2.error).includes('参考图'),
      String(a2.error).slice(0, 40))
    check('★★★ 但两者都是「认不出来」（判形状不受 label 影响）',
      String(a1.error).includes('认不出来') && String(a2.error).includes('认不出来'), '')

    /* 产物 404 → 自动当素材名再试一次（老存档那种纯名字靠这条）。 */
    hits.length = 0
    const fallback = await refBase64('mat-only.png', '参考图')
    check('★★ 纯名字：产物路由 404 后**再试素材路由**（老存档那种手填值靠这条）',
      hits.length === 2
      && hits[0] === '/api/ecom-workbench/artifact/mat-only.png'
      && hits[1] === '/api/ecom-workbench/material/mat-only.png',
      hits.join(' → '))
    check('★★ 而且第二次真的取到了字节', fallback.ok === true, String(fallback.error))

    /* 两条都 404 → 报错点名、说清试过两条路。 */
    hits.length = 0
    const both = await refBase64('gone.png', '参考图')
    check('★★★ 两条路都取不回 → 报错（不是静默跳过）', both.ok === false, String(both.error))
    check('★★★ 报错点名是哪一张', String(both.error).includes('gone.png'), String(both.error).slice(0, 60))
    check('★★★ 报错说清两条路都试过了',
      String(both.error).includes('产物') && String(both.error).includes('素材'), String(both.error))
    check('★★ 确实试了两次', hits.length === 2, hits.join(','))

    /* ⚠️ 带路径的**不试**第二条路：路径写错要报错，不许悄悄换条路取到别的东西。 */
    hits.length = 0
    const path404 = await refBase64('/api/ecom-workbench/material/gone.png', '参考图')
    check('★★★ 带路径的取不回时**不换路重试**（只打一次）',
      path404.ok === false && hits.length === 1, hits.join(','))
    check('★★ 报错里那条路径的说明清楚', String(path404.error).includes('取不回'), String(path404.error).slice(0, 60))
  } finally {
    globalThis.fetch = realFetch
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 四、artifactBase64 是薄壳：既有话术一字不变
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 四、artifactBase64 薄壳（既有调用方不受影响） ===')
{
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0) } })
  try {
    const r = await artifactBase64('art-gone')
    check('★★★ 既有话术一字不变（「取不回底图：宿主半返回 404」）',
      String(r.error) === '取不回底图：宿主半返回 404', String(r.error))
    const empty = await artifactBase64('')
    check('★★ 空 id 那句也没变（「没有底图（产物 id 是空的）」）',
      String(empty.error) === '没有底图（产物 id 是空的）', String(empty.error))
  } finally {
    globalThis.fetch = realFetch
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * 五、doGenerate 真的把 data.reference 并进去了（源码层）
 *
 * ## 为什么这一条要看源码
 *
 * `doGenerate` 住在组件里，而组件引 `EcomWorkbench.module.css` ——
 * Node 跑不了（`ERR_UNKNOWN_FILE_EXTENSION`，`content-canvas-fixes.mjs` 文件头
 * 记着同一件事）。而这一段要验的恰恰是「那一行在不在、顺序对不对」，
 * 都是**声明层面**的事实，读源码是够的。
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 五、doGenerate 接上了 data.reference ===')
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/client/workbench/ContentCanvas.tsx', import.meta.url), 'utf8')

  check('★★★ doGenerate 里读了 `data.reference`', src.includes("(cur.data.reference ?? '').trim()"), '')
  check('★★★ 取不回时**停下报错**并 return（不是静默跳过）',
    /if \(!one\.ok \|\| one\.data === undefined\) \{[\s\S]{0,200}return/.test(src), '')
  check('★★★ 合并顺序是 底图 → 节点选的 → @ 提及',
    /mergeRefs\(\[\.\.\.\(preset\?\.refs \?\? \[\]\), \.\.\.picked\], mentioned\)/.test(src),
    '')
  check('★★★ 视频节点那条说「首帧」、其余说「参考图」',
    /cur\.type === 'video' \? '首帧' : '参考图'/.test(src), '')
  check('★★ 一张都没选时不多出空项（`picked` 只在非空时 push）',
    /if \(pickedRef !== ''\) \{/.test(src), '')
  check('★★ @ 提及那条 label 传的是「参考图」（修掉原先说「底图」的错话术）',
    /refBase64\(artId, '参考图'\)/.test(src), '')
}

console.log('')
console.log(failed === 0
  ? '结论：五种形状、两条路由、话术、回退、doGenerate 接线全部通过 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
