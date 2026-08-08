#!/usr/bin/env node
/**
 * `deployd` — the agency CLI.
 *
 *   deployd login                              sign in from the browser (24h, IP-bound)
 *   deployd whoami                             which agency, which scopes, draft quota
 *   deployd sites                              list the agency's sites
 *   deployd create "Acme Bakery"               create a draft, print its preview URL
 *   deployd create "Acme" --dir ./build        …and upload a folder into it
 *   deployd domains check acme.com             availability and price, every registrar
 *   deployd domains buy acme.com --site <id>   register it
 *   deployd domains                            domains this agency owns
 *   deployd push --site <id> --dir ./build     upload a folder as a new version
 *
 * Unlike `scripts/upload-site.js`, which runs on platform admin credentials and
 * is ours alone, this authenticates with an agency API key over the public API.
 * It reaches that agency's sites and nothing else, which is the whole reason it
 * exists — the older script cannot be handed to a customer.
 *
 * The key is stored in ~/.deployd/config.json at mode 0600, not in an
 * environment variable: env vars leak into `ps`, CI logs and crash reports.
 * DEPLOYD_API_KEY still overrides it, for CI.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')

const CONFIG_DIR = path.join(os.homedir(), '.deployd')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const DEFAULT_HOST = process.env.DEPLOYD_HOST || 'https://deployd.app'

// ── Config ───────────────────────────────────────────────────────────────────

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeConfig(config) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 })
}

function apiKey() {
  if (process.env.DEPLOYD_API_KEY) return process.env.DEPLOYD_API_KEY

  const config = readConfig()
  if (!config.apiKey) {
    fail('Not logged in. Run `deployd login` to sign in from the browser.')
  }
  // A browser-approved session carries its expiry; say "session expired"
  // instead of letting the server's generic 401 look like a broken key.
  if (config.apiKeyExpiresAt && Date.parse(config.apiKeyExpiresAt) < Date.now()) {
    fail('Your CLI session expired. Run `deployd login` to sign in again.')
  }
  return config.apiKey
}

function host() {
  return readConfig().host || DEFAULT_HOST
}

// ── Output ───────────────────────────────────────────────────────────────────

const bold = s => `\x1b[1m${s}\x1b[0m`
const dim = s => `\x1b[2m${s}\x1b[0m`
const green = s => `\x1b[32m${s}\x1b[0m`
const red = s => `\x1b[31m${s}\x1b[0m`
const yellow = s => `\x1b[33m${s}\x1b[0m`

function fail(message) {
  console.error(`${red('✗')} ${message}`)
  process.exit(1)
}

function prompt(question, { hidden = false } = {}) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

    if (!hidden) {
      rl.question(question, answer => { rl.close(); resolve(answer.trim()) })
      return
    }

    // Suppress echo so a pasted key does not stay on screen or in scrollback.
    const onData = char => {
      if (['\n', '\r', ''].includes(char.toString())) process.stdin.removeListener('data', onData)
      else process.stdout.write('\x1b[2K\x1b[200D' + question)
    }
    process.stdout.write(question)
    process.stdin.on('data', onData)
    rl.question('', answer => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

// ── API ──────────────────────────────────────────────────────────────────────

async function api(method, endpoint, body, { raw = false, auth = true } = {}) {
  let response
  try {
    response = await fetch(`${host()}${raw ? '' : '/api/v1'}${endpoint}`, {
      method,
      headers: {
        // The login flow itself runs before any key exists.
        ...(auth ? { Authorization: `Bearer ${apiKey()}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    fail(`Could not reach ${host()}: ${err.message}`)
  }

  const text = await response.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    fail(`Unexpected response from ${host()} (HTTP ${response.status})`)
  }

  if (!response.ok) {
    // The quota refusal is the one error where the useful part is the numbers,
    // not the sentence.
    if (data.code === 'draft_limit_reached' && data.quota) {
      fail(`${data.error}\n  ${dim(`Drafts: ${data.quota.used}/${data.quota.allowance}`)}`)
    }
    if (data.code === 'insufficient_scope') {
      fail(`${data.error}\n  ${dim('Mint a key with the scope it needs in Settings → API keys.')}`)
    }
    fail(data.error || `HTTP ${response.status}`)
  }

  return data
}

// ── Commands ─────────────────────────────────────────────────────────────────

const commands = {}

commands.login = async (args = {}) => {
  // Two ways in. The default opens the browser and has the signed-in user
  // approve this machine — the resulting session token lives 24 hours and
  // only works from this machine's public IP. `--key` is the old way: paste
  // a dashboard-minted key, which is what you want for CI or for the
  // sensitive scopes a session token deliberately does not carry.
  if (args.key) return loginWithPastedKey()
  return loginViaBrowser()
}

async function loginWithPastedKey() {
  const key = await prompt('API key: ', { hidden: true })
  if (!key) fail('No key entered.')
  if (!key.startsWith('dpa_')) fail('That does not look like a Deployd API key (they start with dpa_).')
  return storeVerifiedKey(key, null)
}

async function loginViaBrowser() {
  const started = await api('POST', '/api/cli-auth/start', {}, { raw: true, auth: false })

  // The code IS the phishing defence: the person approves only if the browser
  // shows exactly what the terminal shows. So the terminal shows it first,
  // unmissably, and the browser opens only when they say so — a page that
  // pops up before you have seen the code is a comparison nobody makes.
  const spaced = started.userCode.split('').join(' ')
  const inner = `      ${spaced}      `
  const line = '─'.repeat(inner.length)
  const pad = ' '.repeat(inner.length)

  console.log('\nYour login code — approve it ONLY if the browser shows exactly this:\n')
  console.log(`  ┌${line}┐`)
  console.log(`  │${pad}│`)
  console.log(`  │${'\x1b[1m\x1b[36m'}${inner}${'\x1b[0m'}│`)
  console.log(`  │${pad}│`)
  console.log(`  └${line}┘`)

  // The browser opens only for a human at a TTY, and only after ENTER. A
  // non-interactive run (CI, an agent, a test) gets the URL printed and
  // nothing else — spawning a browser from a headless process is never what
  // anyone wanted, and under jest it opened the mocked URL on the
  // developer's actual desktop.
  if (process.stdin.isTTY) {
    await prompt(dim('\nPress ENTER to open the browser and approve… '))
    openBrowser(started.verificationUrl)
  }
  console.log(dim(`  Approve here: ${started.verificationUrl}`))
  process.stdout.write(dim('  Waiting for approval'))

  const deadline = Date.parse(started.expiresAt)
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, (started.interval || 3) * 1000))
    process.stdout.write(dim('.'))

    const state = await api('POST', '/api/cli-auth/poll', { deviceCode: started.deviceCode }, { raw: true, auth: false })
    if (state.status === 'pending') continue
    if (state.status === 'expired') break

    process.stdout.write('\n')
    console.log(dim(`  Session lasts 24h and only works from this network (${state.boundToIp}).`))
    return storeVerifiedKey(state.token, state.expiresAt)
  }

  process.stdout.write('\n')
  fail('The login request expired before it was approved. Run `deployd login` again.')
}

async function storeVerifiedKey(key, expiresAt) {
  // Verify before storing, so a typo fails now rather than on the next command.
  const config = readConfig()
  writeConfig({ ...config, apiKey: key, apiKeyExpiresAt: expiresAt || null })

  let me
  try {
    me = await api('GET', '/whoami')
  } catch (err) {
    writeConfig(config)   // roll back; do not leave a bad key on disk
    throw err
  }

  console.log(`${green('✓')} Signed in to ${bold((me.agency || me.account).name)}`)
  console.log(dim(`  key ${me.key.name} · scopes: ${me.key.scopes.join(', ')}`))
  if (expiresAt) console.log(dim(`  session expires ${new Date(expiresAt).toLocaleString()}`))
  console.log(dim(`  stored in ${CONFIG_FILE}`))
}

/** Open a URL in the default browser; printing it already happened, so best-effort. */
function openBrowser(url) {
  const { spawn } = require('child_process')
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open'
  try {
    spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref()
  } catch { /* the URL is on screen */ }
}

