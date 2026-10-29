/** 定时任务是**串行**的：界面说一句、代码写清为什么、加一条会话重叠的防呆（票 16，2026-10-30）。
 *
 * # 起因
 *
 * 用户定下「保持串行」。三件事没人管就会散：
 *
 *   ① 界面上不说 → 用户看到五条任务都定在 09:30，以为会同时跑，
 *      跑完后看到时间戳一条接一条，以为是没跑完或者卡住了；
 *   ② 代码里不写为什么 → 下一个人看到 `for` + `await`，第一反应是「漏了 `Promise.all`」，
 *      顺手「优化」掉，于是两个工作流同时操作同一个浏览器页面；
 *   ③ 没有断言 → ②那种改动**不会变红**，坏法还是静默的（结果照落盘，只是数字不是那一页的）。
 *
 * # 这一份盯什么
 *
 * | 判据 | 坏法 | 抓它的断言 |
 * |---|---|---|
 * | 1 | 界面那句被删掉 / 写了但没渲染 | 真的挂了组件，读 **DOM 里的文字** |
 * | 2 | `tick()` 的 `for` 换成 `Promise.all` | 假派发记并发峰值，必须是 1 |
 * | 3 | 五个任务的会话标签改成全不相同（于是「不能并行」这条依据消失） | 按 `PATROL_JOBS[].tag` 分组，必须有一组 ≥ 2 |
 * | 4 | 本条说明被删掉 | 本文件头必须写着它防的是什么 |
 *
 * # 判据 3 的断言**防的是什么**（票面要求如实写明）
 *
 * 它防的是「**将来有人改成并行而不做分组**」：五个默认巡查任务共用三套浏览器会话
 * （天猫两份 / 抖音两份 / 千川一份），同会话的两份是同一个已登录浏览器，
 * 并行会互相把页面导航走。这条断言验的是**事实**（会话有重叠），
 * 不是「代码里有没有 `Promise.all`」—— 后者换个写法就绕过去了。
 *
 * 所以哪天它红了，先想清楚：是任务名单真的变了，还是有人为了方便并行
 * 把 `tag` 改成了一任务一会话。后者改完，串行这条约束就没有依据了。
 *
 * 跑法：`node scripts/run-tests.mjs schedule-serial`
 */
import { mkdtemp } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire, register } from 'node:module'
import { settle, waitUntil } from './_wait.mjs'

/* ── 沙箱与闸门（必须在载入插件模块之前设好：模块读环境变量定目录）────── */
process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-serial-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
/* 不弹系统通知（跑测试弹气球会打断用户）。 */
process.env.EWB_TEST_NO_SPAWN = '1'

let bad = 0
/**
 * 断言一条。
 * @param {string} name - 用例名。
 * @param {boolean} ok - 过没过。
 * @param {string} [detail] - 细节。
 */
function check(name, ok, detail) {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : ' → ' + detail))
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 界面上那句说明（真的渲染出来才算）
 *
 * ⚠️ 不按「源码里有这几个字」断言。那种写法抓不住「写了但渲染在
 * `{cond && …}` 的分支里、cond 永远为假」—— 用户屏幕上什么都没有，测试却绿。
 * ══════════════════════════════════════════════════════════════════════ */
console.log('① 定时板块的说明文字（渲染出来的）')

register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, ctx, next) {\n'
  + "  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }\n"
  + '  return next(url, ctx)\n'
  + '}\n',
))

const require = createRequire(import.meta.url)
const { JSDOM } = require('jsdom')

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
try { Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true }) } catch { /* 只读则跳过 */ }
globalThis.localStorage = window.localStorage
globalThis.HTMLElement = window.HTMLElement
globalThis.Element = window.Element
globalThis.Node = window.Node
globalThis.SVGElement = window.SVGElement
globalThis.DocumentFragment = window.DocumentFragment
globalThis.MouseEvent = window.MouseEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.getComputedStyle = window.getComputedStyle
globalThis.requestAnimationFrame = window.requestAnimationFrame
globalThis.cancelAnimationFrame = window.cancelAnimationFrame
globalThis.ResizeObserver = window.ResizeObserver ?? class { observe() {} unobserve() {} disconnect() {} }
window.matchMedia = window.matchMedia ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
globalThis.matchMedia = window.matchMedia

