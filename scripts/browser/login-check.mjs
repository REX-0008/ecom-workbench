/** 生成「确认账号已登录」这一步的代码（两份取数工作流共用）。
 *
 * 用户 2026-10-20 原话：
 *   「我发现，两个取数工作流都缺了确认账号已登录环节，需要补充上。」
 *   「增加 if 或者失败节点，走提醒流程，具体提醒待定，当前输出原因即可」
 *
 * ## 为什么单独一份、不写进各自的 code 文件
 *
 * 抖音与天猫的**判据不同**（域名、cookie 名、跳转页），但**结构完全一样**：
 *
 *   打开首页 → 读「登录了吗」→ IF 分流 ┬ 已登录 → 继续原来的流程
 *                                     └ 未登录 → 写一份「未登录」结果 → 结束
 *
 * 所以这里只提供**两段页面内 eval**（各平台一份判据）+ 一段生成结果文件的
 * `code.js`，工作流骨架在各自的 build-*.mjs 里搭。
 *
 * ## 判据照源码（别自己发明）
 *
 * | | 源码 | 判据 |
 * | --- | --- | --- |
 * | 抖音 | `douyin-ui.ts:524` | `page.url().includes('/login')` |
 * | 天猫 | `tb-sycm.ts:67,73` | `page.url().includes('login.htm')`，外加 cookie 里要有 unb 与 cookie2 |
 *
 * ⚠️ **天猫那条 cookie 判据不能省**：`sycm.taobao.com` 在未登录时**不一定**跳到
 * login.htm（有时留在原页但接口返 401）。源码用「跳转 + cookie 双判」。
 * 只判 URL 会出现「以为登录了、结果每张报表都拿不到地址」那种更费解的现象。
 */

/** 抖音：当前页是不是登录页。 */
export const LOGIN_CHECK_DY = `
/* ⚠️ 这段由「打开模块页」之后单独一个节点跑，只回答一个问题：登录了吗。 */
const href = String(location.href)
const isLogin = href.includes('/login')
return {
  ok: true,
  loggedIn: !isLogin,
  href,
  /* 给人看的原因（用户要求「当前输出原因即可」）。 */
  reason: isLogin ? '页面跳到了登录页（' + href.slice(0, 120) + '）' : '',
}
`

/** 天猫：当前页是不是登录页（跳转 + cookie 双判，照 `tb-sycm.ts:67-73`）。 */
export const LOGIN_CHECK_TM = `
/* ## 判据照源码 tb-sycm.ts:67/73
 *
 * ① location.href 含 login.htm → 明确是登录页；
 * ② cookie 里缺 unb 或 cookie2 → 会话级登录态没了（源码 getCookies 那段）。
 *
 * ⚠️ 两条是**或**关系：源码先判 URL，进登录流程后再用 cookie 确认「登上了没」。
 * 这里反过来用它判「现在能用吗」——任一条不满足就是不能用。
 * document.cookie 读不到 HttpOnly 的 cookie，所以**只能信 URL**那一条。
 * 源码能读 unb 是因为 playwright 的 ctx.cookies() 拿得到 HttpOnly，
 * 而我们在页面内 eval 里拿不到 —— 这是**已知差异**，写在这里备查。 */
const href = String(location.href)
const isLogin = href.includes('login.htm') || href.includes('/login')
return {
  ok: true,
  loggedIn: !isLogin,
  href,
  reason: isLogin ? '页面跳到了登录页（' + href.slice(0, 120) + '）' : '',
}
`

/**
 * 千川：当前页是不是登录页（2026-10-23 加，供 `login-gate.mjs` 那段复用）。
 *
 * ## 判据照源码 `douyin-ui.ts:383-393`（千川那段 `qianchuanFlow`）
 *
 * 未登录会跳登录域，URL 里不再有 `site-promotion`。
 *
 * ## 为什么单独一份、不直接用 `qianchuan-code.mjs` 的 `QC_CHECK_LOGIN`
 *
 * 两者的**用途不同、形状也不同**：
 *   · `QC_CHECK_LOGIN` 是「跑流程时顺手查一下」，未登录就 `ok:false` 直接失败；
 *   · 这一份要交给 `login-gate.mjs`，而它判的是 **`result.loggedIn`** 这个字段
 *     （与抖音/天猫同形状），所以必须把人话结论放在那个字段上。
 *
 * 形状统一之后，`login-gate.mjs` 只需认识一种结论 —— 三份工作流共用同一段救援逻辑。
 */
export const LOGIN_CHECK_QC = `
/* ⚠️ 这段由「打开千川页面」之后单独一个节点跑，只回答一个问题：登录了吗。
 * 判据照源码：千川未登录会跳登录域，URL 里不再有 site-promotion。 */
const href = String(location.href)
const isLogin = !href.includes('site-promotion')
return {
  ok: true,
  loggedIn: !isLogin,
  href,
  /* 给人看的原因（与抖音/天猫同一字段名，救援那段直接取它）。 */
  reason: isLogin ? '页面不在 site-promotion（当前 ' + href.slice(0, 120) + '）' : '',
}
`

/**
 * 「未登录」时写的那份结果文件内容。
 *
 * 与正常工作流写的**同一份文件、同一个形状**，只是 `ok:false` 且带原因 ——
 * 这样面板读它的代码不用改（它不会因为「多了一种情况」而崩）。
 *
 * @param job - 平台名（`douyin` / `tmall`），只用于文案。
 * @returns `code.js` 的正文。
 */
export function loginFailResult(job) {
  const who = job === 'douyin' ? '抖音' : job === 'qianchuan' ? '千川' : '天猫'
  return `
/* 上游 = 「检查登录」那一步的输出（含 href / reason）。 */
const up = input && typeof input === 'object' ? input : {}
const inner = up.result !== undefined && up.result !== null && typeof up.result === 'object' ? up.result : up
const reason = String(inner.reason ?? '未登录')
return {
  ok: false,
  job: ${JSON.stringify(job)},
  error: '${who}账号未登录：' + reason,
  hint: '在那个浏览器窗口里登录${who}，然后在运行记录里点「继续」。',
  href: String(inner.href ?? ''),
  at: new Date().toISOString(),
}
`
}
