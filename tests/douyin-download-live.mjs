/** 抖音取数「点下载」那一步的**真机替身**回归（本地假页面 + 真驱动）。
 *
 * ## 为什么这份要起真浏览器（与 douyin-download.mjs 的分工）
 *
 * `tests/douyin-download.mjs` 钉的是**静态结构**（脚本里有几个 click、顺序对不对、
 * 有没有中文报错）—— 它不开浏览器，所以跑得快、永不 flaky。
 * 但静态断言抓不到一类错：**选择器写对了、程序逻辑却取错了元素**。
 * 例如 `btn: 'last'` 要取最后一个按钮，写成 `.first()` 时
 * 上面那份测试里的「选择器串有没有变」照样通过 —— 只有真的去点一次才知道。
 *
 * 所以这份**在本地假页面上**跑真 `driver.mjs`：起一个带调试端口的 Chrome，
 * 页面是我们自己写的 HTML，**绝不碰抖音 / 天猫**（用户红线）。
 *
 * ## ⚠️ 它不进 `npm test`
 *
 * 与 `browser-driver.mjs` 的理由一样：它要求「能起一个浏览器 + 有 playwright 的 chromium」。
 * 那个条件不成立时红的原因与代码无关，最后只会被人忽略。
 * 需要时单独跑：`node tests/douyin-download-live.mjs`
 *
 * ⚠️ 跑前会自己起、跑完会自己关，**不留后台进程**。
 *
 * 跑法：node tests/douyin-download-live.mjs
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import net from 'node:net'

const require = createRequire(import.meta.url)

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

/**
 * 跳过：环境不满足，**一个断言都没验**。
 *
 * ## 为什么单独一个函数（2026-10-23）
 *
 * 这份测试有 4 处「跳过」（没 playwright / 没 chromium / 端口被占 / 没存档）。
 * 它们全是 `exit(0)` —— 也就是**在运行器眼里等于「通过」**。
 * 原来的输出只有一行普通文字，直接跑的人看到「没有错误行」很容易以为验过了。
 *
 * 所以统一成这个函数，做三件事：
 *   ① 每行都带 `[SKIP]` 前缀 —— 运行器绿的时候也会扫 stdout，能捞出来单独汇总；
 *   ② 末尾再打一句**结论行**，直接跑的人一眼看到「本次没有验证任何断言」；
 *   ③ `exit(0)`（跳过不是失败，与「找不到 chromium 就跳过」同一取舍）。
 *
 * ⚠️ 这也是本轮反复出现的那条纪律：**退出码 0 ≠ 结论成立**。
 *
 * @param reason - 为什么跳过（一句话，说清缺什么）。
 * @param cleanup - 退出前要不要清临时目录。
 * @returns {never} 不返回。
 */
function skip(reason, cleanup = true) {
  console.log('[SKIP] ' + reason)
  console.log('[SKIP] 本次没有验证到任何断言 —— 这是环境问题，不是被测代码失败。')
  if (cleanup) { try { rmSync(TMP, { recursive: true, force: true }) } catch { /* 目录可能还没建 */ } }
  console.log('')
  console.log('结论：跳过（本次没有验证任何断言）')
  process.exit(0)
}

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const DRIVER = join(ROOT, 'src/nodes/browser/driver.mjs')
const TMP = join(process.env.TEMP ?? '/tmp', 'ewb-douyin-live-' + String(process.pid))
const HOME = join(TMP, 'home')
const PAGES = join(TMP, 'page')
/**
 * 临时目录**必须按进程分**（2026-10-23 修，这是那串「假红」的真根因）。
 *
 * ## 原来是什么、为什么坏
 *
 * 原来固定写成 `%TEMP%\ewb-douyin-live`，而下面 `:89` 一开始就
 * `rmSync(TMP, { recursive: true, force: true })` 把整目录删掉重建。
 *
 * 于是**两个人（或两个会话）同时跑这份测试时**：
 *   · A 正在写 `page/two.html`、`page/empty.html`，B 的 `rmSync` 把它删了；
 *   · A 再 `goto` 就报 `ERR_FILE_NOT_FOUND at .../page/two.html`；
 *   · 而 A 的断言只判 `r.json?.ok`，那种形状下偶然成立 → 出现
 *     「前置 ✗ 但主断言 ✓」这种**不可能同时成立**的输出。
 *   · 同理 `out-dropdown` / `out-last` 目录被对面清掉 → 「文件没能存到」。
 *
 * 这不是被测代码的错，也不是「偶发」—— **是两个人共用一份临时目录**。
 *
 * ## 现在怎么分
 *
 * 目录名带上 `process.pid`：每个测试进程独占一份，互不删除。
 * 收尾仍按自己的那份删，不碰别人的。
 */
const PORT = 9489

/* playwright 与驱动用的是同一份（本项目的依赖）。 */
let chromium = null
try {
  ;({ chromium } = require('playwright'))
} catch {
  skip('本机没有 playwright，或没装 chromium —— 这份是真机替身，不进 npm test', false)
}

