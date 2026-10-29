/** 执行画布这一半的编组：组**不参与执行** + 两个画布都改了（契约 CE，用户 m01076）。
 *
 * ## 为什么单独一个文件
 *
 * `tests/group-geometry.mjs` 验的是**几何**（纯函数，喂数据看结果）。
 * 这个文件验的是**执行画布那一侧的接线**，三件事都属于「错了不会报错、只会表现成
 * 用户看到的样子不对」那一类：
 *
 *   ⑮ **组不参与派发** —— 组成了真节点之后，若 `toRunSpecsFromCanvas` 不过滤它，
 *      调度器会给 `__group` 造一条 spec → `fns.get('__group') === undefined` →
 *      报「没有这个内置节点：__group」。用户看到的是「跑一半失败了」，
 *      而真正的原因只是画布里有个框。
 *   ⑯ **判据同源** —— `specs.ts` 与 `env-check.ts` 必须用**同一对**字段认组
 *      （`type === 'group' || defId === '__group'`）。一处认 `type`、另一处只认 `defId`
 *      就会漂：新存档写 `type`、旧存档只有 `defId`，两边各漏一半，**且漏得不报错**。
 *   ⑨ **执行画布真的改了** —— 它不再用名单模型（`groupBox` / `moveGroupBy`），
 *      改成几何层；框是节点、四角有手柄。这一条只能查源码与组件，查不到就得靠人点。
 *
 * ## 为什么不能靠「跑一次试试」
 *
 * 派发是宿主半的事，测试跑在 Node 里没有那个 server；而 jsdom 不做布局，
 * 「拖框四角改大小」在 DOM 上量不出位移。所以这里分两层：
 *   · **翻译层**（`toRunSpecsFromCanvas`）直接喂数据看结果 —— 这是「会不会派发」的真判据；
 *   · **组件层**（`GroupNodeCard`）用 `renderToString` 看它画出了什么（手柄、归属钩子）。
 *
 * 跑法：node --import <tsx> tests/group-run-specs.mjs
 */
import { readFileSync } from 'node:fs'
import { createRequire, register } from 'node:module'

/* 源码里 import 了 `.module.css`，Node 不认识 —— 当空对象（与打包器对 CSS Modules 的语义一致）。 */
register('data:text/javascript,' + encodeURIComponent(
  'export async function load(url, ctx, next) {\n'
  + "  if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true }\n"
  + '  return next(url, ctx)\n'
  + '}\n',
))

const require = createRequire(import.meta.url)

let failed = 0
/**
 * 断言。
 * @param name - 断言名。
 * @param cond - 是否通过。
 * @param detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

/** 读源码（一律相对本文件，避免依赖运行目录）。 */
const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const { toRunSpecs, toRunSpecsFromCanvas, isGroupNodeShape } = await import('../src/workflow/specs.ts')

/** 造一个节点定义（只填调度器要看的字段）。 */
function def(id, extra = {}) {
  return { id, label: id, summary: '', executor: 'builtin', inputs: [], outputs: [], paramDefs: [], ...extra }
}

/** 节点类型表（`toRunSpecs` 吃的是**数组**，`toRunSpecsFromCanvas` 不吃它）。 */
const LIB = [def('code.js'), def('flow.loop')]
/** 分组框的占位定义（它不是节点库里的东西，由调用方合成 —— 与画布一致）。 */
const GROUP_DEF = def('__group', { label: '分组' })

