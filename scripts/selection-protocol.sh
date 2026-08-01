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
        ''|*[!a-z0-9_,-]*|*,,*) return 1 ;;
        *) return 0 ;;
    esac
}

smart_selection_bounds_are_valid() {
    for SMART_SELECTION_VALUE in "$1" "$2" "$3" "$4"
    do
        [ "${#SMART_SELECTION_VALUE}" -le 7 ] || return 1
        smart_selection_is_canonical_decimal \
            "$SMART_SELECTION_VALUE" || return 1
        [ "$SMART_SELECTION_VALUE" -le 1000000 ] || return 1
    done
    [ "$1" -lt "$3" ] || return 1
    [ "$2" -lt "$4" ] || return 1
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
    # Bound digit count before BusyBox test performs integer conversion so an
    # attacker-controlled all-digit argument cannot overflow its parser.
    smart_selection_bounds_are_valid \
        "$SMART_SELECTION_X0" "$SMART_SELECTION_Y0" \
        "$SMART_SELECTION_X1" "$SMART_SELECTION_Y1" || return 1

    SMART_SELECTION_SNAPSHOT="v2,$SMART_SELECTION_KIND,$SMART_SELECTION_ORIENTATION,$SMART_SELECTION_X0,$SMART_SELECTION_Y0,$SMART_SELECTION_X1,$SMART_SELECTION_Y1"
}

smart_selection_document_id_is_valid() {
    [ "${#1}" -eq 36 ] || return 1
    case "$1" in
        ????????-????-????-????-????????????) ;;
        *) return 1 ;;
    esac
    case "$1" in
        *[!0-9a-f-]*) return 1 ;;
    esac
}

smart_selection_page_id_hex_is_valid() {
    SMART_SELECTION_HEX_REST=$1
    [ "${#SMART_SELECTION_HEX_REST}" -ge 2 ] || return 1
    [ "${#SMART_SELECTION_HEX_REST}" -le 256 ] || return 1
    [ $(( ${#SMART_SELECTION_HEX_REST} % 2 )) -eq 0 ] || return 1
    case "$SMART_SELECTION_HEX_REST" in
        *[!0-9a-f]*) return 1 ;;
    esac

    SMART_SELECTION_HEX_FIRST=1
    while [ -n "$SMART_SELECTION_HEX_REST" ]; do
        SMART_SELECTION_HEX_TAIL=${SMART_SELECTION_HEX_REST#??}
        SMART_SELECTION_HEX_PAIR=${SMART_SELECTION_HEX_REST%"$SMART_SELECTION_HEX_TAIL"}
        if [ "$SMART_SELECTION_HEX_FIRST" -eq 1 ]; then
            case "$SMART_SELECTION_HEX_PAIR" in
                3[0-9]|4[1-9a-f]|5[0-9a]|6[1-9a-f]|7[0-9a]) ;;
                *) return 1 ;;
            esac
            SMART_SELECTION_HEX_FIRST=0
        else
            case "$SMART_SELECTION_HEX_PAIR" in
                2d|2e|3a|3[0-9]|4[1-9a-f]|5[0-9a]|5f|6[1-9a-f]|7[0-9a]) ;;
                *) return 1 ;;
            esac
        fi
        SMART_SELECTION_HEX_REST=$SMART_SELECTION_HEX_TAIL
    done
}