rmSync(TMP, { recursive: true, force: true })
mkdirSync(PAGES, { recursive: true })
mkdirSync(join(HOME, 'profiles', 'test', 'data', 'ecom-workbench', 'browser'), { recursive: true })

/**
 * 写一个假页面。
 * @param {string} name - 文件名。
 * @param {string} body - 正文（含 script）。
 * @returns {string} `file://` 地址。
 */
function page(name, body) {
  /* ⚠️ 用 utf8 写：中文按钮文案是这些断言的判据，写成 ascii 会变成问号，
   * 于是选择器永远匹配不上、测试红得莫名其妙（踩过一次）。 */
  writeFileSync(join(PAGES, name), '<!doctype html><html><body style="margin:20px">' + body + '</body></html>', 'utf8')
  return 'file:///' + join(PAGES, name).replace(/\\/g, '/')
}

/* ── 三个假页面 ─────────────────────────────────────────────── */

/* ① dropdown：先点「下载」出菜单，再点「下载当前明细」。
 * ⚠️ 照 ant-design 的真实行为加一条：**窗口失焦就收起下拉**。
 * 那条正是「拆成两个节点会失败」的原因（第二个节点重连时下拉已经收起）。 */
const P_DROPDOWN = page('dropdown.html', `
  <div class="aurora-dropdown-trigger" style="border:1px solid #888;padding:8px;width:120px">下载</div>
  <ul id="menu" style="display:none;border:1px solid #888;width:200px">
    <li class="aurora-dropdown-menu-title-content" id="dl-cur">下载当前明细</li>
  </ul>
  <script>
    window.ev = []
    var menu = document.getElementById('menu')
    document.querySelector('.aurora-dropdown-trigger').addEventListener('click', function (e) {
      window.ev.push('trig:' + e.isTrusted)
      if (e.isTrusted) menu.style.display = 'block'
    })
    document.getElementById('dl-cur').addEventListener('click', function (e) {
      window.ev.push('menu:' + e.isTrusted)
      if (!e.isTrusted) return
      var blob = new Blob(['PK fake xlsx'], { type: 'application/vnd.ms-excel' })
      var a = document.createElement('a')
      a.href = URL.createObjectURL(blob); a.download = 'trade.xlsx'
      document.body.appendChild(a); a.click(); a.remove()
    })
    window.addEventListener('blur', function () { window.ev.push('BLUR'); menu.style.display = 'none' })
  </script>`)

/* ② 两个「下载明细」按钮，**只有最后一个**会真下载。
 * 这是 `btn: 'last'` 的判据：取错那个就是点了个不下数据的按钮。 */
const P_TWO = page('two.html', `
  <button style="padding:6px">下载明细</button>
  <button style="padding:6px;margin-left:20px">下载明细</button>
  <script>
    window.ev = []
    var all = document.querySelectorAll('button')
    all[0].addEventListener('click', function (e) { window.ev.push('FIRST:' + e.isTrusted) })
    all[all.length - 1].addEventListener('click', function (e) {
      window.ev.push('LAST:' + e.isTrusted)
      if (!e.isTrusted) return
      var blob = new Blob(['PK fake xlsx'], { type: 'application/vnd.ms-excel' })
      var a = document.createElement('a')
      a.href = URL.createObjectURL(blob); a.download = 'video.xlsx'
      document.body.appendChild(a); a.click(); a.remove()
    })
  </script>`)

/* ③ 一个按钮都没有的页面（验中文报错）。 */
const P_EMPTY = page('empty.html', '<p>没有下载按钮</p>')

/* ── 起浏览器（与真实场景一样：常驻、经 CDP 连）─────────────── */
const EXE = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright', 'chromium-1234', 'chrome-win64', 'chrome.exe')
if (!existsSync(EXE)) {
  skip('找不到 playwright 的 chromium，跳过真机替身')
}

console.log('=== 抖音「点下载」真机替身（本地假页面，不碰抖音/天猫）===')
console.log('')
console.log('① 起一个常驻浏览器（CDP :' + String(PORT) + '）')

/* ── ⓪ 端口占用预检（2026-10-23 加）──────────────────────────────
 *
 * ## 为什么要有这一步
 *
 * 上一次跑（任何原因失败）可能留下一个**孤儿 Chrome**：父进程 `proc.kill()`
 * 只杀掉 node 脚本，浏览器会自己活着继续听端口（见下面 `hostJs` 里那段注释）。
 * 下一次跑到这里，真实情况是「**有人占着**」，但报出来的却是
 * `connect ECONNREFUSED 127.0.0.1:9489` —— 那句指向「连不上」，
 * 方向正好相反，看报错的人会去查驱动代码，白查一轮。
 *
 * ## 这一步做什么
 *
 * 先试连一下：**连得上**说明已经有人在听（多半就是孤儿）→ 明确说清并**提前退出**；
 * 连不上才是正常情况，照原流程起浏览器。
 *
 * ⚠️ **它不是断言**，故意不 `check()`：
 * 端口被占是**环境坏**，不是被测代码错。报成断言红会被当成回归，
 * 而这条测试本来就不进 `npm test`（要真浏览器）。所以：
 *   · 打印一行明确的「本次没验到」，让人知道不是「验过了通过」；
 *   · `exit` 码用 **0**（跳过），与上面「找不到 chromium 就跳过」同一个取舍。
 *
 * ## 怎么判断「连得上」
 *
 * 用 `net.connect` 试一次：`connect` 事件来了就是有东西在听；
 * `error`（ECONNREFUSED）就是没人听。给 800ms，超时也算「没人听」
 * （宁可照常往下跑，也不要因为探测本身慢而误报「被占用」）。
 */
