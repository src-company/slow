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

        // Two sets. The first is the round durations a sender actually picks.
        // The second is where `_formatDelay` shows its seams: it prints ONE unit
        // and truncates, so nothing ever reads "an hour and thirty minutes" —
        // that is an hour, and 45 days is a month. These are the renders that
        // say what a holder is really shown.
        uint256[18] memory delays = [
            uint256(60), // a minute, the floor
            3600, // an hour, the default
            86400, // a day
            604800, // a week
            2592000, // 30 days
            7776000, // 90 days, rolls to months
            31536000, // a year
            157680000, // five years
            type(uint96).max, // the ceiling, so the label cannot overflow the plate
            1, // "1 second" — the only singular second
            59, // still seconds, one tick below the minute floor
            90, // a minute and a half -> "1 minute"
            3599, // 59m59s -> "59 minutes", one tick below the hour
            5400, // an hour and thirty minutes -> "1 hour"
            86399, // 23h59m59s -> "23 hours", one tick below the day
            90000, // a day and an hour -> "1 day"
            3888000, // 45 days -> "1 month"
            62985600 // 729 days, two years less a day -> "1 year"
        ];

        // Written a line at a time rather than concatenated: every uri() is a
        // ~1.6 kB base64 blob, and accumulating 270 of them into one string runs
        // the EVM out of memory before the file is ever opened.
        vm.writeFile("preview/gallery.tsv", "");
        for (uint256 a; a != assets.length; ++a) {
            address token = address(0);
            if (a != 0) token = address(new Tok(assets[a][0], assets[a][1]));
            for (uint256 d; d != delays.length; ++d) {
                uint256 id = uint256(uint160(token)) | (delays[d] << 160);
                vm.writeLine(
                    "preview/gallery.tsv",
                    string.concat(assets[a][1], "\t", vm.toString(delays[d]), "\t", slow.uri(id))
                );
            }
        }
    }
}
