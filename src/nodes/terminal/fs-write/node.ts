/** 节点定义（纯数据：不 import 任何 Node 内置模块，客户端与宿主半共用这一份）。
 *
 * 一个节点一个目录 —— 见 `plans/2026-10-08-板块范式与目录规划.md` §2 与总纲「节点化」条。
 * 注册表在 `src/nodes/index.ts` 集中维护（加节点要在这里补一行，原因见那里的说明）。
 */
import type { NodeDef } from '../../../workflow/model.ts'

export const NODE: NodeDef = {
  id: 'sys.fs.write',
  category: 'terminal',
  label: '写文件',
  summary: '把内容写到本地文件（覆盖或追加）',
  executor: 'builtin',
  inputs: [{ id: 'content', label: '内容', type: 'any' }],
  outputs: [{ id: 'path', label: '写入路径', type: 'text' }],
  onError: 'stop',
  params: { path: '', mode: 'overwrite', mkdir: true, encoding: 'utf8' },
  detail: {
    what: '把上游的结果存成本地文件。对象和数组会自动转成 JSON 文本。',
    inputs: '任意要保存的内容。',
    outputs: '实际写入的路径（便于下游引用或留痕）。',
    whenToUse: '保存采集结果；导出报表；给别的程序留中间文件。',
    cautions: '「覆盖」会把原文件清掉。要保留历史就改成「追加」或路径里带日期。',
  },
  hints: [{ message: '默认为「覆盖」模式，会清空同名文件的原有内容。如需保留历史，请改用「追加」或在路径中带日期。', type: 'info' }],
  paramDefs: [
    { key: 'path', label: '目标路径', kind: 'text', required: true, placeholder: 'D:\\数据\\结果.json',
      hint: '目标文件路径。建议带日期以避免互相覆盖，如 D:\\数据\\{{日期}}-商品.json' },
    { key: 'mode', label: '写入模式', kind: 'select', default: 'overwrite', options: [
      { value: 'overwrite', label: '覆盖', description: '清掉旧内容重写' },
      { value: 'append', label: '追加', description: '接到文件末尾，保留历史' },
    ], hint: '每次运行都重新生成的数据用「覆盖」；持续累积的日志用「追加」。' },
    { key: 'mkdir', label: '自动创建目录', kind: 'boolean', default: true,
      hint: '目标文件夹不存在时自动创建。默认开启。' },
    { key: 'encoding', label: '内容编码', kind: 'select', default: 'utf8', options: [
      { value: 'utf8', label: 'UTF-8', description: '普通文本（默认）' },
      { value: 'base64', label: 'Base64', description: '上游给的是 base64 文本，写盘时还原成二进制' },
    ], hint: '写图片、视频这类二进制文件时选 Base64：上游那串 base64 会被还原成原始字节再写盘。' },
  ],
}
