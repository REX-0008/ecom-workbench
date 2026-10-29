/** 浏览器驱动（`src/nodes/browser/driver.mjs`）的**离线**测试。
 *
 * ## 为什么是离线的
 *
 * 真机验证（连真浏览器、开真窗口）已经做过，但它**不能进测试套件**：
 * 它要求「用户开着带调试端口的浏览器」，别人跑、以后跑都可能不成立，
 * 那样测试会红，而红的原因与代码无关 —— 那种测试最后只会被人忽略。
 *
 * 所以这里测**不需要浏览器就能测的部分**，也就是最容易错、最难查的部分：
 *   ① 会话登记表的读写与自愈（跨节点复用的核心机制）
 *   ② 各种「说不清就静默失败」的错误路径必须**明确报错**
 *   ③ 驱动脚本的语法与结构（动作齐全、不偷偷关用户浏览器、**端口无默认值**）
 *
 * ⚠️ **2026-10-14 起「离线」这条要求更严了**（用户 #7 改造的直接后果）：
 * 从前「不传端口」时驱动会连**写死的 9222**，而本机 9222 上通常真开着用户的浏览器
 * —— 于是这个「离线测试」其实会**碰用户的真浏览器**（虽然只做读操作）。
 * 端口没有默认值之后它不再可能发生。**新增断言时不要再引入「会真连上」的用例。**
 *
 * 真机那部分记在 `plans/工作流基础-2026-10-12-02-节点目录化与浏览器层.md`。
 *
 * 跑法：node tests/browser-driver.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** 累计失败数。 */
let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\//, '')
const DRIVER = ROOT + 'src/nodes/browser/driver.mjs'
const SRC = readFileSync(DRIVER, 'utf8')

console.log('=== 浏览器驱动（离线）===')

console.log('')
console.log('① 驱动脚本结构')
{
  check('语法合法（node --check）', (() => {
    try { execFileSync('node', ['--check', DRIVER], { stdio: 'ignore' }); return true } catch { return false }
  })())
  /* 七个动作都要在（少一个的表现是「下拉里有、点了报不认识」）。 */
  for (const a of ['goto', 'click', 'input', 'text', 'screenshot', 'eval', 'download']) {
    check('有 ' + a + ' 动作', new RegExp("case '" + a + "'").test(SRC))
  }
  /* ⚠️ 动作集合在驱动里**枚举了三处**（KNOWN / validateParams / run 的 switch），
   * 少写一处就会出现「下拉可选、点了报不认识」或「校验放行、执行时才炸」。
   * 这里查三处**一致**（不一致就是漏改了）。 */
  {
    const known = /const KNOWN = \[([^\]]+)\]/.exec(SRC)?.[1] ?? ''
    const list = [...known.matchAll(/'([^']+)'/g)].map(m => m[1]).sort()
    check('动作清单与 switch 分支一致（改动作时别漏）',
      list.length === 7 && SRC.includes("case 'download': return await actDownload"),
      list.join(','))
  }
  /* ⚠️ **下载必须先挂监听再触发**（官方明确要求，见节点说明）。
   * 反了会丢事件，且**这一步不报错** —— 只表现为「永远等不到下载」。
   * 断言用 `page.click(` 这个**调用**（不带引号参数），
   * 免得锚到具体某个参数写法上（我第一版锚了完整调用串，改动后锚不到）。 */
  {
    const waitAt = SRC.indexOf("const waiter = page.waitForEvent('download'")
    const clickAt = SRC.indexOf('await page.click(selector')
    check('下载先挂监听、再点击（顺序反了会静默丢事件）',
      waitAt > 0 && clickAt > 0 && waitAt < clickAt,
      'waitForEvent@' + String(waitAt) + ' click@' + String(clickAt))
  }
  /* 下载落盘必须**当场做**（CDP 远程连接下 path() 抛错、临时文件随上下文消失）。 */
  check('下载当场 saveAs（不能留到别的节点）', /await download\.saveAs\(file\)/.test(SRC))
  check('下载失败会报出来（不留残缺文件当成功）', /download\.failure\(\)/.test(SRC))
  /* ⚠️ 红线：**绝不能**关掉用户的浏览器。只允许 browser.close()（那是断连接）。
   * 这条要是破了，后果是用户浏览器被关、所有登录态相关的工作流全断。 */
  const hasKill = /\.close\(\)\s*;?\s*\/\*\s*kill|\bkillBrowser|process\.kill/.test(SRC)
  check('没有杀浏览器进程的代码', !hasKill)
  /* 断连接必须存在且**只是**断连接（实测过 close() 不关浏览器）。 */
  check('收尾时断连接（不是关浏览器）', /browser\.close\(\)/.test(SRC))
}

