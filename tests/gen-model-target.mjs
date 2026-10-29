/** 节点怎么知道自己该用哪个模型（2026-10-26，T-B-后端）。
 *
 * # 用户原话
 *
 * 「我都没看到生图、视频、文本、音频这些的模型设置在哪，
 * 节点是怎么知道自己该用什么模型的？？？」
 *
 * # 这一份验的就是答案
 *
 * 以前：界面在节点没选模型时自己填「模型清单里的第一个」
 * （`ContentCanvas.tsx:1493` / `:1550`）—— 换渠道、换机器就变了，用户什么都没改。
 *
 * 现在三层：
 * ```
 * ① 指定了模型      → 用
 *   ② 没指定 → 默认模型里这一类 → 用它的渠道 + 模型
 *     ③ 默认也没有 → **报错**说「去设置里选一个」
 * ```
 *
 * 跑法：node scripts/run-tests.mjs gen-model-target
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-gmt-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const {
  submitGeneration, getTask, setGenerateDeps, resetGenerateForTest, resolveGenerationTarget,
} = await import('../src/schedule/generate.ts')
const { saveChannel } = await import('../src/schedule/channels.ts')
const { saveModelDefaults, readModelDefaults } = await import('../src/schedule/model-defaults.ts')
const { resetChannelQueueForTest } = await import('../src/schedule/channel-queue.ts')

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

/** 1×1 PNG。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** 假 fetch：回一张图。 */
function imgFetch() {
  return async () => new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
}

/** 等任务到终态。 */
async function settle(id) {
  const deadline = Date.now() + 8000
  for (;;) {
    const t = getTask(id)
    if (t !== null && (t.status === 'success' || t.status === 'failed')) return t
    if (Date.now() > deadline) return getTask(id)
    await new Promise(done => setTimeout(done, 10))
  }
}

/**
 * 把「会抛的函数」包成 `{value, err}`（**不许让异常把整个测试崩掉**）。
 *
 * 这条是自证时踩出来的：`gen-model-target` 第一次做自证（改坏默认那层），
 * 测试直接崩在一个没接的 `throw` 上 —— 红条数是 0，看起来像「改坏了也没事」。
 * 断言该优雅失败。
 *
 * @param fn - 要调的函数。
 * @returns `{value, err}`（二选一）。
 */
async function caught(fn) {
  try {
    return { value: await fn(), err: '' }
  } catch (e) {
    return { value: undefined, err: e instanceof Error ? e.message : String(e) }
  }
}

/* ── ① 指定了模型：照用 ────────────────────────────────────────────── */

console.log('① 指定了模型 → 用它')
{
  resetGenerateForTest()
  resetChannelQueueForTest()
  await saveChannel({
    id: 'ch-a', name: '渠道 A', protocol: 'openai', baseUrl: 'https://a.example.com',
    models: [
      { id: 'first-model', label: '第一个', caps: ['image'] },
      { id: 'second-model', label: '第二个', caps: ['image'] },
    ],
  })
  const t = (await caught(() => resolveGenerationTarget({ kind: 'image', model: 'second-model' }))).value
    ?? { model: '', from: '' }
  check('★★ 指定了就用指定的（不是清单第一个）', t.model === 'second-model' && t.from === 'given',
    JSON.stringify(t))
  check('★★ 没指定渠道时不强行绑一个', t.channelId === undefined, String(t.channelId))
}

/* ── ② 没指定 → 用默认模型 ─────────────────────────────────────────── */

