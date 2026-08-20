#!/usr/bin/env bash
set -euo pipefail
umask 027
[[ ${EUID} -eq 0 ]] || { echo "host helper installation requires root" >&2; exit 70; }
readonly source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
[[ -f ${source_dir}/nelos-proxmox-host-helper.mjs && ! -L ${source_dir}/nelos-proxmox-host-helper.mjs ]] || exit 70
install -d -o root -g root -m 0750 /usr/local/libexec/nelos
install -o root -g root -m 0750 "${source_dir}/nelos-proxmox-host-helper.mjs" /usr/local/libexec/nelos/proxmox-host-helper.mjs
