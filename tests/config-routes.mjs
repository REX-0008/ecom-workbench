/** 配置面四条分组的路由层（2026-10-26，T-B-后端自查补的）。
 *
 * # 为什么单开一份
 *
 * 自查时发现：`model-fetch` / `storage-config` / `prompt-source-config` 那三份测试
 * 验的都是**函数**，没有一条真的走 HTTP 路由。判据是「每个路由的每个方法都要有一条
 * 测试真的调过它并断言了效果」—— 只测函数挡不住「路由接错方法」「路径拼错」
 * 「回包字段名写错」这一类。
 *
 * 走法照 `tests/generate-route.mjs`：`apply(fakeCtx)` 抓 handler，
 * `Readable` 造请求、`EventEmitter` 当响应。
 *
 * # ⏱ 耗时：那次 29.3 秒已归因（2026-10-27 查清）
 *
 * | 事实 | 值 |
 * |---|---|
 * | 那次全量里的耗时 | 29.3s（`tmp/full-react18-real.log`） |
 * | 网络正常时 | 1.42 秒（`probe` 真拉 GitHub，一秒钟上下） |
 * | 网络不通时 | 32 秒（`probe` 卡在超时上） |
 * | 单次调用超过 100ms 的 | 只有一条：`prompt-sources/config/:id/probe` |
 *
 * ## 真因
 *
 * `prompt-sources/config/:id/probe` 那一条断言真的去联网了。
 *
 * 探针函数本身收一个注入参数：`probeSource`（`prompt-source-config.ts:316`）的签名是
 * `probeSource(id: string, doFetch?: typeof fetch)`，`:322` 是 `const impl = doFetch ?? fetch`。
 * 但路由那条调用没传：`src/index.ts:1948` 写的是 `await probeSource(id)`，
 * 于是退回全局 `fetch`，真的去拉 `https://raw.githubusercontent.com/…/awesome-gpt-image.json`。
 * 网络通 → 1424ms；网络不通或卡住 → 32073ms（实测）。那次 29.3 秒就是它。
 *
 * 缺口在路由层没有注入点，不在函数层没有参数。这个区别决定该改哪一层：
 * 函数签名早就对，改它等于白改。
 *
 * ## 怎么修的
 *
 * 用 `withStubbedFetch()`（本文件 `:113`）只包住那一条调用，`finally` 里还原全局 `fetch`。
 * 修完 32389ms → 77ms，连跑三次 0.6 / 0.7 / 0.6 秒，断言一条没少。
 *
 * 不能全程换掉：④ 段有一条用例专门验「真连 `127.0.0.1:1` → kind=unreachable」，
 * 全程换等于把那条也 mock 了，判据强度直接掉。
 *
 * ## 当初为什么判成「未归因」（这份文件里最值钱的一句）
 *
 * 原来的注释写着「不真联网：把内置源地址指到一个假主机」。
 * 那段桩根本不存在。一句假注释让人相信了「这条不联网」，
 * 于是排查时没人往网络那一步去想，那次耗时就被写成了「查不出来」。
 *
 * 教训：注释里写「不会发生某某」时，得能指出是哪一行保证它不发生。
 * 指不出来就是愿望，不是事实。
 *
 * 如果再变慢，先看是不是又有哪条在真联网 —— 跑一遍单条耗时，
 * 找超过 100ms 的那一条，再看它走的 `fetch` 是不是全局的。
 *
 * 跑法：node scripts/run-tests.mjs config-routes
 */
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-cfgr-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const { apply } = await import('../src/index.ts')
const { saveChannel } = await import('../src/schedule/channels.ts')
const { dataRoot } = await import('../src/schedule/artifacts.ts')

let handler = null
apply({
  inject(names, fn) {
    if (names.includes('webServer')) fn({ webServer: { register(r) { handler = r.handler } } })
    if (names.includes('subprocess')) fn({ subprocess: { spawn: () => ({ terminate() {}, waitForExit: async () => true }) } })
  },
  effect() { return () => { /* 清理 */ } },
})

let bad = 0
/* ⏱ 整份耗时的起点（看门狗用，见文件末尾）。
 *
 * 必须在**第一条断言之前**取；放到结尾就成了「从结尾到结尾」的 0 毫秒，
 * 那条看门狗会永远绿 —— 那是假绿里最坏的一种。 */
const startedAt = Date.now()

/**
 * 在一段回调期间把全局 `fetch` 换成桩，**结束后一定还原**。
 *
 * ## 为什么需要它（2026-10-27）
 *
 * `probeSource` 收一个注入参数：`prompt-source-config.ts:316` 的签名是
 * `probeSource(id: string, doFetch?: typeof fetch)`，`:322` 是 `const impl = doFetch ?? fetch`。
 * 但路由那条调用没传第二个参数 —— `src/index.ts:1948` 写的是 `await probeSource(id)`，
 * 所以它退回全局 `fetch`。
 *
 * 于是「测连通」那条断言会真的去拉 GitHub —— 网络通时 648ms，
 * 网络不通时 32 秒（实测）。整份测试因此从 720ms 变成 32 秒。
 *
 * 缺口在路由层没有注入点，不在函数层没有参数 —— 这两句差一个字，差的是
 * 「该改哪一层」。这里选择在测试侧包住全局 `fetch`（不动 `src/**`），
 * 要根治得让路由那条能拿到一个可注入的 `fetch`。
 *
 * ## 为什么不能「全程换掉 fetch」
 *
 * ④ 段有一条用例专门验「真连 `127.0.0.1:1` → kind=unreachable」。
 * 全程换掉就等于把那条也 mock 了，判据强度直接掉。
 * 所以只在这一条调用**前后**换（`try/finally` 还原）。
 *
 * @param fn - 要包起来的那段。
 * @returns 那段的结果。
 */
