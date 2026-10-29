/** 生成巡查工作流（shop / activity / qianchuan）的存档 JSON。
 *
 * ## 为什么用脚本生成而不是手写 JSON
 *
 * ① 三个 job **同一个骨架**，手抄三遍必然分叉；
 * ② `code.js` 里的解析代码很长（几百行），塞进 JSON 字符串里没法读、没法 diff
 *    —— 所以解析代码在 `code-*.mjs` 里（**单一来源**：生成器与测试都用它）。
 *
 * ## 骨架（照新判据：一串固定步骤 → 一份工作流）
 *
 * ```
 * ① 读配置(sys.fs.read) → ② 解析配置(code.js) → ③ 算时间(code.js) → ④ 夜禁判断(flow.if)
 *                                                          ├─不成立→ ⑧ 写「未跑」结果
 *                                                          └─成立→ ⑤ 打开页面(browser.act)
 *                                                                 → ⑥ 取整页文本(browser.act)
 *                                                                 → ⑦ 解析判档(code.js)
 *                                                                 → ⑨ 写结果(sys.fs.write)
 * ```
 *
 * ⚠️ **按新判据（`docs/机制-什么做成节点、什么写代码、什么做成工作流.md`）**：
 *   - 「读配置文件」→ **碰外部世界** → `sys.fs.read` 节点（**不是** `code.js` + `import fs`）
 *   - 「配置文件不存在」→ 用 `sys.fs.read` 的**失败策略「继续」**表达
 *     （它跳过时会把上游原样传下去 → 下一个节点拿到 `undefined` → 用内置默认）
 *   - 「解析配置 / 算时间 / 解析页面 / 判档」→ **纯数据变换** → `code.js`
 *   - 「打开页面 / 取文本」→ **碰外部世界** → `browser.act`
 *   - 「写结果」→ **碰外部世界** → `sys.fs.write`
 *
 * 跑法：`node scripts/build-patrol-workflows.mjs`
 * 产出：`$DSH_HOME/profiles/<profile>/data/ecom-workbench/workflows/巡查-<job>.json`
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CODE_PARSE_CFG, codeCurfew, CURFEW_EXPR } from './patrol/code-common.mjs'
import { codeParseQianchuan } from './patrol/code-qianchuan.mjs'
import { codeParseShop } from './patrol/code-shop.mjs'
import { codeParseActivity } from './patrol/code-activity.mjs'
import { PATROL_JOBS, TASK_KINDS } from './patrol/jobs.mjs'
/**
 * 工作流的**稳定编号**（用户 2026-10-19：「引用用编号不用名称」）。
 *
 * 生成器与运行时**共用同一份派生规则** —— 所以组合层能算出子工作流的编号去引用，
 * 而不用先读别的存档。规则本身是纯算术（FNV-1a），零依赖。
 *
 * ⚠️ 直接 import `.ts`：本机的 Node 24 原生剥类型，实测可行；
 * 不另抄一份哈希（「同一件事写两份迟早漂」）。
 */
import { deriveWorkflowId } from '../src/workflow/ids.ts'

const HOME = process.env.DSH_HOME ?? ''
const PROFILE = process.env.DSH_PROFILE ?? 'desktop'
const OUT_DIR = join(HOME, 'profiles', PROFILE, 'data', 'ecom-workbench', 'workflows')
/** `writeShellScripts` 要一个 `{ mkdirSync }` 形状的对象（便于测试替身）。 */
const mkdirs = mkdirSync

/**
 * 结果文件的输出目录（**绝对路径**）。
 *
 * ⚠️ 与配置路径同一个理由：相对路径会落在**宿主半进程的工作目录**，
 * 而那不是我们能预期的地方。写绝对路径，并在备注里注明「换机器要改」。
 *
 * ⚠️ **用 `$DSH_HOME/tmp/`**（而不是源码的 `out/`）：按本项目的文件位置规则，
 * 进程产物归 `$DSH_HOME/tmp/`，不进源码目录。而这块是**观测数据**（面板读它），
 * 所以放在数据目录下更好 —— 用 `data/ecom-workbench/patrol/`。
 */
const OUT_BASE = join(HOME, 'profiles', PROFILE, 'data', 'ecom-workbench', 'patrol').replace(/\\/g, '/')

/**
 * 配置文件路径（**绝对路径**）。
 *
 * ## 为什么写绝对路径而不是相对路径 / 变量（三条都实测过）
 *
 * ① **相对路径不可靠** —— `sys.fs.read` 的相对路径是相对**宿主半进程的工作目录**
 *    （`/health` 返回的 `workdir: process.cwd()`，即 dsh 的启动目录），
 *    而那**不是** `$DSH_HOME`，也不一定在哪。
 * ② **`{{env.DSH_HOME}}` 在画布上解析不出来** —— 画布调 `runGraph` 时
 *    **不传 `env`**（`WorkflowCanvas` 里没有它），那个占位符会被替换成空串。
 *    （宿主半那条路（`run-file`）会传 env，但画布这条不会。）
 * ③ 所以按**当前机器的真实位置**写死，并在节点备注里注明「换机器/换 profile 要改这一处」。
 *
 * ⚠️ 源码 run.ts 的兜底路径写的是 profiles/agent/...，
 * 但本机**没有 agent 这个 profile** —— 真配置在 profiles/desktop/（实测）。
 */