commands.logout = async () => {
  const config = readConfig()
  delete config.apiKey
  writeConfig(config)
  console.log(`${green('✓')} Key removed from ${CONFIG_FILE}`)
  console.log(dim('  It is still valid — revoke it in Settings → API keys if it leaked.'))
}

commands.whoami = async () => {
  const me = await api('GET', '/whoami')
  // A key belongs to an agency or to a Pro account; the response says which.
  const who = me.agency || me.account
  const kind = me.agency ? '' : dim(' · Pro account')
  console.log(`${bold(who.name)} ${dim(`(${who.id})`)}${kind}`)
  console.log(`  plan     ${who.plan} · ${who.status}`)
  console.log(`  drafts   ${me.quota.used}/${me.quota.allowance} used`)
  console.log(`  key      ${me.key.name}`)
  console.log(`  scopes   ${me.key.scopes.join(', ')}`)
}

commands.sites = async () => {
  const { sites } = await api('GET', '/sites')
  if (sites.length === 0) {
    console.log('No sites yet. Create one with `deployd create "Name"`.')
    return
  }

  for (const site of sites) {
    const label = site.isDraft ? dim('draft') : green('live')
    console.log(`${label}  ${bold(site.name || site.siteId)}`)
    console.log(`       ${dim(site.siteId)}`)
    console.log(`       ${site.domain ? `https://${site.domain}` : site.previewUrl}`)
  }
  console.log(dim(`\n${sites.length} site(s)`))
}

commands.create = async args => {
  const name = args._[0]
  if (!name) fail('Usage: deployd create "Site name" [--dir ./folder]')

  // There is no --domain here on purpose. A domain reaches a site only
  // through a door that proves control of it: buying (`deployd domains buy
  // <domain> --site <id>`) or transferring in. Anything else would be an
  // unverified claim on a name someone else may own.
  if (args.domain) {
    fail('Sites are created without a domain. Buy one with ' +
      '`deployd domains buy <domain> --site <id>` or bring one with ' +
      '`deployd transfer in <domain>` after creating the site.')
  }

  const site = await api('POST', '/sites', { name })

  console.log(`${green('✓')} Created ${bold(site.name)}`)
  console.log(`  site id  ${site.siteId}`)
  console.log(`  preview  ${site.previewUrl}`)
  console.log(dim(`  drafts   ${site.quota.used}/${site.quota.allowance} used`))

  // `create --dir ./folder` is create-and-upload in one step.
  if (args.dir) {
    console.log('')
    return uploadFolder(site.siteId, args)
  }

  console.log(dim(`\nNext: deployd push --site ${site.siteId} --dir ./your-folder`))
}

commands.domains = async args => {
  const sub = args._[0]

  if (!sub) {
    const { domains } = await api('GET', '/domains')
    if (domains.length === 0) {
      console.log('No domains registered through Deployd.')
      return
    }
    for (const d of domains) {
      const provider = d.provider === 'external' ? `external${d.external_registrar ? ` (${d.external_registrar})` : ''}` : d.provider
      const price = d.price != null ? ` · ${d.currency || 'USD'} ${Number(d.price).toFixed(2)}/yr` : ''
      const expiry = d.expiresAt ? ` · expires ${String(d.expiresAt).slice(0, 10)}` : ''
      console.log(`${bold(d.domain)}  ${dim(`${d.status} · ${provider}${price}${expiry}`)}`)
    }
    return
  }

  if (sub === 'check') {
    const domain = args._[1]
    if (!domain) fail('Usage: deployd domains check example.com')

    const result = await api('GET', `/domains/check?domain=${encodeURIComponent(domain)}`)

    if (result.available === false) {
      console.log(`${red('✗')} ${bold(result.domain)} is taken`)
      return
    }
    if (result.available === null) {
      console.log(`? ${bold(result.domain)} — no registrar could answer`)
    } else {
      console.log(`${green('✓')} ${bold(result.domain)} is available`)
    }

    // The price. Registrar costs are shown dimmed underneath because they are
    // ours, not the customer's — quoting a registrar's number as the price is
    // how someone ends up expecting to pay it.
    if (result.pricing) {
      const p = result.pricing
      console.log(`  ${bold(`${p.currency} ${p.netPrice.toFixed(2)}`)}/year`)
      if (p.vatRate > 0) {
        console.log(dim(`  ${p.currency} ${p.grossPrice.toFixed(2)} incl. ${p.vatRate}% VAT`))
      }
    } else if (result.premiumOnly) {
      console.log(`  ${red('premium domain')} ${dim('— needs a manual quote')}`)
    }

    console.log(dim('\n  registrar costs:'))
    for (const quote of result.quotes) {
      if (quote.error) {
        console.log(`  ${dim(`  ${quote.provider}: ${quote.error}`)}`)
      } else if (quote.available && typeof quote.price === 'number') {
        const best = result.best && result.best.provider === quote.provider
        console.log(dim(`    ${quote.provider.padEnd(11)} ${quote.currency} ${quote.price.toFixed(2)}`) + (best ? green('  ← used') : '') + (quote.premium ? red('  premium') : ''))
      } else {
        console.log(dim(`    ${quote.provider}: not available here`))
      }
    }
    return
  }

  if (sub === 'status') {
    const id = args._[1]
    if (!id) fail('Usage: deployd domains status <purchaseId>')

    const purchase = await api('GET', `/domains/purchases/${encodeURIComponent(id)}`)
    const colour = { registered: green, refunded: yellow, refund_failed: red }[purchase.status] || dim
    console.log(`${bold(purchase.domain)}  ${colour(purchase.status)}`)
    console.log(dim(`  ${purchase.currency} ${Number(purchase.price).toFixed(2)} · ${purchase.provider || 'pending'}`))
    if (purchase.failureReason) console.log(red(`  ${purchase.failureReason}`))
    return
  }

  if (sub === 'buy') {
    const domain = args._[1]
    if (!domain) fail('Usage: deployd domains buy example.com [--site <siteId>] [--provider namesilo]')

    const quote = await api('GET', `/domains/check?domain=${encodeURIComponent(domain)}`)
    if (quote.available === false) fail(`${domain} is already taken.`)
    if (!quote.best) fail(`No registrar can sell ${domain} right now.`)

    const p = quote.pricing
    console.log(`${bold(quote.domain)} — ${bold(`${p.currency} ${p.netPrice.toFixed(2)}`)}/year`)
    if (p.vatRate > 0) console.log(dim(`  ${p.currency} ${p.grossPrice.toFixed(2)} incl. ${p.vatRate}% VAT`))
    console.log(dim(`  registered via ${quote.best.provider}`))

    const answer = await prompt('Register it? [y/N] ')
    if (!/^y(es)?$/i.test(answer)) {
      console.log('Aborted.')
      return
    }

    const purchase = await api('POST', '/domains/register', {
      domain,
      siteId: args.site || null,
      years: args.years ? Number(args.years) : 1,
    })

    // Nothing is bought yet. Saying "registered" here would be wrong, and the
    // customer would go looking for a domain that does not exist.
    console.log(`${yellow('!')} ${bold(purchase.domain)} is reserved, pending payment`)
    console.log(`  price   ${purchase.currency} ${Number(purchase.price).toFixed(2)}${purchase.vatRate ? dim(` + ${purchase.vatRate}% VAT`) : ''}`)
    console.log(`  pay     ${purchase.checkoutUrl}`)
    console.log(dim(`  quote expires ${new Date(purchase.expiresAt).toLocaleTimeString()}`))
    console.log(dim(`\n  The domain is registered once payment clears, and refunded automatically if it cannot be.`))
    console.log(dim(`  Check progress: deployd domains status ${purchase.purchaseId}`))
    return
  }

  fail(`Unknown subcommand "${sub}". Try: check, buy, or no argument to list.`)
}

/**
 * DNS record management.
 *
 *   deployd dns acme.com                        list records
 *   deployd dns acme.com add A www 203.0.113.9  add one
 *   deployd dns acme.com set <id> 203.0.113.9   change an answer
 *   deployd dns acme.com rm <id>                delete one
 *
 * Every change is confirmed by email before it runs, so these commands return a
 * pending id rather than a result. `--wait` polls until someone clicks.
 *
 * `--confirm-to <email>` picks which registered address gets the email — the
 * end customer's or the agency's. It can only choose among addresses already
 * on file for the domain; the server refuses anything else, so the flag can
 * narrow the recipients but never smuggle in a new one.
 */

/** The `--confirm-to` flag, normalised for the API's `confirmTo` field. */
function confirmTo(args) {
  const value = args['confirm-to'] || args.confirmTo
  return value ? { confirmTo: value } : {}
}

commands.dns = async args => {
  const domain = args._[0]
  if (!domain) fail('Usage: deployd dns <domain> [add|set|rm] …')

  const action = args._[1]

  if (!action) {
    const { records } = await api('GET', `/domains/${encodeURIComponent(domain)}/dns`)
    if (records.length === 0) { console.log('No DNS records.'); return }

    console.log(bold(domain))
    for (const r of records) {
      const priority = r.priority != null ? ` p${r.priority}` : ''
      console.log(`  ${dim(String(r.id).padEnd(12))} ${r.type.padEnd(6)} ${String(r.host).padEnd(18)} ${r.answer}${dim(`  ttl=${r.ttl}${priority}`)}`)
    }
    return
  }

  if (action === 'add') {
    const [, , type, host, answer] = args._
    if (!type || !host || !answer) fail('Usage: deployd dns <domain> add <TYPE> <host> <answer>')

    const pending = await api('POST', `/domains/${encodeURIComponent(domain)}/dns`, {
      type: type.toUpperCase(), host, answer,
      ttl: args.ttl ? Number(args.ttl) : undefined,
      priority: args.priority ? Number(args.priority) : undefined,
      ...confirmTo(args),
    })
    return awaitConfirmation(pending, args)
  }

  if (action === 'set') {
    const [, , recordId, answer] = args._
    if (!recordId || !answer) fail('Usage: deployd dns <domain> set <recordId> <answer>')

    const pending = await api('PUT', `/domains/${encodeURIComponent(domain)}/dns/${encodeURIComponent(recordId)}`, {
      answer,
      ttl: args.ttl ? Number(args.ttl) : undefined,
      ...confirmTo(args),
    })
    return awaitConfirmation(pending, args)
  }

  if (action === 'rm' || action === 'delete') {
    const recordId = args._[2]
    if (!recordId) fail('Usage: deployd dns <domain> rm <recordId>')

    const pending = await api('DELETE', `/domains/${encodeURIComponent(domain)}/dns/${encodeURIComponent(recordId)}`, args['confirm-to'] ? confirmTo(args) : undefined)
    return awaitConfirmation(pending, args)
  }

  fail(`Unknown dns subcommand "${action}". Try: add, set, rm, or none to list.`)
}

/**
 * Transfers.
 *
 *   deployd transfer in acme.com --auth-code XXXX
 *   deployd transfer out acme.com
 *   deployd transfer status acme.com
 */
commands.transfer = async args => {
  const [direction, domain] = args._
  if (!direction || !domain) fail('Usage: deployd transfer <in|out|status> <domain>')

  if (direction === 'in') {
    const authCode = args['auth-code'] || args.authCode
    if (!authCode) fail('Pass --auth-code, the EPP code from your current registrar.')

    const result = await api('POST', `/domains/${encodeURIComponent(domain)}/transfer-in`, {
      authCode, years: args.years ? Number(args.years) : 1,
    })
    console.log(`${green('✓')} Transfer of ${bold(domain)} started via ${result.provider}`)
    console.log(`  price   ${result.currency} ${result.price}`)
    console.log(dim(`  ${result.message}`))
    return
  }

  if (direction === 'status') {
    const result = await api('GET', `/domains/${encodeURIComponent(domain)}/transfer-in`)
    console.log(`${bold(domain)}  ${result.status}`)
    return
  }

  if (direction === 'out') {
    console.log(`This releases ${bold(domain)} so another registrar can take it.`)
    const answer = await prompt('Continue? [y/N] ')
    if (!/^y(es)?$/i.test(answer)) { console.log('Aborted.'); return }

    const pending = await api('POST', `/domains/${encodeURIComponent(domain)}/transfer-out`, args['confirm-to'] ? confirmTo(args) : undefined)
    return awaitConfirmation(pending, args)
  }

  fail(`Unknown direction "${direction}". Try: in, out, status.`)
}

/**
 * Report a pending confirmation, and optionally wait for it.
 *
 * The command has not done anything yet — it has asked someone to approve it.
 * Saying "queued" rather than "done" is the difference between someone
 * believing DNS is live and knowing it is not.
 */
async function awaitConfirmation(pending, args) {
  console.log(`${yellow('!')} ${bold(pending.description.title)} needs confirming`)
  console.log(`  ${pending.description.summary}`)
  console.log(dim(`  emailed to ${pending.sentTo.join(', ')}`))
  console.log(dim(`  expires ${new Date(pending.expiresAt).toLocaleTimeString()}`))

  if (!args.wait) {
    console.log(dim(`\n  Waiting? Re-run with --wait, or check: deployd confirm-status ${pending.id}`))
    return
  }

  process.stdout.write(dim('\n  Waiting for confirmation'))
  const deadline = Date.parse(pending.expiresAt)

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000))
    process.stdout.write(dim('.'))

    const state = await api('GET', `/confirm/${pending.id}/status`, null, { raw: true })
    if (state.status === 'used') { console.log(`\n${green('✓')} Confirmed and applied.`); return }
    if (state.status === 'rejected') { console.log(`\n${red('✗')} Rejected.`); return }
    if (state.status === 'expired') break
  }

  console.log(`\n${red('✗')} Expired without confirmation.`)
}

