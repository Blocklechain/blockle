#!/usr/bin/env bash
export LC_ALL=C
set -e -o pipefail

# Determine the maximum number of jobs to run simultaneously (overridable by
# environment)
MAX_JOBS="${MAX_JOBS:-$(nproc)}"

# Download the depends sources now as we won't have internet access in the build
# container
make -C "${PWD}/depends" -j"$MAX_JOBS" download ${V:+V=1} ${SOURCES_PATH:+SOURCES_PATH="$SOURCES_PATH"}

# Determine the reference time used for determinism (overridable by environment)
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git log --format=%at -1)}"

time-machine() {
    guix time-machine --url=https://github.com/dongcarl/guix.git \
                      --commit=b3a7c72c8b2425f8ddb0fc6e3b1caeed40f86dee \
                      -- "$@"
}

# Deterministically build Blockle Core for HOSTs (overriable by environment)
for host in ${HOSTS=x86_64-linux-gnu arm-linux-gnueabihf aarch64-linux-gnu riscv64-linux-gnu}; do

    # Display proper warning when the user interrupts the build
    trap 'echo "** INT received while building ${host}, you may want to clean up the relevant output and distsrc-* directories before rebuilding"' INT

    # Run the build script 'contrib/guix/libexec/build.sh' in the build
    # container specified by 'contrib/guix/manifest.scm'
    # shellcheck disable=SC2086
    time-machine environment --manifest="${PWD}/contrib/guix/manifest.scm" \
                             --container \
                             --pure \
                             --no-cwd \
                             --share="$PWD"=/blockle \
                             ${SOURCES_PATH:+--share="$SOURCES_PATH"} \
                             ${ADDITIONAL_GUIX_ENVIRONMENT_FLAGS} \
                             -- env HOST="$host" \
                                    MAX_JOBS="$MAX_JOBS" \
                                    SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:?unable to determine value}" \
                                    ${V:+V=1} \
                                    ${SOURCES_PATH:+SOURCES_PATH="$SOURCES_PATH"} \
                                  bash -c "cd /blockle && bash contrib/guix/libexec/build.sh"

done
