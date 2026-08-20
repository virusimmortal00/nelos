#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/bin:/bin
export PATH

die() { printf 'error: %s\n' "$*" >&2; exit 70; }
[[ $# -eq 5 ]] || die "usage: collect-golden-source-measurement.sh REQUEST KNOWN_HOSTS IDENTITY SOURCE_CONFIG OUTPUT"
readonly request_file="$1" known_hosts="$2" identity="$3" source_config="$4" output="$5"
[[ $request_file == /* && $known_hosts == /* && $identity == /* && $source_config == /* && $output == /* ]] || die "measurement arguments are invalid"
[[ ! -e $output && ! -L $output && -d $(dirname "$output") && ! -L $(dirname "$output") ]] || die "measurement output must be a new file in an existing directory"
for source in "$request_file" "$known_hosts" "$identity" "$source_config"; do
  /usr/bin/python3 -c 'import os,stat,sys; s=os.lstat(sys.argv[1]); assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and not s.st_mode & 0o022 and os.path.realpath(sys.argv[1])==sys.argv[1]' "$source" || die "measurement input is not one sealed canonical regular file"
done
readonly expected_host_fingerprint="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["volumeAttestor"]["hostKeyFingerprint"])' "$request_file")"
readonly expected_identity_fingerprint="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["volumeAttestor"]["identityFingerprint"])' "$request_file")"
readonly observed_hosts="$(/usr/bin/ssh-keygen -lf "$known_hosts" -E sha256 | awk '{print $2}')"
readonly observed_identity="$(/usr/bin/ssh-keygen -lf "$identity" -E sha256 | awk 'NR == 1 {print $2}')"
[[ $observed_hosts == "$expected_host_fingerprint" && $observed_identity == "$expected_identity_fingerprint" ]] || die "volume-attestor host or principal fingerprint differs from the request"
readonly payload="$(/usr/bin/python3 - "$request_file" "$source_config" <<'PY'
import datetime, hashlib, json, sys, time
request=json.load(open(sys.argv[1], encoding="utf-8")); config=json.load(open(sys.argv[2], encoding="utf-8")); now=int(time.time()*1000)
required={"apiTlsCaDigest","apiUrl","attestorTokenId","buildNonce","buildTokenId","cleanupExpiresAt","expiresAt","maxBuildMs","networkAclPath","node","outputTemplate","providerId","reservationId","schemaVersion","sourceCommit","sourceTemplateName","storage","volumeAttestor"}
assert set(request)==required and request["schemaVersion"]==1 and request["providerId"]=="proxmox-lab" and request["storage"]=="local-lvm"
assert request["outputTemplate"]=={"macAddress":"02:4E:45:4C:90:27","name":"nelos-desktop-ubuntu-24-04-v1","vmId":request["outputTemplate"]["vmId"]}
assert config.get("name")==request["sourceTemplateName"] and int(config.get("template",0))==1
canonical=lambda value: json.dumps(value, sort_keys=True, separators=(",",":"), ensure_ascii=False)
config_digest="sha256:"+hashlib.sha256(canonical(config).encode()).hexdigest()
deadline=min(now+request["maxBuildMs"], int(datetime.datetime.fromisoformat(request["expiresAt"].replace("Z","+00:00")).timestamp()*1000))
assert deadline-now>=300000
payload={"schemaVersion":1,"providerId":request["providerId"],"node":request["node"],"storage":request["storage"],"reservationId":request["reservationId"],"buildNonce":request["buildNonce"],"role":"source","vmId":9024,"name":request["sourceTemplateName"],"configDigest":config_digest,"deadlineAt":datetime.datetime.fromtimestamp(deadline/1000,datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00","Z"),"maxBytes":274877906944}
print(canonical(payload))
PY
)" || die "source-measurement request could not be derived"
readonly host="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["volumeAttestor"]["sshHost"])' "$request_file")"
readonly port="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["volumeAttestor"]["sshPort"])' "$request_file")"
readonly user="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["volumeAttestor"]["sshUser"])' "$request_file")"
readonly temporary="${output}.partial"
[[ ! -e $temporary && ! -L $temporary ]] || die "partial measurement output already exists"
printf '%s\n' "$payload" | /usr/bin/ssh -F /dev/null -T -p "$port" \
  -o BatchMode=yes -o CanonicalizeHostname=no -o CheckHostIP=no -o ClearAllForwardings=yes -o ControlMaster=no -o ControlPath=none \
  -o ForwardAgent=no -o GlobalKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o IdentityAgent=none -o KbdInteractiveAuthentication=no \
  -o NumberOfPasswordPrompts=0 -o PasswordAuthentication=no -o PermitLocalCommand=no -o ProxyCommand=none -o ProxyJump=none -o RequestTTY=no \
  -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=${known_hosts}" -i "$identity" -- "${user}@${host}" \
  /usr/bin/sudo -n /usr/libexec/nelos-proxmox-volume-measure request > "$temporary"
[[ $(wc -c < "$temporary") -ge 128 && $(wc -c < "$temporary") -le 1048576 ]] || die "volume measurement output is missing or oversized"
/usr/bin/python3 -c 'import json,sys; v=json.load(open(sys.argv[1], encoding="utf-8")); assert v["role"]=="source" and v["vmId"]==9024 and v["status"]=="stopped"' "$temporary" || die "volume measurement output is invalid"
chmod 0400 "$temporary"
mv -n -- "$temporary" "$output" || die "volume measurement output could not be committed"
printf 'measurement=%s\n' "sha256:$(/usr/bin/python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$output")"
