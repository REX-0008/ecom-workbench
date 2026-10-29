/** 内容库素材按 kind 分三组、文本素材不出破图（票 39 内容库那一半，2026-10-29）。
 *
 * # 这一单修的两件事
 *
 * | 问题 | 修法 |
 * |---|---|
 * | 三类素材平铺成一张网格，混在一起 | 按 `ASSET_GROUPS` 分三组，每组标题 + 数量 |
 * | 文本素材走 `<img src={m.url}>` → **破图** | 改画标题 + 正文摘要，与画布左栏同一形态 |
 *
 * # 破图为什么是真缺陷（不是「不好看」）
 *
 * 文本素材的 `url` 指向 `<name>.text.json`（`src/schedule/materials.ts:319`），
 * 浏览器把 JSON 当图片解 → 一个加载失败的空框。用户看不出这是文字内容。
 *
 * # 这一份盯什么
 *
 * 1. **三组分明**：顺序、标题、每组数量都对
 * 2. **文本素材不是 `<img>`**：那个位置上渲染的是文本卡，而且整张卡里
 *    **没有任何 `<img>` 的 src 含 `.text.json`**
 * 3. **图片与视频一字没变**：还是 `<img>` / `<video>`，还是文件名 —— 这是老行为
 * 4. **分组判据只有一份**：内容库 import 自 `CanvasSidePanel.tsx`，不是自己写的
 *
 * 第 4 条没法靠 DOM 验（两份判据实现得一样时行为也一样），所以用**源码断言**：
 * 内容库里不许出现自己判 kind 的正则（那种「看起来对、其实是第二份」的写法）。
 *
 * 跑法：`node scripts/run-tests.mjs material-groups`
 */
import { readFileSync } from 'node:fs'
import { createEnv } from './_canvas-harness.mjs'

const env = await createEnv()
const { window, React, mount, check } = env

/**
 * 挂内容库，素材列表用给定的那几条。
 * @param {object[]} mats - 素材（形状照 `GET /materials`）。
 * @returns {Promise<object>} 挂载句柄。
 */
async function mountLib(mats) {
  const realFetch = window.fetch
  const stub = async (url, init) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '')
    if (p === '/api/ecom-workbench/materials' && (init?.method ?? 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => ({ ok: true, materials: mats, items: mats }) }
    }
    return realFetch(url, init)
  }
  window.fetch = stub
  globalThis.fetch = stub
  const { ContentLibrary } = await import('../src/client/workbench/ContentLibrary.tsx')
  const m = await mount(React.createElement(ContentLibrary, { active: true }), 800)
  const raw = m.unmount
  m.unmount = () => {
    raw()
    window.fetch = realFetch
    globalThis.fetch = realFetch
  }
  return m
}

/* 三条素材：一条图片、一条视频、一条文本（带标题与正文）。 */
const MATS = [
  { name: '商品主图.png', bytes: 100, mtime: 1, url: '/api/ecom-workbench/material/a.png', kind: 'image' },
  { name: 'promo.mp4', bytes: 200, mtime: 2, url: '/api/ecom-workbench/material/b.mp4', kind: 'video' },
  {
    name: 'text-1750000000.text.json', bytes: 300, mtime: 3,
    url: '/api/ecom-workbench/material/c.text.json', kind: 'text',
    title: '小红书开箱文案', content: '  今天开箱一台新相机，  第一印象是体积小。  ',
  },
]

