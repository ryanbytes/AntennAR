# AntennAR

AntennAR is a mobile-first antenna-aiming PWA. It uses the rear camera as a live background and places licensed radio-site markers by compass azimuth. The phone calculates bearings, distances, and radius filtering locally. It downloads only coarse FCC map cells around the local origin and selected radius, then loads more cells automatically as the phone moves.

## Run locally

```sh
npm install
npm run dev
```

Open the displayed localhost URL. Camera, location, and motion access are requested only after **Start field view** is tapped. iPhone compass permission is requested directly from that gesture. Camera and sensors require HTTPS in normal hosted phone browsers; localhost is allowed for development.

Build and preview the PWA with:

```sh
npm run build
npm run preview
```

## FCC data

The FCC layer is derived from official FCC ULS complete license public-access ZIP files. The importer reads `HD` records with license status `A`, joins their current location (`LO`), entity (`EN`), and frequency (`FR`) records, and retains locations with usable coordinates. The LO “Site Status” field is a protection code, not an Active/Inactive flag; it is not used as a license-status filter. Site-based records in a complete current license archive are used only when the parent license is Active.

Import every U.S. state and territory into versioned 0.5-degree geographic cells:

```sh
python3 tools/import_fcc.py \
  --states "AL,AK,AZ,AR,CA,CO,CT,DE,FL,GA,HI,ID,IL,IN,IA,KS,KY,LA,ME,MD,MA,MI,MN,MS,MO,MT,NE,NV,NH,NJ,NM,NY,NC,ND,OH,OK,OR,PA,RI,SC,SD,TN,TX,UT,VT,VA,WA,WV,WI,WY,DC,AS,GU,MP,PR,VI" \
  --spatial-tiles
```

The official source ZIP files are downloaded to ignored `data/raw/`. Generated compact JSON tiles, gzip sidecars, and `public/data/fcc-catalog.json` are ignored by Git. The client uses the current location and radius locally to find intersecting cells; requests contain only a tile ID at 0.5-degree granularity, never exact coordinates. As the user moves, it requests missing cells and reuses cached versioned cells from the device. The server serves precompressed `.json.gz` sidecars for `.json` requests (`gzip_static` in the included Nginx configuration). The VPS contains only these public static FCC files, not a user database or local origin records.

For a faster regional refresh, use `--states "IN,IL,MI,OH,KY"`. The importer updates the source date, import date, tile counts, included-site counts, and compressed download sizes. The UI marks snapshots older than 14 days as stale; it does not silently relabel stale records as current.

### Coverage gaps

The imported layer covers point locations published in the selected FCC ULS site-oriented archive groups. It does **not** cover FCC broadcast stations maintained in the separate Licensing and Management System (LMS), market-only authorizations without point sites (including BRS/EBS), or records without usable mapped locations. It is not a complete inventory of every FCC authorization or every physical transmitter. The app states this scope in the interface and shows the exact selected region and source date.

An FCC license is an authorization, not proof that equipment is currently transmitting. SAFE-T is not inferred from public-safety service codes or frequencies. A site is labeled as a confirmed SAFE-T match only when a separately reviewed exact FCC system/location cross-reference is supplied through `--safe-t-matches`.

The importer uses FCC's public access files and does not scrape or repackage third-party copies. FCC format and field references:

- [ULS Public Access Files introduction](https://wireless.fcc.gov/uls/documentation/pa_intro24.pdf)
- [ULS data-file field definitions](https://wireless.fcc.gov/wtbfiles/pa_ddef51.pdf)
- [FCC ULS public data page](https://opendata.fcc.gov/Wireless/FCC-Universal-Licensing-System-ULS-/x28i-i4z4)

## Privacy

- Camera video remains on the device and is attached directly to a local video element.
- GPS and compass readings remain in page memory. Radius, bearing, and distance calculations run locally; the app makes no location-aware server request.
- Manual origin coordinates are stored in this browser's local storage only.
- The app contains no analytics, advertising, third-party scripts, external fonts, or tracking SDKs. Nginx access logging is disabled for the AntennAR virtual host.

## HTTPS deployment

Production URL: [https://antennar.ftnsa.com](https://antennar.ftnsa.com)

The host is the existing VPS, using a dedicated Nginx site root at `/var/www/antennar.ftnsa.com`. Do not place AntennAR files under a Wabash Scanner directory. Cloudflare supplies the proxied DNS/HTTPS edge; the origin uses a Let's Encrypt certificate and Cloudflare SSL mode Full (strict). Install `deploy/nginx-antennar.conf`. The Nginx configuration applies a same-origin Content Security Policy and Permissions Policy, serves compressed FCC tile JSON, redirects HTTP to HTTPS, and turns off access logs.

Build with `npm run build` and sync the contents of `dist/` to the dedicated document root. Keep `public/data/fcc-catalog.json` and versioned `public/data/fcc/**/*.json` tiles plus their gzip sidecars with the deployed static files. Verify both `https://antennar.ftnsa.com/` and a nearby tile after every import. Camera and sensor permissions work only on the HTTPS origin in normal phone browsers.
