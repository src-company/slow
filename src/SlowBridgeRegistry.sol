// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.30;

/// @title SLOW bridge registry
/// @notice Where the dapp learns which L1 route reaches which destination
///         chain, so a page frozen in bytecode can still find a rollup that did
///         not exist when it was written.
///
/// @dev WHY A REGISTRY AT ALL. The page is immutable. Bridge entrypoints are
///      proxies whose implementations get replaced, gas parameters drift, and
///      new destinations appear. Baking a route in means the page is wrong the
///      day any of that changes, and cannot be told.
///
/// @dev What the owner can and cannot do. A registry an owner can rewrite is a
///      registry that can point a bridge at an address which keeps the ETH, so
///      this one is deliberately weak:
///
///      1. IT STORES NO CALLDATA. Only an entrypoint address, a `kind` naming a
///         bridge FAMILY the page already knows how to talk to, and gas
///         parameters. The page builds the calldata itself from that kind. An
///         owner can therefore misdirect a route; it can never make the page
///         construct a call of the owner's choosing.
///      2. ROUTES FREEZE, one way, per chain. Once frozen the entry is
///         immutable and this contract has no say over that destination again.
///      3. THE PAGE PREFERS ITS OWN. Destinations compiled into the page are
///         used from the page; a registry entry for one of those is ignored.
///         The registry can only ADD chains the page never shipped with, so the
///         trust it carries is scoped to routes a reader opted into by using a
///         chain the page did not know about.
///
///      Ownership is two-step and renounceable. Renouncing after freezing every
///      route makes this contract inert, which is the intended end state.
///
/// @dev TWO REGISTERS, ONE ARGUMENT. Alongside routes this publishes an ADDRESS
///      BOOK — where `SlowArrival`, `SlowRelay` and whatever comes after them
///      live on each chain — for the same reason and under the same rules. A
///      page frozen in bytecode cannot carry a constant for a contract that is
///      not deployed yet, and `SlowRelay` is not. See `deployments`: it is a
///      discovery pointer, the reader verifies what it finds, the page prefers
///      its own, and freezing is how the trust is given back.
contract SlowBridgeRegistry {
    /// @notice Bridge families the page knows how to build calldata for.
    /// @dev NONE is the zero value, so an unset route reads as absent rather
    ///      than as a valid family.
    enum Kind {
        NONE,
        OP_STACK, // OptimismPortal.depositTransaction(address,uint256,uint64,bool,bytes)
        ARBITRUM // Inbox.createRetryableTicket(address,uint256,uint256,address,address,uint256,uint256,bytes)
    }

    struct Route {
        address entry; // the L1 contract to call
        Kind kind; // which family, so the page knows the shape
        uint64 l2GasLimit; // gas to buy for the destination call
        bool frozen; // once true, this route can never change again
    }

    /// @notice destination chain id => route from THIS chain.
    mapping(uint256 chainId => Route) public routes;

    /// @notice Every chain id ever registered, so a reader can enumerate
    ///         without knowing what to ask for.
    uint256[] public chainIds;
    mapping(uint256 chainId => bool) private _known;

    address public owner;
    address public pendingOwner;

    error NotOwner();
    error NotPendingOwner();
    error RouteFrozen();
    error InvalidRoute();

    event RouteSet(uint256 indexed chainId, address entry, Kind kind, uint64 l2GasLimit);
    event RouteFrozenEvent(uint256 indexed chainId);
    event OwnershipOffered(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    constructor(address initialOwner) {
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner || owner == address(0)) revert NotOwner();
        _;
    }

    /// @notice Publish or correct a route to `chainId`.
    /// @dev Reverts once the route is frozen. A `kind` of NONE is rejected: use
    ///      it to mean "absent", never to mean "registered but unusable".
    function setRoute(uint256 chainId, address entry, Kind kind, uint64 l2GasLimit)
        external
        onlyOwner
    {
        Route storage r = routes[chainId];
        if (r.frozen) revert RouteFrozen();
        if (entry == address(0) || kind == Kind.NONE || chainId == 0 || l2GasLimit == 0) {
            revert InvalidRoute();
        }
        r.entry = entry;
        r.kind = kind;
        r.l2GasLimit = l2GasLimit;
        if (!_known[chainId]) {
            _known[chainId] = true;
            chainIds.push(chainId);
        }
        emit RouteSet(chainId, entry, kind, l2GasLimit);
    }

    /// @notice Make a route permanent. There is no unfreeze.
    function freezeRoute(uint256 chainId) external onlyOwner {
        Route storage r = routes[chainId];
        if (r.kind == Kind.NONE) revert InvalidRoute();
        if (r.frozen) revert RouteFrozen();
        r.frozen = true;
        emit RouteFrozenEvent(chainId);
    }

    /// @notice Every route at once, so the dapp reads this in a single call
    ///         rather than one per chain it might guess at.
    function allRoutes() external view returns (uint256[] memory ids, Route[] memory out) {
        ids = chainIds;
        out = new Route[](ids.length);
        for (uint256 i; i != ids.length; ++i) {
            out[i] = routes[ids[i]];
        }
    }

    /// @notice How many chains are registered.
    function routeCount() external view returns (uint256) {
        return chainIds.length;
    }

    // ────────────────────────────────────────────────────── THE ADDRESS BOOK

    /// @notice name => chain id => where that contract lives on that chain.
    /// @dev WHAT THIS IS FOR, AND THE ONE THING IT IS NOT.
    ///
    ///      The page is immutable bytecode. `SlowRelay` is not deployed yet, and
    ///      a page shipped today can carry no constant for it — so without this
    ///      the relay becomes reachable only by shipping a NEW page, and every
    ///      later contract has the same problem. This is the register that lets
    ///      a page find something that did not exist when it was written.
    ///
    ///      It is a discovery pointer, not a trust pointer, and the safety
    ///      argument rests on that distinction. `trustedMessenger` on the relay
    ///      and `routeTo` on the arrival must stay immutable: the first accepts
    ///      duck-typed proofs and so one added entry drains every open escrow,
    ///      the second is where value travels. Neither may ever be reachable
    ///      from here. What may is the ADDRESS a reader dials, which the reader
    ///      then checks for itself.
    ///
    ///      This contract cannot check the addresses it publishes, which is
    ///      structural: it sits on one chain naming contracts
    ///      on others, where it can read no code. So `entry.code.length` — the
    ///      check `SlowArrival`'s constructor makes about its own routes — is
    ///      not available here at any price. The reader has to probe the
    ///      destination chain and confirm both that there is code and that the
    ///      selector it means to call is in it, which is what `probeArrival`
    ///      already does before any route that needs it opens.
    ///
    ///      The same additive rule as routes applies. A name the page ships a constant for
    ///      is read from the page; an entry here for that name is ignored. So
    ///      the trust this carries is scoped to contracts a reader opted into by
    ///      using something the page never knew about — and `freeze` is how that
    ///      trust is given back, one entry at a time, permanently.
    mapping(bytes32 name => mapping(uint256 chainId => Deployment)) public deployments;

    struct Deployment {
        address at; // where it lives on that chain
        bool frozen; // once true, this entry can never change again
    }

    /// @notice Every name ever registered, so a reader can enumerate without
    ///         knowing what to ask for.
    bytes32[] public names;
    mapping(bytes32 name => bool) private _knownName;
    mapping(bytes32 name => uint256[]) private _nameChains;
    mapping(bytes32 name => mapping(uint256 chainId => bool)) private _knownNameChain;

    error InvalidDeployment();
    error DeploymentFrozen();

    event DeploymentSet(bytes32 indexed name, uint256 indexed chainId, address at);
    event DeploymentFrozenEvent(bytes32 indexed name, uint256 indexed chainId);

    /// @notice Publish or correct where `name` lives on `chainId`.
    /// @param name A right-padded ASCII short string — `bytes32(bytes("SlowRelay"))`.
    ///        A plain name rather than a hash so a reader can print what it found.
    function setDeployment(bytes32 name, uint256 chainId, address at) external onlyOwner {
        Deployment storage d = deployments[name][chainId];
        if (d.frozen) revert DeploymentFrozen();
        // Zero means ABSENT, exactly as `Kind.NONE` does for a route. It never
        // means "registered but unusable", so it cannot be written.
        if (name == bytes32(0) || chainId == 0 || at == address(0)) revert InvalidDeployment();
        d.at = at;
        if (!_knownName[name]) {
            _knownName[name] = true;
            names.push(name);
        }
        if (!_knownNameChain[name][chainId]) {
            _knownNameChain[name][chainId] = true;
            _nameChains[name].push(chainId);
        }
        emit DeploymentSet(name, chainId, at);
    }

    /// @notice Make one entry permanent. There is no unfreeze.
    /// @dev Per name AND per chain, not per name: freezing Base's relay must not
    ///      also freeze a chain that has not been deployed to yet, or the first
    ///      freeze would end the register.
    function freezeDeployment(bytes32 name, uint256 chainId) external onlyOwner {
        Deployment storage d = deployments[name][chainId];
        if (d.at == address(0)) revert InvalidDeployment();
        if (d.frozen) revert DeploymentFrozen();
        d.frozen = true;
        emit DeploymentFrozenEvent(name, chainId);
    }

    /// @notice Every chain one name is deployed to.
    function deploymentsOf(bytes32 name)
        external
        view
        returns (uint256[] memory ids, Deployment[] memory out)
    {
        ids = _nameChains[name];
        out = new Deployment[](ids.length);
        for (uint256 i; i != ids.length; ++i) {
            out[i] = deployments[name][ids[i]];
        }
    }

    /// @notice The whole book, flattened, so the dapp reads it in ONE call
    ///         rather than one per name it might guess at. Parallel arrays: row
    ///         `i` is `outNames[i]` on `outChainIds[i]`.
    function allDeployments()
        external
        view
        returns (
            bytes32[] memory outNames,
            uint256[] memory outChainIds,
            address[] memory outAddrs,
            bool[] memory outFrozen
        )
    {
        uint256 n;
        for (uint256 i; i != names.length; ++i) {
            n += _nameChains[names[i]].length;
        }
        outNames = new bytes32[](n);
        outChainIds = new uint256[](n);
        outAddrs = new address[](n);
        outFrozen = new bool[](n);
        uint256 k;
        for (uint256 i; i != names.length; ++i) {
            bytes32 name = names[i];
            uint256[] storage ids = _nameChains[name];
            for (uint256 j; j != ids.length; ++j) {
                Deployment storage d = deployments[name][ids[j]];
                outNames[k] = name;
                outChainIds[k] = ids[j];
                outAddrs[k] = d.at;
                outFrozen[k] = d.frozen;
                ++k;
            }
        }
    }

    /// @notice How many distinct names are registered.
    function nameCount() external view returns (uint256) {
        return names.length;
    }

    /// @notice How many chains one name is registered on.
    function chainCountFor(bytes32 name) external view returns (uint256) {
        return _nameChains[name].length;
    }

    // ───────────────────────────────────────────────────────── OWNERSHIP

    /// @dev Two steps, so a mistyped address cannot silently end the ability to
    ///      register anything ever again.
    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipOffered(msg.sender, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || pendingOwner == address(0)) revert NotPendingOwner();
        address from = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(from, owner);
    }

    /// @notice Give up the ability to register or change any route, forever.
    /// @dev The intended end state once every route is frozen: the registry
    ///      becomes a read-only public record with nobody behind it.
    function renounceOwnership() external onlyOwner {
        address from = owner;
        owner = address(0);
        pendingOwner = address(0);
        emit OwnershipTransferred(from, address(0));
    }
}
