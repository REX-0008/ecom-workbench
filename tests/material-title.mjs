/** 素材库显示文本素材的标题（票 51，2026-10-28）。
 *
 * # 这一单修的是什么
 *
 * 文本素材存了两个名字：**文件名**（`文案-甲.text.json`）与**用户起的标题**
 * （`小红书开箱文案`）。界面上一直只画文件名 —— 于是用户当初给它起的名字
 * **从来没露过面**，而票 45 的搜索已经能按标题命中了（命中了看不见，更困惑）。
 *
 * # 这一份盯什么
 *
 * 改动本身很小，风险全在**顺手统一**上：
 *
 * | 坏法 | 抓它的断言 |
 * |---|---|
 * | 为了「好看」把图片也改成显示别的 | 「图片与视频的显示**与改动前逐字一样**」 |
 * | 标题为空时编一个（显示空串/显示 `.text.json`）| 「无标题的文本素材退回文件名」 |
 * | `kind` 缺失的新宿主半被当成文本 | 「`kind` 没给 → 退回文件名」 |
 * | 删除请求改成用标题发（**这会让删除失败**）| 「删除请求仍按文件名发」 |
 *
 * ⚠️ 最后一条是这一单最危险的地方：标题**不是键**，文件名才是。
 * 用标题去 `DELETE /materials/<name>` 会删不掉，而且不报错地留在列表里。
 *
 * 跑法：`node scripts/run-tests.mjs material-title`
 */
import { createEnv } from './_canvas-harness.mjs'

const env = await createEnv()
const { window, React, act, mount, click, settle, check } = env

