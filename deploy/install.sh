#!/bin/bash
set -e

APP_DIR="/opt/apps-father"
cd $APP_DIR

echo "Installing dependencies..."
npm install

echo "Generating Prisma client..."
npx prisma generate

echo "Starting PostgreSQL..."
docker compose up -d
sleep 5

echo "Pushing database schema..."
npx prisma db push

echo "Building TypeScript..."
npm run build

echo "Creating directories..."
mkdir -p projects

echo ""
echo "Installation complete! Run: bash deploy/start.sh"
