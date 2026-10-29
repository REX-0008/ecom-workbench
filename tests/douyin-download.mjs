/** 「抖音表单下载」的下拉两步点击 —— 离线回归。
 *
 * ## 为什么单独一份（不塞进 douyin-logic / douyin-workflow）
 *
 * 这件事的判据全是**结构性的**：哪一段脚本、被判成哪一层、两下点击在不在同一个节点、
 * 落盘校验的顺序对不对。它们与「算日期」「算列表」那些纯逻辑不同，
 * 也与「整条跑不跑得通」不同（那条要起引擎）。
 * 放一起会让人以为改日期逻辑也要跑这里。**盯的是一件事：下拉那两下别被拆开。**
 *
 * ## 背景（2026-10-19）
 *
 * 交易 / 商品列表（`btn: 'dropdown'`）的下载是下拉菜单：先点「下载」出菜单、
 * 再点「下载当前明细」。源码 `douyin-ui.ts:193-195` 是真实鼠标连点两下，
 * 两下之间**没有任何重连** —— 「同一页面会话内不间断」是它的隐含前提。
 *
 * 我们「一个节点 = 一个子进程」。所以：
 *   · 拆成 `browser.act(点开) → browser.download(点菜单项)` **实测必失败**
 *     （第二个节点点的时候下拉已收起，报 `page.click: Timeout 30000ms exceeded`）；
 *   · 唯一可行的是**同一个节点里做完**（这段脚本就是这么写的）。
 *
 * ⚠️ 本测试**不开任何页面**（用户红线）。真机那部分用本地假页面单独验过，
 * 不进套件 —— 它要求「有一个开着调试端口的浏览器」，条件不成立时红的原因与代码无关。
 *
 * 跑法：node tests/douyin-download.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** 累计失败数。 */
let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} [detail] - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const DRIVER = join(ROOT, 'src/nodes/browser/driver.mjs')
const CODE_SRC = join(ROOT, 'scripts/browser/douyin-code.mjs')
const DRIVER_SRC = readFileSync(DRIVER, 'utf8')
const CODE = readFileSync(CODE_SRC, 'utf8')

console.log('=== 抖音下拉两步点击（离线）===')

/* ── ① 生成脚本的结构 ─────────────────────────────────────────── */
console.log('')
console.log('① 下载脚本的结构（这几条一破，dropdown 两个模块就必失败）')
const { downloadDropdown, downloadSingle } = await import('../scripts/browser/douyin-code.mjs')
/* ⚠️ 2026-10-19：一整段脚本拆成**两条分支**（`flow.if` 按 btn 分流）：
 * 下拉两下 vs 单按钮一下。两者共用同一份「公共前后段」，只差点击那几行。
 * 所以下面凡是「两下点击」的断言都锚 `SCRIPT`（dropdown 那条），
 * 「一下点击」的锚 `SINGLE`。 */
