#!/usr/bin/env bash

# Only retry the observed CloudKit transport loss. Missing/invalid tickets and
# every other exit code remain failures in both verification and recovery.
stapler_with_network_retry() {
  local attempt output exit_code
  for attempt in 1 2 3; do
    if output="$(xcrun stapler "$@" 2>&1)"; then
      printf '%s\n' "${output}"
      return 0
    else
      exit_code=$?
    fi
    printf '%s\n' "${output}" >&2
    if [[ "${exit_code}" -ne 68 || "${attempt}" -eq 3 ]] || \
       ! grep -Fq 'Error Domain=NSURLErrorDomain Code=-1005' <<<"${output}"; then
      return "${exit_code}"
    fi
    echo "Apple ticket service connection was lost; retrying stapler ${1} (${attempt}/3)." >&2
    sleep "$((attempt * 10))"
  done
}
