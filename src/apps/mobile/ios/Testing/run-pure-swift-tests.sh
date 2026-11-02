#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
IOS_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
OUTPUT_DIR=$(mktemp -d "${TMPDIR:-/tmp}/openbitfun-ios-pure-swift-tests.XXXXXX")
trap 'rm -rf "$OUTPUT_DIR"' EXIT HUP INT TERM

xcrun --sdk macosx swiftc \
  "$IOS_DIR/OpenBitFun/Infrastructure/RemoteAuthorityGate.swift" \
  "$SCRIPT_DIR/RemoteAuthorityGateTests.swift" \
  -o "$OUTPUT_DIR/remote-authority-gate-tests"
"$OUTPUT_DIR/remote-authority-gate-tests"

xcrun --sdk macosx swiftc \
  "$IOS_DIR/OpenBitFun/Infrastructure/AccountFailureCopy.swift" \
  "$SCRIPT_DIR/AccountFailureCopyTests.swift" \
  -o "$OUTPUT_DIR/account-failure-copy-tests"
"$OUTPUT_DIR/account-failure-copy-tests"

xcrun --sdk macosx swiftc \
  "$IOS_DIR/OpenBitFun/Infrastructure/RemoteHomePresentation.swift" \
  "$SCRIPT_DIR/RemoteHomePresentationTests.swift" \
  -o "$OUTPUT_DIR/remote-home-presentation-tests"
"$OUTPUT_DIR/remote-home-presentation-tests"


xcrun --sdk macosx swiftc \
  "$IOS_DIR/OpenBitFun/Infrastructure/StreamingTextState.swift" \
  "$SCRIPT_DIR/StreamingTextStateTests.swift" \
  -o "$OUTPUT_DIR/streaming-text-state-tests"
"$OUTPUT_DIR/streaming-text-state-tests"

xcrun --sdk macosx swiftc \
  "$IOS_DIR/OpenBitFun/Infrastructure/ComposerDismissGesture.swift" \
  "$SCRIPT_DIR/ComposerDismissGestureTests.swift" \
  -o "$OUTPUT_DIR/composer-dismiss-gesture-tests"
"$OUTPUT_DIR/composer-dismiss-gesture-tests"

xcrun --sdk macosx swiftc \
  "$IOS_DIR/OpenBitFun/Presentation/Models/MobilePresentationModels.swift" \
  "$SCRIPT_DIR/MobileProcessGroupTests.swift" \
  -o "$OUTPUT_DIR/mobile-process-group-tests"
"$OUTPUT_DIR/mobile-process-group-tests"

printf '%s\n' 'iOS pure Swift focused tests passed.'

xcrun --sdk macosx swiftc \
  "$IOS_DIR/OpenBitFun/Infrastructure/StartupRevealPreference.swift" \
  "$SCRIPT_DIR/StartupRevealPreferenceTests.swift" \
  -o "$OUTPUT_DIR/startup-reveal-preference-tests"
"$OUTPUT_DIR/startup-reveal-preference-tests"

xcrun --sdk macosx swiftc \
  "$IOS_DIR/OpenBitFun/Features/Chat/HistoryPageArrivalTracker.swift" \
  "$SCRIPT_DIR/HistoryPageArrivalTrackerTests.swift" \
  -o "$OUTPUT_DIR/history-page-arrival-tracker-tests"
"$OUTPUT_DIR/history-page-arrival-tracker-tests"
