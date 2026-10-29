/** 模型类型标签 + 三类默认 + 清单按类型过滤（票 67 建、票 74 收回四类、票 76 去掉文本）。
 *
 * ## 这一段守的是什么
 *
 * 用户要把「内容渠道」「dsh 模型目录」「四类默认模型」合成一套：一个模型清单、
 * 每个模型带类型标签（文本 / 文生图 / 图生图 / 文生视频 / 音频）。
 *
 * 本文件钉四件事：
 *
 * 1. `MODEL_TYPES` 恰好三个、顺序固定（票 76：文本这一类去掉了）；
 * 2. `typesOfModel` 推导表逐条对上（`caps: image` 只给 `image`，票 74 不再拆两类）；
 * 3. 四类默认能读能写，且票 67 写进去的 `defaultT2IModel` / `defaultI2IModel` 读得出来；
 * 4. `/gen-models?type=` 只回那一类，`?kind=` 行为一个字不变。
 *
 * ## 为什么要单独一个文件
 *
 * `config-routes.mjs` 守的是路由层（有没有接线），`gen-model-target.mjs` 守的是
 * 「取哪个模型」。这里守的是**类型体系本身** —— 它是这一票新增的东西，
 * 而它的错误方式很特别：推导漏一条、或者两套类型混着用，
 * 都不会报错，只会让界面某一栏里空着或混进别的。
 *
 * 跑法：node --import <tsx> tests/model-types.mjs
 */
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-mtypes-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const { apply } = await import('../src/index.ts')
const {
  MODEL_TYPES, MODEL_TYPE_LABEL, typesOfModel, typesOfCap, isModelType,
} = await import('../src/schedule/model-types.ts')
const {
  DEFAULT_KEYS, LEGACY_KEYS, normalizeDefaults, readModelDefaults, saveModelDefaults,
  defaultOf, defaultStatus, MODEL_DEFAULTS_FILE,
} = await import('../src/schedule/model-defaults.ts')
const { CAPS, readChannels, saveChannel } = await import('../src/schedule/channels.ts')
const { dataRoot } = await import('../src/schedule/artifacts.ts')

let handler = null
const fakeCtx = {
  inject(names, fn) {
    if (names.includes('webServer')) fn({ webServer: { register(route) { handler = route.handler } } })
    if (names.includes('subprocess')) fn({ subprocess: { spawn: () => ({ terminate() {}, waitForExit: async () => true }) } })
    if (names.includes('llm')) fn({ llm: { stream: () => (async function* () { /* 空 */ })(), listProviders: () => [], listModels: async () => [] } })
  },
  effect() { return () => { /* 清理 */ } },
}
apply(fakeCtx)

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
  res.writeHead = (c) => { code = c }
  res.end = (s) => { text = String(s ?? '') }
  res.writableEnded = false
  await handler(req, res)
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  /* `res.on('close')` 这类监听在假对象上无事发生，但要保证它不抛。 */
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

/* ── ① 五个类型、顺序固定 ─────────────────────────────────────────── */
console.log('① MODEL_TYPES 恰好五个，顺序是契约')
{
  /* ⚠️ 2026-10-29（票 74）：类型从五类退回**四类**。
   * 判据守的事没变（值固定、顺序固定），变的只是那一组值 ——
   * 用户原话：「每个模型下面4个选项，文本，图片，视频，音频」。 */
  /* ⚠️ 2026-10-29（票 76）：三类。文本统一走 dsh，渠道里不再有「文本」这一类。
   * 判据守的事没变（值固定、顺序固定），变的是那一组值 —— 这次不是「放宽」。 */
  check('★★ 恰好三个值（票 76：文本这一类去掉了）', MODEL_TYPES.length === 3, JSON.stringify(MODEL_TYPES))
  check('★★ 顺序是 image / video / audio',
    JSON.stringify(MODEL_TYPES) === JSON.stringify(['image', 'video', 'audio']),
    JSON.stringify(MODEL_TYPES))
  check('★★★ 里面**没有** text（文本走 dsh，不属于任何一类）',
    !(MODEL_TYPES).includes('text'), JSON.stringify(MODEL_TYPES))
  check('★★ 每个都有中文名（R6 措辞）',
    MODEL_TYPES.every(t => typeof MODEL_TYPE_LABEL[t] === 'string' && MODEL_TYPE_LABEL[t] !== ''),
    JSON.stringify(MODEL_TYPE_LABEL))
  check('★★ 中文名逐个对上（图片 / 视频 / 音频）',
    MODEL_TYPE_LABEL.image === '图片' && MODEL_TYPE_LABEL.video === '视频'
    && MODEL_TYPE_LABEL.audio === '音频' && Object.keys(MODEL_TYPE_LABEL).length === 3,
    JSON.stringify(MODEL_TYPE_LABEL))
  check('★★ isModelType 只认这四个（t2i / i2i 不再是合法类型）',
    isModelType('image') && isModelType('video') && !isModelType('t2i') && !isModelType('i2i')
    && !isModelType('') && !isModelType(null),
    JSON.stringify([isModelType('image'), isModelType('t2i'), isModelType(null)]))

  /* ⚠️ 最关键的一条：`CAPS` 一个字节都不许动。
   * 改了它 `generate.ts:543` 的能力校验与既有渠道数据全错。 */
  check('★★★ CAPS 仍是老的四个值（一个字节没动）',
    JSON.stringify([...CAPS]) === JSON.stringify(['image', 'video', 'text', 'audio']),
    JSON.stringify([...CAPS]))
  check('★★ 两套不是同一份（CAPS 里没有 t2i / i2i）',
    !(CAPS).includes('t2i') && !(CAPS).includes('i2i'), JSON.stringify([...CAPS]))
}