await new Promise((resolve) => {
  const probe = net.connect({ host: '127.0.0.1', port: PORT })
  let settled = false
  /** 收尾（只走一次）。
   * @param occupied - 端口上是否已经有东西在听。
   */
  const done = (occupied) => {
    if (settled) return
    settled = true
    probe.destroy()
    if (occupied) {
      /* ⚠️ 走统一的 `skip()`：每行带 `[SKIP]` 前缀（运行器绿的时候也会扫 stdout），
       * 并在末尾打一句结论行 —— 直接跑的人不会误以为「没输出错误就是过了」。 */
      skip('端口 ' + String(PORT) + ' 已被占用（可能是上一次留下的孤儿 Chrome）。先关掉它，或等几十秒再跑。', false)
    }
    resolve(undefined)
  }
  probe.once('connect', () => { done(true) })
  probe.once('error', () => { done(false) })
  /* 超时按「没人听」处理：探测本身不该把测试卡住。 */
  setTimeout(() => { done(false) }, 800)
})

let proc = null
{
  /* ⚠️ 用一个**子进程**起浏览器，而不是在测试进程里 launch：
   * 驱动连的是 CDP 端口，浏览器必须活到驱动跑完。
   * 用子进程还有一个好处：测试结束时能确定地收掉它（不留后台）。
   *
   * ⚠️⚠️ 子进程**不能靠 cwd 找 playwright**（实测踩到）。
   * 那个脚本放在 TEMP 下，Node 会从**脚本所在目录**往上找 `node_modules`
   * —— TEMP 里没有，于是 `ERR_MODULE_NOT_FOUND: Cannot find package 'playwright'`，
   * 而报错被 spawn 的 stderr 吞掉，表现成「浏览器 20 秒没起来」（一个完全指错方向的错）。
   * 所以这里把**解析好的绝对路径**写进脚本里 import。 */
  const pwPath = require.resolve('playwright').replace(/\\/g, '/')
  const hostJs = join(TMP, 'host.mjs')
  writeFileSync(hostJs, `
    import pw from 'file:///${pwPath}'
    const b = await pw.chromium.launch({
      headless: true,
      executablePath: process.env.LOCALAPPDATA + '\\\\ms-playwright\\\\chromium-1234\\\\chrome-win64\\\\chrome.exe',
      args: ['--remote-debugging-port=${PORT}', '--remote-debugging-address=127.0.0.1'],
    })
    console.log('READY')
    /* ⚠️⚠️ **必须自己收浏览器**，不能只靠父进程 kill 掉这个脚本。
     * 实测：父进程 proc.kill() 只杀掉 node 脚本，**Chrome 会变成孤儿进程活着**，
     * 于是端口一直被占 —— 下一次跑测试就说「连不上 :端口」，
     * 而那个报错与代码毫无关系（我为此白查了一轮）。
     * 所以收到信号时先 browser.close() 再退出。 */
    const bye = async () => {
      try { await b.close() } catch (e) { /* 已经关了就算了 */ }
      process.exit(0)
    }
    process.on('SIGTERM', bye)
    process.on('SIGINT', bye)
    process.on('message', (m) => { if (m === 'bye') bye() })
    setInterval(() => {}, 1 << 30)
  `, 'utf8')
  /* ⚠️ ipc 通道：让父进程能发一条「请收掉」的消息，比 SIGTERM 在 Windows 上可靠。 */
  proc = spawn(process.execPath, [hostJs], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
  /* ⚠️ **兜底**：万一中途抛错、没走到 ⑤ 的收尾，Node 仍会在退出时执行这里。
   * 没有这条的话，一次失败会留下一个占着端口的孤儿 Chrome，
   * **下一次跑又在别的地方报错** —— 那种「一次失败污染后面所有次」最难查。
   *
   * ★ 2026-10-23 补：原来只 `proc.kill()`，那只杀掉**中间那个 node 脚本**，
   * 而浏览器是它 launch 出来的**孙进程**，照样活着占端口。
   * 所以这里再加一道 `killByPort()` —— 按端口找进程连树一起杀。
   * **任何一种退出方式**（正常 / 断言失败 / 未捕获异常 / `process.exit`）
   * 都会走到 exit 回调，所以这一道覆盖住全部路径。
   *
   * ⚠️⚠️ **别在这里注册 SIGINT / SIGTERM / SIGHUP 处理器**（我试过，反而更坏）。
   * 实测对照（同一环境，各跑 3 次）：
   *   · 注册了 signal 处理器 → **3 次里 2 次红**，症状是跑到 ③④ 段时
   *     `connectOverCDP: connect ECONNREFUSED 127.0.0.1:9489` —— 浏览器中途没了；
   *   · 去掉它们 → **3 次全绿**。
   * 原因：一注册就改掉了 Node 在这几条信号上的默认行为，而我那个处理器里
   * `proc.kill()` + `killByPort()` 是无条件跑的 —— 浏览器跟着被带走。
   * 而它想解决的场景（Ctrl+C 时清孤儿）**本来就被下面的 `exit` 回调覆盖**：
   * Node 收到 SIGINT 默认就是退出，退出前照样走 `exit`。
   * **不需要它，就别加它。** */
  process.on('exit', () => {
    try { proc?.kill() } catch { /* ignore */ }
    killByPort()
  })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('浏览器 20 秒没起来')), 20000)
    let err = ''
    /* ⚠️ 把子进程的 stderr 收下来：那句「20 秒没起来」本身指不出任何方向，
     * 真正的答案（找不到包 / 没有 chromium）在 stderr 里。 */
    proc.stderr.on('data', (d) => { err += String(d) })
    proc.stdout.on('data', (d) => { if (String(d).includes('READY')) { clearTimeout(t); resolve() } })
    proc.on('error', (e) => { clearTimeout(t); reject(e) })
    proc.on('exit', (code) => {
      clearTimeout(t)
      reject(new Error('浏览器子进程退出了（' + String(code) + '）：' + err.slice(0, 300)))
    })
  })
  check('浏览器起来了', true)
}

