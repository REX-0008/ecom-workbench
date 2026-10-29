/** 节点依赖判定（票 22，2026-10-27）。
 *
 * ## 这一份盯什么
 *
 * 票面四条判据：
 *
 *   ① 某节点声明了一个不存在的依赖 → 它进 `missing` 态；
 *   ② 依赖满足 → 不进 `missing` 态；
 *   ③ 界面上 `missing` 态说得清缺什么、怎么装；
 *   ④ `depsImplemented` 不再是 `false`。
 *
 * ## 为什么给 `judgeDeps` 注入 `DepProbe`
 *
 * 不注入的话只能真去装一个 python 才能验「缺件」那条 —— 而「这台机器上恰好没有」
 * 是环境属性，不是代码属性：换台开发机断言就红，反过来装了 python 的机器上
 * 那条断言会**永远绿着**（它验的是「这一声条件不成立」，不是代码对不对）。
 * 所以探测点做成注入的，测试造事实。
 *
 * 真探测（`makeDepProbe`）另有一组断言，但只验**它会不会说假话**：
 * 「声明了但确实存在的东西不许被判缺」（用 `node` 这个必然存在的程序验）。
 *
 * 跑法：`node scripts/run-tests.mjs node-deps`
 */
import { readFileSync } from 'node:fs'
import {
  DEP_KINDS, DEP_KIND_LABEL, judgeDeps, judgeLibrary, makeDepProbe,
} from '../src/workflow/deps-check.ts'

let failed = 0
/**
 * 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/**
 * 造一个探测实现：只有给的那些算有。
 * @param have - `{ npm?: [], bin?: [], env?: [], files?: [] }`。
 * @returns 探测实现。
 */
