# Wayfarer — Privacy Policy

_Last updated: 2026-07-17_

Wayfarer is a small, independently run travel-diary app. This policy explains, in plain
language, what data it holds and the control you have over it. It is written honestly for an
indie-scale project — there is no ad network, no analytics profile, and nothing is sold.

## What Wayfarer stores

- **Your diary entries** — the title, date, location, story text, and references to your
  photos and voice notes that you create.
- **Your photos and voice notes** — the image and audio files you attach. Photos are
  downscaled in your browser before upload (max 1600px, JPEG quality 0.8).
- **Your account** — the email address you sign up with, and a per-account display name and
  storage-usage counter.

**Local mode.** If you use Wayfarer without signing in, everything stays in your browser
(IndexedDB) on your device. Nothing is sent anywhere, and this policy's cloud sections do
not apply until you create an account.

**Cloud mode.** When you sign in, your entries and media sync to a private space in our
backend (Supabase). Access is enforced by row-level security keyed to your account id — no
other user can read your entries or files, and files live in a **private** storage bucket
(no public URLs).

## What Wayfarer does _not_ do

- No advertising, no ad tracking, no selling or sharing of your data with third parties.
- No behavioral analytics profile of you.
- We do not read your diary content except where strictly necessary to operate the service
  or to respond to a valid abuse report or legal obligation (see Terms).

## Third parties we rely on

- **Supabase** — authentication, database, and file storage.
- **Cloudflare** — hosting and (in a later version) media storage/delivery.

These providers process data only to run the service. If a future version adds **Google
Drive import**, Wayfarer will use the narrow `drive.file` scope and only access the specific
files you pick in Google's own picker. Data obtained through Google APIs is used solely to
bring those photos into your diary and is handled in accordance with the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including its Limited Use requirements; it is not used for advertising and is not sold.

## Your rights

- **Export.** Use "Save diary (.json)" any time to download a complete copy of your entries
  and photos. This is portable and works fully offline.
- **Delete.** "Delete my account and data" permanently removes your account, every entry, and
  every stored photo and voice note from the backend, and wipes this device's local copy.
  This is immediate and cannot be undone.
- **Access.** Your data is always visible to you inside the app; the export gives you the
  raw copy.

## Data retention

Cloud data is kept until you delete an entry or your account. Deleting your account purges
your stored files and removes your account record; associated database rows are removed by
cascade.

## Contact

Questions, privacy requests, or abuse reports: **[abuse@wayfarer.example](mailto:abuse@wayfarer.example)**
_(placeholder — replace with a monitored address before public launch)._
