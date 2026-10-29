/** 下载节点（`browser.download`，显示名「下载-playwright」）：触发下载 + 等事件 + 落盘，**一个节点做完**。
 *
 * ## 名字（用户 2026-10-19 明确）
 *
 * 用户原话：「将延迟下载节点改名。名字为：下载-playwright。下载与浏览器作为两个节点。」
 *
 * 所以：
 *   · `label` = **下载-playwright**（旧名「延迟下载」已废）；
 *   · 与「浏览器-playwright」（`browser.act`）是**两个节点**，不合并 —— 用户明确要分开；
 *   · `category` 仍是 `browser`（用户没要求拆分类，只说改名）。
 *
 * 「-playwright」这个后缀是**有信息量的**：它说明这一步是在**真的浏览器**里做的
 * （与 `sys.fs.*` 那类本机节点区分开），用户一眼能看出这步需要开着浏览器。
 *
 * ## 为什么必须「一件事一个节点」（技术硬约束，不是设计偏好）
 *
 * 依据（Playwright 官方 Download 文档已核实，见
 * `plans/2026-10-12-脚本拆分设计方案.md` §3.4）：
 *
 * | 事实 | 官方原文 |
 * |---|---|
 * | 临时文件会没 | *All the downloaded files belonging to the browser context are **deleted when the browser context is closed*** |
 * | `path()` 远程不可用 | *The method **throws when connected remotely*** |
 * | 必须先挂监听再点击 | *Start waiting for download before clicking. **Note no await*** |
 *
 * 我们走 CDP = **远程连接**，所以 `download.path()` 直接抛错；
 * 而临时文件在上下文关闭后就没了。所以「触发 → 等事件 → `saveAs`」
 * **必须在同一个进程内一口气做完**，中间不能断成几个节点。
 *
 * ## 边界（用户定的「落盘后就结束」）
 *
 * 本节点**只到落盘**。文件头校验 / 改名 / 归档 / 已存在跳过是**另做节点**的事
 * （那些可拆、可单独重跑，不依赖「download 事件」这个稍纵即逝的东西）。
 *
 * ## 参数按「触发方式 + 落盘位置」两组组织
 *
 * 触发有两套（点页面按钮 / 直接开下载链接），界面用 `showWhen` 只显示用得上的。
 */
import type { NodeDef } from '../../../workflow/model.ts'

export const NODE: NodeDef = {
  id: 'browser.download',
  category: 'browser',
  label: '下载-playwright',
  summary: '在已登录的浏览器里点一下下载按钮，把接下来要下的文件存到指定位置',
  /* 与「浏览器」节点同理：驱动脚本跑在子进程里（CDP 连接会挂住事件循环）。 */
  executor: 'builtin',
  inputs: [{ id: 'in', label: '输入', type: 'any' }],
  /* ⚠️ 输出类型用 `text` 而不是想象一个 `file` ——
   * 端口类型只有 data / text / image / number / any（见 workflow/model.ts）。
   * 而且「文件路径」本质上就是一段文字，下游用它去读文件、改名、归档都合适。
   * 用 `any` 反而丢掉了「这是一段文字」的提示。 */
  outputs: [{ id: 'file', label: '文件路径', type: 'text' }, { id: 'out', label: '结果', type: 'any' }],
  deps: { npm: ['playwright'], bin: ['node'] },
  /* 下载失败**默认停**：文件没下来还往下跑，后面所有校验都会错。 */
  onError: 'stop',
  params: {
    session: '默认',
    trigger: 'click',
    selector: '',
    url: '',
    dir: '',
    filename: '',
    timeout: 120000,
  },
  detail: {
    what: '在已登录的浏览器里点一下下载按钮，把浏览器随即开始下载的文件'
      + '直接存到指定位置。它解决的问题是：浏览器默认把文件下到「下载」文件夹、'
      + '名字还带一串乱码，后面没法按固定名字找。',
    inputs: '任意上游数据（参数里可以写 `{{变量}}` 引用）。',
    outputs: '下载好的文件完整路径（给后面的「校验 / 改名 / 归档」用）。',
    whenToUse: '凡是「点了按钮之后浏览器自己开始下载」的步骤都用它。'
      + '比如报表导出、图片素材下载。',
    cautions: '触发和落盘必须是同一个节点，中间不能断开 —— '
      + '浏览器的下载临时文件在连接结束后就没了，这是它的机制。'
      + '所以别指望「先点按钮、再用另一个节点存文件」。',
  },
  paramDefs: [
    {
      key: 'session',
      label: '用哪个浏览器',
      kind: 'text',
      default: '默认',
      required: true,
      placeholder: '默认',
      /**
       * ⚠️ **界面上不渲染** —— 与下面「浏览器」一节里的**标签**是同一个值
       * （`params.session`），两个入口重复了（用户 2026-10-16 报的）。
       * 参数定义必须留着：默认值、会话色标（`hasSession`）、
       * 「浏览器」一节的显示条件都靠它。机制见 `model.ts` 的 `ParamDef.hidden`。 */
      hidden: true,
      hint: '要和前面「打开页面」那个节点用同一个名字，'
        + '否则找不到那个页面（下载按钮就在那个页面上）。改它在下面的「浏览器」一节里。',
    },
    {
      key: 'trigger',
      label: '怎么触发下载',
      kind: 'select',
      default: 'click',
      options: [
        { value: 'click', label: '点页面上的按钮', description: '最常见：点「导出」「下载」按钮' },
        { value: 'url', label: '直接开一个下载链接', description: '已知文件地址时用，例如接口返回的直链' },
      ],
      hint: '多数情况选「点页面上的按钮」。只有手里已经有文件地址时才用第二项。',
    },
    {
      key: 'selector',
      label: '下载按钮',
      kind: 'text',
      required: true,
      placeholder: '.export-btn',
      showWhen: { key: 'trigger', equals: ['click'] },
      hint: '下载按钮的 CSS 选择器（右键元素 → 检查，复制 class 或 id）。',
    },
    {
      key: 'url',
      label: '下载链接',
      kind: 'text',
      required: true,
      placeholder: 'https://.../report.xlsx',
      showWhen: { key: 'trigger', equals: ['url'] },
      hint: '文件的直接地址。可以写 `{{上游变量}}`（例如上一步接口返回的直链）。',
    },
    {
      key: 'dir',
      label: '存到哪个目录',
      kind: 'text',
      required: true,
      placeholder: 'D:\\报表\\抖音',
      hint: '文件保存的目录。不填文件名时用它自动起名（带时间戳，不会覆盖已有的）。'
        + '可以写 `{{变量}}` 做按日期/店铺分目录。',
    },
    {
      key: 'filename',
      label: '文件名',
      kind: 'text',
      advanced: true,
      placeholder: '留空 = 自动起名',
      hint: '想固定名字就填（例如 `{{date}}-交易.xlsx`）。'
        + '留空则用「原名 + 时间戳」——同名文件会被覆盖，所以按日期跑时建议留空。',
    },
    {
      key: 'timeout',
      label: '最多等多久',
      kind: 'number',
      default: 120000,
      unit: '毫秒',
      min: 5000,
      step: 5000,
      advanced: true,
      hint: '从点下去到文件下载完的最长等待。报表类文件可能几十秒，默认 120000 毫秒（2 分钟）。',
    },
  ],
}