const CONFIG_PATH = join(HOME, 'profiles', PROFILE, 'data', 'workbench', 'monitor.json').replace(/\\/g, '/')

/** 一个节点的构造助手（同时管 nodes 与 edges）。 */
class Builder {
  /**
   * @param job - 名字（**不带前缀**，前缀由 `namePrefix` 决定）。
   * @param namePrefix - 名字前缀。默认 `'巡查-'`。
   *
   * ⚠️ **前缀必须能改**（2026-10-14 修）：我第一版把 `'巡查-'` 写死在 `doc()` 里，
   * 于是「清洗入库 / 天猫取数 / 抖音表单下载」这三份**非巡查**的工作流
   * 也被冠上了「巡查-」—— 面板里看着像四份巡查。
   * 现在由调用方给前缀（巡查那三份给 `'巡查-'`，其余给各自的名字）。
   */
  constructor(job, namePrefix) {
    this.job = job
    this.namePrefix = namePrefix === undefined ? '巡查-' : namePrefix
    this.nodes = []
    this.edges = []
    this.n = 0
  }

  /**
   * 加一个节点。
   * @param defId - 节点类型。
   * @param params - 参数。
   * @param label - 实例名（**必须写清它干什么** —— 用户原话：「看的时候我不知道」）。
   * @param x - 位置 x。
   * @param y - 位置 y。
   * @param onError - 失败策略（默认 `stop`）。
   * @param note - 备注（讲「我在这里为什么用它」）。
   * @param id - **显式指定节点 id**（默认按顺序 `n1` / `n2`…）。
   *
   *   ⚠️ 为什么需要它（2026-10-21 加）：给已存在的存档补「开始 / 结束」节点时，
   *   若还用自增编号，就得**把新节点插在最前**，于是后面所有节点的 id 整体后移
   *   —— 而测试里有用 id 定位的补丁（如 `tests/tmall-workflow.mjs` 钉 `n1`
   *   的「现在几点」），一移就补错节点。用固定 id（`start` / `end`）
   *   可以「后加但不动别人」，编号从此稳定。
   * @returns 节点 id。
   */
  add(defId, params, label, x, y, onError = 'stop', note = undefined, id = undefined) {
    const nid = id ?? ('n' + String(++this.n))
    this.nodes.push({
      id: nid, type: 'v1', defId, position: { x, y }, params,
      onError, skipped: false, label,
      ...(note === undefined ? {} : { note }),
    })
    return nid
  }

  /**
   * 连一条边。
   *
   * ⚠️ **同一对端点、同一组出口/入口只许连一次**，重复直接抛错（2026-10-27 加）。
   *
   * 为什么要在生成期就拦住：重复边不会让节点跑两遍（`topo.ts` 的 `topoSort`
   * 按 `source\u0000target` 去过重），但 `run.ts:957` 的 `upstreamOf` 是按**原始
   * 边表**过滤的 —— 下游会拿到**两份相同的上游**。实测：
   * `[{"v":1}]` 变成 `[{"v":1},{"v":1}]`。
   * 现在没出错只是因为读的是 `input.v` 那种取第一个的写法，任何一处按上游个数
   * 或顺序取值都会静默拿坏值。
   *
   * 这个坑真实发生过：`build-douyin.mjs` 在 `addLoginRescue` 之外又重连了五行、
   * `build-tmall.mjs` 多连了一条 `ask → abort`，在存档里留下 6 组重复边。
   * `tests/archive-edges.mjs` 盯存档，这里盯**生成期**，两道都留。
   *
   * @param from - 源节点 id。
   * @param to - 目标节点 id。
   * @param handle - 源出口名（条件分流用）。
   * @param targetHandle - 目标入口名（默认 `in`）。
   */
  link(from, to, handle, targetHandle) {
    const th = targetHandle ?? 'in'
    /* 判重键与 `tests/archive-edges.mjs` 逐字同一条规则。 */
    const dup = this.edges.some(e =>
      e.source === from && e.target === to
      && (e.sourceHandle ?? '') === (handle ?? '')
      && (e.targetHandle ?? '') === th)
    if (dup) {
      throw new Error('link：重复连线 ' + from + ' →' + (handle === undefined ? '' : handle) + '→ '
        + to + '[in=' + th + ']。段内连线由 addLoginRescue 自己连好，调用方不要再连一遍。')
    }
    this.edges.push({
      id: 'e' + String(this.edges.length + 1),
      source: from, target: to,
      ...(handle === undefined ? {} : { sourceHandle: handle }),
      targetHandle: th,
    })
  }

