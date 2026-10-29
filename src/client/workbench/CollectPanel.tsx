/** 收藏板块（Skill / Github项目 / 设置 三个 tab）。
 *
 * ## 这个板块是干什么的
 *
 * **记录、备忘 + 决定要不要用**。用户 2026-10-11 原话：
 * 「记录一下有哪些好的 skill，放在这里考虑是否要启用。」
 *
 * ## 三个 tab（挂在外壳的板块上，面板内部不再分层）
 *
 * | tab | 内容 |
 * | --- | --- |
 * | **Skill** | 三列表格：名称 ｜ 备注 ｜ 描述，末列是**动作按钮** |
 * | **Github项目** | 纯手输清单：名称 ｜ 备注 ｜ 地址 |
 * | **设置** | 两侧 skill 目录的增删（**都可配多个**），并显示每个目录扫到几个 |
 *
 * ## 两条容易做错的语义（用户明确指出过）
 *
 * 1. **末列是按钮，不是状态标签**。它点了要切换，所以文字要写**能做什么**：
 *    - 已收藏的（parked，模型看不到）→ 按钮写 **「应用」**
 *    - 已安装的（模型能用）→ 按钮写 **「收藏」**
 *    写「现在是什么」是错的——用户原话：「那个不是标签，是按钮，按了之后是要切换的，
 *    所以显示的不应该是现在是什么，是能怎么操作」。
 * 2. **搬走 = 模型看不到**。所以按钮要带悬浮提示说清后果（用户要求「注意给他提醒，
 *    鼠标移动上去出现的」）。
 */
import { TagPickerSingle } from './TagPicker.tsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge, Dot, Label, SectionHead } from './terminal.tsx'

/** 一道契约：skill 的一条。 */
interface SkillRow {
  name: string
  title?: string
  description?: string
  where: 'installed' | 'collected'
  root: string
  /** agent（模型）能不能用它 —— 由 `disable-model-invocation` 决定。 */
  agentUsable: boolean
  /** 用户能不能用（`/名字` 触发）—— 由 `user-invocable` 决定。 */
  userUsable: boolean
}

/**
 * 状态灯的悬浮说明（用户要求有提醒）。
 *
 * 四种组合都照顾到：两个都不能用是**配置有问题**（写了两个排除），要单独说出来；
 * 其余按「agent 能不能用」为主。
 *
 * @param row - 那一行 skill。
 * @returns 给 title 属性用的说明。
 */
function statusTip(row: SkillRow): string {
  if (!row.agentUsable && !row.userUsable) {
    return row.name + '：agent 与用户均不可用（SKILL.md 同时设了 disable-model-invocation 与 user-invocable: false）'
  }
  if (!row.agentUsable) {
    return row.name + '：仅用户可用 —— 模型看不到它（SKILL.md 设了 disable-model-invocation: true），只能通过 /' + row.name + ' 调用'
  }
  if (!row.userUsable) {
    return row.name + '：仅 agent 可用（SKILL.md 设了 user-invocable: false），无法通过 /' + row.name + ' 调用'
  }
  return row.name + '：agent 可用，也可通过 /' + row.name + ' 调用'
}

/** 一侧根目录的明细（宿主半给）。 */
interface RootInfo {
  path: string
  count: number
  exists: boolean
  isDefault: boolean
}

/** 一条项目（与宿主半同形）。 */
interface ProjectRowData {
  name: string
  note?: string
  repo?: string
  /** 分类（用户要求）。界面按它分组显示，顺序见 CATEGORY_ORDER。 */
  category?: string
}

/** 备注表（与宿主半同形）。 */
interface Notes {
  roots?: { installed?: string[], collected?: string[] }
  skills: Record<string, { note?: string, repo?: string }>
  /** 插件备注：界面已不展示，字段保留（老数据不丢）。 */
  plugins: { name: string, note?: string, repo?: string }[]
  projects: ProjectRowData[]
}

/** 宿主半 /collect/list 的返回。 */
interface CollectList {
  skills: SkillRow[]
  notes: Notes
  roots: { installed: RootInfo[], collected: RootInfo[] }
}

/** 空白备注表（拉取失败时的兜底，避免界面崩）。 */
const EMPTY_NOTES: Notes = { skills: {}, plugins: [], projects: [] }

/** 调宿主半（统一错误处理：永不抛，返回 ok 与原因）。 */
async function api<T>(path: string, init?: RequestInit): Promise<{ ok: boolean, body?: T, error?: string }> {
  try {
    const res = await fetch('/api/ecom-workbench/collect/' + path, init)
    const body = await res.json() as T & { error?: string }
    if (!res.ok) return { ok: false, body, error: body.error ?? ('宿主半返回 ' + String(res.status)) }
    return { ok: true, body }
  } catch (e) {
    return { ok: false, error: '连不上宿主半：' + (e instanceof Error ? e.message : String(e)) }
  }
}

/* ── 三列表格的排版 ───────────────────────────────────────
 * 用户要求「展示应该展示3列，名称、备注、descriptio」。
 * 用 `grid` + 固定列宽而不是 `<table>`：单元格里放输入框时，table 的
 * 行高与边框行为更难伺候，而这里只需要「三列对齐」这一点。
 * 列宽：名称（固定，可截断）｜ 备注（自适应，最宽）｜ 描述（固定，可截断）。 */
