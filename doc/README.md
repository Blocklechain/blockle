Blockle Core
=============

Setup
---------------------
Blockle Core is the original Blockle client and it builds the backbone of the network. It downloads and, by default, stores the entire history of Blockle transactions, which requires a few hundred gigabytes of disk space. Depending on the speed of your computer and network connection, the synchronization process can take anywhere from a few hours to a day or more.

To download Blockle Core, visit [blocklecore.org]([https://github.com/NotRin7/Blockle/releases/).

Running
---------------------
The following are some helpful notes on how to run Blockle Core on your native platform.

### Unix

Unpack the files into a directory and run:

- `bin/blockle-qt` (GUI) or
- `bin/blockled` (headless)

### Windows

Unpack the files into a directory, and then run blockle-qt.exe.

### macOS

Drag Blockle Core to your applications folder, and then run Blockle Core.

### Need Help?

* Ask for help on [Discord]([https://discord.com/invite/z2T8qvzeGc]).

Building
---------------------
The following are developer notes on how to build Blockle Core on your native platform. They are not complete guides, but include notes on the necessary libraries, compile flags, etc.

- [Dependencies](dependencies.md)
- [macOS Build Notes](build-osx.md)
- [Unix Build Notes](build-unix.md)
- [Windows Build Notes](build-windows.md)
- [FreeBSD Build Notes](build-freebsd.md)
- [OpenBSD Build Notes](build-openbsd.md)
- [NetBSD Build Notes](build-netbsd.md)
- [Gitian Building Guide (External Link)](https://github.com/blockle-core/docs/blob/master/gitian-building.md)

Development
---------------------
The Blockle repo's [root README](/README.md) contains relevant information on the development process and automated testing.

- [Developer Notes](developer-notes.md)
- [Productivity Notes](productivity.md)
- [Release Notes](release-notes.md)
- [Release Process](release-process.md)
- [Source Code Documentation (External Link)](https://doxygen.blocklecore.org/)
- [Translation Process](translation_process.md)
- [Translation Strings Policy](translation_strings_policy.md)
- [JSON-RPC Interface](JSON-RPC-interface.md)
- [Unauthenticated REST Interface](REST-interface.md)
- [Shared Libraries](shared-libraries.md)
- [BIPS](bips.md)
- [Dnsseed Policy](dnsseed-policy.md)
- [Benchmarking](benchmarking.md)

### Resources
* Discuss on the [BlockleTalk](https://blockletalk.org/) forums, in the [Development & Technical Discussion board](https://blockletalk.org/index.php?board=6.0).
* Discuss project-specific development on #blockle-core-dev on Freenode. If you don't have an IRC client, use [webchat here](https://webchat.freenode.net/#blockle-core-dev).
* Discuss general Blockle development on #blockle-dev on Freenode. If you don't have an IRC client, use [webchat here](https://webchat.freenode.net/#blockle-dev).

### Miscellaneous
- [Assets Attribution](assets-attribution.md)
- [blockle.conf Configuration File](blockle-conf.md)
- [Files](files.md)
- [Fuzz-testing](fuzzing.md)
- [Reduce Memory](reduce-memory.md)
- [Reduce Traffic](reduce-traffic.md)
- [Tor Support](tor.md)
- [Init Scripts (systemd/upstart/openrc)](init.md)
- [ZMQ](zmq.md)
- [PSBT support](psbt.md)

License
---------------------
Distributed under the [MIT software license](/COPYING).
