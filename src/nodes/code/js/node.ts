/** 节点定义（纯数据：不 import 任何 Node 内置模块，客户端与宿主半共用这一份）。
 *
 * 一个节点一个目录 —— 见 `plans/2026-10-08-板块范式与目录规划.md` §2 与总纲「节点化」条。
 * 注册表在 `src/nodes/index.ts` 集中维护（加节点要在这里补一行，原因见那里的说明）。
 */
import type { NodeDef } from '../../../workflow/model.ts'

export const NODE: NodeDef = {
  id: 'code.js',
  category: 'code',
  label: '执行 JavaScript',
  summary: '跑一段 JS 处理数据（在本程序里跑，不在页面上）',
  executor: 'builtin',
  /* 允许多入：上游有多路时可以一次拿到全部（代码里 input 会是数组）。 */
  inputs: [{ id: 'in', label: '输入', type: 'any', multi: true }],
  outputs: [{ id: 'out', label: '输出', type: 'any' }],
  onError: 'stop',
  params: { code: 'return input', timeout: 30000 },
  detail: {
    what: '在本程序内部跑一段 JavaScript 来加工数据：过滤、改名、拼字符串、算数、转格式。不碰网页，纯粹处理上游传来的数据。',
    inputs: '任意上游数据（用变量 input 取）。',
    outputs: '代码 return 的东西。',
    whenToUse: '上游数据需要改一下才能给下游用时（如把价格从「￥199.00」变成 199）。',
    cautions: '要操作网页请用「执行 JS」的浏览器版（那个在页面里跑），不是这个。这个跑在本程序里，读不到网页内容。',
  },
  paramDefs: [
    { key: 'code', label: '代码', kind: 'textarea', required: true, placeholder: 'return input.filter(x => x.price > 100)',
      hint: '用 input 取上游数据，用 return 把结果传给下游。如 return input.filter(x => x.price > 100)' },
    { key: 'timeout', label: '超时上限', kind: 'number', default: 30000, unit: '毫秒', min: 1000, step: 1000, advanced: true,
      hint: '超过该时长判定失败。默认 30000 毫秒（30 秒）。处理大量数据时调大。' },
  ],
}
