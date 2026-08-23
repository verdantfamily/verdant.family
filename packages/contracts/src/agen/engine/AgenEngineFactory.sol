// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {IPositionManager} from "@uniswap/v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {ActionConstants} from "@uniswap/v4-periphery/src/libraries/ActionConstants.sol";
import {LiquidityAmounts} from "@uniswap/v4-core/test/utils/LiquidityAmounts.sol";

import {VerdantToken} from "../../VerdantToken.sol";
import {AgenCurve} from "../AgenCurve.sol";
import {AgenMarketRegistry} from "../AgenMarketRegistry.sol";
import {AgenPositionLocker} from "../AgenPositionLocker.sol";
import {AgenEngineDeployer} from "./AgenEngineDeployer.sol";
import {AgenEngineHook} from "./AgenEngineHook.sol";
import {AgenEngineVault} from "./AgenEngineVault.sol";
import {AgenRuleLib} from "./AgenRuleLib.sol";

/// @title AgenEngineFactory
/// @notice Launches a deterministic programmable market, atomically, from typed data alone.
///
/// @dev What separates this from `AgenFactory` is what it will not accept. `AgenFactory`
/// takes a bundle of `bytes initCode` and CREATE2s whatever it is handed, because a
/// generated market's contracts are written per launch. This takes a token's name, a pool's
/// opening tick, and a canonical rule configuration — and every contract it deploys is one
/// whose source is in this repository and whose bytecode is fixed at this factory's own
/// construction. There is no path by which a model, a frontend or a creator can put code on
/// chain through here.
///
/// ## One transaction, or none of it
///
/// Token, vault, hook configuration, pool, liquidity and registry record all happen in one
/// call. If any part reverts, all of it does — including the CREATE2 deployments, since a
/// reverted transaction leaves no code behind. So there is no reachable state in which a
/// market's token exists without its rules, or its rules without its liquidity, or a
/// registry record for a pool nobody can trade.
///
/// ## Why the commitment is recomputed rather than recorded
///
/// The manifest carries an `implementationHash`, and this contract does not trust it. It
/// derives the hash from the configuration the hook actually stored and refuses the launch
/// unless the two agree. That is what makes a creator's approval binding: they signed a
/// commitment over specific economics, and a launch whose economics differ produces a
/// different hash and cannot be registered under the old one.
///
/// ## Why the launched token is `currency1`
///
/// `AgenCurve` lays its three bands *downward* from the opening tick, which is only valued
/// entirely in `currency1` if the launched token is `currency1`. `AgenFactory` has the same
/// requirement and the same error. The token's address is CREATE2-derived, so a launch
/// chooses a salt that sorts above its quote asset; `TokenNotAboveQuote` is what happens
/// when it did not.
///
/// The hook itself supports either orientation and is tested in both — that generality is
/// real and exercised, it simply is not reachable through this launch path while the curve
/// is one-sided.
contract AgenEngineFactory is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    /// @notice Everything a deterministic launch needs. Typed, and no bytecode anywhere.
    struct Manifest {
        // --- the token ---
        string name;
        string symbol;
        /// @dev Base units. Must equal `config.referenceSupply`, since every percentage
        /// threshold in the market is measured against it.
        uint256 supply;
        string metadataURI;
        bool metadataMutable;
        /// @dev Chosen off chain so the token's address sorts above the quote asset.
        bytes32 tokenSalt;
        // --- the pool ---
        address quoteAsset;
        int24 initialTick;
        // --- the rules ---
        AgenRuleLib.Config config;
        // --- the parties ---
        /// @dev Receives the *liquidity* position's fees, through the locker. Distinct from
        /// the programmable fee recipients, which the configuration names.
        address feeReceiver;
        // --- the commitments ---
        bytes32 specificationHash;
        /// @dev Recomputed here and refused unless it matches.
        bytes32 implementationHash;
    }

    /// @dev Carried between steps rather than recomputed. Three fields because the EVM's
    /// stack has opinions.
    struct Launch {
        address locker;
        uint256 firstTokenId;
        uint256 supply;
    }

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    AgenMarketRegistry public immutable registry;

    /// @notice Holds the per-market bytecode, so this contract can stay under EIP-170.
    /// @dev Every address a launch creates derives from the deployer rather than from here,
    /// because the deployer is the creating account.
    AgenEngineDeployer public immutable deployer;

    /// @notice The shared engine hook every market this factory launches will use.
    /// @dev Immutable, and it pins this factory in return. The two-way pinning is why the
    /// deployment order matters — see `script/DeployAgenEngine.s.sol`.
    AgenEngineHook public immutable hook;

    /// @notice Where a `Treasury` recipient's share goes.
    /// @dev Resolved here rather than carried in the configuration, so the canonical
    /// encoding stays independent of who Agen happens to be paying today. Immutable, so a
    /// market's split cannot be redirected after it launches.
    address public immutable treasury;

    error ZeroPoolManager();
    error ZeroPositionManager();
    error ZeroTreasury();
    error ZeroFeeReceiver();
    error ZeroSupply();
    error SupplyMismatch(uint256 manifestSupply, uint256 configSupply);
    error QuoteAssetMismatch(address manifestQuote, address configQuote);
    error TokenNotAboveQuote(address token, address quoteAsset);
    error NoSupplyToLock(address token);
    error NoLiquidity(uint256 band, uint256 amount);
    error PositionNotLocked(uint256 tokenId, address owner, address locker);
    error WrongDeployer(address expected, address actual);
    error WrongRegistry(address expected, address actual);
    error HookNotOurs(address hookFactory, address expected);

    /// @notice The commitment the manifest declared is not the one this market produces.
    /// @dev The check that makes an approval binding. A creator signed a hash over specific
    /// economics; if the economics differ, the hash differs, and this refuses the launch
    /// rather than registering a market under a commitment nobody agreed to.
    error CommitmentMismatch(bytes32 declared, bytes32 computed);

    /// @notice A deterministic engine market was created.
    /// @dev Carries what a verifier needs to identify an engine-v1 market from the chain
    /// alone, and deliberately never the creator's prompt.
    event EngineMarketDeployed(
        uint256 indexed index,
        address indexed token,
        address indexed creator,
        PoolId poolId,
        address vault,
        address locker,
        uint8 engineVersion,
        bytes32 configHash,
        bytes32 implementationHash
    );

    /// @dev The hook is checked to point back at this factory. Prediction alone is not
    /// enough: it turns a mis-ordered deployment into a failed one rather than a live
    /// factory whose markets no hook will ever configure.
    constructor(
        IPoolManager poolManager_,
        IPositionManager positionManager_,
        AgenEngineDeployer deployer_,
        AgenMarketRegistry registry_,
        AgenEngineHook hook_,
        address treasury_
    ) {
        if (address(poolManager_) == address(0)) revert ZeroPoolManager();
        if (address(positionManager_) == address(0)) revert ZeroPositionManager();
        if (treasury_ == address(0)) revert ZeroTreasury();

        // Every wiring checked, so a mis-ordered deployment is a failed transaction rather
        // than a live factory that cannot launch anything.
        if (deployer_.factory() != address(this)) revert WrongDeployer(address(this), deployer_.factory());
        if (registry_.factory() != address(this)) revert WrongRegistry(address(this), registry_.factory());
        if (hook_.factory() != address(this)) revert HookNotOurs(hook_.factory(), address(this));

        poolManager = poolManager_;
        positionManager = positionManager_;
        deployer = deployer_;
        registry = registry_;
        hook = hook_;
        treasury = treasury_;
    }

    /// @notice Launch a deterministic programmable market.
    ///
    /// @dev The order is the safety argument. Validate before deploying anything; deploy the
    /// token before deriving the pool key, because the key contains its address; configure
    /// the hook before opening the pool, because `beforeInitialize` refuses a pool with no
    /// rules; open liquidity before registering, so a registered market is always one that
    /// can be traded.
    function deployMarket(Manifest calldata manifest) external nonReentrant returns (uint256 index) {
        if (manifest.supply == 0) revert ZeroSupply();
        if (manifest.feeReceiver == address(0)) revert ZeroFeeReceiver();
        if (manifest.supply != manifest.config.referenceSupply) {
            revert SupplyMismatch(manifest.supply, manifest.config.referenceSupply);
        }
        if (manifest.quoteAsset != manifest.config.quoteAsset) {
            revert QuoteAssetMismatch(manifest.quoteAsset, manifest.config.quoteAsset);
        }
        /*
         * A native quote needs no special case, and it is worth saying why rather than
         * leaving the absence of a branch to be noticed.
         *
         * Native currency is `Currency.wrap(address(0))` throughout v4, so it sorts below
         * every ERC-20 and lands on `currency0` unconditionally — which is exactly the
         * orientation `AgenCurve` requires, for free, without a salt search. `toId()` is 0,
         * which `poolManager.mint` accepts like any other, and `CurrencyLibrary` resolves
         * `balanceOfSelf` and `transfer` to the native forms. Nothing below distinguishes the
         * two cases because nothing has to.
         *
         * No wrapping anywhere: the market's quote asset is native Robinhood Chain ETH, the
         * vault holds native ETH when the derivation says so, and a creator never sees WETH.
         */
        // Reverts unless the opening tick is on the grid with room for three bands.
        AgenCurve.validate(manifest.initialTick);

        address token = deployer.deployToken(
            manifest.tokenSalt,
            manifest.name,
            manifest.symbol,
            manifest.supply,
            msg.sender,
            manifest.metadataURI,
            manifest.metadataMutable
        );

        // The curve's bands are valued entirely in `currency1`, so the token has to be it.
        if (token <= manifest.quoteAsset) revert TokenNotAboveQuote(token, manifest.quoteAsset);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(manifest.quoteAsset),
            currency1: Currency.wrap(token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: AgenCurve.TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        AgenEngineVault vault = _deployVault(manifest, key);

        // The hook validates the configuration and derives its own identity for it. Nothing
        // here supplies a hash.
        bytes32 configHash = hook.configure(key, manifest.config, vault);

        bytes32 computed = AgenRuleLib.implementationHash(
            configHash, block.chainid, address(hook), manifest.config.engineVersion
        );
        if (computed != manifest.implementationHash) {
            revert CommitmentMismatch(manifest.implementationHash, computed);
        }

        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(manifest.initialTick));

        Launch memory launch = _openLiquidity(manifest, key, token);

        index = _register(manifest, key, token, address(vault), launch.locker);

        emit EngineMarketDeployed(
            index,
            token,
            msg.sender,
            key.toId(),
            address(vault),
            launch.locker,
            manifest.config.engineVersion,
            configHash,
            computed
        );
    }

    // --- prediction ----------------------------------------------------------

    /// @notice Where a launch's token will land, before it exists.
    ///
    /// @dev So a caller can search for a salt that sorts above their quote asset, and so the
    /// review screen can show the address it is about to create. Derives from the deployer,
    /// which is the creating account.
    ///
    /// `msg.sender` is the creator, so a prediction is only valid for the account that asked
    /// for it — which is correct, since the creator's address is baked into the token.
    function predictToken(Manifest calldata manifest) external view returns (address) {
        return deployer.computeAddress(
            manifest.tokenSalt,
            deployer.tokenInitCodeHash(
                manifest.name,
                manifest.symbol,
                manifest.supply,
                msg.sender,
                manifest.metadataURI,
                manifest.metadataMutable
            )
        );
    }

    /// @notice The salt this factory will use for a launch's vault.
    /// @dev Derived from the token's salt so the vault is predictable too, and distinct from
    /// it so the two never collide.
    function vaultSalt(bytes32 tokenSalt) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("agen.engine.vault", tokenSalt));
    }

    // --- internals -----------------------------------------------------------

    /// @dev One vault per market, holding the fee currency the configuration derived, with
    /// the recipients resolved from the configuration's own distribution.
    ///
    /// There is deliberately no second model of the split: the roles in
    /// `config.distribution` are turned into addresses here and nowhere else, and the hook
    /// then checks the vault's shares against that same configuration — so a disagreement is
    /// a failed launch rather than a market paying somebody the creator did not name.
    function _deployVault(Manifest calldata manifest, PoolKey memory key) private returns (AgenEngineVault) {
        uint256 count = manifest.config.distribution.length;

        address[] memory recipients = new address[](count);
        uint24[] memory shares = new uint24[](count);

        for (uint256 i = 0; i < count; i++) {
            AgenRuleLib.Share calldata share = manifest.config.distribution[i];
            shares[i] = share.sharePpm;

            if (share.kind == AgenRuleLib.RecipientKind.Creator) {
                recipients[i] = msg.sender;
            } else if (share.kind == AgenRuleLib.RecipientKind.Treasury) {
                recipients[i] = treasury;
            } else {
                recipients[i] = share.recipient;
            }
        }

        // The quote asset is `currency0` by construction above, so the fee currency follows
        // directly from which leg the configuration names.
        Currency feeCurrency = AgenRuleLib.FeeCurrency(manifest.config.feeCurrency) == AgenRuleLib.FeeCurrency.Quote
            ? key.currency0
            : key.currency1;

        return AgenEngineVault(
            payable(
                deployer.deployVault(
                    vaultSalt(manifest.tokenSalt), address(hook), poolManager, feeCurrency, recipients, shares
                )
            )
        );
    }

    /// @dev Deploy the locker, put the whole supply into three positions it owns, and prove
    /// it owns them. Mirrors `AgenFactory._openLiquidity`, including why the locker is a
    /// plain `CREATE`: its constructor names the first position's token id, which the
    /// PositionManager does not assign until the mint that happens after it is deployed.
    function _openLiquidity(Manifest calldata manifest, PoolKey memory key, address token)
        private
        returns (Launch memory launch)
    {
        launch.supply = IERC20(token).balanceOf(address(this));
        if (launch.supply == 0) revert NoSupplyToLock(token);

        launch.firstTokenId = positionManager.nextTokenId();
        launch.locker = deployer.deployLocker(
            positionManager, launch.firstTokenId, manifest.feeReceiver, key.currency0, key.currency1
        );

        _mintBands(key, manifest.initialTick, token, launch.locker, launch.supply);

        for (uint256 i = 0; i < AgenCurve.BANDS; i++) {
            uint256 tokenId = launch.firstTokenId + i;
            address owner = IERC721(address(positionManager)).ownerOf(tokenId);
            if (owner != launch.locker) revert PositionNotLocked(tokenId, owner, launch.locker);
        }

        // Converting an amount of token into whole units of liquidity leaves dust. It goes
        // to the creator: it has to go somewhere, every other candidate is a party who did
        // not launch this market, and this factory must not end the call holding any.
        uint256 dust = IERC20(token).balanceOf(address(this));
        if (dust != 0) IERC20(token).safeTransfer(msg.sender, dust);
    }

    /// @dev The three mints as one batch. `amount0Max: 0` on every band is the assertion
    /// that no quote asset is required, which holds because every band's upper tick is at or
    /// below the opening tick — v4 values such a position entirely in `currency1`.
    function _mintBands(PoolKey memory key, int24 initialTick, address token, address locker, uint256 supply)
        private
    {
        AgenCurve.Band[3] memory band = AgenCurve.bands(initialTick);

        IERC20(token).safeTransfer(address(positionManager), supply);

        bytes memory actions = abi.encodePacked(
            uint8(Actions.MINT_POSITION),
            uint8(Actions.MINT_POSITION),
            uint8(Actions.MINT_POSITION),
            uint8(Actions.SETTLE),
            uint8(Actions.SWEEP)
        );

        bytes[] memory params = new bytes[](AgenCurve.BANDS + 2);
        uint256 allocated;

        for (uint256 i = 0; i < AgenCurve.BANDS; i++) {
            // The last band takes the remainder rather than its own percentage, so the three
            // amounts sum to the supply exactly and no crumb is left outside a position.
            uint256 amount = i + 1 == AgenCurve.BANDS
                ? supply - allocated
                : (supply * band[i].allocationBps) / AgenCurve.BPS_DENOMINATOR;
            allocated += amount;

            uint256 liquidity = LiquidityAmounts.getLiquidityForAmount1(
                TickMath.getSqrtPriceAtTick(band[i].tickLower), TickMath.getSqrtPriceAtTick(band[i].tickUpper), amount
            );
            if (liquidity == 0) revert NoLiquidity(i, amount);

            params[i] = abi.encode(
                key,
                band[i].tickLower,
                band[i].tickUpper,
                liquidity,
                uint128(0),
                // forge-lint: disable-next-line(unsafe-typecast) -- a share of a uint128-bounded supply
                uint128(amount),
                locker,
                bytes("")
            );
        }

        params[AgenCurve.BANDS] = abi.encode(key.currency1, ActionConstants.OPEN_DELTA, false);
        params[AgenCurve.BANDS + 1] = abi.encode(key.currency1, address(this));

        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }

    /// @dev The public record, written after the liquidity exists so a registered market is
    /// always one that can be traded.
    ///
    /// The vault is recorded under `ROLE_VAULT`, so a verifier reading the registry alone
    /// finds it without knowing anything about this factory. The hook is the shared engine
    /// hook, which is itself how an engine market is recognised.
    function _register(
        Manifest calldata manifest,
        PoolKey memory key,
        address token,
        address vault,
        address locker
    ) private returns (uint256) {
        AgenMarketRegistry.Component[] memory components = new AgenMarketRegistry.Component[](4);
        components[0] =
            AgenMarketRegistry.Component({addr: token, role: registry.ROLE_TOKEN(), codeHash: token.codehash});
        components[1] = AgenMarketRegistry.Component({
            addr: address(hook),
            role: registry.ROLE_HOOK(),
            codeHash: address(hook).codehash
        });
        components[2] =
            AgenMarketRegistry.Component({addr: vault, role: registry.ROLE_VAULT(), codeHash: vault.codehash});
        components[3] =
            AgenMarketRegistry.Component({addr: locker, role: registry.ROLE_LOCKER(), codeHash: locker.codehash});

        return registry.register(
            AgenMarketRegistry.Market({
                creator: msg.sender,
                token: token,
                hook: address(hook),
                poolId: PoolId.unwrap(key.toId()),
                quoteAsset: manifest.quoteAsset,
                specificationHash: manifest.specificationHash,
                implementationHash: manifest.implementationHash,
                metadataURI: manifest.metadataURI,
                // forge-lint: disable-next-line(unsafe-typecast) -- uint64 holds timestamps past year 500 billion
                createdAt: uint64(block.timestamp),
                // forge-lint: disable-next-line(unsafe-typecast)
                createdAtBlock: uint64(block.number)
            }),
            components
        );
    }

    function _create2(bytes32 salt, bytes32 initCodeHash) private view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(hex"ff", address(this), salt, initCodeHash))))
        );
    }
}
