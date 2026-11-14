// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {LXTypes} from "../src/interfaces/ILiquidityXTypes.sol";

contract FuzzTest is BaseTest {
    address internal M;

    function setUp() public override {
        super.setUp();
        M = address(musd);
    }

    // ================================================================== interest

    /// accrue == ceil(p*apr*dt / (YEAR*BPS)), and is the smallest integer >= the exact value.
    function testFuzz_accrueInterest_reference(uint256 p, uint256 apr, uint256 dt) public view {
        p = bound(p, 0, 1e30);
        apr = bound(apr, 0, 50_000);
        dt = bound(dt, 0, 10 * YEAR);
        uint256 got = loans.accrueInterest(p, apr, dt);
        assertEq(got, _refInterest(p, apr, dt));
        uint256 exactNum = p * apr * dt;
        assertGe(got * YEAR * BPS, exactNum);
        if (got > 0) assertLt((got - 1) * YEAR * BPS, exactNum);
    }

    /// Interest on a real loan (owed and repay) matches the reference after an arbitrary wait,
    /// including after maturity.
    function testFuzz_loan_interest_and_full_repay(uint256 amount, uint16 apr, uint256 wait) public {
        amount = bound(amount, 1e18, 100_000e18);
        apr = uint16(bound(apr, 1, 10_000));
        wait = bound(wait, 0, 3 * YEAR);
        _deposit(lender, M, amount);
        uint256 oid = _offerFull(lender, M, amount, apr, 365 days, 0, uint64(block.timestamp + 1 days));
        uint256 rid = _request(borrower, M, amount, apr, 30 days, _coll(amount, 20_000));
        vm.prank(lender);
        uint256 lid = market.matchOfferAndRequest(oid, rid, amount);
        vm.warp(block.timestamp + wait);
        uint256 expI = _refInterest(amount, apr, wait);
        (uint256 pr, uint256 i, uint256 t) = loans.owed(lid);
        assertEq(pr, amount);
        assertEq(i, expI);
        vm.prank(borrower);
        uint256 paid = loans.repay(lid, type(uint256).max);
        assertEq(paid, t);
        assertEq(vault.available(lender, M), amount + expI);
        assertEq(uint8(loans.getLoan(lid).status), uint8(LXTypes.LoanStatus.Repaid));
    }

    /// Two partial repayments: interest first, then principal; accounting adds up.
    function testFuzz_partial_repay_split(uint256 amount, uint256 wait, uint256 first) public {
        amount = bound(amount, 1e18, 100_000e18);
        wait = bound(wait, 1, YEAR);
        _deposit(lender, M, amount);
        uint256 oid = _offer(lender, M, amount, 1_000);
        uint256 rid = _request(borrower, M, amount, 1_000, 30 days, _coll(amount, 20_000));
        vm.prank(lender);
        uint256 lid = market.matchOfferAndRequest(oid, rid, amount);
        vm.warp(block.timestamp + wait);
        (,, uint256 total) = loans.owed(lid);
        uint256 interest = total - amount;
        first = bound(first, 1, total);
        vm.prank(borrower);
        loans.repay(lid, first);
        LXTypes.Loan memory l = loans.getLoan(lid);
        uint256 iPaid = first < interest ? first : interest;
        assertEq(l.interestPaid, iPaid);
        assertEq(l.principalRepaid, first - iPaid);
        assertEq(l.outstandingPrincipal, amount - (first - iPaid));
        if (first < total) {
            vm.prank(borrower);
            uint256 rest = loans.repay(lid, type(uint256).max);
            assertEq(rest, total - first); // same timestamp: nothing new accrues
        }
        l = loans.getLoan(lid);
        assertEq(uint8(l.status), uint8(LXTypes.LoanStatus.Repaid));
        assertEq(l.interestPaid + l.principalRepaid, total);
        assertEq(vault.lent(lender, M), 0);
    }

    // ================================================================== CR math

    function testFuzz_quoteCR_reference(uint256 amount, uint256 coll, uint256 price) public {
        amount = bound(amount, 1, 1e30);
        coll = bound(coll, 0, 1e24);
        price = bound(price, 1, 1e30);
        feed.setAnswer(int256(price));
        uint256 cr = market.quoteCollateralRatio(M, amount, coll);
        assertEq(cr, coll * price * BPS / (WAD * amount)); // one floor (audit 2026-11-12)
    }

    /// minCollateral is the exact rounding-up boundary: it satisfies crBps and one wei less does not
    /// (whenever one wei is worth enough to matter at this price).
    function testFuzz_minCollateral_boundary(uint256 amount, uint16 crBps, uint256 price) public {
        amount = bound(amount, 1e18, 1e27);
        crBps = uint16(bound(crBps, 10_500, 50_000));
        price = bound(price, 1e18, 1e25);
        feed.setAnswer(int256(price));
        uint256 c = market.minCollateral(M, amount, crBps);
        assertEq(c, _ceilDiv(amount * crBps * WAD, BPS * price));
        // c * price >= amount * cr * WAD / BPS  (exact, before the floor in collateralUsd)
        assertGe(c * price * BPS, amount * crBps * WAD);
        assertLt((c - 1) * price * BPS, amount * crBps * WAD);
    }

    function testFuzz_maxBorrow_respects_cr(uint256 coll, uint16 crBps, uint256 price) public {
        coll = bound(coll, 1e12, 1e22);
        crBps = uint16(bound(crBps, 10_500, 50_000));
        price = bound(price, 1e18, 1e25);
        feed.setAnswer(int256(price));
        uint256 mb = market.maxBorrow(M, coll, crBps);
        if (mb > 0) assertGe(market.quoteCollateralRatio(M, mb, coll), crBps);
        uint256 mb6 = market.maxBorrow(address(usdc), coll, crBps);
        if (mb6 > 0) assertGe(market.quoteCollateralRatio(address(usdc), mb6, coll), crBps);
        assertEq(mb6, mb / 1e12);
    }

    /// Pro-rata partial fills never hand out more than the request's collateral, and the last fill
    /// takes exactly the remainder.
    function testFuzz_partial_fill_shares(uint256 amount, uint256 f1, uint256 coll) public {
        amount = bound(amount, 3e18, 100_000e18);
        coll = bound(coll, _coll(amount, 15_000) * 2, 10 ether);
        vm.assume(coll <= 10 ether);
        f1 = bound(f1, 1e18, amount - 1e18);
        uint256 rid = _request(borrower, M, amount, 800, 1 days, coll);
        _deposit(lender, M, amount);
        vm.prank(lender);
        try market.fundRequest(rid, f1, 1) returns (uint256 l1) {
            uint256 ceilShare = (coll * f1 + amount - 1) / amount; // partial shares round up (audit 2026-11-12)
            assertEq(loans.getLoan(l1).collateral, ceilShare > coll ? coll : ceilShare);
            vm.prank(lender);
            uint256 l2 = market.fundRequest(rid, amount - f1, 1);
            assertEq(loans.getLoan(l1).collateral + loans.getLoan(l2).collateral, coll);
            assertEq(market.getRequest(rid).collateralRemaining, 0);
        } catch {
            // Only acceptable failure: the floored share fell below 150% (rounding at tiny sizes).
        }
    }

    // ================================================================== liquidation split

    function testFuzz_liquidation_split(uint256 amount, uint256 newPrice) public {
        amount = bound(amount, 1e18, 100_000e18);
        uint256 coll = _coll(amount, 20_000);
        vm.assume(coll <= 10 ether);
        newPrice = bound(newPrice, 1e15, 59_999e18);
        _deposit(lender, M, amount);
        uint256 oid = _offer(lender, M, amount, 500);
        uint256 rid = _request(borrower, M, amount, 800, 1 days, coll);
        vm.prank(lender);
        uint256 lid = market.matchOfferAndRequest(oid, rid, amount);
        feed.setAnswer(int256(newPrice));
        (uint256 debt, uint256 lc, uint256 bc) = engine.previewLiquidation(lid);
        assertEq(lc + bc, coll);
        uint256 debtBtc = _ceilDiv(debt * WAD, newPrice);
        uint256 wb = debtBtc * 10_500 / BPS;
        assertEq(lc, wb < coll ? wb : coll);
        (uint256 cr,,) = engine.health(lid);
        if (cr < 12_000) {
            vm.prank(lender);
            engine.liquidate(lid);
            assertEq(cm.freeCollateral(lender), lc);
            assertEq(cm.freeCollateral(borrower), bc);
        }
    }
}
