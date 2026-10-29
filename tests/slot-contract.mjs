/** 侧栏注册的**契约合规**测试（2026-10-13 新建，同日跟进「去掉顶部」）。
 *
 * ## 这个文件守什么
 *
 * 用户实测报过一个症状：**「整个左侧栏被左侧按钮遮挡」**。
 * 查下来是**我们自己的两个插件**在 `sidebar.panellist` 里干了违规的事：
 *
 *   - 在官方那一格**又渲染了一个按钮**，用 `position:absolute; inset:0; z-index:3`
 *     盖住官方行；
 *   - 用 `[class*="panelRow"]` 匹配官方**构建器生成的哈希类名**来定位；
 *   - 用 `stopPropagation` 拦掉官方的 `selectPanel`；
 *   - 用 `visibility:hidden` 藏掉官方文字（因为重影了）。
 *
 * **这与官方契约相反。** 官方 `sidebar.panellist` 渲染在**官方自己的 `<button>`
 * 内部**，注释原话：
 *
 * > 「Global panel icons. Each list id addresses the matching main panel;
 * > **the sidebar owns the button and resolves its label from list metadata.**」
 *
 * ## 最终决定（用户 2026-10-13）：**顶部整个不要，只用底部**
 *
 * 用户原话：「**去掉顶部的，保留底部的两个按钮。**」
 *
 * 理由：那个孔位的语义与我们的需求根本不合 —— 它是
 * 「**一个指向同名中央面板（`main`）的指针**」：点图标 = 官方
 * `selectPanel(图标 id)` = **切走中间那块**；而我们要「叠加在右侧、对话保留」。
 * 而且**没有同名 `main` 面板时官方直接抛错**
 * （`ui-layout/service.ts:73`：「main panel "..." is not registered」）。
 *
 * ## 现在守什么
 *
 *   ① 两个插件都**不再注册** `sidebar.panellist`（顶部那一格）；
 *   ② 两个插件都用 `sidebar.footer.action`（官方不套按钮、
 *      注释写明「Optional actions beside Settings」= 给「一个动作」用的席位）；
 *   ③ 那段 CSS 只锚**我们自己的** `data-*` 属性，不碰官方类名；
 *   ④ 且它里面没有旧覆盖做法（`#*-toggle-cover` / `panelRow` / `stopPropagation`）。
 *
 * ## 判据为什么这么写（踩过两次假报，都留在这里）
 *
 * ① 不能在整个产物里查 `panelRow` / `stopPropagation` ——
 *    **React 内部与别的组件里本来就有**，会报一堆假红。
 * ② 不能在产物里查 `#wb-toggle-cover` 就完事 ——
 *    我们把「为什么删」写进了源码注释，而**注释会被打进产物**，
 *    于是命中的是**说明文字**不是真代码。
 *
 * 所以判据锚到**我们那段 CSS 的实际文本**：从 `[data-XX-footer-toggle]` 到
 * `data-XX-column]` 之间那一段 —— 那才是真正会进 `<style>` 的内容。
 *
 * ⚠️ 已知的唯一例外：`[class*="centerCol"]`（挤压官方对话列）**暂时必须留着**
 * ——没有别的公开接口能改中间列的宽度。它是**已知脆弱点**
 * （官方改类名则挤压静默失效），所以判据里单独剔除它，而不是假装它不存在。
 *
 * 跑法：node tests/slot-contract.mjs（需先 `npm run bundle` —— 它读产物）
 */
import { readFileSync, existsSync } from 'node:fs'

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

/** 两个插件（同一套契约，各查一遍）。 */
const ROOT = new URL('../', import.meta.url).pathname.replace(/^\//, '')
const TARGETS = [
  { name: 'ecom-workbench', file: ROOT + 'lib/client.js', prefix: 'ewb' },
  {
    name: 'workbench（兄弟插件，同一套做法）',
    file: ROOT + '../workbench/lib/client.js',
    prefix: 'wb',
  },
]

console.log('=== 侧栏注册契约 ===')

for (const t of TARGETS) {
  console.log('')
  console.log('【' + t.name + '】')
  if (!existsSync(t.file)) {
    /* 兄弟插件没构建过不算失败 —— 它可能不在这台机器上。
     * 但**我们自己的**产物必须在（否则这条测试等于没跑）。 */
    const isSelf = t.prefix === 'ewb'
    check('产物存在（先 npm run bundle）', !isSelf, t.file)
    continue
  }
  const s = readFileSync(t.file, 'utf8')

  /* ① 顶部孔位**不再注册**。
   * ⚠️ 判据查「注册调用」而不是「出现过这个词」——
   * 注释里会讲到它（讲为什么不用），而注释会被打进产物。 */
  const topCalls = (s.match(/inject\((["'])sidebar\.panellist\1/g) ?? []).length
  check('不再注册顶部孔位（sidebar.panellist）', topCalls === 0,
    '找到 ' + String(topCalls) + ' 处注册调用')
  /* 为顶部孔位写的图标组件也该没了。 */
  check('顶部孔位的图标组件已删', !s.includes('data-' + t.prefix + '-panellist-icon'))

  /* ② 底部孔位**在注册**。 */
  const botCalls = (s.match(/inject\((["'])sidebar\.footer\.action\1/g) ?? []).length
  check('注册了底部开关（sidebar.footer.action）', botCalls > 0)
  check('底部开关按钮的标记在', s.includes('data-' + t.prefix + '-footer-toggle'))

  /* ③④ 我们那段 CSS 的真实文本。 */
  const start = s.indexOf('[data-' + t.prefix + '-footer-toggle]')
  const end = s.indexOf('data-' + t.prefix + '-column]', start)
  check('找得到我们注入的 CSS 段', start >= 0 && end > start)
  const seg = start < 0 ? '' : s.slice(start, end + 40)

  check('CSS 里没有旧的整行覆盖按钮（#' + t.prefix + '-toggle-cover）',
    !seg.includes('#' + t.prefix + '-toggle-cover'))
  /* `centerCol` 是已知例外（见文件头），剔除后再查官方哈希类名。 */
  const segNoCenter = seg.replace(/\[class\*="centerCol"\]/g, '')
  check('CSS 里不匹配官方 panelRow 类名（centerCol 例外已剔除）',
    !segNoCenter.includes('panelRow'))
  check('CSS 段里没有 stopPropagation', !seg.includes('stopPropagation'))
}

console.log('')
console.log('=== 判据自证（假注入必须被抓到）===')
{
  /* 保证判据不是恒真（本项目多次踩过假绿）。 */
  const fakeTop = 'inject("sidebar.panellist",()=>{})'
  check('★ 假的顶部注册会被 ① 判据抓到',
    (fakeTop.match(/inject\((["'])sidebar\.panellist\1/g) ?? []).length > 0)

  const self = TARGETS[0]
  if (existsSync(self.file)) {
    const s = readFileSync(self.file, 'utf8')
    const start = s.indexOf('[data-ewb-footer-toggle]')
    const end = s.indexOf('data-ewb-column]', start)
    const seg = start < 0 ? '' : s.slice(start, end + 40)
    const dirty = seg + '#ewb-toggle-cover{position:absolute}'
    check('★ 往 CSS 段塞旧串后，判据能发现', dirty.includes('#ewb-toggle-cover'))
  }
}

console.log('')
console.log(failed === 0
  ? '结论：侧栏注册符合官方契约（只用底部孔位）✓'
  : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