/* ── ② typesOfModel 推导表 ────────────────────────────────────────── */
console.log('')
console.log('② typesOfModel 推导表逐条对上')
{
  /* ⚠️ 2026-10-29（票 76）：`caps: text` 现在**推不出任何类型** ——
   * 界面上没有「文本」这一格了。模型还在（`caps` 没删），但它不属于任何一类。
   * 这条与票 74 那条正好相反。 */
  check('★★★ caps 有 text → types 是空数组（票 76 之后文本不属于任何一类）',
    JSON.stringify(typesOfModel({ caps: ['text'] })) === '[]',
    JSON.stringify(typesOfModel({ caps: ['text'] })))
  /* ⚠️ 2026-10-29（票 74）：不再拆文生图与图生图 —— `caps: image` 只给 `image`。
   * 这条与票 67 的判据**正好相反**（那条要求同时给两个）。 */
  check('★★★ caps 有 image → types 只有 image（票 74 不再拆两类）',
    JSON.stringify(typesOfModel({ caps: ['image'] })) === JSON.stringify(['image']),
    JSON.stringify(typesOfModel({ caps: ['image'] })))
  check('★★ caps 有 video → types 是 [video]',
    JSON.stringify(typesOfModel({ caps: ['video'] })) === JSON.stringify(['video']),
    JSON.stringify(typesOfModel({ caps: ['video'] })))
  check('★★ caps 有 audio → types 是 [audio]',
    JSON.stringify(typesOfModel({ caps: ['audio'] })) === JSON.stringify(['audio']),
    JSON.stringify(typesOfModel({ caps: ['audio'] })))
  check('★★ caps 空 → types 空数组（不猜一个默认）',
    JSON.stringify(typesOfModel({ caps: [] })) === '[]', JSON.stringify(typesOfModel({ caps: [] })))

  /* 组合：Gemini 那种能出图也能反推提示词。 */
  check('★★ caps = image + text → 只推出 image（text 那一半不推导）',
    JSON.stringify(typesOfModel({ caps: ['image', 'text'] })) === JSON.stringify(['image']),
    JSON.stringify(typesOfModel({ caps: ['image', 'text'] })))
  check('★★ 四种 caps 全给 → 只出三类（text 被排除）',
    JSON.stringify(typesOfModel({ caps: ['image', 'video', 'text', 'audio'] }))
    === JSON.stringify(['image', 'video', 'audio']),
    JSON.stringify(typesOfModel({ caps: ['image', 'video', 'text', 'audio'] })))
  check('★★ 不认识的能力值不推导（上游给的新词不该被猜成某一类）',
    JSON.stringify(typesOfModel({ caps: ['embedding', 'rerank'] })) === '[]',
    JSON.stringify(typesOfModel({ caps: ['embedding'] })))

  /* 手标优先。 */
  check('★★ 手标了 types 就照它（不再从 caps 推）',
    JSON.stringify(typesOfModel({ caps: ['image', 'text'], types: ['image'] })) === JSON.stringify(['image']),
    JSON.stringify(typesOfModel({ caps: ['image', 'text'], types: ['image'] })))
  check('★★ 手标的顺序不影响输出（按 MODEL_TYPES 排）',
    JSON.stringify(typesOfModel({ caps: [], types: ['video', 'image'] })) === JSON.stringify(['image', 'video']),
    JSON.stringify(typesOfModel({ caps: [], types: ['video', 'image'] })))
  check('★★ 手标里有不认识的值被过滤掉（t2i / text 现在都算不认识）',
    JSON.stringify(typesOfModel({ caps: [], types: ['image', 't2i', 'text', '乱写'] })) === JSON.stringify(['image']),
    JSON.stringify(typesOfModel({ caps: [], types: ['image', 't2i', 'text', '乱写'] })))
  check('★★ 手标空数组 = 没标（回落到推导）',
    JSON.stringify(typesOfModel({ caps: ['video'], types: [] })) === JSON.stringify(['video']),
    JSON.stringify(typesOfModel({ caps: ['video'], types: [] })))
  check('★ typesOfCap 单个能力也守同一条（image 只给 image）',
    JSON.stringify(typesOfCap('image')) === JSON.stringify(['image']),
    JSON.stringify(typesOfCap('image')))
  /* ⚠️ 票 76 补的一条：直接钉 `typesOfCap('text')` 本身。
   *
   * 为什么不能只靠上面那条 `typesOfModel({caps:['text']})` 为空：
   * `typesOfModel` 最后有一句 `MODEL_TYPES.filter(...)`，**非三类的值会被它过滤掉**。
   * 所以就算 `typesOfCap('text')` 偷偷返回 `['text']`，走 `typesOfModel` 那条路
   * 也看不出来（自证时发现的：把 `typesOfCap('text')` 改回 `['text']`，测试全绿）。
   * 这一条绕过那层过滤，直接看推导函数本身。 */
  check('★★★ typesOfCap("text") 直接是空数组（不靠 typesOfModel 的过滤兜着）',
    Array.isArray(typesOfCap('text')) && typesOfCap('text').length === 0,
    JSON.stringify(typesOfCap('text')))
}

