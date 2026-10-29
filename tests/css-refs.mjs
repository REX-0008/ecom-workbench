/** CSS 引用一致性检查：核对「代码引用的类名」与「产物里真的发射了的规则」。
 *
 * 为什么需要（2026-11-10 建）：
 * 把 1541 行的 workflow-canvas.module.css 拆成 5 个文件后，出现了一类**静默失效**：
 *   - `.canvas` 的规则被拆进 canvas-tokens.module.css，而代码引用的是
 *     `css_workflow_canvas.canvas` → 两者生成的 hash 类名不同 →
 *     **元素上挂的类名根本没有对应规则** → 容器高度 0 → React Flow 报「错误 004」。
 *   - `RunHistoryPanel.tsx` import 了 workflow-canvas，但那些 `hist*` 类在
 *     EcomWorkbench.module.css 里 → 映射不到 → 类名变 undefined。
 *
 * 两类都不报错、构建通过、单测通过 —— 只有真机上「样式不见了」。
 * 这个脚本在**产物层**核对：对每个 `import css_X from './Y.module.css'`，
 * 把代码里用到的每个 `css_X.类名` 查它的 hash，再确认产物里存在该 hash 的规则。
 *
 * ## ⚠️ 已知限制：断点那一组是**扫全文本**的，注释里的断点类名也算「使用」
 *
 * `walk()`（本文件下方）逐行正则扫源码**全文本**，**不跳注释**。
 * 所以只要注释里出现了形如 `2xl:flex`、`sm:grid-cols-2` 这类**断点类名**，
 * 它就会被当成「源码用了这个断点」，然后去产物里找对应规则 —— 找不到就红。
 *
 * **2026-10-27 就这么红过一次**：`ImageWorkbench.tsx:994` 那段注释写着
 * 「卡片式多列网格（`sm:grid-cols-2 2xl:grid-cols-3`，照参考项目）」，
 * 而真实代码用的是 inline `style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}`
 * —— 那两个断点类**从来没在代码里出现过**。注释在说谎，而这份检查把它当真了。
 *
 * **所以看到断点那条红时，正确的怀疑顺序是：**
 *
 * | 先查 | 再看 |
 * |---|---|
 * | **注释里是不是写了断点类名**（最常见） | 真实 `className` 里是不是真用了这个断点 |
 * | 真实用了但产物没发射 → 查 `tailwind.css` 的 `@theme` 里有没有声明该 `--breakpoint-*` |
 * | 产物是旧的 → 重新打包（本检查比的是产物，不是源码） |
 *
 * **结论：注释里不要写断点类名**（哪怕是在描述实现）。写实现就写「按容器宽度自适应列数」
 * 这类说法，不要抄类名。
 *
 * ## 为什么不改成「扫的时候跳过注释」
 *
 * 那样会新增一类**漏检**：注释里写了一个真类名、代码里忘了写 —— 那是真 bug
 * （本文件开头讲的两类静默失效正是这种形状），跳注释就再也抓不到了。
 * **宁可让注释里别写类名，也不让检查瞎掉。**
 */
import { readFileSync, readdirSync } from 'node:fs'

const DIR = new URL('../src/client/workbench/', import.meta.url)
const BUNDLE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/* ① 从产物里抽各 CSS Modules 的「类名 → hash」映射表。 */
function moduleMap(fileName) {
  const varName = 'var ' + fileName.replace(/[.-]/g, '_') + '_module_css_default = {'
  const i = BUNDLE.indexOf(varName)
  if (i < 0) return null
  const seg = BUNDLE.slice(i, BUNDLE.indexOf('};', i))
  const out = new Map()
  for (const m of seg.matchAll(/"([\w]+)":\s*"([^"]+)"/g)) out.set(m[1], m[2])
  return out
}

let problems = 0
let checked = 0
console.log('=== CSS 引用一致性检查 ===')

