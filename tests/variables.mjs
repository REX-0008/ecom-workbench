/** 变量替换的独立检查（不需要浏览器，直接跑）。
 *
 * 为什么必须有：这条功能此前是「承诺了但没实现」，
 * 属于最容易再次悄悄失效的一类——所以要有能立刻变红的检查。
 *
 * 跑法：node tests/variables.mjs
 */
import { substituteText, substituteDeep, fieldsFromUpstream } from '../src/workflow/variables.ts'
import { buildCommand } from '../src/workflow/command.ts'

/** 累计失败数。 */
let bad = 0

/**
 * 断言一条，打印结果。
 * @param name - 用例名。
 * @param ok - 是否通过。
 * @param detail - 打印细节。
 */
function check(name, ok, detail) {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : ' → ' + detail))
}


console.log('① 基础替换')
check('单个变量', substituteText('https://x.com/{{id}}', { fields: { id: '42' } }).value === 'https://x.com/42')
check('多个变量', substituteText('{{a}}-{{b}}', { fields: { a: '1', b: '2' } }).value === '1-2')
check('无占位符原样返回', substituteText('就是一段文字', {}).value === '就是一段文字')

console.log('② 没找到时的行为（关键：不抛错、原样保留、记一笔）')
const miss = substituteText('page={{page}}', {})
check('原样保留占位符', miss.value === 'page={{page}}', miss.value)
check('记下没找到的名字', miss.missing.length === 1 && miss.missing[0] === 'page', JSON.stringify(miss.missing))
check('不抛异常', true)

console.log('③ 点号取值与数组')
check('嵌套取值', substituteText('{{item.title}}', { fields: { item: { title: '手机' } } }).value === '手机')
check('数组下标', substituteText('{{list.1}}', { fields: { list: ['a', 'b'] } }).value === 'b')
check('路径断掉返回原样', substituteText('{{a.b.c}}', { fields: { a: {} } }).value === '{{a.b.c}}')

console.log('④ 值与文本的转换')
check('数字', substituteText('{{n}}', { fields: { n: 42 } }).value === '42')
check('布尔', substituteText('{{b}}', { fields: { b: false } }).value === 'false')
check('对象转 JSON', substituteText('{{o}}', { fields: { o: { x: 1 } } }).value === '{"x":1}')

console.log('⑤ env 与 vars 前缀')
check('env 前缀', substituteText('{{env.TOK}}', { env: { TOK: 'abc' } }).value === 'abc')
check('vars 前缀', substituteText('{{vars.k}}', { vars: { k: 'v' } }).value === 'v')

console.log('⑥ 递归替换（整张参数表）')
const deep = substituteDeep({ url: 'x/{{id}}', opts: { tag: '{{tag}}' }, n: 5, arr: ['{{id}}'] }, { fields: { id: '7', tag: 'T' } })
check('顶层字符串', deep.value.url === 'x/7')
check('嵌套对象', deep.value.opts.tag === 'T')
check('非字符串不动', deep.value.n === 5)
check('数组内替换', deep.value.arr[0] === '7')
check('无缺失', deep.missing.length === 0)

console.log('⑦ 上游字段表拼装')
const f1 = fieldsFromUpstream([{ a: 1, b: 2 }])
check('对象直接展开', f1.a === 1 && f1.b === 2)
const f2 = fieldsFromUpstream([{ a: 1 }, { a: 2 }])
check('同名键合并成数组', Array.isArray(f2.a) && f2.a.length === 2)
const f3 = fieldsFromUpstream(['一段文本'])
check('非对象落到 input', f3.input === '一段文本')
check('空上游给空表', Object.keys(fieldsFromUpstream([])).length === 0)

