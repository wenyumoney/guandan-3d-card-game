#!/usr/bin/env bash
# 掼蛋 3D 卡牌 — 阿里云自动部署脚本
# 用法：
#   bash scripts/deploy.sh setup  <user@host>   # 首次：安装 Node.js + PM2
#   bash scripts/deploy.sh deploy <user@host>   # 每次：构建 + 上传 + 重启
#
# 需要 Git Bash（Windows）或 Linux/Mac 终端

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── 颜色 ──
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()  { echo -e "${CYAN}[部署]${NC} $*"; }
ok()    { echo -e "${GREEN}  ✓${NC} $*"; }
err()   { echo -e "${RED}  ✗${NC} $*"; exit 1; }

# ── 参数 ──
CMD="${1:-}"
TARGET="${2:-}"
APP_NAME="guandan-server"
DEPLOY_DIR="/opt/guandan"
NODE_VERSION="22"

case "$CMD" in
  setup)
    # ═══════════════════════════════════════════
    # 首次设置远程服务器
    # ═══════════════════════════════════════════
    [ -z "$TARGET" ] && err "用法: bash scripts/deploy.sh setup root@你的阿里云IP"
    info "设置远程服务器: $TARGET"
    ssh "$TARGET" bash -s <<'REMOTE'
      set -e
      echo "▶ 更新系统..."
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq && apt-get install -y -qq curl git unzip 2>/dev/null || true

      # Node.js 22（通过 NodeSource）
      if ! command -v node &>/dev/null; then
        echo "▶ 安装 Node.js 22..."
        curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
        apt-get install -y nodejs
      fi
      echo "  Node.js $(node -v) / npm $(npm -v)"

      # PM2 进程守护
      if ! command -v pm2 &>/dev/null; then
        echo "▶ 安装 PM2..."
        npm install -g pm2
      fi
      echo "  PM2 $(pm2 -v)"

      # 创建部署目录
      mkdir -p /opt/guandan
      echo "✓ 服务器准备完成"
REMOTE
    ok "服务器已就绪"
    info "下一步: bash scripts/deploy.sh deploy $TARGET"
    ;;

  deploy)
    # ═══════════════════════════════════════════
    # 构建 + 上传 + 重启
    # ═══════════════════════════════════════════
    [ -z "$TARGET" ] && err "用法: bash scripts/deploy.sh deploy root@你的阿里云IP"

    # 1. 构建
    info "构建生产包..."
    npm run build || err "构建失败，请先 npm install"
    ok "dist/ 生成完成"

    # 2. 打包（只上传运行时需要的文件）
    info "打包部署文件..."
    TAR="deploy-$(date +%Y%m%d-%H%M%S).tar.gz"
    tar --exclude='*.test.ts' --exclude='node_modules' -czf "$TAR" \
      dist/ server/ src/core/ src/ai/ src/net/protocol.ts package.json package-lock.json
    ok "打包完成: $TAR ($(du -h "$TAR" | cut -f1))"

    # 3. 上传
    info "上传到 $TARGET:$DEPLOY_DIR..."
    scp "$TAR" "$TARGET:$DEPLOY_DIR/"
    ok "上传完成"

    # 4. 远程解压 + 安装 + 重启
    info "远程安装 & 重启..."
    ssh "$TARGET" bash -s <<REMOTE
      set -e
      cd $DEPLOY_DIR

      echo "▶ 解压..."
      tar xzf $TAR --overwrite
      rm -f $TAR

      echo "▶ 安装依赖..."
      npm install --production --registry=https://registry.npmmirror.com

      echo "▶ 重启服务..."
      export PORT=8787
      pm2 delete $APP_NAME 2>/dev/null || true
      pm2 start npm --name $APP_NAME -- run start
      pm2 save
      pm2 status

      echo ""
      echo "✓ 部署完成！"
      echo "  状态: pm2 status"
      echo "  日志: pm2 logs $APP_NAME"
      echo "  重启: pm2 restart $APP_NAME"
REMOTE
    rm -f "$TAR"
    ok "部署成功 🀄"
    ;;

  logs)
    # ═══════════════════════════════════════════
    # 查看远程日志
    # ═══════════════════════════════════════════
    [ -z "$TARGET" ] && err "用法: bash scripts/deploy.sh logs root@你的阿里云IP"
    ssh "$TARGET" "pm2 logs $APP_NAME --lines 50"
    ;;

  status)
    # ═══════════════════════════════════════════
    # 查看远程服务状态
    # ═══════════════════════════════════════════
    [ -z "$TARGET" ] && err "用法: bash scripts/deploy.sh status root@你的阿里云IP"
    ssh "$TARGET" "pm2 status"
    ;;

  *)
    echo ""
    echo "🀄 掼蛋 3D 卡牌 — 阿里云部署工具"
    echo ""
    echo "用法:"
    echo "  bash scripts/deploy.sh setup  root@你的IP   # 首次：安装 Node.js + PM2"
    echo "  bash scripts/deploy.sh deploy root@你的IP   # 每次：构建 + 上传 + 重启"
    echo "  bash scripts/deploy.sh logs   root@你的IP   # 查看日志"
    echo "  bash scripts/deploy.sh status root@你的IP   # 查看状态"
    echo ""
    echo "前提:"
    echo "  1. 阿里云 ECS 已购买，安全组已开放 80 端口"
    echo "  2. 本机能 SSH 到服务器 (ssh root@IP)"
    ;;
esac
