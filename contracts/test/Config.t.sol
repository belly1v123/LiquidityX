// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {IProtocolConfig} from "../src/interfaces/ILiquidityX.sol";
import {LXTypes} from "../src/interfaces/ILiquidityXTypes.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract ConfigTest is BaseTest {
    function test_initial_state() public view {
        LXTypes.RiskParams memory p = config.riskParams();
        assertEq(p.minInitialCrBps, 15_000);
        assertEq(p.liquidationCrBps, 12_000);
        assertEq(p.maxCollateralPerLoan, 10 ether);
        assertTrue(config.hasRole(config.RISK_ADMIN_ROLE(), admin));
        assertTrue(config.hasRole(config.PAUSER_ROLE(), admin));
        assertTrue(config.hasRole(config.DEFAULT_ADMIN_ROLE(), admin));
        assertEq(config.RISK_ADMIN_ROLE(), keccak256("RISK_ADMIN_ROLE"));
        assertEq(config.PAUSER_ROLE(), keccak256("PAUSER_ROLE"));
        address[] memory a = config.listAssets();
        assertEq(a.length, 2);
        assertEq(a[0], address(musd));
        LXTypes.AssetConfig memory c = config.assetConfig(address(usdc));
        assertEq(c.decimals, 6);
        assertTrue(c.enabled);
    }

    function test_setRiskParams_valid() public {
        LXTypes.RiskParams memory p = defaultParams();
        p.minInitialCrBps = 20_000;
        vm.prank(admin);
        config.setRiskParams(p);
        assertEq(config.riskParams().minInitialCrBps, 20_000);
    }

    function _expectInvalid(LXTypes.RiskParams memory p) internal {
        vm.prank(admin);
        vm.expectRevert(IProtocolConfig.InvalidRiskParams.selector);
        config.setRiskParams(p);
    }

    function test_setRiskParams_bounds() public {
        LXTypes.RiskParams memory p;
        p = defaultParams(); p.liquidationCrBps = 10_499; _expectInvalid(p);
        p = defaultParams(); p.liquidationCrBps = 15_000; _expectInvalid(p);
        p = defaultParams(); p.minInitialCrBps = 50_001; _expectInvalid(p);
        p = defaultParams(); p.liquidationBonusBps = 2_001; _expectInvalid(p);
        p = defaultParams(); p.liquidationCrBps = 10_500; p.liquidationBonusBps = 501; _expectInvalid(p);
        p = defaultParams(); p.minAprBps = 0; _expectInvalid(p);
        p = defaultParams(); p.minAprBps = 200; p.maxAprBps = 100; _expectInvalid(p);
        p = defaultParams(); p.maxAprBps = 50_001; _expectInvalid(p);
        p = defaultParams(); p.minDuration = 59; _expectInvalid(p);
        p = defaultParams(); p.minDuration = 2 days; p.maxDuration = 1 days; _expectInvalid(p);
        p = defaultParams(); p.maxDuration = 731 days; _expectInvalid(p);
        p = defaultParams(); p.gracePeriod = 31 days; _expectInvalid(p);
        p = defaultParams(); p.maxListingLifetime = 1 hours - 1; _expectInvalid(p);
        p = defaultParams(); p.maxListingLifetime = 366 days; _expectInvalid(p);
        p = defaultParams(); p.maxCollateralPerLoan = 0; _expectInvalid(p);
    }

    function test_constructor_validates() public {
        LXTypes.RiskParams memory p = defaultParams();
        p.maxCollateralPerLoan = 0;
        vm.expectRevert(IProtocolConfig.InvalidRiskParams.selector);
        new ProtocolConfig(p, admin);
    }

    function test_configureAsset() public {
        MockERC20 t = new MockERC20("T", "T", 8);
        vm.prank(admin);
        config.configureAsset(address(t), false, 1, 10);
        LXTypes.AssetConfig memory c = config.assetConfig(address(t));
        assertEq(c.decimals, 8);
        assertFalse(c.enabled);
        assertFalse(config.isAssetEnabled(address(t)));
        // reconfigure: not listed twice
        vm.prank(admin);
        config.configureAsset(address(t), true, 1, 10);
        assertTrue(config.isAssetEnabled(address(t)));
        assertEq(config.listAssets().length, 3);
    }

    function test_configureAsset_invalid() public {
        MockERC20 t0 = new MockERC20("T", "T", 0);
        MockERC20 t19 = new MockERC20("T", "T", 19);
        vm.startPrank(admin);
        vm.expectRevert(IProtocolConfig.InvalidAsset.selector);
        config.configureAsset(address(t0), true, 1, 10);
        vm.expectRevert(IProtocolConfig.InvalidAsset.selector);
        config.configureAsset(address(t19), true, 1, 10);
        vm.expectRevert(IProtocolConfig.InvalidAsset.selector);
        config.configureAsset(address(musd), true, 0, 10);
        vm.expectRevert(IProtocolConfig.InvalidAsset.selector);
        config.configureAsset(address(musd), true, 11, 10);
        vm.expectRevert(IProtocolConfig.InvalidAsset.selector);
        config.configureAsset(address(0), true, 1, 10);
        vm.expectRevert(IProtocolConfig.InvalidAsset.selector);
        config.configureAsset(makeAddr("eoa"), true, 1, 10);
        vm.expectRevert(IProtocolConfig.InvalidAsset.selector);
        config.configureAsset(address(oracle), true, 1, 10); // no decimals()
        vm.stopPrank();
    }

    function test_access_control() public {
        bytes32 risk = config.RISK_ADMIN_ROLE();
        bytes32 pauser = config.PAUSER_ROLE();
        LXTypes.RiskParams memory p = defaultParams();
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, risk));
        config.setRiskParams(p);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, risk));
        config.configureAsset(address(musd), true, 1, 2);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, pauser));
        config.pause();
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, pauser));
        config.unpause();
        vm.stopPrank();
    }

    function test_pause_unpause() public {
        vm.startPrank(admin);
        config.pause();
        assertTrue(config.paused());
        vm.expectRevert(Pausable.EnforcedPause.selector);
        config.pause();
        config.unpause();
        assertFalse(config.paused());
        vm.expectRevert(Pausable.ExpectedPause.selector);
        config.unpause();
        vm.stopPrank();
    }
}
