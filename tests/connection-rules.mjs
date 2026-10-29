/** 连线校验的独立检查（含多入端口）。
 *
 * 为什么必须有：连线规则决定「用户能不能连上」，改错了会堵住合理用法或放开错误用法。
 * 多入端口是 2026-10-08 新引入的（此前一刀切禁止），必须验两个方向：
 *   - 默认端口：第二条线应被拒
 *   - 声明 multi 的端口：第二条线应被放行
 *
 * 跑法：node --import <tsx> tests/connection-rules.mjs
 */
import { isValidConnection, whyInvalid } from '../src/client/workbench/connection-rules.ts'

/** 累计失败数。 */
let bad = 0

/**
 * 断言一条。
 * @param name - 用例名。
 * @param ok - 是否通过。
 * @param detail - 细节。
 */
function check(name, ok, detail) {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : ' → ' + detail))
}

/* 造两个节点定义：一个普通单入，一个声明了 multi。 */
const defPlain = {
  id: 'plain', label: '普通', executor: 'builtin',
  inputs: [{ id: 'in', label: '输入', type: 'data' }],
  outputs: [{ id: 'out', label: '输出', type: 'data' }],
}
const defMulti = {
  id: 'multi', label: '可多入', executor: 'builtin',
  inputs: [{ id: 'in', label: '输入', type: 'data', multi: true }],
  outputs: [{ id: 'out', label: '输出', type: 'data' }],
}
const defSrc = {
  id: 'src', label: '来源', executor: 'builtin',
  inputs: [],
  outputs: [{ id: 'out', label: '输出', type: 'data' }],
}

/** 造一个校验上下文。 */
function ctx(defs, edges, nodeDefId) {
  return { defs: new Map(defs.map(d => [d.id, d])), nodeDefId, edges }
}

console.log('① 默认端口：第二条线被拒')
let c = ctx([defPlain, defSrc], [{ id: "e1", source: "s1", target: "n1", targetHandle: "in" }], new Map([["s1", "src"], ["s2", "src"], ["n1", "plain"]]))
const conn2 = { source: "s2", target: "n1", sourceHandle: "out", targetHandle: "in" }
check('第二条线被拒', isValidConnection(conn2, c) === false)
check('原因文字提到了「已有线」', whyInvalid(conn2, c).includes('已经有线'), whyInvalid(conn2, c))

console.log('② 声明 multi 的端口：第二条线放行')
c = ctx([defMulti, defSrc], [{ id: "e1", source: "s1", target: "n1", targetHandle: "in" }], new Map([["s1", "src"], ["s2", "src"], ["n1", "multi"]]))
check('第二条线被放行', isValidConnection(conn2, c) === true)

console.log('③ 同一条线重复连（同一个来源）→ 仍按「已有线」处理')
c = ctx([defPlain, defSrc], [{ id: "e1", source: "s1", target: "n1", targetHandle: "in" }], new Map([["s1", "src"], ["n1", "plain"]]))
const same = { source: "s1", target: "n1", sourceHandle: "out", targetHandle: "in" }
check('同源同目标：规则不拦（由界面去重）', isValidConnection(same, c) === true)

console.log('④ 不能连自己')
c = ctx([defPlain], [], new Map([["n1", "plain"]]))
const self = { source: "n1", target: "n1", sourceHandle: "out", targetHandle: "in" }
check('自连被拒', isValidConnection(self, c) === false)
check('原因提到「自己」', whyInvalid(self, c).includes('自己'))

console.log('⑤ 不能连成环')
c = ctx([defPlain], [{ id: "e1", source: "a", target: "b", sourceHandle: "out", targetHandle: "in" }], new Map([["a", "plain"], ["b", "plain"]]))
const cycle = { source: "b", target: "a", sourceHandle: "out", targetHandle: "in" }
check('成环被拒', isValidConnection(cycle, c) === false)
check('原因提到「环」', whyInvalid(cycle, c).includes('环'))

console.log('⑥ 类型不兼容（text 输出 → data 输入）')
const defTextSrc = { id: 'textsrc', label: '文本源', executor: 'builtin', inputs: [], outputs: [{ id: 'out', label: '输出', type: 'text' }] }
c = ctx([defPlain, defTextSrc], [], new Map([["s1", "textsrc"], ["n1", "plain"]]))
const mismatch = { source: "s1", target: "n1", sourceHandle: "out", targetHandle: "in" }
check('类型不匹配被拒', isValidConnection(mismatch, c) === false, whyInvalid(mismatch, c))

console.log('⑦ 查不到端口定义时保守处理（不因缺信息而放行多入）')
c = ctx([defSrc], [{ id: "e1", source: "s1", target: "unknown", targetHandle: "in" }], new Map([["s1", "src"], ["s2", "src"]]))
const unknown = { source: "s2", target: "unknown", sourceHandle: "out", targetHandle: "in" }
check('目标节点查不到定义时，多入被拒', isValidConnection(unknown, c) === false)

console.log(bad === 0 ? '结论：全部通过 ✓' : '结论：' + String(bad) + ' 条失败 ✗')
process.exit(bad === 0 ? 0 : 1)