  /**
   * 把一批节点归属到某个**容器**（循环）里。
   *
   * ⚠️ 循环的成员靠 `parentId` —— 调度器按它认「谁在循环体里」
   * （见 `src/workflow/loop.ts` 的 `containerMap`）。
   * 不设的话那些节点只是画布上的孤点，循环**不会**带它们跑。
   *
   * ## ⚠️⚠️ 必须同时把坐标**从绝对改成相对**（2026-10-20 修的真 BUG）
   *
   * React Flow 的 `parentId` 语义是「**子节点的 position 相对父节点**」。
   * 而 `add()` 画出来的坐标是**绝对**的（那是排布整张图时算的）。
   *
   * 原来这里只写了 `parentId`、没动坐标，后果是**整个循环体被平移一个框的原点、
   * 全部落到框外面**。实测 `取数-抖音电商罗盘` 的存档：
   *
   *   n3（循环框）在 (400, 120)
   *   n4 的 position 是 (760, -40)  ← 本该是绝对坐标
   *   → 真机显示成 (400+760, 120-40) = (1160, 80)  ← 比框顶还高 40
   *
   * 用户看到的就是「刚打开工作流，循环里的内容不在循环里」，
   * 而且**每份带循环的存档都是这样**（生成器统一这么写）。
   *
   * ## 只转一层够不够
   *
   * 够，**但必须按「由外到内」的顺序调用**：内层循环自己也是外层的成员，
   * 先给内层调用一次（相对其父），再给外层调用一次（这时内层的坐标
   * 已经是相对外层了，减一次外层原点就是最终值）。
   * 嵌套两层以上同理 —— 每一层都只减**自己父节点**的原点。
   *
   * ⚠️ 如果你在外层之后再调内层，内层会被减两次原点。**调用顺序是硬约束**，
   * 见各生成器里 `setParent` 的调用处（内层先）。
   *
   * @param ids - 成员节点 id。
   * @param containerId - 容器（循环）节点 id。
   */
  setParent(ids, containerId) {
    const box = this.nodes.find(n => n.id === containerId)
    if (box === undefined) throw new Error('setParent：没有这个容器 ' + containerId)
    const set = new Set(ids)
    for (const n of this.nodes) {
      if (!set.has(n.id)) continue
      /* 已经归属别的容器 → 说明调用顺序错了（先外后内），减两次原点会偏移。 */
      if (n.parentId !== undefined && n.parentId !== containerId) {
        throw new Error('setParent：' + n.id + ' 已归属 ' + n.parentId
          + '，不能改挂到 ' + containerId + '。嵌套循环要先内层、后外层调用。')
      }
      /* 绝对 → 相对：减去父框原点（只减一次）。 */
      n.position = { x: n.position.x - box.position.x, y: n.position.y - box.position.y }
      n.parentId = containerId
    }
  }

  /**
   * 产出存档。
   *
   * ⚠️ **2026-10-19 起带上稳定编号 `id`**（用户：「引用用编号不用名称」）。
   * 编号由名字派生（`deriveWorkflowId`），生成器与运行时同一份规则，
   * 所以「一键下载」这类组合层能直接算出子工作流的编号去引用。
   */
  doc() {
    const name = this.namePrefix + this.job
    return { version: 1, id: deriveWorkflowId(name), name, nodes: this.nodes, edges: this.edges }
  }
}

/**
 * 建一份巡查工作流（**一份 = 一个平台 + 一个任务**）。
 *
 * ## ⚠️ 2026-10-14 拆开：从 3 份混平台的变成 5 份单平台的
 *
 * 用户原话：「**将巡查根据平台、任务命名，如果当前有两个平台混在一起的就拆分。**」
 *
 * 拆之前 `shop` / `activity` 各混了两个平台（每份里两条链 + 一个合并节点）。
 * 拆开后**每份只有一个平台**，于是：
 *   · **不再有合并节点** —— 它存在的唯一理由就是合两个平台
 *   · **不再有「按有几个页面猜平台」的写法** —— 现在每份的 `platform` 是**显式**的
 *
 * ⚠️ 那些护栏一条都没少：夜禁判断、`onError: 'continue'` 的读配置、
 * 「配置边从条件的成立出口接」（否则夜禁跳过时解析会覆盖「未跑」结果）、
 * 「无论成败都写结果文件」。
 *
 * @param job - `PATROL_JOBS` 里的一项。
 * @returns 存档对象。
 */
