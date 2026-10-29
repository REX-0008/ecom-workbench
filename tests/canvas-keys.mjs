/**
 * 票 61：临时切换键两边都认空格与 Ctrl，多选键统一 Meta 与 Control
 *
 * ## 用户原话（`docs/调研-两画布界面细节对照.md` 定案戊组第 25 条）
 *
 * > 空格和 ctrl 都可以临时切换左键功能。
 *
 * ## 这个测试守什么
 *
 * 两层：
 *   ① **纯函数层**：`shortcutOf` / `isPanReleaseKey` / `isPanPressKey` 认得哪些键
 *      —— 这一层能真跑，不需要挂画布；
 *   ② **源码层**：两条画布的 React Flow 配置（`selectionKeyCode` /
 *      `multiSelectionKeyCode`）与快捷键表 —— 这两处是 JSX 属性，jsdom 里
 *      拿不到 React Flow 的内部状态，只能读源码。
 *
 * ⚠️ **票 35 那两道闸必须仍在**：`e.repeat` 直接 return、
 * 已经是 pan 时不再覆盖 restore。这一票加 Ctrl 时同样是「按下 + 松开」成对，
 * 只加按下不加松开 = 票 35 那个「切不回去」的同一形状。
 */
import { readFileSync } from 'node:fs'
import { isPanReleaseKey, shortcutOf } from '../src/client/workbench/content-canvas-store.ts'

let failed = 0

/**
 * 记一条断言。
 * @param name - 断言名。
 * @param ok - 成立吗。
 * @param detail - 失败时打出来的补充信息。
 */
function check(name, ok, detail) {
  if (ok) {
    console.log('  ✓ ' + name + (detail === undefined ? '' : '  —— ' + detail))
  } else {
    console.log('  ✗ ' + name + (detail === undefined ? '' : '  —— ' + detail))
    failed += 1
  }
}

/**
 * 读源码并去掉注释（注释里提到键名不算「用了」）。
 * @param f - `src/client/workbench/` 下的文件名。
 * @returns 去注释后的文本。
 */
