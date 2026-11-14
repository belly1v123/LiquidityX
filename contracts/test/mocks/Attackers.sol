// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ICollateralManager, ILoanManager, ILoanMarketplace} from "../../src/interfaces/ILiquidityX.sol";

/// @notice Withdraws free collateral and tries to re-enter withdrawCollateral from receive().
contract ReentrantCollateralReceiver {
    ICollateralManager public immutable cm;
    uint256 public attempts;
    bool public reentered;
    bytes public lastError;
    bool public immutable swallow;

    constructor(ICollateralManager cm_, bool swallow_) {
        cm = cm_;
        swallow = swallow_;
    }

    function deposit() external payable {
        cm.depositCollateral{value: msg.value}();
    }

    function withdraw(uint256 amount) external {
        cm.withdrawCollateral(amount);
    }

    receive() external payable {
        if (attempts == 0) {
            attempts++;
            try cm.withdrawCollateral(msg.value) {
                reentered = true;
            } catch (bytes memory err) {
                lastError = err;
                // Either bubble (outer withdrawal fails with NativeTransferFailed) or swallow and inspect.
                if (!swallow) revert("reentry blocked");
            }
        }
    }
}

/// @notice A contract that refuses native BTC.
contract RejectingReceiver {
    function deposit(ICollateralManager cm) external payable {
        cm.depositCollateral{value: msg.value}();
    }

    function withdraw(ICollateralManager cm, uint256 amount) external {
        cm.withdrawCollateral(amount);
    }
}

/// @notice A borrower contract that can create requests and repay; used for the malicious-token test.
contract ContractBorrower {
    receive() external payable {}

    function createRequest(
        ILoanMarketplace m,
        address asset,
        uint256 amount,
        uint16 apr,
        uint32 duration,
        uint256 collateral,
        uint64 expiry
    ) external payable returns (uint256) {
        return m.createRequest{value: msg.value}(asset, amount, apr, duration, collateral, expiry);
    }

    function approve(ERC20 t, address spender, uint256 amount) external {
        t.approve(spender, amount);
    }

    function repay(ILoanManager lm, uint256 loanId, uint256 amount) external returns (uint256) {
        return lm.repay(loanId, amount);
    }

    function withdrawCollateral(ICollateralManager cm, uint256 amount) external {
        cm.withdrawCollateral(amount);
    }
}

/// @notice ERC-20 that calls back into a target during transferFrom (simulates a hook token, e.g. ERC-777).
///  The callback re-enters LoanManager.repay / CollateralManager.withdrawCollateral.
contract ReentrantToken is ERC20 {
    address public target;
    bytes public payload;
    bool public armed;
    bool public reentrySucceeded;
    bytes public reentryError;

    constructor() ERC20("Reentrant", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (armed) {
            armed = false;
            (bool ok, bytes memory ret) = target.call(payload);
            reentrySucceeded = ok;
            reentryError = ret;
        }
        return super.transferFrom(from, to, value);
    }
}
