Repository Tools
---------------------

### [Developer tools](/contrib/devtools) ###
Specific tools for developers working on this repository.
Additional tools, including the `github-merge.py` script, are available in the [maintainer-tools](https://github.com/blockle-core/blockle-maintainer-tools) repository.

### [Verify-Commits](/contrib/verify-commits) ###
Tool to verify that every merge commit was signed by a developer using the `github-merge.py` script.

### [Linearize](/contrib/linearize) ###
Construct a linear, no-fork, best version of the blockchain.

### [Qos](/contrib/qos) ###

A Linux bash script that will set up traffic control (tc) to limit the outgoing bandwidth for connections to the Blockle network. This means one can have an always-on blockled instance running, and another local blockled/blockle-qt instance which connects to this node and receives blocks from it.

### [Seeds](/contrib/seeds) ###
Utility to generate the pnSeed[] array that is compiled into the client.

Build Tools and Keys
---------------------

### Packaging ###
The [Debian](/contrib/debian) subfolder contains the copyright file.

All other packaging related files can be found in the [blockle-core/packaging](https://github.com/blockle-core/packaging) repository.

### [Gitian-descriptors](/contrib/gitian-descriptors) ###
Files used during the gitian build process. For more information about gitian, see the [the Blockle Core documentation repository](https://github.com/blockle-core/docs).

### [Gitian-keys](/contrib/gitian-keys)
PGP keys used for signing Blockle Core [Gitian release](/doc/release-process.md) results.

### [MacDeploy](/contrib/macdeploy) ###
Scripts and notes for Mac builds.

### [Gitian-build](/contrib/gitian-build.py) ###
Script for running full Gitian builds.

Test and Verify Tools
---------------------

### [TestGen](/contrib/testgen) ###
Utilities to generate test vectors for the data-driven Blockle tests.

### [Verify Binaries](/contrib/verifybinaries) ###
This script attempts to download and verify the signature file SHA256SUMS.asc from blockle.org.
