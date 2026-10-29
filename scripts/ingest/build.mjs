/** 生成「清洗入库」工作流（**一份工作流** —— 一串固定步骤）。
 *
 * ## 对应原脚本
 *
 * `清洗入库.bat` = `node src/ingest.ts` + `node src/sync_superset.ts`。
 *
 * ## 骨架
 *
 * ```
 * ① 读 manifest (sys.fs.read)
 * ② 写 config.json (code.js：把路径与 manifest 拼成配置文件)
 * ③ 列文件          (code.shell：node <脚本> <workDir>)
 * ④ 读 Excel + 清洗 (code.shell)
 * ⑤ 写库            (code.shell)
 * ⑥ 汇总（code.js：把 summary.json 读成面板要的形状）
 * ```
 *
 * ## ⚠️ 交接方式：**一个固定工作目录 + 中间文件**
 *
 * 三条都在 `scripts/ingest/shell-steps.mjs` 的文件头里写清了，这里只放结论：
 *   ① 数据**不能**走命令行（`code.shell` 经 `cmd /c` 跑，引号会被吃、还有长度上限）
 *   ② 也**不能**靠「上游输出」串（引擎只给**直接上游**，而第 3 步需要第 1 步的 manifest；
 *      硬串就得把几千行 Excel 在引擎里来回搬）
 *   ③ 所以照 `.bat` 的老办法：**一个固定工作目录，数据全落盘**，命令行只带那个路径
 *
 * 这意味着：**shell 脚本本身要先落盘**（生成器写进 `$DSH_HOME/tmp/`），
 * 命令行只写 `node <脚本路径> <workDir>`。
 *
 * @param Builder - 生成器的 Builder 类。
 * @param opts - 见下（都来自调用方，路径写死由调用方决定）。
 * @returns 存档对象。
 */
/**
 * 造一条 `code.shell` 命令。
 *
 * ## ⚠️ **不能加引号**（实测踩到，2026-10-14）
 *
 * `code.shell` 经 **`cmd /c`** 跑。而 `cmd /c` 有一条古怪规则：
 * **命令行以引号开头时，它会把第一个引号剥掉再处理** ——
 * 于是 `node "X" "Y"` 里的引号从第三个开始错位，
 * 实测报错 `Cannot find module '...\tmp\ewb-ingest\"...\step-list.mjs"'`
 * （路径被拼成了一个不存在的怪路径）。
 *
 * 对照实测（同一脚本、同一个 cmd /c）：
 *   - `node "A" "B"` → **失败**（剥引号）
 *   - `node A B`     → **成功**
 *   - `node "A" B`   → **失败**（同样从第一个引号起）
 *
 * 所以：**命令里一个引号都不用**。
 * 代价是路径不能含空格 —— 所以 `shellDir` 选在 `$DSH_HOME/tmp/` 下
 * （本项目的路径约定里它是干净的）；若将来真出现空格路径，
 * 得改用 `cmd /c ""node" "A" "B""` 那种双层引号写法（更绕，现在不需要）。
 *
 * @param scriptPath - 要跑的脚本。
 * @param arg - 唯一参数（工作目录）。
 * @returns 命令行。
 */
function shellCmd(scriptPath, arg) {
  return 'node ' + scriptPath + ' ' + arg
}

/** 反斜杠路径转成正斜杠（`cmd` 与 `node` 都认，且不涉及转义）。 */
const fwd = (p) => String(p).replace(/\\/g, '/')

