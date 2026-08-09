#!/bin/bash
# Wrapper so clasp works without node in PATH
exec /opt/homebrew/bin/node /opt/homebrew/bin/clasp "$@"
