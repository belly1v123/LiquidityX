// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ILiquidationEngine, IProtocolConfig, IPriceOracleAdapter, ILoanManager} from "./interfaces/ILiquidityX.sol";
import {LXTypes} from "./interfaces/ILiquidityXTypes.sol";

/// @title LiquidationEngine
/// @notice Lender-compensated-in-BTC liquidation (no on-chain BTC/stablecoin market is assumed):
///   debtUsd = (outstandingPrincipal + unpaid interest) * 10**(18 - d)
///   debtBtc = ceil(debtUsd * 1e18 / price)
///   lenderCollateral = min(collateral, debtBtc * (BPS + bonus) / BPS); the rest goes to the borrower.
///  Eligible when CR < liquidationCrBps (Undercollateralized) or now > maturity + grace (Overdue),
///  always at a fresh price. Only the loan's lender or KEEPER_ROLE may liquidate.
contract LiquidationEngine is ILiquidationEngine, AccessControl, ReentrancyGuard {
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    uint256 internal constant BPS = LXTypes.BPS;
    uint256 internal constant WAD = 1e18;

    /// @dev Not part of the frozen interface.
    error ZeroAddress();

    IProtocolConfig public immutable config;
    IPriceOracleAdapter public immutable oracle;
    ILoanManager public immutable loans;

    constructor(IProtocolConfig config_, IPriceOracleAdapter oracle_, ILoanManager loans_, address admin) {
        if (
            address(config_) == address(0) || address(oracle_) == address(0) || address(loans_) == address(0)
                || admin == address(0)
        ) revert ZeroAddress();
        config = config_;
        oracle = oracle_;
        loans = loans_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @inheritdoc ILiquidationEngine
    /// @dev For a non-Active loan returns (type(uint256).max, None, priceOk). When the price is not usable,
    ///  crBps is 0 (unknown) and reason can only be Overdue or None; liquidation would still revert.
    function health(uint256 loanId)
        external
        view
        override
        returns (uint256 crBps, LXTypes.LiquidationReason reason, bool priceOk)
    {
        LXTypes.Loan memory l = loans.getLoan(loanId);
        uint256 price;
        (priceOk, price,) = oracle.tryGetPrice();
        if (l.status != LXTypes.LoanStatus.Active) return (type(uint256).max, LXTypes.LiquidationReason.None, priceOk);
        (,, uint256 debt) = loans.owed(loanId);
        LXTypes.RiskParams memory rp = config.riskParams();
        uint8 dec = config.assetConfig(l.asset).decimals;
        if (priceOk) {
            crBps = _cr(l.collateral, debt, dec, price);
            reason = _reason(crBps, l.maturity, rp);
        } else {
            crBps = 0;
            reason = block.timestamp > uint256(l.maturity) + rp.gracePeriod
                ? LXTypes.LiquidationReason.Overdue
                : LXTypes.LiquidationReason.None;
        }
    }

    /// @inheritdoc ILiquidationEngine
    function previewLiquidation(uint256 loanId)
        external
        view
        override
        returns (uint256 debt, uint256 lenderCollateral, uint256 borrowerCollateral)
    {
        LXTypes.Loan memory l = loans.getLoan(loanId);
        (uint256 price,) = oracle.getPrice();
        (,, debt) = loans.owed(loanId);
        uint8 dec = config.assetConfig(l.asset).decimals;
        (lenderCollateral, borrowerCollateral) = _split(debt, dec, l.collateral, price, config.riskParams().liquidationBonusBps);
    }

    /// @inheritdoc ILiquidationEngine
    function liquidate(uint256 loanId) external override nonReentrant {
        LXTypes.Loan memory l = loans.getLoan(loanId);
        if (l.status != LXTypes.LoanStatus.Active) revert NotLiquidatable(loanId);
        if (msg.sender != l.lender && !hasRole(KEEPER_ROLE, msg.sender)) revert NotAuthorized();

        (uint256 price,) = oracle.getPrice(); // reverts StalePrice / InvalidPrice
        (,, uint256 debt) = loans.owed(loanId);
        LXTypes.RiskParams memory rp = config.riskParams();
        uint8 dec = config.assetConfig(l.asset).decimals;
        LXTypes.LiquidationReason reason = _reason(_cr(l.collateral, debt, dec, price), l.maturity, rp);
        if (reason == LXTypes.LiquidationReason.None) revert NotLiquidatable(loanId);

        (uint256 lenderCollateral, uint256 borrowerCollateral) =
            _split(debt, dec, l.collateral, price, rp.liquidationBonusBps);
        loans.settleLiquidation(loanId, lenderCollateral);
        emit Liquidated(loanId, msg.sender, reason, debt, price, lenderCollateral, borrowerCollateral);
    }

    // ------------------------------------------------------------------ internals

    function _reason(uint256 crBps, uint64 maturity, LXTypes.RiskParams memory rp)
        internal
        view
        returns (LXTypes.LiquidationReason)
    {
        if (crBps < rp.liquidationCrBps) return LXTypes.LiquidationReason.Undercollateralized;
        if (block.timestamp > uint256(maturity) + rp.gracePeriod) return LXTypes.LiquidationReason.Overdue;
        return LXTypes.LiquidationReason.None;
    }

    function _cr(uint256 collateral, uint256 debt, uint8 dec, uint256 price) internal pure returns (uint256) {
        uint256 debtUsd = debt * 10 ** (18 - dec);
        if (debtUsd == 0) return type(uint256).max;
        return Math.mulDiv(collateral, price * BPS, WAD * debtUsd);
    }

    function _split(uint256 debt, uint8 dec, uint256 collateral, uint256 price, uint256 bonusBps)
        internal
        pure
        returns (uint256 lenderCollateral, uint256 borrowerCollateral)
    {
        uint256 debtUsd = debt * 10 ** (18 - dec);
        uint256 num = debtUsd * WAD;
        uint256 debtBtc = num == 0 ? 0 : (num - 1) / price + 1;
        uint256 withBonus = debtBtc * (BPS + bonusBps) / BPS;
        lenderCollateral = withBonus < collateral ? withBonus : collateral;
        borrowerCollateral = collateral - lenderCollateral;
    }
}
