---
name: deployd-cli
description: Create, list and publish Deployd Studio websites and register/manage domains from the command line. Use when asked to create a site, check or buy a domain, change DNS records, or transfer a domain for a Deployd agency or Pro account.
---

# Deployd CLI

`deployd` is the command line for Deployd Studio (https://deployd.app). It
authenticates with an **agency API key** and can only reach that agency's own
sites and domains.

## Install

```bash
npm install -g deployd-network-cli
```

Inside the platform repo, `node scripts/deployd-cli.js …` runs the same CLI
without installing.

## Authenticate

Preferred (interactive): `deployd login` — prompts for a key (`dpa_…`, minted
in Settings → API keys), verifies it against `/api/v1/whoami`, stores it in
`~/.deployd/config.json` at mode 0600.

Non-interactive (CI, agents): set `DEPLOYD_API_KEY` in the environment. It
overrides the config file. **Never echo the key or write it to any other
file.** If there is no key, stop and ask the user for one — do not guess.

Check who you are before acting:

```bash
deployd whoami        # agency name, key scopes, draft quota
```

## Commands

```bash
deployd sites                              # list the agency's sites
deployd create "Acme Bakery"               # create a draft site
deployd create "Acme" --dir ./build        # …and upload a folder into it
deployd push --site <id> --dir ./build     # upload a folder as a new version
                                           # (a sync; --no-delete keeps
                                           #  remote files absent locally)

deployd domains                            # domains the agency owns
deployd domains check acme.com             # availability + customer price
deployd domains buy acme.com --site <id>   # buy (returns a payment link)
deployd domains status <purchaseId>        # purchase progress

deployd dns acme.com                       # list DNS records
deployd dns acme.com add A www 1.2.3.4     # add a record
deployd dns acme.com set <recordId> 5.6.7.8
deployd dns acme.com rm <recordId>
                                           # --wait blocks until confirmed
                                           # --confirm-to picks the recipient

deployd transfer in acme.com --auth-code <code>
deployd transfer out acme.com              # release to another registrar
deployd transfer status acme.com

```

## Rules that shape what you tell the user

1. **Buying is payment-first.** `domains buy` returns a Stripe checkout URL;
   the domain is NOT registered when the command returns. Say it is *reserved
   pending payment*, give the link, and check with `domains status`. If
   registration fails after payment, the refund is automatic.

2. **DNS changes and transfers-out are NOT live when the command returns.**
   They apply only after someone clicks an emailed confirmation showing the
   exact change. The email goes to an address already registered on the domain
   (the customer, or the agency that manages them) — `--confirm-to <email>`
   picks among those addresses but can never add a new one. Never tell the
   user a DNS change or transfer is done until it is confirmed (`--wait`, or
   `deployd confirm-status <id>`).

3. **Quote customer prices only.** `domains check` output already includes the
   platform margin and VAT where applicable. Never quote a registrar's raw
   cost.

4. **Scopes are explicit.** A key without `domains:register`, `dns:write` or
   `domains:write` cannot do those things — that is deliberate, because they
   spend money or can take a site offline. On an `insufficient_scope` error,
   tell the user to mint a key with that scope in Settings → API keys; do not
   hunt for workarounds.

5. **Draft quota.** Agencies have a draft-site allowance; `create` fails with
   the numbers when it is spent. Extra drafts are bought in packs of 10 from
   the dashboard.

6. **A domain is never "claimed".** `create` takes no domain, deliberately —
   an unverified domain on a site would be a claim on a name someone else may
   own. Attach a domain only through `domains buy --site <id>` or
   `transfer in`, both of which prove control.

7. **Uploads are versions.** `push` stages files and then finalizes them into
   a new version atomically — an interrupted push leaves the previous version
   intact. It syncs: remote files absent from the folder are removed unless
   `--no-delete` is passed.

## Errors worth recognising

| Error | Meaning | What to do |
|---|---|---|
| `Invalid or expired API key` | Bad, revoked or expired key | Ask the user for a fresh key |
| `insufficient_scope` | Key lacks the needed scope | Mint a key with that scope |
| `draft_limit_reached` | Draft quota spent | Publish a draft or buy extra slots |
| `already taken` on buy | Domain registered elsewhere | Suggest alternatives via `domains check` |
| `premium` on buy | Premium-priced name | Refused by design; pick another name |
