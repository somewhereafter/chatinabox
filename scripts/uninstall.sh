#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this uninstaller with sudo." >&2
  exit 1
fi

purge=false
[[ "${1:-}" == "--purge" ]] && purge=true

systemctl disable --now catinabox.service catinabox-bridge.service \
  >/dev/null 2>&1 || true
rm -f /etc/systemd/system/catinabox.service
rm -f /etc/systemd/system/catinabox-bridge.service
rm -f /usr/local/bin/catinabox
systemctl daemon-reload

rm -rf /opt/catinabox
if $purge; then
  rm -rf /var/lib/catinabox /var/lib/catinabox-bridge /etc/catinabox
  userdel catinabox >/dev/null 2>&1 || true
  groupdel catinabox >/dev/null 2>&1 || true
  echo "Catinabox and its local state were removed."
else
  echo "Catinabox was removed. State remains in /var/lib/catinabox, /var/lib/catinabox-bridge, and /etc/catinabox."
  echo "Use --purge to remove them too."
fi