smart_selection_page_fields_are_valid() {
    SMART_SELECTION_DOCUMENT_ID=$1
    SMART_SELECTION_PAGE_ID_HEX=$2
    SMART_SELECTION_PAGE_INDEX=$3
    SMART_SELECTION_PAGE_X0=$4
    SMART_SELECTION_PAGE_Y0=$5
    SMART_SELECTION_PAGE_X1=$6
    SMART_SELECTION_PAGE_Y1=$7
    SMART_SELECTION_PAGE_COMPLETENESS=$8

    smart_selection_document_id_is_valid \
        "$SMART_SELECTION_DOCUMENT_ID" || return 1
    smart_selection_page_id_hex_is_valid \
        "$SMART_SELECTION_PAGE_ID_HEX" || return 1
    smart_selection_is_canonical_decimal \
        "$SMART_SELECTION_PAGE_INDEX" || return 1
    [ "${#SMART_SELECTION_PAGE_INDEX}" -le 7 ] || return 1
    [ "$SMART_SELECTION_PAGE_INDEX" -le 1000000 ] || return 1
    smart_selection_bounds_are_valid \
        "$SMART_SELECTION_PAGE_X0" "$SMART_SELECTION_PAGE_Y0" \
        "$SMART_SELECTION_PAGE_X1" "$SMART_SELECTION_PAGE_Y1" || return 1
    case "$SMART_SELECTION_PAGE_COMPLETENESS" in
        full_page|viewport_only) ;;
        *) return 1 ;;
    esac
}

# QML request: v2 as before, or v3 with document/page/view context.
smart_parse_selection_request() {
    SMART_SELECTION_PAYLOAD=$1
    smart_selection_payload_chars_are_safe \
        "$SMART_SELECTION_PAYLOAD" || return 1

    SMART_SELECTION_SAVED_IFS=$IFS
    IFS=,
    set -- $SMART_SELECTION_PAYLOAD
    IFS=$SMART_SELECTION_SAVED_IFS
    case "$1:$#" in
        v2:9)
            SMART_SELECTION_MODE=$2
            smart_selection_fields_are_valid \
                "$3" "$4" "$5" "$6" "$7" "$8" || return 1
            SMART_SELECTION_CAPTURED_MS=$9
            ;;
        v3:17)
            SMART_SELECTION_MODE=$2
            smart_selection_fields_are_valid \
                "$3" "$4" "$5" "$6" "$7" "$8" || return 1
            smart_selection_page_fields_are_valid \
                "$9" "${10}" "${11}" "${12}" "${13}" "${14}" \
                "${15}" "${16}" || return 1
            SMART_SELECTION_SNAPSHOT="v3,$SMART_SELECTION_KIND,$SMART_SELECTION_ORIENTATION,$SMART_SELECTION_X0,$SMART_SELECTION_Y0,$SMART_SELECTION_X1,$SMART_SELECTION_Y1,$SMART_SELECTION_DOCUMENT_ID,$SMART_SELECTION_PAGE_ID_HEX,$SMART_SELECTION_PAGE_INDEX,$SMART_SELECTION_PAGE_X0,$SMART_SELECTION_PAGE_Y0,$SMART_SELECTION_PAGE_X1,$SMART_SELECTION_PAGE_Y1,$SMART_SELECTION_PAGE_COMPLETENESS"
            SMART_SELECTION_CAPTURED_MS=${17}
            ;;
        *) return 1 ;;
    esac
    case "$SMART_SELECTION_MODE" in
        write_back|whatsapp_only) ;;
        *) return 1 ;;
    esac
    smart_selection_is_canonical_decimal \
        "$SMART_SELECTION_CAPTURED_MS" || return 1
    [ "${#SMART_SELECTION_CAPTURED_MS}" -le 13 ] || return 1
    [ "$SMART_SELECTION_CAPTURED_MS" -gt 0 ] || return 1
}

