# 掼蛋 3D 卡牌游戏 (Three.js)

接近 3A 品质的**单机掼蛋**卡牌游戏（1 真人 + 3 AI，2v2），国风雅致美术，完整正式掼蛋规则，桌面浏览器优先。

需求书：`../../../Users/wenyu/docs/superpowers/specs/2026-07-14-guandan-3d-card-game-prompt.md`

## 架构（分层解耦）

| 目录 | 职责 |
|------|------|
| `src/core/` | 纯 TS 规则引擎（零渲染依赖）：牌/牌型/出牌/进贡/升级/胜负 |
| `src/ai/` | 出牌 AI（easy/normal/hard 三档，hard = 确定化蒙特卡洛 DMC） |
| `src/render/` | Three.js 场景/牌桌/手牌 3D 视图/CSS 卡片/动画/特效 |
| `src/ui/` | HUD（顶栏信息+操作按钮）/开局菜单/玩法说明/设置面板 |
| `src/app/` | GameSession 对局流程 + prefs 持久化 |
| `src/audio/` | Web Audio 音乐与音效（BGM + 出牌/炸弹/结算音效） |
| `src/net/` | 联机接口占位（不实现服务器） |

## 里程碑

- ✅ **M1** core 规则引擎 + 单测（TDD 先行）
- ✅ **M2** 基础 3D 牌桌 + 手牌交互 + 出牌流程跑通
- ✅ **M3** AI 出牌三档（easy/normal/hard）
- ✅ **M4** 国风美术 + 动画 + 特效 + 音效
- ✅ **M5** 结算/进贡/升级/过 A 完整闭环 + 体验打磨（菜单/设置/战绩/帮助）
- 🚀 **M6** 发布 v1.0.0

## 开发命令

```bash
npm install                # 安装依赖（走 npmmirror 镜像）
npm run dev                # 开发服务器 (127.0.0.1:5173)
npm run build              # 生产构建
npm run preview            # 预览生产构建 (127.0.0.1:5188)
npm run test               # 运行单测 (vitest)
npm run test:watch         # 监听模式 TDD
npm run typecheck          # tsc 类型检查
npm run coverage           # 覆盖率
npm run test:bot           # Playwright bot 对局测试
npm run test:prod          # Playwright 生产构建验证
npm run test:all           # vitest + Playwright 全量
```

## AI 自对弈

```bash
# AI 自对弈分析（4 hard 互博）
npx tsx scripts/selfplay.ts [场数=20]

# 实力基准（hard vs normal）
npx tsx scripts/selfplay.ts 20 --vs
```

## 技术栈

| 层 | 技术 |
|----|------|
| 3D 渲染 | Three.js 0.185 |
| 构建 | Vite 8 + TypeScript 7 |
| 测试 | Vitest 4 + Playwright |
| 音频 | Web Audio API（程序化合成） |
| 持久化 | localStorage |
| AI | 确定化蒙特卡洛 (DMC) + 启发式 baseline |

## 捆版大小

| Chunk | 大小 (gzip) |
|-------|------------|
| 应用代码 | 22.7 KB |
| Three.js | 137.7 KB |
| CSS | 2.0 KB |
| **合计** | **~162 KB** |
