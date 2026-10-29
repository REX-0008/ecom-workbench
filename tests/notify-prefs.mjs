/** 提醒偏好的检查（用户 2026-10-22：拆成「失败是否提醒」+「预警节点什么级别才提醒」两项）。
 *
 * ## 为什么这一份必须存在
 *
 * 这几处存错都是**静默**的：
 *   · 偏好存到浏览器里 → 定时任务失败时宿主半读不到，用户以为「已经关了」，其实照弹；
 *   · 设成不提醒但代码没比对 → 关不掉，用户只能去关系统通知；
 *   · **旧文件没迁移** → 升级后把用户设过的档位悄悄重置成默认；
 *   · 文件被手改坏 → 抛错把定时扫表或恢复流程整个搞崩（那比不发通知严重得多）。
 *
 * 所以这里**直接验行为**，不验实现：
 *   · 真写旧形状的文件、真读回、真把 JSON 写坏；
 *   · 真把一个必失败的定时任务交给 `tick()`，数通知被调了几次；
 *   · 真放一份恢复不了的挂起现场，跑一次那个扫描回调，数通知被调了几次。
 *
 * ## 为什么要拦 `notify` 这个模块
 *
 * 生产代码调用的是 `notify(title, text)`，它**没有返回值可数**；
 * 而 `EWB_TEST_NO_SPAWN=1` 闸门只让它「不弹」，照样会静默返回成功 ——
 * 只靠闸门的话，「发了一条」与「一条没发」在测试里长得一模一样（假绿）。
 * 所以在加载器这一层把 `src/notify/index.ts` 换成一份计数桩，
 * 判据才能落在「到底调没调」上。
 *
 * 跑法：node scripts/run-tests.mjs notify-prefs
 */
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { register } from 'node:module'

/* ── 沙箱（必须在载入插件之前设好：模块读环境变量定目录）────────── */
process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-nprefs-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
/* 闸门：即使桩被绕过也不会真弹气球。 */
process.env.EWB_TEST_NO_SPAWN = '1'

/** 桩收到的通知（每次一条 `[title, text]`）。 */
const calls = []
globalThis.__ewbNotifyCalls = calls
const STUB = [
  'export async function notify(title, text) {',
  '  globalThis.__ewbNotifyCalls.push([title, text])',
  "  return { ok: true, reason: '桩：只记账，不弹' }",
  '}',
  'export function killAll() {}',
  'export async function selfcheck() { return {} }',
].join('\n')
/* ⚠️ 只拦我们自己的 `src/notify/index.ts`（按后缀认），别的模块一律放行。
 * 用模板串拼，避免引号打架（这里曾因一个 `'` / `"` 错配整份文件解析失败）。 */
const HOOK = [
  'export async function resolve(spec, ctx, next) {',
  "  if (typeof spec === 'string' && spec.endsWith('/notify/index.ts')) {",
  "    return { url: 'ewb-stub:notify', shortCircuit: true }",
  '  }',
  '  return next(spec, ctx)',
  '}',
  'export async function load(url, ctx, next) {',
  "  if (url === 'ewb-stub:notify') {",
  '    return { format: \'module\', source: STUB_SOURCE, shortCircuit: true }',
  '  }',
  '  return next(url, ctx)',
  '}',
].join('\n').replace('STUB_SOURCE', JSON.stringify(STUB))
register('data:text/javascript,' + encodeURIComponent(HOOK))

const { apply } = await import('../src/index.ts')
const {
  notifyPrefsFile, readNotifyPrefs, writeNotifyPrefs, defaultNotifyPrefs,
  DEFAULT_NOTIFY_PREFS, NOTIFY_PREFS_FILE,
} = await import('../src/notify/prefs.ts')
const { workflowsDir } = await import('../src/workflow/store.ts')
const { PREFS_FILE } = await import('../src/workflow/browser-prefs.ts')
const { seedDefaultTasks, loadTasks, updateTasks } = await import('../src/schedule/store.ts')
const { tick } = await import('../src/schedule/runner.ts')
const { savePausedRun } = await import('../src/workflow/pause-store.ts')

