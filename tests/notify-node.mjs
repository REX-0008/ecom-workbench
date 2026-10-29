/** 通知节点（`flow.notify`）的检查（2026-10-22，2026-10-23 改为级别门槛）。
 *
 * ## 为什么必须单独一份
 *
 * 这个节点「不发」的几种情形**都是静默的**：
 *   · 门槛设成不发送 → 什么都不弹（看着像「跑成功了」）；
 *   · 本条级别被门槛挡住 → 同样什么都不弹（与上一种长得一样，只能靠 reason 分辨）；
 *   · 节点自己设了不发系统通知 → 又是同一种表象；
 *   · 提醒内容没替换成变量 → 通知里带着原样的 `{{店铺}}`。
 *
 * 所以这里**直接验结论**，不验实现：
 *   · 四种门槛各跑一遍三档级别，看 `notified` 与 `reason`；
 *   · 「没发」的几种情形**真数有没有起子进程**（拉一个 `spawn` 计数器）；
 *   · 四种 reason 文案两两互不相同（用断言钉住，不接受「都差不多」）；
 *   · 变量替换走**既有的** `buildCommand`（与真实跑路同一条），不自己写替换。
 *
 * ## 偏好从哪来（2026-10-22 后端改成两项，本文件跟着改）
 *
 * `readNotifyPrefs()` 现在返回 `{ failNotify, alertMinLevel }`。本节点**只看
 * `alertMinLevel`**；`failNotify` 管的是定时失败与恢复失败，与本节点无关 ——
 * 第 ⑤ 段专门有一条断言钉住「它不影响本节点」。
 *
 * 读盘那一层是后端的（`src/notify/prefs.ts`），本测试在第 ⑨ 段用**沙箱目录**
 * 造偏好文件，覆盖「文件不存在 / 写坏 / 新形状各档 / 旧文件迁移后」。
 *
 * 跑法：node --import <tsx> tests/notify-node.mjs
 */
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'

/* 闸门：不弹通知（跑测试弹气球会打断用户）。与 `host-dispatch` / `schedule-notify` 同一个闸门。 */
process.env.EWB_TEST_NO_SPAWN = '1'

/* ── 子进程计数器（必须在 import 节点实现**之前**装好）──────────────
 *
 * `src/notify/index.ts` 里是 `import { spawn } from 'node:child_process'`，
 * 而 ESM 的具名绑定取的是**模块求值那一刻**那个函数。所以要先用 `createRequire`
 * 拿到同一个模块对象、替换掉它的 `spawn`，再让实现模块求值 ——
 * 这样它拿到的就是计数器包过的版本（实测：替换后再 import 才数得到）。 */
const require = createRequire(import.meta.url)
const cp = require('node:child_process')
let spawnCalls = 0
const realSpawn = cp.spawn
cp.spawn = function (...args) {
  spawnCalls += 1
  return realSpawn.apply(cp, args)
}

const { NODE } = await import('../src/nodes/flow/notify/node.ts')
const { NODE_LIBRARY } = await import('../src/nodes/index.ts')
const { NODE_IMPLS } = await import('../src/nodes/impls.ts')
const { runNotify, decideNotify, asAlertLevel, levelPasses, notifyFn } = await import('../src/nodes/flow/notify/impl.ts')
const { buildCommand } = await import('../src/workflow/command.ts')
const { notifyPrefsFile } = await import('../src/notify/prefs.ts')

/** 累计失败数。 */
let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

console.log('=== ① 节点定义 ===')
{
  const inLib = NODE_LIBRARY.map(d => d.id)
  check('★ NODE_LIBRARY 里有 flow.notify', inLib.includes('flow.notify'), inLib.join(','))
  check('顺序在 flow.parallel 之后、flow.wait 之前',
    inLib.indexOf('flow.parallel') < inLib.indexOf('flow.notify')
    && inLib.indexOf('flow.notify') < inLib.indexOf('flow.wait'),
    String(inLib.indexOf('flow.notify')))
  check('label 是「通知」且不带「未完善」', NODE.label === '通知', NODE.label)
  check('executor 是 builtin', NODE.executor === 'builtin', String(NODE.executor))
  check('单入单出（in / out）', NODE.inputs.length === 1 && NODE.inputs[0].id === 'in'
    && NODE.outputs.length === 1 && NODE.outputs[0].id === 'out',
    NODE.inputs.map(p => p.id).join(',') + ' → ' + NODE.outputs.map(p => p.id).join(','))
  check('失败策略是 continue', NODE.onError === 'continue', String(NODE.onError))
  check('★ 实现在 NODE_IMPLS 里登记了', NODE_IMPLS.has('flow.notify'))
}

