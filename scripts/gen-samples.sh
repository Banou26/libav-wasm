#!/usr/bin/env bash
set -euo pipefail

# Regenerate the test sample videos used by tests/playback.spec.ts. Outputs go to
# ./test-files/ (gitignored). Each frame burns in the current time in ms + frame number
# so visual inspection can spot stutter / dropped frames down to millisecond precision.
#
# Uses jrottenberg/ffmpeg (Ubuntu-based, ~600MB, includes x264 + x265 + DejaVu fonts).
# Run with: ./scripts/gen-samples.sh

cd "$(dirname "$0")/.."
OUTDIR="$(pwd)/test-files"
mkdir -p "$OUTDIR"

IMAGE="jrottenberg/ffmpeg:7-ubuntu"
DURATION=30
FPS=30

# resolution → "WIDTHxHEIGHT H264_BITRATE HEVC_BITRATE"
declare -A SPECS=(
  [720p]="1280x720  3M  2M"
  [1080p]="1920x1080 8M  5M"
  [1440p]="2560x1440 14M 9M"
  [2160p]="3840x2160 25M 18M"
)

FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf

gen() {
  local codec=$1 res=$2 bitrate=$3 outname=$4
  read -r dim _ _ <<<"${SPECS[$res]}"
  local height=${dim##*x}
  local fontsize=$((height / 12))
  local pad=$((height / 60))
  # `%{eif\:t*1000\:d}` shows the current time in milliseconds as an integer (the only
  # way to get ms precision via drawtext expressions). %{n} is the frame counter. The
  # surrounding single quotes are part of the filter syntax — they tell ffmpeg's filter
  # parser not to treat the colons inside `%{...}` as field separators.
  local text="'%{eif\\:t*1000\\:d}ms  f=%{n}'"
  echo "==> ${outname} (${codec} ${dim} @${bitrate})"
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$OUTDIR:/work" \
    "$IMAGE" \
    -y \
    -f lavfi -i "testsrc2=size=${dim}:rate=${FPS}:duration=${DURATION}" \
    -vf "drawtext=fontfile=${FONT}:text=${text}:fontsize=${fontsize}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=${pad}:x=${pad}:y=${pad}" \
    -c:v "$codec" -b:v "$bitrate" \
    -pix_fmt yuv420p \
    "/work/${outname}"
}

# Default samples used by the test suite. 1080p is a reasonable middle ground for the
# correctness tests; perf-focused tests should pick the resolution variants below.
gen libx264 1080p "$(echo "${SPECS[1080p]}" | awk '{print $2}')" sample-h264.mkv
gen libx265 1080p "$(echo "${SPECS[1080p]}" | awk '{print $3}')" sample-hevc.mkv

# Perf variants — HEVC only, since the H264 path is passthrough (no decode work in WASM)
# and wall time at every resolution is dominated by network + MSE, not codec.
for res in 720p 1440p 2160p; do
  gen libx265 "$res" "$(echo "${SPECS[$res]}" | awk '{print $3}')" "sample-hevc-${res}.mkv"
done

echo
echo "Generated under: ${OUTDIR}"
ls -lh "${OUTDIR}"/sample-*.mkv
