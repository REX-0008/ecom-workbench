/** 界面偏好「落盘」的检查（用户 2026-10-22：「重启桌面端就丢」）。
 *
 * ## 为什么这一份必须存在
 *
 * 这份文件的三种坏法都是**静默**的：
 *   · 写到 localStorage 去了 → 端口一变就读不到，表现成「设了没用」；
 *   · 逐字段回落写成整份作废 → 手改坏一个数，另外四个开关一起被打回默认；
 *   · 写接口做成整份替换 → 改一个开关把其它四个清掉。
 *
 * 所以这里**直接验行为**：真写文件、真读回、真把 JSON 写坏、真传坏值。
 *
 * 跑法：node scripts/run-tests.mjs ui-prefs
 */
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

/* ── 沙箱（必须在载入插件之前设好：模块读环境变量定目录）────────── */
process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-uiprefs-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
/* 闸门：不起 BI 脚本、不弹通知（这两件事与本题无关，但 apply 会把它们挂上）。 */
process.env.EWB_TEST_NO_SPAWN = '1'

const { apply } = await import('../src/index.ts')
const { uiPrefsFile, defaultUiPrefs, readUiPrefs, writeUiPrefs, UI_PREFS_FILE } =
  await import('../src/prefs/ui-prefs.ts')
const { workflowsDir } = await import('../src/workflow/store.ts')
const { PREFS_FILE } = await import('../src/workflow/browser-prefs.ts')
const { NOTIFY_PREFS_FILE } = await import('../src/notify/prefs.ts')

/* ── 假 ctx：只抓路由处理函数 ───────────────────────────────── */
let handler = null
const fakeCtx = {
  inject(names, fn) {
    if (names.includes('webServer')) {
      fn({ webServer: { register(route) { handler = route.handler; return () => { /* 清理 */ } } } })
    }
    if (names.includes('subprocess')) {
      fn({
        subprocess: {
          spawn() {
            return {
              pid: 1,
              terminate() { /* 假句柄 */ },
              waitForExit: async () => true,
              done: Promise.resolve({ exitCode: 0, signal: null }),
              collected: {
                stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
                stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
              },
            }
          },
        },
      })
    }
  },
  /* ⚠️ 不执行回调：真 cordis 会起定时器，本测试不需要。 */
  effect() { return () => { /* 清理 */ } },
}
apply(fakeCtx)

/** 模拟一次 HTTP 调用。
 * @param method - 方法。
 * @param url - 路径。
 * @param body - 请求体。
 * @returns 状态码与解析后的响应体。 */
async function call(method, url, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')])
  req.method = method
  req.url = url
  const res = new EventEmitter()
  let code = 0
  let out = ''
  res.writeHead = (c) => { code = c }
  res.end = (s) => { out = s }
  res.writableEnded = false
  await handler(req, res)
  return { code, body: JSON.parse(out) }
}

let bad = 0
/** 断言一条。
 * @param name - 用例名。
 * @param ok - 过没过。
 * @param detail - 细节。 */
function check(name, ok, detail) {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : ' → ' + detail))
}

console.log('① 路由注册:', handler === null ? '失败 ✗' : '成功 ✓')

/* ── 一、文件位置与首次读取（验收 1）────────────────────────── */
console.log('')
console.log('=== 1. 文件位置 / 首次读取 ===')
{
  check('文件名是 ui-prefs.json', UI_PREFS_FILE === 'ui-prefs.json' && uiPrefsFile().endsWith('ui-prefs.json'),
    uiPrefsFile())
  const mine = dirname(uiPrefsFile())
  const browser = dirname(join(workflowsDir(), '..', PREFS_FILE))
  const notif = dirname(join(workflowsDir(), '..', NOTIFY_PREFS_FILE))
  check('★ 与 browser-prefs.json 同目录同级', mine === browser, mine + ' | ' + browser)
  check('★ 与 notify-prefs.json 同目录同级', mine === notif, mine + ' | ' + notif)

  check('首次读取时文件还不存在', !existsSync(uiPrefsFile()), uiPrefsFile())
  let threw = null
  let p = null
  try {
    p = await readUiPrefs()
  } catch (e) {
    threw = e
  }
  check('★★ 文件不存在不抛错', threw === null, String(threw))
  /* ⚠️ **2026-10-29（票 58）`libW` 212 → 260**：用户定两侧栏默认宽度统一 260。
   * 判据语义一个字没改（「文件不存在 → 全默认值」），只换数字。 */
  check('★ 文件不存在 → 全默认值',
    JSON.stringify(p) === JSON.stringify({ topHidden: false, navCollapsed: false, libW: 260, legend: true, nodeW: 300 }),
    JSON.stringify(p))
  check('★★ 读不存在的文件不自动创建', !existsSync(uiPrefsFile()), uiPrefsFile())
  check('默认值由 defaultUiPrefs() 给出且与现行代码一致',
    defaultUiPrefs().libW === 260 && defaultUiPrefs().nodeW === 300
    && defaultUiPrefs().legend === true && defaultUiPrefs().topHidden === false
    && defaultUiPrefs().navCollapsed === false, JSON.stringify(defaultUiPrefs()))
}

