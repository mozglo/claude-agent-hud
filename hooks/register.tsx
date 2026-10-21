import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentRow, PlanProgress } from '../types'

const agents = atom({ plugin: 'agent-hud', key: 'agents' } as const, [])
const open = atom({ plugin: 'agent-hud', key: 'open' } as const, [])
const plan = atom({ plugin: 'agent-hud', key: 'plan' } as const, null)
const tick = atom({ plugin: 'agent-hud', key: 'tick' } as const, 0)

const MAX_ROWS = 6
const LOG_LINES = 5
const KEEP_DONE_MS = 3 * 60_000

type Args = Record<string, unknown>
type Lang = 'en' | 'ru'

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const base = (p: unknown) => str(p).split('/').pop() || str(p)
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const host = (u: unknown) => str(u).replace(/^https?:\/\//, '').split('/')[0] ?? ''

const clockText = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const ruPlural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many
}

// All user-facing words, per language
const T = {
  en: {
    agents: 'Agents',
    running: (n: number) => `${n} running`,
    allDone: 'all finished',
    done: (n: number) => `${n} done`,
    failed: (n: number) => `${n} failed`,
    plan: 'plan',
    clear: 'clear finished',
    more: (n: number) => `and ${n} more`,
    steps: (n: number) => `${n} ${n === 1 ? 'step' : 'steps'}`,
    finished: 'done',
    crashed: 'failed',
    starting: 'starting',
    resumed: 'resumed',
    retrying: 'error, retrying',
    aborted: 'stopped',
    refusal: 'model refused',
    apiError: 'API error',
    act: {
      read: (f: string) => `reading ${f}`,
      edit: (f: string) => `editing ${f}`,
      write: (f: string) => `writing ${f}`,
      cmd: (c: string) => `running ${c}`,
      grep: (p: string) => `searching “${p}”`,
      glob: (p: string) => `finding files ${p}`,
      fetch: (h: string) => `reading ${h}`,
      search: (q: string) => `searching the web for “${q}”`,
      agent: (d: string) => `spawning agent: ${d}`,
      skill: (s: string) => `loading skill ${s}`,
      tools: 'loading tools',
      mcp: (t: string) => `using ${t}`,
    },
  },
  ru: {
    agents: 'Агенты',
    running: (n: number) => `работают ${n}`,
    allDone: 'все закончили',
    done: (n: number) => `готово ${n}`,
    failed: (n: number) => `упало ${n}`,
    plan: 'план',
    clear: 'убрать готовых',
    more: (n: number) => `и ещё ${n}`,
    steps: (n: number) => `${n} ${ruPlural(n, 'шаг', 'шага', 'шагов')}`,
    finished: 'готово',
    crashed: 'упал',
    starting: 'запускается',
    resumed: 'продолжает работу',
    retrying: 'ошибка, пробует дальше',
    aborted: 'остановлен',
    refusal: 'отказ модели',
    apiError: 'ошибка API',
    act: {
      read: (f: string) => `читает ${f}`,
      edit: (f: string) => `правит ${f}`,
      write: (f: string) => `пишет ${f}`,
      cmd: (c: string) => `команда: ${c}`,
      grep: (p: string) => `ищет «${p}»`,
      glob: (p: string) => `ищет файлы ${p}`,
      fetch: (h: string) => `читает сайт ${h}`,
      search: (q: string) => `гуглит «${q}»`,
      agent: (d: string) => `запускает агента: ${d}`,
      skill: (s: string) => `открывает скил ${s}`,
      tools: 'подгружает инструменты',
      mcp: (t: string) => `инструмент ${t}`,
    },
  },
}

let L = T.en

// What the agent is doing, in plain words
const describe = (tool: string, a: Args): string => {
  const w = L.act
  switch (tool) {
    case 'Read': return w.read(base(a.file_path))
    case 'Edit': return w.edit(base(a.file_path))
    case 'Write': return w.write(base(a.file_path))
    case 'NotebookEdit': return w.edit(base(a.notebook_path))
    case 'Bash': return str(a.description) ? cut(oneLine(str(a.description)), 50) : w.cmd(cut(oneLine(str(a.command)), 40))
    case 'Grep': return w.grep(cut(str(a.pattern), 30))
    case 'Glob': return w.glob(cut(str(a.pattern), 30))
    case 'WebFetch': return w.fetch(host(a.url))
    case 'WebSearch': return w.search(cut(str(a.query), 30))
    case 'Agent': return w.agent(cut(str(a.description), 30))
    case 'Skill': return w.skill(str(a.skill))
    case 'ToolSearch': return w.tools
    default:
      if (tool.startsWith('mcp__')) return w.mcp(tool.split('__').pop() ?? tool)
      return tool
  }
}