function fakeProbe(have) {
  const has = (kind, name) => (have[kind] ?? []).includes(name)
  return {
    hasNpm: n => has('npm', n),
    hasBin: n => has('bin', n),
    hasEnv: n => has('env', n),
    hasFile: n => has('files', n),
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 判据 1：声明了不存在的依赖 → 判缺
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 声明了不存在的依赖 → 判缺 ===')
{
  const one = judgeDeps({ bin: ['python'] }, fakeProbe({ bin: [] }))
  check('★★ 声明的程序不在 → ok:false', one.ok === false, String(one.ok))
  check('★★ 缺口清单里就是那一条', one.gaps.length === 1 && one.gaps[0].kind === 'bin' && one.gaps[0].name === 'python',
    JSON.stringify(one.gaps))
  check('★★ 那句话里点了名（说得出缺的是 python）', one.reason.includes('python'), one.reason)
  check('★★ 那句话也说了怎么装（不能只说缺）',
    one.reason.includes('PATH') || one.reason.includes('装'), one.reason)

  const npmMiss = judgeDeps({ npm: ['playwright'] }, fakeProbe({ npm: [] }))
  check('★★ npm 包不在 → 判缺，且原因里提到装包',
    npmMiss.ok === false && npmMiss.reason.includes('npm install'), npmMiss.reason)

  const envMiss = judgeDeps({ env: ['IMAGE_API_KEY'] }, fakeProbe({ env: [] }))
  check('★★ 环境变量没设 → 判缺，原因里提到设变量',
    envMiss.ok === false && envMiss.reason.includes('环境变量'), envMiss.reason)

  const fileMiss = judgeDeps({ files: ['assets/x.json'] }, fakeProbe({ files: [] }))
  check('★★ 随附文件不在 → 判缺', fileMiss.ok === false, fileMiss.reason)

  /* 四类一起缺：话要分开说，不许把「装包」那句说三遍。 */
  const many = judgeDeps({ npm: ['a', 'b'], bin: ['c'], env: ['D'] }, fakeProbe({}))
  check('★★ 四类都缺 → 每条缺口都在清单里（4 条）', many.gaps.length === 4, String(many.gaps.length))
  check('★★ 同一类的多个名字合成一句（不重复念装法）',
    (many.reason.match(/npm install/g) ?? []).length === 1, many.reason)
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 判据 2：依赖满足 → 不判缺
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 依赖满足 → 不判缺（不许把有的说成缺的） ===')
{
  const ok = judgeDeps({ npm: ['playwright'], bin: ['node'] }, fakeProbe({ npm: ['playwright'], bin: ['node'] }))
  check('★★ 全部满足 → ok:true', ok.ok === true, String(ok.ok))
  check('★★ 缺口清单是空的', ok.gaps.length === 0, String(ok.gaps.length))
  check('★★ 满足时不给那句原因（空串，不是「没缺」三个字）', ok.reason === '', JSON.stringify(ok.reason))

  check('★★ 没有声明 deps 的节点 → 直接算满足',
    judgeDeps(undefined, fakeProbe({})).ok === true, '')
  check('★★ 声明是空对象也算满足（没有要求 = 没有缺口）',
    judgeDeps({}, fakeProbe({})).ok === true, '')
  check('★ 某类声明成空数组也算满足', judgeDeps({ npm: [] }, fakeProbe({})).ok === true, '')

  /* 只缺一样：不许把满足的那几样也列出来（旧界面那块就是这么错的）。 */
  const half = judgeDeps({ npm: ['playwright'], bin: ['python'] }, fakeProbe({ npm: ['playwright'], bin: [] }))
  check('★★ 只列真缺的那一条（有 playwright 就不许报它）',
    half.gaps.length === 1 && half.gaps[0].name === 'python', JSON.stringify(half.gaps))
  check('★★ 那句话里不许出现满足了的那个名字', !half.reason.includes('playwright'), half.reason)
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ `judgeLibrary`：只回缺的、带上节点 id
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 一批节点：只回缺件的那些 ===')
{
  const lib = [
    { id: 'browser.act', deps: { npm: ['playwright'], bin: ['node'] } },
    { id: 'code.python', deps: { bin: ['python'] } },
    { id: 'flow.start' },
    { id: 'ecom.image-gen', deps: { env: ['IMAGE_API_KEY'] } },
  ]
  const missing = judgeLibrary(lib, fakeProbe({ npm: ['playwright'], bin: ['node'] }))
  check('★★ 只回缺的（python 与 IMAGE_API_KEY 两个）', missing.length === 2, String(missing.length))
  check('★★ 满足的 browser.act 不在里面', !missing.some(m => m.id === 'browser.act'),
    missing.map(m => m.id).join(','))
  check('★★ 没声明 deps 的 flow.start 也不在里面', !missing.some(m => m.id === 'flow.start'),
    missing.map(m => m.id).join(','))
  check('★★ 每条带节点 id（界面要靠它把节点标红）',
    missing.every(m => typeof m.id === 'string' && m.id !== ''), JSON.stringify(missing.map(m => m.id)))
  check('★★ 全部满足时回空数组', judgeLibrary(lib, fakeProbe({
    npm: ['playwright'], bin: ['node', 'python'], env: ['IMAGE_API_KEY'],
  })).length === 0, '')
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 真探测不许说假话
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 真探测（makeDepProbe）：有的不许判成没的 ===')
{
  const probe = makeDepProbe()
  /* node 一定在 —— 这份测试本身就是 node 在跑（`process.execPath` 存在）。
   * 拿它验「真探测会不会把有的说成没的」最稳。 */
  check('★★ 真探测：node 这个程序判为有（在跑测试就一定有）', probe.hasBin('node') === true, String(probe.hasBin('node')))
  check('★★ 一个不存在的程序名判为没有', probe.hasBin('ewb-no-such-bin-xyz') === false, '')
  check('★★ 一个不存在的 npm 包判为没有', probe.hasNpm('ewb-no-such-pkg-xyz') === false, '')
  check('★★ 本项目的 playwright 判为有（package.json 里就有它）',
    probe.hasNpm('playwright') === true, String(probe.hasNpm('playwright')))
  /* 环境变量：设成空串与没设一样。 */
  process.env.EWB_DEP_PROBE_TEST = ''
  check('★★ 环境变量设成空串不算有（空值 = 没配）', probe.hasEnv('EWB_DEP_PROBE_TEST') === false, '')
  process.env.EWB_DEP_PROBE_TEST = 'x'
  check('★★ 设成非空算有', probe.hasEnv('EWB_DEP_PROBE_TEST') === true, '')
  delete process.env.EWB_DEP_PROBE_TEST
  check('★ 删掉之后算没有', probe.hasEnv('EWB_DEP_PROBE_TEST') === false, '')
  check('★★ 不存在的文件判为没有', probe.hasFile('ewb-no-such-file-xyz.json') === false, '')
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 真节点库里的那几条声明，判定跑得通
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 拿真节点库跑一遍（不崩、结果形状对） ===')
{
  const { NODE_LIBRARY } = await import('../src/nodes/index.ts')
  const declared = NODE_LIBRARY.filter(d => d.deps !== undefined)
  check('★★ 节点库里确实有节点声明了 deps（否则这一票没法验）',
    declared.length > 0, declared.map(d => d.id).join(','))
  const judged = judgeLibrary(NODE_LIBRARY)
  check('★★ 判定跑得通，每条缺件都带 id 与原因',
    judged.every(j => j.id !== '' && j.reason !== '' && j.gaps.length > 0),
    judged.map(j => j.id + '(' + j.reason.slice(0, 20) + ')').join(' / ') || '（全齐）')
  /* 声明的依赖类型都在这四类里（不许出现第五类没判的）。 */
  const kinds = new Set()
  for (const d of declared) for (const k of DEP_KINDS) for (const _ of d.deps[k] ?? []) kinds.add(k)
  check('★★ 声明里出现了哪几类，判定就覆盖哪几类',
    [...kinds].every(k => DEP_KINDS.includes(k)), [...kinds].join(','))
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 判据 3 + 4：界面说清缺什么、`depsImplemented` 不再是 false
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑥ 界面与宿主半的接线 ===')
{
  const hostSrc = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  check('★★ 判据 4：`depsImplemented` 不再是 false',
    !hostSrc.includes('depsImplemented: false') && hostSrc.includes('depsImplemented: true'),
    hostSrc.includes('depsImplemented: true') ? 'depsImplemented: true' : '没找到')
  check('★★ 宿主半真去判了（调 judgeLibrary）', hostSrc.includes('judgeLibrary(NODE_LIBRARY)'), '')
  check('★★ `/env-check` 把缺件清单带出去了（`depsMissing`）', hostSrc.includes('depsMissing'), '')
  check('★★ 另有一条只判依赖的路由（画布挂载时用，不必付存档+浏览器检测的代价）',
    hostSrc.includes('/api/ecom-workbench/nodes/deps'), '')

  const listSrc = readFileSync(new URL('../src/client/workbench/WorkflowList.tsx', import.meta.url), 'utf8')
  check('★★ 判据 3：环境检测里逐条列出缺件的节点', listSrc.includes('data-ewb-env-dep-node'), '')
  check('★★ 判据 3：每一条都带「怎么装」那句（不只是节点名）',
    listSrc.includes('data-ewb-env-dep-reason'), '')
  check('★★ 那条「还没实现」的旧提示已经删掉（它现在是假话）',
    !listSrc.includes('声明式依赖（某节点要哪些 npm 包 / 外部程序 / 环境变量）还没做'), '')
  check('★★ 但「没查到」这条路还留着（老宿主半时要说实话，不许说成「没缺」）',
    listSrc.includes('env.depsImplemented') && listSrc.includes('没查'), '')

  const nodeSrc = readFileSync(new URL('../src/client/workbench/NodeEditorPopover.tsx', import.meta.url), 'utf8')
  check('★★ 判据 3：节点属性面板只列**真缺的**（不许把声明全列一遍再标缺失）',
    nodeSrc.includes('props.depsGap.gaps.map'), '')
  check('★★ 判据 3：面板里也给了「怎么装」',
    nodeSrc.includes('data-ewb-node-deps-fix'), '')

  const canvasSrc = readFileSync(new URL('../src/client/workbench/WorkflowCanvas.tsx', import.meta.url), 'utf8')
  check('★★ 画布真去取了缺件清单', canvasSrc.includes("'/api/ecom-workbench/nodes/deps'"), '')
  check('★★ 画布把缺的节点标成 missing（这是 `missing` 态第一次真被置上）',
    canvasSrc.includes("state: 'missing' as NodeState"), '')
  check('★★ 不覆盖运行中的状态（running / queued 是运行事实）',
    canvasSrc.includes("st === 'idle' || st === 'missing'"), '')
  check('★★ 取不到清单时不瞎标（宁可不说，不许说错）',
    canvasSrc.includes('宁可不显示，也不许瞎标'), '')
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ R6：用户可见文案
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑦ 文案（R6） ===')
{
  check('★★ 四类的中文名都在，且与界面那份同一套字',
    DEP_KINDS.every(k => (DEP_KIND_LABEL[k] ?? '') !== '')
    && DEP_KIND_LABEL.npm === 'NPM 包' && DEP_KIND_LABEL.bin === '外部程序'
    && DEP_KIND_LABEL.env === '环境变量' && DEP_KIND_LABEL.files === '随附文件',
    DEP_KINDS.map(k => DEP_KIND_LABEL[k]).join(' / '))

  const j = judgeDeps({ npm: ['a'], bin: ['b'], env: ['C'], files: ['d'] }, fakeProbe({}))
  check('★★ 那句原因里没有第二人称（R6.1）', !/[你您]/.test(j.reason), j.reason)
  check('★ 那句原因里没有问句/感叹（R6.3）', !/[？?！!]/.test(j.reason), j.reason)
  /* 四类的修法各不相同 —— 说明那句话不是一句通用话套上来的。 */
  const hints = ['npm install', 'PATH', '环境变量', '路径']
  check('★★ 四类的修法各说各的（不是一句通用话）',
    hints.every(h => j.reason.includes(h)), j.reason)
}

console.log('')
console.log(failed === 0 ? '结论：依赖判定接对了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
