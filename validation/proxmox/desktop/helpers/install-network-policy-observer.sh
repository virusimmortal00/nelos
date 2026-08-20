#!/usr/bin/env bash
set -euo pipefail
umask 027

[[ ${EUID} -eq 0 ]] || { echo "gateway observer installation requires root" >&2; exit 70; }
readonly source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly source_path="${source_dir}/nelos-network-policy-observer.py"
readonly target_path=/usr/libexec/nelos-network-policy-observer

[[ -f ${source_path} && ! -L ${source_path} ]] || { echo "gateway observer source is unavailable" >&2; exit 70; }
/usr/bin/python3 -c 'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_text(), sys.argv[1], "exec")' "${source_path}"
[[ -x /usr/sbin/nft ]] || { echo "the fixed nftables executable is unavailable" >&2; exit 70; }
install -d -o root -g root -m 0755 /usr/libexec
install -o root -g root -m 0755 "${source_path}" "${target_path}"

readonly installed_digest="$(sha256sum "${target_path}" | awk '{print $1}')"
readonly source_digest="$(sha256sum "${source_path}" | awk '{print $1}')"
[[ ${installed_digest} == "${source_digest}" ]] || { echo "installed gateway observer digest differs" >&2; exit 77; }
printf 'sha256:%s\n' "${installed_digest}"