/**
 * 用真驱动跑一次 eval。
 * @param {string} session - 会话名。
 * @param {string} action - goto / eval。
 * @param {object} params - 参数。
 * @returns {{ok: boolean, json: object|null}} 结果。
 */
function runDriver(session, action, params) {
  const payload = JSON.stringify({
    action,
    session: { name: session, launcher: 'cdp', port: String(PORT), exePath: '' },
    params, upstream: [], workdir: TMP,
  })
  try {
    const out = execFileSync(process.execPath, [DRIVER, payload], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, DSH_HOME: HOME, DSH_PROFILE: 'test' },
    })
    const lines = out.trim().split('\n').filter(l => l.trim() !== '')
    return { ok: true, json: JSON.parse(lines[lines.length - 1]) }
  } catch (e) {
    const raw = String(e.stdout ?? '')
    const lines = raw.trim().split('\n').filter(l => l.trim() !== '')
    let json = null
    try { json = JSON.parse(lines[lines.length - 1]) } catch { /* ignore */ }
    return { ok: false, json }
  }
}

/**
 * 存档里「负责下载」那个节点的**标题前缀**。
 *
 * ⚠️ ⚠️ **不要按节点 id 找。同一个坑已经犯过两次。**
 *
 * 第一次（2026-10-19）：这里写死 `n12`，而 t21 重构后 `n12` 变成了别的节点。
 * 当时没报错是因为**它连存档都没找到**（文件名也过期了）→ 走「跳过」分支
 * `exit(0)` → 在测试名单里、统计为通过，**实际一条断言都没跑**。
 * 教训写在 `pitfalls/假防线-看着写了其实不生效.md`。
 *
 * 第二次（2026-10-20）：改成写死 `n13` / `n14` 之后**又坏一次** ——
 * 这一轮「搜索 tab 改成 flow.if」在**循环 A** 里插了一个节点，
 * 于是后面**所有 id 整体后移一格**（下载两支从 n13/n14 变成 n15/n16）。
 *
 * 两次同一个坑，说明判据本身选错了：**节点 id 是「第几个 add 出来的」**，
 * 它天然会随「在别处插一个节点」而变；而**标题是给人看的、稳定**。
 * 所以按标题前缀找，与 `tests/douyin-workflow.mjs` 的 `idOf` 同一做法。
 *
 * @param {'dropdown'|'first'|'last'} btn - 该模块的按钮取法。
 * @returns {string} 节点标题前缀（dropdown 走两下那支，其余走一下那支）。
 */
function downloadLabelFor(btn) {
  /* 两枝是 `flow.if` 分出来的：dropdown 走「两下点击」，其余走「一次点击」。 */
  return btn === 'dropdown' ? '④b1 两步点击' : '④b2 一次点击'
}

/**
 * 把存档里负责下载的脚本按某个模块项实例化（模拟循环变量注入）。
 * @param {object} item - 循环项。
 * @param {string} outRoot - 沙箱数据根。
 * @returns {string|null} 脚本正文；读不到存档时 null。
 */
function scriptFor(item, outRoot) {
  const WF = join(process.env.DSH_HOME ?? '', 'profiles', 'desktop', 'data', 'ecom-workbench',
    'workflows', '取数-抖音电商罗盘.json')
  if (!existsSync(WF)) return null
  const doc = JSON.parse(readFileSync(WF, 'utf8'))
  const prefix = downloadLabelFor(item?.module?.btn)
  const node = doc.nodes.find(n => String(n.label ?? '').startsWith(prefix))
  if (node === undefined) return null
  return String(node.params.code)
    .split('{{item}}').join(JSON.stringify(item))
    .split('D:/ecom-data/原始数据').join(outRoot.replace(/\\/g, '/'))
}