/** 假宿主：只回这块要的那两条路由。 */
const host = async (url) => {
  const p = String(url).replace(/^https?:\/\/[^/]+/, '')
  if (p === '/api/ecom-workbench/schedule/tasks') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        tasks: [{
          id: 's-1', name: '[自动生成] 巡查-天猫-店铺数据', workflowName: '巡查-天猫-店铺数据',
          time: '09:30', enabled: true, lastResult: '成功：跑完了（3 个节点）', lastRunAt: Date.now(),
        }],
      }),
    }
  }
  if (p === '/api/ecom-workbench/workflows') {
    return { ok: true, status: 200, json: async () => ({ items: [{ name: '巡查-天猫-店铺数据' }] }) }
  }
  return { ok: true, status: 200, json: async () => ({ ok: true }) }
}
window.fetch = host
globalThis.fetch = host

const React = require('react')
const { createRoot } = require('react-dom/client')
const { act } = React
globalThis.React = React

const { ScheduleBoard } = await import('../src/client/workbench/ScheduleBoard.tsx')

/** 「多个任务会串行」那句话的原文（票面建议措辞，一字不改）。 */
const SERIAL_SENTENCE = '多个任务到同一时间点时，按任务表顺序逐个执行。'

const hostEl = window.document.createElement('div')
window.document.body.appendChild(hostEl)
const root = createRoot(hostEl)
await act(async () => {
  root.render(React.createElement(ScheduleBoard, {
    active: true, tab: '', apiBase: '/api/ecom-workbench',
    topHidden: false, onToggleTop: () => {}, onSelectTab: () => {}, onRunWorkflow: () => {},
  }))
})
await act(async () => { await settle() })
/* 先等任务表真的读出来（加载态那一屏上没有底部说明）。 */
await waitUntil(() => hostEl.textContent.includes('09:30'))
await act(async () => { await settle() })

/* 取**底部说明那一段**的渲染文字（不是整页、也不是源码常量）。
 * 判据 1 要证明的是「它真的画在屏幕上」，所以只能从这里取。 */
const noteEl = [...hostEl.querySelectorAll('div')]
  .filter(n => (n.textContent ?? '').includes('执行器每分钟扫一次任务表'))
  .pop()
const noteText = noteEl?.textContent ?? ''

check('★★ 那句「逐个执行」渲染到了屏幕上', noteText.includes(SERIAL_SENTENCE),
  noteText === '' ? '（底部说明段都没找到）' : JSON.stringify(noteText.slice(-120)))
check('★★ 它挂在底部那段说明的末尾（不是散在别处）',
  noteText.trim().endsWith(SERIAL_SENTENCE), JSON.stringify(noteText.slice(-60)))
/* R6 跑在**渲染出来的那段文字**上：不用第二人称、不用疑问句或感叹句。 */
check('★★ 那段说明没有第二人称（R6.1）', noteText !== '' && !/[你您]/.test(noteText), noteText)
check('★★ 那段说明没有疑问句或感叹句（R6.3）', noteText !== '' && !/[？?！!]/.test(noteText), noteText)

await act(async () => { root.unmount() })
hostEl.remove()

/* ══════════════════════════════════════════════════════════════════════
 * ② `tick()` 仍是串行 —— 按**行为**验，不按源码文本
 *
 * 判据要能被「把 `for` 换成 `Promise.all`」这条改动打红，所以只能看实际并发：
 * 假派发进一次记一次在途数，峰值必须是 1。
 * （读源码找 `Promise.all` 抓不住「换个写法并行」，也抓不住「for 里不 await」。）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('② tick() 里两个任务同一分钟到点：必须一个跑完才跑下一个')

const { saveWorkflow } = await import('../src/workflow/store.ts')
const { seedDefaultTasks, loadTasks, updateTasks } = await import('../src/schedule/store.ts')
const { tick } = await import('../src/schedule/runner.ts')

const WF = '串行测试流'
await saveWorkflow({
  version: 1,
  name: WF,
  nodes: [{ id: 'n1', defId: 'code.js', position: { x: 0, y: 0 }, params: { code: 'return 1' }, onError: 'stop' }],
  edges: [],
}, WF)

await seedDefaultTasks()

const NOW = new Date()
const hhmm = String(NOW.getHours()).padStart(2, '0') + ':' + String(NOW.getMinutes()).padStart(2, '0')
/* 前两条设成此刻、其余停用；两条都指向同一份工作流（内容与并发无关，验的是「能不能同时」）。 */
await updateTasks(list => list.map((t, i) => i < 2
  ? { ...t, time: hhmm, enabled: true, workflowName: WF, name: '[自动生成] 串行测试' + String(i + 1) }
  : { ...t, enabled: false }))

