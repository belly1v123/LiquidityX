// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {LoanManager} from "../src/LoanManager.sol";
import {ILoanManager, ILiquidityXVault, ILoanMarketplace} from "../src/interfaces/ILiquidityX.sol";
import {LXTypes} from "../src/interfaces/ILiquidityXTypes.sol";
import {MockFeeOnTransferToken} from "./mocks/MockFeeOnTransferToken.sol";
import {ReentrantToken} from "./mocks/Attackers.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract LoanManagerTest is BaseTest {
    address internal M;

    function setUp() public override {
        super.setUp();
        M = address(musd);
    }

    /// Opens a loan of `amount` MUSD at `apr` for `dur` via matchOfferAndRequest. Returns loan id.
    function _open(uint256 amount, uint16 apr, uint32 dur) internal returns (uint256 lid) {
        uint256 oid = _depositAndOffer(lender, amount, apr);
        uint256 rid = _request(borrower, M, amount, apr, dur, _coll(amount, 20_000));
        vm.prank(lender);
        lid = market.matchOfferAndRequest(oid, rid, amount);
    }

    function _approveVault(address who) internal {
        vm.prank(who);
        musd.approve(address(vault), type(uint256).max);
    }

    // ================================================================== interest

    function test_interest_matches_reference() public {
        uint256 lid = _open(1_000e18, 500, 30 days);
        vm.warp(block.timestamp + 10 days);
        (uint256 p, uint256 i, uint256 t) = loans.owed(lid);
        assertEq(p, 1_000e18);
        assertEq(i, _refInterest(1_000e18, 500, 10 days));
        assertEq(t, p + i);
        // 1000 * 5% * 10/365 = 1.369863013698630137 -> rounded up
        assertEq(i, 1_369_863_013_698_630_137);
    }

    function test_interest_rounds_up() public {
        uint256 lid = _open(1e18, 1, 1 days);
        vm.warp(block.timestamp + 1);
        (, uint256 i,) = loans.owed(lid);
        // 1e18 * 1 * 1 / (31536000 * 10000) = 3170979.19... -> 3170980
        assertEq(i, 3_170_980);
        assertEq(loans.accrueInterest(1e18, 1, 1), 3_170_980);
        assertEq(loans.accrueInterest(0, 500, 100), 0);
        assertEq(loans.accrueInterest(100, 500, 0), 0);
        assertEq(loans.accrueInterest(1, 1, 1), 1); // ceil of a tiny positive value
    }

    function test_owedAt() public {
        uint256 lid = _open(1_000e18, 1_000, 30 days);
        uint256 start = block.timestamp;
        (, uint256 i,) = loans.owedAt(lid, start + YEAR);
        assertEq(i, 100e18);
        (, i,) = loans.owedAt(lid, start - 1); // before lastAccrual: no extra
        assertEq(i, 0);
        (, i,) = loans.owedAt(lid, start);
        assertEq(i, 0);
    }

    function test_interest_continues_after_maturity() public {
        uint256 lid = _open(1_000e18, 1_000, 1 days);
        vm.warp(block.timestamp + 10 days); // 9 days past maturity
        (, uint256 i,) = loans.owed(lid);
        assertEq(i, _refInterest(1_000e18, 1_000, 10 days));
    }

    // ================================================================== repay

    function test_partial_repayments_interest_first() public {
        uint256 lid = _open(1_000e18, 1_000, 30 days);
        _approveVault(borrower);
        uint256 t0 = block.timestamp;

        vm.warp(t0 + 10 days);
        uint256 i1 = _refInterest(1_000e18, 1_000, 10 days);
        // pay less than interest
        vm.prank(borrower);
        uint256 paid = loans.repay(lid, i1 / 2);
        assertEq(paid, i1 / 2);
        LXTypes.Loan memory l = _loan(lid);
        assertEq(l.outstandingPrincipal, 1_000e18);
        assertEq(l.accruedInterest, i1 - i1 / 2);
        assertEq(l.interestPaid, i1 / 2);
        assertEq(l.lastAccrual, t0 + 10 days);

        // pay remaining interest + 400 principal
        vm.expectEmit(true, true, false, true, address(loans));
        emit ILoanManager.LoanRepayment(lid, borrower, i1 - i1 / 2, 400e18, 600e18);
        vm.prank(borrower);
        loans.repay(lid, (i1 - i1 / 2) + 400e18);
        l = _loan(lid);
        assertEq(l.outstandingPrincipal, 600e18);
        assertEq(l.accruedInterest, 0);
        assertEq(l.principalRepaid, 400e18);

        // further accrual is on the reduced principal
        vm.warp(t0 + 20 days);
        uint256 i2 = _refInterest(600e18, 1_000, 10 days);
        (, uint256 owedI,) = loans.owed(lid);
        assertEq(owedI, i2);

        assertEq(vault.lent(lender, M), 600e18);
        assertEq(vault.available(lender, M), 400e18 + i1);
        assertEq(vault.interestEarned(lender, M), i1);
        assertEq(vault.totalInterestPaid(M), i1);
    }

    function test_full_repay_releases_collateral_and_withdraw() public {
        uint256 lid = _open(1_000e18, 500, 30 days);
        uint256 coll = _loan(lid).collateral;
        _approveVault(borrower);
        vm.warp(block.timestamp + 15 days);
        (,, uint256 total) = loans.owed(lid);
        uint256 interest = total - 1_000e18;
        uint256 bBal = musd.balanceOf(borrower);

        vm.expectEmit(true, false, false, true, address(loans));
        emit ILoanManager.LoanRepaid(lid, interest);
        vm.prank(borrower);
        uint256 paid = loans.repay(lid, type(uint256).max);
        assertEq(paid, total);
        assertEq(musd.balanceOf(borrower), bBal - total);

        LXTypes.Loan memory l = _loan(lid);
        assertEq(uint8(l.status), uint8(LXTypes.LoanStatus.Repaid));
        assertEq(l.closedAt, block.timestamp);
        assertEq(l.outstandingPrincipal, 0);
        assertEq(l.interestPaid, interest);
        assertEq(cm.loanCollateral(lid), 0);
        assertEq(cm.freeCollateral(borrower), coll);

        uint256 eth = borrower.balance;
        vm.prank(borrower);
        cm.withdrawCollateral(coll);
        assertEq(borrower.balance, eth + coll);

        assertEq(vault.available(lender, M), total);
        assertEq(vault.lent(lender, M), 0);
        uint256 lBal = musd.balanceOf(lender);
        vm.prank(lender);
        vault.withdraw(M, total);
        assertEq(musd.balanceOf(lender), lBal + total);
        assertEq(musd.balanceOf(address(vault)), 0);
    }

    function test_repay_capped_at_owed() public {
        uint256 lid = _open(1_000e18, 500, 30 days);
        _approveVault(borrower);
        vm.warp(block.timestamp + 1 days);
        (,, uint256 total) = loans.owed(lid);
        vm.prank(borrower);
        uint256 paid = loans.repay(lid, total + 5_000e18);
        assertEq(paid, total);
    }

    function test_double_repay_reverts() public {
        uint256 lid = _open(1_000e18, 500, 30 days);
        _approveVault(borrower);
        vm.prank(borrower);
        loans.repay(lid, type(uint256).max);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(ILoanManager.LoanNotActive.selector, lid));
        loans.repay(lid, 1);
        vm.expectRevert(abi.encodeWithSelector(ILoanManager.LoanNotActive.selector, 999));
        loans.repay(999, 1);
    }

    function test_repay_zero_reverts() public {
        uint256 lid = _open(1_000e18, 500, 30 days);
        vm.prank(borrower);
        vm.expectRevert(ILoanManager.ZeroAmount.selector);
        loans.repay(lid, 0);
    }

    function test_repay_same_block_no_interest() public {
        uint256 lid = _open(1_000e18, 500, 30 days);
        _approveVault(borrower);
        vm.prank(borrower);
        uint256 paid = loans.repay(lid, type(uint256).max);
        assertEq(paid, 1_000e18);
    }

    function test_third_party_can_repay() public {
        uint256 lid = _open(1_000e18, 500, 30 days);
        _approveVault(lender2);
        vm.warp(block.timestamp + 1 days);
        vm.prank(lender2);
        loans.repay(lid, type(uint256).max);
        // Collateral goes to the BORROWER, not the payer.
        assertEq(cm.freeCollateral(borrower), _loan(lid).collateral);
        assertEq(cm.freeCollateral(lender2), 0);
    }

    function test_repay_after_maturity() public {
        uint256 lid = _open(1_000e18, 1_000, 1 days);
        _approveVault(borrower);
        vm.warp(block.timestamp + 5 days);
        vm.prank(borrower);
        uint256 paid = loans.repay(lid, type(uint256).max);
        assertEq(paid, 1_000e18 + _refInterest(1_000e18, 1_000, 5 days));
    }

    function test_repay_needs_vault_approval() public {
        uint256 lid = _open(1_000e18, 500, 30 days);
        vm.prank(borrower);
        musd.approve(address(vault), 0);
        vm.prank(borrower);
        vm.expectRevert();
        loans.repay(lid, 1e18);
    }

    function test_fee_on_transfer_rejected_on_repayment() public {
        MockFeeOnTransferToken fot = new MockFeeOnTransferToken();
        fot.setFeeBps(0);
        vm.prank(admin);
        config.configureAsset(address(fot), true, 1e18, 1_000_000e18);
        fot.mint(lender, 1_000e18);
        fot.mint(borrower, 1_000e18);
        vm.prank(lender);
        fot.approve(address(vault), type(uint256).max);
        vm.prank(borrower);
        fot.approve(address(vault), type(uint256).max);
        _deposit(lender, address(fot), 1_000e18);
        uint256 oid = _offer(lender, address(fot), 1_000e18, 500);
        uint256 rid = _request(borrower, address(fot), 1_000e18, 800, 1 days, _coll(1_000e18, 20_000));
        vm.prank(lender);
        uint256 lid = market.matchOfferAndRequest(oid, rid, 1_000e18);
        fot.setFeeBps(100);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(ILiquidityXVault.TransferAmountMismatch.selector, 100e18, 99e18));
        loans.repay(lid, 100e18);
    }

    function test_reentrancy_on_repay_blocked() public {
        ReentrantToken rt = new ReentrantToken();
        vm.prank(admin);
        config.configureAsset(address(rt), true, 1e18, 1_000_000e18);
        rt.mint(lender, 1_000e18);
        rt.mint(borrower, 1_000e18);
        vm.prank(lender);
        rt.approve(address(vault), type(uint256).max);
        vm.prank(borrower);
        rt.approve(address(vault), type(uint256).max);
        _deposit(lender, address(rt), 1_000e18);
        uint256 oid = _offer(lender, address(rt), 1_000e18, 500);
        uint256 rid = _request(borrower, address(rt), 1_000e18, 800, 1 days, _coll(1_000e18, 20_000));
        vm.prank(lender);
        uint256 lid = market.matchOfferAndRequest(oid, rid, 1_000e18);

        // 1) re-enter LoanManager.repay from inside the token pull
        rt.arm(address(loans), abi.encodeCall(ILoanManager.repay, (lid, type(uint256).max)));
        vm.prank(borrower);
        loans.repay(lid, 10e18);
        assertFalse(rt.reentrySucceeded());
        assertEq(bytes4(rt.reentryError()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(_loan(lid).outstandingPrincipal, 990e18);

        // 2) re-enter Vault.withdraw from inside collectRepayment's pull
        rt.arm(address(vault), abi.encodeCall(ILiquidityXVault.withdraw, (address(rt), 1)));
        vm.prank(borrower);
        loans.repay(lid, type(uint256).max);
        assertFalse(rt.reentrySucceeded());
        assertEq(bytes4(rt.reentryError()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(uint8(_loan(lid).status), uint8(LXTypes.LoanStatus.Repaid));
        assertEq(rt.balanceOf(address(vault)), vault.totalAvailable(address(rt)) + vault.totalReserved(address(rt)));
    }

    // ================================================================== 6-decimal asset

    function test_6_decimal_asset_math() public {
        address U = address(usdc);
        _deposit(lender, U, 1_000e6);
        uint256 oid = _offer(lender, U, 1_000e6, 1_000);
        uint256 c = market.minCollateral(U, 1_000e6, 15_000);
        assertEq(c, _coll(1_000e18, 15_000));
        uint256 rid = _request(borrower, U, 1_000e6, 1_000, 30 days, c);
        assertEq(market.quoteCollateralRatio(U, 1_000e6, c), 15_000);
        vm.prank(lender);
        uint256 lid = market.matchOfferAndRequest(oid, rid, 1_000e6);
        vm.warp(block.timestamp + 7 days);
        (, uint256 i,) = loans.owed(lid);
        assertEq(i, _refInterest(1_000e6, 1_000, 7 days));
        assertEq(i, 1_917_809); // 1000 USDC * 10% * 7/365 = 1.917808.. -> 1.917809
        vm.prank(borrower);
        uint256 paid = loans.repay(lid, type(uint256).max);
        assertEq(paid, 1_000e6 + i);
        assertEq(vault.available(lender, U), 1_000e6 + i);
        // FillTooSmall uses asset-decimal minLoan
        _setPrice(PRICE);
        uint256 rid2 = _request(borrower, U, 10e6, 1_000, 1 days, 1 ether);
        _deposit(lender2, U, 10e6);
        vm.prank(lender2);
        vm.expectRevert(abi.encodeWithSelector(ILoanMarketplace.FillTooSmall.selector, 1e6 - 1, 1e6));
        market.fundRequest(rid2, 1e6 - 1, 1);
    }

    // ================================================================== access + views

    function test_access_control() public {
        bytes32 mr = loans.MARKET_ROLE();
        bytes32 lr = loans.LIQUIDATOR_ROLE();
        assertEq(mr, keccak256("MARKET_ROLE"));
        assertEq(lr, keccak256("LIQUIDATOR_ROLE"));
        ILoanManager.OpenLoanParams memory p;
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, mr));
        loans.openLoan(p);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, lr));
        loans.settleLiquidation(1, 0);
        vm.stopPrank();
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, lender, lr));
        loans.settleLiquidation(1, 0);
    }

    function test_openLoan_invalid_params() public {
        ILoanManager.OpenLoanParams memory p;
        vm.prank(address(market));
        vm.expectRevert(ILoanManager.InvalidLoanParams.selector);
        loans.openLoan(p);
    }

    function test_settleLiquidation_excessive() public {
        uint256 lid = _open(1_000e18, 500, 30 days);
        uint256 c = _loan(lid).collateral;
        vm.prank(address(engine));
        vm.expectRevert(abi.encodeWithSelector(ILoanManager.ExcessiveSeize.selector, c + 1, c));
        loans.settleLiquidation(lid, c + 1);
    }

    function test_getLoans() public {
        _open(10e18, 500, 1 days);
        _open(10e18, 500, 1 days);
        _open(10e18, 500, 1 days);
        assertEq(loans.loanCount(), 3);
        assertEq(loans.getLoans(0, 100).length, 3);
        assertEq(loans.getLoans(2, 1)[0].id, 2);
        assertEq(loans.getLoans(3, type(uint256).max).length, 1);
        assertEq(loans.getLoans(4, 1).length, 0);
    }

    function test_constructor_zero() public {
        vm.expectRevert(LoanManager.ZeroAddress.selector);
        new LoanManager(config, vault, cm, address(0));
    }
}
