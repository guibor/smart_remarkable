#!/bin/bash
# Strict data parser and device-side checks for the Smart Remarkable app/QMD
# compatibility contract. This file is sourced by both guarded installers.

smart_contract_is_sha256() {
    case "$1" in
        *[!0-9a-f]*|"") return 1 ;;
    esac
    [ "${#1}" -eq 64 ]
}

smart_contract_is_hash_or_unresolved() {
    [ "$1" = UNRESOLVED ] || smart_contract_is_sha256 "$1"
}

smart_contract_load() {
    SMART_ARTIFACT_CONTRACT_PATH=$1
    [ -f "$SMART_ARTIFACT_CONTRACT_PATH" ] || return 1
    [ ! -L "$SMART_ARTIFACT_CONTRACT_PATH" ] || return 1

    SMART_CONTRACT_REQUIRED_KEYS='ARTIFACT_CONTRACT_VERSION SELECTION_PROTOCOL_VERSION DEVICE_SERIAL FIRMWARE_VERSION FIRMWARE_BUILD XOCHITL_SHA256 XOCHITL_BUILD_ID HASHTAB_SHA256 XOVI_SHA256 QRR_SHA256 MESSAGE_BROKER_SHA256 APPLOAD_SHA256 STOCK_SCRIPT_SHA256 XOVI_XOCHITL_SERVICE_CONF_SHA256 ACTIVE_XOVI_DROPIN_SHA256 XOCHITL_UNIT_SHA256 XOCHITL_STOCK_OVERRIDE_SHA256 SCENE_SELECTION_HANDLER_RESOURCE_HASH DEVICE_SCENE_VIEW_RESOURCE_HASH SELECTION_CONTEXTUAL_MENU_RESOURCE_HASH PEN_LAYER_MEMORY_QMD_SHA256 QUICK_SETTINGS_TIMER_QMD_SHA256 BETTER_TOC_QMD_SHA256 BETTER_TOC_COLLAPSE_QMD_SHA256 GESTIK_QMD_SHA256 GHOSTBUSTER_QMD_SHA256 TOC_FROM_SELECTION_QMD_SHA256 PREVIOUS_BUTTON_QMD_SHA256 LEGACY_BUTTON_QMD_SHA256 V2_MIGRATION_BUTTON_QMD_SHA256 SOURCE_QMD_SHA256 BUTTON_QMD_SHA256 INERT_SOURCE_QMD_SHA256 INERT_BUTTON_QMD_SHA256 SMART_REMARKABLE_SHA256 APPLOAD_LAUNCHER_SHA256 RUN_ARMED_ONCE_SHA256 SELECTION_PROTOCOL_SHA256'
    for SMART_CONTRACT_KEY in $SMART_CONTRACT_REQUIRED_KEYS; do
        unset "$SMART_CONTRACT_KEY"
    done

    SMART_CONTRACT_SEEN=' '
    while IFS= read -r SMART_CONTRACT_LINE || [ -n "$SMART_CONTRACT_LINE" ]; do
        case "$SMART_CONTRACT_LINE" in
            ""|\#*) continue ;;
            [A-Z0-9_]*=*) ;;
            *) return 1 ;;
        esac
        SMART_CONTRACT_KEY=${SMART_CONTRACT_LINE%%=*}
        SMART_CONTRACT_VALUE=${SMART_CONTRACT_LINE#*=}
        case " $SMART_CONTRACT_REQUIRED_KEYS " in
            *" $SMART_CONTRACT_KEY "*) ;;
            *) return 1 ;;
        esac
        case "$SMART_CONTRACT_VALUE" in
            ""|*[!A-Za-z0-9._-]*) return 1 ;;
        esac
        case "$SMART_CONTRACT_SEEN" in
            *" $SMART_CONTRACT_KEY "*) return 1 ;;
        esac
        SMART_CONTRACT_SEEN="$SMART_CONTRACT_SEEN$SMART_CONTRACT_KEY "
        printf -v "$SMART_CONTRACT_KEY" '%s' "$SMART_CONTRACT_VALUE"
    done <"$SMART_ARTIFACT_CONTRACT_PATH"

    for SMART_CONTRACT_KEY in $SMART_CONTRACT_REQUIRED_KEYS; do
        case "$SMART_CONTRACT_SEEN" in
            *" $SMART_CONTRACT_KEY "*) ;;
            *) return 1 ;;
        esac
        eval "SMART_CONTRACT_VALUE=\${$SMART_CONTRACT_KEY-}"
        [ -n "$SMART_CONTRACT_VALUE" ] || return 1
    done

    [ "$ARTIFACT_CONTRACT_VERSION" = smart-remarkable-artifacts-v2 ] || return 1
    [ "$SELECTION_PROTOCOL_VERSION" = smart-selection-v3 ] || return 1
    case "$DEVICE_SERIAL" in *[!0-9A-F]*) return 1 ;; esac
    [ "${#DEVICE_SERIAL}" -eq 16 ] || return 1
    [[ "$FIRMWARE_VERSION" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || return 1
    case "$FIRMWARE_BUILD" in *[!0-9]*) return 1 ;; esac
    [ "${#FIRMWARE_BUILD}" -eq 14 ] || return 1
    case "$XOCHITL_BUILD_ID" in *[!0-9a-f]*) return 1 ;; esac
    [ "${#XOCHITL_BUILD_ID}" -eq 40 ] || return 1
    case "$SCENE_SELECTION_HANDLER_RESOURCE_HASH$DEVICE_SCENE_VIEW_RESOURCE_HASH$SELECTION_CONTEXTUAL_MENU_RESOURCE_HASH" in
        *[!0-9]*) return 1 ;;
    esac

    for SMART_CONTRACT_VALUE in \
        "$XOCHITL_SHA256" "$HASHTAB_SHA256" "$XOVI_SHA256" "$QRR_SHA256" \
        "$MESSAGE_BROKER_SHA256" "$APPLOAD_SHA256" "$STOCK_SCRIPT_SHA256" \
        "$XOVI_XOCHITL_SERVICE_CONF_SHA256" "$ACTIVE_XOVI_DROPIN_SHA256" \
        "$XOCHITL_UNIT_SHA256" "$XOCHITL_STOCK_OVERRIDE_SHA256" \
        "$PEN_LAYER_MEMORY_QMD_SHA256" "$QUICK_SETTINGS_TIMER_QMD_SHA256" \
        "$BETTER_TOC_QMD_SHA256" "$BETTER_TOC_COLLAPSE_QMD_SHA256" \
        "$GESTIK_QMD_SHA256" "$GHOSTBUSTER_QMD_SHA256" \
        "$TOC_FROM_SELECTION_QMD_SHA256" "$PREVIOUS_BUTTON_QMD_SHA256" \
        "$LEGACY_BUTTON_QMD_SHA256" "$V2_MIGRATION_BUTTON_QMD_SHA256" \
        "$INERT_SOURCE_QMD_SHA256" \
        "$INERT_BUTTON_QMD_SHA256"
    do
        smart_contract_is_sha256 "$SMART_CONTRACT_VALUE" || return 1
    done
    for SMART_CONTRACT_VALUE in \
        "$SOURCE_QMD_SHA256" "$BUTTON_QMD_SHA256" \
        "$SMART_REMARKABLE_SHA256" "$APPLOAD_LAUNCHER_SHA256" \
        "$RUN_ARMED_ONCE_SHA256" "$SELECTION_PROTOCOL_SHA256"
    do
        smart_contract_is_hash_or_unresolved "$SMART_CONTRACT_VALUE" || return 1
    done
    [ "$PREVIOUS_BUTTON_QMD_SHA256" != "$LEGACY_BUTTON_QMD_SHA256" ] || return 1
    [ "$LEGACY_BUTTON_QMD_SHA256" != "$V2_MIGRATION_BUTTON_QMD_SHA256" ] || return 1
    [ "$LEGACY_BUTTON_QMD_SHA256" != "$INERT_BUTTON_QMD_SHA256" ] || return 1
    [ "$V2_MIGRATION_BUTTON_QMD_SHA256" != "$INERT_BUTTON_QMD_SHA256" ] || return 1
}

