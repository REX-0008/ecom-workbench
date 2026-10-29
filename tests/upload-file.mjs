/** 素材上传的纯函数（契约 CG，2026-10-26）。
 *
 * ## 这一段补的是哪个缺口
 *
 * BB 那轮核查报告的：「jsdom 造不出带文件的 `FileList`（`DataTransfer` 没实现），
 * 所以真实选文件那一下**没被自动化走过**，只验了源码层」。
 *
 * 现在把关从组件里抽成了 `prepareUpload`：它接一个
 * `{name, size, type, base64}` 对象（**不是 `File`**），所以能真跑断言。
 *
 * 跑法：node --import <tsx> tests/upload-file.mjs
 */
const {
  prepareUpload, base64FromDataUrl, mimeOfName, humanBytes, unsafeNameWhy,
  MAX_UPLOAD_BYTES,
} = await import('../src/client/workbench/upload-file.ts')

let bad = 0
/**
 * 断言一条。
 * @param {string} name - 用例名。
 * @param {boolean} ok - 过没过。
 * @param {string} detail - 细节。
 */
function check(name, ok, detail) {
  if (!ok) bad += 1
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail === undefined ? '' : ' → ' + detail))
}

/** 真 PNG 的 base64（1×1）。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * 造一个候选。
 * @param {object} over - 覆盖字段。
 * @returns {object} 候选。
 */
function cand(over = {}) {
  return { name: 'cat.png', size: 1024, type: 'image/png', base64: PNG_B64, ...over }
}

/* ── ① 正常通过 ─────────────────────────────────────────────────── */
console.log('① 正常通过')
{
  const r = prepareUpload(cand())
  check('★★ 一张 PNG 通过', 'why' in r === false, 'why' in r ? r.why : '')
  check('★★ 通过时给出可直接 POST 的 body（name + base64）',
    'why' in r === false && r.upload.name === 'cat.png' && r.upload.base64 === PNG_B64,
    JSON.stringify('why' in r ? null : Object.keys(r.upload)))
  /* 视频也过。 */
  check('★ 视频通过', 'why' in prepareUpload(cand({ name: 'clip.mp4', type: 'video/mp4' })) === false, '')
  /* 名字大小写不影响判类型。 */
  check('★ 名字大写也认（A.PNG）', 'why' in prepareUpload(cand({ name: 'A.PNG' })) === false, '')
  /* mime 为空也能过（靠扩展名判类型，不靠 mime）。 */
  check('★★ `type` 为空也能过（类型看扩展名，不看 mime）',
    'why' in prepareUpload(cand({ type: '' })) === false, '')
}

/* ── ② 超 6 MB 拒绝（验收 5 的第一条）──────────────────────────── */
console.log('')
console.log('② 超 6 MB 拒绝')
{
  const r = prepareUpload(cand({ size: MAX_UPLOAD_BYTES + 1 }))
  check('★★ 6 MB + 1 字节被拒绝', 'why' in r === true, '')
  check('★★ 说清多大、上限多少',
    'why' in r && String(r.why).includes('文件太大') && String(r.why).includes('6.00 MB'),
    'why' in r ? r.why : '')
  check('★★ 还解释**为什么是 6 MB 而不是 8 MB**（不然用户觉得这上限很随便）',
    'why' in r && String(r.why).includes('1.33'), 'why' in r ? r.why.slice(0, 60) : '')
  /* 边界：正好 6 MB 放行。 */
  check('★★ 正好 6 MB 放行（边界不多拦一个字节）',
    'why' in prepareUpload(cand({ size: MAX_UPLOAD_BYTES })) === false, '')
  check('★ 上限就是 6 MB', MAX_UPLOAD_BYTES === 6 * 1024 * 1024, String(MAX_UPLOAD_BYTES))
}

/* ── ③ 带 .. 拒绝（验收 5 的第二条）────────────────────────────── */
console.log('')
console.log('③ 带 .. 拒绝')
{
  const r = prepareUpload(cand({ name: '../escape.png' }))
  check('★★ `../escape.png` 被拒绝', 'why' in r === true, '')
  check('★★ 说清不能有「..」', 'why' in r && String(r.why).includes('..'), 'why' in r ? r.why : '')
  check('★ `a..b.png` 也拒绝（不许出现两个点连写）',
    'why' in prepareUpload(cand({ name: 'a..b.png' })) === true, '')
  check('★★ 路径分隔符也拒绝',
    'why' in prepareUpload(cand({ name: 'a/b.png' })) === true
    && 'why' in prepareUpload(cand({ name: 'a\\b.png' })) === true, '')
  check('★ 以点开头拒绝（隐藏文件）',
    'why' in prepareUpload(cand({ name: '.hidden.png' })) === true, '')
  check('★ 中文名拒绝（服务器只收字母数字与 . _ -）',
    'why' in prepareUpload(cand({ name: '猫.png' })) === true, '')
  check('★ unsafeNameWhy 对正常名字给空串', unsafeNameWhy('my-cat_01.png') === '', '')
  check('★ 空名字拒绝', 'why' in prepareUpload(cand({ name: '' })) === true, '')
}

