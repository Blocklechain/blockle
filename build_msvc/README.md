Building Blockle Core with Visual Studio
========================================

Introduction
---------------------
Solution and project files to build the Blockle Core applications `msbuild` or Visual Studio can be found in the build_msvc directory. The build has been tested with Visual Studio 2017 and 2019.

Building with Visual Studio is an alternative to the Linux based [cross-compiler build](https://github.com/blockle/blockle/blob/master/doc/build-windows.md).

Quick Start
---------------------
The minimal steps required to build Blockle Core with the msbuild toolchain are below. More detailed instructions are contained in the following sections.

```
vcpkg install --triplet x64-windows-static berkeleydb boost-filesystem boost-multi-index boost-signals2 boost-test boost-thread libevent[thread] zeromq double-conversion
vcpkg integrate install
py -3 build_msvc\msvc-autogen.py
msbuild /m build_msvc\blockle.sln /p:Platform=x64 /p:Configuration=Release /t:build
```

Dependencies
---------------------
A number of [open source libraries](https://github.com/blockle/blockle/blob/master/doc/dependencies.md) are required in order to be able to build Blockle Core.

Options for installing the dependencies in a Visual Studio compatible manner are:

- Use Microsoft's [vcpkg](https://docs.microsoft.com/en-us/cpp/vcpkg) to download the source packages and build locally. This is the recommended approach.
- Download the source code, build each dependency, add the required include paths, link libraries and binary tools to the Visual Studio project files.
- Use [nuget](https://www.nuget.org/) packages with the understanding that any binary files have been compiled by an untrusted third party.

The [external dependencies](https://github.com/blockle/blockle/blob/master/doc/dependencies.md) required for building are:

- Berkeley DB
- Boost
- DoubleConversion
- libevent
- Qt5
- ZeroMQ

Qt
---------------------
In order to build the Blockle Core a static build of Qt is required. The runtime library version (e.g. v141, v142) and platform type (x86 or x64) must also match.

Some prebuilt x64 versions of Qt can be downloaded from [here](https://github.com/sipsorcery/qt_win_binary/releases). Please be aware these downloads are NOT officially sanctioned by Blockle Core and are provided for developer convenience only. They should NOT be used for builds that will be used in a production environment or with real funds.

To determine which Qt prebuilt version to download open the `.appveyor.yml` file and note the `QT_DOWNLOAD_URL`. When extracting the zip file the destination path must be set to `C:\`. This is due to the way that Qt includes, libraries and tools use internal paths.

To build Blockle Core without Qt unload or disable the `blockle-qt`, `libblockle_qt` and `test_blockle-qt` projects.

Building
---------------------
The instructions below use `vcpkg` to install the dependencies.

- Install [`vcpkg`](https://github.com/Microsoft/vcpkg).
- Install the required packages (replace x64 with x86 as required). The list of required packages can be found in the `build_msvc\vcpkg-packages.txt` file. The PowerShell command below will work if run from the repository root directory and `vcpkg` is in the path. Alternatively the contents of the packages text file can be pasted in place of the `Get-Content` cmdlet.

```
PS >.\vcpkg install --triplet x64-windows-static $(Get-Content -Path build_msvc\vcpkg-packages.txt).split()
PS >.\vcpkg integrate install
```

- Use Python to generate `*.vcxproj` from Makefile

```
PS >py -3 msvc-autogen.py
```

- An optional step is to adjust the settings in the build_msvc directory and the common.init.vcxproj file. This project file contains settings that are common to all projects such as the runtime library version and target Windows SDK version. The Qt directories can also be set.

- To build from the command line with the Visual Studio 2017 toolchain use:

```
msbuild /m blockle.sln /p:Platform=x64 /p:Configuration=Release /p:PlatformToolset=v141 /t:build
```

- To build from the command line with the Visual Studio 2019 toolchain use:

```
msbuild /m blockle.sln /p:Platform=x64 /p:Configuration=Release /t:build
```

- Alternatively open the `build_msvc\blockle.sln` file in Visual Studio.

AppVeyor
---------------------
The .appveyor.yml in the root directory is suitable to perform builds on [AppVeyor](https://www.appveyor.com/) Continuous Integration servers. The simplest way to perform an AppVeyor build is to fork Blockle Core and then configure a new AppVeyor Project pointing to the forked repository.

For safety reasons the Blockle Core .appveyor.yml file has the artifact options disabled. The build will be performed but no executable files will be available. To enable artifacts on a forked repository uncomment the lines shown below:

```
    #- 7z a blockle-%APPVEYOR_BUILD_VERSION%.zip %APPVEYOR_BUILD_FOLDER%\build_msvc\%platform%\%configuration%\*.exe
    #- path: blockle-%APPVEYOR_BUILD_VERSION%.zip
```