/* ── 三列表格的排版 ───────────────────────────────────────
 * 用户要求「展示应该展示3列，名称、备注、description」，
 * 随后又指出：「当宽度不够的时候，描述也可以压缩，对多压缩剩下10个字节左右」。
 *
 * ⚠️ **踩过的坑（用户报「没有应用按钮」）**：第一版用固定列宽
 * （名称 200 + 备注 160 + 描述 300 + 按钮 96 ≈ 756px），而工作台右列常年不到这个宽度
 * → 整行**横向溢出到看不见的地方**，末列那个按钮就「凭空消失」了。
 *
 * 所以四列**必须都能压缩**：用 `minmax(0, …)` 而不是钉死的 px。
 * 里面的 `0` 是关键 —— grid 项的默认 `min-width:auto` 会让内容
 * （长描述、长路径）**撑住列宽、拒绝压缩**，那样照样会溢出。
 *
 * 压缩的优先次序（谁先让位）：
 *   名称（重要，先保）→ 备注（要能打字，留个够用的份额）→ 描述（**最先被压**，
 *   用户点名它可以压到「10 个字节左右」）→ 末列按钮**固定 84px 不压**
 *   （它是唯一的操作入口，压没了整行就没法用）。 */
const GRID = 'grid items-center gap-2'
/**
 * 表格列模板：名称 ｜ 备注 ｜ 描述 ｜ 按钮。
 *
 * 末列放**两个按钮**（打开目录 + 应用/收藏），所以给得宽一些；
 * 它仍然**固定不被压缩**（按钮压没了整行就没法用）。
 */
const ROW_COLS = 'minmax(0, 170px) minmax(0, 1.1fr) minmax(0, 0.9fr) 168px'

/** 表头（一列一个标题）。 */
function Head({ cols }: { cols: [string, string, string] }): React.JSX.Element {
  return (
    <div
      className={GRID + ' border-b border-[var(--dsw-alias-border-l2)] pb-1.5 pt-3'}
      style={{ gridTemplateColumns: ROW_COLS }}
    >
      {cols.map(t => (
        <span key={t} className="truncate font-mono text-ewb-caption uppercase tracking-[0.16em] text-[var(--dsw-alias-label-tertiary)]">{t}</span>
      ))}
      <span />
    </div>
  )
}

/** 表格末列的小按钮（统一一种外观）。
 *
 * 用户 2026-10-11 指出：「收藏和应用按钮应当是一个颜色，目前收藏字号和底色都不一样，统一」。
 * 之前按 `tone` 分成两种：「应用」有强调色底与描边、「收藏」是透明底 + 次要灰字，
 * 于是同一个位置的两个按钮看着像两种东西。现在**统一成同一种**：
 * 同样的底、同样的描边、同样的字色、同样的字号（`text-ewb-caption`）。
 * 「主操作」与「次操作」的区别交给**悬浮提示**去说（用户本来也要求有提示），不靠颜色。
 *
 * 「打开目录」也走这个组件 —— 三个按钮同款。 */
const ACT_BTN = [
  'pressable is-dark whitespace-nowrap rounded-ctl border',
  'border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)] text-[var(--ewb-accent)]',
  'px-2.5 py-1.5 font-mono text-ewb-caption leading-none disabled:opacity-45',
].join(' ')

/** 小按钮。 */
function ActBtn({ onClick, title, disabled, children }: {
  onClick: () => void
  title: string
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      /* `title` = 悬浮提示，用户明确要求「鼠标移动上去出现的」提醒。 */
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={ACT_BTN}
    >{children}</button>
  )
}

/**
 * 收藏板块。
 *
 * @param props.tab - 当前 tab（外壳传入）：`skill` / `github` / `settings`。
 * @returns 界面。
 */
