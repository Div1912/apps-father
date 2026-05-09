#!/bin/bash
set -e

DOMAIN="apps-father.com"
APP_DIR="/opt/apps-father"

echo "========================================="
echo "  Apps Father - Server Setup"
echo "========================================="

# 1. System update
echo "[1/9] Updating system..."
apt update && apt upgrade -y

# 2. Install essential packages
echo "[2/9] Installing essentials..."
apt install -y curl wget git ufw software-properties-common ca-certificates gnupg

# 3. Install Node.js 20 LTS
echo "[3/9] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
npm install -g pm2

# 4. Install Docker
echo "[4/9] Installing Docker..."
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# 5. Install Nginx
echo "[5/9] Installing Nginx..."
apt install -y nginx

# 6. Install Certbot
echo "[6/9] Installing Certbot..."
apt install -y certbot python3-certbot-nginx

# 7. Configure Firewall
echo "[7/9] Configuring firewall..."
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# 8. Setup application
echo "[8/9] Setting up application..."
mkdir -p $APP_DIR
cd $APP_DIR

if [ -f "package.json" ]; then
    echo "Project files found, installing dependencies..."
    npm install
    npx prisma generate

    # Start PostgreSQL
    docker compose up -d
    echo "Waiting for PostgreSQL to start..."
    sleep 5

    # Push database schema
    npx prisma db push

    # Build TypeScript
    npm run build

    # Create projects directory
    mkdir -p projects
fi

# 9. Configure Nginx
echo "[9/9] Configuring Nginx..."
cat > /etc/nginx/sites-available/apps-father << 'NGINX'
server {
    listen 80;
    server_name apps-father.com;

    client_max_body_size 500M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
    }

    location ~* ^/app/.+\.(css|js|png|jpg|jpeg|gif|svg|ico|woff2?)$ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        expires 1h;
        add_header Cache-Control "public, immutable";
    }
}
NGINX

ln -sf /etc/nginx/sites-available/apps-father /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

echo ""
echo "========================================="
echo "  Setup complete!"
echo "========================================="
echo ""
echo "Next steps:"
echo "  1. Copy project files to $APP_DIR"
echo "  2. Run: cd $APP_DIR && bash deploy/install.sh"
echo "  3. Run: certbot --nginx -d $DOMAIN"
echo "  4. Run: bash deploy/start.sh"
echo ""
