/** 浏览器节点（**一个节点 + 动作下拉**，照 n8n 的形态）。
 *
 * ## 为什么合并成一个节点（用户 2026-10-12 定的）
 *
 * 原来有 5 个浏览器节点（点击 / 输入 / 等待 / 截图 / 执行 JS），
 * 用户的选择是「**合并成一个「浏览器」节点，动作是下拉**」——
 * 依据是 n8n 的做法（它的 Playwright 节点就一个，六个操作在下拉里）。
 *
 * **用户的节点原则**（原话）：
 * > 「节点应该尽量少，尽量通用；如果当前节点无法完成或完成过于复杂，
 * >   则新建逻辑节点。」
 *
 * 所以这里不按「一个动作一个节点」铺开，而是**一个节点 + 动作参数**。
 *
 * ## 会话（用户定的）
 *
 * 每个浏览器节点上都有 `session`：**同名 = 同一个浏览器**。
 * 依据是 n8n 的 Session ID 机制；我们的用法见
 * `plans/工作流基础-2026-10-12-02-节点目录化与浏览器层.md` §3.2。
 *
 * ⚠️ **「确保浏览器可用」不做成独立节点** —— 它是**会话的行为**
 * （首次用到某会话时自动查端口 / 启动 / 等待）。理由：那是准备动作，
 * 每个工作流都因此多一个节点不值得，而失败信息挂在**用它的那个节点**上更直观。
 */
import type { NodeDef } from '../../../workflow/model.ts'