console.log('② 没指定模型 → 用「默认模型」里这一类的那条')
{
  await saveChannel({
    id: 'ch-b', name: '渠道 B', protocol: 'openai', baseUrl: 'https://b.example.com',
    models: [{ id: 'b-img', label: 'B 出图', caps: ['image'] }],
  })
  await saveModelDefaults({
    defaultImageModel: { channelId: 'ch-b', modelId: 'b-img' },
  })
  /* ⚠️ 用 `caught()` 包一层：`resolveGenerationTarget` 会抛（「没设默认」那条）。
   * 直接 `await` 会让测试**崩掉**而不是变红 —— 崩掉时红条数是 0，看起来像"没事"。
   * 这是本项目反复踩的一条：自证改坏代码时，断言该优雅失败，不该抛异常。 */
  const got = await caught(() => resolveGenerationTarget({ kind: 'image', model: '' }))
  const t = got.value ?? { model: '', from: '' }
  check('★★ 没指定 → 取默认里的模型', t.model === 'b-img' && t.from === 'default',
    got.err !== '' ? '抛了：' + got.err.slice(0, 60) : JSON.stringify(t))
  check('★★ 而且带上默认里的渠道（不是让 pickChannel 随便挑）', t.channelId === 'ch-b', String(t.channelId))

  /* 四类各自独立：只设了 image，video 那条不该借到 image 的。 */
  const videoErr = (await caught(() => resolveGenerationTarget({ kind: 'video', model: '' }))).err
  /* ⚠️ 2026-10-29（票 67 补）：措辞从「生视频」改成「文生视频」（与五类的中文名统一）。
   * 这里改成**明确锚「文生视频」** —— 原先锚的是「生视频」，它恰好是「文生视频」
   * 的子串，改完仍会绿，那种绿是巧合不是判据。 */
  /* ⚠️ 2026-10-29（票 74）：四类之后 label 是「视频」（不再是「文生视频」）。
   * 锚的仍是「点名那一类 + 说去设置里选」，只是那个词跟着四类变了。 */
  check('★★ 只设了图片 → 视频那条不借图片的默认，而是报错',
    videoErr.includes('视频'), videoErr.slice(0, 80))
  check('★★ 报错点名的是「视频」（与四类中文名一致）',
    videoErr.includes('「视频」'), videoErr.slice(0, 120))
  check('★★ 报错里说「去设置里选一个」+ 点了这个字段的旧行为',
    videoErr.includes('默认模型') && videoErr.includes('设置') && videoErr.includes('第一个'),
    videoErr.slice(0, 160))
}

/* ── ③ 默认也没有 → 明确报错（这是判据 3 的核心） ───────────────────── */

console.log('③ 默认也没设 → 报错说去设置里选，**不许静默取第一个**')
{
  await saveModelDefaults({})
  const empty = await readModelDefaults()
  check('★ 此刻四类都没默认', Object.keys(empty).length === 0, JSON.stringify(empty))

  const err = (await caught(() => resolveGenerationTarget({ kind: 'image', model: '' }))).err
  check('★★ 没设默认 → 抛错（不是静默给一个模型）', err !== '', err.slice(0, 100))
  check('★★ 错里说「还没有设默认模型」', err.includes('还没有设默认模型'), err.slice(0, 120))
  check('★★ 错里说去「默认模型」里选', err.includes('默认模型') && err.includes('设置'), err.slice(0, 160))
  check('★★ 错里点了旧行为（静默取第一个）——用户看得懂为什么变了',
    err.includes('第一个'), err.slice(0, 200))
  check('★★ 用的是中文类名（图片），不是英文 image', err.includes('图片'), err.slice(0, 60))
}

/* ── ④ 端到端：真跑一次，看任务里用的是哪个模型 ─────────────────────── */

console.log('④ 端到端：任务记录里显示的是「实际用的那个模型」')
{
  resetGenerateForTest()
  resetChannelQueueForTest()
  await saveChannel({
    id: 'ch-c', name: '渠道 C', protocol: 'openai', baseUrl: 'https://c.example.com',
    models: [
      { id: 'wrong-default-pick', label: '清单第一个', caps: ['image'] },
      { id: 'the-real-default', label: '真默认', caps: ['image'] },
    ],
  })
  await saveModelDefaults({ defaultImageModel: { channelId: 'ch-c', modelId: 'the-real-default' } })
  setGenerateDeps({ netFetch: imgFetch() })

  const t0 = await settle(submitGeneration({ kind: 'image', prompt: '猫', model: '' }).id)
  check('★★ 真跑一次：用的是默认那个（不是清单第一个）', t0?.model === 'the-real-default', String(t0?.model))
  check('★★ 任务成功', t0?.status === 'success', String(t0?.status) + ' / ' + String(t0?.error ?? ''))
  check('★★ 进度里写明了「用默认模型：xxx」（用户能看见这次用的哪个）',
    (t0?.history ?? []).some(h => String(h.note ?? '').includes('用默认模型')),
    JSON.stringify((t0?.history ?? []).map(h => h.note).filter(Boolean).slice(0, 3)))

  /* 没设默认时：接口受理、任务失败、原因说清。 */
  await saveModelDefaults({})
  const t1 = await settle(submitGeneration({ kind: 'image', prompt: '猫', model: '' }).id)
  check('★★ 没设默认 → 任务失败（不是静默成功）', t1?.status === 'failed', String(t1?.status))
  check('★★ 失败原因就是「还没有设默认模型」那句',
    String(t1?.error ?? '').includes('还没有设默认模型'), String(t1?.error ?? '').slice(0, 100))
}

/* ── ⑤ 默认指向的东西没了 → 说清是默认坏了 ─────────────────────────── */

