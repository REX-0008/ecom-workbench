/** 工作流类型：基础清单、候选合并、容错读（纯逻辑）。
 *
 * ## 为什么单独测
 *
 * 它与「能不能被调用」是**两件事**（用户 m00901 的修正），而两者很容易被搞混：
 *   · 类型 = 给人看的标签（`workflow-types.ts`）；
 *   · 能不能被调 = 开始节点的类型（`flow.start` 的 `type` 参数）。
 * 这条边界一旦被写错（比如「有『只可被调用』标签就隐藏执行按钮」），
 * 表现是「改了标签，执行按钮莫名消失」—— 所以这里把它钉住。
 *
 * 跑法：node --import <tsx> tests/workflow-types.mjs
 */
import { WORKFLOW_TYPE_PRESETS, typeOptions, readTypes } from '../src/workflow/workflow-types.ts'

let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 通过与否。
 * @param {string} detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

console.log('=== 工作流类型（workflow-types）===')

console.log('')
console.log('① 基础清单')
{
  check('有 5 项（用户 m00901 拍的第一版）', WORKFLOW_TYPE_PRESETS.length === 5, String(WORKFLOW_TYPE_PRESETS.length))
  check('含「只可被调用」「可独立执行」「组合」',
    ['只可被调用', '可独立执行', '组合'].every(t => WORKFLOW_TYPE_PRESETS.includes(t)),
    WORKFLOW_TYPE_PRESETS.join('、'))
}

console.log('')
console.log('② 候选 = 基础清单 + 本机用过的（去重、排序）')
{
  const got = typeOptions(['组合', '我自己的类目'])
  check('基础清单在前', got.slice(0, 5).join(',') === WORKFLOW_TYPE_PRESETS.join(','), got.join('、'))
  check('★ 用户手写的排在后面（不丢）', got.includes('我自己的类目'), got.join('、'))
  check('★ 与清单重复的不重复出现', got.filter(t => t === '组合').length === 1, JSON.stringify(got))
  check('多个自定义按字母序',
    JSON.stringify(typeOptions(['zzz', 'aaa']).slice(5)) === JSON.stringify(['aaa', 'zzz']),
    JSON.stringify(typeOptions(['zzz', 'aaa'])))
}

console.log('')
console.log('③ 读存档容错（存档不可信）')
{
  check('没这个键 → 空数组', readTypes({}).length === 0)
  check('null / undefined → 空数组', readTypes(null).length === 0 && readTypes(undefined).length === 0)
  check('★ 是字符串（手改坏了）→ 空数组，不炸', readTypes({ types: '采集' }).length === 0)
  check('★ 数组里混了非字符串 → 只留字符串',
    JSON.stringify(readTypes({ types: ['采集', 42, null, {}] })) === JSON.stringify(['采集']),
    JSON.stringify(readTypes({ types: ['采集', 42, null, {}] })))
  check('空串与纯空白丢掉', readTypes({ types: ['', '  ', '组合'] }).join(',') === '组合')
  check('两端空白去掉', readTypes({ types: [' 采集 '] })[0] === '采集')
}

console.log('')
console.log(failed === 0 ? '结论：工作流类型全部通过 ✓' : '有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
