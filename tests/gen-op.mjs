/** 图像操作 + 遮罩 + 提及解析（契约 T1，2026-10-26）。
 *
 * # ⚠️ 不连真 ComfyUI、不连外网
 *
 * 全走注入的假 `fetchImpl`。验的是「op 映射对不对、遮罩真进了上传、缺工作流时那句人话、
 * 提及解析的九种写法」，**不验**本机 ComfyUI 能真出一张图（它现在没在跑）。
 *
 * 跑法：node --import <tsx> tests/gen-op.mjs
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-genop-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const {
  categoryOf, workflowMissingWhy, filterModelsByOp, pickWorkflow, listModels,
  submitGeneration, getTask, setGenerateDeps, resetGenerateForTest,
} = await import('../src/schedule/generate.ts')
const { runComfyGeneration, textsOfHistory } = await import('../src/schedule/comfyui.ts')
const { saveChannel, deleteChannel } = await import('../src/schedule/channels.ts')
const { resetChannelQueueForTest } = await import('../src/schedule/channel-queue.ts')
const { resolveMentions, listMentions } = await import('../src/schedule/mentions.ts')
const { GEN_OPS, isGenOp, GenError } = await import('../src/schedule/net-gen.ts')
const { defaultWorkflowOf, availableWorkflowsOf } = await import('../src/schedule/comfyui-workflows/registry.ts')

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
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/* ── ① op 映射 ───────────────────────────────────────────────────── */

console.log('① 五个 op 各映射到哪一类')
{
  const cases = [
    ['inpaint', 'inpaint'],
    ['upscale', 'upscale'],
    ['superResolve', 'superResolve'],
    ['caption', 'text'],
    ['angle', 'angle'],
  ]
  for (const [op, want] of cases) {
    const got = categoryOf('image', false, op)
    check('★★ ' + op + ' → ' + want, got === want, got)
  }
  check('★★ GEN_OPS 正好是这五个', GEN_OPS.join(',') === 'inpaint,upscale,superResolve,caption,angle',
    GEN_OPS.join(','))
  check('★ 不认识的值 isGenOp 为假', isGenOp('blur') === false && isGenOp('') === false)
}

console.log('② 不给 op 时行为一字不变')
{
  check('★★ categoryOf(image, false) 仍是 t2i', categoryOf('image', false) === 't2i',
    categoryOf('image', false))
  check('★★ categoryOf(image, true) 仍是 i2i', categoryOf('image', true) === 'i2i',
    categoryOf('image', true))
  check('★★ categoryOf(video, true) 仍是 omniVideo', categoryOf('video', true) === 'omniVideo',
    categoryOf('video', true))
  check('★★ categoryOf(text, false) 仍是 text', categoryOf('text', false) === 'text',
    categoryOf('text', false))
  check('★★ categoryOf(audio, false) 仍是 audio', categoryOf('audio', false) === 'audio',
    categoryOf('audio', false))
  /* op 优先于 kind：给了 upscale 就是 upscale，不再看 hasRefs。 */
  check('★★ 给了 op 时不再看 hasRefs', categoryOf('image', true, 'upscale') === 'upscale',
    categoryOf('image', true, 'upscale'))
}

/* ── ③ 缺工作流时那句人话 ─────────────────────────────────────────── */

console.log('③ 三类内置没有的工作流，文案要说清「没挂 + 去配置」')
{
  const three = ['superResolve', 'angle', 'upscale']
  for (const cat of three) {
    const why = workflowMissingWhy(cat)
    const ok = why.includes('没挂') && why.includes('渠道设置') && why.includes('内置清单里也没有')
    check('★★ ' + cat + ' 的文案说清了没挂、去哪配、内置没有', ok, why)
  }
  /* 内置有的类别（t2i）不该说「内置清单里也没有」。 */
  const t2iWhy = workflowMissingWhy('t2i')
  check('★★ 内置有的类别不谎称「内置里也没有」', !t2iWhy.includes('内置清单里也没有'), t2iWhy)
  /* 不能是 developer 味的英文类别名收尾。 */
  check('★ 文案带中文类别名「超分」', workflowMissingWhy('superResolve').includes('超分'),
    workflowMissingWhy('superResolve'))
  /* pickWorkflow 对这三类真的返回 null（前提核实，不是断言我们的代码）。 */
  for (const cat of three) {
    check('★ ' + cat + ' 确实是内置没有的那三类之一（pickWorkflow 给 null）',
      pickWorkflow({}, cat) === null, String(pickWorkflow({}, cat)))
  }
}

console.log('③b 钉住前提：superResolve / upscale / angle 三类内置一个都没有')
{
  /* ⚠️ 这一段守的是**文案的正确性**，不是功能。
   *
   * `workflowMissingWhy` 分两个分支：
   * · 内置没有这一类 → 「…内置清单里也没有这一类…」
   * · 内置有、但渠道显式清掉了 → 「…或清掉那个配置让内置的接管…」
   *
   * 现在 `superResolve` / `upscale` / `angle` 走第一支。**如果哪天有人给这三类
   * 补了内置工作流**（比如把参考项目里那几份导入进来），第一支的话就成了假话 ——
   * 用户会看到「内置清单里也没有这一类」，而其实有。
   *
   * 所以这里把「一个都没有」钉成断言：真补上内置时，这条会红，逼着去改文案的判据。
   * 断言用的是编辑内置清单就会变的真实函数（`defaultWorkflowOf` /
   * `availableWorkflowsOf`），不是自己写死的一份名单。 */
  const three = ['superResolve', 'upscale', 'angle']
  for (const cat of three) {
    check('★★ ' + cat + ' 没有默认工作流（defaultWorkflowOf 给 undefined）',
      defaultWorkflowOf(cat) === undefined, String(defaultWorkflowOf(cat)))
    check('★★ ' + cat + ' 一个候选都没有（availableWorkflowsOf 给空数组）',
      availableWorkflowsOf(cat).length === 0,
      String(availableWorkflowsOf(cat).length) + ' 份')
  }
  /* 反向对照：`inpaint` **有**内置默认（`inpaint-qwen-image`）。
   * 有了这条，上面三条才是「这三类真的特殊」，而不是「这个函数对谁都返回 undefined」。 */
  check('★★ 对照：inpaint 有内置默认（说明上面三条不是函数恒空）',
    defaultWorkflowOf('inpaint') !== undefined,
    String(defaultWorkflowOf('inpaint')?.id))
}

