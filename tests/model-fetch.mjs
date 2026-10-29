/** 拉模型清单 + 四类默认模型 + 拉取失败三种原因（2026-10-26，T-B-后端）。
 *
 * # ⚠️ 不连外网
 *
 * 全走注入的假 `fetchImpl`。验的是「三条协议的地址拼对没有、响应解对没有、
 * 失败分得清是哪一种」，**不验**真打一次 OpenAI / ComfyUI / Gemini。
 *
 * 跑法：node scripts/run-tests.mjs model-fetch
 */
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-mfetch-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const {
  fetchChannelModels, comfyModelsUrl, openAiModelsUrl, geminiModelsUrl,
  parseModelsResponse, COMFY_FETCH_KINDS,
} = await import('../src/schedule/model-fetch.ts')
const {
  readModelDefaults, saveModelDefaults, normalizeDefaults, asModelRef,
  defaultOf, defaultStatus, MODEL_DEFAULTS_FILE, DEFAULT_KEYS,
} = await import('../src/schedule/model-defaults.ts')

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

/**
 * 假 fetch：记下每次请求，按脚本回响应。
 * @param {Function} make - `(url) => {status?, body?, raw?, throw?}`。
 * @returns {Function} 假 fetch（带 calls）。
 */
function fakeFetch(make) {
  const calls = []
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: String(init.method ?? 'GET').toUpperCase(), headers: init.headers ?? {} })
    const one = make(String(url)) ?? {}
    if (one.throw !== undefined) throw new Error(one.throw)
    return new Response(one.raw !== undefined ? one.raw : JSON.stringify(one.body ?? {}), {
      status: one.status ?? 200,
      headers: { 'content-type': 'application/json', ...one.headers ?? {} },
    })
  }
  impl.calls = calls
  return impl
}

/* ── ① 地址拼装（三条协议各一条） ───────────────────────────────────── */

console.log('① 三条协议的地址各自拼对')
{
  check('★★ ComfyUI 的 diffusion 走上 /api/experiment/models/diffusion_models（不是自己拼 diffusion）',
    comfyModelsUrl('http://127.0.0.1:8188', 'diffusion') === 'http://127.0.0.1:8188/api/experiment/models/diffusion_models',
    comfyModelsUrl('http://127.0.0.1:8188', 'diffusion'))
  check('★★ ComfyUI 的 text_encoder 走 text_encoders（界面叫 clip、接口叫 text_encoders，两头名字不同）',
    comfyModelsUrl('http://x:1', 'text_encoder') === 'http://x:1/api/experiment/models/text_encoders',
    comfyModelsUrl('http://x:1', 'text_encoder'))
  check('★★ ComfyUI 的 checkpoint / vae 各自对',
    comfyModelsUrl('http://x:1', 'checkpoint').endsWith('/checkpoints')
    && comfyModelsUrl('http://x:1', 'vae').endsWith('/vae'),
    comfyModelsUrl('http://x:1', 'checkpoint') + ' / ' + comfyModelsUrl('http://x:1', 'vae'))
  check('★ 尾斜杠不会拼出双斜杠', comfyModelsUrl('http://x:1///', 'vae') === 'http://x:1/api/experiment/models/vae',
    comfyModelsUrl('http://x:1///', 'vae'))

  check('★★ OpenAI 的地址走 /v1/models', openAiModelsUrl('https://api.example.com') === 'https://api.example.com/v1/models',
    openAiModelsUrl('https://api.example.com'))
  check('★★ 地址已经带 /v1 时不重复加（用户的填法不统一）',
    openAiModelsUrl('https://api.example.com/v1') === 'https://api.example.com/v1/models',
    openAiModelsUrl('https://api.example.com/v1'))
  check('★★ Gemini 的地址走 /v1beta/models',
    geminiModelsUrl('https://g.example.com') === 'https://g.example.com/v1beta/models',
    geminiModelsUrl('https://g.example.com'))
}

/* ── ② 响应解析（三条协议各一条） ───────────────────────────────────── */