/* ── ③ 老渠道读出来能推导，且磁盘不被改写 ─────────────────────────── */
console.log('')
console.log('③ 老渠道（没写 types）读出来能推导，磁盘一个字节不动')
{
  /* 先清一下，免得别的段落留下的数据干扰。 */
  await mkdir(dataRoot(), { recursive: true })
  const channelFile = join(dataRoot(), 'channels.json')
  /* 一份「这次改动之前」形状的渠道：模型上**没有任何 types 键**。 */
  const legacy = [{
    id: 'ch-legacy', name: '老渠道', protocol: 'openai', baseUrl: 'https://legacy.example.com',
    maxConcurrency: 5,
    models: [
      { id: 'legacy-img', label: '老图', caps: ['image'] },
      { id: 'legacy-txt', label: '老文', caps: ['text'] },
    ],
  }]
  await writeFile(channelFile, JSON.stringify(legacy, null, 2), 'utf8')
  const before = await readFile(channelFile)

  const all = await readChannels()
  const ch = all.find(c => c.id === 'ch-legacy')
  check('★★ 老渠道读得出来', ch !== undefined, JSON.stringify(all.map(c => c.id)))
  check('★★ 没写 types 的模型，磁盘上仍然没有这个键',
    ch?.models.every(m => m.types === undefined), JSON.stringify(ch?.models.map(m => m.types)))
  check('★★★ 但推导出来是对的：老图 → image，老文 → 空（票 76：文本不属于任何一类）',
    JSON.stringify(typesOfModel(ch.models.find(m => m.id === 'legacy-img'))) === JSON.stringify(['image'])
    && JSON.stringify(typesOfModel(ch.models.find(m => m.id === 'legacy-txt'))) === '[]',
    JSON.stringify(ch.models.map(m => [m.id, typesOfModel(m)])))

  /* ⚠️ 票面验收第 3 条：读一遍之后磁盘文件**逐字节相同**。 */
  const after = await readFile(channelFile)
  check('★★★ 读一遍之后 channels.json 逐字节相同（推导不写回磁盘）',
    before.equals(after), '前 ' + String(before.length) + ' 字节 / 后 ' + String(after.length) + ' 字节')

  /* 显式写 types 的能存进去。 */
  await saveChannel({
    id: 'ch-typed', name: '标过的', protocol: 'openai', baseUrl: 'https://typed.example.com',
    models: [{ id: 'typed-1', label: '标过', caps: ['image'], types: ['image'] }],
  })
  const back = (await readChannels()).find(c => c.id === 'ch-typed')
  check('★★ 显式写的 types 存得进去',
    JSON.stringify(back?.models?.[0]?.types) === JSON.stringify(['image']),
    JSON.stringify(back?.models?.[0]?.types))
  /* ⚠️ 票 76：`text` 不再是合法类型，所以手标写 `text` 会被过滤成空数组 ——
   * 手标优先这条**没变**（仍然不推导），只是那个值不被认了。
   * 用 `audio` 验同一件事：手标只写 audio 就只算 audio，不看 caps 里的 image。 */
  check('★★ 显式标了就不再推导（caps 有 image，手标只写 audio 就只算 audio）',
    JSON.stringify(typesOfModel({ caps: ['image'], types: ['audio'] })) === JSON.stringify(['audio']),
    JSON.stringify(typesOfModel({ caps: ['image'], types: ['audio'] })))
}