console.log('')
console.log('② 会话登记表：跨节点复用的核心机制')
{
  /* 沙箱：照项目约定走 `EWB_TEST_HOME`（AGENTS.md「运行文件」：它优先于一切），
   * 而**不是**在仓库里建临时目录 ——
   * 那样既是「临时文件落源码目录」（违反根 AGENTS.md 红线 4），
   * 又绕过了 EWB_TEST_HOME 这道统一沙箱（第一版就是这么写的，已修）。
   *
   * ⚠️ 驱动是**独立子进程**，它读的是 `DSH_HOME`（不是 EWB_TEST_HOME）——
   * 因为部署后的驱动拿不到测试变量。所以这里把 `DSH_HOME` 指到 EWB_TEST_HOME 下，
   * 让「测试沙箱」对子进程也成立。 */
  const HOME = process.env.EWB_TEST_HOME ?? join(ROOT, '.tmp-browser-test')
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(join(HOME, 'profiles', 'test', 'data', 'ecom-workbench', 'browser'), { recursive: true })
  const TABS = join(HOME, 'profiles', 'test', 'data', 'ecom-workbench', 'browser', 'browser-tabs.json')

  /** 用沙箱环境跑驱动。 */
  const run = (payload) => {
    try {
      const out = execFileSync('node', [DRIVER, JSON.stringify(payload)], {
        cwd: ROOT, encoding: 'utf8',
        env: { ...process.env, DSH_HOME: HOME, DSH_PROFILE: 'test' },
      })
      return { code: 0, json: JSON.parse(out.trim().split('\n').filter(l => l.trim() !== '').pop()) }
    } catch (e) {
      const raw = String(e.stdout ?? '')
      let json = null
      try { json = JSON.parse(raw.trim().split('\n').filter(l => l.trim() !== '').pop()) } catch { /* ignore */ }
      return { code: e.status ?? 1, json }
    }
  }

  /* 没有页面时的动作必须**明确报错并说怎么修**，不许静默开空白窗口。
   *
   * ⚠️ **2026-10-14 起这个块分两条断言**（用户 #7 改造的直接后果）：
   *
   * 原来「不传端口」时驱动会去连写死的 9222 —— 而本机 9222 上通常**真开着**
   * 用户那个带调试端口的浏览器，于是这条断言实际上是在**连用户的真浏览器**，
   * 只是恰好只能走到「会话里没有页面」那一支（它只做 `Target.getTargets` 读操作）。
   * 也就是说：这条测试**依赖用户开着浏览器**，而本文件开头明确说过这类测试不能进套件。
   *
   * 现在端口**没有默认值**了，所以「不传端口」会停在**更早、更明确**的一步 ——
   * 那正是用户要的「不填端口时的行为有明确定义」。于是：
   *   ① 不传端口 → 必须是「没填端口」+ 说清怎么办（**离线、确定**）
   *   ② 传一个没人听的端口 → 必须是「连不上 :端口」（**离线、确定**）
   *
   * ⚠️ 原先那条「报错里指出先接『打开页面』」的断言**已移除**：它要求真的连上一个
   * 浏览器才能到达那一支，而「真的连上」= 依赖用户开着浏览器（不稳定、且会碰真机）。
   * 「会话里没有页面」那句话仍在驱动里（见 `findSessionPage` 那段），
   * 但它的验证属于**真机验证**，不属于本离线套件。 */
  const noPort = run({ action: 'text', session: { name: '空会话' }, params: { selector: 'body' } })
  check('不填端口时明确报错（不猜端口、不私连 9222）', noPort.json?.ok === false,
    JSON.stringify(noPort.json).slice(0, 80))
  check('★ 报错指出「没填端口」并说清在哪填',
    String(noPort.json?.error ?? '').includes('没有填调试端口')
    && String(noPort.json?.error ?? '').includes('浏览器'),
    String(noPort.json?.error ?? '').slice(0, 60))
  check('★ 报错里**不出现**任何写死的端口号（不把硬编码藏进文案）',
    !/9222|127\.0\.0\.1/.test(String(noPort.json?.error ?? '')),
    String(noPort.json?.error ?? '').slice(0, 60))

  /* 传一个**确定没人听**的端口（1 号端口本机不会有人占）：必须报「连不上 :1」。 */
  const deadPort = run({ action: 'text', session: { name: '空会话', port: '1' }, params: { selector: 'body' } })
  check('端口没人听时明确报错（带上那个端口号）',
    deadPort.json?.ok === false && String(deadPort.json?.error ?? '').includes(':1'),
    String(deadPort.json?.error ?? '').slice(0, 60))

  /* 报错**不该**顺手建登记表（那说明它偷偷开了窗口）。 */
  const tableAfter = existsSync(TABS) ? JSON.parse(readFileSync(TABS, 'utf8')) : { sessions: {} }
  check('没页面时不会偷偷建登记', (tableAfter.sessions?.['空会话'] ?? []).length === 0)

  /* 非法动作：明确报错，且**列出可选动作**（否则用户不知道写什么）。 */
  const bad = run({ action: 'no.such', session: { name: 'x' }, params: {} })
  check('非法动作明确报错', bad.json?.ok === false)
  check('报错里列出可选动作', String(bad.json?.error ?? '').includes('goto / click'), String(bad.json?.error ?? '').slice(0, 70))

  /* 缺参数的必填项：也要明确报错（不能拿空选择器去点）。 */
  const noSel = run({ action: 'click', session: { name: 'x' }, params: {} })
  check('没填目标元素时明确报错', String(noSel.json?.error ?? '').includes('没填'), String(noSel.json?.error ?? '').slice(0, 40))

  /* 非法 JSON：入口要挡住，而不是崩。 */
  check('非法 JSON 被挡住（不崩）', (() => {
    try {
      execFileSync('node', [DRIVER, '{not json'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, DSH_HOME: HOME } })
      return false
    } catch (e) {
      const raw = String(e.stdout ?? '')
      return raw.includes('不是合法 JSON')
    }
  })())

  rmSync(HOME, { recursive: true, force: true })
}