/** 在途数峰值：串行时恒为 1；换成 `Promise.all` 会到 2。 */
let live = 0
let peak = 0
/** 每次派发的进入 / 离开时刻，用来证明两段**时间区间不重叠**。 */
const spans = []
const fakeDispatch = async () => {
  live += 1
  peak = Math.max(peak, live)
  const t0 = Date.now()
  /* 故意慢一点：两个立刻返回的异步函数在 `Promise.all` 下也可能被排成一先一后，
   * 那样峰值到不了 2，这条断言就白写了（假绿）。 */
  await new Promise(resolve => setTimeout(resolve, 40))
  spans.push({ t0, t1: Date.now() })
  live -= 1
  return { ok: true, status: 'success', output: 'ok', logs: ['假装跑了一步'] }
}

const ranIds = await tick(fakeDispatch, { workdir: process.env.EWB_TEST_HOME }, NOW)
const afterTasks = await loadTasks()
const dueIds = afterTasks.slice(0, 2).map(t => t.id)

check('★ 两条到点的都跑了（不是只跑第一条就停）', ranIds.length === 2, JSON.stringify(ranIds))
check('★★ 并发峰值是 1（一个跑完才起下一个）', peak === 1, '峰值 ' + String(peak))
check('★★ 按任务表顺序跑（先表里靠前的那条）', ranIds.join(',') === dueIds.join(','),
  ranIds.join(',') + ' / 表里顺序 ' + dueIds.join(','))
check('★★ 两段执行的时间区间**不重叠**（后一段的起点不早于前一段的终点）',
  spans.length === 2 && spans[1].t0 >= spans[0].t1,
  JSON.stringify(spans.map(s => s.t1 - s.t0)))

/* ══════════════════════════════════════════════════════════════════════
 * ③ 五个默认巡查任务里，至少两份共用同一个浏览器会话
 *
 * 见文件头「判据 3 的断言防的是什么」。验的是事实（会话有重叠），
 * 不是「代码里有没有 `Promise.all`」。
 * ══════════════════════════════════════════════════════════════════════ */
console.log('③ 默认巡查任务的浏览器会话有重叠（这就是不能并行的硬理由）')

const { PATROL_JOBS } = await import('../scripts/patrol/jobs.mjs')

/** 会话标签 → 用它的任务名。 */
const byTag = new Map()
for (const job of PATROL_JOBS) {
  const list = byTag.get(job.tag) ?? []
  list.push(job.name)
  byTag.set(job.tag, list)
}
const shared = [...byTag.entries()].filter(([, list]) => list.length >= 2)

check('★ 五份巡查都有会话标签', PATROL_JOBS.length === 5 && PATROL_JOBS.every(j => typeof j.tag === 'string' && j.tag !== ''),
  PATROL_JOBS.map(j => j.tag).join(','))
check('★★ 至少一组会话被两份任务共用（并行会互相踩页面）', shared.length >= 2,
  shared.map(([tag, list]) => tag + ' ← ' + list.join(' / ')).join('；'))
check('★★ 重叠的正是天猫与抖音那两组（千川单独一套）',
  JSON.stringify(shared.map(([tag]) => tag).sort()) === JSON.stringify(['天猫', '抖音']),
  shared.map(([tag]) => tag).join(',') + ' / 共 ' + String(byTag.size) + ' 套会话')

/* ══════════════════════════════════════════════════════════════════════
 * ④ 这条断言「防什么」写在本文件里，不许只剩代码
 *
 * 判据 4 是**文档要求**：将来有人改成并行、看到 ③ 红了，
 * 得能在这里读到「这不是测试老，是你该先做分组」。
 * ══════════════════════════════════════════════════════════════════════ */
console.log('④ 这条防呆断言自己说明白了它防什么')

const selfText = readFileSync(new URL(import.meta.url), 'utf8')
check('★★ 文件头写明了防的是「将来有人改成并行而不做分组」',
  selfText.includes('将来有人改成并行而不做分组'), '本文件文件头')
check('★★ 也写明了它验的是事实（会话重叠）、不是 `Promise.all`',
  selfText.includes('不是「代码里有没有 `Promise.all`」'), '本文件文件头')

console.log(bad === 0 ? '\n全部通过 ✓' : '\n有 ' + String(bad) + ' 条没过 ✗')
process.exit(bad === 0 ? 0 : 1)
