/** 容器交互的**接线契约**测试（改名自 refit-base，2026-10-13）。
 *
 * ## 这个文件盯什么
 *
 * 它守的是「画布层怎么和容器纯逻辑接上」—— 那些**纯逻辑测不出**的东西：
 *   - 贴边函数必须基于「传入的数组」（读旧 ref 会把归属变更覆盖掉 —— 真 bug）；
 *   - `setNodes` 只调一次（两次会互相覆盖，分组框尺寸变化丢掉 —— 真 bug）；
 *   - 循环框先重排、再贴边（反了那一轮尺寸算错）；
 *   - **归属只能由「加节点时」与「右键菜单」两处改**（2026-10-13 起不再靠拖动）。
 *
 * ## ⚠️ 2026-10-13 大改：拖动改归属那套已删
 *
 * 用户定规矩「先看 n8n 与 Dify，**他们都没有的就不做**」，并指出循环
 * 「出入都不应该在里面的节点上」。而两家都**不靠拖动改容器归属**：
 *   - n8n：组成员由**连线**决定（连线时自动吸收 + 不合法就拒绝），
 *     没有拖进拖出，连「单个移出」都没有（只能整组解散）；
 *   - Dify：归属在**加节点那一刻**由邻居继承；已进容器的节点**拖动时被钳住**。
 *
 * 所以原来那些断言（悬停 1 秒、半进半出提示、连带移出、鼠标旁提示）
 * **整体作废**，换成「拖动**不许**改归属」+「显式菜单改归属」这两组。
 *
 * 跑法：node tests/refit-base.mjs
 */
import { readFileSync } from 'node:fs'

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
const SRC = readFileSync(ROOT + 'src/client/workbench/WorkflowCanvas.tsx', 'utf8')

console.log('=== 容器归属：只能由「加节点」与「右键菜单」改 ===')

/* ① **拖动不许改归属**（2026-10-13 的核心要求）。
 * 判据：那套东西的**关键标识符一个都不该还在**。
 * ⚠️ 注释里会提到它们（讲为什么删），所以查的是**代码里的调用/状态**，
 * 不是「出现过这个词」—— 否则注释会救活断言（本项目的经典假绿）。 */
{
  const codeOnly = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const gone = ['dropTarget', 'stepDragIntent', 'CONFIRM_MS', 'DragIntent',
    'setDragHint', 'setHoverCandidateId', 'setDropTargetId', 'setLeaveFromId',
    'hoverTimerRef', 'intentRef', 'pointerRef', 'applyIntent', 'countLeaveClosure',
    'removeWithClosure', 'leaveClosure', 'assignWithClosure']
  const left = gone.filter(k => codeOnly.includes(k))
  check('拖动改归属那一整套已删干净（代码里不留一个）', left.length === 0, left.join(', '))
  /* 拖动回调还在（位置与辅助线仍要它），但不许碰 parentId。 */
  const dragBody = /const onNodeDrag = useCallback\([\s\S]*?\n  \}, \[\]\)/.exec(codeOnly)?.[0] ?? ''
  check('onNodeDrag 还在（拖动本身没删）', dragBody !== '')
  check('onNodeDrag 里不许改 parentId', !/parentId/.test(dragBody))
  const stopBody = /const onNodeDragStop = useCallback\([\s\S]*?\n  \}, \[/.exec(codeOnly)?.[0] ?? ''
  check('onNodeDragStop 里不许改 parentId', !/parentId/.test(stopBody), stopBody.slice(0, 80))
}

