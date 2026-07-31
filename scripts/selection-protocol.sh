#!/bin/sh
# Strict, side-effect-free parsers for the stock-selection AppLoad protocol.
# This file is sourced by the root-owned launcher and directly by local tests.

smart_selection_is_canonical_decimal() {
    case "$1" in
        ''|*[!0-9]*|0[0-9]*) return 1 ;;
        *) return 0 ;;
    esac
}

smart_selection_payload_chars_are_safe() {
    case "$1" in
        ''|*[!a-z0-9_,]*|*,,*) return 1 ;;
        *) return 0 ;;
    esac
}

smart_selection_fields_are_valid() {
    SMART_SELECTION_KIND=$1
    SMART_SELECTION_ORIENTATION=$2
    SMART_SELECTION_X0=$3
    SMART_SELECTION_Y0=$4
    SMART_SELECTION_X1=$5
    SMART_SELECTION_Y1=$6

    case "$SMART_SELECTION_KIND" in
        ink|image|mixed) ;;
        *) return 1 ;;
    esac
    case "$SMART_SELECTION_ORIENTATION" in
        normal|rot180) ;;
        *) return 1 ;;
    esac
    for SMART_SELECTION_VALUE in \
        "$SMART_SELECTION_X0" \
        "$SMART_SELECTION_Y0" \
        "$SMART_SELECTION_X1" \
        "$SMART_SELECTION_Y1"
    do
        # The maximum legal coordinate is 1000000. Bound digit count before
        # BusyBox test performs integer conversion so an attacker-controlled,
        # all-digit argument cannot overflow or produce a parser diagnostic.
        [ "${#SMART_SELECTION_VALUE}" -le 7 ] || return 1
        smart_selection_is_canonical_decimal \
            "$SMART_SELECTION_VALUE" || return 1
    done
    [ "$SMART_SELECTION_X0" -le 1000000 ] || return 1
    [ "$SMART_SELECTION_Y0" -le 1000000 ] || return 1
    [ "$SMART_SELECTION_X1" -le 1000000 ] || return 1
    [ "$SMART_SELECTION_Y1" -le 1000000 ] || return 1
    [ "$SMART_SELECTION_X0" -lt "$SMART_SELECTION_X1" ] || return 1
    [ "$SMART_SELECTION_Y0" -lt "$SMART_SELECTION_Y1" ] || return 1

    SMART_SELECTION_SNAPSHOT="v2,$SMART_SELECTION_KIND,$SMART_SELECTION_ORIENTATION,$SMART_SELECTION_X0,$SMART_SELECTION_Y0,$SMART_SELECTION_X1,$SMART_SELECTION_Y1"
}

# QML request: v2,mode,kind,orientation,x0,y0,x1,y1,captured_ms
smart_parse_selection_request() {
    SMART_SELECTION_PAYLOAD=$1
    smart_selection_payload_chars_are_safe \
        "$SMART_SELECTION_PAYLOAD" || return 1

    SMART_SELECTION_SAVED_IFS=$IFS
    IFS=,
    set -- $SMART_SELECTION_PAYLOAD
    IFS=$SMART_SELECTION_SAVED_IFS
    [ "$#" -eq 9 ] || return 1
    [ "$1" = v2 ] || return 1
    SMART_SELECTION_MODE=$2
    case "$SMART_SELECTION_MODE" in
        write_back|whatsapp_only) ;;
        *) return 1 ;;
    esac
    smart_selection_fields_are_valid "$3" "$4" "$5" "$6" "$7" "$8" || return 1
    SMART_SELECTION_CAPTURED_MS=$9
    smart_selection_is_canonical_decimal \
        "$SMART_SELECTION_CAPTURED_MS" || return 1
    [ "${#SMART_SELECTION_CAPTURED_MS}" -le 13 ] || return 1
    [ "$SMART_SELECTION_CAPTURED_MS" -gt 0 ] || return 1
}

# QML acknowledgement: v2,kind,orientation,x0,y0,x1,y1
smart_parse_selection_snapshot() {
    SMART_SELECTION_PAYLOAD=$1
    smart_selection_payload_chars_are_safe \
        "$SMART_SELECTION_PAYLOAD" || return 1

    SMART_SELECTION_SAVED_IFS=$IFS
    IFS=,
    set -- $SMART_SELECTION_PAYLOAD
    IFS=$SMART_SELECTION_SAVED_IFS
    [ "$#" -eq 7 ] || return 1
    [ "$1" = v2 ] || return 1
    smart_selection_fields_are_valid "$2" "$3" "$4" "$5" "$6" "$7"
}

# Launcher/Rust descriptor: v2,nonce,kind,orientation,x0,y0,x1,y1,captured_ms
smart_parse_active_selection_descriptor() {
    SMART_SELECTION_PAYLOAD=$1
    smart_selection_payload_chars_are_safe \
        "$SMART_SELECTION_PAYLOAD" || return 1

    SMART_SELECTION_SAVED_IFS=$IFS
    IFS=,
    set -- $SMART_SELECTION_PAYLOAD
    IFS=$SMART_SELECTION_SAVED_IFS
    [ "$#" -eq 9 ] || return 1
    [ "$1" = v2 ] || return 1
    SMART_SELECTION_NONCE=$2
    [ "${#SMART_SELECTION_NONCE}" -eq 64 ] || return 1
    case "$SMART_SELECTION_NONCE" in
        *[!0-9a-f]*) return 1 ;;
    esac
    smart_selection_fields_are_valid "$3" "$4" "$5" "$6" "$7" "$8" || return 1
    SMART_SELECTION_CAPTURED_MS=$9
    smart_selection_is_canonical_decimal \
        "$SMART_SELECTION_CAPTURED_MS" || return 1
    [ "${#SMART_SELECTION_CAPTURED_MS}" -le 13 ] || return 1
    [ "$SMART_SELECTION_CAPTURED_MS" -gt 0 ] || return 1
    SMART_SELECTION_DESCRIPTOR="v2,$SMART_SELECTION_NONCE,${SMART_SELECTION_SNAPSHOT#v2,},$SMART_SELECTION_CAPTURED_MS"
    SMART_SELECTION_ACK="v2,$SMART_SELECTION_NONCE,${SMART_SELECTION_SNAPSHOT#v2,}"
}

smart_generate_selection_nonce() {
    SMART_SELECTION_NONCE=$(
        /usr/bin/od -An -N32 -tx1 /dev/urandom | \
            /usr/bin/tr -d ' \n'
    ) || return 1
    [ "${#SMART_SELECTION_NONCE}" -eq 64 ] || return 1
    case "$SMART_SELECTION_NONCE" in
        *[!0-9a-f]*) return 1 ;;
    esac
}

smart_capture_epoch_ms() {
    SMART_SELECTION_EPOCH_SECONDS=$(/bin/date +%s) || return 1
    smart_selection_is_canonical_decimal \
        "$SMART_SELECTION_EPOCH_SECONDS" || return 1
    SMART_SELECTION_CAPTURED_MS="${SMART_SELECTION_EPOCH_SECONDS}000"
    [ "${#SMART_SELECTION_CAPTURED_MS}" -le 13 ] || return 1
}
