#!/usr/bin/env python3
"""Write ExportOptions.generated.plist from the profiles asc_profiles.py made.

GENERATED, NOT CHECKED IN. Manual signing requires naming a provisioning
profile per bundle id, and the names come from whatever the API returned or
created on this run. A checked-in plist naming profiles that were never
installed fails later and less clearly than automatic signing does.
"""

from __future__ import annotations

import json
import pathlib
import sys

TEAM = "B87ALX4XW9"


def main() -> int:
    src = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "profiles.json")
    dest = pathlib.Path(sys.argv[2] if len(sys.argv) > 2
                        else "ExportOptions.generated.plist")
    names: dict[str, str] = json.loads(src.read_text())
    if not names:
        print("::error::profiles.json is empty — nothing to sign with")
        return 1

    rows = "".join(
        f"      <key>{ident}</key><string>{name}</string>\n"
        for ident, name in sorted(names.items()))
    dest.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
        '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        '<plist version="1.0">\n'
        '<dict>\n'
        '  <key>method</key><string>app-store-connect</string>\n'
        f'  <key>teamID</key><string>{TEAM}</string>\n'
        '  <key>signingStyle</key><string>manual</string>\n'
        '  <key>destination</key><string>export</string>\n'
        '  <key>uploadSymbols</key><true/>\n'
        '  <key>provisioningProfiles</key>\n'
        '  <dict>\n'
        f'{rows}'
        '  </dict>\n'
        '</dict>\n'
        '</plist>\n')
    print(f"wrote {dest} naming {len(names)} profile(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