console.log('② 三种响应各自解对')
{
  const oa = parseModelsResponse('openai', {
    object: 'list',
    data: [{ id: 'gpt-image-1', object: 'model' }, { id: 'gpt-4o-mini', object: 'model' }],
  })
  check('★★ OpenAI：取出两个 id', oa.length === 2 && oa[0].id === 'gpt-image-1', JSON.stringify(oa.map(m => m.id)))
  check('★ 没有 displayName 时 label 退回 id', oa[0].label === 'gpt-image-1', oa[0].label)

  const gem = parseModelsResponse('gemini', {
    models: [
      { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' },
      { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
    ],
  })
  check('★★ Gemini：去掉 models/ 前缀（不去的话生成请求会变成 models/models/xxx → 必然 404）',
    gem[0].id === 'gemini-2.5-flash', gem[0].id)
  check('★ Gemini：displayName 当 label', gem[0].label === 'Gemini 2.5 Flash', gem[0].label)

  const comfy = parseModelsResponse('comfyui', [{ name: 'flux1-dev.safetensors' }, { filename: 'sd3.safetensors' }])
  check('★★ ComfyUI：name 与 filename 两种键名都认', comfy.length === 2,
    JSON.stringify(comfy.map(m => m.id)))

  check('★ 垃圾输入给空数组，不抛', parseModelsResponse('openai', null).length === 0
    && parseModelsResponse('gemini', 'x').length === 0)
  check('★★ 条目里 id 为空的跳过（不产生一个空模型）',
    parseModelsResponse('openai', { data: [{ id: '' }, { id: 'a' }] }).length === 1, '')
}

/* ── ③ 拉取成功：三条协议各真走一遍 ─────────────────────────────────── */

console.log('③ 三条协议各拉一次（假 HTTP 截获）')
{
  const ch = { id: 'c1', protocol: 'openai', baseUrl: 'https://api.example.com' }
  const f = fakeFetch(() => ({ body: { data: [{ id: 'img-1' }, { id: 'img-2' }] } }))
  const r = await fetchChannelModels(ch, 'sk-test', undefined, { fetchImpl: f })
  check('★★ OpenAI 拉到了两个', r.ok && r.models.length === 2, JSON.stringify(r.models.map(m => m.id)))
  check('★★ 请求带了 Bearer 密钥', String(f.calls[0].headers.authorization ?? '').includes('sk-test'),
    String(f.calls[0].headers.authorization))
  check('★★ 请求打的是 /v1/models', f.calls[0].url.endsWith('/v1/models'), f.calls[0].url)

  const fg = fakeFetch(() => ({ body: { models: [{ name: 'models/gem' }] } }))
  const rg = await fetchChannelModels({ id: 'c2', protocol: 'gemini', baseUrl: 'https://g.example.com' },
    'k-gem', undefined, { fetchImpl: fg })
  check('★★ Gemini 拉到 1 个', rg.ok && rg.models.length === 1, JSON.stringify(rg.models.map(m => m.id)))
  check('★★ Gemini 的密钥走 x-goog-api-key（不走 Bearer）',
    fg.calls[0].headers['x-goog-api-key'] === 'k-gem' && fg.calls[0].headers.authorization === undefined,
    JSON.stringify(Object.keys(fg.calls[0].headers)))

  const fc = fakeFetch(() => ({ body: [{ name: 'flux1-dev.safetensors' }] }))
  const rc = await fetchChannelModels({ id: 'c3', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188' },
    '', 'diffusion', { fetchImpl: fc })
  check('★★ ComfyUI 拉到 1 个', rc.ok && rc.models.length === 1, JSON.stringify(rc.models.map(m => m.id)))
  check('★★ ComfyUI 没给密钥时**不带** authorization（它一般不要密钥）',
    fc.calls[0].headers.authorization === undefined, JSON.stringify(fc.calls[0].headers))
  check('★★ ComfyUI 没说要哪一类时明确要求（不是随便拉一类）',
    (await fetchChannelModels({ id: 'c3', protocol: 'comfyui', baseUrl: 'http://x:1' }, '', undefined,
      { fetchImpl: fc })).kind === 'no-endpoint',
    String((await fetchChannelModels({ id: 'c3', protocol: 'comfyui', baseUrl: 'http://x:1' }, '', undefined, { fetchImpl: fc })).error))
}

/* ── ④ 失败三种原因分开说（这是用户点名的那条） ─────────────────────── */

console.log('④ 拉取失败：三种原因分开说，不许静默空列表')
{
  const base = { id: 'c', protocol: 'openai', baseUrl: 'https://api.example.com' }

  /* ① 连不上（地址写错 / 服务没起） */
  const un = await fetchChannelModels(base, 'k', undefined, {
    fetchImpl: fakeFetch(() => ({ throw: 'getaddrinfo ENOTFOUND api.example.com' })),
  })
  check('★★ 连不上 → kind=unreachable', un.ok === false && un.kind === 'unreachable', String(un.kind))
  check('★★ 连不上的话里说「地址写错 / 端口没开 / 服务没起」+ 带上原文',
    String(un.error).includes('连不上') && String(un.error).includes('ENOTFOUND'), String(un.error))
  check('★★ 连不上时**不是**空列表当成功', un.ok === false && un.models.length === 0, String(un.ok))

  /* ② 密钥不对（401 / 403） */
  const au = await fetchChannelModels(base, 'bad', undefined, { fetchImpl: fakeFetch(() => ({ status: 401 })) })
  check('★★ 401 → kind=auth', au.ok === false && au.kind === 'auth', String(au.kind))
  check('★★ 密钥那条话说「检查密钥填了没有 / 过期没有」',
    String(au.error).includes('密钥'), String(au.error))
  const fo = await fetchChannelModels(base, 'bad', undefined, { fetchImpl: fakeFetch(() => ({ status: 403 })) })
  check('★ 403 也算 auth（不是就漏了）', fo.kind === 'auth', String(fo.kind))

  /* ③ 地址通了但没有这个接口（404 / 405） */
  const ne = await fetchChannelModels(base, 'k', undefined, { fetchImpl: fakeFetch(() => ({ status: 404 })) })
  check('★★ 404 → kind=no-endpoint', ne.ok === false && ne.kind === 'no-endpoint', String(ne.kind))
  check('★★ 接口那条话说「地址能连上，但不是这个协议的接口」——与「连不上」必须分开',
    String(ne.error).includes('没有列模型的接口') && String(ne.error).includes('协议'), String(ne.error))
  const me = await fetchChannelModels(base, 'k', undefined, { fetchImpl: fakeFetch(() => ({ status: 405 })) })
  check('★ 405 也算 no-endpoint', me.kind === 'no-endpoint', String(me.kind))

  /* ④ 上游自己报错：把它的话带回去 */
  const up = await fetchChannelModels(base, 'k', undefined, {
    fetchImpl: fakeFetch(() => ({ status: 500, raw: 'internal boom' })),
  })
  check('★★ 500 → kind=upstream 且带上游原文', up.kind === 'upstream' && String(up.error).includes('internal boom'),
    String(up.error))

  /* 三种的 kind **必须互不相同** —— 这是「分开说」的真正判据。 */
  const kinds = new Set([un.kind, au.kind, ne.kind, up.kind].filter(Boolean))
  check('★★ 四种失败的 kind 是四个不同的值（真的分开了，不是都叫「失败」）',
    kinds.size === 4, [...kinds].join(','))

  /* 空地址：连试都不该试 */
  const noBase = await fetchChannelModels({ id: 'c', protocol: 'openai', baseUrl: '' }, 'k', undefined,
    { fetchImpl: fakeFetch(() => ({ body: {} })) })
  check('★★ 没填地址 → 直接说「先去填地址」，不发请求', noBase.ok === false && String(noBase.error).includes('地址'),
    String(noBase.error))
}

console.log('⑤ 拉到了但是空的：说清「这是真的空」，不当失败')
{
  const f = fakeFetch(() => ({ body: [{ }] }))
  const r = await fetchChannelModels({ id: 'c', protocol: 'comfyui', baseUrl: 'http://x:1' }, '', 'vae',
    { fetchImpl: f })
  check('★★ ComfyUI 这一类一个都没有 → ok:true（不是失败）', r.ok === true, String(r.ok))
  check('★★ 但要说明「这一类一个模型都没有」', String(r.error).includes('一个模型都没有'), String(r.error))
  check('★ COMFY_FETCH_KINDS 是四类', COMFY_FETCH_KINDS.join(',') === 'diffusion,text_encoder,checkpoint,vae',
    COMFY_FETCH_KINDS.join(','))
}

/* ── ⑥ 四类默认模型：读写与判据 ─────────────────────────────────────── */

/* ⚠️ **2026-10-29（票 74）从五类退回四类**：`t2i` / `i2i` 合回 `image`，
 * 键名回到 `defaultImageModel`。
 *
 * 这一段前几天刚被票 67 从四类改成五类、今天又被票 74 改回四类。两次都不是
 * 「放宽判据」，是**判据的对象变了**：键名与类数由 `DEFAULT_KEYS` / `MODEL_TYPES`
 * 决定，源码改了而断言不改，验的就是一个不存在的东西。
 *
 * ⚠️ **票 67 那两个键的兼容读要留着**（`LEGACY_KEYS`：`defaultT2IModel` /
 * `defaultI2IModel` 都映射到 `image`）。那两天可能已经有人设过，静默丢掉
 * 等于「设了等于没设」。下面专门留断言钉住它。 */
console.log('⑥ 三类默认模型（图片 / 视频 / 音频 —— 票 76 去掉文本）')
{
  /* 文件名与键名先钉住 —— 界面要按这些键名发 PUT。 */
  check('★★ 文件名是 model-defaults.json', MODEL_DEFAULTS_FILE === 'model-defaults.json', MODEL_DEFAULTS_FILE)
  /* ⚠️ 2026-10-29（票 76）：三键。`defaultTextModel` 下线（文本统一走 dsh，
   * 渠道里没有那一类了，所以没有「文本默认模型」这回事）。 */
  check('★★★ 三个键名（票 76：defaultTextModel 下线）',
    DEFAULT_KEYS.image === 'defaultImageModel'
    && DEFAULT_KEYS.video === 'defaultVideoModel' && DEFAULT_KEYS.audio === 'defaultAudioModel'
    && Object.keys(DEFAULT_KEYS).length === 3,
    JSON.stringify(DEFAULT_KEYS))

  /* 全新安装：没有文件 → 空对象，不报错 */
  const fresh = await readModelDefaults()
  check('★★ 还没设过 → 空对象（不是抛错）', Object.keys(fresh).length === 0, JSON.stringify(fresh))
  check('★★ 没设时 status 三类全 false', Object.values(defaultStatus(fresh)).every(v => v === false),
    JSON.stringify(defaultStatus(fresh)))
  check('★★★ status 只有三类（没有 text）', Object.keys(defaultStatus(fresh)).length === 3,
    JSON.stringify(Object.keys(defaultStatus(fresh))))

  /* 存四类 */
  const saved = await saveModelDefaults({
    /* 故意把 `defaultTextModel` 也发进来 —— 它现在是老键（映射到空），
     * 存进去必须**不出现**。这条验的是「发了也不认」。 */
    defaultTextModel: { channelId: 'ch-b', modelId: 'txt-1' },
    defaultImageModel: { channelId: 'ch-a', modelId: 'img-1' },
    defaultVideoModel: { channelId: 'ch-a', modelId: 'vid-1' },
    defaultAudioModel: { channelId: 'ch-b', modelId: 'aud-1' },
  })
  check('★★ 三类都存进去了（发的 defaultTextModel 被丢掉）',
    Object.keys(saved).length === 3, JSON.stringify(saved))
  check('★★★ defaultTextModel 读不进来（映射到空，不进任何一类）',
    saved.defaultTextModel === undefined, JSON.stringify(Object.keys(saved)))
  const back = await readModelDefaults()
  check('★★ 读回来一样', JSON.stringify(back) === JSON.stringify(saved), JSON.stringify(back))
  check('★★ defaultOf 按类型取得到（三类各是各的）',
    defaultOf(back, 'image')?.modelId === 'img-1' && defaultOf(back, 'audio')?.modelId === 'aud-1',
    JSON.stringify([defaultOf(back, 'image'), defaultOf(back, 'audio')]))
  check('★★★ defaultOf("text") 给 undefined（票 76：文本没有默认模型）',
    defaultOf(back, 'text') === undefined, JSON.stringify(defaultOf(back, 'text')))
  check('★★ status 三类全 true', Object.values(defaultStatus(back)).every(v => v === true),
    JSON.stringify(defaultStatus(back)))

  /* ★ 票 67 那两个键的兼容读：都映射到 `image`。
   * 这条是**保留下来的能力**，不是新加的 —— 那两天可能已经有人设过。 */
  {
    const t2i = normalizeDefaults({ defaultT2IModel: { channelId: 'old', modelId: 'img-9' } })
    check('★★★ 老键 defaultT2IModel 读成 image 那一格',
      t2i.defaultImageModel?.modelId === 'img-9', JSON.stringify(t2i))
    const i2i = normalizeDefaults({ defaultI2IModel: { channelId: 'old2', modelId: 'img-8' } })
    check('★★★ 老键 defaultI2IModel 也读成 image 那一格',
      i2i.defaultImageModel?.modelId === 'img-8', JSON.stringify(i2i))
    /* 当前形态优先：`defaultImageModel` 在时，老键盖不回去。 */
    const both = normalizeDefaults({
      defaultImageModel: { channelId: 'new', modelId: 'img-1' },
      defaultT2IModel: { channelId: 'old', modelId: 'img-9' },
    })
    check('★★★ 当前形态优先：defaultImageModel 在时老键盖不回去',
      both.defaultImageModel?.modelId === 'img-1', JSON.stringify(both))
  }

  /* 半条引用（只有渠道没有模型）要当没给 —— 它比没有更糟（让人以为设过了）。 */
  check('★★ 半条引用不收（只有 channelId）', asModelRef({ channelId: 'x' }) === undefined, '')
  check('★★ 半条引用不收（只有 modelId）', asModelRef({ modelId: 'y' }) === undefined, '')
  check('★ 空串也不收', asModelRef({ channelId: '', modelId: '' }) === undefined, '')
  check('★ 收的时候 trim', asModelRef({ channelId: ' c ', modelId: ' m ' })?.modelId === 'm',
    JSON.stringify(asModelRef({ channelId: ' c ', modelId: ' m ' })))

  /* normalizeDefaults：坏键跳过，好键留下 */
  const messy = normalizeDefaults({
    defaultImageModel: { channelId: 'a', modelId: 'b' },
    defaultVideoModel: { channelId: 'only-this' },
    defaultTextModel: 'not-an-object',
  })
  check('★★ 坏键跳过、好键留下（一条写坏不该让三类都用不上）',
    Object.keys(messy).length === 1 && messy.defaultImageModel?.modelId === 'b', JSON.stringify(messy))

  /* 清掉其余：给 null / 缺键 */
  const cleared = await saveModelDefaults({
    defaultImageModel: { channelId: 'a', modelId: 'b' },
  })
  check('★★ 整份覆盖：没给的类就没了（null = 清掉）', Object.keys(cleared).length === 1,
    JSON.stringify(cleared))

  /* 落盘的内容真的是 JSON 文件（不是内存里一份）。
   * ⚠️ 路径要从 `dataRoot()` 取，**不许自己拼** `EWB_TEST_HOME/ecom-workbench` ——
   * 沙箱下 `dataRoot()` 就是 `EWB_TEST_HOME` 本身，多拼一层会读到不存在的路径。 */
  const { dataRoot } = await import('../src/schedule/artifacts.ts')
  const defaultsPath = join(dataRoot(), MODEL_DEFAULTS_FILE)
  const raw = JSON.parse(await readFile(defaultsPath, 'utf8'))
  check('★★ 真落盘了（不是只在内存）',
    raw.defaultImageModel?.modelId === 'b', JSON.stringify(raw))
  /* ⚠️ 票 74 补的一条：保存时只写当前四键，老键一个都不写回去。
   * 否则磁盘上永久同时存在两套键，每次读都要跑一遍「哪组优先」。 */
  check('★★★ 落盘的只有四键，票 67 那两个老键不写回去',
    raw.defaultT2IModel === undefined && raw.defaultI2IModel === undefined, JSON.stringify(Object.keys(raw)))

  /* 坏 JSON → 空对象，不崩 */
  await writeFile(defaultsPath, '{坏', 'utf8')
  check('★★ 文件被写坏 → 读回空对象（不崩）', Object.keys(await readModelDefaults()).length === 0, '')
}

console.log('')
if (bad === 0) console.log('全部通过 ✓')
else { console.log('有 ' + String(bad) + ' 条不通过 ✗'); process.exitCode = 1 }
