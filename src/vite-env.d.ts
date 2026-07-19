/// <reference types="vite/client" />

declare global {
  interface Window {
    __THREE_GAME_DIAGNOSTICS__?: () => object
    __FX_TEST__?: (kind: 'bomb' | 'wild', tier?: number) => void
    __PAUSE__?: (p: boolean) => void
    __READY__?: boolean
    __THREE_GAME_TEST_HOOKS__?: {
      seed(value: number): void
      setState(name: string): void
      setPausedForScreenshot(paused: boolean): void
    }
  }
}

export {}
