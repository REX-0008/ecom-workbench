/** 16 份工作流 JSON 的逐字节一致 + 注册表（契约 CA，2026-10-26）。
 *
 * ## 这一段守的是什么
 *
 * 那 16 份 JSON 是**别人的作品**（参考项目 MIT 许可），我们只是搬过来用。
 * 「搬对了」的唯一判据是逐字节相同 —— 任何一处被「顺手改一下」，
 * 以后就没法与上游对齐，也说不清是谁改的。
 *
 * 跑法：node --import <tsx> tests/comfyui-workflows.mjs
 */
import { readFile, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const {
  WORKFLOW_CATEGORIES, BUILTIN_WORKFLOWS, defaultWorkflowOf, availableWorkflowsOf,
  builtinWorkflowById, builtinOfJson, listBuiltinWorkflows,
} = await import('../src/schedule/comfyui-workflows/registry.ts')

/** 参考项目里那 16 份的目录（只读）。 */
const REF_DIR = 'F:/AGENTS/agent-chat-dsh/refs-projects/infinite-canvas/web/src/assets/workflows'
/** 我们这边复制过来的目录。 */
const OUR_DIR = new URL('../src/schedule/comfyui-workflows/', import.meta.url).pathname.replace(/^\//, '')

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
 * 一份文件的 SHA256。
 * @param {string} path - 路径。
 * @returns {Promise<string>} 十六进制摘要。
 */
async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/* ── ① 16 份逐字节相同 ────────────────────────────────────────────── */
console.log('① 16 份 JSON 与参考项目逐字节相同')
{
  const refNames = (await readdir(REF_DIR)).filter(n => n.endsWith('.json')).sort()
  const ourNames = (await readdir(OUR_DIR)).filter(n => n.endsWith('.json')).sort()
  check('★★ 参考项目那边是 16 份', refNames.length === 16, String(refNames.length))
  check('★★ 我们这边也是同样的 16 份（文件名一个不差）',
    JSON.stringify(ourNames) === JSON.stringify(refNames), ourNames.length + ' 份')

  let same = 0
  const mismatched = []
  for (const name of refNames) {
    const a = await sha256(join(REF_DIR, name))
    const b = await sha256(join(OUR_DIR, name)).catch(() => '')
    if (a === b) same += 1
    else mismatched.push(name)
  }
  check('★★ 16 份 SHA256 全部相同（一个字节都没改）',
    same === 16 && mismatched.length === 0,
    String(same) + '/16' + (mismatched.length === 0 ? '' : '，不同：' + mismatched.join(',')))
  /* 逐份打出来（交付要贴对比输出）。 */
  for (const name of refNames) {
    const a = await sha256(join(REF_DIR, name))
    console.log('     ' + name + '  ' + a.slice(0, 16))
  }
}

/* ── ② 注册表：12 类都能取，取不到给 undefined ───────────────────── */
console.log('')
console.log('② 注册表能按 12 个类别取工作流')
{
  check('★ 类别枚举是 12 个', WORKFLOW_CATEGORIES.length === 12, WORKFLOW_CATEGORIES.join(','))

  /* 有内置工作流的 9 类。 */
  const hasBuiltin = ['t2i', 'i2i', 'inpaint', 'text', 'omniVideo', 'frameVideo', 'audio', 'faceRefine', 'depthVideo']
  const missing = hasBuiltin.filter(c => defaultWorkflowOf(c) === undefined)
  check('★★ 这 9 类都能取到默认工作流', missing.length === 0, '缺：' + missing.join(','))

  /* 那 3 类**故意**没有（参考项目里也是用户自己导入）。 */
  const noBuiltin = ['superResolve', 'angle', 'upscale']
  const wrong = noBuiltin.filter(c => defaultWorkflowOf(c) !== undefined)
  check('★★ superResolve / angle / upscale 返回 undefined（不是抛错）',
    wrong.length === 0, '意外有：' + wrong.join(','))

  let threw = ''
  try { defaultWorkflowOf('不存在的类别') } catch (e) { threw = String(e) }
  check('★★ 不认识的类别也不抛错（返回 undefined）', threw === '', threw)

  check('★ availableWorkflowsOf(omniVideo) 有 4 份',
    availableWorkflowsOf('omniVideo').length === 4, String(availableWorkflowsOf('omniVideo').length))
  check('★ availableWorkflowsOf(frameVideo) 有 4 份',
    availableWorkflowsOf('frameVideo').length === 4, String(availableWorkflowsOf('frameVideo').length))
  check('★ availableWorkflowsOf(superResolve) 是空数组（不是 undefined）',
    Array.isArray(availableWorkflowsOf('superResolve')) && availableWorkflowsOf('superResolve').length === 0, '')

  /* ⚠️ 候选清单是 **17 条**、但只引用 **16 份唯一 JSON**：
   * `qwen_image_21_api.json` 同时是「文生图默认」与「图生图默认」
   * （参考项目也是这么摆的 —— 同一份工作流两种用法）。
   * 所以这里判「条数 17」与「唯一 JSON 数 16」，两个都要对。 */
  check('★ 候选清单 17 条（qwen_image_21 一份两用）',
    BUILTIN_WORKFLOWS.length === 17, String(BUILTIN_WORKFLOWS.length))
  const uniqueJson = new Set(BUILTIN_WORKFLOWS.map(w => JSON.stringify(w.json)))
  check('★★ 但只引用 16 份唯一 JSON（没有凭空多出一份）',
    uniqueJson.size === 16, String(uniqueJson.size))
  /* 每类最多一个默认。 */
  const byCat = new Map()
  for (const w of BUILTIN_WORKFLOWS) if (w.isDefault) byCat.set(w.category, (byCat.get(w.category) ?? 0) + 1)
  check('★★ 每个类别最多只有一个 isDefault',
    [...byCat.values()].every(n => n === 1), JSON.stringify([...byCat.entries()]))
}

/* ── ③ 按 id 找、按内容认 ────────────────────────────────────────── */
console.log('')
console.log('③ 按 id 找与按内容认')
{
  check('★ 按 id 找得到', builtinWorkflowById('t2i-z-image-turbo')?.name.includes('Z-Image'), '')
  check('★ 找不到给 undefined', builtinWorkflowById('nope') === undefined, '')

  /* 按内容认：把默认那份原样传进去，应该认出是它。 */
  const json = defaultWorkflowOf('t2i').json
  check('★★ 原样传回去能认出是内置的', builtinOfJson(json)?.category === 't2i', builtinOfJson(json)?.id)
  /* 改一个字节就认不出来（说明判据真是内容而不是引用）。 */
  const tampered = JSON.parse(JSON.stringify(json))
  tampered['__tampered__'] = { class_type: 'X', inputs: {} }
  check('★★ 改过的 JSON 认不出是内置的（判据是内容不是引用）',
    builtinOfJson(tampered) === undefined, '')

  const list = listBuiltinWorkflows('t2i')
  check('★ 清单不带 JSON 本体（列表页不该搬 148KB）',
    list.length === 2 && list.every(x => x.json === undefined), JSON.stringify(Object.keys(list[0] ?? {})))
  check('★ 不传类别就列全部', listBuiltinWorkflows().length === 17, String(listBuiltinWorkflows().length))
}

/* ── ④ 校验规则与那 16 份的一致程度（并记下**已知不一致**）────────── */
console.log('')
console.log('④ 校验规则与 16 份的对照')
{
  const { validateComfyWorkflow } = await import('../src/schedule/comfyui.ts')
  /* ⚠️ 这一条**不是**「16 份全通过」。上游的 `video_h3_face_refine_api.json`
   * 的保存节点标题是「10. Save (ORIGINAL audio)」、没有 `output_video` 标记，
   * 按校验规则它不通过 —— 而上游自己的测试断言它通过（`__tests__/comfyui.test.ts:1149`），
   * 那是上游的一处不一致。
   *
   * 我们的处理：**校验只用于「用户导入工作流」那一刻**（照上游的实现），
   * 生成链路不做全套校验（见 `comfyui.ts` 的 `runComfyGeneration` ① 那段）。
   * 所以这份文件不通过校验**不影响它能用来生成**。
   *
   * 这条断言把「哪几份不通过、为什么不通过」写死，免得以后有人看到
   * 「16 份里有一份不通过」就回去改那 16 份 JSON（那是上游原文，一个字节都不许动）。 */
  const fails = []
  for (const w of BUILTIN_WORKFLOWS) {
    const r = validateComfyWorkflow(w.json, w.category)
    if (!r.ok) fails.push({ id: w.id, error: r.error })
  }
  const notOk = new Set(fails.map(f => f.id))
  check('★★ 17 条里只有 1 条不通过（faceRefine 那份缺 output_video，上游已知不一致）',
    fails.length === 1 && notOk.has('tool-face-refine-h3'),
    fails.map(f => f.id + '：' + f.error).join(' | '))
  check('★★ 其余 16 条全部通过', 17 - fails.length === 16, String(17 - fails.length))

  /* 反向：拿一份文生图去按「首尾帧视频」校验，必须不通过 —— 否则说明校验是摆设。
   * ⚠️ 它挂在**输出标记**那一关（文生图有 output_image、没有 output_video），
   * 还没走到首尾帧槽位那一关。所以断言只判「不通过」，不断言具体是哪句话。 */
  const crossed = validateComfyWorkflow(defaultWorkflowOf('t2i').json, 'frameVideo')
  check('★★ 类别对不上时校验会拒绝（不是万能通过）',
    crossed.ok === false && String(crossed.error).includes('output_video'), String(crossed.error))

  /* 再反向：一份真正合格的视频工作流要能通过（证明上面那条不是「全都拒绝」）。 */
  const depth = validateComfyWorkflow(defaultWorkflowOf('depthVideo').json, 'depthVideo')
  check('★★ 合格的 depthVideo 工作流能通过校验（校验不是一律拒绝）',
    depth.ok === true, String(depth.error))
}

console.log('')
console.log(bad === 0
  ? '结论：16 份逐字节一致、注册表 12 类都能取、校验对得上 ✓'
  : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
