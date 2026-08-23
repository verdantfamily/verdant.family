# The engine-v1 approval model

What a creator's signature authorises, where that is enforced, and what the chain enforces
independently of it. Written because the two are easy to conflate and the consequences of
conflating them are not symmetric: assuming the chain checks something the application checks
leaves a hole, and assuming the application checks something the chain checks leaves a
redundant check nobody can remove safely.

The short version: **the creator's `personal_sign` is application-layer authorisation, not
on-chain authorisation.** `AgenEngineFactory.deployMarket` is permissionless and recovers no
signature. That is deliberate, it is safe, and the reasons are below.

## Where the signature is verified

Three places, all server-side, all in the Next application. Never on chain.

| Where | When | What it checks |
| --- | --- | --- |
| `apps/agen/src/app/lib/builds.ts` → `approveEngineBuild` | The creator presses "Approve these rules" | `verifyMessage` recovers the connected wallet from the message built over `job.engine.configHash` and `job.engine.implementationHash`. On success the signature is stored on the job. |
| `apps/agen/src/app/lib/engine-launch.ts` → `requireApproval` | The creator presses "Launch", before any calldata is returned | The stored approval names this wallet, its hashes equal the job's *current* hashes, and the signature still verifies against a message rebuilt from them. |
| `apps/agen/src/app/lib/launched.ts` → `recordEngineLaunch` | After the transaction confirms | The receipt's `EngineMarketDeployed` carries the approved commitment and names the approving wallet as creator. |

The message itself is EIP-191 (`personal_sign`), not EIP-712, and there is exactly one builder
for it: `engineApprovalMessage` in `packages/market-compiler/src/approval.ts`. The browser
reaches it through `@verdant/market-compiler/browser` and the server through the package
barrel, so the bytes signed and the bytes verified are the same function's output rather than
two implementations kept in step. `packages/market-engine/approval/engine-v1.vectors.json`
pins that output for nine market shapes.

EIP-191 rather than EIP-712 is a legibility choice and only defensible *because* the signature
never reaches a contract. A `personal_sign` dialog shows the creator the literal text — the
configuration hash and the commitment, on their own lines, checkable against the review screen
behind the wallet. EIP-712 would show a typed structure and buy domain separation that nothing
here needs, since no contract recovers this signature. If that ever changes, this becomes the
wrong choice: a `personal_sign` payload that a contract recovers wants a domain, a nonce and a
chain id, and none of those are in this preimage.

## What the second signature is

The transaction. It is a separate act from the approval and that separation is the enforceable
version of "the market you were shown is the market you get": between the two, the server
recomputes the commitment from the stored configuration and refuses if it moved. A rebuild, a
tampered record or a decoder that lost a rule all end there, before a wallet is asked for
money.

## What stops another caller submitting altered calldata

Nothing stops them *calling* — and nothing needs to, because altering the calldata cannot
produce the market the creator approved.

1. **The commitment is recomputed on chain, not accepted.** `deployMarket` derives
   `implementationHash` from the configuration the hook actually stored, over the chain id, the
   hook's address and the engine version, and reverts with `CommitmentMismatch` unless it
   equals the value the manifest declared. So a caller cannot declare commitment *X* while
   deploying economics *Y*. Either the economics are the approved economics or the transaction
   reverts.
2. **The creator is `msg.sender`, never an argument.** A third party who alters the calldata
   and launches gets a market whose creator is themselves: their address in the registry, and
   the `Creator` share of the fee split resolved to their address by
   `AgenEngineFactory._deployVault`. They cannot launch a market that pays the original
   creator's fees to anybody, including themselves.
3. **The token address is derived, not chosen.** It is CREATE2 over the deployer, the token
   salt and an initcode hash that includes the creator, so a different caller producing the
   same salt still produces a different token at a different address. Two markets with
   identical economics are not the same market.