console.log('③c 文案的两支都要被验到（不只验现在走的那一支）')
{
  /* ③b 钉住了「这三类确实没有内置」。但**只验当前走的那一支是不够的** ——
   * 如果 `workflowMissingWhy` 哪天被改成只会说一句「没挂，去配」，
   * 那么「内置有、只是渠道清掉了」那种情况就会得到一句不完整的话，
   * 而 ③b 仍然是绿的。
   *
   * 所以这里把**两支都验一遍**：内置没有的一类（upscale）走第一支，
   * 内置有的一类（inpaint）走第二支，且两句必须真的不同。
   * 靠的是真实函数在两种输入下的输出，不是比对写死的字符串。 */
  const withoutBuiltin = workflowMissingWhy('upscale')
  const withBuiltin = workflowMissingWhy('inpaint')
  check('★★ 两支文案确实不同（说明 workflowMissingWhy 真的按「内置有没有」分叉）',
    withBuiltin !== withoutBuiltin, withoutBuiltin.slice(0, 24) + '… / ' + withBuiltin.slice(0, 24) + '…')
  check('★★ 现在走的是「内置没有」那一支（含「内置清单里也没有」）',
    withoutBuiltin.includes('内置清单里也没有'), withoutBuiltin)
  check('★★ 内置有的类别走另一支（不含「内置清单里也没有」）',
    !withBuiltin.includes('内置清单里也没有'), withBuiltin)
  check('★★ 内置有的那一支说「清掉那个配置让内置的接管」',
    withBuiltin.includes('让内置的接管'), withBuiltin)
}

/* ── ④ 遮罩真的进了 ComfyUI 上传调用 ────────────────────────────────── */

/**
 * 一个能跑通 runComfyGeneration 全流程的假 ComfyUI（上传 → 提交 → 轮询 → 下载）。
 * @param {object} [overrides] - `{outputs}`：换掉 `/history` 回的那份 outputs（验文本产出用）。
 */
