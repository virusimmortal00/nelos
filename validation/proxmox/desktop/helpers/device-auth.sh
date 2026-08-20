#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ ${EUID} -eq 0 ]] || { echo "device-auth must be initiated by the trusted guest bootstrap" >&2; exit 70; }
readonly binding_file=/etc/nelos-desktop/run-binding.json
readonly auth_file=/var/lib/nelos-desktop/device-auth.json
readonly automation_user=nelosauto
readonly automation_home=/home/nelosauto
[[ -f ${binding_file} && ! -L ${binding_file} ]] || exit 70
[[ ! -e /root/.codex && ! -e /home/codex/.codex ]] || { echo "developer Codex state is addressable" >&2; exit 77; }
[[ ! -e ${automation_home}/.codex ]] || { echo "automation CODEX_HOME must not pre-exist" >&2; exit 77; }
install -d -o "${automation_user}" -g "${automation_user}" -m 0700 "${automation_home}/.codex"
runuser -u "${automation_user}" -- env HOME="${automation_home}" CODEX_HOME="${automation_home}/.codex" codex login --device-auth
status="$(runuser -u "${automation_user}" -- env HOME="${automation_home}" CODEX_HOME="${automation_home}/.codex" codex login status --json)"
jq -e '.authenticated == true and .modelBacked == true and (.subject | type == "string" and length > 0)' <<<"${status}" >/dev/null
jq -n --argjson binding "$(<"${binding_file}")" --arg subject "$(jq -r .subject <<<"${status}")" --arg session "$(jq -r .sessionId <<<"${status}")" \
  '{accounts:[{automation:true,subject:$subject}],binding:$binding,developerSessionImported:false,modelBacked:true,sessionId:$session}' >"${auth_file}.new"
chown root:root "${auth_file}.new"
chmod 0440 "${auth_file}.new"
mv -f "${auth_file}.new" "${auth_file}"
uid="$(id -u "${automation_user}")"
runuser -u "${automation_user}" -- env XDG_RUNTIME_DIR="/run/user/${uid}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" systemctl --user start nelos-codex-desktop.service
