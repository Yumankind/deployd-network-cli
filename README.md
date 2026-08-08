# deployd-network-cli

The command line for [Deployd Studio](https://deployd.app). Create draft
websites, check and buy domains, and manage DNS — authenticated with an API
key from any Deployd account, scoped to that account's own sites and nothing
else. Your plan sets the draft quota (free: one draft at a time, Creator
Pro: five, agency: 25+), never the door.

```bash
npm install -g deployd-network-cli
```

## Sign in

```bash
deployd login
```

opens your browser: confirm the code on screen matches your terminal and
click **Authorize**. The CLI
receives a **session token that lasts 24 hours and only works from the
network that requested it** — lifted from your laptop, it is useless
anywhere else. Session tokens carry the default scopes only.

For CI, or for the sensitive scopes a session deliberately lacks
(`domains:register`, `dns:write`, `domains:write`), mint a key in
**Settings → API keys** and either run `deployd login --key` or set
`DEPLOYD_API_KEY` (it takes precedence).

Credentials are stored in `~/.deployd/config.json` (mode `0600`), never in an
environment variable — env vars leak into `ps`, CI logs and crash reports.

## Commands

```
deployd whoami                            agency, key scopes, draft quota
deployd sites                             list your sites
deployd create "Acme Bakery"              create a draft site
deployd create "Acme" --dir ./build       …and upload a folder into it
deployd push --site <id> --dir ./build    upload a folder as a new version

deployd feedback --site <id>              unresolved feedback (comment, page,
                                          selected elements); --all for history
deployd feedback resolve <fid> --site <id>  mark feedback handled

deployd domains                           domains you own
deployd domains check acme.com            availability + price, every registrar
deployd domains buy acme.com --site ID    buy it (pay first, registered after)
deployd domains status <purchaseId>       how a purchase is going

deployd dns acme.com                      list DNS records
deployd dns acme.com add A www 1.2.3.4    add a record       (email-confirmed)
deployd dns acme.com set <id> 5.6.7.8     change one         (email-confirmed)
deployd dns acme.com rm <id>              delete one         (email-confirmed)

deployd transfer in acme.com --auth-code X   bring a domain to Deployd
deployd transfer out acme.com                release it       (email-confirmed)
deployd transfer status acme.com             inbound transfer progress

deployd help                              everything else
```

## Uploading

`push` (and `create --dir`) uploads a folder as a **new version** of the
site: files are staged in batches, then finalized atomically — an interrupted
upload leaves the previous version untouched. The upload is a sync: remote
files absent from your folder are removed (`--no-delete` keeps them).
Dotfiles and `node_modules` are never uploaded. There is no way to "claim" a
domain at creation — attach one by buying or transferring it in, which proves
you control it.

## Two things worth knowing

**Buying is payment-first.** `domains buy` returns a Stripe checkout link; the
domain is registered only after the payment clears, and refunded automatically
if registration then fails. The price shown by `domains check` is the price
charged.

**Sensitive changes are email-confirmed.** DNS changes and outbound transfers
do not apply when the command runs. A confirmation email — showing exactly
what will change — goes to an address already registered on the domain (the
customer, or the agency that manages them), and the change applies when
someone clicks it. `--confirm-to` chooses among those addresses; it cannot add
one. A key alone can never move a domain or its DNS.

## Scopes

Keys carry explicit scopes. The default set covers reading and creating sites
and checking domains; `domains:register` (spends money), `dns:write` and
`domains:write` (can take a site offline) must be granted deliberately when
the key is created.

## Agent skill

An Agent Skill teaching AI agents (Claude Code and compatible tools) to
install and drive this CLI ships with the package at
[`skills/deployd-cli/SKILL.md`](skills/deployd-cli/SKILL.md) — including the
rules an agent must not get wrong: payment before registration, nothing live
until the confirmation email is clicked, customer prices only.

To use it, copy the folder where your agent looks for skills:

```bash
cp -r "$(npm root -g)/deployd-network-cli/skills/deployd-cli" ~/.claude/skills/
```

(or into a project's `.claude/skills/` to share it with a team). In the
platform monorepo the same skill lives at `.claude/skills/deployd-cli/` and is
picked up automatically.