function fakeComfy(overrides = {}) {
  const calls = []
  const outputs = overrides.outputs ?? { 9: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } }
  const impl = async (url, init = {}) => {
    const u = String(url)
    const method = String(init.method ?? 'GET').toUpperCase()
    calls.push({ url: u, method, body: init.body })
    /* 上传：回一个文件名。**这条是关键** —— 遮罩的字节要出现在这里。 */
    if (u.includes('/upload/image')) {
      const form = init.body
      /* FormData 里的文件名：取我们给的那个（`uploadImage` 会加随机前缀）。 */
      let name = 'uploaded.png'
      try {
        const f = form.get('image')
        if (f !== null && f !== undefined) name = 'up_' + String(f.name ?? name)
      } catch { /* 不是 FormData 就用默认名 */ }
      return new Response(JSON.stringify({ name, subfolder: '', type: 'input' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    /* 提交：回 prompt_id。 */
    if (u.includes('/prompt')) {
      return new Response(JSON.stringify({ prompt_id: 'job-1' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    /* 系统状态（探测 OS）。 */
    if (u.includes('/system_stats')) {
      return new Response(JSON.stringify({ system: { os: 'nt' } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    /* 历史：直接回 done + 产出（默认一张图，可用 overrides 换）。 */
    if (u.includes('/history/')) {
      return new Response(JSON.stringify({
        'job-1': {
          status: { status_str: 'success', completed: true },
          outputs,
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    /* 队列：空。 */
    if (u.includes('/queue')) {
      return new Response(JSON.stringify({ queue_running: [], queue_pending: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    /* 取产出字节。 */
    if (u.includes('/view')) {
      return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  impl.calls = calls
  return impl
}

/** 一份含遮罩槽位的工作流（照 ComfyUI 真格式：节点编号为键）。 */
function inpaintWorkflow() {
  return {
    3: { class_type: 'CLIPTextEncode', inputs: { text: '原来的提示词', clip: ['1', 0] }, _meta: { title: 'prompt' } },
    10: { class_type: 'LoadImage', inputs: { image: 'placeholder.png' }, _meta: { title: 'ref_image_01' } },
    /* 遮罩槽位：`ref_mask` 这个名字（三个认法之一）。 */
    11: { class_type: 'LoadImageMask', inputs: { image: 'mask.png', channel: 'red' }, _meta: { title: 'ref_mask' } },
    9: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
  }
}

console.log('④ 遮罩真的被上传，且填进了 ref_mask 槽位')
{
  const fetchImpl = fakeComfy()
  const MASK = Buffer.from('mask-bytes-1234567890', 'utf8')
  const out = await runComfyGeneration({
    channel: {
      id: 'ch-comfy', name: '本地', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
      models: [], maxConcurrency: 1,
    },
    category: 'inpaint',
    workflow: inpaintWorkflow(),
    bindings: { prompt: '把背景换掉' },
    refMask: { name: 'mask.png', bytes: MASK, mime: 'image/png' },
    http: { fetchImpl },
    sleep: async () => { /* 不真睡 */ },
  })
  /* ① 上传调用里有几次？遮罩必须占一次。 */
  const uploads = fetchImpl.calls.filter(c => c.url.includes('/upload/image'))
  check('★★ 遮罩走了一次上传（两次上传：遮罩只有一个，参考图没给）', uploads.length === 1,
    String(uploads.length))
  /* ② 上传的是遮罩的字节（从 FormData 里把 blob 读出来比字节）。 */
  let uploadedBytesHex = ''
  let uploadedName = ''
  try {
    const fd = uploads[0].body
    const blob = fd.get('image')
    uploadedName = String(blob?.name ?? '')
    const buf = Buffer.from(await blob.arrayBuffer())
    uploadedBytesHex = buf.toString('hex')
  } catch (e) {
    uploadedBytesHex = 'no-formdata: ' + String(e)
  }
  check('★★ 上传的字节就是遮罩的字节', uploadedBytesHex === MASK.toString('hex'),
    uploadedBytesHex.slice(0, 40))
  check('★ 上传的文件名认得出是遮罩', uploadedName.includes('mask'), uploadedName)

  /* ③ 提交出去的 workflow 里，遮罩槽位拿到的是**上传返回的文件名**（不是本地路径）。 */
  const submitCall = fetchImpl.calls.find(c => c.url.includes('/prompt'))
  let maskSlotValue = ''
  try {
    const body = JSON.parse(String(submitCall.body))
    maskSlotValue = String(body.prompt['11'].inputs.image ?? '')
  } catch (e) {
    maskSlotValue = 'parse-fail: ' + String(e)
  }
  check('★★ ref_mask 槽位拿到的是上传后的文件名', maskSlotValue.startsWith('up_') && maskSlotValue.includes('mask'),
    maskSlotValue)
  check('★★ 而且不是本地路径/原文件名', maskSlotValue !== 'mask.png', maskSlotValue)
  check('★ 全流程跑完了（有产出字节）', out.files.length === 1 && out.files[0].bytes.length > 0,
    String(out.files.length))
}

console.log('⑤ 不给遮罩时，上传调用里没有遮罩那一次')
{
  const fetchImpl = fakeComfy()
  await runComfyGeneration({
    channel: {
      id: 'ch-comfy', name: '本地', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
      models: [], maxConcurrency: 1,
    },
    category: 'inpaint',
    workflow: inpaintWorkflow(),
    bindings: { prompt: '把背景换掉' },
    http: { fetchImpl },
    sleep: async () => { /* 不真睡 */ },
  })
  const uploads = fetchImpl.calls.filter(c => c.url.includes('/upload/image'))
  check('★★ 没给遮罩 → 一次上传都没有', uploads.length === 0, String(uploads.length))
}

console.log('⑥ 网络模型渠道收到 op / mask 时明确报错（不静默忽略）')
{
  /* 直接调 generateOnChannel 太绕（要完整 channel），这里验 GenError 的形状够不够读懂。
   * 真正「抛不抛」由 `net-gen.mjs` 已有的 ②b 段覆盖；这里只补一条遮罩的。
   * ⚠️ 构造是 `(message, kind)` —— 顺序反了会得到一个 message 为 `'unsupported'` 的错。 */
  const e = new GenError('网络模型的接口没有遮罩（mask）这个参数：请改用 ComfyUI 渠道做局部重绘', 'unsupported')
  check('★ GenError 的 kind 是 unsupported', e.kind === 'unsupported', e.kind)
  check('★ 文案说清了「没有这个参数」与「该用什么」',
    e.message.includes('没有遮罩') && e.message.includes('ComfyUI'), e.message)
}

/* ── ⑥b 反推提示词（caption）端到端：文本产出这条链真的通了 ──────────── */

/** 等一个任务到终态（最多 8 秒）。 */
async function settle(id) {
  const deadline = Date.now() + 8000
  for (;;) {
    const t = getTask(id)
    if (t !== null && (t.status === 'success' || t.status === 'failed')) return t
    if (Date.now() > deadline) return getTask(id)
    await new Promise(done => setTimeout(done, 10))
  }
}

/** 一份文本工作流（照 `text_qwen3_5_api.json` 的真槽位：prompt + ref_image_01 + output_text）。 */
function textWorkflow() {
  return {
    3: { class_type: 'PrimitiveStringMultiline', inputs: { value: '' }, _meta: { title: 'prompt' } },
    10: { class_type: 'LoadImage', inputs: { image: 'p.png' }, _meta: { title: 'ref_image_01' } },
    12: { class_type: 'ShowAny', inputs: { anything: ['3', 0] }, _meta: { title: 'output_text' } },
    9: { class_type: 'KSampler', inputs: { seed: 0 }, _meta: { title: 'seed' } },
  }
}

console.log('⑥b 反推提示词端到端：只有文本也算成功，文本进了产出')
{
  resetGenerateForTest()
  resetChannelQueueForTest()
  await saveChannel({
    id: 'ch-txt', name: '文字渠道', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    models: [{ id: 'local', label: '本地模型', caps: ['image'] }],
    comfyuiTextWorkflow: textWorkflow(),
  })

  /* ① 只有文本、没有文件 —— 这一类必须成功（原先这里是「没有产出文件」判失败）。 */
  setGenerateDeps({
    comfyHttp: {
      fetchImpl: fakeComfy({ outputs: { 12: { text: ['一只白猫坐在窗台上，水彩风格'] } } }),
    },
    sleep: async () => { /* 不真睡 */ },
  })
  const t1 = await settle(submitGeneration({
    kind: 'image', op: 'caption', prompt: '描述这张图', model: 'local', channelId: 'ch-txt',
    refs: [{ mime: 'image/png', bytes: PNG }],
  }).id)
  check('★★ caption 只有文本没有文件 → 任务成功（不再判「没有产出文件」）',
    t1?.status === 'success', String(t1?.status) + ' / ' + String(t1?.error ?? ''))
  check('★★ caption 的文本进了产出（一条 text/plain 产物）',
    (t1?.artifacts?.length ?? 0) === 1 && String(t1?.artifacts?.[0]?.mime).startsWith('text/plain'),
    JSON.stringify((t1?.artifacts ?? []).map(a => a.mime)))
  check('★★ 而且产物里有内容（不是 0 字节占位）',
    (t1?.artifacts?.[0]?.bytes ?? 0) > 0, String(t1?.artifacts?.[0]?.bytes))

  /* ② 既有文本又有文件 —— 两者都要在。 */
  setGenerateDeps({
    comfyHttp: {
      fetchImpl: fakeComfy({
        outputs: {
          12: { text: ['一段描述'] },
          13: { images: [{ filename: 'preview.png', subfolder: '', type: 'output' }] },
        },
      }),
    },
    sleep: async () => { /* 不真睡 */ },
  })
  const t2 = await settle(submitGeneration({
    kind: 'image', op: 'caption', prompt: '描述这张图', model: 'local', channelId: 'ch-txt',
    refs: [{ mime: 'image/png', bytes: PNG }],
  }).id)
  const mimes2 = (t2?.artifacts ?? []).map(a => a.mime)
  check('★★ caption 既有文本又有文件 → 两者都在（2 条产物）',
    t2?.status === 'success' && mimes2.length === 2,
    String(t2?.status) + ' / ' + mimes2.join(','))
  check('★★ 两个都在：一条文本一条图片',
    mimes2.some(m => String(m).startsWith('text/plain')) && mimes2.some(m => String(m).startsWith('image/')),
    mimes2.join(','))

  /* ③ 图片 / 视频那几类：只有文本没有文件 → **仍然判失败**（它们要的确实是文件）。
   *
   * ⚠️ 必须重设依赖：不改 `fetchImpl` 的话上一个用例那份「有图」的假响应还在。 */
  setGenerateDeps({
    comfyHttp: { fetchImpl: fakeComfy({ outputs: { 12: { text: ['一段描述'] } } }) },
    sleep: async () => { /* 不真睡 */ },
  })
  await saveChannel({
    id: 'ch-img', name: '图片渠道', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    models: [{ id: 'local', label: '本地模型', caps: ['image'] }],
  })
  const t3 = await settle(submitGeneration({
    kind: 'image', prompt: '一只白猫', model: 'local', channelId: 'ch-img',
  }).id)
  check('★★ image 类只有文本没有文件 → 仍然判失败（不因为没有文件而放过）',
    t3?.status === 'failed', String(t3?.status) + ' / ' + String(t3?.error ?? ''))
  check('★★ 失败原因说的是「没有产出文件」那条（不是文本那条）',
    String(t3?.error ?? '').includes('没有产出文件'), String(t3?.error ?? ''))

  /* 收拾现场：⑥b 建的渠道不能留给后面的 ⑦（它按渠道数断言）。 */
  await deleteChannel('ch-txt')
  await deleteChannel('ch-img')
  resetGenerateForTest()
}

/** `textsOfHistory` 的单独判据（与 comfyui-http 那份互补：这里验整条链用到的形状）。 */
console.log('⑥c textsOfHistory 单独判据')
{
  const h = { j: { outputs: { 1: { text: ['甲'] }, 2: { text: ['乙'] } } } }
  check('★★ 多个节点的文本按顺序全取出来', textsOfHistory(h, 'j').join('|') === '甲|乙',
    JSON.stringify(textsOfHistory(h, 'j')))
}

/* ── ⑥d `caption` 走网络模型：强制按 text 判能力与发请求 ───────────────── */

console.log('⑥d caption 走网络模型：按 text 判能力，不按调用方给的 kind')
{
  resetGenerateForTest()
  resetChannelQueueForTest()
  /* 一个**只会画图**的模型（没有 text 能力）。 */
  await saveChannel({
    id: 'ch-onlyimg', name: '只会画图', protocol: 'openai', baseUrl: 'http://127.0.0.1:9',
    models: [{ id: 'img-1', label: '出图', caps: ['image'] }],
  })
  setGenerateDeps({ netFetch: async () => new Response(JSON.stringify({ data: [] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }) })

  /* 以前按调用方给的 `kind: 'image'` 判能力 → 放行 → 它真去画图（回来一张图，不是描述）。
   * 现在按 `text` 判 → 在动手之前就被拦住。 */
  const t1 = await settle(submitGeneration({
    kind: 'image', op: 'caption', prompt: '描述这张图', model: 'img-1', channelId: 'ch-onlyimg',
    refs: [{ mime: 'image/png', bytes: PNG }],
  }).id)
  check('★★ 只会画图的模型做 caption → 提交后被能力校验拦住（不静默去画图）',
    t1?.status === 'failed', String(t1?.status))
  check('★★ 拦的理由是「没有 text 能力」（不是 image）',
    String(t1?.error ?? '').includes('没有「text」能力'), String(t1?.error ?? ''))

  /* 换成**真有 text 能力**的模型 —— 它该过能力校验，并且请求按 text 发出去（不出图）。 */
  await saveChannel({
    id: 'ch-textok', name: '能读图答字', protocol: 'gemini', baseUrl: 'http://127.0.0.1:9',
    models: [{ id: 'gemini-2.5-flash', label: '看图答字', caps: ['image', 'text'] }],
  })
  const seenBodies = []
  setGenerateDeps({
    netFetch: async (url, init = {}) => {
      seenBodies.push(String(init.body ?? ''))
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '一只白猫坐在窗台上' }] } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const t2 = await settle(submitGeneration({
    kind: 'image', op: 'caption', prompt: '描述这张图', model: 'gemini-2.5-flash', channelId: 'ch-textok',
    refs: [{ mime: 'image/png', bytes: PNG }],
  }).id)
  check('★★ 有 text 能力的模型能做完 caption', t2?.status === 'success',
    String(t2?.status) + ' / ' + String(t2?.error ?? ''))
  check('★★ 请求里没有要图的 responseModalities（按 text 发的，不是去画图）',
    seenBodies.length === 1 && !seenBodies[0].includes('responseModalities'),
    seenBodies.join(' | ').slice(0, 120))
  check('★★ 结果是一条 text/plain 产物（就是那段描述）',
    (t2?.artifacts?.length ?? 0) === 1 && String(t2?.artifacts?.[0]?.mime).startsWith('text/plain'),
    JSON.stringify((t2?.artifacts ?? []).map(a => a.mime)))

  await deleteChannel('ch-onlyimg')
  await deleteChannel('ch-textok')
  resetGenerateForTest()
}

/* ── ⑥e 尺寸写法：比例真算出宽高，认不出来就失败 ────────────────────── */

console.log('⑥e 尺寸写法（`size`）：比例要真算出宽高，认不出来要失败')
{
  resetGenerateForTest()
  resetChannelQueueForTest()
  await saveChannel({
    id: 'ch-size', name: '尺寸渠道', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    models: [{ id: 'local', label: '本地模型', caps: ['image'] }],
  })

  /** 截获提交出去的 workflow（看 width/height 槽位填了什么）。 */
  function sizeProbe() {
    const fetchImpl = fakeComfy()
    const orig = fetchImpl
    const wrapped = async (url, init = {}) => {
      const res = await orig(url, init)
      return res
    }
    wrapped.calls = fetchImpl.calls
    return wrapped
  }

  /** 从提交调用里读出某个槽位节点填的值。 */
  function slotOf(calls, nodeId) {
    const submit = calls.find(c => String(c.url).includes('/prompt'))
    if (submit === undefined) return null
    try {
      const body = JSON.parse(String(submit.body))
      return body.prompt?.[nodeId]?.inputs ?? null
    } catch { return null }
  }

  /* 一份带 width/height 槽位的工作流（照 `qwen_image_21_api.json` 的真实槽位名）。 */
  function sizedWorkflow() {
    return {
      3: { class_type: 'PrimitiveStringMultiline', inputs: { value: '' }, _meta: { title: 'prompt' } },
      4: { class_type: 'PrimitiveInt', inputs: { value: 512 }, _meta: { title: 'width' } },
      5: { class_type: 'PrimitiveInt', inputs: { value: 512 }, _meta: { title: 'height' } },
      9: { class_type: 'KSampler', inputs: { seed: 0 }, _meta: { title: 'seed' } },
    }
  }
  await saveChannel({
    id: 'ch-size', name: '尺寸渠道', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    models: [{ id: 'local', label: '本地模型', caps: ['image'] }],
    comfyuiT2iWorkflow: sizedWorkflow(),
  })

  /* ① `16:9` 这种比例 → **真算出宽高并填进槽位**（以前静默不填）。 */
  {
    const probe = sizeProbe()
    setGenerateDeps({ comfyHttp: { fetchImpl: probe }, sleep: async () => { /* 不真睡 */ } })
    const t = await settle(submitGeneration({
      kind: 'image', prompt: '一只猫', model: 'local', channelId: 'ch-size', size: '16:9',
    }).id)
    const w = slotOf(probe.calls, '4')
    const h = slotOf(probe.calls, '5')
    check('★★ 16:9 算出了宽高并填进槽位（不是保持 512）',
      w?.value !== 512 && h?.value !== 512, JSON.stringify({ w: w?.value, h: h?.value }))
    check('★★ 宽高是 16:9 的比例（宽 > 高 且 短边 1024）',
      Number(w?.value) === 1820 && Number(h?.value) === 1024,
      String(w?.value) + 'x' + String(h?.value))
    check('★★ 而且任务成功（比例写法不再被当成没填）', t?.status === 'success',
      String(t?.status) + ' / ' + String(t?.error ?? ''))
  }

  /* ② 像素写法照旧。 */
  {
    const probe = sizeProbe()
    setGenerateDeps({ comfyHttp: { fetchImpl: probe }, sleep: async () => { /* 不真睡 */ } })
    await settle(submitGeneration({
      kind: 'image', prompt: '一只猫', model: 'local', channelId: 'ch-size', size: '800x600',
    }).id)
    check('★★ 800x600 逐字填进槽位',
      Number(slotOf(probe.calls, '4')?.value) === 800 && Number(slotOf(probe.calls, '5')?.value) === 600,
      JSON.stringify({ w: slotOf(probe.calls, '4')?.value, h: slotOf(probe.calls, '5')?.value }))
  }

  /* ③ 认不出来的写法 → **任务失败**，且原因说清（不许静默 `{}`）。 */
  {
    const probe = sizeProbe()
    setGenerateDeps({ comfyHttp: { fetchImpl: probe }, sleep: async () => { /* 不真睡 */ } })
    const t = await settle(submitGeneration({
      kind: 'image', prompt: '一只猫', model: 'local', channelId: 'ch-size', size: '大一点',
    }).id)
    check('★★ 认不出的尺寸写法 → 任务失败（不是静默不填）', t?.status === 'failed',
      String(t?.status) + ' / ' + String(t?.error ?? ''))
    check('★★ 失败原因说出了「认不出来」与能写的那几种',
      String(t?.error ?? '').includes('尺寸写法认不出来')
      && String(t?.error ?? '').includes('1024x1024')
      && String(t?.error ?? '').includes('16:9'),
      String(t?.error ?? ''))
    check('★★ 失败时**没有**提交给 ComfyUI（白跑一次更糟）',
      probe.calls.filter(c => String(c.url).includes('/prompt')).length === 0,
      String(probe.calls.length))
  }

  /* ④ 中文冒号那一种，原因要专门点出来。 */
  {
    const probe = sizeProbe()
    setGenerateDeps({ comfyHttp: { fetchImpl: probe }, sleep: async () => { /* 不真睡 */ } })
    const t = await settle(submitGeneration({
      kind: 'image', prompt: '一只猫', model: 'local', channelId: 'ch-size', size: '16：9',
    }).id)
    check('★★ 中文冒号 → 失败，并点明「写成了中文冒号」',
      t?.status === 'failed' && String(t?.error ?? '').includes('中文冒号'),
      String(t?.error ?? ''))
  }

  await deleteChannel('ch-size')
  resetGenerateForTest()
}

/* ── ⑥f 负面提示词真进槽位 ──────────────────────────────────────────── */

console.log('⑥f negativePrompt 真填进工作流（原来只进记录、不进槽位）')
{
  resetGenerateForTest()
  resetChannelQueueForTest()

  /** 从提交调用里读出某节点的 inputs。 */
  function inputsOf(calls, nodeId) {
    const submit = calls.find(c => String(c.url).includes('/prompt'))
    if (submit === undefined) return null
    try { return JSON.parse(String(submit.body)).prompt?.[nodeId]?.inputs ?? null } catch { return null }
  }

  /* ① 内置那一份的**实际标题**：`"CLIP Text Encode (Negative Prompt)"`，
   *    不是 `negative`。照 `inpaint_qwen_image_api.json` 的节点 277 写。 */
  function builtinShapedWorkflow() {
    return {
      298: { class_type: 'PrimitiveStringMultiline', inputs: { value: '' }, _meta: { title: 'prompt' } },
      289: { class_type: 'LoadImage', inputs: { image: 'p.png' }, _meta: { title: 'ref_image_01' } },
      299: { class_type: 'LoadImage', inputs: { image: 'mask.png' }, _meta: { title: 'ref_mask' } },
      277: {
        class_type: 'CLIPTextEncode',
        inputs: { text: ' ', clip: ['275', 0] },
        _meta: { title: 'CLIP Text Encode (Negative Prompt)' },
      },
    }
  }
  await saveChannel({
    id: 'ch-neg', name: '负向渠道', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    models: [{ id: 'local', label: '本地模型', caps: ['image'] }],
    comfyuiT2iWorkflow: builtinShapedWorkflow(),
  })
  const probe = fakeComfy()
  setGenerateDeps({ comfyHttp: { fetchImpl: probe }, sleep: async () => { /* 不真睡 */ } })
  await settle(submitGeneration({
    kind: 'image', prompt: '一只白猫', negativePrompt: '糊的、多手指', model: 'local', channelId: 'ch-neg',
  }).id)
  const neg = inputsOf(probe.calls, '277')
  check('★★ 负面提示词真填进了那个标题是整句的槽位（原来永远是 " "）',
    neg?.text === '糊的、多手指', JSON.stringify(neg?.text))
  check('★★ 而且正向提示词没被写进负面节点（两个槽位分开）',
    neg?.text !== '一只白猫', JSON.stringify(neg?.text))
  const pos = inputsOf(probe.calls, '298')
  check('★★ 正向提示词仍在自己的槽位（没互相覆盖）', pos?.value === '一只白猫', JSON.stringify(pos?.value))

  /* ② 不给负面提示词时，那个槽位保持原样（不写空串、不写 undefined）。 */
  const probe2 = fakeComfy()
  setGenerateDeps({ comfyHttp: { fetchImpl: probe2 }, sleep: async () => { /* 不真睡 */ } })
  await settle(submitGeneration({
    kind: 'image', prompt: '一只白猫', model: 'local', channelId: 'ch-neg',
  }).id)
  check('★★ 不给负面提示词 → 那个槽位保持原值 " "（不被写成空串）',
    inputsOf(probe2.calls, '277')?.text === ' ', JSON.stringify(inputsOf(probe2.calls, '277')?.text))

  /* ③ 用户自己导入的工作流常见的三种写法也都认。 */
  for (const [label, title] of [['negative', 'negative'], ['negative_prompt', 'negative_prompt'], ['中文', '负面提示词']]) {
    const wf = {
      1: { class_type: 'PrimitiveStringMultiline', inputs: { value: '' }, _meta: { title: 'prompt' } },
      2: { class_type: 'PrimitiveStringMultiline', inputs: { value: '旧值' }, _meta: { title } },
    }
    await saveChannel({
      id: 'ch-neg2', name: '负向渠道2', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
      models: [{ id: 'local', label: '本地模型', caps: ['image'] }],
      comfyuiT2iWorkflow: wf,
    })
    const p = fakeComfy()
    setGenerateDeps({ comfyHttp: { fetchImpl: p }, sleep: async () => { /* 不真睡 */ } })
    await settle(submitGeneration({
      kind: 'image', prompt: '猫', negativePrompt: '别糊', model: 'local', channelId: 'ch-neg2',
    }).id)
    check('★★ 标题写成「' + label + '」也认', inputsOf(p.calls, '2')?.value === '别糊',
      JSON.stringify(inputsOf(p.calls, '2')?.value))
  }

  /* ④ **标题里一个 negative 都没有，负向是「字段名」** —— 这是第二处可填的地方，
   *    照 `qwen_image_21_api.json` 的真实形状：`node 512` 是 `TextEncodeQwenImage21`，
   *    标题「文本编码 Qwen Image 2.1」，负向文本在 `inputs.negative_prompt: ""`。
   *
   *    只按标题认的话，这份工作流一个字都填不进去，而按标题写的断言全绿。 */
  {
    const wf = {
      /* 正向：靠标题 `prompt` 认（这一份的实际做法，节点 485）。 */
      485: { class_type: 'PrimitiveStringMultiline', inputs: { value: '旧正向' }, _meta: { title: 'prompt' } },
      /* 负向：标题完全不含 negative，靠**字段名** `negative_prompt` 认（节点 512）。 */
      512: {
        class_type: 'TextEncodeQwenImage21',
        inputs: { prompt: ['485', 0], negative_prompt: '', resolution: 0 },
        _meta: { title: '文本编码 Qwen Image 2.1' },
      },
    }
    await saveChannel({
      id: 'ch-fieldfull', name: '字段名渠道', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
      models: [{ id: 'local', label: '本地模型', caps: ['image'] }],
      comfyuiT2iWorkflow: wf,
    })
    const p = fakeComfy()
    setGenerateDeps({ comfyHttp: { fetchImpl: p }, sleep: async () => { /* 不真睡 */ } })
    await settle(submitGeneration({
      kind: 'image', prompt: '一只白猫', negativePrompt: '糊的、多手指', model: 'local', channelId: 'ch-fieldfull',
    }).id)
    check('★★ 标题不含 negative、靠**字段名** negative_prompt 也填得进（qwen_image_21 那份的形状）',
      inputsOf(p.calls, '512')?.negative_prompt === '糊的、多手指',
      JSON.stringify(inputsOf(p.calls, '512')?.negative_prompt))
    check('★★ 同一份里正向仍进它自己的槽位（两个判据互不吃掉）',
      inputsOf(p.calls, '485')?.value === '一只白猫', JSON.stringify(inputsOf(p.calls, '485')?.value))
    /* 连线不是可填的文本：`KSampler.inputs.negative` 是 `["512",0]`，往那写会把工作流写坏。 */
    const wfLink = {
      1: { class_type: 'PrimitiveStringMultiline', inputs: { value: '' }, _meta: { title: 'prompt' } },
      9: { class_type: 'KSampler', inputs: { seed: 0, negative: ['1', 0] }, _meta: { title: 'seed' } },
    }
    await saveChannel({
      id: 'ch-link', name: '连线渠道', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
      models: [{ id: 'local', label: '本地模型', caps: ['image'] }],
      comfyuiT2iWorkflow: wfLink,
    })
    const p2 = fakeComfy()
    setGenerateDeps({ comfyHttp: { fetchImpl: p2 }, sleep: async () => { /* 不真睡 */ } })
    await settle(submitGeneration({
      kind: 'image', prompt: '猫', negativePrompt: '别糊', model: 'local', channelId: 'ch-link',
    }).id)
    const ks = inputsOf(p2.calls, '9')
    check('★★ 键名 negative 但是**连线**（["1",0]）→ 不被写坏',
      Array.isArray(ks?.negative) && ks.negative[0] === '1', JSON.stringify(ks?.negative))
    await deleteChannel('ch-fieldfull')
    await deleteChannel('ch-link')
  }

  await deleteChannel('ch-neg')
  await deleteChannel('ch-neg2')
  resetGenerateForTest()
}

/* ── ⑥g `count`：填进建 Latent 那个节点的 batch_size ─────────────────── */

console.log('⑥g count 填进 batch_size（按结构找，不按标题）')
{
  resetGenerateForTest()
  resetChannelQueueForTest()

  /** 从提交调用里读出某节点 inputs。 */
  function inputsOf(calls, nodeId) {
    const submit = calls.find(c => String(c.url).includes('/prompt'))
    if (submit === undefined) return null
    try { return JSON.parse(String(submit.body)).prompt?.[nodeId]?.inputs ?? null } catch { return null }
  }

  /* 照 `qwen_image_21_api.json` 的真实形状：507 号节点是 `EmptyLatentImage`，
   * 标题是描述性的「空Latent图像」，**不是槽位标记**，`batch_size: 1`。 */
  function latentWorkflow() {
    return {
      3: { class_type: 'PrimitiveStringMultiline', inputs: { value: '' }, _meta: { title: 'prompt' } },
      507: {
        class_type: 'EmptyLatentImage',
        inputs: { width: 512, height: 512, batch_size: 1 },
        _meta: { title: '空Latent图像' },
      },
      9: { class_type: 'KSampler', inputs: { seed: 0, latent_image: ['507', 0] }, _meta: { title: 'seed' } },
    }
  }
  await saveChannel({
    id: 'ch-cnt', name: '张数渠道', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    models: [{ id: 'local', label: '本地模型', caps: ['image'] }],
    comfyuiT2iWorkflow: latentWorkflow(),
  })

  /* ① count=3 → batch_size 变 3。 */
  {
    const probe = fakeComfy({ outputs: {
      9: { images: [
        { filename: 'a.png', subfolder: '', type: 'output' },
        { filename: 'b.png', subfolder: '', type: 'output' },
        { filename: 'c.png', subfolder: '', type: 'output' },
      ] },
    } })
    setGenerateDeps({ comfyHttp: { fetchImpl: probe }, sleep: async () => { /* 不真睡 */ } })
    const t = await settle(submitGeneration({
      kind: 'image', prompt: '一只猫', model: 'local', channelId: 'ch-cnt', count: 3,
    }).id)
    check('★★ count=3 填进了 batch_size（那个节点的标题不是槽位标记，靠结构找）',
      Number(inputsOf(probe.calls, '507')?.batch_size) === 3,
      JSON.stringify(inputsOf(probe.calls, '507')?.batch_size))
    check('★★ 而且三张都收成了产物（不是只留第一张）',
      (t?.artifacts?.length ?? 0) === 3, String(t?.artifacts?.length ?? 0))
    check('★★ count 没被当成「提交三次」（只提交了一次 /prompt）',
      probe.calls.filter(c => String(c.url).includes('/prompt')).length === 1,
      String(probe.calls.filter(c => String(c.url).includes('/prompt')).length))
  }

  /* ② count=1 或没给 → batch_size 保持原值（不无意义地改工作流）。 */
  {
    const probe = fakeComfy()
    setGenerateDeps({ comfyHttp: { fetchImpl: probe }, sleep: async () => { /* 不真睡 */ } })
    await settle(submitGeneration({
      kind: 'image', prompt: '一只猫', model: 'local', channelId: 'ch-cnt', count: 1,
    }).id)
    check('★★ count=1 → batch_size 仍是 1（不动工作流）',
      Number(inputsOf(probe.calls, '507')?.batch_size) === 1,
      JSON.stringify(inputsOf(probe.calls, '507')?.batch_size))
  }

  /* ③ 没有 batch_size 的工作流（视频 / 音频那类）→ 不报错，只是不生效。
   *    这条钉住「不静默崩、也不假装改了」。 */
  {
    await saveChannel({
      id: 'ch-nobatch', name: '无批量渠道', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
      models: [{ id: 'local', label: '本地模型', caps: ['image'] }],
      comfyuiT2iWorkflow: {
        3: { class_type: 'PrimitiveStringMultiline', inputs: { value: '' }, _meta: { title: 'prompt' } },
        9: { class_type: 'KSampler', inputs: { seed: 0 }, _meta: { title: 'seed' } },
      },
    })
    const probe = fakeComfy()
    setGenerateDeps({ comfyHttp: { fetchImpl: probe }, sleep: async () => { /* 不真睡 */ } })
    const t = await settle(submitGeneration({
      kind: 'image', prompt: '一只猫', model: 'local', channelId: 'ch-nobatch', count: 3,
    }).id)
    check('★★ 工作流没有 batch_size → 任务照常成功（不因为 count 崩）',
      t?.status === 'success', String(t?.status) + ' / ' + String(t?.error ?? ''))
  }

  await deleteChannel('ch-cnt')
  await deleteChannel('ch-nobatch')
  resetGenerateForTest()
}

/* ── ⑦ 按 op 过滤模型 ─────────────────────────────────────────────── */

console.log('⑦ 按 op 过滤模型：网络模型只留 caption，ComfyUI 要有这一类工作流')
{
  await saveChannel({
    id: 'ch-net', name: '云端', protocol: 'openai', baseUrl: 'http://127.0.0.1:9',
    models: [{ id: 'gpt-image-1', label: '出图', caps: ['image'] }],
  })
  await saveChannel({
    id: 'ch-comfy', name: '本地', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    models: [{ id: 'local', label: '本地模型', caps: ['image'] }],
    /* 只挂 t2i，**不挂** upscale —— 这就是「点了 upscale 却没工作流」的那种渠道。 */
  })
  const all = await listModels()
  check('★ 上面两个渠道各出了一个模型', all.length === 2, String(all.length))

  const forUpscale = await filterModelsByOp(all, 'upscale')
  check('★★ upscale 一个都不留（内置没有，那渠道也没挂 → 选了必然报错）',
    forUpscale.length === 0, forUpscale.map(m => m.channelId).join(','))
  /* `inpaint` 有内置工作流（`inpaint-qwen-image`），所以 ComfyUI 渠道能接这一单。 */
  const forInpaint = await filterModelsByOp(all, 'inpaint')
  check('★★ inpaint 留 ComfyUI（内置有局部编辑工作流）',
    forInpaint.length === 1 && forInpaint[0].channelId === 'ch-comfy',
    forInpaint.map(m => m.channelId).join(','))
  check('★★ inpaint 不留网络模型（它们的接口没有遮罩）',
    !forInpaint.some(m => m.channelId === 'ch-net'), forInpaint.map(m => m.channelId).join(','))
  /* `caption` 反推提示词：两条路都能做，但**网络模型那边必须那个模型真有 text 能力**。
   *
   * 上面那个 `ch-net` 只登记了 `caps: ['image']`（只会画图的模型）——
   * 它**不该**出现在 caption 的清单里：请求侧对网络模型的 caption 会强制按
   * `kind: 'text'` 发（`runTask` 的 `effectiveKind`），只会画图的模型到那里就被拦。
   * 列出来 = 把用户引向一条必然报错的路。 */
  const forCaption = await filterModelsByOp(all, 'caption')
  check('★★ caption 只留 ComfyUI（那个网络模型只会画图，没有 text 能力）',
    forCaption.length === 1 && forCaption[0].channelId === 'ch-comfy',
    forCaption.map(m => m.channelId).join(','))

  /* 换一个**真有 text 能力**的网络模型（Gemini 那种能读图答字的），它就该出现了。 */
  await saveChannel({
    id: 'ch-gem', name: '云端文字', protocol: 'gemini', baseUrl: 'http://127.0.0.1:9',
    models: [{ id: 'gemini-2.5-flash', label: '看图答字', caps: ['image', 'text'] }],
  })
  const all3 = await listModels()
  const forCaption3 = await filterModelsByOp(all3, 'caption')
  check('★★ 有 text 能力的网络模型能进 caption 清单',
    forCaption3.some(m => m.channelId === 'ch-gem'), forCaption3.map(m => m.channelId).join(','))
  check('★★ 但它仍然只有 caption 这一个 op 能进（inpaint 还是不给）',
    (await filterModelsByOp(all3, 'inpaint')).every(m => m.channelId !== 'ch-gem'),
    (await filterModelsByOp(all3, 'inpaint')).map(m => m.channelId).join(','))

  /* 给 ComfyUI 渠道挂上 upscale 工作流，它就该出现了。 */
  await saveChannel({
    id: 'ch-comfy', name: '本地', protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188',
    models: [{ id: 'local', label: '本地模型', caps: ['image'] }],
    comfyuiUpscaleWorkflow: inpaintWorkflow(),
  })
  const all2 = await listModels()
  const forUpscale2 = await filterModelsByOp(all2, 'upscale')
  check('★★ 挂上 upscale 工作流后，那个渠道出现了', forUpscale2.length === 1,
    forUpscale2.map(m => m.channelId).join(','))
  check('★★ 而且仍然不带网络模型', !forUpscale2.some(m => m.channelId === 'ch-net'),
    forUpscale2.map(m => m.channelId).join(','))
}

/* ── ⑧ resolveMentions ───────────────────────────────────────────── */

console.log('⑧ 提及解析（九种写法）')
{
  /** 一个只有几个节点的画布。 */
  const nodes = {
    n1: { kind: 'text', name: '主提示', text: '一只白猫坐在窗台' },
    n2: { kind: 'image', name: '参考图', artifact: 'art-abc123' },
    n3: { kind: 'text', name: '风格', text: '水彩' },
    n4: { kind: 'image', name: '空的图', artifact: '' },
    n5: { kind: 'config', name: '配置' },
  }
  const lookup = id => nodes[id]

  /* (1) 正常替换：文本节点正文插进来。 */
  const r1 = resolveMentions('照着 @[主提示](n1) 画', lookup)
  check('★★ 文本节点：正文插进来了', r1.prompt === '照着 一只白猫坐在窗台 画', r1.prompt)

  /* (2) 图片节点：进 refs，原文换成 [图: 名字]。 */
  const r2 = resolveMentions('用 @[参考图](n2) 当底图', lookup)
  check('★★ 图片节点：产物 id 进了 refs', r2.refs.length === 1 && r2.refs[0] === 'art-abc123',
    JSON.stringify(r2.refs))
  check('★★ 图片节点：原文换成了 [图: 名字]（不是塞进提示词）',
    r2.prompt === '用 [图: 参考图] 当底图', r2.prompt)

  /* (3) 找不到节点：原样保留 + 进 missing。 */
  const r3 = resolveMentions('用 @[不存在](n99) 试试', lookup)
  check('★★ 找不到：原文一字不改地留着', r3.prompt === '用 @[不存在](n99) 试试', r3.prompt)
  check('★★ 找不到：进了 missing', r3.missing.length === 1 && r3.missing[0] === 'n99',
    JSON.stringify(r3.missing))

  /* (4) 多个提及 + 顺序按第一次出现 + 去重。 */
  const r4 = resolveMentions('@[参考图](n2) 和 @[主提示](n1) 再加 @[参考图](n2)', lookup)
  check('★★ 多个提及：两个都替换了', r4.prompt === '[图: 参考图] 和 一只白猫坐在窗台 再加 [图: 参考图]',
    r4.prompt)
  check('★★ 同一个图片提及两次，refs 里只留一份', r4.refs.length === 1, JSON.stringify(r4.refs))

  /* (5) 空 prompt。 */
  const r5 = resolveMentions('', lookup)
  check('★★ 空 prompt：什么都不变、不报错',
    r5.prompt === '' && r5.refs.length === 0 && r5.missing.length === 0,
    JSON.stringify(r5))

  /* (6) 畸形语法原样保留（缺右括号 / id 里带空格 / 没 @）。 */
  const r6 = resolveMentions('坏的 @[主提示](n1 还有 [主提示](n1) 和 @[](n2)', lookup)
  check('★★ 畸形：缺右括号那条原样留存', r6.prompt.includes('@[主提示](n1 '), r6.prompt)
  check('★★ 畸形：没有 @ 的方括号不动', r6.prompt.includes('[主提示](n1)'), r6.prompt)
  /* 空名字（`@[](n2)`）**算合法**：id 认得出就用它，显示名退回节点自己的名字。
   * 判据是「只要 id 能定位就不是畸形」—— 名字只是给人看的标签。 */
  check('★★ 空名字：仍然按 id 认出来（退回节点自己的名字）',
    r6.prompt.endsWith('[图: 参考图]'), r6.prompt)
  /* id 里带空格 → 畸形，原样保留。 */
  const r6b = resolveMentions('@[主提示](n 1)', lookup)
  check('★★ 畸形：id 里带空格原样保留', r6b.prompt === '@[主提示](n 1)', r6b.prompt)

  /* (7) 名字里含方括号。 */
  const r7 = resolveMentions('用 @[主图[新版]](n2) 画', lookup)
  check('★★ 名字里有方括号也认得出', r7.refs.length === 1 && r7.refs[0] === 'art-abc123',
    JSON.stringify(r7.refs))
  check('★★ 而且替换对了（名字完整）', r7.prompt === '用 [图: 主图[新版]] 画', r7.prompt)

  /* (8) 图片节点没有产物 id → 按找不到处理（引不出东西）。 */
  const r8 = resolveMentions('@[空的图](n4)', lookup)
  check('★★ 图片节点没产物：原样保留 + 进 missing',
    r8.prompt === '@[空的图](n4)' && r8.missing.includes('n4'), JSON.stringify(r8))

  /* (9) 不可引用的类型（config）。 */
  const r9 = resolveMentions('@[配置](n5)', lookup)
  check('★★ config 节点：原样保留 + 进 missing',
    r9.prompt === '@[配置](n5)' && r9.missing.includes('n5'), JSON.stringify(r9))

  /* (10) 文本节点被引用时记进 textNodes（反查用）。 */
  check('★★ 文本节点进了 textNodes', r1.textNodes.length === 1 && r1.textNodes[0] === 'n1',
    JSON.stringify(r1.textNodes))

  /* (11) listMentions 只解析不替换。 */
  const lm = listMentions('@[参考图](n2) @[主提示](n1)')
  check('★★ listMentions 列出两条', lm.length === 2, JSON.stringify(lm))
  check('★ listMentions 带名字与 id', lm[0].name === '参考图' && lm[0].id === 'n2',
    JSON.stringify(lm[0]))
}

/* ── ⑨ 纯函数：不碰宿主 ───────────────────────────────────────────── */

console.log('⑨ mentions.ts 是纯的（不读存档、不碰 DOM）')
{
  /* 只 import 就能用：不传任何宿主上下文、不设任何环境变量。 */
  const out = resolveMentions('@[甲](a1)', () => ({ kind: 'text', text: '乙' }))
  check('★★ 零上下文也能跑', out.prompt === '乙', out.prompt)
  /* 传 null 进 lookup 之外的垃圾不应崩。 */
  const weird = resolveMentions(null, () => undefined)
  check('★ 传 null prompt 不崩、回空串', weird.prompt === '' && weird.refs.length === 0,
    JSON.stringify(weird))
}

console.log('')
if (bad === 0) {
  console.log('全部通过 ✓')
} else {
  console.log('有 ' + String(bad) + ' 条不通过 ✗')
  process.exitCode = 1
}