/* ── 假 ctx：抓路由处理函数 + 按标签抓 effect 回调 ───────────────── */
let handler = null
/** 按标签存下来的 effect 回调（本测试只跑「挂起恢复」那一个）。 */
const effects = new Map()
const fakeCtx = {
  inject(names, fn) {
    if (names.includes('webServer')) {
      fn({ webServer: { register(route) { handler = route.handler; return () => { /* 清理 */ } } } })
    }
    if (names.includes('subprocess')) {
      fn({
        subprocess: {
          spawn() {
            return {
              pid: 1,
              terminate() { /* 假句柄 */ },
              waitForExit: async () => true,
              done: Promise.resolve({ exitCode: 0, signal: null }),
              collected: {
                stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
                stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
              },
            }
          },
        },
      })
    }
  },
  /* ⚠️ 不自动执行：真 cordis 会执行（于是起定时器）。本测试只手动跑挂起恢复那一个。 */
  effect(fn, label) {
    effects.set(String(label), fn)
    return () => { /* 清理 */ }
  },
}
apply(fakeCtx)

/** 模拟一次 HTTP 调用。
 * @param method - 方法。
 * @param url - 路径。
 * @param body - 请求体。
 * @returns 解析后的响应。 */
async function call(method, url, body) {
  const { Readable } = await import('node:stream')
  const { EventEmitter } = await import('node:events')
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  req.method = method
  req.url = url
  const res = new EventEmitter()
  let code = 0
  let out = ''
  res.writeHead = (c) => { code = c }
  res.end = (s) => { out = s }
  res.writableEnded = false
  await handler(req, res)
  return { code, body: JSON.parse(out) }
}

let bad = 0
/** 断言一条。
 * @param name - 用例名。
 * @param ok - 过没过。
 * @param detail - 细节。 */
function check(name, ok, detail) {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : ' → ' + detail))
}

/** 把盘上的偏好文件写成给定内容（json 给字符串就原样写，用来造坏 JSON）。
 * @param content - 对象或原始字符串。 */
async function putFile(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  await writeFile(notifyPrefsFile(), text, 'utf8')
}

/** 盘上的偏好文件解析出来（断言「磁盘上到底存了什么」）。
 * @returns 解析后的对象。 */
async function onDisk() {
  return JSON.parse(await readFile(notifyPrefsFile(), 'utf8'))
}

console.log('① 路由注册:', handler === null ? '失败 ✗' : '成功 ✓')

/* ── 一、文件位置 / 形状 / 缺文件（验收 2 的前半）────────────── */
console.log('')
console.log('=== 1a. 文件位置 / 形状 / 缺文件 ===')
{
  check('文件名是 notify-prefs.json', NOTIFY_PREFS_FILE === 'notify-prefs.json'
    && notifyPrefsFile().endsWith('notify-prefs.json'), notifyPrefsFile())
  const mine = dirname(notifyPrefsFile())
  const theirs = dirname(join(workflowsDir(), '..', PREFS_FILE))
  check('★ 与 browser-prefs.json 同目录同级', mine === theirs, mine + ' | ' + theirs)
  check('默认值就是 { failNotify: true, alertMinLevel: "off" }',
    JSON.stringify(DEFAULT_NOTIFY_PREFS) === '{"failNotify":true,"alertMinLevel":"off"}',
    JSON.stringify(DEFAULT_NOTIFY_PREFS))
  check('defaultNotifyPrefs() 每次给新对象', defaultNotifyPrefs() !== defaultNotifyPrefs())

  check('首次读取时文件还不存在', !existsSync(notifyPrefsFile()), notifyPrefsFile())
  const p = await readNotifyPrefs()
  check('★★ 缺文件 → 全默认（failNotify true / alertMinLevel off）',
    p.failNotify === true && p.alertMinLevel === 'off', JSON.stringify(p))
  check('★★ 读不存在的文件不自动创建', !existsSync(notifyPrefsFile()), notifyPrefsFile())
}

