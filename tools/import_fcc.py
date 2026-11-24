#!/usr/bin/env python3
"""Build a state-scoped compact site dataset from FCC ULS complete license archives."""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

BASE = "https://data.fcc.gov/download/pub/uls/complete/"
# These are FCC public-access complete-license archive groups, not radio-service codes.
ARCHIVES = ["aircr", "amat", "brs", "cell", "coast", "gmrs", "LMbcast", "LMpriv", "micro", "paging", "ship"]
SERVICE_NAMES = {
    "AC": "Aircraft", "HA": "Amateur", "HV": "Amateur vanity", "BR": "Broadband Radio Service",
    "ED": "Educational Broadband Service", "MD": "Multipoint Distribution Service", "VX": "Instructional Television Fixed Service",
    "CL": "Cellular", "AA": "Aviation Auxiliary", "AF": "Aeronautical and Fixed", "AR": "Aviation Radionavigation",
    "MA": "Marine Auxiliary", "MC": "Coastal Group", "MK": "Alaska Group", "MR": "Marine Radiolocation",
    "ZA": "General Mobile Radio Service", "GB": "Business · 800 MHz conventional", "GE": "Public Safety · 800 MHz conventional",
    "GF": "Public Safety National Plan · 800 MHz conventional", "GI": "Industrial / transportation · 900 MHz conventional",
    "GJ": "Business / industrial / transportation · conventional", "GL": "900 MHz SMR · conventional", "GM": "800 MHz SMR · conventional",
    "GO": "Industrial / transportation · 800 MHz conventional", "GP": "Public Safety · 800 MHz conventional", "GR": "SMR · 900 MHz conventional",
    "GS": "Private carrier paging", "GU": "Business · 900 MHz conventional", "GX": "SMR · 800 MHz conventional",
    "IG": "Industrial / Business Pool · conventional", "IK": "Industrial / Business Pool · commercial conventional",
    "IQ": "Intelligent Transportation Service", "LP": "Broadcast Auxiliary · low power", "LV": "Low Power Wireless Assist Video",
    "LN": "Location Narrowband · 902–928 MHz", "LW": "Location Wideband · 902–928 MHz", "NC": "Nationwide Commercial · 220 MHz",
    "PA": "Public Safety · 4.9 GHz", "PW": "Public Safety Pool · conventional", "QD": "Non-Nationwide Data · 220 MHz",
    "QM": "Non-Nationwide Public Safety / Mutual Aid · 220 MHz", "QO": "Non-Nationwide Other · 220 MHz",
    "QQ": "Intelligent Transportation Service · non-public-safety", "QT": "Non-Nationwide Trunked · 220 MHz",
    "RP": "Broadcast Auxiliary · remote pickup", "RS": "Land Mobile Radiolocation", "SG": "Conventional Public Safety · 700 MHz",
    "SL": "Public Safety · 700 MHz state license", "SP": "Public Safety · 700 MHz nationwide", "SY": "Public Safety · 700 MHz trunked",
    "YB": "Business · 800 MHz trunked", "YE": "Public Safety National Plan · 800 MHz trunked", "YF": "Public Safety National Plan · 800 MHz trunked",
    "YG": "Industrial / Business Pool · trunked", "YI": "Industrial / transportation · 900 MHz trunked",
    "YJ": "Business / industrial / transportation · trunked", "YK": "Industrial / Business Pool · commercial trunked",
    "YL": "900 MHz SMR · trunked", "YM": "800 MHz SMR · trunked", "YO": "Industrial / transportation · 800 MHz trunked",
    "YP": "Public Safety · 800 MHz trunked", "YS": "SMR · 900 MHz trunked", "YU": "Business · 900 MHz trunked",
    "YW": "Public Safety Pool · trunked", "YX": "SMR · 800 MHz trunked",
    "CA": "Commercial Air-Ground Radiotelephone", "CB": "BETRS", "CD": "Paging and Radiotelephone", "CG": "General Aviation Air-Ground",
    "CO": "Offshore Radiotelephone", "CR": "Rural Radiotelephone", "CF": "Common Carrier Fixed Microwave", "CT": "Local Television Transmission",
    "MG": "Microwave Industrial / Business Pool", "MM": "Millimeter Wave", "MW": "Microwave Public Safety Pool", "NN": "3650–3700 MHz",
    "PE": "Digital Electronic Message Service", "TB": "TV Microwave Booster", "TI": "TV Intercity Relay", "TP": "TV Pickup",
    "TS": "TV Studio Transmitter Link", "TT": "TV Translator Relay", "WA": "Microwave Aviation", "WM": "Microwave Marine", "WR": "Microwave Radiolocation",
    "SA": "Ship Recreational / Voluntarily Equipped", "SB": "Ship Compulsory Equipped", "SE": "Ship Exemption",
}


