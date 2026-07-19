// ── 本地持久化：偏好设置 + 战绩统计（localStorage；不可用/损坏时静默回退默认值）──

import { type Difficulty } from '../ai/ai'
import { type Quality } from '../render/Renderer'

export interface Prefs {
  difficulty: Difficulty
  quality?: Quality // 缺省跟随 Renderer 自身默认
  muted: boolean
  volume: number // 0~1
  speed: number // 动画/节奏速度倍率（0.7 慢 / 1 正常 / 1.5 快）
}

export interface Stats {
  matches: number // 完整场数（打过 A）
  matchWins: number // 我方整场胜数
  rounds: number // 单局数
  roundWins: number // 我方单局胜数
  doubles: number // 我方打出双下次数
}

const PREFS_KEY = 'guandan.prefs'
const STATS_KEY = 'guandan.stats'
const HELP_KEY = 'guandan.seenHelp'

export const DEFAULT_PREFS: Prefs = { difficulty: 'normal', muted: false, volume: 1, speed: 1 }
export const DEFAULT_STATS: Stats = { matches: 0, matchWins: 0, rounds: 0, roundWins: 0, doubles: 0 }

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null // 隐私模式等场景访问即抛
  }
}

function load<T extends object>(key: string, fallback: T): T {
  try {
    const raw = storage()?.getItem(key)
    if (!raw) return { ...fallback }
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) }
  } catch {
    return { ...fallback }
  }
}

function save(key: string, value: unknown): void {
  try {
    storage()?.setItem(key, JSON.stringify(value))
  } catch {
    /* 写失败不影响游戏 */
  }
}

export function loadPrefs(): Prefs {
  return load(PREFS_KEY, DEFAULT_PREFS)
}

export function savePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...loadPrefs(), ...patch }
  save(PREFS_KEY, next)
  return next
}

export function loadStats(): Stats {
  return load(STATS_KEY, DEFAULT_STATS)
}

/** 单局结束记账。won=我方赢本局；isDouble=胜方双下；matchEnd=本局同时终结整场（过A）。 */
export function recordRound(won: boolean, isDouble: boolean, matchEnd: boolean): Stats {
  const s = loadStats()
  s.rounds++
  if (won) s.roundWins++
  if (won && isDouble) s.doubles++
  if (matchEnd) {
    s.matches++
    if (won) s.matchWins++
  }
  save(STATS_KEY, s)
  return s
}

/** 是否看过玩法说明（首次进游戏自动弹出一次）。 */
export function seenHelp(): boolean {
  try {
    return storage()?.getItem(HELP_KEY) === '1'
  } catch {
    return true // 读不到就当看过，避免反复打扰
  }
}

export function markHelpSeen(): void {
  try {
    storage()?.setItem(HELP_KEY, '1')
  } catch {
    /* 忽略 */
  }
}
