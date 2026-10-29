/** 会话色标（`src/client/workbench/session-color.ts`）的测试。
 *
 * 为什么值得单独测：它是**纯映射**，错了不会崩、不会报类型错，
 * 只表现为「两个不同会话同色」或「同一个会话换设备后变色」——
 * 而这种错误只有盯着画布看才可能发现。所以把判据钉死。
 *
 * 跑法：node --import <tsx> tests/session-color.mjs
 */
import { sessionColor, SESSION_COLORS, hasSession } from '../src/client/workbench/session-color.ts'

/** 累计失败数。 */
let failed = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} cond - 是否通过。
 * @param {string} detail - 附注。
 */
function check(name, cond, detail = '') {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (detail === '' ? '' : '  —— ' + detail))
  if (!cond) failed += 1
}

console.log('=== 会话色标 ===')

console.log('')
console.log('① 同名恒同色（这是色标的意义所在）')
{
  check('同一个名字两次调用同色', sessionColor('淘宝') === sessionColor('淘宝'))
  check('大小写/空格归一（" 默认 " 与 "默认" 同色）',
    sessionColor(' 默认 ') === sessionColor('默认'))
  check('空/未填按「默认」处理', sessionColor('') === sessionColor('默认'))
  check('undefined 也按「默认」处理', sessionColor(undefined) === sessionColor('默认'))
}

console.log('')
console.log('② 不同会话名的区分度（**允许偶尔撞色**，用户 2026-10-12 定的）')
{
  /* ⚠️ 这条的判据是**刻意的宽松**：6 个颜色的色板下，
   * 6 个名字「期望」本来就只有 4-5 种颜色（鸽笼原理）。
   * 实测过三种哈希（FNV-1a / djb2 / djb2+位置权重），
   * **没有一种能让中文和英文同时满分** —— 这是色板大小的固有限制，不是哈希写坏了。
   *
   * 用户的选择是「就 6 个，允许偶尔撞色」，理由：会话名就写在色标旁边，
   * 不是靠颜色认名。所以这里只要**别退化**（比如全同色）就行。 */
  const names = ['默认', '淘宝', '抖音', '拼多多', '京东', '视频号']
  const colors = names.map(n => sessionColor(n))
  const distinct = new Set(colors).size
  check('6 个常见中文会话名至少 4 种颜色', distinct >= 4, distinct + ' 种：' + colors.join(' '))
  const short = ['A', 'B', 'C', 'D', 'E', 'F']
  const shortDistinct = new Set(short.map(n => sessionColor(n))).size
  check('6 个单字母名至少 4 种颜色', shortDistinct >= 4, shortDistinct + ' 种')
  /* 最要紧的那条**绝对不能错**：不同名字不许**全部**同色（那等于色标没用）。 */
  check('常见会话名不是全同色（色标有意义）', distinct > 1, String(distinct))
}

console.log('')
console.log('③ 颜色必须来自色板（否则 CSS 变量会拿到 undefined）')
{
  const all = ['默认', '淘宝', '抖音', 'x', 'yy', '长一点的会话名', '🐑', 'a-b_c']
  const bad = all.filter(n => !SESSION_COLORS.includes(sessionColor(n)))
  check('所有结果都在色板里（没算出 undefined）', bad.length === 0, bad.join(', '))
  /* ⚠️ 这条盯的是一个真实的实现坑：哈希用 `| 0` 会变负数，
   * 不取绝对值的话 `-7 % 6 = -1`，索引成 undefined → 颜色变空。 */
  const many = Array.from({ length: 400 }, (_, i) => '会话' + String(i))
  const badMany = many.filter(n => !SESSION_COLORS.includes(sessionColor(n)))
  check('400 个名字都不越界（负数取模的坑）', badMany.length === 0, badMany.slice(0, 3).join(', '))
  check('色板至少 4 色（太少就分不出会话）', SESSION_COLORS.length >= 4, String(SESSION_COLORS.length))
}

console.log('')
console.log('④ hasSession：判据是「有没有 session 参数」，不是看 id')
{
  check('有 session 参数 → true', hasSession([{ key: 'action' }, { key: 'session' }]) === true)
  check('没有 → false', hasSession([{ key: 'action' }]) === false)
  check('undefined → false（不崩）', hasSession(undefined) === false)
  check('空数组 → false', hasSession([]) === false)
}

console.log('')
console.log(failed === 0 ? '结论：会话色标全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