/* ══════════════════════════════════════════════════════════════════════
 * ⑮ 组不参与派发（验收 15）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ⑮ 组是画布节点的，但**不派发** ===')
{
  /* 画布内存形状：组 + 两个真节点 + 一条连到组的边（存档里可能有脏边）。 */
  const canvasNodes = [
    { id: 'g-1', type: 'group', position: { x: 0, y: 0 }, data: { def: GROUP_DEF, onError: 'stop', params: {} } },
    { id: 'a', type: 'v1', position: { x: 40, y: 60 }, data: { def: def('code.js'), onError: 'stop', params: {}, groupId: 'g-1' } },
    { id: 'b', type: 'v1', position: { x: 340, y: 60 }, data: { def: def('code.js'), onError: 'stop', params: {}, groupId: 'g-1' } },
  ]
  const canvasEdges = [
    { id: 'e1', source: 'a', target: 'b' },
    /* 一条**连到组**的边：组不派发之后它的端点在规格里不存在，
     * 翻译时必须把它一起丢掉，否则拓扑排序会算出幽灵依赖。 */
    { id: 'e2', source: 'b', target: 'g-1' },
  ]
  const out = toRunSpecsFromCanvas(canvasNodes, canvasEdges)
  const ids = out.nodes.map(s => s.id)
  check('★★ 组的 id **没有**出现在运行节点里（不是跑失败，是根本不派发）',
    !ids.includes('g-1'), ids.join(','))
  check('★★ 两个真节点都在（别顺手把别人过滤掉）',
    ids.includes('a') && ids.includes('b'), ids.join(','))
  check('★★ 连到组的那条边也被丢掉（否则拓扑排序算出幽灵依赖）',
    !out.edges.some(e => e.source === 'g-1' || e.target === 'g-1'),
    out.edges.map(e => e.source + '->' + e.target).join(' '))

  /* 存档那条路（列表里点▶跑）同样要过滤 —— 两条路必须同构，这是本项目踩过的坑。 */
  const doc = {
    nodes: [
      { id: 'g-1', type: 'group', defId: '__group', position: { x: 0, y: 0 } },
      { id: 'a', type: 'v1', defId: 'code.js', position: { x: 40, y: 60 }, groupId: 'g-1' },
    ],
    edges: [],
  }
  const fromDoc = toRunSpecs(doc, LIB)
  check('★★ 存档那条路也把组过滤掉（两条入口同构）',
    !fromDoc.nodes.map(s => s.id).includes('g-1'), fromDoc.nodes.map(s => s.id).join(','))
  check('★ 组**不算**「缺类型」（它不是缺，是本来就不该派发）',
    !fromDoc.missingTypes.includes('__group'), JSON.stringify(fromDoc.missingTypes))

  /* 循环框是**可执行容器**，绝不能顺手一起过滤掉（那是把循环功能删了）。 */
  const withLoop = toRunSpecs({
    nodes: [
      { id: 'L', type: 'v1', defId: 'flow.loop', position: { x: 0, y: 0 } },
      { id: 'k', type: 'v1', defId: 'code.js', position: { x: 10, y: 10 }, parentId: 'L' },
    ],
    edges: [],
  }, LIB)
  check('★ （对照）循环框照常派发，没被当成组过滤掉',
    withLoop.nodes.map(s => s.id).includes('L'), withLoop.nodes.map(s => s.id).join(','))
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑯ 判据同源（验收 16）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑯ 认「这是不是组」的判据只有一份 ===')
{
  /* 三处的**行为**必须一致：type 写了、只写 defId、都是组。 */
  check('★★ type=group → 认成组', isGroupNodeShape({ type: 'group' }))
  check('★★ 只有 defId=__group（旧存档）→ 也认成组', isGroupNodeShape({ defId: '__group' }))
  check('★ 普通节点 → 不是组', !isGroupNodeShape({ type: 'v1', defId: 'code.js' }))
  check('★ 空对象 → 不是组（存档里可能是脏数据）', !isGroupNodeShape({}))

  /* 源码层：`env-check.ts` 必须用**同一对**字段，不许一处只认 defId。 */
  const envSrc = src('../src/workflow/env-check.ts')
  const envOk = /n\.type === GROUP_NODE_TYPE \|\| n\.defId === GROUP_DEF_ID/.test(envSrc)
  check('★★ env-check.ts 的判据是「type 或 defId」这一对（不是只认一个）', envOk,
    envOk ? '' : '在 env-check.ts 里没找到 `type === GROUP_NODE_TYPE || defId === GROUP_DEF_ID`')

  /* 源码层：`specs.ts` 的两条路（存档 / 画布）都必须走 `isGroupNodeShape`。
   * 只数「出现几次」不够 —— 要确认**两个函数体里各有一处调用**。 */
  const specsSrc = src('../src/workflow/specs.ts')
  const callsInSpecs = (specsSrc.match(/isGroupNodeShape\(/g) ?? []).length
  check('★★ specs.ts 的两条翻译路都走同一个判据函数（至少两处调用）',
    callsInSpecs >= 3, '出现 ' + String(callsInSpecs) + ' 次（1 次定义 + 2 处调用）')
  const roundTripCanvas = specsSrc.indexOf('const runnable = nodes.filter')
  check('★★ 画布那条路是先过滤再 map（过滤写在 `const runnable` 上）',
    roundTripCanvas > 0, roundTripCanvas > 0 ? '' : '没找到 `const runnable = nodes.filter`')
}

/* ══════════════════════════════════════════════════════════════════════
 * 画布节点 ⇄ 几何节点的换算（契约 CE 追加的两个函数）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 换算：画布节点 ⇄ 几何节点（只碰几何字段）===')
{
  const { toGeoNodes, applyGeoNodes } = await import('../src/client/workbench/group-geometry.ts')

  /* 造一个「像 V1Node 的东西」：带 def / params / 运行态 —— 这些**都不许被换算碰到**。 */
  const mk = (id, x, y, extra = {}) => ({
    id,
    type: 'v1',
    position: { x, y },
    data: { def: { id: 'code.js' }, params: { a: 1 }, state: 'idle' },
    ...extra,
  })

  const nodes = [mk('a', 10, 20), mk('g', 0, 0, { type: 'group', width: 700, height: 300 })]
  const geo = toGeoNodes(nodes, new Map([['a', { w: 200, h: 100 }]]), { w: 300, h: 168 })
  check('★★ 量到的尺寸被用上（普通节点自己没有 width/height）',
    geo[0].width === 200 && geo[0].height === 100,
    JSON.stringify({ w: geo[0].width, h: geo[0].height }))
  check('★★ 节点自己的宽高优先于实测（框是用户拉的，不能被测量值覆盖）',
    geo[1].width === 700 && geo[1].height === 300,
    JSON.stringify({ w: geo[1].width, h: geo[1].height }))
  check('★ 都量不到时用画布兜底尺寸',
    toGeoNodes([mk('z', 0, 0)], new Map(), { w: 300, h: 168 })[0].width === 300)

  /* 只回写四样：position / width / height / data.groupId。 */
  const after = applyGeoNodes(nodes, [
    { id: 'a', type: 'v1', position: { x: 50, y: 60 }, width: 210, height: 110, data: { groupId: 'g' } },
    { id: 'g', type: 'group', position: { x: 0, y: 0 }, width: 700, height: 300, data: {} },
  ])
  check('★★ 位置被回写', after[0].position.x === 50 && after[0].position.y === 60)
  check('★★ 归属被回写（`data.groupId`）', after[0].data.groupId === 'g', String(after[0].data.groupId))
  check('★★ **别的 data 字段一个都没动**（def / params / 运行态必须原样）',
    after[0].data.def.id === 'code.js' && after[0].data.params.a === 1 && after[0].data.state === 'idle',
    JSON.stringify(after[0].data))
  check('★★ 归属取消时**删掉那个键**（不是写 undefined —— 存档会变成 null）',
    !('groupId' in applyGeoNodes([mk('a', 0, 0, { data: { def: { id: 'x' }, groupId: 'g' } })], [
      { id: 'a', type: 'v1', position: { x: 0, y: 0 }, width: 1, height: 1, data: {} },
    ])[0].data), '')
  check('★ 几何里没有的节点原样返回（不被抹掉）',
    applyGeoNodes(nodes, [])[0].data.def.id === 'code.js')
}