4. **The vault's split is checked against the configuration.** The factory resolves the
   distribution's roles to addresses and the hook then checks the vault's shares against that
   same configuration, so a mismatch is a failed launch rather than a market paying somebody
   the creator did not name.

What none of that prevents is a third party deploying their own market with byte-identical
economics. That is not an attack on the creator's market; it is somebody launching a market.
The engine is a public contract and copying a fee schedule is not a security property anything
here claims to protect.

## What `implementationHash` protects, exactly

It binds **the economics, to a chain, to an engine**. It is
`keccak256(domain, chainId, hookAddress, engineVersion, configHash)` where `configHash` is
`keccak256` of the canonical ABI encoding of the configuration and nothing else.

So it protects against:

- a rate, threshold, tier, stage, recipient, share, ceiling or fee currency differing from the
  one reviewed — any of them changes `configHash` and therefore the commitment;
- the same economics being run by a different hook, or on a different chain, which is what the
  chain id and hook address in the preimage are for;
- a signature over an engine-0 build standing as approval of an engine-v1 one. The two
  approval messages have deliberately different text, so the preimages cannot collide whatever
  the hashes happen to be.

It does **not** protect:

- **identity.** It says nothing about which token, which pool, which vault or which creator.
  Two creators launching the same rules produce the same commitment. This is the gap the
  application layer has to close, and where it closes it is described below.
- **display labels.** Token symbol, quote-asset symbol and decimals are outside the encoding
  by design — a ticker is not economics, and two markets differing only in what their token is
  called must hash identically.
- **the liquidity fee receiver.** Who collects the locked position's Uniswap fees is a launch
  argument, not part of the configuration, and is stated separately on the launch screen.

## Is the factory permissioned through Agen's application or operator path?

**No.** `deployMarket` is `external` and `nonReentrant` and has no owner, no allowlist, no
operator check and no signature recovery. Any address can call it directly and get a market.

That is intentional. A permissioned factory would make Agen a gatekeeper of markets that its
own contracts otherwise guarantee are well-formed, and it would mean a market's continued
existence depended on Agen's operator key. The properties that matter are enforced by
construction instead: no caller can put bytecode on chain through this factory (every contract
it deploys has fixed bytecode from its own construction), no caller can declare economics it is
not deploying, and no caller can launch a market attributed to somebody else.

## Can a direct caller launch an engine market without the creator's signature?

**Yes, and that is not a bypass.** They can launch a market — *their* market, with themselves
as creator, their own token, their own vault. What they cannot do is:

- launch a market that the application will present as somebody else's build;
- launch a market whose economics differ from a commitment they declared;
- cause the original creator's build to point anywhere other than the market that creator
  launched.

The last one is the only one that was ever at risk, and it was at risk in the application
rather than in the contract. `POST /api/markets/[id]/launched` is unauthenticated and takes a
transaction hash, and a market's configuration is public — so an identical-economics market
deployed by anybody produces an identical commitment, and a commitment check alone cannot tell
it from the creator's own launch. `recordEngineLaunch` therefore also requires the event's
`creator` to be the wallet that signed the approval. An engine market is not considered
launched for a build until a log from the configured engine factory names both the approved
commitment and the approving wallet.

That check is engine-v1 only. The generated-market path has the same shape of exposure and is
older than this work; it is recorded here as known rather than fixed as part of an engine-v1
go-live.

## Summary of the boundary

| Property | Enforced by |
| --- | --- |
| The market's economics are the reviewed economics | The chain. `CommitmentMismatch` in `AgenEngineFactory`. |
| The economics belong to this engine on this chain | The chain, through the commitment preimage. |
| No bytecode reaches the chain through the factory | The chain, by construction. |
| The creator is the caller | The chain. `msg.sender`. |
| This wallet consented to these economics | The application. `verifyMessage`, three times. |
| The server will not build calldata without consent | The application. `requireApproval`. |
| This build's page points at this creator's market | The application. `recordEngineLaunch`. |
