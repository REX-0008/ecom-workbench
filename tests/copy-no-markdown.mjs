/** 用户可见文案里**不许再有 markdown 加粗标记 `**`**（防回归）。
 *
 * ## 为什么要有这条测试
 *
 * 2026-10-14 的实测事实：本插件**没有任何 markdown 渲染** ——
 * `NodeEditorPopover.tsx` 直接渲染 `{def.hint}`，`window.prompt` 更是纯文本。
 * 所以写在文案里的 `**` **不会变成加粗，而是原样显示两个星号**。
 * 曾经 148 处字符串 + 6 处 JSX 文本里带着它（用户看到的句子长这样：
 * 「**固定间隔反而容易被识别**，建议开启」）。
 *
 * 对照物：dsh 官方的 40 个界面插件 `locales.ts`（都在各自的 client 目录下）里，
 * 1730 条中文可见串含 `**` 的 **0 条** —— 官方就是不用加粗的。
 *
 * ## 判据为什么用「TypeScript 解析器 + AST 区间」
 *
 * 因为要**区分两类 `**`**：注释里的（约 4600 处，给我们自己看的，**必须保留**）
 * 和字符串 / JSX 文本里的（用户会看到，**必须为 0**）。
 *
 * ⚠️ 两种错误做法都试过、都踩过：
 *   ① **逐字符自己扫**——被正则字面量里的引号搞失步（`/['"]/` 里的 `'` 会让状态机错位）；
 *   ② **只查行首是不是注释符号**——`.tsx` 里写在花括号里的块注释
 *      （形如「花括号 斜杠星 … 星斜杠 花括号」）不以 `*` 或 `//` 开头，会被误判成「代码」。
 * 所以这里用 `ts.createSourceFile` 拿 AST，只看 `**` **落在哪一类节点的区间里** ——
 * 判据本身就是解析器给的，不靠我猜。
 *
 * ## 覆盖范围（三处，不只 `src/`）
 *
 * 1. **源码** `src/**`：用户可见位置必须为 0（注释里的不算、也不许动）
 * 2. **生成器** `scripts/**`：这里只查**单双引号的字符串字面量** ——
 *    生成器会把它们写成工作流存档的 `node.note`，而画布**直接渲染** note。
 *    （实测：清 `src/` 之后存档里还剩 132 处 `**`，全部来自这里。）
 *    反引号串**故意排除**：那些是生成的 shell 脚本正文与 `code.js` 代码正文，
 *    进的是节点参数里的「代码」，且内部嵌着大量注释 `**`，不属于画布说明文案。
 * 3. **产物** `lib/client.js` / `lib/index.js`：这两份**保留注释**（tsdown 不剥），
 *    所以产物里的 `**` 总数不可能为 0；判据只看「落在字符串/JSX 里的」那部分 = 0
 *
 * ## ⚠️ 一处**明写**的边界：提示词模板正文（2026-10-22）
 *
 * 提示词模板正文（`src/client/workbench/templates/`）是**唯一一处**允许用 `BOLD`
 * 常量拼出 `**` 的地方。理由：那个板块的只读预览会把它渲染成真粗体
 * （`PromptBoard.tsx` 的 `renderEmphasis`），用户看不到字面星号；
 * 而复制到剪贴板与编辑态 textarea 仍需要 `**` 的强调语义
 * （复制出去的是喂给模型的提示词，Markdown 粗体在那里是正常写法）。
 *
 * 判据的**本意**是「用户可见位置不许出现会**原样显示**的两颗星」。
 * 那一处既然真渲染成粗体了，源码里有没有字面量就不再是判据该问的问题 ——
 * 所以数据文件里写 `${BOLD}要点${BOLD}`，运行时仍是 `**要点**`。
 * 这不是暗中绕开：判据本身的代码一个字没动，边界就写在上面这段里。
 *
 * ⚠️ **那一处的防线不在这份测试里**，而在 `tests/dom-render.mjs` 的 ⑬ 段：
 * 它断言「正文只读区的可见文字里没有字面 `**`」+「只读区里有 `<strong>`」。
 * 如果哪天 `renderEmphasis` 被删了或被改成原样输出，**这份测试抓不到**
 * （它只扫源码，看不到渲染结果），**只有 ⑬ 段那两条能抓到**。
 * 所以动 `renderEmphasis` 之前先看 ⑬ 段，别以为这里绿了就万事大吉。
 *
 * ## ⚠️ 第二处边界：提示词库的**上游数据**（2026-10-25 契约 BJ）
 *
 * `src/client/workbench/prompt-sources/*.json` 里的条目是**上游原文快照**
 * （GitHub 上那几个提示词集合的截断副本，许可见 `docs/调研-提示词源与兜底副本.md`）。
 * 其中 8 条正文带 Markdown 粗体标记，合计 140 处 `**` —— 这 140 处**是字面量**，
 * 于是产物 `lib/client.js` 里也确实有 140 处在字符串里。
 *
 * ### 为什么这处的 `**` 是正当的，与上一处的区别在哪
 *
 * | | 模板正文（templates/） | 提示词数据（prompt-sources/） |
 * |---|---|---|
 * | 谁写的 | **我们自己**写的 62 个模板 | **上游作者**写的原文 |
 * | 能不能改成 `${BOLD}` 拼 | 能（我们控制源码） | **不能**（JSON 里必须是字面 `**`） |
 * | 改了会怎样 | — | **与上游对不上账**（那是快照，改一个字节就不是原文了） |
 *
 * 所以这一处**只能在数据里保留字面量**，而判据本意是「用户可见位置不许出现会
 * **原样显示**的两颗星」—— 这两件事不冲突：界面已经把它渲染成真粗体了
 * （`PromptLibrary.tsx` 的正文预览走 `renderEmphasis`，提示词库与提示词板块
 * 共用 `emphasis-render.tsx` 那**唯一一份**实现）。
 *
 * ### 豁免怎么做的（这是本段的重点：它是**窄口**的，不是整份产物放过）
 *
 * 判据从「产物里字符串中的 `**` = 0」改成
 * 「产物里字符串中的 `**`，**扣掉那 8 条正文原样包含的那些**之后 = 0」。
 *
 * 具体做法：把那 8 条正文的**整段原文**拿去在产物里做子串匹配，命中的区间标成
 * 「来自数据」；剩下任何一处 `**` 都还算命中。于是：
 *   · 数据里的 140 处 → 免（它们落在完整的那段正文里，位置对得上）；
 *   · **代码里新写的一句文案带 `**`** → 仍红（它不在任何一条正文里）；
 *   · 有人把一条**新数据**加进 JSON 带 `**` → 也红（它不在这 8 条里，
 *     除非同时更新这份豁免 —— 那说明「加数据要过一遍这条」是刻意的）。
 *
 * ⚠️ **不是** `if (name === 'lib/client.js') return` 那种写法：那等于这条断言
 * 对客户端产物整体失效，什么新漏洞都抓不到了。验收第 5 条的自证正是钉这一点。
 *
 * ### 这一处的防线在哪
 *
 * · **渲染**：`tests/dom-render.mjs` 新增的一对断言（正文区有 `<strong>`、
 *   可见文字里没有字面 `**`）—— 它扫渲染结果，这份静态测试看不到；
 * · **复制**：`tests/prompt-library.mjs` 断言剪贴板里**仍带 `**`**
 *   （复制出去的是喂给模型的提示词，强调语义在那里是正常写法）。
 *
 * 动 `renderEmphasis`、动 `PromptLibrary` 的正文渲染、或往 JSON 里加新数据 ——
 * 三处都会让这一节失守，都先看上面这两条防线。
 *
 * ### ⚠️ 第二类豁免来源：ComfyUI 工作流快照里的 `**`（2026-10-26 加）
 *
 * 上面讲的是**提示词源**（`src/client/workbench/prompt-sources/*.json`）。
 * 还有**另一类**来源也带 `**`，它的豁免依据**完全不同**，别混：
 *
 * | | 提示词源 `prompt-sources/*.json` | ComfyUI 工作流 `src/schedule/comfyui-workflows/*.json` |
 * |---|---|---|
 * | `**` 是什么 | **用户会看到的正文** | **发给本地 ComfyUI 的参数值** |
 * | 界面渲不渲染 | 渲染 —— `renderEmphasis` 变成真粗体 | **不渲染** —— 只是一个槽位值 |
 * | 能不能改 | 不能（上游原文快照） | 不能（CA 那单逐字节核对过与上游相同） |
 * | 豁免依据 | 「已经渲染成粗体了，用户看不到星号」 | 「这段字根本不在用户视野里」 |
 *
 * 一句话说清：**提示词源的 `**` 是「用户会看到的正文，所以那边必须走
 * `renderEmphasis` 渲染成真粗体」；ComfyUI 工作流 JSON 里的 `**` 是
 * 「发给上游的参数值，界面不渲染」。两类的豁免依据不同，别混。**
 *
 * 混写的危险很具体：以后有人删掉 `renderEmphasis`，提示词源那 140 处会当场
 * 露出星号（用户看得见），而工作流那 10 处**仍然没事**（用户看不见）。
 * 若两类写成同一句理由，删的时候就会以为「反正都豁免了」，把真问题放过去。
 *
 * 这一类的靶子**现数**：`workflowDataBodies()` 从 JSON 里递归找所有含 `**`
 * 的字符串值，不写死条数与处数 —— 换一份工作流文件、上游改一句提示词，
 * 靶子跟着变；写死的话那种变化会被「数字照样对」掩盖。
 *
 * 跑法：node tests/copy-no-markdown.mjs
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, extname, relative, dirname } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
/** TypeScript 的位置与 `package.json` 里 check:types 用的那份一致。 */
const ts = require('F:/AGENTS/agent-chat-dsh/refs/deepseek-harness@62962ee4/node_modules/typescript')

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const EXTS = new Set(['.ts', '.tsx', '.mjs', '.js', '.jsx'])

