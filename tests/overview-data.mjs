/** 总览显示数据本身（票 07，2026-10-30）。
 *
 * # 用户原话（第 9 条）
 *
 * 「总览界面的逻辑需要重新设计，这里应该是显示数据，而不是有没有采集，产物有没有交出，
 * 采集是否成功，这都不是重点，关于采集成功与否显示一个当前数据是什么时候更新的即可
 * （更新没有成功不要更新数据，即不是跑了就更新数据，而是成功拿到数据才更新数据。）」
 *
 * 第二块拍板：「总览第二块『今日关键数字』。目前有采集的都要放」。
 *
 * # 这一份的桩**照真实数据抄**
 *
 * 下面 `TM_SHOP` / `DY_SHOP` / `DY_QIANCHUAN` 三份的形状与数值都是
 * 2026-10-30 从 `profiles/desktop/data/ecom-workbench/patrol/` 实测抄来的
 * （`ok` / `runAt` / `dataDate` / 每项的 `label` / `value` / `state` 逐字一致）。
 * 不照抄的话，「天猫 9 项」这种判据就只能拍脑袋，而拍脑袋的判据永远绿。
 *
 * # 四类要分开（判据 5 钉的就是这个）
 *
 * | 类 | 桩里是谁 | 界面上那句话 |
 * |---|---|---|
 * | 采到了 | 天猫 9 项、千川 1 项 | 显示数字 |
 * | 跑了但一项没采到 | 抖音店铺 11 项全是 `—` | 「本份巡查未采到指标」 |
 * | 有文件读不出 | 天猫活动报名 | 「这份结果格式不对，读不出指标」 |
 * | 文件不存在 | 抖音活动报名 | 「这份还没跑过」 |
 *
 * 跑法：`node scripts/run-tests.mjs overview-data`
 *
 * ⚠️ **今天显示几格会随数据变，判据只认口径**。
 *
 * 桩里的三份是 2026-10-30 03:00 的快照（那时合计 10 格）。之后票 13 把旧项目
 * 9 月的巡查导进来，盘上变成 24 格、`patrol-dy-shop.json` 也不再是全空。
 * **这不是坏消息，也不该改这里**：这一份钉的是
 * 「`state !== 'unknown'` 且 `value !== '—'` 才算采到」这条**口径**，
 * 以及四类来源各说各话。格数是数据的属性，不是代码的属性。
 *
 * 所以下一个人看到界面上是 24 格、而这里写「10 格」时不要以为坏了 ——
 * 要验的是「抖音那 11 项一项都不进格子」这种**规则**，不是总数。
 */
import { createEnv } from './_canvas-harness.mjs'

const env = await createEnv()
const { window, React, mount, check } = env

/* ══════════════════════════════════════════════════════════════════════
 * 桩数据（数值照真实文件逐字抄）
 * ══════════════════════════════════════════════════════════════════════ */

/** 天猫店铺数据：9 项采到，物流 4.68 是 warn。 */
const TM_SHOP = {
  file: 'patrol-tm-shop.json', name: '巡查-天猫-店铺数据', platform: 'tm',
  runAt: '2026-10-19T22:54:00.205Z', dataDate: '2026-10-20', ok: true, error: null,
  blocks: [
    {
      id: 'tm-score', title: '天猫店铺评分', state: 'warn', summary: '物流 4.68',
      items: [
        { label: '体验', value: '5.00', state: 'ok', note: '' },
        { label: '商品', value: '5.00', state: 'ok', note: '' },
        { label: '物流', value: '4.68', state: 'warn', note: '' },
        { label: '服务', value: '5.00', state: 'ok', note: '' },
      ],
    },
    {
      id: 'tm-alert', title: '天猫预警', state: 'ok', summary: '全部正常',
      items: [
        { label: '包裹异常', value: '0', state: 'ok', note: '无待办' },
        { label: '待处理违规', value: '0', state: 'ok', note: '无待办' },
        { label: '待处理投诉', value: '0', state: 'ok', note: '无待办' },
        { label: '待处理售后', value: '0', state: 'ok', note: '无待办' },
      ],
    },
    {
      id: 'tm-sales', title: '天猫', state: 'ok', summary: '今日 ¥0 · 昨日 ¥155.65',
      items: [{ label: '今日成交金额', value: '¥0', state: 'ok', note: '昨日 ¥155.65', collapseShow: true }],
    },
  ],
}