/* ══════════════════════════════════════════════════════════════════════
 * ① 三组分明：顺序、标题、数量
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 三组分明：图片 / 视频 / 文本，各组数量对 ===')
{
  const m = await mountLib(MATS)
  const q = sel => m.el.querySelector(sel)

  const heads = [...m.el.querySelectorAll('[data-ewb-mat-group-head]')].map(e => e.getAttribute('data-ewb-mat-group-head'))
  check('★★★ 三组都在，且顺序是 image / video / text（照 ASSET_GROUPS）',
    heads.join(',') === 'image,video,text', heads.join(','))

  check('★★ 图片组的标题是「图片」',
    (q('[data-ewb-mat-group-head="image"]')?.textContent ?? '').includes('图片'),
    q('[data-ewb-mat-group-head="image"]')?.textContent ?? '')
  check('★★ 视频组的标题是「视频」',
    (q('[data-ewb-mat-group-head="video"]')?.textContent ?? '').includes('视频'),
    q('[data-ewb-mat-group-head="video"]')?.textContent ?? '')
  check('★★ 文本组的标题是「文本」',
    (q('[data-ewb-mat-group-head="text"]')?.textContent ?? '').includes('文本'),
    q('[data-ewb-mat-group-head="text"]')?.textContent ?? '')

  check('★★★ 每组数量都是 1',
    q('[data-ewb-mat-group-count="image"]')?.textContent === '1'
    && q('[data-ewb-mat-group-count="video"]')?.textContent === '1'
    && q('[data-ewb-mat-group-count="text"]')?.textContent === '1',
    ['image', 'video', 'text'].map(k => k + '=' + String(q('[data-ewb-mat-group-count="' + k + '"]')?.textContent)).join(' '))

  /* 每条素材落在它自己那一组里（不是「三组都在但内容乱放」）。 */
  check('★★★ 每条素材落在自己那一组里',
    q('[data-ewb-mat-group="image"] [data-ewb-material="商品主图.png"]') !== null
    && q('[data-ewb-mat-group="video"] [data-ewb-material="promo.mp4"]') !== null
    && q('[data-ewb-mat-group="text"] [data-ewb-material="text-1750000000.text.json"]') !== null,
    [...m.el.querySelectorAll('[data-ewb-material]')].map(e => e.getAttribute('data-ewb-material')).join(' / '))

  /* 卡片上的 kind 标记与它所在的组一致。 */
  const kinds = [...m.el.querySelectorAll('[data-ewb-material]')].map(e => e.getAttribute('data-ewb-material-kind'))
  check('★★ 每张卡带的 kind 与所在组一致',
    kinds.join(',') === 'image,video,text', kinds.join(','))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 文本素材不出破图（这是票 39 修的那个真缺陷）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 文本素材：不画 <img>，画标题 + 正文摘要 ===')
{
  const m = await mountLib(MATS)
  const q = sel => m.el.querySelector(sel)
  const textCard = '[data-ewb-material="text-1750000000.text.json"]'

  /* ★★★ 核心一条：**整张文本卡里一个 `<img>` 都没有**。 */
  check('★★★ 文本素材那张卡里没有 <img>（原来是一张破图）',
    q(textCard + ' img') === null,
    q(textCard + ' img') === null ? '' : '还是 <img>：' + String(q(textCard + ' img')?.getAttribute('src')))
  check('★★★ 也没有 <video>（它不是视频）', q(textCard + ' video') === null)

  /* ★★★ 反过来再验一次：整棵 DOM 里**没有任何 img 的 src 含 .text.json**。
   * 这条比上一条宽 —— 挡住「换个别的地方又画出破图」那种写法。 */
  const badSrc = [...m.el.querySelectorAll('img')]
    .map(i => i.getAttribute('src') ?? '')
    .filter(s => s.includes('.text.json'))
  check('★★★ 整个内容库里没有一处 <img> 指向 .text.json（破图源头已断）',
    badSrc.length === 0, badSrc.join(' / '))

  /* 它画的是文本卡：标题 + 正文摘要。 */
  check('★★★ 文本素材画出的是文本卡（data-ewb-material-text 在）',
    q(textCard + ' [data-ewb-material-text]') !== null)
  check('★★ 卡上显示的是**标题**（「小红书开箱文案」，不是 text-1750000000.text.json）',
    (q(textCard + ' [data-ewb-material-text-title]')?.textContent ?? '') === '小红书开箱文案',
    String(q(textCard + ' [data-ewb-material-text-title]')?.textContent))
  const body = q(textCard + ' [data-ewb-material-text-body]')?.textContent ?? ''
  check('★★ 卡上有**正文摘要**（空白压成一行）',
    body.includes('今天开箱') && !body.includes('\n'), body)
  check('★ 摘要与左栏同一个函数（超 60 字截断带省略号）',
    body.length <= 61, String(body.length))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 图片与视频一字没变（这是老行为，不许顺手改）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 图片与视频：显示与改动前完全一样 ===')
{
  const m = await mountLib(MATS)
  const q = sel => m.el.querySelector(sel)

  check('★★★ 图片卡仍是 <img>，src 就是那个 url',
    q('[data-ewb-material="商品主图.png"] [data-ewb-material-img]')?.getAttribute('src') === '/api/ecom-workbench/material/a.png',
    String(q('[data-ewb-material="商品主图.png"] [data-ewb-material-img]')?.getAttribute('src')))
  check('★★ 图片卡上没有文本卡的钩子（没被顺手改成文本样式）',
    q('[data-ewb-material="商品主图.png"] [data-ewb-material-text]') === null)

  check('★★★ 视频卡仍是 <video> 且带播放控件',
    q('[data-ewb-material="promo.mp4"] [data-ewb-material-video]')?.hasAttribute('controls') === true
    && q('[data-ewb-material="promo.mp4"] [data-ewb-material-video]')?.getAttribute('src') === '/api/ecom-workbench/material/b.mp4')
  check('★★ 视频卡上没有文本卡的钩子',
    q('[data-ewb-material="promo.mp4"] [data-ewb-material-text]') === null)

  /* ★★ 图片与视频的主文字仍是**文件名**（票 51 定的，不许因为这票变成别的）。 */
  check('★★★ 图片卡主文字仍是文件名（一字不差）',
    (q('[data-ewb-material="商品主图.png"] [data-ewb-material-label]')?.textContent ?? '') === '商品主图.png',
    String(q('[data-ewb-material="商品主图.png"] [data-ewb-material-label]')?.textContent))
  check('★★★ 视频卡主文字仍是文件名（一字不差）',
    (q('[data-ewb-material="promo.mp4"] [data-ewb-material-label]')?.textContent ?? '') === 'promo.mp4',
    String(q('[data-ewb-material="promo.mp4"] [data-ewb-material-label]')?.textContent))

  /* 删除按钮仍按文件名（标题不是键，混了就删不掉）。 */
  check('★★ 文本素材的删除按钮仍按文件名挂',
    q('[data-ewb-material-del="text-1750000000.text.json"]') !== null)

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 分组判据只有一份（源码断言）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 分组判据只有一份：从 CanvasSidePanel import，不自己重写 ===')
{
  const src = readFileSync(new URL('../src/client/workbench/ContentLibrary.tsx', import.meta.url), 'utf8')

  check('★★★ 内容库 import 了 materialKindOf 与 ASSET_GROUPS（与左栏同一份）',
    /import\s*\{[^}]*materialKindOf[^}]*\}\s*from\s*'\.\/CanvasSidePanel\.tsx'/.test(src)
    && /import\s*\{[^}]*ASSET_GROUPS[^}]*\}\s*from\s*'\.\/CanvasSidePanel\.tsx'/.test(src),
    (src.match(/from '\.\/CanvasSidePanel\.tsx'/g) ?? []).length + ' 处 import')

  /* ★★★ 这一条挡「import 了但自己又写一份」那种假共用。 */
  const ownVideoRe = /\\\.\(mp4\|webm\|mov\|m4v\|avi\|mkv\)\$/g
  check('★★★ 内容库里不再有自己的视频扩展名正则（原来那行 `isVideo` 已删）',
    (src.match(ownVideoRe) ?? []).length === 0,
    (src.match(ownVideoRe) ?? []).length + ' 处')

  /* ★★ 正文摘要也必须是同一个函数（不是这里再写一遍 slice）。 */
  check('★★ 内容库 import 了 materialSummaryOf（摘要与左栏同一份）',
    /import\s*\{[^}]*materialSummaryOf[^}]*\}\s*from\s*'\.\/CanvasSidePanel\.tsx'/.test(src))
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 两处主文字规则的差别**逐输入钉死**（不是「注释里说说」）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 票 39 的 lead 追问过一句：「『左栏按扩展名兜底、内容库不认』那句是真的吗？」
 * 答案是**核出来一半对一半错**：
 *
 *   · 分类确实曾经不同 —— `kind` 缺席时左栏按扩展名认出文本素材，内容库原来不认。
 *     这一条**已经修**（两边都走 `materialKindOf`），所以现在**没有**区别了。
 *   · 主文字确实不同 —— 只在「文本素材 + 标题为空」这一种情况下：
 *     左栏给「（没有标题）」，内容库给文件名。
 *
 * 所以这一组断言做两件事：**证明分类一致**、**证明主文字只差那一行**。
 * 注释会过时，断言不会。 */