console.log('')
console.log('=== ② 参数三项都对（R6 文案 + hint 必填）===')
{
  const defs = NODE.paramDefs ?? []
  check('参数正好三项', defs.length === 3, defs.map(d => d.key).join(','))
  for (const key of ['content', 'level', 'system']) {
    const d = defs.find(x => x.key === key)
    check('有参数 ' + key, d !== undefined)
    check(key + ' 带 hint', typeof d?.hint === 'string' && d.hint !== '')
  }
  const content = defs.find(x => x.key === 'content')
  check('content 必填', content?.required === true, String(content?.required))
  check('★ content 的 hint 说明支持 {{变量}}', String(content?.hint).includes('{{'))

  const level = defs.find(x => x.key === 'level')
  check('level 是 select', level?.kind === 'select', String(level?.kind))
  check('level 三档且顺序为 信息 / 注意 / 严重',
    (level?.options ?? []).map(o => o.label).join(',') === '信息,注意,严重',
    (level?.options ?? []).map(o => o.label).join(','))
  check('level 默认「注意」', level?.default === 'notice', String(level?.default))

  const system = defs.find(x => x.key === 'system')
  check('system 是 boolean 且默认开', system?.kind === 'boolean' && system?.default === true,
    String(system?.kind) + ' / ' + String(system?.default))

  check('有 detail.cautions', typeof NODE.detail?.cautions === 'string' && NODE.detail.cautions !== '')
  check('★ cautions 写明「输出不带上游数据」', String(NODE.detail?.cautions).includes('不带上游数据'),
    String(NODE.detail?.cautions).slice(0, 60))
}

