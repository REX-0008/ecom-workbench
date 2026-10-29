/** ComfyUI 直连的纯函数三段（契约 AX，2026-10-25）。
 *
 * # ⚠️ 这个测试验的是什么、不验什么
 *
 * | 验 | 不验 |
 * |---|---|
 * | 槽位填写、参考图裁剪、轮询状态机 | **真的连上 ComfyUI 出一张图** |
 *
 * 本机 ComfyUI 没在跑（8188 / 8189 都不通），所以最后那条只能标未验。
 * 这份测试**不许**写成「ComfyUI 已通」——它验的是一个纯函数的行为。
 *
 * 跑法：node --import <tsx> tests/comfyui.mjs
 */
const {
  applyBindings, pruneUnusedRefs, pollJob, pollIntervalOf, stateFromHistory, stateFromQueue,
  POLL_RUNNING_MS, POLL_PENDING_MS, POLL_TIMEOUT_MS,
} = await import('../src/schedule/comfyui.ts')
const { readFile } = await import('node:fs/promises')

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
 * 造一份含三个槽位的假工作流（形状照 ComfyUI 的真格式：节点编号为键）。
 * @returns {object} 工作流。
 */
function fakeWorkflow() {
  return {
    /* 提示词槽位：CLIPTextEncode 的字段叫 text。 */
    3: { class_type: 'CLIPTextEncode', inputs: { text: '原来的提示词', clip: ['1', 0] }, _meta: { title: 'prompt' } },
    /* 宽高槽位：PrimitiveInt 的字段叫 value。 */
    4: { class_type: 'PrimitiveInt', inputs: { value: 512 }, _meta: { title: 'width' } },
    5: { class_type: 'PrimitiveInt', inputs: { value: 512 }, _meta: { title: 'height' } },
    /* 种子槽位。 */
    6: { class_type: 'KSampler', inputs: { seed: 0, steps: 20, model: ['7', 0] }, _meta: { title: 'seed' } },
    /* 参考图节点：带一条「别的节点指着它」的连线，用来验裁剪。 */
    10: { class_type: 'LoadImage', inputs: { image: 'placeholder.png' }, _meta: { title: 'ref_image_01' } },
    11: { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['12', 0] } },
    /* 普通节点：没有 title，不该被动到。 */
    9: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
  }
}

/* ── ① 槽位填写 ───────────────────────────────────────────────────── */
console.log('① 槽位填写：三个标了 _meta.title 的节点都填对')
{
  const wf = fakeWorkflow()
  const out = applyBindings(wf, { prompt: '一只白猫', width: 1024, height: 768, seed: 42 })
  check('★★ prompt 槽位填了（CLIPTextEncode 的字段是 text）',
    out['3'].inputs.text === '一只白猫', String(out['3'].inputs.text))
  check('★★ width 槽位填了（PrimitiveInt 的字段是 value）',
    out['4'].inputs.value === 1024, String(out['4'].inputs.value))
  check('★★ height 槽位填了', out['5'].inputs.value === 768, String(out['5'].inputs.value))
  check('★★ seed 槽位填了', out['6'].inputs.seed === 42, String(out['6'].inputs.seed))
  check('★ 别的输入没被碰（steps 还是 20）', out['6'].inputs.steps === 20, String(out['6'].inputs.steps))
  check('★★ 原工作流没被改（深拷贝）', wf['3'].inputs.text === '原来的提示词',
    String(wf['3'].inputs.text))

  /* 找不到槽位就跳过，不报错：一份工作流可能压根没有 height 槽位。 */
  const noHeight = fakeWorkflow()
  delete noHeight['5']
  let threw = ''
  let out2 = null
  try { out2 = applyBindings(noHeight, { height: 999 }) } catch (e) { threw = String(e) }
  check('★★ 没有 height 槽位时不报错（跳过）', threw === '' && out2 !== null, threw)

  /* 种子兜底：没有任何节点标 seed，但有个节点输入里带数字 seed。 */
  const noSeedTitle = fakeWorkflow()
  delete noSeedTitle['6']._meta
  const out3 = applyBindings(noSeedTitle, { seed: 777 })
  check('★★ 没有 seed 槽位时兜底填第一个带数字 seed 的节点',
    out3['6'].inputs.seed === 777, String(out3['6'].inputs.seed))
}

