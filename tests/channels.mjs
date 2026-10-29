/** 渠道表与密钥（契约 AX，2026-10-25）。
 *
 * ## 这一段守的是什么
 *
 * 计划 §三 2.1 唯一一条硬要求：**密钥不进前端**。
 * 所有断言都围着它转 —— 密钥能存、能读（宿主）、但任何一条 GET 的响应体里
 * 都搜不到那串字符。
 *
 * ## 判据为什么是「搜字符串」而不是「看字段名」
 *
 * 「响应里有没有 `apiKey` 字段」这种判据挡不住泄密：把密钥塞进 `note` 或者
 * 不小心整条 spread 进来都不带那个字段名。所以判据是**拿真实密钥去搜整个响应文本**。
 *
 * 跑法：node --import <tsx> tests/channels.mjs
 */
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-ch-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const { apply } = await import('../src/index.ts')
const { channelSecretFile, PROTOCOLS } = await import('../src/schedule/channels.ts')

/** 抓 `apply()` 注册进来的路由处理函数。 */
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
 * 模拟一次 HTTP 调用（保留原始响应文本 —— 泄密是靠**搜文本**发现的）。
 * @param {string} method - 方法。
 * @param {string} url - 路径。
 * @param {object} [body] - 请求体。
 * @returns {Promise<{code:number, text:string, json:any}>} 响应。
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
  return { code, text, json }
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

/* 用一串**绝对不可能是别的东西**的假密钥：搜它命中就一定是泄密，
 * 不会因为「碰巧某段文案里也有一模一样的字」误判。 */
const SECRET = 'sk-EWB-SECRET-do-not-leak-2f7c9a'

/* ── ① 新建渠道 + 密钥落两个文件 ───────────────────────────────────── */
console.log('① 新建一条带密钥的渠道')
{
  const created = await call('POST', '/api/ecom-workbench/channels', {
    id: 'ch_openai1', name: '我的 OpenAI', protocol: 'openai',
    baseUrl: 'https://api.example.com/v1',
    models: [{ id: 'gpt-image-1', label: '图像模型', caps: ['image'] }],
    maxConcurrency: 3, apiKey: SECRET,
  })
  check('★ 新建成功', created.code === 200 && created.json?.ok === true,
    JSON.stringify({ code: created.code, ok: created.json?.ok }))

  const publicText = await readFile(join(process.env.EWB_TEST_HOME, 'channels.json'), 'utf8')
  check('★★ channels.json 里**没有**那串密钥', !publicText.includes(SECRET),
    publicText.length + ' 字节')
  const secretText = await readFile(channelSecretFile(), 'utf8')
  check('★★ channels.secret.json 里**有**那串密钥', secretText.includes(SECRET),
    Object.keys(JSON.parse(secretText)).join(','))
  check('★ 公开表里存了协议、地址、并发上限',
    publicText.includes('"protocol": "openai"') && publicText.includes('"maxConcurrency": 3'),
    publicText.replace(/\s+/g, ' ').slice(0, 120))
}

/* ── ② GET 不回密钥 ────────────────────────────────────────────────── */
console.log('')
console.log('② GET /channels 的响应体里搜不到密钥')
{
  const got = await call('GET', '/api/ecom-workbench/channels')
  check('★★ 整份响应文本里**0 命中**那串密钥', !got.text.includes(SECRET),
    got.text.length + ' 字节')
  const list = got.json?.channels ?? []
  check('★★ 每条带 hasKey（这条配过 → true）',
    list.length === 1 && list[0]?.hasKey === true,
    JSON.stringify(list.map(c => ({ id: c.id, hasKey: c.hasKey }))))
  check('★★ 而且带出来的是渠道定义（名字、协议、模型）',
    list[0]?.name === '我的 OpenAI' && list[0]?.protocol === 'openai'
    && list[0]?.models?.[0]?.id === 'gpt-image-1',
    JSON.stringify(list[0]))

  /* 没配密钥的那条 → hasKey 为 false（界面靠它显示「未配置」）。 */
  await call('POST', '/api/ecom-workbench/channels', {
    id: 'ch_nokey', name: '没配密钥的', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8189',
  })
  const got2 = await call('GET', '/api/ecom-workbench/channels')
  const nokey = (got2.json?.channels ?? []).find(c => c.id === 'ch_nokey')
  check('★ 没配密钥的那条 hasKey=false', nokey?.hasKey === false, JSON.stringify(nokey?.hasKey))
}

