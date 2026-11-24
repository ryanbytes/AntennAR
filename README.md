# AntennAR

Mobile-first antenna aiming PWA. It uses the rear camera as a live background and positions active licensed site markers by azimuth when a reliable phone heading is available. Site selection, bearings, distances, radius filtering, and manual-origin storage stay on the device.

## Run locally

```sh
npm install
npm run dev
```

Open the displayed `http://localhost:5173` address. Browsers treat localhost as a secure context, so camera and sensor testing can work there. Phone camera, location, and motion access require HTTPS on a normal hosted site. The first permissions are requested only after tapping **Start field view**. On iPhone, compass permission is requested directly from that button gesture.

To build and preview the static PWA:

```sh
npm run build
npm run preview
```

## License data and updates

The deployed phone downloads compact U.S.-wide and Australia-wide JSON snapshots generated from the official archives. It never requests FCC or ACMA data based on a phone coordinate; nearby radius filtering is local. Raw source archives and generated site JSON are ignored by Git.

### United States — FCC ULS

The FCC ULS public-access files are zipped, pipe-delimited database tables. The importer uses the complete license archive groups with site/frequency data, takes only `HD` license status `A`, requires an active `LO` site record with usable coordinates, joins the matching licensee/frequency rows, and emits only the chosen states. It accepts site records even when no frequency row is present; in that case the detail view says the frequency was unavailable in the source.

```sh
python3 tools/import_fcc.py --states "CA,OR"
```

By default this downloads the site-oriented ULS archive groups handled by the importer and writes `public/data/fcc-sites.json`. To refresh, rerun it. For a narrower or broader FCC import, use `--archives` with comma-separated complete archive group names. Add `--safe-t-matches data/safe-t-reviewed.json` only when you have an exact, reviewed cross-reference. GitHub Actions imports all U.S. states and territories weekly before publishing.

The optional SAFE-T file must contain `matches` with exact FCC `systemId` and `locationNumber` pairs, `reviewed: true`, a label, and an HTTPS source URL. No SAFE-T match is inferred from a public-safety service code or frequency alone. Other active public-safety license locations remain marked **PUBLIC SAFETY**.

### Australia — ACMA RRL

ACMA publishes a full RRL snapshot several times a day. This importer selects only `Granted` licences that have not expired, joins transmitter (`DEVICE_TYPE=T`) records to registered sites and frequencies, and emits only selected states/territories. It excludes individual, community/volunteer, and unknown client categories so no natural-person client details enter the derivative dataset; licensee names are retained only for government and company types.

```sh
python3 tools/import_acma.py --states "NSW,VIC"
```

The importer downloads `spectra_rrl.zip` from ACMA into ignored `data/raw/` and writes `public/data/acma-sites.json`. You may instead pass a previously downloaded archive with `--input`. The app shows the ACMA snapshot date and the required attribution: “Based on Australian Communications and Media Authority information.” The RRL terms permit derivative software/distribution but prohibit distributing a natural person licensee's client information; the importer excludes those records. GitHub Actions imports all Australian states and territories weekly before publishing.

### Data freshness and source limits

The footer always shows each installed source and its source/import date. FCC snapshots older than 14 days and ACMA snapshots older than 8 days are visibly marked stale; stale records remain available for reference but are not presented as current. GitHub Actions refreshes both source snapshots weekly. Do not edit generated JSON by hand.

An active/current licence is an authorization record, not proof that a transmitter is powered on, a tower is visible, or a radio path is clear. FCC and ACMA coordinates may describe licensed sites or transmitters rather than a physical tower; the UI places all markers on an azimuth/horizon guide and does not invent elevation.

FCC ULS supports public-safety service categories, but the records do not identify Indiana SAFE-T sites by themselves. A SAFE-T label needs a reviewed, exact site cross-reference to an authoritative source. The optional match file is empty by default.

### Country coverage and reuse limits

The current importers cover U.S. FCC ULS records and Australian ACMA RRL records. These are practical, official, free-to-download sources with reuse conditions the project can honor. The FCC importer requires an explicit state scope and handles site-based archive groups with mapped locations; it cannot represent every authorization type in the FCC ecosystem, and a location may have no frequency row in the source.

Australia is limited to organization licensees because ACMA reuse terms prohibit redistributing client information for natural-person licensees. The importer also requires a granted, unexpired licence and a transmitter device row. It omits person and community/volunteer client categories, so it is not a complete view of every Australian authorization.

Other free downloads are not automatically free to repackage. [Canada’s ISED terms](https://ised-isde.canada.ca/site/ised/en/copyright-written-permission) require permission to adapt or revise government works, so no Canadian derivative is included. [New Zealand’s public Spectrum Search Lite dataset](https://www.rsm.govt.nz/engineers-and-examiners/resources-for-engineers-and-certifiers/spectrum-search-lite) is no longer maintained (its published update ended in 2022), while current RRF data extracts are for approved users; neither is included as current public data. No additional country is presented until a current official source and its reuse terms can be verified.

## Privacy and hosting

- `getUserMedia`, geolocation, and orientation are invoked only from the Start flow.
- Coordinates from live GPS are held in page memory, used for local filtering, never placed in URLs or sent to a server, and not logged. Manual coordinates are stored in browser `localStorage` only.
- Camera video is attached directly to a local `<video>` element. The app has no analytics, advertising, tracking code, external font loads, or location-aware server endpoint.
- Host the built static files over HTTPS. Keep JSON static and do not add a location API. The GitHub Pages deployment uses same-origin app assets, has no analytics or third-party scripts, and benefits from GitHub's HTTPS hosting; GitHub Pages does not provide custom response headers, so a future move to a host with header configuration should set a restrictive Content Security Policy and same-origin Permissions Policy. The dynamic marker UI uses inline style attributes, so `style-src` needs to allow inline styles unless those positions are changed to CSS classes.
- Deployment is automated through GitHub Actions. The workflow imports source data, builds the PWA, and publishes the artifact to GitHub Pages on main-branch updates and weekly refreshes.

The PWA shell and the last loaded compact JSON snapshots can be cached by the service worker. Refresh once online after importing a new data snapshot; the on-screen source date makes cached/stale data visible.

## FCC format references

- [FCC ULS Public Access Files introduction and archive/table overview](https://wireless.fcc.gov/uls/documentation/pa_intro24.pdf)
- [FCC ULS data file field definitions](https://wireless.fcc.gov/wtbfiles/pa_ddef51.pdf)
- [FCC ULS public data page](https://opendata.fcc.gov/Wireless/FCC-Universal-Licensing-System-ULS-/x28i-i4z4)

## Australian source and terms

- [ACMA RRL data download and reuse terms](https://www.acma.gov.au/radiocomms-licence-data)
- [ACMA RRL data format help](https://cdn.acma.gov.au/offline-rrl/index.html)
