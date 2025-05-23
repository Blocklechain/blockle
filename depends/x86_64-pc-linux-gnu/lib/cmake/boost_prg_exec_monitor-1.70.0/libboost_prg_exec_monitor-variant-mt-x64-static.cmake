# Generated by Boost 1.70.0

# address-model=64

if(CMAKE_SIZEOF_VOID_P EQUAL 4)
  _BOOST_SKIPPED("libboost_prg_exec_monitor-mt-x64.a" "64 bit, need 32")
  return()
endif()

# layout=tagged

# toolset=gcc9

# link=static

if(NOT "${Boost_USE_STATIC_LIBS}" STREQUAL "" AND NOT Boost_USE_STATIC_LIBS)
  _BOOST_SKIPPED("libboost_prg_exec_monitor-mt-x64.a" "static, Boost_USE_STATIC_LIBS=${Boost_USE_STATIC_LIBS}")
  return()
endif()

if(BUILD_SHARED_LIBS)
  _BOOST_SKIPPED("libboost_prg_exec_monitor-mt-x64.a" "static, BUILD_SHARED_LIBS=${BUILD_SHARED_LIBS}, set Boost_USE_STATIC_LIBS=ON to override")
  return()
endif()

# runtime-link=shared

if(Boost_USE_STATIC_RUNTIME)
  _BOOST_SKIPPED("libboost_prg_exec_monitor-mt-x64.a" "shared runtime, Boost_USE_STATIC_RUNTIME=${Boost_USE_STATIC_RUNTIME}")
  return()
endif()

# runtime-debugging=off

if(Boost_USE_DEBUG_RUNTIME)
  _BOOST_SKIPPED("libboost_prg_exec_monitor-mt-x64.a" "release runtime, Boost_USE_DEBUG_RUNTIME=${Boost_USE_DEBUG_RUNTIME}")
  return()
endif()

# threading=multi

# variant=release

if(NOT "${Boost_USE_RELEASE_LIBS}" STREQUAL "" AND NOT Boost_USE_RELEASE_LIBS)
  _BOOST_SKIPPED("libboost_prg_exec_monitor-mt-x64.a" "release, Boost_USE_RELEASE_LIBS=${Boost_USE_RELEASE_LIBS}")
  return()
endif()

message(STATUS "  libboost_prg_exec_monitor-mt-x64.a")

# Target file name: libboost_prg_exec_monitor-mt-x64.a
set_property(TARGET Boost::prg_exec_monitor APPEND PROPERTY IMPORTED_CONFIGURATIONS RELEASE)
set_target_properties(Boost::prg_exec_monitor PROPERTIES
  IMPORTED_LINK_INTERFACE_LANGUAGES_RELEASE CXX
  IMPORTED_LOCATION_RELEASE "${_BOOST_LIBDIR}/libboost_prg_exec_monitor-mt-x64.a"
  )

list(APPEND _BOOST_PRG_EXEC_MONITOR_DEPS headers)
