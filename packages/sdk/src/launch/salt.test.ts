import type { Address, Hex, PublicClient } from "viem";
import {
  concat,
  encodeAbiParameters,
  getAddress,
  getCreate2Address,
  keccak256,
  slice,
} from "viem";
import { describe, expect, it } from "vitest";

import { NATIVE_CURRENCY } from "../markets/pool.js";
import { TOKEN_SCALE } from "./create.js";
import {
  mineTokenSalt,
  predictTokenAddress,
  readTokenInitCodeHash,
  saltFor,
} from "./salt.js";

/**
 * The address a launch lands on, and why getting it wrong is not a small error.
 *
 * For an ether-quoted market the predicted address is a convenience: it lets an
 * interface show a creator their token's address before they pay for it. For an
 * equity-quoted market it is a precondition — the factory reverts unless the token
 * sorts above the quote asset — so a prediction that is wrong in any of its three
 * inputs produces a salt search that terminates confidently on a salt that does not
 * work, and the creator finds out by losing a transaction.
 *
 * The three inputs are the deployer's address, the namespaced salt and the init code
 * hash. These tests check each of them separately, and check the CREATE2 formula
 * itself against a hand-assembled preimage rather than only against viem.
 */

const DEPLOYER: Address = "0xdE91070000000000000000000000000000000001";
const CREATOR: Address = "0x00000000000000000000000000000000000c4eA7";
const OTHER_CREATOR: Address = "0x000000000000000000000000000000000007Ade4";
const EQUITY: Address = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";

const INIT_CODE_HASH: Hex =
  "0x1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b";
const SALT: Hex =
  "0x00000000000000000000000000000000000000000000000000000000000000a7";
/**
 * A seed chosen because it does not succeed immediately.
 *
 * Against `EQUITY` this one takes several candidates, which is what makes the
 * boundary assertions below say something: with a seed whose first candidate
 * qualified, the loop that checks every earlier candidate failed would have no
 * iterations and would pass whatever the search did.
 */
const SEED: Hex =
  "0x00005eed0000000000000000000000000000000000000000000000000000001b";

/**
 * CREATE2 assembled by hand: `keccak256(0xff ++ deployer ++ salt ++ initCodeHash)`,
 * low twenty bytes. Deliberately not viem's `getCreate2Address` — the point of a
 * differential check is that two pieces of code agree, and this is the second one.
 */
function create2ByHand(
  deployer: Address,
  namespacedSalt: Hex,
  initCodeHash: Hex,
): Address {
  const digest = keccak256(
    concat(["0xff", deployer, namespacedSalt, initCodeHash]),
  );
  return getAddress(slice(digest, 12));
}

describe("saltFor", () => {
  it("is keccak256(abi.encode(creator, salt)), padded rather than packed", () => {
    // `VerdantFactory.saltFor` uses `abi.encode`, so both arguments occupy a whole
    // word. The packed form is 52 bytes rather than 64 and hashes differently, and
    // it is the mistake that produces predictions no launch ever lands on.
    const padded = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "bytes32" }],
        [CREATOR, SALT],
      ),
    );
    expect(saltFor(CREATOR, SALT)).toBe(padded);
    expect(saltFor(CREATOR, SALT)).not.toBe(keccak256(concat([CREATOR, SALT])));
  });

  it("namespaces by creator, so two creators cannot share an address", () => {
    // The property the factory's design rests on: a salt one creator has mined is
    // not available to anybody else.
    expect(saltFor(CREATOR, SALT)).not.toBe(saltFor(OTHER_CREATOR, SALT));
  });
});

