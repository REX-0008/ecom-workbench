/** BI 板块（宿主半）：启动 Docker 引擎 + 探端口。
 *
 * ## 为什么在宿主半
 *
 * 「起一个进程」与「探一个 TCP 端口」都只能在这里做 ——
 * 浏览器里既不能起进程、也连不了 `127.0.0.1:8088`（与浏览器检测同一条理由，
 * 见 `src/workflow/browser-detect-host.ts` 的文件头）。
 *
 * ## 事实（计划 §二「Superset」）
 *
 * - 地址 `http://127.0.0.1:8088/dashboard/list/`（旧工作台 `workbench-config.ts:12` 的默认值）；
 * - Docker 引擎起来之后，Superset 那四个容器（`superset_app` / `superset_db` /
 *   `superset_cache` / `superset_mcp`，compose 项目 `superset-deploy`）的重启策略是
 *   `unless-stopped`，**会自行恢复** —— 所以这里不需要 `docker compose up`；
 * - 当前 Docker 未运行 → 8088 无监听。
 *
 * ## ⚠️ 为什么不再只走那个 `.bat`（2026-10-23，契约 Z）
 *
 * 用户原话：「我指的是启动按钮执行的动作不对……我试了两次启动，都没有成功启动 docker。」
 *
 * 根因在脚本内部（**不是我们的 spawn 有问题**）：那个 bat 先判 `Docker Desktop.exe`
 * 进程在不在，**在**就跳到 `:docker_wait`，然后死循环等 `docker info` 成功 ——
 * 期间**永远不去启动引擎**。也就是说「Docker Desktop 窗口开着但引擎停了」这个
 * 恰恰最常见的状态，脚本会一直空转，什么都不做。用户干等 90 秒才看到「还没起来」。
 *
 * 所以首选改成 Docker 官方命令 `docker desktop start -d`（引擎已在跑时它返回
 * `Docker Desktop is already running`、退出码 0），脚本降级为**退路**。
 *
 * ## 探测用的是**现成的那一个**
 *
 * `probePort` 已经住在 `src/workflow/browser-detect-host.ts`（600 毫秒超时）。
 * 不在这里再写一份 TCP 探测 —— 「同一件事写两份迟早漂」（见 `pitfalls/`）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { probePort } from '../workflow/browser-detect-host.ts'

/**
 * Docker 官方命令行的默认路径（Docker Desktop 装在默认位置时）。
 *
 * ⚠️ 用完整路径而不是裸 `docker`：dsh 进程的 PATH 里不一定有 Docker 的 `bin` 目录，
 * 而裸 `docker` 在找不到时会抛 ENOENT，那条错误到用户眼里只是「起不来」。
 */
export const BI_DOCKER_EXE = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'

/**
 * 一键启动脚本的默认路径（计划里写死的那一个）。
 *
 * ## 为什么改成常量 + 环境变量覆盖
 *
 * 与 `EWB_TEST_NO_SPAWN` 同一个理由：让「这条路径不存在」那个失败分支能被测试
 * **真的走到**，而不是只靠人读代码相信。不设环境变量时行为与以前完全一样。
 */
export const BI_LAUNCHER = 'D:/ecom-data/一键启动.bat'

/**
 * 官方启动命令的参数。
 *
 * ## 为什么单独抽成常量（2026-10-23）
 *
 * 测试闸门 `EWB_TEST_NO_SPAWN=1` 会在**进到 spawn 之前**就返回，
 * 所以「真正传了哪几个参数」那一层在测试里**永远走不到** ——
 * 第一版自证就是这么失败的：把 `via` 在 docker 分支里写死成 `'bat'`，测试全绿。
 *
 * 抽成常量之后，「参数是不是 `desktop start -d`」可以被直接断言，
 * 不必靠「真的去起一个 Docker」来验（那会动用户的引擎，不许做）。
 */
export const BI_DOCKER_ARGS = ['desktop', 'start', '-d'] as const

/**
 * 走官方命令那条路时给用户看的文案（抽成常量，见下）。
 *
 * ## 为什么要单独抽出来
 *
 * 测试闸门 `EWB_TEST_NO_SPAWN=1` 在 `spawn` 之前就返回**另一句**文案，
 * 所以「官方命令这条路到底对用户说了什么」在测试里走不到 ——
 * 第一版把断言写在返回值上，直接红了（拿到的是闸门那句）。
 *
 * 抽成常量后，这句文案本身可以被直接断言，而且**只有一份**
 * （改了分支忘了改文案这种事就不再可能）。
 *
 * ## 措辞依据（别改回去）
 *
 * `docker desktop start -d` 是**异步**的，2026-10-23 在 Docker 全停状态下实测：
 * 发出命令 3 秒后查 `docker desktop status` 仍报「没在跑」，约 14 秒后引擎就绪，
 * 约 30 秒后 8088 才开始监听。所以这句只能承诺「请求已发出」，
 * 写「已就绪」会让用户点完看页面还是白的、以为按钮又坏了。
 */