/* ── 二、旧文件迁移（验收 1，三个用例）───────────────────────── */
console.log('')
console.log('=== 1b. 旧文件三种 mode 的迁移 ===')
{
  await putFile({ mode: 'failures' })
  const a = await readNotifyPrefs()
  check('★★ 旧 { mode: failures } → failNotify true + alertMinLevel off',
    a.failNotify === true && a.alertMinLevel === 'off', JSON.stringify(a))

  await putFile({ mode: 'alerts' })
  const b = await readNotifyPrefs()
  check('★★ 旧 { mode: alerts } → failNotify true + alertMinLevel info',
    b.failNotify === true && b.alertMinLevel === 'info', JSON.stringify(b))

  await putFile({ mode: 'off' })
  const c = await readNotifyPrefs()
  check('★★ 旧 { mode: off } → failNotify false + alertMinLevel off',
    c.failNotify === false && c.alertMinLevel === 'off', JSON.stringify(c))

  /* 旧值本身就非法（大小写不符 / 带空格 / 别的字符串）→ 当没填，回落默认。 */
  await putFile({ mode: 'OFF' })
  const d = await readNotifyPrefs()
  check('★ 旧值大小写不符 → 回落默认（不算坏的迁移）',
    d.failNotify === true && d.alertMinLevel === 'off', JSON.stringify(d))
  await putFile({ mode: '  alerts  ' })
  const e = await readNotifyPrefs()
  check('★ 旧值带空格 → 回落默认', e.failNotify === true && e.alertMinLevel === 'off', JSON.stringify(e))

  /* 读的时候只翻译、不改写磁盘（回滚能继续读得懂）。 */
  await putFile({ mode: 'alerts' })
  await readNotifyPrefs()
  check('★★ 迁移只在读取时发生，磁盘上仍是旧形状（没被改写）',
    JSON.stringify(await onDisk()) === '{"mode":"alerts"}', JSON.stringify(await onDisk()))
}

/* ── 三、坏 JSON（验收 2 的后半）────────────────────────────── */
console.log('')
console.log('=== 2. 坏 JSON / 不是对象 ===')
{
  await putFile('{')
  let threw = null
  let p = null
  try {
    p = await readNotifyPrefs()
  } catch (err) {
    threw = err
  }
  check('★★ 坏 JSON 不抛错', threw === null, String(threw))
  check('★★ 坏 JSON → 全默认',
    p?.failNotify === true && p?.alertMinLevel === 'off', JSON.stringify(p))
  check('坏 JSON 时也不自动改写文件', (await readFile(notifyPrefsFile(), 'utf8')) === '{')

  await putFile('[]')
  const arr = await readNotifyPrefs()
  check('数组形状 → 全默认', arr.failNotify === true && arr.alertMinLevel === 'off', JSON.stringify(arr))
  await putFile('"乱写"')
  const str = await readNotifyPrefs()
  check('裸字符串 → 全默认', str.failNotify === true && str.alertMinLevel === 'off', JSON.stringify(str))
}

