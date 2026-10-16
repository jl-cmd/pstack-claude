#!/bin/sh
for python in python3 python; do
  if "$python" -c '' > /dev/null 2>&1; then
    exec "$python" "${0%/*}/bro-log.py"
  fi
done
echo "bro-log: neither python3 nor python runs on PATH" >&2
