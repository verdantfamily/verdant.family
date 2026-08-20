# Deploying Verdant to Robinhood mainnet

A Verdant deployment cannot be corrected. The hook's address is mined and v4 reads its
permissions from that address on every call; the factory, both registries and the
deployer name each other in immutables; the anchor can create exactly once. There is no
owner who can rewire anything and no upgrade path, which is the property the protocol is
sold on and also the reason a mistake here is not patched but abandoned — a fresh
deployment at fresh addresses, with any markets created in the meantime stranded on a
factory nobody uses.

So this is written as a checklist, in order, with the reason each step exists. Do not
skip a step because the previous one looked fine.

## 1. Decide the two addresses that cannot be changed later

**The treasury.** `FeeSplitter` takes it as an immutable at market creation, so every
market ever launched pays this address the protocol's share for as long as it trades. A
market created against the wrong treasury cannot be repointed.

**The registry owner.** This is the one live privilege in the system. It can change the
bounds and the protocol share *for markets created afterwards* — it cannot touch a live
market, which is what the immutables are for. It should be a Safe, not an EOA; canonical
Safe factories are deployed on 4663 (see V15 in [verification.md](verification.md)). The
verifier warns if this address has no code, and that warning is worth acting on rather
than acknowledging.

Neither is derivable from anything on chain, so neither can be checked by any amount of
internal consistency. They are checked against what you say you meant, in step 5.

## 2. Pre-flight

Run from the repository root. All of these must be clean before anything is broadcast.

```bash
pnpm install
pnpm test                      # the TypeScript packages
pnpm bounds:emit && git diff --exit-code -- packages/config/generated/bounds.json
cd packages/contracts
forge test                     # the full suite, no network
bash ../../scripts/fork-test.sh # the fork suite; needs network
```

Read the fork output rather than the exit status. The script deliberately passes when the
RPC is unreachable, because a CI gate that fails on someone else's outage gets ignored —
but that tolerance means a run that proved nothing looks like a run that passed. It says
so in a warning when that happens.

The fork run is the one that matters most: it launches a market against the Uniswap
actually deployed on 4663, and it is the only thing that has ever confirmed that
`IMsgSender.msgSender()` on the deployed PositionManager reports what the liquidity
guard depends on. It also prints the two gas figures — a launch is ~3.28M and the most
expensive launch the bounds permit is ~4.10M, against a 32M per-transaction cap.

If the fork suite fails on the `code.length` assertions, Uniswap has been redeployed on
4663 and the pinned addresses in `packages/config/src/chains.ts` need revisiting before
anything else happens.

## 3. Fund the operator, and understand what its nonce does not matter for

The operator is an ordinary account; it needs enough ETH for six contract creations plus
the hook mining is free (it happens off chain, in the script). Nothing about its
transaction count matters: the factory's address comes from `FactoryOrigin`, which
computes it from its own address and its own first-creation nonce, so the deployment does
not depend on the operator having a particular nonce and the sequence is identical to the
one CI runs (ADR-007).

## 4. Simulate, read the address book, then broadcast

Simulate first. This touches real chain state and produces the exact addresses the
broadcast will produce, without sending anything:

```bash
cd packages/contracts

export POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
export POSITION_MANAGER=0x58daec3116aae6D93017bAAea7749052E8a04fA7
export TREASURY=0x...            # step 1
export REGISTRY_OWNER=0x...      # step 1, a Safe

forge script script/Deploy.s.sol --rpc-url robinhood --sender 0xYOUR_OPERATOR
```

Read the printed address book. Then broadcast:

```bash
forge script script/Deploy.s.sol --rpc-url robinhood --broadcast \
  --sender 0xYOUR_OPERATOR --interactives 1
```

Set `REGISTRY_OWNER` explicitly even though it has a default. The default is the
deploying key, which would leave the register owned by whatever laptop ran the script.

## 5. Verify before telling anyone the addresses

The deployment asserts its own wiring as it goes, but those assertions run inside the
transaction that creates the contracts, against values the same script computed. Pointed
at the wrong PositionManager, it would deploy a perfectly self-consistent protocol wired
to the wrong contract and report success.