def get(args_url: str) -> bytes:
    request = urllib.request.Request(args_url, headers={"User-Agent": "AntennAR-data-import/1.0"})
    with urllib.request.urlopen(request, timeout=180) as response:
        body = response.read()
    if not zipfile.is_zipfile(BytesIO(body)):
        raise RuntimeError(f"FCC response was not a ZIP archive: {args_url}")
    print(f"Fetched {args_url.rsplit('/', 1)[-1]} ({len(body):,} bytes)", file=sys.stderr)
    return body


def records(zf: zipfile.ZipFile, table: str):
    member = next((item for item in zf.namelist() if Path(item).name.lower() == f"{table}.dat"), None)
    if not member:
        return
    with zf.open(member) as stream:
        for raw in stream:
            try:
                yield raw.decode("latin-1").rstrip("\r\n").split("|")
            except UnicodeError:
                continue


def decimal_dms(d: str, m: str, s: str, direction: str) -> float | None:
    try:
        result = float(d) + float(m) / 60 + float(s) / 3600
        return -result if direction.upper() in {"S", "W"} else result
    except (ValueError, TypeError):
        return None


def source_timestamp(zf: zipfile.ZipFile) -> datetime:
    dates = [datetime(*item.date_time, tzinfo=timezone.utc) for item in zf.infolist() if item.filename.lower().endswith(".dat")]
    return max(dates, default=datetime.now(timezone.utc))


def load_safe_t_matches(path: Path | None) -> dict[tuple[str, str], dict]:
    if path is None:
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    matches: dict[tuple[str, str], dict] = {}
    for item in payload.get("matches", []):
        if item.get("reviewed") is not True:
            continue
        if not str(item.get("sourceUrl", "")).startswith("https://"):
            raise ValueError("Reviewed SAFE-T match references must be HTTPS URLs")
        matches[(str(item["systemId"]).strip(), str(item["locationNumber"]).strip())] = item
    return matches