console.log('')
console.log('=== ③ 定义文件只 import 类型（纯数据）===')
{
  const src = readFileSync(join(ROOT, 'src/nodes/flow/notify/node.ts'), 'utf8')
  const importLines = src.split('\n').filter(l => l.trim().startsWith('import '))
  check('★ 只有 import type', importLines.length > 0 && importLines.every(l => l.includes('import type')),
    importLines.join(' | '))
  check('没有 Node 内置模块的 import', !/from ['"]node:/.test(src))
}

console.log('')
console.log('=== ④ 级别门槛比较（纯函数 levelPasses / asAlertLevel）===')
{
  /* 语义（后端 2026-10-22 定的，`AlertLevel` 的书写顺序就是高低序）：
   *   severe > notice > info；`off` = 一律不发。 */
  check('门槛 off：三档全不过', ['info', 'notice', 'severe'].every(l => levelPasses('off', l) === false))
  check('门槛 info：三档全过', ['info', 'notice', 'severe'].every(l => levelPasses('info', l) === true))
  check('★★ 门槛 notice：info 不过、notice 过、severe 过',
    levelPasses('notice', 'info') === false
    && levelPasses('notice', 'notice') === true
    && levelPasses('notice', 'severe') === true,
    JSON.stringify([levelPasses('notice', 'info'), levelPasses('notice', 'notice'), levelPasses('notice', 'severe')]))
  check('★★ 门槛 severe：只有 severe 过',
    levelPasses('severe', 'info') === false
    && levelPasses('severe', 'notice') === false
    && levelPasses('severe', 'severe') === true,
    JSON.stringify([levelPasses('severe', 'info'), levelPasses('severe', 'notice'), levelPasses('severe', 'severe')]))
  /* 高低顺序别写反：severe 必须比 notice 高。 */
  check('★★ 级别高低顺序是 severe > notice > info',
    levelPasses('severe', 'severe') === true && levelPasses('notice', 'severe') === true
    && levelPasses('severe', 'notice') === false,
    '若反了，「门槛 severe 时 notice 会发」')

  check('asAlertLevel：三档认得',
    asAlertLevel('info') === 'info' && asAlertLevel('notice') === 'notice' && asAlertLevel('severe') === 'severe')
  check('asAlertLevel：乱写给默认 notice（与参数默认值一致）',
    asAlertLevel('乱写') === 'notice' && asAlertLevel(undefined) === 'notice', String(asAlertLevel('乱写')))
}

console.log('')
console.log('=== ⑤ 四种门槛各跑一次（这段数子进程）===')
{
  /* ★ 正对照：先证明计数器**真的数得到**。
   * 没有这一条，「没起子进程」那几条断言可能是「监控根本没接上」的假绿。 */
  spawnCalls = 0
  const { spawn } = await import('node:child_process')
  await new Promise((resolve) => {
    const c = spawn('cmd.exe', ['/c', 'echo probe'], { windowsHide: true })
    c.on('close', resolve)
    c.on('error', resolve)
  })
  check('★★ 正对照：计数器数得到真起的子进程（不然下面几条是假绿）', spawnCalls === 1,
    'spawn ' + String(spawnCalls) + ' 次')

  /**
   * 造一份偏好。
   * @param {string} min - alertMinLevel。
   * @param {boolean} [failNotify] - failNotify（默认 true）。
   * @returns {object} 偏好。
   */
  const prefs = (min, failNotify = true) => ({ failNotify, alertMinLevel: min })
  /** 造一份参数。
   * @param {string} level - 级别。
   * @param {boolean} [system] - system。
   * @returns {object} 参数。 */
  const params = (level, system = true) => ({ content: '巡查完成：3 个活动待报名', level, system })

  /* ---- 门槛 off：一律不发 ---- */
  const seen = {}
  for (const lv of ['info', 'notice', 'severe']) {
    spawnCalls = 0
    const r = await runNotify(params(lv), prefs('off'))
    seen['off_' + lv] = r
    check('★★ 门槛 off + ' + lv + '：不发', r.notified === false, JSON.stringify(r))
    check('★ 门槛 off + ' + lv + '：没起子进程', spawnCalls === 0, 'spawn ' + String(spawnCalls) + ' 次')
  }
  check('★★ 门槛 off 的 reason 说清是关闭（不是级别不够）',
    seen.off_info.reason.includes('不发送') && !seen.off_info.reason.includes('低于'),
    seen.off_info.reason)

  /* ---- 门槛 info：三档全发 ---- */
  for (const lv of ['info', 'notice', 'severe']) {
    spawnCalls = 0
    const r = await runNotify(params(lv), prefs('info'))
    check('★★ 门槛 info + ' + lv + '：发（notified 为真）', r.notified === true, JSON.stringify(r))
    check('★ 门槛 info + ' + lv + '：闸门下不起子进程，但理由说明闸门',
      spawnCalls === 0 && r.reason.includes('闸门'), r.reason)
  }

  /* ---- 门槛 notice：info 不发，notice / severe 发 ---- */
  const rNoticeInfo = await runNotify(params('info'), prefs('notice'))
  check('★★ 门槛 notice + info：不发', rNoticeInfo.notified === false, JSON.stringify(rNoticeInfo))
  check('★★ 它的 reason 说清是级别不够', rNoticeInfo.reason.includes('低于'), rNoticeInfo.reason)
  check('★ 门槛 notice + notice：发', (await runNotify(params('notice'), prefs('notice'))).notified === true)
  check('★ 门槛 notice + severe：发', (await runNotify(params('severe'), prefs('notice'))).notified === true)

  /* ---- 门槛 severe：只有 severe 发 ---- */
  const rSevInfo = await runNotify(params('info'), prefs('severe'))
  const rSevNotice = await runNotify(params('notice'), prefs('severe'))
  check('★★ 门槛 severe + info：不发', rSevInfo.notified === false, JSON.stringify(rSevInfo))
  check('★★ 门槛 severe + notice：不发（这一条最容易被写反）',
    rSevNotice.notified === false, JSON.stringify(rSevNotice))
  check('★★ 它们都写明是级别不够',
    rSevInfo.reason.includes('低于') && rSevNotice.reason.includes('低于'),
    rSevInfo.reason + ' | ' + rSevNotice.reason)
  check('★ 门槛 severe + severe：发', (await runNotify(params('severe'), prefs('severe'))).notified === true)

  /* ---- failNotify 完全不影响本节点 ---- */
  const rFailOff = await runNotify(params('info'), prefs('info', false))
  check('★★ failNotify: false + 门槛 info：info 照样发（两者互不相干）',
    rFailOff.notified === true, JSON.stringify(rFailOff))
  check('★ 反过来：failNotify: true + 门槛 off 仍不发',
    (await runNotify(params('severe'), prefs('off', true))).notified === false)

  /* ---- system: false 仍不发（这条是原来的，不许回归） ---- */
  spawnCalls = 0
  const rNoSys = await runNotify(params('severe', false), prefs('info'))
  check('★★ 门槛够了但 system 假：不发', rNoSys.notified === false, JSON.stringify(rNoSys))
  check('★ 它的 reason 说明节点设为不发系统通知',
    rNoSys.reason.includes('不发系统通知'), rNoSys.reason)
  check('★ system 假时没起子进程', spawnCalls === 0, 'spawn ' + String(spawnCalls) + ' 次')
}

console.log('')
console.log('=== ⑥ 四种 reason 文案互不相同（用断言钉住）===')
{
  /**
   * 造一份偏好。
   * @param {string} min - alertMinLevel。
   * @returns {object} 偏好。
   */
  const prefs = (min) => ({ failNotify: true, alertMinLevel: min })

  /* 四种原因各取一次。 */
  const rOff = await runNotify({ content: 'x', level: 'severe', system: true }, prefs('off'))
  const rLow = await runNotify({ content: 'x', level: 'info', system: true }, prefs('severe'))
  const rNoSys = await runNotify({ content: 'x', level: 'severe', system: false }, prefs('info'))
  const rSent = await runNotify({ content: 'x', level: 'severe', system: true }, prefs('info'))

  const all = {
    off: rOff.reason,
    low: rLow.reason,
    noSystem: rNoSys.reason,
    sent: rSent.reason,
  }
  /* ★ 两两互不相同（4 条 → 6 对）。「都差不多」在这里过不去。 */
  const keys = Object.keys(all)
  let dupes = []
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      if (all[keys[i]] === all[keys[j]]) dupes.push(keys[i] + '=' + keys[j])
    }
  }
  check('★★ 四种 reason 两两互不相同', dupes.length === 0, dupes.join(',') + ' | ' + JSON.stringify(all))
  check('★ 四种都不为空', keys.every(k => typeof all[k] === 'string' && all[k] !== ''), JSON.stringify(all))
  check('★★ 关闭那条点名「不发送」', all.off.includes('不发送'), all.off)
  check('★★ 级别不够那条点名「低于」且带上两边的级别',
    all.low.includes('低于') && all.low.includes('信息') && all.low.includes('严重'), all.low)
  check('★★ 节点自设那条点名「不发系统通知」', all.noSystem.includes('不发系统通知'), all.noSystem)
  check('★★ 发出去了那条以「已发出」开头（不是被挡住的语气）',
    all.sent.startsWith('已发出'), all.sent)

  /* 四种原因的 notified 值也各不相同地成组：只有一种为真。 */
  check('★★ 只有「真发出去」那条 notified 为真',
    rOff.notified === false && rLow.notified === false
    && rNoSys.notified === false && rSent.notified === true,
    JSON.stringify([rOff.notified, rLow.notified, rNoSys.notified, rSent.notified]))
}