export function CollectPanel({ tab }: { tab: 'skill' | 'github' | 'settings' }) {
  const [data, setData] = useState<CollectList | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  /** 提示条（保存 / 搬移的结果都从这里说出来，不静默）。 */
  const [msg, setMsg] = useState<{ tone: 'ok' | 'warn' | 'err', text: string } | null>(null)
  /** 备注改动后还没保存（决定「保存」按钮是否可用、是否提示）。 */
  const [dirty, setDirty] = useState(false)
  /**
   * 备注的**改动版本号**（每次改动 +1）。
   *
   * 用途：保存请求飞在路上时用户又改了字，响应回来不能把「新改动」误标成已保存
   * ——那会让那次改动永远存不下去（静默丢字）。比对版本号即可避免。
   */
  const revRef = useRef(0)
  /** 上次保存成功的时刻（显示在提示条里，让用户确信存进去了）。 */
  const [savedAt, setSavedAt] = useState('')

  /** 拉一次（列表 + 备注 + 根目录明细）。 */
  const refresh = useCallback((): void => {
    setState('loading')
    void api<CollectList>('list').then(r => {
      if (!r.ok || r.body === undefined) { setState('error'); setErr(r.error ?? '未知原因'); return }
      setData(r.body)
      setDirty(false)
      setState('ok')
    })
  }, [])

  useEffect(() => { refresh() }, [refresh])

  /** 保存整份备注。
   * @param next - 要写的备注表。
   */
  const saveNotes = useCallback((next: Notes): void => {
    /* ⚠️ 记下「发出这份时是第几版」。
     *
     * 为什么必须记：自动保存是防抖触发的，**请求飞在路上时用户可能又改了字**。
     * 若响应回来无条件 `setDirty(false)`，那次新改动就被误标成「已保存」，
     * 于是再也不会被存 —— 用户的字会静悄悄丢掉。
     * 所以只在「响应回来时版本没变」的情况下清 dirty。 */
    const sentRev = revRef.current
    setBusy(true)
    setMsg(null)
    void api('notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(next),
    }).then(r => {
      setBusy(false)
      if (!r.ok) { setMsg({ tone: 'err', text: '保存失败：' + (r.error ?? '未知原因') }); return }
      const stillCurrent = revRef.current === sentRev
      setData(d => (stillCurrent && d !== null ? { ...d, notes: next } : d))
      if (stillCurrent) setDirty(false)
      const t = new Date()
      const hh = String(t.getHours()).padStart(2, '0')
      const mm = String(t.getMinutes()).padStart(2, '0')
      setSavedAt(hh + ':' + mm)
      /* 自动保存时**不弹提示条**（否则每敲几个字就闪一条，很吵）；
       * 状态由顶部那行「已保存于 …」表达。手动点保存时才弹。 */
      if (!autoRef.current) setMsg({ tone: 'ok', text: '备注已保存（' + hh + ':' + mm + '）' })
    })
  }, [])

  /* ── 备注热更新（用户 2026-10-11 问「备注的写入是不是应该热更新」）──
   *
   * 结论：**应该**。理由：备注是边看边写的东西，让用户每改一处都去点「保存」
   * 是多余的仪式；漏点一次就白写。
   *
   * 做法：改动后**防抖 800ms** 自动存一份（不是每敲一个字就发请求）。
   * 800ms 是打完一个词/一句话的间隔；拖得太久用户会以为没生效。
   *
   * 为什么还要留「保存」按钮：① 它显示「有未保存的改动」，是**状态指示**；
   * ② 自动保存失败时用户能手动重试；③ 立刻想落盘时不用等那 800ms。
   *
   * `autoRef` 用来区分「自动」与「手动」——自动时不弹提示条，免得吵。 */
  const autoRef = useRef(false)
  useEffect(() => {
    if (!dirty || data === null) return
    const t = window.setTimeout(() => {
      autoRef.current = true
      saveNotes(data.notes)
      /* 复位放到下一轮，让 saveNotes 里读到的仍是 true。 */
      window.setTimeout(() => { autoRef.current = false }, 0)
    }, 800)
    return () => { window.clearTimeout(t) }
  }, [dirty, data, saveNotes])

  /** 在文件管理器里打开一个 skill 的目录（用户要求）。
   *
   * 客户端**只发 skill 名**，路径由宿主半解析 —— 见宿主半那条路由的注释：
   * 若接受客户端传路径，等于开了个「打开任意位置」的口子。 */
  const openDir = useCallback((name: string): void => {
    setMsg(null)
    void api<{ ok: boolean, path?: string, error?: string }>('open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then(r => {
      if (!r.ok || r.body?.ok !== true) {
        setMsg({ tone: 'err', text: r.body?.error ?? r.error ?? '无法打开目录' })
        return
      }
      /* 说清打开的是哪个路径 —— 用户可能配了多个根，得知道落在哪。 */
      setMsg({ tone: 'ok', text: '已打开目录：' + (r.body?.path ?? name) })
    })
  }, [])

  /** 搬移一个 skill（已安装 ⇄ 收藏）。 */
  const move = useCallback((name: string, to: 'installed' | 'collected'): void => {
    setBusy(true)
    setMsg(null)
    void api<{ ok: boolean, error?: string }>('move', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, to }),
    }).then(r => {
      setBusy(false)
      if (!r.ok || r.body?.ok !== true) {
        setMsg({ tone: 'err', text: r.body?.error ?? r.error ?? '搬移失败' })
        return
      }
      setMsg({
        tone: 'ok',
        text: to === 'collected'
          ? '已收藏：' + name + '（模型将看不到它；已备份，可随时点「应用」装回）'
          : '已应用：' + name + '（模型现在可以用它了；已备份）',
      })
      refresh()
    })
  }, [refresh])

  /** 改某条 skill 的备注（只改本地，等点保存）。 */
  const setSkillNote = useCallback((name: string, note: string): void => {
    setData(d => (d === null ? d : { ...d, notes: { ...d.notes, skills: { ...d.notes.skills, [name]: { ...d.notes.skills[name], note } } } }))
    setDirty(true)
    revRef.current += 1
  }, [])

  /** 改「Github 项目」清单里的一条。 */
  const setProject = useCallback((i: number, v: { name?: string, note?: string, repo?: string }): void => {
    setData(d => {
      if (d === null) return d
      const list = d.notes.projects.slice()
      list[i] = { ...list[i], ...v }
      return { ...d, notes: { ...d.notes, projects: list } }
    })
    setDirty(true)
    revRef.current += 1
  }, [])

  /** 加一条空项目 / 删一条。 */
  const addProject = useCallback((): void => {
    setData(d => (d === null ? d : { ...d, notes: { ...d.notes, projects: [...d.notes.projects, { name: '' }] } }))
    setDirty(true)
    revRef.current += 1
  }, [])
  const delProject = useCallback((i: number): void => {
    setData(d => (d === null ? d : { ...d, notes: { ...d.notes, projects: d.notes.projects.filter((_, j) => j !== i) } }))
    setDirty(true)
    revRef.current += 1
  }, [])

  /** 改目录配置（设置 tab）。 */
  const setRoots = useCallback((side: 'installed' | 'collected', paths: string[]): void => {
    setData(d => (d === null ? d : { ...d, notes: { ...d.notes, roots: { ...d.notes.roots, [side]: paths } } }))
    setDirty(true)
    revRef.current += 1
  }, [])

  const notes = data?.notes ?? EMPTY_NOTES
  const skills = data?.skills ?? []
  const collected = useMemo(() => skills.filter(s => s.where === 'collected'), [skills])
  const installed = useMemo(() => skills.filter(s => s.where === 'installed'), [skills])

  /** 保存按钮（备注有改动时才亮）。 */
  const saveBar = (
    <div className="mb-2 flex items-center gap-3 border-b border-[var(--dsw-alias-border-l2)] pb-2">
      <button
        type="button"
        disabled={!dirty || busy}
        title={dirty ? '把备注写入磁盘（保存后刷新页面仍然保留）' : '没有未保存的改动'}
        onClick={() => { saveNotes(notes) }}
        className={[
          'pressable is-dark rounded-ctl border px-3 py-1.5 font-mono text-ewb-caption disabled:opacity-45',
          dirty
            ? 'border-[var(--ewb-accent-line)] bg-[var(--ewb-accent-soft)] text-[var(--ewb-accent)]'
            : 'border-[var(--dsw-alias-border-l2)] text-[var(--dsw-alias-label-tertiary)]',
        ].join(' ')}
      >{busy ? '保存中…' : '保存'}</button>
      {/* 状态文字：有没有未保存的东西、上次存于几点 —— 用户说「不知道是否成功保存」。 */}
      <span className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
        {dirty ? '有未保存的改动' : savedAt === '' ? '已是最新' : '已保存于 ' + savedAt}
      </span>
      <span className="flex-1" />
      <button
        type="button"
        className="pressable is-dark px-2.5 py-1.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]"
        onClick={refresh}
      >刷新</button>
    </div>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-ewb-collect-panel={tab}>
      {msg !== null && (
        <div
          className={[
            'mb-2 rounded-ctl border px-3 py-2 font-mono text-ewb-caption',
            msg.tone === 'ok'
              ? 'border-[color-mix(in_oklab,var(--dsw-alias-state-success-primary)_35%,transparent)] text-[var(--dsw-alias-state-success-primary)]'
              : msg.tone === 'warn'
                ? 'border-[color-mix(in_oklab,var(--dsw-alias-state-warn-primary)_35%,transparent)] text-[var(--dsw-alias-state-warn-primary)]'
                : 'border-[color-mix(in_oklab,var(--dsw-alias-state-error-primary)_35%,transparent)] text-[var(--dsw-alias-state-error-primary)]',
          ].join(' ')}
        >{msg.text}</div>
      )}

      {state === 'loading' && <div className="p-6 text-center font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">加载中…</div>}
      {state === 'error' && (
        <div className="flex flex-col items-center gap-2 rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-10">
          <div className="font-mono text-ewb-meta text-[var(--dsw-alias-state-error-primary)]">无法读取收藏数据</div>
          <div className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">{err}</div>
          <button type="button" className="pressable is-dark rounded-ctl border border-[var(--dsw-alias-border-l2)] px-3 py-1.5 font-mono text-ewb-caption" onClick={refresh}>重试</button>
        </div>
      )}

      {/* ── Skill 三列表格 ─────────────────────────────── */}
      {state === 'ok' && tab === 'skill' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-ewb-collect-tab="skill">
          {saveBar}
          {collected.length > 0 && (
            <Fold label="已收藏" count={collected.length}>
              <Head cols={['名称', '备注', '描述']} />
              {collected.map(s => (
                <SkillLine
                  key={'c:' + s.name}
                  row={s}
                  note={notes.skills[s.name] ?? {}}
                  busy={busy}
                  onNote={v => { setSkillNote(s.name, v) }}
                  onOpenDir={() => { openDir(s.name) }}
                  /* 已收藏 → 按钮写「应用」（点了就装回，模型能用）。 */
                  actionLabel="应用"
                  actionTitle={'把 ' + s.name + ' 装回安装目录（$DSH_HOME/skills），模型就能用它了。搬移前会先备份。'}
                  onAction={() => { move(s.name, 'installed') }}
                />
              ))}
            </Fold>
          )}

          <div className="pb-4">
            <Fold label="已安装" count={installed.length}>
              {installed.length === 0
                ? <div data-ewb-collect-skill-empty="" className="rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-6 text-center font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">此目录未发现 skill</div>
                : (
                  <>
                    <Head cols={['名称', '备注', '描述']} />
                    {installed.map(s => (
                    <SkillLine
                      key={'i:' + s.name}
                      row={s}
                      note={notes.skills[s.name] ?? {}}
                      busy={busy}
                      onNote={v => { setSkillNote(s.name, v) }}
                  onOpenDir={() => { openDir(s.name) }}
                      /* 已安装 → 按钮写「收藏」（点了就移走，模型看不到）。 */
                      actionLabel="收藏"
                      actionTitle={'把 ' + s.name + ' 移到收藏目录：模型将看不到它（这就是「暂时不用」的含义）。搬移前会先备份，之后点「应用」可以装回。'}
                      onAction={() => { move(s.name, 'collected') }}
                    />
                  ))}
                </>
              )}
            </Fold>
          </div>
        </div>
      )}

      {/* ── Github 项目：按分类折叠 ─────────────────────── */}
      {state === 'ok' && tab === 'github' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-ewb-collect-tab="github">
          {saveBar}
          <div className="mb-1 flex items-center gap-2">
            <span className="font-mono text-ewb-label uppercase tracking-[0.2em] text-[var(--dsw-alias-label-tertiary)]">Github 项目</span>
            <span className="text-[var(--dsw-alias-label-secondary)]">{notes.projects.length}</span>
            <span className="h-px flex-1 bg-[var(--dsw-alias-border-l2)]" />
            <button
              type="button"
              className="pressable is-dark rounded-full border border-[var(--dsw-alias-border-l2)] px-3 py-1 font-mono text-ewb-caption text-[var(--ewb-accent)]"
              onClick={addProject}
            >+ 添加</button>
          </div>
          {notes.projects.length === 0
            ? <div data-ewb-collect-project-empty="" className="rounded-card border border-dashed border-[var(--dsw-alias-border-l2)] px-4 py-6 text-center font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">尚未记录项目</div>
            : (
              <>
                {groupedProjects(notes.projects).map(([cat, items]) => (
                  <Fold key={cat} label={cat} count={items.length}>
                    <div className="mb-2 flex flex-col gap-1.5">
                      {items.map(({ it, i }) => (
                        <ProjectRow
                          key={'p:' + String(i)}
                          it={it}
                          onSet={v => { setProject(i, v) }}
                      categoryOptions={projectCategoryOptions(notes.projects)}
                          onDelete={() => { delProject(i) }}
                        />
                      ))}
                    </div>
                  </Fold>
                ))}
              </>
            )}
        </div>
      )}

      {/* ── 设置：两侧目录都可配多个 ─────────────────────── */}
      {state === 'ok' && tab === 'settings' && (
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto" data-ewb-collect-tab="settings">
          {saveBar}
          {([['installed', '已安装目录', '模型会从这些目录加载 skill。默认目录不要删，否则模型将看不到任何 skill。'],
            ['collected', '收藏目录', '收藏的 skill 放在这里。这些目录不参与 dsh 加载，所以放这里的 skill 模型看不到。']] as const).map(([side, title, hint]) => {
            const infos = side === 'installed' ? (data?.roots.installed ?? []) : (data?.roots.collected ?? [])
            const configured = notes.roots?.[side] ?? []
            return (
              <section key={side} data-ewb-collect-roots={side}>
                <SectionHead
                  label={title}
                  count={infos.length}
                  right={(
                    <button
                      type="button"
                      className="pressable is-dark rounded-full border border-[var(--dsw-alias-border-l2)] px-3 py-1 font-mono text-ewb-caption text-[var(--ewb-accent)]"
                      /* 浏览器的目录选择器做不了「路径字符串」（安全限制），
                       * 所以这里是手填路径 + 当前值作默认，且**不替你猜**别的路径。 */
                      onClick={() => {
                        const v = window.prompt('要加哪个目录？（填绝对路径）\n\n' + title + '当前：\n' + infos.map(x => x.path).join('\n'), '')
                        if (v === null || v.trim() === '') return
                        /* 第一个自定义根出现时，把默认根也带上 —— 否则一配自定义根，
                         * 默认根就整个消失（sideRoots 的行为是「配了就不并用默认」）。 */
                        const base = configured.length > 0 ? configured : infos.map(x => x.path)
                        setRoots(side, [...base, v.trim()])
                      }}
                    >+ 添加目录</button>
                  )}
                />
                <div className="mb-2 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">{hint}</div>
                <div className="flex flex-col gap-2">
                  {infos.map((info, i) => (
                    <div
                      key={info.path}
                      className="flex items-center gap-3 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-3 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]" title={info.path}>{info.path}</span>
                      {/* 「扫到 0 个」与「目录不存在」分开说 —— 两种毛病，两种修法。 */}
                      {!info.exists
                        ? <Badge tone="err">目录不存在</Badge>
                        : info.count === 0
                          ? <Badge tone="warn">扫到 0 个</Badge>
                          : <Badge tone="ok">{info.count} 个</Badge>}
                      {info.isDefault && <Badge tone="accent">默认</Badge>}
                      <button
                        type="button"
                        className="shrink-0 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)] hover:text-[var(--dsw-alias-state-error-primary)]"
                        title={info.isDefault
                          ? '这是内置默认目录。删掉它会让这一侧只扫配置的目录'
                          : '从这一侧的目录列表移除（不删除磁盘上的文件）'}
                        onClick={() => {
                          const base = configured.length > 0 ? configured : infos.map(x => x.path)
                          setRoots(side, base.filter((_, j) => j !== i))
                        }}
                      >移除</button>
                    </div>
                  ))}
                </div>
                {configured.length > 0 && (
                  <button
                    type="button"
                    className="mt-2 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)] underline"
                    title="清除自定义目录，恢复为内置默认目录"
                    onClick={() => { setRoots(side, []) }}
                  >恢复默认目录</button>
                )}
              </section>
            )
          })}
          <div className="pb-2">
            <Label rule>配置存在哪</Label>
            <div className="mt-2 font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-tertiary)]">
              数据目录下的 <span className="text-[var(--dsw-alias-label-secondary)]">collect/notes.json</span>
              （与备注同一份文件，不另开配置）。改完点上面的「保存」才写盘。
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * 可折叠的分组（用户 2026-10-11 要求：「skill 的已收藏、github 项目的分类
 * 都应该是可以折叠的内容」）。
 *
 * 为什么用原生 `<details>`：它自带「展开/收起」语义与键盘可达性，
 * 不用自己管状态、不用自己写 aria —— 省一整套受控组件的代码。
 *
 * 默认**展开**（`open`）：折叠是为了「不碍事」，不是为了把内容藏起来；
 * 一进来全收起、还得逐组点开，反而多一步。
 *
 * @param props.label - 分组名。
 * @param props.count - 条目数（显示在名字后面）。
 * @param props.children - 组内内容。
 * @returns 可折叠分组。
 */
function Fold({ label, count, children }: {
  label: string
  count?: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <details open className="group">
      <summary className="flex cursor-pointer items-center gap-2 py-2 font-mono text-ewb-label uppercase tracking-[0.2em] text-[var(--dsw-alias-label-tertiary)] hover:text-[var(--dsw-alias-label-secondary)]">
        {/* 指示箭头：收起朝右、展开转下。用 `group-open` 变体，不写 JS 状态。 */}
        <span aria-hidden="true" className="inline-block transition-transform group-open:rotate-90">›</span>
        <span className="whitespace-nowrap">{label}</span>
        {count !== undefined && <span className="text-[var(--dsw-alias-label-secondary)]">{count}</span>}
        <span className="h-px flex-1 bg-[var(--dsw-alias-border-l2)]" />
      </summary>
      {children}
    </details>
  )
}

/** 分类的显示顺序（用户要求「分类不要太多」，固定 5 类）。
 *
 * 为什么把顺序写在代码里、分类值写在数据里：顺序是**界面决策**（先看哪个），
 * 换一下不该动用户的数据；而分类归属是**用户数据**，他自己会调。
 * 数据里出现这里没列的分类（用户手写的）→ 排在后面，不丢。 */
const CATEGORY_ORDER = ['Agent 与 Skill', '采集与搜索', '内容与设计', '实用工具', '学习参考']

/**
 * 把项目按分类分组（保持组内原有顺序）。
 * @param projects - 全部项目。
 * @returns [分类名, 该项目与它在原数组里的下标][]，按 CATEGORY_ORDER 排。
 */
/**
 * 分类的候选清单（用户 m00861：「输入就是新建或者筛选以后分类」）。
 *
 * 来源 = 固定 5 类 ∪ **当前所有项目里出现过的分类**（去重）。
 * ⚠️ 只给「已有 + 固定」，**不给「未分类」** —— 那是显示用的兜底名，
 * 让用户选它等于给一个不存在的分类赋值（会与「没分类」表现不同）。
 *
 * @param projects - 全部项目。
 * @returns 候选（固定 5 类在前，其余按字母序）。
 */
function projectCategoryOptions(projects: ProjectRowData[]): string[] {
  const used = projects
    .map(p => (p.category === undefined ? '' : p.category))
    .filter(c => c !== '' && c !== '未分类')
  return [...CATEGORY_ORDER, ...[...new Set(used)].filter(c => !CATEGORY_ORDER.includes(c)).sort()]
}

function groupedProjects(projects: ProjectRowData[]): [string, { it: ProjectRowData, i: number }[]][] {
  const map = new Map<string, { it: ProjectRowData, i: number }[]>()
  projects.forEach((it, i) => {
    /* 没分类的归到「未分类」，而不是丢掉 —— 用户自己加的条目可能没写。 */
    const cat = it.category === undefined || it.category === '' ? '未分类' : it.category
    const list = map.get(cat)
    if (list === undefined) map.set(cat, [{ it, i }])
    else list.push({ it, i })
  })
  const known = CATEGORY_ORDER.filter(c => map.has(c))
  const extra = [...map.keys()].filter(c => !CATEGORY_ORDER.includes(c) && c !== '未分类').sort()
  const rest = map.has('未分类') ? ['未分类'] : []
  return [...known, ...extra, ...rest].map(c => [c, map.get(c) ?? []] as [string, { it: ProjectRowData, i: number }[]])
}

/**
 * 一个项目（**可展开**）。
 *
 * 用户 2026-10-11：「我希望 skill 和 github 都可以展开，按钮的位置可以不移动，
 * 展开看更详细的内容。」
 * 所以列表态只显示「名称 ｜ 备注摘要 ｜ 地址 ↗」，展开后是**可编辑的三个字段**
 * —— 按钮（展开箭头、↗、删除）留在**同一位置**，展开只是往下长内容。
 *
 * @param props.it - 这一条的数据。
 * @param props.onSet - 改字段。
 * @param props.onDelete - 删掉这条。
 * @returns 一行。
 */
function ProjectRow({ it, onSet, onDelete, categoryOptions }: {
  it: ProjectRowData
  onSet: (v: { name?: string, note?: string, repo?: string, category?: string }) => void
  /** 分类的候选（已有分类 + 固定 5 类）。 */
  categoryOptions: readonly string[]
  onDelete: () => void
}): React.JSX.Element {
  const open = useExpanded(it)
  const hasRepo = it.repo !== undefined && it.repo !== ''
  return (
    <div className="overflow-hidden rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-base)]">
      {/* 列表态：三列 + 按钮。按钮位置固定，展开与否都不动。 */}
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          title={open.value ? '收起详情' : '展开：改名称、备注、地址'}
          aria-expanded={open.value}
          onClick={open.toggle}
          className="shrink-0 px-1 font-mono text-ewb-meta text-[var(--dsw-alias-label-tertiary)]"
        >
          <span aria-hidden="true" className="inline-block transition-transform" style={{ transform: open.value ? 'rotate(90deg)' : 'none' }}>›</span>
        </button>
        <span className="min-w-0 flex-1 truncate text-ewb-meta font-semibold text-[var(--dsw-alias-label-primary)]" title={it.name ?? ''}>
          {it.name === undefined || it.name === '' ? '（未命名）' : it.name}
        </span>
        <span className="min-w-0 flex-[2] truncate font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]" title={it.note ?? ''}>
          {it.note === undefined || it.note === '' ? '（还没写备注）' : it.note}
        </span>
        {hasRepo
          ? (
            <a
              className="shrink-0 font-mono text-ewb-caption text-[var(--ewb-accent)] underline"
              href={it.repo}
              target="_blank"
              rel="noreferrer"
              title={'在新标签页打开：' + String(it.repo)}
            >地址 ↗</a>
          )
          : <span className="shrink-0 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">无地址</span>}
        <button
          type="button"
          title="删掉这一条（会自动保存）"
          onClick={onDelete}
          className="shrink-0 font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)] hover:text-[var(--dsw-alias-state-error-primary)]"
        >删除</button>
      </div>
      {open.value && (
        <div className="flex flex-col gap-2 border-t border-[var(--dsw-alias-border-l2)] px-3 py-2.5">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">名称</span>
            <input
              type="text"
              className="rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1.5 text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none"
              value={it.name ?? ''}
              onChange={e => { onSet({ name: e.target.value }) }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">备注</span>
            <textarea
              className="min-h-[64px] w-full resize-y rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1.5 text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none"
              value={it.note ?? ''}
              onChange={e => { onSet({ note: e.target.value }) }}
            />
          </label>
          {/* ★ 分类（用户 m00861：「前端没有选择分类的按钮……做成可输入的选项栏」）。
           *
           * ⚠️ 数据层**早就有** category（见 collect/store.ts），界面也早按它分组 ——
           * 缺的只是这个编辑入口。所以这里只是补一个控件，不动数据结构、不动保存链路。
           *
           * ⚠️ 控件与「工作流类型」**共用一份**（用户 m00901 要求「公用一份」）——
           * 见 TagPicker.tsx 的说明。 */}
          <label className="flex flex-col gap-1">
            <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">分类</span>
            <TagPickerSingle
              id="ewb-proj-cat"
              value={it.category ?? ''}
              options={categoryOptions}
              onChange={v => { onSet({ category: v }) }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-ewb-caption uppercase tracking-[0.14em] text-[var(--dsw-alias-label-tertiary)]">地址</span>
            <input
              type="text"
              className="rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1.5 font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)] outline-none"
              placeholder="https://github.com/…"
              value={it.repo ?? ''}
              onChange={e => { onSet({ repo: e.target.value }) }}
            />
          </label>
        </div>
      )}
    </div>
  )
}

/**
 * 一行的展开状态（本地，用 React 状态）。
 *
 * 为什么不用 `<details>`：这里展开的是**同一行下面的内容**，而行本身是 flex 布局、
 * 按钮与文字都在同一层；用 details 会迫使把行内容也塞进 summary，
 * 而 summary 里放交互元素（链接、删除按钮）在部分浏览器上点击行为不一致。
 * 纯状态更可控。
 *
 * @param keySource - 用哪条数据判身份（仅用于注释说明，状态本身由调用处的 key 隔离）。
 * @returns 当前值与切换函数。
 */
function useExpanded(_keySource: unknown): { value: boolean, toggle: () => void } {
  const [value, setValue] = useState(false)
  return { value, toggle: () => { setValue(v => !v) } }
}

/**
 * 一行 skill（三列 + 动作按钮）。
 */
function SkillLine({ row, note, busy, onNote, onOpenDir, actionLabel, actionTitle, onAction }: {
  row: SkillRow
  note: { note?: string }
  busy: boolean
  onNote: (v: string) => void
  onOpenDir: () => void
  actionLabel: string
  actionTitle: string
  onAction: () => void
}): React.JSX.Element {
  const open = useExpanded(row.name)
  return (
    <div className="border-b border-[var(--dsw-alias-border-l2)]">
      {/* 主行：三列 + 按钮。**按钮位置固定**，展开只是往下长内容
       * （用户 2026-10-11：「按钮的位置可以不移动，展开看更详细的内容」）。 */}
      <div
        className={GRID + ' py-2'}
        style={{ gridTemplateColumns: ROW_COLS }}
      >
        {/* 名称列：展开箭头 + 状态灯 + 名字。
         *
         * 用户 2026-10-11 要求：「已安装的skill应当注明状态（agent可用，仅用户，
         * 用绿灯橙色的灯表示），绿色的表示agent可用」。
         * 依据是 SKILL.md 的 disable-model-invocation（见 store.ts 的说明）：
         *   绿 = agent 能用；橙 = 仅用户（要打斜杠加名字才能触发，模型看不到）。 */}
        <div className="flex min-w-0 items-start gap-1.5" title={statusTip(row)}>
          <button
            type="button"
            aria-expanded={open.value}
            title={open.value ? '收起详情' : '展开：看完整备注与描述'}
            onClick={open.toggle}
            className="mt-0.5 shrink-0 px-0.5 font-mono text-ewb-meta text-[var(--dsw-alias-label-tertiary)]"
          >
            <span aria-hidden="true" className="inline-block transition-transform" style={{ transform: open.value ? 'rotate(90deg)' : 'none' }}>›</span>
          </button>
          <span className="mt-1.5 shrink-0"><Dot state={row.agentUsable ? 'ok' : 'warn'} /></span>
          <span className="min-w-0">
            <span className="block truncate text-ewb-meta font-semibold text-[var(--dsw-alias-label-primary)]">{row.title ?? row.name}</span>
            {row.title !== undefined && row.title !== row.name && (
              <span className="block truncate font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">{row.name}</span>
            )}
          </span>
        </div>
        <input
          type="text"
          className="min-w-0 rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-2 py-1.5 text-ewb-meta text-[var(--dsw-alias-label-primary)] outline-none"
          placeholder="为什么收着它 / 什么时候用…"
          value={note.note ?? ''}
          onChange={e => { onNote(e.target.value) }}
        />
        {/* 描述列：来自 SKILL.md，只读（收起时截断，展开后看全文）。 */}
        <div className="min-w-0 truncate font-mono text-ewb-caption text-[var(--dsw-alias-label-secondary)]" title={row.description ?? ''}>
          {row.description ?? '（SKILL.md 未写描述）'}
        </div>
        {/* 按钮列：**打开目录 + 应用/收藏**（用户要求这两个按钮放一起）。 */}
        <div className="flex items-center justify-end gap-1.5">
          <ActBtn
            onClick={onOpenDir}
            title={'在文件管理器里打开 ' + row.name + ' 所在的目录'}
          >打开目录</ActBtn>
          <ActBtn onClick={onAction} title={actionTitle} disabled={busy}>{actionLabel}</ActBtn>
        </div>
      </div>
      {/* 展开区：完整描述 + 目录路径 +（收藏侧）SKILL.md 正文预览。 */}
      {open.value && (
        <div className="flex flex-col gap-2 px-3 pb-3 pt-1">
          <div className="flex flex-col gap-1">
            <Label>完整描述</Label>
            <div className="font-mono text-ewb-caption leading-relaxed text-[var(--dsw-alias-label-secondary)]">
              {row.description ?? '（SKILL.md 未写描述）'}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label>所在目录</Label>
            <div className="break-all font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">
              {row.root === '' ? '（未提供）' : row.root + '\\' + row.name}
            </div>
          </div>
          <SkillBody name={row.name} />
        </div>
      )}
    </div>
  )
}

/**
 * 一个 skill 的正文预览（**展开时才拉**，不再每次渲染都请求）。
 *
 * 为什么是独立组件：它自带「加载中 / 读不到」两个中间态，
 * 放在 SkillLine 里会让那一行臃肿；而且只有展开时才挂载，
 * 收起就卸载 —— 请求自然只在需要时发生。
 *
 * @param props.name - skill 名（宿主半按它去找 SKILL.md）。
 * @returns 正文预览块。
 */
function SkillBody({ name }: { name: string }): React.JSX.Element {
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    let cancelled = false
    void api<{ text?: string }>('skill?name=' + encodeURIComponent(name)).then(r => {
      if (cancelled) return
      if (!r.ok || r.body?.text === undefined) { setErr(r.error ?? '无法读取正文'); return }
      setText(r.body.text)
    })
    return () => { cancelled = true }
  }, [name])

  return (
    <div className="flex flex-col gap-1">
      <Label>SKILL.md</Label>
      {err !== '' && <div className="font-mono text-ewb-caption text-[var(--dsw-alias-state-error-primary)]">{err}</div>}
      {text === null && err === '' && <div className="font-mono text-ewb-caption text-[var(--dsw-alias-label-tertiary)]">读取中…</div>}
      {text !== null && (
        <pre className="max-h-[280px] overflow-auto whitespace-pre-wrap rounded-ctl border border-[var(--dsw-alias-border-l2)] bg-[var(--dsw-alias-bg-layer-1)] px-3 py-2 font-mono text-ewb-caption leading-[1.5] text-[var(--dsw-alias-label-secondary)]">{text}</pre>
      )}
    </div>
  )
}
