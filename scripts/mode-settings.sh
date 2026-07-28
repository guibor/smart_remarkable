#!/bin/sh
# Strict parser for non-secret Smart Remarkable interaction settings.
# The file is data, never sourced or evaluated.

smart_load_mode_settings() {
    SMART_MODE=session-hold
    SMART_HOLD_MS=800
    SMART_HOLD_RADIUS_PX=12
    SMART_MIN_EXTENT_PX=24
    SMART_ONCE_TIMEOUT_SECONDS=600
    SMART_SESSION_TIMEOUT_SECONDS=3600
    SMART_SETTINGS_FILE=${SMART_REMARKABLE_SETTINGS_FILE:-/home/root/.config/smart-remarkable/settings.conf}

    if [ -e "$SMART_SETTINGS_FILE" ]; then
        [ -f "$SMART_SETTINGS_FILE" ] && [ ! -L "$SMART_SETTINGS_FILE" ] || {
            echo "Invalid Smart Remarkable settings path" >&2
            return 2
        }
        while IFS= read -r line || [ -n "$line" ]; do
            case "$line" in
                ''|'#'*) ;;
                mode=*) SMART_MODE=${line#mode=} ;;
                hold_ms=*) SMART_HOLD_MS=${line#hold_ms=} ;;
                hold_radius_px=*) SMART_HOLD_RADIUS_PX=${line#hold_radius_px=} ;;
                min_extent_px=*) SMART_MIN_EXTENT_PX=${line#min_extent_px=} ;;
                once_timeout_seconds=*) SMART_ONCE_TIMEOUT_SECONDS=${line#once_timeout_seconds=} ;;
                session_timeout_seconds=*) SMART_SESSION_TIMEOUT_SECONDS=${line#session_timeout_seconds=} ;;
                *)
                    echo "Unknown or malformed Smart Remarkable setting" >&2
                    return 2
                    ;;
            esac
        done < "$SMART_SETTINGS_FILE"
    fi

    case "$SMART_MODE" in
        once)
            SMART_TRIGGER_CORNER=pen-release
            SMART_NO_LOOP=1
            SMART_RUNTIME_MAX_SECONDS=$SMART_ONCE_TIMEOUT_SECONDS
            ;;
        session-hold)
            SMART_TRIGGER_CORNER=pen-hold
            SMART_NO_LOOP=0
            SMART_RUNTIME_MAX_SECONDS=$SMART_SESSION_TIMEOUT_SECONDS
            ;;
        session-auto)
            SMART_TRIGGER_CORNER=pen-release
            SMART_NO_LOOP=0
            SMART_RUNTIME_MAX_SECONDS=$SMART_SESSION_TIMEOUT_SECONDS
            ;;
        *)
            echo "mode must be once, session-hold, or session-auto" >&2
            return 2
            ;;
    esac

    for value in \
        "$SMART_HOLD_MS" \
        "$SMART_HOLD_RADIUS_PX" \
        "$SMART_MIN_EXTENT_PX" \
        "$SMART_ONCE_TIMEOUT_SECONDS" \
        "$SMART_SESSION_TIMEOUT_SECONDS"
    do
        case "$value" in
            ''|*[!0-9]*)
                echo "Smart Remarkable numeric settings must be unsigned integers" >&2
                return 2
                ;;
        esac
    done

    [ "$SMART_HOLD_MS" -ge 400 ] && [ "$SMART_HOLD_MS" -le 3000 ] || {
        echo "hold_ms must be between 400 and 3000" >&2
        return 2
    }
    [ "$SMART_HOLD_RADIUS_PX" -ge 4 ] && [ "$SMART_HOLD_RADIUS_PX" -le 48 ] || {
        echo "hold_radius_px must be between 4 and 48" >&2
        return 2
    }
    [ "$SMART_MIN_EXTENT_PX" -ge 8 ] && [ "$SMART_MIN_EXTENT_PX" -le 128 ] || {
        echo "min_extent_px must be between 8 and 128" >&2
        return 2
    }
    [ "$SMART_ONCE_TIMEOUT_SECONDS" -ge 60 ] && [ "$SMART_ONCE_TIMEOUT_SECONDS" -le 900 ] || {
        echo "once_timeout_seconds must be between 60 and 900" >&2
        return 2
    }
    [ "$SMART_SESSION_TIMEOUT_SECONDS" -ge 300 ] && [ "$SMART_SESSION_TIMEOUT_SECONDS" -le 3900 ] || {
        echo "session_timeout_seconds must be between 300 and 3900" >&2
        return 2
    }

    export SMART_MODE SMART_HOLD_MS SMART_HOLD_RADIUS_PX
    export SMART_MIN_EXTENT_PX SMART_RUNTIME_MAX_SECONDS
    export SMART_TRIGGER_CORNER SMART_NO_LOOP SMART_SETTINGS_FILE
}