/* ── 四、单字段非法 → 只回落那一个（验收 3，本题要害）────────── */
console.log('')
console.log('=== 3. 单字段非法 → 该字段回落，其它合法字段仍生效 ===')
{
  /* 一条文件里两个字段都坏 —— 读的时候各回落各自的默认。 */
  await putFile({ failNotify: 'yes', alertMinLevel: 'loud' })
  const p = await readNotifyPrefs()
  check('★★ failNotify 不是布尔（"yes"）→ 回落 true', p.failNotify === true, String(p.failNotify))
  check('★★ alertMinLevel 不是四档之一（"loud"）→ 回落 off', p.alertMinLevel === 'off', String(p.alertMinLevel))

  /* 一个好一个坏：好的必须活下来（不是整份作废）。 */
  await putFile({ failNotify: false, alertMinLevel: 'loud' })
  const q = await readNotifyPrefs()
  check('★★★★ 合法的 failNotify: false 仍生效', q.failNotify === false, String(q.failNotify))
  check('★★★★ 同批非法的 alertMinLevel 单独回落 off', q.alertMinLevel === 'off', String(q.alertMinLevel))

  await putFile({ failNotify: 'yes', alertMinLevel: 'severe' })
  const r = await readNotifyPrefs()
  check('★★★★ 合法的 alertMinLevel: severe 仍生效', r.alertMinLevel === 'severe', String(r.alertMinLevel))
  check('★★★★ 同批非法的 failNotify 单独回落 true', r.failNotify === true, String(r.failNotify))

  /* 四档都认。 */
  for (const lv of ['off', 'info', 'notice', 'severe']) {
    await putFile({ failNotify: true, alertMinLevel: lv })
    check('alertMinLevel 认 ' + lv, (await readNotifyPrefs()).alertMinLevel === lv)
  }

  /* 写的时候非法字段 = **跳过**（回落盘上原值，不打回默认）。 */
  await putFile({ failNotify: false, alertMinLevel: 'notice' })
  const w = await writeNotifyPrefs({ failNotify: 'yes', alertMinLevel: 'info' })
  check('★ 写时非法 failNotify 被跳过（保持盘上 false）', w.failNotify === false, String(w.failNotify))
  check('★ 写时合法 alertMinLevel 生效', w.alertMinLevel === 'info', String(w.alertMinLevel))
  const w2 = await writeNotifyPrefs({ alertMinLevel: 'loud' })
  check('★ 写时非法 alertMinLevel 被跳过（保持 info，不打回 off）',
    w2.alertMinLevel === 'info', String(w2.alertMinLevel))
}

/* ── 五、两条路由（验收 4）────────────────────────────────── */
console.log('')
console.log('=== 4. 两条路由 ===')
{
  /* 先把盘上清成默认，才好判断「另一个字段不变」。 */
  await putFile(DEFAULT_NOTIFY_PREFS)

  const g0 = await call('GET', '/api/ecom-workbench/notify/prefs')
  check('GET 回 200 + { ok, prefs }', g0.code === 200 && g0.body.ok === true
    && g0.body.prefs?.failNotify === true && g0.body.prefs?.alertMinLevel === 'off',
    JSON.stringify(g0.body))

  const p1 = await call('POST', '/api/ecom-workbench/notify/prefs', { prefs: { failNotify: false } })
  check('★★ POST 回 200', p1.code === 200 && p1.body.ok === true, JSON.stringify(p1.body))
  check('★ POST 返回合并后的完整对象（两个字段都在）',
    p1.body.prefs?.failNotify === false && p1.body.prefs?.alertMinLevel === 'off',
    JSON.stringify(p1.body.prefs))

  const g1 = await call('GET', '/api/ecom-workbench/notify/prefs')
  check('★★ 随后 GET 读回 failNotify: false', g1.body.prefs?.failNotify === false,
    JSON.stringify(g1.body.prefs))
  check('★★ 且 alertMinLevel 不变（仍是 off）', g1.body.prefs?.alertMinLevel === 'off',
    JSON.stringify(g1.body.prefs))

  /* 非法值照样 200，且只影响那一个字段。 */
  const p2 = await call('POST', '/api/ecom-workbench/notify/prefs', { prefs: { alertMinLevel: 'loud' } })
  check('★ 非法字段也回 200', p2.code === 200 && p2.body.ok === true, JSON.stringify(p2.body))
  check('★ 非法 alertMinLevel 被跳过（仍是 off），failNotify 也没动',
    p2.body.prefs?.alertMinLevel === 'off' && p2.body.prefs?.failNotify === false,
    JSON.stringify(p2.body.prefs))

  const p3 = await call('POST', '/api/ecom-workbench/notify/prefs', { prefs: { alertMinLevel: 'notice' } })
  check('★ 改 alertMinLevel 不动 failNotify',
    p3.body.prefs?.alertMinLevel === 'notice' && p3.body.prefs?.failNotify === false,
    JSON.stringify(p3.body.prefs))
  check('盘上真落了 notice', (await onDisk()).alertMinLevel === 'notice', JSON.stringify(await onDisk()))

  /* 空 body / 不是对象也不该炸。 */
  const p4 = await call('POST', '/api/ecom-workbench/notify/prefs', {})
  check('没给 prefs 也不炸（整份保持原样）', p4.code === 200
    && p4.body.prefs?.alertMinLevel === 'notice' && p4.body.prefs?.failNotify === false,
    JSON.stringify(p4.body))
}

