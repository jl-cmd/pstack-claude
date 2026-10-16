#!/bin/sh
for python in python3 python; do
  if "$python" -c 'import sys; sys.exit(sys.version_info[0] != 3)' > /dev/null 2>&1; then
    exec "$python" "${0%/*}/bro-log.py"
  fi
done
echo "bro-log: neither python3 nor python runs Python 3 on PATH" >&2
