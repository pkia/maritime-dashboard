# Online Ships on the Dashboard

The Online tab shows ships from the internet (orange markers), separate
from this station's own antenna data (white markers on the AIS tab).

## Current source: VesselAPI (api.vesselapi.com)

Key file: /home/ev/maritime-dashboard/vesselapi_key.txt

The free tier has a small MONTHLY request quota. The daemon is quota-aware:

- Fetches at most every 20 minutes in the background
- Extra fetches when someone is actually viewing the Online tab
  (max 1 per 10 min regardless of how many browsers ask)
- On quota errors it backs off for 6 hours before retrying

Status 2026-08-21: the monthly quota is exhausted
("API monthly quota exceeded"). Ships return automatically when the
quota resets (calendar month, likely Sep 1). Until then the tab shows
the quota status honestly.

New key (fresh account at vesselapi.com -> API key):

    echo "YOUR_KEY" > /home/ev/maritime-dashboard/vesselapi_key.txt

Ships appear within ~30 seconds, no restart needed.

## Retired sources

- aisstream.io: keys valid but the server never delivers data
- MarineTraffic / VesselFinder embeds: bot-walled, serve empty maps
- aiscatcher.org data API: Cloudflare Turnstile gated
