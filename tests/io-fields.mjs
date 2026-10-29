/** 「开始 / 结束」节点的声明解析（纯逻辑，不起服务、不碰磁盘）。
 *
 * ## 为什么单独一个测试文件
 *
 * 两个节点的参数都是**一行一项的文本清单**，解析规则住在
 * `src/workflow/io-fields.ts`（客户端与宿主半共用）。它错的话，
 * 两边会**各错各的**：界面上显示「有 3 项输入」而执行层只认 2 项 ——
 * 这种不一致极难查（用户看到的与程序用的不是同一份事实）。
 *
 * 所以这里只喂字符串、只看解析结果，把容错规则逐条钉住。
 *
 * 跑法：node --import <tsx> tests/io-fields.mjs
 */
import { parseInputFields, parseOutputFields, resolveInputs, missingRequired, parseAssignments } from '../src/workflow/io-fields.ts'

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

console.log('=== io-fields：开始/结束节点的声明解析 ===')

console.log('')
console.log('① 开始节点：四列格式【名字 | 说明 | 是否必填 | 默认值】')
{
  const got = parseInputFields(['日期 | 要采集哪一天 | 必填 | 2026-10-17', '店铺'])
  check('解析出 2 项', got.length === 2, JSON.stringify(got))
  check('第 1 项的四个字段都对',
    got[0]?.name === '日期' && got[0]?.description === '要采集哪一天'
    && got[0]?.required === true && got[0]?.default === '2026-10-17',
    JSON.stringify(got[0]))
  check('只写名字的那项：不必填、没有默认值',
    got[1]?.name === '店铺' && got[1]?.required === false && got[1]?.default === undefined,
    JSON.stringify(got[1]))
}

console.log('')
console.log('② 容器形状的容错（存档可能被手改成字符串）')
{
  const fromText = parseInputFields('a\n\nb | 说明')
  check('字符串也认（按换行拆、跳过空行）', fromText.length === 2, JSON.stringify(fromText))
  check('null / undefined 给空数组',
    parseInputFields(null).length === 0 && parseInputFields(undefined).length === 0)
  check('# 开头的行是注释（忽略）', parseInputFields(['# 这是注释', '真的']).length === 1,
    JSON.stringify(parseInputFields(['# 这是注释', '真的'])))
  check('名字为空的行整行忽略（不是报错）', parseInputFields([' | 只有说明']).length === 0)
}

console.log('')
console.log('③ 「是否必填」认哪几种写法')
{
  const yes = ['必填', 'true', '是', 'TRUE', '必填 ']
  const bad = yes.filter(w => parseInputFields(['x | | ' + w])[0]?.required !== true)
  check('必填/true/是 都算必填（大小写与空格都认）', bad.length === 0, bad.join('、'))
  check('空着 / 否 / 别的字 → 不必填',
    ['', '否', 'no'].every(w => parseInputFields(['x | | ' + w])[0]?.required === false))
}

console.log('')
console.log('④ 全角分隔符也认（中文输入法下很容易打出全角）')
{
  const got = parseInputFields(['日期 ｜ 哪一天 ｜ 必填'])
  check('全角 ｜ 生效', got[0]?.name === '日期' && got[0]?.required === true, JSON.stringify(got[0]))
}

console.log('')
console.log('⑤ 结束节点：【名字 = 节点id.字段】')
{
  const got = parseOutputFields(['汇总 = n15.json', '名单 = n8'])
  check('解析出 2 项', got.length === 2, JSON.stringify(got))
  check('带点号 → 拆成节点与字段',
    got[0]?.name === '汇总' && got[0]?.nodeId === 'n15' && got[0]?.field === 'json',
    JSON.stringify(got[0]))
  check('不带点号 → 整段当节点 id、取整体输出',
    got[1]?.name === '名单' && got[1]?.nodeId === 'n8' && got[1]?.field === '',
    JSON.stringify(got[1]))
  check('全角 ＝ 生效',
    parseOutputFields(['x ＝ n1.a'])[0]?.nodeId === 'n1',
    JSON.stringify(parseOutputFields(['x ＝ n1.a'])))
}

console.log('')
console.log('⑥ 只写一个名字（结束节点）')
{
  const got = parseOutputFields(['某字段'])
  check('名字与节点名都取该行（等价于「交出同名字段」）',
    got[0]?.name === '某字段' && got[0]?.nodeId === '某字段' && got[0]?.field === '',
    JSON.stringify(got[0]))
}

console.log('')
console.log('⑦ 合并输入：外部给的值优先，缺的用默认值')
{
  const fields = parseInputFields(['日期 | | 必填 | 默认日', '店铺 | | | 默认店', '第三项'])
  const got = resolveInputs(fields, { 日期: '外部日' })
  check('外部给的覆盖默认值', got['日期'] === '外部日', JSON.stringify(got))
  check('没给的用默认值', got['店铺'] === '默认店', JSON.stringify(got))
  check('没有默认值又没给的 → 不出现在结果里', !('第三项' in got), JSON.stringify(got))
  /* ★ 这条是用户 m00901 的语义：只认声明过的字段。 */
  check('★ 外部多给的字段被丢掉（只认开始节点声明过的）',
    !('多余的' in resolveInputs(fields, { 多余的: 1 })),
    JSON.stringify(resolveInputs(fields, { 多余的: 1 })))
}

console.log('')
console.log('⑧ 必填缺了要说清是哪几个')
{
  const fields = parseInputFields(['A | | 必填', 'B', 'C | | 必填'])
  check('缺 2 个时列出 A 与 C',
    JSON.stringify(missingRequired(fields, { B: 1 })) === JSON.stringify(['A', 'C']),
    JSON.stringify(missingRequired(fields, { B: 1 })))
  check('给了空串也算缺',
    JSON.stringify(missingRequired(fields, { A: '', C: 'x' })) === JSON.stringify(['A']))
  check('都给了 → 空数组', missingRequired(fields, { A: 1, C: 2 }).length === 0)
}

console.log('')
console.log('⑨ 名字 = 值（喂给子工作流 / 前端填输入）')
{
  const got = parseAssignments(['日期 = 2026-10-17', '店铺', '空 = '])
  check('解析出 3 项', got.length === 3, JSON.stringify(got))
  check('带等号 → 有值', got[0]?.value === '2026-10-17', JSON.stringify(got[0]))
  /* ⚠️ 这条是有意区分：「只写名字」= 取同名变量；「写了等号但值为空」= 明确给空值。
   * 两者在下游表现不同，所以不能都归成空串。 */
  check('★ 只写名字 → value 是 undefined（语义 = 取同名变量）',
    got[1]?.value === undefined, JSON.stringify(got[1]))
  check('★ 写了等号但值为空 → value 是空串（语义 = 明确给空值）',
    got[2]?.value === '', JSON.stringify(got[2]))
}

console.log('')
console.log(failed === 0 ? '结论：输入输出声明的解析全部通过 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