describe("predictTokenAddress", () => {
  const predicted = predictTokenAddress({
    deployer: DEPLOYER,
    creator: CREATOR,
    salt: SALT,
    initCodeHash: INIT_CODE_HASH,
  });

  it("agrees with viem's getCreate2Address on the namespaced salt", () => {
    expect(predicted).toBe(
      getCreate2Address({
        from: DEPLOYER,
        salt: saltFor(CREATOR, SALT),
        bytecodeHash: INIT_CODE_HASH,
      }),
    );
  });

  it("agrees with the CREATE2 formula assembled by hand", () => {
    expect(predicted).toBe(
      create2ByHand(DEPLOYER, saltFor(CREATOR, SALT), INIT_CODE_HASH),
    );
  });

  it("uses the namespaced salt and not the creator's raw one", () => {
    // The whole of what `saltFor` contributes. If this step were skipped, every
    // prediction would be wrong and would look right — a well-formed address,
    // stable across calls, that the launch never occupies.
    expect(predicted).not.toBe(
      getCreate2Address({
        from: DEPLOYER,
        salt: SALT,
        bytecodeHash: INIT_CODE_HASH,
      }),
    );
  });

  it("derives from the deployer, so the factory's address gives a different answer", () => {
    // The token is created by `VerdantDeployer`, which holds its creation code.
    // Passing the factory here is the plausible mistake, and it is silent.
    const factory: Address = "0xFa17000000000000000000000000000000000001";
    expect(predicted).not.toBe(
      predictTokenAddress({
        deployer: factory,
        creator: CREATOR,
        salt: SALT,
        initCodeHash: INIT_CODE_HASH,
      }),
    );
  });

  it("depends on the init code hash, which is what makes the supply part of the address", () => {
    const otherHash: Hex = `0x${"ab".repeat(32)}`;
    expect(predicted).not.toBe(
      predictTokenAddress({
        deployer: DEPLOYER,
        creator: CREATOR,
        salt: SALT,
        initCodeHash: otherHash,
      }),
    );
  });

  it("is checksummed, so it can be compared with an address from anywhere", () => {
    expect(predicted).toBe(getAddress(predicted));
  });
});