export const NODE: NodeDef = {
  id: 'browser.act',
  category: 'browser',
  /* ⚠️ 名字里带上 **playwright**（用户 2026-10-13 要求）。
   *
   * 用户原话：「这个浏览器节点名称改一下，改成：**浏览器-playwright**。
   * 虽然当前只有一个，但还是**明确一下用的是什么**。」
   *
   * 理由：将来可能有别的驱动（如 CDP 直连、别的自动化库），
   * 那时节点会变多，名字里不带驱动名就分不清谁是谁。
   * 与调研结论一致（`docs/` 里 n8n 的命名也是「Playwright 节点」）。 */
  label: '浏览器-playwright',
  summary: '在已登录的浏览器里做一件事（打开页面 / 点击 / 输入 / 取文本 / 截图 / 执行脚本）',
  /* ⚠️ `builtin`：宿主半收到派发时**自己拼 argv 起子进程**。
   *
   * 为什么不写 `shell`（让客户端拼命令）：**驱动脚本的完整路径只有宿主半知道**
   * （它在 `lib/nodes/browser/driver.mjs`，位置由宿主半自己算），
   * 而客户端在浏览器里跑、拿不到文件系统路径。
   *
   * 但语义上仍是「起子进程」—— 依据（用户现有脚本的实战注释）：
   * 「playwright 的 CDP 连接会挂住事件循环，成功路径隐式退出会卡住进程」，
   * 放宿主半进程内会把它卡死。 */
  executor: 'builtin',
  inputs: [{ id: 'in', label: '输入', type: 'any' }],
  outputs: [{ id: 'out', label: '结果', type: 'any' }, { id: 'page', label: '页面', type: 'data' }],
  deps: { npm: ['playwright'], bin: ['node'] },
  onError: 'stop',
  params: {
    action: 'goto',
    session: '默认',
    /**
     * 第二层：**怎么连**（`cdp` / `headed` / `headless`）。
     *
     * ⚠️ **不由用户直接填** —— 由画布按**标签**从设置里解析后写入，
     * 而设置里用户选的是「**来源**」（已开的调试端口 / 本机装着的浏览器），
     * 这个值是从来源 + 打开方式**推导**出来的（见 `browser-settings.ts` 的 `launcherOf`）。
     * 理由（用户 2026-10-13 定的两层）：「第一层决定第二层……其他的节点第二层自动统一
     * （保持一致性，不然，明明用来保证一个页面的标签一样，浏览器不一样，
     * 那么运行必然会出问题，甚至不一定是报错）」。
     *
     * 放在节点 params 里的原因：**宿主半拿不到 localStorage**
     * （它跑在 Node 进程里，设置在浏览器那边）。而 params 是存档的一部分、
     * 客户端写、宿主半读 —— 正好是这条数据的天然通道。
     */
    launcher: 'cdp',
    /** 第二层：用哪个可执行文件（空 = 用 Playwright 自带的）。同样由标签解析写入。 */
    exePath: '',
    /**
     * 第二层：**CDP 调试端口**（用户 2026-10-14 手填的那个）。
     *
     * ⚠️ 与 `launcher` / `exePath` 一样由画布按标签解析后写入，理由同上
     * （宿主半读不到 localStorage）。
     *
     * ⚠️ **默认是空串，不是 9222** —— 用户原话：
     * 「我希望 **9222 这个不是默认而是前端可见的手填项目**，**不能是硬编码的**」。
     * 空串 = 还没填，那时驱动会明确报错并说清怎么办（不会悄悄连 9222）。
     */
    port: '',
    /* 各动作自己的参数（只显示当前动作用得上的那几个）。 */
    url: '',
    waitUntil: 'domcontentloaded',
    selector: '',
    text: '',
    clear: true,
    scope: 'viewport',
    format: 'png',
    code: '',
    timeout: 30000,
  },
  detail: {
    what: '在已经登录的常驻浏览器里做一件浏览器该做的事。它不会新开浏览器，'
      + '所以沿用浏览器里现成的登录态（这是采集能跑通的前提）。',
    inputs: '任意上游数据（可以给本节点的参数用 `{{变量}}` 引用）。',
    outputs: '「结果」是这一步的产出（取到的文本 / 截图路径等）；'
      + '「页面」给下游继续操作同一个页面用。',
    whenToUse: '采集流程里凡是要动浏览器的步骤：打开网址、点按钮、填输入框、'
      + '把页面上的文字抓回来、截图留证。',
    cautions: '一个节点做一件事。要连着做几件（打开 → 点 → 抓），'
      + '就按顺序连几个本节点，而不是指望它一次做完。'
      + '「执行脚本」是兜底手段：页面上的动作找不到对应选项时，用它直接写代码。',
  },
  paramDefs: [
    {
      key: 'action',
      label: '做什么',
      kind: 'select',
      default: 'goto',
      options: [
        { value: 'goto', label: '打开页面', description: '在浏览器里打开一个网址' },
        { value: 'click', label: '点击', description: '点页面上的按钮 / 链接 / 标签' },
        { value: 'input', label: '输入文本', description: '往输入框里填内容' },
        { value: 'text', label: '取文本', description: '把某个元素里的文字抓回来给下游用' },
        { value: 'screenshot', label: '截图', description: '把页面或某个元素存成图片' },
        { value: 'eval', label: '执行脚本', description: '在页面里跑一段 JS，兜底用' },
      ],
      hint: '一个节点只做一件事。要连着做几件，按顺序连几个本节点。',
    },
    {
      key: 'session',
      label: '用哪个浏览器',
      kind: 'text',
      default: '默认',
      required: true,
      placeholder: '默认',
      /**
       * ⚠️ **界面上不渲染**（用户 2026-10-16：「这个设置和浏览器中的标签重复了对吧？
       * 如果是重复了就去掉他」）。
       *
       * 它确实与下面「浏览器」一节里的**标签**写的是同一个值（`params.session`）——
       * 同一个东西两个入口，看着像两件事。所以参数区不再画它，
       * 改标签只去「浏览器」一节。
       *
       * **参数定义必须留着**（不能直接删）：
       *   ① `default: '默认'` 与执行链读的是这个键；
       *   ② 节点卡片上的**会话色标**靠 `hasSession(paramDefs)` 判断该不该显示，
       *      判据就是「有没有 `session` 这个参数」—— 删了色标也没了；
       *   ③ 「浏览器」一节的**出现条件**用的是同一条判据。
       *
       * 机制见 `model.ts` 的 `ParamDef.hidden`（照 n8n 的 `type: 'hidden'`
       * 与 Dify 的 `hide?: boolean`，两家都有这一条）。
       */
      hidden: true,
      hint: '同名 = 同一个浏览器。改它在下面的「浏览器」一节里（那一节的「标签」就是这个值）。'
        + '只有在需要「另一台浏览器、另一份登录态」时才改这个名字。',
    },
    {
      key: 'url',
      label: '网址',
      kind: 'text',
      required: true,
      placeholder: 'https://compass.jinritemai.com/shop/business-part',
      showWhen: { key: 'action', equals: ['goto'] },
      hint: '要打开的网址。可以写 `{{上游变量}}` 引用上一步的输出。',
    },
    {
      key: 'waitUntil',
      label: '等到什么时候算打开完',
      kind: 'select',
      default: 'domcontentloaded',
      options: [
        { value: 'domcontentloaded', label: '页面结构出来就行', description: '最快；页面上的数据可能还没加载完' },
        { value: 'load', label: '连图片等资源都加载完', description: '稳一点，慢一点' },
        { value: 'networkidle', label: '网络空闲（没有新请求）', description: '最稳；数据是 JS 异步拉的页面用这个' },
      ],
      showWhen: { key: 'action', equals: ['goto'] },
      hint: '选「页面结构出来就行」最容易超时失败；数据是异步加载的页面选「网络空闲」。',
    },
    {
      key: 'selector',
      label: '目标元素',
      kind: 'text',
      required: true,
      placeholder: '.aurora-dropdown-trigger',
      showWhen: { key: 'action', equals: ['click', 'input', 'text', 'screenshot'] },
      hint: '目标元素的 CSS 选择器。在浏览器里右键元素 → 检查，复制它的 class 或 id。'
        + '页面改版后选择器常常失效，那时先回来改这里。',
    },
    {
      key: 'text',
      label: '要填的内容',
      kind: 'textarea',
      placeholder: '{{keyword}}',
      showWhen: { key: 'action', equals: ['input'] },
      hint: '往输入框里填的文字。可以写 `{{上游变量}}`——按关键词列表搜索时就这样用。',
    },
    {
      key: 'clear',
      label: '先清空原来的内容',
      kind: 'boolean',
      default: true,
      advanced: true,
      showWhen: { key: 'action', equals: ['input'] },
      hint: '是否先清空输入框再填。默认清空（避免旧内容留在里面）。',
    },
    {
      key: 'scope',
      label: '截哪一块',
      kind: 'select',
      default: 'viewport',
      options: [
        { value: 'viewport', label: '当前可见区域', description: '最常见，文件小' },
        { value: 'full', label: '整个页面（含需滚动才能看到的部分）', description: '页面很长时图会很大' },
        { value: 'element', label: '只截某个元素', description: '需要填「目标元素」' },
      ],
      showWhen: { key: 'action', equals: ['screenshot'] },
      hint: '「整个页面」遇到很长的页面会生成很大的图，注意磁盘占用。',
    },
    {
      key: 'format',
      label: '图片格式',
      kind: 'select',
      default: 'png',
      options: [
        { value: 'png', label: 'PNG', description: '无损，文件大' },
        { value: 'jpeg', label: 'JPEG', description: '有损，文件小' },
      ],
      advanced: true,
      showWhen: { key: 'action', equals: ['screenshot'] },
      hint: '只作留证用选 JPEG 就够（文件小一半）。要看清细节选 PNG。',
    },
    {
      key: 'code',
      label: '脚本',
      kind: 'textarea',
      required: true,
      placeholder: 'return await page.title()',
      showWhen: { key: 'action', equals: ['eval'] },
      hint: '在页面里跑的一段 JS（等价于在控制台里执行）。返回值就是本节点的「结果」。'
        + '这是兜底手段：能用上面的动作就别用它。',
    },
    {
      key: 'timeout',
      label: '最长等待',
      kind: 'number',
      default: 30000,
      unit: '毫秒',
      min: 1000,
      step: 1000,
      advanced: true,
      hint: '这一步最多等多久。页面慢或网络差时调大。默认 30000 毫秒（30 秒）。',
    },
  ],
}
