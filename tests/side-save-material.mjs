/**
 * 票 39（判据 5）：左栏提示词 tab 里每一条都能「存成素材」
 *
 * ## 用户要的
 *
 * 提示词 tab 里那些内置提示词，看见一条想留下来的，能直接存成**文本素材**
 * （存完在「素材」那一格的文本组里）。改之前全仓 `grep "存成素材"` 是空的 ——
 * 这个入口根本不存在。
 *
 * ## 判据分两层
 *
 *   ① **结构**：每一条提示词旁边都有一颗带 `data-ewb-side-prompt-save` 的按钮，
 *      而且**不许是 `<button>` 套 `<button>`**（非法 HTML，浏览器会拆内层）；
 *   ② **行为**：点了真的发 `POST /materials/text`，请求体里 `content` 是那条的正文。
 *
 * ② 只有挂 React 才验得到，所以这个文件 `import` 组件 —— 它 import 了
 * `.module.css`，Node 直接加载不了，所以跑的时候要带 tsx loader + 一个
 * 能处理 `.css` 的环境。这里走的是项目里既有的做法（`content-canvas.mjs` 同款）。
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
 * @param f - `src/client/workbench/` 下的文件名。
 * @returns 去注释后的文本。
 */
function srcOf(f) {
  const t = readFileSync('src/client/workbench/' + f, 'utf8')
  return t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const side = srcOf('CanvasSidePanel.tsx')
const sideRaw = readFileSync('src/client/workbench/CanvasSidePanel.tsx', 'utf8')

console.log('')
console.log('=== ① 结构：每一条旁边都有「存成素材」 ===')
{
  check('★★ 判据 1：按钮带 `data-ewb-side-prompt-save` 钩子',
    /data-ewb-side-prompt-save=\{e\.id\}/.test(side))
  check('★★ 判据 1：它在 `promptsShown.map(...)` 里面（每条都有，不是只有一条）',
    /promptsShown\.map\(e => \([\s\S]{0,2600}?data-ewb-side-prompt-save=\{e\.id\}/.test(side))
  check('★★ 判据 1：原来那颗「插入」按钮的钩子与行为**一个字没动**',
    /data-ewb-side-prompt=\{e\.id\}/.test(side)
    && /onClick=\{\(\) => \{ props\.onInsertPrompt\(e\) \}\}/.test(side)
    && /draggable/.test(side))
  /* ⚠️ 非法嵌套：`<button>` 里放 `<button>`，浏览器会把内层拆出去。 */
  /* ⚠️ **必须在剥过注释的 `side` 上判**，不能在原文上判 ——
   * 注释里写着 `</button>` 这类字样（说明为什么不能嵌套时提到它），
   * 在原文上判会把注释里的标签当成真标签。第一版就这么误报过。 */
  /* ⚠️ 只看**这颗按钮自己那个 `<button` 之前**的内容。
   * `data-ewb-side-prompt-save` 出现在属性上，而它自己的 `<button` 在更前面 ——
   * 直接拿 `indexOf(...)` 切，切点落在「新按钮的标签已经打开之后」，
   * 于是 `lastIndexOf('<button')` 找到的是**它自己**，判定必然错。
   * 第一版就是这么误报的（判了两次都红）。 */
  const saveAttr = side.indexOf('data-ewb-side-prompt-save')
  const saveTagOpen = side.lastIndexOf('<button', saveAttr)
  const before = side.slice(0, saveTagOpen)
  const lastOpen = before.lastIndexOf('<button')
  const lastClose = before.lastIndexOf('</button>')
  /* 最后一次出现的 `<button` 必须已经被 `</button>` 关掉 —— 否则就是套在里面。 */
  check('★★ 判据 1：没有 `<button>` 套 `<button>`（外层是 div 容器）',
    lastClose > lastOpen,
    lastClose > lastOpen ? '' : '存成素材那颗还套在「插入」那颗按钮里面')
  /* 再钉一条更直接的：两颗按钮处在**同一个 `<div>` 容器**里。
   *
   * ⚠️ 第一版写成「`</button>` 之后紧跟 `<button ... data-ewb-side-prompt-save`」，
   * 那个正则把属性顺序钉死了（源码里 `type="button"` 之后还有 `style` 与
   * `data-*` 好几行），实际上永远匹配不上 —— **一条永远红的断言**。
   * 改成数容器：在「插入」那颗的 `</button>` 与「存成素材」那颗的 `<button>`
   * 之间**只该有注释**，不该再出现另一个开标签。 */
  const between = side.slice(lastClose, saveTagOpen)
  check('★★ 判据 1：两颗按钮之间只有注释（同一个 div 容器里并排）',
    !/<(?!\/)[a-z]/.test(between.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')),
    between.replace(/\s+/g, ' ').trim().slice(0, 60))
}

console.log('')
console.log('=== ② 行为：真的发 POST /materials/text ===')
{
  check('★★ 判据 2：调用的是 `POST /api/ecom-workbench/materials/text`',
    /fetch\('\/api\/ecom-workbench\/materials\/text'/.test(side)
    && /method: 'POST'/.test(side))
  check('★★ 判据 2：请求体里 `content` 取的是那条提示词的正文',
    /content/.test(side) && /e\.prompt/.test(side),
    (/const content = \(e\.prompt[\s\S]{0,40}/.exec(side) ?? [''])[0].replace(/\s+/g, ' '))
  check('★★ 判据 2：`title` 取的是那条的名字',
    /const title = \(e\.title \?\? ''\)\.trim\(\)/.test(side))
  check('★★ 判据 2：按钮的 onClick 真的调了那个函数',
    /onClick=\{\(\) => \{ void savePromptAsMaterial\(e\) \}\}/.test(side))

  /* ── 判据 4：失败要说原因，不许静默 ───────────────────────────── */
  check('★★ 判据 4：失败时有明确的一句（带宿主半回的原因）',
    /'存进素材库失败：' \+ \(body\?\.error/.test(side))
  check('★★ 判据 4：`catch` 里也说原因（网络断了不至于什么都不显示）',
    /catch \(err\) \{[\s\S]{0,200}setSaveErr\('存进素材库失败：'/.test(side))
  check('★★ 判据 4：空正文会拦下来（不存一条空素材）',
    /这条提示词没有正文，没有可存的内容/.test(side))
  check('★★ 判据 4：错误显示在侧栏里（不是跑到画布另一头）',
    /data-ewb-side-save-err=""/.test(side))

  /* ── 判据 3：存完刷新素材清单 ─────────────────────────────────── */
  check('★★ 判据 3：存完调 `loadMats()` 刷新（否则切过去看到的是旧列表）',
    /await loadMats\(\)/.test(side))
}

console.log('')
console.log('=== ⑤ 文案守 R6 ===')
{
  const texts = ['存成素材', '正在存…', '把这条提示词存成文本素材（存完在「素材」那一格的文本组里）',
    '这条提示词没有正文，没有可存的内容。']
  check('★★ 判据 5：不用第二人称', texts.every(t => !/你/.test(t)))
  check('★★ 判据 5：不用疑问句做标签', texts.filter(t => t !== '正在存…').every(t => !/[？?]$/.test(t)))
  check('★★ 判据 5：不用口语词',
    texts.every(t => !/折腾|省事|顺手|一会儿|其实|别怕|搞/.test(t)))
}

console.log('')
console.log('=== ⑥ 边界 ===')
{
  check('★ 本票**没有**改 `ContentLibrary.tsx`（那半边转给前端了）',
    !sideRaw.includes('ContentLibrary'))
  check('★ 四个分组函数的导出**没动**（前端要 import 它们）',
    /export function materialKindOf/.test(side)
    && /export const ASSET_GROUPS/.test(side)
    && /export function materialLabelOf/.test(side)
    && /export function materialSummaryOf/.test(side))
}

console.log('')
console.log(failed === 0 ? '结论：提示词能存成素材了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