/* ── ③ 更新不丢密钥；空串不清密钥 ──────────────────────────────────── */
console.log('')
console.log('③ 改渠道不会把密钥弄丢')
{
  /* 只改名、不带 apiKey → 旧密钥留着。 */
  await call('POST', '/api/ecom-workbench/channels', {
    id: 'ch_openai1', name: '改过名的 OpenAI', protocol: 'openai',
    baseUrl: 'https://api.example.com/v1', maxConcurrency: 4,
  })
  const secrets = JSON.parse(await readFile(channelSecretFile(), 'utf8'))
  check('★★ 只改名 → 密钥还在', secrets.ch_openai1 === SECRET, String(secrets.ch_openai1))
  const list = (await call('GET', '/api/ecom-workbench/channels')).json?.channels ?? []
  const one = list.find(c => c.id === 'ch_openai1')
  check('★ 名字改过来了、hasKey 仍是 true',
    one?.name === '改过名的 OpenAI' && one?.hasKey === true, JSON.stringify(one?.name))

  /* 带空串 apiKey → 按「没带」处理，不删密钥（界面误操作不该删掉已配好的密钥）。 */
  await call('POST', '/api/ecom-workbench/channels', {
    id: 'ch_openai1', protocol: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: '',
  })
  const secrets2 = JSON.parse(await readFile(channelSecretFile(), 'utf8'))
  check('★ 传空串 apiKey → 密钥仍在（不清空）', secrets2.ch_openai1 === SECRET,
    String(secrets2.ch_openai1))
}

/* ── ④ 删渠道要连密钥一起删 ───────────────────────────────────────── */
console.log('')
console.log('④ 删渠道同时删密钥')
{
  const del = await call('DELETE', '/api/ecom-workbench/channels/ch_openai1')
  check('★ 删除成功', del.code === 200 && del.json?.ok === true, String(del.code))
  const secrets = JSON.parse(await readFile(channelSecretFile(), 'utf8'))
  check('★★ secret 文件里那条也没了', secrets.ch_openai1 === undefined,
    JSON.stringify(Object.keys(secrets)))
  const list = (await call('GET', '/api/ecom-workbench/channels')).json?.channels ?? []
  check('★ 渠道表里也没了', !list.some(c => c.id === 'ch_openai1'), list.map(c => c.id).join(','))

  const again = await call('DELETE', '/api/ecom-workbench/channels/ch_openai1')
  check('★ 删不存在的 → 404 + 说明', again.code === 404 && String(again.json?.error).includes('没有这个渠道'),
    String(again.json?.error))
}

/* ── ⑤ 校验：非法协议 / 空地址 / 非法 id ──────────────────────────── */
console.log('')
console.log('⑤ 校验')
{
  const badProto = await call('POST', '/api/ecom-workbench/channels', {
    id: 'ch_bad', protocol: 'stability', baseUrl: 'https://x',
  })
  check('★★ 非法协议 → 400', badProto.code === 400, String(badProto.code))
  check('★ 错误话说清了允许哪三种',
    String(badProto.json?.error).includes('openai') && String(badProto.json?.error).includes('comfyui'),
    String(badProto.json?.error))

  const noUrl = await call('POST', '/api/ecom-workbench/channels', {
    id: 'ch_bad2', protocol: 'openai', baseUrl: '',
  })
  check('★★ 空地址 → 400', noUrl.code === 400 && String(noUrl.json?.error).includes('地址'),
    String(noUrl.json?.error))

  const badId = await call('POST', '/api/ecom-workbench/channels', {
    id: '../逃逸', protocol: 'openai', baseUrl: 'https://x',
  })
  check('★ 非法 id → 400（挡路径穿越）', badId.code === 400, String(badId.code))

  check('★ 三种协议都在常量里（给界面校验用）',
    PROTOCOLS.join(',') === 'openai,comfyui,gemini', PROTOCOLS.join(','))

  /* 校验失败时不该写进任何文件（半存半不存最坏）。 */
  const list = (await call('GET', '/api/ecom-workbench/channels')).json?.channels ?? []
  check('★★ 校验失败的都没进表', !list.some(c => c.id === 'ch_bad' || c.id === 'ch_bad2'),
    list.map(c => c.id).join(','))
}

