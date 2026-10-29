/** 浏览器检测与两层设置的测试（纯逻辑，不碰磁盘）。
 *
 * 用户 2026-10-13 的要求：
 *   - 「设置里面增加一个**默认使用浏览器**……电脑应该有很多浏览器可以用，
 *     包括 playwright 默认打包的浏览器，这个检测过程能否自动。
 *     如果可以，增加一个**检测功能**。另外我们的 **CDP 也列进去**。」
 *   - 两层结构：「第一层决定第二层，其他的节点第二层自动统一
 *     （不然，明明用来保证一个页面的标签一样，浏览器不一样，运行必然会出问题）」
 *   - 「不用多个端口……我要固定使用这个浏览器，使用他的 cookie 记住并更新登录态」
 *
 * 跑法：node --import <tsx> tests/browser-settings.mjs
 */
import {
  systemBrowserCandidates, playwrightCacheDirs, parsePlaywrightCache,
  usable, LAUNCHER_LABEL, SOURCE_LABEL, OPEN_MODE_LABEL,
  listeningPorts, cdpBrowserOf, scanCdpPorts, normalizePort,
  CDP_SCAN_TIMEOUT_MS, CDP_SCAN_CONCURRENCY,
} from '../src/client/workbench/browser-detect.ts'
import {
  readPrefs, resolveTag, allTags, setTag, removeTag, checkRunnable, launcherOf, EMPTY_PREFS,
} from '../src/client/workbench/browser-settings.ts'

let failed = 0
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

console.log('=== ① 系统浏览器候选（Windows 常见安装位置）===')
{
  const c = systemBrowserCandidates('win32', { LOCALAPPDATA: 'C:\\Users\\X\\AppData\\Local' })
  check('列出了若干候选', c.length >= 3, String(c.length))
  const ids = c.map(x => x.id)
  check('包含 qqbrowser（用户实际在用的那个）', ids.includes('qqbrowser'), ids.join(','))
  check('包含 chrome 与 edge', ids.includes('chrome') && ids.includes('edge'))
  check('★ QQBrowser 排第一（用户跑采集用的就是它）', ids[0] === 'qqbrowser', ids[0])
  /* Chrome 要多一个「当前用户安装」的位置。 */
  const chrome = c.find(x => x.id === 'chrome')
  check('Chrome 有「当前用户安装」的候选路径',
    chrome.paths.some(p => p.includes('AppData\\Local')), JSON.stringify(chrome.paths))
  /* 非 Windows 不返回候选（不做没验证过的平台猜测）。 */
  check('非 win32 返回空（不猜别的平台）', systemBrowserCandidates('darwin', {}).length === 0)
}

console.log('')
console.log('=== ② Playwright 自带浏览器的缓存目录 ===')
{
  const d = playwrightCacheDirs('win32', { LOCALAPPDATA: 'C:\\U\\AppData\\Local' }, 'C:/Users/X')
  check('Windows 上找了 LOCALAPPDATA 那份', d.some(x => x.includes('AppData\\Local')), JSON.stringify(d))
  check('也找了 ~/.cache（playwright 的老约定）', d.some(x => x.includes('.cache')), JSON.stringify(d))
  const d2 = playwrightCacheDirs('linux', {}, '/home/x')
  check('Linux 只找 ~/.cache', d2.length === 1 && d2[0] === '/home/x/.cache/ms-playwright', JSON.stringify(d2))
}

console.log('')
console.log('=== ③ 解析 Playwright 缓存目录名 ===')
{
  const got = parsePlaywrightCache([
    'chromium-1200', 'chromium_headless_shell-1200',
    'firefox-1490', 'webkit-2100', 'ffmpeg-1011',
    'chromium-1180',   // 旧版本，应被新版盖掉
    'not-a-browser',   // 不认识
  ])
  const ids = got.map(g => g.id).sort()
  check('认出 chromium / firefox / webkit', ids.join(',') === 'chromium,firefox,webkit', ids.join(','))
  check('★ 排除了 ffmpeg（那是录屏工具，不是浏览器）', !ids.includes('ffmpeg'))
  check('★ 同名的保留**最高版本**', got.find(g => g.id === 'chromium')?.version === '1200',
    got.find(g => g.id === 'chromium')?.version)
  check('headless_shell 归并到 chromium（不单列）', ids.filter(x => x === 'chromium').length === 1)
  check('名字是给人看的', got.find(g => g.id === 'firefox')?.name.includes('Firefox'))
}