/** 累计失败数。 */
let failed = 0
/**
 * 断言。
 * @param {string} name 说明。
 * @param {boolean} ok 通过与否。
 * @param {string} [detail] 失败时补一句。
 */
function check(name, ok, detail) {
  console.log('   ' + (ok ? '✓' : '✗') + ' ' + name + (ok || detail === undefined ? '' : ' —— ' + detail))
  if (!ok) failed++
}

/**
 * 从**客户端入口**出发，跟着 import 走，看能不能走到 `comfyui-workflows/registry`。
 *
 * ## 为什么不能只扫「有没有 import 行」（第一版就是这么写的，实测不行）
 *
 * 第一版扫 `src/client/**` 里的 import 行，结果 `yes = true`、期望回到 10 处、
 * 而产物里是 0 处 → 红。查了原因：`WorkspaceSettings.tsx:74-75` 有两行
 * **没人用的 import**（`ChannelSettings` / `DefaultsSettings` 从票 66 起就不再被
 * 那个文件用了，import 行留着）。而 `ChannelSettings.tsx:58` 又 import 了 registry。
 *
 * 于是「源码里有 import 行」为真，但**打包器按可达性摇树** ——
 * `ConfigBoard` 不再 import `ChannelSettings`，那条链从入口走不到，
 * 那批 JSON 照样被摇掉。判据若按 import 行判，就与打包器的真实行为对不上。
 *
 * 所以这里做的是**可达性遍历**：从 `src/client/index.ts` 出发跟相对路径 import，
 * 能走到的文件才算「进了客户端产物」。这正是打包器做的那件事
 * （只限相对路径 import；裸包名不进我们的树）。
 *
 * @returns 可达就 true。
 */