/* ② 归属的两个**合法入口**必须都在。 */
{
  check('有「放入循环」（加节点之外的显式入口）', /const putIntoLoop = useCallback/.test(SRC))
  check('有「移出循环」', /const takeOutOfLoop = useCallback/.test(SRC))
  /* 两者都要走 `assignToContainer`（纯逻辑、有单测；不许自己手搓坐标换算）。 */
  const putBody = /const putIntoLoop = useCallback\([\s\S]*?\}, \[/.exec(SRC)?.[0] ?? ''
  const outBody = /const takeOutOfLoop = useCallback\([\s\S]*?\}, \[/.exec(SRC)?.[0] ?? ''
  check('「放入循环」走 assignToContainer', /assignToContainer\(/.test(putBody))
  check('「移出循环」走 assignToContainer', /assignToContainer\(/.test(outBody))
  /* 右键菜单里要挂上它们（有函数没入口 = 死代码）。 */
  check('右键菜单挂了「放入循环」', /putIntoLoop\(n\.id/.test(SRC))
  check('右键菜单挂了「移出循环」', /takeOutOfLoop\(n\.id/.test(SRC))
}

/* ③ 「加节点时按落点归属」（照 Dify 的「加的那一刻定」）。 */
{
  const addBody = /const addNode = useCallback\([\s\S]*?\n  \}, \[/.exec(SRC)?.[0] ?? ''
  check('addNode 里有落点判定（containerAt）', /containerAt\(/.test(addBody))
  check('落点在容器内时走 assignToContainer', /assignToContainer\(/.test(addBody))
  /* ⚠️ 容器自己不能被放进容器里（否则成环）—— 实现里有这条防。 */
  check('循环节点自己不被放进容器', /def\.id !== LOOP_DEF_ID/.test(addBody))
}

console.log('')
console.log('=== 贴边与重排（这两个曾出过真 bug）===')
{
  /* ⚠️ **2026-10-13 改**：编组换成名单模型后，`refitGroups` 整个删掉了 ——
   * 分组框的位置尺寸是**渲染时按成员包围盒算出来的**，没有任何存在节点上的
   * 尺寸要更新。所以下面只守**循环框**（它仍是 parentId 容器，仍需贴边）。
   *
   * 那族「贴边读到旧数组把改动覆盖掉」的 bug（我们曾为它专门改名重构）
   * 在分组一侧**从根上不存在**了 —— 这是换模型换来的好处。 */
  check('refitGroups 已删（分组框不需要贴边了）', !/const refitGroups = useCallback/.test(SRC))
  check('refitAll 不再调分组贴边', !/refitGroups\(/.test(SRC))
  /* 循环贴边仍然要。
   *
   * ⚠️ **2026-10-15 改判据**：原来这段逻辑住在 `refitAll` 里、并且它「只 setNodes 一次」
   * （两次会互相覆盖 —— 真 bug）。现在拆成两半：
   *   - `refitNodes`：**纯计算**，一次都不 setNodes（比原来更强）
   *   - `refitAll`  ：只负责 setNodes
   * 为什么拆：`refitAll` 原先带「无变化就不 setNodes」的条件，而调用方常常传
   * **刚 map 出来的新数组**（自动布局写新坐标）—— 那时若循环框恰好没变化，
   * 它会原样返回、被判定「无变化」→ **新坐标被静默丢掉**（「点自动布局没反应」）。
   * `dom-render` 的「间距 10 与 380 排出来不同」当场抓到了。
   *
   * 所以判据跟着挪到 `refitNodes` 上：**那里一个 setNodes 都不许有**。 */
  const calcBody = /const refitNodes = useCallback\([\s\S]*?\n  \}, \[\]\)/.exec(SRC)?.[0] ?? ''
  check('refitNodes 是纯计算（一个 setNodes 都没有）',
    ((calcBody.match(/setNodes\(/g) ?? []).length) === 0,
    String((calcBody.match(/setNodes\(/g) ?? []).length))
  /* **先重排、再贴边**（反了那一轮尺寸算错）。 */
  check('refitNodes 里先重排再贴边',
    calcBody.indexOf('relayoutInside(') > 0 && calcBody.indexOf('relayoutInside(') < calcBody.indexOf('fitLoopBox('))
  check('重排用最新的 edges', /relayoutInside\([^)]*edgesRef\.current/.test(calcBody))
  /* ── 方向：从 `dirRef` 读，且**不进依赖** ──
   *
   * 为什么钉这条：`relayoutInside` 要靠方向决定框内竖排还是横排。
   * 两个错法都不会报错、也不会崩：
   *   ① **写死方向**（不传方向 / 传常量）→ 框内永远一个朝向，
   *      用户切了画布方向，循环框里照样是反的那一边；
   *   ② **把 `dir` 写进依赖** → `refitNodes` 换引用 → `refitAll` 跟着换 →
   *      十几个回调和两个 effect 连锁重建。这个文件对这件事极其敏感
   *      （文件头记着一整族死循环），所以宁可钉死也不让人「顺手补一下依赖」。 */
  check('重排把方向传进去了（不是写死的一个朝向）',
    /relayoutInside\([^)]*dirRef\.current/.test(calcBody))
  check('refitNodes 的依赖**仍是空的**（方向走 dirRef，不许进依赖）',
    /\n  \}, \[\]\)/.test(calcBody))
  /* ⚠️ **锚到「整行就是一个赋值」**，不能用 `／dirRef\.current = dir／` 这种
   * 松散的写法 —— 第一版就是松的，而上面 `dirRef` 的注释里正好写着
   * 「见下面 `dirRef.current = dir` 那一行」，于是**注释把断言救活了**：
   * 真删掉同步那行，测试照样绿。（AGENTS.md 记过同型坑，我又踩了一次。）
   * 实测：删掉 `dirRef.current = dir` 那行 → 本条必须变红。 */
  check('dirRef 在渲染期同步（空依赖读到的才是最新方向）',
    /^    dirRef\.current = dir$/m.test(SRC))
  /* ── 循环框的遍历顺序：内层先、外层后 ──
   *
   * 为什么必须钉：外层给内层循环留位时要读内层**这一轮**的框尺寸。
   * 按数组原顺序走（`for (const n of next)`）就可能先排外层、
   * 读到内层上一轮的尺寸 → 内层框长出来之后压住外层的下一个成员。
   * 这个错**不报错、不崩、单测也测不出**（纯逻辑层只管单层），
   * 只能钉接线。 */
  check('★ 循环框按「内层先」的顺序遍历（不是数组原顺序）',
    /for \(const loopId of orderLoopsInnerFirst\(next\)\)/.test(calcBody))
  check('★ 遍历的是 id 列表（旧写法 `for (const n of next)` 会让顺序回到数组原序）',
    /for \(const n of next\)/.test(calcBody) === false)
  /* `refitAll` 只做一件事：把 `refitNodes` 的结果写回去。 */
  const allBody = /const refitAll = useCallback\([\s\S]*?\n  \}, \[refitNodes, setNodes\]\)/.exec(SRC)?.[0] ?? ''
  check('refitAll 只做一次 setNodes', ((allBody.match(/setNodes\(/g) ?? []).length) === 1,
    String((allBody.match(/setNodes\(/g) ?? []).length))
  check('refitAll 走 refitNodes（逻辑只有一份）', /refitNodes\(/.test(allBody))
  /* ④ 松手后无条件重算（用户报过「不拖一下框不变」）。
   *
   * ⚠️ **2026-10-26 改判据：原来锚的是依赖数组字面量 `}, [refitAll])`。**
   *
   * 旧写法：
   *   `const stopBody = /const onNodeDragStop = useCallback\([\s\S]*?\}, \[refitAll\]\)/.exec(SRC)?.[0] ?? ''`
   *
   * 它把「依赖数组恰好只有 `refitAll`」当成了行为判据。编组那一单给
   * `onNodeDragStop` 加了一个依赖（`syncGroupsAfterDrag`），数组变成
   * `[refitAll, syncGroupsAfterDrag]` —— **正则匹配不到，`stopBody` 是空串，
   * 断言直接红**，而代码里 `refitAll(nodesRef.current)` 明明还在。
   * 那不是真回归，是判据锚在了不相干的东西上（依赖数组 ≠ 行为）。
   *
   * 新写法：只锚「函数体结束」（`\n  }, [`），不关心依赖数组里有几项。
   * ⚠️ 用**去掉注释**的源码（`stopSrc`）：下面要按「`refitAll(` 前面有没有 `return`」判，
   * 注释里提到 return 会被算进去（本项目被注释救活过断言，吃过亏）。
   */
  const stopSrc = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  const stopBody = /const onNodeDragStop = useCallback\([\s\S]*?\n  \}, \[/.exec(stopSrc)?.[0] ?? ''
  check('找得到 onNodeDragStop 的函数体（空断言防护）', stopBody.length > 0)
  check('松手后无条件贴边', /refitAll\(/.test(stopBody))

  /* ★★ **真回归的判据**：「有组时 `refitAll` 仍被调用」。
   *
   * 上一版这里只有一个 `refitAll(` 是否出现 —— 而**「出现了但被 return 跳过」照样通过**
   * （这正是我 CE 那笔自检出来的假绿形态：判「出现过」而不判「真的会执行」）。
   *
   * 所以这里钉两件具体的事：
   *   ① `refitAll` 的调用**必须排在所有 `return` 之后**（或者说：它前面不许有条件 return）；
   *   ② 那个条件块本身**不许带 `return`**。
   *
   * 判法：取 `refitAll(` 那一次调用的位置，检查它之前那段里**没有** `return`。
   * —— 函数体里除了最后那句，任何提前 return 都会把贴边跳过。 */
  const refitAt = stopBody.indexOf('refitAll(')
  const before = refitAt < 0 ? '' : stopBody.slice(0, refitAt)
  check('★★ `refitAll` 之前不许有任何提前 return（有组时贴边也照样跑）',
    refitAt >= 0 && !/\breturn\b/.test(before),
    refitAt < 0 ? '`onNodeDragStop` 里找不到 refitAll 调用'
      : (/\breturn\b/.test(before) ? 'refitAll 之前出现了 return —— 贴边会被跳过' : ''))
  /* ⚠️ 这一段**不能用正则匹配那个 if 块**：多试过两种写法都失败 ——
   *   ① `/if \([^)]*GROUP_NODE_TYPE[^)]*\) \{/`：条件里 `some(n => …)` 自带 `)`，`[^)]*` 断了；
   *   ② `/if \([\s\S]*?GROUP_NODE_TYPE[\s\S]*?\) \{([\s\S]*?)\n    \}/`：源码是 **CRLF**，
   *      `\n    \}` 对不上 `\r\n    \r\n    }`。
   * 改成**按位置切片**：从 `GROUP_NODE_TYPE` 到 `refitAll(` 之间那一段就是「组那一块 + 中间」，
   * 直接看里面有没有 `return`。这条判据不依赖缩进、不依赖换行符。 */
  const grpAt = stopBody.indexOf('GROUP_NODE_TYPE')
  const grpBlock = grpAt < 0 || refitAt < 0 ? '' : stopBody.slice(grpAt, refitAt)
  check('★★ 编组同步那一块是**条件执行、不是条件返回**（有 `syncGroupsAfterDrag(moved)`、没有 `return`）',
    grpBlock.includes('syncGroupsAfterDrag(moved)') && !/\breturn\b/.test(grpBlock),
    grpBlock === '' ? '在 onNodeDragStop 里找不到 GROUP_NODE_TYPE 那一块'
      : (/\breturn\b/.test(grpBlock) ? '组那一块里出现了 return —— 贴边会被跳过' : ''))

  /* ⚠️⚠️ **挂载时那次自动布局必须走函数式 setNodes**（2026-10-15 我自己踩的坑）。
   *
   * ## 那个坑的形态（`browser-two-layers` 当场抓到 4 条红）
   *
   * 那个 `useEffect` 的依赖是 `[]`（「只在挂载时跑一次」），闭包里的 `nodes`
   * 是**首帧那一份** —— 而存档是异步 `fetch` 回来的，首帧往往是**空数组**。
   *
   * 原来写的是 `setNodes(ns => ns.map(...))`：即使 `pos` 算出来是空表，
   * 也只是「谁都不动」，后来加载的节点安然无恙。
   *
   * 我为了接上 `refitNodes` 改成了 `refitAll(nodes.map(...))` —— 传值。
   * 于是首帧那次 `setNodes(空数组)` 把**后来加载的节点整个覆盖掉**：
   * 画布空白 → 节点编辑区都找不到 → `[class*="_block"]` 不存在、
   * 切来源后界面不更新。**这是静默的**（不报错、不崩）。
   *
   * ## 判据为什么这么写
   *
   * 不能只查「有没有调用 refitNodes」——传值那版也调了。要查的是
   * **`setNodes` 的回调形态**：这段里每一个 `refitNodes(...)` 都必须出现在
   * `setNodes(ns => ...)` 的箭头函数体里。
   *
   * 具体做法：从「只在挂载时跑一次」那个标记**往回**找到最近的一个
   * `useEffect(() => {`（那个标记写在 effect 的尾巴上，往前才是函数体），
   * 要求这段里 ① 含 `setNodes(ns =>`；② **不含** `refitAll(`（那是传值的写法）。
   * 改回 `refitAll(nodes.map(...))` 会立刻让 ② 失败 —— 已验证。 */
  const markAt = SRC.indexOf('只在挂载时跑一次')
  const bodyStart = markAt > 0 ? SRC.lastIndexOf('useEffect(() => {', markAt) : -1
  const mountRaw = bodyStart > 0 ? SRC.slice(bodyStart, markAt) : ''
  /* ⚠️ **必须把注释剥掉再查**（否则注释里那句「不能写成 `refitAll(...)`」
   * 会把自己判成违规 —— 我第一版就撞上了）。
   *
   * 这与 AGENTS.md 里那条教训是**同一枚硬币的反面**：那里是「注释里的同一串
   * 救活了本该失败的断言」（假绿），这里是「注释里的同一串让本该通过的失败」。
   * 两种都说明**断言不能连注释一起扫**。 */
  const mountBody = mountRaw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  /* 先确认抠对了段（否则后面几条是**空断言**，永远绿）。 */
  check('找得到「挂载时那次自动布局」这段（空断言防护）',
    mountBody.includes('elkLayout(') && mountBody.includes('refitNodes('),
    String(mountBody.length) + ' 字符')
  check('挂载时的自动布局走函数式 setNodes（防闭包拿到首帧的空 nodes）',
    /setNodes\(ns\s*=>/.test(mountBody))
  check('挂载时的布局**不许**写成传值的 refitAll(...)（那会覆盖掉后加载的节点）',
    !/refitAll\(/.test(mountBody),
    (mountBody.match(/refitAll\(/g) ?? []).length + ' 处')
  check('挂载时的布局接了 refitNodes（成员的框内排列与框尺寸要一起算）',
    /refitNodes\(/.test(mountBody))
}

console.log('')
console.log(failed === 0 ? '结论：容器接线契约全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
