// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MezoFeedSim} from "./MezoFeedSim.sol";
import {
    ILoanMarketplace,
    ILoanManager,
    ILiquidityXVault,
    ICollateralManager,
    IPriceOracleAdapter
} from "../src/interfaces/ILiquidityX.sol";
import {LXTypes} from "../src/interfaces/ILiquidityXTypes.sol";

/// @notice Full two-wallet lifecycle against an existing deployment (deployments/<chainId>.json):
///  lender deposits + offers, borrower requests with BTC at ~200% CR, match, borrower repays in full,
///  borrower withdraws collateral, lender withdraws principal + interest.
///  Env: LENDER_PRIVATE_KEY, BORROWER_PRIVATE_KEY, DEMO_AMOUNT (wei, default 10e18), DEMO_DURATION (s, default 3600),
///       DEMO_APR_BPS (default 500).
///  The borrower needs a little MUSD on top of the loan for interest, plus BTC for collateral and gas.
///  Testnet: forge script script/Demo.s.sol --rpc-url mezo_testnet --broadcast --skip-simulation --slow --legacy --gas-estimate-multiplier 200
contract Demo is MezoFeedSim {
    struct D {
        ILoanMarketplace market;
        ILoanManager loans;
        ILiquidityXVault vault;
        ICollateralManager cm;
        IPriceOracleAdapter oracle;
        IERC20 musd;
        address feed;
    }

    function _load() internal view returns (D memory d) {
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);
        d.market = ILoanMarketplace(vm.parseJsonAddress(json, ".contracts.marketplace"));
        d.loans = ILoanManager(vm.parseJsonAddress(json, ".contracts.loans"));
        d.vault = ILiquidityXVault(vm.parseJsonAddress(json, ".contracts.vault"));
        d.cm = ICollateralManager(vm.parseJsonAddress(json, ".contracts.collateral"));
        d.oracle = IPriceOracleAdapter(vm.parseJsonAddress(json, ".contracts.oracle"));
        d.musd = IERC20(vm.parseJsonAddress(json, ".assets.MUSD"));
        d.feed = vm.parseJsonAddress(json, ".feed");
    }

    D internal d;
    uint256 internal lenderPk;
    uint256 internal borrowerPk;
    address internal lender;
    address internal borrower;
    address internal asset;
    uint256 internal amount;
    uint32 internal duration;
    uint16 internal apr;

    function run() external {
        d = _load();
        _simulateMezoFeed(d.feed);
        lenderPk = vm.envUint("LENDER_PRIVATE_KEY");
        borrowerPk = vm.envUint("BORROWER_PRIVATE_KEY");
        lender = vm.addr(lenderPk);
        borrower = vm.addr(borrowerPk);
        amount = vm.envOr("DEMO_AMOUNT", uint256(10e18));
        duration = uint32(vm.envOr("DEMO_DURATION", uint256(1 hours)));
        apr = uint16(vm.envOr("DEMO_APR_BPS", uint256(500)));
        asset = address(d.musd);

        console.log("lender  ", lender);
        console.log("borrower", borrower);
        console.log("amount  ", amount);
        (uint256 price,) = d.oracle.getPrice();
        console.log("BTC/USD (18 dec)", price);
        require(d.musd.balanceOf(lender) >= amount, "Demo: lender needs MUSD");

        uint256 offerId = _lenderOffer();
        uint256 requestId = _borrowerRequest();
        uint256 loanId = _match(offerId, requestId);
        _repayAndWithdraw(loanId);
        _lenderWithdraw();

        LXTypes.Loan memory l = d.loans.getLoan(loanId);
        require(l.status == LXTypes.LoanStatus.Repaid, "Demo: loan not repaid");
        console.log("    interest paid", l.interestPaid);
        console.log("Demo complete: loan", loanId, "Repaid");
    }

    /// 1. lender: approve + deposit + offer
    function _lenderOffer() internal returns (uint256 offerId) {
        vm.startBroadcast(lenderPk);
        d.musd.approve(address(d.vault), amount);
        d.vault.deposit(asset, amount);
        console.log("[1] lender deposited", amount);
        offerId = d.market.createOffer(asset, amount, apr, duration, 0, uint64(block.timestamp + 1 days));
        console.log("[2] offer created", offerId);
        vm.stopBroadcast();
    }

    /// 2. borrower: request with BTC at ~200% CR at the live price
    function _borrowerRequest() internal returns (uint256 requestId) {
        uint256 collateral = d.market.minCollateral(asset, amount, 20_000);
        console.log("    collateral (wei) for 200% CR", collateral);
        vm.startBroadcast(borrowerPk);
        requestId = d.market.createRequest{value: collateral}(
            asset, amount, apr, duration, collateral, uint64(block.timestamp + 1 days)
        );
        console.log("[3] request created", requestId);
        vm.stopBroadcast();
    }

    /// 3. lender matches its offer with the request
    function _match(uint256 offerId, uint256 requestId) internal returns (uint256 loanId) {
        vm.startBroadcast(lenderPk);
        loanId = d.market.matchOfferAndRequest(offerId, requestId, amount);
        vm.stopBroadcast();
        LXTypes.Loan memory l = d.loans.getLoan(loanId);
        console.log("[4] matched -> loan", loanId);
        console.log("    principal", l.principal, "maturity", l.maturity);
    }

    /// 4. borrower repays in full (approval covers a day of interest in case blocks are slow) and withdraws BTC
    function _repayAndWithdraw(uint256 loanId) internal {
        (,, uint256 owedLater) = d.loans.owedAt(loanId, block.timestamp + 1 days);
        vm.startBroadcast(borrowerPk);
        d.musd.approve(address(d.vault), owedLater);
        uint256 paid = d.loans.repay(loanId, type(uint256).max);
        console.log("[5] repaid in full", paid);
        uint256 free = d.cm.freeCollateral(borrower);
        d.cm.withdrawCollateral(free);
        console.log("[6] borrower withdrew collateral (wei)", free);
        vm.stopBroadcast();
    }

    /// 5. lender withdraws principal + interest
    function _lenderWithdraw() internal {
        uint256 avail = d.vault.available(lender, asset);
        vm.startBroadcast(lenderPk);
        d.vault.withdraw(asset, avail);
        console.log("[7] lender withdrew", avail);
        vm.stopBroadcast();
    }
}
