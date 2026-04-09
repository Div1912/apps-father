#!/bin/bash
set -e

APP_DIR="/opt/apps-father"
cd $APP_DIR

# Update .env for production
sed -i 's/NODE_ENV=development/NODE_ENV=production/' .env 2>/dev/null || true

echo "Starting Apps Father with PM2..."
pm2 delete apps-father 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo ""
echo "Apps Father is running!"
echo "Check status: pm2 status"
echo "View logs: pm2 logs apps-father"