console.log('⑤ 默认指向的渠道/模型没了 → 说清是「默认」坏了')
{
  resetGenerateForTest()
  resetChannelQueueForTest()
  await saveChannel({
    id: 'ch-d', name: '渠道 D', protocol: 'openai', baseUrl: 'https://d.example.com',
    models: [{ id: 'd-img', label: 'D', caps: ['image'] }],
  })
  await saveModelDefaults({ defaultImageModel: { channelId: 'ch-d', modelId: 'gone-model' } })
  setGenerateDeps({ netFetch: imgFetch() })
  const t = await settle(submitGeneration({ kind: 'image', prompt: '猫', model: '' }).id)
  check('★★ 任务失败', t?.status === 'failed', String(t?.status))
  check('★★ 原因里说「这个模型是默认里取的」并指出去设置里改',
    String(t?.error ?? '').includes('default') || String(t?.error ?? '').includes('默认'),
    String(t?.error ?? '').slice(0, 140))
  check('★★ 还说「重新拉一次模型清单」（模型改名/删掉是常见原因）',
    String(t?.error ?? '').includes('拉'), String(t?.error ?? '').slice(0, 200))
}

/* ── ⑥ 文本节点生成也取「文本」那一格（票 38，2026-10-28 补）─────────
 *
 * ## 为什么这条必须存在
 *
 * 票 38 给 `DefaultsSettings` 的 `text` 那一格写说明时，第一版写成了
 * 「这一格只对反推提示词有效」—— **错的**。内容画布的文本节点有「生成」那一格
 * （用模型润色正文），它走的是 `kind: 'text'`，取的也是这一格。
 * lead 2026-10-28 指出后改掉了文案，这里补一条断言把事实钉住。
 *
 * ## 为什么这条用**后端真跑**而不是搜源码
 *
 * 「文本节点提交时 kind 是 'text'」这句话在 `ContentCanvas.tsx:1263` 的
 * `genKindOf()` 里，那是界面的事；而「kind 为 'text'、没给模型时会不会取到
 * 这一格」是后端的事。搜源码只能证明前半句，证明不了后半句 ——
 * 而用户真正会撞上的正是后半句（配了不生效才叫坏）。
 *
 * 所以这条走 `resolveGenerationTarget({ kind: 'text', model: '' })` 这个真函数：
 * 它就是 `runTask` 在提交时调的那一个（`generate.ts:512`）。
 *
 * ## 与反推提示词那条的关系
 *
 * 两条路**都**落到 `text` 这一格，但来路不同：
 *   · 文本节点 → 直接把 `kind: 'text'` 传下来；
 *   · 反推提示词 → `kind: 'image' + op: 'caption'`，由 `:374` 的 `kindForDefault` 映射过来。
 * 所以这里两条都要验：只验一条就会重犯「以为只有一条路」的错。
 */
