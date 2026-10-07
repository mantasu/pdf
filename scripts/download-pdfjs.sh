#!/bin/bash
# Download the pinned pdf.js legacy distribution into resources/pdf.js.
# Adapted from https://github.com/mathematic-inc/vscode-pdf (Apache-2.0).
set -euo pipefail

cd "$(dirname "$0")/.."

version_info=$(cat pdfjs.version)
version=${version_info%%@*}
expected_hash=${version_info#*@}

if [ -f resources/pdf.js/BUILD_INFO ] && grep -q "^version=${version}$" resources/pdf.js/BUILD_INFO; then
    echo "pdf.js ${version} already present, skipping download"
    exit 0
fi

rm -rf resources/pdf.js
mkdir -p resources/pdf.js

echo "Downloading pdf.js ${version}..."
curl -fL -o /tmp/pdfjs.zip "https://github.com/mozilla/pdf.js/releases/download/v${version}/pdfjs-${version}-legacy-dist.zip"

actual_hash=$(sha1sum /tmp/pdfjs.zip | awk '{ print $1 }')
if [ "$actual_hash" != "$expected_hash" ]; then
    echo "Hash mismatch: expected $expected_hash, but got $actual_hash" >&2
    rm /tmp/pdfjs.zip
    exit 1
fi

unzip -q /tmp/pdfjs.zip -d resources/pdf.js
rm /tmp/pdfjs.zip

# Drop source maps, they are not shipped and only waste space.
find resources/pdf.js -name '*.map' -delete

echo "version=${version}" > resources/pdf.js/BUILD_INFO

# The upstream viewer.html ships a CSP meta tag which is too strict for the
# VS Code webview. Remove it; our extension supplies a webview-safe CSP.
perl -0pi -e 's/<meta[^>]*?http-equiv=["\x27]Content-Security-Policy["\x27][^>]*?>\s*//gis' resources/pdf.js/web/viewer.html

echo "pdf.js ${version} ready in resources/pdf.js"
