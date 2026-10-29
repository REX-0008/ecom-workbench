/** 节点定义（纯数据：不 import 任何 Node 内置模块，客户端与宿主半共用这一份）。
 *
 * ## 它是什么（用户 m00901 定案）
 *
 * 用户原话：「**输入=开始节点、输出=结束节点**、没开始节点不是不接，而是**没法接**，
 * 直接将参数发到第一个节点？**不接受这种**。可被调用不是设置项，而是**开始节点是什么决定的**。」
 *
 * 所以这个节点一次回答两件事：
 *   ① **这份工作流要哪些输入**（名字 / 说明 / 必填 / 默认值）；
 *   ② **谁能启动它** —— 由 `type` 决定（见下），**不是**另加一个开关。
 *
 * ## 入口类型（照 n8n 与 Dify，两家同一个答案：入口节点分类型，类型决定谁能启动它）
 *
 * | n8n | Dify | 我们 |
 * |---|---|---|
 * | 每种入口是**一个独立的触发器节点**（Manual Trigger / Schedule Trigger / Execute Sub-workflow Trigger…） | 入口是**一个「开始」节点但类型可换**（`isTypeFixed: false`，换出来的是 `trigger-webhook` 等独立节点） | 沿用 Dify 的形态：**一个节点 + 可换的 `type`** |
 *
 * 出处：n8n 的 [Manual Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.manualworkflowtrigger.md)
 * 与 [Execute Sub-workflow Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflowtrigger.md)；
 * Dify 的 `web/app/components/workflow/nodes/start/default.ts:9`（`isStart: true`、
 * `isTypeFixed: false`，注释原文 *"support node type change for start node(user input)"*）
 * 与 `types.ts:573-584` 的 `TRIGGER_NODE_TYPES` / `isTriggerNode()`。
 *
 * ## 为什么不做成「工作流设置」
 *
 * 用户明确不要设置项。而且做成设置会**丢失连线上的位置**：
 * 「输入从哪进」和「谁能启动」是同一件事，由同一个节点回答，没有第二条路。
 *
 * ## 没有开始节点会怎样
 *
 * **不是「把参数发到第一个节点」**（用户明确不接受这种兜底）。
 * 没有开始节点 = 这份工作流**没法接外部输入** —— 手动跑照样能跑（它自己带初始数据），
 * 但别的流程调它会**明确报错**，不会静默塞给第一个节点。
 */
import type { NodeDef } from '../../../workflow/model.ts'

export const NODE: NodeDef = {
  id: 'flow.start',
  category: 'flow',
  label: '开始',
  summary: '工作流的入口：声明要哪些输入，并决定谁能启动它',
  executor: 'builtin',
  /* 起点没有入端口 —— 它是这条链的头。 */
  inputs: [],
  outputs: [{ id: 'out', label: '输入值', type: 'any' }],
  onError: 'stop',
  /* 空输入：用户可以一条都不声明，那时它就是个「从这开始跑」的标记。 */
  params: { type: 'manual', fields: [], model: '' },
  detail: {
    what: '工作流的起点。声明这份工作流要哪些输入（名字 / 说明 / 是否必填 / 默认值），'
      + '并决定谁能启动它 —— 界面上点「执行」，还是只能被另一个流程调用。',
    inputs: '没有入线（它是整条链的头）。要喂进来的值由它自己的「输入项」声明。',
    outputs: '把声明的每一项值交给下游，下游用 {{名字}} 取（如 {{日期}}）。',
    whenToUse: '任何要被外部喂数据的工作流都该放一个。纯自己跑的采集流程可以不放。',
    cautions: '① 一份工作流最多一个开始节点（两个会明确报错）。\n'
      + '② 类型选「被另一个流程调用」之后，界面上不再显示「执行」按钮 —— '
      + '手动跑会因为缺输入而失败，所以干脆不给这个入口。\n'
      + '③ 没有声明输入项时：手动跑照常；被别的流程调用时不会报错，'
      + '只是没有值可给（上游给的值会被丢掉）。\n'
      + '④ 「这份工作流默认用哪个模型」是配置，不是输入：它不进执行前要填的表单，'
      + '也不能用 {{名字}} 取到。留空则跟随默认。',
  },
  paramDefs: [
    {
      key: 'type',
      label: '谁能启动它',
      kind: 'select',
      default: 'manual',
      options: [
        { value: 'manual', label: '手动执行', description: '我在界面上点「执行」，或从画布整图跑' },
        { value: 'called', label: '被另一个流程调用', description: '只能由「跑另一份工作流」节点启动；界面不显示执行按钮' },
        { value: 'schedule', label: '定时', description: '暂未与工作流接上（本轮只留位子，选了也是手动）' },
      ],
      hint: '决定「谁能启动这份工作流」。选「被另一个流程调用」会隐藏界面上的执行按钮 —— '
        + '手动跑会缺输入，所以不给这个入口。',
    },
    {
      key: 'fields',
      label: '输入项',
      kind: 'list',
      default: [],
      hint: '这份工作流要哪些输入，一行一项。格式：名字 | 说明 | 是否必填 | 默认值'
        + '（后三项可省略，如「日期」或「日期 | 要采集哪一天 | 必填」）。'
        + '下游用 {{名字}} 取这些值。',
    },
    {
      /* ## 这是**配置**，不是输入（2026-10-23）
       *
       * 它放在 `paramDefs` 里是因为它属于「这份工作流怎么配」，
       * 但它**不写进上面「输入项」那个清单** —— 输入项是**给人填的值**（日期、店铺名），
       * 而「用哪个模型」是这份工作流的运行配置。
       *
       * 两者的后果完全不同：
       *   · 输入项会显示成「执行前要填的表单」，填的东西进 `{{变量}}`；
       *   · 本项不出现在那个表单里，也不该被 `{{名字}}` 取到，
       *     而是由引擎写进运行上下文的保留键 `__model`，供「AI 生成」节点与子工作流用。
       *
       * 界面上它渲染在参数区（与「谁能启动它」并列），说明文字也要讲清这个定位。 */
      key: 'model',
      label: '这份工作流默认用哪个模型',
      kind: 'model',
      /* ★ 票 70（2026-10-29）：开始节点选的模型是给「AI 生成」节点与子工作流用的，
       * 两者都是文本用途。与 `ai.agent` 那处同一个理由（见 `ParamDef.modelType`）。 */
      modelType: 'text',
      default: '',
      /* 留空 = 不指定，走回落链（计划 §2.2）。 */
      required: false,
      hint: '留空则跟随默认（工作台设置里的默认模型，其次 dsh 模型设置里选的那个）。'
        + '这是配置，不会出现在执行前要填的输入表单里；'
        + '它会被下方「AI 生成」节点沿用，子工作流自己没选时也沿用它。',
    },
  ],
}
