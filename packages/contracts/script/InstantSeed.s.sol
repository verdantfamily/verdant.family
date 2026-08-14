// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {InstantFactory} from "../src/InstantFactory.sol";

/// @title InstantSeed
/// @notice Launches two Instant markets on a local rig and trades them, so the indexer has
/// a history to read and something to be wrong about.
///
/// @dev A rig script. It is not for any real chain and would be an expensive mistake on
/// one — it launches markets and spends ether on them from whatever key it is given.
///
/// The trades are deliberately mixed: a creator's first buy inside the launch, then buys
/// and sells from a second account, spread across several blocks. That is the minimum
/// shape that can catch the three things most likely to be wrong in a new indexing path —
/// a side derived backwards, a volume that counts one direction, and a candle whose open
/// and close come from the wrong end of a bucket.
///
/// Usage, from `scripts/instant-proof.sh`:
///
///   INSTANT_FACTORY=0x... SWAP_ROUTER=0x... forge script script/InstantSeed.s.sol \
///     --rpc-url $RPC --private-key $KEY --broadcast
contract InstantSeed is Script {
    uint160 internal constant MIN_LIMIT = TickMath.MIN_SQRT_PRICE + 1;
    uint160 internal constant MAX_LIMIT = TickMath.MAX_SQRT_PRICE - 1;

    function run() external {
        InstantFactory factory = InstantFactory(payable(vm.envAddress("INSTANT_FACTORY")));
        PoolSwapTest router = PoolSwapTest(vm.envAddress("SWAP_ROUTER"));
        address sender = msg.sender;

        vm.startBroadcast(sender);

        // --- one market, launched with the creator's own first buy ---------------
        InstantFactory.Created memory first = factory.create{value: 1 ether}(
            InstantFactory.CreateParams({
                name: "Proof One",
                symbol: "PONE",
                metadataURI: "https://example.invalid/metadata/one.json",
                feeRecipient: sender,
                salt: bytes32(uint256(1)),
                initialBuyAmount: 1 ether,
                initialBuyMinTokens: 0
            })
        );

        console.log("MARKET_ONE_TOKEN", first.token);
        console.log("MARKET_ONE_VAULT", first.vault);

        // --- and one launched cold, so a market with no first buy is covered too --
        InstantFactory.Created memory second = factory.create(
            InstantFactory.CreateParams({
                name: "Proof Two",
                symbol: "PTWO",
                metadataURI: "https://example.invalid/metadata/two.json",
                feeRecipient: sender,
                salt: bytes32(uint256(2)),
                initialBuyAmount: 0,
                initialBuyMinTokens: 0
            })
        );

        console.log("MARKET_TWO_TOKEN", second.token);
        console.log("MARKET_TWO_VAULT", second.vault);

        // --- trade the first, in both directions ---------------------------------
        PoolKey memory key = factory.poolKeyFor(first.token);

        _buy(router, key, 2 ether);
        _buy(router, key, 0.5 ether);

        // Sell a third of what this account now holds. A partial sell rather than the
        // whole balance, so the market ends with a non-zero holder and the last trade is
        // not the one that emptied it.
        uint256 held = IERC20(first.token).balanceOf(sender);
        _sell(router, key, first.token, held / 3);

        _buy(router, key, 0.25 ether);

        // --- and one trade in the second, so it is not a market with zero history --
        _buy(router, factory.poolKeyFor(second.token), 0.4 ether);

        vm.stopBroadcast();

        console.log("");
        console.log("SEED_MARKETS 2");
        console.log("SEED_TRADES 6");
    }

    function _buy(PoolSwapTest router, PoolKey memory key, uint256 ethIn) private {
        router.swap{value: ethIn}(
            key,
            // forge-lint: disable-next-line(unsafe-typecast) -- a rig's own literal
            SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: MIN_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
    }

    function _sell(PoolSwapTest router, PoolKey memory key, address token, uint256 amount) private {
        IERC20(token).approve(address(router), amount);
        router.swap(
            key,
            // forge-lint: disable-next-line(unsafe-typecast) -- bounded by the supply
            SwapParams({zeroForOne: false, amountSpecified: -int256(amount), sqrtPriceLimitX96: MAX_LIMIT}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            bytes("")
        );
    }
}
