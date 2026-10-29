/** 示例工作流数据（画布一打开就能看到完整样子，而且**点运行真的会跑**）。
 *
 * 为什么换成这几个节点（2026-10-08 接引擎时改）：
 *   原来的示例用了「抓列表 / 字段映射 / 生成文案 / 生成主图」四个节点——
 *   它们**还没有接通执行方**（浏览器采集与出图都还没实现），点运行会第一条就失败。
 *   现在改成**四个已实现的本机节点 + 一个等待节点**，整条链真的跑得通、真的出文件。
 *   业务叙事没丢——造的就是商品数据（示例数据 → 筛出便宜的 → 拼文案 → 存文件）。
 *
 * 这条示例同时覆盖了要验证的几件事：
 *   - 四种运行状态：idle / queued / running / success
 *   - 上游输出真的流到下游（最后一个节点写出的就是前面算出来的东西）
 *   - 五种端口颜色里的 data / text / number
 */
import type { NodeDef } from '../../workflow/model.ts'

/** 示例工作流的画布节点（坐标只是初值，进来后会跑一次自动布局）。
 * 业务叙事：造示例商品 → 筛出便宜的 → 歇一下 → 拼文案 → 存文件。 */
export const V1_SAMPLE_NODES = [
  {
    id: 'n-gen', defId: 'code.js',
    params: {
      code: 'return Array.from({ length: 6 }, (_, i) => ({ 名称: "商品" + (i + 1), 价格: 59 + i * 40, 销量: 10 * (i + 1) }))',
      timeout: 30000,
    },
    onError: 'stop' as const, state: 'success' as const, progress: '完成',
  },
  {
    id: 'n-filter', defId: 'code.js',
    params: {
      code: 'return input.filter(x => x.价格 < 100)',
      timeout: 30000,
    },
    onError: 'stop' as const, state: 'success' as const, progress: '完成',
  },
  {
    id: 'n-wait', defId: 'flow.delay',
    params: { ms: 300, random: false },
    onError: 'continue' as const, state: 'running' as const, progress: '运行中',
  },
  {
    id: 'n-format', defId: 'code.js',
    params: {
      code: 'return input.map(x => x.名称 + " ¥" + x.价格).join("\\n")',
      timeout: 30000,
    },
    onError: 'stop' as const, state: 'queued' as const, progress: '排队中',
  },
  {
    id: 'n-write', defId: 'sys.fs.write',
    params: { path: 'ecom-workbench-out/示例商品.txt', mode: 'overwrite', mkdir: true },
    onError: 'stop' as const, state: 'idle' as const,
  },
]

/** 示例连线（覆盖 data / text 两种端口颜色）。 */
export const V1_SAMPLE_EDGES = [
  { id: 'e1', source: 'n-gen', sourceHandle: 'out', target: 'n-filter', targetHandle: 'in' },
  { id: 'e2', source: 'n-filter', sourceHandle: 'out', target: 'n-wait', targetHandle: 'in' },
  { id: 'e3', source: 'n-wait', sourceHandle: 'out', target: 'n-format', targetHandle: 'in' },
  { id: 'e4', source: 'n-format', sourceHandle: 'out', target: 'n-write', targetHandle: 'content' },
]