function buildOne(job) {
  const spec = job
  /**
   * 这一份用哪段解析代码（按 `kind` 显式选，**不靠文字匹配**）。
   *
   * ⚠️ **第二个参数是这份工作流的短名**（进结果文件的 `job` 字段）——
   * 拆成「一平台一份」之后，解析器不能再把 `job` 写死成 `'shop'`/`'activity'`
   * （那会让五份结果文件都自称同一件事，面板分不清）。实测踩到：`job=undefined`。
   *
   * ⚠️ 解析代码**不放在 `jobs.mjs` 表里**，而是这里按 `kind` 选 ——
   * 那张表要能被测试单独引用（不该把几百行解析代码也拖进去）。
   */
  const parseCode =
    spec.kind === TASK_KINDS.activity ? codeParseActivity(spec.platform, spec.id)
      : spec.kind === TASK_KINDS.qianchuan ? codeParseQianchuan(spec.id, spec.platform)
        : codeParseShop(spec.platform, spec.id)
  const b = new Builder(spec.name, '')
  const Y = 120
  const x0 = 1400

  /* ⓪ 开始 —— 入口标记，**不声明输入**。
   *
   * ## 为什么一个输入都不声明（不是偷懒）
   *
   * 巡查的驱动数据全都不在外部：打开哪个页面在 ⑥、阈值在 ①② 读的配置里、
   * 时间由 ③ 现算 —— 巡查.bat 本身也没有任何命令行参数。
   * 声明一个没人读的输入，等于给用户挖一个「填了却没效果」的坑
   * （见 pitfalls/假防线-看着写了其实不生效.md）。
   *
   * ## 那为什么还要它
   *
   * 用户定案：**没有开始节点 = 这份工作流接不了外部输入**，而且它回答
   * 「谁能启动这份工作流」（type 参数）。总览板块按节点列流程时也靠它认出入口。
   *
   * ## ⚠️ 用固定 id start（不走自增）
   *
   * 补节点是在 n1..n10 已经写好之后做的。走自增就得把新节点插在**最前面**，
   * 于是 n1..n10 全部改名 —— 而测试/文档里按 id 指节点的写法会跟着错位。
   * 固定 id = 后加不动别人。见 Builder.add 的 id 参数说明。 */
  const start = b.add('flow.start', { type: 'manual', fields: [] },
    '⓪ 开始', 40, Y - 220, 'stop',
    '入口标记：这份巡查不接受外部输入 —— 跑哪个页面、阈值多少，都由 ① 读的配置与 ⑥ 的页面决定。',
    'start')

  /* ① 读配置 —— **碰外部世界** → 专用节点（按新判据，不写在 code 里）。
   *
   * ⚠️ `onError: 'continue'` 是这条链的关键：
   * 配置文件**不存在是正常情况**（那就用内置默认值）。设成 continue 后，
   * 这个节点失败会被跳过、上游原样传给下游 → 下一个节点拿到 `undefined`
   * → 解析配置那步就会走「用内置默认」那条。
   * 这比在 code 里 `import fs` + try/catch 更合判据，而且**画布上看得见**。 */
  const readCfg = b.add('sys.fs.read', { path: CONFIG_PATH, encoding: 'utf8' },
    '① 读配置（monitor.json）', 40, Y, 'continue',
    '读阈值配置。读不到就用内置默认值（所以这里设成「继续」而不是「停止」）。')

  /* ② 解析配置 —— **纯数据变换** → code.js。 */
  const parseCfg = b.add('code.js', { code: CODE_PARSE_CFG, timeout: 30000 },
    '② 解析配置（兜默认值）', 380, Y, 'stop',
    '把配置文本变成配置对象；文件没读到或内容不合法时用内置默认值，并在 configSource 里说明用了哪份。')

  /* ⓪ → ①：开始节点接在「读配置」前面，这样它不是孤点（画布上看得见顺序）。
   * ⚠️ 开始节点交出的值是**空对象**（没声明输入项），所以 ① 拿到的上游没变；
   * 而 ① 本来就设了「继续」，读不到配置时一样走默认值。 */
  b.link(start, readCfg)
  b.link(readCfg, parseCfg)

  /* ③ 算时间 —— 纯数据变换。 */
  const curfew = b.add('code.js', { code: codeCurfew(true), timeout: 30000 },
    '③ 算时间（夜禁判定）', 720, Y, 'stop',
    '算当前小时数。默认绕过夜禁（照 巡查.bat：手动跑一律带 --bypass-curfew）。')

  b.link(parseCfg, curfew)

  /* ④ 夜禁判断。 */
  const gate = b.add('flow.if', { expr: CURFEW_EXPR },
    '④ 能跑吗（夜禁 00:00-09:00）', 1060, Y, 'stop',
    '夜禁时段不跑（源码 run.ts：hour < 9 就退出）。成立 → 继续采集；不成立 → 写一份「未跑」结果。')

  b.link(curfew, gate)

  /* ⑤ 夜禁跳过时也要写一份结果 —— 否则面板看不到「今天没跑」。 */
  const skipDoc = b.add('code.js', {
    code: `return {
  job: ${JSON.stringify(spec.id)},
  platform: ${JSON.stringify(spec.platform)},
  task: ${JSON.stringify(spec.task)},
  runAt: new Date().toISOString(),
  dataDate: new Date().toLocaleDateString('sv'),
  ok: false,
  error: '夜禁时段（00:00-09:00）未跑',
  blocks: [],
}`,
    timeout: 30000,
  }, '⑤ 夜禁：生成「未跑」结果', 1060, Y + 460, 'stop',
    '夜禁时也要落一份结果文件 —— 面板据此知道「今天没跑」，而不是「文件不存在」。')

  b.link(gate, skipDoc, 'false')

  const skipWrite = b.add('sys.fs.write', { path: OUT_BASE + '/' + spec.outFile, mode: 'overwrite', mkdir: true },
    '⑤b 夜禁：写「未跑」结果', 1400, Y + 460, 'stop',
    '写结果文件。')

  b.link(skipDoc, skipWrite, undefined, 'content')

  /* ⑥ 打开页面 —— 碰外部世界。 */
  const open = b.add('browser.act', {
    action: 'goto', session: spec.tag, launcher: 'cdp', exePath: '',
    url: spec.url, waitUntil: 'domcontentloaded', timeout: 30000,
  }, '⑥ 打开页面（' + spec.tag + '）', x0, Y, 'stop',
    '在常驻的已登录浏览器里打开。会话标签「' + spec.tag + '」决定用哪个浏览器（在节点设置里配）。')

  b.link(gate, open, 'true')

  /* ⑦ 等页面渲染 —— 源码是 settleMs 6000。
   * ⚠️ 用 `flow.delay` 等而不是在 eval 里 sleep（那样会卡住页面主线程）。 */
  const wait = b.add('flow.delay', { ms: 6000, random: false },
    '⑦ 等页面渲染（' + spec.tag + '）', x0 + 340, Y, 'continue',
    '等 6 秒让异步内容渲染完（照源码的 settleMs 6000）。')

  b.link(open, wait)

  /* ⑧ 取整页文本 —— `document.body.innerText`，与源码的 `pageText` 等价。 */
  const text = b.add('browser.act', {
    action: 'eval', session: spec.tag, launcher: 'cdp', exePath: '',
    code: "return { text: document.body ? document.body.innerText : '' }",
    timeout: 30000,
  }, '⑧ 取整页文本（' + spec.tag + '）', x0 + 680, Y, 'stop',
    '取整页文本（innerText），与源码的 pageText 完全等价。')

  b.link(wait, text)

  /* ⑨ 解析判档 —— 纯数据变换。 */
  const parse = b.add('code.js', { code: parseCode, timeout: 30000 },
    '⑨ 解析判档（' + spec.tag + '）', x0 + 1020, Y, 'stop',
    '机械文本分析（照源码 text.ts 的「关键词邻近取值」）+ 阈值判档。纯数据变换，改规则只改这一处。')

  b.link(text, parse)
  /* ⚠️ 配置那条边要从**条件的成立出口**接过来，不能直接从「② 解析配置」接 ——
   * 那样夜禁跳过时它还是活的，解析会去跑、拿不到文本、把「未跑」结果覆盖掉。
   * 这是 2026-10-14 实测踩到并修掉的。 */
  b.link(gate, parse, 'true')

  /* ⑩ 写结果文件。
   *
   * ⚠️ **不论成败都写** —— 源码的约定：「采集失败需人工」也要让面板看到。
   * ⚠️ 拆开后**没有合并节点**：一份工作流只有一个平台，合成什么？ */
  const write = b.add('sys.fs.write', { path: OUT_BASE + '/' + spec.outFile, mode: 'overwrite', mkdir: true },
    '⑩ 写结果文件', x0 + 1700, Y, 'stop',
    '写结果文件（面板读它）。无论成败都写 —— 源码的约定：「采集失败需人工」也要让面板看到。')

  b.link(parse, write, undefined, 'content')

  /* ⑪ 结束 —— **2026-10-25 去掉**。
   *
   * 原来这里是一个 `flow.end`，声明两项：
   *   · 判档 = ⑨ 的输出（PatrolResult：job / platform / dataDate / ok / error /
   *     blocks，每块带 state 与 items）—— 总览板块靠它显示五张卡；
   *   · 结果文件 = ⑩ 的输出 { path, bytes }。
   *
   * 用户 2026-10-25 决定**存档里不再有结束节点**，所以节点与那条边都不建了，
   * ⑩ 写结果文件 就是这条链的尾。
   *
   * ⚠️ 节点定义（`src/nodes/flow/end/node.ts`）原样保留在节点库里。
   *
   * ⚠️⚠️ **这一份的代价是本轮最大的一处，必须知道**：
   * 判档结果原来**靠这个结束节点**命名成「判档」交出去。去掉之后，
   * 读它的一方（总览板块 / 别的流程）不能再按产出名取，只能自己去读
   * ⑩ 写下的那份结果文件 —— 两者内容同源（⑨ 的输入就是它，⑩ 写的是它）。
   *
   * 夜禁那支本来就走 ⑤/⑤b、⑨ 没跑，所以那一路的「判档」一直是 undefined，
   * 变化只落在正常采集那一路。 */

  /* ★ 说明（用户 2026-10-14 要求显示在列表里）。 */
  const doc = b.doc()
  doc.description = spec.name.replace('巡查-', '') + '：' + spec.task
  return doc
}



