#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this uninstaller with sudo." >&2
  exit 1
fi

purge=false
[[ "${1:-}" == "--purge" ]] && purge=true

systemctl disable --now chatinabox.service chatinabox-bridge.service \
  >/dev/null 2>&1 || true
rm -f /etc/systemd/system/chatinabox.service
rm -f /etc/systemd/system/chatinabox-bridge.service
rm -f /usr/local/bin/chatinabox
systemctl daemon-reload

rm -rf /opt/chatinabox
if $purge; then
  rm -rf /var/lib/chatinabox /var/lib/chatinabox-bridge /etc/chatinabox
  userdel chatinabox >/dev/null 2>&1 || true
  groupdel chatinabox >/dev/null 2>&1 || true
  echo "Chatinabox and its local state were removed."
else
  echo "Chatinabox was removed. State remains in /var/lib/chatinabox, /var/lib/chatinabox-bridge, and /etc/chatinabox."
  echo "Use --purge to remove them too."
fi
