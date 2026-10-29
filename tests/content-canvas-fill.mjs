/**
 * 票 62：内容画布补齐 —— 通知条、节点与连线计数、锁定、素材搜索与空态两句
 *
 * ## 为什么单独一个文件
 *
 * 这四样里三样是**结构性事实**（源码里有没有那条拦截、那个钩子），
 * 一样是**行为**（通知条出现 → 点 × → 消失）。
 * 前三种只能读源码/挂载验，第四种要挂 React。
 *
 * 票 58 已做掉的两样（素材搜索、空态两句）在这里只做**验收**，
 * 不重复验它们的行为 —— 那在 `side-align.mjs` 里。
 */
import { readFileSync } from 'node:fs'

let failed = 0

/**
 * 记一条断言。
 * @param name - 断言名。
 * @param ok - 成立吗。
 * @param detail - 失败时的补充信息。
 */
function check(name, ok, detail) {
  if (ok) console.log('  ✓ ' + name + (detail === undefined ? '' : '  —— ' + detail))
  else {
    console.log('  ✗ ' + name + (detail === undefined ? '' : '  —— ' + detail))
    failed += 1
  }
}

/**
 * 读源码并剥注释（注释里提到的东西不算「用了」）。
 * @param f - `src/client/workbench/` 下的文件名。
 * @returns 去注释后的文本。
 */
