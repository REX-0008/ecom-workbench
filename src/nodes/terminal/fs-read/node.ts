/** 节点定义（纯数据：不 import 任何 Node 内置模块，客户端与宿主半共用这一份）。
 *
 * 一个节点一个目录 —— 见 `plans/2026-10-08-板块范式与目录规划.md` §2 与总纲「节点化」条。
 * 注册表在 `src/nodes/index.ts` 集中维护（加节点要在这里补一行，原因见那里的说明）。
 */
import type { NodeDef } from '../../../workflow/model.ts'

export const NODE: NodeDef = {
  id: 'sys.fs.read',
  category: 'terminal',
  label: '读文件',
  summary: '读本地文件内容',
  executor: 'builtin',
  inputs: [{ id: 'path', label: '路径', type: 'text' }],
  outputs: [{ id: 'content', label: '内容', type: 'text' }],
  onError: 'stop',
  params: { path: '', encoding: 'utf8' },
  detail: {
    what: '读取本地文件内容（文本、JSON、CSV 均可）。',
    inputs: '文件路径（可从上游来，如按日期拼出的路径）。',
    outputs: '文件内容文本。',
    whenToUse: '读取采集结果文件做后续处理；读取配置或映射表。',
    cautions: '文件不存在会直接失败停止。路径支持中文，但路径必须正确（建议使用绝对路径）。',
  },
  paramDefs: [
    { key: 'path', label: '文件路径', kind: 'text', required: true, placeholder: 'D:\\数据\\商品.json',
      hint: '要读取的文件完整路径。可用 {{变量}} 动态拼接，如 D:\\数据\\{{日期}}.json' },
    { key: 'encoding', label: '文件编码', kind: 'select', default: 'utf8', options: [
      { value: 'utf8', label: 'UTF-8', description: '绝大多数文件' },
      { value: 'gbk', label: 'GBK', description: '老 Excel 导出的 csv 常是这种' },
      { value: 'base64', label: 'Base64', description: '二进制文件（如图片）' },
    ], hint: '读出乱码时更换此项：中文乱码通常说明文件实际编码为 GBK。' },
  ],
}