console.log('')
console.log('③ 结构约定（防「以后改坏」）')
{
  /* 「打开页面」是链条的头，它开的窗口**必须留着**给下游用。
   * 第一版在这里错过：goto 用完即关 → 下游永远找不到页面。
   * 断言方式：驱动里不该有「按 reused 决定关不关」那种逻辑残留。 */
  check('不复用「用完即关」的错误逻辑', !/if\s*\(own\s*!==\s*null\s*&&\s*own\.reused\s*!==\s*true\)\s*await\s+closeOwnWindow/.test(SRC))
  /* 复用查找必须存在（否则每个节点各开一个窗口）——
   * 断言「被调用」，不是「定义存在」（见上面那条的说明）。 */
  check('有会话页面复用查找', /await findSessionPage\(browser, session\)/.test(SRC))
  /* 自愈必须存在（否则浏览器关掉后登记的 id 永远失效）。 */
  check('登记表会自愈（剔除已消失的）', /alive\.length\s*!==\s*list\.length/.test(SRC))
  /* 不可见元素要能取到（我们开的是最小化窗口 —— 等 visible 会超时）。
   * ⚠️ 断言必须锚到**真实调用**，不能只查 `state: 'attached'` 存在：
   * 那句在注释里也出现过一次，只查存在的话把选项删掉它照样通过（实测假绿）。 */
  check('取文本不等「可见」（最小化窗口里等不到）',
    /waitForSelector\(selector,\s*\{\s*timeout:[^}]*state:\s*'attached'/.test(SRC))
  /* 页面脚本要在**页面里**跑（不是 Node 进程里）。
   * 第一版用 new Function 在驱动里跑 → `document is not defined`。
   * ⚠️ 同理锚到赋值语句（`page.evaluate` 在注释里还出现过两次）。 */
  check('页面脚本在页面上下文里执行', /result = await own\.page\.evaluate\(/.test(SRC))
  /* ⚠️ 脚本层级判据**不能把 `.page.xxx` 当标识符**。
   * 第一版用 `\b(?:page|context|browser)\s*\.`，于是
   * `document.querySelector('.page.active')` 被误判成驱动层脚本 →
   * 在 Node 里跑 → `document is not defined`（正是这功能最容易踩的错）。
   *
   * ⚠️⚠️ 第二版**仍然错**，2026-10-19 真机抓出来：它没剔除注释。
   * 抖音「读已结算日」那段脚本的**注释**里写着
   * `page.waitForSelector(picker, 20000)`（解释「源码那步在 playwright 层、
   * 我们改成页面内轮询」），就这一句注释让判据命中 → 整段页面脚本被送进
   * Node 跑 → 报 **`location is not defined`**（错指向的位置完全无关）。
   *
   * ⚠️ **必须从驱动源码里取出那个函数来验，不能自己写死一份**。
   * 第一版就是 hardcode 了「正确」的正则去测样本，
   * 于是**把驱动改成错的它照样通过**（自我满足的假断言，实测白验一次）。
   * 现在从 `SRC` 里抠出 `looksLikeDriverScript` 的函数体、`eval` 成真函数再测。 */
  {
    const m = /const looksLikeDriverScript = \(code\) => \{[\s\S]*?\n  \}/.exec(SRC)
    const cases = [
      /* 页面层（不能判成驱动层）—— 这是真机踩到的那一条。 */
      ['/** 源码是 page.waitForSelector(picker, 20000)，我们改成轮询 */\nconst x = document.querySelector("a")\nif (location.href) return 1', false],
      ['// page.goto 在这里用不着\nconst a = 1', false],
      ["document.querySelector('.page.active')", false],
      ["document.querySelector('.browser-icon').click()", false],
      ['const s = `page.goto`', false],
      ['return document.title', false],
      /* 驱动层（必须判成驱动层）。 */
      ['return await page.title()', true],
      ['await context.newPage()', true],
      ['const u = "http://a/b"\nawait page.goto(u)', true],
    ]
    if (m === null) {
      check('脚本层级判据存在', false, '源码里找不到 looksLikeDriverScript 的定义')
    } else {
      /* 把 `const looksLikeDriverScript = (code) => { ... }` 换成匿名函数再 eval。
       * 取不出来就判失败（别静默跳过 —— 那会变成永远的绿）。 */
      let fn = null
      try {
        const body = m[0].replace(/^const looksLikeDriverScript = /, '')
        fn = eval('(' + body + ')')
      } catch { /* 下面判失败 */ }
      const wrong = fn === null
        ? cases.map(c => c[0])
        : cases.filter(([src, want]) => fn(src) !== want)
      check('脚本层级判据剔除注释与字符串后才判（注释里的 page. 不算）',
        wrong.length === 0,
        wrong.length === 0 ? '' : ('判错：' + wrong.map(c => c[0].slice(0, 44)).join(' | ')))
    }
  }
  /* 会话页面复用必须真的被调用（只定义不调用 = 每个节点各开一个窗口）。
   * ⚠️ 同理：`findSessionPage` 在定义处、注释里都出现，必须锚到 `await` 调用。 */
  check('会话页面复用被真的调用', /await findSessionPage\(browser, session\)/.test(SRC))
}

console.log('')
console.log('⑨ 三种启动方式（用户 2026-10-13 定的第二层）')
{
  /* 第二层：`cdp` / `headed` / `headless`。三种都要在，且有明确分工。 */
  check('有 openBrowser（按方式开浏览器）', /async function openBrowser\(session\)/.test(SRC))
  check('cdp 走 connectOverCDP', /connectOverCDP\(/.test(SRC))
  check('有 headed / headless 走 launch', /chromium\.launch\(/.test(SRC))
  check('headless 真的把 headless 传下去', /headless:\s*kind === 'headless'/.test(SRC))
  check('可执行文件路径只在给了的时候才传（否则用 playwright 自带的）',
    /exePath !== undefined/.test(SRC) && /opts\.executablePath/.test(SRC))

  /* ⚠️ **关键区分**（我在这踩过坑）：
   *   - cdp：只断连接，**绝不关浏览器**（用户的浏览器、登录态是资产）
   *   - headed/headless：是**我们启的**，跑完必须关（否则每次泄漏一个进程）
   * 两条方向相反，代码里必须分开 —— 合成一条就是 bug。 */
  check('★ 自己启的浏览器会被关掉（owned 分支）',
    /if \(opened\.owned\)/.test(SRC))
  /* ⚠️ 判据要**锚到 finally 里那一处** —— 文件里有多个 `opened.owned`：
   * 错误提示那条在前、收尾那条在后。用 `} finally {` 定位才不会误命中。
   * （第一版就是被错误提示那条救活了 → 假绿。） */
  {
    const fin = SRC.indexOf('} finally {')
    const tail = fin < 0 ? '' : SRC.slice(fin)
    check('★ 收尾处把 owned 与 cdp **分开**处理（不是一律 close）',
      /if \(opened\.owned\)[\s\S]{0,600}?await browser\.close\(\)[\s\S]{0,300}?\}\s*else\s*\{[\s\S]{0,300}?await browser\.close\(\)/.test(tail),
      fin < 0 ? '找不到 finally' : '')
  }
  check('不杀用户浏览器的纪律仍在（没有 browserType 的 kill/关闭用户进程）',
    !/taskkill|process\.kill\(.*browser/i.test(SRC))
  /* ⚠️ 实测抓到的 bug：`launch` 出来的浏览器**一个 context 都没有**，
   * 要先 `newContext()`；否则报「连上的浏览器里没有可用的上下文」——
   * 而那时浏览器其实**已经起来了**（错在没建 context，不是启动失败）。
   * 这个坑真实发生过，钉住它。 */
  check('★ 自己启的浏览器会先建 context（否则报「contexts 为空」）',
    /opened\.owned \? await browser\.newContext\(\)/.test(SRC))
  check('openOwnWindow 接受「自己启的」context 覆盖',
    /async function openOwnWindow\(browser, ctxOverride\)/.test(SRC))

  /* ── ★ CDP 端口：**手填，不硬编码**（用户 2026-10-14 #7）──────────────
   *
   * 用户原话：「我希望 **9222 这个不是默认而是前端可见的手填项目**，
   * **不能是硬编码的**。」
   *
   * 判据是**行为**：端口只从 `session.port` 来，且**没有兜底默认值**。
   * ⚠️ 断言不能只查「源码里没有 9222 字样」——那样改成 `const P = 9*1000+222`
   * 或从别处读一个默认值都能通过。所以查的是**「没有任何 `?? 默认` 兜底」**。 */
  check('★ 驱动里没有端口默认值常量（`DEFAULT_PORT = 9222` 那类）',
    !/DEFAULT_PORT/.test(SRC))
  /* ⚠️ 断言的是**性质**不是写法：端口只从 `session.port` 来，
   * 且**任何地方都没有拿数字当兜底**（`?? 9222` / `|| 9222`）。
   * 上一版这条锚了 `const port = ...session?.port` 的确切写法 ——
   * 换了等价的写法（先取 `raw` 再判空）就误报红。测试不该绑语法。 */
  check('★ 端口从 session.port 取', /session\?\.port/.test(SRC))
  check('★ 没有任何数字兜底（不把硬编码藏进 `??` / `||`）',
    !/session\?\.port\s*(\?\?|\|\|)\s*\d/.test(SRC)
    && !/(\?\?|\|\|)\s*\d{4}\b/.test(SRC),
    ((/(\?\?|\|\|)\s*\d{4}\b/.exec(SRC) ?? [])[0] ?? ''))
  check('★ 没填端口时明确报错（不静默连别的端口）',
    /没有填调试端口/.test(SRC))
  check('★ 该报错说清了去哪儿填（节点里 / 全局设置里都要提到）',
    /浏览器/.test(SRC) && /端口/.test(SRC) && /检测/.test(SRC))
  /* 连上之后要回报「连的是哪个端口」——排查时靠它。 */
  check('回报里带上实际连的端口', /return \{ browser, kind, owned: false, port \}/.test(SRC))

  /* ⚠️ **架构性事实**：启动式跑完就关，而每个节点是独立子进程 ——
   * 所以启动式**天然不支持多步**。这不是 bug，是架构决定的；
   * 必须给**专门的说明**（实测确认过：单步能跑、第二步报「没有页面」）。 */
  check('★ 启动式多步会报专门说明（不是让人对着「没有页面」猜）',
    /跑完这一步就关了/.test(SRC))
  check('该说明里指出了出路（改用 CDP）', /必须让浏览器常驻/.test(SRC))
  /* 启动式不登记会话表（登记了下次也找不回来 —— 那个进程已经死了）。 */
  check('启动式不登记会话表（登记了会让下次误判「找到了」）',
    /if \(!\(ownedCtx !== null\)\) addTab\(/.test(SRC))
}

console.log('')
console.log(failed === 0 ? '结论：浏览器驱动全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