console.log('')
console.log('=== ④ 三个内部值都有中文说明（**不再给用户直接选**）===')
{
  /* ⚠️ 2026-10-14 起：`launcher` 的三个值是**从来源推导**的，不是给用户选的项。
   * 但它们的说明仍要用在「提示 / 报错」里，所以三个都得在。 */
  check('三个内部值都在（cdp / headed / headless）',
    ['cdp', 'headed', 'headless'].every(k => LAUNCHER_LABEL[k] !== undefined))
  check('CDP 的说明点明「保留登录态」（这是采集的关键）',
    LAUNCHER_LABEL.cdp.hint.includes('登录态'))
  check('无头的说明点明「没有登录态」', LAUNCHER_LABEL.headless.hint.includes('登录态'))

  /* ★ 用户要的**两个来源**（「他们可以列在一起」）。 */
  check('★ 有「已开的调试端口（CDP）」这个来源',
    SOURCE_LABEL.cdp !== undefined && SOURCE_LABEL.cdp.name.includes('CDP'))
  check('★ 有「本机装着的浏览器」这个来源',
    SOURCE_LABEL.app !== undefined && SOURCE_LABEL.app.name.includes('本机'))
  check('★ CDP 来源的说明点明「保留登录态」', SOURCE_LABEL.cdp.hint.includes('登录态'))

  /* ★ 有头/无头**降级成「打开方式的属性」**（用户明确要求）。 */
  check('★ 有「有窗口 / 无窗口」两个打开方式',
    OPEN_MODE_LABEL.headed !== undefined && OPEN_MODE_LABEL.headless !== undefined)
  check('★ 「打开方式」的说明里不再有 CDP（它不属于这一层）',
    !OPEN_MODE_LABEL.headed.hint.includes('CDP') && !OPEN_MODE_LABEL.headless.hint.includes('CDP'))
}

console.log('')
console.log('=== ④b launcherOf：来源 + 打开方式 → 驱动读的那个值 ===')
{
  /* 这是「界面显示」与「驱动实际怎么连」**唯一的一条桥**，错了就分叉。 */
  check('来源=CDP → 连已有的（不论打开方式填了什么）',
    launcherOf('cdp', 'headed') === 'cdp' && launcherOf('cdp', 'headless') === 'cdp')
  check('来源=本机 + 有窗口 → headed', launcherOf('app', 'headed') === 'headed')
  check('来源=本机 + 无窗口 → headless', launcherOf('app', 'headless') === 'headless')
}

console.log('')
console.log('=== ⑤ 两层结构：第一层决定第二层（★ 核心）===')
{
  /* 用户要的「自动统一」：同名标签**只可能有一份**第二层配置。 */
  let p = { ...EMPTY_PREFS, tags: {} }
  p = setTag(p, '淘宝', { source: 'cdp', browserId: 'qqbrowser', port: '9222', exePath: '', openMode: 'headed', launcher: 'cdp' })
  p = setTag(p, '抖音', { source: 'app', browserId: 'chrome', port: '', exePath: '', openMode: 'headed', launcher: 'headed' })

  const tb = resolveTag(p, '淘宝')
  check('淘宝 → qqbrowser（按标签解析）', tb.browserId === 'qqbrowser', tb.browserId)
  const dy = resolveTag(p, '抖音')
  check('抖音 → chrome（另一套，互不影响）', dy.browserId === 'chrome', dy.browserId)

  /* ★ 关键：同一个标签解析两次，结果必须**完全一样** ——
   * 这就是「其他节点第二层自动统一」的机制保证。 */
  const a1 = resolveTag(p, '淘宝')
  const a2 = resolveTag(p, '淘宝')
  check('★ 同一标签解析结果恒定（所以同名不可能不同浏览器）',
    JSON.stringify(a1) === JSON.stringify(a2))

  /* 改标签的第二层 → 所有用它的节点自动跟随（因为它们不存第二层）。 */
  p = setTag(p, '淘宝', { source: 'cdp', browserId: 'edge', port: '9222', exePath: '', openMode: 'headed', launcher: 'cdp' })
  check('★ 改标签后，节点再解析就拿到新值（自动统一）',
    resolveTag(p, '淘宝').browserId === 'edge', resolveTag(p, '淘宝').browserId)
}