/**
 * 挂内容库，素材列表用给定的那几条（临时接管 `GET /materials`）。
 * @param {object[]} mats - 素材数组（形状照 `GET /materials`）。
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
  /* 卸载时恢复 fetch —— 返回一个包过的句柄，调用方照常 `m.unmount()`。 */
  const raw = m.unmount
  m.unmount = () => {
    raw()
    window.fetch = realFetch
    globalThis.fetch = realFetch
  }
  return m
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 纯函数：四种情况的判据
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① materialLabel：文本素材显示标题，其余一个字节不动 ===')
{
  const { materialLabel } = await import('../src/client/workbench/ContentLibrary.tsx')

  const img = { name: '参考图一.png', bytes: 1, mtime: 1, url: '/a', kind: 'image' }
  const vid = { name: '演示视频.mp4', bytes: 1, mtime: 1, url: '/b', kind: 'video' }
  const txt = { name: '文案-甲.text.json', bytes: 1, mtime: 1, url: '/c', kind: 'text', title: '小红书开箱文案', content: '……' }
  const txtNoTitle = { name: '文案-乙.text.json', bytes: 1, mtime: 1, url: '/d', kind: 'text', content: '……' }
  const txtSpace = { name: '文案-丙.text.json', bytes: 1, mtime: 1, url: '/e', kind: 'text', title: '   ', content: '……' }
  const oldHost = { name: '文案-丁.text.json', bytes: 1, mtime: 1, url: '/f' }

  check('★★★ 文本素材 + 有标题 → 主文字是标题',
    materialLabel(txt).label === '小红书开箱文案', materialLabel(txt).label)
  check('★★★ 悬停提示里既有标题也有文件名（两个都要，用户可能去目录里找文件）',
    materialLabel(txt).title.includes('小红书开箱文案') && materialLabel(txt).title.includes('文案-甲.text.json'),
    materialLabel(txt).title)

  /* ★★★ 这一条是「不许顺手统一」的钉子。 */
  check('★★★ 图片：主文字与悬停提示**与改动前逐字一样**（都是文件名）',
    materialLabel(img).label === '参考图一.png' && materialLabel(img).title === '参考图一.png',
    JSON.stringify(materialLabel(img)))
  check('★★★ 视频：同上',
    materialLabel(vid).label === '演示视频.mp4' && materialLabel(vid).title === '演示视频.mp4',
    JSON.stringify(materialLabel(vid)))

  check('★★ 文本素材但没有标题 → 退回文件名（不显示空串）',
    materialLabel(txtNoTitle).label === '文案-乙.text.json', materialLabel(txtNoTitle).label)
  check('★★ 标题只有空格 → 也算没有标题',
    materialLabel(txtSpace).label === '文案-丙.text.json', materialLabel(txtSpace).label)
  check('★★ `kind` 缺失（老宿主半）→ 退回文件名，不假装知道它是什么',
    materialLabel(oldHost).label === '文案-丁.text.json', materialLabel(oldHost).label)
  check('★ 标题前后空格被去掉（不显示带空格的标题）',
    materialLabel({ ...txt, title: '  开箱文案  ' }).label === '开箱文案',
    materialLabel({ ...txt, title: '  开箱文案  ' }).label)
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 界面上：文本素材显示标题，图片视频不变
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 界面上：文本素材显示标题，图片与视频仍是文件名 ===')
{
  const mats = [
    { name: '参考图一.png', bytes: 100, mtime: 1, url: '/api/ecom-workbench/material/a.png', kind: 'image' },
    { name: '演示视频.mp4', bytes: 200, mtime: 2, url: '/api/ecom-workbench/material/b.mp4', kind: 'video' },
    { name: '文案-甲.text.json', bytes: 300, mtime: 3, url: '/api/ecom-workbench/material/c.text.json', kind: 'text', title: '小红书开箱文案', content: '……' },
    { name: '文案-乙.text.json', bytes: 400, mtime: 4, url: '/api/ecom-workbench/material/d.text.json', kind: 'text', content: '……' },
  ]
  const m = await mountLib(mats)
  const q = sel => m.el.querySelector(sel)

  check('★★ 四张卡都在', m.el.querySelectorAll('[data-ewb-material]').length === 4,
    String(m.el.querySelectorAll('[data-ewb-material]').length))

  const labelOf = name => q('[data-ewb-material="' + name + '"] [data-ewb-material-label]')?.textContent ?? ''

  check('★★★ 有标题的文本素材：卡上显示的是**标题**',
    labelOf('文案-甲.text.json') === '小红书开箱文案', labelOf('文案-甲.text.json'))
  check('★★★ 而且**不是**文件名', !labelOf('文案-甲.text.json').includes('.text.json'),
    labelOf('文案-甲.text.json'))

  /* ★★★ 这两条钉住「图片与视频完全没变」—— 靠的是**逐字比对**，不是「看起来对」。 */
  check('★★★ 图片卡：主文字仍是文件名（一字不差）',
    labelOf('参考图一.png') === '参考图一.png', labelOf('参考图一.png'))
  check('★★★ 视频卡：主文字仍是文件名（一字不差）',
    labelOf('演示视频.mp4') === '演示视频.mp4', labelOf('演示视频.mp4'))
  check('★★ 图片卡悬停提示仍是文件名本身',
    q('[data-ewb-material="参考图一.png"] [data-ewb-material-label]')?.getAttribute('title') === '参考图一.png',
    String(q('[data-ewb-material="参考图一.png"] [data-ewb-material-label]')?.getAttribute('title')))

  check('★★ 没有标题的文本素材：仍显示文件名',
    labelOf('文案-乙.text.json') === '文案-乙.text.json', labelOf('文案-乙.text.json'))

  /* ★★ 磁盘上的真实文件名仍然挂在元素上 —— 删除要靠它。 */
  check('★★ 元素上仍带着真实文件名（删除要用它，不是标题）',
    q('[data-ewb-material="文案-甲.text.json"] [data-ewb-material-label]')?.getAttribute('data-ewb-material-file') === '文案-甲.text.json',
    String(q('[data-ewb-material="文案-甲.text.json"] [data-ewb-material-label]')?.getAttribute('data-ewb-material-file')))

  check('★★ 长标题不会撑破卡片（那一行有 truncate）',
    (q('[data-ewb-material="文案-甲.text.json"] [data-ewb-material-label]')?.className ?? '').includes('truncate'),
    q('[data-ewb-material="文案-甲.text.json"] [data-ewb-material-label]')?.className ?? '')

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 删除确认框用标题问，但请求仍按文件名发
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 删除：问的时候用标题，发请求仍用文件名 ===')
{
  const mats = [
    { name: '参考图一.png', bytes: 100, mtime: 1, url: '/api/ecom-workbench/material/a.png', kind: 'image' },
    { name: '文案-甲.text.json', bytes: 300, mtime: 3, url: '/api/ecom-workbench/material/c.text.json', kind: 'text', title: '小红书开箱文案', content: '……' },
  ]
  const m = await mountLib(mats)
  const q = sel => m.el.querySelector(sel)
  const asked = []
  const sent = []
  const realFetch = window.fetch
  window.confirm = (text) => { asked.push(String(text)); return true }
  globalThis.confirm = window.confirm
  window.fetch = async (url, init) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '')
    if ((init?.method ?? 'GET') === 'DELETE') sent.push(p)
    return realFetch(url, init)
  }
  globalThis.fetch = window.fetch

  await click(q('[data-ewb-material-del="文案-甲.text.json"]'))
  await act(async () => { await settle() })

  check('★★ 删素材前弹了确认框', asked.length === 1, '弹了 ' + String(asked.length) + ' 次')
  check('★★★ 确认框里问的是**标题**（用户认的名字），不是 `xxx.text.json`',
    asked[0]?.includes('小红书开箱文案') === true && asked[0]?.includes('.text.json') !== true,
    String(asked[0]))
  /* ★★★ 这条最要紧：标题不是键。用标题发请求会「删不掉且不报错」。 */
  check('★★★ 删除请求仍按**文件名**发（用标题发会删不掉，且不报错）',
    sent.some(u => u === '/api/ecom-workbench/materials/' + encodeURIComponent('文案-甲.text.json')),
    sent.join(' / '))
  check('★★ 没有一次请求里出现标题（说明没把标题当键用）',
    !sent.some(u => u.includes(encodeURIComponent('小红书开箱文案'))), sent.join(' / '))

  /* 图片素材的确认框仍问文件名。 */
  asked.length = 0
  await click(q('[data-ewb-material-del="参考图一.png"]'))
  await act(async () => { await settle() })
  check('★★ 图片素材的确认框仍问文件名（与改动前一样）',
    asked[0]?.includes('参考图一.png') === true, String(asked[0]))

  m.unmount()
}

console.log('')
console.log(env.getFailed() === 0 ? '结论：文本素材显示标题了 ✓' : '结论：有 ' + String(env.getFailed()) + ' 条不通过 ✗')
process.exit(env.getFailed() === 0 ? 0 : 1)