/* ⚠️ 存档是构建产物：没有就先跳过（并说清怎么生成），不静默当通过。 */
const PROBE = scriptFor({ module: { name: 'x', folder: 'x', btn: 'first' }, date: '2026-10-19' }, TMP)
if (PROBE === null) {
  console.log('')
  await stopHost()
  skip('找不到工作流存档，先跑 scripts/build-patrol-workflows.mjs')
}

/* ══════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ 关于这里的**间歇失败**（如实记，不掩盖）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 现在的状态（2026-10-23 更新）
 *
 *  ① **原来记的是「约 1/4 ~ 1/10」**（见下面「历史」）。
 *  ② **2026-10-23 查出一个真根因 + 一个多余机制**：
 *     · **真根因（已修）**：临时目录原来是固定路径 `%TEMP%\ewb-douyin-live`，
 *       两个进程同时跑会互相 `rmSync` 删掉对方的 `page/*.html` —— 直接产生
 *       `ERR_FILE_NOT_FOUND`、以及「前置 ✗ 但主断言 ✓」这种不可能的输出。
 *       现已按 `process.pid` 隔离（见文件头那段说明）。
 *     · **一个多余机制（已删，归因未证实）**：曾加过的 signal 处理器
 *       （`SIGINT`/`SIGTERM`/`SIGHUP` 里无条件 `proc.kill()` + `killByPort()`）
 *       从代码上就多余 —— `exit` + `killByPort()` 已覆盖同一场景。已删除。
 *       ⚠️ 当初那次「3 次里 2 次红 / 去掉后 3 次全绿」的对照是在**有并发**时做的，
 *       样本被污染，**不能归因于它**。
 *  ③ **删后 16 次连跑零失败（我 6 次 + 组长 10 次）**，但要看清三件事：
 *     · 这 16 次里有多少是「删 signal 处理器」的功劳、多少是「临时目录按 pid
 *       隔离」的功劳，**分不开** —— 两处是一起改的；
 *     · **不宣称根治**，样本还不够大。若再复现，按「历史」里那条线索
 *       （CDP 下 `saveAs` 抢下载临时文件）继续查；
 *     · ⚠️ 最要紧：**这份测试用固定端口 9489，任何时候只许一个人跑。**
 *       并发会互相撞端口 +（隔离前）互相删目录，得出的所有结论都不可信。
 *
 * ## 历史（2026-10-20 记，原样保留）
 *
 * 现象：偶尔某一段报 `文件没能存到 …\DemoShop-….xlsx`（就是 `saveAs` 失败）。
 * 频率：约 **1/4 ~ 1/10**，随机落在 ② / ③ 任一段；重跑通常就过。
 *
 * 已经排除的（都是**做过实验**，不是猜）：
 *   · 不是 `saveAs` 本身 —— 同一进程内连做 12 次，0 失败；
 *   · 不是「跨进程连同一个浏览器」—— 照本测试的写法（每轮起新进程）连做 12 次，0 失败；
 *   · 不是脚本逻辑 —— 失败时文件名（含 `-自营` 后缀）已经拼好了，
 *     说明选按钮 / 等下载 / 定名全对，只在最后一步落盘失败。
 *
 * **推断（未证实）**：CDP 远程连接下 `saveAs` 依赖浏览器侧的下载临时文件，
 * 那个文件还没真正落完时去拿会偶发失败 —— 与
 * `src/nodes/browser/download/node.ts` 里记的那条硬约束是同一件事
 * （「临时文件在上下文关闭后就被删掉」）。
 *
 * **为什么不加重试**：加个 `for` 循环把它变绿，等于把真实的偶发盖住，
 * 而这份测试的职责就是暴露它。**若它变频繁，按上面那条线索去查。**
 *
 * ## 另外两个已修的坑（2026-10-23，都会伪装成「间歇失败」）
 *
 * · **临时目录原来固定** `%TEMP%\ewb-douyin-live`，而开头就 `rmSync` 重建 ——
 *   两个人同时跑就互删：对方删掉 `page/two.html` → 这边报
 *   `ERR_FILE_NOT_FOUND`；删掉 `out-*` → 这边报「文件没能存到」。
 *   现在目录名带 `process.pid`，各占一份。
 * · **前置失败时主断言仍可能通过**（`r.json?.ok` 在「连不上」的形状下偶然成立），
 *   于是出现过「前置 ✗ 但主断言 ✓」。现在前置没过就明说「本段未验」。
 *
 * 另：本文件**不在 `npm test` 的名单里**（见文件头），所以偶发红不会污染主套件。
 * ══════════════════════════════════════════════════════════════════════════ */