console.log('')
console.log('=== ⑤ 分类一致、主文字只差「标题为空」那一行（逐输入钉死）===')
{
  const side = await import('../src/client/workbench/CanvasSidePanel.tsx')
  const lib = await import('../src/client/workbench/ContentLibrary.tsx')

  /* 同一批输入喂给两边。 */
  const CASES = [
    /* 分类一致性用的：`kind` 缺席时必须都认出是文本素材。 */
    { tag: 'kind 缺席 + 名字 .text.json', m: { name: 'text-1.text.json', title: '标题', content: 'x' } },
    { tag: 'kind 缺席 + 名字 .json', m: { name: 'note.json', title: '标题', content: 'x' } },
    { tag: 'kind 缺席 + 名字 .mp4', m: { name: 'clip.mp4', title: '标题', content: 'x' } },
    { tag: 'kind=text 明说', m: { name: 'a.text.json', kind: 'text', title: '标题' } },
    /* 主文字一致性用的：除「标题为空」外都该逐字相同。 */
    { tag: '文本 + 有标题', m: { name: 'a.text.json', kind: 'text', title: '开箱' } },
    { tag: '文本 + 标题前后空格', m: { name: 'a.text.json', kind: 'text', title: '  开箱  ' } },
    { tag: '图片', m: { name: 'a.png', kind: 'image' } },
    { tag: '视频', m: { name: 'b.mp4', kind: 'video' } },
  ]

  for (const c of CASES) {
    /* ★★★ 两边的主文字在**这些**输入上必须逐字相同（证明没有无理由漂移）。 */
    check('★★ 主文字一致：' + c.tag,
      side.materialLabelOf(c.m) === lib.materialLabel(c.m).label,
      '左栏=' + JSON.stringify(side.materialLabelOf(c.m)) + ' 内容库=' + JSON.stringify(lib.materialLabel(c.m).label))
  }

  /* ★★★ 唯一那一处差别的**正面**断言：两边各按自己的规则行事。 */
  const noTitle = { name: 'a.text.json', kind: 'text', content: 'x' }
  check('★★★ 差别只有一处：文本素材没标题时，左栏给「（没有标题）」',
    side.materialLabelOf(noTitle) === '（没有标题）', side.materialLabelOf(noTitle))
  check('★★★ 而内容库给**文件名**（删除按钮要用它，见 `materialLabel` 的注释）',
    lib.materialLabel(noTitle).label === 'a.text.json', lib.materialLabel(noTitle).label)
  check('★★ 标题是空串、只有空格时同理（都算「没标题」）',
    side.materialLabelOf({ ...noTitle, title: '' }) === '（没有标题）'
    && lib.materialLabel({ ...noTitle, title: '' }).label === 'a.text.json'
    && lib.materialLabel({ ...noTitle, title: '   ' }).label === 'a.text.json',
    '空串 → 内容库 ' + lib.materialLabel({ ...noTitle, title: '' }).label
    + ' / 空格 → 内容库 ' + lib.materialLabel({ ...noTitle, title: '   ' }).label)

  /* ★★ 分类：`kind` 缺席时**两边都认得出**文本素材（这是修好的那一处）。 */
  const oldText = { name: 't.text.json', title: '老标题', content: 'x' }
  check('★★★ `kind` 缺席的老目录文本素材：左栏与内容库都判成 text',
    side.materialKindOf(oldText) === 'text' && lib.materialLabel(oldText).label === '老标题',
    'kindOf=' + side.materialKindOf(oldText) + ' 内容库=' + lib.materialLabel(oldText).label)
}

console.log('')
console.log(env.getFailed() === 0 ? '结论：素材三组分明、文本不出破图 ✓' : '结论：有 ' + String(env.getFailed()) + ' 条不通过 ✗')
process.exit(env.getFailed() === 0 ? 0 : 1)