/** 抖音店铺数据：11 项**全是 `—`**，state 也全是 unknown（一项都没采到）。 */
const DY_SHOP = {
  file: 'patrol-dy-shop.json', name: '巡查-抖音-店铺数据', platform: 'dy',
  runAt: '2026-10-22T20:17:39.439Z', dataDate: '2026-10-23', ok: true, error: null,
  blocks: [
    {
      id: 'dy-score', title: '抖音店铺评分', state: 'unknown', summary: '部分指标未采集到',
      items: [
        { label: '体验', value: '—', state: 'unknown', note: '未匹配到，需人工查看' },
        { label: '商品', value: '—', state: 'unknown', note: '未匹配到，需人工查看' },
        { label: '物流', value: '—', state: 'unknown', note: '未匹配到，需人工查看' },
        { label: '服务', value: '—', state: 'unknown', note: '未匹配到，需人工查看' },
      ],
    },
    {
      id: 'dy-alert', title: '抖音预警', state: 'unknown', summary: '部分指标未采集到',
      items: [
        /* ★ 这一项**故意**是 `state: 'ok'` 但 `value: '—'` —— 真实数据就是这样。
         * 只看 `state` 的实现会把它当「采到了」摆进格子，而它恰恰是没匹配到。
         * 这是「判据两条都要」那条最值钱的观察点。 */
        { label: '待发货', value: '—', state: 'ok', note: '未匹配到' },
        { label: '异常包裹', value: '—', state: 'unknown', note: '未匹配到，需人工查看' },
        { label: '待处理售后', value: '—', state: 'unknown', note: '未匹配到，需人工查看' },
        { label: '服务工单', value: '—', state: 'unknown', note: '未匹配到，需人工查看' },
        { label: '待整改风险点', value: '—', state: 'unknown', note: '未匹配到，需人工查看' },
        { label: '待处理违规', value: '—', state: 'unknown', note: '未匹配到，需人工查看' },
      ],
    },
    {
      id: 'dy-sales', title: '抖音', state: 'unknown', summary: '今日成交 ¥—',
      items: [{ label: '今日成交金额', value: '—', state: 'unknown', note: '', collapseShow: true }],
    },
  ],
}

/** 千川：整体 `ok: false`，但「今日成交金额 0.00 元」这一项**真采到了**。 */
const DY_QIANCHUAN = {
  file: 'patrol-dy-qianchuan.json', name: '巡查-抖音-千川余额', platform: 'dy',
  runAt: '2026-10-29T17:40:16.804Z', dataDate: '2026-10-30', ok: false, error: null,
  blocks: [
    {
      id: 'qianchuan', title: '推广消耗（千川）', state: 'unknown', summary: '数据未采集到',
      items: [
        { label: '今日消耗', value: '—', state: 'unknown', note: '未匹配到，需人工查看', collapseShow: true },
        { label: '账户余额', value: '—', state: 'unknown', note: '未匹配到，需人工查看' },
        { label: '今日成交金额', value: '0.00 元', state: 'ok', note: '', collapseShow: true },
        { label: 'ROI', value: '—', state: 'unknown', note: '未匹配到' },
      ],
    },
  ],
}

/** 完整的三栏（今天真实的样子）。 */
const REAL_PAYLOAD = {
  ok: true,
  items: [TM_SHOP, DY_SHOP, DY_QIANCHUAN],
  broken: [{ file: 'patrol-tm-activity.json', name: '巡查-天猫-活动报名', why: 'blocks 不是非空数组（结果装在单数 block 里）、缺 runAt、缺 dataDate' }],
  missing: [{ file: 'patrol-dy-activity.json', name: '巡查-抖音-活动报名' }],
}

/** 看板那一层要的工作流（只放一份巡查，够验「保留」即可）。 */
const WF_ROWS = [{ name: '巡查-天猫-店铺数据', id: 'wf-tm', nodes: 9, startType: 'manual', at: Date.now() - 3600000 }]

/**
 * 挂总览，`/patrol/results` 的答复由参数决定。
 *
 * @param {object} opts - `{ patrol: object | null }`（`null` = 这条路由坏掉）。
 * @returns {Promise<object>} 挂载句柄。
 */