for (const f of readdirSync(DIR).filter((x) => /\.tsx?$/.test(x))) {
  const src = readFileSync(new URL(f, DIR), 'utf8')
  /* 一个文件可能 import 多个 CSS（拆文件后常见）。 */
  for (const im of src.matchAll(/import (\w+) from '\.\/([\w-]+)\.module\.css'/g)) {
    const [, varName, modName] = im
    const map = moduleMap(modName)
    if (map === null) { console.log('  ✗ ' + f + ' —— 产物里找不到 ' + modName + ' 的映射表'); problems += 1; continue }
    const used = new Set([...src.matchAll(new RegExp('\\b' + varName + '\\.([a-zA-Z][\\w]*)', 'g'))].map((x) => x[1]))
    for (const cls of used) {
      checked += 1
      const hash = map.get(cls)
      if (hash === undefined) {
        console.log('  ✗ ' + f + '：' + varName + '.' + cls + ' —— ' + modName + '.module.css 里没有这个类')
        problems += 1
        continue
      }
      /* 该 hash 必须在产物里有规则（可能作为独立规则、或逗号分组的一员）。 */
      if (!new RegExp('\\.' + hash + '[\\s,{:.]').test(BUNDLE)) {
        console.log('  ✗ ' + f + '：' + varName + '.' + cls + ' → .' + hash + ' —— 产物里没有这条规则（规则可能被拆到了别的文件）')
        problems += 1
      }
    }
  }
}

console.log('核对 ' + checked + ' 处引用；问题 ' + problems + ' 处')
if (problems > 0) process.exitCode = 1

