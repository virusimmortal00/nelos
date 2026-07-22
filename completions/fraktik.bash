# Bash completion for fraktik.
#
# Install: source this file from ~/.bashrc, e.g.
#   source /absolute/path/to/completions/fraktik.bash
# Regenerate after fraktik's command surface changes; see
# docs/fraktik-completions.md for the verification contract that keeps this file
# in sync.

# COMMANDS and per-command SUBCOMMANDS/OPTIONS below are the canonical list;
# test/cli-completions.test.mjs cross-checks them against bin/fraktik's
# own `supported` command array and fails on drift in either direction.
_fraktik_commands="start spinoff send status read watch list archive title web plan worktree intelligence doctor"

_fraktik_subcommands_title="set get"
_fraktik_subcommands_web="begin join collect readiness accept"
_fraktik_subcommands_plan="slices"
_fraktik_subcommands_intelligence="route verify"
_fraktik_subcommands_worktree="plan provision inspect launch integration"

_fraktik_common_opts="--thread-id --socket --timeout-ms -h --help"
_fraktik_opts_start="--cwd --prompt --prompt-file --model --effort --sandbox --permissions --approval --wait"
_fraktik_opts_spinoff="$_fraktik_opts_start --queen-thread-id"
_fraktik_opts_send="--prompt --prompt-file"
_fraktik_opts_status=""
_fraktik_opts_read="--turns"
_fraktik_opts_watch="--poll-ms --max-wait-ms"
_fraktik_opts_list="--limit --all --search"
_fraktik_opts_archive="--detach --restore-detached"
_fraktik_opts_web_begin="--title --registry-only"
_fraktik_opts_web_join="--id --title --registry-only"
_fraktik_opts_web_collect="--id --queen-thread-id --wait --poll-ms --max-wait-ms"
_fraktik_opts_web_readiness="--id --queen-thread-id --thread-id"
_fraktik_opts_web_accept="--id --queen-thread-id --thread-id --work-unit-id --member-thread-id --source-turn-id --result-file --decision --summary"
_fraktik_opts_plan_slices="--spec-file"
_fraktik_opts_intelligence_route="--task-shape --profile --model --effort --allow-native-fanout"
_fraktik_opts_intelligence_verify="--thread-id --turn-id --model --effort"
_fraktik_opts_worktree_plan="--web-id --work-unit-id --spec-revision --attempt --worktree-root"
_fraktik_opts_worktree_provision="--action-id --work-unit-id --owner-task-id --source --worktree-path --branch --base --operation"
_fraktik_opts_worktree_inspect="--action-id"
_fraktik_opts_worktree_launch="--work-unit-spec --prompt --prompt-file --source --worktree-root --worktree-path --branch --base --model --effort --sandbox --permissions --approval --wait --poll-ms --max-wait-ms"
_fraktik_opts_worktree_integration="--queen-thread-id --thread-id"
_fraktik_opts_doctor="--codex --socket"

_fraktik_completions() {
  local cur prev command subcommand
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  command="${COMP_WORDS[1]}"
  subcommand="${COMP_WORDS[2]}"

  if [[ "$COMP_CWORD" -eq 1 ]]; then
    COMPREPLY=($(compgen -W "$_fraktik_commands" -- "$cur"))
    return
  fi

  local opts=""
  case "$command" in
    start) opts="$_fraktik_opts_start $_fraktik_common_opts" ;;
    spinoff) opts="$_fraktik_opts_spinoff $_fraktik_common_opts" ;;
    send) opts="$_fraktik_opts_send $_fraktik_common_opts" ;;
    status) opts="$_fraktik_opts_status $_fraktik_common_opts" ;;
    read) opts="$_fraktik_opts_read $_fraktik_common_opts" ;;
    watch) opts="$_fraktik_opts_watch $_fraktik_common_opts" ;;
    list) opts="$_fraktik_opts_list $_fraktik_common_opts" ;;
    archive) opts="$_fraktik_opts_archive $_fraktik_common_opts" ;;
    doctor) opts="$_fraktik_opts_doctor" ;;
    title)
      if [[ "$COMP_CWORD" -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$_fraktik_subcommands_title" -- "$cur"))
        return
      fi
      opts="$_fraktik_common_opts"
      ;;
    web)
      if [[ "$COMP_CWORD" -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$_fraktik_subcommands_web" -- "$cur"))
        return
      fi
      case "$subcommand" in
        begin) opts="$_fraktik_opts_web_begin $_fraktik_common_opts" ;;
        join) opts="$_fraktik_opts_web_join $_fraktik_common_opts" ;;
        collect) opts="$_fraktik_opts_web_collect $_fraktik_common_opts" ;;
        readiness) opts="$_fraktik_opts_web_readiness $_fraktik_common_opts" ;;
        accept) opts="$_fraktik_opts_web_accept $_fraktik_common_opts" ;;
      esac
      ;;
    plan)
      if [[ "$COMP_CWORD" -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$_fraktik_subcommands_plan" -- "$cur"))
        return
      fi
      opts="$_fraktik_opts_plan_slices $_fraktik_common_opts"
      ;;
    intelligence)
      if [[ "$COMP_CWORD" -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$_fraktik_subcommands_intelligence" -- "$cur"))
        return
      fi
      case "$subcommand" in
        route) opts="$_fraktik_opts_intelligence_route $_fraktik_common_opts" ;;
        verify) opts="$_fraktik_opts_intelligence_verify" ;;
      esac
      ;;
    worktree)
      if [[ "$COMP_CWORD" -eq 2 ]]; then
        COMPREPLY=($(compgen -W "$_fraktik_subcommands_worktree" -- "$cur"))
        return
      fi
      case "$subcommand" in
        plan) opts="$_fraktik_opts_worktree_plan" ;;
        provision) opts="$_fraktik_opts_worktree_provision" ;;
        inspect) opts="$_fraktik_opts_worktree_inspect" ;;
        launch) opts="$_fraktik_opts_worktree_launch $_fraktik_common_opts" ;;
        integration) opts="$_fraktik_opts_worktree_integration $_fraktik_common_opts" ;;
      esac
      ;;
  esac

  COMPREPLY=($(compgen -W "$opts" -- "$cur"))
}

complete -F _fraktik_completions fraktik
