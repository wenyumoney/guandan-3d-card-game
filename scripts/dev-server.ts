// 开发服务器：同时启动 Vite dev server 和 WebSocket 游戏服务器。
// 用法：npx tsx scripts/dev-server.ts

import { spawn, type ChildProcess } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let vite: ChildProcess | null = null
let wsServer: ChildProcess | null = null

function startVite(): void {
  vite = spawn('npx', ['vite', '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  })
  vite.on('exit', (code) => {
    console.log(`[dev] Vite 退出 (code=${code})`)
    vite = null
  })
}

function startWs(): void {
  // 使用 tsx 直接运行 TypeScript 服务器
  wsServer = spawn('npx', ['tsx', 'server/index.ts'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  })
  wsServer.on('exit', (code) => {
    console.log(`[dev] WS 服务器退出 (code=${code})`)
    wsServer = null
  })
}

function cleanup(): void {
  console.log('\n[dev] 关闭所有服务...')
  if (vite) { vite.kill(); vite = null }
  if (wsServer) { wsServer.kill(); wsServer = null }
  process.exit(0)
}

process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
process.on('exit', cleanup)

console.log('🚀 启动开发环境...')
startWs()
setTimeout(startVite, 500) // 先等 WS 服务器启动
