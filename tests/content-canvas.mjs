/** 内容画布（契约 AY，计划 §三 Step 3）：画布库、五种节点、结果落位、撤销。
 *
 * ## 这个测试现在分**两个文件**（2026-10-26 拆，起因是它破了 20 秒慢测线）
 *
 * | 文件 | 管什么 |
 * |---|---|
 * | 本文件 | ①–⑧：纯函数、画布库、骨架 tab 条、五种节点、自动保存、交互补全、编组 |
 * | `content-canvas-ops.mjs` | ⑨–㉒：生成链路、参考图、拖放、批量、@ 提及、蒙版、扩分、提交时解析提及 |
 *
 * 底座（jsdom、假宿主、挂载器、DOM 小工具）在 `_canvas-harness.mjs`，两边共用一份。
 *
 * ## 为什么拆、账是怎么算的
 *
 * 拆前：2927 行 / **20.7 秒**（`scripts/run-tests.mjs:106` 的 `SLOW_MS` 是 20 秒，已破线）。
 * 耗时构成是**包一层计时量出来的**，不是估的：
 *
 * ```
 * act 累计     11.4s（281 次）   ← React 真渲染 + effect flush
 * settle 累计   7.7s（145 次）   ← 等任务队列跑空
 * 其余          0.6s             ← 同步断言 / 纯函数 / 模块加载
 * ```
 *
 * 三笔加起来 19.7 秒 ≈ 总耗时，也就是说 96% 的时间花在「真渲染」与「真等待」上，
 * **没有一笔是可以白省的**。所以没有「优化」余地，只能拆成两个进程各跑一半。
 *
 * ⚠️ 拆的时候**一次 `settle` 都没删、轮次也没调小** —— 那是「把测试调成刚好够慢」，
 * 本项目踩过（见 `tests/_wait.mjs` 的头注）。拆前后都是 145 次 `settle` / 281 次 `act`。
 *
 * ## 宿主是**桩**，不是真的
 *
 * 宿主半那条路由（`src/index.ts` 的 `/canvases`）已经上线，但它是**进程内路由**，
 * 这个测试跑在 Node 里、没有那个 server。所以按 `src/schedule/canvases.ts` 的
 * **真实返回形状**造一份内存宿主（在 `_canvas-harness.mjs` 里）。
 *
 * ⚠️ 说清楚这一点很重要：本测试证明的是「界面按那个形状收发」，**不是**
 * 「真宿主通了」。真宿主那条路由由 `tests/canvases.mjs` 验。
 *
 * 跑法：`node scripts/run-tests.mjs content-canvas`（会自动带 tsx loader）
 */
import { readFileSync } from 'node:fs'
import { createEnv } from './_canvas-harness.mjs'

const env = await createEnv()
const {
  window, React, act,
  mkDoc,
  mount, click,
  settle, waitUntil,
  ContentCanvas,
  getFailed,
} = env
const S = env.S
const check = env.check

console.log('=== ① 纯函数：结果落位、撤销栈上限、防抖 ===')
const store = await import('../src/client/workbench/content-canvas-store.ts')
{
  const { newNode, placeResult, isEmptyNode } = store

  /* 空占位 → 填它自己。 */
  const blankImg = newNode('image', { x: 0, y: 0 })
  check('空图片节点算「空占位」', isEmptyNode(blankImg))
  const r1 = placeResult([blankImg], blankImg.id, { artifact: 'art-1' })
  check('★★ 空占位：结果填进它自己（不是另起一个）',
    r1.placed === 'self' && r1.nodes.length === 1 && r1.nodes[0].data.artifact === 'art-1',
    '放置方式=' + r1.placed + ' 节点数=' + String(r1.nodes.length))
  check('★ 原节点 id 不变（填的是同一个节点，不是换了一个）', r1.nodes[0].id === blankImg.id)

  /* 已有内容 → 右边长一个，原图不动。 */
  const filled = r1.nodes[0]
  const r2 = placeResult([filled], filled.id, { artifact: 'art-2' })
  check('★★ 已有内容：在右边长一个新节点（原图不动）',
    r2.placed === 'right' && r2.nodes.length === 2,
    '放置方式=' + r2.placed + ' 节点数=' + String(r2.nodes.length))
  check('★ 原图那张还在、内容没被改', r2.nodes[0].data.artifact === 'art-1')
  const grown = r2.nodes[1] ?? { position: { x: -1, y: -1 }, data: {} }
  check('★ 新节点在它右边（x 更大、y 相同）',
    grown.position.x > filled.position.x && grown.position.y === filled.position.y,
    '原 x=' + String(filled.position.x) + ' 新 x=' + String(grown.position.x))
  check('★ 新节点内容就是这次结果', grown.data.artifact === 'art-2')

  /* 生成配置：不是空占位，结果另起一个「它要生成的那种」节点，配置一个字不改。 */
  const cfg = newNode('config', { x: 100, y: 100 }, { genType: 'video', count: 2 })
  check('★ 生成配置永远不算空占位（它描述要生成什么，不是内容）', !isEmptyNode(cfg))
  const r3 = placeResult([cfg], cfg.id, { artifact: 'vid-1' })
  check('★ 配置节点出结果时另起一个视频节点',
    r3.placed === 'right' && r3.nodes.length === 2 && r3.nodes[1].type === 'video')
  check('★ 配置本身没被改成产出物', r3.nodes[0].data.artifact === undefined && r3.nodes[0].data.genType === 'video')

  /* 目标不存在：什么都不做（不许悄悄新建）。 */
  const r4 = placeResult([blankImg], 'nope', { artifact: 'x' })
  check('★ 目标节点不存在时什么都不做（placed=none）', r4.placed === 'none' && r4.nodes.length === 1)

  /* 文本节点：空文本算空占位。 */
  const blankText = newNode('text', { x: 0, y: 0 }, { text: '   ' })
  check('★ 只有空白的文本节点算空占位', isEmptyNode(blankText))
}

{
  const { createHistory, snapshotOf, HISTORY_LIMIT } = store

  /* 摆三个节点 → 撤销 → 两个。 */
  const h = createHistory()
  const base = snapshotOf([], [], { x: 0, y: 0, zoom: 1 })
  h.record(base)                                    /* 改动前：0 个 */
  let cur = { ...base, nodes: [store.newNode('text', { x: 0, y: 0 })] }
  h.record(snapshotOf(cur.nodes, cur.edges, cur.viewport))   /* 改动前：1 个 */
  cur = { ...cur, nodes: [...cur.nodes, store.newNode('image', { x: 100, y: 0 })] }
  h.record(snapshotOf(cur.nodes, cur.edges, cur.viewport))   /* 改动前：2 个 */
  cur = { ...cur, nodes: [...cur.nodes, store.newNode('video', { x: 200, y: 0 })] }

  check('摆三个节点之后是三个', cur.nodes.length === 3)
  const u1 = h.undo(cur)
  check('★★ 撤销一次回到两个', u1 !== null && u1.nodes.length === 2,
    '实际=' + String(u1 === null ? 'null' : u1.nodes.length))
  const u2 = h.undo(u1)
  check('★ 再撤一次回到一个', u2 !== null && u2.nodes.length === 1,
    '实际=' + String(u2 === null ? 'null' : u2.nodes.length))
  const re1 = h.redo(u2)
  check('★★ 重做一次回到两个', re1 !== null && re1.nodes.length === 2,
    '实际=' + String(re1 === null ? 'null' : re1.nodes.length))
  const re2 = h.redo(re1)
  check('★ 再重做回到三个', re2 !== null && re2.nodes.length === 3,
    '实际=' + String(re2 === null ? 'null' : re2.nodes.length))
  check('★ 没有更多可重做时给 null（按钮该灰）', h.redo(re2) === null)

  /* 栈上限 50：推 60 次只留 50。 */
  const h2 = createHistory()
  for (let i = 0; i < 60; i += 1) {
    h2.record(snapshotOf([store.newNode('text', { x: i, y: 0 })], [], { x: 0, y: 0, zoom: 1 }))
  }
  check('★ 栈上限是 50（常量没被改）', HISTORY_LIMIT === 50, '实际=' + String(HISTORY_LIMIT))
  check('★★ 推 60 次只留 50（多的从最早那边丢）', h2.depths().past === 50,
    '实际=' + String(h2.depths().past))
  /* 丢的是最早的：撤到底应该停在第 10 次那一份（x=10），不是第 0 次。
   *
   * ⚠️ 循环写到**撤不动为止**（上限 200 次保险），不写死 50 次 ——
   * 写死 50 次的话，「栈上限被去掉」这个改动只让上面那条变红，这条照样绿
   * （撤 50 次无论有没有上限都落在第 10 份）。自证二第一次就是这么漏的。 */
  let last = snapshotOf([], [], { x: 0, y: 0, zoom: 1 })
  for (let i = 0; i < 200; i += 1) {
    const prev = h2.undo(last)
    if (prev === null) break
    last = prev
  }
  check('★★ 撤到底停在「还留着的最早那一版」（不是第 0 版）',
    last.nodes.length === 1 && last.nodes[0].position.x === 10,
    '实际 x=' + String(last.nodes[0]?.position.x))
}

{
  /* 防抖：连排三次只存一次，最后一次的内容。 */
  const { createAutosave, AUTOSAVE_DELAY } = store
  const saved = []
  const a = createAutosave(s => { saved.push(s) }, 30)
  a.queue({ nodes: [], edges: [], viewport: { x: 1, y: 0, zoom: 1 } })
  a.queue({ nodes: [], edges: [], viewport: { x: 2, y: 0, zoom: 1 } })
  a.queue({ nodes: [], edges: [], viewport: { x: 3, y: 0, zoom: 1 } })
  await new Promise(r => setTimeout(r, 120))
  check('★★ 连续三次改动只落一次盘（防抖生效）', saved.length === 1, '实际存了 ' + String(saved.length) + ' 次')
  check('★ 存的是最后一次那份', saved[0]?.viewport.x === 3)

  /* flush：立刻存掉排队那次（切走画布前用）。 */
  const saved2 = []
  const b = createAutosave(s => { saved2.push(s) }, 5000)
  b.queue({ nodes: [], edges: [], viewport: { x: 9, y: 0, zoom: 1 } })
  b.flush()
  check('★ flush 立刻存掉排队那次（不用等到防抖时间）', saved2.length === 1 && saved2[0].viewport.x === 9)

  /* 取消：那一笔不存。 */
  const saved3 = []
  const c = createAutosave(s => { saved3.push(s) }, 30)
  c.queue({ nodes: [], edges: [], viewport: { x: 7, y: 0, zoom: 1 } })
  c.cancel()
  await new Promise(r => setTimeout(r, 100))
  check('★ cancel 之后那一笔不存', saved3.length === 0)

  check('防抖时长是 400ms 量级（计划 §三 3.1）', AUTOSAVE_DELAY >= 300 && AUTOSAVE_DELAY <= 600,
    String(AUTOSAVE_DELAY) + 'ms')
}