/* ── ② 参考图裁剪 ─────────────────────────────────────────────────── */
console.log('')
console.log('② 参考图裁剪：不给图就把节点与指着它的连线一起删')
{
  const wf = fakeWorkflow()
  /* 一张参考图都不给 → ref_image_01 节点该消失，VAEEncode 指着它的那条连线也该消失。 */
  const pruned = pruneUnusedRefs(wf, 0)
  check('★★ 参考图节点被删掉了', pruned['10'] === undefined,
    Object.keys(pruned).join(','))
  /* ⚠️ 这里我第一版断言写反了，记下来免得以后再写反：
   * `VAEEncode` 的 `pixels` 指着被删的 LoadImage → 它**少了必填输入就没法跑**，
   * 所以按级联规则它自己也要被删（参考项目 `comfyui.ts:447-470` 就是这么做的）。
   * 只删连线、留一个跑不了的节点，等于把错误推到 ComfyUI 那边去。 */
  check('★★ 指着它的下游节点也一起被删（少了必填输入就跑不了）',
    pruned['11'] === undefined, Object.keys(pruned).join(','))

  /* 给了一张 → 不删。 */
  const kept = pruneUnusedRefs(wf, 1)
  check('★★ 给了参考图就不删', kept['10'] !== undefined && kept['10'].inputs.image === 'placeholder.png',
    JSON.stringify(kept['10']))

  /* ref_image_02 这种带序号的：只给 1 张 → 02 该被删、01 留着。 */
  const two = fakeWorkflow()
  two['13'] = { class_type: 'LoadImage', inputs: { image: 'second.png' }, _meta: { title: 'ref_image_02' } }
  const pruned2 = pruneUnusedRefs(two, 1)
  check('★★ 给了 1 张 → ref_image_02 被删、ref_image_01 留着',
    pruned2['13'] === undefined && pruned2['10'] !== undefined,
    Object.keys(pruned2).join(','))

  /* 原工作流不该被改。 */
  check('★★ 原工作流没被改（深拷贝）', wf['10'] !== undefined, Object.keys(wf).join(','))

  /* 级联：只删 LoadImage 会让 VAEEncode 指着空气。
   * 这里 VAEEncode 的 pixels 是唯一输入来源时它也该被删（本测试的 VAEEncode 还有 vae，
   * 所以它留着但少了那条连线）—— 这是「可选输入」之外的正确行为。 */
  const chain = {
    20: { class_type: 'LoadImage', inputs: { image: 'x.png' }, _meta: { title: 'ref_image' } },
    21: { class_type: 'VAEEncode', inputs: { pixels: ['20', 0] } },
  }
  const pruned3 = pruneUnusedRefs(chain, 0)
  check('★★ 级联：只靠参考图供入的节点也一起删（不留下指着空气的节点）',
    pruned3['20'] === undefined && pruned3['21'] === undefined,
    Object.keys(pruned3).join(','))

  /* 反向：可选输入的节点**只删连线、不删节点**（多图插槽少一张还能跑）。
   * 名单照参考项目 `comfyui.ts:455-462`。 */
  const optional = {
    30: { class_type: 'LoadImage', inputs: { image: 'y.png' }, _meta: { title: 'ref_image' } },
    31: { class_type: 'TextEncodeQwenImage21', inputs: { images_image_1: ['30', 0], text: 'hi' } },
  }
  const pruned4 = pruneUnusedRefs(optional, 0)
  check('★★ 可选输入的节点留着、只删那条连线',
    pruned4['31'] !== undefined && pruned4['31'].inputs.images_image_1 === undefined
    && pruned4['31'].inputs.text === 'hi',
    JSON.stringify(pruned4['31']?.inputs))
}

/* ── ③ 轮询间隔与状态机 ───────────────────────────────────────────── */
console.log('')
console.log('③ 轮询：两档间隔都在、状态判定对')
{
  check('★★ 运行中的间隔是 2 秒', POLL_RUNNING_MS === 2000, String(POLL_RUNNING_MS))
  check('★★ 排队中的间隔是 3.5 秒', POLL_PENDING_MS === 3500, String(POLL_PENDING_MS))
  check('★★ 超时上限是 18 小时量级（不是几分钟）',
    POLL_TIMEOUT_MS === 18 * 60 * 60 * 1000, String(POLL_TIMEOUT_MS))
  check('★ 状态到间隔的映射对',
    pollIntervalOf('running') === 2000 && pollIntervalOf('pending') === 3500,
    String(pollIntervalOf('running')) + '/' + String(pollIntervalOf('pending')))

  /* 状态判定：喂假响应。 */
  check('★★ history 里没这个 id → 还在跑（pending 态）',
    stateFromHistory({}, 'job-1').state === 'pending', stateFromHistory({}, 'job-1').state)
  check('★★ history 里 status_str=error → failed',
    stateFromHistory({ 'job-1': { status: { status_str: 'error' }, outputs: {} } }, 'job-1').state === 'failed',
    stateFromHistory({ 'job-1': { status: { status_str: 'error' }, outputs: {} } }, 'job-1').state)
  check('★★ history 里有产出 → done',
    stateFromHistory({ 'job-1': { status: { status_str: 'success' }, outputs: { images: [{ filename: 'a.png' }] } } }, 'job-1').state === 'done',
    stateFromHistory({ 'job-1': { outputs: { images: [{}] } } }, 'job-1').state)
  check('★★ 跑完了但没产出 → failed（不是一直等到 18 小时）',
    stateFromHistory({ 'job-1': { status: { status_str: 'success' }, outputs: {} } }, 'job-1').state === 'failed',
    stateFromHistory({ 'job-1': { status: { status_str: 'success' }, outputs: {} } }, 'job-1').state)

  check('★ queue 里在跑 → running', stateFromQueue({ queue_running: [['1', 'job-1']] }, 'job-1') === 'running',
    stateFromQueue({ queue_running: [['1', 'job-1']] }, 'job-1'))
  check('★ queue 里在排 → pending', stateFromQueue({ queue_pending: [['1', 'job-1']] }, 'job-1') === 'pending',
    stateFromQueue({ queue_pending: [['1', 'job-1']] }, 'job-1'))
}