The verifier starts from the other end: given only the factory, it takes every
counterparty from what the factory itself says, then asks each of those contracts who
*they* think the factory is. It also compares the deployed register against
`bounds.json`, checks the hook's address carries exactly `0x3880`, and checks the two
intents from step 1.

It checks the admitted quote assets by name, one at a time, which is worth understanding
because nothing else would catch a failure there. The set is seeded in `ModelRegistry`'s
constructor and never again; a deployment seeded from a stale `bounds.json` refuses every
stock-paired launch with `QuoteAssetNotAdmitted` while passing every other check in this
file. On 4663 the verifier also warns when an admitted address has no code, which is how a
typo in the reviewed list surfaces before somebody tries to launch against it.

Once step 6 has recorded the addresses, this reads them from there:

```bash
bash scripts/verify-mainnet.sh
```

Before that, or to check some other deployment, name them:

```bash
FACTORY=0x... \
ORIGIN=0x... \
EXPECTED_TREASURY=0x... \
EXPECTED_REGISTRY_OWNER=0x... \
forge script script/Verify.s.sol --rpc-url robinhood
```

It broadcasts nothing and needs no key. Read every line. `FAIL` means discard the
deployment and start again at step 4 — there is nothing to repair. Warnings are things
that were not checked, or were checked and are merely unwise; both deserve a decision
rather than a glance.

## 6. Record the addresses

Put them in `packages/config/src/deployments.ts`, which is where every other package
reads them from. The deploy script prints them in the order that file wants.

Commit that with the transaction hashes in the message. This is the only durable record
of which deployment is the live one — a second, abandoned deployment is
indistinguishable from the real one by inspection, since both pass every internal check.

## 7. Verify the source on Blockscout

Etherscan does not index 4663; verification is Blockscout only. The hook arrives through
the canonical CREATE2 deployer rather than from the operator, so it is verified by
address like the others:

```bash
forge verify-contract --chain-id 4663 --verifier blockscout \
  --verifier-url https://blockscout.mainnet.chain.robinhood.com/api \
  0xHOOK src/VerdantHook.sol:VerdantHook \
  --constructor-args $(cast abi-encode "c(address,address,address)" \
    $POOL_MANAGER $FACTORY $POSITION_MANAGER)
```

Repeat for `VerdantFactory`, `VerdantDeployer`, `MarketRegistry`, `ModelRegistry` and
`FactoryOrigin` with their own constructor arguments. Unverified source on an immutable
contract is a request to be trusted rather than read.

## 8. Launch one market, deliberately

The first market on a new deployment is a test whether it is called one or not, so make
it one on purpose: minimum supply, a single-stage Fixed schedule, no creator allocation,
and a treasury you control. Then buy a small amount, wait for a fee stage if the schedule
has one, call `collect()` on the locker, and claim from the splitter.

That exercises the whole path — creation, the hook's fee, the locked position, the split,
the pull — against the live deployment, for the price of a few hundredths of an ETH. The
fork suite already does exactly this, so a difference here means something about mainnet
differs from a fork of it, which is worth knowing before a stranger's money is involved.

## 9. The feed, which is a server rather than a contract

Everything above is immutable and finished. The indexer is neither: it is a process that
holds a Postgres database and follows the chain, and the site is a set of server components
that ask it questions. Vercel cannot host that — it has no long-running process and no
database — so the two live in different places, and `railway.toml` in the repository root is
the whole of the indexer's deployment.

```bash
railway up --service indexer        # from the repository root, not apps/indexer
railway logs --service indexer      # the backfill's progress, and its rate limiting
```

`DATABASE_URL` is the only variable that matters and Railway sets it, by reference to the
Postgres service in the same project. Ponder reads it and uses Postgres; with it unset it
falls back to PGlite in `apps/indexer/.ponder`, which is a single-writer file and the reason
a second indexer on one machine kills the first. Nothing else is configured, because the
chain, the factory, the hook and the block to start from all come from the deployment record
in `packages/config` — a feed and a site that disagreed about which Verdant they follow
would be worse than no feed.