/* ── 生成 ─────────────────────────────────────────────────────────── */
if (!existsSync(OUT_DIR)) { mkdirSync(OUT_DIR, { recursive: true }) }
let built = 0
for (const job of PATROL_JOBS) {
  const doc = buildOne(job)
  const p = join(OUT_DIR, doc.name + '.json')
  writeFileSync(p, JSON.stringify(doc, null, 2), 'utf8')
  built += 1
  console.log('已写入 ' + p)
  console.log('  ' + String(doc.nodes.length) + ' 节点 / ' + String(doc.edges.length) + ' 连线')
  for (const n of doc.nodes) {
    console.log('    ' + n.id.padEnd(5) + n.defId.padEnd(16) + (n.label ?? ''))
  }
}

/* ── 「清洗入库」那份（另一串固定步骤，独立文件）────────────────────
 *
 * ⚠️ 它有自己的 Builder（job 名不同、路径参数不同），所以走另一个模块。
 * 三个 shell 脚本与清洗库**必须先落盘**（`code.shell` 的命令行塞不进几百行脚本）。 */
{
  const { buildIngest, writeShellScripts } = await import('./ingest/build.mjs')
  const steps = await import('./ingest/shell-steps.mjs')
  const cleanLibSource = readFileSync(new URL('./ingest/clean-lib.mjs', import.meta.url), 'utf8')
  const INGEST_PROJECT = 'D:/ecom-data/清洗入库'
  /** shell 脚本落盘目录（工作流里的命令指向它）。 */
  const SHELL_DIR = join(HOME, 'tmp', 'ewb-ingest')
  writeShellScripts(SHELL_DIR, steps, cleanLibSource, { mkdirSync: mkdirs, writeFileSync })
  console.log('')
  console.log('已落盘 shell 脚本到 ' + SHELL_DIR)

  const ingestDoc = buildIngest(Builder, {
    manifestPath: INGEST_PROJECT + '/manifest.json',
    dataRoot: 'D:/ecom-data/原始数据',
    dbPath: INGEST_PROJECT + '/ecom.db',
    projectDir: INGEST_PROJECT,
    shellDir: SHELL_DIR,
    cleanLibPath: SHELL_DIR + '/clean-lib.mjs',
  })
  const ip = join(OUT_DIR, ingestDoc.name + '.json')
  writeFileSync(ip, JSON.stringify(ingestDoc, null, 2), 'utf8')
  built += 1
  console.log('已写入 ' + ip)
  console.log('  ' + String(ingestDoc.nodes.length) + ' 节点 / ' + String(ingestDoc.edges.length) + ' 连线')
  for (const n of ingestDoc.nodes) console.log('    ' + n.id.padEnd(5) + n.defId.padEnd(12) + (n.label ?? ''))
}

