/** 产物库总数与「显示前 N 条」那句（票 52，2026-10-28，界面侧）。
 *
 * # 与 `tests/artifacts-total.mjs` 的分工
 *
 * | 文件 | 验什么 |
 * |---|---|
 * | `tests/artifacts-total.mjs` | 宿主半：`countArtifacts()` 数与 `listArtifacts()` 列表 |
 * | **本文件** | 界面：拿 `total` 显示总数、超上限时那句话、**不超上限时一字不变** |
 *
 * 分开的理由与前面几张一样：后端不挂 DOM（快、好定位），界面必须在真渲染里才验得到。
 *
 * # 最要紧的一条
 *
 * **不超上限时显示与改动前完全一样。** 绝大多数用户没有 200 条产物，
 * 他们不该看到任何变化 —— 这条要能抓住「顺手把总数改成 total、并且不管三七二十一
 * 都显示『显示前 N 条』」那种写法。
 *
 * 跑法：`node scripts/run-tests.mjs artifacts-total-ui`
 */
import { createEnv } from './_canvas-harness.mjs'

const env = await createEnv()
const { window, React, mount, check } = env

/**
 * 挂内容库，`/artifacts` 用给定的回包（临时接管 fetch）。
 * @param {object} payload - `{ items, total }`。
 * @returns {Promise<object>} 挂载句柄。
 */
async function mountWith(payload) {
  const realFetch = window.fetch
  const stub = async (url, init) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '')
    if (p === '/api/ecom-workbench/artifacts' && (init?.method ?? 'GET') === 'GET') {
      return { ok: true, status: 200, json: async () => ({ ok: true, dir: '/tmp', ...payload }) }
    }
    return realFetch(url, init)
  }
  window.fetch = stub
  globalThis.fetch = stub
  const { ContentLibrary } = await import('../src/client/workbench/ContentLibrary.tsx')
  const m = await mount(React.createElement(ContentLibrary, { active: true }), 700)
  const raw = m.unmount
  m.unmount = () => {
    raw()
    window.fetch = realFetch
    globalThis.fetch = realFetch
  }
  return m
}

/**
 * 造 n 条假产物（形状照 `GET /artifacts` 的 `items[]`）。
 * @param {number} n - 条数。
 * @returns {object[]} 数组。
 */
function fakeArts(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'art-' + String(i),
    ext: 'png', mime: 'image/png', bytes: 10, createdAt: 1000 + i,
    width: 8, height: 8, url: '/api/ecom-workbench/artifact/art-' + String(i),
  }))
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 不超过上限：与改动前完全一样（防回归）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 不超过上限：显示与改动前一样，且**没有**「显示前 N 条」那句 ===')
{
  const m = await mountWith({ items: fakeArts(12), total: 12 })
  const q = sel => m.el.querySelector(sel)

  check('★★★ 总数显示 12 条', (q('[data-ewb-art-total]')?.textContent ?? '').includes('共 12 条'),
    String(q('[data-ewb-art-total]')?.textContent))
  /* ★★★ 这一条防「不管三七二十一都显示那句话」。 */
  check('★★★ 没超上限时**不显示**「显示前 N 条」（用户看不到任何变化）',
    q('[data-ewb-art-truncated]') === null)
  check('★★ 十二张卡都在', m.el.querySelectorAll('[data-ewb-artifact]').length === 12,
    String(m.el.querySelectorAll('[data-ewb-artifact]').length))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 超上限：总数是真数 + 有一句话说清只显示了前 N 条
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 超上限：总数是真实 260，并说清只显示前 200 条 ===')
{
  const m = await mountWith({ items: fakeArts(200), total: 260 })
  const q = sel => m.el.querySelector(sel)

  check('★★★ 总数显示**真实**的 260 条（不是 200）',
    (q('[data-ewb-art-total]')?.textContent ?? '').includes('共 260 条'),
    String(q('[data-ewb-art-total]')?.textContent))
  check('★★★ 而且**不是** 200（这就是原来那个假数）',
    !(q('[data-ewb-art-total]')?.textContent ?? '').includes('共 200 条'),
    String(q('[data-ewb-art-total]')?.textContent))

  /* ★★★ 票面明令：不许静默截断。 */
  const trunc = q('[data-ewb-art-truncated]')?.textContent ?? ''
  check('★★★ 有一句「显示前 200 条」（不静默截断）', trunc.includes('显示前 200 条'), trunc)
  /* 为什么截断要说清 —— 用户会问「为什么不给我看全部」。 */
  check('★★ 悬停里说清了为什么（一次最多列 200 条，删掉旧的会补上）',
    (q('[data-ewb-art-truncated]')?.getAttribute('title') ?? '').includes('200'),
    String(q('[data-ewb-art-truncated]')?.getAttribute('title')))

  check('★★ 列表真的只有 200 张卡（总数是 260 但没多画）',
    m.el.querySelectorAll('[data-ewb-artifact]').length === 200,
    String(m.el.querySelectorAll('[data-ewb-artifact]').length))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 老宿主半不回首真数：退回 arts.length，不比改动前更差
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 回包里没有 total（或 total 是旧的假值）时退回列表条数 ===')
{
  /* 老宿主半回 `total: items.length` —— 那正是改动前的假数。 */
  const m = await mountWith({ items: fakeArts(200), total: 200 })
  const q = sel => m.el.querySelector(sel)
  check('★★ 老回包（total = items.length）→ 显示 200 条，与改动前一致',
    (q('[data-ewb-art-total]')?.textContent ?? '').includes('共 200 条'),
    String(q('[data-ewb-art-total]')?.textContent))
  check('★★ 那种情况下也不多说「显示前 N 条」（两个数相等，没被截断的迹象）',
    q('[data-ewb-art-truncated]') === null)
  m.unmount()

  /* 完全没有 `total` 这个键。 */
  const m2 = await mountWith({ items: fakeArts(5) })
  const q2 = sel => m2.el.querySelector(sel)
  check('★★ 回包里**没有** total 时退回列表条数（显示 5 条，不是 0 条）',
    (q2('[data-ewb-art-total]')?.textContent ?? '').includes('共 5 条'),
    String(q2('[data-ewb-art-total]')?.textContent))
  m2.unmount()
}

console.log('')
console.log(env.getFailed() === 0 ? '结论：总数是真的了 ✓' : '结论：有 ' + String(env.getFailed()) + ' 条不通过 ✗')
process.exit(env.getFailed() === 0 ? 0 : 1)