/* ── 五种节点各自渲染出正确形态 ─────────────────────────────────────── */
{
  /* 一份**每种节点都有内容**的画布 —— 这样能一次看全五种形态。 */
  S.mem.set('cv_shapes', mkDoc('cv_shapes', '五种节点', [
    { id: 'n_text', type: 'text', position: { x: 0, y: 0 }, data: { text: '一段文字' } },
    { id: 'n_img', type: 'image', position: { x: 340, y: 0 }, data: { artifact: 'art-abc' } },
    { id: 'n_vid', type: 'video', position: { x: 680, y: 0 }, data: { artifact: 'art-vid' } },
    { id: 'n_aud', type: 'audio', position: { x: 1020, y: 0 }, data: { artifact: 'art-aud' } },
    { id: 'n_cfg', type: 'config', position: { x: 1360, y: 0 }, data: { genType: 'image', model: 'gpt-image-1', count: 2 } },
  ]))

  const m = await mount(React.createElement(ContentCanvas, {
    canvasId: 'cv_shapes', active: true, onClose: () => {},
  }), 900)
  const q = sel => m.el.querySelector(sel)

  check('画布挂上了（React Flow 视口在）', q('.react-flow__viewport') !== null)
  const nodeEls = () => [...m.el.querySelectorAll('.react-flow__node')]
  check('五个节点都渲染出来了', nodeEls().length === 5, '实际 ' + String(nodeEls().length))

  const nodeOf = (id) => m.el.querySelector('.react-flow__node[data-id="' + id + '"]')

  /* 文本：**平时不是输入框**（契约 CD 第五节：单击只开面板，双击才进编辑）。
   *
   * ⚠️ 这条判据在 2026-10-26 契约 CD 时**改准了**，不是放宽：
   * 用户 m01076 的诉求是「文本节点不应该单击就编辑，单击展开设置，双击才直接编辑」。
   * 所以「默认渲染成 textarea」从「对」变成了「错」—— 现在默认必须是只读的那一块文字。
   * 「双击之后进编辑」那条判据在 ⑩ 段单独验。 */
  const textView = nodeOf('n_text')?.querySelector('[data-ewb-content-textview]')
  const textAreaIdle = nodeOf('n_text')?.querySelector('[data-ewb-content-text]')
  check('★★ 文本节点平时**不是**输入框（单击不进编辑）', textAreaIdle === null && textView !== null)
  check('★ 平时显示的是存下来的那段字', (textView?.textContent ?? '').includes('一段文字'),
    '实际=' + (textView?.textContent ?? '（空）'))
  /* 「没有标题栏」怎么验：**名称只在那个悬浮标签里出现一次**，且节点里
   * 没有第二处常驻显示它的地方（没有一行占位的标题文字）。
   *
   * ⚠️ 判据不能是「节点里没有『文本』这两个字」—— 悬浮标签本身带着它
   * （那是设计的一部分，计划 §三 3.2「名称只在悬浮时出现」）。
   * 所以判据落在**出现次数**上：整棵节点里「文本」只出现 1 次，且那一次在
   * `data-ewb-content-name` 里。标题栏如果真的存在，必然多出一处。 */
  const textNodeEl = nodeOf('n_text')
  const nameCount = (textNodeEl?.textContent ?? '').split('文本').length - 1
  check('★★ 文本节点**没有标题栏**（名称只以悬浮标签出现一次）',
    nameCount === 1
      && (textNodeEl?.querySelector('[data-ewb-content-name]')?.textContent ?? '') === '文本',
    '节点文字里「文本」出现 ' + String(nameCount) + ' 次：' + (textNodeEl?.textContent ?? '').slice(0, 40))
  /* 而且那个标签平时是看不见的（`opacity: 0`），悬浮才出现 —— 查样式源码，
   * 因为 jsdom 不算样式（CSS Modules 在这里是空对象）。 */
  const cssSrc = readFileSync(new URL('../src/client/workbench/EcomWorkbench.module.css', import.meta.url), 'utf8')
  const nameRule = /\.contentNodeName\s*\{([^}]*)\}/.exec(cssSrc)?.[1] ?? ''
  check('★★ 名称标签平时透明（opacity: 0），悬浮 / 选中才显形',
    /opacity:\s*0/.test(nameRule) && /hover[^{]*\{[^}]*opacity:\s*1/.test(cssSrc),
    nameRule.replace(/\s+/g, ' ').slice(0, 60))

  /* 图片：就是那张图，`src` 指向宿主半的二进制路由。 */
  const img = nodeOf('n_img')?.querySelector('[data-ewb-content-img]')
  check('★★ 图片节点渲染 <img>', img !== null && img.tagName.toLowerCase() === 'img')
  check('★ 图片地址走宿主半的产物路由',
    (img?.getAttribute('src') ?? '').startsWith('/api/ecom-workbench/artifact/'),
    img?.getAttribute('src') ?? '（没有 src）')

  /* 视频：播放器。 */
  const vid = nodeOf('n_vid')?.querySelector('[data-ewb-content-video]')
  check('★★ 视频节点渲染 <video> 且带播放控件',
    vid !== null && vid.tagName.toLowerCase() === 'video' && vid.hasAttribute('controls'))

  /* 音频：播放控件。 */
  const aud = nodeOf('n_aud')?.querySelector('[data-ewb-content-audio]')
  check('★★ 音频节点有播放控件',
    aud !== null && aud.tagName.toLowerCase() === 'audio' && aud.hasAttribute('controls'))

  /* 生成配置：五个设置都在，且**没有出口**。 */
  const cfg = nodeOf('n_cfg')
  check('★ 生成配置有类型切换', cfg?.querySelector('[data-ewb-config-type="image"]') !== null)
  check('★ 生成配置有模型', cfg?.querySelector('[data-ewb-config-model]') !== null)
  check('★ 生成配置有尺寸', cfg?.querySelector('[data-ewb-config-size]') !== null)
  check('★ 生成配置有张数', cfg?.querySelector('[data-ewb-config-count]') !== null)
  check('★ 生成配置有「走哪份工作流」', cfg?.querySelector('[data-ewb-config-workflow]') !== null)

  /* ★★ 验收 5：生成配置**没有出口**。
   *
   * 判据落在 React Flow 渲染出来的 handle 上：`source` 类名就是出口，
   * `target` 是入口。参考项目的 Config 只有入口。 */
  const cfgHandles = [...(cfg?.querySelectorAll('.react-flow__handle') ?? [])]
  const cfgSources = cfgHandles.filter(h => h.classList.contains('source'))
  const cfgTargets = cfgHandles.filter(h => h.classList.contains('target'))
  check('★★ 生成配置节点**没有出口**（source handle 数为 0）',
    cfgSources.length === 0, '实际的出口数=' + String(cfgSources.length))
  check('★ 生成配置有一个入口（target handle 数为 1）',
    cfgTargets.length === 1, '实际的入口数=' + String(cfgTargets.length))

  /* 对照：图片节点**有**出口 —— 否则上一条可能只是因为「所有节点都没有 handle」。 */
  const imgSources = [...(nodeOf('n_img')?.querySelectorAll('.react-flow__handle.source') ?? [])]
  check('★ （对照）图片节点**有**出口（说明上一条不是「全都没有」）',
    imgSources.length === 1, '实际=' + String(imgSources.length))

  m.unmount()
}

/* ── 改一下就自动保存：请求体里带 nodes / edges / viewport ──────────── */
{
  S.mem.set('cv_autosave', mkDoc('cv_autosave', '自动保存', [
    { id: 'a1', type: 'image', position: { x: 0, y: 0 }, data: {} },
  ]))
  S.puts.length = 0
  const m = await mount(React.createElement(ContentCanvas, {
    canvasId: 'cv_autosave', active: true, onClose: () => {},
  }), 800)
  const addBtn = m.el.querySelector('[data-ewb-canvas-add="text"]')
  check('工具条上有「文本」按钮', addBtn !== null)
  await click(addBtn)
  /* ★ 等「自动保存真的发出、且请求体里有 2 个节点」——
   * 防抖是 400ms（`content-canvas-store.ts` 的 `AUTOSAVE_DELAY`），
   * 那属于产品行为，等它而不是空转。 */
  await waitUntil(() => {
    const b = S.puts[S.puts.length - 1]?.body
    return Array.isArray(b?.nodes) && b.nodes.length === 2
  }, 3000)

  check('★★ 改动之后自动保存发了 PUT', S.puts.length >= 1, '实际发了 ' + String(S.puts.length) + ' 次')
  const body = S.puts[S.puts.length - 1]?.body ?? {}
  check('★ 请求体带 nodes', Array.isArray(body.nodes))
  check('★ 请求体带 edges', Array.isArray(body.edges))
  check('★ 请求体带 viewport（三个数）',
    body.viewport !== null && typeof body.viewport === 'object'
      && typeof body.viewport.x === 'number' && typeof body.viewport.zoom === 'number')
  check('★★ 新加的节点真的进了请求体（2 个）',
    Array.isArray(body.nodes) && body.nodes.length === 2,
    '实际 ' + String(Array.isArray(body.nodes) ? body.nodes.length : '?') + ' 个')
  /* ★ 只存要存的那几个键：`selected` / `measured` / `dragging` 这些运行态一个都不许落盘。 */
  const leaked = (body.nodes ?? []).flatMap(n => Object.keys(n)).filter(k =>
    k === 'selected' || k === 'measured' || k === 'dragging' || k === 'positionAbsolute')
  check('★★ 运行态字段没有被写进画布文件（selected / measured / dragging 一个都没有）',
    leaked.length === 0, leaked.join('、'))

  /* 撤销到 1 个：证明撤销真的接在界面上（不只是纯函数里对）。 */
  const undoBtn = m.el.querySelector('[data-ewb-canvas-undo]')
  check('撤销按钮在（加了节点之后可点）', undoBtn !== null && undoBtn.disabled !== true)
  await click(undoBtn)
  await waitUntil(() => (S.puts[S.puts.length - 1]?.body?.nodes ?? []).length === 1, 3000)
  const afterUndo = S.puts[S.puts.length - 1]?.body ?? {}
  check('★★ 界面上按撤销之后节点回到 1 个',
    Array.isArray(afterUndo.nodes) && afterUndo.nodes.length === 1,
    '实际 ' + String(Array.isArray(afterUndo.nodes) ? afterUndo.nodes.length : '?') + ' 个')

  const redoBtn = m.el.querySelector('[data-ewb-canvas-redo]')
  await click(redoBtn)
  await waitUntil(() => (S.puts[S.puts.length - 1]?.body?.nodes ?? []).length === 2, 3000)
  const afterRedo = S.puts[S.puts.length - 1]?.body ?? {}
  check('★★ 重做之后又回到 2 个',
    Array.isArray(afterRedo.nodes) && afterRedo.nodes.length === 2,
    '实际 ' + String(Array.isArray(afterRedo.nodes) ? afterRedo.nodes.length : '?') + ' 个')

  m.unmount()
}