/* ── 六、定时任务失败（验收 5）────────────────────────────── */
console.log('')
console.log('=== 5. 定时任务失败时按 failNotify 决定发不发 ===')
{
  await seedDefaultTasks()

  /** 把第 0 条任务设成「此刻」、并清掉今天已跑标记。
   * @param tag - 任务名后缀（两次跑用不同名字，便于看输出）。 */
  const arm = async (tag) => {
    const now = new Date()
    const hhmm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0')
    await updateTasks(list => list.map((t, i) => i === 0
      ? { ...t, enabled: true, time: hhmm, lastRunDate: undefined, lastResult: undefined, name: '[自动生成] 偏好测试' + tag }
      : { ...t, enabled: false }))
    return now
  }
  /** 假派发：必失败（本测试要验的是「发不发通知」，不是节点实现）。 */
  const failDispatch = async () => ({ ok: false, status: 'failed', output: null, logs: [], error: '假装失败' })

  await call('POST', '/api/ecom-workbench/notify/prefs', { prefs: { failNotify: false } })
  calls.length = 0
  const nowOff = await arm('A')
  const ranOff = await tick(failDispatch, { workdir: process.env.EWB_TEST_HOME }, nowOff)
  const tOff = (await loadTasks())[0]
  check('failNotify: false 时那条任务照跑（只是不提醒）', ranOff.length === 1, JSON.stringify(ranOff))
  check('★★ failNotify: false 时**不调** notify', calls.length === 0, JSON.stringify(calls))
  check('★★ failNotify: false 时 lastResult 仍记「失败：…」',
    String(tOff.lastResult).startsWith('失败：'), String(tOff.lastResult))

  await call('POST', '/api/ecom-workbench/notify/prefs', { prefs: { failNotify: true } })
  calls.length = 0
  const nowOn = await arm('B')
  const ranOn = await tick(failDispatch, { workdir: process.env.EWB_TEST_HOME }, nowOn)
  check('failNotify: true 时那条任务照跑', ranOn.length === 1, JSON.stringify(ranOn))
  check('★★ failNotify: true 时**会调** notify', calls.length === 1, JSON.stringify(calls))
  check('★ 通知标题是「定时任务失败：…」', String(calls[0]?.[0]).startsWith('定时任务失败：'), String(calls[0]?.[0]))

  /* alertMinLevel 与定时失败无关：它设成 off，失败通知照发。 */
  await call('POST', '/api/ecom-workbench/notify/prefs', { prefs: { failNotify: true, alertMinLevel: 'off' } })
  calls.length = 0
  const nowMix = await arm('C')
  await tick(failDispatch, { workdir: process.env.EWB_TEST_HOME }, nowMix)
  check('★★ alertMinLevel: off 不影响失败通知（两项独立）', calls.length === 1, JSON.stringify(calls))
}

/* ── 七、挂起恢复失败（验收 6）──────────────────────────────
 *
 * 那两处通知住在 `ctx.effect` 的扫描回调里。这里把那个回调单独跑一次：
 * 放一份「恢复不了」的现场（工作流名不存在 → 恢复必失败）。 */
