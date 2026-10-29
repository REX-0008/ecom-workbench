/** 设置板块排版（票 02，2026-10-30，用户第 3、5 条）。
 *
 * # 这一单修的三件事
 *
 * | 用户原话 | 修法 |
 * |---|---|
 * | 「默认模型说明文字太多」 | 逐句按「删掉会不会做错事」裁，三段裁成一句 |
 * | 「dsh 模型目录展开后内容覆盖叠加」 | `.section { flex: 0 0 auto }` —— 不许被压扁 |
 * | 「标题文字大小都不统一，模型和 comfyui 没有横线」 | 每一节都有上边线；三处块标题统一用 `.sectionTitle` |
 *
 * # 为什么这一份要单独写（`dom-render` 里也有几条）
 *
 * `dom-render` 那几条验的是**骨架**（两格不渗透、顺序对、`titleClassName` 传进去）。
 * 这一份验的是**排版规则本身**：
 *
 *   ① `.section` 里有没有 `flex: 0 0 auto`（叠加的修法）
 *   ② `.section` 里有没有 `border-top`（每一节都有线，含第一块）
 *   ③ 三个 tab 的每一块是不是**真的都套了 `.section`**（这是「模型和 comfyui 没线」的根）
 *   ④ 块标题是不是**都指向同一个字号**（用户抱怨三档并存）
 *   ⑤ 说明文字有没有被裁（防止「改回去」）
 *
 * # ⚠️ 关于「叠加」这条能验到什么程度
 *
 * jsdom **不排版**，`getBoundingClientRect` 全返回 0 —— 「视觉上没有叠在一起」
 * 这件事**验不到**。所以这一份验的是**修法**：`.section` 里有 `flex: 0 0 auto`。
 *
 * 这条判据的可靠性来自 CSS 语义：纵向 flex 容器里 `flex-shrink: 0` 的子项**不会**
 * 被压到小于内容高度，而溢出只在「子项被压扁」时才发生。所以「声明在」等价于
 * 「机制在」。**但真机截图我没做**（本票禁止打包，且 Playwright 的浏览器没装）。
 *
 * 跑法：`node scripts/run-tests.mjs settings-layout`
 */
import { readFileSync } from 'node:fs'

let bad = 0
/**
 * 断言。
 * @param {string} name - 断言名。
 * @param {boolean} ok - 过没过。
 * @param {string} [detail] - 细节。
 */
function check(name, ok, detail) {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : '  → ' + detail))
}

/**
 * 读一个源码文件。
 * @param {string} rel - 相对 `src/client/workbench/` 的路径。
 * @returns {string} 内容。
 */
function src(rel) {
  return readFileSync(new URL('../src/client/workbench/' + rel, import.meta.url), 'utf8')
}

const CSS = src('WorkbenchSettings.module.css')
/**
 * 抠出某条类规则体。
 * @param {string} css - 整份 CSS。
 * @param {string} cls - 类名（不带点）。
 * @returns {string} 规则体；没有给空串。
 */