/* ── 「天猫取数」那份（干活层，另一串固定步骤）──────────────────────
 *
 * ⚠️ 它的 shell 脚本（列目录 / 下载）也要落盘 —— 与 ingest 同一个理由
 * （`cmd /c` 的命令行塞不进脚本、也不该带引号）。 */
{
  const { buildTmall } = await import('./browser/build-tmall.mjs')
  const tmallShell = await import('./browser/tmall-shell.mjs')
  const tmallCode = await import('./browser/tmall-code.mjs')
  const loginCheckTm = await import('./browser/login-check.mjs')
  const TMALL_SHELL_DIR = join(HOME, 'tmp', 'ewb-tmall')
  mkdirs(TMALL_SHELL_DIR, { recursive: true })
  writeFileSync(join(TMALL_SHELL_DIR, 'tm-list-dirs.mjs'), tmallShell.TM_LIST_DIRS, 'utf8')
  writeFileSync(join(TMALL_SHELL_DIR, 'tm-download.mjs'), tmallShell.TM_DOWNLOAD, 'utf8')
  console.log('')
  console.log('已落盘天猫的 shell 脚本到 ' + TMALL_SHELL_DIR)

  const tmallDoc = buildTmall(Builder, {
    dataRoot: 'D:/ecom-data/原始数据',
    shellDir: TMALL_SHELL_DIR,
    outFile: OUT_BASE + '/tm-sycm.json',
    /* 页面内与纯逻辑那几段**由调用方传**（测试要单独引用它们，不该把生成器拖进来）。 */
    code: {
      fetchReports: tmallCode.TM_FETCH_REPORTS,
      filterToday: tmallCode.TM_FILTER_TODAY,
      trigger: tmallCode.TM_TRIGGER_AND_POLL,
      pickFilename: tmallCode.TM_PICK_FILENAME,
    },
    /* ★ 登录确认那一步（用户 2026-10-20）。与抖音共用同一份实现，
     * 只有判据不同（天猫看 login.htm，抖音看 /login）。 */
    login: {
      checkTm: loginCheckTm.LOGIN_CHECK_TM,
      failResult: loginCheckTm.loginFailResult,
    },
  })
  const tp = join(OUT_DIR, tmallDoc.name + '.json')
  writeFileSync(tp, JSON.stringify(tmallDoc, null, 2), 'utf8')
  built += 1
  console.log('已写入 ' + tp)
  console.log('  ' + String(tmallDoc.nodes.length) + ' 节点 / ' + String(tmallDoc.edges.length) + ' 连线')
  for (const n of tmallDoc.nodes) console.log('    ' + n.id.padEnd(5) + n.defId.padEnd(12) + (n.label ?? ''))
}