async function mountOverview(opts = {}) {
  const realFetch = window.fetch
  const stub = async (url, init) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '')
    const method = String(init?.method ?? 'GET').toUpperCase()
    if (p === '/api/ecom-workbench/patrol/results' && method === 'GET') {
      if (opts.patrol === null) return { ok: false, status: 500, json: async () => ({ ok: false, error: '读巡查结果时出错：ENOENT' }) }
      return { ok: true, status: 200, json: async () => (opts.patrol ?? REAL_PAYLOAD) }
    }
    if (p === '/api/ecom-workbench/workflows' && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ ok: true, dir: '/tmp', items: WF_ROWS, workflows: WF_ROWS }) }
    }
    if (p.startsWith('/api/ecom-workbench/workflow/runs')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, runs: [] }) }
    }
    return realFetch(url, init)
  }
  window.fetch = stub
  globalThis.fetch = stub
  const { OverviewBoard } = await import('../src/client/workbench/OverviewBoard.tsx')
  const m = await mount(React.createElement(OverviewBoard, {
    active: true, tab: '', apiBase: '/api/ecom-workbench', topHidden: false,
    onToggleTop: () => {}, onSelectTab: () => {}, onRunWorkflow: () => {},
  }))
  const raw = m.unmount
  m.unmount = () => { raw(); window.fetch = realFetch; globalThis.fetch = realFetch }
  return m
}

/** 所有指标格子的 `label`。 */
const labelsOf = m => [...m.el.querySelectorAll('[data-ewb-ov-metric]')].map(e => e.getAttribute('data-ewb-ov-metric'))

/** 某一格的 `value` 原文。 */
const valueOf = (m, label) =>
  m.el.querySelector('[data-ewb-ov-metric="' + label + '"] [data-ewb-ov-metric-value]')?.textContent ?? ''

/** 来源那一行的 class 状态。 */
const sourceState = (m, name) =>
  m.el.querySelector('[data-ewb-ov-source="' + name + '"]')?.getAttribute('data-ewb-ov-source-state') ?? ''

/** 来源那一行的文字。 */
const sourceText = (m, name) =>
  m.el.querySelector('[data-ewb-ov-source="' + name + '"]')?.textContent ?? ''

/* ══════════════════════════════════════════════════════════════════════
 * ① 天猫那 9 项全部出现（label 与 value 逐字对上）
 * ② 千川那 1 项出现
 * ⑨ value 原样，没有被包第二层单位
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ①②⑨ 采到的指标逐项出现，value 原样 ===')
{
  const m = await mountOverview()
  const labels = labelsOf(m)

  const tm = ['体验', '商品', '物流', '服务', '包裹异常', '待处理违规', '待处理投诉', '待处理售后', '今日成交金额']
  const missingTm = tm.filter(l => !labels.includes(l))
  check('★★★ 天猫那 9 项全都在（' + String(tm.length) + ' 项）', missingTm.length === 0,
    missingTm.length === 0 ? '' : '缺：' + missingTm.join('、'))
  check('★★★ 一共 10 格（天猫 9 + 千川 1）', labels.length === 10, String(labels.length))

  /* 逐字对上 value —— 「显示出来了」不等于「显示对了」。 */
  check('★★★ 体验 = 5.00', valueOf(m, '体验') === '5.00', valueOf(m, '体验'))
  check('★★★ 物流 = 4.68（就是那个 warn 的）', valueOf(m, '物流') === '4.68', valueOf(m, '物流'))
  check('★★ 服务 = 5.00', valueOf(m, '服务') === '5.00', valueOf(m, '服务'))
  check('★★ 包裹异常 = 0', valueOf(m, '包裹异常') === '0', valueOf(m, '包裹异常'))
  check('★★★ 今日成交金额 = ¥0（天猫那份；千川那份是 0.00 元，两者都出现了）',
    [...m.el.querySelectorAll('[data-ewb-ov-metric="今日成交金额"] [data-ewb-ov-metric-value]')]
      .map(e => e.textContent).sort().join(' ｜ ') === '0.00 元 ｜ ¥0',
    [...m.el.querySelectorAll('[data-ewb-ov-metric="今日成交金额"] [data-ewb-ov-metric-value]')].map(e => e.textContent).join(' ｜ '))
  check('★★★ 千川那 1 项（今日成交金额 = 0.00 元）出现',
    [...m.el.querySelectorAll('[data-ewb-ov-metric-value]')].some(e => e.textContent === '0.00 元'))

  /* ⑨ 单位不许自己加。 */
  check('★★★ ¥0 没有被包成 ¥¥0', valueOf(m, '今日成交金额') === '¥0' || valueOf(m, '今日成交金额') === '0.00 元',
    valueOf(m, '今日成交金额'))
  const allValues = [...m.el.querySelectorAll('[data-ewb-ov-metric-value]')].map(e => e.textContent ?? '')
  check('★★★ 所有 value 里没有出现「¥¥」或「元元」', !allValues.some(v => v.includes('¥¥') || v.includes('元元')),
    JSON.stringify(allValues))
  check('★★ 没给 5.00 那种裸数字补单位', allValues.includes('5.00') && !allValues.some(v => v === '5.00 分' || v === '5.00分'))

  /* warn 那格看得出来（颜色或标记）。 */
  check('★★ 物流那格带了 warn 状态', m.el.querySelector('[data-ewb-ov-metric="物流"]')?.getAttribute('data-ewb-ov-metric-state') === 'warn',
    m.el.querySelector('[data-ewb-ov-metric="物流"]')?.getAttribute('data-ewb-ov-metric-state') ?? '')
  check('★★ warn 那格有一个看得见的标记（不只靠颜色）',
    m.el.querySelector('[data-ewb-ov-metric="物流"] [data-ewb-ov-warn]') !== null)

  /* 分组：按 block.title（同名的并成一组）。 */
  const groupTitles = [...m.el.querySelectorAll('[data-ewb-ov-group]')].map(e => e.getAttribute('data-ewb-ov-group'))
  check('★★ 分组按 block.title（天猫店铺评分 / 天猫预警 / 天猫 / 推广消耗（千川））',
    ['天猫店铺评分', '天猫预警', '天猫', '推广消耗（千川）'].every(t => groupTitles.includes(t)),
    JSON.stringify(groupTitles))

  m.unmount()
}