async function withStubbedFetch(fn) {
  const real = globalThis.fetch
  /* 桩返回一份**像样的上游清单**：这样 `ok:true` 与 `count` 都能验到，
   * 比原来「靠真连失败、只验 error」覆盖得更多。 */
  globalThis.fetch = async (url) => {
    const body = [{ title: '桩条目一', prompt: 'p1' }, { title: '桩条目二', prompt: 'p2' }]
    return {
      ok: true,
      status: 200,
      url: String(url),
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}
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

/**
 * 模拟一次 HTTP 调用。
 * @param {string} method - 方法。
 * @param {string} url - 路径。
 * @param {object} [body] - 请求体。
 * @returns {Promise<{code:number, json:any}>} 响应。
 */
async function call(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  req.method = method
  req.url = url
  const res = new EventEmitter()
  let code = 0
  let text = ''
  res.writeHead = c => { code = c }
  res.end = s => { text = String(s ?? '') }
  res.writableEnded = false
  await handler(req, res)
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { code, json }
}

/* ── ① model-defaults：GET / PUT 都真调过 ───────────────────────────── */

console.log('① 默认模型四个方法都走通')
{
  const g0 = await call('GET', '/api/ecom-workbench/model-defaults')
  check('★★ GET 未设 → 200 + 四类全 false', g0.code === 200
    && Object.values(g0.json?.status ?? {}).every(v => v === false), JSON.stringify(g0.json?.status))
  check('★★ GET **不给 items**（映射不是列表）', g0.json?.items === undefined, JSON.stringify(g0.json?.items))

  const p1 = await call('PUT', '/api/ecom-workbench/model-defaults', {
    defaults: { defaultImageModel: { channelId: 'ch-x', modelId: 'm-1' } },
  })
  check('★★ PUT（带 defaults 包一层）→ 200', p1.code === 200, String(p1.json?.error))
  /* ⚠️ 2026-10-29（票 74）：又从五类退回四类，`image` 这个键回来了。
   * 上面那条 PUT 发的正是 `defaultImageModel` —— 现在它是**主键**，不是老键。
   * 判据守的事没变（「设进去了、读得出来」），变的只是键名。 */
  check('★★★ 回包里 status.image 变 true（票 74：image 回来了）',
    p1.json?.status?.image === true, JSON.stringify(p1.json?.status))
  /* ⚠️ 2026-10-29（票 76）：三类，没有 text（文本统一走 dsh）。
   * 判据守的事没变（「每一类都给一个布尔」），变的是有几类。 */
  check('★★ 回包里三类齐全（image/video/audio）',
    ['image', 'video', 'audio'].every(k => typeof p1.json?.status?.[k] === 'boolean')
    && Object.keys(p1.json?.status ?? {}).length === 3,
    JSON.stringify(p1.json?.status))
  check('★★★ 回包里**没有** text 那一格（票 76）',
    p1.json?.status?.text === undefined, JSON.stringify(p1.json?.status))

  const g1 = await call('GET', '/api/ecom-workbench/model-defaults')
  check('★★ 存完再 GET 读得到',
    g1.json?.defaults?.defaultImageModel?.modelId === 'm-1',
    JSON.stringify(g1.json?.defaults))

  /* 平铺写法（不带 defaults）也要收。 */
  const p2 = await call('PUT', '/api/ecom-workbench/model-defaults', {
    defaultVideoModel: { channelId: 'ch-y', modelId: 'v-1' },
  })
  check('★★ PUT（不带 defaults 直接平铺）也收', p2.json?.defaults?.defaultVideoModel?.modelId === 'v-1',
    JSON.stringify(p2.json?.defaults))
  check('★★ 整份覆盖：上一条 image 被清掉',
    p2.json?.defaults?.defaultImageModel === undefined,
    JSON.stringify(p2.json?.defaults))

  /* `broken`：默认指向的渠道不在时要说出来。 */
  await saveChannel({
    id: 'ch-y', name: '渠道 Y', protocol: 'openai', baseUrl: 'https://y.example.com',
    models: [{ id: 'v-1', label: 'v', caps: ['video'] }],
  })
  const g2 = await call('GET', '/api/ecom-workbench/model-defaults')
  check('★ 默认指着的渠道在 → broken 里没有 video', g2.json?.broken?.video === undefined,
    JSON.stringify(g2.json?.broken))
  const p3 = await call('PUT', '/api/ecom-workbench/model-defaults', {
    defaultVideoModel: { channelId: 'ch-never', modelId: 'v-1' },
  })
  check('★ 指向不存在的渠道 → 存得进去（不拦，只是标出来）', p3.code === 200, String(p3.code))
  const g3 = await call('GET', '/api/ecom-workbench/model-defaults')
  check('★★ 下次 GET 时 broken 说出原因', String(g3.json?.broken?.video ?? '').includes('ch-never'),
    String(g3.json?.broken?.video ?? ''))

  /* ── ★ 2026-10-28（票 38）：第三种 broken —— 渠道在、模型也在，但**没这一类能力** ──
   *
   * ## 为什么要补这一条
   *
   * 前面两种 broken 都是「找不到」（渠道没了 / 模型 id 没了）。而真跑之前那道校验
   * （`generate.ts:543-552`）查的是 `model.caps.includes(kind)` —— **找到了但用不了**
   * 是第三种情形，原来会被算成「设好了」（绿字），用户到生成那一刻才失败。
   *
   * 最常见的成因：上游拉回来的模型 `caps` 是空的（`FetchModelsDialog.tsx` 文件头
   * 讲了「上游只说有什么、不说能干什么」），用户直接拿它设默认。
   *
   * 判据分两条，证明的是两件不同的事：
   *   ① 缺能力 → `broken` 里有一句**点名能力**的原因（不是静默通过）；
   *   ② 有那条能力时 → `broken` 里**没有**它（不能因为多算一种原因而误报）。
   * 只验 ① 会做出一个「什么都报坏」的实现；只验 ② 等于没验。 */
  await saveChannel({
    id: 'ch-z', name: '渠道 Z', protocol: 'openai', baseUrl: 'https://z.example.com',
    models: [
      /* 只有 image 能力，却被设成视频默认 —— 这就是「设了但没这个能力」。 */
      { id: 'z-img-only', label: '只出图', caps: ['image'] },
      { id: 'z-ok-video', label: '能出视频', caps: ['video'] },
    ],
  })
  await call('PUT', '/api/ecom-workbench/model-defaults', {
    defaultVideoModel: { channelId: 'ch-z', modelId: 'z-img-only' },
  })
  const g4 = await call('GET', '/api/ecom-workbench/model-defaults')
  const why = String(g4.json?.broken?.video ?? '')
  /* ⚠️ 2026-10-29（票 74）：四类之后 label 是「视频」（不再是「文生视频」）。
   * 锚的仍是「点名类别 + 说清它实际算什么」，只是那个词跟着四类变了。 */
  check('★★★ 设了但模型不属于这一类 → broken 里说清（不再显示成「设好了」）',
    why.includes('不属于') && why.includes('视频'), why === '' ? '（broken.video 是空的）' : why)
  check('★★ 原因里说清了它实际算哪几类（用户能对上渠道那边的标签）',
    why.includes('图片'), why)
  check('★★ 原因里告诉用户去哪改（给它标类型，或换一个模型）',
    why.includes('标') || why.includes('换'), why)
  check('★ 而且这句和「渠道没了」「模型没了」那两句**不一样**（三种原因分得开）',
    !why.includes('已经不在了') && !why.includes('找不到了'), why)

  /* 反面：换成有那条能力的模型 → 不该再报坏。 */
  await call('PUT', '/api/ecom-workbench/model-defaults', {
    defaultVideoModel: { channelId: 'ch-z', modelId: 'z-ok-video' },
  })
  const g5 = await call('GET', '/api/ecom-workbench/model-defaults')
  check('★★★ 换成有这一类能力的模型 → broken 里就没有它了（不误报）',
    g5.json?.broken?.video === undefined, JSON.stringify(g5.json?.broken))
}

/* ── ② storage：GET / PUT，含 400 与恢复默认 ─────────────────────────── */

console.log('② 存储目录 GET / PUT')
{
  const g0 = await call('GET', '/api/ecom-workbench/storage')
  check('★★ GET → 200 + 五格', g0.code === 200 && (g0.json?.dirs?.length ?? 0) === 5,
    String(g0.json?.dirs?.length))
  check('★★ 每格带 key / label / path / isDefault', (g0.json?.dirs ?? []).every(
    d => typeof d.key === 'string' && typeof d.label === 'string'
      && typeof d.path === 'string' && typeof d.isDefault === 'boolean'),
  JSON.stringify(g0.json?.dirs?.[0]))

  /* 相对路径 → 400 + key */
  const bad1 = await call('PUT', '/api/ecom-workbench/storage', { dirs: { artifacts: 'rel/x' } })
  check('★★ 相对路径 → 400', bad1.code === 400, String(bad1.code))
  check('★★ 400 里带 key 指是哪一格', bad1.json?.key === 'artifacts', String(bad1.json?.key))
  check('★★ 那句话是中文字段名', String(bad1.json?.error).includes('产物'), String(bad1.json?.error))

  /* 好路径 → 200 + 热生效 */
  const good = join(process.env.EWB_TEST_HOME, 'disk2', 'art')
  const ok1 = await call('PUT', '/api/ecom-workbench/storage', { dirs: { artifacts: good } })
  check('★★ 好路径 → 200', ok1.code === 200, String(ok1.json?.error))
  check('★★ 回包里 artifacts 那格的 path 变了、isDefault 变 false',
    (ok1.json?.dirs ?? []).find(d => d.key === 'artifacts')?.isDefault === false,
    JSON.stringify((ok1.json?.dirs ?? []).find(d => d.key === 'artifacts')))
  /* 落盘了（重启后还在）。 */
  const raw = JSON.parse(await readFile(join(dataRoot(), 'storage.json'), 'utf8'))
  check('★★ 真落盘（重启后还在）', raw.artifacts === good, JSON.stringify(raw))

  /* 空串 → 恢复默认 */
  const reset = await call('PUT', '/api/ecom-workbench/storage', { dirs: { artifacts: '' } })
  check('★★ 空串 → 200 且回默认', reset.code === 200, String(reset.json?.error))
  check('★★ 回默认后 isDefault 又是 true',
    (reset.json?.dirs ?? []).find(d => d.key === 'artifacts')?.isDefault === true,
    JSON.stringify((reset.json?.dirs ?? []).find(d => d.key === 'artifacts')))
}

/* ── ③ 提示词源：五条路由全调一遍 ───────────────────────────────────── */

console.log('③ 提示词源五条路由（原来一条都没被 HTTP 调过）')
{
  const g0 = await call('GET', '/api/ecom-workbench/prompt-sources/config')
  check('★★ GET → 200 + 五个内置源', g0.code === 200 && (g0.json?.sources?.length ?? 0) === 5,
    String(g0.json?.sources?.length))
  check('★★ 每个都标 builtin:true', (g0.json?.sources ?? []).every(s => s.builtin === true), '')

  /* 加一个自定义源 */
  const add = await call('POST', '/api/ecom-workbench/prompt-sources/config', {
    id: 'my-src', name: '我的源', url: 'https://a.example.com/p.json',
  })
  check('★★ POST → 200 且带上新源', add.code === 200 && (add.json?.sources ?? []).some(s => s.id === 'my-src'),
    String(add.json?.error))
  check('★★ 新源标 builtin:false',
    (add.json?.sources ?? []).find(s => s.id === 'my-src')?.builtin === false, '')

  const dup = await call('POST', '/api/ecom-workbench/prompt-sources/config', {
    id: 'my-src', url: 'https://b.example.com/p.json',
  })
  check('★★ 重复 id → 400', dup.code === 400, String(dup.code))
  check('★ 那句话说明「已经有」', String(dup.json?.error).includes('已经有'), String(dup.json?.error))

  const noUrl = await call('POST', '/api/ecom-workbench/prompt-sources/config', { name: 'x' })
  check('★★ 没地址 → 400', noUrl.code === 400, String(noUrl.code))

  /* 改 */
  const put = await call('PUT', '/api/ecom-workbench/prompt-sources/config/my-src', { name: '改了' })
  check('★★ PUT → 200 且名字变了',
    (put.json?.sources ?? []).find(s => s.id === 'my-src')?.name === '改了', String(put.json?.error))

  /* 停用内置 */
  const off = await call('PUT', '/api/ecom-workbench/prompt-sources/config/awesome-gpt-image',
    { enabled: false })
  check('★★ 内置能停用（PUT）', off.code === 200
    && (off.json?.sources ?? []).find(s => s.id === 'awesome-gpt-image')?.enabled === false,
  String(off.json?.error))
  check('★★ 停用后仍在清单里（不是消失）', (off.json?.sources ?? []).length === 6,
    String((off.json?.sources ?? []).length))

  /* 删内置 → 409 */
  const delBuiltin = await call('DELETE', '/api/ecom-workbench/prompt-sources/config/awesome-gpt-image')
  check('★★ 删内置 → HTTP 409（不是 404/400）', delBuiltin.code === 409, String(delBuiltin.code))
  check('★★ 409 里带 builtin:true（界面据此显示「只能停用」）',
    delBuiltin.json?.builtin === true, String(delBuiltin.json?.builtin))
  check('★★ 那句话说了「删不掉」与「停用」',
    String(delBuiltin.json?.error).includes('删不掉')
    && String(delBuiltin.json?.error).includes('停用'), String(delBuiltin.json?.error))

  /* 删自己的 → 200 */
  const delMine = await call('DELETE', '/api/ecom-workbench/prompt-sources/config/my-src')
  check('★★ 删自定义源 → 200', delMine.code === 200, String(delMine.json?.error))
  check('★★ 删完清单里没了', !(delMine.json?.sources ?? []).some(s => s.id === 'my-src'), '')

  const delMiss = await call('DELETE', '/api/ecom-workbench/prompt-sources/config/never-exist')
  check('★★ 删不存在的 → 404', delMiss.code === 404, String(delMiss.code))

  /* ── 测连通：**不真联网**（2026-10-27 修，下面这段注释是完整原因）──
   *
   * ## 这句话原来是假的
   *
   * 注释原先写「不真联网：把内置源地址指到一个假主机」—— **其实没有那段桩**。
   * 路由那条调用没给探针传 fetch：`src/index.ts:1948` 是 `await probeSource(id)`，
   * 而 `probeSource`（`prompt-source-config.ts:316`）的第二个参数是可选的，
   * `:322` 写 `const impl = doFetch ?? fetch` —— 没传就退回全局。
   * 于是它真的去拉 `https://raw.githubusercontent.com/…/awesome-gpt-image.json`。
   *
   * ⚠️ 缺口在路由层没有注入点，不是函数层没有参数。这两句差的不是措辞，
   *    是「该改哪一层」。写错方向会让人去改一个本来就对的签名。
   *
   * ## 后果（被耗时看门狗抓到的）
   *
   * | 网络状况 | 这一条要多久 |
   * |---|---|
   * | 通（当初量的时候） | 648ms |
   * | **不通 / 墙 / DNS 慢** | **32,073ms**（2026-10-27 实测） |
   *
   * 整份 `config-routes` 因此从 720ms 变成 32 秒 —— 5 秒看门狗立刻红了。
   * 这正是那条看门狗存在的意义：**它替我们抓到了「测试偷偷依赖外网」这件事。**
   *
   * ## 修法：**只在这一条调用前后**换 `fetch`，别的一律不碰
   *
   * 换全局 `fetch` 是最省事的做法，但会误伤下面 ④ 段那条
   * `127.0.0.1:1` 的真连用例（它要验「真连不上 → unreachable」）。
   * 所以用 `withStubbedFetch`：只在回调期间生效，`finally` 里还原。
   *
   * ⚠️ **判据强度一点没降**：这条验的是「probe 这条路走得通、回包带 ok 与 url、
   * 而且它真的发了请求（要么 count 要么 error）」。桩返回的是一份像样的上游 JSON，
   * 所以 `ok:true` 与 `count` 都能验到，比原来「靠真连失败」覆盖得更多。 */
  const probe = await withStubbedFetch(async () => {
    return await call('POST',
      '/api/ecom-workbench/prompt-sources/config/awesome-gpt-image/probe')
  })
  check('★★ probe → 200（失败也回 200，那是「测试结果」不是「接口坏了」）', probe.code === 200,
    String(probe.code))
  check('★★ probe 回包里带 ok 与 url（排查要看地址）',
    typeof probe.json?.ok === 'boolean' && typeof probe.json?.url === 'string',
    JSON.stringify({ ok: probe.json?.ok, url: probe.json?.url }))
  check('★ 而且它真发了请求（要么有 count，要么有 error）',
    typeof probe.json?.count === 'number' || typeof probe.json?.error === 'string',
    JSON.stringify({ count: probe.json?.count, error: String(probe.json?.error ?? '').slice(0, 40) }))
}

/* ── ④ 拉模型：渠道不存在 / 没填地址 / ComfyUI 没给 kind ─────────────── */

console.log('④ 拉模型三条边界（真发请求那条由 model-fetch.mjs 验）')
{
  const miss = await call('GET', '/api/ecom-workbench/channels/never-exist/models')
  check('★★ 渠道不存在 → 404', miss.code === 404, String(miss.code))

  await saveChannel({
    id: 'ch-noaddr', name: '没地址', protocol: 'openai', baseUrl: '',
    models: [],
  }).catch(() => null) /* 空地址会被 normalizeChannel 拦，存不进去就跳过 */
  /* 存一条地址是占位符的（连不上），验四种失败里那种能真走到。 */
  await saveChannel({
    id: 'ch-badaddr', name: '坏地址', protocol: 'openai', baseUrl: 'http://127.0.0.1:1',
    models: [],
  })
  const un = await call('GET', '/api/ecom-workbench/channels/ch-badaddr/models')
  check('★★ 连不上 → 仍是 HTTP 200（那是「拉取结果」不是「接口坏了」）', un.code === 200, String(un.code))
  check('★★ ok:false 且 kind=unreachable', un.json?.ok === false && un.json?.kind === 'unreachable',
    JSON.stringify({ ok: un.json?.ok, kind: un.json?.kind }))
  check('★★ 回包里带 url（排查必看）', typeof un.json?.url === 'string', String(un.json?.url))

  await saveChannel({
    id: 'ch-comfy', name: '本地', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:1',
    models: [],
  })
  const noKind = await call('GET', '/api/ecom-workbench/channels/ch-comfy/models')
  check('★★ ComfyUI 不给 kind → kind=no-endpoint 且说要哪一类',
    noKind.json?.kind === 'no-endpoint' && String(noKind.json?.error).includes('哪一类'),
    String(noKind.json?.error))
  const withKind = await call('GET', '/api/ecom-workbench/channels/ch-comfy/models?kind=vae')
  check('★★ 给了 kind 就走对应路径（连不上 → unreachable）',
    withKind.json?.kind === 'unreachable', String(withKind.json?.kind))
  check('★★ 而且 url 里是 /api/experiment/models/vae',
    String(withKind.json?.url ?? '').endsWith('/api/experiment/models/vae'), String(withKind.json?.url))
}

/* ── ⑤ 渠道模型四种形状（HTTP 层） ─────────────────────────────────── */

console.log('⑤ 渠道模型的四种形状（HTTP 层）')
{
  const strArr = await call('POST', '/api/ecom-workbench/channels', {
    id: 'ch-s1', protocol: 'openai', baseUrl: 'https://a.example.com',
    models: ['gpt-image-1|GPT Image|image,video'],
  })
  check('★★ 字符串数组 → 200 且拆成三段',
    strArr.code === 200 && strArr.json?.channel?.models?.[0]?.id === 'gpt-image-1', String(strArr.json?.error))

  const objArr = await call('POST', '/api/ecom-workbench/channels', {
    id: 'ch-s2', protocol: 'openai', baseUrl: 'https://b.example.com',
    models: [{ id: 'o-1', label: '对象', caps: ['image'] }],
  })
  check('★★ 对象数组 → 200', objArr.code === 200 && objArr.json?.channel?.models?.[0]?.label === '对象', '')

  const mixed = await call('POST', '/api/ecom-workbench/channels', {
    id: 'ch-s3', protocol: 'openai', baseUrl: 'https://c.example.com',
    models: ['a|甲|image', { id: 'b', label: '乙', caps: ['video'] }],
  })
  check('★★ 混着 → 200 且两个都收', (mixed.json?.channel?.models ?? []).length === 2, '')

  const text = await call('POST', '/api/ecom-workbench/channels', {
    id: 'ch-s4', protocol: 'openai', baseUrl: 'https://d.example.com',
    models: 'x|一|image\ny|二|video',
  })
  check('★★ 整段多行文本 → 200 且按行拆开', (text.json?.channel?.models ?? []).length === 2, '')
}

/* ── ⑥ 跨层：配置改完之后，**消费方真的读了没有** ─────────────────────
 *
 * 这一组是 2026-10-26 自查补的。前五组只验「路由通不通」，而当时抓出的三个缺口
 * 全是同一类病：**路由通了、消费方没读配置**。所以这一组必须穿过两层：
 *
 *   配置写盘（PUT / POST） → 消费方真的按它变了（GET /prompt-sources、/content/dirs）
 *
 * 判据不能只问函数（`listSources()` 绿着也可能没人调它）—— 所以这里一律走 HTTP。 */

console.log('')
console.log('⑥ 跨层：改配置之后消费方真的读了')

console.log('⑥-1 存储目录：改完「重启」再套一次，仍是新目录')
{
  const target = join(process.env.EWB_TEST_HOME, 'cross', 'art2')
  const put = await call('PUT', '/api/ecom-workbench/storage', { artifacts: target })
  check('★★ PUT 存下新产物目录 → 200', put.code === 200, String(put.json?.error))

  const nowDirs = await call('GET', '/api/ecom-workbench/content/dirs')
  check('★★ 当场生效（热生效那条没坏）', nowDirs.json?.artifacts === target, String(nowDirs.json?.artifacts))

  /* 模拟「重启」：内存里的覆盖表清空（进程内存没了），盘上的 storage.json 还在。 */
  const { setDirOverrides } = await import('../src/schedule/artifacts.ts')
  setDirOverrides({})
  const afterClear = await call('GET', '/api/ecom-workbench/content/dirs')
  check('★ 清空覆盖后确实回到默认（确认这一步真清掉了）',
    afterClear.json?.artifacts !== target, String(afterClear.json?.artifacts))

  /* 跑一遍**真正的启动流程**（不是手动调那个函数）—— 这是本条判据的核心。 */
  apply({
    inject(names, fn) {
      if (names.includes('webServer')) fn({ webServer: { register(r) { handler = r.handler } } })
      if (names.includes('subprocess')) fn({ subprocess: { spawn: () => ({ terminate() {}, waitForExit: async () => true }) } })
    },
    effect() { return () => { /* 清理 */ } },
  })
  /* `apply` 里那次套用是后台跑的（同步签名不能 await），等它落地。 */
  let landed = false
  for (let i = 0; i < 40 && !landed; i += 1) {
    const got = await call('GET', '/api/ecom-workbench/content/dirs')
    if (got.json?.artifacts === target) landed = true
    else await new Promise(r => setTimeout(r, 25))
  }
  check('★★ **重启后（重跑启动流程）目录配置还在**（不是回默认）', landed, String(landed))
}

console.log('')
console.log('⑥-2 停用一个源 → 提示词库里就没有它')
{
  const before = await call('GET', '/api/ecom-workbench/prompt-sources')
  const idsBefore = (before.json?.sources ?? []).map(s => s.id)
  const victim = idsBefore[0]
  check('★ 先确认它在清单里（否则这条测不出东西）', victim !== undefined, String(victim))

  const off = await call('PUT', '/api/ecom-workbench/prompt-sources/config/' + victim, { enabled: false })
  check('★ 停用 → 200', off.code === 200, String(off.json?.error))

  const after = await call('GET', '/api/ecom-workbench/prompt-sources')
  const idsAfter = (after.json?.sources ?? []).map(s => s.id)
  check('★★ **停用后提示词库里没有它**', !idsAfter.includes(victim), idsAfter.join(','))
  check('★ 其余源还在（不是整份清空）', idsAfter.length === idsBefore.length - 1,
    String(idsAfter.length) + ' / ' + String(idsBefore.length))

  /* 单条读取那条路也不能例外 —— 清单里没有了，按 id 直接取也该说清「已停用」。 */
  const one = await call('GET', '/api/ecom-workbench/prompt-sources/' + victim)
  check('★★ 按 id 直接取 → 404 且说清是「已停用」（不是「没有这个源」）',
    one.code === 404 && one.json?.disabled === true && String(one.json?.error).includes('已停用'),
    String(one.json?.error))

  const r = await call('POST', '/api/ecom-workbench/prompt-sources/' + victim + '/refresh')
  check('★★ 停用的源也不许拉（拉了会写出一份清单里看不到的缓存）',
    r.json?.ok === false && String(r.json?.error).includes('已停用'), String(r.json?.error))

  await call('PUT', '/api/ecom-workbench/prompt-sources/config/' + victim, { enabled: true })
}

console.log('')
console.log('⑥-3 用户自己加的源 → 提示词库里有它')
{
  const add = await call('POST', '/api/ecom-workbench/prompt-sources/config', {
    id: 'my-own-src', name: '我自己的源', url: 'https://example.com/prompts.json',
  })
  check('★★ 加一个自定义源 → 200', add.code === 200, String(add.json?.error))

  const list = await call('GET', '/api/ecom-workbench/prompt-sources')
  const mine = (list.json?.sources ?? []).find(s => s.id === 'my-own-src')
  check('★★ **自定义源出现在提示词库里**（旧写法只遍历内置五个，它永远看不到）',
    mine !== undefined, (list.json?.sources ?? []).map(s => s.id).join(','))
  check('★★ 名字用用户给的（不是 id）', mine?.name === '我自己的源', String(mine?.name))
  check('★★ 标出它不是内置的（界面据此决定显不显示「删除」）', mine?.builtin === false, String(mine?.builtin))
  check('★ 还没拉过 → from 是 custom（不是 builtin：它没有内置副本）',
    mine?.from === 'custom', String(mine?.from))

  const one = await call('GET', '/api/ecom-workbench/prompt-sources/my-own-src')
  check('★★ 单条也能读到（不再走「内置里没查着就 404」那条）',
    one.code === 200 && one.json?.from === 'custom', String(one.json?.error ?? one.json?.from))
  check('★ 单条里说清了「还没内容」这件事', String(one.json?.note).includes('还没有内容'),
    String(one.json?.note))
}

console.log('')
console.log('⑥-4 全部停用 → 空态要有话说')
{
  const all = await call('GET', '/api/ecom-workbench/prompt-sources')
  for (const s of all.json?.sources ?? []) {
    await call('PUT', '/api/ecom-workbench/prompt-sources/config/' + s.id, { enabled: false })
  }
  /* 自定义源没有「停用」这个状态（存在即启用），只能删。 */
  await call('DELETE', '/api/ecom-workbench/prompt-sources/config/my-own-src')

  const empty = await call('GET', '/api/ecom-workbench/prompt-sources')
  check('★★ 全停用后清单是空的', (empty.json?.sources ?? []).length === 0,
    JSON.stringify((empty.json?.sources ?? []).map(s => s.id)))
  check('★★ **空态带一句话**（一片空白看着像坏了）',
    typeof empty.json?.emptyNote === 'string' && empty.json.emptyNote.length > 0,
    String(empty.json?.emptyNote))
  check('★ 那句话说了怎么办（提到「启用」）', String(empty.json?.emptyNote).includes('启用'),
    String(empty.json?.emptyNote))
  check('★ 空的时候不硬塞一个空的 emptyNote 以外的假条目', empty.json?.ok === true, String(empty.json?.ok))
}

console.log('')
console.log('⑥-5 源地址改过 → 旧缓存不再冒充「现在的缓存」')
/* 票 26。判据穿两层：配置改地址（PUT）→ 读路径说实话（GET 单条 / 清单）。
 *
 * 为什么这一组必须有：`readSource` 原来拿到缓存就返回，从不看缓存里那个 `url`。
 * 用户把地址从 A 改成 B 之后，提示词库照旧给 A 的内容，note 只说「X 时间拉下来的缓存」——
 * 界面上一句「改过地址要再点一次刷新」就是在这件事上打补丁。
 *
 * 4 条判据对应票面 1~4：
 *   ① 地址相同 → 正常缓存 `from:'cache'`
 *   ② 地址不同 → 不许还是 `from:'cache'`
 *   ③ note 里说清「地址改过」，不许含糊成「旧缓存」
 *   ④ 改回原地址 → 旧缓存又能用（不是一律作废）
 *
 * 桩要给出带 `id` 的条目：`refreshSource` 会丢掉缺 `id` 或 `prompt` 的条目，
 * 只给 title/prompt 的话会走成「一条都不符合形状」。 */
async function withEntriesFetch(entries, fn) {
  const real = globalThis.fetch
  globalThis.fetch = async (u) => ({
    ok: true,
    status: 200,
    url: String(u),
    json: async () => entries,
    text: async () => JSON.stringify(entries),
  })
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

{
  const URL_A = 'https://a.example.com/prompts.json'
  const URL_B = 'https://b.example.com/prompts.json'
  const body = [{ id: 'e1', prompt: 'p1' }, { id: 'e2', prompt: 'p2' }]

  /* ── 自定义源（没有内置副本 → 走乙：留旧内容但说实话）── */
  const add = await call('POST', '/api/ecom-workbench/prompt-sources/config', {
    id: 'stale-src', name: '会改地址的源', url: URL_A,
  })
  check('★ 先造一个自定义源（否则测不出东西）', add.code === 200, String(add.json?.error))
  const refreshed = await withEntriesFetch(body, async () =>
    await call('POST', '/api/ecom-workbench/prompt-sources/stale-src/refresh'))
  check('★ 拉一次落进缓存', refreshed.json?.ok === true && refreshed.json?.result?.count === 2,
    JSON.stringify({ ok: refreshed.json?.ok, count: refreshed.json?.result?.count, error: refreshed.json?.error }))

  const same = await call('GET', '/api/ecom-workbench/prompt-sources/stale-src')
  check('① 缓存地址与配置地址相同 → from 仍是 cache', same.json?.from === 'cache', String(same.json?.from))
  check('① 而且内容就是刚拉的那两条', same.json?.source?.count === 2, String(same.json?.source?.count))

  const moved = await call('PUT', '/api/ecom-workbench/prompt-sources/config/stale-src', { url: URL_B })
  check('★ 改地址 → 200', moved.code === 200, String(moved.json?.error))

  const afterMove = await call('GET', '/api/ecom-workbench/prompt-sources/stale-src')
  check('② 地址改过 → 不许还是 from:cache（它此刻不代表新地址的内容）',
    afterMove.json?.from !== 'cache', String(afterMove.json?.from))
  check('③ note 说清了「地址改过」这件事，不是含糊的「旧缓存」',
    String(afterMove.json?.note).includes('地址改过') && String(afterMove.json?.note).includes('旧地址'),
    String(afterMove.json?.note))
  check('③ note 里给了下一步（提到「刷新」）', String(afterMove.json?.note).includes('刷新'),
    String(afterMove.json?.note))
  check('★ 自定义源没有内置副本可回落 → 内容仍留着（不是变空清单）',
    afterMove.json?.source?.count === 2, String(afterMove.json?.source?.count))

  const listStale = await call('GET', '/api/ecom-workbench/prompt-sources')
  const mineStale = (listStale.json?.sources ?? []).find(s => s.id === 'stale-src')
  check('② 清单里那一条也不再标成 cache（单条说实话、清单照旧就是同一个谎换个地方）',
    mineStale?.from !== 'cache', String(mineStale?.from))

  const back = await call('PUT', '/api/ecom-workbench/prompt-sources/config/stale-src', { url: URL_A })
  check('★ 改回原地址 → 200', back.code === 200, String(back.json?.error))
  const restored = await call('GET', '/api/ecom-workbench/prompt-sources/stale-src')
  check('④ 改回原地址后旧缓存又能正常用（不是一律作废）',
    restored.json?.from === 'cache' && restored.json?.source?.count === 2,
    JSON.stringify({ from: restored.json?.from, count: restored.json?.source?.count }))
  check('④ 而且 note 回到平常那句（不再说地址改过）',
    !String(restored.json?.note).includes('地址改过'), String(restored.json?.note))

  /* ── 内置源（有内置副本 → 走甲：回落内置并说清）── */
  const B_IN = 'awesome-gpt-image'
  /* ⑥-4 那一组把所有源都停用过，这里先启用回来 —— 不启用的话读路径直接给 null，
   * 下面几条会验成 undefined，而不是「有没有说清楚」。 */
  const reOn = await call('PUT', '/api/ecom-workbench/prompt-sources/config/' + B_IN, { enabled: true })
  check('★ 先把内置源启用回来（⑥-4 全停用过）', reOn.code === 200, String(reOn.json?.error))
  const fetched = await withEntriesFetch(body, async () =>
    await call('POST', '/api/ecom-workbench/prompt-sources/' + B_IN + '/refresh'))
  check('★ 内置源也拉一份缓存', fetched.json?.ok === true, String(fetched.json?.error))
  const cfg1 = await call('GET', '/api/ecom-workbench/prompt-sources/config')
  const originUrl = (cfg1.json?.sources ?? []).find(s => s.id === B_IN)?.url ?? ''
  check('★ 记下内置源原地址（改完要还原）', originUrl !== '', originUrl)

  const beforeMove = await call('GET', '/api/ecom-workbench/prompt-sources/' + B_IN)
  check('★ 改地址之前它确实是 from:cache（否则下面第 ② 条测不出东西）',
    beforeMove.json?.from === 'cache', String(beforeMove.json?.from))

  const movedIn = await call('PUT', '/api/ecom-workbench/prompt-sources/config/' + B_IN, { url: URL_B })
  check('★ 改内置源地址 → 200', movedIn.code === 200, String(movedIn.json?.error))
  const afterIn = await call('GET', '/api/ecom-workbench/prompt-sources/' + B_IN)
  check('② 内置源地址改过 → 不许还是 from:cache', afterIn.json?.from !== 'cache', String(afterIn.json?.from))
  check('③ 内置源这条回落成内置副本（有可回落的东西就别拿旧内容充数）',
    afterIn.json?.from === 'builtin', String(afterIn.json?.from))
  check('③ note 里同时说了「地址改过」与「内置副本」',
    String(afterIn.json?.note).includes('地址改过') && String(afterIn.json?.note).includes('内置副本'),
    String(afterIn.json?.note))

  const restoreIn = await call('PUT', '/api/ecom-workbench/prompt-sources/config/' + B_IN, { url: originUrl })
  check('★ 内置源地址还原 → 200', restoreIn.code === 200, String(restoreIn.json?.error))
  const backIn = await call('GET', '/api/ecom-workbench/prompt-sources/' + B_IN)
  check('④ 还原后内置源的缓存又能正常用', backIn.json?.from === 'cache', String(backIn.json?.from))

  await call('DELETE', '/api/ecom-workbench/prompt-sources/config/stale-src')
}

console.log('')
console.log('⑦ 三份文件头写清了「这些 export 只为单测」')
/* 这一段的判据是**注释本身**，所以只能读源码，不能调函数。
 *
 * 为什么值得钉住：那批 export 生产代码不直接调，`grep` 调用方是零。
 * 下一个人（或下一次自查）看到「零调用点」的第一反应就是「漏接线，去接上」——
 * 这正是 §五 记下的那类坑。文件头那句话是把「有意的」写在最显眼处，
 * 断言钉住它，是防止某次「顺手清理未使用 export」把它连人带话一起删掉。
 *
 * 只锚「段标题 + 本文件那几个 export 名同段出现」，不锚整段措辞 ——
 * 措辞可以改，但「指得出是哪几个」这条不许退化成一句「这些 export」。 */
async function exportNote(file) {
  const src = await readFile(new URL('../src/schedule/' + file, import.meta.url), 'utf8')
  const at = src.indexOf('## 关于 `export`')
  if (at === -1) return { found: false, section: '' }
  /* 取到下一个同级标题（`## `）或那个注释块的结束标记为止。 */
  const rest = src.slice(at + 3)
  const nextHead = rest.indexOf('\n * ## ')
  const close = rest.indexOf('\n */')
  const end = [nextHead, close].filter(i => i !== -1).sort((a, b) => a - b)[0]
  return { found: true, section: end === undefined ? rest : rest.slice(0, end) }
}

for (const [file, names] of [
  ['model-fetch.ts', ['comfyModelsUrl', 'openAiModelsUrl', 'geminiModelsUrl', 'parseModelsResponse']],
  ['model-defaults.ts', ['asModelRef', 'normalizeDefaults']],
  ['storage-config.ts', ['checkDir', 'effectiveDirs']],
]) {
  const { found, section } = await exportNote(file)
  check('★★ ' + file + ' 文件头有「关于 export」那段（不是漏接线，是有意的）', found, found ? '' : '没找到那段')
  const missing = names.filter(n => !section.includes(n))
  check('★★ ' + file + ' 那段逐个点了名（' + names.join(' / ') + '）',
    found && missing.length === 0, missing.length === 0 ? '' : '缺：' + missing.join(','))
}

console.log('')
console.log('⑧ 配置五块各说清了「改完什么时候生效」')
/* 判据是**文案本身**，所以读源码。
 *
 * 为什么值得钉住：这五块的生效方式真的不同 —— 存储目录是存完立刻进新目录，
 * 默认模型与渠道是下一次生成现读，提示词源改了地址要**再刷新一次**内容才会跟着走，
 * 拉模型那一步只是填进表单、还没存。五句要是写成同一句，至少三句是假话。
 *
 * 自证方式：删掉其中一句 → 对应那条变红。
 * 第二组断言判「五句互不相同」—— 防的是「复制粘贴同一句」这种退化。 */
const WHEN = [
  ['StorageSettings.tsx', '存储目录', '立刻生效，不用重启'],
  ['DefaultsSettings.tsx', '默认模型', '下一次生成就按这里选的那条走'],
  ['ChannelSettings.tsx', '渠道', '下一次生成就按新的地址与并发上限走'],
  ['PromptSourcesSettings.tsx', '提示词源', '旧内容仍按旧地址算，点一次「刷新」才会按新地址拉下来'],
  ['FetchModelsDialog.tsx', '拉取模型', '回到表单点一次「保存」才算配好'],
]
const whenTexts = []
for (const [file, name, phrase] of WHEN) {
  const src = await readFile(new URL('../src/client/workbench/' + file, import.meta.url), 'utf8')
  const ok = src.includes(phrase)
  if (ok) whenTexts.push({ file, name, phrase })
  check('★★ ' + file + '（' + name + '）写清了什么时候生效', ok, ok ? phrase : '没找到：' + phrase)
}
const dup = whenTexts.filter((a, i) => whenTexts.findIndex(b => b.phrase === a.phrase) !== i)
check('★★ 五块的生效说明不是同一句复制粘贴（各块真实行为不同）',
  whenTexts.length === WHEN.length && dup.length === 0,
  whenTexts.length !== WHEN.length
    ? '凑不齐 ' + String(WHEN.length) + ' 句，只有 ' + String(whenTexts.length) + ' 句'
    : dup.length === 0 ? '' : '重复：' + dup.map(d => d.name).join(','))

console.log('')
/* ⏱ 耗时看门狗（用户 m03555）。
 *
 * ## 为什么要有这一条
 *
 * 这个文件在 2026-10-26 的一次全量里跑了 29.3 秒，之后稳定在 1.3 秒上下
 * （连跑五次：1.43 / 1.42 / 1.50 / 1.43 / 1.34）。
 *
 * 那次为什么慢，2026-10-27 已查清：`probe` 那一条真的去联网了 ——
 * 路由调用（`src/index.ts:1948`）没给探针传 fetch，探针退回全局那个，
 * 网络不通时卡到 32073ms（真因与修法见文件头）。
 * 已用 `withStubbedFetch()` 只包那一条调用修掉，修完 32389ms → 77ms。
 *
 * ## 这条断言现在的作用
 *
 * 它已经把真身抓到过一次 —— 那次 32 秒就是靠它报出来的，不是靠人翻日志。
 * 以后的作用仍然是：下次它再变慢时自己会说。
 *
 * 5 秒这个上限的定法：现在 0.6~1.5 秒，留数倍余量；
 * 真出现十几二十秒那种情况会立刻红。取「整份」而不是「单次调用」，
 * 因为单次都是几毫秒，累计起来才异常。
 *
 * ## 它红了先看什么
 *
 * 先看是不是又有哪条在真联网：跑一遍、找单条超过 100ms 的那一条，
 * 再看它走的 `fetch` 是不是全局的 —— 桩没包住就是这一类。 */
check('★★ 整份跑完在 5 秒内（曾经抓到一次 32 秒：probe 真联网，已修）',
  Date.now() - startedAt < 5000,
  String(Date.now() - startedAt) + ' ms（上限 5000）')

if (bad === 0) console.log('全部通过 ✓')
else { console.log('有 ' + String(bad) + ' 条不通过 ✗'); process.exitCode = 1 }