function srcOf(f) {
  const t = readFileSync('src/client/workbench/' + f, 'utf8')
  return t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const cc = srcOf('ContentCanvas.tsx')
const notices = srcOf('notices.tsx')
const css = readFileSync('src/client/workbench/EcomWorkbench.module.css', 'utf8')

/* ══════════════════════════════════════════════════════════════════════
 * ① 通知条
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ① 通知条（判据 1）===')
{
  check('★★ 判据 1：内容画布**复用**执行画布那个组件（不是复制一份）',
    /import \{ useNotices, NoticeBar \} from '\.\/notices\.tsx'/.test(cc))
  check('★★ 判据 1：`useNotices` 挂上了',
    /const \{ notices, notify, dismiss \} = useNotices\(\)/.test(cc))
  check('★★ 判据 1：`<NoticeBar>` 渲染了',
    /<NoticeBar notices=\{notices\} onDismiss=\{dismiss\} \/>/.test(cc))
  check('★★ 判据 1：自动保存失败进通知条',
    /notify\('自动保存失败：' \+ why, 'error'\)/.test(cc),
    (/notify\('自动保存失败[^)]*\)/.exec(cc) ?? [''])[0])
  check('★★ 判据 1：素材存失败进通知条',
    /notify\('存进素材库失败：' \+ why, 'error'\)/.test(cc))
  check('★★ 判据 1：上传失败进通知条',
    /notify\('「' \+ want\.name \+ '」' \+ why, 'error'\)/.test(cc))
  /* 那行红字**保留**（它是「刚刚那一下」的就地提示，与通知条分工不同）。 */
  check('★★ 判据 1：原来那行红字**保留**（与通知条分工，不是替换）',
    /data-ewb-canvas-error=""/.test(cc))
  /* 通知条组件本身带手动关闭。 */
  check('★★ 判据 1：通知条可手动关（组件里有 × 按钮）',
    /className=\{css\.noticeClose\}/.test(notices) && />×</.test(notices))
  check('★★ 判据 1：`error` 语气**不自动消失**（只有非 error 才起计时器）',
    /if \(tone !== 'error'\)/.test(notices))
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 计数条
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ② 节点与连线计数（判据 2）===')
{
  check('★★ 判据 2：计数条有独立钩子 `data-ewb-content-count`',
    /data-ewb-content-count=""/.test(cc))
  check('★★ 判据 2：三个数都在（节点 / 连线 / 选中）',
    /节点 \{nodes\.length\}/.test(cc) && /' \/ ' \+ String\(edges\.length\) \+ ' 连线'/.test(cc)
    && /selCount > 0 &&/.test(cc))
  check('★★ 判据 2：选中为 0 时**不显示**那一项（与执行画布一致）',
    /selCount > 0 && <span/.test(cc))
  check('★★ 判据 2：`selCount` 是实时算的（不是缓存的旧值）',
    /const selCount = nodes\.filter\(n => n\.selected === true\)\.length/.test(cc))
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 锁定：四条拦截
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ③ 锁定（判据 3、4）===')
{
  check('★★ 判据 3 之一：拦拖动（`nodesDraggable={!locked}`）',
    /nodesDraggable=\{!locked\}/.test(cc))
  check('★★ 判据 3 之二：拦拉线（`nodesConnectable={!locked}`）',
    /nodesConnectable=\{!locked\}/.test(cc))
  check('★★ 判据 3 之三：拦改尺寸（`onNodesChange` 里丢掉 dimensions）',
    /locked \? changes\.filter\(c => c\.type !== 'dimensions'\) : changes/.test(cc),
    (/const next = locked[\s\S]{0,120}/.exec(cc) ?? [''])[0].slice(0, 100))
  check('★★ 判据 3 之四：拦 `Delete`（`deleteSelected` 开头就 return）',
    /const deleteSelected = useCallback\(\(\): number => \{\s*\n\s*\/\*[^\n]*\*\/\s*\n\s*if \(locked\) return -1/.test(cc)
    || /if \(locked\) return -1/.test(cc))
  check('★★ 判据 3 之五：拦右键菜单删除',
    /if \(locked\) \{\s*\n\s*disarmDelete\(\)\s*\n\s*setErr\('画布已锁定，先解锁才能删除'\)/.test(cc))

  /* ⚠️ 这一条是「有意不同」的守卫：将来谁「顺手统一」加了这个属性，这里会红。 */
  check('★★ 判据 3：`elementsSelectable` **没有**被加上 `!locked`（与执行画布有意不同）',
    !/elementsSelectable=\{!locked\}/.test(cc),
    '锁着也要能点开节点看侧栏详情')

  check('★★ 判据 3：解锁后四项都恢复（属性直接是 `!locked`，没有别处再拦）',
    (cc.match(/locked/g) ?? []).length >= 6, '共出现 ' + String((cc.match(/locked/g) ?? []).length) + ' 次')

  check('★★ 判据 4：锁定状态存进 `localStorage`（刷新后还在）',
    /localStorage\.getItem\('ewb\.contentLocked'\)/.test(cc))
  check('★★ 判据 4：写盘用的是同一个键',
    /localStorage\.setItem\('ewb\.contentLocked'/.test(cc))
  /* ⚠️ 与执行画布**各用各的键**（用户 2026-10-29 认可）。 */
  check('★★ 判据 4：用的是 `ewb.contentLocked`，**不是**执行画布那个 `ewb.locked`',
    !/localStorage\.(get|set)Item\('ewb\.locked'/.test(cc))

  /* 返回值语义必须写清（lead 点名要求）。
   *
   * ⚠️ 这条**必须读原文**（不剥注释）—— 它验的就是文档有没有写。
   * 在 `cc`（已剥注释）上跑永远红，第一版就踩了这个。 */
  const ccRaw = readFileSync('src/client/workbench/ContentCanvas.tsx', 'utf8')
  check('★★ 判据 3：`deleteSelected` 的返回值三种取值写清楚了',
    /`> 0`/.test(ccRaw) && /`< 0`/.test(ccRaw) && /没有选中项/.test(ccRaw),
    '文档里要有「>0 真删了几个」「0 没选中」「<0 被锁拦」三行')
  check('★★ 判据 3：`Delete` 键那处按 `!== 0` 判（盖住「被拦」那一支）',
    /if \(nodesGone !== 0 \|\| edgeGone\) e\.preventDefault\(\)/.test(cc))
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 素材搜索与空态两句（票 58 已做，这里只验收）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ④ 素材搜索与空态（判据 5，票 58 已做）===')
{
  const side = srcOf('CanvasSidePanel.tsx')
  check('★★ 判据 5：素材 tab 有搜索框',
    /placeholder="搜索素材…"/.test(side))
  check('★★ 判据 5：空态分两句（「本来就没有」与「搜不到」不是同一句）',
    /素材目录是空的/.test(side) && /没有匹配/.test(side),
    (/没有匹配[^<]{0,30}/.exec(side) ?? [''])[0])
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 不做空画布引导（判据 6）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑤ 不做空画布引导（判据 6）===')
{
  /* 反面断言：空画布时不许出现引导文案。
   * 按**用户会看到的词**判，不按类名 —— 类名可能被复用。 */
  const GUIDE_WORDS = ['拖一个节点进来', '开始创作', '从左侧拖', '点击此处添加', '双击空白']
  const hits = GUIDE_WORDS.filter(w => cc.includes(w))
  check('★★ 判据 6：内容画布里**没有**空画布引导文案',
    hits.length === 0, hits.join('、'))
  check('★★ 判据 6：也没有「空画布」那一类引导元素',
    !/data-ewb-empty-guide|contentEmptyGuide/.test(cc))
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 文案与边界
 * ══════════════════════════════════════════════════════════════════════ */
console.log('')
console.log('=== ⑥ 文案与边界（判据 9）===')
{
  const texts = ['画布已锁定，先解锁才能删除', '锁定画布，防止误拖动 / 误删', '画布已锁定（只读）。点一下解锁才能编辑']
  check('★★ 判据 9：锁定相关文案不用第二人称',
    texts.every(t => !/你/.test(t)))
  check('★★ 判据 9：也不用疑问句做标签',
    texts.every(t => !/[？?]$/.test(t)))
}

console.log('')
console.log(failed === 0 ? '结论：内容画布补齐的六样都对 ✓' : '结论：有 ' + String(failed) + ' 条不通过 ✗')
process.exit(failed === 0 ? 0 : 1)
