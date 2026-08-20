#!/usr/bin/env bash
set -euo pipefail
umask 027
[[ ${EUID} -eq 0 ]] || { echo "host helper installation requires root" >&2; exit 70; }
readonly source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
for helper in nelos-proxmox-host-helper.py nelos-proxmox-attest.py nelos-proxmox-lease-authority.py; do
  [[ -f ${source_dir}/${helper} && ! -L ${source_dir}/${helper} ]] || exit 70
  /usr/bin/python3 -c 'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(), sys.argv[1], "exec")' "${source_dir}/${helper}"
done
python_runtime="$(readlink -f /usr/bin/python3)"
[[ ${python_runtime} == /usr/bin/python3.* && -f ${python_runtime} && -x ${python_runtime} && $(stat -c '%u:%g' "${python_runtime}") == 0:0 && -x /usr/bin/pvesh ]] || { echo "PVE-native Python or pvesh is unavailable" >&2; exit 70; }
install -d -o root -g root -m 0755 /usr/libexec
install -o root -g root -m 0750 "${source_dir}/nelos-proxmox-host-helper.py" /usr/libexec/nelos-proxmox-transport
install -o root -g root -m 0750 "${source_dir}/nelos-proxmox-attest.py" /usr/libexec/nelos-proxmox-attest
install -o root -g root -m 0750 "${source_dir}/nelos-proxmox-lease-authority.py" /usr/libexec/nelos-proxmox-lease-authority
