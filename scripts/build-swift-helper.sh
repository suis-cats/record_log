#!/bin/zsh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$PROJECT_ROOT/bin"
xcrun swiftc -O -framework CoreGraphics -framework ApplicationServices "$PROJECT_ROOT/swift/InputCollector.swift" -o "$PROJECT_ROOT/bin/input-collector-macos"
file "$PROJECT_ROOT/bin/input-collector-macos"