const modelName = (m: string) => {
  const low = m.toLowerCase()
  for (const n of ['opus', 'sonnet', 'haiku', 'fable']) if (low.includes(n)) return n
  return m
}

let ticker: Timer | undefined
let planItems: string[] = []

async function patch($: EngineInterface, id: string, fn: (r: AgentRow) => AgentRow) {
  await update($, agents, list => list.map(r => (r.id === id ? fn(r) : r)))
}

// One redraw per second while anything runs, none when idle
async function ensureTicker($: EngineInterface) {
  const list = await read($, agents)
  const running = list.some(r => r.status === 'running')
  if (running && !ticker) {
    ticker = $.clock.every(1000, () => void update($, tick, n => n + 1))
  } else if (!running && ticker) {
    ticker.cancel()
    ticker = undefined
    await update($, tick, n => n + 1)
  }
}

// The desktop app's task list (items / advance / done + start)
async function trackPlan($: EngineInterface, a: Args) {
  if (Array.isArray(a.items)) {
    planItems = (a.items as { status?: string }[]).map(i => i.status || 'pending')
  }
  if (a.advance === true) {
    const i = planItems.indexOf('in_progress')
    if (i >= 0) planItems[i] = 'completed'
    const j = planItems.indexOf('pending')
    if (j >= 0) planItems[j] = 'in_progress'
  }
  if (Array.isArray(a.done)) for (const n of a.done as number[]) if (planItems[n - 1]) planItems[n - 1] = 'completed'
  if (typeof a.start === 'number' && planItems[a.start - 1]) planItems[a.start - 1] = 'in_progress'
  const p: PlanProgress | null = planItems.length
    ? { done: planItems.filter(x => x === 'completed').length, total: planItems.length }
    : null
  await update($, plan, () => p)
}