export const BI_REASON_DOCKER_DESKTOP =
  '已请求启动 Docker Desktop（官方命令，异步执行）；引擎约 30 秒后可用，'
  + '之后 Superset 容器会自行恢复。这句只表示请求已发出，就绪与否看 BI 状态'

/** Superset 的地址（界面嵌它）。 */
export const BI_URL = 'http://127.0.0.1:8088/dashboard/list/'

/** 端口。 */
export const BI_PORT = 8088

/**
 * 这次启动走的是哪条路。
 *
 * - `docker-desktop` —— 官方命令 `docker desktop start -d`（首选）
 * - `bat` —— 退回到那个一键启动脚本
 * - `none` —— 两条都不通（此时必然 `ok: false`）
 */
export type BiVia = 'docker-desktop' | 'bat' | 'none'

/** `startBi()` 的返回（`src/index.ts` 那条路由原样发给界面）。 */
export interface BiStartResult {
  /** 有没有真的发起启动。 */
  ok: boolean
  /** 给人看的一句话（走哪条路、缺什么、怎么补）。 */
  reason: string
  /** 实际用到的那个可执行文件 / 脚本路径（都没找到时是首选那条的路径）。 */
  path: string
  /** 走的是哪条路 —— 界面据此说清「到底动了什么」。 */
  via: BiVia
}

/**
 * 读环境变量（空串当没设）。
 * @param name - 变量名。
 * @returns 值；没设或为空串时 `undefined`。
 */
function envPath(name: string): string | undefined {
  const v = process.env[name]
  if (v === undefined) return undefined
  const t = v.trim()
  return t === '' ? undefined : t
}

/**
 * 启动 Docker 引擎。
 *
 * ## 两段式（首选官方命令，退路是脚本）
 *
 * ① 找 `docker.exe`（`EWB_BI_DOCKER_EXE` 优先，否则 {@link BI_DOCKER_EXE}）→
 *    `docker desktop start -d`
 * ② 找不到 → 退回到那个 `.bat`
 * ③ 两样都找不到 → `ok: false`，文案把两条路各缺什么都写出来
 *
 * ## 为什么用 `node:child_process` 而不是 `ctx.subprocess`
 *
 * 与「打开目录」（`src/index.ts` 的 `openInFileManager`）同一个理由：
 * `ctx.subprocess` 是给**受管任务**用的（要全 stdio/graceMs、要能取消、会被记账），
 * 而这里只是**把引擎拉起来**：命令发起后自己的生命周期走完，我们不等它、也不看它。
 * 借用那套反而要多写规格、还会在任务列表里留一条永远不结束的记录。
 *
 * ⚠️ `detached: true` + `unref()`：父进程不等它。
 * `windowsHide: false` 只用在脚本那条（脚本要弹控制台，Docker 拉镜像要几分钟，
 * 不给窗口用户会以为「点了没反应」）；官方命令那条**不弹窗**，所以 `stdio: 'ignore'`。
 *
 * ## 环境变量在调用时读，不在模块加载时读
 *
 * 测试要能在同一个进程里换着路径跑三种分支（有/无 docker、有/无脚本）。
 * 加载时读死就做不到这件事。副作用是零：这两个变量只在这里读。
 *
 * @returns 起没起来、走的哪条路、原因。
 */