commands['confirm-status'] = async args => {
  const id = args._[0]
  if (!id) fail('Usage: deployd confirm-status <id>')
  const state = await api('GET', `/confirm/${id}/status`, null, { raw: true })
  console.log(`${state.status}  ${dim(state.description?.summary || '')}`)
}

/**
 * Feedback left on the preview/feedback page.
 *
 *   deployd feedback --site <id>                unresolved: comment, page, elements
 *   deployd feedback --site <id> --all          include resolved
 *   deployd feedback resolve <id…> --site <id>  mark handled
 *
 * "Unresolved" includes errored items on purpose — an item the agent failed
 * on is exactly the one a person needs to see.
 */
commands.feedback = async args => {
  if (!args.site) fail('Pass --site <siteId>.')
  const action = args._[0]

  if (action === 'resolve') {
    const ids = args._.slice(1)
    if (ids.length === 0) fail('Usage: deployd feedback resolve <feedbackId…> --site <id>')

    for (const id of ids) {
      const result = await api('POST',
        `/sites/${encodeURIComponent(args.site)}/feedback/${encodeURIComponent(id)}/resolve`)
      console.log(result.alreadyResolved
        ? `${dim('·')} ${id} ${dim('was already resolved')}`
        : `${green('✓')} ${id} resolved`)
    }
    return
  }
  if (action) fail(`Unknown feedback subcommand "${action}". Try: resolve, or none to list.`)

  const { feedback, unresolved } = await api('GET',
    `/sites/${encodeURIComponent(args.site)}/feedback${args.all ? '?all=1' : ''}`)

  if (feedback.length === 0) {
    console.log(args.all ? 'No feedback on this site.' : 'No unresolved feedback. ✨')
    return
  }

  for (const item of feedback) {
    const mark = item.resolved ? green('✓') : yellow('●')
    const when = item.created ? new Date(item.created).toLocaleString() : ''
    console.log(`${mark} ${bold(item.id)}  ${dim(`${item.status} · ${when}`)}`)
    console.log(`  ${item.comment}`)
    if (item.page) console.log(dim(`  page      ${item.page}`))
    for (const el of item.selectedElements) {
      console.log(dim(`  element   <${el.tag || '?'}>  ${el.xpath || ''}`))
      if (el.htmlPreview) console.log(dim(`            ${el.htmlPreview}`))
    }
    if (item.attachments) console.log(dim(`  ${item.attachments} attachment(s)`))
    if (item.statusMessage) console.log(dim(`  note      ${item.statusMessage}`))
    console.log('')
  }
  console.log(dim(`${unresolved} unresolved · resolve with: deployd feedback resolve <id> --site ${args.site}`))
}