/* ── 二、部分更新（验收 2）────────────────────────────────── */
console.log('')
console.log('=== 2. 写单个字段 → 其余保持 ===')
{
  const written = await writeUiPrefs({ nodeW: 360 })
  check('返回完整对象（五个字段都在）', Object.keys(written).length === 5, JSON.stringify(written))
  check('★ 写的那个字段生效', written.nodeW === 360, String(written.nodeW))
  check('★ 其余字段保持默认', written.topHidden === false && written.navCollapsed === false
    && written.libW === 260 && written.legend === true, JSON.stringify(written))
  const onDisk = JSON.parse(await readFile(uiPrefsFile(), 'utf8'))
  check('盘上是合并后的完整对象', JSON.stringify(onDisk) === JSON.stringify(written), JSON.stringify(onDisk))

  /* 再改另一个字段：上一个必须还在（这是「部分更新」的要害）。 */
  const second = await writeUiPrefs({ topHidden: true })
  check('★★ 第二次只改 topHidden，nodeW 仍是 360', second.topHidden === true && second.nodeW === 360,
    JSON.stringify(second))
  const readBack = await readUiPrefs()
  check('★ 读回与返回值一致', JSON.stringify(readBack) === JSON.stringify(second), JSON.stringify(readBack))
}

/* ── 三、坏 JSON（验收 3）──────────────────────────────────── */
console.log('')
console.log('=== 3. 文件被写坏 ===')
{
  await writeFile(uiPrefsFile(), '{', 'utf8')
  let threw = null
  let p = null
  try {
    p = await readUiPrefs()
  } catch (e) {
    threw = e
  }
  check('★★ 坏 JSON 不抛错', threw === null, String(threw))
  check('★ 坏 JSON → 全默认值', JSON.stringify(p) === JSON.stringify(defaultUiPrefs()), JSON.stringify(p))
}

/* ── 四、单字段非法 → 只回落那一个（验收 4，本题要害）────────── */
console.log('')
console.log('=== 4. 单字段非法 → 该字段回落，其它合法字段仍生效 ===')
{
  /* 一条文件里三个字段坏、两个字段好 —— 好的必须活下来。 */
  await writeFile(uiPrefsFile(), JSON.stringify({
    topHidden: true,      /* 合法 */
    navCollapsed: 'yes',  /* 非法（字符串） */
    libW: 'abc',          /* 非法（不是数） */
    legend: false,        /* 合法 */
    nodeW: 9999,          /* 非法（越界） */
  }), 'utf8')
  const p = await readUiPrefs()
  check('★★ nodeW 越界（9999）→ 回落 300', p.nodeW === 300, String(p.nodeW))
  check('★★ libW 不是数（"abc"）→ 回落 260', p.libW === 260, String(p.libW))
  check('★★ navCollapsed 不是布尔（"yes"）→ 回落 false', p.navCollapsed === false, String(p.navCollapsed))
  check('★★★★ 合法的 topHidden 仍生效（不是整份作废）', p.topHidden === true, String(p.topHidden))
  check('★★★★ 合法的 legend 仍生效（不是整份作废）', p.legend === false, String(p.legend))

  /* 写接口也该逐个挡：非法字段跳过，合法字段照写。 */
  const w = await writeUiPrefs({ nodeW: 9999, libW: 200, legend: 'yes' })
  check('★ 写时非法 nodeW 被跳过（保持盘上原值 300）', w.nodeW === 300, String(w.nodeW))
  check('★ 写时合法 libW 生效', w.libW === 200, String(w.libW))
  check('★ 写时非法 legend 被跳过（保持盘上原值 false）', w.legend === false, String(w.legend))

  /* 边界值本身合法（越界才回落）。
   * ⚠️ **票 58：libW 的下界 160 → 180**（两侧栏统一到 180–460）。nodeW 的 520 没变。 */
  const edge = await writeUiPrefs({ libW: 180, nodeW: 520 })
  check('边界值 180 / 520 合法', edge.libW === 180 && edge.nodeW === 520, JSON.stringify(edge))
  /* ⚠️ 写的时候「非法」等于「跳过」，回落的是**盘上原值**（不是默认值）——
   * 与读的时候不同。判据是「上一批的 180 / 520 还在」，不是「打回 260 / 300」。 */
  /* ⚠️ **票 58：上界 420 → 460**，所以「越界」那个数也要跟着往上挪
   * （用 421 的话它在新区间里是合法的，那条断言就验不到「越界被跳过」了）。 */
  const over = await writeUiPrefs({ libW: 461, nodeW: 521 })
  check('★★ 写时越界的字段被跳过（保持原值 180 / 520，不打回默认）',
    over.libW === 180 && over.nodeW === 520, JSON.stringify(over))
}

