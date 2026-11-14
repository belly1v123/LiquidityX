// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IProtocolConfig} from "./interfaces/ILiquidityX.sol";
import {LXTypes} from "./interfaces/ILiquidityXTypes.sol";

/// @title ProtocolConfig
/// @notice Risk parameters, the borrow-asset allowlist and the global pause switch.
contract ProtocolConfig is IProtocolConfig, AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant RISK_ADMIN_ROLE = keccak256("RISK_ADMIN_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @dev Not part of the frozen interface: zero admin in the constructor.
    error ZeroAddress();

    LXTypes.RiskParams internal _params;
    mapping(address => LXTypes.AssetConfig) internal _assets;
    mapping(address => bool) internal _known;
    address[] internal _assetList;

    constructor(LXTypes.RiskParams memory params, address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RISK_ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
        _setRiskParams(params);
    }

    // ------------------------------------------------------------------ pause

    function paused() public view override(IProtocolConfig, Pausable) returns (bool) {
        return Pausable.paused();
    }

    function pause() external override onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external override onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ------------------------------------------------------------------ views

    function riskParams() external view override returns (LXTypes.RiskParams memory) {
        return _params;
    }

    function assetConfig(address asset) external view override returns (LXTypes.AssetConfig memory) {
        return _assets[asset];
    }

    function isAssetEnabled(address asset) external view override returns (bool) {
        return _assets[asset].enabled;
    }

    function listAssets() external view override returns (address[] memory) {
        return _assetList;
    }

    // ------------------------------------------------------------------ admin

    function setRiskParams(LXTypes.RiskParams calldata params) external override onlyRole(RISK_ADMIN_ROLE) nonReentrant {
        _setRiskParams(params);
    }

    function configureAsset(address asset, bool enabled, uint256 minLoan, uint256 maxLoan)
        external
        override
        onlyRole(RISK_ADMIN_ROLE)
        nonReentrant
    {
        if (asset == address(0) || asset.code.length == 0) revert InvalidAsset();
        if (minLoan == 0 || minLoan > maxLoan) revert InvalidAsset();
        uint8 d;
        try IERC20Metadata(asset).decimals() returns (uint8 dec) {
            d = dec;
        } catch {
            revert InvalidAsset();
        }
        if (d == 0 || d > 18) revert InvalidAsset();
        _assets[asset] = LXTypes.AssetConfig({enabled: enabled, decimals: d, minLoan: minLoan, maxLoan: maxLoan});
        if (!_known[asset]) {
            _known[asset] = true;
            _assetList.push(asset);
        }
        emit AssetConfigured(asset, enabled, d, minLoan, maxLoan);
    }

    function _setRiskParams(LXTypes.RiskParams memory p) internal {
        if (
            p.liquidationCrBps < 10_500 || p.liquidationCrBps >= p.minInitialCrBps || p.minInitialCrBps > 50_000
                || p.liquidationBonusBps > 2_000 || uint256(LXTypes.BPS) + p.liquidationBonusBps > p.liquidationCrBps
                || p.minAprBps < 1 || p.minAprBps > p.maxAprBps || p.maxAprBps > 50_000 || p.minDuration < 60
                || p.minDuration > p.maxDuration || p.maxDuration > 730 days || p.gracePeriod > 30 days
                || p.maxListingLifetime < 1 hours || p.maxListingLifetime > 365 days || p.maxCollateralPerLoan == 0
        ) revert InvalidRiskParams();
        _params = p;
        emit RiskParamsUpdated(p);
    }
}
