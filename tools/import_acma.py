#!/usr/bin/env python3
"""Build a state-scoped ACMA RRL transmitter dataset, excluding natural-person clients."""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
import urllib.request
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import quote

SOURCE_URL = "https://cdn.acma.gov.au/rrl/spectra_rrl.zip"
SOURCE_PAGE = "https://www.acma.gov.au/radiocomms-licence-data"
ATTRIBUTION = "Based on Australian Communications and Media Authority information"
SERVICE_NAMES = {
    "1": "Broadcasting", "2": "Fixed", "3": "Land Mobile", "5": "Maritime Coast", "6": "Amateur",
    "8": "Aeronautical", "9": "Earth", "10": "PTS", "18": "Radiodetermination", "50": "Datacasting",
    "65": "Defence", "66": "Aircraft", "67": "Maritime Ship", "68": "Outpost", "69": "Scientific", "75": "Space",
    "85": "Spectrum licence", "90": "Broadcast Service Licence", "93": "Datacasting Service Licence",
    "95": "Broadcasting Class Licence", "102": "Fixed Receive", "105": "Major Coast Receive", "109": "Earth Receive",
    "110": "PTS 900 MHz", "165": "Defence Receive", "175": "Space Receive",
}
ORG_CLIENT_TYPE_IDS = {"1", "2", "3", "4", "5"}  # Exclude Person and community/volunteer types conservatively.


def csv_rows(zf: zipfile.ZipFile, table: str):
    member = next((name for name in zf.namelist() if Path(name).name.lower() == f"{table}.csv"), None)
    if not member:
        raise RuntimeError(f"ACMA archive is missing {table}.csv")
    with zf.open(member) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", errors="replace", newline="")
        yield from csv.DictReader(text)


def expiry_date(value: str) -> date | None:
    value = value.strip()
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%d/%m/%Y", "%d-%b-%Y"):
        try:
            return datetime.strptime(value[:19], fmt).date()
        except ValueError:
            pass
    # Unknown non-empty dates fail closed rather than treating the licence as current.
    return date.min


def download(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "AntennAR-data-import/1.0"})
    with urllib.request.urlopen(request, timeout=180) as response, path.open("wb") as output:
        while block := response.read(1024 * 1024):
            output.write(block)
    if not zipfile.is_zipfile(path):
        path.unlink(missing_ok=True)
        raise RuntimeError("ACMA did not return the expected spectra_rrl ZIP archive")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--states", required=True, help="Comma-separated Australian state/territory codes (e.g. NSW,VIC)")
    parser.add_argument("--input", type=Path, help="Use a previously downloaded official spectra_rrl.zip")
    parser.add_argument("--output", type=Path, default=Path("public/data/acma-sites.json"))
    args = parser.parse_args()
    states = {value.strip().upper() for value in args.states.split(",") if value.strip()}
    if not states or any(not re.fullmatch(r"[A-Z]{2,3}", code) for code in states):
        parser.error("--states requires one or more two- or three-letter state/territory codes")
    archive_path = args.input or Path("data/raw/spectra_rrl.zip")
    if not args.input or not archive_path.exists():
        download(archive_path)
    with zipfile.ZipFile(archive_path) as zf:
        client_by_id: dict[str, tuple[str, str]] = {}
        for row in csv_rows(zf, "client"):
            client_by_id[row.get("CLIENT_NO", "").strip()] = (row.get("CLIENT_TYPE_ID", "").strip(), row.get("LICENCEE", "").strip())
        active_licences: dict[str, dict] = {}
        for row in csv_rows(zf, "licence"):
            client_type, licensee = client_by_id.get(row.get("CLIENT_NO", "").strip(), ("", ""))
            if client_type not in ORG_CLIENT_TYPE_IDS or row.get("STATUS", "").strip() != "1":
                continue
            expiry = expiry_date(row.get("DATE_OF_EXPIRY", ""))
            if expiry is not None and expiry < date.today():
                continue
            license_no = row.get("LICENCE_NO", "").strip()
            if license_no:
                active_licences[license_no] = {"licensee": licensee or "Organization licensee", "service": row.get("SV_ID", "").strip(), "licenseType": row.get("LICENCE_TYPE_NAME", "").strip(), "category": row.get("LICENCE_CATEGORY_NAME", "").strip()}
        sites: dict[str, dict] = {}
        for row in csv_rows(zf, "site"):
            state = row.get("STATE", "").strip().upper()
            if state not in states:
                continue
            try:
                lat, lon = float(row["LATITUDE"]), float(row["LONGITUDE"])
            except (KeyError, ValueError):
                continue
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                continue
            sites[row.get("SITE_ID", "").strip()] = {"lat": round(lat, 6), "lon": round(lon, 6), "state": state, "city": "", "siteName": row.get("NAME", "").strip()}
        grouped: dict[tuple[str, str], dict] = {}
        for row in csv_rows(zf, "device_details"):
            if row.get("DEVICE_TYPE", "").strip().upper() != "T":
                continue
            licence_no, site_id = row.get("LICENCE_NO", "").strip(), row.get("SITE_ID", "").strip()
            licence = active_licences.get(licence_no); site = sites.get(site_id)
            if not licence or not site:
                continue
            raw_freq = (row.get("FREQUENCY") or row.get("CARRIER_FREQ") or "").strip()
            try:
                freq = float(raw_freq)
            except ValueError:
                continue
            if freq <= 0:
                continue
            key = (licence_no, site_id)
            record = grouped.setdefault(key, {
                "id": f"AU:{licence_no}:{site_id}", "country": "AU", "systemId": licence_no,
                "callSign": row.get("CALL_SIGN", "").strip() or licence_no,
                "licensee": licence["licensee"], "service": licence["service"],
                "serviceName": SERVICE_NAMES.get(licence["service"], f"ACMA service {licence['service']}"),
                "state": site["state"], "city": site["city"], "siteName": row.get("STATION_NAME", "").strip() or site["siteName"],
                "lat": site["lat"], "lon": site["lon"], "frequencies": [], "licenseStatus": "Active",
                "recordUrl": f"https://www.acma.gov.au/register-radiocommunication-licences-rrl?pLICENCE_NO={quote(licence_no, safe='')}",
            })
            if freq not in record["frequencies"]:
                record["frequencies"].append(freq)
        result_sites = list(grouped.values())
        for site in result_sites:
            site["frequencies"].sort()
        stamps = [datetime(*item.date_time, tzinfo=timezone.utc) for item in zf.infolist() if item.filename.lower().endswith(".csv")]
        source_date = max(stamps, default=datetime.now(timezone.utc)).date().isoformat()
    payload = {
        "schemaVersion": 1, "country": "AU", "source": "ACMA Register of Radiocommunications Licences (RRL)",
        "sourceUrl": SOURCE_PAGE, "attribution": ATTRIBUTION, "sourceDate": source_date,
        "importedAt": datetime.now(timezone.utc).date().isoformat(), "scope": f"{','.join(sorted(states))} · organization licensees only",
        "services": {key: value for key, value in SERVICE_NAMES.items()}, "siteCount": len(result_sites),
        "sites": sorted(result_sites, key=lambda x: (x["service"], x["callSign"], x["id"])),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.output.with_suffix(args.output.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    tmp.replace(args.output)
    print(f"Wrote {args.output} · {len(result_sites):,} mapped active AU transmitter sites · organization client data only · {args.output.stat().st_size:,} bytes · source {source_date}", file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as exc:
        print(f"ACMA import failed: {exc}", file=sys.stderr); sys.exit(1)