console.log('')
console.log('=== ⑥ 全局默认 + 可覆盖（用户：「设置里面选一个作为默认」+「可全局覆盖」）===')
{
  const base = {
    defaultBrowserId: 'chrome', defaultLauncher: 'cdp',
    defaultSource: 'cdp', defaultPort: '', defaultOpenMode: 'headed', tags: {},
  }
  check('没单独配的标签 → 用全局默认',
    resolveTag(base, '随便一个标签').browserId === 'chrome')

  const overridden = setTag({ ...base, tags: {} }, '抖音', {
    source: 'cdp', browserId: 'qqbrowser', port: '9222', exePath: '', openMode: 'headed', launcher: 'cdp',
  })
  check('★ 单独配了的标签 → 用自己那个（全局覆盖）',
    resolveTag(overridden, '抖音').browserId === 'qqbrowser')
  check('同一个设置里，别的标签仍用全局默认',
    resolveTag(overridden, '淘宝').browserId === 'chrome')

  /* 全局默认也是空 → 用兜底（检测到的第一个能用的）。 */
  check('全局默认空时用兜底', resolveTag(EMPTY_PREFS, 'x', 'edge').browserId === 'edge')
  check('什么都没有 → 空串（调用方要处理「一个都没检测到」）',
    resolveTag(EMPTY_PREFS, 'x').browserId === '')
}

console.log('')
console.log('=== ⑦ 来源与打开方式也能按标签覆盖 ===')
{
  const p = {
    defaultBrowserId: 'chrome', defaultLauncher: 'headless',
    defaultSource: 'app', defaultPort: '', defaultOpenMode: 'headless', tags: {},
  }
  check('默认是「本机 + 无窗口」',
    resolveTag(p, 'x').source === 'app' && resolveTag(p, 'x').launcher === 'headless')
  /* ★ 标签可以单独改成「连已有的」（采集要登录态的那条路）。 */
  const p2 = setTag(p, '淘宝', {
    source: 'cdp', browserId: '', port: '9222', exePath: '', openMode: 'headless', launcher: 'cdp',
  })
  check('★ 标签可单独指定 CDP（采集要登录态）',
    resolveTag(p2, '淘宝').source === 'cdp' && resolveTag(p2, '淘宝').launcher === 'cdp')
  check('别的标签仍是无窗口启动式',
    resolveTag(p2, 'y').source === 'app' && resolveTag(p2, 'y').launcher === 'headless')
  /* 来源是 CDP 时，打开方式**不影响** launcher（那是另一个来源的属性）。 */
  check('★ 来源=CDP 时打开方式不影响连法',
    resolveTag(p2, '淘宝').launcher === 'cdp')
}

console.log('')
console.log('=== ⑧ ★ 端口：手填、无默认值、不填有明确行为（用户 #7）===')
{
  /* ★ 核心：默认偏好里**没有端口**（不预填 9222）。 */
  check('★ 默认偏好里**没有**端口（不预填 9222）', EMPTY_PREFS.defaultPort === '',
    JSON.stringify(EMPTY_PREFS.defaultPort))
  check('★ 解析结果里的端口来自配置（不是常量）',
    resolveTag({
      ...EMPTY_PREFS,
      tags: { t: { source: 'cdp', browserId: '', port: '9333', exePath: '', openMode: 'headed', launcher: 'cdp' } },
    }, 't').port === '9333')
  check('★ 没填端口 → 解析结果是空串（**不替用户猜**）',
    resolveTag(EMPTY_PREFS, 'x').port === '')
  /* 标签没填 → 跟着全局默认；全局也没填 → 空串。 */
  check('标签没填时跟全局默认',
    resolveTag({ ...EMPTY_PREFS, defaultPort: '9222' }, 'x').port === '9222')
  /* 来源不是 CDP 时端口一并清空（否则「切到本机浏览器」后还留着一个端口，看着像还在连）。 */
  check('★ 来源=本机时端口清空（不留着上一个来源的端口）',
    resolveTag({
      ...EMPTY_PREFS,
      defaultPort: '9222',
      tags: { t: { source: 'app', browserId: 'chrome', port: '', exePath: '', openMode: 'headed', launcher: 'headed' } },
    }, 't').port === '')

  /* ★ 「不填端口」的**行为定义**：跑不了，但原因说得清。 */
  const noPort = checkRunnable(resolveTag(EMPTY_PREFS, 'x'))
  check('★ 来源=CDP 且没填端口 → 判定为「跑不了」', noPort.ok === false)
  check('★ 该原因说清了「没填端口」+ 去哪儿填',
    noPort.reason.includes('没填') && noPort.reason.includes('端口') && noPort.reason.includes('检测'),
    noPort.reason.slice(0, 50))
  check('填了端口就能跑',
    checkRunnable(resolveTag({ ...EMPTY_PREFS, defaultPort: '9222' }, 'x')).ok === true)
  check('来源=本机时不做端口要求（它不用端口）',
    checkRunnable(resolveTag({
      ...EMPTY_PREFS,
      defaultSource: 'app',
      tags: { t: { source: 'app', browserId: 'chrome', port: '', exePath: '', openMode: 'headed', launcher: 'headed' } },
    }, 't')).ok === true)

  check('端口合法化：只认 1–65535 的数字',
    normalizePort(' 9222 ') === '9222' && normalizePort('0') === '' && normalizePort('70000') === ''
    && normalizePort('abc') === '' && normalizePort('') === '' && normalizePort(null) === '')
}