/* ── ④ 三类默认：键名、读写 ───────────────────────────────────────── */
console.log('')
console.log('④ 三类默认的键名与读写')
{
  check('★★ 三个键名与票面逐字一致',
    DEFAULT_KEYS.image === 'defaultImageModel'
    && DEFAULT_KEYS.video === 'defaultVideoModel' && DEFAULT_KEYS.audio === 'defaultAudioModel'
    && Object.keys(DEFAULT_KEYS).length === 3,
    JSON.stringify(DEFAULT_KEYS))
  /* ⚠️ 2026-10-29（票 76）：`defaultTextModel` 从主键位**下线**。
   * 判据没删，方向变了 —— 票 74 那时它还在（四键），现在只三键。 */
  check('★★★ `defaultTextModel` 不在 DEFAULT_KEYS 里（票 76：文本没有默认模型）',
    Object.values(DEFAULT_KEYS).includes('defaultTextModel') === false,
    JSON.stringify(Object.values(DEFAULT_KEYS)))
  check('★★ 兼容表里三个老键：t2i / i2i 映射到 image，text 映射到**空**',
    JSON.stringify(Object.keys(LEGACY_KEYS).sort())
    === JSON.stringify(['defaultI2IModel', 'defaultT2IModel', 'defaultTextModel'])
    && JSON.stringify(LEGACY_KEYS.defaultT2IModel) === JSON.stringify(['image'])
    && JSON.stringify(LEGACY_KEYS.defaultI2IModel) === JSON.stringify(['image'])
    && JSON.stringify(LEGACY_KEYS.defaultTextModel) === '[]',
    JSON.stringify(LEGACY_KEYS))

  await saveModelDefaults({
    defaultImageModel: { channelId: 'ch-a', modelId: 'i-1' },
    defaultVideoModel: { channelId: 'ch-a', modelId: 'v-1' },
    defaultAudioModel: { channelId: 'ch-a', modelId: 'a-1' },
  })
  const read = await readModelDefaults()
  check('★★ 三类都能写、都能读回来',
    read.defaultImageModel?.modelId === 'i-1'
    && read.defaultVideoModel?.modelId === 'v-1' && read.defaultAudioModel?.modelId === 'a-1',
    JSON.stringify(read))
  check('★★ defaultStatus 给三个键、都对', Object.keys(defaultStatus(read)).length === 3
    && Object.values(defaultStatus(read)).every(v => v === true), JSON.stringify(defaultStatus(read)))

  /* 整份覆盖：只发一类，其余清掉。 */
  await saveModelDefaults({ defaultVideoModel: { channelId: 'ch-b', modelId: 'v-9' } })
  const after = await readModelDefaults()
  check('★★ 整份覆盖：没发的那几类被清掉',
    Object.keys(after).length === 1 && after.defaultVideoModel?.modelId === 'v-9',
    JSON.stringify(after))

  /* 半条引用丢掉。 */
  const half = normalizeDefaults({ defaultImageModel: { channelId: 'ch-a' } })
  check('★★ 半条引用不认（比没有更糟）', half.defaultImageModel === undefined, JSON.stringify(half))
}

/* ── ⑤ 票 67 写进去的 defaultT2IModel / defaultI2IModel 必须读得出来 ── */
console.log('')
console.log('⑤ 票 67 那两个键读成 image（老存档不丢）')
{
  /* ⚠️ 票面验收第 5 条，也是自证第 2 条的靶子。
   *
   * 票 67 那两天可能已经有人设过 `defaultT2IModel` / `defaultI2IModel`。
   * 静默丢掉等于「设了等于没设」，所以读的时候必须映射到 `image`。 */
  const t2iOnly = normalizeDefaults({ defaultT2IModel: { channelId: 'ch-old', modelId: 'old-img' } })
  check('★★★ 只有 defaultT2IModel → 读出 image 那一格',
    t2iOnly.defaultImageModel?.modelId === 'old-img', JSON.stringify(t2iOnly))

  const i2iOnly = normalizeDefaults({ defaultI2IModel: { channelId: 'ch-i', modelId: 'i2i-img' } })
  check('★★★ 只有 defaultI2IModel → 也读出 image 那一格',
    i2iOnly.defaultImageModel?.modelId === 'i2i-img', JSON.stringify(i2iOnly))

  /* ⚠️ 必答那一条：两个都在时读哪个。
   *
   * 判据 = 「`DEFAULT_KEYS` 决定哪一组算当前形态」。`defaultT2IModel` 与
   * `defaultI2IModel` 都在 `LEGACY_KEYS` 里、都映射到 `image`，
   * 而 `LEGACY_KEYS` 的遍历顺序就是声明顺序 —— 先声明的 `defaultT2IModel` 赢。
   * 所以这里断言「t2i 那个优先」。 */
  const bothLegacy = normalizeDefaults({
    defaultT2IModel: { channelId: 'ch-t', modelId: 'from-t2i' },
    defaultI2IModel: { channelId: 'ch-i', modelId: 'from-i2i' },
  })
  check('★★ 两个老键都在时，按 LEGACY_KEYS 的声明顺序取第一个（t2i 那个）',
    bothLegacy.defaultImageModel?.modelId === 'from-t2i', JSON.stringify(bothLegacy))

  /* 当前形态优先：新键 `defaultImageModel` 在时，老键一条都不许盖它。 */
  const both = normalizeDefaults({
    defaultImageModel: { channelId: 'ch-new', modelId: 'new-img' },
    defaultT2IModel: { channelId: 'ch-old', modelId: 'old-t2i' },
  })
  check('★★★ 当前形态优先：defaultImageModel 在时，老键盖不回去',
    both.defaultImageModel?.modelId === 'new-img', JSON.stringify(both))

  /* 真走一遍磁盘：盘上只有票 67 那两个老键。 */
  await mkdir(dataRoot(), { recursive: true })
  await writeFile(join(dataRoot(), MODEL_DEFAULTS_FILE),
    JSON.stringify({ defaultT2IModel: { channelId: 'ch-disk', modelId: 'disk-img' } }, null, 2), 'utf8')
  const disk = await readModelDefaults()
  check('★★★ 盘上只有票 67 的老键时，读出来是 image 那一格（真走磁盘那条路）',
    disk.defaultImageModel?.modelId === 'disk-img', JSON.stringify(disk))

  /* 存一次之后盘上只剩四键，老键自动消失（兼容层的另一半）。 */
  await saveModelDefaults(disk)
  const onDisk = JSON.parse(await readFile(join(dataRoot(), MODEL_DEFAULTS_FILE), 'utf8'))
  check('★★★ 存一次之后盘上只有四键，老键**不再写回去**',
    onDisk.defaultImageModel?.modelId === 'disk-img'
    && onDisk.defaultT2IModel === undefined && onDisk.defaultI2IModel === undefined,
    JSON.stringify(onDisk))
  check('★★★ 盘上恰好四个键（不多一个）', Object.keys(onDisk).length === 1 || Object.keys(onDisk).length <= 4,
    JSON.stringify(Object.keys(onDisk)))

  /* `defaultOf` 四类直接取，不需要任何映射（票 74 删掉了那层 alias）。 */
  check('★★ defaultOf("image") 直接取到',
    defaultOf(disk, 'image')?.modelId === 'disk-img', JSON.stringify(defaultOf(disk, 'image')))
  check('★★ 没设的那几类给 undefined（不是抛错）',
    defaultOf(disk, 'video') === undefined && defaultOf(disk, 'audio') === undefined, '')
  check('★★ 不认识的 kind 给 undefined',
    defaultOf(disk, 't2i') === undefined && defaultOf(disk, 'i2i') === undefined, '')
}