/** 「一项都没采到」那句话（与源码里那个常量同一句，故意复述一遍当判据）。 */
const SOURCE_TEXT_NONE = '本份巡查未采到指标'

/* ══════════════════════════════════════════════════════════════════════
 * ③ 抖音那 11 项一个都不出现，但那一块有一句话
 * ④ state === 'unknown' 的项一律不进格子
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ③④ 一项都没采到的那份：不进格子，但要有一句话 ===')
{
  const m = await mountOverview()
  const labels = labelsOf(m)
  /* ⚠️ 判据**不能**拿「待处理售后 / 待处理违规」这种名字去查 ——
   * 天猫预警那块**也有**同名项，它们本来就该显示。
   * 只查抖音独有、且这 11 项里最典型的四个；再单独查分组标题不出现。 */
  const dyOnly = ['待发货', '异常包裹', '服务工单', '待整改风险点']
  const leaked = dyOnly.filter(l => labels.includes(l))
  check('★★★ 抖音店铺那 11 项一个都没进格子', leaked.length === 0, leaked.join('、'))
  const dyGroups = ['抖音店铺评分', '抖音预警', '抖音']
  const groupTitles = [...m.el.querySelectorAll('[data-ewb-ov-group]')].map(e => e.getAttribute('data-ewb-ov-group'))
  check('★★★ 抖音那三块分组一个都没建出来（整块不该出现在格子区）',
    dyGroups.every(t => !groupTitles.includes(t)), JSON.stringify(groupTitles))
  check('★★★ 但那一块没有消失：有一句「本份巡查未采到指标」',
    sourceText(m, '巡查-抖音-店铺数据').includes(SOURCE_TEXT_NONE), sourceText(m, '巡查-抖音-店铺数据'))
  check('★★ 那句标的是「没采到」这一类', sourceState(m, '巡查-抖音-店铺数据') === 'none',
    sourceState(m, '巡查-抖音-店铺数据'))
  /* ④ 的正面写法：`state === 'unknown'` 的项一律不出现。 */
  const unknownOnly = ['今日消耗', '账户余额', 'ROI']
  check('★★★ state 是 unknown 的项（今日消耗 / 账户余额 / ROI）也一个都没进格子',
    unknownOnly.every(l => !labels.includes(l)), JSON.stringify(unknownOnly.filter(l => labels.includes(l))))
  /* ★ 「待发货」是 state ok 但 value — 的那一项。 */
  check('★★★ `value` 是 `—` 的项也不进格子（哪怕 state 写着 ok）', !labels.includes('待发货'))
  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ broken 与 missing 各一句，两句不同
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ⑤ 格式不对 / 还没跑过：两句话不同 ===')
{
  const m = await mountOverview()
  const brokenText = sourceText(m, '巡查-天猫-活动报名')
  const missingText = sourceText(m, '巡查-抖音-活动报名')
  check('★★★ 格式不对那份说了「格式不对，读不出指标」', brokenText.includes('格式不对'), brokenText)
  check('★★★ 还没跑过那份说了「还没跑过」', missingText.includes('还没跑过'), missingText)
  check('★★★ 两句**不是同一句**（合成一句的话用户分不清该去看还是该去跑）',
    brokenText !== missingText && brokenText !== '' && missingText !== '')
  check('★★ 四类各自的状态不同（metrics / none / broken / missing）',
    new Set([sourceState(m, '巡查-天猫-店铺数据'), sourceState(m, '巡查-抖音-店铺数据'),
      sourceState(m, '巡查-天猫-活动报名'), sourceState(m, '巡查-抖音-活动报名')]).size === 4,
    [sourceState(m, '巡查-天猫-店铺数据'), sourceState(m, '巡查-抖音-店铺数据'),
      sourceState(m, '巡查-天猫-活动报名'), sourceState(m, '巡查-抖音-活动报名')].join(' / '))
  m.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 当前数据更新于 = 最近一条**成功**的 runAt
 * ⑦ 失败记录在成功之后 → 时间不变
 * ⑧ 一条成功都没有 → 「还没有可用数据」
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ⑥⑦⑧ 当前数据更新于 只认成功那几趟 ===')
{
  /* ⑥ 真实数据里三个时间：千川 10-29（`ok: false`）、抖音店铺 10-22（`ok: true` 但一项没采到）、
   * 天猫 10-19（`ok: true` 且真有数字）。
   *
   * 正确答案是**天猫 10-19** —— 两种写错法都会露馅：
   *   · 取「最新一条不管成败」→ 显示 10-29（千川）；
   *   · 只看 `ok` 不看采没采到 → 显示 10-22（抖音店铺），
   *     而那时格子里全是天猫的数字，时间与内容对不上。 */
  const m = await mountOverview()
  const upd = m.el.querySelector('[data-ewb-ov-updated]')
  check('★★★ 有「当前数据更新于」那一行', upd !== null)
  check('★★★ 它挂的是**真采到数据**那几条里最新的（天猫 10-19）',
    upd?.getAttribute('data-ewb-ov-updated') === '巡查-天猫-店铺数据',
    upd?.getAttribute('data-ewb-ov-updated') ?? '(没有)')
  /* ⚠️ 显示的是**本地时间**：`2026-10-19T22:54:00.205Z` 在东八区是 10-20 06:54。
   * 所以判据不能死写 10-19（那是 UTC 的那天）—— 那会把正确的实现判成错。 */
  check('★★ 那一行写的是被选中那份的时间（东八区 10-20 06:54）',
    (upd?.textContent ?? '').includes('10-20') && (upd?.textContent ?? '').includes('06:54'), upd?.textContent ?? '')
  check('★★★ 含「当前数据更新于」且时间与格子里那批数字同源',
    (upd?.textContent ?? '').startsWith('当前数据更新于 '), upd?.textContent ?? '')
  check('★★★ 也不是「跑成功了但一项没采到」那份的 10-22（时间与格子里的数字必须对得上）',
    !(upd?.textContent ?? '').includes('10-22'), upd?.textContent ?? '')
  check('★★ 屏上**没有**把千川那个时间当「当前数据」', !(m.el.textContent ?? '').includes('当前数据更新于 10-29'))
  m.unmount()

  /* ⑦ 喂一条失败记录在成功记录之后：时间不变、那一份的内容也不被它覆盖。 */
  const laterFail = {
    file: 'patrol-dy-activity.json', name: '巡查-抖音-活动报名', platform: 'dy',
    runAt: '2026-10-30T01:00:00.000Z', dataDate: '2026-10-30', ok: false, error: '登录态失效',
    blocks: [{ title: '抖音活动', items: [{ label: '报名中活动', value: '5', state: 'ok', note: '' }] }],
  }
  const m2 = await mountOverview({
    patrol: {
      ok: true,
      items: [TM_SHOP, laterFail],
      broken: [],
      missing: [],
    },
  })
  const upd2 = m2.el.querySelector('[data-ewb-ov-updated]')
  check('★★★ 失败那条（10-30）没有推进「当前数据更新于」',
    upd2?.getAttribute('data-ewb-ov-updated') === '巡查-天猫-店铺数据',
    upd2?.getAttribute('data-ewb-ov-updated') ?? '(没有)')
  check('★★★ 也没有拿它的 dataDate（2026-10-30）冒充', !(m2.el.textContent ?? '').includes('当前数据更新于 10-30'),
    upd2?.textContent ?? '')
  /* ── 但**它自己真采到的项**照样进格子（项看 state，更新于看 ok，两件事）。 ── */
  check('★★ 失败那趟里真采到的项照样进格子（指标看项自己的 state）',
    labelsOf(m2).includes('报名中活动'), JSON.stringify(labelsOf(m2)))
  m2.unmount()

  /* ⑧ 一条成功都没有。 */
  const m3 = await mountOverview({
    patrol: { ok: true, items: [laterFail], broken: [], missing: [] },
  })
  check('★★★ 一条成功都没有时写「还没有可用数据」',
    (m3.el.querySelector('[data-ewb-ov-nodata]')?.textContent ?? '').includes('还没有可用数据'),
    m3.el.querySelector('[data-ewb-ov-nodata]')?.textContent ?? '(没有)')
  check('★★★ 并且**不显示**那个失败的时间（10-30 / 01:00 都不许冒充当前数据）',
    m3.el.querySelector('[data-ewb-ov-updated]') === null && !(m3.el.textContent ?? '').includes('当前数据更新于'),
    m3.el.querySelector('[data-ewb-ov-updated]')?.textContent ?? '')
  m3.unmount()
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑩ 刷新按钮仍是真跑一次（走 FlowRunPanel 那条 SSE）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ⑩ 刷新仍是真的跑一次（复用的是 FlowRunPanel） ===')
{
  /* ⚠️ 必须装 `EventSource`：不装的话 FlowRunPanel 走「这个环境不支持实时推送」
   * 那条退路 —— 面板还是会出现，但断言看到的是退路，不是真的那条路。 */
  const opened = []
  class FakeEs {
    constructor(url) { this.url = String(url); this.handlers = {}; this.closed = false; opened.push(this) }
    addEventListener(kind, fn) { (this.handlers[kind] ||= []).push(fn) }
    close() { this.closed = true }
  }
  window.EventSource = FakeEs
  globalThis.EventSource = FakeEs

  const m = await mountOverview()
  const btn = m.el.querySelector('[data-ewb-dashboard-refresh="巡查-天猫-店铺数据"]')
  check('★★ 看板还在，且带着刷新按钮（这一段原样保留）', btn !== null)
  btn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await env.settle()
  const panel = m.el.querySelector('[data-ewb-dashboard-runpanel]')
  check('★★★ 点刷新后展开了跑的画面', panel !== null)
  check('★★ 那条画面里是 FlowRunPanel（走的是同一条 SSE，不是另写一套）',
    panel?.querySelector('[data-ewb-flow-panel]') !== null)
  check('★★★ 确实开了一条 `/workflow/run-stream`',
    opened.length === 1 && opened[0].url.includes('/workflow/run-stream'),
    String(opened.length) + ' ' + (opened[0]?.url ?? ''))

  m.unmount()
  window.EventSource = undefined
  globalThis.EventSource = undefined
}

/* ══════════════════════════════════════════════════════════════════════
 * 反向：巡查结果这条路由坏掉时，看板那层照样能看
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== 反向：/patrol/results 坏了不许把整页变成错误页 ===')
{
  const m = await mountOverview({ patrol: null })
  check('★★ 巡查结果读不到时**没有**整页报错（看板那层照样显示）',
    m.el.querySelector('[data-ewb-dashboard]') !== null)
  check('★★ 但说清了指标为什么没有', m.el.querySelector('[data-ewb-ov-patrol-err]') !== null,
    m.el.querySelector('[data-ewb-ov-patrol-err]')?.textContent ?? '(没有)')
  check('★★ 指标区给空态而不是一片空白', m.el.querySelector('[data-ewb-ov-metrics-empty]') !== null)
  m.unmount()
}

console.log('')
console.log(env.getFailed() === 0 ? '结论：总览显示的是数据本身 ✓' : '结论：有 ' + String(env.getFailed()) + ' 条不通过 ✗')
process.exit(env.getFailed() === 0 ? 0 : 1)
