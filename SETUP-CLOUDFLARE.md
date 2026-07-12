# Wayfarer on Cloudflare Pages — setup checklist

Wayfarer moves from GitHub Pages to Cloudflare Pages so the whole site can sit
behind a password gate (`functions/_middleware.js`, a Pages Function that runs
on every request — static assets included). Everything below runs from the repo
root; no build step is involved.

1. **Log in to Cloudflare** (opens a browser window):

   ```sh
   npx wrangler@4 login
   ```

2. **Create the Pages project** (once):

   ```sh
   npx wrangler@4 pages project create wayfarer --production-branch main
   ```

3. **Set the site password** (you will be prompted; the value is stored as an
   encrypted secret, never in the repo):

   ```sh
   npx wrangler@4 pages secret put SITE_PASSWORD --project-name wayfarer
   ```

   Until this secret exists, visiting the deployed site shows a friendly
   500 "setup needed" page with this exact command.

4. **Deploy** (repeat this step for every update). First stage exactly the
   app's files into `dist/`, then deploy that folder (`wrangler.toml` points
   `pages_build_output_dir` at it; `functions/` is picked up from the repo
   root automatically):

   ```sh
   rm -rf dist && mkdir dist
   cp -R index.html config.js css js dist/
   npx wrangler@4 pages deploy --project-name wayfarer
   ```

   **Never deploy the repo root** (`pages deploy .`): wrangler has no
   user-configurable ignore list, so that would upload — and serve — internal
   files (`ARCHITECTURE.md`, `worklog/`, `supabase/schema.sql`, …) and any
   local `.dev.vars` or `.wrangler/` state created by the dev preview,
   including the site password itself at `/.dev.vars`.

   The site is served at the root of your `*.pages.dev` domain, e.g.
   `https://wayfarer.pages.dev/`. Enter the password once per device;
   the session cookie lasts 30 days. `/logout` ends the session.

5. **Later — if you enable Supabase cloud sync** (see `SETUP.md`): update the
   Supabase Auth redirect URLs so magic links point at the new
   `https://<project>.pages.dev` address instead of the old GitHub Pages URL
   (Supabase dashboard → Authentication → URL Configuration → Site URL and
   Redirect URLs).

   **Important:** the password gate sits in front of *everything*, including
   the magic-link landing page. Make sure you have already entered the site
   password on a device **before** clicking a magic link on it — otherwise the
   link's redirect gets bounced to `/login` and the auth tokens are lost.

## Notes

- **Changing the password logs everyone out.** The session-cookie signing key
  is derived from `SITE_PASSWORD`, so rotating the secret (re-run step 3)
  invalidates all existing sessions by design.
- On HTTPS (which Pages provides automatically) the session cookie is marked
  `Secure`; over the plain-http local preview the flag is omitted, since
  Safari refuses to store `Secure` cookies on `http://localhost` (Chrome and
  Firefox exempt localhost). Local static previews (`python3 -m http.server`)
  simply run without the gate; to preview the gate itself, put the password in
  a `.dev.vars` file in the repo root (`SITE_PASSWORD=…`) and run
  `npx wrangler@4 pages dev .`. **Keep `.dev.vars` and the `.wrangler/` state
  folder out of git and out of any deployed folder** — both are listed in
  `.gitignore`, and deploys upload only the staged `dist/` (step 4), so
  neither can leak; don't work around that.
- No password or secret is ever logged or echoed back by the gate.