console.log('')
console.log('=== ⑦ 提醒内容为空 → 明确报错（由失败策略 continue 兜住）===')
{
  let msg = ''
  try {
    await runNotify({ content: '   ' }, { failNotify: true, alertMinLevel: 'info' })
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e)
  }
  check('★ 空内容报错且说清怎么办', msg.includes('提醒内容'), msg)
}

console.log('')
console.log('=== ⑧ {{变量}} 走既有替换（与真实跑路同一条）===')
{
  const built = buildCommand(NODE, { ...NODE.params, content: '巡查完成：{{店铺}} 有 {{件数}} 个待办' }, [{ 店铺: '天猫', 件数: 3 }])
  const content = built.command.params.content
  check('★ {{店铺}} 被替换', content.includes('天猫'), String(content))
  check('★ {{件数}} 被替换（非字符串值也转文本）', content.includes('3'), String(content))
  check('没有残留占位符', !content.includes('{{'), String(content))
  check('没找到的变量没有被静默吃掉（本用例全找到）', built.missing.length === 0, built.missing.join(','))
}

console.log('')
console.log('=== ⑨ 真派发入口：偏好从盘上读（沙箱里造偏好文件）===')
/* 沙箱目录：后面 ⑩ 段还要用，所以写在块外。 */
process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-notify-'))
const prefsFile = notifyPrefsFile()
/**
 * 写一份偏好文件。
 * @param {unknown} raw - 直接写进去的内容（字符串/对象都行）。
 * @returns {Promise<void>} 写完。
 */