commands.push = async args => {
  if (!args.site) fail('Pass --site <siteId>. (Create one first: deployd create "Name")')
  if (!args.dir) fail('Pass --dir <folder>.')
  return uploadFolder(args.site, args)
}

/**
 * Upload a folder as a new version of a site, over the public API.
 *
 * Batched: files go up in requests of at most 100 files / 8 MB raw, then one
 * finalize call turns the batches into a version — pruning remote files that
 * are absent locally (the upload is a sync; --no-delete keeps them). Nothing
 * about the site changes until the finalize, so a dead connection mid-upload
 * leaves the old version intact.
 */
async function uploadFolder(siteId, args) {
  const root = path.resolve(args.dir)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    fail(`Not a folder: ${root}`)
  }

  const files = collectFiles(root)
  if (files.length === 0) fail(`Nothing to upload in ${root}`)
  if (!files.some(f => f === 'index.html')) {
    console.log(`${yellow('!')} No index.html at the root — the site will have no front page.`)
  }

  const totalBytes = files.reduce((n, f) => n + fs.statSync(path.join(root, f)).size, 0)
  console.log(`Uploading ${bold(String(files.length))} file(s), ${formatBytes(totalBytes)} → site ${siteId}`)

  if (args['dry-run']) {
    for (const f of files) console.log(`  ${dim('would send')} ${f}`)
    console.log(dim('\n--dry-run: nothing uploaded.'))
    return
  }

  const BATCH_FILES = 100
  const BATCH_BYTES = 8 * 1024 * 1024

  let batch = []
  let batchBytes = 0
  let sent = 0

  const flush = async () => {
    if (batch.length === 0) return
    await api('POST', `/sites/${encodeURIComponent(siteId)}/files`, { files: batch })
    sent += batch.length
    process.stdout.write(`\r  ${sent}/${files.length} uploaded`)
    batch = []
    batchBytes = 0
  }

  for (const rel of files) {
    const absolute = path.join(root, rel)
    const buffer = fs.readFileSync(absolute)
    if (batch.length >= BATCH_FILES || batchBytes + buffer.length > BATCH_BYTES) await flush()
    batch.push({ path: rel, content: buffer.toString('base64'), contentType: contentTypeOf(rel) })
    batchBytes += buffer.length
  }
  await flush()
  process.stdout.write('\n')

  const version = await api('POST', `/sites/${encodeURIComponent(siteId)}/versions`, {
    manifest: files,
    prune: !args['no-delete'],
  })

  console.log(`${green('✓')} Version ${bold('v' + version.version)} is live on the preview`)
  if (version.pruned) console.log(dim(`  removed ${version.pruned} remote file(s) absent locally`))
  console.log(`  ${version.previewUrl}`)
}