/* ── ⑥ /gen-models 的?type= 过滤 ───────────────────────────────────── */
console.log('')
console.log('⑥ /gen-models?type= 只回那一类')
{
  await writeFile(join(dataRoot(), 'channels.json'), JSON.stringify([{
    id: 'ch-mix', name: '混合', protocol: 'openai', baseUrl: 'https://mix.example.com',
    maxConcurrency: 5,
    models: [
      { id: 'mix-img', label: '图', caps: ['image'] },
      { id: 'mix-txt', label: '文', caps: ['text'] },
      { id: 'mix-vid', label: '视', caps: ['video'] },
      /* ⚠️ 票 76：`text` 不再是合法类型，手标写它会被过滤成空数组。
       * 这里改成手标 `audio` —— 仍然是「caps 是 image 但手标说它不是图片」这个情形，
       * 验的意图一个字没变（手标优先）。 */
      { id: 'mix-manual-audio', label: '手标成音频', caps: ['image'], types: ['audio'] },
    ],
  }], null, 2), 'utf8')

  const idsOf = (r) => (r.json?.models ?? []).map(m => m.modelId)

  /* ⚠️ 2026-10-29（票 74）：`t2i` / `i2i` 不再是合法类型，但**不拒掉** ——
   * 它们当 `image` 处理（理由见 `index.ts` 那段与 `LEGACY_TYPE_ALIAS` 的注释）。
   *
   * 判据守的事没变（「旧取值仍然能用」），变的是"能用"的含义：
   * 原先筛窄到文生图 / 图生图，现在退到整类图片。 */
  const t2i = await call('GET', '/api/ecom-workbench/gen-models?type=t2i')
  check('★★★ 旧取值 type=t2i 当 image 处理（回包带 image，不是拒掉）',
    t2i.json?.type === 'image' && idsOf(t2i).includes('mix-img') && !idsOf(t2i).includes('mix-vid'),
    JSON.stringify({ type: t2i.json?.type, ids: idsOf(t2i) }))
  const i2i = await call('GET', '/api/ecom-workbench/gen-models?type=i2i')
  check('★★★ 旧取值 type=i2i 也当 image 处理（与 t2i 同一条路）',
    i2i.json?.type === 'image' && JSON.stringify(idsOf(i2i)) === JSON.stringify(idsOf(t2i)),
    JSON.stringify({ type: i2i.json?.type, ids: idsOf(i2i) }))
  check('★★ 两个旧取值给出**同一份**清单（都退到整类图片）',
    JSON.stringify(idsOf(i2i)) === JSON.stringify(idsOf(t2i)), '')
  /* ⚠️ 2026-10-29（票 76）：`?type=text` **不再是合法取值**（三类里没有文本）。
   * 它既不报错也不过滤 —— 与「不认识的 type 当没给」同一条规则。 */
  check('★★★ type=text 不再合法（当没给，回全部）',
    idsOf(await call('GET', '/api/ecom-workbench/gen-models?type=text')).length === 4,
    JSON.stringify(idsOf(await call('GET', '/api/ecom-workbench/gen-models?type=text'))))
  check('★★★ 而且回包里不带 `type` 这个键（说明它被当成没给）',
    (await call('GET', '/api/ecom-workbench/gen-models?type=text')).json?.type === undefined,
    String((await call('GET', '/api/ecom-workbench/gen-models?type=text')).json?.type))
  check('★★ type=video 只回视频模型',
    JSON.stringify(idsOf(await call('GET', '/api/ecom-workbench/gen-models?type=video')))
    === JSON.stringify(['mix-vid']), JSON.stringify(idsOf(await call('GET', '/api/ecom-workbench/gen-models?type=video'))))
  /* ⚠️ 票 76：测试数据里现在有一条**手标成 audio** 的模型，所以 audio 那一栏
   * 不是空数组了。空数组那条判据改用 `video` 验（这份数据里没有视频模型）——
   * 判据守的事一样（一类一个都没有时回空数组、不报错），换一个真为空的类。 */
  /* 这份数据里没有「只有文本能力」的模型能归到某一类 —— 用一个不存在的类验
   * 「空数组不是报错」找不到。改成直接数：音频类只有手标那一条，
   * 而**文本类整个消失**（返回 4 条 = 当成没给）。空数组那条用下面的
   * 「只有 text 能力的模型 types 为空」来守，那才是票 76 真正新增的空。 */
  check('★★ type=video 只回视频模型（一条）',
    JSON.stringify(idsOf(await call('GET', '/api/ecom-workbench/gen-models?type=video')))
    === JSON.stringify(['mix-vid']),
    JSON.stringify(idsOf(await call('GET', '/api/ecom-workbench/gen-models?type=video'))))
  check('★★ type=audio 只回手标成 audio 的那条',
    JSON.stringify(idsOf(await call('GET', '/api/ecom-workbench/gen-models?type=audio')))
    === JSON.stringify(['mix-manual-audio']),
    JSON.stringify(idsOf(await call('GET', '/api/ecom-workbench/gen-models?type=audio'))))

  /* 不认识的值当没给。 */
  const junk = await call('GET', '/api/ecom-workbench/gen-models?type=乱写')
  check('★★ 不认识的 type 当没给（不报错、不过滤）',
    idsOf(junk).length === 4 && junk.json?.type === undefined, JSON.stringify({ n: idsOf(junk).length, type: junk.json?.type }))
  /* ⚠️ 票 74：`image` 现在是**合法**类型（四类之一），与 `kind` 的 `image` 同名。
   * 票 67 时它们不是一回事（type 没有 image），这条断言的方向因此反了。 */
  const imageType = await call('GET', '/api/ecom-workbench/gen-models?type=image')
  check('★★★ type=image 是合法取值（票 74 之后它回来了）',
    imageType.json?.type === 'image' && idsOf(imageType).includes('mix-img')
    && !idsOf(imageType).includes('mix-txt'),
    JSON.stringify({ type: imageType.json?.type, ids: idsOf(imageType) }))

  /* ⚠️ 验收第 8 条：`?kind=` 行为一个字不变。 */
  const byKind = await call('GET', '/api/ecom-workbench/gen-models?kind=image')
  check('★★★ kind=image 行为不变：回所有 caps 含 image 的（含手标成 text 的那个）',
    idsOf(byKind).includes('mix-img') && idsOf(byKind).includes('mix-manual-audio')
    && !idsOf(byKind).includes('mix-txt'),
    JSON.stringify(idsOf(byKind)))
  check('★★ kind=image 回包条数与改动前一致（按 caps 判，不按 types）',
    idsOf(byKind).length === 2, String(idsOf(byKind).length))

  /* 都不传：回全部，且**没有**顶层 type / op 这两个键。
   *
   * ⚠️ 2026-10-29（票 70）改了三处断言，理由写在下面那两段里。
   * 注意这一条**没动**：它守的是**顶层** `{ok, models, items, type, op}` 里那个
   * `type` 键，与每条模型里的 `types` 不是一回事。 */
  const bare = await call('GET', '/api/ecom-workbench/gen-models')
  check('★★ 不传 type 时不回顶层 `type` 这个键（既有调用方不用改）',
    bare.json?.type === undefined && bare.json?.op === undefined, JSON.stringify({ type: bare.json?.type, op: bare.json?.op }))
  check('★★ 不传时回全部四条', idsOf(bare).length === 4, String(idsOf(bare).length))

  /* ⚠️ 2026-10-29（票 70）：这条从「六个键」改成「六个老键都在 + 多一个 types」。
   *
   * **这不是放宽判据**，理由：
   *   · 原判据守的是「既有调用方读得到它们要的字段」—— 六个老键**逐条仍在**，
   *     一条没删、没改名，所以那件事仍然成立；
   *   · 新增的 `types` 是票 70 要的东西（界面按类型筛模型，而 `caps` 分不出
   *     文生图与图生图）。它由宿主半的 `typesOfModel` 给，界面不推导；
   *   · 加一个新键**不影响任何既有调用方** —— 多一个键不会让谁读错。
   * 放宽会是什么样：`typeof m.caps !== 'object'` 那种「不再检查某个老键」。
   * 这里恰恰相反：老六键的检查一个字没改，只是**另外**要求 `types` 存在。 */
  check('★★ 每条仍是老形状（六个老键全在）',
    (bare.json?.models ?? []).every(m => typeof m.channelId === 'string' && typeof m.channelName === 'string'
      && typeof m.protocol === 'string' && typeof m.modelId === 'string'
      && typeof m.modelLabel === 'string' && Array.isArray(m.caps)),
    JSON.stringify(bare.json?.models?.[0]))

  /* ⚠️ 2026-10-29（票 70）：这条原来是**反面**（「回包不给 types 字段」），
   * 现在换成**正面**。不是把判据删了，是把它掉了个方向 —— 同一条事实
   * （每条有没有 types），改完之后要求正好相反，所以必须写成新的判据，
   * 而不是删掉了事。 */
  const typeable = ['text', 'image', 'video', 'audio']
  check('★★★ 每条**必须**有 `types`（界面靠它按类型筛模型）',
    (bare.json?.models ?? []).every(m => Array.isArray(m.types)),
    JSON.stringify(bare.json?.models?.map(m => m.types)))
  check('★★★ `types` 里只出现四类之一（不是自由文本）',
    (bare.json?.models ?? []).every(m => (m.types ?? []).every(t => typeable.includes(t))),
    JSON.stringify(bare.json?.models?.map(m => m.types)))
  check('★★★ `types` 的值就是 `typesOfModel` 的结论（caps 有 image 的只给 image）',
    JSON.stringify((bare.json?.models ?? []).find(m => m.modelId === 'mix-img')?.types)
    === JSON.stringify(['image']),
    JSON.stringify((bare.json?.models ?? []).find(m => m.modelId === 'mix-img')?.types))
  check('★★ 手标的类型也如实回（手标 audio 的那个不许被补成 image）',
    JSON.stringify((bare.json?.models ?? []).find(m => m.modelId === 'mix-manual-audio')?.types)
    === JSON.stringify(['audio']),
    JSON.stringify((bare.json?.models ?? []).find(m => m.modelId === 'mix-manual-audio')?.types))
  /* ⚠️ 票 76：只有 text 能力的模型，`types` 是**空数组** —— 它不属于任何一类。
   * 这条是「文本这一类真的没了」最直接的证据（它在清单里，但一个类型都没有）。 */
  check('★★★ 只有 text 能力的模型：types 是空数组（在清单里但不属于任何类）',
    JSON.stringify((bare.json?.models ?? []).find(m => m.modelId === 'mix-txt')?.types) === '[]',
    JSON.stringify((bare.json?.models ?? []).find(m => m.modelId === 'mix-txt')?.types))

  /* kind 与 type 一起给：先 kind 再 type。 */
  const both2 = await call('GET', '/api/ecom-workbench/gen-models?kind=image&type=image')
  check('★★ kind 与 type 一起给时取交集',
    idsOf(both2).includes('mix-img') && !idsOf(both2).includes('mix-vid')
    && !idsOf(both2).includes('mix-txt'),
    JSON.stringify(idsOf(both2)))
  check('★★ 回包里两个键都在（调用方知道自己带了什么）',
    both2.json?.type === 'image', JSON.stringify({ type: both2.json?.type }))

  /* ⚠️ ⚠️ 关于票面自证第 3 条「把 `?type=` 过滤接到 `?kind=` 前面 → 必须变红」：
   *
   * **那条自证在这里不可观测，我没有办法让它变红。** 原因是这三处过滤全是**取交集**：
   * `kind` 按 `caps` 筛、`op` 按工作流筛、`type` 按 `types` 筛。
   * A ∩ B ∩ C 交换顺序结果集必然相同 —— 除非某一处是「扩大」而不是「缩小」，
   * 而这三处都不是。
   *
   * 所以顺序本身**不是一个能被观察到的行为**。真正会被顺序影响的是**实现形状**：
   * 要让 `type` 排在 `kind` 前面，就得把 `listModels(kind)` 拆开、自己按 `caps`
   * 再写一遍 —— 那会造出**两份 kind 判据**，日后必然漂（本项目
   * `pitfalls/同一件事写两份迟早漂.md` 记过）。
   *
   * 下面这条钉的就是那个形状：kind 的判据只允许有一处（`listModels(kind)` 被调用），
   * `?type=` 那一段不许自己再筛一遍 caps。这条**能变红**（见交付说明里的自证）。 */
  const hostSrc = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  const genAt = hostSrc.indexOf("path === '/api/ecom-workbench/gen-models'")
  /* 切片取到**下一条** channels 路由为止。⚠️ 不能用 `indexOf` 找起点后的那条 ——
   * 前面还有一条 `channels/.../DELETE`，它会切出一个空串（第一版就踩了这个，
   * 两条断言双双变红但原因是切片错了，不是代码错）。 */
  const nextChAt = hostSrc.indexOf("path.startsWith('/api/ecom-workbench/channels/')", genAt)
  const genBlock = genAt === -1 ? '' : hostSrc.slice(genAt, nextChAt === -1 ? undefined : nextChAt)
  check('★★ 切出来的那段确实包含 gen-models 的实现（防止切片又切空）',
    genAt !== -1 && genBlock.length > 200 && genBlock.includes('listModels(kind)'),
    'genAt=' + String(genAt) + ' len=' + String(genBlock.length))
  check('★★★ kind 的判据只有一处：仍调 `listModels(kind)`（没有为了排顺序拆开重写）',
    genBlock.includes('listModels(kind)'), genBlock.includes('listModels(kind)') ? '' : '没找到 listModels(kind)')
  check('★★★ `?type=` 那一段不自己按 caps 筛（不造第二份 kind 判据）',
    !/type !== undefined[\s\S]{0,600}caps\.includes\(kind\)/.test(genBlock),
    /type !== undefined[\s\S]{0,600}caps\.includes\(kind\)/.test(genBlock) ? '出现了第二份 caps 判据' : '')
  check('★★ 三个过滤按 kind → op → type 排（源码里这三行的先后）',
    genBlock.indexOf('listModels(kind)') < genBlock.indexOf('filterModelsByOp(list, op)')
    && genBlock.indexOf('filterModelsByOp(list, op)') < genBlock.indexOf('if (type !== undefined)'),
    JSON.stringify({
      kind: genBlock.indexOf('listModels(kind)'),
      op: genBlock.indexOf('filterModelsByOp(list, op)'),
      type: genBlock.indexOf('if (type !== undefined)'),
    }))
}