const writePrefs = async (raw) => {
  await mkdir(dirname(prefsFile), { recursive: true })
  await writeFile(prefsFile, typeof raw === 'string' ? raw : JSON.stringify(raw), 'utf8')
}
{
  const params = { content: '巡查完成：3 个活动待报名', level: 'notice', system: true }

  /* 文件不存在 → 默认偏好（`DEFAULT_NOTIFY_PREFS`：预警节点默认不发） */
  spawnCalls = 0
  const absent = await notifyFn({ node: 'flow.notify', params })
  check('★ 偏好文件不存在 → 按默认（预警节点不发）',
    absent.notified === false && absent.reason.includes('不发送'), JSON.stringify(absent))
  check('文件不存在时没起子进程', spawnCalls === 0, 'spawn ' + String(spawnCalls) + ' 次')

  /* 文件写坏 → 默认偏好（不炸） */
  await writePrefs('{ 这不是 JSON')
  const broken = await notifyFn({ node: 'flow.notify', params })
  check('★ 偏好文件写坏 → 按默认，不抛错',
    broken.notified === false, JSON.stringify(broken))

  /* 新形状：门槛 info → notice 级别的节点会发 */
  await writePrefs({ failNotify: true, alertMinLevel: 'info' })
  const alerts = await notifyFn({ node: 'flow.notify', params })
  check('★ 盘上写 alertMinLevel: info → 走真发路（notified 为真、理由说明闸门）',
    alerts.notified === true && alerts.reason.includes('闸门'), JSON.stringify(alerts))
  check('门槛 info 在闸门下也没起子进程（闸门只闸「弹」这一下）', spawnCalls === 0,
    'spawn ' + String(spawnCalls) + ' 次')

  /* 新形状：门槛 severe → 同一份 notice 级别的节点不发 */
  await writePrefs({ failNotify: true, alertMinLevel: 'severe' })
  const blocked = await notifyFn({ node: 'flow.notify', params })
  check('★★ 盘上写 alertMinLevel: severe → notice 级别被挡住',
    blocked.notified === false && blocked.reason.includes('低于'), JSON.stringify(blocked))

  /* 旧文件自动迁移（后端负责，这里只验「节点侧仍然工作」）：
   * 旧 `{ mode: 'alerts' }` → `alertMinLevel: 'info'` → notice 级别的节点会发。 */
  await writePrefs({ mode: 'alerts' })
  const legacy = await notifyFn({ node: 'flow.notify', params })
  check('★ 旧文件 { mode: alerts } 迁移后节点照常发（不会被静默关掉）',
    legacy.notified === true, JSON.stringify(legacy))

  /* 旧 `{ mode: 'failures' }` → `alertMinLevel: 'off'` → 节点不发。 */
  await writePrefs({ mode: 'failures' })
  const legacyFail = await notifyFn({ node: 'flow.notify', params })
  check('★ 旧文件 { mode: failures } 迁移后节点不发（与迁移表一致）',
    legacyFail.notified === false && legacyFail.reason.includes('不发送'), JSON.stringify(legacyFail))
}