console.log('')
console.log('=== ⑨ 读写容错（存档可能被手改 / 是老版本形状）===')
{
  check('空字符串 → 空偏好', readPrefs('')?.tags !== undefined && Object.keys(readPrefs('').tags).length === 0)
  check('坏 JSON → 空偏好（不抛）', Object.keys(readPrefs('{不是json').tags).length === 0)
  check('null → 空偏好', Object.keys(readPrefs(null).tags).length === 0)
  check('数组形状 → 空偏好', Object.keys(readPrefs('[1,2]').tags).length === 0)
  /* 坏标签项被跳过；好的保留。 */
  const p = readPrefs(JSON.stringify({
    defaultBrowserId: 'chrome', defaultLauncher: 'cdp',
    tags: { 好: { browserId: 'edge', launcher: 'cdp', exePath: '' }, 坏: null, '': { browserId: 'x' } },
  }))
  check('坏的标签项被跳过、好的保留', Object.keys(p.tags).join(',') === '好', Object.keys(p.tags).join(','))
  /* 非法 launcher 退回 cdp。 */
  const p2 = readPrefs(JSON.stringify({ tags: { t: { browserId: 'a', launcher: '瞎写的' } } }))
  check('非法启动方式退回 cdp', p2.tags.t.launcher === 'cdp', p2.tags.t.launcher)
}

console.log('')
console.log('=== ⑩ 标签列表 / 删除 ===')
{
  let p = setTag(EMPTY_PREFS, '淘宝', { browserId: 'a', launcher: 'cdp', exePath: '' })
  check('画布上用了但没配的标签也要列出来（否则用户看不到它）',
    allTags(p, ['淘宝', '抖音']).sort().join(',') === ['淘宝', '抖音'].sort().join(','),
    allTags(p, ['淘宝', '抖音']).join(','))
  check('去重', allTags(p, ['淘宝', '淘宝']).length === 1)
  check('空标签名不列', allTags(p, ['', '  ']).length === 1, JSON.stringify(allTags(p, ['', '  '])))
  const p2 = removeTag(p, '淘宝')
  check('删掉后它退回全局默认', resolveTag(p2, '淘宝').browserId === '', resolveTag(p2, '淘宝').browserId)
}

console.log('')
console.log('=== ⑪ usable() ===')
{
  const withPath = { id: 'a', name: 'A', path: 'C:/x.exe', source: 'system', kinds: ['cdp'] }
  const without = { id: 'b', name: 'B', path: null, source: 'system', kinds: ['cdp'] }
  check('有路径 = 能用', usable(withPath) === true)
  check('没路径 = 不能用（但仍在清单里，让用户知道找过）', usable(without) === false)
}

