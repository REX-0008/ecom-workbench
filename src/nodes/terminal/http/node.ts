/** 节点定义（纯数据：不 import 任何 Node 内置模块，客户端与宿主半共用这一份）。
 *
 * 一个节点一个目录 —— 见 `plans/2026-10-08-板块范式与目录规划.md` §2 与总纲「节点化」条。
 * 注册表在 `src/nodes/index.ts` 集中维护（加节点要在这里补一行，原因见那里的说明）。
 */
import type { NodeDef } from '../../../workflow/model.ts'

export const NODE: NodeDef = {
  id: 'sys.http',
  category: 'terminal',
  label: 'HTTP 请求',
  summary: '发一个 HTTP 请求（对接任何接口的万能节点）',
  executor: 'http',
  inputs: [{ id: 'body', label: '请求体', type: 'any' }],
  outputs: [{ id: 'response', label: '响应', type: 'data' }, { id: 'status', label: '状态码', type: 'number' }],
  onError: 'continueErrorOutput',
  params: { method: 'GET', url: '', headers: '', bodyType: 'json', timeout: 30000 },
  /**
   * 让节点上的「最长等多久」（`params.timeout`）真正生效（契约 CG，2026-10-26）。
   *
   * ## 加这一行之前是什么样
   *
   * 界面上那个参数一直写着「超过该时长判定失败」，参数表里也确实有
   * `timeout: 30000` —— 但**执行层一个字都没读它**：
   * · `workflow/command.ts` 的 http 分支只拼 `url` / `method` / `headers` / `body`；
   * · `dispatch/executors.ts` 的 http 执行方虽然在类型里声明了 `timeoutMs`，
   *   函数体里一次都没用过（`grep 'c.timeoutMs'` 原来是 0 处）。
   *
   * 后果：用户在这个节点上填 10 分钟，实际生效的仍是派发器的全局 300 秒 ——
   * 一条慢接口会在 5 分钟时被判超时，而界面上写着「能等 10 分钟」。
   *
   * ## 加上之后怎么走
   *
   * 三层优先级（实现在 `workflow/model.ts` 的 `readTimeout`，与「执行命令」节点
   * 契约 BE 那次完全同一套）：
   *
   * ```
   * params.timeout        ← 用户当场填的，最高
   *   → def.timeoutMs     ← 这类节点的静态上限（本节点没写，所以跳过）
   *     → 派发器全局      ← 没填时的兜底（300 秒）
   * ```
   *
   * `readTimeout` 读出来的值由 `run.ts:1292` 塞进 `DispatchRequest.timeoutMs`
   * （契约 AV 加的那个字段），派发器的 `withTimeout` 就按它设超时。
   */
  timeoutParam: 'timeout',
  detail: {
    what: '发起 HTTP 请求。对接任何没有专用节点的接口都用它——包括自有服务与第三方 API。',
    inputs: '请求体（POST/PUT 时用）。',
    outputs: '响应内容；以及状态码（200 表示成功）。',
    whenToUse: '要调用的服务没有专用节点时；对接企业内部接口时。',
    cautions: '密钥不要直接写在请求头里——放在「环境变量」节点或密钥配置中更安全。',
  },
  paramDefs: [
    { key: 'method', label: '请求方式', kind: 'select', default: 'GET', options: [
      { value: 'GET', label: 'GET', description: '读取数据' },
      { value: 'POST', label: 'POST', description: '新建 / 提交' },
      { value: 'PUT', label: 'PUT', description: '更新（全量）' },
      { value: 'DELETE', label: 'DELETE', description: '删除' },
    ], hint: '查询数据用 GET；提交或新建用 POST；更新数据用 PUT。' },
    { key: 'url', label: '接口地址', kind: 'text', required: true, placeholder: 'https://api.example.com/v1/items',
      hint: '完整的接口地址。可用 {{变量}} 拼参数。' },
    { key: 'headers', label: '请求头', kind: 'json', placeholder: '{"Authorization":"Bearer …"}',
      hint: 'JSON 格式的请求头，如 {"Authorization":"Bearer <令牌>"}。密钥建议放环境变量，不要写死在这里。' },
    { key: 'bodyType', label: '请求体格式', kind: 'select', default: 'json', options: [
      { value: 'json', label: 'JSON', description: '最常见' },
      { value: 'form', label: '表单', description: '老式接口 / 文件上传' },
      { value: 'raw', label: '原始文本', description: '自行拼接的字符串' },
      { value: 'none', label: '不带请求体', description: 'GET 请求用' },
    ], hint: '按接口文档要求填写。多数现代接口为 JSON。' },
    { key: 'timeout', label: '最长等多久', kind: 'number', default: 30000, unit: '毫秒', min: 1000, step: 1000, advanced: true,
      hint: '超过该时长判定失败。默认 30000 毫秒（30 秒）。接口响应慢时调大。' },
  ],
}
