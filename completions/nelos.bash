# Bash completion for nelos.
#
# Install: source this file from ~/.bashrc, e.g.
#   source /absolute/path/to/completions/nelos.bash
# Regenerate after nelos's command surface changes; see
# docs/nelos-completions.md for the verification contract that keeps this file
# in sync.

# COMMANDS and per-command SUBCOMMANDS/OPTIONS below are the canonical list;
# test/cli-completions.test.mjs cross-checks them against bin/nelos's
# own `supported` command array and fails on drift in either direction.
_nelos_commands="start spinoff send status read watch list archive title web plan worktree intelligence desktop-test doctor"

_nelos_subcommands_title="set get"
_nelos_subcommands_web="begin join collect readiness accept"
_nelos_subcommands_plan="slices"
_nelos_subcommands_intelligence="route verify"
_nelos_subcommands_worktree="plan provision inspect launch integration"

_nelos_common_opts="--thread-id --socket --timeout-ms -h --help"
_nelos_opts_start="--cwd --prompt --prompt-file --model --effort --sandbox --permissions --approval --wait"
_nelos_opts_spinoff="$_nelos_opts_start --queen-thread-id"
_nelos_opts_send="--prompt --prompt-file"
_nelos_opts_status=""
_nelos_opts_read="--turns"
_nelos_opts_watch="--poll-ms --max-wait-ms"
_nelos_opts_list="--limit --all --search"
_nelos_opts_archive="--detach --restore-detached"
_nelos_opts_web_begin="--title --registry-only"
_nelos_opts_web_join="--id --title --registry-only"
_nelos_opts_web_collect="--id --queen-thread-id --wait --poll-ms --max-wait-ms"
_nelos_opts_web_readiness="--id --queen-thread-id --thread-id"
_nelos_opts_web_accept="--id --queen-thread-id --thread-id --work-unit-id --member-thread-id --source-turn-id --result-file --decision --summary"
_nelos_opts_plan_slices="--spec-file"
_nelos_opts_intelligence_route="--task-shape --profile --model --effort --allow-native-fanout"
_nelos_opts_intelligence_verify="--thread-id --turn-id --model --effort"
_nelos_opts_worktree_plan="--web-id --work-unit-id --spec-revision --attempt --worktree-root"
_nelos_opts_worktree_provision="--action-id --work-unit-id --owner-task-id --source --worktree-path --branch --base --operation"
_nelos_opts_worktree_inspect="--action-id"
_nelos_opts_worktree_launch="--work-unit-spec --prompt --prompt-file --source --worktree-root --worktree-path --branch --base --model --effort --sandbox --permissions --approval --wait --poll-ms --max-wait-ms"
_nelos_opts_worktree_integration="--queen-thread-id --thread-id"
_nelos_opts_doctor="--codex --socket"
_nelos_opts_desktop_test="--candidate --scenario-set --run-id --bundle-output"

_nelos_completions() {
  local cur prev command subcommand
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  command="${COMP_WORDS[1]}"
  subcommand="${COMP_WORDS[2]}"

  if [[ "$COMP_CWORD" -eq 1 ]]; then
    COMPREPLY=($(compgen -W "$_nelos_commands" -- "$cur"))
    return
  fi

  local opts=""
  case "$command" in
    start) opts="$_nelos_opts_start $_nelos_common_opts" ;;
    spinoff) opts="$_nelos_opts_spinoff $_nelos_common_opts" ;;
    send) opts="$_nelos_opts_send $_nelos_common_opts" ;;
    status) opts="$_nelos_opts_status $_nelos_common_opts" ;;
    read) opts="$_nelos_opts_read $_nelos_common_opts" ;;
    watch) opts="$_nelos_opts_watch $_nelos_common_opts" ;;
    list) opts="$_nelos_opts_list $_nelos_common_opts" ;;
    archive) opts="$_nelos_opts_archive $_nelos_common_opts" ;;
    doctor) opts="$_nelos_opts_doctor" ;;
    desktop-test) opts="$_nelos_opts_desktop_test" ;;
    title)
      if [[ "$COMP_CWORD" -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$_nelos_subcommands_title" -- "$cur"))
        return
      fi
      opts="$_nelos_common_opts"
      ;;
    web)
      if [[ "$COMP_CWORD" -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$_nelos_subcommands_web" -- "$cur"))
        return
      fi
      case "$subcommand" in
        begin) opts="$_nelos_opts_web_begin $_nelos_common_opts" ;;
        join) opts="$_nelos_opts_web_join $_nelos_common_opts" ;;
        collect) opts="$_nelos_opts_web_collect $_nelos_common_opts" ;;
        readiness) opts="$_nelos_opts_web_readiness $_nelos_common_opts" ;;
        accept) opts="$_nelos_opts_web_accept $_nelos_common_opts" ;;
      esac
      ;;
    plan)
      if [[ "$COMP_CWORD" -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$_nelos_subcommands_plan" -- "$cur"))
        return
      fi
      opts="$_nelos_opts_plan_slices $_nelos_common_opts"
      ;;
    intelligence)
      if [[ "$COMP_CWORD" -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$_nelos_subcommands_intelligence" -- "$cur"))
        return
      fi
      case "$subcommand" in
        route) opts="$_nelos_opts_intelligence_route $_nelos_common_opts" ;;
        verify) opts="$_nelos_opts_intelligence_verify" ;;
      esac
      ;;
    worktree)
      if [[ "$COMP_CWORD" -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$_nelos_subcommands_worktree" -- "$cur"))
        return
      fi
      case "$subcommand" in
        plan) opts="$_nelos_opts_worktree_plan" ;;
        provision) opts="$_nelos_opts_worktree_provision" ;;
        inspect) opts="$_nelos_opts_worktree_inspect" ;;
        launch) opts="$_nelos_opts_worktree_launch $_nelos_common_opts" ;;
        integration) opts="$_nelos_opts_worktree_integration $_nelos_common_opts" ;;
      esac
      ;;
  esac

  COMPREPLY=($(compgen -W "$opts" -- "$cur"))
}

complete -F _nelos_completions nelos
