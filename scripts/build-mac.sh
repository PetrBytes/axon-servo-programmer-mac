#!/bin/bash
# Build the signed (ad-hoc) Apple Silicon app and a compressed DMG. Runs on macOS.
set -euo pipefail
VER="${1:?usage: build-mac.sh <version>}"
NAME="Axon Servo Programmer"

npx @electron/packager . "$NAME" --platform=darwin --arch=arm64 \
  --icon=build/icon.icns --app-bundle-id=nz.peter.axonprogrammer --app-version="$VER" \
  --app-category-type=public.app-category.developer-tools --out=dist --overwrite --asar \
  --ignore='^/(test|build|dist|scripts|release|release-notes|\.github|README\.md)($|/)' \
  --extend-info=build/extra.plist

APP="dist/$NAME-darwin-arm64/$NAME.app"

# Drop Chromium UI translations the app doesn't use (~40 MB).
find "$APP/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources" \
  -maxdepth 1 -name '*.lproj' ! -name 'en.lproj' ! -name 'en_GB.lproj' -exec rm -rf {} +

# Ad-hoc sign the whole bundle so macOS sees a valid, sealed app.
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

STAGE="$(mktemp -d)"
ditto "$APP" "$STAGE/$NAME.app"
ln -s /Applications "$STAGE/Applications"
cp "build/READ ME FIRST.txt" "$STAGE/READ ME FIRST.txt"

mkdir -p release
DMG="release/Axon-Servo-Programmer-$VER-arm64.dmg"
hdiutil create -volname "$NAME" -srcfolder "$STAGE" -ov -fs HFS+ -format ULMO "$DMG"
hdiutil verify "$DMG"
ls -lh "$DMG"