console.log('')
console.log('=== ⑫ ★ 老存档迁移（只有 launcher、没有 source/port）===')
{
  /* ⚠️ 用户升级后**不该发现「浏览器设置全没了」** —— 老形状必须读得懂。
   * 老形状：{ browserId, launcher: 'cdp'|'headed'|'headless', exePath } */
  const old = readPrefs(JSON.stringify({
    defaultBrowserId: 'chrome',
    defaultLauncher: 'cdp',
    tags: { 淘宝: { browserId: 'qqbrowser', launcher: 'cdp', exePath: '' } },
  }))
  check('★ 老存档读出来了（没丢）', old.tags['淘宝'] !== undefined)
  check('★ `launcher: cdp` → 来源=CDP', old.tags['淘宝'].source === 'cdp', String(old.tags['淘宝'].source))
  check('★ 老存档的端口留空（**绝不回填 9222** —— 那等于继续硬编码）',
    old.tags['淘宝'].port === '', JSON.stringify(old.tags['淘宝'].port))
  check('全局默认也迁移了', old.defaultSource === 'cdp' && old.defaultBrowserId === 'chrome')

  const old2 = readPrefs(JSON.stringify({
    defaultLauncher: 'headless',
    tags: { 抖音: { browserId: 'chromium', launcher: 'headless', exePath: 'C:/c.exe' } },
  }))
  check('★ `launcher: headless` → 来源=本机 + 打开方式=无窗口',
    old2.tags['抖音'].source === 'app' && old2.tags['抖音'].openMode === 'headless',
    old2.tags['抖音'].source + '/' + old2.tags['抖音'].openMode)
  check('★ 迁移后 launcher 与来源自洽（推导出来的）',
    old2.tags['抖音'].launcher === 'headless' && launcherOf('app', 'headless') === 'headless')
  check('exePath 保留', old2.tags['抖音'].exePath === 'C:/c.exe')

  /* ⚠️ 手改坏了：`source` 与 `launcher` 对不上时，**以 source 为准**（重新推导）——
   * 否则「界面说连已有的、驱动去启动一个」这种分叉最难查。 */
  const broke = readPrefs(JSON.stringify({
    defaultSource: 'cdp', defaultPort: '9222', defaultOpenMode: 'headed', defaultLauncher: 'cdp',
    tags: { x: { source: 'app', openMode: 'headed', launcher: 'cdp', browserId: 'a', port: '', exePath: '' } },
  }))
  check('★ 存档里 launcher 与 source 打架时，按 source 重新推导',
    broke.tags.x.launcher === 'headed', broke.tags.x.launcher)

  /* 老形状的全局默认：只有 defaultLauncher。 */
  const oldDef = readPrefs(JSON.stringify({ defaultLauncher: 'headed', tags: {} }))
  check('老全局默认（headed）→ 来源=本机',
    oldDef.defaultSource === 'app' && oldDef.defaultLauncher === 'headed',
    oldDef.defaultSource + '/' + oldDef.defaultLauncher)
}

console.log('')
console.log('=== ⑬ ★ 解析 netstat（找监听端口）===')
{
  /* ⚠️ 这是「检测」按钮的地基：解析错了就永远扫不到端点，
   * 而且**不报错**（表现为「一个端口都没扫到」）。所以拿真实形状来测。 */
  const win = [
    '活动连接',
    '',
    '  协议  本地地址          外部地址        状态           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1452',
    '  TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       3052',
    '  TCP    [::]:445               [::]:0                 LISTENING       4',
    '  TCP    127.0.0.1:9222         127.0.0.1:52000        ESTABLISHED     3052',
    '  TCP    192.168.1.5:139        0.0.0.0:0              LISTENING       4',
  ].join('\r\n')
  const got = listeningPorts(win)
  check('★ 认出 IPv4 的监听端口', got.includes(135) && got.includes(9222), got.join(','))
  check('★ 认出 IPv6 的（`[::]:445` → 445）—— 写错会漏掉一半端口',
    got.includes(445), got.join(','))
  check('★ 排除 ESTABLISHED 的（只有 LISTENING 才算）',
    got.filter(p => p === 9222).length === 1, got.join(','))
  check('已连接的远端端口不算（52000 不该在里面）', !got.includes(52000), got.join(','))
  check('升序去重', JSON.stringify(got) === JSON.stringify([...got].sort((a, b) => a - b)))

  /* Linux / macOS 的写法（同一套代码要能兼顾）。 */
  const unix = [
    'tcp4       0      0  127.0.0.1.9222       *.*      LISTEN',
    'tcp6       0      0  ::1.445              *.*      LISTEN',
  ].join('\n')
  const u = listeningPorts(unix)
  check('★ 兼容 Unix 写法（`LISTEN` + 点分端口）', u.includes(9222) && u.includes(445), u.join(','))

  check('空输入 → 空数组', listeningPorts('').length === 0)
  check('只有表头 → 空数组', listeningPorts('  协议  本地地址\n').length === 0)
}