# QML acknowledgement snapshot: v2, or v3 with exact page context.
smart_parse_selection_snapshot() {
    SMART_SELECTION_PAYLOAD=$1
    smart_selection_payload_chars_are_safe \
        "$SMART_SELECTION_PAYLOAD" || return 1

    SMART_SELECTION_SAVED_IFS=$IFS
    IFS=,
    set -- $SMART_SELECTION_PAYLOAD
    IFS=$SMART_SELECTION_SAVED_IFS
    case "$1:$#" in
        v2:7)
            smart_selection_fields_are_valid \
                "$2" "$3" "$4" "$5" "$6" "$7"
            ;;
        v3:15)
            smart_selection_fields_are_valid \
                "$2" "$3" "$4" "$5" "$6" "$7" || return 1
            smart_selection_page_fields_are_valid \
                "$8" "$9" "${10}" "${11}" "${12}" "${13}" \
                "${14}" "${15}" || return 1
            SMART_SELECTION_SNAPSHOT="v3,$SMART_SELECTION_KIND,$SMART_SELECTION_ORIENTATION,$SMART_SELECTION_X0,$SMART_SELECTION_Y0,$SMART_SELECTION_X1,$SMART_SELECTION_Y1,$SMART_SELECTION_DOCUMENT_ID,$SMART_SELECTION_PAGE_ID_HEX,$SMART_SELECTION_PAGE_INDEX,$SMART_SELECTION_PAGE_X0,$SMART_SELECTION_PAGE_Y0,$SMART_SELECTION_PAGE_X1,$SMART_SELECTION_PAGE_Y1,$SMART_SELECTION_PAGE_COMPLETENESS"
            ;;
        *) return 1 ;;
    esac
}

# Launcher/Rust descriptor: v2 as before, or nonce-bound v3 page context.
smart_parse_active_selection_descriptor() {
    SMART_SELECTION_PAYLOAD=$1
    smart_selection_payload_chars_are_safe \
        "$SMART_SELECTION_PAYLOAD" || return 1

    SMART_SELECTION_SAVED_IFS=$IFS
    IFS=,
    set -- $SMART_SELECTION_PAYLOAD
    IFS=$SMART_SELECTION_SAVED_IFS
    SMART_SELECTION_NONCE=$2
    [ "${#SMART_SELECTION_NONCE}" -eq 64 ] || return 1
    case "$SMART_SELECTION_NONCE" in
        *[!0-9a-f]*) return 1 ;;
    esac
    case "$1:$#" in
        v2:9)
            smart_selection_fields_are_valid \
                "$3" "$4" "$5" "$6" "$7" "$8" || return 1
            SMART_SELECTION_CAPTURED_MS=$9
            ;;
        v3:17)
            smart_selection_fields_are_valid \
                "$3" "$4" "$5" "$6" "$7" "$8" || return 1
            smart_selection_page_fields_are_valid \
                "$9" "${10}" "${11}" "${12}" "${13}" "${14}" \
                "${15}" "${16}" || return 1
            SMART_SELECTION_SNAPSHOT="v3,$SMART_SELECTION_KIND,$SMART_SELECTION_ORIENTATION,$SMART_SELECTION_X0,$SMART_SELECTION_Y0,$SMART_SELECTION_X1,$SMART_SELECTION_Y1,$SMART_SELECTION_DOCUMENT_ID,$SMART_SELECTION_PAGE_ID_HEX,$SMART_SELECTION_PAGE_INDEX,$SMART_SELECTION_PAGE_X0,$SMART_SELECTION_PAGE_Y0,$SMART_SELECTION_PAGE_X1,$SMART_SELECTION_PAGE_Y1,$SMART_SELECTION_PAGE_COMPLETENESS"
            SMART_SELECTION_CAPTURED_MS=${17}
            ;;
        *) return 1 ;;
    esac
    smart_selection_is_canonical_decimal \
        "$SMART_SELECTION_CAPTURED_MS" || return 1
    [ "${#SMART_SELECTION_CAPTURED_MS}" -le 13 ] || return 1
    [ "$SMART_SELECTION_CAPTURED_MS" -gt 0 ] || return 1
    SMART_SELECTION_DESCRIPTOR="$1,$SMART_SELECTION_NONCE,${SMART_SELECTION_SNAPSHOT#??,},$SMART_SELECTION_CAPTURED_MS"
    SMART_SELECTION_ACK="$1,$SMART_SELECTION_NONCE,${SMART_SELECTION_SNAPSHOT#??,}"
}

smart_generate_selection_nonce() {
    SMART_SELECTION_NONCE=$(
        /usr/bin/hexdump -n 32 -v -e '1/1 "%02x"' /dev/urandom
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