describe("mineTokenSalt", () => {
  const forEquity = (seed?: Hex) =>
    mineTokenSalt({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      above: EQUITY,
      ...(seed === undefined ? {} : { seed }),
    });

  it("returns a token that really does sort above the quote asset", () => {
    // The property the whole function exists for, stated as the factory states it:
    // strictly above, compared as integers.
    const { token } = forEquity(SEED);
    expect(BigInt(token)).toBeGreaterThan(BigInt(EQUITY));
  });

  it("returns a salt that predicts the token it reported", () => {
    // The two halves of the result have to describe one launch. If they could
    // disagree, a creator would launch with a salt whose address was never checked.
    const { salt, token } = forEquity(SEED);
    expect(
      predictTokenAddress({
        deployer: DEPLOYER,
        creator: CREATOR,
        salt,
        initCodeHash: INIT_CODE_HASH,
      }),
    ).toBe(token);
  });

  it("is deterministic in its seed", () => {
    // What lets an interface show the same predicted address twice, and what lets
    // this test name an exact salt at all.
    expect(forEquity(SEED)).toEqual(forEquity(SEED));
  });

  it("searches somewhere else for a different seed", () => {
    const other: Hex = `0x${"11".repeat(32)}`;
    expect(forEquity(SEED).salt).not.toBe(forEquity(other).salt);
  });

  it("accepts the first candidate when the quote asset is ether", () => {
    // Every address is above zero, so an ether-quoted launch never searches. This
    // is the assertion that the ordering constraint costs nothing in the common
    // case rather than being skipped in it.
    const mined = mineTokenSalt({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      above: NATIVE_CURRENCY,
      seed: SEED,
    });
    expect(mined.attempts).toBe(1);
    expect(BigInt(mined.token)).toBeGreaterThan(0n);
  });

  it("finds an equity-quoted salt in a handful of candidates", () => {
    // NVDA's address sits high in the space, so roughly a fifth of candidates
    // qualify — the expected search is about five. A bound here would be a
    // statistical claim, so this only asserts the search is short enough to be
    // done in a form field rather than in a background job.
    expect(forEquity(SEED).attempts).toBeLessThan(64);
  });

  it("reports how many candidates it tried, counting the one that worked", () => {
    const mined = forEquity(SEED);

    // The seed was chosen to need more than one candidate. Asserted rather than
    // assumed, because the loop below is vacuous if it ever stops being true.
    expect(mined.attempts).toBeGreaterThan(1);

    // Every candidate before the reported one must have failed. A search bounded
    // just short of the winner therefore has to give up: if any earlier candidate
    // had qualified, `attempts` would be overstating the work and understating how
    // many salts a creator has to choose from.
    for (let i = 1; i < mined.attempts; i++) {
      expect(() =>
        mineTokenSalt({
          deployer: DEPLOYER,
          creator: CREATOR,
          initCodeHash: INIT_CODE_HASH,
          above: EQUITY,
          seed: SEED,
          maxAttempts: i,
        }),
      ).toThrow(/no salt in/);
    }

    // And a search bounded exactly at the winner succeeds, which is what makes the
    // loop above a statement about the boundary rather than about small bounds.
    expect(
      mineTokenSalt({
        deployer: DEPLOYER,
        creator: CREATOR,
        initCodeHash: INIT_CODE_HASH,
        above: EQUITY,
        seed: SEED,
        maxAttempts: mined.attempts,
      }).salt,
    ).toBe(mined.salt);
  });

  it("has a default seed, so a caller need not invent entropy", () => {
    const mined = mineTokenSalt({
      deployer: DEPLOYER,
      creator: CREATOR,
      initCodeHash: INIT_CODE_HASH,
      above: EQUITY,
    });
    expect(BigInt(mined.token)).toBeGreaterThan(BigInt(EQUITY));
  });

  it("gives one creator a different search from another's", () => {
    // Namespacing again, this time through the default seed: two creators mining
    // against the same equity should not be handed the same candidate list, or the
    // second to launch would collide with the first.
    const mine = (creator: Address) =>
      mineTokenSalt({
        deployer: DEPLOYER,
        creator,
        initCodeHash: INIT_CODE_HASH,
        above: EQUITY,
      });
    expect(mine(CREATOR).salt).not.toBe(mine(OTHER_CREATOR).salt);
  });

  it("throws rather than looping forever on an unsatisfiable constraint", () => {
    // No address exceeds the top of the space, so this is the shape of a caller
    // passing something that is not a quote asset. The message has to name the
    // input, because "try again" would be advice that never works.
    expect(() =>
      mineTokenSalt({
        deployer: DEPLOYER,
        creator: CREATOR,
        initCodeHash: INIT_CODE_HASH,
        above: "0xffffffffffffffffffffffffffffffffffffffff",
        maxAttempts: 8,
      }),
    ).toThrow(/no salt in 8 candidates/);
  });
});

describe("readTokenInitCodeHash", () => {
  it("scales the supply and passes the constructor arguments in order", async () => {
    // The deployer's `tokenInitCodeHash` takes the *scaled* supply, because that is
    // what the factory passes to the constructor. Asking the chain with whole tokens
    // would return the hash of a different token and every predicted address would
    // be wrong by a factor of 1e18 in the supply.
    const calls: unknown[][] = [];
    const client = {
      readContract: (request: { readonly args: readonly unknown[] }) => {
        calls.push([...request.args]);
        return Promise.resolve(INIT_CODE_HASH);
      },
    } as unknown as PublicClient;

    const hash = await readTokenInitCodeHash(client, {
      deployer: DEPLOYER,
      name: "Verdant Reference Market",
      symbol: "VRM",
      supplyTokens: 1_000_000_000n,
      creator: CREATOR,
      metadataURI: "ipfs://bafyexample",
      metadataMutable: true,
    });

    expect(hash).toBe(INIT_CODE_HASH);
    expect(calls).toEqual([
      [
        "Verdant Reference Market",
        "VRM",
        1_000_000_000n * TOKEN_SCALE,
        CREATOR,
        "ipfs://bafyexample",
        true,
      ],
    ]);
  });
});
