#compdef fraktik
# Zsh completion for fraktik.
#
# Install: place on your $fpath (e.g. copy or symlink into a directory
# already on fpath, such as ~/.zsh/completions), then `autoload -U
# compinit && compinit`. Regenerate after fraktik's command surface
# changes; see docs/fraktik-completions.md for the verification contract that
# keeps this file in sync.

# _fraktik_commands and _fraktik_subcommands_* below are the
# canonical list; test/cli-completions.test.mjs cross-checks them against
# bin/fraktik's own `supported` command array and fails on drift in
# either direction.
_fraktik_commands=(start spinoff send status read watch list archive title web plan worktree intelligence doctor)
_fraktik_subcommands_title=(set get)
_fraktik_subcommands_web=(begin join collect readiness accept)
_fraktik_subcommands_plan=(slices)
_fraktik_subcommands_intelligence=(route verify)
_fraktik_subcommands_worktree=(plan provision inspect launch integration)

_fraktik_common_opts=(--thread-id --socket --timeout-ms -h --help)

_fraktik() {
  local -a command_words
  command_words=("${words[@]:1}")

  if (( CURRENT == 2 )); then
    _describe 'command' _fraktik_commands
    return
  fi

  local command="${words[2]}"
  case "$command" in
    start|spinoff)
      _values 'option' --cwd --prompt --prompt-file --model --effort --sandbox \
        --permissions --approval --wait --queen-thread-id \
        "${_fraktik_common_opts[@]}"
      ;;
    send)
      _values 'option' --prompt --prompt-file "${_fraktik_common_opts[@]}"
      ;;
    status)
      _values 'option' "${_fraktik_common_opts[@]}"
      ;;
    read)
      _values 'option' --turns "${_fraktik_common_opts[@]}"
      ;;
    watch)
      _values 'option' --poll-ms --max-wait-ms "${_fraktik_common_opts[@]}"
      ;;
    list)
      _values 'option' --limit --all --search "${_fraktik_common_opts[@]}"
      ;;
    archive)
      _values 'option' --detach --restore-detached "${_fraktik_common_opts[@]}"
      ;;
    doctor)
      _values 'option' --codex --socket
      ;;
    title)
      if (( CURRENT == 3 )); then
        _describe 'subcommand' _fraktik_subcommands_title
        return
      fi
      _values 'option' "${_fraktik_common_opts[@]}"
      ;;
    web)
      if (( CURRENT == 3 )); then
        _describe 'subcommand' _fraktik_subcommands_web
        return
      fi
      case "${words[3]}" in
        accept)
          _values 'option' --id --queen-thread-id --thread-id --work-unit-id \
            --member-thread-id --source-turn-id --result-file \
            --decision --summary "${_fraktik_common_opts[@]}"
          ;;
        readiness)
          _values 'option' --id --queen-thread-id --thread-id \
            "${_fraktik_common_opts[@]}"
          ;;
        *)
          _values 'option' --id --title --registry-only --queen-thread-id --wait \
            --poll-ms --max-wait-ms "${_fraktik_common_opts[@]}"
          ;;
      esac
      ;;
    plan)
      if (( CURRENT == 3 )); then
        _describe 'subcommand' _fraktik_subcommands_plan
        return
      fi
      _values 'option' --spec-file "${_fraktik_common_opts[@]}"
      ;;
    intelligence)
      if (( CURRENT == 3 )); then
        _describe 'subcommand' _fraktik_subcommands_intelligence
        return
      fi
      case "${words[3]}" in
        route)
          _values 'option' --task-shape --profile --model --effort \
            --allow-native-fanout "${_fraktik_common_opts[@]}"
          ;;
        verify)
          _values 'option' --thread-id --turn-id --model --effort
          ;;
      esac
      ;;
    worktree)
      if (( CURRENT == 3 )); then
        _describe 'subcommand' _fraktik_subcommands_worktree
        return
      fi
      case "${words[3]}" in
        plan)
          _values 'option' --web-id --work-unit-id --spec-revision --attempt --worktree-root
          ;;
        provision)
          _values 'option' --action-id --work-unit-id --owner-task-id --source \
            --worktree-path --branch --base --operation
          ;;
        inspect)
          _values 'option' --action-id
          ;;
        launch)
          _values 'option' --work-unit-spec --prompt --prompt-file --source \
            --worktree-root --worktree-path --branch --base --model --effort \
            --sandbox --permissions --approval --wait --poll-ms --max-wait-ms \
            "${_fraktik_common_opts[@]}"
          ;;
        integration)
          _values 'option' --queen-thread-id --thread-id "${_fraktik_common_opts[@]}"
          ;;
      esac
      ;;
  esac
}

_fraktik "$@"
