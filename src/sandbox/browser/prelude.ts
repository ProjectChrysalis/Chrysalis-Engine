/**
 * What the sandbox shell defines before the first command runs.
 *
 * cd: the shell keeps a relative $PWD after `cd some/dir`, and every later
 * relative path then resolves against it twice (apps/x/apps/x/file). It also
 * "enters" folders that do not exist. The wrapper hands it absolute, existing
 * paths only.
 *
 * git: the workspace repository lives with the engine, so `git` is a shell
 * function that sends its arguments over the sandbox's HTTP path to a
 * reserved host the engine answers itself, and prints what comes back:
 * stdout as the body, stderr and the exit status in headers. Pipes,
 * redirection, loops and `cd` work as they would with git. Arguments travel
 * one per line, base64 encoded, so quoting, spaces and newlines survive. The
 * engine reads files as they are on disk: changes a command makes in the
 * sandbox reach it when that command finishes.
 */

/** Never resolvable (.invalid is reserved), so nothing but the engine answers. */
export const SANDBOX_GIT_HOST = "git.chrysalis.invalid";

const CD_FUNCTION = `cd() {
  local target="\${1:-/workspace}"
  case "$target" in
    /*) ;;
    -) target="$OLDPWD" ;;
    *) target="$PWD/$target" ;;
  esac
  # no early return: the shell keeps going after a return inside if
  if [ -d "$target" ]; then builtin cd "$target"; else echo "cd: $1: No such file or directory" >&2; false; fi
}`;

const GIT_FUNCTION = `git() {
  local body hdr out code
  body=$(mktemp); hdr=$(mktemp); out=$(mktemp)
  : > "$body"
  # shift, not for-in: the shell splits "$@" on spaces inside a for list
  while [ "$#" -gt 0 ]; do printf '%s' "$1" | base64 | tr -d '\\n' >> "$body"; echo >> "$body"; shift; done
  curl -s -D "$hdr" -o "$out" -H "x-git-cwd: $PWD" --data-binary "@$body" "http://${SANDBOX_GIT_HOST}/"
  if grep -qi '^x-git-exit:' "$hdr"; then
    cat "$out"
    grep -i '^x-git-stderr:' "$hdr" | cut -d' ' -f2 | tr -d '\\r' | base64 -d >&2
    code=$(grep -i '^x-git-exit:' "$hdr" | tr -dc 0-9)
  else
    echo "git: the workspace repository did not answer" >&2
    cat "$out" >&2
    code=128
  fi
  rm -f "$body" "$hdr" "$out"
  return "\${code:-128}"
}`;

export const SHELL_PRELUDE = `${CD_FUNCTION}\n${GIT_FUNCTION}`;