/* ── 「抖音表单下载」那份（最大的一份：**两次顺序循环**）────────────
 *
 * ⚠️ 嵌套循环被明确禁止（run.ts），所以拆成「循环A 模块」+「循环B 日期对」。
 * 详见 `scripts/browser/douyin-code.mjs` 的文件头。 */
{
  const { buildDouyin } = await import('./browser/build-douyin.mjs')
  const douyinShell = await import('./browser/douyin-shell.mjs')
  const douyinCode = await import('./browser/douyin-code.mjs')
  const loginCheck = await import('./browser/login-check.mjs')
  const DY_SHELL_DIR = join(HOME, 'tmp', 'ewb-douyin')
  mkdirs(DY_SHELL_DIR, { recursive: true })
  writeFileSync(join(DY_SHELL_DIR, 'dy-list-one.mjs'), douyinShell.DY_LIST_ONE, 'utf8')
  console.log('')
  console.log('已落盘抖音的 shell 脚本到 ' + DY_SHELL_DIR)

  const douyinDoc = buildDouyin(Builder, {
    dataRoot: 'D:/ecom-data/原始数据',
    shellDir: DY_SHELL_DIR,
    outFile: OUT_BASE + '/douyin-ui.json',
    code: {
      stepModules: douyinCode.DY_STEP_MODULES,
      shopTab: douyinCode.DY_SHOP_TAB,
      readR: douyinCode.DY_READ_R,
      /* ⚠️ 2026-10-19：`lastDate`（只算 L）+ `buildPairs`（把 7 个模块的日期
       * 展平成一张表）合成一步 `moduleDates` —— 每个模块在自己那一轮里算自己的日期。
       * 见 `build-douyin.mjs` 文件头「为什么必须嵌进去」。 */
      moduleDates: douyinCode.DY_MODULE_DATES,
      setDate: douyinCode.DY_SET_DATE,
      /* ⚠️ 下载是**两个函数**（各自把数据根写进脚本里），由 `flow.if` 按 btn 分流：
       * 下拉两下 vs 单按钮一下。传函数、不传算好的值 —— 由 `buildDouyin` 用同一个
       * `dataRoot` 调它们，避免数据根在两处各写一遍（那样迟早会漂，
       * 症状是「文件落到别的目录」，很难查）。
       *
       * ⚠️ 为什么两个分支都是代码节点、而不是用 `browser.download` 节点：
       * 那个节点定不出「带 8 位日期」的文件名，入库会静默取不到日期。
       * 完整理由见 `build-douyin.mjs` 文件头。 */
      downloadDropdown: douyinCode.downloadDropdown,
      downloadSingle: douyinCode.downloadSingle,
      filename: douyinCode.DY_FILENAME,
      roundGuard: douyinCode.DY_ROUND_GUARD,
      summary: douyinCode.DY_SUMMARY,
    },
    /* ★ 登录确认那一步（用户 2026-10-20）。两份取数工作流共用同一份实现，
     * 只有判据不同（各平台的登录页域名不一样）。 */
    login: {
      checkDy: loginCheck.LOGIN_CHECK_DY,
      failResult: loginCheck.loginFailResult,
    },
  })
  const dp = join(OUT_DIR, douyinDoc.name + '.json')
  writeFileSync(dp, JSON.stringify(douyinDoc, null, 2), 'utf8')
  built += 1
  console.log('已写入 ' + dp)
  console.log('  ' + String(douyinDoc.nodes.length) + ' 节点 / ' + String(douyinDoc.edges.length) + ' 连线')
  for (const n of douyinDoc.nodes) {
    console.log('    ' + n.id.padEnd(5) + n.defId.padEnd(16) + (n.parentId === undefined ? '' : '↳') + (n.label ?? ''))
  }
}

