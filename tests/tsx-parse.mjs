/** TSX 语法自检：抓「JSX 注释少了收尾花括号」这一类**构建才报、类型检查看不见**的错。
 *
 * ## 为什么需要它（这个错踩了三次，每次都要花几分钟找）
 *
 * JSX 块注释少了结尾的花括号（`{/` + `* … *` + `/` 后面没有 `}`）—— 后面整段 JSX 被当成注释内容吞掉，
 * 构建报的是 `Expected ',' or '}' but found '.'` 且**指向一行看起来完全正常的代码**。
 * 而 `npm run check:types`（tsconfig.check.json）**不覆盖 src/client/**，
 * 所以类型检查是全绿的 —— 只有 rolldown/tsdown 构建时才炸。
 *
 * 做法：用 TypeScript 自带的 `createSourceFile` 解析每个 `.tsx`/`.ts`，
 * **只看 parseDiagnostics**（纯语法，不做类型检查）—— 快、零依赖、不误报。
 *
 * ⚠️ 为什么不靠构建：构建要几十秒、且一次只报第一个错；这个脚本把所有文件的
 * 语法错一次列全，并且能在任何改动后随手跑。
 */
import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\//, '')
const SRC = join(ROOT, 'src')
/** TypeScript 自带的那份（与 check:types 用的是同一个包）。 */
const TS_PATH = join(ROOT, '../../refs/deepseek-harness@62962ee4/node_modules/typescript/lib/typescript.js')

const ts = (await import('file:///' + TS_PATH.replace(/\\/g, '/'))).default ?? await import('file:///' + TS_PATH.replace(/\\/g, '/'))

/** 收集 src 下所有 .ts / .tsx（跳过 .d.ts）。
 * @param dir - 目录。
 * @returns 文件路径。
 */
function walk(dir) {
  const out = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (/\.tsx?$/.test(e)) out.push(p)
  }
  return out
}

/* ── 判据自证（不验证的话，「全部通过」可能只是因为根本没扫到文件）──
 * 造一个**故意坏掉**的临时文件，确认它是红的，再删掉。
 * ⚠️ 这一步必须在这里做而不是靠人记：本项目踩过多次「断言其实没连上」。 */
{
  const probe = join(SRC, '__syntax-probe.tsx')
  /* 故意少一个收尾花括号 —— 就是那个真错。 */
  writeFileSync(probe, 'export const A = () => <div>{/* 说明 */ <span>x</span></div>' + '\n', 'utf8')
  const sf = ts.createSourceFile(probe, readFileSync(probe, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  unlinkSync(probe)
  const caught = sf.parseDiagnostics.length > 0
  console.log((caught ? '  ✓ ' : '  ✗ ') + '★ 判据自证：故意坏掉的 TSX 能被解析器抓到')
  if (!caught) { console.log('结论：判据失效（坏的都抓不到，好的通过说明不了什么）✗'); process.exit(1) }
}
console.log('')
const files = walk(SRC)
let bad = 0
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  const kind = f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, kind)
  if (sf.parseDiagnostics.length === 0) continue
  bad += 1
  console.log('  ✗ ' + relative(ROOT, f))
  const lines = text.split(/\r?\n/)
  for (const d of sf.parseDiagnostics.slice(0, 3)) {
    const { line, character } = sf.getLineAndCharacterOfPosition(d.start)
    console.log('     ' + String(line + 1) + ':' + String(character + 1) + '  '
      + ts.flattenDiagnosticMessageText(d.messageText, ' '))
    console.log('     → ' + lines[line].trim().slice(0, 100))
  }
}

/* ── 第二类：JSX 里的裸块注释（会被当成文本渲染出来）──────────────
 *
 * 2026-10-18 用户截图抓到：卡片上原样显示了一行「⚠️ 这一排要贴紧（用户 m03635…」。
 * 原因：注释没包在花括号里 —— 在 JSX children 位置，它就是一段**文本**，不是注释。
 *（我自己写这个检查脚本时又踩了两次同一件事，可见它多容易犯。）
 *
 * 判据：用 AST 找所有 JsxText 节点，文本里出现注释起始符或结束符就是这种错。
 * 不能正则扫源码：正常写法的花括号注释里也含这些符号，字符串字面量里也可能有。
 */
let bareComment = 0
for (const f of files) {
  if (!f.endsWith('.tsx')) continue
  const text = readFileSync(f, 'utf8')
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const srcLines = text.split(/\r?\n/)
  /* 两个符号**拼出来**：在源码里直接写它们会把这一段注释提前结束。 */
  const OPEN_MARK = '/' + '*'
  const CLOSE_MARK = '*' + '/'
  /**
   * 递归找 JSX 文本节点。
   * @param node - AST 节点。
   */
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) {
      const val = node.text ?? ''
      if (val.includes(OPEN_MARK) || val.includes(CLOSE_MARK)) {
        bareComment += 1
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
        console.log('  ✗ ' + relative(ROOT, f) + ':' + String(line + 1) + '  JSX 文本里混进了注释符号')
        console.log('     → ' + srcLines[line].trim().slice(0, 90))
        console.log('     → 注释必须包在花括号里，裸写就变成会显示的文本')
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
console.log((bareComment === 0 ? '  ✓ ' : '  ✗ ') + '★ JSX 里的注释都包在花括号里（不会被当文本显示）')
if (bareComment > 0) bad += 1
console.log('')
console.log((bareComment === 0 ? '  ✓ ' : '  ✗ ') + '★ JSX 里的注释都包在花括号里（不会被当文本显示）')
if (bareComment > 0) bad += 1
console.log('')
console.log('')
console.log('扫了 ' + String(files.length) + ' 个源文件')
console.log(bad === 0 ? '结论：源码语法全部通过 ✓' : '结论：有 ' + String(bad) + ' 个文件语法有错 ✗')
process.exit(bad === 0 ? 0 : 1)