console.log('')
console.log('=== ⑭ ★ 解析 /json/version 的响应 ===')
{
  /* ★ 判据就是 **`Browser` 字段**（用户实测确认：CDP 端点必有它）。 */
  check('★ 取到 Browser 字段',
    cdpBrowserOf(JSON.stringify({ Browser: 'Chrome/138.0.7204.0' })) === 'Chrome/138.0.7204.0')
  check('不是 JSON → null（**不抛**：非 CDP 端口可能返回任意内容）',
    cdpBrowserOf('<html>404</html>') === null)
  check('是 JSON 但没有 Browser → null（不是 CDP）',
    cdpBrowserOf(JSON.stringify({ hello: 'world' })) === null)
  check('Browser 是空串 → null', cdpBrowserOf(JSON.stringify({ Browser: '' })) === null)
}

console.log('')
console.log('=== ⑮ ★ 并发扫端口（work pool）===')
{
  /* ★ 关键性质：**一个端口都不听时不能卡住** ——
   * 所以要并发；且单个端口出错不能算失败（那正是「它不是 CDP」的正常表现）。 */
  const ports = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

  /* ① 只认答话的那两个。 */
  const found = await scanCdpPorts(ports, async p => (p === 3 || p === 12 ? 'Chrome/' + String(p) : null))
  check('★ 只收答话的端口', found.length === 2, JSON.stringify(found))
  check('结果按端口升序（界面上看着稳定）',
    JSON.stringify(found.map(f => f.port)) === JSON.stringify([3, 12]), JSON.stringify(found))
  check('带上它自报的版本', found[1].browser === 'Chrome/12', String(found[1].browser))

  /* ② 有端口**抛错**时不能整批失败（非 CDP 端口本来就可能各种拒绝）。 */
  const withThrow = await scanCdpPorts(ports, async p => {
    if (p === 2) throw new Error('连接被重置')
    return p === 4 ? 'Chrome/4' : null
  })
  check('★ 某个端口抛错不影响别的（那正是「不是 CDP」的正常表现）',
    withThrow.length === 1 && withThrow[0].port === 4, JSON.stringify(withThrow))

  /* ③ ★ **并发是真的**：12 个端口、每个睡 30ms、并发 4 → 约 3 批 ≈ 90ms。
   * 若退化成串行就是 360ms。用「有没有真的重叠」来判（不靠绝对时间，避免 CI 抖动）。 */
  let peak = 0
  let live = 0
  const t0 = Date.now()
  await scanCdpPorts(ports, async () => {
    live += 1
    peak = Math.max(peak, live)
    await new Promise(r => setTimeout(r, 30))
    live -= 1
    return null
  }, { concurrency: 4 })
  const ms = Date.now() - t0
  check('★ 并发确实发生了（同时在跑的探针 > 1）', peak > 1, 'peak=' + String(peak))
  check('★ 并发不超标（不超过设定的宽度）', peak <= 4, 'peak=' + String(peak))
  check('★ 并发省时间（12×30ms 串行=360ms，实测远小于它）', ms < 300, String(ms) + 'ms')

  /* ④ 边界：空清单、并发 0 / 负数都不能炸。 */
  check('空清单 → 空结果', (await scanCdpPorts([], async () => 'x')).length === 0)
  check('并发 0 → 不炸（当成 1）', (await scanCdpPorts([1], async () => 'x', { concurrency: 0 })).length === 1)
  check('并发比端口多 → 不炸', (await scanCdpPorts([1, 2], async () => 'x', { concurrency: 99 })).length === 2)

  /* ⑤ 常量是**实测值**（50 个端口 2.1 秒），别被人随手调大到卡界面。 */
  check('★ 单端口超时保持短（≤1000ms，调大会让「检测」卡住）',
    CDP_SCAN_TIMEOUT_MS <= 1000, String(CDP_SCAN_TIMEOUT_MS))
  check('★ 并发保持够大（≥8，调小会让总耗时成倍涨）',
    CDP_SCAN_CONCURRENCY >= 8, String(CDP_SCAN_CONCURRENCY))
}

console.log('')
console.log(failed === 0
  ? '结论：浏览器检测与两层设置全部通过 ✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
