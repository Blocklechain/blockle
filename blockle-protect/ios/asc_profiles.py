#!/usr/bin/env python3
"""Ensure an App Store distribution profile exists for every bundle id, and
install it so `-exportArchive` can sign manually.

WHY THIS EXISTS
---------------
The archive now carries its entitlements (ad-hoc signed after the build; see
the workflow). Export then fails with two misleading lines:

    error: exportArchive Authentication failed
    error: exportArchive No profiles for 'org.blockle.protect' were found

The log underneath them says `status code: 200 (no error)` with `"errors": []`.
The ASC key authenticates fine — it has uploaded builds on every run through
44927460372. What comes back is an EMPTY PROFILE LIST, and Xcode reports an
empty result as an authentication failure.

So the missing thing is an App Store distribution profile that grants the App
Group across all seven bundle ids. `-allowProvisioningUpdates` is not creating
them. This script asks the API directly, which has exactly three outcomes and
all of them are progress:

  * the profiles exist           -> downloads and installs them, export works
  * they do not and can be made  -> creates them, installs them, export works
  * the key may not create them  -> prints the HTTP status and the Apple error
                                    verbatim, which ANSWERS the open question
                                    ("is this key Admin / App Manager?")
                                    instead of leaving it to inference

A key that can upload builds cannot necessarily create profiles, and an empty
200 is exactly what that looks like from Xcode's side.

ES256, NOT openssl. An earlier attempt at ASC auth in this repo signed the JWT
with `openssl dgst`, which emits a DER signature; ES256 requires raw R||S, so
every request came back unauthorized and the preflight silently concluded there
were no apps. PyJWT with the cryptography backend gets this right.

Usage (CI):
    python3 asc_profiles.py --out profiles.json
Writes a JSON map of bundle id -> profile name for ExportOptions.plist, and
installs each .mobileprovision where xcodebuild looks for it.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

API = "https://api.appstoreconnect.apple.com/v1"

# The seven that ship. The test target is not archived and has no profile.
BUNDLES = [
    "org.blockle.protect",
    "org.blockle.protect.shieldCore",
    "org.blockle.protect.shieldCustom",
    "org.blockle.protect.shieldAdult1",
    "org.blockle.protect.shieldAdult2",
    "org.blockle.protect.shieldAdult3",
    "org.blockle.protect.shieldAdult4",
]

PROFILE_TYPE = "IOS_APP_STORE"
# ANY certificate whose type mentions distribution.
#
# NOT a fixed tuple. The first version of this script filtered on exactly
# ("DISTRIBUTION", "IOS_DISTRIBUTION") and reported "distribution certificates
# visible: 0" — which it then declared meant the account had none. That was
# almost certainly the filter's fault, not the account's: Xcode's cloud signing
# issues a certificate of type DISTRIBUTION_MANAGED, and builds signed with it
# have been uploading to TestFlight from this very workflow. Matching on the
# substring takes whatever Apple actually calls it, and every type is printed
# below so the answer is visible rather than inferred.
def is_distribution(cert_type: str) -> bool:
    return "DISTRIBUTION" in (cert_type or "").upper()


def die(msg: str, code: int = 1) -> None:
    print(f"::error::{msg}")
    sys.exit(code)


def token() -> str:
    kid = os.environ.get("ASC_KEY_ID", "").strip()
    iss = os.environ.get("ASC_ISSUER_ID", "").strip()
    if not kid or not iss:
        die("ASC_KEY_ID / ASC_ISSUER_ID are not set")
    key_path = pathlib.Path.home() / ".appstoreconnect" / "private_keys" / f"AuthKey_{kid}.p8"
    if not key_path.exists():
        die(f"no private key at {key_path}")
    try:
        import jwt  # PyJWT
    except ImportError:
        die("PyJWT is not installed (pip install 'pyjwt[crypto]')")
    now = int(time.time())
    return jwt.encode(
        {"iss": iss, "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1"},
        key_path.read_text(),
        algorithm="ES256",
        headers={"kid": kid, "typ": "JWT"},
    )


def call(tok: str, path: str, method: str = "GET", body: dict | None = None) -> dict:
    """One API call. Apple's error payload is printed verbatim on failure,
    because the whole point of this script is to stop guessing."""
    url = path if path.startswith("http") else f"{API}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {tok}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        print(f"  HTTP {e.code} on {method} {url}")
        print(f"  {detail[:1200]}")
        if e.code in (401, 403):
            print("::error::The key authenticated but is NOT permitted to do this.")
            print("  ASC API keys have roles. A key with Developer access can")
            print("  upload builds and cannot create certificates or profiles —")
            print("  which is exactly what an empty 200 looks like to Xcode.")
            print("  Fix: App Store Connect -> Users and Access -> Integrations")
            print("  -> App Store Connect API, and give this key (or a new one)")
            print("  the Admin or App Manager role.")
        raise
    except urllib.error.URLError as e:
        die(f"could not reach the API: {e}")
    return {}


def paged(tok: str, path: str) -> list[dict]:
    out: list[dict] = []
    nxt = path
    while nxt:
        page = call(tok, nxt)
        out.extend(page.get("data", []))
        nxt = page.get("links", {}).get("next")
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="profiles.json")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what exists; create nothing")
    args = ap.parse_args()

    tok = token()
    print("authenticated against App Store Connect")

    # ---- what the key can see -------------------------------------------
    all_certs = paged(tok, "/certificates?limit=200")
    # EVERY certificate, with its type, before any filtering. A count of zero
    # after a filter says nothing about the account until the unfiltered list
    # is on screen too.
    print(f"certificates the key can see: {len(all_certs)}")
    for c in all_certs:
        a = c["attributes"]
        print(f"  {str(a.get('certificateType')):24} {a.get('name')}  "
              f"expires {str(a.get('expirationDate'))[:10]}")
    certs = [c for c in all_certs
             if is_distribution(c["attributes"].get("certificateType", ""))]
    print(f"...of which distribution-capable: {len(certs)}")
    if not certs:
        die("the key can see no distribution certificate. If the list above is "
            "EMPTY the account has none — create one in Xcode (Settings -> "
            "Accounts -> Manage Certificates -> +). If the list above has "
            "entries, their type strings are printed and this filter needs to "
            "accept one of them.")

    bundles = {b["attributes"]["identifier"]: b["id"]
               for b in paged(tok, "/bundleIds?limit=200")}
    print(f"bundle ids visible: {len(bundles)}")

    existing: dict[str, dict] = {}
    for p in paged(tok, "/profiles?limit=200&include=bundleId"):
        a = p["attributes"]
        if a.get("profileType") != PROFILE_TYPE:
            continue
        if a.get("profileState") != "ACTIVE":
            continue
        rel = p.get("relationships", {}).get("bundleId", {}).get("data") or {}
        for ident, bid in bundles.items():
            if rel.get("id") == bid:
                existing[ident] = p
    print(f"active {PROFILE_TYPE} profiles matching our bundles: {len(existing)}")

    # ---- make sure every bundle has one ---------------------------------
    install_dir = (pathlib.Path.home() / "Library" / "MobileDevice"
                   / "Provisioning Profiles")
    install_dir.mkdir(parents=True, exist_ok=True)

    names: dict[str, str] = {}
    missing_bundle_ids: list[str] = []
    for ident in BUNDLES:
        if ident not in bundles:
            missing_bundle_ids.append(ident)
            continue
        prof = existing.get(ident)
        if prof is None:
            if args.dry_run:
                print(f"  WOULD CREATE   {ident}")
                continue
            name = f"Blockle Protect AppStore {ident}"
            print(f"  creating       {ident}  ({name})")
            created = call(tok, "/profiles", "POST", {
                "data": {
                    "type": "profiles",
                    "attributes": {"name": name,
                                   "profileType": PROFILE_TYPE},
                    "relationships": {
                        "bundleId": {"data": {"type": "bundleIds",
                                              "id": bundles[ident]}},
                        "certificates": {"data": [
                            {"type": "certificates", "id": c["id"]}
                            for c in certs]},
                    },
                }
            })
            prof = created.get("data")
            if prof is None:
                die(f"profile creation returned no data for {ident}")
        else:
            print(f"  already there  {ident}")

        a = prof["attributes"]
        names[ident] = a["name"]
        content = a.get("profileContent")
        if not content:
            # A listed profile does not always carry its bytes; fetch it.
            got = call(tok, f"/profiles/{prof['id']}")
            content = got.get("data", {}).get("attributes", {}).get(
                "profileContent")
        if not content:
            die(f"no profileContent for {ident} — cannot install it")
        dest = install_dir / f"{a['uuid']}.mobileprovision"
        dest.write_bytes(base64.b64decode(content))
        print(f"    installed -> {dest.name}")

    if missing_bundle_ids:
        die("these bundle ids do not exist in the account, so no profile can "
            "be made for them: " + ", ".join(missing_bundle_ids)
            + ". They are normally created by -allowProvisioningUpdates on a "
              "first archive; create them under Identifiers in the portal "
              "(and enable App Groups on each).")

    pathlib.Path(args.out).write_text(json.dumps(names, indent=2))
    print(f"\nwrote {args.out} with {len(names)} profile name(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
