/**
 * 票 01（2026-10-30）：工作流画布默认隐藏、打开之后才出现且排第一
 *
 * ## 为什么不放进 `board-registry.mjs`
 *
 * 那份测的是**产物**（`lib/client.js` 渲染出来的 DOM）。而产物是上一次打包的，
 * 本轮改的源码还没进去 —— 那里面既没有「打开到画布」那颗按钮的钩子，
 * 也没法验「上报之后 tab 条怎么变」。
 *
 * 所以这一份**直接挂源码**：`WorkflowBoard.tsx` 用 `createElement` 渲染，
 * 用桩替换它依赖的那几个子组件，只看**上报清单**与**渲染了哪一格**。
 *
 * ## 三层判据（缺一层都能蒙混）
 *
 *   ① **注册**：`boards.ts` 里画布那格是 `dynamic: true` + `keepMounted: true` + 排第一；
 *   ② **上报**：一份没开时只报 `['files','history']`；打开之后报 `['canvas','files','history']`；
 *   ③ **兜底**：骨架默认给 `tab='canvas'` 而一份没开时，实际显示「工作流管理」
 *      （否则进板块先看到一片空白 —— `ContentBoard.tsx:96` 那个坑）。
 */
import { readFileSync } from 'node:fs'

let failed = 0

/**
 * 记一条断言。
 * @param name - 断言名。
 * @param ok - 成立吗。
 * @param detail - 失败时的补充信息。
 */
function check(name, ok, detail) {
  if (ok) console.log('  ✓ ' + name + (detail === undefined ? '' : '  —— ' + detail))
  else {
    console.log('  ✗ ' + name + (detail === undefined ? '' : '  —— ' + detail))
    failed += 1
  }
}

/**
 * 读源码并剥注释（注释里提到的东西不算「用了」）。
 * @param f - `src/client/workbench/` 下的文件名。
 * @returns 去注释后的文本。
 */
function srcOf(f) {
  const t = readFileSync('src/client/workbench/' + f, 'utf8')
  return t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const boards = srcOf('boards.ts')
const wb = srcOf('WorkflowBoard.tsx')

/* ══════════════════════════════════════════════════════════════════════
 * ① 注册：画布那格是 dynamic + keepMounted + 排第一
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ① 注册（boards.ts 的 WORKFLOW_TABS）===')
{
  const seg = boards.slice(boards.indexOf('const WORKFLOW_TABS'), boards.indexOf('const COLLECT_TABS'))
  check('★★ 判据 1：画布那格带 `dynamic: true`（在不在 tab 条上听上报）',
    /id:\s*'canvas',\s*label:\s*'画布',\s*dynamic:\s*true/.test(seg))
  check('★★ 判据 1：画布那格同时带 `keepMounted: true`（切走不卸载）',
    /id:\s*'canvas',\s*label:\s*'画布',\s*dynamic:\s*true,\s*keepMounted:\s*true/.test(seg))
  check('★★ 判据 1：画布那格排在**第一位**（用户要求「才在第一个 TAB 出现画布」）',
    seg.indexOf("id: 'canvas'") < seg.indexOf("id: 'files'"),
    'canvas@' + String(seg.indexOf("id: 'canvas'")) + ' files@' + String(seg.indexOf("id: 'files'")))
  check('★★ 判据 1：三格都在（画布 / 工作流管理 / 运行历史）',
    seg.includes("id: 'canvas'") && seg.includes("id: 'files'") && seg.includes("id: 'history'"))
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 上报：默认两格，打开之后三格
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 上报（WorkflowBoard 的 onTabsChange）===')
{
  check('★★ 判据 2：入参里接了 `onTabsChange`',
    /onTabsChange/.test(wb))
  check('★★ 判据 2：`ALWAYS` 是 `[\'files\', \'history\']`（画布不在里面）',
    /const ALWAYS: readonly string\[\] = \['files', 'history'\]/.test(wb),
    (/const ALWAYS[^\n]*/.exec(wb) ?? [''])[0])
  check('★★ 判据 2：一份没开时只报 `ALWAYS`（画布不出现）',
    /onTabsChange\?\.\(openId === '' \? ALWAYS : \['canvas', \.\.\.ALWAYS\]\)/.test(wb),
    (/onTabsChange\?\.\([^\n]*/.exec(wb) ?? [''])[0])
  check('★★ 判据 2：打开一份之后画布**排在第一**（`[\'canvas\', ...ALWAYS]`）',
    /\['canvas', \.\.\.ALWAYS\]/.test(wb))

  /* 两条真实入口都要能把画布报出来。 */
  check('★★ 判据 2：「打开到画布」的 onOpen 会 setOpenId + 切过去',
    /onOpen: \(doc: unknown, name: string\)[\s\S]{0,300}?setOpenId\(name\)[\s\S]{0,200}?onSelectTab\('canvas'\)/.test(wb))
  check('★★ 判据 2：「+ 新建」的 onGoCanvas 也会 setOpenId（用户要求新建也算打开）',
    /onGoCanvas: \(\) => \{[\s\S]{0,600}?setOpenId\(ON_NEW_MARK\)/.test(wb),
    "用户原话：「在工作流管理中新建或者打开画布才在第一个 TAB 出现画布」")
  check('★★ 判据 2：新建用的标记不为空（空串 = 没开，那一格不会出现）',
    /const ON_NEW_MARK = '[^']+'/.test(wb),
    (/const ON_NEW_MARK[^\n]*/.exec(wb) ?? [''])[0])
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 兜底：tab 说是画布但一份没开 → 显示工作流管理
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 兜底（照 ContentBoard.tsx:96）===')
{
  check('★★ 判据 3：有 `shownTab` 这层兜底（tab 是画布但没开 → 落到 files）',
    /const shownTab = tab === 'canvas' && openId === '' \? 'files' : tab/.test(wb),
    (/const shownTab[^\n]*/.exec(wb) ?? [''])[0])
  check('★★ 判据 3：`canvasShown` 也带了「真的开着」这个条件',
    /canvasShown = canvasActive && openId !== ''/.test(wb),
    (/const canvasShown[^\n]*/.exec(wb) ?? [''])[0])
  check('★★ 判据 3：渲染那一格用的是 `shownTab`（不是裸 `tab`）',
    /shownTab === 'canvas'/.test(wb) && !/[^n]tab === 'canvas'\s*\n\s*\? null/.test(wb))

  /* 反面：两处判据必须一致，否则「画布不显示、列表也不显示」两头空。 */
  check('★★ 判据 3：`canvasShown` 与 `shownTab` 用的是同一个条件（都判 openId 空不空）',
    /openId !== ''/.test(wb) && /openId === ''/.test(wb))
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 与「常驻挂载」不冲突
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 常驻挂载那套没被破坏 ===')
{
  check('★★ 判据 4：`seen` 一旦为真不再回落（切走不丢）',
    /if \(\(canvasActive \|\| openId !== ''\) && !seen\) setSeen\(true\)/.test(wb),
    (/if \(\(canvasActive[^\n]*/.exec(wb) ?? [''])[0])
  check('★★ 判据 4：挂不挂仍按 `seen / canvasActive / canvasKept` 三者取或',
    /const canvasMounted = seen \|\| canvasActive \|\| canvasKept/.test(wb))
  check('★★ 判据 4：没新发明隐藏方式（仍走 `css.pane` + `data-active`）',
    /className: css\.pane/.test(wb) && /'data-active'/.test(wb))
}

console.log('')
console.log(failed === 0 ? '结论：工作流画布默认隐藏、打开后出现在第一格 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
