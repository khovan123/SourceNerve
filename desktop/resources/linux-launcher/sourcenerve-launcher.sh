#!/bin/sh
set -eu

install_root="/usr/lib/sourcenerve"
desktop_binary="$install_root/sourcenerve-desktop"
daemon_binary="$install_root/resources/bin/linux-x64/sourcenerve"
cloudflared_binary="$install_root/resources/bin/cloudflared"

is_deleted_executable() {
  pid="$1"
  expected="$2"
  actual="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
  [ "$actual" = "$expected (deleted)" ]
}

is_electron_main_process() {
  pid="$1"
  if [ ! -r "/proc/$pid/cmdline" ]; then
    return 1
  fi
  ! tr '\000' '\n' < "/proc/$pid/cmdline" 2>/dev/null | grep -q '^--type='
}

stale_main_pids=""
for proc_dir in /proc/[0-9]*; do
  [ -d "$proc_dir" ] || continue
  pid="${proc_dir#/proc/}"
  if is_deleted_executable "$pid" "$desktop_binary" && is_electron_main_process "$pid"; then
    stale_main_pids="$stale_main_pids $pid"
  fi
done

if [ -n "$stale_main_pids" ]; then
  # Ask the stale Electron main process to terminate before the new binary starts.
  # Re-check /proc before every signal so PID reuse cannot target an unrelated process.
  for pid in $stale_main_pids; do
    if is_deleted_executable "$pid" "$desktop_binary"; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done

  attempts=0
  while [ "$attempts" -lt 8 ]; do
    remaining=0
    for pid in $stale_main_pids; do
      if is_deleted_executable "$pid" "$desktop_binary"; then
        remaining=1
        break
      fi
    done
    [ "$remaining" -eq 0 ] && break
    attempts=$((attempts + 1))
    sleep 1
  done

  # A wedged pre-update instance must not keep owning Electron's single-instance lock.
  for pid in $stale_main_pids; do
    if is_deleted_executable "$pid" "$desktop_binary"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done

  # Clean up stale bundled children only after a stale main process was positively identified.
  for binary in "$daemon_binary" "$cloudflared_binary"; do
    for proc_dir in /proc/[0-9]*; do
      [ -d "$proc_dir" ] || continue
      pid="${proc_dir#/proc/}"
      if is_deleted_executable "$pid" "$binary"; then
        kill -TERM "$pid" 2>/dev/null || true
      fi
    done
  done
fi

exec "$desktop_binary" "$@"