/* ── ⑨ 模型两种形状都收（2026-10-26，T-B-后端）────────────────────────
 *
 * 界面上一直是「一行一个模型」的**文本**（`ChannelSettings.tsx` 的 `parseModels`
 * 拆 `"gpt-image-1|GPT Image|image,video"`）。拉了模型之后要能勾选，
 * 勾出来的是结构化 `{ id, label, caps }`。两种都得收：
 *
 * - 老渠道存在磁盘上了，强制某种形状等于要写迁移 —— 这次改动不该让任何已存渠道读不出来；
 * - 新界面可以直接发对象，也可以继续发文本。 */
console.log('⑨ 模型的两种形状都收（字符串 / 对象），老渠道不坏')
{
  /* ① 字符串数组（界面那条文本格式） */
  const s1 = await call('POST', '/api/ecom-workbench/channels', {
    id: 'ch_shape1', name: '字符串形状', protocol: 'openai', baseUrl: 'https://a.example.com',
    models: ['gpt-image-1|GPT Image|image,video', 'plain-model', 'third|第三个|audio'],
  })
  check('★★ 字符串数组 → 200', s1.code === 200, String(s1.json?.error))
  const m1 = s1.json?.channel?.models ?? []
  check('★★ 字符串被拆成 id / label / caps 三段', m1[0]?.id === 'gpt-image-1' && m1[0]?.label === 'GPT Image'
    && m1[0]?.caps.join(',') === 'image,video', JSON.stringify(m1[0]))
  check('★★ 只有 id 的那行 label 退回 id', m1[1]?.label === 'plain-model' && m1[1]?.caps.length === 0,
    JSON.stringify(m1[1]))
  check('★ 三条都收进来了', m1.length === 3, String(m1.length))

  /* ② 对象数组（新界面勾选出来的） */
  const s2 = await call('POST', '/api/ecom-workbench/channels', {
    id: 'ch_shape2', name: '对象形状', protocol: 'openai', baseUrl: 'https://b.example.com',
    models: [{ id: 'obj-1', label: '对象一', caps: ['image', 'text'] }, { id: 'obj-2' }],
  })
  check('★★ 对象数组 → 200', s2.code === 200, String(s2.json?.error))
  const m2 = s2.json?.channel?.models ?? []
  check('★★ 对象的 caps 原样收', m2[0]?.caps.join(',') === 'image,text', JSON.stringify(m2[0]))
  check('★ 对象没给 label 时退回 id', m2[1]?.label === 'obj-2', JSON.stringify(m2[1]))

  /* ③ 两种混在一个数组里也收（界面切换过程中会出现） */
  const s3 = await call('POST', '/api/ecom-workbench/channels', {
    id: 'ch_shape3', name: '混合', protocol: 'openai', baseUrl: 'https://c.example.com',
    models: ['str-a|甲|image', { id: 'obj-b', label: '乙', caps: ['video'] }],
  })
  check('★★ 一个数组里字符串与对象混着也给收', (s3.json?.channel?.models ?? []).length === 2,
    JSON.stringify(s3.json?.channel?.models))

  /* ④ 整段多行文本（有些调用方直接发草稿里的那段字） */
  const s4 = await call('POST', '/api/ecom-workbench/channels', {
    id: 'ch_shape4', name: '整段文本', protocol: 'openai', baseUrl: 'https://d.example.com',
    models: 'txt-1|一号|image\ntxt-2|二号|video',
  })
  check('★★ 整段多行文本也能收（按行拆）', (s4.json?.channel?.models ?? []).length === 2,
    JSON.stringify(s4.json?.channel?.models))

  /* ⑤ 老渠道（只有对象、没有新字段）读回来不变 —— 这是「不坏」的判据。 */
  const old = (await call('GET', '/api/ecom-workbench/channels')).json?.channels ?? []
  const keep = old.find(c => c.id === 'ch_shape2')
  check('★★ 存进去再读回来，对象形状一字不差',
    keep?.models?.[0]?.id === 'obj-1' && keep?.models?.[0]?.label === '对象一',
    JSON.stringify(keep?.models?.[0]))

  /* ⑥ 不认识的能力值被丢掉（不许混进 caps） */
  const s6 = await call('POST', '/api/ecom-workbench/channels', {
    id: 'ch_shape6', name: '坏能力', protocol: 'openai', baseUrl: 'https://e.example.com',
    models: [{ id: 'x', label: 'x', caps: ['image', '不存在的能力', 'video'] }],
  })
  check('★★ 不认识的能力值被过滤掉', (s6.json?.channel?.models?.[0]?.caps ?? []).join(',') === 'image,video',
    JSON.stringify(s6.json?.channel?.models?.[0]?.caps))
}

