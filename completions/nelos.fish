# Fish completion for nelos.
#
# Install: copy or symlink into ~/.config/fish/completions/nelos.fish.
# Regenerate after nelos's command surface changes; see
# docs/nelos-completions.md for the verification contract that keeps this
# file in sync.

# Each `-a "COMMAND"` line under __fish_use_subcommand below is the
# canonical top-level command list; test/cli-completions.test.mjs
# cross-checks them against bin/nelos's own `supported` command array
# and fails on drift in either direction.
complete -c nelos -f
complete -c nelos -n __fish_use_subcommand -a start -d 'Start a new durable task'
complete -c nelos -n __fish_use_subcommand -a spinoff -d 'Start a queen-directed durable task'
complete -c nelos -n __fish_use_subcommand -a send -d 'Start a follow-up turn on a task'
complete -c nelos -n __fish_use_subcommand -a status -d 'Read task lifecycle status'
complete -c nelos -n __fish_use_subcommand -a read -d 'Read recent task turns'
complete -c nelos -n __fish_use_subcommand -a watch -d 'Wait for one task to settle'
complete -c nelos -n __fish_use_subcommand -a list -d 'List known tasks'
complete -c nelos -n __fish_use_subcommand -a archive -d 'Archive a task'
complete -c nelos -n __fish_use_subcommand -a title -d 'Get or set a task title'
complete -c nelos -n __fish_use_subcommand -a web -d 'Coordinate a task web'
complete -c nelos -n __fish_use_subcommand -a plan -d 'Validate and route a slice plan'
complete -c nelos -n __fish_use_subcommand -a worktree -d 'Manage isolated writer worktrees'
complete -c nelos -n __fish_use_subcommand -a intelligence -d 'Route an intelligence profile'
complete -c nelos -n __fish_use_subcommand -a desktop-test -d 'Run a disposable Desktop smoke scenario set'
complete -c nelos -n __fish_use_subcommand -a doctor -d 'Diagnose the local distribution'

complete -c nelos -n '__fish_seen_subcommand_from title; and not __fish_seen_subcommand_from set get' -a 'set get'
complete -c nelos -n '__fish_seen_subcommand_from web; and not __fish_seen_subcommand_from begin join collect readiness accept' -a 'begin join collect readiness accept'
complete -c nelos -n '__fish_seen_subcommand_from plan; and not __fish_seen_subcommand_from slices' -a slices
complete -c nelos -n '__fish_seen_subcommand_from intelligence; and not __fish_seen_subcommand_from route verify' -a 'route verify'
complete -c nelos -n '__fish_seen_subcommand_from worktree; and not __fish_seen_subcommand_from plan provision inspect launch integration' -a 'plan provision inspect launch integration'

set -l nelos_common_opts thread-id socket timeout-ms
for opt in $nelos_common_opts
    complete -c nelos -l $opt -r
end
complete -c nelos -s h -l help -d 'Show help'

complete -c nelos -n '__fish_seen_subcommand_from start spinoff' -l cwd -r
complete -c nelos -n '__fish_seen_subcommand_from start spinoff send' -l prompt -r
complete -c nelos -n '__fish_seen_subcommand_from start spinoff send' -l prompt-file -r
complete -c nelos -n '__fish_seen_subcommand_from start spinoff intelligence' -l model -r
complete -c nelos -n '__fish_seen_subcommand_from start spinoff intelligence' -l effort -r
complete -c nelos -n '__fish_seen_subcommand_from start spinoff' -l sandbox -xa 'read-only workspace-write danger-full-access'
complete -c nelos -n '__fish_seen_subcommand_from start spinoff' -l permissions -r
complete -c nelos -n '__fish_seen_subcommand_from start spinoff' -l approval -xa 'never on-request untrusted'
complete -c nelos -n '__fish_seen_subcommand_from start spinoff web' -l wait
complete -c nelos -n '__fish_seen_subcommand_from spinoff web' -l queen-thread-id -r
complete -c nelos -n '__fish_seen_subcommand_from read' -l turns -r
complete -c nelos -n '__fish_seen_subcommand_from watch web' -l poll-ms -r
complete -c nelos -n '__fish_seen_subcommand_from watch web' -l max-wait-ms -r
complete -c nelos -n '__fish_seen_subcommand_from list' -l limit -r
complete -c nelos -n '__fish_seen_subcommand_from list' -l all
complete -c nelos -n '__fish_seen_subcommand_from list' -l search -r
complete -c nelos -n '__fish_seen_subcommand_from archive' -l detach
complete -c nelos -n '__fish_seen_subcommand_from archive' -l restore-detached
complete -c nelos -n '__fish_seen_subcommand_from doctor' -l codex -r
complete -c nelos -n '__fish_seen_subcommand_from desktop-test' -l candidate -r
complete -c nelos -n '__fish_seen_subcommand_from desktop-test' -l scenario-set -r
complete -c nelos -n '__fish_seen_subcommand_from desktop-test' -l run-id -r
complete -c nelos -n '__fish_seen_subcommand_from desktop-test' -l bundle-output -r
complete -c nelos -n '__fish_seen_subcommand_from web' -l id -r
complete -c nelos -n '__fish_seen_subcommand_from web' -l title -r
complete -c nelos -n '__fish_seen_subcommand_from web' -l registry-only
complete -c nelos -n '__fish_seen_subcommand_from web; and __fish_seen_subcommand_from accept' -l work-unit-id -r
complete -c nelos -n '__fish_seen_subcommand_from web; and __fish_seen_subcommand_from accept' -l member-thread-id -r
complete -c nelos -n '__fish_seen_subcommand_from web; and __fish_seen_subcommand_from accept' -l source-turn-id -r
complete -c nelos -n '__fish_seen_subcommand_from web; and __fish_seen_subcommand_from accept' -l result-file -r
complete -c nelos -n '__fish_seen_subcommand_from web; and __fish_seen_subcommand_from accept' -l decision -xa 'accepted rejected'
complete -c nelos -n '__fish_seen_subcommand_from web; and __fish_seen_subcommand_from accept' -l summary -r
complete -c nelos -n '__fish_seen_subcommand_from plan' -l spec-file -r
complete -c nelos -n '__fish_seen_subcommand_from intelligence' -l task-shape -xa 'complex/open-ended everyday clear/repeatable'
complete -c nelos -n '__fish_seen_subcommand_from intelligence' -l profile -xa 'sol terra luna'
complete -c nelos -n '__fish_seen_subcommand_from intelligence' -l allow-native-fanout
complete -c nelos -n '__fish_seen_subcommand_from intelligence; and __fish_seen_subcommand_from verify' -l turn-id -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from plan' -l web-id -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from plan provision' -l work-unit-id -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from plan' -l spec-revision -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from plan' -l attempt -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from plan launch' -l worktree-root -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from provision inspect' -l action-id -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from provision' -l owner-task-id -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from provision launch' -l source -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from provision launch' -l worktree-path -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from provision launch' -l branch -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from provision launch' -l base -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from provision' -l operation -xa 'create adopt'
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from launch' -l work-unit-spec -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from launch' -l prompt -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from launch' -l prompt-file -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from launch' -l model -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from launch' -l effort -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from launch' -l sandbox -xa 'read-only workspace-write danger-full-access'
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from launch' -l permissions -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from launch' -l approval -xa 'never on-request untrusted'
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from launch' -l wait
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from launch' -l poll-ms -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from launch' -l max-wait-ms -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from integration' -l queen-thread-id -r
complete -c nelos -n '__fish_seen_subcommand_from worktree; and __fish_seen_subcommand_from integration' -l thread-id -r