/** Walk a folder into sorted relative paths, skipping what never belongs on a site. */
function collectFiles(root) {
  const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg'])
  const out = []

  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue          // .git, .env, .DS_Store
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name))
        continue
      }
      if (!entry.isFile()) continue                     // sockets, symlinks
      out.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'))
    }
  }

  walk(root)
  return out.sort()
}

/** Just the types a static site actually ships; the server defaults the rest. */
function contentTypeOf(rel) {
  const types = {
    html: 'text/html', css: 'text/css', js: 'application/javascript',
    mjs: 'application/javascript', json: 'application/json', txt: 'text/plain',
    xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
    ttf: 'font/ttf', otf: 'font/otf', mp4: 'video/mp4', webm: 'video/webm',
    mp3: 'audio/mpeg', pdf: 'application/pdf', wasm: 'application/wasm',
    webmanifest: 'application/manifest+json', map: 'application/json',
  }
  return types[rel.split('.').pop().toLowerCase()] || 'application/octet-stream'
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

commands.help = async () => {
  console.log(`${bold('deployd')} — build and publish websites from the command line

  ${bold('deployd login')}                          sign in from the browser (24h session)
      --key                                paste a dashboard-minted API key instead
  ${bold('deployd whoami')}                         agency, scopes and draft quota
  ${bold('deployd sites')}                          list this agency's sites
  ${bold('deployd create')} "Acme Bakery"           create a draft site
      --dir ./folder                       …and upload a folder into it

  ${bold('deployd domains')}                        domains this agency owns
  ${bold('deployd domains check')} acme.com         availability and price
  ${bold('deployd domains buy')} acme.com           buy it (pay, then it registers)
      --site <siteId>                      attach it to a site
      --years <n>                          registration term
  ${bold('deployd domains status')} <purchaseId>  how a purchase is going

  ${bold('deployd dns')} acme.com                    list DNS records
  ${bold('deployd dns')} acme.com add A www 1.2.3.4   add a record
  ${bold('deployd dns')} acme.com set <id> 1.2.3.4    change one
  ${bold('deployd dns')} acme.com rm <id>             delete one
      --wait                               block until confirmed by email
      --confirm-to a@b.com                 send the confirmation to this
                                           registered address (customer or
                                           agency — never a new one)

  ${bold('deployd transfer in')} acme.com --auth-code X   bring a domain here
  ${bold('deployd transfer out')} acme.com            release it to another registrar
  ${bold('deployd transfer status')} acme.com         how an inbound transfer is going

  ${bold('deployd feedback')} --site <id>            unresolved feedback: comment, page, elements
  ${bold('deployd feedback resolve')} <fid> --site <id>  mark it handled
      --all                                include resolved items

  ${bold('deployd push')} --site <id> --dir ./build upload a folder as a new version
      --dry-run                            show what would change
      --no-delete                          keep remote files not present locally

  ${dim(`API host: ${host()}   ·   key: ${CONFIG_FILE}`)}
`)
}

// ── Entry ────────────────────────────────────────────────────────────────────

/** Minimal parser: `--flag value`, `--flag`, positionals in `_`. */
function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const name = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) args[name] = true
    else { args[name] = next; i++ }
  }
  return args
}

async function main() {
  const [, , command, ...rest] = process.argv
  const run = commands[command || 'help']

  if (!run) {
    console.error(`Unknown command "${command}".\n`)
    await commands.help()
    process.exit(1)
  }

  await run(parseArgs(rest))
}

function run() {
  main().catch(err => fail(err.message))
}

if (require.main === module) {
  run()
}

module.exports = { parseArgs, commands, run }
