/**
 * 票 63：执行画布删掉新建 / 打开 / 另存为三颗按钮
 *
 * ## 用户原话（`docs/调研-两画布界面细节对照.md` 定案己组 26、27）
 *
 * > 执行画布去掉新建、打开、另存为按钮，同内容画布一个逻辑，
 * > 新建打开操作在工作流管理中执行。画布中就专注当前执行的内容即可。
 *
 * ## 这个测试守什么
 *
 * 四件事：
 *   ① 三颗按钮**真的没了**（按 `action` 与 `title` 各查一遍，零命中）；
 *   ② **保存还在**（用户没说删，那是每天要用的）；
 *   ③ 被删的三个函数**连同调用点一起删干净**，没留孤儿 import；
 *   ④ 能力没丢 —— 工作流管理里那三个入口确实在。
 *
 * ⚠️ 只读源码，不挂画布：这几件事都是「源码里有没有」的结构性事实，
 * 挂 React 反而验不出来（按钮在不在，DOM 也是从同一份源码长出来的）。
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
 * 读源码并剥注释。
 *
 * ⚠️ **必须剥**：票 63 在删按钮那处写了一大段说明，
 * 里面提到 `saveAs` / `newWorkflow` / 「另存为」这些词 ——
 * 不剥注释的话，「这三个词不许出现」的断言会被自己的说明文字弄红。
 *
 * 这正是 `dom-render` 白名单那一类坑的同一个形状（注释被当成代码）。
 *
 * @param f - `src/client/workbench/` 下的文件名。
 * @returns 去注释后的文本。
 */
function srcOf(f) {
  const t = readFileSync('src/client/workbench/' + f, 'utf8')
  return t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const wf = srcOf('WorkflowCanvas.tsx')
const wfRaw = readFileSync('src/client/workbench/WorkflowCanvas.tsx', 'utf8')
const list = readFileSync('src/client/workbench/WorkflowList.tsx', 'utf8')
const zoom = srcOf('CanvasZoomControls.tsx')

/* ══════════════════════════════════════════════════════════════════════
 * ① 三颗按钮没了（判据 1）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ① 三颗按钮真的没了（判据 1）===')
{
  check('★★ 判据 1：没有 `action="new"`',
    !/action="new"/.test(wf))
  check('★★ 判据 1：没有 `action="save-as"`',
    !/action="save-as"/.test(wf))
  check('★★ 判据 1：没有 `action="open"`',
    !/action="open"/.test(wf))
  /* 按 title 再查一遍（票面要求「按 title 与 data-* 各查一遍」）。 */
  check('★★ 判据 1：按 title 也查不到「清空画布，开始一份新的工作流」',
    !/清空画布，开始一份新的工作流/.test(wfRaw))
  check('★★ 判据 1：按 title 也查不到「写成一份新文件（原来那份不动）」',
    !/写成一份新文件（原来那份不动）/.test(wfRaw))
  check('★★ 判据 1：按 title 也查不到「打开一份本机已存的工作流」',
    !/打开一份本机已存的工作流/.test(wfRaw))
  /* 旧钩子。 */
  check('★★ 判据 1：旧的 `data-ewb-open` 钩子也没了',
    !/data-ewb-open/.test(wfRaw))
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 保存仍在（判据 2）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 保存仍在（判据 2）===')
{
  check('★★ 判据 2：`action="save"` 那颗还在',
    /action="save"/.test(wf))
  check('★★ 判据 2：它的 `data-ewb-save` 钩子还在（既有断言按它找）',
    /'data-ewb-save': ''/.test(wf))
  check('★★ 判据 2：它绑的还是 `save`（不是被换成空函数）',
    /onClick=\{save\}/.test(wf))
  check('★★ 判据 2：`save` 函数还在',
    /const save = useCallback|function save\(/.test(wf) || /\bsave\b/.test(wf))
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 三个函数与孤儿 import（判据 4）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 被删动作的残留（判据 4）===')
{
  /* 票 63 删之前 grep 过：三个函数**只有它们自己那颗按钮**在调用，
   * 所以连函数一起删。这里断言「零调用点」。 */
  check('★★ 判据 4：`newWorkflow` 零调用点（函数已删）',
    !/newWorkflow/.test(wf),
    (/newWorkflow/.test(wfRaw) ? '原文里还有（可能是注释）' : '干净'))
  check('★★ 判据 4：`saveAs` 零调用点（函数已删）',
    !/saveAs/.test(wf))
  check('★★ 判据 4：`openSaved` 零调用点（函数已删）',
    !/openSaved/.test(wf))

  /* 孤儿 import：只服务这三颗的图标与接口。 */
  check('★★ 判据 4：`FilePlusIcon` 不再 import（只服务「新建」那颗）',
    !/FilePlusIcon/.test(wf))
  check('★★ 判据 4：`FileOutputIcon` 不再 import（只服务「另存为」那颗）',
    !/FileOutputIcon/.test(wf))
  check('★★ 判据 4：`FolderOpenIcon` 不再 import（只服务「打开」那颗）',
    !/FolderOpenIcon/.test(wf))
  check('★★ 判据 4：`loadWorkflowFile` 不再 import（只被 `openSaved` 用）',
    !/loadWorkflowFile/.test(wf))
  check('★★ 判据 4：`SaveIcon` **仍然** import（保存那颗还用）',
    /SaveIcon/.test(wf))
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 能力没丢（判据 3）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 能力没丢：工作流管理里那三个入口（判据 3）===')
{
  check('★★ 判据 3：工作流管理里有「+ 新建」',
    /\+ 新建/.test(list))
  check('★★ 判据 3：有「打开到画布」',
    /打开到画布/.test(list))
  check('★★ 判据 3：有「打开目录」',
    /打开目录/.test(list))
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 快捷键表（判据 5）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 快捷键表里没有指向被删动作的说明（判据 5）===')
{
  /* 票 63 开工前 grep 过：`shortcutHelp()` 里**本来就没有**「新建 / 打开 / 另存为」
   * 那三条（那张表只有编辑类与视图类）。所以这一条是**反面断言**：
   * 它守的是「将来谁把这三条的说明加回去」。
   *
   * ⚠️ 要按「说明文字」判，不能按「新建」这两个字判 ——
   * 「+ 新建」那个入口不在这个文件里，但别的说明里可能出现「新建」一词。 */
  const DELETED_ACTIONS = ['新建工作流', '打开工作流', '另存为']
  const hits = DELETED_ACTIONS.filter(a => zoom.includes(a))
  check('★★ 判据 5：「临时抓手」那条仍写着空格与 Ctrl（票 61 的成果没被碰）',
    /空格 \/ Ctrl（按住）/.test(zoom))
  check('★★ 判据 5：快捷键表里没有指向被删动作的说明',
    hits.length === 0, hits.join('、'))
  check('★★ 判据 5：表里还留着「复制 / 粘贴」这类编辑键（表本身没被删空）',
    /Ctrl \+ C \/ V/.test(zoom))
}

console.log('')
console.log(failed === 0 ? '结论：三颗按钮删干净、保存还在、能力没丢 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
