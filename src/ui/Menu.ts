import { type Difficulty } from '../ai/ai'
import { type Stats, seenHelp, markHelpSeen } from '../app/prefs'

/**
 * 开局菜单（国风覆盖层）：难度选择 + 开始 + 玩法说明 + 战绩摘要。
 * 首次进游戏自动弹出玩法说明一次（localStorage 标记）。
 */
export interface MenuOpts {
  stats: Stats
  initialDifficulty: Difficulty
  onStart(d: Difficulty): void
  onOnline?: () => void
}

const HELP_HTML = `
  <h2>玩法说明</h2>
  <h3>操作</h3>
  <ul>
    <li><b>选牌</b>：点击单张 · 拖动划选多张 · 双击选同点数全部</li>
    <li><b>理牌</b>：循环切换排列（点数 → 同花顺优先）</li>
    <li><b>提示</b>：连点循环给出可出的每一手（弱→强）</li>
    <li>跟牌时无牌可压会<b>自动过</b>；快捷键 Enter 出牌 / 空格 过 / H 提示</li>
  </ul>
  <h3>规则速查</h3>
  <ul>
    <li><b>牌型</b>：单张 · 对子 · 三带二 · 顺子(5张) · 木板(三连对) · 钢板(二连三) · 炸弹(4+张同点) · 同花顺 · 天王炸</li>
    <li><b>级牌</b>：当前打的等级牌仅次于王；<b>红桃级牌</b>是逢人配（万能牌）</li>
    <li><b>进贡</b>：上局末游给头游进最大牌，头游还一张 ≤10 的牌；双下则双贡；有两张大王可抗贡</li>
    <li><b>升级</b>：双下 +3 级 · 一二三 +2 级 · 一三四 +1 级；打过 A 赢整场</li>
  </ul>`

export function createMenu(root: HTMLElement, opts: MenuOpts): void {
  const el = document.createElement('div')
  el.id = 'menu'
  const { stats } = opts
  const statLine = stats.rounds === 0
    ? '暂无战绩'
    : `战绩 ${stats.matches} 场 ${stats.matchWins} 胜 · 单局 ${stats.roundWins}/${stats.rounds}` +
      (stats.doubles > 0 ? ` · 双下 ${stats.doubles} 次` : '')
  el.innerHTML = `
    <div class="menu-card">
      <h1 class="menu-title">掼蛋</h1>
      <p class="menu-sub">国风 · 二打二 · 过 A 为胜</p>
      <div class="menu-diff">
        <button data-d="easy">简单</button>
        <button data-d="normal">普通</button>
        <button data-d="hard">困难</button>
      </div>
      <button class="menu-start">开始游戏</button>
      <button class="menu-online">联机对战</button>
      <button class="menu-help-btn">玩法说明</button>
      <p class="menu-stats">${statLine}</p>
    </div>
    <div class="menu-help">
      <div class="menu-help-card">${HELP_HTML}<button class="menu-help-close">知道了</button></div>
    </div>`
  root.appendChild(el)

  let difficulty = opts.initialDifficulty
  const diffBtns = [...el.querySelectorAll<HTMLButtonElement>('.menu-diff button')]
  const applyDiff = (): void =>
    diffBtns.forEach((b) => b.classList.toggle('active', b.dataset.d === difficulty))
  diffBtns.forEach((b) => b.addEventListener('click', () => {
    difficulty = b.dataset.d as Difficulty
    applyDiff()
  }))
  applyDiff()

  const helpEl = el.querySelector('.menu-help') as HTMLDivElement
  const openHelp = (): void => helpEl.classList.add('show')
  el.querySelector('.menu-help-btn')!.addEventListener('click', openHelp)
  el.querySelector('.menu-help-close')!.addEventListener('click', () => {
    helpEl.classList.remove('show')
    markHelpSeen()
  })

  el.querySelector('.menu-start')!.addEventListener('click', () => {
    el.remove()
    opts.onStart(difficulty)
  })

  if (opts.onOnline) {
    el.querySelector('.menu-online')!.addEventListener('click', () => {
      el.remove()
      opts.onOnline!()
    })
  } else {
    ;(el.querySelector('.menu-online')! as HTMLButtonElement).style.display = 'none'
  }

  if (!seenHelp()) openHelp() // 首次进游戏自动弹一次
}