/* ── ④ pollJob：真的按间隔问、到点出结果、超时停 ─────────────────── */
console.log('')
console.log('④ pollJob 的状态机（喂假 fetchJob，不连真服务）')
{
  /* 不会真睡的 sleep：把「要等多久」记下来，让测试跑得飞快。 */
  /** @type {number[]} */
  const slept = []
  const fakeSleep = async (ms) => { slept.push(ms) }

  /* 第一次：在跑；第二次：跑完了。 */
  let calls = 0
  const r1 = await pollJob('job-a', async () => {
    calls += 1
    if (calls === 1) return { history: {}, queue: { queue_running: [['1', 'job-a']] } }
    return { history: { 'job-a': { status: { status_str: 'success' }, outputs: { images: [{ filename: 'out.png' }] } } }, queue: {} }
  }, { sleep: fakeSleep })
  check('★★ 跑完了 → done 且带回产出',
    r1.state === 'done' && JSON.stringify(r1.outputs).includes('out.png'),
    JSON.stringify(r1.state))
  check('★★ 在跑时按 2 秒的间隔问（不是 3.5 秒）', slept[0] === POLL_RUNNING_MS, String(slept[0]))
  check('★ 一共问了两次（不多问）', calls === 2, String(calls))

  /* 排队中：间隔该是 3.5 秒。 */
  slept.length = 0
  let calls2 = 0
  await pollJob('job-b', async () => {
    calls2 += 1
    if (calls2 === 1) return { history: {}, queue: { queue_pending: [['1', 'job-b']] } }
    return { history: { 'job-b': { outputs: { images: [{}] } } }, queue: {} }
  }, { sleep: fakeSleep })
  check('★★ 排队时按 3.5 秒的间隔问', slept[0] === POLL_PENDING_MS, String(slept[0]))

  /* 超时：一直没结果 → 到点停下并给原因（不能永远转）。 */
  slept.length = 0
  const r3 = await pollJob('job-c', async () => ({ history: {}, queue: { queue_running: [['1', 'job-c']] } }),
    { sleep: fakeSleep, timeoutMs: 50 })
  check('★★ 超时会停下并说明原因（不会永远轮询）',
    r3.state === 'failed' && String(r3.error).includes('超时'), String(r3.error))

  /* 取消：signal 一 abort 就停。 */
  const ac = new AbortController()
  ac.abort()
  const r4 = await pollJob('job-d', async () => ({ history: {}, queue: {} }),
    { sleep: fakeSleep, signal: ac.signal })
  check('★ 已取消 → 立刻停（不再问）', r4.state === 'failed' && String(r4.error).includes('取消'),
    String(r4.error))

  /* 问状态本身报错 → 明确失败，不是无限重试。 */
  const r5 = await pollJob('job-e', async () => { throw new Error('连接被拒') }, { sleep: fakeSleep })
  check('★★ 问状态失败 → failed 且带原因',
    r5.state === 'failed' && String(r5.error).includes('连接被拒'), String(r5.error))
}

/* ── ⑤ 时长槽位（票 29，2026-10-27）───────────────────────────────────
 *
 * ## 判据落在产出那份工作流的值上，不是「函数被调了」
 *
 * 这一票的病根就是「请求里收了 `seconds`、工作流里那个槽位永远是空串」。
 * 所以断言必须看 `out['47'].inputs.Number` 到底变成了什么 ——
 * 只看「`applyBindings` 跑了没抛错」的话，这条功能可以缺失而测试全绿。
 *
 * ## 用真内置工作流，不用假的那份
 *
 * `audio_minimax_music_3_api.json` 就是用户真会用的那份：节点 `47` 是
 * `class_type: "Float"`、`inputs: { "Number": "" }`、`_meta.title: "duration"`。
 * 拿它验才能抓住「字段名不是 duration」这件事（我自己第一次写的时候就猜错过）。 */