export function startBi(): BiStartResult {
  const dockerExe = envPath('EWB_BI_DOCKER_EXE') ?? BI_DOCKER_EXE
  const launcher = envPath('EWB_BI_LAUNCHER') ?? BI_LAUNCHER

  if (process.platform !== 'win32') {
    return {
      ok: false,
      reason: '只有 Windows 能这样拉起 Docker（当前 ' + process.platform + '）',
      path: dockerExe,
      via: 'none',
    }
  }

  const hasDocker = existsSync(dockerExe)
  const hasLauncher = existsSync(launcher)
  /* 先把「本来会走哪条」定下来 —— 闸门那条分支也要如实报它。 */
  const via: BiVia = hasDocker ? 'docker-desktop' : hasLauncher ? 'bat' : 'none'
  const path = via === 'bat' ? launcher : dockerExe

  /* 闸门：不真起进程（测试要它）。行为与以前一致，只是 `via` 照样给出来。 */
  if (process.env.EWB_TEST_NO_SPAWN === '1') {
    return {
      ok: via !== 'none',
      reason: via === 'none'
        ? '测试闸门 EWB_TEST_NO_SPAWN=1：没有真起进程；同时两条路都不存在 —— '
          + '找不到 docker 命令（' + dockerExe + '），也找不到启动脚本（' + launcher + '）'
        : '测试闸门 EWB_TEST_NO_SPAWN=1：没有真起进程（只验到路径与分支，本来会走 '
          + (via === 'docker-desktop' ? '官方命令' : '启动脚本') + '）',
      path,
      via,
    }
  }

  if (via === 'none') {
    /* 两条都缺 —— 这一条必须把「缺什么」说全，否则用户只知道「失败了」，
     * 不知道该装 Docker 还是该改脚本路径（契约 Z 要的就是这个）。 */
    return {
      ok: false,
      reason: '找不到 docker 命令（' + dockerExe + '），也找不到启动脚本（' + launcher + '）'
        + ' —— 装好 Docker Desktop，或用环境变量 EWB_BI_DOCKER_EXE / EWB_BI_LAUNCHER 指向实际位置',
      path,
      via,
    }
  }

  try {
    if (via === 'docker-desktop') {
      /* ## 为什么是 `desktop start -d` 而不是 `desktop start`
       *
       * `-d` / `--detach` 让命令交出控制权就返回，不等引擎完全就绪
       * （`docker desktop start --help` 里写着 `-d, --detach` 与 `--timeout`）。
       * 不等的原因：这里**本来就不该等** —— 引擎起来之后那四个容器会自行恢复，
       * 界面另有 `/bi/status` 去探 8088。若在这里同步等，一次点击要挂几十秒。
       *
       * ## ⚠️ 这条命令是**异步**的（2026-10-23 实测，别再当成同步）
       *
       * 停止状态下实测的完整时序：
       *
       *   21:50:20  `docker desktop start -d` → `✓ Starting Docker Desktop`，退出码 0，耗时 3.5 秒
       *   21:50:23  立刻查 `docker desktop status` → 仍报「没在跑」（正常，异步的）
       *   21:50:37  `docker info` 返回 29.2.1（引擎网络就绪，约 14 秒后）
       *   21:50:50  8088 开始监听
       *   21:50:55  `curl http://127.0.0.1:8088/dashboard/list/` → HTTP 200
       *
       * 所以本函数返回 `ok: true` 的含义**只能是「已发出启动请求」**，
       * 不能是「已就绪」。就绪与否由 `/bi/status` 探端口说了算。
       * 文案里也因此写「约 30 秒后可用」而不是「已就绪」。
       *
       * 官方命令自己的窗口由 Docker 管，我们**不弹控制台**（`windowsHide: true`）。 */
      const child = spawn(dockerExe, [...BI_DOCKER_ARGS], {
        detached: true, stdio: 'ignore', windowsHide: true,
      })
      /* 起不来就算了 —— 界面靠 `/bi/status` 探端口，探不到会如实说没起。
       * ⚠️ 这里**不能**因为异步的 `error` 事件把返回值改成失败：那个事件必然晚于返回。
       * ⚠️ 也没区分「spawn 成功但命令本身退非 0」与「压根没这个文件」——
       *   前者同样是 `ok: true`（确实发出去过），要分辨得等子进程退出，
       *   而我们已经 `unref()` 不等它了。这条边界如实写在注释里，不假装能分。 */
      child.on('error', () => { /* 见上面的注释 */ })
      child.unref()
      return {
        ok: true,
        reason: BI_REASON_DOCKER_DESKTOP,
        path,
        via,
      }
    }
    /* `.bat` 必须经 `cmd /c` —— `spawn` 直接起 `.bat` 在 Node ≥ 20 会被拒
     * （这是安装包漏洞 CVE-2024-27980 之后的既定行为）。 */
    const child = spawn('cmd.exe', ['/c', path], { detached: true, stdio: 'ignore', windowsHide: false })
    child.on('error', () => { /* 起不来就算了，用户能看到窗口有没有出现 */ })
    child.unref()
    return {
      ok: true,
      reason: '已请求启动（走一键启动脚本，将弹出窗口；Docker 启动约需 30-60 秒）',
      path,
      via,
    }
  } catch (e) {
    return {
      ok: false,
      reason: '起不来：' + (e instanceof Error ? e.message : String(e)),
      path,
      via,
    }
  }
}

/**
 * 探 BI 起没起（8088 有没有在听）。
 *
 * ⚠️ 「端口在听」只说明**有程序占着它**，不说明那是 Superset ——
 * 真要确认得打开页面看。这一条与 `/browser/cdp` 那条路由的三态回复同一个道理。
 *
 * @returns 状态。
 */
export async function biStatus(): Promise<{ listening: boolean, port: number, url: string }> {
  return { listening: await probePort(BI_PORT), port: BI_PORT, url: BI_URL }
}