Then Vercel's `VERDANT_FEED_URL` is set to the service's public URL.

### The public RPC cannot carry the feed, and this is measurable

Robinhood's own documentation says the public endpoint is not for indexing. What that means
in numbers, taken from the deployed service:

- The chain produces **10.25 blocks a second** — it is an Orbit L2 with sub-second blocks.
- The indexer ingests **11.6 blocks a second** through the public endpoint, most of its
  requests spent on 429s and backoff.

A margin of 1.3 blocks a second is not a margin. A gap of 200,000 blocks closes in two days
at that rate, and any dip in throughput below 10.25 means it never closes at all — the feed
would fall permanently further behind the chain it is following.

There is a second, harder limit. The public node keeps no archive state: an `eth_call` at a
block more than roughly an hour old returns `metadata is not found, <block>`. The indexing
functions work around this by reading write-once values at `latest` (see the comment at the
top of `apps/indexer/src/index.ts`), which is sound because those values cannot change — but
it is a workaround, and it forecloses anything that genuinely needs history.

So a provider key is not an optimisation here, it is a requirement. Robinhood recommends
Alchemy, `https://robinhood-mainnet.g.alchemy.com/v2/<key>`, and Dwellir, Alchemy, QuickNode,
dRPC, Blockdaemon and Validation Cloud all serve chain 4663 with archive access. Set it and
nothing else changes:

```bash
railway variable set PONDER_RPC_URL_4663=https://robinhood-mainnet.g.alchemy.com/v2/KEY --service indexer
```

One provider was tried and rejected: NodeFlare's keyless endpoint answers correctly from a
laptop, including archive reads, but Cloudflare returns 403 to Railway's egress addresses. An
RPC that works where you test it and not where it runs is worse than one that is merely slow,
so check a candidate from the deployment rather than from your machine.

## 10. The site

```bash
vercel deploy --prod          # from the repository root, with the root linked to the project
```

Two settings make that work, and both are easy to lose an hour to. The Vercel project's Root
Directory is `apps/web`, not `.`: the Next builder looks for `next` in the package.json it
finds there, and pointed at the repository root it finds a workspace with no framework and
refuses. Deploying from the root anyway is deliberate — the upload has to contain the whole
workspace, because `apps/web` alone is not installable.

And `apps/web/vercel.json` builds the three workspace packages before Next. They resolve
through `exports` to a `dist`, so `transpilePackages` does not save them from needing to be
compiled first; `^...` is pnpm for "this package's dependencies, without this package".

`vercel build && vercel deploy --prebuilt` from `apps/web` does not work, and the error it
gives is misleading. Next traces its serverless bundles against the workspace root, so the
output references `node_modules/.pnpm/...` paths that exist above `apps/web` and therefore
above what a deploy from `apps/web` uploads. It reports the first one as a missing file rather
than as a missing directory tree.

## 11. The X bot

Turning `@useagen` on is four things in order, and the order matters because the third one is
irreversible per market. See [ADR-017](decisions/017-a-tweet-is-a-launch.md) for why it is built
this way.

**Deploy `CreatorSeatFactory`, and record it.** Nothing else in this section works without it. Its
address goes in `packages/config/src/deployments.ts` under `addons.creatorSeatFactory`, or in
`NEXT_PUBLIC_CREATOR_SEAT_FACTORY` for a deployment being tried out. Until it is set,
`sponsorProblems()` reports the bot as unable to launch, and the bot answers questions and refuses
launches rather than launching something whose fees nobody can claim.

**Fund two wallets, and understand why they are two.** Both are fresh keys that hold only gas, and
they must not be the same key — `sponsorProblems()` refuses the deployment if they are.

`X_SPONSOR_PRIVATE_KEY` is the hot key. It submits every launch, pays every gas bill, and signs
constantly. Treat it as rotatable: replace it on a schedule or the afternoon you suspect it leaked,
fund the new one, and nothing else in this section changes. No creator entitlement depends on it.