/* ══ 响应式变体必须在产物里真的发射（2026-10-17 新增）════════════════════
 *
 * ## 为什么要有这一条（用户当场抓到的一类真 bug）
 *
 * 用户 m02340：「工作流管理列表换样式**没改**，仍是横条。」
 *
 * 查实：代码里写的是「窄屏 1 列、宽屏 2-3 列」，而**宽屏那部分根本没被编译出来**
 * —— 产物里搜 lg:grid-cols-2 是 0 次，整份产物只有 2 处 @media
 * （都是 prefers-reduced-motion）。于是那排卡片永远是 1 列，与用户看到的一模一样。
 *
 * 真因：本项目**故意不引 tailwind 的默认主题**（怕 reset 改掉 dsh 外观），
 * 代价是 --breakpoint-* 也没了；Tailwind 对**变量不存在**的变体是**静默不发射**
 * —— 构建成功、类型检查成功、dom-render 也绿（那个测试查的是「源码里写了什么类名」，
 * 不是「产物里有没有这条规则」）。
 *
 * ## 判据（两个方向都查，缺一个就会假绿）
 *
 *   ① 源码里用了某个断点类（sm: / md: / lg: / xl: / 2xl:）
 *      → 产物里必须能找到对应的 .<前缀>\: 规则；
 *   ② tailwind.css 的 @theme 里必须显式声明那个 --breakpoint-<前缀>。
 *
 * ⚠️ 只查「产物里有没有 @media」会假绿：原有的 prefers-reduced-motion 就带 @media。
 * 所以 ① 查的是**这个断点前缀的类名真的发射了**。
 *
 * ⚠️ 有效性验过：把 tailwind.css 里的 --breakpoint-lg 删掉 → 立刻红。 */
{
  const SRC_ROOT = new URL('../src/', import.meta.url)
  const TW = readFileSync(new URL('../src/client/styles/tailwind.css', import.meta.url), 'utf8')
  /** 要盯的断点前缀（Tailwind v4 默认档，取值见 tailwind.css 的 @theme）。 */
  const PREFIXES = ['sm', 'md', 'lg', 'xl', '2xl']
  /** 前缀 → 首次用到它的「文件:行」（报错时能直接指过去）。 */
  const used = new Map()
  /** 递归扫 src/ 下的源码（不看 node_modules，那不是我们的代码）。
   *
   * ⚠️ 认类名的判据是「前缀前面不是类名字符、后面紧跟类名字符」——
   * 用 [^A-Za-z0-9_-] 当前置，比列举一圈引号/空格稳（那圈符号里含反引号，
   * 在多层引号嵌套下很容易写坏）。
   *
   * @param dir - 目录 URL。 */
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = new URL(e.name + (e.isDirectory() ? '/' : ''), dir)
      if (e.isDirectory()) { walk(full); continue }
      if (!/[.](tsx?|mjs)$/.test(e.name)) continue
      const text = readFileSync(full, 'utf8')
      text.split('\n').forEach((line, i) => {
        for (const p of PREFIXES) {
          const re = new RegExp('(?:^|[^A-Za-z0-9_-])' + p + ':([a-z0-9\\[\\]\\-/.%])')
          if (re.test(line) && !used.has(p)) {
            const rel = decodeURIComponent(full.pathname).replace(/^.*[\\/]src[\\/]/, 'src/')
            used.set(p, rel + ':' + String(i + 1))
          }
        }
      })
    }
  }
  walk(SRC_ROOT)

  let bpBad = 0
  for (const [p, where] of used) {
    /* ① 产物里这个断点前缀的类名真的发射了吗（产物里的形态是 .lg\:xxx）。 */
    /* ⚠️ 产物里的形态是 .lg\\:xxx（CSS 文本被嵌在 JS 字符串里，
     * 所以一个反斜杠在产物文件里写成两个）。用 indexOf 直接比字符串，
     * 不绕 RegExp —— 那串反斜杠在源码里嵌套四层，极易写错（我第一版就写错了，
     * 结果 sm/xl 明明在产物里却报「没有」）。 */
    const BS = String.fromCharCode(92)

    /* ══ 数字开头的断点必须先做 CSS 转义（2026-10-28 修的真假红）════════
     *
     * ## 这条红过很久，错的一直是这里，不是产物
     *
     * `2xl` 是**数字开头**的类名，CSS 规范要求先转义首字符，否则 `.\2xl…`
     * 会被解析成「转义序列 2x」。产物的真实形态逐字符是：
     *
     * ```
     * .  \  \  3  2  ' '  x  l  \  \  :        ← 首字符被转义成一个码点 + 空格终结符
     * 46 92 92  51 50 32  120 108 92 92 58
     * ```
     *
     * 也就是 `.<BS><BS>32 xl<BS><BS>:`。
     * 而原来这里一律拼 `'.' + p + BS + BS + ':'` = `.2xl\\:` —— **永远找不到**，
     * 于是 `2xl` 那条**永久假红**。从 `e832853` 起就这样，
     * 只是那时源码里没人用 `2xl:`，`used` 里没这个键，检查空过。
     *
     * ## 转义怎么算（这一行写清，免得下一个人以为是魔法）
     *
     * CSS 的逃生写法是 `\` + **首字符的十六进制码点** + 一个空格（空格是终结符，
     * 用来把转义与后面的字符隔开）。`'2'` → `0x32` → 写出来就是 `\32 `。
     *
     * ⚠️ 所以这一段**不是**「只对 2xl 的硬编码」：`'3'`→`0x33`、`'4'`→`0x34`，
     * 将来真出现 `3xl` 也会自动算对。
     *
     * ⚠️ 也**别改成「写死一个数字 + 切片穿插」的写法**（比如
     * `'3' + p.slice(1) + ' ' + p.slice(2)`）：那样拼出来是 `\3 2xl xl`，
     * 数字与字母被空格拆开，产物里根本没有这种串。**整数运算 + 一次 slice** 才对。 */
    const firstHex = p.charCodeAt(0).toString(16)
    const needle = /^\d/.test(p)
      ? '.' + BS + BS + firstHex + ' ' + p.slice(1) + BS + BS + ':'
      : '.' + p + BS + BS + ':'
    const emitted = BUNDLE.includes(needle)
    /* ② 对应的 @theme 变量在不在。 */
    const declared = new RegExp('--breakpoint-' + p + '\\s*:').test(TW)
    console.log('  ' + (emitted && declared ? '✓' : '✗') + ' 断点 ' + p + '：'
      + '产物里发射=' + (emitted ? '有' : '没有') + ' ｜ @theme 里声明=' + (declared ? '有' : '没有')
      + '（首次用于 ' + where + '）')
    if (!emitted || !declared) {
      bpBad += 1
      console.log('     → 这个断点类会被 Tailwind 静默丢弃（不报错、只是少样式）。'
        + '在 src/client/styles/tailwind.css 的 @theme 里补上 --breakpoint-' + p + '。')
    }
  }
  if (used.size === 0) console.log('  （源码里没有用任何响应式变体 —— 这条检查空过）')
  if (bpBad > 0) process.exitCode = 1
}