/* ── ⑩ 用**还没保存的**密钥先验一次（票 36，2026-10-28）────────────────
 *
 * ## 这一段守什么
 *
 * 用户原话：「模型接口密钥填了后应该可以读取接口支持的模型。」
 * 原来的路只有 `GET /channels/:id/models` —— 要渠道 id，也就是**必须先保存**。
 * 于是「先填密钥、看看对不对」走不通，只能瞎填着存一次。
 *
 * `POST /channels/probe` 补的就是这条：只读请求体里那三样（协议 / 地址 / 密钥），
 * 不碰盘上的 `channels.json`。
 *
 * ## 三条判据各有各的反面
 *
 * | 验什么 | 反面（不做会怎样） |
 * |---|---|
 * | 不落盘 | 点一次「测连通」就凭空多一条渠道 |
 * | 空地址 / 错协议给的是「结果」不是 4xx | 界面会把它当接口坏了，显示成异常 |
 * | 连不上 → `kind: unreachable` + 带 url | 用户不知道到底问了哪个地址 |
 *
 * ⚠️ 这里**不真联网**：地址一律用 `127.0.0.1:1`（本机必然拒绝连接）。
 * 那既证明「真的发了请求」，又不需要外网。 */
console.log('')
console.log('⑩ 预检：没保存的密钥也能先问一次上游')
{
  /* 先记下盘上渠道表的原貌。 */
  const before = (await call('GET', '/api/ecom-workbench/channels')).json?.channels ?? []
  const beforeIds = before.map(c => c.id).sort().join(',')

  const emptyUrl = await call('POST', '/api/ecom-workbench/channels/probe', {
    protocol: 'openai', baseUrl: '', apiKey: 'sk-x',
  })
  check('★★ 空地址 → HTTP 200（这是「结果」不是「接口坏了」）', emptyUrl.code === 200, String(emptyUrl.code))
  check('★★ 空地址 → ok:false 且 kind=unreachable（没东西可问 ≠ 上游不通，话要分开）',
    emptyUrl.json?.ok === false && emptyUrl.json?.kind === 'unreachable',
    JSON.stringify({ ok: emptyUrl.json?.ok, kind: emptyUrl.json?.kind }))
  check('★ 空地址那句话说清了先填地址', String(emptyUrl.json?.error).includes('地址'),
    String(emptyUrl.json?.error))

  const badProto = await call('POST', '/api/ecom-workbench/channels/probe', {
    protocol: 'stability', baseUrl: 'https://x.example.com', apiKey: 'sk-x',
  })
  check('★★ 不认识的协议 → kind=no-endpoint，且说清允许哪三种',
    badProto.json?.kind === 'no-endpoint'
    && String(badProto.json?.error).includes('openai')
    && String(badProto.json?.error).includes('gemini'),
    String(badProto.json?.error))

  /* 真发一次请求（打本机的 1 号端口，必然连不上）。 */
  const unreach = await call('POST', '/api/ecom-workbench/channels/probe', {
    protocol: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-never-valid',
  })
  check('★★ 连不上 → 仍是 HTTP 200（失败也是「结果」）', unreach.code === 200, String(unreach.code))
  check('★★ 连不上 → ok:false 且 kind=unreachable',
    unreach.json?.ok === false && unreach.json?.kind === 'unreachable',
    JSON.stringify({ ok: unreach.json?.ok, kind: unreach.json?.kind }))
  check('★★ 回包里带 url（用户要知道它到底问了哪个地址）',
    String(unreach.json?.url ?? '').includes('/v1/models'), String(unreach.json?.url))
  check('★★★ 回包里搜不到那串密钥（预检也不许把密钥带出去）',
    !unreach.text.includes('sk-never-valid'), '响应 ' + String(unreach.text.length) + ' 字节')

  /* ★ 最关键的一条：预检**不许**落盘。 */
  const after = (await call('GET', '/api/ecom-workbench/channels')).json?.channels ?? []
  check('★★★ 预检之后渠道表一条都没多（不落盘，它不是「新建渠道」）',
    after.map(c => c.id).sort().join(',') === beforeIds,
    '前 ' + beforeIds + ' → 后 ' + after.map(c => c.id).sort().join(','))
}

console.log('')
console.log(bad === 0 ? '结论：渠道表与密钥（不出宿主）全部通过 ✓' : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
