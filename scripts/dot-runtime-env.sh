#!/bin/sh
# Parse data only; credentials never appear in command-line arguments or logs.
smart_load_dot_runtime_env() {
    file=${1:?Dot configuration required}
    DOT_BASE_URL= DOT_TABLET_KEY=
    seen_url=0 seen_key=0
    [ -f "$file" ] && [ ! -L "$file" ] || return 2
    [ "$(wc -l <"$file" | tr -d ' ')" = 2 ] || return 2
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            DOT_BASE_URL=*)
                [ "$seen_url" = 0 ] || return 2
                seen_url=1; DOT_BASE_URL=${line#DOT_BASE_URL=} ;;
            DOT_TABLET_KEY=*)
                [ "$seen_key" = 0 ] || return 2
                seen_key=1; DOT_TABLET_KEY=${line#DOT_TABLET_KEY=} ;;
            *) return 2 ;;
        esac
    done < "$file"
    [ "$seen_url:$seen_key" = 1:1 ] || return 2
    case "$DOT_BASE_URL" in https://*/dot) ;; *) return 2 ;; esac
    case "$DOT_BASE_URL" in *[!A-Za-z0-9.:/_-]*) return 2 ;; esac
    case "$DOT_TABLET_KEY" in ''|*[!A-Za-z0-9_-]*) return 2 ;; esac
    [ "${#DOT_TABLET_KEY}" -ge 32 ] && [ "${#DOT_TABLET_KEY}" -le 256 ] || return 2
}
