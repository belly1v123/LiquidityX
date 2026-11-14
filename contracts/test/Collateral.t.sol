// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {CollateralManager} from "../src/CollateralManager.sol";
import {ICollateralManager} from "../src/interfaces/ILiquidityX.sol";
import {ReentrantCollateralReceiver, RejectingReceiver} from "./mocks/Attackers.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract CollateralTest is BaseTest {
    function test_deposit_withdraw() public {
        vm.prank(borrower);
        cm.depositCollateral{value: 2 ether}();
        assertEq(cm.freeCollateral(borrower), 2 ether);
        assertEq(cm.totalFree(), 2 ether);
        assertEq(address(cm).balance, 2 ether);

        uint256 before = borrower.balance;
        vm.expectEmit(true, false, false, true, address(cm));
        emit ICollateralManager.CollateralWithdrawn(borrower, 1 ether);
        vm.prank(borrower);
        cm.withdrawCollateral(1 ether);
        assertEq(borrower.balance, before + 1 ether);
        assertEq(cm.freeCollateral(borrower), 1 ether);
        assertEq(address(cm).balance, 1 ether);
    }

    function test_zero_amounts() public {
        vm.startPrank(borrower);
        vm.expectRevert(ICollateralManager.ZeroAmount.selector);
        cm.depositCollateral{value: 0}();
        vm.expectRevert(ICollateralManager.ZeroAmount.selector);
        cm.withdrawCollateral(0);
        vm.stopPrank();
    }

    function test_withdraw_more_than_free() public {
        vm.prank(borrower);
        cm.depositCollateral{value: 1 ether}();
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(ICollateralManager.InsufficientFree.selector, 1 ether, 1 ether + 1));
        cm.withdrawCollateral(1 ether + 1);
    }

    function test_direct_transfer_reverts() public {
        vm.prank(borrower);
        (bool ok, bytes memory err) = address(cm).call{value: 1 ether}("");
        assertFalse(ok);
        assertEq(bytes4(err), ICollateralManager.DirectTransferNotAllowed.selector);
        vm.prank(borrower);
        (ok, err) = address(cm).call{value: 1 ether}(hex"deadbeef");
        assertFalse(ok);
        assertEq(bytes4(err), ICollateralManager.DirectTransferNotAllowed.selector);
    }

    /// Safety rule 2: locked collateral is not withdrawable.
    function test_locked_collateral_not_withdrawable() public {
        uint256 c = _coll(1_000e18, 20_000);
        _request(borrower, address(musd), 1_000e18, 800, 1 days, c);
        assertEq(cm.freeCollateral(borrower), 0);
        assertEq(cm.requestCollateral(1), c);
        vm.prank(borrower);
        vm.expectRevert(abi.encodeWithSelector(ICollateralManager.InsufficientFree.selector, 0, 1));
        cm.withdrawCollateral(1);
    }

    function test_reentrancy_on_withdrawCollateral_blocked() public {
        ReentrantCollateralReceiver attacker = new ReentrantCollateralReceiver(cm, false);
        attacker.deposit{value: 2 ether}();
        // Some other user's funds in the manager that the attacker would like to drain.
        vm.prank(borrower);
        cm.depositCollateral{value: 5 ether}();

        vm.expectRevert(ICollateralManager.NativeTransferFailed.selector);
        attacker.withdraw(1 ether);
        assertEq(cm.freeCollateral(address(attacker)), 2 ether);
        assertEq(address(cm).balance, 7 ether);
        assertFalse(attacker.reentered());
    }

    function test_reentry_error_is_reentrancy_guard() public {
        // The attacker swallows the inner failure so we can inspect it.
        ReentrantCollateralReceiver attacker = new ReentrantCollateralReceiver(cm, true);
        attacker.deposit{value: 2 ether}();
        attacker.withdraw(1 ether);
        assertEq(bytes4(attacker.lastError()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertFalse(attacker.reentered());
        assertEq(address(attacker).balance, 1 ether);
        assertEq(cm.freeCollateral(address(attacker)), 1 ether);
        assertEq(address(cm).balance, cm.totalFree());
    }

    function test_rejecting_receiver() public {
        RejectingReceiver r = new RejectingReceiver();
        r.deposit{value: 1 ether}(cm);
        vm.expectRevert(ICollateralManager.NativeTransferFailed.selector);
        r.withdraw(cm, 1 ether);
        assertEq(cm.freeCollateral(address(r)), 1 ether);
    }

    function test_privileged_functions_access() public {
        bytes32 m = cm.MARKET_ROLE();
        bytes32 l = cm.LOAN_ROLE();
        vm.deal(stranger, 1 ether);
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, m));
        cm.depositFor{value: 1}(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, m));
        cm.lockForRequest(1, stranger, 1);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, m));
        cm.unlockFromRequest(1, stranger, 1);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, l));
        cm.assignFromRequest(1, 1, stranger, 1);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, l));
        cm.assignFromFree(1, stranger, 1);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, l));
        cm.releaseLoan(1, stranger);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, l));
        cm.seize(1, stranger, 1, stranger);
        vm.stopPrank();
    }

    function test_internal_paths() public {
        vm.deal(address(market), 10 ether);
        vm.startPrank(address(market));
        vm.expectRevert(ICollateralManager.ZeroAmount.selector);
        cm.depositFor{value: 0}(borrower);
        cm.depositFor{value: 3 ether}(borrower);
        vm.expectRevert(abi.encodeWithSelector(ICollateralManager.InsufficientFree.selector, 3 ether, 4 ether));
        cm.lockForRequest(7, borrower, 4 ether);
        cm.lockForRequest(7, borrower, 3 ether);
        vm.expectRevert(abi.encodeWithSelector(ICollateralManager.InsufficientLocked.selector, 3 ether, 4 ether));
        cm.unlockFromRequest(7, borrower, 4 ether);
        vm.stopPrank();

        vm.startPrank(address(loans));
        cm.assignFromRequest(7, 1, borrower, 1 ether);
        assertEq(cm.loanCollateral(1), 1 ether);
        cm.releaseLoan(1, borrower);
        // Safety rule 6: release empties the lock; a second release reverts.
        vm.expectRevert(abi.encodeWithSelector(ICollateralManager.InsufficientLocked.selector, 0, 1));
        cm.releaseLoan(1, borrower);
        cm.assignFromRequest(7, 2, borrower, 2 ether);
        vm.expectRevert(abi.encodeWithSelector(ICollateralManager.InsufficientLocked.selector, 2 ether, 3 ether));
        cm.seize(2, lender, 3 ether, borrower);
        cm.seize(2, lender, 1.5 ether, borrower);
        assertEq(cm.freeCollateral(lender), 1.5 ether);
        vm.expectRevert(abi.encodeWithSelector(ICollateralManager.InsufficientLocked.selector, 0, 1));
        cm.seize(2, lender, 1, borrower);
        vm.stopPrank();
        assertEq(address(cm).balance, cm.totalFree() + cm.totalLockedInRequests() + cm.totalLockedInLoans());
    }

    function test_constructor_zero() public {
        vm.expectRevert(CollateralManager.ZeroAddress.selector);
        new CollateralManager(config, address(0));
    }
}
