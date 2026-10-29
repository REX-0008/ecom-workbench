/** 巡查工作流的**配置表**（单一来源：生成器与测试都用）。
 *
 * ## 拆法（用户 2026-10-14 定的）
 *
 * 用户原话：「**将巡查根据平台、任务命名，如果当前有两个平台混在一起的就拆分。**」
 *
 * 拆之前是 3 份（`shop` / `activity` / `qianchuan`），其中 **2 份混了平台**：
 *   · `shop`     = 天猫店铺数据 + 抖音店铺数据
 *   · `activity` = 天猫活动报名 + 抖音活动报名
 *   · `qianchuan` = 抖音千川（单平台，不用拆）
 *
 * 拆之后是 **5 份，每份一个平台**：
 *
 * | 名字 | 平台 | 干什么 |
 * | --- | --- | --- |
 * | 巡查-天猫-店铺数据 | 天猫 | 余额/店铺状态判档 |
 * | 巡查-天猫-活动报名 | 天猫 | 报名中的活动有没有异常 |
 * | 巡查-抖音-店铺数据 | 抖音 | 余额/店铺状态判档 |
 * | 巡查-抖音-活动报名 | 抖音 | 报名中的活动有没有异常 |
 * | 巡查-抖音-千川余额 | 抖音 | 千川余额判档 |
 *
 * ## ⚠️ 拆开带来两个**必须交代**的变化
 *
 * ### 一、不再有「合并两平台结果」这一步
 * 原来 `shop`/`activity` 各有一个合并节点（把天猫与抖音的结果合成一份、
 * 按「部分失败仍算成功」算 ok）。拆开后**一份工作流只有一个平台**，
 * 那个合并节点**不再需要**（它存在的唯一理由就是合两个平台）。
 * 于是每份工作流更短、结果文件也更小。
 *
 * ### 二、结果文件从 3 个变成 5 个
 * 原来是 `patrol-shop.json` / `patrol-activity.json` / `patrol-qianchuan.json`。
 * 现在每份一个文件（见下面 `outFile`）。
 * ⚠️ **实测确认：现有代码里没有任何东西在读这些文件**
 * （`grep` 过 `src/` 全目录，只有一处注释提到「巡查-shop」）。
 * 它们是**写给将来面板看的**，所以改名/增数**不会破坏任何现有功能**。
 *
 * ## ⚠️ 命名里的「平台-任务」两段
 * 用户要求「根据**平台、任务**命名」→ 所以名字是 `<平台>-<任务>`，
 * 再看不出 `shop` / `activity` 这种内部代号。
 */

/**
 * 一份巡查工作流的定义。
 *
 * @typedef {object} PatrolJob
 * @property {string} id - 存档文件名用的短名（也是 outFile 的名字）。
 * @property {string} name - 面板里显示的名字（**平台-任务**）。
 * @property {string} platform - `'tm' | 'dy'`。
 * @property {string} tag - 浏览器会话标签（决定用哪个浏览器）。
 * @property {string} url - 要打开的页面。
 * @property {string} task - 干什么（一句话，进工作流的说明字段）。
 * @property {string} parseKind - 给解析器选哪套规则（`'tm' | 'dy' | undefined`）。
 * @property {() => string} parse - 解析代码。
 * @property {string} outFile - 结果文件路径。
 */

/** 任务种类（决定用哪段解析代码）。 */
export const TASK_KINDS = {
  /** 店铺数据：余额 / 店铺状态判档。 */
  shop: 'shop',
  /** 活动报名：报名中的活动有没有异常。 */
  activity: 'activity',
  /** 千川余额：余额与日预算消耗。 */
  qianchuan: 'qianchuan',
}

/**
 * 五份巡查工作流的配置。
 *
 * ⚠️ 这里的 `url` / `tag` 全是照源码（`自动巡查/src/*.ts`）逐条搬的，
 * 与「巡查-…」拆开前**完全一致** —— 只是**分组方式**变了（按平台而不是按任务）。
 *
 * ⚠️ **不放解析代码**（那几百行由生成器按 `kind` 选）——
 * 这样本表能被测试单独引用，不必把解析代码也拖进来。
 */
export const PATROL_JOBS = [
  {
    id: 'patrol-tm-shop',
    name: '巡查-天猫-店铺数据',
    kind: TASK_KINDS.shop,
    platform: 'tm',
    tag: '天猫',
    url: 'https://myseller.taobao.com/home.htm/QnworkbenchHome/',
    task: '看天猫店铺的余额与店铺状态，按阈值判档',
    outFile: 'patrol-tm-shop.json',
  },
  {
    id: 'patrol-tm-activity',
    name: '巡查-天猫-活动报名',
    kind: TASK_KINDS.activity,
    platform: 'tm',
    tag: '天猫',
    url: 'https://myseller.taobao.com/home.htm/starb/tmc-next/sale/seller/homepage.htm?tab=item',
    task: '看天猫报名中的活动有没有异常（报名异常只告警、不判致命）',
    outFile: 'patrol-tm-activity.json',
  },
  {
    id: 'patrol-dy-shop',
    name: '巡查-抖音-店铺数据',
    kind: TASK_KINDS.shop,
    platform: 'dy',
    tag: '抖音',
    url: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
    task: '看抖音店铺的余额与店铺状态，按阈值判档',
    outFile: 'patrol-dy-shop.json',
  },
  {
    id: 'patrol-dy-activity',
    name: '巡查-抖音-活动报名',
    kind: TASK_KINDS.activity,
    platform: 'dy',
    tag: '抖音',
    url: 'https://fxg.jinritemai.com/ffa/merchant/campaign-square?list_tab=access&f_tab=1&apply_tab=good',
    task: '看抖音报名中的活动有没有异常（J 表行数第二次校验要减 3）',
    outFile: 'patrol-dy-activity.json',
  },
  {
    id: 'patrol-dy-qianchuan',
    name: '巡查-抖音-千川余额',
    kind: TASK_KINDS.qianchuan,
    platform: 'dy',
    tag: '千川',
    /* ⚠️ 千川的 URL **不带 aavid 账号参数**（源码里带）—— 换号时不会出错。 */
    url: 'https://qianchuan.jinritemai.com/home',
    task: '看千川余额与日预算消耗，按阈值判档',
    outFile: 'patrol-dy-qianchuan.json',
  },
]
