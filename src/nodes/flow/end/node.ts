/** 节点定义（纯数据：不 import 任何 Node 内置模块，客户端与宿主半共用这一份）。
 *
 * ## 它是什么（用户 m00901 定案）
 *
 * 用户原话：「**输入=开始节点、输出=结束节点**」。所以出口也是**一个节点**，
 * 不是工作流设置 —— 它声明「这份工作流的产出是什么」，供外部（别的流程、
 * 前端界面）取用。
 *
 * ## 参照
 *
 * Dify 的 End 节点（`web/app/components/workflow/nodes/end/default.ts`）：
 * 它的 `outputs` 每项 = **变量名 + `value_selector`**（「选节点 + 选字段」）——
 * 也就是「这次跑完，把哪个节点的哪个字段叫成什么名字交出去」。
 * 我们照这个形状。
 *
 * ⚠️ **n8n 没有 End 节点**（它的子工作流是「最后一个节点把数据交回父流程」，
 * 见 https://docs.n8n.io/build/flow-logic/break-workflows-into-smaller-parts.md ）。
 * 用户 m00901 明确要「输出=结束节点」，所以**照 Dify 那条**。
 *
 * ## 没有结束节点会怎样
 *
 * 整份工作流照样跑完（它是可选的，与 Dify 的 `isRequired: false` 一致）。
 * 只是**没有对外声明的产出** —— 别的流程调它时拿不到值。
 */
import type { NodeDef } from '../../../workflow/model.ts'

export const NODE: NodeDef = {
  id: 'flow.end',
  category: 'flow',
  label: '结束',
  summary: '工作流的出口：声明把哪个节点的哪个字段作为产出交出去',
  executor: 'builtin',
  inputs: [{ id: 'in', label: '输入', type: 'any' }],
  /* 终点没有出端口 —— 它是这条链的尾。 */
  outputs: [],
  onError: 'stop',
  params: { fields: [], when: 'end' },
  detail: {
    what: '工作流的终点。声明「这次跑完，把哪个节点的哪个字段叫成什么名字交出去」——'
      + '别的流程调这份工作流时，拿到的就是这些值。',
    inputs: '一条入线。连上谁，就在谁跑完之后收尾（顺序依赖）。',
    outputs: '没有出线（它是整条链的尾）。产出是通过「交出哪些值」声明的。',
    whenToUse: '这份工作流的产出要给别处用（被另一个流程调用、或在前端界面上看）时。',
    cautions: '① 一份工作流最多一个结束节点。\n'
      + '② 不声明的字段不会交出去 —— 想给出去，就在这里逐项列上。\n'
      + '③ 没有结束节点不会报错，只是这份工作流没有对外产出。\n'
      + '④ 「什么时候显示」分两种：跑完才显示（默认，与 bat 一样最后打印结果），'
      + '或跑到这一步就显示（想边跑边看产出时用）。两者产出的值完全一样，只是露脸的时机不同。',
  },
  paramDefs: [
    {
      key: 'fields',
      label: '交出哪些值',
      kind: 'list',
      default: [],
      hint: '一行一项。格式：名字 = 节点id.字段（如「汇总 = n15.json」）。'
        + '只写名字则交出同名上游字段。',
    },
    {
      key: 'when',
      label: '什么时候显示',
      kind: 'select',
      default: 'end',
      options: [
        { value: 'end', label: '跑完才显示', description: '像 bat 一样，全部跑完再打印结果（默认）' },
        { value: 'live', label: '跑到这一步就显示', description: '想边跑边看产出时用；值完全一样' },
      ],
      hint: '两种只是露脸的时机不同，交出哪些值不受影响。'
        + '选「跑完才显示」时，产出会在整份工作流结束后统一出现在运行面板与运行历史里；'
        + '选「跑到这一步就显示」时，节点跑到这里立刻打一行「产出：…」，后面还有步骤也能先看到。',
    },
  ],
}
