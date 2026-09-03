// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.30;

import {Script} from "@forge/Script.sol";
import {SLOWNext} from "../src/SLOWNext.sol";

/// @dev A token that answers name() and symbol(), which is all _createURI reads.
contract Tok {
    string public name;
    string public symbol;

    constructor(string memory n, string memory s) {
        name = n;
        symbol = s;
    }
}

/// @notice Dumps uri(id) straight from the contract for a spread of assets and
///         delays, so the gallery shows what holders actually see rather than a
///         re-implementation of the renderer in another language.
contract RenderGallery is Script {
    function run() external {
        SLOWNext slow = new SLOWNext(address(0), address(0));

        string[2][15] memory assets = [
            ["Ether", "ETH"],
            ["USD Coin", "USDC"],
            ["Tether USD", "USDT"],
            ["Ethena USDe", "USDe"],
            ["Global Dollar", "USDG"],
            ["Coinbase Wrapped BTC", "cbBTC"],
            ["Wrapped BTC", "WBTC"],
            ["Wrapped liquid staked Ether 2.0", "wstETH"],
            ["Coinbase Wrapped Staked ETH", "cbETH"],
            ["Aerodrome", "AERO"],
            ["Liquity BOLD", "BOLD"],
            ["NVIDIA Corporation", "NVDA"],
            ["SPDR S&P 500 ETF Trust", "SPY"],
            ["SpaceX", "SPCX"],
            ["GameStop Corp.", "GME"]
        ];

        uint256[9] memory delays = [
            uint256(60), // a minute, the floor
            3600, // an hour, the default
            86400, // a day
            604800, // a week
            2592000, // 30 days
            7776000, // 90 days, rolls to months
            31536000, // a year
            157680000, // five years
            type(uint96).max // the ceiling, so the label cannot overflow the plate
        ];

        string memory out = "";
        for (uint256 a; a != assets.length; ++a) {
            address token = address(0);
            if (a != 0) token = address(new Tok(assets[a][0], assets[a][1]));
            for (uint256 d; d != delays.length; ++d) {
                uint256 id = uint256(uint160(token)) | (delays[d] << 160);
                out = string.concat(out, assets[a][1], "\t", vm.toString(delays[d]), "\t", slow.uri(id), "\n");
            }
        }
        vm.writeFile("out/gallery.tsv", out);
    }
}
