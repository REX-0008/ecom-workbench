/** 把 playwright 放进**部署目录里插件自己的 node_modules**。
 *
 * ## 为什么这样做是合理的（不是绕过 pnpm）
 *
 * 实测到的事实：
 *   - `profiles/desktop/pnpm-workspace.yaml` 里是 `nodeLinker: hoisted`
 *     → pnpm **复制**依赖而不是符号链接；
 *   - 我们的插件是 `file:` 依赖 → pnpm 把插件**复制**进
 *     `profiles/desktop/node_modules/@our/ecom-workbench/`；
 *   - 插件自己的依赖装在 `…/@our/ecom-workbench/node_modules/`
 *     （实测：`zustand` 就在那儿，是真目录）。
 *
 * 所以 **playwright 该去的位置就是那里** —— 本脚本只是提前做了
 * `pnpm install` 本来要做的事。
 *
 * ⚠️ **不会倒退**：`src/nodes/../package.json` 里已声明 `playwright` 依赖，
 * 将来任何一次 `pnpm install` 都会把它重新装到同一个位置。
 *
 * ## 为什么需要这么一手（而不是直接跑 pnpm install）
 *
 * `pnpm install` 会重写 `profiles/desktop/node_modules`，而那是**运行中的桌面端
 * 正在使用的目录**（红线：单写入者）。而要求用户退出桌面端 = 同时关掉了 AI 会话，
 * 变成「告诉不了我」的死循环。
 *
 * 本脚本只**新增**文件、不改动任何已有文件，所以可以在桌面端运行时做。
 *
 * 跑法：`node scripts/install-browser-deps.mjs`
 */
import { readdirSync, statSync, mkdirSync, cpSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\//, '').replace(/\/$/, '')
/* 部署根：优先用环境变量（脚本可从任意位置跑），退回「相对本仓库推算」。
 * 我们的源码在 <数据根>/my-dsh-plugins/ecom-workbench，所以上两级就是数据根。 */
const DSH_HOME = process.env.DSH_HOME ?? join(ROOT, '..', '..')
const PROFILE = process.env.DSH_PROFILE ?? 'desktop'
const DEPLOY = join(DSH_HOME, 'profiles', PROFILE, 'node_modules', '@our', 'ecom-workbench')
const DEST = join(DEPLOY, 'node_modules')

/** 要放过去的包（playwright 只依赖 playwright-core，后者无依赖）。 */
const PACKAGES = ['playwright', 'playwright-core']

if (!existsSync(DEPLOY)) {
  console.error('找不到部署目录：' + DEPLOY)
  console.error('（插件还没装到那个 profile？先按 AGENTS.md 的「装插件」走一遍）')
  process.exit(1)
}

console.log('部署目录：' + DEPLOY)
console.log('目标位置：' + DEST)
console.log('')

mkdirSync(DEST, { recursive: true })

let done = 0
for (const name of PACKAGES) {
  const from = join(ROOT, 'node_modules', name)
  const to = join(DEST, name)
  if (!existsSync(from)) {
    console.error('  源缺失：' + from + '（先在本仓库 npm install）')
    process.exit(1)
  }
  /* ⚠️ 先删目标再拷：cpSync 的覆盖语义在目录上不干净（旧文件会残留，
   * 造成「版本混杂」这种极难查的问题）。 */
  if (existsSync(to)) rmSync(to, { recursive: true, force: true })
  cpSync(from, to, { recursive: true })
  const mb = Math.round(listBytes(to) / 1024 / 1024 * 10) / 10
  console.log('  ✓ ' + name + ' → ' + mb + ' MB')
  done += 1
}

/* 写一个标记文件：让「这份依赖是手工放进去的」这件事可查。
 * 将来排查「为什么这里多了个包」时有据可依。 */
writeFileSync(join(DEST, '.ewb-manual-deps.json'), JSON.stringify({
  note: '由 ecom-workbench 的 scripts/install-browser-deps.mjs 放入。'
    + '与 pnpm install 的结果等价（package.json 已声明这些依赖）。',
  packages: PACKAGES,
  at: new Date().toISOString(),
}, null, 2), 'utf8')

console.log('')
console.log('完成 ' + done + ' 个包。')

/**
 * 数一个目录的字节数。
 * @param {string} dir - 目录。
 * @returns {number} 字节数。
 */
function listBytes(dir) {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) n += listBytes(p)
    else n += statSync(p).size
  }
  return n
}