function bodyOf(css, cls) {
  const m = new RegExp('\\.' + cls + '\\s*\\{([\\s\\S]*?)\\}').exec(css)
  return m === null ? '' : m[1]
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 叠加的修法：`.section` 不许被压扁
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 叠加的修法：每一节都不许被 flex 压扁 ===')
{
  const body = bodyOf(CSS, 'section')
  check('★★★ `.section` 里有 flex: 0 0 auto（或 flex-shrink: 0）',
    /flex:\s*0\s+0\s+auto/.test(body) || /flex-shrink:\s*0/.test(body),
    body.trim().split('\n').map(s => s.trim()).filter(s => s !== '').join(' '))

  /* ★★ 反面：**不许**在 `.section` 上写 `flex: 1` 或 `min-height: 0` ——
   * 那两条正是让它「可被压扁」的写法（`ModelListSection` / `ChannelSettings`
   * 原来就是这么写的，所以它们俩会溢出来）。 */
  check('★★★ `.section` 里没有 flex: 1 / min-height: 0（那是可被压扁的写法）',
    !/flex:\s*1\b/.test(body) && !/min-height:\s*0/.test(body),
    body.trim())
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 每一节都有上边线（含第一块）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 每一节都有上边线（不是只在相邻两节之间）===')
{
  const body = bodyOf(CSS, 'section')
  check('★★★ `.section` 自己的规则里有 border-top（所以第一块也有线）',
    /border-top/.test(body), body.trim().split('\n').map(s => s.trim()).filter(s => s !== '').join(' '))

  /* ★★ 相邻两节之间仍然要有留白（旧判据保留，别退化成「有线但贴着」）。 */
  const gap = /\.section\s*\+\s*\.section\s*\{([\s\S]*?)\}/.exec(CSS)
  check('★★ `.section + .section` 仍有 margin-top（节间留白没丢）',
    gap !== null && /margin-top/.test(gap[1]), gap === null ? '（没有这条规则）' : gap[1].trim())

  /* ★ 第一节**不再**被特殊去掉横线（原来 `.section:first-child` 若写 border-top: none
   * 就等于第一块没线，正是用户抱怨的那种不一致）。 */
  const firstChild = /\.section:first-child\s*\{([\s\S]*?)\}/.exec(CSS)
  check('★★ 没有「第一节去掉上边线」那种规则',
    firstChild === null || !/border-top:\s*none/.test(firstChild[1]),
    firstChild === null ? '（没有这条规则，好）' : firstChild[1].trim())
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 三个 tab 的每一块**真的都套了 `.section`**
 * ══════════════════════════════════════════════════════════════════════
 *
 * 这是「模型和 comfyui 没有横线」的根：`ModelListSection` 与 `ChannelSettings`
 * 原来用 Tailwind 现写、没套 `ws.section`，所以它们那一块既没线也没间距。
 * 只改 CSS 不改组件的话，那条 CSS 对它们**根本不生效** —— 这就是「改了没变化」。 */
console.log('')
console.log('=== ③ 三个 tab 的每一块都套了同一个外壳（ws.section）===')
{
  /* 三处块：**最终都要落在一个 `.section` 里** —— 但「谁套的」可以不同。
   *
   * | 块 | 谁套的 `.section` |
   * |---|---|
   * | 默认模型（`DefaultsSettings`） | **外面** `ConfigBoard.tsx:168` 那层 |
   * | 模型清单（`ModelListSection`） | **自己**带 |
   * | ComfyUI 渠道（`ChannelSettings`） | **自己**带 |
   *
   * 只要求「最终落在一个 `.section` 里」，不要求每个组件自己带 ——
   * 否则默认模型那块会**套两层**，画出两条横线、间距还翻倍。
   *
   * 判据做法：前两个看自己文件的根；默认模型看 `ConfigBoard` 有没有把它包起来。 */
  const SELF_WRAPPED = [
    ['ModelListSection.tsx', 'data-ewb-model-list'],
    ['ChannelSettings.tsx', 'data-ewb-channels'],
  ]
  for (const [file, hook] of SELF_WRAPPED) {
    const s = src(file)
    check('★★★ ' + file + ' import 了 WorkbenchSettings.module.css',
      /import \w+ from '\.\/WorkbenchSettings\.module\.css'/.test(s))
    const rootRe = new RegExp('className=\\{[^}]*\\b\\w+\\.section\\b[^}]*\\}[^>]*' + hook)
    check('★★★ ' + file + ' 的根元素套了 ws.section（不是 Tailwind 现写）',
      rootRe.test(s),
      rootRe.test(s) ? '' : '根上找不到 ws.section —— 那一块不会有横线')
  }

  /* ★★★ 默认模型那一块：**由 `ConfigBoard` 外面包一层 `.section`**，
   * 而且它自己的根**不许**再套 —— 套两层会出现两条横线。 */
  const cfg = src('ConfigBoard.tsx')
  check('★★★ ConfigBoard 把 DefaultsSettings 包在 css.section 里',
    /<div className=\{css\.section\}\s+data-ewb-content-defaults-section="">[\s\S]{0,200}?<DefaultsSettings/.test(cfg))
  const defSrc = src('DefaultsSettings.tsx')
  check('★★★ DefaultsSettings 自己的根**不**再套 ws.section（否则两条横线）',
    !/data-ewb-defaults=""/.test(defSrc.split('\n').find(l => l.includes('data-ewb-defaults=""'))?.replace(/^.*(className=)/, '$1') ?? '')
    || !/\w+\.section[^>]*data-ewb-defaults=""/.test(defSrc),
    (defSrc.split('\n').find(l => l.includes('data-ewb-defaults=""')) ?? '').trim())

  /* ★★★ 反面：那两个文件里**不许**再在根上写 `overflow-y-auto` ——
   * 外层 `ConfigBoard` 已经是滚动容器，内层再套一个就是「滚动套滚动」，
   * 那正是「展开一块之后内容错位」的另一半原因（内层自己滚，外层量不到真实高度）。 */
  for (const file of ['ModelListSection.tsx', 'ChannelSettings.tsx']) {
    const s = src(file)
    const rootLine = s.split('\n').find(l => /data-ewb-(model-list|channels)=""/.test(l) && l.includes('<div')) ?? ''
    check('★★ ' + file + ' 的根不自带 overflow-y-auto（滚动交给外层 ConfigBoard）',
      rootLine !== '' && !rootLine.includes('overflow-y-auto'),
      rootLine.trim().slice(0, 120) || '（找不到根元素那一行）')
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 块标题统一一个字号
 * ══════════════════════════════════════════════════════════════════════
 *
 * 用户抱怨的是「标题文字大小都不统一」。查下来三档：`.sectionTitle`（body）、
 * `.subTitle`（meta）、三处块标题的 Tailwind `text-ewb-caption uppercase`。
 *
 * 现在前两档合并（块标题改用 `.sectionTitle`），`.subTitle` 保持小一档
 * —— 那是**副标题**，与节标题不是一个层级，不该算进「三档并存」里。 */
console.log('')
console.log('=== ④ 块标题与节标题同一个字号（不再三档并存）===')
{
  const titleBody = bodyOf(CSS, 'sectionTitle')
  const titleSize = /font-size:\s*var\((--text-ewb-[\w-]+)\)/.exec(titleBody)?.[1] ?? ''
  check('★★ `.sectionTitle` 的字号是 --text-ewb-body（全板块唯一那一档）',
    titleSize === '--text-ewb-body', titleSize === '' ? '（没写 var()）' : titleSize)

  /* ★★★ 三处块标题必须用 `sectionTitle`，**不许**再写 caption + uppercase。 */
  const HEADS = [
    ['ModelListSection.tsx', 'data-ewb-model-list-head'],
    ['ChannelSettings.tsx', 'data-ewb-channel-head'],
    ['DefaultsSettings.tsx', 'data-ewb-defaults-head'],
  ]
  for (const [file, hook] of HEADS) {
    const s = src(file)
    /* ⚠️ 必须找到**那个元素**那一行，不能只找含钩子的第一行 ——
     * 注释里也会提钩子名（`data-ewb-channel-head` 在 ChannelSettings 的注释里出现过），
     * 匹配到注释就会误报。所以要求这一行同时含 `<span`。 */
    const seg = s.split('\n').find(l => l.includes(hook) && l.includes('<span')) ?? ''
    check('★★★ ' + file + ' 的块标题用 sectionTitle（不再 caption + uppercase）',
      /\.sectionTitle\b/.test(seg) && !/text-ewb-caption/.test(seg),
      seg.trim().slice(0, 120) || '（找不到带钩子的 <span>）')
  }

  /* ★★ 全文件扫一遍：不许有残留的 `text-ewb-caption uppercase` 当**节/块标题**用。
   *
   * ⚠️ 只有**表单内**的小标题可以留着（「新建模型」「新建渠道」「工作流（每个类别一份…）」）——
   * 那三处是**表单里的小标题**，不是节的标题，用户抱怨的「三档字号」不包括它们。
   * 所以判据要排除它们，不能一刀切扫全文（那样会误伤，然后被人用 `// eslint-disable`
   * 那种方式绕过去 —— 判据要能长期留着，就必须只钉该钉的）。 */
  const FORM_INNER = ['新建模型', '新建渠道', '编辑 ', '工作流（每个类别一份']
  const leftovers = ['ModelListSection.tsx', 'ChannelSettings.tsx', 'DefaultsSettings.tsx']
    .flatMap(file => {
      const s = src(file)
      const lines = s.split('\n')
      return [...s.matchAll(/^.*text-ewb-caption uppercase.*$/gm)]
        .map(m => m[0])
        /* ⚠️ 文字往往在**下一行**（JSX 里 `<span>` 与它的内容分行写），
         * 所以要看「本行 + 后两行」再判是不是表单内小标题。 */
        .filter(line => {
          const i = lines.indexOf(line.trim() === line ? line : lines.find(l => l.includes(line.trim())) ?? '')
          const window = i < 0 ? line : lines.slice(i, i + 3).join(' ')
          return !FORM_INNER.some(w => window.includes(w))
        })
        .map(line => file + ': ' + line.trim().slice(0, 80))
    })
  check('★★ 三个组件里没有残留的「caption + uppercase」**节标题**样式（表单内小标题除外）',
    leftovers.length === 0, leftovers.join(' | ') || '（零残留）')
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 说明文字被裁过（防止改回去）
 * ══════════════════════════════════════════════════════════════════════
 *
 * 用户第 3 条：「默认模型说明文字太多」。裁的判据是「删掉会不会做错事」。
 * 这一组只验**结果**（长度与必须留的那一句），不验写法：
 * 哪天有人加回一句长解释，这一组会红。 */
console.log('')
console.log('=== ⑤ 说明文字裁过（不许改回长解释）===')
{
  const def = src('DefaultsSettings.tsx')
  /* 取「文本」那一格说明元素的正文。 */
  const note = /data-ewb-defaults-text-note=""[\s\S]{0,400}?>\s*([^<]+?)\s*</.exec(def)?.[1]?.trim() ?? ''
  check('★★★ 「文本」那格的说明还在（不是删光）', note !== '', note)
  check('★★★ 只剩一句、不超过 30 字（原来 78 字）', note.length > 0 && note.length <= 30,
    note.length + ' 字：「' + note + '」')
  /* 必须留的那一条：OpenAI 不支持文字（删了用户会去配一个做不了的默认）。 */
  check('★★★ 留下了「OpenAI 不能生成文字」那条（删了会让人配错）',
    note.includes('OpenAI') && note.includes('文字'), note)
  /* 删掉的那两句不许回来。 */
  check('★★ 不再解释「谁在用它」（删掉不会做错事的那句）',
    !note.includes('文本节点') && !note.includes('反推'), note)
  check('★★ 不再罗列「哪个协议能生成」（那是默认预期）',
    !note.includes('ComfyUI') && !note.includes('Gemini'), note)

  /* ★★ dsh 模型目录那两句也裁短了。 */
  const ws = src('WorkspaceSettings.tsx')
  const pickNote = /data-ewb-model-picks=""[\s\S]{0,300}?>\s*([^<]+?)\s*</.exec(ws)?.[1]?.trim() ?? ''
  check('★★ 「清单是空的」那句不超过 40 字', pickNote.length > 0 && pickNote.length <= 40,
    pickNote.length + ' 字：「' + pickNote + '」')
}

console.log('')
console.log(bad === 0 ? '结论：设置排版三条都钉住了 ✓' : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