/* ── ② dropdown：两下点击 + 落盘 ─────────────────────────────── */
console.log('')
console.log('② dropdown 模块（交易）：一个节点里点两下并落盘')
{
  const OUT = join(TMP, 'out-dropdown')
  const code = scriptFor(
    { module: { name: '交易', folder: 'D-店铺-整体-抖音', btn: 'dropdown' }, date: '2026-10-19' },
    OUT,
  )
  /* ⚠️ **goto 的返回值必须检查**。它失败时（浏览器还没完全 ready、端口刚起来）
   * 后面 eval 会报「会话里还没有打开的页面」—— 那是**另一个**错误，
   * 看起来像是脚本坏了，实际只是页面没开成。第一版就这么误导过我一轮。 */
  const g = runDriver('dd', 'goto', { url: P_DROPDOWN, waitUntil: 'load', timeout: 20000 })
  check('（前置）浏览器里有页面可操作', g.json?.ok === true,
    String(g.json?.error ?? '').slice(0, 100))
  const r = runDriver('dd', 'eval', { code, timeout: 120000 })
  check('★ dropdown 一个节点跑通（两下点击在同一进程）',
    r.json?.ok === true, String(r.json?.error ?? '').slice(0, 120))
  /* 真的落盘了，且文件名照源码规则（店铺-日期-原文件名）。 */
  const dir = join(OUT, 'D-店铺-整体-抖音')
  const files = existsSync(dir) ? readdirSync(dir) : []
  check('★ 文件真的落盘', files.length === 1, files.join(','))
  check('★ 文件名照源码（店铺-YYYYMMDD-原名）',
    files[0] === 'DemoShop-20261019-trade.xlsx', files[0] ?? '')
  check('落盘结果里带 pageTitle（给风控护栏用）',
    typeof r.json?.output?.result?.pageTitle === 'string')
}

/* ── ③ btn=last 要取最后一个按钮 ─────────────────────────────── */
console.log('')
console.log('③ btn=last 取最后一个（页面上有两个「下载明细」，只有最后一个会下）')
{
  /* ⚠️⚠️ **这一段见过一次间歇失败**（2026-10-20，如实记，没有掩盖）。
   *
   * 📌 **2026-10-23 更新：现在的最新状态写在上面 ② 段之前那个大框里**
   * （查出过一个放大器 = 已删除的 signal 处理器；删后 16 次连跑零失败；
   * **不宣称根治**）。下面保留的是 2026-10-20 当时的原始记录，不改写。
   *
   * 现象：`saveAs` 报「文件没能存到 …\DemoShop-20261019-video-自营.xlsx」。
   * 频率：**连跑 4 次里 1 次**；之后连跑 11 次全过（包括专门针对这段的 6 次）。
   *
   * 已经排除的（都做过实验，不是猜）：
   *   · 不是 `saveAs` 本身有问题 —— 同一进程内连做 12 次，0 失败；
   *   · 不是「跨进程连同一个浏览器」—— 照测试的写法（每轮起新进程）连做 12 次，0 失败；
   *   · 不是我的脚本逻辑 —— 失败时文件名后缀 `-自营` 已经拼好了，
   *     说明已经走到 `saveAs` 那一步，前面（选按钮、等下载、定名）全对。
   *
   * **推断**（未证实）：CDP 远程连接下 `saveAs` 依赖浏览器侧的下载临时文件，
   * 那个文件在「下载还没真正落完」时去拿会偶发失败 ——
   * 与 `src/nodes/browser/download/node.ts` 里记的那条硬约束是同一件事
   * （*临时文件在上下文关闭后就被删掉*）。
   *
   * **为什么不在这里加重试**：加重试会把一个真实的偶发掩盖掉，
   * 而这条测试的职责就是「暴露问题」。**但如果它越跑越频繁，就该按上面那条线索去查**，
   * 而不是加个 `for` 循环把它变绿。
   *
   * 另：这份测试**不进 `npm test`**（理由见文件头），所以它偶发红不会污染主套件。 */
  const OUT = join(TMP, 'out-last')
  const code = scriptFor(
    { module: { name: '短视频-自营', folder: 'D-店铺-视频-抖音', btn: 'last', fileSuffix: '-自营' }, date: '2026-10-19' },
    OUT,
  )
  const gLast = runDriver('last', 'goto', { url: P_TWO, waitUntil: 'load', timeout: 20000 })
  const lastOpened = gLast.json?.ok === true
  check('（前置）btn=last 那段：页面开成了', lastOpened, String(gLast.json?.error ?? '').slice(0, 100))
  /* ⚠️ 前置失败就**不许**再让后面的断言算通过（2026-10-23 修）。
   * 原来这里是「前置 ✗、主断言 ✓」并列出现 —— 两件事不可能同时成立：
   * 页面根本没打开，eval 当然拿不到结果，`r.json?.ok === true` 只会在
   * 驱动返回了别的形状时偶然成立。那是一条**假绿**。
   * 现在：前置没过就明说「本段未验」，并把该段的断言全部记为失败。 */
  const dir = join(OUT, 'D-店铺-视频-抖音')
  if (!lastOpened) {
    check('★ btn=last 跑通（点到了会下载的那个）', false, '前置未过（页面没打开），本段未验')
    check('★ 落盘了（说明点的是最后一个，不是第一个）', false, '前置未过，本段未验')
    check('★ 后缀 -自营 拼进文件名', false, '前置未过，本段未验')
  } else {
    const r = runDriver('last', 'eval', { code, timeout: 60000 })
    check('★ btn=last 跑通（点到了会下载的那个）',
      r.json?.ok === true, String(r.json?.error ?? '').slice(0, 120))
    const files = existsSync(dir) ? readdirSync(dir) : []
    check('★ 落盘了（说明点的是最后一个，不是第一个）', files.length === 1, files.join(','))
    check('★ 后缀 -自营 拼进文件名', (files[0] ?? '').includes('-自营'), files[0] ?? '')
  }
}