console.log('')
console.log('=== ⑩ 整图跑一次（真调度器 + 真内置执行方，验输出形状与不传上游）===')
{
  /* 偏好设成门槛 info，让这条路真的走到「发」。 */
  await writePrefs({ failNotify: true, alertMinLevel: 'info' })

  const { runGraph } = await import('../src/workflow/run.ts')
  const { createBuiltinExecutor } = await import('../src/dispatch/executors.ts')
  const builtin = createBuiltinExecutor(NODE_IMPLS)

  /** 一个最小节点规格。
   * @param {string} id - 节点 id。
   * @param {object} def - 节点定义。
   * @param {object} [params] - 参数。
   * @returns {object} 规格。 */
  const spec = (id, def, params = {}) => ({ id, def, params, onError: 'continue', skipped: false })

  const nodes = [
    spec('n1', { id: 'code.js', label: '取数', executor: 'builtin', inputs: [{ id: 'in', label: '入', type: 'any' }], outputs: [{ id: 'out', label: '出', type: 'any' }] }, { code: 'return { 店铺: "天猫", 件数: 3 }' }),
    spec('n2', NODE, { content: '巡查完成：{{店铺}} 有 {{件数}} 个待办', level: 'severe', system: true }),
  ]
  const edges = [{ source: 'n1', target: 'n2' }]

  const outputs = []
  /** 派发给 n2 的命令体（要验变量是不是在真实跑路里被替换了）。 */
  let notifyCommand = null
  const ran = await runGraph(
    { nodes, edges, workdir: process.cwd() },
    async (req) => {
      if (req.nodeId === 'n2') notifyCommand = req.command
      const r = await builtin.run(req)
      const ok = r.status === 'success'
      if (ok) outputs.push({ nodeId: req.nodeId, output: r.output })
      return { ok, status: r.status, output: r.output, logs: r.logs, error: r.error }
    },
    {
      workflowId: '通知节点自检',
      onEvent: (e) => { if (e.kind === 'success' && e.nodeId === 'n2') outputs.push({ nodeId: 'n2', output: e.output }) },
    },
  )

  const notifyOut = outputs.filter(o => o.nodeId === 'n2').map(o => o.output).filter(Boolean).pop()
  const sentText = String(notifyCommand?.params?.content ?? '')
  check('★ 整图跑到了通知节点', ran.ran.includes('n2'), ran.ran.join(','))
  check('★ 输出只有 notified / level / reason 三个字段',
    JSON.stringify(Object.keys(notifyOut ?? {}).sort()) === '["level","notified","reason"]',
    JSON.stringify(Object.keys(notifyOut ?? {})))
  check('★★ 输出里不带上游数据（没有「店铺」「件数」）',
    notifyOut?.店铺 === undefined && notifyOut?.件数 === undefined, JSON.stringify(notifyOut))
  check('★★ 真实跑路里 {{变量}} 被替换了（派发到本节点的正文已是实际值）',
    sentText.includes('天猫') && sentText.includes('3') && !sentText.includes('{{'), sentText)
  check('级别 severe 原样带出', notifyOut?.level === 'severe', String(notifyOut?.level))
  check('门槛 info 下 severely 级别的提醒发出去了', notifyOut?.notified === true, JSON.stringify(notifyOut))
}

console.log('')
console.log('=== ⑪ 旧三档的说法已清干净（代码里不留第二份形状副本）===')
{
  const impl = readFileSync(join(ROOT, 'src/nodes/flow/notify/impl.ts'), 'utf8')
  const node = readFileSync(join(ROOT, 'src/nodes/flow/notify/node.ts'), 'utf8')
  check('★★ impl.ts 里不再自造 NotifyMode 类型', !/export type NotifyMode/.test(impl))
  check('★★ impl.ts 里不再有 normalizeMode 函数', !/function normalizeMode/.test(impl))
  check('★ impl.ts 直接引后端那份类型',
    impl.includes('AlertMinLevel') && impl.includes('NotifyPrefs'), 'import 行')
  check('★★ node.ts 的 cautions 不再写旧三档（「失败提醒」那种说法）',
    !node.includes('失败提醒（默认）') && !node.includes('预警节点提醒：'),
    node.slice(node.indexOf('cautions'), node.indexOf('cautions') + 60))
  check('★★ node.ts 的 cautions 写明新语义（最低级别门槛）',
    node.includes('最低级别') || node.includes('门槛'), 'cautions')
  check('★ node.ts 的 cautions 写明失败提醒是另一项设置',
    node.includes('另一项独立设置'), 'cautions')
  check('R6：detail 里没有第二人称', !node.includes('你'))
  check('R6：detail 里没有疑问句做标签', !/[？?]/.test(node.slice(node.indexOf('detail:'))))
}

console.log('')
if (failed === 0) {
  console.log('全部通过 ✓')
  process.exit(0)
}
console.log('有 ' + String(failed) + ' 条红的 ✗')
process.exit(1)