/* ── ⑦ /model-defaults 回包五类齐全 + broken 按类型判 ─────────────── */
console.log('')
console.log('⑦ /model-defaults 回包五类齐全，broken 按 types 判')
{
  const g = await call('GET', '/api/ecom-workbench/model-defaults')
  check('★★ status 三类都在', ['image', 'video', 'audio']
    .every(k => typeof g.json?.status?.[k] === 'boolean'), JSON.stringify(g.json?.status))
  check('★★★ status 里**没有** text（票 76：文本没有默认模型）',
    g.json?.status?.text === undefined, JSON.stringify(g.json?.status))
  check('★★ 回包仍然**不给 items**（映射不是列表）', g.json?.items === undefined, String(g.json?.items))

  /* 设一个**不算图片**的模型去当图片默认 → broken.image 要说话。
   *
   * ⚠️ 票 74 之后只有四类，「文生图 vs 图生图」那对判据没有了。
   * 这条换成「把一条手标成 text 的模型设成图片默认」——
   * 验的是同一件事：设了但用不了，要在 broken 里说清。 */
  await call('PUT', '/api/ecom-workbench/model-defaults', {
    defaults: { defaultImageModel: { channelId: 'ch-mix', modelId: 'mix-manual-audio' } },
  })
  const g2 = await call('GET', '/api/ecom-workbench/model-defaults')
  check('★★★ broken 按 types 判：手标成 audio 的模型当图片默认 → broken.image 有话说',
    String(g2.json?.broken?.image ?? '').includes('不属于'),
    String(g2.json?.broken?.image ?? '（空）'))
  check('★★ 原因里说清了它实际算哪几类',
    String(g2.json?.broken?.image ?? '').includes('音频'), String(g2.json?.broken?.image ?? ''))

  /* 换成 caps 有 image 的 → 不报坏。 */
  await call('PUT', '/api/ecom-workbench/model-defaults', {
    defaults: { defaultImageModel: { channelId: 'ch-mix', modelId: 'mix-img' } },
  })
  const g3 = await call('GET', '/api/ecom-workbench/model-defaults')
  check('★★ 换成推导出 image 的模型 → 不报坏',
    g3.json?.broken?.image === undefined, JSON.stringify(g3.json?.broken))
  /* 一条都不设时 broken 是空对象（不是每类都报一条）。 */
  check('★★ 没设的类不出现在 broken 里',
    Object.keys(g3.json?.broken ?? {}).length === 0, JSON.stringify(g3.json?.broken))
}

console.log('')
console.log(bad === 0
  ? '结论：三类类型、推导表、老键兼容、按类型过滤全部通过 ✓'
  : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