/** 一个节点的工作目录（shell 步骤之间靠它交接）。 */
export function buildIngest(Builder, opts) {
  const {
    manifestPath, dataRoot, dbPath, projectDir, shellDir, cleanLibPath, syncScript,
  } = opts

  /* ⚠️ 第二个参数是**名字前缀**：巡查那三份用 '巡查-'，这一份不是巡查 → 空前缀。 */
  const b = new Builder('清洗入库', '')
  const Y = 120
  const STEP = 360
  const X = 40
  /** 工作目录（shell 步骤之间靠它交接）。 */
  const workDir = shellDir

  /* ⓪ 开始 —— 入口标记，**不声明输入**。
   *
   * 清洗要读哪个 manifest、数据根在哪、库在哪，全都写在下游节点参数里（这份工作流的设计
   * 就是「路径在节点参数里写死、换机器改这一处」），没有需要外部喂的值 ——
   * 清洗入库.bat 也没有任何命令行参数。所以只放一个空的入口标记。
   *
   * ⚠️ 用固定 id start（不走自增）：后加的节点不该让 n1..n6 改名。 */
  const start = b.add('flow.start', { type: 'manual', fields: [] },
    '⓪ 开始', X - 340, Y, 'stop',
    '入口标记：这份工作流不接受外部输入 —— 扫哪个目录、写哪个库，都由下游节点参数决定。',
    'start')

  /* ① 读 manifest —— 碰外部世界 → sys.fs.read。 */
  const readManifest = b.add('sys.fs.read', { path: manifestPath, encoding: 'utf8' },
    '① 读 manifest.json', X, Y, 'stop',
    'manifest 是纯数据（17 张表的规则）。改清洗规则只改这个文件，不用动工作流。')

  /* ② 写 config.json —— 纯数据变换 → code.js。
   *
   * ⚠️ 为什么要有这一步：shell 步骤需要知道「数据根在哪、库在哪、manifest 是什么」，
   * 而这些**都只能在节点参数里写死或从上游拿**。manifest 是从上游来的，
   * 路径是我在生成时写死的 —— 所以在这里把它们拼成一个文件落盘。
   * 这样三条 shell 命令**都只带一个 workDir 参数**（命令行干净得像 `.bat`）。 */
  const writeConfig = b.add('code.js', {
    code: `/* 上游 = ① 读出来的 manifest 文本。把它与路径拼成 config.json 的内容。
 * ⚠️ manifest 的 data_root / db_path 是**相对 manifest 自己所在目录**的
 *（见它自己的 path_convention 字段），所以这里直接用生成时算好的绝对路径，
 * 不去解析它 —— 免得又多一处「相对谁」的歧义。 */
const text = typeof input === 'string' ? input : ''
if (text.trim() === '') throw new Error('manifest 是空的（① 读文件那步失败？）')
let manifest
try { manifest = JSON.parse(text) } catch (e) {
  throw new Error('manifest 不是合法 JSON：' + String(e && e.message ? e.message : e))
}
if (!Array.isArray(manifest.tables)) throw new Error('manifest 里没有 tables 数组（形状不对）')

return {
  dataRoot: ${JSON.stringify(dataRoot)},
  dbPath: ${JSON.stringify(dbPath)},
  projectDir: ${JSON.stringify(projectDir)},
  cleanLibPath: ${JSON.stringify(cleanLibPath)},
  manifest,
  /* ③ 列文件那步要的表清单（只要 id 与 folder —— 别的它不需要）。 */
  tables: manifest.tables.map((t) => ({ id: t.id, folder: t.folder })),
  tableCount: manifest.tables.length,
}
`,
    timeout: 30000,
  }, '② 拼配置内容', X + STEP, Y, 'stop',
    '把 manifest 与各项路径拼成配置对象。只算不写 —— 写文件归下一步（判据：碰外部世界的用专用节点）。')

  b.link(start, readManifest)
  b.link(readManifest, writeConfig)

  /* ②b 写 config.json —— 碰外部世界 → sys.fs.write。 */
  const saveConfig = b.add('sys.fs.write', {
    path: workDir + '/config.json',
    mode: 'overwrite',
    mkdir: true,
  }, '②b 写 config.json', X + STEP * 2, Y, 'stop',
    '把上一步算出来的配置写成文件。后续三个 shell 步骤都读它（各自只收一个工作目录参数）。')

  b.link(writeConfig, saveConfig)

  /* ③ 列文件 —— 碰外部世界 → code.shell。 */
  const listStep = b.add('code.shell', {
    command: shellCmd(fwd(shellDir) + '/step-list.mjs', fwd(workDir)),
    cwd: workDir,
    shell: 'cmd',
    timeout: 120000,
  }, '③ 列文件（扫每个文件夹）', X + STEP * 3, Y, 'stop',
    '按 manifest 逐文件夹列 xlsx（排除 ~$ 锁文件，按名字排序=旧到新）。')

  b.link(writeConfig, listStep)

  /* ④ 读 Excel + 清洗 —— 碰外部世界（依赖在项目目录）→ code.shell。 */
  const readStep = b.add('code.shell', {
    command: shellCmd(fwd(shellDir) + '/step-read-clean.mjs', fwd(workDir)),
    cwd: workDir,
    shell: 'cmd',
    timeout: 1800000,
  }, '④ 读 Excel + 清洗', X + STEP * 4, Y, 'stop',
    '读 xlsx（exceljs 从项目目录 import）+ 就地清洗。普通加载、不用 read_only（read_only 会漏数）。')

  b.link(listStep, readStep)

  /* ⑤ 写库 —— 碰外部世界 → code.shell。
   *
   * ⚠️ 30 分钟超时：清洗几万行 + 建视图与实体表可能很慢，超时会白跑一半。 */
  const writeStep = b.add('code.shell', {
    command: shellCmd(fwd(shellDir) + '/step-write-db.mjs', fwd(workDir)),
    cwd: workDir,
    shell: 'cmd',
    timeout: 1800000,
  }, '⑤ 写库（建表/UPSERT/视图/实体表）', X + STEP * 5, Y, 'stop',
    '写 SQLite：补缺失列（不重建，保历史）+ UPSERT（同主键后者覆盖）+ 重建视图与实体表。')

  b.link(readStep, writeStep)

  /* ⑥ 结束 —— **2026-10-25 去掉**。
   *
   * 原来这里是一个 `flow.end`，声明「写库结果 = ⑤」（⑤ 是 step-write-db.mjs 的
   * stdout 摘要，纯文本）。用户 2026-10-25 决定**存档里不再有结束节点**，
   * 所以节点与那条边都不建了，⑤ 写库 就是这条链的尾。
   *
   * ⚠️ 节点定义（`src/nodes/flow/end/node.ts`）原样保留在节点库里。
   *
   * 代价说清楚：这份工作流不再有对外声明的产出。想看落库摘要，读 ⑤ 那步
   * 在运行记录里打出的 stdout；要一个结构化的汇总，得另外加一个汇总节点
   * —— 那是下次的事，本次只做「去掉结束节点」。 */

  /* ★ 说明（用户 2026-10-14 要求显示在列表里）。 */
  const doc = b.doc()
  doc.description = '读 manifest 扫各文件夹的 xlsx → 清洗 → 写进 SQLite（补列、UPSERT、建视图与实体表）'
  return doc
}