smart_contract_require_complete() {
    for SMART_CONTRACT_VALUE in \
        "$SOURCE_QMD_SHA256" "$BUTTON_QMD_SHA256" \
        "$SMART_REMARKABLE_SHA256" "$APPLOAD_LAUNCHER_SHA256" \
        "$RUN_ARMED_ONCE_SHA256" "$SELECTION_PROTOCOL_SHA256"
    do
        smart_contract_is_sha256 "$SMART_CONTRACT_VALUE" || return 1
    done
    [ "$LEGACY_BUTTON_QMD_SHA256" != "$INERT_BUTTON_QMD_SHA256" ] || return 1
    [ "$LEGACY_BUTTON_QMD_SHA256" != "$BUTTON_QMD_SHA256" ] || return 1
    [ "$V2_MIGRATION_BUTTON_QMD_SHA256" != "$BUTTON_QMD_SHA256" ] || return 1
    [ "$INERT_BUTTON_QMD_SHA256" != "$BUTTON_QMD_SHA256" ] || return 1
}

smart_contract_classify_qmd_sha() {
    case "$1" in
        absent) printf '%s\n' absent ;;
        "$LEGACY_BUTTON_QMD_SHA256") printf '%s\n' legacy-functional ;;
        "$V2_MIGRATION_BUTTON_QMD_SHA256") printf '%s\n' v2-migration-functional ;;
        "$INERT_BUTTON_QMD_SHA256") printf '%s\n' new-inert ;;
        "$BUTTON_QMD_SHA256")
            smart_contract_is_sha256 "$BUTTON_QMD_SHA256" || return 1
            printf '%s\n' new-functional
            ;;
        *) return 1 ;;
    esac
}

