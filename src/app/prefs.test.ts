import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadPrefs, savePrefs, DEFAULT_PREFS,
  loadStats, recordRound, DEFAULT_STATS,
  seenHelp, markHelpSeen,
} from './prefs'

// node 环境无 localStorage：用内存 stub
const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
} as Storage

beforeEach(() => store.clear())

describe('prefs 偏好设置', () => {
  it('无存储时返回默认值', () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS)
  })

  it('save/load 往返', () => {
    savePrefs({ difficulty: 'hard', volume: 0.5, speed: 1.5, muted: true, quality: 'low' })
    expect(loadPrefs()).toEqual({ difficulty: 'hard', volume: 0.5, speed: 1.5, muted: true, quality: 'low' })
  })

  it('部分补丁合并已有设置', () => {
    savePrefs({ difficulty: 'easy' })
    savePrefs({ volume: 0.3 })
    const p = loadPrefs()
    expect(p.difficulty).toBe('easy')
    expect(p.volume).toBe(0.3)
    expect(p.speed).toBe(DEFAULT_PREFS.speed)
  })

  it('损坏 JSON 回退默认值', () => {
    store.set('guandan.prefs', '{not json!!')
    expect(loadPrefs()).toEqual(DEFAULT_PREFS)
  })
})

describe('stats 战绩统计', () => {
  it('无存储时返回默认值', () => {
    expect(loadStats()).toEqual(DEFAULT_STATS)
  })

  it('recordRound 累计单局与双下', () => {
    recordRound(true, false, false)
    recordRound(true, true, false) // 我方双下
    recordRound(false, true, false) // 对方双下：不计
    const s = loadStats()
    expect(s.rounds).toBe(3)
    expect(s.roundWins).toBe(2)
    expect(s.doubles).toBe(1)
    expect(s.matches).toBe(0)
  })

  it('matchEnd 记整场胜负', () => {
    recordRound(true, false, true)
    recordRound(false, false, true)
    const s = loadStats()
    expect(s.matches).toBe(2)
    expect(s.matchWins).toBe(1)
  })
})

describe('帮助标记', () => {
  it('首次未看过，标记后已看过', () => {
    expect(seenHelp()).toBe(false)
    markHelpSeen()
    expect(seenHelp()).toBe(true)
  })
})