/* ⚠️ **不许改到上游的数据**（2026-10-14 修的一个真 bug，很隐蔽）。
 *
 * 原实现把同名字段合并成数组时写的是 `out[k].push(v)` —— 而 `out[k]` 是
 * **上游输出里那个数组的引用**，于是那个 push **改到了上游节点自己的输出**。
 *
 * 实测症状：「巡查-shop」里「天猫解析」与「抖音解析」都有 `blocks` 字段，
 * 于是 `fieldsFromUpstream` 把抖音的 blocks **push 进天猫的 blocks** ——
 * 天猫的输出从 3 个块变成 4 个（第 4 项还是个数组），最终合并出 7 个块（正常 6 个），
 * 而**日志里一条错都没有**。排查了很久，最后靠给数组装陷阱才抓到。
 *
 * 这条断言必须**在调用前后比对**，不能只查结果（见 `AGENTS.md` 的「改坏必红」纪律）。 */
{
  const up1 = { blocks: ['a', 'b'], name: '天猫' }
  const up2 = { blocks: ['c'], name: '抖音' }
  const before = JSON.stringify([up1, up2])
  const f = fieldsFromUpstream([up1, up2])
  /* ⚠️ 合并后的形状是 `['a','b',['c']]` —— 第三项是**第二个上游的那个数组本身**
   * （它被当成「一个值」追加进来）。这是既有语义，
   * 本条断言只是**钉住它别变**；重点是下面那两条「上游没被动过」。 */
  check('★ 同名数组字段合并：2 项 + 第二个上游的数组（共 3 项）',
    Array.isArray(f.blocks) && f.blocks.length === 3 && Array.isArray(f.blocks[2]),
    JSON.stringify(f.blocks))
  check('★ 调用后上游数据**一个字节都没变**（不许原地 push）',
    JSON.stringify([up1, up2]) === before,
    '之前 ' + before + ' / 之后 ' + JSON.stringify([up1, up2]))
  check('★ 上游那些数组本身长度不变（2 / 1，不是 3 / 1）',
    up1.blocks.length === 2 && up2.blocks.length === 1,
    String(up1.blocks.length) + ' / ' + String(up2.blocks.length))

  /* 反向自证：合并出来的数组**不是**上游那个引用（否则改了它就会动到上游）。 */
  check('★ 合并结果是新数组（不是上游的引用）', f.blocks !== up1.blocks)
}

console.log('')
console.log('⑧ scope.fields 与上游字段是「叠加」不是「取代」（2026-10-12）')
{
  /* 这条守的是循环的迭代变量通路。
   *
   * `buildCommand` 原先把 scope.fields 写成 `scope?.fields ?? fieldsFromUpstream(...)` ——
   * 一旦调用方传了 fields，上游字段就**整体消失**。当时没有调用方传它，所以看不出问题；
   * 但循环要往里注入 item / index，用取代语义就会让循环体内的节点**读不到上游数据**。
   *
   * ⚠️ 这条**必须直接测 `buildCommand`**，不能在 runGraph 顶层测：
   * 顶层运行时不传 loopVars（是 undefined），两种语义的结果**完全一样**，
   * 在那一层写断言等于没测（实测：故意改回取代语义，顶层断言照样通过）。 */
  const defWith = (params) => ({ id: 'code.js', label: 'x', executor: 'builtin', inputs: [], outputs: [], params })
  const d = defWith({ a: '{{key}}', b: '{{item}}' })
  const merged = buildCommand(d, d.params, [{ key: '来自上游' }], { fields: { item: '迭代值' } })
  check('上游字段在（没被 fields 挤掉）', JSON.stringify(merged.command).includes('来自上游'), JSON.stringify(merged.command))
  check('注入的 fields 也在', JSON.stringify(merged.command).includes('迭代值'), JSON.stringify(merged.command))
  check('两者都没报缺失', merged.missing.length === 0, JSON.stringify(merged.missing))

  /* 同名时调用方覆盖上游（数组下标等场景要能改写上游值）。 */
  const d2 = defWith({ v: '{{key}}' })
  const over = buildCommand(d2, d2.params, [{ key: '上游' }], { fields: { key: '覆盖' } })
  check('同名时 fields 覆盖上游', JSON.stringify(over.command).includes('覆盖'), JSON.stringify(over.command))
}

console.log(bad === 0 ? '结论：全部通过 ✓' : '结论：' + String(bad) + ' 条失败 ✗')
process.exit(bad === 0 ? 0 : 1)
