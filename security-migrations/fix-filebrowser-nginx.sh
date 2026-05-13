# No shebang — called as: bash /tmp/fix_fb.sh  (shebang causes CRLF errors)
SERVER_NAME="%%SERVER_NAME%%"
FB_DB="/opt/filebrowser/filebrowser.db"
FB_BASEURL="/filebrowser"

set -e

# ── Auto-detect nginx site config (follows symlinks via for loop) ───────────
echo ""
echo "=== Searching for nginx site config ==="
NGINX_SITE=""
for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null; do
  [ -e "$f" ] || continue
  if grep -q "$SERVER_NAME" "$f" 2>/dev/null; then
    NGINX_SITE="$f"
    break
  fi
done

# Fallback: any config with proxy_pass to 3001
if [ -z "$NGINX_SITE" ]; then
  for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf 2>/dev/null; do
    [ -e "$f" ] || continue
    if grep -q "proxy_pass.*3001\|proxy_pass.*3000" "$f" 2>/dev/null; then
      NGINX_SITE="$f"
      break
    fi
  done
fi

if [ -z "$NGINX_SITE" ]; then
  echo "  ERROR: could not find nginx site config"
  echo "  Files in sites-enabled:"
  ls -la /etc/nginx/sites-enabled/ 2>/dev/null || echo "  (empty)"
  exit 1
fi

echo "  Found: $NGINX_SITE"
echo ""
echo "=== Filebrowser proxy — clean fix ==="
echo "  Target : https://$SERVER_NAME$FB_BASEURL/"
echo ""

# ── Remove ALL previous filebrowser inserts from the config ────────────────
echo "--> Cleaning previous filebrowser location blocks..."
python3 - "$NGINX_SITE" << 'PYEOF'
import sys, re, shutil

path = sys.argv[1]
with open(path) as f:
    txt = f.read()

shutil.copy(path, path + '.bak')

# Remove any location blocks we may have added before
txt = re.sub(
    r'\n\s*#\s*Filebrowser proxy\n\s*location\s+/(?:files|admin/files|filebrowser)[^{]*\{[^}]*\}',
    '', txt, flags=re.DOTALL
)
txt = re.sub(
    r'\n\s*location\s+/(?:files|admin/files|filebrowser)[^{]*\{[^}]*\}',
    '', txt, flags=re.DOTALL
)
txt = re.sub(r'[ \t]*include snippets/filebrowser.*?;\n', '', txt)

with open(path, 'w') as f:
    f.write(txt)
print("  cleaned (backup: " + path + ".bak)")
PYEOF

# ── Insert location /filebrowser before the catch-all location / ────────────
echo "--> Inserting location $FB_BASEURL..."
python3 - "$NGINX_SITE" "$FB_BASEURL" << 'PYEOF'
import sys, re, shutil

path    = sys.argv[1]
baseurl = sys.argv[2]

with open(path) as f:
    txt = f.read()

block = (
    "\n"
    "    # Filebrowser proxy\n"
    "    location " + baseurl + " {\n"
    "        proxy_pass         http://127.0.0.1:9090;\n"
    "        proxy_http_version 1.1;\n"
    "        proxy_set_header   Host              $host;\n"
    "        proxy_set_header   X-Real-IP         $remote_addr;\n"
    "        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;\n"
    "        proxy_set_header   X-Forwarded-Proto $scheme;\n"
    "        proxy_set_header   Upgrade           $http_upgrade;\n"
    "        proxy_set_header   Connection        \"upgrade\";\n"
    "        proxy_read_timeout 300s;\n"
    "        proxy_buffering    off;\n"
    "        client_max_body_size 500M;\n"
    "    }\n"
)

patched, n = re.subn(r'(\n[ \t]*location\s+/\s*\{)', block + r'\1', txt, count=1)
if n == 0:
    print("ERROR: could not find 'location /' — patch failed")
    sys.exit(1)

with open(path, 'w') as f:
    f.write(patched)
print("  inserted location " + baseurl + " ✓")
PYEOF

echo "--> Location blocks now in config:"
grep -n "location" "$NGINX_SITE"
echo ""

# ── Set filebrowser baseurl ─────────────────────────────────────────────────
echo "--> Setting filebrowser baseurl = $FB_BASEURL..."
if [ -f "$FB_DB" ]; then
  filebrowser -d "$FB_DB" config set --baseurl "$FB_BASEURL" 2>&1 \
    && echo "    baseurl set ✓" \
    || echo "    warning: could not set baseurl"
fi

# ── nginx test + reload ─────────────────────────────────────────────────────
echo "--> nginx -t..."
nginx -t
echo "--> systemctl reload nginx..."
systemctl reload nginx
echo "    nginx reloaded ✓"

# ── Restart filebrowser ─────────────────────────────────────────────────────
echo "--> Restarting filebrowser..."
if systemctl is-active --quiet filebrowser 2>/dev/null; then
  systemctl restart filebrowser && echo "    restarted (systemctl) ✓"
elif pm2 list 2>/dev/null | grep -q filebrowser; then
  pm2 restart filebrowser && echo "    restarted (pm2) ✓"
else
  FB_PID=$(pgrep -x filebrowser 2>/dev/null || pgrep -f "filebrowser" 2>/dev/null | head -1 || true)
  if [ -n "$FB_PID" ]; then
    kill "$FB_PID" && sleep 1
    nohup filebrowser -d "$FB_DB" --baseurl "$FB_BASEURL" &>/dev/null &
    echo "    killed PID $FB_PID and restarted ✓"
  else
    echo "    WARNING: process not found — start manually:"
    echo "    filebrowser -d $FB_DB --baseurl $FB_BASEURL &"
  fi
fi

echo ""
echo "======================================================"
echo "  https://$SERVER_NAME$FB_BASEURL/"
echo "======================================================"
echo ""
