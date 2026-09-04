// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.30;

import {Script} from "@forge/Script.sol";
import {SLOW} from "../src/SLOW.sol";

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
        SLOW slow = new SLOW(address(0), address(0));

        // The last two are not decoration. `_fit` sizes on `bytes(s).length`,
        // and a port that reaches for a language's own string length agrees on
        // ASCII and diverges on everything else — a four-character CJK symbol
        // is twelve bytes here and four in JavaScript, which drew it at 44px
        // where this draws 33. An all-ASCII fixture cannot catch that, so the
        // fixture is no longer all-ASCII. The second one carries an ampersand
        // and a two-byte letter together, so escapeHTML and the byte count are
        // exercised in the same row.
        string[2][17] memory assets = [
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
            ["GameStop Corp.", "GME"],
            [unicode"日本円ステーブルコイン", unicode"日本円ト"],
            [unicode"Übercoin & Company Limited", unicode"ÜBER"]
        ];

        // Two sets. The first is the round durations a sender actually picks.
        // The second set is the awkward values, and it is the one worth looking
        // at: _formatDelay picks the largest unit that divides EXACTLY, so an
        // hour and a half is "90 minutes" rather than "1 hour", and 729 days is
        // "729 days" rather than "1 year". A label that reads back as anything
        // other than the delay is a lie on an artefact nobody can correct.
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
            90, // a minute and a half -> "90 seconds"
            3599, // 59m59s -> "3599 seconds", exact or nothing
            5400, // an hour and thirty minutes -> "90 minutes"
            86399, // 23h59m59s -> "86399 seconds", exact or nothing
            90000, // a day and an hour -> "25 hours"
            3888000, // 45 days -> "45 days"
            62985600 // 729 days, two years less a day -> "729 days"
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
                    string.concat(
                        assets[a][1],
                        "\t",
                        vm.toString(delays[d]),
                        "\t",
                        slow.uri(id),
                        // The NAME, verbatim. The parity test used to recover it
                        // by regex out of the render — but the render carries a
                        // CLIPPED name, and clipping is not idempotent once a
                        // codepoint straddles the cut, so feeding it back drew a
                        // fourth full stop. Recovering an input from an output
                        // works only while the output is lossless. Write it down.
                        "\t",
                        assets[a][0]
                    )
                );
            }
        }
    }
}