/* ── 撤销**不删产物**（验收 8）───────────────────────────────────────── */
{
  /* 判据落在**行为**上：撤销之后画布上那个节点没了，但产物库那条还在。
   *
   * 这里没有真产物库（Step 4 才有），所以用两条能验的东西钉住：
   *   ① 撤销只发 `PUT /canvases/<id>`，**一次删除请求都没发**（不删文件）；
   *   ② 源码里撤销那一段**没有**任何删产物的调用。
   * ② 是防回归的：将来有人「顺手」在撤销里加一句删产物，这条立刻红。 */
  S.mem.set('cv_nodel', mkDoc('cv_nodel', '撤销不删产物', [
    { id: 'p1', type: 'image', position: { x: 0, y: 0 }, data: { artifact: 'art-keep' } },
    { id: 'p2', type: 'image', position: { x: 340, y: 0 }, data: { artifact: 'art-other' } },
  ]))
  const seen = []
  const prevFetch = globalThis.fetch
  globalThis.fetch = window.fetch = async (url, init) => {
    seen.push(String(init?.method ?? 'GET').toUpperCase() + ' ' + pathOf(url))
    return prevFetch(url, init)
  }
  const m = await mount(React.createElement(ContentCanvas, {
    canvasId: 'cv_nodel', active: true, onClose: () => {},
  }), 800)
  /* 点第一个节点选中它，再删掉它。 */
  const first = m.el.querySelector('.react-flow__node[data-id="p1"]')
  await act(async () => { first?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await act(async () => { await settle() })
  const delBtn = m.el.querySelector('[data-ewb-canvas-del]')
  await click(delBtn)
  await act(async () => { await settle() })
  const undoBtn = m.el.querySelector('[data-ewb-canvas-undo]')
  await click(undoBtn)
  await act(async () => { await settle() })
  m.unmount()
  globalThis.fetch = window.fetch = prevFetch

  const deletes = seen.filter(s => s.startsWith('DELETE'))
  check('★★ 删除节点 / 撤销 全程**没有发任何 DELETE 请求**（产物库没被动）',
    deletes.length === 0, deletes.join('、') || '（一次都没有）')

  /* 源码层反面判据：撤销那一段不许出现删产物的调用。 */
  const srcText = readFileSync(new URL('../src/client/workbench/ContentCanvas.tsx', import.meta.url), 'utf8')
  const undoBlock = srcText.slice(srcText.indexOf('const doUndo'), srcText.indexOf('const doRedo'))
  check('★★ 撤销那一段源码里没有任何删产物的调用（deleteArtifact / DELETE 都没有）',
    !/deleteArtifact|method:\s*'DELETE'|deleteCanvas/.test(undoBlock),
    undoBlock.slice(0, 60).replace(/\s+/g, ' '))
  /* 而且这条约定要**写在注释里**（计划 §三 3.4 的硬要求）。 */
  check('★ 「撤销不删产物」这条约定写进了源码注释',
    /撤销.\*不删产物|撤销不删产物/.test(srcText) && srcText.includes('产物库是主'))
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 画布库 + 骨架 tab 条（验收 1 / 2）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 画布库：新建 → 打开 → 改 → 返回列表（节点数变了）===')

const { ContentBoard } = await import('../src/client/workbench/ContentBoard.tsx')
{
  S.mem.clear()
  S.mem.set('cv_seed', mkDoc('cv_seed', '已有画布'))

  /** 这一轮骨架上报的可见格（数组的最后一份就是「现在该显示」）。 */
  const reports = []
  /** 骨架让我切到哪一格。 */
  let picked = ''
  const boardProps = (over) => ({
    active: true,
    tab: 'lib',
    apiBase: '/api/ecom-workbench',
    topHidden: false,
    onToggleTop: () => {},
    onSelectTab: (t) => { picked = t },
    onRunWorkflow: () => {},
    keptTabs: ['canvas'],
    onTabsChange: (v) => { reports.push([...v]) },
    ...over,
  })

  const m = await mount(React.createElement(ContentBoard, boardProps({})), 700)
  const q = sel => m.el.querySelector(sel)

  /* 列表里有那一份，且显示节点数与更新时间。 */
  check('画布库里列出了已有的画布', q('[data-ewb-canvas-row="cv_seed"]') !== null)
  check('★ 每行显示节点数', (q('[data-ewb-canvas-count="cv_seed"]')?.textContent ?? '').includes('个节点'),
    q('[data-ewb-canvas-count="cv_seed"]')?.textContent ?? '')
  check('★ 每行显示更新时间（不是空白）',
    (q('[data-ewb-canvas-updated="cv_seed"]')?.textContent ?? '').trim() !== '')

  /* ── 画布库缩略图（用户 m02814 #105）──
   * 纯函数先验「取哪个产物当缩略图」，DOM 再验「那一格真的画了」。
   *
   * ⚠️ 这里单独 import 一次 `canvasThumbOf`：本段在 ⑤ 那个解构块**之前**，
   * 拿不到那边的局部变量（第一版就是因此 `ReferenceError`）。 */
  {
    const { canvasThumbOf } = await import('../src/client/workbench/content-canvas-store.ts')
    const mk = (id, type, x, y, art) => ({ id, type, position: { x, y }, data: { artifact: art } })
    check('★★ 缩略图取的是图片产物',
      canvasThumbOf([mk('a', 'image', 0, 0, 'art-x')]) === 'art-x')
    check('★★ 没产物的节点不当缩略图（空节点画出来一片白，等于没有）',
      canvasThumbOf([mk('a', 'image', 0, 0, '')]) === undefined)
    check('★★ 文本节点不当缩略图（一段字塞进小格子看不出什么）',
      canvasThumbOf([{ id: 't', type: 'text', position: { x: 0, y: 0 }, data: { text: '一段话' } }]) === undefined)
    check('★★ 有产物时**图片优先于视频**（某些环境视频缩略图不出首帧）',
      canvasThumbOf([mk('v', 'video', 0, 0, 'art-v'), mk('i', 'image', 300, 300, 'art-i')]) === 'art-i')
    check('★ 同类里取最左上那张',
      canvasThumbOf([mk('i2', 'image', 300, 300, 'art-2'), mk('i1', 'image', 10, 10, 'art-1')]) === 'art-1')
    check('★ 一个产物都没有 → undefined（界面画占位，不是空白）',
      canvasThumbOf([]) === undefined)

    /* DOM：**两种画布各验一次**。
     *
     * ⚠️ 第一版只按「cv_seed 里有没有产物」二选一验，结果 cv_seed 恰好没产物
     * → 只验到占位分支；把 `img` 分支整段删掉，测试**照样绿**（自证抓出来的）。
     * 现在造一份**带产物**的画布，两条分支都验。 */
    const seeded = [...S.mem.values()].find(d => d.id === 'cv_seed')
    const hasArt = (seeded?.nodes ?? []).some(n => (n.data?.artifact ?? '') !== '')

    /* ① 没产物那份：画占位而不是留白。 */
    const blankId = hasArt ? 'cv_thumb_blank' : 'cv_seed'
    if (!hasArt) {
      check('★★ 没有产物的画布 → 那一行画占位（不是留白）',
        q('[data-ewb-canvas-thumb-empty="cv_seed"]') !== null)
    } else {
      /* cv_seed 有产物，另造一份空的来验占位。 */
      S.mem.set(blankId, mkDoc(blankId, '空画布', [
        { id: 'tb', type: 'image', position: { x: 0, y: 0 }, data: {} },
      ]))
    }

    /* ② 有产物那份：画 `<img>`，src 指向产物路由。 */
    const withArt = 'cv_thumb_full'
    S.mem.set(withArt, mkDoc(withArt, '有图的画布', [
      { id: 'ta', type: 'image', position: { x: 0, y: 0 }, data: { artifact: 'art-thumb-1' } },
    ]))
    const m2 = await mount(React.createElement(ContentBoard, boardProps({})), 700)
    const q2 = sel => m2.el.querySelector(sel)
    check('★★ 有产物的画布 → 那一行真的画了缩略图 <img>',
      q2('[data-ewb-canvas-thumb="cv_thumb_full"]') !== null)
    check('★★ 缩略图的 src 指向那个产物（不是随便一张图）',
      (q2('[data-ewb-canvas-thumb="cv_thumb_full"]')?.getAttribute('src') ?? '') === '/api/ecom-workbench/artifact/art-thumb-1',
      String(q2('[data-ewb-canvas-thumb="cv_thumb_full"]')?.getAttribute('src')))
    check('★★ 空画布那份画的是占位（两种分支都验到了）',
      q2('[data-ewb-canvas-thumb-empty="' + blankId + '"]') !== null)
    m2.unmount()
    /* ⚠️ **用完即删**：多造的这两份会污染后面「关掉之后回到列表，新建的那份在里面」
     * 那条断言（它数的是份数）。第一版忘了删，红了 1 条 —— 不是产品错，是测试自己
     * 在共享内存里留了垃圾。
     *
     * ⚠️ 而且**不能删 `cv_seed` 本身**：`blankId` 在没有产物的情形下就等于 `cv_seed`
     * （复用它，不另造），那也是有意的 —— 第一版无条件 `S.mem.delete(blankId)`
     * 把共享的种子画布删掉了，后面那条变成「实际 1 份」。 */
    S.mem.delete(withArt)
    if (blankId !== 'cv_seed') S.mem.delete(blankId)
  }

  /* 没打开画布时：上报的清单里**没有** canvas。 */
  const before = reports[reports.length - 1] ?? []
  check('★★ 没打开画布时上报的清单里没有「画布」这一格',
    !before.includes('canvas'), '实际：' + before.join(' / '))
  check('★ 没打开画布时其余六格都在（不是空清单）',
    before.length === 6 && before.includes('lib'), '实际：' + before.join(' / '))

  /* 新建一份 → 会打开它 → 上报的清单里出现 canvas，且**在第一位**。 */
  const newBtn = q('[data-ewb-canvas-new]')
  check('有「新建画布」按钮', newBtn !== null)
  await click(newBtn)
  await act(async () => { await settle() })
  const afterNew = reports[reports.length - 1] ?? []
  check('★★ 打开一份画布之后上报的清单里出现「画布」', afterNew.includes('canvas'),
    '实际：' + afterNew.join(' / '))
  check('★★ 而且它**在第一位**', afterNew[0] === 'canvas', '实际：' + afterNew.join(' / '))
  check('★ 新建之后骨架被要求切到画布那一格', picked === 'canvas', '实际：' + (picked || '（没切）'))

  /* 画布格真的挂上了。 */
  check('★★ 画布格挂上了（React Flow 视口在）', q('[data-ewb-content-pane="canvas"] .react-flow__viewport') !== null)

  /* 往画布上加两个节点 —— 让「返回列表后节点数变了」这条有东西可验。 */
  const addText = q('[data-ewb-canvas-add="text"]')
  const addImg = q('[data-ewb-canvas-add="image"]')
  check('画布工具条上的加节点按钮在（画布格真的挂上了）', addText !== null && addImg !== null)
  S.puts.length = 0
  await click(addText)
  await click(addImg)
  await waitUntil(() => (S.puts[S.puts.length - 1]?.body?.nodes ?? []).length === 2, 3000)
  const wrapped = S.puts[S.puts.length - 1]?.body ?? {}
  check('★★ 在内容板里改画布也会自动保存（节点的 2 个进了请求体）',
    Array.isArray(wrapped.nodes) && wrapped.nodes.length === 2,
    '实际发了 ' + String(S.puts.length) + ' 次 PUT，最后一份 '
      + String(Array.isArray(wrapped.nodes) ? wrapped.nodes.length : '?') + ' 个节点')

  /* 关掉画布 → 回到列表 → 节点数变了。 */
  const closeBtn = q('[data-ewb-canvas-close]')
  await click(closeBtn)
  await act(async () => { await settle() })

  const afterClose = reports[reports.length - 1] ?? []
  check('★★ 关掉画布之后「画布」这一格重新消失',
    !afterClose.includes('canvas'), '实际：' + afterClose.join(' / '))

  /* ★ 关掉之后列表要**重新读一次** —— 节点数得是 2。
   *
   * ⚠️ 这里必须整块重挂 ContentBoard，不能只看同一份组件里的列表：
   * 画布库那一格在 `active` 变真时才重读（`ContentCanvasLib` 的 effect），
   * 而「关掉画布」只是回到列表，`active` 一直是真 —— 那一格不会自己重读。
   * 真实使用里用户会切走再切回来（那时 `active` 翻一次），或者直接刷新页面。
   * 所以判据是「**重新进这个板块**时，列表里读到的节点数是对的」。 */
  m.unmount()
  const m2 = await mount(React.createElement(ContentBoard, boardProps({})), 800)
  const rows = [...m2.el.querySelectorAll('[data-ewb-canvas-row]')].map(e => e.getAttribute('data-ewb-canvas-row'))
  check('★ 关掉之后回到列表，新建的那份在里面', rows.length === 2, '实际 ' + String(rows.length) + ' 份')
  const counts = rows.map(id => m2.el.querySelector('[data-ewb-canvas-count="' + id + '"]')?.textContent ?? '')
  check('★★ 重新进板块时列表里的节点数是对的（新建那份 2 个节点）',
    counts.some(t => t.includes('2 个节点')), counts.join(' / '))

  m2.unmount()
}

/* ── 真挂骨架：tab 条上真的多出「画布」且在第一格 ────────────────────── */
console.log('')
console.log('=== ④ 真挂骨架：tab 条（不是只看上报的数组）===')
{
  S.mem.clear()
  const { EcomWorkbench } = await import('../src/client/workbench/EcomWorkbench.tsx')
  const hooks = {
    get: () => true, set: () => {},
    getHideChat: () => false, setHideChat: () => {},
    getWb: () => true, setWb: () => {},
  }
  const m = await mount(React.createElement(EcomWorkbench, hooks), 900)
  /* ⚠️ 只在**骨架的 tab 条**里找 `role="tab"`。
   *
   * 契约 CD 之后画布自己的左侧栏也有三个 `role="tab"`（节点 / 素材 / 提示词）。
   * 不加这个范围的话，判据会读到「画布 / 画布库 / … / 节点 / 素材 / 提示词」，
   * 于是「关掉之后 tab 条上又没有了」会因为侧栏那个「画布」（其实没有）被误判 ——
   * 这里限范围是**改准**，不是放宽：侧栏那块有 `data-ewb-side-panel` 标记，按它排除。 */
  const tabLabels = () => [...window.document.querySelectorAll('[role="tab"]')]
    .filter(b => b.closest('[data-ewb-side-panel]') === null)
    .map(b => (b.textContent ?? '').trim())

  /* 点左栏「内容」。 */
  const entry = window.document.querySelector('[data-ewb-item="content"]')
  check('左栏有「内容」板块', entry !== null)
  await click(entry)
  await act(async () => { await settle() })

  const before = tabLabels()
  check('★★ 没打开画布时 tab 条上**没有**「画布」', !before.includes('画布'),
    '实际：' + before.join(' / '))
  /* ★ 2026-10-29（票 66）：内容板块最后那一格从「配置」改名成「板块设置」。
   *
   * 为什么改名：侧栏新增了一个「配置」**板块**（原底部齿轮「工作台设置」升级的），
   * 内容板块里再有一个「配置」格，用户分不清两处。
   *
   * 这条断言守的事情**一个字没变**：tab 条上除了画布库，其余常驻格也在
   * （不是只剩画布库一格）。变的只是那一格的名字。
   *
   * ⚠️ **不许写成 `includes('配置') || includes('板块设置')`** —— 那是放宽：
   * 新名字是定案，没有回退可能；写成「两个都认」会让「名字改回去了」也通过。 */
  check('★ 画布库与其余格在 tab 条上', before.includes('画布库') && before.includes('板块设置'),
    '实际：' + before.join(' / '))

  /* 新建一份 → 画布格出现。 */
  const newBtn = window.document.querySelector('[data-ewb-canvas-new]')
  await click(newBtn)
  await act(async () => { await settle() })

  const after = tabLabels()
  check('★★ 打开画布之后 tab 条上出现「画布」', after.includes('画布'), '实际：' + after.join(' / '))
  check('★★ 而且在**第一位**', after[0] === '画布', '实际：' + after.join(' / '))

  /* 关掉 → 消失。 */
  const closeBtn = window.document.querySelector('[data-ewb-canvas-close]')
  await click(closeBtn)
  await act(async () => { await settle() })
  const closed = tabLabels()
  check('★★ 关掉之后 tab 条上又没有了', !closed.includes('画布'), '实际：' + closed.join(' / '))

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 契约 CD（用户 m01076）：模式切换 / 九个快捷键 / 焦点不接管 /
 *    右键菜单 / 单击不进编辑、双击才进 / 改尺寸 / 缩放滑杆 / 网格 / 侧栏
 *
 * 这一段全部从**源码 import**，不读产物 —— 与 ①②③④ 同一套。
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 契约 CD：交互补全 ===')
{
  const {
    shortcutOf, isPanReleaseKey, typingTarget, copyNodes, pasteNodes, clipboardSize, canvasThumbOf,
    duplicateNodes, resizeNode, renameNode, clearClipboard,
  } = store
  const { modeToProps, toggleMode } = await import('../src/client/workbench/CanvasToolbar.tsx')
  const { clampZoomPct, ZOOM_MIN, ZOOM_MAX } = await import('../src/client/workbench/CanvasZoomControls.tsx')
  const { panelFields } = await import('../src/client/workbench/NodeSettingsPanel.tsx')
  const { showHoverItem } = await import('../src/client/workbench/NodeHoverToolbar.tsx')

  /* ── 验收 1：模式切换真的改 React Flow 的两个属性 ── */
  const selMode = modeToProps('select')
  const panMode = modeToProps('pan')
  check('★★ 框选模式：panOnDrag=false、selectionOnDrag=true',
    selMode.panOnDrag === false && selMode.selectionOnDrag === true,
    JSON.stringify(selMode))
  check('★★ 移动模式：panOnDrag=true、selectionOnDrag=false',
    panMode.panOnDrag === true && panMode.selectionOnDrag === false,
    JSON.stringify(panMode))
  check('★ 点一下真的在两态之间切（select → pan → select）',
    toggleMode('select') === 'pan' && toggleMode('pan') === 'select')

  /* ── 验收 2：九个快捷键逐条 ── */
  const K = (key, mod = false, shift = false) => ({ key, ctrlKey: mod, metaKey: false, shiftKey: shift, target: null })
  check('★★ 快捷键 1/9：Delete → 删选中', shortcutOf(K('Delete')) === 'delete')
  check('★★ 快捷键 2/9：Backspace → 删选中（Mac 键盘）', shortcutOf(K('Backspace')) === 'delete')
  check('★★ 快捷键 3/9：Esc → 取消选中/关面板', shortcutOf(K('Escape')) === 'escape')
  check('★★ 快捷键 4/9：Ctrl+A → 全选', shortcutOf(K('a', true)) === 'selectAll')
  check('★★ 快捷键 5/9：Ctrl+C → 复制', shortcutOf(K('c', true)) === 'copy')
  check('★★ 快捷键 6/9：Ctrl+V → 粘贴', shortcutOf(K('v', true)) === 'paste')
  check('★★ 快捷键 7/9：Ctrl+D → 原地复制', shortcutOf(K('d', true)) === 'duplicate')
  check('★★ 快捷键 8/9：Ctrl+G → 编组', shortcutOf(K('g', true)) === 'group')
  check('★★ 快捷键 9/9：Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z 撤销重做',
    shortcutOf(K('z', true)) === 'undo'
    && shortcutOf(K('y', true)) === 'redo'
    && shortcutOf(K('z', true, true)) === 'redo')
  check('★ Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0 放大缩小复位',
    shortcutOf(K('=', true)) === 'zoomIn'
    && shortcutOf(K('+', true)) === 'zoomIn'
    && shortcutOf(K('-', true)) === 'zoomOut'
    && shortcutOf(K('0', true)) === 'zoomReset')

  /* ── 验收 3：焦点在输入框里 → 一律不接管 ── */
  const inArea = { tagName: 'TEXTAREA', isContentEditable: false }
  const inInput = { tagName: 'INPUT', isContentEditable: false }
  const inEditable = { tagName: 'DIV', isContentEditable: true }
  const onBody = { tagName: 'DIV', isContentEditable: false }
  check('★★ 焦点在 textarea 里：Delete 不被接管', shortcutOf({ key: 'Delete', target: inArea }) === null)
  check('★★ 焦点在 textarea 里：Ctrl+A / Ctrl+Z 也不被接管',
    shortcutOf({ key: 'a', ctrlKey: true, target: inArea }) === null
    && shortcutOf({ key: 'z', ctrlKey: true, target: inArea }) === null)
  check('★ 焦点在 input 里：Ctrl+C / Ctrl+V 不被接管（用户是在复制文字）',
    shortcutOf({ key: 'c', ctrlKey: true, target: inInput }) === null
    && shortcutOf({ key: 'v', ctrlKey: true, target: inInput }) === null)
  check('★ 焦点在 contentEditable 里：同样不接管',
    shortcutOf({ key: 'Backspace', target: inEditable }) === null)
  check('★ 焦点在普通元素上：接管（说明上一条不是「永远不接管」）',
    shortcutOf({ key: 'Delete', target: onBody }) === 'delete' && typingTarget(onBody) === false)
  check('★ 莫名其妙的 target（null）也不炸', typingTarget(null) === false)

  /* ══════════════════════════════════════════════════════════════════
   * ⑫ 空格临时切「抓手 / 平移」（用户 m02814，照 Figma / PS 的手感）
   * ══════════════════════════════════════════════════════════════════ */
  check('★★ 按下空格 → panHold（临时切抓手）',
    shortcutOf(K(' ')) === 'panHold', String(shortcutOf(K(' '))))
  check('★ 老浏览器给的是 Spacebar，也认',
    shortcutOf(K('Spacebar')) === 'panHold', String(shortcutOf(K('Spacebar'))))
  /* ⚠️ 松开是**另一个函数**：`shortcutOf` 只看「按了什么键」，不看方向。 */
  check('★★ 松开空格 → isPanReleaseKey 为真（画布据此恢复原工具）',
    isPanReleaseKey({ key: ' ', target: null }) === true
    && isPanReleaseKey({ key: 'Spacebar', target: null }) === true)
  check('★ 松开别的键不算（否则随便一个 keyup 都会把工具切回去）',
    isPanReleaseKey({ key: 'a', target: null }) === false
    && isPanReleaseKey({ key: 'Shift', target: null }) === false)
  /* 输入框里打字：按下与松开都不许触发，否则「打空格」会把画布切成抓手 */
  check('★★ 焦点在 textarea 里按空格 → 不接管（否则打不出空格）',
    shortcutOf({ key: ' ', target: inArea }) === null,
    String(shortcutOf({ key: ' ', target: inArea })))
  check('★★ 焦点在 textarea 里松开空格 → 也不算松开（没切过就不该恢复）',
    isPanReleaseKey({ key: ' ', target: inArea }) === false)
  check('★ 焦点在 contentEditable 里按空格 → 同样不接管',
    shortcutOf({ key: ' ', target: inEditable }) === null)
  /* Ctrl+空格：很多系统那是输入法切换，抢过来会让人打不出字 */
  check('★★ Ctrl+空格**不**当切工具（会跟输入法切换打架）',
    shortcutOf(K(' ', true)) === null, String(shortcutOf(K(' ', true))))
  check('★ 普通空格仍然是空格：不误判成别的键（Delete 那几条也没被它吃掉）',
    shortcutOf(K('Delete')) === 'delete' && shortcutOf(K('Escape')) === 'escape')

  /* ── 复制 / 粘贴 / 原地复制 / 改尺寸 / 改名 ── */
  clearClipboard()
  const a1 = { id: 'a', type: 'text', position: { x: 0, y: 0 }, data: { text: '甲' } }
  check('★ 复制 1 个节点进了缓冲区', copyNodes([a1]) === 1 && clipboardSize() === 1)
  const pasted = pasteNodes(32)
  check('★★ 粘出来的 id 是新的（不是同一个节点）', pasted.length === 1 && pasted[0].id !== 'a')
  check('★ 粘出来的位置错开了（不叠在原地上）',
    pasted[0].position.x === 32 && pasted[0].position.y === 32)
  check('★ 粘出来的是内容副本（改副本不影响原件）',
    (function () { pasted[0].data.text = '乙'; return a1.data.text === '甲' })())
  const dup = duplicateNodes([a1], 24)
  check('★ 原地复制的 id 新的、位置错开 24',
    dup[0].id !== 'a' && dup[0].position.x === 24 && dup[0].position.y === 24)
  const resized = resizeNode([a1], 'a', 400, 260)
  check('★★ 改尺寸写进节点（400x260）', resized[0].width === 400 && resized[0].height === 260)
  const tooSmall = resizeNode([a1], 'a', 3, 3)
  check('★ 尺寸有下限（不会缩成 0 —— 缩到 0 等于节点消失）',
    tooSmall[0].width >= 48 && tooSmall[0].height >= 48,
    String(tooSmall[0].width) + 'x' + String(tooSmall[0].height))
  const renamed = renameNode([a1], 'a', '  新名字  ')
  check('★ 改名去掉首尾空格', renamed[0].title === '新名字')
  const cleared = renameNode(renamed, 'a', '   ')
  check('★ 名字清空后回落到类型名', cleared[0].title === undefined)
  clearClipboard()

  /* ── 左侧栏的“按类型筛 / 搜索”八条已随功能一起退役（用户 m03414）──
   *
   * 用户要求删掉左侧栏的「节点」格（顶部工具栏已经有全部节点），
   * 而 `filterNodes` / `nodeMatches` / `FILTER_TYPES` **只为那一格存在**（全仓搜过）。
   * 功能删了、判据还留着就是死代码 —— 而且会让人以为那个格还在。
   *
   * ❗ **这是删断言，不是撞过去**：删的八条全是「筛选函数返回什么」，
   * 而那个函数本身已经不存在了。新增的侧栏判据（只剩两个 tab）在
   * `tests/content-canvas-panels.mjs` 里。 */

  /* ── 验收 9：悬浮工具条按类型给项 ── */
  check('★★ 图片节点（有产物）有「下载」', showHoverItem('download', 'image', true, false) === true)
  check('★★ 配置节点**没有**「下载」', showHoverItem('download', 'config', false, false) === false)
  check('★ 文本节点没有「下载」（它没有可下载的字节）',
    showHoverItem('download', 'text', false, true) === false)
  check('★ 有提示词才有「复制提示词」',
    showHoverItem('copyPrompt', 'image', true, true) === true
    && showHoverItem('copyPrompt', 'image', true, false) === false)
  check('★ 「删除」每个类型都有', showHoverItem('delete', 'config', false, false) === true)

  /* ── 图像操作入口（用户 m02814：#59 裁剪 / #62 拆图 / #65 抓帧）── */
  check('★★ 图片节点有产物 → 有「图像操作」入口',
    showHoverItem('imageOp', 'image', true, false) === true)
  check('★★ 视频节点有产物 → 有「图像操作」入口（抓帧要用）',
    showHoverItem('imageOp', 'video', true, false) === true)
  check('★★ **空**图片节点没有入口（没东西可裁）',
    showHoverItem('imageOp', 'image', false, false) === false)
  check('★★ 文本 / 配置节点没有入口（它们没有可加工的图）',
    showHoverItem('imageOp', 'text', false, true) === false
    && showHoverItem('imageOp', 'config', false, false) === false)

  /* ── 面板字段按类型分（第五节；CH 给图片 / 视频 / 音频补了「模型」）── */
  check('★★ 文本面板：提示词 + 模型 + 生成', panelFields('text').join(',') === 'prompt,model,generate')
  check('★★ 图片面板：提示词 + 模型 + 尺寸 + 张数 + 参考图 + 生成',
    panelFields('image').join(',') === 'prompt,model,size,count,reference,generate',
    panelFields('image').join(','))
  check('★★ 视频面板：提示词 + 模型 + 时长 + 分辨率 + 首帧 + 生成',
    panelFields('video').join(',') === 'prompt,model,seconds,resolution,reference,generate',
    panelFields('video').join(','))
  check('★★ 音频面板：提示词 + 模型 + 时长 + 生成',
    panelFields('audio').join(',') === 'prompt,model,seconds,generate',
    panelFields('audio').join(','))
  check('★★ 组框没有设置面板字段（它不是内容）', panelFields('group').length === 0)

  /* ── 验收 11：缩放滑杆范围 5–500 ── */
  check('★★ 缩放滑杆范围是 5–500', ZOOM_MIN === 5 && ZOOM_MAX === 500)
  check('★★ 拖到 500 就是 500%', clampZoomPct(500) === 500)
  check('★★ 拖到 5 就是 5%', clampZoomPct(5) === 5)
  check('★ 超出范围夹回边界', clampZoomPct(9999) === 500 && clampZoomPct(-30) === 5)
  check('★ 非数字回落 100', clampZoomPct(Number.NaN) === 100)

  /* ── 真挂画布 ── */
  S.mem.clear()
  S.mem.set('cv_cd', mkDoc('cv_cd', 'CD 画布', [
    { id: 'n1', type: 'text', position: { x: 0, y: 0 }, data: { text: '原文' } },
    { id: 'n2', type: 'image', position: { x: 400, y: 0 }, data: { artifact: 'art-1' } },
  ]))
  const m = await mount(React.createElement(ContentCanvas, {
    canvasId: 'cv_cd', active: true, onClose: () => {},
  }), 900)

  const pane = () => m.el.querySelector('.react-flow__pane')
  const modeBtn = () => m.el.querySelector('[data-ewb-canvas-mode]')
  /* ★ 票 54：模式现在读**属性**，不读文字。
   *
   * 票面第 3 条「只留图标，文字进 title」→ 按钮的 `textContent` 必然为空，
   * 读它永远得到空串（改之前这些断言全红）。属性取值与旧文字一一对应：
   * `select` ⟷「框选」、`pan` ⟷「移动」，而且它是**同一个 state 的另一个载体**，
   * 所以「按钮与画布说的是同一件事」这个要求没变。 */
  const modeNow = () => modeBtn()?.getAttribute('data-ewb-canvas-mode') ?? '（没有）'
  check('★★ 工具条上有模式按钮', modeBtn() !== null, '当前=' + modeNow())

  /* ⚠️ 这两个类由 React Flow 自己按属性算出来（`Pane` 里
   * `draggable = panOnDrag === true …`、`cc(['react-flow__pane', { draggable, selection }])`），
   * 所以读类等价于读「它收到了什么属性」—— jsdom 里这是能拿到的最直接证据。 */
  /* ★ 票 01（2026-10-30）：**默认态现在是移动，不是框选**。
   *
   * 用户原话：「将两个画布默认的鼠标逻辑切换到移动。」
   *
   * 改之前这两条验的是「进来就是框选」。现在验「进来就是移动」——
   * 仍是同样的两个可观察量（按钮属性 + pane 的类），强度没降。 */
  check('★★ 默认是移动态（按钮的模式值是 pan，票 01 改的）',
    modeNow() === 'pan', '实际=' + modeNow())
  check('★★ 默认移动态：pane 带 draggable 类（panOnDrag 真的是 true）',
    pane()?.classList.contains('draggable') === true,
    '类=' + (pane()?.className ?? ''))
  check('★★ 默认移动态：pane 没有 selection 类（selectionOnDrag 真的是 false）',
    pane()?.classList.contains('selection') !== true,
    '类=' + (pane()?.className ?? ''))

  /* ★ 票 01（2026-10-30）：**默认模式从框选改成了移动**。
   *
   * 用户原话：「将两个画布默认的鼠标逻辑切换到移动。」
   *
   * 所以这一段原来验的是「点一下切到移动」，现在反过来 ——
   * 进来就是移动，点一下切到框选。**判据强度没降**（仍是两条路都验到），
   * 只是起点换了。 */
  await click(modeBtn())
  check('★★ 点一下切到框选态（按钮的模式值变成 select）',
    modeNow() === 'select', '实际=' + modeNow())
  check('★★ 框选态：pane 没有 draggable 类（panOnDrag 真的变 false 了）',
    pane()?.classList.contains('draggable') !== true,
    '类=' + (pane()?.className ?? ''))
  check('★★ 框选态：pane 带 selection 类（selectionOnDrag 真的变 true 了）',
    pane()?.classList.contains('selection') === true,
    '类=' + (pane()?.className ?? ''))

  await click(modeBtn())
  check('★★ 再点一下切回移动态（模式值回到 pan、画布又可拖了）',
    modeNow() === 'pan' && pane()?.classList.contains('draggable') === true,
    '模式=' + modeNow() + ' 类=' + (pane()?.className ?? ''))

  /* ══════════════════════════════════════════════════════════════════
   * ⑬ 空格「按下切、松开恢复」在**真画布上**也成立（用户 m02814）
   * ══════════════════════════════════════════════════════════════════
   *
   * ⚠️ 这一段是**补出来的**：原来只验了 `shortcutOf` / `isPanReleaseKey` 两个纯函数，
   * 删掉画布里 `keyup` 那段恢复逻辑，测试**照样绿**（实测）。
   * 那说明「函数写对了」被当成了「画布接上了」—— 典型的两回事。
   * 现在从按钮文字 + pane 的 `draggable` 类这两处**可观察结果**验整条链路。 */
  const dragOn = () => pane()?.classList.contains('draggable') === true
  /* ★ 票 01（2026-10-30）：**默认已经是移动**，所以这里的「另一态」是框选。
   *
   * 这一段验的角色与原来完全一样（按住 → 切到另一种 → 松开 → 回原样），
   * 只是两个态的先后反过来了。票 35 那两道闸（`e.repeat` / 不覆盖 restore）
   * 仍在原地，下面 ⑬·五 段继续钉它们。 */
  check('★ （前置）此刻是移动态（默认值，票 01）', dragOn() === true,
    '类=' + (pane()?.className ?? ''))
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
  })
  await act(async () => { await settle() })
  check('★★ 按住空格 → 画布真切成框选（pane 不再有 draggable 类）', dragOn() === false,
    '类=' + (pane()?.className ?? ''))
  check('★★ 按住空格时按钮的模式值也变成 select（状态是一份，不是两处各记一套）',
    modeNow() === 'select', '实际=' + modeNow())
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }))
  })
  await act(async () => { await settle() })
  check('★★ 松开空格 → 画布真的恢复（pane 又有 draggable 类）', dragOn() === true,
    '类=' + (pane()?.className ?? ''))
  check('★★ 松开后按钮的模式值也回到 pan', modeNow() === 'pan',
    '实际=' + (modeBtn()?.getAttribute('data-ewb-canvas-mode') ?? ''))
  /* 先手动切成框选、再按住空格拖、松手 —— 应该**回到框选**，不是一律回移动。 */
  await click(modeBtn())
  check('★ （前置）手动切成框选了', dragOn() === false)
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    window.dispatchEvent(new window.KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }))
  })
  await act(async () => { await settle() })
  check('★★ 本来是框选时，按住空格再松开 → 回到**框选**（不是一律回移动）',
    dragOn() === false, '类=' + (pane()?.className ?? ''))
  await click(modeBtn())
  check('★ （复原）回到移动态，别影响后面', dragOn() === true)

  /* ══════════════════════════════════════════════════════════════════
   * ⑬·五 键盘**自动重复**时也要能切回来（票 35，2026-10-28）
   * ══════════════════════════════════════════════════════════════════
   *
   * ## 为什么上面那一段抓不到真机的 bug
   *
   * 用户报：「按空格切换到了拖动的逻辑，然后就切不回去了。」
   *
   * 上面那一段只派**一次** keydown + **一次** keyup —— 而真机上，手按住不放时
   * 浏览器每 ~30ms 补发一次 `keydown`（`e.repeat === true`）。
   *
   * 于是当时序变成「keydown → 重渲染 → repeat 的 keydown → keyup」时：
   *   1. 第一次：`panRestoreRef = 'select'`、`mode = 'pan'`；
   *   2. 重渲染换新闭包，新闭包里 `mode` 已是 `'pan'`；
   *   3. repeat：`panRestoreRef = 'pan'`（**把要恢复的值覆盖掉了**）；
   *   4. keyup：`setMode('pan')` → 永远切不回来。
   *
   * **那一段的判据是对的，只是它模拟的时序太理想**。这一段补上重复帧。
   */
  {
    const panOn = () => pane()?.classList.contains('draggable') === true
    /* ★ 票 01（2026-10-30）：默认已是**移动**，所以「切走」的那一态是框选。
     *
     * ⚠️ **这一段守的东西一个字没变**：不管默认是哪一态，
     * 「按住 → 重复帧 → 松开 → 回到按之前那一态」这条链都是同一个坑。
     * 变的只是「哪一态算原始态」。票 35 那两个真机 bug 的判据全留着。 */
    check('★ （前置·重复帧）此刻是移动态（默认值，票 01）', panOn() === true,
      '类=' + (pane()?.className ?? ''))

    /* 模拟「按住不放」：一次正常 keydown + 三次 repeat 的 keydown。 */
    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    })
    await act(async () => { await settle() })
    check('★ （重复帧）按住空格 → 切成框选', panOn() === false,
      '类=' + (pane()?.className ?? ''))
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        window.dispatchEvent(new window.KeyboardEvent('keydown', {
          key: ' ', bubbles: true, cancelable: true, repeat: true,
        }))
      })
      await act(async () => { await settle() })
    }
    check('★ （重复帧）自动重复的 keydown 不会改变状态（仍是框选）', panOn() === false,
      '类=' + (pane()?.className ?? ''))

    /* ★★ 这一条就是真机 bug：重复帧之后再松开，必须回到**按之前那一态**。 */
    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }))
    })
    await act(async () => { await settle() })
    check('★★★ 自动重复之后松开 → **仍然回到移动**（真机「切不回去」就是这个 bug）',
      panOn() === true, '类=' + (pane()?.className ?? '') + '（false = 卡在框选）')
    check('★★ 按钮也回到 pan（不是只有画布回来了、按钮还写着 select）',
      modeNow() === 'pan', '实际=' + modeNow())

    /* ★ 窗口失焦也要恢复：Alt+Tab 走的时候 keyup 不会来。 */
    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    })
    await act(async () => { await settle() })
    check('★ （失焦兜底）按住空格 → 框选', panOn() === false,
      '类=' + (pane()?.className ?? ''))
    await act(async () => { window.dispatchEvent(new window.Event('blur')) })
    await act(async () => { await settle() })
    check('★★★ 按住空格时切走窗口（失焦）→ 也回到移动（否则会一直卡在框选）',
      panOn() === true, '类=' + (pane()?.className ?? ''))
  }

  /* ── 验收 6 / 7 / 8 ── */
  const nodeOf = (id) => m.el.querySelector('.react-flow__node[data-id="' + id + '"]')
  const textNode = () => nodeOf('n1')
  check('★★ 平时是只读的那一块文字（不是 textarea）',
    textNode()?.querySelector('[data-ewb-content-text]') === null
    && textNode()?.querySelector('[data-ewb-content-textview]') !== null)

  /* ⚠️ 必须派在内层那个节点盒子上（`.react-flow__node` 只是 React Flow 的包装层，
   * 事件不会往下冒泡）—— 派在外层会误报成「单击没反应」。 */
  await act(async () => {
    textNode()?.querySelector('[data-ewb-content-node]')
      ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await settle() })
  check('★★ 单击之后**没有**出现 textarea（不进编辑）',
    textNode()?.querySelector('[data-ewb-content-text]') === null)
  check('★★ 单击之后设置面板出现了',
    m.el.querySelector('[data-ewb-node-panel]') !== null)
  check('★★ 单击之后**没有任何输入框**抢到焦点',
    window.document.activeElement === null
    || (window.document.activeElement.tagName !== 'TEXTAREA'
      && window.document.activeElement.tagName !== 'INPUT'),
    '焦点在=' + (window.document.activeElement?.tagName ?? '（无）'))

  await act(async () => {
    textNode()?.querySelector('[data-ewb-content-textview]')
      ?.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }))
  })
  await act(async () => { await settle() })
  const areaNow = textNode()?.querySelector('[data-ewb-content-text]')
  check('★★ 双击之后才出现 textarea（进编辑）', areaNow !== null,
    'textarea=' + (areaNow === null ? '（没有）' : '有'))
  check('★★ 双击之后 textarea 拿到了焦点',
    areaNow !== null && window.document.activeElement === areaNow,
    '焦点在=' + (window.document.activeElement?.tagName ?? '（无）'))

  /* 验收 8：编辑写进 data.text（节点的产出），不写进任何 config 类字段。 */
  if (areaNow !== null) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    await act(async () => {
      setter?.call(areaNow, '改过的输出')
      areaNow.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    /* ★ 等「自动保存真的发出去」，不是空转。
     * 自动保存是防抖 400ms（`content-canvas-store.ts:444` 的 `AUTOSAVE_DELAY`），
     * 那是产品行为，所以等 `S.puts` 里出现这份新内容。 */
    await waitUntil(() => {
      const p = S.puts.filter(x => x.id === 'cv_cd').pop()
      return p?.body?.nodes?.find(n => n.id === 'n1')?.data?.text === '改过的输出'
    }, 3000)
  }
  const lastPut = S.puts.filter(p => p.id === 'cv_cd').pop()
  const savedNode = lastPut?.body?.nodes?.find(n => n.id === 'n1')
  check('★★ 编辑后写进了 data.text（节点的产出）',
    savedNode?.data?.text === '改过的输出',
    '实际 text=' + String(savedNode?.data?.text))
  check('★★ 没把正文写进任何 config 类字段（config / value / input / outputs 都没有）',
    savedNode?.data?.config === undefined && savedNode?.data?.value === undefined
    && savedNode?.data?.input === undefined && savedNode?.data?.outputs === undefined,
    'data 的键=' + Object.keys(savedNode?.data ?? {}).join(','))

  /* ── 验收 3（真 DOM）/ 自证锚点：文本框里按 Delete **不删节点** ──
   *
   * 这一段是契约 CD 验收 14 的自证对象。此时 textarea 刚拿到焦点（上一步双击进来的）。
   *
   * ⚠️ 事件必须**派在拿到焦点的那个元素上**（真浏览器里 keydown 就是这样：
   * target = document.activeElement，然后冒泡到 window）。
   * 派在 window 上会得到 target = window → 被判成「没在输入」→ 误删节点，
   * 那样验的就不是这条规则了。 */
  const countNodes = () => m.el.querySelectorAll('.react-flow__node').length
  check('★ （前置）此时有 2 个节点', countNodes() === 2, '实际 ' + String(countNodes()))

  const areaFocused = textNode()?.querySelector('[data-ewb-content-text]')
  await act(async () => {
    areaFocused?.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'Delete', bubbles: true, cancelable: true,
    }))
  })
  await act(async () => { await settle() })
  check('★★ 焦点在 textarea 里按 Delete **没有删掉节点**',
    countNodes() === 2, '实际 ' + String(countNodes()) + ' 个节点')

  /* 反面：焦点不在输入框里时，Delete 必须真的删。
   * 不验这一条的话，上一条可能只是「Delete 根本没接上」。 */
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await act(async () => {
    textNode()?.querySelector('[data-ewb-content-node]')
      ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await settle() })
  check('★ （前置）选中了那个节点', m.el.querySelector('.react-flow__node.selected') !== null)
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'Delete', bubbles: true, cancelable: true,
    }))
  })
  await act(async () => { await settle() })
  check('★★ 焦点不在输入框里时按 Delete **真的删了**（说明上一条不是「Delete 没接上」）',
    countNodes() === 1, '实际 ' + String(countNodes()) + ' 个节点')

  /* Ctrl+Z 撤销（真键盘）→ 节点回来。 */
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'z', ctrlKey: true, bubbles: true, cancelable: true,
    }))
  })
  await act(async () => { await settle() })
  check('★★ Ctrl+Z 从键盘撤销把节点恢复了', countNodes() === 2,
    '实际 ' + String(countNodes()) + ' 个节点')

  /* Ctrl+A 全选（真键盘）。 */
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'a', ctrlKey: true, bubbles: true, cancelable: true,
    }))
  })
  await act(async () => { await settle() })
  check('★★ Ctrl+A 从键盘真的全选了（2 个节点都带 selected）',
    m.el.querySelectorAll('.react-flow__node.selected').length === 2,
    '实际 ' + String(m.el.querySelectorAll('.react-flow__node.selected').length))

  /* Esc 取消选中（真键盘）。 */
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await act(async () => { await settle() })
  check('★★ Esc 从键盘取消了全部选中',
    m.el.querySelectorAll('.react-flow__node.selected').length === 0,
    '实际 ' + String(m.el.querySelectorAll('.react-flow__node.selected').length))

  /* Ctrl+C / Ctrl+V（真键盘）：先选一个，复制再粘贴 → 节点多一个。 */
  await act(async () => {
    m.el.querySelector('.react-flow__node[data-id="n2"] [data-ewb-content-node]')
      ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  })
  await act(async () => { await settle() })
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'c', ctrlKey: true, bubbles: true, cancelable: true,
    }))
  })
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', {
      key: 'v', ctrlKey: true, bubbles: true, cancelable: true,
    }))
  })
  await act(async () => { await settle() })
  check('★★ Ctrl+C 再 Ctrl+V 从键盘粘贴出一个新节点（3 个）',
    countNodes() === 3, '实际 ' + String(countNodes()) + ' 个节点')

  /* ── 验收 10：四角改尺寸，改完存档里 width/height 变了 ──
   *
   * ⚠️ jsdom 不做布局，所以这里用 pointerdown + pointermove 的**位移量**驱动，
   * 而且只验「位移 → 存档里的数变了」。真机上的拖动手感要人眼。 */
  const br = m.el.querySelector('.react-flow__node[data-id="n1"] [data-ewb-node-resize="br"]')
  check('★★ 节点右下角有拖动手柄（四角各一个）',
    br !== null && m.el.querySelectorAll('.react-flow__node[data-id="n1"] [data-ewb-node-resize]').length === 4,
    '手柄数=' + String(m.el.querySelectorAll('.react-flow__node[data-id="n1"] [data-ewb-node-resize]').length))
  const beforeSize = (() => {
    const n = S.puts.filter(p => p.id === 'cv_cd').pop()?.body?.nodes?.find(x => x.id === 'n1')
    return { w: n?.width, h: n?.height }
  })()
  await act(async () => {
    br?.dispatchEvent(new window.MouseEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: 100, clientY: 100,
    }))
  })
  await act(async () => {
    window.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: 220, clientY: 190 }))
  })
  await act(async () => {
    window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: 220, clientY: 190 }))
  })
  /* ★ 等「尺寸真的写进存档了」——同样受 400ms 自动保存防抖影响。 */
  await waitUntil(() => {
    const n = S.puts.filter(p => p.id === 'cv_cd').pop()?.body?.nodes?.find(x => x.id === 'n1')
    return typeof n?.width === 'number' && typeof n?.height === 'number'
      && n.width > beforeSize.w && n.height > beforeSize.h
  }, 3000)
  const afterSize = (() => {
    const n = S.puts.filter(p => p.id === 'cv_cd').pop()?.body?.nodes?.find(x => x.id === 'n1')
    return { w: n?.width, h: n?.height }
  })()
  check('★★ 拖右下角之后存档里的 width / height 真的变大了',
    typeof afterSize.w === 'number' && typeof afterSize.h === 'number'
    && typeof beforeSize.w === 'number'
    && afterSize.w > beforeSize.w && afterSize.h > beforeSize.h,
    '改前 ' + String(beforeSize.w) + 'x' + String(beforeSize.h)
    + ' → 改后 ' + String(afterSize.w) + 'x' + String(afterSize.h))

  /* ── 验收 5（定位）：点侧栏一行会调 setCenter / 视口变 ──
   *
   * jsdom 不做布局，`setCenter` 真正把视口挪动需要尺寸；这里验**它被调到了**
   * 并且带着那个节点的坐标。用 true 的 spy 替换 `useReactFlow` 拿不到，
   * 所以改成验「点完之后那个节点被选中 + 面板开到了它身上」——
   * 那是 `focusNode` 里与 `setCenter` 同一段代码做的事，
   * 而且它是这条链路唯一能在无布局环境里稳定观察到的结果。 */
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await act(async () => { await settle() })
  /* ── 「点侧栏一行 → 那个节点被选中」三条已随功能退役（用户 m03414）──
   *
   * 它们验的是「侧栏那个节点清单能定位节点」，而那个格已经被用户要求删掉了。
   * 「点一下定位到那个节点」这个能力并没有丢 —— 在画布上直接点就是了。 */

  /* ── 验收 4：右键菜单两种上下文 ── */
  await act(async () => {
    textNode()?.dispatchEvent(new window.MouseEvent('contextmenu', {
      bubbles: true, clientX: 100, clientY: 100,
    }))
  })
  await act(async () => { await settle() })
  const nodeMenuText = m.el.querySelector('[data-ewb-menu]')?.textContent ?? ''
  check('★★ 节点上右键：菜单里有「复制节点」', nodeMenuText.includes('复制节点'),
    nodeMenuText.replace(/\s+/g, ' ').slice(0, 90))
  check('★★ 节点上右键：菜单里有「删除节点」', nodeMenuText.includes('删除节点'))
  check('★ 节点上右键：菜单里有分组 / 取消分组 / 选中组内全部成员',
    nodeMenuText.includes('分组') && nodeMenuText.includes('取消分组')
    && nodeMenuText.includes('选中组内全部成员'))
  check('★ 节点上右键：有「适应画布」', nodeMenuText.includes('适应画布'))

  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await act(async () => { await settle() })
  check('★ Esc 关掉了右键菜单', m.el.querySelector('[data-ewb-menu]') === null)

  await act(async () => {
    pane()?.dispatchEvent(new window.MouseEvent('contextmenu', {
      bubbles: true, clientX: 60, clientY: 60,
    }))
  })
  await act(async () => { await settle() })
  const paneMenuText = m.el.querySelector('[data-ewb-menu]')?.textContent ?? ''
  check('★★ 空白处右键：菜单里有「粘贴」与「全选」',
    paneMenuText.includes('粘贴') && paneMenuText.includes('全选'),
    paneMenuText.replace(/\s+/g, ' ').slice(0, 90))
  check('★★ 空白处右键：没有「删除节点」（那是节点上的项）',
    !paneMenuText.includes('删除节点'))
  await act(async () => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })

  /* ── 验收 11（界面侧）：拖滑杆 → 百分比变了 ── */
  const slider = () => m.el.querySelector('[data-ewb-zoom-slider]')
  const pctEl = () => m.el.querySelector('[data-ewb-zoom-pct]')
  check('★★ 缩放控件挂上了（滑杆 + 百分比）', slider() !== null && pctEl() !== null)
  check('★ 滑杆的 min/max 就是 5 与 500',
    slider()?.getAttribute('min') === '5' && slider()?.getAttribute('max') === '500',
    'min=' + String(slider()?.getAttribute('min')) + ' max=' + String(slider()?.getAttribute('max')))
  const setRange = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    const el = slider()
    if (el !== null && setRange !== undefined) {
      setRange.call(el, '500')
      el.dispatchEvent(new window.Event('input', { bubbles: true }))
      el.dispatchEvent(new window.Event('change', { bubbles: true }))
    }
  })
  /* ★ 等百分比真的变成 500%（React Flow 的 zoomTo 要一个来回）。 */
  await waitUntil(() => (pctEl()?.textContent ?? '') === '500%', 3000)
  check('★★ 滑杆拖到 500 时百分比显示 500%',
    (pctEl()?.textContent ?? '') === '500%', '实际=' + (pctEl()?.textContent ?? '（空）'))

  /* ── 网格样式切换（第九条）──
   *
   * ⚠️ **2026-10-29（票 59）搬到设置面板里了**。
   *
   * 用户原话：「当前内容画布左下角的背景调整进设置中，不单独出现，设置去右上角。」
   *
   * 所以这两条断言要**先打开设置面板**再找按钮，钩子也从 `data-ewb-grid`
   * 换成 `data-ewb-settings-grid`。
   *
   * **这不是放宽**：改前守「画布上有三颗、能切换」，改后守同一件事，
   * 只是那三颗在面板里。而且额外多守了一条「画布上**不许**再有」——
   * 那正是票 59 判据 1。 */
  const gridBtnsOnCanvas = () => [...m.el.querySelectorAll('[data-ewb-grid]')]
  check('★★ 票 59 判据 1：画布上**不再有**点阵/线格/空白那三颗',
    gridBtnsOnCanvas().length === 0, '实际=' + String(gridBtnsOnCanvas().length))
  check('★ 默认是点阵（有 Background 铺着）',
    m.el.querySelector('.react-flow__background') !== null)
  /* 打开设置面板（入口在顶部悬浮条右端，钩子 `data-ewb-settings-open`）。 */
  const settingsBtn = m.el.querySelector('[data-ewb-settings-open]')
  check('★ 设置入口在（data-ewb-settings-open）', settingsBtn !== null)
  await click(settingsBtn)
  const gridBtns = () => [...m.el.querySelectorAll('[data-ewb-settings-grid]')]
  check('★★ 设置面板里网格有三个选项（点阵 / 线格 / 空白）', gridBtns().length === 3,
    '实际=' + String(gridBtns().length))
  const noneBtn = gridBtns().find(b => b.getAttribute('data-ewb-settings-grid') === 'none')
  await click(noneBtn)
  check('★★ 切到空白之后 Background 整块没有了',
    m.el.querySelector('.react-flow__background') === null,
    'Background 还在=' + String(m.el.querySelector('.react-flow__background') !== null))

  /* ── 侧栏（第四节）── */
  const sideTabs = () => [...m.el.querySelectorAll('[data-ewb-side-tab]')]
    .map(b => b.getAttribute('data-ewb-side-tab'))
  check('★☆ 侧栏只剩两个 tab（节点那格已删，用户 m03414）',
    sideTabs().join(',') === 'assets,prompts', sideTabs().join(','))
  /* ⚠️ “节点清单 = 画布节点数”、“按类型筛”、“搜索”三组均已随那格退役。
   * 它们验的是侧栏那个清单的行为，而那个清单已经不存在了。 */

  await click(m.el.querySelector('[data-ewb-side-tab="assets"]'))
  check('★★ 切到素材 tab 有它自己那一块',
    m.el.querySelector('[data-ewb-side-assets]') !== null)
  await click(m.el.querySelector('[data-ewb-side-tab="prompts"]'))
  const promptRows = m.el.querySelectorAll('[data-ewb-side-prompt]')
  check('★★ 切到提示词 tab 列出了内置提示词（非空）', promptRows.length > 0,
    '实际 ' + String(promptRows.length) + ' 条')

  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑧ 编组（契约 CE）：组是真节点，拖进拖出、改大小、收纳、适应、解散
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑧ 编组：组是真节点 ===')
{
  const store = await import('../src/client/workbench/content-canvas-store.ts')
  const {
    groupNodes, ungroupNodes, fitGroup, captureIntoGroup, syncGroupsAfterDrag, groupMemberCount, toGeo,
  } = store

  /** 造一个内容节点（宽高都要给 —— 几何判定按中心点）。 */
  const nd = (id, x, y, w = 200, h = 100, groupId) => ({
    id, type: 'text', position: { x, y }, width: w, height: h,
    data: { text: id, ...groupId === undefined ? {} : { groupId } },
  })
  /** 造一个组节点。 */
  const grp = (id, x, y, w, h) => ({
    id, type: 'group', position: { x, y }, width: w, height: h, data: {},
  })

  /* ── 纯函数：组是 nodes 里的一项 ── */
  const a = nd('a', 100, 100)
  const b = nd('b', 400, 100)
  const made = groupNodes([a, b], ['a', 'b'], '我的组')

  const gn = made.nodes.find(n => n.id === made.groupId)
  check('★★ 建组之后 nodes 里多了一个组节点（type = group）', gn?.type === 'group',
    String(gn?.type))
  check('★★ 组节点有位置与宽高（能选中 / 拖动 / 缩放）',
    gn !== undefined && typeof gn.position.x === 'number' && typeof gn.width === 'number',
    JSON.stringify(gn === undefined ? null : { p: gn.position, w: gn.width, h: gn.height }))
  check('★★ 成员的 groupId 指向这个组',
    made.nodes.filter(n => n.id === 'a' || n.id === 'b').every(n => n.data.groupId === made.groupId),
    made.nodes.map(n => n.id + ':' + String(n.data.groupId)).join(' / '))
  check('★★ 成员的坐标仍是绝对的（不是相对框的）',
    made.nodes.find(n => n.id === 'a')?.position.x === 100,
    String(made.nodes.find(n => n.id === 'a')?.position.x))
  check('★★ 组名进了组节点（不是某个成员的）', gn?.title === '我的组', String(gn?.title))
  check('★ 组排在最前（渲染时在成员底下）', made.nodes[0]?.id === made.groupId,
    String(made.nodes[0]?.id))
  check('★ 只选中 1 个节点时编不了组（返回空 groupId，节点一个不动）',
    groupNodes([a, b], ['a'], 'x').groupId === '',
    String(groupNodes([a, b], ['a'], 'x').groupId))
  /* 组不能进组。参考项目 `project.tsx:1014` 的写法是「先把选中的组剔掉，
   * 剩下的还有 ≥2 个才编」—— 所以这里验的是「组不会被当成成员」，
   * 不是「一选中组就整单作废」。 */
  const mixed = groupNodes([...made.nodes], [made.groupId, 'a', 'b'], '')
  check('★ 组不能进组（选中的组本身不会被当成成员编进新组）',
    mixed.groupId !== ''
    && mixed.nodes.find(n => n.id === made.groupId)?.data.groupId === undefined,
    '新组=' + mixed.groupId + '，旧组的归属='
    + String(mixed.nodes.find(n => n.id === made.groupId)?.data.groupId))

  /* ── 成员数（框上要显示）── */
  check('★★ 组节点上能数出成员数',
    groupMemberCount(made.nodes, made.groupId) === 2,
    String(groupMemberCount(made.nodes, made.groupId)))

  /* ── 解散 ── */
  const un = ungroupNodes(made.nodes, made.groupId)
  check('★★ 解散之后组节点没了', un.find(n => n.id === made.groupId) === undefined)
  check('★★ 解散之后成员的 groupId 被清掉',
    un.filter(n => n.id === 'a' || n.id === 'b').every(n => n.data.groupId === undefined),
    un.filter(n => n.id === 'a' || n.id === 'b').map(n => String(n.data.groupId)).join(','))
  check('★★ 解散之后成员**留在原地**（坐标没被改动）',
    un.find(n => n.id === 'a')?.position.x === 100,
    String(un.find(n => n.id === 'a')?.position.x))

  /* ── 拖进 / 拖出（验收 3）──
   * 判据是几何：`syncGroupsAfterDrag` 拿的是**拖完之后**的坐标，
   * 节点中心落在框里 → 归入，落在框外 → 脱离。 */
  const box = { ...gn, position: { x: 0, y: 0 }, width: 600, height: 400 }
  const inside = nd('inside', 100, 100)
  const outside = nd('outside', 2000, 2000)
  const movedIn = syncGroupsAfterDrag([box, inside, outside], ['inside'])
  check('★★ 把节点拖到框里 → 自动归入那个组',
    movedIn.find(n => n.id === 'inside')?.data.groupId === box.id,
    String(movedIn.find(n => n.id === 'inside')?.data.groupId))
  check('★ 没进框的那个节点归属不变（不是整片重排）',
    movedIn.find(n => n.id === 'outside')?.data.groupId === undefined)

  const draggedOut = syncGroupsAfterDrag([
    box,
    { ...nd('was-in', 2000, 2000), data: { text: 'was-in', groupId: box.id } },
  ], ['was-in'])
  check('★★ 把成员拖出框外 → 自动脱离',
    draggedOut.find(n => n.id === 'was-in')?.data.groupId === undefined,
    String(draggedOut.find(n => n.id === 'was-in')?.data.groupId))

  /* ── 改大小后同步（验收 4）── */
  const smallBox = grp('g1', 0, 0, 300, 200)
  const nearNode = nd('near', 320, 20)
  const beforeBig = syncGroupsAfterDrag([smallBox, nearNode], ['__没拖任何东西__'])
  check('★ （前置）框小的时候那个节点不属于任何组',
    beforeBig.find(n => n.id === 'near')?.data.groupId === undefined)
  /* 真正放大框，再同步（拖的是框本身）。 */
  const grownBox = { ...smallBox, width: 900, height: 600 }
  const synced = syncGroupsAfterDrag([grownBox, nearNode], ['g1'])
  check('★★ 框放大后，原本在外面的节点被收进来了',
    synced.find(n => n.id === 'near')?.data.groupId === 'g1',
    String(synced.find(n => n.id === 'near')?.data.groupId))
  /* 框缩小 → 里面的成员被摘掉。 */
  const shrunk = syncGroupsAfterDrag([
    { ...smallBox, width: 120, height: 120 },
    { ...nd('was-near', 320, 20), data: { text: 'was-near', groupId: 'g1' } },
  ], ['g1'])
  check('★★ 框缩小后，落到框外的成员被摘掉归属',
    shrunk.find(n => n.id === 'was-near')?.data.groupId === undefined,
    String(shrunk.find(n => n.id === 'was-near')?.data.groupId))

  /* ── 收纳框内的节点（验收 5）── */
  const outer = grp('g2', 0, 0, 600, 400)
  const in1 = nd('in1', 100, 100)
  const in2 = nd('in2', 300, 100)
  const out1 = nd('out1', 2000, 2000)
  const cap = captureIntoGroup([outer, in1, in2, out1], 'g2')
  check('★★ 一键收纳按几何位置收（收了 2 个）', cap.captured === 2, '收了 ' + String(cap.captured) + ' 个')
  check('★★ 框内的都归了这一组',
    cap.nodes.filter(n => n.id === 'in1' || n.id === 'in2').every(n => n.data.groupId === 'g2'))
  check('★ 框外的不动', cap.nodes.find(n => n.id === 'out1')?.data.groupId === undefined)

  /* ── 适应成员（验收 6）── */
  const loose = grp('g3', -500, -500, 5000, 5000)
  const k1 = { ...nd('k1', 100, 100), data: { text: 'k1', groupId: 'g3' } }
  const k2 = { ...nd('k2', 400, 100), data: { text: 'k2', groupId: 'g3' } }
  const fitted = fitGroup([loose, k1, k2], 'g3')
  const fg = fitted.find(n => n.id === 'g3')
  check('★★ 适应成员之后框变小了（刚好包住成员）',
    fg !== undefined && fg.width !== undefined && fg.width < 5000,
    '宽 ' + String(fg?.width))
  check('★ 成员一个都没动（适应的是框，不是节点）',
    fitted.find(n => n.id === 'k1')?.position.x === 100,
    String(fitted.find(n => n.id === 'k1')?.position.x))

  /* ── 存盘不能丢归属（白名单式映射的坑）── */
  const round = toGeo({ ...a, data: { text: 'a', groupId: 'g9' } })
  check('★★ 存盘形状里的 groupId 能进几何层（不丢归属）', round.data?.groupId === 'g9',
    String(round.data?.groupId))
}


console.log('')
console.log(getFailed() === 0 ? '结论：内容画布接对了 ✓' : '结论：有 ' + String(getFailed()) + ' 条不通过 ✗')
process.exit(getFailed() === 0 ? 0 : 1)
