// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {LiquidityXVault} from "../src/LiquidityXVault.sol";
import {ILiquidityXVault, IProtocolConfig} from "../src/interfaces/ILiquidityX.sol";
import {MockFeeOnTransferToken} from "./mocks/MockFeeOnTransferToken.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

contract VaultTest is BaseTest {
    function test_deposit_withdraw() public {
        _deposit(lender, address(musd), 1_000e18);
        assertEq(vault.available(lender, address(musd)), 1_000e18);
        assertEq(vault.totalAvailable(address(musd)), 1_000e18);
        assertEq(musd.balanceOf(address(vault)), 1_000e18);

        uint256 before = musd.balanceOf(lender);
        vm.prank(lender);
        vault.withdraw(address(musd), 400e18);
        assertEq(musd.balanceOf(lender), before + 400e18);
        assertEq(vault.available(lender, address(musd)), 600e18);
        assertEq(vault.totalAvailable(address(musd)), 600e18);
    }

    function test_deposit_events() public {
        vm.expectEmit(true, true, false, true, address(vault));
        emit ILiquidityXVault.Deposited(lender, address(musd), 5e18);
        _deposit(lender, address(musd), 5e18);
        vm.expectEmit(true, true, false, true, address(vault));
        emit ILiquidityXVault.Withdrawn(lender, address(musd), 5e18);
        vm.prank(lender);
        vault.withdraw(address(musd), 5e18);
    }

    function test_deposit_reverts() public {
        vm.startPrank(lender);
        vm.expectRevert(ILiquidityXVault.ZeroAmount.selector);
        vault.deposit(address(musd), 0);
        MockERC20 other = new MockERC20("X", "X", 18);
        vm.expectRevert(abi.encodeWithSelector(ILiquidityXVault.AssetNotEnabled.selector, address(other)));
        vault.deposit(address(other), 1e18);
        vm.stopPrank();
    }

    function test_withdraw_more_than_available_reverts() public {
        _deposit(lender, address(musd), 100e18);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILiquidityXVault.InsufficientAvailable.selector, 100e18, 101e18));
        vault.withdraw(address(musd), 101e18);
        vm.prank(lender);
        vm.expectRevert(ILiquidityXVault.ZeroAmount.selector);
        vault.withdraw(address(musd), 0);
    }

    /// Safety rule 1: reserved and lent funds are not withdrawable.
    function test_cannot_withdraw_reserved_or_lent() public {
        _depositAndOffer(lender, 1_000e18, 500);
        assertEq(vault.available(lender, address(musd)), 0);
        assertEq(vault.reserved(lender, address(musd)), 1_000e18);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILiquidityXVault.InsufficientAvailable.selector, 0, 1));
        vault.withdraw(address(musd), 1);

        uint256 rid = _request(borrower, address(musd), 500e18, 800, 1 days, _coll(500e18, 20_000));
        vm.prank(lender);
        market.matchOfferAndRequest(1, rid, 500e18);
        assertEq(vault.lent(lender, address(musd)), 500e18);
        assertEq(vault.reserved(lender, address(musd)), 500e18);
        vm.prank(lender);
        vm.expectRevert(abi.encodeWithSelector(ILiquidityXVault.InsufficientAvailable.selector, 0, 1));
        vault.withdraw(address(musd), 1);
    }

    function test_withdraw_allowed_after_asset_disabled() public {
        _deposit(lender, address(musd), 100e18);
        vm.prank(admin);
        config.configureAsset(address(musd), false, 1e18, 1_000_000e18);
        vm.prank(lender);
        vault.withdraw(address(musd), 100e18);
    }

    /// Safety rule 10: fee-on-transfer rejected on deposit.
    function test_fee_on_transfer_rejected_on_deposit() public {
        MockFeeOnTransferToken fot = new MockFeeOnTransferToken();
        vm.prank(admin);
        config.configureAsset(address(fot), true, 1e18, 1_000_000e18);
        fot.mint(lender, 1_000e18);
        vm.startPrank(lender);
        fot.approve(address(vault), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(ILiquidityXVault.TransferAmountMismatch.selector, 100e18, 99e18));
        vault.deposit(address(fot), 100e18);
        vm.stopPrank();
    }

    function test_privileged_functions_access() public {
        bytes32 market_ = vault.MARKET_ROLE();
        bytes32 loan_ = vault.LOAN_ROLE();
        assertEq(market_, keccak256("MARKET_ROLE"));
        assertEq(loan_, keccak256("LOAN_ROLE"));
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, market_));
        vault.reserve(lender, address(musd), 1);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, market_));
        vault.release(lender, address(musd), 1);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, loan_));
        vault.fundLoan(1, lender, address(musd), 1, stranger, true);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, loan_));
        vault.collectRepayment(1, lender, address(musd), stranger, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, loan_));
        vault.writeOff(1, lender, address(musd), 1);
        vm.stopPrank();
        // Even the marketplace cannot call LOAN_ROLE functions.
        vm.prank(address(market));
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, address(market), loan_));
        vault.fundLoan(1, lender, address(musd), 1, stranger, true);
    }

    function test_internal_paths_insufficient() public {
        _deposit(lender, address(musd), 10e18);
        vm.startPrank(address(market));
        vm.expectRevert(abi.encodeWithSelector(ILiquidityXVault.InsufficientAvailable.selector, 10e18, 11e18));
        vault.reserve(lender, address(musd), 11e18);
        vm.expectRevert(abi.encodeWithSelector(ILiquidityXVault.InsufficientReserved.selector, 0, 1));
        vault.release(lender, address(musd), 1);
        vm.expectRevert(ILiquidityXVault.ZeroAmount.selector);
        vault.reserve(lender, address(musd), 0);
        vm.stopPrank();
        vm.startPrank(address(loans));
        vm.expectRevert(abi.encodeWithSelector(ILiquidityXVault.InsufficientReserved.selector, 0, 1));
        vault.fundLoan(1, lender, address(musd), 1, borrower, true);
        vm.expectRevert(abi.encodeWithSelector(ILiquidityXVault.InsufficientAvailable.selector, 10e18, 11e18));
        vault.fundLoan(1, lender, address(musd), 11e18, borrower, false);
        vm.expectRevert(abi.encodeWithSelector(ILiquidityXVault.InsufficientLent.selector, 0, 1));
        vault.collectRepayment(1, lender, address(musd), borrower, 1, 0);
        vm.expectRevert(abi.encodeWithSelector(ILiquidityXVault.InsufficientLent.selector, 0, 1));
        vault.writeOff(1, lender, address(musd), 1);
        vm.expectRevert(ILiquidityXVault.ZeroAmount.selector);
        vault.collectRepayment(1, lender, address(musd), borrower, 0, 0);
        vm.stopPrank();
    }

    function test_constructor_zero() public {
        vm.expectRevert(LiquidityXVault.ZeroAddress.selector);
        new LiquidityXVault(IProtocolConfig(address(0)), admin);
        vm.expectRevert(LiquidityXVault.ZeroAddress.selector);
        new LiquidityXVault(config, address(0));
    }
}