/**
 * 把三个 shell 脚本与清洗库**写进工作目录**（生成工作流的一部分）。
 *
 * ⚠️ 必须落盘：`code.shell` 的命令行里塞不进几百行脚本（引号会被 `cmd /c` 吃）。
 * 写进一个**固定目录**，工作流里的命令就只带这个路径。
 *
 * @param dir - 目标目录。
 * @param steps - `{ SHELL_LIST, SHELL_READ_CLEAN, SHELL_WRITE_DB }`。
 * @param cleanLib - 清洗库的源码（会被复制成 `clean-lib.mjs`）。
 * @param fs - `{ mkdirSync, writeFileSync }`（由调用方传，便于测试）。
 */
export function writeShellScripts(dir, steps, cleanLibSource, fs) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(dir + '/step-list.mjs', steps.STEP_LIST, 'utf8')
  fs.writeFileSync(dir + '/step-read-clean.mjs', steps.STEP_READ_CLEAN, 'utf8')
  fs.writeFileSync(dir + '/step-write-db.mjs', steps.STEP_WRITE_DB, 'utf8')
  /* 清洗库要**与两个 step 脚本同目录**吗？不必 —— 它的路径由 config 给。
   * 但放一起最省事（少一处要对的路径）。 */
  fs.writeFileSync(dir + '/clean-lib.mjs', cleanLibSource, 'utf8')
  return {
    list: dir + '/step-list.mjs',
    read: dir + '/step-read-clean.mjs',
    write: dir + '/step-write-db.mjs',
    lib: dir + '/clean-lib.mjs',
  }
}
