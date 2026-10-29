/** 节点定义（纯数据：不 import 任何 Node 内置模块，客户端与宿主半共用这一份）。
 *
 * 一个节点一个目录 —— 见 `plans/2026-10-08-板块范式与目录规划.md` §2 与总纲「节点化」条。
 * 注册表在 `src/nodes/index.ts` 集中维护（加节点要在这里补一行，原因见那里的说明）。
 */
import type { NodeDef } from '../../../workflow/model.ts'

export const NODE: NodeDef = {
  id: 'flow.delay',
  category: 'flow',
  label: '延迟',
  summary: '延迟执行（控制节奏、避免触发风控）',
  executor: 'builtin',
  inputs: [{ id: 'in', label: '输入', type: 'any' }],
  outputs: [{ id: 'out', label: '输出', type: 'any' }],
  onError: 'continue',
  params: { ms: 1000, random: false },
  detail: {
    what: '暂停流程一段时间。主要用于控制访问节奏，避免短时间内大量请求被平台判定为爬虫。',
    inputs: '任意数据（原样传下去）。',
    outputs: '原样的输入（所以可以插在任意位置不影响数据流）。',
    whenToUse: '循环里每次操作之间；批量请求之间。',
    cautions: '延迟过短无效，过长浪费时间。随机抖动可使节奏更接近人工操作。',
  },
  paramDefs: [
    { key: 'ms', label: '延迟时长', kind: 'number', default: 1000, unit: '毫秒', min: 0, step: 100,
      hint: '等待时长。默认 1000 毫秒（1 秒）。防风控场景一般 1-3 秒较自然。' },
    { key: 'random', label: '随机抖动', kind: 'boolean', default: false,
      hint: '开启后在「设定时长的一半到一倍半」之间随机取值。固定间隔反而容易被识别，建议开启。' },
  ],
}
