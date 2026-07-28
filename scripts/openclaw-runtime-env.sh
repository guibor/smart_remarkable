#!/bin/sh
# Strict parser for the root-only Smart Remarkable runtime environment.
# The file is data, never sourced or evaluated.

smart_load_openclaw_runtime_env() {
    SMART_OPENCLAW_ENV_FILE=${1:?OpenClaw runtime environment path required}

    unset \
        OPENCLAW_BRIDGE_TOKEN \
        OPENCLAW_SSH_IDENTITY \
        OPENCLAW_LOCAL_PORT \
        OPENCLAW_REMOTE_PORT \
        SMART_REMARKABLE_MODEL \
        RUST_LOG

    [ -f "$SMART_OPENCLAW_ENV_FILE" ] &&
        [ ! -L "$SMART_OPENCLAW_ENV_FILE" ] || {
        echo "Invalid Smart Remarkable environment path" >&2
        return 2
    }
    [ "$(wc -l <"$SMART_OPENCLAW_ENV_FILE" | tr -d ' ')" = 6 ] || {
        echo "Smart Remarkable environment must contain exactly six lines" >&2
        return 2
    }

    smart_seen_bridge_token=0
    smart_seen_identity=0
    smart_seen_local_port=0
    smart_seen_remote_port=0
    smart_seen_model=0
    smart_seen_log=0

    while IFS= read -r smart_env_line || [ -n "$smart_env_line" ]; do
        case "$smart_env_line" in
            OPENCLAW_BRIDGE_TOKEN=*)
                [ "$smart_seen_bridge_token" -eq 0 ] || {
                    echo "Duplicate OpenClaw bridge token setting" >&2
                    return 2
                }
                smart_seen_bridge_token=1
                OPENCLAW_BRIDGE_TOKEN=${smart_env_line#OPENCLAW_BRIDGE_TOKEN=}
                ;;
            OPENCLAW_SSH_IDENTITY=*)
                [ "$smart_seen_identity" -eq 0 ] || {
                    echo "Duplicate OpenClaw identity setting" >&2
                    return 2
                }
                smart_seen_identity=1
                OPENCLAW_SSH_IDENTITY=${smart_env_line#OPENCLAW_SSH_IDENTITY=}
                ;;
            OPENCLAW_LOCAL_PORT=*)
                [ "$smart_seen_local_port" -eq 0 ] || {
                    echo "Duplicate OpenClaw local port setting" >&2
                    return 2
                }
                smart_seen_local_port=1
                OPENCLAW_LOCAL_PORT=${smart_env_line#OPENCLAW_LOCAL_PORT=}
                ;;
            OPENCLAW_REMOTE_PORT=*)
                [ "$smart_seen_remote_port" -eq 0 ] || {
                    echo "Duplicate OpenClaw remote port setting" >&2
                    return 2
                }
                smart_seen_remote_port=1
                OPENCLAW_REMOTE_PORT=${smart_env_line#OPENCLAW_REMOTE_PORT=}
                ;;
            SMART_REMARKABLE_MODEL=*)
                [ "$smart_seen_model" -eq 0 ] || {
                    echo "Duplicate Smart Remarkable model setting" >&2
                    return 2
                }
                smart_seen_model=1
                SMART_REMARKABLE_MODEL=${smart_env_line#SMART_REMARKABLE_MODEL=}
                ;;
            RUST_LOG=*)
                [ "$smart_seen_log" -eq 0 ] || {
                    echo "Duplicate Rust log setting" >&2
                    return 2
                }
                smart_seen_log=1
                RUST_LOG=${smart_env_line#RUST_LOG=}
                ;;
            *)
                echo "Unknown or malformed Smart Remarkable environment setting" >&2
                return 2
                ;;
        esac
    done <"$SMART_OPENCLAW_ENV_FILE"

    [ "$smart_seen_bridge_token" -eq 1 ] &&
        [ "$smart_seen_identity" -eq 1 ] &&
        [ "$smart_seen_local_port" -eq 1 ] &&
        [ "$smart_seen_remote_port" -eq 1 ] &&
        [ "$smart_seen_model" -eq 1 ] &&
        [ "$smart_seen_log" -eq 1 ] || {
        echo "Smart Remarkable environment is incomplete" >&2
        return 2
    }

    case "$OPENCLAW_BRIDGE_TOKEN" in
        ""|*[!A-Za-z0-9_-]*)
            echo "Invalid OpenClaw bridge token" >&2
            return 2
            ;;
    esac
    [ "${#OPENCLAW_BRIDGE_TOKEN}" -ge 43 ] &&
        [ "${#OPENCLAW_BRIDGE_TOKEN}" -le 128 ] || {
        echo "Invalid OpenClaw bridge token length" >&2
        return 2
    }
    [ "$OPENCLAW_SSH_IDENTITY" = \
        /home/root/.ssh/id_dropbear_smart_remarkable_bridge ] || {
        echo "Invalid OpenClaw tunnel identity setting" >&2
        return 2
    }
    [ "$OPENCLAW_LOCAL_PORT" = 18791 ] &&
        [ "$OPENCLAW_REMOTE_PORT" = 18792 ] || {
        echo "Invalid OpenClaw bridge port setting" >&2
        return 2
    }
    [ "$SMART_REMARKABLE_MODEL" = openclaw/main ] || {
        echo "Invalid Smart Remarkable model setting" >&2
        return 2
    }
    [ "$RUST_LOG" = info ] || {
        echo "Invalid Rust log setting" >&2
        return 2
    }
}