/* ── 千川全域推广（2026-10-19 新增，t28）──────────────────────────
 *
 * 源码里那两个 `qianchuan: true` 的模块走的是**完全不同的流程**
 * （区间滚动 / 每次导航后重选维度 / 幂等按「类型+区间结束日」），
 * 所以是**单独一份工作流**，不是罗盘那份里的一个分支。
 * 理由与逐条对照见 `scripts/browser/build-qianchuan.mjs` 的文件头。 */
{
  const { buildQianchuan } = await import('./browser/build-qianchuan.mjs')
  const qcCode = await import('./browser/qianchuan-code.mjs')
  const qcShell = await import('./browser/qianchuan-shell.mjs')
  const { LOGIN_CHECK_QC } = await import('./browser/login-check.mjs')
  const QC_SHELL_DIR = join(HOME, 'tmp', 'ewb-qianchuan')
  mkdirs(QC_SHELL_DIR, { recursive: true })
  writeFileSync(join(QC_SHELL_DIR, 'qc-list-one.mjs'), qcShell.QC_LIST_ONE, 'utf8')
  console.log('')
  console.log('已落盘千川的 shell 脚本到 ' + QC_SHELL_DIR)

  const qcDoc = buildQianchuan(Builder, {
    dataRoot: 'D:/ecom-data/原始数据',
    shellDir: QC_SHELL_DIR,
    outFile: OUT_BASE + '/qianchuan.json',
    /* 千川的「登录了吗」判据（与抖音/天猫**同形状**，结论放在 result.loggedIn）——
     * 好让 `login-gate.mjs` 那段救援逻辑三份共用，而不是各写一份。 */
    loginCheck: LOGIN_CHECK_QC,
    code: {
      stepModules: qcCode.QC_STEP_MODULES,
      checkLogin: qcCode.QC_CHECK_LOGIN,
      clickDim: qcCode.QC_CLICK_DIM,
      planTypes: qcCode.QC_PLAN_TYPES,
      typePlan: qcCode.QC_TYPE_PLAN,
      setRange: qcCode.QC_SET_RANGE,
      pickType: qcCode.QC_PICK_TYPE,
      /* ⚠️ 下载是**函数**（要把数据根写进脚本里），与抖音那份同一个理由：
       * 传函数、由 `buildQianchuan` 用同一个 `dataRoot` 调它 ——
       * 数据根只有一处来源，写两遍迟早会漂（症状是「文件落到别的目录」）。 */
      download: qcCode.qcDownload,
      roundGuard: qcCode.QC_ROUND_GUARD,
      summary: qcCode.QC_SUMMARY,
    },
  })
  const qp = join(OUT_DIR, qcDoc.name + '.json')
  writeFileSync(qp, JSON.stringify(qcDoc, null, 2), 'utf8')
  built += 1
  console.log('已写入 ' + qp)
  console.log('  ' + String(qcDoc.nodes.length) + ' 节点 / ' + String(qcDoc.edges.length) + ' 连线')
  for (const n of qcDoc.nodes) {
    console.log('    ' + n.id.padEnd(5) + n.defId.padEnd(16) + (n.parentId === undefined ? '' : '↳') + (n.label ?? ''))
  }
}

/* ── 组合层那两份（工作流调用工作流）─────────────────────────────
 *
 * 源码里是三个**纯转发**的 bat（只 `call` 子 bat，零逻辑）。
 * 按新判据它们是「一串固定步骤 → 一份工作流」，
 * 而这里用的「跑另一份工作流」节点照 n8n 的 Execute Sub-workflow。
 *
 * ⚠️ 2026-10-22：「一键下载」与「全部下载」合并成一份（用户决定），
 * 合并后按开始节点的「平台」参数分流（全部 / 天猫 / 抖音）。
 * 旧存档由生成器**顺手删掉** —— 手删的话下次重生成又会回来。
 *
 * ⚠️ 必须放在最后：它们引用的「抖音表单下载 / 天猫取数 / 清洗入库」
 * 都是上面刚写出去的 —— 子工作流名写错了只有运行时才报（不会在这里拦下）。 */
{
  const { writeCombine } = await import('./combine/build.mjs')
  const docs = writeCombine(Builder, {
    outDir: OUT_DIR,
    write: (p, text) => { writeFileSync(p, text, 'utf8') },
    remove: ['一键下载.json'],
  })
  for (const doc of docs) {
    built += 1
    console.log('已写入 ' + join(OUT_DIR, doc.name + '.json'))
    console.log('  ' + String(doc.nodes.length) + ' 节点 / ' + String(doc.edges.length) + ' 连线')
    for (const n of doc.nodes) {
      console.log('    ' + n.id.padEnd(5) + n.defId.padEnd(16) + (n.label ?? ''))
    }
  }
}
console.log('')
console.log('共生成 ' + String(built) + ' 份工作流。')