export const register: Register = (on, options) => {
  const lang: Lang = options.language === 'ru' ? 'ru' : 'en'
  L = T[lang]

  on('session.start', async ($, e, next) => {
    await ensureTicker($)
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined || !r.agentId) return r
    const id = r.agentId
    const at = await $.clock.now()
    const resumed = e.resume !== undefined
    await update($, agents, list => {
      const old = list.find(x => x.id === id)
      if (old && resumed) {
        return list.map(x => (x.id === id ? { ...x, status: 'running' as const, endedAt: undefined, now: L.resumed, error: undefined } : x))
      }
      const row: AgentRow = {
        id,
        goal: oneLine(e.description || cut(oneLine(e.prompt), 60) || 'agent'),
        type: e.subagentType || 'agent',
        model: modelName(r.model || e.model || ''),
        startedAt: at,
        status: 'running',
        steps: 0,
        now: L.starting,
        log: [],
      }
      return [...list.filter(x => x.id !== id), row]
    })
    await ensureTicker($)
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const a = e as unknown as Args
    const id = e.agentId

    // Main loop: follow the plan (TodoWrite or the desktop task list)
    if (id === undefined) {
      if (e.tool === 'TodoWrite' && Array.isArray(a.todos)) {
        const todos = a.todos as { status?: string }[]
        await update($, plan, () => ({ done: todos.filter(t => t.status === 'completed').length, total: todos.length }))
      } else if (e.tool.endsWith('update_plan')) {
        await trackPlan($, a)
      }
      return next(e)
    }

    const known = (await read($, agents)).some(r => r.id === id)
    if (!known) return next(e)

    const text = describe(e.tool, a)
    const at = await $.clock.now()
    await patch($, id, r => ({
      ...r,
      steps: r.steps + 1,
      now: text,
      log: [...r.log, { at: at - r.startedAt, text }].slice(-LOG_LINES),
    }))

    const res = await next(e)
    if (res.deny === undefined && res.isError) {
      await patch($, id, r => ({ ...r, now: `${text}: ${L.retrying}` }))
    }
    return res
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id !== undefined && (await read($, agents)).some(r => r.id === id)) {
      const at = await $.clock.now()
      const failed = e.reason === 'error' || e.reason === 'refusal' || e.isAborted
      await patch($, id, r => ({
        ...r,
        endedAt: at,
        status: failed ? 'failed' : 'done',
        now: failed ? r.now : L.finished,
        answer: cut(oneLine(e.answer), 220),
        error: e.isAborted ? L.aborted : e.reason === 'refusal' ? L.refusal : e.reason === 'error' ? L.apiError : undefined,
      }))
      await ensureTicker($)
    }
    return next(e)
  })

  // New message: drop agents that finished a while ago
  on('prompt.submit', async ($, e, next) => {
    const at = await $.clock.now()
    await update($, agents, list => list.filter(r => r.status === 'running' || !r.endedAt || at - r.endedAt < KEEP_DONE_MS))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await read($, tick)
    const list = await read($, agents)
    if (e.props.hasSurvey || list.length === 0) return next(e)

    const opened = await read($, open)
    const p = await read($, plan)
    const at = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)

    const running = list.filter(r => r.status === 'running')
    const done = list.filter(r => r.status === 'done')
    const failed = list.filter(r => r.status === 'failed')
    const shown = [...running, ...failed, ...done.slice().reverse()].slice(0, MAX_ROWS)

    const head = [
      running.length ? L.running(running.length) : L.allDone,
      done.length ? L.done(done.length) : '',
      failed.length ? L.failed(failed.length) : '',
    ].filter(Boolean).join(' · ')

    const toggle = (id: string) => () => update($, open, ids => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]))
    const clear = () => update($, agents, l => l.filter(r => r.status === 'running'))

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Text size="caption" dimColor>{L.agents} · {head}</Text>
          <Box gap={2}>
            {p ? <Text size="caption" dimColor tabular>{L.plan} {p.done}/{p.total}</Text> : null}
            {running.length < list.length ? <Button key="clear" plain onPress={clear}><Text size="caption" dimColor>{L.clear}</Text></Button> : null}
          </Box>
        </Box>
        {shown.map(r => {
          const isOpen = opened.includes(r.id)
          const time = clockText((r.endedAt ?? at) - r.startedAt)
          const icon = r.status === 'running' ? '●' : r.status === 'done' ? '✓' : '!'
          const color = r.status === 'done' ? 'success' : r.status === 'failed' ? 'error' : 'claude'
          const sub =
            r.status === 'running'
              ? `${r.now} · ${L.steps(r.steps)}${r.model ? ` · ${r.model}` : ''}`
              : r.status === 'done'
                ? `${L.finished} · ${L.steps(r.steps)}`
                : `${L.crashed}: ${r.error ?? L.apiError}${r.now ? ` · ${r.now}` : ''}`
          return (
            <Box key={r.id} flexDirection="column" marginTop={1}>
              <Box justifyContent="space-between" gap={2}>
                <Button key={`row-${r.id}`} plain onPress={toggle(r.id)}>
                  <Text size="footnote" color={color}>{icon}  </Text>
                  <Text size="footnote" weight={r.status === 'running' ? 'medium' : 'regular'}>{cut(r.goal, 70)}</Text>
                  <Text size="footnote" dimColor>{isOpen ? '  ▾' : '  ▸'}</Text>
                </Button>
                <Text size="footnote" dimColor tabular>{time}</Text>
              </Box>
              <Text size="caption" dimColor color={r.status === 'failed' ? 'error' : undefined} wrap="truncate-end">     {sub}</Text>
              {isOpen && r.status !== 'done'
                ? r.log.map((l, i) => (
                    <Text key={`${r.id}-l${i}`} size="caption" dimColor mono wrap="truncate-end">     {clockText(l.at)}  {l.text}</Text>
                  ))
                : null}
              {isOpen && r.status === 'done' && r.answer ? <Text size="caption" dimColor wrap="wrap">     {r.answer}</Text> : null}
            </Box>
          )
        })}
        {list.length > shown.length ? <Text size="caption" dimColor>{L.more(list.length - shown.length)}</Text> : null}
      </Box>
    )
  })
}