console.log('⑥ 文本与反推：**明确报错**，不静默降级（票 76 改）')
{
  resetGenerateForTest()
  resetChannelQueueForTest()
  await saveChannel({
    id: 'ch-e', name: '渠道 E（Gemini）', protocol: 'gemini', baseUrl: 'https://e.example.com',
    models: [
      { id: 'e-img-only', label: '只出图', caps: ['image'] },
      { id: 'e-text', label: '能写文字', caps: ['text'] },
    ],
  })
  /* 旧版本这里会设 `defaultTextModel` 并期望「文本节点取到它」。
   * 票 76 之后那个键是**老键（映射到空）**，设了也不认 —— 所以这里故意设它，
   * 验的是「设了也没用，而且报错说得清」。 */
  await saveModelDefaults({ defaultTextModel: { channelId: 'ch-e', modelId: 'e-text' } })

  /* ★ 核心：文本节点那条（`kind: 'text'`）**没有默认模型可取**。 */
  const textNode = await caught(() => resolveGenerationTarget({ kind: 'text', model: '' }))
  const t = textNode.value ?? { model: '', channelId: '', from: '' }
  check('★★★ 文本节点生成（kind=text）→ **报错**，不取任何默认模型',
    textNode.value === undefined && textNode.err !== '',
    textNode.err !== '' ? '抛了：' + textNode.err.slice(0, 80) : '没抛，取到了 ' + JSON.stringify(t))
  check('★★★ 报错说清「文本统一走 dsh」（不是「还没设默认模型」那种含糊话）',
    textNode.err.includes('dsh'), textNode.err.slice(0, 120))
  check('★★ 报错里**不出现**「还没有设默认模型」（那句话会把用户引去设置里找一个不存在的勾选框）',
    !textNode.err.includes('还没有设默认模型'), textNode.err.slice(0, 160))
  check('★★ 报错里给了下一步（用 AI 生成节点 / dsh 自己的模型）',
    textNode.err.includes('AI 生成') || textNode.err.includes('dsh 自己的模型'), textNode.err.slice(0, 200))

  /* 反推提示词那条（`kind: 'image' + op: 'caption'`）→ 同样报错，说得清是「已停用」。 */
  const caption = await caught(() => resolveGenerationTarget({ kind: 'image', op: 'caption', model: '' }))
  check('★★★ 反推提示词（op=caption）→ **报错**，不取任何默认模型',
    caption.value === undefined && caption.err !== '',
    caption.err !== '' ? '抛了：' + caption.err.slice(0, 80) : '没抛，取到了 ' + JSON.stringify(caption.value))
  check('★★★ 报错里点名「反推提示词已停用」（用户能对上自己点的那颗按钮）',
    caption.err.includes('反推提示词已停用'), caption.err.slice(0, 120))
  check('★★ 报错里说清原因与现状（文本统一走 dsh / 暂时没有替代做法）',
    caption.err.includes('dsh') && caption.err.includes('替代'), caption.err.slice(0, 200))
  check('★★ 反推那条**仍然在取默认之前**就报错（不落到「没设默认」那句）',
    !caption.err.includes('还没有设默认模型'), caption.err.slice(0, 160))

  /* 两条路的报错**不一样**（一句话不能既说「已停用」又说「文本不在渠道做」）。 */
  check('★★ 两条路的报错文案不同（各自说各自的事）',
    textNode.err !== caption.err, '')

  /* 真跑一次文本生成：证明它确实失败、而且是那句说得清的话。 */
  setGenerateDeps({
    netFetch: async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '改写后的正文' }] } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })
  const done = await settle(submitGeneration({ kind: 'text', prompt: '把这段话说得更短', model: '' }).id)
  check('★★★ 文本生成任务**失败**（不是静默成功，也不是用错模型画出图）',
    done?.status === 'failed', String(done?.status))
  check('★★ 失败原因就是那句「文本统一走 dsh」',
    String(done?.error ?? '').includes('dsh'), String(done?.error ?? '').slice(0, 120))
  check('★★ 而且**没有**用到任何模型（`model` 空着，不是悄悄挑了 e-text）',
    String(done?.model ?? '') === '', String(done?.model))
}

/* ── ⑦ 图片那一格：带不带参考图取的是**同一个**默认（票 74）──────────
 *
 * ## 票 67 那一版与现在正好相反
 *
 * 票 67 把「图片」拆成文生图与图生图两格，并要求「带参考图取 i2i、不带取 t2i」，
 * 只设了一格时还要报错。用户 2026-10-29 的答复是「四个选项，手动勾选就行」，
 * 所以两格合成一格：**带不带参考图都取 `defaultImageModel`**。
 *
 * 这一段原来那 14 条断言不是被删了，是**方向反了** —— 现在验的是相反的事实：
 * 「带不带参考图取到同一个」而不是「取到不同的两个」。少一条就少了「它真的一格」的证据。
 *
 * ## ⚠️ 但「跑哪份工作流」仍然分得清
 *
 * `categoryOf` 没动：图生图与文生图仍是两份不同的 ComfyUI 工作流。
 * 那条由 `tests/category-lock.mjs` 的 48 格期望表钉着。
 */
console.log('')
console.log('⑦ 图片那一格：带不带参考图取同一个默认')

