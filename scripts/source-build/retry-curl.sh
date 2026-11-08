#!/usr/bin/env bash
# curl --retry handles timeouts and selected HTTP statuses, but not common
# transport failures such as CURLE_RECV_ERROR (56). Retry only known network
# transport exit codes here; permanent HTTP, TLS, and local-file errors fail fast.
set -u

if [[ "$#" -eq 0 ]]; then
  echo "usage: retry-curl.sh <curl arguments>" >&2
  exit 2
fi

max_attempts=8
max_delay=30
last_status=1

for attempt in $(seq 1 "$max_attempts"); do
  if curl "$@"; then
    exit 0
  else
    last_status=$?
  fi

  case "$last_status" in
    5|6|7|18|52|55|56) ;;
    *) exit "$last_status" ;;
  esac

  if [[ "$attempt" -eq "$max_attempts" ]]; then
    break
  fi

  delay=$((1 << (attempt - 1)))
  if [[ "$delay" -gt "$max_delay" ]]; then delay=$max_delay; fi
  echo "retry-curl: transient transport error $last_status; retrying in ${delay}s (attempt $((attempt + 1))/$max_attempts)" >&2
  sleep "$delay"
done

echo "retry-curl: transport error $last_status persisted after $max_attempts attempts" >&2
exit "$last_status"