function srcOf(f) {
  const t = readFileSync('src/client/workbench/' + f, 'utf8')
  return t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 纯函数层：哪些键算「临时切换」
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ① 纯函数：哪些键算临时切换 ===')

/* 注意 `shortcutOf` 的 `mod` 是 `ctrlKey || metaKey`，所以「按 Ctrl」那一刻
 * `ctrlKey` 已经是 true（浏览器在 keydown 里就置位了）。 */

/* ⚠️ **`shortcutOf` 不认 Ctrl —— 这是设计如此，不是缺陷**。
 *
 * 票 61 的可改路径不含 `content-canvas-store.ts`（`shortcutOf` 在那儿），
 * 所以 Ctrl 那条判定写在 `ContentCanvas.tsx` 的 keydown 里，**在调
 * `shortcutOf` 之前**就地判掉。断言这条的作用是把这个事实钉住：
 * 将来谁想在 `shortcutOf` 里加 Ctrl，会发现这里已经写着「不在那儿」。 */
check('★ 判据 1（内容画布）：`shortcutOf` 本身**不**认 Ctrl（Ctrl 在 keydown 里就地判）',
  shortcutOf({ key: 'Control', ctrlKey: true }) === null,
  '返回值 ' + String(shortcutOf({ key: 'Control', ctrlKey: true })))

/* ⚠️ `shortcutOf` 位于 `content-canvas-store.ts`，票 61 的可改路径**不含**它。
 * 所以 Ctrl 那条判定写在 `ContentCanvas.tsx` 的 keydown 里（就地一行）。
 * 下面这条验的是「源码里真有那条判定」，不是验纯函数。 */
{
  const cc = srcOf('ContentCanvas.tsx')
  check('★★ 判据 1（内容画布）：keydown 里认 Ctrl 与 Meta',
    /e\.key === 'Control' \|\| e\.key === 'Meta'/.test(cc))
  check('★★ 判据 1（内容画布）：按下 Ctrl 时 `e.repeat` 直接 return（票 35 第一道闸）',
    /if \(ctrlHold\) \{\s*\n\s*e\.preventDefault\(\)\s*\n\s*if \(e\.repeat === true\) return/.test(cc),
    (/if \(ctrlHold\)[\s\S]{0,200}/.exec(cc) ?? [''])[0].slice(0, 120))
  /* ★ 票 01 补正（2026-10-30）：**判据按实质重写，守的事一个字没变**。
   *
   * ## 改之前的字面写法
   *
   * ```js
   * /if \(mode !== 'pan'\) panRestoreRef\.current = mode/
   * ```
   *
   * 票 01 之前「第二道闸」的目标**恒为 `'pan'`**，所以字面写 `mode !== 'pan'`
   * 恰好等价于「目标与当前相同时不覆盖」。
   *
   * ## 为什么它过期了
   *
   * 默认值改成 `'pan'` 之后，目标不能还是常量 —— 否则这一行永远不成立
   * （本来就 pan，`mode !== 'pan'` 为假），`panRestoreRef` 从不赋值，
   * 松手恢复不到任何东西。所以目标是**变量** `other`。
   *
   * ## 实质是什么（这才是要守的）
   *
   * 「**目标与当前相同时，不许把要恢复的值覆盖掉**」。
   * 闸拆了会的后果：按住键 → 自动重复 → 把 `panRestoreRef` 覆盖成目标
   * → 松手回不来（票 35 那个真机 bug 原样复活）。
   *
   * ⚠️ **两件都要验**：目标是个变量（不然默认 pan 下目标恒等于当前，闸形同虚设），
   * 以及赋值受那个比较保护（不然闸没了）。
   *
   * 自证：把 `if (mode !== other)` 改成无条件赋值 → 这两条之一必红。 */
  check('★★ 判据 1（内容画布）：目标是「另一种模式」（不是写死 pan，否则默认 pan 下永不赋值）',
    /const other: CanvasMode = mode === 'pan' \? 'select' : 'pan'/.test(cc),
    (/const other: CanvasMode[^\n]*/.exec(cc) ?? [''])[0])
  check('★★ 判据 1（内容画布）：目标与当前相同时不覆盖 restore（票 35 第二道闸的实质）',
    /if \(mode !== other\) panRestoreRef\.current = mode/.test(cc))
  check('★★ 判据 1（内容画布）：松开 Ctrl 也会恢复（与按下成对）',
    /ctrlRelease/.test(cc) && /ev\.key === 'Control' \|\| ev\.key === 'Meta'/.test(cc))
}

check('★★ 判据 2（内容画布）：按下空格 = panHold',
  shortcutOf({ key: ' ' }) === 'panHold')
check('★★ 判据 2（内容画布）：松开空格 = 认得出',
  isPanReleaseKey({ key: ' ' }) === true)
check('★★ 判据 2（内容画布）：在输入框里按空格**不**算（`typingTarget` 那道闸）',
  shortcutOf({ key: ' ', target: { tagName: 'INPUT' } }) === null,
  String(shortcutOf({ key: ' ', target: { tagName: 'INPUT' } })))
check('★★ 判据 2（内容画布）：在输入框里松空格也**不**算',
  isPanReleaseKey({ key: ' ', target: { tagName: 'TEXTAREA' } }) === false)

/* 执行画布：交给 React Flow 的 `selectionKeyCode`，源码层验。 */
{
  const wf = srcOf('WorkflowCanvas.tsx')
  check('★★ 判据 1+2（执行画布）：`selectionKeyCode` 同时收 Control 与 Space',
    /selectionKeyCode=\{\['Control', 'Space'\]\}/.test(wf),
    (/selectionKeyCode=[^\n]*/.exec(wf) ?? [''])[0])
  check('★★ 判据 2（执行画布）：空格写的是 `\'Space\'` 不是 `\' \'`',
    !/selectionKeyCode=\{\[[^\]]*' '[^\]]*\]\}/.test(wf),
    'React Flow 按 event.code 匹配，空格是 Space')
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 票 35 那两道闸：不能因为加 Ctrl 被拆掉
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 票 35 的两道闸仍在 ===')
{
  const cc = srcOf('ContentCanvas.tsx')
  /* 空格那条：`e.repeat` 与「不覆盖 restore」各一条，且注释里那套解释也还在。 */
  const panHoldBlock = /if \(act === 'panHold'\) \{([\s\S]*?)\n      \}/.exec(cc)?.[1] ?? ''
  check('★★ 判据 3：空格那条仍有 `e.repeat` 闸',
    /if \(e\.repeat === true\) return/.test(panHoldBlock))
  /* ★ 票 01 补正：与上面判据 1 同一处改动、同一个理由（见那一段的长注释）。
   *
   * 空格那条与 Ctrl 那条**各有一份**这个判断，所以两处都要按实质验 ——
   * 只验一处的话，另一处被拆掉闸不会有人知道。 */
  check('★★ 判据 4：空格那条的目标也是「另一种模式」',
    /const other: CanvasMode = mode === 'pan' \? 'select' : 'pan'/.test(panHoldBlock),
    (/const other: CanvasMode[^\n]*/.exec(panHoldBlock) ?? [''])[0])
  check('★★ 判据 4：空格那条仍有「目标与当前相同时不覆盖」闸',
    /if \(mode !== other\) panRestoreRef\.current = mode/.test(panHoldBlock))
  check('★★ 判据 5：窗口失焦当松开的兜底还在（`onBlur`）',
    /const onBlur = \(\): void =>/.test(cc) && /window\.addEventListener\('blur'/.test(cc)
    || /addEventListener\('blur', onBlur\)/.test(cc))
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 多选键统一
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 多选键：两边同一个 ===')
{
  const cc = srcOf('ContentCanvas.tsx')
  const wf = srcOf('WorkflowCanvas.tsx')
  const WANT = /\{\['Meta', 'Control'\]\}/
  check('★★ 判据 6：执行画布的 `multiSelectionKeyCode` 是 [Meta, Control]',
    /multiSelectionKeyCode=\{WANT\}/.test(wf) || /multiSelectionKeyCode=\{\['Meta', 'Control'\]\}/.test(wf),
    (/multiSelectionKeyCode=[^\n]*/.exec(wf) ?? [''])[0])
  check('★★ 判据 6：内容画布也显式声明成同一个（原来是 React Flow 默认的 Meta）',
    /multiSelectionKeyCode=\{\['Meta', 'Control'\]\}/.test(cc),
    (/multiSelectionKeyCode=[^\n]*/.exec(cc) ?? [''])[0])
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 快捷键表
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 快捷键表与实际行为一致 ===')
{
  const zc = srcOf('CanvasZoomControls.tsx')
  const row = /\{ keys: '([^']*空格[^']*)', what: '临时抓手' \}/.exec(zc)
  check('★★ 判据 7：「临时抓手」那条写着',
    row !== null, row === null ? '没找到' : row[1])
  check('★★ 判据 7：它同时含「Ctrl」与「空格」两个词',
    row !== null && row[1].includes('Ctrl') && row[1].includes('空格'),
    row === null ? '' : row[1])
}

console.log('')
console.log(failed === 0 ? '结论：两画的临时切换键与多选键都统一了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
