// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {LoanMarketplace} from "../src/LoanMarketplace.sol";
import {
    ILoanMarketplace, IPriceOracleAdapter, ILiquidityXVault, ICollateralManager
} from "../src/interfaces/ILiquidityX.sol";
import {LXTypes} from "../src/interfaces/ILiquidityXTypes.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract MarketplaceTest is BaseTest {
    address internal M; // musd shorthand

    function setUp() public override {
        super.setUp();
        M = address(musd);
    }

    // ================================================================== offers

    function test_createOffer() public {
        _deposit(lender, M, 1_000e18);
        uint64 exp = uint64(block.timestamp + 1 days);
        vm.expectEmit(true, true, true, true, address(market));
        emit ILoanMarketplace.OfferCreated(1, lender, M, 1_000e18, 500, 30 days, 15_000, exp);
        uint256 id = _offerFull(lender, M, 1_000e18, 500, 30 days, 0, exp);
        assertEq(id, 1);
        LXTypes.Offer memory o = market.getOffer(1);
        assertEq(o.lender, lender);
        assertEq(o.remaining, 1_000e18);
        assertEq(o.minCrBps, 15_000); // 0 => config minimum
        assertEq(uint8(o.status), uint8(LXTypes.OfferStatus.Open));
        assertEq(o.createdAt, block.timestamp);
        assertEq(vault.reserved(lender, M), 1_000e18);
        assertEq(market.offerCount(), 1);
    }

    function test_createOffer_custom_minCr() public {
        _deposit(lender, M, 1_000e18);
        uint256 id = _offerFull(lender, M, 1_000e18, 500, 30 days, 20_000, uint64(block.timestamp + 1 days));
        assertEq(market.getOffer(id).minCrBps, 20_000);
    }

    function test_createOffer_validation() public {
        _deposit(lender, M, 10_000_000e18);
        uint64 exp = uint64(block.timestamp + 1 days);
        MockERC20 other = new MockERC20("X", "X", 18);
        vm.startPrank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.AssetNotEnabled.selector, address(other)));
        market.createOffer(address(other), 10e18, 500, 1 days, 0, exp);
        vm.expectRevert(ILoanMarketplace.InvalidAmount.selector);
        market.createOffer(M, 1e18 - 1, 500, 1 days, 0, exp);
        vm.expectRevert(ILoanMarketplace.InvalidAmount.selector);
        market.createOffer(M, 1_000_000e18 + 1, 500, 1 days, 0, exp);
        vm.expectRevert(ILoanMarketplace.InvalidApr.selector);
        market.createOffer(M, 10e18, 0, 1 days, 0, exp);
        vm.expectRevert(ILoanMarketplace.InvalidApr.selector);
        market.createOffer(M, 10e18, 10_001, 1 days, 0, exp);
        vm.expectRevert(ILoanMarketplace.InvalidDuration.selector);
        market.createOffer(M, 10e18, 500, 1 hours - 1, 0, exp);
        vm.expectRevert(ILoanMarketplace.InvalidDuration.selector);
        market.createOffer(M, 10e18, 500, 365 days + 1, 0, exp);
        vm.expectRevert(ILoanMarketplace.InvalidCollateralRatio.selector);
        market.createOffer(M, 10e18, 500, 1 days, 14_999, exp);
        vm.expectRevert(ILoanMarketplace.InvalidExpiry.selector);
        market.createOffer(M, 10e18, 500, 1 days, 0, uint64(block.timestamp));
        vm.expectRevert(ILoanMarketplace.InvalidExpiry.selector);
        market.createOffer(M, 10e18, 500, 1 days, 0, uint64(block.timestamp + 30 days + 1));
        vm.stopPrank();
    }

    function test_createOffer_needs_available() public {
        _deposit(lender, M, 5e18);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILiquidityXVault.InsufficientAvailable.selector, 5e18, 10e18));
        market.createOffer(M, 10e18, 500, 1 days, 0, uint64(block.timestamp + 1 days));
    }

    function test_cancelOffer() public {
        uint256 id = _depositAndOffer(lender, 1_000e18, 500);
        vm.expectEmit(true, true, false, true, address(market));
        emit ILoanMarketplace.OfferCancelled(id, lender, 1_000e18);
        vm.prank(lender);
        market.cancelOffer(id);
        assertEq(uint8(market.getOffer(id).status), uint8(LXTypes.OfferStatus.Cancelled));
        assertEq(market.getOffer(id).remaining, 0);
        assertEq(vault.available(lender, M), 1_000e18);
        assertEq(vault.reserved(lender, M), 0);
        // double cancel
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.OfferNotOpen.selector, id));
        market.cancelOffer(id);
    }

    function test_cancelOffer_not_owner() public {
        uint256 id = _depositAndOffer(lender, 1_000e18, 500);
        vm.prank(stranger);
        vm.expectRevert(ILoanMarketplace.NotOfferOwner.selector);
        market.cancelOffer(id);
    }

    function test_cancel_expired_offer_releases() public {
        uint256 id = _depositAndOffer(lender, 1_000e18, 500);
        vm.warp(block.timestamp + 8 days);
        vm.prank(lender);
        market.cancelOffer(id);
        assertEq(vault.available(lender, M), 1_000e18);
    }

    function test_cancel_partially_filled_offer() public {
        uint256 oid = _depositAndOffer(lender, 1_000e18, 500);
        uint256 rid = _request(borrower, M, 400e18, 800, 1 days, _coll(400e18, 20_000));
        vm.prank(lender);
        market.matchOfferAndRequest(oid, rid, 400e18);
        vm.prank(lender);
        market.cancelOffer(oid);
        assertEq(vault.available(lender, M), 600e18);
        assertEq(vault.lent(lender, M), 400e18);
    }

    // ================================================================== requests

    function test_createRequest() public {
        uint256 c = _coll(1_000e18, 15_000);
        uint64 exp = uint64(block.timestamp + 1 days);
        vm.expectEmit(true, true, true, true, address(market));
        emit ILoanMarketplace.RequestCreated(1, borrower, M, 1_000e18, 800, 1 days, c, exp);
        vm.prank(borrower);
        uint256 id = market.createRequest{value: c}(M, 1_000e18, 800, 1 days, c, exp);
        LXTypes.Request memory r = market.getRequest(id);
        assertEq(r.borrower, borrower);
        assertEq(r.collateral, c);
        assertEq(r.collateralRemaining, c);
        assertEq(uint8(r.status), uint8(LXTypes.RequestStatus.Open));
        assertEq(cm.requestCollateral(id), c);
        assertEq(address(cm).balance, c);
        assertEq(address(market).balance, 0);
    }

    function test_createRequest_from_free_collateral() public {
        uint256 c = _coll(1_000e18, 20_000);
        vm.prank(borrower);
        cm.depositCollateral{value: c}();
        vm.prank(borrower);
        uint256 id = market.createRequest(M, 1_000e18, 800, 1 days, c, uint64(block.timestamp + 1 days));
        assertEq(cm.requestCollateral(id), c);
        assertEq(cm.freeCollateral(borrower), 0);
    }

    function test_createRequest_excess_value_stays_free() public {
        uint256 c = _coll(1_000e18, 20_000);
        vm.prank(borrower);
        market.createRequest{value: c + 1 ether}(M, 1_000e18, 800, 1 days, c, uint64(block.timestamp + 1 days));
        assertEq(cm.freeCollateral(borrower), 1 ether);
    }

    function test_createRequest_validation() public {
        uint64 exp = uint64(block.timestamp + 1 days);
        uint256 c = _coll(1_000e18, 20_000);
        vm.startPrank(borrower);
        vm.expectRevert(ILoanMarketplace.InvalidAmount.selector);
        market.createRequest{value: c}(M, 0, 800, 1 days, c, exp);
        vm.expectRevert(ILoanMarketplace.InvalidApr.selector);
        market.createRequest{value: c}(M, 1_000e18, 0, 1 days, c, exp);
        vm.expectRevert(ILoanMarketplace.InvalidDuration.selector);
        market.createRequest{value: c}(M, 1_000e18, 800, 59 minutes, c, exp);
        vm.expectRevert(ILoanMarketplace.InvalidExpiry.selector);
        market.createRequest{value: c}(M, 1_000e18, 800, 1 days, c, uint64(block.timestamp - 1));
        vm.expectRevert(ILoanMarketplace.InvalidAmount.selector);
        market.createRequest(M, 1_000e18, 800, 1 days, 0, exp);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.CollateralCapExceeded.selector, 10 ether + 1, 10 ether));
        market.createRequest{value: 10 ether + 1}(M, 1_000e18, 800, 1 days, 10 ether + 1, exp);
        // CR just below 150%
        uint256 low = _coll(1_000e18, 15_000) - 1e10;
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.InsufficientCollateral.selector, 14_999, 15_000));
        market.createRequest{value: low}(M, 1_000e18, 800, 1 days, low, exp);
        // value short of collateral and no free balance
        vm.expectRevert(abi.encodeWithSelector(ICollateralManager.InsufficientFree.selector, c - 1, c));
        market.createRequest{value: c - 1}(M, 1_000e18, 800, 1 days, c, exp);
        vm.stopPrank();
    }

    function test_cancelRequest() public {
        uint256 c = _coll(1_000e18, 20_000);
        uint256 id = _request(borrower, M, 1_000e18, 800, 1 days, c);
        vm.prank(stranger);
        vm.expectRevert(ILoanMarketplace.NotRequestOwner.selector);
        market.cancelRequest(id);
        vm.expectEmit(true, true, false, true, address(market));
        emit ILoanMarketplace.RequestCancelled(id, borrower, c);
        vm.prank(borrower);
        market.cancelRequest(id);
        assertEq(cm.freeCollateral(borrower), c);
        assertEq(cm.requestCollateral(id), 0);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.RequestNotOpen.selector, id));
        market.cancelRequest(id);
        // withdraw afterwards
        vm.prank(borrower);
        cm.withdrawCollateral(c);
    }

    // ================================================================== match: success + A/B/C

    function test_match_full() public {
        uint256 oid = _depositAndOffer(lender, 1_000e18, 500);
        uint256 c = _coll(1_000e18, 20_000);
        uint256 rid = _request(borrower, M, 1_000e18, 800, 30 days, c);
        uint256 bBefore = musd.balanceOf(borrower);

        vm.expectEmit(true, true, true, true, address(market));
        emit ILoanMarketplace.Matched(1, oid, rid, lender, borrower, 1_000e18, 500, c, borrower);
        vm.prank(borrower);
        uint256 lid = market.matchOfferAndRequest(oid, rid, 1_000e18);

        assertEq(lid, 1);
        assertEq(musd.balanceOf(borrower), bBefore + 1_000e18);
        assertEq(uint8(market.getOffer(oid).status), uint8(LXTypes.OfferStatus.Filled));
        assertEq(uint8(market.getRequest(rid).status), uint8(LXTypes.RequestStatus.Filled));
        assertEq(market.getRequest(rid).collateralRemaining, 0);
        LXTypes.Loan memory l = _loan(lid);
        assertEq(l.lender, lender);
        assertEq(l.borrower, borrower);
        assertEq(l.principal, 1_000e18);
        assertEq(l.aprBps, 500);
        assertEq(l.collateral, c);
        assertEq(l.maturity, block.timestamp + 30 days);
        assertEq(l.offerId, oid);
        assertEq(l.requestId, rid);
        assertEq(cm.loanCollateral(lid), c);
        assertEq(cm.requestCollateral(rid), 0);
        assertEq(vault.lent(lender, M), 1_000e18);
        assertEq(vault.reserved(lender, M), 0);
    }

    /// docs/CONTRACTS.md partial matching example.
    function test_partial_match_ABC_example() public {
        uint256 A = _depositAndOffer(lender, 400e18, 500);
        uint256 B = _depositAndOffer(lender2, 300e18, 600);
        uint256 C = _depositAndOffer(lender3, 1_000e18, 900);
        uint256 coll = 3 ether; // 1,000 MUSD vs $300,000 => 30,000% CR
        uint256 rid = _request(borrower, M, 1_000e18, 800, 30 days, coll);

        vm.prank(lender);
        uint256 l1 = market.matchOfferAndRequest(A, rid, 400e18);
        vm.prank(borrower);
        uint256 l2 = market.matchOfferAndRequest(B, rid, 300e18);

        assertEq(_loan(l1).principal, 400e18);
        assertEq(_loan(l1).aprBps, 500);
        assertEq(_loan(l1).collateral, coll * 40 / 100);
        assertEq(_loan(l2).principal, 300e18);
        assertEq(_loan(l2).aprBps, 600);
        assertEq(_loan(l2).collateral, coll * 30 / 100);

        LXTypes.Request memory r = market.getRequest(rid);
        assertEq(uint8(r.status), uint8(LXTypes.RequestStatus.Open));
        assertEq(r.amount - r.filled, 300e18);
        assertEq(r.collateralRemaining, coll - coll * 70 / 100);
        assertEq(r.fills, 2);
        assertEq(uint8(market.getOffer(A).status), uint8(LXTypes.OfferStatus.Filled));
        assertEq(uint8(market.getOffer(B).status), uint8(LXTypes.OfferStatus.Filled));

        vm.prank(lender3);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.AprTooHigh.selector, 900, 800));
        market.matchOfferAndRequest(C, rid, 300e18);

        // The final fill takes collateralRemaining exactly.
        uint256 D = _depositAndOffer(lender3, 300e18, 800);
        vm.prank(lender3);
        uint256 l3 = market.matchOfferAndRequest(D, rid, 300e18);
        assertEq(_loan(l3).collateral, coll - coll * 70 / 100);
        assertEq(uint8(market.getRequest(rid).status), uint8(LXTypes.RequestStatus.Filled));
        assertEq(market.getRequest(rid).collateralRemaining, 0);
        assertEq(cm.requestCollateral(rid), 0);
        assertEq(cm.totalLockedInLoans(), coll);
    }

    function test_partial_share_rounds_up() public {
        uint256 oid = _depositAndOffer(lender, 1_000e18, 500);
        uint256 coll = 1 ether + 7; // not divisible
        uint256 rid = _request(borrower, M, 3e18, 800, 1 days, coll);
        vm.prank(lender);
        uint256 lid = market.matchOfferAndRequest(oid, rid, 1e18);
        uint256 ceilShare = (coll + 2) / 3; // ceil(coll / 3): partial shares round up (audit 2026-11-12)
        assertEq(_loan(lid).collateral, ceilShare);
        assertEq(market.getRequest(rid).collateralRemaining, coll - ceilShare);
    }

    // ================================================================== match failures

    function _setupPair() internal returns (uint256 oid, uint256 rid) {
        oid = _depositAndOffer(lender, 1_000e18, 500);
        rid = _request(borrower, M, 1_000e18, 800, 1 days, _coll(1_000e18, 20_000));
    }

    function test_match_expired() public {
        (uint256 oid, uint256 rid) = _setupPair();
        vm.warp(market.getOffer(oid).expiry);
        _setPrice(PRICE);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.OfferExpired.selector, oid));
        market.matchOfferAndRequest(oid, rid, 1_000e18);
    }

    function test_match_request_expired() public {
        _deposit(lender, M, 1_000e18);
        uint256 o = _offerFull(lender, M, 1_000e18, 500, 30 days, 0, uint64(block.timestamp + 20 days));
        uint256 rid = _request(borrower, M, 1_000e18, 800, 1 days, _coll(1_000e18, 20_000)); // expires +7d
        vm.warp(block.timestamp + 7 days);
        _setPrice(PRICE);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.RequestExpired.selector, rid));
        market.matchOfferAndRequest(o, rid, 1_000e18);
    }

    function test_match_cancelled() public {
        (uint256 oid, uint256 rid) = _setupPair();
        vm.prank(lender);
        market.cancelOffer(oid);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.OfferNotOpen.selector, oid));
        market.matchOfferAndRequest(oid, rid, 1_000e18);

        uint256 oid2 = _depositAndOffer(lender2, 1_000e18, 500);
        vm.prank(borrower);
        market.cancelRequest(rid);
        vm.prank(lender2);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.RequestNotOpen.selector, rid));
        market.matchOfferAndRequest(oid2, rid, 1_000e18);
    }

    function test_match_filled_and_double_match() public {
        (uint256 oid, uint256 rid) = _setupPair();
        vm.prank(lender);
        market.matchOfferAndRequest(oid, rid, 1_000e18);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.OfferNotOpen.selector, oid));
        market.matchOfferAndRequest(oid, rid, 1_000e18);
        uint256 oid2 = _depositAndOffer(lender2, 1_000e18, 500);
        vm.prank(lender2);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.RequestNotOpen.selector, rid));
        market.matchOfferAndRequest(oid2, rid, 1_000e18);
    }

    function test_match_overfill_reverts() public {
        uint256 oid = _depositAndOffer(lender, 500e18, 500);
        uint256 rid = _request(borrower, M, 1_000e18, 800, 1 days, _coll(1_000e18, 20_000));
        vm.prank(lender);
        vm.expectRevert(ILoanMarketplace.InvalidAmount.selector);
        market.matchOfferAndRequest(oid, rid, 501e18); // > offer.remaining
        uint256 big = _depositAndOffer(lender2, 2_000e18, 500);
        vm.prank(lender2);
        vm.expectRevert(ILoanMarketplace.InvalidAmount.selector);
        market.matchOfferAndRequest(big, rid, 1_001e18); // > request unfilled
        vm.prank(lender2);
        vm.expectRevert(ILoanMarketplace.InvalidAmount.selector);
        market.matchOfferAndRequest(big, rid, 0);
    }

    function test_match_apr_too_high() public {
        uint256 oid = _depositAndOffer(lender, 1_000e18, 900);
        uint256 rid = _request(borrower, M, 1_000e18, 800, 1 days, _coll(1_000e18, 20_000));
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.AprTooHigh.selector, 900, 800));
        market.matchOfferAndRequest(oid, rid, 1_000e18);
    }

    function test_match_duration_too_long() public {
        _deposit(lender, M, 1_000e18);
        uint256 oid = _offerFull(lender, M, 1_000e18, 500, 1 days, 0, uint64(block.timestamp + 7 days));
        uint256 rid = _request(borrower, M, 1_000e18, 800, 2 days, _coll(1_000e18, 20_000));
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.DurationTooLong.selector, 2 days, 1 days));
        market.matchOfferAndRequest(oid, rid, 1_000e18);
    }

    function test_match_insufficient_cr_offer_minCr() public {
        _deposit(lender, M, 1_000e18);
        uint256 oid = _offerFull(lender, M, 1_000e18, 500, 30 days, 25_000, uint64(block.timestamp + 7 days));
        uint256 rid = _request(borrower, M, 1_000e18, 800, 1 days, _coll(1_000e18, 20_000));
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.InsufficientCollateral.selector, 20_000, 25_000));
        market.matchOfferAndRequest(oid, rid, 1_000e18);
    }

    function test_match_insufficient_cr_after_price_drop() public {
        (uint256 oid, uint256 rid) = _setupPair(); // 200% at $100k
        _setPrice(70_000e18); // => 140%
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.InsufficientCollateral.selector, 14_000, 15_000));
        market.matchOfferAndRequest(oid, rid, 1_000e18);
    }

    function test_match_self() public {
        _deposit(borrower, M, 1_000e18);
        uint256 oid = _offer(borrower, M, 1_000e18, 500);
        uint256 rid = _request(borrower, M, 1_000e18, 800, 1 days, _coll(1_000e18, 20_000));
        vm.prank(borrower);
        vm.expectRevert(ILoanMarketplace.SelfMatch.selector);
        market.matchOfferAndRequest(oid, rid, 1_000e18);
    }

    function test_match_asset_mismatch() public {
        _deposit(lender, address(usdc), 1_000e6);
        uint256 oid = _offer(lender, address(usdc), 1_000e6, 500);
        uint256 rid = _request(borrower, M, 1_000e18, 800, 1 days, _coll(1_000e18, 20_000));
        vm.prank(lender);
        vm.expectRevert(ILoanMarketplace.AssetMismatch.selector);
        market.matchOfferAndRequest(oid, rid, 1_000e18);
    }

    function test_match_not_party() public {
        (uint256 oid, uint256 rid) = _setupPair();
        vm.prank(stranger);
        vm.expectRevert(ILoanMarketplace.NotParty.selector);
        market.matchOfferAndRequest(oid, rid, 1_000e18);
    }

    function test_match_fill_too_small() public {
        uint256 oid = _depositAndOffer(lender, 1_000e18, 500);
        uint256 rid = _request(borrower, M, 10e18, 800, 1 days, 1 ether);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.FillTooSmall.selector, 0.5e18, 1e18));
        market.matchOfferAndRequest(oid, rid, 0.5e18);
        vm.prank(lender);
        market.matchOfferAndRequest(oid, rid, 9.5e18);
        // A sub-minLoan match is refused on the offer side too, unless it empties the offer (audit 2026-11-12).
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.FillTooSmall.selector, 0.5e18, 1e18));
        market.matchOfferAndRequest(oid, rid, 0.5e18);
        // A direct fund can still complete the request's small remainder.
        _deposit(lender2, M, 0.5e18);
        vm.prank(lender2);
        market.fundRequest(rid, 0.5e18, 800);
        assertEq(uint8(market.getRequest(rid).status), uint8(LXTypes.RequestStatus.Filled));
    }

    function test_match_collateral_cap_after_param_change() public {
        uint256 oid = _depositAndOffer(lender, 1_000e18, 500);
        uint256 rid = _request(borrower, M, 1_000e18, 800, 1 days, 5 ether);
        LXTypes.RiskParams memory p = defaultParams();
        p.maxCollateralPerLoan = 1 ether;
        vm.prank(admin);
        config.setRiskParams(p);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.CollateralCapExceeded.selector, 5 ether, 1 ether));
        market.matchOfferAndRequest(oid, rid, 1_000e18);
    }

    function test_match_asset_disabled() public {
        (uint256 oid, uint256 rid) = _setupPair();
        vm.prank(admin);
        config.configureAsset(M, false, 1e18, 1_000_000e18);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.AssetNotEnabled.selector, M));
        market.matchOfferAndRequest(oid, rid, 1_000e18);
        // Cancels still work.
        vm.prank(lender);
        market.cancelOffer(oid);
        vm.prank(borrower);
        market.cancelRequest(rid);
    }

    // ================================================================== oracle gating (safety rule 8)

    function test_stale_oracle_blocks_request_and_match() public {
        (uint256 oid, uint256 rid) = _setupPair();
        uint256 t = block.timestamp;
        vm.warp(t + 3601);
        uint256 c = _coll(1_000e18, 20_000);
        vm.prank(borrower2);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracleAdapter.StalePrice.selector, t, 3600));
        market.createRequest{value: c}(M, 1_000e18, 800, 1 days, c, uint64(block.timestamp + 1 days));
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracleAdapter.StalePrice.selector, t, 3600));
        market.matchOfferAndRequest(oid, rid, 1_000e18);
        _deposit(lender2, M, 1_000e18);
        vm.prank(lender2);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracleAdapter.StalePrice.selector, t, 3600));
        market.fundRequest(rid, 1_000e18, 1);
        vm.prank(borrower2);
        vm.expectRevert(abi.encodeWithSelector(IPriceOracleAdapter.StalePrice.selector, t, 3600));
        market.borrowFromOffer{value: c}(oid, 1_000e18, 1 days, c);
        // Offers don't need a price; cancels still work.
        _offer(lender2, M, 1_000e18, 500);
        vm.prank(borrower);
        market.cancelRequest(rid);
    }

    function test_invalid_oracle_blocks_request_and_match() public {
        (uint256 oid, uint256 rid) = _setupPair();
        feed.setAnswer(0);
        uint256 c = _coll(1_000e18, 20_000);
        vm.prank(borrower2);
        vm.expectRevert(IPriceOracleAdapter.InvalidPrice.selector);
        market.createRequest{value: c}(M, 1_000e18, 800, 1 days, c, uint64(block.timestamp + 1 days));
        vm.prank(lender);
        vm.expectRevert(IPriceOracleAdapter.InvalidPrice.selector);
        market.matchOfferAndRequest(oid, rid, 1_000e18);
        feed.setReverts(true);
        vm.prank(lender);
        vm.expectRevert(IPriceOracleAdapter.InvalidPrice.selector);
        market.matchOfferAndRequest(oid, rid, 1_000e18);
    }

    // ================================================================== fundRequest

    function test_fundRequest_lender_sets_apr_up_to_ceiling() public {
        uint256 c = _coll(1_000e18, 20_000);
        uint256 rid = _request(borrower, M, 1_000e18, 800, 1 days, c);
        _deposit(lender, M, 1_000e18);
        vm.prank(lender);
        vm.expectRevert(ILoanMarketplace.InvalidApr.selector);
        market.fundRequest(rid, 500e18, 801); // above the borrower's ceiling
        vm.prank(lender);
        vm.expectRevert(ILoanMarketplace.InvalidApr.selector);
        market.fundRequest(rid, 500e18, 0); // below config minimum
        vm.prank(lender);
        uint256 lid = market.fundRequest(rid, 500e18, 450);
        assertEq(_loan(lid).aprBps, 450);
    }

    function test_cr_exact_minimum_passes() public {
        // Single-floor _cr: collateral from minCollateral always passes createRequest (audit 2026-11-12).
        _setPrice(int256(100000500000000000000000));
        uint256 amount = 1000005000000066667;
        uint256 c = market.minCollateral(M, amount, 15_000);
        assertGe(market.quoteCollateralRatio(M, amount, c), 15_000);
        _request(borrower, M, amount, 800, 1 days, c);
    }

    function test_partial_fill_of_minimum_request() public {
        // Ceil share: a request at exactly the minimum ratio can be filled in parts.
        _setPrice(int256(100000500000000000000000));
        uint256 amount = 2_000_010_000_000_400_002;
        uint256 c = market.minCollateral(M, amount, 15_000);
        uint256 rid = _request(borrower, M, amount, 800, 1 days, c);
        _deposit(lender, M, amount);
        vm.prank(lender);
        market.fundRequest(rid, amount / 2, 800);
        vm.prank(lender);
        market.fundRequest(rid, amount - amount / 2, 800);
        assertEq(uint8(market.getRequest(rid).status), uint8(LXTypes.RequestStatus.Filled));
    }

    function test_fundRequest() public {
        uint256 c = _coll(1_000e18, 20_000);
        uint256 rid = _request(borrower, M, 1_000e18, 800, 1 days, c);
        _deposit(lender, M, 600e18);
        vm.expectEmit(true, true, true, true, address(market));
        emit ILoanMarketplace.Matched(1, 0, rid, lender, borrower, 600e18, 800, c * 600 / 1000, lender);
        vm.prank(lender);
        uint256 lid = market.fundRequest(rid, 600e18, 800);
        LXTypes.Loan memory l = _loan(lid);
        assertEq(l.aprBps, 800); // request.maxAprBps
        assertEq(l.offerId, 0);
        assertEq(l.collateral, c * 600 / 1000);
        assertEq(vault.available(lender, M), 0);
        assertEq(vault.lent(lender, M), 600e18);

        vm.prank(lender2);
        vm.expectRevert(abi.encodeWithSelector(ILiquidityXVault.InsufficientAvailable.selector, 0, 400e18));
        market.fundRequest(rid, 400e18, 1);
        _deposit(lender2, M, 400e18);
        vm.prank(lender2);
        market.fundRequest(rid, 400e18, 1);
        assertEq(uint8(market.getRequest(rid).status), uint8(LXTypes.RequestStatus.Filled));
    }

    function test_fundRequest_failures() public {
        uint256 rid = _request(borrower, M, 1_000e18, 800, 1 days, _coll(1_000e18, 15_000));
        _deposit(borrower, M, 1_000e18);
        vm.prank(borrower);
        vm.expectRevert(ILoanMarketplace.SelfMatch.selector);
        market.fundRequest(rid, 1_000e18, 1);
        _deposit(lender, M, 1_000e18);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.FillTooSmall.selector, 1, 1e18));
        market.fundRequest(rid, 1, 1);
        vm.prank(lender);
        vm.expectRevert(ILoanMarketplace.InvalidAmount.selector);
        market.fundRequest(rid, 1_001e18, 1);
        // Price drops 1% -> share CR < 150%
        _setPrice(99_000e18);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.InsufficientCollateral.selector, 14_850, 15_000));
        market.fundRequest(rid, 1_000e18, 1);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.RequestNotOpen.selector, 99));
        market.fundRequest(99, 1e18, 1);
        vm.warp(block.timestamp + 7 days);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.RequestExpired.selector, rid));
        market.fundRequest(rid, 1_000e18, 1);
    }

    // ================================================================== borrowFromOffer

    function test_borrowFromOffer() public {
        uint256 oid = _depositAndOffer(lender, 1_000e18, 500);
        uint256 c = _coll(400e18, 15_000);
        uint256 bBefore = musd.balanceOf(borrower);
        vm.expectEmit(true, true, true, true, address(market));
        emit ILoanMarketplace.Matched(1, oid, 0, lender, borrower, 400e18, 500, c, borrower);
        vm.prank(borrower);
        uint256 lid = market.borrowFromOffer{value: c}(oid, 400e18, 2 days, c);
        LXTypes.Loan memory l = _loan(lid);
        assertEq(l.requestId, 0);
        assertEq(l.offerId, oid);
        assertEq(l.maturity, block.timestamp + 2 days);
        assertEq(l.collateral, c);
        assertEq(cm.loanCollateral(lid), c);
        assertEq(cm.freeCollateral(borrower), 0);
        assertEq(musd.balanceOf(borrower), bBefore + 400e18);
        assertEq(market.getOffer(oid).remaining, 600e18);
        assertEq(market.getOffer(oid).fills, 1);
        // borrow the rest from existing free collateral
        uint256 c2 = _coll(600e18, 20_000);
        vm.prank(borrower);
        cm.depositCollateral{value: c2}();
        vm.prank(borrower);
        market.borrowFromOffer(oid, 600e18, 1 days, c2);
        assertEq(uint8(market.getOffer(oid).status), uint8(LXTypes.OfferStatus.Filled));
    }

    function test_borrowFromOffer_failures() public {
        _deposit(lender, M, 1_000e18);
        uint256 oid = _offerFull(lender, M, 1_000e18, 500, 7 days, 20_000, uint64(block.timestamp + 3 days));
        uint256 c = _coll(1_000e18, 20_000);
        vm.startPrank(borrower);
        vm.expectRevert(ILoanMarketplace.InvalidAmount.selector);
        market.borrowFromOffer{value: c}(oid, 1_001e18, 1 days, c);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.FillTooSmall.selector, 1, 1e18));
        market.borrowFromOffer{value: c}(oid, 1, 1 days, c);
        vm.expectRevert(ILoanMarketplace.InvalidDuration.selector);
        market.borrowFromOffer{value: c}(oid, 1_000e18, 1 hours - 1, c);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.DurationTooLong.selector, 8 days, 7 days));
        market.borrowFromOffer{value: c}(oid, 1_000e18, 8 days, c);
        vm.expectRevert(ILoanMarketplace.InvalidAmount.selector);
        market.borrowFromOffer(oid, 1_000e18, 1 days, 0);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.CollateralCapExceeded.selector, 11 ether, 10 ether));
        market.borrowFromOffer{value: 11 ether}(oid, 1_000e18, 1 days, 11 ether);
        uint256 low = _coll(1_000e18, 15_000); // meets config min but not offer's 200%
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.InsufficientCollateral.selector, 15_000, 20_000));
        market.borrowFromOffer{value: low}(oid, 1_000e18, 1 days, low);
        vm.expectRevert(abi.encodeWithSelector(ICollateralManager.InsufficientFree.selector, c - 1, c));
        market.borrowFromOffer{value: c - 1}(oid, 1_000e18, 1 days, c);
        vm.stopPrank();
        vm.prank(lender);
        vm.expectRevert(ILoanMarketplace.SelfMatch.selector);
        market.borrowFromOffer{value: c}(oid, 1_000e18, 1 days, c);
        vm.warp(block.timestamp + 3 days);
        _setPrice(PRICE);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.OfferExpired.selector, oid));
        market.borrowFromOffer{value: c}(oid, 1_000e18, 1 days, c);
    }

    // ================================================================== views

    function test_views() public {
        uint256 c = 1 ether; // $100,000
        assertEq(market.quoteCollateralRatio(M, 50_000e18, c), 20_000);
        assertEq(market.quoteCollateralRatio(M, 0, c), type(uint256).max);
        assertEq(market.quoteCollateralRatio(address(usdc), 50_000e6, c), 20_000);
        assertEq(market.maxBorrow(M, c, 0), uint256(100_000e18) * 10_000 / 15_000);
        assertEq(market.maxBorrow(address(usdc), c, 20_000), 50_000e6);
        assertEq(market.minCollateral(M, 50_000e18, 20_000), 1 ether);
        assertEq(market.minCollateral(M, 1_000e18, 0), _coll(1_000e18, 15_000));
        assertEq(market.minCollateral(address(usdc), 50_000e6, 20_000), 1 ether);
        // rounding up
        assertEq(market.minCollateral(M, 1, 15_000), 1);
        MockERC20 other = new MockERC20("X", "X", 18);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.AssetNotEnabled.selector, address(other)));
        market.quoteCollateralRatio(address(other), 1, 1);
    }

    function test_pagination() public {
        _deposit(lender, M, 100e18);
        for (uint256 i; i < 5; ++i) _offer(lender, M, 10e18, 500);
        assertEq(market.getOffers(0, 10).length, 5);
        assertEq(market.getOffers(1, 2).length, 2);
        assertEq(market.getOffers(1, 2)[1].id, 2);
        assertEq(market.getOffers(4, 10).length, 2);
        assertEq(market.getOffers(6, 10).length, 0);
        assertEq(market.getOffers(5, type(uint256).max).length, 1);
        assertEq(market.getRequests(1, 10).length, 0);
        _request(borrower, M, 10e18, 800, 1 days, 1 ether);
        assertEq(market.getRequests(1, 10)[0].id, 1);
    }

    function test_constructor_zero() public {
        vm.expectRevert(LoanMarketplace.ZeroAddress.selector);
        new LoanMarketplace(config, oracle, vault, cm, loans, address(0));
    }
}