/* ══ 盒模型：插件容器里必须有 box-sizing: border-box（2026-10-18 新增）══════
 *
 * ## 为什么要有这一条（用户当场抓到的真 bug）
 *
 * 用户 m03965 截图：「卡片右边距没有正常显示」—— 最右一列卡片的右内边距看不见，
 * 文字贴着右边框。
 *
 * 查实：我们没有引 Tailwind preflight（怕 reset 改掉 dsh 外观），
 * 于是也**丢了它的 `box-sizing: border-box`**。浏览器默认是 content-box，
 * 而我们的写法是照 border-box 写的（`w-full` + `px-5`）：
 * 在 content-box 下宽 = 100% **再加**左右 40px → 内层比卡片宽 40px，
 * 卡片上的 `overflow-hidden` 把右边那 40px 裁掉 → 右内边距消失。
 *
 * ## 判据（三件事都要，少一件就假绿）
 *
 *   ① 产物 CSS 里有 `box-sizing:border-box`；
 *   ② 它**挂在 `[data-ewb-column]` / `[data-ewb-drawer]` 作用域里**
 *      —— 全局 `*` 会 re-skin dsh 宿主页，是本项目明令禁止的；
 *   ③ 包在 `:where()` 里（特指度 0）—— 否则会盖过组件自己手写的 box-sizing。
 *
 * ⚠️ 只查 ① 会假绿：将来若有人为某个组件单独写一条 box-sizing，
 * 全局那条被删掉照样能通过。所以 ① 查的是**带作用域前缀的那一段**。
 *
 * ⚠️ 有效性验过：把这整条规则删掉 → 立刻红（2026-10-18 实测）。 */
{
  const BS = String.fromCharCode(92)
  /* 产物里的形态：:where([data-ewb-column],[data-ewb-drawer]),... {box-sizing:border-box}
   * 用「data-ewb-column 出现 + 其后 400 字内出现 box-sizing:border-box」判定，
   * 不写死整串 —— 选择器顺序将来调整时不该让它假红。 */
  const scoped = []
  let at = BUNDLE.indexOf('data-ewb-column')
  while (at >= 0) {
    const seg = BUNDLE.slice(at, at + 400)
    if (seg.includes('box-sizing:border-box')) { scoped.push(at); break }
    at = BUNDLE.indexOf('data-ewb-column', at + 1)
  }
  const hasScoped = scoped.length > 0
  /* ⚠️ 判据：`box-sizing:border-box` 这条声明**前面 300 字内**出现 `:where([data-ewb-column]`。
   * 不写成一条长正则去串整个选择器列表 —— 那串方括号/字符类在本文件的多层字符串里
   * 极易被转义吃掉（第一版就是这么虚报红的：正则里的 \\[ 变成了字符类）。 */
  /* ⚠️ 必须从 `scoped[0]`（data-ewb-column 那一段）往后找 box-sizing，
   * **不能全局 indexOf** —— 产物里第一条 box-sizing 是某个 CSS Module 里的，
   * 与我们这条规则无关（第一版就是这么虚报红的）。 */
  const seg = hasScoped ? BUNDLE.slice(scoped[0], scoped[0] + 400) : ''
  const hasWhere = hasScoped && seg.includes('box-sizing:border-box')
  console.log('  ' + (hasScoped ? '✓' : '✗') + ' 盒模型：插件容器里声明了 box-sizing: border-box'
    + (hasScoped ? '' : '（缺它 → 所有「w-full + 内边距」的元素都会右侧溢出，被 overflow-hidden 裁掉）'))
  if (!hasScoped) {
    console.log('     → 在 src/client/styles/tailwind.css 里补：'
      + ':where([data-ewb-column],[data-ewb-drawer]) *{box-sizing:border-box}')
    process.exitCode = 1
  } else if (!hasWhere) {
    console.log('  ✗ 盒模型：找到了 box-sizing，但**不是**包在 :where([data-ewb-…]) 作用域里')
    console.log('     → 全局 * 会改掉 dsh 宿主页的外观，必须限定在我们自己的容器')
    process.exitCode = 1
  }
}

