// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {
    ILoanMarketplace,
    IProtocolConfig,
    IPriceOracleAdapter,
    ILiquidityXVault,
    ICollateralManager,
    ILoanManager
} from "./interfaces/ILiquidityX.sol";
import {LXTypes} from "./interfaces/ILiquidityXTypes.sol";

/// @title LoanMarketplace
/// @notice Offers (lender liquidity reserved in the vault) and requests (borrower BTC locked in the
///  CollateralManager). Every match re-validates all terms on-chain at a fresh oracle price and opens
///  the loan through LoanManager.
contract LoanMarketplace is ILoanMarketplace, AccessControl, ReentrancyGuard {
    uint256 internal constant BPS = LXTypes.BPS;
    uint256 internal constant WAD = 1e18;

    /// @dev Not part of the frozen interface.
    error ZeroAddress();
    /// @dev Not part of the frozen interface: same selector as OpenZeppelin Pausable's error.
    error EnforcedPause();

    IProtocolConfig public immutable config;
    IPriceOracleAdapter public immutable oracle;
    ILiquidityXVault public immutable vault;
    ICollateralManager public immutable collateralManager;
    ILoanManager public immutable loans;

    uint256 public override offerCount;
    uint256 public override requestCount;
    mapping(uint256 => LXTypes.Offer) internal _offers;
    mapping(uint256 => LXTypes.Request) internal _requests;

    constructor(
        IProtocolConfig config_,
        IPriceOracleAdapter oracle_,
        ILiquidityXVault vault_,
        ICollateralManager collateral_,
        ILoanManager loans_,
        address admin
    ) {
        if (
            address(config_) == address(0) || address(oracle_) == address(0) || address(vault_) == address(0)
                || address(collateral_) == address(0) || address(loans_) == address(0) || admin == address(0)
        ) revert ZeroAddress();
        config = config_;
        oracle = oracle_;
        vault = vault_;
        collateralManager = collateral_;
        loans = loans_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    modifier whenNotPaused() {
        if (config.paused()) revert EnforcedPause();
        _;
    }

    // ================================================================== lender

    /// @inheritdoc ILoanMarketplace
    function createOffer(address asset, uint256 amount, uint16 aprBps, uint32 maxDuration, uint16 minCrBps, uint64 expiry)
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 offerId)
    {
        LXTypes.RiskParams memory rp = config.riskParams();
        _checkAssetAndSize(asset, amount);
        if (aprBps < rp.minAprBps || aprBps > rp.maxAprBps) revert InvalidApr();
        if (maxDuration < rp.minDuration || maxDuration > rp.maxDuration) revert InvalidDuration();
        if (minCrBps == 0) minCrBps = rp.minInitialCrBps;
        else if (minCrBps < rp.minInitialCrBps) revert InvalidCollateralRatio();
        _checkExpiry(expiry, rp.maxListingLifetime);

        offerId = ++offerCount;
        _offers[offerId] = LXTypes.Offer({
            id: offerId,
            lender: msg.sender,
            asset: asset,
            amount: amount,
            remaining: amount,
            aprBps: aprBps,
            maxDuration: maxDuration,
            minCrBps: minCrBps,
            expiry: expiry,
            createdAt: uint64(block.timestamp),
            fills: 0,
            status: LXTypes.OfferStatus.Open
        });

        vault.reserve(msg.sender, asset, amount);
        emit OfferCreated(offerId, msg.sender, asset, amount, aprBps, maxDuration, minCrBps, expiry);
    }

    /// @inheritdoc ILoanMarketplace
    function cancelOffer(uint256 offerId) external override nonReentrant {
        LXTypes.Offer storage o = _offers[offerId];
        if (o.status != LXTypes.OfferStatus.Open) revert OfferNotOpen(offerId);
        if (o.lender != msg.sender) revert NotOfferOwner();
        uint256 rem = o.remaining;
        o.remaining = 0;
        o.status = LXTypes.OfferStatus.Cancelled;
        if (rem > 0) vault.release(msg.sender, o.asset, rem);
        emit OfferCancelled(offerId, msg.sender, rem);
    }

    // ================================================================== borrower

    /// @inheritdoc ILoanMarketplace
    function createRequest(
        address asset,
        uint256 amount,
        uint16 maxAprBps,
        uint32 duration,
        uint256 collateral,
        uint64 expiry
    ) external payable override nonReentrant whenNotPaused returns (uint256 requestId) {
        LXTypes.RiskParams memory rp = config.riskParams();
        uint8 dec = _checkAssetAndSize(asset, amount);
        if (maxAprBps < rp.minAprBps || maxAprBps > rp.maxAprBps) revert InvalidApr();
        if (duration < rp.minDuration || duration > rp.maxDuration) revert InvalidDuration();
        _checkExpiry(expiry, rp.maxListingLifetime);
        if (collateral == 0) revert InvalidAmount();
        if (collateral > rp.maxCollateralPerLoan) revert CollateralCapExceeded(collateral, rp.maxCollateralPerLoan);
        (uint256 price,) = oracle.getPrice();
        _checkCr(collateral, amount, dec, price, rp.minInitialCrBps);

        requestId = ++requestCount;
        _requests[requestId] = LXTypes.Request({
            id: requestId,
            borrower: msg.sender,
            asset: asset,
            amount: amount,
            filled: 0,
            maxAprBps: maxAprBps,
            duration: duration,
            collateral: collateral,
            collateralRemaining: collateral,
            expiry: expiry,
            createdAt: uint64(block.timestamp),
            fills: 0,
            status: LXTypes.RequestStatus.Open
        });

        if (msg.value > 0) collateralManager.depositFor{value: msg.value}(msg.sender);
        collateralManager.lockForRequest(requestId, msg.sender, collateral);
        emit RequestCreated(requestId, msg.sender, asset, amount, maxAprBps, duration, collateral, expiry);
    }

    /// @inheritdoc ILoanMarketplace
    function cancelRequest(uint256 requestId) external override nonReentrant {
        LXTypes.Request storage r = _requests[requestId];
        if (r.status != LXTypes.RequestStatus.Open) revert RequestNotOpen(requestId);
        if (r.borrower != msg.sender) revert NotRequestOwner();
        uint256 rem = r.collateralRemaining;
        r.collateralRemaining = 0;
        r.status = LXTypes.RequestStatus.Cancelled;
        if (rem > 0) collateralManager.unlockFromRequest(requestId, msg.sender, rem);
        emit RequestCancelled(requestId, msg.sender, rem);
    }

    // ================================================================== matching

    /// @inheritdoc ILoanMarketplace
    function matchOfferAndRequest(uint256 offerId, uint256 requestId, uint256 amount)
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 loanId)
    {
        LXTypes.Offer storage o = _offers[offerId];
        LXTypes.Request storage r = _requests[requestId];
        _checkOfferOpen(o, offerId);
        _checkRequestOpen(r, requestId);
        address lender = o.lender;
        address borrower = r.borrower;
        if (msg.sender != lender && msg.sender != borrower) revert NotParty();
        if (lender == borrower) revert SelfMatch();
        if (o.asset != r.asset) revert AssetMismatch();
        if (o.aprBps > r.maxAprBps) revert AprTooHigh(o.aprBps, r.maxAprBps);
        if (r.duration > o.maxDuration) revert DurationTooLong(r.duration, o.maxDuration);
        _checkOfferFill(o, amount);

        uint256 minInit = config.riskParams().minInitialCrBps;
        uint256 required = o.minCrBps > minInit ? o.minCrBps : minInit;
        uint256 share = _takeFromRequest(r, amount, required);

        // Effects on the offer.
        uint256 rem = o.remaining - amount;
        o.remaining = rem;
        o.fills += 1;
        if (rem == 0) o.status = LXTypes.OfferStatus.Filled;

        loanId = loans.openLoan(
            ILoanManager.OpenLoanParams({
                offerId: offerId,
                requestId: requestId,
                lender: lender,
                borrower: borrower,
                asset: r.asset,
                principal: amount,
                aprBps: o.aprBps,
                duration: r.duration,
                collateral: share,
                fromReserved: true
            })
        );
        emit Matched(loanId, offerId, requestId, lender, borrower, amount, o.aprBps, share, msg.sender);
    }

    /// @inheritdoc ILoanMarketplace
    function fundRequest(uint256 requestId, uint256 amount, uint16 aprBps)
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 loanId)
    {
        LXTypes.Request storage r = _requests[requestId];
        _checkRequestOpen(r, requestId);
        address borrower = r.borrower;
        if (msg.sender == borrower) revert SelfMatch();
        // The lender names the rate; it can be anything up to the borrower's ceiling (audit 2026-11-12).
        LXTypes.RiskParams memory rp = config.riskParams();
        if (aprBps < rp.minAprBps || aprBps > r.maxAprBps) revert InvalidApr();

        uint256 share = _takeFromRequest(r, amount, rp.minInitialCrBps);

        loanId = loans.openLoan(
            ILoanManager.OpenLoanParams({
                offerId: 0,
                requestId: requestId,
                lender: msg.sender,
                borrower: borrower,
                asset: r.asset,
                principal: amount,
                aprBps: aprBps,
                duration: r.duration,
                collateral: share,
                fromReserved: false
            })
        );
        emit Matched(loanId, 0, requestId, msg.sender, borrower, amount, aprBps, share, msg.sender);
    }

    /// @inheritdoc ILoanMarketplace
    function borrowFromOffer(uint256 offerId, uint256 amount, uint32 duration, uint256 collateral)
        external
        payable
        override
        nonReentrant
        whenNotPaused
        returns (uint256 loanId)
    {
        ILoanManager.OpenLoanParams memory p = _takeFromOffer(offerId, amount, duration, collateral);
        // Interactions
        if (msg.value > 0) collateralManager.depositFor{value: msg.value}(msg.sender);
        loanId = loans.openLoan(p);
        emit Matched(loanId, offerId, 0, p.lender, msg.sender, amount, p.aprBps, collateral, msg.sender);
    }

    /// @dev Checks and offer-side effects for borrowFromOffer.
    function _takeFromOffer(uint256 offerId, uint256 amount, uint32 duration, uint256 collateral)
        internal
        returns (ILoanManager.OpenLoanParams memory p)
    {
        LXTypes.Offer storage o = _offers[offerId];
        _checkOfferOpen(o, offerId);
        if (msg.sender == o.lender) revert SelfMatch();
        LXTypes.AssetConfig memory ac = config.assetConfig(o.asset);
        if (!ac.enabled) revert AssetNotEnabled(o.asset);
        uint256 rem = o.remaining;
        if (amount == 0 || amount > rem) revert InvalidAmount();
        if (amount < ac.minLoan && amount != rem) revert FillTooSmall(amount, ac.minLoan);

        LXTypes.RiskParams memory rp = config.riskParams();
        if (duration < rp.minDuration || duration > rp.maxDuration) revert InvalidDuration();
        if (duration > o.maxDuration) revert DurationTooLong(duration, o.maxDuration);
        if (collateral == 0) revert InvalidAmount();
        if (collateral > rp.maxCollateralPerLoan) revert CollateralCapExceeded(collateral, rp.maxCollateralPerLoan);
        (uint256 price,) = oracle.getPrice();
        uint256 required = o.minCrBps > rp.minInitialCrBps ? o.minCrBps : rp.minInitialCrBps;
        _checkCr(collateral, amount, ac.decimals, price, required);

        // Effects
        rem -= amount;
        o.remaining = rem;
        o.fills += 1;
        if (rem == 0) o.status = LXTypes.OfferStatus.Filled;

        p = ILoanManager.OpenLoanParams({
            offerId: offerId,
            requestId: 0,
            lender: o.lender,
            borrower: msg.sender,
            asset: o.asset,
            principal: amount,
            aprBps: o.aprBps,
            duration: duration,
            collateral: collateral,
            fromReserved: true
        });
    }

    // ================================================================== views

    function getOffer(uint256 offerId) external view override returns (LXTypes.Offer memory) {
        return _offers[offerId];
    }

    function getRequest(uint256 requestId) external view override returns (LXTypes.Request memory) {
        return _requests[requestId];
    }

    function getOffers(uint256 start, uint256 count) external view override returns (LXTypes.Offer[] memory out) {
        (uint256 from, uint256 to) = _clamp(start, count, offerCount);
        out = new LXTypes.Offer[](to - from);
        for (uint256 i = from; i < to; ++i) {
            out[i - from] = _offers[i];
        }
    }

    function getRequests(uint256 start, uint256 count) external view override returns (LXTypes.Request[] memory out) {
        (uint256 from, uint256 to) = _clamp(start, count, requestCount);
        out = new LXTypes.Request[](to - from);
        for (uint256 i = from; i < to; ++i) {
            out[i - from] = _requests[i];
        }
    }

    function quoteCollateralRatio(address asset, uint256 amount, uint256 collateral)
        external
        view
        override
        returns (uint256 crBps)
    {
        uint8 dec = _decimals(asset);
        (uint256 price,) = oracle.getPrice();
        return _cr(collateral, amount, dec, price);
    }

    function maxBorrow(address asset, uint256 collateral, uint16 crBps) external view override returns (uint256 amount) {
        uint8 dec = _decimals(asset);
        uint256 cr = crBps == 0 ? config.riskParams().minInitialCrBps : crBps;
        (uint256 price,) = oracle.getPrice();
        uint256 usd = Math.mulDiv(collateral, price * BPS, WAD * cr);
        return usd / 10 ** (18 - dec);
    }

    function minCollateral(address asset, uint256 amount, uint16 crBps) external view override returns (uint256 collateral) {
        uint8 dec = _decimals(asset);
        uint256 cr = crBps == 0 ? config.riskParams().minInitialCrBps : crBps;
        (uint256 price,) = oracle.getPrice();
        uint256 num = amount * 10 ** (18 - dec) * cr * WAD;
        if (num == 0) return 0;
        return (num - 1) / (BPS * price) + 1;
    }

    // ================================================================== internals

    /// @dev Shared by matchOfferAndRequest and fundRequest: validates size, computes the pro-rata collateral
    ///  share, checks it at a fresh price against `requiredCr`, and applies the request-side effects.
    function _takeFromRequest(LXTypes.Request storage r, uint256 amount, uint256 requiredCr)
        internal
        returns (uint256 share)
    {
        LXTypes.AssetConfig memory ac = config.assetConfig(r.asset);
        if (!ac.enabled) revert AssetNotEnabled(r.asset);
        uint256 unfilled = r.amount - r.filled;
        if (amount == 0 || amount > unfilled) revert InvalidAmount();
        bool completes = amount == unfilled;
        if (amount < ac.minLoan && !completes) revert FillTooSmall(amount, ac.minLoan);

        // Partial fills round the pro-rata share UP (capped at what is left) so a request posted at exactly the
        // minimum ratio can still be filled in parts; the completing fill takes the remainder (audit 2026-11-12).
        if (completes) {
            share = r.collateralRemaining;
        } else {
            share = Math.mulDiv(r.collateral, amount, r.amount, Math.Rounding.Ceil);
            if (share > r.collateralRemaining) share = r.collateralRemaining;
        }
        uint256 cap = config.riskParams().maxCollateralPerLoan;
        if (share > cap) revert CollateralCapExceeded(share, cap);
        (uint256 price,) = oracle.getPrice();
        _checkCr(share, amount, ac.decimals, price, requiredCr);

        r.filled += amount;
        r.collateralRemaining -= share;
        r.fills += 1;
        if (completes) r.status = LXTypes.RequestStatus.Filled;
    }

    /// @dev Offer-side size rule for matches, same as borrowFromOffer: no fill below minLoan unless it empties the offer.
    function _checkOfferFill(LXTypes.Offer storage o, uint256 amount) internal view {
        if (amount == 0 || amount > o.remaining) revert InvalidAmount();
        uint256 minLoan = config.assetConfig(o.asset).minLoan;
        if (amount < minLoan && amount != o.remaining) revert FillTooSmall(amount, minLoan);
    }

    function _checkOfferOpen(LXTypes.Offer storage o, uint256 offerId) internal view {
        if (o.status != LXTypes.OfferStatus.Open) revert OfferNotOpen(offerId);
        if (block.timestamp >= o.expiry) revert OfferExpired(offerId);
    }

    function _checkRequestOpen(LXTypes.Request storage r, uint256 requestId) internal view {
        if (r.status != LXTypes.RequestStatus.Open) revert RequestNotOpen(requestId);
        if (block.timestamp >= r.expiry) revert RequestExpired(requestId);
    }

    function _checkAssetAndSize(address asset, uint256 amount) internal view returns (uint8) {
        LXTypes.AssetConfig memory ac = config.assetConfig(asset);
        if (!ac.enabled) revert AssetNotEnabled(asset);
        if (amount < ac.minLoan || amount > ac.maxLoan) revert InvalidAmount();
        return ac.decimals;
    }

    function _checkExpiry(uint64 expiry, uint32 maxLifetime) internal view {
        if (expiry <= block.timestamp || expiry > block.timestamp + maxLifetime) revert InvalidExpiry();
    }

    function _checkCr(uint256 collateral, uint256 amount, uint8 dec, uint256 price, uint256 required) internal pure {
        uint256 cr = _cr(collateral, amount, dec, price);
        if (cr < required) revert InsufficientCollateral(cr, required);
    }

    function _cr(uint256 collateral, uint256 amount, uint8 dec, uint256 price) internal pure returns (uint256) {
        uint256 debtUsd = amount * 10 ** (18 - dec);
        if (debtUsd == 0) return type(uint256).max;
        // One floor, after the multiply, so the check agrees with minCollateral's exact ceiling (audit 2026-11-12).
        return Math.mulDiv(collateral, price * BPS, WAD * debtUsd);
    }

    function _decimals(address asset) internal view returns (uint8 dec) {
        dec = config.assetConfig(asset).decimals;
        if (dec == 0) revert AssetNotEnabled(asset);
    }

    function _clamp(uint256 start, uint256 count, uint256 total) internal pure returns (uint256 from, uint256 to) {
        from = start == 0 ? 1 : start;
        if (from > total) return (from, from);
        uint256 maxCount = total + 1 - from;
        to = from + (count < maxCount ? count : maxCount);
    }
}
