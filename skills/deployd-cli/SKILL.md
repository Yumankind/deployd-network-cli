---
name: deployd-cli
description: Create, list and publish Deployd Studio websites and register/manage domains from the command line, with any Deployd account (agency, Creator Pro or free). Use when asked to create a site, upload/publish a site folder, check or buy a domain, change DNS records, or transfer a domain.
---

# Deployd CLI

`deployd` is the command line for Deployd Studio (https://deployd.app). It
authenticates with an **API key** belonging to a Deployd account — agency,
Creator Pro, or free — and can only reach that account's own sites and
domains. The plan sets the draft quota (free: one draft at a time, Pro:
five, agency: 25+), never the door.

## Install

```bash
npm install -g deployd-network-cli
```

Inside the platform repo, `node scripts/deployd-cli.js …` runs the same CLI
without installing.

## Authenticate

Interactive: `deployd login` — opens the browser for a one-click approval by
the signed-in user, then stores a **24-hour session token bound to this
machine's public IP** in `~/.deployd/config.json` (mode 0600). Sessions carry
every scope, including `domains:register` — buying still ends at a Stripe
checkout the user pays, and DNS/transfers at an emailed confirmation, so the
scope is not the safety mechanism. For CI or long-lived credentials, mint a
key in Settings → API keys (scopes chosen at mint time) and store it with
`deployd login --key`.

Non-interactive (CI, agents): set `DEPLOYD_API_KEY` in the environment. It
overrides the config file. **Never echo the key or write it to any other
file.** If there is no key, stop and ask the user to run `deployd login` or
provide one — do not guess.

Check who you are before acting:

```bash
deployd whoami        # agency name, key scopes, draft quota
```

## Commands

```bash
deployd sites                              # list the agency's sites
deployd create "Acme Bakery"               # create a draft site
deployd create "Acme" --dir ./build        # …and upload a folder into it
deployd pull --site <id> --dir ./site      # download the site's content
                                           #  (skips identical files, never
                                           #   deletes local ones)
deployd push --site <id> --dir ./site      # upload a folder as a new version
                                           # (a sync; --no-delete keeps
                                           #  remote files absent locally)

deployd feedback --site <id>               # unresolved feedback: comment, page,
                                           #  selected elements (--all for history)
deployd feedback resolve <fid> --site <id> # mark feedback handled

deployd domains                            # domains the agency owns
deployd domains check acme.com             # availability + customer price
                                           #  (--country PT adds a VAT estimate)
deployd domains buy acme.com --site <id>   # buy (returns a payment link)
                                           # optional registrant, all optional:
                                           #  --owner-email --owner-name
                                           #  --owner-org --owner-phone
                                           #  --owner-address --owner-city
                                           #  --owner-zip --owner-state
                                           #  --owner-country <ISO2>
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

2. **The registrant is optional, and never invented locally.** The `--owner-*`
   flags name who the domain is registered to — a public WHOIS record. Pass
   only what the user actually told you; anything omitted is filled in
   server-side with the account's own email and the Deployd company contact.
   Never guess an address or a phone number to fill a flag. `domains buy`
   prints the registrant it will use before the confirmation prompt.

3. **DNS changes and transfers-out are NOT live when the command returns.**
   They apply only after someone clicks an emailed confirmation showing the
   exact change. The email goes to an address already registered on the domain
   (the customer, or the agency that manages them) — `--confirm-to <email>`
   picks among those addresses but can never add a new one. Never tell the
   user a DNS change or transfer is done until it is confirmed (`--wait`, or
   `deployd confirm-status <id>`).

4. **Quote the total, not a part of it.** `domains check` prints the customer
   price itemised — the cheapest registrar's cost plus a flat management fee,
   with a VAT estimate on top for EU countries (`--country PT`). Explaining
   that breakdown is fine; quoting the registrar cost as the price is not.

5. **Scopes are explicit.** A key without `domains:register`, `dns:write` or
   `domains:write` cannot do those things — that is deliberate, because they
   spend money or can take a site offline. On an `insufficient_scope` error,
   tell the user to mint a key with that scope in Settings → API keys; do not
   hunt for workarounds.

6. **Draft quota.** Every account has a draft-site allowance — free: one,
   Creator Pro: five, agencies: 25 plus purchasable packs of 10. `create`
   fails with the numbers when it is spent; publishing a draft frees its
   slot.

7. **A domain is never "claimed".** `create` takes no domain, deliberately —
   an unverified domain on a site would be a claim on a name someone else may
   own. Attach a domain only through `domains buy --site <id>` or
   `transfer in`, both of which prove control.

8. **Feedback is the edit queue.** `feedback` lists what reviewers left on
   the preview page — comment, page, and the exact elements they selected
   (xpath + HTML snippet), which is enough context to make the edit. Errored
   items stay listed until a person resolves them. Resolve only feedback that
   has actually been addressed; an `in_progress` item cannot be resolved while
   the agent is working on it.

9. **Uploads are versions.** `push` stages files and then finalizes them into
   a new version atomically — an interrupted push leaves the previous version
   intact. It syncs: remote files absent from the folder are removed unless
   `--no-delete` is passed.

10. **To update an existing site, pull it first.** `pull` then edit then
   `push` is the update loop. Pushing a folder that was never pulled
   replaces the site's content with the folder (push syncs) — only do that
   deliberately.

## Errors worth recognising

| Error | Meaning | What to do |
|---|---|---|
| `Invalid or expired API key` | Bad, revoked or expired key | Ask the user for a fresh key |
| `insufficient_scope` | Key lacks the needed scope | Mint a key with that scope |
| `draft_limit_reached` | Draft quota spent | Publish a draft or buy extra slots |
| `already taken` on buy | Domain registered elsewhere | Suggest alternatives via `domains check` |
| `premium` on buy | Premium-priced name | Refused by design; pick another name |
