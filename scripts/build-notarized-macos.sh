#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="SkyInclude Browser"
APP_BUNDLE_NAME="${APP_NAME}.app"
PRODUCT_NAME="SkyInclude Browser"
VERSION="$(node -p "require('./package.json').version")"
NOTARY_MAX_ATTEMPTS="${NOTARY_MAX_ATTEMPTS:-90}"
NOTARY_SLEEP_SECONDS="${NOTARY_SLEEP_SECONDS:-60}"

require_env() {
    local name="$1"
    if [[ -z "${!name:-}" ]]; then
        echo "Missing required environment variable: ${name}" >&2
        exit 1
    fi
}

if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "macOS notarization must run on macOS." >&2
    exit 1
fi

require_env "APPLE_ID"
require_env "APPLE_APP_SPECIFIC_PASSWORD"
require_env "APPLE_TEAM_ID"

rm -rf dist
mkdir -p dist/notary dist/dmg-stage

echo "Building signed macOS app bundles for ${PRODUCT_NAME} ${VERSION}"
npx electron-builder --mac dir --x64 --publish=never
npx electron-builder --mac dir --arm64 --publish=never

notary_json_value() {
    local file="$1"
    local key="$2"
    node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const value = data[process.argv[2]];
if (value === undefined || value === null) process.exit(1);
console.log(value);
" "$file" "$key"
}

notarize_app() {
    local app_path="$1"
    local arch="$2"
    local zip_path="dist/notary/${PRODUCT_NAME}-${VERSION}-${arch}.zip"
    local submit_output="dist/notary/${arch}-submit.json"
    local info_output="dist/notary/${arch}-info.json"
    local log_output="dist/notary/${arch}-notary-log.json"

    echo "Verifying code signature before notarization: ${app_path}"
    codesign --verify --deep --strict --verbose=2 "${app_path}"

    echo "Creating notarization zip: ${zip_path}"
    rm -f "${zip_path}"
    ditto -c -k --sequesterRsrc --keepParent "${app_path}" "${zip_path}"

    echo "Submitting ${arch} app for notarization"
    xcrun notarytool submit "${zip_path}" \
        --apple-id "${APPLE_ID}" \
        --password "${APPLE_APP_SPECIFIC_PASSWORD}" \
        --team-id "${APPLE_TEAM_ID}" \
        --output-format json | tee "${submit_output}"

    local submission_id
    submission_id="$(notary_json_value "${submit_output}" id)"
    echo "Notary submission ID (${arch}): ${submission_id}"

    local status=""
    local attempt=1
    while [[ "${attempt}" -le "${NOTARY_MAX_ATTEMPTS}" ]]; do
        echo "Polling notarization status for ${arch}, attempt ${attempt}/${NOTARY_MAX_ATTEMPTS}"

        if xcrun notarytool info "${submission_id}" \
            --apple-id "${APPLE_ID}" \
            --password "${APPLE_APP_SPECIFIC_PASSWORD}" \
            --team-id "${APPLE_TEAM_ID}" \
            --output-format json > "${info_output}"; then
            cat "${info_output}"
            status="$(notary_json_value "${info_output}" status || true)"
        else
            echo "notarytool info failed; retrying after ${NOTARY_SLEEP_SECONDS}s" >&2
            status=""
        fi

        case "${status}" in
            Accepted)
                echo "Notarization accepted for ${arch}"
                break
                ;;
            Invalid|Rejected)
                echo "Notarization ${status} for ${arch}; fetching notary log" >&2
                xcrun notarytool log "${submission_id}" \
                    --apple-id "${APPLE_ID}" \
                    --password "${APPLE_APP_SPECIFIC_PASSWORD}" \
                    --team-id "${APPLE_TEAM_ID}" \
                    --output-format json | tee "${log_output}" || true
                exit 1
                ;;
            *)
                sleep "${NOTARY_SLEEP_SECONDS}"
                ;;
        esac

        attempt=$((attempt + 1))
    done

    if [[ "${status}" != "Accepted" ]]; then
        echo "Timed out waiting for notarization acceptance for ${arch}; fetching latest notary log if available" >&2
        xcrun notarytool log "${submission_id}" \
            --apple-id "${APPLE_ID}" \
            --password "${APPLE_APP_SPECIFIC_PASSWORD}" \
            --team-id "${APPLE_TEAM_ID}" \
            --output-format json | tee "${log_output}" || true
        exit 1
    fi

    echo "Stapling notarization ticket for ${arch}: ${app_path}"
    xcrun stapler staple "${app_path}"
    xcrun stapler validate "${app_path}"

    echo "Verifying Gatekeeper assessment for ${arch}"
    spctl --assess --type execute --verbose "${app_path}"
}

create_dmg() {
    local app_path="$1"
    local arch="$2"
    local dmg_path="dist/${PRODUCT_NAME}-${VERSION}-${arch}.dmg"
    local stage_dir="dist/dmg-stage/${arch}"

    rm -rf "${stage_dir}" "${dmg_path}"
    mkdir -p "${stage_dir}"
    cp -R "${app_path}" "${stage_dir}/${APP_BUNDLE_NAME}"
    ln -s /Applications "${stage_dir}/Applications"

    echo "Creating DMG: ${dmg_path}"
    hdiutil create \
        -volname "${PRODUCT_NAME}" \
        -srcfolder "${stage_dir}" \
        -ov \
        -format UDZO \
        "${dmg_path}"

    hdiutil verify "${dmg_path}"
}

declare -A APP_PATHS=(
    ["x64"]="dist/mac/${APP_BUNDLE_NAME}"
    ["arm64"]="dist/mac-arm64/${APP_BUNDLE_NAME}"
)

for arch in x64 arm64; do
    app_path="${APP_PATHS[$arch]}"
    if [[ ! -d "${app_path}" ]]; then
        echo "Expected app bundle not found: ${app_path}" >&2
        exit 1
    fi

    notarize_app "${app_path}" "${arch}"
    create_dmg "${app_path}" "${arch}"
done

echo "Signed, notarized, stapled, and packaged macOS DMGs:"
ls -lh dist/*.dmg