/* ── ④ 坏 base64 拒绝（验收 5 的第三条）────────────────────────── */
console.log('')
console.log('④ 坏 base64 拒绝')
{
  const empty = prepareUpload(cand({ base64: '' }))
  check('★★ 内容是空串 → 拒绝且说「读不出来」',
    'why' in empty && String(empty.why).includes('读不出来'), 'why' in empty ? empty.why : '')
  const junk = prepareUpload(cand({ base64: '这不是base64!!!' }))
  check('★★ 不是 base64 → 拒绝且说清',
    'why' in junk && String(junk.why).includes('base64'), 'why' in junk ? junk.why : '')
  /* 带换行 / 空格的 base64 也算坏（FileReader 不会产出那种形状）。 */
  check('★ 中间带空格的 base64 也拒绝',
    'why' in prepareUpload(cand({ base64: 'AAAA BBBB' })) === true, '')
  /* 带 `=` 补齐的合法 base64 要放行（很多真实 base64 末尾有 =）。 */
  check('★★ 带 `=` 补齐的合法 base64 放行',
    'why' in prepareUpload(cand({ base64: 'iVBORw0KGgo=' })) === false, '')
}

/* ── ⑤ 类型与空文件 ─────────────────────────────────────────────── */
console.log('')
console.log('⑤ 类型与空文件')
{
  const txt = prepareUpload(cand({ name: 'note.txt' }))
  check('★★ .txt 拒绝且说「只收图片与视频」',
    'why' in txt && String(txt.why).includes('只收图片与视频'), 'why' in txt ? txt.why : '')
  check('★ 没有扩展名拒绝',
    'why' in prepareUpload(cand({ name: 'afile' })) === true, '')
  const zero = prepareUpload(cand({ size: 0 }))
  check('★★ 0 字节拒绝且说「是空的」',
    'why' in zero && String(zero.why).includes('空的'), 'why' in zero ? zero.why : '')
  check('★ 负数字节也拒绝', 'why' in prepareUpload(cand({ size: -1 })) === true, '')
}

/* ── ⑥ 校验顺序：先报最有用的那个错 ─────────────────────────────── */
console.log('')
console.log('⑥ 校验顺序（先报用户最该看到的那个）')
{
  /* 一个既类型错、又超大的文件：先报类型（那更可能是真原因）。 */
  const both = prepareUpload(cand({ name: 'x.txt', size: MAX_UPLOAD_BYTES * 2 }))
  check('★★ 类型错 + 超大 → 报类型（更可能是真原因）',
    'why' in both && String(both.why).includes('只收图片与视频'), 'why' in both ? both.why.slice(0, 40) : '')
  /* 名字带 .. 又超大：先报名字（它决定能不能落盘）。 */
  const both2 = prepareUpload(cand({ name: '../x.png', size: MAX_UPLOAD_BYTES * 2 }))
  check('★★ 名字非法 + 超大 → 报名字',
    'why' in both2 && String(both2.why).includes('..'), 'why' in both2 ? both2.why.slice(0, 40) : '')
}

/* ── ⑦ dataUrl 剥前缀（组件里最容易写错的一行）────────────────── */
console.log('')
console.log('⑦ dataUrl 剥前缀')
{
  check('★★ 标准形状剥对了',
    base64FromDataUrl('data:image/png;base64,' + PNG_B64) === PNG_B64, '')
  check('★ 没有逗号时原样返回', base64FromDataUrl('abc') === 'abc', '')
  check('★ 空串给空串', base64FromDataUrl('') === '', '')
  check('★ 内容里带逗号也只切第一个（后面原样留）',
    base64FromDataUrl('data:x;base64,AAA,BBB') === 'AAA,BBB', '')
}

/* ── ⑧ 工具函数 ─────────────────────────────────────────────────── */
console.log('')
console.log('⑧ 工具函数')
{
  check('★★ mimeOfName：png → image/png', mimeOfName('a.png') === 'image/png', mimeOfName('a.png'))
  check('★ mp4 → video/mp4', mimeOfName('a.mp4') === 'video/mp4', mimeOfName('a.mp4'))
  check('★ 不认识的扩展名给 octet-stream',
    mimeOfName('a.xyz') === 'application/octet-stream', mimeOfName('a.xyz'))
  check('★★ humanBytes：512 B / 2.0 KB / 6.00 MB',
    humanBytes(512) === '512 B' && humanBytes(2048) === '2.0 KB'
    && humanBytes(6 * 1024 * 1024) === '6.00 MB',
    [humanBytes(512), humanBytes(2048), humanBytes(6 * 1024 * 1024)].join(' / '))
  check('★ humanBytes 对负数与 NaN 给 —（不抛错）',
    humanBytes(-1) === '—' && humanBytes(Number.NaN) === '—', '')
}

/* ── ⑨ 与宿主那侧同一套规则（两处判据不许漂）──────────────────── */
console.log('')
console.log('⑨ 客户端与宿主的判据一致')
{
  const { isMaterialSafe } = await import('../src/schedule/materials.ts')
  /* 客户端先挡一遍只为「早点告诉用户」；真正生效的是宿主那一道。
   * 两边对同一批名字必须给同样的结论 —— 不然会出现「客户端放行、宿主 400」。 */
  const names = ['cat.png', '../x.png', 'a/b.png', 'a..b.png', '.hidden.png', '猫.png', 'a b.png']
  const mismatch = []
  for (const n of names) {
    const clientOk = unsafeNameWhy(n) === ''
    const hostOk = isMaterialSafe(n)
    if (clientOk !== hostOk) mismatch.push(n + '(客户端' + String(clientOk) + '/宿主' + String(hostOk) + ')')
  }
  check('★★ 两边对同一批名字结论一致（不会出现「客户端过、宿主 400」）',
    mismatch.length === 0, mismatch.join(' | '))
}

console.log('')
console.log(bad === 0
  ? '结论：上传把关（超 6 MB / 带 .. / 坏 base64 / 正常）全部通过 ✓'
  : '结论：有 ' + String(bad) + ' 条不通过 ✗')
process.exit(bad === 0 ? 0 : 1)