/* ── ④ 中文报错（不是英文堆栈） ─────────────────────────────── */
console.log('')
console.log('④ 点不到时报中文（用户能看懂的那种）')
{
  const OUT = join(TMP, 'out-err')

  /* ★ 把「点不到」那两段的点击超时调短（2026-10-26 加）。
   *
   * ## 为什么可以改、为什么只在这两段改
   *
   * 本段验的是**报错文案**（「第 1 下…点开下载菜单」/「没点到「下载明细」」，
   * 以及里面那句中文排查方向）—— 与「Playwright 找了多久元素」毫无关系。
   * 而存档里的点击写的是 `click({ timeout: 30000 })`：页面上**没有**那个按钮时，
   * 这两段各要**实打实等满 30 秒**才抛错。两段合计 60 秒，占这份测试 73 秒的一大半，
   * 而那 60 秒**什么都没验**（没有任何断言在判超时值）。
   *
   * 所以只把**这两段**用的脚本里 `timeout: 30000` 换成 3000 —— 断言验的文案
   * 一个字没变，等待从 60 秒变 6 秒。
   *
   * ⚠️ 只在这两段做：② / ③ 是「点得到」的正常路径，那里的 30 秒是**真容错**
   * （页面慢一点时不该假红），不许动。
   *
   * ⚠️ 别把这条换成「删掉等待」：3000ms 仍然给了元素出现的机会，
   * 只是把「确定不存在」的确认时间缩短。 */
  const shortenClick = (code) => String(code).split('timeout: 30000').join('timeout: 3000')

  const dd = shortenClick(scriptFor({ module: { name: '交易', folder: 'x', btn: 'dropdown' }, date: '2026-10-19' }, OUT))
  const gE1 = runDriver('e1', 'goto', { url: P_EMPTY, waitUntil: 'load', timeout: 20000 })
  const e1Opened = gE1.json?.ok === true
  check('（前置）报错段：页面开成了', e1Opened, String(gE1.json?.error ?? '').slice(0, 100))
  if (!e1Opened) {
    /* 同上：前置没过，本段的两条断言不许算通过。 */
    check('★ dropdown 点不到 → 报「第 1 下…点开下载菜单」', false, '前置未过（页面没打开），本段未验')
    check('★ 报错里有中文排查方向（不是只有英文堆栈）', false, '前置未过，本段未验')
  } else {
    const r1 = runDriver('e1', 'eval', { code: dd, timeout: 60000 })
    check('★ dropdown 点不到 → 报「第 1 下…点开下载菜单」',
      String(r1.json?.error ?? '').includes('点开下载菜单'), String(r1.json?.error ?? '').slice(0, 80))
    check('★ 报错里有中文排查方向（不是只有英文堆栈）',
      /检查页面上还有没有|选择器是否还/.test(String(r1.json?.error ?? '')))
  }

  const one = shortenClick(scriptFor({ module: { name: '直播', folder: 'x', btn: 'first' }, date: '2026-10-19' }, OUT))
  /* ⚠️ 换会话就必须先 goto：驱动只认「这个会话登记过哪个页面」，
   * 没登记就报「会话里还没有打开的页面」——那是**另一个**错误，
   * 会让这条断言看起来「没过」而真实原因与选择器无关（第一版就是这么错的）。 */
  const gE2 = runDriver('e2', 'goto', { url: P_EMPTY, waitUntil: 'load', timeout: 20000 })
  const e2Opened = gE2.json?.ok === true
  check('（前置）单按钮报错段：页面开成了', e2Opened, String(gE2.json?.error ?? '').slice(0, 100))
  if (!e2Opened) {
    check('★ 单按钮点不到 → 报「没点到下载明细」', false, '前置未过（页面没打开），本段未验')
    check('单按钮的报错也说明取的是第几个', false, '前置未过，本段未验')
  } else {
    const r2 = runDriver('e2', 'eval', { code: one, timeout: 60000 })
    check('★ 单按钮点不到 → 报「没点到下载明细」',
      String(r2.json?.error ?? '').includes('没点到「下载明细」'), String(r2.json?.error ?? '').slice(0, 80))
    check('单按钮的报错也说明取的是第几个', /取第一个|取最后一个/.test(String(r2.json?.error ?? '')))
  }
}

