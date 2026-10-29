/** 撤销栈的独立检查（不需要浏览器）。
 *
 * 为什么必须有：撤销栈是「用户以为有、实际漏了」的典型——
 * 拖动/改参数/键盘删除此前都不进栈，代码看着都正常。
 * 加去重也是：不去重时连续两次相同操作会白占两格。
 *
 * 跑法：node tests/history.mjs
 */
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
process.env.NODE_ENV = 'production'

/* store 是 zustand 写的，需要 React 运行时环境；用最小 stub 绕过。
 * 只测 push / undo / redo / 去重 这几个纯数据逻辑。 */
const { useHistoryStore, restoreSnapshot } = await import('../src/client/workbench/history-store.ts')

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

/** 造一个最小节点（只要撤销栈用到的字段）。 */
function node(id, x) {
  return { id, type: 'v1', position: { x, y: 0 }, selected: false, data: { def: { id: 'code.js' }, state: 'idle', params: {}, onError: 'stop' } }
}

/** 造一份快照输入。 */
function snap(nodes, edges = []) { return { nodes, edges } }

const S = useHistoryStore.getState()

console.log('① 按真实用法验证：记「操作前」→ 操作 → 撤销')
/* 语义说明：push 记的是**操作之前**的状态。
 * 所以「拖动」的用法是：拖之前 push(a@0)，拖完画布成了 a@10，
 * 撤销时把当前(a@10)传进去，拿回 a@0。 */
S.clear()
S.push([node("a", 0)], [])
check('记了一格', useHistoryStore.getState().past.length === 1)
const prev = useHistoryStore.getState().undo(snap([node("a", 10)]))
check('撤销回到操作前（位置 0）', prev !== null && prev.nodes[0].position.x === 0, String(prev?.nodes[0]?.position.x))
check('撤销后 future 有一格（存的是被撤销时的状态）', useHistoryStore.getState().future.length === 1)
const fwd = useHistoryStore.getState().redo(snap([node("a", 0)]))
check('重做回到操作后（位置 10）', fwd !== null && fwd.nodes[0].position.x === 10, String(fwd?.nodes[0]?.position.x))
console.log('② 连续两次操作（真实拖动两次）')
S.clear()
S.push([node("a", 0)], [])
S.push([node("a", 10)], [])
const u1 = useHistoryStore.getState().undo(snap([node("a", 20)]))
check('第一次撤销 → 位置 10', u1 !== null && u1.nodes[0].position.x === 10, String(u1?.nodes[0]?.position.x))
const u2 = useHistoryStore.getState().undo(snap([node("a", 10)]))
check('第二次撤销 → 位置 0', u2 !== null && u2.nodes[0].position.x === 0, String(u2?.nodes[0]?.position.x))
check('撤到底再撤销 → null（不崩）', useHistoryStore.getState().undo(snap([node("a", 0)])) === null)

console.log('③ 去重（新加的）：同一件事不重复入栈')
S.clear()
S.push([node("a", 0)], [])
S.push([node("a", 0)], [])
S.push([node("a", 0)], [])
check('三次相同 → 只占一格', useHistoryStore.getState().past.length === 1, String(useHistoryStore.getState().past.length))
S.push([node("a", 5)], [])
check('内容变了才入栈', useHistoryStore.getState().past.length === 2, String(useHistoryStore.getState().past.length))

console.log('④ 连线也是快照的一部分')
S.clear()
S.push([node("a", 0)], [{ id: 'e1', source: 'a', target: 'b' }])
check('连线被记进去', useHistoryStore.getState().past[0].edges.length === 1)
S.push([node("a", 0)], [{ id: 'e1', source: 'a', target: 'c' }])
check('连线变了算两格', useHistoryStore.getState().past.length === 2)

console.log('⑤ 上限与清空')
S.clear()
for (let i = 0; i < 130; i++) S.push([node("a", i)], [])
check('超上限后不超过 100', useHistoryStore.getState().past.length <= 100, String(useHistoryStore.getState().past.length))
check('是最新的那些（末位位置 129）', useHistoryStore.getState().past.at(-1).nodes[0].position.x === 129)
S.clear()
check('clear 后两栈都空', useHistoryStore.getState().past.length === 0 && useHistoryStore.getState().future.length === 0)

console.log('⑥ 恢复快照会重挂回调')
const restored = restoreSnapshot(snap([node("a", 3)]), [])
check('恢复后位置正确', restored[0].position.x === 3)
check('回调位仍是 undefined（由画布挂）', restored[0].data.onRunOne === undefined)

console.log(bad === 0 ? '结论：全部通过 ✓' : '结论：' + String(bad) + ' 条失败 ✗')
process.exit(bad === 0 ? 0 : 1)
