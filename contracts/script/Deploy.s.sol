// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console} from "forge-std/Script.sol";
import {MezoFeedSim} from "./MezoFeedSim.sol";
import {PriceOracleAdapter} from "../src/PriceOracleAdapter.sol";
import {ProtocolConfig} from "../src/ProtocolConfig.sol";
import {LiquidityXVault} from "../src/LiquidityXVault.sol";
import {CollateralManager} from "../src/CollateralManager.sol";
import {LoanManager} from "../src/LoanManager.sol";
import {LoanMarketplace} from "../src/LoanMarketplace.sol";
import {LiquidationEngine} from "../src/LiquidationEngine.sol";
import {LXTypes} from "../src/interfaces/ILiquidityXTypes.sol";
import {MockERC20} from "../test/mocks/MockERC20.sol";
import {MockAggregator} from "../test/mocks/MockAggregator.sol";

/// @notice Deploys and wires LiquidityX (docs/CONTRACTS.md "Deployment wiring").
///  chain 31611 (Mezo testnet): real MUSD / mUSDC / BTC-USD precompile.
///  chain 31337 (anvil): MockERC20 MUSD + MockAggregator ($100,000, always fresh); mints to anvil accounts 0..3.
///  Writes deployments/<chainId>.json.
///  Usage (anvil):   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
///  Usage (testnet): forge script script/Deploy.s.sol --rpc-url mezo_testnet --broadcast --skip-simulation --legacy
///  (--skip-simulation is required on Mezo, see MezoFeedSim.)
contract Deploy is MezoFeedSim {
    address internal constant MEZO_MUSD = 0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503;
    address internal constant MEZO_MUSDC = 0xe1a26db653708A2AD8F824E92Db9852410e33A59;
    address internal constant MEZO_BTC_USD_FEED = 0x7b7c000000000000000000000000000000000015;
    uint256 internal constant MAX_STALENESS = 3600;

    struct Deployed {
        PriceOracleAdapter oracle;
        ProtocolConfig config;
        LiquidityXVault vault;
        CollateralManager collateral;
        LoanManager loans;
        LoanMarketplace marketplace;
        LiquidationEngine liquidation;
        address musd;
        address musdc; // 0 when not configured
        address feed;
    }

    function defaultParams() public pure returns (LXTypes.RiskParams memory) {
        return LXTypes.RiskParams({
            minInitialCrBps: 15_000,
            liquidationCrBps: 12_000,
            liquidationBonusBps: 500,
            minAprBps: 1,
            maxAprBps: 10_000,
            minDuration: 1 hours,
            maxDuration: 365 days,
            gracePeriod: 1 days,
            maxListingLifetime: 30 days,
            maxCollateralPerLoan: 10 ether
        });
    }

    function run() external returns (Deployed memory d) {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);
        uint256 startBlock = block.number;
        bool local = block.chainid == 31337;
        require(local || block.chainid == 31611, "Deploy: unsupported chain");

        console.log("chainId", block.chainid);
        console.log("deployer", deployer);
        console.log("deployer balance (wei)", deployer.balance);

        vm.startBroadcast(pk);

        if (local) {
            MockERC20 musd = new MockERC20("Mezo USD (local)", "MUSD", 18);
            MockAggregator agg = new MockAggregator(18, 100_000e18);
            agg.setLive(true);
            d.musd = address(musd);
            d.feed = address(agg);
            // anvil default accounts 0..3
            address[4] memory accts = [
                0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,
                0x70997970C51812dc3A010C7d01b50e0d17dc79C8,
                0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC,
                0x90F79bf6EB2c4f870365E785982E1f101E93b906
            ];
            for (uint256 i; i < 4; ++i) {
                musd.mint(accts[i], 100_000e18);
            }
        } else {
            _simulateMezoFeed(MEZO_BTC_USD_FEED);
            d.musd = MEZO_MUSD;
            d.musdc = MEZO_MUSDC;
            d.feed = MEZO_BTC_USD_FEED;
        }

        // 1. oracle + config
        d.oracle = new PriceOracleAdapter(d.feed, MAX_STALENESS, deployer);
        d.config = new ProtocolConfig(defaultParams(), deployer);
        // 2. custody, loans, marketplace, engine
        d.vault = new LiquidityXVault(d.config, deployer);
        d.collateral = new CollateralManager(d.config, deployer);
        d.loans = new LoanManager(d.config, d.vault, d.collateral, deployer);
        d.marketplace = new LoanMarketplace(d.config, d.oracle, d.vault, d.collateral, d.loans, deployer);
        d.liquidation = new LiquidationEngine(d.config, d.oracle, d.loans, deployer);

        // 3. roles
        d.vault.grantRole(d.vault.MARKET_ROLE(), address(d.marketplace));
        d.vault.grantRole(d.vault.LOAN_ROLE(), address(d.loans));
        d.collateral.grantRole(d.collateral.MARKET_ROLE(), address(d.marketplace));
        d.collateral.grantRole(d.collateral.LOAN_ROLE(), address(d.loans));
        d.loans.grantRole(d.loans.MARKET_ROLE(), address(d.marketplace));
        d.loans.grantRole(d.loans.LIQUIDATOR_ROLE(), address(d.liquidation));

        // 4. assets
        d.config.configureAsset(d.musd, true, 1e18, 1_000_000e18);
        if (d.musdc != address(0)) d.config.configureAsset(d.musdc, false, 1e6, 1_000_000e6);

        vm.stopBroadcast();

        // Sanity: the oracle must be readable right now (fails loudly if the precompile/feed is wrong).
        (bool ok, uint256 price,) = d.oracle.tryGetPrice();
        console.log("oracle ok", ok);
        console.log("price (18 dec)", price);

        _write(d, deployer, startBlock);
        _log(d);
    }

    function _write(Deployed memory d, address deployer, uint256 startBlock) internal {
        string memory contracts_ = string.concat(
            "{\"oracle\":\"", vm.toString(address(d.oracle)),
            "\",\"config\":\"", vm.toString(address(d.config)),
            "\",\"vault\":\"", vm.toString(address(d.vault)),
            "\",\"collateral\":\"", vm.toString(address(d.collateral)),
            "\",\"loans\":\"", vm.toString(address(d.loans)),
            "\",\"marketplace\":\"", vm.toString(address(d.marketplace)),
            "\",\"liquidation\":\"", vm.toString(address(d.liquidation)), "\"}"
        );
        string memory musdc = d.musdc == address(0) ? "null" : string.concat("\"", vm.toString(d.musdc), "\"");
        string memory json = string.concat(
            "{\"chainId\":", vm.toString(block.chainid),
            ",\"deployer\":\"", vm.toString(deployer),
            "\",\"startBlock\":", vm.toString(startBlock),
            ",\"contracts\":", contracts_,
            ",\"assets\":{\"MUSD\":\"", vm.toString(d.musd), "\",\"mUSDC\":", musdc, "}",
            ",\"feed\":\"", vm.toString(d.feed),
            "\",\"txs\":{}}"
        );
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console.log("wrote", path);
    }

    function _log(Deployed memory d) internal pure {
        console.log("PriceOracleAdapter", address(d.oracle));
        console.log("ProtocolConfig    ", address(d.config));
        console.log("LiquidityXVault   ", address(d.vault));
        console.log("CollateralManager ", address(d.collateral));
        console.log("LoanManager       ", address(d.loans));
        console.log("LoanMarketplace   ", address(d.marketplace));
        console.log("LiquidationEngine ", address(d.liquidation));
        console.log("MUSD              ", d.musd);
        console.log("feed              ", d.feed);
    }
}