def read_archive(name: str, states: set[str], data: bytes, matches: dict[tuple[str, str], dict]) -> tuple[list[dict], datetime]:
    zf = zipfile.ZipFile(BytesIO(data))
    licenses: dict[str, dict] = {}
    for row in records(zf, "hd"):
        if len(row) > 6 and row[0] == "HD" and row[5].strip().upper() == "A":
            licenses[row[1].strip()] = {"systemId": row[1].strip(), "callSign": row[4].strip(), "service": row[6].strip().upper()}
    if not licenses:
        raise RuntimeError(f"No Active HD license records in {name}; refusing to publish incomplete output")
    licensees: dict[str, str] = {}
    for row in records(zf, "en"):
        if len(row) > 11 and row[0] == "EN" and row[1].strip() in licenses:
            if row[7].strip(): licensees.setdefault(row[1].strip(), row[7].strip())
            elif row[8].strip() or row[10].strip(): licensees.setdefault(row[1].strip(), " ".join(part.strip() for part in (row[8], row[9], row[10], row[11]) if part.strip()))
    frequencies: dict[tuple[str, str], set[float]] = {}
    for row in records(zf, "fr"):
        if len(row) > 9 and row[0] == "FR" and row[1].strip() in licenses:
            try: f = float(row[9].strip())
            except ValueError: continue
            if f > 0: frequencies.setdefault((row[1].strip(), row[6].strip()), set()).add(f)

    sites: list[dict] = []
    for row in records(zf, "lo"):
        if len(row) < 43 or row[0] != "LO" or row[1].strip() not in licenses:
            continue
        state = row[14].strip().upper()
        if state not in states or row[9].strip().upper() != "A":
            continue
        lat = decimal_dms(row[19], row[20], row[21], row[22]); lon = decimal_dms(row[23], row[24], row[25], row[26])
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        uid, loc = row[1].strip(), row[8].strip()
        license_row = licenses[uid]
        service = license_row["service"]
        match = matches.get((uid, loc))
        sites.append({
            "id": f"US:{uid}:{loc}", "country": "US", "systemId": uid,
            "callSign": license_row["callSign"], "licensee": licensees.get(uid, license_row["callSign"]),
            "service": service, "serviceName": SERVICE_NAMES.get(service, f"FCC radio service {service}"),
            "state": state, "city": row[12].strip(), "siteName": row[42].strip(), "lat": round(lat, 6), "lon": round(lon, 6),
            "frequencies": sorted(frequencies.get((uid, loc), set())), "licenseStatus": "Active",
            "recordUrl": f"https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey={uid}",
            **({"confirmedSafeT": True, "safeTLabel": match.get("label", "Reviewed SAFE-T match"), "safeTSource": match["sourceUrl"]} if match else {}),
        })
    return sites, source_timestamp(zf)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--states", required=True, help="Comma-separated US state abbreviations; required to keep the phone dataset region-sized")
    parser.add_argument("--archives", default=",".join(ARCHIVES), help="Comma-separated FCC complete archive groups (default: all site-based groups with transmitter location records)")
    parser.add_argument("--safe-t-matches", type=Path, help="Optional reviewed exact ULS system/location match list")
    parser.add_argument("--output", type=Path, default=Path("public/data/fcc-sites.json"))
    args = parser.parse_args()
    states = {x.strip().upper() for x in args.states.split(",") if x.strip()}
    archives = list(dict.fromkeys(x.strip() for x in args.archives.split(",") if x.strip()))
    if not states or any(not re.fullmatch(r"[A-Z]{2}", x) for x in states): parser.error("--states requires two-letter postal abbreviations")
    if not archives or any(not re.fullmatch(r"[A-Za-z0-9_-]+", x) for x in archives): parser.error("--archives requires FCC archive group names")
    all_sites: list[dict] = []
    matches = load_safe_t_matches(args.safe_t_matches)
    source_date = datetime.min.replace(tzinfo=timezone.utc)
    for archive in archives:
        sites, stamp = read_archive(archive, states, get(BASE + f"l_{archive}.zip"), matches)
        all_sites.extend(sites); source_date = max(source_date, stamp)
        print(f"{archive}: {len(sites):,} active locations", file=sys.stderr)
    # Site records can be duplicated between archive groups; one service's record wins.
    compact = {site["id"]: site for site in all_sites}
    payload = {
        "schemaVersion": 1, "country": "US", "source": "FCC Universal Licensing System (ULS) complete license public access files",
        "sourceUrl": "https://wireless.fcc.gov/uls/documentation/pa_intro24.pdf", "sourceDate": source_date.date().isoformat(),
        "importedAt": datetime.now(timezone.utc).date().isoformat(), "scope": f"{','.join(sorted(states))} · {len(archives)} FCC archive groups",
        "services": {code: name for code, name in SERVICE_NAMES.items()}, "siteCount": len(compact),
        "sites": sorted(compact.values(), key=lambda x: (x["service"], x["callSign"], x["id"])),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.output.with_suffix(args.output.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    tmp.replace(args.output)
    print(f"Wrote {args.output} · {len(compact):,} mapped active FCC license locations · {args.output.stat().st_size:,} bytes · source {payload['sourceDate']}", file=sys.stderr)


if __name__ == "__main__":
    try: main()
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as exc:
        print(f"FCC import failed: {exc}", file=sys.stderr); sys.exit(1)