`X_CREATOR_SEAT_OPENER_PRIVATE_KEY` is the opposite kind of key, and this is the part worth reading
twice. It is the initial occupant of every X creator seat, and seat addresses are derived from it
(`seatOf(opener, label)`), so it is named immutably in the vault of every market ever launched from
X. **It is effectively permanent.** Rotating it derives a new population of seats and leaves every
existing market paying seats only the old key can hand over, so **keep the old key** if you ever
change it: it is not a signing key that becomes worthless, it is the key to every existing
creator's handover. Keep it offline-grade — separate secret store, no reuse anywhere else — and
fund it lightly. It signs one cheap transaction per creator, ever: the `offer` that starts a
handover. `sponsor.ts` refuses it any other call, by selector, so it cannot be used as a general
signer even by a caller inside this codebase.

The split exists so those two sentences can both be true. Sharing one key meant an ordinary hot-key
rotation silently stranded every unclaimed entitlement older than it — fees still accruing to seats
Agen could no longer hand over.

To mint both at once, `node scripts/make-x-keys.mjs` from `apps/agen` writes the four variables into
`.env.local` and prints only the two addresses to fund. It prints no private key — the opener cannot
be rotated, so it is the last secret that should exist in terminal scrollback — and it refuses to run
if either key is already set, because generating a second opener over a live one renames every seat.

**Set the credentials.** Three sets, because X needs three:

| Variable | What it is for | Without it |
|---|---|---|
| `X_BOT_USERNAME` | The handle the bot answers as. Defaults to `useagen`. | Production default is correct |
| `X_BOT_USER_ID` | The bot's numeric id, so it cannot answer itself | The self-check fails open |
| `X_BEARER_TOKEN` | App-only reads: mentions, parent posts, search | No mentions can be read |
| `BRAVE_SEARCH_API_KEY` | Optional. Lets @useagen search the open web when a question needs a current fact | `web_search` is reported unavailable; Agen still answers from context and its own tools |
| `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` | OAuth 1.0a, for posting as the bot | The bot cannot reply, so it will not launch |
| `X_OAUTH_CLIENT_ID`, `X_OAUTH_CLIENT_SECRET` | OAuth 2.0 PKCE, for "sign in with X" | Nobody can claim their fees |
| `X_OAUTH_REDIRECT_URI` | Defaults to `${NEXT_PUBLIC_SITE_URL}/api/x/auth/callback` | Derived |
| `X_INGRESS_SECRET` | Bearer secret for `/api/x/poll` and `/api/x/webhook` | Both endpoints refuse every request |
| `X_SPONSOR_PRIVATE_KEY` | The rotatable hot wallet that submits launches and pays all gas | No launches |
| `X_SPONSOR_ADDRESS` | Optional. Checked against the key and refused if it disagrees | Derived from the key |
| `X_CREATOR_SEAT_OPENER_PRIVATE_KEY` | The permanent occupant of every X creator seat. Must differ from the sponsor | No launches; seats would have no occupant able to hand them over |
| `X_CREATOR_SEAT_OPENER_ADDRESS` | Optional. Checked against the key; a mismatch is refused rather than deriving unreachable seats | Derived from the key |
| `X_SESSION_SECRET` | Optional. Signs X sessions; derived from `AGENT_WALLET_MASTER_KEY` otherwise | Derived |
| `AGENT_WALLET_MASTER_KEY` | Already required for agents; the session key derives from it | Sessions cannot be signed |
| `NEXT_PUBLIC_SITE_URL` | Where a token's metadata and picture are recorded, permanently | Launches refuse |

**Choose how mentions arrive.** `X_MENTION_DELIVERY=polling` is the default and works on every
access tier; point a cron at `POST /api/x/poll` with the ingress secret every minute. Set
`webhook` instead when the account's tier includes activity webhooks and point X at
`/api/x/webhook`; `GET` on that route answers the CRC challenge. Both doors end in the same
`handleMention`, so switching is configuration.

The limits, all optional, all spend controls rather than politeness:

| Variable | Default | What it bounds |
|---|---|---|
| `X_MAX_LAUNCHES_PER_USER_PER_DAY` | 3 | One account's sponsored launches per day |
| `X_MAX_LAUNCHES_PER_DAY` | 200 | The platform's, per day |
| `X_MAX_GAS_PER_DAY_WEI` | 0.5 ETH | Gas the platform will spend per day |
| `X_USER_COOLDOWN_SECONDS` | 60 | Interval between one account's launches |
| `X_MAX_MENTIONS_PER_USER_PER_MINUTE` | 5 | Mentions answered per account per minute |
| `X_MIN_ACCOUNT_AGE_DAYS` | 7 | How old an account must be to be sponsored |
| `X_MIN_FOLLOWERS` | 0 | Followers required to be sponsored |
| `X_BLOCKLIST` | empty | Comma-separated X user **ids**, never handles |
| `X_LAUNCHES_DISABLED` | unset | `1` stops launches. Needs a redeploy, which is the point |
| `X_REPLIES_DISABLED` | unset | `1` stops replies, and therefore launches |

The stored kill switch is separate and faster: it lives in the bot's own SQLite database and either
one being set stops launches, so the fast switch cannot overrule the deliberate one.

**What it can find out, and what it says when it cannot.** Answering is a research loop, not a
lookup: the model picks which source a question belongs to from a catalogue where each tool declares
its kind — Agen's own markets, the chain, X itself, the open web, one named page. The advice it reads
about *where to look* is generated from the tools actually configured, so an unavailable capability
is reported to the model as unavailable and produces "I can't check that" rather than a confident
guess. Two consequences worth knowing before reading the logs:

- Without `BRAVE_SEARCH_API_KEY`, questions about news, companies or anything else current are
  answered from the model's training data or refused. Everything about Agen markets, the chain and X
  still works.
- Several X capabilities depend on the access tier, not on configuration: quote posts, likers and
  follower relationships are commonly restricted. Those tools report themselves unavailable, and
  `x_follows` in particular answers "could not determine" rather than "no" when it cannot finish the
  check — a wrong "no" there is a fabricated claim about two real people.

Depth is read off the wording. `thoughts?` is a few turns; `research this` gathers from more than one
source; `investigate this` is told to cross-check and to say where its sources disagree. That is a
ceiling on cost per mention, not a target: the ceiling is 12 model calls, and an ordinary mention
spends one or two. Images in the conversation are sent to the model to be looked at, which costs
image tokens on any mention carrying a picture. An answer that will not fit in one post may be posted
as a chain of up to three; the first post always stands alone, so a chain that fails part-way has
still answered the question.

To see the routing behaviour on a live model without posting anything:

```
set -a && . ./.env.local && set +a
X_ROUTING_PROBE=1 pnpm vitest run src/app/lib/x/routing.probe.test.ts
```

**Check it from anywhere.** `GET /api/x/status` needs no credential and reports no values: which
variables are missing, whether the bot can answer and launch, today's launch and gas counts against
their limits, and `keys`, which says whether both platform keys are present and `separated`. A
configured deployment showing `separated: false` is the one to act on — it is running on a single
key, and rotating it later would strand every unclaimed entitlement.

**Rotating the sponsor.** Which is now an ordinary operation, and the reason for the split. Fund a
new key, set `X_SPONSOR_PRIVATE_KEY` (and `X_SPONSOR_ADDRESS` if you set it), redeploy. Leave
`X_CREATOR_SEAT_OPENER_PRIVATE_KEY` alone. Existing seats keep their occupant, unclaimed creators
can still be offered their fees, and the only visible change is which address submits the next
launch. Token addresses are mined against the sponsor as `msg.sender`, so vanity prefixes and salts
differ after a rotation; nothing already launched is affected.

## If something is wrong afterwards

There is no recovery path and that is deliberate. The response to a mis-deployment is a
new deployment: a new `FactoryOrigin`, a newly mined hook, new registries, and
`packages/config/src/deployments.ts` updated to point at them. The old contracts stay on
chain forever, working exactly as their bytecode says, which is why step 6 exists — the
record of which one is real lives in this repository, not on the chain.