function clientReachesWorkflowRegistry() {
  const entry = join(ROOT, 'src', 'client', 'index.ts')
  if (!existsSync(entry)) return { yes: false, via: [] }
  const visited = new Set()
  /** 走过的路径（命中时用来报「从哪条链进来的」）。 */
  const via = []
  const EXTS_TRY = ['', '.ts', '.tsx', '.mjs', '.js', '.jsx', '.json', '/index.ts', '/index.tsx']
  const resolveRel = (from, spec) => {
    const base = join(dirname(from), spec)
    for (const suf of EXTS_TRY) {
      const p = base + suf
      if (existsSync(p) && statSync(p).isFile()) return p
    }
    return null
  }
  /** 广度优先，带路径回溯（好用来说明「谁把它带进来的」）。 */
  const queue = [[entry, [relative(ROOT, entry)]]]
  while (queue.length > 0) {
    const [file, chain] = queue.shift()
    if (visited.has(file)) continue
    visited.add(file)
    if (file.includes('comfyui-workflows') && file.includes('registry')) {
      return { yes: true, via: chain }
    }
    let src
    try { src = readFileSync(file, 'utf8') } catch { continue }
    /* 抓 `from '…'` 与 `import('…')` 与 `require('…')`，只认相对路径。 */
    /* ── 跟链时要跳过「导入了但从未被用到」的那一句（第二版死在这里）──
     *
     * 只按 import 行跟下去时，实测仍然 `reaches = true`，链是：
     *
     * ```
     * src/client/index.ts → EcomWorkbench.tsx → boards.ts → ConfigBoard.tsx
     *   → WorkspaceSettings.tsx → ChannelSettings.tsx → registry.ts
     * ```
     *
     * 但产物里那批 JSON 是 0 处 —— 因为 `WorkspaceSettings.tsx:74-75` 那两行
     * 是**没人用的 import**（票 66 之后那个文件不再渲染 `ChannelSettings` /
     * `DefaultsSettings`，import 行留着），打包器把**未使用的绑定**摇掉了。
     *
     * 所以跟链时要跳过「导入了、但名字在文件别处一次都没出现」的那些句 ——
     * 那正是打包器的判据。这不是猜：`grep -c comfyuiT2iWorkflow lib/client.js → 0`
     * 就是它按这个语义摇出来的结果。 */
    const specs = new Set()
    /* ★ 票 75 补：**side-effect import**（`import './x.ts'`）——
     * 没有 `from`、没有绑定名，下面那条带 `from` 的正则抓不到它。
     *
     * ## 漏了它会怎样（实测）
     *
     * `EcomWorkbench.tsx:31` 就是一句 `import './boards.ts'` ——
     * 那是**注册板块**的副作用导入，正是它把 `boards.ts` 带进来的。
     * 漏掉这一类之后遍历只走到 5 个文件就断了，`boards.ts` 后面那一串
     * （`ConfigBoard` → `ChannelSettings` → `registry`）全跟丢，
     * 于是误判成「客户端到不了 registry」，期望写成 0 处，
     * 而产物里其实有 10 处 → 红，而且诊断还把原因说反成「产物是旧的」。
     *
     * ⚠️ 这一类**无条件加入**，不走下面那套「名字被用到才活」的判活 ——
     * 它本来就没有名字。打包器对它的语义是「只要这一句在，那个模块就进产物」。 */
    for (const m of src.matchAll(/^\s*import\s+['"](\.[^'"]*)['"]/gm)) specs.add(m[1])
    for (const m of src.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s+['"](\.[^'"]*)['"]/gm)) {
      const clause = m[1]
      const spec = m[2]
      /* `import type` 整句跳过：它是类型，不进产物。 */
      if (/^\s*type/.test(clause)) continue
      const names = []
      const braced = /\{([\s\S]*)\}/.exec(clause)
      if (braced !== null) {
        for (const one of braced[1].split(',')) {
          for (const piece of one.split(' as ')) {
            const n = piece.trim().replace(/^type\s+/, '')
            if (/^[A-Za-z_$][\w$]*$/.test(n)) names.push(n)
          }
        }
      }
      /* 默认导入那一段（花括号之前的部分）。 */
      const head = clause.replace(/\{[\s\S]*\}/, '').trim()
      const def = /^([A-Za-z_$][\w$]*)/.exec(head)
      if (def !== null) names.push(def[1])
      /* 这一句之外还出现过任意一个名字 → 这个 import 是活的。 */
      /* 这一句之外还出现过任意一个名字 → 这个 import 是活的。
       *
       * ## ⚠️ **必须先剥注释**（票 75 自证时实测踩到）
       *
       * 打包器判「绑定有没有被用到」时**不看注释**。而这段代码第一版直接把
       * 整份源码拿去正则 —— 于是「注释里提到过这个名字」就会把一句死 import
       * 判成活的。实测：把 `ConfigBoard.tsx` 里挂的 `ChannelSettings` 那一步注掉，
       * 本该 `yes: false`（客户端到不了 registry），结果仍然 `yes: true` ——
       * 因为同一个文件的注释里还有几处提到它（都在讲它为什么在这一格）。
       *
       * 那个形状比「判据失效」更难发现：**它是绿着错的**。
       * 所以这里剥掉块注释与行注释再判，与打包器同一个语义。 */
      const rest = src.replace(m[0], '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      const alive = names.length === 0
        || names.some(n => new RegExp('(^|[^\w$.])' + n.replace(/\$/g, '\$') + '([^\w$]|$)').test(rest))
      if (alive) specs.add(spec)
    }
    for (const m of src.matchAll(/(?:from|import)\s*\(\s*['"](\.[^'"]*)['"]/g)) specs.add(m[1])
    for (const m of src.matchAll(/require\s*\(\s*['"](\.[^'"]*)['"]/g)) specs.add(m[1])
    for (const spec of specs) {
      const p = resolveRel(file, spec)
      if (p !== null) queue.push([p, [...chain, relative(ROOT, p)]])
    }
  }
  return { yes: false, via: [] }
}

/**
 * 递归收集文件。
 * @param {string} dir 目录。
 * @returns {string[]} 文件路径。
 */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'lib' || name === '.git') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (EXTS.has(extname(name))) out.push(p)
  }
  return out
}