console.log('')
console.log('=== 6. 挂起恢复失败时按 failNotify 决定发不发 ===')
{
  const factory = effects.get('ecom-workbench: paused resume')
  check('抓到了「挂起恢复」的扫描回调', typeof factory === 'function', String(typeof factory))
  if (typeof factory === 'function') {
    /** 放一份恢复不了的现场。
     * @param runId - 运行 id。 */
    const put = async (runId) => {
      await savePausedRun({
        version: 1,
        runId,
        workflowId: '不存在的工作流-偏好测试',
        startedAt: 1,
        pausedAt: 1,
        resumeAfter: 'n1',
        ran: ['n1'],
        executions: 1,
        outputs: { n1: {}, n2: {} },
        unreachable: [],
        inputs: {},
        wait: { mode: 'duration', resumeAtMs: 0, ms: 0 },
      })
    }
    /** 起一轮扫描（`beat()` 自己不 await，所以靠固定等一会儿）。
     * ⚠️ 每轮都重新调一次工厂：`beat` 有 `busy` 防重入、`dispose` 会把 `stopped` 置真，
     * 复用同一个闭包时第二轮什么都不做（第一版就这么红的）。
     * @param runId - 这份现场的运行 id。
     * @param ms - 给它多少毫秒干完。
     * @returns 这一轮收到的通知条数。 */
    const scanOnce = async (runId, ms) => {
      calls.length = 0
      await put(runId)
      const dispose = factory()
      await new Promise(r => setTimeout(r, ms))
      if (typeof dispose === 'function') dispose()
      return calls.length
    }

    await call('POST', '/api/ecom-workbench/notify/prefs', { prefs: { failNotify: false } })
    const nOff = await scanOnce('r-off', 600)
    check('★★ failNotify: false 时挂起恢复失败**不调** notify', nOff === 0, JSON.stringify(calls))

    await call('POST', '/api/ecom-workbench/notify/prefs', { prefs: { failNotify: true } })
    const nOn = await scanOnce('r-on', 1500)
    check('★ failNotify: true 时挂起恢复失败**会调** notify', nOn >= 1, JSON.stringify(calls))
    check('★ 通知标题是「挂起的运行恢复失败：…」',
      String(calls[0]?.[0] ?? '').startsWith('挂起的运行恢复失败：'), String(calls[0]?.[0]))
  }
}

/* ── 八、文案守 R6（验收 7）──────────────────────────────────
 *
 * 只查**用户看得见的字符串字面量**，不查整行源码 ——
 * 三元表达式里那个 `?` 不是文案（第一版就这么假红了一次）。 */
console.log('')
console.log('=== 7. 文案 ===')
{
  const src = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
  const start = src.indexOf("path === '/api/ecom-workbench/notify/prefs' && r.method === 'GET'")
  const end = src.indexOf("path === '/api/ecom-workbench/ui/prefs' && r.method === 'GET'")
  const block = start >= 0 && end > start ? src.slice(start, end) : ''
  check('找到了提醒偏好那两条路由', block !== '', start + '..' + end)
  /** 路由块里所有带中文的字符串字面量（就是会到用户眼前的那些字）。 */
  const texts = [...block.matchAll(/'([^'\\]*[\u4e00-\u9fa5][^'\\]*)'/g)].map(m => m[1])
  check('路由块里有用户可见文案', texts.length > 0, JSON.stringify(texts))
  check('★ 不含第二人称（你 / 您）', texts.every(t => !/[你您]/.test(t)), JSON.stringify(texts))
  check('★ 不用疑问句做标签', texts.every(t => !/[？?]/.test(t)), JSON.stringify(texts))
  check('★ 不含「折腾 / 省事 / 顺手 / 一会儿 / 其实 / 别怕」',
    texts.every(t => !/折腾|省事|顺手|一会儿|其实|别怕/.test(t)), JSON.stringify(texts))
}

console.log('')
if (bad === 0) {
  console.log('全部通过 ✓')
  await rm(process.env.EWB_TEST_HOME, { recursive: true, force: true })
  process.exit(0)
}
console.log('有 ' + String(bad) + ' 条红的 ✗')
process.exit(1)
