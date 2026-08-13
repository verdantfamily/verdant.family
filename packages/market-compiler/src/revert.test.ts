import { describe, expect, it } from "vitest";

import { explainRevert, selectorsOf } from "./revert.js";

const VAULT = `
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

contract FeeVault {
    error NotHook(address caller);
    error NotOwner(address caller);
    error InsufficientBalance(uint256 requested, uint256 available);

    function credit(uint256 amount) external {}
}
`;

const HOOK = `
// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IHooks {
    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external returns (bytes4, BeforeSwapDelta, uint24);
}

contract HarbourHook {
    error HookCallFailed();
}
`;

describe("reading a revert", () => {
  const table = selectorsOf([
    { path: "FeeVault.sol", content: VAULT },
    { path: "HarbourHook.sol", content: HOOK },
  ]);

  it("knows the selector of an error declared in the sources", () => {
    // Hashed rather than written down, so this stays true if the declaration changes.
    expect(table.get("0xa570b990")).toBe("NotHook(address)");
    expect(table.get("0xa9e35b2f")).toBe("HookCallFailed()");
  });

  it("names every selector buried in a wrapped hook revert", () => {
    // The exact shape a live Harbour build failed with, seven times over, and which
    // three repair rounds could not read: four hex fields and no words.
    const raw =
      "WrappedError(0xA6e0000000000000000000000000000000001088, 0x575e24b4, " +
      "0xa570b990000000000000000000000000a6e0000000000000000000000000000000001088, 0xa9e35b2f)";

    const explained = explainRevert(raw, table);

    expect(explained).toContain("NotHook(address)");
    expect(explained).toContain("HookCallFailed()");

    // The evidence survives the explanation: a decode that guessed wrong must not be
    // able to hide what it was guessing at.
    expect(explained).toContain(raw);
  });

  it("leaves a reason it cannot improve exactly as it was", () => {
    expect(explainRevert("panic: arithmetic underflow or overflow (0x11)", table)).toBe(
      "panic: arithmetic underflow or overflow (0x11)",
    );
    expect(explainRevert("0xdeadbeef", table)).toBe("0xdeadbeef");
  });

  it("skips a signature whose parameters it cannot canonicalise", () => {
    // A struct parameter cannot be hashed from the declaration alone, and a wrong
    // selector would put a confident, incorrect name on somebody's revert.
    const odd = selectorsOf([
      { path: "A.sol", content: "contract A { error Bad(PoolKey key); error Fine(address who); }" },
    ]);

    expect([...odd.values()]).toContain("Fine(address)");
    expect([...odd.values()]).not.toContain("Bad(PoolKey)");
  });

  it("treats uint and int as their canonical widths", () => {
    const aliases = selectorsOf([
      { path: "A.sol", content: "contract A { error Over(uint amount); }" },
    ]);

    expect([...aliases.values()]).toContain("Over(uint256)");
  });
});