/* ── 五、两条路由（验收 5 / 6）────────────────────────────── */
console.log('')
console.log('=== 5/6. 两条路由 ===')
{
  /* 先把盘上清成默认，才好判断「其它字段不变」。 */
  await writeFile(uiPrefsFile(), JSON.stringify(defaultUiPrefs()), 'utf8')

  const g0 = await call('GET', '/api/ecom-workbench/ui/prefs')
  check('GET 回 200 + { ok, prefs }', g0.code === 200 && g0.body.ok === true
    && JSON.stringify(g0.body.prefs) === JSON.stringify(defaultUiPrefs()), JSON.stringify(g0.body))

  const p1 = await call('POST', '/api/ecom-workbench/ui/prefs', { prefs: { topHidden: true } })
  check('★★ POST 回 200', p1.code === 200 && p1.body.ok === true, JSON.stringify(p1.body))
  check('★ POST 返回合并后的完整对象', p1.body.prefs?.topHidden === true
    && p1.body.prefs?.nodeW === 300 && p1.body.prefs?.libW === 260, JSON.stringify(p1.body.prefs))

  const g1 = await call('GET', '/api/ecom-workbench/ui/prefs')
  check('★★ 随后 GET 读回 topHidden: true', g1.body.prefs?.topHidden === true, JSON.stringify(g1.body.prefs))
  check('★★ 其它字段不变', g1.body.prefs?.navCollapsed === false && g1.body.prefs?.libW === 260
    && g1.body.prefs?.legend === true && g1.body.prefs?.nodeW === 300, JSON.stringify(g1.body.prefs))

  /* 非法值照样 200，且只影响那一个字段。 */
  const p2 = await call('POST', '/api/ecom-workbench/ui/prefs', { prefs: { nodeW: 9999, legend: false } })
  check('★ 非法字段也回 200', p2.code === 200 && p2.body.ok === true, JSON.stringify(p2.body))
  /* ⚠️ 写时非法 = **跳过**（保持盘上原值 300，盘上本来就是 300），不是「打回默认」——
   * 两种说法在这一次恰好同值，所以判据只钉住「同批的合法字段照常生效」。 */
  check('★ 非法 nodeW 被跳过（仍是 300）、同批的 legend 仍生效',
    p2.body.prefs?.nodeW === 300 && p2.body.prefs?.legend === false, JSON.stringify(p2.body.prefs))
  check('★ 上一批的 topHidden 没被清掉', p2.body.prefs?.topHidden === true, JSON.stringify(p2.body.prefs))

  /* 空 body / 不是对象也不该炸。 */
  const p3 = await call('POST', '/api/ecom-workbench/ui/prefs', {})
  check('没给 prefs 也不炸（整份保持原样）', p3.code === 200 && p3.body.prefs?.topHidden === true,
    JSON.stringify(p3.body))
}

/* ── 六、文案守 R6（验收里的文案要求）────────────────────────
 *
 * 只查**用户看得见的字符串字面量**，不查整行源码（三元表达式里的 `?` 不是文案）。
 *
 * ## 2026-10-23 修过一次「被新路由撞假」（契约 N）
 *
 * ### 坏在哪（两个毛病叠在一起）
 *
 * ① **切片的起止点都落在字符串字面量内部**。
 *    起点写的是 `path === '/api/ecom-workbench/ui/prefs' && r.method === 'GET'` ——
 *    它从那个**引号之后**开始，于是后面第一个 `'` 是「上一条字符串的收尾引号」，
 *    整块的引号配对从此错一位。
 * ② **终点用下游路由名当哨兵**（`.../run` 那条）。契约 H 在中间插进了两条模型路由，
 *    范围于是从「界面偏好两条」胀成「界面偏好 + 模型目录 + 模型偏好」，
 *    而模型路由里 `as { prefs?: unknown }` 的 `?` 是**类型语法的可选标记**，不是问句。
 *
 * 两者合起来的效果：正则从「收尾引号」一路配到很远的另一个引号，
 * 把一个 335 字、跨好几行的**代码片段**当成了一段「文案」，`?` 就这么被算进去了。
 *
 * ### 现在怎么取
 *
 *   · 范围：只取**那两条 `ui/prefs` 路由各自的 `if { … }` 块**，
 *     起点从 `if (` 之前算、终点靠**括号配对**找它自己的收尾。
 *     → 后面再插多少条路由都不影响（不再依赖任何下游路由名）。
 *   · 文案：先**剥掉注释**（注释里的字不会到用户眼前，且注释里的引号会打乱配对），
 *     再抓**同一行内**的字符串字面量（`[^'\\\r\n]` 不含换行）。
 *     → 一个「文案」不可能横跨多行；跨行的一定是代码被误配了。
 *
 * ⚠️ **没有**把 `?` 从判据里删掉 —— 那是把 R6 这条规矩废掉。 */
