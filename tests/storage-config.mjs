/** 本地存储目录可改（2026-10-26，T-B-后端）。
 *
 * # 验什么
 *
 * 「能改」「改完真生效」「不可写的目录要拦住」三件事，加上「不许半套生效」。
 * 真磁盘操作，但**全部在 `EWB_TEST_HOME` 沙箱里**。
 *
 * 跑法：node scripts/run-tests.mjs storage-config
 */
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.EWB_TEST_HOME = await mkdtemp(join(tmpdir(), 'ewb-storage-'))
process.env.EWB_TEST_SKILLS = join(process.env.EWB_TEST_HOME, 'skills')
process.env.EWB_TEST_NO_SPAWN = '1'

const {
  readStorageConfig, saveStorageConfig, checkDir, effectiveDirs, dirsSummary,
  applyStorageConfig, STORAGE_KEYS, STORAGE_FILE,
} = await import('../src/schedule/storage-config.ts')
const { artifactsDir, materialsDir, dataRoot } = await import('../src/schedule/artifacts.ts')

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

/* ── ① 默认状态 ───────────────────────────────────────────────────── */

console.log('① 没改过：五个目录都在数据根下')
{
  const cfg = await readStorageConfig()
  check('★★ 全新安装没有配置（不是报错）', Object.keys(cfg).length === 0, JSON.stringify(cfg))
  const dirs = effectiveDirs()
  check('★★ 五格都有路径', STORAGE_KEYS.every(k => typeof dirs[k] === 'string' && dirs[k] !== ''),
    JSON.stringify(dirs))
  check('★★ 默认时 artifacts 就是数据根下的 artifacts',
    dirs.artifacts === join(dataRoot(), 'artifacts'), dirs.artifacts)
  const sum = dirsSummary()
  check('★★ 摘要里五格都标「是默认」', sum.length === 5 && sum.every(d => d.isDefault === true),
    JSON.stringify(sum.map(d => d.key + ':' + d.isDefault)))
  check('★★ 摘要带中文字段名（报错要说人话）',
    sum.find(d => d.key === 'artifacts')?.label === '产物', '')
}

/* ── ② 校验：三种不通过各有各的话 ───────────────────────────────────── */

console.log('② 改之前先验能不能写')
{
  const empty = await checkDir('')
  check('★★ 空路径 → 拒绝', empty.ok === false && String(empty.error).includes('不能为空'), String(empty.error))

  const rel = await checkDir('relative/dir')
  check('★★ 相对路径 → 拒绝（进程工作目录会变，产物会散）',
    rel.ok === false && String(rel.error).includes('完整路径'), String(rel.error))

  /* 一个存在但写不进去的路径：Windows 上用一个「路径里有一段是文件」的方式造。 */
  const blocker = join(process.env.EWB_TEST_HOME, 'i-am-a-file')
  await writeFile(blocker, 'x', 'utf8')
  const nested = await checkDir(join(blocker, 'sub'))
  check('★★ 父级是文件 → 建不出目录，拒绝', nested.ok === false && String(nested.error).includes('建不出'),
    String(nested.error))

  /* 能写的：自动建出来。 */
  const okDir = join(process.env.EWB_TEST_HOME, 'new-disk', 'artifacts')
  const good = await checkDir(okDir)
  check('★★ 不存在的目录会自动建出来', good.ok === true, String(good.error))
  /* 「真写真删」的判据是下面这条：目录里除了我们建的那个不该留下任何东西。
   * 只写 `stat` 不看内容等于没验 —— 临时文件留在用户的盘上是很脏的。 */
  const left = await readFile(join(okDir, 'x'), 'utf8').catch(() => null)
  check('★★ 校验用的那个临时文件删干净了', left === null, String(left))
  const listing = await (await import('node:fs/promises')).readdir(okDir)
  check('★★ 目录里没有残留的 .ewb-write-test-* 文件',
    !listing.some(n => n.startsWith('.ewb-write-test-')), JSON.stringify(listing))
  void stat
}

/* ── ③ 改完真生效（热生效，不用重启） ───────────────────────────────── */