/* ══ 下拉的 `<option>` 必须显式给底/字色（2026-10-14，用户 §11）══════════
 *
 * 用户原话：「在黑色主题下，节点中的选项栏不可见（选项栏的底色和文字颜色都是
 * 白色），被选中的才是蓝底黑字可见的，未选中项目视觉上看不到。」
 *
 * ## 为什么在**产物层**查这条
 *
 * `<select>` 的弹层由系统画（原生控件），我们只对 `option` 上的
 * `background-color` / `color` **有影响**（真 Chromium 实测认得）。
 * 而「有没有这段规则」在源码里查会**假绿** —— 本文件开头记的就是这类静默失效。
 * 所以在产物里查它**真的发射了**。
 *
 * 实测数据（真 Chromium + 产物真 CSS 量的「选项底色/文字」对比度）：
 *   · 不写 → `option` 底是 `rgba(0,0,0,0)`（透明），叠在系统弹层上：
 *       暗色 17:1（能看）而**亮色 1.11:1（看不见）** —— 亮暗总有一边踩空；
 *   · 写了（用主题令牌）→ 暗色 12.80:1、亮色 18.90:1，两边都 ≥ WCAG AA 的 4.5:1。
 * 所以这条规则**必须存在**，且必须用**主题令牌**（亮暗各自跟随）而不是写死色值。 */
{
  /* ⚠️ 判据 2026-10-14 从「`.select option` 存在」**扩成「每个下拉类名各自都有」**。
   *
   * 为什么必须逐个查（这是本轮真实漏掉过的事）：
   * §11 第一次修时只给 `node-form` 的 `.select` 加了 option 配色，
   * 而项目里还有另外两个下拉 —— `workflow-canvas` 的 `.setSelect`（设置抽屉）
   * 与 `node-card` 的 `.loopFieldSelect`（循环节点的设置面板，**正是用户说的
   * 「节点中的选项栏」**）—— 它们仍然看不见。
   * 只查一个类名时，漏掉另外两个**测试照样全绿**，所以必须逐类名点检。
   *
   * ⚠️ 用**产物里的真 hash**（`moduleMap`）而不是正则猜类名形状：
   * 直接拿「CSS Modules 映射表里这个类名对应的 hash」去产物里找规则，
   * 这样「类名被改名/加前缀」也不会误判，且错误信息能直接说出是哪个类漏了。 */
  const DROPDOWNS = [
    { mod: 'node-form', cls: 'select', where: '节点参数区（NodeEditorPopover）' },
    { mod: 'workflow-canvas', cls: 'setSelect', where: '工作台设置抽屉（BrowserSettings）' },
    { mod: 'node-card', cls: 'loopFieldSelect', where: '循环节点的设置面板（LoopNode）', use: { file: 'LoopNode.tsx', var: 'css_card' } },
  ]
  let bad = 0
  for (const d of DROPDOWNS) {
    const map = moduleMap(d.mod)
    const hash = map === null ? undefined : map.get(d.cls)
    const label = d.mod + '.' + d.cls + '（' + d.where + '）'
    if (hash === undefined) {
      console.log('  ✗ ' + label + ' → 产物映射表里找不到这个类名（它没被发射）')
      bad += 1
      continue
    }
    /* ⚠️ **还要确认它真的被挂到某个元素上**（2026-10-14 突变测试抓出的假绿）。
     *
     * 只查「产物里有 `.hash option` 规则」是不够的：CSS Modules 的映射表
     * **只要规则写了就一定发射那对 hash↔类名**，与「组件有没有用这个类」无关。
     * 所以把 `className={css_card.loopFieldSelect}` 从 `LoopNode.tsx` 删掉时，
     * 规则仍在产物里、断言照样通过 —— 而用户实际看到的那个下拉又变回默认样式了。
     * 这正是本文件开头记的那类「构建通过、真机上样式失效」。 */
    if (d.use !== undefined) {
      const src = readFileSync(new URL('../src/client/workbench/' + d.use.file, import.meta.url), 'utf8')
      const used = new RegExp('className=\\{' + d.use.var + '\\.' + d.cls + '\\}').test(src)
      console.log('  ' + (used ? '✓' : '✗') + ' ' + label + ' → 组件里**真的挂了这个类**'
        + (used ? '' : '（规则在产物里，但没人用它 = 等于没配色）'))
      if (!used) {
        console.log('     → 要在 ' + d.use.file + ' 的 <select> 上写 className={' + d.use.var + '.' + d.cls + '}')
        bad += 1
      }
    }
    /* 精确匹配「`.hash option` 后面直接是 `,` 或 `{`」——
     * ⚠️ 别用 `[^{]*` 这类宽写法：`option.disabled-fake {` 也会被匹配上，
     * 于是把规则改成永不命中，断言照样通过（**假绿**，突变测试抓出来过一次）。 */
    const esc = hash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const rule = new RegExp('\\.' + esc + ' option\\s*[,{][^{]*\\{([^}]*)\\}').exec(BUNDLE)
    if (rule === null) {
      console.log('  ✗ ' + label + ' → 产物里**没有** option 配色规则'
        + '（这个下拉的未选中项在亮/暗某一侧会看不见）')
      bad += 1
      continue
    }
    const decl = rule[1]
    const hasBg = /background-color:\s*var\(--dsw-/.test(decl)
    const hasColor = /color:\s*var\(--dsw-/.test(decl)
    console.log('  ' + (hasBg && hasColor ? '✓' : '✗') + ' ' + label
      + ' → option 给了底/字色（底:', hasBg ? '有' : '无', '｜ 字:', hasColor ? '有' : '无', '）')
    if (!hasBg || !hasColor) {
      /* ⚠️ 关键词：option 底色不写就是**透明**的，叠在系统弹层上 —— 亮暗总有一边踩空。 */
      console.log('     → 不写的话 option 底色是透明的，亮暗两边总有一边和文字同色。')
      bad += 1
    }
    /* 写死色值也算不合格：换主题就崩（用户要的是跟随主题）。 */
    if (/(?:^|;)\s*(?:background-color|color):\s*#/.test(decl)) {
      console.log('  ✗ ' + label + ' 用了写死的色值（应改用主题令牌，否则换主题就崩）')
      bad += 1
    }
  }
  if (bad > 0) process.exitCode = 1
}

/* ⚠️ 「结论」必须打在**所有检查之后**：原来它在下拉与盒模型两段之前，
 * 那两段红时仍会打印「全部对得上」，与退出码矛盾（2026-10-18 挪到文件末尾）。 */
console.log(process.exitCode === 1 ? '结论：有对不上的地方 ✗' : '结论：全部对得上 ✓')
