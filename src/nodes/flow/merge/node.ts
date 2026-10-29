/** 节点定义（纯数据：不 import 任何 Node 内置模块，客户端与宿主半共用这一份）。
 *
 * ## 它那时只是个空壳，2026-10-27 补上了实现（票 21）
 *
 * 在这之前它只有定义、没有实现 —— 拖进画布点了报「没有这个内置节点」，
 * 标签上挂着表示没做完的字样。
 * 而引擎里**有两处报错文案把用户指向它**：
 *   · `workflow/run.ts`：并行框内多路汇到同一个节点时报
 *     「请先用「合并」节点把这几路并成一路，或改成串联」；
 *   · `workflow/parallel.ts` 的文件头：「靠显式合并节点做 —— 我们有 `flow.merge`」。
 *
 * 节点不存在的话那两句就是在让人去找一个不存在的东西 —— 比报错更糟：
 * 报错至少说清了自己不行。补上实现之后，那两句才成立。
 *
 * 实现是纯函数、不碰外部世界、不新增依赖（`src/dispatch/builtins.ts` 的 `mergeFn`）。
 *
 * 注册表在 `src/nodes/index.ts` 集中维护（加节点要在这里补一行，原因见那里的说明）。
 */
import type { NodeDef } from '../../../workflow/model.ts'

export const NODE: NodeDef = {
  id: 'flow.merge',
  category: 'flow',
  label: '合并',
  summary: '把两路数据合成一路',
  executor: 'builtin',
  /* 合并节点：两个入口都允许多入——它本来就是用来汇总多路的。 */
  inputs: [
    { id: 'a', label: '输入 A', type: 'any', multi: true },
    { id: 'b', label: '输入 B', type: 'any', multi: true },
  ],
  outputs: [{ id: 'out', label: '合并结果', type: 'any' }],
  /* 失败策略默认「继续」：合并失败时下游拿不到值，但不该把整条采集停掉 ——
   * 与「延迟」「通知」同一个取舍。真要严格就在这里改成「停止流程」。 */
  onError: 'continue',
  params: { mode: 'array', dedupe: false },
  detail: {
    /* ⚠️ 这些字符串会直接显示在节点设置里，不许出现 Markdown 的 `**`
     * （`tests/copy-no-markdown.mjs` 钉着：用户可见位置出现 `**` 会原样显示成星号）。 */
    what: '把两路上游的数据合成一份：拼成一个数组、合并成一个对象、或首尾相接成文本。'
      + '并行框里几路的结果要汇到一起、两条分支各自产出几个字段要合起来用，都靠它。',
    inputs: '两路数据（A 和 B）。按连线顺序，第一条接进来的当 A、第二条当 B。'
      + '两路都到齐才合并，所以它天然是个「等两边都完」的汇合点。',
    outputs: '合并后的结果。形状跟着「合并方式」走：数组 / 对象 / 一段文本。',
    whenToUse: '两个来源的数据要一起处理时（如两个平台的商品汇总）；'
      + '并行框里的几路要收成一路时（把这一路的结果交给后面统一处理）。',
    cautions: '① 合并方式要选对：两个数组用「拼成数组」，两个对象的字段要拼一起用「合并成对象」，'
      + '两段文字接成一段用「文本首尾相接」。选错了不会报错，只会得到一个形状不对的结果。\n'
      + '② 一路数据都没收到时报错，不会给出一个空结果 —— 「上游没接上」与「合并出来是空的」'
      + '在排查时是两件事。\n'
      + '③ 「合并成对象」时两边的同名字段以后一路为准（后一路通常是更靠下游的加工结果）。\n'
      + '④ 输入端口只是画布上的两个孔，引擎递进来的是按连线顺序排的一个数组：'
      + '它按「前两个值」算 A 和 B，多于两路的会一并并进「拼成数组」那种方式里。',
  },
  paramDefs: [
    { key: 'mode', label: '合并方式', kind: 'select', default: 'array', options: [
      { value: 'array', label: '拼成一个数组', description: 'A 和 B 都是数组时用（各自摊开接上）' },
      { value: 'object', label: '合并成一个对象', description: '两边的字段拼一起，同名以后一路为准' },
      { value: 'concat', label: '文本首尾相接', description: '两段文字接成一段' },
    ], hint: '按上下游数据形态选择：数组则拼接数组，对象则合并字段，文本则首尾相接。' },
    { key: 'dedupe', label: '去重', kind: 'boolean', default: false,
      showWhen: { key: 'mode', equals: ['array'] },
      hint: '合并后去掉重复项（按值的文本形式判，对象与数组也能比）。默认关闭（保留全部）。' },
  ],
}
