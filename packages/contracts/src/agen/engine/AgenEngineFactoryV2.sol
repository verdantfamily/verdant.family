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

import {AgenCurve} from "../AgenCurve.sol";
import {AgenMarketRegistry} from "../AgenMarketRegistry.sol";
import {AgenEngineDeployerV2} from "./AgenEngineDeployerV2.sol";
import {AgenEnginePotDeployerV2} from "./AgenEnginePotDeployerV2.sol";
import {AgenEngineHookV2} from "./AgenEngineHookV2.sol";
import {AgenEngineVault} from "./AgenEngineVault.sol";
import {AgenRuleLib} from "./AgenRuleLib.sol";
import {AgenRuleLibV2} from "./AgenRuleLibV2.sol";
import {IAgenEngineHookV2} from "./IAgenEngineHookV2.sol";

/// @title AgenEngineFactoryV2
/// @notice Launches an engine-v2 market: notifying token, shared v2 hook, holder and
/// buyback pots. Parallel to `AgenEngineFactory`; nothing v1 is reused on chain.
contract AgenEngineFactoryV2 is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    struct Manifest {
        string name;
        string symbol;
        uint256 supply;
        string metadataURI;
        bool metadataMutable;
        bytes32 tokenSalt;
        address quoteAsset;
        int24 initialTick;
        AgenRuleLibV2.Config config;
        address feeReceiver;
        bytes32 specificationHash;
        bytes32 implementationHash;
    }

    struct Launch {
        address locker;
        uint256 firstTokenId;
        uint256 supply;
    }

    IPoolManager public immutable poolManager;
    IPositionManager public immutable positionManager;
    AgenMarketRegistry public immutable registry;
    AgenEngineDeployerV2 public immutable deployer;
    /// @notice Holds the pots' bytecode. See `AgenEnginePotDeployerV2` for why it is second.
    AgenEnginePotDeployerV2 public immutable potDeployer;
    AgenEngineHookV2 public immutable hook;
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
    error CommitmentMismatch(bytes32 declared, bytes32 computed);

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

    constructor(
        IPoolManager poolManager_,
        IPositionManager positionManager_,
        AgenEngineDeployerV2 deployer_,
        AgenEnginePotDeployerV2 potDeployer_,
        AgenMarketRegistry registry_,
        AgenEngineHookV2 hook_,
        address treasury_
    ) {
        if (address(poolManager_) == address(0)) revert ZeroPoolManager();
        if (address(positionManager_) == address(0)) revert ZeroPositionManager();
        if (treasury_ == address(0)) revert ZeroTreasury();
        if (deployer_.factory() != address(this)) revert WrongDeployer(address(this), deployer_.factory());
        if (potDeployer_.factory() != address(this)) revert WrongDeployer(address(this), potDeployer_.factory());
        if (registry_.factory() != address(this)) revert WrongRegistry(address(this), registry_.factory());
        if (hook_.factory() != address(this)) revert HookNotOurs(hook_.factory(), address(this));

        poolManager = poolManager_;
        positionManager = positionManager_;
        deployer = deployer_;
        potDeployer = potDeployer_;
        registry = registry_;
        hook = hook_;
        treasury = treasury_;
    }

    function deployMarket(Manifest calldata manifest) external nonReentrant returns (uint256 index) {
        if (manifest.supply == 0) revert ZeroSupply();
        if (manifest.feeReceiver == address(0)) revert ZeroFeeReceiver();
        if (manifest.supply != manifest.config.referenceSupply) {
            revert SupplyMismatch(manifest.supply, manifest.config.referenceSupply);
        }
        if (manifest.quoteAsset != manifest.config.quoteAsset) {
            revert QuoteAssetMismatch(manifest.quoteAsset, manifest.config.quoteAsset);
        }
        AgenCurve.validate(manifest.initialTick);

        address token = deployer.deployToken(
            manifest.tokenSalt,
            manifest.name,
            manifest.symbol,
            manifest.supply,
            msg.sender,
            manifest.metadataURI,
            manifest.metadataMutable,
            address(hook)
        );
        if (token <= manifest.quoteAsset) revert TokenNotAboveQuote(token, manifest.quoteAsset);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(manifest.quoteAsset),
            currency1: Currency.wrap(token),
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: AgenCurve.TICK_SPACING,
            hooks: IHooks(address(hook))
        });

        AgenEngineVault vault = _deployVault(manifest, key);
        bytes32 configHash = hook.configure(key, manifest.config, vault);

        bytes32 computed = AgenRuleLibV2.implementationHash(
            configHash, block.chainid, address(hook), manifest.config.engineVersion
        );
        if (computed != manifest.implementationHash) {
            revert CommitmentMismatch(manifest.implementationHash, computed);
        }

        poolManager.initialize(key, TickMath.getSqrtPriceAtTick(manifest.initialTick));

        Launch memory launch = _openLiquidity(manifest, key, token);
        hook.excludeHolder(key.toId(), address(vault));

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

    function predictToken(Manifest calldata manifest) external view returns (address) {
        return deployer.computeAddress(
            manifest.tokenSalt,
            deployer.tokenInitCodeHash(
                manifest.name,
                manifest.symbol,
                manifest.supply,
                msg.sender,
                manifest.metadataURI,
                manifest.metadataMutable,
                address(hook)
            )
        );
    }

    function vaultSalt(bytes32 tokenSalt) public pure returns (bytes32) {
        return keccak256(abi.encodePacked("agen.engine.vault", tokenSalt));
    }

    function _deployVault(Manifest calldata manifest, PoolKey memory key) private returns (AgenEngineVault) {
        uint256 count = manifest.config.distribution.length;
        address[] memory recipients = new address[](count);
        uint24[] memory shares = new uint24[](count);

        for (uint256 i = 0; i < count; i++) {
            AgenRuleLibV2.Share calldata share = manifest.config.distribution[i];
            shares[i] = share.sharePpm;

            if (share.kind == AgenRuleLibV2.KIND_CREATOR) {
                recipients[i] = msg.sender;
            } else if (share.kind == AgenRuleLibV2.KIND_TREASURY) {
                recipients[i] = treasury;
            } else if (share.kind == AgenRuleLibV2.KIND_LARGEST_HOLDER) {
                recipients[i] = potDeployer.deployHolderPot(IAgenEngineHookV2(address(hook)), i);
            } else if (share.kind == AgenRuleLibV2.KIND_BUYBACK) {
                recipients[i] = potDeployer.deployBuybackPot(IAgenEngineHookV2(address(hook)), i);
            } else {
                recipients[i] = share.recipient;
            }
        }

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

        // Exclude before the supply moves, so the locker never accrues as a "holder".
        hook.excludeHolder(key.toId(), launch.locker);
        hook.excludeHolder(key.toId(), address(positionManager));
        hook.excludeHolder(key.toId(), address(this));
        hook.excludeHolder(key.toId(), address(hook));
        hook.excludeHolder(key.toId(), address(poolManager));

        _mintBands(key, manifest.initialTick, token, launch.locker, launch.supply);

        for (uint256 i = 0; i < AgenCurve.BANDS; i++) {
            uint256 tokenId = launch.firstTokenId + i;
            address owner = IERC721(address(positionManager)).ownerOf(tokenId);
            if (owner != launch.locker) revert PositionNotLocked(tokenId, owner, launch.locker);
        }

        uint256 dust = IERC20(token).balanceOf(address(this));
        if (dust != 0) IERC20(token).safeTransfer(msg.sender, dust);
    }

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
                // forge-lint: disable-next-line(unsafe-typecast)
                uint128(amount),
                locker,
                bytes("")
            );
        }

        params[AgenCurve.BANDS] = abi.encode(key.currency1, ActionConstants.OPEN_DELTA, false);
        params[AgenCurve.BANDS + 1] = abi.encode(key.currency1, address(this));

        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp);
    }

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
                // forge-lint: disable-next-line(unsafe-typecast)
                createdAt: uint64(block.timestamp),
                // forge-lint: disable-next-line(unsafe-typecast)
                createdAtBlock: uint64(block.number)
            }),
            components
        );
    }
}
