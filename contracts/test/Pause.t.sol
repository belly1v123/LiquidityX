// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {LoanMarketplace} from "../src/LoanMarketplace.sol";
import {LiquidityXVault} from "../src/LiquidityXVault.sol";
import {CollateralManager} from "../src/CollateralManager.sol";

/// Safety rule 11: withdraw, cancel, repay and liquidate work while paused; deposits, listings and matches don't.
contract PauseTest is BaseTest {
    address internal M;
    uint256 internal oid;
    uint256 internal rid;
    uint256 internal lid;

    function setUp() public override {
        super.setUp();
        M = address(musd);
        // An active loan, an open offer, an open request, free collateral and an available balance.
        _deposit(lender, M, 3_000e18);
        uint256 o1 = _offer(lender, M, 1_000e18, 500);
        uint256 r1 = _request(borrower, M, 1_000e18, 800, 30 days, _coll(1_000e18, 20_000));
        vm.prank(lender);
        lid = market.matchOfferAndRequest(o1, r1, 1_000e18);
        oid = _offer(lender, M, 1_000e18, 500);
        rid = _request(borrower2, M, 1_000e18, 800, 1 days, _coll(1_000e18, 20_000));
        vm.prank(borrower);
        cm.depositCollateral{value: 1 ether}();
        vm.prank(admin);
        config.pause();
    }

    function test_blocked_while_paused() public {
        uint256 c = 1 ether;
        uint64 exp = uint64(block.timestamp + 1 days);
        vm.startPrank(lender);
        vm.expectRevert(LiquidityXVault.EnforcedPause.selector);
        vault.deposit(M, 1e18);
        vm.expectRevert(LoanMarketplace.EnforcedPause.selector);
        market.createOffer(M, 10e18, 500, 1 days, 0, exp);
        vm.expectRevert(LoanMarketplace.EnforcedPause.selector);
        market.matchOfferAndRequest(oid, rid, 1_000e18);
        vm.expectRevert(LoanMarketplace.EnforcedPause.selector);
        market.fundRequest(rid, 1_000e18, 1);
        vm.stopPrank();
        vm.startPrank(borrower);
        vm.expectRevert(CollateralManager.EnforcedPause.selector);
        cm.depositCollateral{value: c}();
        vm.expectRevert(LoanMarketplace.EnforcedPause.selector);
        market.createRequest{value: c}(M, 10e18, 800, 1 days, c, exp);
        vm.expectRevert(LoanMarketplace.EnforcedPause.selector);
        market.borrowFromOffer{value: c}(oid, 10e18, 1 days, c);
        vm.stopPrank();
    }

    function test_allowed_while_paused() public {
        vm.startPrank(lender);
        vault.withdraw(M, 1_000e18); // the unreserved 1,000
        market.cancelOffer(oid);
        vault.withdraw(M, 1_000e18);
        vm.stopPrank();
        vm.prank(borrower2);
        market.cancelRequest(rid);
        vm.prank(borrower2);
        cm.withdrawCollateral(_coll(1_000e18, 20_000));
        vm.prank(borrower);
        cm.withdrawCollateral(1 ether);
        vm.prank(borrower);
        loans.repay(lid, type(uint256).max);
        vm.prank(borrower);
        cm.withdrawCollateral(_coll(1_000e18, 20_000));
        // unpause restores
        vm.prank(admin);
        config.unpause();
        _deposit(lender, M, 1e18);
    }
}