const SCRIPT = downloadDropdown('D:/TEST_ROOT/原始数据')
const SINGLE = downloadSingle('D:/TEST_ROOT/原始数据')
{
  /* ★ 这是整份改动的核心理由：两下点击必须在**同一段脚本**里。
   * 若哪天有人把它拆成两个节点，这条会红。
   *
   * ⚠️ 锚到**真实调用**（`await page.locator(triggerSel)...click`），
   * 不锚 `.aurora-dropdown-trigger` 这个选择器串 ——
   * 后者在**定义选择器的那一行**就出现一次，比第一次点击更早，
   * 于是「菜单项在触发器之后」恒真、而「等 1.5 秒在两次点击之间」恒假
   * （第一版就是这么写的，三条断言全锚错位置）。这正是
   * `AGENTS.md` 里「别锚到注释/定义里那串」那条纪律。 */
  const click1 = SCRIPT.indexOf('await page.locator(triggerSel).first().click')
  const click2 = SCRIPT.indexOf('await page.locator(menuSel).first().click')
  check('★ 两下点击在**同一段脚本**里（拆开就必失败）', click1 > 0 && click2 > click1,
    '第1下@' + String(click1) + ' 第2下@' + String(click2))

  /* 照源码：两下之间要等一下让菜单渲染（源码 waitForTimeout(1500)）。
   * ⚠️ 同样锚**真实调用** —— 注释里那串 `waitForTimeout(1500)` 不算。 */
  const wait = SCRIPT.indexOf('await page.waitForTimeout(1500)')
  check('两下之间等 1.5 秒（照源码 waitForTimeout(1500)）',
    wait > click1 && wait < click2,
    'wait@' + String(wait) + '（须在 ' + String(click1) + ' 与 ' + String(click2) + ' 之间）')

  /* 照源码：用 page.click / locator.click（真实鼠标），不用页面内 element.click()。
   * 源码 douyin-ui.ts:192 明写：evaluate 合成点击在这页不触发下拉。 */
  check('★ 用 locator/page 点击（真实鼠标），不是页面内合成点击',
    /await page\.locator\(triggerSel\)\.first\(\)\.click\(/.test(SCRIPT)
    && !/\.click\(\)\s*;/.test(SCRIPT.replace(/await page[^\n]*/g, '')),
    '')
}

/* ── ② 层级判定（它决定这段脚本有没有 page / fs） ────────────── */
console.log('')
console.log('② 层级判定（判错就拿不到 page / node:fs，落盘全废）')
{
  /* ⚠️ **必须从驱动源码里抠出那个函数来验**，不能自己写一份。
   * 这里照 `tests/browser-driver.mjs` 的做法：取出真函数再测。 */
  const m = /const looksLikeDriverScript = \(code\) => \{[\s\S]*?\n  \}/.exec(DRIVER_SRC)
  check('驱动里有层级判据', m !== null)
  if (m !== null) {
    const fn = eval('(' + m[0].replace('const looksLikeDriverScript = ', '') + ')')
    check('★ 下载脚本被判成「驱动层」（必须 true，否则拿不到 page / fs）', fn(SCRIPT) === true)
    /* 反例：页面层脚本不能被判成驱动层（否则会在 Node 里跑、报 location is not defined）。 */
    check('页面层脚本（用 document / location）不被判成驱动层',
      fn('const a = document.querySelector(".x")\nif (location.href) return 1') === false)
  }
}

/* ── ③ 补回 browser.download 原本那四件事 ───────────────────── */
console.log('')
console.log('③ 原 browser.download 提供的四件事，脚本里都补回来了')
{
  /* ① 目录：从循环项拿模块 folder（不是写死一个目录）。 */
  check('目录来自 {{item}} 里的模块 folder', SCRIPT.includes('ps.join(root, String(mod.folder')) 
  check('目录不存在会建（不让落盘因缺目录失败）', SCRIPT.includes('fs.mkdirSync(dir, { recursive: true })'))

  /* ② 同名不覆盖（照老行为：加时间戳）。 */
  const sync = SCRIPT.indexOf('fs.existsSync(file)')
  const save = SCRIPT.indexOf('await dl.saveAs(file)')
  check('★ 同名不覆盖：先查存在、再落盘', sync > 0 && sync < save,
    'existsSync@' + String(sync) + ' saveAs@' + String(save))

  /* ③ 文件名规则照源码 {店铺}-{YYYYMMDD}-{建议名}{后缀}。 */
  check('文件名照源码拼（店铺-日期-建议名+后缀）',
    SCRIPT.includes('const SHOP =') && SCRIPT.includes('date.replace(/-/g, \'\')'))

  /* ④ 落盘校验：saveAs 之后显式 failure()，非 null 就抛。 */
  const fail = SCRIPT.indexOf('await dl.failure()')
  check('★ 落盘后校验（saveAs → failure → 非空就抛）',
    fail > save && SCRIPT.includes('文件可能不完整'), 'failure@' + String(fail))
}

/* ── ④ 中文报错覆盖（不许让用户看到 playwright 英文堆栈） ───── */
console.log('')
console.log('④ 每条失败路径都有中文说明（照 browser.download 的文案风格）')
{
  const paths = [
    ['第 1 下点开菜单失败', '点开下载菜单', SCRIPT],
    ['第 2 下点菜单项失败', '」没点到（', SCRIPT],
    ['单按钮模块点不到', '没点到「下载明细」', SINGLE],
    ['点了但没开始下载', '没有开始下载', SCRIPT],
    ['落盘失败', '没能存到', SCRIPT],
    ['下载中途失败', '文件可能不完整', SCRIPT],
  ]
  for (const [what, needle, inScript] of paths) {
    check('有中文报错：' + what, inScript.includes(needle))
  }
  /* 每条都带「原始信息」—— 中文说原因、英文原文留作排查，两者都要有。 */
  check('中文报错都附「原始信息」（便于排查）',
    (SCRIPT.match(/原始信息/g) ?? []).length >= 4 && SINGLE.includes('原始信息'),
    String((SCRIPT.match(/原始信息/g) ?? []).length) + ' 处（下拉那条）')
}

/* ── ⑤ 两条分支：用 btn 分流，5 个非 dropdown 模块行为不变 ────── */
console.log('')
console.log('⑤ 两条分支按 btn 分流（5 个非 dropdown 模块的行为必须一字不变）')
{
  /* ⚠️ 2026-10-19 改法变了：**不再是「一段脚本内部 if/else」**，
   * 而是画布上 `flow.if` 按 `item.module.btn == 'dropdown'` 分成两条路。
   * 所以这里断言的是「两条脚本各自存在、各自的点击对」，不是「里面有 if」。 */
  check('★ 下拉那条只点下拉（不含单按钮选择器）',
    SCRIPT.includes('.aurora-dropdown-trigger') && !SCRIPT.includes('text=下载明细'))
  check('★ 单按钮那条只点一次（不含下拉选择器）',
    SINGLE.includes('text=下载明细') && !SINGLE.includes('.aurora-dropdown-trigger'))

  /* ★ 单按钮那一条的行为**与改造前逐字一致** —— 这是用户明确要求的。
   * 判据锚真实调用，不锚注释里提到的名字。 */
  check('★ btn=last 取最后一个（照源码 douyin-ui.ts:163 的三元）',
    SINGLE.includes("const pickLast = btn === 'last'")
    && SINGLE.includes('page.locator(oneSel).last()')
    && SINGLE.includes('page.locator(oneSel).first()'))
  check('★ 单按钮那条的点击次数是 1（不是 2）',
    (SINGLE.match(/await target\.click\(/g) ?? []).length === 1,
    String((SINGLE.match(/await target\.click\(/g) ?? []).length) + ' 次')
  check('下拉那条的点击次数是 2',
    (SCRIPT.match(/await page\.locator\((?:triggerSel|menuSel)\)\.first\(\)\.click\(/g) ?? []).length === 2,
    String((SCRIPT.match(/await page\.locator\((?:triggerSel|menuSel)\)\.first\(\)\.click\(/g) ?? []).length) + ' 次')

  /* ★★ 两条的**落盘后半段必须逐字相同** —— 否则「两个分支落盘不一样」必然漂。
   * 拿 saveAs 到 return 那一段直接比字符串。 */
  const tailOf = (s) => s.slice(s.indexOf('/* ⑤ 落盘'))
  check('★★ 两条分支的落盘逻辑逐字相同（只差点击那几行）',
    tailOf(SCRIPT) === tailOf(SINGLE),
    '下拉 ' + String(tailOf(SCRIPT).length) + ' 字符 / 单按钮 ' + String(tailOf(SINGLE).length) + ' 字符')

  /* 数据根仍由生成器一处传入（两条都得带上，不能一条写死）。 */
  check('两条脚本都写入了同一个数据根',
    SCRIPT.includes('D:/TEST_ROOT/原始数据') && SINGLE.includes('D:/TEST_ROOT/原始数据'))
}

/* ── ⑤b ★★ 5 个非 dropdown 模块的点击行为**冻结** ────────────
 *
 * 用户明确要求「那 5 个模块的下载行为一字不变」。口头保证不算数，
 * 所以把**会执行的代码行**原样钉在这里：改了任何一个字符（选择器、
 * `.last()` / `.first()` 的取法、超时时长、报错文案）这条都会红。
 *
 * ⚠️ 只钉**代码行**，不钉注释 —— 注释可以改，行为不能改。
 * ⚠️ 这段是从改造前那一版（git HEAD 的 `dyGrabDownload` 的 else 分支）
 * 逐字抄下来的，两边求值后比对过：**除 `} else {` 的收尾花括号外完全相同**。 */
console.log('')
console.log('⑤b ★★ 5 个非 dropdown 模块的点击行为冻结（用户要求一字不变）')
{
  const codeLines = (s) => s
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '' && !l.startsWith('/*') && !l.startsWith('*') && !l.startsWith('//'))
  const clickPart = SINGLE.slice(
    SINGLE.indexOf('/* ② 触发：一下。 */'),
    SINGLE.indexOf('/* ③ 等下载开始'),
  )
  /* ⚠️ 这张表钉的是**行为**（选择器、取第几个、超时、文案），所以改文案要一起改这里。
   *
   * 2026-10-20 更新过一次：报错文案从「最后/第一 + 个」改成「最后一个/第一个」——
   * 因为拼接出来的「最后个」读着不通顺。**那是真正的改进，不是漂**，
   * 所以这里跟着改，并把这句说明留在上面：下次有人只改文案、忘了这张表，
   * 红的原因会指向这里而不是叫他「别动文案」。 */
  const FROZEN = [
    "const oneSel = 'text=下载明细'",
    "const pickLast = btn === 'last'",
    'try {',
    'const target = pickLast ? page.locator(oneSel).last() : page.locator(oneSel).first()',
    'await target.click({ timeout: 30000 })',
    '} catch (e) {',
    "throw new Error('没点到「下载明细」（' + oneSel + '，取'",
    "+ (pickLast ? '最后一个' : '第一个') + '）。'",
    "+ '检查选择器是否还对得上那个按钮（页面改版常失效）。原始信息：'",
    "+ String(e?.message ?? e).split('\\n')[0].slice(0, 100))",
    '}',
  ]
  const actual = codeLines(clickPart)
  const same = JSON.stringify(actual) === JSON.stringify(FROZEN)
  if (same) {
    check('★★ 单按钮分支的代码行与改造前逐字一致', true, String(actual.length) + ' 行')
  } else {
    const at = actual.findIndex((l, i) => l !== FROZEN[i])
    check('★★ 单按钮分支的代码行与改造前逐字一致', false,
      actual.length !== FROZEN.length
        ? '行数 ' + String(actual.length) + ' ≠ ' + String(FROZEN.length)
        : '第 ' + String(at + 1) + ' 行不同：' + JSON.stringify(actual[at]) + ' ≠ ' + JSON.stringify(FROZEN[at]))
  }
  /* 选择器与取法各自单独再钉一次 —— 这两条一旦漂，症状是「点了个不下数据的按钮」。 */
  check('★★ 选择器仍是 text=下载明细', actual.includes("const oneSel = 'text=下载明细'"))
  check('★★ btn=last 仍取最后一个', actual.some(l => l.includes('pickLast ? page.locator(oneSel).last() : page.locator(oneSel).first()')))
}

/* ── ⑥ 模块表与生成器的一致性 ───────────────────────────────── */
console.log('')
console.log('⑥ 模块表 / 生成器 / 工作流三者一致')
{
  const { DY_MODULES } = await import('../scripts/browser/douyin-code.mjs')
  const dd = DY_MODULES.filter(m => m.btn === 'dropdown').map(m => m.name).sort()
  check('★ 恰好 2 个 dropdown 模块（交易 / 商品列表）',
    dd.length === 2 && dd.join(',') === '交易,商品列表', dd.join(','))
  const others = DY_MODULES.filter(m => m.btn !== 'dropdown')
  check('其余 5 个是单次点击', others.length === 5, others.map(m => m.btn).join(','))

  /* 生成器要把**函数**传进来（不是算好的字符串）—— 数据根只该有一处来源。 */
  const buildSrc = readFileSync(join(ROOT, 'scripts/browser/build-douyin.mjs'), 'utf8')
  check('生成器用同一个 dataRoot 生成两条脚本（数据根只有一处来源）',
    /code\.downloadDropdown\(fwd\(dataRoot\)\)/.test(buildSrc)
    && /code\.downloadSingle\(fwd\(dataRoot\)\)/.test(buildSrc))
  /* ⚠️ 断言「那一步的节点类型」要避开中间那些注释行。 */
  const dlNode = (title) => new RegExp(
    "b\\.add\\('browser\\.act',\\s*\\{[\\s\\S]{0,600}?'" + title).test(buildSrc)
  check('生成器里 ④b1 是 browser.act 的 eval',
    dlNode('④b1 两步点击') && /action: 'eval'/.test(buildSrc))
  check('生成器里 ④b2 也是 browser.act 的 eval（不是 browser.download）',
    /b\.add\('browser\.act',\s*\{[\s\S]{0,600}?code: code\.downloadSingle\(fwd\(dataRoot\)\)[\s\S]{0,200}?'④b2 一次点击/.test(buildSrc))
  check('存档里不再生成 browser.download 节点', !/b\.add\('browser\.download'/.test(buildSrc))
  /* ★ ④b 那个条件判断必须真的存在，且左边选的是**循环变量**（不是某个节点字段）。 */
  check('★ 生成器里 ④b 是 flow.if，左边选循环变量 item.module.btn',
    /b\.add\('flow\.if',\s*\{[\s\S]{0,400}?kind: 'loop', name: 'item\.module\.btn'/.test(buildSrc)
    && /op: 'is',\s*value: 'dropdown'/.test(buildSrc))
}

/* ── ⑦ 生成出来存档里的实际节点 ─────────────────────────────── */
console.log('')
console.log('⑦ 存档里的实际节点（要跑过生成器才看得到）')
{
  const WF = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench',
    'workflows', '取数-抖音电商罗盘.json')
  if (!existsSync(WF)) {
    /* 没生成过就**跳过而不是判失败**：存档是构建产物，不随仓库走。
     * 但要说清「跳过了」，不能静默当通过。 */
    console.log('  （跳过：找不到存档，先跑 scripts/build-patrol-workflows.mjs）')
  } else {
    const doc = JSON.parse(readFileSync(WF, 'utf8'))
    check('★ 存档里没有 browser.download 节点（两个分支都走脚本）',
      !doc.nodes.some(n => n.defId === 'browser.download'))
    /* 按**标题**找，不按 id —— id 会随节点增删变，标题是给人看的、稳定。 */
    const byLabel = (prefix) => doc.nodes.find(n => String(n.label ?? '').startsWith(prefix))
    const b1 = byLabel('④b1 两步点击')
    const b2 = byLabel('④b2 一次点击')
    check('★ 存档里有 ④b1（dropdown 分支）',
      b1 !== undefined && b1.defId === 'browser.act' && b1.params.action === 'eval')
    check('★ 存档里有 ④b2（单按钮分支）',
      b2 !== undefined && b2.defId === 'browser.act' && b2.params.action === 'eval')
    check('④b1 的脚本里有两步点击的选择器',
      b1 !== undefined && String(b1.params.code).includes('.aurora-dropdown-trigger')
      && String(b1.params.code).includes('.aurora-dropdown-menu-title-content'))
    check('④b2 的脚本里是单按钮选择器（text=下载明细）',
      b2 !== undefined && String(b2.params.code).includes('text=下载明细'))

    /* ★ 循环体的**关键成员都在**（不数总数 —— 2026-10-20 修）。
     *
     * ⚠️ 原来写的是 `inB.length === 6`，而 2026-10-20 加了「④e 日期间歇」
     * 之后变成 7，于是这条红 —— 但**功能是对的**，是断言把「节点数」当成了规格。
     * `AGENTS.md` 里点过这个坑（tmall 那份也犯过），所以改成判**形状**：
     * 每个该在的成员按 label 找得到，且不再关心多一个少一个。
     *
     * 真正要守的是「结构与分支关系」，那几条上面已经逐条断言了。 */
    const loopB = byLabel('③ 循环 B')
    const inB = doc.nodes.filter(n => n.parentId === loopB?.id)
    const labelsB = inB.map(n => String(n.label ?? ''))
    const needB = ['设日期', '两步点击', '一次点击', '拼文件名', '本轮结果']
    for (const kw of needB) {
      check('★ 循环B 里有「' + kw + '」这一步', labelsB.some(l => l.includes(kw)), labelsB.join(' / '))
    }
    check('★ 循环B 里有反爬间隔（日期间歇）', labelsB.some(l => l.includes('间歇')), labelsB.join(' / '))
    /* 归属关系本身也要成立（这比数数更能说明「嵌对了」）。 */
    check('★★ 循环B 的成员 parentId 都指向循环B',
      inB.every(n => n.parentId === loopB?.id), String(inB.length) + ' 个成员')
  }
}

/* ── ⑧ 红线：scripts 的字符串字面量里不许有 `**` ─────────────── */
console.log('')
console.log('⑧ 红线检查')
{
  /* 这条与 `copy-no-markdown` 重复，但**在这里再挡一次**是有意的：
   * 本文件新增了一大段生成脚本文本，最容易顺手把注释里的 `**` 抄进字符串。
   * ⚠️ 只查**单双引号字符串**（与 copy-no-markdown 对 scripts 的尺子一致）；
   * 反引号串里是代码正文，不算画布文案。 */
  const stringHits = [...CODE.matchAll(/'([^'\\\n]|\\.)*'|"([^"\\\n]|\\.)*"/g)]
    .filter(m => m[0].includes('**'))
  check('生成器脚本正文里没有 `**` 字面量', stringHits.length === 0,
    stringHits.length === 0 ? '' : stringHits[0][0].slice(0, 60))
}

console.log('')
console.log(failed === 0
  ? '结论：下拉两步点击的结构与四项补偿都成立 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