console.log('③ 改完真生效')
{
  const target = join(process.env.EWB_TEST_HOME, 'other-disk', 'art')
  const out = await saveStorageConfig({ artifacts: target })
  check('★★ 存成功', out.ok === true, JSON.stringify(out.ok ? out.config : out.error))
  check('★★ 存完立刻生效（不用重启）', artifactsDir() === target, artifactsDir())
  check('★★ 没改的那几格还是默认（不是全被清掉）',
    materialsDir() === join(dataRoot(), 'materials'), materialsDir())
  const sum = dirsSummary()
  check('★★ 摘要里 artifacts 标成「改过」，其余仍是默认',
    sum.find(d => d.key === 'artifacts')?.isDefault === false
    && sum.filter(d => d.isDefault).length === 4,
    JSON.stringify(sum.map(d => d.key + ':' + d.isDefault)))

  /* 真的写进新目录（不是只改了变量）。 */
  const { storeArtifact } = await import('../src/schedule/artifacts.ts')
  const meta = await storeArtifact({ data: Buffer.from('hello', 'utf8'), mime: 'text/plain' })
  const onDisk = await readFile(join(target, meta.id + '.bin')).catch(() => null)
  check('★★ 产物真写进新目录了（不是只改了变量）', onDisk !== null && onDisk.toString() === 'hello',
    onDisk === null ? '文件不存在' : onDisk.toString())

  /* 配置真的落盘了。 */
  const raw = JSON.parse(await readFile(join(dataRoot(), STORAGE_FILE), 'utf8'))
  check('★★ 配置落盘（重启后还在）', raw.artifacts === target, JSON.stringify(raw))
}

/* ── ④ 半套不生效（一格不过就整份不存） ─────────────────────────────── */

console.log('④ 有一格不过 → 整份不存（不许半套生效）')
{
  const before = artifactsDir()
  const badDir = join(process.env.EWB_TEST_HOME, 'i-am-a-file', 'nope')
  const out = await saveStorageConfig({ materials: join(process.env.EWB_TEST_HOME, 'ok-materials'), artifacts: badDir })
  check('★★ 有一格不可写 → 整份拒绝', out.ok === false, String(out.ok))
  check('★★ 并说清是哪一格（materials 那格写对了，错的是 artifacts）',
    out.key === 'artifacts' && String(out.error).includes('产物'), String(out.key) + ' / ' + String(out.error))
  check('★★ 那一格写对了也**没存**（整份不存）', artifactsDir() === before, artifactsDir())
  const mat = await readFile(join(dataRoot(), STORAGE_FILE), 'utf8').catch(() => '{}')
  check('★★ 磁盘上的配置没被改成半套', !String(mat).includes('ok-materials'), String(mat).slice(0, 80))
}

/* ── ⑤ 恢复默认 ───────────────────────────────────────────────────── */

console.log('⑤ 空串 = 恢复默认')
{
  const out = await saveStorageConfig({ artifacts: '' })
  check('★★ 给空串 → 回到数据根下的默认', out.ok === true, String(out.ok))
  check('★★ 生效的路径真的回默认了', artifactsDir() === join(dataRoot(), 'artifacts'), artifactsDir())
  const cfg = await readStorageConfig()
  check('★★ 配置里那一格被删掉（不是存了个空串）', cfg.artifacts === undefined, JSON.stringify(cfg))
}

/* ── ⑥ 启动时套用 ───────────────────────────────────────────────── */

console.log('⑥ 启动时能把磁盘上的配置套进来（重启后还在）')
{
  const target = join(process.env.EWB_TEST_HOME, 'restart-disk', 'mat')
  await saveStorageConfig({ materials: target })
  /* 模拟「重启」：先清掉内存里的覆盖，再从磁盘套一次。 */
  const { setDirOverrides } = await import('../src/schedule/artifacts.ts')
  setDirOverrides({})
  check('★ 清掉覆盖后回默认（确认这一步真清掉了）', materialsDir() !== target, materialsDir())
  await applyStorageConfig()
  check('★★ 从磁盘套回来就生效了（重启不用再配）', materialsDir() === target, materialsDir())
}

console.log('')
if (bad === 0) console.log('全部通过 ✓')
else { console.log('有 ' + String(bad) + ' 条不通过 ✗'); process.exitCode = 1 }
