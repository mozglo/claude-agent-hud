export type LogLine = { at: number; text: string }

export type AgentRow = {
  id: string
  goal: string
  type: string
  model: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'done' | 'failed'
  steps: number
  now: string
  log: LogLine[]
  answer?: string
  error?: string
}

export type PlanProgress = { done: number; total: number }

declare module 'claude-code' {
  interface PluginState {
    'agent-hud': {
      agents: AgentRow[]
      open: string[]
      plan: PlanProgress | null
      tick: number
    }
  }
}