/**
 * 收掉浏览器（**先让脚本自己关浏览器，实在不行再杀进程**）。
 *
 * ⚠️ 光 `proc.kill()` **不够**（实测踩到）：那只杀掉 node 脚本，
 * 而它 launch 出来的 Chrome 会**变成孤儿进程继续活着**、继续占着 CDP 端口。
 * 下一次跑测试就报「连不上 :端口」，那个报错与代码毫无关系 —— 我为此白查了一轮。
 *
 * 所以在宿主脚本里挂了 `bye` 处理（收到消息就 `browser.close()`），
 * 这里发消息 → 等它自己退 → 超时了才强杀。
 *
 * @returns {Promise<void>}
 */
async function stopHost() {
  if (proc === null) return
  const gone = new Promise((resolve) => {
    if (proc.exitCode !== null) { resolve(); return }
    proc.once('exit', resolve)
  })
  try { proc.send('bye') } catch { /* 通道没了就直接走下面的兜底 */ }
  const ok = await Promise.race([gone.then(() => true), new Promise(r => setTimeout(() => r(false), 5000))])
  if (!ok) proc.kill()
  await gone
  /* ★ 最后再按端口兜一次 —— 上面是「请它自己关」，这里是「确认它真关了」。
   * 宿主脚本正常时会走 `bye` 自己 `browser.close()`；但它要是崩在 launch 之后、
   * 挂 `bye` 之前，Chrome 就留下了，而 node 脚本已经退出、没人能再通知它。 */
  killByPort()
}

/**
 * 按 CDP 端口找出还在听的进程并**连树一起**杀掉（同步，可在 `exit` 里用）。
 *
 * ## 为什么要有这个「最脏但最可靠」的兜底
 *
 * 浏览器是**孙进程**：测试进程 → node 宿主脚本 → Chrome。
 * 父进程 `proc.kill()` 只杀中间那个 node 脚本，Chrome 会变成孤儿继续活着、
 * 继续占着 CDP 端口 —— 下一次跑测试就报「连不上 :端口」，与代码毫无关系。
 *
 * 宿主脚本里虽然挂了 `bye`（收到消息就 `browser.close()`），但它有覆盖不到的时刻：
 * 崩在 `launch()` 之后、挂 `bye` 监听之前；或者 IPC 通道已经断了。
 * 那种时候只剩「按端口找进程」这一条路。
 *
 * ⚠️ 必须在 `process.on('exit')` 里也能用，所以全程**同步**（`execFileSync`），
 * 不能 await —— Node 的 exit 回调不允许异步。
 *
 * @returns {void}
 */
function killByPort() {
  if (process.platform !== 'win32') return
  try {
    /* netstat 的行形如：`  TCP    127.0.0.1:9489    0.0.0.0:0    LISTENING    12448` */
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true })
    const pids = new Set()
    for (const line of out.split('\n')) {
      if (!line.includes(':' + String(PORT))) continue
      if (!/LISTENING/i.test(line)) continue
      const cols = line.trim().split(/\s+/)
      const pid = cols[cols.length - 1]
      if (/^\d+$/.test(pid) && pid !== '0') pids.add(pid)
    }
    /* `/T` 连子进程一起杀：Chrome 会开一堆渲染进程，只杀主进程会留一半。 */
    for (const pid of pids) {
      try { execFileSync('taskkill', ['/F', '/T', '/PID', pid], { stdio: 'ignore', windowsHide: true }) } catch { /* 已经没了 */ }
    }
  } catch { /* 没有 netstat / 没有 taskkill —— 不是致命，下次探测仍会挡住 */ }
}

/* ── 收尾 ───────────────────────────────────────────────────── */
console.log('')
console.log('⑤ 收尾')
{
  /* ⚠️ 必须真的把浏览器收掉：留一个常驻 Chrome 会占着端口，
   * 下次跑就说「端口被占」，而那与代码无关。 */
  await stopHost()
  check('浏览器进程已收掉（不留后台）', proc.exitCode !== null, String(proc.exitCode))
  /* ★ 再验一次端口真的空了 —— 进程退出 ≠ 它 launch 的 Chrome 也退了。
   * 这一条是专门为「孤儿 Chrome 占着端口」那个坑写的。 */
  let portFree = false
  for (let i = 0; i < 20; i++) {
    try {
      /* 连得上说明还有人在听 → 没退干净。 */
      await new Promise((resolve, reject) => {
        const req = require('node:http').get('http://127.0.0.1:' + String(PORT) + '/json/version', () => resolve())
        req.on('error', () => reject(new Error('closed')))
        req.setTimeout(500, () => { req.destroy(); reject(new Error('timeout')) })
      })
      await new Promise(r => setTimeout(r, 250))
    } catch { portFree = true; break }
  }
  check('★ CDP 端口已释放（浏览器真的关了，不是留个孤儿进程）', portFree,
    ':' + String(PORT) + (portFree ? '' : ' 仍有响应'))
  rmSync(TMP, { recursive: true, force: true })
  check('临时目录已清理', !existsSync(TMP))
}

console.log('')
console.log(failed === 0
  ? '结论：真驱动在假页面上跑通（dropdown 两步 / btn=last / 中文报错）✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