/* ══════════════════════════════════════════════════════════════════════
 * 解散编组：框**真的被删掉**（2026-10-26 修的真 bug）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== 解散：框节点必须真的从画布上消失 ===')
{
  const { toGeoNodes, applyGeoNodes, ungroupCanvasGroup } = await import('../src/client/workbench/group-geometry.ts')
  const canvas = [
    { id: 'g1', type: 'group', position: { x: 0, y: 0 }, width: 700, height: 400, data: { groupLabel: '组一' } },
    { id: 'a', type: 'v1', position: { x: 40, y: 60 }, data: { def: { id: 'code.js' }, params: {}, groupId: 'g1' } },
    { id: 'b', type: 'v1', position: { x: 300, y: 60 }, data: { def: { id: 'code.js' }, params: {} } },
  ]
  const geo = toGeoNodes(canvas, new Map(), { w: 300, h: 168 })
  const afterUngroup = ungroupCanvasGroup('g1', geo)

  /* 前提：几何层确实把框删了。 */
  check('★ （前提）几何层的 `ungroupCanvasGroup` 结果里没有那个框',
    !afterUngroup.some(g => g.id === 'g1'))

  /* ⚠️ **这一条是那个 bug 的判据**：直接拿 `applyGeoNodes(原数组, 几何结果)` 回写，
   * 框会被原样留下 —— 因为它按**原数组**遍历，缺 id 的 `return n`。
   * 所以「解散」必须由**调用方先 filter 掉框**（见 `WorkflowCanvas` 那两处）。
   *
   * 这条断言钉住的是**契约本身**：`applyGeoNodes` 不负责删节点。
   * 哪天有人把它改成「几何里缺了就删」，这里会红 —— 那会顺带把
   * `groupSelected`（传进几何的只有成员）变成「删掉其他所有节点」。 */
  check('★★ `applyGeoNodes` 不负责删节点（按原数组遍历，缺 id 的原样保留）',
    applyGeoNodes(canvas, afterUngroup).some(n => n.id === 'g1'),
    '它就是靠这个语义才不能被改成「缺了就删」')

  /* 正确用法：调用方先 filter 掉框。 */
  const correct = applyGeoNodes(canvas.filter(n => n.id !== 'g1'), afterUngroup)
  check('★★ 解散的正确用法：先 filter 掉框 → 框真的没了',
    !correct.some(n => n.id === 'g1'), correct.map(n => n.id).join(','))
  check('★★ 成员的归属被清空（不是留着一个指向空气的 groupId）',
    correct.find(n => n.id === 'a')?.data.groupId === undefined,
    String(correct.find(n => n.id === 'a')?.data.groupId))
  check('★★ 别的节点一个不少（解散只该动那一组）',
    correct.some(n => n.id === 'b') && correct.length === 2,
    correct.map(n => n.id).join(','))

  /* 源码层：两处解散调用点都必须先 filter（改回旧写法会红）。 */
  const canvasSrc = src('../src/client/workbench/WorkflowCanvas.tsx')
  check('★★ `ungroupById` 里先 filter 掉框再回写（不然框会留在画布上）',
    /const kept = nodesRef\.current\.filter\(x => x\.id !== groupId\)/.test(canvasSrc), '')
  check('★★ `ungroupSelected` 里先 filter 掉被解散的框再回写',
    /const gone = new Set\(hit\)/.test(canvasSrc), '')
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑨ 执行画布真的改了（验收 9 的执行画布那一条）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑨ 执行画布：框是真节点、四角有手柄、名单模型下线 ===')
{
  const canvasSrc = src('../src/client/workbench/WorkflowCanvas.tsx')

  /* 名单模型的三个入口必须都消失（文件里的注释提到它们不算，所以查的是**调用**）。 */
  const staleCalls = [/groupBox\(/, /moveGroupBy\(/, /makeGroup\(/, /setGroups\(/, /groupsRef\.current/]
    .filter(re => re.test(canvasSrc)).map(re => String(re))
  check('★★ 执行画布不再调用名单模型的函数（groupBox / moveGroupBy / makeGroup / setGroups）',
    staleCalls.length === 0, staleCalls.join(' '))

  /* 几何层确实接上了（六个动作各有一处调用）。 */
  const wanted = [
    ['createGroupFromNodes', '建组'],
    ['syncGroupMembershipAfterTransform', '改大小 / 拖框后同步归属'],
    ['fitGroupToEnclosedChildren', '适应成员'],
    ['captureEnclosedNodesIntoGroup', '一键收纳'],
    ['ungroupCanvasGroup', '解散'],
    ['findGroupDropTarget', '拖进框'],
  ]
  for (const [fn, why] of wanted) {
    check('★★ 接上了 `' + fn + '`（' + why + '）', canvasSrc.includes(fn + '('), '')
  }

  /* ⚠️ 循环框的 parentId 那套一个字都不许动（它是执行容器，与组是两套）。 */
  check('★ 循环框的 `parentId` 归属没被改成 groupId（两套不许混）',
    /clampIntoLoop\(/.test(canvasSrc) && /fitLoopBox\(/.test(canvasSrc),
    '循环的贴边 / 钳位仍在')

  /* ★ 拖动那一条链（「拖进框自动进组 / 拖出框自动脱离」的用户可见行为全在这里）。
   *
   * ## 为什么这些要按「出现次数」判而不是「出现过」
   *
   * `syncGroupsAfterDrag` / `applyGeoNodes` 这类名字在文件里**定义一次、调用若干次**。
   * 只判「出现过」的话，把调用点删掉它照样匹配得上——那条断言就成了假绿
   * （这个项目为此吃过两次亏：判据太宽 → 破坏之后测试还是绿的）。
   * 所以数**总次数**，并明确说出「1 次 import + 1 次定义 + N 次调用」的构成。 */
  const count = (re) => (canvasSrc.match(re) ?? []).length
  /* 取出 `onNodeDragStop` 那一段函数体（从定义处到下一个 `const xxx = useCallback`），
   * 只在这一段里找调用 —— 全文搜「出现过」会被别处的定义本身匹配到，判据太宽。 */
  const stopStart = canvasSrc.indexOf('const onNodeDragStop = useCallback')
  const stopEnd = canvasSrc.indexOf('const putIntoLoop = useCallback')
  const stopBody = stopStart >= 0 && stopEnd > stopStart ? canvasSrc.slice(stopStart, stopEnd) : ''
  check('★★ 拖完真的同步归属（`onNodeDragStop` 里有调用，不只是定义）',
    /syncGroupsAfterDrag\(moved\)/.test(stopBody),
    stopBody === '' ? '没找到 onNodeDragStop 的函数体' : '')
  check('★★ 拖框时把成员一起带上（`onNodeDragStart` 记下成员起点）',
    /groupDragRef\.current = \{ id: node\.id/.test(canvasSrc), '')
  check('★★ 拖动中按组的位移推成员（`onNodeDrag` 读 groupDragRef）',
    count(/groupDragRef\.current/g) >= 3,
    '出现 ' + String(count(/groupDragRef\.current/g)) + ' 次（1 声明 + 记起点 + 拖动中读 + 松手清）')
  check('★★ 松手后清掉拖框记账（不清的话下次拖普通节点会推错一批）',
    /groupDragRef\.current = null/.test(canvasSrc), '')
  check('★ 改大小之后同步归属（四角手柄那条路的收尾）',
    count(/syncGroupMembershipAfterTransform\(/g) >= 2,
    '出现 ' + String(count(/syncGroupMembershipAfterTransform\(/g)) + ' 次')

  /* 组件层：框画出了四角手柄与归属钩子（`data-group-id` 是 dom-render 找它的依据）。
   *
   * ⚠️ 必须包一层 `ReactFlowProvider`：框里要读画布缩放（四角拖动的像素折算），
   * 那是 React Flow 的 store —— 没有 provider 时它会直接抛
   * `Seems like you have not used ReactFlowProvider as an ancestor`。
   * 真实画布里这个 provider 由 `CanvasInner` 提供，所以这里补的不是「绕过错误」。
   *
   * ⚠️ **provider 必须从 ESM 那份 import**：`GroupNode.tsx` 里 `useStore` 走的是
   * `@xyflow/react` 的 ESM 入口，`require()` 拿到的是 CJS 那份 —— 两个模块实例
   * 各自一个 store，包了 CJS 的 provider 也救不了 ESM 的 `useStore`（实测报同一个错）。 */
  const React = require('react')
  /* ⚠️ 必须把 React 挂到全局再 import 源码组件：tsx 在没有 tsconfig 的目录下
   * 走的是**经典 JSX 转换**（`React.createElement`），而我们这些 `.tsx` 里
   * 只 `import { useRef } from 'react'`、没有 `import * as React` ——
   * 不挂全局就报 `ReferenceError: React is not defined`。
   * 这不是绕过错误：`tests/dom-render.mjs` / `tests/content-canvas.mjs` 等
   * 每一处从源码 import 组件的测试都是这么做的（`globalThis.React = React`）。 */
  globalThis.React = React
  const { renderToString } = require('react-dom/server')
  const { ReactFlowProvider } = await import('@xyflow/react')
  const { GroupNodeCard } = await import('../src/client/workbench/GroupNode.tsx')
  /** 把框包进 provider 再渲染成 HTML。 */
  const renderGroup = (props) => renderToString(
    React.createElement(ReactFlowProvider, null, React.createElement(GroupNodeCard, props)),
  )
  const baseProps = {
    selected: false, isConnectable: true,
    type: 'group', dragging: false, zIndex: 0,
    selectable: true, deletable: true, draggable: true,
    positionAbsoluteX: 0, positionAbsoluteY: 0,
  }
  const html = renderGroup({
    ...baseProps,
    id: 'g-1',
    data: { groupLabel: '我的组', note: '说明' },
    width: 700, height: 300,
  })
  check('★★ 框上带着 `data-group-id`（渲染层靠它认出「这是组」）', html.includes('data-group-id="g-1"'), '')
  const corners = (html.match(/data-ewb-group-resize=/g) ?? []).length
  check('★★ 四角各有一个改大小手柄（照参考项目 4 个 ResizeHandle）', corners === 4,
    '实际 ' + String(corners) + ' 个')
  check('★★ 框有自己的宽高（尺寸写进节点，能存进存档）',
    /width:\s*700px/.test(html) && /height:\s*300px/.test(html),
    (/width:\s*\d+px[^"]*/.exec(html) ?? [''])[0])
  check('★ 框上能看到名字（用户要认出这是哪一组）', html.includes('我的组'), '')
  check('★ 收起态不显示手柄（压成一条时改高度没意义）', (() => {
    const collapsedHtml = renderGroup({
      ...baseProps,
      id: 'g-2', data: { groupLabel: '收起', collapsed: true }, width: 700, height: 300,
    })
    return !/data-ewb-group-resize=/.test(collapsedHtml)
  })(), '')
}

/* ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log(failed === 0 ? '结论：组不参与派发，两个画布都接上了 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