smart_contract_file_is_exact() {
    SMART_CONTRACT_FILE=$1
    SMART_CONTRACT_EXPECTED_SHA=$2
    SMART_CONTRACT_EXPECTED_MODE=$3
    [ -f "$SMART_CONTRACT_FILE" ] || return 1
    [ ! -L "$SMART_CONTRACT_FILE" ] || return 1
    [ "$(stat -c %u:%g:%a "$SMART_CONTRACT_FILE")" = "0:0:$SMART_CONTRACT_EXPECTED_MODE" ] || return 1
    [ "$(sha256sum "$SMART_CONTRACT_FILE" | cut -d' ' -f1)" = "$SMART_CONTRACT_EXPECTED_SHA" ] || return 1
}

smart_contract_installed_client_is_exact() {
    SMART_CONTRACT_APP_ROOT=$1
    [ -d "$SMART_CONTRACT_APP_ROOT" ] || return 1
    [ ! -L "$SMART_CONTRACT_APP_ROOT" ] || return 1
    [ "$(stat -c %u:%g:%a "$SMART_CONTRACT_APP_ROOT")" = 0:0:755 ] || return 1
    smart_contract_file_is_exact \
        "$SMART_CONTRACT_APP_ROOT/smart_remarkable" \
        "$SMART_REMARKABLE_SHA256" 755 || return 1
    smart_contract_file_is_exact \
        "$SMART_CONTRACT_APP_ROOT/appload-launch.sh" \
        "$APPLOAD_LAUNCHER_SHA256" 755 || return 1
    smart_contract_file_is_exact \
        "$SMART_CONTRACT_APP_ROOT/scripts/run-armed-once.sh" \
        "$RUN_ARMED_ONCE_SHA256" 755 || return 1
    smart_contract_file_is_exact \
        "$SMART_CONTRACT_APP_ROOT/scripts/selection-protocol.sh" \
        "$SELECTION_PROTOCOL_SHA256" 755 || return 1
    [ -f "$SMART_CONTRACT_APP_ROOT/compatibility.env" ] || return 1
    [ ! -L "$SMART_CONTRACT_APP_ROOT/compatibility.env" ] || return 1
    [ "$(stat -c %u:%g:%a "$SMART_CONTRACT_APP_ROOT/compatibility.env")" = 0:0:644 ] || return 1
    cmp -s "$SMART_ARTIFACT_CONTRACT_PATH" "$SMART_CONTRACT_APP_ROOT/compatibility.env" ||
        return 1
    [ -f "$SMART_CONTRACT_APP_ROOT/STAGED-FILES.sha256" ] || return 1
    [ ! -L "$SMART_CONTRACT_APP_ROOT/STAGED-FILES.sha256" ] || return 1
    [ "$(stat -c %u:%g:%a "$SMART_CONTRACT_APP_ROOT/STAGED-FILES.sha256")" = 0:0:644 ] ||
        return 1
    (cd "$SMART_CONTRACT_APP_ROOT" && sha256sum -c STAGED-FILES.sha256 >/dev/null)
}
