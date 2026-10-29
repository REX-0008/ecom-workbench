/** 钉住「参数界面只显示所选功能」——`showWhen` 必须真的生效。
 *
 * ## 为什么有它（用户 2026-10-13 报的问题）
 *
 * 用户原话：「浏览器这个节点，他明明是几个功能选择，但是他的界面是**将所有功能
 * 都列出来了**，这个不对，应该**只列出所选功能**。」
 *
 * 根因：`showWhen` 早就写在参数定义里（全项目 27 处），但**客户端从来没读它**。
 *
 * ## 判据为什么这么写
 *
 * 不能只查「源码里出现了 showWhen」（那样注释就能救活它 —— 本项目踩过）。
 * 所以这里**把那段过滤逻辑真跑一遍**：从产物/源码里取出 `visible` 的实现语义，
 * 用真实节点定义（browser.act 的 12 个参数）测。
 *
 * 做法：直接 import 参数定义，**复制一份与组件相同的判据**跑 ——
 * 但为了不让「测试自己实现一遍」变成假绿，还加了一条：
 * 从 `NodeEditorPopover.tsx` 源码里确认组件**确实调用了**这个过滤
 * （`paramDefs.filter(visible)`）。
 *
 * 跑法：node --import <tsx> tests/param-showwhen.mjs
 */
import { readFileSync } from 'node:fs'
import { NODE_LIBRARY } from '../src/nodes/index.ts'

let failed = 0
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

const lib = Array.isArray(NODE_LIBRARY) ? NODE_LIBRARY : [...NODE_LIBRARY.values()]
/** 与组件里 `visible()` 相同的语义（见 NodeEditorPopover.tsx）。 */
function visible(p, params, allDefs) {
  const w = p.showWhen
  if (w === undefined) return true
  const raw = params[w.key]
  const cur = raw === undefined ? allDefs.find(x => x.key === w.key)?.default : raw
  const curText = cur === undefined || cur === null ? '' : String(cur)
  return w.equals.some(eq => String(eq) === curText)
}

console.log('=== 组件确实用了这个过滤（防「测试自己实现一遍」的假绿）===')
{
  const src = readFileSync(new URL('../src/client/workbench/NodeEditorPopover.tsx', import.meta.url), 'utf8')
  check('组件里定义了 visible()', /const visible = \(p: ParamDef\)/.test(src))
  /* ⚠️ 这条**不要锚死确切写法**（2026-10-16 改过一次：为了让 `hidden` 的参数
   * 不进参数区，那行变成 `.filter(p => p.hidden !== true).filter(visible)`，
   * 于是写死 `paramDefs.filter(visible)` 的断言就红了 —— 而**功能是好的**。
   * 改成判「`paramDefs` 的结果经过了 `visible` 这一关」，且**结果真的被用来渲染**。 */
  check('★ 渲染前按 visible 过滤了（paramDefs → … → visible）',
    /paramDefs\s*\.filter\([^)]*\)?\s*\.?filter\([^)]*visible/.test(src)
    || /shownDefs\s*=\s*paramDefs\.filter\([^\n]*visible/.test(src))
  check('过滤结果真的被用来渲染（shownDefs）', /shownDefs\.filter\(/.test(src))
  /* ★ `hidden` 的参数（用户 2026-10-16 报的重复）不该进参数区 ——
   * 判据是**那行过滤里有 `hidden`**，不是「源码里出现过 hidden 这个词」
   * （那样注释就能救活它，本项目踩过这个假绿）。 */
  check('★ hidden 的参数不进参数区（过滤里有 p.hidden !== true）',
    /shownDefs\s*=\s*paramDefs\.filter\([^\n]*hidden !== true/.test(src))
}

console.log('')
console.log('=== 浏览器节点：选了不同动作，显示的参数不同 ===')
{
  const browser = lib.find(d => d.id === 'browser.act')
  check('找到 browser.act 节点', browser !== undefined)
  const defs = browser.paramDefs
  check('它有 11 个参数（这就是「全列出来」的那个节点）', defs.length === 11, String(defs.length))

  /* 各动作下，应该/不应该出现哪些参数。 */
  const CASES = [
    ['goto', ['url', 'waitUntil'], ['selector', 'text', 'scope', 'format', 'code', 'clear']],
    ['click', ['selector'], ['url', 'waitUntil', 'text', 'scope', 'format', 'code']],
    ['input', ['selector', 'text', 'clear'], ['url', 'waitUntil', 'scope', 'format', 'code']],
    ['text', ['selector'], ['url', 'waitUntil', 'text', 'scope', 'format', 'code']],
    ['screenshot', ['selector', 'scope', 'format'], ['url', 'waitUntil', 'text', 'code']],
    ['eval', ['code'], ['url', 'waitUntil', 'selector', 'text', 'scope', 'format']],
  ]
  for (const [action, shouldShow, shouldHide] of CASES) {
    const params = { action }
    const shown = defs.filter(p => visible(p, params, defs)).map(p => p.key)
    const miss = shouldShow.filter(k => !shown.includes(k))
    const extra = shouldHide.filter(k => shown.includes(k))
    check('动作「' + action + '」只显示该显示的', miss.length === 0 && extra.length === 0,
      miss.length > 0 ? '缺 ' + miss.join(',') : extra.length > 0 ? '多 ' + extra.join(',') : shown.join(','))
  }

  /* 永远该显示的（没有 showWhen 的）：动作、会话、超时。 */
  const always = defs.filter(p => p.showWhen === undefined).map(p => p.key)
  check('动作/会话/超时 永远显示', ['action', 'session', 'timeout'].every(k => always.includes(k)),
    always.join(','))
}

console.log('')
console.log('=== 全部节点：showWhen 覆盖了多少，有没有写错的 ===')
{
  let withWhen = 0
  let bad = []
  for (const d of lib) {
    for (const p of d.paramDefs ?? []) {
      if (p.showWhen === undefined) continue
      withWhen += 1
      /* 依赖的 key 必须真的存在，否则那个参数会**永远不显示**（静默失效）。 */
      const dep = (d.paramDefs ?? []).find(x => x.key === p.showWhen.key)
      if (dep === undefined) bad.push(d.id + '.' + p.key + ' -> 依赖不存在的 ' + p.showWhen.key)
      /* `equals` 的值必须落在依赖参数的选项里（下拉）—— 否则永远命中不了。 */
      else if (dep.options !== undefined) {
        const opts = dep.options.map(o => String(o.value))
        const hit = p.showWhen.equals.some(e => opts.includes(String(e)))
        if (!hit) bad.push(d.id + '.' + p.key + ' -> equals ' + JSON.stringify(p.showWhen.equals) + ' 不在 ' + JSON.stringify(opts))
      }
    }
  }
  console.log('    全项目 showWhen 共 ' + String(withWhen) + ' 处')
  check('★ 没有「依赖不存在的 key / equals 永远命中不了」的', bad.length === 0, bad.join(' | '))
}

console.log('')
console.log(failed === 0
  ? '结论：参数只显示所选功能 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