/**
 * 收集「用户可能读到的文本」的区间。
 *
 * kind 有三种，**刻意把反引号串与单双引号串分开**：
 *   - `字符串`   = `'…'` / `"…"`  —— 生成器的备注文案就是这种
 *   - `反引号串` = `` `…` ``（含带 `${}` 的模板串）—— 生成器里那是 shell 脚本正文
 *     与 `code.js` 代码正文，**进的是节点参数的「代码」、不是画布说明文案**
 *   - `JSX 文本` = JSX 里直接写的文字
 *
 * @param {import('typescript').SourceFile} sf 已解析的源文件
 * @returns {Array<{start:number, end:number, kind:string}>} 区间（已按起点排序）
 */
function textRanges(sf) {
  const out = []
  const visit = (node) => {
    const k = node.kind
    if (k === ts.SyntaxKind.StringLiteral) {
      out.push({ start: node.getStart(sf), end: node.getEnd(), kind: '字符串' })
    } else if (k === ts.SyntaxKind.NoSubstitutionTemplateLiteral || k === ts.SyntaxKind.TemplateExpression) {
      out.push({ start: node.getStart(sf), end: node.getEnd(), kind: '反引号串' })
    } else if (k === ts.SyntaxKind.JsxText) {
      out.push({ start: node.getStart(sf), end: node.getEnd(), kind: 'JSX 文本' })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * 扫一个文件，返回「用户可见位置」的 `**` 清单。
 * @param {string} file 文件路径。
 * @param {'ui'|'note'} [mode] `ui`（默认）= 字符串 + 反引号串 + JSX 文本；
 *   `note` = **只**单双引号字符串 —— 生成器用的那把尺（理由见文件头）。
 * @returns {Array<{line:number, at:number, kind:string, text:string}>} 命中（空 = 干净）
 */
function visibleStars(file, mode = 'ui') {
  const src = readFileSync(file, 'utf8')
  if (!src.includes('**')) return []
  const isJsx = file.endsWith('.tsx') || file.endsWith('.jsx')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, isJsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  /* ⚠️ note 模式刻意**不收反引号串** —— 见文件头「覆盖范围」第 2 条。 */
  const ranges = textRanges(sf).filter(r => mode === 'ui' || r.kind === '字符串')
  const hits = []
  for (let i = src.indexOf('**'); i !== -1; i = src.indexOf('**', i + 2)) {
    const range = ranges.find(r => i >= r.start && i < r.end)
    if (range === undefined) continue
    const lineStart = src.lastIndexOf('\n', i) + 1
    const lineEnd = src.indexOf('\n', i)
    /* `at` 是**字符偏移**，给「豁免」那一段筛位置用 —— 光有行号不够：
     * 同一行里可能有多个 `**`，有的来自数据、有的来自新写的代码。 */
    hits.push({ line: src.slice(0, i).split('\n').length, at: i, kind: range.kind, text: src.slice(lineStart, lineEnd === -1 ? src.length : lineEnd).trim().slice(0, 160) })
  }
  return hits
}

console.log('① 源码 `src/**`：用户可见位置不许有 `**`')
const srcFiles = walk(join(ROOT, 'src'))
const srcHits = []
for (const f of srcFiles) {
  for (const h of visibleStars(f)) srcHits.push({ file: relative(ROOT, f).replace(/\\/g, '/'), ...h })
}
check('`src/**` 的字符串 / JSX 文本里没有 `**`', srcHits.length === 0,
  srcHits.length === 0 ? '' : `${srcHits.length} 处，例：${srcHits[0].file}:${srcHits[0].line} ${srcHits[0].text}`)

/* 注释里的必须**还在**（这次只清用户可见的，不是把 `**` 全删掉）。
 * 留一条下限断言：注释是我们写文档的地方，若某次误用「全文替换」清掉它们，这里会红。 */
console.log('')
console.log('② 生成器 `scripts/**`：会写进存档 `node.note` 的字符串里不许有 `**`')
const scriptFiles = walk(join(ROOT, 'scripts'))
const noteHits = []
for (const f of scriptFiles) {
  for (const h of visibleStars(f, 'note')) noteHits.push({ file: relative(ROOT, f).replace(/\\/g, '/'), ...h })
}
check('`scripts/**` 的字符串字面量里没有 `**`（它们会变成节点备注）', noteHits.length === 0,
  noteHits.length === 0 ? '' : `${noteHits.length} 处，例：${noteHits[0].file}:${noteHits[0].line} ${noteHits[0].text}`)

console.log('')
console.log('③ 注释里的 `**` 必须**保留**（只清用户可见的那类）')
let commentStars = 0
for (const f of [...srcFiles, ...scriptFiles]) {
  const src = readFileSync(f, 'utf8')
  const total = src.split('**').length - 1
  const visible = visibleStars(f).length
  commentStars += total - visible
}
check('源码与生成器里仍有大量注释用 `**`（说明没有误伤注释）', commentStars > 1000, `实际 ${commentStars} 处`)

console.log('')
console.log('④ 产物 `lib/client.js` / `lib/index.js`：用户可见位置不许有 `**`')
/**
 * 提示词库那 8 条**上游数据正文**的原文（豁免用的靶子）。
 *
 * ## 为什么要它（不是「放过整个产物」）
 *
 * 那 8 条是上游快照（`prompt-sources/*.json`），里面 140 处 `**` 是**原文，
 * 不许改**（改了与上游对不上账）。而它们是字面量，所以产物字符串里必然有。
 *
 * 豁免的做法：把**每一整段正文原文**拿去在产物里找，命中的那些 `**` 标成「来自数据」。
 * 于是「代码里新写一句带 `**` 的文案」仍然会红 —— 它不在任何一段正文里。
 *
 * ⚠️ 只认**完整的那一段**（`indexOf` 整串，长度 ≥ 40 字），不认零散的
 * `**身份保持**` 这种片段：片段匹配会让「别处也写了同样一句话」顺手免掉。
 *
 * @returns {string[]} 那 8 条正文原文。
 */
function promptDataBodies() {
  const dir = join(ROOT, 'src/client/workbench/prompt-sources')
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    let arr
    try { arr = JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { continue }
    if (!Array.isArray(arr)) continue
    for (const e of arr) {
      if (typeof e?.prompt === 'string' && e.prompt.includes('**') && e.prompt.length >= 40) out.push(e.prompt)
    }
  }
  return out
}
const DATA_BODIES = promptDataBodies()
/**
 * 一段正文在产物里可能出现**两种写法**：原样（真换行）或 JSON 转义后（`\\n`）。
 *
 * 为什么必须两种都认：那 8 条正文是多行字符串，打进 `lib/client.js` 时
 * 被序列化成 `"...\n1.  **身份保持**：..."` —— 产物里是**反斜杠 n**，不是真换行。
 * 第一版只比原文，于是 `indexOf` 全部落空、豁免一处都没生效（而输出上
 * 「取到了 8 条靶子」照样是绿的，那是这条机制最容易骗人的地方）。
 *
 * @param {string} body 正文原文。
 * @returns {string[]} 在产物里该找的写法（按长短优先，先找长的）。
 */
function bodyVariants(body) {
  const esc = JSON.stringify(body).slice(1, -1)
  return body === esc ? [body] : [esc, body]
}
/**
 * 这个偏移量是不是落在某段上游正文里。
 * @param {string} src 产物全文。
 * @param {number} at `**` 出现的偏移。
 * @returns {boolean} 落在数据正文里给 true。
 */
function insideDataBody(src, at) {
  return insideBodies(src, at, DATA_BODIES)
}
/**
 * 这个偏移量是不是落在**某一组靶子**里。
 * @param {string} src 产物全文。
 * @param {number} at `**` 出现的偏移。
 * @param {readonly string[]} bodies 靶子（整段原文）。
 * @returns {boolean} 落在其中任一段里给 true。
 */
function insideBodies(src, at, bodies) {
  for (const body of bodies) {
    /* 整段比对：先找到这段正文的起点，再看 `at` 是不是落在它范围内。
     * 一段正文只可能在产物里出现一次（它在源数据里就一处）。 */
    for (const form of bodyVariants(body)) {
      const start = src.indexOf(form)
      if (start < 0) continue
      if (at >= start && at < start + form.length) return true
    }
  }
  return false
}

/**
 * **第二类豁免来源**：ComfyUI 工作流快照里的字符串（CA 那单搬进来的上游 JSON）。
 *
 * ## 为什么它们也带 `**` 却是正当的（与提示词源那一类**不是**一回事）
 *
 * | | 提示词源 `prompt-sources/*.json` | ComfyUI 工作流 `comfyui-workflows/*.json` |
 * |---|---|---|
 * | `**` 是什么 | **用户会看到的正文** | **发给本地 ComfyUI 的参数值** |
 * | 界面渲不渲染 | 渲染（`renderEmphasis` 变成真粗体） | **不渲染**（只是一个槽位值） |
 * | 能不能改 | 不能（上游原文） | 不能（CA 那单逐字节核对过与上游相同） |
 * | 豁免依据 | 「已经渲染成粗体，用户看不到星号」 | 「用户根本看不到这段字」 |
 *
 * 这张表放在这里是刻意的：两类的**豁免理由不同** —— 一类靠「渲染兜住了」，
 * 一类靠「不在用户视野里」。混成一类写，以后有人删掉 `renderEmphasis` 时
 * 会以为这 10 处也无所谓，那才是真的漏。
 *
 * ## 靶子**现数**，不写死
 *
 * 从 `src/schedule/comfyui-workflows/*.json` 递归找**所有**含 `**` 的字符串值。
 * 不写 `10`：换一份工作流文件、上游改一句提示词，靶子跟着变；
 * 写死数字的话，那种变化会被「数字照样是 10」掩盖过去。
 *
 * @returns {string[]} 含 `**` 的字符串值（整段原文）。
 */
function workflowDataBodies() {
  const dir = join(ROOT, 'src/schedule/comfyui-workflows')
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    let doc
    try { doc = JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { continue }
    /**
     * 递归收集字符串值（JSON 的形状由上游决定，不能假设层级）。
     * @param {unknown} node 任意 JSON 节点。
     */
    const walk = (node) => {
      if (typeof node === 'string') {
        if (node.includes('**')) out.push(node)
        return
      }
      if (Array.isArray(node)) { for (const x of node) walk(x); return }
      if (node !== null && typeof node === 'object') {
        for (const k of Object.keys(node)) walk(node[k])
      }
    }
    walk(doc)
  }
  return out
}
const WORKFLOW_BODIES = workflowDataBodies()
/** 这些靶子里一共多少处 `**`（**现数**，不是写死的 10）。 */
const WORKFLOW_STARS = WORKFLOW_BODIES.reduce(
  (n, s) => n + (s.match(/\*\*/g) ?? []).length, 0,
)

/* 豁免靶子必须真的取到了 —— 取不到就等于「悄悄把整条断言放过了」。
 * 这条断言是豁免机制自己的保险丝。 */
check('取到了提示词库里那 8 条带 `**` 的上游正文（豁免靶子）',
  DATA_BODIES.length === 8, `实际 ${DATA_BODIES.length} 条`)

/* ★ 第二道保险丝：**每一条**靶子都要在产物里真的找到。
 *
 * 为什么需要它：上面那条只验「从 JSON 里取到了 8 条」。取到了但在产物里
 * 一处都对不上（编码形式不同、被压缩改了）时，豁免会**一条都没生效**，
 * 而输出上看起来一切正常 —— 第一版就是只比原文、产物里是 `\n` 转义，
 * 「取到 8 条」照样绿、豁免一处没生效。这条钉死那个盲区。 */
{
  const p = join(ROOT, 'lib/client.js')
  if (existsSync(p)) {
    const src = readFileSync(p, 'utf8')
    const missing = DATA_BODIES.filter(body => bodyVariants(body).every(f => !src.includes(f)))
    check('★★ 那 8 条正文在产物里**逐条**都找得到（豁免真的生效，不是空转）',
      missing.length === 0,
      missing.length === 0 ? '' : `${missing.length} 条对不上，例：${missing[0].slice(0, 40)}…`)
  }
}

/* ★ 第二类来源（ComfyUI 工作流快照）的靶子：**现数** + **逐条在产物里找得到**。
 *
 * 两条都必须有，缺一条这个豁免就会变成假绿：
 *   ① **现数**（`WORKFLOW_STARS` 不是写死的 10）：临时删掉 JSON 里几处 `**`，
 *      这个数会变小 —— 后面与「产物里被豁免掉多少处」一比，数字不等就红。
 *      写死的话，「JSON 改了但产物没重建」会被「照样是 10」掩盖过去。
 *   ② **逐条找得到**：靶子取到了、但产物里一处都对不上（换了打包形态、
 *      字符串被转义成别的样子）时，豁免会**一条都不生效**，
 *      而「取到了 N 条」照样绿 —— 这正是上一轮踩过的那个盲区。
 */
check('★★ 从 comfyui-workflows 里现数取到了靶子（含 `**` 的字符串值）',
  WORKFLOW_BODIES.length > 0 && WORKFLOW_STARS > 0,
  `${WORKFLOW_BODIES.length} 条、共 ${WORKFLOW_STARS} 处 **`)
{
  const p = join(ROOT, 'lib/index.js')
  if (existsSync(p)) {
    const src = readFileSync(p, 'utf8')
    const missing = WORKFLOW_BODIES.filter(body => bodyVariants(body).every(f => !src.includes(f)))
    check('★★ comfyui-workflows 的靶子在产物里**逐条**都找得到（豁免不是空转）',
      missing.length === 0,
      missing.length === 0 ? '' : `${missing.length} 条对不上，例：${missing[0].slice(0, 40)}…`)
  }
}

for (const name of ['lib/client.js', 'lib/index.js']) {
  const p = join(ROOT, name)
  if (!existsSync(p)) {
    check(`${name} 存在（要先 npm run bundle）`, false, '文件不存在')
    continue
  }
  const all = visibleStars(p)
  const src = readFileSync(p, 'utf8')
  /* ⚠️ 用 `visibleStars` 给的**字符偏移**判位置，不用 `text` 回找。
   * 回找（`src.indexOf(h.text)`）会撞车：同一行文字可能在产物里出现多次，
   * 第一版就是那么写的 —— 只要第一处落在数据正文里，同一行**别处**的 `**`
   * 都会被顺带免掉。判据变松了而输出看着正常，这类错最难发现。 */
  const kept = []
  const exemptedPrompt = []
  const exemptedWorkflow = []
  for (const h of all) {
    if (insideDataBody(src, h.at)) exemptedPrompt.push(h)
    else if (insideBodies(src, h.at, WORKFLOW_BODIES)) exemptedWorkflow.push(h)
    else kept.push(h)
  }
  /* 断言名里刻意不写反引号：模板串里转义反引号很容易写错（这一行踩过一次）。 */
  check(`${name} 的字符串 / JSX 文本里没有成对星号（已扣掉提示词库正文与 ComfyUI 工作流那两部分）`,
    kept.length === 0,
    kept.length === 0 ? '' : `${kept.length} 处，例：L${kept[0].line} ${kept[0].text}`)
  /* ★ 现数对照：产物里被「ComfyUI 工作流」类豁免掉的处数。
   *
   * 这一条是「靶子现数」的直接证据：临时删掉 JSON 里几处 `**` 之后，
   * 左边（产物里的豁免数）不变、右边（`WORKFLOW_STARS`）变小 → 红。
   * 反过来说，若把数字写死成 10，这种变化就抓不到。
   *
   * ## ⚠️ 2026-10-29（票 68）：期望值现在**按源码 import 推**，不是写死 10
   *
   * 票 68 让客户端不再挂 `ChannelSettings`，而它是**唯一**引用
   * `comfyui-workflows/registry` 的客户端文件 → 那 16 份 JSON 被摇掉。
   *
   * ```
   * grep -c comfyuiT2iWorkflow lib/client.js  → 0（票 68 之前是 10）
   * grep -c comfyuiT2iWorkflow lib/index.js   → 2（宿主半一直在用）
   * ```
   *
   * 所以这一侧的期望从「10 处」变成「0 处 + 产物里没有 registry 痕迹」。
   * **这不是放宽**：判据看的是「这个产物按源码该不该含那批数据」，
   * 而不是「某个固定数字」。谁把 registry import 回客户端，`hasRegistry` 一真、
   * 期望就回到 10 处，产物没重建立刻红 —— 它比写死 10 更严（写死的那个
   * 在客户端不该含时永远红，人只好把它删掉或改成模糊值，那才是真放宽）。
   *
   * ⚠️ `lib/index.js`（宿主半）那一侧照旧要求 10 处：它一直 import registry。 */
  const isClient = name === 'lib/client.js'
  const hasRegistry = isClient ? clientReachesWorkflowRegistry() : { yes: true, via: [] }
  /* ★ 把 via 链**打出来**（不只放在失败时的 detail 里）。
   *
   * 为什么：`check()` 只在失败时印 detail，而这一条大部分时候是绿的 ——
   * 链对不对**看不见**。而这条判据的价值恰恰在「它按哪条链判的」：
   * 链错了（比如漏了 side-effect import）就会把期望值判反，
   * 那种错是**绿着错**的，只有把链印出来才能当场发现。
   *
   * 它只在 `lib/client.js` 那一侧打（宿主半没有「能不能走到」这回事）。 */
  if (isClient) {
    console.log(`   客户端入口${hasRegistry.yes ? '能' : '不能'}走到 comfyui-workflows/registry`
      + (hasRegistry.via.length > 0 ? '：' : '')
      + hasRegistry.via.join(' -> '))
  }
  const wantWorkflow = hasRegistry.yes ? WORKFLOW_STARS : 0
  check(`★★ ${name} 里被「ComfyUI 工作流」豁免的处数与源数据现数一致`
    + `（${hasRegistry.yes ? WORKFLOW_STARS + ' 处' : '0 处 —— 客户端产物不含那批 JSON'}）`,
  exemptedWorkflow.length === wantWorkflow,
  /* ⚠️ **诊断只说判据自己的结论，不猜原因**（票 75 改）。
   *
   * 上一版这里写「产物是旧的，重跑 npm run bundle」—— 那是**猜**，
   * 而且猜错过一次：真正的原因是遍历漏了 side-effect import，
   * 产物明明是新的。判据把猜的原因印出来比不给原因更糟：
   * 下一个人会照着那句去重打包，打三次也不会好。
   *
   * 所以这里只印三件可核对的事实：
   *   ① 期望几处、产物里几处（判据自己的结论）
   *   ② 期望是怎么来的（能不能从入口走到 registry）
   *   ③ 能走到的话，**via 链**是哪一条（一眼看出是被谁带进来的） */
  `产物里豁免 ${exemptedWorkflow.length} 处，期望 ${wantWorkflow} 处`
    + `；从 src/client/index.ts ${hasRegistry.yes ? '能' : '不能'}走到 comfyui-workflows/registry`
    + (hasRegistry.yes && hasRegistry.via.length > 0
      ? '（via: ' + hasRegistry.via.slice(0, 6).join(' -> ')
        + (hasRegistry.via.length > 6 ? ' -> …' : '') + '）'
      : ''))
  /* ★ 客户端那一侧**必须同时**钉住「产物里真的没有那批数据」。
   *
   * ## 为什么不能只要求「豁免 0 处」
   *
   * 「豁免 0 处」是一个**能被空转满足**的条件：产物里根本没有那批字符串时，
   * 豁免自然是 0。将来谁把 registry import 回客户端、那批 JSON 回来了，
   * `hasRegistry.yes` 变真 → 期望回到 10 处 → 会红（好）。
   *
   * 但反过来还有一条漏网的路：**import 还在、而打包把它摇掉了**
   * （比如有人改了构建配置）。那时 `hasRegistry.yes` 为真、期望 10 处，
   * 产物里 0 处 → 也红。两条合起来，「该含」与「不该含」两个方向都封住了。
   *
   * 这里加的是**独立的第二条证据**：直接看产物里有没有 registry 的痕迹，
   * 不与「豁免数」共用同一个来源 —— 免得两处一起错还互相印证。 */
  if (isClient) {
    check('★★ 客户端产物里**没有** comfyui-workflows 的痕迹（与上面那条独立取证）',
      !hasRegistry.yes || src.includes('comfyuiT2iWorkflow'),
      hasRegistry.yes
        ? '源码 import 了 registry，产物里却没有 comfyuiT2iWorkflow —— 打包配置把它摇掉了'
        : '')
    check('★★ 反向：源码没 import registry 时，产物里 `comfyuiT2iWorkflow` 必须零命中',
      hasRegistry.yes || !src.includes('comfyuiT2iWorkflow'),
      hasRegistry.yes
        ? ''
        : (src.includes('comfyuiT2iWorkflow')
          /* ⚠️ **只说事实，不猜原因**（票 75 改）。
           *
           * 上一版这里写「产物是旧的，重跑 npm run bundle」—— 与上面那条同一个毛病：
           * 那是**猜**。两种可能它分不出来：
           *   ① 产物真旧（改了源码没打包）；
           *   ② 判据自己把「能不能走到」判错了（票 75 就发生过：遍历漏了
           *      side-effect import，于是把真话说成了「产物旧」）。
           * 猜错的那次，人照着它去重打包，打三次也不会好。
           *
           * 所以这里只印两件可核对的事：判据说**走不到**，而产物里**有**。
           * 至于哪一边错，让人拿上面打出来的 via 链自己看一眼。 */
          ? '判据判定「从 src/client/index.ts 走不到 registry」，但产物里 `comfyuiT2iWorkflow` 有命中'
            + '（要么产物是旧的，要么这个可达性判定本身错了 —— 看上面打出来的那条 via 链）'
          : ''))
  }
  if (exemptedPrompt.length > 0 || exemptedWorkflow.length > 0) {
    console.log(`   （豁免 ${exemptedPrompt.length + exemptedWorkflow.length} 处：`
      + `${exemptedPrompt.length} 处来自 prompt-sources 正文、`
      + `${exemptedWorkflow.length} 处来自 comfyui-workflows 参数值）`)
  }
}

console.log('')
console.log(failed === 0 ? '结论：用户可见文案里没有 markdown 加粗标记 ✓' : `结论：有 ${failed} 条不通过 ✗`)
process.exit(failed === 0 ? 0 : 1)