console.log('')
console.log('⑤ 时长槽位：填进 audio_minimax_music_3_api.json 的 duration 节点')
{
  const audio = (await import('../src/schedule/comfyui-workflows/audio_minimax_music_3_api.json',
    { with: { type: 'json' } })).default

  /* 先确认这份工作流里确实有那么一个节点（否则下面的断言在验空气）。 */
  const durNodes = Object.entries(audio).filter(([, n]) => n?._meta?.title === 'duration')
  check('★★ 内置音频工作流里确实有一个 duration 槽位（否则下面在验空气）',
    durNodes.length === 1, '找到 ' + String(durNodes.length) + ' 个')
  const [durId, durNode] = durNodes[0] ?? ['', { inputs: {} }]
  check('★★ 那个槽位的字段名是 Number、当前值是空串（这是「用模型自己的默认」）',
    durId !== '' && 'Number' in (durNode.inputs ?? {}) && durNode.inputs.Number === '',
    JSON.stringify(durNode.inputs))

  /* 判据 1：喂 duration: 12 → 那份工作流里那个槽位真的是 12。 */
  const filled = applyBindings(audio, { duration: 12 })
  check('★★ 判据 1：喂 duration: 12 → 工作流里那个槽位是 12',
    filled[durId]?.inputs?.Number === 12, JSON.stringify(filled[durId]?.inputs))
  check('★★ 而且类型是数字不是字符串（ComfyUI 的 Float 收字符串会拒）',
    typeof filled[durId]?.inputs?.Number === 'number', typeof filled[durId]?.inputs?.Number)

  /* 判据 2：不喂 → 原样不动。这一条专抓「默认填 0 / 填 5」。 */
  const untouched = applyBindings(audio, { prompt: '一段轻音乐' })
  check('★★ 判据 2：不喂 duration → 那个槽位原样不动（仍是空串）',
    untouched[durId]?.inputs?.Number === '', JSON.stringify(untouched[durId]?.inputs))
  check('★★ 判据 2：原工作流也没被改（深拷贝）',
    audio[durId].inputs.Number === '', JSON.stringify(audio[durId].inputs))

  /* 0 是一个有意义的时长写法吗：不拦，但也不能把 0 当成「没给」。
   * 判据：喂 0 就填 0（用户明确要 0 秒是他自己的事，我们不做产品判断）。 */
  const zero = applyBindings(audio, { duration: 0 })
  check('★★ 喂 0 → 填 0（不许把 0 当成「没给」）',
    zero[durId]?.inputs?.Number === 0, JSON.stringify(zero[durId]?.inputs))

  /* 非有限数跳过：写进去 ComfyUI 会拒收整份工作流，而那报错看不出跟时长有关。 */
  const bad = applyBindings(audio, { duration: Number.NaN })
  check('★★ NaN 不写进工作流（会拒收整份，且报错看不懂）',
    bad[durId]?.inputs?.Number === '', JSON.stringify(bad[durId]?.inputs))

  /* 没有 duration 槽位的工作流：给了也不报错、也不乱填。 */
  const noSlot = fakeWorkflow()
  let threw = ''
  let out = null
  try { out = applyBindings(noSlot, { duration: 12 }) } catch (e) { threw = String(e) }
  check('★★ 没有 duration 槽位时给时长 → 不报错，也不往别的节点乱写',
    threw === '' && out !== null && JSON.stringify(out) === JSON.stringify(noSlot), threw)
}

/* ── ⑥ 请求里叫 seconds、bindings 里叫 duration（名字对不上是历史原因）── */
console.log('')
console.log('⑥ 请求 → bindings 的接线（`seconds` → `duration`）')
{
  const genSrc = await readFile(new URL('../src/schedule/generate.ts', import.meta.url), 'utf8')
  check('★★ 生成那条路把请求的 seconds 传进 bindings 的 duration',
    /duration:\s*input\.seconds/.test(genSrc), '')
  check('★★ 没给 seconds 时不发那个键（不许默认填一个数）',
    genSrc.includes('input.seconds === undefined'), '')
  check('★ 请求体那一侧的字段名没被改成 duration（改了会牵动所有调用方）',
    genSrc.includes('seconds?: number') && !/^\s*duration\?: number/m.test(genSrc), '')
}

console.log('')
{
  const src = await readFile(new URL('../src/schedule/comfyui.ts', import.meta.url), 'utf8')
  check('★★ 有「端到端未验」字样', src.includes('端到端未验'), '')
  check('★★ 说明原因是本机 ComfyUI 没在跑（8188/8189）',
    src.includes('8188') && src.includes('8189'), '')
  check('★ 没有把它写成「已验」', !/真出一张图.*(已验|验过)/.test(src), '')
}

console.log('')
console.log(bad === 0
  ? '结论：ComfyUI 三段纯函数全部通过 ✓（⚠️ 真连 ComfyUI 出一张图仍未验）'
  : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