console.log('')
console.log('=== 文案 ===')
{
  const src = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

  /**
   * 取一条路由处理函数的 `if (…) { … }` 整块（靠括号配对，不靠下游哨兵）。
   * @param text - 源码全文。
   * @param marker - 路由条件里的特征片段（如 `path === '…' && r.method === 'GET'`）。
   * @returns 该块的原文；找不到给空串。
   */
  function routeBlockOf(text, marker) {
    const at = text.indexOf(marker)
    if (at < 0) return ''
    const open = text.indexOf('{', at)
    if (open < 0) return ''
    let depth = 0
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth += 1
      else if (text[i] === '}') {
        depth -= 1
        if (depth === 0) return text.slice(at, i + 1)
      }
    }
    return ''
  }

  /* 只取界面偏好那两条 —— 它们是本测试的主角，别的一条都不该混进来。 */
  const getBlock = routeBlockOf(src, "path === '/api/ecom-workbench/ui/prefs' && r.method === 'GET'")
  const postBlock = routeBlockOf(src, "path === '/api/ecom-workbench/ui/prefs' && r.method === 'POST'")
  const block = getBlock + postBlock
  check('找到了界面偏好那两条路由', getBlock !== '' && postBlock !== '',
    'GET ' + String(getBlock.length) + ' 字 / POST ' + String(postBlock.length) + ' 字')

  /**
   * 剥掉 `//` 与 `/* *\/` 注释，**保留换行**（行号与配对都不受影响）。
   * @param s - 源码片段。
   * @returns 去掉注释后的文本。
   */
  function stripComments(s) {
    let out = ''
    let i = 0
    let quote = null
    while (i < s.length) {
      const c = s[i]
      const n = s[i + 1]
      if (quote !== null) {
        out += c
        if (c === '\\') { out += n ?? ''; i += 2; continue }
        if (c === quote) quote = null
        i += 1
        continue
      }
      if (c === '/' && n === '*') {
        const end = s.indexOf('*/', i + 2)
        const stop = end < 0 ? s.length : end + 2
        for (let k = i; k < stop; k++) out += s[k] === '\n' ? '\n' : ' '
        i = stop
        continue
      }
      if (c === '/' && n === '/') {
        const end = s.indexOf('\n', i)
        i = end < 0 ? s.length : end
        continue
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue }
      out += c
      i += 1
    }
    return out
  }

  /** 路由块里所有带中文的**单行**字符串字面量（就是会到用户眼前的那些字）。 */
  const texts = [...stripComments(block).matchAll(/'([^'\\\r\n]*[\u4e00-\u9fa5][^'\\\r\n]*)'/g)].map(m => m[1])
  check('路由块里有用户可见文案', texts.length > 0, JSON.stringify(texts))
  /* 反面自检：抓出来的每一段都必须是**单行**，出现跨行说明引号又配错了。 */
  const spansLines = texts.filter(t => /[\r\n]/.test(t))
  check('★ 抓出来的文案都是单行（没有把代码片段当文案）', spansLines.length === 0,
    spansLines.length === 0 ? '共 ' + String(texts.length) + ' 段' : JSON.stringify(spansLines[0].slice(0, 60)))
  check('★ 不含第二人称（你 / 您）', texts.every(t => !/[你您]/.test(t)), JSON.stringify(texts))
  check('★ 不用疑问句做标签', texts.every(t => !/[？?]/.test(t)), JSON.stringify(texts))
  check('★ 不含「折腾 / 省事 / 顺手 / 一会儿 / 其实 / 别怕」',
    texts.every(t => !/折腾|省事|顺手|一会儿|其实|别怕/.test(t)), JSON.stringify(texts))
}

console.log('')
if (bad === 0) {
  console.log('全部通过 ✓')
  await rm(process.env.EWB_TEST_HOME, { recursive: true, force: true })
  process.exit(0)
}
console.log('有 ' + String(bad) + ' 条红的 ✗')
process.exit(1)