/** 一张假参考图（只用到 mime 与 bytes）。 */
const REF = { mime: 'image/png', bytes: Buffer.from(PNG_B64, 'base64') }
{
  resetGenerateForTest()
  resetChannelQueueForTest()
  await saveChannel({
    id: 'ch-split', name: '分开的渠道', protocol: 'openai', baseUrl: 'https://split.example.com',
    models: [
      { id: 'img-main', label: '图片模型', caps: ['image'] },
      { id: 'vid-only', label: '视频模型', caps: ['video'] },
    ],
  })

  /* ── ① 带不带参考图取的是同一个 ── */
  await saveModelDefaults({
    defaultImageModel: { channelId: 'ch-split', modelId: 'img-main' },
  })
  const withRefs = await caught(() => resolveGenerationTarget({ kind: 'image', model: '', refs: [REF] }))
  const w = withRefs.value ?? { model: '', from: '' }
  check('★★★ 带参考图 → 取 image 那一格的默认',
    w.model === 'img-main', withRefs.err !== '' ? '抛了：' + withRefs.err.slice(0, 60) : JSON.stringify(w))

  const noRefs = await caught(() => resolveGenerationTarget({ kind: 'image', model: '' }))
  const n = noRefs.value ?? { model: '', from: '' }
  check('★★★ 不带参考图 → 取的是**同一个**（票 74 合成一格了）',
    n.model === 'img-main', noRefs.err !== '' ? '抛了：' + noRefs.err.slice(0, 60) : JSON.stringify(n))
  check('★★★ 两次取到的**是同一个模型**（这条与票 67 那条正好相反）',
    w.model === n.model, w.model + ' / ' + n.model)

  /* `refs: []`（界面有时这么发）也走同一条。 */
  const emptyRefs = await caught(() => resolveGenerationTarget({ kind: 'image', model: '', refs: [] }))
  check('★★ refs 空数组也取同一个', (emptyRefs.value ?? {}).model === 'img-main',
    emptyRefs.err !== '' ? '抛了：' + emptyRefs.err.slice(0, 60) : JSON.stringify(emptyRefs.value))

  /* ── ② 没设图片默认时：带不带参考图报**同一句话** ── */
  await saveModelDefaults({ defaultVideoModel: { channelId: 'ch-split', modelId: 'vid-only' } })
  const missWithRefs = await caught(() => resolveGenerationTarget({ kind: 'image', model: '', refs: [REF] }))
  check('★★★ 没设图片默认 + 带参考图 → 报错（不静默）',
    missWithRefs.value === undefined && missWithRefs.err !== '',
    missWithRefs.err !== '' ? '抛了：' + missWithRefs.err.slice(0, 80) : '没抛，取到了 ' + JSON.stringify(missWithRefs.value))
  check('★★★ 报错点名的是「图片」这一格',
    missWithRefs.err.includes('图片'), missWithRefs.err.slice(0, 120))
  check('★★ 报错里给出下一步（去默认模型里选一个）',
    missWithRefs.err.includes('默认模型') && missWithRefs.err.includes('设置'), missWithRefs.err.slice(0, 160))
  const missNoRefs = await caught(() => resolveGenerationTarget({ kind: 'image', model: '' }))
  check('★★ 不带参考图时报的是**同一句话**（一格就是一句话）',
    missNoRefs.err === missWithRefs.err, missNoRefs.err.slice(0, 60))

  /* ── ③ 别的类不受影响（回归） ── */
  await saveModelDefaults({
    defaultVideoModel: { channelId: 'ch-split', modelId: 'vid-only' },
    defaultAudioModel: { channelId: 'ch-split', modelId: 'vid-only' },
  })
  check('★★ kind=video 仍取视频那一格',
    (await caught(() => resolveGenerationTarget({ kind: 'video', model: '' }))).value?.model === 'vid-only', '')
  check('★★ kind=audio 仍取音频那一格',
    (await caught(() => resolveGenerationTarget({ kind: 'audio', model: '' }))).value?.model === 'vid-only', '')
  check('★★ kind=video + 带参考图 → 仍是视频那一格（参考图不把视频变成图片）',
    (await caught(() => resolveGenerationTarget({ kind: 'video', model: '', refs: [REF] }))).value?.model === 'vid-only', '')

  /* ── ④ 但「跑哪份工作流」仍然分得清（票 74 最要紧的那条） ──
   *
   * 这一段直接调 `defaultTypeOf` 与 `categoryOf` 对比：
   * 前者给四类之一（取默认模型用），后者照样分 t2i / i2i（选工作流用）。 */
  const { defaultTypeOf } = await import('../src/schedule/generate.ts')
  const { categoryOf } = await import('../src/schedule/generate.ts')
  check('★★★ 取默认模型那一步：带不带参考图都是 image（票 74 合成一格）',
    defaultTypeOf({ kind: 'image', refs: [REF] }) === 'image'
    && defaultTypeOf({ kind: 'image' }) === 'image',
    JSON.stringify([defaultTypeOf({ kind: 'image', refs: [REF] }), defaultTypeOf({ kind: 'image' })]))
  check('★★★ 选工作流那一步：带不带参考图仍分 t2i / i2i（一个字没退）',
    categoryOf('image', false) === 't2i' && categoryOf('image', true) === 'i2i',
    categoryOf('image', false) + ' / ' + categoryOf('image', true))
  check('★★★ 两件事在同一个请求上给出不同结论（这就是它们必须分开的证据）',
    defaultTypeOf({ kind: 'image', refs: [REF] }) === 'image'
    && categoryOf('image', true) === 'i2i', '')
}

console.log('')
if (bad === 0) console.log('全部通过 ✓')
else { console.log('有 ' + String(bad) + ' 条不通过 ✗'); process.exitCode = 1 }
